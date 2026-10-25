import {
	type DesktopDeviceAction,
	type DesktopDeviceInfoSnapshot,
	type DesktopDeviceToolsSnapshot,
	desktopActionCapability,
	parseDesktopActionEnvelope,
	RNDEVTOOLS_PROTOCOL_VERSION,
	RNDEVTOOLS_SNAPSHOT_LIMITS,
} from '@rndevtools/core/desktop-protocol';
import {
	diagnosticErrorText,
	redactDiagnosticText,
} from '@rndevtools/core/redact';
import { truncateText, utf8ByteLength } from '@rndevtools/core/serialize';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import type { DevtoolsAuthorization } from '../authorization';
import { desktopProjectionId } from './projection';

// A headless host can build its device info and snapshot projections from this
// entry point alone, without the root barrel's diagnostics and optional peers.
export {
	desktopProjectionId,
	limitDesktopProjection,
	projectDesktopHeaders,
	projectDesktopQueryKey,
} from './projection';
export { simulatorUdidFromPath } from './simulator-identity';

/** A bounded diagnostic line published alongside each snapshot. */
export type DesktopDiagnostic = {
	id: string;
	at: number;
	level: 'debug' | 'info' | 'warn' | 'error';
	scope: string;
	message: string;
};

/**
 * Everything the client needs from the host app. The client owns discovery,
 * framing, pacing, replay protection, and admission control, and runs only the
 * actions the device advertises; the host owns what its own state looks like
 * and what an action is allowed to do. Keeping that boundary explicit is what
 * makes this client reusable across apps.
 */
export type DesktopClientHost = {
	/** Projects the host's registered diagnostics into a snapshot payload. */
	captureTools: (
		diagnostics: readonly DesktopDiagnostic[],
	) => DesktopDeviceToolsSnapshot;
	/** Identifies this device and build to the desktop. */
	createDeviceInfo: () => DesktopDeviceInfoSnapshot;
	/**
	 * Applies one desktop-issued action. Rejecting throws. `signal` aborts when
	 * the client stops waiting for the action; a host holding an on-device
	 * prompt should dismiss it and reject.
	 */
	runAction: (
		action: DesktopDeviceAction,
		context: Readonly<{ signal: AbortSignal }>,
	) => Promise<void>;
	/** Current authorization. The client refuses actions while disabled. */
	getAuthorization: () => DevtoolsAuthorization;
};

const DEFAULT_PORT = 47_931;
const DEFAULT_PORT_ATTEMPTS = 10;
const CONNECT_TIMEOUT_MS = 3_500;
const SNAPSHOT_INTERVAL_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 5_000;
const RETRY_DELAY_MS = 2_500;
const MAX_RETRY_DELAY_MS = 30_000;
const HEALTHY_CONNECTION_MS = 10_000;
// Outlasts the broker's longest acknowledgement window (30 s), so the client
// never gives up on an action the desktop is still waiting for.
const DEFAULT_ACTION_TIMEOUT_MS = 45_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_DIAGNOSTICS = 200;
const MAX_PROCESSED_ACTIONS = 200;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const MAX_INCOMING_MESSAGE_BYTES = 600 * 1024;
const MAX_OUTGOING_SNAPSHOT_BYTES = 8 * 1024 * 1024;
// The broker closes a device socket once one second of its frames holds more
// than 8 frames or 24 MiB. The client spends less than that over a longer
// window, so delivery jitter, or a broker busy parsing a large snapshot, cannot
// fold the client's frames into one broker window over the limit.
const MAX_OUTGOING_FRAMES_PER_WINDOW = 6;
const MAX_OUTGOING_BYTES_PER_WINDOW = 16 * 1024 * 1024;
const OUTGOING_RATE_WINDOW_MS = 1_500;
const MAX_CLOSE_REASON_BYTES = 256;
const MAX_BROKER_URL_LENGTH = 8 * 1024;
const MAX_BROKER_CANDIDATES = 100;
const MAX_BROKER_TOKEN_LENGTH = 512;
const MIN_REMOTE_BROKER_TOKEN_LENGTH = 16;
const MAX_PENDING_DESKTOP_ACTIONS = 16;
const MAX_DESKTOP_ACTIONS_PER_WINDOW = 60;
const DESKTOP_ACTION_RATE_WINDOW_MS = 10_000;
const SNAPSHOT_ROW_LIMITS = Object.entries(RNDEVTOOLS_SNAPSHOT_LIMITS);

type ActionResultMessage = {
	type: 'action-result';
	actionId: string;
	ok: boolean;
	error?: string;
};

type ProcessedAction = {
	fingerprint: string;
	result: ActionResultMessage;
};

type ActionReplayLookup =
	| { kind: 'new' }
	| { kind: 'replay'; result: ActionResultMessage }
	| { kind: 'conflict' };

/**
 * The length and hash of an action's JSON. Retaining only this keeps the
 * replay cache small however large the payloads were. A collision could only
 * turn a conflict into a replay of the stored result, which never runs the
 * action.
 */
function actionFingerprint(action: DesktopDeviceAction): string {
	const serialized = JSON.stringify(action);
	return `${serialized.length}:${desktopProjectionId('action', serialized)}`;
}

export class DesktopActionReplayCache {
	readonly #maxEntries: number;
	readonly #entries = new Map<string, ProcessedAction>();

	constructor(maxEntries = MAX_PROCESSED_ACTIONS) {
		if (!Number.isInteger(maxEntries) || maxEntries < 1) {
			throw new Error('maxEntries must be a positive integer.');
		}
		this.#maxEntries = maxEntries;
	}

	lookup(action: DesktopDeviceAction): ActionReplayLookup {
		const processed = this.#entries.get(action.actionId);
		if (!processed) return { kind: 'new' };
		return processed.fingerprint === actionFingerprint(action)
			? { kind: 'replay', result: processed.result }
			: { kind: 'conflict' };
	}

	remember(action: DesktopDeviceAction, result: ActionResultMessage): void {
		this.#entries.set(action.actionId, {
			fingerprint: actionFingerprint(action),
			result,
		});
		while (this.#entries.size > this.#maxEntries) {
			const oldest = this.#entries.keys().next().value;
			if (typeof oldest !== 'string') break;
			this.#entries.delete(oldest);
		}
	}
}

type DesktopActionAdmission =
	| { accepted: false; reason: 'queue-full' | 'rate-limited' }
	| { accepted: true; release: () => void };

export class DesktopActionAdmissionController {
	readonly #maxPending: number;
	readonly #maxPerWindow: number;
	readonly #windowMs: number;
	readonly #now: () => number;
	readonly #acceptedAt: number[] = [];
	#pending = 0;

	constructor({
		maxPending = MAX_PENDING_DESKTOP_ACTIONS,
		maxPerWindow = MAX_DESKTOP_ACTIONS_PER_WINDOW,
		windowMs = DESKTOP_ACTION_RATE_WINDOW_MS,
		now = Date.now,
	}: {
		maxPending?: number;
		maxPerWindow?: number;
		windowMs?: number;
		now?: () => number;
	} = {}) {
		if (!Number.isInteger(maxPending) || maxPending < 1) {
			throw new Error('maxPending must be a positive integer.');
		}
		if (!Number.isInteger(maxPerWindow) || maxPerWindow < 1) {
			throw new Error('maxPerWindow must be a positive integer.');
		}
		if (!Number.isFinite(windowMs) || windowMs <= 0) {
			throw new Error('windowMs must be a positive finite number.');
		}
		this.#maxPending = maxPending;
		this.#maxPerWindow = maxPerWindow;
		this.#windowMs = windowMs;
		this.#now = now;
	}

	admit(): DesktopActionAdmission {
		const now = this.#now();
		const cutoff = now - this.#windowMs;
		while ((this.#acceptedAt[0] ?? Number.POSITIVE_INFINITY) <= cutoff) {
			this.#acceptedAt.shift();
		}
		if (this.#pending >= this.#maxPending) {
			return { accepted: false, reason: 'queue-full' };
		}
		if (this.#acceptedAt.length >= this.#maxPerWindow) {
			return { accepted: false, reason: 'rate-limited' };
		}

		this.#acceptedAt.push(now);
		this.#pending += 1;
		let released = false;
		return {
			accepted: true,
			release: () => {
				if (released) return;
				released = true;
				this.#pending = Math.max(0, this.#pending - 1);
			},
		};
	}
}

/**
 * The UTF-8 byte length of `text`, or undefined when it exceeds `maxBytes`.
 * A string's UTF-16 length is a lower bound on its UTF-8 bytes, so text that
 * is already longer than the limit is refused without walking it.
 */
function utf8ByteLengthWithin(
	text: string,
	maxBytes: number,
): number | undefined {
	if (text.length > maxBytes) return undefined;
	const bytes = utf8ByteLength(text);
	return bytes > maxBytes ? undefined : bytes;
}

/** Meters one connection's outgoing frames and their UTF-8 bytes. */
class DesktopFrameBudget {
	readonly #sent: { at: number; bytes: number }[] = [];
	#bytes = 0;

	fits(bytes: number): boolean {
		this.#expire(Date.now());
		return (
			this.#sent.length < MAX_OUTGOING_FRAMES_PER_WINDOW &&
			this.#bytes + bytes <= MAX_OUTGOING_BYTES_PER_WINDOW
		);
	}

	trySpend(bytes: number): boolean {
		if (!this.fits(bytes)) return false;
		this.#sent.push({ at: Date.now(), bytes });
		this.#bytes += bytes;
		return true;
	}

	/** Milliseconds until the oldest spent frame leaves the window. */
	retryDelayMs(): number {
		const oldest = this.#sent[0];
		return oldest
			? Math.max(1, oldest.at + OUTGOING_RATE_WINDOW_MS - Date.now())
			: 1;
	}

	#expire(now: number): void {
		const newest = this.#sent[this.#sent.length - 1];
		if (newest && newest.at > now) {
			// The wall clock moved backwards; restart the window rather than stall.
			this.#sent.length = 0;
			this.#bytes = 0;
			return;
		}
		let oldest = this.#sent[0];
		while (oldest && oldest.at <= now - OUTGOING_RATE_WINDOW_MS) {
			this.#sent.shift();
			this.#bytes -= oldest.bytes;
			oldest = this.#sent[0];
		}
	}
}

/** What one open connection still has to send, in priority order. */
type DesktopOutbox = {
	readonly target: WebSocket;
	readonly budget: DesktopFrameBudget;
	/** Serialized action results. The broker waits on each, so they only wait. */
	readonly results: string[];
	/** Snapshots coalesce: the next one sent carries the latest state. */
	snapshotDue: boolean;
	lastSnapshotAt: number;
	lastSnapshotBytes: number;
	flushTimer: ReturnType<typeof setTimeout> | undefined;
};

/**
 * Trims every top-level collection to the row limit the desktop schema
 * enforces. The broker rejects a whole snapshot that is over any limit and
 * closes the socket, so one oversized projection would otherwise leave the
 * device reconnecting in a loop. The newest rows are kept: core's event stores
 * append, so those are last.
 */
function trimToSnapshotLimits(tools: DesktopDeviceToolsSnapshot): {
	tools: DesktopDeviceToolsSnapshot;
	trimmed: readonly string[];
} {
	const fields: Readonly<Record<string, unknown>> = tools;
	let trimmedFields: Record<string, unknown> | undefined;
	const trimmed: string[] = [];
	for (const [name, limit] of SNAPSHOT_ROW_LIMITS) {
		const rows = fields[name];
		if (!Array.isArray(rows) || rows.length <= limit) continue;
		trimmedFields ??= { ...fields };
		trimmedFields[name] = rows.slice(-limit);
		trimmed.push(`${name} to ${limit} rows`);
	}
	return trimmedFields
		? { tools: trimmedFields as DesktopDeviceToolsSnapshot, trimmed }
		: { tools, trimmed };
}

function closeDetail(
	event: { code?: number; reason?: string } | undefined,
): string {
	if (typeof event?.code !== 'number') return '';
	const reason =
		typeof event.reason === 'string'
			? truncateText(event.reason, MAX_CLOSE_REASON_BYTES).text.trim()
			: '';
	return ` (${event.code}${reason ? `: ${reason}` : ''})`;
}

function hostFromUri(value: string | undefined): string | undefined {
	if (!value || value.length > MAX_BROKER_URL_LENGTH) return undefined;
	try {
		return new URL(value.includes('://') ? value : `http://${value}`).hostname;
	} catch {
		return undefined;
	}
}

function socketUrl(host: string, port: number): string {
	const displayHost =
		host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
	return `ws://${displayHost}:${port}/device`;
}

function isLocalBrokerHost(hostname: string): boolean {
	return hostname === '10.0.2.2' || isLoopbackBrokerHost(hostname);
}

function isLoopbackBrokerHost(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
	return (
		normalized === 'localhost' ||
		normalized === '127.0.0.1' ||
		normalized === '::1' ||
		normalized === '0:0:0:0:0:0:0:1'
	);
}

function normalizeExplicitUrl(
	value: string,
	{ allowAndroidEmulatorAlias = false } = {},
): string | undefined {
	if (!value || value.length > MAX_BROKER_URL_LENGTH) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return undefined;
		if (url.username || url.password || url.hash) return undefined;
		const isLoopback = isLoopbackBrokerHost(url.hostname);
		const isTrustedEmulatorAlias =
			allowAndroidEmulatorAlias && url.hostname === '10.0.2.2';
		if (url.protocol === 'ws:' && !isLoopback && !isTrustedEmulatorAlias) {
			return undefined;
		}
		if (url.pathname === '/' || url.pathname === '') url.pathname = '/device';
		if (url.pathname !== '/device') return undefined;
		for (const name of url.searchParams.keys()) {
			if (name !== 'token') return undefined;
		}
		const tokens = url.searchParams.getAll('token');
		if (
			tokens.length > 1 ||
			tokens.some((token) => !token || token.length > MAX_BROKER_TOKEN_LENGTH)
		) {
			return undefined;
		}
		if (
			!isLoopback &&
			!isTrustedEmulatorAlias &&
			(tokens[0]?.length ?? 0) < MIN_REMOTE_BROKER_TOKEN_LENGTH
		) {
			return undefined;
		}
		const normalized = url.toString();
		return normalized.length <= MAX_BROKER_URL_LENGTH ? normalized : undefined;
	} catch {
		return undefined;
	}
}

function socketDiagnosticLabel(value: string): string {
	try {
		const url = new URL(value);
		const hadQuery = url.search.length > 0;
		url.search = '';
		return `${redactDiagnosticText(url.toString())}${hadQuery ? '?<redacted>' : ''}`;
	} catch {
		return 'configured desktop broker';
	}
}

export function desktopBrokerCandidates({
	explicitUrl = process.env.EXPO_PUBLIC_DESKTOP_DEVTOOLS_URL,
	hostUri = Constants.expoConfig?.hostUri,
	platform = Platform.OS,
	isEmulator = Device.isDevice === false,
	port = DEFAULT_PORT,
	portAttempts = DEFAULT_PORT_ATTEMPTS,
}: {
	explicitUrl?: string;
	hostUri?: string;
	platform?: string;
	isEmulator?: boolean;
	port?: number;
	portAttempts?: number;
} = {}): string[] {
	if (explicitUrl) {
		const normalized = normalizeExplicitUrl(explicitUrl);
		return normalized ? [normalized] : [];
	}
	const hosts = [
		hostFromUri(hostUri),
		// 10.0.2.2 is the host loopback alias *inside an Android emulator*. On a
		// physical phone it is an ordinary routable RFC1918 address, so sweeping it
		// would offer a full unauthenticated diagnostic snapshot to whatever
		// machine happens to hold it on the developer's network.
		platform === 'android' && isEmulator ? '10.0.2.2' : undefined,
		'127.0.0.1',
		'localhost',
	].filter(
		(host): host is string => Boolean(host) && isLocalBrokerHost(host ?? ''),
	);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) return [];
	const attempts = Number.isFinite(portAttempts)
		? Math.max(1, Math.min(10, Math.floor(portAttempts)))
		: DEFAULT_PORT_ATTEMPTS;
	const ports = Array.from(
		{ length: attempts },
		(_, index) => port + index,
	).filter((candidate) => candidate <= 65_535);
	const uniqueHosts = [...new Set(hosts)];
	return ports.flatMap((candidate) =>
		uniqueHosts.map((host) => socketUrl(host, candidate)),
	);
}

/**
 * Internal tools are also enabled for `preview`, but a preview build runs on
 * testers' devices where no broker exists and `hostUri` is undefined, so
 * discovery would sweep every loopback candidate for the whole session. Keeping
 * the client on development builds also confines the unauthenticated loopback
 * socket to machines the developer controls.
 */
export function shouldStartDesktopClient(
	options: Readonly<{ isDevelopmentBuild: boolean }>,
): boolean {
	return (
		options.isDevelopmentBuild &&
		process.env.NODE_ENV !== 'test' &&
		process.env.EXPO_PUBLIC_DESKTOP_DEVTOOLS_DISABLED !== 'true'
	);
}

export type DesktopClientHandle = {
	stop: () => void;
};

export type DesktopClientOptions = {
	/** Host adapter supplying snapshots, identity, and action execution. */
	host: DesktopClientHost;
	/** Explicit broker URLs. Defaults to the discovered loopback candidates. */
	candidates?: readonly string[];
	/**
	 * How long one host action may run before the client tells the desktop it
	 * timed out, aborts the action's signal, and moves on to the next queued
	 * action. Defaults to 45 seconds.
	 */
	actionTimeoutMs?: number;
};

export function startDesktopClient(
	options: DesktopClientOptions,
): DesktopClientHandle {
	const {
		host,
		candidates,
		actionTimeoutMs = DEFAULT_ACTION_TIMEOUT_MS,
	} = options;
	if (
		!Number.isFinite(actionTimeoutMs) ||
		actionTimeoutMs <= 0 ||
		actionTimeoutMs > MAX_TIMER_DELAY_MS
	) {
		throw new Error(
			'actionTimeoutMs must be a positive number of milliseconds.',
		);
	}
	const allowAndroidEmulatorAlias =
		candidates === undefined &&
		!process.env.EXPO_PUBLIC_DESKTOP_DEVTOOLS_URL &&
		Platform.OS === 'android';
	const requestedCandidates = candidates ?? desktopBrokerCandidates();
	const brokerCandidates = [
		...new Set(
			requestedCandidates
				.slice(0, MAX_BROKER_CANDIDATES)
				.flatMap((candidate) => {
					const normalized = normalizeExplicitUrl(candidate, {
						allowAndroidEmulatorAlias,
					});
					return normalized ? [normalized] : [];
				}),
		),
	];
	let active = true;
	let candidateIndex = 0;
	let sequence = 0;
	let diagnosticSequence = 0;
	let brokerRejections = 0;
	let reportedTrim = '';
	let socket: WebSocket | undefined;
	let outbox: DesktopOutbox | undefined;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	let connectTimer: ReturnType<typeof setTimeout> | undefined;
	let snapshotTimer: ReturnType<typeof setInterval> | undefined;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
	let actionQueue = Promise.resolve();
	let activeActionController: AbortController | undefined;
	let backpressureReported = false;
	const diagnostics: DesktopDiagnostic[] = [];
	const processedActions = new DesktopActionReplayCache();
	const actionAdmission = new DesktopActionAdmissionController();
	const device = host.createDeviceInfo();
	// The broker keys this session by the trimmed identifier, and the action
	// parser trims too, so actions for this device carry the trimmed form.
	const deviceId = typeof device.id === 'string' ? device.id.trim() : '';
	const advertisedCapabilities = new Set<string>(
		Array.isArray(device.capabilities) ? device.capabilities : [],
	);

	const record = (
		level: DesktopDiagnostic['level'],
		scope: string,
		message: string,
	) => {
		const at = Date.now();
		const safeMessage = redactDiagnosticText(message);
		diagnosticSequence += 1;
		diagnostics.push({
			id: `desktop-client-${at}-${diagnosticSequence}`,
			at,
			level,
			scope,
			message: truncateText(safeMessage, 4_096).text,
		});
		if (diagnostics.length > MAX_DIAGNOSTICS) {
			diagnostics.splice(0, diagnostics.length - MAX_DIAGNOSTICS);
		}
	};

	const clearConnectionTimers = () => {
		if (connectTimer) clearTimeout(connectTimer);
		if (snapshotTimer) clearInterval(snapshotTimer);
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		if (outbox?.flushTimer) clearTimeout(outbox.flushTimer);
		connectTimer = undefined;
		snapshotTimer = undefined;
		heartbeatTimer = undefined;
		outbox = undefined;
	};

	const cancelActiveAction = () => {
		try {
			activeActionController?.abort();
		} catch {
			// A host's abort observer must not interrupt diagnostics teardown.
		}
	};

	const sendSerialized = (serialized: string, target = socket): boolean => {
		if (!active || !target || socket !== target || target.readyState !== 1) {
			return false;
		}
		try {
			target.send(serialized);
			return true;
		} catch (error) {
			record(
				'warn',
				'transport',
				`Failed to send desktop message: ${diagnosticErrorText(error)}`,
			);
			return false;
		}
	};

	/** Sends one frame now if the connection's frame budget has room for it. */
	const sendWithinBudget = (message: unknown, target: WebSocket): boolean => {
		const current = outbox;
		if (current?.target !== target) return false;
		let serialized: string;
		try {
			serialized = JSON.stringify(message);
		} catch (error) {
			record(
				'warn',
				'transport',
				`Failed to serialize desktop message: ${diagnosticErrorText(error)}`,
			);
			return false;
		}
		return (
			current.budget.trySpend(utf8ByteLength(serialized)) &&
			sendSerialized(serialized, target)
		);
	};

	const reportTrim = (trimmed: readonly string[]) => {
		const summary = trimmed.join(', ');
		if (summary === reportedTrim) return;
		reportedTrim = summary;
		if (!summary) return;
		record(
			'warn',
			'snapshot',
			`Trimmed ${summary} in the desktop snapshot to fit its row limits; the newest rows were kept.`,
		);
	};

	const serializeSnapshot = (
		target: WebSocket,
	): { serialized: string; bytes: number } | undefined => {
		if (target.bufferedAmount > MAX_BUFFERED_BYTES) {
			if (!backpressureReported) {
				backpressureReported = true;
				record(
					'warn',
					'transport',
					'Desktop snapshot skipped while the socket send buffer drains.',
				);
			}
			return undefined;
		}
		backpressureReported = false;
		try {
			const captured = trimToSnapshotLimits(host.captureTools(diagnostics));
			reportTrim(captured.trimmed);
			const serialized = JSON.stringify({
				type: 'snapshot',
				sequence: sequence + 1,
				sentAt: Date.now(),
				tools: captured.tools,
			});
			const bytes = utf8ByteLengthWithin(
				serialized,
				MAX_OUTGOING_SNAPSHOT_BYTES,
			);
			if (bytes === undefined) {
				record(
					'error',
					'snapshot',
					'Desktop snapshot exceeded the 8 MiB wire budget and was not sent.',
				);
				return undefined;
			}
			return { serialized, bytes };
		} catch (error) {
			record(
				'error',
				'snapshot',
				`Snapshot capture failed: ${diagnosticErrorText(error)}`,
			);
			return undefined;
		}
	};

	/**
	 * Sends what fits the connection's frame budget: queued action results
	 * first, then the coalesced snapshot. Whatever is left waits until the
	 * oldest spent frame leaves the window.
	 */
	const flushOutbox = () => {
		const current = outbox;
		if (!current) return;
		if (current.flushTimer) clearTimeout(current.flushTimer);
		current.flushTimer = undefined;
		const { target, budget, results } = current;
		while (active && socket === target && target.readyState === 1) {
			const result = results[0];
			if (result !== undefined) {
				if (!budget.trySpend(utf8ByteLength(result))) break;
				results.shift();
				sendSerialized(result, target);
				continue;
			}
			if (!current.snapshotDue) return;
			// Capture only once there is room, so a deferred snapshot carries the
			// latest state rather than the state when it was requested.
			if (!budget.fits(current.lastSnapshotBytes)) break;
			const snapshot = serializeSnapshot(target);
			if (!snapshot) {
				current.snapshotDue = false;
				return;
			}
			current.lastSnapshotBytes = snapshot.bytes;
			if (!budget.trySpend(snapshot.bytes)) break;
			current.snapshotDue = false;
			if (sendSerialized(snapshot.serialized, target)) {
				sequence += 1;
				current.lastSnapshotAt = Date.now();
			}
			return;
		}
		if (active && socket === target && target.readyState === 1) {
			current.flushTimer = setTimeout(flushOutbox, budget.retryDelayMs());
		}
	};

	const requestSnapshot = (target: WebSocket) => {
		const current = outbox;
		if (current?.target !== target) return;
		current.snapshotDue = true;
		flushOutbox();
	};

	const queueResult = (result: ActionResultMessage, target: WebSocket) => {
		const current = outbox;
		// A result for a socket that has closed is moot: the broker failed that
		// action when the device disconnected.
		if (current?.target !== target) return;
		current.results.push(JSON.stringify(result));
		flushOutbox();
	};

	/** Runs one host action, giving up after `actionTimeoutMs`. */
	const runHostAction = async (
		action: DesktopDeviceAction,
	): Promise<'completed' | 'timed-out' | 'cancelled'> => {
		const controller = new AbortController();
		activeActionController = controller;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let cancel: (() => void) | undefined;
		const cancellation = new Promise<'cancelled'>((resolve) => {
			cancel = () => resolve('cancelled');
			controller.signal.addEventListener('abort', cancel, { once: true });
		});
		try {
			return await Promise.race([
				cancellation,
				Promise.resolve(
					host.runAction(action, { signal: controller.signal }),
				).then(() => 'completed' as const),
				new Promise<'timed-out'>((resolve) => {
					timer = setTimeout(() => {
						resolve('timed-out');
						controller.abort();
					}, actionTimeoutMs);
				}),
			]);
		} finally {
			clearTimeout(timer);
			if (cancel) controller.signal.removeEventListener('abort', cancel);
			if (activeActionController === controller) {
				activeActionController = undefined;
			}
		}
	};

	const handleAction = async (
		action: DesktopDeviceAction,
		target: WebSocket,
		expectedOwnerId: string | null,
	) => {
		if (!active || socket !== target || target.readyState !== 1) return;
		const authorization = host.getAuthorization();
		if (!authorization.enabled || authorization.ownerId !== expectedOwnerId) {
			queueResult(
				{
					type: 'action-result',
					actionId: action.actionId,
					ok: false,
					error: 'Internal tools authorization changed before execution.',
				},
				target,
			);
			return;
		}
		const processed = processedActions.lookup(action);
		if (processed.kind !== 'new') {
			queueResult(
				processed.kind === 'replay'
					? processed.result
					: {
							type: 'action-result',
							actionId: action.actionId,
							ok: false,
							error: 'Action identifier was reused with different contents.',
						},
				target,
			);
			return;
		}
		let result: ActionResultMessage;
		try {
			const outcome = await runHostAction(action);
			if (outcome === 'cancelled') return;
			if (outcome === 'timed-out') {
				// The queue moves on: one action that never settles, such as a prompt
				// nobody answers, must not block every later one.
				record(
					'warn',
					action.tool,
					`Desktop action timed out: ${action.command}.`,
				);
				result = {
					type: 'action-result',
					actionId: action.actionId,
					ok: false,
					error: `Desktop action timed out after ${actionTimeoutMs} ms; its outcome is unknown.`,
				};
			} else {
				record(
					'info',
					action.tool,
					`Desktop action completed: ${action.command}.`,
				);
				result = {
					type: 'action-result',
					actionId: action.actionId,
					ok: true,
				};
			}
		} catch (error) {
			const message = truncateText(diagnosticErrorText(error), 4_096).text;
			record('warn', action.tool, `Desktop action rejected: ${message}`);
			result = {
				type: 'action-result',
				actionId: action.actionId,
				ok: false,
				error: message,
			};
		}
		processedActions.remember(action, result);
		queueResult(result, target);
		requestSnapshot(target);
	};

	const scheduleReconnect = (delay: number) => {
		if (!active || brokerCandidates.length === 0 || reconnectTimer) return;
		reconnectTimer = setTimeout(() => {
			reconnectTimer = undefined;
			connect();
		}, delay);
	};

	const connect = () => {
		if (!active || socket || brokerCandidates.length === 0) return;
		const currentCandidateIndex = candidateIndex % brokerCandidates.length;
		const url = brokerCandidates[currentCandidateIndex];
		if (!url) return;
		const urlLabel = socketDiagnosticLabel(url);
		let nextSocket: WebSocket;
		try {
			nextSocket = new WebSocket(url);
		} catch (error) {
			record(
				'warn',
				'transport',
				`Could not open ${urlLabel}: ${diagnosticErrorText(error)}`,
			);
			candidateIndex = (currentCandidateIndex + 1) % brokerCandidates.length;
			scheduleReconnect(candidateIndex === 0 ? RETRY_DELAY_MS : 100);
			return;
		}
		socket = nextSocket;
		let opened = false;
		let openedAt = 0;
		let closedByClient = false;

		const closeConnection = (code: number, reason: string) => {
			closedByClient = true;
			try {
				nextSocket.close(code, reason);
			} catch {
				// The transport may already be closing after the policy violation.
			}
		};

		/**
		 * Answers an action this device will not run, then closes the connection
		 * as a policy violation. The answer skips the frame budget: the
		 * connection ends with it, so going over can only end it a frame sooner.
		 */
		const refuse = (actionId: string, error: string, closeReason: string) => {
			sendSerialized(
				JSON.stringify({ type: 'action-result', actionId, ok: false, error }),
				nextSocket,
			);
			closeConnection(1008, closeReason);
		};

		/** Moves on to the next candidate after this one failed to open. */
		const scheduleNextCandidate = () => {
			candidateIndex = (currentCandidateIndex + 1) % brokerCandidates.length;
			if (candidateIndex === 0) {
				record(
					'warn',
					'transport',
					'Could not reach a desktop broker candidate; retrying discovery.',
				);
			}
			scheduleReconnect(candidateIndex === 0 ? RETRY_DELAY_MS : 100);
		};

		connectTimer = setTimeout(() => {
			if (!opened && socket === nextSocket) {
				socket = undefined;
				connectTimer = undefined;
				try {
					nextSocket.close();
				} catch (error) {
					record(
						'warn',
						'transport',
						`Timed-out socket could not close: ${diagnosticErrorText(error)}`,
					);
				}
				scheduleNextCandidate();
			}
		}, CONNECT_TIMEOUT_MS);

		nextSocket.onopen = () => {
			if (!active || socket !== nextSocket) {
				try {
					nextSocket.close(1000, 'stale desktop connection');
				} catch {
					// The connection is already detached from the diagnostics client.
				}
				return;
			}
			opened = true;
			openedAt = Date.now();
			if (connectTimer) clearTimeout(connectTimer);
			connectTimer = undefined;
			candidateIndex = currentCandidateIndex;
			record('info', 'transport', `Connected to ${urlLabel}.`);
			// The broker meters each connection on its own, so each gets a budget.
			outbox = {
				target: nextSocket,
				budget: new DesktopFrameBudget(),
				results: [],
				snapshotDue: false,
				lastSnapshotAt: 0,
				lastSnapshotBytes: 0,
				flushTimer: undefined,
			};
			const sentHello = sendWithinBudget(
				{
					type: 'hello',
					protocolVersion: RNDEVTOOLS_PROTOCOL_VERSION,
					device,
				},
				nextSocket,
			);
			if (!sentHello) {
				closeConnection(1011, 'hello could not be sent');
				return;
			}
			requestSnapshot(nextSocket);
			snapshotTimer = setInterval(() => {
				const current = outbox;
				// A post-action snapshot that just went out already covers this tick.
				if (
					current?.target === nextSocket &&
					Date.now() - current.lastSnapshotAt < SNAPSHOT_INTERVAL_MS / 2
				) {
					return;
				}
				requestSnapshot(nextSocket);
			}, SNAPSHOT_INTERVAL_MS);
			heartbeatTimer = setInterval(() => {
				// Any frame keeps the broker's session fresh, so a heartbeat is only
				// worth the budget while no action result is waiting for it.
				if (outbox?.target !== nextSocket || outbox.results.length > 0) return;
				sendWithinBudget({ type: 'heartbeat', sentAt: Date.now() }, nextSocket);
			}, HEARTBEAT_INTERVAL_MS);
		};

		nextSocket.onmessage = (event) => {
			if (typeof event.data !== 'string') return;
			if (
				utf8ByteLengthWithin(event.data, MAX_INCOMING_MESSAGE_BYTES) ===
				undefined
			) {
				record('warn', 'protocol', 'Rejected an oversized desktop action.');
				closeConnection(1009, 'desktop action too large');
				return;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(event.data);
			} catch {
				record('warn', 'protocol', 'Ignored malformed desktop action JSON.');
				return;
			}
			const action = parseDesktopActionEnvelope(parsed);
			if (!action) {
				record('warn', 'protocol', 'Ignored an invalid desktop action.');
				return;
			}
			// Only the genuine broker filters actions by what the device advertised,
			// and any local process can answer on its port, so the device enforces
			// its own declaration too.
			if (action.deviceId !== deviceId) {
				record(
					'warn',
					'protocol',
					'Refused a desktop action addressed to another device.',
				);
				refuse(
					action.actionId,
					'Desktop action targets a different device.',
					'desktop action for another device',
				);
				return;
			}
			const capability = desktopActionCapability(action.tool, action.command);
			if (!capability || !advertisedCapabilities.has(capability)) {
				const name = capability ?? `${action.tool}.${action.command}`;
				record(
					'warn',
					'protocol',
					`Refused ${name}, which this device does not advertise.`,
				);
				refuse(
					action.actionId,
					`Device does not advertise ${name}.`,
					'desktop action not advertised',
				);
				return;
			}
			const authorization = host.getAuthorization();
			if (!authorization.enabled) {
				refuse(
					action.actionId,
					'Internal tools are not authorized.',
					'internal tools authorization required',
				);
				return;
			}
			const admission = actionAdmission.admit();
			if (!admission.accepted) {
				const queueFull = admission.reason === 'queue-full';
				record(
					'warn',
					'protocol',
					queueFull
						? 'Rejected a desktop action because the pending queue is full.'
						: 'Rejected a desktop action because the rate limit was exceeded.',
				);
				refuse(
					action.actionId,
					queueFull
						? 'Desktop action queue is full; retry later.'
						: 'Desktop action rate limit exceeded; retry later.',
					'desktop action admission limit exceeded',
				);
				return;
			}
			actionQueue = actionQueue
				.catch(() => undefined)
				.then(() => handleAction(action, nextSocket, authorization.ownerId))
				.catch((error: unknown) => {
					record(
						'error',
						'action',
						`Desktop action processing failed: ${diagnosticErrorText(error)}`,
					);
				})
				.finally(admission.release);
		};

		nextSocket.onerror = () => {
			if (opened)
				record('warn', 'transport', `Desktop socket error at ${urlLabel}.`);
		};

		nextSocket.onclose = (event?: { code?: number; reason?: string }) => {
			if (socket !== nextSocket) return;
			cancelActiveAction();
			clearConnectionTimers();
			socket = undefined;
			if (!active) return;
			if (opened) {
				// 1008 and 1009 mean the broker rejected what this device sent.
				// Reconnecting at the usual pace would only repeat the rejection, so
				// consecutive rejections back off until a connection stays healthy.
				const rejected =
					!closedByClient && (event?.code === 1008 || event?.code === 1009);
				if (Date.now() - openedAt >= HEALTHY_CONNECTION_MS) {
					brokerRejections = 0;
				}
				brokerRejections = rejected ? brokerRejections + 1 : 0;
				const delay = Math.min(
					MAX_RETRY_DELAY_MS,
					RETRY_DELAY_MS * 2 ** Math.max(0, brokerRejections - 1),
				);
				record(
					'warn',
					'transport',
					`Disconnected from ${urlLabel}${closeDetail(event)}${
						delay > RETRY_DELAY_MS
							? `; retrying in ${Math.round(delay / 1_000)} s`
							: ''
					}.`,
				);
				scheduleReconnect(delay);
				return;
			}
			scheduleNextCandidate();
		};
	};

	if (brokerCandidates.length === 0) {
		record(
			'error',
			'configuration',
			'No valid desktop broker URL is configured.',
		);
	} else {
		record('debug', 'transport', 'Desktop diagnostics client started.');
		connect();
	}

	return {
		stop: () => {
			active = false;
			cancelActiveAction();
			if (reconnectTimer) clearTimeout(reconnectTimer);
			reconnectTimer = undefined;
			clearConnectionTimers();
			const activeSocket = socket;
			socket = undefined;
			if (activeSocket && activeSocket.readyState < 2) {
				try {
					activeSocket.close(1000, 'Devtools unmounted');
				} catch {
					// Stopping diagnostics must never interrupt app teardown.
				}
			}
		},
	};
}

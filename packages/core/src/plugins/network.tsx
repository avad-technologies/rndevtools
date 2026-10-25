import {
	Button,
	ContentUnavailableView,
	Host,
	HStack,
	Image,
	LabeledContent,
	List,
	Picker,
	Section,
	Spacer,
	TextField,
	Toggle,
	Text as UIText,
	VStack,
} from '@expo/ui/swift-ui';
import {
	autocorrectionDisabled,
	badge,
	buttonStyle,
	font,
	foregroundStyle,
	frame,
	listStyle,
	pickerStyle,
	tag,
} from '@expo/ui/swift-ui/modifiers';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { Platform, PlatformColor } from 'react-native';
import {
	AndroidPanelRow,
	AndroidPanelScroll,
	AndroidPanelSearch,
	AndroidPanelSection,
	AndroidPanelTabs,
} from '../components/android-panel-ui';
import { NavIconButton } from '../components/nav-controls';
import { PanelShell } from '../components/panel-shell';
import {
	createDevToolsActionCoordinator,
	DEVTOOLS_ACTION_POLICY_VERSION,
	type DevToolsActionCoordinator,
	type DevToolsActionExecution,
	type DevToolsActionReceipt,
	type DevToolsCapability,
} from '../core/action-policy';
import type { DevtoolsEventStore } from '../core/event-store';
import { BoundedEventStore, ExternalStore } from '../core/external-store';
import { assertPositiveFinite, assertPositiveInteger } from '../core/options';
import { redactDiagnosticText } from '../core/redact';
import { createRefCountedInstaller } from '../core/ref-counted-installer';
import {
	serializeValue,
	truncateText,
	utf8ByteLength,
} from '../core/serialize';
import {
	exportNetworkSimulationPreference,
	getNetworkSimulationProfile,
	importNetworkSimulationPreference,
	isNetworkSimulationProfileId,
	NETWORK_SIMULATION_PROFILE_IDS,
	type NetworkSimulationProfile,
	type NetworkSimulationProfileId,
} from '../network-profile';
import type {
	DevToolsActionServices,
	DevToolsPanelPlugin,
	DevToolsSystemImage,
} from '../types';
import {
	arrayBufferViewByteLength,
	type CapturedNetworkBody,
	captureHeaders,
	captureRequestHeaders,
	defaultRedactBody,
	defaultRedactFormBody,
	defaultRedactHeader,
	defaultRedactUrl,
	isSafelyInspectableRequest,
	isSafelyInspectableResponse,
	isTextualNetworkContentType,
	type NetworkBodyContext,
	type NetworkCaptureTransport,
	type NetworkEvent,
	type NetworkTimingPhases,
	parseContentLength,
	prepareRequestBodyCapture,
	prepareResponseBodyCapture,
	requestMethod,
	requestUrl,
	type StartedNetworkBodyCapture,
	safelyGetHeaderValue,
	safelyInspectRequestBody,
	safelyInspectRequestMethod,
	safelyInspectRequestSignal,
	safelyInspectResponseBody,
	safelyInspectResponseHeaders,
	safelyInspectResponseStatus,
} from './network-capture';

export type {
	NetworkBodyContext,
	NetworkCacheStatus,
	NetworkCaptureTransport,
	NetworkEvent,
	NetworkEventState,
	NetworkTimingPhases,
} from './network-capture';
export { formatNetworkBytes, parseNetworkUrl } from './network-capture';

type FetchImplementation = typeof fetch;
type FetchLayer = (
	base: FetchImplementation,
	wrapperId: string,
) => FetchImplementation;
type FetchLayerRecord = {
	id: string;
	layer: FetchLayer;
	currentWrapperId?: string;
};
type NetworkTimingUpdate = Omit<NetworkTimingPhases, 'totalMs'>;
type InstalledGlobalFetchLayer = Readonly<{
	id: string;
	dispose: () => void;
	currentWrapperId: () => string | undefined;
	isOwned: () => boolean;
}>;

const MAX_SIMULATED_TRANSFER_DELAY_MS = 30_000;
const MAX_CONCURRENT_BODY_CAPTURES = 32;
const MAX_IN_FLIGHT_NETWORK_ACTIONS = 256;
const BODY_CAPTURE_TIMEOUT_MS = 10_000;
const MAX_RAW_CAPTURE_TEXT_CODE_UNITS = 64 * 1024;
const MAX_SIMULATION_SEED_URL_CODE_UNITS = 1024;
const MAX_STREAMING_ABORT_BRIDGE_FALLBACK_MS = 10 * 60_000;
const SIMULATION_CAPABILITY_POLL_INTERVAL_MS = 250;
// Standard, vendor-neutral correlation headers. A host that emits its own
// vendor header passes it through the plugin options instead.
const DEFAULT_CORRELATION_ID_HEADERS = Object.freeze([
	'x-request-id',
	'traceparent',
]);
const DEFAULT_PARENT_EVENT_ID_HEADERS = Object.freeze(['x-parent-event-id']);
const CAPTURE_AUTHORITY_POLL_INTERVAL_MS = 250;
const SIMULATION_AUTHORITY_RECHECK_INTERVAL_MS = 50;
const REPLAY_MODELED_REQUEST_INIT_KEYS = new Set([
	'body',
	'headers',
	'method',
	'signal',
]);
const STANDARD_REQUEST_INIT_KEYS = [
	'attributionReporting',
	'body',
	'browsingTopics',
	'cache',
	'credentials',
	'duplex',
	'headers',
	'integrity',
	'keepalive',
	'method',
	'mode',
	'priority',
	'redirect',
	'referrer',
	'referrerPolicy',
	'signal',
	'window',
] as const;

let streamingAbortBridgeFinalizerConstructor:
	| typeof FinalizationRegistry
	| undefined;
let streamingAbortBridgeFinalizer: FinalizationRegistry<() => void> | undefined;

function getStreamingAbortBridgeFinalizer():
	| FinalizationRegistry<() => void>
	| undefined {
	const finalizerConstructor = globalThis.FinalizationRegistry;
	if (typeof finalizerConstructor !== 'function') {
		streamingAbortBridgeFinalizerConstructor = undefined;
		streamingAbortBridgeFinalizer = undefined;
		return undefined;
	}
	if (
		streamingAbortBridgeFinalizer &&
		streamingAbortBridgeFinalizerConstructor === finalizerConstructor
	) {
		return streamingAbortBridgeFinalizer;
	}
	streamingAbortBridgeFinalizerConstructor = finalizerConstructor;
	streamingAbortBridgeFinalizer = new finalizerConstructor<() => void>(
		(cleanup) => {
			try {
				cleanup();
			} catch {
				// Finalization is best-effort and must not surface into the host.
			}
		},
	);
	return streamingAbortBridgeFinalizer;
}

type RequestInitInspection = Readonly<{
	safeToRead: boolean;
	descriptors: PropertyDescriptorMap;
	diagnosticInit?: RequestInit;
	replayStable: boolean;
}>;

function inspectRequestInit(
	init: RequestInit | undefined,
): RequestInitInspection {
	if (init === undefined) {
		return {
			safeToRead: true,
			descriptors: Object.create(null),
			replayStable: true,
		};
	}
	try {
		const prototype = Object.getPrototypeOf(init);
		if (prototype !== Object.prototype && prototype !== null) {
			return {
				safeToRead: false,
				descriptors: Object.create(null),
				replayStable: false,
			};
		}
		const descriptors = Object.create(null) as PropertyDescriptorMap;
		const diagnosticInit = Object.create(null) as RequestInit;
		for (const key of STANDARD_REQUEST_INIT_KEYS) {
			const descriptor = Object.getOwnPropertyDescriptor(init, key);
			if (descriptor) {
				if (!('value' in descriptor)) {
					return {
						safeToRead: false,
						descriptors: Object.create(null),
						replayStable: false,
					};
				}
				if (
					key === 'signal' &&
					descriptor.configurable === false &&
					descriptor.writable === false
				) {
					// A Proxy may not report a different value for a frozen data slot.
					return {
						safeToRead: false,
						descriptors: Object.create(null),
						replayStable: false,
					};
				}
				descriptors[key] = descriptor;
				Object.defineProperty(diagnosticInit, key, {
					configurable: false,
					enumerable: true,
					value: descriptor.value,
					writable: false,
				});
				continue;
			}
			// Fetch reads WebIDL dictionary members through the prototype chain. A
			// missing own descriptor is therefore safe only when that member is absent,
			// while irrelevant own properties never need to be enumerated.
			if (key in init) {
				return {
					safeToRead: false,
					descriptors: Object.create(null),
					replayStable: false,
				};
			}
		}
		return {
			safeToRead: true,
			descriptors,
			diagnosticInit: Object.freeze(diagnosticInit),
			// Defined init dictionaries reach this branch only behind an explicit host
			// trust boundary. The detached projection freezes the values used for the
			// diagnostic/replay decision; unmodeled standard members are rejected later.
			replayStable: true,
		};
	} catch {
		return {
			safeToRead: false,
			descriptors: Object.create(null),
			replayStable: false,
		};
	}
}

function isCanonicalRequestInput(
	input: RequestInfo | URL,
	trustedInput = false,
): boolean {
	try {
		if (typeof input === 'string') return true;
		if (!trustedInput) return false;
		// A trusted/canonical Request must win over URL detection. Some React
		// Native URL polyfills expose a generic toString implementation that can
		// accept arbitrary objects without proving a URL brand.
		if (isSafelyInspectableRequest(input, trustedInput)) return true;
		try {
			const hrefGetter = Object.getOwnPropertyDescriptor(
				URL.prototype,
				'href',
			)?.get;
			return (
				typeof hrefGetter === 'function' &&
				typeof Reflect.apply(hrefGetter, input, []) === 'string'
			);
		} catch {
			return false;
		}
	} catch {
		return false;
	}
}

type CanonicalRequestConstruction = Readonly<{
	request: Request;
	replayStable: boolean;
}>;

function isReplayStableCanonicalSource(input: RequestInfo | URL): boolean {
	// Do not preflight any object source. URL and Request implementations may be
	// JavaScript polyfills whose apparent intrinsic getters read through Proxy
	// receivers. The Request constructor remains the single authority touching
	// them, while replay conservatively stays disabled for object inputs.
	return typeof input === 'string';
}

/**
 * Canonicalizes exactly once while observing only the WebIDL reads performed by
 * the host Request constructor itself. This is not a preflight: the forwarding
 * proxy adds no reads, preserves the original receiver for accessors, and the
 * resulting Request is the exact object sent to fetch.
 */
function constructCanonicalRequest(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
): CanonicalRequestConstruction {
	let replayStable = isReplayStableCanonicalSource(input);
	let forwardedInit = init;
	if (init !== undefined) {
		if (
			(init !== null && typeof init === 'object') ||
			typeof init === 'function'
		) {
			forwardedInit = new Proxy(init, {
				get(target, key) {
					const value = Reflect.get(target, key, target);
					if (
						typeof key === 'string' &&
						!REPLAY_MODELED_REQUEST_INIT_KEYS.has(key) &&
						value !== undefined
					) {
						replayStable = false;
					}
					return value;
				},
			});
		} else {
			// Preserve the Request constructor's own validation for unusual runtime
			// values, but never claim their hidden dictionary state is replayable.
			replayStable = false;
		}
	}
	return {
		request: new Request(input, forwardedInit),
		replayStable,
	};
}

function canonicalRequestBodyInit(request: Request): Readonly<{
	found: boolean;
	present?: boolean;
	body?: BodyInit | null;
	opaque?: boolean;
}> {
	try {
		// React Native's whatwg-fetch Request retains the exact normalized body in
		// this owned data slot. Native Request implementations simply fall back to
		// their bounded clone stream when the slot is absent.
		const descriptor = Object.getOwnPropertyDescriptor(request, '_bodyInit');
		if (!descriptor || !('value' in descriptor)) return { found: false };
		const body = descriptor.value;
		if (body == null) return { found: true, present: false, body: null };
		if (typeof body === 'string') {
			return { found: true, present: true, body };
		}
		// The Request may retain a reference to a caller-owned object. Never probe
		// that value while building diagnostics; presence is enough to fail closed.
		return { found: true, present: true, opaque: true };
	} catch {
		return { found: false };
	}
}

function requestInitWithSignal(
	init: RequestInit | undefined,
	signal: AbortSignal,
): RequestInit {
	if (init === undefined) {
		return { signal };
	}
	// Overlay only the WebIDL read for `signal`; forwarding every other operation
	// preserves bounded custom-fetch options without enumerating or copying them.
	return new Proxy(init, {
		get(target, key) {
			return key === 'signal' ? signal : Reflect.get(target, key, target);
		},
	});
}
export const NETWORK_SIMULATION_CAPABILITY_ID = 'network.set-profile';
const NETWORK_SIMULATION_CLEAR_CAPABILITY_ID = 'network.clear-profile';
const NETWORK_CAPTURE_CLEAR_CAPABILITY_ID = 'network.clear';

let nextNetworkPluginInstance = 1;
let nextNetworkSessionNamespace = 1;

function createOpaqueNetworkSessionId(): string {
	const sequence = nextNetworkSessionNamespace;
	nextNetworkSessionNamespace += 1;
	try {
		const candidate = globalThis.crypto?.randomUUID?.();
		if (
			typeof candidate === 'string' &&
			/^[A-Za-z0-9-]{1,64}$/.test(candidate)
		) {
			return candidate;
		}
	} catch {
		// Older React Native runtimes fall through to a collision-free namespace.
	}
	const mixed = Math.imul(sequence ^ 0x4f1bbcdc, 0x45d9f3b) >>> 0;
	return `fallback-${mixed.toString(36)}-${Date.now().toString(36)}`;
}

function networkEventResourceId(event: Pick<NetworkEvent, 'id' | 'sessionId'>) {
	return `${event.sessionId}:${event.id}`;
}

function monotonicNow(): number {
	try {
		const value = globalThis.performance?.now?.();
		if (typeof value === 'number' && Number.isFinite(value)) return value;
	} catch {
		// A replaced performance implementation cannot break app requests.
	}
	return Date.now();
}

function networkSimulationError(message: string): Error {
	const error = new Error(message);
	error.name = 'NetworkSimulationError';
	return error;
}

function abortedRequestError(): Error {
	const error = new Error('The request was aborted.');
	error.name = 'AbortError';
	return error;
}

function safelyInspectErrorName(error: unknown): string | undefined {
	if (!error || (typeof error !== 'object' && typeof error !== 'function')) {
		return undefined;
	}
	try {
		const ownName = Object.getOwnPropertyDescriptor(error, 'name');
		if (ownName) {
			return 'value' in ownName && typeof ownName.value === 'string'
				? ownName.value
				: undefined;
		}
	} catch {
		// Hostile rejected values remain ordinary request errors.
	}
	return undefined;
}

function deterministicHash(value: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

function requestSignal(
	input: RequestInfo | URL,
	init?: RequestInit,
	trustedInput = false,
): AbortSignal | undefined {
	try {
		if (init !== undefined && 'signal' in init) {
			if (init.signal === null) return undefined;
			if (init.signal !== undefined) return init.signal;
		}
		if (typeof Request !== 'undefined' && input instanceof Request) {
			if (isSafelyInspectableRequest(input, trustedInput)) {
				return safelyInspectRequestSignal(input, trustedInput);
			}
		}
	} catch {
		// The real fetch remains responsible for malformed or hostile input.
	}
	return undefined;
}

function knownRequestBodyBytes(init?: RequestInit): number | undefined {
	try {
		const body = init?.body;
		if (typeof body === 'string') {
			return body.length <= MAX_RAW_CAPTURE_TEXT_CODE_UNITS
				? utf8ByteLength(body)
				: undefined;
		}
		if (
			typeof ArrayBuffer !== 'undefined' &&
			body instanceof ArrayBuffer &&
			Object.getPrototypeOf(body) === ArrayBuffer.prototype
		) {
			const byteLength = Object.getOwnPropertyDescriptor(
				ArrayBuffer.prototype,
				'byteLength',
			)?.get?.call(body);
			return typeof byteLength === 'number' && Number.isFinite(byteLength)
				? byteLength
				: undefined;
		}
		if (
			typeof Blob !== 'undefined' &&
			body instanceof Blob &&
			Object.getPrototypeOf(body) === Blob.prototype
		) {
			const size = Object.getOwnPropertyDescriptor(
				Blob.prototype,
				'size',
			)?.get?.call(body);
			return typeof size === 'number' && Number.isFinite(size)
				? size
				: undefined;
		}
		const viewBytes = arrayBufferViewByteLength(body);
		if (viewBytes !== undefined) return viewBytes;
		if (
			typeof URLSearchParams !== 'undefined' &&
			body instanceof URLSearchParams &&
			Object.getPrototypeOf(body) === URLSearchParams.prototype
		) {
			const safe = new URLSearchParams();
			let count = 0;
			let codeUnits = 0;
			for (const [name, value] of URLSearchParams.prototype.entries.call(
				body,
			)) {
				count += 1;
				codeUnits += name.length + value.length;
				if (count > 100 || codeUnits > MAX_RAW_CAPTURE_TEXT_CODE_UNITS) {
					return undefined;
				}
				safe.append(name, value);
			}
			const text = URLSearchParams.prototype.toString.call(safe);
			return text.length <= MAX_RAW_CAPTURE_TEXT_CODE_UNITS
				? utf8ByteLength(text)
				: undefined;
		}
	} catch {
		// Unknown request bodies are not inspected for simulation.
	}
	return undefined;
}

function inferredRequestBodyContentType(
	init: RequestInit | undefined,
): string | undefined {
	try {
		const body = init?.body;
		if (typeof body === 'string') {
			return 'text/plain;charset=UTF-8';
		}
		if (
			typeof URLSearchParams !== 'undefined' &&
			body instanceof URLSearchParams &&
			Object.getPrototypeOf(body) === URLSearchParams.prototype
		) {
			return 'application/x-www-form-urlencoded;charset=UTF-8';
		}
		if (
			typeof Blob !== 'undefined' &&
			body instanceof Blob &&
			Object.getPrototypeOf(body) === Blob.prototype
		) {
			const type = Object.getOwnPropertyDescriptor(
				Blob.prototype,
				'type',
			)?.get?.call(body);
			if (typeof type !== 'string' || type.length === 0) return undefined;
			const bounded = truncateText(type, 1024);
			return bounded.truncated ? undefined : bounded.text;
		}
	} catch {
		// Hostile request bodies have no diagnostic MIME provenance.
	}
	return undefined;
}

function transferDelayMs(
	bytes: number,
	kilobitsPerSecond: number | null,
): number {
	if (bytes <= 0 || !kilobitsPerSecond || kilobitsPerSecond <= 0) return 0;
	return Math.min(
		MAX_SIMULATED_TRANSFER_DELAY_MS,
		(bytes * 8 * 1_000) / (kilobitsPerSecond * 1_000),
	);
}

function abortableDelay(
	milliseconds: number,
	signal?: AbortSignal,
): Promise<void> {
	if (milliseconds <= 0) {
		return signal?.aborted
			? Promise.reject(signal.reason ?? abortedRequestError())
			: Promise.resolve();
	}
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (error?: unknown): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
			if (error !== undefined) reject(error);
			else resolve();
		};
		const onAbort = (): void => finish(signal?.reason ?? abortedRequestError());
		const timer = setTimeout(() => finish(), milliseconds);
		if (signal?.aborted) onAbort();
		else signal?.addEventListener('abort', onAbort, { once: true });
	});
}

async function runSimulatedFetch(
	fetchImplementation: FetchImplementation,
	input: RequestInfo | URL,
	transportInit: RequestInit | undefined,
	diagnosticInit: RequestInit | undefined,
	trustedRequest: boolean,
	knownCanonicalRequestBytes: number | undefined,
	trustedResponse: boolean,
	profile: NetworkSimulationProfile,
	sequence: number,
	epochSignal: AbortSignal,
	isAuthorityCurrent: () => boolean,
	onTiming: (timing: NetworkTimingUpdate) => void,
): Promise<Response> {
	if (profile.id === 'none') {
		const transportStartedAt = monotonicNow();
		try {
			return await fetchImplementation(input, transportInit);
		} finally {
			onTiming({
				transportMs: Math.max(0, monotonicNow() - transportStartedAt),
			});
		}
	}
	const callerSignal = requestSignal(input, diagnosticInit, trustedRequest);
	if (callerSignal?.aborted) {
		throw callerSignal.reason ?? abortedRequestError();
	}
	if (epochSignal.aborted) {
		throw (
			epochSignal.reason ??
			networkSimulationError('The network simulation authority changed.')
		);
	}
	let key = `request-${sequence}`;
	try {
		const rawSeedUrl = requestUrl(input, trustedRequest);
		const seedUrl =
			rawSeedUrl.length > MAX_SIMULATION_SEED_URL_CODE_UNITS
				? `[URL OVER LIMIT:${rawSeedUrl.length}]`
				: rawSeedUrl;
		key = `${requestMethod(input, diagnosticInit, trustedRequest)}:${seedUrl}:${sequence}`;
	} catch {
		// A stable sequence still provides deterministic behavior for hostile input.
	}
	const hash = deterministicHash(key);
	const jitterUnit = ((hash >>> 8) % 20_001) / 10_000 - 1;
	const latencyMs = Math.max(
		0,
		profile.latencyMs + profile.jitterMs * jitterUnit,
	);
	const uploadDelayMs = transferDelayMs(
		knownCanonicalRequestBytes ?? knownRequestBodyBytes(diagnosticInit) ?? 0,
		profile.uploadKbps,
	);
	onTiming({ latencyDelayMs: latencyMs, uploadDelayMs });
	const failureHash = deterministicHash(`${key}:failure`);
	const packetLossHash = deterministicHash(`${key}:request-loss`);

	let timeout: ReturnType<typeof setTimeout> | undefined;
	const timeoutController =
		profile.timeoutMs === null ? undefined : new AbortController();
	const delayController = new AbortController();
	const delayListenerCleanups: Array<() => void> = [];
	let delayListenersReleased = false;
	const releaseDelayListeners = (): void => {
		if (delayListenersReleased) return;
		delayListenersReleased = true;
		for (const cleanup of delayListenerCleanups) cleanup();
	};
	let authorityRevoked: boolean = epochSignal.aborted;
	const disarmProfileTimeout = (): void => {
		authorityRevoked = true;
		if (timeout !== undefined) {
			clearTimeout(timeout);
			timeout = undefined;
		}
	};
	if (!epochSignal.aborted) {
		epochSignal.addEventListener('abort', disarmProfileTimeout, { once: true });
	}
	for (const signal of [callerSignal, epochSignal, timeoutController?.signal]) {
		if (!signal) continue;
		const onAbort = (): void => {
			delayController.abort(
				signal.reason ??
					(signal === epochSignal
						? networkSimulationError(
								'The network simulation authority changed.',
							)
						: abortedRequestError()),
			);
		};
		if (signal.aborted) onAbort();
		else {
			signal.addEventListener('abort', onAbort, { once: true });
			delayListenerCleanups.push(() =>
				signal.removeEventListener('abort', onAbort),
			);
		}
	}
	let transportSignal = callerSignal;
	let effectiveInit = transportInit;
	let manualTransportCleanup: (() => void) | undefined;
	let manualTransportUnregisterToken: object | undefined;
	let manualTransportFallbackTimeout: ReturnType<typeof setTimeout> | undefined;
	const abortBridgeFinalizer = getStreamingAbortBridgeFinalizer();
	const releaseManualTransportBridge = (): void => {
		if (manualTransportFallbackTimeout !== undefined) {
			clearTimeout(manualTransportFallbackTimeout);
			manualTransportFallbackTimeout = undefined;
		}
		if (manualTransportUnregisterToken) {
			abortBridgeFinalizer?.unregister(manualTransportUnregisterToken);
			manualTransportUnregisterToken = undefined;
		}
		const cleanup = manualTransportCleanup;
		manualTransportCleanup = undefined;
		cleanup?.();
	};
	if (timeoutController) {
		if (callerSignal) {
			type AbortSignalWithAny = typeof AbortSignal & {
				any?: (signals: readonly AbortSignal[]) => AbortSignal;
			};
			const combineSignals = (AbortSignal as AbortSignalWithAny).any;
			if (typeof combineSignals === 'function') {
				transportSignal = combineSignals.call(AbortSignal, [
					callerSignal,
					timeoutController.signal,
				]);
			} else {
				const transportController = new AbortController();
				const cleanups: Array<() => void> = [];
				const cleanup = (): void => {
					for (const remove of cleanups.splice(0)) remove();
				};
				manualTransportCleanup = cleanup;
				for (const signal of [callerSignal, timeoutController.signal]) {
					const onAbort = (): void => {
						transportController.abort(signal.reason ?? abortedRequestError());
						releaseManualTransportBridge();
					};
					if (signal.aborted) onAbort();
					else {
						signal.addEventListener('abort', onAbort, { once: true });
						cleanups.push(() => signal.removeEventListener('abort', onAbort));
					}
				}
				transportSignal = transportController.signal;
			}
		} else {
			transportSignal = timeoutController.signal;
		}
		effectiveInit = requestInitWithSignal(transportInit, transportSignal);
	}
	let timeoutPromise: Promise<never> | undefined;
	if (timeoutController && !authorityRevoked) {
		timeoutPromise = new Promise<never>((_resolve, reject) => {
			timeout = setTimeout(() => {
				timeout = undefined;
				if (epochSignal.aborted || !isAuthorityCurrent()) {
					disarmProfileTimeout();
					return;
				}
				const error = networkSimulationError(
					`Instrumented request timed out after ${profile.timeoutMs} ms.`,
				);
				reject(error);
				timeoutController.abort(error);
				delayController.abort(error);
				releaseDelayListeners();
			}, profile.timeoutMs ?? 0);
		});
	}

	const performSimulatedFetch = async (): Promise<Response> => {
		await abortableDelay(latencyMs + uploadDelayMs, delayController.signal);
		releaseDelayListeners();
		if (!isAuthorityCurrent()) {
			throw networkSimulationError(
				'The network simulation authority changed before transport started.',
			);
		}
		if (profile.offline) {
			throw networkSimulationError(
				'Instrumented request blocked by the Offline network profile.',
			);
		}
		if ((failureHash % 10_000) / 100 < profile.failurePercent) {
			throw networkSimulationError(
				`Instrumented request failed by the ${profile.name} network profile.`,
			);
		}
		if ((packetLossHash % 10_000) / 100 < profile.packetLossPercent) {
			throw networkSimulationError(
				`Instrumented request dropped by the ${profile.name} request-loss model.`,
			);
		}

		const transportStartedAt = monotonicNow();
		let response: Response;
		try {
			response = await fetchImplementation(input, effectiveInit);
		} finally {
			onTiming({
				transportMs: Math.max(0, monotonicNow() - transportStartedAt),
			});
		}
		if (manualTransportCleanup) {
			let responseBody: ReadableStream<Uint8Array> | null | undefined;
			let bodyInspectionFailed = false;
			if (!isSafelyInspectableResponse(response, trustedResponse)) {
				bodyInspectionFailed = true;
			} else {
				try {
					responseBody = safelyInspectResponseBody(response, trustedResponse);
				} catch {
					bodyInspectionFailed = true;
				}
			}
			if (!bodyInspectionFailed && responseBody == null) {
				releaseManualTransportBridge();
			} else if (abortBridgeFinalizer) {
				const cleanup = manualTransportCleanup;
				const unregisterToken = Object.freeze({});
				const finalizationTarget =
					responseBody !== null &&
					(typeof responseBody === 'object' ||
						typeof responseBody === 'function')
						? responseBody
						: response;
				abortBridgeFinalizer.register(
					finalizationTarget,
					cleanup,
					unregisterToken,
				);
				manualTransportUnregisterToken = unregisterToken;
			} else {
				// Older runtimes without GC-aware cleanup cannot observe stream
				// completion without consuming it. Bound that compatibility bridge.
				manualTransportFallbackTimeout = setTimeout(
					releaseManualTransportBridge,
					MAX_STREAMING_ABORT_BRIDGE_FALLBACK_MS,
				);
			}
		}
		if (!isAuthorityCurrent()) return response;
		let responseBytes = 0;
		if (isSafelyInspectableResponse(response, trustedResponse)) {
			try {
				const responseHeaders = safelyInspectResponseHeaders(
					response,
					trustedResponse,
				);
				responseBytes =
					parseContentLength(
						safelyGetHeaderValue(
							responseHeaders,
							'content-length',
							trustedResponse,
						),
					) ?? 0;
			} catch {
				// Unknown-length streams are returned without synthetic transfer delay.
			}
		}
		const downloadDelayMs = transferDelayMs(
			responseBytes,
			profile.downloadKbps,
		);
		onTiming({ downloadDelayMs });
		let remainingDownloadDelayMs = downloadDelayMs;
		while (remainingDownloadDelayMs > 0) {
			const shapingController = new AbortController();
			const shapingListenerCleanups: Array<() => void> = [];
			for (const signal of [transportSignal, epochSignal]) {
				if (!signal) continue;
				const onAbort = (): void =>
					shapingController.abort(signal.reason ?? abortedRequestError());
				if (signal.aborted) onAbort();
				else {
					signal.addEventListener('abort', onAbort, { once: true });
					shapingListenerCleanups.push(() =>
						signal.removeEventListener('abort', onAbort),
					);
				}
			}
			const chunkMs = Math.min(
				remainingDownloadDelayMs,
				SIMULATION_AUTHORITY_RECHECK_INTERVAL_MS,
			);
			try {
				await abortableDelay(chunkMs, shapingController.signal);
			} catch (error) {
				if (transportSignal?.aborted) throw error;
				if (epochSignal.aborted) return response;
				throw error;
			} finally {
				for (const cleanup of shapingListenerCleanups) cleanup();
			}
			remainingDownloadDelayMs -= chunkMs;
			if (!isAuthorityCurrent()) return response;
		}
		return response;
	};

	let completedSuccessfully = false;
	try {
		const response = timeoutPromise
			? await Promise.race([performSimulatedFetch(), timeoutPromise])
			: await performSimulatedFetch();
		completedSuccessfully = true;
		return response;
	} finally {
		if (timeout) clearTimeout(timeout);
		epochSignal.removeEventListener('abort', disarmProfileTimeout);
		releaseDelayListeners();
		if (!completedSuccessfully) releaseManualTransportBridge();
		// A successful streaming response keeps the caller bridge until abort or
		// garbage collection so cancellation semantics do not silently expire.
	}
}

const globalFetchLayers = new Map<symbol, FetchLayerRecord>();
let globalFetchBase: FetchImplementation | undefined;
let installedGlobalFetch: FetchImplementation | undefined;
let nextGlobalFetchWrapper = 1;

function rebuildGlobalFetch(): void {
	if (!globalFetchBase) return;
	let next = globalFetchBase;
	const wrapperIds = new Map<FetchLayerRecord, string>();
	for (const record of globalFetchLayers.values()) {
		const wrapperId = `${record.id}:wrapper-${nextGlobalFetchWrapper}`;
		nextGlobalFetchWrapper += 1;
		wrapperIds.set(record, wrapperId);
		next = record.layer(next, wrapperId);
	}
	globalThis.fetch = next;
	for (const [record, wrapperId] of wrapperIds) {
		record.currentWrapperId = wrapperId;
	}
	installedGlobalFetch = next;
}

/** Installs composable fetch instrumentation without leaking middle wrappers. */
function installGlobalFetchLayer(
	id: string,
	layer: FetchLayer,
): InstalledGlobalFetchLayer {
	if (typeof globalThis.fetch !== 'function') {
		return Object.freeze({
			id,
			dispose: () => {},
			currentWrapperId: () => undefined,
			isOwned: () => false,
		});
	}
	if (globalFetchLayers.size > 0 && globalThis.fetch !== installedGlobalFetch) {
		throw new Error('Global fetch changed while diagnostics were installed.');
	}
	const previousBase = globalFetchBase;
	const previousInstalled = installedGlobalFetch;
	if (globalFetchLayers.size === 0) globalFetchBase = globalThis.fetch;
	const token = Symbol('devtools-fetch-layer');
	const record: FetchLayerRecord = { id, layer };
	globalFetchLayers.set(token, record);
	try {
		rebuildGlobalFetch();
	} catch (error) {
		globalFetchLayers.delete(token);
		globalFetchBase = previousBase;
		installedGlobalFetch = previousInstalled;
		throw error;
	}
	let active = true;
	const dispose = () => {
		if (!active) return;
		active = false;
		globalFetchLayers.delete(token);
		try {
			if (globalThis.fetch === installedGlobalFetch) {
				if (globalFetchLayers.size > 0) rebuildGlobalFetch();
				else if (globalFetchBase) globalThis.fetch = globalFetchBase;
			}
		} finally {
			if (globalFetchLayers.size === 0) {
				globalFetchBase = undefined;
				installedGlobalFetch = undefined;
			}
		}
	};
	return Object.freeze({
		id,
		dispose,
		currentWrapperId: () => (active ? record.currentWrapperId : undefined),
		isOwned: () =>
			active &&
			globalFetchLayers.has(token) &&
			globalThis.fetch === installedGlobalFetch,
	});
}

export type NetworkPluginOptions = {
	captureBody?: boolean;
	/** Dynamic owner/session token. A null/invalid token fails capture closed. */
	captureAuthority?: () => string | null;
	/** Publishes owner/session changes so retained diagnostics clear immediately. */
	subscribeCaptureAuthority?: (listener: () => void) => () => void;
	/** Enables app-scoped request simulation. Defaults to false. */
	enableSimulation?: boolean;
	/**
	 * Enables confirmed replay of safely captured requests through the owned
	 * global-fetch layer. Ignored unless `patchGlobalFetch` is also true.
	 */
	enableRequestReplay?: boolean;
	/**
	 * Dynamic host policy for the `set-profile` mutation. A runtime capability
	 * registry can pass `() => registry.toActionCapability(toolId, operation)`.
	 */
	simulationCapability?: DevToolsCapability | (() => DevToolsCapability);
	subscribeSimulationCapability?: (listener: () => void) => () => void;
	actionCoordinator?: DevToolsActionCoordinator;
	/** Receives the plugin's public, session-scoped action receipts. */
	onActionReceipt?: (receipt: DevToolsActionReceipt) => void;
	/** Optional shared timeline; request detail remains in this plugin's store. */
	eventStore?: DevtoolsEventStore;
	/** Optional host correlation bridge. Returned text is redacted and bounded. */
	correlationContext?: (
		input: RequestInfo | URL,
		init: RequestInit | undefined,
	) => Readonly<{ correlationId?: string; parentEventId?: string }> | undefined;
	/**
	 * Request headers consulted for a correlation id, in preference order. A
	 * host with its own vendor header lists it first; the standard headers are
	 * the default so no vendor prefix is assumed.
	 */
	correlationIdHeaders?: readonly string[];
	/** Request headers consulted for a parent event id, in preference order. */
	parentEventIdHeaders?: readonly string[];
	maxBodyBytes?: number;
	maxEvents?: number;
	maxStoreBytes?: number;
	patchGlobalFetch?: boolean;
	/** Trusts responses produced by the host-owned global fetch implementation. */
	trustGlobalFetchResponses?: boolean;
	/** Trusts responses produced by explicit host-vetted fetch implementations. */
	trustExplicitFetchResponses?: boolean;
	/** Trusts request inputs passed to the host-owned global fetch implementation. */
	trustGlobalFetchRequests?: boolean;
	/** Trusts request inputs passed to explicit host-vetted fetch implementations. */
	trustExplicitFetchRequests?: boolean;
	/**
	 * Canonicalizes global-fetch inputs into one owned Request before diagnostics
	 * and transport. This preserves one WebIDL read while making projection safe.
	 */
	canonicalizeGlobalFetchRequests?: boolean;
	captureUnknownLengthBodies?: boolean;
	sourceLabel?: string;
	redactHeader?: (name: string, value: string) => string;
	redactUrl?: (url: string) => string;
	redactBody?: (body: string, context: NetworkBodyContext) => string;
	title?: string;
	id?: string;
	description?: string;
	section?: string;
	systemImage?: DevToolsSystemImage;
};

export type NetworkFetchInstrumentationOptions = Readonly<{
	/**
	 * Allows response access for a host-vetted fetch implementation whose result
	 * may not use the global Response prototype (for example Expo FetchResponse).
	 */
	trustedResponse?: boolean;
	/** Allows diagnostic inspection of inputs for this host-vetted fetch. */
	trustedRequest?: boolean;
	/**
	 * Replaces `(input, init)` with a single owned Request for this vetted fetch.
	 * The host must guarantee its implementation accepts Request-like inputs.
	 */
	canonicalizeRequest?: boolean;
}>;

function trustedResponseRequested(
	options: NetworkFetchInstrumentationOptions | undefined,
): boolean {
	if (options === undefined) return false;
	try {
		const prototype = Object.getPrototypeOf(options);
		if (prototype !== Object.prototype && prototype !== null) return false;
		const descriptor = Object.getOwnPropertyDescriptor(
			options,
			'trustedResponse',
		);
		return !!descriptor && 'value' in descriptor && descriptor.value === true;
	} catch {
		return false;
	}
}

function trustedRequestRequested(
	options: NetworkFetchInstrumentationOptions | undefined,
): boolean {
	if (options === undefined) return false;
	try {
		const prototype = Object.getPrototypeOf(options);
		if (prototype !== Object.prototype && prototype !== null) return false;
		const descriptor = Object.getOwnPropertyDescriptor(
			options,
			'trustedRequest',
		);
		return !!descriptor && 'value' in descriptor && descriptor.value === true;
	} catch {
		return false;
	}
}

function canonicalizeRequestRequested(
	options: NetworkFetchInstrumentationOptions | undefined,
): boolean {
	if (options === undefined) return false;
	try {
		const prototype = Object.getPrototypeOf(options);
		if (prototype !== Object.prototype && prototype !== null) return false;
		const descriptor = Object.getOwnPropertyDescriptor(
			options,
			'canonicalizeRequest',
		);
		return !!descriptor && 'value' in descriptor && descriptor.value === true;
	} catch {
		return false;
	}
}

export type NetworkSimulationState = Readonly<{
	profile: NetworkSimulationProfile;
	capability: DevToolsCapability;
	active: boolean;
	scope: 'instrumented-fetch';
	limitations: readonly [
		'No native SDK or arbitrary app traffic',
		'No WebSocket interception',
		'Known-size request and response shaping only',
	];
}>;

export type NetworkPlugin = {
	plugin: DevToolsPanelPlugin;
	instrumentFetch: (
		fetchImplementation: FetchImplementation,
		options?: NetworkFetchInstrumentationOptions,
	) => FetchImplementation;
	clear: () => void;
	/** Confirmed first-party clear path; `clear` remains for collector compatibility. */
	requestClear: (requestId?: string) => Promise<DevToolsActionReceipt>;
	pause: () => void;
	resume: () => void;
	isPaused: () => boolean;
	getEvents: () => readonly NetworkEvent[];
	getSimulationProfile: () => NetworkSimulationProfile;
	getSimulationState: () => NetworkSimulationState;
	subscribeSimulationState: (listener: () => void) => () => void;
	setSimulationProfile: (
		profileId: NetworkSimulationProfileId,
		requestId?: string,
	) => Promise<DevToolsActionReceipt>;
	clearSimulationProfile: (
		requestId?: string,
	) => Promise<DevToolsActionReceipt>;
	exportSimulationPreference: () => string;
	importSimulationPreference: (
		serialized: string,
		requestId?: string,
	) => Promise<DevToolsActionReceipt>;
};

import {
	NetworkEventDetail,
	secondarySmall,
	statusColor,
} from './network-detail';
import {
	collapseNetworkEvents,
	inferNetworkCacheStatus,
	isSystemNetworkEvent,
	MAX_NETWORK_BODY_BYTES,
	MAX_NETWORK_EVENTS,
	MAX_NETWORK_STORE_BYTES,
	matchesNetworkSearch,
	matchesNetworkSegment,
	type NetworkSegment,
	networkEventLabel,
	networkReplayBlockReason,
	networkRowSubtitle,
	networkStatusPresentation,
	summarizeNetworkEvents,
	summarizeNetworkInsights,
} from './network-presentation';

export * from './network-presentation';

export function createNetworkPlugin(
	options: NetworkPluginOptions = {},
): NetworkPlugin {
	const captureBody = options.captureBody ?? false;
	const simulationEnabled = options.enableSimulation ?? false;
	const requestReplayEnabled =
		options.enableRequestReplay === true && options.patchGlobalFetch === true;
	const captureUnknownLengthBodies =
		options.captureUnknownLengthBodies ?? false;
	const maxBodyBytes = options.maxBodyBytes ?? MAX_NETWORK_BODY_BYTES;
	assertPositiveFinite(maxBodyBytes, 'maxBodyBytes');
	const maxEvents = options.maxEvents ?? 200;
	const maxStoreBytes = options.maxStoreBytes ?? 8 * 1024 * 1024;
	assertPositiveInteger(maxEvents, 'maxEvents');
	assertPositiveFinite(maxStoreBytes, 'maxStoreBytes');
	if (maxBodyBytes > MAX_NETWORK_BODY_BYTES) {
		throw new Error(`maxBodyBytes cannot exceed ${MAX_NETWORK_BODY_BYTES}`);
	}
	if (maxEvents > MAX_NETWORK_EVENTS) {
		throw new Error(`maxEvents cannot exceed ${MAX_NETWORK_EVENTS}`);
	}
	if (maxStoreBytes > MAX_NETWORK_STORE_BYTES) {
		throw new Error(`maxStoreBytes cannot exceed ${MAX_NETWORK_STORE_BYTES}`);
	}
	const redactHeader = options.redactHeader ?? defaultRedactHeader;
	const redactUrl = options.redactUrl ?? defaultRedactUrl;
	const redactBody = options.redactBody ?? defaultRedactBody;
	const title = options.title ?? 'Network';
	const pluginId = options.id ?? 'network';
	if (
		options.subscribeSimulationCapability !== undefined &&
		typeof options.subscribeSimulationCapability !== 'function'
	) {
		throw new Error('subscribeSimulationCapability must be a function');
	}
	if (
		options.subscribeCaptureAuthority !== undefined &&
		typeof options.subscribeCaptureAuthority !== 'function'
	) {
		throw new Error('subscribeCaptureAuthority must be a function');
	}
	if (
		options.correlationContext !== undefined &&
		typeof options.correlationContext !== 'function'
	) {
		throw new Error('correlationContext must be a function');
	}
	if (
		options.captureAuthority !== undefined &&
		typeof options.captureAuthority !== 'function'
	) {
		throw new Error('captureAuthority must be a function');
	}
	if (
		options.onActionReceipt !== undefined &&
		typeof options.onActionReceipt !== 'function'
	) {
		throw new Error('onActionReceipt must be a function');
	}
	const actionCoordinator =
		options.actionCoordinator ?? createDevToolsActionCoordinator();
	const pluginInstanceId = nextNetworkPluginInstance++;
	const configuredSource = options.sourceLabel
		? truncateText(redactDiagnosticText(options.sourceLabel), 4 * 1024).text
		: undefined;
	const sourceForTransport = (transport: NetworkCaptureTransport): string =>
		configuredSource ??
		(transport === 'global-fetch' ? 'Global fetch' : 'Instrumented fetch');
	const store = new BoundedEventStore<NetworkEvent>({
		maxEvents,
		maxBytes: maxStoreBytes,
		estimateBytes: (event) =>
			serializeValue(event, Number.MAX_SAFE_INTEGER).estimatedBytes,
	});
	type ActiveBodyCapture = Readonly<{
		controller: AbortController;
		resourceId: string;
		timeout: ReturnType<typeof setTimeout>;
	}>;
	const activeBodyCaptures = new Map<string, ActiveBodyCapture>();
	// Cancelled RN Blob.text() work cannot itself be aborted. Keep that actual
	// work counted after its result authority is revoked so repeated resets cannot
	// start an unbounded number of native reads.
	let inFlightBodyCaptureWork = 0;
	const retainedNetworkEvent = (resourceId: string): NetworkEvent | undefined =>
		store
			.getSnapshot()
			.find((candidate) => networkEventResourceId(candidate) === resourceId);
	const cancelBodyCapture = (key: string): void => {
		const active = activeBodyCaptures.get(key);
		if (!active) return;
		activeBodyCaptures.delete(key);
		clearTimeout(active.timeout);
		active.controller.abort();
	};
	const cancelActiveBodyCaptures = (): void => {
		for (const key of [...activeBodyCaptures.keys()]) cancelBodyCapture(key);
	};
	const cancelUnretainedBodyCaptures = (): void => {
		const retainedResourceIds = new Set(
			store.getSnapshot().map(networkEventResourceId),
		);
		for (const [key, active] of activeBodyCaptures) {
			if (!retainedResourceIds.has(active.resourceId)) cancelBodyCapture(key);
		}
	};
	const runBodyCapture = (
		resourceId: string,
		phase: 'request' | 'response',
		start: () => StartedNetworkBodyCapture,
		onResult: (captured: CapturedNetworkBody) => void,
	): void => {
		if (!retainedNetworkEvent(resourceId)) return;
		if (inFlightBodyCaptureWork >= MAX_CONCURRENT_BODY_CAPTURES) {
			onResult({
				body: '[Body omitted: capture concurrency limit]',
				complete: false,
				omitted: true,
			});
			return;
		}
		const controller = new AbortController();
		const key = `${resourceId}:${phase}`;
		cancelBodyCapture(key);
		let timeoutResult: CapturedNetworkBody | undefined;
		const timeout = setTimeout(() => {
			controller.abort();
			if (timeoutResult) settle(timeoutResult);
		}, BODY_CAPTURE_TIMEOUT_MS);
		const active: ActiveBodyCapture = { controller, resourceId, timeout };
		activeBodyCaptures.set(key, active);
		inFlightBodyCaptureWork += 1;
		let workReleased = false;
		const releaseWork = (): void => {
			if (workReleased) return;
			workReleased = true;
			inFlightBodyCaptureWork = Math.max(0, inFlightBodyCaptureWork - 1);
		};
		const settle = (captured: CapturedNetworkBody): void => {
			if (activeBodyCaptures.get(key) !== active) return;
			activeBodyCaptures.delete(key);
			clearTimeout(timeout);
			if (!retainedNetworkEvent(resourceId)) return;
			try {
				onResult(captured);
			} catch {
				// Optional diagnostic detail cannot affect the application request.
			}
		};
		let started: StartedNetworkBodyCapture;
		try {
			started = start();
		} catch {
			releaseWork();
			settle({
				body: '[Body omitted: diagnostics capture failed]',
				complete: false,
				omitted: true,
			});
			return;
		}
		if (started.kind === 'immediate') {
			releaseWork();
			settle(started.result);
			return;
		}
		timeoutResult = started.timeoutResult;
		try {
			void Promise.resolve(started.read(controller.signal)).then(
				(captured) => {
					releaseWork();
					settle(captured);
				},
				() => {
					releaseWork();
					settle({
						body: '[Body omitted: diagnostics capture failed]',
						complete: false,
						omitted: true,
					});
				},
			);
		} catch {
			releaseWork();
			settle({
				body: '[Body omitted: diagnostics capture failed]',
				complete: false,
				omitted: true,
			});
		}
	};
	const immutableEvent = (event: NetworkEvent): NetworkEvent =>
		Object.freeze({
			...event,
			requestHeaders: Object.freeze({ ...event.requestHeaders }),
			...(event.responseHeaders
				? { responseHeaders: Object.freeze({ ...event.responseHeaders }) }
				: {}),
			...(event.timing ? { timing: Object.freeze({ ...event.timing }) } : {}),
		});
	let exposedEventSource: readonly NetworkEvent[] | undefined;
	let exposedEvents: readonly NetworkEvent[] = Object.freeze([]);
	const getExposedEvents = (): readonly NetworkEvent[] => {
		const sourceEvents = store.getSnapshot();
		if (sourceEvents !== exposedEventSource) {
			exposedEventSource = sourceEvents;
			exposedEvents = Object.freeze([...sourceEvents]);
		}
		return exposedEvents;
	};
	const pausedStore = new ExternalStore(false);
	const noSimulationProfile: NetworkSimulationProfile = Object.freeze(
		getNetworkSimulationProfile('none'),
	);
	const simulationProfileStore = new ExternalStore<NetworkSimulationProfile>(
		noSimulationProfile,
	);
	let collectorActive = false;
	let collectorGeneration = 0;
	let collectorInstallEpoch = 0;
	let networkSessionId = createOpaqueNetworkSessionId();
	let nextEventId = 1;
	let simulationSequence = 0;
	let actionSequence = 0;
	let simulationEpochController = new AbortController();
	let actionReceiptEpoch = -1;
	let scopedActionSequence = 0;
	let inFlightNetworkActions = 0;
	const pendingNetworkActions = new Map<
		symbol,
		Readonly<{ controller: AbortController }>
	>();
	let actionReceipts = new Map<
		string,
		{
			binding: string;
			promise: Promise<DevToolsActionReceipt>;
		}
	>();
	const releasePendingNetworkAction = (token: symbol): void => {
		if (!pendingNetworkActions.delete(token)) return;
		inFlightNetworkActions = Math.max(0, inFlightNetworkActions - 1);
	};
	const cancelPendingNetworkActions = (): void => {
		for (const [token, pending] of [...pendingNetworkActions]) {
			pending.controller.abort();
			releasePendingNetworkAction(token);
		}
		actionReceipts = new Map();
		actionReceiptEpoch = collectorGeneration;
		scopedActionSequence = 0;
	};
	let simulationCapabilityGeneration = 0;
	let activeSimulationCapabilityId: string | undefined;
	let lastObservedSimulationCapabilityKey: string | undefined;
	let lastObservedSimulationCapabilitySnapshotKey: string | undefined;
	let activeCaptureAuthority: string | undefined;
	let lastPolledCaptureAuthority: string | undefined;
	let hostCaptureAuthoritySubscriptionActive = false;
	let captureAuthorityPoll: ReturnType<typeof setInterval> | undefined;
	let captureSessionResetting = false;
	let installedReplayLayer: InstalledGlobalFetchLayer | undefined;
	const simulationLimitations = Object.freeze([
		'No native SDK or arbitrary app traffic',
		'No WebSocket interception',
		'Known-size request and response shaping only',
	] as const);
	let cachedSimulationProfile: NetworkSimulationProfile | undefined;
	let cachedSimulationCapabilityKey: string | undefined;
	let cachedSimulationState: NetworkSimulationState | undefined;
	const resetNetworkSessionCounters = (): void => {
		networkSessionId = createOpaqueNetworkSessionId();
		nextEventId = 1;
		simulationSequence = 0;
		actionSequence = 0;
	};
	const readCaptureAuthority = (): string | undefined => {
		if (options.captureAuthority === undefined) return undefined;
		try {
			const authority = options.captureAuthority();
			if (
				typeof authority === 'string' &&
				authority.length > 0 &&
				authority.length <= 256 &&
				/^[A-Za-z0-9._:-]+$/.test(authority)
			) {
				return authority;
			}
		} catch {
			// A failed authority read disables capture for this request.
		}
		return undefined;
	};

	const unavailableSimulationCapability = (
		code: NonNullable<DevToolsCapability['reason']>['code'],
		message: string,
	): DevToolsCapability => ({
		schemaVersion: DEVTOOLS_ACTION_POLICY_VERSION,
		id: NETWORK_SIMULATION_CAPABILITY_ID,
		availability: 'unavailable',
		reason: { code, message },
	});
	const configuredSimulationCapability = (): DevToolsCapability => {
		if (!simulationEnabled) {
			return unavailableSimulationCapability(
				'disabled',
				'Instrumented fetch simulation is disabled by this host.',
			);
		}
		if (options.simulationCapability === undefined) {
			return {
				schemaVersion: DEVTOOLS_ACTION_POLICY_VERSION,
				id: NETWORK_SIMULATION_CAPABILITY_ID,
				availability: 'available',
			};
		}
		try {
			const capability =
				typeof options.simulationCapability === 'function'
					? options.simulationCapability()
					: options.simulationCapability;
			const descriptorValue = (value: object, key: string): unknown => {
				const descriptor = Object.getOwnPropertyDescriptor(value, key);
				if (descriptor && !('value' in descriptor)) {
					throw new Error('accessor-backed capability field');
				}
				return descriptor?.value;
			};
			if (!capability || typeof capability !== 'object') {
				throw new Error('invalid capability');
			}
			const schemaVersion = descriptorValue(capability, 'schemaVersion');
			const rawId = descriptorValue(capability, 'id');
			const availability = descriptorValue(capability, 'availability');
			const reason = descriptorValue(capability, 'reason');
			if (
				schemaVersion !== DEVTOOLS_ACTION_POLICY_VERSION ||
				typeof rawId !== 'string' ||
				!rawId ||
				rawId.length > 256 ||
				rawId !== rawId.trim() ||
				utf8ByteLength(rawId) > 256 ||
				!/^[A-Za-z0-9._:-]+$/.test(rawId) ||
				(availability !== 'available' && availability !== 'unavailable') ||
				(availability === 'unavailable' &&
					(!reason || typeof reason !== 'object'))
			) {
				throw new Error('invalid capability');
			}
			const id = rawId;
			if (availability === 'available') {
				return {
					schemaVersion: DEVTOOLS_ACTION_POLICY_VERSION,
					id,
					availability,
				};
			}
			if (!reason || typeof reason !== 'object') {
				throw new Error('invalid capability reason');
			}
			const reasonCode = descriptorValue(reason, 'code');
			const reasonMessage = descriptorValue(reason, 'message');
			if (
				(reasonCode !== 'disabled' &&
					reasonCode !== 'restricted' &&
					reasonCode !== 'unavailable' &&
					reasonCode !== 'unsupported') ||
				typeof reasonMessage !== 'string' ||
				!reasonMessage ||
				reasonMessage.length > 64 * 1024
			) {
				throw new Error('invalid capability reason');
			}
			const rawReasonMessage = reasonMessage.trim();
			const inspectedReasonMessage = defaultRedactBody(rawReasonMessage);
			const safeReasonMessage =
				inspectedReasonMessage === rawReasonMessage
					? truncateText(rawReasonMessage, 1024).text
					: 'Network simulation is unavailable under the current host policy.';
			if (!safeReasonMessage) throw new Error('invalid capability reason');
			return {
				schemaVersion: DEVTOOLS_ACTION_POLICY_VERSION,
				id,
				availability,
				reason: {
					code: reasonCode,
					message: safeReasonMessage,
				},
			};
		} catch {
			return unavailableSimulationCapability(
				'unsupported',
				'The host returned an invalid network simulation capability.',
			);
		}
	};
	const currentSimulationCapability = (): DevToolsCapability => {
		const configured = configuredSimulationCapability();
		const capability: DevToolsCapability =
			configured.availability === 'unavailable'
				? configured
				: !collectorActive
					? {
							schemaVersion: DEVTOOLS_ACTION_POLICY_VERSION,
							id: configured.id,
							availability: 'unavailable',
							reason: {
								code: 'unavailable',
								message:
									'Instrumented fetch simulation requires an active tools session.',
							},
						}
					: configured;
		return capability;
	};
	const effectiveSimulationProfile = (
		profile: NetworkSimulationProfile,
		capability: DevToolsCapability,
	): NetworkSimulationProfile => {
		if (profile.id === 'none') return profile;
		if (
			capability.availability === 'available' &&
			activeSimulationCapabilityId === capability.id
		) {
			return profile;
		}

		// This projection is used as a useSyncExternalStore snapshot getter, so it
		// must not reconcile authority or notify listeners. Poll, request, and action
		// paths perform the sticky session transition explicitly.
		return noSimulationProfile;
	};
	const setStoredSimulationProfile = (
		profile: NetworkSimulationProfile,
		capabilityId?: string,
	): void => {
		const storedProfile = profile.id === 'none' ? noSimulationProfile : profile;
		activeSimulationCapabilityId =
			storedProfile.id === 'none' ? undefined : capabilityId;
		simulationProfileStore.set(storedProfile);
	};
	const getSimulationState = (): NetworkSimulationState => {
		const capability = currentSimulationCapability();
		const profile = effectiveSimulationProfile(
			simulationProfileStore.getSnapshot(),
			capability,
		);
		const capabilityKey = JSON.stringify(capability);
		if (
			cachedSimulationState &&
			cachedSimulationProfile === profile &&
			cachedSimulationCapabilityKey === capabilityKey
		) {
			return cachedSimulationState;
		}
		cachedSimulationProfile = profile;
		cachedSimulationCapabilityKey = capabilityKey;
		const detachedCapability = Object.freeze({
			...capability,
			...(capability.reason
				? { reason: Object.freeze({ ...capability.reason }) }
				: {}),
		});
		cachedSimulationState = Object.freeze({
			profile: Object.freeze({ ...profile }),
			capability: detachedCapability,
			active: capability.availability === 'available' && profile.id !== 'none',
			scope: 'instrumented-fetch',
			limitations: simulationLimitations,
		});
		return cachedSimulationState;
	};
	const polledSimulationStateSubscriptions = new Set<symbol>();
	let hostCapabilitySubscriptionActive = false;
	let simulationCapabilityPoll: ReturnType<typeof setInterval> | undefined;
	let lastPolledSimulationState: NetworkSimulationState | undefined;
	const stopSimulationCapabilityPoll = (): void => {
		if (simulationCapabilityPoll !== undefined) {
			clearInterval(simulationCapabilityPoll);
			simulationCapabilityPoll = undefined;
		}
	};
	const startSimulationCapabilityPoll = (): void => {
		if (
			simulationCapabilityPoll !== undefined ||
			!collectorActive ||
			typeof options.simulationCapability !== 'function' ||
			hostCapabilitySubscriptionActive ||
			polledSimulationStateSubscriptions.size === 0
		) {
			return;
		}
		// The first subscriber may mount after an unobserved authority change.
		// Reconcile that boundary before taking the poll baseline so a later return
		// to the old ID cannot revive its stored profile or pending approvals.
		synchronizeSimulationCapability();
		lastPolledSimulationState = getSimulationState();
		simulationCapabilityPoll = setInterval(() => {
			if (!collectorActive) return;
			const next = getSimulationState();
			if (next === lastPolledSimulationState) return;
			// A polled transition is the same authority boundary as a host-pushed
			// transition: invalidate delayed approvals, active shaping, and captures.
			synchronizeSimulationCapability(next.capability, false, true);
			lastPolledSimulationState = getSimulationState();
		}, SIMULATION_CAPABILITY_POLL_INTERVAL_MS);
	};
	const subscribeSimulationState = (listener: () => void): (() => void) => {
		const subscriptionToken = Symbol('network-simulation-state');
		const unsubscribeProfile = simulationProfileStore.subscribe(() => {
			lastPolledSimulationState = getSimulationState();
			listener();
		});
		if (typeof options.simulationCapability === 'function') {
			polledSimulationStateSubscriptions.add(subscriptionToken);
			startSimulationCapabilityPoll();
		}
		return () => {
			unsubscribeProfile();
			polledSimulationStateSubscriptions.delete(subscriptionToken);
			if (polledSimulationStateSubscriptions.size === 0) {
				stopSimulationCapabilityPoll();
			}
		};
	};

	const redactCapturedBody = (
		body: string | undefined,
		context: NetworkBodyContext,
		collectorOmitted = false,
	): string | undefined => {
		if (body === undefined) return undefined;
		const rawContentType = context.contentType;
		const callbackMediaType = rawContentType
			?.split(';', 1)[0]
			?.trim()
			.toLowerCase();
		const callbackContext = Object.freeze({
			direction: context.direction,
			url: context.url,
			...(callbackMediaType &&
			/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(callbackMediaType) &&
			redactDiagnosticText(callbackMediaType) === callbackMediaType
				? { contentType: callbackMediaType }
				: {}),
		}) satisfies NetworkBodyContext;
		if (collectorOmitted) {
			try {
				const redacted = redactBody(body, callbackContext);
				if (
					typeof redacted === 'string' &&
					redacted.length <= MAX_RAW_CAPTURE_TEXT_CODE_UNITS
				) {
					return truncateText(defaultRedactBody(redacted), maxBodyBytes).text;
				}
			} catch {
				// Fixed collector markers still fail closed if a host hook rejects them.
			}
			return '[Body omitted: redaction failed]';
		}
		const mediaTypes = (rawContentType ?? '')
			.split(',')
			.map((value) => value.trim());
		if (mediaTypes.some((value) => /^multipart\//i.test(value))) {
			return '[Body omitted: multipart content]';
		}
		if (!isTextualNetworkContentType(rawContentType)) {
			return '[Body omitted: non-textual or ambiguous Content-Type]';
		}
		try {
			const isFormEncoded = mediaTypes.some((value) =>
				/^application\/x-www-form-urlencoded(?:\s*;|\s*$)/i.test(value),
			);
			// Built-in form sanitation runs on both sides of the host hook. The host
			// never receives a raw credential, and cannot reintroduce one afterward.
			const builtInProjection = isFormEncoded
				? defaultRedactFormBody(body)
				: body;
			const redacted = redactBody(builtInProjection, callbackContext);
			if (typeof redacted !== 'string') {
				return '[Body omitted: invalid redaction result]';
			}
			if (redacted.length > MAX_RAW_CAPTURE_TEXT_CODE_UNITS) {
				return '[Body omitted: redaction output limit]';
			}
			const structured = isFormEncoded
				? defaultRedactFormBody(redacted)
				: redacted;
			return truncateText(defaultRedactBody(structured), maxBodyBytes).text;
		} catch {
			return '[Body omitted: redaction failed]';
		}
	};
	const redactCapturedUrl = (
		url: unknown,
	): Readonly<{ value: string; complete: boolean }> => {
		if (typeof url !== 'string') {
			return { value: '[URL unavailable]', complete: false };
		}
		if (url === '[URL unavailable]') {
			return { value: url, complete: false };
		}
		if (url.length > MAX_RAW_CAPTURE_TEXT_CODE_UNITS) {
			return { value: '[URL omitted: input limit]', complete: false };
		}
		try {
			const builtInProjection = defaultRedactUrl(url);
			if (builtInProjection.startsWith('[URL omitted:')) {
				return { value: builtInProjection, complete: false };
			}
			const redacted = redactUrl(builtInProjection);
			if (typeof redacted !== 'string') {
				return {
					value: '[URL omitted: invalid redaction result]',
					complete: false,
				};
			}
			const safe = truncateText(defaultRedactUrl(redacted), 16 * 1024);
			return {
				value: safe.text,
				complete:
					!safe.truncated &&
					builtInProjection === url &&
					redacted === url &&
					safe.text === url,
			};
		} catch {
			return { value: '[URL omitted: redaction failed]', complete: false };
		}
	};
	const boundedNetworkErrorText = (
		error: unknown,
	): Readonly<{ text: string; omitted: boolean }> => {
		if (typeof error === 'string') {
			return error.length > MAX_RAW_CAPTURE_TEXT_CODE_UNITS
				? { text: '[Error omitted: input limit]', omitted: true }
				: { text: redactDiagnosticText(error), omitted: false };
		}
		if (typeof error === 'number' || typeof error === 'boolean') {
			return { text: String(error), omitted: false };
		}
		if (typeof error === 'bigint') {
			return { text: 'BigInt rejection', omitted: true };
		}
		if (typeof error === 'symbol') {
			return { text: 'Symbol rejection', omitted: true };
		}
		if (!error || (typeof error !== 'object' && typeof error !== 'function')) {
			return { text: 'Unknown error', omitted: true };
		}
		try {
			const fields = Object.create(null) as Record<
				'name' | 'message' | 'stack',
				string | undefined
			>;
			for (const key of ['name', 'message', 'stack']) {
				const descriptor = Object.getOwnPropertyDescriptor(error, key);
				if (!descriptor || !('value' in descriptor)) continue;
				if (typeof descriptor.value !== 'string') continue;
				if (descriptor.value.length > MAX_RAW_CAPTURE_TEXT_CODE_UNITS) {
					return { text: '[Error omitted: input limit]', omitted: true };
				}
				fields[key as 'name' | 'message' | 'stack'] = descriptor.value;
			}
			const message = fields.message || fields.name || 'Unknown error';
			return { text: redactDiagnosticText(message), omitted: false };
		} catch {
			return { text: 'Unknown error', omitted: true };
		}
	};
	const boundedContextText = (value: unknown): string | undefined => {
		if (
			typeof value !== 'string' ||
			value.length === 0 ||
			value.length > 512 ||
			value !== value.trim() ||
			!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) ||
			redactDiagnosticText(value) !== value
		) {
			return undefined;
		}
		return value;
	};
	const correlationContextProjectionFor = (
		input: RequestInfo | URL,
		init: RequestInit | undefined,
		headers: Readonly<Record<string, string>>,
		allowHostContext: boolean,
	): Readonly<{ correlationId?: string; parentEventId?: string }> => {
		let supplied:
			| Readonly<{ correlationId?: string; parentEventId?: string }>
			| undefined;
		if (allowHostContext) {
			try {
				supplied = options.correlationContext?.(input, init);
			} catch {
				// Correlation metadata is optional and cannot affect the app request.
			}
		}
		const lowerHeaders = Object.fromEntries(
			Object.entries(headers).map(([name, value]) => [
				name.toLowerCase(),
				value,
			]),
		);
		let suppliedCorrelation: unknown;
		let suppliedParent: unknown;
		try {
			suppliedCorrelation = supplied?.correlationId;
			suppliedParent = supplied?.parentEventId;
		} catch {
			// Accessor-backed host metadata is ignored.
		}
		const firstHeader = (names: readonly string[]): string | undefined => {
			for (const name of names) {
				const value = lowerHeaders[name.toLowerCase()];
				if (value !== undefined) return value;
			}
			return undefined;
		};
		const correlationId =
			boundedContextText(suppliedCorrelation) ??
			boundedContextText(
				firstHeader(
					options.correlationIdHeaders ?? DEFAULT_CORRELATION_ID_HEADERS,
				),
			);
		const parentEventId =
			boundedContextText(suppliedParent) ??
			boundedContextText(
				firstHeader(
					options.parentEventIdHeaders ?? DEFAULT_PARENT_EVENT_ID_HEADERS,
				),
			);
		return Object.freeze({
			...(correlationId ? { correlationId } : {}),
			...(parentEventId ? { parentEventId } : {}),
		});
	};
	const timelineEventIdsByResourceId = new Map<string, string>();
	const removeTimelineEvents = (resourceIds?: ReadonlySet<string>): void => {
		if (!options.eventStore || timelineEventIdsByResourceId.size === 0) return;
		const entries = [...timelineEventIdsByResourceId].filter(
			([resourceId]) =>
				resourceIds === undefined || resourceIds.has(resourceId),
		);
		if (entries.length === 0) return;
		try {
			options.eventStore.removeEvents(entries.map(([, eventId]) => eventId));
		} catch {
			// Shared timeline cleanup is best-effort and cannot break host cleanup.
		} finally {
			for (const [resourceId] of entries) {
				timelineEventIdsByResourceId.delete(resourceId);
			}
		}
	};
	const pruneTimelineEvents = (): void => {
		if (!options.eventStore || timelineEventIdsByResourceId.size === 0) return;
		try {
			const retainedTimelineIds = new Set(
				options.eventStore.getEvents().map((candidate) => candidate.id),
			);
			const retainedResourceIds = new Set(
				store.getSnapshot().map(networkEventResourceId),
			);
			const evictedResources = new Set<string>();
			for (const [
				resourceId,
				timelineEventId,
			] of timelineEventIdsByResourceId) {
				if (!retainedTimelineIds.has(timelineEventId)) {
					timelineEventIdsByResourceId.delete(resourceId);
				} else if (!retainedResourceIds.has(resourceId)) {
					evictedResources.add(resourceId);
				}
			}
			removeTimelineEvents(evictedResources);
		} catch {
			// Timeline bookkeeping cannot affect collector or fetch behavior.
		}
	};
	const publishTimelineEvent = (event: NetworkEvent): void => {
		if (!options.eventStore) return;
		try {
			const result = options.eventStore.append({
				at: event.startedAt,
				source: pluginId,
				kind: 'network.request',
				level:
					event.state === 'error' || (event.status ?? 0) >= 500
						? 'error'
						: event.state === 'aborted' ||
								(event.status ?? 0) >= 400 ||
								event.durationMs >= 1_000
							? 'warn'
							: 'info',
				title: `${event.method} ${networkEventLabel(event).label}`,
				summary: `${event.status === undefined ? event.state : `HTTP ${event.status}`} · ${Math.round(event.durationMs)} ms`,
				correlationId: event.correlationId,
				...(event.parentEventId ? { parentEventId: event.parentEventId } : {}),
				resourceRef: {
					toolId: pluginId,
					resourceId: networkEventResourceId(event),
				},
				attributes: {
					method: event.method,
					state: event.state,
					...(event.status === undefined ? {} : { status: event.status }),
					durationMs: event.durationMs,
					profile: event.simulationProfileId ?? 'none',
					cache: event.cacheStatus ?? 'unknown',
				},
			});
			if (result.status === 'accepted') {
				const resourceId = networkEventResourceId(event);
				removeTimelineEvents(new Set([resourceId]));
				timelineEventIdsByResourceId.set(resourceId, result.event.id);
				pruneTimelineEvents();
			}
		} catch {
			// Timeline observability must not affect collector or fetch behavior.
		}
	};
	const clearTimelineEvents = (resourceIds?: readonly string[]): void =>
		removeTimelineEvents(
			resourceIds === undefined ? undefined : new Set(resourceIds),
		);
	const resetCaptureSession = (
		nextAuthority: string | undefined,
		force = false,
	): void => {
		if (!force && activeCaptureAuthority === nextAuthority) return;
		collectorGeneration += 1;
		simulationCapabilityGeneration += 1;
		cancelPendingNetworkActions();
		activeCaptureAuthority = nextAuthority;
		lastPolledCaptureAuthority = nextAuthority;
		resetNetworkSessionCounters();
		captureSessionResetting = true;
		try {
			const expiredSimulationEpoch = simulationEpochController;
			simulationEpochController = new AbortController();
			expiredSimulationEpoch.abort(
				networkSimulationError('The network simulation authority changed.'),
			);
			cancelActiveBodyCaptures();
			store.clear();
			clearTimelineEvents();
			setStoredSimulationProfile(noSimulationProfile);
			pausedStore.set(false);
		} finally {
			captureSessionResetting = false;
		}
	};
	const synchronizeSimulationCapability = (
		capability = currentSimulationCapability(),
		force = false,
		notifySemanticChange = false,
	): DevToolsCapability => {
		const authorityKey = `${capability.availability}:${capability.id}`;
		const semanticKey = JSON.stringify(capability);
		const changed =
			lastObservedSimulationCapabilityKey !== undefined &&
			lastObservedSimulationCapabilityKey !== authorityKey;
		const semanticChanged =
			lastObservedSimulationCapabilitySnapshotKey !== undefined &&
			lastObservedSimulationCapabilitySnapshotKey !== semanticKey;
		lastObservedSimulationCapabilityKey = authorityKey;
		lastObservedSimulationCapabilitySnapshotKey = semanticKey;
		if (collectorActive && (force || changed) && !captureSessionResetting) {
			resetCaptureSession(readCaptureAuthority(), true);
		} else if (
			collectorActive &&
			notifySemanticChange &&
			semanticChanged &&
			!captureSessionResetting
		) {
			simulationProfileStore.set(simulationProfileStore.getSnapshot());
		}
		return capability;
	};
	const synchronizeCaptureAuthority = (
		currentAuthority = readCaptureAuthority(),
	): boolean => {
		if (options.captureAuthority === undefined) return true;
		if (currentAuthority !== activeCaptureAuthority) {
			resetCaptureSession(currentAuthority);
		}
		return currentAuthority !== undefined;
	};
	const captureAuthorityMatches = (
		expectedAuthority: string | undefined,
	): boolean => {
		if (options.captureAuthority === undefined) return true;
		const currentAuthority = readCaptureAuthority();
		const matches =
			currentAuthority !== undefined &&
			currentAuthority === expectedAuthority &&
			currentAuthority === activeCaptureAuthority;
		if (!matches) resetCaptureSession(currentAuthority);
		return matches;
	};
	const stopCaptureAuthorityPoll = (): void => {
		if (captureAuthorityPoll === undefined) return;
		clearInterval(captureAuthorityPoll);
		captureAuthorityPoll = undefined;
	};
	const startCaptureAuthorityPoll = (): void => {
		if (
			captureAuthorityPoll !== undefined ||
			!collectorActive ||
			options.captureAuthority === undefined ||
			hostCaptureAuthoritySubscriptionActive
		) {
			return;
		}
		lastPolledCaptureAuthority = readCaptureAuthority();
		captureAuthorityPoll = setInterval(() => {
			if (!collectorActive) return;
			const nextAuthority = readCaptureAuthority();
			if (nextAuthority === lastPolledCaptureAuthority) return;
			resetCaptureSession(nextAuthority);
		}, CAPTURE_AUTHORITY_POLL_INTERVAL_MS);
	};
	const replaceAndPublish = (event: NetworkEvent): void => {
		const retainedEvent = immutableEvent(event);
		const resourceId = networkEventResourceId(retainedEvent);
		if (
			store.replace(
				(candidate) => networkEventResourceId(candidate) === resourceId,
				retainedEvent,
			) &&
			store
				.getSnapshot()
				.some((candidate) => networkEventResourceId(candidate) === resourceId)
		) {
			publishTimelineEvent(retainedEvent);
		}
		cancelUnretainedBodyCaptures();
	};
	const replaceRetainedDetail = (event: NetworkEvent): void => {
		if (
			serializeValue(event, Number.MAX_SAFE_INTEGER).estimatedBytes >
			maxStoreBytes
		) {
			return;
		}
		const retainedEvent = immutableEvent(event);
		const resourceId = networkEventResourceId(retainedEvent);
		store.replace(
			(candidate) => networkEventResourceId(candidate) === resourceId,
			retainedEvent,
		);
		cancelUnretainedBodyCaptures();
		pruneTimelineEvents();
	};

	const createInstrumentedFetch = (
		fetchImplementation: FetchImplementation,
		captureTransport: NetworkCaptureTransport,
		captureLayerId?: string,
		trustedResponse = false,
		trustedRequest = false,
		canonicalizeRequest = false,
	): FetchImplementation => {
		const source = sourceForTransport(captureTransport);
		const wrappedFetch: FetchImplementation = async (input, init) => {
			const activeReplayLayer = installedReplayLayer;
			if (
				captureSessionResetting ||
				(captureTransport === 'global-fetch' &&
					(activeReplayLayer?.currentWrapperId() !== captureLayerId ||
						activeReplayLayer?.isOwned() !== true))
			) {
				return fetchImplementation(input, init);
			}
			if (!collectorActive) return fetchImplementation(input, init);
			const requestAuthority = readCaptureAuthority();
			if (options.captureAuthority !== undefined) {
				synchronizeCaptureAuthority(requestAuthority);
			}
			const observedSimulationCapability = synchronizeSimulationCapability();
			let configuredProfile = simulationProfileStore.getSnapshot();
			let authorizedProfile = effectiveSimulationProfile(
				configuredProfile,
				observedSimulationCapability,
			);
			if (configuredProfile.id !== 'none' && authorizedProfile.id === 'none') {
				// Capability revocation is sticky; a later re-enable must not silently
				// resurrect conditions or delayed approvals the host already withdrew.
				resetCaptureSession(requestAuthority, true);
				configuredProfile = noSimulationProfile;
				authorizedProfile = noSimulationProfile;
			}
			if (!collectorActive) return fetchImplementation(input, init);
			const captureAuthorized =
				options.captureAuthority === undefined ||
				requestAuthority !== undefined;
			const captureEnabled = !pausedStore.getSnapshot() && captureAuthorized;
			if (!captureEnabled && authorizedProfile.id === 'none') {
				return fetchImplementation(input, init);
			}
			let transportInput = input;
			let transportInit = init;
			let diagnosticInput = input;
			let diagnosticInputTrusted = trustedRequest;
			let canonicalReplayStable = false;
			let canonicalBody: BodyInit | null | undefined;
			let canonicalBodyFound = false;
			let canonicalBodyPresent = false;
			let canonicalBodyOpaque = false;
			if (canonicalizeRequest) {
				if (typeof Request === 'undefined') {
					throw new TypeError('Request canonicalization is unavailable.');
				}
				const canonical = constructCanonicalRequest(input, init);
				const canonicalRequest = canonical.request;
				transportInput = canonicalRequest;
				transportInit = undefined;
				diagnosticInput = canonicalRequest;
				diagnosticInputTrusted = true;
				canonicalReplayStable = canonical.replayStable;
				const retainedBody = canonicalRequestBodyInit(canonicalRequest);
				canonicalBodyFound = retainedBody.found;
				canonicalBodyPresent = retainedBody.present === true;
				canonicalBodyOpaque = retainedBody.opaque === true;
				canonicalBody = retainedBody.body;
			}
			const initInspection =
				transportInit === undefined || trustedRequest
					? inspectRequestInit(transportInit)
					: {
							safeToRead: false,
							descriptors: Object.create(null) as PropertyDescriptorMap,
							replayStable: false,
						};
			const canonicalInput =
				typeof diagnosticInput === 'string' ||
				(diagnosticInputTrusted &&
					isCanonicalRequestInput(diagnosticInput, true));
			const diagnosticInit =
				canonicalBodyFound && canonicalBody != null
					? (Object.freeze({ body: canonicalBody }) as RequestInit)
					: initInspection.diagnosticInit;
			// Unusual inputs still reach the caller's fetch unchanged. Simulation needs
			// to inspect and add a timeout signal, so it fails open for accessor-backed
			// dictionaries, inherited WebIDL fields, and non-canonical request objects.
			const activeProfile =
				initInspection.safeToRead && canonicalInput
					? authorizedProfile
					: noSimulationProfile;
			const requestGeneration = collectorGeneration;
			const requestSimulationCapabilityId = activeSimulationCapabilityId;
			const simulationAuthorityIsCurrent = (): boolean => {
				if (collectorGeneration !== requestGeneration) return false;
				if (options.captureAuthority !== undefined) {
					const currentCaptureAuthority = readCaptureAuthority();
					if (
						currentCaptureAuthority !== requestAuthority ||
						activeCaptureAuthority !== requestAuthority
					) {
						resetCaptureSession(currentCaptureAuthority);
						return false;
					}
				}
				if (activeProfile.id === 'none') return true;
				const currentCapability = currentSimulationCapability();
				if (
					currentCapability.availability !== 'available' ||
					currentCapability.id !== requestSimulationCapabilityId
				) {
					resetCaptureSession(readCaptureAuthority(), true);
					return false;
				}
				return true;
			};
			const timingUpdates: NetworkTimingUpdate = {};
			const requestSimulationEpochSignal = simulationEpochController.signal;
			const executeFetch = (): Promise<Response> => {
				simulationSequence += 1;
				return runSimulatedFetch(
					fetchImplementation,
					transportInput,
					transportInit,
					diagnosticInit,
					diagnosticInputTrusted,
					canonicalBodyFound
						? knownRequestBodyBytes(
								canonicalBody == null ? undefined : { body: canonicalBody },
							)
						: undefined,
					trustedResponse,
					activeProfile,
					simulationSequence,
					requestSimulationEpochSignal,
					simulationAuthorityIsCurrent,
					(timing) => Object.assign(timingUpdates, timing),
				);
			};
			if (!captureEnabled) {
				return executeFetch();
			}
			const generation = requestGeneration;
			const requestSessionId = networkSessionId;
			const captureAuthorityIsCurrent = (): boolean => {
				if (options.captureAuthority === undefined) return true;
				const currentAuthority = readCaptureAuthority();
				if (
					currentAuthority !== requestAuthority ||
					activeCaptureAuthority !== currentAuthority
				) {
					resetCaptureSession(currentAuthority);
					return false;
				}
				return true;
			};

			const startedAtMs = monotonicNow();
			let diagnosticRequestSignal: AbortSignal | undefined;
			let resourceId = '';
			{
				const id = nextEventId++;
				const startedAt = Date.now();
				let rawUrl = '[URL unavailable]';
				let method = 'GET';
				let methodComplete = false;
				let capturedRequestHeaders: Record<string, string> =
					Object.create(null);
				let rawRequestContentType: string | undefined;
				let requestContentTypeComplete = false;
				let headersComplete = false;
				let requestOptionsComplete =
					(canonicalizeRequest
						? canonicalReplayStable
						: initInspection.replayStable) && canonicalInput;
				if (
					!canonicalizeRequest &&
					canonicalInput &&
					typeof Request !== 'undefined' &&
					diagnosticInput instanceof Request
				) {
					requestOptionsComplete = false;
				}
				if (diagnosticInit !== undefined) {
					for (const key of STANDARD_REQUEST_INIT_KEYS) {
						if (
							initInspection.descriptors[key] &&
							!REPLAY_MODELED_REQUEST_INIT_KEYS.has(key)
						) {
							requestOptionsComplete = false;
							break;
						}
					}
				}
				try {
					rawUrl =
						typeof diagnosticInput === 'string'
							? diagnosticInput
							: canonicalInput
								? requestUrl(diagnosticInput, diagnosticInputTrusted)
								: '[URL unavailable]';
				} catch {
					// Continue the real fetch even when its diagnostic projection is hostile.
				}
				try {
					const originalMethod =
						diagnosticInit?.method ??
						(canonicalInput &&
						typeof Request !== 'undefined' &&
						diagnosticInput instanceof Request
							? safelyInspectRequestMethod(
									diagnosticInput,
									diagnosticInputTrusted,
								)
							: 'GET');
					if (typeof originalMethod !== 'string') {
						throw new TypeError('Request method is not a string.');
					}
					const methodWithinLimit =
						originalMethod.length > 0 && originalMethod.length <= 16;
					const requestedMethod = originalMethod.slice(0, 16).toUpperCase();
					method = requestedMethod || 'GET';
					methodComplete =
						methodWithinLimit &&
						originalMethod === requestedMethod &&
						/^[!#$%&'*+.^_`|~0-9A-Z-]+$/.test(requestedMethod);
				} catch {
					// The underlying fetch remains the authority for invalid inputs.
				}
				try {
					const captured = captureRequestHeaders(
						diagnosticInput,
						diagnosticInit,
						redactHeader,
						diagnosticInputTrusted,
					);
					capturedRequestHeaders = captured.headers;
					headersComplete = captured.complete;
					rawRequestContentType = captured.contentType;
					requestContentTypeComplete = captured.contentTypeComplete;
				} catch {
					// Header capture is optional and must not change fetch behavior.
				}
				if (
					!collectorActive ||
					generation !== collectorGeneration ||
					!captureAuthorityIsCurrent()
				) {
					return fetchImplementation(transportInput, transportInit);
				}
				const correlationProjection = correlationContextProjectionFor(
					diagnosticInput,
					diagnosticInit,
					capturedRequestHeaders,
					diagnosticInputTrusted || typeof diagnosticInput === 'string',
				);
				if (
					!collectorActive ||
					generation !== collectorGeneration ||
					!captureAuthorityIsCurrent()
				) {
					return fetchImplementation(transportInput, transportInit);
				}
				let storeCorrelation: unknown;
				if (!correlationProjection.correlationId) {
					try {
						storeCorrelation = options.eventStore?.createCorrelationId();
					} catch {
						// A host-provided ID factory cannot interrupt the app request.
					}
				}
				if (
					!collectorActive ||
					generation !== collectorGeneration ||
					!captureAuthorityIsCurrent()
				) {
					return fetchImplementation(transportInput, transportInit);
				}
				const correlation = Object.freeze({
					correlationId:
						correlationProjection.correlationId ??
						boundedContextText(storeCorrelation) ??
						`network-request-${requestSessionId}-${id}`,
					...(correlationProjection.parentEventId
						? { parentEventId: correlationProjection.parentEventId }
						: {}),
				});
				const capturedUrl = redactCapturedUrl(rawUrl);
				const url = capturedUrl.value;
				const requestFieldsComplete =
					capturedUrl.complete &&
					methodComplete &&
					headersComplete &&
					requestOptionsComplete;
				const knownRequestSizeBytes = knownRequestBodyBytes(diagnosticInit);
				let requestBodyPresenceKnown =
					initInspection.safeToRead && canonicalInput;
				let requestHasBody = false;
				try {
					requestHasBody = canonicalBodyFound
						? canonicalBodyPresent
						: diagnosticInit?.body != null ||
							(canonicalInput &&
								typeof Request !== 'undefined' &&
								diagnosticInput instanceof Request &&
								safelyInspectRequestBody(
									diagnosticInput,
									diagnosticInputTrusted,
								) !== null);
				} catch {
					requestBodyPresenceKnown = false;
				}
				const methodForbidsBody = method === 'GET' || method === 'HEAD';
				const requestContentType =
					rawRequestContentType ??
					inferredRequestBodyContentType(diagnosticInit);
				const requestBodyMimeUnsafe =
					requestHasBody &&
					(!requestContentTypeComplete ||
						!isTextualNetworkContentType(requestContentType));
				try {
					diagnosticRequestSignal =
						initInspection.safeToRead && canonicalInput
							? requestSignal(
									diagnosticInput,
									diagnosticInit,
									diagnosticInputTrusted,
								)
							: undefined;
				} catch {
					// A failed optional signal projection cannot affect the app request.
				}
				resourceId = `${requestSessionId}:${id}`;
				const finishRequestBodyCapture = (
					captured: CapturedNetworkBody,
				): CapturedNetworkBody => {
					const body =
						!requestContentTypeComplete && captured.body !== undefined
							? '[Body omitted: incomplete Content-Type projection]'
							: redactCapturedBody(
									captured.body,
									{
										direction: 'request',
										contentType: requestContentType,
										url,
									},
									captured.omitted === true,
								);
					return {
						...captured,
						body,
						complete:
							captured.complete &&
							body === captured.body &&
							requestBodyPresenceKnown &&
							!(methodForbidsBody && requestHasBody),
					};
				};
				if (
					!collectorActive ||
					generation !== collectorGeneration ||
					!captureAuthorityIsCurrent()
				) {
					return fetchImplementation(transportInput, transportInit);
				}
				store.append(
					immutableEvent({
						sessionId: requestSessionId,
						id,
						startedAt,
						method,
						url,
						state: 'pending',
						durationMs: 0,
						correlationId: correlation.correlationId,
						...(correlation.parentEventId
							? { parentEventId: correlation.parentEventId }
							: {}),
						simulationProfileId: activeProfile.id,
						requestProjectionComplete:
							requestFieldsComplete &&
							!captureBody &&
							methodForbidsBody &&
							requestBodyPresenceKnown &&
							!requestHasBody,
						captureTransport,
						...(captureLayerId ? { captureLayerId } : {}),
						bodyCaptureEnabled: captureBody,
						requestHeaders: capturedRequestHeaders,
						requestSizeBytes: knownRequestSizeBytes,
						source,
					}),
				);
				cancelUnretainedBodyCaptures();
				pruneTimelineEvents();
				const applyCapturedRequestBody = (
					captured: CapturedNetworkBody,
				): void => {
					if (
						!collectorActive ||
						generation !== collectorGeneration ||
						!captureAuthorityIsCurrent()
					) {
						return;
					}
					const retained = retainedNetworkEvent(resourceId);
					if (!retained) return;
					const finished = finishRequestBodyCapture(captured);
					replaceRetainedDetail({
						...retained,
						requestProjectionComplete:
							requestFieldsComplete && finished.complete,
						requestBody: finished.body,
						requestSizeBytes: finished.capturedBytes ?? knownRequestSizeBytes,
					});
				};
				if (captureBody && retainedNetworkEvent(resourceId)) {
					if (canonicalBodyOpaque) {
						applyCapturedRequestBody({
							body: '[Unsupported request body omitted]',
							complete: false,
							omitted: true,
						});
					} else if (requestBodyMimeUnsafe && diagnosticInit?.body == null) {
						applyCapturedRequestBody({
							body: '[Body omitted: non-textual or ambiguous Content-Type]',
							complete: false,
							omitted: true,
						});
					} else {
						try {
							const prepared = prepareRequestBodyCapture(
								diagnosticInput,
								diagnosticInit,
								maxBodyBytes,
								captureUnknownLengthBodies,
								diagnosticInputTrusted,
							);
							if (prepared.kind === 'immediate') {
								applyCapturedRequestBody(prepared.result);
							} else {
								runBodyCapture(
									resourceId,
									'request',
									prepared.start,
									applyCapturedRequestBody,
								);
							}
						} catch {
							applyCapturedRequestBody({
								body: '[Body omitted: diagnostics capture failed]',
								complete: false,
								omitted: true,
							});
						}
					}
				}
			}
			if (
				!collectorActive ||
				generation !== collectorGeneration ||
				!captureAuthorityIsCurrent()
			) {
				return fetchImplementation(transportInput, transportInit);
			}

			try {
				const response = await executeFetch();
				if (
					!collectorActive ||
					generation !== collectorGeneration ||
					!captureAuthorityIsCurrent()
				) {
					return response;
				}
				const retainedRequest = retainedNetworkEvent(resourceId);
				if (!retainedRequest) return response;
				const durationMs = Math.max(0, monotonicNow() - startedAtMs);
				let contentType: string | undefined;
				let rawResponseContentType: string | undefined;
				let responseContentTypeComplete = false;
				let responseLength: number | undefined;
				let responseStatus: number | undefined;
				let responseHeaders: Record<string, string> = Object.create(null);
				const responseInspectable = isSafelyInspectableResponse(
					response,
					trustedResponse,
				);
				if (responseInspectable) {
					try {
						const rawResponseHeaders = safelyInspectResponseHeaders(
							response,
							trustedResponse,
						);
						responseLength = parseContentLength(
							safelyGetHeaderValue(
								rawResponseHeaders,
								'content-length',
								trustedResponse,
							),
						);
						const captured = captureHeaders(rawResponseHeaders, redactHeader);
						responseHeaders = captured.headers;
						rawResponseContentType = captured.contentType;
						responseContentTypeComplete = captured.contentTypeComplete;
						contentType = responseHeaders['content-type'];
						const rawStatus = safelyInspectResponseStatus(
							response,
							trustedResponse,
						);
						responseStatus =
							typeof rawStatus === 'number' &&
							Number.isInteger(rawStatus) &&
							rawStatus >= 0 &&
							rawStatus <= 999
								? rawStatus
								: undefined;
					} catch {
						// The response remains usable when its native projection fails.
					}
				}
				const cacheStatus = inferNetworkCacheStatus(
					responseStatus,
					responseHeaders,
				);
				const timing = Object.freeze({
					...timingUpdates,
					totalMs: durationMs,
				}) satisfies NetworkTimingPhases;
				const settledEvent: NetworkEvent = {
					...retainedRequest,
					state: 'success',
					status: responseStatus,
					durationMs,
					timing,
					cacheStatus,
					responseHeaders,
					contentType,
					responseSizeBytes: responseLength,
				};
				replaceAndPublish(settledEvent);
				const applyCapturedResponseBody = (
					capturedResponse: CapturedNetworkBody,
				): void => {
					if (
						!collectorActive ||
						generation !== collectorGeneration ||
						!captureAuthorityIsCurrent()
					) {
						return;
					}
					const retained = retainedNetworkEvent(resourceId);
					if (!retained) return;
					const responseBody =
						!responseContentTypeComplete && capturedResponse.body !== undefined
							? '[Body omitted: incomplete Content-Type projection]'
							: redactCapturedBody(
									capturedResponse.body,
									{
										direction: 'response',
										contentType: rawResponseContentType,
										url: retained.url,
									},
									capturedResponse.omitted === true,
								);
					replaceRetainedDetail({
						...retained,
						responseBody,
						responseSizeBytes:
							capturedResponse.capturedBytes ??
							(capturedResponse.observedBytes === undefined
								? responseLength
								: undefined),
					});
				};
				if (captureBody && retainedNetworkEvent(resourceId)) {
					if (!responseInspectable) {
						applyCapturedResponseBody({
							body: '[Body omitted: uninspectable response]',
							complete: false,
							omitted: true,
						});
					} else if (!responseContentTypeComplete) {
						applyCapturedResponseBody({
							body: '[Body omitted: incomplete Content-Type projection]',
							capturedBytes: responseLength,
							complete: false,
							omitted: true,
						});
					} else {
						try {
							const prepared = prepareResponseBodyCapture(
								response,
								maxBodyBytes,
								captureUnknownLengthBodies,
								trustedResponse,
							);
							if (prepared.kind === 'immediate') {
								applyCapturedResponseBody(prepared.result);
							} else {
								runBodyCapture(
									resourceId,
									'response',
									prepared.start,
									applyCapturedResponseBody,
								);
							}
						} catch {
							applyCapturedResponseBody({
								body: '[Body omitted: diagnostics capture failed]',
								complete: false,
								omitted: true,
							});
						}
					}
				}
				return response;
			} catch (error) {
				if (
					!collectorActive ||
					generation !== collectorGeneration ||
					!captureAuthorityIsCurrent()
				)
					throw error;
				const retainedRequest = retainedNetworkEvent(resourceId);
				if (!retainedRequest) throw error;
				const durationMs = Math.max(0, monotonicNow() - startedAtMs);
				const timing = Object.freeze({
					...timingUpdates,
					totalMs: durationMs,
				}) satisfies NetworkTimingPhases;
				let aborted = false;
				try {
					aborted =
						safelyInspectErrorName(error) === 'AbortError' ||
						(diagnosticRequestSignal?.aborted === true &&
							error === diagnosticRequestSignal.reason);
				} catch {
					// Hostile thrown values are ordinary request errors.
				}
				const boundedErrorText = boundedNetworkErrorText(error);
				const errorText = boundedErrorText.omitted
					? boundedErrorText.text
					: redactCapturedBody(boundedErrorText.text, {
							direction: 'response',
							contentType: 'text/plain',
							url: retainedRequest.url,
						});
				const settledEvent: NetworkEvent = {
					...retainedRequest,
					state: aborted ? 'aborted' : 'error',
					durationMs,
					timing,
					cacheStatus: 'unknown',
					error: errorText,
				};
				replaceAndPublish(settledEvent);
				throw error;
			}
		};
		return wrappedFetch;
	};
	const instrumentFetch = (
		fetchImplementation: FetchImplementation,
		instrumentationOptions?: NetworkFetchInstrumentationOptions,
	): FetchImplementation =>
		createInstrumentedFetch(
			fetchImplementation,
			'explicit-fetch',
			undefined,
			trustedResponseRequested(instrumentationOptions) ||
				options.trustExplicitFetchResponses === true,
			trustedRequestRequested(instrumentationOptions) ||
				options.trustExplicitFetchRequests === true,
			canonicalizeRequestRequested(instrumentationOptions),
		);
	const nextActionRequestId = (): string => {
		actionSequence += 1;
		return `network-${pluginInstanceId}-${networkSessionId}-action-${actionSequence}`;
	};
	const rejectedNetworkActionReceipt = (
		execution: DevToolsActionExecution,
		errorCode: 'invalid-request' | 'request-id-conflict',
		error: string,
		echoValidatedRequestId = false,
	): DevToolsActionReceipt => {
		const at = Date.now();
		return Object.freeze({
			schemaVersion: DEVTOOLS_ACTION_POLICY_VERSION,
			requestId:
				echoValidatedRequestId &&
				typeof execution.plan.requestId === 'string' &&
				execution.plan.requestId.length <= 256
					? execution.plan.requestId
					: 'unknown',
			actionFingerprint: execution.plan.actionFingerprint,
			capabilityId: execution.plan.capability.id,
			pluginId: execution.plan.pluginId,
			label: execution.plan.label,
			risk: execution.plan.risk,
			status: 'rejected',
			rollbackStatus: 'not-needed',
			startedAt: at,
			completedAt: at,
			errorCode,
			error,
		});
	};
	const publishNetworkActionReceipt = (
		receipt: DevToolsActionReceipt,
	): DevToolsActionReceipt => {
		try {
			options.onActionReceipt?.(receipt);
		} catch {
			// Host audit reporting must never affect the requested action.
		}
		return receipt;
	};
	const executeNetworkAction = (
		execution: DevToolsActionExecution,
	): Promise<DevToolsActionReceipt> => {
		const externalRequestId = execution.plan.requestId;
		if (
			typeof externalRequestId !== 'string' ||
			!externalRequestId ||
			externalRequestId.length > 256 ||
			externalRequestId !== externalRequestId.trim() ||
			!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(externalRequestId) ||
			redactDiagnosticText(externalRequestId) !== externalRequestId
		) {
			return Promise.resolve(
				publishNetworkActionReceipt(
					rejectedNetworkActionReceipt(
						execution,
						'invalid-request',
						'Invalid network action request ID.',
					),
				),
			);
		}
		if (actionReceiptEpoch !== collectorGeneration) {
			actionReceiptEpoch = collectorGeneration;
			scopedActionSequence = 0;
			actionReceipts = new Map();
		}
		const binding = `${execution.plan.actionFingerprint}\u0000${execution.plan.capability.id}\u0000${execution.plan.capability.availability}\u0000${execution.plan.risk}`;
		const existing = actionReceipts.get(externalRequestId);
		if (existing) {
			if (existing.binding === binding) return existing.promise;
			return Promise.resolve(
				publishNetworkActionReceipt(
					rejectedNetworkActionReceipt(
						execution,
						'request-id-conflict',
						'The request ID is already bound to a different network action.',
						true,
					),
				),
			);
		}
		if (actionReceipts.size >= 256) {
			return Promise.resolve(
				publishNetworkActionReceipt(
					rejectedNetworkActionReceipt(
						execution,
						'invalid-request',
						'The network action receipt limit was reached for this session.',
						true,
					),
				),
			);
		}
		if (inFlightNetworkActions >= MAX_IN_FLIGHT_NETWORK_ACTIONS) {
			return Promise.resolve(
				publishNetworkActionReceipt(
					rejectedNetworkActionReceipt(
						execution,
						'invalid-request',
						'The network action in-flight limit was reached.',
						true,
					),
				),
			);
		}
		scopedActionSequence += 1;
		inFlightNetworkActions += 1;
		const pendingToken = Symbol('network-action');
		const pendingController = new AbortController();
		pendingNetworkActions.set(pendingToken, {
			controller: pendingController,
		});
		const requestedReceiptEpoch = collectorGeneration;
		const internalRequestId = `network-${pluginInstanceId}-epoch-${requestedReceiptEpoch}-action-${scopedActionSequence}`;
		let coordinated: Promise<DevToolsActionReceipt>;
		try {
			coordinated = actionCoordinator.execute({
				...execution,
				plan: { ...execution.plan, requestId: internalRequestId },
				signal: pendingController.signal,
			});
		} catch (error) {
			releasePendingNetworkAction(pendingToken);
			return Promise.reject(error);
		}
		const promise = coordinated
			.then((receipt) => {
				const publicReceipt = Object.freeze({
					...receipt,
					requestId: externalRequestId,
				});
				return collectorGeneration === requestedReceiptEpoch
					? publishNetworkActionReceipt(publicReceipt)
					: publicReceipt;
			})
			.finally(() => {
				releasePendingNetworkAction(pendingToken);
			});
		actionReceipts.set(externalRequestId, { binding, promise });
		return promise;
	};
	const setSimulationProfile = async (
		profileId: NetworkSimulationProfileId,
		requestId?: string,
	): Promise<DevToolsActionReceipt> => {
		synchronizeCaptureAuthority();
		const requestedCaptureAuthority = activeCaptureAuthority;
		const boundRequestId = requestId ?? nextActionRequestId();
		if (!isNetworkSimulationProfileId(profileId)) {
			return executeNetworkAction({
				plan: {
					schemaVersion: DEVTOOLS_ACTION_POLICY_VERSION,
					requestId: boundRequestId,
					actionFingerprint: 'network.profile:invalid',
					capability: unavailableSimulationCapability(
						'unsupported',
						'Network simulation profile is unsupported.',
					),
					pluginId,
					label: 'Set network profile',
					risk: 'safe',
					confirmation: { required: false },
					rollback: { availability: 'not-applicable' },
				},
				action: () => {},
			});
		}
		const currentCapability = synchronizeSimulationCapability();
		const previousProfile = effectiveSimulationProfile(
			simulationProfileStore.getSnapshot(),
			currentCapability,
		);
		const previousCapabilityId = activeSimulationCapabilityId;
		const nextProfile = getNetworkSimulationProfile(profileId);
		const profileActionName = nextProfile.name.endsWith('Network')
			? `${nextProfile.name} profile`
			: `${nextProfile.name} network profile`;
		const capability: DevToolsCapability =
			profileId === 'none'
				? collectorActive
					? {
							schemaVersion: DEVTOOLS_ACTION_POLICY_VERSION,
							id: NETWORK_SIMULATION_CLEAR_CAPABILITY_ID,
							availability: 'available',
						}
					: {
							schemaVersion: DEVTOOLS_ACTION_POLICY_VERSION,
							id: NETWORK_SIMULATION_CLEAR_CAPABILITY_ID,
							availability: 'unavailable',
							reason: {
								code: 'unavailable',
								message:
									'Network profile cleanup requires an active tools session.',
							},
						}
				: currentCapability;
		const requestedGeneration = collectorGeneration;
		const requestedCapabilityGeneration = simulationCapabilityGeneration;
		const needsConfirmation = profileId !== 'none';
		let actionApplied = false;
		return executeNetworkAction({
			plan: {
				schemaVersion: DEVTOOLS_ACTION_POLICY_VERSION,
				requestId: boundRequestId,
				actionFingerprint: `network.profile:${profileId}`,
				capability,
				pluginId,
				label:
					profileId === 'none'
						? 'Clear network profile'
						: `Set ${profileActionName}`,
				risk: needsConfirmation ? 'confirmation' : 'safe',
				confirmation: needsConfirmation
					? {
							required: true,
							title: `Apply ${profileActionName}?`,
							message: `${nextProfile.description} This changes only instrumented fetch requests until the tools session ends.`,
							confirmLabel: 'Apply profile',
						}
					: { required: false },
				rollback: { availability: 'available' },
			},
			action: () => {
				const captureAuthorityChanged = !captureAuthorityMatches(
					requestedCaptureAuthority,
				);
				const currentCapability = synchronizeSimulationCapability();
				const sessionChanged = collectorGeneration !== requestedGeneration;
				const authorityChanged =
					profileId !== 'none' &&
					(simulationCapabilityGeneration !== requestedCapabilityGeneration ||
						currentCapability.availability !== 'available' ||
						currentCapability.id !== capability.id);
				if (captureAuthorityChanged || sessionChanged || authorityChanged) {
					throw new Error(
						sessionChanged ||
							simulationCapabilityGeneration !== requestedCapabilityGeneration
							? 'The network tools session changed before the action ran.'
							: (currentCapability.reason?.message ??
									'Network simulation capability changed or is unavailable.'),
					);
				}
				setStoredSimulationProfile(
					nextProfile,
					profileId === 'none' ? undefined : capability.id,
				);
				actionApplied = true;
			},
			rollback: () => {
				if (!actionApplied) return { status: 'complete' };
				if (!captureAuthorityMatches(requestedCaptureAuthority)) {
					return { status: 'complete' };
				}
				const rollbackCapability = synchronizeSimulationCapability();
				const rollbackProfile =
					previousProfile.id === 'none' ||
					(collectorActive &&
						collectorGeneration === requestedGeneration &&
						simulationCapabilityGeneration === requestedCapabilityGeneration &&
						rollbackCapability.availability === 'available' &&
						rollbackCapability.id === previousCapabilityId)
						? previousProfile
						: noSimulationProfile;
				setStoredSimulationProfile(
					rollbackProfile,
					rollbackProfile.id === 'none' ? undefined : previousCapabilityId,
				);
				return { status: 'complete' };
			},
		});
	};
	const clearSimulationProfile = (
		requestId?: string,
	): Promise<DevToolsActionReceipt> => setSimulationProfile('none', requestId);
	// Clears exactly the requests that were confirmed, and only while the tools
	// session and collector generation they were confirmed in are current.
	const clearConfirmed = (
		requestedCaptureAuthority: string | undefined,
		requestedGeneration: number,
		confirmedIds: readonly string[],
	): void => {
		if (
			!captureAuthorityMatches(requestedCaptureAuthority) ||
			!collectorActive ||
			collectorGeneration !== requestedGeneration
		) {
			throw new Error('The network tools session changed before clear ran.');
		}
		const currentIds = store.getSnapshot().map(networkEventResourceId);
		if (
			currentIds.length !== confirmedIds.length ||
			currentIds.some((id, index) => id !== confirmedIds[index])
		) {
			throw new Error(
				'Captured network requests changed before clear ran. Review and confirm the current requests again.',
			);
		}
		cancelActiveBodyCaptures();
		store.clear();
		clearTimelineEvents(confirmedIds);
	};
	const requestClear = (requestId?: string): Promise<DevToolsActionReceipt> => {
		synchronizeCaptureAuthority();
		const requestedCaptureAuthority = activeCaptureAuthority;
		const boundRequestId = requestId ?? nextActionRequestId();
		const requestedGeneration = collectorGeneration;
		const confirmedSnapshot = store.getSnapshot();
		const confirmedIds = confirmedSnapshot.map(networkEventResourceId);
		const capturedCount = confirmedSnapshot.length;
		const firstCapturedId = confirmedIds[0] ?? 'empty';
		const lastCapturedId = confirmedIds.at(-1) ?? 'empty';
		const capability: DevToolsCapability = collectorActive
			? {
					schemaVersion: DEVTOOLS_ACTION_POLICY_VERSION,
					id: NETWORK_CAPTURE_CLEAR_CAPABILITY_ID,
					availability: 'available',
				}
			: {
					schemaVersion: DEVTOOLS_ACTION_POLICY_VERSION,
					id: NETWORK_CAPTURE_CLEAR_CAPABILITY_ID,
					availability: 'unavailable',
					reason: {
						code: 'unavailable',
						message: 'Network capture requires an active tools session.',
					},
				};
		return executeNetworkAction({
			plan: {
				schemaVersion: DEVTOOLS_ACTION_POLICY_VERSION,
				requestId: boundRequestId,
				actionFingerprint: `network.capture:clear:${capturedCount}:${firstCapturedId}:${lastCapturedId}`,
				capability,
				pluginId,
				label: 'Clear captured network requests',
				risk: 'destructive',
				confirmation: {
					required: true,
					title: 'Clear captured network requests?',
					message: `Permanently removes ${capturedCount} captured request${capturedCount === 1 ? '' : 's'} from this tools session.`,
					confirmLabel: 'Clear requests',
					destructive: true,
				},
				rollback: {
					availability: 'unavailable',
					reason: 'Cleared diagnostic events cannot be reconstructed.',
				},
			},
			action: () =>
				clearConfirmed(
					requestedCaptureAuthority,
					requestedGeneration,
					confirmedIds,
				),
		});
	};
	const importSimulationPreference = async (
		serialized: string,
		requestId?: string,
	): Promise<DevToolsActionReceipt> => {
		synchronizeCaptureAuthority();
		const boundRequestId = requestId ?? nextActionRequestId();
		let preference: ReturnType<typeof importNetworkSimulationPreference>;
		try {
			preference = importNetworkSimulationPreference(serialized);
		} catch {
			return executeNetworkAction({
				plan: {
					schemaVersion: DEVTOOLS_ACTION_POLICY_VERSION,
					requestId: boundRequestId,
					actionFingerprint: 'network.profile-import:invalid',
					capability: unavailableSimulationCapability(
						'unsupported',
						'Network simulation preference is invalid or unsupported.',
					),
					pluginId,
					label: 'Import network profile',
					risk: 'safe',
					confirmation: { required: false },
					rollback: { availability: 'not-applicable' },
				},
				action: () => {},
			});
		}
		return setSimulationProfile(preference.profileId, boundRequestId);
	};
	const install = createRefCountedInstaller(({ addCleanup }) => {
		collectorGeneration += 1;
		collectorInstallEpoch += 1;
		const installEpoch = collectorInstallEpoch;
		collectorActive = true;
		lastObservedSimulationCapabilityKey = undefined;
		lastObservedSimulationCapabilitySnapshotKey = undefined;
		activeCaptureAuthority = readCaptureAuthority();
		lastPolledCaptureAuthority = activeCaptureAuthority;
		synchronizeSimulationCapability();
		pausedStore.set(false);
		// Capability availability changes with the collector lifecycle.
		simulationProfileStore.set(simulationProfileStore.getSnapshot());
		addCleanup(() => {
			stopCaptureAuthorityPoll();
			stopSimulationCapabilityPoll();
			collectorActive = false;
			collectorInstallEpoch += 1;
			resetCaptureSession(undefined, true);
		});
		if (options.subscribeCaptureAuthority) {
			let captureSubscriptionActive = true;
			try {
				const unsubscribeCaptureAuthority = options.subscribeCaptureAuthority(
					() => {
						if (
							!captureSubscriptionActive ||
							!collectorActive ||
							collectorInstallEpoch !== installEpoch
						) {
							return;
						}
						resetCaptureSession(readCaptureAuthority(), true);
					},
				);
				if (typeof unsubscribeCaptureAuthority !== 'function') {
					captureSubscriptionActive = false;
					throw new Error('invalid capture authority subscription cleanup');
				}
				hostCaptureAuthoritySubscriptionActive = true;
				stopCaptureAuthorityPoll();
				addCleanup(() => {
					captureSubscriptionActive = false;
					hostCaptureAuthoritySubscriptionActive = false;
					try {
						unsubscribeCaptureAuthority();
					} catch {
						// Host cleanup cannot interrupt diagnostics disposal.
					}
				});
			} catch {
				captureSubscriptionActive = false;
				hostCaptureAuthoritySubscriptionActive = false;
				// Polling below keeps dynamic owner changes observable.
			}
		}
		startCaptureAuthorityPoll();
		if (options.subscribeSimulationCapability) {
			let capabilitySubscriptionActive = true;
			try {
				const unsubscribeCapability = options.subscribeSimulationCapability(
					() => {
						if (
							!capabilitySubscriptionActive ||
							!collectorActive ||
							collectorInstallEpoch !== installEpoch
						) {
							return;
						}
						// A capability notification is an authority epoch boundary. Captures,
						// delayed actions, in-flight settlements, and active degradation never
						// transfer to a replacement or re-granted authority.
						synchronizeSimulationCapability(
							currentSimulationCapability(),
							false,
							true,
						);
					},
				);
				if (typeof unsubscribeCapability !== 'function') {
					capabilitySubscriptionActive = false;
					throw new Error('invalid capability subscription cleanup');
				}
				hostCapabilitySubscriptionActive = true;
				stopSimulationCapabilityPoll();
				addCleanup(() => {
					capabilitySubscriptionActive = false;
					hostCapabilitySubscriptionActive = false;
					try {
						unsubscribeCapability();
					} catch {
						// Host cleanup cannot interrupt diagnostics disposal.
					}
				});
			} catch {
				capabilitySubscriptionActive = false;
				hostCapabilitySubscriptionActive = false;
				// The bounded polling fallback preserves observable capability changes.
			}
		}
		startSimulationCapabilityPoll();
		if (!options.patchGlobalFetch || typeof globalThis.fetch !== 'function') {
			return;
		}
		const replayLayerId = `network-layer-${createOpaqueNetworkSessionId()}`;
		const replayLayer = installGlobalFetchLayer(
			replayLayerId,
			(fetchImplementation, wrapperId) =>
				createInstrumentedFetch(
					fetchImplementation,
					'global-fetch',
					wrapperId,
					options.trustGlobalFetchResponses === true,
					options.trustGlobalFetchRequests === true,
					options.canonicalizeGlobalFetchRequests === true,
				),
		);
		installedReplayLayer = replayLayer;
		addCleanup(() => {
			if (installedReplayLayer === replayLayer)
				installedReplayLayer = undefined;
			replayLayer.dispose();
		});
	});

	function NetworkPanel({
		actions,
		onBack,
	}: {
		actions: DevToolsActionServices;
		onBack: () => void;
	}) {
		const events = useSyncExternalStore(
			store.subscribe,
			store.getSnapshot,
			store.getServerSnapshot,
		);
		const paused = useSyncExternalStore(
			pausedStore.subscribe,
			pausedStore.getSnapshot,
			pausedStore.getServerSnapshot,
		);
		const simulationState = useSyncExternalStore(
			subscribeSimulationState,
			getSimulationState,
			getSimulationState,
		);
		const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
		const [search, setSearch] = useState('');
		const [segment, setSegment] = useState<NetworkSegment>('all');
		const [hideSystemTraffic, setHideSystemTraffic] = useState(true);

		// URL parsing per event is the hot path here; recompute only when the
		// inputs actually change instead of on every render. Hooks stay above
		// the detail early-return.
		const { systemCount, rows, summary, insights } = useMemo(() => {
			const needle = search.trim().toLowerCase();
			const matching = [...events]
				.reverse()
				.filter(
					(candidate) =>
						matchesNetworkSegment(candidate, segment) &&
						matchesNetworkSearch(candidate, needle),
				);
			const systemEvents: NetworkEvent[] = [];
			const appEvents: NetworkEvent[] = [];
			for (const candidate of matching) {
				(isSystemNetworkEvent(candidate) ? systemEvents : appEvents).push(
					candidate,
				);
			}
			const visibleEvents = hideSystemTraffic ? appEvents : matching;
			return {
				systemCount: systemEvents.length,
				rows: collapseNetworkEvents(visibleEvents),
				summary: summarizeNetworkEvents(visibleEvents, Date.now()),
				insights: summarizeNetworkInsights(visibleEvents),
			};
		}, [events, search, segment, hideSystemTraffic]);

		// The search field is native-owned and unmounts with the list, so a query
		// that outlived it would filter the list behind an empty search box.
		const openEvent = (event: NetworkEvent) => {
			setSearch('');
			setSelectedEventId(networkEventResourceId(event));
		};

		const selectedEvent =
			selectedEventId === null
				? undefined
				: events.find(
						(event) => networkEventResourceId(event) === selectedEventId,
					);
		if (selectedEvent) {
			const captureReplaySession = (): (() => Readonly<{
				init: RequestInit;
				url: string;
			}>) => {
				const requestedGeneration = collectorGeneration;
				const requestedCaptureAuthority = activeCaptureAuthority;
				const replayLayer = installedReplayLayer;
				const resourceId = networkEventResourceId(selectedEvent);
				const expectedSessionId = selectedEvent.sessionId;
				const expectedCaptureLayerId = selectedEvent.captureLayerId;
				const assertCurrentReplaySession = () => {
					let captureAuthorityCurrent = true;
					if (options.captureAuthority !== undefined) {
						const currentAuthority = readCaptureAuthority();
						captureAuthorityCurrent =
							currentAuthority !== undefined &&
							currentAuthority === requestedCaptureAuthority &&
							currentAuthority === activeCaptureAuthority;
						if (!captureAuthorityCurrent) {
							resetCaptureSession(currentAuthority);
						}
					}
					const retainedEvent = store
						.getSnapshot()
						.find(
							(candidate) => networkEventResourceId(candidate) === resourceId,
						);
					if (
						!captureAuthorityCurrent ||
						!collectorActive ||
						collectorGeneration !== requestedGeneration ||
						expectedSessionId !== networkSessionId ||
						!retainedEvent ||
						installedReplayLayer !== replayLayer ||
						expectedCaptureLayerId !== replayLayer?.currentWrapperId() ||
						replayLayer?.isOwned() !== true
					) {
						throw new Error(
							'The network tools session changed, or the owned fetch transport was replaced before replay ran.',
						);
					}
					if (networkReplayBlockReason(retainedEvent)) {
						throw new Error(
							'The retained request is no longer complete enough to replay.',
						);
					}
					const replayInit: RequestInit = {
						method: retainedEvent.method,
						headers: Object.fromEntries(
							Object.entries(retainedEvent.requestHeaders),
						),
					};
					if (
						retainedEvent.requestBody !== undefined &&
						retainedEvent.method !== 'GET' &&
						retainedEvent.method !== 'HEAD'
					) {
						replayInit.body = retainedEvent.requestBody;
					}
					return Object.freeze({
						init: Object.freeze(replayInit),
						url: retainedEvent.url,
					});
				};
				assertCurrentReplaySession();
				return assertCurrentReplaySession;
			};
			return (
				<NetworkEventDetail
					actions={actions}
					captureReplaySession={captureReplaySession}
					event={selectedEvent}
					listTitle={title}
					maxBodyBytes={maxBodyBytes}
					onBack={() => setSelectedEventId(null)}
					pluginId={pluginId}
					replayEnabled={requestReplayEnabled}
				/>
			);
		}
		const headerText = paused ? `Paused · ${summary}` : summary;
		const clearRequests = () => {
			synchronizeCaptureAuthority();
			const requestedGeneration = collectorGeneration;
			const requestedCaptureAuthority = activeCaptureAuthority;
			const confirmedSnapshot = store.getSnapshot();
			const confirmedIds = confirmedSnapshot.map(networkEventResourceId);
			void actions.run({
				pluginId,
				label: 'Clear requests',
				confirmation: {
					title: 'Clear captured requests?',
					message: `Removes ${confirmedSnapshot.length} captured request${confirmedSnapshot.length === 1 ? '' : 's'} from this session.`,
					confirmLabel: 'Clear',
					destructive: true,
				},
				action: () =>
					clearConfirmed(
						requestedCaptureAuthority,
						requestedGeneration,
						confirmedIds,
					),
			});
		};
		const togglePaused = () => {
			synchronizeCaptureAuthority();
			const requestedGeneration = collectorGeneration;
			const requestedCaptureAuthority = activeCaptureAuthority;
			void actions.run({
				pluginId,
				label: paused ? 'Resume network capture' : 'Pause network capture',
				action: () => {
					if (
						!captureAuthorityMatches(requestedCaptureAuthority) ||
						!collectorActive ||
						collectorGeneration !== requestedGeneration
					) {
						throw new Error(
							'The network tools session changed before capture state changed.',
						);
					}
					pausedStore.set(!paused);
				},
			});
		};
		const selectSimulationProfile = (value: string) => {
			if (
				!isNetworkSimulationProfileId(value) ||
				simulationState.capability.availability !== 'available'
			) {
				return;
			}
			// Profile mutations already run through the versioned coordinator. Do not
			// nest them in the legacy boolean action service, which would misreport a
			// cancelled inner receipt as a successful outer action.
			void setSimulationProfile(value);
		};
		const simulationFooter =
			simulationState.capability.availability === 'available'
				? `${simulationState.profile.description} Applies only to instrumented fetch. Upload/download shaping requires known-size bodies.`
				: (simulationState.capability.reason?.message ??
					'Network simulation is unavailable.');

		return (
			<PanelShell
				onBack={onBack}
				title={title}
				trailing={
					<>
						<NavIconButton
							accessibilityLabel={paused ? 'Resume capture' : 'Pause capture'}
							onPress={togglePaused}
							systemImage={paused ? 'play.fill' : 'pause.fill'}
							testID="devtools-network-pause"
						/>
						<NavIconButton
							accessibilityLabel="Clear requests"
							destructive
							onPress={clearRequests}
							systemImage="trash"
							testID="devtools-network-clear"
						/>
					</>
				}
			>
				{Platform.OS === 'ios' ? (
					<Host style={{ flex: 1 }}>
						<List modifiers={[listStyle('insetGrouped')]}>
							<Section
								footer={
									<UIText>{`${simulationFooter} No native SDK, WebSocket, or other-app traffic is intercepted.`}</UIText>
								}
								title="Network conditions"
							>
								<LabeledContent label="Active profile">
									<UIText testID="devtools-network-active-profile">
										{simulationState.profile.name}
									</UIText>
								</LabeledContent>
								{simulationState.capability.availability === 'available' ? (
									<Picker
										onSelectionChange={selectSimulationProfile}
										selection={simulationState.profile.id}
										testID="devtools-network-profile-picker"
									>
										{NETWORK_SIMULATION_PROFILE_IDS.map((profileId) => (
											<UIText key={profileId} modifiers={[tag(profileId)]}>
												{getNetworkSimulationProfile(profileId).name}
											</UIText>
										))}
									</Picker>
								) : (
									<LabeledContent label="Simulation">
										<UIText>Unavailable</UIText>
									</LabeledContent>
								)}
							</Section>
							<Section>
								<TextField
									modifiers={[autocorrectionDisabled()]}
									onTextChange={setSearch}
									placeholder="Search URL, table, or status"
									testID="devtools-network-search"
								/>
								<Picker
									modifiers={[pickerStyle('segmented')]}
									onSelectionChange={(value) => setSegment(value)}
									selection={segment}
									testID="devtools-network-filter"
								>
									<UIText modifiers={[tag('all')]}>All</UIText>
									<UIText modifiers={[tag('supabase')]}>Supabase</UIText>
									<UIText modifiers={[tag('errors')]}>Errors</UIText>
									<UIText modifiers={[tag('slow')]}>Slow</UIText>
								</Picker>
							</Section>
							{insights.length > 0 ? (
								<Section title="Insights">
									{insights.map((insight) => (
										<LabeledContent key={insight.id} label={insight.label}>
											<UIText>{insight.detail}</UIText>
										</LabeledContent>
									))}
								</Section>
							) : null}
							{rows.length === 0 ? (
								<Section>
									<ContentUnavailableView
										description={
											events.length === 0
												? 'Captured requests will appear here.'
												: 'No requests match the current filters.'
										}
										systemImage="network"
										testID="devtools-network-empty"
										title={events.length === 0 ? 'No requests' : 'No matches'}
									/>
								</Section>
							) : (
								<Section title={headerText}>
									{rows.map(({ event, count }) => {
										const status = networkStatusPresentation(event);
										const rowModifiers =
											count > 1
												? [buttonStyle('plain'), badge(`×${count}`)]
												: [buttonStyle('plain')];
										return (
											<Button
												key={networkEventResourceId(event)}
												modifiers={rowModifiers}
												onPress={() => openEvent(event)}
												testID={`devtools-network-row-${event.id}`}
											>
												<HStack alignment="center" spacing={12}>
													<UIText
														modifiers={[
															font({
																design: 'monospaced',
																size: 13,
																weight: 'semibold',
															}),
															foregroundStyle(statusColor(status.tone)),
															frame({ minWidth: 36, alignment: 'leading' }),
														]}
													>
														{status.text}
													</UIText>
													<VStack alignment="leading" spacing={2}>
														<HStack alignment="firstTextBaseline" spacing={5}>
															<UIText
																modifiers={[
																	font({
																		design: 'monospaced',
																		size: 15,
																		weight: 'bold',
																	}),
																	foregroundStyle(PlatformColor('labelColor')),
																]}
															>
																{event.method}
															</UIText>
															<UIText
																modifiers={[
																	foregroundStyle(PlatformColor('labelColor')),
																]}
															>
																{networkEventLabel(event).label}
															</UIText>
														</HStack>
														<UIText modifiers={secondarySmall()}>
															{networkRowSubtitle(event)}
														</UIText>
													</VStack>
													<Spacer />
													<Image
														color={PlatformColor('tertiaryLabelColor')}
														size={12}
														systemName="chevron.right"
													/>
												</HStack>
											</Button>
										);
									})}
								</Section>
							)}
							<Section>
								<Toggle
									isOn={hideSystemTraffic}
									onIsOnChange={setHideSystemTraffic}
									testID="devtools-network-hide-system"
								>
									<UIText>Hide system traffic</UIText>
									<UIText>
										{hideSystemTraffic
											? `${systemCount} hidden`
											: `${systemCount} shown`}
									</UIText>
								</Toggle>
							</Section>
						</List>
					</Host>
				) : (
					<AndroidPanelScroll>
						<AndroidPanelSection
							footer={`${simulationFooter} No native SDK, WebSocket, or other-app traffic is intercepted.`}
							title="Network conditions"
						>
							<AndroidPanelRow
								label="Active profile"
								value={simulationState.profile.name}
							/>
							{simulationState.capability.availability === 'available' ? (
								NETWORK_SIMULATION_PROFILE_IDS.map((profileId) => {
									const profile = getNetworkSimulationProfile(profileId);
									return (
										<AndroidPanelRow
											key={profileId}
											label={profile.name}
											onPress={() => selectSimulationProfile(profileId)}
											value={
												profileId === simulationState.profile.id
													? 'Active'
													: undefined
											}
										/>
									);
								})
							) : (
								<AndroidPanelRow label="Simulation" value="Unavailable" />
							)}
						</AndroidPanelSection>
						<AndroidPanelSearch
							onChangeText={setSearch}
							placeholder="Search URL, table, or status"
							value={search}
						/>
						<AndroidPanelTabs
							onSelect={setSegment}
							options={[
								{ label: 'All', value: 'all' },
								{ label: 'Supabase', value: 'supabase' },
								{ label: 'Errors', value: 'errors' },
								{ label: 'Slow', value: 'slow' },
							]}
							selected={segment}
						/>
						{insights.length > 0 ? (
							<AndroidPanelSection title="Insights">
								{insights.map((insight) => (
									<AndroidPanelRow
										key={insight.id}
										label={insight.label}
										value={insight.detail}
										tone={insight.tone === 'info' ? 'default' : insight.tone}
									/>
								))}
							</AndroidPanelSection>
						) : null}
						<AndroidPanelSection title={headerText}>
							{rows.length === 0 ? (
								<AndroidPanelRow
									label={events.length === 0 ? 'No requests' : 'No matches'}
									detail="Captured app requests appear here."
								/>
							) : (
								rows.map(({ event, count }) => {
									const status = networkStatusPresentation(event);
									return (
										<AndroidPanelRow
											key={networkEventResourceId(event)}
											label={`${event.method} ${networkEventLabel(event).label}`}
											detail={networkRowSubtitle(event)}
											onPress={() => openEvent(event)}
											tone={status.tone === 'info' ? 'default' : status.tone}
											value={`${status.text}${count > 1 ? ` ×${count}` : ''}`}
										/>
									);
								})
							)}
						</AndroidPanelSection>
						<AndroidPanelSection>
							<AndroidPanelRow
								label={
									hideSystemTraffic
										? 'Show system traffic'
										: 'Hide system traffic'
								}
								detail={`${systemCount} system request${systemCount === 1 ? '' : 's'}`}
								onPress={() => setHideSystemTraffic((hidden) => !hidden)}
							/>
						</AndroidPanelSection>
					</AndroidPanelScroll>
				)}
			</PanelShell>
		);
	}

	const plugin: DevToolsPanelPlugin = {
		id: pluginId,
		title,
		description:
			options.description ??
			(options.patchGlobalFetch
				? 'Requests made through global and explicit fetch clients'
				: 'Requests made through explicit fetch clients'),
		systemImage: options.systemImage ?? 'network',
		section: options.section,
		Panel: NetworkPanel,
		install,
	};

	return {
		plugin,
		clear: () => {
			synchronizeCaptureAuthority();
			cancelActiveBodyCaptures();
			store.clear();
			clearTimelineEvents();
		},
		requestClear,
		getEvents: () => {
			synchronizeCaptureAuthority();
			return getExposedEvents();
		},
		instrumentFetch,
		isPaused: () => {
			synchronizeCaptureAuthority();
			return pausedStore.getSnapshot();
		},
		pause: () => {
			synchronizeCaptureAuthority();
			if (collectorActive) pausedStore.set(true);
		},
		resume: () => {
			synchronizeCaptureAuthority();
			pausedStore.set(false);
		},
		getSimulationProfile: () => {
			synchronizeCaptureAuthority();
			return {
				...effectiveSimulationProfile(
					simulationProfileStore.getSnapshot(),
					currentSimulationCapability(),
				),
			};
		},
		getSimulationState,
		subscribeSimulationState,
		setSimulationProfile,
		clearSimulationProfile,
		exportSimulationPreference: () => {
			synchronizeCaptureAuthority();
			return exportNetworkSimulationPreference(
				effectiveSimulationProfile(
					simulationProfileStore.getSnapshot(),
					currentSimulationCapability(),
				).id,
			);
		},
		importSimulationPreference,
	};
}

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
	diagnosticErrorText,
	redactDiagnosticText,
} from '@rndevtools/core/redact';
import type {
	CaptureCompositionRecipe,
	SimulatorAction,
	SimulatorActionReceipt,
	SimulatorApp,
	SimulatorCapability,
	SimulatorCapture,
	SimulatorCaptureAccessResult,
	SimulatorCaptureRetentionPolicy,
	SimulatorCaptureRetentionState,
	SimulatorDevice,
	SimulatorDiskCleanupCategoryId,
	SimulatorDiskInventory,
	SimulatorJob,
	SimulatorMetrics,
	SimulatorNativeState,
	SimulatorState,
} from '../shared/simulator-protocol';
import {
	simulatorActionSchema,
	simulatorStateSchema,
	udidSchema,
} from '../shared/simulator-protocol';
import type { SimHelperClient } from './sim-helper-client';
import { type SimctlInventory, SimctlProvider } from './simctl-provider';
import {
	SimulatorCaptureStore,
	simulatorCaptureUrl,
} from './simulator-capture-store';
import {
	runSimulatorCommand,
	SimulatorCommandError,
	type SimulatorCommandOptions,
} from './simulator-command-runner';
import { SimulatorMetricsProvider } from './simulator-metrics-provider';
import {
	SimulatorMutationCoordinator,
	type SimulatorMutationCoordinatorPort,
	type SimulatorMutationLease,
} from './simulator-mutation-coordinator';

const DEFAULT_POLL_INTERVAL_MS = 2_500;
const METRICS_POLL_INTERVAL_MS = 5_000;
const MAX_JOBS = 200;
const MAX_PUSH_PAYLOAD_BYTES = 4_096;
const MAX_JOB_ERROR_LENGTH = 4 * 1024;
const MAX_CERTIFICATE_BYTES = 16 * 1024 * 1024;
const MAX_GPX_BYTES = 5 * 1024 * 1024;
const MAX_GPX_WAYPOINTS = 500;
const MAX_APP_ARGUMENT_BYTES = 4 * 1024;
const MAX_APP_CONTAINER_OUTPUT_BYTES = 256 * 1024;
const MAX_APP_GROUP_CONTAINERS = 64;
const MAX_LOCATION_ROUTE_MS = 12 * 60 * 60 * 1_000;
const MAX_VIDEO_RECORDING_MS = 60 * 60 * 1_000;
const EMPTY_FEATURES: SimulatorCapability['features'] = {
	deviceManagement: false,
	apps: false,
	deepLinks: false,
	location: false,
	push: false,
	privacy: false,
	ui: false,
	statusBar: false,
	keychain: false,
	screenshot: false,
	video: false,
};

type SimulatorListener = (state: SimulatorState) => void;

export type SimulatorActionContext = {
	cleanupSelectedInput?: () => Promise<void>;
	materializeCertificatePath?: () => Promise<{
		cleanup: () => Promise<void>;
		path: string;
	}>;
	selectedPath?: string;
};

export type SimulatorHostProvider = {
	discover: () => Promise<SimulatorCapability>;
	inventory: (signal?: AbortSignal) => Promise<SimctlInventory>;
	listApps: (udid: string, signal?: AbortSignal) => Promise<SimulatorApp[]>;
	runSimctl: (
		args: readonly string[],
		options?: SimulatorCommandOptions
	) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
	openSimulator: (udid: string, signal?: AbortSignal) => Promise<void>;
};

export type SimulatorMetricsHostProvider = {
	sample: (
		devices: readonly SimulatorDevice[],
		signal?: AbortSignal
	) => Promise<SimulatorMetrics>;
};

export type SimulatorNativeHostProvider = {
	inspectPermissions: (signal?: AbortSignal) => Promise<SimulatorNativeState>;
};

export type SimulatorImageCompositor = {
	compose: (
		input: {
			primaryPath: string;
			secondaryPath?: string;
			outputPath: string;
			recipe: CaptureCompositionRecipe;
		},
		signal: AbortSignal
	) => Promise<void>;
};

export type SimulatorCloneProvider = Pick<SimHelperClient, 'cloneSimulator'>;
export type SimulatorDiskProvider = Pick<
	SimHelperClient,
	'planDiskCleanup' | 'cleanDisk'
>;

type SimulatorPathRevealer = (
	containerPath: string,
	signal: AbortSignal
) => Promise<void>;

type SimulatorDeviceDataRootResolver = (udid: string) => Promise<string>;

async function revealPathWithFinder(
	containerPath: string,
	signal: AbortSignal
): Promise<void> {
	await runSimulatorCommand('/usr/bin/open', ['-R', containerPath], {
		signal,
		timeoutMs: 15_000,
		maxOutputBytes: 64 * 1024,
	});
}

async function resolveSimulatorDeviceDataRoot(udid: string): Promise<string> {
	return realpath(
		path.join(
			homedir(),
			'Library',
			'Developer',
			'CoreSimulator',
			'Devices',
			udid,
			'data'
		)
	);
}

type InternalJob = {
	public: SimulatorJob;
	controller: AbortController;
};

function platformName(): SimulatorCapability['platform'] {
	if (
		process.platform === 'darwin' ||
		process.platform === 'win32' ||
		process.platform === 'linux'
	) {
		return process.platform;
	}
	return 'other';
}

function errorText(error: unknown): string {
	const source =
		error instanceof SimulatorCommandError
			? error.message
			: diagnosticErrorText(error);
	return redactDiagnosticText(source)
		.replaceAll(/([a-z][a-z0-9+.-]*:\/\/[^\s?]+)\?[^\s]*/gi, '$1?<redacted>')
		.slice(0, MAX_JOB_ERROR_LENGTH);
}

function actionDeviceUdid(action: SimulatorAction): string | undefined {
	return 'udid' in action ? action.udid : undefined;
}

function coordinate(latitude: number, longitude: number): string {
	return `${latitude.toFixed(7)},${longitude.toFixed(7)}`;
}

function appContainerPaths(output: string, container: string): string[] {
	if (Buffer.byteLength(output, 'utf8') > MAX_APP_CONTAINER_OUTPUT_BYTES) {
		throw new Error(
			'Simulator app container output exceeded the safe size limit.'
		);
	}
	if (container !== 'groups') {
		const containerPath = output.trim();
		if (
			!containerPath ||
			containerPath.includes('\n') ||
			Buffer.byteLength(containerPath, 'utf8') > 4 * 1024
		) {
			throw new Error('Simulator app container path was invalid.');
		}
		return [containerPath];
	}

	const lines = output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length === 0 || lines.length > MAX_APP_GROUP_CONTAINERS) {
		throw new Error('Simulator App Group container list was invalid.');
	}
	return lines.map((line) => {
		const fields = line.split('\t');
		const identifier = fields[0]?.trim();
		const containerPath = fields[1]?.trim();
		if (
			fields.length !== 2 ||
			!identifier ||
			!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(identifier) ||
			!containerPath ||
			Buffer.byteLength(containerPath, 'utf8') > 4 * 1024
		) {
			throw new Error('Simulator App Group container entry was invalid.');
		}
		return containerPath;
	});
}

/**
 * Work that does not mutate a device runs one job at a time per device. A
 * recording runs until it is stopped, for up to an hour, so recordings queue
 * apart: a screenshot or an app listing taken meanwhile does not wait for it.
 */
function actionQueueKey(action: SimulatorAction): string {
	const udid = actionDeviceUdid(action);
	if (!udid) return 'inventory';
	return action.kind === 'capture.video' ? `${udid}:video` : udid;
}

function mutatesInventory(action: SimulatorAction): boolean {
	return [
		'device.create',
		'device.clone',
		'device.rename',
		'device.erase',
		'device.delete',
	].includes(action.kind);
}

function mutatesSimulatorTarget(action: SimulatorAction): boolean {
	if (action.kind === 'device.create') return false;
	if (
		[
			'disk.inspect',
			'app.list',
			'app.revealContainer',
			'capture.screenshot',
			'capture.compose',
			'capture.video',
		].includes(action.kind)
	) {
		return false;
	}
	if (action.kind === 'pasteboard.sync') {
		return action.direction === 'host-to-simulator';
	}
	return true;
}

function actionFeature(
	action: SimulatorAction
): keyof SimulatorCapability['features'] {
	if (action.kind.startsWith('device.')) return 'deviceManagement';
	if (action.kind.startsWith('disk.')) return 'deviceManagement';
	if (action.kind === 'app.openUniversalLink') return 'deepLinks';
	if (action.kind.startsWith('app.') || action.kind === 'pasteboard.sync')
		return 'apps';
	if (action.kind === 'url.open') return 'deepLinks';
	if (action.kind.startsWith('location.')) return 'location';
	if (action.kind === 'push.send') return 'push';
	if (action.kind === 'privacy.update') return 'privacy';
	if (action.kind === 'ui.update') return 'ui';
	if (action.kind.startsWith('statusBar.')) return 'statusBar';
	if (action.kind.startsWith('keychain.')) return 'keychain';
	return action.kind === 'capture.video' ? 'video' : 'screenshot';
}

function statusBarArguments(
	overrides: Extract<
		SimulatorAction,
		{ kind: 'statusBar.override' }
	>['overrides']
): string[] {
	const args: string[] = [];
	const append = (flag: string, value: string | number | undefined) => {
		if (value !== undefined) args.push(flag, String(value));
	};
	append('--time', overrides.time);
	append('--dataNetwork', overrides.dataNetwork);
	append('--wifiMode', overrides.wifiMode);
	append('--wifiBars', overrides.wifiBars);
	append('--cellularMode', overrides.cellularMode);
	append('--cellularBars', overrides.cellularBars);
	append('--operatorName', overrides.operatorName);
	append('--batteryState', overrides.batteryState);
	append('--batteryLevel', overrides.batteryLevel);
	return args;
}

function parsePushPayload(payloadJson: string): string {
	if (Buffer.byteLength(payloadJson, 'utf8') > MAX_PUSH_PAYLOAD_BYTES) {
		throw new Error('Push payload exceeds the 4,096-byte Simulator limit.');
	}
	let value: unknown;
	try {
		value = JSON.parse(payloadJson);
	} catch {
		throw new Error('Push payload must be valid JSON.');
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Push payload must be a top-level object.');
	}
	const aps = Object.getOwnPropertyDescriptor(value, 'aps');
	if (
		!aps ||
		!('value' in aps) ||
		!aps.value ||
		typeof aps.value !== 'object' ||
		Array.isArray(aps.value)
	) {
		throw new Error('Push payload must contain an aps object.');
	}
	return payloadJson;
}

async function validatedSelectedPath(
	selectedPath: string | undefined,
	kind: 'app' | 'certificate' | 'gpx'
): Promise<string> {
	if (!selectedPath) throw new Error(`No ${kind} was selected.`);
	const selected = path.resolve(selectedPath);
	const resolved = await realpath(selected);
	const metadata = await lstat(resolved);
	if (kind === 'app') {
		if (
			!metadata.isDirectory() ||
			path.extname(selected).toLowerCase() !== '.app'
		) {
			throw new Error('Selected application must be an .app directory.');
		}
		return resolved;
	}
	const allowedExtensions =
		kind === 'gpx'
			? new Set(['.gpx'])
			: new Set(['.cer', '.crt', '.der', '.pem']);
	const maximumBytes = kind === 'gpx' ? MAX_GPX_BYTES : MAX_CERTIFICATE_BYTES;
	if (
		!metadata.isFile() ||
		metadata.size > maximumBytes ||
		!allowedExtensions.has(path.extname(selected).toLowerCase())
	) {
		throw new Error(
			kind === 'gpx'
				? 'Selected route must be a bounded GPX file.'
				: 'Selected certificate must be a bounded certificate file.'
		);
	}
	return resolved;
}

function parseGpxWaypoints(source: string): Array<{
	latitude: number;
	longitude: number;
}> {
	if (/<!DOCTYPE|<!ENTITY/i.test(source)) {
		throw new Error(
			'GPX document type and entity declarations are not supported.'
		);
	}
	if (
		!/<(?:[A-Za-z_][\w.-]*:)?gpx\b/i.test(source) ||
		!/<\/(?:[A-Za-z_][\w.-]*:)?gpx\s*>/i.test(source)
	) {
		throw new Error('Selected route must contain a complete GPX document.');
	}
	const waypoints: Array<{ latitude: number; longitude: number }> = [];
	const tagPattern = /<(?:[A-Za-z_][\w.-]*:)?(?:trkpt|rtept|wpt)\b([^>]*)>/gi;
	for (const tag of source.matchAll(tagPattern)) {
		if (waypoints.length >= MAX_GPX_WAYPOINTS) {
			throw new Error(
				`GPX routes cannot exceed ${MAX_GPX_WAYPOINTS} waypoints.`
			);
		}
		const attributes = tag[1] ?? '';
		const latitudeText = /\blat\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1];
		const longitudeText = /\blon\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1];
		if (latitudeText === undefined || longitudeText === undefined) continue;
		const latitude = Number(latitudeText);
		const longitude = Number(longitudeText);
		if (
			!Number.isFinite(latitude) ||
			latitude < -90 ||
			latitude > 90 ||
			!Number.isFinite(longitude) ||
			longitude < -180 ||
			longitude > 180
		) {
			throw new Error('GPX contains an invalid latitude or longitude.');
		}
		waypoints.push({ latitude, longitude });
	}
	if (waypoints.length < 2) {
		throw new Error('GPX routes require at least two valid waypoints.');
	}
	return waypoints;
}

async function readBoundedText(
	filePath: string,
	maximumBytes: number
): Promise<string> {
	const handle = await open(
		filePath,
		constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
	);
	try {
		const metadata = await handle.stat();
		if (!metadata.isFile() || metadata.size > maximumBytes) {
			throw new Error('Selected text input exceeded its safe size limit.');
		}
		const value = await handle.readFile({ encoding: 'utf8' });
		if (Buffer.byteLength(value, 'utf8') > maximumBytes) {
			throw new Error('Selected text input exceeded its safe size limit.');
		}
		return value;
	} finally {
		await handle.close();
	}
}

export class SimulatorService {
	readonly #provider: SimulatorHostProvider;
	readonly #captureStore: SimulatorCaptureStore;
	readonly #metricsProvider: SimulatorMetricsHostProvider;
	readonly #nativeHostProvider: SimulatorNativeHostProvider | undefined;
	readonly #imageCompositor: SimulatorImageCompositor | undefined;
	readonly #cloneProvider: SimulatorCloneProvider | undefined;
	readonly #diskProvider: SimulatorDiskProvider | undefined;
	readonly #revealPath: SimulatorPathRevealer;
	readonly #resolveDeviceDataRoot: SimulatorDeviceDataRootResolver;
	readonly #mutationCoordinator: SimulatorMutationCoordinatorPort;
	readonly #pollIntervalMs: number;
	readonly #now: () => number;
	readonly #listeners = new Set<SimulatorListener>();
	readonly #jobs: InternalJob[] = [];
	readonly #queues = new Map<string, Promise<void>>();
	readonly #tasks = new Set<Promise<void>>();
	readonly #appsByDevice = new Map<string, SimulatorApp[]>();
	readonly #diskByDevice = new Map<string, SimulatorDiskInventory>();
	#capability: SimulatorCapability = {
		status: 'checking',
		platform: platformName(),
		licenseStatus: 'unknown',
		hostArchitecture:
			process.arch === 'arm64' || process.arch === 'x64'
				? process.arch
				: 'other',
		runtimeAvailability: { total: 0, available: 0 },
		features: EMPTY_FEATURES,
	};
	#inventory: SimctlInventory = { runtimes: [], deviceTypes: [], devices: [] };
	#metrics: SimulatorMetrics = { status: 'checking', byDevice: {} };
	#native: SimulatorNativeState = {
		status: 'checking',
		permissionInspection: false,
		permissionPrompting: false,
		permissions: [],
	};
	#revision = 0;
	#updatedAt: number;
	#pollTimer: NodeJS.Timeout | undefined;
	#metricsTimer: NodeJS.Timeout | undefined;
	#pollingActive = true;
	#refreshPromise: Promise<SimulatorState> | undefined;
	#metricsRefreshPromise: Promise<SimulatorState> | undefined;
	#nativeRefreshPromise: Promise<SimulatorState> | undefined;
	#inventoryMutationQueue: Promise<void> = Promise.resolve();
	#metricsController: AbortController | undefined;
	#nativeController: AbortController | undefined;
	#stopped = false;

	constructor({
		captureDirectory,
		captureStore,
		provider = new SimctlProvider(),
		metricsProvider = new SimulatorMetricsProvider(),
		nativeHostProvider,
		imageCompositor,
		cloneProvider,
		diskProvider,
		revealPath = revealPathWithFinder,
		resolveDeviceDataRoot = resolveSimulatorDeviceDataRoot,
		mutationCoordinator = new SimulatorMutationCoordinator(),
		pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
		now = Date.now,
	}: {
		captureDirectory?: string;
		captureStore?: SimulatorCaptureStore;
		provider?: SimulatorHostProvider;
		metricsProvider?: SimulatorMetricsHostProvider;
		nativeHostProvider?: SimulatorNativeHostProvider;
		imageCompositor?: SimulatorImageCompositor;
		cloneProvider?: SimulatorCloneProvider;
		diskProvider?: SimulatorDiskProvider;
		revealPath?: SimulatorPathRevealer;
		resolveDeviceDataRoot?: SimulatorDeviceDataRootResolver;
		mutationCoordinator?: SimulatorMutationCoordinatorPort;
		pollIntervalMs?: number;
		now?: () => number;
	}) {
		this.#provider = provider;
		this.#metricsProvider = metricsProvider;
		this.#nativeHostProvider = nativeHostProvider;
		this.#imageCompositor = imageCompositor;
		this.#cloneProvider = cloneProvider;
		this.#diskProvider = diskProvider;
		this.#revealPath = revealPath;
		this.#resolveDeviceDataRoot = resolveDeviceDataRoot;
		this.#mutationCoordinator = mutationCoordinator;
		if ((captureDirectory === undefined) === (captureStore === undefined)) {
			throw new Error(
				'Configure exactly one Simulator capture store or directory.'
			);
		}
		this.#captureStore =
			captureStore ?? new SimulatorCaptureStore(captureDirectory as string);
		this.#pollIntervalMs =
			Number.isFinite(pollIntervalMs) && pollIntervalMs >= 250
				? pollIntervalMs
				: DEFAULT_POLL_INTERVAL_MS;
		this.#now = now;
		this.#updatedAt = now();
	}

	getState = (): SimulatorState => {
		const appsByDevice: Record<string, SimulatorApp[]> = Object.create(null);
		for (const [udid, apps] of this.#appsByDevice)
			appsByDevice[udid] = [...apps];
		const diskByDevice: Record<string, SimulatorDiskInventory> =
			Object.create(null);
		for (const [udid, inventory] of this.#diskByDevice) {
			diskByDevice[udid] = structuredClone(inventory);
		}
		return simulatorStateSchema.parse({
			revision: this.#revision,
			updatedAt: this.#updatedAt,
			capability: this.#capability,
			runtimes: this.#inventory.runtimes,
			deviceTypes: this.#inventory.deviceTypes,
			devices: this.#inventory.devices,
			appsByDevice,
			diskByDevice,
			jobs: this.#jobs.map((job) => job.public),
			captures: this.#captureStore.list(),
			metrics: this.#metrics,
			native: this.#native,
		});
	};

	subscribe(listener: SimulatorListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	setPollingActive(active: boolean): void {
		if (this.#pollingActive === active) return;
		this.#pollingActive = active;
		if (active && !this.#stopped) {
			void this.refresh()
				.then(() => this.refreshMetrics())
				.catch(() => undefined);
		}
	}

	async start(): Promise<void> {
		this.#stopped = false;
		await this.#captureStore.initialize();
		this.#touch();
		// Metrics need the discovered device list; an empty first sample looked like
		// zero resource use and ran a redundant host scan before discovery finished.
		await Promise.all([
			this.refresh().then(() => this.refreshMetrics()),
			this.refreshNative(),
		]);
		if (this.#stopped || this.#pollTimer) return;
		this.#pollTimer = setInterval(() => {
			if (!this.#pollingActive) return;
			void this.refresh().catch(() => undefined);
		}, this.#pollIntervalMs);
		this.#pollTimer.unref();
		this.#metricsTimer = setInterval(() => {
			if (!this.#pollingActive) return;
			void this.refreshMetrics().catch(() => undefined);
		}, METRICS_POLL_INTERVAL_MS);
		this.#metricsTimer.unref();
	}

	getCapture(captureId: string): SimulatorCapture | undefined {
		return this.#captureStore.get(captureId);
	}

	async getCaptureAccess(
		captureId: string
	): Promise<SimulatorCaptureAccessResult> {
		try {
			const opened = await this.#captureStore.openForRead(captureId);
			await opened.handle.close();
			return {
				captureId: opened.capture.id,
				available: true,
				url: simulatorCaptureUrl(captureId),
			};
		} catch {
			return { captureId, available: false };
		}
	}

	getCaptureRetention(): SimulatorCaptureRetentionState {
		return this.#captureStore.retentionState();
	}

	async deleteCapture(captureId: string): Promise<boolean> {
		const deleted = await this.#captureStore.delete(captureId);
		if (deleted) this.#touch();
		return deleted;
	}

	exportCapture(captureId: string, destinationPath: string): Promise<void> {
		return this.#captureStore.export(captureId, destinationPath);
	}

	verifiedCapturePath(captureId: string): Promise<string> {
		return this.#captureStore.verifiedPath(captureId);
	}

	async configureCaptureRetention(
		policy: SimulatorCaptureRetentionPolicy
	): Promise<SimulatorCaptureRetentionState> {
		const state = await this.#captureStore.configureRetention(policy);
		this.#touch();
		return state;
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		if (this.#pollTimer) clearInterval(this.#pollTimer);
		this.#pollTimer = undefined;
		if (this.#metricsTimer) clearInterval(this.#metricsTimer);
		this.#metricsTimer = undefined;
		this.#metricsController?.abort();
		this.#nativeController?.abort();
		for (const job of this.#jobs) {
			if (
				[
					'queued',
					'preflight',
					'running',
					'verifying',
					'rolling-back',
				].includes(job.public.status)
			) {
				job.controller.abort();
				if (job.public.status === 'queued') {
					job.public = {
						...job.public,
						status: 'cancelled',
						progressSequence: job.public.progressSequence + 1,
						phase: 'cancelled',
						finishedAt: this.#now(),
						message: 'Cancelled during shutdown.',
					};
				}
			}
		}
		await Promise.allSettled([
			...this.#tasks,
			...(this.#metricsRefreshPromise ? [this.#metricsRefreshPromise] : []),
			...(this.#nativeRefreshPromise ? [this.#nativeRefreshPromise] : []),
		]);
		this.#touch();
	}

	refresh(): Promise<SimulatorState> {
		if (this.#refreshPromise) return this.#refreshPromise;
		const refresh = this.#refreshInternal().finally(() => {
			if (this.#refreshPromise === refresh) this.#refreshPromise = undefined;
		});
		this.#refreshPromise = refresh;
		return refresh;
	}

	async rediscover(): Promise<SimulatorState> {
		if (this.#refreshPromise) await this.#refreshPromise;
		this.#capability = {
			status: 'checking',
			platform: platformName(),
			licenseStatus: 'unknown',
			hostArchitecture:
				process.arch === 'arm64' || process.arch === 'x64'
					? process.arch
					: 'other',
			runtimeAvailability: { total: 0, available: 0 },
			features: EMPTY_FEATURES,
		};
		this.#touch();
		return await this.refresh();
	}

	refreshMetrics(): Promise<SimulatorState> {
		if (this.#metricsRefreshPromise) return this.#metricsRefreshPromise;
		const controller = new AbortController();
		this.#metricsController = controller;
		const refresh = this.#metricsProvider
			.sample(this.#inventory.devices, controller.signal)
			.then((metrics) => {
				this.#metrics = metrics;
				this.#touch();
				return this.getState();
			})
			.finally(() => {
				if (this.#metricsRefreshPromise === refresh) {
					this.#metricsRefreshPromise = undefined;
				}
				if (this.#metricsController === controller)
					this.#metricsController = undefined;
			});
		this.#metricsRefreshPromise = refresh;
		return refresh;
	}

	refreshNative(): Promise<SimulatorState> {
		if (this.#nativeRefreshPromise) return this.#nativeRefreshPromise;
		if (!this.#nativeHostProvider) {
			this.#native = {
				status: 'unavailable',
				permissionInspection: false,
				permissionPrompting: false,
				permissions: [],
				error: 'The signed native permission host is not configured.',
			};
			this.#touch();
			return Promise.resolve(this.getState());
		}
		const controller = new AbortController();
		this.#nativeController = controller;
		const refresh = this.#nativeHostProvider
			.inspectPermissions(controller.signal)
			.then((native) => {
				this.#native = native;
				this.#touch();
				return this.getState();
			})
			.catch((error: unknown) => {
				const kind =
					error && typeof error === 'object' && 'kind' in error
						? (error as { kind?: unknown }).kind
						: undefined;
				this.#native = {
					status: kind === 'untrusted' ? 'untrusted' : 'unavailable',
					permissionInspection: false,
					permissionPrompting: false,
					permissions: [],
					error: errorText(error),
				};
				this.#touch();
				return this.getState();
			})
			.finally(() => {
				if (this.#nativeRefreshPromise === refresh) {
					this.#nativeRefreshPromise = undefined;
				}
				if (this.#nativeController === controller)
					this.#nativeController = undefined;
			});
		this.#nativeRefreshPromise = refresh;
		return refresh;
	}

	async resolveConfirmationTarget(
		udid: string
	): Promise<{ name: string; udid: string }> {
		const inventory = await this.#provider.inventory();
		const device = inventory.devices.find(
			(candidate) => candidate.udid === udid && candidate.isAvailable
		);
		if (!device) {
			throw new Error('Simulator is not present in the fresh inventory.');
		}
		return { name: device.name, udid: device.udid };
	}

	async #refreshInternal(): Promise<SimulatorState> {
		if (this.#capability.status !== 'available') {
			this.#capability = await this.#provider.discover();
			this.#touch();
			if (this.#capability.status !== 'available') return this.getState();
		}
		try {
			const previouslyBooted = new Set(
				this.#inventory.devices
					.filter((device) => device.state === 'booted')
					.map((device) => device.udid)
			);
			this.#inventory = await this.#provider.inventory();
			this.#capability = {
				...this.#capability,
				runtimeAvailability: {
					total: this.#inventory.runtimes.length,
					available: this.#inventory.runtimes.filter(
						(runtime) => runtime.isAvailable
					).length,
				},
			};
			const validDeviceIds = new Set(
				this.#inventory.devices.map((device) => device.udid)
			);
			for (const udid of this.#appsByDevice.keys()) {
				if (!validDeviceIds.has(udid)) this.#appsByDevice.delete(udid);
			}
			for (const udid of this.#diskByDevice.keys()) {
				if (!validDeviceIds.has(udid)) this.#diskByDevice.delete(udid);
			}
			for (const device of this.#inventory.devices) {
				if (
					device.state !== 'booted' ||
					(this.#appsByDevice.has(device.udid) &&
						previouslyBooted.has(device.udid))
				) {
					continue;
				}
				try {
					await this.#refreshApps(device.udid);
				} catch {
					// App inventory is best-effort and can be manually retried without hiding
					// an otherwise healthy Simulator target.
				}
			}
			const { error: _error, ...healthyCapability } = this.#capability;
			this.#capability = healthyCapability;
		} catch (error) {
			this.#capability = { ...this.#capability, error: errorText(error) };
		}
		this.#touch();
		return this.getState();
	}

	runAction(
		value: SimulatorAction,
		context: SimulatorActionContext = {},
		mutationLease?: SimulatorMutationLease
	): SimulatorActionReceipt {
		const action = simulatorActionSchema.parse(value);
		if (this.#stopped) {
			return {
				actionId: action.actionId,
				accepted: false,
				error: 'Simulator controls are shutting down.',
			};
		}
		if (this.#capability.status !== 'available') {
			return {
				actionId: action.actionId,
				accepted: false,
				error: this.#capability.error ?? 'Simulator controls are unavailable.',
			};
		}
		const requiredFeature = actionFeature(action);
		if (!this.#capability.features[requiredFeature]) {
			return {
				actionId: action.actionId,
				accepted: false,
				error: `This Xcode installation does not support ${requiredFeature}.`,
			};
		}
		if (this.#jobs.some((job) => job.public.actionId === action.actionId)) {
			return {
				actionId: action.actionId,
				accepted: false,
				error: 'A simulator action with this identifier already exists.',
			};
		}
		if (
			(action.kind === 'app.install' ||
				action.kind === 'keychain.addCertificate' ||
				action.kind === 'location.importGpx') &&
			!context.selectedPath &&
			!(
				action.kind === 'keychain.addCertificate' &&
				context.materializeCertificatePath
			)
		) {
			return {
				actionId: action.actionId,
				accepted: false,
				error: 'Required file selection was cancelled.',
			};
		}
		if (!this.#makeJobCapacity()) {
			return {
				actionId: action.actionId,
				accepted: false,
				error: `The ${MAX_JOBS}-job simulator queue is full.`,
			};
		}

		const jobId = `simulator-${randomUUID()}`;
		const controller = new AbortController();
		const internal: InternalJob = {
			controller,
			public: {
				id: jobId,
				actionId: action.actionId,
				kind: action.kind,
				status: 'queued',
				progressSequence: 0,
				phase: 'queued',
				createdAt: this.#now(),
				message: 'Waiting for earlier simulator work…',
				...(actionDeviceUdid(action)
					? { deviceUdid: actionDeviceUdid(action) }
					: {}),
			},
		};
		this.#jobs.push(internal);
		this.#touch();

		const udid = actionDeviceUdid(action);
		const coordinated = Boolean(udid && mutatesSimulatorTarget(action));
		const queueKey = actionQueueKey(action);
		const previous = this.#queues.get(queueKey) ?? Promise.resolve();
		const execution = coordinated
			? this.#runCoordinatedJob(
					internal,
					action,
					context,
					udid as string,
					mutationLease
				)
			: previous
					.catch(() => undefined)
					.then(() => this.#runJob(internal, action, context));
		const task = execution.finally(async () => {
			if (!context.cleanupSelectedInput) return;
			try {
				await context.cleanupSelectedInput();
			} catch {
				// Main-owned staged artifacts are also removed at app shutdown/startup.
			}
		});
		if (!coordinated) this.#queues.set(queueKey, task);
		this.#tasks.add(task);
		void task.finally(() => {
			this.#tasks.delete(task);
			if (!coordinated && this.#queues.get(queueKey) === task) {
				this.#queues.delete(queueKey);
			}
		});
		return { actionId: action.actionId, accepted: true, jobId };
	}

	cancelJob(jobId: string): boolean {
		const job = this.#jobs.find((candidate) => candidate.public.id === jobId);
		if (
			!job ||
			!['queued', 'preflight', 'running', 'verifying', 'rolling-back'].includes(
				job.public.status
			)
		) {
			return false;
		}
		job.controller.abort();
		if (job.public.status === 'queued') {
			job.public = {
				...job.public,
				status: 'cancelled',
				progressSequence: job.public.progressSequence + 1,
				phase: 'cancelled',
				finishedAt: this.#now(),
				message: 'Cancelled before execution.',
			};
			this.#touch();
		}
		return true;
	}

	async #runJob(
		job: InternalJob,
		action: SimulatorAction,
		context: SimulatorActionContext
	): Promise<void> {
		if (job.controller.signal.aborted) return;
		job.public = {
			...job.public,
			status: 'preflight',
			progressSequence: job.public.progressSequence + 1,
			phase: 'preflight',
			startedAt: this.#now(),
			message: 'Validating simulator state and action inputs…',
		};
		this.#touch();
		job.public = {
			...job.public,
			status: 'running',
			progressSequence: job.public.progressSequence + 1,
			phase: 'executing',
			message: 'Running simulator action…',
		};
		this.#touch();
		try {
			const capture = mutatesInventory(action)
				? await this.#withInventoryMutation(job.controller.signal, () =>
						this.#execute(action, context, job.controller.signal, (udid) => {
							job.public = { ...job.public, deviceUdid: udid };
							this.#touch();
						})
					)
				: await this.#execute(action, context, job.controller.signal);
			if (job.controller.signal.aborted) {
				job.public = {
					...job.public,
					status: 'cancelled',
					progressSequence: job.public.progressSequence + 1,
					phase: 'cancelled',
					finishedAt: this.#now(),
					message: capture
						? 'Recording stopped and saved.'
						: 'Action cancelled.',
					...(capture ? { captureId: capture.id } : {}),
				};
			} else {
				job.public = {
					...job.public,
					status: 'complete',
					progressSequence: job.public.progressSequence + 1,
					phase: 'complete',
					finishedAt: this.#now(),
					message: 'Simulator action completed.',
					...(capture ? { captureId: capture.id } : {}),
				};
			}
		} catch (error) {
			const cancelled =
				job.controller.signal.aborted ||
				(error instanceof SimulatorCommandError && error.kind === 'aborted');
			job.public = {
				...job.public,
				status: cancelled ? 'cancelled' : 'failed',
				progressSequence: job.public.progressSequence + 1,
				phase: cancelled ? 'cancelled' : 'failed',
				finishedAt: this.#now(),
				message: cancelled ? 'Action cancelled.' : errorText(error),
			};
		} finally {
			this.#touch();
		}
	}

	async #runCoordinatedJob(
		job: InternalJob,
		action: SimulatorAction,
		context: SimulatorActionContext,
		udid: string,
		mutationLease?: SimulatorMutationLease
	): Promise<void> {
		try {
			await this.#mutationCoordinator.runExclusive(
				udid,
				job.controller.signal,
				() => this.#runJob(job, action, context),
				mutationLease
			);
		} catch (error) {
			if (job.public.status !== 'queued') return;
			const cancelled = job.controller.signal.aborted;
			job.public = {
				...job.public,
				status: cancelled ? 'cancelled' : 'failed',
				progressSequence: job.public.progressSequence + 1,
				phase: cancelled ? 'cancelled' : 'failed',
				finishedAt: this.#now(),
				message: cancelled ? 'Action cancelled.' : errorText(error),
			};
			this.#touch();
		}
	}

	async #withInventoryMutation<T>(
		signal: AbortSignal,
		operation: () => Promise<T>
	): Promise<T> {
		const previous = this.#inventoryMutationQueue;
		let release: () => void = () => undefined;
		this.#inventoryMutationQueue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous.catch(() => undefined);
		try {
			if (signal.aborted) {
				throw new SimulatorCommandError('Simulator action cancelled.', {
					kind: 'aborted',
				});
			}
			return await operation();
		} finally {
			release();
		}
	}

	#requireDevice(udid: string, booted = false): SimulatorDevice {
		const device = this.#inventory.devices.find(
			(candidate) => candidate.udid === udid
		);
		if (!device?.isAvailable) {
			throw new Error('Simulator is not present in the current inventory.');
		}
		if (booted && device.state !== 'booted') {
			throw new Error('Simulator must be booted for this action.');
		}
		return device;
	}

	async #run(
		args: readonly string[],
		signal: AbortSignal,
		options: Omit<SimulatorCommandOptions, 'signal'> = {}
	): Promise<string> {
		const result = await this.#provider.runSimctl(args, { ...options, signal });
		return result.stdout;
	}

	async #refreshInventory(signal: AbortSignal): Promise<void> {
		this.#inventory = await this.#provider.inventory(signal);
	}

	async #refreshApps(udid: string, signal?: AbortSignal): Promise<void> {
		this.#appsByDevice.set(udid, await this.#provider.listApps(udid, signal));
	}

	async #execute(
		action: SimulatorAction,
		context: SimulatorActionContext,
		signal: AbortSignal,
		onCreated?: (udid: string) => void
	): Promise<SimulatorCapture | undefined> {
		if (action.kind === 'device.create') {
			await this.#refreshInventory(signal);
			if (
				!this.#inventory.deviceTypes.some(
					(deviceType) => deviceType.identifier === action.deviceTypeIdentifier
				)
			) {
				throw new Error('Device type is not present in the current inventory.');
			}
			if (
				action.runtimeIdentifier &&
				!this.#inventory.runtimes.some(
					(runtime) =>
						runtime.identifier === action.runtimeIdentifier &&
						runtime.isAvailable
				)
			) {
				throw new Error('Runtime is not available in the current inventory.');
			}
			const createdOutput = await this.#run(
				[
					'create',
					action.name,
					action.deviceTypeIdentifier,
					...(action.runtimeIdentifier ? [action.runtimeIdentifier] : []),
				],
				signal,
				{ timeoutMs: 60_000 }
			);
			await this.#refreshInventory(signal);
			const created = udidSchema.safeParse(createdOutput.trim());
			if (created.success) onCreated?.(created.data);
			if (action.bootAfterCreate) {
				if (!created.success)
					throw new Error(
						'Simulator created, but Xcode did not return a valid device ID. Refresh the list to open it.'
					);
				const device = this.#requireDevice(created.data);
				if (device.state !== 'booted')
					await this.#run(['boot', device.udid], signal, {
						timeoutMs: 120_000,
					});
				await this.#run(['bootstatus', device.udid, '-b'], signal, {
					timeoutMs: 180_000,
				});
				await this.#provider.openSimulator(device.udid, signal);
				await this.#refreshInventory(signal);
				await this.#refreshApps(device.udid, signal);
			}
			return undefined;
		}
		if (action.kind === 'capture.compose') {
			if (!this.#imageCompositor) {
				throw new Error('The signed native image compositor is not available.');
			}
			const primary = this.#captureStore.get(action.primaryCaptureId);
			if (
				primary?.kind !== 'screenshot' ||
				!primary.mimeType.startsWith('image/') ||
				primary.deviceUdid !== action.udid
			) {
				throw new Error(
					'The primary image does not belong to the selected simulator.'
				);
			}
			const secondary = action.secondaryCaptureId
				? this.#captureStore.get(action.secondaryCaptureId)
				: undefined;
			if (
				action.secondaryCaptureId &&
				(secondary?.kind !== 'screenshot' ||
					!secondary.mimeType.startsWith('image/'))
			) {
				throw new Error('The comparison image is not an available screenshot.');
			}
			const [primaryPath, secondaryPath] = await Promise.all([
				this.#captureStore.verifiedPath(primary.id),
				secondary ? this.#captureStore.verifiedPath(secondary.id) : undefined,
			]);
			const pending = await this.#captureStore.reserve({
				deviceUdid: action.udid,
				kind: 'screenshot',
				format: action.recipe.outputFormat,
				...(action.name ? { name: action.name } : {}),
			});
			try {
				await this.#imageCompositor.compose(
					{
						primaryPath,
						...(secondaryPath ? { secondaryPath } : {}),
						outputPath: pending.path,
						recipe: action.recipe,
					},
					signal
				);
				return await this.#captureStore.commit(pending);
			} catch (error) {
				await this.#captureStore.discard(pending);
				throw error;
			}
		}

		// Resolve every targeted UDID against a fresh CoreSimulator inventory at
		// execution time. Jobs may sit behind another mutation, so the renderer's
		// or polling loop's earlier state is not an authorization preflight.
		await this.#refreshInventory(signal);
		const device = this.#requireDevice(action.udid);
		if (action.kind === 'device.boot') {
			if (device.state !== 'booted') {
				await this.#run(['boot', action.udid], signal, { timeoutMs: 120_000 });
			}
			await this.#run(['bootstatus', action.udid, '-b'], signal, {
				timeoutMs: 180_000,
			});
			await this.#provider.openSimulator(action.udid, signal);
			await this.#refreshInventory(signal);
			return undefined;
		}
		if (action.kind === 'device.shutdown') {
			if (device.state !== 'shutdown') {
				await this.#run(['shutdown', action.udid], signal, {
					timeoutMs: 60_000,
				});
			}
			await this.#refreshInventory(signal);
			return undefined;
		}
		if (action.kind === 'device.erase') {
			if (device.state !== 'shutdown') {
				throw new Error('Simulator must be shut down before it can be erased.');
			}
			await this.#run(['erase', action.udid], signal, { timeoutMs: 120_000 });
			this.#appsByDevice.delete(action.udid);
			this.#diskByDevice.delete(action.udid);
			await this.#refreshInventory(signal);
			return undefined;
		}
		if (action.kind === 'device.delete') {
			await this.#run(['delete', action.udid], signal, { timeoutMs: 120_000 });
			this.#appsByDevice.delete(action.udid);
			this.#diskByDevice.delete(action.udid);
			await this.#refreshInventory(signal);
			return undefined;
		}
		if (action.kind === 'device.clone') {
			if (!this.#cloneProvider) {
				throw new Error(
					'The trusted pinned SimSlim clone helper is unavailable; direct simctl cloning is disabled.'
				);
			}
			await this.#cloneProvider.cloneSimulator(
				action.udid,
				action.name,
				signal
			);
			await this.#refreshInventory(signal);
			return undefined;
		}
		if (action.kind === 'device.rename') {
			await this.#run(['rename', action.udid, action.name], signal);
			await this.#refreshInventory(signal);
			return undefined;
		}
		if (action.kind === 'disk.inspect') {
			if (!this.#diskProvider) {
				throw new Error(
					'The signed SimSlim disk inventory helper is not available.'
				);
			}
			const plan = await this.#diskProvider.planDiskCleanup(
				action.udid,
				signal
			);
			const previous = this.#diskByDevice.get(action.udid);
			this.#diskByDevice.set(action.udid, {
				simulatorUdid: plan.simulatorId,
				totalBytes: plan.totalBytes,
				cleanableBytes: plan.cleanableBytes,
				categories: plan.categories,
				storage: plan.storage,
				inspectedAt: this.#now(),
				...(previous?.lastCleanup ? { lastCleanup: previous.lastCleanup } : {}),
			});
			return undefined;
		}
		if (action.kind === 'disk.cleanup') {
			if (!this.#diskProvider) {
				throw new Error(
					'The signed SimSlim disk cleanup helper is not available.'
				);
			}
			const before = await this.#diskProvider.planDiskCleanup(
				action.udid,
				signal
			);
			const beforeInspectedAt = this.#now();
			const cleanable = new Set(
				before.categories
					.filter((category) => category.canClean)
					.map((category) => category.id)
			);
			if (action.categoryIds.some((categoryId) => !cleanable.has(categoryId))) {
				throw new Error(
					'The fresh disk plan no longer permits one of the selected cleanup categories.'
				);
			}
			const cleanup = await this.#diskProvider.cleanDisk(
				action.udid,
				action.categoryIds,
				signal
			);
			const lastCleanup = {
				categoryIds: cleanup.categoryIds as SimulatorDiskCleanupCategoryId[],
				beforeBytes: cleanup.beforeBytes,
				afterBytes: cleanup.afterBytes,
				reclaimedBytes: cleanup.reclaimedBytes,
				wasBooted: cleanup.wasBooted,
				bootStateRestored: cleanup.bootStateRestored,
				cleanedAt: this.#now(),
			};
			try {
				const after = await this.#diskProvider.planDiskCleanup(
					action.udid,
					signal
				);
				this.#diskByDevice.set(action.udid, {
					simulatorUdid: after.simulatorId,
					totalBytes: after.totalBytes,
					cleanableBytes: after.cleanableBytes,
					categories: after.categories,
					storage: after.storage,
					inspectedAt: this.#now(),
					lastCleanup,
				});
			} catch (cause) {
				this.#diskByDevice.set(action.udid, {
					simulatorUdid: before.simulatorId,
					totalBytes: before.totalBytes,
					cleanableBytes: before.cleanableBytes,
					categories: before.categories,
					storage: before.storage,
					inspectedAt: beforeInspectedAt,
					lastCleanup,
				});
				throw new Error(
					'Disk cleanup completed, but its updated inventory could not be inspected.',
					{ cause }
				);
			}
			return undefined;
		}

		this.#requireDevice(action.udid, true);
		if (action.kind === 'app.list') {
			await this.#refreshApps(action.udid, signal);
			return undefined;
		}
		if (action.kind === 'app.install') {
			const appPath = await validatedSelectedPath(context.selectedPath, 'app');
			await this.#run(['install', action.udid, appPath], signal, {
				timeoutMs: 120_000,
			});
			await this.#refreshApps(action.udid, signal);
			return undefined;
		}
		if (action.kind === 'app.uninstall') {
			await this.#run(
				['uninstall', action.udid, action.bundleIdentifier],
				signal
			);
			await this.#refreshApps(action.udid, signal);
			return undefined;
		}
		if (action.kind === 'app.launch') {
			const launchArguments = [...action.arguments];
			if (action.languages) {
				launchArguments.push(
					'-AppleLanguages',
					`(${action.languages.join(',')})`
				);
			}
			if (action.locale) launchArguments.push('-AppleLocale', action.locale);
			const argumentBytes = launchArguments.reduce(
				(total, argument) => total + Buffer.byteLength(argument, 'utf8'),
				0
			);
			if (argumentBytes > MAX_APP_ARGUMENT_BYTES) {
				throw new Error('Application arguments exceed the safe size limit.');
			}
			await this.#run(
				[
					'launch',
					...(action.terminateRunning ? ['--terminate-running-process'] : []),
					action.udid,
					action.bundleIdentifier,
					...launchArguments,
				],
				signal,
				{
					timeoutMs: 60_000,
					...(action.timeZone !== undefined ||
					action.slowAnimations !== undefined
						? {
								simulatorAppEnvironment: {
									...(action.timeZone ? { timeZone: action.timeZone } : {}),
									...(action.slowAnimations !== undefined
										? { slowAnimations: action.slowAnimations }
										: {}),
								},
							}
						: {}),
				}
			);
			return undefined;
		}
		if (action.kind === 'app.terminate') {
			await this.#run(
				['terminate', action.udid, action.bundleIdentifier],
				signal
			);
			return undefined;
		}
		if (action.kind === 'app.openUniversalLink') {
			await this.#run(['openurl', action.udid, action.url], signal);
			return undefined;
		}
		if (action.kind === 'app.revealContainer') {
			const container =
				action.container === 'app-group'
					? action.appGroupIdentifier
					: action.container;
			if (!container) {
				throw new Error(
					'An App Group identifier is required for this container.'
				);
			}
			const containerPaths = appContainerPaths(
				await this.#run(
					[
						'get_app_container',
						action.udid,
						action.bundleIdentifier,
						container,
					],
					signal
				),
				container
			);
			const deviceDataRoot = await this.#resolveDeviceDataRoot(action.udid);
			const resolvedContainers = await Promise.all(
				containerPaths.map(async (containerPath) => {
					const resolved = await realpath(containerPath);
					const metadata = await lstat(resolved);
					if (
						!metadata.isDirectory() ||
						!resolved.startsWith(`${deviceDataRoot}${path.sep}`)
					) {
						throw new Error(
							'Simulator app container escaped the selected device data root.'
						);
					}
					return resolved;
				})
			);
			for (const resolved of resolvedContainers) {
				await this.#revealPath(resolved, signal);
			}
			return undefined;
		}
		if (action.kind === 'pasteboard.sync') {
			const [source, destination] =
				action.direction === 'host-to-simulator'
					? ['host', action.udid]
					: [action.udid, 'host'];
			await this.#run(['pbsync', source, destination], signal, {
				timeoutMs: 30_000,
			});
			return undefined;
		}
		if (action.kind === 'url.open') {
			await this.#run(['openurl', action.udid, action.url], signal);
			return undefined;
		}
		if (action.kind === 'location.clear') {
			await this.#run(['location', action.udid, 'clear'], signal);
			return undefined;
		}
		if (action.kind === 'location.set') {
			await this.#run(
				[
					'location',
					action.udid,
					'set',
					coordinate(action.latitude, action.longitude),
				],
				signal
			);
			return undefined;
		}
		if (action.kind === 'location.run') {
			await this.#run(
				['location', action.udid, 'run', action.scenario],
				signal
			);
			return undefined;
		}
		if (action.kind === 'location.start') {
			const options: string[] = [];
			if (action.speedMetersPerSecond !== undefined) {
				options.push(`--speed=${action.speedMetersPerSecond}`);
			}
			if (action.distanceMeters !== undefined) {
				options.push(`--distance=${action.distanceMeters}`);
			}
			if (action.intervalSeconds !== undefined) {
				options.push(`--interval=${action.intervalSeconds}`);
			}
			await this.#run(
				[
					'location',
					action.udid,
					'start',
					...options,
					...action.waypoints.map((point) =>
						coordinate(point.latitude, point.longitude)
					),
				],
				signal,
				{ timeoutMs: MAX_LOCATION_ROUTE_MS, cancelSignal: 'SIGINT' }
			);
			return undefined;
		}
		if (action.kind === 'location.importGpx') {
			const gpxPath = await validatedSelectedPath(context.selectedPath, 'gpx');
			const waypoints = parseGpxWaypoints(
				await readBoundedText(gpxPath, MAX_GPX_BYTES)
			);
			await this.#run(
				[
					'location',
					action.udid,
					'start',
					...(action.speedMetersPerSecond === undefined
						? []
						: [`--speed=${action.speedMetersPerSecond}`]),
					'-',
				],
				signal,
				{
					stdin: `${waypoints
						.map((point) => coordinate(point.latitude, point.longitude))
						.join('\n')}\n`,
					timeoutMs: MAX_LOCATION_ROUTE_MS,
					cancelSignal: 'SIGINT',
				}
			);
			return undefined;
		}
		if (action.kind === 'push.send') {
			await this.#run(
				['push', action.udid, action.bundleIdentifier, '-'],
				signal,
				{
					stdin: parsePushPayload(action.payloadJson),
				}
			);
			return undefined;
		}
		if (action.kind === 'privacy.update') {
			await this.#run(
				[
					'privacy',
					action.udid,
					action.operation,
					action.service,
					action.bundleIdentifier,
				],
				signal
			);
			return undefined;
		}
		if (action.kind === 'ui.update') {
			await this.#run(
				['ui', action.udid, action.setting, action.value],
				signal
			);
			return undefined;
		}
		if (action.kind === 'statusBar.clear') {
			await this.#run(['status_bar', action.udid, 'clear'], signal);
			return undefined;
		}
		if (action.kind === 'statusBar.override') {
			await this.#run(
				[
					'status_bar',
					action.udid,
					'override',
					...statusBarArguments(action.overrides),
				],
				signal
			);
			return undefined;
		}
		if (action.kind === 'keychain.reset') {
			await this.#run(['keychain', action.udid, 'reset'], signal);
			return undefined;
		}
		if (action.kind === 'keychain.addCertificate') {
			const materialized = context.materializeCertificatePath
				? await context.materializeCertificatePath()
				: undefined;
			try {
				const certificatePath = materialized
					? materialized.path
					: await validatedSelectedPath(context.selectedPath, 'certificate');
				await this.#run(
					[
						'keychain',
						action.udid,
						action.trustRoot ? 'add-root-cert' : 'add-cert',
						certificatePath,
					],
					signal
				);
			} finally {
				await materialized?.cleanup();
			}
			return undefined;
		}
		if (action.kind === 'capture.screenshot') {
			const pending = await this.#captureStore.reserve({
				deviceUdid: action.udid,
				kind: 'screenshot',
				format: action.format,
				...(action.name ? { name: action.name } : {}),
			});
			try {
				await this.#run(
					[
						'io',
						action.udid,
						'screenshot',
						`--type=${action.format}`,
						`--mask=${action.mask}`,
						pending.path,
					],
					signal,
					{ timeoutMs: 60_000 }
				);
				return await this.#captureStore.commit(pending);
			} catch (error) {
				await this.#captureStore.discard(pending);
				throw error;
			}
		}
		if (action.kind === 'capture.video') {
			const pending = await this.#captureStore.reserve({
				deviceUdid: action.udid,
				kind: 'video',
				format: 'mp4',
				...(action.name ? { name: action.name } : {}),
			});
			try {
				await this.#run(
					[
						'io',
						action.udid,
						'recordVideo',
						`--codec=${action.codec}`,
						`--mask=${action.mask}`,
						pending.path,
					],
					signal,
					{
						timeoutMs: MAX_VIDEO_RECORDING_MS,
						cancelSignal: 'SIGINT',
						maxOutputBytes: 1024 * 1024,
					}
				);
				return await this.#captureStore.commit(pending);
			} catch (error) {
				if (
					error instanceof SimulatorCommandError &&
					((signal.aborted && error.kind === 'aborted') ||
						error.kind === 'timeout')
				) {
					try {
						return await this.#captureStore.commit(pending);
					} catch {
						await this.#captureStore.discard(pending);
					}
				}
				await this.#captureStore.discard(pending);
				throw error;
			}
		}
		throw new Error(
			`Unsupported simulator action: ${(action as SimulatorAction).kind}`
		);
	}

	#makeJobCapacity(): boolean {
		while (this.#jobs.length >= MAX_JOBS) {
			const index = this.#jobs.findIndex((job) =>
				['complete', 'failed', 'needs-attention', 'cancelled'].includes(
					job.public.status
				)
			);
			if (index < 0) return false;
			this.#jobs.splice(index, 1);
		}
		return true;
	}

	#touch(): void {
		this.#revision += 1;
		this.#updatedAt = this.#now();
		if (this.#stopped) return;
		const state = this.getState();
		for (const listener of this.#listeners) {
			try {
				listener(state);
			} catch {
				// A renderer listener cannot interrupt simulator lifecycle management.
			}
		}
	}
}

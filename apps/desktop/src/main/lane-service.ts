import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { redactDiagnosticText } from '@rndevtools/core/redact';
import {
	type DeviceAccessDecision,
	type DeviceHold,
	freeDevices,
} from '../shared/device-hold';
import {
	allocateLanePort,
	DEFAULT_LANE_ENVIRONMENTS,
	findLaneConflict,
	LANE_METRO_HEALTH_TIMEOUT_MS,
	type Lane,
	type LaneAgent,
	type LaneBackendPolicy,
	type LaneDeviceRequest,
	type LaneEnvironment,
	type LaneOperation,
	type LaneOperationReceipt,
	type LaneReservation,
	type LaneSlim,
	type LaneState,
	type LaneView,
	type LaneWorktree,
	laneAppDirectory,
	laneDeepLink,
	laneDevClientLaunchUrl,
	laneOperationReceiptSchema,
	laneOperationSchema,
	laneStateSchema,
	MAX_DEVICE_REQUESTS,
} from '../shared/lane-protocol';
import type {
	SimulatorAction,
	SimulatorActionReceipt,
	SimulatorDevice,
	SimulatorJob,
	SimulatorState,
} from '../shared/simulator-protocol';
import {
	SLIMMING_CONFIRMATIONS,
	type SlimmingAction,
	type SlimmingActionReceipt,
	type SlimmingState,
} from '../shared/slimming-protocol';
import {
	type LaneBackendSummary,
	type LaneWorktreeSupabase,
	laneBackendSummarySchema,
	laneWorktreeSupabaseSchema,
	sanitizeSupabaseDisplayText,
} from '../shared/supabase-protocol';
import { waitForJob } from './job-wait';
import {
	laneEnvProblem,
	type MetroSupervisorPort,
	metroSupervisor,
	NotLaneMetroError,
} from './lane-metro';
import type { LaneStore } from './lane-store';
import { type WorktreeInspectorPort, worktreeInspector } from './lane-worktree';
import { safeErrorText } from './security';
import type {
	SimulatorMutationCoordinatorPort,
	SimulatorMutationLease,
} from './simulator-mutation-coordinator';
import {
	LANE_BACKEND_DEFAULT_WAIT_MS,
	type LaneBackendEnsureInput,
	type LaneBackendEnsureResult,
	type LaneBackendLateAttach,
	type SupabaseMetroRestartReason,
} from './supabase/service-ports';

const HEALTH_POLL_INTERVAL_MS = 500;
const RECONCILE_INTERVAL_MS = 5_000;
/** How long a settled device request stays listed for the agent that made it. */
const DEVICE_REQUEST_TTL_MS = 30 * 60_000;
/** How long the Metro log of a lane that is gone is kept once it stops growing. */
const LANE_LOG_RETENTION_MS = 7 * 24 * 60 * 60_000;
const LANE_LOG_PRUNE_INTERVAL_MS = 60 * 60_000;
/** How often a wait on the injected clock looks at it again. */
const CLOCK_POLL_INTERVAL_MS = 250;
/** How long a Metro restart waits for the old Metro to let go of the port. */
const METRO_EXIT_TIMEOUT_MS = 10_000;
const METRO_EXIT_POLL_INTERVAL_MS = 100;
const MAX_BACKEND_REASON_LENGTH = 1_024;

export type LaneSimulatorPort = {
	getState: () => SimulatorState;
	refresh: () => Promise<SimulatorState>;
	runAction: (action: SimulatorAction) => SimulatorActionReceipt;
	cancelJob: (jobId: string) => boolean;
	subscribe: (listener: (state: SimulatorState) => void) => () => void;
};

/**
 * The slice of the SimSlim service a lane may drive. It is the same entry
 * point the Simulator panel and recipes use, so every gate in `runAction`
 * (experimental setting, compatibility tuple, signed-helper authorization)
 * applies to a lane exactly as it does to a click in the panel.
 */
export type LaneSlimmingPort = {
	getState: () => SlimmingState;
	refresh: () => Promise<SlimmingState>;
	runAction: (
		action: SlimmingAction,
		mutationLease?: SimulatorMutationLease
	) => SlimmingActionReceipt;
	cancelJob: (jobId: string) => boolean;
	subscribe: (listener: (state: SlimmingState) => void) => () => void;
};

/**
 * A worktree's local backend as a lane sees it: the Supabase service in
 * main. `ensureForLane` answers with a summary instead of rejecting over a
 * backend problem, and adds `lateAttach` (which never rejects) when the
 * backend is still starting. `detachLane` drops the lane's hold without
 * waiting for anything to stop. `defaultPolicy` is what a start that names
 * no backend gets in that environment.
 */
export type LaneBackendPort = {
	ensureForLane: (
		input: LaneBackendEnsureInput,
		signal?: AbortSignal
	) => Promise<LaneBackendEnsureResult>;
	detachLane: (laneId: string) => void;
	defaultPolicy: (environmentId: string) => 'auto' | 'off';
	/** The worktree's Supabase project for the start form, when known. */
	describeWorktree?: (worktreePath: string) => LaneWorktreeSupabase | undefined;
};

/**
 * Whether `requester` (an agent, or the operator when undefined) may drive
 * the Simulator: the agent service's answer, the one the router asks.
 */
export type LaneDeviceAccessPort = (
	simulatorUdid: string,
	requester: Pick<LaneAgent, 'kind' | 'sessionId'> | undefined
) => DeviceAccessDecision;

type LaneListener = (state: LaneState) => void;

type LaneStartInput = Extract<LaneOperation, { kind: 'lane.start' }>;

type BackendEnv = Readonly<Record<string, string>>;

/**
 * What main knows about one lane's local backend. In memory only: lanes.json
 * never holds its values. A desktop restart rebuilds it from the backend
 * port and compares the durable Metro environment hash before reusing values.
 */
type LaneBackendRecord = {
	policy: LaneBackendPolicy;
	/** The port's latest answer, as the lane wire allows it. */
	summary: LaneBackendSummary;
	/** What the lane's current Metro was spawned with; never stored or echoed. */
	env?: BackendEnv | undefined;
	/** Bumped by every new answer, so an older late attach knows it lost. */
	generation: number;
	/** A dev-client launch held back until the backend is ready. */
	deferredLaunch: boolean;
	metro?: 'restarted' | 'unchanged' | 'needs-restart' | undefined;
	/** The lane's own word on its backend, such as a restart that failed. */
	note?: string | undefined;
};

/** An ensure in flight; its answer never rejects. */
type PendingBackend = {
	policy: 'auto' | 'required';
	answer: Promise<LaneBackendEnsureResult>;
};

/** What a lane does with its backend once its Metro is due. */
type BackendDecision = {
	summary: LaneBackendSummary;
	/** Present when the backend serves the lane now: this Metro gets it. */
	env?: BackendEnv | undefined;
	/** Present while the backend is still starting; settles when it is not. */
	late?: Promise<LaneBackendLateAttach> | undefined;
};

/** A `required` lane start refused over its backend; the receipt carries why. */
class LaneBackendError extends Error {
	readonly summary: LaneBackendSummary;

	constructor(summary: LaneBackendSummary) {
		const state = summary.reason
			? `${summary.status} (${summary.reason})`
			: summary.status;
		super(
			`This lane requires its local backend, which is ${state}.${summary.reasonText ? ` ${summary.reasonText}` : ''}`
		);
		this.summary = summary;
	}
}

/**
 * A lane start either produces a lane or, when no Simulator was named and none
 * is free, a device request the user settles from the Lanes panel.
 */
export type LaneStartOutcome =
	| { lane: LaneView; deviceRequest?: undefined }
	| { lane?: undefined; deviceRequest: LaneDeviceRequest };

/** One line of redacted, bounded text the lane wire accepts as a reason. */
function backendReason(text: string): string {
	return sanitizeSupabaseDisplayText(
		redactDiagnosticText(text),
		MAX_BACKEND_REASON_LENGTH
	);
}

function backendSummary(
	policy: LaneBackendPolicy,
	status: LaneBackendSummary['status'],
	extra: Partial<LaneBackendSummary> = {}
): LaneBackendSummary {
	return { policy, status, appEnvNames: [], warnings: [], ...extra };
}

function failedBackend(
	policy: LaneBackendPolicy,
	text: string
): LaneBackendSummary {
	return backendSummary(policy, 'failed', {
		reason: 'failed',
		reasonText: backendReason(text),
	});
}

/** Compares two sets of backend variables, whatever their key order. */
function envFingerprint(env: BackendEnv | undefined): string {
	return createHash('sha256')
		.update(
			JSON.stringify(
				Object.entries(env ?? {}).sort(([left], [right]) =>
					left.localeCompare(right)
				)
			)
		)
		.digest('hex');
}

/** Unknown values may still be in a surviving Metro; a known empty hash is safe. */
function metroHasBackendEnv(
	lane: Lane,
	record: LaneBackendRecord | undefined
): boolean {
	if (record?.env !== undefined) return Object.keys(record.env).length > 0;
	if (lane.backendEnvHash !== undefined) {
		return lane.backendEnvHash !== envFingerprint(undefined);
	}
	return (record?.policy ?? lane.backendPolicy) !== 'off';
}

/** A request the user settled, which the agent that made it may still read. */
function isSettledRequest(request: LaneDeviceRequest): boolean {
	return request.status === 'fulfilled' || request.status === 'dismissed';
}

function isPhone(device: SimulatorDevice): boolean {
	return /iphone/i.test(device.deviceTypeIdentifier ?? device.name);
}

/** `com.apple.CoreSimulator.SimRuntime.iOS-26-0` reads as 26.00; unknown is 0. */
function runtimeVersion(device: SimulatorDevice): number {
	const match = /-(\d+)-(\d+)$/.exec(device.runtimeIdentifier);
	return match ? Number(match[1]) + Number(match[2]) / 100 : 0;
}

/** Resolves once `promise` settles either way; rejects if `signal` aborts first. */
function whenSettled(
	promise: Promise<unknown>,
	signal: AbortSignal
): Promise<void> {
	return new Promise((resolve, reject) => {
		const onAbort = () => reject(new Error('Lane operation cancelled.'));
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener('abort', onAbort, { once: true });
		const done = () => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		};
		promise.then(done, done);
	});
}

/**
 * Waits `ms`, rejecting if `signal` aborts during the wait. A signal that is
 * already aborted does not cut the wait short; a caller that must stop checks
 * `aborted` itself.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return wait(ms, undefined, {
		signal: signal?.aborted ? undefined : signal,
	}).catch(() => {
		throw new Error('Lane operation cancelled.');
	});
}

/**
 * Owns lane leases and the lifecycle around them: validate the worktree,
 * refuse to steal a device or port, boot the Simulator through the shared
 * mutation pipeline, optionally slim it, start a detached Metro, wait for it
 * to answer, and send the dev client a launch URL that points at exactly
 * that Metro.
 *
 * Slimming rides along but never bypasses its gates. A lane start may name a
 * SimSlim profile; the desktop applies it before Metro starts, and the SimSlim
 * service checks the experimental setting, the device's compatibility tuple,
 * who holds the device (the lane's agent is the requester), and the helper's
 * signed-parent authorization. A refused slim is recorded as `skipped` with
 * the reason and the lane starts anyway, so an agent is never blocked on a
 * slim it cannot get.
 *
 * Concurrent starts never share a device or a port. Starts for one app
 * directory run one at a time, and a start holds an in-memory reservation of
 * its app directory, Simulator, and port from its first step until its lane
 * is stored, which other starts check alongside the stored lanes.
 *
 * A lane may get its worktree's local backend through the backend port. The
 * ensure runs while the Simulator boots and slims; Metro waits for it at most
 * LANE_BACKEND_DEFAULT_WAIT_MS more and then gets only the public values the
 * port maps (URL, publishable key). A backend that is late attaches later:
 * Metro starts without those names, the dev-client launch waits, and the
 * attach restarts Metro with them and launches. `auto` never fails a lane
 * over its backend. `required` fails the start before Metro spawns when the
 * backend cannot serve the lane, and stops the lane's Metro when a late
 * attach fails. What the lane knows about its backend lives in memory and on
 * the wire only.
 */
export class LaneService {
	readonly #store: LaneStore;
	readonly #simulator: LaneSimulatorPort;
	readonly #slimming: LaneSlimmingPort | undefined;
	readonly #mutationCoordinator: SimulatorMutationCoordinatorPort | undefined;
	readonly #holds: (() => ReadonlyMap<string, DeviceHold>) | undefined;
	readonly #deviceAccess: LaneDeviceAccessPort | undefined;
	readonly #metro: MetroSupervisorPort;
	readonly #worktrees: WorktreeInspectorPort;
	readonly #environments: readonly LaneEnvironment[];
	readonly #maxWorkers: number;
	readonly #backends: LaneBackendPort | undefined;
	readonly #now: () => number;
	readonly #listeners = new Set<LaneListener>();
	/** The worktrees' Supabase projects as last published. */
	#publishedBackendsKey = '';
	readonly #deviceRequests = new Map<string, LaneDeviceRequest>();
	readonly #reservations = new Set<LaneReservation>();
	/**
	 * The last start, Metro restart, or late attach queued for each app
	 * directory, settled or not.
	 */
	readonly #startsByApp = new Map<string, Promise<void>>();
	/** Each lane's local backend, by lane id. */
	readonly #backendRecords = new Map<string, LaneBackendRecord>();
	/** Aborted by stop(): work the lanes do on their own ends with it. */
	readonly #lifecycle = new AbortController();
	#worktreeCache: LaneWorktree[] = [];
	#revision = 0;
	#updatedAt: number;
	#error: string | undefined;
	#reconcileTimer: NodeJS.Timeout | undefined;
	#refreshPromise: Promise<LaneState> | undefined;
	#logsPrunedAt: number | undefined;
	#stopped = false;

	constructor({
		store,
		simulator,
		slimming,
		mutationCoordinator,
		metro = metroSupervisor,
		worktrees = worktreeInspector,
		environments = DEFAULT_LANE_ENVIRONMENTS,
		metroMaxWorkers = 2,
		backends,
		holds,
		deviceAccess,
		now = Date.now,
	}: {
		store: LaneStore;
		simulator: LaneSimulatorPort;
		/** Both must be given for a lane to slim; neither means "report only". */
		slimming?: LaneSlimmingPort;
		mutationCoordinator?: SimulatorMutationCoordinatorPort;
		metro?: MetroSupervisorPort;
		worktrees?: WorktreeInspectorPort;
		environments?: readonly LaneEnvironment[];
		metroMaxWorkers?: number;
		/**
		 * The worktree's own local backend. Without it a lane has none: `auto`
		 * is recorded as skipped and `required` is refused before boot. Its
		 * values reach only Metro's spawn env.
		 */
		backends?: LaneBackendPort;
		/**
		 * Who holds each Simulator, from the agent service. When set, reconcile
		 * releases a lane whose owning agent has been gone past the grace
		 * period, so devices return to the pool without anyone's cooperation.
		 */
		holds?: () => ReadonlyMap<string, DeviceHold>;
		/**
		 * Who may drive a Simulator, from the agent service. When set, a lane
		 * up resumes the app's existing lane only for a requester its holder
		 * lets in, so one session's lane up never restarts another session's
		 * Metro or relaunches its dev client.
		 */
		deviceAccess?: LaneDeviceAccessPort;
		now?: () => number;
	}) {
		this.#store = store;
		this.#simulator = simulator;
		this.#slimming = slimming;
		this.#mutationCoordinator = mutationCoordinator;
		this.#metro = metro;
		this.#worktrees = worktrees;
		this.#environments = environments;
		this.#maxWorkers = metroMaxWorkers;
		this.#backends = backends;
		this.#holds = holds;
		this.#deviceAccess = deviceAccess;
		this.#now = now;
		this.#updatedAt = now();
	}

	async start(): Promise<void> {
		await this.#store.start();
		await this.#reconcile();
		await this.refresh().catch(() => undefined);
		for (const lane of this.#store.lanes()) {
			if (
				(lane.backendPolicy === 'auto' || lane.backendPolicy === 'required') &&
				this.#isMetroRunning(lane)
			) {
				void this.#serialize(
					laneAppDirectory(lane),
					this.#lifecycle.signal,
					() => this.#restoreBackend(lane.id)
				).catch(() => undefined);
			}
		}
		this.#reconcileTimer = setInterval(() => {
			void this.#reconcile();
		}, RECONCILE_INTERVAL_MS);
		this.#reconcileTimer.unref();
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		this.#lifecycle.abort();
		if (this.#reconcileTimer) clearInterval(this.#reconcileTimer);
		// Metro processes are detached on purpose; they keep serving the agents
		// that started them after the desktop app quits.
	}

	getState = (): LaneState => {
		const lanes = this.#store.lanes();
		const laneByWorktree = new Map(
			lanes.map((lane) => [lane.worktreePath, lane.id])
		);
		return laneStateSchema.parse({
			revision: this.#revision,
			updatedAt: this.#updatedAt,
			environments: this.#environments,
			lanes: lanes.map((lane) => this.#view(lane)),
			worktrees: this.#worktreeCache.map((worktree) => {
				const supabase = this.#describeWorktree(worktree.path);
				return {
					...worktree,
					...(laneByWorktree.has(worktree.path)
						? { laneId: laneByWorktree.get(worktree.path) }
						: {}),
					...(supabase ? { supabase } : {}),
				};
			}),
			repositories: this.#store.repositories(),
			deviceRequests: [...this.#deviceRequests.values()],
			...(this.#error ? { error: this.#error } : {}),
		});
	};

	subscribe(listener: LaneListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/**
	 * Every lane that holds a Simulator, for the agent service: each stored
	 * lane, then each start that has reserved its device but not stored its
	 * lane yet (`starting`). Counting the starts is what keeps a claim off a
	 * device during its boot, rather than the lane overriding the claim once
	 * it is stored.
	 */
	holdingLanes(): {
		id: string;
		simulatorUdid: string;
		worktreePath: string;
		agent?: Pick<LaneAgent, 'kind' | 'sessionId'> | undefined;
		metro: Lane['metro'];
		startedAt: number;
		starting?: true;
	}[] {
		return [
			...this.#store.lanes().map((lane) => ({
				id: lane.id,
				simulatorUdid: lane.simulatorUdid,
				worktreePath: lane.worktreePath,
				agent: lane.agent,
				metro: lane.metro,
				startedAt: lane.startedAt,
			})),
			...[...this.#reservations].flatMap(
				({ laneId, simulatorUdid, worktreePath, agent, startedAt }) =>
					laneId !== undefined &&
					simulatorUdid !== undefined &&
					worktreePath !== undefined &&
					startedAt !== undefined
						? [
								{
									id: laneId,
									simulatorUdid,
									worktreePath,
									agent,
									metro: 'starting' as const,
									startedAt,
									starting: true as const,
								},
							]
						: []
			),
		];
	}

	/**
	 * The backend's view of the worktrees changed: publish again, but only
	 * when what the start form shows actually moved.
	 */
	backendsChanged(): void {
		const key = this.#worktreeBackendsKey();
		if (key === this.#publishedBackendsKey) return;
		this.#touch();
	}

	#describeWorktree(worktreePath: string): LaneWorktreeSupabase | undefined {
		try {
			const described = this.#backends?.describeWorktree?.(worktreePath);
			return described &&
				laneWorktreeSupabaseSchema.safeParse(described).success
				? described
				: undefined;
		} catch {
			// The start form falls back to the Supabase state's own rows.
			return undefined;
		}
	}

	#worktreeBackendsKey(): string {
		return JSON.stringify(
			this.#worktreeCache.map((worktree) => [
				worktree.path,
				this.#describeWorktree(worktree.path) ?? null,
			])
		);
	}

	/**
	 * Lists the tracked repositories' worktrees again. Agents poll this, so
	 * each dirty flag may be reused for a short while; the operator's refresh
	 * (`lane.refresh`) asks git again.
	 */
	refresh(): Promise<LaneState> {
		if (!this.#refreshPromise) {
			this.#refreshPromise = this.#refreshWorktrees().finally(() => {
				this.#refreshPromise = undefined;
			});
		}
		return this.#refreshPromise;
	}

	async runOperation(
		value: LaneOperation,
		signal: AbortSignal = new AbortController().signal
	): Promise<LaneOperationReceipt> {
		const operation = laneOperationSchema.parse(value);
		const base = { actionId: operation.actionId, kind: operation.kind };
		try {
			if (this.#stopped) throw new Error('Lanes are shutting down.');
			switch (operation.kind) {
				case 'lane.start': {
					const outcome = await this.#startLane(operation, signal);
					return laneOperationReceiptSchema.parse({
						...base,
						completed: true,
						...outcome,
						...(outcome.lane?.backend ? { backend: outcome.lane.backend } : {}),
						state: this.getState(),
					});
				}
				case 'lane.provide-device': {
					const outcome = await this.provideDevice(operation, signal);
					return laneOperationReceiptSchema.parse({
						...base,
						completed: true,
						...outcome,
						...(outcome.lane?.backend ? { backend: outcome.lane.backend } : {}),
						state: this.getState(),
					});
				}
				case 'lane.launch': {
					const lane = await this.launchLane(
						operation.laneId,
						operation.url,
						operation.agent,
						signal
					);
					return laneOperationReceiptSchema.parse({
						...base,
						completed: true,
						lane: this.#view(lane),
						state: this.getState(),
					});
				}
				case 'lane.stop': {
					await this.stopLane(operation.laneId);
					return laneOperationReceiptSchema.parse({
						...base,
						completed: true,
						state: this.getState(),
					});
				}
				case 'lane.log': {
					const lane = this.#requireLane(operation.laneId);
					// The tail is raw Metro output, app console logs included, so it
					// leaves main redacted, and cut back to size because redaction
					// can lengthen it.
					const log = redactDiagnosticText(
						await this.#metro.readLogTail(lane.logPath, operation.maxCharacters)
					).slice(-operation.maxCharacters);
					return laneOperationReceiptSchema.parse({
						...base,
						completed: true,
						lane: this.#view(lane),
						log,
					});
				}
				case 'lane.refresh': {
					await this.#reconcile();
					return laneOperationReceiptSchema.parse({
						...base,
						completed: true,
						state: await this.#refreshWorktrees({ fresh: true }),
					});
				}
				case 'lane.remove-repository': {
					await this.#store.removeRepository(operation.repositoryRoot);
					return laneOperationReceiptSchema.parse({
						...base,
						completed: true,
						state: await this.refresh(),
					});
				}
				case 'lane.add-repository':
					throw new Error(
						'Repository selection must be resolved by the IPC layer before reaching the lane service.'
					);
			}
		} catch (error) {
			return laneOperationReceiptSchema.parse({
				...base,
				completed: false,
				error: safeErrorText(error),
				...(error instanceof LaneBackendError
					? { backend: error.summary }
					: {}),
			});
		}
	}

	async addRepository(root: string): Promise<LaneState> {
		const repositoryRoot = await this.#worktrees.repositoryRoot(root);
		await this.#store.addRepository(repositoryRoot);
		return this.refresh();
	}

	/**
	 * Lane up is single-flight per app directory: a start for an app another
	 * start is still working on waits for that one to settle, then finds its
	 * lane (and resumes it) or its failure, so one app never gets two lanes.
	 * Starts for different apps run side by side and keep apart through their
	 * reservations. `held` is a reservation the caller took earlier (a device
	 * the user chose for a parked request), which this start takes over.
	 */
	async #startLane(
		input: LaneStartInput,
		signal: AbortSignal,
		held?: LaneReservation
	): Promise<LaneStartOutcome> {
		// Whichever checkout contains it, the requested directory is the app
		// directory (the checkout itself, or the Expo app inside it), so it
		// keys the start before anything is looked up.
		const appDirectory = path.resolve(input.worktreePath);
		return this.#serialize(appDirectory, signal, async () => {
			const reservation = held ?? { appDirectory };
			this.#reservations.add(reservation);
			try {
				return await this.#startReserved(input, reservation, signal);
			} finally {
				this.#reservations.delete(reservation);
			}
		});
	}

	/**
	 * Runs `task` once everything queued before it for `appDirectory` has
	 * settled: starts, Metro restarts, and late attaches for one app never
	 * interleave. The next task for the app waits for this one and all
	 * before it, even when this one gives up waiting because `signal` fired.
	 */
	async #serialize<T>(
		appDirectory: string,
		signal: AbortSignal,
		task: () => Promise<T>
	): Promise<T> {
		const previous = this.#startsByApp.get(appDirectory);
		const run = (async () => {
			if (previous) await whenSettled(previous, signal);
			return task();
		})();
		const tail = Promise.allSettled([previous, run]).then(() => undefined);
		this.#startsByApp.set(appDirectory, tail);
		try {
			return await run;
		} finally {
			if (this.#startsByApp.get(appDirectory) === tail) {
				this.#startsByApp.delete(appDirectory);
			}
		}
	}

	async #startReserved(
		input: LaneStartInput,
		reservation: LaneReservation,
		signal: AbortSignal
	): Promise<LaneStartOutcome> {
		const requestedPath = path.resolve(input.worktreePath);
		const environment = this.#environments.find(
			(candidate) => candidate.id === input.environment
		);
		if (!environment) {
			throw new Error(`Unknown lane environment "${input.environment}".`);
		}

		// The agent passes wherever it is working. Resolve the checkout that
		// contains it: that is the lane's worktree, and the requested directory
		// (if deeper) is the Expo app inside a monorepo.
		const repositoryRoot = await this.#worktrees.repositoryRoot(requestedPath);
		const worktrees = await this.#worktrees.listWorktrees(repositoryRoot);
		const worktree = worktrees
			.map((candidate) => ({
				...candidate,
				path: path.resolve(candidate.path),
			}))
			.filter(
				(candidate) =>
					requestedPath === candidate.path ||
					requestedPath.startsWith(`${candidate.path}${path.sep}`)
			)
			.sort((left, right) => right.path.length - left.path.length)[0];
		if (!worktree) {
			throw new Error(
				`${requestedPath} is not inside a worktree of ${repositoryRoot}.`
			);
		}
		const worktreePath = worktree.path;
		const appPath = requestedPath === worktreePath ? undefined : requestedPath;
		// Starting the lane that already exists for this app on this Simulator is
		// idempotent: agents retry `lane up` after an interruption, and a second
		// attempt should land them in the lane rather than at a conflict they
		// cannot resolve. A lane on another Simulator, or another app's lane on
		// this Simulator, is still a conflict.
		const candidateApp = laneAppDirectory({
			worktreePath,
			...(appPath ? { appPath } : {}),
		});
		// Without a named Simulator, the app's existing lane on any device is the
		// lane the agent means.
		const existing = this.#store
			.lanes()
			.find(
				(lane) =>
					laneAppDirectory(lane) === candidateApp &&
					(input.simulatorUdid === undefined ||
						lane.simulatorUdid.toUpperCase() ===
							input.simulatorUdid.toUpperCase())
			);
		if (existing) {
			// The router checks the named Simulator, or the device of the app's
			// existing lane, before anything starts. That lane may have been
			// created since by a start queued ahead of this one, possibly on
			// another session's device, so the check is made here too, in turn.
			const access = this.#deviceAccess?.(existing.simulatorUdid, input.agent);
			if (access && !access.allowed) throw new Error(access.reason);
			const resumed = await this.#resumeLane(
				existing,
				input,
				{ environment, branch: worktree.branch },
				reservation,
				signal
			);
			return { lane: this.#view(resumed) };
		}
		await this.#store.addRepository(repositoryRoot);

		// From the inventory to the reservation there is no await: the device
		// is picked, checked, and reserved before any other start can look.
		const inventory = await this.#simulator.refresh();
		const others = this.#otherReservations(reservation);
		const simulatorUdid =
			input.simulatorUdid ?? this.#pickFreeDevice(inventory.devices, others);
		if (!simulatorUdid) {
			return {
				deviceRequest: this.#parkDeviceRequest(input, {
					worktreePath,
					...(appPath ? { appPath } : {}),
					branch: worktree.branch,
					message: this.#noFreeDeviceReason(inventory.devices, others),
				}),
			};
		}
		const conflict = findLaneConflict(
			this.#store.lanes(),
			{
				worktreePath,
				...(appPath ? { appPath } : {}),
				simulatorUdid,
			},
			others
		);
		if (conflict) throw new Error(conflict);

		const device = inventory.devices.find(
			(candidate) =>
				candidate.udid.toUpperCase() === simulatorUdid.toUpperCase()
		);
		if (!device?.isAvailable) {
			throw new Error(
				'The Simulator is not available in the current inventory.'
			);
		}
		// The router checked a named device before this start began, and a
		// claim may have landed since. Checked again here, with nothing awaited
		// before the reservation, which from then on holds the device for this
		// start in the agent service's eyes (holdingLanes).
		this.#assertDeviceAccess(device.udid, input.agent);
		const id = this.#store.newLaneId();
		reservation.simulatorUdid = device.udid;
		reservation.laneId = id;
		reservation.worktreePath = worktreePath;
		reservation.startedAt = this.#now();
		if (input.agent) {
			reservation.agent = {
				kind: input.agent.kind,
				sessionId: input.agent.sessionId,
			};
		}

		const port = await allocateLanePort({
			environment,
			lanes: this.#store.lanes(),
			isPortFree: this.#metro.isPortFree,
			claim: (candidate) => this.#claimPort(reservation, candidate),
			...(input.preferredPort !== undefined
				? { preferredPort: input.preferredPort }
				: {}),
		});
		const identity = await this.#worktrees.readExpoIdentity(
			appPath ?? worktreePath
		);
		// Validate the slim request before anything is booted or spawned, so a
		// typo in a profile id fails fast instead of after a 20s boot.
		const slimRequest = input.slimProfileId
			? this.#slimRequest(input.slimProfileId)
			: undefined;
		// Likewise a backend this lane cannot have.
		const backendPolicy = this.#backendPolicy(input.backend, environment);
		const logPath = this.#store.logPathFor(id);
		const startedAt = this.#now();
		const agent = this.#agentWithTimestamp(input.agent);
		const target = {
			id,
			worktreePath,
			...(appPath ? { appPath } : {}),
			branch: worktree.branch,
			simulatorUdid: device.udid,
			environment: environment.id,
			port,
		};

		// The backend starts now and comes up while the Simulator boots and
		// slims; nothing below waits for it until Metro is due.
		const pending = this.#beginBackend(target, backendPolicy, input.agent);
		let lane: Lane;
		let decision: BackendDecision | undefined;
		let metroPid: number | undefined;
		try {
			// Boot first: a lane whose device cannot boot should not leave a
			// Metro running for nothing.
			if (device.state !== 'booted') {
				await this.#runSimulatorAction(
					{
						actionId: `lane-boot-${randomUUID()}`,
						kind: 'device.boot',
						udid: device.udid,
					},
					signal
				);
			}

			// Slim before Metro so the dev client's first launch lands on a device
			// that already has its services trimmed. Without approval the lane is
			// parked in needs-approval and everything else proceeds.
			let slim: LaneSlim | undefined;
			if (slimRequest) {
				slim = await this.#applySlim(
					device.udid,
					slimRequest,
					input.agent,
					signal
				);
			}

			// A `required` backend that cannot serve the lane fails it here,
			// before anything is spawned.
			decision = pending
				? await this.#decideBackend(pending, environment, signal)
				: undefined;
			metroPid = await this.#spawnMetro(
				{ ...target, logPath },
				environment,
				decision?.env
			);
			lane = {
				...target,
				backendPolicy,
				backendEnvHash: envFingerprint(decision?.env),
				metroPid,
				metro: 'starting',
				logPath,
				...(identity.bundleIdentifier
					? { bundleIdentifier: identity.bundleIdentifier }
					: {}),
				...(identity.scheme ? { scheme: identity.scheme } : {}),
				startedAt,
				...(agent ? { agent } : {}),
				...(slim ? { slim } : {}),
			};
			if (decision) {
				// Recorded before the lane is stored, so its first broadcast says
				// where its backend stands.
				const record = this.#recordBackend(id, backendPolicy, decision.summary);
				record.env = decision.env;
				record.deferredLaunch = input.launch && decision.late !== undefined;
			}
			// The reservation held the device for this start, but a claim that
			// got in anyway (as one can once an abandoned start's grace period
			// runs out) is never overridden: the start fails instead. Nothing is
			// awaited between this check and the store taking the lane.
			this.#assertDeviceAccess(device.udid, input.agent);
			await this.#store.upsert(lane);
		} catch (error) {
			// The lane never came to exist, so the backend lets go of it: now,
			// and again once the ensure settles in case it took the hold late.
			this.#releaseBackend(id);
			void pending?.answer.then(() => this.#releaseBackend(id));
			// Nor does its Metro have anyone to serve; left running it would
			// keep the port, and every retry would leave another.
			if (metroPid !== undefined) {
				await this.#discardMetro(id, metroPid, target);
			}
			throw error;
		}
		// The stored lane holds the app, the device, and the port from here.
		this.#reservations.delete(reservation);
		this.#touch();
		// The repository may be new to the store; make its worktrees visible
		// without waiting for the next explicit refresh.
		await this.refresh().catch(() => undefined);

		const record = this.#backendRecords.get(id);
		if (decision?.late && record) {
			this.#awaitLateAttach(lane, record.generation, decision.late);
		}
		if (input.launch && !record?.deferredLaunch) {
			lane = await this.launchLane(id, undefined, input.agent, signal);
		}
		return { lane: this.#view(lane) };
	}

	/** Refuses a device someone other than `agent` holds (see LaneDeviceAccessPort). */
	#assertDeviceAccess(
		simulatorUdid: string,
		agent: Pick<LaneAgent, 'kind' | 'sessionId'> | undefined
	): void {
		const access = this.#deviceAccess?.(simulatorUdid, agent);
		if (access && !access.allowed) throw new Error(access.reason);
	}

	/**
	 * Stops the Metro a start spawned for a lane that never came to be. The
	 * stop proves the PID is that Metro first and otherwise leaves it alone.
	 * A store write that failed after taking the lane leaves it in memory, so
	 * it goes too.
	 */
	async #discardMetro(
		laneId: string,
		metroPid: number,
		lane: Pick<Lane, 'worktreePath' | 'appPath' | 'port'>
	): Promise<void> {
		if (this.#store.get(laneId)) {
			await this.#store.remove(laneId).catch(() => undefined);
		}
		await this.#metro
			.stop(metroPid, lane.port, laneAppDirectory(lane))
			.catch(() => undefined);
	}

	/**
	 * The free Simulator a lane gets when the agent named none: nobody's lane,
	 * no other start's reservation, nobody's live claim, available in the
	 * inventory. iPhones first (the dev client is a phone app), booted before
	 * shut down so the lane starts fast, then the newest runtime, then by name
	 * so the choice is stable.
	 */
	#pickFreeDevice(
		devices: readonly SimulatorDevice[],
		others: readonly LaneReservation[]
	): string | undefined {
		const laneUdids = this.#takenUdids(others);
		const holds = this.#holds?.() ?? new Map<string, DeviceHold>();
		const candidates = devices.filter(
			(device) =>
				device.isAvailable && !laneUdids.has(device.udid.toUpperCase())
		);
		const free = new Set(
			freeDevices(
				candidates.map((device) => device.udid),
				holds,
				this.#now()
			).map((udid) => udid.toUpperCase())
		);
		return candidates
			.filter((device) => free.has(device.udid.toUpperCase()))
			.sort(
				(left, right) =>
					Number(isPhone(right)) - Number(isPhone(left)) ||
					Number(right.state === 'booted') - Number(left.state === 'booted') ||
					runtimeVersion(right) - runtimeVersion(left) ||
					left.name.localeCompare(right.name)
			)[0]?.udid;
	}

	#noFreeDeviceReason(
		devices: readonly SimulatorDevice[],
		others: readonly LaneReservation[]
	): string {
		const available = devices.filter((device) => device.isAvailable);
		if (available.length === 0) {
			return 'No Simulator is available in the current inventory.';
		}
		// A device another start is taking counts as its lane's already.
		const laneUdids = this.#takenUdids(others);
		const holds = this.#holds?.();
		let byLanes = 0;
		let bySessions = 0;
		for (const device of available) {
			const udid = device.udid.toUpperCase();
			if (laneUdids.has(udid)) byLanes += 1;
			else if (holds?.get(udid)) bySessions += 1;
		}
		return `All ${available.length} available Simulators are in use: ${byLanes} by lanes, ${bySessions} claimed by other sessions.`;
	}

	#otherReservations(reservation: LaneReservation): LaneReservation[] {
		return [...this.#reservations].filter((other) => other !== reservation);
	}

	/** Upper-cased UDIDs a stored lane or another in-flight start has. */
	#takenUdids(others: readonly LaneReservation[]): Set<string> {
		return new Set([
			...this.#store.lanes().map((lane) => lane.simulatorUdid.toUpperCase()),
			...others.flatMap((other) =>
				other.simulatorUdid ? [other.simulatorUdid.toUpperCase()] : []
			),
		]);
	}

	/**
	 * Who already has `port`: a live lane other than `laneId`, or another
	 * in-flight start that claimed it. A stopped lane's port is free again.
	 */
	#portHolder(
		reservation: LaneReservation,
		port: number,
		laneId?: string
	): string | undefined {
		const lane = this.#store
			.lanes()
			.find(
				(candidate) =>
					candidate.id !== laneId &&
					candidate.metro !== 'stopped' &&
					candidate.port === port
			);
		if (lane) return `lane ${lane.id}`;
		for (const other of this.#reservations) {
			if (other !== reservation && other.port === port) {
				return `a lane starting for ${other.appDirectory}`;
			}
		}
		return undefined;
	}

	/**
	 * Takes `port` for `reservation` unless someone already has it. The check
	 * and the claim are one synchronous step, so no other start can slip in
	 * between them.
	 */
	#claimPort(reservation: LaneReservation, port: number): boolean {
		if (this.#portHolder(reservation, port)) return false;
		reservation.port = port;
		return true;
	}

	/**
	 * Records a start that is waiting on a Simulator. One request per app
	 * directory: a retry replaces its predecessor instead of stacking cards.
	 * Lane state lists at most MAX_DEVICE_REQUESTS, so a new request takes the
	 * place of the oldest settled one, and with every listed request still
	 * open the start is refused instead of parked.
	 */
	#parkDeviceRequest(
		input: LaneStartInput,
		resolved: {
			worktreePath: string;
			appPath?: string;
			branch: string;
			message: string;
		}
	): LaneDeviceRequest {
		const appDirectory = laneAppDirectory(resolved);
		for (const [id, request] of this.#deviceRequests) {
			if (
				laneAppDirectory(request) === appDirectory &&
				request.status !== 'starting'
			) {
				this.#deviceRequests.delete(id);
			}
		}
		if (!this.#makeDeviceRequestRoom()) {
			throw new Error(
				`${MAX_DEVICE_REQUESTS} lane starts are already waiting on the user for a Simulator, so this one was not added. ${resolved.message} Ask the user to settle or dismiss the waiting requests in RN Devtools, then run lane up again.`
			);
		}
		const now = this.#now();
		const request: LaneDeviceRequest = {
			id: `device-request-${randomUUID()}`,
			status: 'pending',
			requestedAt: now,
			updatedAt: now,
			message: resolved.message,
			worktreePath: resolved.worktreePath,
			...(resolved.appPath ? { appPath: resolved.appPath } : {}),
			branch: resolved.branch,
			environment: input.environment,
			...(input.preferredPort !== undefined
				? { preferredPort: input.preferredPort }
				: {}),
			launch: input.launch,
			...(input.slimProfileId ? { slimProfileId: input.slimProfileId } : {}),
			...(input.backend ? { backend: input.backend } : {}),
			...(input.agent ? { agent: input.agent } : {}),
		};
		this.#deviceRequests.set(request.id, request);
		this.#touch();
		return request;
	}

	/**
	 * Drops the oldest settled device requests until one more fits; false
	 * when every listed request is still waiting or starting.
	 */
	#makeDeviceRequestRoom(): boolean {
		while (this.#deviceRequests.size >= MAX_DEVICE_REQUESTS) {
			const oldest = [...this.#deviceRequests.values()]
				.filter(isSettledRequest)
				.sort((left, right) => left.updatedAt - right.updatedAt)[0];
			if (!oldest) return false;
			this.#deviceRequests.delete(oldest.id);
		}
		return true;
	}

	#updateDeviceRequest(
		request: LaneDeviceRequest,
		patch: Partial<Pick<LaneDeviceRequest, 'status' | 'message' | 'laneId'>>
	): LaneDeviceRequest {
		const next = { ...request, ...patch, updatedAt: this.#now() };
		this.#deviceRequests.set(next.id, next);
		this.#touch();
		return next;
	}

	/**
	 * Settles a device request from the Lanes panel. `use` starts the lane on
	 * the chosen Simulator; `clone` first clones it (the signed helper's clone
	 * path, the same one the Simulator panel uses) and starts on the copy. A
	 * start that fails leaves the request pending with the reason, so the user
	 * can pick again and the agent keeps seeing an open request.
	 */
	async provideDevice(
		input: Extract<LaneOperation, { kind: 'lane.provide-device' }>,
		signal: AbortSignal
	): Promise<LaneStartOutcome> {
		const request = this.#deviceRequests.get(input.requestId);
		if (!request) {
			throw new Error(`Device request ${input.requestId} does not exist.`);
		}
		if (request.status !== 'pending') {
			throw new Error(
				`Device request ${input.requestId} is ${request.status}.`
			);
		}
		if (input.decision === 'dismiss') {
			return {
				deviceRequest: this.#updateDeviceRequest(request, {
					status: 'dismissed',
					message: 'Dismissed by the operator.',
				}),
			};
		}
		if (!input.simulatorUdid) {
			throw new Error(
				`Choosing to ${input.decision} a Simulator needs its UDID.`
			);
		}
		let current = this.#updateDeviceRequest(request, {
			status: 'starting',
			message:
				input.decision === 'clone'
					? 'Cloning the Simulator…'
					: 'Starting the lane…',
		});
		// Hold the device the user chose from this moment (a clone from the
		// moment it exists), so a lane up that picks its own device cannot take
		// it while the clone or the start is still running.
		const reservation: LaneReservation = {
			appDirectory: laneAppDirectory(request),
			...(input.decision === 'use'
				? { simulatorUdid: input.simulatorUdid }
				: {}),
		};
		this.#reservations.add(reservation);
		try {
			const simulatorUdid =
				input.decision === 'clone'
					? await this.#cloneDevice(
							input.simulatorUdid,
							request.branch,
							reservation,
							signal
						)
					: input.simulatorUdid;
			const outcome = await this.#startLane(
				{
					actionId: input.actionId,
					kind: 'lane.start',
					worktreePath: current.appPath ?? current.worktreePath,
					simulatorUdid,
					environment: current.environment,
					launch: current.launch,
					...(current.preferredPort !== undefined
						? { preferredPort: current.preferredPort }
						: {}),
					...(current.slimProfileId
						? { slimProfileId: current.slimProfileId }
						: {}),
					...(current.backend ? { backend: current.backend } : {}),
					...(current.agent ? { agent: current.agent } : {}),
				},
				signal,
				reservation
			);
			if (!outcome.lane) {
				throw new Error('The lane did not start on the chosen Simulator.');
			}
			current = this.#updateDeviceRequest(current, {
				status: 'fulfilled',
				message: `Started on ${simulatorUdid}.`,
				laneId: outcome.lane.id,
			});
			return { lane: outcome.lane };
		} catch (error) {
			this.#updateDeviceRequest(current, {
				status: 'pending',
				message: safeErrorText(error),
			});
			throw error;
		} finally {
			this.#reservations.delete(reservation);
		}
	}

	/**
	 * Clones a Simulator for a lane and returns the copy's UDID, reserving it
	 * for the lane the moment it shows up in the inventory.
	 */
	async #cloneDevice(
		sourceUdid: string,
		branch: string,
		reservation: LaneReservation,
		signal: AbortSignal
	): Promise<string> {
		const before = this.#simulator.getState().devices;
		const source = before.find(
			(device) => device.udid.toUpperCase() === sourceUdid.toUpperCase()
		);
		if (!source) {
			throw new Error(
				'The Simulator to clone is not in the current inventory.'
			);
		}
		const taken = new Set(before.map((device) => device.name));
		const base = `${source.name} · ${branch}`.slice(0, 100);
		let name = base;
		for (let n = 2; taken.has(name); n += 1) name = `${base} ${n}`;
		await this.#runSimulatorAction(
			{
				actionId: `lane-clone-${randomUUID()}`,
				kind: 'device.clone',
				udid: source.udid,
				name,
			},
			signal
		);
		const clone = (await this.#simulator.refresh()).devices.find(
			(device) =>
				device.name === name &&
				!before.some((known) => known.udid === device.udid)
		);
		if (!clone) {
			throw new Error(`The clone "${name}" did not appear in the inventory.`);
		}
		reservation.simulatorUdid = clone.udid;
		return clone.udid;
	}

	/**
	 * Brings an existing lane back to running for a repeated `lane up`: if its
	 * Metro is gone, start a fresh one on the lane's own port; then launch the
	 * dev client when asked. The lane keeps its id, port, and log.
	 *
	 * The backend is asked again each time, for the worktree's branch as it is
	 * now. A Metro that is gone respawns with whatever the backend serves
	 * within the wait. A running one restarts only when the backend's values
	 * changed (its API URL moved, say) or when what it was spawned with is
	 * unknown, as after a desktop restart. A backend still starting attaches
	 * late, and the launch waits for it unless Metro already has values.
	 */
	async #resumeLane(
		existing: Lane,
		input: Extract<LaneOperation, { kind: 'lane.start' }>,
		{ environment, branch }: { environment: LaneEnvironment; branch: string },
		reservation: LaneReservation,
		signal: AbortSignal
	): Promise<Lane> {
		let lane = existing;
		// Only the lane's own Metro counts as alive: a packager answering on the
		// port may be another worktree's, which is no reason to skip a respawn.
		const metroAlive = this.#isMetroRunning(lane);
		if (!metroAlive) {
			// A stopped lane's port reads as free to other starts. Claim it before
			// the first await, and never take it back from a lane that got it
			// meanwhile.
			const holder = this.#portHolder(reservation, lane.port, lane.id);
			if (holder) {
				throw new Error(
					`Port ${lane.port} now belongs to ${holder}. Stop lane ${lane.id} and start it again to lease a new port.`
				);
			}
			reservation.port = lane.port;
		}
		const previous = this.#backendRecords.get(lane.id);
		const policy = this.#backendPolicy(
			input.backend ?? previous?.policy ?? lane.backendPolicy,
			environment
		);
		const pending = this.#beginBackend({ ...lane, branch }, policy, lane.agent);
		let decision: BackendDecision | undefined;
		try {
			decision = pending
				? await this.#decideBackend(pending, environment, signal)
				: undefined;
		} catch (error) {
			// A required backend that cannot serve the lane fails this lane up;
			// the lane itself keeps running as it was.
			if (error instanceof LaneBackendError) {
				this.#recordBackend(lane.id, policy, error.summary);
				this.#touch();
			}
			throw error;
		}
		const current = this.#store.get(lane.id);
		if (!current) {
			this.#releaseBackend(lane.id);
			throw new Error(
				`Lane ${lane.id} stopped while its backend was being ensured.`
			);
		}
		lane = current;
		if (!decision && previous) {
			// Turned off on this lane up: the backend lets go of the lane, and a
			// running Metro that has its values restarts without them.
			this.#releaseBackend(lane.id);
			if (metroAlive && metroHasBackendEnv(lane, previous)) {
				lane = await this.#respawnMetro(lane, environment, undefined);
			}
		}
		const record = decision
			? this.#recordBackend(lane.id, policy, decision.summary)
			: undefined;
		lane = { ...lane, backendPolicy: policy };
		await this.#store.upsert(lane);
		if (!metroAlive) {
			const metroPid = await this.#spawnMetro(lane, environment, decision?.env);
			try {
				// A lane stopped while its Metro spawned stays stopped, and that
				// Metro, which no lane would ever stop, goes.
				if (!this.#store.get(lane.id)) {
					throw new Error(
						`Lane ${lane.id} was stopped while its Metro started.`
					);
				}
				lane = {
					...lane,
					metroPid,
					metro: 'starting',
					backendEnvHash: envFingerprint(decision?.env),
					startedAt: this.#now(),
				};
				if (record) record.env = decision?.env;
				await this.#store.upsert(lane);
			} catch (error) {
				await this.#metro
					.stop(metroPid, lane.port, laneAppDirectory(lane))
					.catch(() => undefined);
				throw error;
			}
			this.#reservations.delete(reservation);
			this.#touch();
		} else if (record && decision?.env) {
			await this.#attachEnv(lane, environment, record, decision.env);
			lane = this.#store.get(lane.id) ?? lane;
		}
		// A launch held back by an earlier start counts as asked for.
		const wantsLaunch = input.launch || previous?.deferredLaunch === true;
		if (record) {
			record.deferredLaunch =
				wantsLaunch && decision?.late !== undefined && record.env === undefined;
			if (decision?.late) {
				this.#awaitLateAttach(lane, record.generation, decision.late);
			}
			this.#touch();
		}
		if (wantsLaunch && !record?.deferredLaunch) {
			lane = await this.launchLane(lane.id, undefined, input.agent, signal);
		}
		return lane;
	}

	/**
	 * Spawns a lane's Metro with its environment's metroEnv and the public
	 * values its backend serves.
	 */
	async #spawnMetro(
		lane: Pick<Lane, 'worktreePath' | 'appPath' | 'port' | 'logPath'>,
		environment: LaneEnvironment,
		backendEnv?: BackendEnv
	): Promise<number> {
		return this.#metro.start({
			worktreePath: laneAppDirectory(lane),
			port: lane.port,
			logPath: lane.logPath,
			maxWorkers: this.#maxWorkers,
			...(environment.metroEnv ? { metroEnv: environment.metroEnv } : {}),
			...(backendEnv && Object.keys(backendEnv).length > 0
				? { laneEnv: backendEnv }
				: {}),
		});
	}

	async launchLane(
		laneId: string,
		url: string | undefined,
		agent: Pick<LaneAgent, 'kind' | 'sessionId'> | undefined,
		signal: AbortSignal
	): Promise<Lane> {
		const lane = this.#requireLane(laneId);
		const healthy = await this.#waitForMetro(lane, signal);
		if (!healthy) {
			// The wait awaited; write onto the lane as it is now, and not at all
			// if it was stopped or got a new Metro meanwhile.
			const current = this.#store.get(laneId);
			if (current && current.metroPid === lane.metroPid) {
				await this.#store.upsert({
					...current,
					metro: this.#metroStatus(current),
				});
				this.#touch();
			}
			throw new Error(
				`Metro on port ${lane.port} did not become ready within ${LANE_METRO_HEALTH_TIMEOUT_MS / 1_000}s. Read the lane log for the bundler error.`
			);
		}
		const target =
			url !== undefined
				? laneDeepLink(lane, url)
				: lane.scheme
					? laneDevClientLaunchUrl(lane.scheme, lane.port)
					: undefined;
		if (!target) {
			throw new Error(
				'The worktree declares no URL scheme in app.json, so the dev client cannot be deep-linked. Pass --url with the full launch URL.'
			);
		}
		// Opening a scheme the Simulator has no app for fails with an opaque
		// FBSOpenApplicationServiceErrorDomain error; check first and say what to
		// build. The check only runs when the worktree told us its bundle id.
		await this.#assertDevClientInstalled(lane, signal);
		await this.#runSimulatorAction(
			{
				actionId: `lane-launch-${randomUUID()}`,
				kind: 'url.open',
				udid: lane.simulatorUdid,
				url: target,
			},
			signal
		);
		// The checks and the open awaited, and a stop or a Metro restart may
		// have run meanwhile: write onto the lane as it is now. A lane stopped
		// mid-launch stays stopped, and a Metro that replaced the one that was
		// checked keeps its PID and its own status.
		const current = this.#store.get(laneId);
		if (!current) {
			throw new Error(
				`Lane ${laneId} was stopped while its dev client opened.`
			);
		}
		// A launch never moves the hold. The lane's agent stays its holder for
		// the lane's life: its own launch refreshes when it was last seen, and a
		// launch by anyone else (another session, or an agent on an operator's
		// lane) leaves the holder as it was. Refusing non-holders is the
		// router's job; this keeps ownership intact whoever gets through.
		const holder =
			current.agent &&
			agent &&
			current.agent.kind === agent.kind &&
			current.agent.sessionId === agent.sessionId
				? this.#agentWithTimestamp(agent)
				: current.agent;
		const launched: Lane = {
			...current,
			...(current.metroPid === lane.metroPid
				? { metro: 'ready' as const }
				: {}),
			lastLaunchedAt: this.#now(),
			...(holder ? { agent: holder } : {}),
		};
		// Whoever launched, a launch held back for the backend has happened.
		const record = this.#backendRecords.get(laneId);
		if (record) record.deferredLaunch = false;
		await this.#store.upsert(launched);
		this.#touch();
		return launched;
	}

	async stopLane(laneId: string): Promise<void> {
		const lane = this.#requireLane(laneId);
		if (lane.metroPid !== undefined) {
			try {
				await this.#metro.stop(
					lane.metroPid,
					lane.port,
					laneAppDirectory(lane)
				);
			} catch (error) {
				// A PID that now names some other process proves the lane's own
				// Metro is gone, which is all a stop wants. A PID whose owner could
				// not be checked keeps the lane, as does an Expo on the lane's port
				// serving from elsewhere: it may be the lane's own Metro after its
				// worktree moved, and dropping the lane would orphan it.
				if (!(error instanceof NotLaneMetroError)) throw error;
			}
		}
		await this.#store.remove(laneId);
		// The backend lets go of the lane without anything waiting for a stop,
		// and nothing it does can keep the lane alive.
		this.#releaseBackend(laneId);
		this.#touch();
	}

	/**
	 * Restarts a lane's own Metro on its port with the lane's current backend
	 * values, for the backend port: after a stack attached late, moved its
	 * ports, or followed a branch switch, or when the operator asks. For
	 * `detach` the new Metro gets no backend values. For every other reason
	 * the backend port is asked for the lane's values again (ensureForLane
	 * with waitMs 0, which must answer from the port's own records rather than
	 * wait on the work that asked for this restart). The lane keeps its id,
	 * port, and log, the old Metro is stopped only once its PID is proven to
	 * be this lane's, and a dev client that was open relaunches against the
	 * new Metro. A launch still held back stays for launchDeferred.
	 */
	async restartMetro(
		laneId: string,
		reason: SupabaseMetroRestartReason
	): Promise<void> {
		if (this.#stopped) throw new Error('Lanes are shutting down.');
		const lane = this.#requireLane(laneId);
		const signal = this.#lifecycle.signal;
		await this.#serialize(path.resolve(laneAppDirectory(lane)), signal, () =>
			this.#restartMetroNow(laneId, reason, signal)
		);
	}

	async #restartMetroNow(
		laneId: string,
		reason: SupabaseMetroRestartReason,
		signal: AbortSignal
	): Promise<void> {
		const lane = this.#requireLane(laneId);
		if (!this.#isMetroRunning(lane)) {
			throw new Error(
				`Metro isn't running for lane ${laneId}. Run lane up to start it again.`
			);
		}
		const environment = this.#environmentFor(lane);
		const previous = this.#backendRecords.get(laneId);
		if (reason === 'detach') {
			// Nothing to take back from a Metro known to have no backend values;
			// one spawned before a desktop restart may have them.
			const hasValues = metroHasBackendEnv(lane, previous);
			if (hasValues) await this.#respawnMetro(lane, environment, undefined);
			if (previous) {
				const record = this.#recordBackend(laneId, previous.policy, {
					...backendSummary(previous.policy, 'stopped'),
					...(previous.summary.stackId
						? { stackId: previous.summary.stackId }
						: {}),
				});
				record.env = undefined;
				record.metro = hasValues ? 'restarted' : 'unchanged';
				// An auto lane's held-back launch goes ahead without the backend;
				// a required lane's waits for the backend to come back.
				if (record.deferredLaunch && record.policy !== 'required') {
					await this.#launchInBackground(laneId, record, signal);
				}
			}
			this.#touch();
			return;
		}
		const policy = previous?.policy ?? lane.backendPolicy ?? 'auto';
		if (policy === 'off') {
			const restarted = await this.#respawnMetro(lane, environment, undefined);
			if (restarted.lastLaunchedAt !== undefined) {
				await this.launchLane(laneId, undefined, undefined, signal);
			}
			return;
		}
		const decision = await this.#decideBackend(
			this.#ensureBackend(
				{ ...lane, branch: this.#currentBranch(lane) },
				policy,
				lane.agent,
				0
			),
			environment,
			signal,
			{ refuse: false }
		);
		const record = this.#recordBackend(laneId, policy, decision.summary);
		this.#touch();
		if (!decision.env) {
			// Still starting: the late attach restarts Metro once it is ready.
			if (decision.late) {
				this.#awaitLateAttach(lane, record.generation, decision.late);
				return;
			}
			throw new Error(
				`The lane's local backend is ${decision.summary.status}, so its Metro was left as it was.${decision.summary.reasonText ? ` ${decision.summary.reasonText}` : ''}`
			);
		}
		let restarted: Lane;
		try {
			restarted = await this.#respawnMetro(lane, environment, decision.env);
		} catch (error) {
			record.metro = 'needs-restart';
			record.note = backendReason(
				`Metro could not be restarted with the backend: ${safeErrorText(error)}`
			);
			this.#touch();
			throw error;
		}
		record.env = decision.env;
		record.metro = 'restarted';
		this.#touch();
		if (restarted.lastLaunchedAt !== undefined && !record.deferredLaunch) {
			await this.#launchInBackground(laneId, record, signal);
		}
	}

	/**
	 * Opens the dev client a lane start held back for its backend, if it is
	 * still held back; otherwise does nothing. The lane's own late attach
	 * launches too, and whichever comes first wins.
	 */
	async launchDeferred(laneId: string): Promise<void> {
		if (this.#stopped) throw new Error('Lanes are shutting down.');
		const lane = this.#requireLane(laneId);
		if (!this.#backendRecords.get(laneId)?.deferredLaunch) return;
		const signal = this.#lifecycle.signal;
		await this.#serialize(
			path.resolve(laneAppDirectory(lane)),
			signal,
			async () => {
				if (!this.#backendRecords.get(laneId)?.deferredLaunch) return;
				await this.launchLane(laneId, undefined, undefined, signal);
			}
		);
	}

	/**
	 * Refreshes the Metro liveness of every lane and releases abandoned ones.
	 *
	 * A lane's `agent` is the hold's owner and stays for the lane's lifetime;
	 * whether that owner is still around is the agent service's call (its
	 * session is alive or not), not a matter of recent CLI touches. When the
	 * owner has been gone for the grace period the lane is torn down, Metro
	 * stopped, and the device returns to the pool.
	 */
	async #reconcile(): Promise<void> {
		let changed = false;
		const holds = this.#holds?.();
		const now = this.#now();
		for (const [id, request] of this.#deviceRequests) {
			if (
				isSettledRequest(request) &&
				now - request.updatedAt >= DEVICE_REQUEST_TTL_MS
			) {
				this.#deviceRequests.delete(id);
				changed = true;
			}
		}
		for (const lane of this.#store.lanes()) {
			const hold = holds?.get(lane.simulatorUdid.toUpperCase());
			if (
				hold?.laneId === lane.id &&
				!hold.holderLive &&
				hold.releaseAt !== undefined &&
				now >= hold.releaseAt
			) {
				await this.stopLane(lane.id).catch(() => undefined);
				changed = true;
				continue;
			}
			const status = this.#metroStatus(lane);
			const liveStatus =
				status === 'stopped' || lane.metroPid === undefined
					? 'stopped'
					: (await this.#metro.isHealthy(lane.port, lane.metroPid))
						? 'ready'
						: 'starting';
			// The probe awaited; write back onto the lane as it is now, and not
			// at all if it was stopped or got a new Metro meanwhile.
			const current = this.#store.get(lane.id);
			if (
				current &&
				current.metroPid === lane.metroPid &&
				liveStatus !== current.metro
			) {
				await this.#store.upsert({ ...current, metro: liveStatus });
				changed = true;
			}
		}
		// Only stopLane removes lanes and it forgets their backends; this is the
		// backstop for anything that slipped past it.
		const laneIds = new Set(this.#store.lanes().map((lane) => lane.id));
		for (const laneId of this.#backendRecords.keys()) {
			if (!laneIds.has(laneId)) {
				this.#backendRecords.delete(laneId);
				changed = true;
			}
		}
		if (changed) this.#touch();
		// Logs of lanes that are gone go a week after they stop growing,
		// checked when the service starts and hourly after that.
		if (
			this.#logsPrunedAt === undefined ||
			now - this.#logsPrunedAt >= LANE_LOG_PRUNE_INTERVAL_MS
		) {
			this.#logsPrunedAt = now;
			try {
				await this.#store.pruneLogs(LANE_LOG_RETENTION_MS, now);
			} catch {
				// Best effort: a log that cannot go now goes on a later pass.
			}
		}
	}

	async #refreshWorktrees({
		fresh = false,
	}: {
		fresh?: boolean;
	} = {}): Promise<LaneState> {
		const roots = new Set(this.#store.repositories());
		for (const lane of this.#store.lanes()) {
			try {
				roots.add(await this.#worktrees.repositoryRoot(lane.worktreePath));
			} catch {
				// A lane whose worktree vanished is reported through its own entry.
			}
		}
		const worktrees: LaneWorktree[] = [];
		const errors: string[] = [];
		for (const root of roots) {
			try {
				for (const entry of await this.#worktrees.listWorktrees(root, {
					fresh,
				})) {
					worktrees.push({
						path: entry.path,
						branch: entry.branch,
						repositoryRoot: entry.repositoryRoot,
						dirty: entry.dirty,
					});
				}
			} catch (error) {
				errors.push(`${root}: ${safeErrorText(error)}`);
			}
		}
		this.#worktreeCache = worktrees
			.slice(0, 128)
			.sort((left, right) => left.path.localeCompare(right.path));
		this.#error = errors.length ? errors.join('\n').slice(0, 4_096) : undefined;
		this.#touch();
		return this.getState();
	}

	#metroStatus(lane: Lane): Lane['metro'] {
		if (
			lane.metroPid === undefined ||
			!this.#metro.isProcessRunning(lane.metroPid)
		) {
			return 'stopped';
		}
		return lane.metro === 'stopped' ? 'starting' : lane.metro;
	}

	/**
	 * Waits for the lane's own Metro to serve its port. Another packager
	 * answering there does not count, so a lane can never be reported ready,
	 * or its dev client launched, against another worktree's Metro.
	 */
	async #waitForMetro(lane: Lane, signal: AbortSignal): Promise<boolean> {
		const deadline = this.#now() + LANE_METRO_HEALTH_TIMEOUT_MS;
		while (this.#now() < deadline) {
			if (signal.aborted) throw new Error('Lane launch cancelled.');
			if (
				lane.metroPid !== undefined &&
				(await this.#metro.isHealthy(lane.port, lane.metroPid))
			) {
				return true;
			}
			if (
				lane.metroPid !== undefined &&
				!this.#metro.isProcessRunning(lane.metroPid)
			) {
				throw new Error(
					`Metro for ${lane.branch} exited before it became ready. Read the lane log for the bundler error.`
				);
			}
			await sleep(HEALTH_POLL_INTERVAL_MS, signal);
		}
		return false;
	}

	#isMetroRunning(lane: Lane): boolean {
		return (
			lane.metroPid !== undefined && this.#metro.isProcessRunning(lane.metroPid)
		);
	}

	/**
	 * The lane's worktree branch as the last worktree listing saw it; the
	 * lane's own record keeps the branch it started on.
	 */
	#currentBranch(lane: Lane): string {
		return (
			this.#worktreeCache.find(
				(worktree) => path.resolve(worktree.path) === lane.worktreePath
			)?.branch ?? lane.branch
		);
	}

	/** The lane's environment; one this build no longer lists has no metroEnv. */
	#environmentFor(lane: Lane): LaneEnvironment {
		return (
			this.#environments.find(
				(candidate) => candidate.id === lane.environment
			) ?? { id: lane.environment, portRange: [lane.port, lane.port] }
		);
	}

	/**
	 * Replaces the lane's own Metro with a fresh one on the lane's port, given
	 * `backendEnv`. The old Metro is stopped only once the supervisor proves
	 * its PID is this lane's (a refusal leaves it running and throws), and the
	 * lane stays stored the whole time, so its port stays leased.
	 */
	async #respawnMetro(
		lane: Lane,
		environment: LaneEnvironment,
		backendEnv: BackendEnv | undefined
	): Promise<Lane> {
		const pid = lane.metroPid;
		if (pid !== undefined && this.#metro.isProcessRunning(pid)) {
			await this.#metro.stop(pid, lane.port, laneAppDirectory(lane));
			await this.#waitForMetroExit(pid, lane.port);
		}
		const current = this.#store.get(lane.id);
		if (!current || current.metroPid !== pid) {
			throw new Error(
				`Lane ${lane.id} stopped or got another Metro while this one restarted.`
			);
		}
		const metroPid = await this.#spawnMetro(current, environment, backendEnv);
		// A lane stopped while its Metro spawned leaves that Metro no one to
		// serve, so it goes too.
		const latest = this.#store.get(lane.id);
		if (!latest || latest.metroPid !== pid) {
			await this.#metro
				.stop(metroPid, current.port, laneAppDirectory(current))
				.catch(() => undefined);
			throw new Error(`Lane ${lane.id} stopped while its Metro restarted.`);
		}
		const next: Lane = {
			...latest,
			metroPid,
			metro: 'starting',
			backendEnvHash: envFingerprint(backendEnv),
			startedAt: this.#now(),
		};
		await this.#store.upsert(next);
		this.#touch();
		return next;
	}

	/** Waits for a stopped Metro to exit and let go of the lane's port. */
	async #waitForMetroExit(pid: number, port: number): Promise<void> {
		const deadline = this.#now() + METRO_EXIT_TIMEOUT_MS;
		while (
			this.#metro.isProcessRunning(pid) ||
			!(await this.#metro.isPortFree(port))
		) {
			if (this.#now() >= deadline) {
				throw new Error(
					`Metro on port ${port} did not exit within ${METRO_EXIT_TIMEOUT_MS / 1_000}s of being stopped. The lane keeps its port; start it again once the port is free.`
				);
			}
			await sleep(METRO_EXIT_POLL_INTERVAL_MS, this.#lifecycle.signal);
		}
	}

	/**
	 * The backend policy a start or a resume runs with: what it asked for,
	 * else the environment's default from the backend port, else off. Without
	 * a backend port nothing can honour `required`, so it fails here, before
	 * anything boots.
	 */
	#backendPolicy(
		requested: LaneBackendPolicy | undefined,
		environment: LaneEnvironment
	): LaneBackendPolicy {
		const policy = requested ?? this.#defaultBackendPolicy(environment);
		if (policy === 'required' && !this.#backends) {
			throw new Error(
				'This desktop session has no local backends, so a lane cannot require one. Start it with backend auto or off.'
			);
		}
		return policy;
	}

	#defaultBackendPolicy(environment: LaneEnvironment): LaneBackendPolicy {
		try {
			return this.#backends?.defaultPolicy(environment.id) === 'auto'
				? 'auto'
				: 'off';
		} catch {
			return 'off';
		}
	}

	/** Restore only the backend hold and summary; the detached Metro stays untouched. */
	async #restoreBackend(laneId: string): Promise<void> {
		const lane = this.#store.get(laneId);
		if (
			this.#stopped ||
			!lane ||
			!this.#isMetroRunning(lane) ||
			(lane.backendPolicy !== 'auto' && lane.backendPolicy !== 'required')
		) {
			return;
		}
		const policy = lane.backendPolicy;
		const record = this.#recordBackend(
			lane.id,
			policy,
			backendSummary(policy, 'starting')
		);
		this.#touch();
		const pending = this.#ensureBackend(
			{ ...lane, branch: this.#currentBranch(lane) },
			policy,
			lane.agent,
			0
		);
		const apply = (answer: LaneBackendLateAttach): boolean => {
			if (this.#stopped) return false;
			const current = this.#store.get(lane.id);
			if (!current || !this.#isMetroRunning(current)) {
				this.#releaseBackend(lane.id);
				return false;
			}
			if (
				current.metroPid !== lane.metroPid ||
				this.#backendRecords.get(lane.id)?.generation !== record.generation
			) {
				return false;
			}
			const read = this.#readBackend(
				policy,
				this.#environmentFor(current),
				answer.summary,
				answer.laneEnv
			);
			record.summary = read.summary;
			if (read.env) {
				if (current.backendEnvHash === envFingerprint(read.env)) {
					record.env = read.env;
					record.metro = 'unchanged';
				} else {
					record.metro = 'needs-restart';
					record.note =
						"The restored Metro's backend values changed or could not be verified. Run lane up to apply the current backend.";
				}
			}
			this.#touch();
			return true;
		};
		const answer = await pending.answer;
		if (apply(answer) && answer.lateAttach) {
			void answer.lateAttach
				.catch(
					(error: unknown): LaneBackendLateAttach => ({
						summary: failedBackend(policy, safeErrorText(error)),
					})
				)
				.then((late) =>
					this.#serialize(
						laneAppDirectory(lane),
						this.#lifecycle.signal,
						async () => {
							apply(late);
						}
					)
				)
				.catch(() => undefined);
		}
	}

	/** Starts asking the backend port for a lane, unless its policy is off. */
	#beginBackend(
		target: Pick<
			Lane,
			'id' | 'worktreePath' | 'appPath' | 'branch' | 'environment'
		>,
		policy: LaneBackendPolicy,
		agent: Pick<LaneAgent, 'kind' | 'sessionId'> | undefined
	): PendingBackend | undefined {
		return policy === 'off'
			? undefined
			: this.#ensureBackend(target, policy, agent);
	}

	/**
	 * Asks the backend port to ensure a lane's backend, starting now. Its
	 * answer never rejects: a port that throws reads as a failed backend.
	 * Without a port the backend is skipped (`required` never gets here).
	 *
	 * The ensure is detached from the request that asked: a cancelled lane up
	 * stops waiting and lets go through detachLane, while a stack already on
	 * its way keeps starting for the next lane up to attach.
	 */
	#ensureBackend(
		target: Pick<
			Lane,
			'id' | 'worktreePath' | 'appPath' | 'branch' | 'environment'
		>,
		policy: 'auto' | 'required',
		agent: Pick<LaneAgent, 'kind' | 'sessionId'> | undefined,
		waitMs: number = LANE_BACKEND_DEFAULT_WAIT_MS
	): PendingBackend {
		const port = this.#backends;
		if (!port) {
			return {
				policy,
				answer: Promise.resolve({
					summary: backendSummary(policy, 'skipped', {
						reason: 'disabled',
						reasonText:
							'Local backends are not available in this desktop session.',
					}),
				}),
			};
		}
		const input: LaneBackendEnsureInput = {
			laneId: target.id,
			worktreePath: target.worktreePath,
			...(target.appPath ? { appPath: target.appPath } : {}),
			branch: target.branch,
			environmentId: target.environment,
			policy,
			...(agent
				? { agent: { kind: agent.kind, sessionId: agent.sessionId } }
				: {}),
			waitMs,
		};
		const failed = (error: unknown): LaneBackendEnsureResult => ({
			summary: failedBackend(
				policy,
				`The local backend could not be ensured: ${safeErrorText(error)}`
			),
		});
		let answer: Promise<LaneBackendEnsureResult>;
		try {
			answer = port.ensureForLane(input, this.#lifecycle.signal).catch(failed);
		} catch (error) {
			answer = Promise.resolve(failed(error));
		}
		return { policy, answer };
	}

	/**
	 * Waits for the backend at most LANE_BACKEND_DEFAULT_WAIT_MS past now,
	 * the moment a Metro is due, and decides what that Metro gets. Unless
	 * `refuse` is off, a `required` backend that cannot serve the lane and is
	 * not still starting throws a LaneBackendError.
	 */
	async #decideBackend(
		pending: PendingBackend,
		environment: LaneEnvironment,
		signal: AbortSignal,
		{ refuse = true }: { refuse?: boolean } = {}
	): Promise<BackendDecision> {
		const answer = await this.#untilDeadline(
			pending.answer,
			this.#now() + LANE_BACKEND_DEFAULT_WAIT_MS,
			signal
		);
		let decision: BackendDecision;
		if (!answer) {
			// Not ready in time: Metro goes without the backend's names, and
			// the answer, whenever it comes, attaches it.
			decision = {
				summary: backendSummary(pending.policy, 'starting'),
				late: pending.answer.then((late) => this.#lateAnswer(late)),
			};
		} else {
			const read = this.#readBackend(
				pending.policy,
				environment,
				answer.summary,
				answer.laneEnv
			);
			decision =
				read.summary.status === 'starting' && !read.env && answer.lateAttach
					? { summary: read.summary, late: answer.lateAttach }
					: read;
		}
		if (
			refuse &&
			pending.policy === 'required' &&
			!decision.env &&
			!decision.late
		) {
			throw new LaneBackendError(decision.summary);
		}
		return decision;
	}

	/** What a port's answer that came after the wait amounts to. */
	#lateAnswer(
		answer: LaneBackendEnsureResult
	): LaneBackendLateAttach | Promise<LaneBackendLateAttach> {
		if (answer.summary.status === 'starting' && answer.lateAttach) {
			return answer.lateAttach;
		}
		return {
			summary: answer.summary,
			...(answer.laneEnv ? { laneEnv: answer.laneEnv } : {}),
		};
	}

	/**
	 * Reads one answer from the backend port: the summary to record and, when
	 * the backend serves the lane now, the variables its Metro gets. A name
	 * the environment's metroEnv sets stays the environment's
	 * (`pinned-by-environment`), and a summary the lane wire would refuse, or
	 * variables Metro would refuse, read as a failed backend. `shadowed` (the
	 * app's own dotenv files win) serves an `auto` lane with a warning and
	 * never a `required` one.
	 */
	#readBackend(
		policy: 'auto' | 'required',
		environment: LaneEnvironment,
		summary: LaneBackendSummary,
		laneEnv: BackendEnv | undefined
	): { summary: LaneBackendSummary; env?: BackendEnv } {
		const parsed = laneBackendSummarySchema.safeParse({ ...summary, policy });
		if (!parsed.success) {
			return {
				summary: failedBackend(
					policy,
					'The local backend answered in a form RN Devtools could not read.'
				),
			};
		}
		// Whether the launch waits and how Metro took the backend are the
		// lane's to say.
		const { launch: _launch, metro: _metro, ...read } = parsed.data;
		const serves =
			read.status === 'ready' ||
			(read.status === 'shadowed' && policy === 'auto');
		if (!serves) return { summary: read };
		const offered = Object.entries(laneEnv ?? {});
		const pinned = new Set(
			offered
				.filter(([name]) => environment.metroEnv?.[name] !== undefined)
				.map(([name]) => name)
		);
		const env = Object.fromEntries(
			offered.filter(([name]) => !pinned.has(name))
		);
		const problem = laneEnvProblem(env);
		if (problem) {
			return {
				summary: {
					...failedBackend(
						policy,
						`Metro would refuse the backend's app variables. ${problem}`
					),
					...(read.stackId ? { stackId: read.stackId } : {}),
				},
			};
		}
		if (pinned.size === 0) return { summary: read, env };
		return {
			summary: {
				...read,
				appEnvNames: read.appEnvNames.filter((name) => !pinned.has(name)),
				warnings: read.warnings.includes('pinned-by-environment')
					? read.warnings
					: [...read.warnings, 'pinned-by-environment'],
			},
			env,
		};
	}

	/**
	 * Records the port's latest answer for a lane, superseding any late attach
	 * still waiting on an earlier one. What the current Metro was spawned
	 * with, and a launch still held back, carry over.
	 */
	#recordBackend(
		laneId: string,
		policy: LaneBackendPolicy,
		summary: LaneBackendSummary
	): LaneBackendRecord {
		const previous = this.#backendRecords.get(laneId);
		const record: LaneBackendRecord = {
			policy,
			summary,
			env: previous?.env,
			generation: (previous?.generation ?? 0) + 1,
			deferredLaunch: previous?.deferredLaunch ?? false,
		};
		this.#backendRecords.set(laneId, record);
		return record;
	}

	/**
	 * Forgets a lane's backend and tells the port to drop the lane's hold,
	 * without waiting on it: a port that throws or rejects changes nothing
	 * for the lane.
	 */
	#releaseBackend(laneId: string): void {
		this.#backendRecords.delete(laneId);
		const port = this.#backends;
		if (!port) return;
		try {
			const result: unknown = port.detachLane(laneId);
			// Typed void, but an async port's rejection must not go unhandled.
			if (result instanceof Promise) result.catch(() => undefined);
		} catch {
			// The lane is gone whatever the backend makes of it.
		}
	}

	/** A stored lane as the wire reports it, with its backend when known. */
	#view(lane: Lane): LaneView {
		const record = this.#backendRecords.get(lane.id);
		if (!record) return lane;
		return {
			...lane,
			backend: {
				...record.summary,
				...(record.note ? { reasonText: record.note } : {}),
				...(record.deferredLaunch ? { launch: 'deferred' as const } : {}),
				...(record.metro ? { metro: record.metro } : {}),
			},
		};
	}

	/**
	 * Attaches a backend that was not ready when the lane's Metro spawned,
	 * once it is, or settles the lane without it once it failed. Queued
	 * behind whatever else runs for the lane's app, and dropped when the lane
	 * stopped or a newer answer superseded this one.
	 */
	#awaitLateAttach(
		lane: Lane,
		generation: number,
		late: Promise<LaneBackendLateAttach>
	): void {
		const appDirectory = path.resolve(laneAppDirectory(lane));
		const signal = this.#lifecycle.signal;
		void late
			.catch(
				(error: unknown): LaneBackendLateAttach => ({
					summary: failedBackend(
						'auto',
						`The local backend did not attach: ${safeErrorText(error)}`
					),
				})
			)
			.then((answer) =>
				this.#serialize(appDirectory, signal, () =>
					this.#applyLateAttach(lane.id, generation, answer, signal)
				)
			)
			.catch(() => undefined);
	}

	async #applyLateAttach(
		laneId: string,
		generation: number,
		answer: LaneBackendLateAttach,
		signal: AbortSignal
	): Promise<void> {
		const record = this.#backendRecords.get(laneId);
		const lane = this.#store.get(laneId);
		if (this.#stopped || !lane || record?.generation !== generation) return;
		const policy = record.policy === 'required' ? 'required' : 'auto';
		const environment = this.#environmentFor(lane);
		const read = this.#readBackend(
			policy,
			environment,
			answer.summary,
			answer.laneEnv
		);
		record.summary = read.summary;
		record.metro = undefined;
		record.note = undefined;
		if (read.env) {
			await this.#attachEnv(lane, environment, record, read.env);
			// A Metro that could not take the backend keeps a held-back launch
			// held back; lane up or Restart Metro picks it up.
			if (
				record.metro !== 'needs-restart' &&
				(record.deferredLaunch ||
					(record.metro === 'restarted' && lane.lastLaunchedAt !== undefined))
			) {
				await this.#launchInBackground(laneId, record, signal);
			}
		} else if (policy === 'required') {
			record.deferredLaunch = false;
			await this.#stopMetroWithoutBackend(lane, record);
		} else if (record.deferredLaunch) {
			// An auto lane launches without the backend, which says why.
			await this.#launchInBackground(laneId, record, signal);
		}
		this.#touch();
	}

	/**
	 * Gives a running lane's Metro the backend's values: a PID-verified
	 * restart on the lane's port, unless the current Metro was spawned with
	 * exactly these. A Metro that is gone, or a restart the supervisor
	 * refuses, marks the backend `needs-restart` with the reason instead of
	 * failing anything.
	 */
	async #attachEnv(
		lane: Lane,
		environment: LaneEnvironment,
		record: LaneBackendRecord,
		env: BackendEnv
	): Promise<void> {
		if (!this.#isMetroRunning(lane)) {
			record.metro = 'needs-restart';
			record.note =
				'Metro for this lane is not running. Run lane up to start it with the backend.';
			return;
		}
		if (
			record.env !== undefined &&
			envFingerprint(record.env) === envFingerprint(env)
		) {
			record.metro = 'unchanged';
			return;
		}
		try {
			await this.#respawnMetro(lane, environment, env);
			record.env = env;
			record.metro = 'restarted';
		} catch (error) {
			record.metro = 'needs-restart';
			record.note = backendReason(
				`Metro could not be restarted with the backend: ${safeErrorText(error)}`
			);
		}
	}

	/**
	 * Stops a `required` lane's Metro once its backend failed to attach. The
	 * lane stays listed with the reason, holding its device, until it is
	 * stopped or started again.
	 */
	async #stopMetroWithoutBackend(
		lane: Lane,
		record: LaneBackendRecord
	): Promise<void> {
		const why = record.summary.reasonText
			? ` ${record.summary.reasonText}`
			: '';
		const pid = lane.metroPid;
		if (pid === undefined || !this.#metro.isProcessRunning(pid)) return;
		try {
			await this.#metro.stop(pid, lane.port, laneAppDirectory(lane));
		} catch (error) {
			record.note = backendReason(
				`The lane requires its local backend, but its Metro could not be stopped: ${safeErrorText(error)}${why}`
			);
			return;
		}
		record.note = backendReason(
			`The lane requires its local backend, so its Metro was stopped.${why}`
		);
		const current = this.#store.get(lane.id);
		if (current?.metroPid === pid) {
			await this.#store.upsert({ ...current, metro: 'stopped' });
		}
	}

	/**
	 * Opens the dev client for a lane on the lane's own account, not the
	 * agent's; a failure is noted on the lane's backend, after what the
	 * backend itself said.
	 */
	async #launchInBackground(
		laneId: string,
		record: LaneBackendRecord,
		signal: AbortSignal
	): Promise<void> {
		try {
			await this.launchLane(laneId, undefined, undefined, signal);
		} catch (error) {
			record.deferredLaunch = false;
			const why = record.summary.reasonText
				? `${record.summary.reasonText} `
				: '';
			record.note = backendReason(
				`${why}The dev client did not open: ${safeErrorText(error)}`
			);
		}
	}

	/**
	 * `promise`'s value, or undefined once the injected clock reaches
	 * `deadline` first. Rejects when `signal` aborts.
	 */
	async #untilDeadline<T>(
		promise: Promise<T>,
		deadline: number,
		signal: AbortSignal
	): Promise<T | undefined> {
		let settled = false;
		const value = promise.then((result) => {
			settled = true;
			return { result };
		});
		const timeout = (async () => {
			while (!settled && this.#now() < deadline) {
				await sleep(CLOCK_POLL_INTERVAL_MS, signal);
			}
		})();
		try {
			return (await Promise.race([value, timeout]))?.result;
		} finally {
			settled = true;
		}
	}

	async #runSimulatorAction(
		action: SimulatorAction,
		signal: AbortSignal
	): Promise<SimulatorJob> {
		const receipt = this.#simulator.runAction(action);
		if (!receipt.accepted || !receipt.jobId) {
			throw new Error(receipt.error ?? 'The Simulator action was rejected.');
		}
		const job = await waitForJob(this.#simulator, receipt.jobId, signal, {
			cancel: true,
			abortError: () => new Error('Lane operation cancelled.'),
		});
		if (job.status !== 'complete') throw new Error(job.message);
		return job;
	}

	#requireLane(laneId: string): Lane {
		const lane = this.#store.get(laneId);
		if (!lane) throw new Error(`Lane ${laneId} does not exist.`);
		return lane;
	}

	async #assertDevClientInstalled(
		lane: Lane,
		signal: AbortSignal
	): Promise<void> {
		if (!lane.bundleIdentifier) return;
		try {
			await this.#runSimulatorAction(
				{
					actionId: `lane-apps-${randomUUID()}`,
					kind: 'app.list',
					udid: lane.simulatorUdid,
				},
				signal
			);
		} catch {
			// Listing apps is advisory. If it fails, let url.open report instead.
			return;
		}
		const apps =
			this.#simulator.getState().appsByDevice[lane.simulatorUdid] ??
			this.#simulator.getState().appsByDevice[
				lane.simulatorUdid.toUpperCase()
			] ??
			[];
		const wanted = lane.bundleIdentifier.toLowerCase();
		if (apps.some((app) => app.bundleIdentifier.toLowerCase() === wanted)) {
			return;
		}
		throw new Error(
			`${lane.bundleIdentifier} is not installed on this Simulator, so there is no dev client to open. Build it once from the worktree with \`npx expo run:ios --device ${lane.simulatorUdid} --no-bundler\` (the RN Devtools build cache shares the result with other worktrees), then run lane launch again. Metro on port ${lane.port} is still running.`
		);
	}

	/** Checks a requested profile exists in the signed helper's catalog. */
	#slimRequest(profileId: string): string {
		if (!this.#slimming || !this.#mutationCoordinator) {
			throw new Error(
				'Slimming is not available in this build, so --slim cannot be honoured.'
			);
		}
		const state = this.#slimming.getState();
		if (state.helper.status !== 'available') {
			throw new Error(
				state.helper.error ??
					'The SimSlim helper is unavailable, so the lane cannot slim.'
			);
		}
		if (!state.profiles.some((profile) => profile.id === profileId)) {
			const known = state.profiles.map((profile) => profile.id).join(', ');
			throw new Error(
				`Unknown SimSlim profile "${profileId}". Known profiles: ${known || 'none'}.`
			);
		}
		return profileId;
	}

	/**
	 * Runs one `profile.apply` through the SimSlim service under the shared
	 * per-Simulator mutation lease, and folds the job's outcome into the lane.
	 * A rejected or failed job never throws: Metro and the launch still happen,
	 * and the lane carries the reason.
	 */
	async #applySlim(
		udid: string,
		profileId: string,
		requester:
			| { kind: 'claude' | 'codex' | 'other'; sessionId: string }
			| undefined,
		signal: AbortSignal
	): Promise<LaneSlim> {
		const slimming = this.#slimming;
		const coordinator = this.#mutationCoordinator;
		if (!slimming || !coordinator) {
			return {
				profileId,
				status: 'skipped',
				message: 'Slimming is not available in this build.',
				updatedAt: this.#now(),
			};
		}
		try {
			return await coordinator.runExclusive(udid, signal, async (lease) => {
				await slimming.refresh();
				const receipt = slimming.runAction(
					{
						actionId: `lane-slim-${randomUUID()}`,
						kind: 'profile.apply',
						profileId,
						simulatorUdids: [udid],
						confirmation: SLIMMING_CONFIRMATIONS.apply,
						// The lane's agent is the requester, so a device another session
						// holds is refused by the slimming service's ownership check.
						...(requester ? { requester } : {}),
					},
					lease
				);
				if (!receipt.accepted || !receipt.jobId) {
					return {
						profileId,
						status: 'skipped' as const,
						message: receipt.error ?? 'SimSlim rejected the profile.',
						updatedAt: this.#now(),
					};
				}
				const job = await waitForJob(slimming, receipt.jobId, signal, {
					cancel: true,
					abortError: () => new Error('Lane operation cancelled.'),
				});
				return {
					profileId,
					status:
						job.status === 'complete'
							? ('applied' as const)
							: ('failed' as const),
					message: job.message,
					jobId: receipt.jobId,
					updatedAt: this.#now(),
				};
			});
		} catch (error) {
			if (signal.aborted) throw error;
			return {
				profileId,
				status: 'failed',
				message: safeErrorText(error),
				updatedAt: this.#now(),
			};
		}
	}

	#agentWithTimestamp(
		agent: Pick<LaneAgent, 'kind' | 'sessionId'> | undefined
	): LaneAgent | undefined {
		return agent ? { ...agent, lastSeenAt: this.#now() } : undefined;
	}

	#touch(): void {
		this.#revision += 1;
		this.#updatedAt = this.#now();
		this.#publishedBackendsKey = this.#worktreeBackendsKey();
		const state = this.getState();
		for (const listener of this.#listeners) {
			try {
				listener(state);
			} catch {
				// One failing subscriber must not starve the others.
			}
		}
	}
}

import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentSession, AgentState } from '../../shared/agent-protocol';
import type { DeviceHolder } from '../../shared/device-hold';
import type { Lane } from '../../shared/lane-protocol';
import {
	isActiveSupabaseJob,
	isSupabaseStackRunning,
	type LaneBackendSummary,
	type LaneWorktreeSupabase,
	SUPABASE_MAX_LOG_CHARACTERS,
	type SupabaseAgentOperation,
	type SupabaseAgentResult,
	type SupabaseDoctorInfo,
	type SupabaseErrorView,
	type SupabaseExcludableCapability,
	type SupabaseInterest,
	type SupabaseJob,
	type SupabaseJobKind,
	type SupabaseOperation,
	type SupabaseOperationReceipt,
	type SupabasePruneSummary,
	type SupabaseStackSummary,
	type SupabaseState,
	sanitizeSupabaseDisplayText,
	supabaseDesktopError,
	supabaseRevertKeepsStack,
} from '../../shared/supabase-protocol';
import { runSimulatorCommand } from '../simulator-command-runner';
import { parseHostMemoryPressure } from '../simulator-metrics-provider';
import {
	decideSupabaseAdmission,
	SUPABASE_CREATION_CONCURRENCY,
	SUPABASE_LIFECYCLE_CONCURRENCY,
	SUPABASE_MAX_CLI_CHILDREN,
	supabaseAdmissionCandidates,
	supabaseRunningCap,
} from './admission';
import {
	releaseSupabaseHolder,
	runSupabaseAgentOperation,
	supabaseDoctorInfo,
} from './agent-operations';
import {
	isPathWithin,
	nodeStaticFileSystem,
	type StaticFileSystem,
} from './bounded-read';
import {
	nextSupabaseFollowRetry,
	observeSupabaseHeads,
	planSupabaseFollows,
	type SupabaseFollowPlan,
	type SupabaseFollowRetry,
} from './branch-follow';
import {
	MainOnlyCredentials,
	parseSupabaseStackDestroy,
	parseSupabaseStackList,
	parseSupabaseStackLogs,
	parseSupabaseStackPrepare,
	parseSupabaseStackRestart,
	parseSupabaseStackStart,
	parseSupabaseStackStatus,
	parseSupabaseStackStop,
	type SupabasePublicEndpoints,
	type SupabaseStackList,
	type SupabaseStackListEntry,
	type SupabaseStackLogs,
	type SupabaseStackStatus,
} from './cli-contract';
import { planSupabaseDrift, type SupabaseDriftStack } from './cli-drift';
import {
	type ClassifiedSupabaseError,
	interpretSupabaseResult,
	SUPABASE_BRANCH_MOVED_TITLE,
	type SupabaseOutcome,
	supabaseBranchMovedError,
} from './cli-errors';
import {
	type ResolvedSupabaseCli,
	type SupabaseCliResolution,
	SupabaseCliResolver,
} from './cli-resolver';
import {
	pruneSupabaseProgressFiles,
	readSupabaseProgressLines,
	removeSupabaseProgressFile,
	type SupabaseCliEnvironmentOptions,
	SupabaseCliRunner,
	SupabaseCliRunnerError,
} from './cli-runner';
import {
	buildSupabaseArgv,
	SupabaseArgvError,
	type SupabaseCliOperation,
	type SupabasePreparableCapability,
	supabaseOperationBudget,
} from './dialect';
import {
	createSupabaseDiscovery,
	type OwnerDiscoveryResult,
	type PortReservationsResult,
	type SupabaseDiscovery,
	type SupabaseOwnerProcess,
	type SysvCapacityResult,
} from './discovery';
import {
	deleteSupabaseUploads,
	measureSupabaseDirectory,
	SUPABASE_SYSTEM_TIMERS,
	type SupabaseEngineTimers,
	SupabaseKeyedLock,
	SupabaseSemaphore,
	SupabaseSingleFlight,
	supabaseDelay,
	supabaseProcessAlive,
	supabaseRealpath,
	supabaseUploadsPath,
} from './engine-support';
import { dueSupabaseStops } from './gc';
import { type GitHead, readGitHead } from './git-head';
import {
	type SupabaseGitCheckIgnore,
	SupabaseKeyStore,
	SupabasePortLeases,
	supabasePortOverrideName,
} from './hardening';
import {
	resolveSupabaseHolds,
	type SupabaseHoldLane,
	type SupabaseHoldsResult,
	sameSupabaseClocks,
	supabaseHolderKeys,
	supabaseHoldsStack,
} from './holds';
import {
	initialSupabaseJobSteps,
	type SupabaseDetachedChild,
	type SupabaseJobStep,
	type SupabaseJobStepState,
	SupabaseJobStore,
	supabaseArgvDigest,
} from './job-store';
import { ensureSupabaseForLane, supabaseLaneEnv } from './lane-backend';
import {
	ensureSupabaseStoreDirectory,
	type SupabasePolicySnapshot,
	SupabasePolicyStore,
} from './policy-store';
import {
	inspectSupabaseRepositories,
	type SupabaseRepositoryFacts,
	type SupabaseRepositoryScanDeps,
	type SupabaseWorktreeFacts,
} from './repositories';
import { describeSupabaseConfirmation } from './service-confirmation';
import { runSupabaseOperation } from './service-operations';
import {
	type LaneBackendEnsureInput,
	type LaneBackendEnsureResult,
	type SteeringSnapshot,
	type SupabaseAgentContext,
	type SupabaseConfirmationFacts,
	type SupabaseHolderKey,
	type SupabaseOperationContext,
	type SupabaseReleaseResult,
	type SupabaseServiceApi,
	type SupabaseServiceDeps,
	toSupabaseErrorView,
} from './service-ports';
import {
	redactSupabaseStoredText,
	SUPABASE_MAX_SERVED_SIMULATORS,
	type SupabaseRequestRecord,
	type SupabaseStackRecord,
	SupabaseStackStore,
	type SupabaseStoredHold,
	supabaseRecreateError,
} from './stack-store';
import {
	assembleSupabaseState,
	type SupabaseExposureEntry,
	type SupabaseLaneAttachment,
	type SupabasePathCheck,
	type SupabaseStatusCacheEntry,
	supabasePathLabel,
} from './state-assembly';
import {
	SupabaseSteeringWriter,
	supabaseSteeringRoots,
} from './steering-writer';

/**
 * The Supabase orchestrator: the one owner of local Supabase state in main.
 *
 * It keeps the stores (policy, stack records with holds and requests, jobs)
 * under `<userData>/supabase`, runs every CLI call from a neutral 0700 cwd
 * through the validated runner, and assembles SupabaseState from what it
 * knows: owner processes, the port registry, the last stack list, per-stack
 * status reads, lsof verdicts, measurements, repository facts and holds.
 * The revision moves only when the visible state changes.
 *
 * Off means off: while local Supabase is turned off (or this Mac can't run
 * it) no timer probes anything and no process is spawned. On, a cheap tier
 * runs every 15 s (owners, the registry, paths and HEADs, holds and
 * automatic stops), `stack list` runs when the owner set changes, after
 * lifecycle work and every 5 min, status reads follow changes and the
 * inspected stack, lsof runs after every lifecycle operation and every
 * 5 min, and footprint and disk are measured only while a window shows the
 * tab. Viewing never extends an automatic stop.
 *
 * Lifecycle work runs as jobs under a per-stack lock: creations one at a
 * time (2.121.0 does not claim native backend ports), resumes and stops two
 * at a time, at most four CLI children in all.
 */

const CHEAP_INTERVAL_MS = 15_000;
const LIST_INTERVAL_MS = 5 * 60_000;
const LSOF_INTERVAL_MS = 5 * 60_000;
const INSPECT_INTERVAL_MS = 10_000;
const MEMORY_INTERVAL_MS = 30_000;
const DISK_INTERVAL_MS = 10 * 60_000;
const CAPACITY_INTERVAL_MS = 5 * 60_000;
const LIST_FRESH_MS = 5_000;
const REQUEST_TTL_MS = 30 * 60_000;
const QUIT_WAIT_MS = 15_000;
const BUSY_RETRY_DELAYS_MS = [500, 1_000, 2_000] as const;
const OWNER_EXIT_WAIT_MS = 15_000;
const OWNER_POLL_MS = 500;
const VALIDATION_TTL_MS = 60_000;
const OUTSIDE_START_WAIT_MS = 120_000;
const OUTSIDE_START_POLL_MS = 1_000;
const MAX_STATUS_READS_PER_LIST = 16;
const MAX_EXTRA_WORKTREES = 32;
const MAX_ADMISSION_STOPS = 3;
const ADOPTED_CHILD_POLL_MS = 1_000;
const ADOPTED_CHILD_MAX_MS = 10 * 60_000;
/** A logs read that keeps overflowing the runner stops shrinking here. */
const MIN_LOG_TAIL = 16;
const DOCKER_SOCKETS = [
	'/var/run/docker.sock',
	'.docker/run/docker.sock',
	'.colima/default/docker.sock',
] as const;
const PODMAN_SOCKETS = [
	'/var/run/podman/podman.sock',
	'.local/share/containers/podman/machine/podman.sock',
] as const;
const LAN_EXPOSED_TITLE = 'Stack listened on your network';
const NO_ROOM_TITLE = 'Not enough room';
const OFF_MESSAGE = 'Local Supabase is off in RN Devtools.';
/** Main's refusal of a CLI read that got its turn once the feature was off. */
const OFF_ERROR: ClassifiedSupabaseError = Object.freeze({
	code: 'failed',
	title: 'Local Supabase is off',
	message: OFF_MESSAGE,
	recovery: 'Turn on local Supabase in the Supabase tab first.',
	retry: 'none',
	details: Object.freeze({}),
});
/**
 * Jobs that can bring a stack up: a turn-off with Stop managed stacks waits
 * for them, then stops their stacks too.
 */
const STARTING_JOB_KINDS: ReadonlySet<SupabaseJobKind> = new Set([
	'create',
	'resume',
	'recreate',
	'stop-and-start',
	'studio',
	'restart',
]);

type MemoryPressure = SupabaseState['capacity']['memoryPressure'];
type JobRequester = SupabaseJob['requestedBy'];

export type SupabaseEngineRunner = Pick<
	SupabaseCliRunner,
	'run' | 'spawnDetached'
>;
export type SupabaseEngineResolver = Pick<
	SupabaseCliResolver,
	'resolve' | 'validateBinary'
>;

/**
 * Seams the tests substitute; production uses the defaults.
 */
export type SupabaseEngineSeams = Readonly<{
	platform: SupabaseState['availability']['platform'];
	runner?: SupabaseEngineRunner;
	resolver?: SupabaseEngineResolver;
	/** Built for the Supabase home in use; rebuilt when the home changes. */
	discovery?: (
		options: Readonly<{ supabaseHome: string }>
	) => SupabaseDiscovery;
	memoryPressure?: () => Promise<MemoryPressure>;
	timers?: SupabaseEngineTimers;
	/** The argv-verified SIGTERM fallback for an owner. */
	signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
	processAlive?: (pid: number) => boolean;
	gitCheckIgnore?: SupabaseGitCheckIgnore;
	/** The user's home: the default Supabase home and path labels. */
	homeDirectory?: string;
	pathExists?: (target: string) => Promise<boolean>;
	repositoryScan?: SupabaseRepositoryScanDeps;
	random?: (size: number) => Uint8Array;
}>;

/** A stack as the engine sees it: the state row plus what only main knows. */
export type SupabaseStackView = Readonly<{
	id: string;
	summary?: SupabaseStackSummary | undefined;
	record?: SupabaseStackRecord | undefined;
	entry?: SupabaseStackListEntry | undefined;
	facts?: SupabaseWorktreeFacts | undefined;
}>;

/** What a step reports: done, or a renderer-safe error. */
type SupabaseStepResult =
	| Readonly<{ ok: true }>
	| Readonly<{ ok: false; error: SupabaseErrorView }>;

/** A job's handle inside its own work. */
type SupabaseEngineJob = Readonly<{
	id: string;
	stackIds: readonly string[];
	/** Aborted when the operator cancels the job. */
	signal: AbortSignal;
	/** Queued until now; the first pending step becomes current. */
	begin: () => void;
	step: (stepId: string, state: SupabaseJobStepState, detail?: string) => void;
	/** One redacted CLI stderr line, or main's own progress text. */
	progress: (line: string) => void;
	details: (
		fields: Readonly<{ cancellable?: boolean; expectedMs?: number }>
	) => void;
}>;

export type SupabaseEngineJobOutcome = Readonly<{
	status: 'complete' | 'failed' | 'cancelled';
	error?: SupabaseErrorView | undefined;
}>;

type SupabaseEngineJobSpec = Readonly<{
	kind: SupabaseJobKind;
	stackIds: readonly string[];
	requestedBy: JobRequester;
	cancellable: boolean;
	steps?: readonly SupabaseJobStep[];
	migrationTotal?: number | undefined;
	expectedMs?: number | undefined;
	coldCache?: boolean | undefined;
}>;

/** Why an ensure did not give a running stack. */
export type SupabaseEnsureRefusal = Readonly<{
	kind: 'refused';
	reason: NonNullable<LaneBackendSummary['reason']>;
	agentCode:
		| 'supabase_disabled'
		| 'supabase_unsupported'
		| 'cli_unverified'
		| 'cli_missing'
		| 'stack_flag_missing'
		| 'config_conflict'
		| 'ports_pinned'
		| 'container_runtime'
		| 'supabase_capacity'
		| 'git_busy'
		| 'not_found'
		| 'needs_recreate'
		| 'supabase_failed'
		| 'cli_mismatch'
		| 'branch_moved';
	message: string;
	stackId?: string | undefined;
	facts?: SupabaseWorktreeFacts | undefined;
	error?: SupabaseErrorView | undefined;
	requestId?: string | undefined;
}>;

export type SupabaseEnsureResult =
	| Readonly<{
			kind: 'ready';
			stackId: string;
			facts: SupabaseWorktreeFacts;
			warnings: readonly ('memory-warning' | 'cli-untested')[];
	  }>
	| SupabaseEnsureRefusal;

/** Who asks for an ensure, and what they keep once it runs. */
type SupabaseEnsureRequest = Readonly<{
	requestedBy: JobRequester;
	createdBy: SupabaseStackRecord['createdBy'];
	/** An agent's session or worktree hold, added once the stack runs. */
	hold?: SupabaseStoredHold | undefined;
	/** The operator's start pins the stack (always, or only when unheld). */
	pin?: 'always' | 'if-unheld' | undefined;
	lane?: Readonly<{ laneId: string; port?: number | undefined }> | undefined;
	/** An agent whose start finds no room files a request for the user. */
	capacityRequester?:
		| Readonly<{ holder: DeviceHolder; synthetic: boolean }>
		| undefined;
	/** Learns the job id as soon as one runs. */
	onJob?: ((jobId: string) => void) | undefined;
}>;

/** A lane on a stack, as the engine tracks it (memory only). */
type LaneAttachment = {
	laneId: string;
	stackId: string;
	worktreePath: string;
	agent?: DeviceHolder | undefined;
	since: number;
	/** The lane has not been stored yet (its start is still running). */
	pending: boolean;
	/** What the lane's Metro was given; a different value needs a restart. */
	envFingerprint?: string | undefined;
	needsMetroRestart: boolean;
};

type ClipboardClear = { text: string; timer: unknown };

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : 'error';
}

function refusal(
	reason: SupabaseEnsureRefusal['reason'],
	agentCode: SupabaseEnsureRefusal['agentCode'],
	message: string,
	extra: Partial<
		Omit<SupabaseEnsureRefusal, 'kind' | 'reason' | 'agentCode' | 'message'>
	> = {}
): SupabaseEnsureRefusal {
	return { kind: 'refused', reason, agentCode, message, ...extra };
}

/** The state without the fields that change on every assembly. */
function stateFingerprint(state: SupabaseState): string {
	return JSON.stringify({
		...state,
		revision: 0,
		updatedAt: 0,
		prune: { ...state.prune, computedAt: 0 },
	});
}

/** One interest from every window's: the newest view, any inspected stack. */
function mergeInterest(
	interests: Iterable<SupabaseInterest>
): SupabaseInterest | undefined {
	const visible = [...interests].filter(
		(interest) => interest.view !== 'hidden'
	);
	const latest = visible.at(-1);
	if (!latest) return undefined;
	const inspected = [...visible]
		.reverse()
		.find(
			(interest) =>
				interest.view === 'stacks' && interest.inspectStackId !== undefined
		);
	return inspected ?? latest;
}

function runnerFailure(error: unknown): ClassifiedSupabaseError {
	const message =
		error instanceof SupabaseCliRunnerError ||
		error instanceof SupabaseArgvError
			? error.message
			: 'The Supabase CLI could not start.';
	return {
		code: 'failed',
		title: 'Supabase CLI could not run',
		message: redactSupabaseStoredText(message, 512),
		recovery:
			'Check that dependencies are installed in this worktree, then retry.',
		retry: 'none',
		details: {},
	};
}

/** The CLI exited 0, so the stack runs, but its output could not be read. */
function startedUnread(error: ClassifiedSupabaseError): boolean {
	return (
		error.details.unexpectedOutput === true && error.details.exitCode === 0
	);
}

function sameHead(left: GitHead, right: GitHead | undefined): boolean {
	if (!right) return false;
	if (left.status !== 'ok' || right.status !== 'ok') {
		return left.status === right.status;
	}
	return (
		left.branchContext === right.branchContext &&
		left.operation === right.operation
	);
}

/** Real memory pressure from /usr/bin/memory_pressure; unknown on failure. */
async function nodeMemoryPressure(): Promise<MemoryPressure> {
	try {
		const result = await runSimulatorCommand(
			'/usr/bin/memory_pressure',
			['-Q'],
			{ timeoutMs: 5_000, maxOutputBytes: 64 * 1_024 }
		);
		return parseHostMemoryPressure(result.stdout).memoryPressure;
	} catch {
		return 'unknown';
	}
}

async function nodePathExists(target: string): Promise<boolean> {
	try {
		await lstat(target);
		return true;
	} catch {
		return false;
	}
}

export class SupabaseEngine implements SupabaseServiceApi {
	readonly deps: SupabaseServiceDeps;
	readonly now: () => number;
	readonly log: (line: string) => void;
	readonly platform: SupabaseState['availability']['platform'];
	readonly root: string;
	readonly cwd: string;
	readonly progressDirectory: string;
	readonly runner: SupabaseEngineRunner;
	readonly resolver: SupabaseEngineResolver;
	readonly timers: SupabaseEngineTimers;
	readonly policyStore: SupabasePolicyStore;
	readonly stackStore: SupabaseStackStore;
	readonly jobStore: SupabaseJobStore;
	readonly keyStore: SupabaseKeyStore;
	readonly portLeases: SupabasePortLeases;
	readonly steeringWriter: SupabaseSteeringWriter;
	readonly homeDirectory: string;
	/** Last export file per stack, for Reveal (main-chosen paths only). */
	readonly exportPaths = new Map<string, string>();

	readonly #seams: SupabaseEngineSeams;
	readonly #fs: StaticFileSystem;
	readonly #readHead: typeof readGitHead;
	readonly #memoryProbe: () => Promise<MemoryPressure>;
	readonly #signalProcess: (pid: number, signal: NodeJS.Signals) => void;
	readonly #processAlive: (pid: number) => boolean;
	readonly #pathExists: (target: string) => Promise<boolean>;
	#discovery: SupabaseDiscovery;
	#discoveryHome: string;

	// Caches, all in memory.
	#facts: SupabaseRepositoryFacts[] = [];
	readonly #extraWorktrees = new Map<
		string,
		Readonly<{ path: string; repositoryRoot: string; branch: string }>
	>();
	/** Apps requested before a lane or stack record can remember them. */
	readonly #requestedApps = new Map<
		string,
		Readonly<{ worktreePath: string; appPath: string }>
	>();
	#list: SupabaseStackList | undefined;
	#lastListAt: number | undefined;
	#listFailure: Readonly<{ message: string; at: number }> | undefined;
	readonly #statuses = new Map<string, SupabaseStatusCacheEntry>();
	#owners: OwnerDiscoveryResult | undefined;
	readonly #ownerFirstSeen = new Map<string, number>();
	#reservations: PortReservationsResult | undefined;
	readonly #exposure = new Map<string, SupabaseExposureEntry>();
	readonly #memory = new Map<string, { bytes: number; measuredAt: number }>();
	readonly #disk = new Map<
		string,
		{ stackBytes?: number; uploadsBytes?: number; measuredAt: number }
	>();
	#cache:
		| {
				bytes?: number;
				state: 'cold' | 'warm' | 'unknown';
				measuredAt?: number;
		  }
		| undefined;
	#sysv: SysvCapacityResult | undefined;
	#memoryPressure: MemoryPressure = 'unknown';
	readonly #endpoints = new Map<string, SupabasePublicEndpoints>();
	/** Key material and DB_URL: memory only, never persisted or sent. */
	readonly #credentials = new Map<string, MainOnlyCredentials>();
	readonly #pathChecks = new Map<string, SupabasePathCheck>();
	#heads = new Map<string, Readonly<{ ref: string; since: number }>>();
	readonly #attachments = new Map<string, LaneAttachment>();
	readonly #cliChanged = new Set<string>();
	readonly #stackFolders = new Map<string, boolean>();
	readonly #interests = new Map<string, SupabaseInterest>();
	readonly #holds = new Map<string, SupabaseHoldsResult>();
	#previousPrune: SupabasePruneSummary | undefined;
	#disabling: SupabaseState['feature']['disabling'];
	#engines: SupabaseState['engines'] = { docker: 'absent', podman: 'absent' };
	#homeStateRoot: string | undefined;
	#drift = new Map<string, Readonly<{ signature: string; since: number }>>();
	readonly #driftAttempted = new Map<string, string>();
	readonly #validated = new Map<
		string,
		Readonly<{ at: number; resolution: SupabaseCliResolution }>
	>();
	readonly #containerStopped = new Set<string>();
	readonly #following = new Set<string>();
	readonly #followRetries = new Map<string, SupabaseFollowRetry>();

	// Execution.
	readonly #stackLocks = new SupabaseKeyedLock();
	readonly #creationGate = new SupabaseSemaphore(SUPABASE_CREATION_CONCURRENCY);
	readonly #lifecycleGate = new SupabaseSemaphore(
		SUPABASE_LIFECYCLE_CONCURRENCY
	);
	readonly #childGate = new SupabaseSemaphore(SUPABASE_MAX_CLI_CHILDREN);
	/** Keyed `automatic:<id>` or `explicit:<id>`: who began the flight. */
	readonly #ensures = new SupabaseSingleFlight<SupabaseEnsureResult>();
	/**
	 * The job each ensure flight runs, under the flight's key, and whether
	 * the flight still waits for the automatic one before it.
	 */
	readonly #ensureJobs = new Map<
		string,
		{
			jobId?: string;
			queued: boolean;
			listeners: Set<(jobId: string) => void>;
		}
	>();
	readonly #statusFlights = new SupabaseSingleFlight<
		SupabaseStackStatus | undefined
	>();
	readonly #flights = new SupabaseSingleFlight<void>();
	readonly #jobControllers = new Map<string, AbortController>();
	readonly #jobInterrupts = new Map<string, () => void>();
	readonly #lifecycleResults = new Set<Promise<unknown>>();
	readonly #tasks = new Set<Promise<unknown>>();
	readonly #clipboard = new Set<ClipboardClear>();

	// Publication.
	readonly #listeners = new Set<(state: SupabaseState) => void>();
	#state: SupabaseState | undefined;
	#fingerprint = '';
	#revision = 0;
	#dirty = true;
	#publishQueued = false;

	// The service's own lifecycle.
	#started = false;
	#stopped = false;
	#active = false;
	#cwdSafe = true;
	readonly #unsubscribes: (() => void)[] = [];
	readonly #timers = new Map<string, unknown>();
	#lastLsofSweepAt = 0;
	#lastCapacityAt = 0;
	#lastMemoryAt = 0;
	#lastDiskAt = 0;
	#repositoriesDirty = true;
	#lanesSignature = '';

	constructor(deps: SupabaseServiceDeps, seams: SupabaseEngineSeams) {
		this.deps = deps;
		this.#seams = seams;
		this.now = deps.now ?? Date.now;
		this.log = deps.log ?? (() => undefined);
		this.platform = seams.platform;
		this.homeDirectory =
			seams.homeDirectory ?? process.env.HOME ?? os.homedir();
		this.root = path.join(path.resolve(deps.userDataDirectory), 'supabase');
		this.cwd = path.join(this.root, 'cwd');
		this.progressDirectory = path.join(this.root, 'progress');
		this.timers = seams.timers ?? SUPABASE_SYSTEM_TIMERS;
		this.runner = seams.runner ?? new SupabaseCliRunner();
		this.resolver =
			seams.resolver ??
			new SupabaseCliResolver({ runner: this.runner, probeCwd: this.cwd });
		this.#fs = seams.repositoryScan?.fs ?? nodeStaticFileSystem;
		this.#readHead = seams.repositoryScan?.readHead ?? readGitHead;
		this.#memoryProbe = seams.memoryPressure ?? nodeMemoryPressure;
		this.#signalProcess =
			seams.signalProcess ?? ((pid, signal) => process.kill(pid, signal));
		this.#processAlive = seams.processAlive ?? supabaseProcessAlive;
		this.#pathExists = seams.pathExists ?? nodePathExists;
		this.policyStore = new SupabasePolicyStore({
			directory: this.root,
			now: this.now,
			pathLabel: (value) => this.pathLabel(value),
			log: this.log,
		});
		this.stackStore = new SupabaseStackStore({
			directory: this.root,
			now: this.now,
			log: this.log,
		});
		this.jobStore = new SupabaseJobStore({
			directory: this.root,
			now: this.now,
			log: this.log,
		});
		this.keyStore = new SupabaseKeyStore({
			directory: path.join(this.root, 'keys'),
			now: this.now,
			...(seams.random ? { random: seams.random } : {}),
			...(seams.gitCheckIgnore ? { checkIgnore: seams.gitCheckIgnore } : {}),
		});
		this.portLeases = new SupabasePortLeases({
			file: path.join(this.root, 'port-leases-v1.json'),
			now: this.now,
		});
		this.steeringWriter = new SupabaseSteeringWriter({
			directory: deps.agentSocketDirectory,
			now: this.now,
			log: this.log,
		});
		this.#discoveryHome = this.supabaseHome();
		this.#discovery = this.#buildDiscovery(this.#discoveryHome);
	}

	// -------------------------------------------------------------------------
	// Basics

	/** The Supabase home the CLI and discovery use. */
	supabaseHome(): string {
		return (
			this.policyStore.snapshot().paths.supabaseHome ??
			path.join(this.homeDirectory, '.supabase')
		);
	}

	pathLabel(value: string): string {
		return supabasePathLabel(value, this.homeDirectory);
	}

	/** Local Supabase is on and this Mac can run it. */
	enabled(): boolean {
		return this.policySnapshot().enabled && this.platform.supported;
	}

	/**
	 * A lifecycle job whose turn came once the feature was off is called off
	 * instead of beginning: nothing is probed or spawned while it is off.
	 * Every job checks this after its gate and the stack's lock, right before
	 * job.begin() or its first CLI call; only the turn-off's own stops don't.
	 */
	calledOff():
		| Readonly<{ status: 'cancelled'; error: SupabaseErrorView }>
		| undefined {
		return this.enabled()
			? undefined
			: {
					status: 'cancelled',
					error: supabaseDesktopError('feature_off', OFF_MESSAGE),
				};
	}

	policySnapshot(): SupabasePolicySnapshot {
		return this.policyStore.snapshot();
	}

	#discoveryNow(): SupabaseDiscovery {
		const home = this.supabaseHome();
		if (home !== this.#discoveryHome) {
			this.#discoveryHome = home;
			this.#discovery = this.#buildDiscovery(home);
		}
		return this.#discovery;
	}

	#buildDiscovery(home: string): SupabaseDiscovery {
		return this.#seams.discovery
			? this.#seams.discovery({ supabaseHome: home })
			: createSupabaseDiscovery({ supabaseHome: home });
	}

	#cliEnvironment(
		leasedPorts?: Readonly<Record<string, string>>
	): SupabaseCliEnvironmentOptions {
		const paths = this.policySnapshot().paths;
		return {
			...(paths.supabaseHome ? { supabaseHome: paths.supabaseHome } : {}),
			...(paths.sslCertFile ? { sslCertFile: paths.sslCertFile } : {}),
			...(leasedPorts && Object.keys(leasedPorts).length > 0
				? { leasedPorts }
				: {}),
		};
	}

	/** Runs `task` in the background, tracked so tests and quit can wait. */
	track<T>(task: Promise<T>): Promise<T> {
		const tracked = task.catch((error: unknown) => {
			this.log(`Supabase background task failed: ${errorName(error)}`);
			return undefined;
		});
		this.#tasks.add(tracked);
		void tracked.finally(() => this.#tasks.delete(tracked));
		return task;
	}

	/** Resolves once every background task has settled (tests). */
	async settle(): Promise<void> {
		for (let round = 0; round < 100 && this.#tasks.size > 0; round += 1) {
			await Promise.allSettled([...this.#tasks]);
		}
	}

	#lanes(): readonly Lane[] {
		try {
			const lanes = this.deps.lanes.lanes();
			return Array.isArray(lanes) ? lanes : [];
		} catch {
			return [];
		}
	}

	#sessions(): readonly AgentSession[] {
		try {
			const sessions = this.deps.agents.sessions();
			return Array.isArray(sessions) ? sessions : [];
		} catch {
			return [];
		}
	}

	#sessionDiscovery(): Pick<AgentState['discovery'], 'claude' | 'codex'> {
		try {
			return this.deps.agents.discovery();
		} catch {
			return { claude: 'unavailable', codex: 'unavailable' };
		}
	}

	// -------------------------------------------------------------------------
	// State publication

	markDirty(): void {
		this.#dirty = true;
		if (this.#publishQueued) return;
		this.#publishQueued = true;
		queueMicrotask(() => {
			this.#publishQueued = false;
			const before = this.#state?.revision;
			let state: SupabaseState;
			try {
				state = this.getState();
			} catch (error) {
				// A broken input must not take main down; the next change retries.
				this.#dirty = true;
				this.log(`Supabase state could not be assembled: ${errorName(error)}`);
				return;
			}
			if (state.revision === before) return;
			for (const listener of [...this.#listeners]) {
				try {
					listener(state);
				} catch {
					// A subscriber must never break the service.
				}
			}
		});
	}

	getState(): SupabaseState {
		if (!this.#dirty && this.#state) return this.#state;
		this.#dirty = false;
		const candidate = this.#assemble(this.#revision + 1);
		this.#previousPrune = candidate.prune;
		const fingerprint = stateFingerprint(candidate);
		if (this.#state && fingerprint === this.#fingerprint) return this.#state;
		this.#fingerprint = fingerprint;
		this.#revision += 1;
		this.#state = candidate;
		return candidate;
	}

	subscribe(listener: (state: SupabaseState) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	#interest(): SupabaseInterest | undefined {
		return mergeInterest(this.#interests.values());
	}

	#assemble(revision: number): SupabaseState {
		const lanes = this.#lanes();
		const laneIds = new Set(lanes.map((lane) => lane.id));
		const attachments = new Map<string, SupabaseLaneAttachment>();
		for (const attachment of this.#attachments.values()) {
			if (!laneIds.has(attachment.laneId)) continue;
			attachments.set(attachment.laneId, {
				stackId: attachment.stackId,
				needsMetroRestart: attachment.needsMetroRestart,
			});
		}
		const interest = this.#interest();
		return assembleSupabaseState({
			now: this.now(),
			revision,
			platform: this.platform,
			policy: this.policySnapshot(),
			...(this.#disabling ? { disabling: this.#disabling } : {}),
			discovery: {
				status: this.#active ? 'live' : 'off',
				...(this.#lastListAt === undefined
					? {}
					: { lastListAt: this.#lastListAt }),
				sessions: this.#sessionDiscovery(),
				...(this.#listFailure ? { listFailure: this.#listFailure } : {}),
			},
			...(this.#owners ? { owners: this.#owners } : {}),
			ownerFirstSeen: this.#ownerFirstSeen,
			...(this.#reservations ? { reservations: this.#reservations } : {}),
			...(this.#homeStateRoot ? { homeStateRoot: this.#homeStateRoot } : {}),
			...(this.#list ? { list: this.#list } : {}),
			statuses: this.#statuses,
			endpoints: this.#endpoints,
			credentials: this.#credentials,
			records: this.stackStore.records(),
			requests: this.stackStore.requests(),
			lanes,
			laneAttachments: attachments,
			sessions: this.#sessions(),
			repositories: this.#facts,
			holds: this.#holds,
			jobs: this.jobStore.jobs({ now: this.now() }),
			activity: this.stackStore.activity(),
			measurements: {
				memory: this.#memory,
				disk: this.#disk,
				...(this.#cache ? { cache: this.#cache } : {}),
				...(this.#sysv ? { sysv: this.#sysv } : {}),
				memoryPressure: this.#memoryPressure,
			},
			exposure: this.#exposure,
			pathChecks: this.#pathChecks,
			stackFolders: this.#stackFolders,
			headStableSince: new Map(
				[...this.#heads].map(([worktree, head]) => [worktree, head.since])
			),
			cliChanged: this.#cliChanged,
			engines: this.#engines,
			...(interest ? { interest } : {}),
			...(this.#previousPrune ? { previousPrune: this.#previousPrune } : {}),
			pathLabel: (value) => this.pathLabel(value),
			log: this.log,
		});
	}

	// -------------------------------------------------------------------------
	// Start and stop of the service

	async start(): Promise<void> {
		if (this.#started) return;
		this.#started = true;
		try {
			await ensureSupabaseStoreDirectory(this.root);
			await Promise.all([this.policyStore.load(), this.stackStore.load()]);
			const jobs = await this.jobStore.load();
			await this.#adoptChildren(jobs.children);
			// Files of children that ended while no desktop ran, or that an
			// earlier version kept: only an adopted child's is read again.
			this.track(
				pruneSupabaseProgressFiles(this.progressDirectory, {
					before: this.now(),
					keep: new Set(
						this.jobStore.children().map((child) => child.progressFile)
					),
				})
			);
		} catch (error) {
			this.log(`Supabase state could not be loaded: ${errorName(error)}`);
		}
		this.#unsubscribes.push(
			this.policyStore.subscribe(() => this.markDirty()),
			this.stackStore.subscribe(() => this.markDirty()),
			this.jobStore.subscribe(() => this.markDirty())
		);
		try {
			this.#unsubscribes.push(
				this.deps.lanes.subscribe(() => this.#onLanesChanged()),
				this.deps.agents.subscribe(() => this.#onAgentsChanged())
			);
		} catch (error) {
			this.log(
				`Supabase could not follow lanes or agents: ${errorName(error)}`
			);
		}
		this.#cwdSafe = await this.#neutralCwdIsSafe();
		if (this.enabled()) {
			this.#activate();
		} else {
			// No rules apply while off, including a file a crash left behind.
			await this.steeringWriter.remove();
		}
		this.markDirty();
	}

	async stop(): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#deactivate({ removeSteering: false });
		for (const unsubscribe of this.#unsubscribes.splice(0)) {
			try {
				unsubscribe();
			} catch {
				// Nothing to undo.
			}
		}
		// A copied secret should not outlive the app on the clipboard.
		for (const pending of [...this.#clipboard]) {
			this.timers.clearTimeout(pending.timer);
			await this.#clearClipboardIfUnchanged(pending.text);
		}
		this.#clipboard.clear();
		// Lifecycle children keep running on their own; wait a little for them.
		const children = [...this.#lifecycleResults];
		if (children.length > 0) {
			await this.#within(Promise.allSettled(children), QUIT_WAIT_MS);
		}
	}

	/** Waits for `task`, or `ms` at most, leaving no timer behind. */
	async #within(task: Promise<unknown>, ms: number): Promise<void> {
		const controller = new AbortController();
		try {
			await Promise.race([
				task,
				supabaseDelay(this.timers, ms, controller.signal),
			]);
		} finally {
			controller.abort();
		}
	}

	/**
	 * The CLI searches upward from its cwd for supabase/config.toml when it
	 * is not told where to look; none may exist above the neutral cwd inside
	 * userData, or every CLI call is refused.
	 */
	async #neutralCwdIsSafe(): Promise<boolean> {
		const candidates = [
			path.join(this.cwd, 'supabase', 'config.toml'),
			path.join(this.root, 'supabase', 'config.toml'),
			path.join(path.dirname(this.root), 'supabase', 'config.toml'),
		];
		for (const candidate of candidates) {
			if (await this.#pathExists(candidate)) {
				this.log(
					'A supabase/config.toml sits above the neutral Supabase cwd; RN Devtools runs no Supabase CLI until it is removed.'
				);
				return false;
			}
		}
		return true;
	}

	#activate(): void {
		if (this.#active || this.#stopped) return;
		this.#active = true;
		this.#repositoriesDirty = true;
		this.track(this.#boot());
		this.markDirty();
	}

	#deactivate(options: Readonly<{ removeSteering: boolean }>): void {
		this.#active = false;
		for (const handle of this.#timers.values()) {
			this.timers.clearTimeout(handle);
		}
		this.#timers.clear();
		if (options.removeSteering) this.track(this.steeringWriter.remove());
		this.markDirty();
	}

	#schedule(name: string, delayMs: number, task: () => Promise<void>): void {
		if (!this.#active || this.#stopped) return;
		const existing = this.#timers.get(name);
		if (existing !== undefined) this.timers.clearTimeout(existing);
		this.#timers.set(
			name,
			this.timers.setTimeout(
				() => {
					this.#timers.delete(name);
					if (!this.#active || this.#stopped) return;
					this.track(task());
				},
				Math.max(0, delayMs)
			)
		);
	}

	async #boot(): Promise<void> {
		await this.#readEngines();
		await this.refreshRepositories();
		// Turned off again meanwhile: no key file is checked with git.
		if (!this.#active) return;
		await this.applyPerStackKeys();
		await this.#cheapTick({ boot: true });
		// A window may already show the tab: its interest predates turning on.
		const interest = this.#interest();
		if (interest) {
			this.#schedule('measure', 0, () => this.#measureTick());
			if (interest.inspectStackId !== undefined) {
				this.#schedule('inspect', INSPECT_INTERVAL_MS, () =>
					this.#inspectTick()
				);
			}
		}
	}

	async #readEngines(): Promise<void> {
		const found = async (candidates: readonly string[]) => {
			for (const candidate of candidates) {
				const target = path.isAbsolute(candidate)
					? candidate
					: path.join(this.homeDirectory, candidate);
				if (await this.#pathExists(target)) return 'found' as const;
			}
			return 'absent' as const;
		};
		this.#engines = {
			docker: await found(DOCKER_SOCKETS),
			podman: await found(PODMAN_SOCKETS),
		};
	}

	#onLanesChanged(): void {
		if (!this.#active) return;
		let signature = '';
		try {
			signature = JSON.stringify([
				this.deps.lanes.repositories(),
				this.deps.lanes
					.worktrees()
					.map((worktree) => [worktree.path, worktree.branch]),
				this.#lanes().map((lane) => [lane.id, lane.worktreePath, lane.appPath]),
			]);
		} catch {
			signature = '';
		}
		if (signature !== this.#lanesSignature) {
			this.#lanesSignature = signature;
			this.#repositoriesDirty = true;
			this.#schedule('repositories', 250, async () => {
				await this.refreshRepositories();
				await this.reconcileHolds();
			});
		} else {
			this.#schedule('holds', 250, () => this.reconcileHolds());
		}
		this.markDirty();
	}

	#onAgentsChanged(): void {
		if (!this.#active) return;
		this.#schedule('holds', 250, () => this.reconcileHolds());
		this.markDirty();
	}

	/** Turns the cadence on or off after the policy changed. */
	syncActivation(): void {
		if (this.enabled()) {
			if (!this.#active) this.#activate();
		} else if (this.#active) {
			this.#deactivate({ removeSteering: true });
		}
	}

	// -------------------------------------------------------------------------
	// Interest

	setInterest(senderKey: string, interest: SupabaseInterest): void {
		const before = this.#interest();
		if (interest.view === 'hidden') this.#interests.delete(senderKey);
		else this.#interests.set(senderKey, interest);
		const after = this.#interest();
		this.markDirty();
		if (!this.#active) return;
		if (after?.inspectStackId !== undefined) {
			if (after.inspectStackId !== before?.inspectStackId) {
				this.track(this.readStatus(after.inspectStackId));
			}
			this.#schedule('inspect', INSPECT_INTERVAL_MS, () => this.#inspectTick());
		}
		if (after && !before) {
			this.#schedule('measure', 0, () => this.#measureTick());
		}
	}

	async #inspectTick(): Promise<void> {
		const stackId = this.#interest()?.inspectStackId;
		if (stackId === undefined) return;
		await this.readStatus(stackId);
		this.#schedule('inspect', INSPECT_INTERVAL_MS, () => this.#inspectTick());
	}

	async #measureTick(): Promise<void> {
		if (this.#interest() === undefined) return;
		const now = this.now();
		if (now - this.#lastMemoryAt >= MEMORY_INTERVAL_MS - 1_000) {
			this.#lastMemoryAt = now;
			await this.#measureMemory();
		}
		// Turned off meanwhile: nothing more is measured.
		if (!this.#active) return;
		if (now - this.#lastDiskAt >= DISK_INTERVAL_MS - 1_000) {
			this.#lastDiskAt = now;
			await this.#measureDisk();
		}
		this.markDirty();
		this.#schedule('measure', MEMORY_INTERVAL_MS, () => this.#measureTick());
	}

	// -------------------------------------------------------------------------
	// The cheap tier

	async #cheapTick(options: Readonly<{ boot?: boolean }> = {}): Promise<void> {
		if (!this.#active) return;
		try {
			// Any step can outlast the feature: once it is off, the tick ends
			// before the next one probes, lists, starts or stops anything.
			const ownersChanged = await this.#readOwners();
			if (!this.#active) return;
			this.#reservations = await this.#discoveryNow().readPortReservations();
			this.#homeStateRoot =
				(await supabaseRealpath(path.join(this.supabaseHome(), 'stacks'))) ??
				path.join(this.supabaseHome(), 'stacks');
			await this.#checkPaths();
			if (await this.#headsMoved()) this.#repositoriesDirty = true;
			if (!this.#active) return;
			if (this.#repositoriesDirty) await this.refreshRepositories();
			if (!this.#active) return;
			const now = this.now();
			// A new owner, or none for a while: list again, but not in the
			// middle of a creation (the list probes owners' locks).
			const listDue =
				options.boot === true ||
				ownersChanged ||
				this.#lastListAt === undefined ||
				now - this.#lastListAt >= LIST_INTERVAL_MS;
			if (
				listDue &&
				(options.boot === true || this.#creationGate.active === 0)
			) {
				await this.refreshList();
				if (!this.#active) return;
			}
			if (options.boot === true) this.#deriveLaneAttachments();
			if (now - this.#lastCapacityAt >= CAPACITY_INTERVAL_MS) {
				await this.#readCapacity();
			}
			await this.stackStore.expireRequests();
			await this.reconcileHolds();
			if (!this.#active) return;
			await this.#stopContainerStacks();
			if (!this.#active) return;
			await this.#planDrift();
			if (!this.#active) return;
			await this.#planFollows();
			if (!this.#active) return;
			if (now - this.#lastLsofSweepAt >= LSOF_INTERVAL_MS) {
				this.#lastLsofSweepAt = now;
				await this.#sweepExposure();
			}
			await this.writeSteering();
		} catch (error) {
			this.log(`Supabase reconcile failed: ${errorName(error)}`);
		} finally {
			this.markDirty();
			this.#schedule('cheap', CHEAP_INTERVAL_MS, () => this.#cheapTick());
		}
	}

	/** Reads owner processes; true when the set of stacks with an owner changed. */
	async #readOwners(): Promise<boolean> {
		const owners = await this.#discoveryNow().discoverOwners();
		const before = new Set(
			this.#owners?.status === 'ok'
				? this.#owners.owners.map((owner) => owner.stackId)
				: []
		);
		this.#owners = owners;
		if (owners.status !== 'ok') return false;
		const now = this.now();
		const after = new Set(owners.owners.map((owner) => owner.stackId));
		for (const stackId of after) {
			if (!this.#ownerFirstSeen.has(stackId)) {
				this.#ownerFirstSeen.set(stackId, now);
			}
		}
		for (const stackId of [...this.#ownerFirstSeen.keys()]) {
			if (!after.has(stackId)) this.#ownerFirstSeen.delete(stackId);
		}
		return (
			before.size !== after.size || [...after].some((id) => !before.has(id))
		);
	}

	ownerOf(stackId: string): SupabaseOwnerProcess | undefined {
		return this.#owners?.status === 'ok'
			? this.#owners.owners.find((owner) => owner.stackId === stackId)
			: undefined;
	}

	async #checkPaths(): Promise<void> {
		const now = this.now();
		const roots = new Map<string, { projectRoot: string; worktree?: string }>();
		for (const record of this.stackStore.records()) {
			roots.set(record.id, {
				projectRoot: record.projectRoot,
				...(record.worktreePath ? { worktree: record.worktreePath } : {}),
			});
		}
		for (const entry of this.#list?.stacks ?? []) {
			if (!roots.has(entry.id)) {
				roots.set(entry.id, { projectRoot: entry.projectRoot });
			}
		}
		for (const [stackId, root] of roots) {
			const projectKind = await this.#fs.kind(root.projectRoot);
			const worktreeKind = root.worktree
				? await this.#fs.kind(root.worktree)
				: projectKind;
			const previous = this.#pathChecks.get(stackId);
			const missing = projectKind === 'missing';
			this.#pathChecks.set(stackId, {
				worktreeExists: worktreeKind !== 'missing',
				projectRootMissingChecks: missing
					? (previous?.projectRootMissingChecks ?? 0) + 1
					: 0,
				...(missing ? { missingSince: previous?.missingSince ?? now } : {}),
			});
		}
		for (const stackId of [...this.#pathChecks.keys()]) {
			if (!roots.has(stackId)) this.#pathChecks.delete(stackId);
		}
	}

	/** Re-reads each known worktree's HEAD; true when one moved. */
	async #headsMoved(): Promise<boolean> {
		let moved = false;
		const seen = new Set<string>();
		for (const worktree of this.allFacts()) {
			if (seen.has(worktree.worktreePath)) continue;
			seen.add(worktree.worktreePath);
			if (worktree.detection?.status !== 'found') continue;
			const head = await this.#readHead(worktree.worktreePath);
			if (!sameHead(head, worktree.head)) moved = true;
		}
		return moved;
	}

	async #readCapacity(): Promise<void> {
		this.#lastCapacityAt = this.now();
		this.#sysv = await this.#discoveryNow().readSysvCapacity();
		// Turned off during that read: memory pressure isn't probed.
		if (!this.#active) return;
		this.#memoryPressure = await this.#memoryProbe();
	}

	// -------------------------------------------------------------------------
	// Repositories and worktree facts

	allFacts(): readonly SupabaseWorktreeFacts[] {
		return this.#facts.flatMap((repository) => repository.worktrees);
	}

	repositoryFacts(): readonly SupabaseRepositoryFacts[] {
		return this.#facts;
	}

	refreshRepositories(options: { fresh?: boolean } = {}): Promise<void> {
		const scan = async () => {
			this.#repositoriesDirty = false;
			let repositories: readonly string[] = [];
			let worktrees: readonly Readonly<{
				path: string;
				branch: string;
				repositoryRoot: string;
				dirty: boolean;
			}>[] = [];
			try {
				repositories = this.deps.lanes.repositories();
				worktrees = this.deps.lanes.worktrees();
			} catch {
				// Lanes are not ready yet; only the extra worktrees are scanned.
			}
			const tracked = new Set(worktrees.map((worktree) => worktree.path));
			const extras = [...this.#extraWorktrees.values()].filter(
				(extra) => !tracked.has(extra.path)
			);
			const facts = await inspectSupabaseRepositories(
				{
					repositories: [
						...new Set([
							...repositories,
							...extras.map((extra) => extra.repositoryRoot),
						]),
					],
					worktrees: [
						...worktrees,
						...extras.map((extra) => ({
							path: extra.path,
							branch: extra.branch,
							repositoryRoot: extra.repositoryRoot,
							dirty: false,
						})),
					],
					lanes: this.#lanes(),
					appPaths: [
						...this.#requestedApps.values(),
						...this.stackStore.records().flatMap((record) => {
							const worktreePath = record.worktreePath;
							return worktreePath === undefined
								? []
								: record.appPaths.map((appPath) => ({ worktreePath, appPath }));
						}),
					],
					policy: this.policySnapshot().policy,
					featureEnabled: true,
					platformSupported: this.platform.supported,
					resolveCli: (input) => this.resolver.resolve(input),
					now: this.now(),
				},
				this.#seams.repositoryScan ?? {}
			);
			this.#facts = facts;
			this.#heads = observeSupabaseHeads(
				this.#heads,
				this.allFacts(),
				this.now()
			).heads;
			this.markDirty();
		};
		return options.fresh
			? this.#flights.runFresh('repositories', scan)
			: this.#flights.run('repositories', scan);
	}

	/**
	 * Facts for a checkout or app inside it. An explicit app is scanned even
	 * before its first lane or stack exists; a sibling's project is never a
	 * substitute. Agents may also name worktrees Lanes does not track. The
	 * HEAD is re-read so callers decide on the live branch.
	 */
	async worktreeFacts(
		worktreePath: string,
		appPath?: string
	): Promise<SupabaseWorktreeFacts | undefined> {
		const real = (await supabaseRealpath(worktreePath)) ?? worktreePath;
		const wanted = appPath
			? ((await supabaseRealpath(appPath)) ?? appPath)
			: undefined;
		const containing = () =>
			this.allFacts().filter(
				(facts) =>
					facts.worktreePath === worktreePath ||
					facts.realWorktreePath === real ||
					real.startsWith(`${facts.realWorktreePath}/`)
			);
		const deepest = () =>
			containing().sort(
				(left, right) =>
					right.realWorktreePath.length - left.realWorktreePath.length
			)[0];
		let root = deepest();
		if (!root) {
			if (!(await this.#addExtraWorktree(real))) return undefined;
			await this.refreshRepositories({ fresh: true });
			root = deepest();
			if (!root) return undefined;
		}
		const realRoot = root.realWorktreePath;
		const trackedRoot = root.worktreePath;
		const app = wanted ?? (real === realRoot ? undefined : real);
		const find = (): SupabaseWorktreeFacts | undefined => {
			const sameRoot = containing().filter(
				(facts) => facts.realWorktreePath === realRoot
			);
			return app === undefined
				? (sameRoot.find((facts) => facts.detection?.status === 'found') ??
						sameRoot[0])
				: sameRoot.find(
						(facts) =>
							facts.appPath === app ||
							facts.appPath ===
								path.join(trackedRoot, path.relative(realRoot, app)) ||
							(facts.detection?.status === 'found' &&
								facts.detection.appRoot === app)
					);
		};
		if (app !== undefined) {
			if (
				!isPathWithin(realRoot, app) ||
				(await this.#fs.kind(app)) !== 'directory'
			) {
				return undefined;
			}
			this.#requestedApps.set(app, {
				worktreePath: trackedRoot,
				appPath: path.join(trackedRoot, path.relative(realRoot, app)),
			});
			while (this.#requestedApps.size > MAX_EXTRA_WORKTREES) {
				const oldest = this.#requestedApps.keys().next().value;
				if (oldest === undefined) break;
				this.#requestedApps.delete(oldest);
			}
			if (!find()) await this.refreshRepositories({ fresh: true });
		}
		let facts = find();
		if (!facts) return undefined;
		const head = await this.#readHead(facts.worktreePath);
		if (!sameHead(head, facts.head)) {
			await this.refreshRepositories();
			facts = find() ?? facts;
		}
		return facts;
	}

	/** Records an untracked git worktree so the next scan includes it. */
	async #addExtraWorktree(target: string): Promise<boolean> {
		let current = target;
		for (let depth = 0; ; depth += 1) {
			const kind = await this.#fs.kind(path.join(current, '.git'));
			if (kind === 'file' || kind === 'directory') break;
			const parent = path.dirname(current);
			if (parent === current || depth >= 32) return false;
			current = parent;
		}
		const head = await this.#readHead(current);
		if (head.status !== 'ok') return false;
		const repositoryRoot =
			path.basename(head.commonDir) === '.git'
				? path.dirname(head.commonDir)
				: current;
		const branch = head.branchContext.startsWith('refs/heads/')
			? head.branchContext.slice('refs/heads/'.length)
			: head.branchContext;
		this.#extraWorktrees.set(current, {
			path: current,
			repositoryRoot,
			branch: branch.slice(0, 256) || 'detached',
		});
		while (this.#extraWorktrees.size > MAX_EXTRA_WORKTREES) {
			const oldest = this.#extraWorktrees.keys().next().value;
			if (oldest === undefined) break;
			this.#extraWorktrees.delete(oldest);
		}
		return true;
	}

	/** The facts of the worktree a stack belongs to. */
	factsForStack(
		stackId: string,
		record = this.stackStore.record(stackId),
		entry = this.entry(stackId)
	): SupabaseWorktreeFacts | undefined {
		const facts = this.allFacts();
		const byId = facts.find(
			(candidate) => candidate.expectedStackId === stackId
		);
		if (byId) return byId;
		if (record?.worktreePath !== undefined) {
			const worktree = facts.filter(
				(candidate) => candidate.worktreePath === record.worktreePath
			);
			const app = worktree.find((candidate) =>
				record.appPaths.includes(candidate.appPath)
			);
			const found = app ?? worktree[0];
			if (found) return found;
		}
		const projectRoot = entry?.projectRoot ?? record?.projectRoot;
		if (projectRoot === undefined) return undefined;
		return (
			facts.find(
				(candidate) =>
					candidate.detection?.status === 'found' &&
					candidate.detection.projectRoot === projectRoot
			) ??
			facts
				.filter(
					(candidate) =>
						projectRoot === candidate.realWorktreePath ||
						projectRoot.startsWith(`${candidate.realWorktreePath}/`)
				)
				.sort(
					(left, right) =>
						right.realWorktreePath.length - left.realWorktreePath.length
				)[0]
		);
	}

	entry(stackId: string): SupabaseStackListEntry | undefined {
		return this.#list?.stacks.find((entry) => entry.id === stackId);
	}

	listEntries(): readonly SupabaseStackListEntry[] {
		return this.#list?.stacks ?? [];
	}

	view(stackId: string): SupabaseStackView {
		const record = this.stackStore.record(stackId);
		const entry = this.entry(stackId);
		return {
			id: stackId,
			summary: this.getState().stacks.find((stack) => stack.id === stackId),
			record,
			entry,
			facts: this.factsForStack(stackId, record, entry),
		};
	}

	/** Re-reads HEAD: does the worktree still sit on the stack's branch? */
	async headMatches(view: SupabaseStackView): Promise<boolean> {
		const branch =
			view.entry?.branchContext ??
			view.record?.branchContext ??
			view.summary?.branchContext;
		const worktree = view.facts?.worktreePath ?? view.record?.worktreePath;
		if (branch === undefined || worktree === undefined) return false;
		const head = await this.#readHead(worktree);
		return head.status === 'ok' && head.branchContext === branch;
	}

	/**
	 * A `--local` call's precondition: the CLI resolves the stack from HEAD
	 * when it runs, so a worktree that left the stack's branch while the call
	 * waited would send it to that branch's stack instead.
	 */
	async stillOnBranch(
		view: SupabaseStackView
	): Promise<ClassifiedSupabaseError | undefined> {
		return (await this.headMatches(view))
			? undefined
			: supabaseBranchMovedError();
	}

	endpointsOf(stackId: string): SupabasePublicEndpoints | undefined {
		return (
			this.#statuses.get(stackId)?.status?.publicEndpoints ??
			this.#endpoints.get(stackId)
		);
	}

	credentialsOf(stackId: string): MainOnlyCredentials | undefined {
		return this.#credentials.get(stackId);
	}

	#reservedPorts(stackId: string): number | undefined {
		if (this.#reservations?.status !== 'ok') return undefined;
		return this.#reservations.reservations.filter(
			(reservation) => reservation.stackId === stackId
		).length;
	}

	// -------------------------------------------------------------------------
	// CLI selection and execution

	/** The worktree's own CLI when it may manage stacks. */
	manageCli(
		facts: SupabaseWorktreeFacts | undefined
	): ResolvedSupabaseCli | undefined {
		const resolution = facts?.cli;
		return resolution?.ok && resolution.cli.dialect.manageable
			? resolution.cli
			: undefined;
	}

	/** The worktree's own CLI when it may read (verified or compatible). */
	readCli(
		facts: SupabaseWorktreeFacts | undefined
	): ResolvedSupabaseCli | undefined {
		const resolution = facts?.cli;
		return resolution?.ok && resolution.cli.dialect.gate !== 'unsupported'
			? resolution.cli
			: undefined;
	}

	/** The newest verified CLI any tracked worktree has. */
	newestCli(): ResolvedSupabaseCli | undefined {
		const candidates = this.allFacts().flatMap((facts) =>
			facts.cli?.ok && facts.cli.cli.dialect.gate !== 'unsupported'
				? [facts.cli.cli]
				: []
		);
		const rank = (cli: ResolvedSupabaseCli) =>
			cli.dialect.gate === 'verified' ? 2 : cli.dialect.manageable ? 1 : 0;
		return [...candidates].sort(
			(left, right) =>
				rank(right) - rank(left) ||
				right.version.localeCompare(left.version, undefined, { numeric: true })
		)[0];
	}

	#allowedRoots(): string[] {
		const roots = new Set<string>();
		for (const repository of this.#facts) {
			roots.add(repository.realRoot);
			for (const worktree of repository.worktrees) {
				roots.add(worktree.realWorktreePath);
			}
		}
		return [...roots].filter((root) => path.isAbsolute(root));
	}

	/** A binary from elsewhere (owner argv[0], a recorded path), once it validates. */
	async #validatedCli(
		binaryPath: string | undefined
	): Promise<ResolvedSupabaseCli | undefined> {
		if (binaryPath === undefined || !path.isAbsolute(binaryPath)) {
			return undefined;
		}
		const resolution = await this.#validateBinary(binaryPath);
		return resolution?.ok && resolution.cli.dialect.gate !== 'unsupported'
			? resolution.cli
			: undefined;
	}

	async #validateBinary(
		binaryPath: string
	): Promise<SupabaseCliResolution | undefined> {
		const cached = this.#validated.get(binaryPath);
		if (cached && this.now() - cached.at < VALIDATION_TTL_MS) {
			return cached.resolution;
		}
		const allowedRoots = this.#allowedRoots();
		if (allowedRoots.length === 0) return undefined;
		try {
			const resolution = await this.resolver.validateBinary({
				binaryPath,
				allowedRoots,
				allowUnverifiedPatch: this.policySnapshot().policy.allowUnverifiedPatch,
			});
			this.#validated.set(binaryPath, { at: this.now(), resolution });
			return resolution;
		} catch {
			return undefined;
		}
	}

	/** Any validated CLI for a stop or destroy: they work across releases. */
	async #stopCli(stackId: string): Promise<ResolvedSupabaseCli | undefined> {
		const record = this.stackStore.record(stackId);
		return (
			(await this.#validatedCli(record?.binaryPath)) ??
			this.readCli(this.factsForStack(stackId)) ??
			this.newestCli() ??
			(await this.#validatedCli(this.ownerOf(stackId)?.executable))
		);
	}

	/** The owner's own CLI first, for status and logs. */
	async ownerCli(stackId: string): Promise<ResolvedSupabaseCli | undefined> {
		const record = this.stackStore.record(stackId);
		return (
			(await this.#validatedCli(this.ownerOf(stackId)?.executable)) ??
			(await this.#validatedCli(record?.binaryPath)) ??
			this.readCli(this.factsForStack(stackId)) ??
			this.newestCli()
		);
	}

	#blockedCli(): ClassifiedSupabaseError | undefined {
		if (this.#cwdSafe) return undefined;
		return {
			code: 'failed',
			title: 'Supabase CLI calls are blocked',
			message:
				"A supabase/config.toml sits above RN Devtools' neutral working directory.",
			recovery:
				"Remove the supabase folder from RN Devtools' application data, then restart RN Devtools.",
			retry: 'none',
			details: {},
		};
	}

	/** A short attached call (reads, a dump): the request may abort it. */
	async runRead<T>(
		cli: ResolvedSupabaseCli,
		operation: SupabaseCliOperation,
		project: (json: unknown, stderrLines: readonly string[]) => T,
		options: Readonly<{
			signal?: AbortSignal | undefined;
			expectOutput?: 'json' | 'none';
			/** Checked once a CLI slot is free, right before the spawn. */
			precondition?:
				| (() => Promise<ClassifiedSupabaseError | undefined>)
				| undefined;
		}> = {}
	): Promise<SupabaseOutcome<T>> {
		const blocked = this.#blockedCli();
		if (blocked) return { ok: false, error: blocked };
		let argv: readonly string[];
		try {
			argv = buildSupabaseArgv(cli.dialect, operation);
		} catch (error) {
			return { ok: false, error: runnerFailure(error) };
		}
		const budget = supabaseOperationBudget(operation);
		return this.#childGate.run(async () => {
			try {
				// A read that waited for a CLI slot, or behind another list, can
				// get its turn once the feature is off: then it spawns nothing.
				if (!this.enabled()) return { ok: false, error: OFF_ERROR };
				const refused = await options.precondition?.();
				if (refused) return { ok: false, error: refused };
				const result = await this.runner.run({
					binaryPath: cli.binaryPath,
					argv,
					cwd: this.cwd,
					timeoutMs: budget.timeoutMs,
					interruptGraceMs: budget.interruptGraceMs,
					...(budget.forceKillAfterMs === undefined
						? {}
						: { forceKillAfterMs: budget.forceKillAfterMs }),
					...(options.signal ? { signal: options.signal } : {}),
					environment: this.#cliEnvironment(),
				});
				return interpretSupabaseResult(result, project, {
					...(options.expectOutput
						? { expectOutput: options.expectOutput }
						: {}),
				});
			} catch (error) {
				return { ok: false, error: runnerFailure(error) };
			}
		});
	}

	/**
	 * `stack logs`, newest first within the character budget. Output longer
	 * than the runner reads is read again with a quarter of the tail, so a
	 * busy window shows its newest lines instead of failing.
	 */
	async readLogs(
		cli: ResolvedSupabaseCli,
		operation: Extract<SupabaseCliOperation, { kind: 'stack.logs' }>
	): Promise<SupabaseOutcome<SupabaseStackLogs>> {
		let tail = operation.tail;
		for (;;) {
			const outcome = await this.runRead(cli, { ...operation, tail }, (json) =>
				parseSupabaseStackLogs(json, {
					maxCharacters: SUPABASE_MAX_LOG_CHARACTERS,
				})
			);
			if (outcome.ok) {
				return tail === operation.tail
					? outcome
					: { ok: true, value: { ...outcome.value, truncated: true } };
			}
			if (
				outcome.error.details.stdoutTruncated !== true ||
				tail <= MIN_LOG_TAIL
			) {
				return outcome;
			}
			tail = Math.max(MIN_LOG_TAIL, Math.floor(tail / 4));
		}
	}

	/**
	 * A lifecycle call, detached so it survives the request and the app, its
	 * stderr streamed into the job's steps. The child is recorded so a
	 * restarted desktop can adopt it, and the job's cancel interrupts it
	 * (SIGINT, then SIGTERM after the grace; never SIGKILL).
	 */
	async #runLifecycle<T>(
		cli: ResolvedSupabaseCli,
		operation: SupabaseCliOperation,
		project: (json: unknown, stderrLines: readonly string[]) => T,
		job: SupabaseEngineJob | undefined,
		options: Readonly<{
			label: string;
			leasedPorts?: Readonly<Record<string, string>> | undefined;
			/** Checked once a CLI slot is free, right before the spawn. */
			precondition?:
				| (() => Promise<ClassifiedSupabaseError | undefined>)
				| undefined;
		}>
	): Promise<SupabaseOutcome<T>> {
		const blocked = this.#blockedCli();
		if (blocked) return { ok: false, error: blocked };
		let argv: readonly string[];
		try {
			argv = buildSupabaseArgv(cli.dialect, operation);
		} catch (error) {
			return { ok: false, error: runnerFailure(error) };
		}
		const budget = supabaseOperationBudget(operation);
		return this.#childGate.run(async () => {
			try {
				const refused = await options.precondition?.();
				if (refused) return { ok: false, error: refused };
				const handle = await this.runner.spawnDetached({
					binaryPath: cli.binaryPath,
					argv,
					cwd: this.cwd,
					timeoutMs: budget.timeoutMs,
					interruptGraceMs: budget.interruptGraceMs,
					...(budget.forceKillAfterMs === undefined
						? {}
						: { forceKillAfterMs: budget.forceKillAfterMs }),
					progressDirectory: this.progressDirectory,
					progressLabel: options.label,
					...(job
						? { onStderrLine: (line: string) => job.progress(line) }
						: {}),
					environment: this.#cliEnvironment(options.leasedPorts),
				});
				this.#lifecycleResults.add(handle.result);
				void handle.result.finally(() =>
					this.#lifecycleResults.delete(handle.result)
				);
				if (job) {
					this.#jobInterrupts.set(job.id, handle.interrupt);
					if (job.signal.aborted) handle.interrupt();
					await this.jobStore
						.recordChild({
							jobId: job.id,
							pid: handle.pid,
							startedAt: this.now(),
							argvDigest: supabaseArgvDigest([cli.binaryPath, ...argv]),
							progressFile: handle.progressFile,
							stackIds: [...job.stackIds].slice(0, 32),
						})
						.catch(() => undefined);
				}
				const result = await handle.result;
				if (job) {
					this.#jobInterrupts.delete(job.id);
					await this.jobStore.releaseChild(job.id).catch(() => undefined);
				}
				return interpretSupabaseResult(result, project);
			} catch (error) {
				return { ok: false, error: runnerFailure(error) };
			}
		});
	}

	errorView(error: ClassifiedSupabaseError): SupabaseErrorView {
		return toSupabaseErrorView(error, {
			pathLabel: (value) => this.pathLabel(value),
		});
	}

	// -------------------------------------------------------------------------
	// Inventory, status, exposure, measurements

	/**
	 * `stack list`, single-flight. A caller never joins a list that began
	 * before it asked: one that just started, stopped or destroyed a stack
	 * must see that in the result.
	 */
	refreshList(): Promise<void> {
		return this.#flights.runFresh('list', async () => {
			const cli = this.newestCli();
			if (!cli) {
				if (
					this.allFacts().some((facts) => facts.detection?.status === 'found')
				) {
					this.#listFailure = {
						message:
							'No tracked worktree has a Supabase CLI RN Devtools can run, so stacks cannot be listed.',
						at: this.now(),
					};
				}
				this.markDirty();
				return;
			}
			const outcome = await this.runRead(
				cli,
				{ kind: 'stack.list' },
				(json, stderr) => parseSupabaseStackList(json, stderr)
			);
			// Turned off meanwhile: nothing is kept, and no status is read.
			if (!this.enabled()) return;
			const now = this.now();
			if (!outcome.ok) {
				this.#listFailure = {
					message: redactSupabaseStoredText(
						`${outcome.error.title}: ${outcome.error.message}`,
						1_024
					),
					at: now,
				};
				this.markDirty();
				return;
			}
			const previous = new Map(
				(this.#list?.stacks ?? []).map((entry) => [entry.id, entry])
			);
			const previousAt = this.#lastListAt ?? 0;
			this.#list = outcome.value;
			this.#lastListAt = now;
			this.#listFailure = undefined;
			const changed: string[] = [];
			const listed = new Set<string>();
			for (const entry of outcome.value.stacks) {
				listed.add(entry.id);
				const old = previous.get(entry.id);
				const cached = this.#statuses.get(entry.id);
				if (
					old &&
					old.owner === entry.owner &&
					old.runtime === entry.runtime &&
					old.branchContext === entry.branchContext &&
					cached?.status !== undefined &&
					// Read or confirmed at the last list: one that list left unread
					// (it reads 16 at most) may be stale, so it is read, not confirmed.
					(cached.checkedAt ?? 0) >= previousAt &&
					(cached.failure === undefined ||
						cached.failure.at < (cached.checkedAt ?? 0))
				) {
					// The list confirms the last status read is still current.
					this.#statuses.set(entry.id, { ...cached, checkedAt: now });
				} else {
					changed.push(entry.id);
				}
			}
			for (const stackId of [...this.#statuses.keys()]) {
				if (!listed.has(stackId)) {
					this.#statuses.delete(stackId);
					this.#exposure.delete(stackId);
				}
			}
			for (const entry of outcome.value.unreadable) {
				this.#stackFolders.set(
					entry.id,
					await this.#pathExists(
						path.join(this.supabaseHome(), 'stacks', entry.id)
					)
				);
			}
			this.markDirty();
			// Turned off while it checked the unreadable folders: no status is
			// read until it is on.
			if (!this.enabled()) return;
			await Promise.all(
				changed
					.slice(0, MAX_STATUS_READS_PER_LIST)
					.map((stackId) => this.readStatus(stackId))
			);
		});
	}

	/** The list, refreshed when it is older than `maxAgeMs`. */
	async freshList(maxAgeMs = LIST_FRESH_MS): Promise<void> {
		if (
			this.#lastListAt === undefined ||
			this.now() - this.#lastListAt > maxAgeMs
		) {
			await this.refreshList();
		}
	}

	/** One `stack status` read through the owner's validated CLI. */
	readStatus(stackId: string): Promise<SupabaseStackStatus | undefined> {
		return this.#statusFlights.run(stackId, async () => {
			// Off, nothing is read, not even the version of the binary to use.
			if (!this.enabled()) return undefined;
			const cli = await this.ownerCli(stackId);
			if (!cli) return undefined;
			const outcome = await this.runRead(
				cli,
				{ kind: 'stack.status', stackId },
				parseSupabaseStackStatus
			);
			// Turned off meanwhile: nothing is kept.
			if (!this.enabled()) return undefined;
			const now = this.now();
			const previous = this.#statuses.get(stackId);
			if (!outcome.ok) {
				this.#statuses.set(stackId, {
					...(previous?.status ? { status: previous.status } : {}),
					...(previous?.checkedAt === undefined
						? {}
						: { checkedAt: previous.checkedAt }),
					failure: { error: this.errorView(outcome.error), at: now },
				});
				this.markDirty();
				return undefined;
			}
			const status = outcome.value;
			this.#statuses.set(stackId, { status, checkedAt: now });
			if (status.configDrift?.status === 'unchanged') {
				await this.#forgetRecreate(stackId);
			}
			if (status.publicEndpoints) {
				this.#endpoints.set(stackId, status.publicEndpoints);
			}
			this.#rememberCredentials(
				stackId,
				status.credentials,
				status.lifecycle === 'running'
			);
			if (status.owner !== 'reachable') {
				const exposure = this.#exposure.get(stackId);
				if (exposure?.verdict === 'loopback') this.#exposure.delete(stackId);
			}
			this.#markLanesStale(stackId);
			this.markDirty();
			return status;
		});
	}

	/**
	 * The status read that lifecycle work ends with. Off by then (the
	 * turn-off's own stops, or work that was running at it), nothing is read,
	 * and a read that ends while off keeps nothing, even one that began before
	 * the turn-off: either way the last status is dropped instead, so once on
	 * again the stack never shows as it was before that work. Only those two
	 * drop it: a read that a turn-off and a turn-on both land during ends
	 * while on, so it keeps what it read, and until it ends the stack shows as
	 * it was before.
	 */
	async #rereadStatus(stackId: string): Promise<void> {
		if (this.enabled()) await this.readStatus(stackId);
		if (!this.enabled()) this.#statuses.delete(stackId);
	}

	/**
	 * The configuration matches the saved stack again (the setting it could
	 * not adopt was reverted), so it starts and keeps its data.
	 */
	async #forgetRecreate(stackId: string): Promise<void> {
		if (!this.stackStore.record(stackId)?.flags.needsRecreate) return;
		await this.stackStore.updateRecord(stackId, (draft) => {
			const { needsRecreate: _needsRecreate, ...flags } = draft.flags;
			const { lastError, recreateError: _recreateError, ...rest } = draft;
			return {
				...rest,
				...(lastError && lastError.code !== 'needs_recreate'
					? { lastError }
					: {}),
				flags,
			};
		});
	}

	/** Keeps public keys across reads; DB_URL only while the database runs. */
	#rememberCredentials(
		stackId: string,
		credentials: MainOnlyCredentials,
		running: boolean
	): void {
		const old = this.#credentials.get(stackId);
		const merged = new MainOnlyCredentials({
			publishableKey: credentials.publishableKey ?? old?.publishableKey,
			anonKey: credentials.anonKey ?? old?.anonKey,
			dbUrl: running ? (credentials.dbUrl ?? old?.dbUrl) : undefined,
		});
		this.#credentials.set(stackId, merged);
	}

	/**
	 * lsof over the owner's process tree, never JSON addresses. An owner
	 * list that can't be read is an unknown verdict, not a clean one;
	 * `not-running` means the owner list was read and has no owner for it.
	 */
	async verifyExposure(
		stackId: string
	): Promise<'loopback' | 'lan-exposed' | 'unknown' | 'not-running'> {
		await this.#readOwners();
		let verdict: 'loopback' | 'lan-exposed' | 'unknown' = 'unknown';
		if (this.#owners?.status === 'ok') {
			const owner = this.ownerOf(stackId);
			if (!owner) {
				if (this.#exposure.get(stackId)?.verdict === 'loopback') {
					this.#exposure.delete(stackId);
				}
				this.markDirty();
				return 'not-running';
			}
			const tree = await this.#discoveryNow().processTree(owner.pid, {
				stackId,
			});
			if (tree.status === 'ok') {
				const exposure = await this.#discoveryNow().checkExposure(tree.pids);
				verdict =
					exposure.status !== 'ok'
						? 'unknown'
						: exposure.nonLoopback.length > 0
							? 'lan-exposed'
							: 'loopback';
			}
		}
		this.#exposure.set(stackId, { verdict, checkedAt: this.now() });
		this.markDirty();
		return verdict;
	}

	/**
	 * Verifies a stack listens only on loopback; a listener elsewhere, or a
	 * check that fails, stops it and fails the operation (fail closed). A
	 * stack expected to run whose owner is missing counts as unverified,
	 * unless the caller only sweeps (`notRunning: 'pass'`).
	 */
	async enforceExposure(
		stackId: string,
		job: SupabaseEngineJob | undefined,
		options: Readonly<{ notRunning?: 'pass' | 'fail' }> = {}
	): Promise<SupabaseStepResult> {
		const checked = await this.verifyExposure(stackId);
		if (checked === 'loopback') return { ok: true };
		if (checked === 'not-running' && options.notRunning === 'pass') {
			return { ok: true };
		}
		const verdict = checked === 'lan-exposed' ? 'lan-exposed' : 'unknown';
		await this.stopStep(stackId, job, { clearPin: false });
		this.#exposure.set(stackId, { verdict, checkedAt: this.now() });
		this.markDirty();
		return {
			ok: false,
			error:
				verdict === 'lan-exposed'
					? supabaseDesktopError(
							'refused',
							'A service of this stack listened on an address other than 127.0.0.1, so RN Devtools stopped it. Its data is kept.',
							{
								title: LAN_EXPOSED_TITLE,
								recovery:
									'Check supabase/config.toml for listener addresses, then start it again.',
							}
						)
					: supabaseDesktopError(
							'refused',
							"RN Devtools couldn't verify that this stack listens only on this Mac, so it stopped it. Its data is kept.",
							{
								title: 'Exposure could not be verified',
								recovery: 'Start it again; RN Devtools checks it each time.',
							}
						),
		};
	}

	async #sweepExposure(): Promise<void> {
		for (const record of this.stackStore.records()) {
			if (record.origin !== 'managed' && record.origin !== 'adopted') continue;
			if (record.runtime === 'docker' || record.runtime === 'podman') continue;
			if (!this.ownerOf(record.id) || this.#jobActive(record.id)) continue;
			await this.lockStack(record.id, async () => {
				// Turned off while it waited for the lock: nothing is probed.
				if (!this.#active) return;
				await this.enforceExposure(record.id, undefined, {
					notRunning: 'pass',
				});
			});
		}
	}

	async #measureMemory(): Promise<void> {
		if (this.#owners?.status !== 'ok') return;
		const now = this.now();
		for (const owner of this.#owners.owners.slice(0, 32)) {
			// Turned off meanwhile: nothing more is measured.
			if (!this.#active) return;
			const tree = await this.#discoveryNow().processTree(owner.pid, {
				stackId: owner.stackId,
			});
			if (tree.status !== 'ok' || !this.#active) continue;
			const memory = await this.#discoveryNow().measureMemory(tree.pids);
			if (memory.status === 'ok') {
				this.#memory.set(owner.stackId, {
					bytes: memory.bytes,
					measuredAt: now,
				});
			}
		}
		for (const stackId of [...this.#memory.keys()]) {
			if (!this.ownerOf(stackId)) this.#memory.delete(stackId);
		}
	}

	async #measureDisk(): Promise<void> {
		const home = this.supabaseHome();
		const ids = [
			...new Set([
				...this.listEntries().map((entry) => entry.id),
				...(this.#list?.unreadable ?? []).map((entry) => entry.id),
			]),
		].slice(0, 63);
		const now = this.now();
		const result = await this.#discoveryNow().measureDisk([
			...ids.map((id) => path.join(home, 'stacks', id)),
			path.join(home, 'cache'),
		]);
		if (result.status !== 'ok') return;
		for (const [index, id] of ids.entries()) {
			const measured = result.entries[index];
			const projectRoot =
				this.entry(id)?.projectRoot ?? this.stackStore.record(id)?.projectRoot;
			const uploads =
				projectRoot === undefined
					? undefined
					: await measureSupabaseDirectory(
							supabaseUploadsPath(projectRoot, id),
							{ now: this.now }
						);
			this.#disk.set(id, {
				...(measured?.status === 'ok' ? { stackBytes: measured.bytes } : {}),
				...(uploads ? { uploadsBytes: uploads.bytes } : {}),
				measuredAt: now,
			});
		}
		const cache = result.entries[ids.length];
		this.#cache =
			cache?.status === 'ok'
				? {
						bytes: cache.bytes,
						state: cache.bytes > 0 ? 'warm' : 'cold',
						measuredAt: now,
					}
				: cache?.status === 'unavailable' && cache.reason === 'missing'
					? { state: 'cold', measuredAt: now }
					: { state: 'unknown' };
	}

	/** Whether a first start on this Mac would download services. */
	#coldCache(): boolean | undefined {
		return this.#cache?.state === 'cold'
			? true
			: this.#cache?.state === 'warm'
				? false
				: undefined;
	}

	// -------------------------------------------------------------------------
	// Lanes

	attachLane(
		attachment: Readonly<{
			laneId: string;
			stackId: string;
			worktreePath: string;
			agent?: DeviceHolder | undefined;
		}>
	): void {
		const existing = this.#attachments.get(attachment.laneId);
		const same = existing?.stackId === attachment.stackId;
		this.#attachments.set(attachment.laneId, {
			laneId: attachment.laneId,
			stackId: attachment.stackId,
			worktreePath: attachment.worktreePath,
			...(attachment.agent ? { agent: attachment.agent } : {}),
			since: same && existing ? existing.since : this.now(),
			pending: !this.#lanes().some((lane) => lane.id === attachment.laneId),
			...(same && existing?.envFingerprint !== undefined
				? { envFingerprint: existing.envFingerprint }
				: {}),
			needsMetroRestart: same && existing ? existing.needsMetroRestart : false,
		});
		this.markDirty();
	}

	/**
	 * Remembers that a lane runs this stack's app on its Simulator, and says
	 * whether that Simulator last ran against another stack: the app may
	 * still be signed in there, and the session carries over.
	 */
	noteServedSimulator(stackId: string, laneId: string): boolean {
		const udid = this.deps.lanes.laneById(laneId)?.simulatorUdid.toUpperCase();
		if (udid === undefined) return false;
		// A Simulator is listed on one record only: the stack it last ran.
		const previous = this.stackStore
			.records()
			.find((record) =>
				record.servedSimulators?.some((entry) => entry.udid === udid)
			);
		if (previous?.id === stackId) return false;
		if (this.stackStore.record(stackId)) {
			const at = this.now();
			if (previous) {
				this.track(
					this.stackStore.updateRecord(previous.id, (draft) => ({
						...draft,
						servedSimulators: (draft.servedSimulators ?? []).filter(
							(entry) => entry.udid !== udid
						),
					}))
				);
			}
			this.track(
				this.stackStore.updateRecord(stackId, (draft) => ({
					...draft,
					servedSimulators: [
						{ udid, at },
						...(draft.servedSimulators ?? []).filter(
							(entry) => entry.udid !== udid
						),
					].slice(0, SUPABASE_MAX_SERVED_SIMULATORS),
				}))
			);
		}
		return previous !== undefined;
	}

	/** Notes what a lane's Metro was given, so a later change asks for a restart. */
	laneServed(laneId: string, envFingerprint: string): void {
		const attachment = this.#attachments.get(laneId);
		if (!attachment) return;
		attachment.envFingerprint = envFingerprint;
		attachment.needsMetroRestart = false;
		this.markDirty();
	}

	describeWorktree(worktreePath: string): LaneWorktreeSupabase | undefined {
		if (!this.enabled()) return undefined;
		const facts = this.allFacts().find(
			(candidate) => candidate.worktreePath === worktreePath
		);
		if (!facts) return undefined;
		const found =
			facts.detection?.status === 'found' ? facts.detection : undefined;
		switch (facts.mode.value) {
			case 'managed':
				return {
					project: 'managed',
					...(found && found.pinnedListeners.length > 0
						? { portsPinned: true }
						: {}),
				};
			case 'observed': {
				// Still being read: the start decides.
				if (facts.detection === undefined) return undefined;
				const reasonText =
					facts.mode.reasonText === undefined
						? ''
						: sanitizeSupabaseDisplayText(facts.mode.reasonText, 512);
				return {
					project: 'observed',
					...(reasonText.length > 0 ? { reasonText } : {}),
				};
			}
			case 'off':
				// A repository turned off reads nothing; its rows say so.
				return facts.detection?.status === 'none'
					? { project: 'none' }
					: undefined;
		}
	}

	/** Lane down: drops the lane's hold without waiting; idempotent. */
	detachLane(laneId: string): void {
		if (!this.#attachments.delete(laneId)) return;
		this.markDirty();
		if (this.#active) this.#schedule('holds', 0, () => this.reconcileHolds());
	}

	attachmentsOf(stackId: string): readonly Readonly<LaneAttachment>[] {
		return [...this.#attachments.values()].filter(
			(attachment) => attachment.stackId === stackId
		);
	}

	attachment(laneId: string): Readonly<LaneAttachment> | undefined {
		return this.#attachments.get(laneId);
	}

	/**
	 * Restore only an explicit durable backend choice, on the lane's own app
	 * and current branch. An off or legacy lane must not gain a backend hold
	 * just because its environment defaults to auto.
	 */
	#deriveLaneAttachments(): void {
		for (const lane of this.#lanes()) {
			if (this.#attachments.has(lane.id) || lane.metro === 'stopped') continue;
			if (lane.backendPolicy !== 'auto' && lane.backendPolicy !== 'required') {
				continue;
			}
			const appPath = lane.appPath ?? lane.worktreePath;
			const facts = this.allFacts().find(
				(candidate) =>
					candidate.worktreePath === lane.worktreePath &&
					candidate.appPath === appPath &&
					candidate.mode.value === 'managed'
			);
			const stackId = facts?.expectedStackId;
			if (!stackId || !this.ownerOf(stackId)) continue;
			this.attachLane({
				laneId: lane.id,
				stackId,
				worktreePath: lane.worktreePath,
				...(lane.agent
					? {
							agent: {
								kind: lane.agent.kind,
								sessionId: lane.agent.sessionId,
							},
						}
					: {}),
			});
		}
	}

	/**
	 * Restarts the Metro of every running lane on a stack except `skip`,
	 * without waiting: restartMetro asks this service for the lane's values
	 * from inside the lane's own queue, so awaiting it here could deadlock an
	 * ensure that lane is waiting on.
	 */
	restartAttachedMetro(
		stackId: string,
		reason: 'ports-moved' | 'follow',
		skip?: string
	): void {
		for (const attachment of this.attachmentsOf(stackId)) {
			if (attachment.laneId === skip || attachment.pending) continue;
			const lane = this.#lanes().find(
				(candidate) => candidate.id === attachment.laneId
			);
			if (!lane || lane.metro === 'stopped') continue;
			void this.deps.lanes
				.restartMetro(attachment.laneId, reason)
				.catch((error: unknown) => {
					const current = this.#attachments.get(attachment.laneId);
					if (current) current.needsMetroRestart = true;
					this.log(
						`Metro for lane ${attachment.laneId.slice(0, 13)} could not be restarted: ${errorName(error)}`
					);
					this.markDirty();
				});
		}
	}

	/** Marks lanes whose Metro has older values than the stack serves now. */
	#markLanesStale(stackId: string): void {
		const env = supabaseLaneEnv(
			this.policySnapshot().policy.appEnv,
			this.endpointsOf(stackId),
			this.credentialsOf(stackId)
		);
		if (env.names.length === 0) return;
		for (const attachment of this.#attachments.values()) {
			if (
				attachment.stackId === stackId &&
				attachment.envFingerprint !== undefined &&
				attachment.envFingerprint !== env.fingerprint
			) {
				attachment.needsMetroRestart = true;
			}
		}
	}

	#holdLanes(stackId: string): SupabaseHoldLane[] {
		const lanes = this.#lanes();
		const result: SupabaseHoldLane[] = [];
		for (const attachment of [...this.#attachments.values()]) {
			if (attachment.stackId !== stackId) continue;
			const lane = lanes.find(
				(candidate) => candidate.id === attachment.laneId
			);
			if (!lane && !attachment.pending) {
				// The lane is gone without a detach (a crash, a store edit).
				this.#attachments.delete(attachment.laneId);
				continue;
			}
			if (lane && attachment.pending) attachment.pending = false;
			const agent = lane?.agent
				? { kind: lane.agent.kind, sessionId: lane.agent.sessionId }
				: attachment.agent;
			result.push({
				laneId: attachment.laneId,
				...(agent ? { agent } : {}),
				worktreePath: lane?.worktreePath ?? attachment.worktreePath,
				since: lane?.startedAt ?? attachment.since,
			});
		}
		return result;
	}

	// -------------------------------------------------------------------------
	// Holds and automatic stops

	isLive(stackId: string): boolean {
		if (this.ownerOf(stackId)) return true;
		const status = this.#statuses.get(stackId)?.status;
		if (status?.lifecycle === 'running' || status?.lifecycle === 'starting') {
			return status.owner === 'reachable';
		}
		return (
			this.#owners?.status !== 'ok' &&
			this.entry(stackId)?.owner === 'reachable'
		);
	}

	#jobActive(stackId: string): boolean {
		return this.jobStore
			.activeJobs()
			.some((job) => job.stackIds.includes(stackId));
	}

	#resolveHolds(
		record: SupabaseStackRecord,
		ignore?: Readonly<{ holder: DeviceHolder; sessionCwd?: string | undefined }>
	): SupabaseHoldsResult {
		const check = this.#pathChecks.get(record.id);
		return resolveSupabaseHolds({
			now: this.now(),
			policy: this.policySnapshot().policy,
			stack: supabaseHoldsStack(record, {
				live: this.isLive(record.id),
				orphaned: (check?.projectRootMissingChecks ?? 0) >= 2,
				...(check?.missingSince === undefined
					? {}
					: { orphanedAt: check.missingSince }),
			}),
			lanes: this.#holdLanes(record.id),
			sessions: this.#sessions(),
			discovery: this.#sessionDiscovery(),
			...(ignore ? { ignore } : {}),
		});
	}

	/** The holds the state shows for a stack. */
	holdsOf(stackId: string): SupabaseHoldsResult | undefined {
		return this.#holds.get(stackId);
	}

	/** Holds resolved for a record, ignoring a releasing session's own cwd. */
	holdsIgnoring(
		record: SupabaseStackRecord,
		ignore: Readonly<{ holder: DeviceHolder; sessionCwd?: string | undefined }>
	): SupabaseHoldsResult {
		return this.#resolveHolds(record, ignore);
	}

	/** Recomputes every stack's holds, persists clocks, runs the stops due now. */
	reconcileHolds(): Promise<void> {
		return this.#flights.run('holds', async () => {
			const known = new Set<string>();
			for (const record of this.stackStore.records()) {
				known.add(record.id);
				const result = this.#resolveHolds(record);
				if (!sameSupabaseClocks(result.clocks, record.clocks)) {
					await this.stackStore.setClocks(record.id, result.clocks);
				}
				if (result.release !== undefined) {
					await this.stackStore.applyRelease(record.id, result.release);
				}
				this.#holds.set(record.id, result);
			}
			// Stacks without a record still show their lanes and sessions.
			for (const entry of this.listEntries()) {
				if (known.has(entry.id)) continue;
				known.add(entry.id);
				this.#holds.set(
					entry.id,
					resolveSupabaseHolds({
						now: this.now(),
						policy: this.policySnapshot().policy,
						stack: {
							origin: 'external',
							live: this.isLive(entry.id),
							directory:
								this.factsForStack(entry.id, undefined, entry)?.worktreePath ??
								entry.projectRoot,
							pinned: false,
							holds: [],
							orphaned: false,
							clocks: {},
						},
						lanes: this.#holdLanes(entry.id),
						sessions: this.#sessions(),
						discovery: this.#sessionDiscovery(),
					})
				);
			}
			for (const stackId of [...this.#holds.keys()]) {
				if (!known.has(stackId)) this.#holds.delete(stackId);
			}
			this.markDirty();
			if (!this.#active) return;
			const now = this.now();
			const due = dueSupabaseStops(
				[...this.#holds].map(([stackId, result]) => ({
					stackId,
					autoStopAt: result.autoStopAt,
					autoStopReason: result.autoStopReason,
					inFlight: this.#jobActive(stackId),
				})),
				now
			);
			for (const stop of due) {
				// Re-check the holders right before stopping.
				const record = this.stackStore.record(stop.stackId);
				if (!record) continue;
				const fresh = this.#resolveHolds(record);
				if (fresh.autoStopAt === undefined || fresh.autoStopAt > now) continue;
				this.track(
					this.stopJob(stop.stackId, stop.requestedBy, { ifStillDue: true })
				);
			}
			const next = [...this.#holds.values()]
				.map((result) => result.autoStopAt)
				.filter((at): at is number => at !== undefined && at > now)
				.sort((left, right) => left - right)[0];
			if (next !== undefined) {
				this.#schedule('autostop', next - now + 50, () =>
					this.reconcileHolds()
				);
			}
		});
	}

	/**
	 * A stop as a job, under the stack's lock and the lifecycle gate (two at
	 * a time). `ungated` skips the gate for the stops admission makes, which
	 * already run inside a gated start. `ifStillDue` checks an automatic stop
	 * again once it has its turn, and skips a stack held again meanwhile.
	 */
	stopJob(
		stackId: string,
		requestedBy: JobRequester,
		options: Readonly<{
			clearPin?: boolean;
			ungated?: boolean;
			ifStillDue?: boolean;
		}> = {}
	): Promise<
		Readonly<{ jobId: string; done: Promise<SupabaseEngineJobOutcome> }>
	> {
		return this.startJob(
			{
				kind: 'stop',
				stackIds: [stackId],
				requestedBy,
				cancellable: false,
				steps: initialSupabaseJobSteps('stop'),
			},
			(job) => {
				const work = () =>
					this.lockStack(
						stackId,
						async (): Promise<SupabaseEngineJobOutcome> => {
							const off = this.calledOff();
							if (off) return off;
							job.begin();
							if (options.ifStillDue && !this.#stopStillDue(stackId)) {
								job.step('stop', 'skipped', 'In use again');
								return { status: 'complete' };
							}
							const result = await this.stopStep(stackId, job, {
								clearPin: options.clearPin === true,
							});
							return result.ok
								? { status: 'complete' }
								: { status: 'failed', error: result.error };
						}
					);
				return options.ungated ? work() : this.#lifecycleGate.run(work);
			}
		);
	}

	/** Nothing holds the stack and its unheld linger has run out. */
	#stopStillDue(stackId: string): boolean {
		const record = this.stackStore.record(stackId);
		if (!record) return false;
		const holds = this.#resolveHolds(record);
		return holds.autoStopAt !== undefined && holds.autoStopAt <= this.now();
	}

	/** Docker or Podman stacks on a managed identity: stopped once, never attached. */
	async #stopContainerStacks(): Promise<void> {
		if (!this.policySnapshot().policy.stopContainerStacksOnce) return;
		const managedIds = new Set(
			this.allFacts().flatMap((facts) =>
				facts.mode.value === 'managed' && facts.expectedStackId
					? [facts.expectedStackId]
					: []
			)
		);
		for (const entry of this.listEntries()) {
			if (entry.runtime !== 'docker' && entry.runtime !== 'podman') continue;
			const record = this.stackStore.record(entry.id);
			const managed =
				managedIds.has(entry.id) ||
				record?.origin === 'managed' ||
				record?.origin === 'adopted';
			if (
				!managed ||
				entry.owner !== 'reachable' ||
				this.#containerStopped.has(entry.id) ||
				record?.flags.containerStoppedAt !== undefined ||
				this.#jobActive(entry.id)
			) {
				continue;
			}
			this.#containerStopped.add(entry.id);
			await this.#markContainerStopped(entry);
			this.track(
				this.stopJob(entry.id, { kind: 'automatic', reason: 'container' }).then(
					async ({ done }) => {
						// Called off by a turn-off: it is stopped once the feature is on.
						if ((await done).status === 'cancelled') {
							await this.#unmarkContainerStopped(entry.id);
						}
					}
				)
			);
		}
	}

	async #unmarkContainerStopped(stackId: string): Promise<void> {
		this.#containerStopped.delete(stackId);
		if (!this.stackStore.record(stackId)) return;
		await this.stackStore.updateRecord(stackId, (draft) => {
			const { containerStoppedAt: _stoppedAt, ...flags } = draft.flags;
			return { ...draft, flags };
		});
	}

	async #markContainerStopped(entry: SupabaseStackListEntry): Promise<void> {
		const now = this.now();
		if (this.stackStore.record(entry.id)) {
			await this.stackStore.updateRecord(entry.id, (draft) => ({
				...draft,
				flags: { ...draft.flags, containerStoppedAt: now },
			}));
			return;
		}
		const facts = this.factsForStack(entry.id, undefined, entry);
		await this.stackStore.upsertRecord({
			id: entry.id,
			origin: 'external',
			name: entry.name || 'default',
			projectRoot: entry.projectRoot,
			...(facts ? { worktreePath: facts.worktreePath } : {}),
			appPaths: [],
			...(facts ? { repositoryId: facts.repositoryId } : {}),
			branchContext: entry.branchContext,
			createdBy: { via: 'external' },
			createdAt: now,
			runtime: entry.runtime,
			pinned: false,
			holds: [],
			clocks: {},
			exclusions: [],
			studioEnabled: false,
			flags: { containerStoppedAt: now },
		});
	}

	// -------------------------------------------------------------------------
	// Drift, follow, hardening, steering

	async #planDrift(): Promise<void> {
		const stacks: SupabaseDriftStack[] = [];
		for (const record of this.stackStore.records()) {
			if (record.origin !== 'managed' && record.origin !== 'adopted') continue;
			const owner = this.ownerOf(record.id);
			if (!owner) continue;
			const ownerValidation = await this.#validateBinary(owner.executable);
			// Turned off meanwhile: nothing more is validated or restarted.
			if (!this.#active) return;
			// Only a worktree still on the stack's branch may restart it.
			const facts = this.factsForStack(record.id, record);
			stacks.push({
				stackId: record.id,
				recordedBinary: record.binaryPath,
				recordedVersion: record.cliVersion,
				ownerExecutable: owner.executable,
				ownerValidation,
				worktreeCli:
					facts?.expectedStackId === record.id ? facts.cli : undefined,
				inFlight: this.#jobActive(record.id),
			});
		}
		const plan = planSupabaseDrift({
			stacks,
			previous: this.#drift,
			attempted: this.#driftAttempted,
			now: this.now(),
		});
		this.#drift = new Map(plan.pending);
		this.#cliChanged.clear();
		for (const stackId of plan.changed) this.#cliChanged.add(stackId);
		for (const { stackId, signature } of plan.restart) {
			const view = this.view(stackId);
			if (!view.facts) continue;
			this.#driftAttempted.set(stackId, signature);
			this.track(
				this.restartWithWorktreeCli(view, {
					kind: 'automatic',
					reason: 'cli-upgrade',
				}).then(async ({ done }) => {
					// Called off by a turn-off, it is tried again once the feature is on.
					if (
						(await done).status === 'cancelled' &&
						this.#driftAttempted.get(stackId) === signature
					) {
						this.#driftAttempted.delete(stackId);
					}
				})
			);
		}
		if (plan.nextDueAt !== undefined) {
			this.#schedule('drift', plan.nextDueAt - this.now() + 50, () =>
				this.#planDrift()
			);
		}
	}

	/** Stop with any validated binary, then start again with the worktree's own. */
	restartWithWorktreeCli(
		view: SupabaseStackView,
		requestedBy: JobRequester
	): Promise<
		Readonly<{ jobId: string; done: Promise<SupabaseEngineJobOutcome> }>
	> {
		const facts = view.facts;
		return this.startJob(
			{
				kind: 'stop-and-start',
				stackIds: [view.id],
				requestedBy,
				cancellable: false,
				steps: initialSupabaseJobSteps('stop-and-start'),
			},
			(job) =>
				this.#lifecycleGate.run(() =>
					this.lockStack(view.id, async () => {
						const off = this.calledOff();
						if (off) return off;
						job.begin();
						if (!facts) {
							return {
								status: 'failed',
								error: supabaseDesktopError(
									'refused',
									"This stack's worktree isn't tracked."
								),
							};
						}
						// Starting again reloads the checkout's config: only on its branch.
						if (!(await this.headMatches(view))) {
							return {
								status: 'failed',
								error: supabaseDesktopError(
									'refused',
									"The worktree is on another branch, so the stack keeps its current CLI until it's back."
								),
							};
						}
						const stopped = await this.stopStep(view.id, job, {
							clearPin: false,
						});
						if (!stopped.ok) return { status: 'failed', error: stopped.error };
						const started = await this.startStep(
							{
								facts,
								stackId: view.id,
								mode: 'resume',
								exclusions: this.exclusionsFor(view.id),
							},
							job
						);
						if (!started.ok) return { status: 'failed', error: started.error };
						return this.verifyAfterStart(started.stackId, job);
					})
				)
		);
	}

	async #planFollows(): Promise<void> {
		const plan = planSupabaseFollows({
			policy: this.policySnapshot().policy,
			facts: this.allFacts(),
			stacks: this.getState().stacks,
			records: new Map(
				this.stackStore.records().map((record) => [record.id, record])
			),
			headStableSince: new Map(
				[...this.#heads].map(([key, head]) => [key, head.since])
			),
			now: this.now(),
			busy: this.#following,
			retries: this.#followRetries,
		});
		for (const candidate of plan.due) {
			this.track(this.#followAutomatically(candidate));
		}
		if (plan.nextDueAt !== undefined) {
			this.#schedule('follow', plan.nextDueAt - this.now() + 50, async () => {
				await this.refreshRepositories();
				await this.#planFollows();
			});
		}
	}

	/**
	 * An automatic follow. One that fails waits longer before each new try
	 * at the same stack instead of starting it on every cheap tick; a HEAD
	 * move to another branch starts over.
	 */
	async #followAutomatically(
		candidate: SupabaseFollowPlan['due'][number]
	): Promise<void> {
		const outcome = await this.followBranch(
			candidate.worktreePath,
			candidate.fromStackIds,
			{ kind: 'automatic', reason: 'follow' },
			undefined,
			candidate.appPath
		);
		if (outcome.status === 'complete') return;
		this.#followRetries.set(
			candidate.projectRoot,
			nextSupabaseFollowRetry(
				this.#followRetries.get(candidate.projectRoot),
				candidate.toStackId,
				this.now()
			)
		);
	}

	/**
	 * Follows a worktree to its current branch: ensures the new identity
	 * natively, moves the old stacks' holds, pin and lanes over, restarts the
	 * attached Metro, then stops the old stacks (data kept; they show as a
	 * stale branch and come back when the worktree switches back). Holds
	 * stay where they were when the new stack cannot start.
	 */
	async followBranch(
		worktreePath: string,
		fromStackIds: readonly string[],
		requestedBy: JobRequester,
		onJob?: (jobId: string) => void,
		appPath?: string
	): Promise<SupabaseEngineJobOutcome> {
		const from = fromStackIds
			.map((id) => this.stackStore.record(id))
			.find((record) => record !== undefined);
		const facts = await this.worktreeFacts(
			worktreePath,
			appPath ?? from?.appPaths[0] ?? from?.projectRoot
		);
		const target = facts?.expectedStackId;
		const projectRoot =
			facts?.detection?.status === 'found'
				? facts.detection.projectRoot
				: undefined;
		if (!facts || !target || !projectRoot || facts.mode.value !== 'managed') {
			return {
				status: 'failed',
				error: supabaseDesktopError(
					'refused',
					"The worktree's new branch isn't managed by RN Devtools, so it was not followed."
				),
			};
		}
		if (
			fromStackIds.some(
				(id) => this.stackStore.record(id)?.projectRoot !== projectRoot
			)
		) {
			return {
				status: 'failed',
				error: supabaseDesktopError(
					'refused',
					'Only stacks from the same Supabase project can follow its branch.'
				),
			};
		}
		if (this.#following.has(projectRoot)) {
			return {
				status: 'failed',
				error: supabaseDesktopError(
					'refused',
					'This Supabase project is already following its branch.'
				),
			};
		}
		this.#following.add(projectRoot);
		try {
			const result = await this.ensureStack(facts, {
				requestedBy,
				createdBy: { via: 'desktop' },
				...(onJob ? { onJob } : {}),
			});
			if (result.kind !== 'ready') {
				return {
					status: 'failed',
					error:
						result.error ?? supabaseDesktopError('refused', result.message),
				};
			}
			const now = this.now();
			const stops: string[] = [];
			for (const fromId of fromStackIds) {
				if (fromId === target) continue;
				const from = this.stackStore.record(fromId);
				for (const hold of from?.holds ?? []) {
					await this.stackStore.addHold(target, { ...hold, since: now });
				}
				if (from?.pinned) await this.stackStore.setPinned(target, true);
				if (from) {
					await this.stackStore.updateRecord(fromId, (draft) => {
						const { pinnedAt: _pinnedAt, ...rest } = draft;
						return {
							...rest,
							holds: [],
							pinned: false,
							flags: { ...draft.flags, supersededAt: now },
						};
					});
				}
				for (const attachment of this.attachmentsOf(fromId)) {
					this.attachLane({ ...attachment, stackId: target });
				}
				stops.push(fromId);
			}
			this.restartAttachedMetro(target, 'follow');
			for (const fromId of stops) {
				const stop = await this.stopJob(
					fromId,
					requestedBy.kind === 'automatic'
						? requestedBy
						: { kind: 'automatic', reason: 'follow' },
					{ clearPin: true }
				);
				await stop.done;
			}
			this.#followRetries.delete(projectRoot);
			await this.reconcileHolds();
			return { status: 'complete' };
		} finally {
			this.#following.delete(projectRoot);
		}
	}

	/**
	 * Per-stack keys for every managed worktree when the policy asks for
	 * them (written where git ignores the file), or the managed block
	 * removed again when it doesn't.
	 */
	async applyPerStackKeys(): Promise<void> {
		const on = this.policySnapshot().policy.perStackKeys;
		const roots = new Map<string, string>();
		for (const facts of this.allFacts()) {
			if (
				facts.mode.value === 'managed' &&
				facts.detection?.status === 'found'
			) {
				roots.set(facts.detection.projectRoot, facts.realWorktreePath);
			}
		}
		for (const [projectRoot, worktreeRoot] of roots) {
			if (!on) {
				await this.keyStore.removeFromWorktree(projectRoot);
				continue;
			}
			const applied = await this.keyStore.applyToWorktree({
				projectRoot,
				worktreeRoot,
			});
			if (applied === 'not-ignored') {
				this.log(
					"Per-stack keys were not written: git doesn't ignore supabase/.env.local in a managed worktree."
				);
			}
		}
	}

	async #startOverrides(
		facts: SupabaseWorktreeFacts
	): Promise<Readonly<Record<string, string>> | undefined> {
		const policy = this.policySnapshot().policy;
		if (facts.detection?.status !== 'found') return undefined;
		if (policy.perStackKeys) {
			await this.keyStore.applyToWorktree({
				projectRoot: facts.detection.projectRoot,
				worktreeRoot: facts.realWorktreePath,
			});
		}
		if (!policy.pinnedPortsCompat) return undefined;
		const names = facts.detection.pinnedListeners.flatMap((listener) => {
			const name = supabasePortOverrideName(listener);
			return name ? [name] : [];
		});
		if (names.length === 0) return undefined;
		return this.portLeases.overridesFor(facts.realWorktreePath, names);
	}

	steering(): SteeringSnapshot {
		const enabled = this.enabled();
		return {
			enabled,
			desktopPid: process.pid,
			writtenAt: this.now(),
			managedRoots: enabled
				? supabaseSteeringRoots({
						facts: this.allFacts(),
						stacks: this.getState().stacks,
					})
				: [],
		};
	}

	async writeSteering(): Promise<void> {
		if (!this.enabled()) {
			await this.steeringWriter.remove();
			return;
		}
		await this.steeringWriter.write(this.steering());
	}

	// -------------------------------------------------------------------------
	// Jobs

	/**
	 * Creates a job and runs `work` in the background. The job stays queued
	 * until the work calls begin() (once it got its turn); its outcome
	 * becomes the job's terminal state and an activity entry.
	 */
	async startJob(
		spec: SupabaseEngineJobSpec,
		work: (job: SupabaseEngineJob) => Promise<SupabaseEngineJobOutcome>
	): Promise<
		Readonly<{ jobId: string; done: Promise<SupabaseEngineJobOutcome> }>
	> {
		const created = await this.jobStore.create({
			kind: spec.kind,
			stackIds: spec.stackIds.slice(0, 32),
			requestedBy: spec.requestedBy,
			cancellable: spec.cancellable,
			...(spec.steps ? { steps: spec.steps } : {}),
			...(spec.migrationTotal === undefined
				? {}
				: { migrationTotal: spec.migrationTotal }),
			...(spec.expectedMs === undefined ? {} : { expectedMs: spec.expectedMs }),
			...(spec.coldCache === undefined ? {} : { coldCache: spec.coldCache }),
		});
		const controller = new AbortController();
		this.#jobControllers.set(created.id, controller);
		let begun = false;
		const job: SupabaseEngineJob = {
			id: created.id,
			stackIds: created.stackIds,
			signal: controller.signal,
			begin: () => {
				if (begun) return;
				begun = true;
				this.jobStore.start(created.id);
			},
			step: (stepId, state, detail) => {
				this.jobStore.markStep(created.id, stepId, state, detail);
			},
			progress: (line) => {
				this.jobStore.progress(created.id, line);
			},
			details: (fields) => {
				this.jobStore.setDetails(created.id, fields);
			},
		};
		const done = (async (): Promise<SupabaseEngineJobOutcome> => {
			let outcome: SupabaseEngineJobOutcome;
			try {
				outcome = await work(job);
			} catch (error) {
				this.log(`Supabase job failed: ${errorName(error)}`);
				outcome = {
					status: 'failed',
					error: supabaseDesktopError(
						'internal',
						'The Supabase operation failed unexpectedly.'
					),
				};
			}
			job.begin();
			if (controller.signal.aborted && outcome.status === 'failed') {
				outcome = { status: 'cancelled' };
			}
			const finished = await this.jobStore.finish(created.id, {
				status: outcome.status,
				...(outcome.error ? { error: outcome.error } : {}),
			});
			this.#jobControllers.delete(created.id);
			this.#jobInterrupts.delete(created.id);
			if (finished) await this.#recordActivity(finished);
			this.markDirty();
			if (this.#active) {
				this.#schedule('after-job', 100, async () => {
					// A creation lists again when it ends; listing meanwhile would
					// only race it.
					if (this.#creationGate.active === 0) await this.refreshList();
					await this.reconcileHolds();
					await this.writeSteering();
				});
			}
			return outcome;
		})();
		this.track(done);
		this.markDirty();
		return { jobId: created.id, done };
	}

	async #recordActivity(job: SupabaseJob): Promise<void> {
		if (isActiveSupabaseJob(job)) return;
		try {
			await this.stackStore.recordActivity({
				id: job.id,
				kind: job.kind,
				stackIds: [...job.stackIds],
				outcome:
					job.status === 'queued' || job.status === 'running'
						? 'lost'
						: job.status,
				...(job.error ? { errorCode: job.error.code } : {}),
				startedAt: job.startedAt,
				durationMs: Math.max(0, job.updatedAt - job.startedAt),
				requestedBy: job.requestedBy.kind,
				...(job.coldCache === undefined ? {} : { coldCache: job.coldCache }),
			});
		} catch (error) {
			this.log(`Supabase activity could not be saved: ${errorName(error)}`);
		}
	}

	/** Cancels a job: SIGINT to its CLI child; the CLI cleans up first. */
	cancelJob(jobId: string): boolean {
		const controller = this.#jobControllers.get(jobId);
		if (!controller) return false;
		this.jobStore.requestCancel(jobId);
		controller.abort();
		this.#jobInterrupts.get(jobId)?.();
		this.markDirty();
		return true;
	}

	job(jobId: string): SupabaseJob | undefined {
		return this.jobStore.job(jobId);
	}

	waitForJob(
		jobId: string,
		timeoutMs: number,
		signal?: AbortSignal
	): Promise<SupabaseJob | undefined> {
		return this.jobStore.waitFor(jobId, timeoutMs, signal);
	}

	activeJobFor(stackId: string): SupabaseJob | undefined {
		return this.jobStore
			.activeJobs()
			.find((job) => job.stackIds.includes(stackId));
	}

	/**
	 * Children a previous desktop left running: followed by pid until they
	 * exit, then their job ends from what their progress file says. A pid
	 * another process reused (after a reboot) is not adopted.
	 */
	async #adoptChildren(
		children: readonly SupabaseDetachedChild[]
	): Promise<void> {
		for (const child of children) {
			if (!this.#processAlive(child.pid) || !(await this.#sameCommand(child))) {
				this.track(this.jobStore.releaseChild(child.jobId));
				this.track(
					removeSupabaseProgressFile(this.progressDirectory, child.progressFile)
				);
				continue;
			}
			if (!this.jobStore.adopt(child.jobId)) continue;
			this.track(this.#followAdopted(child));
		}
	}

	/**
	 * Whether `ps` shows the command the child was started with. ps escapes
	 * the line by the locale it inherits, so both sides are compared as
	 * digests of one form, never as text. Only while the feature is on: off,
	 * nothing is spawned and the pid check decides.
	 */
	async #sameCommand(child: SupabaseDetachedChild): Promise<boolean> {
		if (!this.enabled()) return true;
		const found = await this.#discoveryNow().processCommand(child.pid);
		return (
			found.status === 'ok' &&
			found.command !== undefined &&
			supabaseArgvDigest([found.command]) === child.argvDigest
		);
	}

	async #followAdopted(child: SupabaseDetachedChild): Promise<void> {
		const deadline = child.startedAt + ADOPTED_CHILD_MAX_MS;
		while (
			this.#processAlive(child.pid) &&
			this.now() < deadline &&
			!this.#stopped
		) {
			await supabaseDelay(this.timers, ADOPTED_CHILD_POLL_MS);
		}
		let status: 'complete' | 'failed' | 'lost' = 'lost';
		try {
			const lines = await readSupabaseProgressLines(child.progressFile);
			for (const line of lines.slice(-32)) {
				this.jobStore.progress(child.jobId, line);
			}
			const last = [...lines]
				.reverse()
				.find((line) => line.startsWith('[task] '));
			status = last?.startsWith('[task] done')
				? 'complete'
				: last?.startsWith('[task] failed')
					? 'failed'
					: 'lost';
		} catch {
			status = 'lost';
		}
		await this.jobStore.finish(child.jobId, { status });
		await this.jobStore.releaseChild(child.jobId);
		await removeSupabaseProgressFile(
			this.progressDirectory,
			child.progressFile
		);
		if (this.#active) await this.refreshList();
	}

	// -------------------------------------------------------------------------
	// Lifecycle steps (run inside a job and the stack's lock)

	/** A stack's exclusions: the policy's, minus Studio when the operator enabled it. */
	exclusionsFor(stackId: string | undefined): SupabaseExcludableCapability[] {
		const record =
			stackId === undefined ? undefined : this.stackStore.record(stackId);
		const exclude = this.policySnapshot().policy.exclude;
		return record?.studioEnabled
			? exclude.filter((capability) => capability !== 'studio')
			: [...exclude];
	}

	/**
	 * `stack stop` with any validated binary (busy errors retried at 0.5, 1
	 * and 2 s), then, if that failed, SIGTERM to the owner once pgrep shows
	 * it still is this stack's owner, re-checked right before signalling.
	 */
	async stopStep(
		stackId: string,
		job: SupabaseEngineJob | undefined,
		options: Readonly<{ clearPin: boolean }>
	): Promise<SupabaseStepResult> {
		job?.step('stop', 'current');
		const cli = await this.#stopCli(stackId);
		let error: SupabaseErrorView | undefined;
		let stopped = false;
		if (cli) {
			const delays: number[] = [...BUSY_RETRY_DELAYS_MS];
			for (;;) {
				const outcome = await this.#runLifecycle(
					cli,
					{ kind: 'stack.stop', stackId },
					parseSupabaseStackStop,
					job,
					{ label: 'stop' }
				);
				if (outcome.ok) {
					stopped = true;
					break;
				}
				error = this.errorView(outcome.error);
				const delay =
					outcome.error.code === 'busy' ? delays.shift() : undefined;
				if (delay === undefined) break;
				await supabaseDelay(this.timers, delay);
			}
		}
		if (!stopped && (await this.#terminateOwner(stackId))) stopped = true;
		if (!stopped) {
			job?.step('stop', 'failed', error?.title);
			return {
				ok: false,
				error:
					error ??
					supabaseDesktopError(
						'unavailable',
						'No Supabase CLI RN Devtools can run is available to stop this stack.',
						{
							title: 'Could not stop the stack',
							recovery:
								'Install dependencies in one of its worktrees, then try again.',
						}
					),
			};
		}
		job?.step('stop', 'done');
		await this.#afterStop(stackId, options);
		return { ok: true };
	}

	async #afterStop(
		stackId: string,
		options: Readonly<{ clearPin: boolean }>
	): Promise<void> {
		const now = this.now();
		if (this.stackStore.record(stackId)) {
			await this.stackStore.updateRecord(stackId, (draft) => {
				if (!options.clearPin) return { ...draft, lastStoppedAt: now };
				const { pinnedAt: _pinnedAt, ...rest } = draft;
				return { ...rest, pinned: false, lastStoppedAt: now };
			});
		}
		const credentials = this.#credentials.get(stackId);
		if (credentials) this.#rememberCredentials(stackId, credentials, false);
		const exposure = this.#exposure.get(stackId);
		if (exposure?.verdict === 'loopback') this.#exposure.delete(stackId);
		this.#memory.delete(stackId);
		await this.#readOwners();
		await this.#rereadStatus(stackId);
		this.markDirty();
	}

	async #terminateOwner(stackId: string): Promise<boolean> {
		await this.#readOwners();
		if (this.#owners?.status !== 'ok') return false;
		const owner = this.ownerOf(stackId);
		if (!owner) return true;
		// Re-check right before signalling: the same pid must still own this id.
		const again = await this.#discoveryNow().discoverOwners();
		const same =
			again.status === 'ok' &&
			again.owners.some(
				(candidate) =>
					candidate.pid === owner.pid &&
					candidate.stackId === stackId &&
					candidate.executable === owner.executable
			);
		if (!same) return false;
		try {
			this.#signalProcess(owner.pid, 'SIGTERM');
		} catch {
			return false;
		}
		const deadline = this.now() + OWNER_EXIT_WAIT_MS;
		while (this.now() < deadline) {
			await supabaseDelay(this.timers, OWNER_POLL_MS);
			const owners = await this.#discoveryNow().discoverOwners();
			if (
				owners.status === 'ok' &&
				!owners.owners.some((candidate) => candidate.pid === owner.pid)
			) {
				this.#owners = owners;
				return true;
			}
		}
		return false;
	}

	/**
	 * `stack start` natively: create from the project root, or resume by id
	 * with the exclusions passed again (a resume drops them otherwise). Busy
	 * errors retry with backoff, a partial lifecycle gets one stop and start,
	 * a port collision one more try. Records the start, its binary and
	 * exclusions, the endpoints and the main-only credentials, and restarts
	 * other attached lanes' Metro when the API port moved.
	 */
	async startStep(
		input: Readonly<{
			facts: SupabaseWorktreeFacts;
			stackId?: string | undefined;
			mode: 'create' | 'resume';
			exclusions: readonly SupabaseExcludableCapability[];
			eager?: boolean | undefined;
			createdBy?: SupabaseStackRecord['createdBy'] | undefined;
			skipLane?: string | undefined;
			/** Checked before each spawn; a refusal records nothing (nothing ran). */
			precondition?:
				| (() => Promise<ClassifiedSupabaseError | undefined>)
				| undefined;
		}>,
		job: SupabaseEngineJob | undefined
	): Promise<
		| Readonly<{ ok: true; stackId: string }>
		| Readonly<{ ok: false; error: SupabaseErrorView }>
	> {
		const { facts } = input;
		const cli = this.manageCli(facts);
		const detection = facts.detection;
		if (!cli || detection?.status !== 'found') {
			return {
				ok: false,
				error: supabaseDesktopError(
					'refused',
					`Observed only: ${facts.mode.reasonText ?? 'RN Devtools does not manage this worktree'}.`
				),
			};
		}
		const leasedPorts = await this.#startOverrides(facts);
		const operation: SupabaseCliOperation =
			input.mode === 'create' || input.stackId === undefined
				? {
						kind: 'stack.start',
						workdir: detection.projectRoot,
						exclude: [...input.exclusions],
						...(input.eager === true ? { eager: true } : {}),
					}
				: {
						kind: 'stack.start',
						stackId: input.stackId,
						exclude: [...input.exclusions],
					};
		const label = input.mode === 'create' ? 'create' : 'start';
		job?.step('database', 'current');
		const delays: number[] = [...BUSY_RETRY_DELAYS_MS];
		let partialRetried = false;
		let portRetried = false;
		const check = input.precondition;
		const refused = { value: false };
		const precondition = check
			? async () => {
					const error = await check();
					if (error) refused.value = true;
					return error;
				}
			: undefined;
		let outcome = await this.#runLifecycle(
			cli,
			operation,
			parseSupabaseStackStart,
			job,
			{ label, leasedPorts, precondition }
		);
		while (!outcome.ok && job?.signal.aborted !== true) {
			const code = outcome.error.code;
			if (code === 'busy' && delays.length > 0) {
				await supabaseDelay(this.timers, delays.shift() ?? 500);
			} else if (code === 'partial' && !partialRetried && input.stackId) {
				partialRetried = true;
				await this.stopStep(input.stackId, job, { clearPin: false });
				job?.step('database', 'current');
			} else if (
				code === 'ports_conflict' &&
				outcome.error.retry === 'once' &&
				!portRetried
			) {
				portRetried = true;
			} else {
				break;
			}
			outcome = await this.#runLifecycle(
				cli,
				operation,
				parseSupabaseStackStart,
				job,
				{ label, leasedPorts, precondition }
			);
		}
		if (!outcome.ok) {
			const view = this.errorView(outcome.error);
			const stackId = input.stackId ?? facts.expectedStackId;
			// It started, but its output can't be read: nothing about the stack
			// is verified, so it is stopped (its data is kept).
			if (stackId !== undefined && startedUnread(outcome.error)) {
				await this.stopStep(stackId, job, { clearPin: false });
			}
			if (stackId !== undefined && !refused.value) {
				await this.#recordStartFailure(
					stackId,
					input,
					view,
					outcome.error,
					job?.signal.aborted === true
				);
			}
			job?.step('database', 'failed', view.title);
			return { ok: false, error: view };
		}
		const start = outcome.value;
		job?.details({ cancellable: false });
		this.#rememberCredentials(start.id, start.credentials, true);
		await this.#recordStart(start.id, input, cli);
		if (start.publicEndpoints) {
			this.#endpoints.set(start.id, start.publicEndpoints);
		}
		if (start.endpointChanges.some((change) => change.endpoint === 'api')) {
			this.#markLanesStale(start.id);
			this.restartAttachedMetro(start.id, 'ports-moved', input.skipLane);
		}
		this.markDirty();
		return { ok: true, stackId: start.id };
	}

	async #recordStart(
		stackId: string,
		input: Readonly<{
			facts: SupabaseWorktreeFacts;
			exclusions: readonly SupabaseExcludableCapability[];
			createdBy?: SupabaseStackRecord['createdBy'] | undefined;
		}>,
		cli: ResolvedSupabaseCli
	): Promise<void> {
		const { facts } = input;
		const detection = facts.detection;
		if (detection?.status !== 'found' || facts.head?.status !== 'ok') return;
		const now = this.now();
		const existing = this.stackStore.record(stackId);
		const branchContext =
			this.entry(stackId)?.branchContext ?? facts.head.branchContext;
		const base: SupabaseStackRecord = existing ?? {
			id: stackId,
			origin: 'managed',
			name: 'default',
			projectRoot: detection.projectRoot,
			appPaths: [],
			branchContext,
			createdBy: input.createdBy ?? { via: 'desktop' },
			createdAt: now,
			runtime: 'native',
			pinned: false,
			holds: [],
			clocks: {},
			exclusions: [],
			studioEnabled: false,
			flags: {},
		};
		// A start clears what an earlier failure or a branch follow noted, and
		// the key fingerprints older versions wrote.
		const {
			failedStart: _failedStart,
			interrupted: _interrupted,
			needsRecreate: _needsRecreate,
			prepared: _prepared,
			supersededBy: _supersededBy,
			supersededAt: _supersededAt,
			...flags
		} = base.flags;
		const {
			lastError: _lastError,
			recreateError: _recreateError,
			keyFingerprints: _keyFingerprints,
			...rest
		} = base;
		await this.stackStore.upsertRecord({
			...rest,
			origin: rest.origin === 'external' ? 'adopted' : rest.origin,
			projectRoot: detection.projectRoot,
			worktreePath: facts.worktreePath,
			appPaths: [...new Set([...rest.appPaths, facts.appPath])].slice(-16),
			repositoryId: facts.repositoryId,
			branchContext,
			lastStartedAt: now,
			lastUsedAt: now,
			cliVersion: cli.version,
			binaryPath: cli.binaryPath,
			runtime: 'native',
			exclusions: [...input.exclusions],
			flags,
		});
	}

	async #recordStartFailure(
		stackId: string,
		input: Readonly<{
			facts: SupabaseWorktreeFacts;
			mode: 'create' | 'resume';
			exclusions: readonly SupabaseExcludableCapability[];
			createdBy?: SupabaseStackRecord['createdBy'] | undefined;
		}>,
		error: SupabaseErrorView,
		classified: ClassifiedSupabaseError,
		cancelled: boolean
	): Promise<void> {
		const { facts } = input;
		const detection = facts.detection;
		if (detection?.status !== 'found' || facts.head?.status !== 'ok') return;
		const existing = this.stackStore.record(stackId);
		const interrupted =
			input.mode === 'create' &&
			(cancelled || classified.details.timedOut === true);
		const recreate = classified.code === 'needs_recreate';
		const started = startedUnread(classified);
		const base: SupabaseStackRecord = existing ?? {
			id: stackId,
			origin: 'managed',
			name: 'default',
			projectRoot: detection.projectRoot,
			worktreePath: facts.worktreePath,
			appPaths: [facts.appPath],
			repositoryId: facts.repositoryId,
			branchContext: facts.head.branchContext,
			createdBy: input.createdBy ?? { via: 'desktop' },
			createdAt: this.now(),
			runtime: 'native',
			pinned: false,
			holds: [],
			clocks: {},
			exclusions: [...input.exclusions],
			studioEnabled: false,
			flags: {},
		};
		// What the saved stack can't adopt stays with the flag: a retry that
		// fails for another reason (a port conflict, a timeout, a cancel)
		// replaces lastError, not this.
		const { recreateError: _saved, ...kept } = base;
		const recreateError = recreate
			? error
			: existing
				? supabaseRecreateError(existing)
				: undefined;
		await this.stackStore.upsertRecord({
			...kept,
			lastError: error,
			...(recreateError ? { recreateError } : {}),
			flags: {
				...base.flags,
				...(recreate ? { needsRecreate: true as const } : {}),
				...(interrupted ? { interrupted: true as const } : {}),
				// The first start failed but still registered an empty stack.
				...(input.mode === 'create' && !interrupted && !recreate && !started
					? { failedStart: true as const }
					: {}),
			},
		});
	}

	/** lsof after a start; then a status read so the row shows Running. */
	async verifyAfterStart(
		stackId: string,
		job: SupabaseEngineJob
	): Promise<SupabaseEngineJobOutcome> {
		job.step('verify', 'current');
		const exposed = await this.enforceExposure(stackId, job);
		if (!exposed.ok) {
			job.step('verify', 'failed', exposed.error.title);
			return { status: 'failed', error: exposed.error };
		}
		job.step('verify', 'done', '127.0.0.1 only');
		// The job completes once the list has the stack, or a new stack's
		// row would still be the expected one. The list drops statuses of
		// stacks it doesn't show, so read the status after it.
		await this.refreshList();
		await this.#rereadStatus(stackId);
		return { status: 'complete' };
	}

	/** `stack restart`: saved settings, exclusions and keys kept; then status. */
	async restartStep(
		view: SupabaseStackView,
		job: SupabaseEngineJob,
		cli: ResolvedSupabaseCli
	): Promise<SupabaseStepResult> {
		job.step('restart', 'current');
		const outcome = await this.#runLifecycle(
			cli,
			{ kind: 'stack.restart', stackId: view.id },
			parseSupabaseStackRestart,
			job,
			{ label: 'restart' }
		);
		if (!outcome.ok) {
			const error = this.errorView(outcome.error);
			job.step('restart', 'failed', error.title);
			return { ok: false, error };
		}
		job.step('restart', 'done');
		if (view.record) {
			const now = this.now();
			await this.stackStore.updateRecord(view.id, (draft) => ({
				...draft,
				lastStartedAt: now,
				lastUsedAt: now,
			}));
		}
		await this.readStatus(view.id);
		return { ok: true };
	}

	/**
	 * `stack destroy` for ids present in a fresh list and stopped, several
	 * per call when the dialect allows it; a partly failed batch reads the
	 * destroyed ids from the envelope. Uploads go only when asked, through
	 * the guarded removal.
	 */
	async destroyStep(
		stackIds: readonly string[],
		job: SupabaseEngineJob,
		options: Readonly<{ removeUploads: boolean }>
	): Promise<
		Readonly<{
			destroyed: readonly string[];
			failed: readonly Readonly<{
				stackId: string;
				error: SupabaseErrorView;
			}>[];
			freedBytes?: number | undefined;
		}>
	> {
		job.step('destroy', 'current');
		await this.refreshList();
		const failed: { stackId: string; error: SupabaseErrorView }[] = [];
		const ready: string[] = [];
		for (const stackId of stackIds) {
			const entry = this.entry(stackId);
			if (!this.enabled()) {
				// Turned off meanwhile, no list was read, and a destroy needs a
				// fresh one: nothing is destroyed.
				failed.push({
					stackId,
					error: supabaseDesktopError('feature_off', OFF_MESSAGE),
				});
			} else if (!entry) {
				failed.push({
					stackId,
					error: supabaseDesktopError(
						'stale_selection',
						'That stack is not in a fresh list.'
					),
				});
			} else if (entry.owner === 'reachable' || this.ownerOf(stackId)) {
				failed.push({
					stackId,
					error: supabaseDesktopError(
						'refused',
						'Stop it first. Destroy runs only on a stopped stack.'
					),
				});
			} else {
				ready.push(stackId);
			}
		}
		const before = new Map(
			ready.map((stackId) => [
				stackId,
				{
					projectRoot:
						this.entry(stackId)?.projectRoot ??
						this.stackStore.record(stackId)?.projectRoot,
					bytes: this.#disk.get(stackId)?.stackBytes,
				},
			])
		);
		const destroyed: string[] = [];
		const first = ready[0];
		const cli = first === undefined ? undefined : await this.#stopCli(first);
		if (ready.length > 0 && !cli) {
			for (const stackId of ready) {
				failed.push({
					stackId,
					error: supabaseDesktopError(
						'unavailable',
						'No Supabase CLI RN Devtools can run is available to destroy this stack.'
					),
				});
			}
		} else if (cli) {
			const multi =
				cli.dialect.gate !== 'unsupported' && cli.dialect.features.multiDestroy;
			const batches: string[][] = multi
				? [ready.slice(0, 32)]
				: ready.map((stackId) => [stackId]);
			for (const batch of batches) {
				const outcome = await this.#runLifecycle(
					cli,
					{ kind: 'stack.destroy', stackIds: batch, confirmed: true },
					parseSupabaseStackDestroy,
					job,
					{ label: 'destroy' }
				);
				if (outcome.ok) {
					destroyed.push(...outcome.value.destroyedIds);
					continue;
				}
				const partial = outcome.error.details.destroyedStackIds ?? [];
				destroyed.push(...partial.filter((id) => batch.includes(id)));
				const error = this.errorView(outcome.error);
				for (const stackId of batch) {
					if (!partial.includes(stackId)) failed.push({ stackId, error });
				}
			}
		}
		let freedBytes: number | undefined;
		for (const stackId of destroyed) {
			const known = before.get(stackId);
			if (known?.bytes !== undefined) {
				freedBytes = (freedBytes ?? 0) + known.bytes;
			}
			if (options.removeUploads && known?.projectRoot !== undefined) {
				await deleteSupabaseUploads(known.projectRoot, stackId);
			}
			this.#forgetStack(stackId);
		}
		if (destroyed.length > 0) await this.stackStore.removeRecords(destroyed);
		job.step(
			'destroy',
			failed.length > 0 && destroyed.length === 0 ? 'failed' : 'done',
			failed.length > 0
				? `${destroyed.length} of ${stackIds.length} destroyed`
				: undefined
		);
		await this.refreshList();
		return {
			destroyed,
			failed,
			...(freedBytes === undefined ? {} : { freedBytes }),
		};
	}

	#forgetStack(stackId: string): void {
		this.#statuses.delete(stackId);
		this.#endpoints.delete(stackId);
		this.#credentials.delete(stackId);
		this.#exposure.delete(stackId);
		this.#memory.delete(stackId);
		this.#disk.delete(stackId);
		this.#holds.delete(stackId);
		this.exportPaths.delete(stackId);
		for (const attachment of this.attachmentsOf(stackId)) {
			this.#attachments.delete(attachment.laneId);
		}
		this.markDirty();
	}

	/** Records a clean-up's result for the Requests view. */
	notePruneResult(
		result: Readonly<{
			destroyed: number;
			failed: number;
			freedBytes?: number | undefined;
		}>
	): void {
		const previous = this.#previousPrune ?? this.getState().prune;
		this.#previousPrune = {
			...previous,
			lastResult: {
				at: this.now(),
				destroyed: result.destroyed,
				failed: result.failed,
				...(result.freedBytes === undefined
					? {}
					: { freedBytes: result.freedBytes }),
			},
		};
		this.markDirty();
	}

	/** A database mutation through `--local`, from the stack's own project root. */
	async databaseStep<T>(
		view: SupabaseStackView,
		job: SupabaseEngineJob,
		operation: Extract<
			SupabaseCliOperation,
			{ kind: 'migration.up' | 'db.reset' | 'seed.buckets' }
		>,
		project: (json: unknown) => T,
		stepId: string
	): Promise<
		| Readonly<{ ok: true; value: T }>
		| Readonly<{ ok: false; error: SupabaseErrorView }>
	> {
		const cli = this.manageCli(view.facts);
		if (!cli) {
			return {
				ok: false,
				error: supabaseDesktopError(
					'refused',
					"This worktree's Supabase CLI can't change this database."
				),
			};
		}
		job.step(stepId, 'current');
		const outcome = await this.#runLifecycle(cli, operation, project, job, {
			label: stepId,
			precondition: () => this.stillOnBranch(view),
		});
		if (!outcome.ok) {
			const error = this.errorView(outcome.error);
			job.step(stepId, 'failed', error.title);
			return { ok: false, error };
		}
		job.step(stepId, 'done');
		return { ok: true, value: outcome.value };
	}

	/**
	 * `stack prepare --runtime native` on a managed worktree, then a stop of
	 * the stack it registered: the services are downloaded once.
	 */
	async prepareStep(
		facts: SupabaseWorktreeFacts,
		capabilities: readonly SupabasePreparableCapability[],
		job: SupabaseEngineJob
	): Promise<SupabaseStepResult> {
		const cli = this.manageCli(facts);
		const detection = facts.detection;
		if (!cli || detection?.status !== 'found' || facts.head?.status !== 'ok') {
			return {
				ok: false,
				error: supabaseDesktopError(
					'refused',
					'No managed worktree in this repository yet.'
				),
			};
		}
		job.step('download', 'current');
		const outcome = await this.#runLifecycle(
			cli,
			{
				kind: 'stack.prepare',
				workdir: detection.projectRoot,
				capabilities: [...capabilities],
			},
			parseSupabaseStackPrepare,
			job,
			{ label: 'prepare' }
		);
		if (!outcome.ok) {
			const error = this.errorView(outcome.error);
			job.step('download', 'failed', error.title);
			return { ok: false, error };
		}
		job.step('download', 'done');
		const stackId = outcome.value.id;
		if (!this.stackStore.record(stackId)) {
			await this.stackStore.upsertRecord({
				id: stackId,
				origin: 'managed',
				name: 'default',
				projectRoot: detection.projectRoot,
				worktreePath: facts.worktreePath,
				appPaths: [facts.appPath],
				repositoryId: facts.repositoryId,
				branchContext: facts.head.branchContext,
				createdBy: { via: 'desktop', prepare: true },
				createdAt: this.now(),
				cliVersion: cli.version,
				binaryPath: cli.binaryPath,
				runtime: 'native',
				pinned: false,
				holds: [],
				clocks: {},
				exclusions: [],
				studioEnabled: false,
				flags: { prepared: true },
			});
		}
		const stopped = await this.stopStep(stackId, job, { clearPin: false });
		this.#cache = { state: 'warm', measuredAt: this.now() };
		return stopped;
	}

	// -------------------------------------------------------------------------
	// Ensure (lane up, agent up, UI Start, follow)

	/**
	 * Why a worktree can't get a managed stack, or undefined when it can,
	 * checked in the order an agent's recovery depends on.
	 */
	preflight(
		facts: SupabaseWorktreeFacts | undefined
	): SupabaseEnsureRefusal | undefined {
		if (!this.policySnapshot().enabled) return this.#offRefusal();
		if (!this.platform.supported) {
			return refusal(
				'disabled',
				'supabase_unsupported',
				'Native Supabase needs Apple silicon and macOS 14 or later.'
			);
		}
		if (facts?.detection?.status !== 'found') {
			return refusal(
				'no-project',
				'not_found',
				'This worktree has no supabase/config.toml between the app and the worktree root.',
				facts ? { facts } : {}
			);
		}
		const detection = facts.detection;
		if (facts.mode.value === 'off') {
			return refusal(
				'off',
				'supabase_disabled',
				`Local Supabase is off here: ${facts.mode.reasonText ?? 'turned off for this repository'}.`,
				{ facts }
			);
		}
		if (facts.mode.value === 'observed') {
			const code: SupabaseEnsureRefusal['agentCode'] = !detection.stackFlag
				.optedIn
				? 'stack_flag_missing'
				: detection.configConflict
					? 'config_conflict'
					: facts.cli && !facts.cli.ok
						? 'cli_missing'
						: 'cli_unverified';
			return refusal(
				'not-managed',
				code,
				`Observed only: ${facts.mode.reasonText ?? 'RN Devtools does not manage this worktree'}.`,
				{ facts }
			);
		}
		const head = facts.head;
		if (head?.status !== 'ok' || facts.expectedStackId === undefined) {
			return refusal(
				'failed',
				'supabase_failed',
				"This worktree's git HEAD can't be read.",
				{ facts }
			);
		}
		if (head.operation !== undefined) {
			return refusal(
				'git-busy',
				'git_busy',
				'A rebase, merge or similar git operation is in progress in this worktree.',
				{ facts, stackId: facts.expectedStackId }
			);
		}
		if (!this.policySnapshot().policy.pinnedPortsCompat) {
			const holder = this.#pinnedPortHolder(facts);
			if (holder) {
				return refusal(
					'ports-pinned',
					'ports_pinned',
					`Port ${holder.port} for ${holder.key} is pinned in this project and held by another stack. Remove the pinned port so every worktree gets automatic ports.`,
					{ facts, stackId: facts.expectedStackId }
				);
			}
		}
		return undefined;
	}

	/** What an ensure the turn-off overtook is told, as preflight says it. */
	#offRefusal(): SupabaseEnsureRefusal {
		return refusal('disabled', 'supabase_disabled', OFF_MESSAGE);
	}

	#pinnedPortHolder(
		facts: SupabaseWorktreeFacts
	): Readonly<{ port: number; key: string }> | undefined {
		if (facts.detection?.status !== 'found') return undefined;
		if (this.#reservations?.status !== 'ok') return undefined;
		for (const listener of facts.detection.pinnedListeners) {
			if (listener.port === undefined) continue;
			const holder = this.#reservations.reservations.find(
				(reservation) => reservation.port === listener.port
			);
			if (holder && holder.stackId !== facts.expectedStackId) {
				return { port: listener.port, key: listener.key };
			}
		}
		return undefined;
	}

	/**
	 * Ensures the stack for a worktree's current branch runs natively:
	 * attaches to it when it runs, resumes it when stopped, creates it when
	 * missing (one creation at a time, after admission). Single-flight per
	 * identity: callers that join learn the same job, and each one then adds
	 * its own hold. An explicit request (operator, lane, agent) never joins a
	 * flight an automatic one began, whose answer can be a refusal only
	 * automatic requests get: it runs its own once that one ends. Never
	 * rejects.
	 */
	async ensureStack(
		facts: SupabaseWorktreeFacts,
		request: SupabaseEnsureRequest
	): Promise<SupabaseEnsureResult> {
		try {
			const refused = this.preflight(facts);
			if (refused) return refused;
			const stackId = facts.expectedStackId as string;
			const automatic = `automatic:${stackId}`;
			const explicit = `explicit:${stackId}`;
			// An automatic request joins whichever flight runs; an explicit one
			// joins only another explicit one.
			const key =
				request.requestedBy.kind === 'automatic' && !this.#ensures.get(explicit)
					? automatic
					: explicit;
			// A fresh flight registers its job slot synchronously, so callers
			// that join learn the job id it starts, never another flight's.
			const flight = this.#ensures.run(key, () =>
				this.#ensureFlight(
					key,
					facts,
					stackId,
					request,
					key === explicit ? this.#ensures.get(automatic) : undefined
				)
			);
			const tracked = this.#ensureJobs.get(key);
			if (request.onJob && tracked) {
				if (tracked.jobId !== undefined) request.onJob(tracked.jobId);
				else tracked.listeners.add(request.onJob);
			}
			const result = await flight;
			if (result.kind === 'ready') {
				await this.#applyEnsureHolds(result.stackId, request);
			}
			return result;
		} catch (error) {
			this.log(`Supabase ensure failed: ${errorName(error)}`);
			return refusal(
				'failed',
				'supabase_failed',
				'RN Devtools could not start this stack.',
				{ facts }
			);
		}
	}

	/**
	 * Whether the explicit ensure of this stack still waits for an automatic
	 * one: it has no job of its own yet, and that one's job isn't its job.
	 */
	ensureQueued(stackId: string): boolean {
		return this.#ensureJobs.get(`explicit:${stackId}`)?.queued === true;
	}

	async #ensureFlight(
		key: string,
		facts: SupabaseWorktreeFacts,
		stackId: string,
		request: SupabaseEnsureRequest,
		after: Promise<unknown> | undefined
	): Promise<SupabaseEnsureResult> {
		const tracked: {
			jobId?: string;
			queued: boolean;
			listeners: Set<(jobId: string) => void>;
		} = { queued: after !== undefined, listeners: new Set() };
		this.#ensureJobs.set(key, tracked);
		try {
			if (after) {
				// Still one flight at a time per stack. Automatic requests join
				// this one while it waits, so none begins behind it.
				await after.catch(() => undefined);
				tracked.queued = false;
				// Asked again: the feature may have been turned off meanwhile,
				// and then nothing is probed or started.
				const refused = this.preflight(facts);
				if (refused) return refused;
			}
			return await this.#ensureIdentity(facts, stackId, request, (jobId) => {
				tracked.jobId = jobId;
				for (const listener of [...tracked.listeners]) listener(jobId);
				tracked.listeners.clear();
			});
		} finally {
			if (this.#ensureJobs.get(key) === tracked) {
				this.#ensureJobs.delete(key);
			}
		}
	}

	async #applyEnsureHolds(
		stackId: string,
		request: SupabaseEnsureRequest
	): Promise<void> {
		const record = this.stackStore.record(stackId);
		if (!record) return;
		if (request.hold) await this.stackStore.addHold(stackId, request.hold);
		if (request.pin === 'always') {
			await this.stackStore.setPinned(stackId, true);
		} else if (
			request.pin === 'if-unheld' &&
			!this.#resolveHolds(record).held
		) {
			await this.stackStore.setPinned(stackId, true);
		}
		const now = this.now();
		if (this.stackStore.record(stackId)?.lastUsedAt !== now) {
			await this.stackStore.updateRecord(stackId, (draft) => ({
				...draft,
				lastUsedAt: now,
			}));
		}
		this.track(this.reconcileHolds());
	}

	async #ensureIdentity(
		facts: SupabaseWorktreeFacts,
		stackId: string,
		request: SupabaseEnsureRequest,
		onJob: (jobId: string) => void
	): Promise<SupabaseEnsureResult> {
		await this.freshList();
		// Reads can outlast the feature: once it is off, nothing more is
		// probed, attached or started.
		let refused = this.preflight(facts);
		if (refused) return refused;
		const record = this.stackStore.record(stackId);
		const entry = this.entry(stackId);
		if (entry && (entry.runtime === 'docker' || entry.runtime === 'podman')) {
			return refusal(
				'lan-exposed',
				'container_runtime',
				`A ${entry.runtime === 'podman' ? 'Podman' : 'Docker'} stack already uses this worktree's identity. RN Devtools never attaches container stacks; destroy it from the Supabase tab first.`,
				{ facts, stackId }
			);
		}
		if (record?.flags.interrupted) {
			return refusal(
				'failed',
				'needs_recreate',
				"A first start of this stack stopped midway, so it can't be resumed; destroy it and start again.",
				{ facts, stackId }
			);
		}
		let status = entry ? await this.readStatus(stackId) : undefined;
		// A setting the saved stack can't adopt is never retried automatically.
		// An explicit start tries again, because reverting the setting keeps the
		// stack; a start that takes clears the flag, and so does a status read
		// that finds the configuration matching again.
		const recreate = this.stackStore.record(stackId);
		if (
			recreate?.flags.needsRecreate &&
			request.requestedBy.kind === 'automatic' &&
			!(status?.owner === 'reachable' && status.lifecycle === 'running')
		) {
			// The failure that set the flag, even when a later try failed for
			// another reason: its recovery says what this message says.
			const error = supabaseRecreateError(recreate);
			return refusal(
				'failed',
				'needs_recreate',
				// Reverting keeps the stack only when every listed change is
				// editable, as its recovery and the renderer's copy also say.
				supabaseRevertKeepsStack(error?.details.stackChanges)
					? 'The saved stack cannot adopt the current configuration. Revert the change to keep it, or recreate it.'
					: 'The saved stack cannot adopt the current configuration; it must be recreated.',
				{ facts, stackId, ...(error ? { error } : {}) }
			);
		}
		if (
			status?.owner === 'reachable' &&
			(status.lifecycle === 'starting' || status.lifecycle === 'stopping')
		) {
			// Someone else is starting or stopping it: wait for that to settle.
			status = await this.#waitForOutsideLifecycle(stackId);
		}
		// And again once the status reads end.
		refused = this.preflight(facts);
		if (refused) return refused;
		// Owned by another CLI release, which answers nothing else: stop it
		// (that works across releases) and start it with this worktree's CLI.
		if (status?.owner === 'reachable' && status.releaseMismatch) {
			const restart = await this.restartWithWorktreeCli(
				{ id: stackId, record, entry, facts },
				request.requestedBy
			);
			onJob(restart.jobId);
			const outcome = await restart.done;
			if (outcome.status === 'complete') {
				return {
					kind: 'ready',
					stackId,
					facts,
					warnings: this.#warningsFor(facts),
				};
			}
			if (outcome.status === 'cancelled') {
				// Called off because the feature was turned off before it began.
				return (
					this.preflight(facts) ??
					refusal('failed', 'supabase_failed', 'The restart was cancelled.', {
						facts,
						stackId,
					})
				);
			}
			return refusal(
				'cli-mismatch',
				'cli_mismatch',
				outcome.error?.message ??
					'The stack runs on another Supabase CLI release.',
				{
					facts,
					stackId,
					...(outcome.error ? { error: outcome.error } : {}),
				}
			);
		}
		if (status?.owner === 'reachable' && status.lifecycle === 'running') {
			return this.#attachRunning(facts, stackId);
		}
		// Never ran (missing, a failed first start, prepared only): create
		// from the project root. Otherwise resume it by id.
		const mode: 'create' | 'resume' =
			!entry ||
			record?.flags.failedStart === true ||
			record?.flags.prepared === true ||
			(status !== undefined && status.members.length === 0)
				? 'create'
				: 'resume';
		const cold = this.#coldCache();
		const lanePort = request.lane?.port;
		const { jobId, done } = await this.startJob(
			{
				kind: mode,
				stackIds: [stackId],
				requestedBy: request.requestedBy,
				cancellable: true,
				steps: initialSupabaseJobSteps(mode, {
					...(mode === 'create'
						? { migrationTotal: facts.migrationCount }
						: {}),
					...(lanePort === undefined ? {} : { lanePort }),
				}),
				...(mode === 'create' && facts.migrationCount > 0
					? { migrationTotal: facts.migrationCount }
					: {}),
				expectedMs:
					mode === 'create' ? (cold === true ? 45_000 : 5_000) : 2_000,
				...(cold === undefined || mode !== 'create' ? {} : { coldCache: cold }),
			},
			// The gate before the lock, as every lifecycle job takes them.
			(job) =>
				(mode === 'create'
					? this.#creationGate
					: this.#lifecycleGate
				).runCancellable(
					() =>
						this.lockStack(stackId, () =>
							this.#startWork(job, { facts, stackId, mode, request })
						),
					job.signal,
					() => ({ status: 'cancelled' })
				)
		);
		onJob(jobId);
		const outcome = await done;
		if (outcome.status === 'complete') {
			return {
				kind: 'ready',
				stackId,
				facts,
				warnings: this.#warningsFor(facts),
			};
		}
		if (outcome.status === 'cancelled') {
			// Cancelled, or called off because the feature was turned off
			// before it began: then the refusal says so.
			return (
				this.preflight(facts) ??
				refusal('failed', 'supabase_failed', 'The start was cancelled.', {
					facts,
					stackId,
				})
			);
		}
		const error = outcome.error;
		if (error?.title === NO_ROOM_TITLE || error?.code === 'capacity') {
			const requestId =
				request.capacityRequester === undefined
					? undefined
					: await this.#fileCapacityRequest(facts, request.capacityRequester);
			return refusal('capacity', 'supabase_capacity', error.message, {
				facts,
				stackId,
				error,
				...(requestId ? { requestId } : {}),
			});
		}
		const lan = error?.title === LAN_EXPOSED_TITLE;
		return refusal(
			error?.code === 'ports_pinned'
				? 'ports-pinned'
				: lan
					? 'lan-exposed'
					: 'failed',
			error?.code === 'ports_pinned'
				? 'ports_pinned'
				: error?.code === 'needs_recreate'
					? 'needs_recreate'
					: error?.code === 'container_runtime'
						? 'container_runtime'
						: error?.code === 'cli_mismatch'
							? 'cli_mismatch'
							: error?.title === SUPABASE_BRANCH_MOVED_TITLE
								? 'branch_moved'
								: 'supabase_failed',
			error?.message ?? 'The stack did not start.',
			{ facts, stackId, ...(error ? { error } : {}) }
		);
	}

	#warningsFor(
		facts: SupabaseWorktreeFacts
	): ('memory-warning' | 'cli-untested')[] {
		const warnings: ('memory-warning' | 'cli-untested')[] = [];
		if (this.#memoryPressure === 'warning') warnings.push('memory-warning');
		if (facts.cli?.ok && facts.cli.cli.dialect.gate !== 'verified') {
			warnings.push('cli-untested');
		}
		return warnings;
	}

	async #waitForOutsideLifecycle(
		stackId: string
	): Promise<SupabaseStackStatus | undefined> {
		const deadline = this.now() + OUTSIDE_START_WAIT_MS;
		let status = this.#statuses.get(stackId)?.status;
		while (
			this.now() < deadline &&
			status?.owner === 'reachable' &&
			(status.lifecycle === 'starting' || status.lifecycle === 'stopping')
		) {
			await supabaseDelay(this.timers, OUTSIDE_START_POLL_MS);
			// Turned off meanwhile, it stops reading: nothing is probed while off.
			if (!this.enabled()) break;
			status = await this.readStatus(stackId);
		}
		return status;
	}

	async #attachRunning(
		facts: SupabaseWorktreeFacts,
		stackId: string
	): Promise<SupabaseEnsureResult> {
		if (this.#exposure.get(stackId)?.verdict !== 'loopback') {
			const checked = await this.lockStack(stackId, async () =>
				// Turned off while this waited for the lock: nothing is probed.
				this.enabled() ? this.enforceExposure(stackId, undefined) : undefined
			);
			if (!checked) return this.#offRefusal();
			if (!checked.ok) {
				return refusal(
					checked.error.title === LAN_EXPOSED_TITLE ? 'lan-exposed' : 'failed',
					'supabase_failed',
					checked.error.message,
					{ facts, stackId, error: checked.error }
				);
			}
		}
		const detection = facts.detection;
		if (detection?.status === 'found' && facts.head?.status === 'ok') {
			const now = this.now();
			if (!this.stackStore.record(stackId)) {
				// The worktree's own stack, started by someone else: adopted.
				await this.stackStore.upsertRecord({
					id: stackId,
					origin: 'adopted',
					name: this.entry(stackId)?.name || 'default',
					projectRoot: detection.projectRoot,
					worktreePath: facts.worktreePath,
					appPaths: [facts.appPath],
					repositoryId: facts.repositoryId,
					branchContext: facts.head.branchContext,
					createdBy: { via: 'external' },
					createdAt: now,
					lastUsedAt: now,
					runtime: 'native',
					pinned: false,
					holds: [],
					clocks: {},
					exclusions: [],
					studioEnabled: false,
					flags: {},
				});
			} else {
				await this.stackStore.updateRecord(stackId, (draft) => ({
					...draft,
					origin: draft.origin === 'external' ? 'adopted' : draft.origin,
					worktreePath: facts.worktreePath,
					appPaths: [...new Set([...draft.appPaths, facts.appPath])].slice(-16),
					lastUsedAt: now,
				}));
			}
		}
		if (
			!this.endpointsOf(stackId) ||
			!this.credentialsOf(stackId)?.publishableKey
		) {
			await this.readStatus(stackId);
		}
		return {
			kind: 'ready',
			stackId,
			facts,
			warnings: this.#warningsFor(facts),
		};
	}

	async #startWork(
		job: SupabaseEngineJob,
		input: Readonly<{
			facts: SupabaseWorktreeFacts;
			stackId: string;
			mode: 'create' | 'resume';
			request: SupabaseEnsureRequest;
		}>
	): Promise<SupabaseEngineJobOutcome> {
		if (job.signal.aborted) return { status: 'cancelled' };
		// Turned off while this waited its turn behind the gate or the lock:
		// it never begins, as nothing starts while the feature is off.
		const off = this.calledOff();
		if (off) return off;
		job.begin();
		const room = await this.admit(input.stackId, job);
		if (!room.ok) {
			job.step('room', 'failed', room.error.message);
			// Turned off while it made room: called off before anything started.
			return {
				status: room.error.code === 'feature_off' ? 'cancelled' : 'failed',
				error: room.error,
			};
		}
		const started = await this.startStep(
			{
				facts: input.facts,
				...(input.mode === 'resume' ? { stackId: input.stackId } : {}),
				mode: input.mode,
				exclusions: this.exclusionsFor(input.stackId),
				eager:
					input.request.lane !== undefined &&
					input.mode === 'create' &&
					this.policySnapshot().policy.eagerLanes,
				createdBy: input.request.createdBy,
				skipLane: input.request.lane?.laneId,
				// The id was named from HEAD before this waited its turn, and the
				// CLI names it from HEAD again when it runs.
				precondition: () => this.#stillOnHead(input.facts),
			},
			job
		);
		if (!started.ok) {
			return job.signal.aborted
				? { status: 'cancelled' }
				: { status: 'failed', error: started.error };
		}
		const verified = await this.verifyAfterStart(started.stackId, job);
		if (verified.status === 'complete' && started.stackId !== input.stackId) {
			// Another branch's stack started: nothing holds it, so it stops
			// after the linger, and the caller asks again for its branch.
			return {
				status: 'failed',
				error: this.errorView(supabaseBranchMovedError()),
			};
		}
		if (verified.status === 'complete' && input.request.lane) {
			job.step('attach', 'done');
		}
		return verified;
	}

	/** Refuses once the worktree left the branch its facts were read on. */
	async #stillOnHead(
		facts: SupabaseWorktreeFacts
	): Promise<ClassifiedSupabaseError | undefined> {
		if (facts.head?.status !== 'ok') return undefined;
		const head = await this.#readHead(facts.worktreePath);
		return head.status === 'ok' &&
			head.branchContext === facts.head.branchContext
			? undefined
			: supabaseBranchMovedError();
	}

	/**
	 * Admission before a create or resume: stops the least recently used
	 * unheld managed stack while the cap or the free Postgres slots require
	 * it, or refuses (critical memory pressure always refuses, and so does a
	 * turn-off, with `feature_off`).
	 */
	async admit(
		stackId: string,
		job: SupabaseEngineJob | undefined
	): Promise<
		Readonly<{ ok: true }> | Readonly<{ ok: false; error: SupabaseErrorView }>
	> {
		job?.step('room', 'current');
		const off = {
			ok: false,
			error: supabaseDesktopError('feature_off', OFF_MESSAGE),
		} as const;
		await this.#readCapacity();
		for (let round = 0; ; round += 1) {
			// Off, the state lists no stacks to count: nothing is admitted on it.
			if (!this.enabled()) return off;
			const state = this.getState();
			const others = state.stacks.filter((stack) => stack.id !== stackId);
			const running = others.filter(
				(stack) =>
					(stack.origin === 'managed' || stack.origin === 'adopted') &&
					isSupabaseStackRunning(stack)
			).length;
			const starting = this.jobStore
				.activeJobs()
				.filter(
					(active) =>
						active.status === 'running' &&
						!active.stackIds.includes(stackId) &&
						(active.kind === 'create' ||
							active.kind === 'resume' ||
							active.kind === 'recreate')
				).length;
			const sysv = this.#sysv;
			const { cap } = supabaseRunningCap({
				maxRunning: state.policy.maxRunning,
				shmmni: sysv?.status === 'ok' ? sysv.shmmni : undefined,
			});
			const decision = decideSupabaseAdmission({
				running,
				starting,
				cap,
				sysv:
					sysv?.status === 'ok' && sysv.segments.status === 'ok'
						? { used: sysv.segments.used, limit: sysv.shmmni }
						: null,
				memoryPressure: this.#memoryPressure,
				candidates: supabaseAdmissionCandidates(
					others.map((stack) => ({
						stackId: stack.id,
						origin: stack.origin,
						running: isSupabaseStackRunning(stack),
						pinned: stack.pinned,
						held:
							stack.holds.some((hold) => hold.live) ||
							stack.cwdKeepers.length > 0,
						inFlight: this.#jobActive(stack.id),
						lastUsedAt: stack.lastUsedAt,
					}))
				),
			});
			if (decision.kind === 'allow') {
				const free =
					sysv?.status === 'ok' && sysv.segments.status === 'ok'
						? ` · ${sysv.segments.free} Postgres slots free`
						: '';
				job?.step('room', 'done', `${running} of ${cap} running${free}`);
				return { ok: true };
			}
			if (decision.kind === 'refuse' || round >= MAX_ADMISSION_STOPS) {
				return {
					ok: false,
					error: supabaseDesktopError(
						'refused',
						decision.kind === 'refuse'
							? decision.message
							: 'RN Devtools could not make room for another stack.',
						{
							title: NO_ROOM_TITLE,
							recovery:
								'Stop a stack you no longer need, or raise the limit in Settings.',
						}
					),
				};
			}
			// Stop the least recently used unheld stack, then decide again.
			job?.step(
				'room',
				'current',
				`Stopping ${decision.stackId.slice(0, 8)}… to make room`
			);
			const stop = await this.stopJob(
				decision.stackId,
				{ kind: 'automatic', reason: 'capacity' },
				{ ungated: true }
			);
			// Called off by a turn-off, or turned off while it stopped: no more
			// room is made, and the start that asked never begins.
			if ((await stop.done).status === 'cancelled' || !this.enabled()) {
				return off;
			}
			await this.#readCapacity();
		}
	}

	/** An agent's start that found no room waits for the user's choice. */
	async #fileCapacityRequest(
		facts: SupabaseWorktreeFacts,
		requester: Readonly<{ holder: DeviceHolder; synthetic: boolean }>
	): Promise<string | undefined> {
		const existing = this.stackStore
			.requests()
			.find(
				(request) =>
					request.kind === 'start-capacity' &&
					request.status === 'pending' &&
					request.worktreePath === facts.worktreePath &&
					request.requester.kind === requester.holder.kind &&
					request.requester.sessionId === requester.holder.sessionId
			);
		if (existing) return existing.id;
		const now = this.now();
		const branch =
			facts.head?.status === 'ok'
				? facts.head.branchContext.replace(/^refs\/heads\//, '')
				: facts.branch;
		const request: SupabaseRequestRecord = {
			id: `supabase-request-${randomUUID()}`,
			kind: 'start-capacity',
			status: 'pending',
			requester: {
				kind: requester.holder.kind,
				sessionId: requester.holder.sessionId,
				synthetic: requester.synthetic,
			},
			...(facts.expectedStackId ? { stackId: facts.expectedStackId } : {}),
			worktreePath: facts.worktreePath,
			branch: branch.slice(0, 256) || 'a branch',
			createdAt: now,
			expiresAt: now + REQUEST_TTL_MS,
		};
		try {
			await this.stackStore.putRequest(request);
			return request.id;
		} catch {
			return undefined;
		}
	}

	// -------------------------------------------------------------------------
	// Clipboard

	/**
	 * Writes text main resolved (never the renderer) and, for secrets, clears
	 * it after `clearAfterMs` if the clipboard still holds exactly that text.
	 */
	async copyToClipboard(
		text: string,
		clearAfterMs: number | undefined
	): Promise<number | undefined> {
		await this.deps.clipboard.writeText(text);
		if (clearAfterMs === undefined) return undefined;
		const pending: ClipboardClear = { text, timer: undefined };
		pending.timer = this.timers.setTimeout(() => {
			this.#clipboard.delete(pending);
			this.track(this.#clearClipboardIfUnchanged(text));
		}, clearAfterMs);
		this.#clipboard.add(pending);
		return this.now() + clearAfterMs;
	}

	async #clearClipboardIfUnchanged(text: string): Promise<void> {
		try {
			if ((await this.deps.clipboard.readText()) === text) {
				await this.deps.clipboard.writeText('');
			}
		} catch {
			// The clipboard is best effort.
		}
	}

	// -------------------------------------------------------------------------
	// Turning off

	/** Progress of a turn-off that stops managed stacks, for the state. */
	setDisabling(value: SupabaseState['feature']['disabling']): void {
		this.#disabling = value;
		this.markDirty();
	}

	/**
	 * The jobs still queued or running that can bring a stack up: creates,
	 * resumes, follows, recreates, restarts, stop-and-starts and Studio
	 * switches (a stop, then a start).
	 */
	activeStarts(): readonly SupabaseJob[] {
		return this.jobStore
			.activeJobs()
			.filter((job) => STARTING_JOB_KINDS.has(job.kind));
	}

	/** Waits until none of those is queued or running. */
	async whenStartsSettled(): Promise<void> {
		for (;;) {
			const starts = this.activeStarts();
			if (starts.length === 0) return;
			await Promise.all(
				starts.map((job) => this.jobStore.waitFor(job.id, 60_000))
			);
		}
	}

	/** Drops what only makes sense while on; nothing is probed while off. */
	clearLiveCaches(): void {
		this.#list = undefined;
		this.#lastListAt = undefined;
		this.#listFailure = undefined;
		this.#owners = undefined;
		this.#reservations = undefined;
		this.#ownerFirstSeen.clear();
		this.#holds.clear();
		this.markDirty();
	}

	// -------------------------------------------------------------------------
	// The API, through the handler modules

	runOperation(
		operation: SupabaseOperation,
		context: SupabaseOperationContext
	): Promise<SupabaseOperationReceipt> {
		return runSupabaseOperation(this, operation, context);
	}

	async describeConfirmation(
		operation: SupabaseOperation
	): Promise<SupabaseConfirmationFacts | undefined> {
		if (
			this.enabled() &&
			(operation.kind === 'destroy' ||
				operation.kind === 'recreate' ||
				operation.kind === 'request.approve')
		) {
			// Destructive dialogs describe a fresh list.
			await this.#within(this.refreshList(), 10_000);
		}
		return describeSupabaseConfirmation(operation, {
			state: this.getState(),
			now: this.now(),
			reservedPorts: (stackId) => this.#reservedPorts(stackId),
		});
	}

	ensureForLane(
		input: LaneBackendEnsureInput,
		signal?: AbortSignal
	): Promise<LaneBackendEnsureResult> {
		return ensureSupabaseForLane(this, input, signal);
	}

	runAgentOperation(
		operation: SupabaseAgentOperation,
		context: SupabaseAgentContext,
		signal: AbortSignal
	): Promise<SupabaseAgentResult> {
		return runSupabaseAgentOperation(this, operation, context, signal);
	}

	releaseHolder(
		input: Readonly<{
			holder?: DeviceHolder | undefined;
			sessionCwd?: string | undefined;
		}>
	): Promise<SupabaseReleaseResult> {
		return releaseSupabaseHolder(this, input);
	}

	doctor(): SupabaseDoctorInfo {
		return supabaseDoctorInfo(this);
	}

	holderKeys(): readonly SupabaseHolderKey[] {
		return supabaseHolderKeys(this.stackStore.records());
	}

	lockStack<T>(stackId: string, task: () => Promise<T>): Promise<T> {
		return this.#stackLocks.run(stackId, task);
	}

	/**
	 * Resumes and stops run two at a time through this gate. Lifecycle work
	 * takes its gate first and the stack's lock second, so a job holding a
	 * lock never waits for a gate.
	 */
	lifecycleGate(): SupabaseSemaphore {
		return this.#lifecycleGate;
	}

	/** Creations (a create, recreate or prepare) run one at a time. */
	creationGate(): SupabaseSemaphore {
		return this.#creationGate;
	}

	/** Re-reads everything now: the operator's Refresh. */
	async refreshAll(): Promise<void> {
		// Like a cheap tick, a Refresh in flight ends at its next step once off.
		await this.#readOwners();
		if (!this.#active) return;
		this.#reservations = await this.#discoveryNow().readPortReservations();
		await this.#checkPaths();
		if (!this.#active) return;
		await this.refreshRepositories();
		await this.refreshList();
		const inspected = this.#interest()?.inspectStackId;
		if (inspected !== undefined) await this.readStatus(inspected);
		await this.reconcileHolds();
		await this.writeSteering();
	}
}

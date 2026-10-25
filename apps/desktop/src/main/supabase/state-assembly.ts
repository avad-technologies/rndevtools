import os from 'node:os';
import path from 'node:path';
import {
	type AgentSession,
	type AgentState,
	agentSessionKey,
} from '../../shared/agent-protocol';
import { isPathInside } from '../../shared/device-hold';
import type { Lane } from '../../shared/lane-protocol';
import {
	isActiveSupabaseJob,
	isLoopbackHttpUrl,
	isSupabaseStackRunning,
	SUPABASE_EXCLUDABLE_CAPABILITIES,
	SUPABASE_GIT_OPERATION_BY_MARKER,
	SUPABASE_STACK_FLAGS,
	type SupabaseActivityEntry,
	type SupabaseAgentRequest,
	type SupabaseErrorView,
	type SupabaseExcludableCapability,
	type SupabaseInspection,
	type SupabaseInterest,
	type SupabaseJob,
	type SupabasePruneSummary,
	type SupabaseServiceKind,
	type SupabaseStackFlag,
	type SupabaseStackState,
	type SupabaseStackSummary,
	type SupabaseState,
	sanitizeSupabaseDisplayText,
	supabaseAgentLabel,
	supabaseAppEnvNameSchema,
	supabaseBranchLabel,
	supabaseStackSummarySchema,
	supabaseStateSchema,
	supabaseTrafficSignature,
} from '../../shared/supabase-protocol';
import {
	supabaseAdmissionCandidates,
	supabaseNextToStop,
	supabaseRunningCap,
} from './admission';
import type {
	MainOnlyCredentials,
	SupabasePublicEndpoints,
	SupabaseStackList,
	SupabaseStackListEntry,
	SupabaseStackStatus,
} from './cli-contract';
import { buildSupabaseArgv } from './dialect';
import type {
	OwnerDiscoveryResult,
	PortReservation,
	PortReservationsResult,
	SupabaseOwnerProcess,
	SysvCapacityResult,
} from './discovery';
import { computeSupabasePrune, type SupabaseGcStack } from './gc';
import type { SupabaseHoldsResult } from './holds';
import { expectedStackId } from './identity';
import type { SupabasePolicySnapshot } from './policy-store';
import type { SupabaseProjectDetection } from './project';
import {
	type SupabaseRepositoryFacts,
	type SupabaseWorktreeFacts,
	summarizeSupabaseRepository,
	supabaseFactsForLane,
} from './repositories';
import {
	redactSupabaseErrorView,
	redactSupabaseStoredText,
	type SupabaseRequestRecord,
	type SupabaseStackRecord,
	supabaseRecreateError,
} from './stack-store';

/**
 * Builds the renderer's SupabaseState from everything main knows: the
 * policy, discovery probes, the last `stack list`, cached `stack status`
 * reads, the stack records, lanes, repository facts, resolved holds, jobs,
 * requests and measurements. Pure, apart from reading the home directory for
 * the default path labels. The result always parses with the contract's
 * schema: a stack that would not is dropped (and logged), and a state that
 * would not becomes a minimal one carrying a list failure.
 *
 * Nothing secret leaves here: URLs must be loopback http, credentials appear
 * only as `known` booleans, paths only as labels, and every text field is
 * sanitized and bounded.
 */

const MAX_STACKS = 128;
const MAX_REPOSITORIES = 32;
const MAX_REQUESTS = 32;
const MAX_JOBS = 64;
const MAX_ACTIVITY = 64;
const MAX_LANES = 16;
const MAX_REQUEST_IDS = 8;
const MAX_ENV_SHADOW = 16;
const MAX_DRIFT_PATHS = 32;
const MAX_FOREIGN_HOMES = 8;
const MAX_CONTAINER_NOTICES = 32;
const MAX_CANDIDATES = 16;
const GIB = 1_024 ** 3;
/** Measured idle and awake footprints (DESIGN: measured basis). */
const IDLE_STACK_BYTES = 0.17 * GIB;
const AWAKE_STACK_BYTES = 0.9 * GIB;
/** An owner alive this long without answering is not responding. */
const OWNER_START_GRACE_MS = 30_000;
const SHADOW_ROOT_PREFIX = 'supabase-shadow-';
const UNREADABLE_REASON = "its state can't be read";
const UNTRACKED_REASON = "its repository isn't tracked in Lanes";

/**
 * The last good `stack status` read of a stack, and the newest failure.
 */
export type SupabaseStatusCacheEntry = Readonly<{
	status?: SupabaseStackStatus | undefined;
	checkedAt?: number | undefined;
	/** The newest read failed with this renderer-safe error. */
	failure?: Readonly<{ error: SupabaseErrorView; at: number }> | undefined;
}>;

/**
 * The lsof verdict over a stack's process tree.
 */
export type SupabaseExposureEntry = Readonly<{
	verdict: 'loopback' | 'lan-exposed' | 'unknown';
	checkedAt: number;
}>;

/**
 * What the cheap tier found on disk for a stack.
 */
export type SupabasePathCheck = Readonly<{
	worktreeExists: boolean;
	/** Consecutive checks that found the project root missing; 2 is orphaned. */
	projectRootMissingChecks: number;
	missingSince?: number | undefined;
}>;

type SupabaseMeasurements = Readonly<{
	/** RSS over each running stack's process tree. */
	memory?: ReadonlyMap<string, Readonly<{ bytes: number; measuredAt: number }>>;
	disk?: ReadonlyMap<
		string,
		Readonly<{
			stackBytes?: number | undefined;
			uploadsBytes?: number | undefined;
			measuredAt: number;
		}>
	>;
	cache?: Readonly<{
		bytes?: number | undefined;
		state: 'cold' | 'warm' | 'unknown';
		measuredAt?: number | undefined;
	}>;
	sysv?: SysvCapacityResult | undefined;
	memoryPressure?: SupabaseState['capacity']['memoryPressure'];
}>;

/**
 * A lane's attachment, as the service tracks it.
 */
export type SupabaseLaneAttachment = Readonly<{
	stackId: string;
	/** Metro started before the stack attached, or its ports moved since. */
	needsMetroRestart: boolean;
}>;

export type SupabaseStateInputs = Readonly<{
	now: number;
	revision: number;
	/** Demo state is never assembled here, but the source can say so. */
	demo?: boolean | undefined;
	platform: SupabaseState['availability']['platform'];
	policy: SupabasePolicySnapshot;
	disabling?: SupabaseState['feature']['disabling'] | undefined;
	discovery: Readonly<{
		status: SupabaseState['discovery']['status'];
		lastListAt?: number | undefined;
		sessions: Pick<AgentState['discovery'], 'claude' | 'codex'>;
		listFailure?: Readonly<{ message: string; at: number }> | undefined;
	}>;
	/** discovery.discoverOwners(). */
	owners?: OwnerDiscoveryResult | undefined;
	/** When each stack's owner argv was first seen. */
	ownerFirstSeen?: ReadonlyMap<string, number> | undefined;
	/** discovery.readPortReservations(). */
	reservations?: PortReservationsResult | undefined;
	/** Realpath of `<SUPABASE_HOME>/stacks`; other state roots are another home. */
	homeStateRoot?: string | undefined;
	/** The last successful `stack list`. */
	list?: SupabaseStackList | undefined;
	statuses?: ReadonlyMap<string, SupabaseStatusCacheEntry> | undefined;
	/** Last known public endpoints from a start or status (kept while stopped). */
	endpoints?: ReadonlyMap<string, SupabasePublicEndpoints> | undefined;
	/** Main-held credentials per stack; only whether each is known is used. */
	credentials?: ReadonlyMap<string, MainOnlyCredentials> | undefined;
	records: readonly SupabaseStackRecord[];
	requests?: readonly SupabaseRequestRecord[] | undefined;
	lanes: readonly Lane[];
	laneAttachments?: ReadonlyMap<string, SupabaseLaneAttachment> | undefined;
	/** Simulator display names by UDID. */
	simulatorNames?: ReadonlyMap<string, string> | undefined;
	sessions?: readonly AgentSession[] | undefined;
	repositories: readonly SupabaseRepositoryFacts[];
	holds: ReadonlyMap<string, SupabaseHoldsResult>;
	jobs: readonly SupabaseJob[];
	activity?: readonly SupabaseActivityEntry[] | undefined;
	measurements?: SupabaseMeasurements | undefined;
	exposure?: ReadonlyMap<string, SupabaseExposureEntry> | undefined;
	pathChecks?: ReadonlyMap<string, SupabasePathCheck> | undefined;
	/** For unreadable stacks: whether `<home>/stacks/<id>` exists. */
	stackFolders?: ReadonlyMap<string, boolean> | undefined;
	/** When each worktree's HEAD last changed, by worktree path. */
	headStableSince?: ReadonlyMap<string, number> | undefined;
	/** Stacks whose owner binary changed or vanished since they started. */
	cliChanged?: ReadonlySet<string> | undefined;
	engines?: SupabaseState['engines'] | undefined;
	interest?: SupabaseInterest | undefined;
	previousPrune?: SupabasePruneSummary | undefined;
	pathLabel?: ((absolutePath: string) => string) | undefined;
	log?: ((line: string) => void) | undefined;
}>;

// ---------------------------------------------------------------------------
// Small helpers

/** `~/code/app` for a path under the home directory. */
export function supabasePathLabel(
	absolutePath: string,
	home: string = os.homedir()
): string {
	if (home.length > 1 && isPathInside(absolutePath, home)) {
		const rest = path.relative(home, absolutePath);
		return rest.length === 0 ? '~' : `~/${rest}`;
	}
	return absolutePath;
}

/**
 * A git ref as the state carries it: control and bidirectional characters
 * replaced, bounded. The stack's branch and the worktree's HEAD both go
 * through this, so comparing them in the renderer stays exact.
 */
function refText(value: string): string {
	let output = '';
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		const hidden =
			code <= 0x1f ||
			(code >= 0x7f && code <= 0x9f) ||
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2066 && code <= 0x2069) ||
			code === 0x200e ||
			code === 0x200f;
		output += hidden ? '?' : character;
	}
	if (output.length > 1_024) {
		const cut = output.slice(0, 1_024);
		const last = cut.charCodeAt(cut.length - 1);
		// Never end on half of a surrogate pair.
		output = last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
	}
	return output || 'detached';
}

/** Display text: redacted, URL userinfo dropped, controls removed, bounded. */
function plain(value: string, max: number): string {
	return sanitizeSupabaseDisplayText(
		redactSupabaseStoredText(value, max * 2),
		max
	);
}

function loopback(value: string | undefined): string | undefined {
	return value !== undefined && isLoopbackHttpUrl(value) ? value : undefined;
}

function portOf(url: string | undefined): number | undefined {
	if (url === undefined) return undefined;
	try {
		const port = Number(new URL(url).port);
		return Number.isInteger(port) && port >= 1 && port <= 65_535
			? port
			: undefined;
	} catch {
		return undefined;
	}
}

function validPort(value: number | undefined): number | undefined {
	return value !== undefined &&
		Number.isInteger(value) &&
		value >= 1 &&
		value <= 65_535
		? value
		: undefined;
}

/** The capability whose service a composition member is. */
function capabilityOf(
	service: string
): SupabaseExcludableCapability | 'database' | undefined {
	switch (service) {
		case 'database':
			return 'database';
		case 'imgproxy':
			return 'storage';
		case 'pgmeta':
			return 'studio';
		default:
			return (SUPABASE_EXCLUDABLE_CAPABILITIES as readonly string[]).includes(
				service
			)
				? (service as SupabaseExcludableCapability)
				: undefined;
	}
}

const FLAG_ORDER = new Map<SupabaseStackFlag, number>(
	SUPABASE_STACK_FLAGS.map((flag, index) => [flag, index])
);

function orderedFlags(
	flags: ReadonlySet<SupabaseStackFlag>
): SupabaseStackFlag[] {
	return [...flags].sort(
		(left, right) => (FLAG_ORDER.get(left) ?? 0) - (FLAG_ORDER.get(right) ?? 0)
	);
}

/** `api` from `api.port`, `db.pooler` from `db.pooler.port`, `api` from SUPABASE_API_PORT. */
function pinnedKeyLabel(key: string): string {
	const dotenv = /^SUPABASE_([A-Z0-9_]+)_PORT$/.exec(key);
	const label = dotenv?.[1]
		? dotenv[1].toLowerCase()
		: key.replace(/\.port$/, '');
	return plain(label, 64) || 'a service';
}

// ---------------------------------------------------------------------------
// One stack

type Found = Extract<SupabaseProjectDetection, { status: 'found' }>;

type StackContext = Readonly<{
	inputs: SupabaseStateInputs;
	label: (absolutePath: string) => string;
	facts: readonly SupabaseWorktreeFacts[];
	listAt: number | undefined;
	owners: ReadonlyMap<string, SupabaseOwnerProcess> | undefined;
	reservations: ReadonlyMap<string, readonly PortReservation[]>;
	portHolders: ReadonlyMap<number, string>;
	lanesByStack: ReadonlyMap<string, readonly Lane[]>;
	mismatchedIds: ReadonlySet<string>;
	records: ReadonlyMap<string, SupabaseStackRecord>;
	listed: ReadonlyMap<string, SupabaseStackListEntry>;
}>;

type StackSeed = Readonly<{
	id: string;
	entry?: SupabaseStackListEntry | undefined;
	record?: SupabaseStackRecord | undefined;
	unreadable?: boolean;
	/** An expected row: this worktree's stack for its HEAD does not exist yet. */
	expected?: SupabaseWorktreeFacts | undefined;
}>;

function factsForStack(
	context: StackContext,
	id: string,
	projectRoot: string | undefined,
	record: SupabaseStackRecord | undefined
): SupabaseWorktreeFacts | undefined {
	const { facts } = context;
	const byId = facts.find((candidate) => candidate.expectedStackId === id);
	if (byId) return byId;
	if (record?.worktreePath !== undefined) {
		const worktree = facts.filter(
			(candidate) => candidate.worktreePath === record.worktreePath
		);
		const app = worktree.find((candidate) =>
			record.appPaths.includes(candidate.appPath)
		);
		if (app ?? worktree[0]) return app ?? worktree[0];
	}
	if (projectRoot === undefined) return undefined;
	const detected = facts.find(
		(candidate) =>
			candidate.detection?.status === 'found' &&
			candidate.detection.projectRoot === projectRoot
	);
	if (detected) return detected;
	// The deepest worktree containing the root: a worktree may sit inside the
	// main checkout's directory.
	return facts
		.filter((candidate) =>
			isPathInside(projectRoot, candidate.realWorktreePath)
		)
		.sort(
			(left, right) =>
				right.realWorktreePath.length - left.realWorktreePath.length
		)[0];
}

/** Which source is newer: the cached status or the last list. */
function freshStatus(
	context: StackContext,
	id: string
): SupabaseStackStatus | undefined {
	const entry = context.inputs.statuses?.get(id);
	const status = entry?.status;
	if (!status || status.identity.id !== id) return undefined;
	const checkedAt = entry?.checkedAt ?? 0;
	// A newer failed read means the last good one can't be trusted any more.
	if (entry?.failure !== undefined && entry.failure.at > checkedAt) {
		return undefined;
	}
	return context.listAt === undefined || checkedAt >= context.listAt
		? status
		: undefined;
}

function ownerLivenessFor(
	context: StackContext,
	id: string,
	entry: SupabaseStackListEntry | undefined,
	status: SupabaseStackStatus | undefined
): SupabaseStackSummary['ownerLiveness'] {
	const statusEntry = context.inputs.statuses?.get(id);
	const failure = statusEntry?.failure;
	if (
		failure &&
		failure.at >= (statusEntry?.checkedAt ?? 0) &&
		failure.error.code === 'busy' &&
		/sweep/i.test(failure.error.message)
	) {
		return 'sweeping';
	}
	const reachable = (status?.owner ?? entry?.owner) === 'reachable';
	if (reachable) return 'reachable';
	const owner = context.owners?.get(id);
	if (owner) {
		const firstSeen =
			context.inputs.ownerFirstSeen?.get(id) ?? context.inputs.now;
		return context.inputs.now - firstSeen < OWNER_START_GRACE_MS
			? 'starting'
			: 'not-responding';
	}
	if (context.owners !== undefined) return 'absent';
	return entry || status ? 'absent' : 'unknown';
}

function healthFrom(
	status: SupabaseStackStatus | undefined,
	excluded: readonly SupabaseExcludableCapability[]
): SupabaseStackSummary['health'] {
	const members = status?.members ?? [];
	const unhealthy = members.filter(
		(member) =>
			member.state === 'unhealthy' ||
			member.state === 'exited' ||
			member.health === 'unhealthy'
	);
	return {
		members: members.length,
		awake: members.filter((member) => member.state === 'running').length,
		sleeping: members.filter((member) => member.state === 'sleeping').length,
		unhealthy: unhealthy.length,
		unhealthyServices: [
			...new Set(unhealthy.map((member) => member.service)),
		].slice(0, 16),
		excluded: [...excluded],
	};
}

function liveState(status: SupabaseStackStatus): SupabaseStackState {
	const members = status.members;
	const database = members.find((member) => member.service === 'database');
	const unhealthy = members.some(
		(member) =>
			member.state === 'unhealthy' ||
			member.state === 'exited' ||
			member.health === 'unhealthy'
	);
	if (unhealthy || (database !== undefined && database.state !== 'running')) {
		return 'unhealthy';
	}
	// A member stopped outside the idle cycle (sleeping is the idle cycle).
	return members.some((member) => member.state === 'stopped')
		? 'partial'
		: 'running';
}

function stackStateFor(
	seed: StackSeed,
	status: SupabaseStackStatus | undefined,
	ownerLiveness: SupabaseStackSummary['ownerLiveness']
): SupabaseStackState {
	if (seed.unreadable) return 'unreadable';
	if (seed.expected) return 'not-created';
	const record = seed.record;
	if (status?.owner === 'reachable') {
		// Running only from a status read: a reachable owner in `stack list`
		// is never enough.
		if (status.lifecycle === 'running') return liveState(status);
		if (status.releaseMismatch) return 'running';
		if (status.lifecycle === 'starting') return 'starting';
		if (status.lifecycle === 'stopping') return 'stopping';
	}
	if (record?.flags.interrupted) return 'interrupted';
	if (record?.flags.needsRecreate) return 'needs-recreate';
	if (record?.flags.failedStart) return 'failed';
	if (ownerLiveness === 'starting') return 'starting';
	// An owner process that hangs or sweeps: whatever the list said, its
	// state is not known until it answers.
	if (ownerLiveness === 'not-responding' || ownerLiveness === 'sweeping') {
		return 'unknown';
	}
	const stopped =
		status?.lifecycle === 'stopped' ||
		status?.owner === 'unavailable' ||
		(status === undefined && seed.entry?.owner === 'unavailable');
	if (stopped) {
		return (status !== undefined && status.members.length === 0) ||
			record?.flags.prepared
			? 'never-started'
			: 'stopped';
	}
	// An owner that answers, hangs or sweeps, with no status read yet.
	return 'unknown';
}

function excludedFor(
	seed: StackSeed,
	status: SupabaseStackStatus | undefined,
	policyExclude: readonly SupabaseExcludableCapability[]
): SupabaseExcludableCapability[] {
	const members = status?.members ?? [];
	if (members.length > 0) {
		const present = new Set(
			members.map((member) => capabilityOf(member.service))
		);
		return SUPABASE_EXCLUDABLE_CAPABILITIES.filter(
			(capability) => !present.has(capability)
		);
	}
	if (seed.record) return [...seed.record.exclusions];
	if (seed.expected) return [...policyExclude];
	return [];
}

function createdByFor(seed: StackSeed): SupabaseStackSummary['createdBy'] {
	const record = seed.record;
	if (!record) return { via: seed.entry ? 'outside' : 'unknown' };
	const createdBy = record.createdBy;
	const via: SupabaseStackSummary['createdBy']['via'] =
		createdBy.via === 'external'
			? 'outside'
			: createdBy.laneId !== undefined
				? 'lane-up'
				: createdBy.prepare
					? 'pre-download'
					: createdBy.via === 'agent'
						? 'agent-up'
						: 'operator';
	return {
		via,
		...(createdBy.agent === undefined ? {} : { agent: createdBy.agent }),
		...(createdBy.laneId === undefined ? {} : { laneId: createdBy.laneId }),
		at: record.createdAt,
	};
}

/** Command text built from the dialect's own argv, so no CLI word is spelled here. */
function cliCommands(
	facts: SupabaseWorktreeFacts | undefined,
	runner: string | undefined,
	stackId: string
): Pick<SupabaseStackSummary['cli'], 'inspectCommand' | 'statusCommand'> {
	const resolution = facts?.cli;
	if (!resolution?.ok || runner === undefined) return {};
	try {
		const argv = buildSupabaseArgv(resolution.cli.dialect, {
			kind: 'stack.status',
			stackId,
		});
		// The last two words ask for JSON; people read the plain output.
		const words = argv.at(-1) === 'json' ? argv.slice(0, -2) : [...argv];
		return {
			inspectCommand: plain(`${runner} ${words.join(' ')}`, 512),
			statusCommand: plain(`${runner} ${words.slice(0, 2).join(' ')}`, 512),
		};
	} catch {
		return {};
	}
}

function cliFor(
	context: StackContext,
	seed: StackSeed,
	facts: SupabaseWorktreeFacts | undefined,
	detection: Found | undefined
): SupabaseStackSummary['cli'] {
	const resolution = facts?.cli;
	const runner = detection?.runner
		? `${detection.runner.command} supabase`
		: undefined;
	const status = context.inputs.statuses?.get(seed.id);
	const statusMismatch = status?.status?.releaseMismatch;
	const failure = status?.failure;
	const failureMismatch =
		failure?.error.code === 'cli_mismatch' &&
		failure.error.details.ownerRelease !== undefined &&
		failure.error.details.clientRelease !== undefined
			? {
					ownerRelease: failure.error.details.ownerRelease,
					clientRelease: failure.error.details.clientRelease,
				}
			: undefined;
	const mismatch =
		statusMismatch !== undefined
			? {
					ownerRelease: statusMismatch.ownerRelease,
					clientRelease: statusMismatch.clientRelease,
				}
			: failureMismatch;
	const releaseOk = (value: string) => /^[0-9A-Za-z.+-]{1,80}$/.test(value);
	const version = resolution?.ok
		? resolution.cli.version
		: seed.record?.cliVersion;
	return {
		...(version === undefined ? {} : { version: plain(version, 64) }),
		gate: resolution?.ok ? resolution.cli.dialect.gate : 'missing',
		...(runner === undefined ? {} : { runnerLabel: plain(runner, 64) }),
		...cliCommands(facts, runner, seed.id),
		...(mismatch &&
		releaseOk(mismatch.ownerRelease) &&
		releaseOk(mismatch.clientRelease)
			? {
					mismatch: {
						ownerRelease: mismatch.ownerRelease,
						clientRelease: mismatch.clientRelease,
						...(resolution?.ok
							? { clientVersion: plain(resolution.cli.version, 64) }
							: {}),
					},
				}
			: {}),
	};
}

function stackLanes(
	context: StackContext,
	id: string
): SupabaseStackSummary['lanes'] {
	return (context.lanesByStack.get(id) ?? [])
		.slice(0, MAX_LANES)
		.map((lane) => {
			const name = context.inputs.simulatorNames?.get(
				lane.simulatorUdid.toUpperCase()
			);
			return {
				laneId: lane.id,
				simulatorUdid: lane.simulatorUdid,
				...(name === undefined || plain(name, 128).length === 0
					? {}
					: { simulatorLabel: plain(name, 128) }),
				port: lane.port,
				environment: lane.environment,
				metro: lane.metro,
				needsMetroRestart:
					context.inputs.laneAttachments?.get(lane.id)?.needsMetroRestart ??
					false,
			};
		});
}

function endpointsFor(
	context: StackContext,
	id: string,
	status: SupabaseStackStatus | undefined,
	studioIncluded: boolean,
	running: boolean
): Pick<
	SupabaseStackSummary,
	'apiUrl' | 'restUrl' | 'functionsUrl' | 'mailpitUrl' | 'studioUrl' | 'ports'
> {
	const known = status?.publicEndpoints ?? context.inputs.endpoints?.get(id);
	const apiUrl = loopback(known?.apiUrl);
	const restUrl = loopback(known?.restUrl);
	const functionsUrl = loopback(known?.functionsUrl);
	const mailpitUrl = loopback(known?.mailpitUrl);
	const studioUrl =
		studioIncluded && running ? loopback(known?.studioUrl) : undefined;
	const reserved = new Map(
		(context.reservations.get(id) ?? []).map((reservation) => [
			reservation.endpoint,
			reservation.port,
		])
	);
	const endpoint = (key: string) =>
		validPort(status?.endpoints[key]?.port ?? reserved.get(key));
	const api = portOf(apiUrl) ?? validPort(reserved.get('api'));
	const db = endpoint('database.sql');
	const mail = endpoint('mail.http') ?? portOf(mailpitUrl);
	const studio = studioIncluded
		? (endpoint('studio.http') ?? portOf(studioUrl))
		: undefined;
	return {
		...(apiUrl === undefined ? {} : { apiUrl }),
		...(restUrl === undefined ? {} : { restUrl }),
		...(functionsUrl === undefined ? {} : { functionsUrl }),
		...(mailpitUrl === undefined ? {} : { mailpitUrl }),
		...(studioUrl === undefined ? {} : { studioUrl }),
		ports: {
			...(api === undefined ? {} : { api }),
			...(db === undefined ? {} : { db }),
			...(mail === undefined ? {} : { mail }),
			...(studio === undefined ? {} : { studio }),
		},
	};
}

function pinnedPortFor(
	context: StackContext,
	id: string,
	detection: Found | undefined
): SupabaseStackSummary['pinnedPort'] {
	for (const listener of detection?.pinnedListeners ?? []) {
		if (listener.port === undefined) continue;
		const holder = context.portHolders.get(listener.port);
		if (holder === undefined || holder === id) continue;
		const holderRecord = context.records.get(holder);
		const holderRoot =
			holderRecord?.worktreePath ??
			holderRecord?.projectRoot ??
			context.listed.get(holder)?.projectRoot;
		return {
			port: listener.port,
			key: pinnedKeyLabel(listener.key),
			...(holderRoot === undefined
				? {}
				: { holderLabel: context.label(holderRoot) }),
		};
	}
	return undefined;
}

function idMismatch(entry: SupabaseStackListEntry | undefined): boolean {
	if (!entry) return false;
	try {
		return (
			expectedStackId({
				projectRoot: entry.projectRoot,
				branchContext: entry.branchContext,
				name: entry.name,
			}) !== entry.id
		);
	} catch {
		return false;
	}
}

function buildStack(
	context: StackContext,
	seed: StackSeed
): SupabaseStackSummary {
	const { inputs, label } = context;
	const now = inputs.now;
	const id = seed.id;
	const entry = seed.entry;
	const record = seed.record;
	const status = seed.expected ? undefined : freshStatus(context, id);
	const projectRoot =
		entry?.projectRoot ??
		record?.projectRoot ??
		status?.identity.projectRoot ??
		(seed.expected?.detection?.status === 'found'
			? seed.expected.detection.projectRoot
			: undefined);
	const facts = seed.unreadable
		? undefined
		: (seed.expected ?? factsForStack(context, id, projectRoot, record));
	const detection =
		facts?.detection?.status === 'found' ? facts.detection : undefined;
	const head = facts?.head?.status === 'ok' ? facts.head : undefined;
	const branchContext =
		entry?.branchContext ??
		record?.branchContext ??
		status?.identity.branchContext ??
		(seed.expected ? head?.branchContext : undefined);
	const origin: SupabaseStackSummary['origin'] = seed.expected
		? 'expected'
		: (record?.origin ?? 'external');
	const ownerLiveness = seed.unreadable
		? 'unknown'
		: seed.expected
			? 'absent'
			: ownerLivenessFor(context, id, entry, status);
	const state = stackStateFor(seed, status, ownerLiveness);
	const runtime: SupabaseStackSummary['runtime'] = seed.expected
		? 'unknown'
		: (entry?.runtime ?? status?.runtime ?? record?.runtime ?? 'unknown');
	const containerRuntime = runtime === 'docker' || runtime === 'podman';
	const policy = inputs.policy.policy;
	const excluded = excludedFor(seed, status, policy.exclude);
	const members = status?.members ?? [];
	const studioIncluded = members.some((member) => member.service === 'studio');
	const operatorEnabled = record?.studioEnabled ?? false;
	const running = isSupabaseStackRunning({ state });
	const holds = inputs.holds.get(id);
	const pathCheck = inputs.pathChecks?.get(id);
	const worktreeExists = seed.unreadable
		? false
		: (pathCheck?.worktreeExists ?? facts?.exists ?? true);
	const orphaned = (pathCheck?.projectRootMissingChecks ?? 0) >= 2;
	const exposureEntry = inputs.exposure?.get(id);
	const exposure: SupabaseStackSummary['exposure'] = containerRuntime
		? {
				verdict: 'lan-exposed',
				...(exposureEntry
					? { checkedAt: exposureEntry.checkedAt }
					: context.listAt === undefined
						? {}
						: { checkedAt: context.listAt }),
			}
		: exposureEntry
			? { verdict: exposureEntry.verdict, checkedAt: exposureEntry.checkedAt }
			: { verdict: 'unchecked' };
	const stableSince = facts
		? inputs.headStableSince?.get(facts.worktreePath)
		: undefined;
	const currentHead = head
		? {
				ref: refText(head.branchContext),
				...(stableSince === undefined ? {} : { stableSince }),
				...(head.operation === undefined
					? {}
					: {
							gitOperation: SUPABASE_GIT_OPERATION_BY_MARKER[head.operation],
						}),
			}
		: undefined;
	const requestedExclusions = record?.exclusions ?? policy.exclude;
	const reenabled =
		record && members.length > 0
			? record.exclusions.filter((capability) =>
					members.some((member) => capabilityOf(member.service) === capability)
				)
			: [];
	const reservations = context.reservations.get(id) ?? [];
	const owner = context.owners?.get(id);
	const homeRoot = inputs.homeStateRoot;
	const otherHome =
		homeRoot !== undefined &&
		(reservations.some((reservation) => reservation.stateRoot !== homeRoot) ||
			(owner?.stateRoot !== undefined && owner.stateRoot !== homeRoot));
	const liveHold = holds?.holds.some((hold) => hold.live) ?? false;
	const desktopStopped =
		record?.lastStoppedAt !== undefined &&
		record.lastStoppedAt >= (record.lastStartedAt ?? 0);
	const flags = new Set<SupabaseStackFlag>();
	if (!worktreeExists && !seed.unreadable) flags.add('worktree-deleted');
	if (orphaned) flags.add('orphaned');
	if (
		origin !== 'expected' &&
		currentHead !== undefined &&
		branchContext !== undefined &&
		currentHead.ref !== refText(branchContext)
	) {
		flags.add('stale-branch');
	}
	if (
		studioIncluded &&
		!operatorEnabled &&
		requestedExclusions.includes('studio')
	) {
		flags.add('studio-back-on');
	}
	if (status?.configDrift?.status === 'changed') flags.add('config-changed');
	if (detection && detection.pinnedListeners.length > 0) {
		flags.add('ports-pinned');
	}
	if (detection?.configConflict) flags.add('config-json-conflict');
	if (
		detection &&
		facts?.cli?.ok &&
		facts.cli.cli.dialect.gate !== 'verified'
	) {
		flags.add('cli-unverified');
	}
	if (
		inputs.cliChanged?.has(id) ||
		(owner !== undefined &&
			record?.binaryPath !== undefined &&
			owner.executable !== record.binaryPath)
	) {
		flags.add('cli-changed');
	}
	if (detection && facts?.cli !== undefined && !facts.cli.ok) {
		flags.add('cli-missing');
	}
	if (detection && detection.shadowedAppVariables.length > 0) {
		flags.add('env-shadowed');
	}
	if (otherHome) flags.add('other-supabase-home');
	if (idMismatch(entry) || context.mismatchedIds.has(id)) {
		flags.add('id-mismatch');
	}
	if (detection && !detection.stackFlag.optedIn) flags.add('not-opted-in');
	if (
		projectRoot !== undefined &&
		path.basename(projectRoot).startsWith(SHADOW_ROOT_PREFIX)
	) {
		flags.add('transient');
	}
	if (containerRuntime || exposureEntry?.verdict === 'lan-exposed') {
		flags.add('lan-exposed');
	}
	if (!containerRuntime && exposureEntry?.verdict === 'unknown') {
		flags.add('exposure-unknown');
	}
	if (state === 'stopped' && liveHold && !desktopStopped) {
		flags.add('stopped-outside');
	}
	if (holds?.clocksPaused) flags.add('clocks-paused');

	const mode: SupabaseStackSummary['mode'] = seed.unreadable
		? { value: 'observed', reasonText: UNREADABLE_REASON }
		: facts
			? {
					value: facts.mode.value,
					...(facts.mode.reasonText === undefined
						? {}
						: { reasonText: plain(facts.mode.reasonText, 512) }),
				}
			: { value: 'observed', reasonText: UNTRACKED_REASON };
	const repositoryId = facts?.repositoryId ?? record?.repositoryId;
	const worktreePath = facts?.worktreePath ?? record?.worktreePath;
	const statusEntry = inputs.statuses?.get(id);
	const credentials =
		inputs.credentials?.get(id) ?? statusEntry?.status?.credentials;
	const memory = inputs.measurements?.memory?.get(id);
	const disk = inputs.measurements?.disk?.get(id);
	// From the failure behind the flag, not lastError, which moves on.
	const recreateChanges = record
		? supabaseRecreateError(record)?.details.stackChanges
		: undefined;
	const managedLike =
		origin === 'managed' || origin === 'adopted' || origin === 'expected';
	const appEnvNames = managedLike
		? policy.appEnv.map((entryValue) => entryValue.name).slice(0, 8)
		: [];
	const envShadow = (detection?.shadowedAppVariables ?? [])
		.filter(
			(variable) => supabaseAppEnvNameSchema.safeParse(variable.name).success
		)
		.slice(0, MAX_ENV_SHADOW)
		.map((variable) => ({
			file:
				plain(
					path.relative(detection?.worktreeRoot ?? '/', variable.file) ||
						variable.file,
					1_024
				) || '.env',
			line: Math.max(1, variable.line),
			name: variable.name,
		}));
	const requestIds = (inputs.requests ?? [])
		.filter(
			(request) =>
				request.stackId === id &&
				(request.status === 'pending' || request.status === 'settling') &&
				request.expiresAt > now
		)
		.map((request) => request.id)
		.slice(0, MAX_REQUEST_IDS);
	const activeJob = inputs.jobs.find(
		(job) => isActiveSupabaseJob(job) && job.stackIds.includes(id)
	);
	const drift = status?.configDrift;
	const folder = seed.unreadable ? inputs.stackFolders?.get(id) : undefined;
	const name = plain(
		entry?.name ?? status?.identity.name ?? record?.name ?? 'default',
		128
	);
	const pinnedPort = pinnedPortFor(context, id, detection);

	return {
		id,
		name: name.length > 0 ? name : 'default',
		origin,
		state,
		ownerLiveness,
		lifecycle: status?.lifecycle ?? null,
		readiness: status?.readiness ?? null,
		health: healthFrom(status, excluded),
		runtime,
		exposure,
		mode,
		...(repositoryId === undefined ? {} : { repositoryId }),
		...(worktreePath === undefined
			? {}
			: { worktreeLabel: label(worktreePath) }),
		...(projectRoot === undefined
			? {}
			: { projectRootLabel: label(projectRoot) }),
		...(branchContext === undefined
			? {}
			: { branchContext: refText(branchContext) }),
		...(currentHead === undefined ? {} : { currentHead }),
		worktreeExists,
		...endpointsFor(context, id, status, studioIncluded, running),
		excluded,
		studio: { included: studioIncluded, operatorEnabled },
		...(pinnedPort === undefined ? {} : { pinnedPort }),
		lanes: stackLanes(context, id),
		holds: [...(holds?.holds ?? [])].slice(0, 16),
		cwdKeepers: (holds?.cwdKeepers ?? []).slice(0, 16).map((keeper) => ({
			agent: keeper.agent,
			cwdLabel: label(keeper.cwd),
		})),
		createdBy: createdByFor(seed),
		pinned: record?.pinned ?? false,
		...(holds?.autoStopAt === undefined
			? {}
			: { autoStopAt: Math.max(0, Math.floor(holds.autoStopAt)) }),
		...(holds?.autoStopReason === undefined
			? {}
			: { autoStopReason: holds.autoStopReason }),
		cli: cliFor(context, seed, facts, detection),
		flags: orderedFlags(flags),
		...(disk?.stackBytes === undefined ? {} : { diskBytes: disk.stackBytes }),
		...(disk?.uploadsBytes === undefined
			? {}
			: { uploadsBytes: disk.uploadsBytes }),
		uploadsInDeletedWorktree: !worktreeExists && !seed.unreadable,
		...(memory === undefined || !running
			? {}
			: { memoryBytes: memory.bytes, measuredAt: memory.measuredAt }),
		...(record?.lastUsedAt === undefined
			? {}
			: { lastUsedAt: record.lastUsedAt }),
		configDrift: drift
			? {
					status: drift.status,
					...(drift.paths.length > 0
						? {
								paths: drift.paths
									.slice(0, MAX_DRIFT_PATHS)
									.map((entryPath) => plain(entryPath, 256)),
							}
						: {}),
				}
			: { status: 'unavailable' },
		...(reenabled.length > 0 ? { compositionDrift: { reenabled } } : {}),
		...(record?.lastError === undefined
			? {}
			: { lastError: redactSupabaseErrorView(record.lastError) }),
		...(recreateChanges === undefined ? {} : { recreateChanges }),
		known: {
			publishableKey: credentials?.publishableKey !== undefined,
			anonKey: credentials?.anonKey !== undefined,
			databaseAddress: running && credentials?.dbUrl !== undefined,
		},
		appEnvNames,
		...(envShadow.length > 0 ? { envShadow } : {}),
		bucketsConfigured: facts?.bucketsConfigured ?? false,
		migrationCount: facts?.migrationCount ?? 0,
		requestIds,
		...(activeJob === undefined ? {} : { activeJobId: activeJob.id }),
		...(folder === undefined ? {} : { stackFolderExists: folder }),
	};
}

// ---------------------------------------------------------------------------
// The whole state

/**
 * The lanes on each stack: the service's attachments when it passes them (a
 * lane started with its backend off is not attached), else the stack each
 * lane's worktree HEAD would use.
 */
function laneStackIds(
	inputs: SupabaseStateInputs
): ReadonlyMap<string, readonly Lane[]> {
	const byStack = new Map<string, Lane[]>();
	const attachments = inputs.laneAttachments;
	for (const lane of inputs.lanes) {
		const stackId = attachments
			? attachments.get(lane.id)?.stackId
			: supabaseFactsForLane(lane, inputs.repositories)?.expectedStackId;
		if (stackId === undefined) continue;
		const list = byStack.get(stackId) ?? [];
		list.push(lane);
		byStack.set(stackId, list);
	}
	return byStack;
}

function requestView(
	record: SupabaseRequestRecord,
	stacks: ReadonlyMap<string, SupabaseStackSummary>,
	sessions: readonly AgentSession[],
	capacity: SupabaseState['capacity'],
	running: readonly SupabaseStackSummary[],
	worktreeOf: (stackId: string) => string | undefined,
	now: number
): SupabaseAgentRequest {
	const stack =
		record.stackId === undefined ? undefined : stacks.get(record.stackId);
	const requesterKey = agentSessionKey(record.requester);
	const directory =
		record.worktreePath ??
		(record.stackId === undefined ? undefined : worktreeOf(record.stackId));
	const live =
		sessions.some((session) => agentSessionKey(session) === requesterKey) ||
		(record.requester.synthetic &&
			directory !== undefined &&
			sessions.some(
				(session) =>
					session.kind === record.requester.kind &&
					session.cwd !== undefined &&
					isPathInside(session.cwd, directory)
			));
	const status =
		(record.status === 'pending' || record.status === 'settling') &&
		record.expiresAt <= now
			? 'expired'
			: record.status;
	const otherHolders = (stack?.holds ?? [])
		.filter(
			(hold) =>
				hold.holder === 'operator' ||
				hold.agent === undefined ||
				agentSessionKey(hold.agent) !== requesterKey
		)
		.slice(0, 16)
		.map((hold) => ({
			holder: hold.holder,
			...(hold.holder !== 'operator' && hold.agent
				? { agent: hold.agent }
				: {}),
			live: hold.live,
		}));
	const lane = stack?.lanes[0];
	const laneHold = lane
		? stack?.holds.find(
				(hold) => hold.holder === 'lane' && hold.laneId === lane.laneId
			)
		: undefined;
	const movedTo =
		stack?.currentHead !== undefined &&
		stack.branchContext !== undefined &&
		stack.currentHead.ref !== stack.branchContext
			? supabaseBranchLabel(stack.currentHead.ref)
			: undefined;
	return {
		id: record.id,
		kind: record.kind,
		status,
		requester: {
			kind: record.requester.kind,
			sessionId: record.requester.sessionId,
			live,
			synthetic: record.requester.synthetic,
		},
		...(record.stackId === undefined ? {} : { stackId: record.stackId }),
		branch: record.branch,
		...(record.sizeBytes !== undefined
			? { sizeBytes: record.sizeBytes }
			: stack?.diskBytes !== undefined
				? { sizeBytes: stack.diskBytes }
				: {}),
		...(record.seed === undefined ? {} : { seed: record.seed }),
		createdAt: record.createdAt,
		expiresAt: record.expiresAt,
		...(record.note === undefined ? {} : { note: record.note }),
		otherHolders,
		...(lane
			? {
					laneAttached: {
						laneId: lane.laneId,
						port: lane.port,
						running: lane.metro !== 'stopped',
						ownedByRequester:
							laneHold?.holder === 'lane' &&
							laneHold.agent !== undefined &&
							agentSessionKey(laneHold.agent) === requesterKey,
					},
				}
			: {}),
		...(movedTo === undefined ? {} : { branchMovedTo: plain(movedTo, 256) }),
		...(record.kind === 'start-capacity'
			? {
					capacity: {
						running: capacity.running,
						cap: capacity.cap,
						candidates: running.slice(0, MAX_CANDIDATES).map((candidate) => {
							const holder = candidate.holds.find((hold) => hold.live);
							const holderLabel =
								holder && holder.holder !== 'operator' && holder.agent
									? supabaseAgentLabel(holder.agent)
									: holder?.holder === 'operator'
										? 'you'
										: undefined;
							return {
								stackId: candidate.id,
								branch:
									plain(
										supabaseBranchLabel(candidate.branchContext) ??
											`${candidate.id.slice(0, 8)}…`,
										256
									) || candidate.id.slice(0, 8),
								...(holderLabel === undefined
									? {}
									: { holderLabel: plain(holderLabel, 256) }),
								...(candidate.lastUsedAt === undefined
									? {}
									: { idleSinceAt: candidate.lastUsedAt }),
								liveHolder: candidate.holds.some((hold) => hold.live),
							};
						}),
					},
				}
			: {}),
		...(record.error === undefined
			? {}
			: { error: redactSupabaseErrorView(record.error) }),
	};
}

/**
 * Wake times measured after an idle sleep with CLI 2.121.0 on Apple silicon
 * (experiments/supabase-backends/FINDINGS.md). A hint, not a promise.
 */
const WAKE_HINT_MS: Partial<Record<SupabaseServiceKind, number>> = {
	rest: 400,
	auth: 800,
	storage: 1_400,
	realtime: 2_600,
	functions: 600,
	studio: 18_000,
};

function inspectionFor(
	inputs: SupabaseStateInputs,
	stacks: ReadonlyMap<string, SupabaseStackSummary>
): SupabaseInspection | undefined {
	const interest = inputs.interest;
	const stackId =
		interest?.view === 'stacks' ? interest.inspectStackId : undefined;
	if (stackId === undefined || !stacks.has(stackId)) return undefined;
	if (stacks.get(stackId)?.origin === 'expected') return undefined;
	const entry = inputs.statuses?.get(stackId);
	const status =
		entry?.status?.identity.id === stackId ? entry.status : undefined;
	const failure = entry?.failure;
	const failedSince =
		failure !== undefined && failure.at >= (entry?.checkedAt ?? 0);
	const errors = new Map(
		(status?.services ?? []).map((service) => [service.id, service.error])
	);
	return {
		stackId,
		status:
			status === undefined
				? 'unavailable'
				: failedSince || status.releaseMismatch !== undefined
					? 'stale'
					: 'live',
		members: (status?.members ?? []).slice(0, 32).map((member) => {
			const capability = capabilityOf(member.service);
			const error = errors.get(member.id);
			const wakeHintMs =
				member.state === 'sleeping' ? WAKE_HINT_MS[member.service] : undefined;
			return {
				service: member.service,
				...(capability === undefined ? {} : { capability }),
				activation: member.activation,
				state: member.state,
				lifecycle: member.lifecycle,
				health: member.health,
				...(wakeHintMs === undefined ? {} : { wakeHintMs }),
				...(error === undefined || plain(error, 512).length === 0
					? {}
					: { error: plain(error, 512) }),
			};
		}),
		endpoints: Object.entries(status?.endpoints ?? {})
			.filter(([key]) =>
				/^[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9_-]{0,31}$/.test(key)
			)
			.slice(0, 64)
			.map(([key, endpoint]) => ({ key, port: endpoint.port })),
		checkedAt: entry?.checkedAt ?? failure?.at ?? inputs.now,
		...(failedSince && failure
			? { error: redactSupabaseErrorView(failure.error) }
			: {}),
	};
}

function sysvFrom(
	sysv: SysvCapacityResult | undefined
): SupabaseState['capacity']['sysv'] {
	if (sysv?.status !== 'ok' || sysv.segments.status !== 'ok') return null;
	return { used: sysv.segments.used, limit: sysv.shmmni };
}

function registryErrorFrom(
	reservations: PortReservationsResult | undefined
): string | undefined {
	if (
		reservations?.status !== 'unavailable' ||
		reservations.reason === 'missing'
	) {
		return undefined;
	}
	const detail = reservations.detail
		? `: ${plain(reservations.detail, 200)}`
		: '';
	return plain(
		`The port registry couldn't be read (${reservations.reason})${detail}.`,
		1_024
	);
}

function emptyPrune(
	now: number,
	previous: SupabasePruneSummary | undefined
): SupabasePruneSummary {
	return {
		revision: previous?.revision ?? 0,
		computedAt: now,
		groups: [],
		notSuggested: { held: 0, pinned: 0, starting: 0, external: 0, running: 0 },
		...(previous?.lastResult === undefined
			? {}
			: { lastResult: previous.lastResult }),
	};
}

/** The state with no stacks: off, unsupported, or a failed assembly. */
function baseState(
	inputs: SupabaseStateInputs,
	cap: Readonly<{ cap: number; derivedCap: number }>
): SupabaseState {
	const sessionsUnavailable =
		inputs.discovery.sessions.claude === 'unavailable' ||
		inputs.discovery.sessions.codex === 'unavailable';
	const enabled = inputs.policy.enabled && inputs.policy.health === 'ok';
	const listFailure = inputs.discovery.listFailure;
	return {
		revision: inputs.revision,
		updatedAt: inputs.now,
		source: inputs.demo === true ? 'demo' : 'live',
		availability: {
			platform: {
				supported: inputs.platform.supported,
				arch: plain(inputs.platform.arch, 32),
				macosVersion: plain(inputs.platform.macosVersion, 32),
				...(inputs.platform.reasonText === undefined
					? {}
					: { reasonText: plain(inputs.platform.reasonText, 512) }),
			},
		},
		feature: {
			enabled,
			...(inputs.policy.acknowledgedAt === undefined
				? {}
				: { acknowledgedAt: inputs.policy.acknowledgedAt }),
			policyHealth: inputs.policy.health,
			...(inputs.disabling === undefined
				? {}
				: { disabling: inputs.disabling }),
		},
		discovery: {
			status:
				enabled && inputs.platform.supported ? inputs.discovery.status : 'off',
			...(inputs.discovery.lastListAt === undefined
				? {}
				: { lastListAt: inputs.discovery.lastListAt }),
			sessions: sessionsUnavailable ? 'unavailable' : 'ok',
			...(listFailure === undefined
				? {}
				: {
						listFailure: {
							message:
								redactSupabaseStoredText(listFailure.message, 1_024, {
									keepNewlines: true,
								}) || 'The stack list failed.',
							at: listFailure.at,
						},
					}),
		},
		capacity: {
			running: 0,
			starting: 0,
			queued: 0,
			cap: cap.cap,
			derivedCap: cap.derivedCap,
			sysv: sysvFrom(inputs.measurements?.sysv),
			memoryPressure: inputs.measurements?.memoryPressure ?? 'unknown',
		},
		footprint: { mode: 'estimate', bytes: 0, awake: 0, idle: 0 },
		disk: { cacheState: 'unknown' },
		home: { label: inputs.policy.policy.paths.supabaseHomeLabel },
		engines: inputs.engines ?? { docker: 'absent', podman: 'absent' },
		policy: inputs.policy.policy,
		stacks: [],
		repositories: [],
		requests: [],
		jobs: [...inputs.jobs].slice(0, MAX_JOBS),
		prune: emptyPrune(inputs.now, inputs.previousPrune),
		transientCount: 0,
		notices: { containerStacks: [] },
		trafficSignature: supabaseTrafficSignature([]),
		activity: [...(inputs.activity ?? [])].slice(0, MAX_ACTIVITY),
	};
}

function issuePaths(error: {
	issues: readonly { path: readonly PropertyKey[]; code: string }[];
}): string {
	return error.issues
		.slice(0, 6)
		.map(
			(issue) =>
				`${issue.path.map((segment) => (typeof segment === 'number' ? String(segment) : typeof segment === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(segment) ? segment : '?')).join('.') || '(root)'}: ${issue.code}`
		)
		.join(', ');
}

/** Picks which stacks to list (at most 128) and in what order. */
function stackSeeds(
	inputs: SupabaseStateInputs,
	facts: readonly SupabaseWorktreeFacts[]
): Readonly<{ seeds: StackSeed[]; mismatchedIds: ReadonlySet<string> }> {
	const records = new Map(inputs.records.map((record) => [record.id, record]));
	const listed = inputs.list?.stacks ?? [];
	const seen = new Set<string>();
	const primary: StackSeed[] = [];
	const transient: StackSeed[] = [];
	for (const entry of listed) {
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		const seed = { id: entry.id, entry, record: records.get(entry.id) };
		if (path.basename(entry.projectRoot).startsWith(SHADOW_ROOT_PREFIX)) {
			transient.push(seed);
		} else {
			primary.push(seed);
		}
	}
	// Managed and adopted stacks first, then by most recent use.
	primary.sort(
		(left, right) =>
			Number(right.record !== undefined) - Number(left.record !== undefined) ||
			(right.record?.lastUsedAt ?? 0) - (left.record?.lastUsedAt ?? 0)
	);
	const unreadable: StackSeed[] = [];
	for (const entry of inputs.list?.unreadable ?? []) {
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		unreadable.push({ id: entry.id, unreadable: true });
	}
	// Before the first list, the records are all there is (state unknown).
	const remembered: StackSeed[] =
		inputs.list === undefined
			? inputs.records
					.filter((record) => !seen.has(record.id))
					.map((record) => {
						seen.add(record.id);
						return { id: record.id, record };
					})
			: [];
	const mismatchedIds = new Set<string>();
	const expected: StackSeed[] = [];
	for (const worktree of facts) {
		const detection = worktree.detection;
		const head = worktree.head;
		const id = worktree.expectedStackId;
		if (
			id === undefined ||
			detection?.status !== 'found' ||
			!detection.stackFlag.optedIn ||
			head?.status !== 'ok' ||
			worktree.mode.value === 'off' ||
			seen.has(id) ||
			inputs.list === undefined
		) {
			continue;
		}
		// The CLI listed this worktree's branch under another id: trust the
		// CLI, flag the mismatch, and add no expected row.
		const other = listed.find(
			(entry) =>
				entry.projectRoot === detection.projectRoot &&
				entry.branchContext === head.branchContext &&
				entry.name === 'default'
		);
		if (other) {
			mismatchedIds.add(other.id);
			continue;
		}
		seen.add(id);
		expected.push({ id, expected: worktree });
	}
	const seeds = [
		...primary,
		...unreadable,
		...remembered,
		...expected,
		...transient,
	].slice(0, MAX_STACKS);
	return { seeds, mismatchedIds };
}

/**
 * The SupabaseState for the renderer. Off or unsupported, it carries the
 * platform verdict, the policy and nothing probed.
 */
export function assembleSupabaseState(
	inputs: SupabaseStateInputs
): SupabaseState {
	const log = inputs.log ?? (() => undefined);
	const sysv = inputs.measurements?.sysv;
	const cap = supabaseRunningCap({
		maxRunning: inputs.policy.policy.maxRunning,
		shmmni: sysv?.status === 'ok' ? sysv.shmmni : undefined,
	});
	const base = baseState(inputs, cap);
	if (!base.feature.enabled || !inputs.platform.supported) {
		return validated(base, base, log);
	}
	const pathLabel =
		inputs.pathLabel ?? ((value: string) => supabasePathLabel(value));
	const label = (value: string) =>
		sanitizeSupabaseDisplayText(pathLabel(value), 1_024) || 'a folder';
	const facts = inputs.repositories
		.slice(0, MAX_REPOSITORIES)
		.flatMap((repository) => repository.worktrees);
	const reservationList =
		inputs.reservations?.status === 'ok'
			? inputs.reservations.reservations
			: [];
	const reservations = new Map<string, PortReservation[]>();
	const portHolders = new Map<number, string>();
	for (const reservation of reservationList) {
		const list = reservations.get(reservation.stackId) ?? [];
		list.push(reservation);
		reservations.set(reservation.stackId, list);
		portHolders.set(reservation.port, reservation.stackId);
	}
	const owners =
		inputs.owners?.status === 'ok'
			? new Map(inputs.owners.owners.map((owner) => [owner.stackId, owner]))
			: undefined;
	const { seeds, mismatchedIds } = stackSeeds(inputs, facts);
	const context: StackContext = {
		inputs,
		label,
		facts,
		listAt: inputs.discovery.lastListAt,
		owners,
		reservations,
		portHolders,
		lanesByStack: laneStackIds(inputs),
		mismatchedIds,
		records: new Map(inputs.records.map((record) => [record.id, record])),
		listed: new Map(
			(inputs.list?.stacks ?? []).map((entry) => [entry.id, entry])
		),
	};

	let stacks: SupabaseStackSummary[] = [];
	for (const seed of seeds) {
		let built: SupabaseStackSummary;
		try {
			built = buildStack(context, seed);
		} catch (error) {
			log(
				`Supabase stack ${seed.id.slice(0, 8)} could not be described: ${error instanceof Error ? error.name : 'error'}`
			);
			continue;
		}
		const parsed = supabaseStackSummarySchema.safeParse(built);
		if (parsed.success) {
			stacks.push(parsed.data);
		} else {
			log(
				`Supabase stack ${seed.id.slice(0, 8)} was left out: ${issuePaths(parsed.error)}`
			);
		}
	}

	// Clean up suggestions, then each stack's prune mark.
	const recordById = context.records;
	const gcStacks: SupabaseGcStack[] = stacks.map((stack) => {
		const record = recordById.get(stack.id);
		const check = inputs.pathChecks?.get(stack.id);
		return {
			id: stack.id,
			origin: stack.origin,
			state: stack.state,
			pinned: stack.pinned,
			held:
				stack.holds.some((hold) => hold.live) || stack.cwdKeepers.length > 0,
			inFlight: stack.activeJobId !== undefined,
			laneRunning: stack.lanes.some((lane) => lane.metro !== 'stopped'),
			flags: stack.flags,
			idleSince:
				record?.lastStoppedAt ?? record?.lastUsedAt ?? record?.createdAt,
			flaggedAt:
				check?.missingSince ??
				(stack.flags.includes('stale-branch')
					? stack.currentHead?.stableSince
					: undefined),
			diskBytes: stack.diskBytes,
			uploadsBytes: stack.uploadsBytes,
		};
	});
	const prune = computeSupabasePrune({
		now: inputs.now,
		retentionDays: inputs.policy.policy.retentionDays,
		stacks: gcStacks,
		previous: inputs.previousPrune,
	});
	stacks = stacks.map((stack) => {
		const mark = prune.marks.get(stack.id);
		if (!mark) return stack;
		const flags =
			mark.group === 'retention' && !stack.flags.includes('prune-suggested')
				? orderedFlags(new Set([...stack.flags, 'prune-suggested']))
				: stack.flags;
		return {
			...stack,
			...(mark.group === undefined ? {} : { pruneGroup: mark.group }),
			...(mark.suggestedAt === undefined
				? {}
				: { pruneSuggestedAt: Math.max(0, Math.floor(mark.suggestedAt)) }),
			flags,
		};
	});

	const byId = new Map(stacks.map((stack) => [stack.id, stack]));
	const managedRunning = stacks.filter(
		(stack) =>
			(stack.origin === 'managed' || stack.origin === 'adopted') &&
			isSupabaseStackRunning(stack)
	);
	const startingIds = new Set(
		stacks
			.filter((stack) => stack.state === 'starting')
			.map((stack) => stack.id)
	);
	for (const job of inputs.jobs) {
		if (
			job.status === 'running' &&
			(job.kind === 'create' ||
				job.kind === 'resume' ||
				job.kind === 'recreate')
		) {
			for (const id of job.stackIds) startingIds.add(id);
		}
	}
	const candidates = supabaseAdmissionCandidates(
		stacks.map((stack) => ({
			stackId: stack.id,
			origin: stack.origin,
			running: isSupabaseStackRunning(stack),
			pinned: stack.pinned,
			held:
				stack.holds.some((hold) => hold.live) || stack.cwdKeepers.length > 0,
			inFlight: stack.activeJobId !== undefined,
			lastUsedAt: stack.lastUsedAt,
		}))
	);
	const next =
		managedRunning.length >= cap.cap
			? supabaseNextToStop(candidates)
			: undefined;
	const capacity: SupabaseState['capacity'] = {
		...base.capacity,
		running: managedRunning.length,
		starting: startingIds.size,
		queued: inputs.jobs.filter((job) => job.status === 'queued').length,
		...(next === undefined ? {} : { nextToStopId: next.stackId }),
	};

	const runningStacks = stacks.filter(isSupabaseStackRunning);
	const awake = runningStacks.filter((stack) => stack.health.awake > 1).length;
	const idle = runningStacks.length - awake;
	const measured = runningStacks.filter(
		(stack) => stack.memoryBytes !== undefined
	);
	const footprint: SupabaseState['footprint'] =
		runningStacks.length > 0 && measured.length === runningStacks.length
			? {
					mode: 'measured',
					bytes: measured.reduce(
						(total, stack) => total + (stack.memoryBytes ?? 0),
						0
					),
					measuredAt: Math.min(
						...measured.map((stack) => stack.measuredAt ?? inputs.now)
					),
					awake,
					idle,
				}
			: {
					mode: 'estimate',
					bytes: Math.round(
						idle * IDLE_STACK_BYTES + awake * AWAKE_STACK_BYTES
					),
					awake,
					idle,
				};

	const diskStacks = stacks.filter((stack) => stack.diskBytes !== undefined);
	const uploadStacks = stacks.filter(
		(stack) => stack.uploadsBytes !== undefined
	);
	const cache = inputs.measurements?.cache;
	const diskTimes = [
		...[...(inputs.measurements?.disk?.values() ?? [])].map(
			(entry) => entry.measuredAt
		),
		...(cache?.measuredAt === undefined ? [] : [cache.measuredAt]),
	];
	const disk: SupabaseState['disk'] = {
		...(diskStacks.length > 0
			? {
					stacksBytes: diskStacks.reduce(
						(total, stack) => total + (stack.diskBytes ?? 0),
						0
					),
				}
			: {}),
		...(uploadStacks.length > 0
			? {
					uploadsBytes: uploadStacks.reduce(
						(total, stack) => total + (stack.uploadsBytes ?? 0),
						0
					),
				}
			: {}),
		...(cache?.bytes === undefined ? {} : { cacheBytes: cache.bytes }),
		cacheState: cache?.state ?? 'unknown',
		...(diskTimes.length > 0 ? { measuredAt: Math.max(...diskTimes) } : {}),
	};

	const homeRoot = inputs.homeStateRoot;
	const foreign =
		homeRoot === undefined
			? []
			: [
					...new Set(
						reservationList
							.map((reservation) => reservation.stateRoot)
							.filter((root) => root !== homeRoot)
							.map((root) => label(path.dirname(root)))
					),
				].slice(0, MAX_FOREIGN_HOMES);

	const managedIds = new Set(
		facts
			.filter((worktree) => worktree.mode.value === 'managed')
			.flatMap((worktree) =>
				worktree.expectedStackId === undefined ? [] : [worktree.expectedStackId]
			)
	);
	const containerStacks = stacks
		.filter(
			(stack) =>
				(stack.runtime === 'docker' || stack.runtime === 'podman') &&
				(managedIds.has(stack.id) ||
					stack.origin === 'managed' ||
					stack.origin === 'adopted')
		)
		.map((stack) => stack.id)
		.slice(0, MAX_CONTAINER_NOTICES);
	const registryError = registryErrorFrom(inputs.reservations);

	const worktreeOf = (stackId: string) =>
		recordById.get(stackId)?.worktreePath ??
		facts.find((worktree) => worktree.expectedStackId === stackId)
			?.worktreePath;
	const requests = (inputs.requests ?? [])
		.slice(0, MAX_REQUESTS)
		.map((record) =>
			requestView(
				record,
				byId,
				inputs.sessions ?? [],
				capacity,
				managedRunning,
				worktreeOf,
				inputs.now
			)
		);

	const repositoryStacks = stacks.map((stack) => ({
		id: stack.id,
		state: stack.state,
		repositoryId: stack.repositoryId,
		worktreePath: worktreeOf(stack.id),
		branchContext: stack.branchContext,
		flags: stack.flags,
	}));
	const repositories = inputs.repositories
		.slice(0, MAX_REPOSITORIES)
		.flatMap((repository) => {
			try {
				return [
					summarizeSupabaseRepository(repository, {
						platform: base.availability.platform,
						featureEnabled: true,
						stacks: repositoryStacks,
						pathLabel,
					}),
				];
			} catch (error) {
				log(
					`Supabase repository ${repository.id} could not be summarized: ${error instanceof Error ? error.name : 'error'}`
				);
				return [];
			}
		});

	const inspection = inspectionFor(inputs, byId);
	const state: SupabaseState = {
		...base,
		capacity,
		footprint,
		disk,
		home: {
			label: base.home.label,
			...(foreign.length > 0 ? { foreign } : {}),
		},
		stacks,
		repositories,
		requests,
		jobs: dedupeJobs(inputs.jobs),
		prune: prune.summary,
		transientCount: stacks.filter((stack) => stack.flags.includes('transient'))
			.length,
		notices: {
			containerStacks,
			...(registryError === undefined ? {} : { registryError }),
		},
		...(inspection === undefined ? {} : { inspection }),
		trafficSignature: supabaseTrafficSignature(
			stacks.flatMap((stack) =>
				stack.ports.api === undefined
					? []
					: [{ port: stack.ports.api, stackId: stack.id }]
			)
		),
	};
	return validated(state, base, log);
}

function dedupeJobs(jobs: readonly SupabaseJob[]): SupabaseJob[] {
	const seen = new Set<string>();
	return jobs
		.filter((job) => {
			if (seen.has(job.id)) return false;
			seen.add(job.id);
			return true;
		})
		.slice(0, MAX_JOBS);
}

function validated(
	state: SupabaseState,
	fallback: SupabaseState,
	log: (line: string) => void
): SupabaseState {
	const parsed = supabaseStateSchema.safeParse(state);
	if (parsed.success) return parsed.data;
	log(`Supabase state failed its schema: ${issuePaths(parsed.error)}`);
	const minimal = supabaseStateSchema.safeParse({
		...fallback,
		stacks: [],
		repositories: [],
		requests: [],
		jobs: [],
		discovery: {
			...fallback.discovery,
			listFailure: {
				message: 'RN Devtools could not describe the local Supabase stacks.',
				at: fallback.updatedAt,
			},
		},
	});
	if (minimal.success) return minimal.data;
	throw new Error('The Supabase state could not be assembled.');
}

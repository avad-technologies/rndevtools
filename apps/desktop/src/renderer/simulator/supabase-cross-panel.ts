import { formatAgo } from '@/lib/format';
import {
	type SupabaseOperationInput,
	type SupabaseSessionBackend,
	supabaseActiveJob,
	supabaseBackendsForSession,
	supabaseConfirmationKind,
	supabaseStackForLane,
} from '@/simulator/supabase-model';
import {
	formatStopDelay,
	holdCountdownLabel,
	isPathInside,
} from '../../shared/device-hold';
import type { LaneView, LaneWorktree } from '../../shared/lane-protocol';
import {
	formatSupabaseSize,
	isSupabaseStackLanExposed,
	isSupabaseStackRunning,
	type LaneBackendChip,
	type LaneBackendSummary,
	type LaneWorktreeSupabase,
	laneBackendChip,
	laneBackendSelectAvailability,
	laneDefaultBackend,
	laneWorktreeSupabaseSuffix,
	SUPABASE_REASONS,
	type SupabaseAvailability,
	type SupabaseHold,
	type SupabaseHoldRef,
	type SupabaseStackSummary,
	type SupabaseState,
	stackStatus,
	supabaseActionAvailability,
	supabaseAgentLabel,
	supabaseHoldMatches,
	supabaseStackTitle,
} from '../../shared/supabase-protocol';

/**
 * Local Supabase as the Lanes, Fleet and Agents surfaces see it: which stack
 * a lane runs on, what its Backend section says, what the start form offers,
 * and which stacks an agent session holds. Pure and node-tested; the panels
 * render these shapes and never re-derive the joins in JSX. Keys never
 * appear here, only variable names.
 */

type LaneRef = Pick<LaneView, 'id' | 'backend'>;
type Tone = 'success' | 'warning' | 'danger' | 'info' | 'default';
type AgentKind = 'claude' | 'codex' | 'other';

/** `64616c83…`: the stack id prefix the cross-panel lines and search use. */
export function stackIdPrefix(id: string): string {
	return `${id.slice(0, 8)}…`;
}

/** Whether Lanes, Fleet and Agents show local Supabase at all: never while off. */
export function supabaseChipsVisible(
	state: Pick<SupabaseState, 'feature'>
): boolean {
	return state.feature.enabled;
}

/**
 * The stack a lane's backend runs on: the one its summary names, else the
 * stack that lists the lane (main matches those by worktree HEAD, so a lane
 * started before a desktop restart still finds it).
 */
export function laneBackendStack(
	lane: LaneRef,
	state: Pick<SupabaseState, 'stacks'>
): SupabaseStackSummary | undefined {
	const named = lane.backend?.stackId;
	const byId =
		named === undefined
			? undefined
			: state.stacks.find((stack) => stack.id === named);
	return byId ?? supabaseStackForLane(state, lane.id);
}

/**
 * A stack's chip where no lane summary speaks for it, such as an agent's
 * `supabase up`: `db :24410` while it runs, amber without a database, red
 * for a LAN-exposed container stack.
 */
export function stackBackendChip(
	stack: SupabaseStackSummary,
	jobs: SupabaseState['jobs']
): LaneBackendChip {
	if (isSupabaseStackLanExposed(stack)) {
		return { label: 'db refused · LAN', tone: 'danger' };
	}
	if (isSupabaseStackRunning(stack)) {
		return stack.ports.api === undefined
			? { label: 'db ready', tone: 'success' }
			: { label: `db :${stack.ports.api}`, tone: 'success' };
	}
	if (stack.state === 'starting' || supabaseActiveJob(stack, jobs)) {
		return { label: 'db starting', tone: 'warning' };
	}
	if (stack.flags.includes('stale-branch')) {
		return { label: 'db stale', tone: 'warning' };
	}
	return { label: 'db stopped', tone: 'warning' };
}

/** The explicit port a URL names, if any. */
export function portOf(url: string | undefined): number | undefined {
	if (url === undefined) return undefined;
	try {
		const port = Number(new URL(url).port);
		return Number.isInteger(port) && port > 0 ? port : undefined;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Lane backend: status words, reasons and notes

type LaneBackendStatus = LaneBackendSummary['status'];
type LaneBackendReason = NonNullable<LaneBackendSummary['reason']>;
type LaneBackendWarning = LaneBackendSummary['warnings'][number];

const SUMMARY_STATUS: Readonly<Record<LaneBackendStatus, string>> = {
	ready: 'Ready',
	starting: 'Starting…',
	stopped: 'Stopped',
	skipped: 'Skipped',
	failed: 'Failed',
	refused: 'Refused',
	stale: 'Stale branch',
	shadowed: 'Shadowed by .env',
	blocked: 'Blocked',
};

const SUMMARY_TONE: Readonly<Record<LaneBackendStatus, Tone>> = {
	ready: 'success',
	starting: 'info',
	stopped: 'warning',
	skipped: 'warning',
	failed: 'danger',
	refused: 'danger',
	stale: 'warning',
	shadowed: 'warning',
	blocked: 'warning',
};

/** What a lane-backend reason means when main sent no words of its own. */
const LANE_BACKEND_REASON_TEXT: Readonly<Record<LaneBackendReason, string>> = {
	off: 'The lane started with Backend off.',
	disabled: 'Local Supabase is off.',
	'no-project': 'This worktree has no Supabase project.',
	'not-managed':
		"Observed only: RN Devtools doesn't manage this worktree's stack.",
	capacity: 'Every stack slot was in use when the lane started.',
	'git-busy': 'A git operation was in progress in the worktree.',
	'ports-pinned':
		'Its supabase/config.toml pins listener ports another stack holds.',
	'lan-exposed':
		'A Docker or Podman stack on this identity listens on your network, so it was refused.',
	'cli-mismatch':
		'The stack runs on another Supabase CLI release than this worktree.',
	'branch-moved': 'The worktree moved to another branch since it started.',
	'dotenv-shadowed':
		"The app's own .env files set the same names and override them.",
	timeout: "The database wasn't ready in time; the app opens once it is.",
	failed: 'The database did not start.',
};

/** The notes a lane's backend carries, in the Backend section. */
const WARNING_TEXT: Readonly<
	Record<Exclude<LaneBackendWarning, 'previous-session-on-simulator'>, string>
> = {
	'shared-default-keys':
		'Every local stack shares the default keys, so a token from one stack also works on the others.',
	'cli-untested':
		"This worktree's Supabase CLI release isn't verified for RN Devtools.",
	'composition-drift':
		'A start without exclusions turned excluded services back on.',
	'pinned-by-environment':
		'The lane environment already sets some of these names, so Metro keeps its own values.',
	'dotenv-shadowed':
		"The app's own .env files set some of these names and override them.",
	'memory-warning':
		'Memory pressure is high. Stop stacks or Simulators you are not using.',
};

/** The lane chip, or none while local Supabase is off. */
export function laneChipFor(
	lane: Pick<LaneView, 'backend'>,
	state: Pick<SupabaseState, 'feature'>
): LaneBackendChip | undefined {
	return supabaseChipsVisible(state)
		? laneBackendChip(lane.backend)
		: undefined;
}

/** `Running · stack 64616c83…`, or the summary's word when no stack is listed. */
export function laneBackendStatusText(
	summary: LaneBackendSummary | undefined,
	stack: SupabaseStackSummary | undefined,
	jobs: SupabaseState['jobs']
): Readonly<{ text: string; tone: Tone }> {
	if (stack) {
		const status = stackStatus(stack, { jobs });
		return {
			text: `${status.label} · stack ${stackIdPrefix(stack.id)}`,
			tone: status.tone,
		};
	}
	if (!summary) return { text: 'Not attached', tone: 'default' };
	const word = SUMMARY_STATUS[summary.status];
	return {
		text:
			summary.status === 'skipped' && summary.reason === 'capacity'
				? `${word} · capacity`
				: word,
		tone: SUMMARY_TONE[summary.status],
	};
}

/** Main's own reason, else the reason code in words; none once it is ready. */
export function laneBackendReasonText(
	summary: LaneBackendSummary | undefined
): string | undefined {
	if (!summary || summary.status === 'ready') return undefined;
	const text = summary.reasonText?.trim();
	if (text) return /[.!?…]$/.test(text) ? text : `${text}.`;
	return summary.reason === undefined
		? undefined
		: LANE_BACKEND_REASON_TEXT[summary.reason];
}

// ---------------------------------------------------------------------------
// Lane backend: the lane detail's Backend section

type LaneBackendHolder = Readonly<{
	/** `Held by this lane · Claude 7f3a2c91 (live)`. */
	text: string;
	agent?: Readonly<{ kind: AgentKind; sessionId: string }>;
}>;

type LaneBackendView = Readonly<{
	summary?: LaneBackendSummary;
	stack?: SupabaseStackSummary;
	status: Readonly<{ text: string; tone: Tone }>;
	reason?: string;
	/** Loopback and public, so the renderer may copy it itself. */
	apiUrl?: string;
	/** Names only: Metro got these variables, the values stay in main. */
	appEnvNames: readonly string[];
	holder?: LaneBackendHolder;
	/** Other holders, e.g. `Codex 5d1b8f40 · gone · stops in 7 min`. */
	others: readonly string[];
	/** The stack attached after Metro started, or its ports moved since. */
	needsMetroRestart: boolean;
	/** The lane's Simulator last ran against another stack (sb-127-auth-token). */
	carryOver: boolean;
	notes: readonly string[];
}>;

function holdClock(hold: SupabaseHold, now: number): string {
	return holdCountdownLabel(
		{
			live: hold.live,
			releaseAt: hold.releaseAt,
			holder: hold.holder,
			synthetic: hold.holder !== 'operator' && hold.agent?.synthetic === true,
		},
		now,
		{ verb: 'stops' }
	).text;
}

function holderWithClock(
	hold: SupabaseHold,
	now: number,
	options: Readonly<{ pinned: boolean; ownLane: boolean }>
): string {
	// The operator and other lanes only ever follow "Also held by".
	if (hold.holder === 'operator') {
		return options.pinned ? 'you (pinned)' : 'you (Supabase tab)';
	}
	if (!hold.agent) return options.ownLane ? 'You' : 'another lane';
	const name = supabaseAgentLabel(hold.agent);
	const clock = holdClock(hold, now);
	// A synthetic holder's name already says it is held by its worktree.
	return clock === 'by worktree' ? name : `${name} (${clock})`;
}

/**
 * The lane detail's Backend section, or undefined when there is nothing to
 * show: local Supabase off, or a lane that never asked for a backend and has
 * no stack.
 */
export function laneBackendView(
	lane: LaneView,
	state: SupabaseState,
	now: number
): LaneBackendView | undefined {
	if (!state.feature.enabled) {
		return undefined;
	}
	const summary = lane.backend;
	const stack = laneBackendStack(lane, state);
	if (!stack && (!summary || summary.policy === 'off')) return undefined;
	const laneHold = stack?.holds.find(
		(hold) => hold.holder === 'lane' && hold.laneId === lane.id
	);
	const holder: LaneBackendHolder | undefined = laneHold
		? {
				text: `Held by this lane · ${holderWithClock(laneHold, now, {
					pinned: false,
					ownLane: true,
				})}`,
				...(laneHold.holder === 'lane' && laneHold.agent
					? {
							agent: {
								kind: laneHold.agent.kind,
								sessionId: laneHold.agent.sessionId,
							},
						}
					: {}),
			}
		: undefined;
	const others = (stack?.holds ?? [])
		.filter((hold) => hold !== laneHold)
		.map((hold) =>
			holderWithClock(hold, now, {
				pinned: stack?.pinned === true,
				ownLane: false,
			})
		);
	const reason = laneBackendReasonText(summary);
	const apiUrl = summary?.apiUrl ?? stack?.apiUrl;
	const notes = (summary?.warnings ?? []).flatMap((warning) =>
		warning === 'previous-session-on-simulator' ? [] : [WARNING_TEXT[warning]]
	);
	return {
		...(summary ? { summary } : {}),
		...(stack ? { stack } : {}),
		status: laneBackendStatusText(summary, stack, state.jobs),
		...(reason === undefined ? {} : { reason }),
		...(apiUrl === undefined ? {} : { apiUrl }),
		appEnvNames: summary?.appEnvNames ?? [],
		...(holder ? { holder } : {}),
		others: [...new Set(others)].slice(0, 3),
		needsMetroRestart:
			summary?.metro === 'needs-restart' ||
			stack?.lanes.some(
				(candidate) =>
					candidate.laneId === lane.id && candidate.needsMetroRestart
			) === true,
		carryOver:
			summary?.warnings.includes('previous-session-on-simulator') === true,
		notes,
	};
}

type ControlContext = Readonly<{
	bridgeAvailable: boolean;
	state: Pick<SupabaseState, 'feature' | 'availability'>;
	/** The lane's own Supabase operation is in flight. */
	pending?: boolean;
}>;

/**
 * Restart Metro to attach: the lane's Metro must still run, and the bridge,
 * the feature and the platform come first, as everywhere else.
 */
export function laneRestartMetroAvailability(
	lane: Pick<LaneView, 'metro'>,
	context: ControlContext
): SupabaseAvailability {
	if (!context.bridgeAvailable) {
		return { allowed: false, check: 'bridge', reason: SUPABASE_REASONS.bridge };
	}
	if (!context.state.feature.enabled) {
		return { allowed: false, check: 'off', reason: SUPABASE_REASONS.off };
	}
	if (!context.state.availability.platform.supported) {
		return {
			allowed: false,
			check: 'platform',
			reason: SUPABASE_REASONS.platform,
		};
	}
	if (context.pending === true) {
		return {
			allowed: false,
			check: 'in-flight',
			reason: SUPABASE_REASONS.inFlight,
		};
	}
	return lane.metro === 'stopped'
		? {
				allowed: false,
				check: 'state',
				reason: SUPABASE_REASONS.metroNotRunning,
			}
		: { allowed: true };
}

const LIVE_STATES: ReadonlySet<SupabaseStackSummary['state']> = new Set([
	'running',
	'starting',
	'partial',
	'unhealthy',
	'stopping',
]);

type LaneStopBackend = Readonly<{
	operation: Extract<SupabaseOperationInput, { kind: 'stop' }>;
	availability: SupabaseAvailability;
	confirmation: ReturnType<typeof supabaseConfirmationKind>;
	/** `Stop backend`, with an ellipsis when main's dialog guards it. */
	label: string;
}>;

/**
 * Stop backend for a lane's stack while it runs: Stop's own availability,
 * and how it confirms (ConfirmAction while a live agent holds the stack,
 * main's dialog for a stack RN Devtools didn't start).
 */
export function laneStopBackend(
	stack: SupabaseStackSummary | undefined,
	state: SupabaseState,
	context: Readonly<{ bridgeAvailable: boolean; pending?: boolean }>
): LaneStopBackend | undefined {
	if (!stack || !LIVE_STATES.has(stack.state)) return undefined;
	const operation: LaneStopBackend['operation'] = {
		kind: 'stop',
		stackIds: [stack.id],
	};
	const confirmation = supabaseConfirmationKind(operation, state);
	return {
		operation,
		availability: supabaseActionAvailability(stack, 'stop', {
			bridgeAvailable: context.bridgeAvailable,
			state,
			...(context.pending === undefined ? {} : { pending: context.pending }),
		}),
		confirmation,
		label: confirmation.kind === 'native' ? 'Stop backend…' : 'Stop backend',
	};
}

// ---------------------------------------------------------------------------
// Lanes start form: worktree suffixes and the Backend select

/** Main's home-relative label for a path, `~/code/app`, when it sits under /Users. */
function homeLabel(path: string): string {
	const match = /^\/Users\/[^/]+(?=\/|$)/.exec(path);
	return match ? `~${path.slice(match[0].length)}` : path;
}

function withoutTrailingSlash(value: string): string {
	return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

/** Whether a lane path and one of main's path labels name the same folder. */
function pathMatchesLabel(path: string, label: string): boolean {
	const target = withoutTrailingSlash(label);
	const plain = withoutTrailingSlash(path);
	return target === plain || target === homeLabel(plain);
}

/** Whether a path lies inside the folder one of main's labels names. */
function pathInsideLabel(path: string, label: string): boolean {
	return isPathInside(path, label) || isPathInside(homeLabel(path), label);
}

type LaneWorktreeBackend = Readonly<{
	/** What the picker suffix and the Backend select read. */
	supabase?: LaneWorktreeSupabase;
	/** Use local Supabase here is off for this worktree's repository. */
	repositoryOff?: boolean;
	/** Main has not listed the worktree yet; the start decides. */
	unknown?: boolean;
}>;

/**
 * A worktree's Supabase project: what main put on the lane worktree, else
 * main's repository rows matched by path. Managed, observed (with main's
 * reason) or none, and whether its stack pins listener ports.
 */
export function laneWorktreeBackend(
	worktree: Pick<LaneWorktree, 'path' | 'supabase'>,
	state: Pick<SupabaseState, 'repositories' | 'stacks'>
): LaneWorktreeBackend {
	if (worktree.supabase) return { supabase: worktree.supabase };
	for (const repository of state.repositories) {
		const row = repository.worktrees.find((candidate) =>
			pathMatchesLabel(worktree.path, candidate.pathLabel)
		);
		if (!row) continue;
		if (row.mode === 'off') {
			return repository.mode === 'off'
				? { repositoryOff: true }
				: { supabase: { project: 'none' } };
		}
		if (row.mode === 'observed') {
			return {
				supabase: {
					project: 'observed',
					...(row.reasonText === undefined
						? {}
						: { reasonText: row.reasonText }),
				},
			};
		}
		const stack =
			row.stackId === undefined
				? undefined
				: state.stacks.find((candidate) => candidate.id === row.stackId);
		const pinned =
			stack !== undefined &&
			(stack.flags.includes('ports-pinned') || stack.pinnedPort !== undefined);
		return {
			supabase: {
				project: 'managed',
				...(pinned ? { portsPinned: true } : {}),
			},
		};
	}
	return { unknown: true };
}

/** The picker suffix: ` · Supabase`, ` · Supabase (needs opt-in)`, or nothing. */
export function laneWorktreeOptionSuffix(
	info: LaneWorktreeBackend,
	state: Pick<SupabaseState, 'feature'>
): string {
	if (info.repositoryOff) {
		return '';
	}
	const suffix = laneWorktreeSupabaseSuffix(
		info.supabase,
		state.feature.enabled
	);
	return suffix === undefined ? '' : ` ${suffix}`;
}

/**
 * Whether Auto or Required may be offered for a worktree. A worktree main
 * has not listed yet is left to the start; Off is always possible.
 */
export function laneBackendAvailability(
	info: LaneWorktreeBackend,
	state: Pick<SupabaseState, 'feature' | 'availability'>
): SupabaseAvailability {
	if (info.unknown || info.repositoryOff) {
		const base = laneBackendSelectAvailability({ project: 'managed' }, state);
		if (!base.allowed || info.unknown) return base;
		return {
			allowed: false,
			check: 'mode',
			reason:
				'Local Supabase is off for this repository. Turn it back on in Supabase › Repositories.',
		};
	}
	return laneBackendSelectAvailability(info.supabase, state);
}

/** `default` follows the environment's lane default; the rest are explicit. */
export type LaneBackendChoice = 'default' | 'auto' | 'off' | 'required';

const POLICY_LABELS = {
	auto: 'Auto',
	off: 'Off',
	required: 'Required',
} as const;

type LaneBackendSelect = Readonly<{
	options: readonly Readonly<{ value: LaneBackendChoice; label: string }>[];
	/** What the select shows; Off while it is disabled. */
	value: LaneBackendChoice;
	availability: SupabaseAvailability;
	/** The visible line under the fields: the effect, or why it is disabled. */
	hint: string;
	/** What the start request carries; absent keeps the environment default. */
	backend?: 'auto' | 'off' | 'required';
	/** Whether the start brings up a database, for the pending message. */
	starts: boolean;
}>;

/**
 * The Backend select for a start: `Auto (development)` (the environment's
 * default, sent as nothing) then the explicit choices, or a disabled Off
 * with its reason as visible text.
 */
export function laneBackendSelect(
	input: Readonly<{
		info: LaneWorktreeBackend;
		environmentId: string;
		choice: LaneBackendChoice;
		state: Pick<SupabaseState, 'feature' | 'availability' | 'policy' | 'disk'>;
	}>
): LaneBackendSelect {
	const availability = laneBackendAvailability(input.info, input.state);
	if (!availability.allowed) {
		return {
			options: [{ value: 'off', label: 'Off' }],
			value: 'off',
			availability,
			hint: availability.reason,
			starts: false,
		};
	}
	const fallback = laneDefaultBackend(input.state.policy, input.environmentId);
	const options: { value: LaneBackendChoice; label: string }[] = [
		{
			value: 'default',
			label: `${POLICY_LABELS[fallback]} (${input.environmentId})`,
		},
		...(['auto', 'off', 'required'] as const)
			.filter((policy) => policy !== fallback)
			.map((policy) => ({ value: policy, label: POLICY_LABELS[policy] })),
	];
	const value = options.some((option) => option.value === input.choice)
		? input.choice
		: 'default';
	const effective = value === 'default' ? fallback : value;
	const timing =
		input.state.disk.cacheState === 'warm'
			? 'about 5 s'
			: 'about 5 s; first start about 45 s';
	const hint =
		effective === 'off'
			? 'Backend: off. Metro gets no Supabase variables for this lane.'
			: effective === 'required'
				? `Backend: required. The lane starts only if this worktree's database does (${timing}).`
				: `Backend: starts or resumes this worktree's database (${timing}); the app opens when it is ready.`;
	return {
		options,
		value,
		availability,
		hint,
		...(value === 'default' ? {} : { backend: value }),
		starts: effective !== 'off',
	};
}

/** The start's pending notice, naming the backend when one comes up. */
export function laneStartPendingMessage(
	input: Readonly<{ slim: boolean; backend: boolean }>
): string {
	if (input.backend) {
		return input.slim
			? 'Starting the backend, booting, slimming, and starting Metro…'
			: 'Starting the backend, booting the Simulator, and starting Metro…';
	}
	return input.slim
		? 'Booting, slimming, and starting Metro…'
		: 'Booting the Simulator and starting Metro…';
}

// ---------------------------------------------------------------------------
// Fleet

export type LaneBackendBrief = Readonly<{
	chip: LaneBackendChip;
	/** `Running · stack 64616c83…`, the Fleet Lane section's Backend line. */
	line: string;
	stackId?: string;
	apiPort?: number;
	dbPort?: number;
}>;

/** A lane's backend for Fleet rows and tiles, or none while hidden. */
export function laneBackendBrief(
	lane: LaneView,
	state: Pick<SupabaseState, 'feature' | 'stacks' | 'jobs'>
): LaneBackendBrief | undefined {
	const chip = laneChipFor(lane, state);
	if (!chip) return undefined;
	const stack = laneBackendStack(lane, state);
	const apiPort = stack?.ports.api ?? portOf(lane.backend?.apiUrl);
	const dbPort = stack?.ports.db;
	return {
		chip,
		line: laneBackendStatusText(lane.backend, stack, state.jobs).text,
		...(stack ? { stackId: stack.id } : {}),
		...(apiPort === undefined ? {} : { apiPort }),
		...(dbPort === undefined ? {} : { dbPort }),
	};
}

// ---------------------------------------------------------------------------
// Agents view

type SessionRef = Readonly<{
	kind: AgentKind;
	sessionId: string;
	cwd?: string | undefined;
}>;

export type SessionBackendView = Readonly<{
	key: string;
	stack: SupabaseStackSummary;
	via: SupabaseSessionBackend['via'];
	live: boolean;
	/** The hold behind it, for HolderBadge; none for a cwd keeper. */
	hold?: SupabaseHold;
	release?: SupabaseHoldRef;
	chip: LaneBackendChip;
	/** `feat-checkout · via lane :8102`. */
	text: string;
}>;

function viaText(
	backend: Pick<SessionBackendView, 'via' | 'stack' | 'hold'>
): string {
	switch (backend.via) {
		case 'lane': {
			const laneId =
				backend.hold?.holder === 'lane' ? backend.hold.laneId : undefined;
			const port = backend.stack.lanes.find(
				(lane) => lane.laneId === laneId
			)?.port;
			return port === undefined ? 'via its lane' : `via lane :${port}`;
		}
		case 'session':
			return 'supabase up';
		case 'worktree':
			return 'held by worktree';
		case 'cwd':
			return 'works in its worktree';
	}
}

/**
 * The stacks an agent session holds: by its own lane, session or worktree
 * hold, as the shared MCP identity of its kind working in the worktree
 * (held by worktree), or as a session working inside it (cwd).
 */
export function sessionSupabaseBackends(
	session: SessionRef,
	state: Pick<SupabaseState, 'feature' | 'stacks' | 'jobs'>
): readonly SessionBackendView[] {
	if (!supabaseChipsVisible(state)) return [];
	const direct = supabaseBackendsForSession(state, session);
	const byStack = new Map<string, SessionBackendView>();
	const view = (
		backend: Omit<SessionBackendView, 'key' | 'chip' | 'text'>
	): SessionBackendView => ({
		...backend,
		key: `${backend.stack.id}:${backend.via}`,
		chip: stackBackendChip(backend.stack, state.jobs),
		text: `${supabaseStackTitle(backend.stack)} · ${viaText(backend)}`,
	});
	for (const backend of direct) {
		const hold =
			backend.via === 'cwd'
				? undefined
				: backend.stack.holds.find(
						(candidate) =>
							candidate.holder === backend.via &&
							candidate.agent?.kind === session.kind &&
							candidate.agent.sessionId === session.sessionId
					);
		byStack.set(
			backend.stack.id,
			view({
				stack: backend.stack,
				via: backend.via,
				live: backend.live,
				...(hold ? { hold } : {}),
				...(backend.release ? { release: backend.release } : {}),
			})
		);
	}
	const cwd = session.cwd;
	for (const stack of state.stacks) {
		const current = byStack.get(stack.id);
		if (current && current.via !== 'cwd') continue;
		const inside =
			current !== undefined ||
			(cwd !== undefined &&
				stack.worktreeLabel !== undefined &&
				pathInsideLabel(cwd, stack.worktreeLabel));
		if (!inside) continue;
		// The shared MCP identity of this session's kind holds it for every
		// session of that kind working in the worktree, this one included.
		const hold = stack.holds.find(
			(candidate) =>
				candidate.holder === 'worktree' &&
				candidate.agent.kind === session.kind &&
				candidate.agent.synthetic
		);
		if (hold?.holder !== 'worktree') continue;
		byStack.set(
			stack.id,
			view({
				stack,
				via: 'worktree',
				live: hold.live,
				hold,
				release: {
					holder: 'worktree',
					agentKind: hold.agent.kind,
					sessionId: hold.agent.sessionId,
				},
			})
		);
	}
	return [...byStack.values()];
}

/** `1 device · 1 backend`, `2 devices`, `1 backend`, or `idle`. */
export function sessionAttachmentLabel(
	devices: number,
	backends: number
): string {
	const parts = [
		devices > 0 ? `${devices} device${devices === 1 ? '' : 's'}` : '',
		backends > 0 ? `${backends} backend${backends === 1 ? '' : 's'}` : '',
	].filter(Boolean);
	return parts.length === 0 ? 'idle' : parts.join(' · ');
}

export type ReleaseBackendPrompt = Readonly<{
	operation: Extract<SupabaseOperationInput, { kind: 'release' }>;
	availability: SupabaseAvailability;
	/** ConfirmAction while the holder is live; an abandoned hold releases at once. */
	confirm: boolean;
	title: string;
	description: string;
	label: string;
}>;

/**
 * Release for a session or worktree hold: what it ends and whether the
 * stack's database stops for it. Lane holds end with their lane, so they
 * have none.
 */
export function releaseBackendPrompt(
	backend: SessionBackendView,
	state: SupabaseState,
	context: Readonly<{ bridgeAvailable: boolean; pending?: boolean }> = {
		bridgeAvailable: true,
	}
): ReleaseBackendPrompt | undefined {
	const ref = backend.release;
	if (!ref) return undefined;
	const operation: ReleaseBackendPrompt['operation'] = {
		kind: 'release',
		stackId: backend.stack.id,
		holder: ref,
	};
	const confirmation = supabaseConfirmationKind(operation, state);
	const { stack } = backend;
	const title = supabaseStackTitle(stack);
	const agent = supabaseAgentLabel({
		kind: ref.agentKind,
		sessionId: ref.sessionId,
		synthetic: ref.holder === 'worktree',
	});
	const keptBy = stack.holds.some(
		(hold) => hold.live && !supabaseHoldMatches(hold, ref)
	);
	const stops =
		LIVE_STATES.has(stack.state) &&
		!stack.pinned &&
		!keptBy &&
		stack.cwdKeepers.length === 0;
	const delay = state.policy.unheldStopDelayMs;
	const when = delay === 0 ? 'at once' : `in ${formatStopDelay(delay)}`;
	return {
		operation,
		availability: supabaseActionAvailability(stack, 'release', {
			bridgeAvailable: context.bridgeAvailable,
			state,
			...(context.pending === undefined ? {} : { pending: context.pending }),
		}),
		confirm: confirmation.kind === 'inline',
		title: `Release ${agent}'s hold on ${title}?`,
		description: stops
			? `Nothing else holds ${title}, so its database stops ${when}. Data is kept, and the agent's next supabase up starts it again.`
			: `${title} keeps running while something else holds it. The agent's next supabase up holds it again.`,
		label: `Release ${agent}'s hold on ${title}`,
	};
}

type SessionRequestLine = Readonly<{
	id: string;
	text: string;
}>;

/** The session's requests still waiting on the user, for Review in Supabase. */
export function sessionRequestLines(
	session: Pick<SessionRef, 'kind' | 'sessionId'>,
	state: Pick<SupabaseState, 'feature' | 'requests'>,
	now: number
): readonly SessionRequestLine[] {
	if (!state.feature.enabled) {
		return [];
	}
	return state.requests.flatMap((request): SessionRequestLine[] => {
		if (
			(request.status !== 'pending' && request.status !== 'settling') ||
			request.requester.kind !== session.kind ||
			request.requester.sessionId !== session.sessionId
		) {
			return [];
		}
		const size =
			request.sizeBytes === undefined
				? ''
				: ` (${formatSupabaseSize(request.sizeBytes)})`;
		const what =
			request.kind === 'destroy'
				? `Asked to destroy ${request.branch}${size}`
				: request.kind === 'reset'
					? `Asked to reset ${request.branch}'s database`
					: `Needs a database for ${request.branch}; every slot is in use`;
		return [
			{
				id: request.id,
				text: `${what} · ${formatAgo(request.createdAt, now)}`,
			},
		];
	});
}

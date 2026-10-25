import {
	type AgentSession,
	agentSessionKey,
} from '../../shared/agent-protocol';
import {
	type DeviceHolder,
	holderClockKey,
	isPathInside,
	isSyntheticHolder,
	resolveHolderLiveness,
} from '../../shared/device-hold';
import type {
	SupabaseHold,
	SupabaseHoldAgent,
	SupabasePolicy,
} from '../../shared/supabase-protocol';
import type { SupabaseHolderKey } from './service-ports';
import type {
	SupabaseHolderClock,
	SupabaseStackRecord,
	SupabaseStoredHold,
} from './stack-store';

/**
 * Who keeps a stack running, and when it stops on its own. Pure: the same
 * inputs give the same answer, so the service, its tests and the steering
 * writer agree.
 *
 * Holds are lanes attached to the stack (their agent, or the operator who
 * started them), agent session holds from `supabase up`, worktree holds for
 * synthetic `mcp-*` callers (live while a session of that kind works inside
 * the worktree), and the operator's pin. A live session whose cwd is inside
 * the worktree also keeps the stack running, except the session asking for
 * its own down or release.
 *
 * Automatic stops (data is always kept): 60 s after the last hold is
 * released, once every holder has been gone past the abandonment grace, at
 * once when the project root has been missing on two consecutive checks;
 * never for a pinned or external stack. While an agent kind's sessions can't
 * be read its holders are unknown rather than gone: their clocks pause, and
 * no linger or abandonment stop fires. Clocks are kept in the stack record
 * so a desktop restart does not start them over.
 */

/**
 * Whether each agent kind's sessions can be read right now.
 */
type SupabaseSessionDiscovery = Readonly<{
	claude: 'ok' | 'unavailable';
	codex: 'ok' | 'unavailable';
}>;

/**
 * A lane attached to the stack.
 */
export type SupabaseHoldLane = Readonly<{
	laneId: string;
	/** The agent driving the lane; absent for a lane the operator started. */
	agent?: DeviceHolder | undefined;
	/**
	 * The lane's checkout, which a synthetic lane agent is judged against, as
	 * its device hold is. Not the app directory inside it: in a monorepo the
	 * agent's session works from the checkout root, above the app.
	 */
	worktreePath: string;
	since: number;
}>;

export type SupabaseHoldsInput = Readonly<{
	now: number;
	policy: Pick<SupabasePolicy, 'unheldStopDelayMs' | 'abandonedGraceMs'>;
	stack: Readonly<{
		origin: 'managed' | 'adopted' | 'external';
		/** Up in some form (running, starting, partial, unhealthy): only then can it stop. */
		live: boolean;
		/** Where its sessions work: the worktree, else the project root. */
		directory: string;
		pinned: boolean;
		pinnedAt?: number | undefined;
		holds: readonly SupabaseStoredHold[];
		/** When the current unheld period began (the record's `releasedAt`). */
		releasedAt?: number | undefined;
		/** The session whose own down started it; its cwd keeps nothing running. */
		releasedBy?:
			| Readonly<{ holder: DeviceHolder; sessionCwd?: string | undefined }>
			| undefined;
		/** A branch follow moved its holds to another stack at this time. */
		supersededAt?: number | undefined;
		/** The project root was missing on two consecutive checks. */
		orphaned: boolean;
		orphanedAt?: number | undefined;
		clocks: Readonly<Record<string, SupabaseHolderClock>>;
	}>;
	lanes: readonly SupabaseHoldLane[];
	/** The live sessions discovery reports (AgentService sessions()). */
	sessions: readonly AgentSession[];
	discovery: SupabaseSessionDiscovery;
	/**
	 * A down or release being decided now ignores its own session as a cwd
	 * keeper; afterwards the record's `releasedBy` keeps ignoring it.
	 */
	ignore?: Readonly<{ holder: DeviceHolder; sessionCwd?: string | undefined }>;
}>;

/**
 * A live session working inside the worktree.
 */
type SupabaseCwdKeeper = Readonly<{
	agent: SupabaseHoldAgent;
	/** Main only; the state shows a label. */
	cwd: string;
}>;

export type SupabaseAutoStopReason =
	| 'released'
	| 'abandoned'
	| 'orphaned'
	| 'superseded';

export type SupabaseHoldsResult = Readonly<{
	/** In the contract's shape, operator first, at most 16. */
	holds: readonly SupabaseHold[];
	cwdKeepers: readonly SupabaseCwdKeeper[];
	/** A live hold or a cwd keeper keeps it running. */
	held: boolean;
	/** An automatic stop waits because agent sessions can't be read. */
	clocksPaused: boolean;
	autoStopAt?: number;
	autoStopReason?: SupabaseAutoStopReason;
	/**
	 * How the record's release period changes: `clear` while something holds
	 * the stack (dropping `releasedAt` and `releasedBy`), or the time an
	 * unheld period began when none is recorded yet. The linger always counts
	 * from the last release, never from an older one.
	 */
	release?: 'clear' | Readonly<{ at: number }>;
	/** The record's clocks after this evaluation; persist them when they differ. */
	clocks: Readonly<Record<string, SupabaseHolderClock>>;
}>;

const MAX_HOLDS = 16;
const MAX_KEEPERS = 16;
const HOLDER_ORDER: Readonly<Record<SupabaseHold['holder'], number>> = {
	operator: 0,
	lane: 1,
	session: 2,
	worktree: 3,
};

/** The hold agent for a holder: synthetic `mcp-*` identities are marked. */
export function supabaseHoldAgent(holder: DeviceHolder): SupabaseHoldAgent {
	return {
		kind: holder.kind,
		sessionId: holder.sessionId,
		synthetic: isSyntheticHolder(holder),
	};
}

type Liveness =
	| Readonly<{ live: true }>
	| Readonly<{ live: false; paused: true }>
	| Readonly<{ live: false; paused: false; abandonedSince: number }>;

/**
 * Runs one abandonment clock the way AgentService runs its own: it starts
 * when the holder goes missing, stops when it is live again, pauses (keeping
 * how long it ran) while its kind can't be seen, and resumes from there.
 */
function holderLiveness(
	holder: DeviceHolder,
	directory: string | undefined,
	input: SupabaseHoldsInput,
	liveKeys: ReadonlySet<string>,
	clocks: Record<string, SupabaseHolderClock>
): Liveness {
	// Nothing discovers other agents' sessions, so they are never known to be
	// gone: their holds count as live until released.
	if (holder.kind === 'other') return { live: true };
	const now = input.now;
	const key = holderClockKey(holder, directory);
	const previous = input.stack.clocks[key];
	const effective =
		previous === undefined
			? undefined
			: 'missingSince' in previous
				? previous.missingSince
				: now - previous.pausedElapsedMs;
	const liveness = resolveHolderLiveness(
		holder,
		{
			liveSessionKeys: liveKeys,
			liveSessions: input.sessions,
			missingSince: new Map(effective === undefined ? [] : [[key, effective]]),
			now,
		},
		directory
	);
	if (liveness.live) return { live: true };
	if (input.discovery[holder.kind] === 'unavailable') {
		if (previous !== undefined) {
			clocks[key] =
				'missingSince' in previous
					? { pausedElapsedMs: Math.max(0, now - previous.missingSince) }
					: previous;
		}
		return { live: false, paused: true };
	}
	const since = Math.min(effective ?? now, now);
	clocks[key] = { missingSince: since };
	return { live: false, paused: false, abandonedSince: since };
}

function timedHold<T extends object>(
	base: T,
	since: number,
	liveness: Liveness,
	graceMs: number
): T & {
	since: number;
	live: boolean;
	abandonedSince?: number;
	releaseAt?: number;
} {
	if (liveness.live) return { ...base, since, live: true };
	if (liveness.paused) return { ...base, since, live: false };
	return {
		...base,
		since,
		live: false,
		abandonedSince: liveness.abandonedSince,
		releaseAt: liveness.abandonedSince + graceMs,
	};
}

/** Whether `session` is the requester a down or release ignores. */
function isIgnored(
	session: AgentSession,
	ignore: SupabaseHoldsInput['ignore']
): boolean {
	if (!ignore) return false;
	if (agentSessionKey(session) === agentSessionKey(ignore.holder)) return true;
	// A synthetic requester stands for every session of its kind; the one
	// working where the request came from is the requester.
	return (
		isSyntheticHolder(ignore.holder) &&
		session.kind === ignore.holder.kind &&
		ignore.sessionCwd !== undefined &&
		session.cwd !== undefined &&
		isPathInside(session.cwd, ignore.sessionCwd)
	);
}

/** Resolves a stack's holds, cwd keepers and automatic stop. */
export function resolveSupabaseHolds(
	input: SupabaseHoldsInput
): SupabaseHoldsResult {
	const { now, stack, policy } = input;
	const graceMs = policy.abandonedGraceMs;
	const liveKeys = new Set(input.sessions.map(agentSessionKey));
	const clocks: Record<string, SupabaseHolderClock> = {};
	const holds: SupabaseHold[] = [];
	let paused = false;

	if (stack.pinned) {
		holds.push({
			holder: 'operator',
			since: stack.pinnedAt ?? now,
			live: true,
		});
	}
	for (const lane of input.lanes) {
		const liveness = lane.agent
			? holderLiveness(lane.agent, lane.worktreePath, input, liveKeys, clocks)
			: ({ live: true } as const);
		if (!liveness.live && liveness.paused) paused = true;
		holds.push(
			timedHold(
				{
					holder: 'lane' as const,
					laneId: lane.laneId,
					...(lane.agent ? { agent: supabaseHoldAgent(lane.agent) } : {}),
				},
				lane.since,
				liveness,
				graceMs
			)
		);
	}
	for (const stored of stack.holds) {
		const holder = {
			kind: stored.agent.kind,
			sessionId: stored.agent.sessionId,
		};
		const liveness = holderLiveness(
			holder,
			stack.directory,
			input,
			liveKeys,
			clocks
		);
		if (!liveness.live && liveness.paused) paused = true;
		holds.push(
			timedHold(
				{
					holder: stored.holder,
					agent: {
						kind: stored.agent.kind,
						sessionId: stored.agent.sessionId,
						synthetic: stored.agent.synthetic || isSyntheticHolder(holder),
					},
				},
				stored.since,
				liveness,
				graceMs
			)
		);
	}
	holds.sort(
		(left, right) =>
			HOLDER_ORDER[left.holder] - HOLDER_ORDER[right.holder] ||
			left.since - right.since
	);

	const liveHolders = new Set(
		holds.flatMap((hold) =>
			hold.live && hold.holder !== 'operator' && hold.agent
				? [agentSessionKey(hold.agent)]
				: []
		)
	);
	// A live synthetic hold already stands for the sessions of its kind
	// working here; they are not listed again as keepers.
	const syntheticKinds = new Set(
		holds.flatMap((hold) =>
			hold.live && hold.holder !== 'operator' && hold.agent?.synthetic
				? [hold.agent.kind]
				: []
		)
	);
	const keepers = new Map<string, SupabaseCwdKeeper>();
	const ignore = input.ignore ?? stack.releasedBy;
	for (const session of input.sessions) {
		if (
			session.cwd === undefined ||
			!isPathInside(session.cwd, stack.directory) ||
			isIgnored(session, ignore) ||
			liveHolders.has(agentSessionKey(session)) ||
			syntheticKinds.has(session.kind)
		) {
			continue;
		}
		keepers.set(agentSessionKey(session), {
			agent: supabaseHoldAgent(session),
			cwd: session.cwd,
		});
	}
	const cwdKeepers = [...keepers.values()].slice(0, MAX_KEEPERS);
	const held = holds.some((hold) => hold.live) || cwdKeepers.length > 0;
	// Any hold, even an abandoned one, or a keeper means the stack is not in
	// an unheld period: a later release starts a fresh linger.
	const occupied = holds.length > 0 || cwdKeepers.length > 0;
	const recorded =
		stack.releasedAt !== undefined || stack.releasedBy !== undefined;
	const base = {
		holds: holds.slice(0, MAX_HOLDS),
		cwdKeepers,
		held,
		clocks,
		...(occupied && recorded ? { release: 'clear' as const } : {}),
	};

	// Only a stack the desktop manages, and that is up, stops on its own.
	if (!stack.live || stack.origin === 'external' || stack.pinned) {
		return { ...base, clocksPaused: false };
	}
	if (stack.orphaned) {
		return {
			...base,
			clocksPaused: false,
			autoStopAt: Math.min(stack.orphanedAt ?? now, now),
			autoStopReason: 'orphaned',
		};
	}
	if (held) return { ...base, clocksPaused: false };
	const sessionsUnreadable =
		input.discovery.claude === 'unavailable' ||
		input.discovery.codex === 'unavailable';
	if (holds.length > 0) {
		// Every holder is gone. A paused clock, or a session we can't see that
		// may work in the worktree, holds the stop back.
		if (paused || sessionsUnreadable) return { ...base, clocksPaused: true };
		const releaseAt = Math.max(
			...holds.map((hold) => hold.releaseAt ?? Number.POSITIVE_INFINITY)
		);
		return Number.isFinite(releaseAt)
			? {
					...base,
					clocksPaused: false,
					autoStopAt: releaseAt,
					autoStopReason: 'abandoned',
				}
			: { ...base, clocksPaused: false };
	}
	const from = stack.releasedAt ?? stack.supersededAt ?? now;
	const release =
		stack.releasedAt === undefined ? { release: { at: from } } : {};
	if (sessionsUnreadable) {
		return { ...base, ...release, clocksPaused: true };
	}
	return {
		...base,
		...release,
		clocksPaused: false,
		autoStopAt: from + policy.unheldStopDelayMs,
		autoStopReason:
			stack.supersededAt !== undefined ? 'superseded' : 'released',
	};
}

/**
 * The `stack` part of the holds input for a stored record: where its
 * sessions work, its pin, stored holds, release period and clocks.
 */
export function supabaseHoldsStack(
	record: Pick<
		SupabaseStackRecord,
		| 'origin'
		| 'worktreePath'
		| 'projectRoot'
		| 'pinned'
		| 'pinnedAt'
		| 'holds'
		| 'releasedAt'
		| 'releasedBy'
		| 'flags'
		| 'clocks'
	>,
	observed: Readonly<{
		live: boolean;
		orphaned: boolean;
		orphanedAt?: number | undefined;
	}>
): SupabaseHoldsInput['stack'] {
	return {
		origin: record.origin,
		live: observed.live,
		directory: record.worktreePath ?? record.projectRoot,
		pinned: record.pinned,
		...(record.pinnedAt === undefined ? {} : { pinnedAt: record.pinnedAt }),
		holds: record.holds,
		...(record.releasedAt === undefined
			? {}
			: { releasedAt: record.releasedAt }),
		...(record.releasedBy === undefined
			? {}
			: {
					releasedBy: {
						holder: record.releasedBy.holder,
						...(record.releasedBy.sessionCwd === undefined
							? {}
							: { sessionCwd: record.releasedBy.sessionCwd }),
					},
				}),
		...(record.flags.supersededAt === undefined
			? {}
			: { supersededAt: record.flags.supersededAt }),
		orphaned: observed.orphaned,
		...(observed.orphanedAt === undefined
			? {}
			: { orphanedAt: observed.orphanedAt }),
		clocks: record.clocks,
	};
}

/** Whether two clock maps hold the same clocks, so a write can be skipped. */
export function sameSupabaseClocks(
	left: Readonly<Record<string, SupabaseHolderClock>>,
	right: Readonly<Record<string, SupabaseHolderClock>>
): boolean {
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(right).length) return false;
	return keys.every((key) => {
		const a = left[key];
		const b = right[key];
		if (a === undefined || b === undefined) return false;
		if ('missingSince' in a) {
			return 'missingSince' in b && a.missingSince === b.missingSince;
		}
		return 'pausedElapsedMs' in b && a.pausedElapsedMs === b.pausedElapsedMs;
	});
}

/**
 * Every holder the stack records name, with the directory each stack lives
 * in: AgentService's `holders` option, so its clocks cover them too.
 */
export function supabaseHolderKeys(
	records: readonly Pick<
		SupabaseStackRecord,
		'holds' | 'worktreePath' | 'projectRoot'
	>[]
): SupabaseHolderKey[] {
	const keys = new Map<string, SupabaseHolderKey>();
	for (const record of records) {
		const directory = record.worktreePath ?? record.projectRoot;
		for (const hold of record.holds) {
			const holder = {
				kind: hold.agent.kind,
				sessionId: hold.agent.sessionId,
			};
			const key = holderClockKey(holder, directory);
			if (!keys.has(key)) keys.set(key, { holder, directory });
		}
	}
	return [...keys.values()];
}

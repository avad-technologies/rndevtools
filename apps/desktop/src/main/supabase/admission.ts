import {
	SUPABASE_MIN_FREE_SYSV_SEGMENTS,
	SUPABASE_POLICY_DEFAULTS,
	SUPABASE_REASONS,
	type SupabaseState,
	supabaseDerivedCap,
} from '../../shared/supabase-protocol';

/**
 * Admission control before every create or resume (DESIGN: capacity and
 * concurrency). One SysV shared-memory segment per running postmaster,
 * shadow databases included, makes `kern.sysv.shmmni` a hard ceiling for the
 * machine; the cap keeps 8 segments free for shadows. Over the cap the least
 * recently used unheld managed stack is stopped (it comes back in about a
 * second); held, pinned and external stacks are never stopped to make room.
 */

/** New stacks are created one at a time: 2.121.0 does not claim native backend ports. */
export const SUPABASE_CREATION_CONCURRENCY = 1;
/** Resumes and stops run two at a time. */
export const SUPABASE_LIFECYCLE_CONCURRENCY = 2;
/** At most this many Supabase CLI children run at once, reads included. */
export const SUPABASE_MAX_CLI_CHILDREN = 4;

type MemoryPressure = SupabaseState['capacity']['memoryPressure'];

/**
 * The running cap: the policy's maxRunning when the operator changed it
 * (1-24), else min(12, floor((shmmni - 8) / 2)) for this Mac.
 */
export function supabaseRunningCap(
	input: Readonly<{ maxRunning: number; shmmni?: number | undefined }>
): Readonly<{ cap: number; derivedCap: number }> {
	const derivedCap = supabaseDerivedCap(input.shmmni);
	const overridden = input.maxRunning !== SUPABASE_POLICY_DEFAULTS.maxRunning;
	const cap = overridden
		? Math.max(1, Math.min(24, Math.floor(input.maxRunning)))
		: derivedCap;
	return { cap, derivedCap };
}

/**
 * A running managed or adopted stack nothing holds, which admission may stop.
 */
export type SupabaseAdmissionCandidate = Readonly<{
	stackId: string;
	lastUsedAt?: number | undefined;
}>;

/** What a stack looks like to candidate selection. */
export type SupabaseAdmissionStack = Readonly<{
	stackId: string;
	origin: 'managed' | 'adopted' | 'external' | 'expected';
	/** Running, partial or unhealthy: it holds a Postgres segment. */
	running: boolean;
	pinned: boolean;
	/** A live hold or a cwd keeper. */
	held: boolean;
	/** A desktop job is running on it. */
	inFlight: boolean;
	lastUsedAt?: number | undefined;
}>;

/** The unheld, unpinned managed stacks admission may stop, LRU first. */
export function supabaseAdmissionCandidates(
	stacks: readonly SupabaseAdmissionStack[]
): SupabaseAdmissionCandidate[] {
	return stacks
		.filter(
			(stack) =>
				(stack.origin === 'managed' || stack.origin === 'adopted') &&
				stack.running &&
				!stack.pinned &&
				!stack.held &&
				!stack.inFlight
		)
		.map((stack) => ({
			stackId: stack.stackId,
			...(stack.lastUsedAt === undefined
				? {}
				: { lastUsedAt: stack.lastUsedAt }),
		}))
		.sort(
			(left, right) =>
				(left.lastUsedAt ?? 0) - (right.lastUsedAt ?? 0) ||
				left.stackId.localeCompare(right.stackId)
		);
}

/** The least recently used candidate: what admission would stop next. */
export function supabaseNextToStop(
	candidates: readonly SupabaseAdmissionCandidate[]
): SupabaseAdmissionCandidate | undefined {
	return [...candidates].sort(
		(left, right) =>
			(left.lastUsedAt ?? 0) - (right.lastUsedAt ?? 0) ||
			left.stackId.localeCompare(right.stackId)
	)[0];
}

export type SupabaseAdmissionInput = Readonly<{
	/** Running managed and adopted stacks. */
	running: number;
	/** Desktop starts in flight; each will hold a segment. */
	starting: number;
	cap: number;
	/** SysV segments; null when ipcs is unavailable (the check is skipped). */
	sysv: Readonly<{ used: number; limit: number }> | null;
	memoryPressure: MemoryPressure;
	candidates: readonly SupabaseAdmissionCandidate[];
}>;

type SupabaseAdmissionWarning = 'memory-warning' | 'sysv-unknown';

export type SupabaseAdmissionDecision =
	| Readonly<{
			kind: 'allow';
			warnings: readonly SupabaseAdmissionWarning[];
	  }>
	| Readonly<{
			/** Stop this stack, then decide again. */
			kind: 'stop-lru';
			stackId: string;
			reason: 'capacity' | 'sysv';
	  }>
	| Readonly<{
			kind: 'refuse';
			reason: 'capacity' | 'sysv' | 'memory';
			/** The visible reason, the same copy the renderer shows. */
			message: string;
	  }>;

/**
 * Whether a start may go ahead now. Critical memory pressure refuses; a full
 * cap or too few free SysV segments stops the least recently used unheld
 * managed stack first, or refuses when there is none. Warnings ride along
 * on an allowed start.
 */
export function decideSupabaseAdmission(
	input: SupabaseAdmissionInput
): SupabaseAdmissionDecision {
	if (input.memoryPressure === 'critical') {
		return {
			kind: 'refuse',
			reason: 'memory',
			message: SUPABASE_REASONS.memoryCritical,
		};
	}
	const next = supabaseNextToStop(input.candidates);
	const occupied = input.running + input.starting;
	if (occupied >= input.cap) {
		return next
			? { kind: 'stop-lru', stackId: next.stackId, reason: 'capacity' }
			: {
					kind: 'refuse',
					reason: 'capacity',
					message: SUPABASE_REASONS.capacityFull(input.running, input.cap),
				};
	}
	if (input.sysv) {
		// Starts already in flight will take a segment each.
		const free = Math.max(
			0,
			input.sysv.limit - input.sysv.used - input.starting
		);
		if (free < SUPABASE_MIN_FREE_SYSV_SEGMENTS) {
			return next
				? { kind: 'stop-lru', stackId: next.stackId, reason: 'sysv' }
				: {
						kind: 'refuse',
						reason: 'sysv',
						message: SUPABASE_REASONS.sysv(free),
					};
		}
	}
	const warnings: SupabaseAdmissionWarning[] = [];
	if (input.memoryPressure === 'warning') warnings.push('memory-warning');
	if (input.sysv === null) warnings.push('sysv-unknown');
	return { kind: 'allow', warnings };
}

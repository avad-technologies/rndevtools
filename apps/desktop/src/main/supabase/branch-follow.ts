import type {
	SupabasePolicy,
	SupabaseStackSummary,
} from '../../shared/supabase-protocol';
import type { SupabaseWorktreeFacts } from './repositories';
import type { SupabaseStackRecord } from './stack-store';

/**
 * Branch follow (DESIGN: branch switches). When a worktree's HEAD moves off
 * the branch of a stack something holds, and stays put for 30 s with no
 * rebase, merge, cherry-pick, revert or bisect in progress, the desktop
 * ensures the new branch's stack natively, moves the holds and lanes over,
 * and stops the old stack (its data is kept, and switching back reattaches
 * it). A detached HEAD is never followed, nor a branch whose config does not
 * opt in. A follow that fails is tried again after a minute, then after
 * twice as long each time, up to half an hour. Pure: the service decides
 * with it and runs the follow itself.
 */

/** HEAD must stay on one value this long before a follow. */
export const SUPABASE_FOLLOW_DEBOUNCE_MS = 30_000;

/** A failed automatic follow waits this long before its next try, doubling. */
export const SUPABASE_FOLLOW_RETRY_MS = 60_000;
const FOLLOW_RETRY_MAX_MS = 30 * 60_000;

/** A project's failed automatic follows to one stack, and when to try again. */
export type SupabaseFollowRetry = Readonly<{
	toStackId: string;
	failures: number;
	retryAt: number;
}>;

/**
 * The retry after one more failed follow to `toStackId`: a minute, then
 * twice as long each time, up to half an hour.
 */
export function nextSupabaseFollowRetry(
	previous: SupabaseFollowRetry | undefined,
	toStackId: string,
	now: number
): SupabaseFollowRetry {
	const failures =
		previous?.toStackId === toStackId ? previous.failures + 1 : 1;
	return {
		toStackId,
		failures,
		retryAt:
			now +
			Math.min(
				FOLLOW_RETRY_MAX_MS,
				SUPABASE_FOLLOW_RETRY_MS * 2 ** (failures - 1)
			),
	};
}

type SupabaseFollowCandidate = Readonly<{
	/** The worktree as Lanes tracks it. */
	worktreePath: string;
	appPath: string;
	projectRoot: string;
	/** The held stacks of this project on another branch. */
	fromStackIds: readonly string[];
	toBranchContext: string;
	/** The id the CLI gives the new branch's stack. */
	toStackId: string;
	dueAt: number;
}>;

export type SupabaseFollowPlan = Readonly<{
	/** Follows due now. */
	due: readonly SupabaseFollowCandidate[];
	/** When the next pending follow becomes due. */
	nextDueAt?: number;
}>;

/** Whether a stack is in use: a live hold, a lane, or a session working there. */
export function isSupabaseStackHeld(
	stack: Pick<SupabaseStackSummary, 'holds' | 'lanes' | 'cwdKeepers'>
): boolean {
	return (
		stack.holds.some((hold) => hold.live) ||
		stack.lanes.length > 0 ||
		stack.cwdKeepers.length > 0
	);
}

/**
 * Tracks when each worktree's HEAD last changed: a new value starts its
 * stable period now, an unchanged one keeps its start. Returns the updated
 * map and the worktrees whose HEAD changed.
 */
export function observeSupabaseHeads(
	previous: ReadonlyMap<string, Readonly<{ ref: string; since: number }>>,
	facts: readonly Pick<SupabaseWorktreeFacts, 'worktreePath' | 'head'>[],
	now: number
): Readonly<{
	heads: Map<string, Readonly<{ ref: string; since: number }>>;
	changed: readonly string[];
}> {
	const heads = new Map<string, Readonly<{ ref: string; since: number }>>();
	const changed: string[] = [];
	for (const worktree of facts) {
		if (heads.has(worktree.worktreePath)) continue;
		const head = worktree.head;
		if (head?.status !== 'ok') continue;
		const ref = `${head.branchContext}${head.operation ? `|${head.operation}` : ''}`;
		const known = previous.get(worktree.worktreePath);
		if (known?.ref === ref) {
			heads.set(worktree.worktreePath, known);
		} else {
			heads.set(worktree.worktreePath, { ref, since: now });
			if (known !== undefined) changed.push(worktree.worktreePath);
		}
	}
	return { heads, changed };
}

/**
 * The follows the policy calls for: in follow mode, for every managed
 * worktree whose HEAD is a branch (not detached, nothing in progress) that
 * differs from a held stack of that worktree, due 30 s after HEAD settled,
 * or later while an earlier follow to the same stack failed. `force` names
 * one stack whose follow skips both waits (the operator's Follow button, an
 * agent's explicit up).
 */
export function planSupabaseFollows(
	input: Readonly<{
		policy: Pick<SupabasePolicy, 'branchSwitch'>;
		facts: readonly SupabaseWorktreeFacts[];
		stacks: readonly SupabaseStackSummary[];
		records: ReadonlyMap<string, SupabaseStackRecord>;
		headStableSince: ReadonlyMap<string, number>;
		now: number;
		/** Project roots a follow is already running for. */
		busy?: ReadonlySet<string>;
		/** Failed automatic follows by project root; another target starts over. */
		retries?: ReadonlyMap<string, SupabaseFollowRetry>;
		force?: string;
	}>
): SupabaseFollowPlan {
	if (input.policy.branchSwitch !== 'follow' && input.force === undefined) {
		return { due: [] };
	}
	const due: SupabaseFollowCandidate[] = [];
	let nextDueAt: number | undefined;
	const seen = new Set<string>();
	for (const facts of input.facts) {
		const head = facts.head;
		const target = facts.expectedStackId;
		if (
			facts.mode.value !== 'managed' ||
			facts.detection?.status !== 'found' ||
			head?.status !== 'ok' ||
			head.operation !== undefined ||
			head.branchContext === 'detached' ||
			target === undefined
		) {
			continue;
		}
		const projectRoot = facts.detection.projectRoot;
		if (seen.has(projectRoot) || input.busy?.has(projectRoot)) continue;
		seen.add(projectRoot);
		const from = input.stacks.filter((stack) => {
			const record = input.records.get(stack.id);
			const worktree = record?.worktreePath;
			return (
				worktree !== undefined &&
				(worktree === facts.worktreePath ||
					worktree === facts.realWorktreePath) &&
				record?.projectRoot === projectRoot &&
				(record?.origin === 'managed' || record?.origin === 'adopted') &&
				stack.id !== target &&
				stack.branchContext !== undefined &&
				stack.branchContext !== head.branchContext &&
				stack.runtime !== 'docker' &&
				stack.runtime !== 'podman' &&
				(input.force === stack.id ||
					(input.force === undefined && isSupabaseStackHeld(stack)))
			);
		});
		if (from.length === 0) continue;
		const forced = input.force !== undefined;
		const since = input.headStableSince.get(facts.worktreePath);
		if (!forced && since === undefined) continue;
		const retry = input.retries?.get(projectRoot);
		const dueAt = forced
			? input.now
			: Math.max(
					(since ?? input.now) + SUPABASE_FOLLOW_DEBOUNCE_MS,
					retry?.toStackId === target ? retry.retryAt : 0
				);
		if (dueAt > input.now) {
			nextDueAt = Math.min(nextDueAt ?? dueAt, dueAt);
			continue;
		}
		due.push({
			worktreePath: facts.worktreePath,
			appPath: facts.appPath,
			projectRoot,
			fromStackIds: from.map((stack) => stack.id),
			toBranchContext: head.branchContext,
			toStackId: target,
			dueAt,
		});
	}
	return { due, ...(nextDueAt === undefined ? {} : { nextDueAt }) };
}

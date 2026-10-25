import {
	isLiveStackState,
	type SupabaseJob,
	type SupabasePruneSummary,
	type SupabaseStackFlag,
	type SupabaseStackState,
	type SupabaseStackSummary,
} from '../../shared/supabase-protocol';
import type { SupabaseAutoStopReason } from './holds';

/**
 * Clean up and automatic stops. Destroy is never automatic: this module only
 * suggests stacks for the operator's Clean up (with sizes) and lists the stops
 * that are due. Prune groups, in order: deleted worktrees, stale branches,
 * stacks stopped longer than the retention, failed or never-started stacks,
 * and unreadable stacks (shown, never selectable). Held, pinned, external,
 * running and in-flight stacks are never suggested.
 */

const DAY_MS = 24 * 60 * 60 * 1_000;

type PruneGroupId = SupabasePruneSummary['groups'][number]['id'];
const PRUNE_ORDER: readonly PruneGroupId[] = [
	'worktree-deleted',
	'stale-branch',
	'retention',
	'failed-start',
	'unreadable',
];
const PRESELECTED: ReadonlySet<PruneGroupId> = new Set([
	'worktree-deleted',
	'failed-start',
]);

/** States a stack can be destroyed in: nothing runs. */
const STOPPED_STATES: ReadonlySet<SupabaseStackState> = new Set([
	'stopped',
	'failed',
	'never-started',
	'interrupted',
]);

/** What clean up needs to know about one stack. */
export type SupabaseGcStack = Readonly<{
	id: string;
	origin: SupabaseStackSummary['origin'];
	state: SupabaseStackState;
	pinned: boolean;
	/** A live hold or a cwd keeper. */
	held: boolean;
	/** A desktop job is running on it. */
	inFlight: boolean;
	/** An attached lane's Metro is not stopped. */
	laneRunning: boolean;
	flags: readonly SupabaseStackFlag[];
	/** When it stopped, else its last use, else its creation. */
	idleSince?: number | undefined;
	/** When its worktree went or its HEAD moved, if known. */
	flaggedAt?: number | undefined;
	diskBytes?: number | undefined;
	uploadsBytes?: number | undefined;
}>;

/**
 * One stack's place in clean up.
 */
type SupabasePruneMark = Readonly<{
	/** The group it is suggested in, when it is. */
	group?: PruneGroupId;
	/** When it was (or will be, while it stays stopped) suggested. */
	suggestedAt?: number;
}>;

export type SupabasePruneResult = Readonly<{
	summary: SupabasePruneSummary;
	marks: ReadonlyMap<string, SupabasePruneMark>;
}>;

function groupFor(
	stack: SupabaseGcStack,
	now: number,
	retentionMs: number
): PruneGroupId | undefined {
	if (stack.flags.includes('transient') || stack.origin === 'expected') {
		return undefined;
	}
	if (stack.state === 'unreadable') return 'unreadable';
	if (
		stack.origin === 'external' ||
		stack.pinned ||
		stack.held ||
		stack.inFlight ||
		stack.laneRunning ||
		!STOPPED_STATES.has(stack.state)
	) {
		return undefined;
	}
	if (
		stack.flags.includes('worktree-deleted') ||
		stack.flags.includes('orphaned')
	) {
		return 'worktree-deleted';
	}
	if (stack.flags.includes('stale-branch')) return 'stale-branch';
	if (
		stack.state === 'failed' ||
		stack.state === 'interrupted' ||
		stack.state === 'never-started'
	) {
		return 'failed-start';
	}
	if (stack.idleSince !== undefined && now - stack.idleSince >= retentionMs) {
		return 'retention';
	}
	return undefined;
}

/** Why a stack is not suggested, one reason each: starting first, then pinned, held, external, running. */
function notSuggestedReason(
	stack: SupabaseGcStack
): keyof SupabasePruneSummary['notSuggested'] | undefined {
	if (stack.state === 'starting' || stack.inFlight) return 'starting';
	if (stack.pinned) return 'pinned';
	if (stack.held) return 'held';
	if (stack.origin === 'external') return 'external';
	if (isLiveStackState(stack.state)) return 'running';
	return undefined;
}

function sameGroups(
	left: SupabasePruneSummary['groups'],
	right: SupabasePruneSummary['groups']
): boolean {
	return (
		left.length === right.length &&
		left.every((group, index) => {
			const other = right[index];
			return (
				other !== undefined &&
				other.id === group.id &&
				other.stackIds.length === group.stackIds.length &&
				other.stackIds.every((id, position) => group.stackIds[position] === id)
			);
		})
	);
}

/**
 * The Clean up summary and each stack's prune mark. The revision moves only
 * when a group's members change, so a selection made on an older revision
 * is refused as stale.
 */
export function computeSupabasePrune(
	input: Readonly<{
		now: number;
		retentionDays: number;
		stacks: readonly SupabaseGcStack[];
		previous?: SupabasePruneSummary | undefined;
	}>
): SupabasePruneResult {
	const retentionMs = input.retentionDays * DAY_MS;
	const members = new Map<PruneGroupId, SupabaseGcStack[]>();
	const marks = new Map<string, SupabasePruneMark>();
	for (const stack of input.stacks) {
		const group = groupFor(stack, input.now, retentionMs);
		if (group === undefined) {
			// A stopped managed stack is suggested once it has been idle for the
			// retention; nextEvents shows that date ahead of time.
			if (
				stack.state === 'stopped' &&
				stack.origin !== 'external' &&
				stack.origin !== 'expected' &&
				!stack.pinned &&
				!stack.flags.includes('transient') &&
				stack.idleSince !== undefined
			) {
				marks.set(stack.id, { suggestedAt: stack.idleSince + retentionMs });
			}
			continue;
		}
		const list = members.get(group) ?? [];
		list.push(stack);
		members.set(group, list);
		const suggestedAt =
			group === 'retention'
				? (stack.idleSince ?? input.now) + retentionMs
				: group === 'unreadable'
					? undefined
					: (stack.flaggedAt ?? stack.idleSince);
		marks.set(stack.id, {
			group,
			...(suggestedAt === undefined
				? {}
				: { suggestedAt: Math.min(suggestedAt, input.now) }),
		});
	}
	const groups = PRUNE_ORDER.flatMap((id) => {
		const list = members.get(id);
		if (!list || list.length === 0) return [];
		const sorted = [...list].sort((left, right) =>
			left.id.localeCompare(right.id)
		);
		const known = sorted.filter((stack) => stack.diskBytes !== undefined);
		return [
			{
				id,
				stackIds: sorted.map((stack) => stack.id),
				...(known.length > 0
					? {
							bytes: known.reduce(
								(total, stack) => total + (stack.diskBytes ?? 0),
								0
							),
						}
					: {}),
				selectable: id !== 'unreadable',
				preselected: PRESELECTED.has(id),
			},
		];
	});
	const suggested = new Set(groups.flatMap((group) => group.stackIds));
	const notSuggested = {
		held: 0,
		pinned: 0,
		starting: 0,
		external: 0,
		running: 0,
	};
	for (const stack of input.stacks) {
		if (suggested.has(stack.id) || stack.origin === 'expected') continue;
		const reason = notSuggestedReason(stack);
		if (reason !== undefined) notSuggested[reason] += 1;
	}
	const measured = input.stacks.filter(
		(stack) => stack.diskBytes !== undefined || stack.uploadsBytes !== undefined
	);
	const selectableBytes = groups
		.filter((group) => group.selectable && group.bytes !== undefined)
		.map((group) => group.bytes ?? 0);
	const previous = input.previous;
	const previousGroups = previous?.groups ?? [];
	const previousRevision = previous?.revision ?? 0;
	const revision = sameGroups(previousGroups, groups)
		? previousRevision
		: previousRevision + 1;
	const summary: SupabasePruneSummary = {
		revision,
		computedAt: input.now,
		groups,
		...(measured.length > 0
			? {
					onDiskBytes: measured.reduce(
						(total, stack) =>
							total + (stack.diskBytes ?? 0) + (stack.uploadsBytes ?? 0),
						0
					),
				}
			: {}),
		...(selectableBytes.length > 0
			? {
					suggestedBytes: selectableBytes.reduce(
						(total, bytes) => total + bytes,
						0
					),
				}
			: {}),
		notSuggested,
		...(previous?.lastResult === undefined
			? {}
			: { lastResult: previous.lastResult }),
	};
	return { summary, marks };
}

/**
 * An automatic stop that is due now.
 */
export type SupabaseDueStop = Readonly<{
	stackId: string;
	reason: SupabaseAutoStopReason;
	/** The job's `requestedBy` for this stop. */
	requestedBy: Extract<SupabaseJob['requestedBy'], { kind: 'automatic' }>;
}>;

const AUTOMATIC_REASON: Readonly<
	Record<
		SupabaseAutoStopReason,
		Extract<SupabaseJob['requestedBy'], { kind: 'automatic' }>['reason']
	>
> = {
	released: 'idle',
	abandoned: 'abandoned',
	orphaned: 'orphaned',
	superseded: 'follow',
};

/**
 * The stops due at `now` from each stack's resolved holds, soonest first.
 * Stacks with a job in flight wait for it; nothing here ever destroys.
 */
export function dueSupabaseStops(
	stacks: readonly Readonly<{
		stackId: string;
		autoStopAt?: number | undefined;
		autoStopReason?: SupabaseAutoStopReason | undefined;
		inFlight: boolean;
	}>[],
	now: number
): SupabaseDueStop[] {
	return stacks
		.flatMap((stack) =>
			stack.autoStopAt !== undefined &&
			stack.autoStopReason !== undefined &&
			stack.autoStopAt <= now &&
			!stack.inFlight
				? [
						{
							stackId: stack.stackId,
							reason: stack.autoStopReason,
							at: stack.autoStopAt,
						},
					]
				: []
		)
		.sort(
			(left, right) =>
				left.at - right.at || left.stackId.localeCompare(right.stackId)
		)
		.map(({ stackId, reason }) => ({
			stackId,
			reason,
			requestedBy: { kind: 'automatic', reason: AUTOMATIC_REASON[reason] },
		}));
}

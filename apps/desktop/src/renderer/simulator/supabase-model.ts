import { formatAgo, formatClock, formatSize } from '@/lib/format';
import type { WithoutActionId } from '@/lib/runtime-action';
import { formatStopDelay, holdCountdownLabel } from '../../shared/device-hold';
import {
	attentionItems,
	isActiveSupabaseJob,
	isSupabaseStackRunning,
	SUPABASE_DETAIL_SECTIONS,
	SUPABASE_MAX_DESTROY_IDS,
	SUPABASE_MAX_LOG_CHARACTERS,
	type SupabaseAgentRequest,
	type SupabaseAttentionItem,
	type SupabaseAttentionRank,
	type SupabaseAvailability,
	type SupabaseDatabasePayload,
	type SupabaseErrorView,
	type SupabaseHold,
	type SupabaseHoldRef,
	type SupabaseInspection,
	type SupabaseJob,
	type SupabaseLogRecord,
	type SupabaseLogsPayload,
	type SupabaseMigrationsView,
	type SupabaseOperation,
	type SupabasePolicy,
	type SupabasePruneSummary,
	type SupabaseRepositorySummary,
	type SupabaseServiceKind,
	type SupabaseStackAction,
	type SupabaseStackChangeView,
	type SupabaseStackStatus,
	type SupabaseStackSummary,
	type SupabaseState,
	type SupabaseTone,
	stackStatus,
	supabaseActionAvailability,
	supabaseAgentLabel,
	supabaseBranchLabel,
	supabaseCleanUpAvailability,
	supabaseConfirmationRequired,
	supabaseHeadMatches,
	supabaseInlineConfirmation,
	supabaseJobLabel,
	supabaseRequestActionAvailability,
	supabaseRevertKeepsStack,
	supabaseStackTitle,
	visibleStackFlags,
} from '../../shared/supabase-protocol';

/**
 * Pure joins for the Supabase tab. The panel reads these shapes and never
 * re-derives stack, hold, job or request facts in JSX; every rule here is
 * node-tested. Nothing here holds a secret: keys appear by name only.
 */

// ---------------------------------------------------------------------------
// Vocabulary

export type SupabaseView = 'stacks' | 'repositories' | 'requests' | 'settings';
export type SupabaseDetailSection = (typeof SUPABASE_DETAIL_SECTIONS)[number];

/** An operation as a control builds it; the runtime adds the actionId. */
export type SupabaseOperationInput = WithoutActionId<SupabaseOperation>;

type AgentRef = Readonly<{
	kind: 'claude' | 'codex' | 'other';
	sessionId: string;
	synthetic?: boolean;
}>;

const LIVE_STATES: ReadonlySet<SupabaseStackSummary['state']> = new Set([
	'running',
	'starting',
	'partial',
	'unhealthy',
	'stopping',
]);
const STOPPED_STATES: ReadonlySet<SupabaseStackSummary['state']> = new Set([
	'stopped',
	'never-started',
	'failed',
	'interrupted',
	'needs-recreate',
]);
const START_JOB_KINDS: ReadonlySet<SupabaseJob['kind']> = new Set([
	'create',
	'resume',
	'prepare',
]);

function isLive(stack: Pick<SupabaseStackSummary, 'state'>): boolean {
	return LIVE_STATES.has(stack.state);
}

function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

/** `64616c83…145f`: enough of a 64-hex id to tell stacks apart. */
export function shortSupabaseId(id: string): string {
	return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

/** Elapsed time rounded down, without `ago`: `18 s`, `7 min`, `2 h`, `3 days`. */
export function formatSupabaseElapsed(ms: number): string {
	const seconds = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / 1_000);
	if (seconds < 60) return `${seconds} s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours} h`;
	return plural(Math.floor(hours / 24), 'day');
}

/** The active job on a stack: the one it names, else any queued or running one. */
export function supabaseActiveJob(
	stack: Pick<SupabaseStackSummary, 'id' | 'activeJobId'>,
	jobs: readonly SupabaseJob[]
): SupabaseJob | undefined {
	const named =
		stack.activeJobId === undefined
			? undefined
			: jobs.find((job) => job.id === stack.activeJobId);
	if (named && isActiveSupabaseJob(named)) return named;
	return jobs.find(
		(job) => isActiveSupabaseJob(job) && job.stackIds.includes(stack.id)
	);
}

// ---------------------------------------------------------------------------
// Tab state, header meta and metrics

export type SupabaseTabState =
	| 'bridge-missing'
	| 'loading'
	| 'unsupported'
	| 'off'
	| 'empty'
	| 'ready';

/** Which of the tab's top-level states to render, highest priority first. */
export function supabaseTabState(
	state: Pick<SupabaseState, 'availability' | 'feature' | 'stacks'>,
	context: Readonly<{ bridgeAvailable: boolean; isLoading: boolean }>
): SupabaseTabState {
	if (!context.bridgeAvailable) return 'bridge-missing';
	if (context.isLoading) return 'loading';
	if (!state.availability.platform.supported) return 'unsupported';
	if (!state.feature.enabled) return 'off';
	return state.stacks.some((stack) => !stack.flags.includes('transient'))
		? 'ready'
		: 'empty';
}

/** Counts behind the header meta, transient stacks left out. */
export function supabaseStackCounts(
	state: Pick<SupabaseState, 'stacks' | 'jobs'>
): Readonly<{ running: number; stopped: number; starting: number }> {
	let running = 0;
	let stopped = 0;
	let starting = 0;
	for (const stack of state.stacks) {
		if (stack.flags.includes('transient')) continue;
		const job = supabaseActiveJob(stack, state.jobs);
		if (
			stack.state === 'starting' ||
			(job !== undefined &&
				(START_JOB_KINDS.has(job.kind) || job.kind === 'recreate'))
		) {
			starting += 1;
		} else if (isSupabaseStackRunning(stack)) {
			running += 1;
		} else if (STOPPED_STATES.has(stack.state)) {
			stopped += 1;
		}
	}
	return { running, stopped, starting };
}

/** `3 running · 4 stopped · 1 starting`, or the state word while not ready. */
export function supabaseHeaderMeta(
	state: Pick<SupabaseState, 'stacks' | 'jobs'>,
	tabState: SupabaseTabState
): string {
	switch (tabState) {
		case 'bridge-missing':
			return 'Unavailable';
		case 'loading':
			return 'Checking…';
		case 'unsupported':
			return 'Not available on this Mac';
		case 'off':
			return 'Off';
		default:
			break;
	}
	const counts = supabaseStackCounts(state);
	const parts = [
		counts.running > 0 ? `${counts.running} running` : '',
		counts.stopped > 0 ? `${counts.stopped} stopped` : '',
		counts.starting > 0 ? `${counts.starting} starting` : '',
	].filter(Boolean);
	return parts.length > 0 ? parts.join(' · ') : 'No stacks';
}

export type SupabaseMetric = Readonly<{
	id: 'running' | 'slots' | 'memory' | 'disk';
	label: string;
	value: string;
	detail: string;
	/** Metrics only ever warn: at the cap, under 4 free slots, critical memory. */
	tone: 'default' | 'warning';
}>;

const METRIC_LABELS = {
	running: 'Running',
	slots: 'Postgres slots',
	memory: 'Memory',
	disk: 'Disk',
} as const;

/**
 * The four metrics: Running n/cap, Postgres slots used/limit, Memory and
 * Disk. They stay on screen in every state, with dashes until there is
 * something to measure.
 */
export function supabaseMetrics(
	state: Pick<
		SupabaseState,
		'capacity' | 'footprint' | 'disk' | 'stacks' | 'jobs'
	>,
	tabState: SupabaseTabState,
	now: number
): readonly SupabaseMetric[] {
	if (tabState !== 'ready' && tabState !== 'empty') {
		const detail = (id: SupabaseMetric['id']) =>
			tabState === 'off'
				? id === 'running'
					? 'off'
					: 'checked when on'
				: tabState === 'unsupported'
					? 'not available'
					: '';
		return (['running', 'slots', 'memory', 'disk'] as const).map((id) => ({
			id,
			label: METRIC_LABELS[id],
			value: '—',
			detail: detail(id),
			tone: 'default',
		}));
	}
	const { capacity, footprint, disk } = state;
	const nextToStop =
		capacity.nextToStopId === undefined
			? undefined
			: state.stacks.find((stack) => stack.id === capacity.nextToStopId);
	const runningDetail =
		capacity.starting > 0
			? `${capacity.starting} starting`
			: nextToStop
				? `next to stop: ${supabaseStackTitle(nextToStop)}`
				: capacity.running >= capacity.cap
					? 'all held'
					: `${capacity.cap - capacity.running} free`;
	const slots: SupabaseMetric = capacity.sysv
		? {
				id: 'slots',
				label: METRIC_LABELS.slots,
				value: `${capacity.sysv.used} / ${capacity.sysv.limit}`,
				detail: `${Math.max(0, capacity.sysv.limit - capacity.sysv.used)} free`,
				tone:
					capacity.sysv.limit - capacity.sysv.used < 4 ? 'warning' : 'default',
			}
		: {
				id: 'slots',
				label: METRIC_LABELS.slots,
				value: '—',
				detail: 'not measured',
				tone: 'default',
			};
	const nothingRuns =
		footprint.bytes === 0 && capacity.running === 0 && capacity.starting === 0;
	const memory: SupabaseMetric = {
		id: 'memory',
		label: METRIC_LABELS.memory,
		value: nothingRuns
			? '—'
			: footprint.mode === 'measured'
				? formatSize(footprint.bytes)
				: `≈ ${formatSize(footprint.bytes)}`,
		detail: nothingRuns
			? 'nothing running'
			: footprint.mode === 'measured'
				? footprint.measuredAt === undefined
					? 'RSS'
					: `RSS · measured ${formatAgo(footprint.measuredAt, now)}`
				: 'estimate',
		tone: capacity.memoryPressure === 'critical' ? 'warning' : 'default',
	};
	const measured = [disk.stacksBytes, disk.uploadsBytes, disk.cacheBytes];
	const diskTotal = measured.some((bytes) => bytes !== undefined)
		? measured.reduce<number>((total, bytes) => total + (bytes ?? 0), 0)
		: undefined;
	return [
		{
			id: 'running',
			label: METRIC_LABELS.running,
			value: `${capacity.running} / ${capacity.cap}`,
			detail: runningDetail,
			tone: capacity.running >= capacity.cap ? 'warning' : 'default',
		},
		slots,
		memory,
		{
			id: 'disk',
			label: METRIC_LABELS.disk,
			value: formatSize(diskTotal),
			detail:
				diskTotal === undefined
					? 'not measured'
					: disk.cacheBytes !== undefined
						? `${formatSize(disk.cacheBytes)} is shared cache`
						: disk.cacheState === 'cold'
							? 'services not downloaded yet'
							: '',
			tone: 'default',
		},
	];
}

// ---------------------------------------------------------------------------
// Notices

/** The tab shows at most this many ranked notices before the +N toggle. */
const SUPABASE_NOTICE_LIMIT = 2;

/**
 * The tab-level notices: attention items without suggestions, capped at
 * two unless expanded. `overflow` is how many sit behind the toggle.
 */
export function supabaseNoticeList(
	items: readonly SupabaseAttentionItem[],
	expanded: boolean
): Readonly<{
	visible: readonly SupabaseAttentionItem[];
	overflow: number;
	toggleLabel?: string;
}> {
	const notices = items.filter((item) => item.rank !== 'suggestion');
	const overflow = Math.max(0, notices.length - SUPABASE_NOTICE_LIMIT);
	const visible = expanded ? notices : notices.slice(0, SUPABASE_NOTICE_LIMIT);
	if (overflow === 0) return { visible, overflow };
	return {
		visible,
		overflow,
		toggleLabel: expanded
			? 'Show fewer notices'
			: `+${overflow} more ${overflow === 1 ? 'notice' : 'notices'}`,
	};
}

type NoticeRank = Exclude<SupabaseAttentionRank, 'suggestion'>;
const ATTENTION_ORDER: Readonly<Record<NoticeRank, number>> = {
	danger: 0,
	request: 1,
	warning: 2,
};

/** Each stack's strongest notice rank; suggestions never make a stack need attention. */
export function supabaseAttentionByStack(
	items: readonly SupabaseAttentionItem[]
): ReadonlyMap<string, NoticeRank> {
	const ranks = new Map<string, NoticeRank>();
	for (const item of items) {
		if (item.rank === 'suggestion') continue;
		for (const id of item.stackIds) {
			const known = ranks.get(id);
			if (!known || ATTENTION_ORDER[item.rank] < ATTENTION_ORDER[known]) {
				ranks.set(id, item.rank);
			}
		}
	}
	return ranks;
}

// ---------------------------------------------------------------------------
// Stack rows

type SupabaseRowGroup =
	| 'attention'
	| 'in-flight'
	| 'running-lane'
	| 'running-held'
	| 'running-unheld'
	| 'stopped'
	| 'prune'
	| 'not-created';

const GROUP_ORDER: Readonly<Record<SupabaseRowGroup, number>> = {
	attention: 0,
	'in-flight': 1,
	'running-lane': 2,
	'running-held': 3,
	'running-unheld': 4,
	stopped: 5,
	prune: 6,
	'not-created': 7,
};

type SupabaseRowPart = Readonly<{ text: string; tone: SupabaseTone }>;

/**
 * The row's trailing badge: who holds it, else Pinned, else External.
 */
type SupabaseRowHolder =
	| Readonly<{ kind: 'agent'; label: string; agent: AgentRef }>
	| Readonly<{ kind: 'pinned'; label: string }>
	| Readonly<{ kind: 'origin'; label: string }>;

export type SupabaseStackRow = Readonly<{
	id: string;
	stack: SupabaseStackSummary;
	title: string;
	status: SupabaseStackStatus;
	group: SupabaseRowGroup;
	attention?: NoticeRank;
	transient: boolean;
	/** Line 2: the state, at most two flags, lane and API ports, and size. */
	parts: readonly SupabaseRowPart[];
	line2: string;
	holder?: SupabaseRowHolder;
	ports: readonly number[];
	/** Typeahead: branch, state, ports and holder. */
	textValue: string;
	searchText: string;
}>;

function rowGroup(
	stack: SupabaseStackSummary,
	status: SupabaseStackStatus,
	attention: NoticeRank | undefined
): SupabaseRowGroup {
	if (attention) return 'attention';
	if (stack.origin === 'expected') return 'not-created';
	if (status.tone === 'info') return 'in-flight';
	if (isSupabaseStackRunning(stack)) {
		if (stack.lanes.some((lane) => lane.metro !== 'stopped')) {
			return 'running-lane';
		}
		return stack.pinned ||
			stack.holds.some((hold) => hold.live) ||
			stack.cwdKeepers.length > 0
			? 'running-held'
			: 'running-unheld';
	}
	return stack.pruneGroup !== undefined ||
		stack.flags.includes('prune-suggested')
		? 'prune'
		: 'stopped';
}

function rowParts(
	stack: SupabaseStackSummary,
	status: SupabaseStackStatus,
	job: SupabaseJob | undefined,
	now: number
): SupabaseRowPart[] {
	const parts: SupabaseRowPart[] = [];
	if (status.key === 'lan-exposed') {
		parts.push(
			{ text: status.label, tone: status.tone },
			{
				text: stack.runtime === 'podman' ? 'Podman' : 'Docker',
				tone: 'default',
			},
			{ text: isLive(stack) ? 'running' : 'stopped', tone: 'default' }
		);
	} else {
		let text = status.label;
		if (status.key === 'in-flight' && job) {
			text = `${status.label} ${formatSupabaseElapsed(now - job.startedAt)}`;
		} else if (
			status.key === 'stopped' &&
			stack.pruneGroup === 'retention' &&
			stack.lastUsedAt !== undefined
		) {
			text = `Stopped ${Math.floor((now - stack.lastUsedAt) / 86_400_000)} d`;
		}
		parts.push({ text, tone: status.tone });
		const flags = visibleStackFlags(stack, 2);
		for (const chip of flags.chips) {
			if (chip.label !== status.label) {
				parts.push({ text: chip.label, tone: chip.tone });
			}
		}
		if (flags.more > 0) parts.push({ text: `+${flags.more}`, tone: 'default' });
		if (stack.origin === 'expected') {
			parts.push({ text: `${stack.mode.value} worktree`, tone: 'default' });
		} else if (stack.pruneGroup === 'retention') {
			parts.push({ text: 'prune suggested', tone: 'default' });
		}
	}
	const lane =
		stack.lanes.find((candidate) => candidate.metro !== 'stopped') ??
		stack.lanes[0];
	if (lane) parts.push({ text: `lane :${lane.port}`, tone: 'default' });
	if (isLive(stack) && stack.ports.api !== undefined) {
		parts.push({ text: `API :${stack.ports.api}`, tone: 'default' });
	}
	if (stack.diskBytes !== undefined) {
		parts.push({ text: formatSize(stack.diskBytes), tone: 'default' });
	}
	return parts;
}

function rowHolder(stack: SupabaseStackSummary): SupabaseRowHolder | undefined {
	const agentHold = stack.holds.find(
		(hold) => hold.live && hold.holder !== 'operator' && hold.agent
	);
	if (agentHold && agentHold.holder !== 'operator' && agentHold.agent) {
		return {
			kind: 'agent',
			label: supabaseAgentLabel(agentHold.agent),
			agent: agentHold.agent,
		};
	}
	if (stack.pinned) return { kind: 'pinned', label: 'Pinned' };
	if (stack.origin === 'external') return { kind: 'origin', label: 'External' };
	return undefined;
}

function stackAgents(stack: SupabaseStackSummary): AgentRef[] {
	return [
		...stack.holds.flatMap((hold) =>
			hold.holder !== 'operator' && hold.agent ? [hold.agent] : []
		),
		...stack.cwdKeepers.map((keeper) => keeper.agent),
		...(stack.createdBy.agent ? [stack.createdBy.agent] : []),
	];
}

function stackPorts(stack: SupabaseStackSummary): number[] {
	return [
		...new Set(
			[
				stack.ports.api,
				stack.ports.db,
				stack.ports.mail,
				stack.ports.studio,
				...stack.lanes.map((lane) => lane.port),
			].filter((port): port is number => port !== undefined)
		),
	];
}

function buildRow(
	stack: SupabaseStackSummary,
	state: Pick<SupabaseState, 'jobs'>,
	attention: NoticeRank | undefined,
	now: number
): SupabaseStackRow {
	const status = stackStatus(stack, { jobs: state.jobs });
	const job = supabaseActiveJob(stack, state.jobs);
	const title = supabaseStackTitle(stack);
	const parts = rowParts(stack, status, job, now);
	const holder = rowHolder(stack);
	const ports = stackPorts(stack);
	const agents = stackAgents(stack);
	return {
		id: stack.id,
		stack,
		title,
		status,
		group: rowGroup(stack, status, attention),
		...(attention ? { attention } : {}),
		transient: stack.flags.includes('transient'),
		parts,
		line2: parts.map((part) => part.text).join(' · '),
		...(holder ? { holder } : {}),
		ports,
		textValue: [
			title,
			status.label,
			...ports.map((port) => `:${port}`),
			holder?.label ?? '',
		]
			.filter(Boolean)
			.join(' '),
		searchText: [
			title,
			stack.branchContext ?? '',
			stack.worktreeLabel ?? '',
			stack.projectRootLabel ?? '',
			stack.id,
			status.label,
			...agents.flatMap((agent) => [
				supabaseAgentLabel(agent),
				agent.kind,
				agent.sessionId,
			]),
			...stack.lanes.map((lane) => lane.simulatorLabel ?? ''),
			...ports.map((port) => `:${port}`),
			holder?.label ?? '',
		]
			.join(' ')
			.toLowerCase(),
	};
}

function compareRows(left: SupabaseStackRow, right: SupabaseStackRow): number {
	const group = GROUP_ORDER[left.group] - GROUP_ORDER[right.group];
	if (group !== 0) return group;
	if (left.group === 'attention' && left.attention && right.attention) {
		const rank =
			ATTENTION_ORDER[left.attention] - ATTENTION_ORDER[right.attention];
		if (rank !== 0) return rank;
	}
	if (left.group === 'running-unheld') {
		const soonest =
			(left.stack.autoStopAt ?? Number.MAX_SAFE_INTEGER) -
			(right.stack.autoStopAt ?? Number.MAX_SAFE_INTEGER);
		if (soonest !== 0) return soonest;
	}
	if (left.group === 'stopped' || left.group === 'prune') {
		const recent =
			(right.stack.lastUsedAt ?? -1) - (left.stack.lastUsedAt ?? -1);
		if (recent !== 0) return recent;
	}
	return (
		left.title.localeCompare(right.title) || left.id.localeCompare(right.id)
	);
}

/**
 * Every stack as a list row, ranked: needs attention, in flight, running
 * with a lane, running and held, running unheld (soonest auto-stop first),
 * stopped (most recent first), prune-suggested, not created.
 */
export function buildSupabaseRows(
	state: SupabaseState,
	now: number = state.updatedAt
): readonly SupabaseStackRow[] {
	const attention = supabaseAttentionByStack(attentionItems(state, now));
	return state.stacks
		.map((stack) => buildRow(stack, state, attention.get(stack.id), now))
		.sort(compareRows);
}

/**
 * Search terms all have to match: `:81` matches a port by prefix, anything
 * else the branch, worktree, id, state, agent or Simulator.
 */
export function matchesSupabaseSearch(
	row: Pick<SupabaseStackRow, 'ports' | 'searchText'>,
	query: string
): boolean {
	const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	return terms.every((term) => {
		const port = /^:(\d{1,5})$/.exec(term)?.[1];
		if (port !== undefined) {
			return row.ports.some((value) => String(value).startsWith(port));
		}
		return row.searchText.includes(term);
	});
}

export type SupabaseStackFilter =
	| 'all'
	| 'running'
	| 'stopped'
	| 'not-created'
	| 'held'
	| 'unused'
	| 'attention'
	| 'external'
	| 'transient';

export const SUPABASE_STACK_FILTERS: readonly Readonly<{
	id: SupabaseStackFilter;
	label: string;
}>[] = [
	{ id: 'all', label: 'All stacks' },
	{ id: 'running', label: 'Running' },
	{ id: 'stopped', label: 'Stopped' },
	{ id: 'not-created', label: 'Not created' },
	{ id: 'held', label: 'Held by agents' },
	{ id: 'unused', label: 'Unused' },
	{ id: 'attention', label: 'Needs attention' },
	{ id: 'external', label: 'External' },
	{ id: 'transient', label: 'Transient' },
];

/** Shadow-database stacks show only under the Transient filter. */
export function supabaseRowMatchesFilter(
	row: SupabaseStackRow,
	filter: SupabaseStackFilter
): boolean {
	if (filter === 'transient') return row.transient;
	if (row.transient) return false;
	const { stack } = row;
	switch (filter) {
		case 'all':
			return true;
		case 'running':
			return isSupabaseStackRunning(stack) || stack.state === 'starting';
		case 'stopped':
			return STOPPED_STATES.has(stack.state);
		case 'not-created':
			return stack.origin === 'expected';
		case 'held':
			return (
				stack.holds.some(
					(hold) => hold.holder !== 'operator' && hold.agent !== undefined
				) || stack.cwdKeepers.length > 0
			);
		case 'unused':
			return (
				stack.origin !== 'expected' &&
				!stack.pinned &&
				stack.holds.length === 0 &&
				stack.lanes.length === 0 &&
				stack.cwdKeepers.length === 0
			);
		case 'attention':
			return row.attention !== undefined;
		case 'external':
			return stack.origin === 'external';
	}
}

/** The filter select's options, each with its count: `All stacks (10)`. */
export function supabaseFilterOptions(
	rows: readonly SupabaseStackRow[]
): readonly Readonly<{
	id: SupabaseStackFilter;
	label: string;
	count: number;
}>[] {
	return SUPABASE_STACK_FILTERS.map((filter) => ({
		...filter,
		count: rows.filter((row) => supabaseRowMatchesFilter(row, filter.id))
			.length,
	}));
}

export function supabaseVisibleRows(
	rows: readonly SupabaseStackRow[],
	options: Readonly<{ filter: SupabaseStackFilter; query: string }>
): readonly SupabaseStackRow[] {
	return rows.filter(
		(row) =>
			supabaseRowMatchesFilter(row, options.filter) &&
			matchesSupabaseSearch(row, options.query)
	);
}

/** Keeps the selection while its row is listed, else the first row. */
export function resolveSupabaseSelection(
	rows: readonly Readonly<{ id: string }>[],
	selectedId: string | null
): string | null {
	if (selectedId !== null && rows.some((row) => row.id === selectedId)) {
		return selectedId;
	}
	return rows[0]?.id ?? null;
}

/**
 * Where selection goes after the selected row disappears, e.g. after a
 * destroy: the next row that is still listed, else the previous one.
 */
export function supabaseSelectionAfterRemoval(
	previous: readonly Readonly<{ id: string }>[],
	selectedId: string | null,
	current: readonly Readonly<{ id: string }>[]
): string | null {
	const listed = new Set(current.map((row) => row.id));
	if (selectedId !== null && listed.has(selectedId)) return selectedId;
	const index = previous.findIndex((row) => row.id === selectedId);
	if (index >= 0) {
		const after = previous.slice(index + 1).find((row) => listed.has(row.id));
		if (after) return after.id;
		const before = previous
			.slice(0, index)
			.reverse()
			.find((row) => listed.has(row.id));
		if (before) return before.id;
	}
	return current[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Detail: heading, sections and the action row

/** The detail heading: eyebrow, branch, worktree and id, and the origin word. */
export function supabaseStackHeading(stack: SupabaseStackSummary): Readonly<{
	eyebrow: string;
	title: string;
	subtitle: string;
	origin: string;
}> {
	return {
		eyebrow: 'Supabase stack',
		title: supabaseStackTitle(stack),
		subtitle: [stack.worktreeLabel, shortSupabaseId(stack.id)]
			.filter((part): part is string => Boolean(part))
			.join(' · '),
		origin:
			stack.origin === 'expected'
				? 'Not created'
				: stack.origin === 'external'
					? 'External'
					: stack.origin === 'adopted'
						? 'Adopted'
						: stack.mode.value === 'observed'
							? 'Observed'
							: 'Managed',
	};
}

/**
 * Overview opens by default, Services and Connect while the stack runs;
 * Database, Logs and the Danger zone wait to be opened.
 */
export function defaultSupabaseSectionOpen(
	stack: Pick<SupabaseStackSummary, 'state'>,
	section: SupabaseDetailSection
): boolean {
	switch (section) {
		case 'overview':
			return true;
		case 'services':
		case 'connect':
			return isSupabaseStackRunning(stack);
		default:
			return false;
	}
}

/** The open sections of a stack's detail, the person's choices first. */
export function supabaseOpenSections(
	stack: Pick<SupabaseStackSummary, 'state'>,
	overrides: Readonly<Partial<Record<SupabaseDetailSection, boolean>>> = {}
): readonly SupabaseDetailSection[] {
	return SUPABASE_DETAIL_SECTIONS.filter(
		(section) =>
			overrides[section] ?? defaultSupabaseSectionOpen(stack, section)
	);
}

/** How a control confirms: a main-owned dialog, an inline prompt, or not at all. */
export function supabaseConfirmationKind(
	input: SupabaseOperationInput,
	state: Pick<SupabaseState, 'stacks' | 'requests' | 'policy' | 'jobs'>
): Readonly<
	| { kind: 'native' }
	| { kind: 'inline'; agents: readonly string[] }
	| { kind: 'none' }
> {
	const operation = { ...input, actionId: 'preview' } as SupabaseOperation;
	if (supabaseConfirmationRequired(operation, state)) return { kind: 'native' };
	const inline = supabaseInlineConfirmation(operation, state);
	return inline.required
		? { kind: 'inline', agents: inline.agents }
		: { kind: 'none' };
}

type SupabaseDetailActionId =
	| 'start'
	| 'try-again'
	| 'resume'
	| 'stop'
	| 'stop-external'
	| 'restart'
	| 'pin'
	| 'unpin'
	| 'adopt'
	| 'cancel-start'
	| 'open-lane'
	| 'open-logs';

export type SupabaseDetailAction = Readonly<{
	id: SupabaseDetailActionId;
	label: string;
	availability: SupabaseAvailability;
	/** What to run; navigation actions have none. */
	operation?: SupabaseOperationInput;
	confirmation: ReturnType<typeof supabaseConfirmationKind>;
}>;

const ACTION_STACK_ACTIONS: Readonly<
	Partial<Record<SupabaseDetailActionId, SupabaseStackAction>>
> = {
	start: 'start',
	'try-again': 'start',
	resume: 'resume',
	stop: 'stop',
	'stop-external': 'stop',
	restart: 'restart',
	pin: 'pin',
	unpin: 'unpin',
	adopt: 'adopt',
	'cancel-start': 'cancel-start',
	'open-logs': 'read-logs',
};

function detailOperation(
	id: SupabaseDetailActionId,
	stack: SupabaseStackSummary,
	job: SupabaseJob | undefined
): SupabaseOperationInput | undefined {
	switch (id) {
		case 'start':
		case 'try-again':
		case 'resume':
			return { kind: 'start', stackId: stack.id };
		case 'stop':
		case 'stop-external':
			return { kind: 'stop', stackIds: [stack.id] };
		case 'restart':
			return { kind: 'restart', stackId: stack.id };
		case 'pin':
			return { kind: 'pin', stackId: stack.id };
		case 'unpin':
			return { kind: 'unpin', stackId: stack.id };
		case 'adopt':
			return { kind: 'adopt', stackId: stack.id };
		case 'cancel-start':
			return job ? { kind: 'cancel-job', jobId: job.id } : undefined;
		default:
			return undefined;
	}
}

function startLabel(
	base: string,
	state: Pick<SupabaseState, 'capacity' | 'stacks'>,
	now: number
): string {
	const { capacity } = state;
	if (capacity.running < capacity.cap || capacity.nextToStopId === undefined) {
		return base;
	}
	const next = state.stacks.find((stack) => stack.id === capacity.nextToStopId);
	if (!next) return base;
	const idle =
		next.lastUsedAt === undefined
			? ''
			: `, idle ${formatSupabaseElapsed(now - next.lastUsedAt)}`;
	return `${base} (stops ${supabaseStackTitle(next)}${idle})`;
}

/**
 * The detail's state-dependent action row, at most four buttons, each with
 * its availability (the visible disabled reason) and how it confirms.
 */
export function supabaseDetailActions(
	stack: SupabaseStackSummary,
	state: SupabaseState,
	context: Readonly<{
		bridgeAvailable: boolean;
		pending?: boolean;
		now: number;
	}>
): readonly SupabaseDetailAction[] {
	const job = supabaseActiveJob(stack, state.jobs);
	const ids: SupabaseDetailActionId[] = [];
	if (job && START_JOB_KINDS.has(job.kind)) {
		ids.push('cancel-start');
	} else if (stack.origin === 'external') {
		if (stack.runtime === 'native') ids.push('adopt');
		if (
			isLive(stack) ||
			stack.ownerLiveness === 'reachable' ||
			stack.ownerLiveness === 'not-responding'
		) {
			ids.push('stop-external');
		}
	} else if (stack.state === 'not-created' || stack.state === 'never-started') {
		ids.push('start');
	} else if (stack.state === 'failed') {
		ids.push('try-again', 'open-logs');
	} else if (isLive(stack)) {
		ids.push('stop', 'restart', stack.pinned ? 'unpin' : 'pin');
	} else if (stack.state !== 'unreadable') {
		ids.push('resume');
	}
	if (stack.lanes.length > 0 && ids.length < 4) ids.push('open-lane');
	const availabilityContext = {
		bridgeAvailable: context.bridgeAvailable,
		state,
		now: context.now,
		...(context.pending === undefined ? {} : { pending: context.pending }),
	};
	return ids.slice(0, 4).map((id) => {
		const action = ACTION_STACK_ACTIONS[id];
		const operation = detailOperation(id, stack, job);
		const label = {
			start: startLabel('Start', state, context.now),
			'try-again': startLabel('Try again', state, context.now),
			resume: startLabel('Resume', state, context.now),
			stop: 'Stop',
			'stop-external': 'Stop…',
			restart: 'Restart services',
			pin: 'Keep running',
			unpin: 'Unpin',
			adopt: 'Adopt',
			'cancel-start': 'Cancel start…',
			'open-lane': 'Open lane',
			'open-logs': 'Open logs',
		}[id];
		return {
			id,
			label,
			availability: action
				? supabaseActionAvailability(stack, action, availabilityContext)
				: { allowed: true },
			...(operation ? { operation } : {}),
			confirmation: operation
				? supabaseConfirmationKind(operation, state)
				: { kind: 'none' },
		};
	});
}

// ---------------------------------------------------------------------------
// Bulk selection

export type SupabaseBulkAction = Readonly<{
	stackIds: readonly string[];
	label: string;
	availability: SupabaseAvailability;
}>;

/**
 * What Stop N and Destroy N… would act on for a batch selection: eligible
 * stacks only, with the summary of what each skips.
 */
export function supabaseBulkEligibility(
	state: SupabaseState,
	selectedIds: readonly string[],
	context: Readonly<{ bridgeAvailable: boolean; now: number }>
): Readonly<{
	stop: SupabaseBulkAction;
	destroy: SupabaseBulkAction;
	summary: string;
}> {
	const stacks = selectedIds.flatMap((id) => {
		const stack = state.stacks.find((candidate) => candidate.id === id);
		return stack ? [stack] : [];
	});
	const availabilityContext = {
		bridgeAvailable: context.bridgeAvailable,
		state,
		now: context.now,
	};
	const refusal = (reason: string): SupabaseAvailability => ({
		allowed: false,
		reason,
		check: 'state',
	});
	const stopChecks = stacks.map((stack) => ({
		stack,
		availability: supabaseActionAvailability(
			stack,
			'stop',
			availabilityContext
		),
	}));
	const stoppable = stopChecks.filter(
		(check) => check.availability.allowed && check.stack.origin !== 'external'
	);
	const firstStopRefusal = stopChecks.find(
		(check) =>
			!check.availability.allowed &&
			(check.availability.check === 'bridge' ||
				check.availability.check === 'off' ||
				check.availability.check === 'platform')
	)?.availability;
	const stop: SupabaseBulkAction = {
		stackIds: stoppable.map((check) => check.stack.id),
		label: `Stop ${stoppable.length}`,
		availability:
			firstStopRefusal ??
			(stoppable.length > 0
				? { allowed: true }
				: stopChecks.some(
							(check) =>
								check.availability.allowed && check.stack.origin === 'external'
						)
					? refusal(
							'External stacks are stopped one at a time from their detail.'
						)
					: refusal('None of the selected stacks is running.')),
	};
	const destroyChecks = stacks.map((stack) => ({
		stack,
		availability: supabaseActionAvailability(
			stack,
			'destroy',
			availabilityContext
		),
	}));
	const destroyable = destroyChecks.filter(
		(check) => check.availability.allowed
	);
	const running = stacks.filter(isLive).length;
	const destroy: SupabaseBulkAction = {
		stackIds: destroyable.map((check) => check.stack.id),
		label: `Destroy ${destroyable.length}…`,
		availability:
			destroyable.length > 0
				? { allowed: true }
				: running > 0 && running === stacks.length
					? refusal(
							`Destroy runs only on stopped stacks; ${running} selected ${running === 1 ? 'is' : 'are'} running.`
						)
					: (destroyChecks.find((check) => !check.availability.allowed)
							?.availability ?? refusal('Select at least one stack.')),
	};
	const stopSkips = stacks.length - stoppable.length;
	const destroySkips = stacks.length - destroyable.length;
	const stoppedSkips = stopChecks.filter(
		(check) => !check.availability.allowed && !isLive(check.stack)
	).length;
	return {
		stop,
		destroy,
		summary: [
			`${stacks.length} selected`,
			stopSkips > 0
				? `Stop skips ${stopSkips}${stoppedSkips === stopSkips ? ' stopped' : ''}`
				: '',
			destroySkips > 0
				? `Destroy skips ${destroySkips}${running === destroySkips ? ' running' : ''}`
				: '',
		]
			.filter(Boolean)
			.join(' · '),
	};
}

// ---------------------------------------------------------------------------
// Who holds this, and created by

export type SupabaseOpenTarget =
	| Readonly<{ kind: 'agents'; agent: AgentRef }>
	| Readonly<{ kind: 'lane'; laneId: string }>
	| Readonly<{ kind: 'simulator'; udid: string }>;

export type SupabaseChainLink = Readonly<{
	kind: 'agent' | 'operator' | 'lane' | 'simulator' | 'worktree' | 'stack';
	label: string;
	tone: 'success' | 'warning' | 'muted' | 'danger' | 'default';
	agent?: AgentRef;
	/** The Open-in button: visible text, accessible name and target. */
	open?: Readonly<{ text: string; label: string; target: SupabaseOpenTarget }>;
}>;

export type SupabaseOtherHolder = Readonly<{
	key: string;
	label: string;
	live: boolean;
	agent?: AgentRef;
	/** Set for session and worktree holds, which Release may end. */
	release?: SupabaseHoldRef;
}>;

function holdKey(hold: SupabaseHold, index: number): string {
	return hold.holder === 'operator'
		? 'operator'
		: hold.holder === 'lane'
			? `lane:${hold.laneId}`
			: `${hold.holder}:${hold.agent.kind}:${hold.agent.sessionId}:${index}`;
}

const dayTime = new Intl.DateTimeFormat(undefined, {
	hour: '2-digit',
	minute: '2-digit',
	hour12: false,
});
const dateTime = new Intl.DateTimeFormat(undefined, {
	month: 'short',
	day: 'numeric',
	hour: '2-digit',
	minute: '2-digit',
	hour12: false,
});

/** `today 12:02`, `yesterday 09:15`, or `Oct 15, 14:02`. */
export function formatSupabaseMoment(timestamp: number, now: number): string {
	const day = new Date(timestamp);
	const today = new Date(now);
	const sameDay = (left: Date, right: Date) =>
		left.getFullYear() === right.getFullYear() &&
		left.getMonth() === right.getMonth() &&
		left.getDate() === right.getDate();
	if (sameDay(day, today)) return `today ${dayTime.format(timestamp)}`;
	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	if (sameDay(day, yesterday)) return `yesterday ${dayTime.format(timestamp)}`;
	return dateTime.format(timestamp);
}

/** `lane up · Claude 9b1e2c00 · today 12:02`, `You (Supabase tab)`, `Outside RN Devtools`. */
export function supabaseCreatedByText(
	stack: Pick<SupabaseStackSummary, 'createdBy'>,
	now: number
): string {
	const { createdBy } = stack;
	const when =
		createdBy.at === undefined ? '' : formatSupabaseMoment(createdBy.at, now);
	const agent = createdBy.agent ? supabaseAgentLabel(createdBy.agent) : '';
	switch (createdBy.via) {
		case 'lane-up':
			return ['lane up', agent, when].filter(Boolean).join(' · ');
		case 'agent-up':
			return ['supabase up', agent, when].filter(Boolean).join(' · ');
		case 'operator':
			return ['You (Supabase tab)', when].filter(Boolean).join(' · ');
		case 'pre-download':
			return ['Pre-download services', when].filter(Boolean).join(' · ');
		case 'outside':
			return 'Outside RN Devtools';
		case 'unknown':
			return 'Unknown';
	}
}

/**
 * The "Who holds this" chain, Agent › Lane › Simulator › Worktree › Stack,
 * built from the primary hold; every other hold is listed as "Also held by".
 * Liveness reads the same as Simulator holds (holdCountdownLabel).
 */
export function supabaseHolderChain(
	stack: SupabaseStackSummary,
	now: number,
	options: Readonly<{ clocksPaused?: boolean }> = {}
): Readonly<{
	links: readonly SupabaseChainLink[];
	others: readonly SupabaseOtherHolder[];
}> {
	const countdown = (hold: SupabaseHold) =>
		holdCountdownLabel(
			{
				live: hold.live,
				releaseAt: hold.releaseAt,
				holder: hold.holder,
				synthetic: hold.holder !== 'operator' && hold.agent?.synthetic === true,
			},
			now,
			{
				verb: 'stops',
				...(options.clocksPaused === undefined
					? {}
					: { clocksPaused: options.clocksPaused }),
			}
		);
	const laneHold =
		stack.holds.find((hold) => hold.holder === 'lane' && hold.live) ??
		stack.holds.find((hold) => hold.holder === 'lane');
	const lane =
		laneHold?.holder === 'lane'
			? stack.lanes.find((candidate) => candidate.laneId === laneHold.laneId)
			: stack.lanes[0];
	const agentHold =
		laneHold?.holder === 'lane' && laneHold.agent
			? laneHold
			: (stack.holds.find(
					(hold) =>
						(hold.holder === 'session' || hold.holder === 'worktree') &&
						hold.live
				) ??
				stack.holds.find(
					(hold) => hold.holder === 'session' || hold.holder === 'worktree'
				));
	const operatorHold = stack.holds.find((hold) => hold.holder === 'operator');
	const links: SupabaseChainLink[] = [];
	const primary = new Set<SupabaseHold>();
	if (agentHold && agentHold.holder !== 'operator' && agentHold.agent) {
		primary.add(agentHold);
		const label = countdown(agentHold);
		const via =
			agentHold.holder === 'lane' && lane
				? ` · via lane :${lane.port}`
				: agentHold.holder === 'session'
					? ' · supabase up'
					: '';
		const agentName = supabaseAgentLabel(agentHold.agent);
		links.push({
			kind: 'agent',
			label: `${agentName}${label.text === 'by worktree' && agentName.endsWith('by worktree') ? '' : ` · ${label.text}`}${via}`,
			tone: agentHold.live ? 'success' : 'warning',
			agent: agentHold.agent,
			open: {
				text: 'Open in Agents',
				label: `Open ${agentName} in Agents`,
				target: { kind: 'agents', agent: agentHold.agent },
			},
		});
	} else if (stack.pinned || operatorHold) {
		if (operatorHold) primary.add(operatorHold);
		links.push({
			kind: 'operator',
			label: stack.pinned
				? 'You · pinned · never stopped automatically'
				: 'You · started from the Supabase tab',
			tone: 'default',
		});
	} else if (laneHold?.holder === 'lane' && lane) {
		links.push({
			kind: 'operator',
			label: `You · lane :${lane.port}`,
			tone: 'default',
		});
	}
	if (laneHold) primary.add(laneHold);
	const title = supabaseStackTitle(stack);
	if (lane) {
		links.push({
			kind: 'lane',
			label: `Lane :${lane.port} · Metro ${lane.metro}`,
			tone:
				lane.metro === 'ready'
					? 'success'
					: lane.metro === 'stopped'
						? 'muted'
						: 'default',
			open: {
				text: 'Open lane',
				label: `Open lane ${title} :${lane.port} in Lanes`,
				target: { kind: 'lane', laneId: lane.laneId },
			},
		});
		const simulator =
			lane.simulatorLabel ?? shortSupabaseId(lane.simulatorUdid);
		links.push({
			kind: 'simulator',
			label: simulator,
			tone: 'default',
			open: {
				text: 'Open in Simulators',
				label: `Open ${simulator} in Simulators`,
				target: { kind: 'simulator', udid: lane.simulatorUdid },
			},
		});
	}
	const head = !stack.worktreeExists
		? 'worktree deleted'
		: stack.currentHead === undefined
			? ''
			: supabaseHeadMatches(stack)
				? 'HEAD matches'
				: `HEAD on ${supabaseBranchLabel(stack.currentHead.ref) ?? 'another branch'}`;
	links.push({
		kind: 'worktree',
		label: [title, stack.worktreeLabel, head]
			.filter((part): part is string => Boolean(part))
			.join(' · '),
		tone: !stack.worktreeExists
			? 'danger'
			: supabaseHeadMatches(stack)
				? 'default'
				: 'warning',
	});
	links.push({
		kind: 'stack',
		label:
			stack.ports.api === undefined
				? 'This stack'
				: `This stack · API :${stack.ports.api}`,
		tone: isSupabaseStackRunning(stack) ? 'success' : 'muted',
	});
	const others = stack.holds.flatMap((hold, index): SupabaseOtherHolder[] => {
		if (primary.has(hold) || hold.holder === 'operator') return [];
		const name =
			hold.holder === 'lane'
				? hold.agent
					? supabaseAgentLabel(hold.agent)
					: `Lane ${hold.laneId.slice(5, 13)}`
				: supabaseAgentLabel(hold.agent);
		const liveness = hold.live
			? countdown(hold).text
			: `gone ${formatSupabaseElapsed(now - (hold.abandonedSince ?? now))}`;
		const ends =
			!hold.live && hold.releaseAt !== undefined
				? ` · hold ends ${dayTime.format(hold.releaseAt)}`
				: '';
		return [
			{
				key: holdKey(hold, index),
				label: `${name} · ${liveness}${ends}`,
				live: hold.live,
				...(hold.agent ? { agent: hold.agent } : {}),
				...(hold.holder === 'session' || hold.holder === 'worktree'
					? {
							release: {
								holder: hold.holder,
								agentKind: hold.agent.kind,
								sessionId: hold.agent.sessionId,
							},
						}
					: {}),
			},
		];
	});
	return { links, others };
}

// ---------------------------------------------------------------------------
// Cross-panel joins

/** The stack a lane is attached to, for the Lanes and Fleet chips. */
export function supabaseStackForLane(
	state: Pick<SupabaseState, 'stacks'>,
	laneId: string
): SupabaseStackSummary | undefined {
	return state.stacks.find((stack) =>
		stack.lanes.some((lane) => lane.laneId === laneId)
	);
}

export type SupabaseSessionBackend = Readonly<{
	stack: SupabaseStackSummary;
	via: 'lane' | 'session' | 'worktree' | 'cwd';
	live: boolean;
	release?: SupabaseHoldRef;
}>;

/** The stacks an agent session holds, and how, for the Agents view. */
export function supabaseBackendsForSession(
	state: Pick<SupabaseState, 'stacks'>,
	agent: Readonly<{ kind: AgentRef['kind']; sessionId: string }>
): readonly SupabaseSessionBackend[] {
	const matches = (candidate: AgentRef | undefined) =>
		candidate?.kind === agent.kind && candidate.sessionId === agent.sessionId;
	return state.stacks.flatMap((stack): SupabaseSessionBackend[] => {
		const hold = stack.holds.find(
			(candidate) => candidate.holder !== 'operator' && matches(candidate.agent)
		);
		if (hold && hold.holder !== 'operator') {
			return [
				{
					stack,
					via: hold.holder,
					live: hold.live,
					...(hold.holder === 'session' || hold.holder === 'worktree'
						? {
								release: {
									holder: hold.holder,
									agentKind: hold.agent.kind,
									sessionId: hold.agent.sessionId,
								},
							}
						: {}),
				},
			];
		}
		return stack.cwdKeepers.some((keeper) => matches(keeper.agent))
			? [{ stack, via: 'cwd', live: true }]
			: [];
	});
}

// ---------------------------------------------------------------------------
// Repositories

export type SupabaseRepositoryRow = Readonly<{
	id: string;
	repository: SupabaseRepositorySummary;
	title: string;
	readiness: Readonly<{
		label: string;
		tone: 'success' | 'warning' | 'default';
	}>;
	line2: string;
	fixes: number;
	searchText: string;
}>;

/**
 * Display names for the repository checks.
 */
export const SUPABASE_CHECK_LABELS: Readonly<
	Record<SupabaseRepositorySummary['checks'][number]['id'], string>
> = {
	platform: 'Platform',
	project: 'Supabase project',
	'stack-flag': 'Stack flag',
	'config-json': 'config.json',
	'pinned-ports': 'Pinned ports',
	cli: 'Supabase CLI',
	'app-env-files': 'App env files',
	recommended: 'Recommended',
};

function repositoryReadiness(
	repository: SupabaseRepositorySummary
): SupabaseRepositoryRow['readiness'] {
	switch (repository.readiness) {
		case 'ready':
			return { label: 'Ready', tone: 'success' };
		case 'needs-fix': {
			const fixes = Math.max(
				1,
				repository.checks.filter((check) => check.status === 'needs-fix').length
			);
			return { label: plural(fixes, 'fix', 'fixes'), tone: 'warning' };
		}
		case 'observed':
			return { label: 'Observed', tone: 'default' };
		case 'no-supabase':
			return { label: 'No Supabase', tone: 'default' };
		case 'off':
			return { label: 'Off', tone: 'default' };
		case 'checking':
			return { label: 'Checking…', tone: 'default' };
	}
}

/** Tracked repositories as list rows, each with its readiness word. */
export function buildSupabaseRepositoryRows(
	state: Pick<SupabaseState, 'repositories'>
): readonly SupabaseRepositoryRow[] {
	return state.repositories.map((repository) => {
		const { counts, cli } = repository;
		const line2 =
			repository.readiness === 'observed' &&
			cli.version !== undefined &&
			cli.gate !== undefined &&
			cli.gate !== 'verified'
				? `CLI ${cli.version} not verified`
				: repository.readiness === 'no-supabase'
					? 'No supabase/config.toml'
					: [
							plural(counts.worktrees, 'worktree'),
							`${counts.managed} managed`,
							counts.running > 0 ? `${counts.running} running` : '',
						]
							.filter(Boolean)
							.join(' · ');
		return {
			id: repository.id,
			repository,
			title: repository.label,
			readiness: repositoryReadiness(repository),
			line2,
			fixes: repository.checks.filter((check) => check.status === 'needs-fix')
				.length,
			searchText: [
				repository.label,
				repository.appPathLabel ?? '',
				...repository.worktrees.flatMap((worktree) => [
					worktree.pathLabel,
					worktree.branch,
				]),
			]
				.join(' ')
				.toLowerCase(),
		};
	});
}

export type SupabaseRepositoryFilter =
	| 'all'
	| 'needs-fix'
	| 'ready'
	| 'observed'
	| 'no-supabase';

const SUPABASE_REPOSITORY_FILTERS: readonly Readonly<{
	id: SupabaseRepositoryFilter;
	label: string;
}>[] = [
	{ id: 'all', label: 'All repositories' },
	{ id: 'needs-fix', label: 'Needs fix' },
	{ id: 'ready', label: 'Ready' },
	{ id: 'observed', label: 'Observed' },
	{ id: 'no-supabase', label: 'No Supabase' },
];

function repositoryMatchesFilter(
	row: SupabaseRepositoryRow,
	filter: SupabaseRepositoryFilter
): boolean {
	return filter === 'all' || row.repository.readiness === filter;
}

export function supabaseRepositoryFilterOptions(
	rows: readonly SupabaseRepositoryRow[]
): readonly Readonly<{
	id: SupabaseRepositoryFilter;
	label: string;
	count: number;
}>[] {
	return SUPABASE_REPOSITORY_FILTERS.map((filter) => ({
		...filter,
		count: rows.filter((row) => repositoryMatchesFilter(row, filter.id)).length,
	}));
}

export function supabaseVisibleRepositoryRows(
	rows: readonly SupabaseRepositoryRow[],
	options: Readonly<{ filter: SupabaseRepositoryFilter; query: string }>
): readonly SupabaseRepositoryRow[] {
	const terms = options.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	return rows.filter(
		(row) =>
			repositoryMatchesFilter(row, options.filter) &&
			terms.every((term) => row.searchText.includes(term))
	);
}

/** A repository's worktrees, each linked to its stack when there is one. */
export function supabaseRepositoryWorktrees(
	repository: SupabaseRepositorySummary,
	state: Pick<SupabaseState, 'stacks' | 'jobs'>
): readonly Readonly<{
	pathLabel: string;
	branch: string;
	mode: SupabaseRepositorySummary['worktrees'][number]['mode'];
	text: string;
	stackId?: string;
}>[] {
	return repository.worktrees.map((worktree) => {
		const stack =
			worktree.stackId === undefined
				? undefined
				: state.stacks.find((candidate) => candidate.id === worktree.stackId);
		let stackText = '';
		if (stack) {
			const label = stackStatus(stack, {
				jobs: state.jobs,
			}).label.toLowerCase();
			stackText =
				isLive(stack) && stack.ports.api !== undefined
					? `${label} :${stack.ports.api}`
					: label;
		}
		const facts = [worktree.mode, worktree.reasonText ?? '', stackText].filter(
			Boolean
		);
		return {
			pathLabel: worktree.pathLabel,
			branch: worktree.branch,
			mode: worktree.mode,
			text: `${worktree.branch} · ${facts.join(' · ')}`,
			...(stack ? { stackId: stack.id } : {}),
		};
	});
}

// ---------------------------------------------------------------------------
// Agent requests

export type SupabaseRequestCard = Readonly<{
	id: string;
	request: SupabaseAgentRequest;
	tone: 'warning' | 'danger';
	title: string;
	age: string;
	facts: string;
	/** The agent's sanitized note; shown on the card only, never in a dialog. */
	note?: string;
	/** While the request settles, e.g. `Destroying feat-old-ui…`. */
	progress?: string;
	error?: SupabaseErrorView;
	stack?: SupabaseStackSummary;
	approve: Readonly<{ label: string; availability: SupabaseAvailability }>;
	deny: Readonly<{ label: string; availability: SupabaseAvailability }>;
	/** Start-capacity requests: what could be stopped to make room. */
	candidates: readonly Readonly<{
		stackId: string;
		label: string;
		liveHolder: boolean;
	}>[];
}>;

/** `Codex session 3c9e7a12`, or `Codex · by worktree` for a shared MCP identity. */
export function supabaseRequesterName(
	requester: Pick<
		SupabaseAgentRequest['requester'],
		'kind' | 'sessionId' | 'synthetic'
	>
): string {
	const kind =
		requester.kind === 'claude'
			? 'Claude'
			: requester.kind === 'codex'
				? 'Codex'
				: 'Agent';
	return requester.synthetic || requester.sessionId.startsWith('mcp-')
		? `${kind} · by worktree`
		: `${kind} session ${requester.sessionId.slice(0, 8)}`;
}

function holderName(
	holder: SupabaseAgentRequest['otherHolders'][number]
): string {
	if (holder.holder === 'operator') return 'you';
	const name = holder.agent ? supabaseAgentLabel(holder.agent) : 'a lane';
	return `${name} (${holder.live ? 'live' : 'gone'})`;
}

/**
 * The Requests view's cards: pending, settling and failed agent requests,
 * with the facts main derived, the agent's note, and each button's
 * availability. `stopStackIds` holds the stack chosen per capacity request.
 */
export function buildSupabaseRequestCards(
	state: SupabaseState,
	now: number,
	context: Readonly<{
		bridgeAvailable: boolean;
		stopStackIds?: Readonly<Record<string, string>>;
	}>
): readonly SupabaseRequestCard[] {
	return state.requests
		.filter(
			(request) =>
				request.status === 'failed' ||
				((request.status === 'pending' || request.status === 'settling') &&
					request.expiresAt > now)
		)
		.sort((left, right) => left.createdAt - right.createdAt)
		.map((request) => {
			const stack =
				request.stackId === undefined
					? undefined
					: state.stacks.find((candidate) => candidate.id === request.stackId);
			const who = `${supabaseRequesterName(request.requester)} (${request.requester.live ? 'live' : 'gone'})`;
			const size =
				request.sizeBytes === undefined
					? ''
					: ` (${formatSize(request.sizeBytes)})`;
			const title =
				request.kind === 'destroy'
					? `${who} asks to destroy ${request.branch}${size}`
					: request.kind === 'reset'
						? `${who} asks to reset ${request.branch}'s database${request.seed === false ? ' without seed' : ''}`
						: request.capacity
							? `${who} needs a database for ${request.branch}; ${request.capacity.running} of ${request.capacity.cap} run, all in use`
							: `${who} needs a database for ${request.branch}; every slot is in use`;
			const facts =
				request.kind === 'start-capacity'
					? request.branchMovedTo === undefined
						? 'Stop one running stack to make room.'
						: `The worktree moved to ${request.branchMovedTo} since the request.`
					: `${[
							stack
								? stackStatus(stack, { jobs: state.jobs }).label
								: 'Not listed',
							request.laneAttached
								? `lane :${request.laneAttached.port} ${request.laneAttached.running ? 'running' : 'stopped'}${request.laneAttached.ownedByRequester ? ' (theirs)' : ''}`
								: 'no lane attached',
							request.otherHolders.length === 0
								? 'nothing else holds it'
								: `also held by ${request.otherHolders.map(holderName).join(', ')}`,
						].join(' · ')}.`;
			const stopStackId = context.stopStackIds?.[request.id];
			const availabilityContext = {
				bridgeAvailable: context.bridgeAvailable,
				state,
				...(stopStackId === undefined ? {} : { stopStackId }),
			};
			const chosen =
				stopStackId === undefined
					? undefined
					: request.capacity?.candidates.find(
							(candidate) => candidate.stackId === stopStackId
						);
			return {
				id: request.id,
				request,
				tone: request.status === 'failed' ? 'danger' : 'warning',
				title,
				age: formatAgo(request.createdAt, now),
				facts,
				...(request.note === undefined ? {} : { note: request.note }),
				...(request.status === 'settling'
					? {
							progress:
								request.kind === 'destroy'
									? `Destroying ${request.branch}…`
									: request.kind === 'reset'
										? `Resetting ${request.branch}…`
										: `Starting ${request.branch}…`,
						}
					: {}),
				...(request.error ? { error: request.error } : {}),
				...(stack ? { stack } : {}),
				approve: {
					label:
						request.kind === 'destroy'
							? 'Review and destroy…'
							: request.kind === 'reset'
								? 'Review and reset…'
								: chosen
									? `Stop ${chosen.branch} and start ${request.branch}`
									: `Stop one and start ${request.branch}`,
					availability: supabaseRequestActionAvailability(
						request,
						'approve',
						availabilityContext
					),
				},
				deny: {
					label: request.kind === 'start-capacity' ? 'Dismiss' : 'Deny',
					availability: supabaseRequestActionAvailability(
						request,
						'deny',
						availabilityContext
					),
				},
				candidates: (request.capacity?.candidates ?? []).map((candidate) => ({
					stackId: candidate.stackId,
					label: [
						candidate.branch,
						candidate.holderLabel ?? (candidate.liveHolder ? 'held' : 'unheld'),
						candidate.idleSinceAt === undefined
							? ''
							: `idle ${formatSupabaseElapsed(now - candidate.idleSinceAt)}`,
					]
						.filter(Boolean)
						.join(' · '),
					liveHolder: candidate.liveHolder,
				})),
			};
		});
}

// ---------------------------------------------------------------------------
// Clean up

type SupabasePruneGroupId = SupabasePruneSummary['groups'][number]['id'];

/**
 * A clean-up selection is only valid for the prune revision it was made on.
 */
export type SupabasePruneSelection = Readonly<{
	revision: number;
	stackIds: readonly string[];
}>;

function selectableIds(prune: SupabasePruneSummary): Set<string> {
	return new Set(
		prune.groups
			.filter((group) => group.selectable)
			.flatMap((group) => group.stackIds)
	);
}

/** The groups main preselects (worktree deleted, failed to start), selectable only. */
export function defaultSupabasePruneSelection(
	prune: SupabasePruneSummary
): SupabasePruneSelection {
	return {
		revision: prune.revision,
		stackIds: prune.groups
			.filter((group) => group.selectable && group.preselected)
			.flatMap((group) => group.stackIds)
			.slice(0, SUPABASE_MAX_DESTROY_IDS),
	};
}

export function isSupabasePruneSelectionStale(
	selection: SupabasePruneSelection,
	prune: Pick<SupabasePruneSummary, 'revision'>
): boolean {
	return selection.revision !== prune.revision;
}

/**
 * Re-keys a selection to the current revision, keeping what is still
 * selectable: the person has reviewed it.
 */
export function reviewSupabasePruneSelection(
	selection: SupabasePruneSelection,
	prune: SupabasePruneSummary
): SupabasePruneSelection {
	const allowed = selectableIds(prune);
	return {
		revision: prune.revision,
		stackIds: selection.stackIds.filter((id) => allowed.has(id)),
	};
}

/** Selects or clears one stack; unreadable and vanished stacks never select. */
export function toggleSupabasePruneStack(
	selection: SupabasePruneSelection,
	prune: SupabasePruneSummary,
	stackId: string
): SupabasePruneSelection {
	const reviewed = reviewSupabasePruneSelection(selection, prune);
	if (reviewed.stackIds.includes(stackId)) {
		return {
			...reviewed,
			stackIds: reviewed.stackIds.filter((id) => id !== stackId),
		};
	}
	if (
		!selectableIds(prune).has(stackId) ||
		reviewed.stackIds.length >= SUPABASE_MAX_DESTROY_IDS
	) {
		return reviewed;
	}
	return { ...reviewed, stackIds: [...reviewed.stackIds, stackId] };
}

export type SupabasePruneGroupView = Readonly<{
	id: SupabasePruneGroupId;
	label: string;
	consequence: string;
	selectable: boolean;
	sizeLabel: string;
	selected: 'all' | 'some' | 'none';
	rows: readonly Readonly<{
		stackId: string;
		title: string;
		sizeLabel: string;
		selected: boolean;
	}>[];
}>;

function pruneGroupLabel(
	id: SupabasePruneGroupId,
	policy: Pick<SupabasePolicy, 'retentionDays'>
): string {
	switch (id) {
		case 'worktree-deleted':
			return 'Worktree deleted';
		case 'stale-branch':
			return 'Stale branch';
		case 'retention':
			return `Stopped longer than ${policy.retentionDays} days`;
		case 'failed-start':
			return 'Failed to start';
		case 'unreadable':
			return 'Unreadable';
	}
}

const PRUNE_CONSEQUENCES: Readonly<Record<SupabasePruneGroupId, string>> = {
	'worktree-deleted':
		'No downside: the worktree is gone, and its uploads with it.',
	'stale-branch':
		'Recovery: lane up recreates a fresh, migrated, seeded database in about 5 s.',
	retention:
		'Recovery: lane up recreates a fresh, migrated, seeded database in about 5 s.',
	'failed-start':
		'It holds no data yet; starting again creates it in about 5 s.',
	unreadable:
		"Never selectable: this CLI can't decode it, and RN Devtools never deletes stack folders.",
};

/** The Clean up groups, with each stack's selection state. */
export function supabasePruneGroups(
	state: Pick<SupabaseState, 'prune' | 'stacks' | 'policy'>,
	selection: SupabasePruneSelection
): readonly SupabasePruneGroupView[] {
	const reviewed = new Set(
		reviewSupabasePruneSelection(selection, state.prune).stackIds
	);
	return state.prune.groups.map((group) => {
		const rows = group.stackIds.map((stackId) => {
			const stack = state.stacks.find((candidate) => candidate.id === stackId);
			return {
				stackId,
				title: stack ? supabaseStackTitle(stack) : shortSupabaseId(stackId),
				sizeLabel: formatSize(stack?.diskBytes),
				selected: group.selectable && reviewed.has(stackId),
			};
		});
		const count = rows.filter((row) => row.selected).length;
		return {
			id: group.id,
			label: pruneGroupLabel(group.id, state.policy),
			consequence: PRUNE_CONSEQUENCES[group.id],
			selectable: group.selectable,
			sizeLabel: formatSize(group.bytes),
			selected: count === 0 ? 'none' : count === rows.length ? 'all' : 'some',
			rows,
		};
	});
}

const lastCleanUpFormat = new Intl.DateTimeFormat(undefined, {
	month: 'short',
	day: 'numeric',
	hour: '2-digit',
	minute: '2-digit',
	hour12: false,
});

/** The Clean up summary bar, the trigger's label and availability. */
export function supabasePruneSummary(
	state: Pick<SupabaseState, 'prune' | 'stacks' | 'feature'>,
	selection: SupabasePruneSelection,
	context: Readonly<{ bridgeAvailable: boolean }>
): Readonly<{
	stackIds: readonly string[];
	triggerLabel: string;
	statusLine: string;
	availability: SupabaseAvailability;
	onDisk: string;
	suggested: string;
	selectedSize: string;
	notSuggested: string;
	lastResult?: string;
}> {
	const allowed = selectableIds(state.prune);
	const stackIds = selection.stackIds.filter((id) => allowed.has(id));
	const bytes = stackIds.reduce(
		(total, id) =>
			total + (state.stacks.find((stack) => stack.id === id)?.diskBytes ?? 0),
		0
	);
	const { notSuggested, lastResult } = state.prune;
	const skipped = [
		notSuggested.held > 0 ? `${notSuggested.held} held` : '',
		notSuggested.pinned > 0 ? `${notSuggested.pinned} pinned` : '',
		notSuggested.starting > 0 ? `${notSuggested.starting} starting` : '',
		notSuggested.external > 0 ? `${notSuggested.external} external` : '',
		notSuggested.running > 0 ? `${notSuggested.running} running` : '',
	].filter(Boolean);
	const count = stackIds.length;
	return {
		stackIds,
		triggerLabel:
			count === 0
				? 'Destroy selected stacks…'
				: `Destroy ${plural(count, 'stack')} (${formatSize(bytes)})…`,
		statusLine:
			count === 0
				? 'Select stacks to clean up · a system dialog confirms'
				: `${plural(count, 'stack')} selected · a system dialog confirms`,
		availability: supabaseCleanUpAvailability(
			{ stackIds, revision: selection.revision },
			{ bridgeAvailable: context.bridgeAvailable, state }
		),
		onDisk: formatSize(state.prune.onDiskBytes),
		suggested: formatSize(state.prune.suggestedBytes),
		selectedSize: formatSize(bytes),
		notSuggested:
			skipped.length > 0
				? `Not suggested: ${skipped.join(', ')}. Never automatic.`
				: 'RN Devtools never deletes a database on its own.',
		...(lastResult
			? {
					lastResult: `Last clean up destroyed ${plural(lastResult.destroyed, 'stack')}${lastResult.freedBytes === undefined ? '' : ` and freed ${formatSize(lastResult.freedBytes)}`}${lastResult.failed > 0 ? ` · ${lastResult.failed} failed` : ''} · ${lastCleanUpFormat.format(lastResult.at)}`,
				}
			: {}),
	};
}

/** The destroy that Clean up runs: bound to the revision it was reviewed on. */
export function supabaseCleanUpOperation(
	selection: SupabasePruneSelection
): Extract<SupabaseOperationInput, { kind: 'destroy' }> {
	return {
		kind: 'destroy',
		stackIds: [...selection.stackIds],
		removeUploads: false,
		pruneRevision: selection.revision,
	};
}

// ---------------------------------------------------------------------------
// Job steps

type SupabaseStepStatus =
	| 'success'
	| 'current'
	| 'muted'
	| 'danger'
	| 'default';

export type SupabaseStepView = Readonly<{
	id: string;
	label: string;
	detail?: string;
	state: NonNullable<SupabaseJob['steps']>[number]['state'];
	status: SupabaseStepStatus;
	current: boolean;
}>;

const JOB_VERBS: Readonly<Record<SupabaseJob['kind'], string>> = {
	create: 'Starting',
	resume: 'Starting',
	stop: 'Stopping',
	restart: 'Restarting',
	'stop-and-start': 'Restarting',
	destroy: 'Destroying',
	recreate: 'Recreating',
	reset: 'Resetting',
	migrate: 'Migrating',
	'seed-buckets': 'Seeding buckets for',
	export: 'Exporting',
	prepare: 'Downloading services for',
	studio: 'Restarting',
	disable: 'Stopping',
};

const STEP_STATUS: Readonly<
	Record<SupabaseStepView['state'], SupabaseStepStatus>
> = {
	done: 'success',
	current: 'current',
	pending: 'muted',
	failed: 'danger',
	skipped: 'muted',
};

/**
 * A job as a step list: main's steps with Timeline statuses, the elapsed
 * and expected time, and the one-time download note. No percentages.
 */
export function supabaseStepList(
	job: SupabaseJob,
	now: number,
	title = 'the stack'
): Readonly<{
	steps: readonly SupabaseStepView[];
	headline: string;
	elapsed: string;
	expected?: string;
	coldCacheNote?: string;
	/** The step a polite live region announces. */
	currentLabel?: string;
	failed: boolean;
	error?: SupabaseErrorView;
	latestLine?: string;
}> {
	const active = isActiveSupabaseJob(job);
	const elapsed = formatSupabaseElapsed(
		(active ? now : job.updatedAt) - job.startedAt
	);
	const failed = job.status === 'failed' || job.status === 'lost';
	const steps = job.steps ?? [];
	const markFailed =
		failed && !steps.some((step) => step.state === 'failed')
			? steps.findIndex((step) => step.state === 'current')
			: -1;
	const views = steps.map((step, index): SupabaseStepView => {
		const state = index === markFailed ? 'failed' : step.state;
		const migration =
			job.migration &&
			/migration/i.test(step.label) &&
			step.detail === undefined
				? `${job.migration.done} of ${job.migration.total}`
				: undefined;
		const detail =
			step.detail ?? migration ?? (state === 'skipped' ? 'skipped' : undefined);
		return {
			id: step.id,
			label: step.label,
			...(detail === undefined ? {} : { detail }),
			state,
			status: STEP_STATUS[state],
			current: state === 'current',
		};
	});
	const current = views.find((step) => step.current);
	return {
		steps: views,
		headline:
			job.status === 'queued'
				? 'Queued · new stacks start one at a time'
				: `${JOB_VERBS[job.kind]} ${title} · ${elapsed}`,
		elapsed,
		...(job.expectedMs === undefined
			? {}
			: { expected: `about ${formatSupabaseElapsed(job.expectedMs)}` }),
		...(job.coldCache === true
			? {
					coldCacheNote:
						'First start on this Mac downloads services once (usually about 45 s); later stacks take about 5 s.',
				}
			: {}),
		...(current ? { currentLabel: current.label } : {}),
		failed,
		...(job.error ? { error: job.error } : {}),
		...(job.latestLine === undefined ? {} : { latestLine: job.latestLine }),
	};
}

// ---------------------------------------------------------------------------
// Logs

export type SupabaseLogLine = Readonly<{
	key: string;
	kind: 'entry' | 'marker';
	service: string;
	/** Exactly what the pre shows and Copy shown copies: redacted text only. */
	text: string;
	/** Filter matches as [start, end) offsets into `text`, for <mark>. */
	matches: readonly (readonly [number, number])[];
}>;

/** `--- launch 2 ---`, or `--- 3 stdout lines lost · rest ---` with the service. */
export function supabaseLogMarkerText(
	record: Extract<SupabaseLogRecord, { type: 'marker' }>,
	includeService: boolean
): string {
	const service = includeService ? ` · ${record.service}` : '';
	if (record.kind === 'launch') {
		return `--- launch${record.count === undefined ? '' : ` ${record.count}`}${service} ---`;
	}
	const count = record.count === undefined ? 'some' : String(record.count);
	const stream = record.stream === undefined ? '' : ` ${record.stream}`;
	return `--- ${count}${stream} ${record.count === 1 ? 'line' : 'lines'} lost${service} ---`;
}

function logTime(timestamp: string): string {
	const parsed = Date.parse(timestamp);
	return Number.isNaN(parsed) ? timestamp : formatClock(parsed);
}

function matchRanges(text: string, query: string): [number, number][] {
	if (query === '') return [];
	const haystack = text.toLowerCase();
	const ranges: [number, number][] = [];
	let from = 0;
	for (;;) {
		const index = haystack.indexOf(query, from);
		if (index < 0) return ranges;
		ranges.push([index, index + query.length]);
		from = index + query.length;
	}
}

/**
 * A logs read as the pre shows it: service filter, text filter with match
 * offsets, and markers kept as context while no text filter is set. The
 * filter is client-side over main's redacted, bounded records.
 */
export function supabaseLogView(
	payload: SupabaseLogsPayload,
	options: Readonly<{ query?: string; service?: string }> = {}
): Readonly<{
	lines: readonly SupabaseLogLine[];
	services: readonly string[];
	/** Entries in the read, before filtering. */
	total: number;
	/** Entries shown after filtering; the role=status count. */
	matchCount: number;
	visibleText: string;
	summary: string;
}> {
	const query = (options.query ?? '').trim().toLowerCase();
	const service =
		options.service === undefined || options.service === 'all'
			? undefined
			: options.service;
	const services = [
		...new Set(payload.records.map((record) => record.service)),
	];
	const includeService = service === undefined && services.length > 1;
	const lines: SupabaseLogLine[] = [];
	let total = 0;
	payload.records.forEach((record, index) => {
		if (record.type === 'entry') total += 1;
		if (service !== undefined && record.service !== service) return;
		if (record.type === 'marker') {
			if (query === '') {
				lines.push({
					key: `${index}`,
					kind: 'marker',
					service: record.service,
					text: supabaseLogMarkerText(record, includeService),
					matches: [],
				});
			}
			return;
		}
		const text = `${logTime(record.timestamp)} ${record.service.padEnd(9)} ${record.line}`;
		const matches = matchRanges(text, query);
		if (query !== '' && matches.length === 0) return;
		lines.push({
			key: `${index}`,
			kind: 'entry',
			service: record.service,
			text,
			matches,
		});
	});
	const matchCount = lines.filter((line) => line.kind === 'entry').length;
	return {
		lines,
		services,
		total,
		matchCount,
		visibleText: lines.map((line) => line.text).join('\n'),
		summary: [
			'Redacted',
			plural(total, 'line'),
			`${formatSize(payload.bytes)} of ${formatSize(SUPABASE_MAX_LOG_CHARACTERS)}`,
			`read ${formatClock(payload.readAt)}`,
			payload.truncated ? 'older lines dropped' : '',
		]
			.filter(Boolean)
			.join(' · '),
	};
}

// ---------------------------------------------------------------------------
// Database

type MigrationStatus = 'applied' | 'pending' | 'out-of-order' | 'missing-local';

const MIGRATION_LABELS: Readonly<
	Record<MigrationStatus, Readonly<{ label: string; tone: SupabaseTone }>>
> = {
	applied: { label: 'applied', tone: 'default' },
	pending: { label: 'pending', tone: 'warning' },
	'out-of-order': { label: 'out of order', tone: 'danger' },
	'missing-local': { label: 'missing locally', tone: 'warning' },
};

function hitRate(value: string | undefined): string {
	if (value === undefined) return '—';
	if (value.trim().endsWith('%')) return value.trim();
	const ratio = Number(value);
	return Number.isFinite(ratio) && ratio >= 0 && ratio <= 1
		? `${(ratio * 100).toFixed(1)}%`
		: value;
}

const rowCount = new Intl.NumberFormat(undefined);

/**
 * A database read as the Database section shows it: the stats line, the
 * top tables, and migrations with their statuses (only when comparable).
 */
export function supabaseDatabaseView(
	payload: SupabaseDatabasePayload
): Readonly<{
	target: SupabaseDatabasePayload['target'];
	targetNote?: string;
	stats: readonly Readonly<{ id: string; label: string; value: string }>[];
	summary: string;
	tables: readonly Readonly<{ name: string; rows: string; size: string }>[];
	migrations?:
		| Readonly<{
				comparable: true;
				state: 'up-to-date' | 'pending' | 'out-of-order' | 'missing-local';
				summary: string;
				pending: readonly string[];
				truncated: boolean;
				rows: readonly Readonly<{
					version: string;
					time: string;
					status: MigrationStatus;
					statusLabel: string;
					tone: SupabaseTone;
				}>[];
		  }>
		| Readonly<{ comparable: false; reasonText: string }>;
	readAt: number;
}> {
	const stats = payload.stats ?? {};
	const entries = [
		{ id: 'size', label: 'Size', value: stats.databaseSize ?? '—' },
		{ id: 'index-hit', label: 'Index hit', value: hitRate(stats.indexHitRate) },
		{ id: 'table-hit', label: 'Table hit', value: hitRate(stats.tableHitRate) },
		{ id: 'wal', label: 'WAL', value: stats.walSize ?? '—' },
		{ id: 'tables', label: 'Tables', value: stats.totalTableSize ?? '—' },
		{ id: 'indexes', label: 'Indexes', value: stats.totalIndexSize ?? '—' },
		{
			id: 'since-reset',
			label: 'Stats since',
			value: stats.timeSinceStatsReset ?? '—',
		},
	];
	const summary = [
		stats.databaseSize === undefined ? '' : `Size ${stats.databaseSize}`,
		stats.indexHitRate === undefined
			? ''
			: `index hit ${hitRate(stats.indexHitRate)}`,
		stats.tableHitRate === undefined
			? ''
			: `table hit ${hitRate(stats.tableHitRate)}`,
		stats.walSize === undefined ? '' : `WAL ${stats.walSize}`,
	]
		.filter(Boolean)
		.join(' · ');
	const migrations = payload.migrations;
	return {
		target: payload.target,
		...(payload.target === 'db-url'
			? {
					targetNote:
						"The worktree is on another branch, so these stats are read through the database address RN Devtools keeps for this stack; migration status isn't worked out.",
				}
			: {}),
		stats: entries,
		summary: summary || 'No statistics yet',
		tables: payload.topTables.map((table) => {
			const rows = Number(table.estimatedRowCount);
			return {
				name: table.name,
				rows:
					table.estimatedRowCount !== undefined && Number.isFinite(rows)
						? `~${rowCount.format(rows)} rows`
						: '—',
				size: table.totalSize ?? table.tableSize ?? '—',
			};
		}),
		...(migrations === undefined
			? {}
			: {
					migrations: migrations.comparable
						? {
								comparable: true,
								state: migrations.state,
								summary: [
									`Migrations · ${migrations.applied} applied`,
									`${migrations.pending.length} pending`,
									migrations.outOfOrder.length > 0
										? `${migrations.outOfOrder.length} out of order`
										: '',
									migrations.missingLocal.length > 0
										? `${migrations.missingLocal.length} missing locally`
										: '',
								]
									.filter(Boolean)
									.join(' · '),
								pending: migrations.pending,
								truncated: migrations.total > migrations.rows.length,
								rows: migrations.rows.map((row) => ({
									...row,
									statusLabel: MIGRATION_LABELS[row.status].label,
									tone: MIGRATION_LABELS[row.status].tone,
								})),
							}
						: { comparable: false, reasonText: migrations.reasonText },
				}),
		readAt: payload.readAt,
	};
}

// ---------------------------------------------------------------------------
// Connect

/**
 * The Connect section: loopback URLs to copy, the database port, and keys
 * by name only. Values never reach the renderer; main writes key, psql and
 * app-variable copies to the clipboard itself.
 */
export function supabaseConnectView(
	stack: SupabaseStackSummary,
	policy: Pick<SupabasePolicy, 'appEnv'>
): Readonly<{
	urls: readonly Readonly<{
		id: 'api' | 'rest' | 'functions';
		label: string;
		value?: string;
	}>[];
	databasePort?: number;
	publishable: Readonly<{ known: boolean; description: string }>;
	secret: string;
	mailpit: Readonly<{ excluded: boolean; port?: number }>;
	studio: Readonly<{
		included: boolean;
		operatorEnabled: boolean;
		port?: number;
	}>;
	appEnv: readonly Readonly<{
		name: string;
		source: string;
		injected: boolean;
	}>[];
	envShadow: readonly string[];
	footnotes: readonly string[];
}> {
	const url = (
		id: 'api' | 'rest' | 'functions',
		label: string,
		value: string | undefined
	) => ({ id, label, ...(value === undefined ? {} : { value }) });
	return {
		urls: [
			url('api', 'API URL', stack.apiUrl),
			url('rest', 'REST', stack.restUrl),
			url('functions', 'Functions', stack.functionsUrl),
		],
		...(stack.ports.db === undefined ? {} : { databasePort: stack.ports.db }),
		publishable: {
			known: stack.known.publishableKey,
			description: 'The local default key, the same on every local stack.',
		},
		secret:
			stack.cli.statusCommand === undefined
				? 'Not shown by RN Devtools.'
				: `Not shown by RN Devtools. Run ${stack.cli.statusCommand} in the worktree.`,
		mailpit: {
			excluded: stack.excluded.includes('mail'),
			...(stack.ports.mail === undefined ? {} : { port: stack.ports.mail }),
		},
		studio: {
			included: stack.studio.included,
			operatorEnabled: stack.studio.operatorEnabled,
			...(stack.ports.studio === undefined ? {} : { port: stack.ports.studio }),
		},
		appEnv: policy.appEnv.map((entry) => ({
			name: entry.name,
			source: entry.source,
			injected: stack.appEnvNames.includes(entry.name),
		})),
		envShadow: (stack.envShadow ?? []).map(
			(shadow) =>
				`${shadow.file}:${shadow.line} sets ${shadow.name}; Expo reads it instead.`
		),
		footnotes: [
			'Values stay in RN Devtools.',
			'Keys and the database password never reach this window; RN Devtools writes them to the clipboard itself.',
		],
	};
}

// ---------------------------------------------------------------------------
// Clock cadence

/**
 * The time to judge a state by. A live state is read against the panel
 * clock; the demo state describes one fixed moment, so it is read at that
 * moment and its countdowns and request expiry stay coherent.
 */
export function supabaseStateClock(
	state: Pick<SupabaseState, 'source' | 'updatedAt'>,
	now: number
): number {
	return state.source === 'demo' ? state.updatedAt : now;
}

/** Countdowns under two minutes tick every second, the rest every 15 s. */
export const SUPABASE_FAST_TICK_MS = 1_000;
export const SUPABASE_SLOW_TICK_MS = 15_000;
const FAST_WINDOW_MS = 120_000;

/**
 * How often the panel clock ticks: every second while a visible countdown
 * is under two minutes or an elapsed counter runs, otherwise every 15 s.
 */
export function supabaseClockCadence(
	clock: Readonly<{
		deadlines?: readonly (number | undefined)[];
		elapsing?: boolean;
	}>,
	now: number
): number {
	if (clock.elapsing === true) return SUPABASE_FAST_TICK_MS;
	return (clock.deadlines ?? []).some(
		(deadline) =>
			deadline !== undefined &&
			deadline - now > 0 &&
			deadline - now < FAST_WINDOW_MS
	)
		? SUPABASE_FAST_TICK_MS
		: SUPABASE_SLOW_TICK_MS;
}

/** The countdowns a stack's row and detail show: auto-stop and hold ends. */
export function supabaseStackDeadlines(
	stack: Pick<SupabaseStackSummary, 'autoStopAt' | 'holds'>
): readonly number[] {
	return [
		stack.autoStopAt,
		...stack.holds.map((hold) => hold.releaseAt),
	].filter((deadline): deadline is number => deadline !== undefined);
}

// ---------------------------------------------------------------------------
// Detail controls

/** How a control confirms; see {@link supabaseConfirmationKind}. */
type SupabaseConfirmationChoice = ReturnType<typeof supabaseConfirmationKind>;

/** Where a control that runs nothing takes the operator. */
export type SupabaseControlTarget =
	| Readonly<{ kind: 'section'; section: SupabaseDetailSection }>
	| Readonly<{ kind: 'repository'; repositoryId: string }>
	| Readonly<{ kind: 'stack'; stackId: string }>
	| Readonly<{ kind: 'show-running' }>
	| Readonly<{ kind: 'refresh' }>;

/**
 * One detail button: what it runs or opens, how it confirms, and the visible
 * reason when it can't run yet. Ids reuse the action row's, so a notice never
 * repeats a button the row already shows.
 */
export type SupabaseControl = Readonly<{
	id: string;
	label: string;
	availability: SupabaseAvailability;
	operation?: SupabaseOperationInput;
	target?: SupabaseControlTarget;
	confirmation: SupabaseConfirmationChoice;
}>;

export type SupabaseControlContext = Readonly<{
	bridgeAvailable: boolean;
	now: number;
	/** The renderer has this stack's operation pending. */
	pending?: boolean;
	/** The last database read, for the migration controls. */
	migrations?: SupabaseMigrationsView;
}>;

/**
 * A control for one stack. Navigation needs nothing but the renderer, so a
 * control without an `action` is always available.
 */
export function supabaseStackControl(
	stack: SupabaseStackSummary,
	state: SupabaseState,
	context: SupabaseControlContext,
	spec: Readonly<{
		id: string;
		label: string;
		action?: SupabaseStackAction;
		operation?: SupabaseOperationInput;
		target?: SupabaseControlTarget;
	}>
): SupabaseControl {
	const availability: SupabaseAvailability =
		spec.action === undefined
			? { allowed: true }
			: supabaseActionAvailability(stack, spec.action, {
					bridgeAvailable: context.bridgeAvailable,
					state,
					now: context.now,
					...(context.pending === undefined
						? {}
						: { pending: context.pending }),
					...(context.migrations === undefined
						? {}
						: { migrations: context.migrations }),
				});
	return {
		id: spec.id,
		label: spec.label,
		availability,
		...(spec.operation === undefined ? {} : { operation: spec.operation }),
		...(spec.target === undefined ? {} : { target: spec.target }),
		confirmation:
			spec.operation === undefined
				? { kind: 'none' }
				: supabaseConfirmationKind(spec.operation, state),
	};
}

type ControlFactory = (
	spec: Parameters<typeof supabaseStackControl>[3]
) => SupabaseControl;

function controlsFor(
	stack: SupabaseStackSummary,
	state: SupabaseState,
	context: SupabaseControlContext
) {
	const make: ControlFactory = (spec) =>
		supabaseStackControl(stack, state, context, spec);
	const id = stack.id;
	const creates =
		stack.state === 'not-created' ||
		stack.state === 'never-started' ||
		stack.state === 'failed';
	return {
		start: (controlId: 'start' | 'resume' | 'try-again', label: string) =>
			make({
				id: controlId,
				label,
				action: creates ? 'start' : 'resume',
				operation: { kind: 'start', stackId: id },
			}),
		stop: () =>
			stack.origin === 'external'
				? make({
						id: 'stop-external',
						label: 'Stop…',
						action: 'stop',
						operation: { kind: 'stop', stackIds: [id] },
					})
				: make({
						id: 'stop',
						label: 'Stop',
						action: 'stop',
						operation: { kind: 'stop', stackIds: [id] },
					}),
		restart: () =>
			make({
				id: 'restart',
				label: 'Restart services',
				action: 'restart',
				operation: { kind: 'restart', stackId: id },
			}),
		stopAndStart: (
			purpose: 'apply-config' | 'switch-cli' | 'recover-partial',
			label: string
		) =>
			make({
				id: `stop-and-start:${purpose}`,
				label,
				action: purpose === 'switch-cli' ? 'switch-cli' : 'stop-and-start',
				operation: { kind: 'stop-and-start', stackId: id, purpose },
			}),
		reapply: () =>
			make({
				id: 'reapply-exclusions',
				label: 'Re-apply exclusions',
				action: 'reapply-exclusions',
				operation: { kind: 'reapply-exclusions', stackId: id },
			}),
		destroy: () =>
			make({
				id: 'destroy',
				label: 'Destroy…',
				action: 'destroy',
				operation: { kind: 'destroy', stackIds: [id], removeUploads: false },
			}),
		recreate: (label: string) =>
			make({
				id: 'recreate',
				label,
				action: 'recreate',
				operation: { kind: 'recreate', stackId: id },
			}),
		reveal: () =>
			make({
				id: 'reveal',
				label: 'Reveal in Finder',
				action: 'reveal',
				operation: { kind: 'reveal', stackId: id, what: 'stack-folder' },
			}),
		follow: () =>
			make({
				id: 'follow-branch',
				label: 'Follow',
				action: 'follow-branch',
				operation: { kind: 'follow-branch', stackId: id },
			}),
		resumeSaved: () =>
			make({
				id: 'resume-saved',
				label: 'Resume with saved settings',
				action: 'resume-saved',
				operation: { kind: 'resume-saved', stackId: id },
			}),
		reviewRepository: () =>
			stack.repositoryId === undefined
				? undefined
				: make({
						id: 'review-repository',
						label: 'Review repository',
						target: { kind: 'repository', repositoryId: stack.repositoryId },
					}),
		section: (
			controlId: string,
			label: string,
			section: SupabaseDetailSection
		) => make({ id: controlId, label, target: { kind: 'section', section } }),
		openStack: (stackId: string, label: string) =>
			make({ id: 'open-stack', label, target: { kind: 'stack', stackId } }),
		showRunning: () =>
			make({
				id: 'show-running',
				label: 'Show running stacks',
				target: { kind: 'show-running' },
			}),
		refresh: () =>
			make({ id: 'refresh', label: 'Refresh', target: { kind: 'refresh' } }),
	};
}

function present<T>(values: readonly (T | undefined)[]): T[] {
	return values.filter((value): value is T => value !== undefined);
}

function distinctControls(
	controls: readonly (SupabaseControl | undefined)[]
): SupabaseControl[] {
	const seen = new Set<string>();
	return present(controls).filter((control) => {
		if (seen.has(control.id)) return false;
		seen.add(control.id);
		return true;
	});
}

function sentence(text: string): string {
	const trimmed = text.trim();
	return trimmed === '' || /[.!?…:]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Main's recovery, or its message when there is no recovery. */
function errorBody(error: SupabaseErrorView): string {
	const recovery = error.recovery.trim();
	const message = error.message.trim();
	if (recovery !== '') return sentence(recovery);
	return message !== '' && message !== error.title ? sentence(message) : '';
}

/**
 * The one recovery each of main's error codes maps to; codes the desktop
 * raises for itself, or that the tab answers elsewhere, map to none.
 */
function errorControl(
	stack: SupabaseStackSummary,
	controls: ReturnType<typeof controlsFor>,
	error: SupabaseErrorView
): SupabaseControl | undefined {
	switch (error.code) {
		case 'not_running':
			return stack.state === 'stopped'
				? controls.start('resume', 'Resume')
				: controls.start('start', 'Start');
		case 'ports_conflict':
		case 'confirm_required':
			return controls.start('try-again', 'Try again');
		case 'cli_mismatch':
			return controls.stopAndStart('switch-cli', 'Restart with this CLI');
		case 'needs_recreate':
			return controls.recreate('Destroy and recreate…');
		case 'container_runtime':
			return controls.destroy();
		case 'ports_pinned':
			return error.details.holderStackId === undefined
				? controls.reviewRepository()
				: controls.openStack(error.details.holderStackId, 'Open that stack');
		case 'partial':
		case 'reset_failed_partial':
			return controls.stopAndStart('recover-partial', 'Stop and start');
		case 'capacity':
			return controls.showRunning();
		case 'unreadable':
			return controls.reveal();
		case 'migration_drift':
			return controls.section('open-database', 'Open database', 'database');
		case 'migration_failed':
		case 'failed':
			return controls.section('open-logs', 'Open logs', 'logs');
		case 'flag_misuse':
			return controls.reviewRepository();
		case 'not_found':
		case 'busy':
		case 'stale_selection':
		case 'unknown_target':
		case 'internal':
			return controls.refresh();
		case 'refused':
		case 'feature_off':
		case 'platform_unsupported':
		case 'confirmation_required':
		case 'unavailable':
			return undefined;
	}
}

/** A typed notice under the detail heading, with its recoveries. */
export type SupabaseDetailNotice = Readonly<{
	id: string;
	tone: 'danger' | 'warning' | 'default';
	title: string;
	text: string;
	controls: readonly SupabaseControl[];
	/** Needs recreate: what the saved stack can't adopt. */
	changes?: readonly SupabaseStackChangeView[];
}>;

const NOTICE_ORDER: Readonly<Record<SupabaseDetailNotice['tone'], number>> = {
	danger: 0,
	warning: 1,
	default: 2,
};

function movedHeadLabel(stack: SupabaseStackSummary): string {
	const label = supabaseBranchLabel(stack.currentHead?.ref);
	if (label === undefined) return 'another branch';
	return label === 'detached HEAD' ? 'a detached HEAD' : label;
}

/**
 * The detail's typed notices, danger first: exposure, failed and interrupted
 * starts, needs recreate, unreadable state, a deleted worktree, a CLI
 * mismatch, an unresponsive owner, a partial stop, a stale branch, observed
 * mode, a pinned port, and any other error main recorded. Title and recovery
 * come from main's ClassifiedSupabaseError when it has one. A stack with an
 * operation in flight shows its step list instead.
 */
export function supabaseDetailNotices(
	stack: SupabaseStackSummary,
	state: SupabaseState,
	context: SupabaseControlContext
): readonly SupabaseDetailNotice[] {
	const status = stackStatus(stack, { jobs: state.jobs });
	if (status.key === 'in-flight' || status.key === 'queued') return [];
	const controls = controlsFor(stack, state, context);
	const live = isLive(stack);
	const error = stack.lastError;
	const engine = stack.runtime === 'podman' ? 'Podman' : 'Docker';
	const notices: SupabaseDetailNotice[] = [];
	const handled = new Set<string>();
	const push = (
		notice: Omit<SupabaseDetailNotice, 'controls'> & {
			controls: readonly (SupabaseControl | undefined)[];
		},
		codes: readonly string[] = []
	) => {
		for (const code of codes) handled.add(code);
		notices.push({ ...notice, controls: distinctControls(notice.controls) });
	};

	if (status.key === 'lan-exposed') {
		push(
			{
				id: 'lan-exposed',
				tone: 'danger',
				title: 'LAN-exposed.',
				text: `${engine} listens on every interface with public default keys. ${live ? 'It still runs; stop it before you destroy it.' : 'Stopped once, never attached.'} Nothing is deleted if ${engine} doesn't answer.`,
				controls: [live ? controls.stop() : controls.destroy()],
			},
			['container_runtime']
		);
	} else if (status.key === 'exposure-unknown') {
		push({
			id: 'exposure-unknown',
			tone: 'danger',
			title: 'Exposure unknown.',
			text: "Couldn't verify it listens only on this Mac, so it was stopped. Resume checks again.",
			controls: [controls.start('resume', 'Resume')],
		});
	}
	if (stack.state === 'failed') {
		push(
			{
				id: 'failed',
				tone: 'danger',
				title: error ? sentence(error.title) : 'Failed to start.',
				text: error
					? errorBody(error)
					: 'The first start failed and left an empty stack.',
				controls: [
					error ? errorControl(stack, controls, error) : undefined,
					controls.start('try-again', 'Try again'),
					controls.destroy(),
				],
			},
			error ? [error.code] : []
		);
	}
	if (stack.state === 'interrupted') {
		push({
			id: 'interrupted',
			tone: 'danger',
			title: 'Interrupted.',
			text: "A first start stopped midway can't be resumed. Destroy it and start again; nothing was saved yet.",
			controls: [controls.recreate('Destroy and start again…')],
		});
	}
	if (stack.state === 'needs-recreate') {
		// Kept until the state clears: a later failure for another reason
		// replaces lastError, which then gets a notice of its own.
		const changes = stack.recreateChanges;
		push(
			{
				id: 'needs-recreate',
				tone: 'danger',
				title: 'Needs recreate.',
				// Main clears this state once the configuration matches the saved
				// stack again, so reverting helps when every listed change is
				// editable, as the Resume reason and the status pill also say.
				text: supabaseRevertKeepsStack(changes)
					? "The saved stack can't adopt this configuration. Revert the listed settings to keep it and its data, or destroy and recreate it for a fresh, migrated, seeded database."
					: "The saved stack can't adopt this configuration. Recreating destroys its data and starts a fresh, migrated, seeded database.",
				controls: [controls.recreate('Destroy and recreate…')],
				...(changes && changes.length > 0 ? { changes } : {}),
			},
			['needs_recreate']
		);
	}
	if (status.key === 'unhealthy') {
		push({
			id: 'unhealthy',
			tone: 'danger',
			title: 'Unhealthy.',
			text: status.explanation,
			controls: [controls.restart()],
		});
	}
	if (stack.state === 'unreadable') {
		push(
			{
				id: 'unreadable',
				tone: 'warning',
				title: 'Stack state cannot be read.',
				text: "This CLI can't decode it (another CLI release may have saved it). RN Devtools never deletes stack folders.",
				controls: [controls.reveal()],
			},
			['unreadable']
		);
	}
	if (
		(stack.flags.includes('worktree-deleted') ||
			stack.flags.includes('orphaned')) &&
		status.key !== 'lan-exposed' &&
		stack.state !== 'unreadable'
	) {
		const size =
			stack.diskBytes === undefined
				? ''
				: `${formatSize(stack.diskBytes)} and `;
		push({
			id: 'worktree-deleted',
			tone: 'warning',
			title: 'Worktree deleted.',
			text: `Its worktree was deleted. RN Devtools ${live ? 'stops it at once' : 'stopped it at once'}. Destroy it to free ${size}10 ports; ${stack.uploadsInDeletedWorktree ? 'its uploads went with the worktree' : 'its uploads stay unless you tick the box in the next dialog'}.`,
			controls: [controls.destroy()],
		});
	}
	if (stack.cli.mismatch) {
		const { mismatch } = stack.cli;
		push(
			{
				id: 'cli-mismatch',
				tone: 'warning',
				title:
					error?.code === 'cli_mismatch'
						? sentence(error.title)
						: 'Stack is served by another CLI release.',
				text: `Owner ${mismatch.ownerVersion ?? mismatch.ownerRelease}, this worktree ${mismatch.clientVersion ?? mismatch.clientRelease}. Stop, Destroy and log history still work; database tools and status don't. Data is kept.`,
				controls: [
					live ? controls.stop() : undefined,
					controls.stopAndStart('switch-cli', 'Restart with this CLI'),
				],
			},
			['cli_mismatch']
		);
	}
	if (stack.ownerLiveness === 'not-responding') {
		push({
			id: 'not-responding',
			tone: 'warning',
			title: 'Owner not responding.',
			text: "Its owner runs but didn't answer in 2 s; agents' local commands fail. Stop asks it to shut down.",
			controls: [controls.stop()],
		});
	}
	if (stack.state === 'partial') {
		push(
			{
				id: 'partial',
				tone: 'warning',
				title: 'Partly stopped.',
				text: 'Some services stopped outside the normal idle cycle. Stop and start brings them back; data is kept.',
				controls: [controls.stopAndStart('recover-partial', 'Stop and start')],
			},
			['partial', 'reset_failed_partial']
		);
	}
	if (status.key === 'stopped-outside') {
		push({
			id: 'stopped-outside',
			tone: 'warning',
			title: 'Stopped outside RN Devtools.',
			text: 'Something still holds it. Resume brings it back; data and ports are kept.',
			controls: [controls.start('resume', 'Resume')],
		});
	}
	if (stack.flags.includes('stale-branch') && stack.state !== 'unreadable') {
		push({
			id: 'stale-branch',
			tone: 'warning',
			title: 'Stale branch.',
			text: `The worktree moved to ${movedHeadLabel(stack)}. Agents' local commands now reach that branch's stack. This one keeps its data; switching back reattaches it. Resume and database changes stay off until then.`,
			controls: [
				controls.follow(),
				stack.state === 'stopped' ? controls.resumeSaved() : undefined,
			],
		});
	}
	if (
		stack.mode.value !== 'managed' &&
		stack.state !== 'unreadable' &&
		status.key !== 'lan-exposed'
	) {
		const reason = stack.mode.reasonText?.trim().replace(/\.$/, '');
		push(
			{
				id: 'observed',
				tone: 'warning',
				title:
					stack.mode.value === 'off'
						? 'Local Supabase is off here:'
						: 'Observed only:',
				text: `${reason || (stack.mode.value === 'off' ? 'Use local Supabase here is Off for this repository' : 'RN Devtools does not manage this worktree')}. RN Devtools lists this stack and can stop or destroy it, but won't start it or change its database.`,
				controls: [controls.reviewRepository()],
			},
			['flag_misuse']
		);
	}
	if (stack.pinnedPort) {
		const { pinnedPort } = stack;
		push(
			{
				id: 'ports-pinned',
				tone: 'warning',
				title: 'Port pinned by another stack.',
				text: `Port ${pinnedPort.port} for ${pinnedPort.key} is pinned in supabase/config.toml and held by ${pinnedPort.holderLabel === undefined ? 'another stack' : `the stack for ${pinnedPort.holderLabel}`}. Remove the pinned port so every worktree gets automatic ports.`,
				controls: [controls.reviewRepository()],
			},
			['ports_pinned']
		);
	}
	if (stack.state === 'never-started') {
		push({
			id: 'never-started',
			tone: 'default',
			title: 'Never started.',
			text: 'Prepared, but never started. Start creates its database, migrations and seed.',
			controls: [controls.start('start', 'Start')],
		});
	}
	if (error && !handled.has(error.code)) {
		push({
			id: `error:${error.code}`,
			tone: 'danger',
			title: sentence(error.title),
			text: errorBody(error),
			controls: [errorControl(stack, controls, error)],
		});
	}
	return notices
		.map((notice, index) => ({ notice, index }))
		.sort(
			(left, right) =>
				NOTICE_ORDER[left.notice.tone] - NOTICE_ORDER[right.notice.tone] ||
				left.index - right.index
		)
		.map(({ notice }) => notice);
}

/**
 * Drift the Services section names when it applies: Studio back on (its SQL
 * endpoint has no authentication) and configuration changed since the start.
 */
export function supabaseDriftNotices(
	stack: SupabaseStackSummary,
	state: SupabaseState,
	context: SupabaseControlContext
): readonly SupabaseDetailNotice[] {
	const controls = controlsFor(stack, state, context);
	const notices: SupabaseDetailNotice[] = [];
	const reenabled = stack.compositionDrift?.reenabled ?? [];
	if (stack.flags.includes('studio-back-on') || reenabled.length > 0) {
		const names = reenabled.length > 0 ? reenabled : ['studio'];
		const studio = names.includes('studio');
		notices.push({
			id: 'studio-back-on',
			tone: 'warning',
			title: studio
				? 'Studio is back on.'
				: `${names.join(' and ')} ${names.length === 1 ? 'is' : 'are'} back on.`,
			text: studio
				? 'A start without exclusions re-enabled it; its SQL endpoint has no authentication while it runs.'
				: 'A start without exclusions re-enabled excluded services.',
			controls: distinctControls([controls.reapply()]),
		});
	}
	if (stack.configDrift.status === 'changed') {
		const paths = stack.configDrift.paths ?? [];
		notices.push({
			id: 'config-changed',
			tone: 'warning',
			title: 'Config changed since this stack started:',
			text:
				paths.length > 0
					? `${paths.join(', ')}.`
					: 'supabase/config.toml changed.',
			controls: distinctControls([
				controls.stopAndStart('apply-config', 'Stop and start to apply'),
			]),
		});
	}
	return notices;
}

function joinNames(names: readonly string[]): string {
	if (names.length <= 1) return names[0] ?? '';
	return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function stopDelayText(policy: Pick<SupabasePolicy, 'unheldStopDelayMs'>) {
	const ms = policy.unheldStopDelayMs;
	if (ms === 0) return 'as soon as nothing holds it';
	return `${formatStopDelay(ms)} after nothing holds it`;
}

/**
 * The inline ConfirmAction copy for an operation that interrupts a live
 * agent (or always confirms inline, like Cancel start and Re-seed). It never
 * stands in front of a native dialog: callers use it only when
 * supabaseConfirmationKind says `inline`.
 */
export function supabaseInlineConfirmCopy(
	input: SupabaseOperationInput,
	state: Pick<SupabaseState, 'stacks' | 'jobs' | 'policy'>,
	agents: readonly string[]
): Readonly<{ title: string; description: string; confirmLabel: string }> {
	const titleOf = (stackId: string | undefined) => {
		const stack = state.stacks.find((candidate) => candidate.id === stackId);
		return stack ? supabaseStackTitle(stack) : 'this stack';
	};
	const who = joinNames(agents);
	const using =
		agents.length === 0
			? ''
			: `${who} ${agents.length === 1 ? 'is' : 'are'} using it; `;
	const capitalized = (text: string) =>
		text === '' ? text : `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`;
	switch (input.kind) {
		case 'stop': {
			if (input.stackIds.length > 1) {
				return {
					title: `Stop ${input.stackIds.length} stacks?`,
					description: `${who} ${agents.length === 1 ? 'is' : 'are'} using ${agents.length === 1 ? 'one of them' : 'them'}; their apps lose the database until something starts them again. Data and ports are kept; pins clear.`,
					confirmLabel: `Stop ${input.stackIds.length}`,
				};
			}
			const title = titleOf(input.stackIds[0]);
			return {
				title: `Stop ${title}'s stack?`,
				description: capitalized(
					`${using}its app loses the database until something starts it again. Data and ports are kept.`
				),
				confirmLabel: `Stop ${title}`,
			};
		}
		case 'restart':
			return {
				title: `Restart ${titleOf(input.stackId)}'s services?`,
				description: capitalized(
					`${using}open connections drop for about a second. Saved settings, exclusions, data and keys are kept.`
				),
				confirmLabel: 'Restart services',
			};
		case 'stop-and-start':
		case 'reapply-exclusions':
			return {
				title: `Stop and start ${titleOf(input.stackId)}?`,
				description: capitalized(
					`${using}its app loses the database for about 4 s. Data is kept.`
				),
				confirmLabel:
					input.kind === 'reapply-exclusions'
						? 'Re-apply exclusions'
						: 'Stop and start',
			};
		case 'apply-migrations':
			return {
				title: `Apply pending migrations to ${titleOf(input.stackId)}?`,
				description: capitalized(
					`${using}schema changes can block its queries while they run.`
				),
				confirmLabel: 'Apply migrations',
			};
		case 'set-studio':
			return {
				title: `Turn Studio off for ${titleOf(input.stackId)}?`,
				description: capitalized(
					`${using}the stack stops and starts without Studio, so its app loses the database for about 4 s. Data is kept.`
				),
				confirmLabel: 'Disable Studio',
			};
		case 'seed-buckets':
			return {
				title: `Re-seed buckets for ${titleOf(input.stackId)}?`,
				description: `${agents.length === 0 ? '' : `${who} ${agents.length === 1 ? 'is' : 'are'} using it. `}Files with the same name in its buckets are overwritten; other files stay.`,
				confirmLabel: 'Re-seed buckets',
			};
		case 'release': {
			const agent = supabaseAgentLabel({
				kind: input.holder.agentKind,
				sessionId: input.holder.sessionId,
				synthetic: input.holder.holder === 'worktree',
			});
			const title = titleOf(input.stackId);
			return {
				title: `Release ${agent}'s hold on ${title}?`,
				description: `${agent} is live and may still use it. ${title} stops ${stopDelayText(state.policy)}, unless a lane or another session keeps it running.`,
				confirmLabel: 'Release',
			};
		}
		case 'cancel-job': {
			const job = state.jobs.find((candidate) => candidate.id === input.jobId);
			return {
				title: `Cancel the start of ${titleOf(job?.stackIds[0])}?`,
				description: 'The CLI cleans up first (up to 45 s).',
				confirmLabel: 'Cancel start',
			};
		}
		case 'request.approve': {
			const stopTitle = titleOf(input.stopStackId);
			return {
				title: `Stop ${stopTitle} to make room?`,
				description: capitalized(
					`${using}its app loses the database until something starts it again. Data and ports are kept.`
				),
				confirmLabel: `Stop ${stopTitle}`,
			};
		}
		default:
			return {
				title: 'Continue?',
				description: capitalized(
					`${using}this interrupts its database for a moment.`
				),
				confirmLabel: 'Continue',
			};
	}
}

// ---------------------------------------------------------------------------
// Overview, facts and services

/** `Running · database healthy · 5 services asleep (start on first request)`. */
export function supabaseOverviewLine(
	stack: SupabaseStackSummary,
	status: SupabaseStackStatus
): string {
	const parts = [status.key === 'running-idle' ? 'Running' : status.label];
	if (isSupabaseStackRunning(stack)) {
		if (stack.health.unhealthy === 0 && stack.readiness !== 'unhealthy') {
			parts.push('database healthy');
		}
		if (stack.health.sleeping > 0) {
			parts.push(
				`${plural(stack.health.sleeping, 'service')} asleep (start on first request)`
			);
		}
	}
	return parts.join(' · ');
}

type SupabaseStackFact = Readonly<{
	id: string;
	label: string;
	value: string;
	/** Muted trailing text, e.g. when it was checked. */
	note?: string;
	mono?: boolean;
	/** A non-secret value the renderer may copy itself. */
	copy?: string;
}>;

const RUNTIME_WORDS: Readonly<Record<SupabaseStackSummary['runtime'], string>> =
	{
		native: 'native',
		docker: 'Docker',
		podman: 'Podman',
		unknown: 'unknown runtime',
	};

const EXPOSURE_WORDS: Readonly<
	Record<SupabaseStackSummary['exposure']['verdict'], string>
> = {
	loopback: 'loopback only',
	'lan-exposed': 'listens on every interface',
	unknown: "couldn't verify where it listens",
	unchecked: 'not checked yet',
};

const GATE_WORDS: Readonly<
	Record<SupabaseStackSummary['cli']['gate'], string>
> = {
	verified: 'verified',
	compatible: 'compatible, not verified',
	unsupported: 'not verified',
	missing: 'not found',
};

/**
 * The Overview facts: runtime and exposure, CLI, disk, memory, id and the
 * inspect command. Command text comes from main; the renderer never spells
 * CLI words. Only non-secret values carry a copy.
 */
export function supabaseStackFacts(
	stack: SupabaseStackSummary,
	now: number
): readonly SupabaseStackFact[] {
	const facts: SupabaseStackFact[] = [];
	if (stack.state !== 'not-created') {
		facts.push({
			id: 'runtime',
			label: 'Runtime',
			value: `${RUNTIME_WORDS[stack.runtime]} · ${EXPOSURE_WORDS[stack.exposure.verdict]}`,
			...(stack.exposure.checkedAt === undefined
				? {}
				: { note: `lsof, ${formatAgo(stack.exposure.checkedAt, now)}` }),
		});
	}
	const cli = [
		stack.cli.version,
		GATE_WORDS[stack.cli.gate],
		stack.cli.runnerLabel,
	].filter((part): part is string => Boolean(part));
	facts.push({
		id: 'cli',
		label: 'Supabase CLI',
		value: cli.join(' · '),
		...(stack.cli.mismatch
			? {
					note: `owner runs ${stack.cli.mismatch.ownerVersion ?? stack.cli.mismatch.ownerRelease}`,
				}
			: {}),
	});
	if (stack.diskBytes !== undefined) {
		facts.push({
			id: 'disk',
			label: 'Disk',
			value:
				stack.uploadsBytes === undefined || stack.uploadsBytes === 0
					? formatSize(stack.diskBytes)
					: `${formatSize(stack.diskBytes)} + ${formatSize(stack.uploadsBytes)} uploads`,
			...(stack.measuredAt === undefined
				? {}
				: { note: `as of ${formatClock(stack.measuredAt)}` }),
		});
	}
	if (stack.memoryBytes !== undefined && isLive(stack)) {
		facts.push({
			id: 'memory',
			label: 'Memory',
			value: `${formatSize(stack.memoryBytes)} RSS`,
		});
	}
	if (
		stack.projectRootLabel !== undefined &&
		stack.projectRootLabel !== stack.worktreeLabel
	) {
		facts.push({
			id: 'project',
			label: 'Project root',
			value: stack.projectRootLabel,
			mono: true,
		});
	}
	if (stack.lastUsedAt !== undefined && !isLive(stack)) {
		facts.push({
			id: 'last-used',
			label: 'Last used',
			value: formatAgo(stack.lastUsedAt, now),
		});
	}
	facts.push({
		id: 'stack-id',
		label: 'Stack id',
		value: shortSupabaseId(stack.id),
		mono: true,
		copy: stack.id,
	});
	if (stack.cli.inspectCommand !== undefined) {
		facts.push({
			id: 'inspect',
			label: 'Inspect',
			value: stack.cli.inspectCommand,
			mono: true,
			copy: stack.cli.inspectCommand,
		});
	}
	return facts;
}

type SupabaseServiceView = Readonly<{
	key: string;
	service: SupabaseInspection['members'][number]['service'];
	state: SupabaseInspection['members'][number]['state'];
	health: SupabaseInspection['members'][number]['health'];
	activation: SupabaseInspection['members'][number]['activation'];
	wakeHintMs?: number;
	port?: number;
	error?: string;
}>;

/**
 * The Services section: the awake count, main's member rows in the CLI's
 * own words when this stack is inspected, and why rows are missing or old.
 */
export function supabaseServicesView(
	stack: SupabaseStackSummary,
	inspection: SupabaseInspection | undefined
): Readonly<{
	summary: string;
	checkedAt?: number;
	rows: readonly SupabaseServiceView[];
	note?: string;
	/** True until the first status read lands for a running stack. */
	waiting: boolean;
	excluded?: string;
}> {
	const { health } = stack;
	const summary =
		health.members === 0
			? ''
			: [
					`${health.awake} of ${health.members} awake`,
					health.sleeping > 0 ? `${health.sleeping} asleep` : '',
					health.unhealthy > 0 ? `${health.unhealthy} unhealthy` : '',
				]
					.filter(Boolean)
					.join(' · ');
	const own = inspection?.stackId === stack.id ? inspection : undefined;
	const rows: SupabaseServiceView[] = (own?.members ?? []).map(
		(member, index) => {
			const port = own?.endpoints.find((endpoint) =>
				endpoint.key.startsWith(`${member.service}.`)
			)?.port;
			return {
				key: `${member.service}:${index}`,
				service: member.service,
				state: member.state,
				health: member.health,
				activation: member.activation,
				...(member.wakeHintMs === undefined
					? {}
					: { wakeHintMs: member.wakeHintMs }),
				...(port === undefined ? {} : { port }),
				...(member.error === undefined ? {} : { error: member.error }),
			};
		}
	);
	const live = isLive(stack);
	let note: string | undefined;
	if (own?.status === 'stale') {
		note = stack.cli.mismatch
			? `Status needs this stack's own Supabase CLI release; showing the state from ${formatClock(own.checkedAt)}.`
			: `Showing the last status, from ${formatClock(own.checkedAt)}.`;
	} else if (own?.status === 'unavailable') {
		note = `Status unavailable: ${sentence(own.error?.message || own.error?.title || 'the CLI did not answer')} Last rows kept.`;
	} else if (!live && stack.state !== 'unknown') {
		note =
			stack.state === 'not-created' || stack.state === 'never-started'
				? 'Services appear once the stack has started.'
				: 'Services run while the stack does; it is not running now.';
	}
	return {
		summary,
		...(own === undefined ? {} : { checkedAt: own.checkedAt }),
		rows,
		...(note === undefined ? {} : { note }),
		waiting: live && own === undefined,
		...(stack.excluded.length > 0
			? { excluded: `Excluded by Settings: ${stack.excluded.join(', ')}.` }
			: {}),
	};
}

// ---------------------------------------------------------------------------
// Log reads

/** A log read's window: the newest 200 lines, or a time span. */
export type SupabaseLogWindow = 'tail' | '10m' | '1h' | 'start';

/** The log windows: `--tail 200`, or `--tail 1000 --since 10m|1h|start`. */
export const SUPABASE_LOG_WINDOWS: readonly Readonly<{
	id: SupabaseLogWindow;
	label: string;
}>[] = [
	{ id: 'tail', label: 'Last 200 lines' },
	{ id: '10m', label: 'Last 10 min' },
	{ id: '1h', label: 'Last hour' },
	{ id: 'start', label: 'Since start' },
];

/** Every log service a filter may name, gateway included. */
const LOG_SERVICES: readonly string[] = [
	'gateway',
	'database',
	'rest',
	'auth',
	'realtime',
	'storage',
	'imgproxy',
	'functions',
	'studio',
	'pgmeta',
	'mail',
	'analytics',
	'pooler',
] satisfies readonly (SupabaseServiceKind | 'gateway')[];

/**
 * The service filter's choices: all services, the gateway, and the services
 * the stack runs (from its inspection when there is one, else every kind
 * except what it excludes).
 */
export function supabaseLogServices(
	stack: Pick<SupabaseStackSummary, 'id' | 'excluded'>,
	inspection: SupabaseInspection | undefined
): readonly string[] {
	const members =
		inspection?.stackId === stack.id
			? new Set<string>(inspection.members.map((member) => member.service))
			: undefined;
	const excluded = new Set<string>(stack.excluded);
	return LOG_SERVICES.filter((service) =>
		service === 'gateway'
			? true
			: members
				? members.has(service)
				: !excluded.has(service)
	);
}

/** The read for a window and service: names services only when filtered. */
export function supabaseLogsOperation(
	stackId: string,
	window: SupabaseLogWindow,
	service: string
): Extract<SupabaseOperationInput, { kind: 'read-logs' }> {
	return {
		kind: 'read-logs',
		stackId,
		...(service === 'all' ? {} : { services: [service] }),
		tail: window === 'tail' ? 200 : 1_000,
		...(window === 'tail' ? {} : { since: window }),
	};
}

const ISO_TIME =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The auto-refresh read: everything since the newest record (its ISO time
 * when the CLI gave one, else the seconds since the last read).
 */
export function supabaseLogsRefreshOperation(
	stackId: string,
	service: string,
	payload: SupabaseLogsPayload,
	now: number
): Extract<SupabaseOperationInput, { kind: 'read-logs' }> {
	const newest = payload.records.at(-1)?.timestamp;
	const since =
		newest !== undefined &&
		ISO_TIME.test(newest) &&
		!Number.isNaN(Date.parse(newest))
			? newest
			: `${Math.min(999_999, Math.max(1, Math.ceil((now - payload.readAt) / 1_000)))}s`;
	return {
		kind: 'read-logs',
		stackId,
		...(service === 'all' ? {} : { services: [service] }),
		tail: 1_000,
		since,
	};
}

function recordKey(record: SupabaseLogRecord): string {
	return record.type === 'entry'
		? `e|${record.timestamp}|${record.service}|${record.instanceId}|${record.stream}|${record.line}`
		: `m|${record.timestamp}|${record.service}|${record.instanceId}|${record.kind}|${record.count ?? ''}`;
}

/**
 * Appends an auto-refresh read to what is on screen: records the two reads
 * share at the boundary appear once, and the oldest lines go first so the
 * pre never holds more than main's 64 KiB.
 */
export function mergeSupabaseLogs(
	previous: SupabaseLogsPayload,
	next: SupabaseLogsPayload
): SupabaseLogsPayload {
	const seen = new Set(previous.records.slice(-200).map(recordKey));
	const records = [
		...previous.records,
		...next.records.filter((record) => !seen.has(recordKey(record))),
	];
	let characters = records.reduce(
		(total, record) =>
			total + (record.type === 'entry' ? record.line.length : 0),
		0
	);
	let start = 0;
	while (
		start < records.length &&
		(characters > SUPABASE_MAX_LOG_CHARACTERS || records.length - start > 5_000)
	) {
		const record = records[start];
		if (record?.type === 'entry') characters -= record.line.length;
		start += 1;
	}
	const kept = records.slice(start);
	return {
		records: kept,
		truncated: previous.truncated || next.truncated || start > 0,
		bytes: kept.reduce(
			(total, record) =>
				total + (record.type === 'entry' ? record.line.length : 0),
			0
		),
		readAt: Math.max(previous.readAt, next.readAt),
	};
}

// ---------------------------------------------------------------------------
// Activity, counts and the requests summary

type SupabaseActivityRow = Readonly<{
	id: string;
	title: string;
	label: string;
	detail?: string;
	elapsed: string;
	tone: 'info' | 'danger' | 'default';
	active: boolean;
	/** Cancel start, for a cancellable desktop start still running. */
	cancel?: Extract<SupabaseOperationInput, { kind: 'cancel-job' }>;
}>;

function outcomeWord(status: SupabaseJob['status']): string {
	switch (status) {
		case 'queued':
			return 'Queued';
		case 'running':
			return 'Running';
		case 'complete':
			return 'done';
		case 'failed':
			return 'failed';
		case 'cancelled':
			return 'cancelled';
		case 'lost':
			return 'lost track';
	}
}

/**
 * The Supabase activity Disclosure: running jobs first, then the newest
 * finished ones, with a summary line naming the first running job.
 */
export function supabaseActivityView(
	state: Pick<SupabaseState, 'jobs' | 'stacks'>,
	now: number
): Readonly<{
	title: string;
	meta?: string;
	active: number;
	rows: readonly SupabaseActivityRow[];
}> {
	const titleOf = (job: SupabaseJob) => {
		const titles = job.stackIds.map((stackId) => {
			const stack = state.stacks.find((candidate) => candidate.id === stackId);
			return stack ? supabaseStackTitle(stack) : shortSupabaseId(stackId);
		});
		if (titles.length === 0) {
			return job.kind === 'prepare' ? 'Pre-download services' : 'Supabase';
		}
		return titles.length > 2
			? `${titles.slice(0, 2).join(', ')} and ${titles.length - 2} more`
			: titles.join(', ');
	};
	const ordered = [...state.jobs].sort(
		(left, right) =>
			Number(isActiveSupabaseJob(right)) - Number(isActiveSupabaseJob(left)) ||
			right.startedAt - left.startedAt
	);
	const rows = ordered.slice(0, 20).map((job): SupabaseActivityRow => {
		const active = isActiveSupabaseJob(job);
		const detail = job.error?.title ?? job.latestLine;
		const startJob =
			job.kind === 'create' || job.kind === 'resume' || job.kind === 'prepare';
		return {
			id: job.id,
			title: titleOf(job),
			label: active ? supabaseJobLabel(job) : outcomeWord(job.status),
			...(detail === undefined ? {} : { detail }),
			elapsed: formatSupabaseElapsed(
				(active ? now : job.updatedAt) - job.startedAt
			),
			tone: active
				? 'info'
				: job.status === 'failed' || job.status === 'lost'
					? 'danger'
					: 'default',
			active,
			...(active && startJob && job.cancellable && job.cancelRequested !== true
				? { cancel: { kind: 'cancel-job', jobId: job.id } }
				: {}),
		};
	});
	const active = state.jobs.filter(isActiveSupabaseJob).length;
	const first = rows.find((row) => row.active);
	return {
		title:
			active > 0
				? `Supabase activity · ${active} running`
				: 'Recent Supabase activity',
		...(first
			? {
					meta: `${first.title} · ${first.label.replace(/…$/, '')} · ${first.elapsed}`,
				}
			: {}),
		active,
		rows,
	};
}

/** How many stacks Clean up suggests: every selectable group's members. */
export function supabaseCleanUpCount(
	state: Pick<SupabaseState, 'prune'>
): number {
	return selectableIds(state.prune).size;
}

/** `2 to decide · 3 suggested`, the Requests view's toolbar meta. */
export function supabaseRequestsMeta(
	cards: readonly Pick<SupabaseRequestCard, 'request'>[],
	state: Pick<SupabaseState, 'prune'>
): string {
	const decide = cards.filter(
		(card) => card.request.status === 'pending'
	).length;
	return `${decide} to decide · ${supabaseCleanUpCount(state)} suggested`;
}

/**
 * Turning off with managed stacks running: `Turning off… stopping 3 managed
 * stacks (1 of 3).`, counting the stack being stopped now.
 */
export function supabaseDisablingText(
	disabling: NonNullable<SupabaseState['feature']['disabling']>
): string {
	if (disabling.waitingForStarts) {
		return 'Turning off… waiting for running starts to finish.';
	}
	const { total, remaining } = disabling;
	const current = Math.min(total, Math.max(1, total - remaining + 1));
	return `Turning off… stopping ${plural(total, 'managed stack')} (${current} of ${total}).`;
}

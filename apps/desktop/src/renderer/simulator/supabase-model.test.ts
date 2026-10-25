import { describe, expect, it } from 'vitest';
import { formatClock } from '@/lib/format';
import {
	applySupabaseDemoOperation,
	createSupabaseDemoState,
	SUPABASE_DEMO_IDS,
	SUPABASE_DEMO_NOW,
} from '../../shared/supabase-demo-data';
import {
	attentionItems,
	type SupabaseAgentRequest,
	type SupabaseDatabasePayload,
	type SupabaseInspection,
	type SupabaseJob,
	type SupabaseLogRecord,
	type SupabaseLogsPayload,
	type SupabaseStackChangeView,
	type SupabaseStackSummary,
	type SupabaseState,
	stackStatus,
} from '../../shared/supabase-protocol';
import {
	buildSupabaseRepositoryRows,
	buildSupabaseRequestCards,
	buildSupabaseRows,
	defaultSupabasePruneSelection,
	defaultSupabaseSectionOpen,
	formatSupabaseElapsed,
	formatSupabaseMoment,
	isSupabasePruneSelectionStale,
	matchesSupabaseSearch,
	mergeSupabaseLogs,
	resolveSupabaseSelection,
	reviewSupabasePruneSelection,
	SUPABASE_FAST_TICK_MS,
	SUPABASE_SLOW_TICK_MS,
	shortSupabaseId,
	supabaseActiveJob,
	supabaseActivityView,
	supabaseAttentionByStack,
	supabaseBackendsForSession,
	supabaseBulkEligibility,
	supabaseCleanUpCount,
	supabaseCleanUpOperation,
	supabaseClockCadence,
	supabaseConfirmationKind,
	supabaseConnectView,
	supabaseCreatedByText,
	supabaseDatabaseView,
	supabaseDetailActions,
	supabaseDetailNotices,
	supabaseDisablingText,
	supabaseDriftNotices,
	supabaseFilterOptions,
	supabaseHeaderMeta,
	supabaseHolderChain,
	supabaseInlineConfirmCopy,
	supabaseLogMarkerText,
	supabaseLogServices,
	supabaseLogsOperation,
	supabaseLogsRefreshOperation,
	supabaseLogView,
	supabaseMetrics,
	supabaseNoticeList,
	supabaseOpenSections,
	supabaseOverviewLine,
	supabasePruneGroups,
	supabasePruneSummary,
	supabaseRepositoryFilterOptions,
	supabaseRepositoryWorktrees,
	supabaseRequestsMeta,
	supabaseRowMatchesFilter,
	supabaseSelectionAfterRemoval,
	supabaseServicesView,
	supabaseStackControl,
	supabaseStackCounts,
	supabaseStackDeadlines,
	supabaseStackFacts,
	supabaseStackForLane,
	supabaseStackHeading,
	supabaseStateClock,
	supabaseStepList,
	supabaseTabState,
	supabaseVisibleRepositoryRows,
	supabaseVisibleRows,
	toggleSupabasePruneStack,
} from './supabase-model';

const ids = SUPABASE_DEMO_IDS;
const now = SUPABASE_DEMO_NOW;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MB = 1_024 * 1_024;
const SECRET_SHAPES = [
	/sb_secret_/,
	/sb_publishable_/,
	/eyJ/,
	/postgres(?:ql)?:\/\//,
	/SERVICE_ROLE/,
];

function demo(): SupabaseState {
	return createSupabaseDemoState();
}

function stackIn(state: SupabaseState, id: string): SupabaseStackSummary {
	const stack = state.stacks.find((candidate) => candidate.id === id);
	if (!stack) throw new Error(`No demo stack ${id}`);
	return stack;
}

function withStack(
	state: SupabaseState,
	id: string,
	overrides: Partial<SupabaseStackSummary>
): SupabaseState {
	return {
		...state,
		stacks: state.stacks.map((stack) =>
			stack.id === id ? { ...stack, ...overrides } : stack
		),
	};
}

function job(overrides: Partial<SupabaseJob> = {}): SupabaseJob {
	return {
		id: 'supabase-job-00000000-0000-4000-8000-000000000001',
		kind: 'create',
		stackIds: [ids.featOnboarding],
		status: 'running',
		startedAt: now - 18_000,
		updatedAt: now - 1_000,
		cancellable: true,
		requestedBy: { kind: 'operator' },
		...overrides,
	};
}

let action = 0;
function demoReceipt(state: SupabaseState, fields: Record<string, unknown>) {
	action += 1;
	return applySupabaseDemoOperation(
		state,
		{ actionId: `model-${action}`, ...fields } as Parameters<
			typeof applySupabaseDemoOperation
		>[1],
		now
	).receipt;
}

describe('supabaseTabState', () => {
	const ready = demo();
	it.each([
		['bridge-missing', ready, { bridgeAvailable: false, isLoading: false }],
		['loading', ready, { bridgeAvailable: true, isLoading: true }],
		[
			'unsupported',
			createSupabaseDemoState({ variant: 'unsupported' }),
			{ bridgeAvailable: true, isLoading: false },
		],
		[
			'off',
			createSupabaseDemoState({ variant: 'off' }),
			{ bridgeAvailable: true, isLoading: false },
		],
		[
			'empty',
			createSupabaseDemoState({ variant: 'empty' }),
			{ bridgeAvailable: true, isLoading: false },
		],
		['ready', ready, { bridgeAvailable: true, isLoading: false }],
	] as const)('reads %s', (expected, state, context) => {
		expect(supabaseTabState(state, context)).toBe(expected);
	});

	it('counts a tab with only transient stacks as empty', () => {
		const state = createSupabaseDemoState({ variant: 'empty' });
		const transient = {
			...stackIn(demo(), ids.main),
			flags: ['transient' as const],
		};
		expect(
			supabaseTabState(
				{ ...state, stacks: [transient] },
				{ bridgeAvailable: true, isLoading: false }
			)
		).toBe('empty');
	});
});

describe('header meta and metrics', () => {
	it('reads demo set A as 3 running, 4 stopped, 1 starting', () => {
		const state = demo();
		expect(supabaseStackCounts(state)).toEqual({
			running: 3,
			stopped: 4,
			starting: 1,
		});
		expect(supabaseHeaderMeta(state, 'ready')).toBe(
			'3 running · 4 stopped · 1 starting'
		);
		expect(supabaseHeaderMeta(state, 'off')).toBe('Off');
		expect(supabaseHeaderMeta(state, 'unsupported')).toBe(
			'Not available on this Mac'
		);
		expect(
			supabaseHeaderMeta(createSupabaseDemoState({ variant: 'empty' }), 'empty')
		).toBe('No stacks');
	});

	it('shows the four demo metrics with their details', () => {
		const metrics = supabaseMetrics(demo(), 'ready', now);
		expect(
			metrics.map((metric) => [metric.label, metric.value, metric.detail])
		).toEqual([
			['Running', '3 / 12', '1 starting'],
			['Postgres slots', '6 / 32', '26 free'],
			['Memory', '1.2 GB', 'RSS · measured 5 s ago'],
			['Disk', '2.1 GB', '1.7 GB is shared cache'],
		]);
		expect(metrics.every((metric) => metric.tone === 'default')).toBe(true);
	});

	it('keeps the grid with dashes while off or unsupported', () => {
		const off = supabaseMetrics(demo(), 'off', now);
		expect(off.map((metric) => [metric.value, metric.detail])).toEqual([
			['—', 'off'],
			['—', 'checked when on'],
			['—', 'checked when on'],
			['—', 'checked when on'],
		]);
		expect(
			supabaseMetrics(demo(), 'unsupported', now).every(
				(metric) => metric.value === '—' && metric.detail === 'not available'
			)
		).toBe(true);
	});

	it('warns at the cap, under four free slots, and on critical memory', () => {
		const base = demo();
		const full: SupabaseState = {
			...base,
			capacity: {
				...base.capacity,
				running: 12,
				starting: 0,
				sysv: { used: 30, limit: 32 },
				memoryPressure: 'critical',
				nextToStopId: ids.featPayments,
			},
			footprint: { ...base.footprint, mode: 'estimate' },
		};
		const metrics = supabaseMetrics(full, 'ready', now);
		expect(metrics.map((metric) => metric.tone)).toEqual([
			'warning',
			'warning',
			'warning',
			'default',
		]);
		expect(metrics[0]?.detail).toBe('next to stop: feat-payments');
		expect(metrics[2]?.value).toBe('≈ 1.2 GB');
		expect(metrics[2]?.detail).toBe('estimate');
		const { nextToStopId: _next, ...capacity } = full.capacity;
		expect(
			supabaseMetrics({ ...full, capacity }, 'ready', now)[0]?.detail
		).toBe('all held');
	});
});

describe('notices', () => {
	it('caps tab notices at two with a +N toggle, and never lists suggestions', () => {
		const items = attentionItems(demo(), now);
		const collapsed = supabaseNoticeList(items, false);
		expect(collapsed.visible.map((item) => item.kind)).toEqual([
			'lan-exposed',
			'request',
		]);
		expect(collapsed.overflow).toBe(1);
		expect(collapsed.toggleLabel).toBe('+1 more notice');
		const expanded = supabaseNoticeList(items, true);
		expect(expanded.visible.map((item) => item.kind)).toEqual([
			'lan-exposed',
			'request',
			'stacks-need-attention',
		]);
		expect(expanded.toggleLabel).toBe('Show fewer notices');
		expect(
			supabaseNoticeList(items.slice(0, 2), false).toggleLabel
		).toBeUndefined();
	});

	it('ranks each stack by its strongest notice', () => {
		const ranks = supabaseAttentionByStack(attentionItems(demo(), now));
		expect(Object.fromEntries(ranks)).toEqual({
			[ids.legacyMain]: 'danger',
			[ids.featOldUi]: 'request',
			[ids.unreadable]: 'warning',
		});
	});
});

describe('buildSupabaseRows', () => {
	it('ranks demo set A: attention, in flight, lane, held, prune, not created', () => {
		const rows = buildSupabaseRows(demo(), now);
		expect(rows.map((row) => [row.title, row.group])).toEqual([
			['legacy-main', 'attention'],
			['feat-old-ui', 'attention'],
			['c41d0e77…', 'attention'],
			['fix-auth-redirect', 'in-flight'],
			['feat-checkout', 'running-lane'],
			['feat-payments', 'running-held'],
			['main', 'running-held'],
			['feat-gone', 'prune'],
			['feat-search', 'prune'],
			['feat-onboarding', 'not-created'],
		]);
	});

	it('writes line 2 with the state, flags, labelled ports and size', () => {
		const rows = new Map(
			buildSupabaseRows(demo(), now).map((row) => [row.id, row])
		);
		expect(rows.get(ids.featCheckout)?.line2).toBe(
			'Running · idle · lane :8102 · API :21734 · 64 MB'
		);
		expect(rows.get(ids.fixAuthRedirect)?.line2).toBe(
			'Starting… 2 s · lane :8106 · API :23310 · 58 MB'
		);
		expect(rows.get(ids.legacyMain)?.line2).toBe(
			'LAN-exposed · Docker · stopped · 88 MB'
		);
		expect(rows.get(ids.featOldUi)?.line2).toBe(
			'Stopped · Stale branch · 71 MB'
		);
		expect(rows.get(ids.featSearch)?.line2).toBe(
			'Stopped 16 d · prune suggested · 44 MB'
		);
		expect(rows.get(ids.featOnboarding)?.line2).toBe(
			'Not created · managed worktree'
		);
		expect(rows.get(ids.featCheckout)?.parts[0]).toEqual({
			text: 'Running · idle',
			tone: 'success',
		});
	});

	it('badges the holder: an agent, else Pinned, else External', () => {
		const rows = new Map(
			buildSupabaseRows(demo(), now).map((row) => [row.id, row])
		);
		expect(rows.get(ids.featCheckout)?.holder).toMatchObject({
			kind: 'agent',
			label: 'Claude 7f3a2c91',
		});
		expect(rows.get(ids.featPayments)?.holder?.label).toBe(
			'Codex · by worktree'
		);
		expect(rows.get(ids.main)?.holder).toEqual({
			kind: 'pinned',
			label: 'Pinned',
		});
		expect(rows.get(ids.legacyMain)?.holder?.label).toBe('External');
		expect(rows.get(ids.featOldUi)?.holder).toBeUndefined();
		expect(rows.get(ids.featCheckout)?.textValue).toContain(':8102');
	});

	it('orders unheld running stacks by the soonest automatic stop', () => {
		const base = demo();
		const unheld = (id: string, autoStopAt: number) =>
			({
				...stackIn(base, id),
				holds: [],
				pinned: false,
				lanes: [],
				autoStopAt,
				autoStopReason: 'released',
			}) satisfies SupabaseStackSummary;
		const state: SupabaseState = {
			...base,
			stacks: [
				unheld(ids.main, now + 50_000),
				unheld(ids.featPayments, now + 20_000),
			],
		};
		expect(buildSupabaseRows(state, now).map((row) => row.title)).toEqual([
			'feat-payments',
			'main',
		]);
	});
});

describe('search, filters and selection', () => {
	const rows = buildSupabaseRows(demo(), now);
	const titles = (list: readonly { title: string }[]) =>
		list.map((row) => row.title);

	it('matches branches, :port prefixes, agents and several terms', () => {
		expect(
			titles(supabaseVisibleRows(rows, { filter: 'all', query: ':8102' }))
		).toEqual(['feat-checkout']);
		expect(
			titles(supabaseVisibleRows(rows, { filter: 'all', query: ':2173' }))
		).toEqual(['feat-checkout']);
		expect(
			titles(supabaseVisibleRows(rows, { filter: 'all', query: 'claude' }))
		).toEqual(['feat-checkout']);
		expect(
			titles(supabaseVisibleRows(rows, { filter: 'all', query: 'codex' }))
		).toEqual(['feat-checkout', 'feat-payments']);
		expect(
			titles(supabaseVisibleRows(rows, { filter: 'all', query: 'feat old' }))
		).toEqual(['feat-old-ui']);
		expect(
			supabaseVisibleRows(rows, { filter: 'all', query: '  ' })
		).toHaveLength(10);
		const [first] = rows;
		expect(first && matchesSupabaseSearch(first, ':9')).toBe(false);
	});

	it('counts every filter, as the select labels them', () => {
		expect(
			supabaseFilterOptions(rows).map((option) => [option.label, option.count])
		).toEqual([
			['All stacks', 10],
			['Running', 4],
			['Stopped', 4],
			['Not created', 1],
			['Held by agents', 2],
			['Unused', 5],
			['Needs attention', 3],
			['External', 2],
			['Transient', 0],
		]);
	});

	it('shows transient stacks only under the Transient filter', () => {
		const state = withStack(demo(), ids.featSearch, {
			flags: ['transient'],
		});
		const transientRows = buildSupabaseRows(state, now);
		const shadow = transientRows.find((row) => row.id === ids.featSearch);
		expect(shadow?.transient).toBe(true);
		expect(shadow && supabaseRowMatchesFilter(shadow, 'all')).toBe(false);
		expect(shadow && supabaseRowMatchesFilter(shadow, 'transient')).toBe(true);
		expect(
			titles(
				supabaseVisibleRows(transientRows, { filter: 'transient', query: '' })
			)
		).toEqual(['feat-search']);
	});

	it('keeps a listed selection and falls back to the first row', () => {
		expect(resolveSupabaseSelection(rows, ids.main)).toBe(ids.main);
		expect(resolveSupabaseSelection(rows, 'gone')).toBe(ids.legacyMain);
		expect(resolveSupabaseSelection([], ids.main)).toBeNull();
	});

	it('moves the selection to the next row after a destroy', () => {
		const previous = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
		expect(
			supabaseSelectionAfterRemoval(previous, 'b', [{ id: 'a' }, { id: 'c' }])
		).toBe('c');
		expect(
			supabaseSelectionAfterRemoval(previous, 'c', [{ id: 'a' }, { id: 'b' }])
		).toBe('b');
		expect(supabaseSelectionAfterRemoval(previous, 'a', previous)).toBe('a');
		expect(supabaseSelectionAfterRemoval(previous, 'b', [])).toBeNull();
	});
});

describe('stack detail', () => {
	const state = demo();

	it('heads the detail with the branch, worktree, short id and origin', () => {
		expect(supabaseStackHeading(stackIn(state, ids.featCheckout))).toEqual({
			eyebrow: 'Supabase stack',
			title: 'feat-checkout',
			subtitle: '~/code/example-app-wt/feat-checkout · 64616c83…145f',
			origin: 'Managed',
		});
		expect(
			supabaseStackHeading(stackIn(state, ids.featOnboarding)).origin
		).toBe('Not created');
		expect(supabaseStackHeading(stackIn(state, ids.legacyMain)).origin).toBe(
			'External'
		);
		expect(shortSupabaseId(ids.featCheckout)).toBe('64616c83…145f');
	});

	it('opens Overview always, Services and Connect while running', () => {
		const running = stackIn(state, ids.featCheckout);
		const stopped = stackIn(state, ids.featOldUi);
		expect(supabaseOpenSections(running)).toEqual([
			'overview',
			'services',
			'connect',
		]);
		expect(supabaseOpenSections(stopped)).toEqual(['overview']);
		expect(defaultSupabaseSectionOpen(running, 'database')).toBe(false);
		expect(
			supabaseOpenSections(running, { services: false, logs: true })
		).toEqual(['overview', 'logs', 'connect']);
	});

	it('picks the native dialog, an inline confirm, or neither', () => {
		expect(
			supabaseConfirmationKind(
				{ kind: 'destroy', stackIds: [ids.featOldUi], removeUploads: false },
				state
			)
		).toEqual({ kind: 'native' });
		expect(
			supabaseConfirmationKind(
				{ kind: 'stop', stackIds: [ids.featCheckout] },
				state
			)
		).toEqual({ kind: 'inline', agents: ['Claude 7f3a2c91'] });
		expect(
			supabaseConfirmationKind({ kind: 'stop', stackIds: [ids.main] }, state)
		).toEqual({ kind: 'none' });
	});

	it('offers at most four state-dependent actions with visible reasons', () => {
		const context = { bridgeAvailable: true, now };
		const labels = (id: string) =>
			supabaseDetailActions(stackIn(state, id), state, context).map(
				(entry) => entry.label
			);
		expect(labels(ids.featCheckout)).toEqual([
			'Stop',
			'Restart services',
			'Keep running',
			'Open lane',
		]);
		expect(labels(ids.main)).toEqual(['Stop', 'Restart services', 'Unpin']);
		expect(labels(ids.fixAuthRedirect)).toEqual(['Cancel start…', 'Open lane']);
		expect(labels(ids.featOnboarding)).toEqual(['Start']);
		expect(labels(ids.legacyMain)).toEqual([]);
		expect(labels(ids.unreadable)).toEqual([]);
		const [resume] = supabaseDetailActions(
			stackIn(state, ids.featOldUi),
			state,
			context
		);
		expect(resume).toMatchObject({
			id: 'resume',
			operation: { kind: 'start', stackId: ids.featOldUi },
			availability: {
				allowed: false,
				check: 'head',
				reason:
					"The worktree is on feat-nav-v2. Starting this stack would load feat-nav-v2's settings. Switch back to feat-old-ui first.",
			},
		});
		const [stop] = supabaseDetailActions(
			stackIn(state, ids.featCheckout),
			state,
			context
		);
		expect(stop?.confirmation).toEqual({
			kind: 'inline',
			agents: ['Claude 7f3a2c91'],
		});
		const [cancel] = supabaseDetailActions(
			stackIn(state, ids.fixAuthRedirect),
			state,
			context
		);
		expect(cancel?.operation).toEqual({
			kind: 'cancel-job',
			jobId: ids.jobFixAuth,
		});
		const offline = supabaseDetailActions(
			stackIn(state, ids.featCheckout),
			state,
			{ bridgeAvailable: false, now }
		);
		expect(offline[0]?.availability).toMatchObject({ check: 'bridge' });
	});

	it('names the stack admission would stop on a full Mac', () => {
		const base = demo();
		const full: SupabaseState = {
			...base,
			capacity: {
				...base.capacity,
				running: 12,
				nextToStopId: ids.featPayments,
			},
		};
		const withUse = withStack(full, ids.featPayments, {
			lastUsedAt: now - 2 * HOUR,
		});
		const [start] = supabaseDetailActions(
			stackIn(withUse, ids.featOnboarding),
			withUse,
			{ bridgeAvailable: true, now }
		);
		expect(start?.label).toBe('Start (stops feat-payments, idle 2 h)');
	});
});

describe('supabaseBulkEligibility', () => {
	const state = demo();
	const context = { bridgeAvailable: true, now };

	it('counts eligible stacks only and says what each action skips', () => {
		const result = supabaseBulkEligibility(
			state,
			[ids.featCheckout, ids.featPayments, ids.main, ids.featOldUi],
			context
		);
		expect(result.stop).toMatchObject({
			label: 'Stop 3',
			stackIds: [ids.featCheckout, ids.featPayments, ids.main],
			availability: { allowed: true },
		});
		expect(result.destroy).toMatchObject({
			label: 'Destroy 1…',
			stackIds: [ids.featOldUi],
			availability: { allowed: true },
		});
		expect(result.summary).toBe(
			'4 selected · Stop skips 1 stopped · Destroy skips 3 running'
		);
	});

	it('refuses with the visible reason when nothing is eligible', () => {
		expect(
			supabaseBulkEligibility(state, [ids.featOldUi, ids.featSearch], context)
				.stop.availability
		).toMatchObject({ reason: 'None of the selected stacks is running.' });
		expect(
			supabaseBulkEligibility(state, [ids.featCheckout, ids.main], context)
				.destroy.availability
		).toMatchObject({
			reason: 'Destroy runs only on stopped stacks; 2 selected are running.',
		});
		const external = withStack(state, ids.legacyMain, {
			state: 'running',
			runtime: 'native',
			exposure: { verdict: 'loopback' },
			flags: [],
			ownerLiveness: 'reachable',
			lifecycle: 'running',
		});
		expect(
			supabaseBulkEligibility(external, [ids.legacyMain], context).stop
				.availability
		).toMatchObject({
			reason: 'External stacks are stopped one at a time from their detail.',
		});
	});
});

describe('who holds this', () => {
	const state = demo();

	it('chains agent, lane, Simulator, worktree and stack, with Open-in targets', () => {
		const chain = supabaseHolderChain(stackIn(state, ids.featCheckout), now);
		expect(
			chain.links.map((link) => [link.kind, link.label, link.tone])
		).toEqual([
			['agent', 'Claude 7f3a2c91 · live · via lane :8102', 'success'],
			['lane', 'Lane :8102 · Metro ready', 'success'],
			['simulator', 'iPhone 17 Pro', 'default'],
			[
				'worktree',
				'feat-checkout · ~/code/example-app-wt/feat-checkout · HEAD matches',
				'default',
			],
			['stack', 'This stack · API :21734', 'success'],
		]);
		expect(chain.links[1]?.open).toEqual({
			text: 'Open lane',
			label: 'Open lane feat-checkout :8102 in Lanes',
			target: { kind: 'lane', laneId: ids.laneCheckout },
		});
		expect(chain.links[0]?.open?.target).toEqual({
			kind: 'agents',
			agent: {
				kind: 'claude',
				sessionId: ids.claudeCheckout,
				synthetic: false,
			},
		});
		expect(chain.others).toHaveLength(1);
		expect(chain.others[0]?.label).toMatch(
			/^Codex 5d1b8f40 · gone 3 min · hold ends \d{2}:\d{2}$/
		);
		expect(chain.others[0]?.release).toEqual({
			holder: 'session',
			agentKind: 'codex',
			sessionId: ids.codexAbandoned,
		});
	});

	it('reads pinned, worktree-held and operator lanes the way the copy deck does', () => {
		expect(
			supabaseHolderChain(stackIn(state, ids.main), now).links[0]?.label
		).toBe('You · pinned · never stopped automatically');
		expect(
			supabaseHolderChain(stackIn(state, ids.featPayments), now).links[0]?.label
		).toBe('Codex · by worktree');
		const lane = supabaseHolderChain(stackIn(state, ids.fixAuthRedirect), now);
		expect(lane.links.map((link) => link.label).slice(0, 3)).toEqual([
			'You · lane :8106',
			'Lane :8106 · Metro starting',
			'iPhone 17',
		]);
		const moved = supabaseHolderChain(stackIn(state, ids.featOldUi), now);
		expect(moved.links.find((link) => link.kind === 'worktree')).toMatchObject({
			label: 'feat-old-ui · ~/code/example-app-wt/old-ui · HEAD on feat-nav-v2',
			tone: 'warning',
		});
		const gone = supabaseHolderChain(stackIn(state, ids.featGone), now);
		expect(gone.links.find((link) => link.kind === 'worktree')?.tone).toBe(
			'danger'
		);
	});

	it('says who created a stack and when', () => {
		const checkout = stackIn(state, ids.featCheckout);
		expect(supabaseCreatedByText(checkout, now)).toBe(
			`lane up · Claude 7f3a2c91 · ${formatSupabaseMoment(now - 2 * HOUR, now)}`
		);
		expect(
			supabaseCreatedByText(stackIn(state, ids.main), now).startsWith(
				'You (Supabase tab) · '
			)
		).toBe(true);
		expect(supabaseCreatedByText(stackIn(state, ids.legacyMain), now)).toBe(
			'Outside RN Devtools'
		);
	});

	it('formats moments relative to today', () => {
		const noon = new Date(2026, 9, 17, 12, 0).getTime();
		expect(formatSupabaseMoment(noon - HOUR, noon)).toMatch(/^today 11:00$/);
		expect(formatSupabaseMoment(noon - 24 * HOUR, noon)).toMatch(
			/^yesterday 12:00$/
		);
		expect(formatSupabaseMoment(noon - 5 * 24 * HOUR, noon)).not.toMatch(
			/today|yesterday/
		);
	});
});

describe('cross-panel joins', () => {
	const state = demo();

	it('finds the stack a lane is attached to', () => {
		expect(supabaseStackForLane(state, ids.laneCheckout)?.id).toBe(
			ids.featCheckout
		);
		expect(supabaseStackForLane(state, 'lane-none')).toBeUndefined();
	});

	it('lists the backends a session holds, and which it may release', () => {
		expect(
			supabaseBackendsForSession(state, {
				kind: 'claude',
				sessionId: ids.claudeCheckout,
			}).map((backend) => [backend.stack.id, backend.via, backend.live])
		).toEqual([[ids.featCheckout, 'lane', true]]);
		expect(
			supabaseBackendsForSession(state, {
				kind: 'codex',
				sessionId: ids.codexAbandoned,
			})
		).toEqual([
			{
				stack: stackIn(state, ids.featCheckout),
				via: 'session',
				live: false,
				release: {
					holder: 'session',
					agentKind: 'codex',
					sessionId: ids.codexAbandoned,
				},
			},
		]);
		const kept = withStack(state, ids.featSearch, {
			cwdKeepers: [
				{ agent: { kind: 'claude', sessionId: 'abc12345', synthetic: false } },
			],
		});
		expect(
			supabaseBackendsForSession(kept, {
				kind: 'claude',
				sessionId: 'abc12345',
			}).map((backend) => backend.via)
		).toEqual(['cwd']);
	});
});

describe('repositories', () => {
	const state = demo();
	const rows = buildSupabaseRepositoryRows(state);

	it('gives each repository a readiness word and a second line', () => {
		expect(
			rows.map((row) => [row.title, row.readiness.label, row.line2])
		).toEqual([
			['~/code/example-app', '2 fixes', '9 worktrees · 7 managed · 3 running'],
			['~/code/example-admin', 'Observed', 'CLI 2.122.0 not verified'],
			['~/code/example-site', 'No Supabase', 'No supabase/config.toml'],
		]);
		expect(rows[0]?.readiness.tone).toBe('warning');
	});

	it('filters and searches repositories, worktree branches included', () => {
		expect(
			supabaseRepositoryFilterOptions(rows).map((option) => [
				option.id,
				option.count,
			])
		).toEqual([
			['all', 3],
			['needs-fix', 1],
			['ready', 0],
			['observed', 1],
			['no-supabase', 1],
		]);
		expect(
			supabaseVisibleRepositoryRows(rows, {
				filter: 'all',
				query: 'spike-maps',
			}).map((row) => row.title)
		).toEqual(['~/code/example-app']);
		expect(
			supabaseVisibleRepositoryRows(rows, { filter: 'observed', query: '' })
		).toHaveLength(1);
	});

	it('links worktrees to their stacks', () => {
		const app = state.repositories[0];
		if (!app) throw new Error('No demo repository');
		const worktrees = supabaseRepositoryWorktrees(app, state);
		expect(worktrees[0]).toEqual({
			pathLabel: '~/code/example-app',
			branch: 'main',
			mode: 'managed',
			text: 'main · managed · running · idle :22990',
			stackId: ids.main,
		});
		expect(
			worktrees.find((worktree) => worktree.branch === 'spike-maps')
		).toMatchObject({ text: 'spike-maps · observed · ports pinned' });
	});
});

describe('buildSupabaseRequestCards', () => {
	const state = demo();
	const context = { bridgeAvailable: true };

	it('turns the demo destroy request into a card with facts and the note', () => {
		const [card] = buildSupabaseRequestCards(state, now, context);
		expect(card).toMatchObject({
			id: ids.requestOldUi,
			tone: 'warning',
			title:
				'Codex session 3c9e7a12 (live) asks to destroy feat-old-ui (71 MB)',
			age: '4 min ago',
			facts: 'Stopped · no lane attached · nothing else holds it.',
			note: 'Fresh database for the migration test.',
			approve: {
				label: 'Review and destroy…',
				availability: { allowed: true },
			},
			deny: { label: 'Deny', availability: { allowed: true } },
		});
	});

	it('hides expired requests and shows settling ones with progress', () => {
		expect(buildSupabaseRequestCards(state, now + HOUR, context)).toEqual([]);
		const settling: SupabaseState = {
			...state,
			requests: state.requests.map((request) => ({
				...request,
				status: 'settling' as const,
			})),
		};
		const [card] = buildSupabaseRequestCards(settling, now, context);
		expect(card?.progress).toBe('Destroying feat-old-ui…');
		expect(card?.approve.availability).toMatchObject({
			allowed: false,
			reason: 'This request is already being settled.',
		});
	});

	it('lets a capacity request name the stack to stop', () => {
		const capacity: SupabaseAgentRequest = {
			id: 'supabase-request-00000000-0000-4000-8000-000000000002',
			kind: 'start-capacity',
			status: 'pending',
			requester: {
				kind: 'claude',
				sessionId: '9b1e2c00-0000-4000-8000-000000000003',
				live: true,
				synthetic: false,
			},
			branch: 'feat-tags',
			createdAt: now - MINUTE,
			expiresAt: now + 29 * MINUTE,
			otherHolders: [],
			capacity: {
				running: 12,
				cap: 12,
				candidates: [
					{
						stackId: ids.featSearch,
						branch: 'feat-search',
						holderLabel: 'Codex 77c0d2aa',
						idleSinceAt: now - 2 * HOUR,
						liveHolder: true,
					},
				],
			},
		};
		const next = { ...state, requests: [capacity] };
		const [unchosen] = buildSupabaseRequestCards(next, now, context);
		expect(unchosen).toMatchObject({
			title:
				'Claude session 9b1e2c00 (live) needs a database for feat-tags; 12 of 12 run, all in use',
			approve: {
				label: 'Stop one and start feat-tags',
				availability: { allowed: false, reason: 'Choose a stack to stop.' },
			},
			deny: { label: 'Dismiss' },
			candidates: [
				{
					stackId: ids.featSearch,
					label: 'feat-search · Codex 77c0d2aa · idle 2 h',
					liveHolder: true,
				},
			],
		});
		const [chosen] = buildSupabaseRequestCards(next, now, {
			...context,
			stopStackIds: { [capacity.id]: ids.featSearch },
		});
		expect(chosen?.approve).toEqual({
			label: 'Stop feat-search and start feat-tags',
			availability: { allowed: true },
		});
	});
});

describe('clean up', () => {
	const state = demo();

	it('preselects worktree-deleted stacks and never selects unreadable ones', () => {
		const selection = defaultSupabasePruneSelection(state.prune);
		expect(selection).toEqual({
			revision: state.prune.revision,
			stackIds: [ids.featGone],
		});
		const groups = supabasePruneGroups(state, selection);
		expect(
			groups.map((group) => [group.label, group.selectable, group.selected])
		).toEqual([
			['Worktree deleted', true, 'all'],
			['Stale branch', true, 'none'],
			['Stopped longer than 14 days', true, 'none'],
			['Unreadable', false, 'none'],
		]);
		expect(
			toggleSupabasePruneStack(selection, state.prune, ids.unreadable)
		).toEqual(selection);
	});

	it('toggles stacks, and summarises the trigger', () => {
		let selection = defaultSupabasePruneSelection(state.prune);
		selection = toggleSupabasePruneStack(
			selection,
			state.prune,
			ids.featSearch
		);
		selection = toggleSupabasePruneStack(selection, state.prune, ids.featOldUi);
		expect(selection.stackIds).toEqual([
			ids.featGone,
			ids.featSearch,
			ids.featOldUi,
		]);
		const summary = supabasePruneSummary(state, selection, {
			bridgeAvailable: true,
		});
		expect(summary).toMatchObject({
			triggerLabel: 'Destroy 3 stacks (179 MB)…',
			statusLine: '3 stacks selected · a system dialog confirms',
			availability: { allowed: true },
			suggested: '179 MB',
			notSuggested:
				'Not suggested: 2 held, 1 pinned, 1 starting, 1 external. Never automatic.',
		});
		expect(summary.lastResult).toMatch(
			/^Last clean up destroyed 2 stacks and freed 120 MB · /
		);
		selection = toggleSupabasePruneStack(selection, state.prune, ids.featOldUi);
		expect(selection.stackIds).toEqual([ids.featGone, ids.featSearch]);
		expect(supabaseCleanUpOperation(selection)).toEqual({
			kind: 'destroy',
			stackIds: [ids.featGone, ids.featSearch],
			removeUploads: false,
			pruneRevision: state.prune.revision,
		});
	});

	it('refuses a selection made on an older revision until it is reviewed', () => {
		const stale = {
			revision: state.prune.revision - 1,
			stackIds: [ids.featGone],
		};
		expect(isSupabasePruneSelectionStale(stale, state.prune)).toBe(true);
		expect(
			supabasePruneSummary(state, stale, { bridgeAvailable: true }).availability
		).toEqual({
			allowed: false,
			reason: 'The list changed. Review the selection again.',
			check: 'state',
		});
		const reviewed = reviewSupabasePruneSelection(
			{ ...stale, stackIds: [ids.featGone, ids.unreadable, 'f'.repeat(64)] },
			state.prune
		);
		expect(reviewed).toEqual({
			revision: state.prune.revision,
			stackIds: [ids.featGone],
		});
		expect(
			supabasePruneSummary(
				state,
				{ revision: 3, stackIds: [] },
				{
					bridgeAvailable: true,
				}
			).availability
		).toMatchObject({ reason: 'Select at least one stack.' });
	});
});

describe('supabaseStepList', () => {
	it('maps the demo job onto Timeline statuses with the current step', () => {
		const state = demo();
		const running = state.jobs[0];
		if (!running) throw new Error('No demo job');
		const view = supabaseStepList(running, now, 'fix-auth-redirect');
		expect(view.steps.map((step) => [step.status, step.current])).toEqual([
			['success', false],
			['current', true],
			['muted', false],
			['muted', false],
		]);
		expect(view.headline).toBe('Starting fix-auth-redirect · 2 s');
		expect(view.expected).toBe('about 5 s');
		expect(view.currentLabel).toBe('Start the database');
		expect(view.failed).toBe(false);
	});

	it('marks the current step failed when a job fails without saying where', () => {
		const failed = job({
			status: 'failed',
			updatedAt: now - 2_000,
			coldCache: true,
			migration: { done: 0, total: 3 },
			steps: [
				{ id: 'room', label: 'Check room', state: 'done' },
				{ id: 'migrate', label: 'Apply migrations', state: 'current' },
				{ id: 'seed', label: 'Seed data', state: 'skipped' },
			],
		});
		const view = supabaseStepList(failed, now, 'feat-onboarding');
		expect(view.steps.map((step) => [step.status, step.detail])).toEqual([
			['success', undefined],
			['danger', '0 of 3'],
			['muted', 'skipped'],
		]);
		expect(view.failed).toBe(true);
		expect(view.headline).toBe('Starting feat-onboarding · 16 s');
		expect(view.coldCacheNote).toContain('downloads services once');
		expect(supabaseStepList(job({ status: 'queued' }), now).headline).toBe(
			'Queued · new stacks start one at a time'
		);
	});
});

describe('supabaseLogView', () => {
	const state = demo();
	const receipt = demoReceipt(state, {
		kind: 'read-logs',
		stackId: ids.featCheckout,
		tail: 200,
	});
	const logs = receipt.logs as SupabaseLogsPayload;

	it('renders markers and redacted entries, and summarises the read', () => {
		const view = supabaseLogView(logs);
		expect(view.total).toBe(7);
		expect(view.lines).toHaveLength(9);
		expect(view.lines[0]?.text).toBe('--- launch · rest ---');
		expect(view.lines.find((line) => line.text.includes('lost'))?.text).toBe(
			'--- 3 stdout lines lost · rest ---'
		);
		const entry = view.lines.find((line) => line.kind === 'entry');
		expect(
			entry?.text.endsWith(
				'database  LOG: database system is ready to accept connections'
			)
		).toBe(true);
		expect(view.summary).toBe(
			`Redacted · 7 lines · ${logs.bytes} B of 64 KB · read ${formatClock(logs.readAt)}`
		);
		expect(view.visibleText.split('\n')).toHaveLength(9);
		expect(view.services).toEqual(['rest', 'database', 'gateway', 'auth']);
	});

	it('filters by text with match ranges, and by service', () => {
		const matching = supabaseLogView(logs, { query: 'NOTES' });
		expect(matching.matchCount).toBe(4);
		expect(matching.lines.every((line) => line.kind === 'entry')).toBe(true);
		for (const line of matching.lines) {
			const [start, end] = line.matches[0] ?? [0, 0];
			expect(line.text.slice(start, end).toLowerCase()).toBe('notes');
		}
		const gateway = supabaseLogView(logs, { service: 'gateway' });
		expect(gateway.lines.map((line) => line.service)).toEqual([
			'gateway',
			'gateway',
			'gateway',
		]);
		expect(supabaseLogView(logs, { service: 'all' }).lines).toHaveLength(9);
	});

	it('words markers the way the copy deck does', () => {
		const marker = {
			type: 'marker' as const,
			timestamp: '2026-10-17T14:02:00Z',
			source: 'history' as const,
			service: 'rest',
			instanceId: 'abc',
			kind: 'launch' as const,
			count: 2,
		};
		expect(supabaseLogMarkerText(marker, false)).toBe('--- launch 2 ---');
		expect(supabaseLogMarkerText(marker, true)).toBe('--- launch 2 · rest ---');
		expect(
			supabaseLogMarkerText(
				{ ...marker, kind: 'lost', stream: 'stderr', count: 1 },
				false
			)
		).toBe('--- 1 stderr line lost ---');
	});
});

describe('supabaseDatabaseView', () => {
	const state = demo();
	const payload = demoReceipt(state, {
		kind: 'read-database',
		stackId: ids.featCheckout,
	}).database as SupabaseDatabasePayload;

	it('summarises stats, tables and migrations with their statuses', () => {
		const view = supabaseDatabaseView(payload);
		expect(view.summary).toBe(
			'Size 11 MB · index hit 99.8% · table hit 99.1% · WAL 16 MB'
		);
		expect(view.tables[0]).toEqual({
			name: 'public.notes',
			rows: `~${new Intl.NumberFormat(undefined).format(1_000)} rows`,
			size: '2.3 MB',
		});
		expect(view.targetNote).toBeUndefined();
		const migrations = view.migrations;
		expect(migrations?.comparable).toBe(true);
		if (migrations?.comparable) {
			expect(migrations.summary).toMatch(
				/^Migrations · \d+ applied · \d+ pending$/
			);
			expect(
				migrations.rows.find((row) => row.status === 'pending')
			).toMatchObject({ statusLabel: 'pending', tone: 'warning' });
		}
	});

	it('explains reads through the held address and migrations it cannot compare', () => {
		const moved: SupabaseDatabasePayload = {
			target: 'db-url',
			topTables: [],
			migrations: {
				comparable: false,
				reasonText: 'The worktree is on feat-nav-v2.',
			},
			readAt: now,
		};
		const view = supabaseDatabaseView(moved);
		expect(view.targetNote).toContain('another branch');
		expect(view.summary).toBe('No statistics yet');
		expect(view.migrations).toEqual({
			comparable: false,
			reasonText: 'The worktree is on feat-nav-v2.',
		});
		expect(
			supabaseDatabaseView({
				...moved,
				migrations: {
					comparable: true,
					state: 'out-of-order',
					rows: [
						{ version: '20261016090000', time: 'x', status: 'out-of-order' },
						{ version: '20261017080000', time: 'y', status: 'missing-local' },
					],
					total: 2,
					applied: 1,
					pending: [],
					outOfOrder: ['20261016090000'],
					missingLocal: ['20261017080000'],
				},
			}).migrations
		).toMatchObject({
			summary:
				'Migrations · 1 applied · 0 pending · 1 out of order · 1 missing locally',
			rows: [
				{ statusLabel: 'out of order', tone: 'danger' },
				{ statusLabel: 'missing locally', tone: 'warning' },
			],
		});
	});
});

describe('supabaseConnectView', () => {
	it('lists URLs and the database port, and keys by name only', () => {
		const state = demo();
		const stack = withStack(state, ids.featCheckout, {
			envShadow: [
				{
					file: 'apps/mobile/.env.local',
					line: 3,
					name: 'EXPO_PUBLIC_SUPABASE_URL',
				},
			],
		}).stacks.find((candidate) => candidate.id === ids.featCheckout);
		if (!stack) throw new Error('No demo stack');
		const view = supabaseConnectView(stack, state.policy);
		expect(view.urls).toEqual([
			{ id: 'api', label: 'API URL', value: 'http://127.0.0.1:21734' },
			{ id: 'rest', label: 'REST', value: 'http://127.0.0.1:21734/rest/v1' },
			{
				id: 'functions',
				label: 'Functions',
				value: 'http://127.0.0.1:21734/functions/v1',
			},
		]);
		expect(view.databasePort).toBe(21_736);
		expect(view.publishable.known).toBe(true);
		expect(view.secret).toBe(
			'Not shown by RN Devtools. Run pnpm exec supabase status in the worktree.'
		);
		expect(view.appEnv).toEqual([
			{ name: 'EXPO_PUBLIC_SUPABASE_URL', source: 'API_URL', injected: true },
			{
				name: 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
				source: 'PUBLISHABLE_KEY',
				injected: true,
			},
		]);
		expect(view.envShadow).toEqual([
			'apps/mobile/.env.local:3 sets EXPO_PUBLIC_SUPABASE_URL; Expo reads it instead.',
		]);
		const serialized = JSON.stringify(view);
		for (const shape of SECRET_SHAPES) expect(serialized).not.toMatch(shape);
	});

	it('leaves URLs out until the first start', () => {
		const state = demo();
		const view = supabaseConnectView(
			stackIn(state, ids.featOnboarding),
			state.policy
		);
		expect(view.urls.every((url) => url.value === undefined)).toBe(true);
		expect(view.databasePort).toBeUndefined();
		expect(view.publishable.known).toBe(false);
	});
});

describe('clock cadence and elapsed time', () => {
	it('ticks every second under two minutes, otherwise every 15 s', () => {
		expect(supabaseClockCadence({ deadlines: [now + 45_000] }, now)).toBe(
			SUPABASE_FAST_TICK_MS
		);
		expect(supabaseClockCadence({ deadlines: [now + 7 * MINUTE] }, now)).toBe(
			SUPABASE_SLOW_TICK_MS
		);
		expect(supabaseClockCadence({ deadlines: [now - 1_000] }, now)).toBe(
			SUPABASE_SLOW_TICK_MS
		);
		expect(supabaseClockCadence({ deadlines: [undefined] }, now)).toBe(
			SUPABASE_SLOW_TICK_MS
		);
		expect(supabaseClockCadence({ elapsing: true }, now)).toBe(
			SUPABASE_FAST_TICK_MS
		);
	});

	it('reads the demo at its own moment and live states at the panel clock', () => {
		const state = demo();
		expect(supabaseStateClock(state, now + 5 * HOUR)).toBe(now);
		expect(
			supabaseStateClock({ ...state, source: 'live' }, now + 5 * HOUR)
		).toBe(now + 5 * HOUR);
	});

	it('collects the countdowns a stack shows', () => {
		const stack = stackIn(demo(), ids.featCheckout);
		expect(supabaseStackDeadlines(stack)).toEqual([now + 7 * MINUTE]);
		expect(
			supabaseStackDeadlines({ ...stack, autoStopAt: now + 30_000 })
		).toEqual([now + 30_000, now + 7 * MINUTE]);
	});

	it('rounds elapsed time down', () => {
		expect(formatSupabaseElapsed(18_900)).toBe('18 s');
		expect(formatSupabaseElapsed(7 * MINUTE + 59_000)).toBe('7 min');
		expect(formatSupabaseElapsed(2 * HOUR)).toBe('2 h');
		expect(formatSupabaseElapsed(72 * HOUR)).toBe('3 days');
		expect(formatSupabaseElapsed(-5)).toBe('0 s');
	});

	it('finds a stack’s active job by name, then by membership', () => {
		const state = demo();
		const checkout = stackIn(state, ids.fixAuthRedirect);
		expect(supabaseActiveJob(checkout, state.jobs)?.id).toBe(ids.jobFixAuth);
		const { activeJobId: _active, ...unnamed } = checkout;
		expect(supabaseActiveJob(unnamed, state.jobs)?.id).toBe(ids.jobFixAuth);
		expect(
			supabaseActiveJob(unnamed, [
				{ ...(state.jobs[0] as SupabaseJob), status: 'complete' },
			])
		).toBeUndefined();
	});
});

it('always shows a deleted worktree on line 2, with the size', () => {
	const gone = buildSupabaseRows(demo(), now).find(
		(row) => row.id === ids.featGone
	);
	expect(gone?.line2).toBe('Stopped · Worktree deleted · Project gone · 64 MB');
	expect(gone?.stack.diskBytes).toBe(64 * MB);
});

describe('detail controls', () => {
	const context = { bridgeAvailable: true, now };

	it('builds a control with its availability and confirmation tier', () => {
		const state = demo();
		const stop = supabaseStackControl(
			stackIn(state, ids.featCheckout),
			state,
			context,
			{
				id: 'stop',
				label: 'Stop',
				action: 'stop',
				operation: { kind: 'stop', stackIds: [ids.featCheckout] },
			}
		);
		expect(stop).toMatchObject({
			availability: { allowed: true },
			confirmation: { kind: 'inline', agents: ['Claude 7f3a2c91'] },
		});
		const pending = supabaseStackControl(
			stackIn(state, ids.featCheckout),
			state,
			{ ...context, pending: true },
			{ id: 'pin', label: 'Keep running', action: 'pin' }
		);
		expect(pending.availability).toMatchObject({
			allowed: false,
			reason: 'Another operation is running on this stack.',
		});
	});

	it('keeps navigation available without the bridge', () => {
		const state = demo();
		const open = supabaseStackControl(
			stackIn(state, ids.featCheckout),
			state,
			{ bridgeAvailable: false, now },
			{
				id: 'open-logs',
				label: 'Open logs',
				target: { kind: 'section', section: 'logs' },
			}
		);
		expect(open).toEqual({
			id: 'open-logs',
			label: 'Open logs',
			availability: { allowed: true },
			target: { kind: 'section', section: 'logs' },
			confirmation: { kind: 'none' },
		});
	});
});

describe('supabaseDetailNotices', () => {
	const context = { bridgeAvailable: true, now };
	const ids_ = (state: SupabaseState, id: string) =>
		supabaseDetailNotices(stackIn(state, id), state, context).map(
			(notice) => notice.id
		);

	it('names a LAN-exposed stack once, with the one recovery that applies', () => {
		const state = demo();
		const [notice, ...rest] = supabaseDetailNotices(
			stackIn(state, ids.legacyMain),
			state,
			context
		);
		expect(rest).toEqual([]);
		expect(notice).toMatchObject({
			id: 'lan-exposed',
			tone: 'danger',
			title: 'LAN-exposed.',
		});
		expect(notice?.text).toContain('Stopped once, never attached.');
		expect(notice?.controls.map((control) => control.label)).toEqual([
			'Destroy…',
		]);
		expect(notice?.controls[0]?.confirmation).toEqual({ kind: 'native' });
	});

	it('explains a stale branch, a deleted worktree and an unreadable stack', () => {
		const state = demo();
		const [stale] = supabaseDetailNotices(
			stackIn(state, ids.featOldUi),
			state,
			context
		);
		expect(stale?.text).toMatch(/^The worktree moved to feat-nav-v2\./);
		expect(
			stale?.controls.map((control) => [
				control.label,
				control.availability.allowed,
			])
		).toEqual([
			['Follow', false],
			['Resume with saved settings', true],
		]);
		const [gone] = supabaseDetailNotices(
			stackIn(state, ids.featGone),
			state,
			context
		);
		expect(gone?.text).toBe(
			'Its worktree was deleted. RN Devtools stopped it at once. Destroy it to free 64 MB and 10 ports; its uploads went with the worktree.'
		);
		const [unreadable] = supabaseDetailNotices(
			stackIn(state, ids.unreadable),
			state,
			context
		);
		expect(unreadable).toMatchObject({
			id: 'unreadable',
			title: 'Stack state cannot be read.',
		});
		expect(unreadable?.controls.map((control) => control.label)).toEqual([
			'Reveal in Finder',
		]);
		expect(ids_(state, ids.featCheckout)).toEqual([]);
		expect(ids_(state, ids.fixAuthRedirect)).toEqual([]);
		expect(ids_(state, ids.featOnboarding)).toEqual([]);
	});

	it('words a failed first start with main’s title and recovery', () => {
		const state = withStack(demo(), ids.featOnboarding, {
			origin: 'managed',
			state: 'failed',
			lastError: {
				code: 'migration_failed',
				title: 'Migration failed',
				message: 'ERROR: relation "notes" already exists',
				recovery: 'Fix the failing migration, then apply again.',
				retry: 'none',
				details: {},
			},
		});
		const notices = supabaseDetailNotices(
			stackIn(state, ids.featOnboarding),
			state,
			context
		);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({
			id: 'failed',
			tone: 'danger',
			title: 'Migration failed.',
			text: 'Fix the failing migration, then apply again.',
		});
		expect(notices[0]?.controls.map((control) => control.id)).toEqual([
			'open-logs',
			'try-again',
			'destroy',
		]);
	});

	it('offers reverting editable changes, else only Destroy and recreate', () => {
		const majorVersion: SupabaseStackChangeView = {
			service: 'database',
			path: 'config.version',
			key: '[db] major_version',
			saved: '15',
			requested: '17',
			editable: true,
		};
		const needsRecreate = (stackChanges?: SupabaseStackChangeView[]) =>
			withStack(demo(), ids.featSearch, {
				state: 'needs-recreate',
				lastError: {
					code: 'needs_recreate',
					title: 'Saved stack cannot adopt this configuration',
					message: 'The saved stack cannot adopt these changes.',
					recovery: 'Revert the listed settings, or destroy and recreate it.',
					retry: 'none',
					details: stackChanges ? { stackChanges } : {},
				},
				...(stackChanges ? { recreateChanges: stackChanges } : {}),
			});
		const noticesOf = (state: SupabaseState) =>
			supabaseDetailNotices(stackIn(state, ids.featSearch), state, context);
		const resumeOf = (state: SupabaseState) =>
			supabaseDetailActions(stackIn(state, ids.featSearch), state, context)[0];

		const revertable = needsRecreate([majorVersion]);
		const [notice, ...rest] = noticesOf(revertable);
		expect(rest).toEqual([]);
		expect(notice).toMatchObject({
			id: 'needs-recreate',
			tone: 'danger',
			title: 'Needs recreate.',
			text: "The saved stack can't adopt this configuration. Revert the listed settings to keep it and its data, or destroy and recreate it for a fresh, migrated, seeded database.",
			changes: [majorVersion],
		});
		expect(
			notice?.controls.map((control) => [
				control.label,
				control.availability.allowed,
				control.confirmation.kind,
			])
		).toEqual([['Destroy and recreate…', true, 'native']]);
		expect(resumeOf(revertable)).toMatchObject({
			id: 'resume',
			availability: { allowed: false },
		});
		// The notice, the disabled Resume's reason and the pill agree.
		const adviceOf = (state: SupabaseState) => {
			const resume = resumeOf(state)?.availability;
			return {
				notice: noticesOf(state)[0]?.text,
				resume: resume?.allowed === false ? resume.reason : undefined,
				pill: stackStatus(stackIn(state, ids.featSearch)).explanation,
			};
		};
		expect(adviceOf(revertable)).toEqual({
			notice: notice?.text,
			resume:
				'[db] major_version changed from 15 to 17. Revert it to keep this stack, or recreate it.',
			pill: 'The saved stack cannot adopt this configuration. Revert the change to keep it, or recreate it.',
		});

		const build: SupabaseStackChangeView = {
			key: 'Postgres build',
			saved: '17.4.1',
			requested: '17.6.1',
			editable: false,
		};
		const recreateOnly = {
			notice:
				"The saved stack can't adopt this configuration. Recreating destroys its data and starts a fresh, migrated, seeded database.",
			resume:
				'This stack must be recreated: Postgres build changed from 17.4.1 to 17.6.1.',
			pill: 'The saved stack cannot adopt this configuration. Recreate it.',
		};
		expect(adviceOf(needsRecreate([build]))).toEqual(recreateOnly);
		// A change no setting controls blocks the start whatever else changed.
		expect(adviceOf(needsRecreate([majorVersion, build]))).toEqual(
			recreateOnly
		);
		expect(adviceOf(needsRecreate([build, majorVersion]))).toEqual(
			recreateOnly
		);
		const [unlisted] = noticesOf(needsRecreate());
		expect(unlisted?.text).toBe(recreateOnly.notice);
		expect(unlisted).not.toHaveProperty('changes');
		expect(adviceOf(needsRecreate()).pill).toBe(recreateOnly.pill);

		// Reverted: main's next status read drops the state and its error.
		const reverted = withStack(demo(), ids.featSearch, { state: 'stopped' });
		expect(noticesOf(reverted)).toEqual([]);
		expect(resumeOf(reverted)).toMatchObject({
			id: 'resume',
			availability: { allowed: true },
		});
	});

	it('still offers reverting once a retry fails for another reason', () => {
		const majorVersion: SupabaseStackChangeView = {
			service: 'database',
			path: 'config.version',
			key: '[db] major_version',
			saved: '15',
			requested: '17',
			editable: true,
		};
		// A lane tried it again and found its port taken: main keeps the state
		// and what it can't adopt, and lastError is the new failure.
		const state = withStack(demo(), ids.featSearch, {
			state: 'needs-recreate',
			recreateChanges: [majorVersion],
			lastError: {
				code: 'ports_conflict',
				title: 'Port unavailable',
				message: 'Port 54321 for api at 127.0.0.1 is in use by another process',
				recovery:
					'Another process is using port 54321. Free it, or remove the pinned port setting, then start again.',
				retry: 'none',
				details: { port: 54_321, key: 'api', portProblem: 'held-by-process' },
			},
		});
		const stack = stackIn(state, ids.featSearch);
		const notices = supabaseDetailNotices(stack, state, context);
		expect(notices.map((notice) => notice.id)).toEqual([
			'needs-recreate',
			'error:ports_conflict',
		]);
		expect(notices[0]).toMatchObject({
			text: "The saved stack can't adopt this configuration. Revert the listed settings to keep it and its data, or destroy and recreate it for a fresh, migrated, seeded database.",
			changes: [majorVersion],
		});
		expect(notices[1]).toMatchObject({
			title: 'Port unavailable.',
			text: 'Another process is using port 54321. Free it, or remove the pinned port setting, then start again.',
		});
		expect(
			supabaseDetailActions(stack, state, context)[0]?.availability
		).toMatchObject({
			allowed: false,
			reason:
				'[db] major_version changed from 15 to 17. Revert it to keep this stack, or recreate it.',
		});
		expect(stackStatus(stack).explanation).toBe(
			'The saved stack cannot adopt this configuration. Revert the change to keep it, or recreate it.'
		);
	});

	it('offers Stop and Restart with this CLI for a release mismatch', () => {
		const state = withStack(demo(), ids.main, {
			cli: {
				version: '2.121.0',
				gate: 'verified',
				mismatch: { ownerRelease: '2.120.2', clientRelease: '2.121.0' },
			},
		});
		const [mismatch] = supabaseDetailNotices(
			stackIn(state, ids.main),
			state,
			context
		);
		expect(mismatch?.text).toMatch(
			/^Owner 2\.120\.2, this worktree 2\.121\.0\./
		);
		expect(mismatch?.controls.map((control) => control.id)).toEqual([
			'stop',
			'stop-and-start:switch-cli',
		]);
	});

	it('maps an error main recorded to one recovery, and orders danger first', () => {
		const state = withStack(demo(), ids.featSearch, {
			mode: {
				value: 'observed',
				reasonText: "Supabase CLI 2.122.0 isn't verified",
			},
			lastError: {
				code: 'ports_pinned',
				title: 'Port pinned by another stack',
				message: 'Port 54321 is in use.',
				recovery: 'Remove the pinned port from supabase/config.toml.',
				retry: 'none',
				details: { holderStackId: ids.main },
			},
		});
		const notices = supabaseDetailNotices(
			stackIn(state, ids.featSearch),
			state,
			context
		);
		expect(notices.map((notice) => [notice.id, notice.tone])).toEqual([
			['error:ports_pinned', 'danger'],
			['observed', 'warning'],
		]);
		expect(notices[0]?.controls[0]).toMatchObject({
			label: 'Open that stack',
			target: { kind: 'stack', stackId: ids.main },
		});
		expect(notices[1]?.text).toBe(
			"Supabase CLI 2.122.0 isn't verified. RN Devtools lists this stack and can stop or destroy it, but won't start it or change its database."
		);
	});
});

describe('supabaseDriftNotices', () => {
	it('names Studio back on and changed configuration, each with its fix', () => {
		const state = withStack(demo(), ids.featCheckout, {
			flags: ['studio-back-on'],
			configDrift: { status: 'changed', paths: ['services.auth.site_url'] },
		});
		const notices = supabaseDriftNotices(
			stackIn(state, ids.featCheckout),
			state,
			{ bridgeAvailable: true, now }
		);
		expect(
			notices.map((notice) => [
				notice.title,
				notice.text,
				notice.controls.map((control) => control.label),
			])
		).toEqual([
			[
				'Studio is back on.',
				'A start without exclusions re-enabled it; its SQL endpoint has no authentication while it runs.',
				['Re-apply exclusions'],
			],
			[
				'Config changed since this stack started:',
				'services.auth.site_url.',
				['Stop and start to apply'],
			],
		]);
		expect(
			supabaseDriftNotices(stackIn(demo(), ids.featCheckout), demo(), {
				bridgeAvailable: true,
				now,
			})
		).toEqual([]);
	});
});

describe('supabaseInlineConfirmCopy', () => {
	const state = demo();

	it('names the live agents a stop interrupts', () => {
		expect(
			supabaseInlineConfirmCopy(
				{ kind: 'stop', stackIds: [ids.featCheckout] },
				state,
				['Claude 7f3a2c91']
			)
		).toEqual({
			title: "Stop feat-checkout's stack?",
			description:
				'Claude 7f3a2c91 is using it; its app loses the database until something starts it again. Data and ports are kept.',
			confirmLabel: 'Stop feat-checkout',
		});
		expect(
			supabaseInlineConfirmCopy(
				{ kind: 'stop', stackIds: [ids.featCheckout, ids.featPayments] },
				state,
				['Claude 7f3a2c91', 'Codex · by worktree']
			)
		).toMatchObject({
			title: 'Stop 2 stacks?',
			confirmLabel: 'Stop 2',
			description: expect.stringMatching(
				/^Claude 7f3a2c91 and Codex · by worktree are using them;/
			),
		});
	});

	it('words cancel, release and re-seed', () => {
		expect(
			supabaseInlineConfirmCopy(
				{ kind: 'cancel-job', jobId: ids.jobFixAuth },
				state,
				[]
			)
		).toEqual({
			title: 'Cancel the start of fix-auth-redirect?',
			description: 'The CLI cleans up first (up to 45 s).',
			confirmLabel: 'Cancel start',
		});
		expect(
			supabaseInlineConfirmCopy(
				{
					kind: 'release',
					stackId: ids.featCheckout,
					holder: {
						holder: 'session',
						agentKind: 'codex',
						sessionId: ids.codexAbandoned,
					},
				},
				state,
				['Codex 5d1b8f40']
			)
		).toEqual({
			title: "Release Codex 5d1b8f40's hold on feat-checkout?",
			description:
				'Codex 5d1b8f40 is live and may still use it. feat-checkout stops 60 s after nothing holds it, unless a lane or another session keeps it running.',
			confirmLabel: 'Release',
		});
		expect(
			supabaseInlineConfirmCopy(
				{ kind: 'seed-buckets', stackId: ids.main },
				state,
				[]
			).description
		).toBe(
			'Files with the same name in its buckets are overwritten; other files stay.'
		);
	});
});

describe('overview, facts and services', () => {
	const state = demo();

	it('summarises a running stack in one line', () => {
		const checkout = stackIn(state, ids.featCheckout);
		expect(
			supabaseOverviewLine(checkout, stackStatus(checkout, { jobs: [] }))
		).toBe(
			'Running · database healthy · 5 services asleep (start on first request)'
		);
		const stopped = stackIn(state, ids.featOldUi);
		expect(
			supabaseOverviewLine(stopped, stackStatus(stopped, { jobs: [] }))
		).toBe('Stopped');
	});

	it('lists the facts, copying only non-secret values', () => {
		const facts = supabaseStackFacts(stackIn(state, ids.featCheckout), now);
		expect(
			Object.fromEntries(facts.map((fact) => [fact.id, fact.value]))
		).toMatchObject({
			runtime: 'native · loopback only',
			cli: '2.121.0 · verified · pnpm exec supabase',
			disk: '64 MB + 2.0 MB uploads',
			memory: '180 MB RSS',
			'stack-id': '64616c83…145f',
			inspect: `pnpm exec supabase stack status --stack-id ${ids.featCheckout}`,
		});
		expect(facts.find((fact) => fact.id === 'runtime')?.note).toBe(
			'lsof, 2 min ago'
		);
		expect(facts.find((fact) => fact.id === 'stack-id')?.copy).toBe(
			ids.featCheckout
		);
		const serialized = JSON.stringify(facts);
		for (const shape of SECRET_SHAPES) expect(serialized).not.toMatch(shape);
	});

	it('shows inspected members with their ports, and why rows are missing', () => {
		const checkout = stackIn(state, ids.featCheckout);
		const inspection: SupabaseInspection = {
			stackId: ids.featCheckout,
			status: 'live',
			members: [
				{
					service: 'database',
					activation: 'eager',
					state: 'running',
					lifecycle: 'running',
					health: 'healthy',
				},
				{
					service: 'rest',
					activation: 'lazy',
					state: 'sleeping',
					lifecycle: null,
					health: null,
					wakeHintMs: 400,
				},
			],
			endpoints: [{ key: 'database.postgres', port: 21_736 }],
			checkedAt: now,
		};
		const view = supabaseServicesView(checkout, inspection);
		expect(view).toMatchObject({
			summary: '2 of 7 awake · 5 asleep',
			checkedAt: now,
			waiting: false,
			excluded: 'Excluded by Settings: studio, analytics.',
		});
		expect(view.rows.map((row) => [row.service, row.port])).toEqual([
			['database', 21_736],
			['rest', undefined],
		]);
		expect(supabaseServicesView(checkout, undefined)).toMatchObject({
			rows: [],
			waiting: true,
		});
		expect(
			supabaseServicesView(checkout, { ...inspection, status: 'stale' }).note
		).toBe(`Showing the last status, from ${formatClock(now)}.`);
		expect(
			supabaseServicesView(stackIn(state, ids.featOldUi), undefined)
		).toMatchObject({
			waiting: false,
			note: 'Services run while the stack does; it is not running now.',
		});
	});
});

describe('log reads', () => {
	const entry = (
		timestamp: string,
		line: string
	): Extract<SupabaseLogRecord, { type: 'entry' }> => ({
		type: 'entry',
		timestamp,
		source: 'history',
		service: 'rest',
		instanceId: 'instance-1',
		stream: 'stdout',
		line,
	});

	it('maps windows and the service filter onto the read', () => {
		expect(supabaseLogsOperation(ids.featCheckout, 'tail', 'all')).toEqual({
			kind: 'read-logs',
			stackId: ids.featCheckout,
			tail: 200,
		});
		expect(supabaseLogsOperation(ids.featCheckout, '10m', 'auth')).toEqual({
			kind: 'read-logs',
			stackId: ids.featCheckout,
			services: ['auth'],
			tail: 1_000,
			since: '10m',
		});
	});

	it('refreshes from the newest record, or from the last read', () => {
		const payload: SupabaseLogsPayload = {
			records: [entry('2026-10-17T14:02:11.000Z', 'GET /rest/v1/notes 200')],
			truncated: false,
			bytes: 22,
			readAt: now - 5_000,
		};
		expect(
			supabaseLogsRefreshOperation(ids.featCheckout, 'all', payload, now)
		).toEqual({
			kind: 'read-logs',
			stackId: ids.featCheckout,
			tail: 1_000,
			since: '2026-10-17T14:02:11.000Z',
		});
		expect(
			supabaseLogsRefreshOperation(
				ids.featCheckout,
				'rest',
				{ ...payload, records: [entry('14:02:11', 'GET')] },
				now
			)
		).toMatchObject({ services: ['rest'], since: '5s' });
	});

	it('merges a refresh without repeats and keeps the newest 64 KiB', () => {
		const first = entry('2026-10-17T14:02:11.000Z', 'a'.repeat(60_000));
		const previous: SupabaseLogsPayload = {
			records: [first],
			truncated: false,
			bytes: 60_000,
			readAt: now - 5_000,
		};
		const merged = mergeSupabaseLogs(previous, {
			records: [first, entry('2026-10-17T14:02:16.000Z', 'b'.repeat(10_000))],
			truncated: false,
			bytes: 70_000,
			readAt: now,
		});
		expect(merged.records.map((record) => record.timestamp)).toEqual([
			'2026-10-17T14:02:16.000Z',
		]);
		expect(merged).toMatchObject({
			truncated: true,
			bytes: 10_000,
			readAt: now,
		});
		const small = mergeSupabaseLogs(
			{ ...previous, records: [entry('t1', 'one')], bytes: 3 },
			{
				records: [entry('t1', 'one'), entry('t2', 'two')],
				truncated: false,
				bytes: 6,
				readAt: now,
			}
		);
		expect(small.records.map((record) => record.timestamp)).toEqual([
			't1',
			't2',
		]);
		expect(small.truncated).toBe(false);
	});

	it('offers the gateway and the services the stack runs', () => {
		const state = demo();
		const checkout = stackIn(state, ids.featCheckout);
		expect(supabaseLogServices(checkout, undefined)).not.toContain('studio');
		expect(supabaseLogServices(checkout, undefined)).toContain('gateway');
		expect(
			supabaseLogServices(checkout, {
				stackId: ids.featCheckout,
				status: 'live',
				members: [
					{
						service: 'database',
						activation: 'eager',
						state: 'running',
						lifecycle: 'running',
						health: 'healthy',
					},
				],
				endpoints: [],
				checkedAt: now,
			})
		).toEqual(['gateway', 'database']);
	});
});

describe('activity and counts', () => {
	it('lists the running job first, with its summary and Cancel', () => {
		const view = supabaseActivityView(demo(), now);
		expect(view).toMatchObject({
			title: 'Supabase activity · 1 running',
			meta: 'fix-auth-redirect · Starting · 2 s',
			active: 1,
		});
		expect(view.rows[0]).toMatchObject({
			label: 'Starting…',
			tone: 'info',
			cancel: { kind: 'cancel-job', jobId: ids.jobFixAuth },
		});
		const done = supabaseActivityView(
			{
				...demo(),
				jobs: [job({ status: 'failed', updatedAt: now - 1_000 })],
			},
			now
		);
		expect(done).toMatchObject({
			title: 'Recent Supabase activity',
			active: 0,
		});
		expect(done.rows[0]).toMatchObject({ label: 'failed', tone: 'danger' });
		expect(done.rows[0]?.cancel).toBeUndefined();
	});

	it('counts clean-up suggestions and requests to decide', () => {
		const state = demo();
		expect(supabaseCleanUpCount(state)).toBe(3);
		expect(
			supabaseRequestsMeta(
				buildSupabaseRequestCards(state, now, { bridgeAvailable: true }),
				state
			)
		).toBe('1 to decide · 3 suggested');
	});
});

describe('supabaseDisablingText', () => {
	it('counts the managed stack being stopped, or waits for starts', () => {
		expect(
			supabaseDisablingText({ remaining: 3, total: 3, waitingForStarts: false })
		).toBe('Turning off… stopping 3 managed stacks (1 of 3).');
		expect(
			supabaseDisablingText({ remaining: 1, total: 3, waitingForStarts: false })
		).toBe('Turning off… stopping 3 managed stacks (3 of 3).');
		expect(
			supabaseDisablingText({ remaining: 1, total: 1, waitingForStarts: false })
		).toBe('Turning off… stopping 1 managed stack (1 of 1).');
		expect(
			supabaseDisablingText({ remaining: 2, total: 2, waitingForStarts: true })
		).toBe('Turning off… waiting for running starts to finish.');
	});
});

it('labels Clean up without a count while nothing is selected', () => {
	const state = demo();
	expect(
		supabasePruneSummary(
			state,
			{ revision: state.prune.revision, stackIds: [] },
			{ bridgeAvailable: true }
		)
	).toMatchObject({
		triggerLabel: 'Destroy selected stacks…',
		statusLine: 'Select stacks to clean up · a system dialog confirms',
		availability: { allowed: false, reason: 'Select at least one stack.' },
	});
});

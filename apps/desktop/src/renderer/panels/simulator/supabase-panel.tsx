import { Button } from '@heroui/react/button';
import {
	ChevronDown,
	ChevronUp,
	CircleCheck,
	DatabaseZap,
	Eraser,
	FolderGit2,
	FolderPlus,
	HardDrive,
	Inbox,
	Layers,
	ListChecks,
	LoaderCircle,
	MemoryStick,
	Play,
	RefreshCw,
	Settings,
	Square,
	Trash2,
} from 'lucide-react';
import {
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
} from 'react';
import { SimulatorMetric } from '@/components/simulator-ui';
import {
	SupabaseControlButton,
	SupabaseNotice,
	SupabaseSelect,
} from '@/components/supabase-ui';
import {
	Badge,
	DisabledReason,
	Disclosure,
	EmptyPanel,
	PanelHeader,
	PanelNotice,
	SearchControl,
	StatusPill,
	Toolbar,
} from '@/components/ui';
import {
	buildSupabaseRepositoryRows,
	buildSupabaseRequestCards,
	buildSupabaseRows,
	type SupabaseControlTarget,
	type SupabaseOpenTarget,
	type SupabaseOperationInput,
	type SupabaseStackRow,
	type SupabaseTabState,
	type SupabaseView,
	supabaseActivityView,
	supabaseBulkEligibility,
	supabaseCleanUpCount,
	supabaseConfirmationKind,
	supabaseDisablingText,
	supabaseFilterOptions,
	supabaseHeaderMeta,
	supabaseInlineConfirmCopy,
	supabaseMetrics,
	supabaseNoticeList,
	supabaseOpenSections,
	supabaseRepositoryFilterOptions,
	supabaseRequestsMeta,
	supabaseSelectionAfterRemoval,
	supabaseStackDeadlines,
	supabaseStateClock,
	supabaseTabState,
	supabaseVisibleRepositoryRows,
	supabaseVisibleRows,
} from '@/simulator/supabase-model';
import { useLaneRuntime } from '@/state/lane-runtime';
import { useSimulatorRuntime } from '@/state/simulator-runtime';
import {
	type SupabaseNavigation,
	useSupabaseActions,
	useSupabaseInterest,
	useSupabaseNavigation,
	useSupabaseNow,
	useSupabaseState,
} from '@/state/supabase-runtime';
import { agentSessionKey } from '../../../shared/agent-protocol';
import {
	attentionItems,
	isActiveSupabaseJob,
	SUPABASE_REASONS,
	type SupabaseAttentionItem,
	type SupabaseInterest,
	type SupabaseStackSummary,
	type SupabaseState,
	supabaseGlobalActionAvailability,
	supabasePlatformLabel,
} from '../../../shared/supabase-protocol';
import { SupabaseRepositoriesView } from './supabase-repositories-view';
import { SupabaseRequestsView } from './supabase-requests-view';
import { SupabaseSettingsView } from './supabase-settings-view';
import {
	SUPABASE_BULK_REASON_IDS,
	SupabaseStacksView,
} from './supabase-stacks-view';

const ABOUT =
	"One local Supabase stack per worktree and branch, on 127.0.0.1, using Supabase's native runtime. RN Devtools starts, stops and cleans them up for lanes and agents; agents keep running their own local database commands. Supabase marks these stack commands experimental. Viewing this tab never keeps a stack running.";

const OFF_PURPOSE =
	"Give each worktree and branch its own local Supabase on 127.0.0.1. RN Devtools starts, stops and cleans them up for lanes and agents, using Supabase's native runtime, never Docker. Alpha.";

/**
 * The view the tab can show in its state. Requests and Repositories need the
 * feature on; nothing but Stacks renders while unsupported, without the
 * bridge, or before the first read (Settings excepted, so a deep link from
 * global Settings lands even while the tab loads).
 */
export function supabaseEffectiveView(
	view: SupabaseView,
	tabState: SupabaseTabState
): SupabaseView {
	switch (tabState) {
		case 'bridge-missing':
		case 'unsupported':
			return 'stacks';
		case 'loading':
			return view === 'settings' ? 'settings' : 'stacks';
		case 'off':
			return view === 'requests' ? 'stacks' : view;
		default:
			return view;
	}
}

/** The views the toggle offers: Requests only while the feature is on. */
export function supabaseToggleViews(
	tabState: SupabaseTabState
): readonly Exclude<SupabaseView, 'settings'>[] {
	if (tabState === 'ready' || tabState === 'empty') {
		return ['stacks', 'repositories', 'requests'];
	}
	return ['stacks', 'repositories'];
}

/**
 * What the tab tells main is on screen: the inspected stack and its open
 * sections in the Stacks view, otherwise just the view. Batch selection and
 * not-created rows inspect nothing.
 */
export function supabaseInterestFor(
	view: SupabaseView,
	stack: Pick<SupabaseStackSummary, 'id' | 'state'> | undefined,
	sections: SupabaseNavigation['sections']
): SupabaseInterest {
	if (view !== 'stacks') return { view, sections: [] };
	if (!stack || stack.state === 'not-created') {
		return { view: 'stacks', sections: [] };
	}
	return {
		view: 'stacks',
		inspectStackId: stack.id,
		sections: [...supabaseOpenSections(stack, sections[stack.id])],
	};
}

const VIEW_LABELS: Readonly<Record<Exclude<SupabaseView, 'settings'>, string>> =
	{
		stacks: 'Stacks',
		repositories: 'Repositories',
		requests: 'Requests',
	};

const VIEW_ICONS = {
	stacks: Layers,
	repositories: FolderGit2,
	requests: Inbox,
} as const;

const METRIC_ICONS = {
	running: Play,
	slots: Layers,
	memory: MemoryStick,
	disk: HardDrive,
} as const;

export function SupabasePanel() {
	const { state, isLoading, isBridgeAvailable, runtimeError } =
		useSupabaseState();
	const { run, refresh, reload, isPending, isStackPending } =
		useSupabaseActions();
	const { navigation, navigate, selectStack, openInSupabase } =
		useSupabaseNavigation();
	const { setSelectedDeviceUdid } = useSimulatorRuntime();
	const lanes = useLaneRuntime();
	const tabState = supabaseTabState(state, {
		bridgeAvailable: isBridgeAvailable,
		isLoading,
	});
	// Without a first state the empty one reads as unsupported; say what
	// actually happened instead.
	const unreadable =
		tabState !== 'bridge-missing' &&
		tabState !== 'loading' &&
		runtimeError !== null &&
		state.revision === 0;
	const live = !unreadable && (tabState === 'ready' || tabState === 'empty');
	const view = supabaseEffectiveView(navigation.view, tabState);
	const deadlines = state.stacks.flatMap(supabaseStackDeadlines);
	const clock = useSupabaseNow(
		{
			deadlines,
			elapsing: view === 'stacks' && state.jobs.some(isActiveSupabaseJob),
		},
		live && state.source === 'live'
	);
	// The demo describes one fixed moment; live states read at the panel clock.
	const now = supabaseStateClock(state, clock);

	const rows = useMemo(() => buildSupabaseRows(state, now), [state, now]);
	const visibleRows = useMemo(
		() =>
			supabaseVisibleRows(rows, {
				filter: navigation.filter,
				query: navigation.query,
			}),
		[navigation.filter, navigation.query, rows]
	);
	// The previous list on screen, so a destroyed row hands its selection to
	// the next one instead of jumping back to the top.
	const lastVisible = useRef<readonly SupabaseStackRow[]>([]);
	const selectedStackId = supabaseSelectionAfterRemoval(
		lastVisible.current,
		navigation.selectedStackId,
		visibleRows
	);
	useEffect(() => {
		lastVisible.current = visibleRows;
		if (selectedStackId !== navigation.selectedStackId) {
			selectStack(selectedStackId);
		}
	}, [navigation.selectedStackId, selectStack, selectedStackId, visibleRows]);
	const selectedStack =
		selectedStackId === null
			? undefined
			: state.stacks.find((stack) => stack.id === selectedStackId);

	const repositoryRows = useMemo(
		() => buildSupabaseRepositoryRows(state),
		[state]
	);
	const visibleRepositoryRows = useMemo(
		() =>
			supabaseVisibleRepositoryRows(repositoryRows, {
				filter: navigation.repositoryFilter,
				query: navigation.repositoryQuery,
			}),
		[navigation.repositoryFilter, navigation.repositoryQuery, repositoryRows]
	);
	const requestCards = useMemo(
		() =>
			buildSupabaseRequestCards(state, now, {
				bridgeAvailable: isBridgeAvailable,
			}),
		[isBridgeAvailable, now, state]
	);

	useSupabaseInterest(
		live
			? supabaseInterestFor(
					view,
					navigation.batchMode ? undefined : selectedStack,
					navigation.sections
				)
			: null
	);

	const attention = useMemo(() => attentionItems(state, now), [state, now]);
	const notices = supabaseNoticeList(attention, navigation.noticesExpanded);

	const { focusLane } = lanes;
	const openTarget = useCallback(
		(target: SupabaseOpenTarget) => {
			switch (target.kind) {
				case 'simulator':
					setSelectedDeviceUdid(target.udid);
					window.location.hash = 'simulator/fleet';
					return;
				case 'lane':
					focusLane(target.laneId);
					return;
				case 'agents':
					focusLane({
						view: 'agents',
						sessionKey: agentSessionKey(target.agent),
					});
					return;
			}
		},
		[focusLane, setSelectedDeviceUdid]
	);
	const openControlTarget = useCallback(
		(target: SupabaseControlTarget) => {
			switch (target.kind) {
				case 'repository':
					openInSupabase({
						view: 'repositories',
						repositoryId: target.repositoryId,
					});
					return;
				case 'stack':
					openInSupabase({ stackId: target.stackId });
					return;
				case 'show-running':
					navigate({ type: 'set-view', view: 'stacks' });
					navigate({ type: 'set-filter', filter: 'running' });
					return;
				case 'refresh':
					void refresh();
					return;
				case 'section':
					return;
			}
		},
		[navigate, openInSupabase, refresh]
	);
	const runRecovery = (item: SupabaseAttentionItem) => {
		const recovery = item.recovery;
		if (!recovery) return;
		switch (recovery.kind) {
			case 'show-stacks': {
				const [first] = recovery.stackIds;
				if (first !== undefined) openInSupabase({ stackId: first });
				return;
			}
			case 'review-request':
				openInSupabase({ view: 'requests' });
				return;
			case 'resume':
				void run({ kind: 'start', stackId: recovery.stackId });
				return;
			case 'open-settings':
				openInSupabase({ view: 'settings' });
				return;
			case 'retry-refresh':
				void refresh();
				return;
			case 'show-running':
				openControlTarget({ kind: 'show-running' });
				return;
			case 'open-clean-up':
				openInSupabase({ section: 'clean-up' });
				return;
		}
	};

	// The lane runtime's notice reports the outcome; it shows on this tab.
	const trackRepository = async () => {
		const receipt = await lanes.runOperation(
			{ kind: 'lane.add-repository' },
			{ successMessage: 'Repository tracked in Lanes.' }
		);
		if (receipt?.completed) void refresh();
	};

	const turnOn = supabaseGlobalActionAvailability('turn-on', {
		bridgeAvailable: isBridgeAvailable,
		state,
		pending: isPending('feature'),
	});
	const cleanUpCount = supabaseCleanUpCount(state);
	const blocked =
		unreadable || tabState === 'unsupported' || tabState === 'bridge-missing';
	const showToolbar = view !== 'settings' && !blocked;
	const meta = unreadable
		? 'Unavailable'
		: view === 'settings'
			? 'Settings'
			: supabaseHeaderMeta(state, tabState);
	const focusHandled = useCallback(
		(nonce: number) => navigate({ type: 'focus-handled', nonce }),
		[navigate]
	);
	const selectRepository = useCallback(
		(repositoryId: string | null) =>
			navigate({ type: 'select-repository', repositoryId }),
		[navigate]
	);

	return (
		<section className="panel-root supabase-panel">
			<PanelHeader
				actions={
					<SupabaseHeaderActions
						cleanUpCount={cleanUpCount}
						live={live}
						refreshing={isPending('refresh')}
						settingsOpen={view === 'settings'}
						showGear={!blocked}
						onCleanUp={() => openInSupabase({ section: 'clean-up' })}
						onRefresh={() => void refresh()}
						onToggleSettings={() => navigate({ type: 'toggle-settings' })}
					/>
				}
				description={ABOUT}
				meta={
					<span className="supabase-header-meta">
						<Badge>Alpha</Badge>
						<span>{meta}</span>
					</span>
				}
				title="Supabase"
			/>
			<SupabaseTabNotices
				expanded={navigation.noticesExpanded}
				notices={notices}
				runtimeError={runtimeError}
				state={state}
				tabState={tabState}
				unreadable={unreadable}
				onRecovery={runRecovery}
				onRetry={() => void reload()}
				onToggle={() =>
					navigate({
						type: 'set-notices-expanded',
						expanded: !navigation.noticesExpanded,
					})
				}
			/>
			{view === 'settings' && !blocked ? null : (
				<div
					aria-busy={tabState === 'loading' || undefined}
					className={`sim-metric-grid supabase-metric-grid ${tabState === 'loading' ? 'is-loading' : ''}`}
				>
					{supabaseMetrics(
						state,
						unreadable ? 'bridge-missing' : tabState,
						now
					).map((metric) => {
						const Icon = METRIC_ICONS[metric.id];
						return (
							<SimulatorMetric
								detail={metric.detail}
								icon={<Icon className="h-3.5 w-3.5" />}
								key={metric.id}
								label={metric.label}
								tone={metric.tone}
								value={metric.value}
							/>
						);
					})}
				</div>
			)}
			{showToolbar ? (
				<SupabaseToolbar
					isBridgeAvailable={isBridgeAvailable}
					laneBridge={lanes.isBridgeAvailable}
					navigation={navigation}
					now={now}
					repositoryOptions={supabaseRepositoryFilterOptions(repositoryRows)}
					repositoryMatches={visibleRepositoryRows.length}
					requestCount={requestCards.length}
					requestsMeta={supabaseRequestsMeta(requestCards, state)}
					rows={rows}
					stackMatches={visibleRows.length}
					state={state}
					tabState={tabState}
					trackBusy={lanes.pendingOperation === 'lane.add-repository'}
					view={view}
					onBulkRun={(input) => void run(input)}
					onNavigate={navigate}
					onTrackRepository={() => void trackRepository()}
				/>
			) : null}
			{unreadable ? (
				<div className="supabase-body panel-scroll">
					<EmptyPanel
						action={
							<Button
								size="sm"
								variant="secondary"
								onPress={() => void reload()}
							>
								<RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
								Retry
							</Button>
						}
						description="RN Devtools couldn't read the local Supabase state. Nothing was started or changed; Retry reads it again."
						icon={<DatabaseZap className="h-5 w-5" />}
						title="Supabase state could not be read"
					/>
				</div>
			) : tabState === 'unsupported' ? (
				<div className="supabase-body panel-scroll">
					<EmptyPanel
						description="RN Devtools runs local Supabase only on the native runtime, never Docker or Podman, so nothing is probed here."
						icon={<DatabaseZap className="h-5 w-5" />}
						title="Not available on this Mac"
					/>
				</div>
			) : tabState === 'bridge-missing' ? (
				<div className="supabase-body panel-scroll">
					<EmptyPanel
						description="Open the packaged RN Devtools app to list and manage the local Supabase stacks on this Mac."
						icon={<DatabaseZap className="h-5 w-5" />}
						title="Supabase controls are unavailable"
					/>
				</div>
			) : view === 'settings' ? (
				<SupabaseSettingsView
					isBridgeAvailable={isBridgeAvailable}
					state={state}
					onOpenRepositories={() => openInSupabase({ view: 'repositories' })}
				/>
			) : tabState === 'off' ? (
				view === 'repositories' ? (
					<div className="supabase-body panel-scroll">
						<EmptyPanel
							description="Turn on local Supabase to check repositories. Nothing is read while it is off."
							icon={<FolderGit2 className="h-5 w-5" />}
							title="Repositories are checked when it is on"
						/>
					</div>
				) : (
					<SupabaseOffState
						availability={turnOn}
						platform={state.availability.platform}
						turningOn={isPending('feature')}
						onTurnOn={() => void run({ kind: 'set-enabled', enabled: true })}
					/>
				)
			) : view === 'repositories' ? (
				<SupabaseRepositoriesView
					isBridgeAvailable={isBridgeAvailable}
					navigation={navigation}
					rows={visibleRepositoryRows}
					state={state}
					onOpenStack={(stackId) => openInSupabase({ stackId })}
					onSelect={selectRepository}
					onTrackRepository={() => void trackRepository()}
					onFocusHandled={focusHandled}
				/>
			) : view === 'requests' ? (
				<SupabaseRequestsView
					focus={navigation.focus}
					isBridgeAvailable={isBridgeAvailable}
					now={now}
					state={state}
					onFocusHandled={focusHandled}
					onOpenSettings={() => openInSupabase({ view: 'settings' })}
					onOpenStack={(stackId) => openInSupabase({ stackId })}
				/>
			) : (
				<SupabaseStacksView
					isBridgeAvailable={isBridgeAvailable}
					isStackPending={isStackPending}
					loading={tabState === 'loading'}
					navigation={navigation}
					now={now}
					rows={rows}
					selectedStackId={selectedStackId}
					state={state}
					visibleRows={visibleRows}
					onClearFilters={() => {
						navigate({ type: 'set-filter', filter: 'all' });
						navigate({ type: 'set-query', query: '' });
					}}
					onControlTarget={openControlTarget}
					onNavigate={navigate}
					onOpenRepository={(repositoryId) =>
						openInSupabase({ view: 'repositories', repositoryId })
					}
					onOpenTarget={openTarget}
					onSelect={selectStack}
				/>
			)}
			{live && view !== 'settings' ? (
				<SupabaseActivity now={now} state={state} />
			) : null}
		</section>
	);
}

function SupabaseHeaderActions({
	live,
	refreshing,
	cleanUpCount,
	showGear,
	settingsOpen,
	onRefresh,
	onCleanUp,
	onToggleSettings,
}: {
	live: boolean;
	refreshing: boolean;
	cleanUpCount: number;
	showGear: boolean;
	settingsOpen: boolean;
	onRefresh: () => void;
	onCleanUp: () => void;
	onToggleSettings: () => void;
}) {
	return (
		<>
			{live ? (
				<Button
					aria-label="Refresh Supabase stacks"
					size="sm"
					variant="secondary"
					onPress={onRefresh}
				>
					<RefreshCw
						aria-hidden="true"
						className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`}
					/>
					Refresh
				</Button>
			) : null}
			<span className="sr-only" role="status">
				{refreshing ? 'Refreshing Supabase stacks' : ''}
			</span>
			{live ? (
				<Button size="sm" variant="secondary" onPress={onCleanUp}>
					<Eraser aria-hidden="true" className="h-3.5 w-3.5" />
					{cleanUpCount > 0 ? `Clean up ${cleanUpCount}` : 'Clean up'}
				</Button>
			) : null}
			{showGear ? (
				<Button
					aria-label="Supabase settings"
					aria-pressed={settingsOpen}
					className="sim-icon-button"
					isIconOnly
					size="sm"
					variant={settingsOpen ? 'secondary' : 'ghost'}
					onPress={onToggleSettings}
				>
					<Settings aria-hidden="true" className="h-3.5 w-3.5" />
				</Button>
			) : null}
		</>
	);
}

/**
 * The tab's state notices, then at most two ranked attention notices with
 * the `+N more` toggle at the end of the last one, then the demo note.
 */
function SupabaseTabNotices({
	state,
	tabState,
	unreadable,
	runtimeError,
	notices,
	expanded,
	onToggle,
	onRecovery,
	onRetry,
}: {
	state: SupabaseState;
	tabState: SupabaseTabState;
	/** The first read failed, so there is no state to describe. */
	unreadable: boolean;
	runtimeError: string | null;
	notices: ReturnType<typeof supabaseNoticeList>;
	expanded: boolean;
	onToggle: () => void;
	onRecovery: (item: SupabaseAttentionItem) => void;
	onRetry: () => void;
}) {
	const toggle = notices.toggleLabel ? (
		<Button
			aria-expanded={expanded}
			className="supabase-notice-more"
			size="sm"
			variant="ghost"
			onPress={onToggle}
		>
			{notices.toggleLabel}
			{expanded ? (
				<ChevronUp aria-hidden="true" className="h-3 w-3" />
			) : (
				<ChevronDown aria-hidden="true" className="h-3 w-3" />
			)}
		</Button>
	) : undefined;
	const disabling = state.feature.disabling;
	return (
		<>
			{tabState === 'bridge-missing' ? (
				<SupabaseNotice
					title="Supabase controls need the secure desktop bridge."
					tone="warning"
				>
					Open the packaged RN Devtools app.
				</SupabaseNotice>
			) : null}
			{tabState === 'unsupported' && !unreadable ? (
				<SupabaseNotice
					title="Native Supabase needs Apple silicon and macOS 14 or later."
					tone="warning"
				>
					This Mac: {supabasePlatformLabel(state.availability.platform)}.
				</SupabaseNotice>
			) : null}
			{runtimeError && tabState !== 'bridge-missing' ? (
				<SupabaseNotice
					actions={
						<Button
							className="supabase-notice-button"
							size="sm"
							variant="ghost"
							onPress={onRetry}
						>
							<RefreshCw aria-hidden="true" className="h-3 w-3" />
							Retry
						</Button>
					}
					title="Supabase state could not be read."
					tone="danger"
				>
					{runtimeError}
				</SupabaseNotice>
			) : null}
			{disabling ? (
				<p className="supabase-progress-line" role="status">
					<LoaderCircle
						aria-hidden="true"
						className="h-3.5 w-3.5 animate-spin"
					/>
					{supabaseDisablingText(disabling)}
				</p>
			) : null}
			{notices.visible.map((item, index) => (
				<SupabaseNotice
					actions={
						item.recovery ? (
							<Button
								className="supabase-notice-button"
								size="sm"
								variant="ghost"
								onPress={() => onRecovery(item)}
							>
								{item.recovery.label}
							</Button>
						) : undefined
					}
					key={item.id}
					title={noticeLead(item.text).title}
					tone={item.tone === 'danger' ? 'danger' : 'warning'}
					{...(index === notices.visible.length - 1 && toggle
						? { trailing: toggle }
						: {})}
				>
					{[noticeLead(item.text).rest, item.detail ?? '']
						.filter(Boolean)
						.join(' ')}
				</SupabaseNotice>
			))}
			{state.source === 'demo' ? (
				<PanelNotice
					title="Demo stacks. Nothing runs and nothing is saved."
					tone="info"
				>
					Every control works against a demo state kept in memory; it resets
					when RN Devtools restarts.
				</PanelNotice>
			) : null}
		</>
	);
}

/**
 * Splits an attention sentence into the bold lead and the rest, the way the
 * notices read: `1 stack listens on your network.` then `It runs on Docker…`.
 */
export function noticeLead(text: string): Readonly<{
	title: string;
	rest: string;
}> {
	const match = /^(.+?[.:])\s+(\S.*)$/s.exec(text.trim());
	return match?.[1] && match[2]
		? { title: match[1], rest: match[2] }
		: { title: text.trim(), rest: '' };
}

function SupabaseToolbar({
	state,
	tabState,
	view,
	navigation,
	rows,
	now,
	stackMatches,
	repositoryMatches,
	repositoryOptions,
	requestCount,
	requestsMeta,
	isBridgeAvailable,
	laneBridge,
	trackBusy,
	onNavigate,
	onBulkRun,
	onTrackRepository,
}: {
	state: SupabaseState;
	tabState: SupabaseTabState;
	view: SupabaseView;
	navigation: SupabaseNavigation;
	rows: readonly SupabaseStackRow[];
	now: number;
	stackMatches: number;
	repositoryMatches: number;
	repositoryOptions: ReturnType<typeof supabaseRepositoryFilterOptions>;
	requestCount: number;
	requestsMeta: string;
	isBridgeAvailable: boolean;
	laneBridge: boolean;
	trackBusy: boolean;
	onNavigate: ReturnType<typeof useSupabaseNavigation>['navigate'];
	onBulkRun: (input: SupabaseOperationInput) => void;
	onTrackRepository: () => void;
}) {
	const live = tabState === 'ready' || tabState === 'empty';
	const views = supabaseToggleViews(tabState);
	const trackReasonId = useId();
	return (
		<Toolbar>
			<fieldset className="sim-layout-toggle supabase-view-toggle">
				<legend className="sr-only">Supabase view</legend>
				{views.map((id) => {
					const Icon = VIEW_ICONS[id];
					const pressed = view === id;
					return (
						<Button
							aria-pressed={pressed}
							key={id}
							size="sm"
							variant={pressed ? 'secondary' : 'ghost'}
							onPress={() => onNavigate({ type: 'set-view', view: id })}
						>
							<Icon
								aria-hidden="true"
								className="supabase-toggle-icon h-3.5 w-3.5"
							/>
							{VIEW_LABELS[id]}
							{id === 'requests' && requestCount > 0 ? (
								<span className="supabase-toggle-count">
									<span className="sr-only">, </span>
									{requestCount}
								</span>
							) : null}
						</Button>
					);
				})}
			</fieldset>
			{live && view === 'stacks' ? (
				<StacksToolbar
					isBridgeAvailable={isBridgeAvailable}
					navigation={navigation}
					now={now}
					rows={rows}
					stackMatches={stackMatches}
					state={state}
					onBulkRun={onBulkRun}
					onNavigate={onNavigate}
				/>
			) : null}
			{live && view === 'repositories' ? (
				<>
					<SearchControl
						ariaLabel="Search repositories and worktrees"
						placeholder="Repository or worktree"
						value={navigation.repositoryQuery}
						widthClassName="w-[260px] max-[1080px]:w-[180px]"
						onChange={(query) =>
							onNavigate({ type: 'set-repository-query', query })
						}
					/>
					<SupabaseSelect
						className="supabase-toolbar-filter"
						label="Filter repositories"
						options={repositoryOptions.map((option) => ({
							value: option.id,
							label: `${option.label} (${option.count})`,
						}))}
						value={navigation.repositoryFilter}
						onChange={(filter) =>
							onNavigate({ type: 'set-repository-filter', filter })
						}
					/>
					<Button
						{...(laneBridge ? {} : { 'aria-describedby': trackReasonId })}
						aria-label={trackBusy ? 'Tracking…' : 'Track repository…'}
						isDisabled={!laneBridge || trackBusy}
						size="sm"
						variant="ghost"
						onPress={onTrackRepository}
					>
						<FolderPlus aria-hidden="true" className="h-3.5 w-3.5" />
						<span className="supabase-toolbar-label">
							{trackBusy ? 'Tracking…' : 'Track repository…'}
						</span>
					</Button>
					{laneBridge ? null : (
						<DisabledReason id={trackReasonId}>
							Tracking a repository needs the Lanes desktop bridge.
						</DisabledReason>
					)}
					<span className="sim-toolbar-meta sim-fleet-toolbar-meta">
						{repositoryMatches} matching
					</span>
				</>
			) : null}
			{live && view === 'requests' ? (
				<span className="sim-toolbar-meta supabase-toolbar-end">
					{requestsMeta}
				</span>
			) : null}
		</Toolbar>
	);
}

/**
 * The Stacks toolbar: search, the filter with counts, Select multiple and,
 * in batch mode, Stop N and Destroy N… for the eligible stacks only.
 */
function StacksToolbar({
	state,
	navigation,
	rows,
	now,
	stackMatches,
	isBridgeAvailable,
	onNavigate,
	onBulkRun,
}: {
	state: SupabaseState;
	navigation: SupabaseNavigation;
	rows: readonly SupabaseStackRow[];
	now: number;
	stackMatches: number;
	isBridgeAvailable: boolean;
	onNavigate: ReturnType<typeof useSupabaseNavigation>['navigate'];
	onBulkRun: (input: SupabaseOperationInput) => void;
}) {
	const bulk = supabaseBulkEligibility(state, navigation.batchIds, {
		bridgeAvailable: isBridgeAvailable,
		now,
	});
	const stopInput = {
		kind: 'stop' as const,
		stackIds: [...bulk.stop.stackIds],
	};
	const stopConfirmation = supabaseConfirmationKind(stopInput, state);
	const filterOptions = supabaseFilterOptions(rows);
	return (
		<>
			<SearchControl
				ariaLabel="Search Supabase stacks by branch, port or agent"
				placeholder="Branch, :port, agent"
				value={navigation.query}
				widthClassName="w-[260px] max-[1080px]:w-[180px]"
				onChange={(query) => onNavigate({ type: 'set-query', query })}
			/>
			<SupabaseSelect
				className="supabase-toolbar-filter"
				label="Filter stacks"
				options={filterOptions.map((option) => ({
					value: option.id,
					label: `${option.label} (${option.count})`,
				}))}
				value={navigation.filter}
				onChange={(filter) => onNavigate({ type: 'set-filter', filter })}
			/>
			<div className="supabase-bulk-group">
				{navigation.batchMode ? (
					<SupabaseControlButton
						control={{
							label: bulk.stop.label,
							availability: bulk.stop.availability,
							confirmation: stopConfirmation,
						}}
						describedBy={
							bulk.stop.availability.allowed
								? undefined
								: SUPABASE_BULK_REASON_IDS.stop
						}
						icon={<Square aria-hidden="true" className="h-3.5 w-3.5" />}
						inlineCopy={supabaseInlineConfirmCopy(
							stopInput,
							state,
							stopConfirmation.kind === 'inline' ? stopConfirmation.agents : []
						)}
						reasonPlacement="elsewhere"
						onRun={() => onBulkRun(stopInput)}
					/>
				) : null}
				{navigation.batchMode ? (
					<SupabaseControlButton
						control={{
							label: bulk.destroy.label,
							availability: bulk.destroy.availability,
							confirmation: { kind: 'native' },
						}}
						describedBy={
							bulk.destroy.availability.allowed
								? undefined
								: SUPABASE_BULK_REASON_IDS.destroy
						}
						icon={<Trash2 aria-hidden="true" className="h-3.5 w-3.5" />}
						reasonPlacement="elsewhere"
						variant="ghost"
						onRun={() =>
							onBulkRun({
								kind: 'destroy',
								stackIds: [...bulk.destroy.stackIds],
								removeUploads: false,
							})
						}
					/>
				) : null}
				<Button
					aria-label={
						navigation.batchMode ? 'Done selecting' : 'Select multiple'
					}
					aria-pressed={navigation.batchMode}
					size="sm"
					variant={navigation.batchMode ? 'secondary' : 'ghost'}
					onPress={() =>
						onNavigate({
							type: 'set-batch-mode',
							enabled: !navigation.batchMode,
						})
					}
				>
					<ListChecks aria-hidden="true" className="h-3.5 w-3.5" />
					<span className="supabase-toolbar-label">
						{navigation.batchMode ? 'Done selecting' : 'Select multiple'}
					</span>
				</Button>
				{navigation.batchMode ? (
					<span className="sim-toolbar-meta">
						{navigation.batchIds.length} selected
					</span>
				) : null}
			</div>
			{navigation.batchMode ? null : (
				<span className="sim-toolbar-meta sim-fleet-toolbar-meta">
					{stackMatches} matching · {navigation.batchIds.length} selected
				</span>
			)}
		</>
	);
}

function SupabaseOffState({
	platform,
	availability,
	turningOn,
	onTurnOn,
}: {
	platform: SupabaseState['availability']['platform'];
	availability: ReturnType<typeof supabaseGlobalActionAvailability>;
	turningOn: boolean;
	onTurnOn: () => void;
}) {
	const reasonId = useId();
	return (
		<div className="supabase-body panel-scroll">
			<EmptyPanel
				action={
					<div className="supabase-off-actions">
						<p className="supabase-off-verdict">
							<CircleCheck aria-hidden="true" className="h-3.5 w-3.5" />
							This Mac can run it: {supabasePlatformLabel(platform)}
						</p>
						<Button
							{...(availability.allowed
								? {}
								: { 'aria-describedby': reasonId })}
							isDisabled={!availability.allowed || turningOn}
							size="sm"
							variant="primary"
							onPress={onTurnOn}
						>
							{turningOn ? 'Turning on…' : 'Turn on local Supabase…'}
						</Button>
						{availability.allowed ? null : (
							<DisabledReason id={reasonId}>
								{availability.reason}
							</DisabledReason>
						)}
						<p className="supabase-off-note">
							Off means off: nothing runs or polls.
						</p>
					</div>
				}
				description={OFF_PURPOSE}
				icon={<DatabaseZap className="h-5 w-5" />}
				title="Local Supabase is off"
			/>
		</div>
	);
}

/** Supabase activity: running jobs first, each start with Cancel. */
function SupabaseActivity({
	state,
	now,
}: {
	state: SupabaseState;
	now: number;
}) {
	const { run, isPending } = useSupabaseActions();
	const activity = supabaseActivityView(state, now);
	if (activity.rows.length === 0) return null;
	return (
		<div className="sim-fleet-activity supabase-activity">
			<Disclosure
				{...(activity.meta === undefined ? {} : { meta: activity.meta })}
				title={activity.title}
			>
				<ul className="sim-activity-list supabase-activity-list panel-scroll">
					{activity.rows.map((row) => (
						<li className="sim-activity-row" key={row.id}>
							<div>
								<strong>{row.title}</strong>
								<span>
									{[row.detail, row.elapsed].filter(Boolean).join(' · ')}
								</span>
							</div>
							<StatusPill tone={row.tone}>{row.label}</StatusPill>
							{row.cancel ? (
								<CancelJobButton
									busy={isPending(`job:${row.cancel.jobId}`)}
									input={row.cancel}
									state={state}
									onRun={(input) => void run(input)}
								/>
							) : null}
						</li>
					))}
				</ul>
			</Disclosure>
		</div>
	);
}

function CancelJobButton({
	input,
	state,
	busy,
	onRun,
}: {
	input: { kind: 'cancel-job'; jobId: string };
	state: SupabaseState;
	busy: boolean;
	onRun: (input: { kind: 'cancel-job'; jobId: string }) => void;
}): ReactNode {
	const copy = supabaseInlineConfirmCopy(input, state, []);
	return (
		<SupabaseControlButton
			control={{
				label: 'Cancel…',
				availability: busy
					? {
							allowed: false,
							reason: SUPABASE_REASONS.cancelling,
							check: 'in-flight',
						}
					: { allowed: true },
				confirmation: { kind: 'inline', agents: [] },
			}}
			ariaLabel={copy.title.replace(/\?$/, '')}
			inlineCopy={copy}
			variant="ghost"
			onRun={() => onRun(input)}
		/>
	);
}

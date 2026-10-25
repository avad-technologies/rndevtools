import { Button } from '@heroui/react/button';
import {
	ArrowUpRight,
	CalendarClock,
	CirclePause,
	Database,
	Download,
	FileDown,
	FolderGit2,
	FolderOpen,
	GitBranch,
	GitCompareArrows,
	History,
	Info,
	List,
	Pin,
	PinOff,
	Play,
	RefreshCcw,
	RefreshCw,
	RotateCcw,
	ScrollText,
	ShieldCheck,
	Square,
	Timer,
	Trash2,
	Upload,
	User,
	UserCheck,
	Waypoints,
	X,
} from 'lucide-react';
import {
	type ComponentType,
	type Dispatch,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from 'react';
import {
	HolderChain,
	LogView,
	MainCopyButton,
	ServiceRow,
	StackStatePill,
	StepList,
	SupabaseControlButton,
	SupabaseNotice,
	SupabaseSelect,
} from '@/components/supabase-ui';
import {
	Badge,
	CopyButton,
	DisabledReason,
	Disclosure,
	InfoPopover,
	KeyValue,
	SearchControl,
	Skeleton,
	StatusDot,
} from '@/components/ui';
import { showAppTraffic, useStackAppTraffic } from '@/lib/app-traffic';
import { formatClock, formatSize } from '@/lib/format';
import {
	defaultSupabaseSectionOpen,
	mergeSupabaseLogs,
	SUPABASE_LOG_WINDOWS,
	type SupabaseControl,
	type SupabaseControlContext,
	type SupabaseControlTarget,
	type SupabaseDetailNotice,
	type SupabaseDetailSection,
	type SupabaseLogWindow,
	type SupabaseOpenTarget,
	type SupabaseOperationInput,
	shortSupabaseId,
	supabaseActiveJob,
	supabaseConnectView,
	supabaseCreatedByText,
	supabaseDatabaseView,
	supabaseDetailActions,
	supabaseDetailNotices,
	supabaseDriftNotices,
	supabaseHolderChain,
	supabaseInlineConfirmCopy,
	supabaseLogServices,
	supabaseLogsOperation,
	supabaseLogsRefreshOperation,
	supabaseLogView,
	supabaseOverviewLine,
	supabaseServicesView,
	supabaseStackControl,
	supabaseStackFacts,
	supabaseStackHeading,
	supabaseStepList,
} from '@/simulator/supabase-model';
import { useDesktopRuntime } from '@/state/desktop-runtime';
import {
	type SupabaseFocusRequest,
	type SupabaseNavigationAction,
	useSupabaseActions,
} from '@/state/supabase-runtime';
import {
	nextEvents,
	SUPABASE_REASONS,
	type SupabaseDatabasePayload,
	type SupabaseErrorView,
	type SupabaseLogsPayload,
	type SupabaseNextEvent,
	type SupabaseOperationReceipt,
	type SupabaseStackAction,
	type SupabaseStackSummary,
	type SupabaseState,
	stackStatus,
	supabaseActionAvailability,
	supabaseDesktopError,
	supabaseStackTitle,
} from '../../../shared/supabase-protocol';

/**
 * The detail of one stack: heading, the state's action row, typed notices,
 * the step list of a running job, and Overview, Services, Database, Logs,
 * Connect and the Danger zone as native Disclosures. Database and Logs read
 * only when opened or refreshed, never on selection or focus.
 */

/** The last database read and export on a stack, kept while the tab lives. */
type SupabaseDatabaseRead = Readonly<{
	status: 'reading' | 'ready' | 'error';
	payload?: SupabaseDatabasePayload;
	error?: SupabaseErrorView;
	exported?: Readonly<{
		content: 'schema' | 'data';
		bytes?: number;
		revealable: boolean;
	}>;
}>;

/** The last log read on a stack, with the window and service it used. */
type SupabaseLogsRead = Readonly<{
	status: 'reading' | 'ready' | 'error';
	payload?: SupabaseLogsPayload;
	error?: SupabaseErrorView;
	window: SupabaseLogWindow;
	service: string;
}>;

export type SupabaseStackReads = Readonly<{
	database?: SupabaseDatabaseRead;
	logs?: SupabaseLogsRead;
}>;

type IconComponent = ComponentType<{ className?: string }>;

const CONTROL_ICONS: Readonly<Record<string, IconComponent>> = {
	start: Play,
	'try-again': RotateCcw,
	resume: Play,
	stop: Square,
	'stop-external': Square,
	restart: RotateCcw,
	pin: Pin,
	unpin: PinOff,
	adopt: UserCheck,
	'cancel-start': X,
	'open-lane': Waypoints,
	'open-logs': ScrollText,
	destroy: Trash2,
	recreate: RotateCcw,
	reveal: FolderOpen,
	'follow-branch': GitBranch,
	'resume-saved': History,
	'review-repository': FolderGit2,
	'open-stack': ArrowUpRight,
	'show-running': List,
	refresh: RefreshCw,
	'reapply-exclusions': ShieldCheck,
	'open-database': Database,
	'stop-and-start:apply-config': RefreshCcw,
	'stop-and-start:switch-cli': GitCompareArrows,
	'stop-and-start:recover-partial': RefreshCcw,
	release: User,
};

function controlIcon(id: string): ReactNode {
	const Icon = CONTROL_ICONS[id];
	return Icon ? <Icon aria-hidden="true" className="h-3.5 w-3.5" /> : null;
}

const NEXT_ICONS: Readonly<Record<SupabaseNextEvent['icon'], IconComponent>> = {
	timer: Timer,
	'calendar-clock': CalendarClock,
	pin: Pin,
	'circle-pause': CirclePause,
	user: User,
};

const SECTION_TITLES: Readonly<Record<SupabaseDetailSection, string>> = {
	overview: 'Overview',
	services: 'Services',
	database: 'Database',
	logs: 'Logs',
	connect: 'Connect',
	danger: 'Danger zone',
};

/**
 * Keeps notice controls the action row doesn't already show, so one button
 * never appears twice on screen.
 */
export function supabaseNoticeControls(
	notice: Pick<SupabaseDetailNotice, 'controls'>,
	actionIds: ReadonlySet<string>
): readonly SupabaseControl[] {
	return notice.controls.filter((control) => !actionIds.has(control.id));
}

/**
 * The disabled reasons under the action row, each once, with the controls
 * that point at it: two buttons refused for the same reason share one line.
 */
export function supabaseActionReasons(
	controls: readonly Pick<SupabaseControl, 'id' | 'availability'>[]
): readonly Readonly<{ reason: string; controlIds: readonly string[] }>[] {
	const reasons = new Map<string, string[]>();
	for (const control of controls) {
		if (control.availability.allowed) continue;
		const ids = reasons.get(control.availability.reason) ?? [];
		ids.push(control.id);
		reasons.set(control.availability.reason, ids);
	}
	return [...reasons].map(([reason, controlIds]) => ({ reason, controlIds }));
}

/**
 * Studio's controls, the same in Services and Connect: Enable Studio… while
 * it is excluded (main's dialog), else Open Studio and Disable Studio.
 */
export function supabaseStudioControls(
	stack: SupabaseStackSummary,
	state: SupabaseState,
	context: SupabaseControlContext
): readonly SupabaseControl[] {
	const control = (spec: Parameters<typeof supabaseStackControl>[3]) =>
		supabaseStackControl(stack, state, context, spec);
	const { included, operatorEnabled } = stack.studio;
	return [
		!included
			? control({
					id: 'enable-studio',
					label: 'Enable Studio…',
					action: 'enable-studio',
					operation: { kind: 'set-studio', stackId: stack.id, enabled: true },
				})
			: undefined,
		included
			? control({
					id: 'open-studio',
					label: 'Open Studio',
					action: 'open-studio',
					operation: { kind: 'open', stackId: stack.id, surface: 'studio' },
				})
			: undefined,
		included || operatorEnabled
			? control({
					id: 'disable-studio',
					label: 'Disable Studio',
					action: 'disable-studio',
					operation: { kind: 'set-studio', stackId: stack.id, enabled: false },
				})
			: undefined,
	].filter((item): item is SupabaseControl => item !== undefined);
}

/**
 * Folds an auto-refresh read into the logs on screen, but only into the read
 * it started from. A service or window change, a manual read or its error
 * replaces that read, and the tick's lines are dropped instead of being shown
 * under a filter they were not read for.
 */
export function supabaseLogsAfterRefresh(
	reads: SupabaseStackReads,
	started: SupabaseLogsRead,
	next: SupabaseLogsPayload
): SupabaseStackReads {
	if (reads.logs !== started || !started.payload) return reads;
	return {
		...reads,
		logs: {
			...started,
			status: 'ready',
			payload: mergeSupabaseLogs(started.payload, next),
		},
	};
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const timer = window.setTimeout(() => setDebounced(value), delayMs);
		return () => window.clearTimeout(timer);
	}, [delayMs, value]);
	return debounced;
}

/** A read refused because another read of the same kind is still running. */
function isInFlightRefusal(receipt: SupabaseOperationReceipt): boolean {
	return (
		receipt.error?.code === 'refused' &&
		receipt.error.message === SUPABASE_REASONS.inFlight
	);
}

function failedRead(receipt: SupabaseOperationReceipt): SupabaseErrorView {
	return (
		receipt.error ??
		supabaseDesktopError('internal', 'The read did not complete.')
	);
}

const LOG_AUTO_REFRESH_MS = 5_000;
const LOG_AUTO_REFRESH_LIMIT_MS = 10 * 60_000;

export function SupabaseStackDetail({
	stack,
	state,
	now,
	isBridgeAvailable,
	pending,
	sections,
	focus,
	reads,
	onReads,
	onNavigate,
	onControlTarget,
	onOpenTarget,
}: {
	stack: SupabaseStackSummary;
	state: SupabaseState;
	now: number;
	isBridgeAvailable: boolean;
	pending: boolean;
	sections: Readonly<Partial<Record<SupabaseDetailSection, boolean>>>;
	focus: SupabaseFocusRequest | null;
	reads: SupabaseStackReads;
	onReads: (
		update: (current: SupabaseStackReads) => SupabaseStackReads
	) => void;
	onNavigate: Dispatch<SupabaseNavigationAction>;
	onControlTarget: (target: SupabaseControlTarget) => void;
	onOpenTarget: (target: SupabaseOpenTarget) => void;
}) {
	const { run } = useSupabaseActions();
	const headingRef = useRef<HTMLHeadingElement>(null);
	const reasonPrefix = useId();
	const status = stackStatus(stack, { jobs: state.jobs });
	const heading = supabaseStackHeading(stack);
	const title = supabaseStackTitle(stack);
	const context: SupabaseControlContext = {
		bridgeAvailable: isBridgeAvailable,
		now,
		pending,
		...(reads.database?.payload?.migrations === undefined
			? {}
			: { migrations: reads.database.payload.migrations }),
	};
	const control = (
		spec: Parameters<typeof supabaseStackControl>[3]
	): SupabaseControl => supabaseStackControl(stack, state, context, spec);
	const isOpen = (section: SupabaseDetailSection) =>
		sections[section] ?? defaultSupabaseSectionOpen(stack, section);
	const setOpen = (section: SupabaseDetailSection, open: boolean) =>
		onNavigate({ type: 'set-section', stackId: stack.id, section, open });

	// Reads run only when the stack can answer them; a refused read would
	// repeat the visible reason as an error.
	const canRead = (action: 'read-database' | 'read-logs') =>
		supabaseActionAvailability(stack, action, {
			bridgeAvailable: isBridgeAvailable,
			state,
			now,
		}).allowed;

	const readDatabase = useCallback(async () => {
		onReads((current) => ({
			...current,
			database: { ...current.database, status: 'reading' },
		}));
		const receipt = await run({ kind: 'read-database', stackId: stack.id });
		if (isInFlightRefusal(receipt)) return;
		onReads((current) => ({
			...current,
			database: receipt.database
				? {
						status: 'ready',
						payload: receipt.database,
						...(current.database?.exported
							? { exported: current.database.exported }
							: {}),
					}
				: {
						...current.database,
						status: 'error',
						error: failedRead(receipt),
					},
		}));
	}, [onReads, run, stack.id]);

	const readLogs = useCallback(
		async (logWindow: SupabaseLogWindow, service: string) => {
			onReads((current) => ({
				...current,
				logs: {
					...current.logs,
					status: 'reading',
					window: logWindow,
					service,
				},
			}));
			const receipt = await run(
				supabaseLogsOperation(stack.id, logWindow, service)
			);
			if (isInFlightRefusal(receipt)) return;
			onReads((current) => ({
				...current,
				logs: receipt.logs
					? {
							status: 'ready',
							payload: receipt.logs,
							window: logWindow,
							service,
						}
					: {
							...current.logs,
							status: 'error',
							error: failedRead(receipt),
							window: logWindow,
							service,
						},
			}));
		},
		[onReads, run, stack.id]
	);

	const scrollToSection = (section: SupabaseDetailSection) => {
		window.requestAnimationFrame(() => {
			document
				.getElementById(`${reasonPrefix}-section-${section}`)
				?.scrollIntoView({ block: 'nearest' });
		});
	};

	const readOpened = (section: SupabaseDetailSection) => {
		if (
			section === 'database' &&
			reads.database?.status !== 'reading' &&
			canRead('read-database')
		) {
			void readDatabase();
		}
		if (
			section === 'logs' &&
			reads.logs?.status !== 'reading' &&
			canRead('read-logs')
		) {
			void readLogs(reads.logs?.window ?? 'tail', reads.logs?.service ?? 'all');
		}
	};

	const openSection = (section: SupabaseDetailSection) => {
		if (!isOpen(section)) setOpen(section, true);
		readOpened(section);
		scrollToSection(section);
	};

	const toggleSection = (section: SupabaseDetailSection, open: boolean) => {
		setOpen(section, open);
		// Opening a section is the only read trigger besides Refresh.
		if (open) readOpened(section);
	};

	// A deep link focuses the heading, and reads the section it named.
	const focusRef = useRef(readOpened);
	focusRef.current = readOpened;
	useEffect(() => {
		if (focus?.target !== 'stack') return;
		if (focus.id !== undefined && focus.id !== stack.id) return;
		headingRef.current?.focus();
		if (focus.section !== undefined) focusRef.current(focus.section);
		onNavigate({ type: 'focus-handled', nonce: focus.nonce });
	}, [focus, onNavigate, stack.id]);

	const runOperation = async (
		input: SupabaseOperationInput
	): Promise<SupabaseOperationReceipt> => {
		const receipt = await run(input);
		const settled = receipt.completed && receipt.cancelled !== true;
		if (input.kind === 'destroy' && settled && !receipt.jobId) {
			// Selection moves to the next row; its heading takes focus.
			onNavigate({ type: 'request-focus', target: 'stack' });
		}
		if (
			(input.kind === 'apply-migrations' || input.kind === 'reset') &&
			settled &&
			!receipt.jobId &&
			isOpen('database')
		) {
			void readDatabase();
		}
		if (input.kind === 'export' && settled && receipt.export) {
			const exported = {
				content: receipt.export.content,
				revealable: receipt.export.revealable,
				...(receipt.export.bytes === undefined
					? {}
					: { bytes: receipt.export.bytes }),
			};
			onReads((current) => ({
				...current,
				database: {
					...current.database,
					status: current.database?.status ?? 'ready',
					exported,
				},
			}));
		}
		return receipt;
	};

	const handleTarget = (target: SupabaseControlTarget) => {
		if (target.kind === 'section') {
			openSection(target.section);
			return;
		}
		onControlTarget(target);
	};

	const runControl = (item: SupabaseControl) => {
		if (item.operation) {
			void runOperation(item.operation);
			return;
		}
		if (item.target) handleTarget(item.target);
	};

	const inlineCopy = (
		item: Pick<SupabaseControl, 'operation' | 'confirmation'>
	) =>
		item.operation && item.confirmation.kind === 'inline'
			? supabaseInlineConfirmCopy(
					item.operation,
					state,
					item.confirmation.agents
				)
			: undefined;

	const renderControl = (
		item: SupabaseControl,
		options: Readonly<{
			variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
			className?: string;
			describedBy?: string;
			reasonPlacement?: 'after' | 'elsewhere';
			ariaLabel?: string;
		}> = {}
	) => {
		const copy = inlineCopy(item);
		return (
			<SupabaseControlButton
				control={item}
				icon={controlIcon(item.id)}
				key={item.id}
				{...(options.variant ? { variant: options.variant } : {})}
				{...(options.className ? { className: options.className } : {})}
				{...(options.describedBy ? { describedBy: options.describedBy } : {})}
				{...(options.reasonPlacement
					? { reasonPlacement: options.reasonPlacement }
					: {})}
				{...(options.ariaLabel ? { ariaLabel: options.ariaLabel } : {})}
				{...(copy ? { inlineCopy: copy } : {})}
				onRun={() => runControl(item)}
			/>
		);
	};

	// The action row: at most four buttons, the rest live in the sections.
	const actions = supabaseDetailActions(stack, state, {
		bridgeAvailable: isBridgeAvailable,
		pending,
		now,
	});
	const actionIds = new Set(actions.map((action) => action.id));
	const actionReasons = supabaseActionReasons(actions);
	const reasonIdFor = (controlId: string) => {
		const index = actionReasons.findIndex((entry) =>
			entry.controlIds.includes(controlId)
		);
		return index < 0 ? undefined : `${reasonPrefix}-action-${index}`;
	};
	const lane = stack.lanes.find((candidate) => candidate.metro !== 'stopped');
	const firstLane = lane ?? stack.lanes[0];
	const notices = supabaseDetailNotices(stack, state, context);
	const servicesView = supabaseServicesView(stack, state.inspection);
	const job = supabaseActiveJob(stack, state.jobs);
	const stepList = job ? supabaseStepList(job, now, title) : undefined;

	return (
		<div className="sim-target-detail supabase-detail">
			<div className="sim-detail-heading">
				<div className="supabase-detail-title">
					<p className="sim-eyebrow">{heading.eyebrow}</p>
					<h2 ref={headingRef} tabIndex={-1}>
						{heading.title}
					</h2>
					{/* The id never breaks at its ellipsis; the path may wrap. */}
					<span className="supabase-detail-subtitle">
						{stack.worktreeLabel ? `${stack.worktreeLabel} · ` : ''}
						<span className="supabase-nowrap">{shortSupabaseId(stack.id)}</span>
					</span>
				</div>
				<div className="sim-detail-heading-pills">
					<StackStatePill status={status} />
					<Badge>{heading.origin}</Badge>
				</div>
			</div>
			{actions.length > 0 ? (
				<div className="sim-action-row supabase-action-row">
					{actions.map((action, index) => {
						const describedBy = reasonIdFor(action.id);
						const shared = {
							variant:
								index === 0 ? ('secondary' as const) : ('ghost' as const),
							reasonPlacement: 'elsewhere' as const,
							...(describedBy ? { describedBy } : {}),
						};
						if (action.id === 'open-lane' && firstLane) {
							return (
								<SupabaseControlButton
									ariaLabel={`Open lane ${title} :${firstLane.port} in Lanes`}
									control={action}
									icon={controlIcon(action.id)}
									key={action.id}
									variant="ghost"
									onRun={() =>
										onOpenTarget({ kind: 'lane', laneId: firstLane.laneId })
									}
								/>
							);
						}
						if (action.id === 'open-logs') {
							return renderControl(
								{ ...action, target: { kind: 'section', section: 'logs' } },
								shared
							);
						}
						return renderControl(action, {
							...shared,
							ariaLabel: `${action.label.replace(/…$/, '')} ${title}`,
						});
					})}
					{actionIds.has('cancel-start') ? (
						<span className="supabase-action-note">
							Cancelling lets the CLI clean up (up to 45 s).
						</span>
					) : null}
					{actionIds.has('adopt') ? (
						<span className="supabase-action-note">
							After adopting, RN Devtools stops it{' '}
							{state.policy.unheldStopDelayMs < 120_000
								? `${Math.round(state.policy.unheldStopDelayMs / 1_000)} s`
								: `${Math.round(state.policy.unheldStopDelayMs / 60_000)} min`}{' '}
							after nothing holds it; data is kept.
						</span>
					) : null}
					{actionReasons.map((entry, index) => (
						<DisabledReason
							id={`${reasonPrefix}-action-${index}`}
							key={entry.reason}
						>
							{entry.reason}
						</DisabledReason>
					))}
				</div>
			) : (
				<div className="supabase-action-spacer" />
			)}
			{stepList ? (
				<section
					aria-label={`Progress for ${title}`}
					className="supabase-progress"
				>
					<p className="supabase-progress-headline">
						{stepList.headline}
						{stepList.expected ? ` · ${stepList.expected}` : ''}
						{stepList.coldCacheNote ? `. ${stepList.coldCacheNote}` : ''}
					</p>
					{stepList.steps.length > 0 ? (
						<StepList
							announcement={stepList.currentLabel}
							label={`Steps for ${title}`}
							steps={stepList.steps}
						/>
					) : null}
					{stepList.latestLine ? (
						<p className="sim-inline-note">Latest · {stepList.latestLine}</p>
					) : null}
				</section>
			) : null}
			{notices.length > 0 ? (
				<div className="supabase-detail-notices">
					{notices.map((notice) => (
						<DetailNotice
							key={notice.id}
							notice={notice}
							render={(item) =>
								renderControl(item, {
									variant: 'ghost',
									className: 'supabase-notice-button',
								})
							}
							visible={supabaseNoticeControls(notice, actionIds)}
						/>
					))}
				</div>
			) : null}
			<DetailSection
				anchor={`${reasonPrefix}-section-overview`}
				open={isOpen('overview')}
				section="overview"
				onToggle={toggleSection}
			>
				<OverviewSection
					context={context}
					now={now}
					stack={stack}
					state={state}
					status={status}
					renderControl={renderControl}
					onOpenTarget={onOpenTarget}
				/>
			</DetailSection>
			<DetailSection
				anchor={`${reasonPrefix}-section-services`}
				meta={
					servicesView.checkedAt === undefined
						? undefined
						: `checked ${formatClock(servicesView.checkedAt)}`
				}
				open={isOpen('services')}
				section="services"
				summary={servicesView.summary}
				onToggle={toggleSection}
			>
				<ServicesSection
					context={context}
					stack={stack}
					state={state}
					view={servicesView}
					renderControl={renderControl}
				/>
			</DetailSection>
			<DetailSection
				anchor={`${reasonPrefix}-section-database`}
				{...(reads.database?.payload
					? { meta: `checked ${formatClock(reads.database.payload.readAt)}` }
					: {})}
				open={isOpen('database')}
				section="database"
				onToggle={toggleSection}
			>
				<DatabaseSection
					context={context}
					read={reads.database}
					stack={stack}
					state={state}
					renderControl={renderControl}
					onRead={() => void readDatabase()}
					onRun={(input) => void runOperation(input)}
				/>
			</DetailSection>
			<DetailSection
				anchor={`${reasonPrefix}-section-logs`}
				open={isOpen('logs')}
				section="logs"
				onToggle={toggleSection}
			>
				<LogsSection
					context={context}
					read={reads.logs}
					stack={stack}
					state={state}
					title={title}
					onRead={(window, service) => void readLogs(window, service)}
					onReads={onReads}
				/>
			</DetailSection>
			<DetailSection
				anchor={`${reasonPrefix}-section-connect`}
				open={isOpen('connect')}
				section="connect"
				onToggle={toggleSection}
			>
				<ConnectSection
					context={context}
					stack={stack}
					state={state}
					title={title}
					renderControl={renderControl}
					onRun={runOperation}
				/>
			</DetailSection>
			<DetailSection
				anchor={`${reasonPrefix}-section-danger`}
				open={isOpen('danger')}
				section="danger"
				onToggle={toggleSection}
			>
				<DangerSection
					control={control}
					stack={stack}
					renderControl={renderControl}
				/>
			</DetailSection>
		</div>
	);
}

type RenderControl = (
	item: SupabaseControl,
	options?: Readonly<{
		variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
		className?: string;
		describedBy?: string;
		reasonPlacement?: 'after' | 'elsewhere';
		ariaLabel?: string;
	}>
) => ReactNode;

function DetailNotice({
	notice,
	visible,
	render,
}: {
	notice: SupabaseDetailNotice;
	visible: readonly SupabaseControl[];
	render: (item: SupabaseControl) => ReactNode;
}) {
	return (
		<SupabaseNotice
			actions={visible.length > 0 ? visible.map(render) : undefined}
			inset
			title={notice.title}
			tone={notice.tone}
		>
			{notice.text}
			{notice.changes ? (
				<table className="supabase-changes">
					<thead>
						<tr>
							<th scope="col">Key</th>
							<th scope="col">Saved → requested</th>
							<th scope="col">Editable</th>
						</tr>
					</thead>
					<tbody>
						{notice.changes.map((change) => (
							<tr
								key={`${change.service ?? ''}:${change.key ?? change.path ?? ''}`}
							>
								<td>
									<code className="supabase-code">
										{change.service ? `[${change.service}] ` : ''}
										{change.key ?? change.path ?? '—'}
									</code>
								</td>
								<td>
									{change.saved ?? '—'} → {change.requested ?? '—'}
								</td>
								<td>{change.editable ? 'yes' : 'no'}</td>
							</tr>
						))}
					</tbody>
				</table>
			) : null}
		</SupabaseNotice>
	);
}

/**
 * A detail Disclosure whose open state lives in the provider per stack. Its
 * content renders only while open, so a closed section neither reads nor
 * keeps interactive elements in the tab order.
 */
function DetailSection({
	section,
	open,
	summary,
	meta,
	anchor,
	onToggle,
	children,
}: {
	section: SupabaseDetailSection;
	open: boolean;
	summary?: string | undefined;
	meta?: string | undefined;
	anchor: string;
	onToggle: (section: SupabaseDetailSection, open: boolean) => void;
	children: ReactNode;
}) {
	return (
		<div className={`supabase-section is-${section}`} id={anchor}>
			<Disclosure
				{...(meta ? { meta } : {})}
				open={open}
				title={
					<>
						{SECTION_TITLES[section]}
						{summary ? (
							<span className="supabase-section-summary"> · {summary}</span>
						) : null}
					</>
				}
				onToggle={(next) => onToggle(section, next)}
			>
				{open ? children : null}
			</Disclosure>
		</div>
	);
}

function OverviewSection({
	stack,
	state,
	status,
	now,
	context,
	renderControl,
	onOpenTarget,
}: {
	stack: SupabaseStackSummary;
	state: SupabaseState;
	status: ReturnType<typeof stackStatus>;
	now: number;
	context: SupabaseControlContext;
	renderControl: RenderControl;
	onOpenTarget: (target: SupabaseOpenTarget) => void;
}) {
	const clocksPaused = state.discovery.sessions === 'unavailable';
	const chain = supabaseHolderChain(stack, now, { clocksPaused });
	const events = nextEvents(stack, state.policy, now, { clocksPaused });
	const facts = supabaseStackFacts(stack, now);
	const control = (spec: Parameters<typeof supabaseStackControl>[3]) =>
		supabaseStackControl(stack, state, context, spec);
	const eventControl = (action: SupabaseNextEvent['actions'][number]) =>
		action === 'keep-running'
			? control({
					id: 'pin',
					label: 'Keep running',
					action: 'pin',
					operation: { kind: 'pin', stackId: stack.id },
				})
			: action === 'unpin'
				? control({
						id: 'unpin',
						label: 'Unpin',
						action: 'unpin',
						operation: { kind: 'unpin', stackId: stack.id },
					})
				: control({
						id: 'stop',
						label: 'Stop',
						action: 'stop',
						operation: { kind: 'stop', stackIds: [stack.id] },
					});
	return (
		<div className="supabase-overview">
			<p className="supabase-overview-line">
				<StatusDot hollow={status.icon === 'hollow-dot'} tone={status.tone} />
				<span>{supabaseOverviewLine(stack, status)}</span>
			</p>
			<div className="supabase-subhead">
				<h3>Who holds this</h3>
				<InfoPopover label="Who holds this">
					The agent, lane, Simulator and worktree a stack is attached to.
					Holders keep it running; when the last one lets go it stops after the
					delay in Settings and keeps its data.
				</InfoPopover>
			</div>
			<HolderChain links={chain.links} onOpen={onOpenTarget} />
			{chain.others.length > 0 ? (
				<div className="supabase-also">
					<span className="supabase-also-label">Also held by</span>
					<ul>
						{chain.others.map((other) => {
							const release = other.release
								? control({
										id: 'release',
										label: other.live ? 'Release…' : 'Release',
										action: 'release',
										operation: {
											kind: 'release',
											stackId: stack.id,
											holder: other.release,
										},
									})
								: undefined;
							return (
								<li key={other.key}>
									<StatusDot tone={other.live ? 'success' : 'warning'} />
									<span>{other.label}</span>
									{release
										? renderControl(release, {
												variant: 'ghost',
												ariaLabel: `Release the hold of ${other.label.split(' · ')[0] ?? 'this holder'} on ${supabaseStackTitle(stack)}`,
											})
										: null}
								</li>
							);
						})}
					</ul>
				</div>
			) : null}
			<dl className="supabase-facts">
				<KeyValue
					label="Created by"
					value={supabaseCreatedByText(stack, now)}
				/>
			</dl>
			<div className="supabase-subhead">
				<h3>What happens next</h3>
			</div>
			{events.length === 0 ? (
				<p className="supabase-next is-muted">
					<CalendarClock aria-hidden="true" className="h-3.5 w-3.5" />
					<span>
						Nothing is scheduled. RN Devtools never deletes a stack on its own.
					</span>
				</p>
			) : (
				events.map((event) => {
					const Icon = NEXT_ICONS[event.icon];
					return (
						<div
							className={`supabase-next is-${event.tone}`}
							key={`${event.kind}:${event.at ?? ''}`}
						>
							<Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
							{event.at === undefined ? (
								<span className="supabase-next-text">{event.text}</span>
							) : (
								<output aria-live="off" className="supabase-next-text">
									{event.text}
								</output>
							)}
							{event.actions.length > 0 ? (
								<span className="supabase-next-actions">
									{event.actions.map((action) =>
										renderControl(eventControl(action), { variant: 'ghost' })
									)}
								</span>
							) : null}
						</div>
					);
				})
			)}
			<dl className="supabase-facts">
				{facts.map((fact) => (
					<KeyValue
						key={fact.id}
						label={fact.label}
						mono={fact.mono === true}
						value={
							<span className="supabase-fact">
								<span className="supabase-fact-value">{fact.value}</span>
								{fact.note ? (
									<span className="supabase-fact-note">({fact.note})</span>
								) : null}
								{fact.copy ? (
									<CopyButton label={`Copy ${fact.label}`} value={fact.copy} />
								) : null}
							</span>
						}
					/>
				))}
			</dl>
			<StackAppTraffic now={now} stack={stack} />
			<p className="sim-inline-note">
				Viewing this tab never keeps a stack running.
			</p>
		</div>
	);
}

/** P5: what the connected app on one of this stack's lanes talks to. */
function StackAppTraffic({
	stack,
	now,
}: {
	stack: SupabaseStackSummary;
	now: number;
}) {
	const row = useStackAppTraffic(stack, now);
	const { setSelectedDeviceId } = useDesktopRuntime();
	if (!row) return null;
	return (
		<dl className="supabase-facts">
			<KeyValue
				label="App traffic"
				value={
					<span className="supabase-fact">
						<StatusDot tone={row.tone} />
						<span className="supabase-fact-value">{row.text}</span>
						{row.filter ? (
							<Button
								size="sm"
								variant="ghost"
								onPress={() => showAppTraffic(row, setSelectedDeviceId)}
							>
								Show traffic
							</Button>
						) : null}
					</span>
				}
			/>
		</dl>
	);
}

function ServicesSection({
	stack,
	state,
	view,
	context,
	renderControl,
}: {
	stack: SupabaseStackSummary;
	state: SupabaseState;
	view: ReturnType<typeof supabaseServicesView>;
	context: SupabaseControlContext;
	renderControl: RenderControl;
}) {
	const drift = supabaseDriftNotices(stack, state, context);
	const studio = supabaseStudioControls(stack, state, context);
	return (
		<div className="supabase-services">
			{view.waiting ? (
				<div aria-busy="true" className="supabase-skeleton-rows">
					<Skeleton className="supabase-skeleton-line" rounded="sm" />
					<Skeleton className="supabase-skeleton-line" rounded="sm" />
					<Skeleton className="supabase-skeleton-line" rounded="sm" />
				</div>
			) : null}
			{view.rows.map((row) => (
				<ServiceRow
					activation={row.activation}
					error={row.error}
					health={row.health}
					key={row.key}
					port={row.port}
					service={row.service}
					state={row.state}
					wakeHintMs={row.wakeHintMs}
				/>
			))}
			{view.note ? <p className="sim-inline-note">{view.note}</p> : null}
			{view.excluded ? (
				<p className="supabase-excluded">
					<Info aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
					<span>{view.excluded}</span>
				</p>
			) : null}
			{studio.length > 0 ? (
				<div className="supabase-connect-row supabase-studio-line">
					<span>Studio</span>
					<span>
						{stack.studio.included
							? 'on · its SQL endpoint has no authentication while it runs'
							: 'excluded'}
					</span>
					<span className="supabase-connect-buttons">
						{studio.map((item) =>
							renderControl(item, {
								variant: 'ghost',
								ariaLabel: `${item.label.replace(/…$/, '')} for ${supabaseStackTitle(stack)}`,
							})
						)}
					</span>
				</div>
			) : null}
			{drift.map((notice) => (
				<SupabaseNotice
					actions={
						notice.controls.length > 0
							? notice.controls.map((item) =>
									renderControl(item, {
										variant: 'ghost',
										className: 'supabase-notice-button',
									})
								)
							: undefined
					}
					inset
					key={notice.id}
					title={notice.title}
					tone={notice.tone}
				>
					{notice.text}
				</SupabaseNotice>
			))}
		</div>
	);
}

function DatabaseSection({
	stack,
	state,
	read,
	context,
	renderControl,
	onRead,
	onRun,
}: {
	stack: SupabaseStackSummary;
	state: SupabaseState;
	read: SupabaseDatabaseRead | undefined;
	context: SupabaseControlContext;
	renderControl: RenderControl;
	onRead: () => void;
	onRun: (input: SupabaseOperationInput) => void;
}) {
	const reasonId = useId();
	const availability = supabaseActionAvailability(stack, 'read-database', {
		bridgeAvailable: context.bridgeAvailable,
		state,
		now: context.now,
	});
	const view = read?.payload ? supabaseDatabaseView(read.payload) : undefined;
	const reading = read?.status === 'reading';
	const control = (spec: Parameters<typeof supabaseStackControl>[3]) =>
		supabaseStackControl(stack, state, context, spec);
	const migrations = view?.migrations;
	const pendingCount =
		migrations?.comparable === true ? migrations.pending.length : 0;
	const mutations = [
		control({
			id: 'apply-migrations',
			label:
				pendingCount > 0 ? `Apply ${pendingCount} pending` : 'Apply pending',
			action: 'apply-migrations',
			operation: { kind: 'apply-migrations', stackId: stack.id },
		}),
		control({
			id: 'export-schema',
			label: 'Export schema…',
			action: 'export',
			operation: { kind: 'export', stackId: stack.id, content: 'schema' },
		}),
		control({
			id: 'export-data',
			label: 'Export data…',
			action: 'export',
			operation: { kind: 'export', stackId: stack.id, content: 'data' },
		}),
		control({
			id: 'seed-buckets',
			label: 'Re-seed buckets…',
			action: 'seed-buckets',
			operation: { kind: 'seed-buckets', stackId: stack.id },
		}),
	];
	const icons: Readonly<Record<string, ReactNode>> = {
		'apply-migrations': <Upload aria-hidden="true" className="h-3.5 w-3.5" />,
		'export-schema': <FileDown aria-hidden="true" className="h-3.5 w-3.5" />,
		'export-data': <FileDown aria-hidden="true" className="h-3.5 w-3.5" />,
		'seed-buckets': <Download aria-hidden="true" className="h-3.5 w-3.5" />,
	};
	const exported = read?.exported;
	return (
		<div className="supabase-database">
			<div className="supabase-section-bar">
				<span className="supabase-section-label">Stats</span>
				{/* Once read, the section's summary line carries the checked time. */}
				{read?.payload ? null : (
					<span className="supabase-section-meta">read on open</span>
				)}
				<Button
					{...(availability.allowed ? {} : { 'aria-describedby': reasonId })}
					aria-label={`Refresh the database of ${supabaseStackTitle(stack)}`}
					isDisabled={!availability.allowed || reading}
					size="sm"
					variant="ghost"
					onPress={onRead}
				>
					<RefreshCw
						aria-hidden="true"
						className={`h-3.5 w-3.5 ${reading ? 'animate-spin' : ''}`}
					/>
					Refresh
				</Button>
			</div>
			{availability.allowed ? null : (
				<DisabledReason id={reasonId}>{availability.reason}</DisabledReason>
			)}
			{reading && !read?.payload ? (
				<div aria-busy="true" className="supabase-skeleton-rows">
					<Skeleton className="supabase-skeleton-line" rounded="sm" />
					<Skeleton className="supabase-skeleton-line" rounded="sm" />
				</div>
			) : null}
			{read?.status === 'error' && read.error ? (
				<SupabaseNotice inset title={read.error.title} tone="danger">
					{read.error.recovery || read.error.message}
				</SupabaseNotice>
			) : null}
			{view ? (
				<>
					{view.targetNote ? (
						<p className="sim-inline-note is-warning">{view.targetNote}</p>
					) : null}
					<div className="supabase-stats">
						{view.stats.slice(0, 4).map((stat) => (
							<div className="supabase-stat" key={stat.id}>
								<span className="supabase-stat-label">{stat.label}</span>
								<span className="supabase-stat-value">{stat.value}</span>
							</div>
						))}
					</div>
					{view.tables.length > 0 ? (
						<table className="supabase-table">
							<caption className="sr-only">Largest tables</caption>
							<thead>
								<tr>
									<th scope="col">Table</th>
									<th className="is-numeric" scope="col">
										Rows (est.)
									</th>
									<th className="is-numeric" scope="col">
										Size
									</th>
								</tr>
							</thead>
							<tbody>
								{view.tables.map((table) => (
									<tr key={table.name}>
										<td>
											<code className="supabase-code">{table.name}</code>
										</td>
										<td className="is-numeric">{table.rows}</td>
										<td className="is-numeric">{table.size}</td>
									</tr>
								))}
							</tbody>
						</table>
					) : (
						<p className="sim-section-empty">No tables yet.</p>
					)}
					{migrations?.comparable === true ? (
						<>
							<p className="supabase-section-label">{migrations.summary}</p>
							{migrations.rows.length > 0 ? (
								<table className="supabase-table">
									<caption className="sr-only">Migrations</caption>
									<thead>
										<tr>
											<th scope="col">Version</th>
											<th scope="col">Time</th>
											<th className="is-numeric" scope="col">
												Status
											</th>
										</tr>
									</thead>
									<tbody>
										{migrations.rows.map((row) => (
											<tr key={row.version}>
												<td>
													<code className="supabase-code">{row.version}</code>
												</td>
												<td>{row.time}</td>
												<td className="is-numeric">
													<span className={`supabase-migration is-${row.tone}`}>
														{row.statusLabel}
													</span>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							) : null}
							{migrations.truncated ? (
								<p className="sim-inline-note">
									Showing the newest {migrations.rows.length} migrations.
								</p>
							) : null}
						</>
					) : migrations?.comparable === false ? (
						<p className="sim-inline-note">{migrations.reasonText}</p>
					) : null}
				</>
			) : null}
			{mutations.length > 0 ? (
				<div className="supabase-section-actions">
					{mutations.map((item) => (
						<span className="supabase-control" key={item.id}>
							<SupabaseControlButton
								control={item}
								icon={icons[item.id]}
								{...(item.operation && item.confirmation.kind === 'inline'
									? {
											inlineCopy: supabaseInlineConfirmCopy(
												item.operation,
												state,
												item.confirmation.agents
											),
										}
									: {})}
								tone="warning"
								variant="ghost"
								onRun={() => {
									if (item.operation) onRun(item.operation);
								}}
							/>
						</span>
					))}
				</div>
			) : null}
			{exported ? (
				<p className="supabase-export-result" role="status">
					Exported {supabaseStackTitle(stack)}'s {exported.content}
					{exported.bytes === undefined
						? ''
						: ` (${formatSize(exported.bytes)})`}
					. Storage files aren't included.
					{exported.revealable
						? renderControl(
								control({
									id: 'reveal-export',
									label: 'Show in Finder',
									action: 'reveal',
									operation: {
										kind: 'reveal',
										stackId: stack.id,
										what: 'export',
									},
								}),
								{ variant: 'ghost' }
							)
						: null}
				</p>
			) : null}
			<p className="sim-inline-note">
				Storage files aren't in exports; there is no restore.
			</p>
		</div>
	);
}

function LogsSection({
	stack,
	state,
	title,
	read,
	context,
	onRead,
	onReads,
}: {
	stack: SupabaseStackSummary;
	state: SupabaseState;
	title: string;
	read: SupabaseLogsRead | undefined;
	context: SupabaseControlContext;
	onRead: (window: SupabaseLogWindow, service: string) => void;
	onReads: (
		update: (current: SupabaseStackReads) => SupabaseStackReads
	) => void;
}) {
	const { run } = useSupabaseActions();
	const reasonId = useId();
	const autoReasonId = useId();
	const [query, setQuery] = useState('');
	const filter = useDebouncedValue(query, 100);
	const availabilityContext = {
		bridgeAvailable: context.bridgeAvailable,
		state,
		now: context.now,
	};
	const availability = supabaseActionAvailability(
		stack,
		'read-logs',
		availabilityContext
	);
	const autoAvailability = supabaseActionAvailability(
		stack,
		'logs-auto-refresh',
		availabilityContext
	);
	const logWindow = read?.window ?? 'tail';
	const service = read?.service ?? 'all';
	const services = supabaseLogServices(stack, state.inspection);
	const reading = read?.status === 'reading';
	const view = read?.payload
		? supabaseLogView(read.payload, { query: filter })
		: undefined;

	// Auto-refresh polls with --since every 5 s while this section is open
	// and the window visible, and pauses after 10 minutes.
	const [autoStartedAt, setAutoStartedAt] = useState<number | null>(null);
	const [autoPaused, setAutoPaused] = useState(false);
	const latest = useRef(read);
	latest.current = read;
	const autoOn = autoStartedAt !== null && autoAvailability.allowed;
	const autoReason = !autoAvailability.allowed
		? autoAvailability.reason
		: read?.payload
			? undefined
			: 'Auto-refresh starts once the logs have been read.';
	useEffect(() => {
		if (autoStartedAt === null || !autoOn) return undefined;
		const timer = globalThis.setInterval(() => {
			if (Date.now() - autoStartedAt > LOG_AUTO_REFRESH_LIMIT_MS) {
				setAutoStartedAt(null);
				setAutoPaused(true);
				return;
			}
			if (document.visibilityState !== 'visible') return;
			const started = latest.current;
			if (!started?.payload || started.status === 'reading') return;
			// A background run never refuses the operator's own read, which
			// then supersedes this tick.
			void run(
				supabaseLogsRefreshOperation(
					stack.id,
					started.service,
					started.payload,
					Date.now()
				),
				{ background: true }
			).then((receipt) => {
				const next = receipt.logs;
				if (!next) return;
				onReads((reads) => supabaseLogsAfterRefresh(reads, started, next));
			});
		}, LOG_AUTO_REFRESH_MS);
		return () => globalThis.clearInterval(timer);
	}, [autoOn, autoStartedAt, onReads, run, stack.id]);

	const serviceOptions = [
		{ value: 'all', label: 'All services' },
		...services.map((name) => ({ value: name, label: name })),
	];

	return (
		<div className="supabase-logs">
			<div className="supabase-log-controls">
				<SupabaseSelect
					describedBy={availability.allowed ? undefined : reasonId}
					disabled={!availability.allowed}
					label="Log service"
					options={serviceOptions}
					value={services.includes(service) ? service : 'all'}
					onChange={(next) => onRead(logWindow, next)}
				/>
				<SupabaseSelect
					describedBy={availability.allowed ? undefined : reasonId}
					disabled={!availability.allowed}
					label="Log window"
					options={SUPABASE_LOG_WINDOWS.map((option) => ({
						value: option.id,
						label: option.label,
					}))}
					value={logWindow}
					onChange={(next) => onRead(next, service)}
				/>
				<SearchControl
					ariaLabel="Filter log lines"
					placeholder="Filter lines"
					value={query}
					widthClassName="w-[180px] max-[1080px]:w-[140px]"
					onChange={setQuery}
				/>
				<Button
					{...(availability.allowed ? {} : { 'aria-describedby': reasonId })}
					aria-label={`Refresh the logs of ${title}`}
					className="sim-icon-button"
					isDisabled={!availability.allowed || reading}
					isIconOnly
					size="sm"
					variant="ghost"
					onPress={() => onRead(logWindow, service)}
				>
					<RefreshCw
						aria-hidden="true"
						className={`h-3.5 w-3.5 ${reading ? 'animate-spin' : ''}`}
					/>
				</Button>
			</div>
			{availability.allowed ? null : (
				<DisabledReason id={reasonId}>{availability.reason}</DisabledReason>
			)}
			{reading && !read?.payload ? (
				<div aria-busy="true" className="supabase-skeleton-rows">
					<Skeleton className="supabase-skeleton-line" rounded="sm" />
					<Skeleton className="supabase-skeleton-line" rounded="sm" />
					<Skeleton className="supabase-skeleton-line" rounded="sm" />
				</div>
			) : null}
			{read?.status === 'error' && read.error ? (
				<SupabaseNotice inset title="Could not read logs:" tone="danger">
					{read.error.message || read.error.title}
				</SupabaseNotice>
			) : null}
			{view ? (
				<LogView
					label={`Redacted logs for ${title}`}
					lines={view.lines}
					summary={view.summary}
					visibleText={view.visibleText}
				/>
			) : null}
			<p className="supabase-log-matches" role="status">
				{view && filter.trim() !== ''
					? `${view.matchCount} ${view.matchCount === 1 ? 'line matches' : 'lines match'} “${filter.trim()}”.`
					: ''}
			</p>
			<p className="sim-inline-note">
				History stays readable while the stack is stopped.
			</p>
			<div className="supabase-log-auto">
				<label className="supabase-checkbox">
					<input
						{...(autoReason === undefined
							? {}
							: { 'aria-describedby': autoReasonId })}
						checked={autoOn}
						disabled={autoReason !== undefined}
						type="checkbox"
						onChange={(event) => {
							setAutoPaused(false);
							setAutoStartedAt(event.currentTarget.checked ? Date.now() : null);
						}}
					/>
					Auto-refresh while open
				</label>
				{autoReason === undefined ? null : (
					<DisabledReason id={autoReasonId}>{autoReason}</DisabledReason>
				)}
				{autoPaused ? (
					<span className="supabase-log-paused" role="status">
						Auto-refresh paused after 10 min.
						<Button
							size="sm"
							variant="ghost"
							onPress={() => {
								setAutoPaused(false);
								setAutoStartedAt(Date.now());
							}}
						>
							Resume
						</Button>
					</span>
				) : null}
			</div>
		</div>
	);
}

const COPY_ACTIONS = {
	'publishable-key': 'copy-key',
	'psql-command': 'copy-psql',
	'app-env': 'copy-app-env',
} as const satisfies Readonly<Record<string, SupabaseStackAction>>;

function ConnectSection({
	stack,
	state,
	title,
	context,
	renderControl,
	onRun,
}: {
	stack: SupabaseStackSummary;
	state: SupabaseState;
	title: string;
	context: SupabaseControlContext;
	renderControl: RenderControl;
	onRun: (input: SupabaseOperationInput) => Promise<SupabaseOperationReceipt>;
}) {
	const urlReasonId = useId();
	const view = supabaseConnectView(stack, state.policy);
	const availability = (action: SupabaseStackAction) =>
		supabaseActionAvailability(stack, action, {
			bridgeAvailable: context.bridgeAvailable,
			state,
			now: context.now,
		});
	const control = (spec: Parameters<typeof supabaseStackControl>[3]) =>
		supabaseStackControl(stack, state, context, spec);
	const mainCopy = (what: keyof typeof COPY_ACTIONS, label: string) => {
		const check = availability(COPY_ACTIONS[what]);
		return (
			<MainCopyButton
				ariaLabel={`${label} for ${title}`}
				disabledReason={check.allowed ? undefined : check.reason}
				label={label}
				onCopy={() => onRun({ kind: 'copy', stackId: stack.id, what })}
			/>
		);
	};
	const running = stack.state === 'running' || stack.state === 'partial';
	const mailControl = control({
		id: 'open-mailpit',
		label: 'Open Mailpit',
		action: 'open-mailpit',
		operation: { kind: 'open', stackId: stack.id, surface: 'mailpit' },
	});
	const studioControls = supabaseStudioControls(stack, state, context);
	const metroLane = stack.lanes.find((lane) => lane.needsMetroRestart);
	return (
		<div className="supabase-connect">
			<h4 className="supabase-connect-group">API</h4>
			{view.urls.map((url) => (
				<div className="supabase-connect-row" key={url.id}>
					<span>{url.label}</span>
					<code className="supabase-code">{url.value ?? '—'}</code>
					{url.value ? (
						<CopyButton label={`Copy ${url.label}`} value={url.value} />
					) : (
						<span />
					)}
				</div>
			))}
			{stack.apiUrl === undefined ? (
				<DisabledReason id={urlReasonId}>
					{SUPABASE_REASONS.apiUrlUnknown}
				</DisabledReason>
			) : null}
			<h4 className="supabase-connect-group">Database</h4>
			<div className="supabase-connect-row">
				<span>Port</span>
				<span>
					{view.databasePort === undefined
						? '—'
						: `:${view.databasePort} · the local password stays in RN Devtools`}
				</span>
				<span />
			</div>
			<div className="supabase-connect-actions">
				{mainCopy('psql-command', 'Copy psql command')}
			</div>
			<h4 className="supabase-connect-group">Keys</h4>
			<div className="supabase-connect-row">
				<span>Publishable</span>
				<span>{view.publishable.description}</span>
				<span />
			</div>
			<div className="supabase-connect-actions">
				{mainCopy('publishable-key', 'Copy key')}
			</div>
			<div className="supabase-connect-row">
				<span>Secret</span>
				<span>{view.secret}</span>
				<span />
			</div>
			<h4 className="supabase-connect-group">Development tools</h4>
			<div className="supabase-connect-row">
				<span>Mailpit</span>
				<span>
					{view.mailpit.excluded
						? 'excluded'
						: view.mailpit.port === undefined
							? '—'
							: `:${view.mailpit.port}${running ? '' : ' · stopped'}`}
				</span>
				<span>
					{renderControl(mailControl, {
						variant: 'ghost',
						ariaLabel: `Open Mailpit for ${title}`,
					})}
				</span>
			</div>
			<div className="supabase-connect-row">
				<span>Studio</span>
				<span>
					{view.studio.included
						? `on${view.studio.port === undefined ? '' : ` · :${view.studio.port}`}`
						: 'excluded'}
				</span>
				<span className="supabase-connect-buttons">
					{studioControls.map((item) =>
						renderControl(item, {
							variant: 'ghost',
							ariaLabel: `${item.label.replace(/…$/, '')} for ${title}`,
						})
					)}
				</span>
			</div>
			<h4 className="supabase-connect-group">App variables</h4>
			{view.appEnv.length === 0 ? (
				<p className="sim-section-empty">
					No app variables are mapped. Add one in Settings.
				</p>
			) : (
				<ul className="supabase-app-env">
					{view.appEnv.map((entry) => (
						<li key={entry.name}>
							<code className="supabase-code supabase-app-env-entry">
								{entry.name}
							</code>
							<span aria-hidden="true">←</span>
							<span className="sr-only">from</span>
							<code className="supabase-code supabase-app-env-source">
								{entry.source}
							</code>
							{entry.injected ? null : (
								<span className="supabase-fact-note">not injected</span>
							)}
						</li>
					))}
				</ul>
			)}
			<p className="sim-inline-note">{view.footnotes[0]}</p>
			<div className="supabase-connect-actions">
				{mainCopy('app-env', 'Copy app variables')}
			</div>
			{view.envShadow.map((line) => (
				<SupabaseNotice inset key={line} title="Shadowed:" tone="warning">
					{line}
				</SupabaseNotice>
			))}
			{metroLane ? (
				<div className="supabase-connect-metro">
					<p className="sim-inline-note">
						Lane :{metroLane.port}'s Metro started before this stack was ready,
						so its app doesn't have the address yet.
					</p>
					{renderControl(
						control({
							id: 'restart-metro',
							label: 'Restart Metro to attach',
							action: 'restart-metro',
							operation: { kind: 'restart-metro', laneId: metroLane.laneId },
						}),
						{ variant: 'ghost' }
					)}
				</div>
			) : null}
			<p className="sim-inline-note">{view.footnotes[1]}</p>
		</div>
	);
}

function DangerSection({
	stack,
	control,
	renderControl,
}: {
	stack: SupabaseStackSummary;
	control: (
		spec: Parameters<typeof supabaseStackControl>[3]
	) => SupabaseControl;
	renderControl: RenderControl;
}) {
	const resetReasonId = useId();
	const destroyReasonId = useId();
	const reset = (seed: boolean) =>
		control({
			id: seed ? 'reset-seed' : 'reset-no-seed',
			label: seed ? 'Reset to migrations + seed…' : 'Reset without seed…',
			action: 'reset',
			operation: { kind: 'reset', stackId: stack.id, seed },
		});
	const withSeed = reset(true);
	const withoutSeed = reset(false);
	const destroy = control({
		id: 'destroy',
		label: 'Destroy…',
		action: 'destroy',
		operation: { kind: 'destroy', stackIds: [stack.id], removeUploads: false },
	});
	const stop = control({
		id: 'stop',
		label: stack.origin === 'external' ? 'Stop…' : 'Stop',
		action: 'stop',
		operation: { kind: 'stop', stackIds: [stack.id] },
	});
	const migrations = stack.migrationCount;
	return (
		<div className="supabase-danger">
			<section className="sim-danger-zone supabase-danger-row">
				<div>
					<strong>Reset database</strong>
					<span>
						Drops all data and auth users, then re-runs{' '}
						{migrations > 0
							? `${migrations} ${migrations === 1 ? 'migration' : 'migrations'}`
							: 'the migrations'}{' '}
						and the seed (about 5 s). Keeps the stack id, URL, ports and keys.
						No backup is kept.
					</span>
					{withSeed.availability.allowed ? null : (
						<DisabledReason id={resetReasonId}>
							{withSeed.availability.reason}
						</DisabledReason>
					)}
				</div>
				<div className="supabase-danger-actions">
					{renderControl(withSeed, {
						variant: 'ghost',
						reasonPlacement: 'elsewhere',
						...(withSeed.availability.allowed
							? {}
							: { describedBy: resetReasonId }),
					})}
					{renderControl(withoutSeed, {
						variant: 'ghost',
						reasonPlacement: 'elsewhere',
						...(withoutSeed.availability.allowed
							? {}
							: { describedBy: resetReasonId }),
					})}
				</div>
			</section>
			<section className="sim-danger-zone supabase-danger-row">
				<div>
					<strong>Destroy stack</strong>
					{destroy.availability.allowed ? (
						<span>
							Deletes its database and logs and frees 10 ports. Storage uploads
							stay unless you tick the box in the next dialog. This can't be
							undone.
						</span>
					) : (
						<span id={destroyReasonId}>{destroy.availability.reason}</span>
					)}
					{!destroy.availability.allowed &&
					destroy.availability.reason === SUPABASE_REASONS.stopFirst &&
					stop.availability.allowed
						? renderControl(stop, { variant: 'ghost' })
						: null}
				</div>
				<div className="supabase-danger-actions">
					{renderControl(destroy, {
						variant: 'danger',
						reasonPlacement: 'elsewhere',
						...(destroy.availability.allowed
							? {}
							: { describedBy: destroyReasonId }),
						ariaLabel: `Destroy ${supabaseStackTitle(stack)}`,
					})}
				</div>
			</section>
		</div>
	);
}

import { Button } from '@heroui/react/button';
import { NativeSelect } from '@heroui-pro/react/native-select';
import { Timeline } from '@heroui-pro/react/timeline';
import {
	AlertTriangle,
	Check,
	ChevronDown,
	Circle,
	CircleAlert,
	CircleDashed,
	CircleX,
	Copy,
	Database,
	FolderGit2,
	GitCompareArrows,
	Info,
	LoaderCircle,
	Moon,
	Pin,
	RefreshCw,
	ServerOff,
	ShieldAlert,
	Smartphone,
	Square,
	User,
	Waypoints,
} from 'lucide-react';
import {
	type ComponentType,
	type ReactNode,
	useEffect,
	useId,
	useState,
} from 'react';
import { AgentGlyph } from '@/components/lane-ui';
import { statusToneClassName } from '@/components/status-ui';
import {
	Badge,
	ConfirmAction,
	CopyButton,
	DisabledReason,
	StatusDot,
} from '@/components/ui';
import type {
	SupabaseChainLink,
	SupabaseControl,
	SupabaseLogLine,
	SupabaseOpenTarget,
	SupabaseStepView,
} from '@/simulator/supabase-model';
import { holdCountdownLabel } from '../../shared/device-hold';
import {
	type LaneBackendSummary,
	laneBackendChip,
	type SupabaseHold,
	type SupabaseMemberState,
	type SupabaseOperationReceipt,
	type SupabaseStackLane,
	type SupabaseStackStatus,
	type SupabaseStatusIcon,
	serviceStateLabel,
	supabaseAgentLabel,
} from '../../shared/supabase-protocol';

/**
 * Supabase tab primitives. This is the one module that wraps HeroUI Pro's
 * Timeline and NativeSelect for the tab, so the panels stay on shared
 * components. Every status pairs its colour or motion with a word.
 */

type IconComponent = ComponentType<{ className?: string }>;

const STATUS_ICONS: Readonly<
	Partial<Record<SupabaseStatusIcon, IconComponent>>
> = {
	'loader-circle': LoaderCircle,
	'circle-x': CircleX,
	'circle-alert': CircleAlert,
	square: Square,
	'server-off': ServerOff,
	'git-compare-arrows': GitCompareArrows,
	'circle-dashed': CircleDashed,
	'shield-alert': ShieldAlert,
	'refresh-cw': RefreshCw,
};

function StatusGlyph({ status }: { status: SupabaseStackStatus }) {
	if (status.icon === 'status-dot') return <StatusDot tone={status.tone} />;
	if (status.icon === 'hollow-dot') return <StatusDot hollow />;
	if (status.icon === 'status-dot-moon') {
		return (
			<>
				<StatusDot tone={status.tone} />
				<Moon aria-hidden="true" className="h-3 w-3" />
			</>
		);
	}
	const Icon = STATUS_ICONS[status.icon] ?? Circle;
	// The loader turns only while motion is allowed; the word beside it always
	// says what is happening.
	return (
		<Icon
			aria-hidden="true"
			className={`h-3 w-3 ${status.icon === 'loader-circle' ? 'animate-spin' : ''}`}
		/>
	);
}

/** A stack's absolute status from stackStatus(): icon, word and tone. */
export function StackStatePill({ status }: { status: SupabaseStackStatus }) {
	return (
		<span
			className={`sim-state-pill supabase-state-pill is-${status.tone}`}
			title={status.explanation}
		>
			<StatusGlyph status={status} />
			{status.label}
		</span>
	);
}

/**
 * The lane-relative backend chip for Lanes, Fleet and Agents: `db :21734`
 * when the lane has its database, amber without one, red for a refused LAN
 * stack. Hidden while the feature is off.
 */
export function SupabaseChip({
	summary,
	featureEnabled = true,
}: {
	summary: LaneBackendSummary | undefined;
	featureEnabled?: boolean;
}) {
	const chip = featureEnabled ? laneBackendChip(summary) : undefined;
	if (!chip) return null;
	return (
		<Badge className="supabase-chip" tone={chip.tone}>
			{chip.label}
		</Badge>
	);
}

/**
 * Who holds a stack and whether they are still around, worded like
 * Simulator holds: `Claude 9b1e2c00 · live`, `Codex · by worktree`,
 * `You · lane :8102`, `gone · stops in 7 min`. Only agent glyphs carry hue.
 */
export function HolderBadge({
	hold,
	now,
	lanes = [],
	pinned = false,
	clocksPaused = false,
}: {
	hold: SupabaseHold;
	now: number;
	lanes?: readonly SupabaseStackLane[];
	/** The operator hold is a pin rather than a start from the tab. */
	pinned?: boolean;
	clocksPaused?: boolean;
}) {
	if (hold.holder === 'operator') {
		return (
			<span className="holder-badge is-default">
				<Pin aria-hidden="true" className="h-3 w-3" />
				{pinned ? 'You · pinned' : 'You · started here'}
			</span>
		);
	}
	const countdown = holdCountdownLabel(
		{
			live: hold.live,
			releaseAt: hold.releaseAt,
			holder: hold.holder,
			synthetic: hold.agent?.synthetic === true,
		},
		now,
		{ verb: 'stops', clocksPaused }
	);
	const lane =
		hold.holder === 'lane'
			? lanes.find((candidate) => candidate.laneId === hold.laneId)
			: undefined;
	if (!hold.agent) {
		return (
			<span className={`holder-badge is-${countdown.tone}`}>
				<User aria-hidden="true" className="h-3 w-3" />
				{lane ? `You · lane :${lane.port}` : 'You · lane'}
			</span>
		);
	}
	const name = supabaseAgentLabel(hold.agent);
	const duplicate =
		countdown.text === 'by worktree' && name.endsWith('by worktree');
	return (
		<span className={`holder-badge is-${countdown.tone}`}>
			<AgentGlyph kind={hold.agent.kind} />
			<span>{name}</span>
			{duplicate ? null : (
				<output aria-live="off" className="holder-badge-clock">
					· {countdown.text}
				</output>
			)}
		</span>
	);
}

const CHAIN_ICONS: Readonly<Record<SupabaseChainLink['kind'], IconComponent>> =
	{
		agent: User,
		operator: User,
		lane: Waypoints,
		simulator: Smartphone,
		worktree: FolderGit2,
		stack: Database,
	};

/**
 * The "Who holds this" chain on a Timeline: Agent › Lane › Simulator ›
 * Worktree › Stack. Each link opens its target through `onOpen`, with an
 * accessible name that says where it goes.
 */
export function HolderChain({
	links,
	onOpen,
	label = 'Who holds this',
}: {
	links: readonly SupabaseChainLink[];
	onOpen: (target: SupabaseOpenTarget) => void;
	label?: string;
}) {
	return (
		<Timeline
			aria-label={label}
			className="supabase-chain"
			density="compact"
			size="sm"
		>
			{links.map((link) => {
				const Icon = CHAIN_ICONS[link.kind];
				const open = link.open;
				return (
					<Timeline.Item key={`${link.kind}:${link.label}`} status={link.tone}>
						<Timeline.Marker aria-hidden="true">
							{link.agent ? (
								<AgentGlyph kind={link.agent.kind} />
							) : (
								<Icon className="h-3 w-3" />
							)}
						</Timeline.Marker>
						<Timeline.Content>
							<div className="supabase-chain-row">
								<span className="supabase-chain-text">{link.label}</span>
								{open ? (
									<Button
										aria-label={open.label}
										size="sm"
										variant="ghost"
										onPress={() => onOpen(open.target)}
									>
										{open.text}
									</Button>
								) : null}
							</div>
						</Timeline.Content>
					</Timeline.Item>
				);
			})}
		</Timeline>
	);
}

/**
 * One service in the CLI's own words; sleeping shows a static moon.
 */
export function ServiceRow({
	service,
	state,
	health,
	wakeHintMs,
	activation,
	port,
	error,
}: {
	service: string;
	state: SupabaseMemberState | 'excluded';
	health?: 'starting' | 'healthy' | 'unhealthy' | null | undefined;
	wakeHintMs?: number | undefined;
	activation?: 'eager' | 'lazy' | undefined;
	port?: number | undefined;
	error?: string | undefined;
}) {
	const label = serviceStateLabel({ state, health, wakeHintMs });
	return (
		<div className={`supabase-service-row is-${label.tone}`}>
			<code className="supabase-service-name">{service}</code>
			<span className="supabase-service-state">
				{label.icon === 'moon' ? (
					<Moon aria-hidden="true" className="h-3 w-3 shrink-0" />
				) : (
					<StatusDot tone={label.tone} />
				)}
				<span>
					{label.label}
					{activation === 'eager' && state !== 'excluded' ? ' · eager' : ''}
					{error ? ` · ${error}` : ''}
				</span>
			</span>
			<span className="supabase-service-port">
				{port === undefined ? '' : `:${port}`}
			</span>
		</div>
	);
}

const STEP_ICONS: Readonly<Record<SupabaseStepView['state'], IconComponent>> = {
	done: Check,
	current: LoaderCircle,
	pending: Circle,
	failed: CircleX,
	skipped: CircleDashed,
};

const STEP_WORDS: Readonly<Record<SupabaseStepView['state'], string>> = {
	done: 'done',
	current: 'in progress',
	pending: 'waiting',
	failed: 'failed',
	skipped: 'skipped',
};

/**
 * A job's steps on a Timeline. The current step carries aria-current="step",
 * a failed one the danger status, and every step a word as well as its
 * marker. Only step changes are announced, politely.
 */
export function StepList({
	steps,
	label = 'Progress',
	announcement,
}: {
	steps: readonly SupabaseStepView[];
	label?: string;
	/** Usually the current step's label; changes are read out. */
	announcement?: string | undefined;
}) {
	return (
		<div className="supabase-steps">
			<Timeline aria-label={label} density="compact" size="sm">
				{steps.map((step) => {
					const Icon = STEP_ICONS[step.state];
					return (
						<Timeline.Item
							key={step.id}
							status={step.status}
							{...(step.current ? { 'aria-current': 'step' as const } : {})}
						>
							<Timeline.Marker aria-hidden="true">
								<Icon
									className={`h-3 w-3 ${step.state === 'current' ? 'animate-spin' : ''}`}
								/>
							</Timeline.Marker>
							<Timeline.Content>
								<span className="supabase-step-label">
									{step.label}
									<span className="sr-only"> · {STEP_WORDS[step.state]}</span>
								</span>
								{step.detail ? (
									<span className="supabase-step-detail">{step.detail}</span>
								) : null}
							</Timeline.Content>
						</Timeline.Item>
					);
				})}
			</Timeline>
			<p aria-live="polite" className="sr-only">
				{announcement ?? ''}
			</p>
		</div>
	);
}

function highlighted(
	text: string,
	matches: SupabaseLogLine['matches']
): ReactNode {
	if (matches.length === 0) return text;
	const nodes: ReactNode[] = [];
	let cursor = 0;
	for (const [start, end] of matches) {
		if (start > cursor) nodes.push(text.slice(cursor, start));
		nodes.push(<mark key={start}>{text.slice(start, end)}</mark>);
		cursor = end;
	}
	if (cursor < text.length) nodes.push(text.slice(cursor));
	return nodes;
}

/**
 * Main's redacted log lines in one bounded, focusable pre. Markers read
 * like `--- launch 2 ---`, filter matches use mark, and Copy shown copies
 * exactly the visible redacted text.
 */
export function LogView({
	lines,
	label,
	visibleText,
	summary,
	emptyText = 'No log lines in this window.',
}: {
	lines: readonly SupabaseLogLine[];
	/** The pre's name, e.g. `Redacted logs for feat-checkout`. */
	label: string;
	visibleText: string;
	/** `Redacted · 214 lines · 48 KB of 64 KB · read 14:03:05`. */
	summary?: string;
	emptyText?: string;
}) {
	return (
		<div className="supabase-log">
			<pre
				aria-label={label}
				aria-live="off"
				className="supabase-log-output"
				role="log"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling log must be reachable from the keyboard to be read
				tabIndex={0}
			>
				{lines.length === 0 ? (
					<span className="supabase-log-empty">{emptyText}</span>
				) : (
					lines.map((line) => (
						<span
							className={`supabase-log-line ${line.kind === 'marker' ? 'is-marker' : ''}`}
							key={line.key}
						>
							{highlighted(line.text, line.matches)}
							{'\n'}
						</span>
					))
				)}
			</pre>
			<div className="supabase-log-footer">
				{summary ? <span>{summary}</span> : <span />}
				<span className="supabase-log-copy">
					Copy shown
					<CopyButton label="Copy shown log lines" value={visibleText} />
				</span>
			</div>
		</div>
	);
}

type CopyResult = Readonly<{ ok: boolean; clearsAt?: number }>;

/**
 * Asks main to write a value to the clipboard (the key, a psql command, app
 * variables). The value never reaches this window; the receipt only says
 * whether it was copied and when main clears it again.
 */
export function MainCopyButton({
	label,
	ariaLabel,
	onCopy,
	disabledReason,
}: {
	label: string;
	ariaLabel?: string;
	onCopy: () => Promise<
		Pick<SupabaseOperationReceipt, 'completed'> &
			Partial<Pick<SupabaseOperationReceipt, 'copy'>>
	>;
	/** Disables the button and shows why, as visible text. */
	disabledReason?: string | undefined;
}) {
	const reasonId = useId();
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<CopyResult | null>(null);
	useEffect(() => {
		if (!result) return undefined;
		const timer = window.setTimeout(
			() => setResult(null),
			result.ok && result.clearsAt !== undefined ? 4_000 : 1_800
		);
		return () => window.clearTimeout(timer);
	}, [result]);
	const feedback =
		result === null
			? undefined
			: !result.ok
				? 'Copy failed'
				: result.clearsAt === undefined
					? 'Copied'
					: `Copied · clears in ${Math.max(1, Math.round((result.clearsAt - Date.now()) / 1_000))} s`;
	const disabled = busy || disabledReason !== undefined;
	return (
		<>
			<Button
				{...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
				{...(disabledReason === undefined
					? {}
					: { 'aria-describedby': reasonId })}
				isDisabled={disabled}
				size="sm"
				variant="secondary"
				onPress={() => {
					setBusy(true);
					void onCopy()
						.then((receipt) =>
							setResult({
								ok: receipt.completed && receipt.copy?.copied === true,
								...(receipt.copy?.clearsAt === undefined
									? {}
									: { clearsAt: receipt.copy.clearsAt }),
							})
						)
						.catch(() => setResult({ ok: false }))
						.finally(() => setBusy(false));
				}}
			>
				<Copy aria-hidden="true" className="h-3.5 w-3.5" />
				{feedback ?? label}
			</Button>
			{disabledReason === undefined ? null : (
				<DisabledReason id={reasonId}>{disabledReason}</DisabledReason>
			)}
			<span className="sr-only" role="status">
				{feedback ?? ''}
			</span>
		</>
	);
}

/**
 * The tab's select: a NativeSelect with typed values and a visible-reason hook.
 */
export function SupabaseSelect<T extends string>({
	label,
	value,
	options,
	onChange,
	disabled = false,
	describedBy,
	className = '',
}: {
	/** The accessible name; the select has no visible label of its own. */
	label: string;
	value: T;
	options: readonly Readonly<{ value: T; label: string; disabled?: boolean }>[];
	onChange: (value: T) => void;
	disabled?: boolean;
	describedBy?: string | undefined;
	className?: string;
}) {
	return (
		<NativeSelect
			className={`sim-filter-select ${className}`}
			fullWidth={false}
		>
			<NativeSelect.Trigger
				aria-label={label}
				{...(describedBy ? { 'aria-describedby': describedBy } : {})}
				disabled={disabled}
				value={value}
				onChange={(event) => {
					const next = options.find(
						(option) => option.value === event.currentTarget.value
					);
					if (next) onChange(next.value);
				}}
			>
				{options.map((option) => (
					<NativeSelect.Option
						disabled={option.disabled === true}
						key={option.value}
						value={option.value}
					>
						{option.label}
					</NativeSelect.Option>
				))}
				<NativeSelect.Indicator>
					<ChevronDown className="h-3 w-3" />
				</NativeSelect.Indicator>
			</NativeSelect.Trigger>
		</NativeSelect>
	);
}

const NOTICE_ICONS = {
	danger: CircleX,
	warning: AlertTriangle,
	default: Info,
} as const;

/**
 * A must-read Supabase notice: PanelNotice's look, plus its recoveries inline
 * after the text and a trailing slot (the tab's `+N more notices` toggle).
 * Danger reads as an alert, everything else as status; it is never collapsed
 * into a popover the way an info PanelNotice is. `inset` draws it as a box
 * inside the detail pane instead of a full-width band.
 */
export function SupabaseNotice({
	tone,
	title,
	children,
	actions,
	trailing,
	inset = false,
}: {
	tone: 'danger' | 'warning' | 'default';
	title: string;
	children?: ReactNode;
	/** Recovery buttons, read after the text. */
	actions?: ReactNode;
	trailing?: ReactNode;
	inset?: boolean;
}) {
	const Icon = NOTICE_ICONS[tone];
	return (
		<div
			className={`supabase-notice is-${tone} ${inset ? 'is-inset' : ''} ${statusToneClassName[tone]}`}
			role={tone === 'danger' ? 'alert' : 'status'}
		>
			<Icon aria-hidden="true" className="supabase-notice-icon h-3.5 w-3.5" />
			<div className="supabase-notice-copy">
				<strong className="supabase-notice-title">{title}</strong>
				{children ? (
					<span className="supabase-notice-text"> {children}</span>
				) : null}
				{actions ? (
					<span className="supabase-notice-actions">{actions}</span>
				) : null}
			</div>
			{trailing ? (
				<div className="supabase-notice-trailing">{trailing}</div>
			) : null}
		</div>
	);
}

/** The inline prompt's words; see supabaseInlineConfirmCopy. */
type InlineCopy = Readonly<{
	title: string;
	description: string;
	confirmLabel: string;
}>;

/**
 * One Supabase control. A refused control is disabled with its reason as
 * visible text (right after it, or elsewhere through `describedBy`); an
 * inline-confirmed one asks with ConfirmAction first, which is never shown
 * in front of a native dialog; anything else runs at once (main shows its
 * own dialog when it guards the operation, so those labels end in `…`).
 */
export function SupabaseControlButton({
	control,
	onRun,
	icon,
	variant = 'secondary',
	ariaLabel,
	inlineCopy,
	describedBy,
	reasonPlacement = 'after',
	tone = 'warning',
	className = '',
	isBusy = false,
}: {
	control: Pick<SupabaseControl, 'label' | 'availability' | 'confirmation'>;
	onRun: () => void;
	icon?: ReactNode;
	variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
	/** Names the target when the label alone is ambiguous: `Stop feat-x`. */
	ariaLabel?: string | undefined;
	inlineCopy?: InlineCopy | undefined;
	/** The id of the visible reason when it is rendered elsewhere. */
	describedBy?: string | undefined;
	reasonPlacement?: 'after' | 'elsewhere';
	tone?: 'warning' | 'danger';
	className?: string;
	/** Shows progress without refusing: the control's own operation runs. */
	isBusy?: boolean;
}) {
	const reasonId = useId();
	const { availability, confirmation } = control;
	if (!availability.allowed || isBusy) {
		const ownReason = !availability.allowed && reasonPlacement === 'after';
		const describedByIds =
			[describedBy, ownReason ? reasonId : undefined]
				.filter((id): id is string => id !== undefined)
				.join(' ') || undefined;
		return (
			<>
				<Button
					{...(describedByIds ? { 'aria-describedby': describedByIds } : {})}
					{...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
					className={className}
					isDisabled
					size="sm"
					variant={variant}
				>
					{isBusy ? (
						<LoaderCircle
							aria-hidden="true"
							className="h-3.5 w-3.5 animate-spin"
						/>
					) : (
						icon
					)}
					{control.label}
				</Button>
				{ownReason ? (
					<DisabledReason id={reasonId}>{availability.reason}</DisabledReason>
				) : null}
			</>
		);
	}
	if (confirmation.kind === 'inline' && inlineCopy) {
		return (
			<ConfirmAction
				{...(ariaLabel ? { ariaLabel } : {})}
				{...(describedBy ? { describedBy } : {})}
				confirmLabel={inlineCopy.confirmLabel}
				description={inlineCopy.description}
				title={inlineCopy.title}
				tone={tone}
				triggerIcon={icon}
				triggerLabel={control.label}
				triggerVariant={variant}
				onConfirm={onRun}
			/>
		);
	}
	return (
		<Button
			{...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
			{...(describedBy ? { 'aria-describedby': describedBy } : {})}
			className={className}
			size="sm"
			variant={variant}
			onPress={onRun}
		>
			{icon}
			{control.label}
		</Button>
	);
}

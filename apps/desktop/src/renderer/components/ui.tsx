import { AlertDialog } from '@heroui/react/alert-dialog';
import { Button } from '@heroui/react/button';
import { Popover } from '@heroui/react/popover';
import { SearchField } from '@heroui/react/search-field';
import { Tooltip } from '@heroui/react/tooltip';
import { EmptyState } from '@heroui-pro/react/empty-state';
import {
	AlertTriangle,
	ChevronRight,
	CircleX,
	Copy,
	Info,
	Search,
	X,
} from 'lucide-react';
import {
	type ComponentType,
	type ReactNode,
	useEffect,
	useId,
	useState,
} from 'react';
import { StatusPill, statusToneClassName } from '@/components/status-ui';
import { copyText } from '@/lib/format';

export { StatusPill };

export function InfoPopover({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<Popover>
			<Button
				aria-label={`About ${label}`}
				className="info-button"
				isIconOnly
				variant="ghost"
			>
				<Info aria-hidden="true" className="h-4 w-4" />
			</Button>
			<Popover.Content className="info-popover" placement="bottom start">
				<Popover.Dialog>
					<Popover.Heading>{label}</Popover.Heading>
					<div className="info-popover-copy">{children}</div>
				</Popover.Dialog>
			</Popover.Content>
		</Popover>
	);
}

/**
 * A native details/summary section. Uncontrolled by default (`defaultOpen`);
 * pass `open` with `onToggle` to keep the open state elsewhere, such as per
 * stack in a provider. Keyboard behaviour stays the browser's either way.
 */
export function Disclosure({
	title,
	children,
	defaultOpen = false,
	open,
	onToggle,
	meta,
}: {
	title: ReactNode;
	children: ReactNode;
	defaultOpen?: boolean;
	/** Controlled open state; pair it with `onToggle`. */
	open?: boolean;
	onToggle?: (open: boolean) => void;
	/** Trailing summary text, such as when the section was last read. */
	meta?: ReactNode;
}) {
	const controlled = open !== undefined;
	return (
		<details
			className="panel-disclosure"
			open={controlled ? open : defaultOpen || undefined}
			onToggle={
				onToggle
					? (event) => {
							const next = event.currentTarget.open;
							// Setting `open` from props fires toggle too; only report
							// what the person changed.
							if (!controlled || next !== open) onToggle(next);
						}
					: undefined
			}
		>
			<summary>
				<ChevronRight aria-hidden="true" className="h-4 w-4" />
				<span className="panel-disclosure-title">{title}</span>
				{meta ? <span className="panel-disclosure-meta">{meta}</span> : null}
			</summary>
			<div className="panel-disclosure-content">{children}</div>
		</details>
	);
}

export function PanelHeader({
	title,
	description,
	meta,
	actions,
}: {
	title: string;
	description: string;
	meta?: ReactNode;
	actions?: ReactNode;
}) {
	return (
		<header className="panel-header">
			<div className="panel-heading">
				<h1 className="m-0 text-lg font-semibold tracking-[-0.01em] text-(--foreground)">
					{title}
				</h1>
				<InfoPopover label={title}>{description}</InfoPopover>
				{meta ? <span className="panel-heading-meta">{meta}</span> : null}
			</div>
			{actions ? <div className="panel-header-actions">{actions}</div> : null}
		</header>
	);
}

export function Toolbar({ children }: { children: ReactNode }) {
	return <div className="panel-toolbar">{children}</div>;
}

export function PanelNotice({
	title,
	children,
	tone = 'warning',
}: {
	title: string;
	children: ReactNode;
	tone?: 'warning' | 'danger' | 'info';
}) {
	if (tone === 'info') {
		return (
			<div className="panel-info-note">
				<span>{title.replace(/\.$/, '')}</span>
				<InfoPopover label={title.replace(/\.$/, '')}>{children}</InfoPopover>
			</div>
		);
	}
	const Icon = tone === 'danger' ? CircleX : AlertTriangle;
	return (
		<div
			className={`flex shrink-0 items-start gap-2 border-b px-4 py-2.5 text-xs leading-5 ${statusToneClassName[tone]}`}
			role={tone === 'danger' ? 'alert' : 'status'}
		>
			<Icon aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
			<div className="min-w-0">
				<strong className="mr-1.5 font-semibold">{title}</strong>
				<span className="break-words">{children}</span>
			</div>
		</div>
	);
}

export function SearchControl({
	value,
	onChange,
	placeholder = 'Search',
	ariaLabel = 'Search',
	className = '',
	widthClassName = 'w-[260px]',
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	ariaLabel?: string;
	className?: string;
	/** Tailwind width classes, e.g. a narrower field below 1080 px. */
	widthClassName?: string;
}) {
	return (
		<SearchField
			aria-label={ariaLabel}
			className={`${widthClassName} ${className}`}
			value={value}
			onChange={onChange}
		>
			<SearchField.Group className="h-8 rounded-md border border-foreground/10 bg-background/30 shadow-none transition-colors focus-within:border-foreground/25">
				<Search
					className="ml-2.5 h-3.5 w-3.5 text-(--text-3)"
					aria-hidden="true"
				/>
				<SearchField.Input
					className="h-full min-w-0 flex-1 bg-transparent px-2 text-sm text-(--foreground) outline-none placeholder:text-(--text-3)"
					placeholder={placeholder}
				/>
				<SearchField.ClearButton className="mr-1 grid h-6 w-6 place-items-center rounded text-(--text-3) hover:bg-foreground/8 hover:text-(--foreground)">
					<X className="h-3.5 w-3.5" />
				</SearchField.ClearButton>
			</SearchField.Group>
		</SearchField>
	);
}

export function EmptyPanel({
	icon,
	title,
	description,
	action,
	compact = false,
}: {
	icon?: ReactNode;
	title: string;
	description: string;
	action?: ReactNode;
	compact?: boolean;
}) {
	return (
		<EmptyState
			className={`mx-auto max-w-md justify-center text-center ${compact ? '' : 'min-h-[360px]'}`}
			size={compact ? 'sm' : 'lg'}
			style={compact ? { minHeight: '100%' } : undefined}
		>
			<EmptyState.Header>
				{icon ? (
					<EmptyState.Media variant="icon">{icon}</EmptyState.Media>
				) : null}
				<EmptyState.Title className="text-base text-(--foreground)">
					{title}
				</EmptyState.Title>
				<EmptyState.Description className="text-xs leading-5 text-(--muted)">
					{description}
				</EmptyState.Description>
			</EmptyState.Header>
			{action ? <EmptyState.Content>{action}</EmptyState.Content> : null}
		</EmptyState>
	);
}

export function CodePreview({
	value,
	label,
	maxHeight = 320,
	actions,
}: {
	value: string | undefined;
	label?: string;
	maxHeight?: number;
	/** Controls beside Copy in the label row, such as a format toggle. */
	actions?: ReactNode;
}) {
	if (value === undefined) {
		return <p className="text-xs text-(--text-3)">No captured value.</p>;
	}
	const displayValue = value.length === 0 ? '∅ (empty string)' : value;
	return (
		<div className="overflow-hidden rounded-md border border-foreground/8 bg-background/35">
			{label ? (
				<div className="flex h-8 items-center justify-between border-b border-foreground/8 px-3 font-mono text-xs uppercase tracking-[0.06em] text-(--text-3)">
					<span>{label}</span>
					<span className="flex items-center gap-2 normal-case tracking-normal">
						{actions}
						<CopyButton value={value} />
					</span>
				</div>
			) : null}
			<pre
				className="m-0 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-[1.65] text-text-soft"
				style={{ maxHeight }}
			>
				{displayValue}
			</pre>
		</div>
	);
}

export function CopyButton({
	value,
	label = 'Copy',
}: {
	value: string;
	label?: string;
}) {
	const [lastCopy, setLastCopy] = useState<{
		value: string;
		ok: boolean;
	} | null>(null);
	const result = lastCopy?.value === value ? lastCopy.ok : undefined;
	const feedback =
		result === true ? 'Copied' : result === false ? 'Copy failed' : label;
	useEffect(() => {
		if (!lastCopy || lastCopy.value !== value) return;
		const timer = window.setTimeout(() => setLastCopy(null), 1_800);
		return () => window.clearTimeout(timer);
	}, [lastCopy, value]);
	return (
		<Tooltip delay={400}>
			<Button
				aria-label={feedback}
				className="h-6 min-w-6 rounded p-0 text-(--text-3) hover:bg-foreground/8 hover:text-(--foreground)"
				isIconOnly
				variant="ghost"
				onPress={() => {
					void copyText(value).then((ok) => setLastCopy({ value, ok }));
				}}
			>
				<Copy className="h-3.5 w-3.5" />
			</Button>
			<Tooltip.Content>{feedback}</Tooltip.Content>
		</Tooltip>
	);
}

export function KeyValue({
	label,
	value,
	mono = false,
}: {
	label: string;
	value: ReactNode;
	mono?: boolean;
}) {
	return (
		<div className="grid grid-cols-[132px_minmax(0,1fr)] gap-4 border-b border-foreground/[0.06] py-2.5 last:border-0">
			<dt className="text-xs text-(--text-3)">{label}</dt>
			<dd
				className={`m-0 min-w-0 break-words text-xs text-(--foreground) ${mono ? 'font-mono text-xs' : ''}`}
			>
				{value}
			</dd>
		</div>
	);
}

export function ConfirmAction({
	triggerLabel,
	title,
	description,
	confirmLabel,
	onConfirm,
	tone = 'danger',
	triggerVariant = 'ghost',
	triggerIcon,
	isDisabled = false,
	describedBy,
	disabledReason,
	ariaLabel,
}: {
	triggerLabel: string;
	title: string;
	description: string;
	confirmLabel: string;
	onConfirm: () => void;
	tone?: 'warning' | 'danger';
	triggerVariant?: 'ghost' | 'secondary' | 'primary' | 'danger';
	triggerIcon?: ReactNode;
	isDisabled?: boolean;
	/**
	 * The id of visible text that explains the trigger, such as a
	 * DisabledReason rendered under the action row. Kept on both branches.
	 */
	describedBy?: string;
	/**
	 * Disables the trigger and shows why, as visible text right after it.
	 * The reason is never left to a tooltip.
	 */
	disabledReason?: string;
	/** Names the trigger when its label alone is ambiguous, e.g. `Stop feat-x`. */
	ariaLabel?: string;
}) {
	const reasonId = useId();
	const Icon = tone === 'danger' ? CircleX : AlertTriangle;
	const disabled = isDisabled || disabledReason !== undefined;
	if (disabled) {
		const describedByIds =
			[describedBy, disabledReason === undefined ? undefined : reasonId]
				.filter((id): id is string => id !== undefined)
				.join(' ') || undefined;
		return (
			<>
				<Button
					{...(describedByIds ? { 'aria-describedby': describedByIds } : {})}
					{...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
					isDisabled
					size="sm"
					variant={triggerVariant}
				>
					{triggerIcon}
					{triggerLabel}
				</Button>
				{disabledReason === undefined ? null : (
					<DisabledReason id={reasonId}>{disabledReason}</DisabledReason>
				)}
			</>
		);
	}
	return (
		<AlertDialog>
			<AlertDialog.Trigger
				{...(describedBy ? { 'aria-describedby': describedBy } : {})}
				{...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
				className={`button button--sm button--${triggerVariant}`}
			>
				{triggerIcon}
				{triggerLabel}
			</AlertDialog.Trigger>
			<AlertDialog.Backdrop className="bg-black/40 backdrop-blur-sm dark:bg-black/70">
				<AlertDialog.Container className="border border-foreground/12 bg-overlay shadow-2xl">
					<AlertDialog.Dialog>
						<AlertDialog.Header>
							<AlertDialog.Icon status={tone}>
								<Icon className="h-5 w-5" />
							</AlertDialog.Icon>
							<AlertDialog.Heading>{title}</AlertDialog.Heading>
						</AlertDialog.Header>
						<AlertDialog.Body>{description}</AlertDialog.Body>
						<AlertDialog.Footer>
							<Button size="sm" slot="close" variant="ghost">
								Cancel
							</Button>
							<Button
								{...(tone === 'warning'
									? {
											className:
												'bg-warning text-warning-foreground hover:bg-warning/90',
										}
									: {})}
								onPress={onConfirm}
								size="sm"
								slot="close"
								variant={tone === 'danger' ? 'danger' : 'primary'}
							>
								{confirmLabel}
							</Button>
						</AlertDialog.Footer>
					</AlertDialog.Dialog>
				</AlertDialog.Container>
			</AlertDialog.Backdrop>
		</AlertDialog>
	);
}

/**
 * The one status dot. It never carries meaning alone: a word always sits
 * beside it, so the dot is hidden from assistive technology.
 */
export function StatusDot({
	tone = 'default',
	hollow = false,
	className = '',
}: {
	tone?: 'default' | 'success' | 'info' | 'warning' | 'danger';
	/** An outline only, for something that does not exist yet. */
	hollow?: boolean;
	className?: string;
}) {
	return (
		<span
			aria-hidden="true"
			className={`status-dot is-${tone} ${hollow ? 'is-hollow' : ''} ${className}`}
		/>
	);
}

/**
 * Why a control is disabled, as visible text. Give the control
 * `aria-describedby={id}` so the reason is read with it.
 */
export function DisabledReason({
	id,
	children,
}: {
	id: string;
	children: ReactNode;
}) {
	return (
		<span className="disabled-reason" id={id}>
			<Info
				aria-hidden="true"
				className="disabled-reason-icon h-3 w-3 shrink-0"
			/>
			<span>{children}</span>
		</span>
	);
}

/**
 * A block-layout card for something waiting on a decision, such as an agent's
 * request. Unlike PanelNotice, whose body is an inline span, it holds facts,
 * a quoted note and a row of actions.
 */
export function RequestCard({
	tone = 'warning',
	title,
	meta,
	children,
	actions,
}: {
	tone?: 'warning' | 'danger' | 'default';
	title: ReactNode;
	/** Trailing header text, such as the request's age. */
	meta?: ReactNode;
	children?: ReactNode;
	actions?: ReactNode;
}) {
	const Icon =
		tone === 'danger' ? CircleX : tone === 'warning' ? AlertTriangle : Info;
	return (
		<article className={`request-card is-${tone}`}>
			<header className="request-card-header">
				<Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
				<strong className="request-card-title">{title}</strong>
				{meta ? <span className="request-card-meta">{meta}</span> : null}
			</header>
			{children ? <div className="request-card-body">{children}</div> : null}
			{actions ? <div className="request-card-actions">{actions}</div> : null}
		</article>
	);
}

export type ReadinessStatus =
	| 'ready'
	| 'needs-fix'
	| 'check'
	| 'optional'
	| 'checking';

const READINESS_PILLS: Readonly<
	Record<
		ReadinessStatus,
		{ label: string; tone: 'success' | 'warning' | 'default' }
	>
> = {
	ready: { label: 'Ready', tone: 'success' },
	'needs-fix': { label: 'Needs fix', tone: 'warning' },
	check: { label: 'Check', tone: 'warning' },
	optional: { label: 'Optional', tone: 'default' },
	checking: { label: 'Checking', tone: 'default' },
};

/**
 * One readiness check: an icon, a label with an optional About popover and
 * tag, a summary or next step, file and line facts, a copy-only fix, and a
 * status pill with actions. Simulator capabilities, repository checks and
 * the global Local Supabase row all use it.
 */
export function ReadinessRow({
	icon: Icon,
	label,
	status,
	statusLabel,
	tag,
	info,
	detail,
	lines,
	fix,
	actions,
}: {
	icon: ComponentType<{ className?: string }>;
	label: string;
	status: ReadinessStatus;
	/** Replaces the pill's word, e.g. `Needs setup` or `On · 3 running`. */
	statusLabel?: string;
	/** A small tag beside the label, such as Required or Optional. */
	tag?: string;
	/** The About popover's body; without it there is no popover. */
	info?: ReactNode;
	/** The line under the label: a summary or the next step. */
	detail?: ReactNode;
	/** File and line facts, such as a pinned port in a config file. */
	lines?: readonly { file: string; line: number; text: string }[];
	/** Copy-only: RN Devtools never edits repository files. */
	fix?: { text: string; snippet?: string | undefined };
	actions?: ReactNode;
}) {
	const pill = READINESS_PILLS[status];
	return (
		<div className="sim-capability-row" data-status={status}>
			<span className="sim-capability-icon">
				<Icon className="h-4 w-4" />
			</span>
			<div className="sim-capability-copy">
				<div>
					<strong>{label}</strong>
					{info ? <InfoPopover label={label}>{info}</InfoPopover> : null}
					{tag ? <span>{tag}</span> : null}
				</div>
				{detail ? <p className="sim-capability-next-step">{detail}</p> : null}
				{lines && lines.length > 0 ? (
					<ul className="readiness-lines">
						{lines.map((line, index) => (
							<li key={`${line.file}:${line.line}:${index}`}>
								<code className="readiness-line-file">
									{line.file}:{line.line}
								</code>
								<span className="readiness-line-text">{line.text}</span>
							</li>
						))}
					</ul>
				) : null}
				{fix ? (
					<div className="readiness-fix">
						<p className="readiness-fix-text">{fix.text}</p>
						{fix.snippet ? (
							<div className="readiness-snippet">
								<pre>{fix.snippet}</pre>
								<CopyButton label="Copy snippet" value={fix.snippet} />
							</div>
						) : null}
					</div>
				) : null}
			</div>
			<div className="sim-capability-action">
				<StatusPill tone={pill.tone}>{statusLabel ?? pill.label}</StatusPill>
				{actions}
			</div>
		</div>
	);
}

export function DetailPlaceholder({
	label = 'Select a row to inspect',
}: {
	label?: string;
}) {
	return (
		<div className="grid h-full place-items-center p-8 text-center">
			<div>
				<ChevronRight className="mx-auto mb-3 h-5 w-5 text-foreground/20" />
				<p className="m-0 text-xs text-(--text-3)">{label}</p>
			</div>
		</div>
	);
}

/**
 * Compact semantic label. Prefer this over hand-rolled `border … bg … text …`
 * spans so tone tints stay consistent across panels. `StatusPill` is the
 * mono/uppercase status variant; `Badge` is the softer sentence-case label used
 * for categories and counts.
 */
export function Badge({
	children,
	tone = 'default',
	className = '',
}: {
	children: ReactNode;
	tone?: 'default' | 'brand' | 'success' | 'warning' | 'danger' | 'info';
	className?: string;
}) {
	return <span className={`ui-badge is-${tone} ${className}`}>{children}</span>;
}

/** Inline monospace token for ids, keys, paths, and small code fragments. */
export function InlineCode({
	children,
	className = '',
}: {
	children: ReactNode;
	className?: string;
}) {
	return <code className={`ui-inline-code ${className}`}>{children}</code>;
}

/**
 * Bordered content region with an optional header row. Standardizes the
 * hairline card used throughout the panels (title + optional actions + body)
 * so sections do not each re-derive border/padding/spacing.
 */
export function SectionCard({
	title,
	icon,
	actions,
	children,
	className = '',
	bodyClassName = '',
}: {
	title?: ReactNode;
	icon?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
	className?: string;
	bodyClassName?: string;
}) {
	return (
		<section className={`ui-section-card ${className}`}>
			{title ? (
				<header className="ui-section-card-header">
					<div className="ui-section-card-title">
						{icon ? (
							<span aria-hidden="true" className="ui-section-card-icon">
								{icon}
							</span>
						) : null}
						<span>{title}</span>
					</div>
					{actions ? (
						<div className="ui-section-card-actions">{actions}</div>
					) : null}
				</header>
			) : null}
			<div className={`ui-section-card-body ${bodyClassName}`}>{children}</div>
		</section>
	);
}

/**
 * Loading placeholder. Use in place of a blank region while a projection or
 * native probe is still resolving, so panels share one shimmer treatment.
 */
export function Skeleton({
	className = '',
	rounded = 'sm',
}: {
	className?: string;
	rounded?: 'sm' | 'full';
}) {
	return (
		<span
			aria-hidden="true"
			className={`ui-skeleton is-${rounded} ${className}`}
		/>
	);
}

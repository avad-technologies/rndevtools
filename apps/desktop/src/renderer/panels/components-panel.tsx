import { Button } from '@heroui/react/button';
import { Input } from '@heroui/react/input';
import { NativeSelect } from '@heroui-pro/react/native-select';
import {
	BadgeCheck,
	BoxSelect,
	ChevronDown,
	Clock3,
	Crosshair,
	FileCode2,
	Focus,
	Keyboard,
	MousePointerClick,
	Move,
	RefreshCw,
	ShieldCheck,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
	Badge,
	CodePreview,
	EmptyPanel,
	InlineCode,
	KeyValue,
	PanelHeader,
	PanelNotice,
	SearchControl,
	SectionCard,
	StatusPill,
	Toolbar,
} from '@/components/ui';
import { useDesktopRuntime } from '@/state/desktop-runtime';
import type { ComponentTarget } from '../../shared/protocol';

const MAX_RENDERED_TARGETS = 250;

const KIND_TONE: Record<
	string,
	'default' | 'brand' | 'info' | 'success' | 'warning'
> = {
	screen: 'info',
	component: 'default',
	overlay: 'brand',
};

export function canMutateSemanticTarget(
	target: Pick<ComponentTarget, 'isFocused'> | null,
	screenHash: string | undefined
): boolean {
	return target?.isFocused === true && Boolean(screenHash);
}

function boundsStyle(
	bounds: NonNullable<ComponentTarget['bounds']>,
	viewport: { width: number; height: number }
) {
	const clampPercent = (value: number) => Math.max(0, Math.min(100, value));
	const left = clampPercent((bounds.x / viewport.width) * 100);
	const top = clampPercent((bounds.y / viewport.height) * 100);
	const right = clampPercent(
		((bounds.x + bounds.width) / viewport.width) * 100
	);
	const bottom = clampPercent(
		((bounds.y + bounds.height) / viewport.height) * 100
	);
	return {
		left: `${left}%`,
		top: `${top}%`,
		width: `${Math.max(0, right - left)}%`,
		height: `${Math.max(0, bottom - top)}%`,
	};
}

export function ComponentsPanel() {
	const { canRunAction, actionUnavailableReason, selectedDevice, runAction } =
		useDesktopRuntime();
	const targets = selectedDevice?.tools.components ?? [];
	const renderEvents = selectedDevice?.tools.componentRenders ?? [];
	const summary = selectedDevice?.tools.componentSummary;
	const [query, setQuery] = useState('');
	const [selectedId, setSelectedId] = useState<string | null>(
		targets[0]?.id ?? null
	);
	const [textInput, setTextInput] = useState('');
	const [scrollDirection, setScrollDirection] = useState<
		'up' | 'down' | 'left' | 'right'
	>('down');
	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return targets.filter(
			(target) =>
				!needle ||
				[
					target.name,
					target.targetId,
					target.parentId,
					target.kind,
					target.feature,
					target.route,
					target.testID,
					target.targetKey,
					target.accessibilityLabel,
					target.accessibilityHint,
					target.accessibilityRole,
					target.accessibilityValue,
					...target.sourceFiles,
				]
					.join(' ')
					.toLowerCase()
					.includes(needle)
		);
	}, [query, targets]);
	const visibleTargets = filtered.slice(0, MAX_RENDERED_TARGETS);
	const selected =
		visibleTargets.find((target) => target.id === selectedId) ??
		visibleTargets[0] ??
		null;
	const selectedRenderEvents = useMemo(
		() =>
			selected
				? renderEvents
						.filter((event) => event.targetId === selected.id)
						.slice(-20)
						.reverse()
				: [],
		[renderEvents, selected]
	);
	const currentScreenHash = selected?.screenHash ?? summary?.screenHash;
	const semanticActions = selected?.actions ?? [];
	const semanticMutationEnabled = canMutateSemanticTarget(
		selected,
		currentScreenHash
	);
	const shortenedInstanceCount = targets.filter(
		(target) => target.instanceTruncated
	).length;
	const reportedViewport = selectedDevice?.info.viewport ?? {
		width: 393,
		height: 852,
	};
	const viewport = {
		width: Math.max(1, Math.min(100_000, reportedViewport.width)),
		height: Math.max(1, Math.min(100_000, reportedViewport.height)),
	};
	const mapped = visibleTargets.filter((target) => {
		const bounds = target.bounds;
		return (
			bounds !== null &&
			bounds.width > 0 &&
			bounds.height > 0 &&
			bounds.x < viewport.width &&
			bounds.y < viewport.height &&
			bounds.x + bounds.width > 0 &&
			bounds.y + bounds.height > 0
		);
	});

	// Resolve a single, human-readable reason for a gated semantic mutation so a
	// disabled control always explains itself (device/capability/screen-hash).
	function semanticReason(
		command: string,
		action: 'activate' | 'focus' | 'setText' | 'scroll'
	): string | null {
		const runtimeReason = actionUnavailableReason('components', command);
		if (runtimeReason) return runtimeReason;
		if (!selected?.isFocused) {
			return 'The target is not currently visible on device.';
		}
		if (!currentScreenHash) {
			return 'No current screen hash is bound to this snapshot.';
		}
		if (!semanticActions.includes(action)) {
			return `This target does not advertise the ${action} action.`;
		}
		return null;
	}

	const highlightReason = selected?.isFocused
		? actionUnavailableReason('components', 'highlight')
		: 'The target is not currently visible on device.';

	return (
		<section className="panel-root">
			<PanelHeader
				title="Components"
				description="Inspect only components the app explicitly registers, with stable target keys, source locations, safe instance projections, and optional measured bounds."
				meta={
					<Badge tone="brand">
						<ShieldCheck className="h-3 w-3" /> Targeted registry
					</Badge>
				}
				actions={
					<Button
						isDisabled={!canRunAction('components', 'refresh')}
						size="sm"
						variant="secondary"
						onPress={() =>
							void runAction(
								'components',
								'refresh',
								{},
								'Component targets refreshed.'
							)
						}
					>
						<RefreshCw className="h-3.5 w-3.5" /> Refresh targets
					</Button>
				}
			/>
			<Toolbar>
				<SearchControl
					ariaLabel="Search component targets"
					placeholder="Component, feature, route, test ID…"
					value={query}
					onChange={setQuery}
				/>
				<div className="ml-auto flex items-center gap-3 font-mono text-xs text-(--text-3)">
					<span title={currentScreenHash ?? 'Not reported'}>
						Screen{' '}
						{currentScreenHash
							? currentScreenHash.slice(0, 10)
							: 'v1 / unknown'}
					</span>
					<span className="text-foreground/15">/</span>
					<span>
						{targets.length} of {summary?.sourceTargetCount ?? targets.length}{' '}
						registered
					</span>
					<span className="text-foreground/15">/</span>
					<span>{mapped.length} mapped in viewport</span>
				</div>
			</Toolbar>
			{summary && (summary.truncated || summary.error) ? (
				<PanelNotice
					title="Component capture incomplete."
					tone={summary.error ? 'danger' : 'warning'}
				>
					{summary.error ??
						`${summary.omittedTargetCount} ${summary.omittedTargetCount === 1 ? 'target was' : 'targets were'} invalid, duplicated, or omitted by the on-device safety budget.`}
				</PanelNotice>
			) : null}
			{(summary?.registrationDiagnostics?.length ?? 0) > 0 ? (
				<PanelNotice
					title="Component registration needs attention."
					tone="warning"
				>
					{(summary?.registrationDiagnostics ?? [])
						.slice(0, 5)
						.map((diagnostic) => diagnostic.message)
						.join(' ')}
				</PanelNotice>
			) : null}
			{shortenedInstanceCount > 0 ? (
				<PanelNotice title="Some instance projections were shortened.">
					{shortenedInstanceCount} safe instance projection
					{shortenedInstanceCount === 1 ? ' was' : 's were'} sanitized or
					truncated to stay within the on-device privacy and size limits.
				</PanelNotice>
			) : null}
			{filtered.length > visibleTargets.length ? (
				<PanelNotice title="Desktop target rendering is bounded." tone="info">
					Search covers all {filtered.length} matching targets; the list and
					coordinate map render the first {MAX_RENDERED_TARGETS} to keep
					inspection responsive.
				</PanelNotice>
			) : null}
			{selected && semanticActions.length === 0 ? (
				<PanelNotice title="Semantic actions are not advertised." tone="info">
					This snapshot remains fully inspectable, but it may come from a v1
					client or a target that did not opt into activate, focus, text, or
					scroll actions.
				</PanelNotice>
			) : null}
			<div className="grid min-h-0 flex-1 grid-cols-[300px_minmax(320px,.9fr)_minmax(360px,1.1fr)] max-[1160px]:grid-cols-[280px_minmax(320px,1fr)]">
				<div className="panel-scroll border-r border-foreground/8 p-3">
					{filtered.length === 0 ? (
						<EmptyPanel
							icon={<BoxSelect className="h-5 w-5" />}
							title="No matching targets"
							description="Register an explicit target or broaden your search."
						/>
					) : (
						<div className="space-y-1.5">
							{visibleTargets.map((target) => (
								<button
									aria-pressed={selected?.id === target.id}
									className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${selected?.id === target.id ? 'border-(--brand-border) bg-(--brand-soft)' : 'border-foreground/[0.06] bg-foreground/[0.02] hover:border-foreground/12 hover:bg-foreground/[0.04]'}`}
									key={target.id}
									type="button"
									onClick={() => setSelectedId(target.id)}
								>
									<div className="flex items-center justify-between gap-3">
										<span className="truncate text-xs font-medium text-(--foreground)">
											{target.name}
										</span>
										<Badge tone={KIND_TONE[target.kind] ?? 'default'}>
											{target.kind}
										</Badge>
									</div>
									<p className="mb-0 mt-1.5 truncate font-mono text-xs text-(--text-3)">
										{target.route ?? target.feature ?? 'No route'}
									</p>
									<div className="mt-2 flex items-center gap-2 text-xs text-(--text-3)">
										{target.bounds ? (
											<Crosshair className="h-3 w-3 text-(--brand-text)" />
										) : null}
										<span className="truncate">
											{target.testID ?? target.targetKey ?? target.id}
										</span>
									</div>
								</button>
							))}
						</div>
					)}
				</div>

				<div className="panel-scroll border-r border-foreground/8 p-5 max-[1160px]:hidden">
					<div className="mb-4">
						<p className="m-0 text-xs uppercase tracking-[0.08em] text-(--text-3)">
							Measured coordinate map
						</p>
						<p className="mb-0 mt-1 text-xs leading-4 text-(--muted)">
							A bounds map from explicit measurements—not a live screen
							recording.
						</p>
					</div>
					<div className="mx-auto w-full max-w-[306px] rounded-[34px] border border-white/15 bg-[#050505] p-2 shadow-[0_20px_80px_rgba(0,0,0,.45)]">
						<div
							className="relative overflow-hidden rounded-[27px] border border-white/8 bg-[#0d0d0d]"
							style={{ aspectRatio: `${viewport.width} / ${viewport.height}` }}
						>
							<div className="absolute left-1/2 top-2 z-20 h-5 w-20 -translate-x-1/2 rounded-full bg-black" />
							<div className="absolute inset-x-0 top-0 h-[11%] border-b border-white/[0.05] bg-white/[0.025]" />
							<div className="absolute inset-x-[4%] top-[14%] h-[14%] rounded-lg border border-white/[0.05] bg-white/[0.025]" />
							<div className="absolute inset-x-[4%] top-[31%] h-[36%] rounded-lg border border-white/[0.05] bg-white/[0.025]" />
							<div className="absolute inset-x-[4%] bottom-[4%] h-[12%] rounded-xl border border-white/[0.05] bg-white/[0.025]" />
							{mapped.map((target) => {
								const isSelected = target.id === selected?.id;
								return target.bounds ? (
									<button
										aria-label={`Inspect ${target.name}`}
										aria-pressed={isSelected}
										className={`absolute z-10 border transition-colors ${isSelected ? 'border-(--brand) bg-(--brand-soft) shadow-[0_0_0_1px_var(--brand-border)]' : 'border-(--brand-border) bg-(--brand-soft) hover:bg-[color-mix(in_srgb,var(--brand)_16%,transparent)]'}`}
										key={target.id}
										style={boundsStyle(target.bounds, viewport)}
										type="button"
										onClick={() => setSelectedId(target.id)}
									>
										{isSelected ? (
											<span className="absolute -top-5 left-0 whitespace-nowrap rounded-sm bg-(--brand) px-1.5 py-0.5 font-mono text-xs font-semibold text-black">
												{target.name}
											</span>
										) : null}
									</button>
								) : null;
							})}
						</div>
					</div>
				</div>

				<div className="panel-scroll p-5">
					{selected ? (
						<div className="space-y-4">
							<div className="flex items-start justify-between gap-4">
								<div>
									<p className="m-0 text-xs uppercase tracking-[0.08em] text-(--text-3)">
										Selected target
									</p>
									<h2 className="mb-0 mt-1 text-base font-semibold tracking-[-0.025em] text-(--foreground)">
										{selected.name}
									</h2>
								</div>
								<Badge tone={selected.isFocused ? 'success' : 'default'}>
									{selected.isFocused ? 'Focused' : 'Background'}
								</Badge>
							</div>
							<SectionCard>
								<dl>
									<KeyValue label="Kind" value={selected.kind} />
									<KeyValue label="Instance ID" value={selected.id} mono />
									<KeyValue
										label="Target ID"
										value={selected.targetId ?? selected.id}
										mono
									/>
									<KeyValue
										label="Parent instance"
										value={selected.parentId ?? '—'}
										mono
									/>
									<KeyValue
										label="Depth / z-index"
										value={`${selected.depth ?? 0} / ${selected.zIndex ?? 0}`}
										mono
									/>
									<KeyValue
										label="Feature"
										value={selected.feature ?? '—'}
										mono
									/>
									<KeyValue label="Route" value={selected.route ?? '—'} mono />
									<KeyValue
										label="Test ID"
										value={selected.testID ?? '—'}
										mono
									/>
									<KeyValue
										label="Target key"
										value={selected.targetKey ?? '—'}
										mono
									/>
									<KeyValue
										label="Screen hash"
										value={currentScreenHash ?? 'Not reported (v1 snapshot)'}
										mono
									/>
									<KeyValue
										label="Bounds"
										mono
										value={
											selected.bounds
												? `${selected.bounds.x}, ${selected.bounds.y} · ${selected.bounds.width} × ${selected.bounds.height}`
												: 'Not measured'
										}
									/>
								</dl>
							</SectionCard>
							{selectedRenderEvents.length > 0 ? (
								<SectionCard
									icon={<Clock3 />}
									title="Recent renders"
									bodyClassName="space-y-2"
								>
									{selectedRenderEvents.map((event) => (
										<div
											className="flex items-center justify-between gap-3 rounded-md border border-foreground/[0.06] bg-background/10 px-2.5 py-2"
											key={event.id}
										>
											<div className="min-w-0">
												<p className="m-0 truncate text-xs font-medium text-(--foreground)">
													{event.phase} · {event.cause}
												</p>
												<p className="mb-0 mt-1 font-mono text-xs text-(--text-3)">
													Render #{event.renderCount} · base{' '}
													{event.baseDuration.toFixed(1)} ms
												</p>
											</div>
											<StatusPill
												tone={
													event.actualDuration >= 16 ? 'warning' : 'success'
												}
											>
												{event.actualDuration.toFixed(1)} ms
											</StatusPill>
										</div>
									))}
								</SectionCard>
							) : null}
							{selected.styleText ? (
								<CodePreview
									label={
										selected.styleTruncated
											? 'Safe styles · shortened'
											: 'Safe styles'
									}
									value={selected.styleText}
								/>
							) : null}
							<div>
								<Button
									fullWidth
									isDisabled={
										!selected.isFocused ||
										!canRunAction('components', 'highlight')
									}
									variant="secondary"
									onPress={() =>
										void runAction(
											'components',
											'highlight',
											{ id: selected.id },
											`Highlighted ${selected.name} on device.`
										)
									}
								>
									<Crosshair className="h-3.5 w-3.5" />
									{selected.isFocused
										? 'Highlight on device'
										: 'Target is not currently visible'}
								</Button>
								{highlightReason ? (
									<p className="mb-0 mt-1.5 text-xs leading-4 text-(--text-3)">
										{highlightReason}
									</p>
								) : null}
							</div>
							<SectionCard
								icon={<BadgeCheck />}
								title="Accessibility semantics"
							>
								<dl>
									<KeyValue
										label="Label"
										value={selected.accessibilityLabel ?? '—'}
									/>
									<KeyValue
										label="Hint"
										value={selected.accessibilityHint ?? '—'}
									/>
									<KeyValue
										label="Role"
										value={selected.accessibilityRole ?? '—'}
										mono
									/>
									<KeyValue
										label="Value"
										value={selected.accessibilityValue ?? '—'}
									/>
									<KeyValue
										label="State"
										value={
											selected.accessibilityState
												? JSON.stringify(selected.accessibilityState)
												: '—'
										}
										mono
									/>
								</dl>
							</SectionCard>
							<SectionCard
								title="Semantic actions"
								actions={
									<Badge tone={currentScreenHash ? 'success' : 'warning'}>
										{currentScreenHash ? 'Snapshot bound' : 'Hash required'}
									</Badge>
								}
							>
								<p className="m-0 text-xs leading-4 text-(--text-3)">
									{selected.isFocused
										? 'Every mutation is bound to the exact current screen hash.'
										: "Open this target's route before using semantic mutations."}
								</p>
								<div className="mt-3 flex flex-wrap gap-2">
									<Button
										isDisabled={
											!semanticMutationEnabled ||
											!semanticActions.includes('activate') ||
											!canRunAction('components', 'activate')
										}
										size="sm"
										variant="secondary"
										onPress={() =>
											void runAction(
												'components',
												'activate',
												{ id: selected.id, screenHash: currentScreenHash },
												`Activated ${selected.name}.`
											)
										}
									>
										<MousePointerClick className="h-3.5 w-3.5" /> Activate
									</Button>
									<Button
										isDisabled={
											!semanticMutationEnabled ||
											!semanticActions.includes('focus') ||
											!canRunAction('components', 'focus')
										}
										size="sm"
										variant="secondary"
										onPress={() =>
											void runAction(
												'components',
												'focus',
												{ id: selected.id, screenHash: currentScreenHash },
												`Focused ${selected.name}.`
											)
										}
									>
										<Focus className="h-3.5 w-3.5" /> Focus
									</Button>
									<Button
										isDisabled={
											!currentScreenHash ||
											!canRunAction('components', 'waitForElement')
										}
										size="sm"
										variant="ghost"
										onPress={() =>
											void runAction(
												'components',
												'waitForElement',
												{ id: selected.id, timeoutMs: 3_000 },
												`${selected.name} appeared.`
											)
										}
									>
										<Clock3 className="h-3.5 w-3.5" /> Wait for element
									</Button>
									<Button
										isDisabled={
											!currentScreenHash ||
											!canRunAction('components', 'waitForScreenChange')
										}
										size="sm"
										variant="ghost"
										onPress={() =>
											void runAction(
												'components',
												'waitForScreenChange',
												{ screenHash: currentScreenHash, timeoutMs: 3_000 },
												'Screen changed.'
											)
										}
									>
										<Clock3 className="h-3.5 w-3.5" /> Wait for change
									</Button>
								</div>
								<div className="mt-3 flex gap-2">
									<Input
										aria-label={`Text for ${selected.name}`}
										placeholder="Text to enter (empty clears)"
										value={textInput}
										onChange={(event) =>
											setTextInput(event.currentTarget.value)
										}
									/>
									<Button
										isDisabled={
											!semanticMutationEnabled ||
											!semanticActions.includes('setText') ||
											!canRunAction('components', 'setText')
										}
										size="sm"
										variant="secondary"
										onPress={() =>
											void runAction(
												'components',
												'setText',
												{
													id: selected.id,
													screenHash: currentScreenHash,
													text: textInput,
												},
												`Updated text for ${selected.name}.`
											)
										}
									>
										<Keyboard className="h-3.5 w-3.5" /> Set text
									</Button>
								</div>
								<div className="mt-2 flex gap-2">
									<NativeSelect className="sim-filter-select" fullWidth={false}>
										<NativeSelect.Trigger
											aria-label="Scroll direction"
											value={scrollDirection}
											onChange={(event) =>
												setScrollDirection(
													event.currentTarget.value as typeof scrollDirection
												)
											}
										>
											{(['up', 'down', 'left', 'right'] as const).map(
												(direction) => (
													<NativeSelect.Option
														key={direction}
														value={direction}
													>
														{direction}
													</NativeSelect.Option>
												)
											)}
											<NativeSelect.Indicator>
												<ChevronDown className="h-3 w-3" />
											</NativeSelect.Indicator>
										</NativeSelect.Trigger>
									</NativeSelect>
									<Button
										isDisabled={
											!semanticMutationEnabled ||
											!semanticActions.includes('scroll') ||
											!canRunAction('components', 'scroll')
										}
										size="sm"
										variant="secondary"
										onPress={() =>
											void runAction(
												'components',
												'scroll',
												{
													id: selected.id,
													screenHash: currentScreenHash,
													direction: scrollDirection,
													amount: 0.75,
												},
												`Scrolled ${selected.name} ${scrollDirection}.`
											)
										}
									>
										<Move className="h-3.5 w-3.5" /> Scroll 75%
									</Button>
								</div>
								{(() => {
									const reason = semanticReason('activate', 'activate');
									return reason ? (
										<p
											className="mb-0 mt-3 text-xs leading-4 text-(--text-3)"
											role="note"
										>
											Semantic mutations are disabled: {reason}
										</p>
									) : null;
								})()}
							</SectionCard>
							<SectionCard icon={<FileCode2 />} title="Source">
								{selected.sourceFiles.length === 0 ? (
									<span className="text-xs text-(--text-3)">Not reported</span>
								) : (
									<div className="space-y-1.5">
										{selected.sourceFiles.map((file) => (
											<InlineCode className="block" key={file}>
												{file}
											</InlineCode>
										))}
									</div>
								)}
							</SectionCard>
							<CodePreview
								label="Safe instance projection"
								value={selected.instanceText}
								maxHeight={340}
							/>
						</div>
					) : (
						<EmptyPanel
							icon={<Focus className="h-5 w-5" />}
							title="Select a target"
							description="Choose an explicitly registered component to inspect its safe projection."
						/>
					)}
				</div>
			</div>
		</section>
	);
}

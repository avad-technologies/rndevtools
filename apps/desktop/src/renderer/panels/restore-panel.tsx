import { Button } from '@heroui/react/button';
import { Input } from '@heroui/react/input';
import { Label } from '@heroui/react/label';
import { TextField } from '@heroui/react/textfield';
import {
	ArchiveRestore,
	Camera,
	Check,
	Clock3,
	Copy,
	Pencil,
	ShieldCheck,
	Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
	Badge,
	CodePreview,
	ConfirmAction,
	EmptyPanel,
	InlineCode,
	PanelHeader,
	SectionCard,
	StatusPill,
} from '@/components/ui';
import { formatBytes, formatRelativeTime } from '@/lib/format';
import { useDesktopRuntime } from '@/state/desktop-runtime';

export function RestorePanel() {
	const { canRunAction, actionUnavailableReason, selectedDevice, runAction } =
		useDesktopRuntime();
	const rawPoints = selectedDevice?.tools.restorePoints ?? [];
	const restoreReceipts = selectedDevice?.tools.restoreReceipts ?? [];
	const points = useMemo(
		() =>
			[...rawPoints].sort((left, right) => right.createdAt - left.createdAt),
		[rawPoints]
	);
	const [label, setLabel] = useState('Before desktop changes');
	const [selectedId, setSelectedId] = useState<string | null>(
		points[0]?.id ?? null
	);
	const [sourceSelections, setSourceSelections] = useState<
		Readonly<Record<string, readonly string[]>>
	>({});
	const [pointLabels, setPointLabels] = useState<
		Readonly<Record<string, string>>
	>({});
	const selected =
		points.find((point) => point.id === selectedId) ?? points[0] ?? null;
	const selectedSourceIds = selected
		? (sourceSelections[selected.id] ??
			selected.sources.map((source) => source.id))
		: [];
	const selectedReceipts = selected
		? restoreReceipts
				.filter((receipt) => receipt.pointId === selected.id)
				.sort((left, right) => right.completedAt - left.completedAt)
		: [];
	const pointLabelDraft = selected
		? (pointLabels[selected.id] ?? selected.label)
		: '';

	return (
		<section className="panel-root">
			<PanelHeader
				title="Restore Points"
				description="Persist, selectively restore, and roll back only state sources the app explicitly declares as safe."
				meta={
					<Badge tone="success">
						<ShieldCheck className="h-3 w-3" /> Rollback guarded · explicit
						sources
					</Badge>
				}
			/>
			<div className="grid min-h-0 flex-1 grid-cols-[360px_minmax(0,1fr)]">
				<div className="panel-scroll border-r border-foreground/8 p-4">
					<div className="mb-4 rounded-lg border border-foreground/10 bg-foreground/[0.035] p-4">
						<div className="mb-3 flex items-center gap-2">
							<div className="grid h-8 w-8 place-items-center rounded-md border border-(--brand-border) bg-(--brand-soft) text-(--brand-text)">
								<Camera className="h-3.5 w-3.5" />
							</div>
							<div>
								<h2 className="m-0 text-xs font-semibold text-(--foreground)">
									New checkpoint
								</h2>
								<p className="mb-0 mt-0.5 text-xs text-(--text-3)">
									Explicit safe sources only
								</p>
							</div>
						</div>
						<TextField fullWidth value={label} onChange={setLabel}>
							<Label className="mb-1.5 text-xs text-(--muted)">
								Checkpoint label
							</Label>
							<Input
								className="h-9 rounded-md border border-foreground/10 bg-background/30 px-3 text-xs text-(--foreground)"
								maxLength={120}
								placeholder="Before testing empty state"
							/>
						</TextField>
						<Button
							className="mt-3"
							fullWidth
							isDisabled={!label.trim() || !canRunAction('restore', 'capture')}
							size="sm"
							variant="primary"
							onPress={() => {
								setSelectedId(null);
								void runAction(
									'restore',
									'capture',
									{ label: label.trim() },
									'Restore point captured.'
								);
							}}
						>
							<Camera className="h-3.5 w-3.5" /> Capture current state
						</Button>
						<div className="mt-2 flex items-center justify-end gap-3">
							{actionUnavailableReason('restore', 'resetBaseline') ? (
								<span className="text-right text-xs text-(--text-3)">
									{actionUnavailableReason('restore', 'resetBaseline')}
								</span>
							) : null}
							<ConfirmAction
								triggerLabel="Reset explicit baselines"
								title="Reset explicit sources to baseline?"
								description="Only sources that explicitly implement a baseline reset will change. Rollback data is captured before the first mutation."
								confirmLabel="Reset state"
								isDisabled={!canRunAction('restore', 'resetBaseline')}
								tone="warning"
								triggerVariant="secondary"
								onConfirm={() =>
									void runAction(
										'restore',
										'resetBaseline',
										{},
										'Explicit sources reset to baseline.'
									)
								}
							/>
						</div>
					</div>
					<div className="mb-2 flex items-center justify-between px-1">
						<span className="text-xs uppercase tracking-[0.08em] text-(--text-3)">
							Checkpoints
						</span>
						<span className="font-mono text-xs text-(--text-3)">
							{points.length}
						</span>
					</div>
					{points.length === 0 ? (
						<EmptyPanel
							icon={<Clock3 className="h-5 w-5" />}
							title="No restore points"
							description="Capture the explicit developer state before testing risky scenarios."
						/>
					) : (
						<div className="space-y-2">
							{points.map((point) => (
								<button
									aria-pressed={selected?.id === point.id}
									className={`w-full rounded-lg border p-3 text-left transition-colors ${selected?.id === point.id ? 'border-foreground/18 bg-foreground/[0.07]' : 'border-foreground/[0.06] bg-foreground/[0.02] hover:border-foreground/12 hover:bg-foreground/[0.04]'}`}
									key={point.id}
									type="button"
									onClick={() => setSelectedId(point.id)}
								>
									<div className="flex items-start gap-3">
										<div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md border border-(--brand-border) bg-(--brand-soft) text-(--brand-text)">
											<ArchiveRestore className="h-3.5 w-3.5" />
										</div>
										<div className="min-w-0 flex-1">
											<p className="m-0 truncate text-xs font-medium text-(--foreground)">
												{point.label}
											</p>
											<p className="mb-0 mt-1 text-xs text-(--text-3)">
												{formatRelativeTime(point.createdAt)} ·{' '}
												{formatBytes(point.estimatedBytes)}
											</p>
										</div>
									</div>
								</button>
							))}
						</div>
					)}
				</div>
				<div className="panel-scroll p-6">
					{selected ? (
						<div className="mx-auto max-w-3xl">
							<div className="mb-5 flex items-start justify-between gap-5">
								<div>
									<div className="mb-2 flex items-center gap-2">
										<StatusPill tone="success" dot>
											Captured
										</StatusPill>
										<span className="text-xs text-(--text-3)">
											{formatRelativeTime(selected.createdAt)}
										</span>
									</div>
									<h2 className="m-0 text-xl font-semibold tracking-[-0.035em] text-(--foreground)">
										{selected.label}
									</h2>
									<TextField
										className="mt-2"
										value={pointLabelDraft}
										onChange={(value) =>
											setPointLabels((current) => ({
												...current,
												[selected.id]: value,
											}))
										}
									>
										<Label className="sr-only">Restore point label</Label>
										<Input
											className="h-8 w-72 rounded-md border border-foreground/10 bg-background/30 px-2 text-xs text-(--foreground)"
											maxLength={120}
										/>
									</TextField>
								</div>
								<div className="flex flex-wrap justify-end gap-2">
									<Button
										isDisabled={
											!pointLabelDraft.trim() ||
											pointLabelDraft.trim() === selected.label ||
											!canRunAction('restore', 'rename')
										}
										size="sm"
										variant="tertiary"
										onPress={() =>
											void runAction(
												'restore',
												'rename',
												{ id: selected.id, label: pointLabelDraft.trim() },
												'Restore point renamed.'
											)
										}
									>
										<Pencil className="h-3.5 w-3.5" /> Rename
									</Button>
									<Button
										isDisabled={!canRunAction('restore', 'duplicate')}
										size="sm"
										variant="tertiary"
										onPress={() =>
											void runAction(
												'restore',
												'duplicate',
												{ id: selected.id, label: `${selected.label} copy` },
												'Restore point duplicated.'
											)
										}
									>
										<Copy className="h-3.5 w-3.5" /> Duplicate
									</Button>
									<ConfirmAction
										triggerLabel="Delete"
										triggerIcon={<Trash2 className="h-3.5 w-3.5" />}
										title="Delete this restore point?"
										description="The persisted snapshot will be removed from the dedicated devtools namespace. This cannot be undone."
										confirmLabel="Delete point"
										isDisabled={!canRunAction('restore', 'remove')}
										onConfirm={() => {
											setSelectedId(null);
											void runAction(
												'restore',
												'remove',
												{ id: selected.id },
												'Restore point deleted.'
											);
										}}
									/>
									<ConfirmAction
										triggerLabel="Restore"
										triggerIcon={<ArchiveRestore className="h-3.5 w-3.5" />}
										triggerVariant="secondary"
										tone="warning"
										title="Restore explicit developer state?"
										description={`The app will preflight ${selectedSourceIds.length} selected source${selectedSourceIds.length === 1 ? '' : 's'}, include required dependencies, capture rollback data, then apply in dependency order. User data, authentication, and secure storage remain excluded.`}
										confirmLabel="Restore selected"
										isDisabled={
											selectedSourceIds.length === 0 ||
											!canRunAction('restore', 'restore')
										}
										onConfirm={() =>
											void runAction(
												'restore',
												'restore',
												{ id: selected.id, sourceIds: selectedSourceIds },
												'Explicit developer state restored.'
											)
										}
									/>
								</div>
							</div>
							{(() => {
								const reasons = [
									['Rename', actionUnavailableReason('restore', 'rename')],
									[
										'Duplicate',
										actionUnavailableReason('restore', 'duplicate'),
									],
									['Restore', actionUnavailableReason('restore', 'restore')],
								].filter(([, reason]) => reason) as [string, string][];
								if (reasons.length === 0) return null;
								return (
									<p className="-mt-2 mb-4 text-right text-xs text-(--text-3)">
										{reasons
											.map(([label, reason]) => `${label}: ${reason}`)
											.join(' · ')}
									</p>
								);
							})()}
							<div className="mb-5 grid grid-cols-3 overflow-hidden rounded-lg border border-foreground/8 bg-foreground/[0.025]">
								<div className="border-r border-foreground/8 p-4">
									<p className="m-0 text-xs uppercase tracking-[0.08em] text-(--text-3)">
										Sources
									</p>
									<p className="mb-0 mt-1 font-mono text-lg text-(--foreground)">
										{selected.sources.length}
									</p>
								</div>
								<div className="border-r border-foreground/8 p-4">
									<p className="m-0 text-xs uppercase tracking-[0.08em] text-(--text-3)">
										Size
									</p>
									<p className="mb-0 mt-1 font-mono text-lg text-(--foreground)">
										{formatBytes(selected.estimatedBytes)}
									</p>
								</div>
								<div className="p-4">
									<p className="m-0 text-xs uppercase tracking-[0.08em] text-(--text-3)">
										Lifetime
									</p>
									<p className="mb-0 mt-1 font-mono text-lg text-(--foreground)">
										Persistent
									</p>
								</div>
							</div>
							<div className="space-y-4">
								{selected.sources.map((source) => {
									const isSelected = selectedSourceIds.includes(source.id);
									return (
										<div
											className={`rounded-lg border p-4 ${isSelected ? 'border-(--brand-border) bg-(--brand-soft)' : 'border-foreground/8 bg-foreground/[0.02] opacity-60'}`}
											key={source.id}
										>
											<div className="mb-3 flex items-center justify-between gap-3">
												<div>
													<h3 className="m-0 text-xs font-semibold text-(--foreground)">
														{source.title}
													</h3>
													<p className="mb-0 mt-1">
														<InlineCode>{source.id}</InlineCode>
													</p>
												</div>
												<div className="flex items-center gap-2">
													<StatusPill tone={isSelected ? 'success' : 'default'}>
														{formatBytes(source.bytes)}
													</StatusPill>
													<Button
														aria-pressed={isSelected}
														size="sm"
														variant="tertiary"
														onPress={() =>
															setSourceSelections((current) => ({
																...current,
																[selected.id]: isSelected
																	? selectedSourceIds.filter(
																			(id) => id !== source.id
																		)
																	: [...selectedSourceIds, source.id],
															}))
														}
													>
														{isSelected ? (
															<Check className="h-3.5 w-3.5" />
														) : null}
														{isSelected ? 'Included' : 'Include'}
													</Button>
												</div>
											</div>
											<CodePreview
												label="Canonical JSON preview"
												value={source.preview}
												maxHeight={320}
											/>
										</div>
									);
								})}
							</div>
							{selectedReceipts[0] ? (
								<div className="mt-5">
									<SectionCard
										title="Latest transaction"
										actions={
											<StatusPill
												tone={
													selectedReceipts[0].status === 'complete'
														? 'success'
														: selectedReceipts[0].status === 'needs-attention'
															? 'danger'
															: 'warning'
												}
											>
												{selectedReceipts[0].status}
											</StatusPill>
										}
									>
										<div className="space-y-1 text-xs text-(--text-3)">
											{selectedReceipts[0].sourceResults.map((result) => (
												<p className="m-0" key={result.sourceId}>
													{result.sourceTitle}: preflight {result.preflight},
													apply {result.apply}, rollback {result.rollback}
												</p>
											))}
										</div>
									</SectionCard>
								</div>
							) : null}
							<div className="mt-5 rounded-lg border border-(--brand-border) bg-(--brand-soft) p-4">
								<div className="flex items-center gap-2 text-xs font-medium text-(--brand-text)">
									<ShieldCheck className="h-4 w-4" /> Restore safety boundary
								</div>
								<p className="mb-0 mt-2 text-xs leading-5 text-(--muted)">
									Snapshots are JSON-bounded and validated before writes. If a
									later source fails, the app attempts to reapply the captured
									rollback data. Secure storage and app user data are not
									included.
								</p>
							</div>
						</div>
					) : (
						<EmptyPanel
							icon={<ArchiveRestore className="h-5 w-5" />}
							title="Select a restore point"
							description="Review its exact source boundary before restoring it on device."
						/>
					)}
				</div>
			</div>
		</section>
	);
}

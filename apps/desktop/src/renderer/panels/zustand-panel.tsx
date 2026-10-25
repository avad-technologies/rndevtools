import { Button } from '@heroui/react/button';
import { TextArea } from '@heroui/react/textarea';
import {
	Camera,
	Eye,
	History,
	RefreshCw,
	RotateCcw,
	Save,
	ShieldCheck,
	Store,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
	Badge,
	CodePreview,
	ConfirmAction,
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
import { formatClock, formatRelativeTime } from '@/lib/format';
import { useDesktopRuntime } from '@/state/desktop-runtime';

const MAX_RENDERED_CHANGES = 250;

export function ZustandPanel() {
	const { canRunAction, selectedDevice, runAction } = useDesktopRuntime();
	const stores = selectedDevice?.tools.zustandStores ?? [];
	const changes = selectedDevice?.tools.zustandChanges ?? [];
	const stateSnapshots = selectedDevice?.tools.zustandStateSnapshots ?? [];
	const mutationReceipts = selectedDevice?.tools.zustandMutationReceipts ?? [];
	const summary = selectedDevice?.tools.zustandSummary;
	const [query, setQuery] = useState('');
	const [selectedId, setSelectedId] = useState<string | null>(
		stores[0]?.id ?? null
	);
	const [patchDrafts, setPatchDrafts] = useState<Record<string, string>>({});
	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return stores.filter(
			(store) =>
				!needle ||
				[
					store.title,
					store.description,
					store.id,
					store.keys.join(' '),
					store.stateText,
				]
					.join(' ')
					.toLowerCase()
					.includes(needle)
		);
	}, [query, stores]);
	const selected =
		filtered.find((store) => store.id === selectedId) ?? filtered[0] ?? null;
	const allSelectedChanges = changes
		.filter((change) => selected && change.storeId === selected.id)
		.sort((left, right) => right.at - left.at);
	const selectedChanges = allSelectedChanges.slice(0, MAX_RENDERED_CHANGES);
	const selectedSnapshots = stateSnapshots
		.filter((snapshot) => selected && snapshot.storeId === selected.id)
		.sort((left, right) => right.createdAt - left.createdAt);
	const selectedReceipts = mutationReceipts
		.filter((receipt) => selected && receipt.storeId === selected.id)
		.sort((left, right) => right.completedAt - left.completedAt)
		.slice(0, 20);
	const patchDraft = selected ? (patchDrafts[selected.id] ?? '{}') : '{}';

	return (
		<section className="panel-root">
			<PanelHeader
				title="Zustand"
				description="Explicit privacy-safe projections, with validated reversible edits only for stores that opt in—never a blind global store crawl."
				meta={
					<Badge tone="success">
						<ShieldCheck className="h-3 w-3" /> Registered stores
					</Badge>
				}
				actions={
					<Button
						isDisabled={!canRunAction('zustand', 'refresh')}
						size="sm"
						variant="secondary"
						onPress={() =>
							void runAction(
								'zustand',
								'refresh',
								{},
								'Zustand projections refreshed.'
							)
						}
					>
						<RefreshCw className="h-3.5 w-3.5" /> Refresh projection
					</Button>
				}
			/>
			<Toolbar>
				<SearchControl
					ariaLabel="Search Zustand stores"
					placeholder="Store, key, projected value…"
					value={query}
					onChange={setQuery}
				/>
				<span className="ml-auto font-mono text-xs text-(--text-3)">
					{stores.length} of {summary?.totalStoreCount ?? stores.length}{' '}
					registered stores · {changes.length} changes
				</span>
			</Toolbar>
			{summary && (summary.truncated || summary.error) ? (
				<PanelNotice
					title="Zustand projection incomplete."
					tone={summary.error ? 'danger' : 'warning'}
				>
					{summary.error ??
						`${summary.omittedStoreCount} ${summary.omittedStoreCount === 1 ? 'store was' : 'stores were'} omitted by the on-device safety budget.`}
				</PanelNotice>
			) : null}
			{allSelectedChanges.length > selectedChanges.length ? (
				<PanelNotice title="Change timeline rendering is bounded." tone="info">
					Showing the newest {MAX_RENDERED_CHANGES} of{' '}
					{allSelectedChanges.length} captured changes for this store.
				</PanelNotice>
			) : null}
			<div className="zustand-layout grid min-h-0 flex-1 grid-cols-[300px_minmax(360px,1fr)_340px]">
				<div className="panel-scroll border-r border-foreground/8 p-3">
					{filtered.length === 0 ? (
						<EmptyPanel
							icon={<Store className="h-5 w-5" />}
							title="No matching stores"
							description="Only stores registered by the connected app appear here."
						/>
					) : (
						<div className="space-y-2">
							{filtered.map((store) => (
								<button
									aria-pressed={selected?.id === store.id}
									className={`w-full rounded-lg border p-3 text-left transition-colors ${selected?.id === store.id ? 'border-foreground/18 bg-foreground/[0.07]' : 'border-foreground/[0.06] bg-foreground/[0.02] hover:border-foreground/12 hover:bg-foreground/[0.04]'}`}
									key={store.id}
									type="button"
									onClick={() => setSelectedId(store.id)}
								>
									<div className="flex items-center justify-between gap-3">
										<span className="truncate text-xs font-medium text-(--foreground)">
											{store.title}
										</span>
										<Badge
											tone={
												store.error
													? 'danger'
													: store.capabilities.restorable
														? 'brand'
														: 'default'
											}
										>
											{store.error
												? 'Error'
												: store.capabilities.restorable
													? 'Reversible'
													: 'Read only'}
										</Badge>
									</div>
									<p className="mb-0 mt-1.5 line-clamp-2 text-xs leading-4 text-(--text-3)">
										{store.description ??
											'Explicit Zustand diagnostic projection'}
									</p>
									<div className="mt-3 flex items-center justify-between font-mono text-xs text-(--text-3)">
										<span>{store.keys.length} keys</span>
										<span>{formatRelativeTime(store.updatedAt)}</span>
									</div>
								</button>
							))}
						</div>
					)}
				</div>
				<div className="panel-scroll border-r border-foreground/8 p-5">
					{selected ? (
						<>
							<div className="mb-4 flex items-start justify-between gap-4">
								<div>
									<p className="m-0 text-xs uppercase tracking-[0.08em] text-(--text-3)">
										Store projection
									</p>
									<h2 className="mb-0 mt-1 text-base font-semibold tracking-[-0.02em] text-(--foreground)">
										{selected.title}
									</h2>
								</div>
								<div className="flex items-center gap-1.5 text-xs text-(--text-3)">
									<Eye className="h-3.5 w-3.5" />{' '}
									{selected.capabilities.restorable
										? 'Reversible edits'
										: 'Read only'}
								</div>
							</div>
							<dl className="mb-4 rounded-lg border border-foreground/8 bg-foreground/[0.02] px-3">
								<KeyValue label="Registry id" value={selected.id} mono />
								<KeyValue
									label="Projected keys"
									value={selected.keys.length}
									mono
								/>
								<KeyValue
									label="Last change"
									value={formatRelativeTime(selected.updatedAt)}
								/>
								<KeyValue
									label="Persistence"
									value={
										selected.capabilities.persisted
											? 'Persisted'
											: 'Memory only'
									}
								/>
							</dl>
							<CodePreview
								label="Current projected state"
								value={selected.stateText}
								maxHeight={520}
							/>
							{selected.error ? (
								<div
									className="mt-4 rounded-md border border-danger/20 bg-danger/[0.06] p-3 text-xs text-danger-text"
									role="alert"
								>
									{selected.error}
								</div>
							) : null}
							{selected.capabilities.restorable ? (
								<div className="mt-4">
									<SectionCard
										title="Validated JSON patch"
										actions={
											<Button
												isDisabled={!canRunAction('zustand', 'capture')}
												size="sm"
												variant="secondary"
												onPress={() =>
													void runAction(
														'zustand',
														'capture',
														{ storeId: selected.id },
														'Zustand state captured.'
													)
												}
											>
												<Camera className="h-3.5 w-3.5" /> Capture state
											</Button>
										}
									>
										<TextArea
											aria-label={`JSON patch for ${selected.title}`}
											className="min-h-32 w-full rounded-md border border-foreground/10 bg-background/30 p-3 font-mono text-xs leading-5 text-(--foreground) outline-none focus:border-foreground/25"
											value={patchDraft}
											onChange={(event) => {
												if (!selected) return;
												const value = event.currentTarget.value;
												setPatchDrafts((current) => ({
													...current,
													[selected.id]: value,
												}));
											}}
										/>
										<div className="mt-3 flex items-center justify-end gap-3">
											{!patchDraft.trim() ? (
												<span className="text-xs text-(--text-3)">
													Enter a JSON patch to apply.
												</span>
											) : null}
											<ConfirmAction
												confirmLabel="Apply patch"
												description="The connected app validates the patch, applies it to the live store and verifies it. The current state is checkpointed first, so Restore can undo it."
												isDisabled={
													!canRunAction('zustand', 'patch') ||
													!patchDraft.trim()
												}
												title={`Apply this patch to ${selected.title}?`}
												tone="warning"
												triggerIcon={<Save className="h-3.5 w-3.5" />}
												triggerLabel="Apply patch"
												triggerVariant="primary"
												onConfirm={() =>
													void runAction(
														'zustand',
														'patch',
														{ storeId: selected.id, patchText: patchDraft },
														'Zustand patch applied and verified.'
													)
												}
											/>
										</div>
										{selectedSnapshots.length > 0 ? (
											<div className="mt-4 border-t border-(--separator) pt-3">
												<p className="mb-2 mt-0 text-xs uppercase tracking-[0.08em] text-(--text-3)">
													Captured states
												</p>
												<div className="space-y-2">
													{selectedSnapshots.slice(0, 5).map((snapshot) => (
														<div
															className="flex items-center justify-between gap-3 rounded border border-(--border) px-2.5 py-2"
															key={snapshot.id}
														>
															<span className="font-mono text-xs text-(--text-3)">
																{formatClock(snapshot.createdAt)} ·{' '}
																{snapshot.stateBytes} B
															</span>
															<ConfirmAction
																ariaLabel={`Restore the state captured at ${formatClock(snapshot.createdAt)}`}
																confirmLabel="Restore"
																description={`Restore the state captured at ${formatClock(snapshot.createdAt)}? The current state is checkpointed first.`}
																isDisabled={!canRunAction('zustand', 'jump')}
																title={`Restore ${selected.title}?`}
																tone="warning"
																triggerIcon={
																	<RotateCcw className="h-3.5 w-3.5" />
																}
																triggerLabel="Restore"
																triggerVariant="secondary"
																onConfirm={() =>
																	void runAction(
																		'zustand',
																		'jump',
																		{
																			storeId: selected.id,
																			snapshotId: snapshot.id,
																		},
																		'Zustand state restored and verified.'
																	)
																}
															/>
														</div>
													))}
												</div>
											</div>
										) : null}
									</SectionCard>
								</div>
							) : null}
							<div className="mt-4 flex flex-wrap gap-1.5">
								{selected.keys.map((key) => (
									<InlineCode key={key}>{key}</InlineCode>
								))}
							</div>
						</>
					) : (
						<EmptyPanel
							icon={<Store className="h-5 w-5" />}
							title="Select a store"
							description="Choose a visible projection to inspect its state and change history."
						/>
					)}
				</div>
				<aside className="zustand-timeline panel-scroll p-4">
					<div className="mb-4 flex items-center justify-between">
						<div className="flex items-center gap-2 text-xs uppercase tracking-[0.08em] text-(--text-3)">
							<History className="h-3.5 w-3.5" /> Change timeline
						</div>
						<span className="font-mono text-xs text-(--text-3)">
							{selectedChanges.length}
						</span>
					</div>
					{selectedChanges.length === 0 ? (
						<p className="text-xs leading-5 text-(--text-3)">
							No projected changes have been captured for this store.
						</p>
					) : (
						<div className="space-y-2">
							{selectedChanges.map((change) => (
								<div
									className="rounded-lg border border-foreground/8 bg-foreground/[0.025] p-3"
									key={change.id}
								>
									<div className="flex items-center justify-between gap-2">
										<span className="truncate text-xs font-medium text-(--foreground)">
											{change.storeTitle}
										</span>
										<span className="font-mono text-xs text-(--text-3)">
											{formatClock(change.at)}
										</span>
									</div>
									<div className="mt-2 flex flex-wrap gap-1">
										{change.changedKeys.length === 0 ? (
											<StatusPill tone={change.error ? 'danger' : 'default'}>
												{change.error ?? 'Projection refreshed'}
											</StatusPill>
										) : (
											change.changedKeys.map((key) => (
												<InlineCode key={key}>{key}</InlineCode>
											))
										)}
									</div>
									<pre className="mb-0 mt-2 max-h-28 overflow-auto whitespace-pre-wrap font-mono text-xs leading-4 text-(--text-3)">
										{change.stateText}
									</pre>
								</div>
							))}
						</div>
					)}
					{selectedReceipts.length > 0 ? (
						<div className="mt-5 border-t border-foreground/8 pt-4">
							<div className="mb-3 text-xs uppercase tracking-[0.08em] text-(--text-3)">
								Mutation receipts
							</div>
							<div className="space-y-2">
								{selectedReceipts.map((receipt) => (
									<div
										className="rounded-lg border border-foreground/8 bg-foreground/[0.025] p-3"
										key={receipt.id}
									>
										<div className="flex items-center justify-between gap-2">
											<span className="text-xs font-medium text-(--foreground)">
												{receipt.kind}
											</span>
											<StatusPill
												tone={
													receipt.status === 'succeeded' ? 'success' : 'danger'
												}
											>
												{receipt.status}
											</StatusPill>
										</div>
										<p className="mb-0 mt-2 font-mono text-xs text-(--text-3)">
											{formatClock(receipt.completedAt)} ·{' '}
											{receipt.changedKeys.join(', ') || 'no projected changes'}
										</p>
										{receipt.error ? (
											<p className="mb-0 mt-2 text-xs leading-4 text-danger-text">
												{receipt.error}
											</p>
										) : null}
									</div>
								))}
							</div>
						</div>
					) : null}
				</aside>
			</div>
		</section>
	);
}

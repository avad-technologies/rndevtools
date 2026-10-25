import { Button } from '@heroui/react/button';
import { Input } from '@heroui/react/input';
import { Label } from '@heroui/react/label';
import { TextArea } from '@heroui/react/textarea';
import { TextField } from '@heroui/react/textfield';
import {
	DataGrid,
	type DataGridColumn,
	type DataGridSelection,
} from '@heroui-pro/react/data-grid';
import {
	Bookmark,
	Database,
	EyeOff,
	History,
	RotateCcw,
	Save,
	ShieldCheck,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
	Badge,
	CodePreview,
	ConfirmAction,
	DetailPlaceholder,
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
import { formatBytes, formatRelativeTime } from '@/lib/format';
import { useDesktopRuntime } from '@/state/desktop-runtime';
import type { StorageEntry } from '../../shared/protocol';

/**
 * Pure helper (unit-tested): explains why the storage write action is
 * unavailable, or returns null when it can run. Keeps the disabled-reason logic
 * out of the render tree so it can be asserted without a DOM.
 */
export function storageWriteBlockReason(
	dirty: boolean,
	capabilityReason: string | null
): string | null {
	if (capabilityReason) return capabilityReason;
	if (!dirty) return 'Edit the value to enable saving.';
	return null;
}

export function StoragePanel() {
	const { canRunAction, actionUnavailableReason, selectedDevice, runAction } =
		useDesktopRuntime();
	const entries = selectedDevice?.tools.storage ?? [];
	const events = selectedDevice?.tools.storageEvents ?? [];
	const summary = selectedDevice?.tools.storageSummary;
	const [query, setQuery] = useState('');
	const [adapter, setAdapter] = useState('all');
	const [selectedId, setSelectedId] = useState<string | null>(
		entries[0]?.id ?? null
	);
	const [draftState, setDraftState] = useState({
		deviceId: null as string | null,
		entryId: null as string | null,
		sourceValue: '',
		value: '',
	});

	const adapters = useMemo(
		() => [...new Set(entries.map((entry) => entry.adapterTitle))],
		[entries]
	);
	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return entries.filter(
			(entry) =>
				(adapter === 'all' || entry.adapterTitle === adapter) &&
				(!needle ||
					[entry.key, entry.valueText, entry.adapterTitle, entry.valueType]
						.join(' ')
						.toLowerCase()
						.includes(needle))
		);
	}, [adapter, entries, query]);
	const selected =
		filtered.find((entry) => entry.id === selectedId) ?? filtered[0] ?? null;
	const selectedSourceValue = selected?.valueText ?? '';
	const draft =
		draftState.deviceId === selectedDevice?.info.id &&
		draftState.entryId === selected?.id &&
		draftState.sourceValue === selectedSourceValue
			? draftState.value
			: selectedSourceValue;
	const selectedEvents = useMemo(
		() =>
			selected
				? events
						.filter(
							(event) =>
								event.adapterId === selected.adapterId &&
								event.key === selected.key
						)
						.sort((left, right) => right.at - left.at)
				: [],
		[events, selected]
	);

	useEffect(() => {
		if (adapter !== 'all' && !adapters.includes(adapter)) setAdapter('all');
	}, [adapter, adapters]);

	const columns = useMemo<DataGridColumn<StorageEntry>[]>(
		() => [
			{
				id: 'key',
				header: 'Key',
				minWidth: 340,
				isRowHeader: true,
				cell: (entry) => (
					<div className="min-w-0 py-0.5">
						<div className="truncate font-mono text-xs text-(--foreground)">
							{entry.key}
						</div>
						<div className="mt-0.5 truncate text-xs text-(--text-3)">
							{entry.adapterTitle}
						</div>
					</div>
				),
			},
			{
				id: 'value',
				header: 'Value',
				minWidth: 280,
				cell: (entry) =>
					entry.sensitive ? (
						<span className="flex items-center gap-1.5 text-xs text-(--text-3)">
							<EyeOff className="h-3.5 w-3.5" /> Value intentionally hidden
						</span>
					) : (
						<span className="block truncate font-mono text-xs text-(--muted)">
							{entry.valueText ?? 'undefined'}
						</span>
					),
			},
			{
				id: 'type',
				header: 'Type',
				width: 92,
				cell: (entry) => (
					<StatusPill tone={entry.sensitive ? 'warning' : 'default'}>
						{entry.valueType}
					</StatusPill>
				),
			},
			{
				id: 'size',
				header: 'Size',
				width: 80,
				align: 'end',
				cell: (entry) => (
					<span className="font-mono text-xs text-(--text-3)">
						{formatBytes(entry.bytes)}
					</span>
				),
			},
		],
		[]
	);

	function onSelectionChange(selection: DataGridSelection): void {
		const key = selection === 'all' ? filtered[0]?.id : [...selection][0];
		setSelectedId(key === undefined ? null : String(key));
	}

	return (
		<section className="panel-root">
			<PanelHeader
				title="Storage"
				description="Browse standard and encrypted MMKV keys, edit explicitly writable values, and review recent changes."
				meta={
					<Badge tone="warning">
						<ShieldCheck className="h-3 w-3" /> Secure values never leave device
					</Badge>
				}
			/>
			<Toolbar>
				<SearchControl
					ariaLabel="Search storage keys"
					placeholder="Key or value…"
					value={query}
					onChange={setQuery}
				/>
				<div className="flex items-center gap-1">
					<Button
						aria-pressed={adapter === 'all'}
						className="h-7 rounded-md px-2.5 text-xs"
						size="sm"
						variant={adapter === 'all' ? 'secondary' : 'ghost'}
						onPress={() => setAdapter('all')}
					>
						All adapters
					</Button>
					{adapters.map((value) => (
						<Button
							aria-pressed={adapter === value}
							className="h-7 rounded-md px-2.5 text-xs"
							key={value}
							size="sm"
							variant={adapter === value ? 'secondary' : 'ghost'}
							onPress={() => setAdapter(value)}
						>
							<span className="max-w-36 truncate" title={value}>
								{value.replace(' MMKV', '')}
							</span>
						</Button>
					))}
				</div>
				<span className="ml-auto font-mono text-xs text-(--text-3)">
					{summary?.totalKeyCount ?? entries.length} keys · {events.length}{' '}
					changes
				</span>
			</Toolbar>
			{summary && (summary.truncated || summary.errors.length > 0) ? (
				<PanelNotice
					title="Storage capture incomplete."
					tone={summary.errors.length > 0 ? 'danger' : 'warning'}
				>
					{summary.errors.length > 0
						? summary.errors
								.map((error) => `${error.adapterTitle}: ${error.message}`)
								.join(' · ')
						: `${summary.omittedKeyCount} ${summary.omittedKeyCount === 1 ? 'key was' : 'keys were'} omitted by the on-device safety budget.`}
				</PanelNotice>
			) : null}
			<div className="split-panel">
				<div className="min-w-0 overflow-hidden">
					{filtered.length === 0 ? (
						<EmptyPanel
							icon={<Database className="h-5 w-5" />}
							title="No matching keys"
							description="Change the adapter or search filters to inspect stored values."
						/>
					) : (
						<DataGrid
							aria-label="Device storage keys"
							className="desktop-grid"
							columns={columns}
							data={filtered}
							getRowId={(entry) => entry.id}
							headingHeight={36}
							rowHeight={42}
							selectedKeys={selected ? new Set([selected.id]) : new Set()}
							selectionMode="single"
							virtualized
							onSelectionChange={onSelectionChange}
						/>
					)}
				</div>
				<aside className="detail-pane">
					{selected ? (
						<div className="h-full overflow-auto p-4">
							<div className="mb-4 flex items-start justify-between gap-3">
								<div className="min-w-0">
									<p className="m-0 text-xs uppercase tracking-[0.08em] text-(--text-3)">
										{selected.adapterTitle}
									</p>
									<h2 className="mb-0 mt-1 break-all font-mono text-xs font-medium leading-5 text-(--foreground)">
										{selected.key}
									</h2>
								</div>
								<StatusPill tone={selected.sensitive ? 'warning' : 'default'}>
									{selected.valueType}
								</StatusPill>
							</div>
							<dl className="mb-4">
								<KeyValue
									label="Size"
									value={formatBytes(selected.bytes)}
									mono
								/>
								<KeyValue
									label="Updated"
									value={
										selected.updatedAt
											? formatRelativeTime(selected.updatedAt)
											: 'Unknown'
									}
								/>
								<KeyValue
									label="Writable"
									value={selected.editable ? 'Yes' : 'No'}
								/>
							</dl>
							{selected.sensitive ? (
								<div className="rounded-lg border border-warning/20 bg-warning/[0.06] p-4">
									<div className="flex items-center gap-2 text-xs font-medium text-warning-text">
										<EyeOff className="h-4 w-4" /> Encrypted value hidden
									</div>
									<p className="mb-0 mt-2 text-xs leading-5 text-warning-text/60">
										The key is listed for diagnostics, but its value is never
										read or transmitted to desktop.
									</p>
								</div>
							) : selected.editable ? (
								<TextField
									fullWidth
									value={draft}
									onChange={(value) =>
										setDraftState({
											deviceId: selectedDevice?.info.id ?? null,
											entryId: selected.id,
											sourceValue: selectedSourceValue,
											value,
										})
									}
								>
									<Label className="mb-2 text-xs text-(--muted)">Value</Label>
									{selected.valueType === 'json' || draft.length > 80 ? (
										<TextArea className="min-h-40 w-full rounded-md border border-foreground/10 bg-background/30 p-3 font-mono text-xs leading-5 text-(--foreground) outline-none focus:border-foreground/25" />
									) : (
										<Input className="h-9 rounded-md border border-foreground/10 bg-background/30 px-3 font-mono text-xs text-(--foreground)" />
									)}
									{(() => {
										const dirty = draft !== (selected.valueText ?? '');
										const capabilityReason = actionUnavailableReason(
											'storage',
											'set'
										);
										const blockReason = storageWriteBlockReason(
											dirty,
											capabilityReason
										);
										return (
											<div className="mt-3 flex items-center justify-end gap-3">
												{blockReason ? (
													<span
														className="text-xs text-(--text-3)"
														id="storage-write-reason"
													>
														{blockReason}
													</span>
												) : null}
												<ConfirmAction
													confirmLabel="Write value"
													description={`This will replace ${selected.key} in ${selected.adapterTitle}. The change is immediate and is not included in developer-state restore points.`}
													isDisabled={blockReason !== null}
													onConfirm={() =>
														void runAction(
															'storage',
															'set',
															{ id: selected.id, valueText: draft },
															'Storage value updated.'
														)
													}
													title="Write this storage value?"
													tone="warning"
													triggerIcon={<Save className="h-3.5 w-3.5" />}
													triggerLabel="Save on device"
													triggerVariant="primary"
												/>
											</div>
										);
									})()}
								</TextField>
							) : (
								<CodePreview
									label="Value"
									value={selected.valueText}
									maxHeight={300}
								/>
							)}
							<div className="mt-5">
								<SectionCard
									icon={<History className="h-3.5 w-3.5" />}
									title="Recent changes"
								>
									{selectedEvents.length === 0 ? (
										<p className="m-0 text-xs text-(--text-3)">
											No captured changes for this key.
										</p>
									) : (
										<div className="space-y-2">
											{selectedEvents.map((event) => (
												<div
													className="rounded-md border border-(--border) bg-foreground/[0.025] p-3"
													key={event.id}
												>
													<div className="flex items-center justify-between text-xs">
														<StatusPill tone="info">{event.kind}</StatusPill>
														<span className="font-mono text-(--text-3)">
															{formatRelativeTime(event.at)}
														</span>
													</div>
													<p className="mb-0 mt-2 truncate font-mono text-xs text-(--muted)">
														{event.previousText ?? '∅'} →{' '}
														{event.nextText ?? '∅'}
													</p>
													{event.structuralDiff?.length ? (
														<div className="mt-2 flex flex-wrap gap-1 border-t border-(--separator) pt-2">
															{event.structuralDiff.slice(0, 8).map((diff) => (
																<InlineCode key={`${diff.path}:${diff.kind}`}>
																	{diff.kind} {diff.path}
																</InlineCode>
															))}
														</div>
													) : null}
													<div className="mt-2 flex justify-end gap-2">
														<Button
															className="h-7 px-2 text-xs"
															isDisabled={!canRunAction('storage', 'bookmark')}
															size="sm"
															variant="ghost"
															onPress={() =>
																void runAction(
																	'storage',
																	'bookmark',
																	{ id: event.id },
																	event.bookmarked
																		? 'Storage bookmark removed.'
																		: 'Storage change bookmarked.'
																)
															}
														>
															<Bookmark className="h-3 w-3" />{' '}
															{event.bookmarked ? 'Unbookmark' : 'Bookmark'}
														</Button>
														{event.undoAvailable ? (
															<ConfirmAction
																confirmLabel="Undo change"
																description="Restore the bounded previous value captured on the device."
																isDisabled={!canRunAction('storage', 'undo')}
																onConfirm={() =>
																	void runAction(
																		'storage',
																		'undo',
																		{ id: event.id },
																		'Storage change undone.'
																	)
																}
																title="Undo this storage change?"
																triggerIcon={<RotateCcw className="h-3 w-3" />}
																triggerLabel="Undo"
																triggerVariant="secondary"
															/>
														) : null}
													</div>
												</div>
											))}
										</div>
									)}
								</SectionCard>
							</div>
						</div>
					) : (
						<DetailPlaceholder label="Select a storage key to inspect it" />
					)}
				</aside>
			</div>
		</section>
	);
}

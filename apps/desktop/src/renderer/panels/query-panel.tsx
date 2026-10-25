import { Button } from '@heroui/react/button';
import {
	DataGrid,
	type DataGridColumn,
	type DataGridSelection,
} from '@heroui-pro/react/data-grid';
import { DatabaseZap, RefreshCw, RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
	Badge,
	CodePreview,
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
import { formatRelativeTime } from '@/lib/format';
import { useDesktopRuntime } from '@/state/desktop-runtime';
import type { QueryEntry } from '../../shared/protocol';

const MAX_RENDERED_MUTATIONS = 250;

type QueryFilter = 'all' | 'active' | 'stale' | 'fetching' | 'errors';
type QueryTab = 'queries' | 'mutations';
const SIMULATION_LABELS = {
	loading: 'Loading',
	error: 'Error',
	paused: 'Paused',
	offline: 'Offline',
} as const;

export function queryTone(
	entry: QueryEntry
): 'success' | 'warning' | 'danger' | 'info' {
	if (entry.status === 'error') return 'danger';
	if (entry.fetchStatus === 'fetching') return 'info';
	if (entry.isStale) return 'warning';
	return 'success';
}

export function queryLabel(entry: QueryEntry): string {
	if (entry.status === 'error') return 'error';
	if (entry.fetchStatus === 'fetching') return 'fetching';
	return entry.isStale ? 'stale' : 'fresh';
}

function queryUpdatedLabel(updatedAt: number): string {
	return updatedAt > 0 ? formatRelativeTime(updatedAt) : 'Never';
}

export function mutationTone(
	status: 'idle' | 'pending' | 'success' | 'error'
): 'default' | 'info' | 'success' | 'danger' {
	if (status === 'error') return 'danger';
	if (status === 'pending') return 'info';
	if (status === 'success') return 'success';
	return 'default';
}

export function QueryPanel() {
	const { canRunAction, selectedDevice, runAction } = useDesktopRuntime();
	const queries = selectedDevice?.tools.queries ?? [];
	const mutations = selectedDevice?.tools.mutations ?? [];
	const summary = selectedDevice?.tools.querySummary;
	const simulation = selectedDevice?.tools.querySimulation;
	const activeSimulation = simulation?.active;
	const [tab, setTab] = useState<QueryTab>('queries');
	const [filter, setFilter] = useState<QueryFilter>('all');
	const [query, setQuery] = useState('');
	const [selectedId, setSelectedId] = useState<string | null>(
		queries[0]?.id ?? null
	);
	const [selectedFamilyId, setSelectedFamilyId] = useState<string | null>(
		simulation?.active?.familyId ?? simulation?.families[0]?.id ?? null
	);
	const selectedFamily =
		simulation?.families.find((family) => family.id === selectedFamilyId) ??
		simulation?.families[0];

	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return queries
			.filter((entry) => {
				if (filter === 'active' && entry.observers === 0) return false;
				if (filter === 'stale' && !entry.isStale) return false;
				if (filter === 'fetching' && entry.fetchStatus !== 'fetching')
					return false;
				if (filter === 'errors' && entry.status !== 'error') return false;
				return (
					!needle ||
					[entry.hash, entry.keyText, entry.dataText, entry.errorText]
						.join(' ')
						.toLowerCase()
						.includes(needle)
				);
			})
			.sort((left, right) => right.updatedAt - left.updatedAt);
	}, [filter, queries, query]);
	const filteredMutations = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return mutations
			.filter(
				(mutation) =>
					!needle ||
					[
						mutation.keyText,
						mutation.status,
						mutation.variablesText,
						mutation.errorText,
					]
						.join(' ')
						.toLowerCase()
						.includes(needle)
			)
			.sort(
				(left, right) => (right.submittedAt ?? 0) - (left.submittedAt ?? 0)
			);
	}, [mutations, query]);
	const visibleMutations = filteredMutations.slice(0, MAX_RENDERED_MUTATIONS);
	const selected =
		filtered.find((entry) => entry.id === selectedId) ?? filtered[0] ?? null;
	const truncatedCount =
		tab === 'queries'
			? queries.filter((entry) => entry.truncated).length
			: mutations.filter((entry) => entry.truncated).length;
	const omittedCount =
		tab === 'queries'
			? (summary?.omittedQueryCount ?? 0)
			: (summary?.omittedMutationCount ?? 0);
	const columns = useMemo<DataGridColumn<QueryEntry>[]>(
		() => [
			{
				id: 'key',
				header: 'Query key',
				minWidth: 380,
				isRowHeader: true,
				cell: (entry) => (
					<div className="min-w-0 py-0.5">
						<div className="truncate font-mono text-xs text-(--foreground)">
							{entry.keyText}
						</div>
						<div className="mt-0.5 truncate font-mono text-xs text-(--text-3)">
							{entry.hash}
						</div>
					</div>
				),
			},
			{
				id: 'status',
				header: 'Status',
				width: 104,
				cell: (entry) => (
					<StatusPill tone={queryTone(entry)} dot>
						{queryLabel(entry)}
					</StatusPill>
				),
			},
			{
				id: 'observers',
				header: 'Observers',
				width: 90,
				align: 'end',
				cell: (entry) => (
					<span className="font-mono text-xs text-(--muted)">
						{entry.observers}
					</span>
				),
			},
			{
				id: 'updated',
				header: 'Updated',
				width: 100,
				align: 'end',
				cell: (entry) => (
					<span className="text-xs text-(--text-3)">
						{queryUpdatedLabel(entry.updatedAt)}
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
				title="React Query"
				description="Inspect the live TanStack Query cache and run narrowly scoped refetch or invalidation actions on the selected device."
				meta={
					<span>
						{summary?.sourceQueryCount ?? queries.length} cached queries
					</span>
				}
			/>
			<Toolbar>
				<div className="flex rounded-md border border-foreground/8 bg-background/25 p-0.5">
					{(['queries', 'mutations'] as const).map((value) => (
						<Button
							aria-pressed={tab === value}
							className="h-7 rounded px-3 text-xs"
							key={value}
							size="sm"
							variant={tab === value ? 'secondary' : 'ghost'}
							onPress={() => setTab(value)}
						>
							{value === 'queries'
								? `Queries ${queries.length}${summary?.omittedQueryCount ? ` / ${summary.sourceQueryCount}` : ''}`
								: `Mutations ${mutations.length}${summary?.omittedMutationCount ? ` / ${summary.sourceMutationCount}` : ''}`}
						</Button>
					))}
				</div>
				<SearchControl
					ariaLabel={`Search ${tab}`}
					placeholder={`Search ${tab}…`}
					value={query}
					onChange={setQuery}
				/>
				{tab === 'queries' ? (
					<div className="flex items-center gap-1">
						{(['all', 'active', 'stale', 'fetching', 'errors'] as const).map(
							(value) => (
								<Button
									aria-pressed={filter === value}
									className="h-7 rounded-md px-2 text-xs capitalize"
									key={value}
									size="sm"
									variant={filter === value ? 'secondary' : 'ghost'}
									onPress={() => setFilter(value)}
								>
									{value}
								</Button>
							)
						)}
					</div>
				) : null}
			</Toolbar>
			{simulation && selectedFamily ? (
				<div className="mx-5 mt-4">
					<SectionCard
						icon={<DatabaseZap className="h-3.5 w-3.5" />}
						title="Query simulation"
						actions={
							activeSimulation ? (
								<Button
									isDisabled={!canRunAction('query', 'clearSimulation')}
									size="sm"
									variant="secondary"
									onPress={() =>
										void runAction(
											'query',
											'clearSimulation',
											{ receiptId: activeSimulation.receiptId },
											'Query simulation reset.'
										)
									}
								>
									<RotateCcw className="h-3.5 w-3.5" /> Reset
								</Button>
							) : null
						}
					>
						<p className="m-0 text-xs text-(--foreground)">
							{simulation.active
								? `${simulation.active.familyLabel} · ${SIMULATION_LABELS[simulation.active.mode]} active`
								: selectedFamily.label}
						</p>
						<p className="mb-0 mt-1 text-xs text-(--text-3)">
							{selectedFamily.description ??
								'Only explicitly registered query-family adapters can be changed.'}
						</p>
						{simulation.families.length > 1 ? (
							<div className="mt-3 flex flex-wrap gap-1">
								{simulation.families.map((family) => (
									<Button
										aria-pressed={family.id === selectedFamily.id}
										className="h-7 px-2 text-xs"
										key={family.id}
										size="sm"
										variant={
											family.id === selectedFamily.id ? 'secondary' : 'ghost'
										}
										onPress={() => setSelectedFamilyId(family.id)}
									>
										{family.label}
									</Button>
								))}
							</div>
						) : null}
						<div className="mt-3 flex flex-wrap gap-2">
							{selectedFamily.modes.map((mode) => {
								const reasonId = `query-sim-${selectedFamily.id}-${mode.mode}`;
								return (
									<Button
										{...(mode.supported
											? {}
											: { 'aria-describedby': reasonId })}
										isDisabled={
											!mode.supported || !canRunAction('query', 'simulate')
										}
										key={mode.mode}
										size="sm"
										variant="secondary"
										onPress={() =>
											void runAction(
												'query',
												'simulate',
												{ familyId: selectedFamily.id, mode: mode.mode },
												`${SIMULATION_LABELS[mode.mode]} query simulation applied.`
											)
										}
									>
										{SIMULATION_LABELS[mode.mode]}
									</Button>
								);
							})}
						</div>
						{selectedFamily.modes.some((mode) => !mode.supported) ? (
							<div className="mt-3 flex flex-col gap-1.5">
								{selectedFamily.modes
									.filter((mode) => !mode.supported)
									.map((mode) => (
										<div
											className="flex items-start gap-2 text-xs leading-5 text-(--text-3)"
											id={`query-sim-${selectedFamily.id}-${mode.mode}`}
											key={mode.mode}
										>
											<Badge tone="warning">
												{SIMULATION_LABELS[mode.mode]} unavailable
											</Badge>
											<span className="min-w-0">{mode.reason}</span>
										</div>
									))}
							</div>
						) : null}
					</SectionCard>
				</div>
			) : null}
			{omittedCount > 0 ? (
				<PanelNotice title="Cache capture incomplete.">
					{omittedCount} {tab === 'queries' ? 'query' : 'mutation'} entr
					{omittedCount === 1 ? 'y was' : 'ies were'} omitted by the on-device
					item or byte budget.
				</PanelNotice>
			) : null}
			{truncatedCount > 0 ? (
				<PanelNotice title="Some diagnostic values were shortened.">
					{truncatedCount} {tab === 'queries' ? 'query' : 'mutation'} snapshot
					{truncatedCount === 1 ? ' was' : 's were'} sanitized or truncated to
					stay within the on-device privacy and size limits.
				</PanelNotice>
			) : null}
			{tab === 'mutations' &&
			filteredMutations.length > visibleMutations.length ? (
				<PanelNotice title="Desktop mutation rendering is bounded." tone="info">
					Search covers all {filteredMutations.length} matching mutations; the
					list renders the newest {MAX_RENDERED_MUTATIONS}.
				</PanelNotice>
			) : null}
			{tab === 'mutations' ? (
				<div className="panel-scroll p-5">
					{visibleMutations.length === 0 ? (
						<EmptyPanel
							icon={<DatabaseZap className="h-5 w-5" />}
							title={
								query.trim() ? 'No matching mutations' : 'No captured mutations'
							}
							description={
								query.trim()
									? 'Broaden the search to inspect captured mutation activity.'
									: 'Mutations will appear as the selected device performs writes.'
							}
						/>
					) : (
						<div className="grid gap-3">
							{visibleMutations.map((mutation) => (
								<div
									className="rounded-lg border border-foreground/8 bg-foreground/[0.025] p-4"
									key={mutation.id}
								>
									<div className="flex items-start justify-between gap-4">
										<div className="min-w-0">
											<InlineCode className="break-all">
												{mutation.keyText}
											</InlineCode>
											<p className="mb-0 mt-1 text-xs text-(--text-3)">
												{mutation.submittedAt
													? formatRelativeTime(mutation.submittedAt)
													: 'Not submitted'}
											</p>
										</div>
										<div className="flex items-center gap-1.5">
											{mutation.truncated ? (
												<StatusPill tone="warning">shortened</StatusPill>
											) : null}
											<StatusPill tone={mutationTone(mutation.status)}>
												{mutation.status}
											</StatusPill>
										</div>
									</div>
									{mutation.variablesText ? (
										<div className="mt-3">
											<CodePreview
												label="Variables"
												value={mutation.variablesText}
											/>
										</div>
									) : null}
									{mutation.errorText ? (
										<div className="mt-3 rounded-md border border-danger/20 bg-danger/[0.06] p-3 text-xs text-danger-text">
											{mutation.errorText}
										</div>
									) : null}
								</div>
							))}
						</div>
					)}
				</div>
			) : (
				<div className="split-panel">
					<div className="min-w-0 overflow-hidden">
						{filtered.length === 0 ? (
							<EmptyPanel
								icon={<DatabaseZap className="h-5 w-5" />}
								title="No matching queries"
								description="Adjust the cache filters or use the app to populate new queries."
							/>
						) : (
							<DataGrid
								aria-label="React Query cache"
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
											Query key
										</p>
										<h2 className="mb-0 mt-1 break-all font-mono text-xs leading-5 text-(--foreground)">
											{selected.keyText}
										</h2>
									</div>
									<StatusPill tone={queryTone(selected)} dot>
										{queryLabel(selected)}
									</StatusPill>
								</div>
								<div className="mb-4 flex gap-2">
									<Button
										isDisabled={!canRunAction('query', 'refetch')}
										size="sm"
										variant="primary"
										onPress={() =>
											void runAction(
												'query',
												'refetch',
												{ id: selected.id },
												'Query refetch requested.'
											)
										}
									>
										<RefreshCw className="h-3.5 w-3.5" /> Refetch
									</Button>
									<Button
										isDisabled={!canRunAction('query', 'invalidate')}
										size="sm"
										variant="secondary"
										onPress={() =>
											void runAction(
												'query',
												'invalidate',
												{ id: selected.id },
												'Query invalidated.'
											)
										}
									>
										<RotateCcw className="h-3.5 w-3.5" /> Invalidate
									</Button>
								</div>
								<dl className="mb-4">
									<KeyValue label="Hash" value={selected.hash} mono />
									<KeyValue label="Observers" value={selected.observers} mono />
									<KeyValue label="Fetch status" value={selected.fetchStatus} />
									<KeyValue
										label="Updated"
										value={queryUpdatedLabel(selected.updatedAt)}
									/>
								</dl>
								{selected.errorText ? (
									<div className="mb-4 rounded-md border border-danger/20 bg-danger/[0.06] p-3 text-xs text-danger-text">
										{selected.errorText}
									</div>
								) : null}
								<CodePreview
									label="Cached data"
									value={selected.dataText}
									maxHeight={420}
								/>
							</div>
						) : (
							<DetailPlaceholder label="Select a query to inspect its cache entry" />
						)}
					</aside>
				</div>
			)}
		</section>
	);
}

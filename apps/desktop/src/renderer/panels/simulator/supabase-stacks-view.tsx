import { Button } from '@heroui/react/button';
import { FolderGit2, Pin, Square, Trash2, X } from 'lucide-react';
import { type Dispatch, useCallback, useState } from 'react';
import { AgentBadge } from '@/components/lane-ui';
import { DenseVirtualList } from '@/components/simulator-ui';
import {
	Badge,
	DetailPlaceholder,
	DisabledReason,
	Skeleton,
	StatusDot,
	StatusPill,
} from '@/components/ui';
import { formatSize } from '@/lib/format';
import {
	buildSupabaseRepositoryRows,
	type SupabaseControlTarget,
	type SupabaseOpenTarget,
	type SupabaseStackRow,
	supabaseBulkEligibility,
} from '@/simulator/supabase-model';
import type {
	SupabaseNavigation,
	SupabaseNavigationAction,
} from '@/state/supabase-runtime';
import {
	type SupabaseState,
	stackStatus,
	supabaseLiveAgentLabels,
	supabaseStackTitle,
} from '../../../shared/supabase-protocol';
import {
	SupabaseStackDetail,
	type SupabaseStackReads,
} from './supabase-stack-detail';

/**
 * The visible reasons for the toolbar's Stop N and Destroy N… live in the
 * selection summary, which batch mode always shows; the buttons point here.
 */
export const SUPABASE_BULK_REASON_IDS = Object.freeze({
	stop: 'supabase-bulk-stop-reason',
	destroy: 'supabase-bulk-destroy-reason',
});

/** Reads kept per stack while the tab is mounted; older ones drop first. */
const MAX_CACHED_READS = 32;

/**
 * What batch mode's detail says about a selection: each stack's state and
 * holder, and what Stop N and Destroy N… would do to the eligible ones.
 */
export function supabaseSelectionSummary(
	state: SupabaseState,
	batchIds: readonly string[],
	bulk: ReturnType<typeof supabaseBulkEligibility>
): Readonly<{
	items: readonly Readonly<{ id: string; title: string; text: string }>[];
	stopEffect: string;
	destroyEffect: string;
}> {
	const stacks = batchIds.flatMap((id) => {
		const stack = state.stacks.find((candidate) => candidate.id === id);
		return stack ? [stack] : [];
	});
	const items = stacks.map((stack) => {
		const status = stackStatus(stack, { jobs: state.jobs });
		const agents = supabaseLiveAgentLabels(stack);
		const parts = [
			status.label.toLowerCase(),
			agents.length > 0 ? `${agents.join(', ')} (live)` : '',
			stack.pinned ? 'pinned' : '',
			stack.diskBytes === undefined ? '' : formatSize(stack.diskBytes),
			stack.requestIds.length > 0 ? 'requested for destroy' : '',
		].filter(Boolean);
		return {
			id: stack.id,
			title: supabaseStackTitle(stack),
			text: parts.join(' · '),
		};
	});
	const stoppable = stacks.filter((stack) =>
		bulk.stop.stackIds.includes(stack.id)
	);
	const agents = [...new Set(stoppable.flatMap(supabaseLiveAgentLabels))];
	const pinned = stoppable.filter((stack) => stack.pinned);
	const pins =
		pinned.length === 0
			? ''
			: `; the pin on ${pinned.map(supabaseStackTitle).join(', ')} clears`;
	const stopEffect =
		stoppable.length === 0
			? 'Stops the running stacks you select; data and ports are kept.'
			: agents.length === 0
				? `Their apps lose the database until something starts them again. Data is kept${pins}.`
				: `${agents.length === 1 ? 'One live agent loses its' : `${agents.length} live agents lose their`} database. Data is kept${pins}.`;
	return {
		items,
		stopEffect,
		destroyEffect:
			'Stopped stacks without a running lane only. A system dialog confirms.',
	};
}

/**
 * Getting started, while there are no stacks: every tracked repository's
 * readiness, so the next step is one click away.
 */
export function supabaseGettingStarted(
	state: Pick<SupabaseState, 'repositories'>
): readonly Readonly<{
	id: string;
	title: string;
	detail: string;
	pill: Readonly<{
		label: string;
		tone: 'success' | 'warning' | 'default';
	}>;
}>[] {
	return buildSupabaseRepositoryRows(state).map((row) => ({
		id: row.id,
		title: row.title,
		detail: row.line2,
		pill:
			row.repository.readiness === 'ready'
				? { label: 'Ready', tone: 'success' }
				: row.repository.readiness === 'needs-fix'
					? { label: 'Needs fix', tone: 'warning' }
					: row.repository.readiness === 'observed'
						? { label: 'Check', tone: 'warning' }
						: { label: row.readiness.label, tone: 'default' },
	}));
}

export function SupabaseStacksView({
	state,
	now,
	rows,
	visibleRows,
	selectedStackId,
	navigation,
	loading,
	isBridgeAvailable,
	isStackPending,
	onSelect,
	onNavigate,
	onClearFilters,
	onControlTarget,
	onOpenTarget,
	onOpenRepository,
}: {
	state: SupabaseState;
	now: number;
	rows: readonly SupabaseStackRow[];
	visibleRows: readonly SupabaseStackRow[];
	selectedStackId: string | null;
	navigation: SupabaseNavigation;
	loading: boolean;
	isBridgeAvailable: boolean;
	isStackPending: (stackId: string) => boolean;
	onSelect: (stackId: string | null) => void;
	onNavigate: Dispatch<SupabaseNavigationAction>;
	onClearFilters: () => void;
	onControlTarget: (target: SupabaseControlTarget) => void;
	onOpenTarget: (target: SupabaseOpenTarget) => void;
	onOpenRepository: (repositoryId: string) => void;
}) {
	const [reads, setReads] = useState<ReadonlyMap<string, SupabaseStackReads>>(
		() => new Map()
	);
	const updateReads = useCallback(
		(
			stackId: string,
			update: (current: SupabaseStackReads) => SupabaseStackReads
		) =>
			setReads((current) => {
				const next = new Map(current);
				const value = update(current.get(stackId) ?? {});
				next.delete(stackId);
				next.set(stackId, value);
				while (next.size > MAX_CACHED_READS) {
					const oldest = next.keys().next().value;
					if (oldest === undefined) break;
					next.delete(oldest);
				}
				return next;
			}),
		[]
	);
	const selectedStack =
		selectedStackId === null
			? undefined
			: state.stacks.find((stack) => stack.id === selectedStackId);
	// Stable per stack, so the detail's log auto-refresh keeps its interval.
	const readsStackId = selectedStack?.id;
	const onSelectedReads = useCallback(
		(update: (current: SupabaseStackReads) => SupabaseStackReads) => {
			if (readsStackId !== undefined) updateReads(readsStackId, update);
		},
		[readsStackId, updateReads]
	);
	const noStacks = rows.every((row) => row.transient);

	return (
		<div className="sim-fleet-layout supabase-stacks">
			<div className="sim-list-pane">
				{loading ? (
					<LoadingRows />
				) : visibleRows.length === 0 ? (
					noStacks && navigation.filter !== 'transient' ? (
						<div className="sim-list-empty">
							<strong>No stacks yet</strong>
							<span>
								Start a lane on a worktree whose repository opts in, or let an
								agent run <code>rndevtools supabase --operation up</code>.
								Stacks started outside RN Devtools show up here too.
							</span>
						</div>
					) : (
						<div className="sim-list-empty">
							<strong>No stacks match these filters</strong>
							<span>Try another branch, port or agent.</span>
							<Button size="sm" variant="ghost" onPress={onClearFilters}>
								<X aria-hidden="true" className="h-3.5 w-3.5" />
								Clear filters
							</Button>
						</div>
					)
				) : (
					<DenseVirtualList
						ariaLabel="Supabase stacks"
						getId={(row) => row.id}
						items={visibleRows}
						renderItem={(row) => <StackRow row={row} />}
						rowHeight={64}
						selectedId={navigation.batchMode ? undefined : selectedStackId}
						selectedIds={
							navigation.batchMode ? [...navigation.batchIds] : undefined
						}
						textValue={(row) => row.textValue}
						onSelect={(row) => onSelect(row.id)}
						onSelectedIdsChange={
							navigation.batchMode
								? (ids) => onNavigate({ type: 'set-batch', stackIds: ids })
								: undefined
						}
					/>
				)}
			</div>
			<div className="sim-detail-pane panel-scroll">
				{loading ? (
					<DetailPlaceholder label="Select a stack to inspect" />
				) : navigation.batchMode ? (
					<SelectionSummary
						batchIds={navigation.batchIds}
						isBridgeAvailable={isBridgeAvailable}
						now={now}
						state={state}
						total={rows.filter((row) => !row.transient).length}
					/>
				) : selectedStack ? (
					<SupabaseStackDetail
						focus={navigation.focus}
						isBridgeAvailable={isBridgeAvailable}
						key={selectedStack.id}
						now={now}
						pending={isStackPending(selectedStack.id)}
						reads={reads.get(selectedStack.id) ?? {}}
						sections={navigation.sections[selectedStack.id] ?? {}}
						stack={selectedStack}
						state={state}
						onControlTarget={onControlTarget}
						onNavigate={onNavigate}
						onOpenTarget={onOpenTarget}
						onReads={onSelectedReads}
					/>
				) : noStacks ? (
					<GettingStarted state={state} onOpenRepository={onOpenRepository} />
				) : (
					<DetailPlaceholder label="Select a stack to inspect" />
				)}
			</div>
		</div>
	);
}

function StackRow({ row }: { row: SupabaseStackRow }) {
	const simulator = row.stack.lanes.find(
		(lane) => lane.simulatorLabel !== undefined
	)?.simulatorLabel;
	return (
		<>
			<span className="supabase-row-leading">
				<StatusDot
					hollow={row.status.icon === 'hollow-dot'}
					tone={row.status.tone}
				/>
			</span>
			<div className="supabase-row">
				<div className="supabase-row-top">
					<strong className="supabase-row-title">{row.title}</strong>
					{row.holder ? <RowHolder holder={row.holder} /> : null}
				</div>
				<span className="supabase-row-line">
					{row.parts.map((part, index) => (
						<span className={`is-${part.tone}`} key={part.text}>
							{index > 0 ? ' · ' : ''}
							{part.text}
						</span>
					))}
					{simulator ? (
						<span className="supabase-row-wide"> · {simulator}</span>
					) : null}
				</span>
			</div>
		</>
	);
}

function RowHolder({
	holder,
}: {
	holder: NonNullable<SupabaseStackRow['holder']>;
}) {
	if (holder.kind === 'agent') {
		return (
			<span className="supabase-row-holder" title={holder.label}>
				<AgentBadge agent={holder.agent} />
			</span>
		);
	}
	if (holder.kind === 'pinned') {
		return (
			<Badge className="supabase-row-holder">
				<Pin aria-hidden="true" className="h-3 w-3" />
				{holder.label}
			</Badge>
		);
	}
	return <Badge className="supabase-row-holder">{holder.label}</Badge>;
}

const LOADING_ROWS = ['first', 'second', 'third'] as const;

function LoadingRows() {
	return (
		<ul
			aria-busy="true"
			aria-label="Loading Supabase stacks"
			className="supabase-loading-rows"
		>
			{LOADING_ROWS.map((key) => (
				<li key={key}>
					<StatusDot hollow />
					<span className="supabase-loading-copy">
						<Skeleton className="supabase-skeleton-title" rounded="full" />
						<Skeleton className="supabase-skeleton-line" rounded="full" />
					</span>
				</li>
			))}
		</ul>
	);
}

function SelectionSummary({
	state,
	batchIds,
	total,
	isBridgeAvailable,
	now,
}: {
	state: SupabaseState;
	batchIds: readonly string[];
	total: number;
	isBridgeAvailable: boolean;
	now: number;
}) {
	const bulk = supabaseBulkEligibility(state, batchIds, {
		bridgeAvailable: isBridgeAvailable,
		now,
	});
	const summary = supabaseSelectionSummary(state, batchIds, bulk);
	return (
		<div className="sim-target-detail supabase-selection">
			<div className="sim-detail-heading">
				<div>
					<p className="sim-eyebrow">Selection</p>
					<h2>
						{batchIds.length} of {total} stacks
					</h2>
					<span>Batch mode · at most 20 · counts are eligible stacks only</span>
				</div>
			</div>
			{summary.items.length === 0 ? (
				<p className="sim-section-empty">
					Select stacks in the list; Space toggles the focused row.
				</p>
			) : (
				<ul className="supabase-selection-list">
					{summary.items.map((item) => (
						<li key={item.id}>
							<strong className="supabase-selection-title">{item.title}</strong>
							<span>{item.text}</span>
						</li>
					))}
				</ul>
			)}
			<div className="supabase-selection-effects">
				<div className="supabase-selection-effect">
					<Square aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
					<p className="supabase-selection-text">
						<strong className="supabase-selection-label">
							{bulk.stop.label}:
						</strong>{' '}
						{summary.stopEffect}
					</p>
					{bulk.stop.availability.allowed ? null : (
						<DisabledReason id={SUPABASE_BULK_REASON_IDS.stop}>
							{bulk.stop.availability.reason}
						</DisabledReason>
					)}
				</div>
				<div className="supabase-selection-effect">
					<Trash2 aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
					<p className="supabase-selection-text">
						<strong className="supabase-selection-label">
							{bulk.destroy.label}:
						</strong>{' '}
						{summary.destroyEffect}
					</p>
					{bulk.destroy.availability.allowed ? null : (
						<DisabledReason id={SUPABASE_BULK_REASON_IDS.destroy}>
							{bulk.destroy.availability.reason}
						</DisabledReason>
					)}
				</div>
			</div>
			<p className="sim-inline-note">{bulk.summary}</p>
		</div>
	);
}

function GettingStarted({
	state,
	onOpenRepository,
}: {
	state: SupabaseState;
	onOpenRepository: (repositoryId: string) => void;
}) {
	const repositories = supabaseGettingStarted(state);
	return (
		<div className="sim-target-detail supabase-getting-started">
			<p className="sim-eyebrow">Getting started</p>
			<h2>Repository readiness</h2>
			{repositories.length === 0 ? (
				<p className="sim-section-empty">
					No repository is tracked in Lanes yet. Use Track repository… in the
					Repositories view to add one.
				</p>
			) : (
				<ul className="supabase-readiness-list">
					{repositories.map((repository) => (
						<li key={repository.id}>
							<FolderGit2 aria-hidden="true" className="h-4 w-4 shrink-0" />
							<span className="supabase-readiness-copy">
								<strong className="supabase-readiness-title">
									{repository.title}
								</strong>
								<span className="supabase-readiness-detail">
									{repository.detail}
								</span>
							</span>
							<StatusPill tone={repository.pill.tone}>
								{repository.pill.label}
							</StatusPill>
							<Button
								aria-label={`Review ${repository.title} in Repositories`}
								size="sm"
								variant="ghost"
								onPress={() => onOpenRepository(repository.id)}
							>
								Review
							</Button>
						</li>
					))}
				</ul>
			)}
			<p className="sim-inline-note">
				A stack appears once a lane or an agent starts one, or when RN Devtools
				finds one started outside it. Viewing this tab never starts anything.
			</p>
		</div>
	);
}

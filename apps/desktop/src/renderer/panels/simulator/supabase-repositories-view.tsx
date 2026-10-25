import { Button } from '@heroui/react/button';
import {
	CircleAlert,
	Download,
	Eye,
	FileCheck,
	FileCode,
	FileJson,
	FolderGit2,
	FolderPlus,
	Laptop,
	Layers,
	RefreshCw,
	SquareTerminal,
	Waypoints,
} from 'lucide-react';
import {
	type ComponentType,
	type RefObject,
	useEffect,
	useId,
	useRef,
} from 'react';
import { DenseVirtualList } from '@/components/simulator-ui';
import { SupabaseSelect } from '@/components/supabase-ui';
import {
	Badge,
	DetailPlaceholder,
	DisabledReason,
	ReadinessRow,
	StatusDot,
} from '@/components/ui';
import { formatClock } from '@/lib/format';
import {
	resolveSupabaseSelection,
	SUPABASE_CHECK_LABELS,
	type SupabaseRepositoryRow,
	supabaseRepositoryWorktrees,
} from '@/simulator/supabase-model';
import {
	type SupabaseNavigation,
	useSupabaseActions,
} from '@/state/supabase-runtime';
import {
	type SupabaseRepositorySummary,
	type SupabaseState,
	supabaseRepositoryActionAvailability,
} from '../../../shared/supabase-protocol';

type IconComponent = ComponentType<{ className?: string }>;

const CHECK_ICONS: Readonly<
	Record<SupabaseRepositorySummary['checks'][number]['id'], IconComponent>
> = {
	platform: Laptop,
	project: FileCode,
	'stack-flag': FileCheck,
	'config-json': FileJson,
	'pinned-ports': CircleAlert,
	cli: SquareTerminal,
	'app-env-files': Eye,
	recommended: Layers,
};

/**
 * The repository heading's second line: the app directory, worktrees and
 * when main last checked it.
 */
export function supabaseRepositorySubtitle(
	repository: Pick<
		SupabaseRepositorySummary,
		'appPathLabel' | 'counts' | 'checkedAt'
	>
): string {
	const { counts } = repository;
	return [
		repository.appPathLabel === undefined
			? ''
			: `app ${repository.appPathLabel}`,
		`${counts.worktrees} ${counts.worktrees === 1 ? 'worktree' : 'worktrees'}`,
		counts.running > 0 ? `${counts.running} running` : '',
		repository.checkedAt === undefined
			? ''
			: `checked ${formatClock(repository.checkedAt)}`,
	]
		.filter(Boolean)
		.join(' · ');
}

export function SupabaseRepositoriesView({
	state,
	rows,
	navigation,
	isBridgeAvailable,
	onSelect,
	onOpenStack,
	onTrackRepository,
	onFocusHandled,
}: {
	state: SupabaseState;
	rows: readonly SupabaseRepositoryRow[];
	navigation: SupabaseNavigation;
	isBridgeAvailable: boolean;
	onSelect: (repositoryId: string | null) => void;
	onOpenStack: (stackId: string) => void;
	onTrackRepository: () => void;
	onFocusHandled: (nonce: number) => void;
}) {
	const selectedId = resolveSupabaseSelection(
		rows,
		navigation.selectedRepositoryId
	);
	useEffect(() => {
		if (selectedId !== navigation.selectedRepositoryId) onSelect(selectedId);
	}, [navigation.selectedRepositoryId, onSelect, selectedId]);
	const selected = rows.find((row) => row.id === selectedId)?.repository;
	const headingRef = useRef<HTMLHeadingElement>(null);
	const { focus } = navigation;
	useEffect(() => {
		if (focus?.target !== 'repository') return;
		if (focus.id !== undefined && focus.id !== selected?.id) return;
		headingRef.current?.focus();
		onFocusHandled(focus.nonce);
	}, [focus, onFocusHandled, selected?.id]);

	return (
		<div className="sim-fleet-layout supabase-repositories">
			<div className="sim-list-pane">
				{rows.length === 0 ? (
					<div className="sim-list-empty">
						<strong>
							{state.repositories.length === 0
								? 'No repositories tracked'
								: 'No repositories match these filters'}
						</strong>
						<span>
							{state.repositories.length === 0
								? 'Repositories come from Lanes. Track one to check whether its worktrees can each get a local Supabase stack.'
								: 'Try another repository, worktree or branch.'}
						</span>
						{state.repositories.length === 0 ? (
							<Button size="sm" variant="ghost" onPress={onTrackRepository}>
								<FolderPlus aria-hidden="true" className="h-3.5 w-3.5" />
								Track repository…
							</Button>
						) : null}
					</div>
				) : (
					<DenseVirtualList
						ariaLabel="Repositories"
						getId={(row) => row.id}
						items={rows}
						renderItem={(row) => <RepositoryRow row={row} />}
						rowHeight={64}
						selectedId={selectedId}
						textValue={(row) => `${row.title} ${row.readiness.label}`}
						onSelect={(row) => onSelect(row.id)}
					/>
				)}
			</div>
			<div className="sim-detail-pane panel-scroll">
				{selected ? (
					<RepositoryDetail
						headingRef={headingRef}
						isBridgeAvailable={isBridgeAvailable}
						key={selected.id}
						repository={selected}
						state={state}
						onOpenStack={onOpenStack}
					/>
				) : (
					<DetailPlaceholder label="Select a repository to inspect" />
				)}
			</div>
		</div>
	);
}

function RepositoryRow({ row }: { row: SupabaseRepositoryRow }) {
	return (
		<>
			<span className="supabase-row-leading">
				<StatusDot
					hollow={row.repository.readiness === 'no-supabase'}
					tone={row.readiness.tone}
				/>
			</span>
			<div className="supabase-row">
				<div className="supabase-row-top">
					<strong className="supabase-row-title">{row.title}</strong>
					<Badge className="supabase-row-holder" tone={row.readiness.tone}>
						{row.readiness.label}
					</Badge>
				</div>
				<span className="supabase-row-line">{row.line2}</span>
			</div>
		</>
	);
}

function RepositoryDetail({
	repository,
	state,
	isBridgeAvailable,
	headingRef,
	onOpenStack,
}: {
	repository: SupabaseRepositorySummary;
	state: SupabaseState;
	isBridgeAvailable: boolean;
	headingRef: RefObject<HTMLHeadingElement | null>;
	onOpenStack: (stackId: string) => void;
}) {
	const { run, isPending } = useSupabaseActions();
	const recheckReasonId = useId();
	const modeReasonId = useId();
	const prepareReasonId = useId();
	const context = { bridgeAvailable: isBridgeAvailable, state };
	const pendingKey = `repository:${repository.id}`;
	const busy = isPending(pendingKey);
	const recheck = supabaseRepositoryActionAvailability(
		repository,
		'recheck',
		context
	);
	const setMode = supabaseRepositoryActionAvailability(
		repository,
		'set-mode',
		context
	);
	const prepare = supabaseRepositoryActionAvailability(
		repository,
		'prepare',
		context
	);
	const worktrees = supabaseRepositoryWorktrees(repository, state);
	return (
		<div className="sim-target-detail supabase-repository-detail">
			<div className="sim-detail-heading">
				<div>
					<p className="sim-eyebrow">Repository</p>
					<h2 ref={headingRef} tabIndex={-1}>
						{repository.label}
					</h2>
					<span>{supabaseRepositorySubtitle(repository)}</span>
				</div>
				<div className="supabase-heading-actions">
					<Button
						{...(recheck.allowed
							? {}
							: { 'aria-describedby': recheckReasonId })}
						aria-label={`Re-check ${repository.label}`}
						isDisabled={!recheck.allowed || busy}
						size="sm"
						variant="secondary"
						onPress={() =>
							void run({
								kind: 'repository.recheck',
								repositoryId: repository.id,
							})
						}
					>
						<RefreshCw
							aria-hidden="true"
							className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`}
						/>
						{repository.readiness === 'checking' ? 'Checking…' : 'Re-check'}
					</Button>
					{recheck.allowed ? null : (
						<DisabledReason id={recheckReasonId}>
							{recheck.reason}
						</DisabledReason>
					)}
				</div>
			</div>
			<div className="supabase-repository-controls">
				<div className="supabase-inline-field">
					<span>Use local Supabase here</span>
					<SupabaseSelect
						describedBy={setMode.allowed ? undefined : modeReasonId}
						disabled={!setMode.allowed || busy}
						label={`Use local Supabase in ${repository.label}`}
						options={[
							{ value: 'auto', label: 'Auto' },
							{ value: 'off', label: 'Off' },
						]}
						value={repository.mode}
						onChange={(mode) =>
							void run({
								kind: 'repository.set-mode',
								repositoryId: repository.id,
								mode,
							})
						}
					/>
					{setMode.allowed ? null : (
						<DisabledReason id={modeReasonId}>{setMode.reason}</DisabledReason>
					)}
				</div>
				<div className="supabase-inline-field">
					<Button
						{...(prepare.allowed
							? {}
							: { 'aria-describedby': prepareReasonId })}
						isDisabled={!prepare.allowed || busy}
						size="sm"
						variant="ghost"
						onPress={() =>
							void run({ kind: 'prepare', repositoryId: repository.id })
						}
					>
						<Download aria-hidden="true" className="h-3.5 w-3.5" />
						Pre-download services
					</Button>
					{prepare.allowed ? (
						<span className="supabase-action-note">
							One time, up to about 360 MB; new stacks then start in about 5 s.
						</span>
					) : (
						<DisabledReason id={prepareReasonId}>
							{prepare.reason}
						</DisabledReason>
					)}
				</div>
			</div>
			{repository.checks.length > 0 ? (
				<div className="sim-capability-list supabase-checks">
					{repository.checks.map((check) => (
						<ReadinessRow
							detail={check.summary}
							icon={CHECK_ICONS[check.id]}
							key={check.id}
							label={SUPABASE_CHECK_LABELS[check.id]}
							status={check.status}
							{...(check.lines ? { lines: check.lines } : {})}
							{...(check.fix
								? {
										fix: {
											text: check.fix.text,
											snippet: check.fix.snippet,
										},
									}
								: {})}
						/>
					))}
				</div>
			) : (
				<p className="sim-section-empty">
					{repository.readiness === 'checking'
						? 'Checking this repository…'
						: 'No checks yet. Re-check reads its Supabase files.'}
				</p>
			)}
			<section className="sim-detail-section supabase-worktrees">
				<div className="sim-section-heading">
					<h3>Worktrees</h3>
					<span>{worktrees.length}</span>
				</div>
				{worktrees.length === 0 ? (
					<p className="sim-section-empty">Lanes lists no worktrees here.</p>
				) : (
					<ul className="supabase-worktree-list">
						{worktrees.map((worktree) => (
							<li key={worktree.pathLabel}>
								<span className="supabase-worktree-copy">
									<code className="supabase-worktree-branch">
										{worktree.branch}
									</code>
									<span className="supabase-worktree-path">
										{worktree.pathLabel} ·{' '}
										{worktree.text.replace(/^[^·]+· /, '')}
									</span>
								</span>
								{worktree.stackId === undefined ? null : (
									<Button
										aria-label={`Show the stack for ${worktree.branch}`}
										size="sm"
										variant="ghost"
										onPress={() => {
											if (worktree.stackId !== undefined) {
												onOpenStack(worktree.stackId);
											}
										}}
									>
										Show stack
									</Button>
								)}
							</li>
						))}
					</ul>
				)}
			</section>
			<div className="supabase-repository-footer">
				<p className="sim-inline-note">
					RN Devtools never edits repository files; copy a fix and commit it
					yourself.
				</p>
				<Button
					size="sm"
					variant="ghost"
					onPress={() => {
						window.location.hash = 'simulator/lanes';
					}}
				>
					<Waypoints aria-hidden="true" className="h-3.5 w-3.5" />
					Open in Lanes
				</Button>
			</div>
			<p className="supabase-footnote">
				<FolderGit2 aria-hidden="true" className="h-3.5 w-3.5" />
				Repositories come from Lanes; Track repository adds one there.
			</p>
		</div>
	);
}

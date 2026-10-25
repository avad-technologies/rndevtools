import { Button } from '@heroui/react/button';
import {
	ArrowUpRight,
	FolderOpen,
	Lock,
	Play,
	RefreshCw,
	SlidersHorizontal,
	Square,
	SquareCheckBig,
	Trash2,
	X,
} from 'lucide-react';
import { type RefObject, useEffect, useId, useRef, useState } from 'react';
import {
	SupabaseControlButton,
	SupabaseNotice,
	SupabaseSelect,
} from '@/components/supabase-ui';
import { DisabledReason, RequestCard } from '@/components/ui';
import {
	buildSupabaseRequestCards,
	defaultSupabasePruneSelection,
	isSupabasePruneSelectionStale,
	reviewSupabasePruneSelection,
	type SupabaseOperationInput,
	type SupabasePruneGroupView,
	type SupabasePruneSelection,
	type SupabaseRequestCard,
	supabaseCleanUpOperation,
	supabaseConfirmationKind,
	supabaseInlineConfirmCopy,
	supabasePruneGroups,
	supabasePruneSummary,
	toggleSupabasePruneStack,
} from '@/simulator/supabase-model';
import {
	type SupabaseFocusRequest,
	useSupabaseActions,
} from '@/state/supabase-runtime';
import {
	type SupabaseState,
	supabaseActionAvailability,
} from '../../../shared/supabase-protocol';

/**
 * The approve operation a request card runs: a destroy or reset settles
 * through main's dialog, a capacity request names the stack to stop.
 */
export function supabaseApproveOperation(
	card: Readonly<{
		id: string;
		request: Pick<SupabaseRequestCard['request'], 'kind'>;
	}>,
	stopStackId: string | undefined
): Extract<SupabaseOperationInput, { kind: 'request.approve' }> {
	return {
		kind: 'request.approve',
		requestId: card.id,
		...(card.request.kind === 'start-capacity' && stopStackId !== undefined
			? { stopStackId }
			: {}),
	};
}

/**
 * Clean up's selection: the person's own once they touched it, else what
 * main preselects for the current list.
 */
export function supabaseEffectivePruneSelection(
	touched: SupabasePruneSelection | null,
	prune: SupabaseState['prune']
): Readonly<{ selection: SupabasePruneSelection; stale: boolean }> {
	if (touched === null) {
		return { selection: defaultSupabasePruneSelection(prune), stale: false };
	}
	return {
		selection: touched,
		stale: isSupabasePruneSelectionStale(touched, prune),
	};
}

export function SupabaseRequestsView({
	state,
	now,
	isBridgeAvailable,
	focus,
	onFocusHandled,
	onOpenStack,
	onOpenSettings,
}: {
	state: SupabaseState;
	now: number;
	isBridgeAvailable: boolean;
	focus: SupabaseFocusRequest | null;
	onFocusHandled: (nonce: number) => void;
	onOpenStack: (stackId: string) => void;
	onOpenSettings: () => void;
}) {
	const requestsRef = useRef<HTMLHeadingElement>(null);
	const cleanUpRef = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		if (focus?.target === 'requests') {
			requestsRef.current?.focus();
			onFocusHandled(focus.nonce);
		} else if (focus?.target === 'clean-up') {
			cleanUpRef.current?.focus();
			cleanUpRef.current?.scrollIntoView({ block: 'start' });
			onFocusHandled(focus.nonce);
		}
	}, [focus, onFocusHandled]);
	return (
		<div className="supabase-body panel-scroll">
			<div className="supabase-column">
				<AgentRequests
					headingRef={requestsRef}
					isBridgeAvailable={isBridgeAvailable}
					now={now}
					state={state}
					onOpenSettings={onOpenSettings}
					onOpenStack={onOpenStack}
				/>
				<CleanUp
					headingRef={cleanUpRef}
					isBridgeAvailable={isBridgeAvailable}
					state={state}
				/>
			</div>
		</div>
	);
}

function AgentRequests({
	state,
	now,
	isBridgeAvailable,
	headingRef,
	onOpenStack,
	onOpenSettings,
}: {
	state: SupabaseState;
	now: number;
	isBridgeAvailable: boolean;
	headingRef: RefObject<HTMLHeadingElement | null>;
	onOpenStack: (stackId: string) => void;
	onOpenSettings: () => void;
}) {
	const { run, isPending } = useSupabaseActions();
	const [stopStackIds, setStopStackIds] = useState<Record<string, string>>({});
	const cards = buildSupabaseRequestCards(state, now, {
		bridgeAvailable: isBridgeAvailable,
		stopStackIds,
	});
	return (
		<section
			aria-labelledby="supabase-agent-requests"
			className="supabase-requests"
		>
			<h2
				className="supabase-column-heading"
				id="supabase-agent-requests"
				ref={headingRef}
				tabIndex={-1}
			>
				Agent requests
			</h2>
			{cards.length === 0 ? (
				<p className="sim-section-empty">
					No agent requests. Agents ask here before they destroy a stack or
					reset a database someone else holds; requests expire after 30 min.
				</p>
			) : (
				cards.map((card) => (
					<RequestCardView
						busy={isPending(`request:${card.id}`)}
						card={card}
						key={card.id}
						state={state}
						stopStackId={stopStackIds[card.id]}
						onChooseStop={(stackId) =>
							setStopStackIds((current) => ({ ...current, [card.id]: stackId }))
						}
						onOpenSettings={onOpenSettings}
						onOpenStack={onOpenStack}
						onRun={(input) => void run(input)}
					/>
				))
			)}
		</section>
	);
}

function RequestCardView({
	card,
	state,
	stopStackId,
	busy,
	onChooseStop,
	onRun,
	onOpenStack,
	onOpenSettings,
}: {
	card: SupabaseRequestCard;
	state: SupabaseState;
	stopStackId: string | undefined;
	busy: boolean;
	onChooseStop: (stackId: string) => void;
	onRun: (
		input:
			| ReturnType<typeof supabaseApproveOperation>
			| { kind: 'request.deny'; requestId: string }
	) => void;
	onOpenStack: (stackId: string) => void;
	onOpenSettings: () => void;
}) {
	const approve = supabaseApproveOperation(card, stopStackId);
	const confirmation = supabaseConfirmationKind(approve, state);
	const capacity = card.request.kind === 'start-capacity';
	return (
		<RequestCard
			actions={
				<>
					<SupabaseControlButton
						control={{
							label: card.approve.label,
							availability: card.approve.availability,
							confirmation,
						}}
						icon={
							capacity ? (
								<Play aria-hidden="true" className="h-3.5 w-3.5" />
							) : (
								<Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
							)
						}
						isBusy={busy}
						{...(confirmation.kind === 'inline'
							? {
									inlineCopy: supabaseInlineConfirmCopy(
										approve,
										state,
										confirmation.agents
									),
								}
							: {})}
						onRun={() => onRun(approve)}
					/>
					<SupabaseControlButton
						control={{
							label: card.deny.label,
							availability: card.deny.availability,
							confirmation: { kind: 'none' },
						}}
						icon={<X aria-hidden="true" className="h-3.5 w-3.5" />}
						variant="ghost"
						onRun={() => onRun({ kind: 'request.deny', requestId: card.id })}
					/>
					{capacity ? (
						<Button size="sm" variant="ghost" onPress={onOpenSettings}>
							<SlidersHorizontal aria-hidden="true" className="h-3.5 w-3.5" />
							Raise the limit
						</Button>
					) : null}
					{card.stack ? (
						<Button
							aria-label={`Open the stack for ${card.request.branch}`}
							size="sm"
							variant="ghost"
							onPress={() => {
								if (card.stack) onOpenStack(card.stack.id);
							}}
						>
							<ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
							Open stack
						</Button>
					) : null}
				</>
			}
			meta={card.age}
			title={card.title}
			tone={card.tone}
		>
			<p className="supabase-request-facts">{card.facts}</p>
			{capacity && card.candidates.length > 0 ? (
				<div className="supabase-inline-field">
					<span>Make room:</span>
					<SupabaseSelect
						label={`Stack to stop for ${card.request.branch}`}
						options={[
							{ value: '', label: 'Choose a stack to stop' },
							...card.candidates.map((candidate) => ({
								value: candidate.stackId,
								label: candidate.label,
							})),
						]}
						value={stopStackId ?? ''}
						onChange={(value) => {
							if (value !== '') onChooseStop(value);
						}}
					/>
				</div>
			) : null}
			{card.note ? (
				<blockquote className="supabase-request-note">
					Agent's note: {card.note}
				</blockquote>
			) : null}
			{card.progress ? (
				<p className="supabase-request-progress" role="status">
					{card.progress}
				</p>
			) : null}
			{card.error ? (
				<p className="supabase-request-error" role="alert">
					{card.error.title}
					{card.error.recovery ? ` ${card.error.recovery}` : ''}
				</p>
			) : null}
			{capacity ? (
				<p className="sim-inline-note">
					Stopping a stack a live agent holds asks first. Requests expire after
					30 min.
				</p>
			) : null}
		</RequestCard>
	);
}

function CleanUp({
	state,
	isBridgeAvailable,
	headingRef,
}: {
	state: SupabaseState;
	isBridgeAvailable: boolean;
	headingRef: RefObject<HTMLHeadingElement | null>;
}) {
	const { run, refresh, isPending } = useSupabaseActions();
	const reasonId = useId();
	const [touched, setTouched] = useState<SupabasePruneSelection | null>(null);
	const { selection, stale } = supabaseEffectivePruneSelection(
		touched,
		state.prune
	);
	const groups = supabasePruneGroups(state, selection);
	const summary = supabasePruneSummary(state, selection, {
		bridgeAvailable: isBridgeAvailable,
	});
	const destroying =
		isPending('bulk') ||
		summary.stackIds.some((id) => isPending(`stack:${id}`));
	const toggle = (stackId: string) =>
		setTouched(toggleSupabasePruneStack(selection, state.prune, stackId));
	const cleanUp = async () => {
		const receipt = await run(
			supabaseCleanUpOperation({
				revision: selection.revision,
				stackIds: summary.stackIds,
			})
		);
		// A finished clean up goes back to main's suggestions for the new list.
		if (receipt.completed && receipt.cancelled !== true) setTouched(null);
	};
	return (
		<section aria-labelledby="supabase-clean-up" className="supabase-clean-up">
			<div className="supabase-column-bar">
				<h2
					className="supabase-column-heading"
					id="supabase-clean-up"
					ref={headingRef}
					tabIndex={-1}
				>
					Clean up
				</h2>
				<Button
					aria-label="Refresh the clean up suggestions"
					isDisabled={!isBridgeAvailable || isPending('refresh')}
					size="sm"
					variant="ghost"
					onPress={() => void refresh()}
				>
					<RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
					Refresh
				</Button>
			</div>
			<div className="sim-disk-summary">
				<div>
					<span>On disk</span>
					<strong>{summary.onDisk}</strong>
				</div>
				<div>
					<span>Suggested</span>
					<strong>{summary.suggested}</strong>
				</div>
				<div>
					<span>Selected</span>
					<strong>{summary.selectedSize}</strong>
				</div>
			</div>
			{stale ? (
				<SupabaseNotice
					actions={
						<Button
							className="supabase-notice-button"
							size="sm"
							variant="ghost"
							onPress={() => {
								if (touched) {
									setTouched(
										reviewSupabasePruneSelection(touched, state.prune)
									);
								}
							}}
						>
							Review selection
						</Button>
					}
					inset
					title="The list changed."
					tone="warning"
				>
					Review the selection again; stacks that can no longer be cleaned up
					drop out of it.
				</SupabaseNotice>
			) : null}
			{groups.length === 0 ? (
				<p className="sim-section-empty">
					Nothing to clean up. RN Devtools suggests stacks whose worktree is
					gone, whose branch moved, that stopped longer than{' '}
					{state.policy.retentionDays} days, or that never started.
				</p>
			) : (
				<div className="supabase-prune-groups">
					{groups.map((group) => (
						<PruneGroup
							group={group}
							isBridgeAvailable={isBridgeAvailable}
							key={group.id}
							state={state}
							onReveal={(stackId) =>
								void run({ kind: 'reveal', stackId, what: 'stack-folder' })
							}
							onToggle={toggle}
						/>
					))}
				</div>
			)}
			<div className="sim-disk-cleanup-action">
				<div>
					<strong>{summary.statusLine}</strong>
					<span>
						Destroy deletes their databases and logs; RN Devtools never deletes
						a database on its own.
					</span>
				</div>
				<Button
					{...(summary.availability.allowed
						? {}
						: { 'aria-describedby': reasonId })}
					isDisabled={!summary.availability.allowed || destroying}
					size="sm"
					variant="danger"
					onPress={() => void cleanUp()}
				>
					<Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
					{summary.triggerLabel}
				</Button>
				{summary.availability.allowed ? null : (
					<DisabledReason id={reasonId}>
						{summary.availability.reason}
					</DisabledReason>
				)}
			</div>
			<p className="sim-disk-last-cleanup" role="status">
				{summary.lastResult ?? ''}
			</p>
			<p className="sim-inline-note">{summary.notSuggested}</p>
		</section>
	);
}

function PruneGroup({
	group,
	state,
	isBridgeAvailable,
	onToggle,
	onReveal,
}: {
	group: SupabasePruneGroupView;
	state: SupabaseState;
	isBridgeAvailable: boolean;
	onToggle: (stackId: string) => void;
	onReveal: (stackId: string) => void;
}) {
	return (
		<fieldset className="supabase-prune-group">
			<legend className="sr-only">{group.label}</legend>
			{group.rows.map((row) => {
				const stack = state.stacks.find(
					(candidate) => candidate.id === row.stackId
				);
				if (!group.selectable) {
					const reveal = stack
						? supabaseActionAvailability(stack, 'reveal', {
								bridgeAvailable: isBridgeAvailable,
								state,
							})
						: undefined;
					return (
						<div className="is-protected supabase-prune-row" key={row.stackId}>
							<span className="sim-disk-category-check">
								<Lock aria-hidden="true" className="h-3.5 w-3.5" />
							</span>
							<span>
								<strong className="supabase-prune-title">
									{group.label} ·{' '}
									<code className="supabase-code">{row.title}</code>
								</strong>
								<small className="supabase-prune-detail">
									{group.consequence}
								</small>
							</span>
							<code className="supabase-prune-size">{row.sizeLabel}</code>
							{reveal ? (
								<SupabaseControlButton
									control={{
										label: 'Reveal in Finder',
										availability: reveal,
										confirmation: { kind: 'none' },
									}}
									icon={
										<FolderOpen aria-hidden="true" className="h-3.5 w-3.5" />
									}
									variant="ghost"
									onRun={() => onReveal(row.stackId)}
								/>
							) : null}
						</div>
					);
				}
				return (
					<button
						aria-pressed={row.selected}
						className={`supabase-prune-row ${row.selected ? 'is-selected' : ''}`}
						key={row.stackId}
						type="button"
						onClick={() => onToggle(row.stackId)}
					>
						<span className="sim-disk-category-check">
							{row.selected ? (
								<SquareCheckBig aria-hidden="true" className="h-3.5 w-3.5" />
							) : (
								<Square aria-hidden="true" className="h-3.5 w-3.5" />
							)}
						</span>
						<span>
							<strong className="supabase-prune-title">
								{group.label} ·{' '}
								<code className="supabase-code">{row.title}</code>
							</strong>
							<small className="supabase-prune-detail">
								{group.consequence}
							</small>
						</span>
						<code className="supabase-prune-size">{row.sizeLabel}</code>
					</button>
				);
			})}
		</fieldset>
	);
}

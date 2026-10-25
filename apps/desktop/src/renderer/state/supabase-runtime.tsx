import {
	type Context,
	createContext,
	type Dispatch,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
} from 'react';
import type { ActionStatus } from '@/lib/action-notice';
import { errorText, nextActionId } from '@/lib/runtime-action';
import {
	SUPABASE_STACK_FILTERS,
	type SupabaseDetailSection,
	type SupabaseOperationInput,
	type SupabaseRepositoryFilter,
	type SupabaseStackFilter,
	type SupabaseView,
	supabaseClockCadence,
	supabaseRequesterName,
} from '@/simulator/supabase-model';
import { formatStopDelay } from '../../shared/device-hold';
import {
	EMPTY_SUPABASE_STATE,
	isActiveSupabaseJob,
	isSupabaseStackRunning,
	SUPABASE_CONFIRMATION_KINDS,
	SUPABASE_DETAIL_SECTIONS,
	SUPABASE_MAX_BATCH,
	SUPABASE_NO_INTEREST,
	SUPABASE_REASONS,
	type SupabaseBridge,
	type SupabaseErrorView,
	type SupabaseInterest,
	type SupabaseJob,
	type SupabaseOperation,
	type SupabaseOperationReceipt,
	type SupabaseSidebarBadge,
	type SupabaseState,
	sidebarBadge,
	supabaseAgentLabel,
	supabaseBranchLabel,
	supabaseConfirmationRequired,
	supabaseDesktopError,
	supabaseOperationSchema,
	supabaseStackTitle,
	withSupabaseConfirmation,
} from '../../shared/supabase-protocol';

/**
 * The renderer side of local Supabase: one subscription to main's state,
 * the confirm-then-run path for every control, per-stack pending keys,
 * debounced interest, and the tab's navigation state, which outlives the
 * lazily mounted panel.
 *
 * State, actions and navigation sit in separate contexts, plus a fourth
 * for the shell's badge and job count, so a pushed state re-renders only
 * the components that read it, never App, the titlebar or the sidebar.
 */

const IDLE: ActionStatus = { kind: 'idle', message: '' };

// ---------------------------------------------------------------------------
// Bridge and revisions

const BRIDGE_METHODS = [
	'getSupabaseState',
	'subscribeSupabaseState',
	'runSupabaseOperation',
	'requestSupabaseConfirmation',
	'setSupabaseInterest',
] as const;

/** The Supabase half of the preload bridge, or null when this window has none. */
export function resolveSupabaseBridge(
	candidate: unknown
): SupabaseBridge | null {
	if (typeof candidate !== 'object' || candidate === null) return null;
	const methods = candidate as Partial<
		Record<(typeof BRIDGE_METHODS)[number], unknown>
	>;
	return BRIDGE_METHODS.every((method) => typeof methods[method] === 'function')
		? (candidate as SupabaseBridge)
		: null;
}

/**
 * Pushed and receipt states are accepted only when they are not older than
 * the one on screen, so a slow receipt never rolls a newer push back.
 */
export function acceptSupabaseState(
	current: SupabaseState,
	next: SupabaseState | undefined
): SupabaseState {
	return next !== undefined && next.revision >= current.revision
		? next
		: current;
}

// ---------------------------------------------------------------------------
// Operations

export function createSupabaseActionId(): string {
	return nextActionId('supabase');
}

export function withSupabaseActionId(
	input: SupabaseOperationInput,
	actionId: string
): SupabaseOperation {
	return { ...input, actionId } as SupabaseOperation;
}

/** Bulk operations hold this key as well as each stack's. */
export const SUPABASE_BULK_PENDING_KEY = 'bulk';

export function supabaseStackPendingKey(stackId: string): string {
	return `stack:${stackId}`;
}

/**
 * What an operation keeps busy until main answers: a stack, the bulk key, or
 * a read of its own. Reads use their own keys, so reading logs never blocks
 * Stop; a second press of the same control while it runs is refused. A
 * background run, such as a log auto-refresh tick, holds keys of its own, so
 * it never refuses the operator's read of the same stack.
 */
export function supabasePendingKeys(
	operation: SupabaseOperationInput,
	{ background = false }: Readonly<{ background?: boolean }> = {}
): readonly string[] {
	const keys = operationPendingKeys(operation);
	return background ? keys.map((key) => `background:${key}`) : keys;
}

function operationPendingKeys(
	operation: SupabaseOperationInput
): readonly string[] {
	switch (operation.kind) {
		case 'stop':
		case 'destroy': {
			const [first] = operation.stackIds;
			return operation.stackIds.length === 1 && first !== undefined
				? [supabaseStackPendingKey(first)]
				: [
						SUPABASE_BULK_PENDING_KEY,
						...operation.stackIds.map(supabaseStackPendingKey),
					];
		}
		case 'read-logs':
		case 'read-database':
			return [`${operation.kind}:${operation.stackId}`];
		case 'copy':
			return [`copy:${operation.stackId}:${operation.what}`];
		case 'open':
			return [`open:${operation.stackId}:${operation.surface}`];
		case 'reveal':
			return [`reveal:${operation.stackId}:${operation.what}`];
		case 'prepare':
			return operation.stackId === undefined
				? [`repository:${operation.repositoryId ?? ''}`]
				: [supabaseStackPendingKey(operation.stackId)];
		case 'repository.recheck':
		case 'repository.set-mode':
			return [`repository:${operation.repositoryId}`];
		case 'request.approve':
		case 'request.deny':
			return [`request:${operation.requestId}`];
		case 'cancel-job':
			return [`job:${operation.jobId}`];
		case 'restart-metro':
			return [`lane:${operation.laneId}`];
		case 'set-enabled':
			return ['feature'];
		case 'update-policy':
			return ['policy'];
		case 'choose-path':
			return [`path:${operation.field}`];
		case 'refresh':
			return ['refresh'];
		default:
			return [supabaseStackPendingKey(operation.stackId)];
	}
}

function failedReceipt(
	operation: SupabaseOperation,
	error: SupabaseErrorView
): SupabaseOperationReceipt {
	return {
		actionId: operation.actionId,
		kind: operation.kind,
		completed: false,
		error,
	};
}

function cancelledReceipt(
	operation: SupabaseOperation
): SupabaseOperationReceipt {
	return {
		actionId: operation.actionId,
		kind: operation.kind,
		completed: false,
		cancelled: true,
	};
}

const CONFIRMABLE_KINDS: ReadonlySet<string> = new Set(
	SUPABASE_CONFIRMATION_KINDS
);

/**
 * Runs an operation, first through main's native dialog when it guards it:
 * request the confirmation, merge the dialog's token and options with
 * withSupabaseConfirmation, and run with the same actionId. If the state
 * moved under the click and main now wants the dialog, it is asked once.
 * A dismissed dialog comes back as a cancelled receipt.
 */
export async function confirmThenRunSupabaseOperation(
	bridge: Pick<
		SupabaseBridge,
		'requestSupabaseConfirmation' | 'runSupabaseOperation'
	>,
	operation: SupabaseOperation,
	state: Pick<SupabaseState, 'stacks' | 'requests' | 'policy'>
): Promise<SupabaseOperationReceipt> {
	const confirmAndRun = async (): Promise<SupabaseOperationReceipt> => {
		const result = await bridge.requestSupabaseConfirmation(operation);
		if (
			result.actionId === operation.actionId &&
			!result.confirmed &&
			result.error === undefined
		) {
			return cancelledReceipt(operation);
		}
		const merged = withSupabaseConfirmation(operation, result);
		if (!merged.ok) {
			return failedReceipt(
				operation,
				supabaseDesktopError('confirmation_required', merged.error)
			);
		}
		return bridge.runSupabaseOperation(merged.operation);
	};
	if (supabaseConfirmationRequired(operation, state)) return confirmAndRun();
	const receipt = await bridge.runSupabaseOperation(operation);
	return receipt.error?.code === 'confirmation_required' &&
		CONFIRMABLE_KINDS.has(operation.kind)
		? confirmAndRun()
		: receipt;
}

// ---------------------------------------------------------------------------
// Action notices

/**
 * What a control may say instead of the defaults.
 */
export type SupabaseActionMessages = Readonly<{
	pending?: string;
	success?: string;
	/** Leads the failure notice, e.g. `Could not stop feat-x`. */
	failure?: string;
	/** Leave the shared notice alone; the control shows its own result. */
	quiet?: boolean;
	/**
	 * A run the panel repeats on its own, such as log auto-refresh: it never
	 * refuses, or is refused by, the operator's run of the same operation.
	 */
	background?: boolean;
}>;

/**
 * The default notice copy for an operation, from the UI spec's controls.
 */
export type SupabaseActionCopy = Readonly<{
	pending?: string;
	/** Computed from the state the operation left; silent when undefined. */
	success?: (state: SupabaseState) => string | undefined;
	cancelled?: string;
	failure?: string;
	/** Reads and copies report inline, never in the shared notice. */
	quiet?: boolean;
}>;

function titleOf(
	state: Pick<SupabaseState, 'stacks'>,
	stackId: string
): string {
	const stack = state.stacks.find((candidate) => candidate.id === stackId);
	return stack ? supabaseStackTitle(stack) : `${stackId.slice(0, 8)}…`;
}

function apiPortOf(
	state: Pick<SupabaseState, 'stacks'>,
	stackId: string
): number | undefined {
	return state.stacks.find((candidate) => candidate.id === stackId)?.ports.api;
}

function onPort(port: number | undefined): string {
	return port === undefined ? '' : ` on :${port}`;
}

function delayText(ms: number): string {
	return ms === 0 ? 'as soon as' : formatStopDelay(ms);
}

function requesterOf(
	state: Pick<SupabaseState, 'requests'>,
	requestId: string
): Readonly<{ who: string; branch: string; kind?: string }> {
	const request = state.requests.find(
		(candidate) => candidate.id === requestId
	);
	if (!request) return { who: 'The agent', branch: 'the stack' };
	return {
		who: supabaseRequesterName(request.requester),
		branch: request.branch,
		kind: request.kind,
	};
}

function runningManaged(state: Pick<SupabaseState, 'stacks'>): number {
	return state.stacks.filter(
		(stack) =>
			(stack.origin === 'managed' || stack.origin === 'adopted') &&
			(isSupabaseStackRunning(stack) || stack.state === 'starting')
	).length;
}

/**
 * The pending, success and failure copy for an operation, worded from the
 * state it runs on. Main's own outcome message wins over these when a
 * receipt carries one.
 */
export function supabaseActionCopy(
	operation: SupabaseOperationInput,
	state: SupabaseState
): SupabaseActionCopy {
	switch (operation.kind) {
		case 'refresh':
			return { failure: 'Could not refresh Supabase stacks' };
		case 'read-logs':
		case 'read-database':
		case 'copy':
			return { quiet: true };
		case 'start': {
			const { stackId } = operation;
			const title = titleOf(state, stackId);
			const stack = state.stacks.find((candidate) => candidate.id === stackId);
			const creating =
				!stack ||
				stack.state === 'not-created' ||
				stack.state === 'never-started' ||
				stack.state === 'failed';
			return {
				pending: creating
					? `Starting Supabase for ${title}… about 5 s${state.disk.cacheState === 'cold' ? '; the first start on this Mac takes about 45 s' : ''}`
					: `Starting ${title}…`,
				success: (next) =>
					creating
						? `${title} is running${onPort(apiPortOf(next, stackId))}.`
						: `${title} resumed${onPort(apiPortOf(next, stackId))}. Data was kept.`,
				cancelled: `Start of ${title} cancelled.`,
				failure: `Could not start ${title}`,
			};
		}
		case 'resume-saved': {
			const title = titleOf(state, operation.stackId);
			return {
				pending: `Resuming ${title} with its saved settings…`,
				success: () =>
					`${title} resumed with its saved settings. Data was kept.`,
				failure: `Could not resume ${title}`,
			};
		}
		case 'stop': {
			const [first] = operation.stackIds;
			if (operation.stackIds.length === 1 && first !== undefined) {
				const title = titleOf(state, first);
				const external =
					state.stacks.find((stack) => stack.id === first)?.origin ===
					'external';
				return {
					pending: `Stopping ${title}…`,
					success: () =>
						external
							? `${title} stopped. RN Devtools still doesn't manage it; data and ports are kept.`
							: `${title} stopped. Data and ports are kept; Resume brings it back in about a second.`,
					failure: `Could not stop ${title}`,
				};
			}
			const count = operation.stackIds.length;
			return {
				pending: `Stopping ${count} stacks…`,
				success: () => `Stopped ${count} stacks. Data and ports are kept.`,
				failure: `Could not stop all ${count} stacks`,
			};
		}
		case 'restart': {
			const title = titleOf(state, operation.stackId);
			return {
				pending: `Restarting ${title}'s services…`,
				success: () =>
					`${title}'s services restarted. Saved settings, exclusions, data and keys were kept.`,
				failure: `Could not restart ${title}`,
			};
		}
		case 'stop-and-start': {
			const title = titleOf(state, operation.stackId);
			const version = state.stacks.find(
				(stack) => stack.id === operation.stackId
			)?.cli.version;
			return {
				pending: `Stopping and starting ${title}…`,
				success: () =>
					operation.purpose === 'switch-cli'
						? `${title} restarted with ${version === undefined ? "this worktree's Supabase CLI" : `Supabase CLI ${version}`}. Database tools are back.`
						: operation.purpose === 'apply-config'
							? `${title} restarted with its current settings.`
							: `${title} restarted. Data was kept.`,
				failure: `Could not restart ${title}`,
			};
		}
		case 'reapply-exclusions': {
			const title = titleOf(state, operation.stackId);
			const excluded = state.policy.exclude;
			return {
				pending: `Re-applying exclusions on ${title}…`,
				success: () =>
					excluded.length === 0
						? `Exclusions re-applied on ${title}.`
						: `${excluded.join(' and ')} ${excluded.length === 1 ? 'is' : 'are'} excluded again on ${title}.`,
				failure: `Could not re-apply exclusions on ${title}`,
			};
		}
		case 'pin': {
			const title = titleOf(state, operation.stackId);
			return {
				success: () => `${title} keeps running until you unpin or stop it.`,
				failure: 'Could not save the pin',
			};
		}
		case 'unpin': {
			const title = titleOf(state, operation.stackId);
			const delay = delayText(state.policy.unheldStopDelayMs);
			return {
				success: () =>
					delay === 'as soon as'
						? `Unpinned. ${title} stops as soon as nothing holds it.`
						: `Unpinned. ${title} stops ${delay} after nothing holds it.`,
				failure: 'Could not save the pin',
			};
		}
		case 'release': {
			const title = titleOf(state, operation.stackId);
			const agent = supabaseAgentLabel({
				kind: operation.holder.agentKind,
				sessionId: operation.holder.sessionId,
				synthetic: operation.holder.holder === 'worktree',
			});
			const delay = delayText(state.policy.unheldStopDelayMs);
			return {
				success: (next) => {
					const stack = next.stacks.find(
						(candidate) => candidate.id === operation.stackId
					);
					const held = stack?.holds.some((hold) => hold.live) ?? false;
					return held || delay === 'as soon as'
						? `Released ${agent}'s hold.`
						: `Released ${agent}'s hold. ${title} stops in ${delay} unless something else holds it.`;
				},
				failure: 'Could not release the hold',
			};
		}
		case 'adopt': {
			const title = titleOf(state, operation.stackId);
			return {
				success: () => `${title} is now managed by RN Devtools.`,
				failure: `Could not adopt ${title}`,
			};
		}
		case 'prepare':
			return {
				pending: 'Downloading services… one time, up to about 360 MB',
				success: () =>
					'Services downloaded. New stacks now start in about 5 s.',
				cancelled: 'Download cancelled. Nothing else changed.',
				failure: 'Download failed',
			};
		case 'apply-migrations': {
			const title = titleOf(state, operation.stackId);
			return {
				pending: `Applying migrations to ${title}…`,
				success: () => `Applied pending migrations to ${title}.`,
				failure: `Could not apply migrations to ${title}`,
			};
		}
		case 'reset': {
			const title = titleOf(state, operation.stackId);
			return {
				pending: `Resetting ${title}'s database…`,
				success: () =>
					operation.seed
						? `${title} reset to migrations and seed.`
						: `${title} reset to migrations; seed skipped.`,
				failure: `Database reset of ${title} did not finish`,
			};
		}
		case 'seed-buckets': {
			const title = titleOf(state, operation.stackId);
			return {
				pending: `Seeding buckets for ${title}…`,
				success: () => `Buckets seeded for ${title}.`,
				failure: `Could not seed buckets for ${title}`,
			};
		}
		case 'export': {
			const title = titleOf(state, operation.stackId);
			return {
				pending: `Exporting ${title}'s ${operation.content}…`,
				success: () =>
					`Exported ${title}'s ${operation.content}. Storage files aren't included.`,
				failure: 'Export failed',
			};
		}
		case 'destroy': {
			const [first] = operation.stackIds;
			if (operation.stackIds.length === 1 && first !== undefined) {
				const title = titleOf(state, first);
				return {
					pending: `Destroying ${title}…`,
					success: () => `Destroyed ${title}.`,
					failure: `Could not destroy ${title}`,
				};
			}
			const count = operation.stackIds.length;
			return {
				pending:
					operation.pruneRevision === undefined
						? `Destroying ${count} stacks…`
						: `Cleaning up ${count} stacks…`,
				success: () => `Destroyed ${count} stacks.`,
				failure: `Could not destroy all ${count} stacks`,
			};
		}
		case 'recreate': {
			const title = titleOf(state, operation.stackId);
			return {
				pending: `Recreating ${title}…`,
				success: () =>
					`${title} recreated with a fresh, migrated, seeded database.`,
				failure: `Could not recreate ${title}`,
			};
		}
		case 'set-studio': {
			const title = titleOf(state, operation.stackId);
			return operation.enabled
				? {
						pending: `Enabling Studio for ${title}…`,
						success: () =>
							`Studio is on for ${title}. It sleeps after 5 min idle.`,
						failure: `Could not enable Studio for ${title}`,
					}
				: {
						pending: `Turning Studio off for ${title}…`,
						success: () => `Studio is off again for ${title}.`,
						failure: `Could not turn Studio off for ${title}`,
					};
		}
		case 'follow-branch': {
			const stack = state.stacks.find(
				(candidate) => candidate.id === operation.stackId
			);
			const next =
				supabaseBranchLabel(stack?.currentHead?.ref) ?? 'the new branch';
			return {
				pending: `Following ${next}…`,
				success: () => `Now following ${next}.`,
				failure: `Could not follow ${next}`,
			};
		}
		case 'open':
			return operation.surface === 'mailpit'
				? { pending: 'Opening Mailpit…', failure: 'Could not open Mailpit' }
				: {
						pending: 'Opening Studio… it can take about 18 s to wake',
						failure: 'Could not open Studio',
					};
		case 'reveal':
			return { failure: 'Could not reveal it in Finder' };
		case 'request.approve': {
			const { who, branch, kind } = requesterOf(state, operation.requestId);
			return {
				pending:
					kind === 'reset'
						? `Resetting ${branch}…`
						: kind === 'start-capacity'
							? `Starting ${branch}…`
							: `Destroying ${branch}…`,
				success: () =>
					kind === 'reset'
						? `Reset ${branch} as ${who} asked.`
						: kind === 'start-capacity'
							? `Started ${branch} for ${who}.`
							: `Destroyed ${branch} as ${who} asked.`,
				failure: 'Could not settle the request',
			};
		}
		case 'request.deny': {
			const { who } = requesterOf(state, operation.requestId);
			return {
				success: () => `Request denied. ${who} is told on its next call.`,
				failure: 'Could not deny the request',
			};
		}
		case 'set-enabled':
			return operation.enabled
				? {
						pending: 'Turning on local Supabase…',
						success: () =>
							'Local Supabase is on. Development lanes on opted-in worktrees now get their own database.',
						failure: 'Could not turn on local Supabase',
					}
				: {
						pending: 'Turning off local Supabase…',
						success: (next) => {
							if (operation.disposition === 'stop-managed') {
								return 'Local Supabase is off. Managed stacks were stopped; data kept.';
							}
							const running = runningManaged(next);
							return running > 0
								? `Local Supabase is off. ${running} ${running === 1 ? 'stack keeps' : 'stacks keep'} running.`
								: 'Local Supabase is off.';
						},
						failure: 'Could not turn off local Supabase',
					};
		case 'update-policy': {
			const includesStudio =
				operation.patch.exclude !== undefined &&
				state.policy.exclude.includes('studio') &&
				!operation.patch.exclude.includes('studio');
			return {
				pending: 'Saving Supabase settings…',
				success: () =>
					includesStudio
						? 'New stacks start with Studio. Its SQL endpoint has no authentication while it runs.'
						: operation.patch.allowUnverifiedPatch === true
							? 'Unverified patch releases can be managed after a live check.'
							: 'Supabase settings saved. They apply to the next start; running stacks keep theirs.',
				failure: 'Could not save Supabase settings',
			};
		}
		case 'repository.recheck': {
			const label =
				state.repositories.find(
					(repository) => repository.id === operation.repositoryId
				)?.label ?? 'The repository';
			return {
				pending: `Checking ${label}…`,
				success: (next) => {
					const fixes =
						next.repositories
							.find((repository) => repository.id === operation.repositoryId)
							?.checks.filter((check) => check.status === 'needs-fix').length ??
						0;
					return fixes > 0
						? `${label} checked · ${fixes} ${fixes === 1 ? 'fix' : 'fixes'} needed.`
						: `${label} checked.`;
				},
				failure: `Could not check ${label}`,
			};
		}
		case 'repository.set-mode': {
			const label =
				state.repositories.find(
					(repository) => repository.id === operation.repositoryId
				)?.label ?? 'this repository';
			return {
				success: () =>
					operation.mode === 'auto'
						? `Lanes in ${label} get a local Supabase stack again.`
						: `Local Supabase is off for ${label}. Running stacks keep running.`,
				failure: 'Could not change the repository setting',
			};
		}
		case 'cancel-job':
			return {
				pending: SUPABASE_REASONS.cancelling,
				failure: 'Could not cancel it',
			};
		case 'restart-metro': {
			const stack = state.stacks.find((candidate) =>
				candidate.lanes.some((lane) => lane.laneId === operation.laneId)
			);
			const port = stack?.lanes.find(
				(lane) => lane.laneId === operation.laneId
			)?.port;
			return {
				pending: 'Restarting Metro…',
				success: () =>
					port === undefined || !stack
						? "Metro restarted with the stack's address."
						: `Metro for lane :${port} restarted with ${supabaseStackTitle(stack)}'s database.`,
				failure: 'Could not restart Metro',
			};
		}
		case 'choose-path':
			return { failure: "That folder can't be used" };
	}
}

/** `Could not stop feat-x: Busy. Another operation… Wait a moment, then retry.` */
export function supabaseFailureText(
	prefix: string | undefined,
	error: SupabaseErrorView
): string {
	const sentence = (text: string) =>
		/[.!?…]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
	const lead = prefix ? `${prefix}: ${error.title}` : error.title;
	return [
		sentence(lead),
		error.message.trim() && error.message.trim() !== error.title
			? sentence(error.message)
			: '',
		error.recovery.trim() ? sentence(error.recovery) : '',
	]
		.filter(Boolean)
		.join(' ');
}

/** The notice a receipt leaves: success, an error, or idle for a silent one. */
export function supabaseReceiptNotice(
	receipt: SupabaseOperationReceipt,
	copy: SupabaseActionCopy,
	messages: SupabaseActionMessages,
	state: SupabaseState
): ActionStatus {
	if (receipt.cancelled === true) return IDLE;
	const prefix = messages.failure ?? copy.failure;
	if (!receipt.completed) {
		return {
			kind: 'error',
			message: supabaseFailureText(
				prefix,
				receipt.error ??
					supabaseDesktopError(
						'internal',
						'The Supabase operation did not complete.'
					)
			),
		};
	}
	if (receipt.error) {
		return {
			kind: 'error',
			message: receipt.message ?? supabaseFailureText(prefix, receipt.error),
		};
	}
	const message = receipt.message ?? messages.success ?? copy.success?.(state);
	return message ? { kind: 'success', message } : IDLE;
}

/** The notice a tracked job leaves once it ends; undefined while it runs. */
export function supabaseJobNotice(
	job: Pick<SupabaseJob, 'status' | 'error'>,
	copy: SupabaseActionCopy,
	messages: SupabaseActionMessages,
	state: SupabaseState
): ActionStatus | undefined {
	const prefix = messages.failure ?? copy.failure;
	switch (job.status) {
		case 'queued':
		case 'running':
			return undefined;
		case 'complete': {
			const message = messages.success ?? copy.success?.(state);
			return message ? { kind: 'success', message } : IDLE;
		}
		case 'cancelled':
			return { kind: 'success', message: copy.cancelled ?? 'Cancelled.' };
		case 'failed':
			return {
				kind: 'error',
				message: supabaseFailureText(
					prefix,
					job.error ?? supabaseDesktopError('internal', 'The operation failed.')
				),
			};
		case 'lost':
			return {
				kind: 'error',
				message: `${prefix ?? 'The Supabase operation'}: RN Devtools lost track of it when it restarted. Refresh to see where it stands.`,
			};
	}
}

/** A job started from this window, watched until it ends. */
export type SupabaseJobWatch = Readonly<{
	actionId: string;
	copy: SupabaseActionCopy;
	messages: SupabaseActionMessages;
	quiet: boolean;
	/** The state revision when watching began. */
	revision: number;
	/** The job as last listed, once main has listed it. */
	last?: SupabaseJob;
}>;

/** A job main never lists within this many newer states stops being watched. */
const UNSEEN_JOB_REVISIONS = 3;

/**
 * What the watched jobs say about a new state: the notices their endings
 * leave and the watches still running. A job that leaves the list, or never
 * joins it, has an unknown outcome, so its notice clears instead of
 * claiming success.
 */
export function settleSupabaseJobs(
	watches: ReadonlyMap<string, SupabaseJobWatch>,
	state: SupabaseState
): Readonly<{
	watches: Map<string, SupabaseJobWatch>;
	notices: readonly Readonly<{
		actionId: string;
		status: ActionStatus;
		quiet: boolean;
	}>[];
}> {
	const next = new Map<string, SupabaseJobWatch>();
	const notices: { actionId: string; status: ActionStatus; quiet: boolean }[] =
		[];
	for (const [jobId, watch] of watches) {
		const job = state.jobs.find((candidate) => candidate.id === jobId);
		if (!job) {
			const vanished =
				watch.last !== undefined ||
				state.revision - watch.revision >= UNSEEN_JOB_REVISIONS;
			if (vanished) {
				notices.push({
					actionId: watch.actionId,
					status: IDLE,
					quiet: watch.quiet,
				});
			} else {
				next.set(jobId, watch);
			}
			continue;
		}
		const status = supabaseJobNotice(job, watch.copy, watch.messages, state);
		if (status) {
			notices.push({ actionId: watch.actionId, status, quiet: watch.quiet });
		} else {
			next.set(jobId, { ...watch, last: job });
		}
	}
	return { watches: next, notices };
}

// ---------------------------------------------------------------------------
// Interest

/**
 * Collapses every registered interest into the one main sees: the newest
 * view wins, an inspected stack is kept from any Stacks registration, and
 * the sections opened on that stack are merged in display order.
 */
export function resolveSupabaseInterest(
	interests: Iterable<SupabaseInterest>
): SupabaseInterest {
	const visible = [...interests].filter(
		(interest) => interest.view !== 'hidden'
	);
	const latest = visible.at(-1);
	if (!latest) return SUPABASE_NO_INTEREST;
	if (latest.view !== 'stacks') return { view: latest.view, sections: [] };
	const inspected = [...visible]
		.reverse()
		.find(
			(interest) =>
				interest.view === 'stacks' && interest.inspectStackId !== undefined
		)?.inspectStackId;
	if (inspected === undefined) return { view: 'stacks', sections: [] };
	const sections = new Set(
		visible
			.filter((interest) => interest.inspectStackId === inspected)
			.flatMap((interest) => interest.sections)
	);
	return {
		view: 'stacks',
		inspectStackId: inspected,
		sections: SUPABASE_DETAIL_SECTIONS.filter((section) =>
			sections.has(section)
		),
	};
}

const INTEREST_DEBOUNCE_MS = 60;

// ---------------------------------------------------------------------------
// Navigation

type SupabaseFocusTarget =
	| 'stack'
	| 'repository'
	| 'requests'
	| 'clean-up'
	| 'settings';

/**
 * A heading to focus once its view renders; deep links set one.
 */
export type SupabaseFocusRequest = Readonly<{
	target: SupabaseFocusTarget;
	id?: string;
	/** A deep link's detail section, so the view can read it once it opens. */
	section?: SupabaseDetailSection;
	nonce: number;
}>;

export type SupabaseNavigation = Readonly<{
	view: SupabaseView;
	/** Where the gear returns to from Settings. */
	returnView: Exclude<SupabaseView, 'settings'>;
	filter: SupabaseStackFilter;
	repositoryFilter: SupabaseRepositoryFilter;
	query: string;
	/** The Repositories view searches on its own, so switching views keeps both. */
	repositoryQuery: string;
	selectedStackId: string | null;
	selectedRepositoryId: string | null;
	batchMode: boolean;
	batchIds: readonly string[];
	/** Disclosure choices per stack; unset sections use the defaults. */
	sections: Readonly<
		Record<string, Readonly<Partial<Record<SupabaseDetailSection, boolean>>>>
	>;
	noticesExpanded: boolean;
	focus: SupabaseFocusRequest | null;
	focusNonce: number;
}>;

/**
 * Where another panel sends the operator: a stack, a repository, a view.
 */
export type SupabaseOpenIntent = Readonly<{
	stackId?: string;
	repositoryId?: string;
	view?: SupabaseView;
	/** A detail section to open, or the Clean up heading in Requests. */
	section?: SupabaseDetailSection | 'clean-up';
}>;

export type SupabaseNavigationAction =
	| Readonly<{ type: 'open'; intent: SupabaseOpenIntent }>
	| Readonly<{ type: 'set-view'; view: SupabaseView }>
	| Readonly<{ type: 'toggle-settings' }>
	| Readonly<{ type: 'select-stack'; stackId: string | null }>
	| Readonly<{ type: 'select-repository'; repositoryId: string | null }>
	| Readonly<{ type: 'set-filter'; filter: SupabaseStackFilter }>
	| Readonly<{
			type: 'set-repository-filter';
			filter: SupabaseRepositoryFilter;
	  }>
	| Readonly<{ type: 'set-query'; query: string }>
	| Readonly<{ type: 'set-repository-query'; query: string }>
	| Readonly<{ type: 'set-batch-mode'; enabled: boolean }>
	| Readonly<{ type: 'set-batch'; stackIds: readonly string[] }>
	| Readonly<{ type: 'toggle-batch'; stackId: string }>
	| Readonly<{
			type: 'set-section';
			stackId: string;
			section: SupabaseDetailSection;
			open: boolean;
	  }>
	| Readonly<{ type: 'set-notices-expanded'; expanded: boolean }>
	/** Focuses a heading without moving the view, e.g. after a destroy. */
	| Readonly<{
			type: 'request-focus';
			target: SupabaseFocusTarget;
			id?: string;
	  }>
	| Readonly<{ type: 'focus-handled'; nonce: number }>;

export const INITIAL_SUPABASE_NAVIGATION: SupabaseNavigation = Object.freeze({
	view: 'stacks',
	returnView: 'stacks',
	filter: 'all',
	repositoryFilter: 'all',
	query: '',
	repositoryQuery: '',
	selectedStackId: null,
	selectedRepositoryId: null,
	batchMode: false,
	batchIds: [],
	sections: {},
	noticesExpanded: false,
	focus: null,
	focusNonce: 0,
});

const MAX_REMEMBERED_STACKS = 128;

function withView(
	navigation: SupabaseNavigation,
	view: SupabaseView
): SupabaseNavigation {
	return view === 'settings'
		? {
				...navigation,
				view,
				returnView:
					navigation.view === 'settings'
						? navigation.returnView
						: navigation.view,
			}
		: { ...navigation, view, returnView: view };
}

function batch(ids: readonly string[]): readonly string[] {
	return [...new Set(ids)].slice(0, SUPABASE_MAX_BATCH);
}

/** The tab's navigation, as a pure reducer so deep links are testable. */
export function supabaseNavigationReducer(
	navigation: SupabaseNavigation,
	action: SupabaseNavigationAction
): SupabaseNavigation {
	switch (action.type) {
		case 'open': {
			const { intent } = action;
			const view: SupabaseView =
				intent.view ??
				(intent.stackId !== undefined
					? 'stacks'
					: intent.repositoryId !== undefined
						? 'repositories'
						: intent.section === 'clean-up'
							? 'requests'
							: navigation.view);
			let next = withView(navigation, view);
			if (intent.stackId !== undefined) {
				// A deep link must land on its row, so nothing may filter it out.
				next = {
					...next,
					selectedStackId: intent.stackId,
					filter: 'all',
					query: '',
					batchMode: false,
					batchIds: [],
				};
				if (intent.section !== undefined && intent.section !== 'clean-up') {
					next = supabaseNavigationReducer(next, {
						type: 'set-section',
						stackId: intent.stackId,
						section: intent.section,
						open: true,
					});
				}
			}
			if (intent.repositoryId !== undefined) {
				next = { ...next, selectedRepositoryId: intent.repositoryId };
			}
			const target: SupabaseFocusTarget =
				view === 'stacks'
					? 'stack'
					: view === 'repositories'
						? 'repository'
						: view === 'settings'
							? 'settings'
							: intent.section === 'clean-up'
								? 'clean-up'
								: 'requests';
			const id =
				target === 'stack'
					? intent.stackId
					: target === 'repository'
						? intent.repositoryId
						: undefined;
			const section =
				target === 'stack' &&
				intent.section !== undefined &&
				intent.section !== 'clean-up'
					? intent.section
					: undefined;
			const nonce = navigation.focusNonce + 1;
			return {
				...next,
				focus: {
					target,
					...(id === undefined ? {} : { id }),
					...(section === undefined ? {} : { section }),
					nonce,
				},
				focusNonce: nonce,
			};
		}
		case 'request-focus': {
			const nonce = navigation.focusNonce + 1;
			return {
				...navigation,
				focus: {
					target: action.target,
					...(action.id === undefined ? {} : { id: action.id }),
					nonce,
				},
				focusNonce: nonce,
			};
		}
		case 'set-view':
			return withView(navigation, action.view);
		case 'toggle-settings':
			return navigation.view === 'settings'
				? withView(navigation, navigation.returnView)
				: withView(navigation, 'settings');
		case 'select-stack':
			return { ...navigation, selectedStackId: action.stackId };
		case 'select-repository':
			return { ...navigation, selectedRepositoryId: action.repositoryId };
		case 'set-filter':
			return { ...navigation, filter: action.filter };
		case 'set-repository-filter':
			return { ...navigation, repositoryFilter: action.filter };
		case 'set-query':
			return { ...navigation, query: action.query.slice(0, 256) };
		case 'set-repository-query':
			return { ...navigation, repositoryQuery: action.query.slice(0, 256) };
		case 'set-batch-mode':
			return {
				...navigation,
				batchMode: action.enabled,
				batchIds: action.enabled ? navigation.batchIds : [],
			};
		case 'set-batch':
			return { ...navigation, batchIds: batch(action.stackIds) };
		case 'toggle-batch':
			return {
				...navigation,
				batchIds: navigation.batchIds.includes(action.stackId)
					? navigation.batchIds.filter((id) => id !== action.stackId)
					: batch([...navigation.batchIds, action.stackId]),
			};
		case 'set-section': {
			const { [action.stackId]: current, ...others } = navigation.sections;
			const remembered = Object.keys(others);
			const kept =
				remembered.length >= MAX_REMEMBERED_STACKS
					? Object.fromEntries(
							Object.entries(others).slice(
								remembered.length - MAX_REMEMBERED_STACKS + 1
							)
						)
					: others;
			return {
				...navigation,
				sections: {
					...kept,
					[action.stackId]: { ...current, [action.section]: action.open },
				},
			};
		}
		case 'set-notices-expanded':
			return { ...navigation, noticesExpanded: action.expanded };
		case 'focus-handled':
			return navigation.focus?.nonce === action.nonce
				? { ...navigation, focus: null }
				: navigation;
	}
}

const VIEW_KEY = 'rndevtools.desktop.supabase.view';
const FILTER_KEY = 'rndevtools.desktop.supabase.filter';
const VIEWS: readonly SupabaseView[] = [
	'stacks',
	'repositories',
	'requests',
	'settings',
];

/** The persisted view and filter, ignoring anything this build doesn't know. */
export function readSupabaseNavigationPreferences(
	storage: Pick<Storage, 'getItem'> | undefined
): Partial<Pick<SupabaseNavigation, 'view' | 'filter'>> {
	try {
		const view = storage?.getItem(VIEW_KEY);
		const filter = storage?.getItem(FILTER_KEY);
		return {
			...(VIEWS.some((candidate) => candidate === view)
				? { view: view as SupabaseView }
				: {}),
			...(SUPABASE_STACK_FILTERS.some((candidate) => candidate.id === filter)
				? { filter: filter as SupabaseStackFilter }
				: {}),
		};
	} catch {
		return {};
	}
}

export function writeSupabaseNavigationPreferences(
	storage: Pick<Storage, 'setItem'> | undefined,
	preferences: Pick<SupabaseNavigation, 'view' | 'filter'>
): void {
	try {
		storage?.setItem(VIEW_KEY, preferences.view);
		storage?.setItem(FILTER_KEY, preferences.filter);
	} catch {
		// Storage may be full or disabled; the defaults still work.
	}
}

export function initialSupabaseNavigation(
	preferences: Partial<Pick<SupabaseNavigation, 'view' | 'filter'>>
): SupabaseNavigation {
	const view = preferences.view ?? INITIAL_SUPABASE_NAVIGATION.view;
	return {
		...INITIAL_SUPABASE_NAVIGATION,
		view,
		returnView: view === 'settings' ? 'stacks' : view,
		filter: preferences.filter ?? INITIAL_SUPABASE_NAVIGATION.filter,
	};
}

function browserStorage(): Storage | undefined {
	try {
		return window.localStorage;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Contexts

type SupabaseStateValue = Readonly<{
	state: SupabaseState;
	isLoading: boolean;
	isBridgeAvailable: boolean;
	/** Why the bridge or the first read failed; the panel shows it. */
	runtimeError: string | null;
}>;

type SupabaseActionsValue = Readonly<{
	actionStatus: ActionStatus;
	clearActionStatus: () => void;
	/**
	 * Runs an operation through the native dialog when main guards it, and
	 * always resolves with a receipt: refused, cancelled and failed runs
	 * included. Inline ConfirmAction prompts are the caller's, first.
	 */
	run: (
		input: SupabaseOperationInput,
		messages?: SupabaseActionMessages
	) => Promise<SupabaseOperationReceipt>;
	refresh: () => Promise<SupabaseOperationReceipt>;
	/** Reads main's state again, for when the first read failed. */
	reload: () => Promise<void>;
	pendingKeys: ReadonlySet<string>;
	isPending: (key: string) => boolean;
	isStackPending: (stackId: string) => boolean;
	/** Registers what is on screen until the disposer runs; debounced 60 ms. */
	registerInterest: (interest: SupabaseInterest) => () => void;
}>;

type SupabaseNavigationValue = Readonly<{
	navigation: SupabaseNavigation;
	navigate: Dispatch<SupabaseNavigationAction>;
	selectStack: (stackId: string | null) => void;
	/** Sets the tab up for the intent, then opens `#simulator/supabase`. */
	openInSupabase: (intent: SupabaseOpenIntent) => void;
}>;

type SupabaseShellValue = Readonly<{
	badge: SupabaseSidebarBadge | undefined;
	activeJobs: number;
}>;

const SupabaseStateContext = createContext<SupabaseStateValue | null>(null);
const SupabaseActionsContext = createContext<SupabaseActionsValue | null>(null);
const SupabaseNavigationContext = createContext<SupabaseNavigationValue | null>(
	null
);
const SupabaseShellContext = createContext<SupabaseShellValue | null>(null);

function sameBadge(
	left: SupabaseSidebarBadge | undefined,
	right: SupabaseSidebarBadge | undefined
): boolean {
	return (
		left === right ||
		(left !== undefined &&
			right !== undefined &&
			left.value === right.value &&
			left.tone === right.tone &&
			left.label === right.label)
	);
}

export function SupabaseRuntimeProvider({ children }: { children: ReactNode }) {
	const bridge = useMemo(() => resolveSupabaseBridge(window.rnDevtools), []);
	const [state, setState] = useState<SupabaseState>(EMPTY_SUPABASE_STATE);
	const stateRef = useRef(state);
	const [isLoading, setIsLoading] = useState(Boolean(bridge));
	const [runtimeError, setRuntimeError] = useState<string | null>(() =>
		bridge ? null : SUPABASE_REASONS.bridge
	);
	const [actionStatus, setActionStatus] = useState<ActionStatus>(IDLE);
	const [pending, setPending] = useState<ReadonlyMap<string, string>>(
		() => new Map()
	);
	const pendingRef = useRef(new Map<string, string>());
	const noticeOwner = useRef<string | null>(null);
	const trackedJobs = useRef(new Map<string, SupabaseJobWatch>());
	const [navigation, navigate] = useReducer(
		supabaseNavigationReducer,
		undefined,
		() =>
			initialSupabaseNavigation(
				readSupabaseNavigationPreferences(browserStorage())
			)
	);

	const accept = useCallback((next: SupabaseState | undefined) => {
		setState((current) => {
			const accepted = acceptSupabaseState(current, next);
			stateRef.current = accepted;
			return accepted;
		});
	}, []);

	useEffect(() => {
		if (!bridge) return;
		let active = true;
		let unsubscribe = () => {};
		try {
			unsubscribe = bridge.subscribeSupabaseState((next) => {
				if (!active) return;
				accept(next);
				setRuntimeError(null);
				setIsLoading(false);
			});
		} catch (error) {
			setRuntimeError(errorText(error));
		}
		void bridge
			.getSupabaseState()
			.then((next) => {
				if (!active) return;
				accept(next);
				setRuntimeError(null);
			})
			.catch((error: unknown) => {
				if (active) setRuntimeError(errorText(error));
			})
			.finally(() => {
				if (active) setIsLoading(false);
			});
		return () => {
			active = false;
			try {
				unsubscribe();
			} catch {
				// A faulty native disposer must not break React teardown.
			}
		};
	}, [accept, bridge]);

	// A job's start shows its pending notice until the job ends; the ending
	// is the final word, so it takes the notice back from newer actions.
	useEffect(() => {
		if (trackedJobs.current.size === 0) return;
		const settled = settleSupabaseJobs(trackedJobs.current, state);
		trackedJobs.current = settled.watches;
		for (const notice of settled.notices) {
			if (notice.quiet) continue;
			if (notice.status.kind !== 'idle') {
				noticeOwner.current = notice.actionId;
				setActionStatus(notice.status);
			} else if (noticeOwner.current === notice.actionId) {
				setActionStatus(IDLE);
			}
		}
	}, [state]);

	const run = useCallback<SupabaseActionsValue['run']>(
		async (input, messages = {}) => {
			const actionId = createSupabaseActionId();
			const operation = withSupabaseActionId(input, actionId);
			const current = stateRef.current;
			const copy = supabaseActionCopy(input, current);
			const quiet = messages.quiet ?? copy.quiet === true;
			const show = (status: ActionStatus) => {
				if (quiet) return;
				// Errors and new progress take the one notice slot; a success
				// only replaces the notice this action still owns.
				if (status.kind === 'error' || status.kind === 'pending') {
					noticeOwner.current = actionId;
					setActionStatus(status);
				} else if (noticeOwner.current === actionId) {
					setActionStatus(status);
				}
			};
			const finish = (receipt: SupabaseOperationReceipt, after = current) => {
				show(supabaseReceiptNotice(receipt, copy, messages, after));
				return receipt;
			};
			if (!bridge) {
				return finish(
					failedReceipt(
						operation,
						supabaseDesktopError('unavailable', SUPABASE_REASONS.bridge)
					)
				);
			}
			const parsed = supabaseOperationSchema.safeParse(operation);
			if (!parsed.success) {
				return finish(
					failedReceipt(
						operation,
						supabaseDesktopError(
							'refused',
							'This Supabase request is not valid.'
						)
					)
				);
			}
			const keys = supabasePendingKeys(input, {
				background: messages.background === true,
			});
			if (keys.some((key) => pendingRef.current.has(key))) {
				return failedReceipt(
					operation,
					supabaseDesktopError('refused', SUPABASE_REASONS.inFlight)
				);
			}
			for (const key of keys) pendingRef.current.set(key, actionId);
			setPending(new Map(pendingRef.current));
			const pendingText = messages.pending ?? copy.pending;
			if (pendingText) show({ kind: 'pending', message: pendingText });
			try {
				let receipt = await confirmThenRunSupabaseOperation(
					bridge,
					parsed.data,
					current
				);
				if (receipt.actionId !== actionId) {
					receipt = failedReceipt(
						operation,
						supabaseDesktopError(
							'internal',
							'Main answered a different Supabase action.'
						)
					);
				}
				const after = acceptSupabaseState(current, receipt.state);
				if (receipt.completed && receipt.jobId && !receipt.error) {
					// Tracked before the state lands, so the job effect sees it even
					// when the receipt's state already holds the finished job.
					trackedJobs.current.set(receipt.jobId, {
						actionId,
						copy,
						messages,
						quiet,
						revision: after.revision,
					});
					// Main's word on the job, such as why it is queued, replaces the
					// pending copy while this action still owns the notice.
					if (receipt.message && !quiet && noticeOwner.current === actionId) {
						setActionStatus({ kind: 'pending', message: receipt.message });
					}
					if (receipt.state) accept(receipt.state);
					return receipt;
				}
				if (receipt.state) accept(receipt.state);
				return finish(receipt, after);
			} catch (error) {
				return finish(
					failedReceipt(
						operation,
						supabaseDesktopError('internal', errorText(error))
					)
				);
			} finally {
				for (const key of keys) {
					if (pendingRef.current.get(key) === actionId) {
						pendingRef.current.delete(key);
					}
				}
				setPending(new Map(pendingRef.current));
			}
		},
		[accept, bridge]
	);

	const refresh = useCallback(() => run({ kind: 'refresh' }), [run]);

	const reload = useCallback(async () => {
		if (!bridge) return;
		try {
			accept(await bridge.getSupabaseState());
			setRuntimeError(null);
		} catch (error) {
			setRuntimeError(errorText(error));
		}
	}, [accept, bridge]);

	const clearActionStatus = useCallback(() => {
		noticeOwner.current = null;
		setActionStatus(IDLE);
	}, []);

	const interests = useRef(new Map<symbol, SupabaseInterest>());
	const lastInterest = useRef(JSON.stringify(SUPABASE_NO_INTEREST));
	const interestTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined
	);
	const flushInterest = useCallback(() => {
		if (!bridge) return;
		const next = resolveSupabaseInterest(interests.current.values());
		const serialized = JSON.stringify(next);
		if (serialized === lastInterest.current) return;
		lastInterest.current = serialized;
		try {
			bridge.setSupabaseInterest(next);
		} catch {
			// Let the next change retry; there is nothing else to do here.
			lastInterest.current = '';
		}
	}, [bridge]);
	const registerInterest = useCallback(
		(interest: SupabaseInterest) => {
			const token = Symbol('supabase-interest');
			const schedule = () => {
				if (interestTimer.current) clearTimeout(interestTimer.current);
				interestTimer.current = setTimeout(flushInterest, INTEREST_DEBOUNCE_MS);
			};
			interests.current.set(token, interest);
			schedule();
			return () => {
				interests.current.delete(token);
				schedule();
			};
		},
		[flushInterest]
	);
	useEffect(
		() => () => {
			if (interestTimer.current) clearTimeout(interestTimer.current);
			interests.current.clear();
			if (!bridge) return;
			if (lastInterest.current === JSON.stringify(SUPABASE_NO_INTEREST)) return;
			lastInterest.current = JSON.stringify(SUPABASE_NO_INTEREST);
			try {
				bridge.setSupabaseInterest(SUPABASE_NO_INTEREST);
			} catch {
				// Main drops a closed window's interest itself.
			}
		},
		[bridge]
	);

	const { view, filter } = navigation;
	useEffect(() => {
		writeSupabaseNavigationPreferences(browserStorage(), { view, filter });
	}, [filter, view]);

	const openInSupabase = useCallback((intent: SupabaseOpenIntent) => {
		navigate({ type: 'open', intent });
		if (window.location.hash !== '#simulator/supabase') {
			window.location.hash = 'simulator/supabase';
		}
	}, []);

	const badgeRef = useRef<SupabaseSidebarBadge | undefined>(undefined);
	const nextBadge = useMemo(() => sidebarBadge(state), [state]);
	if (!sameBadge(badgeRef.current, nextBadge)) badgeRef.current = nextBadge;
	const badge = badgeRef.current;
	const activeJobs = useMemo(
		() => state.jobs.filter(isActiveSupabaseJob).length,
		[state.jobs]
	);

	const stateValue = useMemo<SupabaseStateValue>(
		() => ({
			state,
			isLoading,
			isBridgeAvailable: Boolean(bridge),
			runtimeError,
		}),
		[bridge, isLoading, runtimeError, state]
	);
	const actionsValue = useMemo<SupabaseActionsValue>(() => {
		const keys = new Set(pending.keys());
		return {
			actionStatus,
			clearActionStatus,
			run,
			refresh,
			reload,
			pendingKeys: keys,
			isPending: (key) => keys.has(key),
			isStackPending: (stackId) => keys.has(supabaseStackPendingKey(stackId)),
			registerInterest,
		};
	}, [
		actionStatus,
		clearActionStatus,
		pending,
		refresh,
		registerInterest,
		reload,
		run,
	]);
	const selectStack = useCallback(
		(stackId: string | null) => navigate({ type: 'select-stack', stackId }),
		[]
	);
	const navigationValue = useMemo<SupabaseNavigationValue>(
		() => ({ navigation, navigate, selectStack, openInSupabase }),
		[navigation, openInSupabase, selectStack]
	);
	const shellValue = useMemo<SupabaseShellValue>(
		() => ({ badge, activeJobs }),
		[activeJobs, badge]
	);

	return (
		<SupabaseStateContext.Provider value={stateValue}>
			<SupabaseShellContext.Provider value={shellValue}>
				<SupabaseActionsContext.Provider value={actionsValue}>
					<SupabaseNavigationContext.Provider value={navigationValue}>
						{children}
					</SupabaseNavigationContext.Provider>
				</SupabaseActionsContext.Provider>
			</SupabaseShellContext.Provider>
		</SupabaseStateContext.Provider>
	);
}

function useRequiredContext<T>(context: Context<T | null>, name: string): T {
	const value = useContext(context);
	if (!value) {
		throw new Error(`${name} must be used inside SupabaseRuntimeProvider.`);
	}
	return value;
}

/** The pushed state; re-renders on every accepted push. */
export function useSupabaseState(): SupabaseStateValue {
	return useRequiredContext(SupabaseStateContext, 'useSupabaseState');
}

/** run, refresh, pending keys, interest and the shared notice. */
export function useSupabaseActions(): SupabaseActionsValue {
	return useRequiredContext(SupabaseActionsContext, 'useSupabaseActions');
}

/** The tab's view, selection, filters and deep-link intents. */
export function useSupabaseNavigation(): SupabaseNavigationValue {
	return useRequiredContext(SupabaseNavigationContext, 'useSupabaseNavigation');
}

/**
 * The sidebar badge, memoised: it changes identity only when its value,
 * tone or label does, so pushes don't re-render the sidebar.
 */
export function useSupabaseSidebarBadge(): SupabaseSidebarBadge | undefined {
	return useRequiredContext(SupabaseShellContext, 'useSupabaseSidebarBadge')
		.badge;
}

/** Queued and running Supabase jobs, for the titlebar's Jobs metric. */
export function useSupabaseActiveJobCount(): number {
	return useRequiredContext(SupabaseShellContext, 'useSupabaseActiveJobCount')
		.activeJobs;
}

/**
 * Tells main what is on screen while the caller is mounted with this
 * interest; pass null for none. Re-registers only when the interest changes.
 */
export function useSupabaseInterest(interest: SupabaseInterest | null): void {
	const { registerInterest } = useSupabaseActions();
	const key = interest === null ? '' : JSON.stringify(interest);
	useEffect(() => {
		if (key === '') return undefined;
		return registerInterest(JSON.parse(key) as SupabaseInterest);
	}, [key, registerInterest]);
}

/**
 * One panel clock: every second while a visible countdown is under two
 * minutes or an elapsed counter runs, otherwise every 15 s; stopped while
 * inactive and on unmount.
 */
export function useSupabaseNow(
	clock: Readonly<{
		deadlines?: readonly (number | undefined)[];
		elapsing?: boolean;
	}>,
	active = true
): number {
	const [now, setNow] = useState(() => Date.now());
	const cadence = supabaseClockCadence(clock, now);
	useEffect(() => {
		if (!active) return undefined;
		const timer = setInterval(() => setNow(Date.now()), cadence);
		return () => clearInterval(timer);
	}, [active, cadence]);
	return now;
}

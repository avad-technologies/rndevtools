import { confirmSupabaseDemoOperation } from '../shared/supabase-demo-data';
import {
	checkSupabaseOperation,
	SUPABASE_NO_INTEREST,
	type SupabaseConfirmationResult,
	type SupabaseErrorView,
	type SupabaseInterest,
	type SupabaseOperation,
	type SupabaseOperationReceipt,
	type SupabaseState,
	sanitizeSupabaseDisplayText,
	supabaseConfirmationRequired,
	supabaseConfirmationResultSchema,
	supabaseConfirmedOperation,
	supabaseDesktopError,
	supabaseInterestSchema,
	supabaseOperationReceiptSchema,
	supabaseOperationSchema,
	supabaseStateSchema,
} from '../shared/supabase-protocol';
import type { ActionConfirmationStore } from './action-confirmation-store';
import { safeErrorText, sanitizeDialogText } from './security';
import {
	type SupabaseConfirmationFacts,
	type SupabaseDialogPort,
	type SupabaseServiceApi,
	supabaseConfirmationOutcome,
	supabaseMessageBoxOptions,
} from './supabase/service-ports';

const CONFIRMATION_SCOPE = 'supabase';
/** The confirmation result's error is single-line text of at most 1,024. */
const MAX_RESULT_ERROR_LENGTH = 1_024;
const MAX_DIALOG_LINES = 24;
const MAX_DIALOG_CHOICES = 3;
const STATE_BROADCAST_DELAY_MS = 100;

/** The part of an Electron IPC event these handlers read. */
type SupabaseIpcEvent = Readonly<{ sender: Readonly<{ id: number }> }>;

type SupabaseIpcDependencies<E extends SupabaseIpcEvent> = Readonly<{
	service: Pick<
		SupabaseServiceApi,
		'getState' | 'runOperation' | 'describeConfirmation' | 'setInterest'
	>;
	/** One-time tokens, bound to the asking renderer and the exact operation. */
	confirmations: Pick<ActionConfirmationStore, 'issue' | 'consume'>;
	/** The main-owned native dialog, modal to the asking window. */
	showConfirmationDialog: SupabaseDialogPort['showMessageBox'];
	assertTrustedSender: (event: E) => void;
	now: () => number;
}>;

/** The key a renderer's interest is filed under in the service. */
export function supabaseInterestKey(senderId: number): string {
	return `renderer-${senderId}`;
}

/**
 * What a token is bound to: the whole operation (actionId, ids and the
 * chosen options), with batch ids sorted. The store's fingerprint leaves out
 * confirmationToken.
 */
function confirmationBinding(operation: SupabaseOperation): unknown {
	return 'stackIds' in operation
		? { ...operation, stackIds: [...operation.stackIds].sort() }
		: operation;
}

/**
 * The dialog's text, sanitized again at the boundary and bounded: one
 * visible line per fact. Undefined when there is no title or a button would
 * have no label, so the dialog is refused rather than shown half-described.
 */
function dialogFacts(
	facts: SupabaseConfirmationFacts
): SupabaseConfirmationFacts | undefined {
	const title = sanitizeDialogText(facts.title);
	const choices = facts.choices.slice(0, MAX_DIALOG_CHOICES).map((choice) => ({
		label: sanitizeDialogText(choice.label, { maxLength: 64 }),
		...(choice.disposition ? { disposition: choice.disposition } : {}),
	}));
	const checkbox = facts.checkbox
		? {
				label: sanitizeDialogText(facts.checkbox.label),
				checkedByDefault: facts.checkbox.checkedByDefault === true,
			}
		: undefined;
	if (
		!title ||
		choices.length === 0 ||
		choices.some((choice) => !choice.label) ||
		checkbox?.label === ''
	) {
		return undefined;
	}
	return {
		title,
		lines: facts.lines
			.slice(0, MAX_DIALOG_LINES)
			.map((line) => sanitizeDialogText(line, { maxLength: 320 })),
		choices,
		...(checkbox ? { checkbox } : {}),
	};
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

/**
 * Supabase IPC. Every handler checks the sender and re-parses its input.
 * Runs are re-checked against main's state with the shared availability
 * rules first, and a refusal comes back as a receipt. The operations the
 * native dialog guards need a one-time token bound to the asking renderer
 * and to the exact operation, which only `requestConfirmation` issues after
 * the dialog, built from main's own facts, was confirmed.
 */
export function createSupabaseIpcHandlers<E extends SupabaseIpcEvent>({
	service,
	confirmations,
	showConfirmationDialog,
	assertTrustedSender,
	now,
}: SupabaseIpcDependencies<E>) {
	const confirm = async (
		senderId: number,
		operation: SupabaseOperation
	): Promise<SupabaseConfirmationResult> => {
		const state = service.getState();
		// Demo state is main's own fixture: it never shows a system dialog.
		if (state.source === 'demo') return confirmSupabaseDemoOperation(operation);
		const required = supabaseConfirmationRequired(operation, state);
		const refuse = (error: string): SupabaseConfirmationResult => ({
			actionId: operation.actionId,
			required,
			confirmed: false,
			error: sanitizeSupabaseDisplayText(error, MAX_RESULT_ERROR_LENGTH),
		});
		if ('confirmationToken' in operation && operation.confirmationToken) {
			return refuse('Confirmation requests cannot reuse an existing token.');
		}
		if (!required) {
			return { actionId: operation.actionId, required: false, confirmed: true };
		}
		const check = checkSupabaseOperation(operation, state, {
			bridgeAvailable: true,
			now: now(),
		});
		if (!check.allowed) return refuse(check.error.message);
		try {
			const described = await service.describeConfirmation(operation);
			const facts = described ? dialogFacts(described) : undefined;
			if (!facts) {
				return refuse(
					'RN Devtools could not describe this action. Refresh the Supabase tab, then try again.'
				);
			}
			const answer = await showConfirmationDialog(
				supabaseMessageBoxOptions(facts),
				{ senderId }
			);
			const outcome = supabaseConfirmationOutcome(facts, answer);
			// Cancel is not an error: the renderer just stays where it was.
			if (!outcome.confirmed) {
				return {
					actionId: operation.actionId,
					required: true,
					confirmed: false,
				};
			}
			const { token, expiresAt } = confirmations.issue(
				CONFIRMATION_SCOPE,
				senderId,
				confirmationBinding(
					supabaseConfirmedOperation(operation, outcome.options)
				)
			);
			return {
				actionId: operation.actionId,
				required: true,
				confirmed: true,
				token,
				expiresAt,
				options: outcome.options,
			};
		} catch (error) {
			return refuse(safeErrorText(error));
		}
	};

	const run = async (
		senderId: number,
		operation: SupabaseOperation
	): Promise<SupabaseOperationReceipt> => {
		const state = service.getState();
		const check = checkSupabaseOperation(operation, state, {
			bridgeAvailable: true,
			now: now(),
		});
		if (!check.allowed) return failedReceipt(operation, check.error);
		// Checked before consuming, so a refused run leaves its token usable
		// until it expires. Demo state never issues one.
		const demo = state.source === 'demo';
		const token =
			'confirmationToken' in operation
				? operation.confirmationToken
				: undefined;
		const confirmed =
			!demo &&
			token !== undefined &&
			confirmations.consume(
				CONFIRMATION_SCOPE,
				senderId,
				confirmationBinding(operation),
				token
			);
		if (!demo && !confirmed && supabaseConfirmationRequired(operation, state)) {
			return failedReceipt(
				operation,
				supabaseDesktopError(
					'confirmation_required',
					'A fresh, exact confirmation is required.'
				)
			);
		}
		try {
			const receipt = supabaseOperationReceiptSchema.safeParse(
				await service.runOperation(operation, {
					actor: { kind: 'operator', senderId },
					confirmed,
				})
			);
			return receipt.success &&
				receipt.data.actionId === operation.actionId &&
				receipt.data.kind === operation.kind
				? receipt.data
				: failedReceipt(
						operation,
						supabaseDesktopError(
							'internal',
							'RN Devtools could not read the result of this Supabase action.'
						)
					);
		} catch (error) {
			return failedReceipt(
				operation,
				supabaseDesktopError('internal', safeErrorText(error))
			);
		}
	};

	return {
		getState: (event: E): SupabaseState => {
			assertTrustedSender(event);
			return supabaseStateSchema.parse(service.getState());
		},
		requestConfirmation: async (
			event: E,
			value: unknown
		): Promise<SupabaseConfirmationResult> => {
			assertTrustedSender(event);
			const operation = supabaseOperationSchema.parse(value);
			return supabaseConfirmationResultSchema.parse(
				await confirm(event.sender.id, operation)
			);
		},
		runOperation: async (
			event: E,
			value: unknown
		): Promise<SupabaseOperationReceipt> => {
			assertTrustedSender(event);
			return run(event.sender.id, supabaseOperationSchema.parse(value));
		},
		/**
		 * Fire and forget (`ipcMain.on`): a bad message is dropped here, never
		 * thrown into Electron's emitter. Debouncing is the renderer's job.
		 */
		setInterest: (event: E, value: unknown): boolean => {
			try {
				assertTrustedSender(event);
				service.setInterest(
					supabaseInterestKey(event.sender.id),
					supabaseInterestSchema.parse(value)
				);
				return true;
			} catch {
				return false;
			}
		},
	};
}

/**
 * Per-window interest: what each renderer last asked for, passed on only
 * while its window is visible. A hidden or minimized window counts as no
 * interest, a shown one gets its last interest back, and a closed one is
 * dropped. Keys come from supabaseInterestKey.
 */
export function createSupabaseInterestGate(
	setInterest: SupabaseServiceApi['setInterest']
) {
	const windows = new Map<
		string,
		{ interest: SupabaseInterest; visible: boolean }
	>();
	const forward = (senderKey: string) => {
		const entry = windows.get(senderKey);
		setInterest(
			senderKey,
			entry?.visible ? entry.interest : SUPABASE_NO_INTEREST
		);
	};
	return {
		/** What the renderer asked for; a window never reported is visible. */
		setInterest: (senderKey: string, interest: SupabaseInterest): void => {
			windows.set(senderKey, {
				interest,
				visible: windows.get(senderKey)?.visible ?? true,
			});
			forward(senderKey);
		},
		setVisible: (senderKey: string, visible: boolean): void => {
			const entry = windows.get(senderKey);
			if (!entry) {
				// Nothing was forwarded for this window yet; only remember it.
				windows.set(senderKey, { interest: SUPABASE_NO_INTEREST, visible });
				return;
			}
			if (entry.visible === visible) return;
			entry.visible = visible;
			forward(senderKey);
		},
		drop: (senderKey: string): void => {
			if (windows.delete(senderKey)) {
				setInterest(senderKey, SUPABASE_NO_INTEREST);
			}
		},
	};
}

/**
 * Pushes Supabase state to the windows at most once per 100 ms, only when
 * its revision changed, and only a state that validates. Disposed for good
 * on quit.
 */
export function createSupabaseStatePublisher(
	send: (state: SupabaseState) => void,
	delayMs = STATE_BROADCAST_DELAY_MS
) {
	let pending: SupabaseState | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastRevision: number | undefined;
	let disposed = false;
	const flush = () => {
		timer = undefined;
		const state = pending;
		pending = undefined;
		if (!state || state.revision === lastRevision) return;
		const parsed = supabaseStateSchema.safeParse(state);
		if (!parsed.success) return;
		lastRevision = parsed.data.revision;
		send(parsed.data);
	};
	return {
		publish: (state: SupabaseState): void => {
			if (disposed) return;
			pending = state;
			timer ??= setTimeout(flush, delayMs);
		},
		dispose: (): void => {
			disposed = true;
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
			pending = undefined;
		},
	};
}

import { normalizeActionConfirmation } from './action-validation';
import { diagnosticErrorText, redactDiagnosticText } from './redact';
import { truncateText } from './serialize';

export const DEVTOOLS_ACTION_POLICY_VERSION = 1 as const;

const MAX_ACTION_ID_LENGTH = 256;
const MAX_ACTION_TEXT_LENGTH = 256;
const MAX_REASON_LENGTH = 1_024;
const MAX_RAW_TEXT_LENGTH = 64 * 1_024;
const DEFAULT_RECEIPT_LIMIT = 256;
const MAX_IN_FLIGHT_CONFIRMATIONS = 256;

type AbortSignalEventMethod = (...args: unknown[]) => unknown;
type AbortSignalAbortedGetter = (this: AbortSignal) => unknown;

function captureAbortSignalEventMethod(
	name: 'addEventListener' | 'removeEventListener',
): AbortSignalEventMethod | undefined {
	try {
		if (typeof AbortSignal === 'undefined') return undefined;
		let prototype: object | null = AbortSignal.prototype;
		while (prototype) {
			const method = Object.getOwnPropertyDescriptor(prototype, name)?.value;
			if (typeof method === 'function') {
				return method as AbortSignalEventMethod;
			}
			prototype = Object.getPrototypeOf(prototype) as object | null;
		}
	} catch {
		// Signal-bearing executions fail validation if their intrinsic is absent.
	}
	return undefined;
}

const abortSignalAddEventListener =
	captureAbortSignalEventMethod('addEventListener');
const abortSignalRemoveEventListener = captureAbortSignalEventMethod(
	'removeEventListener',
);
const abortSignalAbortedGetter = ((): AbortSignalAbortedGetter | undefined => {
	try {
		if (typeof AbortSignal === 'undefined') return undefined;
		const getter = Object.getOwnPropertyDescriptor(
			AbortSignal.prototype,
			'aborted',
		)?.get;
		return typeof getter === 'function'
			? (getter as AbortSignalAbortedGetter)
			: undefined;
	} catch {
		return undefined;
	}
})();

function intrinsicAbortSignalAborted(signal: AbortSignal): boolean {
	if (!abortSignalAbortedGetter) {
		throw new Error('AbortSignal state inspection is unavailable.');
	}
	const aborted = Reflect.apply(abortSignalAbortedGetter, signal, []);
	if (typeof aborted !== 'boolean') {
		throw new Error('AbortSignal state is invalid.');
	}
	return aborted;
}

function addIntrinsicAbortListener(
	signal: AbortSignal,
	listener: () => void,
): void {
	if (!abortSignalAddEventListener) {
		throw new Error('AbortSignal event handling is unavailable.');
	}
	Reflect.apply(abortSignalAddEventListener, signal, [
		'abort',
		listener,
		{ once: true },
	]);
}

function removeIntrinsicAbortListener(
	signal: AbortSignal,
	listener: () => void,
): void {
	if (!abortSignalRemoveEventListener) return;
	Reflect.apply(abortSignalRemoveEventListener, signal, ['abort', listener]);
}

export type DevToolsCapabilityReasonCode =
	| 'disabled'
	| 'restricted'
	| 'unavailable'
	| 'unsupported';

export type DevToolsCapability = {
	schemaVersion: typeof DEVTOOLS_ACTION_POLICY_VERSION;
	id: string;
	availability: 'available' | 'unavailable';
	reason?: {
		code: DevToolsCapabilityReasonCode;
		message: string;
	};
};

/** Risk is supplied by the trusted host and enforced by the coordinator. */
export type DevToolsActionRisk =
	| 'confirmation'
	| 'destructive'
	| 'privacy-sensitive'
	| 'safe';

export type DevToolsActionConfirmationRequirement =
	| { required: false }
	| {
			required: true;
			title: string;
			message?: string;
			confirmLabel?: string;
			destructive?: boolean;
	  };

export type DevToolsActionRollbackPlan =
	| { availability: 'available' }
	| { availability: 'not-applicable' }
	| { availability: 'unavailable'; reason: string };

/**
 * Canonical, value-free description of an action. Parameters stay with the
 * host-owned closure so receipts cannot accidentally persist sensitive values.
 */
export type DevToolsActionPlan = {
	schemaVersion: typeof DEVTOOLS_ACTION_POLICY_VERSION;
	requestId: string;
	/** Opaque host-generated digest of the canonical operation and parameters. */
	actionFingerprint: string;
	capability: DevToolsCapability;
	pluginId: string;
	label: string;
	risk: DevToolsActionRisk;
	confirmation: DevToolsActionConfirmationRequirement;
	rollback: DevToolsActionRollbackPlan;
};

export type DevToolsActionRollbackResult =
	| { status: 'complete' }
	| { status: 'partial'; reason?: string };

export type DevToolsActionReceiptStatus =
	| 'cancelled'
	| 'failed'
	| 'needs-attention'
	| 'rejected'
	| 'rolled-back'
	| 'succeeded';

export type DevToolsActionReceiptErrorCode =
	| 'action-failed'
	| 'confirmation-required'
	| 'confirmation-unavailable'
	| 'invalid-request'
	| 'request-id-conflict'
	| 'rollback-failed'
	| 'rollback-partial'
	| 'unsupported';

export type DevToolsActionRollbackStatus =
	| 'failed'
	| 'not-available'
	| 'not-needed'
	| 'partial'
	| 'succeeded';

export type DevToolsActionReceipt = {
	schemaVersion: typeof DEVTOOLS_ACTION_POLICY_VERSION;
	requestId: string;
	actionFingerprint: string;
	capabilityId: string;
	pluginId: string;
	label: string;
	risk: DevToolsActionRisk;
	status: DevToolsActionReceiptStatus;
	rollbackStatus: DevToolsActionRollbackStatus;
	startedAt: number;
	completedAt: number;
	errorCode?: DevToolsActionReceiptErrorCode;
	error?: string;
};

export type DevToolsActionExecution = {
	plan: DevToolsActionPlan;
	action: () => unknown | Promise<unknown>;
	rollback?: () =>
		| DevToolsActionRollbackResult
		| Promise<DevToolsActionRollbackResult>;
	/** Cancels a pending confirmation before the action begins. */
	signal?: AbortSignal;
};

export type DevToolsActionCoordinator = {
	execute: (
		execution: DevToolsActionExecution,
	) => Promise<DevToolsActionReceipt>;
	clearReceipts: () => void;
};

export type DevToolsActionCoordinatorOptions = {
	/**
	 * The signal requests prompt dismissal. A promise that ignores it remains
	 * counted against the coordinator's bounded confirmation-work budget until
	 * that promise actually settles.
	 */
	confirm?: (
		confirmation: Exclude<
			DevToolsActionConfirmationRequirement,
			{ required: false }
		>,
		plan: DevToolsActionPlan,
		signal?: AbortSignal,
	) => boolean | Promise<boolean>;
	onReceipt?: (receipt: DevToolsActionReceipt) => void;
	receiptLimit?: number;
	now?: () => number;
};

type ReceiptEntry = {
	fingerprint: string;
	promise: Promise<DevToolsActionReceipt>;
	settled: boolean;
};

function descriptorsFor(
	value: object,
): Record<string, PropertyDescriptor> | null {
	try {
		return Object.getOwnPropertyDescriptors(value);
	} catch {
		return null;
	}
}

function dataProperty(
	descriptors: Record<string, PropertyDescriptor>,
	key: string,
): unknown {
	const descriptor = descriptors[key];
	return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function hasAccessor(
	descriptors: Record<string, PropertyDescriptor>,
	key: string,
): boolean {
	const descriptor = descriptors[key];
	return descriptor !== undefined && !('value' in descriptor);
}

function safeText(
	value: unknown,
	maxLength: number,
	options: { trimmed?: boolean } = {},
): string | null {
	if (
		typeof value !== 'string' ||
		value.length > MAX_RAW_TEXT_LENGTH ||
		(options.trimmed !== false && !value.trim())
	) {
		return null;
	}
	const normalized = options.trimmed === false ? value : value.trim();
	return truncateText(redactDiagnosticText(normalized), maxLength).text;
}

function safeFingerprint(value: unknown): string | null {
	if (
		typeof value !== 'string' ||
		!value ||
		value.length > MAX_ACTION_ID_LENGTH ||
		!/^[A-Za-z0-9._:-]+$/.test(value)
	) {
		return null;
	}
	return value;
}

function normalizeCapability(value: unknown): DevToolsCapability | null {
	if (!value || typeof value !== 'object') return null;
	const descriptors = descriptorsFor(value);
	if (!descriptors) return null;
	for (const key of ['schemaVersion', 'id', 'availability', 'reason']) {
		if (hasAccessor(descriptors, key)) return null;
	}

	const schemaVersion = dataProperty(descriptors, 'schemaVersion');
	const id = safeText(dataProperty(descriptors, 'id'), MAX_ACTION_ID_LENGTH);
	const availability = dataProperty(descriptors, 'availability');
	const rawReason = dataProperty(descriptors, 'reason');
	if (
		schemaVersion !== DEVTOOLS_ACTION_POLICY_VERSION ||
		!id ||
		(availability !== 'available' && availability !== 'unavailable')
	) {
		return null;
	}

	let reason: DevToolsCapability['reason'];
	if (rawReason !== undefined) {
		if (!rawReason || typeof rawReason !== 'object') return null;
		const reasonDescriptors = descriptorsFor(rawReason);
		if (
			!reasonDescriptors ||
			hasAccessor(reasonDescriptors, 'code') ||
			hasAccessor(reasonDescriptors, 'message')
		) {
			return null;
		}
		const code = dataProperty(reasonDescriptors, 'code');
		const message = safeText(
			dataProperty(reasonDescriptors, 'message'),
			MAX_REASON_LENGTH,
		);
		if (
			(code !== 'disabled' &&
				code !== 'restricted' &&
				code !== 'unavailable' &&
				code !== 'unsupported') ||
			!message
		) {
			return null;
		}
		reason = { code, message };
	}
	if (availability === 'unavailable' && !reason) return null;
	if (availability === 'available' && reason) return null;

	return {
		schemaVersion: DEVTOOLS_ACTION_POLICY_VERSION,
		id,
		availability,
		...(reason ? { reason } : {}),
	};
}

function normalizeConfirmation(
	value: unknown,
): DevToolsActionConfirmationRequirement | null {
	if (!value || typeof value !== 'object') return null;
	const descriptors = descriptorsFor(value);
	if (!descriptors || hasAccessor(descriptors, 'required')) return null;
	const required = dataProperty(descriptors, 'required');
	if (required === false) return { required: false };
	if (required !== true) return null;

	const normalized = normalizeActionConfirmation(value);
	return normalized ? { required: true, ...normalized } : null;
}

function normalizeRollback(value: unknown): DevToolsActionRollbackPlan | null {
	if (!value || typeof value !== 'object') return null;
	const descriptors = descriptorsFor(value);
	if (
		!descriptors ||
		hasAccessor(descriptors, 'availability') ||
		hasAccessor(descriptors, 'reason')
	) {
		return null;
	}
	const availability = dataProperty(descriptors, 'availability');
	if (availability === 'available' || availability === 'not-applicable') {
		return { availability };
	}
	if (availability !== 'unavailable') return null;
	const reason = safeText(
		dataProperty(descriptors, 'reason'),
		MAX_REASON_LENGTH,
	);
	return reason ? { availability, reason } : null;
}

/** Validates, bounds, redacts, and detaches an action plan. */
export function normalizeDevToolsActionPlan(
	value: unknown,
): DevToolsActionPlan | null {
	if (!value || typeof value !== 'object') return null;
	const descriptors = descriptorsFor(value);
	if (!descriptors) return null;
	for (const key of [
		'schemaVersion',
		'requestId',
		'actionFingerprint',
		'capability',
		'pluginId',
		'label',
		'risk',
		'confirmation',
		'rollback',
	]) {
		if (hasAccessor(descriptors, key)) return null;
	}

	const schemaVersion = dataProperty(descriptors, 'schemaVersion');
	const requestId = safeText(
		dataProperty(descriptors, 'requestId'),
		MAX_ACTION_ID_LENGTH,
	);
	const actionFingerprint = safeFingerprint(
		dataProperty(descriptors, 'actionFingerprint'),
	);
	const capability = normalizeCapability(
		dataProperty(descriptors, 'capability'),
	);
	const pluginId = safeText(
		dataProperty(descriptors, 'pluginId'),
		MAX_ACTION_ID_LENGTH,
	);
	const label = safeText(
		dataProperty(descriptors, 'label'),
		MAX_ACTION_TEXT_LENGTH,
	);
	const risk = dataProperty(descriptors, 'risk');
	const confirmation = normalizeConfirmation(
		dataProperty(descriptors, 'confirmation'),
	);
	const rollback = normalizeRollback(dataProperty(descriptors, 'rollback'));
	if (
		schemaVersion !== DEVTOOLS_ACTION_POLICY_VERSION ||
		!requestId ||
		!actionFingerprint ||
		!capability ||
		!pluginId ||
		!label ||
		(risk !== 'safe' &&
			risk !== 'confirmation' &&
			risk !== 'destructive' &&
			risk !== 'privacy-sensitive') ||
		!confirmation ||
		!rollback
	) {
		return null;
	}

	return {
		schemaVersion: DEVTOOLS_ACTION_POLICY_VERSION,
		requestId,
		actionFingerprint,
		capability,
		pluginId,
		label,
		risk,
		confirmation,
		rollback,
	};
}

function fingerprint(plan: DevToolsActionPlan): string {
	return JSON.stringify({
		actionFingerprint: plan.actionFingerprint,
		capabilityId: plan.capability.id,
		capabilityAvailability: plan.capability.availability,
		pluginId: plan.pluginId,
		label: plan.label,
		risk: plan.risk,
		confirmationRequired: plan.confirmation.required,
		rollback: plan.rollback.availability,
	});
}

function safeError(error: unknown): string {
	return truncateText(diagnosticErrorText(error), MAX_REASON_LENGTH).text;
}

function invalidReceipt(now: () => number): DevToolsActionReceipt {
	const at = now();
	return {
		schemaVersion: DEVTOOLS_ACTION_POLICY_VERSION,
		requestId: 'unknown',
		actionFingerprint: 'unknown',
		capabilityId: 'unknown',
		pluginId: 'unknown',
		label: 'Invalid action',
		risk: 'safe',
		status: 'rejected',
		rollbackStatus: 'not-needed',
		startedAt: at,
		completedAt: at,
		errorCode: 'invalid-request',
		error: 'Invalid developer-tools action execution.',
	};
}

function receiptFor(
	plan: DevToolsActionPlan,
	startedAt: number,
	completedAt: number,
	result: Pick<
		DevToolsActionReceipt,
		'status' | 'rollbackStatus' | 'errorCode' | 'error'
	>,
): DevToolsActionReceipt {
	return {
		schemaVersion: DEVTOOLS_ACTION_POLICY_VERSION,
		requestId: plan.requestId,
		actionFingerprint: plan.actionFingerprint,
		capabilityId: plan.capability.id,
		pluginId: plan.pluginId,
		label: plan.label,
		risk: plan.risk,
		status: result.status,
		rollbackStatus: result.rollbackStatus,
		startedAt,
		completedAt,
		...(result.errorCode ? { errorCode: result.errorCode } : {}),
		...(result.error ? { error: result.error } : {}),
	};
}

function normalizeRollbackResult(
	value: unknown,
): DevToolsActionRollbackResult | null {
	if (!value || typeof value !== 'object') return null;
	const descriptors = descriptorsFor(value);
	if (
		!descriptors ||
		hasAccessor(descriptors, 'status') ||
		hasAccessor(descriptors, 'reason')
	) {
		return null;
	}
	const status = dataProperty(descriptors, 'status');
	if (status === 'complete') return { status };
	if (status !== 'partial') return null;
	const rawReason = dataProperty(descriptors, 'reason');
	if (rawReason === undefined) return { status };
	const reason = safeText(rawReason, MAX_REASON_LENGTH);
	return reason ? { status, reason } : null;
}

function isAbortSignal(value: unknown): value is AbortSignal {
	if (!value || (typeof value !== 'object' && typeof value !== 'function')) {
		return false;
	}
	try {
		intrinsicAbortSignalAborted(value as AbortSignal);
		return true;
	} catch {
		return false;
	}
}

export function createDevToolsActionCoordinator({
	confirm,
	onReceipt,
	receiptLimit = DEFAULT_RECEIPT_LIMIT,
	now = Date.now,
}: DevToolsActionCoordinatorOptions = {}): DevToolsActionCoordinator {
	const entries = new Map<string, ReceiptEntry>();
	let inFlightConfirmationWork = 0;
	const normalizedReceiptLimit = Number.isFinite(receiptLimit)
		? Math.floor(receiptLimit)
		: DEFAULT_RECEIPT_LIMIT;
	const boundedReceiptLimit = Math.max(
		1,
		Math.min(DEFAULT_RECEIPT_LIMIT * 4, normalizedReceiptLimit),
	);

	const publish = (receipt: DevToolsActionReceipt): DevToolsActionReceipt => {
		try {
			onReceipt?.(receipt);
		} catch {
			// Host observability must never affect the requested operation.
		}
		return receipt;
	};

	const executePlan = async (
		plan: DevToolsActionPlan,
		action: DevToolsActionExecution['action'],
		rollback: DevToolsActionExecution['rollback'],
		signal: AbortSignal | undefined,
	): Promise<DevToolsActionReceipt> => {
		const startedAt = now();
		const cancelledReceipt = (): DevToolsActionReceipt =>
			publish(
				receiptFor(plan, startedAt, now(), {
					status: 'cancelled',
					rollbackStatus: 'not-needed',
				}),
			);
		if (signal && intrinsicAbortSignalAborted(signal))
			return cancelledReceipt();
		if (plan.capability.availability === 'unavailable') {
			return publish(
				receiptFor(plan, startedAt, now(), {
					status: 'rejected',
					rollbackStatus: 'not-needed',
					errorCode: 'unsupported',
					error:
						plan.capability.reason?.message ?? 'Capability is unavailable.',
				}),
			);
		}

		const policyRequiresConfirmation =
			plan.risk === 'confirmation' ||
			plan.risk === 'destructive' ||
			plan.risk === 'privacy-sensitive';
		if (policyRequiresConfirmation && !plan.confirmation.required) {
			return publish(
				receiptFor(plan, startedAt, now(), {
					status: 'rejected',
					rollbackStatus: 'not-needed',
					errorCode: 'confirmation-required',
					error: 'The host policy requires confirmation for this action.',
				}),
			);
		}
		if (plan.confirmation.required) {
			if (!confirm) {
				return publish(
					receiptFor(plan, startedAt, now(), {
						status: 'rejected',
						rollbackStatus: 'not-needed',
						errorCode: 'confirmation-unavailable',
						error: 'No trusted confirmation handler is available.',
					}),
				);
			}
			if (inFlightConfirmationWork >= MAX_IN_FLIGHT_CONFIRMATIONS) {
				return publish(
					receiptFor(plan, startedAt, now(), {
						status: 'rejected',
						rollbackStatus: 'not-needed',
						errorCode: 'confirmation-unavailable',
						error: 'The pending confirmation limit was reached.',
					}),
				);
			}
			inFlightConfirmationWork += 1;
			let confirmationWorkReleased = false;
			let confirmationSettlementOwnsWork = false;
			const releaseConfirmationWork = (): void => {
				if (confirmationWorkReleased) return;
				confirmationWorkReleased = true;
				inFlightConfirmationWork = Math.max(0, inFlightConfirmationWork - 1);
			};
			try {
				const confirmation = Promise.resolve(
					signal
						? confirm(plan.confirmation, plan, signal)
						: confirm(plan.confirmation, plan),
				);
				void confirmation.then(
					releaseConfirmationWork,
					releaseConfirmationWork,
				);
				confirmationSettlementOwnsWork = true;
				const confirmed = signal
					? await new Promise<boolean | undefined>((resolve, reject) => {
							let settled = false;
							const finish = (value: boolean | undefined): void => {
								if (settled) return;
								settled = true;
								try {
									removeIntrinsicAbortListener(signal, onAbort);
								} catch {
									// Resolution must not depend on a host-shadowed signal method.
								}
								resolve(value);
							};
							const onAbort = (): void => finish(undefined);
							if (intrinsicAbortSignalAborted(signal)) onAbort();
							else addIntrinsicAbortListener(signal, onAbort);
							void confirmation.then(
								(value) => finish(value),
								(error) => {
									if (settled) return;
									settled = true;
									try {
										removeIntrinsicAbortListener(signal, onAbort);
									} catch {
										// Preserve the confirmation rejection.
									}
									reject(error);
								},
							);
						})
					: await confirmation;
				if (confirmed !== true) return cancelledReceipt();
			} catch (error) {
				if (!confirmationSettlementOwnsWork) releaseConfirmationWork();
				return publish(
					receiptFor(plan, startedAt, now(), {
						status: 'rejected',
						rollbackStatus: 'not-needed',
						errorCode: 'confirmation-unavailable',
						error: safeError(error),
					}),
				);
			}
		}
		if (signal && intrinsicAbortSignalAborted(signal))
			return cancelledReceipt();

		try {
			await action();
			return publish(
				receiptFor(plan, startedAt, now(), {
					status: 'succeeded',
					rollbackStatus: 'not-needed',
				}),
			);
		} catch (error) {
			const actionError = safeError(error);
			if (plan.rollback.availability !== 'available') {
				return publish(
					receiptFor(plan, startedAt, now(), {
						status: 'failed',
						rollbackStatus: 'not-available',
						errorCode: 'action-failed',
						error: actionError,
					}),
				);
			}

			try {
				const rollbackResult = rollback
					? normalizeRollbackResult(await rollback())
					: null;
				if (rollbackResult?.status === 'complete') {
					return publish(
						receiptFor(plan, startedAt, now(), {
							status: 'rolled-back',
							rollbackStatus: 'succeeded',
							errorCode: 'action-failed',
							error: actionError,
						}),
					);
				}
				return publish(
					receiptFor(plan, startedAt, now(), {
						status: 'needs-attention',
						rollbackStatus: 'partial',
						errorCode: 'rollback-partial',
						error:
							rollbackResult?.reason ??
							'Rollback did not report complete recovery.',
					}),
				);
			} catch (rollbackError) {
				return publish(
					receiptFor(plan, startedAt, now(), {
						status: 'needs-attention',
						rollbackStatus: 'failed',
						errorCode: 'rollback-failed',
						error: safeError(rollbackError),
					}),
				);
			}
		}
	};

	const prune = () => {
		if (entries.size <= boundedReceiptLimit) return;
		for (const [requestId, entry] of entries) {
			if (!entry.settled) continue;
			entries.delete(requestId);
			if (entries.size <= boundedReceiptLimit) return;
		}
	};

	return {
		execute: async (execution): Promise<DevToolsActionReceipt> => {
			if (!execution || typeof execution !== 'object') {
				return publish(invalidReceipt(now));
			}
			const descriptors = descriptorsFor(execution);
			if (
				!descriptors ||
				hasAccessor(descriptors, 'plan') ||
				hasAccessor(descriptors, 'action') ||
				hasAccessor(descriptors, 'rollback') ||
				hasAccessor(descriptors, 'signal')
			) {
				return publish(invalidReceipt(now));
			}
			const plan = normalizeDevToolsActionPlan(
				dataProperty(descriptors, 'plan'),
			);
			const action = dataProperty(descriptors, 'action');
			const rollback = dataProperty(descriptors, 'rollback');
			const signal = dataProperty(descriptors, 'signal');
			if (
				!plan ||
				typeof action !== 'function' ||
				(rollback !== undefined && typeof rollback !== 'function') ||
				(signal !== undefined && !isAbortSignal(signal)) ||
				(plan?.rollback.availability === 'available' &&
					typeof rollback !== 'function')
			) {
				return publish(invalidReceipt(now));
			}

			const planFingerprint = fingerprint(plan);
			const existing = entries.get(plan.requestId);
			if (existing) {
				if (existing.fingerprint === planFingerprint) return existing.promise;
				const at = now();
				return publish(
					receiptFor(plan, at, at, {
						status: 'rejected',
						rollbackStatus: 'not-needed',
						errorCode: 'request-id-conflict',
						error: 'The request ID is already bound to a different action.',
					}),
				);
			}

			const entry: ReceiptEntry = {
				fingerprint: planFingerprint,
				settled: false,
				promise: Promise.resolve().then(() =>
					executePlan(
						plan,
						action as DevToolsActionExecution['action'],
						rollback as DevToolsActionExecution['rollback'],
						signal as AbortSignal | undefined,
					),
				),
			};
			entries.set(plan.requestId, entry);
			void entry.promise.finally(() => {
				entry.settled = true;
				prune();
			});
			return entry.promise;
		},
		clearReceipts: () => {
			for (const [requestId, entry] of entries) {
				if (entry.settled) entries.delete(requestId);
			}
		},
	};
}

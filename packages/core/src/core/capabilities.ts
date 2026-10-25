import {
	DEVTOOLS_ACTION_POLICY_VERSION,
	type DevToolsCapability,
	type DevToolsCapabilityReasonCode,
} from './action-policy';
import { redactDiagnosticText } from './redact';
import { truncateText } from './serialize';

export const DEVTOOLS_CAPABILITY_REGISTRY_VERSION = 1 as const;

const MAX_CAPABILITIES = 128;
const MAX_ID_LENGTH = 128;
const MAX_OPERATION_LENGTH = 128;
const MAX_OPERATIONS_PER_KIND = 64;
const MAX_REASON_LENGTH = 1_024;

export type DevToolsCapabilityAvailability =
	| 'available'
	| 'degraded'
	| 'disabled'
	| 'unsupported';

export type DevToolsCapabilityPlatform = 'android' | 'both' | 'ios';

export type DevToolsRuntimeCapability = {
	schemaVersion: typeof DEVTOOLS_CAPABILITY_REGISTRY_VERSION;
	toolId: string;
	version: number;
	availability: DevToolsCapabilityAvailability;
	reason?: string;
	read: readonly string[];
	mutate: readonly string[];
	platform?: DevToolsCapabilityPlatform;
};

export type DevToolsCapabilityOperation = 'mutate' | 'read';

export type DevToolsCapabilityDecision =
	| {
			allowed: true;
			capability: DevToolsRuntimeCapability;
			operation: string;
			operationKind: DevToolsCapabilityOperation;
	  }
	| {
			allowed: false;
			capability?: DevToolsRuntimeCapability;
			operation: string;
			operationKind: DevToolsCapabilityOperation;
			reason: {
				code: 'disabled' | 'invalid-request' | 'unavailable' | 'unsupported';
				message: string;
			};
	  };

export type DevToolsCapabilityRegistrySnapshot = {
	schemaVersion: typeof DEVTOOLS_CAPABILITY_REGISTRY_VERSION;
	revision: number;
	capabilities: readonly DevToolsRuntimeCapability[];
};

export type DevToolsCapabilityRegistry = {
	get(toolId: string): DevToolsRuntimeCapability | undefined;
	getSnapshot(): DevToolsCapabilityRegistrySnapshot;
	reconcile(capabilities: readonly DevToolsRuntimeCapability[]): void;
	resolve(
		toolId: string,
		operationKind: DevToolsCapabilityOperation,
		operation: string,
	): DevToolsCapabilityDecision;
	subscribe(listener: () => void): () => void;
	toActionCapability(toolId: string, operation: string): DevToolsCapability;
};

function normalizeIdentifier(
	value: unknown,
	maxLength: number,
): string | undefined {
	if (typeof value !== 'string') return undefined;
	const normalized = value.trim();
	if (
		!normalized ||
		normalized.length > maxLength ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)
	) {
		return undefined;
	}
	return normalized;
}

function normalizeOperations(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value) || value.length > MAX_OPERATIONS_PER_KIND) {
		return undefined;
	}
	const operations = value.map((operation) =>
		normalizeIdentifier(operation, MAX_OPERATION_LENGTH),
	);
	if (operations.some((operation) => operation === undefined)) return undefined;
	return Object.freeze([...new Set(operations as string[])].sort());
}

function normalizeReason(value: unknown): string | undefined | null {
	if (value === undefined) return undefined;
	if (typeof value !== 'string' || !value.trim()) return null;
	return truncateText(redactDiagnosticText(value.trim()), MAX_REASON_LENGTH)
		.text;
}

export function normalizeDevToolsRuntimeCapability(
	value: unknown,
): DevToolsRuntimeCapability | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	let descriptors: Record<string, PropertyDescriptor>;
	try {
		descriptors = Object.getOwnPropertyDescriptors(value);
	} catch {
		return null;
	}
	const allowedKeys = new Set([
		'schemaVersion',
		'toolId',
		'version',
		'availability',
		'reason',
		'read',
		'mutate',
		'platform',
	]);
	if (
		Object.keys(descriptors).some((key) => !allowedKeys.has(key)) ||
		Object.values(descriptors).some((descriptor) => !('value' in descriptor))
	) {
		return null;
	}
	const property = (key: string): unknown => descriptors[key]?.value;
	const toolId = normalizeIdentifier(property('toolId'), MAX_ID_LENGTH);
	const version = property('version');
	const availability = property('availability');
	const reason = normalizeReason(property('reason'));
	const read = normalizeOperations(property('read'));
	const mutate = normalizeOperations(property('mutate'));
	const platform = property('platform');
	if (
		property('schemaVersion') !== DEVTOOLS_CAPABILITY_REGISTRY_VERSION ||
		!toolId ||
		typeof version !== 'number' ||
		!Number.isSafeInteger(version) ||
		version < 1 ||
		(availability !== 'available' &&
			availability !== 'degraded' &&
			availability !== 'disabled' &&
			availability !== 'unsupported') ||
		reason === null ||
		!read ||
		!mutate ||
		(platform !== undefined &&
			platform !== 'android' &&
			platform !== 'both' &&
			platform !== 'ios')
	) {
		return null;
	}
	if (availability !== 'available' && !reason) return null;
	return Object.freeze({
		schemaVersion: DEVTOOLS_CAPABILITY_REGISTRY_VERSION,
		toolId,
		version,
		availability,
		...(reason ? { reason } : {}),
		read,
		mutate,
		...(platform ? { platform } : {}),
	});
}

function unavailableDecision(
	operationKind: DevToolsCapabilityOperation,
	operation: string,
	code: 'disabled' | 'invalid-request' | 'unavailable' | 'unsupported',
	message: string,
	capability?: DevToolsRuntimeCapability,
): DevToolsCapabilityDecision {
	return {
		allowed: false,
		...(capability ? { capability } : {}),
		operation,
		operationKind,
		reason: { code, message },
	};
}

function actionReasonCode(
	decision: Extract<DevToolsCapabilityDecision, { allowed: false }>,
): DevToolsCapabilityReasonCode {
	if (decision.reason.code === 'disabled') return 'disabled';
	if (decision.reason.code === 'unsupported') return 'unsupported';
	return 'unavailable';
}

export function createDevToolsCapabilityRegistry(
	initial: readonly DevToolsRuntimeCapability[] = [],
): DevToolsCapabilityRegistry {
	let revision = 0;
	let capabilities = new Map<string, DevToolsRuntimeCapability>();
	let snapshot: DevToolsCapabilityRegistrySnapshot = Object.freeze({
		schemaVersion: DEVTOOLS_CAPABILITY_REGISTRY_VERSION,
		revision,
		capabilities: Object.freeze([]),
	});
	const listeners = new Set<() => void>();

	const reconcile = (next: readonly DevToolsRuntimeCapability[]): void => {
		if (!Array.isArray(next) || next.length > MAX_CAPABILITIES) {
			throw new Error(
				`Capability registry accepts at most ${MAX_CAPABILITIES} tools.`,
			);
		}
		const normalized = next.map(normalizeDevToolsRuntimeCapability);
		if (normalized.some((capability) => capability === null)) {
			throw new Error('Capability registry received an invalid capability.');
		}
		const entries = normalized as DevToolsRuntimeCapability[];
		const ids = new Set(entries.map((capability) => capability.toolId));
		if (ids.size !== entries.length) {
			throw new Error('Capability registry tool IDs must be unique.');
		}
		capabilities = new Map(
			entries.map((capability) => [capability.toolId, capability]),
		);
		revision += 1;
		snapshot = Object.freeze({
			schemaVersion: DEVTOOLS_CAPABILITY_REGISTRY_VERSION,
			revision,
			capabilities: Object.freeze(
				[...capabilities.values()].sort((left, right) =>
					left.toolId.localeCompare(right.toolId),
				),
			),
		});
		for (const listener of [...listeners]) listener();
	};

	const resolve = (
		toolId: string,
		operationKind: DevToolsCapabilityOperation,
		operation: string,
	): DevToolsCapabilityDecision => {
		const normalizedToolId = normalizeIdentifier(toolId, MAX_ID_LENGTH);
		const normalizedOperation = normalizeIdentifier(
			operation,
			MAX_OPERATION_LENGTH,
		);
		if (!normalizedToolId || !normalizedOperation) {
			return unavailableDecision(
				operationKind,
				operation,
				'invalid-request',
				'Capability operation identifiers are invalid.',
			);
		}
		const capability = capabilities.get(normalizedToolId);
		if (!capability) {
			return unavailableDecision(
				operationKind,
				normalizedOperation,
				'unsupported',
				`${normalizedToolId} is not registered by this runtime.`,
			);
		}
		if (
			capability.availability !== 'available' &&
			capability.availability !== 'degraded'
		) {
			return unavailableDecision(
				operationKind,
				normalizedOperation,
				capability.availability,
				capability.reason ??
					`${normalizedToolId} is ${capability.availability}.`,
				capability,
			);
		}
		const supported = capability[operationKind];
		if (!supported.includes(normalizedOperation)) {
			return unavailableDecision(
				operationKind,
				normalizedOperation,
				'unsupported',
				`${normalizedToolId} does not support ${operationKind} operation ${normalizedOperation}.`,
				capability,
			);
		}
		return {
			allowed: true,
			capability,
			operation: normalizedOperation,
			operationKind,
		};
	};

	const registry: DevToolsCapabilityRegistry = {
		get: (toolId) => capabilities.get(toolId),
		getSnapshot: () => snapshot,
		reconcile,
		resolve,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		toActionCapability: (toolId, operation) => {
			const decision = resolve(toolId, 'mutate', operation);
			return decision.allowed
				? {
						schemaVersion: DEVTOOLS_ACTION_POLICY_VERSION,
						id: `${toolId}.${operation}`,
						availability: 'available',
					}
				: {
						schemaVersion: DEVTOOLS_ACTION_POLICY_VERSION,
						id: `${toolId}.${operation}`,
						availability: 'unavailable',
						reason: {
							code: actionReasonCode(decision),
							message: decision.reason.message,
						},
					};
		},
	};

	if (initial.length > 0) reconcile(initial);
	return registry;
}

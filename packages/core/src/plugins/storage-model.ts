import {
	diagnosticErrorText,
	isSensitiveDiagnosticKey,
	sanitizeDiagnosticValueWithMetadata,
} from '../core/redact';
import {
	serializeValue,
	truncateText,
	utf8ByteLength,
} from '../core/serialize';

export type StorageAdapterCapabilities = Readonly<{
	enumerable: boolean;
	readable: boolean;
	writable: boolean;
	deletable: boolean;
	clearable: boolean;
	sensitive: boolean;
	requiresAuthentication: boolean;
}>;

export type StorageRegisteredKey = Readonly<{
	key: string;
	description?: string;
	requiresAuthentication?: boolean;
	/** Values stay metadata-only unless the application opts this exact key in. */
	revealable?: boolean;
}>;

export type DevToolsStorageAdapter = {
	id: string;
	title: string;
	description?: string;
	capabilities?: Partial<StorageAdapterCapabilities>;
	registeredKeys?: readonly StorageRegisteredKey[];
	sensitive?: boolean;
	/**
	 * Shows the values of a sensitive adapter, which are otherwise never read,
	 * and values stored under a key whose name marks it sensitive
	 * (`refreshToken`, `session`), which are otherwise redacted.
	 */
	revealValues?: boolean;
	getAllKeys?: () => readonly string[] | Promise<readonly string[]>;
	getValue?: (key: string) => unknown | Promise<unknown>;
	revealValue?: (key: string) => unknown | Promise<unknown>;
	setValue?: (key: string, value: unknown) => void | Promise<void>;
	parseValue?: (key: string, draft: string, valueType: string) => unknown;
	removeValue?: (key: string) => void | Promise<void>;
	clear?: () => void | Promise<void>;
	subscribe?: (listener: () => void) => () => void;
};

export type StorageEntrySnapshot = {
	key: string;
	description?: string;
	requiresAuthentication?: boolean;
	revealable?: boolean;
	value?: string;
	valueType?: string;
	truncated: boolean;
	redacted?: boolean;
	valueHidden: boolean;
	readError?: string;
	binary: boolean;
};

export type StorageAdapterSnapshot = {
	id: string;
	title: string;
	description?: string;
	sensitive: boolean;
	capabilities?: StorageAdapterCapabilities;
	keyDiscovery?: 'enumerated' | 'registered';
	entries: readonly StorageEntrySnapshot[];
	totalKeyCount: number;
	omittedKeyCount: number;
	estimatedBytes: number;
	truncated: boolean;
	error?: string;
};

export type StorageSnapshot = {
	loading: boolean;
	adapters: readonly StorageAdapterSnapshot[];
};

export type StorageKeyRule = {
	adapterId: string;
	key: string;
	description?: string;
	required?: boolean;
	expectedType?: 'string' | 'number' | 'boolean' | 'object' | 'array';
};

export type StorageValidationResult = StorageKeyRule & {
	status: 'valid' | 'missing' | 'typeMismatch' | 'protected' | 'notCaptured';
	actualType?: string;
};

export type StorageSnapshotLimits = {
	maxEntries: number;
	maxSnapshotBytes: number;
};

const MAX_STORAGE_KEY_BYTES = 64 * 1024;
const MAX_STORAGE_ERROR_BYTES = 8 * 1024;
const MAX_STORAGE_KEY_CANDIDATES = 10_000;
const MAX_STORAGE_ADAPTERS = 10;
const MAX_STORAGE_RULES = 500;
const MAX_STORAGE_TEXT_LENGTH = 4 * 1024;
const STORAGE_VALUE_TYPES = new Set([
	'string',
	'number',
	'boolean',
	'object',
	'array',
]);

function denseArrayValues(
	value: unknown,
	label: string,
	maxItems: number,
): readonly unknown[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
	let length = 0;
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
		if (!descriptor || !('value' in descriptor)) {
			throw new Error(`${label} has an invalid length.`);
		}
		length = descriptor.value;
	} catch {
		throw new Error(`${label} must be a readable array.`);
	}
	if (!Number.isSafeInteger(length) || length < 0 || length > maxItems) {
		throw new Error(`${label} supports at most ${maxItems} items.`);
	}
	const values: unknown[] = [];
	for (let index = 0; index < length; index += 1) {
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		} catch {
			throw new Error(`${label} contains an unreadable item.`);
		}
		if (!descriptor || !('value' in descriptor)) {
			throw new Error(`${label} cannot contain holes or accessors.`);
		}
		values.push(descriptor.value);
	}
	return values;
}

function dataField(record: object, key: string): unknown {
	let descriptor: PropertyDescriptor | undefined;
	try {
		descriptor = Object.getOwnPropertyDescriptor(record, key);
	} catch {
		throw new Error(`Storage configuration field ${key} is unreadable.`);
	}
	if (!descriptor) return undefined;
	if (!('value' in descriptor)) {
		throw new Error(
			`Storage configuration field ${key} cannot be an accessor.`,
		);
	}
	return descriptor.value;
}

type StorageAdapterFunctionKey =
	| 'getAllKeys'
	| 'getValue'
	| 'revealValue'
	| 'setValue'
	| 'parseValue'
	| 'removeValue'
	| 'clear'
	| 'subscribe';

function optionalFunction<Key extends StorageAdapterFunctionKey>(
	record: object,
	key: Key,
): NonNullable<DevToolsStorageAdapter[Key]> | undefined {
	const value = dataField(record, key);
	if (value === undefined) return undefined;
	if (typeof value !== 'function') {
		throw new Error(`Storage adapter ${key} must be a function.`);
	}
	return value as NonNullable<DevToolsStorageAdapter[Key]>;
}

function optionalBoolean(record: object, key: string): boolean | undefined {
	const value = dataField(record, key);
	if (value !== undefined && typeof value !== 'boolean') {
		throw new Error(`Storage configuration field ${key} must be a boolean.`);
	}
	return value as boolean | undefined;
}

function storageCapabilities(
	adapter: Pick<
		DevToolsStorageAdapter,
		| 'capabilities'
		| 'clear'
		| 'getAllKeys'
		| 'getValue'
		| 'removeValue'
		| 'sensitive'
		| 'setValue'
	>,
): StorageAdapterCapabilities {
	const declared = adapter.capabilities ?? {};
	return {
		enumerable: declared.enumerable ?? adapter.getAllKeys !== undefined,
		readable: declared.readable ?? adapter.getValue !== undefined,
		writable: declared.writable ?? adapter.setValue !== undefined,
		deletable: declared.deletable ?? adapter.removeValue !== undefined,
		clearable: declared.clearable ?? adapter.clear !== undefined,
		sensitive: declared.sensitive ?? adapter.sensitive === true,
		requiresAuthentication: declared.requiresAuthentication ?? false,
	};
}

function registeredStorageKeys(
	value: unknown,
): readonly StorageRegisteredKey[] {
	if (value === undefined) return [];
	return denseArrayValues(
		value,
		'Registered storage keys',
		MAX_STORAGE_KEY_CANDIDATES,
	).map((candidate) => {
		if (!candidate || typeof candidate !== 'object') {
			throw new Error('Registered storage keys must be objects.');
		}
		const key = dataField(candidate, 'key');
		const description = dataField(candidate, 'description');
		const requiresAuthentication = dataField(
			candidate,
			'requiresAuthentication',
		);
		const revealable = dataField(candidate, 'revealable');
		if (
			typeof key !== 'string' ||
			key.length === 0 ||
			utf8ByteLength(key) > MAX_STORAGE_KEY_BYTES
		) {
			throw new Error('Registered storage keys must be 1–65536 bytes.');
		}
		if (
			description !== undefined &&
			(typeof description !== 'string' ||
				description.length > MAX_STORAGE_TEXT_LENGTH)
		) {
			throw new Error(
				'Registered storage key descriptions cannot exceed 4096 characters.',
			);
		}
		if (
			requiresAuthentication !== undefined &&
			typeof requiresAuthentication !== 'boolean'
		) {
			throw new Error(
				'Registered storage key authentication must be a boolean.',
			);
		}
		if (revealable !== undefined && typeof revealable !== 'boolean') {
			throw new Error(
				'Registered storage key revealability must be a boolean.',
			);
		}
		return {
			key,
			...(typeof description === 'string' ? { description } : {}),
			...(requiresAuthentication === true
				? { requiresAuthentication: true }
				: {}),
			...(revealable === true ? { revealable: true } : {}),
		};
	});
}

/** Validates and detaches extension-owned storage configuration. */
export function normalizeStorageConfiguration(
	adaptersValue: unknown,
	rulesValue: unknown,
): {
	adapters: readonly DevToolsStorageAdapter[];
	rules: readonly StorageKeyRule[];
} {
	const adapters = denseArrayValues(
		adaptersValue,
		'Storage adapters',
		MAX_STORAGE_ADAPTERS,
	).map((candidate): DevToolsStorageAdapter => {
		if (!candidate || typeof candidate !== 'object') {
			throw new Error('Storage adapters must be objects.');
		}
		const id = dataField(candidate, 'id');
		const title = dataField(candidate, 'title');
		const description = dataField(candidate, 'description');
		if (typeof id !== 'string' || !id || id !== id.trim() || id.length > 256) {
			throw new Error('Storage adapter ids must be 1–256 trimmed characters.');
		}
		if (
			typeof title !== 'string' ||
			!title.trim() ||
			title.length > MAX_STORAGE_TEXT_LENGTH
		) {
			throw new Error('Storage adapter titles must be 1–4096 characters.');
		}
		if (
			description !== undefined &&
			(typeof description !== 'string' ||
				description.length > MAX_STORAGE_TEXT_LENGTH)
		) {
			throw new Error(
				'Storage adapter descriptions cannot exceed 4096 characters.',
			);
		}
		const getAllKeys = optionalFunction(candidate, 'getAllKeys');
		const getValue = optionalFunction(candidate, 'getValue');
		const revealValue = optionalFunction(candidate, 'revealValue');
		const setValue = optionalFunction(candidate, 'setValue');
		const parseValue = optionalFunction(candidate, 'parseValue');
		const removeValue = optionalFunction(candidate, 'removeValue');
		const clear = optionalFunction(candidate, 'clear');
		const subscribe = optionalFunction(candidate, 'subscribe');
		const capabilitiesValue = dataField(candidate, 'capabilities');
		if (
			capabilitiesValue !== undefined &&
			(!capabilitiesValue || typeof capabilitiesValue !== 'object')
		) {
			throw new Error('Storage adapter capabilities must be an object.');
		}
		const capabilities = storageCapabilities({
			capabilities:
				capabilitiesValue && typeof capabilitiesValue === 'object'
					? {
							enumerable: optionalBoolean(capabilitiesValue, 'enumerable'),
							readable: optionalBoolean(capabilitiesValue, 'readable'),
							writable: optionalBoolean(capabilitiesValue, 'writable'),
							deletable: optionalBoolean(capabilitiesValue, 'deletable'),
							clearable: optionalBoolean(capabilitiesValue, 'clearable'),
							sensitive: optionalBoolean(capabilitiesValue, 'sensitive'),
							requiresAuthentication: optionalBoolean(
								capabilitiesValue,
								'requiresAuthentication',
							),
						}
					: undefined,
			clear,
			getAllKeys,
			getValue,
			removeValue,
			sensitive: optionalBoolean(candidate, 'sensitive'),
			setValue,
		});
		const registeredKeys = registeredStorageKeys(
			dataField(candidate, 'registeredKeys'),
		);
		if (!capabilities.enumerable && registeredKeys.length === 0) {
			throw new Error(
				'Non-enumerable storage adapters require registered keys.',
			);
		}
		if (capabilities.enumerable && !getAllKeys) {
			throw new Error('Enumerable storage adapters require getAllKeys.');
		}
		if (registeredKeys.some((entry) => entry.revealable) && !revealValue) {
			throw new Error(
				'Revealable registered storage keys require a revealValue function.',
			);
		}
		return {
			id,
			title,
			...(typeof description === 'string' ? { description } : {}),
			...(optionalBoolean(candidate, 'sensitive') === true
				? { sensitive: true }
				: {}),
			...(optionalBoolean(candidate, 'revealValues') === true
				? { revealValues: true }
				: {}),
			capabilities,
			...(registeredKeys.length > 0 ? { registeredKeys } : {}),
			...(getAllKeys ? { getAllKeys } : {}),
			...(getValue ? { getValue } : {}),
			...(revealValue ? { revealValue } : {}),
			...(setValue ? { setValue } : {}),
			...(parseValue ? { parseValue } : {}),
			...(removeValue ? { removeValue } : {}),
			...(clear ? { clear } : {}),
			...(subscribe ? { subscribe } : {}),
		};
	});

	const adapterIds = new Set<string>();
	for (const adapter of adapters) {
		if (adapterIds.has(adapter.id)) {
			throw new Error(`Duplicate storage adapter id: ${adapter.id}`);
		}
		adapterIds.add(adapter.id);
	}

	const signatures = new Set<string>();
	const rules = denseArrayValues(
		rulesValue,
		'Storage validation rules',
		MAX_STORAGE_RULES,
	).map((candidate): StorageKeyRule => {
		if (!candidate || typeof candidate !== 'object') {
			throw new Error('Storage validation rules must be objects.');
		}
		const adapterId = dataField(candidate, 'adapterId');
		const key = dataField(candidate, 'key');
		const description = dataField(candidate, 'description');
		const required = dataField(candidate, 'required');
		const expectedType = dataField(candidate, 'expectedType');
		if (typeof adapterId !== 'string' || !adapterIds.has(adapterId)) {
			throw new Error(
				'Storage validation rules must reference a known adapter.',
			);
		}
		if (
			typeof key !== 'string' ||
			key.length === 0 ||
			utf8ByteLength(key) > MAX_STORAGE_KEY_BYTES
		) {
			throw new Error('Storage validation rule keys must be 1–65536 bytes.');
		}
		if (
			description !== undefined &&
			(typeof description !== 'string' ||
				description.length > MAX_STORAGE_TEXT_LENGTH)
		) {
			throw new Error(
				'Storage validation rule descriptions cannot exceed 4096 characters.',
			);
		}
		if (required !== undefined && typeof required !== 'boolean') {
			throw new Error('Storage validation rule required must be a boolean.');
		}
		if (
			expectedType !== undefined &&
			(typeof expectedType !== 'string' ||
				!STORAGE_VALUE_TYPES.has(expectedType))
		) {
			throw new Error('Storage validation rule expectedType is invalid.');
		}
		const signature = `${adapterId}\0${key}`;
		if (signatures.has(signature)) {
			throw new Error(`Duplicate storage validation rule: ${adapterId}:${key}`);
		}
		signatures.add(signature);
		return {
			adapterId,
			key,
			...(typeof description === 'string' ? { description } : {}),
			...(typeof required === 'boolean' ? { required } : {}),
			...(typeof expectedType === 'string'
				? { expectedType: expectedType as StorageKeyRule['expectedType'] }
				: {}),
		};
	});

	return { adapters, rules };
}

function storageErrorText(error: unknown): string {
	return truncateText(diagnosticErrorText(error), MAX_STORAGE_ERROR_BYTES).text;
}

function storageEntryBytes(entry: StorageEntrySnapshot): number {
	return serializeValue(entry, Number.MAX_SAFE_INTEGER).estimatedBytes;
}

export type StorageChangeEvent = {
	id: number;
	at: number;
	adapterId: string;
	adapterTitle: string;
	key: string;
	type: 'added' | 'updated' | 'removed';
	previousValue?: string;
	previousValueType?: string;
	value?: string;
	valueType?: string;
	valueHidden: boolean;
	structuralDiff?: readonly StorageStructuralDiffEntry[];
	bookmarked?: boolean;
	undoAvailable?: boolean;
	undoExpiresAt?: number;
	undoStatus?: 'available' | 'expired' | 'succeeded' | 'failed';
};

export type StorageStructuralDiffEntry = Readonly<{
	path: string;
	kind: 'added' | 'changed' | 'removed';
	previousValue?: string;
	value?: string;
}>;

const MAX_STRUCTURAL_DIFF_ENTRIES = 200;
const MAX_STRUCTURAL_DIFF_DEPTH = 16;

function diffPreview(value: unknown): string {
	return serializeValue(
		sanitizeDiagnosticValueWithMetadata(value).value,
		4 * 1024,
	).text;
}

/** Produces a bounded, redacted JSON-path diff for storage history presentation. */
export function diffStorageValues(
	previousText: string | undefined,
	valueText: string | undefined,
): readonly StorageStructuralDiffEntry[] {
	let previous: unknown = previousText;
	let value: unknown = valueText;
	try {
		if (previousText !== undefined) previous = JSON.parse(previousText);
	} catch {}
	try {
		if (valueText !== undefined) value = JSON.parse(valueText);
	} catch {}
	const entries: StorageStructuralDiffEntry[] = [];
	const visit = (
		left: unknown,
		right: unknown,
		path: string,
		depth: number,
	): void => {
		if (entries.length >= MAX_STRUCTURAL_DIFF_ENTRIES || Object.is(left, right))
			return;
		if (
			depth < MAX_STRUCTURAL_DIFF_DEPTH &&
			left !== null &&
			right !== null &&
			typeof left === 'object' &&
			typeof right === 'object' &&
			!Array.isArray(left) &&
			!Array.isArray(right)
		) {
			const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
			for (const key of [...keys].sort()) {
				visit(
					(left as Record<string, unknown>)[key],
					(right as Record<string, unknown>)[key],
					`${path}.${key}`,
					depth + 1,
				);
			}
			return;
		}
		entries.push({
			path,
			kind:
				left === undefined
					? 'added'
					: right === undefined
						? 'removed'
						: 'changed',
			...(left === undefined ? {} : { previousValue: diffPreview(left) }),
			...(right === undefined ? {} : { value: diffPreview(right) }),
		});
	};
	visit(previous, value, '$', 0);
	return entries;
}

function storageValueType(value: unknown): string {
	if (Array.isArray(value)) return 'array';
	if (value === null) return 'null';
	return typeof value;
}

function isBinaryStorageValue(value: unknown): boolean {
	return (
		(typeof ArrayBuffer !== 'undefined' &&
			(value instanceof ArrayBuffer || ArrayBuffer.isView(value))) ||
		(typeof Blob !== 'undefined' && value instanceof Blob)
	);
}

export function parseStorageDraft(draft: string, valueType: string): unknown {
	switch (valueType) {
		case 'string':
			return draft;
		case 'number': {
			// Number('') and Number('   ') are 0, so an emptied field would save a
			// real zero over the previous value instead of reporting a mistake.
			if (!draft.trim()) throw new Error('Enter a finite number.');
			const value = Number(draft);
			if (!Number.isFinite(value)) throw new Error('Enter a finite number.');
			return value;
		}
		case 'boolean':
			if (draft === 'true') return true;
			if (draft === 'false') return false;
			throw new Error('Enter true or false.');
		case 'object': {
			const value: unknown = JSON.parse(draft);
			if (!value || typeof value !== 'object' || Array.isArray(value)) {
				throw new Error('Enter a JSON object.');
			}
			return value;
		}
		case 'array': {
			const value: unknown = JSON.parse(draft);
			if (!Array.isArray(value)) throw new Error('Enter a JSON array.');
			return value;
		}
		default:
			throw new Error(
				`${valueType || 'Unknown'} values cannot be edited safely.`,
			);
	}
}

function isEditableValueType(valueType: string | undefined): boolean {
	return (
		valueType === 'string' ||
		valueType === 'number' ||
		valueType === 'boolean' ||
		valueType === 'object' ||
		valueType === 'array'
	);
}

export function isStorageEntryEditable(
	adapter: DevToolsStorageAdapter,
	entry: StorageEntrySnapshot,
): boolean {
	return (
		!entry.valueHidden &&
		!entry.truncated &&
		!entry.redacted &&
		!entry.readError &&
		!entry.binary &&
		isEditableValueType(entry.valueType) &&
		(adapter.capabilities?.writable ?? true) &&
		!!adapter.setValue
	);
}

export function validateStorageSnapshot(
	snapshot: StorageSnapshot,
	rules: readonly StorageKeyRule[],
): readonly StorageValidationResult[] {
	return rules.map((rule) => {
		const adapter = snapshot.adapters.find(
			(candidate) => candidate.id === rule.adapterId,
		);
		const entry = adapter?.entries.find(
			(candidate) => candidate.key === rule.key,
		);
		if (!entry) {
			if (adapter?.truncated) return { ...rule, status: 'notCaptured' };
			return { ...rule, status: rule.required === false ? 'valid' : 'missing' };
		}
		if (entry.valueHidden) return { ...rule, status: 'protected' };
		if (rule.expectedType && entry.valueType !== rule.expectedType) {
			return { ...rule, status: 'typeMismatch', actualType: entry.valueType };
		}
		return { ...rule, status: 'valid', actualType: entry.valueType };
	});
}

export async function snapshotStorageAdapter(
	adapter: DevToolsStorageAdapter,
	maxValueBytes: number,
	limits: StorageSnapshotLimits = {
		maxEntries: Number.MAX_SAFE_INTEGER,
		maxSnapshotBytes: Number.MAX_SAFE_INTEGER,
	},
): Promise<StorageAdapterSnapshot> {
	const capabilities = storageCapabilities(adapter);
	const registeredKeys = new Map(
		(adapter.registeredKeys ?? []).map((entry) => [entry.key, entry]),
	);
	try {
		const rawKeys = capabilities.enumerable
			? await adapter.getAllKeys?.()
			: [...registeredKeys.keys()];
		if (!Array.isArray(rawKeys)) {
			throw new Error('Storage adapter returned an invalid key list.');
		}
		const lengthDescriptor = Object.getOwnPropertyDescriptor(rawKeys, 'length');
		const rawKeyCount =
			lengthDescriptor &&
			'value' in lengthDescriptor &&
			Number.isSafeInteger(lengthDescriptor.value) &&
			lengthDescriptor.value >= 0
				? lengthDescriptor.value
				: -1;
		if (rawKeyCount < 0) {
			throw new Error('Storage adapter returned an invalid key-list length.');
		}
		const validKeys: string[] = [];
		const candidateCount = Math.min(rawKeyCount, MAX_STORAGE_KEY_CANDIDATES);
		for (let index = 0; index < candidateCount; index += 1) {
			const descriptor = Object.getOwnPropertyDescriptor(
				rawKeys,
				String(index),
			);
			if (!descriptor || !('value' in descriptor)) {
				throw new Error(
					'Storage adapter key lists cannot contain holes or accessors.',
				);
			}
			const key = descriptor.value;
			if (
				typeof key !== 'string' ||
				key.length === 0 ||
				utf8ByteLength(key) > MAX_STORAGE_KEY_BYTES
			) {
				throw new Error('Storage adapter returned an invalid key.');
			}
			validKeys.push(key);
		}
		const keys = [...new Set(validKeys)].sort((left, right) =>
			left.localeCompare(right),
		);
		const revealsValues = adapter.revealValues === true;
		const valueHidden = capabilities.sensitive && !revealsValues;
		const candidateKeys = keys.slice(0, limits.maxEntries);
		const entries: StorageEntrySnapshot[] = [];
		let estimatedBytes = 0;
		for (const key of candidateKeys) {
			const registration = registeredKeys.get(key);
			const requiresAuthentication =
				registration?.requiresAuthentication === true ||
				capabilities.requiresAuthentication === true;
			const revealable =
				registration?.revealable === true && adapter.revealValue !== undefined;
			const metadataBytes = utf8ByteLength(key) + 256;
			const remainingBytes = limits.maxSnapshotBytes - estimatedBytes;
			if (remainingBytes < metadataBytes) continue;

			let entry: StorageEntrySnapshot;
			if (valueHidden || !capabilities.readable || !adapter.getValue) {
				entry = {
					key,
					...(registration?.description
						? { description: registration.description }
						: {}),
					...(requiresAuthentication ? { requiresAuthentication: true } : {}),
					...(revealable ? { revealable: true } : {}),
					truncated: false,
					valueHidden: true,
					binary: false,
				};
			} else {
				try {
					const value = await adapter.getValue(key);
					const binary = isBinaryStorageValue(value);
					const valueBudget = Math.max(
						1,
						Math.min(maxValueBytes, remainingBytes - metadataBytes),
					);
					// An opaque token has no shape the value rules recognize, so a
					// sensitive key name alone redacts it, as it redacts an object field.
					const sanitized = binary
						? undefined
						: !revealsValues && isSensitiveDiagnosticKey(key)
							? { value: '[REDACTED]', truncated: false, redacted: true }
							: sanitizeDiagnosticValueWithMetadata(value);
					const serialized = binary
						? truncateText('[Binary value omitted]', valueBudget)
						: typeof sanitized?.value === 'string'
							? truncateText(sanitized.value, valueBudget)
							: serializeValue(sanitized?.value, valueBudget);
					entry = {
						key,
						...(registration?.description
							? { description: registration.description }
							: {}),
						...(requiresAuthentication ? { requiresAuthentication: true } : {}),
						...(revealable ? { revealable: true } : {}),
						value: serialized.text,
						valueType: storageValueType(value),
						truncated: serialized.truncated || sanitized?.truncated === true,
						redacted: sanitized?.redacted === true,
						valueHidden: false,
						binary,
					};
				} catch (error) {
					entry = {
						key,
						...(registration?.description
							? { description: registration.description }
							: {}),
						...(requiresAuthentication ? { requiresAuthentication: true } : {}),
						...(revealable ? { revealable: true } : {}),
						value: '[Read failed]',
						truncated: false,
						valueHidden: false,
						binary: false,
						readError: storageErrorText(error),
					};
				}
			}

			const entryBytes = storageEntryBytes(entry);
			if (estimatedBytes + entryBytes > limits.maxSnapshotBytes) continue;
			entries.push(entry);
			estimatedBytes += entryBytes;
		}
		// Count against the de-duplicated key set: a duplicate an adapter reports
		// twice was never dropped, and counting it as omitted flips `truncated`,
		// which makes validateStorageSnapshot report every rule as `notCaptured`.
		const omittedKeyCount = keys.length - entries.length;
		return {
			id: adapter.id,
			title: adapter.title,
			description: adapter.description,
			sensitive: capabilities.sensitive,
			capabilities,
			keyDiscovery: capabilities.enumerable ? 'enumerated' : 'registered',
			entries,
			totalKeyCount: keys.length,
			omittedKeyCount,
			estimatedBytes,
			truncated: omittedKeyCount > 0,
		};
	} catch (error) {
		return {
			id: adapter.id,
			title: adapter.title,
			description: adapter.description,
			sensitive: capabilities.sensitive,
			capabilities,
			keyDiscovery: capabilities.enumerable ? 'enumerated' : 'registered',
			entries: [],
			totalKeyCount: 0,
			omittedKeyCount: 0,
			estimatedBytes: 0,
			truncated: false,
			error: storageErrorText(error),
		};
	}
}

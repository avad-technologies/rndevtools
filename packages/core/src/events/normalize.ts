import {
	createKeyWalker,
	redactWithinWindow,
	VALUE_OMITTED,
	VALUE_UNITS,
} from '../core/bounded-redaction';
import { isSensitiveDiagnosticKey, redactDiagnosticText } from '../core/redact';
import type {
	DevtoolsEventAttribute,
	DevtoolsEventInput,
	DevtoolsEventLevel,
	DevtoolsEventResourceRef,
} from './types';

const LEVELS = new Set<DevtoolsEventLevel>(['debug', 'info', 'warn', 'error']);
const MAX_IDENTIFIER_BYTES = 512;
const MAX_TITLE_BYTES = 4 * 1024;
const MAX_SUMMARY_BYTES = 16 * 1024;
const MAX_ATTRIBUTE_COUNT = 64;
const MAX_ATTRIBUTE_KEY_BYTES = 512;
const MAX_ATTRIBUTE_VALUE_BYTES = 4 * 1024;
// The work that the attributes of one event share, in code units, charged as
// the Console plugin charges its attributes: every code unit of a key or
// string tested or redacted, or of a key copied again, and `VALUE_UNITS` for
// every key listed. At most `MAX_ATTRIBUTE_COUNT` values are read. Once it is
// spent, the strings still reached are omitted, and so are the keys of more
// than `MAX_ATTRIBUTE_KEY_BYTES` code units.
const MAX_ATTRIBUTE_UNITS = 2 * 1024 * 1024;
const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000;
const INPUT_FIELDS = new Set([
	'at',
	'attributes',
	'correlationId',
	'kind',
	'level',
	'parentEventId',
	'resourceRef',
	'source',
	'summary',
	'title',
]);

type NormalizationState = {
	redacted: boolean;
	truncated: boolean;
};

export type NormalizedDevtoolsEventInput = Readonly<{
	at: number;
	source: string;
	kind: string;
	level: DevtoolsEventLevel;
	title: string;
	summary?: string;
	correlationId?: string;
	parentEventId?: string;
	resourceRef?: DevtoolsEventResourceRef;
	attributes?: Readonly<Record<string, DevtoolsEventAttribute>>;
	redacted: boolean;
	truncated: boolean;
}>;

function dataProperties(
	value: unknown,
): Record<string, PropertyDescriptor> | null {
	if (value === null || typeof value !== 'object') return null;
	try {
		return Object.getOwnPropertyDescriptors(value);
	} catch {
		return null;
	}
}

function dataValue(
	descriptors: Record<string, PropertyDescriptor>,
	key: string,
): unknown {
	const descriptor = descriptors[key];
	return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function redactNoting(state: NormalizationState): (text: string) => string {
	return (text) => {
		const redacted = redactDiagnosticText(text);
		if (redacted !== text) state.redacted = true;
		return redacted;
	};
}

/**
 * Redacts a bounded window of a text and cuts it to `maxBytes`, so a long one
 * costs no more than what it can keep. `budget` is charged for every code
 * unit redacted.
 */
function safeText(
	value: unknown,
	maxBytes: number,
	state: NormalizationState,
	trim = false,
	budget?: { units: number },
): string | undefined {
	if (typeof value !== 'string') return undefined;
	const bounded = redactWithinWindow(
		trim ? value.trim() : value,
		maxBytes,
		redactNoting(state),
		budget,
	);
	if (bounded.truncated) state.truncated = true;
	return bounded.text;
}

function isValidTimestamp(value: unknown): value is number {
	return (
		typeof value === 'number' &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= MAX_DATE_TIMESTAMP
	);
}

function normalizeResourceRef(
	value: unknown,
	state: NormalizationState,
): DevtoolsEventResourceRef | undefined {
	if (value === undefined) return undefined;
	const descriptors = dataProperties(value);
	if (!descriptors) {
		state.truncated = true;
		return undefined;
	}
	if (
		Object.entries(descriptors).some(
			([key, descriptor]) =>
				descriptor.enumerable && key !== 'toolId' && key !== 'resourceId',
		)
	) {
		state.truncated = true;
	}
	const toolId = safeText(
		dataValue(descriptors, 'toolId'),
		MAX_IDENTIFIER_BYTES,
		state,
		true,
	);
	const resourceId = safeText(
		dataValue(descriptors, 'resourceId'),
		MAX_IDENTIFIER_BYTES,
		state,
		true,
	);
	if (!toolId || !resourceId) {
		state.truncated = true;
		return undefined;
	}
	return Object.freeze({ toolId, resourceId });
}

function normalizeAttributes(
	value: unknown,
	state: NormalizationState,
): Readonly<Record<string, DevtoolsEventAttribute>> | undefined {
	if (value === undefined) return undefined;
	if (value === null || typeof value !== 'object') {
		state.truncated = true;
		return undefined;
	}
	const budget = { units: MAX_ATTRIBUTE_UNITS };
	// Keys are redacted as values are, and their names are tested as logged.
	const walkKey = createKeyWalker(
		redactDiagnosticText,
		isSensitiveDiagnosticKey,
		MAX_ATTRIBUTE_KEY_BYTES,
	);
	const output = Object.create(null) as Record<string, DevtoolsEventAttribute>;
	try {
		if (Array.isArray(value)) {
			state.truncated = true;
			return undefined;
		}
		// Only the descriptors of the keys kept are read: reading every one, and
		// sorting every key, cost time in proportion to the object.
		const keys = Object.keys(value);
		budget.units -= keys.length * VALUE_UNITS;
		if (keys.length > MAX_ATTRIBUTE_COUNT) state.truncated = true;
		for (const rawKey of keys.slice(0, MAX_ATTRIBUTE_COUNT)) {
			const descriptor = Object.getOwnPropertyDescriptor(value, rawKey);
			const name = rawKey.trim();
			if (!descriptor || !name) {
				state.truncated = true;
				continue;
			}
			// Keys that trimming, redaction or the cut make equal are numbered, not
			// dropped. Trimming sets no flag, so a key stored under a name that
			// redaction did not give it marks the event truncated, as dropping it
			// did.
			const stored = walkKey(name, output, budget);
			if (stored.redacted) state.redacted = true;
			if (stored.truncated || (!stored.redacted && stored.key !== name)) {
				state.truncated = true;
			}
			if (stored.omitted) {
				output[stored.key] = VALUE_OMITTED;
				continue;
			}
			if (stored.sensitive) {
				state.redacted = true;
				output[stored.key] = '[REDACTED]';
				continue;
			}
			if (!('value' in descriptor)) {
				state.truncated = true;
				continue;
			}
			const rawValue = descriptor.value;
			if (typeof rawValue === 'string' && budget.units <= 0) {
				state.truncated = true;
				output[stored.key] = VALUE_OMITTED;
			} else if (typeof rawValue === 'string') {
				const text = safeText(
					rawValue,
					MAX_ATTRIBUTE_VALUE_BYTES,
					state,
					false,
					budget,
				);
				output[stored.key] = text ?? '';
			} else if (typeof rawValue === 'boolean') {
				output[stored.key] = rawValue;
			} else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
				output[stored.key] = rawValue;
			} else {
				// Nested data belongs to the owning collector and is represented by a
				// resource reference, never copied into the unified event envelope.
				state.truncated = true;
			}
		}
	} catch {
		// Proxies can reject listing or descriptor reads.
		state.truncated = true;
		return undefined;
	}
	// In key order, whatever order they were logged in.
	const keys = Object.keys(output).sort();
	if (keys.length === 0) return undefined;
	const sorted = Object.create(null) as Record<string, DevtoolsEventAttribute>;
	for (const key of keys) sorted[key] = output[key] as DevtoolsEventAttribute;
	return Object.freeze(sorted);
}

export function normalizeDevtoolsEventInput(
	input: DevtoolsEventInput,
	now: () => number,
): NormalizedDevtoolsEventInput | null {
	const descriptors = dataProperties(input);
	if (!descriptors) return null;
	const state: NormalizationState = { redacted: false, truncated: false };
	if (
		Object.entries(descriptors).some(
			([key, descriptor]) => descriptor.enumerable && !INPUT_FIELDS.has(key),
		)
	) {
		state.truncated = true;
	}
	const source = safeText(
		dataValue(descriptors, 'source'),
		MAX_IDENTIFIER_BYTES,
		state,
		true,
	);
	const kind = safeText(
		dataValue(descriptors, 'kind'),
		MAX_IDENTIFIER_BYTES,
		state,
		true,
	);
	const title = safeText(
		dataValue(descriptors, 'title'),
		MAX_TITLE_BYTES,
		state,
		true,
	);
	if (!source || !kind || !title) return null;

	const rawLevel = dataValue(descriptors, 'level');
	const level = rawLevel === undefined ? 'info' : rawLevel;
	if (typeof level !== 'string' || !LEVELS.has(level as DevtoolsEventLevel)) {
		return null;
	}
	const rawTimestamp = dataValue(descriptors, 'at');
	const candidateTimestamp = rawTimestamp === undefined ? now() : rawTimestamp;
	let at: number;
	if (isValidTimestamp(candidateTimestamp)) {
		at = candidateTimestamp;
	} else {
		const fallbackTimestamp = now();
		if (!isValidTimestamp(fallbackTimestamp)) return null;
		at = fallbackTimestamp;
		state.truncated = true;
	}

	const summaryValue = dataValue(descriptors, 'summary');
	const summary = safeText(summaryValue, MAX_SUMMARY_BYTES, state);
	if (summaryValue !== undefined && summary === undefined)
		state.truncated = true;
	const correlationValue = dataValue(descriptors, 'correlationId');
	const correlationId = safeText(
		correlationValue,
		MAX_IDENTIFIER_BYTES,
		state,
		true,
	);
	if (correlationValue !== undefined && !correlationId) state.truncated = true;
	const parentValue = dataValue(descriptors, 'parentEventId');
	const parentEventId = safeText(
		parentValue,
		MAX_IDENTIFIER_BYTES,
		state,
		true,
	);
	if (parentValue !== undefined && !parentEventId) state.truncated = true;
	const resourceRef = normalizeResourceRef(
		dataValue(descriptors, 'resourceRef'),
		state,
	);
	const attributes = normalizeAttributes(
		dataValue(descriptors, 'attributes'),
		state,
	);

	return {
		at,
		source,
		kind,
		level: level as DevtoolsEventLevel,
		title,
		...(summary ? { summary } : {}),
		...(correlationId ? { correlationId } : {}),
		...(parentEventId ? { parentEventId } : {}),
		...(resourceRef ? { resourceRef } : {}),
		...(attributes ? { attributes } : {}),
		redacted: state.redacted,
		truncated: state.truncated,
	};
}

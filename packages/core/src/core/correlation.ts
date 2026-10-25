import type { DevtoolsEvent, DevtoolsEventInput } from '../events/types';

const MAX_CORRELATION_ID_LENGTH = 512;
const MAX_INFERENCE_WINDOW_MS = 60_000;

export type DevToolsCorrelationRelation = 'explicit' | 'inferred';

export type DevToolsCorrelationScope = Readonly<{
	id: string;
	relation: DevToolsCorrelationRelation;
	startedAt: number;
	parentEventId?: string;
	evidenceEventId?: string;
}>;

export type DevToolsCorrelationInferenceOptions = Readonly<{
	at: number;
	windowMs: number;
	source?: string;
}>;

function safeId(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const id = value.trim();
	return id &&
		id.length <= MAX_CORRELATION_ID_LENGTH &&
		/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)
		? id
		: null;
}

function safeTimestamp(value: number): boolean {
	return Number.isFinite(value) && value >= 0;
}

export function createDevToolsCorrelationScope(options: {
	id: string;
	startedAt: number;
	parentEventId?: string;
}): DevToolsCorrelationScope {
	const id = safeId(options.id);
	const parentEventId =
		options.parentEventId === undefined
			? undefined
			: safeId(options.parentEventId);
	if (!id || !safeTimestamp(options.startedAt) || parentEventId === null) {
		throw new Error('Invalid explicit correlation scope.');
	}
	return Object.freeze({
		id,
		relation: 'explicit',
		startedAt: options.startedAt,
		...(parentEventId ? { parentEventId } : {}),
	});
}

/**
 * Infers only from a prior explicitly correlated event inside a small bounded
 * window. The returned scope is permanently labelled inferred so callers can
 * never present temporal proximity as causal fact.
 */
export function inferDevToolsCorrelationScope(
	events: readonly DevtoolsEvent[],
	options: DevToolsCorrelationInferenceOptions,
): DevToolsCorrelationScope | null {
	if (
		!Array.isArray(events) ||
		!safeTimestamp(options.at) ||
		!Number.isFinite(options.windowMs) ||
		options.windowMs < 0 ||
		options.windowMs > MAX_INFERENCE_WINDOW_MS
	) {
		throw new Error('Invalid correlation inference options.');
	}
	let candidate: DevtoolsEvent | undefined;
	for (const event of events) {
		if (
			!event.correlationId ||
			event.at > options.at ||
			options.at - event.at > options.windowMs ||
			(options.source !== undefined && event.source !== options.source)
		) {
			continue;
		}
		if (
			!candidate ||
			event.at > candidate.at ||
			(event.at === candidate.at && event.sequence > candidate.sequence)
		) {
			candidate = event;
		}
	}
	if (!candidate) return null;
	const id = safeId(candidate.correlationId);
	const evidenceEventId = safeId(candidate.id);
	if (!id || !evidenceEventId) return null;
	return Object.freeze({
		id,
		relation: 'inferred',
		startedAt: options.at,
		parentEventId: evidenceEventId,
		evidenceEventId,
	});
}

export function correlateDevToolsEvent(
	event: DevtoolsEventInput,
	scope: DevToolsCorrelationScope,
): DevtoolsEventInput {
	const attributes = Object.freeze({
		...event.attributes,
		'correlation.relation': scope.relation,
		...(scope.evidenceEventId
			? { 'correlation.evidenceEventId': scope.evidenceEventId }
			: {}),
	});
	return Object.freeze({
		...event,
		correlationId: scope.id,
		...(scope.parentEventId ? { parentEventId: scope.parentEventId } : {}),
		attributes,
	});
}

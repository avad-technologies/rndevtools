import { exportDevtoolsEvents } from '../events/exporters';
import { normalizeDevtoolsEventInput } from '../events/normalize';
import {
	DEVTOOLS_EVENT_VERSION,
	type DevtoolsEvent,
	type DevtoolsEventExportOptions,
	type DevtoolsEventExportResult,
	type DevtoolsEventInput,
	type DevtoolsEventStoreCounters,
	type DevtoolsEventStoreSnapshot,
} from '../events/types';
import { redactDiagnosticText } from './redact';
import { utf8ByteLength } from './serialize';

type Listener = () => void;
type IdKind = 'correlation' | 'event';
const MAX_EVENT_ID_CODE_UNITS = 512;

export type DevtoolsEventStoreOptions = Readonly<{
	maxEvents: number;
	maxBytes: number;
	maxEventBytes?: number;
	maxExportBytes?: number;
	enabled?: boolean;
	now?: () => number;
	idFactory?: (kind: IdKind, sequence: number) => string;
	/** Optional host projection. Built-in redaction and bounds always run after it. */
	sanitize?: (input: DevtoolsEventInput) => DevtoolsEventInput | null;
}>;

export type DevtoolsEventAppendResult =
	| Readonly<{ status: 'accepted'; event: DevtoolsEvent }>
	| Readonly<{
			status: 'dropped';
			reason: 'invalid' | 'oversized' | 'sanitizer';
	  }>
	| Readonly<{ status: 'disabled' | 'disposed' }>;

let nextStoreInstance = 1;
let nextStoreSessionNamespace = 1;

function createOpaqueSessionNamespace(): string {
	const sequence = nextStoreSessionNamespace;
	nextStoreSessionNamespace += 1;
	try {
		const candidate = globalThis.crypto?.randomUUID?.();
		if (
			typeof candidate === 'string' &&
			/^[A-Za-z0-9-]{1,64}$/.test(candidate)
		) {
			return candidate;
		}
	} catch {
		// The monotonic fallback still prevents identifier reuse on older runtimes.
	}
	const mixed = Math.imul(sequence ^ 0x6d2b79f5, 0x5bd1e995) >>> 0;
	return `fallback-${mixed.toString(36)}-${Date.now().toString(36)}`;
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	return value;
}

function emptyCounters(): DevtoolsEventStoreCounters {
	return Object.freeze({
		accepted: 0,
		dropped: 0,
		evicted: 0,
		redacted: 0,
		truncated: 0,
	});
}

export class DevtoolsEventStore {
	readonly #listeners = new Set<Listener>();
	readonly #maxEvents: number;
	readonly #maxBytes: number;
	readonly #maxEventBytes: number;
	readonly #maxExportBytes: number;
	#now: () => number;
	#idFactory?: (kind: IdKind, sequence: number) => string;
	#sanitize?: (input: DevtoolsEventInput) => DevtoolsEventInput | null;
	readonly #instanceId = nextStoreInstance++;
	#enabled: boolean;
	#disposed = false;
	#events: readonly DevtoolsEvent[] = Object.freeze([]);
	#sizes: readonly number[] = Object.freeze([]);
	#estimatedBytes = 0;
	#nextEventSequence = 1;
	#nextCorrelationSequence = 1;
	#sessionNamespace: string | undefined;
	#writeEpoch = 0;
	#counters: DevtoolsEventStoreCounters = emptyCounters();
	#snapshot: DevtoolsEventStoreSnapshot;

	constructor(options: DevtoolsEventStoreOptions) {
		this.#maxEvents = positiveInteger(options.maxEvents, 'maxEvents');
		this.#maxBytes = positiveInteger(options.maxBytes, 'maxBytes');
		this.#maxEventBytes = positiveInteger(
			options.maxEventBytes ?? this.#maxBytes,
			'maxEventBytes',
		);
		if (this.#maxEventBytes > this.#maxBytes) {
			throw new Error('maxEventBytes cannot exceed maxBytes');
		}
		this.#maxExportBytes = positiveInteger(
			options.maxExportBytes ?? this.#maxBytes,
			'maxExportBytes',
		);
		if (this.#maxExportBytes < 2) {
			throw new Error('maxExportBytes must be at least 2');
		}
		if (options.now !== undefined && typeof options.now !== 'function') {
			throw new Error('now must be a function');
		}
		if (
			options.idFactory !== undefined &&
			typeof options.idFactory !== 'function'
		) {
			throw new Error('idFactory must be a function');
		}
		if (
			options.sanitize !== undefined &&
			typeof options.sanitize !== 'function'
		) {
			throw new Error('sanitize must be a function');
		}
		if (options.enabled !== undefined && typeof options.enabled !== 'boolean') {
			throw new Error('enabled must be a boolean');
		}
		this.#now = options.now ?? Date.now;
		this.#idFactory = options.idFactory;
		this.#sanitize = options.sanitize;
		this.#enabled = options.enabled ?? true;
		this.#snapshot = this.#createSnapshot();
	}

	append(input: DevtoolsEventInput): DevtoolsEventAppendResult {
		if (this.#disposed) return Object.freeze({ status: 'disposed' });
		if (!this.#enabled) return Object.freeze({ status: 'disabled' });
		const writeEpoch = this.#writeEpoch;

		let candidate = input;
		if (this.#sanitize) {
			try {
				const sanitized = this.#sanitize(input);
				if (!sanitized) {
					return (
						this.#revokedAppendResult(writeEpoch) ?? this.#drop('sanitizer')
					);
				}
				candidate = sanitized;
			} catch {
				return this.#revokedAppendResult(writeEpoch) ?? this.#drop('sanitizer');
			}
		}
		let normalized: ReturnType<typeof normalizeDevtoolsEventInput>;
		try {
			normalized = normalizeDevtoolsEventInput(candidate, this.#now);
		} catch {
			return this.#revokedAppendResult(writeEpoch) ?? this.#drop('invalid');
		}
		if (!normalized) {
			return this.#revokedAppendResult(writeEpoch) ?? this.#drop('invalid');
		}

		const sequence = this.#nextEventSequence;
		const event = Object.freeze({
			version: DEVTOOLS_EVENT_VERSION,
			id: this.#createId('event', sequence),
			at: normalized.at,
			sequence,
			source: normalized.source,
			kind: normalized.kind,
			level: normalized.level,
			title: normalized.title,
			...(normalized.summary ? { summary: normalized.summary } : {}),
			...(normalized.correlationId
				? { correlationId: normalized.correlationId }
				: {}),
			...(normalized.parentEventId
				? { parentEventId: normalized.parentEventId }
				: {}),
			...(normalized.resourceRef
				? { resourceRef: normalized.resourceRef }
				: {}),
			...(normalized.attributes ? { attributes: normalized.attributes } : {}),
			redacted: normalized.redacted,
			truncated: normalized.truncated,
		}) satisfies DevtoolsEvent;
		const eventBytes = utf8ByteLength(JSON.stringify(event));
		const revoked = this.#revokedAppendResult(writeEpoch);
		if (revoked) return revoked;
		if (eventBytes > this.#maxEventBytes || eventBytes > this.#maxBytes) {
			return this.#drop('oversized');
		}

		const events = [...this.#events, event];
		const sizes = [...this.#sizes, eventBytes];
		let estimatedBytes = this.#estimatedBytes + eventBytes;
		let evicted = 0;
		while (events.length > this.#maxEvents || estimatedBytes > this.#maxBytes) {
			events.shift();
			estimatedBytes -= sizes.shift() ?? 0;
			evicted += 1;
		}
		this.#events = Object.freeze(events);
		this.#sizes = Object.freeze(sizes);
		this.#estimatedBytes = estimatedBytes;
		this.#nextEventSequence += 1;
		this.#counters = Object.freeze({
			accepted: this.#counters.accepted + 1,
			dropped: this.#counters.dropped + evicted,
			evicted: this.#counters.evicted + evicted,
			redacted: this.#counters.redacted + (event.redacted ? 1 : 0),
			truncated: this.#counters.truncated + (event.truncated ? 1 : 0),
		});
		this.#publish();
		return Object.freeze({ status: 'accepted', event });
	}

	createCorrelationId(): string {
		const sequence = this.#nextCorrelationSequence;
		this.#nextCorrelationSequence += 1;
		return this.#createId('correlation', sequence);
	}

	setEnabled(enabled: boolean): void {
		if (typeof enabled !== 'boolean') {
			throw new Error('enabled must be a boolean');
		}
		if (this.#disposed || this.#enabled === enabled) return;
		this.#writeEpoch += 1;
		this.#enabled = enabled;
		this.#publish();
	}

	clear = (): void => {
		if (this.#disposed || this.#events.length === 0) return;
		this.#events = Object.freeze([]);
		this.#sizes = Object.freeze([]);
		this.#estimatedBytes = 0;
		this.#publish();
	};

	/**
	 * Starts a fresh host-owned authority session while retaining store policy and
	 * subscribers. Unlike `clear`, this intentionally resets identifiers and
	 * counters so a replacement owner cannot infer the previous session's volume.
	 */
	resetSession = (): void => {
		if (this.#disposed) return;
		this.#writeEpoch += 1;
		this.#events = Object.freeze([]);
		this.#sizes = Object.freeze([]);
		this.#estimatedBytes = 0;
		this.#nextEventSequence = 1;
		this.#nextCorrelationSequence = 1;
		this.#sessionNamespace = createOpaqueSessionNamespace();
		this.#counters = emptyCounters();
		this.#publish();
	};

	removeEvents = (eventIds: readonly string[]): void => {
		if (this.#disposed || eventIds.length === 0 || this.#events.length === 0) {
			return;
		}
		if (eventIds.length > this.#maxEvents) {
			throw new Error('eventIds cannot exceed the configured event limit');
		}
		const ids = new Set(eventIds);
		const events: DevtoolsEvent[] = [];
		const sizes: number[] = [];
		let estimatedBytes = 0;
		for (let index = 0; index < this.#events.length; index += 1) {
			const event = this.#events[index];
			if (!event || ids.has(event.id)) continue;
			const size = this.#sizes[index] ?? 0;
			events.push(event);
			sizes.push(size);
			estimatedBytes += size;
		}
		if (events.length === this.#events.length) return;
		this.#events = Object.freeze(events);
		this.#sizes = Object.freeze(sizes);
		this.#estimatedBytes = estimatedBytes;
		this.#publish();
	};

	dispose = (): void => {
		if (this.#disposed) return;
		this.#writeEpoch += 1;
		this.#disposed = true;
		this.#enabled = false;
		this.#events = Object.freeze([]);
		this.#sizes = Object.freeze([]);
		this.#estimatedBytes = 0;
		this.#publish();
		this.#listeners.clear();
		this.#sanitize = undefined;
		this.#idFactory = undefined;
		this.#now = Date.now;
	};

	exportEvents(options: DevtoolsEventExportOptions): DevtoolsEventExportResult {
		const requestedMaxBytes = options.maxBytes ?? this.#maxExportBytes;
		positiveInteger(requestedMaxBytes, 'maxBytes');
		return exportDevtoolsEvents(this.#events, {
			format: options.format,
			maxBytes: Math.min(requestedMaxBytes, this.#maxExportBytes),
			...(options.maxEvents === undefined
				? {}
				: { maxEvents: options.maxEvents }),
		});
	}

	getSnapshot = (): DevtoolsEventStoreSnapshot => this.#snapshot;

	getServerSnapshot = (): DevtoolsEventStoreSnapshot => this.#snapshot;

	getEvents = (): readonly DevtoolsEvent[] => this.#events;

	getEstimatedBytes = (): number => this.#estimatedBytes;

	subscribe = (listener: Listener): (() => void) => {
		if (this.#disposed) return () => {};
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	#drop(
		reason: 'invalid' | 'oversized' | 'sanitizer',
	): DevtoolsEventAppendResult {
		this.#counters = Object.freeze({
			...this.#counters,
			dropped: this.#counters.dropped + 1,
		});
		this.#publish();
		return Object.freeze({ status: 'dropped', reason });
	}

	#revokedAppendResult(
		writeEpoch: number,
	): DevtoolsEventAppendResult | undefined {
		if (this.#disposed) return Object.freeze({ status: 'disposed' });
		if (!this.#enabled || this.#writeEpoch !== writeEpoch) {
			return Object.freeze({ status: 'disabled' });
		}
		return undefined;
	}

	#createId(kind: IdKind, sequence: number): string {
		// Bind identity provenance before a host factory can reenter resetSession.
		const namespace = this.#sessionNamespace ?? 'initial';
		let candidate: unknown;
		try {
			candidate = this.#idFactory?.(kind, sequence);
		} catch {
			// A diagnostics ID provider must never interrupt the host application.
		}
		const uniqueSuffix = `:${kind}:${this.#instanceId}:${namespace}:${sequence}`;
		if (
			typeof candidate === 'string' &&
			candidate.length <= MAX_EVENT_ID_CODE_UNITS
		) {
			const trimmed = candidate.trim();
			const namespaced = `${trimmed}${uniqueSuffix}`;
			if (trimmed && namespaced.length <= MAX_EVENT_ID_CODE_UNITS) {
				const redacted = redactDiagnosticText(namespaced);
				if (redacted === namespaced) return namespaced;
			}
		}
		return `devtools:${kind}:${this.#instanceId}:${namespace}:${sequence}`;
	}

	#createSnapshot(): DevtoolsEventStoreSnapshot {
		return Object.freeze({
			version: DEVTOOLS_EVENT_VERSION,
			enabled: this.#enabled,
			disposed: this.#disposed,
			events: this.#events,
			estimatedBytes: this.#estimatedBytes,
			counters: this.#counters,
		});
	}

	#publish(): void {
		this.#snapshot = this.#createSnapshot();
		for (const listener of [...this.#listeners]) {
			try {
				listener();
			} catch {
				// A diagnostics observer must never interrupt the instrumented app.
			}
		}
	}
}

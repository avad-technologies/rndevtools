export const DEVTOOLS_EVENT_VERSION = 1 as const;

export type DevtoolsEventLevel = 'debug' | 'info' | 'warn' | 'error';

export type DevtoolsEventAttribute = string | number | boolean;

export type DevtoolsEventResourceRef = Readonly<{
	toolId: string;
	resourceId: string;
}>;

/**
 * A small, transport-safe timeline entry. Collector-owned detail stays behind
 * `resourceRef`; the envelope intentionally has no arbitrary payload field.
 */
export type DevtoolsEvent = Readonly<{
	version: typeof DEVTOOLS_EVENT_VERSION;
	id: string;
	at: number;
	sequence: number;
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

export type DevtoolsEventInput = Readonly<{
	at?: number;
	source: string;
	kind: string;
	level?: DevtoolsEventLevel;
	title: string;
	summary?: string;
	correlationId?: string;
	parentEventId?: string;
	resourceRef?: DevtoolsEventResourceRef;
	attributes?: Readonly<Record<string, DevtoolsEventAttribute>>;
}>;

export type DevtoolsEventStoreCounters = Readonly<{
	accepted: number;
	dropped: number;
	evicted: number;
	redacted: number;
	truncated: number;
}>;

export type DevtoolsEventStoreSnapshot = Readonly<{
	version: typeof DEVTOOLS_EVENT_VERSION;
	enabled: boolean;
	disposed: boolean;
	events: readonly DevtoolsEvent[];
	estimatedBytes: number;
	counters: DevtoolsEventStoreCounters;
}>;

export type DevtoolsEventExportFormat =
	| 'bug-report'
	| 'errors-only'
	| 'json'
	| 'markdown'
	| 'mermaid'
	| 'ndjson';

export type DevtoolsEventExportOptions = Readonly<{
	format: DevtoolsEventExportFormat;
	maxBytes?: number;
	maxEvents?: number;
}>;

export type DevtoolsEventExportResult = Readonly<{
	format: DevtoolsEventExportFormat;
	text: string;
	estimatedBytes: number;
	eventCount: number;
	omittedEvents: number;
	truncated: boolean;
}>;

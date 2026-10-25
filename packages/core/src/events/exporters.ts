import { sanitizeDiagnosticValueWithMetadata } from '../core/redact';
import { utf8ByteLength } from '../core/serialize';
import type {
	DevtoolsEvent,
	DevtoolsEventExportFormat,
	DevtoolsEventExportResult,
} from './types';

const MAX_EXPORT_EVENTS = 10_000;

export type BoundedDevtoolsEventExportOptions = Readonly<{
	format: DevtoolsEventExportFormat;
	maxBytes: number;
	maxEvents?: number;
}>;

function assertExportOptions(options: BoundedDevtoolsEventExportOptions): void {
	if (
		options.format !== 'bug-report' &&
		options.format !== 'errors-only' &&
		options.format !== 'json' &&
		options.format !== 'markdown' &&
		options.format !== 'mermaid' &&
		options.format !== 'ndjson'
	) {
		throw new Error(
			'format must be bug-report, errors-only, json, markdown, mermaid, or ndjson',
		);
	}
	if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
		throw new Error('maxBytes must be a positive integer');
	}
	if (options.format === 'json' && options.maxBytes < 2) {
		throw new Error('JSON exports require at least 2 bytes');
	}
	if (
		options.maxEvents !== undefined &&
		(!Number.isSafeInteger(options.maxEvents) || options.maxEvents <= 0)
	) {
		throw new Error('maxEvents must be a positive integer');
	}
}

function sanitizedEvent(event: DevtoolsEvent): DevtoolsEvent | null {
	const text = serializeForExport(event);
	if (text === null) return null;
	try {
		const parsed: unknown = JSON.parse(text);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as DevtoolsEvent)
			: null;
	} catch {
		return null;
	}
}

function markdownCell(value: unknown): string {
	return String(value ?? '')
		.replace(/\\/g, '\\\\')
		.replace(/\|/g, '\\|')
		.replace(/[\r\n]+/g, ' ')
		.trim();
}

function markdownRow(event: DevtoolsEvent): string {
	const detail = [event.title, event.summary].filter(Boolean).join(' — ');
	return `| ${markdownCell(new Date(event.at).toISOString())} | ${markdownCell(event.level)} | ${markdownCell(event.source)} | ${markdownCell(event.kind)} | ${markdownCell(detail)} | ${markdownCell(event.correlationId)} |`;
}

function mermaidActor(source: string): string {
	const normalized = source.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 48);
	return normalized ? `source_${normalized}` : 'source_unknown';
}

function mermaidText(event: DevtoolsEvent): string {
	return [event.level.toUpperCase(), event.kind, event.title, event.summary]
		.filter(Boolean)
		.join(' · ')
		.replace(/[\r\n:;#]/g, ' ')
		.replace(/[^\x20-\x7E]/g, '?')
		.trim();
}

type TextFormat = Exclude<DevtoolsEventExportFormat, 'json' | 'ndjson'>;

function textEnvelope(
	format: TextFormat,
	events: readonly DevtoolsEvent[],
): { prefix: string; suffix: string; row: (event: DevtoolsEvent) => string } {
	if (format === 'mermaid') {
		return {
			prefix: 'sequenceDiagram\n    participant Timeline',
			suffix: '',
			row: (event) =>
				`    Timeline->>${mermaidActor(event.source)}: ${mermaidText(event)}`,
		};
	}
	const counts = { debug: 0, info: 0, warn: 0, error: 0 };
	for (const event of events) counts[event.level] += 1;
	const title =
		format === 'bug-report'
			? '# RN Devtools Bug Report'
			: format === 'errors-only'
				? '# RN Devtools Errors'
				: '# RN Devtools Events';
	const summary =
		format === 'bug-report'
			? `\n\nEvents: ${events.length} | Errors: ${counts.error} | Warnings: ${counts.warn}`
			: '';
	return {
		prefix: `${title}${summary}\n\n| Time | Level | Source | Kind | Event | Correlation |\n| --- | --- | --- | --- | --- | --- |`,
		suffix: '',
		row: markdownRow,
	};
}

function exportTextEvents(
	events: readonly DevtoolsEvent[],
	options: BoundedDevtoolsEventExportOptions,
	baseOmitted: number,
): DevtoolsEventExportResult {
	const format = options.format as TextFormat;
	const sanitized = events
		.map(sanitizedEvent)
		.filter((event): event is DevtoolsEvent => event !== null);
	let omittedEvents = baseOmitted + events.length - sanitized.length;
	const filtered =
		format === 'errors-only'
			? sanitized.filter((event) => event.level === 'error')
			: sanitized;
	omittedEvents += sanitized.length - filtered.length;
	const envelope = textEnvelope(format, filtered);
	const envelopeBytes = utf8ByteLength(envelope.prefix + envelope.suffix);
	if (envelopeBytes > options.maxBytes) {
		throw new Error(
			`${format} exports require at least ${envelopeBytes} bytes`,
		);
	}
	const rows: string[] = [];
	let estimatedBytes = envelopeBytes;
	for (let index = filtered.length - 1; index >= 0; index -= 1) {
		const event = filtered[index];
		if (!event) continue;
		const row = envelope.row(event);
		const rowBytes = 1 + utf8ByteLength(row);
		if (estimatedBytes + rowBytes > options.maxBytes) {
			omittedEvents += 1;
			continue;
		}
		rows.unshift(row);
		estimatedBytes += rowBytes;
	}
	const text = `${envelope.prefix}${rows.length ? `\n${rows.join('\n')}` : ''}${envelope.suffix}`;
	return Object.freeze({
		format,
		text,
		estimatedBytes: utf8ByteLength(text),
		eventCount: rows.length,
		omittedEvents,
		truncated: omittedEvents > 0,
	});
}

function serializeForExport(event: DevtoolsEvent): string | null {
	try {
		const projection = sanitizeDiagnosticValueWithMetadata(event);
		if (
			projection.value !== null &&
			typeof projection.value === 'object' &&
			!Array.isArray(projection.value)
		) {
			const envelope = projection.value as Record<string, unknown>;
			envelope.redacted = envelope.redacted === true || projection.redacted;
			envelope.truncated = envelope.truncated === true || projection.truncated;
		}
		const text = JSON.stringify(projection.value);
		return typeof text === 'string' ? text : null;
	} catch {
		return null;
	}
}

/**
 * Exports the newest complete events that fit, preserving chronological order.
 * No partial JSON object or NDJSON row is ever emitted.
 */
export function exportDevtoolsEvents(
	events: readonly DevtoolsEvent[],
	options: BoundedDevtoolsEventExportOptions,
): DevtoolsEventExportResult {
	assertExportOptions(options);
	const maxEvents = Math.min(
		options.maxEvents ?? MAX_EXPORT_EVENTS,
		MAX_EXPORT_EVENTS,
	);
	const candidates = events.slice(-maxEvents);
	let omittedEvents = events.length - candidates.length;
	if (options.format !== 'json' && options.format !== 'ndjson') {
		return exportTextEvents(candidates, options, omittedEvents);
	}
	const serialized: string[] = [];
	let estimatedBytes = options.format === 'json' ? 2 : 0;

	for (let index = candidates.length - 1; index >= 0; index -= 1) {
		const candidate = candidates[index];
		if (!candidate) continue;
		const text = serializeForExport(candidate);
		if (text === null) {
			omittedEvents += 1;
			continue;
		}
		const separatorBytes = serialized.length === 0 ? 0 : 1;
		const candidateBytes = utf8ByteLength(text);
		if (estimatedBytes + separatorBytes + candidateBytes > options.maxBytes) {
			omittedEvents += 1;
			continue;
		}
		serialized.unshift(text);
		estimatedBytes += separatorBytes + candidateBytes;
	}

	const text =
		options.format === 'json'
			? `[${serialized.join(',')}]`
			: serialized.join('\n');
	return Object.freeze({
		format: options.format,
		text,
		estimatedBytes,
		eventCount: serialized.length,
		omittedEvents,
		truncated: omittedEvents > 0,
	});
}

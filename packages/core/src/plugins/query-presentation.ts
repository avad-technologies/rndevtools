import { iosColor } from '../components/panel-shell';
import {
	diagnosticErrorText,
	redactDiagnosticText,
	sanitizeDiagnosticValue,
} from '../core/redact';
import { serializeValue } from '../core/serialize';
import type { DevToolsActionConfirmation } from '../types';
import type { QuerySnapshot } from './query-model';

export type InspectorTab = 'queries' | 'mutations';
export type QueryStatusKind = 'error' | 'fetching' | 'stale' | 'fresh';
export type RunQueryAction = (
	label: string,
	action: () => unknown | Promise<unknown>,
	confirmation?: DevToolsActionConfirmation,
) => void;

export const palette = {
	blue: iosColor('systemBlueColor', '#007AFF'),
	gray: iosColor('systemGrayColor', '#8E8E93'),
	green: iosColor('systemGreenColor', '#34C759'),
	orange: iosColor('systemOrangeColor', '#FF9500'),
	red: iosColor('systemRedColor', '#FF3B30'),
	secondary: iosColor('secondaryLabelColor', 'rgba(60,60,67,0.6)'),
};

export const statusDotColors = {
	error: palette.red,
	fetching: palette.blue,
	fresh: palette.green,
	stale: palette.orange,
};

export const statusLabels: Record<QueryStatusKind, string> = {
	error: 'error',
	fetching: 'fetching…',
	fresh: 'fresh',
	stale: 'stale',
};

export function queryStatusKind(
	query: Pick<QuerySnapshot, 'fetchStatus' | 'isStale' | 'status'>,
): QueryStatusKind {
	if (query.status === 'error') return 'error';
	if (query.fetchStatus === 'fetching' || query.status === 'pending') {
		return 'fetching';
	}
	if (query.isStale) return 'stale';
	return 'fresh';
}

export function mutationDotColor(status: string) {
	if (status === 'error') return palette.red;
	if (status === 'pending') return palette.blue;
	if (status === 'success') return palette.green;
	return palette.gray;
}

function formatQueryKeySegment(part: unknown): string {
	const sanitized = sanitizeDiagnosticValue(part);
	if (typeof sanitized === 'string') return sanitized;
	if (
		typeof sanitized === 'number' ||
		typeof sanitized === 'boolean' ||
		typeof sanitized === 'bigint'
	) {
		return String(sanitized);
	}
	return serializeValue(sanitized, 256).text.replace(/\s+/g, ' ');
}

function readableQueryKeySegments(
	queryKey: readonly unknown[] | undefined,
): readonly unknown[] {
	let descriptors: Record<string, PropertyDescriptor>;
	try {
		if (!Array.isArray(queryKey)) return [];
		descriptors = Object.getOwnPropertyDescriptors(queryKey);
	} catch {
		return [];
	}
	const lengthDescriptor = descriptors.length;
	const length =
		lengthDescriptor &&
		'value' in lengthDescriptor &&
		Number.isSafeInteger(lengthDescriptor.value) &&
		lengthDescriptor.value >= 0
			? Math.min(lengthDescriptor.value, 32)
			: 0;
	const segments: unknown[] = [];
	for (let index = 0; index < length; index += 1) {
		const descriptor = descriptors[String(index)];
		if (descriptor && 'value' in descriptor) segments.push(descriptor.value);
	}
	return segments;
}

export function formatQueryKey(
	queryKey: readonly unknown[] | undefined,
): string {
	const segments = readableQueryKeySegments(queryKey);
	if (segments.length === 0) return 'Anonymous mutation';
	return segments.map(formatQueryKeySegment).join(' › ');
}

/** Row title: every key segment after the grouping segment, ' · ' joined. */
export function formatQueryKeyRemainder(
	queryKey: readonly unknown[] | undefined,
): string {
	const [root, ...rest] = readableQueryKeySegments(queryKey);
	if (rest.length > 0) return rest.map(formatQueryKeySegment).join(' · ');
	return formatQueryKeySegment(root);
}

export function groupQueriesByRoot(
	queries: readonly QuerySnapshot[],
): ReadonlyArray<{ segment: string; queries: readonly QuerySnapshot[] }> {
	const groups = new Map<string, QuerySnapshot[]>();
	for (const query of queries) {
		const segment = query.keySegments[0] ?? 'Anonymous query';
		const group = groups.get(segment);
		if (group) group.push(query);
		else groups.set(segment, [query]);
	}
	return [...groups.entries()].map(([segment, grouped]) => ({
		segment,
		queries: grouped,
	}));
}

function firstLine(text: string): string {
	const index = text.indexOf('\n');
	return index === -1 ? text : text.slice(0, index);
}

function describeLiveError(error: unknown): string | undefined {
	if (error instanceof Error) {
		return `Error: ${diagnosticErrorText(error)}`;
	}
	if (typeof error === 'string' && error) return redactDiagnosticText(error);
	return undefined;
}

/** One-line error summary from the live error, else its serialized snapshot. */
export function summarizeError(
	serialized: string | undefined,
	liveError: unknown,
): string | undefined {
	const live = describeLiveError(liveError);
	if (live) return firstLine(live);
	if (!serialized) return undefined;
	try {
		const parsed: unknown = JSON.parse(serialized);
		if (parsed && typeof parsed === 'object') {
			const record = parsed as { message?: unknown; name?: unknown };
			const name =
				typeof record.name === 'string'
					? redactDiagnosticText(record.name)
					: undefined;
			const message =
				typeof record.message === 'string'
					? redactDiagnosticText(record.message)
					: undefined;
			const joined = [name, message].filter(Boolean).join(': ');
			if (joined) return firstLine(joined);
		}
	} catch {
		// Not JSON (for example truncated); fall through to the raw text.
	}
	return firstLine(redactDiagnosticText(serialized));
}

export function formatTimestamp(timestamp: number): string {
	if (!timestamp) return 'Never';
	if (
		!Number.isFinite(timestamp) ||
		Math.abs(timestamp) > 8_640_000_000_000_000
	) {
		return 'Invalid timestamp';
	}
	return new Date(timestamp).toISOString();
}

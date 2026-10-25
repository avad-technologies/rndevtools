import {
	isSensitiveDiagnosticKey,
	redactDiagnosticText,
} from '@rndevtools/core/redact';
import { truncateText, utf8ByteLength } from '@rndevtools/core/serialize';

const MAX_HEADER_COUNT = 200;
const MAX_HEADER_NAME_BYTES = 256;
const MAX_LONG_TEXT_BYTES = 512 * 1024;
const SAFE_QUERY_FAMILY = /^[a-z][a-z0-9._:-]{0,127}$/i;

/** Stable, non-sensitive identifier that always fits the desktop wire schema. */
export function desktopProjectionId(prefix: string, value: string): string {
	let fnvHash = 2_166_136_261;
	let mixedHash = 5381;
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		fnvHash ^= codeUnit;
		fnvHash = Math.imul(fnvHash, 16_777_619);
		mixedHash = Math.imul(mixedHash, 33) ^ codeUnit;
	}
	const safePrefix =
		prefix.replace(/[^a-z0-9_-]/gi, '-').slice(0, 32) || 'item';
	return `${safePrefix}-${(fnvHash >>> 0).toString(36)}-${(mixedHash >>> 0).toString(36)}`;
}

export function projectDesktopHeaders(
	headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const projected = Object.create(null) as Record<string, string>;
	let projectedCount = 0;
	for (const name of Object.keys(headers)) {
		if (projectedCount >= MAX_HEADER_COUNT) break;
		if (!name || utf8ByteLength(name) > MAX_HEADER_NAME_BYTES) continue;
		const value = headers[name];
		if (typeof value !== 'string') continue;
		const safeValue = isSensitiveDiagnosticKey(name)
			? '[REDACTED]'
			: redactDiagnosticText(value);
		projected[name] = truncateText(safeValue, MAX_LONG_TEXT_BYTES).text;
		projectedCount += 1;
	}
	return projected;
}

/**
 * Desktop snapshots expose only a query family, never raw key parameters.
 * Query keys routinely contain account IDs, search strings, and record IDs;
 * the session-local query ID remains available for targeted actions.
 */
export function projectDesktopQueryKey(
	segments: readonly string[],
	fallback: 'query' | 'mutation',
): string {
	const candidate = segments[0]?.trim();
	const family =
		candidate && SAFE_QUERY_FAMILY.test(candidate)
			? candidate
			: `anonymous ${fallback}`;
	const omittedParameters = Math.max(0, segments.length - 1);
	return omittedParameters === 0
		? family
		: `${family} · ${omittedParameters} parameter${omittedParameters === 1 ? '' : 's'} omitted`;
}

export function limitDesktopProjection<T>(
	values: readonly T[],
	options: { maxItems: number; maxBytes: number; keepNewest?: boolean },
): { items: readonly T[]; omitted: number } {
	const candidates = options.keepNewest ? [...values].reverse() : values;
	const retained: T[] = [];
	let retainedBytes = 2;
	for (const value of candidates) {
		if (retained.length >= options.maxItems) break;
		let serialized: string | undefined;
		try {
			serialized = JSON.stringify(value);
		} catch {
			continue;
		}
		if (serialized === undefined) continue;
		const valueBytes =
			utf8ByteLength(serialized) + (retained.length > 0 ? 1 : 0);
		if (retainedBytes + valueBytes > options.maxBytes) continue;
		retained.push(value);
		retainedBytes += valueBytes;
	}
	if (options.keepNewest) retained.reverse();
	return { items: retained, omitted: values.length - retained.length };
}

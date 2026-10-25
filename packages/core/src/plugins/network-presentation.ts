import { formatDuration as formatNetworkDuration } from '../core/format';
import { redactDiagnosticText } from '../core/redact';
import { truncateText, utf8ByteLength } from '../core/serialize';
import {
	defaultRedactBody,
	defaultRedactFormBody,
	defaultRedactHeader,
	defaultRedactUrl,
	formatNetworkBytes,
	headerNameRequiresRedaction,
	isTextualNetworkContentType,
	type NetworkCacheStatus,
	type NetworkEvent,
	parseNetworkUrl,
} from './network-capture';

export type NetworkSegment = 'all' | 'supabase' | 'errors' | 'slow';

/**
 * The fields request classification actually needs. The on-device `NetworkEvent`
 * and the desktop wire `NetworkEntry` both satisfy this, so both surfaces can
 * share one set of rules instead of each re-deriving them and drifting.
 */
export type ClassifiableNetworkRequest = {
	url: string;
	state: NetworkEvent['state'];
	// Spelled with explicit `undefined` so the desktop's wire entries satisfy
	// this under `exactOptionalPropertyTypes`.
	status?: number | undefined;
	durationMs?: number | undefined;
};

export type NetworkStatusTone = 'success' | 'danger' | 'warning' | 'info';

export type CollapsedNetworkEvent = {
	event: NetworkEvent;
	count: number;
};

export const SLOW_REQUEST_MS = 1000;
export const MAX_BODY_PREVIEW_BYTES = 32 * 1024;
// Keep admission aligned with the bounded built-in redactor. Larger payloads
// must be rejected before allocating a clone/reader that can never be retained.
export const MAX_NETWORK_BODY_BYTES = 64 * 1024;
export const MAX_NETWORK_EVENTS = 10_000;
export const MAX_NETWORK_STORE_BYTES = 32 * 1024 * 1024;
export const MAX_NETWORK_CURL_EXPORT_BYTES = 64 * 1024;
const MAX_NETWORK_CURL_HEADERS = 100;
const MAX_NETWORK_CURL_METHOD_BYTES = 32;
const MAX_NETWORK_CURL_URL_BYTES = 16 * 1024;
const MAX_NETWORK_CURL_HEADER_NAME_BYTES = 1024;
const MAX_NETWORK_CURL_HEADER_VALUE_BYTES = 8 * 1024;
const MAX_NETWORK_CURL_BODY_BYTES = 32 * 1024;
/**
 * Stands in for a URL that cURL export leaves out. A release bundle keeps
 * string literals, so `rndevtools-verify-bundle` looks for this one to find
 * this module.
 */
const CURL_URL_OMITTED = '[URL omitted: export limit]';
const CURL_DERIVED_HEADERS = new Set([
	'content-length',
	'host',
	'transfer-encoding',
]);
/** Placeholders the collector writes in place of a captured secret. */
// Every marker the capture and projection layers can leave behind. Replay sends
// a real request built from the captured text, so anything the projection
// altered must block it: `[Depth limit]`, `[Circular]`, and `[Accessor
// omitted]` survive as literal JSON values, and entry-cap losses are announced
// by the explicit truncation trailer because they leave no in-band evidence.
const UNSAFE_REPLAY_MARKER =
	/(?:redacted|redaction failed|body omitted|binary body omitted|unreadable|formdata omitted|url omitted|truncated|capture cancelled|depth limit|circular|accessor omitted)/i;
export const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SUPABASE_PATH_PREFIXES = ['/rest/', '/functions/', '/storage/', '/auth/'];
const STORAGE_OBJECT_MODES = new Set([
	'authenticated',
	'copy',
	'info',
	'list',
	'move',
	'public',
	'sign',
	'upload',
]);

function hostParts(host: string): { hostname: string; port: number } {
	const lowered = host.toLowerCase();
	// `URL.host` brackets IPv6 authorities, so splitting on the first colon would
	// yield '[' as the hostname and lose the port entirely.
	const bracketed = /^\[(?<address>[^\]]*)\](?::(?<port>\d+))?$/.exec(lowered);
	if (bracketed?.groups) {
		const { address = '', port = '' } = bracketed.groups;
		return { hostname: address, port: Number(port) };
	}
	const separator = lowered.lastIndexOf(':');
	if (separator === -1) return { hostname: lowered, port: Number('') };
	return {
		hostname: lowered.slice(0, separator),
		port: Number(lowered.slice(separator + 1)),
	};
}

export function networkEventLabel(event: NetworkEvent): {
	label: string;
	sourceKind?: 'rest' | 'edge function' | 'storage' | 'auth';
} {
	const parsed = parseNetworkUrl(event.url);
	const segments = parsed.pathname.split('/').filter(Boolean);
	const last = segments.at(-1);
	if (segments[0] === 'rest') {
		return { label: segments[2] ?? last ?? 'rest', sourceKind: 'rest' };
	}
	if (segments[0] === 'functions') {
		return {
			label: segments[2] ?? last ?? 'functions',
			sourceKind: 'edge function',
		};
	}
	if (segments[0] === 'storage') {
		const objectIndex = segments.indexOf('object');
		let label = last ?? 'storage';
		if (objectIndex >= 0) {
			const mode = segments[objectIndex + 1];
			label =
				(STORAGE_OBJECT_MODES.has(mode ?? '')
					? segments[objectIndex + 2]
					: mode) ?? label;
		}
		return { label, sourceKind: 'storage' };
	}
	if (segments[0] === 'auth') {
		return { label: last ?? 'auth', sourceKind: 'auth' };
	}
	return { label: last || parsed.host || parsed.path };
}

export function isSupabaseNetworkEvent(
	event: ClassifiableNetworkRequest,
): boolean {
	const parsed = parseNetworkUrl(event.url);
	if (hostParts(parsed.host).hostname.includes('supabase')) return true;
	return SUPABASE_PATH_PREFIXES.some((prefix) =>
		parsed.pathname.startsWith(prefix),
	);
}

function isFailedNetworkEvent(event: ClassifiableNetworkRequest): boolean {
	return (
		event.state === 'error' ||
		event.state === 'aborted' ||
		(event.status ?? 0) >= 400
	);
}

function headerValue(
	headers: Readonly<Record<string, string>>,
	name: string,
): string | undefined {
	const needle = name.toLowerCase();
	for (const [candidate, value] of Object.entries(headers)) {
		if (candidate.toLowerCase() === needle) return value;
	}
	return undefined;
}

/** Derives only cache states evidenced by status or response headers. */
export function inferNetworkCacheStatus(
	status: number | undefined,
	headers: Readonly<Record<string, string>>,
): NetworkCacheStatus {
	if (status === 304) return 'revalidated';
	const vendorStatus = [
		headerValue(headers, 'cf-cache-status'),
		headerValue(headers, 'x-cache'),
		headerValue(headers, 'x-vercel-cache'),
	]
		.filter((value): value is string => value !== undefined)
		.join(' ')
		.toLowerCase();
	if (/\b(?:hit|stale)\b/.test(vendorStatus)) return 'hit';
	if (/\b(?:revalidated|refresh)\b/.test(vendorStatus)) return 'revalidated';
	if (/\bmiss\b/.test(vendorStatus)) return 'miss';
	if (/\b(?:bypass|dynamic|uncacheable)\b/.test(vendorStatus)) {
		return 'bypassed';
	}
	const age = Number(headerValue(headers, 'age'));
	if (Number.isFinite(age) && age > 0) return 'hit';
	const cacheControl = headerValue(headers, 'cache-control')?.toLowerCase();
	if (cacheControl && /\bno-store\b/.test(cacheControl)) {
		return 'bypassed';
	}
	return 'unknown';
}

export type NetworkInsight = Readonly<{
	id: 'cache' | 'duplicates' | 'failed' | 'slow';
	label: string;
	detail: string;
	count: number;
	tone: NetworkStatusTone;
}>;

/** Small aggregate insights; request detail remains in the collector store. */
export function summarizeNetworkInsights(
	events: readonly NetworkEvent[],
): readonly NetworkInsight[] {
	const completed = events.filter((event) => event.state !== 'pending');
	const insights: NetworkInsight[] = [];
	const duplicateCounts = new Map<string, number>();
	for (const event of completed) {
		const key = `${event.method}\0${event.url}`;
		duplicateCounts.set(key, (duplicateCounts.get(key) ?? 0) + 1);
	}
	const duplicateCount = [...duplicateCounts.values()].reduce(
		(total, count) => total + Math.max(0, count - 1),
		0,
	);
	if (duplicateCount > 0) {
		insights.push({
			id: 'duplicates',
			label: 'Duplicate requests',
			detail: `${duplicateCount} repeated call${duplicateCount === 1 ? '' : 's'}`,
			count: duplicateCount,
			tone: 'warning',
		});
	}
	const failedCount = completed.filter(isFailedNetworkEvent).length;
	if (failedCount > 0) {
		insights.push({
			id: 'failed',
			label: 'Failed requests',
			detail: `${failedCount} request${failedCount === 1 ? '' : 's'} failed`,
			count: failedCount,
			tone: 'danger',
		});
	}
	const slowCount = completed.filter(
		(event) => event.durationMs >= SLOW_REQUEST_MS,
	).length;
	if (slowCount > 0) {
		insights.push({
			id: 'slow',
			label: 'Slow requests',
			detail: `${slowCount} at or above ${formatNetworkDuration(SLOW_REQUEST_MS)}`,
			count: slowCount,
			tone: 'warning',
		});
	}
	const cacheCounts = {
		hit: completed.filter((event) => event.cacheStatus === 'hit').length,
		miss: completed.filter((event) => event.cacheStatus === 'miss').length,
		revalidated: completed.filter(
			(event) => event.cacheStatus === 'revalidated',
		).length,
		bypassed: completed.filter((event) => event.cacheStatus === 'bypassed')
			.length,
	};
	const cacheCount = Object.values(cacheCounts).reduce(
		(total, count) => total + count,
		0,
	);
	if (cacheCount > 0) {
		const parts = [
			cacheCounts.hit > 0 ? `${cacheCounts.hit} hit` : undefined,
			cacheCounts.miss > 0 ? `${cacheCounts.miss} miss` : undefined,
			cacheCounts.revalidated > 0
				? `${cacheCounts.revalidated} revalidated`
				: undefined,
			cacheCounts.bypassed > 0 ? `${cacheCounts.bypassed} bypassed` : undefined,
		].filter((part): part is string => part !== undefined);
		insights.push({
			id: 'cache',
			label: 'HTTP cache evidence',
			detail: parts.join(' · '),
			count: cacheCount,
			tone: cacheCounts.miss > cacheCounts.hit ? 'warning' : 'success',
		});
	}
	return insights;
}

export function networkReplayBlockReason(
	event: NetworkEvent,
): string | undefined {
	if (event.requestProjectionComplete !== true) {
		return 'The complete original request was not retained, so this request cannot be re-sent safely.';
	}
	if (event.captureTransport !== 'global-fetch') {
		return 'This request came from an explicit fetch client whose original transport cannot be reconstructed safely.';
	}
	try {
		const protocol = new URL(event.url).protocol;
		if (protocol !== 'http:' && protocol !== 'https:') {
			return 'Only HTTP(S) requests can be re-sent safely.';
		}
	} catch {
		return 'The captured URL is not an absolute HTTP(S) URL.';
	}
	if (UNSAFE_REPLAY_MARKER.test(event.url)) {
		return 'The captured URL contains omitted or redacted data.';
	}
	if (
		Object.values(event.requestHeaders).some((value) =>
			UNSAFE_REPLAY_MARKER.test(value),
		)
	) {
		return 'One or more request headers were redacted.';
	}
	if (event.requestBody !== undefined) {
		const bodyIssue = requestBodyProjectionIssue(event.requestBody);
		if (bodyIssue === 'diagnostic') {
			return 'The captured request body contains omitted or redacted data.';
		}
		if (bodyIssue === 'truncated') {
			return 'The captured request body was truncated at the capture size limit.';
		}
	}
	return undefined;
}

function requestBodyProjectionIssue(
	body: string,
): 'diagnostic' | 'truncated' | undefined {
	// Byte-capped bodies may be cut mid-value and marked only with a trailing
	// ellipsis; collector-authored diagnostic markers are never transport data.
	if (UNSAFE_REPLAY_MARKER.test(body)) return 'diagnostic';
	return body.endsWith('…') ? 'truncated' : undefined;
}

/**
 * Connectivity checks, Sentry ingest, and the Metro dev server are ambient
 * traffic the panel hides by default. Analytics such as PostHog stay visible
 * because the app sends them deliberately.
 */
export function isSystemNetworkEvent(
	event: ClassifiableNetworkRequest,
): boolean {
	const parsed = parseNetworkUrl(event.url);
	const { hostname, port } = hostParts(parsed.host);
	const pathname = parsed.pathname.toLowerCase();
	if (pathname.includes('generate_204') || pathname.includes('generate204')) {
		return true;
	}
	if (/^clients\d*\.google\.com$/.test(hostname)) return true;
	if (hostname === 'gstatic.com' || hostname.endsWith('.gstatic.com')) {
		return true;
	}
	if (hostname === 'captive.apple.com') return true;
	if (hostname === 'sentry.io' || hostname.endsWith('.sentry.io')) return true;
	if (
		(hostname === 'localhost' ||
			hostname === '127.0.0.1' ||
			hostname === '::1') &&
		port >= 8081 &&
		port <= 8090
	) {
		return true;
	}
	return false;
}

export function matchesNetworkSegment(
	event: ClassifiableNetworkRequest,
	segment: NetworkSegment,
): boolean {
	if (segment === 'supabase') return isSupabaseNetworkEvent(event);
	if (segment === 'errors') return isFailedNetworkEvent(event);
	if (segment === 'slow') {
		return (
			event.state !== 'pending' && (event.durationMs ?? 0) >= SLOW_REQUEST_MS
		);
	}
	return true;
}

export function matchesNetworkSearch(
	event: NetworkEvent,
	needle: string,
): boolean {
	if (!needle) return true;
	return (
		event.url.toLowerCase().includes(needle) ||
		event.method.toLowerCase().includes(needle) ||
		String(event.status ?? '').includes(needle) ||
		networkEventLabel(event).label.toLowerCase().includes(needle)
	);
}

export function collapseNetworkEvents(
	events: readonly NetworkEvent[],
): CollapsedNetworkEvent[] {
	const collapsed: CollapsedNetworkEvent[] = [];
	for (const event of events) {
		const previous = collapsed.at(-1);
		if (
			previous &&
			previous.event.method === event.method &&
			previous.event.url === event.url &&
			previous.event.status === event.status &&
			previous.event.state === event.state
		) {
			previous.count += 1;
		} else {
			collapsed.push({ event, count: 1 });
		}
	}
	return collapsed;
}

export function summarizeNetworkEvents(
	events: readonly NetworkEvent[],
	nowMs: number,
): string {
	if (events.length === 0) return 'No requests';
	const oldest = events.reduce(
		(minimum, event) => Math.min(minimum, event.startedAt),
		Number.POSITIVE_INFINITY,
	);
	const minutes = Math.max(1, Math.ceil((nowMs - oldest) / 60_000));
	const window =
		minutes < 60 ? `Last ${minutes} min` : `Last ${Math.ceil(minutes / 60)} hr`;
	const failed = events.filter(isFailedNetworkEvent).length;
	const bytes = events.reduce(
		(total, event) =>
			total + (event.requestSizeBytes ?? 0) + (event.responseSizeBytes ?? 0),
		0,
	);
	const parts = [
		window,
		`${events.length} request${events.length === 1 ? '' : 's'}`,
	];
	if (failed > 0) parts.push(`${failed} failed`);
	if (bytes > 0) parts.push(formatNetworkBytes(bytes));
	return parts.join(' · ');
}

export function networkStatusPresentation(event: NetworkEvent): {
	text: string;
	tone: NetworkStatusTone;
} {
	if (event.state === 'pending') return { text: '…', tone: 'info' };
	if (event.state === 'aborted') {
		return {
			text: event.status ? String(event.status) : 'ABORTED',
			tone: 'warning',
		};
	}
	if (event.state === 'error') {
		return {
			text: event.status ? String(event.status) : 'ERROR',
			tone: 'danger',
		};
	}
	const status = event.status ?? 0;
	if (status >= 500) return { text: String(status), tone: 'danger' };
	if (status >= 400) return { text: String(status), tone: 'warning' };
	return { text: event.status ? String(event.status) : 'OK', tone: 'success' };
}

function hostToken(host: string): string | undefined {
	const { hostname } = hostParts(host);
	if (!hostname) return undefined;
	if (hostname === 'localhost' || /^[\d.]+$/.test(hostname)) return host;
	const parts = hostname.split('.');
	return parts.length >= 2 ? parts[parts.length - 2] : hostname;
}

export { formatNetworkDuration };

export function networkRowSubtitle(event: NetworkEvent): string {
	const parsed = parseNetworkUrl(event.url);
	const source =
		networkEventLabel(event).sourceKind ??
		hostToken(parsed.host) ??
		event.source;
	const tokens = [source];
	if (event.state === 'pending') {
		tokens.push('pending');
		if (event.requestSizeBytes !== undefined) {
			tokens.push(`${formatNetworkBytes(event.requestSizeBytes)} ↑`);
		}
	} else {
		tokens.push(formatNetworkDuration(event.durationMs));
		if (event.state === 'error' || event.state === 'aborted') {
			const reason = event.error ?? event.state;
			tokens.push(reason.length > 48 ? `${reason.slice(0, 47)}…` : reason);
		} else if (event.responseSizeBytes !== undefined) {
			tokens.push(formatNetworkBytes(event.responseSizeBytes));
		}
	}
	return tokens.join(' · ');
}

export function formatNetworkClock(epochMs: number): string {
	const date = new Date(epochMs);
	const pad = (value: number, size = 2) => String(value).padStart(size, '0');
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
		date.getSeconds(),
	)}.${pad(date.getMilliseconds(), 3)}`;
}

export function networkRequestPath(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.pathname}${parsed.search}` || url;
	} catch {
		return url;
	}
}

export function prettyNetworkBody(body: string): string {
	try {
		return JSON.stringify(JSON.parse(body), null, 2);
	} catch {
		return body;
	}
}

export function detailStatusText(event: NetworkEvent): string {
	if (event.state === 'pending') return 'Pending…';
	if (event.state === 'aborted') return 'Aborted';
	if (event.status === undefined) {
		return event.state === 'error' ? 'Failed' : 'Unknown';
	}
	return event.status === 200 ? '200 OK' : String(event.status);
}

export function responseBodySummaryText(event: NetworkEvent): string {
	if (event.responseBody === undefined) {
		if (event.state === 'pending') return 'Pending';
		return event.bodyCaptureEnabled === false ? 'Not captured' : 'Empty';
	}
	const kind = event.contentType?.toLowerCase().includes('json')
		? 'JSON'
		: (event.contentType?.split(';')[0]?.trim() ?? 'Text');
	return event.responseSizeBytes === undefined
		? kind
		: `${kind} · ${formatNetworkBytes(event.responseSizeBytes)}`;
}

type CurlHeaderProjection = Readonly<{
	entries: readonly Readonly<{ name: string; value: string }>[];
	complete: boolean;
}>;

/** Detaches one bounded header view so MIME classification and output agree. */
function projectCurlHeaders(
	headers: Readonly<Record<string, string>>,
): CurlHeaderProjection {
	try {
		const prototype = Object.getPrototypeOf(headers);
		if (prototype !== Object.prototype && prototype !== null) {
			return { entries: [], complete: false };
		}
		const entries: Array<Readonly<{ name: string; value: string }>> = [];
		for (const name in headers) {
			if (!Object.hasOwn(headers, name)) continue;
			if (entries.length >= MAX_NETWORK_CURL_HEADERS) {
				return { entries, complete: false };
			}
			const descriptor = Object.getOwnPropertyDescriptor(headers, name);
			if (
				!descriptor ||
				!('value' in descriptor) ||
				typeof descriptor.value !== 'string' ||
				name.length > MAX_NETWORK_CURL_HEADER_NAME_BYTES ||
				descriptor.value.length > MAX_NETWORK_CURL_HEADER_VALUE_BYTES
			) {
				return { entries: [], complete: false };
			}
			entries.push(Object.freeze({ name, value: descriptor.value }));
		}
		return { entries, complete: true };
	} catch {
		return { entries: [], complete: false };
	}
}

export function buildCurlCommand(event: NetworkEvent): string {
	const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
	let omitted = 0;
	const boundedMethod =
		event.method.length <= MAX_NETWORK_CURL_METHOD_BYTES
			? event.method.toUpperCase()
			: '';
	const method = /^[!#$%&'*+.^_`|~0-9A-Z-]+$/.test(boundedMethod)
		? boundedMethod
		: 'GET';
	if (method !== boundedMethod) omitted += 1;
	const redactedUrl =
		event.url.length <= MAX_NETWORK_CURL_URL_BYTES
			? truncateText(defaultRedactUrl(event.url), MAX_NETWORK_CURL_URL_BYTES)
			: undefined;
	let url = CURL_URL_OMITTED;
	if (redactedUrl && !redactedUrl.truncated) {
		try {
			const protocol = new URL(redactedUrl.text).protocol;
			if (protocol === 'http:' || protocol === 'https:') {
				url = redactedUrl.text;
			}
		} catch {
			// cURL export only supports absolute HTTP(S) diagnostics.
		}
	}
	if (url === CURL_URL_OMITTED) omitted += 1;
	const parts = [`curl -X ${quote(method)} ${quote(url)}`];
	const requestContentTypes: string[] = [];
	const projectedHeaders = projectCurlHeaders(event.requestHeaders);
	let contentTypeUnsafe = !projectedHeaders.complete;
	// MIME classification is independent of the emitted-header limit. Once the
	// bounded projection is exceeded, or Content-Type is ambiguous/duplicated,
	// fail closed and never emit a captured body.
	for (const { name, value } of projectedHeaders.entries) {
		if (name.toLowerCase() !== 'content-type') continue;
		requestContentTypes.push(value);
	}
	if (requestContentTypes.length > 1) contentTypeUnsafe = true;
	if (!projectedHeaders.complete) omitted += 1;
	for (const { name, value } of projectedHeaders.entries) {
		if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
			omitted += 1;
			continue;
		}
		if (headerNameRequiresRedaction(name)) {
			omitted += 1;
			continue;
		}
		if (CURL_DERIVED_HEADERS.has(name.toLowerCase())) {
			omitted += 1;
			continue;
		}
		const safeName = truncateText(
			redactDiagnosticText(name),
			MAX_NETWORK_CURL_HEADER_NAME_BYTES,
		);
		const safeValue = truncateText(
			defaultRedactHeader(name, value),
			MAX_NETWORK_CURL_HEADER_VALUE_BYTES,
		);
		if (safeName.truncated || safeValue.truncated) {
			if (name.toLowerCase() === 'content-type') contentTypeUnsafe = true;
			omitted += 1;
			continue;
		}
		parts.push(`-H ${quote(`${safeName.text}: ${safeValue.text}`)}`);
	}
	if (
		event.requestBody !== undefined &&
		method !== 'GET' &&
		method !== 'HEAD'
	) {
		if (event.requestBody.length <= MAX_NETWORK_CURL_BODY_BYTES) {
			const mediaTypes = requestContentTypes
				.flatMap((value) => value.split(','))
				.map((value) => value.trim());
			const multipart = mediaTypes.some((value) => /^multipart\//i.test(value));
			const bodyProjection = mediaTypes.some((value) =>
				/^application\/x-www-form-urlencoded(?:\s*;|\s*$)/i.test(value),
			)
				? defaultRedactFormBody(event.requestBody)
				: event.requestBody;
			const textualContentType =
				requestContentTypes.length === 1 &&
				isTextualNetworkContentType(requestContentTypes[0]);
			if (
				event.requestProjectionComplete !== true ||
				multipart ||
				contentTypeUnsafe ||
				!textualContentType ||
				requestBodyProjectionIssue(bodyProjection) !== undefined
			)
				omitted += 1;
			else {
				const safeBody = truncateText(
					defaultRedactBody(bodyProjection),
					MAX_NETWORK_CURL_BODY_BYTES,
				);
				if (
					safeBody.truncated ||
					requestBodyProjectionIssue(safeBody.text) !== undefined
				) {
					omitted += 1;
				} else parts.push(`--data-raw ${quote(safeBody.text)}`);
			}
		} else {
			omitted += 1;
		}
	}
	const included: string[] = [];
	for (const part of parts) {
		const candidate = [...included, part].join(' \\\n  ');
		if (utf8ByteLength(candidate) <= MAX_NETWORK_CURL_EXPORT_BYTES) {
			included.push(part);
		} else {
			omitted += 1;
		}
	}
	const command = included.join(' \\\n  ');
	if (omitted === 0) return command;
	const notice = `\n# ${omitted} redacted argument${omitted === 1 ? '' : 's'} omitted by export limit`;
	return utf8ByteLength(command + notice) <= MAX_NETWORK_CURL_EXPORT_BYTES
		? command + notice
		: command;
}

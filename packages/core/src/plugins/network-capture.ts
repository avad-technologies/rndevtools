import {
	isSensitiveDiagnosticKey,
	redactDiagnosticText,
	sanitizeDiagnosticValueWithMetadata,
} from '../core/redact';
import { truncateText, utf8ByteLength } from '../core/serialize';
import type { NetworkSimulationProfileId } from '../network-profile';

const MAX_CAPTURED_HEADERS = 100;
const MAX_HEADER_NAME_BYTES = 1024;
const MAX_HEADER_VALUE_BYTES = 8 * 1024;
const MAX_RAW_HEADER_COMPONENT_CODE_UNITS = 64 * 1024;
const MAX_RAW_BODY_CODE_UNITS = 64 * 1024;
const MAX_BODY_CAPTURE_READS = 1024;
const MAX_URL_SEARCH_PARAMETER_ENTRIES = 100;
const MAX_URL_PATH_SEGMENTS = 256;
const MAX_CONTENT_TYPE_BYTES = 1024;
const MAX_CONTENT_LENGTH_CODE_UNITS = 64;

export { formatBytes as formatNetworkBytes } from '../core/format';

export type NetworkEventState = 'pending' | 'success' | 'error' | 'aborted';

export type NetworkCacheStatus =
	| 'bypassed'
	| 'hit'
	| 'miss'
	| 'revalidated'
	| 'unknown';

export type NetworkCaptureTransport = 'explicit-fetch' | 'global-fetch';

/**
 * Phases observable at the instrumented fetch boundary. `transportMs` includes
 * all native/network work until fetch resolves; DNS, connect, TLS, and TTFB are
 * intentionally not fabricated because React Native fetch does not expose them.
 */
export type NetworkTimingPhases = Readonly<{
	latencyDelayMs?: number;
	uploadDelayMs?: number;
	transportMs?: number;
	downloadDelayMs?: number;
	totalMs: number;
}>;

export type NetworkEvent = {
	/** Opaque authority epoch; combine with `id` for any durable reference. */
	sessionId: string;
	id: number;
	startedAt: number;
	method: string;
	url: string;
	state: NetworkEventState;
	status?: number;
	durationMs: number;
	timing?: NetworkTimingPhases;
	cacheStatus?: NetworkCacheStatus;
	correlationId?: string;
	parentEventId?: string;
	simulationProfileId?: NetworkSimulationProfileId;
	/** True only when every replay-relevant request field was captured intact. */
	requestProjectionComplete?: boolean;
	/** Identifies the exact fetch authority that produced this capture. */
	captureTransport?: NetworkCaptureTransport;
	/** Opaque owned global-fetch layer epoch; omitted for explicit clients. */
	captureLayerId?: string;
	bodyCaptureEnabled?: boolean;
	requestHeaders: Readonly<Record<string, string>>;
	requestBody?: string;
	responseHeaders?: Readonly<Record<string, string>>;
	responseBody?: string;
	contentType?: string;
	source: string;
	requestSizeBytes?: number;
	responseSizeBytes?: number;
	error?: string;
};

export type NetworkBodyContext = {
	direction: 'request' | 'response';
	contentType?: string;
	url: string;
};

export type CapturedNetworkBody = {
	body?: string;
	capturedBytes?: number;
	complete: boolean;
	/** Internal lower bound used only to validate declared-size provenance. */
	observedBytes?: number;
	/** Internal provenance: cancellation did not contradict a declared size. */
	cancelled?: true;
	/** True only for a fixed diagnostic marker authored by the collector. */
	omitted?: true;
};

export type StartedNetworkBodyCapture =
	| Readonly<{ kind: 'immediate'; result: CapturedNetworkBody }>
	| Readonly<{
			kind: 'task';
			read: (signal?: AbortSignal) => Promise<CapturedNetworkBody>;
			/** Publishes promptly when the underlying read cannot observe abort. */
			timeoutResult?: CapturedNetworkBody;
	  }>;

export type PreparedNetworkBodyCapture =
	| Readonly<{ kind: 'immediate'; result: CapturedNetworkBody }>
	| Readonly<{
			kind: 'deferred';
			/** Allocates the clone/reader only after the global work cap admits it. */
			start: () => StartedNetworkBodyCapture;
	  }>;

export type CapturedNetworkHeaders = {
	headers: Record<string, string>;
	complete: boolean;
	/** Bounded raw MIME provenance captured before a host redactor runs. */
	contentType?: string;
	/** False when header shape/volume prevents an exact MIME classification. */
	contentTypeComplete: boolean;
};

function prototypeGetterValue<T>(
	prototype: object,
	key: string,
	receiver: object,
): T {
	const getter = Object.getOwnPropertyDescriptor(prototype, key)?.get;
	if (typeof getter !== 'function') {
		throw new Error(`Missing intrinsic ${key} getter.`);
	}
	return Reflect.apply(getter, receiver, []) as T;
}

function prototypeMethodValue<T>(
	prototype: object,
	key: string,
	receiver: object,
): T {
	const method = Object.getOwnPropertyDescriptor(prototype, key)?.value;
	if (typeof method !== 'function') {
		throw new Error(`Missing intrinsic ${key} method.`);
	}
	return Reflect.apply(method, receiver, []) as T;
}

function safelyInspectRequestHeaders(
	input: Request,
	trustedInput = false,
): Headers {
	try {
		return prototypeGetterValue<Headers>(Request.prototype, 'headers', input);
	} catch (error) {
		if (!trustedInput) throw error;
		const headers = input.headers;
		if (!headers || typeof headers.get !== 'function') {
			throw new Error('Invalid trusted Request headers field.');
		}
		return headers;
	}
}

export function safelyInspectRequestBody(
	input: Request,
	trustedInput = false,
): ReadableStream<Uint8Array> | null {
	try {
		return prototypeGetterValue<ReadableStream<Uint8Array> | null>(
			Request.prototype,
			'body',
			input,
		);
	} catch (error) {
		if (!trustedInput) throw error;
		return input.body ?? null;
	}
}

export function safelyInspectRequestSignal(
	input: Request,
	trustedInput = false,
): AbortSignal {
	try {
		return prototypeGetterValue<AbortSignal>(
			Request.prototype,
			'signal',
			input,
		);
	} catch (error) {
		if (!trustedInput) throw error;
		const signal = input.signal;
		if (!signal || typeof signal.addEventListener !== 'function') {
			throw new Error('Invalid trusted Request signal field.');
		}
		return signal;
	}
}

export function safelyInspectRequestMethod(
	input: Request,
	trustedInput = false,
): string {
	try {
		return prototypeGetterValue<string>(Request.prototype, 'method', input);
	} catch (error) {
		if (!trustedInput) throw error;
		const method = input.method;
		if (typeof method !== 'string') {
			throw new Error('Invalid trusted Request method field.');
		}
		return method;
	}
}

function safelyCloneRequest(input: Request, trustedInput = false): Request {
	try {
		// Only a native internal-slot brand can make clone invocation proxy-safe.
		prototypeGetterValue<string>(Request.prototype, 'url', input);
		return prototypeMethodValue<Request>(Request.prototype, 'clone', input);
	} catch (error) {
		if (!trustedInput) throw error;
		return input.clone();
	}
}

export function isSafelyInspectableRequest(
	input: RequestInfo | URL,
	trustedInput = false,
): input is Request {
	if (!trustedInput) {
		// JavaScript/polyfilled intrinsic getters can themselves read through a
		// Proxy receiver. Without an explicit host boundary there is no portable,
		// trap-free way to distinguish a Request object from a Request Proxy.
		return false;
	}
	try {
		if (typeof Request === 'undefined') return false;
		prototypeGetterValue<string>(Request.prototype, 'url', input as Request);
		return true;
	} catch {
		try {
			return (
				!!input &&
				(typeof input === 'object' || typeof input === 'function') &&
				typeof (input as Request).url === 'string' &&
				typeof (input as Request).method === 'string' &&
				!!(input as Request).headers &&
				typeof (input as Request).headers.get === 'function'
			);
		} catch {
			return false;
		}
	}
}

export function safelyGetHeaderValue(
	headers: Headers,
	name: string,
	trustedHeaders = false,
): string | null {
	try {
		return Headers.prototype.get.call(headers, name);
	} catch (error) {
		if (!trustedHeaders) throw error;
		return headers.get(name);
	}
}

export function safelyInspectResponseHeaders(
	response: Response,
	trustedTransport = false,
): Headers {
	if (trustedTransport) {
		const headers = response.headers;
		if (!headers || typeof headers.get !== 'function') {
			throw new Error('Invalid trusted Response headers field.');
		}
		return headers;
	}
	return prototypeGetterValue<Headers>(Response.prototype, 'headers', response);
}

export function safelyInspectResponseStatus(
	response: Response,
	trustedTransport = false,
): number {
	if (trustedTransport) return response.status;
	return prototypeGetterValue<number>(Response.prototype, 'status', response);
}

export function safelyInspectResponseBody(
	response: Response,
	trustedTransport = false,
): ReadableStream<Uint8Array> | null {
	if (trustedTransport) return response.body;
	return prototypeGetterValue<ReadableStream<Uint8Array> | null>(
		Response.prototype,
		'body',
		response,
	);
}

function safelyCloneResponse(
	response: Response,
	trustedTransport = false,
): Response {
	if (trustedTransport) return response.clone();
	return prototypeMethodValue<Response>(Response.prototype, 'clone', response);
}

export function isSafelyInspectableResponse(
	response: unknown,
	trustedTransport = false,
): response is Response {
	if (!trustedTransport) {
		// See the Request note above: polyfilled Response getters may forward
		// internal-symbol reads through Proxy traps. Untrusted results fail closed.
		return false;
	}
	try {
		return (
			(typeof response === 'object' && response !== null) ||
			typeof response === 'function'
		);
	} catch {
		return false;
	}
}

export function defaultRedactHeader(name: string, value: string): string {
	if (headerNameRequiresRedaction(name) || isSensitiveDiagnosticKey(name)) {
		return '[REDACTED]';
	}
	const decoded = decodeUrlComponentForInspection(value);
	if (
		decoded === undefined ||
		(decoded !== value && redactDiagnosticText(decoded) !== decoded)
	) {
		return '[REDACTED]';
	}
	return redactDiagnosticText(value);
}

const MAX_URL_DECODE_LAYERS = 8;

function decodeUrlComponentForInspection(value: string): string | undefined {
	let decoded = value;
	for (let layer = 0; layer < MAX_URL_DECODE_LAYERS; layer += 1) {
		if (!/%[0-9a-f]{2}/i.test(decoded)) return decoded;
		try {
			const next = decodeURIComponent(decoded);
			if (next === decoded) return decoded;
			decoded = next;
		} catch {
			return undefined;
		}
	}
	return /%[0-9a-f]{2}/i.test(decoded) ? undefined : decoded;
}

/**
 * Percent is legal in an HTTP field name, but it can hide both sensitive keys
 * and the secret itself. Such names cannot be made safe by redacting only the
 * value, so callers must replace or omit the key as well.
 */
export function headerNameRequiresRedaction(name: string): boolean {
	const decoded = decodeUrlComponentForInspection(name);
	return (
		decoded === undefined ||
		decoded.includes('%') ||
		(decoded !== name &&
			(isSensitiveDiagnosticKey(decoded) ||
				redactDiagnosticText(decoded) !== decoded))
	);
}

function urlComponentIsSensitive(value: string, key = false): boolean {
	const decoded = decodeUrlComponentForInspection(value);
	return (
		decoded === undefined ||
		(key && isSensitiveDiagnosticKey(decoded)) ||
		redactDiagnosticText(decoded) !== decoded
	);
}

export function defaultRedactUrl(rawUrl: string): string {
	if (rawUrl.length > MAX_RAW_BODY_CODE_UNITS) {
		return '[URL omitted: input limit]';
	}
	const isAbsolute = /^[a-z][a-z\d+.-]*:/i.test(rawUrl);
	const isProtocolRelative = rawUrl.startsWith('//');
	try {
		const url = new URL(rawUrl, 'https://devtools.invalid');
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			return '[URL omitted: unsupported scheme]';
		}
		if (url.username) url.username = '[REDACTED]';
		if (url.password) url.password = '[REDACTED]';
		const pathSegments = url.pathname.split('/');
		if (pathSegments.length > MAX_URL_PATH_SEGMENTS) {
			return '[URL omitted: path segment limit]';
		}
		let redactNextPathValue = false;
		url.pathname = pathSegments
			.map((segment) => {
				if (!segment) return segment;
				const sensitiveKey = urlComponentIsSensitive(segment, true);
				const shouldRedact =
					redactNextPathValue ||
					sensitiveKey ||
					urlComponentIsSensitive(segment);
				redactNextPathValue = sensitiveKey;
				return shouldRedact ? '[REDACTED]' : segment;
			})
			.join('/');
		const safeParameters = new URLSearchParams();
		let parameterCount = 0;
		for (const [name, value] of url.searchParams.entries()) {
			parameterCount += 1;
			if (parameterCount > MAX_URL_SEARCH_PARAMETER_ENTRIES) {
				return '[URL omitted: parameter limit]';
			}
			const sensitiveName = urlComponentIsSensitive(name, true);
			const sensitiveValue = urlComponentIsSensitive(value);
			safeParameters.append(
				sensitiveName ? '[REDACTED]' : name,
				sensitiveName || sensitiveValue ? '[REDACTED]' : value,
			);
		}
		url.search = safeParameters.toString();
		if (url.hash) {
			if (urlComponentIsSensitive(url.hash.slice(1))) {
				url.hash = '[REDACTED]';
			}
		}
		const redacted = isAbsolute
			? url.toString()
			: isProtocolRelative
				? `//${url.host}${url.pathname}${url.search}${url.hash}`
				: `${url.pathname}${url.search}${url.hash}`;
		return redactDiagnosticText(redacted);
	} catch {
		return '[URL omitted: invalid URL]';
	}
}

/**
 * The diagnostic projection drops object/array entries past its per-level cap
 * and nesting past its depth limit. Those losses leave no in-band evidence, so
 * a projected body that still parses as JSON would otherwise look complete to
 * both the panel and the replay guard. Append an explicit trailer instead.
 */
const BODY_TRUNCATION_MARKER = '[Body truncated by diagnostic capture]';

function looksLikeXmlBody(body: string): boolean {
	return /^(?:\uFEFF)?\s*</.test(body);
}

export function defaultRedactBody(body: string): string {
	if (body.length > MAX_RAW_BODY_CODE_UNITS) {
		return '[Body omitted: input limit]';
	}
	const decoded = decodeUrlComponentForInspection(body);
	if (
		decoded === undefined ||
		looksLikeXmlBody(body) ||
		looksLikeXmlBody(decoded) ||
		(decoded !== body && redactDiagnosticText(decoded) !== decoded)
	) {
		return looksLikeXmlBody(body) || looksLikeXmlBody(decoded ?? '')
			? '[Body omitted: XML content]'
			: '[Body redacted: encoded sensitive data]';
	}
	try {
		const projection = sanitizeDiagnosticValueWithMetadata(JSON.parse(body));
		if (
			!projection.redacted &&
			!projection.truncated &&
			redactDiagnosticText(body) === body
		) {
			return body;
		}
		const text = JSON.stringify(projection.value, null, 2);
		return projection.truncated ? `${text}\n${BODY_TRUNCATION_MARKER}` : text;
	} catch {
		return redactDiagnosticText(body);
	}
}

export function defaultRedactFormBody(body: string): string {
	try {
		const params = new URLSearchParams(body);
		const safe = new URLSearchParams();
		let changed = false;
		let count = 0;
		for (const [name, value] of params) {
			count += 1;
			if (count > MAX_URL_SEARCH_PARAMETER_ENTRIES) {
				return '[Form body redacted: entry limit]';
			}
			const decodedName = decodeUrlComponentForInspection(name);
			const decodedValue = decodeUrlComponentForInspection(value);
			if (decodedName === undefined || decodedValue === undefined) {
				return '[Form body redacted: ambiguous encoding]';
			}
			const sensitiveName =
				isSensitiveDiagnosticKey(decodedName) ||
				redactDiagnosticText(decodedName) !== decodedName;
			const sensitiveValue =
				redactDiagnosticText(decodedValue) !== decodedValue;
			changed ||= sensitiveName || sensitiveValue;
			safe.append(
				sensitiveName ? '[REDACTED]' : name,
				sensitiveName || sensitiveValue ? '[REDACTED]' : value,
			);
		}
		return changed ? safe.toString() : body;
	} catch {
		return '[Form body redacted: invalid encoding]';
	}
}

/** A deliberately small allowlist for payloads that are safe to decode as text. */
export function isTextualNetworkContentType(
	rawContentType: string | undefined,
): boolean {
	if (
		!rawContentType ||
		rawContentType.length > MAX_CONTENT_TYPE_BYTES ||
		rawContentType.includes(',')
	) {
		return false;
	}
	const mediaType = rawContentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
	if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)) {
		return false;
	}
	if (
		mediaType === 'text/xml' ||
		mediaType === 'application/xml' ||
		mediaType.endsWith('+xml')
	) {
		return false;
	}
	if (mediaType.startsWith('text/')) return true;
	return (
		mediaType === 'application/json' ||
		mediaType.endsWith('+json') ||
		mediaType === 'application/x-ndjson' ||
		mediaType === 'application/json-seq' ||
		mediaType === 'application/x-www-form-urlencoded' ||
		mediaType === 'application/graphql' ||
		mediaType === 'application/javascript' ||
		mediaType === 'application/ecmascript'
	);
}

/**
 * Projects only bounded, descriptor-backed header forms. Arbitrary iterables
 * are never consumed merely to build diagnostics.
 */
export function captureHeaders(
	headersInit: HeadersInit | undefined,
	redact: (name: string, value: string) => string,
): CapturedNetworkHeaders {
	if (!headersInit) {
		return { headers: {}, complete: true, contentTypeComplete: true };
	}
	const safeHeaders = safeHeadersInitProjection(headersInit);
	// Records and tuple arrays are traversed only once while detaching them. MIME
	// inspection then runs against that bounded projection. A branded Headers may
	// still expose Content-Type in O(1) when its complete projection exceeds the
	// visible header cap.
	const contentTypeProjection =
		safeHeaders === undefined
			? (projectCanonicalRawContentType(headersInit) ?? { complete: false })
			: projectRawContentType(safeHeaders);
	const projected =
		safeHeaders === undefined
			? { headers: {}, complete: false, contentTypeComplete: false }
			: headersRecordWithMetadata(safeHeaders, redact);
	return {
		...projected,
		contentTypeComplete: contentTypeProjection.complete,
		...(contentTypeProjection.complete && contentTypeProjection.contentType
			? { contentType: contentTypeProjection.contentType }
			: {}),
	};
}

function projectCanonicalRawContentType(
	headersInit: HeadersInit,
): Readonly<{ complete: boolean; contentType?: string }> | undefined {
	try {
		if (
			typeof Headers === 'undefined' ||
			!(headersInit instanceof Headers) ||
			Object.getPrototypeOf(headersInit) !== Headers.prototype
		) {
			return undefined;
		}
		const value = Headers.prototype.get.call(headersInit, 'content-type');
		if (value === null) return { complete: true };
		const bounded = truncateText(value, MAX_CONTENT_TYPE_BYTES);
		return bounded.truncated
			? { complete: false }
			: { complete: true, contentType: bounded.text };
	} catch {
		return { complete: false };
	}
}

function projectRawContentType(
	headersInit: HeadersInit,
): Readonly<{ complete: boolean; contentType?: string }> {
	try {
		if (typeof Headers !== 'undefined') {
			try {
				const value = Headers.prototype.get.call(headersInit, 'content-type');
				if (value === null) return { complete: true };
				const bounded = truncateText(value, MAX_CONTENT_TYPE_BYTES);
				return bounded.truncated
					? { complete: false }
					: { complete: true, contentType: bounded.text };
			} catch {
				// Descriptor-backed tuples and records are handled below.
			}
		}
		const values: string[] = [];
		const append = (name: string, value: string): boolean => {
			if (name.toLowerCase() !== 'content-type') return true;
			if (value.length > MAX_RAW_HEADER_COMPONENT_CODE_UNITS) return false;
			values.push(value);
			return true;
		};
		if (Array.isArray(headersInit)) {
			if (Object.getPrototypeOf(headersInit) !== Array.prototype) {
				return { complete: false };
			}
			const length = Object.getOwnPropertyDescriptor(
				headersInit,
				'length',
			)?.value;
			if (
				!Number.isSafeInteger(length) ||
				length < 0 ||
				length > MAX_CAPTURED_HEADERS
			) {
				return { complete: false };
			}
			for (let index = 0; index < length; index += 1) {
				const descriptor = Object.getOwnPropertyDescriptor(headersInit, index);
				const pair =
					descriptor && 'value' in descriptor
						? safeHeaderTuple(descriptor.value)
						: undefined;
				if (!pair || !append(pair[0], pair[1])) return { complete: false };
			}
		} else {
			const prototype = Object.getPrototypeOf(headersInit);
			if (prototype !== Object.prototype && prototype !== null) {
				return { complete: false };
			}
			let count = 0;
			for (const name in headersInit) {
				if (!Object.hasOwn(headersInit, name)) continue;
				count += 1;
				if (count > MAX_CAPTURED_HEADERS) return { complete: false };
				const descriptor = Object.getOwnPropertyDescriptor(headersInit, name);
				if (
					!descriptor ||
					!('value' in descriptor) ||
					typeof descriptor.value !== 'string' ||
					!append(name, descriptor.value)
				) {
					return { complete: false };
				}
			}
		}
		const combined = values.join(', ');
		const bounded = truncateText(combined, MAX_CONTENT_TYPE_BYTES);
		return bounded.truncated
			? { complete: false }
			: {
					complete: true,
					...(bounded.text ? { contentType: bounded.text } : {}),
				};
	} catch {
		return { complete: false };
	}
}

function headersRecordWithMetadata(
	headersInit: HeadersInit | undefined,
	redact: (name: string, value: string) => string,
): CapturedNetworkHeaders {
	if (!headersInit) {
		return { headers: {}, complete: true, contentTypeComplete: true };
	}
	const output = Object.create(null) as Record<string, string>;
	let capturedCount = 0;
	let complete = true;
	let contentType: string | undefined;
	try {
		new Headers(headersInit).forEach((value, name) => {
			if (capturedCount >= MAX_CAPTURED_HEADERS) {
				complete = false;
				return;
			}
			capturedCount += 1;
			if (
				name.length > MAX_RAW_HEADER_COMPONENT_CODE_UNITS ||
				value.length > MAX_RAW_HEADER_COMPONENT_CODE_UNITS
			) {
				complete = false;
				output[`[header-${capturedCount}-omitted]`] =
					'[Header omitted: input limit]';
				return;
			}
			if (name.toLowerCase() === 'content-type') {
				const boundedContentType = truncateText(value, MAX_CONTENT_TYPE_BYTES);
				if (boundedContentType.truncated) complete = false;
				else contentType = boundedContentType.text;
			}
			const unsafeName = headerNameRequiresRedaction(name);
			const projectedName = unsafeName
				? `[header-${capturedCount}-redacted]`
				: name;
			const boundedName = truncateText(projectedName, MAX_HEADER_NAME_BYTES);
			if (boundedName.truncated) complete = false;
			try {
				const builtInValue = defaultRedactHeader(name, value);
				const customValue = redact(projectedName, builtInValue);
				if (typeof customValue !== 'string') {
					complete = false;
					output[boundedName.text] = '[REDACTION FAILED]';
					return;
				}
				const redactedValue = defaultRedactHeader(projectedName, customValue);
				const boundedValue = truncateText(
					redactedValue,
					MAX_HEADER_VALUE_BYTES,
				);
				if (
					unsafeName ||
					builtInValue !== value ||
					customValue !== builtInValue ||
					redactedValue !== value ||
					boundedValue.truncated
				) {
					complete = false;
				}
				output[boundedName.text] = boundedValue.text;
			} catch {
				complete = false;
				output[boundedName.text] = '[REDACTION FAILED]';
			}
		});
	} catch {
		return {
			headers: output,
			complete: false,
			contentTypeComplete: contentType !== undefined,
			...(contentType === undefined ? {} : { contentType }),
		};
	}
	return {
		headers: output,
		complete,
		contentTypeComplete: true,
		...(contentType === undefined ? {} : { contentType }),
	};
}

function safeHeaderTuple(
	value: unknown,
): readonly [string, string] | undefined {
	if (
		!Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Array.prototype
	) {
		return undefined;
	}
	const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
	const nameDescriptor = Object.getOwnPropertyDescriptor(value, '0');
	const valueDescriptor = Object.getOwnPropertyDescriptor(value, '1');
	if (
		lengthDescriptor?.value !== 2 ||
		!nameDescriptor ||
		!('value' in nameDescriptor) ||
		!valueDescriptor ||
		!('value' in valueDescriptor) ||
		typeof nameDescriptor.value !== 'string' ||
		typeof valueDescriptor.value !== 'string' ||
		nameDescriptor.value.length > MAX_RAW_HEADER_COMPONENT_CODE_UNITS ||
		valueDescriptor.value.length > MAX_RAW_HEADER_COMPONENT_CODE_UNITS
	) {
		return undefined;
	}
	return [nameDescriptor.value, valueDescriptor.value];
}

/**
 * Detaches only descriptor-backed header forms. In particular, diagnostics do
 * not consume arbitrary iterables or invoke record accessors before fetch does.
 */
function safeHeadersInitProjection(
	headersInit: HeadersInit,
): HeadersInit | undefined {
	try {
		if (typeof Headers !== 'undefined') {
			const projected = new Headers();
			const stopProjection = Object.freeze({});
			let count = 0;
			try {
				Headers.prototype.forEach.call(headersInit, (value, name) => {
					count += 1;
					if (
						count > MAX_CAPTURED_HEADERS ||
						name.length > MAX_RAW_HEADER_COMPONENT_CODE_UNITS ||
						value.length > MAX_RAW_HEADER_COMPONENT_CODE_UNITS
					) {
						throw stopProjection;
					}
					projected.append(name, value);
				});
				return projected;
			} catch (error) {
				if (error === stopProjection) return undefined;
				// Non-Headers values are considered below without consuming iterables.
			}
		}

		if (Object.getOwnPropertyDescriptor(headersInit, Symbol.iterator)) {
			// A record-shaped object with iterator semantics is not an empty record.
			// Never invoke or consume it merely to decide replay completeness.
			return undefined;
		}
		if (Array.isArray(headersInit)) {
			if (Object.getPrototypeOf(headersInit) !== Array.prototype)
				return undefined;
			const length = Object.getOwnPropertyDescriptor(
				headersInit,
				'length',
			)?.value;
			if (
				!Number.isSafeInteger(length) ||
				length < 0 ||
				length > MAX_CAPTURED_HEADERS
			) {
				return undefined;
			}
			const projected: [string, string][] = [];
			for (let index = 0; index < length; index += 1) {
				const descriptor = Object.getOwnPropertyDescriptor(headersInit, index);
				if (!descriptor || !('value' in descriptor)) return undefined;
				const pair = safeHeaderTuple(descriptor.value);
				if (!pair) return undefined;
				projected.push([pair[0], pair[1]]);
			}
			return projected;
		}

		const prototype = Object.getPrototypeOf(headersInit);
		if (prototype !== Object.prototype && prototype !== null) return undefined;
		const projected = Object.create(null) as Record<string, string>;
		let count = 0;
		for (const key in headersInit) {
			if (!Object.hasOwn(headersInit, key)) continue;
			count += 1;
			if (count > MAX_CAPTURED_HEADERS) return undefined;
			const descriptor = Object.getOwnPropertyDescriptor(headersInit, key);
			if (
				!descriptor ||
				!('value' in descriptor) ||
				typeof descriptor.value !== 'string' ||
				key.length > MAX_RAW_HEADER_COMPONENT_CODE_UNITS ||
				descriptor.value.length > MAX_RAW_HEADER_COMPONENT_CODE_UNITS
			) {
				return undefined;
			}
			projected[key] = descriptor.value;
		}
		return projected;
	} catch {
		return undefined;
	}
}

export function captureRequestHeaders(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	redact: (name: string, value: string) => string,
	trustedInput = false,
): CapturedNetworkHeaders {
	// Fetch replaces a Request's inherited headers when init.headers is present.
	if (init?.headers !== undefined) {
		return captureHeaders(init.headers, redact);
	}
	if (isSafelyInspectableRequest(input, trustedInput)) {
		return captureHeaders(
			safelyInspectRequestHeaders(input, trustedInput),
			redact,
		);
	}
	return { headers: {}, complete: true, contentTypeComplete: true };
}

export function requestUrl(
	input: RequestInfo | URL,
	trustedInput = false,
): string {
	if (typeof input === 'string') return input;
	// Prefer the trusted Request projection. URL#toString may be generic in
	// polyfilled runtimes and therefore is not positive evidence of a URL.
	if (isSafelyInspectableRequest(input, trustedInput)) {
		try {
			return prototypeGetterValue<string>(Request.prototype, 'url', input);
		} catch (error) {
			if (!trustedInput) throw error;
			if (typeof input.url !== 'string') {
				throw new Error('Invalid trusted Request URL field.');
			}
			return input.url;
		}
	}
	try {
		return prototypeGetterValue<string>(URL.prototype, 'href', input);
	} catch {
		// The input is neither a safely inspectable Request nor a branded URL.
	}
	throw new Error('Request URL is not safely inspectable.');
}

export function requestMethod(
	input: RequestInfo | URL,
	init?: RequestInit,
	trustedInput = false,
): string {
	const initializedMethod = init?.method;
	if (initializedMethod) {
		return initializedMethod.length > 32
			? `[METHOD OVER LIMIT:${initializedMethod.length}]`
			: initializedMethod.toUpperCase();
	}
	if (isSafelyInspectableRequest(input, trustedInput)) {
		const requestMethod = safelyInspectRequestMethod(input, trustedInput);
		return requestMethod.length > 32
			? `[METHOD OVER LIMIT:${requestMethod.length}]`
			: requestMethod.toUpperCase();
	}
	return 'GET';
}

function bodyFromInit(
	body: BodyInit | null | undefined,
	maxBytes: number,
): CapturedNetworkBody | undefined {
	if (body == null) return undefined;
	if (typeof body === 'string') {
		if (body.length > MAX_RAW_BODY_CODE_UNITS) {
			return {
				body: '[Body omitted: input limit]',
				complete: false,
				omitted: true,
			};
		}
		const bodyBytes = utf8ByteLength(body);
		return {
			body: bodyBytes > maxBytes ? `[Body omitted: ${bodyBytes} bytes]` : body,
			capturedBytes: bodyBytes,
			complete: bodyBytes <= maxBytes,
			...(bodyBytes > maxBytes ? { omitted: true as const } : {}),
		};
	}
	if (
		typeof URLSearchParams !== 'undefined' &&
		body instanceof URLSearchParams &&
		Object.getPrototypeOf(body) === URLSearchParams.prototype
	) {
		const safe = new URLSearchParams();
		let count = 0;
		let inputCodeUnits = 0;
		const entries = URLSearchParams.prototype.entries.call(body);
		for (const [name, value] of entries) {
			count += 1;
			inputCodeUnits += name.length + value.length;
			if (
				count > MAX_URL_SEARCH_PARAMETER_ENTRIES ||
				inputCodeUnits > MAX_RAW_BODY_CODE_UNITS
			) {
				return {
					body: '[Body omitted: URLSearchParams input limit]',
					complete: false,
					omitted: true,
				};
			}
			safe.append(name, value);
		}
		const text = URLSearchParams.prototype.toString.call(safe);
		if (text.length > MAX_RAW_BODY_CODE_UNITS) {
			return {
				body: '[Body omitted: URLSearchParams input limit]',
				complete: false,
				omitted: true,
			};
		}
		const bodyBytes = utf8ByteLength(text);
		return {
			body: bodyBytes > maxBytes ? `[Body omitted: ${bodyBytes} bytes]` : text,
			capturedBytes: bodyBytes,
			// Replaying this projection as a plain string changes fetch's synthesized
			// Content-Type. Until the original body kind is retained, keep it visible
			// for diagnostics but never classify the request as replay-complete.
			complete: false,
			...(bodyBytes > maxBytes ? { omitted: true as const } : {}),
		};
	}
	if (
		typeof FormData !== 'undefined' &&
		body instanceof FormData &&
		Object.getPrototypeOf(body) === FormData.prototype
	) {
		return { body: '[FormData omitted]', complete: false, omitted: true };
	}
	if (
		typeof Blob !== 'undefined' &&
		body instanceof Blob &&
		Object.getPrototypeOf(body) === Blob.prototype
	) {
		const blobSize = Object.getOwnPropertyDescriptor(
			Blob.prototype,
			'size',
		)?.get?.call(body);
		return {
			body: '[Binary body omitted: Blob]',
			...(typeof blobSize === 'number' && Number.isFinite(blobSize)
				? { capturedBytes: blobSize }
				: {}),
			complete: false,
			omitted: true,
		};
	}
	if (
		typeof ArrayBuffer !== 'undefined' &&
		body instanceof ArrayBuffer &&
		Object.getPrototypeOf(body) === ArrayBuffer.prototype
	) {
		const byteLength = Object.getOwnPropertyDescriptor(
			ArrayBuffer.prototype,
			'byteLength',
		)?.get?.call(body);
		return {
			body: '[Binary body omitted]',
			...(typeof byteLength === 'number' && Number.isFinite(byteLength)
				? { capturedBytes: byteLength }
				: {}),
			complete: false,
			omitted: true,
		};
	}
	const viewBytes = arrayBufferViewByteLength(body);
	if (viewBytes !== undefined) {
		return {
			body: '[Binary body omitted: ArrayBufferView]',
			capturedBytes: viewBytes,
			complete: false,
			omitted: true,
		};
	}
	return {
		body: '[Unsupported request body omitted]',
		complete: false,
		omitted: true,
	};
}

export function arrayBufferViewByteLength(value: unknown): number | undefined {
	if (typeof ArrayBuffer === 'undefined' || !ArrayBuffer.isView(value)) {
		return undefined;
	}
	try {
		if (typeof DataView !== 'undefined') {
			const dataViewLength = Object.getOwnPropertyDescriptor(
				DataView.prototype,
				'byteLength',
			)?.get?.call(value);
			if (
				typeof dataViewLength === 'number' &&
				Number.isSafeInteger(dataViewLength) &&
				dataViewLength >= 0
			) {
				return dataViewLength;
			}
		}
	} catch {
		// Typed arrays fail the DataView brand check and continue below.
	}
	try {
		if (typeof Uint8Array === 'undefined') return undefined;
		const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
		const typedArrayLength = Object.getOwnPropertyDescriptor(
			typedArrayPrototype,
			'byteLength',
		)?.get?.call(value);
		return typeof typedArrayLength === 'number' &&
			Number.isSafeInteger(typedArrayLength) &&
			typedArrayLength >= 0
			? typedArrayLength
			: undefined;
	} catch {
		return undefined;
	}
}

export function parseContentLength(value: string | null): number | undefined {
	if (value === null || value.length > MAX_CONTENT_LENGTH_CODE_UNITS) {
		return undefined;
	}
	const normalized = value.trim();
	if (normalized === '') return undefined;
	if (!/^[0-9]+$/.test(normalized)) return undefined;
	const parsed = Number(normalized);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export function parseNetworkUrl(rawUrl: string): {
	host: string;
	origin: string;
	path: string;
	pathname: string;
	query: Readonly<Record<string, string | readonly string[]>>;
} {
	try {
		const url = new URL(rawUrl);
		const query = Object.create(null) as Record<string, string | string[]>;
		for (const [key, value] of url.searchParams.entries()) {
			const current = query[key];
			query[key] =
				current === undefined
					? value
					: Array.isArray(current)
						? [...current, value]
						: [current, value];
		}
		return {
			host: url.host,
			origin: url.origin,
			path: `${url.origin}${url.pathname}`,
			pathname: url.pathname,
			query,
		};
	} catch {
		return {
			host: '',
			origin: '',
			path: rawUrl,
			pathname: rawUrl,
			query: {},
		};
	}
}

async function readBoundedTextReader(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<CapturedNetworkBody> {
	let removeAbortListener = (): void => {};
	let capturedBytes = 0;
	try {
		if (signal?.aborted) {
			cancelTextReader(reader);
			return {
				body: '[Body capture cancelled]',
				cancelled: true,
				complete: false,
				observedBytes: capturedBytes,
				omitted: true,
			};
		}
		const aborted = Symbol('body-capture-aborted');
		const abortPromise = signal
			? new Promise<typeof aborted>((resolve) => {
					const onAbort = () => resolve(aborted);
					signal.addEventListener('abort', onAbort, { once: true });
					removeAbortListener = () =>
						signal.removeEventListener('abort', onAbort);
				})
			: undefined;
		const decoder = new TextDecoder();
		const decodedChunks: string[] = [];
		let readCount = 0;
		while (true) {
			if (readCount >= MAX_BODY_CAPTURE_READS) {
				cancelTextReader(reader);
				return {
					body: '[Body omitted: read count limit]',
					complete: false,
					observedBytes: capturedBytes,
					omitted: true,
				};
			}
			readCount += 1;
			const read = reader.read();
			const result = abortPromise
				? await Promise.race([read, abortPromise])
				: await read;
			if (result === aborted) {
				cancelTextReader(reader);
				return {
					body: '[Body capture cancelled]',
					cancelled: true,
					complete: false,
					observedBytes: capturedBytes,
					omitted: true,
				};
			}
			if (result.done) {
				const finalChunk = decoder.decode();
				if (finalChunk !== '') decodedChunks.push(finalChunk);
				return {
					body: decodedChunks.join(''),
					capturedBytes,
					complete: true,
				};
			}
			if (!(result.value instanceof Uint8Array)) {
				cancelTextReader(reader);
				return { complete: false, observedBytes: capturedBytes };
			}
			capturedBytes += result.value.byteLength;
			if (!Number.isSafeInteger(capturedBytes) || capturedBytes > maxBytes) {
				cancelTextReader(reader);
				return {
					body: `[Body omitted: exceeds ${maxBytes} bytes]`,
					complete: false,
					observedBytes: capturedBytes,
					omitted: true,
				};
			}
			if (result.value.byteLength > 0) {
				const decoded = decoder.decode(result.value, { stream: true });
				if (decoded !== '') decodedChunks.push(decoded);
			}
		}
	} catch {
		cancelTextReader(reader);
		return { complete: false, observedBytes: capturedBytes };
	} finally {
		removeAbortListener();
	}
}

function withCompatibleDeclaredSize(
	captured: CapturedNetworkBody,
	declaredBytes: number | undefined,
): CapturedNetworkBody {
	if (
		captured.complete ||
		captured.capturedBytes !== undefined ||
		declaredBytes === undefined ||
		(captured.observedBytes !== undefined &&
			captured.observedBytes > declaredBytes)
	) {
		return captured;
	}
	return { ...captured, capturedBytes: declaredBytes };
}

function cancelTextReader(
	reader: ReadableStreamDefaultReader<Uint8Array>,
): void {
	try {
		void Promise.resolve(reader.cancel()).catch(() => undefined);
	} catch {
		// Cancellation is best-effort on non-standard body streams.
	}
}

export function prepareRequestBodyCapture(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	maxBytes: number,
	captureUnknownLengthBodies: boolean,
	trustedInput = false,
): PreparedNetworkBodyCapture {
	const initializedBody = bodyFromInit(init?.body, maxBytes);
	if (initializedBody !== undefined) {
		return { kind: 'immediate', result: initializedBody };
	}
	if (!isSafelyInspectableRequest(input, trustedInput)) {
		return { kind: 'immediate', result: { complete: true } };
	}
	const intrinsicMethod = safelyInspectRequestMethod(input, trustedInput);
	if (intrinsicMethod === 'GET' || intrinsicMethod === 'HEAD') {
		return { kind: 'immediate', result: { complete: true } };
	}
	if (safelyInspectRequestBody(input, trustedInput) === null) {
		return { kind: 'immediate', result: { complete: true } };
	}
	// `Content-Length` is a forbidden request header, so a `Request` built from a
	// body never carries one. Without the same opt-in the response path uses,
	// every `fetch(new Request(url, { body }))` would report an omitted body —
	// which `UNSAFE_REPLAY_MARKER` then reads as redacted data and blocks replay.
	const contentLength = parseContentLength(
		safelyGetHeaderValue(
			safelyInspectRequestHeaders(input, trustedInput),
			'content-length',
			trustedInput,
		),
	);
	if (contentLength === undefined && !captureUnknownLengthBodies) {
		return {
			kind: 'immediate',
			result: {
				body: '[Body omitted: unknown content length]',
				complete: false,
				omitted: true,
			},
		};
	}
	if (contentLength !== undefined && contentLength > maxBytes) {
		return {
			kind: 'immediate',
			result: {
				body: `[Body omitted: ${contentLength} bytes]`,
				capturedBytes: contentLength,
				complete: false,
				omitted: true,
			},
		};
	}
	return {
		kind: 'deferred',
		start: () => {
			let reader: ReadableStreamDefaultReader<Uint8Array>;
			try {
				const body = safelyInspectRequestBody(
					safelyCloneRequest(input, trustedInput),
					trustedInput,
				);
				if (!body || typeof body.getReader !== 'function') {
					return {
						kind: 'immediate',
						result: {
							body: '[Body omitted: bounded reader unavailable]',
							complete: false,
							omitted: true,
						},
					};
				}
				reader = body.getReader();
			} catch {
				return {
					kind: 'immediate',
					result: {
						body: '[Unreadable request body]',
						complete: false,
						omitted: true,
					},
				};
			}
			return {
				kind: 'task',
				read: async (signal?: AbortSignal) => {
					const captured = await readBoundedTextReader(
						reader,
						maxBytes,
						signal,
					);
					const normalized =
						captured.body === undefined
							? {
									...captured,
									body: '[Unreadable request body]',
									omitted: true as const,
								}
							: captured;
					return withCompatibleDeclaredSize(normalized, contentLength);
				},
			};
		},
	};
}

export function prepareResponseBodyCapture(
	response: Response,
	maxBytes: number,
	captureUnknownLengthBodies: boolean,
	trustedTransport = false,
): PreparedNetworkBodyCapture {
	if (!isSafelyInspectableResponse(response, trustedTransport)) {
		return {
			kind: 'immediate',
			result: {
				body: '[Body omitted: uninspectable response]',
				complete: false,
				omitted: true,
			},
		};
	}
	let contentLength: number | undefined;
	let rawContentType = '';
	let bodyKnownAbsent = false;
	let retainedTrustedBody:
		| Readonly<{ found: false }>
		| Readonly<{
				found: true;
				body?: string | null;
				blobSize?: number;
				opaque?: true;
		  }> = {
		found: false,
	};
	try {
		const responseHeaders = safelyInspectResponseHeaders(
			response,
			trustedTransport,
		);
		contentLength = parseContentLength(
			safelyGetHeaderValue(responseHeaders, 'content-length', trustedTransport),
		);
		rawContentType =
			safelyGetHeaderValue(responseHeaders, 'content-type', trustedTransport) ??
			'';
		if (trustedTransport) {
			const bodyDescriptor = Object.getOwnPropertyDescriptor(
				response,
				'_bodyInit',
			);
			if (bodyDescriptor && 'value' in bodyDescriptor) {
				const body = bodyDescriptor.value;
				let blobSize: number | undefined;
				if (body != null && typeof body === 'object') {
					try {
						const sizeGetter = Object.getOwnPropertyDescriptor(
							Blob.prototype,
							'size',
						)?.get;
						const candidate = sizeGetter?.call(body);
						if (
							typeof candidate === 'number' &&
							Number.isSafeInteger(candidate) &&
							candidate >= 0
						) {
							blobSize = candidate;
						}
					} catch {
						// A non-Blob retained object remains opaque.
					}
				}
				retainedTrustedBody =
					body == null
						? { found: true, body: null }
						: typeof body === 'string'
							? { found: true, body }
							: blobSize !== undefined
								? { found: true, blobSize }
								: { found: true, opaque: true };
				if (
					typeof body === 'string' &&
					body.length <= MAX_RAW_BODY_CODE_UNITS
				) {
					contentLength ??= utf8ByteLength(body);
				} else if (blobSize !== undefined) {
					contentLength ??= blobSize;
				}
			}
		}
		if (
			retainedTrustedBody.found &&
			retainedTrustedBody.body == null &&
			retainedTrustedBody.blobSize === undefined &&
			retainedTrustedBody.opaque !== true
		) {
			bodyKnownAbsent = true;
		} else if (!retainedTrustedBody.found) {
			try {
				// Only a branded WHATWG Response can use the intrinsic without
				// invoking an adapter's potentially allocating `body` getter. Expo
				// adapters are inspected only from an admitted clone below.
				bodyKnownAbsent =
					prototypeGetterValue<ReadableStream<Uint8Array> | null>(
						Response.prototype,
						'body',
						response,
					) === null;
			} catch {
				bodyKnownAbsent = false;
			}
		}
	} catch {
		return {
			kind: 'immediate',
			result: {
				body: '[Unreadable response body]',
				complete: false,
				omitted: true,
			},
		};
	}
	if (bodyKnownAbsent) {
		return {
			kind: 'immediate',
			result: { capturedBytes: contentLength ?? 0, complete: true },
		};
	}
	if (contentLength !== undefined && contentLength > maxBytes) {
		return {
			kind: 'immediate',
			result: {
				body: `[Body omitted: ${contentLength} bytes]`,
				capturedBytes: contentLength,
				complete: false,
				omitted: true,
			},
		};
	}
	if (rawContentType.length > MAX_HEADER_VALUE_BYTES) {
		return {
			kind: 'immediate',
			result: {
				body: '[Binary body omitted: content type exceeds capture limit]',
				...(contentLength === undefined
					? {}
					: { capturedBytes: contentLength }),
				complete: false,
				omitted: true,
			},
		};
	}
	const contentType = rawContentType.toLowerCase();
	if (!isTextualNetworkContentType(contentType)) {
		return {
			kind: 'immediate',
			result: {
				body: '[Binary body omitted: non-textual content type]',
				...(contentLength === undefined
					? {}
					: { capturedBytes: contentLength }),
				complete: false,
				omitted: true,
			},
		};
	}
	if (retainedTrustedBody.found) {
		if (retainedTrustedBody.opaque) {
			return {
				kind: 'immediate',
				result: {
					body: '[Body omitted: unsupported trusted response body]',
					...(contentLength === undefined
						? {}
						: { capturedBytes: contentLength }),
					complete: false,
					omitted: true,
				},
			};
		}
		if (retainedTrustedBody.body == null) {
			const retainedBlobSize = retainedTrustedBody.blobSize;
			if (retainedBlobSize !== undefined) {
				if (retainedBlobSize > maxBytes) {
					return {
						kind: 'immediate',
						result: {
							body: `[Body omitted: ${retainedBlobSize} bytes]`,
							capturedBytes: retainedBlobSize,
							complete: false,
							omitted: true,
						},
					};
				}
				return {
					kind: 'deferred',
					start: () => ({
						kind: 'task',
						timeoutResult: {
							body: '[Body capture cancelled]',
							capturedBytes: retainedBlobSize,
							complete: false,
							omitted: true,
						},
						read: async (signal?: AbortSignal) => {
							let cancelled = signal?.aborted === true;
							const onAbort = (): void => {
								cancelled = true;
							};
							signal?.addEventListener('abort', onAbort, { once: true });
							try {
								const clone = safelyCloneResponse(response, true);
								// Blob.text() has no cancellation API. Wait for the native read to
								// finish so the caller's bounded work slot remains occupied, while
								// the abort flag prevents its late value from becoming authoritative.
								const text = await Promise.resolve(clone.text());
								if (cancelled) {
									return {
										body: '[Body capture cancelled]',
										capturedBytes: retainedBlobSize,
										complete: false,
										omitted: true,
									};
								}
								if (
									typeof text !== 'string' ||
									text.length > MAX_RAW_BODY_CODE_UNITS ||
									utf8ByteLength(text) > maxBytes
								) {
									return {
										body: '[Body omitted: trusted response text limit]',
										capturedBytes: retainedBlobSize,
										complete: false,
										omitted: true,
									};
								}
								return {
									body: text,
									capturedBytes: retainedBlobSize,
									complete: true,
								};
							} catch {
								if (cancelled) {
									return {
										body: '[Body capture cancelled]',
										capturedBytes: retainedBlobSize,
										complete: false,
										omitted: true,
									};
								}
								return {
									body: '[Unreadable response body]',
									capturedBytes: retainedBlobSize,
									complete: false,
									omitted: true,
								};
							} finally {
								signal?.removeEventListener('abort', onAbort);
							}
						},
					}),
				};
			}
			return {
				kind: 'immediate',
				result: { capturedBytes: contentLength ?? 0, complete: true },
			};
		}
		if (retainedTrustedBody.body.length > MAX_RAW_BODY_CODE_UNITS) {
			return {
				kind: 'immediate',
				result: {
					body: '[Body omitted: input limit]',
					complete: false,
					omitted: true,
				},
			};
		}
		const bodyBytes = utf8ByteLength(retainedTrustedBody.body);
		return {
			kind: 'immediate',
			result:
				bodyBytes > maxBytes
					? {
							body: `[Body omitted: ${bodyBytes} bytes]`,
							capturedBytes: bodyBytes,
							complete: false,
							omitted: true,
						}
					: {
							body: retainedTrustedBody.body,
							capturedBytes: bodyBytes,
							complete: true,
						},
		};
	}
	if (contentLength === undefined && !captureUnknownLengthBodies) {
		return {
			kind: 'immediate',
			result: {
				body: '[Body omitted: unknown content length]',
				complete: false,
				omitted: true,
			},
		};
	}
	return {
		kind: 'deferred',
		start: () => {
			let reader: ReadableStreamDefaultReader<Uint8Array>;
			try {
				const body = safelyInspectResponseBody(
					safelyCloneResponse(response, trustedTransport),
					trustedTransport,
				);
				if (!body || typeof body.getReader !== 'function') {
					return {
						kind: 'immediate',
						result: {
							body: '[Body omitted: bounded reader unavailable]',
							...(contentLength === undefined
								? {}
								: { capturedBytes: contentLength }),
							complete: false,
							omitted: true,
						},
					};
				}
				reader = body.getReader();
			} catch {
				return {
					kind: 'immediate',
					result: {
						body: '[Unreadable response body]',
						...(contentLength === undefined
							? {}
							: { capturedBytes: contentLength }),
						complete: false,
						omitted: true,
					},
				};
			}
			return {
				kind: 'task',
				read: async (signal?: AbortSignal) => {
					const captured = await readBoundedTextReader(
						reader,
						maxBytes,
						signal,
					);
					const normalized =
						captured.body === undefined
							? {
									...captured,
									body: '[Body omitted: unreadable response stream]',
									omitted: true as const,
								}
							: captured;
					return withCompatibleDeclaredSize(normalized, contentLength);
				},
			};
		},
	};
}

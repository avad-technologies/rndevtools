import {
	createKeyWalker,
	isSensitiveKeyName,
	redactWithinWindow,
	stringObjectText,
	VALUE_OMITTED,
	VALUE_UNITS,
} from './bounded-redaction';

// Some secrets have no shape a value rule can recognize (root keys and S3
// signatures are bare hex), so their names alone mark them as sensitive.
const SENSITIVE_KEY =
	/(?:authorization|cookie|csrf|jwt|token|secret|password|passcode|session|api[-_]?key|service[-_]?role[-_]?key|root[-_]?key|db[-_]?url|x[-_]?amz[-_]?(?:credential|signature)|email|phone|user[-_]?id)/i;
// Starts only where a run of address characters begins, so a long run with no
// `@`, such as base64url or dotted ids, is scanned once instead of from every
// word boundary inside it, which took time quadratic in its length. The group
// keeps the leading punctuation that a `\b` start used to leave outside the
// match.
const EMAIL =
	/(?<![A-Z0-9._%+-])([.%+-]*)[A-Z0-9_][A-Z0-9._%+-]*@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
// The lookbehind reads the original text, so EMAIL cannot start an address
// that directly follows another one, as in `a@example.com%20b@example.org`.
// The `\b` start could, right where the previous address ends, so
// redactEmails retries there and, as that start did, replaces the joiner
// along with the address.
const ADJACENT_EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iy;
const BEARER = /\bBearer\s+[A-Za-z\d._~+/=-]+/gi;
// The signature may be empty: an unsigned token still carries its claims.
// The claims group is optional so that an `eyJ` run that is not a token still
// matches and the scan resumes after it, instead of retrying at every `-eyJ`
// inside it; redactDiagnosticText keeps such a run unchanged.
const JWT = /\beyJ[A-Za-z\d_-]+(\.[A-Za-z\d_-]+\.[A-Za-z\d_-]*)?/g;
// Supabase secret API keys, under any name and inside encoded text. There is
// deliberately no rule for bare 64-hex values: stack ids have that shape.
const SECRET_API_KEY = /sb_secret_[A-Za-z\d_-]+/g;
// Keeps the user and the address. The password runs to the last `@` of the
// authority, because unencoded `@` in passwords is common, but never past a
// quote, so it cannot swallow the rest of a JSON document. The user may hold
// an `@` too, as an email address does. A password that is exactly a marker,
// as another layer or an earlier redaction left it, such as a URL-encoded one,
// is left as it is: no `@` follows the marker's in the authority. One that
// only starts with a marker is redacted.
const URL_PASSWORD =
	/(\/\/[^\s:/?#"`<>\\]*):(?!(?:\[|%5B)REDACTED(?:\]|%5D)@[^\s/?#"`<>\\@]*(?![^\s/?#"`<>\\]))[^\s/?#"`<>\\]*@/gi;
// Skips a value that is only a marker, an ellipsis that a cut appended, or
// both, so that redacting redacted text changes nothing. `valueCharacter` is
// what the rule's value is made of.
function unlessRedacted(valueCharacter: string): string {
	return `(?!(?:\\[REDACTED\\])?…?(?!${valueCharacter}))`;
}
// `code` (PKCE and OAuth codes) is too generic a name to redact everywhere, so
// it counts only as a query or fragment parameter.
const CREDENTIAL_PARAMETER = new RegExp(
	`([?&#;]code=)${unlessRedacted(`[^&#;\\s"'<>]`)}[^&#;\\s"'<>]+`,
	'gi',
);
// Mirrors the credential parameters Supabase's own gateway redacts
// (supabase/cli packages/stack/src/internal/redact-credentials.ts), plus
// names whose sensitive word is followed by more of the name, such as
// SECRET_KEY or SERVICE_ROLE_KEY.
const SENSITIVE_NAME =
	'(?:authorization|cookie|csrf|jwt|(?:access|refresh|id)[-_]?token|token(?:[-_]?hash)?|client[-_]?secret|secret(?:[-_]?(?:access[-_]?)?key)?|service[-_]?role[-_]?key|root[-_]?key|db[-_]?url|x[-_]amz[-_](?:credential|signature)|password|passcode|session(?:[-_]?id)?|api[-_]?key|email|phone|user[-_]?id)';
// A name and what separates it from its value.
function assignment(name: string): string {
	return `(["']?${name}["']?\\s*[=:]\\s*)`;
}
const SECRET_ASSIGNMENT = assignment(SENSITIVE_NAME);
// A quoted value is runs with no quote or backslash, joined by escapes. An
// escape may be a backslash and a line terminator, and a value cut right after
// a backslash ends at the end of the text. A run of one character class does
// not grow V8's or Hermes's regexp stack, but each escape of a regexp loop
// does, and a value of about 4 Mi escapes overflowed it. So these find only
// where a value starts, and redactQuotedSecrets matches the value in steps of
// at most 1,024 escapes, which bounds the stack whatever its length.
const DOUBLE_QUOTED_SECRET_START = new RegExp(`${SECRET_ASSIGNMENT}"`, 'gi');
const DOUBLE_QUOTED_VALUE_STEP = /[^"\\]*(?:\\[\s\S][^"\\]*){0,1024}/y;
const SINGLE_QUOTED_SECRET_START = new RegExp(`${SECRET_ASSIGNMENT}'`, 'gi');
const SINGLE_QUOTED_VALUE_STEP = /[^'\\]*(?:\\[\s\S][^'\\]*){0,1024}/y;
// An Authorization value is a scheme word, such as Basic or Digest, and the
// credentials after it on the same line, so the credentials are redacted
// with the scheme. They are one token, or a list of parameters that can hold
// commas and quoted spaces, as Digest's and AWS4-HMAC-SHA256's do, which runs
// to the end of the line. They are a list when they start with `name=` and a
// value that a comma, an `&` or the end of the line follows, after any spaces
// or tabs: a token that starts with an ASCII letter, a digit or one of
// `_+/%.~-` and holds no white space, comma, `&`, `"` or `'`, a quoted
// string, raw or JSON-escaped, that holds at most 1,024 escapes, or a raw one
// that ends at its first quote, whatever backslashes it holds. After a
// JSON-escaped one, the quote that closes the JSON string ends the line too.
// Otherwise the `=` is a token's padding, as in `Basic dXNlcjpwYXM=`, whatever
// follows it.
const LINE_TERMINATORS = '\\r\\n\\u2028\\u2029';
const QUOTED_RUN = `[^"\\\\${LINE_TERMINATORS}]*`;
// The escapes are capped as the quoted-value rules cap theirs, but a lookahead
// cannot resume, so a value of more escapes starts a list only when it is raw
// and ends at its first quote. The first alternative reads it so, as one run
// of one character class, which does not grow the regexp stack however long
// it is.
const QUOTED_PARAMETER_VALUE = `(?:"[^"${LINE_TERMINATORS}]*"|"${QUOTED_RUN}(?:\\\\[^${LINE_TERMINATORS}]${QUOTED_RUN}){0,1024}")`;
// Opened and closed by `\"`. An escape in it is a JSON escape other than `\"`,
// or `\\` and the character or JSON escape after it, which that backslash
// escapes in the header.
const JSON_QUOTED_PARAMETER_VALUE = `\\\\"${QUOTED_RUN}(?:\\\\(?:[^"\\\\${LINE_TERMINATORS}]|\\\\(?:[^"\\\\${LINE_TERMINATORS}]|\\\\[^${LINE_TERMINATORS}]))${QUOTED_RUN}){0,1024}\\\\"`;
const AUTHORIZATION_PARAMETER_VALUE = `(?:${QUOTED_PARAMETER_VALUE}|[A-Z\\d_+/%.~-][^\\s,&"']*)[ \\t]*(?:[,&${LINE_TERMINATORS}]|$)|${JSON_QUOTED_PARAMETER_VALUE}[ \\t]*(?:[,&"${LINE_TERMINATORS}]|$)`;
const AUTHORIZATION_SCHEME_ASSIGNMENT = new RegExp(
	`${assignment('authorization')}(?!["'])[A-Z][A-Z\\d-]*[ \\t]+(?:[^&,}\\s=]+=(?=${AUTHORIZATION_PARAMETER_VALUE})[^\\r\\n\\u2028\\u2029]*|[^&,}\\s]+)`,
	'gi',
);
// A `Bearer` scheme's token runs as far as any other value, so what follows
// the marker always ends a value, and a second redaction leaves it. So does
// the redacted password of a URL whose user is a sensitive name, as in
// `//token:[REDACTED]@host`. Anywhere else, a value that only starts with a
// marker is redacted.
const UNQUOTED_SECRET_ASSIGNMENT = new RegExp(
	`${SECRET_ASSIGNMENT}(?!["']|(?<=\\/\\/[^\\s:/?#"\`<>\\\\]*:)\\[REDACTED\\]@)${unlessRedacted('[^&,}\\s]')}(?:Bearer\\s+)?[^&,}\\s]+`,
	'gi',
);
const MAX_DEPTH = 8;
const MAX_ENTRIES = 100;
// What one projection charges before it omits what is left, in code units:
// every code unit it tests or redacts, or of a key it copies again, and
// `VALUE_UNITS` for every value, hole and accessor it reads and for every key
// it lists. Once it is spent, the texts, objects and bigints still reached
// are omitted, and so are the keys of more than 1 Ki code units. The walk
// visits an object shared by many paths once per path, so without this, a
// value that shares one object widely never finished. It is twice what the
// Console plugin charges the attributes of an event, whose copy it walks.
const MAX_SANITIZED_UNITS = 4 * 1024 * 1024;
// The most UTF-8 bytes of one string that a projection keeps, and of the text
// of a thrown value. A longer string is redacted through a bounded window,
// which redacts at most 2.32 Mi code units however long the string is. It is
// 64 KiB more than the largest limit a built-in caller keeps, 1 MiB of
// Console attributes or of a TanStack Query or Zustand snapshot, so what they
// keep is never cut here first.
const MAX_SANITIZED_TEXT_BYTES = (1024 + 64) * 1024;
// The most decimal digits of a bigint that a projection or the text of a
// thrown value writes. Converting one costs time that grows faster than its
// digits, so a longer one is omitted unconverted.
const MAX_BIGINT_DIGITS = 1024;
// The most code units of its description that the text of a thrown symbol is
// made of. The window redacts a text longer than 2.32 Mi code units from its
// first 1.2 Mi, so the cut changes nothing that is kept.
const MAX_THROWN_DESCRIPTION_UNITS = 4 * 1024 * 1024;
/**
 * Stands in for a property whose getter is never run. A release bundle keeps
 * string literals, so `rndevtools-verify-bundle` looks for this one to find
 * this module, and `/serialize`, which loads it.
 */
const ACCESSOR_OMITTED = '[Accessor omitted]';
const TYPED_ARRAY_PROTOTYPE: object | null =
	typeof Uint8Array === 'undefined'
		? null
		: Object.getPrototypeOf(Uint8Array.prototype);

function intrinsicGetterValue(
	prototype: object | null,
	key: PropertyKey,
	receiver: object,
): unknown {
	const getter = prototype
		? Object.getOwnPropertyDescriptor(prototype, key)?.get
		: undefined;
	return getter ? Reflect.apply(getter, receiver, []) : undefined;
}

/**
 * Names and sizes a typed array or DataView instead of walking it. A typed
 * array exposes every element as an own property, so the descriptor walk would
 * copy a multi-megabyte buffer only to keep 100 entries. The intrinsic
 * accessors read here cannot be shadowed by the instance.
 */
function binaryViewSummary(view: ArrayBufferView): Record<string, unknown> {
	const typedArrayName = intrinsicGetterValue(
		TYPED_ARRAY_PROTOTYPE,
		Symbol.toStringTag,
		view,
	);
	const isTypedArray = typeof typedArrayName === 'string';
	const byteLength = intrinsicGetterValue(
		isTypedArray ? TYPED_ARRAY_PROTOTYPE : DataView.prototype,
		'byteLength',
		view,
	);
	return {
		type: isTypedArray ? typedArrayName : 'DataView',
		...(typeof byteLength === 'number' ? { byteLength } : {}),
	};
}

// 10 ** MAX_BIGINT_DIGITS, made when a bigint is first met, as an engine
// without BigInt never does.
let bigIntDigitLimit: bigint | undefined;

/**
 * The digits of a bigint, or undefined for one of more than
 * `MAX_BIGINT_DIGITS`. The comparisons cost little: one with a longer bigint
 * ends at its size.
 */
function boundedBigIntText(value: bigint): string | undefined {
	bigIntDigitLimit ??= BigInt(`1${'0'.repeat(MAX_BIGINT_DIGITS)}`);
	return -bigIntDigitLimit < value && value < bigIntDigitLimit
		? `${value}`
		: undefined;
}

function normalizedKey(value: string): string {
	return value.replace(/[^a-z\d]/gi, '').toLowerCase();
}

export function isSensitiveDiagnosticKey(value: string): boolean {
	return SENSITIVE_KEY.test(value) || SENSITIVE_KEY.test(normalizedKey(value));
}

/** Replaces every address in one pass, including runs of adjacent ones. */
function redactEmails(value: string): string {
	const parts: string[] = [];
	let copied = 0;
	EMAIL.lastIndex = 0;
	for (let match = EMAIL.exec(value); match; match = EMAIL.exec(value)) {
		parts.push(
			value.slice(copied, match.index),
			match[1] ?? '',
			'[REDACTED EMAIL]',
		);
		let end = EMAIL.lastIndex;
		ADJACENT_EMAIL.lastIndex = end;
		while (ADJACENT_EMAIL.test(value)) {
			parts.push('[REDACTED EMAIL]');
			end = ADJACENT_EMAIL.lastIndex;
		}
		copied = end;
		EMAIL.lastIndex = end;
	}
	if (copied === 0) return value;
	parts.push(value.slice(copied));
	return parts.join('');
}

/**
 * Replaces the quoted value after each sensitive name with `[REDACTED]` in
 * the same quotes. The value ends at its first unescaped quote, or at the end
 * of the text, exactly where one regexp would end it that follows `start`
 * with `[^"\\]*(?:\\[\s\S][^"\\]*)*(?:"|\\?$)` for double quotes.
 */
function redactQuotedSecrets(
	text: string,
	start: RegExp,
	step: RegExp,
	quote: string,
): string {
	const parts: string[] = [];
	let copied = 0;
	start.lastIndex = 0;
	for (let match = start.exec(text); match; match = start.exec(text)) {
		let end = start.lastIndex;
		// A step stops at the closing quote, at the end of the text, at a
		// backslash that ends the text, or after its last escape.
		do {
			step.lastIndex = end;
			end = step.test(text) ? step.lastIndex : text.length;
		} while (end < text.length - 1 && text[end] !== quote);
		parts.push(
			text.slice(copied, match.index),
			match[1] ?? '',
			quote,
			'[REDACTED]',
			quote,
		);
		copied = Math.min(end + 1, text.length);
		start.lastIndex = copied;
	}
	if (copied === 0) return text;
	parts.push(text.slice(copied));
	return parts.join('');
}

export function redactDiagnosticText(value: string): string {
	return redactEmails(
		redactQuotedSecrets(
			redactQuotedSecrets(
				value,
				DOUBLE_QUOTED_SECRET_START,
				DOUBLE_QUOTED_VALUE_STEP,
				'"',
			),
			SINGLE_QUOTED_SECRET_START,
			SINGLE_QUOTED_VALUE_STEP,
			"'",
		)
			.replace(AUTHORIZATION_SCHEME_ASSIGNMENT, '$1[REDACTED]')
			.replace(UNQUOTED_SECRET_ASSIGNMENT, '$1[REDACTED]')
			.replace(CREDENTIAL_PARAMETER, '$1[REDACTED]')
			.replace(URL_PASSWORD, '$1:[REDACTED]@')
			.replace(BEARER, 'Bearer [REDACTED]')
			.replace(SECRET_API_KEY, '[REDACTED SECRET KEY]')
			.replace(JWT, (run: string, claims: string | undefined) =>
				claims === undefined ? run : '[REDACTED JWT]',
			),
	);
}

/**
 * Converts arbitrary thrown values into redacted text without trusting
 * coercion. The text is redacted through a bounded window and kept up to
 * `MAX_SANITIZED_TEXT_BYTES`, as a projection keeps a string, and a bigint of
 * more than `MAX_BIGINT_DIGITS` digits is omitted unconverted.
 */
export function diagnosticErrorText(error: unknown): string {
	let message = 'Unknown error';
	try {
		if (typeof error === 'string') {
			message = error;
		} else if (typeof error === 'number' || typeof error === 'boolean') {
			message = String(error);
		} else if (typeof error === 'bigint') {
			message = boundedBigIntText(error) ?? VALUE_OMITTED;
		} else if (typeof error === 'symbol') {
			// What String() makes of it, from no more of its description than
			// can change what is kept.
			const description = error.description ?? '';
			message =
				description.length > MAX_THROWN_DESCRIPTION_UNITS
					? `Symbol(${description.slice(0, MAX_THROWN_DESCRIPTION_UNITS)}`
					: `Symbol(${description})`;
		} else if (
			error !== null &&
			(typeof error === 'object' || typeof error === 'function')
		) {
			const isError = error instanceof Error;
			// Only these two: listing every descriptor costs time in proportion to
			// the object, such as a String object that lists every index.
			const messageDescriptor = Object.getOwnPropertyDescriptor(
				error,
				'message',
			);
			const nameDescriptor = Object.getOwnPropertyDescriptor(error, 'name');
			if (
				messageDescriptor &&
				'value' in messageDescriptor &&
				typeof messageDescriptor.value === 'string' &&
				messageDescriptor.value
			) {
				message = messageDescriptor.value;
			} else if (
				nameDescriptor &&
				'value' in nameDescriptor &&
				typeof nameDescriptor.value === 'string' &&
				nameDescriptor.value
			) {
				message = nameDescriptor.value;
			} else if (isError) {
				message = 'Error';
			}
		}
	} catch {
		// Proxies can reject descriptor inspection; never fall back to coercion.
	}
	return redactWithinWindow(
		message,
		MAX_SANITIZED_TEXT_BYTES,
		redactDiagnosticText,
	).text;
}

export type DiagnosticSanitization = {
	value: unknown;
	truncated: boolean;
	redacted: boolean;
};

/**
 * Produces a detached JSON-compatible diagnostic projection. Accessors are
 * never invoked, cycles are labeled, and credential/PII-shaped fields are
 * removed before a caller serializes or stores the result. Keys are redacted
 * with the same rules as values and bounded. The work is bounded too: what is
 * left once `MAX_SANITIZED_UNITS` are charged is omitted, and no text costs
 * more than one window.
 */
export function sanitizeDiagnosticValueWithMetadata(
	value: unknown,
): DiagnosticSanitization {
	const seen = new WeakSet<object>();
	const budget = { units: MAX_SANITIZED_UNITS };
	const walkKey = createKeyWalker(
		redactDiagnosticText,
		isSensitiveDiagnosticKey,
	);
	let truncated = false;
	let redacted = false;

	const redactNoting = (text: string): string => {
		const output = redactDiagnosticText(text);
		if (output !== text) redacted = true;
		return output;
	};

	// A text found once the budget is spent is omitted, so no redaction of a
	// text starts past it.
	const redactText = (text: string): string => {
		if (budget.units <= 0) {
			truncated = true;
			return VALUE_OMITTED;
		}
		const bounded = redactWithinWindow(
			text,
			MAX_SANITIZED_TEXT_BYTES,
			redactNoting,
			budget,
		);
		if (bounded.truncated) truncated = true;
		return bounded.text;
	};

	// A value without text costs a value too, so that an array of them runs
	// out. It is kept even once the budget is spent: no object is opened after
	// that, so only the ones already open can list more.
	const kept = <T>(output: T): T => {
		budget.units -= VALUE_UNITS;
		return output;
	};

	// A Map keyed by name holds fields, as an object does, so a value whose key
	// is a credential name is hidden as well. Once the budget is spent the
	// entry is omitted whole, so its key is not tested.
	const visibleEntry = (entry: unknown): unknown => {
		const key = Array.isArray(entry) ? entry[0] : undefined;
		if (
			typeof key !== 'string' ||
			budget.units <= 0 ||
			!isSensitiveKeyName(key, isSensitiveDiagnosticKey, budget)
		) {
			return entry;
		}
		redacted = true;
		return [key, '[REDACTED]'];
	};

	const visit = (current: unknown, depth: number): unknown => {
		if (
			current === null ||
			typeof current === 'boolean' ||
			typeof current === 'number'
		) {
			return kept(current);
		}
		if (typeof current === 'undefined') return kept('[Undefined]');
		if (typeof current === 'function') return kept('[Function]');
		if (budget.units <= 0) {
			truncated = true;
			return VALUE_OMITTED;
		}
		budget.units -= VALUE_UNITS;
		if (typeof current === 'string') return redactText(current);
		if (typeof current === 'bigint') {
			const digits = boundedBigIntText(current);
			if (digits === undefined) {
				truncated = true;
				return VALUE_OMITTED;
			}
			budget.units -= digits.length;
			return `${digits}n`;
		}
		if (typeof current === 'symbol') {
			// The description is text, which the host chose.
			const description = current.description;
			return description ? `Symbol(${redactText(description)})` : 'Symbol()';
		}
		if (depth >= MAX_DEPTH) {
			truncated = true;
			return '[Depth limit]';
		}
		if (typeof current !== 'object') return String(current);
		try {
			if (current instanceof Date) {
				const timestamp = Date.prototype.getTime.call(current);
				return Number.isFinite(timestamp)
					? Date.prototype.toISOString.call(current)
					: '[Invalid Date]';
			}
			if (current instanceof Map || current instanceof Set) {
				const isMap = current instanceof Map;
				// Neither exposes entries as own properties, so the descriptor walk
				// below would render every Map/Set as an empty object. Only the
				// entries kept are read: spreading every entry first cost time in
				// proportion to the size of the collection.
				const iterator: Iterator<unknown> = isMap
					? Map.prototype.entries.call(current)
					: Set.prototype.values.call(current);
				const entries: unknown[] = [];
				for (let next = iterator.next(); !next.done; next = iterator.next()) {
					if (entries.length === MAX_ENTRIES) {
						truncated = true;
						break;
					}
					entries.push(isMap ? visibleEntry(next.value) : next.value);
				}
				const size = intrinsicGetterValue(
					isMap ? Map.prototype : Set.prototype,
					'size',
					current,
				);
				return {
					type: isMap ? 'Map' : 'Set',
					size: typeof size === 'number' ? size : entries.length,
					entries: entries.map((entry) => visit(entry, depth + 1)),
				};
			}
			if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(current)) {
				// The summary omits the contents, so the projection is incomplete.
				truncated = true;
				return binaryViewSummary(current);
			}
			if (current instanceof Error) {
				// Only these three: listing every descriptor costs time in
				// proportion to the object.
				const dataText = (key: 'name' | 'message' | 'stack') => {
					const descriptor = Object.getOwnPropertyDescriptor(current, key);
					return descriptor &&
						'value' in descriptor &&
						typeof descriptor.value === 'string'
						? redactText(descriptor.value)
						: undefined;
				};
				return {
					name: dataText('name') ?? 'Error',
					message: dataText('message') ?? '[Error message unavailable]',
					stack: dataText('stack'),
				};
			}
			const text = stringObjectText(current);
			if (text !== undefined) return redactText(text);
		} catch {
			truncated = true;
			return '[Unreadable object]';
		}
		if (seen.has(current)) {
			truncated = true;
			return '[Circular]';
		}
		seen.add(current);
		try {
			return visitObject(current, depth);
		} finally {
			// `seen` tracks the ancestor path, not every object ever visited.
			// Leaving entries behind would report a value referenced twice in the
			// same tree — a diamond, not a cycle — as '[Circular]' and would raise
			// a spurious truncation flag on an otherwise complete snapshot.
			seen.delete(current);
		}
	};

	const visitObject = (current: object, depth: number): unknown => {
		// Reads only the descriptors that survive the entry cap. Collecting every
		// descriptor first made a large array or map-shaped object cost time and
		// memory in proportion to its size rather than to the entries kept.
		let isArray: boolean;
		let entryCount: number;
		let entries: (readonly [string, PropertyDescriptor | undefined])[];
		try {
			isArray = Array.isArray(current);
			let keys: readonly string[];
			if (isArray) {
				const lengthDescriptor = Object.getOwnPropertyDescriptor(
					current,
					'length',
				);
				entryCount =
					lengthDescriptor &&
					'value' in lengthDescriptor &&
					typeof lengthDescriptor.value === 'number'
						? lengthDescriptor.value
						: 0;
				keys = Array.from(
					{ length: Math.min(entryCount, MAX_ENTRIES) },
					(_unused, index) => String(index),
				);
			} else {
				keys = Object.keys(current);
				entryCount = keys.length;
				// Listing costs time for every key, however few are kept.
				budget.units -= keys.length * VALUE_UNITS;
			}
			entries = keys
				.slice(0, MAX_ENTRIES)
				.map(
					(key) =>
						[key, Object.getOwnPropertyDescriptor(current, key)] as const,
				);
		} catch {
			truncated = true;
			return '[Unreadable object]';
		}
		if (entryCount > MAX_ENTRIES) truncated = true;
		if (isArray) {
			return entries.map(([, descriptor]) => {
				if (descriptor && 'value' in descriptor) {
					return visit(descriptor.value, depth + 1);
				}
				// A hole and an accessor cost a value each too.
				if (!descriptor) return kept('[Empty]');
				truncated = true;
				return kept(ACCESSOR_OMITTED);
			});
		}
		const output = Object.create(null) as Record<string, unknown>;
		for (const [key, descriptor] of entries) {
			if (!descriptor) continue;
			const stored = walkKey(key, output, budget);
			if (stored.redacted) redacted = true;
			if (stored.truncated) truncated = true;
			if ('value' in descriptor && !stored.omitted && !stored.sensitive) {
				output[stored.key] = visit(descriptor.value, depth + 1);
				continue;
			}
			// A value that is not visited, an accessor among them, costs a value.
			budget.units -= VALUE_UNITS;
			if (stored.omitted) {
				output[stored.key] = VALUE_OMITTED;
			} else if (stored.sensitive) {
				redacted = true;
				output[stored.key] = '[REDACTED]';
			} else {
				truncated = true;
				output[stored.key] = ACCESSOR_OMITTED;
			}
		}
		return output;
	};

	return { value: visit(value, 0), truncated, redacted };
}

export function sanitizeDiagnosticValue(value: unknown): unknown {
	return sanitizeDiagnosticValueWithMetadata(value).value;
}

// Bounds shared by the walks that redact captured values: UTF-8 truncation,
// redaction of a long text through a bounded window, and the keys of the
// objects they copy. It holds no redaction rule, so `redact.ts` can use it
// while `serialize.ts` uses both.

export type SerializedValue = {
	text: string;
	truncated: boolean;
	estimatedBytes: number;
};

/**
 * Walks whole code points while their UTF-8 length fits in `maxBytes` and
 * returns where it stopped. The branches are inlined and nothing is allocated
 * per code point: Hermes interprets development builds, where a helper call or
 * a tuple per character made byte counting dominate a multi-megabyte snapshot.
 */
function utf8Prefix(
	text: string,
	maxBytes: number,
): { end: number; bytes: number } {
	let end = 0;
	let bytes = 0;
	while (end < text.length) {
		const code = text.charCodeAt(end);
		let codePointBytes = 3;
		let codeUnits = 1;
		if (code < 0x80) {
			codePointBytes = 1;
		} else if (code < 0x800) {
			codePointBytes = 2;
		} else if (code >= 0xd800 && code <= 0xdbff) {
			const next = text.charCodeAt(end + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				codePointBytes = 4;
				codeUnits = 2;
			}
		}
		if (bytes + codePointBytes > maxBytes) break;
		bytes += codePointBytes;
		end += codeUnits;
	}
	return { end, bytes };
}

export function utf8ByteLength(text: string): number {
	return utf8Prefix(text, Number.POSITIVE_INFINITY).bytes;
}

export function truncateUtf8(text: string, maxBytes: number): SerializedValue {
	const budget = Number.isFinite(maxBytes)
		? Math.max(0, Math.floor(maxBytes))
		: maxBytes === Number.POSITIVE_INFINITY
			? Number.MAX_SAFE_INTEGER
			: 0;
	const ellipsis = '…';
	const ellipsisBytes = utf8ByteLength(ellipsis);
	const whole = utf8Prefix(text, budget);
	if (whole.end === text.length) {
		return { text, truncated: false, estimatedBytes: whole.bytes };
	}
	if (budget < ellipsisBytes) {
		return { text: '', truncated: true, estimatedBytes: 0 };
	}
	const prefix = utf8Prefix(text, budget - ellipsisBytes);
	return {
		text: `${text.slice(0, prefix.end)}${ellipsis}`,
		truncated: true,
		estimatedBytes: prefix.bytes + ellipsisBytes,
	};
}

// Raw code units by which the second window of a pair outgrows the first. What
// the first window keeps must also start the second one's redaction, where a
// secret of up to this length that the first edge cuts is whole. Such a secret
// is never stored unredacted; a longer one that both edges cut can be.
const REDACTION_CONTEXT_UNITS = 64 * 1024;
// Window pairs grow until the second window reaches this many code units, or
// the kept text plus twice the context if that is more. Redaction costs time
// in proportion to its input.
const MAX_REDACTION_WINDOW_UNITS = 512 * 1024;

/**
 * The text that the redactions of a window and of a longer one start with.
 * The longer one sees whole a secret that the shorter one's edge cut, so they
 * differ from where it starts. The prefix never ends inside one of the longer
 * one's redaction markers either, as a secret can begin with a marker's first
 * characters.
 */
function agreedRedactionPrefix(shorter: string, longer: string): string {
	const length = Math.min(shorter.length, longer.length);
	let end = 0;
	// Whole chunks compare natively, so only the chunk that differs is walked.
	while (
		end + 1024 <= length &&
		longer.startsWith(shorter.slice(end, end + 1024), end)
	) {
		end += 1024;
	}
	while (end < length && shorter.charCodeAt(end) === longer.charCodeAt(end)) {
		end += 1;
	}
	const marker = longer.lastIndexOf('[REDACTED', end - 1);
	if (marker >= 0 && longer.indexOf(']', marker) >= end) end = marker;
	// Never keep the first half of a surrogate pair.
	const last = shorter.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end -= 1;
	return shorter.slice(0, end);
}

/** A text cut to a byte limit, and whether the cut removed any of it. */
type BoundedText = { text: string; truncated: boolean };

/**
 * Redacts only the text that truncation to `maxBytes` can keep, plus some
 * context. Redaction scans all of its input, so an unbounded value would
 * otherwise cost time in proportion to whatever the host logged. A window's
 * redaction counts only as far as the redaction of a window
 * `REDACTION_CONTEXT_UNITS` longer agrees with it. While that is less than
 * `maxBytes` holds, the windows grow, up to `MAX_REDACTION_WINDOW_UNITS`. A
 * value no longer than the two windows of the next pair is redacted whole,
 * which is exact and costs no more. One value redacts at most 1.9 Mi code
 * units in all, or twice `maxBytes` plus 192 Ki if that is more. `budget` is
 * charged for every code unit redacted.
 */
export function redactWithinWindow(
	value: string,
	maxBytes: number,
	redact: (text: string) => string,
	budget?: { units: number },
): BoundedText {
	const redactPrefix = (units: number): string => {
		if (budget) budget.units -= units;
		return redact(value.slice(0, units));
	};
	// Every code unit encodes at least one UTF-8 byte, so the kept text spans at
	// most `maxBytes` code units, and the first window adds the context to it.
	let windowUnits = maxBytes + REDACTION_CONTEXT_UNITS;
	const lastWindowUnits = Math.max(
		windowUnits,
		MAX_REDACTION_WINDOW_UNITS - REDACTION_CONTEXT_UNITS,
	);
	while (value.length > 2 * windowUnits + REDACTION_CONTEXT_UNITS) {
		const agreed = agreedRedactionPrefix(
			redactPrefix(windowUnits),
			redactPrefix(windowUnits + REDACTION_CONTEXT_UNITS),
		);
		// Agreed text that overflows `maxBytes` is what the whole value keeps.
		const result = truncateUtf8(agreed, maxBytes);
		if (result.truncated) return result;
		if (windowUnits >= lastWindowUnits) {
			// Truncating after the ellipsis is appended keeps it within `maxBytes`.
			return { ...truncateUtf8(`${agreed}…`, maxBytes), truncated: true };
		}
		// Once the window is within a factor of four of the last one, go straight
		// to it: a pair just short of the last would cost almost as much.
		windowUnits =
			4 * windowUnits > lastWindowUnits ? lastWindowUnits : 2 * windowUnits;
	}
	// The next pair would redact at least as much as the whole value: redact it
	// exactly. A code unit encodes at most three UTF-8 bytes, so a short text
	// needs no count.
	const whole = redactPrefix(value.length);
	return whole.length * 3 <= maxBytes
		? { text: whole, truncated: false }
		: truncateUtf8(whole, maxBytes);
}

/** The longest key that a walk stores unless it sets its own, in UTF-8 bytes. */
const MAX_KEY_BYTES = 1024;
// The longest key whose name a walk tests. A longer key's name could mark its
// value as sensitive past what a test reads, so that value is redacted.
const MAX_KEY_TEST_UNITS = 64 * 1024;
// What the redaction rules write. A key test skips them, and a marker that a
// cut left open, since `[REDACTED EMAIL]` is not a field named `email`.
const REDACTION_MARKER = /\[REDACTED[A-Z _]*[\]…]/g;
/**
 * What a walk charges its budget for each value, hole or accessor it reads and
 * for each key it lists.
 */
export const VALUE_UNITS = 16;
export const VALUE_OMITTED = '[Value omitted: input limit]';
const KEY_OMITTED = '[Key omitted: input limit]';

// The copy number to try next for a key of an output object, so that numbering
// a hundred copies of one key costs a hundred probes rather than thousands.
const nextCopies = new WeakMap<object, Map<string, number>>();

/**
 * `key`, or the first numbered copy of it, within `maxBytes`, that `output`
 * does not hold yet. The number leads, as in `(2) token:`: no rule reads it as
 * a value there, where after a key that ends in an assignment with no value a
 * second pass would redact it.
 */
function distinctKey(output: object, key: string, maxBytes: number): string {
	if (!Object.hasOwn(output, key)) return key;
	let copies = nextCopies.get(output);
	if (!copies) {
		copies = new Map();
		nextCopies.set(output, copies);
	}
	let base = key;
	let baseBytes = Number.NaN;
	for (let copy = copies.get(key) ?? 2; ; copy += 1) {
		const prefix = `(${copy}) `;
		// The number stays within the cap, and the key is cut only as often as
		// the number gains a digit.
		if (maxBytes - prefix.length !== baseBytes) {
			baseBytes = maxBytes - prefix.length;
			base = truncateUtf8(key, baseBytes).text;
		}
		const candidate = `${prefix}${base}`;
		if (!Object.hasOwn(output, candidate)) {
			copies.set(key, copy + 1);
			return candidate;
		}
	}
}

/**
 * Whether the name `key` marks its value as sensitive, tested on the key as
 * it was logged with any redaction marker in it skipped. A key too long to
 * test whole fails closed. `budget` is charged for every code unit tested.
 */
export function isSensitiveKeyName(
	key: string,
	isSensitive: (name: string) => boolean,
	budget: { units: number },
): boolean {
	if (key.length > MAX_KEY_TEST_UNITS) return true;
	budget.units -= key.length;
	return isSensitive(key.replace(REDACTION_MARKER, ' '));
}

type WalkedKey = {
	key: string;
	omitted: boolean;
	redacted: boolean;
	sensitive: boolean;
	truncated: boolean;
};

export type KeyWalker = (
	key: string,
	output: object,
	budget: { units: number },
) => WalkedKey;

/**
 * Bounds the keys of the objects that one walk copies. The walker returns the
 * key under which to copy the value of `key` into `output`: redacted through a
 * window, cut to `maxKeyBytes`, and numbered when redaction or the cut makes
 * it equal to a key that `output` holds. Whether the value is sensitive is
 * tested on `key` itself. `budget` is charged for every code unit tested or
 * redacted. Once it is spent, a key of more than `maxKeyBytes` code units is
 * not redacted, and stands as an omitted key with an omitted value. A shorter
 * key is tested and redacted once per walk, as records of one shape repeat
 * theirs, and each later copy of it is charged its length, so the keys that a
 * walk writes stay within what it charges however widely one object is shared.
 */
export function createKeyWalker(
	redact: (text: string) => string,
	isSensitive: (name: string) => boolean,
	maxKeyBytes = MAX_KEY_BYTES,
): KeyWalker {
	const known = new Map<
		string,
		Omit<WalkedKey, 'key' | 'omitted'> & { text: string }
	>();
	return (key, output, budget) => {
		if (key.length > maxKeyBytes && budget.units <= 0) {
			return {
				key: distinctKey(output, KEY_OMITTED, maxKeyBytes),
				omitted: true,
				redacted: false,
				sensitive: false,
				truncated: true,
			};
		}
		let walked = known.get(key);
		if (walked) {
			budget.units -= walked.text.length;
		} else {
			let redacted = false;
			const bounded = redactWithinWindow(
				key,
				maxKeyBytes,
				(text) => {
					const output = redact(text);
					if (output !== text) redacted = true;
					return output;
				},
				budget,
			);
			walked = {
				text: bounded.text,
				redacted,
				sensitive: isSensitiveKeyName(key, isSensitive, budget),
				truncated: bounded.truncated,
			};
			if (key.length <= maxKeyBytes) known.set(key, walked);
		}
		return {
			key: distinctKey(output, walked.text, maxKeyBytes),
			omitted: false,
			redacted: walked.redacted,
			sensitive: walked.sensitive,
			truncated: walked.truncated,
		};
	};
}

/**
 * The text of a String object, which lists every index as a key, or undefined
 * for any other object.
 */
export function stringObjectText(value: object): string | undefined {
	try {
		if (!(value instanceof String)) return undefined;
		return String.prototype.valueOf.call(value);
	} catch {
		// `instanceof` reads the prototype, which a revoked proxy, such as a
		// stale Immer draft, refuses, and so can a proxy's trap. A proxy can also
		// claim String.prototype without holding a string. Such a value is
		// walked as the object it is.
		return undefined;
	}
}

import { redactDiagnosticText } from '@rndevtools/core/redact';

/**
 * Text that comes out of the Supabase CLI (stderr progress, error envelopes,
 * service log lines) is untrusted. It can carry terminal control sequences,
 * and service output is not redacted upstream: PostgREST logs full query
 * strings, database logs echo statements, and the CLI's own messages can name
 * credentials. Everything this module returns is safe to show in the renderer
 * or send to an agent: credentials are redacted as the text reads with a
 * separator where each control sequence and invisible formatting character
 * is, which are then removed (redactTerminalText), and the text is bounded.
 */

const ELLIPSIS = '…';

// Supabase secret and publishable API keys under any name. Publishable keys are
// meant to ship in apps, but the desktop never shows key material outside main.
const SUPABASE_API_KEY = /sb_(?:secret|publishable)_[A-Za-z0-9_-]*/g;
// A JWT, or a fragment long enough to be one (an unsigned or cut-off token
// still carries its claims). The lookbehind keeps matching linear.
const JWT_FRAGMENT = /(?<![\w-])eyJ[\w-]{2,}\.[\w-]*(?:\.[\w-]*)?/g;
// Keeps the scheme and the user (`postgresql://postgres:…@`), drops the
// password. The password runs to the last `@` of the authority because
// unencoded `@` in passwords is common, but never past a quote or space.
// Scan a scheme-like run once. Include any leading non-letter characters
// from the run in the replacement so schemes adjacent to them still match.
const URL_PASSWORD =
	/(?<![a-z\d+.-])([\d+.-]*[a-z][a-z\d+.-]*:\/\/[^\s/?#@:'"`<>\\]*):[^\s/?#'"`<>\\]*@/gi;
// The credential parameters Supabase's own gateway redacts
// (packages/stack/src/internal/redact-credentials.ts at v2.121.0).
const CREDENTIAL_PARAMETER =
	/([?&#;](?:apikey|jwt|access_token|token|token_hash|code|refresh_token|id_token|provider_token|provider_refresh_token|x-amz-signature|x-amz-credential|x-amz-security-token)=)[^&#;\s'"<>]*/gi;
// The names the CLI prints credentials under, in env, dotenv, or JSON form,
// also as the tail of a longer name such as MY_SECRET_KEY.
const CREDENTIAL_ASSIGNMENT =
	/(?<![A-Za-z0-9])((?:SUPABASE_(?:AUTH_)?)?(?:SECRET_KEY|SERVICE_ROLE_KEY|ANON_KEY|PUBLISHABLE_KEY|JWT_SECRET|DB_URL|DB_PASSWORD|ROOT_KEY|ACCESS_TOKEN|S3_PROTOCOL_ACCESS_KEY_ID|S3_PROTOCOL_ACCESS_KEY_SECRET)["']?\s*[=:]\s*)("(?:\\.|[^"\\])*"?|'[^']*'?|[^\s,;&}]+)/g;

type SupabaseTextOptions = Readonly<{
	/** Upper bound on the returned length, in UTF-16 code units. */
	maxChars: number;
	/** Keep line breaks (error details); otherwise they become spaces. */
	keepNewlines?: boolean;
}>;

/**
 * Returns `value` with terminal control sequences and invisible characters
 * removed, credentials redacted, and the length bounded. Removing them first
 * would join a token to the word they parted it from, out of the rules'
 * reach, so they go as redactTerminalText removes them.
 */
export function sanitizeSupabaseText(
	value: string,
	options: SupabaseTextOptions
): string {
	return boundText(
		redactTerminalText(
			value,
			options.keepNewlines === true,
			redactSupabaseCredentials
		),
		options.maxChars
	);
}

function redactSupabaseCredentials(value: string): string {
	return redactDiagnosticText(
		value
			.replace(CREDENTIAL_ASSIGNMENT, '$1[REDACTED]')
			.replace(URL_PASSWORD, '$1:[REDACTED]@')
			.replace(CREDENTIAL_PARAMETER, '$1[REDACTED]')
			.replace(SUPABASE_API_KEY, '[REDACTED KEY]')
			.replace(JWT_FRAGMENT, '[REDACTED JWT]')
	);
}

/**
 * `value` cut to at most `maxChars` UTF-16 code units, the cut marked with an
 * ellipsis and never through a surrogate pair.
 */
export function boundText(value: string, maxChars: number): string {
	const limit = Math.max(1, Math.floor(maxChars));
	if (value.length <= limit) return value;
	let end = limit - ELLIPSIS.length;
	const lastUnit = value.charCodeAt(end - 1);
	// Never end on a high surrogate; that would leave a lone surrogate behind.
	if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) end -= 1;
	return `${value.slice(0, Math.max(0, end))}${ELLIPSIS}`;
}

function isInvisible(code: number): boolean {
	return (
		code <= 0x1f ||
		(code >= 0x7f && code <= 0x9f) ||
		code === 0x061c ||
		(code >= 0x200b && code <= 0x200f) ||
		(code >= 0x202a && code <= 0x202e) ||
		(code >= 0x2060 && code <= 0x2069) ||
		code === 0xfeff
	);
}

/**
 * Stands where the shown text leaves an escape sequence or an invisible
 * character out, in the text the redaction rules read. They read a tab as
 * white space, which ends a token and starts a word, and no other tab is
 * there: the input's own are shown, and read, as spaces.
 */
const SEPARATOR = '\t';
/** At least as long as any marker the redaction rules leave. */
const MARKER_WINDOW = 32;
const MARKER_AT_START = /^\[REDACTED(?: [A-Z]+)*\]/;
const MARKER_AT_END = /\[REDACTED(?: [A-Z]+)*\]$/;
/** What the core rules leave in an email address's place. */
const EMAIL_MARKER = '[REDACTED EMAIL]';

/**
 * `value` without terminal escape sequences and invisible characters,
 * redacted by `redact`: the core rules, unless the caller has more. The JWT
 * and Bearer rules start at a word boundary, and Bearer and an
 * Authorization scheme take their token after white space, so removing a
 * sequence or a character must not join what it kept apart: in colored
 * output a token can follow a sequence's final letter with a word right
 * before the sequence, as in `fetching\x1b[32meyJ…`, and a carriage
 * return, a backspace or a zero-width space can part `Bearer` from its
 * token. So the rules read the text with a separator where each sequence
 * or character was, which is then removed, and what is left is redacted
 * again for a token that one split. The raw text is never redacted: a rule
 * can stop inside a sequence, at the `;` of `\x1b[1;32m`, and leave the
 * rest of it on the token. Once the separators go, what one parts from a
 * marker is shown as redacting the joined text would show it: the token
 * characters and the markers after the marker go with it, as the rest of a
 * token the separator split, and so do the address characters before an
 * email marker, whose rule can start inside a word.
 */
export function redactTerminalText(
	value: string,
	keepNewlines: boolean,
	redact: (text: string) => string = redactDiagnosticText
): string {
	return redact(shownText(redact(separatedText(value, keepNewlines))));
}

/**
 * `value` with one SEPARATOR for each run of escape sequences and invisible
 * characters, and its tabs and, unless they are kept, its line breaks as
 * spaces. The sequences are ANSI/VT ones (CSI, OSC, DCS and two-byte
 * escapes), and the characters C0 and C1 controls, bidirectional overrides
 * and zero-width characters. Written as a scanner so no control character
 * ever appears in a regular expression.
 */
function separatedText(value: string, keepNewlines: boolean): string {
	let output = '';
	let separated = false;
	let index = 0;
	while (index < value.length) {
		const code = value.charCodeAt(index);
		let next = index + 1;
		let shown: string | undefined;
		if (code === 0x1b || code === 0x9b) {
			next = skipEscapeSequence(value, index);
		} else if (code === 0x09 || (code === 0x0a && !keepNewlines)) {
			shown = ' ';
		} else if (code === 0x0a || !isInvisible(code)) {
			shown = value[index];
		}
		if (shown !== undefined) {
			output += shown;
		} else if (!separated) {
			output += SEPARATOR;
		}
		separated = shown === undefined;
		index = next;
	}
	return output;
}

/**
 * The redacted `view` as it is shown: without its separators, nor what a
 * separator parts from a marker as the rest of what the marker hides.
 */
function shownText(view: string): string {
	const parts: string[] = [];
	let afterMarker = false;
	let start = 0;
	for (;;) {
		const separator = view.indexOf(SEPARATOR, start);
		const end = separator === -1 ? view.length : separator;
		let from = start;
		if (afterMarker) {
			from = pastTokenAndMarkers(view, start, end);
		} else if (start > 0) {
			// An address's rule starts after any character that cannot be in
			// one, a separator too, and keeps the punctuation that leads it.
			let lead = start;
			while (lead < end && isAddressPunctuation(view.charCodeAt(lead))) {
				lead += 1;
			}
			if (view.startsWith(EMAIL_MARKER, lead) && trimAddressEnd(parts)) {
				from = lead;
			}
		}
		const part = view.slice(from, end);
		if (part) {
			parts.push(part);
			afterMarker = MARKER_AT_END.test(part.slice(-MARKER_WINDOW));
		}
		if (separator === -1) return parts.join('');
		start = separator + 1;
	}
}

/**
 * Where the token characters and markers that start `view` at `index`,
 * before `end`, end, short of the full stops that end them: a sentence's
 * more often than a token's.
 */
function pastTokenAndMarkers(view: string, index: number, end: number): number {
	let at = index;
	for (;;) {
		while (at < end && isTokenCharacter(view.charCodeAt(at))) at += 1;
		const marker = MARKER_AT_START.exec(
			view.slice(at, Math.min(end, at + MARKER_WINDOW))
		);
		if (!marker) break;
		at += marker[0].length;
	}
	while (at > index && view.charCodeAt(at - 1) === 0x2e) at -= 1;
	return at;
}

/**
 * Takes the address characters that end `parts` off it, across parts, and
 * says whether there were any.
 */
function trimAddressEnd(parts: string[]): boolean {
	let trimmed = false;
	for (;;) {
		const last = parts[parts.length - 1];
		if (last === undefined) break;
		let end = last.length;
		while (end > 0 && isAddressCharacter(last.charCodeAt(end - 1))) end -= 1;
		if (end === last.length) break;
		trimmed = true;
		if (end > 0) {
			parts[parts.length - 1] = last.slice(0, end);
			break;
		}
		parts.pop();
	}
	return trimmed;
}

/** Bearer's token characters, which hold a JWT's and a secret key's. */
function isTokenCharacter(code: number): boolean {
	return (
		isWordCharacter(code) ||
		code === 0x2b ||
		code === 0x2d ||
		code === 0x2e ||
		code === 0x2f ||
		code === 0x3d ||
		code === 0x7e
	);
}

/** The characters of an email address before its `@`. */
function isAddressCharacter(code: number): boolean {
	return isWordCharacter(code) || isAddressPunctuation(code);
}

function isAddressPunctuation(code: number): boolean {
	return code === 0x25 || code === 0x2b || code === 0x2d || code === 0x2e;
}

function skipEscapeSequence(value: string, start: number): number {
	if (value.charCodeAt(start) === 0x9b)
		return skipControlSequence(value, start + 1);
	const next = value.charCodeAt(start + 1);
	// `[` starts a control sequence.
	if (next === 0x5b) return skipControlSequence(value, start + 2);
	// `]`, `P`, `X`, `^` and `_` start strings that run to a terminator.
	if (
		next === 0x5d ||
		next === 0x50 ||
		next === 0x58 ||
		next === 0x5e ||
		next === 0x5f
	) {
		return skipControlString(value, start + 2);
	}
	let index = start + 1;
	while (index < value.length) {
		const code = value.charCodeAt(index);
		if (code < 0x20 || code > 0x2f) break;
		index += 1;
	}
	const final = value.charCodeAt(index);
	// A letter right after the ESC with a word character after it starts a
	// word, as a lone ESC before a token's `eyJ` leaves it, more often than
	// it ends a sequence: taking it would cut off the token's first letter,
	// and no rule knows the rest. Such a sequence's letter is shown instead.
	if (
		index === start + 1 &&
		isAsciiLetter(final) &&
		isWordCharacter(value.charCodeAt(index + 1))
	) {
		return index;
	}
	return final >= 0x30 && final <= 0x7e ? index + 1 : index;
}

function isAsciiLetter(code: number): boolean {
	return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isWordCharacter(code: number): boolean {
	return isAsciiLetter(code) || (code >= 0x30 && code <= 0x39) || code === 0x5f;
}

function skipControlSequence(value: string, start: number): number {
	let index = start;
	while (index < value.length) {
		const code = value.charCodeAt(index);
		if (code < 0x20 || code > 0x3f) break;
		index += 1;
	}
	const final = value.charCodeAt(index);
	return final >= 0x40 && final <= 0x7e ? index + 1 : index;
}

function skipControlString(value: string, start: number): number {
	let index = start;
	while (index < value.length) {
		const code = value.charCodeAt(index);
		if (code === 0x07 || code === 0x9c) return index + 1;
		if (code === 0x1b && value.charCodeAt(index + 1) === 0x5c) return index + 2;
		index += 1;
	}
	return index;
}

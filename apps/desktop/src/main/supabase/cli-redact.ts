import { redactDiagnosticText } from '@rndevtools/core/redact';

/**
 * Text that comes out of the Supabase CLI (stderr progress, error envelopes,
 * service log lines) is untrusted. It can carry terminal control sequences,
 * and service output is not redacted upstream: PostgREST logs full query
 * strings, database logs echo statements, and the CLI's own messages can name
 * credentials. Everything this module returns is safe to show in the renderer
 * or send to an agent: control sequences and invisible formatting characters
 * are removed first, then credentials are redacted, then the text is bounded.
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
const URL_PASSWORD =
	/([a-z][a-z\d+.-]*:\/\/[^\s/?#@:'"`<>\\]*):[^\s/?#'"`<>\\]*@/gi;
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
 * removed, credentials redacted, and the length bounded.
 */
export function sanitizeSupabaseText(
	value: string,
	options: SupabaseTextOptions
): string {
	const visible = stripTerminalControls(value, options.keepNewlines === true);
	return boundText(redactSupabaseCredentials(visible), options.maxChars);
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

function boundText(value: string, maxChars: number): string {
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
 * Removes ANSI/VT escape sequences (CSI, OSC, DCS and two-byte escapes), C0
 * and C1 controls, bidirectional overrides and zero-width characters. Written
 * as a scanner so no control character ever appears in a regular expression.
 */
function stripTerminalControls(value: string, keepNewlines: boolean): string {
	let output = '';
	let index = 0;
	while (index < value.length) {
		const code = value.charCodeAt(index);
		if (code === 0x1b || code === 0x9b) {
			index = skipEscapeSequence(value, index);
			continue;
		}
		if (code === 0x0a) {
			output += keepNewlines ? '\n' : ' ';
		} else if (code === 0x09) {
			output += ' ';
		} else if (!isInvisible(code)) {
			output += value[index];
		}
		index += 1;
	}
	return output;
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
	return final >= 0x30 && final <= 0x7e ? index + 1 : index;
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

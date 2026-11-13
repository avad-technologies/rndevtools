import { redactDiagnosticText } from '@rndevtools/core/redact';

/**
 * Text that comes out of the Supabase CLI (stderr progress, error envelopes,
 * service log lines) is untrusted. It can carry terminal control sequences,
 * and service output is not redacted upstream: PostgREST logs full query
 * strings, database logs echo statements, and the CLI's own messages can name
 * credentials. Everything sanitizeSupabaseText returns is safe to show in the
 * renderer or send to an agent: terminal escape sequences, C0 and C1
 * controls, bidirectional controls and zero-width characters are removed,
 * the other characters Unicode says to show as nothing (soft hyphens,
 * variation selectors, fillers, tags) stay but can neither part nor join a
 * credential, credentials are redacted however any of those parted or joined
 * them (redactTerminalText), and the text is bounded.
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
 * Returns `value` without terminal escape sequences, controls, bidirectional
 * controls and zero-width characters, with credentials redacted and the
 * length bounded. The other default-ignorable characters stay.
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

/**
 * Stands for a run of removed sequences and characters in the reading that
 * takes each run as a break between words. The rules read a tab as white
 * space, and no other tab is there: the input's own are shown, and read, as
 * spaces.
 */
const SEPARATOR = '\t';

/**
 * What a redaction rule writes where it hides something: a marker, with the
 * quotes a quoted value's rule writes around it and the `Bearer ` the Bearer
 * rule writes before it, and what a later rule leaves of a marker with words
 * when it redacts the marker's first word again (`[REDACTED] JWT]`). The
 * rules return everything else as they read it, except where a later rule
 * takes part of an earlier marker, as the JWT rule takes the `Bearer` of
 * `Bearer [REDACTED]` after `eyJ….`: hiddenParts then hides the whole
 * difference. The expression can match text the input holds too.
 */
const MARKER =
	/(?:Bearer )?["']?\[REDACTED(?: [A-Z]+)*\](?:(?: [A-Z]+)+\])*["']?/g;

/** What one reading of the text hides, where, and the marker it wrote. */
type Hidden = { start: number; end: number; text: string };

/**
 * `value` as it is shown, without terminal escape sequences, controls,
 * bidirectional controls and zero-width characters, and redacted by
 * `redact`: the core rules, unless the caller has more. The rules start a
 * JWT or a Bearer token at a word boundary and take an Authorization
 * scheme's credentials after white space, so a removed sequence or character
 * can keep a credential from them either way it is read. Read as nothing,
 * one can join a token to the word before it, as in `fetching\x1b[32meyJ…`,
 * or `Bearer` to its token. Read as a break, one can split a token, or keep
 * an Authorization parameter from its `=`. So the rules read the shown text,
 * the shown text with a separator wherever something was removed, the text
 * as it came, and the shown text with a separator only before a JWT or a
 * Bearer token that a run joins to a word, each from the start, and
 * whatever any reading hides is hidden. The other default-ignorable
 * characters stay in the shown text and are read both ways too. A two-byte
 * or nF escape takes its final letter, as a terminal does, and when one sits
 * in or beside a word, every reading but the text as it came is read again
 * with only its ESC gone, as a stray ESC's would be. A token that the shown
 * text runs on with past a removed run or such a character is hidden to its
 * end, short of the full stops that end a sentence more often than a token.
 * When no other reading hides more than the shown text's own, and the text
 * between its markers has one place, the result is that reading's.
 */
export function redactTerminalText(
	value: string,
	keepNewlines: boolean,
	redact: (text: string) => string = redactDiagnosticText
): string {
	const text = terminalText(value, keepNewlines, false);
	const redacted = redact(text.shown);
	const raw = text.cuts.length > 0 || text.spaced;
	// Otherwise every reading is the shown text.
	if (!raw && text.ignorableAt.length === 0) return redacted;
	const shown =
		redacted === text.shown
			? { parts: [], exact: true }
			: hiddenParts(text.shown, redacted);
	const otherParts: Hidden[] = [];
	addReadings(otherParts, text, redact, (at) => at);
	if (raw) addParts(otherParts, value, redact, (at) => rawShown(text, at));
	if (text.strays) {
		const kept = terminalText(value, keepNewlines, true);
		const toShown = (at: number) => rawShown(text, keptRaw(kept, at));
		addParts(otherParts, kept.shown, redact, toShown);
		addReadings(otherParts, kept, redact, toShown);
	}
	if (shown.exact && covered(otherParts, shown.parts, text.shown.length)) {
		return redacted;
	}
	return shownWithMarkers(text, shown.parts, otherParts);
}

/**
 * Adds what `redact` hides in the readings of `text`'s shown text other
 * than the shown text itself: with a break at each removed run and
 * default-ignorable character, without those characters, and with a break
 * only before a token that a run joins to a word. `toShown` maps a position
 * of `text.shown` to the shown text of the whole call.
 */
function addReadings(
	parts: Hidden[],
	text: TerminalText,
	redact: (text: string) => string,
	toShown: (at: number) => number
): void {
	const ignorables = text.ignorableAt.length > 0;
	if (text.cuts.length > 0 || ignorables) {
		addParts(parts, text.separated, redact, (at) =>
			toShown(separatedShown(text, at))
		);
	}
	if (ignorables) {
		addParts(parts, text.unbroken, redact, (at) =>
			toShown(unbrokenShown(text, at))
		);
	}
	// A token that a run joins to the word before it and that another run
	// or character splits: read just the runs and characters before a token
	// that the rules start only after a word boundary as breaks.
	const plain = ignorables ? text.unbroken : text.shown;
	const tokenBreaks = mergedPositions(
		text.cutsUnbroken,
		text.ignorableAt
	).filter((at) => startsToken(plain, at));
	// With a break at every cut and no ignorables, this is the separated
	// reading.
	if (
		tokenBreaks.length > 0 &&
		(tokenBreaks.length < text.cuts.length || ignorables)
	) {
		addParts(parts, withSeparators(plain, tokenBreaks), redact, (at) =>
			toShown(unbrokenShown(text, separatorsShown(tokenBreaks, at)))
		);
	}
}

/**
 * Whether every part of `others` lies within what `parts` hide, in a text
 * of `length` characters.
 */
function covered(others: Hidden[], parts: Hidden[], length: number): boolean {
	if (others.length === 0) return true;
	const depth = new Int32Array(length + 1);
	for (const part of parts) {
		depth[part.start] = (depth[part.start] ?? 0) + 1;
		depth[part.end] = (depth[part.end] ?? 0) - 1;
	}
	// hiddenBefore[n]: how many of the first n characters are hidden.
	const hiddenBefore = new Int32Array(length + 1);
	let open = 0;
	for (let index = 0; index < length; index += 1) {
		open += depth[index] ?? 0;
		hiddenBefore[index + 1] = (hiddenBefore[index] ?? 0) + (open > 0 ? 1 : 0);
	}
	return others.every(
		(part) =>
			(hiddenBefore[part.end] ?? 0) - (hiddenBefore[part.start] ?? 0) ===
			part.end - part.start
	);
}

/**
 * Adds what `redact` hides of the reading `view` to `parts`, where it is in
 * the shown text (`shownAt` maps a position of `view` there).
 */
function addParts(
	parts: Hidden[],
	view: string,
	redact: (text: string) => string,
	shownAt: (at: number) => number
): void {
	const redacted = redact(view);
	if (redacted === view) return;
	for (const part of hiddenParts(view, redacted).parts) {
		const start = shownAt(part.start);
		const end = shownAt(part.end);
		if (end > start) parts.push({ start, end, text: markerOnly(part.text) });
	}
}

/**
 * The marker in a MARKER match, with the `Bearer ` the Bearer rule writes
 * before it, without the quotes and words around it that a reading other
 * than the shown text may have held.
 */
function markerOnly(text: string): string {
	const marker = /\[REDACTED(?: [A-Z]+)*\]/.exec(text)?.[0] ?? '[REDACTED]';
	return text.startsWith('Bearer ') ? `Bearer ${marker}` : marker;
}

/**
 * What `redacted`, a redaction of `view`, hides of it: for each marker, the
 * characters between the text before the marker and the text after it,
 * which the rules return as they read it. Where that text could be read in
 * more than one place, everything that is not shown in each of them counts
 * as hidden. Should `redacted` hold text it did not read, the whole span
 * between the first and the last difference counts as hidden.
 */
function hiddenParts(
	view: string,
	redacted: string
): { parts: Hidden[]; exact: boolean } {
	const markerStarts: number[] = [];
	const markerEnds: number[] = [];
	MARKER.lastIndex = 0;
	for (
		let match = MARKER.exec(redacted);
		match;
		match = MARKER.exec(redacted)
	) {
		markerStarts.push(match.index);
		markerEnds.push(MARKER.lastIndex);
	}
	const count = markerStarts.length;
	const between = (index: number) =>
		redacted.slice(
			index === 0 ? 0 : (markerEnds[index - 1] ?? 0),
			index === count ? redacted.length : (markerStarts[index] ?? 0)
		);
	const head = between(0);
	const tail = between(count);
	const tailStart = view.length - tail.length;
	if (
		count === 0 ||
		tailStart < head.length ||
		!view.startsWith(head) ||
		!view.endsWith(tail)
	) {
		return { parts: [wholeDifference(view, redacted)], exact: false };
	}
	// The text between markers, placed as early as it can be, then as late.
	const earliestEnd = new Int32Array(count);
	earliestEnd[0] = head.length;
	for (let index = 1; index < count; index += 1) {
		const part = between(index);
		const at = firstIndex(view, part, earliestEnd[index - 1] ?? 0);
		if (at === -1 || at + part.length > tailStart) {
			return { parts: [wholeDifference(view, redacted)], exact: false };
		}
		earliestEnd[index] = at + part.length;
	}
	// The earliest placement is one, so the latest is never before it.
	const latestStart = new Int32Array(count + 1);
	latestStart[count] = tailStart;
	let exact = true;
	for (let index = count - 1; index >= 1; index -= 1) {
		const part = between(index);
		const at = lastIndex(
			view,
			part,
			(latestStart[index + 1] ?? 0) - part.length
		);
		// Empty text between two markers shows nothing, wherever it is.
		if (part.length > 0 && at + part.length !== earliestEnd[index]) {
			exact = false;
		}
		latestStart[index] = at;
	}
	return {
		parts: markerStarts.map((start, index) => ({
			start: earliestEnd[index] ?? 0,
			end: latestStart[index + 1] ?? 0,
			text: redacted.slice(start, markerEnds[index] ?? start),
		})),
		exact,
	};
}

/** The one part that holds every difference between `view` and `redacted`. */
function wholeDifference(view: string, redacted: string): Hidden {
	const shorter = Math.min(view.length, redacted.length);
	let start = 0;
	while (
		start < shorter &&
		view.charCodeAt(start) === redacted.charCodeAt(start)
	) {
		start += 1;
	}
	let same = 0;
	while (
		same < shorter - start &&
		view.charCodeAt(view.length - 1 - same) ===
			redacted.charCodeAt(redacted.length - 1 - same)
	) {
		same += 1;
	}
	return { start, end: view.length - same, text: '[REDACTED]' };
}

/**
 * Up to this length a pattern is searched for natively, in time at most
 * this many times what the search reads; a longer one by Knuth, Morris and
 * Pratt's search, in time linear in it.
 */
const SHORT_PATTERN = 32;

/** Where `pattern` first occurs in `text` at or after `from`, or -1. */
function firstIndex(text: string, pattern: string, from: number): number {
	const length = pattern.length;
	if (length === 0) return from;
	if (length <= SHORT_PATTERN) return text.indexOf(pattern, from);
	const fallback = prefixTable(pattern, false);
	let matched = 0;
	for (let index = from; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		while (matched > 0 && pattern.charCodeAt(matched) !== code) {
			matched = fallback[matched - 1] ?? 0;
		}
		if (pattern.charCodeAt(matched) === code) matched += 1;
		if (matched === length) return index - length + 1;
	}
	return -1;
}

/**
 * Where `pattern` last occurs in `text` starting at or before `last`, or -1,
 * by the same searches run backwards.
 */
function lastIndex(text: string, pattern: string, last: number): number {
	const length = pattern.length;
	if (last < 0) return -1;
	if (length === 0) return last;
	if (length <= SHORT_PATTERN) return text.lastIndexOf(pattern, last);
	const fallback = prefixTable(pattern, true);
	let matched = 0;
	for (let index = last + length - 1; index >= 0; index -= 1) {
		const code = text.charCodeAt(index);
		while (matched > 0 && pattern.charCodeAt(length - 1 - matched) !== code) {
			matched = fallback[matched - 1] ?? 0;
		}
		if (pattern.charCodeAt(length - 1 - matched) === code) matched += 1;
		if (matched === length) return index;
	}
	return -1;
}

/** The search's table for `pattern`, read from its end when `backwards`. */
function prefixTable(pattern: string, backwards: boolean): Int32Array {
	const length = pattern.length;
	const at = (index: number) =>
		pattern.charCodeAt(backwards ? length - 1 - index : index);
	const table = new Int32Array(length);
	let matched = 0;
	for (let index = 1; index < length; index += 1) {
		const code = at(index);
		while (matched > 0 && at(matched) !== code) {
			matched = table[matched - 1] ?? 0;
		}
		if (at(matched) === code) matched += 1;
		table[index] = matched;
	}
	return table;
}

/**
 * The shown text, with each run of what any reading hides, and of the token
 * characters it runs on with after one past a removed run or a
 * default-ignorable character, replaced by one marker: the first the shown
 * text's own reading wrote there, or another reading's.
 */
function shownWithMarkers(
	text: TerminalText,
	shownParts: Hidden[],
	otherParts: Hidden[]
): string {
	const { shown, cuts } = text;
	const length = shown.length;
	const depth = new Int32Array(length + 1);
	for (const part of [...shownParts, ...otherParts]) {
		depth[part.start] = (depth[part.start] ?? 0) + 1;
		depth[part.end] = (depth[part.end] ?? 0) - 1;
	}
	const hidden = new Uint8Array(length);
	let open = 0;
	for (let index = 0; index < length; index += 1) {
		open += depth[index] ?? 0;
		hidden[index] = open > 0 ? 1 : 0;
	}
	// Where a hidden token can run on: past a removed run, or past or at a
	// default-ignorable character the shown text keeps.
	const breaks = [
		...cuts,
		...text.ignorableAt.flatMap((at, index) => [
			at + (text.ignorableBefore[index - 1] ?? 0),
			at + (text.ignorableBefore[index] ?? 0),
		]),
	].sort((a, b) => a - b);
	for (const at of breaks) {
		if (at === 0 || at >= length || !hidden[at - 1] || hidden[at]) continue;
		let end = at;
		while (end < length && !hidden[end]) {
			const ignorable = ignorableLength(shown, end);
			if (ignorable > 0) end += ignorable;
			else if (isTokenCharacter(shown.charCodeAt(end))) end += 1;
			else break;
		}
		if (end === length || !hidden[end]) {
			while (end > at && shown.charCodeAt(end - 1) === 0x2e) end -= 1;
		}
		hidden.fill(1, at, end);
	}
	otherParts.sort((a, b) => a.start - b.start);
	const output: string[] = [];
	let shownPart = 0;
	let otherPart = 0;
	let index = 0;
	while (index < length) {
		let end = index;
		if (!hidden[index]) {
			while (end < length && !hidden[end]) end += 1;
			// A marker that hides nothing, as for an empty value, stays.
			for (
				let part = shownParts[shownPart];
				part && part.start <= end && part.end === part.start;
				part = shownParts[shownPart]
			) {
				output.push(shown.slice(index, part.start), part.text);
				index = part.start;
				shownPart += 1;
			}
			output.push(shown.slice(index, end));
			index = end;
			continue;
		}
		while (end < length && hidden[end]) end += 1;
		// One marker for each hidden run: markers side by side would read,
		// to a second redaction, as a value that only starts with one.
		let marker: string | undefined;
		for (
			let part = shownParts[shownPart];
			part && part.start < end;
			part = shownParts[shownPart]
		) {
			if (part.end > part.start) marker ??= part.text;
			shownPart += 1;
		}
		for (
			let part = otherParts[otherPart];
			part && part.start < end;
			part = otherParts[otherPart]
		) {
			marker ??= part.text;
			otherPart += 1;
		}
		output.push(marker ?? '[REDACTED]');
		index = end;
	}
	for (const part of shownParts.slice(shownPart)) output.push(part.text);
	return output.join('');
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

function isWordCharacter(code: number): boolean {
	return (
		(code >= 0x41 && code <= 0x5a) ||
		(code >= 0x61 && code <= 0x7a) ||
		(code >= 0x30 && code <= 0x39) ||
		code === 0x5f
	);
}

/**
 * `value` as it is shown, and what the readings other than the shown text
 * need: where it left out each run of removed sequences and characters
 * (`cuts`, as positions of the shown text), the shown text with a SEPARATOR
 * there and for each default-ignorable character, the runs' places in
 * `value`, and the shown text without those characters.
 */
type TerminalText = {
	shown: string;
	separated: string;
	cuts: number[];
	/** Where each cut is in the shown text without default-ignorables. */
	cutsUnbroken: number[];
	removedStarts: number[];
	removedEnds: number[];
	/** How many characters of `value` the runs before each one removed. */
	removedBefore: number[];
	/** Whether a line break is shown as a space. */
	spaced: boolean;
	/**
	 * Whether an escape in or beside a word took characters, which a stray
	 * ESC would not have (strayEscape).
	 */
	strays: boolean;
	/**
	 * The shown text without its default-ignorable characters, where each
	 * one stood in it, and how many code units they and those before took.
	 */
	unbroken: string;
	ignorableAt: number[];
	ignorableBefore: number[];
};

/**
 * `value` without ANSI/VT escape sequences (CSI, OSC, DCS and two-byte
 * escapes), C0 and C1 controls, bidirectional overrides and zero-width
 * characters, its tabs and, unless they are kept, its line breaks shown as
 * spaces. With `keepStrays`, the ESC of an escape that strayEscape finds goes
 * alone, and what it would take stays. Written as a scanner so no control
 * character ever appears in a regular expression.
 */
function terminalText(
	value: string,
	keepNewlines: boolean,
	keepStrays: boolean
): TerminalText {
	const shown: string[] = [];
	const separated: string[] = [];
	const unbroken: string[] = [];
	const cuts: number[] = [];
	const cutsUnbroken: number[] = [];
	const removedStarts: number[] = [];
	const removedEnds: number[] = [];
	const removedBefore: number[] = [];
	let removed = 0;
	let shownLength = 0;
	let spaced = false;
	let strays = false;
	const ignorableAt: number[] = [];
	const ignorableBefore: number[] = [];
	let ignorable = 0;
	let kept = 0;
	const keep = (end: number) => {
		if (end === kept) return;
		const run = value.slice(kept, end);
		shown.push(run);
		separated.push(run);
		unbroken.push(run);
		shownLength += end - kept;
	};
	let index = 0;
	while (index < value.length) {
		const code = value.charCodeAt(index);
		if (code === 0x09 || (code === 0x0a && !keepNewlines)) {
			keep(index);
			shown.push(' ');
			separated.push(' ');
			unbroken.push(' ');
			shownLength += 1;
			spaced ||= code === 0x0a;
			index += 1;
			kept = index;
			continue;
		}
		let end = index;
		if (code === 0x1b && strayEscape(value, index)) {
			strays = true;
			end = keepStrays ? index + 1 : skipEscapeSequence(value, index);
		} else if (code === 0x1b || code === 0x9b) {
			end = skipEscapeSequence(value, index);
		} else if (isInvisible(code) && code !== 0x0a) {
			end = index + 1;
		} else if (code >= 0xad) {
			const length = ignorableLength(value, index);
			if (length > 0) {
				keep(index);
				shown.push(value.slice(index, index + length));
				separated.push(SEPARATOR.repeat(length));
				ignorableAt.push(shownLength - ignorable);
				ignorable += length;
				ignorableBefore.push(ignorable);
				shownLength += length;
				index += length;
				kept = index;
				continue;
			}
		}
		if (end === index) {
			index += 1;
			continue;
		}
		keep(index);
		const last = removedEnds.length - 1;
		if (last >= 0 && removedEnds[last] === index) {
			removedEnds[last] = end;
		} else {
			cuts.push(shownLength);
			cutsUnbroken.push(shownLength - ignorable);
			separated.push(SEPARATOR);
			removedStarts.push(index);
			removedEnds.push(end);
			removedBefore.push(removed);
		}
		removed += end - index;
		index = end;
		kept = index;
	}
	keep(index);
	return {
		shown: shown.join(''),
		separated:
			cuts.length > 0 || ignorableAt.length > 0 ? separated.join('') : '',
		unbroken: ignorableAt.length > 0 ? unbroken.join('') : '',
		cuts,
		cutsUnbroken,
		removedStarts,
		removedEnds,
		removedBefore,
		spaced,
		strays,
		ignorableAt,
		ignorableBefore,
	};
}

/**
 * Whether the ESC at `index` starts a two-byte or nF escape whose final is
 * a letter, with a word character before the ESC or after the letter. A
 * terminal reads the letter as part of the escape, but in or beside a word
 * the ESC may be a stray one, and the letter part of the word: a token's
 * `eyJ`, or the last letter of `password`. A digit or other final, as in the
 * cursor saves `ESC 7` and `ESC 8`, ends a real escape. Control sequences
 * and control strings are left to the other readings.
 */
function strayEscape(value: string, index: number): boolean {
	const next = value.charCodeAt(index + 1);
	if (
		next === 0x5b ||
		next === 0x5d ||
		next === 0x50 ||
		next === 0x58 ||
		next === 0x5e ||
		next === 0x5f
	) {
		return false;
	}
	let at = index + 1;
	while (at < value.length) {
		const code = value.charCodeAt(at);
		if (code < 0x20 || code > 0x2f) break;
		at += 1;
	}
	const final = value.charCodeAt(at);
	return (
		((final >= 0x41 && final <= 0x5a) || (final >= 0x61 && final <= 0x7a)) &&
		(isWordCharacter(value.charCodeAt(index - 1)) ||
			isWordCharacter(value.charCodeAt(at + 1)))
	);
}

/** Where the character at `at` of `kept`'s shown text is in the input. */
function keptRaw(kept: TerminalText, at: number): number {
	const { cuts, removedStarts, removedEnds, removedBefore } = kept;
	let low = 0;
	let high = cuts.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if ((cuts[middle] ?? at) <= at) low = middle + 1;
		else high = middle;
	}
	if (low === 0) return at;
	const start = removedStarts[low - 1] ?? 0;
	return (
		at + (removedBefore[low - 1] ?? 0) + (removedEnds[low - 1] ?? start) - start
	);
}

/** How many characters of the shown text come before `at` in `value`. */
function rawShown(text: TerminalText, at: number): number {
	const { removedStarts, removedEnds, removedBefore } = text;
	let low = 0;
	let high = removedStarts.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if ((removedStarts[middle] ?? at) < at) low = middle + 1;
		else high = middle;
	}
	if (low === 0) return at;
	const start = removedStarts[low - 1] ?? 0;
	const end = removedEnds[low - 1] ?? start;
	return at - (removedBefore[low - 1] ?? 0) - (Math.min(at, end) - start);
}

/**
 * Where `at` in the shown text without its default-ignorable characters is
 * in the shown text, past those that stood before it.
 */
function unbrokenShown(text: TerminalText, at: number): number {
	const { ignorableAt, ignorableBefore } = text;
	let low = 0;
	let high = ignorableAt.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if ((ignorableAt[middle] ?? at) <= at) low = middle + 1;
		else high = middle;
	}
	return at + (low === 0 ? 0 : (ignorableBefore[low - 1] ?? 0));
}

/**
 * Whether a word ends at `at` in `text` and a JWT or a Bearer token starts
 * there, which the rules recognise only after a word boundary.
 */
function startsToken(text: string, at: number): boolean {
	return (
		at > 0 &&
		isWordCharacter(text.charCodeAt(at - 1)) &&
		(text.startsWith('eyJ', at) ||
			text.slice(at, at + 6).toLowerCase() === 'bearer')
	);
}

/** `text` with a SEPARATOR at each of `positions`, in order. */
function withSeparators(text: string, positions: number[]): string {
	const parts: string[] = [];
	let from = 0;
	for (const at of positions) {
		parts.push(text.slice(from, at), SEPARATOR);
		from = at;
	}
	parts.push(text.slice(from));
	return parts.join('');
}

/** The positions in either ascending list, in order and each once. */
function mergedPositions(first: number[], second: number[]): number[] {
	const merged: number[] = [];
	let one = 0;
	let two = 0;
	while (one < first.length || two < second.length) {
		const a = first[one] ?? Number.POSITIVE_INFINITY;
		const b = second[two] ?? Number.POSITIVE_INFINITY;
		const next = Math.min(a, b);
		if (a === next) one += 1;
		if (b === next) two += 1;
		if (merged[merged.length - 1] !== next) merged.push(next);
	}
	return merged;
}

/**
 * How many characters of the shown text come before `at` in the separated
 * reading, whose separator for cut `n` is at `cuts[n] + n`.
 */
function separatedShown(text: TerminalText, at: number): number {
	return separatorsShown(text.cuts, at);
}

/**
 * How many characters of the shown text come before `at` in the shown text
 * with a separator at each of `cuts`, the one for cut `n` at `cuts[n] + n`.
 */
function separatorsShown(cuts: number[], at: number): number {
	let low = 0;
	let high = cuts.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if ((cuts[middle] ?? at) + middle < at) low = middle + 1;
		else high = middle;
	}
	return at - low;
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
 * How many code units the code point at `index` of `value` takes if it is
 * one of the others Unicode says to show as nothing when they cannot be
 * rendered (Default_Ignorable_Code_Point), such as a soft hyphen, a
 * variation selector, a filler or a tag, or 0. They stay in the shown text,
 * but the readings take each as a break and as nothing, as they take a
 * removed run, so that one cannot keep `Bearer` from its token, or split a
 * token, either.
 */
function ignorableLength(value: string, index: number): number {
	const code = value.charCodeAt(index);
	if (code >= 0xd800 && code <= 0xdbff) {
		const low = value.charCodeAt(index + 1);
		if (!(low >= 0xdc00 && low <= 0xdfff)) return 0;
		const point = 0x10000 + (code - 0xd800) * 0x400 + (low - 0xdc00);
		return (point >= 0x1bca0 && point <= 0x1bca3) ||
			(point >= 0x1d173 && point <= 0x1d17a) ||
			(point >= 0xe0000 && point <= 0xe0fff)
			? 2
			: 0;
	}
	return code === 0x00ad ||
		code === 0x034f ||
		code === 0x115f ||
		code === 0x1160 ||
		code === 0x17b4 ||
		code === 0x17b5 ||
		(code >= 0x180b && code <= 0x180f) ||
		(code >= 0x206a && code <= 0x206f) ||
		code === 0x3164 ||
		(code >= 0xfe00 && code <= 0xfe0f) ||
		code === 0xffa0 ||
		(code >= 0xfff0 && code <= 0xfff8)
		? 1
		: 0;
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

/**
 * Minimal, bounded scanners for `supabase/config.toml` and dotenv files.
 * They recover only what static detection needs (key paths, line numbers,
 * booleans, small integers and short strings), skip any syntax they do not
 * understand, and never evaluate anything. Dotenv values are never returned:
 * only the key, its line, and an integer reading for port-shaped values.
 */

/** A TOML value reduced to what detection needs. */
type TomlScalar =
	| { kind: 'boolean'; value: boolean }
	| { kind: 'integer'; value: number }
	| { kind: 'string'; value: string }
	| { kind: 'other' };

export type TomlAssignment = {
	/** Full dotted path: table header plus (dotted) key. */
	path: readonly string[];
	value: TomlScalar;
	/** 1-based line of the key. */
	line: number;
};

type DotenvEntry = {
	key: string;
	/** 1-based line of the key. */
	line: number;
	/** The value read as a decimal integer of at most five digits. */
	integer?: number;
};

const MAX_TOML_ASSIGNMENTS = 20_000;
const MAX_TOML_DEPTH = 32;
const MAX_KEY_SEGMENTS = 16;
const MAX_KEY_SEGMENT_LENGTH = 256;
const MAX_STRING_LENGTH = 4_096;
const MAX_DOTENV_ENTRIES = 10_000;

const BARE_KEY = /[A-Za-z0-9_-]+/y;
const BARE_VALUE = /[A-Za-z0-9_+.:-]+/y;
const DECIMAL_INTEGER = /^[+-]?(?:0|[1-9](?:_?[0-9])*)$/;
const PREFIXED_INTEGER =
	/^0(?:x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|o[0-7](?:_?[0-7])*|b[01](?:_?[01])*)$/;
const HEX_DIGITS = /^[0-9A-Fa-f]+$/;
const OTHER: TomlScalar = { kind: 'other' };
const ESCAPES: Readonly<Record<string, string>> = {
	b: '\b',
	t: '\t',
	n: '\n',
	f: '\f',
	r: '\r',
	e: '\u001b',
	'"': '"',
	'\\': '\\',
};

function integerScalar(digits: string, radix: number): TomlScalar {
	const value = Number.parseInt(digits.replaceAll('_', ''), radix);
	return Number.isSafeInteger(value) ? { kind: 'integer', value } : OTHER;
}

function classifyBareValue(token: string): TomlScalar {
	if (token === 'true') return { kind: 'boolean', value: true };
	if (token === 'false') return { kind: 'boolean', value: false };
	if (DECIMAL_INTEGER.test(token)) return integerScalar(token, 10);
	if (PREFIXED_INTEGER.test(token)) {
		const radix = token[1] === 'x' ? 16 : token[1] === 'o' ? 8 : 2;
		return integerScalar(token.slice(2), radix);
	}
	return OTHER;
}

class TomlScanner {
	readonly #text: string;
	readonly #assignments: TomlAssignment[] = [];
	#index = 0;
	#line = 1;
	/** Current table; undefined after a header that did not parse, or `[[...]]`. */
	#table: readonly string[] | undefined = [];

	constructor(text: string) {
		this.#text = text;
	}

	scan(): TomlAssignment[] {
		while (this.#assignments.length < MAX_TOML_ASSIGNMENTS) {
			this.#skipTrivia();
			if (this.#index >= this.#text.length) break;
			const pending: TomlAssignment[] = [];
			if (this.#statement(pending)) {
				for (const assignment of pending) {
					if (this.#assignments.length >= MAX_TOML_ASSIGNMENTS) break;
					this.#assignments.push(assignment);
				}
			} else {
				this.#skipRestOfLine();
			}
		}
		return this.#assignments;
	}

	#peek(offset = 0): string {
		return this.#text.charAt(this.#index + offset);
	}

	#advanceTo(position: number): void {
		for (let index = this.#index; index < position; index += 1) {
			if (this.#text.charCodeAt(index) === 10) this.#line += 1;
		}
		this.#index = position;
	}

	#skipSpaces(): void {
		while (this.#peek() === ' ' || this.#peek() === '\t') this.#index += 1;
	}

	#skipComment(): void {
		if (this.#peek() !== '#') return;
		const end = this.#text.indexOf('\n', this.#index);
		this.#index = end === -1 ? this.#text.length : end;
	}

	/** Spaces, newlines and comments. */
	#skipTrivia(): void {
		for (;;) {
			const character = this.#peek();
			if (character === ' ' || character === '\t' || character === '\r') {
				this.#index += 1;
			} else if (character === '\n') {
				this.#index += 1;
				this.#line += 1;
			} else if (character === '#') {
				this.#skipComment();
			} else {
				return;
			}
		}
	}

	#skipRestOfLine(): void {
		const end = this.#text.indexOf('\n', this.#index);
		this.#advanceTo(end === -1 ? this.#text.length : end + 1);
	}

	/** Accepts trailing spaces and a comment, then consumes the line break. */
	#endOfLine(): boolean {
		this.#skipSpaces();
		this.#skipComment();
		if (this.#index >= this.#text.length) return true;
		if (this.#peek() === '\r' && this.#peek(1) === '\n') this.#index += 1;
		if (this.#peek() !== '\n') return false;
		this.#index += 1;
		this.#line += 1;
		return true;
	}

	#statement(pending: TomlAssignment[]): boolean {
		if (this.#peek() === '[') return this.#header();
		const line = this.#line;
		const key = this.#key();
		if (!key) return false;
		this.#skipSpaces();
		if (this.#peek() !== '=') return false;
		this.#index += 1;
		this.#skipSpaces();
		const target = this.#table ? [...this.#table, ...key] : undefined;
		const value = this.#value(target, pending, 0);
		if (!value || !this.#endOfLine()) return false;
		if (target) pending.push({ path: target, value, line });
		return true;
	}

	#header(): boolean {
		const arrayTable = this.#peek(1) === '[';
		this.#index += arrayTable ? 2 : 1;
		// Until the header parses, assignments belong to no known table.
		this.#table = undefined;
		const key = this.#key();
		if (!key) return false;
		this.#skipSpaces();
		const close = arrayTable ? ']]' : ']';
		if (!this.#text.startsWith(close, this.#index)) return false;
		this.#index += close.length;
		if (!this.#endOfLine()) return false;
		// Array-of-tables entries never hold the keys detection reads.
		this.#table = arrayTable ? undefined : key;
		return true;
	}

	#key(): string[] | undefined {
		const segments: string[] = [];
		for (;;) {
			this.#skipSpaces();
			const segment = this.#keySegment();
			if (segment === undefined) return undefined;
			segments.push(segment);
			if (segments.length > MAX_KEY_SEGMENTS) return undefined;
			this.#skipSpaces();
			if (this.#peek() !== '.') return segments;
			this.#index += 1;
		}
	}

	#keySegment(): string | undefined {
		const character = this.#peek();
		if (character === '"' || character === "'") {
			if (this.#peek(1) === character && this.#peek(2) === character) {
				return undefined;
			}
			const value = this.#singleLineString(character);
			return value !== undefined && value.length <= MAX_KEY_SEGMENT_LENGTH
				? value
				: undefined;
		}
		BARE_KEY.lastIndex = this.#index;
		const match = BARE_KEY.exec(this.#text);
		if (!match || match[0].length > MAX_KEY_SEGMENT_LENGTH) return undefined;
		this.#index += match[0].length;
		return match[0];
	}

	#singleLineString(quote: string): string | undefined {
		let value = '';
		for (let index = this.#index + 1; index < this.#text.length; index += 1) {
			const character = this.#text.charAt(index);
			if (character === '\n' || character === '\r') return undefined;
			if (character === quote) {
				this.#index = index + 1;
				return value;
			}
			let decoded = character;
			if (quote === '"' && character === '\\') {
				const next = this.#text.charAt(index + 1);
				const escaped = ESCAPES[next];
				if (escaped !== undefined) {
					decoded = escaped;
					index += 1;
				} else if (next === 'u' || next === 'U') {
					const length = next === 'u' ? 4 : 8;
					const hex = this.#text.slice(index + 2, index + 2 + length);
					const codePoint = Number.parseInt(hex, 16);
					if (
						hex.length !== length ||
						!HEX_DIGITS.test(hex) ||
						codePoint > 0x10ffff ||
						(codePoint >= 0xd800 && codePoint <= 0xdfff)
					) {
						return undefined;
					}
					decoded = String.fromCodePoint(codePoint);
					index += 1 + length;
				} else {
					return undefined;
				}
			}
			if (value.length < MAX_STRING_LENGTH) value += decoded;
		}
		return undefined;
	}

	#multiLineString(quote: string): string | undefined {
		const delimiter = quote.repeat(3);
		const start = this.#index + 3;
		for (let from = start; ; ) {
			const end = this.#text.indexOf(delimiter, from);
			if (end === -1) return undefined;
			if (quote === '"') {
				let backslashes = 0;
				for (
					let index = end - 1;
					index >= start && this.#text.charAt(index) === '\\';
					index -= 1
				) {
					backslashes += 1;
				}
				if (backslashes % 2 === 1) {
					from = end + 1;
					continue;
				}
			}
			// TOML allows one or two quotes just before the closing delimiter.
			let close = end;
			while (close < end + 2 && this.#text.charAt(close + 3) === quote) {
				close += 1;
			}
			// Escapes are left undecoded: detection never reads multi-line values.
			const value = this.#text.slice(start, close).slice(0, MAX_STRING_LENGTH);
			this.#advanceTo(close + 3);
			return value;
		}
	}

	#value(
		target: readonly string[] | undefined,
		pending: TomlAssignment[],
		depth: number
	): TomlScalar | undefined {
		if (depth > MAX_TOML_DEPTH) return undefined;
		const character = this.#peek();
		if (character === '"' || character === "'") {
			const value =
				this.#peek(1) === character && this.#peek(2) === character
					? this.#multiLineString(character)
					: this.#singleLineString(character);
			return value === undefined ? undefined : { kind: 'string', value };
		}
		if (character === '[') return this.#array(depth) ? OTHER : undefined;
		if (character === '{') {
			return this.#inlineTable(target, pending, depth) ? OTHER : undefined;
		}
		BARE_VALUE.lastIndex = this.#index;
		const match = BARE_VALUE.exec(this.#text);
		if (!match) return undefined;
		this.#index += match[0].length;
		return classifyBareValue(match[0]);
	}

	#array(depth: number): boolean {
		this.#index += 1;
		for (;;) {
			this.#skipTrivia();
			if (this.#peek() === ']') {
				this.#index += 1;
				return true;
			}
			// Values inside arrays are never recorded.
			if (!this.#value(undefined, [], depth + 1)) return false;
			this.#skipTrivia();
			if (this.#peek() === ',') {
				this.#index += 1;
				continue;
			}
			if (this.#peek() !== ']') return false;
			this.#index += 1;
			return true;
		}
	}

	#inlineTable(
		target: readonly string[] | undefined,
		pending: TomlAssignment[],
		depth: number
	): boolean {
		this.#index += 1;
		for (;;) {
			this.#skipTrivia();
			if (this.#peek() === '}') {
				this.#index += 1;
				return true;
			}
			const line = this.#line;
			const key = this.#key();
			if (!key) return false;
			this.#skipSpaces();
			if (this.#peek() !== '=') return false;
			this.#index += 1;
			this.#skipSpaces();
			const nested = target ? [...target, ...key] : undefined;
			const value = this.#value(nested, pending, depth + 1);
			if (!value) return false;
			if (nested) pending.push({ path: nested, value, line });
			this.#skipTrivia();
			if (this.#peek() === ',') {
				this.#index += 1;
				continue;
			}
			if (this.#peek() !== '}') return false;
			this.#index += 1;
			return true;
		}
	}
}

/**
 * Key assignments in a TOML document, with table context and line numbers.
 * Malformed statements are skipped line by line; keys that follow a malformed
 * table header are dropped rather than credited to the previous table.
 */
export function scanTomlAssignments(text: string): TomlAssignment[] {
	try {
		return new TomlScanner(text).scan();
	} catch {
		return [];
	}
}

function closingQuote(value: string, quote: string, from: number): number {
	for (let index = from; index < value.length; index += 1) {
		if (value.charAt(index) === quote && value.charAt(index - 1) !== '\\') {
			return index;
		}
	}
	return -1;
}

/**
 * Keys assigned in a dotenv file (`KEY=value`, `KEY: value`, optional
 * `export`), with their lines. A quoted value that spans lines is skipped as
 * a whole so its text is never mistaken for assignments.
 */
export function scanDotenvKeys(text: string): DotenvEntry[] {
	const lines = text.split('\n');
	const entries: DotenvEntry[] = [];
	for (
		let index = 0;
		index < lines.length && entries.length < MAX_DOTENV_ENTRIES;
		index += 1
	) {
		const line = index + 1;
		const statement = (lines[index] ?? '').replace(/\r$/, '').trimStart();
		if (statement === '' || statement.startsWith('#')) continue;
		const match =
			/^(?:export[ \t]+)?([A-Za-z0-9_.-]+)[ \t]*[=:][ \t]*(.*)$/.exec(
				statement
			);
		const key = match?.[1];
		if (!match || !key) continue;
		const rest = match[2] ?? '';
		const quote = rest.charAt(0);
		let value: string | undefined;
		if (quote === '"' || quote === "'" || quote === '`') {
			const close = closingQuote(rest, quote, 1);
			if (close === -1) {
				let next = index + 1;
				while (
					next < lines.length &&
					closingQuote(lines[next] ?? '', quote, 0) === -1
				) {
					next += 1;
				}
				index = next;
			} else {
				value = rest.slice(1, close);
			}
		} else {
			value = rest.replace(/[ \t]#.*$/, '').trim();
		}
		const integer =
			value !== undefined && /^\d{1,5}$/.test(value)
				? Number(value)
				: undefined;
		entries.push({ key, line, ...(integer !== undefined ? { integer } : {}) });
	}
	return entries;
}

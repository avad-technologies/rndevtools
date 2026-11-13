import { describe, expect, it } from 'vitest';
import { realisticSecrets } from './cli-fixtures.test-support';
import { redactTerminalText, sanitizeSupabaseText } from './cli-redact';

const ESC = '\u001b';

function line(value: string, maxChars = 4096): string {
	return sanitizeSupabaseText(value, { maxChars });
}

describe('sanitizeSupabaseText', () => {
	it('removes terminal escape sequences and control characters', () => {
		expect(line(`${ESC}[1;32m[task] done:${ESC}[0m Stack is ready.`)).toBe(
			'[task] done: Stack is ready.'
		);
		expect(
			line(`${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;\u0007 text`)
		).toBe('link text');
		expect(line(`${ESC}(Bplain${ESC}7${ESC}8`)).toBe('plain');
		expect(line(`a\u0000b\u0008c\u007fd\u0085e\u009b31mf`)).toBe('abcdef');
		expect(line('carriage\r\nreturn\tand tab')).toBe('carriage return and tab');
		expect(line(`unterminated ${ESC}]0;title`)).toBe('unterminated ');
	});

	it('removes bidirectional overrides and zero-width characters', () => {
		expect(line('safe\u202etxt.exe\u202c and \u2066isolated\u2069')).toBe(
			'safetxt.exe and isolated'
		);
		expect(line('zero\u200bwidth\ufeff')).toBe('zerowidth');
	});

	it('keeps line breaks only when asked', () => {
		expect(sanitizeSupabaseText('one\ntwo', { maxChars: 100 })).toBe('one two');
		expect(
			sanitizeSupabaseText('one\r\ntwo', { maxChars: 100, keepNewlines: true })
		).toBe('one\ntwo');
	});

	it('redacts Supabase keys, JWTs, URL passwords and credential parameters', () => {
		const { secretKey, publishableKey, anonKey, serviceRoleKey, dbPassword } =
			realisticSecrets();
		const samples = [
			`SECRET_KEY=${secretKey}`,
			`"SECRET_KEY":"${secretKey}"`,
			`export SUPABASE_AUTH_SECRET_KEY='${secretKey}'`,
			`bare ${secretKey} value`,
			`PUBLISHABLE_KEY=${publishableKey}`,
			`key ${publishableKey}`,
			`SERVICE_ROLE_KEY: ${serviceRoleKey}`,
			`Authorization: Bearer ${anonKey}`,
			`GET /rest/v1/notes?apikey=${anonKey}&select=id`,
			`GET /auth/v1/verify?token_hash=abc123&type=signup&code=xyz789`,
			`DB_URL=postgresql://postgres:${dbPassword}@127.0.0.1:30630/postgres`,
			`connect postgresql://postgres:${dbPassword}@127.0.0.1:30630/postgres failed`,
			`truncated ${anonKey.split('.').slice(0, 2).join('.')}.`,
		];
		for (const sample of samples) {
			const sanitized = line(sample);
			for (const secret of [
				secretKey,
				publishableKey,
				anonKey,
				serviceRoleKey,
				dbPassword,
			]) {
				expect({ sample, leaked: sanitized.includes(secret) }).toEqual({
					sample,
					leaked: false,
				});
			}
			expect(sanitized).not.toMatch(
				/sb_secret_|sb_publishable_|eyJ[\w-]{4,}\./
			);
		}
		expect(line(`GET /auth/v1/verify?token_hash=abc123&type=signup`)).toContain(
			'type=signup'
		);
		expect(
			line(
				`connect postgresql://postgres:${dbPassword}@127.0.0.1:30630/postgres`
			)
		).toContain('127.0.0.1:30630/postgres');
	});

	it('redacts a token that a removed sequence or character would join to the word before it', () => {
		// The JWT and Bearer rules start at a word boundary, and Bearer takes
		// its token after white space. Removing what parted a word from a token
		// before redacting left neither between them.
		const { anonKey } = realisticSecrets();
		for (const [raw, redacted] of [
			[`Error: fetching\r${anonKey}`, 'Error: fetching[REDACTED JWT]'],
			[`Error: fetching\u000b${anonKey}`, 'Error: fetching[REDACTED JWT]'],
			[`Error: fetching\u0008${anonKey}`, 'Error: fetching[REDACTED JWT]'],
			[`Error: fetching​${anonKey}`, 'Error: fetching[REDACTED JWT]'],
			[
				`Error: fetching${ESC}[32m${anonKey}${ESC}[0m`,
				'Error: fetching[REDACTED JWT]',
			],
			['Error: Bearer\rexample-bearer-value', 'Error: Bearer [REDACTED]'],
			['Error: Bearer\u000bexample-bearer-value', 'Error: Bearer [REDACTED]'],
			['Error: Bearer\u0008example-bearer-value', 'Error: Bearer [REDACTED]'],
			['Error: Bearer​example-bearer-value', 'Error: Bearer [REDACTED]'],
			['Error: Bearer⁠example-bearer-value', 'Error: Bearer [REDACTED]'],
			[
				`Error: Bearer${ESC}[1mexample-bearer-value`,
				'Error: Bearer [REDACTED]',
			],
		] as const) {
			expect({ raw, sanitized: line(raw) }).toEqual({
				raw,
				sanitized: redacted,
			});
		}
		expect(
			sanitizeSupabaseText(`Error: one\r\nfetching\r${anonKey}`, {
				maxChars: 4096,
				keepNewlines: true,
			})
		).toBe('Error: one\nfetching[REDACTED JWT]');
	});

	it('hides all of a key or token that a removed sequence or character splits', () => {
		const { secretKey, publishableKey, anonKey } = realisticSecrets();
		for (const [raw, redacted] of [
			[
				`key ${secretKey.slice(0, 14)}​${secretKey.slice(14)}`,
				'key [REDACTED KEY]',
			],
			[
				`key ${publishableKey.slice(0, 20)}${ESC}[0m${publishableKey.slice(20)}`,
				'key [REDACTED KEY]',
			],
			[
				`token ${anonKey.slice(0, -4)}${ESC}[0m${anonKey.slice(-4)}`,
				'token [REDACTED JWT]',
			],
			[
				`token ${anonKey.slice(0, 24)}​${anonKey.slice(24)}`,
				'token [REDACTED JWT]',
			],
			['mail us​er@example.com', 'mail [REDACTED EMAIL]'],
			// A parameter's value and the token a sequence glues to it are one.
			[
				`GET /rest/v1/notes?apikey=${ESC}[1;32m${anonKey}${ESC}[0m&select=id`,
				'GET /rest/v1/notes?apikey=[REDACTED]&select=id',
			],
		] as const) {
			expect({ raw, sanitized: line(raw) }).toEqual({
				raw,
				sanitized: redacted,
			});
		}
	});

	it('hides all of a key or token that a removed character splits after a name the core rules know', () => {
		// The Supabase rules mark the part they know first, and the core rule
		// for the name redacts the marker's first word again, leaving none for
		// the rest of the token to join. Read with the character gone, the
		// token is whole.
		const { secretKey, publishableKey, anonKey } = realisticSecrets();
		for (const [raw, tail] of [
			[
				`Authorization: Bearer ${anonKey.slice(0, 40)}\r${anonKey.slice(40)}`,
				anonKey.slice(40),
			],
			[
				`apikey: ${secretKey.slice(0, 14)}${ESC}[0m${secretKey.slice(14)}`,
				secretKey.slice(14),
			],
			[
				`token=${anonKey.slice(0, 40)}\u200b${anonKey.slice(40)}`,
				anonKey.slice(40),
			],
			[
				`password: ${publishableKey.slice(0, 20)}\r${publishableKey.slice(20)}`,
				publishableKey.slice(20),
			],
			// Characters Unicode shows as nothing stay in the text, but are read
			// as nothing as well.
			[
				`apikey: ${secretKey.slice(0, 14)}\u00ad${secretKey.slice(14)}`,
				secretKey.slice(14),
			],
			[
				`apikey: ${anonKey.slice(0, 40)}\u3164${anonKey.slice(40)}`,
				anonKey.slice(40),
			],
		] as const) {
			const sanitized = line(raw);
			expect({ raw, leaked: sanitized.includes(tail) }).toEqual({
				raw,
				leaked: false,
			});
			expect(sanitized).not.toMatch(
				/sb_secret_|sb_publishable_|eyJ[\w-]{4,}\./
			);
		}
	});

	it('redacts all of an Authorization parameter list that a removed sequence parts from its first `=`', () => {
		expect(
			line(
				`Authorization: Digest username${ESC}[0m="example", response="secret-value"`
			)
		).toBe('Authorization: [REDACTED]');
	});

	it('leaves stack ids, ports and ordinary text alone', () => {
		const id =
			'b2e7a5393a8054d7b4658b68c7c7bb12092465347f6e3fbb7afb6864534dd9e8';
		const message = `Public port 54321 for api is in use by the stack of project /Users/example/ExampleApp (stack ${id})`;
		expect(line(message)).toBe(message);
		expect(line('GET /rest/v1/notes?select=id&limit=1 HTTP/1.1 200')).toBe(
			'GET /rest/v1/notes?select=id&limit=1 HTTP/1.1 200'
		);
	});

	it('preserves URL schemes, adjacent prefixes and authority syntax while redacting passwords', () => {
		expect(
			line('POSTGRES+tls.v2-foo://db-user:pa@ss@db.example.com:5432/db')
		).toBe('POSTGRES+tls.v2-foo://db-user:[REDACTED]@db.example.com:5432/db');
		expect(line('(123+.-PoStGrEs://:pw%40data@[::1]/db)')).toBe(
			'(123+.-PoStGrEs://:[REDACTED]@[::1]/db)'
		);
		expect(line('ssh://db-user:@localhost/path')).toBe(
			'ssh://db-user:[REDACTED]@localhost/path'
		);
	});

	it('redacts a URL after a long plain-text run', () => {
		const plain = 'x'.repeat(100_000);
		expect(
			line(
				`${plain} postgres://db-user:db-pass@localhost/db`,
				plain.length + 100
			)
		).toBe(`${plain} postgres://db-user:[REDACTED]@localhost/db`);
	});

	it('bounds the result without splitting a surrogate pair', () => {
		expect(line('x'.repeat(10_000), 100)).toHaveLength(100);
		expect(line('x'.repeat(10_000), 100).endsWith('…')).toBe(true);
		const emoji = `${'a'.repeat(98)}😀tail`;
		const bounded = line(emoji, 100);
		expect(bounded.length).toBeLessThanOrEqual(100);
		expect(bounded.endsWith('a…')).toBe(true);
		expect(line('short', 100)).toBe('short');
	});
});

describe('redactTerminalText', () => {
	const JWT =
		'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJleGFtcGxlLXVzZXIifQ.c2lnbmF0dXJlLXZhbHVlLWV4YW1wbGU';
	const { secretKey, publishableKey } = realisticSecrets();
	// A secret is `before`, `core` and `after`; no eight characters of `core`
	// may show.
	const SECRETS: readonly (readonly [string, string, string, boolean?])[] = [
		['', JWT, ''],
		['Bearer ', 'example-bearer-token-value', ''],
		['Authorization: Bearer ', 'example-bearer-token-value', ''],
		['', secretKey, ''],
		['', publishableKey, '', true],
		['', 'jane.doe.private@mail.test', ''],
		['password=', 'hunter2-example-secret', ''],
		['password: ', 'hunter2-example-secret', ''],
		['postgres://dbuser:', 'pa55w0rd-example-value', '@localhost/db'],
		[
			'Authorization: Digest username="example", response="',
			'6629fae49393a05397450978507c4ef1',
			'"',
		],
		[
			'Authorization: AWS4-HMAC-SHA256 Credential=EXAMPLEKEY/20260101/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=',
			'fe5f80f77d5fa3beca038a248ff027d0445342fe2855',
			'',
		],
		['GET /callback?code=', 'example-oauth-code-value', '&state=xyz'],
		['apikey: ', JWT, ''],
		['token=', JWT, ''],
		['apikey: ', secretKey, ''],
	];
	// Escape sequences and characters the shown text leaves out, and ones
	// Unicode shows as nothing that it keeps.
	const RUNS = [
		`${ESC}[0m`,
		`${ESC}[1;32m`,
		`${ESC}]8;;https://example.test${ESC}\\`,
		`${ESC}7`,
		'\r',
		'\u0008',
		'\u200b',
		'\u2060',
		'\u00ad',
		'\ufe0f',
		'\u{e0020}',
		'\u3164',
	];
	const PREFIXES = ['Error: ', 'fetching ', 'got: ', '(', '"'];
	const SUFFIXES = ['', '.', ' done', ', next', '"', ')'];
	const READERS = [
		['failure text', (value: string) => redactTerminalText(value, true)],
		['plan output', (value: string) => redactTerminalText(value, false)],
		[
			'Supabase text',
			(value: string) => sanitizeSupabaseText(value, { maxChars: 1 << 20 }),
		],
	] as const;

	function shows(output: string, core: string): boolean {
		const visible = output.replace(
			/\p{Default_Ignorable_Code_Point}|\p{Cc}/gu,
			''
		);
		for (let index = 0; index + 8 <= core.length; index += 1) {
			if (visible.includes(core.slice(index, index + 8))) return true;
		}
		return false;
	}

	it('hides every secret however escape sequences and invisible characters part it, or join it to a word', () => {
		// A seeded sweep (mulberry32): each secret in a few contexts, with runs
		// inside it, between it and the word before it, both, or before it,
		// where a sequence can take its first letter, or a stray ESC before one
		// of its letters.
		let state = 20_261_112;
		const random = () => {
			state = (state + 0x6d2b79f5) >>> 0;
			let mixed = Math.imul(state ^ (state >>> 15), state | 1);
			mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
			return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
		};
		const pick = <T>(items: readonly T[]): T =>
			items[Math.floor(random() * items.length)] as T;
		const shown: string[] = [];
		for (const [name, read] of READERS) {
			for (const [before, core, after, supabaseOnly] of SECRETS) {
				if (supabaseOnly && name !== 'Supabase text') continue;
				const plain = `${before}${core}${after}`;
				for (const mode of ['inside', 'glued', 'both', 'eaten', 'stray']) {
					for (let count = 0; count < 40; count += 1) {
						let body = plain;
						if (mode === 'inside' || mode === 'both') {
							const cuts = [1, 2].map(() =>
								Math.floor(1 + random() * (plain.length - 1))
							);
							for (const at of cuts.sort((a, b) => b - a)) {
								body = `${body.slice(0, at)}${pick(RUNS)}${body.slice(at)}`;
							}
						}
						if (mode === 'stray') {
							// A lone ESC before a letter of the secret or its name;
							// before P or X one starts a string that takes the rest.
							const letters = [...plain].flatMap((character, at) =>
								/[A-OQ-WYZa-z]/.test(character) ? [at] : []
							);
							const at = pick(letters);
							body = `${plain.slice(0, at)}${ESC}${plain.slice(at)}`;
						}
						let lead = pick(PREFIXES);
						if (mode === 'glued' || mode === 'both') {
							lead = `${lead.trim() || 'x'}word${pick(RUNS)}`;
						} else if (mode === 'eaten') {
							lead += pick([ESC, `${ESC} `, `${ESC}[`, `${ESC}(`]);
						}
						const value = `${lead}${body}${pick(SUFFIXES)}`;
						const output = read(value);
						// Redacting what it returns again changes nothing, except
						// for a marker's words when a character Unicode shows as
						// nothing sits inside a credential's name.
						if (!/\p{Default_Ignorable_Code_Point}/u.test(value)) {
							if (read(output) !== output) {
								shown.push(`${name}, again: ${JSON.stringify(output)}`);
							}
						}
						// A sequence before the secret may take its first letter.
						const hidden =
							mode === 'eaten' && before === '' ? core.slice(1) : core;
						if (shows(output, hidden) || output.includes(ESC)) {
							shown.push(`${name}: ${JSON.stringify(value)} -> ${output}`);
						}
					}
				}
			}
		}
		expect(shown).toEqual([]);
	});

	it('takes time linear in the text, however many markers and readings it has', () => {
		// Eight times the text takes about eight times as long, not sixty-four:
		// markers between the same words, which a search for them finds at
		// every one; a glued token only other readings find; stray ESCs that
		// call for the readings again; and text between two markers, longer
		// than the native search takes, that a long hidden span holds too.
		const shapes: readonly ((scale: number) => string)[] = [
			(scale) =>
				`token=a${ESC}[0m ${'filler '.repeat(6)}`.repeat(1_000 * scale),
			(scale) => `x${ESC}[0mBearer a `.repeat(2_500 * scale),
			(scale) => `pa${ESC}ssword=x `.repeat(2_500 * scale),
			(scale) =>
				`password="${'a'.repeat(100_000 * scale)}"${'a'.repeat(500 * scale)} token=y${ESC}[0m`,
		];
		for (const make of shapes) {
			const time = (scale: number) => {
				const value = make(scale);
				let best = Number.POSITIVE_INFINITY;
				for (let run = 0; run < 3; run += 1) {
					const start = performance.now();
					redactTerminalText(value, true);
					best = Math.min(best, performance.now() - start);
				}
				return best;
			};
			time(1);
			expect(time(16) / time(2)).toBeLessThan(32);
		}
	}, 60_000);

	it('returns Supabase text that a second redaction leaves as it is', () => {
		const once = line('apikey=authorization: a\na');
		expect(once).toBe('apikey=[REDACTED]');
		expect(line(once)).toBe(once);
	});

	it('keeps a marker that hides nothing where it is', () => {
		// A parameter with an empty value is marked, and the marker stays in
		// place when another reading hides more of the text.
		expect(
			sanitizeSupabaseText(
				`GET /rest/v1/notes?apikey=&select=id fetching${ESC}[32m${JWT}`,
				{ maxChars: 4096 }
			)
		).toBe(
			'GET /rest/v1/notes?apikey=[REDACTED]&select=id fetching[REDACTED JWT]'
		);
	});
});

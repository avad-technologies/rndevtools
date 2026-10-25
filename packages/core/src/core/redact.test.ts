import { createZustandPlugin } from '../plugins/zustand';
import {
	diagnosticErrorText,
	isSensitiveDiagnosticKey,
	redactDiagnosticText,
	sanitizeDiagnosticValue,
	sanitizeDiagnosticValueWithMetadata,
} from './redact';
import { serializeValue } from './serialize';

function base64Url(value: unknown): string {
	return btoa(JSON.stringify(value))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

/** Builds token-shaped fixtures at runtime so no key literal sits in source. */
function jwt(payload: Record<string, unknown>, signature = 'c2lnbmF0dXJl') {
	return `${base64Url({ alg: 'HS256', typ: 'JWT' })}.${base64Url(payload)}.${signature}`;
}

const STACK_ID =
	'64616c83912c48442ec266f86ee2d7f004d2be5c8b7f31a6d6b4c2634f82145f';

describe('redactDiagnosticText', () => {
	it('redacts quoted JSON credentials and URL-style assignments', () => {
		expect(
			redactDiagnosticText(
				'{"token":"secret-value","user_id":"person-42"} ?api_key=abc&access_token=def&email=person@example.com authorization: Bearer opaque-token',
			),
		).toBe(
			'{"token":"[REDACTED]","user_id":"[REDACTED]"} ?api_key=[REDACTED]&access_token=[REDACTED]&email=[REDACTED] authorization: [REDACTED]',
		);
	});

	it('redacts escaped and unterminated quoted credential values', () => {
		expect(
			redactDiagnosticText(
				'{"password":"first\\"second","token":"unterminated secret',
			),
		).toBe('{"password":"[REDACTED]","token":"[REDACTED]"');
	});

	it('redacts a quoted credential that ends in a backslash or escapes a line break', () => {
		// Both used to end no match, and the unquoted rule skips a quoted value,
		// so the whole value stayed in clear.
		expect(redactDiagnosticText('password="hunter2\\')).toBe(
			'password="[REDACTED]"',
		);
		expect(redactDiagnosticText("secret: 'hunter2\\")).toBe(
			"secret: '[REDACTED]'",
		);
		for (const lineTerminator of ['\n', '\r', '\u2028', '\u2029']) {
			expect(
				redactDiagnosticText(`password="hunter2\\${lineTerminator}rest" tail`),
			).toBe('password="[REDACTED]" tail');
			expect(
				redactDiagnosticText(`secret: 'hunter2\\${lineTerminator}rest' tail`),
			).toBe("secret: '[REDACTED]' tail");
		}
	});

	it('redacts a long quoted credential without overflowing the regexp stack', () => {
		// The previous rules grew V8's regexp stack by a frame per character and
		// overflowed at about 8 Mi characters. Both scans take 40 ms on this
		// Mac, and a quadratic one would take hours.
		const value = 'p'.repeat(9 * 1024 * 1024);
		const startedAt = Date.now();
		expect(redactDiagnosticText(`password="${value}" tail`)).toBe(
			'password="[REDACTED]" tail',
		);
		expect(redactDiagnosticText(`secret: '${value}`)).toBe(
			"secret: '[REDACTED]'",
		);
		expect(Date.now() - startedAt).toBeLessThan(5_000);
	});

	it('ends a quoted value where the single regexp of the rule ends it', () => {
		// The rules as one regexp each, for the one sensitive name these texts
		// hold. A quote follows every separator, so no other rule matches.
		const doubleQuoted =
			/(["']?password["']?\s*[=:]\s*)"[^"\\]*(?:\\[\s\S][^"\\]*)*(?:"|\\?$)/gi;
		const singleQuoted =
			/(["']?password["']?\s*[=:]\s*)'[^'\\]*(?:\\[\s\S][^'\\]*)*(?:'|\\?$)/gi;
		const regexpForm = (text: string) =>
			text
				.replace(doubleQuoted, '$1"[REDACTED]"')
				.replace(singleQuoted, "$1'[REDACTED]'");
		const pieces = [
			'password',
			'PASSWORD',
			'"password"',
			"'password'",
			'="',
			"='",
			': "',
			":'",
			'"',
			"'",
			'\\',
			'\\\\',
			'\\"',
			"\\'",
			'a',
			' ',
			'\n',
			'\r',
			'\u2028',
			'\u2029',
		];
		let seed = 1;
		const nextPiece = () => {
			// A fixed-seed Lehmer generator, so a failure reproduces.
			seed = (seed * 48_271) % 2_147_483_647;
			return pieces[seed % pieces.length] ?? '';
		};
		const mismatches: string[] = [];
		for (let run = 0; run < 20_000; run += 1) {
			const text = Array.from({ length: 1 + (run % 24) }, nextPiece).join('');
			if (redactDiagnosticText(text) !== regexpForm(text))
				mismatches.push(text);
		}
		// Values of more than one step of escapes, ending at a quote, at a lone
		// backslash or at the end of the text.
		for (const escapes of [1_023, 1_024, 1_025, 2_048, 2_049, 3_000]) {
			for (const sequence of ['\\n', '\\"', '\\\\']) {
				for (const end of ['" tail', '\\', '']) {
					const text = `password="${sequence.repeat(escapes)}${end}`;
					if (redactDiagnosticText(text) !== regexpForm(text)) {
						mismatches.push(`${escapes} ${sequence} ${end}`);
					}
				}
			}
		}
		expect(mismatches).toEqual([]);
	});

	it('redacts a quoted value of 32 Mi escapes without overflowing the regexp stack', () => {
		// The regexp form pushed a frame per escape and overflowed V8's regexp
		// stack at about 4 Mi of them. Both scans take 170 ms on this Mac, and
		// steps that each rescanned the value up to their end would take
		// minutes.
		const escapes = '\\n'.repeat(16 * 1024 * 1024);
		const startedAt = Date.now();
		expect(redactDiagnosticText(`password="${escapes}" tail`)).toBe(
			'password="[REDACTED]" tail',
		);
		expect(redactDiagnosticText(`secret: '${escapes}`)).toBe(
			"secret: '[REDACTED]'",
		);
		expect(Date.now() - startedAt).toBeLessThan(10_000);
	});

	it('formats hostile thrown values without trusting coercion', () => {
		const coerce = jest.fn(() => 'token=private-coercion');
		const hostile = { toString: coerce };
		expect(diagnosticErrorText(hostile)).toBe('Unknown error');
		expect(coerce).not.toHaveBeenCalled();
		const error = new Error('safe');
		const getter = jest.fn(() => 'unsafe');
		Object.defineProperty(error, 'message', {
			configurable: true,
			get: getter,
		});
		expect(diagnosticErrorText(error)).toBe('Error');
		expect(getter).not.toHaveBeenCalled();
	});

	it('redacts a bounded window of a long thrown value', () => {
		// Each was redacted or converted whole, which took most of a second for
		// 64 Mi code units, or for this bigint, on this Mac.
		const long = `token=abc ${'x'.repeat(64 * 1024 * 1024)}`;
		const kept = (head: string) =>
			`${`${head}token=[REDACTED] ${'x'.repeat((1024 + 64) * 1024)}`.slice(0, (1024 + 64) * 1024 - 3)}…`;
		const replace = jest.spyOn(String.prototype, 'replace');
		let texts: string[] = [];
		try {
			texts = [long, new Error(long), Symbol(long)].map(diagnosticErrorText);
			const scanned = replace.mock.contexts.reduce<number>(
				(longest, text) => Math.max(longest, String(text).length),
				0,
			);
			// The longer window of the only pair, as for a string the shared walk
			// projects.
			expect(scanned).toBeLessThanOrEqual(
				(1024 + 3 * 64) * 1024 + '[REDACTED]'.length - 'abc'.length,
			);
		} finally {
			replace.mockRestore();
		}
		expect(texts).toEqual([kept(''), kept(''), kept('Symbol(')]);
		expect(diagnosticErrorText(1n << 20_000_000n)).toBe(
			'[Value omitted: input limit]',
		);
		// Shorter ones read as they did.
		const largest = 10n ** 1_024n - 1n;
		expect(diagnosticErrorText(-largest)).toBe(`-${largest}`);
		expect(diagnosticErrorText(Symbol('token=abc'))).toBe(
			'Symbol(token=[REDACTED]',
		);
		expect(diagnosticErrorText(Symbol())).toBe('Symbol()');
		expect(
			diagnosticErrorText(new Error('failed for person@example.com')),
		).toBe('failed for [REDACTED EMAIL]');
	});

	it('uses intrinsic Date methods instead of instance-owned accessors', () => {
		const value = new Date('2026-08-23T00:00:00.000Z');
		const getTime = jest.fn(() => 0);
		Object.defineProperty(value, 'getTime', { get: getTime });

		expect(sanitizeDiagnosticValue(value)).toBe('2026-08-23T00:00:00.000Z');
		expect(getTime).not.toHaveBeenCalled();
	});
});

describe('redactDiagnosticText backend credentials', () => {
	it('redacts compound secret names in env, JSON, and YAML assignments', () => {
		expect(redactDiagnosticText('SECRET_KEY=sb_secret_x')).toBe(
			'SECRET_KEY=[REDACTED]',
		);
		expect(redactDiagnosticText('{"SECRET_KEY":"sb_secret_x"}')).toBe(
			'{"SECRET_KEY":"[REDACTED]"}',
		);
		expect(redactDiagnosticText('SECRET_KEY: sb_secret_x')).toBe(
			'SECRET_KEY: [REDACTED]',
		);
		expect(
			redactDiagnosticText(`SERVICE_ROLE_KEY=${jwt({ role: 'service_role' })}`),
		).toBe('SERVICE_ROLE_KEY=[REDACTED]');
		expect(
			redactDiagnosticText(
				`{"serviceRoleKey":"${jwt({ role: 'service_role' })}"}`,
			),
		).toBe('{"serviceRoleKey":"[REDACTED]"}');
		expect(redactDiagnosticText(`ROOT_KEY=${'0a'.repeat(32)}`)).toBe(
			'ROOT_KEY=[REDACTED]',
		);
		expect(
			redactDiagnosticText(
				'DB_URL=postgresql://postgres:pw@127.0.0.1:54322/postgres',
			),
		).toBe('DB_URL=[REDACTED]');
	});

	it('redacts secrets whose sensitive word is followed by more of the name', () => {
		const text = [
			'SUPABASE_AUTH_SECRET_KEY=one',
			'JWT_SECRET=two',
			'S3_PROTOCOL_ACCESS_KEY_SECRET=three',
			'AWS_SECRET_ACCESS_KEY=four',
			'secret_access_key = "five"',
			'SUPABASE_DB_ROOT_KEY=six',
		].join('\n');
		expect(redactDiagnosticText(text)).toBe(
			[
				'SUPABASE_AUTH_SECRET_KEY=[REDACTED]',
				'JWT_SECRET=[REDACTED]',
				'S3_PROTOCOL_ACCESS_KEY_SECRET=[REDACTED]',
				'AWS_SECRET_ACCESS_KEY=[REDACTED]',
				'secret_access_key = "[REDACTED]"',
				'SUPABASE_DB_ROOT_KEY=[REDACTED]',
			].join('\n'),
		);
	});

	it('redacts bare secret API keys under any name or encoding', () => {
		expect(redactDiagnosticText('using sb_secret_x for admin')).toBe(
			'using [REDACTED SECRET KEY] for admin',
		);
		expect(redactDiagnosticText('{"key":"sb_secret_abc-DEF_123"}')).toBe(
			'{"key":"[REDACTED SECRET KEY]"}',
		);
		expect(redactDiagnosticText('apikey%3Dsb_secret_x%26next')).toBe(
			'apikey%3D[REDACTED SECRET KEY]%26next',
		);
	});

	it('redacts URL passwords but keeps the user and the address', () => {
		expect(
			redactDiagnosticText('postgresql://postgres:pw@127.0.0.1:1/postgres'),
		).toBe('postgresql://postgres:[REDACTED]@127.0.0.1:1/postgres');
		expect(
			redactDiagnosticText('postgres://admin:p@ss:w0rd@192.0.2.5:5432/app'),
		).toBe('postgres://admin:[REDACTED]@192.0.2.5:5432/app');
		expect(redactDiagnosticText('redis://:pw@127.0.0.1:6379')).toBe(
			'redis://:[REDACTED]@127.0.0.1:6379',
		);
		expect(redactDiagnosticText('connect //svc:pw@[::1]:5432/db')).toBe(
			'connect //svc:[REDACTED]@[::1]:5432/db',
		);
	});

	it('stops a URL password at the end of its quoted value', () => {
		expect(
			redactDiagnosticText(
				'{"url":"postgres://u:pw@127.0.0.1/db","note":"ping person@example.com"}',
			),
		).toBe(
			'{"url":"postgres://u:[REDACTED]@127.0.0.1/db","note":"ping [REDACTED EMAIL]"}',
		);
	});

	it('leaves URL passwords that another layer already redacted', () => {
		for (const text of [
			'https://%5BREDACTED%5D:%5BREDACTED%5D@127.0.0.1/a',
			'https://user:%5bredacted%5d@127.0.0.1/a',
			'postgres://u:[REDACTED]@127.0.0.1/db',
		]) {
			expect(redactDiagnosticText(text)).toBe(text);
		}
	});

	it('redacts the upstream credential query parameters', () => {
		expect(
			redactDiagnosticText(
				'https://example.com/callback?code=pkce-code&state=kept#access_token=a&refresh_token=b&provider_token=c&provider_refresh_token=d&expires_in=3600',
			),
		).toBe(
			'https://example.com/callback?code=[REDACTED]&state=kept#access_token=[REDACTED]&refresh_token=[REDACTED]&provider_token=[REDACTED]&provider_refresh_token=[REDACTED]&expires_in=3600',
		);
		expect(
			redactDiagnosticText(
				'/auth/v1/verify?token_hash=hash&type=email&apikey=k&jwt=j&id_token=i&token=t',
			),
		).toBe(
			'/auth/v1/verify?token_hash=[REDACTED]&type=email&apikey=[REDACTED]&jwt=[REDACTED]&id_token=[REDACTED]&token=[REDACTED]',
		);
		expect(
			redactDiagnosticText(
				'/storage/v1/s3/b/o?X-Amz-Credential=id%2Fscope&X-Amz-Signature=sig&X-Amz-Security-Token=st&X-Amz-Expires=60',
			),
		).toBe(
			'/storage/v1/s3/b/o?X-Amz-Credential=[REDACTED]&X-Amz-Signature=[REDACTED]&X-Amz-Security-Token=[REDACTED]&X-Amz-Expires=60',
		);
	});

	it('redacts JWTs that carry no signature', () => {
		expect(redactDiagnosticText(`token ${jwt({ sub: '1' }, '')} end`)).toBe(
			'token [REDACTED JWT] end',
		);
	});

	it('keeps the text around addresses and token-like runs it does not redact', () => {
		expect(redactDiagnosticText('-person@example.com')).toBe(
			'-[REDACTED EMAIL]',
		);
		expect(redactDiagnosticText('ping .a.b@example.co.uk.')).toBe(
			'ping .[REDACTED EMAIL].',
		);
		expect(redactDiagnosticText('eyJ-eyJabc.def end')).toBe(
			'eyJ-eyJabc.def end',
		);
		expect(redactDiagnosticText(`eyJ.${jwt({ sub: '1' })}.extra`)).toBe(
			'eyJ.[REDACTED JWT].extra',
		);
	});

	it('redacts an address that directly follows another one', () => {
		expect(
			redactDiagnosticText('GET /search?q=alice@example.com%20bob@example.org'),
		).toBe('GET /search?q=[REDACTED EMAIL][REDACTED EMAIL]');
		for (const joiner of ['%2C', '+', '-']) {
			expect(
				redactDiagnosticText(`alice@example.com${joiner}bob@example.org`),
			).toBe('[REDACTED EMAIL][REDACTED EMAIL]');
		}
		expect(redactDiagnosticText('to a@x.com+b@y.com+c@z.com, d@w.io')).toBe(
			'to [REDACTED EMAIL][REDACTED EMAIL][REDACTED EMAIL], [REDACTED EMAIL]',
		);
		expect(redactDiagnosticText('a@b.co.a@b.co.')).toBe(
			'[REDACTED EMAIL][REDACTED EMAIL].',
		);
	});

	it('redacts addresses exactly as a rule starting at any word boundary does', () => {
		// The rule this one replaced, which was quadratic on long runs. Inputs are
		// whole addresses, broken ones and joiners, so that two addresses often
		// touch; random characters almost never form even one.
		const wordBoundaryRule = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
		const pieces = [
			'alice@example.com',
			'x.y+tag@sub.example.co.uk',
			'_u@ex-ample.io',
			'-lead@example.com',
			'.dot@example.com',
			'a@b.co',
			'a@b.c1',
			'a@b',
			'a@.co',
			'%20',
			'%2C',
			'+',
			'-',
			'.',
			'_',
			'..',
			'@',
			' ',
			',',
			'?q=',
			'/',
			'é',
			'',
		];
		let seed = 1;
		const nextPiece = () => {
			// A fixed-seed Lehmer generator, so a failure reproduces.
			seed = (seed * 48_271) % 2_147_483_647;
			return pieces[seed % pieces.length] ?? '';
		};
		const mismatches: string[] = [];
		for (let run = 0; run < 20_000; run += 1) {
			const text = Array.from({ length: 1 + (run % 7) }, nextPiece).join('');
			if (
				redactDiagnosticText(text) !==
				text.replace(wordBoundaryRule, '[REDACTED EMAIL]')
			) {
				mismatches.push(text);
			}
		}
		expect(mismatches).toEqual([]);
	});

	it('scans long runs without an address or a token in linear time', () => {
		// Each of these took seconds at 64 KiB on this Mac when every word
		// boundary or `-eyJ` restarted a scan to the end of the run.
		const runs = [
			'a.'.repeat(128 * 1024),
			'a-'.repeat(128 * 1024),
			'-eyJ'.repeat(64 * 1024),
		];
		const startedAt = Date.now();
		for (const run of runs) expect(redactDiagnosticText(run)).toBe(run);
		// The retry after an address scans the run that follows it once.
		const afterAddress = `a@b.co${'.a'.repeat(128 * 1024)}`;
		expect(redactDiagnosticText(afterAddress)).toBe(
			`[REDACTED EMAIL]${afterAddress.slice('a@b.co'.length)}`,
		);
		expect(redactDiagnosticText('a@b.co+'.repeat(32 * 1024))).toBe(
			`${'[REDACTED EMAIL]'.repeat(32 * 1024)}+`,
		);
		expect(Date.now() - startedAt).toBeLessThan(1_000);
	});

	it('is stable when callers redact text that was already redacted', () => {
		const once = redactDiagnosticText(
			`SECRET_KEY=sb_secret_x key sb_secret_y ${jwt({ role: 'anon' })} postgresql://postgres:pw@127.0.0.1:1/postgres?code=abc`,
		);
		expect(once).toBe(
			'SECRET_KEY=[REDACTED] key [REDACTED SECRET KEY] [REDACTED JWT] postgresql://postgres:[REDACTED]@127.0.0.1:1/postgres?code=[REDACTED]',
		);
		expect(redactDiagnosticText(once)).toBe(once);
	});

	it('changes nothing when it redacts text it already redacted', () => {
		const pieces = [
			'password',
			'token',
			'secret',
			'api_key',
			'session_id',
			'email',
			'authorization',
			'=',
			':',
			': ',
			'"',
			"'",
			'\\',
			' ',
			'\n',
			',',
			'&',
			'}',
			'?',
			'#',
			';',
			'(',
			'/',
			'//',
			'@',
			'.',
			'-',
			'%',
			'[REDACTED]',
			'[REDACTED',
			']',
			'[REDACTED EMAIL]',
			'[REDACTED JWT]',
			'[REDACTED SECRET KEY]',
			'%5BREDACTED%5D',
			'…',
			'alice@example.com',
			'a@b.co',
			jwt({ sub: '1' }),
			'eyJabc',
			'Bearer ',
			'Bearer abc',
			'Basic ',
			'Token\t',
			'Digest u=',
			'x==',
			'[REDACTED]@',
			'(2) ',
			' (2)',
			'sb_secret_x',
			'?code=abc',
			'postgresql://u:pw@example.invalid',
			'abc',
		];
		let seed = 1;
		const nextPiece = () => {
			seed = (seed * 48_271) % 2_147_483_647;
			return pieces[seed % pieces.length] ?? '';
		};
		const changed: string[] = [];
		for (let run = 0; run < 20_000; run += 1) {
			const text = Array.from({ length: 1 + (run % 13) }, nextPiece).join('');
			const once = redactDiagnosticText(text);
			if (redactDiagnosticText(once) !== once) changed.push(text);
		}
		expect(changed).toEqual([]);
		// What a cut leaves at the end of a redacted text, which the serializer
		// redacts again.
		for (const text of [
			'token=[REDACTED]…',
			'https://example.com/callback?code=[REDACTED]…',
			'token=…',
			'password="[REDACTED]"…',
			'postgres://token:[REDACTED]@db.example.com/app',
		]) {
			expect(redactDiagnosticText(text)).toBe(text);
		}
	});

	it('redacts a Bearer token as far as any other value', () => {
		// Its tail used to be kept, and redacted again by a second pass.
		expect(
			redactDiagnosticText('authorization: Bearer opaque|token-tail next'),
		).toBe('authorization: [REDACTED] next');
	});

	it('redacts the password of a URL whose user is an email address', () => {
		expect(
			redactDiagnosticText(
				'smtp://alice@example.com:hunter2!x@smtp.example.com:587',
			),
		).toBe('smtp://[REDACTED EMAIL]:[REDACTED]@smtp.example.com:587');
	});

	it('redacts a URL password that only starts like a marker', () => {
		expect(
			redactDiagnosticText('postgres://u:[REDACTEDhunter2@127.0.0.1:5432/app'),
		).toBe('postgres://u:[REDACTED]@127.0.0.1:5432/app');
	});

	it('redacts a URL password that only starts with a marker', () => {
		// The password runs to the last `@`, so a marker and an `@` start it
		// without being all of it.
		expect(
			redactDiagnosticText(
				'postgres://u:[REDACTED]@hunter2@127.0.0.1:5432/app',
			),
		).toBe('postgres://u:[REDACTED]@127.0.0.1:5432/app');
		expect(
			redactDiagnosticText('postgres://u:%5BREDACTED%5D@ss@db.example.com/app'),
		).toBe('postgres://u:[REDACTED]@db.example.com/app');
		expect(
			redactDiagnosticText(
				'https://token:[REDACTED]@hunter2@db.example.com/app',
			),
		).toBe('https://token:[REDACTED]@db.example.com/app');
	});

	it('redacts a value that only starts with the marker of a URL password', () => {
		// Only a URL whose user is a sensitive name keeps what follows the
		// marker, which is the address.
		expect(redactDiagnosticText('token=[REDACTED]@hunter2')).toBe(
			'token=[REDACTED]',
		);
		expect(redactDiagnosticText('password: [REDACTED]@hunter2 next')).toBe(
			'password: [REDACTED] next',
		);
		expect(redactDiagnosticText('api_key=[REDACTED]@s3cr3t-tail')).toBe(
			'api_key=[REDACTED]',
		);
		// A colon without the `//` of a URL before the name is an assignment.
		expect(redactDiagnosticText('token:[REDACTED]@hunter2')).toBe(
			'token:[REDACTED]',
		);
		expect(redactDiagnosticText('password:[REDACTED]@hunter2 next')).toBe(
			'password:[REDACTED] next',
		);
		for (const text of [
			'postgres://token:[REDACTED]@db.example.com/app',
			'redis://my_token:[REDACTED]@127.0.0.1:6379',
		]) {
			expect(redactDiagnosticText(text)).toBe(text);
		}
	});

	it('redacts the credentials after any Authorization scheme', () => {
		// Only the scheme word used to be redacted, and the base64 of
		// `user:hunter2` stayed in clear.
		expect(redactDiagnosticText('authorization: Basic dXNlcjpodW50ZXIy')).toBe(
			'authorization: [REDACTED]',
		);
		expect(redactDiagnosticText('Authorization: Token abc123secret')).toBe(
			'Authorization: [REDACTED]',
		);
		expect(
			redactDiagnosticText('Proxy-Authorization: Negotiate YIIBzQYGKwY next'),
		).toBe('Proxy-Authorization: [REDACTED] next');
		expect(
			redactDiagnosticText('authorization=Basic dXNlcjpodW50ZXIy, retry=1'),
		).toBe('authorization=[REDACTED], retry=1');
		expect(redactDiagnosticText('authorization: Basic dXNlcg==, retry=1')).toBe(
			'authorization: [REDACTED], retry=1',
		);
		// Parameters run to the end of the line, past commas and quoted spaces.
		expect(
			redactDiagnosticText(
				'Authorization: Digest username="u", realm="Example Realm", response="6629fae4"\nnext',
			),
		).toBe('Authorization: [REDACTED]\nnext');
		expect(
			redactDiagnosticText(
				'authorization: AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=host;x-amz-date, Signature=5d672d79c15b',
			),
		).toBe('authorization: [REDACTED]');
		expect(
			redactDiagnosticText(
				'Authorization: SharedAccessSignature sr=uri&sig=s3cr3t&se=1&skn=k',
			),
		).toBe('Authorization: [REDACTED]');
		// A JSON document can hold the header with its quotes escaped.
		expect(
			redactDiagnosticText(
				'{"header":"Authorization: Digest username=\\"u\\", response=\\"6629fae4\\""}',
			),
		).toBe('{"header":"Authorization: [REDACTED]');
		// A tab separates the credentials as a space does.
		expect(redactDiagnosticText('authorization: Basic\tdXNlcjpodW50ZXIy')).toBe(
			'authorization: [REDACTED]',
		);
		// The credentials are on the scheme's line.
		expect(redactDiagnosticText('authorization: Basic\nnext line')).toBe(
			'authorization: [REDACTED]\nnext line',
		);
		for (const lineTerminator of ['\n', '\r', '\u2028', '\u2029']) {
			expect(
				redactDiagnosticText(
					`Authorization: Digest username="u", response="6629fae4"${lineTerminator}next`,
				),
			).toBe(`Authorization: [REDACTED]${lineTerminator}next`);
		}
	});

	it('reads an = that ends a token as its padding', () => {
		// A single pad followed by a quote, a semicolon or a parenthesis was read
		// as the first of a list of parameters, and the rest of the line was
		// replaced with the credentials.
		expect(
			redactDiagnosticText(
				'["authorization: Basic dXNlcjpwYXM=","accept: */*"]',
			),
		).toBe('["authorization: [REDACTED],"accept: */*"]');
		expect(
			redactDiagnosticText(
				"curl -H 'Authorization: Basic dXNlcjpwYXM=' https://example.com/api -d '{\"a\":1}'",
			),
		).toBe(
			"curl -H 'Authorization: [REDACTED] https://example.com/api -d '{\"a\":1}'",
		);
		expect(
			redactDiagnosticText('Authorization: Basic dXNlcjpwYXM=; next=1'),
		).toBe('Authorization: [REDACTED] next=1');
		expect(
			redactDiagnosticText('(Authorization: Basic dXNlcjpwYXM=) then user=bob'),
		).toBe('(Authorization: [REDACTED] then user=bob');
		expect(
			redactDiagnosticText(
				JSON.stringify([
					'curl -H "Authorization: Basic dXNlcjpwYXM=" -H "Accept: */*"',
				]),
			),
		).toBe('["curl -H \\"Authorization: [REDACTED] -H \\"Accept: */*\\""]');
		// A parameter's value is a token or a quoted string that a comma, an `&`
		// or the end of the line follows, and a token starts with a letter, a
		// digit or one of `_+/%.~-`, never with a parenthesis, a bracket, a bar
		// or a semicolon.
		expect(
			redactDiagnosticText('Authorization: Basic dXNlcjpwYXM=, retry=1'),
		).toBe('Authorization: [REDACTED], retry=1');
		expect(
			redactDiagnosticText('(Authorization: Basic dXNlcjpwYXM=), retry=1'),
		).toBe('(Authorization: [REDACTED], retry=1');
		expect(
			redactDiagnosticText('[Authorization: Basic dXNlcjpwYXM=], retry=1'),
		).toBe('[Authorization: [REDACTED], retry=1');
		expect(
			redactDiagnosticText('Authorization: Basic dXNlcjpwYXM=|, retry=1'),
		).toBe('Authorization: [REDACTED], retry=1');
		expect(
			redactDiagnosticText('Authorization: Basic dXNlcjpwYXM=;q=1, retry=1'),
		).toBe('Authorization: [REDACTED], retry=1');
		// The quote after an escaped backslash ends a quoted value.
		expect(
			redactDiagnosticText('Authorization: Custom a="a\\\\"b", retry=1'),
		).toBe('Authorization: [REDACTED], retry=1');
		expect(
			redactDiagnosticText('["authorization: Digest qop=auth","accept: */*"]'),
		).toBe('["authorization: [REDACTED],"accept: */*"]');
		expect(redactDiagnosticText('Authorization: Custom a=1, sig=abc')).toBe(
			'Authorization: [REDACTED]',
		);
		// Spaces may come before the comma, and an `&` may follow a quoted value
		// as a comma does, in a JSON document too.
		for (const header of [
			'Authorization: Digest username="u" , response="6629fae4"',
			'Authorization: Custom a="u"&sig=sigSECRETvalue',
		]) {
			expect(redactDiagnosticText(header)).toBe('Authorization: [REDACTED]');
			expect(redactDiagnosticText(JSON.stringify({ header }))).toBe(
				'{"header":"Authorization: [REDACTED]',
			);
		}
	});

	it('reads a list whose first value starts with punctuation, holds escapes or ends a JSON string', () => {
		// Each of these kept the parameters after the first, or the text after a
		// quoted space, in clear.
		const firstValues = [
			'path=/v1/x',
			'key=_abc',
			'nonce=+abc',
			'a=%2F',
			'a=.x',
			'a=~x',
			'a=-x',
		];
		const lists: [text: string, redacted: string][] = [
			...firstValues.map((first): [string, string] => [
				`Authorization: Custom ${first}, sig=sigSECRETvalue`,
				'Authorization: [REDACTED]',
			]),
			[
				'Authorization: Digest username="Mu\\"fasa", response="6629fae4"',
				'Authorization: [REDACTED]',
			],
			// A raw value that ends at its first quote starts a list whatever
			// backslashes it holds, past the cap on escapes too.
			[
				`Authorization: Custom a="${'\\x'.repeat(1_025)}", sig=sigSECRETvalue`,
				'Authorization: [REDACTED]',
			],
			[
				'Authorization: Digest realm="C:\\dir\\", response="6629fae49393a05397450978507c4ef1"',
				'Authorization: [REDACTED]',
			],
			// A JSON document escapes the quotes and backslashes of the header, and
			// the quote that closes its string ends the line.
			...[
				'Authorization: Digest username="DOMAIN\\Mufasa", cnonce="0a4f113b", response="6629fae4"',
				'Authorization: Digest username="Mu\\"fasa", response="6629fae4"',
			].map((header): [string, string] => [
				JSON.stringify({ header }),
				'{"header":"Authorization: [REDACTED]',
			]),
			// As Python's json.dumps writes it, which escapes what is not ASCII.
			[
				'{"h": "Authorization: Digest username=\\"Jos\\u00e9\\", response=\\"6629fae4\\""}',
				'{"h": "Authorization: [REDACTED]',
			],
			[
				JSON.stringify([
					'authorization: Token token="abc123 secretpart"',
					'accept: */*',
				]),
				'["authorization: [REDACTED]',
			],
		];
		for (const [text, redacted] of lists) {
			expect(redactDiagnosticText(text)).toBe(redacted);
			expect(redactDiagnosticText(redacted)).toBe(redacted);
		}
		// The escapes of a first value are capped, as the quoted-value rules cap
		// theirs, so a long one cannot overflow the regexp stack. One of more
		// escapes starts a list only when it is raw and ends at its first quote,
		// which one run of one character class reads.
		const escaped = (sequence: string, escapes: number) =>
			`Authorization: Custom a="${sequence.repeat(escapes)}", retry=1`;
		for (const sequence of ['\\n', '\\"']) {
			expect(redactDiagnosticText(escaped(sequence, 1_024))).toBe(
				'Authorization: [REDACTED]',
			);
			expect(
				redactDiagnosticText(JSON.stringify([escaped(sequence, 1_024)])),
			).toBe('["Authorization: [REDACTED]');
		}
		for (const escapes of [1_025, 4 * 1024 * 1024]) {
			expect(redactDiagnosticText(escaped('\\n', escapes))).toBe(
				'Authorization: [REDACTED]',
			);
			expect(redactDiagnosticText(escaped('\\"', escapes))).toBe(
				'Authorization: [REDACTED], retry=1',
			);
			expect(
				redactDiagnosticText(JSON.stringify([escaped('\\n', escapes)])),
			).toBe('["Authorization: [REDACTED], retry=1"]');
		}
	});

	it('keeps stack ids, publishable keys, and non-credential codes', () => {
		const kept = [
			`stack ${STACK_ID} started`,
			`--stack-id ${STACK_ID}`,
			`{"id":"${STACK_ID}"}`,
			'PUBLISHABLE_KEY=sb_publishable_x',
			'{"publishable_key":"sb_publishable_x"}',
			'keys starting with sb_secret_ are refused',
			'exit code=1',
			'{"code":"PGRST116","message":"no rows"}',
			'error_code=42',
			'postgres://postgres@127.0.0.1:54322/postgres',
			'http://127.0.0.1:54321/rest/v1',
		];
		for (const text of kept) expect(redactDiagnosticText(text)).toBe(text);
	});
});

describe('isSensitiveDiagnosticKey backend names', () => {
	it('flags secret-bearing names whose values have no recognizable shape', () => {
		for (const key of [
			'SERVICE_ROLE_KEY',
			'serviceRoleKey',
			'ROOT_KEY',
			'rootKey',
			'DB_URL',
			'dbUrl',
			'X-Amz-Signature',
			'X-Amz-Credential',
		]) {
			expect(isSensitiveDiagnosticKey(key)).toBe(true);
		}
	});

	it('keeps public names readable', () => {
		for (const key of ['PUBLISHABLE_KEY', 'ANON_KEY', 'API_URL', 'stackId']) {
			expect(isSensitiveDiagnosticKey(key)).toBe(false);
		}
	});

	it('projects a stack env map without its secrets', () => {
		const serialized = JSON.stringify(
			sanitizeDiagnosticValue({
				env: {
					API_URL: 'http://127.0.0.1:54321',
					DB_URL: 'postgresql://postgres:pw@127.0.0.1:54322/postgres',
					PUBLISHABLE_KEY: 'sb_publishable_x',
					ROOT_KEY: '0a'.repeat(32),
					SECRET_KEY: 'sb_secret_x',
					SERVICE_ROLE_KEY: jwt({ role: 'service_role' }),
				},
				endpoint: 'postgresql://postgres:pw@127.0.0.1:54322/postgres',
				id: STACK_ID,
			}),
		);
		expect(serialized).not.toContain('sb_secret_');
		expect(serialized).not.toContain('eyJ');
		expect(serialized).not.toContain(':pw@');
		expect(serialized).not.toContain('0a'.repeat(32));
		expect(serialized).toContain('sb_publishable_x');
		expect(serialized).toContain('http://127.0.0.1:54321');
		expect(serialized).toContain(
			'postgresql://postgres:[REDACTED]@127.0.0.1:54322',
		);
		expect(serialized).toContain(STACK_ID);
	});
});

describe('sanitizeDiagnosticValue', () => {
	it('redacts sensitive fields without invoking accessors', () => {
		const value = {
			accessToken: 'private-token',
			get dangerous() {
				throw new Error('getter must not run');
			},
			nested: { email: 'person@example.com', public: 'visible' },
		};

		const sanitized = sanitizeDiagnosticValue(value);
		const serialized = JSON.stringify(sanitized);

		expect(serialized).toContain('[REDACTED]');
		expect(serialized).toContain('[Accessor omitted]');
		expect(serialized).toContain('visible');
		expect(serialized).not.toContain('private-token');
		expect(serialized).not.toContain('person@example.com');
	});

	it('treats prototype-shaped keys as ordinary detached data', () => {
		const value = Object.create(null) as Record<string, unknown>;
		Object.defineProperty(value, '__proto__', {
			configurable: true,
			enumerable: true,
			value: { polluted: true },
			writable: true,
		});

		const sanitized = sanitizeDiagnosticValue(value) as Record<string, unknown>;

		expect(Object.getPrototypeOf(sanitized)).toBeNull();
		expect(Object.hasOwn(sanitized, '__proto__')).toBe(true);
		expect(JSON.stringify(sanitized)).toContain('polluted');
		expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
	});

	it('reports structural omissions', () => {
		const sanitized = sanitizeDiagnosticValueWithMetadata(
			Array.from({ length: 101 }, (_, index) => index),
		);

		expect(sanitized.truncated).toBe(true);
		expect(sanitized.value).toHaveLength(100);
	});

	it('summarizes binary views instead of walking their elements', () => {
		const bytes = new Uint8Array(4_000_000);
		const byteLength = jest.fn(() => 0);
		Object.defineProperty(bytes, 'byteLength', { get: byteLength });
		const view = new DataView(new ArrayBuffer(12));

		const projection = sanitizeDiagnosticValueWithMetadata({
			avatar: bytes,
			samples: new Float32Array(2),
			view,
		});

		expect(projection.value).toEqual({
			avatar: { type: 'Uint8Array', byteLength: 4_000_000 },
			samples: { type: 'Float32Array', byteLength: 8 },
			view: { type: 'DataView', byteLength: 12 },
		});
		expect(projection.truncated).toBe(true);
		expect(byteLength).not.toHaveBeenCalled();
	});

	it('reads only the array entries that survive the entry cap', () => {
		const read = jest.fn();
		const values = new Proxy(new Array<number>(1_000_000).fill(1), {
			getOwnPropertyDescriptor(target, key) {
				read(key);
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
		});

		const projection = sanitizeDiagnosticValueWithMetadata(values);

		expect(projection.value).toHaveLength(100);
		expect(projection.truncated).toBe(true);
		// The length, then one descriptor per kept index.
		expect(read).toHaveBeenCalledTimes(101);
	});

	it('keeps the first 100 fields of a larger object in order', () => {
		const value: Record<string, unknown> = Object.fromEntries(
			Array.from({ length: 150 }, (_, index) => [`field${index}`, index]),
		);
		value.field3 = 'token=private';

		const projection = sanitizeDiagnosticValueWithMetadata(value);
		const keys = Object.keys(projection.value as object);

		expect(keys).toHaveLength(100);
		expect(keys[0]).toBe('field0');
		expect(keys[99]).toBe('field99');
		expect(projection.truncated).toBe(true);
		expect(JSON.stringify(projection.value)).not.toContain('private');
	});

	it('reports whether a projection was redacted', () => {
		expect(
			sanitizeDiagnosticValueWithMetadata({ count: 1, ready: true }).redacted,
		).toBe(false);
		expect(
			sanitizeDiagnosticValueWithMetadata({ token: 'private-token' }).redacted,
		).toBe(true);
		expect(
			sanitizeDiagnosticValueWithMetadata('email=user@example.com').redacted,
		).toBe(true);
	});

	it('does not invoke array accessors or include non-enumerable fields', () => {
		const array: unknown[] = [];
		Object.defineProperty(array, '0', {
			enumerable: true,
			get() {
				throw new Error('array getter must not run');
			},
		});
		array.length = 1;
		const object = { visible: true } as Record<string, unknown>;
		Object.defineProperty(object, 'hidden', {
			enumerable: false,
			value: 'private implementation detail',
		});

		expect(sanitizeDiagnosticValue(array)).toEqual(['[Accessor omitted]']);
		expect(JSON.stringify(sanitizeDiagnosticValue(object))).toBe(
			'{"visible":true}',
		);
	});

	it('projects Map and Set contents instead of empty objects', () => {
		// Neither exposes entries as own properties, and the app rehydrates real
		// state (pinned notes) into a Map, so a descriptor walk shows nothing.
		expect(
			sanitizeDiagnosticValue(
				new Map([
					['first', 1],
					['second', 2],
				]),
			),
		).toEqual({
			type: 'Map',
			size: 2,
			entries: [
				['first', 1],
				['second', 2],
			],
		});
		expect(sanitizeDiagnosticValue(new Set(['a', 'b']))).toEqual({
			type: 'Set',
			size: 2,
			entries: ['a', 'b'],
		});
	});

	it('redacts credential-shaped values inside a Map', () => {
		expect(
			JSON.stringify(
				sanitizeDiagnosticValue(new Map([['owner', 'user@example.com']])),
			),
		).toContain('[REDACTED EMAIL]');
	});

	it('reports a value referenced twice in one tree without calling it a cycle', () => {
		const shared = { id: 'item-1', count: 8 };
		const projection = sanitizeDiagnosticValueWithMetadata({
			current: shared,
			items: [shared],
		});
		const serialized = JSON.stringify(projection.value);
		expect(serialized).not.toContain('[Circular]');
		expect(projection.truncated).toBe(false);
	});

	it('marks cycles and depth limits without throwing', () => {
		const cyclic: Record<string, unknown> = { name: 'root' };
		cyclic.self = cyclic;
		expect(JSON.stringify(sanitizeDiagnosticValue(cyclic))).toContain(
			'[Circular]',
		);

		let deep: Record<string, unknown> = { leaf: true };
		for (let level = 0; level < 12; level += 1) deep = { deep };
		const projection = sanitizeDiagnosticValueWithMetadata(deep);
		expect(JSON.stringify(projection.value)).toContain('[Depth limit]');
		expect(projection.truncated).toBe(true);
	});

	it('maps non-JSON primitives to stable placeholders', () => {
		expect(
			sanitizeDiagnosticValue({
				big: 10n,
				missing: undefined,
				run: () => true,
				when: new Date(0),
				broken: new Date(Number.NaN),
			}),
		).toEqual({
			big: '10n',
			missing: '[Undefined]',
			run: '[Function]',
			when: '1970-01-01T00:00:00.000Z',
			broken: '[Invalid Date]',
		});
	});

	it('redacts bare bearer tokens and JWTs outside assignments', () => {
		expect(redactDiagnosticText('Bearer abc.def-ghi')).toBe(
			'Bearer [REDACTED]',
		);
		expect(
			redactDiagnosticText('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln'),
		).toBe('[REDACTED JWT]');
	});

	it('treats mixed-case and separator-laden key names as sensitive', () => {
		for (const key of ['AccessToken', 'X-API-KEY', 'user_id', 'Set-Cookie']) {
			expect(sanitizeDiagnosticValue({ [key]: 'value' })).toEqual({
				[key]: '[REDACTED]',
			});
		}
	});

	it('redacts an error stack that carries personal data', () => {
		const error = new Error('failed for user@example.com');
		const projected = sanitizeDiagnosticValue(error) as { message: string };
		expect(projected.message).toBe('failed for [REDACTED EMAIL]');
	});

	it('redacts and bounds keys with the rules that values follow', () => {
		const projection = sanitizeDiagnosticValueWithMetadata({
			'postgresql://postgres:hunter2@db.example.com/app': true,
			'alice.smith@example.com': 1,
			'bob@example.com': 2,
			[jwt({ sub: '1' })]: 3,
			['k'.repeat(2_000)]: 4,
			['k'.repeat(2_001)]: 5,
		});
		const value = projection.value as Record<string, unknown>;
		// Two addresses stay two keys, and so do two keys cut to 1 KiB alike.
		expect(Object.keys(value)).toEqual([
			'postgresql://postgres:[REDACTED]@db.example.com/app',
			'[REDACTED EMAIL]',
			'(2) [REDACTED EMAIL]',
			'[REDACTED JWT]',
			`${'k'.repeat(1_021)}…`,
			`(2) ${'k'.repeat(1_017)}…`,
		]);
		expect(Object.values(value)).toEqual([true, 1, 2, 3, 4, 5]);
		expect(projection).toMatchObject({ redacted: true, truncated: true });
		// What serializeValue and the Console plugin project again stays put.
		expect(sanitizeDiagnosticValue(value)).toEqual(value);
		expect(
			serializeValue({ 'a@example.com': 1, 'b@example.com': 2 }).text,
		).toBe('{\n  "[REDACTED EMAIL]": 1,\n  "(2) [REDACTED EMAIL]": 2\n}');
	});

	it('tests the name of a key as it was logged', () => {
		expect(
			sanitizeDiagnosticValue({
				// Its marker names a sensitive field; the address does not.
				'alice@example.com': 'visible',
				accessToken: 'opaque',
				// Too long to test whole, so its value is redacted.
				[`${'x'.repeat(70_000)}token`]: 'opaque',
			}),
		).toEqual({
			'[REDACTED EMAIL]': 'visible',
			accessToken: '[REDACTED]',
			[`${'x'.repeat(1_021)}…`]: '[REDACTED]',
		});
	});

	it('redacts a bounded window of a 12 Mi key', () => {
		const replace = jest.spyOn(String.prototype, 'replace');
		let projection: unknown;
		try {
			projection = sanitizeDiagnosticValue({
				[`token=${'k'.repeat(12 * 1024 * 1024)}`]: 1,
			});
			const scanned = Math.max(
				...replace.mock.contexts.map((text) => String(text).length),
			);
			expect(scanned).toBeLessThanOrEqual(512 * 1024);
		} finally {
			replace.mockRestore();
		}
		expect(projection).toEqual({ 'token=[REDACTED]…': '[REDACTED]' });
	});

	it('bounds the work on values that share or list large objects', () => {
		const many = Object.fromEntries(
			Array.from({ length: 200_000 }, (_, index) => [`m${index}`, 1]),
		);
		const references = Object.fromEntries(
			Array.from({ length: 100 }, (_, index) => [`r${index}`, many]),
		);
		const table = Object.fromEntries(
			Array.from({ length: 100_000 }, (_, index) => [
				`id${index}`,
				{ n: index },
			]),
		);
		// The walk visits a shared object once per path: 10^10 here.
		const keys = Array.from(
			{ length: 100 },
			(_, index) => `${'k'.repeat(4_096)}${index}`,
		);
		let tree: object = { leaf: 1 };
		for (let depth = 0; depth < 5; depth += 1) {
			const child = tree;
			tree = Object.fromEntries(keys.map((key) => [key, child]));
		}
		const values = [
			references,
			Object.fromEntries(
				Array.from({ length: 100 }, (_, index) => [`s${index}`, references]),
			),
			{ rows: Array.from({ length: 50 }, (_, index) => ({ index, table })) },
			tree,
		];
		const listed = jest.spyOn(Object, 'keys');
		try {
			for (const value of values) {
				listed.mockClear();
				const projection = sanitizeDiagnosticValueWithMetadata(value);
				const keysListed = listed.mock.results.reduce(
					(sum, result) => sum + (result.value as unknown[]).length,
					0,
				);
				expect(projection.truncated).toBe(true);
				// Each key listed is charged, so a large object is listed a few times
				// at most rather than once per reference.
				expect(keysListed).toBeLessThan(3 * 200_000);
			}
		} finally {
			listed.mockRestore();
		}
	});

	it('reads only the entries of a Map or Set that it keeps', () => {
		const map = new Map(
			Array.from({ length: 1_000_000 }, (_, index) => [`k${index}`, index]),
		);
		const set = new Set(map.keys());
		const startedAt = Date.now();
		// Each reference used to copy every entry, 5.4 s in all on this Mac,
		// where reading the entries kept takes 40 ms.
		const projection = sanitizeDiagnosticValueWithMetadata(
			Array.from({ length: 100 }, () => ({ map, set })),
		);
		expect(Date.now() - startedAt).toBeLessThan(2_000);
		const [first] = projection.value as {
			map: { size: number; entries: unknown[] };
			set: { size: number; entries: unknown[] };
		}[];
		expect(first?.map.size).toBe(1_000_000);
		expect(first?.map.entries).toHaveLength(100);
		expect(first?.map.entries[99]).toEqual(['k99', 99]);
		expect(first?.set.size).toBe(1_000_000);
		expect(first?.set.entries).toHaveLength(100);
		expect(projection.truncated).toBe(true);
	});

	it('reads only the error fields it shows', () => {
		const read = jest.fn();
		const extra = Object.fromEntries(
			Array.from({ length: 100_000 }, (_, index) => [`extra${index}`, index]),
		);
		const error = new Proxy(
			Object.assign(new Error('failed for person@example.com'), extra),
			{
				getOwnPropertyDescriptor(target, key) {
					read(key);
					return Reflect.getOwnPropertyDescriptor(target, key);
				},
			},
		);
		expect(sanitizeDiagnosticValue(error)).toMatchObject({
			name: 'Error',
			message: 'failed for [REDACTED EMAIL]',
		});
		expect(read.mock.calls.map(([key]) => key)).toEqual([
			'name',
			'message',
			'stack',
		]);
		read.mockClear();
		expect(diagnosticErrorText(error)).toBe('failed for [REDACTED EMAIL]');
		expect(read.mock.calls.map(([key]) => key)).toEqual(['message', 'name']);
	});

	it('reads a String object as the text it holds', () => {
		expect(
			sanitizeDiagnosticValue(Object('token=abc person@example.com')),
		).toBe('token=[REDACTED] [REDACTED EMAIL]');
		// It lists every index as a key, which took most of a second at 4 Mi on
		// this Mac, so only the object that holds it is listed. Like any text, it
		// is kept up to 1 MiB and 64 KiB.
		const text = 'x'.repeat(4 * 1024 * 1024);
		const listed = jest.spyOn(Object, 'keys');
		let projection: unknown;
		let keysListed = 0;
		try {
			projection = sanitizeDiagnosticValue({ text: Object(text) });
			keysListed = listed.mock.results.reduce(
				(sum, result) => sum + (result.value as unknown[]).length,
				0,
			);
		} finally {
			listed.mockRestore();
		}
		expect(keysListed).toBe(1);
		expect(projection).toEqual({
			text: `${'x'.repeat((1024 + 64) * 1024 - 3)}…`,
		});
	});

	it('redacts the description of a symbol', () => {
		expect(
			sanitizeDiagnosticValue({ marker: Symbol('person@example.com') }),
		).toEqual({ marker: 'Symbol([REDACTED EMAIL])' });
	});

	it('redacts a bounded window of a symbol description and an error field', () => {
		const long = `token=abc ${'x'.repeat(4 * 1024 * 1024)}`;
		const kept = `${`token=[REDACTED] ${'x'.repeat((1024 + 64) * 1024)}`.slice(0, (1024 + 64) * 1024 - 3)}…`;
		const replace = jest.spyOn(String.prototype, 'replace');
		let projection: ReturnType<typeof sanitizeDiagnosticValueWithMetadata>;
		try {
			projection = sanitizeDiagnosticValueWithMetadata({
				marker: Symbol(long),
				error: new Error(long),
			});
			const scanned = replace.mock.contexts.reduce<number>(
				(longest, text) => Math.max(longest, String(text).length),
				0,
			);
			expect(scanned).toBeLessThanOrEqual(
				(1024 + 3 * 64) * 1024 + '[REDACTED]'.length - 'abc'.length,
			);
		} finally {
			replace.mockRestore();
		}
		expect(projection.value).toMatchObject({
			marker: `Symbol(${kept})`,
			error: { name: 'Error', message: kept },
		});
		expect(projection.truncated).toBe(true);
	});

	it('bounds the work on arrays of values that hold no text', () => {
		// One array shared by every path, 10^8 values here. Each such value cost
		// nothing, so the walk took 9 s on this Mac and JSON.stringify then failed
		// with 'Invalid string length'.
		let reads = 0;
		const shared = (leaf: unknown[]): unknown => {
			let node: unknown = new Proxy(leaf, {
				getOwnPropertyDescriptor(target, key) {
					reads += 1;
					return Reflect.getOwnPropertyDescriptor(target, key);
				},
			});
			for (let level = 0; level < 3; level += 1) {
				const child = node;
				node = Array.from({ length: 100 }, () => child);
			}
			return node;
		};
		const accessors: unknown[] = [];
		for (let index = 0; index < 100; index += 1) {
			Object.defineProperty(accessors, index, {
				enumerable: true,
				get() {
					throw new Error('getter must not run');
				},
			});
		}
		for (const leaf of [
			Array(100).fill(undefined),
			Array(100).fill(() => 1),
			Array(100).fill(Symbol('s')),
			new Array(100),
			accessors,
		]) {
			const value = shared(leaf);
			reads = 0;
			const projection = sanitizeDiagnosticValueWithMetadata(value);
			// Each read of the shared array costs 16 of the 4 Mi units, and an
			// array open when they run out reads its remaining 100 entries.
			expect(reads).toBeLessThanOrEqual((4 * 1024 * 1024) / 16 + 100);
			const serialized = serializeValue(value);
			expect(projection.truncated).toBe(true);
			expect(JSON.stringify(projection.value)).toContain(
				'[Value omitted: input limit]',
			);
			expect(serialized.text.startsWith('[\n  [\n    [\n')).toBe(true);
		}
	});

	it('charges the fields of an object that it does not visit', () => {
		// One object of 100 accessors or hidden values, shared by 10^6 paths. If
		// neither kind cost anything, each listing would cost only its keys.
		let listings = 0;
		const shared = (
			fields: (index: number) => [string, PropertyDescriptor],
		) => {
			const leaf = {};
			for (let index = 0; index < 100; index += 1) {
				const [key, descriptor] = fields(index);
				Object.defineProperty(leaf, key, { enumerable: true, ...descriptor });
			}
			let node: unknown = new Proxy(leaf, {
				ownKeys(target) {
					listings += 1;
					return Reflect.ownKeys(target);
				},
			});
			for (let level = 0; level < 3; level += 1) {
				const child = node;
				node = Array.from({ length: 100 }, () => child);
			}
			return node;
		};
		const getter = jest.fn();
		for (const value of [
			shared((index) => [`a${index}`, { get: getter }]),
			shared((index) => [`token${index}`, { value: 'opaque' }]),
		]) {
			listings = 0;
			const projection = sanitizeDiagnosticValueWithMetadata(value);
			// Each field costs 16 of the 4 Mi units to list and 16 not to visit.
			expect(listings).toBeLessThanOrEqual((4 * 1024 * 1024) / (100 * 32) + 1);
			expect(projection.truncated).toBe(true);
			expect(JSON.stringify(projection.value)).not.toContain('opaque');
		}
		expect(getter).not.toHaveBeenCalled();
	});

	it('converts a bigint only up to a bounded number of digits', () => {
		// Converting one of 2,000,000 bits took 57 ms on this Mac each time it
		// was reached.
		const huge = 2n ** 2_000_000n;
		const startedAt = Date.now();
		const projection = sanitizeDiagnosticValueWithMetadata(
			Array(100).fill(huge),
		);
		const elapsed = Date.now() - startedAt;
		expect(projection).toMatchObject({
			value: Array(100).fill('[Value omitted: input limit]'),
			truncated: true,
		});
		expect(elapsed).toBeLessThan(1_000);
		const largest = 10n ** 1_024n - 1n;
		expect(sanitizeDiagnosticValue([largest, -largest, largest + 1n])).toEqual([
			`${largest}n`,
			`-${largest}n`,
			'[Value omitted: input limit]',
		]);
	});

	it('charges a converted bigint for its digits', () => {
		// 10,000 bigints of 1,024 digits. Charged only a value each, all of them
		// would be converted.
		const digits = 10n ** 1_023n;
		const projection = sanitizeDiagnosticValueWithMetadata(
			Array.from({ length: 100 }, () => Array(100).fill(digits)),
		);
		const converted = JSON.stringify(projection.value).split(`${digits}n`);
		expect(converted.length - 1).toBeLessThanOrEqual((4 * 1024 * 1024) / 1_024);
		expect(projection.truncated).toBe(true);
	});

	it('redacts a bounded window of a long string', () => {
		// The whole string was redacted, which took 1 s for 64 Mi under V8's JIT
		// on this Mac.
		const long = `token=abc ${'x'.repeat(64 * 1024 * 1024)}`;
		const replace = jest.spyOn(String.prototype, 'replace');
		let serialized: ReturnType<typeof serializeValue> | undefined;
		try {
			serialized = serializeValue({ s: long });
			const scanned = replace.mock.contexts.reduce<number>(
				(longest, text) => Math.max(longest, String(text).length),
				0,
			);
			// The longer window of the only pair: the 1 MiB and 64 KiB kept, twice
			// the 64 Ki context, and what the marker adds for the later rules.
			expect(scanned).toBeLessThanOrEqual(
				(1024 + 3 * 64) * 1024 + '[REDACTED]'.length - 'abc'.length,
			);
		} finally {
			replace.mockRestore();
		}
		expect(serialized?.truncated).toBe(true);
		expect(serialized?.text.startsWith('{\n  "s": "token=[REDACTED] xxx')).toBe(
			true,
		);
		const projection = sanitizeDiagnosticValueWithMetadata({
			s: 'x'.repeat(4 * 1024 * 1024),
		});
		expect(projection).toEqual({
			value: { s: `${'x'.repeat((1024 + 64) * 1024 - 3)}…` },
			truncated: true,
			redacted: false,
		});
	});

	it('redacts whole a string that a pair of windows would cost more to redact', async () => {
		// A string a little longer than the second window was redacted as a pair
		// of windows, almost twice its length, so two of them spent the budget,
		// and what followed them was omitted.
		const length = Math.floor(1.3 * 1024 * 1024);
		const a = 'x'.repeat(length);
		const b = 'y'.repeat(length);
		expect(sanitizeDiagnosticValue({ a, b, c: { n: 1 }, d: 'v1' })).toEqual({
			a: `${'x'.repeat((1024 + 64) * 1024 - 3)}…`,
			b: `${'y'.repeat((1024 + 64) * 1024 - 3)}…`,
			c: { n: 1 },
			d: 'v1',
		});
		// Whole, it is redacted exactly. Neither window of the pair held the end
		// of this password, so its start was kept.
		const url = `${'x'.repeat(1_100_000)} postgres://u:${'p'.repeat(200_000)}@db.example.com/app`;
		expect(sanitizeDiagnosticValue({ url })).toEqual({
			url: `${'x'.repeat(1_100_000)} postgres://u:[REDACTED]@db.example.com/app`,
		});
		// A Zustand store projects its state through this walk, and an edit next
		// to two such strings went missing from its change log.
		let state = { a, b, counter: 1, user: { name: 'one' } };
		const listeners = new Set<() => void>();
		const diagnostics = createZustandPlugin({
			stores: [
				{
					id: 'docs',
					title: 'Docs',
					getInspectableState: () => state,
					subscribe: (listener) => {
						listeners.add(listener);
						return () => listeners.delete(listener);
					},
				},
			],
		});
		const dispose = diagnostics.plugin.install?.();
		state = { a, b, counter: 2, user: { name: 'two' } };
		for (const listener of listeners) listener();
		await new Promise<void>((resolve) => {
			queueMicrotask(resolve);
		});
		expect(diagnostics.getEvents().map((event) => event.changedKeys)).toEqual([
			['counter', 'user'],
		]);
		dispose?.();
	});

	it('hides a Map value whose key is a credential name', () => {
		// A Map keyed by name holds fields, as an object does.
		const projection = sanitizeDiagnosticValueWithMetadata({
			map: new Map<unknown, unknown>([
				['password', 'hunter2'],
				['accessToken', 'opaque-abc'],
				['note', 'visible'],
				[7, 'seven'],
			]),
		});
		expect(projection.value).toEqual({
			map: {
				type: 'Map',
				size: 4,
				entries: [
					['password', '[REDACTED]'],
					['accessToken', '[REDACTED]'],
					['note', 'visible'],
					[7, 'seven'],
				],
			},
		});
		expect(projection.redacted).toBe(true);
		expect(
			serializeValue(new Map([['client_secret', 'hunter2']])).text,
		).not.toContain('hunter2');
		// As for a field, the name is tested with its markers skipped, and one
		// too long to test whole hides its value.
		const long = 'k'.repeat(70_000);
		expect(
			sanitizeDiagnosticValue(
				new Map([
					['[REDACTED EMAIL]', 'visible'],
					[long, 'opaque'],
				]),
			),
		).toEqual({
			type: 'Map',
			size: 2,
			entries: [
				['[REDACTED EMAIL]', 'visible'],
				[long, '[REDACTED]'],
			],
		});
	});

	it('numbers copies of a key where a second pass keeps the number', () => {
		// After a key that ends in an assignment with no value, a second pass
		// read a trailing number as the value and redacted it.
		const keys = {
			'alice@example.com password=': 1,
			'bob@example.org password=': 2,
		};
		const once = sanitizeDiagnosticValue(keys) as Record<string, unknown>;
		expect(Object.keys(once)).toEqual([
			'[REDACTED EMAIL] password=',
			'(2) [REDACTED EMAIL] password=',
		]);
		expect(sanitizeDiagnosticValue(once)).toEqual(once);
		expect(
			serializeValue(
				sanitizeDiagnosticValue({ 'a@example.com x': 1, 'b@example.com x': 2 }),
			).text,
		).toBe('{\n  "[REDACTED EMAIL] x": 1,\n  "(2) [REDACTED EMAIL] x": 2\n}');
	});

	it('omits a long key and its value once the budget is spent', () => {
		// Listing 300,000 keys spends the budget, so the long keys among the
		// 100 kept are not redacted. A short key still is.
		const value: Record<string, unknown> = {
			['a'.repeat(2_000)]: 'first',
			['b'.repeat(2_000)]: 'second',
			short: 'third',
		};
		for (let index = 0; index < 300_000; index += 1) value[`f${index}`] = index;
		const projection = sanitizeDiagnosticValueWithMetadata(value);
		const output = projection.value as Record<string, unknown>;
		expect(Object.entries(output).slice(0, 4)).toEqual([
			['[Key omitted: input limit]', '[Value omitted: input limit]'],
			['(2) [Key omitted: input limit]', '[Value omitted: input limit]'],
			['short', '[Value omitted: input limit]'],
			['f0', 0],
		]);
		expect(projection.truncated).toBe(true);
	});

	it('charges the budget for each code unit of a key that it tests', () => {
		// Each key is tested and redacted once: 60,000 units for each of these,
		// so the budget runs out among them and the last ones are omitted.
		const value = Object.fromEntries(
			Array.from({ length: 100 }, (_, index) => [
				`${index}`.padStart(30_000, 'k'),
				'v',
			]),
		);
		const output = sanitizeDiagnosticValue(value) as Record<string, unknown>;
		expect(Object.values(output)).toContain('v');
		expect(Object.keys(output)).toContain('[Key omitted: input limit]');
	});

	it('charges each later copy of a key for its length', () => {
		// One object with a long key, reached by 10^6 paths. The key was tested
		// and redacted once and then copied free, so the projection held 87,046
		// copies of it, 21 times the code units the walk charged.
		const key = 'k'.repeat(1_000);
		let value: unknown = { [key]: 1 };
		for (let level = 0; level < 3; level += 1) {
			const child = value;
			value = Array.from({ length: 100 }, () => child);
		}
		const projection = sanitizeDiagnosticValueWithMetadata(value);
		const copies = JSON.stringify(projection.value).split(key).length - 1;
		expect(copies).toBeGreaterThan(0);
		expect(copies).toBeLessThanOrEqual((4 * 1024 * 1024) / key.length);
		expect(projection.truncated).toBe(true);
	});

	it('skips a marker that a cut left open when it tests a key', () => {
		// The cut ends inside the marker of the address. A field named `email`
		// is sensitive, but a key cut there is not, so a second pass keeps it.
		const once = sanitizeDiagnosticValue({
			[`${'k'.repeat(1_005)} alice@example.com zzz`]: 'visible',
		});
		expect(once).toEqual({
			[`${'k'.repeat(1_005)} [REDACTED EMAIL…`]: 'visible',
		});
		expect(sanitizeDiagnosticValue(once)).toEqual(once);
	});
});

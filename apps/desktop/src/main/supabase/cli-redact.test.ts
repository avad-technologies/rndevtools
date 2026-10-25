import { describe, expect, it } from 'vitest';
import { realisticSecrets } from './cli-fixtures.test-support';
import { sanitizeSupabaseText } from './cli-redact';

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

	it('leaves stack ids, ports and ordinary text alone', () => {
		const id =
			'b2e7a5393a8054d7b4658b68c7c7bb12092465347f6e3fbb7afb6864534dd9e8';
		const message = `Public port 54321 for api is in use by the stack of project /Users/example/ExampleApp (stack ${id})`;
		expect(line(message)).toBe(message);
		expect(line('GET /rest/v1/notes?select=id&limit=1 HTTP/1.1 200')).toBe(
			'GET /rest/v1/notes?select=id&limit=1 HTTP/1.1 200'
		);
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

import { utf8ByteLength } from '@rndevtools/core/serialize';
import {
	desktopProjectionId,
	limitDesktopProjection,
	projectDesktopHeaders,
	projectDesktopQueryKey,
} from './projection';

describe('desktop diagnostic projections', () => {
	it('creates stable bounded identifiers without retaining source text', () => {
		const source = 'query'.repeat(100_000);
		const first = desktopProjectionId('query', source);
		expect(first).toBe(desktopProjectionId('query', source));
		expect(first).not.toContain(source.slice(0, 20));
		expect(first.length).toBeLessThanOrEqual(256);
		expect(desktopProjectionId('query', '😀')).not.toBe(
			desktopProjectionId('query', '😁'),
		);
	});

	it('retains the newest serializable items within count and byte budgets', () => {
		const limited = limitDesktopProjection(
			[
				{ id: 'old', value: 'x'.repeat(100) },
				{ id: 'middle', value: 'ok' },
				{ id: 'new', value: 'ok' },
			],
			{ maxItems: 2, maxBytes: 100, keepNewest: true },
		);

		expect(limited.items).toEqual([
			{ id: 'middle', value: 'ok' },
			{ id: 'new', value: 'ok' },
		]);
		expect(limited.omitted).toBe(1);
	});

	it('bounds header names, values, and field count', () => {
		const headers: Record<string, string> = {
			['n'.repeat(257)]: 'ignored',
			['名'.repeat(100)]: 'ignored',
			authorization: 'Bearer opaque-secret',
			'x-context': '{"password":"private-value"}',
			'x-too-long': 'x'.repeat(600_000),
			'x-multibyte': '🏋️'.repeat(100_000),
			...Object.fromEntries(
				Array.from({ length: 205 }, (_, index) => [`x-${index}`, 'value']),
			),
		};
		const projected = projectDesktopHeaders(headers) ?? {};

		expect(Object.keys(projected).length).toBeLessThanOrEqual(200);
		expect(utf8ByteLength(projected['x-too-long'] ?? '')).toBeLessThanOrEqual(
			512 * 1024,
		);
		expect(utf8ByteLength(projected['x-multibyte'] ?? '')).toBeLessThanOrEqual(
			512 * 1024,
		);
		expect(projected['x-multibyte']).not.toContain('\uFFFD');
		expect(projected['n'.repeat(257)]).toBeUndefined();
		expect(projected['名'.repeat(100)]).toBeUndefined();
		expect(projected.authorization).toBe('[REDACTED]');
		expect(projected['x-context']).toContain('[REDACTED]');
		expect(JSON.stringify(projected)).not.toContain('private-value');
		for (const value of Object.values(projected)) {
			expect(utf8ByteLength(value)).toBeLessThanOrEqual(512 * 1024);
		}
	});

	it('omits sensitive query-key parameters from desktop metadata', () => {
		const projected = projectDesktopQueryKey(
			[
				'ai-coach',
				'conversation-history',
				'5d1a7b6e-55f1-4f97-9a64-59a5b947c9af',
				'private coaching prompt',
			],
			'query',
		);

		expect(projected).toBe('ai-coach · 3 parameters omitted');
		expect(projected).not.toContain('5d1a7b6e');
		expect(projected).not.toContain('private coaching prompt');
		expect(projectDesktopQueryKey(['unsafe family name'], 'mutation')).toBe(
			'anonymous mutation',
		);
	});
});

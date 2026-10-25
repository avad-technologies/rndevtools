import { utf8ByteLength } from '../core/serialize';
import { createEnvironmentPlugin, formatEnvironmentValue } from './environment';
import { validateEnvironmentValues } from './environment-model';

describe('validateEnvironmentValues', () => {
	it('formats declared values without JSON noise', () => {
		expect(formatEnvironmentValue('development')).toBe('development');
		expect(formatEnvironmentValue(true)).toBe('true');
		expect(formatEnvironmentValue(undefined)).toBe('Not set');
	});

	it('redacts and bounds rendered string values', () => {
		const formatted = formatEnvironmentValue(
			`email=person@example.com ${'x'.repeat(20 * 1024)}`,
		);

		expect(formatted).toContain('[REDACTED]');
		expect(formatted.endsWith('…')).toBe(true);
		expect(utf8ByteLength(formatted)).toBeLessThanOrEqual(16 * 1024);
	});

	it('reports valid, missing, type, and value checks', () => {
		const sections = [
			{
				title: 'App',
				values: { NAME: 'ExampleApp', COUNT: '2', PLATFORM: 'android' },
			},
		];
		const results = validateEnvironmentValues(sections, [
			{ key: 'NAME', section: 'App', expectedType: 'string' },
			{ key: 'MISSING', section: 'App', required: true },
			{ key: 'COUNT', section: 'App', expectedType: 'number' },
			{ key: 'PLATFORM', section: 'App', expectedValue: 'ios' },
			{ key: 'OPTIONAL', section: 'App', required: false },
		]);

		expect(results.map((result) => result.status)).toEqual([
			'valid',
			'missing',
			'typeMismatch',
			'valueMismatch',
			'valid',
		]);
	});

	it('rejects duplicate section names and compares object values structurally', () => {
		expect(() =>
			createEnvironmentPlugin({
				sections: [
					{ title: 'Build', values: {} },
					{ title: 'Build', values: {} },
				],
			}),
		).toThrow('Duplicate environment section title');
		const [result] = validateEnvironmentValues(
			[{ title: 'Build', values: { config: { a: 1, b: 2 } } }],
			[{ key: 'config', expectedValue: { b: 2, a: 1 } }],
		);
		expect(result?.status).toBe('valid');
	});

	it('rejects duplicate, unknown-section, and ambiguous rules', () => {
		const sections = [
			{ title: 'Build', values: { PLATFORM: 'ios' } },
			{ title: 'Runtime', values: { PLATFORM: 'ios' } },
		];
		expect(() =>
			createEnvironmentPlugin({
				sections,
				rules: [{ key: 'PLATFORM' }],
			}),
		).toThrow('ambiguous');
		expect(() =>
			createEnvironmentPlugin({
				sections,
				rules: [{ key: 'PLATFORM', section: 'Missing' }],
			}),
		).toThrow('Unknown environment rule section');
		expect(() =>
			createEnvironmentPlugin({
				sections,
				rules: [
					{ key: 'PLATFORM', section: 'Build' },
					{ key: 'PLATFORM', section: 'Build' },
				],
			}),
		).toThrow('Duplicate environment rule');
		expect(() =>
			createEnvironmentPlugin({
				sections: [{ title: 'Build', values: { PLATFORM: 'ios' } }],
				rules: [{ key: 'PLATFORM' }, { key: 'PLATFORM', section: 'Build' }],
			}),
		).toThrow('Overlapping environment rules');
	});

	it('rejects rule descriptions too large for native text rendering', () => {
		expect(() =>
			createEnvironmentPlugin({
				values: { MODE: 'development' },
				rules: [{ key: 'MODE', description: 'x'.repeat(4 * 1024 + 1) }],
			}),
		).toThrow('cannot exceed 4096 characters');
	});

	it('does not invoke accessors and rejects non-JSON object comparisons', () => {
		const getter = jest.fn(() => 'ios');
		const actual = Object.defineProperty({}, 'platform', {
			enumerable: true,
			get: getter,
		});
		const results = validateEnvironmentValues(
			[
				{
					title: 'Runtime',
					values: { accessor: actual, map: new Map([['a', 1]]) },
				},
			],
			[
				{ key: 'accessor', expectedValue: { platform: 'ios' } },
				{ key: 'map', expectedValue: new Map([['a', 1]]) },
			],
		);

		expect(results.map((result) => result.status)).toEqual([
			'valueMismatch',
			'valueMismatch',
		]);
		expect(getter).not.toHaveBeenCalled();
	});

	it('does not invoke top-level value or array accessors', () => {
		const topLevelGetter = jest.fn(() => 'private');
		const arrayGetter = jest.fn(() => 'private');
		const values = Object.defineProperty({}, 'TOKEN', {
			enumerable: true,
			get: topLevelGetter,
		});
		const actual: unknown[] = [];
		Object.defineProperty(actual, '0', {
			enumerable: true,
			get: arrayGetter,
		});
		actual.length = 1;

		const [topLevel, array] = validateEnvironmentValues(
			[
				{ title: 'Runtime', values },
				{ title: 'Arrays', values: { actual } },
			],
			[
				{ key: 'TOKEN', section: 'Runtime', expectedValue: 'private' },
				{ key: 'actual', section: 'Arrays', expectedValue: ['private'] },
			],
		);

		expect(topLevel?.status).toBe('valueMismatch');
		expect(array?.status).toBe('valueMismatch');
		expect(topLevelGetter).not.toHaveBeenCalled();
		expect(arrayGetter).not.toHaveBeenCalled();
	});

	it('bounds section size and structural comparison work', () => {
		const oversized = Object.fromEntries(
			Array.from({ length: 5_001 }, (_, index) => [`KEY_${index}`, index]),
		);
		expect(() =>
			createEnvironmentPlugin({
				sections: [{ title: 'Oversized', values: oversized }],
			}),
		).toThrow('at most 5000 values');

		const nested = (depth: number): unknown => {
			let value: unknown = 'leaf';
			for (let index = 0; index < depth; index += 1) value = { value };
			return value;
		};
		expect(() =>
			validateEnvironmentValues(
				[{ title: 'Runtime', values: { deep: nested(40) } }],
				[{ key: 'deep', expectedValue: nested(40) }],
			),
		).not.toThrow();
		expect(
			validateEnvironmentValues(
				[{ title: 'Runtime', values: { deep: nested(40) } }],
				[{ key: 'deep', expectedValue: nested(40) }],
			)[0]?.status,
		).toBe('valueMismatch');
	});

	it('compares dates without invoking instance-owned methods', () => {
		const actual = new Date('2026-08-23T00:00:00.000Z');
		const expected = new Date('2026-08-23T00:00:00.000Z');
		const actualGetTime = jest.fn(() => 0);
		const expectedGetTime = jest.fn(() => 1);
		Object.defineProperty(actual, 'getTime', { get: actualGetTime });
		Object.defineProperty(expected, 'getTime', { get: expectedGetTime });

		const [result] = validateEnvironmentValues(
			[{ title: 'Runtime', values: { releasedAt: actual } }],
			[{ key: 'releasedAt', expectedValue: expected }],
		);

		expect(result?.status).toBe('valid');
		expect(actualGetTime).not.toHaveBeenCalled();
		expect(expectedGetTime).not.toHaveBeenCalled();
	});
});

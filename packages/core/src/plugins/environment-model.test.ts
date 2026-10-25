import {
	assertEnvironmentRules,
	createEnvironmentBooleanRule,
	createEnvironmentEnumRule,
	createEnvironmentNumberRule,
	createEnvironmentUrlRule,
	createEnvironmentVersionRule,
	evaluateEnvironmentHealth,
	searchEnvironmentHealthIssues,
	validateEnvironmentValues,
} from './environment-model';

describe('typed environment health', () => {
	const section = {
		title: 'Runtime',
		values: {
			BOOL: 'true',
			COUNT: '4',
			URL: 'https://example.app/path',
			MODE: 'preview',
			VERSION: 'v1.2.3',
		},
	};

	it('validates boolean, number, URL, enum, and version rules', () => {
		const results = validateEnvironmentValues(
			[section],
			[
				createEnvironmentBooleanRule({ key: 'BOOL', expected: true }),
				createEnvironmentNumberRule({
					key: 'COUNT',
					integer: true,
					minimum: 1,
					maximum: 5,
				}),
				createEnvironmentUrlRule({ key: 'URL', protocols: ['https'] }),
				createEnvironmentEnumRule({
					key: 'MODE',
					values: ['preview', 'production'],
				}),
				createEnvironmentVersionRule({
					key: 'VERSION',
					minimum: '1.2',
					maximum: '2',
				}),
			],
		);

		expect(results.map(({ status }) => status)).toEqual(Array(5).fill('valid'));
		expect(results.map(({ normalizedValue }) => normalizedValue)).toEqual([
			true,
			4,
			'https://example.app/path',
			'preview',
			'v1.2.3',
		]);
	});

	it('reports typed failures through the stable status contract', () => {
		const results = validateEnvironmentValues(
			[
				{
					title: 'Runtime',
					values: {
						BOOL: 'TRUE',
						COUNT: '1.5',
						URL: 'ftp://example.app',
						MODE: 'beta',
						VERSION: 'latest',
					},
				},
			],
			[
				createEnvironmentBooleanRule({ key: 'BOOL' }),
				createEnvironmentNumberRule({ key: 'COUNT', integer: true }),
				createEnvironmentUrlRule({ key: 'URL' }),
				createEnvironmentEnumRule({ key: 'MODE', values: ['preview'] }),
				createEnvironmentVersionRule({ key: 'VERSION' }),
			],
		);

		expect(results.map(({ status }) => status)).toEqual([
			'typeMismatch',
			'valueMismatch',
			'valueMismatch',
			'valueMismatch',
			'valueMismatch',
		]);
		expect(results.map(({ issueCode }) => issueCode)).toEqual([
			'boolean',
			'number',
			'url',
			'enum',
			'version',
		]);
	});

	it('produces deterministic weighted scores, groups, and searches', () => {
		const rules = [
			createEnvironmentBooleanRule({ key: 'BOOL', section: 'Runtime' }),
			createEnvironmentUrlRule({
				key: 'URL',
				section: 'Network',
				severity: 'warning',
			}),
			createEnvironmentEnumRule({
				key: 'MODE',
				section: 'Runtime',
				values: ['production'],
			}),
		];
		const sections = [
			{ title: 'Network', values: { URL: 'bad' } },
			{ title: 'Runtime', values: { BOOL: 'true', MODE: 'preview' } },
		];
		const health = evaluateEnvironmentHealth(sections, rules);

		expect(health.score).toBe(40);
		expect(health.groups.map(({ section }) => section)).toEqual([
			'Network',
			'Runtime',
		]);
		expect(
			searchEnvironmentHealthIssues(health, 'mode')[0]?.issues[0]?.key,
		).toBe('MODE');
		expect(
			evaluateEnvironmentHealth([...sections].reverse(), [...rules].reverse())
				.score,
		).toBe(40);
	});

	it('rejects invalid typed rule definitions', () => {
		expect(() =>
			assertEnvironmentRules(
				[section],
				[createEnvironmentNumberRule({ key: 'COUNT', minimum: 5, maximum: 1 })],
			),
		).toThrow('Invalid numeric environment rule');
		expect(() =>
			assertEnvironmentRules(
				[section],
				[createEnvironmentEnumRule({ key: 'MODE', values: [] })],
			),
		).toThrow('Invalid enum environment rule');
	});
});

import {
	parseScenarioDocumentJson,
	SCENARIO_DOCUMENT_NAMESPACE,
	SCENARIO_SCHEMA_VERSION,
	type ScenarioDefinition,
} from './scenario-model';

function definition(
	overrides: Partial<ScenarioDefinition> = {},
): ScenarioDefinition {
	return {
		schemaVersion: SCENARIO_SCHEMA_VERSION,
		id: 'user.offline',
		version: 1,
		name: 'Offline user flow',
		variables: [],
		preconditions: [],
		steps: [
			{
				id: 'network',
				type: 'network-profile',
				input: { profileId: 'offline' },
			},
		],
		...overrides,
	};
}

function document(scenarios: readonly ScenarioDefinition[]): string {
	return JSON.stringify({
		schemaVersion: SCENARIO_SCHEMA_VERSION,
		namespace: SCENARIO_DOCUMENT_NAMESPACE,
		scenarios,
	});
}

describe('scenario model document parser', () => {
	it('parses a strict bounded document into validated definitions', () => {
		expect(parseScenarioDocumentJson(document([definition()]))).toEqual({
			schemaVersion: SCENARIO_SCHEMA_VERSION,
			namespace: SCENARIO_DOCUMENT_NAMESPACE,
			scenarios: [definition()],
		});
	});

	it('rejects malformed, partial, and extended envelopes', () => {
		expect(() => parseScenarioDocumentJson('{')).toThrow('malformed');
		expect(() => parseScenarioDocumentJson('{}')).toThrow('unsupported schema');
		expect(() =>
			parseScenarioDocumentJson(
				JSON.stringify({
					schemaVersion: 1,
					namespace: SCENARIO_DOCUMENT_NAMESPACE,
					scenarios: [],
					extra: true,
				}),
			),
		).toThrow('unsupported schema');
	});

	it('rejects duplicate ids and invalid definitions atomically', () => {
		expect(() =>
			parseScenarioDocumentJson(
				document([definition(), definition({ name: 'Duplicate' })]),
			),
		).toThrow('Duplicate scenario id');
		expect(() =>
			parseScenarioDocumentJson(
				document([
					definition({
						steps: [
							{
								id: 'unsupported',
								type: 'shell' as never,
								input: {},
							},
						],
					}),
				]),
			),
		).toThrow('unknown type');
	});

	it('enforces configured document and scenario-count bounds', () => {
		expect(() =>
			parseScenarioDocumentJson(
				document([
					definition(),
					definition({ id: 'user.second', name: 'Second' }),
				]),
				{ maxScenarios: 1 },
			),
		).toThrow('scenario-count limit');
		expect(() =>
			parseScenarioDocumentJson(document([definition()]), {
				maxDocumentBytes: 32,
			}),
		).toThrow('oversized');
	});
});

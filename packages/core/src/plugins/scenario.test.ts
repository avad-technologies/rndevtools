import type { RestorePointStorage } from './restore-points';
import {
	parseScenarioJson,
	SCENARIO_SCHEMA_VERSION,
	type ScenarioDefinition,
} from './scenario';
import { ScenarioRepository } from './scenario-repository';

function definition(
	overrides: Partial<ScenarioDefinition> = {},
): ScenarioDefinition {
	return {
		schemaVersion: SCENARIO_SCHEMA_VERSION,
		id: 'offline-home',
		version: 1,
		name: 'Offline home',
		variables: [
			{
				id: 'profile',
				label: 'Network profile',
				type: 'string',
				required: true,
				defaultValue: 'offline',
				options: ['offline', 'edge'],
			},
		],
		preconditions: [],
		steps: [
			{
				id: 'network',
				type: 'network-profile',
				input: {
					profileId: { kind: 'variable', variableId: 'profile' },
				},
			},
		],
		...overrides,
	};
}

function memoryStorage(): RestorePointStorage & {
	values: Map<string, string>;
} {
	const values = new Map<string, string>();
	return {
		values,
		getItem: (key) => values.get(key),
		setItem: (key, value) => {
			values.set(key, value);
		},
	};
}

describe('scenario schema and repository', () => {
	it('parses a versioned definition and rejects unknown or oversized steps', () => {
		expect(parseScenarioJson(JSON.stringify(definition()))).toMatchObject({
			id: 'offline-home',
			steps: [{ type: 'network-profile' }],
		});
		expect(() =>
			parseScenarioJson(
				JSON.stringify(
					definition({
						steps: [
							{
								id: 'unknown',
								type: 'shell' as never,
								input: {},
							},
						],
					}),
				),
			),
		).toThrow('unknown type');
		expect(() =>
			parseScenarioJson(
				JSON.stringify(
					definition({
						steps: [
							{
								id: 'large',
								type: 'custom-action',
								input: { payload: 'x'.repeat(70 * 1024) },
							},
						],
					}),
				),
			),
		).toThrow(/byte limit|oversized/);
		expect(
			parseScenarioJson(
				JSON.stringify(
					definition({
						steps: [
							{
								id: 'identity',
								type: 'impersonation',
								input: { personaId: 'power' },
							},
						],
					}),
				),
			).steps[0]?.type,
		).toBe('impersonation');
	});

	it('rejects unknown variables and dangerous object keys', () => {
		expect(() =>
			parseScenarioJson(
				JSON.stringify(
					definition({
						steps: [
							{
								id: 'network',
								type: 'network-profile',
								input: {
									profileId: {
										kind: 'variable',
										variableId: 'missing',
									},
								},
							},
						],
					}),
				),
			),
		).toThrow('unknown variable');
		const json = JSON.stringify(definition()).replace(
			'"profileId":',
			'"__proto__":{"polluted":true},"profileId":',
		);
		expect(() => parseScenarioJson(json)).toThrow('not allowed');
		expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
	});

	it('persists user scenarios separately from immutable bundled definitions', async () => {
		const storage = memoryStorage();
		const bundled = definition();
		const repository = new ScenarioRepository({ bundled: [bundled], storage });
		const user = definition({ id: 'user-scenario', name: 'User scenario' });

		await repository.save(user);
		const bundledTarget = repository.getTarget(bundled.id);
		if (!bundledTarget)
			throw new Error('Bundled scenario target was not created.');
		await expect(repository.remove(bundledTarget)).rejects.toThrow('immutable');
		const hydrated = new ScenarioRepository({ bundled: [bundled], storage });
		await hydrated.ready;

		expect(hydrated.getSnapshot().bundled.map((item) => item.id)).toEqual([
			'offline-home',
		]);
		expect(hydrated.getSnapshot().user.map((item) => item.id)).toEqual([
			'user-scenario',
		]);
		expect(hydrated.getSnapshot().all).toHaveLength(2);
	});

	it('rejects an invalid import atomically', async () => {
		const repository = new ScenarioRepository();
		await repository.save(definition({ id: 'existing', name: 'Existing' }));
		const document = JSON.parse(repository.exportJson()) as {
			scenarios: unknown[];
		};
		document.scenarios.push({ ...definition(), steps: [{ type: 'shell' }] });

		await expect(
			repository.importJson(JSON.stringify(document)),
		).rejects.toThrow();
		expect(repository.getSnapshot().user.map((item) => item.id)).toEqual([
			'existing',
		]);
	});

	it('rejects stale execute and remove targets after a same-id replacement', async () => {
		const repository = new ScenarioRepository();
		await repository.save(
			definition({ id: 'replaceable', version: 1, name: 'First' }),
		);
		const stale = repository.getTarget('replaceable');
		if (!stale) throw new Error('Initial scenario target was not created.');

		await repository.save(
			definition({ id: 'replaceable', version: 2, name: 'Second' }),
		);
		expect(() => repository.resolveTarget(stale)).toThrow(
			'changed after confirmation',
		);
		await expect(repository.remove(stale)).rejects.toThrow(
			'changed after confirmation',
		);
		expect(repository.getSnapshot().user).toEqual([
			expect.objectContaining({
				id: 'replaceable',
				version: 2,
				name: 'Second',
			}),
		]);

		const current = repository.getTarget('replaceable');
		if (!current)
			throw new Error('Replacement scenario target was not created.');
		await repository.remove(current);
		expect(repository.getSnapshot().user).toEqual([]);
	});

	it('freezes repository definitions and collection snapshots used by targets', async () => {
		const repository = new ScenarioRepository();
		await repository.save(definition({ id: 'frozen', name: 'Frozen' }));
		const target = repository.getTarget('frozen');
		if (!target) throw new Error('Frozen scenario target was not created.');
		const snapshot = repository.getSnapshot();
		const storedDefinition = snapshot.user[0];
		if (!storedDefinition) throw new Error('Frozen scenario was not stored.');
		const replacement = definition({ id: 'frozen', name: 'Injected' });

		(snapshot.all as ScenarioDefinition[])[0] = replacement;
		expect(snapshot.all[0]?.name).toBe('Frozen');
		expect(() => {
			(snapshot.user as ScenarioDefinition[]).splice(0, 1, replacement);
		}).toThrow();
		expect(() => {
			(
				storedDefinition.steps as Array<ScenarioDefinition['steps'][number]>
			).push({ id: 'injected', type: 'navigation', input: {} });
		}).toThrow();
		expect(repository.resolveTarget(target).name).toBe('Frozen');
		expect(repository.resolveTarget(target).steps).toHaveLength(1);
	});

	it('serializes concurrent saves and preserves storage failures atomically', async () => {
		let fail = false;
		const values = new Map<string, string>();
		const repository = new ScenarioRepository({
			storage: {
				getItem: (key) => values.get(key),
				setItem: (key, value) => {
					if (fail) throw new Error('disk full');
					values.set(key, value);
				},
			},
		});
		await Promise.all([
			repository.save(definition({ id: 'one', name: 'One' })),
			repository.save(definition({ id: 'two', name: 'Two' })),
		]);
		fail = true;
		await expect(
			repository.save(definition({ id: 'three', name: 'Three' })),
		).rejects.toThrow('disk full');

		expect(repository.getSnapshot().user.map((item) => item.id)).toEqual([
			'one',
			'two',
		]);
	});
});

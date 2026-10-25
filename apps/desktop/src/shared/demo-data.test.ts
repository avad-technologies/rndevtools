import { RNDEVTOOLS_SNAPSHOT_LIMITS } from '@rndevtools/core/desktop-protocol';
import {
	SCENARIO_DOCUMENT_NAMESPACE,
	SCENARIO_SCHEMA_VERSION,
	type ScenarioDefinition,
} from '@rndevtools/core/scenario-model';
import { describe, expect, it } from 'vitest';
import { applyDemoAction, createDemoDevice, tickDemoDevice } from './demo-data';
import {
	type DesktopAction,
	deviceSessionSchema,
	type ToolId,
} from './protocol';

// Demo fixtures date some rows a day before `now`, and the snapshot schema
// rejects negative timestamps, so test clocks start well after the epoch.
const BASE_TIME = 1_800_000_000_000;

function action(
	tool: ToolId,
	command: string,
	payload: Record<string, unknown> = {}
): DesktopAction {
	return {
		actionId: `test-${tool}-${command}`,
		deviceId: 'rndevtools-demo-ios',
		tool,
		command,
		payload,
	};
}

function scenarioDefinition(
	overrides: Partial<ScenarioDefinition> = {}
): ScenarioDefinition {
	return {
		schemaVersion: SCENARIO_SCHEMA_VERSION,
		id: 'user.offline',
		version: 1,
		name: 'Offline flow',
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

function seeded<T extends { id: string }>(
	template: T | undefined,
	count: number
): T[] {
	if (!template) throw new Error('Seed row is missing.');
	return Array.from({ length: count }, (_, index) => ({
		...template,
		id: `seed-${index}`,
	}));
}

function scenarioDocument(scenarios: readonly ScenarioDefinition[]): string {
	return JSON.stringify({
		schemaVersion: SCENARIO_SCHEMA_VERSION,
		namespace: SCENARIO_DOCUMENT_NAMESPACE,
		scenarios,
	});
}

describe('demo device actions', () => {
	it('applies safe remote mutations without mutating the previous snapshot', () => {
		const original = createDemoDevice(BASE_TIME + 1_000_000);
		const storageEntry = original.tools.storage.find((entry) => entry.editable);
		expect(storageEntry).toBeDefined();

		const updated = applyDemoAction(
			original,
			action('storage', 'set', {
				id: storageEntry?.id,
				valueText: 'updated-from-desktop',
			}),
			BASE_TIME + 1_001_000
		);

		expect(
			original.tools.storage.find((entry) => entry.id === storageEntry?.id)
				?.valueText
		).not.toBe('updated-from-desktop');
		expect(
			updated.tools.storage.find((entry) => entry.id === storageEntry?.id)
				?.valueText
		).toBe('updated-from-desktop');
		expect(updated.tools.storageEvents[0]?.kind).toBe('updated');
	});

	it('rejects writes to protected storage', () => {
		const device = createDemoDevice();
		const protectedEntry = device.tools.storage.find(
			(entry) => entry.sensitive
		);
		expect(() =>
			applyDemoAction(
				device,
				action('storage', 'set', {
					id: protectedEntry?.id,
					valueText: 'leak',
				})
			)
		).toThrow('cannot be edited');
	});

	it('bookmarks and undoes storage history by stable event id', () => {
		const original = createDemoDevice(BASE_TIME + 1_100_000);
		const entry = original.tools.storage.find(
			(candidate) => candidate.editable
		);
		expect(entry).toBeDefined();
		const updated = applyDemoAction(
			original,
			action('storage', 'set', {
				id: entry?.id,
				valueText: 'temporary-value',
			}),
			BASE_TIME + 1_101_000
		);
		const event = updated.tools.storageEvents[0];
		expect(event?.undoAvailable).toBe(true);

		const bookmarked = applyDemoAction(
			updated,
			action('storage', 'bookmark', { id: event?.id }),
			BASE_TIME + 1_102_000
		);
		expect(bookmarked.tools.storageEvents[0]?.bookmarked).toBe(true);

		const undone = applyDemoAction(
			bookmarked,
			action('storage', 'undo', { id: event?.id }),
			BASE_TIME + 1_103_000
		);
		expect(
			undone.tools.storage.find((candidate) => candidate.id === entry?.id)
				?.valueText
		).toBe(event?.previousText);
		expect(undone.tools.storageEvents[0]).toMatchObject({
			bookmarked: true,
			undoAvailable: false,
			undoStatus: 'succeeded',
		});
	});

	it('captures, restores, and removes only explicit restore points', () => {
		const device = createDemoDevice(BASE_TIME + 2_000_000);
		const captured = applyDemoAction(
			device,
			action('restore', 'capture', { label: 'Before scenario' }),
			BASE_TIME + 2_001_000
		);
		const point = captured.tools.restorePoints[0];
		expect(point?.label).toBe('Before scenario');
		expect(point?.sources).toHaveLength(1);

		const renamed = applyDemoAction(
			captured,
			action('restore', 'rename', {
				id: point?.id,
				label: 'Renamed scenario',
			}),
			BASE_TIME + 2_002_000
		);
		expect(renamed.tools.restorePoints[0]?.label).toBe('Renamed scenario');
		const duplicated = applyDemoAction(
			renamed,
			action('restore', 'duplicate', {
				id: point?.id,
				label: 'Scenario copy',
			}),
			BASE_TIME + 2_003_000
		);
		expect(duplicated.tools.restorePoints[0]?.label).toBe('Scenario copy');

		const restored = applyDemoAction(
			duplicated,
			action('restore', 'restore', {
				id: point?.id,
				sourceIds: ['developer-overrides'],
			}),
			BASE_TIME + 2_004_000
		);
		expect(restored.tools.diagnostics[0]?.scope).toBe('restore');
		expect(restored.tools.restoreReceipts[0]).toMatchObject({
			pointId: point?.id,
			status: 'complete',
		});
		const baseline = applyDemoAction(
			restored,
			action('restore', 'resetBaseline', {}),
			BASE_TIME + 2_004_500
		);
		expect(baseline.tools.restoreReceipts[0]).toMatchObject({
			pointId: 'baseline',
			status: 'complete',
		});

		const removed = applyDemoAction(
			baseline,
			action('restore', 'remove', { id: point?.id }),
			BASE_TIME + 2_005_000
		);
		expect(
			removed.tools.restorePoints.some(
				(candidate) => candidate.id === point?.id
			)
		).toBe(false);
	});

	it('captures, patches, and restores an opted-in Zustand projection', () => {
		const device = createDemoDevice(BASE_TIME + 2_100_000);
		const store = device.tools.zustandStores.find(
			(candidate) => candidate.capabilities.restorable
		);
		expect(store).toBeDefined();
		const captured = applyDemoAction(
			device,
			action('zustand', 'capture', { storeId: store?.id }),
			BASE_TIME + 2_101_000
		);
		const snapshot = captured.tools.zustandStateSnapshots[0];
		expect(snapshot?.storeId).toBe(store?.id);

		const patched = applyDemoAction(
			captured,
			action('zustand', 'patch', {
				storeId: store?.id,
				patchText: '{"showDebugBadges":false}',
			}),
			BASE_TIME + 2_102_000
		);
		expect(
			JSON.parse(
				patched.tools.zustandStores.find(
					(candidate) => candidate.id === store?.id
				)?.stateText ?? '{}'
			).showDebugBadges
		).toBe(false);
		expect(patched.tools.zustandMutationReceipts.at(-1)).toMatchObject({
			kind: 'patch',
			status: 'succeeded',
		});

		const restored = applyDemoAction(
			patched,
			action('zustand', 'jump', {
				storeId: store?.id,
				snapshotId: snapshot?.id,
			}),
			BASE_TIME + 2_103_000
		);
		expect(
			restored.tools.zustandStores.find(
				(candidate) => candidate.id === store?.id
			)?.stateText
		).toBe(store?.stateText);
		expect(restored.tools.zustandMutationReceipts.at(-1)?.kind).toBe('jump');
	});

	it('runs and undoes one transactional scenario at a time', () => {
		const device = createDemoDevice(BASE_TIME + 2_500_000);
		const scenario = device.tools.scenarios[0];
		expect(scenario).toBeDefined();
		const active = applyDemoAction(
			device,
			action('scenarios', 'execute', {
				id: scenario?.id,
				version: scenario?.version,
				definitionToken: scenario?.definitionToken,
				variables: {},
			}),
			BASE_TIME + 2_501_000
		);
		expect(active.tools.scenarioRuntime.active).toMatchObject({
			scenarioId: scenario?.id,
		});
		expect(active.tools.scenarioReceipts[0]?.status).toBe('complete');
		expect(() =>
			applyDemoAction(
				active,
				action('scenarios', 'execute', {
					id: scenario?.id,
					version: scenario?.version,
					definitionToken: scenario?.definitionToken,
				}),
				BASE_TIME + 2_502_000
			)
		).toThrow('Undo the active scenario');

		const undone = applyDemoAction(
			active,
			action('scenarios', 'undo', {
				receiptId: active.tools.scenarioRuntime.active?.receiptId,
			}),
			BASE_TIME + 2_503_000
		);
		expect(undone.tools.scenarioRuntime.active).toBeUndefined();
	});

	it('strictly imports valid user scenarios with atomic replace and merge', () => {
		const original = createDemoDevice(BASE_TIME + 2_550_000);
		const replaced = applyDemoAction(
			original,
			action('scenarios', 'import', {
				json: scenarioDocument([scenarioDefinition()]),
				mode: 'replace',
			}),
			BASE_TIME + 2_551_000
		);
		expect(original.tools.scenarios.every((scenario) => scenario.bundled)).toBe(
			true
		);
		expect(
			replaced.tools.scenarios.filter((scenario) => !scenario.bundled)
		).toEqual([
			expect.objectContaining({
				id: 'user.offline',
				name: 'Offline flow',
				preconditionCount: 0,
				steps: [
					expect.objectContaining({
						id: 'network',
						type: 'network-profile',
					}),
				],
			}),
		]);

		const merged = applyDemoAction(
			replaced,
			action('scenarios', 'import', {
				json: scenarioDocument([
					scenarioDefinition({
						id: 'user.navigation',
						name: 'Navigation flow',
						steps: [
							{
								id: 'navigate',
								type: 'navigation',
								label: 'Open home',
								input: { path: '/home' },
							},
						],
					}),
				]),
				mode: 'merge',
			}),
			BASE_TIME + 2_552_000
		);
		expect(
			merged.tools.scenarios
				.filter((scenario) => !scenario.bundled)
				.map((scenario) => scenario.id)
		).toEqual(['user.offline', 'user.navigation']);
		expect(merged.tools.diagnostics[0]?.message).toContain('merge mode');

		const replacedAgain = applyDemoAction(
			merged,
			action('scenarios', 'import', {
				json: scenarioDocument([
					scenarioDefinition({ id: 'user.replacement', name: 'Replacement' }),
				]),
				mode: 'replace',
			}),
			BASE_TIME + 2_553_000
		);
		expect(
			replacedAgain.tools.scenarios
				.filter((scenario) => !scenario.bundled)
				.map((scenario) => scenario.id)
		).toEqual(['user.replacement']);
	});

	it('rejects invalid scenario imports without mutating the demo list', () => {
		const original = createDemoDevice(BASE_TIME + 2_560_000);
		const originalScenarios = structuredClone(original.tools.scenarios);
		const bundledId = original.tools.scenarios.find(
			(scenario) => scenario.bundled
		)?.id;
		if (!bundledId) throw new Error('Bundled demo scenario is missing.');
		const invalidImports: Array<Record<string, unknown>> = [
			{ json: '{}', mode: 'merge' },
			{
				json: scenarioDocument([
					scenarioDefinition(),
					scenarioDefinition({ name: 'Duplicate id' }),
				]),
				mode: 'merge',
			},
			{
				json: scenarioDocument([
					scenarioDefinition({ id: bundledId, name: 'Bundled collision' }),
				]),
				mode: 'merge',
			},
			{ json: scenarioDocument([scenarioDefinition()]), mode: 'append' },
			{
				json: scenarioDocument(
					Array.from({ length: 26 }, (_, index) =>
						scenarioDefinition({
							id: `user.limit-${index}`,
							name: `Limit ${index}`,
						})
					)
				),
				mode: 'replace',
			},
		];

		for (const payload of invalidImports) {
			expect(() =>
				applyDemoAction(original, action('scenarios', 'import', payload))
			).toThrow();
			expect(original.tools.scenarios).toEqual(originalScenarios);
		}
	});

	it('rejects merge collisions without replacing an existing user scenario', () => {
		const imported = applyDemoAction(
			createDemoDevice(BASE_TIME + 2_570_000),
			action('scenarios', 'import', {
				json: scenarioDocument([scenarioDefinition()]),
				mode: 'merge',
			})
		);
		const beforeCollision = structuredClone(imported.tools.scenarios);

		expect(() =>
			applyDemoAction(
				imported,
				action('scenarios', 'import', {
					json: scenarioDocument([
						scenarioDefinition({ name: 'Would overwrite' }),
					]),
					mode: 'merge',
				})
			)
		).toThrow('already exists');
		expect(imported.tools.scenarios).toEqual(beforeCollision);
	});

	it('starts and stops a reversible seeded identity session', () => {
		const device = createDemoDevice(BASE_TIME + 2_600_000);
		const active = applyDemoAction(
			device,
			action('identity', 'start', { personaId: 'power' }),
			BASE_TIME + 2_601_000
		);
		expect(active.tools.identitySession.active).toMatchObject({
			actor: { kind: 'account', label: 'Original account' },
			target: { kind: 'persona', label: 'Frequent user', personaId: 'power' },
			status: 'active',
		});
		expect(device.tools.identitySession.active).toBeUndefined();

		const restored = applyDemoAction(
			active,
			action('identity', 'stop'),
			BASE_TIME + 2_602_000
		);
		expect(restored.tools.identitySession.active).toBeUndefined();
		expect(restored.tools.identitySession.history[0]).toMatchObject({
			status: 'stopped',
			stoppedAt: BASE_TIME + 2_602_000,
		});
	});

	it('records performance samples only while a review is active', () => {
		const device = createDemoDevice(BASE_TIME + 3_000_000);
		const started = applyDemoAction(
			device,
			action('performance', 'start'),
			BASE_TIME + 3_001_000
		);
		const ticked = tickDemoDevice(started, BASE_TIME + 3_002_000);
		expect(ticked.tools.performance.samples).toHaveLength(1);

		const stopped = applyDemoAction(
			ticked,
			action('performance', 'stop'),
			BASE_TIME + 3_003_000
		);
		const afterStop = tickDemoDevice(stopped, BASE_TIME + 3_004_000);
		expect(afterStop.tools.performance.samples).toHaveLength(1);
		expect(afterStop.tools.performance.summary.sampleCount).toBe(1);
	});

	it('bounds the live demo performance window and reports dropped samples', () => {
		const device = createDemoDevice(BASE_TIME + 3_100_000);
		const sample = device.tools.performance.samples[0];
		expect(sample).toBeDefined();
		if (!sample) throw new Error('Demo performance sample is missing.');
		device.tools.performance.samples = Array.from(
			{ length: 1_500 },
			(_, index) => ({
				...sample,
				id: `sample-${index}`,
			})
		);
		device.tools.performance.droppedSampleCount = 2;

		const ticked = tickDemoDevice(device, BASE_TIME + 3_101_000);
		expect(ticked.tools.performance.samples).toHaveLength(1_500);
		expect(ticked.tools.performance.droppedSampleCount).toBe(3);
	});

	it('highlights only a visible registered component target', () => {
		const device = createDemoDevice(BASE_TIME + 4_000_000);
		const target = device.tools.components[0];
		expect(target).toBeDefined();
		const highlighted = applyDemoAction(
			device,
			action('components', 'highlight', { id: target?.id }),
			BASE_TIME + 4_001_000
		);
		expect(highlighted.tools.diagnostics[0]).toMatchObject({
			scope: 'components',
			level: 'info',
		});
		expect(() =>
			applyDemoAction(
				device,
				action('components', 'highlight', { id: 'missing-target' })
			)
		).toThrow('not currently visible');
	});
});

describe('demo device snapshot limits', () => {
	const limits = RNDEVTOOLS_SNAPSHOT_LIMITS;

	it('stays parseable when an action is repeated past a collection limit', () => {
		let device = createDemoDevice(BASE_TIME + 5_000_000);
		for (let index = 0; index <= limits.restorePoints; index += 1) {
			device = applyDemoAction(
				device,
				action('restore', 'capture', { label: `Checkpoint ${index}` }),
				BASE_TIME + 5_001_000 + index
			);
		}
		expect(device.tools.restorePoints).toHaveLength(limits.restorePoints);
		expect(device.tools.restorePoints[0]?.label).toBe(
			`Checkpoint ${limits.restorePoints}`
		);
		expect(deviceSessionSchema.safeParse(device).success).toBe(true);
	});

	it('keeps the newest rows of the collections actions prepend to', () => {
		const device = createDemoDevice(BASE_TIME + 5_100_000);
		const tools = device.tools;
		tools.storageEvents = seeded(tools.storageEvents[0], limits.storageEvents);
		tools.routeEvents = seeded(tools.routeEvents[0], limits.routeEvents);
		tools.restorePoints = seeded(tools.restorePoints[0], limits.restorePoints);
		tools.restoreReceipts = seeded(
			tools.restoreReceipts[0],
			limits.restoreReceipts
		);
		tools.diagnostics = seeded(tools.diagnostics[0], limits.diagnostics);
		const scenario = tools.scenarios[0];
		const executed = applyDemoAction(
			device,
			action('scenarios', 'execute', {
				id: scenario?.id,
				version: scenario?.version,
				definitionToken: scenario?.definitionToken,
			}),
			BASE_TIME + 5_100_500
		);
		executed.tools.scenarioReceipts = seeded(
			executed.tools.scenarioReceipts[0],
			limits.scenarioReceipts
		);

		let next = applyDemoAction(
			executed,
			action('storage', 'set', { id: 'storage-theme', valueText: 'light' }),
			BASE_TIME + 5_101_000
		);
		next = applyDemoAction(
			next,
			action('routes', 'navigate', { path: '/settings' }),
			BASE_TIME + 5_102_000
		);
		next = applyDemoAction(
			next,
			action('restore', 'capture', { label: 'Newest' }),
			BASE_TIME + 5_103_000
		);
		next = applyDemoAction(
			next,
			action('restore', 'resetBaseline'),
			BASE_TIME + 5_104_000
		);
		next = applyDemoAction(
			next,
			action('zustand', 'refresh'),
			BASE_TIME + 5_105_000
		);
		next = applyDemoAction(
			next,
			action('scenarios', 'undo', {
				receiptId: next.tools.scenarioRuntime.active?.receiptId,
			}),
			BASE_TIME + 5_106_000
		);
		next = applyDemoAction(
			next,
			action('scenarios', 'execute', {
				id: scenario?.id,
				version: scenario?.version,
				definitionToken: scenario?.definitionToken,
			}),
			BASE_TIME + 5_107_000
		);

		expect(next.tools.storageEvents).toHaveLength(limits.storageEvents);
		expect(next.tools.storageEvents[0]?.id).toBe(
			`storage-event-${BASE_TIME + 5_101_000}`
		);
		expect(next.tools.routeEvents).toHaveLength(limits.routeEvents);
		expect(next.tools.routeEvents[0]?.route).toBe('/settings');
		expect(next.tools.restorePoints).toHaveLength(limits.restorePoints);
		expect(next.tools.restorePoints[0]?.label).toBe('Newest');
		expect(next.tools.restoreReceipts).toHaveLength(limits.restoreReceipts);
		expect(next.tools.restoreReceipts[0]?.pointId).toBe('baseline');
		expect(next.tools.diagnostics).toHaveLength(limits.diagnostics);
		expect(next.tools.diagnostics[0]?.scope).toBe('zustand');
		expect(next.tools.scenarioReceipts).toHaveLength(limits.scenarioReceipts);
		expect(next.tools.scenarioReceipts[0]?.id).toBe(
			`scenario-receipt-${BASE_TIME + 5_107_000}`
		);
	});

	it('keeps the newest rows of the Zustand history actions append to', () => {
		const device = createDemoDevice(BASE_TIME + 5_200_000);
		const patch = (patchText: string, actionId: string) => ({
			...action('zustand', 'patch', { storeId: 'dev-menu', patchText }),
			actionId,
		});
		const patched = applyDemoAction(
			device,
			patch('{"showDebugBadges":false}', 'seed-patch'),
			BASE_TIME + 5_200_500
		);
		const tools = patched.tools;
		tools.zustandStateSnapshots = seeded(
			tools.zustandStateSnapshots[0],
			limits.zustandStateSnapshots
		);
		tools.zustandMutationReceipts = seeded(
			tools.zustandMutationReceipts[0],
			limits.zustandMutationReceipts
		);
		tools.zustandChanges = seeded(
			tools.zustandChanges.at(-1),
			limits.zustandChanges
		);

		const next = applyDemoAction(
			patched,
			patch('{"showDebugBadges":true}', 'newest-patch'),
			BASE_TIME + 5_201_000
		);

		expect(next.tools.zustandStateSnapshots).toHaveLength(
			limits.zustandStateSnapshots
		);
		expect(next.tools.zustandStateSnapshots.at(-1)?.id).toBe(
			'zustand-state-after-newest-patch'
		);
		expect(next.tools.zustandMutationReceipts).toHaveLength(
			limits.zustandMutationReceipts
		);
		expect(next.tools.zustandMutationReceipts.at(-1)?.id).toBe(
			'zustand-mutation-newest-patch'
		);
		expect(next.tools.zustandChanges).toHaveLength(limits.zustandChanges);
		expect(next.tools.zustandChanges.at(-1)?.id).toBe(
			'zustand-change-newest-patch'
		);
	});

	it('rejects an action whose result the snapshot schema would refuse', () => {
		const device = createDemoDevice(BASE_TIME + 5_300_000);
		const before = structuredClone(device);
		const patchText = JSON.stringify(
			Object.fromEntries(
				Array.from({ length: limits.storageKeys }, (_, index) => [
					`flag${index}`,
					true,
				])
			)
		);

		expect(() =>
			applyDemoAction(
				device,
				action('zustand', 'patch', { storeId: 'dev-menu', patchText }),
				BASE_TIME + 5_301_000
			)
		).toThrow('cannot hold the result');
		expect(device).toEqual(before);
	});
});

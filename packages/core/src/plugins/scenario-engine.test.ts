import { SCENARIO_SCHEMA_VERSION, type ScenarioDefinition } from './scenario';
import { type ScenarioActionAdapter, ScenarioEngine } from './scenario-engine';

const TEST_RECOVERY_COMPATIBILITY_ID = 'test-scenario-adapters-v1';

function scenario(
	steps: ScenarioDefinition['steps'],
	overrides: Partial<ScenarioDefinition> = {},
): ScenarioDefinition {
	return {
		schemaVersion: SCENARIO_SCHEMA_VERSION,
		id: 'test-scenario',
		version: 1,
		name: 'Test scenario',
		variables: [],
		preconditions: [],
		steps,
		...overrides,
	};
}

function step(id: string, type: ScenarioDefinition['steps'][number]['type']) {
	return { id, type, input: {} } as const;
}

describe('ScenarioEngine', () => {
	it('preflights every step before capturing rollback or applying mutations', async () => {
		const capture = jest.fn();
		const apply = jest.fn();
		const adapters: ScenarioActionAdapter[] = [
			{
				type: 'developer-overrides',
				preflight: () => ({ summary: 'safe', reversible: true }),
				captureRollback: capture,
				apply,
				rollback: () => {},
			},
			{
				type: 'navigation',
				preflight: () => {
					throw new Error('route unavailable');
				},
				apply,
			},
		];
		const engine = new ScenarioEngine({ stepAdapters: adapters });

		const receipt = await engine.execute(
			scenario([
				step('overrides', 'developer-overrides'),
				step('route', 'navigation'),
			]),
		);

		expect(receipt.status).toBe('preflight-failed');
		expect(capture).not.toHaveBeenCalled();
		expect(apply).not.toHaveBeenCalled();
	});

	it('resolves variables, applies sequentially, blocks conflicts, and undoes in reverse', async () => {
		let value = 'live';
		const order: string[] = [];
		const adapter: ScenarioActionAdapter = {
			type: 'developer-overrides',
			recoveryVersion: 1,
			preflight: ({ input }) => {
				expect(input).toEqual({ mode: 'mock' });
				return { summary: 'set mode', reversible: true };
			},
			captureRollback: ({ step: currentStep }) => {
				order.push(`capture:${currentStep.id}`);
				return value;
			},
			apply: ({ step: currentStep, input }) => {
				order.push(`apply:${currentStep.id}`);
				value = input.mode as string;
			},
			rollback: ({ step: currentStep, rollback }) => {
				order.push(`rollback:${currentStep.id}`);
				value = rollback as string;
			},
		};
		const engine = new ScenarioEngine({ stepAdapters: [adapter] });
		const definition = scenario(
			[
				{
					id: 'first',
					type: 'developer-overrides',
					input: { mode: { kind: 'variable', variableId: 'mode' } },
				},
				{
					id: 'second',
					type: 'developer-overrides',
					input: { mode: { kind: 'variable', variableId: 'mode' } },
				},
			],
			{
				variables: [
					{
						id: 'mode',
						label: 'Mode',
						type: 'string',
						required: true,
					},
				],
			},
		);

		const receipt = await engine.execute(definition, {
			variables: { mode: 'mock' },
		});
		expect(receipt.status).toBe('complete');
		expect(value).toBe('mock');
		expect(engine.getSnapshot().active?.scenarioId).toBe('test-scenario');
		await expect(engine.execute(definition)).rejects.toThrow('is active');

		const undo = await engine.undo(receipt.id);
		expect(undo.status).toBe('complete');
		expect(value).toBe('live');
		expect(order).toEqual([
			'capture:first',
			'capture:second',
			'apply:first',
			'apply:second',
			'rollback:second',
			'rollback:first',
		]);
		expect(engine.getSnapshot().active).toBeUndefined();
	});

	it('rolls back the failing step and prior steps after an apply failure', async () => {
		let first = 1;
		let second = 1;
		const adapter: ScenarioActionAdapter = {
			type: 'zustand-write',
			preflight: () => ({ summary: 'state', reversible: true }),
			captureRollback: ({ step: currentStep }) =>
				currentStep.id === 'first' ? first : second,
			apply: ({ step: currentStep }) => {
				if (currentStep.id === 'first') first = 2;
				else {
					second = 2;
					throw new Error('apply failed after side effect');
				}
			},
			rollback: ({ step: currentStep, rollback }) => {
				if (currentStep.id === 'first') first = rollback as number;
				else second = rollback as number;
			},
		};
		const engine = new ScenarioEngine({ stepAdapters: [adapter] });

		const receipt = await engine.execute(
			scenario([
				step('first', 'zustand-write'),
				step('second', 'zustand-write'),
			]),
		);

		expect(receipt.status).toBe('rolled-back');
		expect({ first, second }).toEqual({ first: 1, second: 1 });
		expect(receipt.stepResults).toEqual([
			expect.objectContaining({ apply: 'succeeded', rollback: 'succeeded' }),
			expect.objectContaining({ apply: 'failed', rollback: 'succeeded' }),
		]);
		expect(engine.getSnapshot().active).toBeUndefined();
	});

	it('requires explicit approval for non-reversible steps and reports incomplete undo', async () => {
		const engine = new ScenarioEngine({
			stepAdapters: [
				{
					type: 'custom-action',
					preflight: () => ({ summary: 'custom', reversible: false }),
					apply: () => {},
				},
			],
		});
		const definition = scenario([step('custom', 'custom-action')]);

		expect((await engine.execute(definition)).status).toBe('preflight-failed');
		const applied = await engine.execute(definition, {
			allowNonReversible: true,
		});
		expect(applied.status).toBe('complete');
		const undo = await engine.undo(applied.id);
		expect(undo.status).toBe('needs-attention');
		expect(undo.stepResults[0]).toMatchObject({
			rollback: 'failed',
			rollbackError: 'Step is non-reversible.',
		});
		expect(engine.getSnapshot().active).toBeDefined();
	});

	it('requires explicit approval for privileged steps before rollback capture', async () => {
		const captureRollback = jest.fn(() => ({ prior: true }));
		const apply = jest.fn();
		const engine = new ScenarioEngine({
			stepAdapters: [
				{
					type: 'storage-write',
					preflight: () => ({
						summary: 'preference',
						reversible: true,
						privileged: true,
					}),
					captureRollback,
					apply,
					rollback: () => {},
				},
			],
		});
		const definition = scenario([step('preference', 'storage-write')]);

		expect((await engine.execute(definition)).status).toBe('preflight-failed');
		expect(captureRollback).not.toHaveBeenCalled();
		expect(apply).not.toHaveBeenCalled();
		expect(
			(await engine.execute(definition, { allowPrivileged: true })).status,
		).toBe('complete');
	});

	it('evaluates scenario preconditions before step preflight', async () => {
		const preflight = jest.fn(() => ({ summary: 'safe', reversible: false }));
		const engine = new ScenarioEngine({
			stepAdapters: [{ type: 'navigation', preflight, apply: () => {} }],
			preconditionEvaluators: [
				{
					type: 'environment',
					evaluate: () => {
						throw new Error('wrong environment');
					},
				},
			],
		});

		const receipt = await engine.execute(
			scenario([step('route', 'navigation')], {
				preconditions: [{ id: 'preview-only', type: 'environment', input: {} }],
			}),
		);

		expect(receipt.status).toBe('preflight-failed');
		expect(receipt.error).toContain('wrong environment');
		expect(preflight).not.toHaveBeenCalled();
	});

	it('keeps failed rollback recoverable, blocks conflicts, and retries undo', async () => {
		const values = new Map([
			['first', 'before-first'],
			['second', 'before-second'],
		]);
		let failRollback = true;
		const rollbackOrder: string[] = [];
		let stored: string | undefined;
		const adapter: ScenarioActionAdapter = {
			type: 'developer-overrides',
			recoveryVersion: 1,
			preflight: () => ({ summary: 'override', reversible: true }),
			captureRollback: ({ step: currentStep }) => values.get(currentStep.id),
			apply: ({ step: currentStep }) => {
				values.set(currentStep.id, `after-${currentStep.id}`);
				if (currentStep.id === 'second') throw new Error('apply failed');
			},
			rollback: ({ rollback, step: currentStep }) => {
				rollbackOrder.push(currentStep.id);
				if (failRollback && currentStep.id === 'first') {
					throw new Error('rollback failed');
				}
				values.set(currentStep.id, rollback as string);
			},
		};
		const recoveryStorage = {
			load: () => stored,
			save: (serialized: string) => {
				stored = serialized;
			},
			clear: () => {
				stored = undefined;
			},
		};
		const engine = new ScenarioEngine({
			stepAdapters: [adapter],
			recoveryStorage,
			recoveryCompatibilityId: TEST_RECOVERY_COMPATIBILITY_ID,
		});
		const definition = scenario([
			step('first', 'developer-overrides'),
			step('second', 'developer-overrides'),
		]);

		const failed = await engine.execute(definition);
		expect(failed.status).toBe('needs-attention');
		expect(engine.getSnapshot().active).toMatchObject({
			receiptId: failed.id,
			recoveryRequired: true,
			stepCount: 1,
		});
		await expect(engine.execute(definition)).rejects.toThrow('is active');
		expect(JSON.parse(stored ?? '').steps).toHaveLength(1);

		failRollback = false;
		const restarted = new ScenarioEngine({
			stepAdapters: [adapter],
			recoveryStorage,
			recoveryCompatibilityId: TEST_RECOVERY_COMPATIBILITY_ID,
		});
		expect(restarted.getSnapshot().active?.stepCount).toBe(1);
		expect((await restarted.undo(failed.id)).status).toBe('complete');
		expect(values).toEqual(
			new Map([
				['first', 'before-first'],
				['second', 'before-second'],
			]),
		);
		expect(rollbackOrder).toEqual(['second', 'first', 'first']);
		expect(restarted.getSnapshot().active).toBeUndefined();
	});

	it('rehydrates a durable recovery checkpoint after restart and clears it on undo', async () => {
		let stored: string | undefined;
		let value = 'before';
		const recoveryStorage = {
			load: () => stored,
			save: (serialized: string) => {
				stored = serialized;
			},
			clear: () => {
				stored = undefined;
			},
		};
		const adapter: ScenarioActionAdapter = {
			type: 'developer-overrides',
			recoveryVersion: 1,
			preflight: () => ({ summary: 'override', reversible: true }),
			captureRollback: () => value,
			apply: () => {
				value = 'after';
			},
			rollback: ({ rollback }) => {
				value = rollback as string;
			},
		};
		const first = new ScenarioEngine({
			stepAdapters: [adapter],
			recoveryStorage,
			recoveryCompatibilityId: TEST_RECOVERY_COMPATIBILITY_ID,
		});
		const receipt = await first.execute(
			scenario([step('override', 'developer-overrides')]),
		);
		expect(receipt.status).toBe('complete');
		expect(stored).toContain(receipt.id);

		const restarted = new ScenarioEngine({
			stepAdapters: [adapter],
			recoveryStorage,
			recoveryCompatibilityId: TEST_RECOVERY_COMPATIBILITY_ID,
		});
		expect(restarted.getSnapshot().active).toMatchObject({
			receiptId: receipt.id,
			recoveryRequired: false,
		});
		expect((await restarted.undo(receipt.id)).status).toBe('complete');
		expect(value).toBe('before');
		expect(stored).toBeUndefined();
	});

	it('blocks recovery across app or adapter compatibility changes', async () => {
		let stored: string | undefined;
		const recoveryStorage = {
			load: () => stored,
			save: (value: string) => {
				stored = value;
			},
			clear: () => {
				stored = undefined;
			},
		};
		const adapter = (recoveryVersion: number): ScenarioActionAdapter => ({
			type: 'developer-overrides',
			recoveryVersion,
			preflight: () => ({ summary: 'override', reversible: true }),
			captureRollback: () => 'before',
			apply: () => {},
			rollback: () => {},
		});
		const first = new ScenarioEngine({
			stepAdapters: [adapter(1)],
			recoveryStorage,
			recoveryCompatibilityId: TEST_RECOVERY_COMPATIBILITY_ID,
		});
		await first.execute(scenario([step('override', 'developer-overrides')]));

		const appChanged = new ScenarioEngine({
			stepAdapters: [adapter(1)],
			recoveryStorage,
			recoveryCompatibilityId: 'test-scenario-adapters-v2',
		});
		expect(appChanged.getSnapshot().recoveryError).toContain('incompatible');
		const adapterChanged = new ScenarioEngine({
			stepAdapters: [adapter(2)],
			recoveryStorage,
			recoveryCompatibilityId: TEST_RECOVERY_COMPATIBILITY_ID,
		});
		expect(adapterChanged.getSnapshot().recoveryError).toContain(
			'incompatible',
		);
	});

	it('rejects stale undo receipts without changing the current scenario', async () => {
		let value = 'before';
		const adapter: ScenarioActionAdapter = {
			type: 'developer-overrides',
			recoveryVersion: 1,
			preflight: () => ({ summary: 'override', reversible: true }),
			captureRollback: () => value,
			apply: ({ context }) => {
				value = context.scenario.id;
			},
			rollback: ({ rollback }) => {
				value = rollback as string;
			},
		};
		const engine = new ScenarioEngine({ stepAdapters: [adapter] });
		const first = await engine.execute(
			scenario([step('override', 'developer-overrides')], { id: 'first' }),
		);
		await engine.undo(first.id);
		const second = await engine.execute(
			scenario([step('override', 'developer-overrides')], { id: 'second' }),
		);

		await expect(engine.undo(first.id)).rejects.toThrow(
			'changed after confirmation',
		);
		expect(engine.getSnapshot().active?.receiptId).toBe(second.id);
		expect(value).toBe('second');
		await engine.undo(second.id);
	});

	it('uses distinct receipt identities for same-scenario executions in one millisecond', async () => {
		const now = jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
		const engine = new ScenarioEngine({
			stepAdapters: [
				{
					type: 'developer-overrides',
					recoveryVersion: 1,
					preflight: () => ({ summary: 'override', reversible: true }),
					captureRollback: () => 'before',
					apply: () => {},
					rollback: () => {},
				},
			],
		});
		const definition = scenario([step('override', 'developer-overrides')]);
		try {
			const first = await engine.execute(definition);
			await engine.undo(first.id);
			const second = await engine.execute(definition);
			expect(second.id).not.toBe(first.id);
			await expect(engine.undo(first.id)).rejects.toThrow(
				'changed after confirmation',
			);
			await engine.undo(second.id);
		} finally {
			now.mockRestore();
		}
	});

	it('does not mutate when the pre-apply recovery checkpoint cannot be saved', async () => {
		const apply = jest.fn();
		const engine = new ScenarioEngine({
			stepAdapters: [
				{
					type: 'developer-overrides',
					recoveryVersion: 1,
					preflight: () => ({ summary: 'override', reversible: true }),
					captureRollback: () => 'before',
					apply,
					rollback: () => {},
				},
			],
			recoveryStorage: {
				load: () => undefined,
				save: () => {
					throw new Error('disk full');
				},
				clear: () => {},
			},
			recoveryCompatibilityId: TEST_RECOVERY_COMPATIBILITY_ID,
		});

		const receipt = await engine.execute(
			scenario([step('override', 'developer-overrides')]),
		);
		expect(receipt.status).toBe('preflight-failed');
		expect(receipt.error).toContain('disk full');
		expect(apply).not.toHaveBeenCalled();
	});

	it('bounds callbacks and releases running state after a hanging preflight', async () => {
		const engine = new ScenarioEngine({
			stepAdapters: [
				{
					type: 'navigation',
					preflight: () => new Promise(() => {}),
					apply: () => {},
				},
			],
			operationTimeoutMs: 5,
		});

		const receipt = await engine.execute(
			scenario([step('route', 'navigation')]),
		);
		expect(receipt.status).toBe('preflight-failed');
		expect(receipt.error).toContain('timed out');
		expect(engine.getSnapshot().running).toBe(false);
		await expect(
			engine.execute(scenario([step('route', 'navigation')])),
		).rejects.toThrow('still settling');
	});

	it('keeps durable recovery when a hanging apply is interrupted', async () => {
		let stored: string | undefined;
		const engine = new ScenarioEngine({
			stepAdapters: [
				{
					type: 'developer-overrides',
					recoveryVersion: 1,
					preflight: () => ({ summary: 'override', reversible: true }),
					captureRollback: () => 'before',
					apply: () => new Promise(() => {}),
					rollback: () => {},
				},
			],
			operationTimeoutMs: 5,
			recoveryStorage: {
				load: () => stored,
				save: (serialized) => {
					stored = serialized;
				},
				clear: () => {
					stored = undefined;
				},
			},
			recoveryCompatibilityId: TEST_RECOVERY_COMPATIBILITY_ID,
		});

		const receipt = await engine.execute(
			scenario([step('override', 'developer-overrides')]),
		);
		expect(receipt.status).toBe('needs-attention');
		expect(receipt.error).toContain('Recovery remains available');
		expect(engine.getSnapshot()).toMatchObject({
			running: false,
			active: { receiptId: receipt.id, recoveryRequired: true },
		});
		expect(stored).toContain('"recoveryRequired":true');
		await expect(engine.undo(receipt.id)).rejects.toThrow(
			'recovery is quarantined',
		);
	});

	it('journals only the attempted prefix when an apply is interrupted', async () => {
		let stored: string | undefined;
		let releaseApply: (() => void) | undefined;
		const hangingApply = new Promise<void>((resolve) => {
			releaseApply = resolve;
		});
		const rollback = jest.fn();
		const reversible: ScenarioActionAdapter = {
			type: 'developer-overrides',
			recoveryVersion: 1,
			preflight: () => ({ summary: 'override', reversible: true }),
			captureRollback: () => 'before',
			apply: () => hangingApply,
			rollback,
		};
		const nonReversible: ScenarioActionAdapter = {
			type: 'custom-action',
			recoveryVersion: 1,
			preflight: () => ({ summary: 'later', reversible: false }),
			apply: () => {},
		};
		const recoveryStorage = {
			load: () => stored,
			save: (serialized: string) => {
				stored = serialized;
			},
			clear: () => {
				stored = undefined;
			},
		};
		const definition = scenario([
			step('first', 'developer-overrides'),
			step('never-started', 'custom-action'),
		]);
		const engine = new ScenarioEngine({
			stepAdapters: [reversible, nonReversible],
			recoveryStorage,
			recoveryCompatibilityId: TEST_RECOVERY_COMPATIBILITY_ID,
			operationTimeoutMs: 5,
		});

		const receipt = await engine.execute(definition, {
			allowNonReversible: true,
		});

		expect(receipt.status).toBe('needs-attention');
		expect(JSON.parse(stored ?? '{}').steps).toEqual([
			expect.objectContaining({ stepId: 'first' }),
		]);
		releaseApply?.();
		await hangingApply;
		const restarted = new ScenarioEngine({
			stepAdapters: [reversible, nonReversible],
			recoveryStorage,
			recoveryCompatibilityId: TEST_RECOVERY_COMPATIBILITY_ID,
		});
		expect(await restarted.undo(receipt.id)).toMatchObject({
			status: 'complete',
			stepResults: [expect.objectContaining({ stepId: 'first' })],
		});
		expect(rollback).toHaveBeenCalledTimes(1);
	});

	it('does not overlap earlier rollbacks while an interrupted rollback settles', async () => {
		let releaseRollback: (() => void) | undefined;
		const hangingRollback = new Promise<void>((resolve) => {
			releaseRollback = resolve;
		});
		const order: string[] = [];
		let secondAttempts = 0;
		const adapter: ScenarioActionAdapter = {
			type: 'developer-overrides',
			recoveryVersion: 1,
			preflight: () => ({ summary: 'override', reversible: true }),
			captureRollback: () => 'before',
			apply: () => {},
			rollback: async ({ step: currentStep }) => {
				order.push(`start:${currentStep.id}`);
				if (currentStep.id === 'second' && secondAttempts++ === 0) {
					await hangingRollback;
				}
				order.push(`finish:${currentStep.id}`);
			},
		};
		const engine = new ScenarioEngine({
			stepAdapters: [adapter],
			operationTimeoutMs: 5,
		});
		const applied = await engine.execute(
			scenario([
				step('first', 'developer-overrides'),
				step('second', 'developer-overrides'),
			]),
		);

		const interrupted = await engine.undo(applied.id);
		expect(interrupted.status).toBe('needs-attention');
		expect(order).toEqual(['start:second']);
		await expect(engine.undo(applied.id)).rejects.toThrow('still settling');

		releaseRollback?.();
		await hangingRollback;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(order).toEqual(['start:second', 'finish:second']);
		expect((await engine.undo(applied.id)).status).toBe('complete');
		expect(order).toEqual([
			'start:second',
			'finish:second',
			'start:second',
			'finish:second',
			'start:first',
			'finish:first',
		]);
	});

	it('persists cleanup-only recovery and never replays a successful rollback', async () => {
		let stored: string | undefined;
		let failClear = true;
		const rollback = jest.fn();
		const recoveryStorage = {
			load: () => stored,
			save: (serialized: string) => {
				stored = serialized;
			},
			clear: () => {
				if (failClear) throw new Error('storage busy');
				stored = undefined;
			},
		};
		const adapter: ScenarioActionAdapter = {
			type: 'developer-overrides',
			recoveryVersion: 1,
			preflight: () => ({ summary: 'override', reversible: true }),
			captureRollback: () => 'before',
			apply: () => {},
			rollback,
		};
		const engine = new ScenarioEngine({
			stepAdapters: [adapter],
			recoveryStorage,
			recoveryCompatibilityId: TEST_RECOVERY_COMPATIBILITY_ID,
		});
		const applied = await engine.execute(
			scenario([step('override', 'developer-overrides')]),
		);

		const firstUndo = await engine.undo(applied.id);
		expect(firstUndo.status).toBe('needs-attention');
		expect(rollback).toHaveBeenCalledTimes(1);
		expect(engine.getSnapshot().active).toMatchObject({
			recoveryRequired: true,
			stepCount: 0,
		});
		expect(stored).toContain('"cleanupOnly":true');

		const restarted = new ScenarioEngine({
			stepAdapters: [adapter],
			recoveryStorage,
			recoveryCompatibilityId: TEST_RECOVERY_COMPATIBILITY_ID,
		});
		failClear = false;
		expect((await restarted.undo(applied.id)).status).toBe('complete');
		expect(rollback).toHaveBeenCalledTimes(1);
		expect(stored).toBeUndefined();
	});

	it('fails closed for corrupt and oversized recovery journals', async () => {
		const adapter: ScenarioActionAdapter = {
			type: 'navigation',
			recoveryVersion: 1,
			preflight: () => ({ summary: 'route', reversible: false }),
			apply: () => {},
		};
		for (const stored of ['{}', 'x'.repeat(1024 * 1024 + 1)]) {
			const engine = new ScenarioEngine({
				stepAdapters: [adapter],
				recoveryCompatibilityId: TEST_RECOVERY_COMPATIBILITY_ID,
				recoveryStorage: {
					load: () => stored,
					save: () => {},
					clear: () => {},
				},
			});
			expect(engine.getSnapshot().recoveryError).toContain(
				'Stored scenario recovery could not be loaded',
			);
			await expect(
				engine.execute(scenario([step('route', 'navigation')])),
			).rejects.toThrow('needs attention');
		}
	});

	it('discards active and corrupt recovery authority across an application reset', async () => {
		let stored: string | undefined;
		const recoveryStorage = {
			load: () => stored,
			save: (serialized: string) => {
				stored = serialized;
			},
			clear: () => {
				stored = undefined;
			},
		};
		const adapter: ScenarioActionAdapter = {
			type: 'developer-overrides',
			recoveryVersion: 1,
			preflight: () => ({ summary: 'override', reversible: true }),
			captureRollback: () => 'before',
			apply: () => {},
			rollback: () => {},
		};
		const engine = new ScenarioEngine({
			stepAdapters: [adapter],
			recoveryStorage,
			recoveryCompatibilityId: TEST_RECOVERY_COMPATIBILITY_ID,
		});
		const receipt = await engine.execute(
			scenario([step('override', 'developer-overrides')]),
		);
		expect(stored).toBeDefined();

		await engine.discardRecovery();
		expect(stored).toBeUndefined();
		expect(engine.getSnapshot().active).toBeUndefined();
		await expect(engine.undo(receipt.id)).rejects.toThrow('No active scenario');

		stored = '{}';
		const corrupt = new ScenarioEngine({
			stepAdapters: [adapter],
			recoveryStorage,
			recoveryCompatibilityId: TEST_RECOVERY_COMPATIBILITY_ID,
		});
		expect(corrupt.getSnapshot().recoveryError).toBeDefined();
		await corrupt.discardRecovery();
		expect(corrupt.getSnapshot().recoveryError).toBeUndefined();
		expect(stored).toBeUndefined();
	});

	it('retains corrupt recovery authority when direct journal deletion fails', async () => {
		const engine = new ScenarioEngine({
			stepAdapters: [],
			recoveryStorage: {
				load: () => '{}',
				save: () => {},
				clear: () => {
					throw new Error('storage busy');
				},
			},
			recoveryCompatibilityId: TEST_RECOVERY_COMPATIBILITY_ID,
		});
		const before = engine.getSnapshot().recoveryError;
		expect(before).toBeDefined();

		await expect(engine.discardRecovery()).rejects.toThrow('storage busy');
		expect(engine.getSnapshot().recoveryError).toBe(before);
	});

	it('waits for an ignored-signal callback before completing reset invalidation', async () => {
		let releaseApply: (() => void) | undefined;
		let startedApply: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			startedApply = resolve;
		});
		const hanging = new Promise<void>((resolve) => {
			releaseApply = resolve;
		});
		const engine = new ScenarioEngine({
			stepAdapters: [
				{
					type: 'developer-overrides',
					recoveryVersion: 1,
					preflight: () => ({ summary: 'override', reversible: true }),
					captureRollback: () => 'before',
					apply: async () => {
						startedApply?.();
						await hanging;
					},
					rollback: () => {},
				},
			],
			operationTimeoutMs: 1_000,
		});
		const execution = engine.execute(
			scenario([step('override', 'developer-overrides')]),
		);
		await started;
		let discarded = false;
		const discard = engine.discardRecovery().then(() => {
			discarded = true;
		});

		await Promise.resolve();
		expect(discarded).toBe(false);
		releaseApply?.();
		await execution;
		await discard;
		expect(discarded).toBe(true);
		expect(engine.getSnapshot().active).toBeUndefined();
	});

	it('fails reset invalidation closed when an adapter never quiesces', async () => {
		let startedApply: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			startedApply = resolve;
		});
		let stored: string | undefined;
		const engine = new ScenarioEngine({
			stepAdapters: [
				{
					type: 'developer-overrides',
					recoveryVersion: 1,
					preflight: () => ({ summary: 'override', reversible: true }),
					captureRollback: () => 'before',
					apply: () => {
						startedApply?.();
						return new Promise<void>(() => {});
					},
					rollback: () => {},
				},
			],
			recoveryStorage: {
				load: () => stored,
				save: (value) => {
					stored = value;
				},
				clear: () => {
					stored = undefined;
				},
			},
			recoveryCompatibilityId: TEST_RECOVERY_COMPATIBILITY_ID,
			operationTimeoutMs: 1_000,
			resetQuiescenceTimeoutMs: 5,
		});
		void engine.execute(scenario([step('override', 'developer-overrides')]));
		await started;

		await expect(engine.discardRecovery()).rejects.toThrow(
			'Recovery remains quarantined',
		);
		expect(stored).toBeDefined();
		expect(engine.getSnapshot().active).toMatchObject({
			recoveryRequired: true,
		});
	});
});

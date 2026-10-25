import {
	createDevToolsActionCoordinator,
	DEVTOOLS_ACTION_POLICY_VERSION,
	type DevToolsActionPlan,
} from './action-policy';

function plan(overrides: Partial<DevToolsActionPlan> = {}): DevToolsActionPlan {
	return {
		schemaVersion: DEVTOOLS_ACTION_POLICY_VERSION,
		requestId: 'request-1',
		actionFingerprint: 'storage.clear:v1',
		capability: {
			schemaVersion: DEVTOOLS_ACTION_POLICY_VERSION,
			id: 'storage.clear',
			availability: 'available',
		},
		pluginId: 'storage',
		label: 'Clear storage',
		risk: 'safe',
		confirmation: { required: false },
		rollback: { availability: 'not-applicable' },
		...overrides,
	};
}

describe('createDevToolsActionCoordinator', () => {
	it('rejects unavailable capabilities before invoking the host action', async () => {
		const action = jest.fn();
		const coordinator = createDevToolsActionCoordinator();

		const receipt = await coordinator.execute({
			plan: plan({
				capability: {
					schemaVersion: DEVTOOLS_ACTION_POLICY_VERSION,
					id: 'storage.clear',
					availability: 'unavailable',
					reason: {
						code: 'unsupported',
						message: 'This runtime cannot clear storage.',
					},
				},
			}),
			action,
		});

		expect(action).not.toHaveBeenCalled();
		expect(receipt).toMatchObject({
			status: 'rejected',
			errorCode: 'unsupported',
			rollbackStatus: 'not-needed',
		});
	});

	it('enforces trusted confirmation policy before invoking the action', async () => {
		const action = jest.fn();
		const confirm = jest.fn(async () => false);
		const coordinator = createDevToolsActionCoordinator({ confirm });
		const destructivePlan = plan({
			risk: 'destructive',
			confirmation: {
				required: true,
				title: 'Clear storage?',
				destructive: true,
			},
		});

		const receipt = await coordinator.execute({
			plan: destructivePlan,
			action,
		});

		expect(confirm).toHaveBeenCalledWith(
			expect.objectContaining({ required: true, destructive: true }),
			expect.objectContaining({ requestId: 'request-1' }),
		);
		expect(action).not.toHaveBeenCalled();
		expect(receipt.status).toBe('cancelled');

		const missingConfirmation = await createDevToolsActionCoordinator().execute(
			{
				plan: plan({
					requestId: 'request-2',
					risk: 'privacy-sensitive',
				}),
				action,
			},
		);
		expect(missingConfirmation.errorCode).toBe('confirmation-required');
		expect(action).not.toHaveBeenCalled();
	});

	it('cancels an unresolved confirmation before the action begins', async () => {
		let receivedSignal: AbortSignal | undefined;
		const action = jest.fn();
		const coordinator = createDevToolsActionCoordinator({
			confirm: (_confirmation, _plan, signal) => {
				receivedSignal = signal;
				return new Promise<boolean>(() => {});
			},
		});
		const controller = new AbortController();
		const pending = coordinator.execute({
			plan: plan({
				risk: 'destructive',
				confirmation: { required: true, title: 'Clear storage?' },
			}),
			action,
			signal: controller.signal,
		});
		await Promise.resolve();
		controller.abort();

		await expect(pending).resolves.toEqual(
			expect.objectContaining({ status: 'cancelled' }),
		);
		expect(receivedSignal).toBe(controller.signal);
		expect(action).not.toHaveBeenCalled();
	});

	it('keeps shadowed-signal confirmations in the bounded work budget', async () => {
		const confirm = jest.fn(() => new Promise<boolean>(() => {}));
		const coordinator = createDevToolsActionCoordinator({ confirm });
		const pending: Array<Promise<unknown>> = [];
		const controllers: AbortController[] = [];
		const shadowedAborted: jest.Mock[] = [];
		const shadowedAdds: jest.Mock[] = [];
		const shadowedRemoves: jest.Mock[] = [];
		for (let index = 0; index < 256; index += 1) {
			const controller = new AbortController();
			const add = jest.fn(() => {
				throw new Error('shadowed addEventListener');
			});
			const remove = jest.fn(() => {
				throw new Error('shadowed removeEventListener');
			});
			const aborted = jest.fn(() => {
				throw new Error('shadowed aborted');
			});
			Object.defineProperties(controller.signal, {
				aborted: { configurable: true, get: aborted },
				addEventListener: { configurable: true, value: add },
				removeEventListener: { configurable: true, value: remove },
			});
			controllers.push(controller);
			shadowedAborted.push(aborted);
			shadowedAdds.push(add);
			shadowedRemoves.push(remove);
			pending.push(
				coordinator.execute({
					plan: plan({
						requestId: `shadowed-${index}`,
						risk: 'destructive',
						confirmation: { required: true, title: 'Continue?' },
					}),
					action: jest.fn(),
					signal: controller.signal,
				}),
			);
		}
		await Promise.resolve();
		for (const controller of controllers) controller.abort();

		await expect(Promise.all(pending)).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ status: 'cancelled' }),
			]),
		);
		expect(shadowedAdds.every((method) => method.mock.calls.length === 0)).toBe(
			true,
		);
		expect(
			shadowedAborted.every((method) => method.mock.calls.length === 0),
		).toBe(true);
		expect(
			shadowedRemoves.every((method) => method.mock.calls.length === 0),
		).toBe(true);

		const rejected = await coordinator.execute({
			plan: plan({
				requestId: 'shadowed-over-limit',
				risk: 'destructive',
				confirmation: { required: true, title: 'Continue?' },
			}),
			action: jest.fn(),
		});
		expect(confirm).toHaveBeenCalledTimes(256);
		expect(rejected).toEqual(
			expect.objectContaining({
				errorCode: 'confirmation-unavailable',
				status: 'rejected',
			}),
		);
	});

	it('deduplicates concurrent and completed request IDs', async () => {
		let finish: (() => void) | undefined;
		const action = jest.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const coordinator = createDevToolsActionCoordinator();
		const execution = { plan: plan(), action };

		const first = coordinator.execute(execution);
		const duplicate = coordinator.execute(execution);
		await Promise.resolve();
		expect(action).toHaveBeenCalledTimes(1);
		finish?.();

		const [firstReceipt, duplicateReceipt] = await Promise.all([
			first,
			duplicate,
		]);
		expect(duplicateReceipt).toBe(firstReceipt);
		await expect(coordinator.execute(execution)).resolves.toBe(firstReceipt);
		expect(action).toHaveBeenCalledTimes(1);
	});

	it('rejects reuse of a request ID for a different canonical action', async () => {
		const coordinator = createDevToolsActionCoordinator();
		const firstAction = jest.fn();
		const conflictingAction = jest.fn();

		await coordinator.execute({ plan: plan(), action: firstAction });
		const receipt = await coordinator.execute({
			plan: plan({ actionFingerprint: 'storage.clear:other-target' }),
			action: conflictingAction,
		});

		expect(firstAction).toHaveBeenCalledTimes(1);
		expect(conflictingAction).not.toHaveBeenCalled();
		expect(receipt).toMatchObject({
			status: 'rejected',
			errorCode: 'request-id-conflict',
		});
	});

	it('returns success and bounded failure receipts', async () => {
		const receipts = jest.fn();
		const coordinator = createDevToolsActionCoordinator({
			onReceipt: receipts,
			now: () => 1234,
		});

		await expect(
			coordinator.execute({ plan: plan(), action: jest.fn() }),
		).resolves.toMatchObject({
			status: 'succeeded',
			startedAt: 1234,
			completedAt: 1234,
		});
		const failed = await coordinator.execute({
			plan: plan({
				requestId: 'request-failed',
				rollback: {
					availability: 'unavailable',
					reason: 'No checkpoint exists.',
				},
			}),
			action: () => {
				throw new Error('database unavailable');
			},
		});

		expect(failed).toMatchObject({
			status: 'failed',
			errorCode: 'action-failed',
			error: 'database unavailable',
			rollbackStatus: 'not-available',
		});
		expect(receipts).toHaveBeenCalledTimes(2);
	});

	it('records complete, partial, and failed rollback outcomes', async () => {
		const coordinator = createDevToolsActionCoordinator();
		const action = () => {
			throw new Error('apply failed');
		};
		const rollbackPlan = plan({
			rollback: { availability: 'available' },
		});

		await expect(
			coordinator.execute({
				plan: rollbackPlan,
				action,
				rollback: async () => ({ status: 'complete' }),
			}),
		).resolves.toMatchObject({
			status: 'rolled-back',
			rollbackStatus: 'succeeded',
		});
		await expect(
			coordinator.execute({
				plan: plan({
					requestId: 'request-partial',
					rollback: { availability: 'available' },
				}),
				action,
				rollback: async () => ({
					status: 'partial',
					reason: 'Cache restored, settings still changed.',
				}),
			}),
		).resolves.toMatchObject({
			status: 'needs-attention',
			rollbackStatus: 'partial',
			errorCode: 'rollback-partial',
		});
		await expect(
			coordinator.execute({
				plan: plan({
					requestId: 'request-rollback-failed',
					rollback: { availability: 'available' },
				}),
				action,
				rollback: async () => {
					throw new Error('rollback failed');
				},
			}),
		).resolves.toMatchObject({
			status: 'needs-attention',
			rollbackStatus: 'failed',
			errorCode: 'rollback-failed',
		});
	});

	it('rejects a promised rollback when the host omits its handler', async () => {
		const action = jest.fn();
		const coordinator = createDevToolsActionCoordinator();

		const receipt = await coordinator.execute({
			plan: plan({ rollback: { availability: 'available' } }),
			action,
		});

		expect(action).not.toHaveBeenCalled();
		expect(receipt).toMatchObject({
			status: 'rejected',
			errorCode: 'invalid-request',
		});
	});

	it('never persists confirmation content or unredacted sensitive text', async () => {
		const secret = 'private-action-token';
		const onReceipt = jest.fn();
		const coordinator = createDevToolsActionCoordinator({
			confirm: async () => true,
			onReceipt,
		});

		const receipt = await coordinator.execute({
			plan: plan({
				label: `Replay token=${secret}`,
				risk: 'confirmation',
				confirmation: {
					required: true,
					title: `Use token=${secret}?`,
					message: `Authorization: Bearer ${secret}`,
				},
			}),
			action: () => {
				throw new Error(`token=${secret}`);
			},
		});

		const persisted = JSON.stringify({ receipt, calls: onReceipt.mock.calls });
		expect(persisted).not.toContain(secret);
		expect(persisted).not.toContain('Authorization');
		expect(persisted).toContain('[REDACTED]');
		expect(receipt).not.toHaveProperty('confirmation');
	});
});

import { changedZustandKeys, createZustandPlugin } from './zustand';

/**
 * Store notifications coalesce into one capture per task, so assertions have to
 * let the queued microtask run first.
 */
function flushCaptures(): Promise<void> {
	return new Promise<void>((resolve) => {
		queueMicrotask(resolve);
	});
}

describe('createZustandPlugin', () => {
	it('captures only an explicit projection while installed', async () => {
		let state = { count: 1, secret: 'never expose this' };
		const listeners = new Set<() => void>();
		const diagnostics = createZustandPlugin({
			stores: [
				{
					id: 'counter',
					title: 'Counter',
					getInspectableState: () => ({ count: state.count }),
					subscribe: (listener) => {
						listeners.add(listener);
						return () => listeners.delete(listener);
					},
				},
			],
		});

		expect(diagnostics.getSnapshot().stores).toEqual([]);
		const dispose = diagnostics.plugin.install?.();
		expect(diagnostics.getSnapshot().stores[0]?.stateText).toContain(
			'"count": 1',
		);
		expect(diagnostics.getSnapshot().stores[0]?.stateText).not.toContain(
			'secret',
		);

		state = { count: 2, secret: 'still hidden' };
		for (const listener of listeners) listener();
		await flushCaptures();
		expect(diagnostics.getEvents()).toEqual([
			expect.objectContaining({ storeId: 'counter', changedKeys: ['count'] }),
		]);
		expect(JSON.stringify(diagnostics.getEvents())).not.toContain('hidden');
		state = { count: 2, secret: 'raw-only change' };
		for (const listener of listeners) listener();
		await flushCaptures();
		expect(diagnostics.getEvents()).toHaveLength(1);

		dispose?.();
		state = { count: 3, secret: 'hidden after dispose' };
		for (const listener of listeners) listener();
		await flushCaptures();
		expect(diagnostics.getEvents()).toHaveLength(1);
	});

	it('coalesces a burst of store notifications into one capture', async () => {
		let count = 0;
		let notify = () => {};
		const diagnostics = createZustandPlugin({
			stores: [
				{
					id: 'counter',
					title: 'Counter',
					getInspectableState: () => ({ count }),
					subscribe: (listener) => {
						notify = listener;
						return () => {};
					},
				},
			],
		});
		diagnostics.plugin.install?.();
		// A host store that calls set() repeatedly inside one task must not pay
		// for a full sanitize/serialize pass per call.
		for (let tick = 1; tick <= 25; tick += 1) {
			count = tick;
			notify();
		}
		await flushCaptures();
		expect(diagnostics.getEvents()).toHaveLength(1);
		expect(diagnostics.getEvents()[0]?.stateText).toContain('25');
	});

	it('detects a change that lands past the first kilobyte of a field', async () => {
		// Fingerprints once compared a 1 KB prefix, so an edit deeper into a large
		// field left the change log empty while the store text updated.
		const padding = 'x'.repeat(4_096);
		let notes = { padding, edited: 'before' };
		let notify = () => {};
		const diagnostics = createZustandPlugin({
			stores: [
				{
					id: 'notes',
					title: 'Notes',
					getInspectableState: () => ({ notes }),
					subscribe: (listener) => {
						notify = listener;
						return () => {};
					},
				},
			],
		});
		diagnostics.plugin.install?.();
		notes = { padding, edited: 'after' };
		notify();
		await flushCaptures();
		expect(diagnostics.getEvents()).toEqual([
			expect.objectContaining({ changedKeys: ['notes'] }),
		]);
	});

	it('bounds the change history by count', async () => {
		let count = 0;
		let notify = () => {};
		const diagnostics = createZustandPlugin({
			maxEvents: 1,
			stores: [
				{
					id: 'counter',
					title: 'Counter',
					getInspectableState: () => ({ count }),
					subscribe: (listener) => {
						notify = listener;
						return () => {};
					},
				},
			],
		});
		diagnostics.plugin.install?.();
		count = 1;
		notify();
		await flushCaptures();
		count = 2;
		notify();
		await flushCaptures();

		expect(diagnostics.getEvents()).toHaveLength(1);
		expect(diagnostics.getEvents()[0]?.stateText).toContain('2');
	});

	it('redacts credential-shaped fields from explicit projections', () => {
		const diagnostics = createZustandPlugin({
			stores: [
				{
					id: 'session',
					title: 'Session',
					getInspectableState: () => ({
						accessToken: 'private-access-token',
						ready: true,
					}),
					subscribe: () => () => {},
				},
			],
		});
		diagnostics.plugin.install?.();

		const snapshot = JSON.stringify(diagnostics.getSnapshot());
		expect(snapshot).toContain('[REDACTED]');
		expect(snapshot).not.toContain('private-access-token');
	});

	it('does not invoke accessors while fingerprinting projected state', () => {
		const getter = jest.fn(() => 'unsafe');
		const state = { count: 1 } as Record<string, unknown>;
		Object.defineProperty(state, 'computed', {
			enumerable: true,
			get: getter,
		});
		let notify = () => {};
		const diagnostics = createZustandPlugin({
			stores: [
				{
					id: 'safe',
					title: 'Safe',
					getInspectableState: () => state,
					subscribe: (listener) => {
						notify = listener;
						return () => {};
					},
				},
			],
		});

		diagnostics.plugin.install?.();
		notify();
		expect(getter).not.toHaveBeenCalled();
		expect(diagnostics.getSnapshot().stores[0]?.stateText).toContain(
			'[Accessor omitted]',
		);
	});

	it('bounds the number and aggregate size of projected stores', () => {
		const stores = Array.from({ length: 4 }, (_, index) => ({
			id: `store-${index}`,
			title: `Store ${index}`,
			getInspectableState: () => ({ value: 'x'.repeat(1_024) }),
			subscribe: () => () => {},
		}));
		const byCount = createZustandPlugin({ maxStores: 2, stores });
		byCount.plugin.install?.();
		expect(byCount.getSnapshot()).toMatchObject({
			stores: expect.arrayContaining([
				expect.objectContaining({ id: 'store-0' }),
				expect.objectContaining({ id: 'store-1' }),
			]),
			totalStoreCount: 4,
			omittedStoreCount: 2,
			truncated: true,
		});

		const byBytes = createZustandPlugin({
			maxSnapshotBytes: 400,
			maxValueBytes: 1_024,
			stores,
		});
		byBytes.plugin.install?.();
		expect(byBytes.getSnapshot().stores.length).toBeLessThan(stores.length);
		expect(byBytes.getSnapshot().truncated).toBe(true);
		expect(() => createZustandPlugin({ stores, maxEvents: 10_001 })).toThrow(
			'maxEvents cannot exceed',
		);
		expect(() =>
			createZustandPlugin({ stores, maxValueBytes: 1024 * 1024 + 1 }),
		).toThrow('maxValueBytes cannot exceed');
	});

	it('keeps array field metadata within the protocol key limit', async () => {
		let values = Array.from({ length: 700 }, (_, index) => index);
		let notify = () => {};
		const diagnostics = createZustandPlugin({
			stores: [
				{
					id: 'large-array',
					title: 'Large array',
					getInspectableState: () => values,
					subscribe: (listener) => {
						notify = listener;
						return () => {};
					},
				},
			],
		});
		diagnostics.plugin.install?.();
		expect(
			diagnostics.getSnapshot().stores[0]?.keys.length,
		).toBeLessThanOrEqual(500);
		expect(diagnostics.getSnapshot().stores[0]?.truncated).toBe(true);

		values = values.map((value) => value + 1);
		notify();
		await flushCaptures();
		expect(diagnostics.getEvents()[0]?.changedKeys.length).toBeLessThanOrEqual(
			500,
		);
	});

	it('contains faulty host subscriptions and disposers', () => {
		const diagnostics = createZustandPlugin({
			stores: [
				{
					id: 'faulty',
					title: 'Faulty',
					getInspectableState: () => ({ ready: true }),
					subscribe: () => {
						throw new Error('subscribe failed');
					},
				},
			],
			subscribeToStores: () => {
				throw new Error('registry failed');
			},
		});

		let dispose: (() => void) | undefined;
		expect(() => {
			dispose = diagnostics.plugin.install?.();
		}).not.toThrow();
		expect(diagnostics.getSnapshot().stores[0]?.id).toBe('faulty');
		expect(diagnostics.getSnapshot().stores[0]?.error).toContain(
			'Subscription failed',
		);
		expect(diagnostics.getEvents()[0]?.error).toContain('Subscription failed');
		expect(() => dispose?.()).not.toThrow();
	});

	it('ignores adapter callbacks after disposal and reinstallation', async () => {
		let count = 0;
		const listeners: Array<() => void> = [];
		const diagnostics = createZustandPlugin({
			stores: [
				{
					id: 'counter',
					title: 'Counter',
					getInspectableState: () => ({ count }),
					subscribe: (listener) => {
						listeners.push(listener);
						return () => {};
					},
				},
			],
		});
		const firstDispose = diagnostics.plugin.install?.();
		const staleListener = listeners[0];
		firstDispose?.();
		const secondDispose = diagnostics.plugin.install?.();
		count = 1;

		staleListener?.();
		await flushCaptures();

		expect(diagnostics.getEvents()).toEqual([]);
		expect(diagnostics.getSnapshot().stores[0]?.stateText).toContain(
			'"count": 0',
		);
		listeners[1]?.();
		await flushCaptures();
		expect(diagnostics.getEvents()).toEqual([
			expect.objectContaining({ changedKeys: ['count'] }),
		]);
		secondDispose?.();
	});

	it('keeps another install subscribed when a disposer is called twice', () => {
		const unsubscribe = jest.fn();
		const diagnostics = createZustandPlugin({
			stores: [
				{
					id: 'counter',
					title: 'Counter',
					getInspectableState: () => ({ count: 0 }),
					subscribe: () => unsubscribe,
				},
			],
		});
		const firstDispose = diagnostics.plugin.install?.();
		const secondDispose = diagnostics.plugin.install?.();

		firstDispose?.();
		firstDispose?.();
		expect(unsubscribe).not.toHaveBeenCalled();
		secondDispose?.();
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});

	it('surfaces invalid adapter contracts without making installation fatal', () => {
		const diagnostics = createZustandPlugin({
			stores: [
				{
					id: 'invalid',
					title: 'Invalid',
					getInspectableState: undefined,
					subscribe: () => () => {},
				},
			] as unknown as Parameters<typeof createZustandPlugin>[0]['stores'],
		});

		expect(() => diagnostics.plugin.install?.()).not.toThrow();
		expect(diagnostics.getSnapshot().error).toContain(
			'projection and subscription callbacks',
		);
	});

	it('does not invoke adapter accessors and reports invalid registry disposers', () => {
		const getter = jest.fn(() => () => ({ ready: true }));
		const adapter = {
			id: 'unsafe',
			title: 'Unsafe',
			subscribe: () => () => {},
		} as Record<string, unknown>;
		Object.defineProperty(adapter, 'getInspectableState', {
			enumerable: true,
			get: getter,
		});
		const unsafe = createZustandPlugin({
			stores: [adapter] as unknown as Parameters<
				typeof createZustandPlugin
			>[0]['stores'],
		});
		unsafe.plugin.install?.();
		expect(getter).not.toHaveBeenCalled();
		expect(unsafe.getSnapshot().error).toContain('must be plain data');

		const invalidRegistry = createZustandPlugin({
			stores: [],
			subscribeToStores: (() => undefined) as unknown as (
				listener: () => void,
			) => () => void,
		});
		invalidRegistry.plugin.install?.();
		expect(invalidRegistry.getSnapshot().error).toContain(
			'did not return a disposer',
		);
	});

	it('advertises only explicit mutation capabilities', () => {
		const diagnostics = createZustandPlugin({
			stores: [
				{
					id: 'read-only',
					title: 'Read only',
					getInspectableState: () => ({ count: 0 }),
					subscribe: () => () => {},
				},
				{
					id: 'writable',
					title: 'Writable',
					getInspectableState: () => ({ count: 0 }),
					subscribe: () => () => {},
					validatePatch: (patch) => patch,
					applyPatch: () => {},
					reset: () => {},
					persisted: true,
					restorable: true,
				},
			],
		});
		diagnostics.plugin.install?.();

		expect(diagnostics.getSnapshot().stores).toEqual([
			expect.objectContaining({
				id: 'read-only',
				capabilities: {
					writable: false,
					resettable: false,
					persisted: false,
					restorable: false,
					sensitivePaths: [],
				},
			}),
			expect.objectContaining({
				id: 'writable',
				capabilities: {
					writable: true,
					resettable: true,
					persisted: true,
					restorable: true,
					sensitivePaths: [],
				},
			}),
		]);
	});

	it('rejects partial, accessor-backed, and unsafe mutation contracts', () => {
		const optionalGetter = jest.fn(() => true);
		const accessorAdapter = {
			id: 'accessor',
			title: 'Accessor',
			getInspectableState: () => ({ count: 0 }),
			subscribe: () => () => {},
		} as Record<string, unknown>;
		Object.defineProperty(accessorAdapter, 'restorable', {
			enumerable: true,
			get: optionalGetter,
		});
		const cases = [
			{
				id: 'partial',
				title: 'Partial',
				getInspectableState: () => ({ count: 0 }),
				subscribe: () => () => {},
				validatePatch: (patch: unknown) => patch,
			},
			{
				id: 'no-writer',
				title: 'No writer',
				getInspectableState: () => ({ count: 0 }),
				subscribe: () => () => {},
				restorable: true,
			},
			{
				id: 'sensitive-restore',
				title: 'Sensitive restore',
				getInspectableState: () => ({ count: 0 }),
				subscribe: () => () => {},
				validatePatch: (patch: unknown) => patch,
				applyPatch: () => {},
				restorable: true,
				sensitivePaths: ['token'],
			},
			accessorAdapter,
		];

		for (const adapter of cases) {
			const diagnostics = createZustandPlugin({
				stores: [adapter] as unknown as Parameters<
					typeof createZustandPlugin
				>[0]['stores'],
			});
			diagnostics.plugin.install?.();
			expect(diagnostics.getSnapshot().error).toBeTruthy();
		}
		expect(optionalGetter).not.toHaveBeenCalled();
	});

	it('normalizes bounded sensitive paths without invoking list accessors', () => {
		const itemGetter = jest.fn(() => 'token');
		const paths: string[] = ['profile.email', 'profile.email', 'session.token'];
		Object.defineProperty(paths, '1', {
			enumerable: true,
			get: itemGetter,
		});
		const diagnostics = createZustandPlugin({
			stores: [
				{
					id: 'unsafe-paths',
					title: 'Unsafe paths',
					getInspectableState: () => ({ ready: true }),
					subscribe: () => () => {},
					sensitivePaths: paths,
				},
			],
		});
		diagnostics.plugin.install?.();
		expect(itemGetter).not.toHaveBeenCalled();
		expect(diagnostics.getSnapshot().error).toContain('holes or accessors');

		const bounded = createZustandPlugin({
			stores: [
				{
					id: 'too-many-paths',
					title: 'Too many paths',
					getInspectableState: () => ({ ready: true }),
					subscribe: () => () => {},
					sensitivePaths: Array.from(
						{ length: 501 },
						(_, index) => `p${index}`,
					),
				},
			],
		});
		bounded.plugin.install?.();
		expect(bounded.getSnapshot().error).toContain('cannot exceed 500');
	});

	it('applies validated patches, captures history, and correlates events', async () => {
		let state = { count: 0, label: 'initial' };
		let notify = () => {};
		const append = jest.fn();
		const diagnostics = createZustandPlugin({
			eventStore: { append } as never,
			stores: [
				{
					id: 'counter',
					title: 'Counter',
					getInspectableState: () => state,
					subscribe: (listener) => {
						notify = listener;
						return () => {};
					},
					validatePatch: (patch) => {
						if (!patch || typeof patch !== 'object')
							throw new Error('bad patch');
						return patch;
					},
					applyPatch: (patch) => {
						state = { ...state, ...(patch as typeof state) };
						notify();
					},
					restorable: true,
				},
			],
		});
		diagnostics.plugin.install?.();

		const receipt = await diagnostics.applyPatch(
			'counter',
			{ count: 2 },
			'route-action-1',
		);

		expect(state).toEqual({ count: 2, label: 'initial' });
		expect(receipt).toMatchObject({
			kind: 'patch',
			status: 'succeeded',
			changedKeys: ['count'],
			correlationId: 'route-action-1',
		});
		expect(diagnostics.getStateSnapshots('counter')).toHaveLength(2);
		expect(diagnostics.getMutationReceipts()).toEqual([receipt]);
		expect(append).toHaveBeenCalledWith(
			expect.objectContaining({
				correlationId: 'route-action-1',
				kind: 'mutation-succeeded',
			}),
		);
	});

	it('rejects invalid patches before mutation and records a failed receipt', async () => {
		let state = { count: 0 };
		const applyPatch = jest.fn((patch: unknown) => {
			state = { ...state, ...(patch as typeof state) };
		});
		const diagnostics = createZustandPlugin({
			stores: [
				{
					id: 'counter',
					title: 'Counter',
					getInspectableState: () => state,
					subscribe: () => () => {},
					validatePatch: (patch) => {
						const candidate = patch as { count?: number };
						if (candidate.count !== undefined && candidate.count < 0) {
							throw new Error('count must be non-negative');
						}
						return patch;
					},
					applyPatch,
					restorable: true,
				},
			],
		});

		await expect(
			diagnostics.applyPatch('counter', { count: -1 }),
		).rejects.toThrow('count must be non-negative');
		expect(state).toEqual({ count: 0 });
		expect(applyPatch).not.toHaveBeenCalled();
		expect(diagnostics.getMutationReceipts()).toEqual([
			expect.objectContaining({ status: 'failed', kind: 'patch' }),
		]);
	});

	it('rolls back an adapter that throws after mutating', async () => {
		let state = { count: 0 };
		const diagnostics = createZustandPlugin({
			stores: [
				{
					id: 'counter',
					title: 'Counter',
					getInspectableState: () => state,
					subscribe: () => () => {},
					validatePatch: (patch) => patch,
					applyPatch: (patch) => {
						state = { ...state, ...(patch as typeof state) };
						if (state.count === 2) throw new Error('host apply failed');
					},
					restorable: true,
				},
			],
		});

		await expect(
			diagnostics.applyPatch('counter', { count: 2 }),
		).rejects.toThrow('prior state was restored');
		expect(state).toEqual({ count: 0 });
		expect(diagnostics.getMutationReceipts()).toEqual([
			expect.objectContaining({ status: 'rolled-back' }),
		]);
	});

	it('rolls back a validator that changes state before rejecting a patch', async () => {
		let state = { count: 0 };
		const diagnostics = createZustandPlugin({
			stores: [
				{
					id: 'counter',
					title: 'Counter',
					getInspectableState: () => state,
					subscribe: () => () => {},
					validatePatch: (patch) => {
						if ((patch as { count?: number }).count === 3) {
							state = { count: 99 };
							throw new Error('validator rejected after a side effect');
						}
						return patch;
					},
					applyPatch: (patch) => {
						state = { ...state, ...(patch as typeof state) };
					},
					restorable: true,
				},
			],
		});

		await expect(
			diagnostics.applyPatch('counter', { count: 3 }),
		).rejects.toThrow('prior state was restored');
		expect(state).toEqual({ count: 0 });
		expect(diagnostics.getMutationReceipts()).toEqual([
			expect.objectContaining({ status: 'rolled-back' }),
		]);
	});

	it('resets and jumps only through the restorable adapter', async () => {
		let state = { count: 1 };
		const diagnostics = createZustandPlugin({
			stores: [
				{
					id: 'counter',
					title: 'Counter',
					getInspectableState: () => state,
					subscribe: () => () => {},
					validatePatch: (patch) => patch,
					applyPatch: (patch) => {
						state = { ...state, ...(patch as typeof state) };
					},
					reset: () => {
						state = { count: 0 };
					},
					restorable: true,
				},
			],
		});
		const captured = await diagnostics.captureState('counter');
		await diagnostics.applyPatch('counter', { count: 7 });
		expect(state.count).toBe(7);
		await diagnostics.jumpToState('counter', captured.id);
		expect(state.count).toBe(1);
		await diagnostics.resetStore('counter');
		expect(state.count).toBe(0);
	});

	it('keeps exact snapshots private and bounds public history', async () => {
		let state = { accessToken: 'private-token', count: 0 };
		const diagnostics = createZustandPlugin({
			maxStateSnapshots: 1,
			stores: [
				{
					id: 'counter',
					title: 'Counter',
					getInspectableState: () => state,
					subscribe: () => () => {},
					validatePatch: (patch) => patch,
					applyPatch: (patch) => {
						state = { ...state, ...(patch as typeof state) };
					},
					restorable: true,
				},
			],
		});
		await diagnostics.captureState('counter');
		state = { ...state, count: 1 };
		await diagnostics.captureState('counter');

		const snapshots = diagnostics.getStateSnapshots();
		expect(snapshots).toHaveLength(1);
		expect(JSON.stringify(snapshots)).toContain('[REDACTED]');
		expect(JSON.stringify(snapshots)).not.toContain('private-token');
		expect(snapshots[0]).not.toHaveProperty('json');
	});

	it('rejects accessor patches and dangerous object keys before host callbacks', async () => {
		const validatePatch = jest.fn((patch: unknown) => patch);
		const applyPatch = jest.fn();
		const diagnostics = createZustandPlugin({
			stores: [
				{
					id: 'counter',
					title: 'Counter',
					getInspectableState: () => ({ count: 0 }),
					subscribe: () => () => {},
					validatePatch,
					applyPatch,
					restorable: true,
				},
			],
		});
		const getter = jest.fn(() => 2);
		const accessorPatch = {} as Record<string, unknown>;
		Object.defineProperty(accessorPatch, 'count', {
			enumerable: true,
			get: getter,
		});
		await expect(
			diagnostics.applyPatch('counter', accessorPatch),
		).rejects.toThrow('accessor');
		expect(getter).not.toHaveBeenCalled();

		const dangerous = JSON.parse(
			'{"constructor":{"prototype":{"admin":true}}}',
		);
		await expect(diagnostics.applyPatch('counter', dangerous)).rejects.toThrow(
			'not allowed',
		);
		expect(applyPatch).not.toHaveBeenCalled();
		// validatePatch is used to validate the rollback projection, but neither
		// rejected user payload reaches it.
		expect(validatePatch).toHaveBeenCalledTimes(2);
	});
});

describe('changedZustandKeys', () => {
	it('reports added, removed, and modified top-level keys', () => {
		expect(
			changedZustandKeys(
				{ unchanged: '1', removed: '2', changed: 'before' },
				{ unchanged: '1', added: '3', changed: 'after' },
			),
		).toEqual(['added', 'changed', 'removed']);
	});

	it('bounds a completely replaced top-level key set', () => {
		const previous = Object.fromEntries(
			Array.from({ length: 500 }, (_, index) => [`old-${index}`, 'before']),
		);
		const next = Object.fromEntries(
			Array.from({ length: 500 }, (_, index) => [`new-${index}`, 'after']),
		);
		expect(changedZustandKeys(previous, next)).toHaveLength(500);
	});
});

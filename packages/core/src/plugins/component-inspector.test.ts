import {
	type ComponentRenderEventInput,
	componentTargetsAtPoint,
	createComponentInspectorPlugin,
	normalizeComponentRenderEvents,
	normalizeComponentTargets,
} from './component-inspector';

describe('normalizeComponentRenderEvents', () => {
	it('bounds profiler envelopes without retaining props or state', () => {
		const events = normalizeComponentRenderEvents(
			[
				{
					id: 'render-1',
					targetId: 'target-1',
					at: 100,
					phase: 'update',
					actualDuration: 4.25,
					baseDuration: 8.75,
					startTime: 90,
					commitTime: 99,
					renderCount: 2,
					cause: 'unknown',
					changedKeys: ['title', 'accessToken'],
					props: { secret: 'must-not-be-read' },
				} as never,
			],
			10,
		);

		expect(events).toEqual([
			expect.objectContaining({
				id: 'render-1',
				targetId: 'target-1',
				actualDuration: 4.3,
				baseDuration: 8.8,
				cause: 'unknown',
				changedKeys: ['title', 'accessToken'],
			}),
		]);
		expect(JSON.stringify(events)).not.toContain('must-not-be-read');
	});

	it('rejects malformed metrics and does not invoke accessors', () => {
		const accessor = jest.fn(() => 'secret');
		const candidate = {
			id: 'render-1',
			targetId: 'target-1',
			at: 100,
			phase: 'update',
			actualDuration: Number.NaN,
			baseDuration: 8,
			startTime: 90,
			commitTime: 99,
			renderCount: 2,
		};
		Object.defineProperty(candidate, 'cause', { get: accessor });

		expect(normalizeComponentRenderEvents([candidate as never], 10)).toEqual(
			[],
		);
		expect(accessor).not.toHaveBeenCalled();
	});
});

describe('componentTargetsAtPoint', () => {
	it('orders overlapping targets front-to-back deterministically', () => {
		const targets = normalizeComponentTargets(
			[
				{
					id: 'back',
					name: 'Back',
					bounds: { x: 0, y: 0, width: 100, height: 100 },
					isFocused: true,
					depth: 1,
					zIndex: 0,
				},
				{
					id: 'front',
					name: 'Front',
					bounds: { x: 10, y: 10, width: 80, height: 80 },
					isFocused: true,
					depth: 2,
					zIndex: 3,
				},
				{
					id: 'background-route',
					name: 'Background route',
					bounds: { x: 10, y: 10, width: 20, height: 20 },
					isFocused: false,
					zIndex: 99,
				},
			],
			{ maxTargets: 5, maxInstanceBytes: 128, maxTextBytes: 64 },
		);

		expect(
			componentTargetsAtPoint(targets, { x: 20, y: 20 }).map(
				(target) => target.id,
			),
		).toEqual(['front', 'back']);
		expect(componentTargetsAtPoint(targets, { x: Number.NaN, y: 0 })).toEqual(
			[],
		);
	});
});

describe('normalizeComponentTargets', () => {
	it('bounds target count, metadata, measurements, and instance previews', () => {
		const targets = normalizeComponentTargets(
			[
				{
					id: 'target-1',
					name: 'Example card',
					bounds: { x: Number.NaN, y: 10.25, width: -2, height: 30.75 },
					instance: { state: 'x'.repeat(100) },
					sourceFiles: ['one.tsx', 'two.tsx'],
				},
				{ id: 'target-2', name: 'Hidden by cap' },
			],
			{ maxTargets: 1, maxInstanceBytes: 32, maxTextBytes: 32 },
		);

		expect(targets).toHaveLength(1);
		expect(targets[0]).toEqual(
			expect.objectContaining({
				id: 'target-1',
				kind: 'component',
				instanceTruncated: true,
				bounds: null,
			}),
		);
		expect(
			normalizeComponentTargets([{ id: 'target', name: 'Target' }], {
				maxTargets: 10,
				maxInstanceBytes: 32,
				maxTextBytes: 32,
				maxSnapshotBytes: 1,
			}),
		).toEqual([]);
	});

	it('skips invalid and duplicate instances without hiding later entries', () => {
		const targets = normalizeComponentTargets(
			[
				{ id: '', name: 'Missing id' },
				{ id: 'one', name: '   ' },
				{ id: 'two', name: 'Two' },
				{ id: 'two', name: 'Duplicate' },
			],
			{
				maxTargets: 1,
				maxInstanceBytes: 32,
				maxTextBytes: 64,
				maxSnapshotBytes: 512,
			},
		);

		expect(targets).toEqual([
			expect.objectContaining({ id: 'two', name: 'Two' }),
		]);
	});

	it('bounds target identifiers by UTF-8 bytes for desktop action parity', () => {
		const targets = normalizeComponentTargets(
			[
				{ id: '🏋️'.repeat(100), name: 'Oversized identifier' },
				{ id: 'safe-id', name: 'Safe target' },
			],
			{ maxTargets: 5, maxInstanceBytes: 32, maxTextBytes: 64 },
		);

		expect(targets).toEqual([
			expect.objectContaining({ id: 'safe-id', name: 'Safe target' }),
		]);
	});

	it('contains malformed runtime metadata from a host source', () => {
		const targets = normalizeComponentTargets(
			[
				{ id: 'valid', name: 'Valid', kind: 42, isFocused: 'yes' },
				{ id: 10, name: 'Invalid' },
			] as unknown as Parameters<typeof normalizeComponentTargets>[0],
			{ maxTargets: 5, maxInstanceBytes: 32, maxTextBytes: 32 },
		);

		expect(targets).toEqual([
			expect.objectContaining({
				id: 'valid',
				kind: 'component',
				isFocused: false,
			}),
		]);
	});

	it('redacts instance metadata before serialization', () => {
		const targets = normalizeComponentTargets(
			[
				{
					id: 'private-target',
					name: 'Private target',
					instance: {
						accessToken: 'opaque-private-token',
						status: 'ready',
					},
				},
			],
			{ maxTargets: 5, maxInstanceBytes: 1_024, maxTextBytes: 64 },
		);

		expect(targets[0]?.instanceText).toContain('[REDACTED]');
		expect(targets[0]?.instanceText).not.toContain('opaque-private-token');
	});

	it('bounds explicit accessibility semantics and derives a screen hash', () => {
		const targets = normalizeComponentTargets(
			[
				{
					id: 'semantic-target',
					name: 'Search field',
					accessibilityLabel: 'Search items',
					accessibilityHint: 'Filters the item list',
					accessibilityRole: 'search',
					accessibilityValue: 'example',
					accessibilityState: {
						disabled: false,
						selected: true,
						secret: 'must be omitted',
					},
					actions: ['focus', 'setText', 'unsupported'],
				},
			] as Parameters<typeof normalizeComponentTargets>[0],
			{ maxTargets: 5, maxInstanceBytes: 1_024, maxTextBytes: 64 },
		);

		expect(targets[0]).toEqual(
			expect.objectContaining({
				accessibilityLabel: 'Search items',
				accessibilityRole: 'search',
				accessibilityState: { disabled: false, selected: true },
				actions: ['focus', 'setText'],
				screenHash: expect.stringMatching(/^screen-[0-9a-f]{8}$/),
			}),
		);
		expect(JSON.stringify(targets[0])).not.toContain('must be omitted');
	});

	it('normalizes explicit hierarchy metadata and redacts safe style projections', () => {
		const targets = normalizeComponentTargets(
			[
				{
					id: 'child-instance',
					targetId: 'item-row',
					parentId: 'parent-instance',
					depth: 2,
					zIndex: 12.25,
					name: 'Item row',
					styles: {
						display: 'flex',
						accessToken: 'must-not-leak',
					},
				},
			],
			{ maxTargets: 5, maxInstanceBytes: 1_024, maxTextBytes: 64 },
		);

		expect(targets[0]).toEqual(
			expect.objectContaining({
				id: 'child-instance',
				targetId: 'item-row',
				parentId: 'parent-instance',
				depth: 2,
				zIndex: 12.3,
				styleTruncated: false,
			}),
		);
		expect(targets[0]?.styleText).toContain('[REDACTED]');
		expect(targets[0]?.styleText).not.toContain('must-not-leak');
	});

	it('skips accessor-backed target fields without invoking them', () => {
		const target = { id: 'safe', name: 'Safe target' } as Record<
			string,
			unknown
		>;
		Object.defineProperty(target, 'route', {
			enumerable: true,
			get() {
				throw new Error('route getter must not run');
			},
		});

		const targets = normalizeComponentTargets(
			[target] as unknown as Parameters<typeof normalizeComponentTargets>[0],
			{ maxTargets: 5, maxInstanceBytes: 1_024, maxTextBytes: 64 },
		);

		expect(targets).toEqual([
			expect.objectContaining({ id: 'safe', route: undefined }),
		]);
	});

	it('does not invoke accessors in the target list', () => {
		const getter = jest.fn(() => ({ id: 'unsafe', name: 'Unsafe' }));
		const targets: unknown[] = [];
		Object.defineProperty(targets, '0', {
			enumerable: true,
			get: getter,
		});
		targets.length = 1;

		expect(
			normalizeComponentTargets(
				targets as Parameters<typeof normalizeComponentTargets>[0],
				{ maxTargets: 5, maxInstanceBytes: 1_024, maxTextBytes: 64 },
			),
		).toEqual([]);
		expect(getter).not.toHaveBeenCalled();
	});

	it('rejects a revoked target-list proxy without throwing', () => {
		const revoked = Proxy.revocable([], {});
		revoked.revoke();

		expect(
			normalizeComponentTargets(
				revoked.proxy as Parameters<typeof normalizeComponentTargets>[0],
				{ maxTargets: 5, maxInstanceBytes: 1_024, maxTextBytes: 64 },
			),
		).toEqual([]);
	});
});

describe('createComponentInspectorPlugin', () => {
	it('rejects unsafe retention limits', () => {
		const source = { getSnapshot: () => [], subscribe: () => () => {} };
		expect(() =>
			createComponentInspectorPlugin({ source, maxTargets: 5_001 }),
		).toThrow('maxTargets cannot exceed');
		expect(() =>
			createComponentInspectorPlugin({
				source,
				maxSnapshotBytes: 16 * 1024 * 1024 + 1,
			}),
		).toThrow('maxSnapshotBytes cannot exceed');
	});

	it('subscribes to an explicit target source only while installed', () => {
		let targets = [{ id: 'one', name: 'One' }];
		let listener: (() => void) | undefined;
		const diagnostics = createComponentInspectorPlugin({
			source: {
				getSnapshot: () => targets,
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {
						listener = undefined;
					};
				},
			},
		});

		expect(diagnostics.getTargets()).toEqual([]);
		const dispose = diagnostics.plugin.install?.();
		expect(diagnostics.getTargets().map((target) => target.id)).toEqual([
			'one',
		]);
		targets = [{ id: 'two', name: 'Two' }];
		listener?.();
		expect(diagnostics.getTargets().map((target) => target.id)).toEqual([
			'two',
		]);

		dispose?.();
		expect(listener).toBeUndefined();
	});

	it('collects bounded profiler events only while installed', () => {
		let renderListener: (() => void) | undefined;
		let renderEvents: ComponentRenderEventInput[] = [
			{
				id: 'render-1',
				targetId: 'one',
				at: 100,
				phase: 'mount' as const,
				actualDuration: 3,
				baseDuration: 4,
				startTime: 90,
				commitTime: 99,
				renderCount: 1,
			},
		];
		const diagnostics = createComponentInspectorPlugin({
			source: {
				getSnapshot: () => [{ id: 'one', name: 'One' }],
				subscribe: () => () => {},
			},
			renderSource: {
				getSnapshot: () => renderEvents,
				subscribe: (listener) => {
					renderListener = listener;
					return () => {
						renderListener = undefined;
					};
				},
			},
			maxRenderEvents: 1,
		});

		expect(diagnostics.getRenderEvents()).toEqual([]);
		const dispose = diagnostics.plugin.install?.();
		expect(diagnostics.getRenderEvents()).toEqual([
			expect.objectContaining({ id: 'render-1', cause: 'mount' }),
		]);
		renderEvents = [
			...renderEvents,
			{
				id: 'render-2',
				targetId: 'one',
				at: 110,
				phase: 'update',
				actualDuration: 2,
				baseDuration: 4,
				startTime: 101,
				commitTime: 109,
				renderCount: 2,
			},
		];
		renderListener?.();
		expect(diagnostics.getRenderEvents()).toEqual([
			expect.objectContaining({ id: 'render-2', cause: 'unknown' }),
		]);
		dispose?.();
		expect(renderListener).toBeUndefined();
	});

	it('retains distinct instances that share a target id and reports the collision', () => {
		const diagnostics = createComponentInspectorPlugin({
			source: {
				getSnapshot: () => [
					{ id: 'row-1', targetId: 'item-row', name: 'Row one' },
					{ id: 'row-2', targetId: 'item-row', name: 'Row two' },
				],
				subscribe: () => () => {},
			},
		});

		const dispose = diagnostics.plugin.install?.();
		expect(diagnostics.getTargets().map((target) => target.id)).toEqual([
			'row-1',
			'row-2',
		]);
		expect(diagnostics.getSnapshot().diagnostics).toEqual([
			expect.objectContaining({
				code: 'duplicate-target-id',
				targetId: 'item-row',
				instanceIds: ['row-1', 'row-2'],
			}),
		]);
		dispose?.();
	});

	it('contains faulty host sources during install and capture', () => {
		const diagnostics = createComponentInspectorPlugin({
			source: {
				getSnapshot: () => {
					throw new Error('snapshot failed');
				},
				subscribe: () => {
					throw new Error('subscribe failed');
				},
			},
		});

		let dispose: (() => void) | undefined;
		expect(() => {
			dispose = diagnostics.plugin.install?.();
		}).not.toThrow();
		expect(diagnostics.getTargets()).toEqual([]);
		expect(diagnostics.getSnapshot().error).toContain('Subscription failed');
		expect(() => dispose?.()).not.toThrow();
	});

	it('ignores a pending refresh after the collector is disposed', async () => {
		let targets = [{ id: 'before', name: 'Before' }];
		let resolveRefresh: (() => void) | undefined;
		const diagnostics = createComponentInspectorPlugin({
			source: {
				getSnapshot: () => targets,
				subscribe: () => () => {},
				refresh: () =>
					new Promise<void>((resolve) => {
						resolveRefresh = resolve;
					}),
			},
		});
		const dispose = diagnostics.plugin.install?.();
		targets = [{ id: 'after', name: 'After' }];
		dispose?.();
		resolveRefresh?.();
		await Promise.resolve();

		expect(diagnostics.getTargets().map((target) => target.id)).toEqual([
			'before',
		]);
	});

	it('ignores callbacks fired by a faulty disposer', () => {
		let targets = [{ id: 'before', name: 'Before' }];
		const diagnostics = createComponentInspectorPlugin({
			source: {
				getSnapshot: () => targets,
				subscribe: (listener) => () => listener(),
			},
		});
		const dispose = diagnostics.plugin.install?.();
		targets = [{ id: 'during-dispose', name: 'During dispose' }];

		dispose?.();

		expect(diagnostics.getTargets().map((target) => target.id)).toEqual([
			'before',
		]);
	});

	it('delegates explicit target highlighting only while installed', async () => {
		const highlight = jest.fn();
		const diagnostics = createComponentInspectorPlugin({
			source: {
				getSnapshot: () => [{ id: 'one', name: 'One' }],
				subscribe: () => () => {},
				highlight,
			},
		});
		await expect(diagnostics.highlight('one')).rejects.toThrow('disabled');
		const dispose = diagnostics.plugin.install?.();
		await diagnostics.highlight('one');
		expect(highlight).toHaveBeenCalledWith('one');
		dispose?.();
	});

	it('rejects stale semantic actions and delegates only advertised actions', async () => {
		const performAction = jest.fn();
		const diagnostics = createComponentInspectorPlugin({
			source: {
				getSnapshot: () => [
					{
						id: 'one',
						name: 'One',
						actions: ['activate', 'setText'] as const,
					},
				],
				subscribe: () => () => {},
				performAction,
			},
		});
		const dispose = diagnostics.plugin.install?.();
		const { screenHash } = diagnostics.getSnapshot();

		await expect(
			diagnostics.performAction('one', 'screen-stale', { type: 'activate' }),
		).rejects.toThrow('screen changed');
		await expect(
			diagnostics.performAction('one', screenHash, {
				type: 'scroll',
				direction: 'down',
			}),
		).rejects.toThrow('does not support scroll');
		await diagnostics.performAction('one', screenHash, {
			type: 'setText',
			text: 'Example',
		});
		expect(performAction).toHaveBeenCalledWith('one', {
			type: 'setText',
			text: 'Example',
		});
		dispose?.();
	});

	it('waits for an explicitly registered element and screen change', async () => {
		let targets = [{ id: 'before', name: 'Before' }];
		let listener: (() => void) | undefined;
		const diagnostics = createComponentInspectorPlugin({
			source: {
				getSnapshot: () => targets,
				subscribe: (nextListener) => {
					listener = nextListener;
					return () => {
						listener = undefined;
					};
				},
			},
		});
		const dispose = diagnostics.plugin.install?.();
		const originalScreenHash = diagnostics.getSnapshot().screenHash;
		const elementWait = diagnostics.waitForElement('after', 1_000);
		const screenWait = diagnostics.waitForScreenChange(
			originalScreenHash,
			1_000,
		);

		targets = [{ id: 'after', name: 'After' }];
		listener?.();
		await expect(elementWait).resolves.toBeUndefined();
		await expect(screenWait).resolves.toBeUndefined();
		dispose?.();
	});
});

import {
	canonicalizeRestoreValue,
	createRestorePointsPlugin,
	type RestorePointStorage,
} from './restore-points';

function createMemoryRestoreStorage(): RestorePointStorage & {
	readonly values: Map<string, string>;
} {
	const values = new Map<string, string>();
	return {
		values,
		getItem: (key) => values.get(key),
		setItem: (key, value) => {
			values.set(key, value);
		},
		removeItem: (key) => {
			values.delete(key);
		},
	};
}

describe('createRestorePointsPlugin', () => {
	it('captures detached JSON and restores through the explicit source', async () => {
		let state = { mode: 'live', nested: { count: 1 } };
		const diagnostics = createRestorePointsPlugin({
			sources: [
				{
					id: 'scenario',
					title: 'Scenario',
					capture: () => state,
					restore: (snapshot) => {
						state = snapshot as typeof state;
					},
				},
			],
		});

		const point = await diagnostics.capture('Before repro');
		state.nested.count = 99;
		state = { mode: 'mock', nested: { count: 2 } };
		await diagnostics.restore(point.id);

		expect(state).toEqual({ mode: 'live', nested: { count: 1 } });
		expect(diagnostics.getPoints()[0]?.label).toBe('Before repro');
	});

	it('rolls attempted sources back if a restore fails', async () => {
		let first = 1;
		let second = 1;
		const diagnostics = createRestorePointsPlugin({
			sources: [
				{
					id: 'first',
					title: 'First',
					capture: () => first,
					restore: (value) => {
						first = value as number;
					},
				},
				{
					id: 'second',
					title: 'Second',
					capture: () => second,
					restore: (value) => {
						if (value === 1) throw new Error('source rejected old state');
						second = value as number;
					},
				},
			],
		});
		const point = await diagnostics.capture();
		first = 2;
		second = 2;

		await expect(diagnostics.restore(point.id)).rejects.toThrow(
			'The pre-restore state was reapplied',
		);
		expect(first).toBe(2);
		expect(second).toBe(2);
	});

	it('evicts the oldest points by count', async () => {
		let state = 1;
		const diagnostics = createRestorePointsPlugin({
			maxPoints: 1,
			sources: [
				{
					id: 'state',
					title: 'State',
					capture: () => state,
					restore: () => {},
				},
			],
		});
		await diagnostics.capture('One');
		state = 2;
		await diagnostics.capture('Two');

		expect(diagnostics.getPoints()).toHaveLength(1);
		expect(diagnostics.getPoints()[0]?.label).toBe('Two');
	});

	it('validates source metadata and bounds labels', async () => {
		expect(() =>
			createRestorePointsPlugin({
				sources: [
					{
						id: ' spaced ',
						title: 'Invalid',
						capture: () => 1,
						restore: () => {},
					},
				],
			}),
		).toThrow('surrounding whitespace');

		const diagnostics = createRestorePointsPlugin({
			sources: [
				{ id: 'state', title: 'State', capture: () => 1, restore: () => {} },
			],
		});
		const point = await diagnostics.capture('x'.repeat(1_000));
		expect(point.label.length).toBeLessThan(1_000);
		expect(point.estimatedBytes).toBe(
			new TextEncoder().encode(JSON.stringify(point)).byteLength,
		);
		await expect(diagnostics.remove('missing')).rejects.toThrow(
			'no longer available',
		);
	});

	it('bounds the explicit source registry', () => {
		expect(() =>
			createRestorePointsPlugin({
				sources: Array.from({ length: 51 }, (_, index) => ({
					id: `source-${index}`,
					title: `Source ${index}`,
					capture: () => index,
					restore: () => {},
				})),
			}),
		).toThrow('at most 50');
	});

	it('does not invoke source accessors and caps retained state', () => {
		const getter = jest.fn(() => () => ({ ready: true }));
		const source = {
			id: 'unsafe',
			title: 'Unsafe',
			restore: () => {},
		} as Record<string, unknown>;
		Object.defineProperty(source, 'capture', {
			enumerable: true,
			get: getter,
		});
		expect(() =>
			createRestorePointsPlugin({
				sources: [source] as unknown as Parameters<
					typeof createRestorePointsPlugin
				>[0]['sources'],
			}),
		).toThrow('capture and restore functions');
		expect(getter).not.toHaveBeenCalled();
		expect(() =>
			createRestorePointsPlugin({ sources: [], maxPoints: 51 }),
		).toThrow('maxPoints cannot exceed');
		expect(() =>
			createRestorePointsPlugin({
				sources: [],
				maxTotalBytes: 16 * 1024 * 1024 + 1,
			}),
		).toThrow('maxTotalBytes cannot exceed');
	});

	it('persists, hydrates, renames, duplicates, and exports dedicated restore points', async () => {
		const storage = createMemoryRestoreStorage();
		let state = { ready: true };
		const source = {
			id: 'safe-state',
			title: 'Safe state',
			capture: () => state,
			restore: (snapshot: unknown) => {
				state = snapshot as typeof state;
			},
		};
		const first = createRestorePointsPlugin({
			sources: [source],
			persistence: { storage },
		});
		const captured = await first.capture('Original');
		await first.rename(captured.id, 'Renamed');
		await first.duplicate(captured.id, 'Copy');

		const hydrated = createRestorePointsPlugin({
			sources: [source],
			persistence: { storage },
		});
		await hydrated.ready;

		expect(hydrated.getPoints().map((point) => point.label)).toEqual([
			'Renamed',
			'Copy',
		]);
		const exported = JSON.parse(hydrated.exportJson()) as {
			schemaVersion: number;
			namespace: string;
			points: unknown[];
		};
		expect(exported).toMatchObject({
			schemaVersion: 1,
			namespace: 'rndevtools-restore-points',
		});
		expect(exported.points).toHaveLength(2);
	});

	it('discards malformed persisted entries without touching other storage keys', async () => {
		const storage = createMemoryRestoreStorage();
		storage.values.set('unrelated-app-key', 'keep-me');
		const source = {
			id: 'safe-state',
			title: 'Safe state',
			capture: () => ({ count: 1 }),
			restore: () => {},
		};
		const seed = createRestorePointsPlugin({
			sources: [source],
			persistence: { storage },
		});
		await seed.capture('Valid');
		const key = '@rndevtools/core/restore-points/v1';
		const document = JSON.parse(storage.values.get(key) ?? '{}') as {
			points: unknown[];
		};
		document.points.push({ id: 'invalid', label: '', sources: [] });
		storage.values.set(key, JSON.stringify(document));

		const hydrated = createRestorePointsPlugin({
			sources: [source],
			persistence: { storage },
		});
		await hydrated.ready;

		expect(hydrated.getPoints()).toHaveLength(1);
		expect(storage.values.get('unrelated-app-key')).toBe('keep-me');
		expect(
			(JSON.parse(storage.values.get(key) ?? '{}') as { points: unknown[] })
				.points,
		).toHaveLength(1);
	});

	it('rejects an invalid import atomically', async () => {
		const diagnostics = createRestorePointsPlugin({
			sources: [
				{
					id: 'safe-state',
					title: 'Safe state',
					capture: () => ({ count: 1 }),
					restore: () => {},
				},
			],
		});
		await diagnostics.capture('Existing');
		const document = JSON.parse(diagnostics.exportJson()) as {
			points: Array<Record<string, unknown>>;
		};
		document.points.push({ id: 'bad', label: 'Bad' });

		await expect(
			diagnostics.importJson(JSON.stringify(document)),
		).rejects.toThrow('timestamp');
		expect(diagnostics.getPoints().map((point) => point.label)).toEqual([
			'Existing',
		]);
		await expect(
			diagnostics.importJson(diagnostics.exportJson(), 'invalid' as never),
		).rejects.toThrow('import mode');
	});

	it('rejects a rename that would exceed the repository byte budget', async () => {
		const diagnostics = createRestorePointsPlugin({
			maxTotalBytes: 300,
			sources: [
				{
					id: 'state',
					title: 'State',
					capture: () => 1,
					restore: () => {},
				},
			],
		});
		const point = await diagnostics.capture('Small');

		await expect(diagnostics.rename(point.id, 'x'.repeat(256))).rejects.toThrow(
			'repository byte limit',
		);
		expect(diagnostics.getPoints()[0]?.label).toBe('Small');
	});

	it('preflights every selected source before executing any mutation', async () => {
		let first = 1;
		let second = 1;
		const firstRestore = jest.fn((value: unknown) => {
			first = value as number;
		});
		const secondRestore = jest.fn((value: unknown) => {
			second = value as number;
		});
		const diagnostics = createRestorePointsPlugin({
			sources: [
				{
					id: 'first',
					title: 'First',
					capture: () => first,
					validate: () => {},
					restore: firstRestore,
				},
				{
					id: 'second',
					title: 'Second',
					dependencies: ['first'],
					capture: () => second,
					validate: () => {
						throw new Error('unsupported snapshot');
					},
					restore: secondRestore,
				},
			],
		});
		const point = await diagnostics.capture();
		first = 2;
		second = 2;

		const receipt = await diagnostics.restoreDetailed(point.id, {
			sourceIds: ['second'],
		});

		expect(receipt.status).toBe('preflight-failed');
		expect(receipt.sourceResults.map((result) => result.sourceId)).toEqual([
			'first',
			'second',
		]);
		expect(firstRestore).not.toHaveBeenCalled();
		expect(secondRestore).not.toHaveBeenCalled();
		expect({ first, second }).toEqual({ first: 2, second: 2 });
	});

	it('rejects duplicate or oversized selective restore requests before mutation', async () => {
		const restore = jest.fn();
		const diagnostics = createRestorePointsPlugin({
			sources: [{ id: 'state', title: 'State', capture: () => 1, restore }],
		});
		const point = await diagnostics.capture();

		const duplicate = await diagnostics.restoreDetailed(point.id, {
			sourceIds: ['state', 'state'],
		});
		const oversized = await diagnostics.restoreDetailed(point.id, {
			sourceIds: Array.from({ length: 51 }, (_, index) => `state-${index}`),
		});

		expect(duplicate).toMatchObject({
			status: 'preflight-failed',
			error: expect.stringContaining('Duplicate restore source selection'),
		});
		expect(oversized).toMatchObject({
			status: 'preflight-failed',
			error: expect.stringContaining('between 1 and 50'),
		});
		expect(restore).not.toHaveBeenCalled();
	});

	it('reports reverse rollback results for a partially applied transaction', async () => {
		let first = 1;
		let second = 1;
		const order: string[] = [];
		const diagnostics = createRestorePointsPlugin({
			sources: [
				{
					id: 'first',
					title: 'First',
					capture: () => first,
					restore: (value) => {
						order.push(`first:${String(value)}`);
						first = value as number;
					},
				},
				{
					id: 'second',
					title: 'Second',
					dependencies: ['first'],
					capture: () => second,
					restore: (value) => {
						order.push(`second:${String(value)}`);
						if (value === 1) throw new Error('apply failed after side effect');
						second = value as number;
					},
				},
			],
		});
		const point = await diagnostics.capture();
		first = 2;
		second = 2;

		const receipt = await diagnostics.restoreDetailed(point.id);

		expect(receipt.status).toBe('rolled-back');
		expect(receipt.sourceResults).toEqual([
			expect.objectContaining({
				sourceId: 'first',
				apply: 'succeeded',
				rollback: 'succeeded',
			}),
			expect.objectContaining({
				sourceId: 'second',
				apply: 'failed',
				rollback: 'succeeded',
			}),
		]);
		expect(order).toEqual(['first:1', 'second:1', 'second:2', 'first:2']);
		expect({ first, second }).toEqual({ first: 2, second: 2 });
	});

	it('resets only explicit baseline sources and rolls them back on failure', async () => {
		let resettable = 1;
		let readOnly = 1;
		let failing = 1;
		const diagnostics = createRestorePointsPlugin({
			sources: [
				{
					id: 'resettable',
					title: 'Resettable',
					capture: () => resettable,
					restore: (value) => {
						resettable = value as number;
					},
					resetToBaseline: () => {
						resettable = 0;
					},
				},
				{
					id: 'read-only',
					title: 'Read only',
					capture: () => readOnly,
					restore: (value) => {
						readOnly = value as number;
					},
				},
				{
					id: 'failing',
					title: 'Failing',
					capture: () => failing,
					restore: (value) => {
						failing = value as number;
					},
					resetToBaseline: () => {
						failing = 0;
						throw new Error('baseline rejected');
					},
				},
			],
		});

		const receipt = await diagnostics.resetToBaseline();

		expect(receipt.status).toBe('rolled-back');
		expect(receipt.sourceResults.map((result) => result.sourceId)).toEqual([
			'resettable',
			'failing',
		]);
		expect({ resettable, readOnly, failing }).toEqual({
			resettable: 1,
			readOnly: 1,
			failing: 1,
		});
	});

	it('needs attention when a failed restore cannot be rolled back', async () => {
		let steady = 1;
		let fragile = 1;
		const diagnostics = createRestorePointsPlugin({
			sources: [
				{
					id: 'steady',
					title: 'Steady',
					capture: () => steady,
					restore: (value) => {
						steady = value as number;
					},
				},
				{
					id: 'fragile',
					title: 'Fragile',
					capture: () => fragile,
					restore: (value) => {
						throw new Error(`cannot restore ${String(value)}`);
					},
				},
			],
		});
		const point = await diagnostics.capture('Before');
		steady = 2;
		fragile = 2;

		const receipt = await diagnostics.restoreDetailed(point.id);

		expect(Object.keys(receipt)).toEqual([
			'id',
			'pointId',
			'pointLabel',
			'startedAt',
			'completedAt',
			'status',
			'sourceResults',
			'error',
		]);
		expect(receipt).toMatchObject({
			pointId: point.id,
			pointLabel: 'Before',
			status: 'needs-attention',
			error: 'cannot restore 1',
		});
		expect(receipt.sourceResults).toEqual([
			{
				sourceId: 'steady',
				sourceTitle: 'Steady',
				preflight: 'passed',
				apply: 'succeeded',
				rollback: 'succeeded',
			},
			{
				sourceId: 'fragile',
				sourceTitle: 'Fragile',
				preflight: 'passed',
				apply: 'failed',
				rollback: 'failed',
				error: 'cannot restore 1',
				rollbackError: 'cannot restore 2',
			},
		]);
		expect({ steady, fragile }).toEqual({ steady: 2, fragile: 2 });
		await expect(diagnostics.restore(point.id)).rejects.toThrow(
			'Restore failed and rollback needs attention. Fragile: cannot restore 2',
		);
	});

	it('needs attention when a failed reset to baseline cannot be rolled back', async () => {
		let steady = 1;
		let fragile = 1;
		const diagnostics = createRestorePointsPlugin({
			sources: [
				{
					id: 'steady',
					title: 'Steady',
					capture: () => steady,
					restore: (value) => {
						steady = value as number;
					},
					resetToBaseline: () => {
						steady = 0;
					},
				},
				{
					id: 'fragile',
					title: 'Fragile',
					capture: () => fragile,
					restore: (value) => {
						throw new Error(`cannot restore ${String(value)}`);
					},
					resetToBaseline: () => {
						fragile = 0;
						throw new Error('baseline rejected');
					},
				},
			],
		});

		const receipt = await diagnostics.resetToBaseline();

		expect(Object.keys(receipt)).toEqual([
			'id',
			'pointId',
			'pointLabel',
			'startedAt',
			'completedAt',
			'status',
			'sourceResults',
			'error',
		]);
		expect(receipt).toMatchObject({
			pointId: 'baseline',
			pointLabel: 'Reset to baseline',
			status: 'needs-attention',
			error: 'baseline rejected',
		});
		expect(receipt.sourceResults).toEqual([
			{
				sourceId: 'steady',
				sourceTitle: 'Steady',
				preflight: 'passed',
				apply: 'succeeded',
				rollback: 'succeeded',
			},
			{
				sourceId: 'fragile',
				sourceTitle: 'Fragile',
				preflight: 'passed',
				apply: 'failed',
				rollback: 'failed',
				error: 'baseline rejected',
				rollbackError: 'cannot restore 1',
			},
		]);
		expect({ steady, fragile }).toEqual({ steady: 1, fragile: 0 });
	});
});

describe('canonicalizeRestoreValue', () => {
	it('rejects non-JSON and oversized snapshots', () => {
		expect(() => canonicalizeRestoreValue(undefined, 100)).toThrow(
			'non-JSON undefined',
		);
		expect(() => canonicalizeRestoreValue({ value: 'too large' }, 4)).toThrow(
			'per-source limit',
		);
		expect(() =>
			canonicalizeRestoreValue({ nested: undefined }, 1_000),
		).toThrow('non-JSON undefined');
		expect(() =>
			canonicalizeRestoreValue({ value: Number.NaN }, 1_000),
		).toThrow('finite JSON number');
		expect(() => canonicalizeRestoreValue({ date: new Date() }, 1_000)).toThrow(
			'plain JSON object',
		);
		expect(() => canonicalizeRestoreValue({ map: new Map() }, 1_000)).toThrow(
			'plain JSON object',
		);
		const circular: { self?: unknown } = {};
		circular.self = circular;
		expect(() => canonicalizeRestoreValue(circular, 1_000)).toThrow(
			'circular or shared reference',
		);
	});

	it('keeps exact JSON for restore while redacting its display preview', () => {
		const canonical = canonicalizeRestoreValue(
			{ password: 'private-value', ready: true },
			1_000,
		);

		expect(canonical.json).toContain('private-value');
		expect(canonical.preview).toContain('[REDACTED]');
		expect(canonical.preview).not.toContain('private-value');
	});

	it('rejects array accessors without invoking them', () => {
		const value: unknown[] = [];
		Object.defineProperty(value, '0', {
			enumerable: true,
			get() {
				throw new Error('getter must not run');
			},
		});
		value.length = 1;

		expect(() => canonicalizeRestoreValue(value, 1_000)).toThrow(
			'is an accessor',
		);
	});

	it('serializes from descriptors without invoking proxy property reads', () => {
		const get = jest.fn(() => {
			throw new Error('property reads must not run');
		});
		const value = new Proxy({ ready: true }, { get });

		expect(canonicalizeRestoreValue(value, 1_000).json).toBe('{"ready":true}');
		expect(get).not.toHaveBeenCalled();
	});

	it('bounds structural work before JSON serialization', () => {
		let value: Record<string, unknown> = {};
		for (let index = 0; index < 70; index += 1) {
			value = { nested: value };
		}

		expect(() => canonicalizeRestoreValue(value, 1_000_000)).toThrow(
			'depth limit',
		);
		expect(() =>
			canonicalizeRestoreValue(new Array(100_001), 1_000_000),
		).toThrow('entry limit');
		expect(() =>
			canonicalizeRestoreValue({}, Number.POSITIVE_INFINITY),
		).toThrow('maxBytes');
	});

	it('rejects prototype-pollution keys before capture', () => {
		const value = JSON.parse('{"safe":true,"__proto__":{"polluted":true}}');

		expect(() => canonicalizeRestoreValue(value, 1_000)).toThrow(
			'not allowed in restore snapshots',
		);
	});
});

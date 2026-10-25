import {
	parsePersistedState,
	SerializedPersistenceWriter,
} from './persistence';

describe('parsePersistedState', () => {
	it('accepts a valid versioned runtime state', () => {
		expect(
			parsePersistedState(
				JSON.stringify({
					version: 1,
					presentationMode: 'window',
					restoreMode: 'window',
					launcherPosition: { x: 12, y: 24 },
					windowSize: { width: 344, height: 540 },
					pinnedPillQuickActionIds: ['state', 'source', 'state', 42],
				}),
			),
		).toEqual({
			version: 1,
			presentationMode: 'window',
			restoreMode: 'window',
			launcherPosition: { x: 12, y: 24 },
			windowSize: { width: 344, height: 540 },
			pinnedPillQuickActionIds: ['state', 'source'],
		});
	});

	it('ignores invalid window dimensions without discarding other state', () => {
		expect(
			parsePersistedState(
				JSON.stringify({
					version: 1,
					presentationMode: 'window',
					restoreMode: 'window',
					windowSize: { width: -20, height: Number.NaN },
				}),
			),
		).toEqual({
			version: 1,
			presentationMode: 'window',
			restoreMode: 'window',
		});
	});

	it('rejects malformed and unsupported state', () => {
		expect(parsePersistedState('not-json')).toBeNull();
		expect(
			parsePersistedState(
				JSON.stringify({
					version: 2,
					presentationMode: 'sheet',
					restoreMode: 'sheet',
				}),
			),
		).toBeNull();
		expect(parsePersistedState('x'.repeat(64 * 1024 + 1))).toBeNull();
	});

	it('bounds restored coordinates and pinned plugin identifiers', () => {
		const pinned = Array.from({ length: 40 }, (_, index) => `plugin-${index}`);
		const state = parsePersistedState(
			JSON.stringify({
				version: 1,
				presentationMode: 'pill',
				restoreMode: 'sheet',
				launcherPosition: { x: 10_000_000, y: 0 },
				pinnedPillQuickActionIds: [' spaced ', 'x'.repeat(257), ...pinned],
			}),
		);

		expect(state?.launcherPosition).toBeUndefined();
		expect(state?.pinnedPillQuickActionIds).toEqual(pinned.slice(0, 32));
	});
});

describe('SerializedPersistenceWriter', () => {
	it('preserves write order when storage resolves out of order', async () => {
		let resolveFirst: (() => void) | undefined;
		const writes: string[] = [];
		const storage = {
			setItem: jest.fn((_key: string, value: string) => {
				writes.push(value);
				if (value === 'first') {
					return new Promise<void>((resolve) => {
						resolveFirst = resolve;
					});
				}
			}),
		};
		const writer = new SerializedPersistenceWriter();
		const first = writer.write(storage, 'key', 'first');
		const second = writer.write(storage, 'key', 'second');
		await Promise.resolve();
		expect(writes).toEqual(['first']);
		resolveFirst?.();
		await Promise.all([first, second]);
		expect(writes).toEqual(['first', 'second']);
	});

	it('does not let one target block writes to another target', async () => {
		let resolveBlocked: (() => void) | undefined;
		const blockedStorage = {
			setItem: jest.fn(
				() =>
					new Promise<void>((resolve) => {
						resolveBlocked = resolve;
					}),
			),
		};
		const replacementStorage = { setItem: jest.fn() };
		const writer = new SerializedPersistenceWriter();

		const blocked = writer.write(blockedStorage, 'state', 'old');
		await Promise.resolve();
		await writer.write(replacementStorage, 'state', 'new');

		expect(replacementStorage.setItem).toHaveBeenCalledWith('state', 'new');
		resolveBlocked?.();
		await blocked;
	});
});

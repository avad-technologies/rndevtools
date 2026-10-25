import { DevtoolsEventStore } from '../core/event-store';
import {
	createQuerySimulationController,
	type QuerySimulationLease,
} from './query-simulation';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}

describe('createQuerySimulationController', () => {
	it('advertises unsupported states with concrete reasons', async () => {
		const controller = createQuerySimulationController([
			{
				id: 'all',
				label: 'All queries',
				operations: { offline: () => ({ release: jest.fn() }) },
				unsupportedReasons: { loading: 'No loading adapter is installed.' },
			},
		]);

		expect(controller.getSnapshot().families[0]?.modes).toEqual(
			expect.arrayContaining([
				{
					mode: 'loading',
					supported: false,
					reason: 'No loading adapter is installed.',
				},
				{ mode: 'offline', supported: true },
			]),
		);
		await expect(controller.apply('all', 'loading')).rejects.toThrow(
			'No loading adapter',
		);
	});

	it('applies, publishes, clears by exact receipt, and records events', async () => {
		const release = jest.fn();
		const eventStore = new DevtoolsEventStore({
			maxEvents: 10,
			maxBytes: 64 * 1024,
			now: () => 1_000,
		});
		const controller = createQuerySimulationController(
			[
				{
					id: 'all',
					label: 'All queries',
					operations: { offline: () => ({ release }) },
				},
			],
			{ eventStore, now: () => 900 },
		);
		const listener = jest.fn();
		controller.subscribe(listener);

		const active = await controller.apply('all', 'offline');
		expect(active).toEqual({
			familyId: 'all',
			familyLabel: 'All queries',
			mode: 'offline',
			receiptId: 'query-simulation-1',
			startedAt: 900,
		});
		expect(Object.isFrozen(active)).toBe(true);
		expect(controller.getSnapshot().active).toEqual(active);
		await expect(controller.clear('query-simulation-stale')).rejects.toThrow(
			'changed',
		);
		expect(release).not.toHaveBeenCalled();
		await controller.clear(active.receiptId);
		expect(release).toHaveBeenCalledTimes(1);
		expect(controller.getSnapshot().active).toBeUndefined();
		expect(listener).toHaveBeenCalledTimes(2);
		expect(eventStore.getEvents().map((event) => event.kind)).toEqual([
			'simulation-applied',
			'simulation-cleared',
		]);
	});

	it('serializes mutations and releases the previous state before switching', async () => {
		const firstRelease = deferred<void>();
		const firstReleaseStarted = jest.fn();
		const secondApply = jest.fn(() => ({ release: jest.fn() }));
		const controller = createQuerySimulationController([
			{
				id: 'all',
				label: 'All queries',
				operations: {
					offline: () => ({
						release: () => {
							firstReleaseStarted();
							return firstRelease.promise;
						},
					}),
					paused: secondApply,
				},
			},
		]);
		await controller.apply('all', 'offline');

		const switching = controller.apply('all', 'paused');
		const queuedClear = controller.clear();
		await Promise.resolve();
		expect(firstReleaseStarted).toHaveBeenCalledTimes(1);
		expect(secondApply).not.toHaveBeenCalled();
		firstRelease.resolve();
		await switching;
		await queuedClear;
		expect(secondApply).toHaveBeenCalledTimes(1);
		expect(controller.getSnapshot().active).toBeUndefined();
	});

	it('does not invoke configuration or lease accessors', async () => {
		const familyGetter = jest.fn(() => 'unsafe');
		const family = { label: 'All queries' } as Record<string, unknown>;
		Object.defineProperty(family, 'id', {
			enumerable: true,
			get: familyGetter,
		});
		expect(() => createQuerySimulationController([family as never])).toThrow(
			'data field',
		);
		expect(familyGetter).not.toHaveBeenCalled();

		const leaseGetter = jest.fn(() => jest.fn());
		const controller = createQuerySimulationController([
			{
				id: 'all',
				label: 'All queries',
				operations: {
					offline: () =>
						Object.defineProperty({}, 'release', {
							enumerable: true,
							get: leaseGetter,
						}) as QuerySimulationLease,
				},
			},
		]);
		await expect(controller.apply('all', 'offline')).rejects.toThrow(
			'data field',
		);
		expect(leaseGetter).not.toHaveBeenCalled();
	});

	it('rejects malformed bounds, clocks, and non-reversible leases', async () => {
		expect(() => createQuerySimulationController([])).toThrow(
			'between 1 and 50',
		);
		expect(() =>
			createQuerySimulationController([
				{ id: 'duplicate', label: 'One' },
				{ id: 'duplicate', label: 'Two' },
			]),
		).toThrow('duplicate');

		const invalidClock = createQuerySimulationController(
			[
				{
					id: 'all',
					label: 'All queries',
					operations: { offline: () => ({ release: jest.fn() }) },
				},
			],
			{ now: () => Number.NaN },
		);
		await expect(invalidClock.apply('all', 'offline')).rejects.toThrow('clock');

		const invalidLease = createQuerySimulationController([
			{
				id: 'all',
				label: 'All queries',
				operations: {
					offline: () => ({}) as QuerySimulationLease,
				},
			},
		]);
		await expect(invalidLease.apply('all', 'offline')).rejects.toThrow(
			'reversible cleanup',
		);
	});
});

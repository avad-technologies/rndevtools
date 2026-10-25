import { BoundedEventStore, ExternalStore } from './external-store';

describe('BoundedEventStore', () => {
	it('evicts the oldest events by count', () => {
		const store = new BoundedEventStore<number>({
			maxEvents: 2,
			maxBytes: 100,
			estimateBytes: () => 1,
		});

		store.append(1);
		store.append(2);
		store.append(3);

		expect(store.getSnapshot()).toEqual([2, 3]);
	});

	it('replaces and upserts events while preserving bounds', () => {
		const store = new BoundedEventStore<{ id: number; value: string }>({
			maxEvents: 2,
			maxBytes: 20,
			estimateBytes: (event) => event.value.length,
		});
		store.append({ id: 1, value: 'one' });
		expect(
			store.replace((event) => event.id === 1, { id: 1, value: 'done' }),
		).toBe(true);
		store.upsert((event) => event.id === 2, { id: 2, value: 'two' });

		expect(store.getSnapshot()).toEqual([
			{ id: 1, value: 'done' },
			{ id: 2, value: 'two' },
		]);
	});

	it('evicts the oldest events by estimated bytes', () => {
		const store = new BoundedEventStore<string>({
			maxEvents: 10,
			maxBytes: 5,
			estimateBytes: (event) => event.length,
		});

		store.append('abc');
		store.append('def');

		expect(store.getSnapshot()).toEqual(['def']);
	});

	it('does not retain an event larger than the byte budget', () => {
		const store = new BoundedEventStore<string>({
			maxEvents: 10,
			maxBytes: 2,
			estimateBytes: (event) => event.length,
		});

		store.append('oversized');

		expect(store.getSnapshot()).toEqual([]);
	});

	it('rejects invalid bounds and non-finite event estimates', () => {
		expect(
			() =>
				new BoundedEventStore({
					maxEvents: 0,
					maxBytes: 10,
					estimateBytes: () => 1,
				}),
		).toThrow('maxEvents');
		const store = new BoundedEventStore<number>({
			maxEvents: 2,
			maxBytes: 10,
			estimateBytes: () => Number.NaN,
		});
		store.append(1);
		expect(store.getSnapshot()).toEqual([]);
		expect(store.getEstimatedBytes()).toBe(0);
	});

	it('contains estimator and observer failures', () => {
		const store = new BoundedEventStore<number>({
			maxEvents: 2,
			maxBytes: 10,
			estimateBytes: () => {
				throw new Error('estimate failed');
			},
		});
		const healthyListener = jest.fn();
		store.subscribe(() => {
			throw new Error('observer failed');
		});
		store.subscribe(healthyListener);

		expect(() => store.append(1)).not.toThrow();
		expect(store.getSnapshot()).toEqual([]);

		const external = new ExternalStore(0);
		external.subscribe(() => {
			throw new Error('observer failed');
		});
		external.subscribe(healthyListener);
		expect(() => external.set(1)).not.toThrow();
		expect(external.getSnapshot()).toBe(1);
		expect(healthyListener).toHaveBeenCalledTimes(1);
	});

	it('defers listeners added during an active notification', () => {
		const store = new ExternalStore(0);
		const lateListener = jest.fn();
		store.subscribe(() => store.subscribe(lateListener));

		store.set(1);
		expect(lateListener).not.toHaveBeenCalled();
		store.set(2);
		expect(lateListener).toHaveBeenCalledTimes(1);
	});
});

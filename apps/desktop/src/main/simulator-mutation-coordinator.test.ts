import { describe, expect, it, vi } from 'vitest';
import { SimulatorMutationCoordinator } from './simulator-mutation-coordinator';

const UDID = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
const SECOND_UDID = '11111111-2222-3333-4444-555555555555';

function deferred() {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

describe('SimulatorMutationCoordinator', () => {
	it('serializes the same UDID case-insensitively and permits validated reentry', async () => {
		const coordinator = new SimulatorMutationCoordinator();
		const firstEntered = deferred();
		const releaseFirst = deferred();
		const order: string[] = [];
		const first = coordinator.runExclusive(
			UDID,
			new AbortController().signal,
			async (lease) => {
				order.push('first');
				firstEntered.resolve();
				await coordinator.runExclusive(
					UDID.toLowerCase(),
					new AbortController().signal,
					async () => {
						order.push('reentrant');
					},
					lease
				);
				await releaseFirst.promise;
			}
		);
		await firstEntered.promise;
		const second = coordinator.runExclusive(
			UDID.toLowerCase(),
			new AbortController().signal,
			async () => {
				order.push('second');
			}
		);
		await Promise.resolve();
		expect(order).toEqual(['first', 'reentrant']);
		releaseFirst.resolve();
		await Promise.all([first, second]);
		expect(order).toEqual(['first', 'reentrant', 'second']);
	});

	it('allows independent simulator targets to run concurrently', async () => {
		const coordinator = new SimulatorMutationCoordinator();
		const release = deferred();
		const entered = vi.fn();
		const run = (udid: string) =>
			coordinator.runExclusive(udid, new AbortController().signal, async () => {
				entered(udid);
				await release.promise;
			});
		const tasks = [run(UDID), run(SECOND_UDID)];
		await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(2));
		release.resolve();
		await Promise.all(tasks);
	});

	it('tries a lease without ever waiting: refused while held, taken once free', async () => {
		const coordinator = new SimulatorMutationCoordinator();
		const signal = new AbortController().signal;
		const entered = deferred();
		const release = deferred();
		const operation = vi.fn(async () => 'ran');
		const held = coordinator.runExclusive(UDID, signal, async () => {
			entered.resolve();
			// The holder itself trying again is refused, never a wait on itself.
			await expect(
				coordinator.tryRunExclusive(UDID, signal, operation)
			).resolves.toEqual({ acquired: false });
			await release.promise;
		});
		await entered.promise;
		await expect(
			coordinator.tryRunExclusive(UDID.toLowerCase(), signal, operation)
		).resolves.toEqual({ acquired: false });
		expect(operation).not.toHaveBeenCalled();
		await expect(
			coordinator.tryRunExclusive(SECOND_UDID, signal, operation)
		).resolves.toEqual({ acquired: true, value: 'ran' });

		release.resolve();
		await held;
		await new Promise((resolve) => setTimeout(resolve, 0));
		await expect(
			coordinator.tryRunExclusive(UDID, signal, operation)
		).resolves.toEqual({ acquired: true, value: 'ran' });
		await expect(
			coordinator.tryRunExclusive('not-a-udid', signal, operation)
		).rejects.toThrow('exact UDID');
	});

	it('holds a lease it took against claimants that come later', async () => {
		const coordinator = new SimulatorMutationCoordinator();
		const signal = new AbortController().signal;
		const entered = deferred();
		const release = deferred();
		const tried = coordinator.tryRunExclusive(UDID, signal, async () => {
			entered.resolve();
			await release.promise;
		});
		const later = vi.fn(async () => undefined);
		const queued = coordinator.runExclusive(UDID, signal, later);
		await entered.promise;
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(later).not.toHaveBeenCalled();
		release.resolve();
		await Promise.all([tried, queued]);
		expect(later).toHaveBeenCalledOnce();
	});

	it('cancels a queued claimant promptly without allowing later work to overtake', async () => {
		const coordinator = new SimulatorMutationCoordinator();
		const firstEntered = deferred();
		const releaseFirst = deferred();
		const first = coordinator.runExclusive(
			UDID,
			new AbortController().signal,
			async () => {
				firstEntered.resolve();
				await releaseFirst.promise;
			}
		);
		await firstEntered.promise;

		const queuedController = new AbortController();
		const queuedOperation = vi.fn(async () => undefined);
		const queued = coordinator.runExclusive(
			UDID,
			queuedController.signal,
			queuedOperation
		);
		queuedController.abort(new Error('cancel queued claimant'));
		await expect(queued).rejects.toThrow('cancel queued claimant');
		expect(queuedOperation).not.toHaveBeenCalled();

		const laterOperation = vi.fn(async () => undefined);
		const later = coordinator.runExclusive(
			UDID,
			new AbortController().signal,
			laterOperation
		);
		await Promise.resolve();
		expect(laterOperation).not.toHaveBeenCalled();
		releaseFirst.resolve();
		await Promise.all([first, later]);
		expect(laterOperation).toHaveBeenCalledOnce();
	});
});

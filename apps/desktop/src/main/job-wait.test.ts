import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForJob } from './job-wait';

function fakeService(status: string) {
	let state = { jobs: [{ id: 'job-1', status }] };
	const listeners = new Set<(value: typeof state) => void>();
	const cancelled: string[] = [];
	return {
		cancelled,
		listeners,
		publish(next: string) {
			state = { jobs: [{ id: 'job-1', status: next }] };
			for (const listener of listeners) listener(state);
		},
		service: {
			getState: () => state,
			subscribe: (listener: (value: typeof state) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			cancelJob: (jobId: string) => {
				cancelled.push(jobId);
				return true;
			},
		},
	};
}

const abortError = () => new Error('Cancelled.');

describe('waitForJob', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('resolves with a job that has ended, now or once a later state shows it', async () => {
		const done = fakeService('complete');
		await expect(
			waitForJob(done.service, 'job-1', AbortSignal.abort(), {
				cancel: true,
				abortError,
			})
		).resolves.toEqual({ id: 'job-1', status: 'complete' });
		expect(done.cancelled).toEqual([]);

		const running = fakeService('running');
		const waited = waitForJob(
			running.service,
			'job-1',
			new AbortController().signal,
			{ abortError }
		);
		running.publish('needs-attention');
		await expect(waited).resolves.toEqual({
			id: 'job-1',
			status: 'needs-attention',
		});
		expect(running.listeners.size).toBe(0);
	});

	it('rejects at once on abort, cancelling the job only when asked to', async () => {
		for (const cancel of [false, true]) {
			const running = fakeService('running');
			const controller = new AbortController();
			const waited = waitForJob(running.service, 'job-1', controller.signal, {
				cancel,
				abortError,
			});
			controller.abort();
			await expect(waited).rejects.toThrow('Cancelled.');
			expect(running.cancelled).toEqual(cancel ? ['job-1'] : []);
			expect(running.listeners.size).toBe(0);
		}
	});

	it('given settleMs, cancels and waits that long for the job to end', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const settles = fakeService('running');
		const settling = waitForJob(settles.service, 'job-1', AbortSignal.abort(), {
			cancel: true,
			settleMs: 1_000,
			abortError,
		});
		expect(settles.cancelled).toEqual(['job-1']);
		await vi.advanceTimersByTimeAsync(999);
		settles.publish('cancelled');
		await expect(settling).resolves.toEqual({
			id: 'job-1',
			status: 'cancelled',
		});

		const stuck = fakeService('running');
		const timedOut = waitForJob(stuck.service, 'job-1', AbortSignal.abort(), {
			cancel: true,
			settleMs: 1_000,
			abortError,
		});
		const rejection = expect(timedOut).rejects.toThrow('Cancelled.');
		await vi.advanceTimersByTimeAsync(1_000);
		await rejection;
		expect(stuck.listeners.size).toBe(0);
	});
});

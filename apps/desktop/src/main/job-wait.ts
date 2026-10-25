/** The statuses a Simulator or Slimming job ends in; it never leaves one. */
export const TERMINAL_JOB_STATUSES = new Set([
	'complete',
	'failed',
	'needs-attention',
	'cancelled',
]);

type Job = { id: string; status: string };

type JobService<T extends Job> = {
	getState: () => { jobs: readonly T[] };
	subscribe: (listener: (state: { jobs: readonly T[] }) => void) => () => void;
	cancelJob: (jobId: string) => boolean;
};

/**
 * Resolves with job `jobId` once the service's state, now or as published
 * later, shows it in a terminal status. If `signal` aborts first, the job is
 * cancelled when `cancel` is set, and the wait rejects with `abortError()`:
 * at once, or, given `settleMs`, only if the job has not ended by then.
 */
export function waitForJob<T extends Job>(
	service: JobService<T>,
	jobId: string,
	signal: AbortSignal,
	{
		abortError,
		cancel = false,
		settleMs,
	}: { abortError: () => Error; cancel?: boolean; settleMs?: number }
): Promise<T> {
	return new Promise((resolve, reject) => {
		let unsubscribe: () => void = () => undefined;
		let settled = false;
		let settleTimer: NodeJS.Timeout | undefined;
		const finish = (state: { jobs: readonly T[] }) => {
			const job = state.jobs.find((candidate) => candidate.id === jobId);
			if (!job || !TERMINAL_JOB_STATUSES.has(job.status)) return;
			cleanup();
			resolve(job);
		};
		const fail = () => {
			cleanup();
			reject(abortError());
		};
		const onAbort = () => {
			if (settled || settleTimer) return;
			if (cancel) service.cancelJob(jobId);
			if (settleMs === undefined) fail();
			else settleTimer = setTimeout(fail, settleMs);
		};
		const cleanup = () => {
			settled = true;
			if (settleTimer) clearTimeout(settleTimer);
			unsubscribe();
			signal.removeEventListener('abort', onAbort);
		};
		unsubscribe = service.subscribe(finish);
		signal.addEventListener('abort', onAbort, { once: true });
		finish(service.getState());
		if (signal.aborted) onAbort();
	});
}

export type CollectorSetupScope = {
	addCleanup: (cleanup: () => void) => void;
};

function runCleanups(cleanups: readonly (() => void)[]): void {
	for (const cleanup of [...cleanups].reverse()) {
		try {
			cleanup();
		} catch {
			// Diagnostics cleanup is isolated and must continue in reverse order.
		}
	}
}

/** Creates an idempotent, ref-counted collector installer with setup rollback. */
export function createRefCountedInstaller(
	setup: (scope: CollectorSetupScope) => void,
): () => () => void {
	let references = 0;
	let activeCleanups: (() => void)[] = [];

	return () => {
		if (references === 0) {
			const pendingCleanups: (() => void)[] = [];
			try {
				setup({
					addCleanup: (cleanup) => {
						if (typeof cleanup !== 'function') {
							throw new Error('Collector cleanup must be a function.');
						}
						pendingCleanups.push(cleanup);
					},
				});
				activeCleanups = pendingCleanups;
			} catch (error) {
				runCleanups(pendingCleanups);
				throw error;
			}
		}
		references += 1;
		let referenceActive = true;
		return () => {
			if (!referenceActive) return;
			referenceActive = false;
			references = Math.max(0, references - 1);
			if (references !== 0) return;
			const cleanups = activeCleanups;
			activeCleanups = [];
			runCleanups(cleanups);
		};
	};
}

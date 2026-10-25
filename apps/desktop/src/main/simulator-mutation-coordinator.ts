import { UDID_PATTERN } from '../shared/simulator-protocol';

export type SimulatorMutationLease = Readonly<{
	simulatorUdid: string;
	owner: symbol;
}>;

export type SimulatorMutationCoordinatorPort = {
	runExclusive: <T>(
		simulatorUdid: string,
		signal: AbortSignal,
		operation: (lease: SimulatorMutationLease) => Promise<T>,
		existingLease?: SimulatorMutationLease
	) => Promise<T>;
	/**
	 * Runs `operation` under the Simulator's lease only when nobody holds it or
	 * waits for it, and otherwise resolves `{ acquired: false }` at once. For
	 * background work that must neither queue behind a foreground mutation nor
	 * wait on a caller that already holds the lease: lanes and recipes refresh
	 * SimSlim from inside their own lease.
	 */
	tryRunExclusive: <T>(
		simulatorUdid: string,
		signal: AbortSignal,
		operation: (lease: SimulatorMutationLease) => Promise<T>
	) => Promise<{ acquired: true; value: T } | { acquired: false }>;
};

/**
 * Main-process serialization boundary shared by every local service that can
 * mutate a Simulator or its associated development app. Service-local queues
 * still own their presentation ordering; this coordinator prevents those
 * otherwise-independent queues from executing against one UDID concurrently.
 */
export class SimulatorMutationCoordinator
	implements SimulatorMutationCoordinatorPort
{
	readonly #tails = new Map<string, Promise<void>>();
	readonly #activeOwners = new Set<symbol>();

	async runExclusive<T>(
		simulatorUdid: string,
		signal: AbortSignal,
		operation: (lease: SimulatorMutationLease) => Promise<T>,
		existingLease?: SimulatorMutationLease
	): Promise<T> {
		if (!UDID_PATTERN.test(simulatorUdid)) {
			throw new Error('Simulator mutation target must be an exact UDID.');
		}
		const key = simulatorUdid.toUpperCase();
		if (existingLease) {
			if (
				!this.#activeOwners.has(existingLease.owner) ||
				existingLease.simulatorUdid !== key
			) {
				throw new Error(
					'Simulator mutation lease does not match the exact target.'
				);
			}
			this.#throwIfAborted(signal);
			return operation(existingLease);
		}

		const previous = this.#tails.get(key) ?? Promise.resolve();
		let release: () => void = () => undefined;
		const turn = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.catch(() => undefined).then(() => turn);
		this.#tails.set(key, tail);
		void tail.then(() => {
			if (this.#tails.get(key) === tail) this.#tails.delete(key);
		});

		let removeAbortListener: () => void = () => undefined;
		try {
			await Promise.race([
				previous.catch(() => undefined),
				new Promise<never>((_resolve, reject) => {
					if (signal.aborted) {
						reject(this.#abortError(signal));
						return;
					}
					const onAbort = () => reject(this.#abortError(signal));
					signal.addEventListener('abort', onAbort, { once: true });
					removeAbortListener = () =>
						signal.removeEventListener('abort', onAbort);
				}),
			]);
		} catch (error) {
			release();
			throw error;
		} finally {
			removeAbortListener();
		}

		const lease: SimulatorMutationLease = Object.freeze({
			simulatorUdid: key,
			owner: Symbol(key),
		});
		this.#activeOwners.add(lease.owner);
		try {
			this.#throwIfAborted(signal);
			return await operation(lease);
		} finally {
			this.#activeOwners.delete(lease.owner);
			release();
		}
	}

	async tryRunExclusive<T>(
		simulatorUdid: string,
		signal: AbortSignal,
		operation: (lease: SimulatorMutationLease) => Promise<T>
	): Promise<{ acquired: true; value: T } | { acquired: false }> {
		if (!UDID_PATTERN.test(simulatorUdid)) {
			throw new Error('Simulator mutation target must be an exact UDID.');
		}
		// A UDID keeps its tail until its last claimant releases, so a tail means
		// the lease is held or awaited. Nothing is awaited between this check and
		// runExclusive setting the tail, so no claimant can slip in between.
		if (this.#tails.has(simulatorUdid.toUpperCase()))
			return { acquired: false };
		return {
			acquired: true,
			value: await this.runExclusive(simulatorUdid, signal, operation),
		};
	}

	#abortError(signal: AbortSignal): Error {
		return signal.reason instanceof Error
			? signal.reason
			: new Error('Simulator mutation was cancelled before execution.');
	}

	#throwIfAborted(signal: AbortSignal): void {
		if (signal.aborted) throw this.#abortError(signal);
	}
}

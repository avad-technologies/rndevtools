import { createHash } from 'node:crypto';
import { lstat, opendir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { isPathStrictlyWithin } from './bounded-read';

/**
 * Small building blocks the Supabase service runs on: bounded concurrency,
 * per-key serialization, injectable timers, and the two filesystem walks it
 * does itself (a bounded size walk and the guarded removal of a stack's
 * Storage uploads). Nothing here knows Supabase command words.
 */

// ---------------------------------------------------------------------------
// Timers

/** The timers the service schedules on; tests substitute a manual clock. */
export type SupabaseEngineTimers = Readonly<{
	setTimeout: (callback: () => void, ms: number) => unknown;
	clearTimeout: (handle: unknown) => void;
}>;

/** Real timers that never keep the app alive on their own. */
export const SUPABASE_SYSTEM_TIMERS: SupabaseEngineTimers = {
	setTimeout: (callback, ms) => {
		const timer = setTimeout(callback, Math.max(0, ms));
		timer.unref?.();
		return timer;
	},
	clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** Resolves after `ms` on the given timers; an abort resolves it early. */
export function supabaseDelay(
	timers: SupabaseEngineTimers,
	ms: number,
	signal?: AbortSignal
): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const onAbort = () => {
			timers.clearTimeout(handle);
			resolve();
		};
		const handle = timers.setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

/** Resolves with the value, or undefined after `ms`, a rejection or an abort. */
export function supabaseWithin<T>(
	timers: SupabaseEngineTimers,
	promise: Promise<T>,
	ms: number,
	signal?: AbortSignal
): Promise<T | undefined> {
	// No wait: whatever has settled by now, else undefined.
	if (ms <= 0) return Promise.race([promise, Promise.resolve(undefined)]);
	return new Promise((resolve) => {
		let done = false;
		const finish = (value: T | undefined) => {
			if (done) return;
			done = true;
			timers.clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
			resolve(value);
		};
		const onAbort = () => finish(undefined);
		const timer = timers.setTimeout(() => finish(undefined), ms);
		if (signal?.aborted) finish(undefined);
		signal?.addEventListener('abort', onAbort, { once: true });
		promise.then(finish, () => finish(undefined));
	});
}

// ---------------------------------------------------------------------------
// Concurrency

/** At most `limit` holders at a time, first come first served. */
export class SupabaseSemaphore {
	readonly #limit: number;
	#active = 0;
	readonly #waiting: (() => void)[] = [];

	constructor(limit: number) {
		this.#limit = Math.max(1, Math.floor(limit));
	}

	get active(): number {
		return this.#active;
	}

	/**
	 * Waits for a slot; the returned function gives it back (once). Undefined
	 * when `signal` aborts first, and the place in line is given up.
	 */
	async #acquire(signal?: AbortSignal): Promise<(() => void) | undefined> {
		if (signal?.aborted) return undefined;
		if (this.#active >= this.#limit) {
			const granted = await new Promise<boolean>((resolve) => {
				const onAbort = () => {
					const index = this.#waiting.indexOf(waiter);
					if (index >= 0) this.#waiting.splice(index, 1);
					resolve(false);
				};
				const waiter = () => {
					signal?.removeEventListener('abort', onAbort);
					resolve(true);
				};
				this.#waiting.push(waiter);
				signal?.addEventListener('abort', onAbort, { once: true });
			});
			if (!granted) return undefined;
		} else {
			this.#active += 1;
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			// The slot passes straight to the next in line.
			const next = this.#waiting.shift();
			if (next) next();
			else this.#active -= 1;
		};
	}

	async run<T>(task: () => Promise<T>): Promise<T> {
		const release = await this.#acquire();
		try {
			return await task();
		} finally {
			release?.();
		}
	}

	/** Like run, but answers `cancelled()` when `signal` aborts while waiting. */
	async runCancellable<T>(
		task: () => Promise<T>,
		signal: AbortSignal,
		cancelled: () => T
	): Promise<T> {
		const release = await this.#acquire(signal);
		if (!release) return cancelled();
		try {
			return await task();
		} finally {
			release();
		}
	}
}

/** Runs tasks for one key one at a time; different keys run in parallel. */
export class SupabaseKeyedLock {
	readonly #tails = new Map<string, Promise<unknown>>();

	run<T>(key: string, task: () => Promise<T>): Promise<T> {
		const previous = this.#tails.get(key) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(task);
		const tail = next.catch(() => undefined);
		this.#tails.set(key, tail);
		void tail.then(() => {
			if (this.#tails.get(key) === tail) this.#tails.delete(key);
		});
		return next;
	}

	/** Whether a task for `key` is running or queued. */
	busy(key: string): boolean {
		return this.#tails.has(key);
	}
}

/** One promise per key while it is pending; later callers share it. */
export class SupabaseSingleFlight<T> {
	readonly #flights = new Map<string, Promise<T>>();
	readonly #queued = new Map<string, Promise<T>>();

	run(key: string, task: () => Promise<T>): Promise<T> {
		const pending = this.#flights.get(key);
		if (pending) return pending;
		const flight = task().finally(() => {
			if (this.#flights.get(key) === flight) this.#flights.delete(key);
		});
		this.#flights.set(key, flight);
		return flight;
	}

	/**
	 * A flight that begins after this call. While one is pending, later
	 * callers share a single flight queued behind it, so a caller that just
	 * changed something never reads a result that began before the change.
	 */
	runFresh(key: string, task: () => Promise<T>): Promise<T> {
		const pending = this.#flights.get(key);
		if (!pending) return this.run(key, task);
		const queued = this.#queued.get(key);
		if (queued) return queued;
		const next = pending
			.then(
				() => undefined,
				() => undefined
			)
			.then(() => {
				if (this.#queued.get(key) === next) this.#queued.delete(key);
				return this.run(key, task);
			});
		this.#queued.set(key, next);
		return next;
	}

	get(key: string): Promise<T> | undefined {
		return this.#flights.get(key);
	}
}

// ---------------------------------------------------------------------------
// Small helpers

export function sha256Hex(value: string): string {
	return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** The realpath, or undefined when the path is missing or unreadable. */
export async function supabaseRealpath(
	target: string
): Promise<string | undefined> {
	try {
		return await realpath(target);
	} catch {
		return undefined;
	}
}

/**
 * Whether `pid` names a live process this user may signal. EPERM means it
 * belongs to someone else, so it is never a child this desktop started.
 */
export function supabaseProcessAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Whether text holds a C0 or C1 control character (or DEL). */
export function hasSupabaseControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
	}
	return false;
}

/** Single-quotes a value for a POSIX shell. */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// Filesystem walks

export type SupabaseDirectorySize = Readonly<{
	bytes: number;
	/** The walk stopped at its entry cap or deadline; `bytes` is a floor. */
	partial: boolean;
}>;

/**
 * Sums the sizes of regular files under `root` without following symlinks,
 * visiting at most `maxEntries` entries within `deadlineMs`. Undefined when
 * the root is missing or not a directory.
 */
export async function measureSupabaseDirectory(
	root: string,
	options: Readonly<{
		maxEntries?: number;
		deadlineMs?: number;
		now?: () => number;
	}> = {}
): Promise<SupabaseDirectorySize | undefined> {
	const now = options.now ?? Date.now;
	const maxEntries = options.maxEntries ?? 50_000;
	const deadline = now() + (options.deadlineMs ?? 2_000);
	try {
		const info = await lstat(root);
		if (!info.isDirectory()) return undefined;
	} catch {
		return undefined;
	}
	let bytes = 0;
	let entries = 0;
	const pending = [root];
	while (pending.length > 0) {
		const directory = pending.pop() as string;
		let handle: Awaited<ReturnType<typeof opendir>>;
		try {
			handle = await opendir(directory);
		} catch {
			continue;
		}
		try {
			for await (const entry of handle) {
				entries += 1;
				if (entries > maxEntries || now() > deadline) {
					return { bytes, partial: true };
				}
				const child = path.join(directory, entry.name);
				if (entry.isDirectory()) {
					pending.push(child);
				} else if (entry.isFile()) {
					try {
						bytes += (await lstat(child)).size;
					} catch {
						// Gone while walking.
					}
				}
			}
		} catch {
			// An unreadable directory counts as empty.
		}
	}
	return { bytes, partial: false };
}

/** Where a stack's Storage uploads live inside its project. */
export function supabaseUploadsPath(
	projectRoot: string,
	stackId: string
): string {
	return path.join(projectRoot, 'supabase', '.temp', 'stack-uploads', stackId);
}

export type SupabaseUploadsRemoval =
	| Readonly<{ removed: true }>
	| Readonly<{ removed: false; reason: 'missing' | 'unsafe' | 'failed' }>;

/**
 * Deletes `<projectRoot>/supabase/.temp/stack-uploads/<id>` and nothing else:
 * the id must be a full 64-hex stack id, every path component from the
 * project root down must be a real directory (no symlinks), and the folder's
 * realpath must sit inside the project's realpath. The CLI never removes
 * uploads, so this is the one deletion the desktop does itself, and only
 * when the operator ticked the box in the destroy dialog.
 */
export async function deleteSupabaseUploads(
	projectRoot: string,
	stackId: string
): Promise<SupabaseUploadsRemoval> {
	if (!/^[0-9a-f]{64}$/.test(stackId) || !path.isAbsolute(projectRoot)) {
		return { removed: false, reason: 'unsafe' };
	}
	const realRoot = await supabaseRealpath(projectRoot);
	if (realRoot === undefined) return { removed: false, reason: 'missing' };
	let current = realRoot;
	for (const segment of ['supabase', '.temp', 'stack-uploads', stackId]) {
		current = path.join(current, segment);
		let info: Awaited<ReturnType<typeof lstat>>;
		try {
			info = await lstat(current);
		} catch {
			return { removed: false, reason: 'missing' };
		}
		if (info.isSymbolicLink() || !info.isDirectory()) {
			return { removed: false, reason: 'unsafe' };
		}
	}
	const realUploads = await supabaseRealpath(current);
	if (
		realUploads === undefined ||
		realUploads !== current ||
		!isPathStrictlyWithin(realRoot, realUploads) ||
		path.basename(realUploads) !== stackId
	) {
		return { removed: false, reason: 'unsafe' };
	}
	try {
		// rm never follows symlinks inside the tree; it unlinks them.
		await rm(realUploads, { recursive: true, force: false });
		return { removed: true };
	} catch {
		return { removed: false, reason: 'failed' };
	}
}

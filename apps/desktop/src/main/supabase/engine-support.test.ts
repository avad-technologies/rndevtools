import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManualClock } from './engine.test-support';
import {
	deleteSupabaseUploads,
	hasSupabaseControlCharacters,
	measureSupabaseDirectory,
	SupabaseKeyedLock,
	SupabaseSemaphore,
	SupabaseSingleFlight,
	shellQuote,
	supabaseDelay,
	supabaseProcessAlive,
	supabaseUploadsPath,
} from './engine-support';

const ID = 'a'.repeat(64);
let base = '';

beforeEach(async () => {
	base = await realpath(
		await mkdtemp(path.join(tmpdir(), 'rndevtools-supabase-support-'))
	);
});

afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

function deferred() {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe('SupabaseSemaphore', () => {
	it('lets at most `limit` tasks run, first come first served', async () => {
		const gate = new SupabaseSemaphore(2);
		const order: string[] = [];
		const blocks = [deferred(), deferred(), deferred()];
		const runs = ['a', 'b', 'c'].map((name, index) =>
			gate.run(async () => {
				order.push(`start ${name}`);
				await blocks[index]?.promise;
				order.push(`end ${name}`);
			})
		);
		await Promise.resolve();
		await Promise.resolve();
		expect(gate.active).toBe(2);
		expect(order).toEqual(['start a', 'start b']);
		blocks[0]?.resolve();
		await runs[0];
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(order).toContain('start c');
		blocks[1]?.resolve();
		blocks[2]?.resolve();
		await Promise.all(runs);
		expect(gate.active).toBe(0);
	});

	it('gives up a place in line when its signal aborts', async () => {
		const gate = new SupabaseSemaphore(1);
		const block = deferred();
		const holder = gate.run(() => block.promise);
		const controller = new AbortController();
		let ran = false;
		const waiting = gate.runCancellable(
			async () => {
				ran = true;
				return 'ran';
			},
			controller.signal,
			() => 'cancelled'
		);
		controller.abort();
		await expect(waiting).resolves.toBe('cancelled');
		block.resolve();
		await holder;
		expect(ran).toBe(false);
		expect(gate.active).toBe(0);
		await expect(gate.run(async () => 'next')).resolves.toBe('next');
	});
});

describe('SupabaseKeyedLock and SupabaseSingleFlight', () => {
	it('serializes one key and runs other keys alongside', async () => {
		const lock = new SupabaseKeyedLock();
		const order: string[] = [];
		const block = deferred();
		const first = lock.run('a', async () => {
			order.push('a1');
			await block.promise;
			order.push('a1 done');
		});
		const second = lock.run('a', async () => {
			order.push('a2');
		});
		const other = lock.run('b', async () => {
			order.push('b');
		});
		await other;
		expect(order).toEqual(['a1', 'b']);
		expect(lock.busy('a')).toBe(true);
		block.resolve();
		await Promise.all([first, second]);
		expect(order).toEqual(['a1', 'b', 'a1 done', 'a2']);
		// A failed task does not wedge the key.
		await expect(
			lock.run('a', async () => {
				throw new Error('boom');
			})
		).rejects.toThrow('boom');
		await expect(lock.run('a', async () => 'after')).resolves.toBe('after');
	});

	it('shares one pending promise per key', async () => {
		const flights = new SupabaseSingleFlight<number>();
		let calls = 0;
		const block = deferred();
		const task = async () => {
			calls += 1;
			await block.promise;
			return calls;
		};
		const one = flights.run('list', task);
		const two = flights.run('list', task);
		expect(flights.get('list')).toBe(one);
		block.resolve();
		await expect(Promise.all([one, two])).resolves.toEqual([1, 1]);
		await Promise.resolve();
		expect(flights.get('list')).toBeUndefined();
	});

	it('queues one fresh flight behind a pending one', async () => {
		const flights = new SupabaseSingleFlight<number>();
		let calls = 0;
		const blocks = [deferred(), deferred()];
		const task = async () => {
			calls += 1;
			const call = calls;
			await blocks[call - 1]?.promise;
			return call;
		};
		const stale = flights.run('list', task);
		const fresh = flights.runFresh('list', task);
		const joined = flights.runFresh('list', task);
		expect(joined).toBe(fresh);
		blocks[0]?.resolve();
		await expect(stale).resolves.toBe(1);
		blocks[1]?.resolve();
		await expect(Promise.all([fresh, joined])).resolves.toEqual([2, 2]);
		// With nothing pending, a fresh flight is an ordinary one.
		await expect(flights.runFresh('list', async () => 7)).resolves.toBe(7);
		// A failed flight still lets the queued one run.
		const failing = flights.run('list', async () => {
			throw new Error('boom');
		});
		const after = flights.runFresh('list', async () => 8);
		await expect(failing).rejects.toThrow('boom');
		await expect(after).resolves.toBe(8);
	});
});

describe('supabaseDelay', () => {
	it('waits on the given timers and ends early on abort', async () => {
		const clock = new ManualClock(0);
		let done = false;
		const waiting = supabaseDelay(clock.timers, 500).then(() => {
			done = true;
		});
		expect(clock.fireNext(499)).toBe(false);
		expect(clock.fireNext(500)).toBe(true);
		await waiting;
		expect(done).toBe(true);
		const controller = new AbortController();
		const aborted = supabaseDelay(clock.timers, 10_000, controller.signal);
		controller.abort();
		await expect(aborted).resolves.toBeUndefined();
		expect(clock.pendingTimers).toBe(0);
	});
});

describe('small helpers', () => {
	it('quotes for a POSIX shell', () => {
		expect(shellQuote('postgresql://postgres:pw@127.0.0.1:5432/postgres')).toBe(
			"'postgresql://postgres:pw@127.0.0.1:5432/postgres'"
		);
		expect(shellQuote("it's")).toBe("'it'\\''s'");
	});

	it('spots control characters', () => {
		expect(hasSupabaseControlCharacters('/Users/example/app')).toBe(false);
		expect(hasSupabaseControlCharacters('a\nb')).toBe(true);
		expect(hasSupabaseControlCharacters('a\u009bb')).toBe(true);
	});

	it("counts only this user's live processes as alive", () => {
		const kill = vi.spyOn(process, 'kill');
		try {
			kill.mockImplementation(() => true);
			expect(supabaseProcessAlive(4_242)).toBe(true);
			// Another user's process: never a child this desktop started.
			kill.mockImplementation(() => {
				throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
			});
			expect(supabaseProcessAlive(4_242)).toBe(false);
			kill.mockImplementation(() => {
				throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
			});
			expect(supabaseProcessAlive(4_242)).toBe(false);
			expect(supabaseProcessAlive(1)).toBe(false);
		} finally {
			kill.mockRestore();
		}
	});
});

describe('measureSupabaseDirectory', () => {
	it('adds up regular files without following symlinks', async () => {
		const root = path.join(base, 'tree');
		await mkdir(path.join(root, 'nested'), { recursive: true });
		await writeFile(path.join(root, 'a.bin'), Buffer.alloc(100));
		await writeFile(path.join(root, 'nested', 'b.bin'), Buffer.alloc(50));
		await symlink('/etc', path.join(root, 'link'));
		await expect(
			measureSupabaseDirectory(root, { now: Date.now })
		).resolves.toEqual({ bytes: 150, partial: false });
		await expect(
			measureSupabaseDirectory(path.join(base, 'missing'), { now: Date.now })
		).resolves.toBeUndefined();
		const capped = await measureSupabaseDirectory(root, {
			now: Date.now,
			maxEntries: 1,
		});
		expect(capped?.partial).toBe(true);
	});
});

describe('deleteSupabaseUploads', () => {
	it('deletes only <projectRoot>/supabase/.temp/stack-uploads/<id>', async () => {
		const root = path.join(base, 'project');
		const uploads = supabaseUploadsPath(root, ID);
		expect(uploads).toBe(
			path.join(root, 'supabase', '.temp', 'stack-uploads', ID)
		);
		await mkdir(uploads, { recursive: true });
		await writeFile(path.join(uploads, 'avatar.png'), 'png');
		const sibling = supabaseUploadsPath(root, 'b'.repeat(64));
		await mkdir(sibling, { recursive: true });
		await deleteSupabaseUploads(root, ID);
		await expect(stat(uploads)).rejects.toThrow();
		await expect(stat(sibling)).resolves.toBeTruthy();
	});

	it('refuses a bad id and a symlinked folder', async () => {
		const root = path.join(base, 'project');
		await mkdir(path.join(root, 'supabase', '.temp', 'stack-uploads'), {
			recursive: true,
		});
		const outside = path.join(base, 'outside');
		await mkdir(outside, { recursive: true });
		await writeFile(path.join(outside, 'keep.txt'), 'keep');
		await symlink(
			outside,
			path.join(root, 'supabase', '.temp', 'stack-uploads', ID)
		);
		await deleteSupabaseUploads(root, ID);
		await expect(stat(path.join(outside, 'keep.txt'))).resolves.toBeTruthy();
		await deleteSupabaseUploads(root, '../../outside');
		await expect(stat(path.join(outside, 'keep.txt'))).resolves.toBeTruthy();
		// A symlinked `supabase` folder is refused too.
		const linked = path.join(base, 'linked');
		await mkdir(linked, { recursive: true });
		await symlink(path.join(root, 'supabase'), path.join(linked, 'supabase'));
		await deleteSupabaseUploads(linked, ID);
		await expect(stat(path.join(outside, 'keep.txt'))).resolves.toBeTruthy();
	});
});

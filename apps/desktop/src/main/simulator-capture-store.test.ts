import {
	lstat,
	mkdtemp,
	open,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
	truncate,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_SIMULATOR_CAPTURE_RETENTION_POLICY,
	SimulatorCaptureStore,
} from './simulator-capture-store';

const UDID = '11111111-2222-3333-4444-555555555555';
const GIBIBYTE = 1024 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1_000;
const temporaryDirectories: string[] = [];

async function fixture({ now = Date.now }: { now?: () => number } = {}) {
	const directory = await mkdtemp(path.join(tmpdir(), 'rndevtools-captures-'));
	temporaryDirectories.push(directory);
	const root = path.join(directory, 'store');
	return { directory, root, store: new SimulatorCaptureStore(root, { now }) };
}

async function reserveScreenshot(store: SimulatorCaptureStore, name?: string) {
	return store.reserve({
		deviceUdid: UDID,
		kind: 'screenshot',
		format: 'png',
		...(name ? { name } : {}),
	});
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true }))
	);
});

describe('simulator capture store', () => {
	it('persists opaque, sanitized capture metadata without publishing local paths', async () => {
		const { root, store } = await fixture();
		const pending = await reserveScreenshot(
			store,
			'../../Health account screenshot'
		);
		expect(pending.path.startsWith(`${await realpath(root)}${path.sep}`)).toBe(
			true
		);
		expect(path.basename(pending.path)).toBe(`${pending.id}.png`);
		expect(path.basename(pending.path)).not.toContain('..');
		await writeFile(pending.path, Buffer.from('image'));
		const capture = await store.commit(pending);
		expect(capture).toMatchObject({
			kind: 'screenshot',
			status: 'complete',
			bytes: 5,
		});
		expect(JSON.stringify(store.list())).not.toContain(root);

		const recordPath = path.join(root, 'records', `${capture.id}.json`);
		expect((await stat(recordPath)).mode & 0o777).toBe(0o600);
		expect((await stat(pending.path)).mode & 0o777).toBe(0o600);
		const reloaded = new SimulatorCaptureStore(root);
		await reloaded.initialize();
		expect(reloaded.list()).toEqual([capture]);
	});

	it('recovers an interrupted non-empty recording as partial on startup', async () => {
		let now = 10 * DAY_MS;
		const { root, store } = await fixture({ now: () => now });
		const pending = await store.reserve({
			deviceUdid: UDID,
			kind: 'video',
			format: 'mp4',
		});
		await writeFile(pending.path, Buffer.from('partial-video'));
		now += 1_000;

		const recovered = new SimulatorCaptureStore(root, { now: () => now });
		await recovered.initialize();
		expect(recovered.list()).toEqual([
			expect.objectContaining({
				id: pending.id,
				status: 'partial',
				bytes: 13,
			}),
		]);
	});

	it('drops empty reservations and quarantines corrupted records without serving files', async () => {
		const { root, store } = await fixture();
		const empty = await reserveScreenshot(store);
		await writeFile(empty.path, Buffer.alloc(0));
		const complete = await reserveScreenshot(store, 'valid');
		await writeFile(complete.path, 'valid');
		const capture = await store.commit(complete);
		await writeFile(
			path.join(root, 'records', `${capture.id}.json`),
			'{"version":1,"unexpected":true}'
		);

		const recovered = new SimulatorCaptureStore(root);
		await recovered.initialize();
		expect(recovered.list()).toEqual([]);
		await expect(recovered.openForRead(capture.id)).rejects.toThrow(
			'Capture is not available'
		);
		expect(await lstat(complete.path)).toBeDefined();
		await expect(lstat(empty.path)).rejects.toMatchObject({ code: 'ENOENT' });
		const records = await readdir(path.join(root, 'records'));
		expect(records.some((name) => name.includes('.corrupt-'))).toBe(true);
	});

	it('never follows a capture symlink outside managed storage', async () => {
		const { directory, root, store } = await fixture();
		const outside = path.join(directory, 'outside-secret.txt');
		await writeFile(outside, 'outside-secret');
		const pending = await reserveScreenshot(store);
		await symlink(outside, pending.path);

		await expect(store.commit(pending)).rejects.toThrow('bounded regular file');
		const recovered = new SimulatorCaptureStore(root);
		await recovered.initialize();
		expect(recovered.list()).toEqual([]);
		expect(await readFile(outside, 'utf8')).toBe('outside-secret');
	});

	it('enforces age retention and persists bounded policy changes', async () => {
		let now = 100 * DAY_MS;
		const { root, store } = await fixture({ now: () => now });
		const oldPending = await reserveScreenshot(store, 'old');
		await writeFile(oldPending.path, 'old');
		const oldCapture = await store.commit(oldPending);
		now += 2 * DAY_MS;
		const retention = await store.configureRetention({
			maxAgeDays: 1,
			maxTotalBytes: 2 * GIBIBYTE,
		});
		expect(retention).toMatchObject({ captureCount: 0, totalBytes: 0 });
		await expect(store.openForRead(oldCapture.id)).rejects.toThrow();

		const reloaded = new SimulatorCaptureStore(root, { now: () => now });
		await reloaded.initialize();
		expect(reloaded.retentionState().policy).toEqual({
			maxAgeDays: 1,
			maxTotalBytes: 2 * GIBIBYTE,
		});
	});

	it('removes oldest captures once the configured byte ceiling is crossed', async () => {
		let now = 100 * DAY_MS;
		const { store } = await fixture({ now: () => now });
		await store.configureRetention({
			maxAgeDays: 30,
			maxTotalBytes: 2 * GIBIBYTE,
		});
		const first = await reserveScreenshot(store, 'first');
		await writeFile(first.path, '');
		await truncate(first.path, Math.floor(1.25 * GIBIBYTE));
		const firstCapture = await store.commit(first);
		now += 1;
		const second = await reserveScreenshot(store, 'second');
		await writeFile(second.path, '');
		await truncate(second.path, Math.floor(1.25 * GIBIBYTE));
		const secondCapture = await store.commit(second);

		expect(store.list().map((capture) => capture.id)).toEqual([
			secondCapture.id,
		]);
		await expect(store.openForRead(firstCapture.id)).rejects.toThrow();
		expect(store.retentionState().totalBytes).toBe(Math.floor(1.25 * GIBIBYTE));
	});

	it('exports atomically and deletes by opaque identifier', async () => {
		const { directory, store } = await fixture();
		const pending = await reserveScreenshot(store, 'export');
		await writeFile(pending.path, 'capture-bytes');
		const capture = await store.commit(pending);
		const destination = path.join(directory, 'exported.png');
		await store.export(capture.id, destination);
		expect(await readFile(destination, 'utf8')).toBe('capture-bytes');
		expect(await store.delete(capture.id)).toBe(true);
		expect(store.list()).toEqual([]);
		await expect(lstat(pending.path)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('uses the 30-day, 10-GiB defaults after a corrupt retention file', async () => {
		const { root, store } = await fixture();
		await store.initialize();
		await writeFile(path.join(root, 'retention-v1.json'), '{broken');
		const recovered = new SimulatorCaptureStore(root);
		await recovered.initialize();
		expect(recovered.retentionState().policy).toEqual(
			DEFAULT_SIMULATOR_CAPTURE_RETENTION_POLICY
		);
	});

	it('removes its atomic metadata temporary file when fsync fails', async () => {
		const { root, store } = await fixture();
		await store.initialize();
		const probePath = path.join(root, 'sync-probe');
		const probe = await open(probePath, 'w');
		const fileHandlePrototype = Object.getPrototypeOf(probe) as {
			sync: () => Promise<void>;
		};
		await probe.close();
		await rm(probePath, { force: true });
		const sync = vi
			.spyOn(fileHandlePrototype, 'sync')
			.mockRejectedValueOnce(new Error('injected fsync failure'));

		await expect(reserveScreenshot(store)).rejects.toThrow(
			'injected fsync failure'
		);
		sync.mockRestore();
		expect(
			(await readdir(path.join(root, 'records'))).filter((name) =>
				name.startsWith('.capture-')
			)
		).toEqual([]);
	});
});

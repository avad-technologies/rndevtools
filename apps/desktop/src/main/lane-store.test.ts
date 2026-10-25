import {
	lutimes,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	utimes,
	writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Lane } from '../shared/lane-protocol';
import { LaneStore } from './lane-store';

const UDID = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
const DAY_MS = 24 * 60 * 60 * 1_000;

async function exists(file: string): Promise<boolean> {
	return readdir(path.dirname(file)).then((entries) =>
		entries.includes(path.basename(file))
	);
}

function lane(id: string, overrides: Partial<Lane> = {}): Lane {
	return {
		id,
		worktreePath: '/Users/dev/app-feature',
		branch: 'feature',
		simulatorUdid: UDID,
		environment: 'development',
		port: 8_100,
		metro: 'starting',
		logPath: '/Users/dev/lane.log',
		startedAt: 1,
		...overrides,
	};
}

describe('LaneStore', () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), 'rndevtools-lanes-'));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it('persists lanes and repositories across restarts', async () => {
		const store = new LaneStore(root);
		await store.start();
		const id = store.newLaneId();
		await store.upsert(lane(id));
		await store.addRepository('/Users/dev/app');

		const reopened = new LaneStore(root);
		await reopened.start();
		expect(reopened.lanes()).toEqual([lane(id)]);
		expect(reopened.repositories()).toEqual(['/Users/dev/app']);
		expect(reopened.logPathFor(id)).toBe(path.join(root, 'logs', `${id}.log`));
	});

	it('updates in place, removes, and returns copies rather than live state', async () => {
		const store = new LaneStore(root);
		await store.start();
		const id = store.newLaneId();
		await store.upsert(lane(id));
		await store.upsert(lane(id, { metro: 'ready', metroPid: 99 }));
		expect(store.lanes()).toHaveLength(1);
		expect(store.get(id)).toMatchObject({ metro: 'ready', metroPid: 99 });
		const copy = store.get(id) as Lane;
		copy.metro = 'stopped';
		expect(store.get(id)?.metro).toBe('ready');
		expect(await store.remove(id)).toBe(true);
		expect(await store.remove(id)).toBe(false);
	});

	it('quarantines a corrupt file instead of failing to start', async () => {
		const store = new LaneStore(root);
		await store.start();
		await store.upsert(lane(store.newLaneId()));
		const file = path.join(root, 'lanes.json');
		await writeFile(file, '{not json');
		const reopened = new LaneStore(root);
		await reopened.start();
		expect(reopened.lanes()).toEqual([]);
		expect(
			(await readdir(root)).some((entry) => entry.includes('.corrupt-'))
		).toBe(true);
	});

	it('quarantines valid JSON that fails the schema and never overwrites it', async () => {
		// What a newer build might leave behind: a lane with a field this build
		// does not know. Ignoring it and writing over it would orphan the
		// detached Metro it describes.
		const file = path.join(root, 'lanes.json');
		const foreign = JSON.stringify({
			version: 1,
			lanes: [{ ...lane('lane-11111111-2222-4333-8444-555555555555'), x: 1 }],
			repositories: ['/Users/dev/app'],
		});
		await writeFile(file, foreign);
		const store = new LaneStore(root);
		await store.start();
		expect(store.lanes()).toEqual([]);
		expect(store.repositories()).toEqual([]);
		const quarantined = (await readdir(root)).filter((entry) =>
			/^lanes\.json\.corrupt-\d+$/.test(entry)
		);
		expect(quarantined).toHaveLength(1);

		// The next write starts a fresh document and leaves the copy alone.
		await store.upsert(lane(store.newLaneId()));
		expect(
			await readFile(path.join(root, quarantined[0] as string), 'utf8')
		).toBe(foreign);
		expect(JSON.parse(await readFile(file, 'utf8')).lanes).toHaveLength(1);
	});

	describe('pruning lane logs', () => {
		async function log(file: string, ageMs: number): Promise<string> {
			await writeFile(file, 'Starting Metro Bundler\n');
			const seconds = (Date.now() - ageMs) / 1_000;
			await utimes(file, seconds, seconds);
			return file;
		}

		it('deletes the logs of lanes that are gone once they sit idle past the retention', async () => {
			const store = new LaneStore(root);
			await store.start();
			const liveId = store.newLaneId();
			await store.upsert(lane(liveId, { logPath: store.logPathFor(liveId) }));
			const gone = await log(store.logPathFor(store.newLaneId()), 8 * DAY_MS);
			const recent = await log(store.logPathFor(store.newLaneId()), DAY_MS);
			const live = await log(store.logPathFor(liveId), 30 * DAY_MS);

			expect(await store.pruneLogs(7 * DAY_MS)).toBe(1);
			expect(await exists(gone)).toBe(false);
			// Still inside the retention window, or still a lane's own log.
			expect(await exists(recent)).toBe(true);
			expect(await exists(live)).toBe(true);
		});

		it('only ever deletes regular lane-<id>.log files in the logs directory', async () => {
			const store = new LaneStore(root);
			await store.start();
			const logs = path.join(root, 'logs');
			const old = 30 * DAY_MS;
			const notes = await log(path.join(logs, 'notes.log'), old);
			const lookalike = await log(path.join(logs, 'lane-feature.log'), old);
			const sibling = await log(
				path.join(root, `${store.newLaneId()}.log`),
				old
			);
			// A directory and a symlink that both look like lane logs.
			const directory = store.logPathFor(store.newLaneId());
			await mkdir(directory);
			const target = await log(path.join(root, 'elsewhere.txt'), old);
			const link = store.logPathFor(store.newLaneId());
			await symlink(target, link);
			const seconds = (Date.now() - old) / 1_000;
			await lutimes(link, seconds, seconds);

			expect(await store.pruneLogs(7 * DAY_MS)).toBe(0);
			for (const kept of [notes, lookalike, sibling, directory, link, target]) {
				expect(await exists(kept)).toBe(true);
			}
		});

		it('tolerates a missing logs directory', async () => {
			const store = new LaneStore(root);
			await store.start();
			await rm(path.join(root, 'logs'), { recursive: true, force: true });
			await expect(store.pruneLogs(7 * DAY_MS)).resolves.toBe(0);
		});
	});

	it('refuses a lane carrying its backend, so lanes.json never holds one', async () => {
		const store = new LaneStore(root);
		await store.start();
		const id = store.newLaneId();
		const backend = {
			policy: 'auto',
			status: 'ready',
			apiUrl: 'http://127.0.0.1:21734',
			appEnvNames: ['EXPO_PUBLIC_SUPABASE_URL'],
			warnings: [],
		};
		await expect(
			store.upsert({ ...lane(id), backend } as Lane)
		).rejects.toThrow();
		expect(store.lanes()).toEqual([]);
		await store.upsert(lane(id));
		const stored = await readFile(path.join(root, 'lanes.json'), 'utf8');
		expect(stored).not.toContain('backend');
		expect(stored).not.toContain('21734');
	});

	it('writes a versioned, strictly validated document', async () => {
		const store = new LaneStore(root);
		await store.start();
		await store.upsert(lane(store.newLaneId()));
		const document = JSON.parse(
			await readFile(path.join(root, 'lanes.json'), 'utf8')
		);
		expect(document.version).toBe(1);
		expect(Array.isArray(document.lanes)).toBe(true);
		await expect(
			store.upsert({ ...lane(store.newLaneId()), port: 1 } as Lane)
		).rejects.toThrow();
	});
});

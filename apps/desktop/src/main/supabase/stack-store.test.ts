import { createHash } from 'node:crypto';
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { supabaseDesktopError } from '../../shared/supabase-protocol';
import { realisticSecrets, SECRET_SHAPED } from './cli-fixtures.test-support';
import {
	SUPABASE_MAX_ACTIVITY,
	SUPABASE_MAX_STACK_RECORDS,
	type SupabaseRequestRecord,
	type SupabaseStackRecord,
	SupabaseStackStore,
	sanitizeSupabaseRequestNote,
	supabaseRecreateError,
} from './stack-store';

// Every saved change here is an fsync'd write, which a faster CPU doesn't
// speed up and a busy disk slows down. The slowest test on this timeout takes
// about 1.8 s in a full desktop run, under a tenth of it.
vi.setConfig({ testTimeout: 30_000 });

const NOW = 1_792_245_785_000;
const MINUTE = 60_000;
/** A fingerprint as older stacks.json files hold it: sha256 of a public key. */
const KEY_FINGERPRINT = createHash('sha256')
	.update('a public key', 'utf8')
	.digest('hex');
const directories: string[] = [];

async function root(): Promise<string> {
	const directory = await mkdtemp(
		path.join(tmpdir(), 'rndevtools-supabase-stacks-')
	);
	directories.push(directory);
	return path.join(directory, 'supabase');
}

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

function hex(seed: number): string {
	return seed.toString(16).padStart(64, '0');
}

function record(
	seed: number,
	overrides: Partial<SupabaseStackRecord> = {}
): SupabaseStackRecord {
	return {
		id: hex(seed),
		origin: 'managed',
		name: 'default',
		projectRoot: `/Users/example/code/example-app-wt/feat-${seed}`,
		worktreePath: `/Users/example/code/example-app-wt/feat-${seed}`,
		appPaths: [],
		branchContext: `refs/heads/feat-${seed}`,
		createdBy: { via: 'desktop' },
		createdAt: NOW - seed * MINUTE,
		runtime: 'native',
		pinned: false,
		holds: [],
		clocks: {},
		exclusions: ['studio', 'analytics'],
		studioEnabled: false,
		flags: {},
		...overrides,
	};
}

function request(
	seed: number,
	overrides: Partial<SupabaseRequestRecord> = {}
): SupabaseRequestRecord {
	return {
		id: `supabase-request-${hex(seed).slice(-8)}-0000-4000-8000-000000000000`,
		kind: 'destroy',
		status: 'pending',
		requester: {
			kind: 'codex',
			sessionId: `session-${seed}`,
			synthetic: false,
		},
		stackId: hex(seed),
		branch: `feat-${seed}`,
		createdAt: NOW - seed * MINUTE,
		expiresAt: NOW - seed * MINUTE + 30 * MINUTE,
		...overrides,
	};
}

function stackStore(directory: string, now = () => NOW) {
	return new SupabaseStackStore({ directory, now });
}

describe('SupabaseStackStore', () => {
	it('round-trips records through an atomic 0600 file', async () => {
		const directory = await root();
		const stacks = stackStore(directory);
		expect(await stacks.load()).toBe('ok');
		expect(stacks.records()).toEqual([]);
		await stacks.upsertRecord(
			record(1, {
				keyFingerprints: {
					publishableKey: KEY_FINGERPRINT,
				},
			})
		);
		await stacks.upsertRecord(record(2, { origin: 'adopted' }));
		await stacks.upsertRecord(
			record(1, {
				lastUsedAt: NOW,
				keyFingerprints: {
					publishableKey: KEY_FINGERPRINT,
				},
			})
		);
		const file = path.join(directory, 'stacks.json');
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		expect((await stat(directory)).mode & 0o777).toBe(0o700);
		expect(await readdir(directory)).toEqual(['stacks.json']);

		const reloaded = stackStore(directory);
		expect(await reloaded.load()).toBe('ok');
		expect(reloaded.records().map((entry) => entry.id)).toEqual([
			hex(1),
			hex(2),
		]);
		expect(reloaded.record(hex(1))?.lastUsedAt).toBe(NOW);
		expect(reloaded.record(hex(1))?.keyFingerprints?.publishableKey).toMatch(
			/^[0-9a-f]{64}$/
		);
		// Copies, so a caller cannot change the store's memory.
		const copy = reloaded.record(hex(1));
		if (copy) copy.pinned = true;
		expect(reloaded.record(hex(1))?.pinned).toBe(false);
	});

	it('refuses invalid records without writing', async () => {
		const directory = await root();
		const stacks = stackStore(directory);
		await stacks.load();
		await expect(
			stacks.upsertRecord(record(1, { projectRoot: 'relative/root' }))
		).rejects.toThrow();
		await expect(
			stacks.upsertRecord(record(1, { branchContext: 'feat-1' }))
		).rejects.toThrow();
		await expect(
			stacks.upsertRecord(
				record(1, { binaryPath: '/Users/example/../bin/supabase' })
			)
		).rejects.toThrow();
		expect(stacks.records()).toEqual([]);
		expect(await readdir(directory)).toEqual([]);
	});

	it.each([
		['invalid JSON', '[1,'],
		[
			'a record with an unknown field',
			JSON.stringify({
				version: 1,
				records: [{ ...record(1), password: 'x' }],
				requests: [],
				activity: [],
			}),
		],
		[
			'duplicate stack ids',
			JSON.stringify({
				version: 1,
				records: [record(1), record(1)],
				requests: [],
				activity: [],
			}),
		],
		[
			'too many records',
			JSON.stringify({
				version: 1,
				records: Array.from({ length: 129 }, (_, index) => record(index + 1)),
				requests: [],
				activity: [],
			}),
		],
	])('quarantines %s and starts empty', async (_label, contents) => {
		const directory = await root();
		await mkdir(directory, { recursive: true });
		const file = path.join(directory, 'stacks.json');
		await writeFile(file, contents);
		const stacks = stackStore(directory);
		expect(await stacks.load()).toBe('quarantined');
		expect(stacks.health).toBe('quarantined');
		expect(stacks.records()).toEqual([]);
		expect(await readFile(`${file}.corrupt-${NOW}`, 'utf8')).toBe(contents);
		await stacks.upsertRecord(record(3));
		expect(stacks.health).toBe('ok');
	});

	it('keeps at most 128 records, evicting the least active unheld one', async () => {
		const directory = await root();
		const stacks = stackStore(directory);
		await stacks.load();
		await stacks.upsertRecords(
			Array.from({ length: SUPABASE_MAX_STACK_RECORDS }, (_, index) =>
				record(index + 1, {
					origin: index + 1 === 5 ? 'external' : 'managed',
					pinned: index + 1 === 128,
				})
			)
		);
		await stacks.upsertRecord(record(500, { createdAt: NOW }));
		const ids = new Set(stacks.records().map((entry) => entry.id));
		expect(ids.size).toBe(SUPABASE_MAX_STACK_RECORDS);
		// The external record goes first, whatever its age.
		expect(ids.has(hex(5))).toBe(false);
		expect(ids.has(hex(500))).toBe(true);
		await stacks.upsertRecord(record(501, { createdAt: NOW }));
		// Then the least recently active managed one: the oldest created.
		expect(stacks.record(hex(127))).toBeUndefined();
		expect(stacks.record(hex(128))).toBeDefined();
	});

	it('refuses a new record when every one is pinned or held', async () => {
		const directory = await root();
		const stacks = stackStore(directory);
		await stacks.load();
		await stacks.upsertRecords(
			Array.from({ length: SUPABASE_MAX_STACK_RECORDS }, (_, index) =>
				record(index + 1, { pinned: true })
			)
		);
		const before = await readFile(path.join(directory, 'stacks.json'), 'utf8');
		await expect(stacks.upsertRecord(record(999))).rejects.toThrow(RangeError);
		// A refused batch writes nothing, not even its valid part.
		await expect(
			stacks.upsertRecords([
				record(1, { pinned: true, lastUsedAt: NOW }),
				record(998),
			])
		).rejects.toThrow(RangeError);
		expect(await readFile(path.join(directory, 'stacks.json'), 'utf8')).toBe(
			before
		);
		expect(stacks.record(hex(1))?.lastUsedAt).toBeUndefined();
		expect(stacks.records()).toHaveLength(SUPABASE_MAX_STACK_RECORDS);
	});

	it('adds, replaces and releases agent holds', async () => {
		const directory = await root();
		const stacks = stackStore(directory, () => NOW);
		await stacks.load();
		await stacks.upsertRecord(record(1, { releasedAt: NOW - MINUTE }));
		await stacks.upsertRecord(
			record(2, {
				worktreePath: '/Users/example/code/example-app-wt/other',
				projectRoot: '/Users/example/code/example-app-wt/other',
			})
		);
		const session = {
			holder: 'session' as const,
			agent: {
				kind: 'claude' as const,
				sessionId: 'claude-1',
				synthetic: false,
			},
			since: NOW - 5 * MINUTE,
		};
		let saved = await stacks.addHold(hex(1), session);
		expect(saved?.holds).toEqual([session]);
		expect(saved?.releasedAt).toBeUndefined();
		saved = await stacks.addHold(hex(1), { ...session, since: NOW });
		expect(saved?.holds).toEqual([{ ...session, since: NOW }]);
		const synthetic = {
			holder: 'worktree' as const,
			agent: {
				kind: 'codex' as const,
				sessionId: 'mcp-codex-mcp-client',
				synthetic: true,
			},
			since: NOW,
		};
		await stacks.addHold(hex(1), synthetic);
		await stacks.addHold(hex(2), synthetic);
		expect(await stacks.addHold(hex(9), session)).toBeUndefined();

		// A synthetic holder releases only where the ending session worked.
		const released = await stacks.releaseHolder(
			{ kind: 'codex', sessionId: 'mcp-codex-mcp-client' },
			{ sessionCwd: '/Users/example/code/example-app-wt/other/apps/mobile' }
		);
		expect(released).toEqual([hex(2)]);
		expect(stacks.record(hex(1))?.holds).toHaveLength(2);
		expect(stacks.record(hex(2))?.holds).toEqual([]);
		expect(stacks.record(hex(2))?.releasedAt).toBe(NOW);
		expect(stacks.record(hex(2))?.releasedBy).toEqual({
			holder: { kind: 'codex', sessionId: 'mcp-codex-mcp-client' },
			sessionCwd: '/Users/example/code/example-app-wt/other/apps/mobile',
		});
		// Holding it again ends the release period.
		await stacks.addHold(hex(2), session);
		expect(stacks.record(hex(2))?.releasedAt).toBeUndefined();
		expect(stacks.record(hex(2))?.releasedBy).toBeUndefined();

		expect(
			await stacks.releaseHolder({ kind: 'claude', sessionId: 'claude-1' })
		).toEqual([hex(1), hex(2)]);
		expect(stacks.record(hex(1))?.holds).toEqual([synthetic]);
		// Still held by the synthetic hold, so no release time yet.
		expect(stacks.record(hex(1))?.releasedAt).toBeUndefined();
		expect(
			await stacks.releaseHolder({ kind: 'claude', sessionId: 'claude-1' })
		).toEqual([]);
	});

	it('applies the release change holds.ts decided', async () => {
		const directory = await root();
		const stacks = stackStore(directory);
		await stacks.load();
		await stacks.upsertRecord(
			record(1, {
				releasedAt: NOW - MINUTE,
				releasedBy: { holder: { kind: 'claude', sessionId: 'claude-1' } },
			})
		);
		const before = await readFile(path.join(directory, 'stacks.json'), 'utf8');
		expect((await stacks.applyRelease(hex(1), undefined))?.releasedAt).toBe(
			NOW - MINUTE
		);
		expect(await readFile(path.join(directory, 'stacks.json'), 'utf8')).toBe(
			before
		);
		const cleared = await stacks.applyRelease(hex(1), 'clear');
		expect(cleared?.releasedAt).toBeUndefined();
		expect(cleared?.releasedBy).toBeUndefined();
		const started = await stacks.applyRelease(hex(1), { at: NOW });
		expect(started?.releasedAt).toBe(NOW);
	});

	it('pins and unpins, starting the linger only when nothing else holds it', async () => {
		const directory = await root();
		const stacks = stackStore(directory);
		await stacks.load();
		await stacks.upsertRecord(record(1, { releasedAt: NOW - MINUTE }));
		let saved = await stacks.setPinned(hex(1), true);
		expect(saved).toMatchObject({ pinned: true, pinnedAt: NOW });
		expect(saved?.releasedAt).toBeUndefined();
		saved = await stacks.setPinned(hex(1), false);
		expect(saved?.pinned).toBe(false);
		expect(saved?.pinnedAt).toBeUndefined();
		expect(saved?.releasedAt).toBe(NOW);
	});

	it('stores clocks and record updates, refusing an id change', async () => {
		const directory = await root();
		const stacks = stackStore(directory);
		await stacks.load();
		await stacks.upsertRecord(record(1));
		await stacks.setClocks(hex(1), {
			'claude:claude-1': { missingSince: NOW - MINUTE },
			'codex:mcp-codex-mcp-client@/Users/example/code/app': {
				pausedElapsedMs: 4_000,
			},
		});
		expect(Object.keys(stacks.record(hex(1))?.clocks ?? {})).toHaveLength(2);
		await expect(
			stacks.setClocks(hex(1), { 'not a key': { missingSince: 1 } })
		).rejects.toThrow();
		const updated = await stacks.updateRecord(hex(1), (draft) => {
			draft.flags = { interrupted: true };
			return undefined;
		});
		expect(updated?.flags).toEqual({ interrupted: true });
		await expect(
			stacks.updateRecord(hex(1), (draft) => ({ ...draft, id: hex(2) }))
		).rejects.toThrow(/stack id/);
		expect(await stacks.updateRecord(hex(7), () => undefined)).toBeUndefined();
		expect(await stacks.removeRecords([hex(1), hex(7)])).toBe(1);
		expect(stacks.records()).toEqual([]);
	});

	it('keeps memory unchanged when a write fails', async () => {
		const directory = await root();
		const stacks = stackStore(directory);
		await stacks.load();
		await stacks.upsertRecord(record(1));
		const file = path.join(directory, 'stacks.json');
		await rename(file, `${file}.moved`);
		await mkdir(file);
		await expect(stacks.upsertRecord(record(2))).rejects.toThrow();
		expect(stacks.records().map((entry) => entry.id)).toEqual([hex(1)]);
	});

	it('sanitizes and bounds agent notes, and redacts stored errors', async () => {
		const secrets = realisticSecrets();
		const override = String.fromCodePoint(0x20_2e);
		const note = `Please reset${override} this ${secrets.secretKey} ${secrets.anonKey} ${secrets.dbUrl}\n${'x'.repeat(400)}`;
		const safe = sanitizeSupabaseRequestNote(note);
		expect(safe).toBeDefined();
		expect(safe?.length).toBeLessThanOrEqual(240);
		expect(safe).not.toMatch(SECRET_SHAPED);
		expect(safe).not.toContain(override);
		expect(safe).not.toContain('\n');
		expect(sanitizeSupabaseRequestNote('   ')).toBeUndefined();
		expect(sanitizeSupabaseRequestNote(undefined)).toBeUndefined();

		const directory = await root();
		const stacks = stackStore(directory);
		await stacks.load();
		await stacks.putRequest(request(1, { note }));
		const leaky = supabaseDesktopError('internal', 'failed');
		await stacks.upsertRecord(
			record(1, {
				lastError: {
					...leaky,
					message: `failed with ${secrets.secretKey} at ${secrets.dbUrl}`,
				},
				recreateError: {
					...leaky,
					code: 'needs_recreate',
					message: `cannot adopt ${secrets.secretKey}`,
				},
				flags: { needsRecreate: true },
			})
		);
		const file = await readFile(path.join(directory, 'stacks.json'), 'utf8');
		expect(file).not.toMatch(SECRET_SHAPED);
		for (const secret of [
			secrets.secretKey,
			secrets.anonKey,
			secrets.dbPassword,
		]) {
			expect(file).not.toContain(secret);
		}
		expect(stacks.request(request(1).id)?.note).toBe(safe);
		expect(stacks.record(hex(1))?.lastError?.message).toBe(
			'failed with [REDACTED KEY] at postgresql://…@127.0.0.1:30630/postgres'
		);
		expect(stacks.record(hex(1))?.recreateError?.message).toBe(
			'cannot adopt [REDACTED KEY]'
		);
	});

	it("keeps what a needs-recreate stack can't adopt, and loads older records", async () => {
		const recreate = {
			...supabaseDesktopError('refused', 'The saved stack cannot adopt it.'),
			code: 'needs_recreate' as const,
			details: {
				stackChanges: [
					{
						key: '[db] major_version',
						saved: '15',
						requested: '17',
						editable: true,
					},
				],
			},
		};
		const conflict = {
			...supabaseDesktopError('refused', 'Port 54321 is in use.'),
			code: 'ports_conflict' as const,
		};
		const directory = await root();
		await mkdir(directory, { recursive: true });
		// Saved before recreateError existed: the details are its lastError.
		await writeFile(
			path.join(directory, 'stacks.json'),
			JSON.stringify({
				version: 1,
				records: [
					record(1, { flags: { needsRecreate: true }, lastError: recreate }),
					record(2, { lastError: recreate }),
				],
				requests: [],
				activity: [],
			})
		);
		const stacks = stackStore(directory);
		expect(await stacks.load()).toBe('ok');
		const older = stacks.record(hex(1));
		expect(older?.recreateError).toBeUndefined();
		expect(older && supabaseRecreateError(older)).toEqual(recreate);
		// Without the flag the saved stack has nothing it can't adopt.
		const unflagged = stacks.record(hex(2));
		expect(unflagged && supabaseRecreateError(unflagged)).toBeUndefined();
		// Kept in its own field, a later failure's lastError leaves it alone.
		await stacks.upsertRecord(
			record(3, {
				flags: { needsRecreate: true },
				lastError: conflict,
				recreateError: recreate,
			})
		);
		const reloaded = stackStore(directory);
		expect(await reloaded.load()).toBe('ok');
		const kept = reloaded.record(hex(3));
		expect(kept?.lastError?.code).toBe('ports_conflict');
		expect(kept && supabaseRecreateError(kept)).toEqual(recreate);
	});

	it('expires pending requests and drops old settled ones', async () => {
		const directory = await root();
		let now = NOW;
		const stacks = stackStore(directory, () => now);
		await stacks.load();
		await stacks.putRequest(request(1, { expiresAt: NOW - 1 }));
		await stacks.putRequest(request(2, { expiresAt: NOW + MINUTE }));
		expect(await stacks.expireRequests()).toBe(1);
		expect(stacks.request(request(1).id)).toMatchObject({
			status: 'expired',
			settledAt: NOW,
		});
		expect(stacks.request(request(2).id)?.status).toBe('pending');
		now = NOW + 25 * 60 * MINUTE;
		// Request 2 expires now; request 1 was settled over a day ago and goes.
		expect(await stacks.expireRequests()).toBe(2);
		expect(stacks.requests().map((entry) => [entry.id, entry.status])).toEqual([
			[request(2).id, 'expired'],
		]);
	});

	it('keeps at most 32 requests, dropping settled ones first', async () => {
		const directory = await root();
		const stacks = stackStore(directory);
		await stacks.load();
		await stacks.putRequest(
			request(40, { status: 'denied', settledAt: NOW - MINUTE })
		);
		for (let seed = 1; seed <= 32; seed += 1) {
			await stacks.putRequest(request(seed));
		}
		const ids = stacks.requests().map((entry) => entry.id);
		expect(ids).toHaveLength(32);
		expect(ids).not.toContain(request(40).id);
		const updated = await stacks.updateRequest(request(1).id, (draft) => {
			draft.status = 'settling';
		});
		expect(updated?.status).toBe('settling');
		expect(await stacks.updateRequest('nope', () => undefined)).toBeUndefined();
	});

	// 205 outcomes, each persisted durably (fsync): up to about 6 s in a full
	// desktop run, under a tenth of its own timeout.
	it('keeps an activity ring of the newest 200 outcomes', async () => {
		const directory = await root();
		const stacks = stackStore(directory);
		await stacks.load();
		for (let index = 0; index < SUPABASE_MAX_ACTIVITY + 5; index += 1) {
			await stacks.recordActivity({
				id: `activity-${index}`,
				kind: 'resume',
				stackIds: [hex(1)],
				outcome: index % 2 === 0 ? 'complete' : 'failed',
				...(index % 2 === 0 ? {} : { errorCode: 'busy' as const }),
				startedAt: NOW + index,
				durationMs: 1_000,
				requestedBy: 'lane',
			});
		}
		const activity = stacks.activity();
		expect(activity).toHaveLength(SUPABASE_MAX_ACTIVITY);
		expect(activity[0]?.id).toBe(`activity-${SUPABASE_MAX_ACTIVITY + 4}`);
		await expect(
			stacks.recordActivity({
				id: 'activity-bad',
				kind: 'resume',
				stackIds: ['short'],
				outcome: 'complete',
				startedAt: NOW,
				durationMs: 1,
				requestedBy: 'lane',
			})
		).rejects.toThrow();
	}, 75_000);

	it('notifies subscribers after each saved change', async () => {
		const directory = await root();
		const stacks = stackStore(directory);
		await stacks.load();
		let calls = 0;
		const unsubscribe = stacks.subscribe(() => {
			calls += 1;
		});
		await stacks.upsertRecord(record(1));
		await stacks.removeRecords([hex(9)]);
		unsubscribe();
		await stacks.upsertRecord(record(2));
		expect(calls).toBe(1);
	});
});

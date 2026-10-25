import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	SUPABASE_POLICY_DEFAULTS,
	SUPABASE_POLICY_ERRORS,
	supabasePolicySchema,
} from '../../shared/supabase-protocol';
import {
	loadSupabaseStoreFile,
	quarantineSupabaseStoreFile,
	readSupabaseStoreFile,
	SupabasePolicyStore,
	SupabaseStoreQueue,
	writeSupabaseStoreFile,
} from './policy-store';

const directories: string[] = [];
const NOW = 1_792_245_785_000;

async function root(): Promise<string> {
	const directory = await mkdtemp(
		path.join(tmpdir(), 'rndevtools-supabase-policy-')
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

function store(directory: string, now = () => NOW) {
	return new SupabasePolicyStore({
		directory,
		now,
		pathLabel: (value) => value.replace('/Users/example', '~'),
	});
}

async function corruptFiles(directory: string): Promise<string[]> {
	return (await readdir(directory)).filter((name) =>
		name.startsWith('policy-v1.json.corrupt-')
	);
}

describe('SupabasePolicyStore', () => {
	it('starts from the defaults with the feature off and no file', async () => {
		const directory = await root();
		const policy = store(directory);
		const snapshot = await policy.load();
		expect(snapshot.enabled).toBe(false);
		expect(snapshot.health).toBe('ok');
		expect(snapshot.policy).toEqual(SUPABASE_POLICY_DEFAULTS);
		expect(supabasePolicySchema.parse(snapshot.policy)).toEqual(
			snapshot.policy
		);
		expect(snapshot.paths).toEqual({});
		const info = await stat(directory);
		expect(info.mode & 0o777).toBe(0o700);
		expect(await readdir(directory)).toEqual([]);
	});

	it('turns the feature on with its acknowledgement and persists 0600', async () => {
		const directory = await root();
		const policy = store(directory);
		await policy.load();
		await expect(policy.setEnabled(true)).rejects.toThrow(/acknowledgement/);
		const snapshot = await policy.setEnabled(true, NOW - 5_000);
		expect(snapshot).toMatchObject({
			enabled: true,
			acknowledgedAt: NOW - 5_000,
			health: 'ok',
		});
		const file = path.join(directory, 'policy-v1.json');
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		// Only the policy file: the temp file was renamed over it.
		expect(await readdir(directory)).toEqual(['policy-v1.json']);
		const stored = JSON.parse(await readFile(file, 'utf8'));
		expect(stored.version).toBe(1);
		// Fixed values and labels are derived, never stored.
		expect(stored.policy.abandonedGraceMs).toBeUndefined();
		expect(stored.policy.appEnvPreset).toBeUndefined();
		expect(stored.policy.paths).toBeUndefined();

		const reloaded = await store(directory).load();
		expect(reloaded.enabled).toBe(true);
		expect(reloaded.acknowledgedAt).toBe(NOW - 5_000);
		const off = await policy.setEnabled(false);
		expect(off.enabled).toBe(false);
		expect(off.acknowledgedAt).toBe(NOW - 5_000);
	});

	it('applies valid patches and returns Settings copy for invalid ones', async () => {
		const directory = await root();
		const policy = store(directory);
		await policy.load();
		const saved = await policy.updatePolicy({
			maxRunning: 6,
			exclude: ['studio', 'analytics', 'pooler'],
			appEnv: [{ name: 'EXPO_PUBLIC_API', source: 'API_URL' }],
		});
		expect(saved.ok).toBe(true);
		if (!saved.ok) return;
		expect(saved.snapshot.policy.maxRunning).toBe(6);
		expect(saved.snapshot.policy.exclude).toEqual([
			'studio',
			'analytics',
			'pooler',
		]);
		expect(saved.snapshot.policy.appEnvPreset).toEqual(
			SUPABASE_POLICY_DEFAULTS.appEnvPreset
		);
		const before = await readFile(
			path.join(directory, 'policy-v1.json'),
			'utf8'
		);

		const tooMany = await policy.updatePolicy({ maxRunning: 0 });
		expect(tooMany).toEqual({
			ok: false,
			errors: { maxRunning: SUPABASE_POLICY_ERRORS.maxRunning },
		});
		const reserved = await policy.updatePolicy({
			appEnv: [{ name: 'NODE_OPTIONS', source: 'API_URL' }],
		});
		expect(reserved).toEqual({
			ok: false,
			errors: { 'appEnv.0': SUPABASE_POLICY_ERRORS.appEnvReserved },
		});
		const smuggled = await policy.updatePolicy({
			paths: { supabaseHomeLabel: '/tmp', customHome: true },
		});
		expect(smuggled.ok).toBe(false);
		const empty = await policy.updatePolicy({});
		expect(empty).toEqual({
			ok: false,
			errors: { form: SUPABASE_POLICY_ERRORS.empty },
		});
		expect(await readFile(path.join(directory, 'policy-v1.json'), 'utf8')).toBe(
			before
		);
		expect(policy.snapshot().policy.maxRunning).toBe(6);
	});

	it('keeps repository modes and chosen paths, labelling paths', async () => {
		const directory = await root();
		const policy = store(directory);
		await policy.load();
		await policy.setRepositoryMode('repo-0123456789ab', 'off');
		let snapshot = await policy.setRepositoryMode('repo-ba9876543210', 'off');
		expect(snapshot.policy.repositories).toEqual([
			{ id: 'repo-0123456789ab', mode: 'off' },
			{ id: 'repo-ba9876543210', mode: 'off' },
		]);
		snapshot = await policy.setRepositoryMode('repo-0123456789ab', 'auto');
		expect(snapshot.policy.repositories).toEqual([
			{ id: 'repo-ba9876543210', mode: 'off' },
		]);
		await expect(
			policy.setRepositoryMode('/Users/example/app', 'off')
		).rejects.toThrow();

		snapshot = await policy.setPath(
			'supabase-home',
			'/Users/example/Library/Supabase Home'
		);
		expect(snapshot.paths.supabaseHome).toBe(
			'/Users/example/Library/Supabase Home'
		);
		expect(snapshot.policy.paths).toEqual({
			supabaseHomeLabel: '~/Library/Supabase Home',
			customHome: true,
		});
		snapshot = await policy.setPath('ssl-cert', '/Users/example/ca.pem');
		expect(snapshot.policy.paths.sslCertLabel).toBe('~/ca.pem');
		await expect(
			policy.setPath('ssl-cert', 'relative/ca.pem')
		).rejects.toThrow();
		await expect(
			policy.setPath('ssl-cert', '/Users/example/../etc/ca.pem')
		).rejects.toThrow();
		snapshot = await policy.setPath('supabase-home', undefined);
		expect(snapshot.paths).toEqual({ sslCertFile: '/Users/example/ca.pem' });
		expect(snapshot.policy.paths).toEqual({
			supabaseHomeLabel: SUPABASE_POLICY_DEFAULTS.paths.supabaseHomeLabel,
			customHome: false,
			sslCertLabel: '~/ca.pem',
		});
		const reloaded = await store(directory).load();
		expect(reloaded.paths).toEqual({ sslCertFile: '/Users/example/ca.pem' });
		expect(reloaded.policy.repositories).toEqual([
			{ id: 'repo-ba9876543210', mode: 'off' },
		]);
	});

	it.each([
		['invalid JSON', '{"version":1,'],
		['another version', JSON.stringify({ version: 2, enabled: true })],
		[
			'an unknown field',
			JSON.stringify({
				version: 1,
				enabled: true,
				policy: {},
				paths: {},
				extra: true,
			}),
		],
	])('quarantines %s and turns the feature off', async (_label, contents) => {
		const directory = await root();
		await mkdir(directory, { recursive: true });
		await writeFile(path.join(directory, 'policy-v1.json'), contents);
		const policy = store(directory);
		const snapshot = await policy.load();
		expect(snapshot.health).toBe('quarantined');
		expect(snapshot.enabled).toBe(false);
		expect(snapshot.policy).toEqual(SUPABASE_POLICY_DEFAULTS);
		const corrupt = await corruptFiles(directory);
		expect(corrupt).toEqual([`policy-v1.json.corrupt-${NOW}`]);
		expect(snapshot.quarantinedTo).toBe(
			path.join(directory, `policy-v1.json.corrupt-${NOW}`)
		);
		// The bad copy is kept as it was, and no new policy file is written yet.
		expect(
			await readFile(path.join(directory, corrupt[0] as string), 'utf8')
		).toBe(contents);
		expect((await readdir(directory)).includes('policy-v1.json')).toBe(false);

		const saved = await policy.setEnabled(true, NOW);
		expect(saved.health).toBe('ok');
		expect(saved.enabled).toBe(true);
	});

	it('quarantines a hand edit that breaks a Settings rule', async () => {
		const directory = await root();
		const policy = store(directory);
		await policy.load();
		await policy.setEnabled(true, NOW);
		const file = path.join(directory, 'policy-v1.json');
		const stored = JSON.parse(await readFile(file, 'utf8'));
		stored.policy.appEnv = [
			{ name: 'SUPABASE_SERVICE_ROLE_KEY', source: 'PUBLISHABLE_KEY' },
		];
		await writeFile(file, JSON.stringify(stored));
		const reloaded = await store(directory).load();
		expect(reloaded.health).toBe('quarantined');
		expect(reloaded.enabled).toBe(false);
		expect(reloaded.policy.appEnv).toEqual(SUPABASE_POLICY_DEFAULTS.appEnv);
	});

	it('quarantines an oversized file and a symlink without following it', async () => {
		const directory = await root();
		await mkdir(directory, { recursive: true });
		const file = path.join(directory, 'policy-v1.json');
		await writeFile(file, ' '.repeat(70 * 1024));
		expect((await store(directory).load()).health).toBe('quarantined');

		const target = path.join(path.dirname(directory), 'elsewhere.json');
		await writeFile(target, '{}');
		await symlink(target, file);
		const later = store(directory, () => NOW + 1);
		expect((await later.load()).health).toBe('quarantined');
		// The link itself was moved aside; its target is untouched.
		expect(await readFile(target, 'utf8')).toBe('{}');
		const moved = await lstat(
			path.join(directory, `policy-v1.json.corrupt-${NOW + 1}`)
		);
		expect(moved.isSymbolicLink()).toBe(true);
	});

	it('keeps memory unchanged when a write fails', async () => {
		const directory = await root();
		const policy = store(directory);
		await policy.load();
		await policy.setEnabled(true, NOW);
		// A directory in the file's place makes the rename fail.
		const file = path.join(directory, 'policy-v1.json');
		await rename(file, `${file}.moved`);
		await mkdir(file);
		await expect(policy.updatePolicy({ maxRunning: 3 })).rejects.toThrow();
		expect(policy.snapshot().policy.maxRunning).toBe(
			SUPABASE_POLICY_DEFAULTS.maxRunning
		);
		// The temp file was removed.
		expect(
			(await readdir(directory)).filter((name) => name.endsWith('.tmp'))
		).toEqual([]);
	});

	it('notifies subscribers with each saved snapshot', async () => {
		const directory = await root();
		const policy = store(directory);
		await policy.load();
		const seen: number[] = [];
		const unsubscribe = policy.subscribe((snapshot) =>
			seen.push(snapshot.policy.retentionDays)
		);
		await policy.updatePolicy({ retentionDays: 30 });
		unsubscribe();
		await policy.updatePolicy({ retentionDays: 31 });
		expect(seen).toEqual([30]);
	});
});

describe('durable store files', () => {
	it('reads bounded regular files and reports what it found', async () => {
		const directory = await root();
		await mkdir(directory, { recursive: true });
		const file = path.join(directory, 'state.json');
		expect(await readSupabaseStoreFile(file, 16)).toEqual({
			status: 'missing',
		});
		await writeFile(file, '{"a":1}');
		expect(await readSupabaseStoreFile(file, 16)).toEqual({
			status: 'ok',
			text: '{"a":1}',
		});
		expect(await readSupabaseStoreFile(file, 4)).toEqual({
			status: 'invalid',
			reason: 'too-large',
		});
		expect(await readSupabaseStoreFile(directory, 16)).toEqual({
			status: 'invalid',
			reason: 'not-a-file',
		});
	});

	it('writes atomically and refuses contents over the bound', async () => {
		const directory = await root();
		const file = path.join(directory, 'state.json');
		await writeSupabaseStoreFile(file, 'one', 16);
		await writeSupabaseStoreFile(file, 'two', 16);
		expect(await readFile(file, 'utf8')).toBe('two');
		await expect(
			writeSupabaseStoreFile(file, 'x'.repeat(17), 16)
		).rejects.toThrow(RangeError);
		expect(await readFile(file, 'utf8')).toBe('two');
		expect(await readdir(directory)).toEqual(['state.json']);
	});

	it('never overwrites an earlier quarantine', async () => {
		const directory = await root();
		await mkdir(directory, { recursive: true });
		const file = path.join(directory, 'state.json');
		await writeFile(file, 'first');
		expect(await quarantineSupabaseStoreFile(file, NOW)).toBe(
			`${file}.corrupt-${NOW}`
		);
		await writeFile(file, 'second');
		expect(await quarantineSupabaseStoreFile(file, NOW)).toBe(
			`${file}.corrupt-${NOW}-1`
		);
		expect(await readFile(`${file}.corrupt-${NOW}`, 'utf8')).toBe('first');
		expect(await readFile(`${file}.corrupt-${NOW}-1`, 'utf8')).toBe('second');
	});

	it('loads, parsing with the caller schema', async () => {
		const directory = await root();
		await mkdir(directory, { recursive: true });
		const file = path.join(directory, 'state.json');
		await writeFile(file, '{"ok":true}');
		const loaded = await loadSupabaseStoreFile(file, {
			maxBytes: 64,
			now: NOW,
			parse: (value) =>
				typeof value === 'object' && value !== null && 'ok' in value
					? value
					: undefined,
		});
		expect(loaded).toEqual({ status: 'ok', data: { ok: true } });
		const rejected = await loadSupabaseStoreFile(file, {
			maxBytes: 64,
			now: NOW,
			parse: () => undefined,
		});
		expect(rejected).toEqual({
			status: 'quarantined',
			movedTo: `${file}.corrupt-${NOW}`,
			reason: 'schema',
		});
	});

	it('runs queued tasks in order, past failures', async () => {
		const queue = new SupabaseStoreQueue();
		const order: string[] = [];
		const first = queue.run(async () => {
			order.push('first');
			throw new Error('first failed');
		});
		const second = queue.run(async () => {
			order.push('second');
			return 2;
		});
		await expect(first).rejects.toThrow('first failed');
		await expect(second).resolves.toBe(2);
		expect(order).toEqual(['first', 'second']);
	});
});

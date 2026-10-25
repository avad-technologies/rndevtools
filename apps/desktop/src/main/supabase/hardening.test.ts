import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	buildSupabaseCliEnvironment,
	SupabaseCliRunnerError,
} from './cli-runner';
import {
	generateSupabaseStackKeys,
	nodeGitCheckIgnore,
	SUPABASE_PORT_LEASE_RANGE,
	SupabaseKeyStore,
	SupabasePortLeases,
	supabasePortOverrideName,
} from './hardening';

let base = '';

beforeEach(async () => {
	base = await realpath(
		await mkdtemp(path.join(tmpdir(), 'rndevtools-supabase-hardening-'))
	);
});

afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

async function worktree(name = 'wt'): Promise<string> {
	const root = path.join(base, name);
	await mkdir(path.join(root, 'supabase'), { recursive: true });
	return root;
}

function store(ignored = true, checks: string[] = []) {
	return new SupabaseKeyStore({
		directory: path.join(base, 'keys'),
		now: () => 1_000,
		checkIgnore: async (_root, relative) => {
			checks.push(relative);
			return ignored;
		},
	});
}

describe('generateSupabaseStackKeys', () => {
	it('makes keys in the shapes the CLI accepts', () => {
		const keys = generateSupabaseStackKeys();
		expect(keys.jwtSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(keys.publishableKey).toMatch(/^sb_publishable_[A-Za-z0-9_-]{32}$/);
		expect(keys.secretKey).toMatch(/^sb_secret_[A-Za-z0-9_-]{32}$/);
		expect(keys.signingKey).toMatchObject({
			kty: 'EC',
			crv: 'P-256',
			alg: 'ES256',
			use: 'sig',
			key_ops: ['sign', 'verify'],
		});
		expect(generateSupabaseStackKeys().jwtSecret).not.toBe(keys.jwtSecret);
	});
});

describe('SupabaseKeyStore', () => {
	it('writes the keys into supabase/.env.local only when git ignores it', async () => {
		const root = await worktree();
		const checks: string[] = [];
		const keys = store(true, checks);
		await writeFile(
			path.join(root, 'supabase', '.env.local'),
			'OPENAI_API_KEY=keep-me\nSUPABASE_AUTH_JWT_SECRET=old\n'
		);
		await expect(
			keys.applyToWorktree({ projectRoot: root, worktreeRoot: root })
		).resolves.toBe('written');
		expect(checks).toEqual([path.join('supabase', '.env.local')]);
		const env = await readFile(
			path.join(root, 'supabase', '.env.local'),
			'utf8'
		);
		expect(env).toMatch(/^OPENAI_API_KEY=keep-me$/m);
		expect(env.match(/SUPABASE_AUTH_JWT_SECRET=/g)).toHaveLength(1);
		expect(env).toContain(
			'# RN Devtools per-stack keys: managed by RN Devtools.'
		);
		const signing = /^SUPABASE_AUTH_SIGNING_KEYS_PATH="(.+)"$/m.exec(env)?.[1];
		expect(signing).toBeDefined();
		const jwks = JSON.parse(await readFile(signing ?? '', 'utf8'));
		expect(jwks).toHaveLength(1);
		expect((await stat(signing ?? '')).mode & 0o777).toBe(0o600);
		expect(
			(await stat(path.join(root, 'supabase', '.env.local'))).mode & 0o777
		).toBe(0o600);
		await expect(
			keys.applyToWorktree({ projectRoot: root, worktreeRoot: root })
		).resolves.toBe('unchanged');
		// The same worktree keeps its keys across calls and restarts.
		const again = await store().keysFor(root);
		expect(env).toContain(again.keys.publishableKey);
	});

	it('leaves a file git would commit alone', async () => {
		const root = await worktree();
		await expect(
			store(false).applyToWorktree({ projectRoot: root, worktreeRoot: root })
		).resolves.toBe('not-ignored');
		await expect(
			stat(path.join(root, 'supabase', '.env.local'))
		).rejects.toThrow();
	});

	it('never writes through a symlink or outside the worktree', async () => {
		const root = await worktree();
		const elsewhere = path.join(base, 'elsewhere.env');
		await writeFile(elsewhere, 'SECRET=1\n');
		await symlink(elsewhere, path.join(root, 'supabase', '.env.local'));
		await expect(
			store().applyToWorktree({ projectRoot: root, worktreeRoot: root })
		).resolves.toBe('failed');
		expect(await readFile(elsewhere, 'utf8')).toBe('SECRET=1\n');
		await expect(
			store().applyToWorktree({
				projectRoot: root,
				worktreeRoot: path.join(base, 'other'),
			})
		).resolves.toBe('failed');
	});

	it('removes only its own block, and notices a revert', async () => {
		const root = await worktree();
		const keys = store();
		await writeFile(path.join(root, 'supabase', '.env.local'), 'KEEP=1\n');
		await keys.applyToWorktree({ projectRoot: root, worktreeRoot: root });
		await writeFile(
			path.join(root, 'supabase', '.env.local'),
			'KEEP=1\nSUPABASE_AUTH_JWT_SECRET=reverted\n'
		);
		// The reverted value is noticed and the managed block written again.
		await expect(
			keys.applyToWorktree({ projectRoot: root, worktreeRoot: root })
		).resolves.toBe('written');
		await expect(keys.removeFromWorktree(root)).resolves.toBe(true);
		expect(
			await readFile(path.join(root, 'supabase', '.env.local'), 'utf8')
		).toBe('KEEP=1\n');
		await expect(keys.removeFromWorktree(root)).resolves.toBe(false);
	});
});

describe('git check-ignore', () => {
	it('refuses relative roots and paths that leave the worktree without running git', async () => {
		await expect(
			nodeGitCheckIgnore('relative', 'supabase/.env.local')
		).resolves.toBe(false);
		await expect(nodeGitCheckIgnore(base, '../outside')).resolves.toBe(false);
		await expect(nodeGitCheckIgnore(base, '/etc/hosts')).resolves.toBe(false);
	});
});

describe('pinned-port leases', () => {
	it('names the override for each pinned listener the runner passes through', () => {
		expect(
			supabasePortOverrideName({ source: 'config', key: 'api.port' })
		).toBe('SUPABASE_API_PORT');
		expect(
			supabasePortOverrideName({ source: 'config', key: 'db.shadow_port' })
		).toBe('SUPABASE_DB_SHADOW_PORT');
		expect(
			supabasePortOverrideName({ source: 'dotenv', key: 'SUPABASE_DB_PORT' })
		).toBe('SUPABASE_DB_PORT');
		expect(
			supabasePortOverrideName({
				source: 'dotenv',
				key: 'SUPABASE_EXAMPLE_PORT',
			})
		).toBeUndefined();
		expect(
			supabasePortOverrideName({ source: 'config', key: 'auth.site_url' })
		).toBeUndefined();
	});

	it('passes leased ports to the CLI only as leases', () => {
		const binaryPath = '/opt/example/node_modules/.bin/supabase';
		expect(
			buildSupabaseCliEnvironment({
				binaryPath,
				parentEnvironment: {},
				options: { leasedPorts: { SUPABASE_API_PORT: '33000' } },
			}).SUPABASE_API_PORT
		).toBe('33000');
		for (const leasedPorts of [
			{ SUPABASE_API_PORT: '80' },
			{ SUPABASE_API_PORT: '33000; rm' },
			{ SUPABASE_ACCESS_TOKEN: '33000' },
		]) {
			expect(() =>
				buildSupabaseCliEnvironment({
					binaryPath,
					parentEnvironment: {},
					options: { leasedPorts },
				})
			).toThrow(SupabaseCliRunnerError);
		}
		expect(() =>
			buildSupabaseCliEnvironment({
				binaryPath,
				parentEnvironment: {},
				options: { overrides: { SUPABASE_API_PORT: '33000' } },
			})
		).toThrow(SupabaseCliRunnerError);
	});

	it('leases each worktree its own block from 33000-39999, kept across restarts', async () => {
		const file = path.join(base, 'leases', 'port-leases-v1.json');
		const leases = new SupabasePortLeases({ file, now: () => 1_000 });
		const first = await leases.overridesFor('/Users/example/wt-a', [
			'SUPABASE_DB_PORT',
			'SUPABASE_API_PORT',
		]);
		expect(first).toEqual({
			SUPABASE_API_PORT: String(SUPABASE_PORT_LEASE_RANGE[0]),
			SUPABASE_DB_PORT: String(Number(SUPABASE_PORT_LEASE_RANGE[0]) + 1),
		});
		const second = await leases.overridesFor('/Users/example/wt-b', [
			'SUPABASE_API_PORT',
		]);
		expect(second).toEqual({ SUPABASE_API_PORT: '33016' });
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		const reloaded = new SupabasePortLeases({ file, now: () => 2_000 });
		await expect(
			reloaded.overridesFor('/Users/example/wt-a', ['SUPABASE_API_PORT'])
		).resolves.toEqual({ SUPABASE_API_PORT: '33000' });
		for (const value of [...Object.values(first), ...Object.values(second)]) {
			const port = Number(value);
			expect(port).toBeGreaterThanOrEqual(33_000);
			expect(port).toBeLessThanOrEqual(39_999);
		}
	});
});

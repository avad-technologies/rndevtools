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
import type { SupabaseWorktreeFacts } from './repositories';
import type { SteeringRoot } from './service-ports';
import {
	SupabaseSteeringWriter,
	supabaseSteeringRoots,
} from './steering-writer';

let base = '';
let now = Date.UTC(2026, 9, 17, 9, 0, 0);

beforeEach(async () => {
	base = await realpath(
		await mkdtemp(path.join(tmpdir(), 'rndevtools-supabase-steering-'))
	);
	now = Date.UTC(2026, 9, 17, 9, 0, 0);
});

afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

function root(index: number, fields: Partial<SteeringRoot> = {}): SteeringRoot {
	return {
		root: `/Users/example/code/example-app-wt/feature-${index}`,
		projectRoot: `/Users/example/code/example-app-wt/feature-${index}`,
		branchContext: `refs/heads/feature-${index}`,
		stackReady: index % 2 === 0,
		runner: 'pnpm exec supabase',
		...fields,
	};
}

function writer(directory = path.join(base, 'agent')) {
	return new SupabaseSteeringWriter({ directory, now: () => now });
}

describe('SupabaseSteeringWriter', () => {
	it('writes steering.json v1 as a 0600 file the hook reads', async () => {
		const steering = writer();
		await expect(
			steering.write({
				enabled: true,
				desktopPid: 4321,
				writtenAt: now,
				managedRoots: [root(1)],
			})
		).resolves.toBe(true);
		const info = await stat(steering.file);
		expect(info.mode & 0o777).toBe(0o600);
		expect((await stat(path.dirname(steering.file))).mode & 0o777).toBe(0o700);
		expect(JSON.parse(await readFile(steering.file, 'utf8'))).toEqual({
			version: 1,
			writtenAt: now,
			desktopPid: 4321,
			supabase: {
				enabled: true,
				roots: [
					{
						worktreeRoot: root(1).root,
						projectRoot: root(1).projectRoot,
						mode: 'managed',
						branchContext: 'refs/heads/feature-1',
						stackReady: false,
						runner: 'pnpm exec supabase',
					},
				],
			},
		});
	});

	it('rewrites an unchanged file only as a heartbeat', async () => {
		const steering = writer();
		const snapshot = {
			enabled: true,
			desktopPid: 4321,
			writtenAt: now,
			managedRoots: [root(1)],
		};
		expect(await steering.write(snapshot)).toBe(true);
		now += 15_000;
		expect(await steering.write({ ...snapshot, writtenAt: now })).toBe(false);
		expect(
			await steering.write({
				...snapshot,
				writtenAt: now,
				managedRoots: [root(1, { stackReady: true })],
			})
		).toBe(true);
		now += 45_000;
		expect(
			await steering.write({
				...snapshot,
				writtenAt: now,
				managedRoots: [root(1, { stackReady: true })],
			})
		).toBe(true);
	});

	it('drops roots the hook would refuse, and stays under 64 KiB and 256 roots', async () => {
		const steering = writer();
		const long = `/Users/example/${'x'.repeat(900)}`;
		const roots = [
			root(1, { root: 'relative/path' }),
			root(2, { branchContext: 'refs/heads/a\u0007b' }),
			root(3, { runner: 'pnpm exec supabase\n' }),
			root(4, { projectRoot: '/Users/example/../etc' }),
			...Array.from({ length: 400 }, (_value, index) =>
				root(index + 10, {
					root: `${long}-${index}`,
					projectRoot: `${long}-${index}`,
				})
			),
		];
		await steering.write({
			enabled: true,
			desktopPid: 4321,
			writtenAt: now,
			managedRoots: roots,
		});
		const text = await readFile(steering.file, 'utf8');
		expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(64 * 1024);
		const written = JSON.parse(text).supabase.roots as {
			worktreeRoot: string;
		}[];
		expect(written.length).toBeGreaterThan(0);
		expect(written.length).toBeLessThanOrEqual(256);
		expect(written.every((entry) => entry.worktreeRoot.startsWith(long))).toBe(
			true
		);
	});

	it('lists no roots while disabled, and removes the file without following a symlink', async () => {
		const steering = writer();
		await steering.write({
			enabled: false,
			desktopPid: 4321,
			writtenAt: now,
			managedRoots: [root(1)],
		});
		expect(JSON.parse(await readFile(steering.file, 'utf8')).supabase).toEqual({
			enabled: false,
			roots: [],
		});
		await steering.remove();
		await expect(stat(steering.file)).rejects.toThrow();
		await steering.remove();
		const target = path.join(base, 'kept.json');
		await writeFile(target, 'keep');
		await symlink(target, steering.file);
		await steering.remove();
		expect(await readFile(target, 'utf8')).toBe('keep');
	});
});

describe('supabaseSteeringRoots', () => {
	it('lists managed worktrees with a readable HEAD once, by realpath', async () => {
		const worktree = path.join(base, 'wt');
		await mkdir(worktree, { recursive: true });
		const managed = {
			worktreePath: worktree,
			realWorktreePath: worktree,
			appPath: worktree,
			mode: { value: 'managed' },
			expectedStackId: 'a'.repeat(64),
			detection: {
				status: 'found',
				projectRoot: worktree,
				runner: {
					command: 'pnpm exec',
					lockfile: `${worktree}/pnpm-lock.yaml`,
				},
			},
			head: {
				status: 'ok',
				branchContext: 'refs/heads/main',
				gitDir: `${worktree}/.git`,
				commonDir: `${worktree}/.git`,
			},
		} as unknown as SupabaseWorktreeFacts;
		const observed = {
			...managed,
			worktreePath: `${worktree}-2`,
			realWorktreePath: `${worktree}-2`,
			mode: { value: 'observed' },
		} as unknown as SupabaseWorktreeFacts;
		const roots = supabaseSteeringRoots({
			facts: [managed, { ...managed, appPath: `${worktree}/app` }, observed],
			stacks: [{ id: 'a'.repeat(64), state: 'running' }],
		});
		expect(roots).toEqual([
			{
				root: worktree,
				projectRoot: worktree,
				branchContext: 'refs/heads/main',
				stackReady: true,
				runner: 'pnpm exec supabase',
			},
		]);
	});
});

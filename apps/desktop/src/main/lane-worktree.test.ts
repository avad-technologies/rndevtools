import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	createWorktreeInspector,
	parseWorktreeList,
	readExpoIdentity,
} from './lane-worktree';
import {
	SimulatorCommandError,
	type SimulatorCommandResult,
} from './simulator-command-runner';

describe('worktree inspector', () => {
	const WORKTREES = Array.from({ length: 10 }, (_, index) => ({
		path: index === 0 ? '/Users/dev/app' : `/Users/dev/app-${index}`,
		branch: index === 0 ? 'main' : `feature-${index}`,
	}));
	const LIST = WORKTREES.map(
		(worktree) =>
			`worktree ${worktree.path}\nHEAD ${'0'.repeat(40)}\nbranch refs/heads/${worktree.branch}\n`
	).join('\n');

	/** git through a fake runner: `status` answers per worktree path. */
	function inspector(status: (cwd: string) => Promise<SimulatorCommandResult>) {
		let clock = 1_000;
		let running = 0;
		const calls = { statuses: [] as string[][], mostAtOnce: 0 };
		const worktrees = createWorktreeInspector({
			now: () => clock,
			runCommand: async (_executable, args) => {
				const cwd = args[1] as string;
				if (args.includes('worktree')) {
					return { stdout: LIST, stderr: '', exitCode: 0 };
				}
				calls.statuses.push([...args]);
				running += 1;
				calls.mostAtOnce = Math.max(calls.mostAtOnce, running);
				try {
					await new Promise((resolve) => setTimeout(resolve, 5));
					return await status(cwd);
				} finally {
					running -= 1;
				}
			},
		});
		return {
			worktrees,
			calls,
			advance: (ms: number) => {
				clock += ms;
			},
		};
	}

	const clean = async () => ({ stdout: '', stderr: '', exitCode: 0 });

	it('asks git status without optional locks, a few worktrees at a time', async () => {
		const { worktrees, calls } = inspector(async (cwd) => ({
			stdout: cwd.endsWith('-3') ? ' M App.tsx\n' : '',
			stderr: '',
			exitCode: 0,
		}));
		const listed = await worktrees.listWorktrees('/Users/dev/app');
		expect(listed.map((worktree) => worktree.dirty)).toEqual(
			WORKTREES.map((worktree) => worktree.path.endsWith('-3'))
		);
		expect(calls.statuses[0]).toEqual([
			'-C',
			'/Users/dev/app',
			'--no-optional-locks',
			'status',
			'--porcelain',
			'--untracked-files=no',
		]);
		expect(calls.statuses).toHaveLength(WORKTREES.length);
		expect(calls.mostAtOnce).toBeLessThanOrEqual(4);
	});

	it('reuses dirty flags between polls for a while, and asks git again when fresh', async () => {
		const { worktrees, calls, advance } = inspector(clean);
		await worktrees.listWorktrees('/Users/dev/app');
		advance(10_000);
		await worktrees.listWorktrees('/Users/dev/app');
		expect(calls.statuses).toHaveLength(WORKTREES.length);
		await worktrees.listWorktrees('/Users/dev/app', { fresh: true });
		expect(calls.statuses).toHaveLength(2 * WORKTREES.length);
		advance(30_000);
		await worktrees.listWorktrees('/Users/dev/app');
		expect(calls.statuses).toHaveLength(3 * WORKTREES.length);
	});

	it('reads a status too long to hold as dirty, and one that cannot run as clean', async () => {
		const { worktrees } = inspector(async (cwd) => {
			if (cwd.endsWith('-1')) {
				throw new SimulatorCommandError('git exceeded its output limit.', {
					kind: 'output-limit',
				});
			}
			if (cwd.endsWith('-2')) {
				throw new SimulatorCommandError('git timed out.', { kind: 'timeout' });
			}
			return { stdout: '', stderr: '', exitCode: 0 };
		});
		const listed = await worktrees.listWorktrees('/Users/dev/app');
		expect(listed[1]).toMatchObject({ path: '/Users/dev/app-1', dirty: true });
		expect(listed[2]).toMatchObject({ path: '/Users/dev/app-2', dirty: false });
	});
});

describe('parseWorktreeList', () => {
	it('parses porcelain output into checkouts with branch names', () => {
		const output = [
			'worktree /Users/dev/app',
			'HEAD 0123456789abcdef0123456789abcdef01234567',
			'branch refs/heads/main',
			'',
			'worktree /Users/dev/app-feature-a',
			'HEAD 89abcdef0123456789abcdef0123456789abcdef',
			'branch refs/heads/feature/a',
			'',
			'worktree /Users/dev/app-detached',
			'HEAD 89abcdef0123456789abcdef0123456789abcdef',
			'detached',
			'',
		].join('\n');
		expect(parseWorktreeList(output, '/Users/dev/app')).toEqual([
			{
				path: '/Users/dev/app',
				branch: 'main',
				repositoryRoot: '/Users/dev/app',
			},
			{
				path: '/Users/dev/app-feature-a',
				branch: 'feature/a',
				repositoryRoot: '/Users/dev/app',
			},
			{
				path: '/Users/dev/app-detached',
				branch: 'detached',
				repositoryRoot: '/Users/dev/app',
			},
		]);
	});

	it('tolerates output without a trailing blank line', () => {
		expect(
			parseWorktreeList(
				'worktree /Users/dev/app\nbranch refs/heads/main',
				'/Users/dev/app'
			)
		).toHaveLength(1);
	});
});

describe('readExpoIdentity', () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), 'rndevtools-worktree-'));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it('reads scheme and bundle identifier from app.json', async () => {
		await writeFile(
			path.join(root, 'app.json'),
			JSON.stringify({
				expo: {
					slug: 'example',
					scheme: 'exampleapp',
					ios: { bundleIdentifier: 'com.example.app' },
				},
			})
		);
		expect(await readExpoIdentity(root)).toEqual({
			scheme: 'exampleapp',
			bundleIdentifier: 'com.example.app',
		});
	});

	it('falls back to exp+slug when no scheme is declared and takes the first of several', async () => {
		await writeFile(
			path.join(root, 'app.json'),
			JSON.stringify({ expo: { slug: 'example' } })
		);
		expect(await readExpoIdentity(root)).toEqual({ scheme: 'exp+example' });
		await writeFile(
			path.join(root, 'app.json'),
			JSON.stringify({ expo: { slug: 'example', scheme: ['one', 'two'] } })
		);
		expect((await readExpoIdentity(root)).scheme).toBe('one');
	});

	it('derives the dev client scheme from the slug the way Expo does', async () => {
		const scheme = async (expo: Record<string, unknown>) => {
			await writeFile(path.join(root, 'app.json'), JSON.stringify({ expo }));
			return (await readExpoIdentity(root)).scheme;
		};
		// expo-dev-client's getDefaultScheme: drop what a URI scheme cannot
		// hold, lowercase, prefix exp+. That is the scheme the dev client has.
		expect(await scheme({ slug: 'my_app' })).toBe('exp+myapp');
		expect(await scheme({ slug: 'My App (Beta)' })).toBe('exp+myappbeta');
		expect(await scheme({ slug: 'example.app-2' })).toBe('exp+example.app-2');
		// Nothing URL-friendly left: Expo registers no default scheme either.
		expect(await scheme({ slug: '___' })).toBeUndefined();
		// A declared scheme the lane record cannot hold yields to a valid one.
		expect(await scheme({ slug: 'my_app', scheme: 'my_app' })).toBe(
			'exp+myapp'
		);
		expect(
			await scheme({ slug: 'demo', scheme: ['bad_one', 'good-one'] })
		).toBe('good-one');
		// Too long for a lane scheme: left out instead of failing the start.
		expect(await scheme({ slug: 'a'.repeat(60) })).toBe(
			`exp+${'a'.repeat(60)}`
		);
		expect(await scheme({ slug: 'a'.repeat(61) })).toBeUndefined();
	});

	it('returns nothing for a worktree without static Expo config', async () => {
		expect(await readExpoIdentity(root)).toEqual({});
		await writeFile(path.join(root, 'app.json'), '{ not json');
		expect(await readExpoIdentity(root)).toEqual({});
	});
});

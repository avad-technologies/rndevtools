import { mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	createEngineHarness,
	disposeEngineHarnesses,
} from './engine.test-support';

afterEach(disposeEngineHarnesses);

async function monorepo() {
	const h = await createEngineHarness({ enabled: true, start: false });
	const repo = await h.repository('repo', { lockfile: true });
	const mobile = path.join(repo, 'apps', 'mobile');
	const admin = path.join(repo, 'apps', 'admin');
	await mkdir(mobile, { recursive: true });
	await mkdir(path.join(admin, 'supabase'), { recursive: true });
	await rename(path.join(repo, 'supabase'), path.join(mobile, 'supabase'));
	await writeFile(
		path.join(admin, 'supabase', 'config.toml'),
		'[experimental]\nstack = true\n'
	);
	await h.engine.start();
	await h.engine.settle();
	return { h, repo, mobile, admin };
}

describe('Supabase projects inside a monorepo', () => {
	it('follows a branch switch separately for each held app project', async () => {
		const { h, repo, mobile, admin } = await monorepo();
		const targets = [mobile, admin];
		for (const [index, app] of targets.entries()) {
			await h.engine.runAgentOperation(
				{ operation: 'up', target: { worktreePath: app }, waitMs: 45_000 },
				{
					requestId: `follow-${index}`,
					holder: { kind: 'other', sessionId: `app-${index}` },
					synthetic: false,
				},
				new AbortController().signal
			);
		}
		const oldIds = await Promise.all(targets.map((app) => h.identity(app)));
		await h.checkout(repo, 'feature');
		const newIds = await Promise.all(targets.map((app) => h.identity(app)));
		await h.advance(46_000);
		for (const [index, id] of newIds.entries()) {
			expect(h.cli.stacks.get(id)?.running).toBe(true);
			expect(h.engine.stackStore.record(id)?.holds).toEqual([
				expect.objectContaining({
					agent: { kind: 'other', sessionId: `app-${index}`, synthetic: false },
				}),
			]);
			expect(h.cli.stacks.get(oldIds[index] ?? '')?.running).toBe(false);
		}
		expect(h.cli.running()).toHaveLength(2);
	});

	it('keeps a session hold on each app and releases only the app named by down', async () => {
		const { h, mobile, admin } = await monorepo();
		const holder = { kind: 'other', sessionId: 'review-agent' } as const;
		const context = { requestId: 'monorepo-holds', holder, synthetic: false };
		for (const app of [mobile, admin]) {
			await h.engine.runAgentOperation(
				{ operation: 'up', target: { worktreePath: app }, waitMs: 45_000 },
				context,
				new AbortController().signal
			);
		}
		const mobileId = await h.identity(mobile);
		const adminId = await h.identity(admin);
		for (const id of [mobileId, adminId]) {
			expect(h.engine.stackStore.record(id)?.holds).toContainEqual(
				expect.objectContaining({ agent: { ...holder, synthetic: false } })
			);
		}
		await h.engine.runAgentOperation(
			{ operation: 'down', target: { worktreePath: mobile } },
			context,
			new AbortController().signal
		);
		expect(h.engine.stackStore.record(mobileId)?.holds).toEqual([]);
		expect(h.engine.stackStore.record(adminId)?.holds).toContainEqual(
			expect.objectContaining({ agent: { ...holder, synthetic: false } })
		);
	});

	it('starts the first required lane from its app before the lane exists', async () => {
		const { h, repo, mobile } = await monorepo();
		expect(h.lanes.lanes).toEqual([]);
		const result = await h.engine.ensureForLane({
			worktreePath: repo,
			appPath: mobile,
			branch: 'main',
			environmentId: 'development',
			policy: 'required',
			waitMs: 45_000,
		});
		expect(result.summary).toMatchObject({
			status: 'ready',
			stackId: await h.identity(mobile),
		});
		expect(result.laneEnv?.EXPO_PUBLIC_SUPABASE_URL).toMatch(
			/^http:\/\/127\.0\.0\.1:/
		);
		await h.engine.refreshRepositories();
		expect(await h.engine.worktreeFacts(repo, mobile)).toMatchObject({
			worktreePath: repo,
			appPath: mobile,
			detection: { projectRoot: mobile },
		});
	});

	it('starts distinct app targets through the agent API without existing lanes', async () => {
		const { h, repo, mobile, admin } = await monorepo();
		for (const app of [mobile, admin]) {
			const stackId = await h.identity(app);
			await expect(
				h.engine.runAgentOperation(
					{ operation: 'up', target: { worktreePath: app }, waitMs: 45_000 },
					{ requestId: 'monorepo', synthetic: false },
					new AbortController().signal
				)
			).resolves.toMatchObject({
				operation: 'up',
				stack: {
					id: stackId,
					status: 'ready',
					worktreePath: repo,
					projectRoot: app,
				},
			});
		}
		expect(h.cli.running()).toHaveLength(2);
		await h.engine.refreshRepositories();
		expect(await h.engine.worktreeFacts(mobile)).toMatchObject({
			appPath: mobile,
			expectedStackId: await h.identity(mobile),
		});
		expect(await h.engine.worktreeFacts(admin)).toMatchObject({
			appPath: admin,
			expectedStackId: await h.identity(admin),
		});
	});

	it('does not substitute a known sibling project for an app with no config', async () => {
		const { h, repo, mobile } = await monorepo();
		await h.engine.worktreeFacts(mobile);
		const plain = path.join(repo, 'apps', 'plain');
		await mkdir(plain);
		expect(await h.engine.worktreeFacts(plain)).toMatchObject({
			appPath: plain,
			detection: { status: 'none', reason: 'no-config' },
		});
	});

	it('prefers a nested project over a known checkout-root project', async () => {
		const { h, repo, mobile } = await monorepo();
		await mkdir(path.join(repo, 'supabase'));
		await writeFile(
			path.join(repo, 'supabase', 'config.toml'),
			'[experimental]\nstack = true\n'
		);
		await h.engine.refreshRepositories();
		expect(await h.engine.worktreeFacts(repo, mobile)).toMatchObject({
			appPath: mobile,
			detection: { projectRoot: mobile },
			expectedStackId: await h.identity(mobile),
		});
	});

	it('keeps app-specific dotenv checks when apps share an ancestor project', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		const mobile = path.join(repo, 'apps', 'mobile');
		const admin = path.join(repo, 'apps', 'admin');
		await mkdir(mobile, { recursive: true });
		await mkdir(admin, { recursive: true });
		await writeFile(
			path.join(admin, '.env'),
			'EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321\n'
		);
		await h.engine.start();
		const mobileFacts = await h.engine.worktreeFacts(mobile);
		const adminFacts = await h.engine.worktreeFacts(admin);
		expect(mobileFacts).toMatchObject({
			appPath: mobile,
			detection: { projectRoot: repo, shadowedAppVariables: [] },
		});
		expect(adminFacts).toMatchObject({
			appPath: admin,
			detection: {
				projectRoot: repo,
				shadowedAppVariables: [{ name: 'EXPO_PUBLIC_SUPABASE_URL' }],
			},
		});
		expect(adminFacts?.expectedStackId).toBe(mobileFacts?.expectedStackId);
	});

	it('discovers an app before its checkout is tracked by Lanes', async () => {
		const { h, repo, mobile } = await monorepo();
		h.lanes.repositories.length = 0;
		h.lanes.worktrees.length = 0;
		await h.engine.refreshRepositories();
		expect(await h.engine.worktreeFacts(mobile)).toMatchObject({
			worktreePath: repo,
			appPath: mobile,
			expectedStackId: await h.identity(mobile),
		});
	});

	it('refuses an app outside its checkout, including a symlink escape', async () => {
		const { h, repo, mobile } = await monorepo();
		await h.engine.worktreeFacts(mobile);
		const other = await h.repository('other');
		expect(await h.engine.worktreeFacts(repo, other)).toBeUndefined();
		const escapedApp = path.join(repo, 'apps', 'escape');
		await symlink(other, escapedApp, 'dir');
		expect(await h.engine.worktreeFacts(repo, escapedApp)).toBeUndefined();
	});

	it('matches an app with no config through a tracked checkout symlink', async () => {
		const { h, repo } = await monorepo();
		const alias = path.join(h.base, 'repo-alias');
		await symlink(repo, alias, 'dir');
		h.lanes.repositories[0] = alias;
		h.lanes.worktrees[0] = {
			path: alias,
			repositoryRoot: alias,
			branch: 'main',
			dirty: false,
		};
		const plain = path.join(alias, 'apps', 'plain');
		await mkdir(plain);
		await h.engine.refreshRepositories();
		expect(await h.engine.worktreeFacts(plain)).toMatchObject({
			worktreePath: alias,
			appPath: plain,
			detection: { status: 'none', reason: 'no-config' },
		});
	});

	it('includes an app requested during an in-flight repository refresh', async () => {
		const { h, mobile, admin } = await monorepo();
		await h.engine.worktreeFacts(mobile);
		let entered: () => void = () => undefined;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const resolveCli = h.resolver.resolve.bind(h.resolver);
		let first = true;
		h.resolver.resolve = async (input) => {
			if (first) {
				first = false;
				entered();
				await held;
			}
			return resolveCli(input);
		};
		const refresh = h.engine.refreshRepositories();
		await started;
		const facts = h.engine.worktreeFacts(admin);
		release();
		await refresh;
		expect(await facts).toMatchObject({
			appPath: admin,
			detection: { projectRoot: admin },
			expectedStackId: await h.identity(admin),
		});
	});
});

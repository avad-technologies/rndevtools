import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Lane, LaneWorktree } from '../../shared/lane-protocol';
import {
	SUPABASE_POLICY_DEFAULTS,
	supabaseRepositorySummarySchema,
} from '../../shared/supabase-protocol';
import { realisticSecrets, SECRET_SHAPED } from './cli-fixtures.test-support';
import type {
	SupabaseCliResolution,
	SupabaseCliResolveInput,
} from './cli-resolver';
import { resolveSupabaseDialect } from './dialect';
import { expectedStackId } from './identity';
import type { SupabaseProjectDetection } from './project';
import {
	inspectSupabaseRepositories,
	type SupabaseRepositoryFacts,
	summarizeSupabaseRepository,
	supabaseFactsForLane,
	supabaseRepositoryId,
	supabaseWorktreeMode,
} from './repositories';

const NOW = 1_792_245_785_000;
const PLATFORM = { supported: true, arch: 'arm64', macosVersion: '15.1' };

let base = '';

beforeEach(async () => {
	base = await realpath(
		await mkdtemp(path.join(tmpdir(), 'rndevtools-supabase-repos-'))
	);
});

afterEach(async () => {
	await rm(base, { recursive: true, force: true });
});

async function write(file: string, contents: string): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, contents);
}

const CONFIG = [
	'project_id = "example-app"',
	'',
	'[api]',
	'port = 54321',
	'',
	'[experimental]',
	'stack = true',
	'',
	'[storage.buckets.avatars]',
	'public = true',
	'',
	'[studio]',
	'enabled = false',
	'',
].join('\n');

function verified(version = '2.121.0'): SupabaseCliResolution {
	return {
		ok: true,
		cli: {
			binaryPath: `${base}/repo/node_modules/@supabase/cli-darwin-arm64/bin/supabase`,
			binaryDirectory: `${base}/repo/node_modules/@supabase/cli-darwin-arm64/bin`,
			packageRoot: `${base}/repo/node_modules/supabase`,
			platformPackageRoot: `${base}/repo/node_modules/@supabase/cli-darwin-arm64`,
			version,
			dialect: resolveSupabaseDialect(version),
			fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
		},
	};
}

const MISSING: SupabaseCliResolution = {
	ok: false,
	reason: 'not-installed',
	message: 'CLI not installed in this worktree',
	recovery: 'Install dependencies in this worktree.',
	path: undefined,
};

/** A main checkout with a Supabase project, a linked worktree and a plain repository. */
async function fixture(): Promise<{
	repo: string;
	worktree: string;
	site: string;
	worktrees: LaneWorktree[];
	lanes: Lane[];
	secret: string;
}> {
	const repo = path.join(base, 'repo');
	const worktree = path.join(base, 'repo-wt', 'feat-x');
	const site = path.join(base, 'site');
	const secret = realisticSecrets().publishableKey;
	await write(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
	await write(path.join(repo, 'supabase', 'config.toml'), CONFIG);
	await write(
		path.join(repo, 'supabase', 'migrations', '20261016000000_notes.sql'),
		'select 1;'
	);
	await write(
		path.join(repo, 'supabase', 'migrations', '20261017000000_tags.sql'),
		'select 2;'
	);
	await write(path.join(repo, 'supabase', 'migrations', 'README.md'), '#');
	await write(path.join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
	await write(
		path.join(repo, '.env.local'),
		`OTHER=1\nEXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${secret}\n`
	);
	const gitdir = path.join(repo, '.git', 'worktrees', 'feat-x');
	await write(path.join(gitdir, 'HEAD'), 'ref: refs/heads/feat-x\n');
	await write(path.join(gitdir, 'commondir'), '../..\n');
	await write(path.join(gitdir, 'rebase-merge', 'done'), '');
	await write(path.join(worktree, '.git'), `gitdir: ${gitdir}\n`);
	await write(
		path.join(worktree, 'supabase', 'config.toml'),
		CONFIG.replace('stack = true', 'stack = false')
	);
	await write(path.join(site, '.git', 'HEAD'), 'ref: refs/heads/main\n');
	return {
		repo,
		worktree,
		site,
		secret,
		worktrees: [
			{ path: repo, branch: 'main', repositoryRoot: repo, dirty: false },
			{ path: worktree, branch: 'feat-x', repositoryRoot: repo, dirty: false },
			{ path: site, branch: 'main', repositoryRoot: site, dirty: false },
		],
		lanes: [
			{
				id: 'lane-c69dc564-b12e-45d5-b0d5-3e9d034a072d',
				worktreePath: worktree,
				branch: 'feat-x',
				simulatorUdid: '380DAF54-343E-4E1B-BE43-1B116A9D03C4',
				environment: 'development',
				port: 8_102,
				metro: 'ready',
				logPath: path.join(base, 'lane.log'),
				startedAt: NOW,
			},
		],
	};
}

function found(
	overrides: Partial<
		Extract<SupabaseProjectDetection, { status: 'found' }>
	> = {}
): SupabaseProjectDetection {
	return {
		status: 'found',
		appRoot: '/Users/example/code/example-app',
		worktreeRoot: '/Users/example/code/example-app',
		projectRoot: '/Users/example/code/example-app',
		configPath: '/Users/example/code/example-app/supabase/config.toml',
		stackFlag: { optedIn: true, line: 7 },
		configConflict: false,
		pinnedListeners: [],
		shadowedAppVariables: [],
		fileIssues: [],
		...overrides,
	};
}

describe('supabaseRepositoryId', () => {
	it('is repo- plus 12 hex of the realpath digest', () => {
		const id = supabaseRepositoryId('/Users/example/code/example-app');
		expect(id).toMatch(/^repo-[0-9a-f]{12}$/);
		expect(supabaseRepositoryId('/Users/example/code/example-app')).toBe(id);
		expect(supabaseRepositoryId('/Users/example/code/example-admin')).not.toBe(
			id
		);
	});
});

describe('supabaseWorktreeMode', () => {
	const mode = (
		overrides: Partial<Parameters<typeof supabaseWorktreeMode>[0]> = {}
	) =>
		supabaseWorktreeMode({
			featureEnabled: true,
			platformSupported: true,
			repositoryMode: 'auto',
			detection: found(),
			cli: verified(),
			...overrides,
		});

	it('is managed only when everything lines up', () => {
		expect(mode()).toEqual({ value: 'managed' });
		expect(mode({ featureEnabled: false })).toEqual({
			value: 'off',
			reasonText: 'local Supabase is off',
		});
		expect(mode({ repositoryMode: 'off' })).toEqual({
			value: 'off',
			reasonText: 'turned off for this repository',
		});
		expect(mode({ detection: undefined }).value).toBe('observed');
		expect(
			mode({ detection: { status: 'none', reason: 'no-config' } })
		).toEqual({ value: 'off', reasonText: 'no supabase/config.toml' });
		expect(mode({ platformSupported: false }).value).toBe('observed');
		expect(
			mode({
				detection: found({ stackFlag: { optedIn: false, reason: 'missing' } }),
			})
		).toEqual({ value: 'observed', reasonText: 'stack flag missing' });
		expect(mode({ detection: found({ configConflict: true }) })).toEqual({
			value: 'observed',
			reasonText: 'supabase/config.json conflicts with config.toml',
		});
		expect(mode({ cli: undefined })).toEqual({
			value: 'observed',
			reasonText: 'still checking the Supabase CLI',
		});
		expect(mode({ cli: MISSING })).toEqual({
			value: 'observed',
			reasonText: 'CLI not installed in this worktree',
		});
		expect(mode({ cli: verified('2.121.3') })).toEqual({
			value: 'observed',
			reasonText: "Supabase CLI 2.121.3 isn't verified",
		});
		expect(mode({ cli: verified('2.122.0') }).value).toBe('observed');
	});
});

describe('inspectSupabaseRepositories', () => {
	it('retains every recorded app project when no lane is running', async () => {
		const { repo, worktrees } = await fixture();
		const apps = ['mobile', 'admin'].map((name) =>
			path.join(repo, 'apps', name)
		);
		for (const app of apps) {
			await write(
				path.join(app, 'supabase', 'config.toml'),
				'[experimental]\nstack = true\n'
			);
		}
		const [facts] = await inspectSupabaseRepositories({
			repositories: [repo],
			worktrees: worktrees.slice(0, 1),
			lanes: [],
			appPaths: apps.map((appPath) => ({ worktreePath: repo, appPath })),
			policy: SUPABASE_POLICY_DEFAULTS,
			featureEnabled: true,
			platformSupported: true,
			resolveCli: async () => verified(),
			now: NOW,
		});
		expect(facts?.worktrees).toHaveLength(2);
		for (const app of apps) {
			expect(
				facts?.worktrees.find((entry) => entry.appPath === app)
			).toMatchObject({
				detection: { projectRoot: app },
				expectedStackId: expectedStackId({
					projectRoot: app,
					branchContext: 'refs/heads/main',
				}),
			});
		}
	});

	it('reads each worktree once, statically, and resolves its CLI', async () => {
		const { repo, worktree, site, worktrees, lanes } = await fixture();
		const calls: SupabaseCliResolveInput[] = [];
		const facts = await inspectSupabaseRepositories({
			repositories: [repo, site, repo],
			worktrees,
			lanes,
			policy: SUPABASE_POLICY_DEFAULTS,
			featureEnabled: true,
			platformSupported: true,
			resolveCli: async (input) => {
				calls.push(input);
				return input.worktreeRoot === repo ? verified() : MISSING;
			},
			now: NOW,
		});
		expect(facts.map((entry) => entry.root)).toEqual([repo, site]);
		const [app, plain] = facts as [
			SupabaseRepositoryFacts,
			SupabaseRepositoryFacts,
		];
		expect(app.id).toBe(supabaseRepositoryId(repo));
		expect(app.mode).toBe('auto');
		expect(app.checkedAt).toBe(NOW);
		const main = app.worktrees.find((entry) => entry.worktreePath === repo);
		const linked = app.worktrees.find(
			(entry) => entry.worktreePath === worktree
		);
		expect(main).toMatchObject({
			appPath: repo,
			exists: true,
			mode: { value: 'managed' },
			bucketsConfigured: true,
			migrationCount: 2,
			expectedStackId: expectedStackId({
				projectRoot: repo,
				branchContext: 'refs/heads/main',
			}),
		});
		expect(main?.head).toMatchObject({
			status: 'ok',
			branchContext: 'refs/heads/main',
		});
		expect(main?.detection).toMatchObject({
			status: 'found',
			stackFlag: { optedIn: true, line: 7 },
			runner: { command: 'pnpm exec' },
			pinnedListeners: [{ key: 'api.port', port: 54321, line: 4 }],
		});
		expect(linked).toMatchObject({
			mode: { value: 'observed', reasonText: 'stack flag is false' },
			head: {
				status: 'ok',
				branchContext: 'refs/heads/feat-x',
				operation: 'rebase-merge',
			},
		});
		// The linked worktree's CLI may come from the main checkout.
		expect(calls).toEqual(
			expect.arrayContaining([
				{
					appPath: repo,
					projectRoot: repo,
					worktreeRoot: repo,
					allowUnverifiedPatch: false,
				},
				{
					appPath: worktree,
					projectRoot: worktree,
					worktreeRoot: worktree,
					mainCheckoutRoot: repo,
					allowUnverifiedPatch: false,
				},
			])
		);
		expect(plain.worktrees).toHaveLength(1);
		expect(plain.worktrees[0]).toMatchObject({
			mode: { value: 'off', reasonText: 'no supabase/config.toml' },
			bucketsConfigured: false,
			migrationCount: 0,
		});
		expect(plain.worktrees[0]?.expectedStackId).toBeUndefined();
		expect(calls).toHaveLength(2);

		expect(supabaseFactsForLane(lanes[0] as Lane, facts)?.worktreePath).toBe(
			worktree
		);
		expect(
			supabaseFactsForLane(
				{ worktreePath: '/nowhere', appPath: undefined },
				facts
			)
		).toBeUndefined();
	});

	it('reads nothing for a repository that is off', async () => {
		const { repo, worktrees, lanes } = await fixture();
		let resolved = 0;
		const [app] = await inspectSupabaseRepositories({
			repositories: [repo],
			worktrees,
			lanes,
			policy: {
				...SUPABASE_POLICY_DEFAULTS,
				repositories: [{ id: supabaseRepositoryId(repo), mode: 'off' }],
			},
			featureEnabled: true,
			platformSupported: true,
			resolveCli: async () => {
				resolved += 1;
				return verified();
			},
			now: NOW,
		});
		expect(app?.mode).toBe('off');
		for (const entry of app?.worktrees ?? []) {
			expect(entry.detection).toBeUndefined();
			expect(entry.head).toBeUndefined();
			expect(entry.mode).toEqual({
				value: 'off',
				reasonText: 'turned off for this repository',
			});
		}
		expect(resolved).toBe(0);
	});

	it('treats a resolver that throws as a failed CLI check', async () => {
		const { repo, worktrees, lanes } = await fixture();
		const [app] = await inspectSupabaseRepositories({
			repositories: [repo],
			worktrees: worktrees.slice(0, 1),
			lanes,
			policy: SUPABASE_POLICY_DEFAULTS,
			featureEnabled: true,
			platformSupported: true,
			resolveCli: async () => {
				throw new TypeError('appPath must be inside the worktree root.');
			},
			now: NOW,
		});
		expect(app?.worktrees[0]?.mode).toEqual({
			value: 'observed',
			reasonText: 'the Supabase CLI could not be checked',
		});
	});
});

describe('summarizeSupabaseRepository', () => {
	it('reports readiness with file:line facts and copy-only fixes', async () => {
		const { repo, worktree, site, worktrees, lanes, secret } = await fixture();
		const facts = await inspectSupabaseRepositories({
			repositories: [repo, site],
			worktrees,
			lanes,
			policy: SUPABASE_POLICY_DEFAULTS,
			featureEnabled: true,
			platformSupported: true,
			resolveCli: async (input) =>
				input.worktreeRoot === repo ? verified() : MISSING,
			now: NOW,
		});
		const [app, plain] = facts as [
			SupabaseRepositoryFacts,
			SupabaseRepositoryFacts,
		];
		const mainId = app.worktrees.find(
			(entry) => entry.worktreePath === repo
		)?.expectedStackId;
		const summary = summarizeSupabaseRepository(app, {
			platform: PLATFORM,
			featureEnabled: true,
			stacks: [
				{
					id: mainId as string,
					state: 'running',
					repositoryId: app.id,
					worktreePath: repo,
					branchContext: 'refs/heads/main',
					flags: [],
				},
				{
					id: 'a'.repeat(64),
					state: 'stopped',
					repositoryId: app.id,
					worktreePath: worktree,
					branchContext: 'refs/heads/feat-old',
					flags: ['stale-branch'],
				},
			],
			pathLabel: (value) => value.replace(base, '~/code'),
		});
		expect(supabaseRepositorySummarySchema.parse(summary)).toEqual(summary);
		expect(summary).toMatchObject({
			id: app.id,
			label: '~/code/repo',
			readiness: 'needs-fix',
			mode: 'auto',
			counts: { worktrees: 2, managed: 1, observed: 1, running: 1 },
			cli: {
				version: '2.121.0',
				gate: 'verified',
				runnerLabel: 'pnpm exec supabase',
			},
		});
		const checks = Object.fromEntries(
			summary.checks.map((check) => [check.id, check])
		);
		expect(Object.keys(checks)).toEqual([
			'platform',
			'project',
			'stack-flag',
			'config-json',
			'pinned-ports',
			'cli',
			'app-env-files',
			'recommended',
		]);
		expect(checks.platform).toMatchObject({
			status: 'ready',
			summary: 'Apple silicon · macOS 15.1',
		});
		expect(checks['stack-flag']).toMatchObject({
			status: 'needs-fix',
			summary: 'Not set to true in feat-x.',
			lines: [{ file: 'supabase/config.toml', line: 7, text: 'stack = false' }],
			fix: { snippet: '[experimental]\nstack = true' },
		});
		expect(checks['pinned-ports']).toMatchObject({
			status: 'needs-fix',
			lines: [
				{ file: 'supabase/config.toml', line: 4, text: 'api.port = 54321' },
			],
		});
		expect(checks.cli).toMatchObject({
			status: 'ready',
			summary: '2.121.0 · verified · pnpm exec supabase',
		});
		expect(checks['app-env-files']).toMatchObject({
			status: 'check',
			summary: '.env.local:2 shadows a mapped name',
			lines: [
				{
					file: '.env.local',
					line: 2,
					text: 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=…',
				},
			],
		});
		expect(checks.recommended).toMatchObject({ status: 'optional' });
		expect(summary.worktrees).toEqual([
			{
				pathLabel: '~/code/repo',
				branch: 'main',
				mode: 'managed',
				stackId: mainId,
			},
			{
				pathLabel: '~/code/repo-wt/feat-x',
				branch: 'feat-x',
				mode: 'observed',
				reasonText: 'stack flag is false',
			},
		]);
		// Dotenv values never leave main.
		const text = JSON.stringify(summary);
		expect(text).not.toContain(secret);
		expect(text).not.toMatch(SECRET_SHAPED);

		const none = summarizeSupabaseRepository(plain, {
			platform: PLATFORM,
			featureEnabled: true,
			stacks: [],
			pathLabel: (value) => value,
		});
		expect(none.readiness).toBe('no-supabase');
		expect(none.checks.map((check) => [check.id, check.status])).toEqual([
			['platform', 'ready'],
			['project', 'optional'],
		]);
		expect(none.cli).toEqual({});
	});

	it('reads off, observed and unsupported repositories', async () => {
		const { repo, worktrees, lanes } = await fixture();
		const [app] = await inspectSupabaseRepositories({
			repositories: [repo],
			worktrees: worktrees.slice(0, 1),
			lanes,
			policy: SUPABASE_POLICY_DEFAULTS,
			featureEnabled: true,
			platformSupported: true,
			resolveCli: async () => verified('2.122.0'),
			now: NOW,
		});
		const facts = app as SupabaseRepositoryFacts;
		const observed = summarizeSupabaseRepository(facts, {
			platform: PLATFORM,
			featureEnabled: true,
			stacks: [],
			pathLabel: (value) => value,
		});
		expect(observed.readiness).toBe('observed');
		expect(observed.checks.find((check) => check.id === 'cli')).toMatchObject({
			status: 'needs-fix',
			summary: "2.122.0 isn't verified for RN Devtools",
		});
		expect(observed.worktrees[0]?.stackId).toBeUndefined();

		const unsupported = summarizeSupabaseRepository(facts, {
			platform: {
				supported: false,
				arch: 'x64',
				macosVersion: '13.6',
				reasonText:
					'Native Supabase needs Apple silicon and macOS 14 or later.',
			},
			featureEnabled: true,
			stacks: [],
			pathLabel: (value) => value,
		});
		expect(unsupported.checks[0]).toMatchObject({
			id: 'platform',
			status: 'needs-fix',
		});
		expect(
			summarizeSupabaseRepository(
				{ ...facts, mode: 'off' },
				{
					platform: PLATFORM,
					featureEnabled: true,
					stacks: [],
					pathLabel: (value) => value,
				}
			).readiness
		).toBe('off');
	});
});

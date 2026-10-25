import { execFile } from 'node:child_process';
import {
	access,
	chmod,
	copyFile,
	link,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Lane, LaneWorktree } from '../../shared/lane-protocol';
import {
	laneBackendSummarySchema,
	type SupabaseOperation,
	type SupabaseOperationReceipt,
	supabaseAgentResultSchema,
	supabaseOperationSchema,
	supabaseStateSchema,
} from '../../shared/supabase-protocol';
import { SupabaseEngine } from './service-engine';
import type {
	SupabaseOperationContext,
	SupabaseServiceDeps,
} from './service-ports';
import { supabasePlatformAvailability } from './supabase-service';

/**
 * Opt-in: drives the real Supabase service (runner, resolver, discovery,
 * stores and jobs) against a real Supabase CLI platform binary.
 *
 *   RNDEVTOOLS_SUPABASE_IT_BIN=/abs/path/to/@supabase/cli-darwin-arm64/bin/supabase \
 *   RNDEVTOOLS_SUPABASE_IT_HOME=/abs/scratch/supabase-home \
 *   pnpm --filter @rndevtools/desktop exec vitest run src/main/supabase/supabase-service.integration.test.ts
 *
 * It builds a scratch git repository and a second worktree (`git worktree
 * add`) whose supabase/config.toml opts into the stack backend, pins no ports
 * and turns Studio and analytics off, with a migration and a seed, and
 * installs the binary into each worktree's node_modules. Then, through the
 * service only: turn on, start, status and inspection, logs, the database
 * read, a migration added at runtime, a reset, copy and open with fake
 * clipboard and shell ports, a lane ensure on the second worktree, an agent's
 * up, env and down, stop, and destroy with the uploads. Every stack it
 * started is stopped and destroyed at the end, even when a step fails. The
 * first start downloads service artifacts into SUPABASE_HOME, which can take
 * minutes.
 */

const BINARY = process.env.RNDEVTOOLS_SUPABASE_IT_BIN ?? '';
const SUPABASE_HOME = process.env.RNDEVTOOLS_SUPABASE_IT_HOME ?? '';
const enabled = BINARY !== '' && SUPABASE_HOME !== '';
const execFileAsync = promisify(execFile);
const STEP_TIMEOUT_MS = 240_000;
const START_TIMEOUT_MS = 420_000;
const SECRET_SHAPED =
	/sb_secret_|eyJ[\w-]+\.[\w-]+|postgres(?:ql)?:\/\/[^\s"]*:[^\s"@]+@|SERVICE_ROLE|SECRET_KEY/;
const LANE_ID = 'lane-11111111-2222-4333-8444-555555555555';
const OPERATOR: SupabaseOperationContext = {
	actor: { kind: 'operator', senderId: 1 },
	confirmed: false,
};
const CONFIRMED: SupabaseOperationContext = { ...OPERATOR, confirmed: true };
const AGENT = { kind: 'claude', sessionId: 'integration-session' } as const;
const CONFIG = [
	'project_id = "example-app"',
	'',
	'[experimental]',
	'stack = true',
	'',
	'[studio]',
	'enabled = false',
	'',
	'[analytics]',
	'enabled = false',
	'',
	'[auth.email]',
	'enable_confirmations = false',
	'',
].join('\n');

async function git(cwd: string, args: readonly string[]) {
	await execFileAsync(
		'/usr/bin/git',
		[
			'-c',
			'user.name=RN Devtools IT',
			'-c',
			'user.email=it@example.com',
			'-c',
			'commit.gpgsign=false',
			...args,
		],
		{
			cwd,
			env: {
				PATH: '/usr/bin:/bin',
				HOME: cwd,
				GIT_CONFIG_NOSYSTEM: '1',
				GIT_CONFIG_GLOBAL: '/dev/null',
			},
		}
	);
}

async function installLinkedOrCopied(source: string, target: string) {
	try {
		await link(source, target);
	} catch {
		await copyFile(source, target);
		await chmod(target, 0o755);
	}
}

/** Lays the binary out the way npm installs the CLI in a worktree. */
async function installCli(worktree: string, version: string) {
	const shimRoot = path.join(worktree, 'node_modules', 'supabase');
	const platformRoot = path.join(
		worktree,
		'node_modules',
		'@supabase',
		'cli-darwin-arm64'
	);
	await mkdir(shimRoot, { recursive: true });
	await mkdir(path.join(platformRoot, 'bin'), { recursive: true });
	await writeFile(
		path.join(shimRoot, 'package.json'),
		JSON.stringify({ name: 'supabase', version })
	);
	await writeFile(
		path.join(platformRoot, 'package.json'),
		JSON.stringify({ name: '@supabase/cli-darwin-arm64', version })
	);
	const source = await realpath(BINARY);
	await installLinkedOrCopied(
		source,
		path.join(platformRoot, 'bin', 'supabase')
	);
	const sidecar = path.join(path.dirname(source), 'supabase-go');
	try {
		await access(sidecar);
		await installLinkedOrCopied(
			sidecar,
			path.join(platformRoot, 'bin', 'supabase-go')
		);
	} catch {
		// Commands that proxy to the Go CLI are not exercised here.
	}
}

describe.skipIf(!enabled)('Supabase service against a real CLI', () => {
	let scratch = '';
	let repository = '';
	let worktree = '';
	let engine: SupabaseEngine | undefined;
	let clipboardText = '';
	const opened: string[] = [];
	const lanes: Lane[] = [];
	const worktrees: LaneWorktree[] = [];
	let counter = 0;

	function service(): SupabaseEngine {
		if (!engine) throw new Error('the service was not created');
		return engine;
	}

	function op(fields: Record<string, unknown>): SupabaseOperation {
		counter += 1;
		return supabaseOperationSchema.parse({
			actionId: `integration-${counter}`,
			...fields,
		});
	}

	async function run(
		fields: Record<string, unknown>,
		context: SupabaseOperationContext = OPERATOR
	): Promise<SupabaseOperationReceipt> {
		const receipt = await service().runOperation(op(fields), context);
		expect(JSON.stringify(receipt)).not.toMatch(SECRET_SHAPED);
		if (receipt.error) {
			throw new Error(`${receipt.error.title}: ${receipt.error.message}`);
		}
		if (receipt.jobId) {
			const job = await service().waitForJob(receipt.jobId, START_TIMEOUT_MS);
			if (job?.status !== 'complete') {
				throw new Error(
					`${fields.kind}: ${job?.status ?? 'missing'} ${job?.error?.message ?? ''}`
				);
			}
		}
		return receipt;
	}

	async function stackIdOf(target: string): Promise<string> {
		const facts = await service().worktreeFacts(target);
		if (!facts?.expectedStackId) throw new Error(`no stack id for ${target}`);
		return facts.expectedStackId;
	}

	function stackOf(stackId: string) {
		return service()
			.getState()
			.stacks.find((stack) => stack.id === stackId);
	}

	beforeAll(async () => {
		expect(path.isAbsolute(BINARY)).toBe(true);
		expect(path.isAbsolute(SUPABASE_HOME)).toBe(true);
		await mkdir(SUPABASE_HOME, { recursive: true, mode: 0o700 });
		scratch = await realpath(
			await mkdtemp(path.join(tmpdir(), 'rndevtools-supabase-service-it-'))
		);
		repository = path.join(scratch, 'example-app');
		worktree = path.join(scratch, 'example-app-feature');
		await mkdir(path.join(repository, 'supabase', 'migrations'), {
			recursive: true,
		});
		await writeFile(path.join(repository, 'supabase', 'config.toml'), CONFIG);
		await writeFile(
			path.join(
				repository,
				'supabase',
				'migrations',
				'20260101000000_items.sql'
			),
			'create table public.items (\n  id bigint generated always as identity primary key,\n  label text not null\n);\nalter table public.items enable row level security;\n'
		);
		await writeFile(
			path.join(repository, 'supabase', 'seed.sql'),
			"insert into public.items (label) select 'item ' || g from generate_series(1, 25) g;\n"
		);
		await writeFile(
			path.join(repository, '.gitignore'),
			'node_modules\nsupabase/.temp\nsupabase/.env.local\n'
		);
		await git(scratch, ['init', '-q', '-b', 'main', repository]);
		await git(repository, ['add', '-A']);
		await git(repository, ['commit', '-q', '-m', 'Add an example project']);
		await git(repository, ['worktree', 'add', '-q', '-b', 'feature', worktree]);
		const { stdout } = await execFileAsync(await realpath(BINARY), [
			'--version',
		]);
		const version = stdout.trim();
		await installCli(repository, version);
		await installCli(worktree, version);
		worktrees.push(
			{
				path: repository,
				branch: 'main',
				repositoryRoot: repository,
				dirty: false,
			},
			{
				path: worktree,
				branch: 'feature',
				repositoryRoot: repository,
				dirty: false,
			}
		);

		const deps: SupabaseServiceDeps = {
			userDataDirectory: path.join(scratch, 'userData'),
			agentSocketDirectory: path.join(scratch, 'userData', 'agent'),
			lanes: {
				lanes: () => lanes,
				laneById: (laneId) => lanes.find((lane) => lane.id === laneId),
				worktrees: () => worktrees,
				repositories: () => [repository],
				restartMetro: async () => undefined,
				launchDeferred: async () => undefined,
				subscribe: () => () => undefined,
			},
			agents: {
				sessions: () => [],
				holderLiveness: () => ({ live: true }),
				discovery: () => ({ claude: 'ok', codex: 'ok' }),
				subscribe: () => () => undefined,
			},
			dialog: {
				showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
				showSaveDialog: async () => ({
					canceled: false,
					filePath: path.join(scratch, 'export.sql'),
				}),
				showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
			},
			shell: {
				openExternal: async (url) => {
					opened.push(url);
				},
				showItemInFolder: () => undefined,
			},
			clipboard: {
				writeText: async (text) => {
					clipboardText = text;
				},
				readText: async () => clipboardText,
			},
			demo: false,
			// The darwin-arm64 binary only runs where native stacks are
			// supported; Node outside Electron cannot read the macOS version.
			platform: {
				platform: process.platform,
				arch: process.arch,
				macosVersion: '15.0.0',
			},
		};
		engine = new SupabaseEngine(deps, {
			platform: supabasePlatformAvailability(deps.platform),
		});
		await engine.policyStore.load();
		await engine.policyStore.setPath('supabase-home', SUPABASE_HOME);
		await engine.start();
	}, STEP_TIMEOUT_MS);

	afterAll(async () => {
		const problems: string[] = [];
		if (engine) {
			const live = (current: SupabaseEngine) =>
				current
					.getState()
					.stacks.filter(
						(stack) =>
							(stack.origin === 'managed' || stack.origin === 'adopted') &&
							stack.state !== 'not-created'
					)
					.map((stack) => stack.id);
			// Lane down first, as the lane service would.
			for (const lane of lanes.splice(0)) engine.detachLane(lane.id);
			await engine.refreshList();
			const managed = live(engine);
			for (const stackId of managed) {
				try {
					await run({ kind: 'stop', stackIds: [stackId] });
				} catch (error) {
					problems.push(`stop ${stackId.slice(0, 12)}: ${String(error)}`);
				}
			}
			if (managed.length > 0) {
				try {
					await run(
						{ kind: 'destroy', stackIds: managed, removeUploads: true },
						CONFIRMED
					);
				} catch (error) {
					problems.push(`destroy: ${String(error)}`);
				}
			}
			await engine.refreshList();
			const left = live(engine);
			if (left.length > 0) {
				problems.push(
					`left behind: ${left.map((id) => id.slice(0, 12)).join(', ')}`
				);
			}
			await engine.stop();
		}
		if (scratch !== '') await rm(scratch, { recursive: true, force: true });
		// A stack left behind keeps its ports reserved in SUPABASE_HOME.
		expect(problems).toEqual([]);
	}, 2 * START_TIMEOUT_MS);

	it(
		'turns on and finds both worktrees managed',
		async () => {
			const receipt = await run(
				{ kind: 'set-enabled', enabled: true },
				CONFIRMED
			);
			expect(receipt.completed).toBe(true);
			await service().refreshAll();
			const state = supabaseStateSchema.parse(service().getState());
			expect(state.source).toBe('live');
			expect(state.feature.enabled).toBe(true);
			expect(state.repositories[0]?.counts.managed).toBe(2);
		},
		STEP_TIMEOUT_MS
	);

	it(
		'starts the main stack natively, listening on loopback only',
		async () => {
			const stackId = await stackIdOf(repository);
			await run({ kind: 'start', stackId });
			const stack = stackOf(stackId);
			expect(stack).toMatchObject({
				state: 'running',
				runtime: 'native',
				exposure: { verdict: 'loopback' },
			});
			expect(stack?.apiUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
			expect(stack?.excluded).toEqual(
				expect.arrayContaining(['studio', 'analytics'])
			);
			expect(JSON.stringify(service().getState())).not.toMatch(SECRET_SHAPED);
		},
		START_TIMEOUT_MS
	);

	it(
		'reads logs and the database',
		async () => {
			const stackId = await stackIdOf(repository);
			const logs = await run({ kind: 'read-logs', stackId, tail: 100 });
			expect(logs.logs?.records.length).toBeGreaterThan(0);
			const database = await run({ kind: 'read-database', stackId });
			expect(database.database).toMatchObject({
				target: 'local',
				migrations: { comparable: true },
			});
		},
		STEP_TIMEOUT_MS
	);

	it(
		'applies a migration added at runtime, then resets',
		async () => {
			const stackId = await stackIdOf(repository);
			await writeFile(
				path.join(
					repository,
					'supabase',
					'migrations',
					'20260102000000_tags.sql'
				),
				'create table public.tags (id bigint generated always as identity primary key);\n'
			);
			await run({
				kind: 'repository.recheck',
				repositoryId: stackOf(stackId)?.repositoryId,
			});
			await run({ kind: 'apply-migrations', stackId });
			await run({ kind: 'unpin', stackId });
			await run({ kind: 'reset', stackId, seed: true }, CONFIRMED);
			expect(stackOf(stackId)?.state).toBe('running');
		},
		START_TIMEOUT_MS
	);

	it(
		'copies and opens values main resolves, and exports',
		async () => {
			const stackId = await stackIdOf(repository);
			await run({ kind: 'copy', stackId, what: 'api-url' });
			expect(clipboardText).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
			const key = await run({ kind: 'copy', stackId, what: 'publishable-key' });
			expect(key.copy?.clearsAt).toBeGreaterThan(Date.now());
			expect(clipboardText.length).toBeGreaterThan(0);
			await run({ kind: 'open', stackId, surface: 'mailpit' });
			expect(opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
			const exported = await run({
				kind: 'export',
				stackId,
				content: 'schema',
			});
			expect(exported.export?.revealable).toBe(true);
			await expect(
				stat(path.join(scratch, 'export.sql'))
			).resolves.toBeTruthy();
		},
		STEP_TIMEOUT_MS
	);

	it(
		'gives a lane on the second worktree its own stack and public values',
		async () => {
			lanes.push({
				id: LANE_ID,
				worktreePath: worktree,
				branch: 'feature',
				simulatorUdid: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
				environment: 'development',
				port: 8081,
				metro: 'ready',
				logPath: path.join(scratch, 'metro.log'),
				startedAt: Date.now(),
			});
			const result = await service().ensureForLane({
				laneId: LANE_ID,
				worktreePath: worktree,
				branch: 'feature',
				environmentId: 'development',
				policy: 'auto',
				waitMs: 45_000,
			});
			const summary = laneBackendSummarySchema.parse(
				result.lateAttach ? (await result.lateAttach).summary : result.summary
			);
			expect(summary.status).toBe('ready');
			expect(summary.stackId).toBe(await stackIdOf(worktree));
			expect(summary.stackId).not.toBe(await stackIdOf(repository));
			const env = result.laneEnv ?? (await result.lateAttach)?.laneEnv ?? {};
			expect(env.EXPO_PUBLIC_SUPABASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:/);
			expect(JSON.stringify(env)).not.toMatch(/sb_secret_|postgres/);
		},
		START_TIMEOUT_MS
	);

	it(
		'rejects user JWTs from another worktree with per-worktree signing keys',
		async () => {
			const firstId = await stackIdOf(repository);
			const secondId = await stackIdOf(worktree);
			await run(
				{ kind: 'update-policy', patch: { perStackKeys: true } },
				CONFIRMED
			);
			await run({ kind: 'stop', stackIds: [firstId, secondId] });
			for (const stackId of [firstId, secondId]) {
				await run({ kind: 'start', stackId });
			}
			const database = await run({ kind: 'read-database', stackId: firstId });
			expect(database.database).toMatchObject({
				target: 'local',
				migrations: { comparable: true },
			});
			const firstUrl = stackOf(firstId)?.apiUrl;
			const secondUrl = stackOf(secondId)?.apiUrl;
			const firstKey = service().credentialsOf(firstId)?.publishableKey;
			const secondKey = service().credentialsOf(secondId)?.publishableKey;
			if (!firstUrl || !secondUrl || !firstKey || !secondKey) {
				throw new Error('Both worktrees need public API credentials.');
			}
			expect(firstKey !== secondKey).toBe(true);
			const signup = await fetch(`${firstUrl}/auth/v1/signup`, {
				method: 'POST',
				headers: { apikey: firstKey, 'content-type': 'application/json' },
				body: JSON.stringify({
					email: 'isolation@example.com',
					password: 'ExamplePassword123!',
				}),
			});
			expect(signup.status).toBe(200);
			const session: unknown = await signup.json();
			const token =
				typeof session === 'object' &&
				session !== null &&
				'access_token' in session
					? session.access_token
					: undefined;
			if (typeof token !== 'string') {
				throw new Error('The isolated test user did not receive a session.');
			}
			const own = await fetch(`${firstUrl}/auth/v1/user`, {
				headers: { apikey: firstKey, authorization: `Bearer ${token}` },
			});
			expect(own.status).toBe(200);
			const other = await fetch(`${secondUrl}/auth/v1/user`, {
				headers: { apikey: secondKey, authorization: `Bearer ${token}` },
			});
			expect([401, 403]).toContain(other.status);
			const otherRest = await fetch(
				`${secondUrl}/rest/v1/items?select=id&limit=1`,
				{
					headers: { apikey: secondKey, authorization: `Bearer ${token}` },
				}
			);
			expect([401, 403]).toContain(otherRest.status);
		},
		STEP_TIMEOUT_MS
	);

	it(
		'serves an agent up, env and down',
		async () => {
			const context = {
				requestId: 'integration-agent',
				holder: AGENT,
				synthetic: false,
			};
			const signal = new AbortController().signal;
			const up = supabaseAgentResultSchema.parse(
				await service().runAgentOperation(
					{
						operation: 'up',
						target: { worktreePath: worktree },
						waitMs: 45_000,
					},
					context,
					signal
				)
			);
			expect(up).toMatchObject({ operation: 'up', stack: { status: 'ready' } });
			const env = supabaseAgentResultSchema.parse(
				await service().runAgentOperation(
					{ operation: 'env', target: { worktreePath: worktree } },
					context,
					signal
				)
			);
			expect(env).toMatchObject({
				operation: 'env',
				env: { API_URL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/) },
			});
			const down = supabaseAgentResultSchema.parse(
				await service().runAgentOperation(
					{ operation: 'down', target: { worktreePath: worktree } },
					context,
					signal
				)
			);
			// The lane still holds it.
			expect(down).toMatchObject({ operation: 'down', stopping: false });
		},
		START_TIMEOUT_MS
	);

	it(
		'stops and destroys the main stack with its uploads',
		async () => {
			const stackId = await stackIdOf(repository);
			const uploads = path.join(
				repository,
				'supabase',
				'.temp',
				'stack-uploads',
				stackId
			);
			await mkdir(uploads, { recursive: true });
			await writeFile(path.join(uploads, 'avatar.txt'), 'upload');
			await run({ kind: 'stop', stackIds: [stackId] });
			expect(stackOf(stackId)?.state).toBe('stopped');
			await run(
				{ kind: 'destroy', stackIds: [stackId], removeUploads: true },
				CONFIRMED
			);
			await expect(stat(uploads)).rejects.toThrow();
			expect(stackOf(stackId)?.state).toBe('not-created');
			expect(JSON.stringify(service().getState())).not.toMatch(SECRET_SHAPED);
		},
		STEP_TIMEOUT_MS
	);
});

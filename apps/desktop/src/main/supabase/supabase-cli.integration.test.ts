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
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	parseSupabaseInspectDbStats,
	parseSupabaseInspectTableStats,
	parseSupabaseMigrationList,
	parseSupabaseStackDestroy,
	parseSupabaseStackList,
	parseSupabaseStackLogs,
	parseSupabaseStackStart,
	parseSupabaseStackStatus,
	parseSupabaseStackStop,
	type SupabaseStackStart,
} from './cli-contract';
import { interpretSupabaseResult, type SupabaseOutcome } from './cli-errors';
import { type ResolvedSupabaseCli, SupabaseCliResolver } from './cli-resolver';
import { SupabaseCliRunner, type SupabaseCliRunResult } from './cli-runner';
import {
	buildSupabaseArgv,
	type SupabaseCliOperation,
	supabaseOperationBudget,
} from './dialect';

/**
 * Opt-in: runs the adapter against a real Supabase CLI platform binary.
 *
 *   RNDEVTOOLS_SUPABASE_IT_BIN=/abs/path/to/@supabase/cli-darwin-arm64/bin/supabase \
 *   RNDEVTOOLS_SUPABASE_IT_HOME=/abs/scratch/supabase-home \
 *   pnpm --filter @rndevtools/desktop exec vitest run src/main/supabase/supabase-cli.integration.test.ts
 *
 * It builds a scratch git repository whose supabase/config.toml enables the
 * stack backend and pins no ports, installs the binary into a scratch
 * node_modules (hard link, or copy), and drives version, start, status, logs,
 * migration list, inspect, list, stop and destroy through the resolver, argv
 * builder, runner, contract and classifier. The stack it creates is destroyed
 * at the end, even when a step fails. Starting a stack downloads service
 * artifacts into SUPABASE_HOME the first time, which can take minutes.
 */

const BINARY = process.env.RNDEVTOOLS_SUPABASE_IT_BIN ?? '';
const SUPABASE_HOME = process.env.RNDEVTOOLS_SUPABASE_IT_HOME ?? '';
const enabled = BINARY !== '' && SUPABASE_HOME !== '';
const execFileAsync = promisify(execFile);
// Longer than any non-start budget plus its 45 s interrupt grace.
const STEP_TIMEOUT_MS = 240_000;
// The runner's budget for lifecycle steps; a first start downloads artifacts.
const FIRST_START_TIMEOUT_MS = 600_000;
// Vitest's own limit for those steps, beyond the runner's interrupt path.
const FIRST_START_TEST_TIMEOUT_MS = FIRST_START_TIMEOUT_MS + 120_000;
const SECRET_SHAPED =
	/sb_secret_|sb_publishable_|eyJ[\w-]+\.[\w-]+|postgres(?:ql)?:\/\/[^\s"]*:[^\s"@]+@|SERVICE_ROLE|SECRET_KEY/;

function expectOk<T>(outcome: SupabaseOutcome<T>): T {
	if (!outcome.ok) {
		throw new Error(
			`${outcome.error.code}: ${outcome.error.title}: ${outcome.error.message}`
		);
	}
	return outcome.value;
}

async function installLinkedOrCopied(source: string, target: string) {
	try {
		// A hard link shares the original's inode, so leave its mode alone.
		await link(source, target);
	} catch {
		await copyFile(source, target);
		await chmod(target, 0o755);
	}
}

async function git(repository: string, args: readonly string[]) {
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
			cwd: repository,
			env: {
				PATH: '/usr/bin:/bin',
				HOME: repository,
				GIT_CONFIG_NOSYSTEM: '1',
				GIT_CONFIG_GLOBAL: '/dev/null',
			},
		}
	);
}

describe.skipIf(!enabled)('Supabase CLI adapter against a real binary', () => {
	const runner = new SupabaseCliRunner();
	const environment = { supabaseHome: SUPABASE_HOME };
	let scratch = '';
	let repository = '';
	let cwd = '';
	let progressDirectory = '';
	let cli: ResolvedSupabaseCli | undefined;
	let started: SupabaseStackStart | undefined;
	let destroyed = false;

	function resolvedCli(): ResolvedSupabaseCli {
		if (cli === undefined) throw new Error('the CLI was not resolved');
		return cli;
	}

	function stackId(): string {
		if (started === undefined) throw new Error('the stack was not started');
		return started.id;
	}

	async function run(
		operation: SupabaseCliOperation
	): Promise<SupabaseCliRunResult> {
		const resolved = resolvedCli();
		const argv = buildSupabaseArgv(resolved.dialect, operation);
		const budget = supabaseOperationBudget(operation);
		if (budget.detached) {
			const handle = await runner.spawnDetached({
				binaryPath: resolved.binaryPath,
				argv,
				cwd,
				timeoutMs:
					operation.kind === 'stack.start'
						? Math.max(budget.timeoutMs, FIRST_START_TIMEOUT_MS)
						: budget.timeoutMs,
				interruptGraceMs: budget.interruptGraceMs,
				progressDirectory,
				progressLabel: operation.kind.replace('.', '-'),
				environment,
			});
			return handle.result;
		}
		return runner.run({
			binaryPath: resolved.binaryPath,
			argv,
			cwd,
			timeoutMs: budget.timeoutMs,
			interruptGraceMs: budget.interruptGraceMs,
			...(budget.forceKillAfterMs === undefined
				? {}
				: { forceKillAfterMs: budget.forceKillAfterMs }),
			environment,
		});
	}

	beforeAll(async () => {
		expect(path.isAbsolute(BINARY)).toBe(true);
		expect(path.isAbsolute(SUPABASE_HOME)).toBe(true);
		await mkdir(SUPABASE_HOME, { recursive: true, mode: 0o700 });
		scratch = await realpath(
			await mkdtemp(path.join(tmpdir(), 'rndevtools-supabase-it-'))
		);
		repository = path.join(scratch, 'example-app');
		cwd = path.join(scratch, 'neutral-cwd');
		progressDirectory = path.join(scratch, 'progress');
		await mkdir(path.join(repository, 'supabase', 'migrations'), {
			recursive: true,
		});
		await writeFile(
			path.join(repository, 'supabase', 'config.toml'),
			'project_id = "example-app"\n\n[experimental]\nstack = true\n'
		);
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
		await writeFile(path.join(repository, '.gitignore'), 'node_modules\n');
		await git(scratch, ['init', '-q', '-b', 'main', repository]);
		await git(repository, ['add', '-A']);
		await git(repository, [
			'commit',
			'-q',
			'-m',
			'Add an example Supabase project',
		]);

		// The adapter only runs a CLI installed in the worktree, so install the
		// binary the way npm lays it out.
		const sourceBinary = await realpath(BINARY);
		const probe = await runner.run({
			binaryPath: sourceBinary,
			argv: buildSupabaseArgv(null, { kind: 'version' }),
			readOnly: true,
			cwd,
			timeoutMs: 10_000,
			environment,
		});
		expect(probe.succeeded).toBe(true);
		const version = probe.takeStdout().trim();
		const shimRoot = path.join(repository, 'node_modules', 'supabase');
		const platformRoot = path.join(
			repository,
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
		await installLinkedOrCopied(
			sourceBinary,
			path.join(platformRoot, 'bin', 'supabase')
		);
		const sidecar = path.join(path.dirname(sourceBinary), 'supabase-go');
		try {
			await access(sidecar);
			await installLinkedOrCopied(
				sidecar,
				path.join(platformRoot, 'bin', 'supabase-go')
			);
		} catch {
			// Commands that proxy to the Go CLI are not exercised here.
		}
	}, STEP_TIMEOUT_MS);

	afterAll(async () => {
		if (cli !== undefined && started !== undefined && !destroyed) {
			try {
				await run({ kind: 'stack.stop', stackId: started.id });
				await run({
					kind: 'stack.destroy',
					stackIds: [started.id],
					confirmed: true,
				});
			} catch {
				// Best effort; report the original failure.
			}
		}
		if (scratch !== '') await rm(scratch, { recursive: true, force: true });
	}, 2 * FIRST_START_TEST_TIMEOUT_MS);

	it(
		'resolves the worktree CLI and gates its dialect',
		async () => {
			const resolver = new SupabaseCliResolver({ runner, probeCwd: cwd });
			const resolution = await resolver.resolve({
				appPath: repository,
				worktreeRoot: repository,
				allowUnverifiedPatch: true,
			});
			if (!resolution.ok) {
				throw new Error(
					`${resolution.reason}: ${resolution.message} (${resolution.path ?? ''})`
				);
			}
			cli = resolution.cli;
			expect(cli.binaryPath.startsWith(repository)).toBe(true);
			expect(['verified', 'compatible']).toContain(cli.dialect.gate);
			expect(cli.dialect.manageable).toBe(true);
		},
		STEP_TIMEOUT_MS
	);

	it(
		'starts a native stack with Studio and analytics excluded',
		async () => {
			const result = await run({
				kind: 'stack.start',
				workdir: repository,
				exclude: ['studio', 'analytics'],
			});
			const stderr = result.stderrLines.join('\n');
			started = expectOk(
				interpretSupabaseResult(result, parseSupabaseStackStart)
			);
			expect(started.runtime).toBe('native');
			expect(started.id).toMatch(/^[0-9a-f]{64}$/);
			expect(started.publicEndpoints?.apiUrl).toMatch(
				/^http:\/\/127\.0\.0\.1:\d+$/
			);
			expect(started.publicEndpoints?.studioUrl).toBeUndefined();
			expect(Object.keys(started.endpoints)).not.toContain('studio.http');
			expect(
				started.credentials.publishableKey ?? started.credentials.anonKey
			).toBeDefined();
			expect(JSON.stringify(started)).not.toMatch(SECRET_SHAPED);
			expect(stderr).toContain('20260101000000_items.sql');
			expect(stderr).not.toMatch(SECRET_SHAPED);
		},
		FIRST_START_TEST_TIMEOUT_MS
	);

	it(
		'reports the running stack',
		async () => {
			const status = expectOk(
				interpretSupabaseResult(
					await run({ kind: 'stack.status', stackId: stackId() }),
					parseSupabaseStackStatus
				)
			);
			expect(status.identity.id).toBe(stackId());
			expect(status.identity.projectRoot).toBe(repository);
			expect(status.identity.branchContext).toBe('refs/heads/main');
			expect(status).toMatchObject({
				owner: 'reachable',
				lifecycle: 'running',
			});
			expect(['ready', 'sleeping', 'starting']).toContain(status.readiness);
			const services = status.members.map((member) => member.service);
			expect(services).toContain('database');
			expect(services).not.toContain('studio');
			expect(services).not.toContain('analytics');
			expect(status.releaseMismatch).toBeUndefined();
			expect(status.publicEndpoints?.apiUrl).toBe(
				started?.publicEndpoints?.apiUrl
			);
			expect(JSON.stringify(status)).not.toMatch(SECRET_SHAPED);
			const list = expectOk(
				interpretSupabaseResult(
					await run({ kind: 'stack.list' }),
					(json, stderr) => parseSupabaseStackList(json, stderr)
				)
			);
			expect(list.stacks).toContainEqual(
				expect.objectContaining({
					id: stackId(),
					projectRoot: repository,
					owner: 'reachable',
				})
			);
		},
		STEP_TIMEOUT_MS
	);

	it(
		'reads log history',
		async () => {
			const logs = expectOk(
				interpretSupabaseResult(
					await run({ kind: 'stack.logs', stackId: stackId(), tail: 50 }),
					(json) => parseSupabaseStackLogs(json)
				)
			);
			expect(logs.records.length).toBeGreaterThan(0);
			expect(logs.records.length).toBeLessThanOrEqual(50 + 16);
			const rendered = JSON.stringify(logs);
			expect(rendered).not.toMatch(SECRET_SHAPED);
			expect(rendered.includes('\\u001b')).toBe(false);
		},
		STEP_TIMEOUT_MS
	);

	it(
		'lists migrations locally and through the stack DB URL',
		async () => {
			const local = expectOk(
				interpretSupabaseResult(
					await run({
						kind: 'migration.list',
						workdir: repository,
						target: 'local',
					}),
					parseSupabaseMigrationList
				)
			);
			expect(local.status).toMatchObject({ state: 'up-to-date', applied: 1 });
			const dbUrl = started?.credentials.dbUrl;
			if (dbUrl !== undefined) {
				const viaUrl = expectOk(
					interpretSupabaseResult(
						await run({
							kind: 'migration.list',
							workdir: repository,
							target: { dbUrl },
						}),
						parseSupabaseMigrationList
					)
				);
				expect(viaUrl.rows).toEqual(local.rows);
			}
		},
		STEP_TIMEOUT_MS
	);

	it(
		'inspects the database read-only',
		async () => {
			const tables = expectOk(
				interpretSupabaseResult(
					await run({
						kind: 'inspect',
						name: 'table-stats',
						workdir: repository,
						target: 'local',
					}),
					parseSupabaseInspectTableStats
				)
			);
			expect(tables.map((table) => table.name)).toContain('public.items');
			const stats = expectOk(
				interpretSupabaseResult(
					await run({
						kind: 'inspect',
						name: 'db-stats',
						workdir: repository,
						target: 'local',
					}),
					parseSupabaseInspectDbStats
				)
			);
			expect(stats?.databaseSize).toBeDefined();
		},
		STEP_TIMEOUT_MS
	);

	it(
		'stops the stack, keeping it registered',
		async () => {
			const stop = expectOk(
				interpretSupabaseResult(
					await run({ kind: 'stack.stop', stackId: stackId() }),
					parseSupabaseStackStop
				)
			);
			expect([...stop.stopped, ...stop.notRunning]).toContain(stackId());
			const status = expectOk(
				interpretSupabaseResult(
					await run({ kind: 'stack.status', stackId: stackId() }),
					parseSupabaseStackStatus
				)
			);
			expect(status).toMatchObject({
				owner: 'unavailable',
				lifecycle: null,
				publicEndpoints: undefined,
			});
		},
		STEP_TIMEOUT_MS
	);

	it(
		'destroys the stack',
		async () => {
			const destroy = expectOk(
				interpretSupabaseResult(
					await run({
						kind: 'stack.destroy',
						stackIds: [stackId()],
						confirmed: true,
					}),
					parseSupabaseStackDestroy
				)
			);
			expect(destroy.destroyedIds).toEqual([stackId()]);
			destroyed = true;
			const status = interpretSupabaseResult(
				await run({ kind: 'stack.status', stackId: stackId() }),
				parseSupabaseStackStatus
			);
			expect(status).toMatchObject({ ok: false, error: { code: 'not_found' } });
		},
		STEP_TIMEOUT_MS
	);
});

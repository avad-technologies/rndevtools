import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	SUPABASE_AGENT_ERROR_CODES,
	type SupabaseAgentOperation,
	type SupabaseAgentResult,
	supabaseAgentResultSchema,
	supabaseDoctorInfoSchema,
	supabaseOperationSchema,
} from '../../shared/supabase-protocol';
import { AgentCliError } from '../agent-cli-service';
import { SECRET_SHAPED } from './cli-fixtures.test-support';
import {
	createEngineHarness,
	disposeEngineHarnesses,
	type EngineHarness,
	fakeLane,
	fakeSession,
} from './engine.test-support';
import type { SupabaseAgentContext } from './service-ports';

// These suites drive the orchestrator through hundreds of store writes. The
// stores' atomic, fsync'd writes are tested on their own; here the same bytes
// and modes are written without the fsync, so the suites don't starve the
// stores' durability tests of disk time when files run in parallel.
vi.mock('./policy-store', async (importOriginal) => {
	const original = await importOriginal<typeof import('./policy-store')>();
	const { chmod, writeFile } = await import('node:fs/promises');
	const { dirname } = await import('node:path');
	return {
		...original,
		writeSupabaseStoreFile: async (
			file: string,
			contents: string,
			maxBytes: number
		) => {
			if (Buffer.byteLength(contents, 'utf8') > maxBytes) {
				throw new RangeError(`${file} would exceed its limit.`);
			}
			await original.ensureSupabaseStoreDirectory(dirname(file));
			await writeFile(file, contents, { mode: 0o600 });
			await chmod(file, 0o600);
		},
	};
});

afterEach(disposeEngineHarnesses);

const CLAUDE = { kind: 'claude', sessionId: 'session-a' } as const;
const CODEX = { kind: 'codex', sessionId: 'session-b' } as const;
const SIGNAL = new AbortController().signal;
const LANE_ID = 'lane-11111111-2222-4333-8444-555555555555';

function context(
	holder: SupabaseAgentContext['holder'] = CLAUDE,
	fields: Partial<SupabaseAgentContext> = {}
): SupabaseAgentContext {
	return { requestId: 'request-1', holder, synthetic: false, ...fields };
}

/** An agent call whose result must pass the router's checks. */
async function agent(
	h: EngineHarness,
	operation: SupabaseAgentOperation,
	callContext: SupabaseAgentContext = context()
): Promise<SupabaseAgentResult> {
	const result = await h.engine.runAgentOperation(
		operation,
		callContext,
		SIGNAL
	);
	const parsed = supabaseAgentResultSchema.parse(result);
	expect(parsed.operation).toBe(operation.operation);
	if (parsed.operation !== 'env') {
		expect(JSON.stringify(parsed)).not.toMatch(SECRET_SHAPED);
	}
	await h.settle();
	return parsed;
}

async function failure(
	h: EngineHarness,
	operation: SupabaseAgentOperation,
	callContext: SupabaseAgentContext = context()
): Promise<AgentCliError> {
	const error = await h.engine
		.runAgentOperation(operation, callContext, SIGNAL)
		.then(
			() => undefined,
			(caught: unknown) => caught
		);
	expect(error).toBeInstanceOf(AgentCliError);
	const typed = error as AgentCliError;
	expect([...SUPABASE_AGENT_ERROR_CODES, 'invalid_request']).toContain(
		typed.code
	);
	expect(typed.recovery).toBeTruthy();
	return typed;
}

async function setup(
	options: { lockfile?: boolean; config?: string; migrations?: number } = {}
) {
	const h = await createEngineHarness({ enabled: true, start: false });
	const repo = await h.repository('repo', { lockfile: true, ...options });
	h.agents.sessions = [
		fakeSession('session-a', '/Users/example/elsewhere'),
		fakeSession('session-b', '/Users/example/other', 'codex'),
	];
	await h.engine.start();
	await h.engine.settle();
	return { h, repo, stackId: await h.identity(repo) };
}

function up(worktreePath: string, waitMs = 45_000): SupabaseAgentOperation {
	return { operation: 'up', target: { worktreePath }, waitMs };
}

describe('supabase up', () => {
	it('keeps the old branch held when starting the new branch fails', async () => {
		const { h, repo, stackId } = await setup();
		await agent(h, up(repo));
		await h.checkout(repo, 'feature');
		h.cli.replyNext('stack start', {
			exitCode: 1,
			stdout: `${JSON.stringify({ _tag: 'Error', error: { code: 'ExperimentalStackStartError', message: 'database: initdb failed' } })}\n`,
			stderr: [],
		});
		await failure(h, up(repo));
		expect(h.engine.stackStore.record(stackId)?.holds).toContainEqual(
			expect.objectContaining({ agent: { ...CLAUDE, synthetic: false } })
		);
		expect(h.cli.stacks.get(stackId)?.running).toBe(true);
	});

	it('starts the worktree stack natively and holds it for the session', async () => {
		const { h, repo, stackId } = await setup({ migrations: 1 });
		const result = await agent(h, up(repo));
		expect(result).toMatchObject({
			operation: 'up',
			stack: {
				id: stackId,
				status: 'ready',
				origin: 'managed',
				mode: 'managed',
				runtime: 'native',
				exposure: 'loopback',
				yours: true,
				worktreePath: repo,
				projectRoot: repo,
			},
			appEnv: [
				'EXPO_PUBLIC_SUPABASE_URL',
				'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
			],
			metro: 'no-lane',
			cli: { run: 'pnpm exec supabase', workdir: repo, version: '2.121.0' },
		});
		if (result.operation !== 'up') throw new Error('not up');
		expect(result.stack.apiPort).toBeGreaterThan(0);
		expect(result.next).toMatch(/pnpm exec supabase migration up --local/);
		expect(result.warnings).toContain('shared-default-keys');
		expect(h.engine.stackStore.record(stackId)?.holds).toEqual([
			{
				holder: 'session',
				agent: { ...CLAUDE, synthetic: false },
				since: h.clock.now,
			},
		]);
		expect(h.engine.stackStore.record(stackId)?.pinned).toBe(false);
	});

	it('answers starting with the job to wait on when asked not to wait', async () => {
		const { h, repo } = await setup();
		const release = h.cli.hold('stack start');
		const result = await h.engine.runAgentOperation(
			up(repo, 0),
			context(),
			SIGNAL
		);
		supabaseAgentResultSchema.parse(result);
		expect(result).toMatchObject({
			operation: 'up',
			stack: { status: 'starting' },
		});
		const jobId = (result as { jobId?: string }).jobId;
		expect(jobId).toMatch(/^supabase-job-/);
		expect((result as { next: string }).next).toContain(jobId);
		await h.cli.waitForCall('stack start');
		const running = await h.engine.waitForJob(jobId ?? '', 20);
		expect(running?.status).toBe('running');
		release();
		const done = await h.engine.waitForJob(jobId ?? '', 2_000);
		expect(done?.status).toBe('complete');
	});

	it('says an up queued behind an automatic start is queued, not to wait on that job', async () => {
		const { h, repo, stackId } = await setup();
		const facts = await h.engine.worktreeFacts(repo);
		if (!facts) throw new Error('The worktree has no facts.');
		const release = h.cli.hold('stack start');
		const followJobs: string[] = [];
		const follow = h.engine.ensureStack(facts, {
			requestedBy: { kind: 'automatic', reason: 'follow' },
			createdBy: { via: 'desktop' },
			onJob: (jobId) => followJobs.push(jobId),
		});
		await h.cli.waitForCall('stack start');
		const queued = await h.engine.runAgentOperation(
			up(repo, 0),
			context(),
			SIGNAL
		);
		supabaseAgentResultSchema.parse(queued);
		expect(queued).toMatchObject({
			operation: 'up',
			stack: { status: 'starting' },
			next: "This up is queued behind RN Devtools' automatic start of the stack. Call supabase with operation up again in a few seconds.",
		});
		expect(queued).not.toHaveProperty('jobId');
		// The follow's start fails, and the queued up then starts it itself.
		h.cli.replyNext('stack start', {
			exitCode: 1,
			stdout: `${JSON.stringify({ _tag: 'Error', error: { code: 'ExperimentalStackStartError', message: 'database: initdb failed' } })}\n`,
			stderr: [],
		});
		release();
		await expect(follow).resolves.toMatchObject({ kind: 'refused' });
		await h.engine.waitForJob(followJobs[0] ?? '', 10_000);
		await h.settle();
		expect(h.engine.job(followJobs[0] ?? '')?.status).toBe('failed');
		await expect(agent(h, up(repo))).resolves.toMatchObject({
			operation: 'up',
			stack: { id: stackId, status: 'ready', yours: true },
		});
		expect(h.cli.count('stack start')).toBe(2);
	});

	it('gives a synthetic MCP caller a worktree hold', async () => {
		const { h, repo, stackId } = await setup();
		await agent(
			h,
			up(repo),
			context(
				{ kind: 'codex', sessionId: 'mcp-1234' },
				{ synthetic: true, sessionCwd: repo }
			)
		);
		expect(h.engine.stackStore.record(stackId)?.holds[0]).toMatchObject({
			holder: 'worktree',
			agent: { kind: 'codex', sessionId: 'mcp-1234', synthetic: true },
		});
	});

	it('refuses a stack id whose worktree moved to another branch', async () => {
		const { h, repo, stackId } = await setup();
		await agent(h, up(repo));
		await h.checkout(repo, 'feat-x');
		const error = await failure(h, {
			operation: 'up',
			target: { stackId },
			waitMs: 0,
		});
		expect(error.code).toBe('branch_moved');
	});

	it('names why a worktree is not managed', async () => {
		const flagless = await setup({ config: '[api]\nenabled = true\n' });
		expect((await failure(flagless.h, up(flagless.repo))).code).toBe(
			'stack_flag_missing'
		);
		const { h, repo } = await setup();
		h.resolver.missing.add(repo);
		await h.engine.runOperation(
			supabaseOperationSchema.parse({
				actionId: 'action-recheck',
				kind: 'repository.recheck',
				repositoryId: h.engine.getState().repositories[0]?.id,
			}),
			{ actor: { kind: 'operator', senderId: 1 }, confirmed: false }
		);
		const missing = await failure(h, up(repo));
		expect(missing.code).toBe('cli_missing');
		const busy = await setup();
		await writeFile(path.join(busy.repo, '.git', 'MERGE_HEAD'), 'abc\n');
		expect((await failure(busy.h, up(busy.repo))).code).toBe('git_busy');
	});

	it('moves its own holds to the current branch on an explicit up', async () => {
		const { h, repo, stackId } = await setup();
		await agent(h, up(repo));
		await h.checkout(repo, 'feat-x');
		await agent(h, up(repo));
		const next = await h.identity(repo);
		expect(h.engine.stackStore.record(stackId)?.holds).toEqual([]);
		expect(h.engine.stackStore.record(next)?.holds).toHaveLength(1);
	});
});

describe('supabase down, ls, status, env, log', () => {
	it('drops the session hold; the stack stops after the linger unless others hold it', async () => {
		const { h, repo, stackId } = await setup();
		await agent(h, up(repo));
		await agent(h, up(repo), context(CODEX));
		const down = await agent(h, {
			operation: 'down',
			target: { worktreePath: repo },
		});
		expect(down).toMatchObject({
			operation: 'down',
			stackId,
			released: true,
			stopping: false,
			keptBy: [expect.stringMatching(/Codex/)],
		});
		const last = await agent(
			h,
			{ operation: 'down', target: { worktreePath: repo } },
			context(CODEX)
		);
		expect(last).toMatchObject({ stopping: true, keptBy: [] });
		expect((last as { next: string }).next).toMatch(/It stops in 1 min/);
		await h.advance(61_000);
		expect(h.cli.stacks.get(stackId)?.running).toBe(false);
	});

	it('counts a lane on the stack as a keeper', async () => {
		const { h, repo } = await setup();
		h.lanes.lanes = [fakeLane({ id: LANE_ID, worktreePath: repo })];
		await h.engine.ensureForLane({
			laneId: LANE_ID,
			worktreePath: repo,
			branch: 'main',
			environmentId: 'development',
			policy: 'auto',
		});
		await agent(h, up(repo));
		const down = await agent(h, {
			operation: 'down',
			target: { worktreePath: repo },
		});
		expect(down).toMatchObject({
			stopping: false,
			keptBy: [`lane ${LANE_ID.slice(0, 13)}`],
		});
	});

	it('lists stacks with the caller’s own marked', async () => {
		const { h, repo, stackId } = await setup();
		await agent(h, up(repo));
		const mine = await agent(h, { operation: 'ls' });
		const theirs = await agent(h, { operation: 'ls' }, context(CODEX));
		expect(mine).toMatchObject({
			stacks: [{ id: stackId, yours: true, status: 'ready' }],
		});
		expect(theirs).toMatchObject({
			stacks: [{ id: stackId, yours: false }],
		});
	});

	it('reports status with the services and what to do next', async () => {
		const { h, repo, stackId } = await setup();
		const before = await agent(h, {
			operation: 'status',
			target: { worktreePath: repo },
		});
		expect(before).toMatchObject({
			stack: { id: stackId, status: 'not-created' },
			next: 'Call supabase with operation up to create it.',
		});
		await agent(h, up(repo));
		const after = await agent(h, {
			operation: 'status',
			target: { stackId: stackId.slice(0, 12) },
		});
		if (after.operation !== 'status') throw new Error('not status');
		expect(after.stack.status).toBe('ready');
		expect(after.services.map((service) => service.service)).toContain(
			'database'
		);
	});

	it('gives public values only through env', async () => {
		const { h, repo, stackId } = await setup();
		expect(
			(
				await failure(h, {
					operation: 'env',
					target: { worktreePath: repo },
				})
			).code
		).toBe('not_found');
		await agent(h, up(repo));
		const env = await agent(h, {
			operation: 'env',
			target: { worktreePath: repo },
		});
		expect(env).toMatchObject({
			operation: 'env',
			stackId,
			env: {
				API_URL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
				PUBLISHABLE_KEY: h.cli.secrets.publishableKey,
				ANON_KEY: h.cli.secrets.anonKey,
			},
		});
		const serialized = JSON.stringify(env);
		expect(serialized).not.toContain(h.cli.secrets.secretKey);
		expect(serialized).not.toContain(h.cli.secrets.serviceRoleKey);
		expect(serialized).not.toContain(h.cli.secrets.dbPassword);
	});

	it('reads log history through the owner’s CLI', async () => {
		const { h, repo } = await setup();
		await agent(h, up(repo));
		const log = await agent(h, {
			operation: 'log',
			target: { worktreePath: repo },
			tail: 50,
		});
		if (log.operation !== 'log') throw new Error('not log');
		expect(log.records.length).toBeGreaterThan(0);
	});

	it('says local Supabase is off for a log read that waited for a CLI slot at the turn-off', async () => {
		const { h, repo, stackId } = await setup();
		await agent(h, up(repo));
		const operator = { actor: { kind: 'operator', senderId: 1 } } as const;
		// Four log reads take every CLI slot.
		const release = h.cli.hold('stack logs');
		const reads = [1, 2, 3, 4].map((index) =>
			h.engine.runOperation(
				supabaseOperationSchema.parse({
					actionId: `action-logs-${index}`,
					kind: 'read-logs',
					stackId,
					tail: 50,
				}),
				{ ...operator, confirmed: false }
			)
		);
		await h.until(() => h.cli.count('stack logs') === 4);
		const reading = vi.spyOn(h.engine, 'readLogs');
		const log = failure(h, {
			operation: 'log',
			target: { worktreePath: repo },
			tail: 50,
		});
		// Its read waits for a CLI slot.
		await h.until(() => reading.mock.calls.length > 0);
		await h.engine.runOperation(
			supabaseOperationSchema.parse({
				actionId: 'action-off',
				kind: 'set-enabled',
				enabled: false,
			}),
			{ ...operator, confirmed: true }
		);
		release();
		await Promise.all(reads);
		// As for a reset called off at the turn-off.
		expect((await log).code).toBe('supabase_disabled');
		expect(h.cli.count('stack logs')).toBe(4);
	});

	it('refuses an ambiguous stack id prefix', async () => {
		const { h, repo } = await setup();
		await agent(h, up(repo));
		h.cli.addStack({
			id: `${'a'.repeat(8)}${'1'.repeat(56)}`,
			projectRoot: repo,
		});
		h.cli.addStack({
			id: `${'a'.repeat(8)}${'2'.repeat(56)}`,
			projectRoot: repo,
		});
		await h.engine.runOperation(
			supabaseOperationSchema.parse({ actionId: 'action-r', kind: 'refresh' }),
			{ actor: { kind: 'operator', senderId: 1 }, confirmed: false }
		);
		const error = await failure(h, {
			operation: 'status',
			target: { stackId: 'a'.repeat(8) },
		});
		expect(error.code).toBe('invalid_request');
	});
});

describe('supabase reset and destroy', () => {
	it('resets at once for the sole live holder on the stack branch', async () => {
		const { h, repo, stackId } = await setup();
		await agent(h, up(repo));
		const reset = await agent(h, {
			operation: 'reset',
			target: { worktreePath: repo },
			seed: true,
		});
		expect(reset).toMatchObject({
			operation: 'reset',
			stackId,
			status: 'complete',
			seed: true,
		});
		expect(h.cli.callsOf('db reset')[0]?.argv).toEqual(
			expect.arrayContaining(['--local', '--workdir', repo])
		);
	});

	it('files a request when another session holds the stack', async () => {
		const { h, repo } = await setup();
		await agent(h, up(repo));
		await agent(h, up(repo), context(CODEX));
		const reset = await agent(h, {
			operation: 'reset',
			target: { worktreePath: repo },
			seed: false,
			note: 'Fresh data, please',
		});
		expect(reset).toMatchObject({ status: 'requested', seed: false });
		expect(h.cli.count('db reset')).toBe(0);
		const [request] = h.engine.getState().requests;
		expect(request).toMatchObject({ kind: 'reset', status: 'pending' });
	});

	it('refuses a reset after the worktree moved branch', async () => {
		const { h, repo, stackId } = await setup();
		await agent(h, up(repo));
		await h.checkout(repo, 'feat-x');
		const error = await failure(h, {
			operation: 'reset',
			target: { stackId },
			seed: true,
		});
		expect(error.code).toBe('branch_moved');
	});

	it('always turns destroy into a request for the user', async () => {
		const { h, repo, stackId } = await setup();
		await agent(h, up(repo));
		const destroy = await agent(h, {
			operation: 'destroy',
			target: { worktreePath: repo },
		});
		expect(destroy).toMatchObject({
			operation: 'destroy',
			stackId,
			status: 'pending',
			expiresAt: h.clock.now + 30 * 60_000,
		});
		expect(h.cli.count('stack destroy')).toBe(0);
		// The same session asking again gets the same request.
		const again = await agent(h, {
			operation: 'destroy',
			target: { worktreePath: repo },
		});
		expect((again as { requestId: string }).requestId).toBe(
			(destroy as { requestId: string }).requestId
		);
		expect(h.engine.getState().requests).toHaveLength(1);
	});
});

describe('agent bookkeeping', () => {
	it('names its holders for the agent clocks and reports doctor info', async () => {
		const { h, repo } = await setup();
		await agent(h, up(repo));
		expect(h.engine.holderKeys()).toEqual([
			{ holder: CLAUDE, directory: repo },
		]);
		const doctor = supabaseDoctorInfoSchema.parse(h.engine.doctor());
		expect(doctor).toMatchObject({
			enabled: true,
			capability: 'ready',
			running: 1,
		});
		expect(doctor.stats.starts).toBe(1);
	});

	it('answers a wait at its timeout, and an unknown job as undefined', async () => {
		const { h } = await setup();
		await expect(
			h.engine.waitForJob(
				'supabase-job-00000000-0000-4000-8000-000000000000',
				5
			)
		).resolves.toBeUndefined();
	});
});

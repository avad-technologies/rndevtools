import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	SUPABASE_CLIPBOARD_CLEAR_MS,
	type SupabaseOperation,
	supabaseOperationReceiptSchema,
	supabaseOperationSchema,
} from '../../shared/supabase-protocol';
import { SECRET_SHAPED } from './cli-fixtures.test-support';
import {
	createEngineHarness,
	disposeEngineHarnesses,
	type EngineHarness,
	fakeLane,
	fakeSession,
} from './engine.test-support';
import type { SupabaseOperationContext } from './service-ports';

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

// Most of these tests' time is quiet windows while calls are held: real
// time, which a faster CPU doesn't shorten and a busy runner stretches. The
// slowest take about 1.2 s in a full desktop run, under a tenth of this.
vi.setConfig({ testTimeout: 30_000 });

afterEach(disposeEngineHarnesses);

const OPERATOR: SupabaseOperationContext = {
	actor: { kind: 'operator', senderId: 1 },
	confirmed: false,
};
const CONFIRMED: SupabaseOperationContext = { ...OPERATOR, confirmed: true };
const CLAUDE = { kind: 'claude', sessionId: 'session-a' } as const;
const CODEX = { kind: 'codex', sessionId: 'session-b' } as const;
const SIGNAL = new AbortController().signal;
const LANE_ID = 'lane-11111111-2222-4333-8444-555555555555';

let counter = 0;
function op(fields: Record<string, unknown>): SupabaseOperation {
	counter += 1;
	return supabaseOperationSchema.parse({
		actionId: `action-${counter}`,
		...fields,
	});
}

/** Runs an operation and checks the receipt the way IPC does. */
async function run(
	h: EngineHarness,
	fields: Record<string, unknown>,
	context: SupabaseOperationContext = OPERATOR
) {
	const operation = op(fields);
	const receipt = await h.engine.runOperation(operation, context);
	expect(receipt.actionId).toBe(operation.actionId);
	expect(receipt.kind).toBe(operation.kind);
	const parsed = supabaseOperationReceiptSchema.parse(receipt);
	expect(JSON.stringify(parsed)).not.toMatch(SECRET_SHAPED);
	return parsed;
}

/** Runs an operation and waits for the job it answers with to end. */
async function runToEnd(
	h: EngineHarness,
	fields: Record<string, unknown>,
	context: SupabaseOperationContext = OPERATOR
) {
	const receipt = await run(h, fields, context);
	await h.engine.waitForJob(receipt.jobId ?? '', 10_000);
	return receipt;
}

const CONFIG_WITH_BUCKET =
	'[experimental]\nstack = true\n[storage.buckets.avatars]\npublic = true\n';

async function setup(
	options: Parameters<typeof createEngineHarness>[0] = {}
): Promise<{ h: EngineHarness; repo: string; stackId: string }> {
	const h = await createEngineHarness({
		enabled: true,
		start: false,
		...options,
	});
	const repo = await h.repository('repo', {
		migrations: 2,
		lockfile: true,
		config: CONFIG_WITH_BUCKET,
	});
	await h.engine.start();
	await h.engine.settle();
	return { h, repo, stackId: await h.identity(repo) };
}

async function started(
	options: Parameters<typeof createEngineHarness>[0] = {}
): Promise<{ h: EngineHarness; repo: string; stackId: string }> {
	const context = await setup(options);
	const receipt = await run(context.h, {
		kind: 'start',
		stackId: context.stackId,
	});
	expect(receipt.jobId).toBeDefined();
	await context.h.engine.waitForJob(receipt.jobId ?? '', 10_000);
	await context.h.settle();
	return context;
}

function stackOf(h: EngineHarness, stackId: string) {
	return h.engine.getState().stacks.find((stack) => stack.id === stackId);
}

function jobOf(h: EngineHarness, jobId: string | undefined) {
	return jobId === undefined ? undefined : h.engine.job(jobId);
}

describe('operation checks', () => {
	it('re-checks every operation against a fresh state', async () => {
		const { h } = await setup();
		const receipt = await run(h, { kind: 'restart', stackId: 'f'.repeat(64) });
		expect(receipt).toMatchObject({
			completed: false,
			error: { code: 'unknown_target' },
		});
		expect(h.cli.count('stack restart')).toBe(0);
	});

	it('refuses a guarded operation that arrives without its token', async () => {
		const { h, stackId } = await started();
		await runToEnd(h, { kind: 'stop', stackIds: [stackId] });
		await h.settle();
		const receipt = await run(h, {
			kind: 'destroy',
			stackIds: [stackId],
			removeUploads: false,
		});
		expect(receipt.error?.code).toBe('confirmation_required');
		expect(h.cli.count('stack destroy')).toBe(0);
		const facts = await h.engine.describeConfirmation(
			op({ kind: 'destroy', stackIds: [stackId], removeUploads: false })
		);
		expect(facts?.title).toBe('Destroy the local Supabase stack for main?');
		expect(facts?.choices[0]?.label).toMatch(/^Destroy main/);
	});
});

describe('lifecycle operations', () => {
	it('starts the branch the worktree is on, pinned, and answers with its job', async () => {
		const { h, stackId } = await setup();
		const receipt = await run(h, { kind: 'start', stackId });
		expect(receipt).toMatchObject({ completed: true });
		expect(receipt.jobId).toMatch(/^supabase-job-/);
		expect(receipt.message).toBeUndefined();
		expect(jobOf(h, receipt.jobId)?.kind).toBe('create');
		await h.engine.waitForJob(receipt.jobId ?? '', 10_000);
		await h.settle();
		expect(jobOf(h, receipt.jobId)?.status).toBe('complete');
		expect(stackOf(h, stackId)).toMatchObject({
			state: 'running',
			pinned: true,
		});
		// Already running: attached at once, no job.
		const again = await run(h, { kind: 'restart', stackId });
		expect(again.jobId).toBeDefined();
	});

	it('refuses to start a stack whose worktree moved to another branch', async () => {
		const { h, repo, stackId } = await started();
		await runToEnd(h, { kind: 'stop', stackIds: [stackId] });
		await h.settle();
		await h.checkout(repo, 'feat-x');
		await run(h, { kind: 'refresh' });
		const receipt = await run(h, { kind: 'start', stackId });
		expect(receipt.completed).toBe(false);
		expect(receipt.error?.message).toMatch(/Switch back to main first/);
		expect(h.cli.callsOf('stack start')).toHaveLength(1);
	});

	it('stops with one CLI call per stack and unpins them', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const first = await h.repository('first');
		const second = await h.repository('second');
		await h.engine.start();
		await h.engine.settle();
		const ids = [await h.identity(first), await h.identity(second)];
		for (const stackId of ids) {
			await runToEnd(h, { kind: 'start', stackId });
			await h.settle();
		}
		const receipt = await run(h, { kind: 'stop', stackIds: ids });
		expect(receipt.jobId).toBeDefined();
		await h.engine.waitForJob(receipt.jobId ?? '', 10_000);
		await h.settle();
		expect(h.cli.callsOf('stack stop').map((call) => call.argv[3])).toEqual(
			expect.arrayContaining(ids)
		);
		for (const stackId of ids) {
			expect(stackOf(h, stackId)).toMatchObject({
				state: 'stopped',
				pinned: false,
			});
		}
		expect(h.engine.getState().activity[0]).toMatchObject({
			kind: 'stop',
			outcome: 'complete',
		});
	});

	it('restarts with stack restart and keeps the pin', async () => {
		const { h, stackId } = await started();
		const receipt = await run(h, { kind: 'restart', stackId });
		await h.engine.waitForJob(receipt.jobId ?? '', 10_000);
		await h.settle();
		expect(jobOf(h, receipt.jobId)?.status).toBe('complete');
		expect(h.cli.callsOf('stack restart')[0]?.argv).toEqual([
			'stack',
			'restart',
			'--stack-id',
			stackId,
			'--output-format',
			'json',
		]);
		expect(stackOf(h, stackId)?.pinned).toBe(true);
	});

	it('resumes a stopped stack with its saved settings, even on another branch', async () => {
		const { h, repo, stackId } = await started();
		await runToEnd(h, { kind: 'stop', stackIds: [stackId] });
		await h.settle();
		await h.checkout(repo, 'feat-x');
		await run(h, { kind: 'refresh' });
		const receipt = await run(h, { kind: 'resume-saved', stackId });
		await h.engine.waitForJob(receipt.jobId ?? '', 10_000);
		await h.settle();
		expect(jobOf(h, receipt.jobId)?.status).toBe('complete');
		expect(h.cli.callsOf('stack restart')[0]?.argv).toEqual(
			expect.arrayContaining(['--stack-id', stackId])
		);
		// A restart loads no config, so no start ran for the other branch.
		expect(h.cli.callsOf('stack start')).toHaveLength(1);
		expect(stackOf(h, stackId)).toMatchObject({
			state: 'running',
			pinned: true,
		});
	});

	it('stops and starts again to apply the config, only on its branch', async () => {
		const { h, repo, stackId } = await started();
		const receipt = await run(h, {
			kind: 'stop-and-start',
			stackId,
			purpose: 'apply-config',
		});
		expect(receipt.message).toBe(
			'Restarting the stack with its current settings.'
		);
		await h.engine.waitForJob(receipt.jobId ?? '', 10_000);
		await h.settle();
		expect(jobOf(h, receipt.jobId)).toMatchObject({
			kind: 'stop-and-start',
			status: 'complete',
		});
		expect(h.cli.count('stack stop')).toBe(1);
		expect(h.cli.callsOf('stack start')).toHaveLength(2);
		await h.checkout(repo, 'feat-x');
		const moved = await run(h, {
			kind: 'stop-and-start',
			stackId,
			purpose: 'apply-config',
		});
		expect(moved.completed).toBe(false);
		expect(h.cli.count('stack stop')).toBe(1);
	});

	it('re-applies exclusions with a stop and a start, only on its branch', async () => {
		const { h, repo, stackId } = await setup();
		await h.engine.policyStore.updatePolicy({
			exclude: ['studio', 'analytics', 'functions'],
		});
		await runToEnd(h, { kind: 'start', stackId });
		await h.settle();
		// The stack runs functions anyway (an agent's bare start dropped them).
		expect(stackOf(h, stackId)?.compositionDrift).toEqual({
			reenabled: ['functions'],
		});
		const receipt = await run(h, { kind: 'reapply-exclusions', stackId });
		// The job itself, not a settle: a stop and a start can outlast its
		// quiet window on a loaded machine.
		await h.engine.waitForJob(receipt.jobId ?? '', 10_000);
		expect(jobOf(h, receipt.jobId)?.status).toBe('complete');
		expect(h.cli.count('stack stop')).toBe(1);
		const restart = h.cli.callsOf('stack start').at(-1)?.argv ?? [];
		expect(restart).toEqual(expect.arrayContaining(['--stack-id', stackId]));
		expect(
			restart[restart.indexOf('--exclude') + 1]?.split(',').sort()
		).toEqual(['analytics', 'functions', 'studio']);
		await h.checkout(repo, 'feat-x');
		const moved = await run(h, { kind: 'reapply-exclusions', stackId });
		expect(moved.completed).toBe(false);
		expect(h.cli.count('stack stop')).toBe(1);
	});

	it('turns Studio on by starting again without the studio exclusion', async () => {
		const { h, stackId } = await started();
		const receipt = await run(
			h,
			{ kind: 'set-studio', stackId, enabled: true },
			CONFIRMED
		);
		await h.engine.waitForJob(receipt.jobId ?? '', 10_000);
		await h.settle();
		expect(jobOf(h, receipt.jobId)?.status).toBe('complete');
		expect(h.cli.callsOf('stack start').at(-1)?.argv).toEqual(
			expect.arrayContaining(['--exclude', 'analytics'])
		);
		expect(h.engine.stackStore.record(stackId)?.studioEnabled).toBe(true);
	});

	it('adopts a running stack another tool started, after checking loopback', async () => {
		const { h, repo, stackId } = await setup();
		h.cli.addStack({ id: stackId, projectRoot: repo, running: true });
		await run(h, { kind: 'refresh' });
		expect(stackOf(h, stackId)?.origin).toBe('external');
		const receipt = await run(h, { kind: 'adopt', stackId });
		expect(receipt.completed).toBe(true);
		expect(h.engine.stackStore.record(stackId)?.origin).toBe('adopted');
		expect(h.discovery.probes).toContain('lsof');
		expect(h.cli.count('stack start')).toBe(0);
	});

	it('pins, unpins and releases one holder', async () => {
		const { h, repo, stackId } = await setup();
		h.agents.sessions = [fakeSession('session-a', '/Users/example/elsewhere')];
		await h.engine.runAgentOperation(
			{ operation: 'up', target: { worktreePath: repo }, waitMs: 45_000 },
			{ requestId: 'request-1', holder: CLAUDE, synthetic: false },
			SIGNAL
		);
		await h.settle();
		expect((await run(h, { kind: 'pin', stackId })).completed).toBe(true);
		expect(stackOf(h, stackId)?.pinned).toBe(true);
		expect((await run(h, { kind: 'unpin', stackId })).completed).toBe(true);
		expect(stackOf(h, stackId)?.pinned).toBe(false);
		const release = await run(
			h,
			{
				kind: 'release',
				stackId,
				holder: {
					holder: 'session',
					agentKind: 'claude',
					sessionId: 'session-a',
				},
			},
			CONFIRMED
		);
		expect(release.message).toMatch(/Released the hold/);
		expect(h.engine.stackStore.record(stackId)?.holds).toEqual([]);
	});

	it('follows the branch when asked', async () => {
		const { h, repo, stackId } = await started();
		await h.engine.policyStore.updatePolicy({ branchSwitch: 'warn' });
		await h.checkout(repo, 'feat-x');
		await run(h, { kind: 'refresh' });
		const follows = vi.spyOn(h.engine, 'followBranch');
		// Asking skips the 30 s debounce an automatic follow waits for.
		const receipt = await run(h, { kind: 'follow-branch', stackId });
		expect(receipt.completed).toBe(true);
		// The receipt comes with the new stack's job; the follow itself ends
		// once the old stack's stop is done.
		await expect(follows.mock.results[0]?.value).resolves.toEqual({
			status: 'complete',
		});
		const next = await h.identity(repo);
		expect(h.cli.stacks.get(next)?.running).toBe(true);
		expect(h.cli.stacks.get(stackId)?.running).toBe(false);
		expect(h.engine.stackStore.record(next)?.pinned).toBe(true);
	});

	it('prepares services once on a managed worktree, then stops the stack', async () => {
		const { h, stackId } = await setup();
		const repositoryId = h.engine.getState().repositories[0]?.id;
		const receipt = await run(h, { kind: 'prepare', repositoryId });
		expect(receipt.jobId).toBeDefined();
		await h.engine.waitForJob(receipt.jobId ?? '', 10_000);
		await h.settle();
		expect(jobOf(h, receipt.jobId)?.status).toBe('complete');
		expect(h.cli.callsOf('stack prepare')[0]?.argv).toEqual(
			expect.arrayContaining(['--runtime', 'native'])
		);
		expect(h.cli.stacks.get(stackId)?.running).toBe(false);
		expect(h.engine.stackStore.record(stackId)?.flags.prepared).toBe(true);
		// The next start creates it from the project root.
		await runToEnd(h, { kind: 'start', stackId });
		await h.settle();
		expect(h.cli.callsOf('stack start')[0]?.argv).toContain('--workdir');
	});
});

describe('database operations', () => {
	it('applies migrations, resets and seeds buckets locally on the stack branch only', async () => {
		const { h, repo, stackId } = await started();
		const migrate = await run(h, { kind: 'apply-migrations', stackId });
		await h.engine.waitForJob(migrate.jobId ?? '', 10_000);
		await h.settle();
		expect(jobOf(h, migrate.jobId)?.status).toBe('complete');
		expect(h.cli.callsOf('migration up')[0]?.argv).toEqual(
			expect.arrayContaining(['--local', '--workdir', repo])
		);
		const pinned = await run(
			h,
			{ kind: 'reset', stackId, seed: false },
			CONFIRMED
		);
		expect(pinned.error?.message).toMatch(/Unpin it first/);
		await run(h, { kind: 'unpin', stackId });
		const reset = await run(
			h,
			{ kind: 'reset', stackId, seed: false },
			CONFIRMED
		);
		await h.engine.waitForJob(reset.jobId ?? '', 10_000);
		await h.settle();
		expect(jobOf(h, reset.jobId)?.status).toBe('complete');
		expect(h.cli.callsOf('db reset')[0]?.argv).toEqual(
			expect.arrayContaining(['--local', '--no-seed'])
		);
		const seed = await run(h, { kind: 'seed-buckets', stackId }, CONFIRMED);
		await h.engine.waitForJob(seed.jobId ?? '', 10_000);
		await h.settle();
		expect(jobOf(h, seed.jobId)?.status).toBe('complete');
		await h.checkout(repo, 'feat-x');
		const moved = await run(h, { kind: 'apply-migrations', stackId });
		expect(moved.completed).toBe(false);
		expect(h.cli.count('migration up')).toBe(1);
	});

	it('runs no reset once the worktree moved while it waited for a CLI slot', async () => {
		const { h, repo, stackId } = await started();
		await run(h, { kind: 'unpin', stackId });
		// Four log reads take every CLI slot.
		const release = h.cli.hold('stack logs');
		const reads = [1, 2, 3, 4].map(() =>
			h.engine.runOperation(op({ kind: 'read-logs', stackId, tail: 200 }), {
				...OPERATOR,
			})
		);
		await h.until(() => h.cli.count('stack logs') === 4);
		const reset = await run(
			h,
			{ kind: 'reset', stackId, seed: true },
			CONFIRMED
		);
		await h.checkout(repo, 'feat-x');
		release();
		await Promise.all(reads);
		await h.engine.waitForJob(reset.jobId ?? '', 10_000);
		await h.settle();
		expect(h.cli.count('db reset')).toBe(0);
		expect(jobOf(h, reset.jobId)).toMatchObject({
			status: 'failed',
			error: { title: 'Worktree switched branches' },
		});
	});

	it("tells an agent its queued reset didn't run once the worktree moved", async () => {
		const { h, repo, stackId } = await setup();
		h.agents.sessions = [fakeSession('session-a', '/Users/example/elsewhere')];
		await h.engine.runAgentOperation(
			{ operation: 'up', target: { worktreePath: repo }, waitMs: 45_000 },
			{ requestId: 'request-1', holder: CLAUDE, synthetic: false },
			SIGNAL
		);
		await h.settle();
		// An operator restart holds the stack's lock.
		const release = h.cli.hold('stack restart');
		await run(h, { kind: 'restart', stackId });
		await h.cli.waitForCall('stack restart');
		const reset = h.engine.runAgentOperation(
			{ operation: 'reset', target: { stackId }, seed: true },
			{ requestId: 'request-2', holder: CLAUDE, synthetic: false },
			SIGNAL
		);
		await h.until(() =>
			h.engine.jobStore.activeJobs().some((job) => job.kind === 'reset')
		);
		await h.checkout(repo, 'feat-x');
		release();
		await expect(reset).rejects.toMatchObject({ code: 'branch_moved' });
		expect(h.cli.count('db reset')).toBe(0);
	});

	it('tells an agent its queued reset was called off once turned off', async () => {
		const { h, repo, stackId } = await setup();
		h.agents.sessions = [fakeSession('session-a', '/Users/example/elsewhere')];
		await h.engine.runAgentOperation(
			{ operation: 'up', target: { worktreePath: repo }, waitMs: 45_000 },
			{ requestId: 'request-1', holder: CLAUDE, synthetic: false },
			SIGNAL
		);
		await h.settle();
		// An operator restart holds the stack's lock.
		const release = h.cli.hold('stack restart');
		await run(h, { kind: 'restart', stackId });
		await h.cli.waitForCall('stack restart');
		const reset = h.engine.runAgentOperation(
			{ operation: 'reset', target: { stackId }, seed: true },
			{ requestId: 'request-2', holder: CLAUDE, synthetic: false },
			SIGNAL
		);
		await h.until(() =>
			h.engine.jobStore.activeJobs().some((job) => job.kind === 'reset')
		);
		await run(
			h,
			{ kind: 'set-enabled', enabled: false, disposition: 'leave-running' },
			CONFIRMED
		);
		release();
		await expect(reset).rejects.toMatchObject({ code: 'supabase_disabled' });
		expect(h.cli.count('db reset')).toBe(0);
	});

	it('reads the database locally, or through DB_URL for reads only when HEAD moved', async () => {
		const { h, repo, stackId } = await started();
		const local = await run(h, { kind: 'read-database', stackId });
		expect(local.database).toMatchObject({
			target: 'local',
			migrations: { comparable: true },
		});
		expect(h.cli.callsOf('inspect db')[0]?.argv).toContain('--local');
		await h.checkout(repo, 'feat-x');
		const remote = await run(h, { kind: 'read-database', stackId });
		expect(remote.database).toMatchObject({
			target: 'db-url',
			migrations: { comparable: false },
		});
		const reads = h.cli.callsOf('inspect db').slice(2);
		for (const call of reads) {
			const url = call.argv[call.argv.indexOf('--db-url') + 1] ?? '';
			expect(url).toMatch(/sslmode=disable$/);
		}
		expect(h.cli.callsOf('migration list')).toHaveLength(1);
	});

	it('reads logs history, sanitized and bounded', async () => {
		const { h, stackId } = await started();
		const receipt = await run(h, { kind: 'read-logs', stackId, tail: 200 });
		expect(receipt.logs?.records.length).toBeGreaterThan(0);
		expect(h.cli.callsOf('stack logs')[0]?.argv).toEqual(
			expect.arrayContaining(['--stack-id', stackId, '--tail', '200'])
		);
	});

	it('keeps the newest logs when the CLI prints more than RN Devtools reads', async () => {
		const { h, stackId } = await started();
		h.cli.replyNext('stack logs', {
			exitCode: 0,
			stdout: '[',
			stderr: [],
			stdoutTruncated: true,
		});
		const receipt = await run(h, {
			kind: 'read-logs',
			stackId,
			tail: 1_000,
			since: '1h',
		});
		expect(receipt.completed).toBe(true);
		expect(receipt.logs?.records.length).toBeGreaterThan(0);
		expect(receipt.logs?.truncated).toBe(true);
		expect(
			h.cli
				.callsOf('stack logs')
				.map((call) => call.argv[call.argv.indexOf('--tail') + 1])
		).toEqual(['1000', '250']);
	});

	it('exports through the save dialog main shows, and reveals the file', async () => {
		const { h, stackId } = await started();
		h.dialog.saveFile = path.join(h.base, 'export.sql');
		const receipt = await run(h, {
			kind: 'export',
			stackId,
			content: 'schema',
		});
		expect(receipt).toMatchObject({
			completed: true,
			export: { content: 'schema', revealable: true },
		});
		expect(h.cli.callsOf('db dump')[0]?.argv).toEqual(
			expect.arrayContaining(['--local', '--file', h.dialog.saveFile])
		);
		expect(h.cli.callsOf('db dump')[0]?.argv).not.toContain('--dry-run');
		const reveal = await run(h, { kind: 'reveal', stackId, what: 'export' });
		expect(reveal.reveal).toEqual({ revealed: true, what: 'export' });
		expect(h.shell.revealed).toEqual([h.dialog.saveFile]);
		h.dialog.saveFile = undefined;
		const cancelled = await run(h, {
			kind: 'export',
			stackId,
			content: 'data',
		});
		expect(cancelled).toMatchObject({ completed: false, cancelled: true });
	});
});

describe('destroy and recreate', () => {
	it('destroys only stopped stacks from a fresh list, and uploads only when asked', async () => {
		const { h, repo, stackId } = await started();
		const uploads = path.join(
			repo,
			'supabase',
			'.temp',
			'stack-uploads',
			stackId
		);
		await mkdir(uploads, { recursive: true });
		await writeFile(path.join(uploads, 'avatar.png'), 'png');
		const running = await run(
			h,
			{ kind: 'destroy', stackIds: [stackId], removeUploads: true },
			CONFIRMED
		);
		expect(running.completed).toBe(false);
		await runToEnd(h, { kind: 'stop', stackIds: [stackId] });
		await h.settle();
		const receipt = await run(
			h,
			{ kind: 'destroy', stackIds: [stackId], removeUploads: true },
			CONFIRMED
		);
		await h.engine.waitForJob(receipt.jobId ?? '', 10_000);
		await h.settle();
		expect(jobOf(h, receipt.jobId)?.status).toBe('complete');
		expect(h.cli.callsOf('stack destroy')[0]?.argv).toEqual([
			'stack',
			'destroy',
			'--stack-id',
			stackId,
			'--yes',
			'--output-format',
			'json',
		]);
		await expect(stat(uploads)).rejects.toThrow();
		expect(h.engine.stackStore.record(stackId)).toBeUndefined();
		expect(stackOf(h, stackId)?.state).toBe('not-created');
	});

	it('keeps the uploads unless asked', async () => {
		const { h, repo, stackId } = await started();
		const uploads = path.join(
			repo,
			'supabase',
			'.temp',
			'stack-uploads',
			stackId
		);
		await mkdir(uploads, { recursive: true });
		await runToEnd(h, { kind: 'stop', stackIds: [stackId] });
		await h.settle();
		await runToEnd(
			h,
			{ kind: 'destroy', stackIds: [stackId], removeUploads: false },
			CONFIRMED
		);
		await h.settle();
		await expect(stat(uploads)).resolves.toBeTruthy();
	});

	it('recreates a stack whose saved configuration cannot adopt the new one', async () => {
		const { h, stackId } = await started();
		await runToEnd(h, { kind: 'stop', stackIds: [stackId] });
		await h.settle();
		const stack = h.cli.stacks.get(stackId);
		if (stack) stack.configChanged = true;
		h.cli.replyNext('stack start', 'start-needs-recreate');
		await runToEnd(h, { kind: 'start', stackId });
		await h.settle();
		expect(stackOf(h, stackId)?.state).toBe('needs-recreate');
		const facts = await h.engine.describeConfirmation(
			op({ kind: 'recreate', stackId })
		);
		expect(facts?.lines.join('\n')).toMatch(/major_version/);
		const receipt = await run(h, { kind: 'recreate', stackId }, CONFIRMED);
		await h.engine.waitForJob(receipt.jobId ?? '', 10_000);
		await h.settle();
		expect(jobOf(h, receipt.jobId)?.status).toBe('complete');
		expect(h.cli.count('stack destroy')).toBe(1);
		expect(h.cli.callsOf('stack start').at(-1)?.argv).toContain('--workdir');
		expect(stackOf(h, stackId)?.state).toBe('running');
	});
});

describe('values main resolves', () => {
	it('opens only loopback Mailpit URLs', async () => {
		const { h, stackId } = await started();
		const receipt = await run(h, {
			kind: 'open',
			stackId,
			surface: 'mailpit',
		});
		expect(receipt.open).toEqual({ opened: true, surface: 'mailpit' });
		expect(h.shell.opened).toEqual(['http://127.0.0.1:21213/']);
		const studio = await run(h, { kind: 'open', stackId, surface: 'studio' });
		expect(studio.completed).toBe(false);
	});

	it('copies main-resolved values and clears a secret only if it is still there', async () => {
		const { h, stackId } = await started();
		const url = await run(h, { kind: 'copy', stackId, what: 'api-url' });
		expect(url.copy).toEqual({ copied: true, what: 'api-url' });
		expect(h.clipboard.text).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		const key = await run(h, {
			kind: 'copy',
			stackId,
			what: 'publishable-key',
		});
		expect(key.copy?.clearsAt).toBe(h.clock.now + SUPABASE_CLIPBOARD_CLEAR_MS);
		expect(h.clipboard.text).toBe(h.cli.secrets.publishableKey);
		await h.advance(SUPABASE_CLIPBOARD_CLEAR_MS);
		expect(h.clipboard.text).toBe('');
		await run(h, { kind: 'copy', stackId, what: 'psql-command' });
		expect(h.clipboard.text).toMatch(/^psql 'postgresql:\/\//);
		// The user copied something else meanwhile: left alone.
		h.clipboard.text = 'something the user copied';
		await h.advance(SUPABASE_CLIPBOARD_CLEAR_MS);
		expect(h.clipboard.text).toBe('something the user copied');
		const env = await run(h, { kind: 'copy', stackId, what: 'app-env' });
		expect(env.message).toMatch(/2 app variables/);
		expect(h.clipboard.text).toMatch(
			/^EXPO_PUBLIC_SUPABASE_URL=http:\/\/127\.0\.0\.1:\d+\nEXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_/
		);
	});

	it('reveals only paths main resolved', async () => {
		const { h, repo, stackId } = await started();
		const config = await run(h, { kind: 'reveal', stackId, what: 'config' });
		expect(config.reveal).toEqual({ revealed: true, what: 'config' });
		expect(h.shell.revealed).toEqual([
			path.join(repo, 'supabase', 'config.toml'),
		]);
		const uploads = await run(h, { kind: 'reveal', stackId, what: 'uploads' });
		expect(uploads.completed).toBe(false);
	});
});

describe('requests', () => {
	it('approves an agent destroy request with the operator dialog', async () => {
		const { h, repo, stackId } = await started();
		h.agents.sessions = [fakeSession('session-a', '/Users/example/elsewhere')];
		const filed = await h.engine.runAgentOperation(
			{
				operation: 'destroy',
				target: { worktreePath: repo },
				note: 'Start over',
			},
			{ requestId: 'request-1', holder: CLAUDE, synthetic: false },
			SIGNAL
		);
		expect(filed).toMatchObject({ operation: 'destroy', status: 'pending' });
		const requestId = (filed as { requestId: string }).requestId;
		const facts = await h.engine.describeConfirmation(
			op({ kind: 'request.approve', requestId })
		);
		expect(facts?.lines.join('\n')).toMatch(/asked to destroy it/);
		expect(facts?.lines.join('\n')).not.toMatch(/Start over/);
		expect(facts?.lines).toContain(
			'It is running; RN Devtools stops it first.'
		);
		const receipt = await run(
			h,
			{ kind: 'request.approve', requestId, removeUploads: false },
			CONFIRMED
		);
		await h.engine.waitForJob(receipt.jobId ?? '', 10_000);
		await h.settle();
		expect(jobOf(h, receipt.jobId)?.status).toBe('complete');
		expect(h.cli.stacks.has(stackId)).toBe(false);
		expect(h.engine.stackStore.request(requestId)?.status).toBe('approved');
	});

	it('denies a request', async () => {
		const { h, repo } = await started();
		const filed = await h.engine.runAgentOperation(
			{ operation: 'destroy', target: { worktreePath: repo } },
			{ requestId: 'request-1', holder: CODEX, synthetic: false },
			SIGNAL
		);
		const requestId = (filed as { requestId: string }).requestId;
		const receipt = await run(h, { kind: 'request.deny', requestId });
		expect(receipt.message).toMatch(/Request denied/);
		expect(h.engine.stackStore.request(requestId)?.status).toBe('denied');
		expect(h.cli.count('stack destroy')).toBe(0);
	});
});

describe('settings', () => {
	it('turns off and stops managed stacks one at a time, then runs nothing', async () => {
		const { h, stackId } = await started();
		const facts = await h.engine.describeConfirmation(
			op({ kind: 'set-enabled', enabled: false })
		);
		expect(facts?.choices.map((choice) => choice.disposition)).toEqual([
			'leave-running',
			'stop-managed',
		]);
		const receipt = await run(
			h,
			{ kind: 'set-enabled', enabled: false, disposition: 'stop-managed' },
			CONFIRMED
		);
		expect(receipt.message).toBe('Turning off... stopping 1 managed stack.');
		await h.engine.waitForJob(receipt.jobId ?? '', 10_000);
		await h.settle();
		expect(jobOf(h, receipt.jobId)?.status).toBe('complete');
		expect(h.cli.stacks.get(stackId)?.running).toBe(false);
		const before = h.processCalls();
		await h.advance(30 * 60_000);
		expect(h.processCalls()).toBe(before);
		expect(h.engine.getState().feature.enabled).toBe(false);
	});

	it('turns off leaving stacks running', async () => {
		const { h, stackId } = await started();
		const receipt = await run(
			h,
			{ kind: 'set-enabled', enabled: false, disposition: 'leave-running' },
			CONFIRMED
		);
		expect(receipt.message).toBe(
			'Local Supabase is off. 1 stack keeps running.'
		);
		await h.settle();
		expect(h.cli.stacks.get(stackId)?.running).toBe(true);
	});

	it('turns off stopping managed stacks, and starts nothing for an ensure still queued', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		const other = await h.repository('other');
		const lane = fakeLane({ worktreePath: other });
		h.lanes.lanes = [lane];
		await h.engine.start();
		await h.engine.settle();
		await runToEnd(h, { kind: 'start', stackId: await h.identity(repo) });
		await h.settle();
		// The other stack can't adopt its configuration: a follow never tries
		// it again, a lane does.
		const otherId = await h.identity(other);
		await runToEnd(h, { kind: 'start', stackId: otherId });
		await h.settle();
		await runToEnd(h, { kind: 'stop', stackIds: [otherId] });
		await h.settle();
		const stack = h.cli.stacks.get(otherId);
		const facts = await h.engine.worktreeFacts(other);
		if (!stack || !facts) throw new Error('The other stack did not start.');
		stack.configChanged = true;
		h.cli.replyNext('stack start', 'start-needs-recreate');
		await runToEnd(h, { kind: 'start', stackId: otherId });
		await h.settle();
		expect(stackOf(h, otherId)?.state).toBe('needs-recreate');
		const reads = h.cli.count('stack status');
		const release = h.cli.hold('stack status');
		const follow = h.engine.ensureStack(facts, {
			requestedBy: { kind: 'automatic', reason: 'follow' },
			createdBy: { via: 'desktop' },
		});
		await h.until(() => h.cli.count('stack status') > reads);
		// The lane's ensure waits for the follow, so it has no job yet.
		const laneEnsure = h.engine.ensureStack(facts, {
			requestedBy: { kind: 'lane', laneId: lane.id },
			createdBy: { via: 'desktop' },
		});
		const receipt = await run(
			h,
			{ kind: 'set-enabled', enabled: false, disposition: 'stop-managed' },
			CONFIRMED
		);
		expect(receipt.message).toBe('Turning off... stopping 1 managed stack.');
		const starts = h.cli.count('stack start');
		release();
		await expect(follow).resolves.toMatchObject({ kind: 'refused' });
		await expect(laneEnsure).resolves.toMatchObject({
			kind: 'refused',
			reason: 'disabled',
		});
		await h.engine.waitForJob(receipt.jobId ?? '', 10_000);
		await h.settle();
		expect(jobOf(h, receipt.jobId)?.status).toBe('complete');
		expect(h.cli.count('stack start')).toBe(starts);
		expect(h.cli.running()).toEqual([]);
	});

	it('turns off stopping a stack whose start ran, and calls off one still waiting', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		const first = await h.repository('first');
		const second = await h.repository('second');
		await h.engine.start();
		await h.engine.settle();
		await runToEnd(h, { kind: 'start', stackId: await h.identity(repo) });
		await h.settle();
		const release = h.cli.hold('stack start');
		const creating = await run(h, {
			kind: 'start',
			stackId: await h.identity(first),
		});
		await h.until(() => h.cli.count('stack start') === 2);
		// New stacks start one at a time: this one still waits its turn.
		const waiting = await run(h, {
			kind: 'start',
			stackId: await h.identity(second),
		});
		expect(jobOf(h, waiting.jobId)?.status).toBe('queued');
		const receipt = await run(
			h,
			{ kind: 'set-enabled', enabled: false, disposition: 'stop-managed' },
			CONFIRMED
		);
		// The running creation counts, though the state doesn't show it yet.
		expect(receipt.message).toBe('Turning off... stopping 2 managed stacks.');
		const stops = h.cli.count('stack stop');
		release();
		// The turn-off ends last: it waits for both starts first.
		await h.engine.waitForJob(receipt.jobId ?? '', 10_000);
		await h.settle();
		// It finished first and then stopped; the waiting one never began.
		expect(jobOf(h, creating.jobId)?.status).toBe('complete');
		expect(jobOf(h, waiting.jobId)?.status).toBe('cancelled');
		expect(jobOf(h, receipt.jobId)?.status).toBe('complete');
		expect(h.cli.count('stack start')).toBe(2);
		expect(h.cli.count('stack stop')).toBe(stops + 2);
		expect(h.cli.running()).toEqual([]);
	});

	it('turns off stopping managed stacks, and calls off a restart still waiting its turn', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		const first = await h.repository('first');
		const second = await h.repository('second');
		h.lanes.lanes = [fakeLane({ id: LANE_ID, worktreePath: repo })];
		await h.engine.start();
		await h.engine.settle();
		for (const worktree of [first, second, repo]) {
			await runToEnd(h, { kind: 'start', stackId: await h.identity(worktree) });
			await h.settle();
		}
		const stackId = await h.identity(repo);
		const facts = await h.engine.worktreeFacts(repo);
		if (!facts) throw new Error('The worktree has no facts.');
		// Two stops take both lifecycle slots.
		const releaseStops = h.cli.hold('stack stop');
		await run(h, {
			kind: 'stop',
			stackIds: [await h.identity(first), await h.identity(second)],
		});
		await h.until(() => h.cli.count('stack stop') === 2);
		// Another CLI release serves the stack, so the lane's ensure restarts it.
		h.clock.now += 6_000;
		h.cli.replyNext(
			'stack status',
			h.cli.fixtureFor('status-release-mismatch', stackId)
		);
		let restartJob: string | undefined;
		const ensure = h.engine.ensureStack(facts, {
			requestedBy: { kind: 'lane', laneId: LANE_ID },
			createdBy: { via: 'desktop' },
			onJob: (jobId) => {
				restartJob = jobId;
			},
		});
		await h.until(() => restartJob !== undefined);
		const receipt = await run(
			h,
			{ kind: 'set-enabled', enabled: false, disposition: 'stop-managed' },
			CONFIRMED
		);
		expect(receipt.message).toBe('Turning off... stopping 3 managed stacks.');
		const starts = h.cli.count('stack start');
		releaseStops();
		await expect(ensure).resolves.toMatchObject({
			kind: 'refused',
			reason: 'disabled',
		});
		await h.engine.waitForJob(receipt.jobId ?? '', 10_000);
		await h.settle();
		expect(jobOf(h, restartJob)?.status).toBe('cancelled');
		expect(jobOf(h, receipt.jobId)?.status).toBe('complete');
		// Nothing started the stack again after the turn-off stopped it.
		expect(h.cli.count('stack start')).toBe(starts);
		expect(h.cli.running()).toEqual([]);
	});

	const bringingUp: readonly Readonly<{
		name: string;
		/** The call held open while the state doesn't show the stack running. */
		held: string;
		/**
		 * Stopped first; then also moved to another branch (stale), or unable
		 * to adopt its configuration (needs-recreate).
		 */
		before?: 'stopped' | 'stale' | 'needs-recreate';
		/** What the state shows meanwhile: stopped unless said otherwise. */
		shows?: string;
		begin: (
			h: EngineHarness,
			stackId: string,
			repo: string
		) => Promise<unknown>;
	}>[] = [
		{
			name: "a lane's ensure restarting it with the worktree's CLI",
			held: 'stack start',
			begin: async (h, stackId, repo) => {
				// Another CLI release serves it: it is stopped, then started.
				h.clock.now += 6_000;
				h.cli.replyNext(
					'stack status',
					h.cli.fixtureFor('status-release-mismatch', stackId)
				);
				return h.engine.ensureForLane({
					laneId: LANE_ID,
					worktreePath: repo,
					branch: 'main',
					environmentId: 'development',
					policy: 'auto',
					waitMs: 60_000,
				});
			},
		},
		{
			name: 'a stop-and-start',
			held: 'stack start',
			begin: (h, stackId) =>
				run(h, { kind: 'stop-and-start', stackId, purpose: 'apply-config' }),
		},
		{
			name: 'turning Studio on',
			held: 'stack start',
			begin: (h, stackId) =>
				run(h, { kind: 'set-studio', stackId, enabled: true }, CONFIRMED),
		},
		{
			name: 'a resume with its saved settings',
			held: 'stack restart',
			before: 'stale',
			begin: (h, stackId) => run(h, { kind: 'resume-saved', stackId }),
		},
		{
			name: 'a resume',
			held: 'stack start',
			before: 'stopped',
			begin: (h, stackId) => run(h, { kind: 'start', stackId }),
		},
		{
			name: 'a recreate',
			held: 'stack start',
			before: 'needs-recreate',
			shows: 'not-created',
			begin: (h, stackId) => run(h, { kind: 'recreate', stackId }, CONFIRMED),
		},
	];
	for (const job of bringingUp) {
		it(`turns off stopping a stack ${job.name} brings up`, async () => {
			const { h, repo, stackId } = await started();
			h.lanes.lanes = [fakeLane({ id: LANE_ID, worktreePath: repo })];
			if (job.before !== undefined) {
				await runToEnd(h, { kind: 'stop', stackIds: [stackId] });
				await h.settle();
			}
			if (job.before === 'stale') {
				// Stopped, and its worktree moved to another branch since.
				await h.checkout(repo, 'feat-x');
				await run(h, { kind: 'refresh' });
			}
			if (job.before === 'needs-recreate') {
				// Stopped, and its saved state can't adopt the new configuration.
				const stack = h.cli.stacks.get(stackId);
				if (stack) stack.configChanged = true;
				h.cli.replyNext('stack start', 'start-needs-recreate');
				await runToEnd(h, { kind: 'start', stackId });
				await h.settle();
				expect(stackOf(h, stackId)?.state).toBe('needs-recreate');
			}
			const calls = h.cli.count(job.held);
			const release = h.cli.hold(job.held);
			const pending = job.begin(h, stackId, repo);
			await h.until(() => h.cli.count(job.held) > calls);
			// The state doesn't show the stack running; the job still counts it.
			expect(stackOf(h, stackId)?.state).toBe(job.shows ?? 'stopped');
			const receipt = await run(
				h,
				{ kind: 'set-enabled', enabled: false, disposition: 'stop-managed' },
				CONFIRMED
			);
			expect(receipt.message).toBe('Turning off... stopping 1 managed stack.');
			release();
			await pending;
			await h.engine.waitForJob(receipt.jobId ?? '', 10_000);
			await h.settle();
			expect(jobOf(h, receipt.jobId)?.status).toBe('complete');
			expect(h.cli.running()).toEqual([]);
		});
	}

	it('turns on again only once a turn-off that stops managed stacks has stopped them', async () => {
		const { h, stackId } = await setup();
		const starts = h.cli.count('stack start');
		const releaseStart = h.cli.hold('stack start');
		await run(h, { kind: 'start', stackId });
		await h.until(() => h.cli.count('stack start') > starts);
		const off = await run(
			h,
			{ kind: 'set-enabled', enabled: false, disposition: 'stop-managed' },
			CONFIRMED
		);
		expect(off.message).toBe('Turning off... stopping 1 managed stack.');
		// While it waits for the start, turning on would leave its stops to
		// run with the feature on.
		const on = await run(h, { kind: 'set-enabled', enabled: true }, CONFIRMED);
		expect(on).toMatchObject({
			completed: false,
			error: {
				code: 'refused',
				message: 'Local Supabase is still turning off.',
			},
		});
		releaseStart();
		await h.engine.waitForJob(off.jobId ?? '', 10_000);
		await h.settle();
		expect(jobOf(h, off.jobId)?.status).toBe('complete');
		expect(h.engine.getState().feature.enabled).toBe(false);
		expect(h.cli.running()).toEqual([]);
		const again = await run(
			h,
			{ kind: 'set-enabled', enabled: true },
			CONFIRMED
		);
		expect(again.completed).toBe(true);
		await h.engine.settle();
		expect(h.engine.getState().discovery.status).toBe('live');
	});

	it('turns on with the acknowledgement time', async () => {
		const h = await createEngineHarness({ start: false });
		await h.repository('repo');
		await h.engine.start();
		const receipt = await run(
			h,
			{ kind: 'set-enabled', enabled: true },
			CONFIRMED
		);
		expect(receipt.completed).toBe(true);
		await h.settle();
		expect(h.engine.getState().feature).toMatchObject({
			enabled: true,
			acknowledgedAt: h.clock.now,
		});
		expect(h.engine.getState().discovery.status).toBe('live');
		expect(h.cli.count('stack list')).toBe(1);
	});

	it('saves the policy and writes per-stack keys only where git ignores them', async () => {
		const { h, repo, stackId } = await started();
		const applies = vi.spyOn(h.engine, 'applyPerStackKeys');
		// The keys are written after the receipt, and nothing a settle watches
		// (a CLI call, a probe, a job) marks it: wait for the write itself.
		const applied = () =>
			expect(applies.mock.results.at(-1)?.value).resolves.toBeUndefined();
		const receipt = await run(
			h,
			{ kind: 'update-policy', patch: { perStackKeys: true } },
			CONFIRMED
		);
		expect(receipt.message).toMatch(/Per-stack keys apply/);
		await applied();
		const env = await readFile(
			path.join(repo, 'supabase', '.env.local'),
			'utf8'
		);
		expect(env).toMatch(/^SUPABASE_AUTH_JWT_SECRET=/m);
		expect(env).toMatch(/^SUPABASE_AUTH_PUBLISHABLE_KEY=sb_publishable_/m);
		expect(h.checkIgnores).toContain(path.join('supabase', '.env.local'));
		// The state and stores never carry the keys.
		expect(JSON.stringify(h.engine.getState())).not.toMatch(SECRET_SHAPED);
		await run(h, { kind: 'update-policy', patch: { perStackKeys: false } });
		await applied();
		expect(
			await readFile(path.join(repo, 'supabase', '.env.local'), 'utf8')
		).not.toMatch(/SUPABASE_AUTH_/);
		expect(stackOf(h, stackId)?.state).toBe('running');
	});

	it('turns a repository off and back on', async () => {
		const { h, stackId } = await setup();
		const repositoryId = h.engine.getState().repositories[0]?.id;
		await run(h, { kind: 'repository.set-mode', repositoryId, mode: 'off' });
		expect(stackOf(h, stackId)).toBeUndefined();
		expect(h.engine.getState().repositories[0]?.mode).toBe('off');
		await run(h, { kind: 'repository.set-mode', repositoryId, mode: 'auto' });
		await run(h, { kind: 'repository.recheck', repositoryId });
		expect(stackOf(h, stackId)?.mode.value).toBe('managed');
	});

	it('chooses the Supabase home through the open dialog, never while stacks run', async () => {
		const { h, stackId } = await started();
		const home = path.join(h.base, 'supabase-home');
		await mkdir(home, { recursive: true });
		h.dialog.openPaths = [home];
		const refused = await run(h, {
			kind: 'choose-path',
			field: 'supabase-home',
		});
		expect(refused.completed).toBe(false);
		await runToEnd(h, { kind: 'stop', stackIds: [stackId] });
		await h.settle();
		const receipt = await run(h, {
			kind: 'choose-path',
			field: 'supabase-home',
		});
		expect(receipt.completed).toBe(true);
		expect(h.engine.policySnapshot().paths.supabaseHome).toBe(
			await realpath(home)
		);
	});

	it('restarts the Metro of a lane on the stack', async () => {
		const { h, repo } = await started();
		h.lanes.lanes = [fakeLane({ id: LANE_ID, worktreePath: repo })];
		await h.engine.ensureForLane({
			laneId: LANE_ID,
			worktreePath: repo,
			branch: 'main',
			environmentId: 'development',
			policy: 'auto',
		});
		await h.settle();
		const stackId = await h.identity(repo);
		const nothingToDo = await run(h, {
			kind: 'restart-metro',
			laneId: LANE_ID,
		});
		expect(nothingToDo.completed).toBe(false);
		// The API moved under the lane (another tool restarted it).
		const stack = h.cli.stacks.get(stackId);
		if (stack) stack.apiPort = 27_001;
		await h.engine.readStatus(stackId);
		expect(stackOf(h, stackId)?.lanes[0]?.needsMetroRestart).toBe(true);
		const receipt = await run(h, { kind: 'restart-metro', laneId: LANE_ID });
		expect(receipt.completed).toBe(true);
		expect(h.lanes.metroRestarts).toEqual([
			{ laneId: LANE_ID, reason: 'operator' },
		]);
	});
});

describe('work waiting its turn at a turn-off', () => {
	/** Holds the stack's lock, as any job on it does, until released. */
	function holdLock(h: EngineHarness, stackId: string) {
		let release: () => void = () => undefined;
		const held = h.engine.lockStack(
			stackId,
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				})
		);
		return async () => {
			release();
			await held;
		};
	}

	const turnOff = (h: EngineHarness) =>
		run(
			h,
			{ kind: 'set-enabled', enabled: false, disposition: 'leave-running' },
			CONFIRMED
		);

	const queued: readonly Readonly<{
		kind: string;
		/** The stack as the operation finds it. */
		stack:
			| 'running'
			| 'unpinned'
			| 'stopped'
			| 'stale'
			| 'needs-recreate'
			| 'none';
		fields: (stackId: string, h: EngineHarness) => Record<string, unknown>;
		confirmed?: boolean;
	}>[] = [
		{
			kind: 'stop',
			stack: 'running',
			fields: (stackId) => ({ stackIds: [stackId] }),
		},
		{ kind: 'restart', stack: 'running', fields: () => ({}) },
		{
			kind: 'stop-and-start',
			stack: 'running',
			fields: () => ({ purpose: 'apply-config' }),
		},
		{
			kind: 'set-studio',
			stack: 'running',
			fields: () => ({ enabled: true }),
			confirmed: true,
		},
		{ kind: 'apply-migrations', stack: 'running', fields: () => ({}) },
		{
			kind: 'reset',
			stack: 'unpinned',
			fields: () => ({ seed: false }),
			confirmed: true,
		},
		{
			kind: 'seed-buckets',
			stack: 'running',
			fields: () => ({}),
			confirmed: true,
		},
		{ kind: 'start', stack: 'stopped', fields: () => ({}) },
		{ kind: 'resume-saved', stack: 'stale', fields: () => ({}) },
		{
			kind: 'destroy',
			stack: 'stopped',
			fields: (stackId) => ({ stackIds: [stackId], removeUploads: false }),
			confirmed: true,
		},
		{
			kind: 'recreate',
			stack: 'needs-recreate',
			fields: () => ({}),
			confirmed: true,
		},
		{
			kind: 'prepare',
			stack: 'none',
			fields: (_stackId, h) => ({
				repositoryId: h.engine.getState().repositories[0]?.id,
			}),
		},
	];
	for (const operation of queued) {
		it(`calls off a ${operation.kind} whose turn comes once turned off`, async () => {
			const { h, repo, stackId } =
				operation.stack === 'none' ? await setup() : await started();
			if (operation.stack === 'unpinned') {
				await run(h, { kind: 'unpin', stackId });
			}
			if (
				operation.stack === 'stopped' ||
				operation.stack === 'stale' ||
				operation.stack === 'needs-recreate'
			) {
				await runToEnd(h, { kind: 'stop', stackIds: [stackId] });
				await h.settle();
			}
			if (operation.stack === 'stale') {
				await h.checkout(repo, 'feat-x');
				await run(h, { kind: 'refresh' });
			}
			if (operation.stack === 'needs-recreate') {
				const stack = h.cli.stacks.get(stackId);
				if (stack) stack.configChanged = true;
				h.cli.replyNext('stack start', 'start-needs-recreate');
				await runToEnd(h, { kind: 'start', stackId });
				await h.settle();
				expect(stackOf(h, stackId)?.state).toBe('needs-recreate');
			}
			const release = holdLock(h, stackId);
			const receipt = await run(
				h,
				{
					kind: operation.kind,
					...(operation.kind === 'stop' ||
					operation.kind === 'destroy' ||
					operation.kind === 'prepare'
						? {}
						: { stackId }),
					...operation.fields(stackId, h),
				},
				operation.confirmed ? CONFIRMED : OPERATOR
			);
			expect(receipt.jobId).toBeDefined();
			await h.settle();
			await turnOff(h);
			const calls = h.processCalls();
			await release();
			await h.engine.waitForJob(receipt.jobId ?? '', 10_000);
			await h.settle();
			expect(jobOf(h, receipt.jobId)).toMatchObject({
				status: 'cancelled',
				error: { code: 'feature_off' },
			});
			// Not one CLI call or probe once it is off.
			expect(h.processCalls()).toBe(calls);
		});
	}

	it('adopts nothing once turned off while it waited for the lock', async () => {
		const { h, repo, stackId } = await setup();
		h.cli.addStack({ id: stackId, projectRoot: repo, running: true });
		await run(h, { kind: 'refresh' });
		expect(stackOf(h, stackId)?.origin).toBe('external');
		const release = holdLock(h, stackId);
		const adopting = h.engine.runOperation(
			op({ kind: 'adopt', stackId }),
			OPERATOR
		);
		await h.settle();
		await turnOff(h);
		const calls = h.processCalls();
		await release();
		await expect(adopting).resolves.toMatchObject({
			completed: false,
			error: { code: 'feature_off' },
		});
		expect(h.processCalls()).toBe(calls);
		expect(h.engine.stackStore.record(stackId)).toBeUndefined();
	});

	it('destroys nothing an approved request asked for once turned off', async () => {
		const { h, repo, stackId } = await started();
		h.agents.sessions = [fakeSession('session-a', '/Users/example/elsewhere')];
		const filed = await h.engine.runAgentOperation(
			{ operation: 'destroy', target: { worktreePath: repo } },
			{ requestId: 'request-1', holder: CLAUDE, synthetic: false },
			SIGNAL
		);
		const requestId = (filed as { requestId: string }).requestId;
		const release = holdLock(h, stackId);
		const receipt = await run(
			h,
			{ kind: 'request.approve', requestId, removeUploads: false },
			CONFIRMED
		);
		await h.settle();
		await turnOff(h);
		const calls = h.processCalls();
		await release();
		await h.engine.waitForJob(receipt.jobId ?? '', 10_000);
		await h.settle();
		expect(jobOf(h, receipt.jobId)).toMatchObject({
			status: 'cancelled',
			error: { code: 'feature_off' },
		});
		expect(h.engine.stackStore.request(requestId)).toMatchObject({
			status: 'failed',
			error: { code: 'feature_off' },
		});
		expect(h.processCalls()).toBe(calls);
		expect(h.cli.stacks.has(stackId)).toBe(true);
	});

	it('destroys nothing without a fresh list once turned off', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		const other = await h.repository('other');
		await h.engine.start();
		await h.engine.settle();
		const stackId = await h.identity(repo);
		for (const worktree of [repo, other]) {
			await runToEnd(h, { kind: 'start', stackId: await h.identity(worktree) });
			await h.settle();
		}
		await runToEnd(h, { kind: 'stop', stackIds: [stackId] });
		await h.settle();
		// The destroy got its turn, and its fresh list is still being read.
		const release = holdLock(h, stackId);
		const receipt = await run(
			h,
			{ kind: 'destroy', stackIds: [stackId], removeUploads: false },
			CONFIRMED
		);
		const lists = h.cli.count('stack list');
		const releaseList = h.cli.hold('stack list');
		await release();
		await h.until(() => h.cli.count('stack list') > lists);
		// Stop managed stacks keeps the old list until it has stopped the other.
		const releaseStop = h.cli.hold('stack stop');
		const off = await run(
			h,
			{ kind: 'set-enabled', enabled: false, disposition: 'stop-managed' },
			CONFIRMED
		);
		expect(off.message).toBe('Turning off... stopping 1 managed stack.');
		releaseList();
		await h.engine.waitForJob(receipt.jobId ?? '', 10_000);
		releaseStop();
		await h.settle();
		expect(jobOf(h, receipt.jobId)).toMatchObject({
			status: 'failed',
			error: { code: 'feature_off' },
		});
		expect(h.cli.count('stack destroy')).toBe(0);
		expect(h.cli.stacks.has(stackId)).toBe(true);
	});

	it('dumps nothing once turned off while the save dialog was open', async () => {
		const { h, stackId } = await started();
		let choose: () => void = () => undefined;
		vi.spyOn(h.engine.deps.dialog, 'showSaveDialog').mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					choose = () =>
						resolve({ canceled: false, filePath: path.join(h.base, 'a.sql') });
				})
		);
		const exporting = h.engine.runOperation(
			op({ kind: 'export', stackId, content: 'schema' }),
			OPERATOR
		);
		await h.settle();
		await turnOff(h);
		const calls = h.processCalls();
		choose();
		await expect(exporting).resolves.toMatchObject({
			completed: false,
			error: { code: 'feature_off' },
		});
		await h.settle();
		expect(h.processCalls()).toBe(calls);
		expect(h.cli.count('db dump')).toBe(0);
	});
});

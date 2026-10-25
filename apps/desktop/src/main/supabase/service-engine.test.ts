import {
	mkdir,
	readdir,
	readFile,
	realpath,
	stat,
	writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	attentionItems,
	type SupabaseOperation,
	stackStatus,
	supabaseActionAvailability,
	supabaseOperationSchema,
	supabaseStateSchema,
} from '../../shared/supabase-protocol';
import { AgentCliError } from '../agent-cli-service';
import { SECRET_SHAPED } from './cli-fixtures.test-support';
import {
	createEngineHarness,
	disposeEngineHarnesses,
	type EngineHarness,
	fakeLane,
	fakeResolvedCli,
	fakeSession,
} from './engine.test-support';
import { SupabaseJobStore, supabaseArgvDigest } from './job-store';
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
// slowest take about 2.5 s in a full desktop run, under a tenth of this.
vi.setConfig({ testTimeout: 30_000 });

afterEach(disposeEngineHarnesses);

const OPERATOR: SupabaseOperationContext = {
	actor: { kind: 'operator', senderId: 1 },
	confirmed: false,
};
const CONFIRMED: SupabaseOperationContext = { ...OPERATOR, confirmed: true };
const CLAUDE = { kind: 'claude', sessionId: 'session-a' } as const;
const SIGNAL = new AbortController().signal;
const MIGRATION_FAILED = {
	exitCode: 1,
	stdout: `${JSON.stringify({ _tag: 'Error', error: { code: 'MigrationApplyError', message: 'ERROR: relation "profiles" does not exist' } })}\n`,
	stderr: [],
} as const;

let counter = 0;
function op(fields: Record<string, unknown>): SupabaseOperation {
	counter += 1;
	return supabaseOperationSchema.parse({
		actionId: `action-${counter}`,
		...fields,
	});
}

/** Runs an operation and waits for the job it answers with to end. */
async function runToEnd(
	h: EngineHarness,
	fields: Record<string, unknown>,
	context: SupabaseOperationContext = OPERATOR
) {
	const receipt = await h.engine.runOperation(op(fields), context);
	await h.engine.waitForJob(receipt.jobId ?? '', 10_000);
	return receipt;
}

async function startStack(h: EngineHarness, worktree: string): Promise<string> {
	const stackId = await h.identity(worktree);
	const receipt = await h.engine.runOperation(
		op({ kind: 'start', stackId }),
		OPERATOR
	);
	expect(receipt.completed).toBe(true);
	await h.engine.waitForJob(receipt.jobId ?? '', 10_000);
	await h.settle();
	return stackId;
}

/** An agent's up: a session hold, no pin. */
async function agentUp(
	h: EngineHarness,
	worktree: string,
	holder: { kind: 'claude' | 'codex' | 'other'; sessionId: string } = CLAUDE
) {
	const result = await h.engine.runAgentOperation(
		{ operation: 'up', target: { worktreePath: worktree }, waitMs: 45_000 },
		{ requestId: 'request-1', holder, synthetic: false },
		SIGNAL
	);
	await h.settle();
	return result;
}

function stateOf(h: EngineHarness, stackId: string) {
	return h.engine.getState().stacks.find((stack) => stack.id === stackId);
}

/** Turns local Supabase off, leaving stacks running. */
function turnOff(h: EngineHarness) {
	return h.engine.runOperation(
		op({ kind: 'set-enabled', enabled: false }),
		CONFIRMED
	);
}

/**
 * Holds the answer of the first call `when` accepts until release(): the
 * call ran (a probe, a read), and its caller waits for the answer.
 */
function holdFirst<A extends unknown[], R>(
	call: (...args: A) => Promise<R>,
	when: (...args: A) => boolean = () => true
) {
	let release: () => void = () => undefined;
	let held = false;
	return {
		call: async (...args: A): Promise<R> => {
			const result = await call(...args);
			if (!held && when(...args)) {
				held = true;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			}
			return result;
		},
		held: () => held,
		release: () => release(),
	};
}

/** Holds the stack's lock, as work on it does, until the returned call. */
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

/** What a branch follow asks for. */
const FOLLOW = {
	requestedBy: { kind: 'automatic', reason: 'follow' },
	createdBy: { via: 'desktop' },
} as const;

/** A stack that ran once and stopped, with its worktree's facts. */
async function stoppedStack(h: EngineHarness, worktree: string) {
	const stackId = await startStack(h, worktree);
	const stop = await h.engine.runOperation(
		op({ kind: 'stop', stackIds: [stackId] }),
		OPERATOR
	);
	await h.engine.waitForJob(stop.jobId ?? '', 10_000);
	await h.settle();
	const facts = await h.engine.worktreeFacts(worktree);
	const stack = h.cli.stacks.get(stackId);
	if (!facts || !stack) throw new Error('The stack did not start.');
	return { stackId, facts, stack };
}

/** A stopped stack whose saved state can't adopt [db] major_version. */
async function needsRecreateStack(h: EngineHarness, worktree: string) {
	const stopped = await stoppedStack(h, worktree);
	stopped.stack.configChanged = true;
	h.cli.replyNext('stack start', 'start-needs-recreate');
	const start = await h.engine.runOperation(
		op({ kind: 'start', stackId: stopped.stackId }),
		OPERATOR
	);
	await h.engine.waitForJob(start.jobId ?? '', 10_000);
	await h.settle();
	expect(stateOf(h, stopped.stackId)?.state).toBe('needs-recreate');
	return stopped;
}

describe('SupabaseEngine while off', () => {
	it('runs no process while local Supabase is off', async () => {
		const h = await createEngineHarness({ start: false });
		const repo = await h.repository('repo', { migrations: 1 });
		h.lanes.lanes = [fakeLane({ worktreePath: repo })];
		await h.engine.start();
		await h.engine.settle();
		h.engine.setInterest('renderer-1', {
			view: 'stacks',
			inspectStackId: 'a'.repeat(64),
			sections: ['overview'],
		});
		const lane = await h.engine.ensureForLane({
			laneId: 'lane-11111111-2222-4333-8444-555555555555',
			worktreePath: repo,
			branch: 'main',
			environmentId: 'development',
			policy: 'auto',
		});
		expect(lane.summary).toMatchObject({
			status: 'skipped',
			reason: 'disabled',
		});
		await expect(
			h.engine.runAgentOperation(
				{ operation: 'ls' },
				{ requestId: 'request-1', holder: CLAUDE, synthetic: false },
				SIGNAL
			)
		).rejects.toBeInstanceOf(AgentCliError);
		await h.engine.releaseHolder({ holder: CLAUDE });
		const facts = await h.engine.describeConfirmation(
			op({ kind: 'set-enabled', enabled: true })
		);
		expect(facts?.choices[0]?.label).toBe('Turn on');
		const refused = await h.engine.runOperation(
			op({ kind: 'refresh' }),
			OPERATOR
		);
		expect(refused.error?.code).toBe('feature_off');
		h.engine.doctor();
		h.engine.holderKeys();
		h.engine.steering();
		await h.advance(30 * 60_000);
		expect(h.processCalls()).toBe(0);
		expect(h.clock.pendingTimers).toBe(0);
		const state = supabaseStateSchema.parse(h.engine.getState());
		expect(state.source).toBe('live');
		expect(state.discovery.status).toBe('off');
	});

	it('runs no process on a Mac that cannot run native stacks', async () => {
		const h = await createEngineHarness({
			enabled: true,
			supported: false,
			start: false,
		});
		await h.repository('repo');
		await h.engine.start();
		await h.advance(10 * 60_000);
		expect(h.processCalls()).toBe(0);
		expect(h.engine.getState().availability.platform.supported).toBe(false);
	});

	it('stops probing once turned off, and removes the steering file', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		await expect(stat(h.engine.steeringWriter.file)).resolves.toBeTruthy();
		const receipt = await h.engine.runOperation(
			op({ kind: 'set-enabled', enabled: false }),
			CONFIRMED
		);
		expect(receipt.completed).toBe(true);
		await h.engine.settle();
		await expect(stat(h.engine.steeringWriter.file)).rejects.toThrow();
		const before = h.processCalls();
		await h.advance(30 * 60_000);
		expect(h.processCalls()).toBe(before);
		expect(h.clock.pendingTimers).toBe(0);
	});

	it('refuses an ensure queued behind an automatic one once turned off', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		const lane = fakeLane({ worktreePath: repo });
		h.lanes.lanes = [lane];
		await h.engine.start();
		await h.engine.settle();
		const { stackId, facts } = await needsRecreateStack(h, repo);
		const reads = h.cli.count('stack status');
		const release = h.cli.hold('stack status');
		const follow = h.engine.ensureStack(facts, FOLLOW);
		await h.until(() => h.cli.count('stack status') > reads);
		// The lane waits for the follow, which still reads the stack's status,
		// long enough for the list to need reading again.
		const laneEnsure = h.engine.ensureStack(facts, {
			requestedBy: { kind: 'lane', laneId: lane.id },
			createdBy: { via: 'desktop' },
		});
		expect(h.engine.ensureQueued(stackId)).toBe(true);
		h.clock.now += 6_000;
		const off = await h.engine.runOperation(
			op({ kind: 'set-enabled', enabled: false }),
			CONFIRMED
		);
		expect(off.message).toBe('Local Supabase is off.');
		const calls = h.processCalls();
		release();
		await expect(follow).resolves.toMatchObject({ kind: 'refused' });
		await expect(laneEnsure).resolves.toMatchObject({
			kind: 'refused',
			reason: 'disabled',
			agentCode: 'supabase_disabled',
		});
		await h.settle();
		// Nothing is probed or started once it is off.
		expect(h.processCalls()).toBe(calls);
		expect(h.cli.running()).toEqual([]);
	});

	it('reads nothing more for an ensure whose list outlasts the feature', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const { facts } = await stoppedStack(h, repo);
		// The list knows the stopped stack, so listing it again reads nothing
		// more on its own.
		await h.engine.refreshList();
		h.clock.now += 6_000;
		const lists = h.cli.count('stack list');
		const release = h.cli.hold('stack list');
		const follow = h.engine.ensureStack(facts, FOLLOW);
		await h.until(() => h.cli.count('stack list') > lists);
		await h.engine.runOperation(
			op({ kind: 'set-enabled', enabled: false }),
			CONFIRMED
		);
		const calls = h.processCalls();
		release();
		await expect(follow).resolves.toMatchObject({
			kind: 'refused',
			reason: 'disabled',
		});
		await h.settle();
		expect(h.processCalls()).toBe(calls);
	});

	it('starts nothing for an ensure whose status read outlasts the feature', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const { facts } = await stoppedStack(h, repo);
		const reads = h.cli.count('stack status');
		const release = h.cli.hold('stack status');
		// A follow that would resume the stopped stack once it read it.
		const follow = h.engine.ensureStack(facts, FOLLOW);
		await h.until(() => h.cli.count('stack status') > reads);
		await h.engine.runOperation(
			op({ kind: 'set-enabled', enabled: false }),
			CONFIRMED
		);
		const calls = h.processCalls();
		const jobs = h.engine.jobStore.jobs().length;
		release();
		await expect(follow).resolves.toMatchObject({
			kind: 'refused',
			reason: 'disabled',
		});
		await h.settle();
		// Not even a job that is called off at once.
		expect(h.engine.jobStore.jobs()).toHaveLength(jobs);
		expect(h.processCalls()).toBe(calls);
		expect(h.cli.running()).toEqual([]);
	});

	it('stops reading a stack someone else is starting once turned off', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const { stackId, facts } = await stoppedStack(h, repo);
		// Another tool started it, and the CLI still says it is starting.
		const awake = h.cli.fixtureFor('status-awake', stackId);
		const starting = {
			...awake,
			stdout: awake.stdout.replace(
				'"lifecycle":"running"',
				'"lifecycle":"starting"'
			),
		};
		for (let reply = 0; reply < 8; reply += 1) {
			h.cli.replyNext('stack status', starting);
		}
		const reads = h.cli.count('stack status');
		const follow = h.engine.ensureStack(facts, FOLLOW);
		await h.until(() => h.cli.count('stack status') > reads);
		await h.settle();
		await h.engine.runOperation(
			op({ kind: 'set-enabled', enabled: false }),
			CONFIRMED
		);
		const calls = h.processCalls();
		await h.advance(5_000);
		expect(h.processCalls()).toBe(calls);
		await expect(follow).resolves.toMatchObject({
			kind: 'refused',
			reason: 'disabled',
		});
	});

	it('calls off a start that still waited its turn when turned off', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const first = await h.repository('first');
		const second = await h.repository('second');
		await h.engine.start();
		await h.engine.settle();
		const release = h.cli.hold('stack start');
		await h.engine.runOperation(
			op({ kind: 'start', stackId: await h.identity(first) }),
			OPERATOR
		);
		await h.cli.waitForCall('stack start');
		// New stacks start one at a time: this one waits behind the first.
		const facts = await h.engine.worktreeFacts(second);
		if (!facts) throw new Error('The worktree has no facts.');
		let queuedJob: string | undefined;
		const queued = h.engine.ensureStack(facts, {
			requestedBy: { kind: 'operator' },
			createdBy: { via: 'desktop' },
			onJob: (jobId) => {
				queuedJob = jobId;
			},
		});
		await h.until(() => queuedJob !== undefined);
		expect(h.engine.job(queuedJob ?? '')?.status).toBe('queued');
		await h.engine.runOperation(
			op({ kind: 'set-enabled', enabled: false }),
			CONFIRMED
		);
		release();
		await expect(queued).resolves.toMatchObject({
			kind: 'refused',
			reason: 'disabled',
			agentCode: 'supabase_disabled',
		});
		await h.engine.waitForJob(queuedJob ?? '', 10_000);
		await h.settle();
		expect(h.engine.job(queuedJob ?? '')?.status).toBe('cancelled');
		// Only the start that already ran when it was turned off went on.
		expect(h.cli.count('stack start')).toBe(1);
	});

	it('calls off the restart of an ensure still waiting its turn when turned off', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		const first = await h.repository('first');
		const second = await h.repository('second');
		const lane = fakeLane({ worktreePath: repo });
		h.lanes.lanes = [lane];
		await h.engine.start();
		await h.engine.settle();
		const others = [await startStack(h, first), await startStack(h, second)];
		const stackId = await startStack(h, repo);
		const facts = await h.engine.worktreeFacts(repo);
		if (!facts) throw new Error('The worktree has no facts.');
		// Two stops take both lifecycle slots.
		const releaseStops = h.cli.hold('stack stop');
		await h.engine.runOperation(
			op({ kind: 'stop', stackIds: others }),
			OPERATOR
		);
		await h.until(() => h.cli.count('stack stop') === 2);
		// Another CLI release serves the stack, so the ensure restarts it.
		h.clock.now += 6_000;
		h.cli.replyNext(
			'stack status',
			h.cli.fixtureFor('status-release-mismatch', stackId)
		);
		let restartJob: string | undefined;
		const ensure = h.engine.ensureStack(facts, {
			requestedBy: { kind: 'lane', laneId: lane.id },
			createdBy: { via: 'desktop' },
			onJob: (jobId) => {
				restartJob = jobId;
			},
		});
		await h.until(() => restartJob !== undefined);
		expect(h.engine.job(restartJob ?? '')).toMatchObject({
			kind: 'stop-and-start',
			status: 'queued',
		});
		await h.engine.runOperation(
			op({ kind: 'set-enabled', enabled: false }),
			CONFIRMED
		);
		const calls = h.cli.calls.length;
		releaseStops();
		await expect(ensure).resolves.toMatchObject({
			kind: 'refused',
			reason: 'disabled',
			agentCode: 'supabase_disabled',
		});
		await h.engine.waitForJob(restartJob ?? '', 10_000);
		await h.settle();
		expect(h.engine.job(restartJob ?? '')).toMatchObject({
			status: 'cancelled',
			error: { code: 'feature_off' },
		});
		// It neither stopped nor started the stack, which keeps running.
		expect(
			h.cli.calls.slice(calls).filter((call) => call.argv.includes(stackId))
		).toEqual([]);
		expect(h.cli.stacks.get(stackId)?.running).toBe(true);
	});

	it('calls off a drift restart still waiting its turn, and tries it again once on', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		const first = await h.repository('first');
		const second = await h.repository('second');
		await h.engine.start();
		await h.engine.settle();
		const stackId = await startStack(h, repo);
		const others = [await startStack(h, first), await startStack(h, second)];
		await runToEnd(h, { kind: 'stop', stackIds: others });
		await h.settle();
		// pnpm install replaced the binary the owner runs.
		const stack = h.cli.stacks.get(stackId);
		if (!stack) throw new Error('The stack did not start.');
		stack.executable = '/opt/example/old/supabase';
		await h.advance(15_000);
		// Two resumes take both lifecycle slots when the restart comes due.
		const starts = h.cli.count('stack start');
		const releaseStarts = h.cli.hold('stack start');
		for (const other of others) {
			await h.engine.runOperation(
				op({ kind: 'start', stackId: other }),
				OPERATOR
			);
		}
		await h.until(() => h.cli.count('stack start') === starts + 2);
		await h.advance(45_000);
		const restart = h.engine.jobStore
			.activeJobs()
			.find((job) => job.kind === 'stop-and-start');
		expect(restart).toMatchObject({ status: 'queued', stackIds: [stackId] });
		await h.engine.runOperation(
			op({ kind: 'set-enabled', enabled: false }),
			CONFIRMED
		);
		const calls = h.cli.calls.length;
		releaseStarts();
		await h.engine.waitForJob(restart?.id ?? '', 10_000);
		await h.settle();
		expect(h.engine.job(restart?.id ?? '')).toMatchObject({
			status: 'cancelled',
			error: { code: 'feature_off' },
		});
		expect(
			h.cli.calls.slice(calls).filter((call) => call.argv.includes(stackId))
		).toEqual([]);
		// It never ran, so it is tried again once the feature is on.
		await h.engine.runOperation(
			op({ kind: 'set-enabled', enabled: true }),
			CONFIRMED
		);
		await h.engine.settle();
		await h.advance(60_000);
		expect(h.cli.callsOf('stack stop').at(-1)?.argv).toContain(stackId);
		expect(h.cli.callsOf('stack start').at(-1)?.argv).toEqual(
			expect.arrayContaining(['--stack-id', stackId])
		);
		expect(h.cli.stacks.get(stackId)?.executable).not.toBe(
			'/opt/example/old/supabase'
		);
	});

	it('probes nothing for an attach that waited for the lock across the turn-off', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		const lane = fakeLane({ worktreePath: repo });
		h.lanes.lanes = [lane];
		const stackId = await h.identity(repo);
		// Another tool started it: no record, and no exposure check yet.
		h.cli.addStack({ id: stackId, projectRoot: repo, running: true });
		await h.engine.start();
		await h.engine.settle();
		const facts = await h.engine.worktreeFacts(repo);
		if (!facts) throw new Error('The worktree has no facts.');
		// Any work that holds the stack's lock: a stop, a reset, a sweep.
		let release: () => void = () => undefined;
		const holder = h.engine.lockStack(
			stackId,
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				})
		);
		const probes = h.discovery.probes.length;
		const ensure = h.engine.ensureStack(facts, {
			requestedBy: { kind: 'lane', laneId: lane.id },
			createdBy: { via: 'desktop' },
		});
		await h.settle();
		expect(h.discovery.probes.slice(probes)).toEqual([]);
		await h.engine.runOperation(
			op({ kind: 'set-enabled', enabled: false }),
			CONFIRMED
		);
		const calls = h.processCalls();
		release();
		await holder;
		await expect(ensure).resolves.toMatchObject({
			kind: 'refused',
			reason: 'disabled',
			agentCode: 'supabase_disabled',
		});
		await h.settle();
		expect(h.processCalls()).toBe(calls);
		// Nor was it adopted.
		expect(h.engine.stackStore.record(stackId)).toBeUndefined();
	});

	it('calls off an automatic stop still waiting its turn when turned off', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		const first = await h.repository('first');
		const second = await h.repository('second');
		h.agents.sessions = [fakeSession('session-a', '/Users/example/elsewhere')];
		await h.engine.start();
		await h.engine.settle();
		const others = [await startStack(h, first), await startStack(h, second)];
		await agentUp(h, repo);
		const stackId = await h.identity(repo);
		// Two restarts take both lifecycle slots.
		const release = h.cli.hold('stack restart');
		for (const other of others) {
			await h.engine.runOperation(
				op({ kind: 'restart', stackId: other }),
				OPERATOR
			);
		}
		await h.until(() => h.cli.count('stack restart') === 2);
		await h.engine.releaseHolder({ holder: CLAUDE });
		await h.advance(61_000);
		// The linger ran out, so the stop is due, but it waits its turn.
		const stop = h.engine.jobStore
			.activeJobs()
			.find((job) => job.kind === 'stop' && job.stackIds.includes(stackId));
		expect(stop?.status).toBe('queued');
		await h.engine.runOperation(
			op({ kind: 'set-enabled', enabled: false }),
			CONFIRMED
		);
		const stops = h.cli.count('stack stop');
		release();
		await h.engine.waitForJob(stop?.id ?? '', 10_000);
		await h.settle();
		expect(h.engine.job(stop?.id ?? '')).toMatchObject({
			status: 'cancelled',
			error: { code: 'feature_off' },
		});
		expect(h.cli.count('stack stop')).toBe(stops);
		expect(h.cli.stacks.get(stackId)?.running).toBe(true);
	});

	it('ends a cheap tick that was in flight when turned off', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		await startStack(h, repo);
		// The tick at 5 min is due to read capacity and sweep with lsof too.
		await h.advance(5 * 60_000 - 15_000);
		const discoverOwners = h.discovery.discoverOwners;
		let release: () => void = () => undefined;
		let held = false;
		h.discovery.discoverOwners = async () => {
			const owners = await discoverOwners();
			if (!held) {
				// pgrep ran; its answer comes once the feature is off.
				held = true;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			}
			return owners;
		};
		await h.advance(15_000);
		expect(held).toBe(true);
		await h.engine.runOperation(
			op({ kind: 'set-enabled', enabled: false }),
			CONFIRMED
		);
		const calls = h.processCalls();
		const jobs = h.engine.jobStore.jobs().length;
		release();
		await h.settle();
		// No port registry read, list, capacity read, restart, stop or lsof.
		expect(h.processCalls()).toBe(calls);
		expect(h.engine.jobStore.jobs()).toHaveLength(jobs);
		expect(h.clock.pendingTimers).toBe(0);
	});

	it('spawns no list that gets its turn once turned off', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const { facts } = await stoppedStack(h, repo);
		h.clock.now += 6_000;
		const lists = h.cli.count('stack list');
		const release = h.cli.hold('stack list');
		// A list already in flight: the tick's, a Refresh, a job's end.
		const inFlight = h.engine.refreshList();
		await h.until(() => h.cli.count('stack list') > lists);
		// The follow's list begins only after that one, never joining it.
		const follow = h.engine.ensureStack(facts, FOLLOW);
		await h.engine.runOperation(
			op({ kind: 'set-enabled', enabled: false }),
			CONFIRMED
		);
		const calls = h.processCalls();
		release();
		await inFlight;
		await expect(follow).resolves.toMatchObject({
			kind: 'refused',
			reason: 'disabled',
		});
		await h.settle();
		expect(h.processCalls()).toBe(calls);
	});

	it('spawns no list or status read that waited for a CLI slot when turned off', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const stackId = await startStack(h, repo);
		// Four log reads take every CLI slot.
		const release = h.cli.hold('stack logs');
		const logs = [1, 2, 3, 4].map(() =>
			h.engine.runOperation(
				op({ kind: 'read-logs', stackId, tail: 200 }),
				OPERATOR
			)
		);
		await h.until(() => h.cli.count('stack logs') === 4);
		h.clock.now += 1_000;
		const lists = h.cli.count('stack list');
		const reads = h.cli.count('stack status');
		const list = h.engine.refreshList();
		const status = h.engine.readStatus(stackId);
		await h.settle();
		await h.engine.runOperation(
			op({ kind: 'set-enabled', enabled: false }),
			CONFIRMED
		);
		release();
		await Promise.all(logs);
		await list;
		await expect(status).resolves.toBeUndefined();
		await h.settle();
		expect(h.cli.count('stack list')).toBe(lists);
		expect(h.cli.count('stack status')).toBe(reads);
		// Nor is a failure noted for the reads that never ran: on again, the
		// stack shows its last status until its first list.
		expect(h.engine.getState().discovery.listFailure).toBeUndefined();
		const releaseList = h.cli.hold('stack list');
		await h.engine.runOperation(
			op({ kind: 'set-enabled', enabled: true }),
			CONFIRMED
		);
		await h.until(() => h.cli.count('stack list') > lists);
		expect(stateOf(h, stackId)?.state).toBe('running');
		releaseList();
	});

	it("reads no status once off, not even its CLI's version", async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const stackId = await startStack(h, repo);
		await h.engine.runOperation(
			op({ kind: 'set-enabled', enabled: false }),
			CONFIRMED
		);
		await h.settle();
		// Long enough that the binary would be checked again.
		h.clock.now += 61_000;
		const calls = h.processCalls();
		await expect(h.engine.readStatus(stackId)).resolves.toBeUndefined();
		expect(h.processCalls()).toBe(calls);
	});

	it('ends a Refresh in flight when turned off', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		await startStack(h, repo);
		const discoverOwners = h.discovery.discoverOwners;
		let release: () => void = () => undefined;
		let held = false;
		h.discovery.discoverOwners = async () => {
			const owners = await discoverOwners();
			if (!held) {
				held = true;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			}
			return owners;
		};
		const refresh = h.engine.runOperation(op({ kind: 'refresh' }), OPERATOR);
		await h.until(() => held);
		await h.engine.runOperation(
			op({ kind: 'set-enabled', enabled: false }),
			CONFIRMED
		);
		const calls = h.processCalls();
		release();
		await refresh;
		await h.settle();
		expect(h.processCalls()).toBe(calls);
	});

	it('ends a start-up in flight when turned off again', async () => {
		const h = await createEngineHarness({ start: false });
		await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		await h.engine.policyStore.updatePolicy({ perStackKeys: true });
		const resolve = h.resolver.resolve.bind(h.resolver);
		let release: () => void = () => undefined;
		let held = false;
		h.resolver.resolve = async (input) => {
			const resolution = await resolve(input);
			if (!held) {
				held = true;
				await new Promise<void>((done) => {
					release = done;
				});
			}
			return resolution;
		};
		await h.engine.runOperation(
			op({ kind: 'set-enabled', enabled: true }),
			CONFIRMED
		);
		await h.until(() => held);
		await h.engine.runOperation(
			op({ kind: 'set-enabled', enabled: false }),
			CONFIRMED
		);
		const calls = h.processCalls();
		release();
		await h.settle();
		// No key file is checked with git, and no tick runs.
		expect(h.processCalls()).toBe(calls);
	});

	it('ends a measurement in flight when turned off', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		await startStack(h, repo);
		const processTree = h.discovery.processTree;
		let release: () => void = () => undefined;
		let held = false;
		h.discovery.processTree = async (...args) => {
			const tree = await processTree(...args);
			if (!held) {
				held = true;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			}
			return tree;
		};
		// The tab is shown: footprint and disk are measured at once.
		h.engine.setInterest('renderer-1', { view: 'stacks', sections: [] });
		await h.advance(1);
		expect(held).toBe(true);
		await h.engine.runOperation(
			op({ kind: 'set-enabled', enabled: false }),
			CONFIRMED
		);
		const calls = h.processCalls();
		release();
		await h.settle();
		expect(h.processCalls()).toBe(calls);
	});

	it('measures no other stack once turned off midway through a measurement', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const first = await h.repository('first');
		const second = await h.repository('second');
		await h.engine.start();
		await h.engine.settle();
		await startStack(h, first);
		await startStack(h, second);
		const memory = holdFirst(h.discovery.measureMemory);
		h.discovery.measureMemory = memory.call;
		// The tab is shown: footprint is measured at once, a stack at a time.
		h.engine.setInterest('renderer-1', { view: 'stacks', sections: [] });
		await h.advance(1);
		await h.until(memory.held);
		await turnOff(h);
		const calls = h.processCalls();
		memory.release();
		await h.settle();
		// Not even the second stack's process tree.
		expect(h.processCalls()).toBe(calls);
	});

	it('reads no repository for a tick turned off while it reads the port registry', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		// HEAD moved, so the tick reads the repositories again after its check.
		await h.checkout(repo, 'feat-x');
		const ports = holdFirst(h.discovery.readPortReservations);
		h.discovery.readPortReservations = ports.call;
		await h.advance(15_000);
		await h.until(ports.held);
		await turnOff(h);
		const calls = h.processCalls();
		ports.release();
		await h.settle();
		expect(h.processCalls()).toBe(calls);
	});

	it('reads no capacity for a tick turned off while it lists', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		// The tick at 5 min lists, then reads capacity.
		await h.advance(5 * 60_000 - 15_000);
		const lists = h.cli.count('stack list');
		const release = h.cli.hold('stack list');
		await h.advance(15_000);
		await h.until(() => h.cli.count('stack list') > lists);
		await turnOff(h);
		const calls = h.processCalls();
		release();
		await h.settle();
		expect(h.processCalls()).toBe(calls);
	});

	it('probes no memory pressure for a tick turned off during its capacity read', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		await startStack(h, repo);
		// The tick at 5 min reads capacity: Postgres slots, then memory pressure.
		await h.advance(5 * 60_000 - 15_000);
		const sysv = holdFirst(h.discovery.readSysvCapacity);
		h.discovery.readSysvCapacity = sysv.call;
		await h.advance(15_000);
		await h.until(sysv.held);
		await turnOff(h);
		const calls = h.processCalls();
		sysv.release();
		await h.settle();
		expect(h.processCalls()).toBe(calls);
	});

	it('restarts nothing for a tick turned off while it validates an owner binary', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const stackId = await startStack(h, repo);
		const stack = h.cli.stacks.get(stackId);
		if (!stack) throw new Error('The stack did not start.');
		// pnpm install removed the owner's binary: a restart is due at 45 s.
		stack.executable = '/opt/example/old/supabase';
		await h.advance(30_000);
		// Removed again, so the tick at 45 s validates the new path first.
		stack.executable = '/opt/example/older/supabase';
		const validate = holdFirst(
			h.resolver.validateBinary.bind(h.resolver),
			(input) => input.binaryPath === '/opt/example/older/supabase'
		);
		h.resolver.validateBinary = validate.call;
		await h.advance(15_000);
		await h.until(validate.held);
		await turnOff(h);
		const jobs = h.engine.jobStore.jobs().length;
		validate.release();
		await h.settle();
		// Not even a restart that is called off at once.
		expect(h.engine.jobStore.jobs()).toHaveLength(jobs);
	});

	it('probes nothing for an lsof sweep that waited for a lock across the turn-off', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const stackId = await startStack(h, repo);
		await h.advance(5 * 60_000 - 15_000);
		// Work that holds the stack's lock, with no job, across the 5 min sweep.
		const release = holdLock(h, stackId);
		const lsof = () =>
			h.discovery.probes.filter((probe) => probe === 'lsof').length;
		const before = lsof();
		await h.advance(15_000);
		expect(lsof()).toBe(before);
		await turnOff(h);
		const calls = h.processCalls();
		await release();
		await h.settle();
		expect(h.processCalls()).toBe(calls);
	});

	it('reads no repository for a Refresh turned off while it reads the port registry', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const ports = holdFirst(h.discovery.readPortReservations);
		h.discovery.readPortReservations = ports.call;
		const refresh = h.engine.runOperation(op({ kind: 'refresh' }), OPERATOR);
		await h.until(ports.held);
		await turnOff(h);
		const calls = h.processCalls();
		ports.release();
		await refresh;
		await h.settle();
		expect(h.processCalls()).toBe(calls);
	});

	it('shows no stack the turn-off stopped as running once on again', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const stackId = await startStack(h, repo);
		const off = await h.engine.runOperation(
			op({ kind: 'set-enabled', enabled: false, disposition: 'stop-managed' }),
			CONFIRMED
		);
		await h.engine.waitForJob(off.jobId ?? '', 10_000);
		await h.settle();
		expect(h.cli.stacks.get(stackId)?.running).toBe(false);
		const lists = h.cli.count('stack list');
		const release = h.cli.hold('stack list');
		await h.engine.runOperation(
			op({ kind: 'set-enabled', enabled: true }),
			CONFIRMED
		);
		await h.until(() => h.cli.count('stack list') > lists);
		// Nothing read it after its stop: it isn't known until its first list.
		expect(stateOf(h, stackId)?.state).toBe('unknown');
		release();
		await h.engine.settle();
		expect(stateOf(h, stackId)?.state).toBe('stopped');
	});

	it('shows no stack whose stop read its status across the turn-off as running once on again', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const stackId = await startStack(h, repo);
		const stops = h.cli.count('stack stop');
		const releaseStop = h.cli.hold('stack stop');
		const stop = await h.engine.runOperation(
			op({ kind: 'stop', stackIds: [stackId] }),
			OPERATOR
		);
		await h.until(() => h.cli.count('stack stop') > stops);
		// The stop's closing status read is in flight when it is turned off.
		const reads = h.cli.count('stack status');
		const releaseStatus = h.cli.hold('stack status');
		releaseStop();
		await h.until(() => h.cli.count('stack status') > reads);
		await turnOff(h);
		releaseStatus();
		await h.engine.waitForJob(stop.jobId ?? '', 10_000);
		expect(h.cli.stacks.get(stackId)?.running).toBe(false);
		const lists = h.cli.count('stack list');
		const releaseList = h.cli.hold('stack list');
		await h.engine.runOperation(
			op({ kind: 'set-enabled', enabled: true }),
			CONFIRMED
		);
		await h.until(() => h.cli.count('stack list') > lists);
		// That read kept nothing, and the status from before the stop is gone.
		expect(stateOf(h, stackId)?.state).toBe('unknown');
		expect(h.engine.isLive(stackId)).toBe(false);
		releaseList();
		await h.engine.settle();
		expect(stateOf(h, stackId)?.state).toBe('stopped');
	});

	it('shows a stack the turn-off stopped as stopped at every list once on again', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		// Sixteen stopped stacks listed before it: a list reads 16 statuses.
		for (let index = 0; index < 16; index += 1) {
			h.cli.addStack({
				id: index.toString(16).padStart(2, '0').repeat(32),
				projectRoot: `/Users/example/other-${index}/supabase`,
			});
		}
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const stackId = await startStack(h, repo);
		const off = await h.engine.runOperation(
			op({ kind: 'set-enabled', enabled: false, disposition: 'stop-managed' }),
			CONFIRMED
		);
		await h.engine.waitForJob(off.jobId ?? '', 10_000);
		await h.settle();
		h.clock.now += 60_000;
		await h.engine.runOperation(
			op({ kind: 'set-enabled', enabled: true }),
			CONFIRMED
		);
		await h.engine.settle();
		expect(stateOf(h, stackId)?.state).toBe('stopped');
		// The next list finds it unchanged.
		await h.advance(5 * 60_000 + 15_000);
		expect(stateOf(h, stackId)?.state).toBe('stopped');
		expect(h.engine.isLive(stackId)).toBe(false);
	});

	it('keeps nothing from before a start that ran on after the turn-off', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const { stackId } = await stoppedStack(h, repo);
		const starts = h.cli.count('stack start');
		const releaseStart = h.cli.hold('stack start');
		const start = await h.engine.runOperation(
			op({ kind: 'start', stackId }),
			OPERATOR
		);
		await h.until(() => h.cli.count('stack start') > starts);
		await turnOff(h);
		releaseStart();
		await h.engine.waitForJob(start.jobId ?? '', 10_000);
		await h.settle();
		expect(h.cli.stacks.get(stackId)?.running).toBe(true);
		h.clock.now += 60_000;
		const lists = h.cli.count('stack list');
		const releaseList = h.cli.hold('stack list');
		await h.engine.runOperation(
			op({ kind: 'set-enabled', enabled: true }),
			CONFIRMED
		);
		await h.until(() => h.cli.count('stack list') > lists);
		// Not the stopped status from before its start: no "0 of 7 awake".
		expect(stateOf(h, stackId)).toMatchObject({
			readiness: null,
			health: { members: 0 },
		});
		releaseList();
		await h.engine.settle();
		expect(stateOf(h, stackId)?.state).toBe('running');
	});
});

// Quitting ends a cheap tick in flight too, at its next step. Unlike a
// turn-off it keeps the feature on and the caches full, so the later steps
// would probe, stop, restart or follow stacks as the desktop quits.
describe('SupabaseEngine quitting', () => {
	it('reads no capacity for a tick in flight at its repository read when the desktop quits', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		// The tick at 5 min reads capacity but lists nothing: a Refresh just did.
		await h.advance(5 * 60_000 - 15_000);
		await h.engine.runOperation(op({ kind: 'refresh' }), OPERATOR);
		// HEAD moved, so that tick reads the repositories first.
		await h.checkout(repo, 'feat-x');
		const resolve = holdFirst(h.resolver.resolve.bind(h.resolver));
		h.resolver.resolve = resolve.call;
		await h.advance(15_000);
		await h.until(resolve.held);
		await h.engine.stop();
		const calls = h.processCalls();
		resolve.release();
		await h.settle();
		expect(h.processCalls()).toBe(calls);
	});

	it('stops no Docker stack for a tick in flight when the desktop quits', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const docker = await h.repository('docker');
		await h.engine.start();
		await h.engine.settle();
		await h.advance(5 * 60_000 - 15_000);
		// A Docker stack appears on a managed identity: the tick at 5 min lists
		// it and reads capacity before its container stops.
		const dockerId = await h.identity(docker);
		h.cli.addStack({
			id: dockerId,
			projectRoot: docker,
			runtime: 'docker',
			running: true,
		});
		const sysv = holdFirst(h.discovery.readSysvCapacity);
		h.discovery.readSysvCapacity = sysv.call;
		await h.advance(15_000);
		await h.until(sysv.held);
		await h.engine.stop();
		sysv.release();
		await h.settle();
		expect(h.cli.count('stack stop')).toBe(0);
		expect(h.cli.stacks.get(dockerId)?.running).toBe(true);
	});

	it('validates no owner binary for a tick in flight at its container stops when the desktop quits', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		const docker = await h.repository('docker');
		await h.engine.start();
		await h.engine.settle();
		const stackId = await startStack(h, repo);
		await h.advance(30_000);
		// The owner now runs another valid binary, which the next tick's drift
		// check validates.
		const binary =
			'/opt/example/next/node_modules/@supabase/cli-darwin-arm64/bin/supabase';
		h.resolver.binaries.set(binary, '2.121.0');
		const stack = h.cli.stacks.get(stackId);
		if (!stack) throw new Error('The stack did not start.');
		stack.executable = binary;
		// A Docker stack appears on a managed identity: that tick stops it
		// first, and records the stop while the desktop quits.
		const dockerId = await h.identity(docker);
		h.cli.addStack({
			id: dockerId,
			projectRoot: docker,
			runtime: 'docker',
			running: true,
		});
		const mark = holdFirst(
			h.engine.stackStore.upsertRecord.bind(h.engine.stackStore),
			(record) => record.id === dockerId
		);
		vi.spyOn(h.engine.stackStore, 'upsertRecord').mockImplementation(mark.call);
		const validations: string[] = [];
		const validate = h.resolver.validateBinary.bind(h.resolver);
		h.resolver.validateBinary = (input) => {
			validations.push(input.binaryPath);
			return validate(input);
		};
		await h.advance(15_000);
		await h.until(mark.held);
		await h.engine.stop();
		mark.release();
		await h.settle();
		expect(validations).not.toContain(binary);
	});

	it('starts no branch follow for a tick in flight at its drift check when the desktop quits', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		h.agents.sessions = [fakeSession('session-a', '/Users/example/elsewhere')];
		await h.engine.start();
		await h.engine.settle();
		await agentUp(h, repo);
		const oldId = await h.identity(repo);
		// The held worktree moved to another branch: the tick at 45 s follows it.
		await h.checkout(repo, 'feat-x');
		await h.advance(30_000);
		// The owner now runs another valid binary, which that tick validates
		// first.
		const binary =
			'/opt/example/next/node_modules/@supabase/cli-darwin-arm64/bin/supabase';
		h.resolver.binaries.set(binary, '2.121.0');
		const stack = h.cli.stacks.get(oldId);
		if (!stack) throw new Error('The stack did not start.');
		stack.executable = binary;
		const validate = holdFirst(
			h.resolver.validateBinary.bind(h.resolver),
			(input) => input.binaryPath === binary
		);
		h.resolver.validateBinary = validate.call;
		await h.advance(15_000);
		await h.until(validate.held);
		const calls = h.cli.calls.length;
		await h.engine.stop();
		validate.release();
		await h.settle();
		// No list, no start of the new branch's stack, no stop of the old one.
		expect(h.cli.calls.length).toBe(calls);
		expect(h.cli.stacks.get(oldId)?.running).toBe(true);
	});
});

describe('SupabaseEngine cadence', () => {
	it('reads the cheap tier every 15 s and lists on owner changes and every 5 min', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		expect(h.cli.count('stack list')).toBe(1);
		const owners = () =>
			h.discovery.probes.filter((probe) => probe === 'owners').length;
		const before = owners();
		await h.advance(15_000);
		expect(owners()).toBe(before + 1);
		// Nothing changed: no new list within 5 min.
		await h.advance(60_000);
		expect(h.cli.count('stack list')).toBe(1);
		// Another tool starts the worktree's stack: the owner set changes.
		h.cli.addStack({
			id: await h.identity(repo),
			projectRoot: repo,
			running: true,
		});
		await h.advance(15_000);
		expect(h.cli.count('stack list')).toBe(2);
		await h.advance(5 * 60_000 + 15_000);
		expect(h.cli.count('stack list')).toBeGreaterThanOrEqual(3);
	});

	it('measures footprint and disk only while a window shows the tab', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		await startStack(h, repo);
		const rss = () =>
			h.discovery.probes.filter((probe) => probe === 'rss').length;
		const du = () =>
			h.discovery.probes.filter((probe) => probe === 'du').length;
		await h.advance(60_000);
		expect(rss()).toBe(0);
		expect(du()).toBe(0);
		h.engine.setInterest('renderer-1', { view: 'stacks', sections: [] });
		await h.advance(1);
		expect(rss()).toBe(1);
		expect(du()).toBe(1);
		await h.advance(30_000);
		expect(rss()).toBe(2);
		expect(du()).toBe(1);
		h.engine.setInterest('renderer-1', { view: 'hidden', sections: [] });
		await h.advance(20 * 60_000);
		expect(rss()).toBe(2);
		expect(du()).toBe(1);
	});

	it('reads the inspected stack every 10 s while visible', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const stackId = await startStack(h, repo);
		const statuses = () => h.cli.count('stack status');
		const before = statuses();
		h.engine.setInterest('renderer-1', {
			view: 'stacks',
			inspectStackId: stackId,
			sections: ['overview'],
		});
		await h.engine.settle();
		expect(statuses()).toBe(before + 1);
		await h.advance(10_000);
		expect(statuses()).toBeGreaterThanOrEqual(before + 2);
		h.engine.setInterest('renderer-1', { view: 'hidden', sections: [] });
		await h.settle();
		const hidden = statuses();
		await h.advance(14_000);
		expect(statuses()).toBe(hidden);
	});

	it('never extends an automatic stop while the tab is watched', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		h.agents.sessions = [fakeSession('session-a', '/Users/example/elsewhere')];
		await h.engine.start();
		await h.engine.settle();
		await agentUp(h, repo);
		const stackId = await h.identity(repo);
		expect(stateOf(h, stackId)?.state).toBe('running');
		await h.engine.runAgentOperation(
			{ operation: 'down', target: { worktreePath: repo } },
			{ requestId: 'request-2', holder: CLAUDE, synthetic: false },
			SIGNAL
		);
		await h.settle();
		h.engine.setInterest('renderer-1', {
			view: 'stacks',
			inspectStackId: stackId,
			sections: ['overview'],
		});
		await h.advance(59_000);
		expect(h.cli.count('stack stop')).toBe(0);
		await h.advance(2_000);
		expect(h.cli.count('stack stop')).toBe(1);
		expect(stateOf(h, stackId)?.state).toBe('stopped');
	});

	it('reads a status its last list left unread instead of confirming it', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		await h.repository('repo');
		const ids = Array.from({ length: 17 }, (_, index) =>
			index.toString(16).padStart(2, '0').repeat(32)
		);
		for (const [index, id] of ids.entries()) {
			h.cli.addStack({
				id,
				projectRoot: `/Users/example/other-${index}/supabase`,
				running: true,
			});
		}
		await h.engine.start();
		await h.engine.settle();
		// A list reads 16 statuses: the 17th is read on its own.
		const last = ids[16] as string;
		await h.engine.readStatus(last);
		expect(stateOf(h, last)?.state).toBe('running');
		// Another tool stops them all, so the next list reads 16 of them again.
		for (const id of ids) {
			const stack = h.cli.stacks.get(id);
			if (stack) stack.running = false;
		}
		h.clock.now += 1_000;
		await h.engine.runOperation(op({ kind: 'refresh' }), OPERATOR);
		expect(stateOf(h, last)?.state).toBe('stopped');
		// The list after that finds the 17th unchanged, and still reads it.
		h.clock.now += 1_000;
		const reads = h.cli.callsOf('stack status').length;
		await h.engine.runOperation(op({ kind: 'refresh' }), OPERATOR);
		const read = h.cli
			.callsOf('stack status')
			.slice(reads)
			.some((call) => call.argv.includes(last));
		expect(read).toBe(true);
		expect(stateOf(h, last)?.state).toBe('stopped');
	});
});

describe('SupabaseEngine state', () => {
	it('bumps the revision only when the visible state changes', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const pushed: number[] = [];
		h.engine.subscribe((state) => pushed.push(state.revision));
		const first = h.engine.getState().revision;
		await h.advance(15_000);
		expect(h.engine.getState().revision).toBe(first);
		await startStack(h, repo);
		const after = h.engine.getState().revision;
		expect(after).toBeGreaterThan(first);
		expect(new Set(pushed).size).toBe(pushed.length);
		expect(pushed.every((revision) => revision > first)).toBe(true);
	});

	it('keeps key material out of the state, receipts, stores and steering', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo', { lockfile: true });
		await h.engine.start();
		await h.engine.settle();
		const stackId = await startStack(h, repo);
		const receipt = await h.engine.runOperation(
			op({ kind: 'copy', stackId, what: 'publishable-key' }),
			OPERATOR
		);
		expect(receipt.completed).toBe(true);
		expect(h.clipboard.text).toBe(h.cli.secrets.publishableKey);
		const serialized = [
			JSON.stringify(h.engine.getState()),
			JSON.stringify(receipt),
			JSON.stringify(h.engine.doctor()),
			await readFile(h.engine.steeringWriter.file, 'utf8'),
			await readFile(h.engine.stackStore.file, 'utf8'),
			await readFile(h.engine.jobStore.file, 'utf8'),
			await readFile(h.engine.policyStore.file, 'utf8'),
			h.logs.join('\n'),
		];
		for (const text of serialized) {
			expect(text).not.toMatch(SECRET_SHAPED);
			expect(text).not.toContain(h.cli.secrets.dbPassword);
			expect(text).not.toContain(h.cli.secrets.publishableKey);
		}
	});

	it('describes tracked worktrees for the lane start form', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const managed = await h.repository('repo');
		const pinned = await h.repository('pinned', {
			config: '[experimental]\nstack = true\n\n[api]\nport = 54321\n',
		});
		const observed = await h.repository('observed', {
			config: 'project_id = "example-app"\n',
		});
		await h.engine.start();
		await h.engine.settle();
		expect(h.engine.describeWorktree(managed)).toEqual({ project: 'managed' });
		expect(h.engine.describeWorktree(pinned)).toEqual({
			project: 'managed',
			portsPinned: true,
		});
		expect(h.engine.describeWorktree(observed)).toEqual({
			project: 'observed',
			reasonText: expect.stringMatching(/stack flag/),
		});
		expect(
			h.engine.describeWorktree('/Users/example/code/untracked')
		).toBeUndefined();
		await h.engine.policyStore.setEnabled(false);
		expect(h.engine.describeWorktree(managed)).toBeUndefined();
	});

	it('publishes states that parse and never say demo', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		const states: unknown[] = [];
		h.engine.subscribe((state) => states.push(state));
		await h.engine.start();
		await h.engine.settle();
		await startStack(h, repo);
		expect(states.length).toBeGreaterThan(0);
		for (const state of states) {
			expect(supabaseStateSchema.parse(state).source).toBe('live');
		}
	});
});

describe('SupabaseEngine exposure', () => {
	it('stops a stack that listens beyond loopback and fails its start', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const stackId = await startStack(h, repo);
		const stop = await h.engine.runOperation(
			op({ kind: 'stop', stackIds: [stackId] }),
			OPERATOR
		);
		await h.engine.waitForJob(stop.jobId ?? '', 10_000);
		await h.settle();
		const stack = h.cli.stacks.get(stackId);
		if (stack) stack.lanExposed = true;
		const receipt = await h.engine.runOperation(
			op({ kind: 'start', stackId }),
			OPERATOR
		);
		await h.engine.waitForJob(receipt.jobId ?? '', 10_000);
		await h.settle();
		const job = receipt.jobId ? h.engine.job(receipt.jobId) : undefined;
		expect(job?.status).toBe('failed');
		expect(job?.error?.title).toBe('Stack listened on your network');
		expect(h.cli.count('stack stop')).toBe(2);
		expect(h.cli.stacks.get(stackId)?.running).toBe(false);
		expect(stateOf(h, stackId)?.exposure.verdict).toBe('lan-exposed');
	});

	it('stops a started stack whose exposure cannot be verified', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		h.discovery.exposureUnavailable = true;
		const stackId = await h.identity(repo);
		const receipt = await h.engine.runOperation(
			op({ kind: 'start', stackId }),
			OPERATOR
		);
		await h.engine.waitForJob(receipt.jobId ?? '', 10_000);
		await h.settle();
		const job = receipt.jobId ? h.engine.job(receipt.jobId) : undefined;
		expect(job?.status).toBe('failed');
		expect(job?.error?.title).toBe('Exposure could not be verified');
		expect(h.cli.stacks.get(stackId)?.running).toBe(false);
		expect(stateOf(h, stackId)?.exposure.verdict).toBe('unknown');
	});

	it('fails closed when the owner of a started stack cannot be found', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		h.discovery.ownersUnavailable = true;
		const stackId = await h.identity(repo);
		const receipt = await h.engine.runOperation(
			op({ kind: 'start', stackId }),
			OPERATOR
		);
		await h.engine.waitForJob(receipt.jobId ?? '', 10_000);
		await h.settle();
		const job = receipt.jobId ? h.engine.job(receipt.jobId) : undefined;
		expect(job?.status).toBe('failed');
		expect(h.cli.stacks.get(stackId)?.running).toBe(false);
	});

	it('re-checks running managed stacks with lsof every 5 min', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const stackId = await startStack(h, repo);
		const lsof = () =>
			h.discovery.probes.filter((probe) => probe === 'lsof').length;
		const before = lsof();
		const stack = h.cli.stacks.get(stackId);
		if (stack) stack.lanExposed = true;
		await h.advance(5 * 60_000 + 15_000);
		expect(lsof()).toBeGreaterThan(before);
		expect(h.cli.stacks.get(stackId)?.running).toBe(false);
		expect(stateOf(h, stackId)?.exposure.verdict).toBe('lan-exposed');
	});
});

describe('SupabaseEngine container stacks', () => {
	it('stops a Docker stack on a managed identity once, and never attaches it', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		const stackId = await h.identity(repo);
		h.cli.addStack({
			id: stackId,
			projectRoot: repo,
			runtime: 'docker',
			running: true,
		});
		await h.engine.start();
		await h.engine.settle();
		expect(h.cli.count('stack stop')).toBe(1);
		expect(h.engine.stackStore.record(stackId)?.flags.containerStoppedAt).toBe(
			h.clock.now
		);
		// Someone starts it again: it is left alone.
		const stack = h.cli.stacks.get(stackId);
		if (stack) stack.running = true;
		await h.advance(6 * 60_000);
		expect(h.cli.count('stack stop')).toBe(1);
		const lane = await h.engine.ensureForLane({
			laneId: 'lane-11111111-2222-4333-8444-555555555555',
			worktreePath: repo,
			branch: 'main',
			environmentId: 'development',
			policy: 'auto',
		});
		expect(lane.summary.status).toBe('refused');
		expect(lane.laneEnv).toBeUndefined();
	});

	it('stops a Docker stack once the feature is on again when a turn-off called its stop off', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		const stackId = await h.identity(repo);
		h.cli.addStack({
			id: stackId,
			projectRoot: repo,
			runtime: 'docker',
			running: true,
		});
		// Work that holds the stack's lock keeps the stop waiting its turn.
		let release: () => void = () => undefined;
		const holder = h.engine.lockStack(
			stackId,
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				})
		);
		await h.engine.start();
		await h.settle();
		expect(h.engine.stackStore.record(stackId)?.flags.containerStoppedAt).toBe(
			h.clock.now
		);
		await h.engine.runOperation(
			op({ kind: 'set-enabled', enabled: false }),
			CONFIRMED
		);
		release();
		await holder;
		await h.settle();
		expect(h.cli.count('stack stop')).toBe(0);
		expect(
			h.engine.stackStore.record(stackId)?.flags.containerStoppedAt
		).toBeUndefined();
		await h.engine.runOperation(
			op({ kind: 'set-enabled', enabled: true }),
			CONFIRMED
		);
		await h.engine.settle();
		expect(h.cli.count('stack stop')).toBe(1);
		expect(h.cli.stacks.get(stackId)?.running).toBe(false);
	});
});

describe('SupabaseEngine admission', () => {
	it('stops the least recently used unheld stack to make room', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const first = await h.repository('first');
		const second = await h.repository('second');
		await h.engine.start();
		await h.engine.settle();
		await h.engine.policyStore.updatePolicy({ maxRunning: 1 });
		h.agents.sessions = [fakeSession('session-a', '/Users/example/elsewhere')];
		await agentUp(h, first);
		const firstId = await h.identity(first);
		await h.engine.runAgentOperation(
			{ operation: 'down', target: { worktreePath: first } },
			{ requestId: 'request-2', holder: CLAUDE, synthetic: false },
			SIGNAL
		);
		await h.settle();
		const secondId = await startStack(h, second);
		expect(h.cli.stacks.get(firstId)?.running).toBe(false);
		expect(h.cli.stacks.get(secondId)?.running).toBe(true);
		const room = h.engine
			.getState()
			.jobs.find((job) => job.kind === 'create' && job.stackIds[0] === secondId)
			?.steps?.find((step) => step.id === 'room');
		expect(room?.state).toBe('done');
	});

	it('refuses a start when nothing can make room, and files a request for an agent', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const first = await h.repository('first');
		const second = await h.repository('second');
		await h.engine.start();
		await h.engine.settle();
		await h.engine.policyStore.updatePolicy({ maxRunning: 1 });
		await startStack(h, first);
		await expect(agentUp(h, second)).rejects.toMatchObject({
			code: 'supabase_capacity',
		});
		const requests = h.engine.getState().requests;
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({ kind: 'start-capacity' });
	});

	it('refuses every start under critical memory pressure', async () => {
		const h = await createEngineHarness({
			enabled: true,
			start: false,
			memoryPressure: 'critical',
		});
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const stackId = await h.identity(repo);
		const receipt = await h.engine.runOperation(
			op({ kind: 'start', stackId }),
			OPERATOR
		);
		expect(receipt.completed).toBe(false);
		expect(receipt.error?.message).toMatch(/Memory pressure is critical/);
		await expect(agentUp(h, repo)).rejects.toMatchObject({
			code: 'supabase_capacity',
		});
		expect(h.cli.count('stack start')).toBe(0);
	});

	it('starts nothing once a turn-off calls off the stop that would make room', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const first = await h.repository('first');
		const second = await h.repository('second');
		await h.engine.start();
		await h.engine.settle();
		await h.engine.policyStore.updatePolicy({ maxRunning: 1 });
		h.agents.sessions = [fakeSession('session-a', '/Users/example/elsewhere')];
		await agentUp(h, first);
		const firstId = await h.identity(first);
		await h.engine.runAgentOperation(
			{ operation: 'down', target: { worktreePath: first } },
			{ requestId: 'request-2', holder: CLAUDE, synthetic: false },
			SIGNAL
		);
		await h.settle();
		// Work on the first stack keeps the stop that makes room waiting.
		const release = holdLock(h, firstId);
		const up = agentUp(h, second).then(
			() => undefined,
			(error: unknown) => error
		);
		await h.until(() =>
			h.engine.jobStore
				.activeJobs()
				.some((job) => job.kind === 'stop' && job.stackIds.includes(firstId))
		);
		await turnOff(h);
		const calls = h.processCalls();
		await release();
		await expect(up).resolves.toMatchObject({ code: 'supabase_disabled' });
		await h.settle();
		// No stop, no capacity read and no start: one stack still runs.
		expect(h.processCalls()).toBe(calls);
		expect(h.cli.running().map((stack) => stack.id)).toEqual([firstId]);
	});

	it('reads no capacity once turned off while the stop that makes room runs', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const first = await h.repository('first');
		const second = await h.repository('second');
		await h.engine.start();
		await h.engine.settle();
		await h.engine.policyStore.updatePolicy({ maxRunning: 1 });
		h.agents.sessions = [fakeSession('session-a', '/Users/example/elsewhere')];
		await agentUp(h, first);
		await h.engine.runAgentOperation(
			{ operation: 'down', target: { worktreePath: first } },
			{ requestId: 'request-2', holder: CLAUDE, synthetic: false },
			SIGNAL
		);
		await h.settle();
		const stops = h.cli.count('stack stop');
		const release = h.cli.hold('stack stop');
		const up = agentUp(h, second).then(
			() => undefined,
			(error: unknown) => error
		);
		await h.until(() => h.cli.count('stack stop') > stops);
		await turnOff(h);
		const calls = h.cli.count();
		const probes = h.discovery.probes.length;
		release();
		await expect(up).resolves.toMatchObject({ code: 'supabase_disabled' });
		await h.engine.settle();
		// The stop ran on and read its owner; no capacity is read while off.
		expect(h.discovery.probes.slice(probes)).toEqual(['owners']);
		expect(h.cli.count()).toBe(calls);
		expect(h.cli.running()).toEqual([]);
	});

	it('shows no stack whose stop to make room read its status across the turn-off as running once on again', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const first = await h.repository('first');
		const second = await h.repository('second');
		await h.engine.start();
		await h.engine.settle();
		await h.engine.policyStore.updatePolicy({ maxRunning: 1 });
		h.agents.sessions = [fakeSession('session-a', '/Users/example/elsewhere')];
		await agentUp(h, first);
		const firstId = await h.identity(first);
		await h.engine.runAgentOperation(
			{ operation: 'down', target: { worktreePath: first } },
			{ requestId: 'request-2', holder: CLAUDE, synthetic: false },
			SIGNAL
		);
		await h.settle();
		const stops = h.cli.count('stack stop');
		const releaseStop = h.cli.hold('stack stop');
		const up = agentUp(h, second).then(
			() => undefined,
			(error: unknown) => error
		);
		await h.until(() => h.cli.count('stack stop') > stops);
		// The stop's closing status read is in flight when it is turned off.
		const reads = h.cli.count('stack status');
		const releaseStatus = h.cli.hold('stack status');
		releaseStop();
		await h.until(() => h.cli.count('stack status') > reads);
		await turnOff(h);
		releaseStatus();
		await expect(up).resolves.toMatchObject({ code: 'supabase_disabled' });
		expect(h.cli.stacks.get(firstId)?.running).toBe(false);
		const lists = h.cli.count('stack list');
		const releaseList = h.cli.hold('stack list');
		await h.engine.runOperation(
			op({ kind: 'set-enabled', enabled: true }),
			CONFIRMED
		);
		await h.until(() => h.cli.count('stack list') > lists);
		expect(stateOf(h, firstId)?.state).toBe('unknown');
		expect(h.engine.isLive(firstId)).toBe(false);
		releaseList();
		await h.engine.settle();
		expect(stateOf(h, firstId)?.state).toBe('stopped');
	});

	it('admits nothing once turned off while it reads the capacity', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const sysv = holdFirst(h.discovery.readSysvCapacity);
		h.discovery.readSysvCapacity = sysv.call;
		const receipt = await h.engine.runOperation(
			op({ kind: 'start', stackId: await h.identity(repo) }),
			OPERATOR
		);
		await h.until(sysv.held);
		await turnOff(h);
		const calls = h.processCalls();
		sysv.release();
		await h.engine.waitForJob(receipt.jobId ?? '', 10_000);
		await h.settle();
		// The state lists no stack while off: no room is judged from it.
		expect(h.engine.job(receipt.jobId ?? '')).toMatchObject({
			status: 'cancelled',
			error: { code: 'feature_off' },
		});
		expect(h.processCalls()).toBe(calls);
		expect(h.cli.count('stack start')).toBe(0);
	});
});

describe('SupabaseEngine lifecycle', () => {
	it('creates a missing stack natively with the policy exclusions', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo', { migrations: 2 });
		await h.engine.start();
		await h.engine.settle();
		const stackId = await startStack(h, repo);
		const [start] = h.cli.callsOf('stack start');
		expect(start?.argv).toEqual([
			'stack',
			'start',
			'--workdir',
			repo,
			'--runtime',
			'native',
			'--exclude',
			'studio,analytics',
			'--output-format',
			'json',
		]);
		expect(start?.detached).toBe(true);
		const record = h.engine.stackStore.record(stackId);
		expect(record).toMatchObject({
			origin: 'managed',
			binaryPath: start?.binaryPath,
			cliVersion: '2.121.0',
			exclusions: ['studio', 'analytics'],
			pinned: true,
		});
		expect(stateOf(h, stackId)?.state).toBe('running');
		expect(h.engine.getState().activity[0]).toMatchObject({
			kind: 'create',
			outcome: 'complete',
		});
	});

	it('resumes a stopped stack by id with its exclusions passed again', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const stackId = await startStack(h, repo);
		await runToEnd(h, { kind: 'stop', stackIds: [stackId] });
		await h.settle();
		expect(stateOf(h, stackId)?.state).toBe('stopped');
		await runToEnd(h, { kind: 'start', stackId });
		await h.settle();
		const starts = h.cli.callsOf('stack start');
		expect(starts[1]?.argv).toEqual([
			'stack',
			'start',
			'--stack-id',
			stackId,
			'--runtime',
			'native',
			'--exclude',
			'studio,analytics',
			'--output-format',
			'json',
		]);
		expect(stateOf(h, stackId)?.state).toBe('running');
	});

	it('creates again after a failed first start registered an empty stack', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const stackId = await h.identity(repo);
		h.cli.replyNext('stack start', {
			exitCode: 1,
			stdout: `${JSON.stringify({ _tag: 'Error', error: { code: 'ExperimentalStackStartError', message: 'database: initdb failed' } })}\n`,
			stderr: ['[task] failed: database: initdb failed'],
		});
		const failed = await h.engine.runOperation(
			op({ kind: 'start', stackId }),
			OPERATOR
		);
		await h.engine.waitForJob(failed.jobId ?? '', 10_000);
		await h.settle();
		expect(h.engine.job(failed.jobId ?? '')?.status).toBe('failed');
		expect(h.engine.stackStore.record(stackId)?.flags.failedStart).toBe(true);
		// The CLI still registered the stack, with no members.
		h.cli.addStack({ id: stackId, projectRoot: repo, members: 0 });
		await h.engine.runOperation(op({ kind: 'refresh' }), OPERATOR);
		expect(stateOf(h, stackId)?.state).toBe('failed');
		await runToEnd(h, { kind: 'start', stackId });
		await h.settle();
		const starts = h.cli.callsOf('stack start');
		expect(starts).toHaveLength(2);
		expect(starts[1]?.argv).toContain('--workdir');
		expect(
			h.engine.stackStore.record(stackId)?.flags.failedStart
		).toBeUndefined();
		expect(stateOf(h, stackId)?.state).toBe('running');
	});

	it('keeps a stack whose setting needed a recreate once the setting is reverted', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const stackId = await startStack(h, repo);
		await runToEnd(h, { kind: 'stop', stackIds: [stackId] });
		await h.settle();
		// [db] major_version moved: the saved stack can't adopt it.
		const stack = h.cli.stacks.get(stackId);
		if (stack) stack.configChanged = true;
		h.cli.replyNext('stack start', 'start-needs-recreate');
		await runToEnd(h, { kind: 'start', stackId });
		await h.settle();
		await h.engine.readStatus(stackId);
		expect(stateOf(h, stackId)?.state).toBe('needs-recreate');
		// Reverted: the next status read finds the configuration matching.
		if (stack) stack.configChanged = false;
		await h.engine.readStatus(stackId);
		expect(stateOf(h, stackId)?.state).toBe('stopped');
		expect(h.engine.stackStore.record(stackId)?.lastError).toBeUndefined();
		const receipt = await h.engine.runOperation(
			op({ kind: 'start', stackId }),
			OPERATOR
		);
		await h.engine.waitForJob(receipt.jobId ?? '', 10_000);
		await h.settle();
		expect(h.engine.job(receipt.jobId ?? '')?.status).toBe('complete');
		expect(h.cli.callsOf('stack start').at(-1)?.argv).toEqual(
			expect.arrayContaining(['--stack-id', stackId])
		);
		expect(h.cli.count('stack destroy')).toBe(0);
		expect(stateOf(h, stackId)?.state).toBe('running');
	});

	it('lets an explicit up try a stack that needed a recreate again', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		h.agents.sessions = [fakeSession('session-a', '/Users/example/elsewhere')];
		await h.engine.start();
		await h.engine.settle();
		await agentUp(h, repo);
		const stackId = await h.identity(repo);
		await runToEnd(h, { kind: 'stop', stackIds: [stackId] });
		await h.settle();
		// Another setting still differs, so status reads keep the flag.
		const stack = h.cli.stacks.get(stackId);
		if (stack) stack.configChanged = true;
		h.cli.replyNext('stack start', 'start-needs-recreate');
		await expect(agentUp(h, repo)).rejects.toMatchObject({
			code: 'needs_recreate',
		});
		expect(stateOf(h, stackId)?.state).toBe('needs-recreate');
		// The setting that needed the recreate is reverted: the next up starts it.
		await expect(agentUp(h, repo)).resolves.toMatchObject({ operation: 'up' });
		expect(h.cli.callsOf('stack start').at(-1)?.argv).toEqual(
			expect.arrayContaining(['--stack-id', stackId])
		);
		expect(
			h.engine.stackStore.record(stackId)?.flags.needsRecreate
		).toBeUndefined();
		expect(h.cli.stacks.get(stackId)?.running).toBe(true);
	});

	it('never retries a start that needs a recreate automatically', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		h.agents.sessions = [fakeSession('session-a', '/Users/example/elsewhere')];
		await h.engine.start();
		await h.engine.settle();
		await agentUp(h, repo);
		const mainId = await h.identity(repo);
		await h.checkout(repo, 'feat-x');
		const featureId = await h.identity(repo);
		await h.engine.runOperation(op({ kind: 'refresh' }), OPERATOR);
		h.cli.replyNext('stack start', 'start-needs-recreate');
		await runToEnd(h, { kind: 'start', stackId: featureId });
		await h.settle();
		expect(h.engine.stackStore.record(featureId)?.flags.needsRecreate).toBe(
			true
		);
		const starts = h.cli.count('stack start');
		await h.advance(5 * 60_000);
		// The held stack stays where it is; no follow starts the flagged one.
		expect(h.cli.count('stack start')).toBe(starts);
		expect(h.cli.stacks.get(mainId)?.running).toBe(true);
		expect(
			h.engine.stackStore
				.record(mainId)
				?.holds.some((hold) => hold.agent.sessionId === 'session-a')
		).toBe(true);
	});

	it('tells an automatic start to revert only when every change is editable', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const stackId = await startStack(h, repo);
		await runToEnd(h, { kind: 'stop', stackIds: [stackId] });
		await h.settle();
		const facts = await h.engine.worktreeFacts(repo);
		const stack = h.cli.stacks.get(stackId);
		if (!facts || !stack) throw new Error('The stack did not start.');
		/** What a follow is told once a start failed over these changes. */
		const refusalAfter = async (stackChanges: readonly object[]) => {
			// The recorded refusal, listing these changes instead.
			const reply = h.cli.fixtureFor('start-needs-recreate', stackId);
			const stdout = JSON.parse(reply.stdout) as Record<string, unknown>;
			h.cli.replyNext('stack start', {
				...reply,
				stdout: `${JSON.stringify({ ...stdout, stack_changes: stackChanges })}\n`,
			});
			stack.configChanged = true;
			await runToEnd(h, { kind: 'start', stackId });
			await h.settle();
			expect(stateOf(h, stackId)?.state).toBe('needs-recreate');
			const starts = h.cli.count('stack start');
			const result = await h.engine.ensureStack(facts, {
				requestedBy: { kind: 'automatic', reason: 'follow' },
				createdBy: { via: 'desktop' },
			});
			expect(h.cli.count('stack start')).toBe(starts);
			// Reverted: the next status read clears the flag for the next case.
			stack.configChanged = false;
			await h.engine.readStatus(stackId);
			return result.kind === 'refused'
				? { message: result.message, recovery: result.error?.recovery }
				: { message: result.kind };
		};
		const majorVersion = {
			service: 'database',
			path: 'config.version',
			key: '[db] major_version',
			saved: '15',
			requested: '17',
			editable: true,
		};
		// What a CLI upgrade reports: no setting controls the pinned build.
		const postgresBuild = {
			service: 'database',
			key: 'Postgres build',
			saved: '17.4.1',
			requested: '17.6.1',
			editable: false,
		};
		await expect(refusalAfter([majorVersion])).resolves.toEqual({
			message:
				'The saved stack cannot adopt the current configuration. Revert the change to keep it, or recreate it.',
			recovery: expect.stringContaining('Revert the listed settings'),
		});
		const recreateOnly = {
			message:
				'The saved stack cannot adopt the current configuration; it must be recreated.',
			recovery:
				'This configuration needs a new stack. Destroy and recreate it from RN Devtools; that deletes its local database.',
		};
		await expect(refusalAfter([postgresBuild])).resolves.toEqual(recreateOnly);
		// A change no setting controls blocks the start whatever else changed.
		await expect(refusalAfter([majorVersion, postgresBuild])).resolves.toEqual(
			recreateOnly
		);
		await expect(refusalAfter([postgresBuild, majorVersion])).resolves.toEqual(
			recreateOnly
		);
		// With none listed there is nothing to revert.
		await expect(refusalAfter([])).resolves.toEqual(recreateOnly);
		expect(h.cli.count('stack destroy')).toBe(0);
	});

	it('gives a lane that asks during an automatic follow its own start and job', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		const lane = fakeLane({ worktreePath: repo });
		h.lanes.lanes = [lane];
		await h.engine.start();
		await h.engine.settle();
		const stackId = await startStack(h, repo);
		await runToEnd(h, { kind: 'stop', stackIds: [stackId] });
		await h.settle();
		const facts = await h.engine.worktreeFacts(repo);
		const stack = h.cli.stacks.get(stackId);
		if (!facts || !stack) throw new Error('The stack did not start.');
		// A follow never tries this stack again; an explicit ask does.
		stack.configChanged = true;
		h.cli.replyNext('stack start', 'start-needs-recreate');
		await runToEnd(h, { kind: 'start', stackId });
		await h.settle();
		expect(stateOf(h, stackId)?.state).toBe('needs-recreate');
		const starts = h.cli.count('stack start');
		const reads = h.cli.count('stack status');
		const ensures = vi.spyOn(h.engine, 'ensureStack');
		const releaseStatus = h.cli.hold('stack status');
		const releaseStart = h.cli.hold('stack start');
		const follow = h.engine.ensureStack(facts, {
			requestedBy: { kind: 'automatic', reason: 'follow' },
			createdBy: { via: 'desktop' },
		});
		// The lane asks while the follow still reads the stack's status.
		await h.until(() => h.cli.count('stack status') > reads);
		let answered = false;
		const up = h.engine
			.ensureForLane({
				laneId: lane.id,
				worktreePath: repo,
				branch: 'main',
				environmentId: 'development',
				policy: 'auto',
				waitMs: 1_000,
			})
			.finally(() => {
				answered = true;
			});
		await h.until(() => ensures.mock.calls.length === 2);
		releaseStatus();
		await expect(follow).resolves.toMatchObject({
			kind: 'refused',
			agentCode: 'needs_recreate',
		});
		// Not the follow's refusal: the lane starts the stack itself.
		await h.until(() => answered || h.cli.count('stack start') > starts);
		await h.advance(1_000);
		const answer = await up;
		expect(answer.summary).toMatchObject({ status: 'starting', stackId });
		expect(h.engine.job(answer.summary.jobId ?? '')).toMatchObject({
			kind: 'resume',
			stackIds: [stackId],
			requestedBy: { kind: 'lane', laneId: lane.id },
		});
		releaseStart();
		expect((await answer.lateAttach)?.summary.status).toBe('ready');
		expect(h.cli.count('stack start')).toBe(starts + 1);
		// A start that takes clears the flag and what it kept.
		const record = h.engine.stackStore.record(stackId);
		expect(record?.flags.needsRecreate).toBeUndefined();
		expect(record?.recreateError).toBeUndefined();
	});

	it("keeps what the saved stack can't adopt when a retry fails for another reason", async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		const lane = fakeLane({ worktreePath: repo });
		h.lanes.lanes = [lane];
		await h.engine.start();
		await h.engine.settle();
		const stackId = await startStack(h, repo);
		await runToEnd(h, { kind: 'stop', stackIds: [stackId] });
		await h.settle();
		const facts = await h.engine.worktreeFacts(repo);
		const stack = h.cli.stacks.get(stackId);
		if (!facts || !stack) throw new Error('The stack did not start.');
		// Only [db] major_version changed, so reverting it keeps the stack.
		stack.configChanged = true;
		h.cli.replyNext('stack start', 'start-needs-recreate');
		await runToEnd(h, { kind: 'start', stackId });
		await h.settle();
		/** What a follow is told, and what the tab's copy says, right now. */
		const advice = async () => {
			const result = await h.engine.ensureStack(facts, {
				requestedBy: { kind: 'automatic', reason: 'follow' },
				createdBy: { via: 'desktop' },
			});
			const state = h.engine.getState();
			const summary = state.stacks.find((entry) => entry.id === stackId);
			if (result.kind !== 'refused' || !summary) {
				throw new Error('The follow was not refused.');
			}
			const resume = supabaseActionAvailability(summary, 'resume', {
				bridgeAvailable: true,
				state,
			});
			return {
				refusal: result.message,
				code: result.error?.code,
				recovery: result.error?.recovery,
				pill: stackStatus(summary, { jobs: state.jobs }).explanation,
				resume: resume.allowed ? undefined : resume.reason,
				attention: attentionItems(state).find(
					(item) => item.id === 'start-failed'
				)?.text,
				changes: summary.recreateChanges,
			};
		};
		const revert = {
			refusal:
				'The saved stack cannot adopt the current configuration. Revert the change to keep it, or recreate it.',
			code: 'needs_recreate',
			recovery: expect.stringContaining('Revert the listed settings'),
			pill: 'The saved stack cannot adopt this configuration. Revert the change to keep it, or recreate it.',
			resume:
				'[db] major_version changed from 15 to 17. Revert it to keep this stack, or recreate it.',
			attention:
				"1 stack can't adopt its configuration: revert the change or recreate it.",
			changes: [
				{
					service: 'database',
					path: 'config.version',
					key: '[db] major_version',
					saved: '15',
					requested: '17',
					editable: true,
				},
			],
		};
		await expect(advice()).resolves.toEqual(revert);
		// A lane tries it again, and this time a port it needs is taken.
		h.cli.replyNext('stack start', {
			exitCode: 1,
			stdout: `${JSON.stringify({ _tag: 'Error', error: { code: 'ExperimentalStackStartError', message: 'Port 54321 for api at 127.0.0.1 is in use by another process' } })}\n`,
			stderr: [],
		});
		const retry = await h.engine.ensureForLane({
			laneId: lane.id,
			worktreePath: repo,
			branch: 'main',
			environmentId: 'development',
			policy: 'auto',
		});
		await h.settle();
		expect(retry.summary).toMatchObject({
			status: 'failed',
			reasonText:
				'Port 54321 for api at 127.0.0.1 is in use by another process',
		});
		expect(stateOf(h, stackId)).toMatchObject({
			state: 'needs-recreate',
			lastError: { code: 'ports_conflict' },
		});
		await expect(advice()).resolves.toEqual(revert);
		// Reverted: the flag and what it kept go together.
		stack.configChanged = false;
		await h.engine.readStatus(stackId);
		expect(stateOf(h, stackId)?.state).toBe('stopped');
		expect(stateOf(h, stackId)?.recreateChanges).toBeUndefined();
		expect(h.engine.stackStore.record(stackId)?.recreateError).toBeUndefined();
		expect(h.cli.count('stack destroy')).toBe(0);
	});

	it("keeps what an older record says it can't adopt when a retry fails for another reason", async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		const lane = fakeLane({ worktreePath: repo });
		h.lanes.lanes = [lane];
		await h.engine.start();
		await h.engine.settle();
		const { stackId, facts } = await needsRecreateStack(h, repo);
		// Saved before recreateError existed: only lastError holds the failure.
		await h.engine.stackStore.updateRecord(stackId, (draft) => {
			const { recreateError: _saved, ...older } = draft;
			return older;
		});
		const revert = {
			kind: 'refused',
			message:
				'The saved stack cannot adopt the current configuration. Revert the change to keep it, or recreate it.',
			error: {
				code: 'needs_recreate',
				recovery: expect.stringContaining('Revert the listed settings'),
			},
		};
		await expect(h.engine.ensureStack(facts, FOLLOW)).resolves.toMatchObject(
			revert
		);
		h.cli.replyNext('stack start', {
			exitCode: 1,
			stdout: `${JSON.stringify({ _tag: 'Error', error: { code: 'ExperimentalStackStartError', message: 'Port 54321 for api at 127.0.0.1 is in use by another process' } })}\n`,
			stderr: [],
		});
		const retry = await h.engine.ensureForLane({
			laneId: lane.id,
			worktreePath: repo,
			branch: 'main',
			environmentId: 'development',
			policy: 'auto',
		});
		await h.settle();
		expect(retry.summary.status).toBe('failed');
		// The older failure moved to its own field as lastError moved on.
		const record = h.engine.stackStore.record(stackId);
		expect(record?.lastError?.code).toBe('ports_conflict');
		expect(record?.recreateError?.code).toBe('needs_recreate');
		await expect(h.engine.ensureStack(facts, FOLLOW)).resolves.toMatchObject(
			revert
		);
		const state = h.engine.getState();
		const summary = state.stacks.find((entry) => entry.id === stackId);
		if (!summary) throw new Error('The stack is not listed.');
		expect(stackStatus(summary, { jobs: state.jobs }).explanation).toBe(
			'The saved stack cannot adopt this configuration. Revert the change to keep it, or recreate it.'
		);
		expect(summary.recreateChanges?.map((change) => change.key)).toEqual([
			'[db] major_version',
		]);
	});

	it("keeps what the saved stack can't adopt across retries that each fail for another reason", async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		const lane = fakeLane({ worktreePath: repo });
		h.lanes.lanes = [lane];
		await h.engine.start();
		await h.engine.settle();
		const { stackId, facts } = await needsRecreateStack(h, repo);
		for (let retry = 1; retry <= 2; retry += 1) {
			// A lane tries it again, and a port it needs is taken each time.
			h.cli.replyNext('stack start', {
				exitCode: 1,
				stdout: `${JSON.stringify({ _tag: 'Error', error: { code: 'ExperimentalStackStartError', message: 'Port 54321 for api at 127.0.0.1 is in use by another process' } })}\n`,
				stderr: [],
			});
			const answer = await h.engine.ensureForLane({
				laneId: lane.id,
				worktreePath: repo,
				branch: 'main',
				environmentId: 'development',
				policy: 'auto',
			});
			await h.settle();
			expect(answer.summary.status).toBe('failed');
			// The second retry finds lastError no longer needs_recreate.
			const record = h.engine.stackStore.record(stackId);
			expect(record?.lastError?.code).toBe('ports_conflict');
			expect(record?.recreateError?.code).toBe('needs_recreate');
			await expect(h.engine.ensureStack(facts, FOLLOW)).resolves.toMatchObject({
				kind: 'refused',
				message:
					'The saved stack cannot adopt the current configuration. Revert the change to keep it, or recreate it.',
			});
			const state = h.engine.getState();
			const summary = state.stacks.find((entry) => entry.id === stackId);
			if (!summary) throw new Error('The stack is not listed.');
			expect(stackStatus(summary, { jobs: state.jobs }).explanation).toBe(
				'The saved stack cannot adopt this configuration. Revert the change to keep it, or recreate it.'
			);
		}
	});

	it("starts no other branch's stack when the worktree moves while a create waits", async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const first = await h.repository('first');
		const second = await h.repository('second');
		await h.engine.start();
		await h.engine.settle();
		const release = h.cli.hold('stack start');
		await h.engine.runOperation(
			op({ kind: 'start', stackId: await h.identity(first) }),
			OPERATOR
		);
		await h.cli.waitForCall('stack start');
		// New stacks start one at a time: this up waits behind the first.
		const mainId = await h.identity(second);
		const up = h.engine.runAgentOperation(
			{ operation: 'up', target: { worktreePath: second }, waitMs: 45_000 },
			{ requestId: 'request-1', holder: CLAUDE, synthetic: false },
			SIGNAL
		);
		await h.until(
			() =>
				h.engine.jobStore.activeJobs().filter((job) => job.kind === 'create')
					.length === 2
		);
		await h.checkout(second, 'feature');
		const featureId = await h.identity(second);
		release();
		await expect(up).rejects.toMatchObject({ code: 'branch_moved' });
		await h.settle();
		expect(h.cli.count('stack start')).toBe(1);
		expect(h.cli.stacks.has(featureId)).toBe(false);
		// Nothing ran, so nothing was recorded for the id the up named.
		expect(h.engine.stackStore.record(mainId)).toBeUndefined();
	});

	it('stops a stack whose start succeeded but printed output it cannot read', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const stackId = await h.identity(repo);
		h.cli.replyNext('stack start', {
			exitCode: 0,
			stdout: `${JSON.stringify({ unexpected: true })}\n`,
			stderr: [],
		});
		const release = h.cli.hold('stack start');
		const receipt = await h.engine.runOperation(
			op({ kind: 'start', stackId }),
			OPERATOR
		);
		await h.cli.waitForCall('stack start');
		// The CLI created and started it before printing.
		h.cli.addStack({ id: stackId, projectRoot: repo, running: true });
		release();
		await h.engine.waitForJob(receipt.jobId ?? '', 10_000);
		await h.settle();
		expect(h.engine.job(receipt.jobId ?? '')).toMatchObject({
			status: 'failed',
			error: { title: 'Unexpected Supabase CLI output' },
		});
		expect(h.cli.callsOf('stack stop').at(-1)?.argv).toEqual(
			expect.arrayContaining(['--stack-id', stackId])
		);
		expect(h.cli.stacks.get(stackId)?.running).toBe(false);
		// It did start, so it is not a failed first start to create again.
		expect(
			h.engine.stackStore.record(stackId)?.flags.failedStart
		).toBeUndefined();
	});

	it('creates one stack at a time and lets a queued creation be cancelled', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const first = await h.repository('first');
		const second = await h.repository('second');
		await h.engine.start();
		await h.engine.settle();
		const release = h.cli.hold('stack start');
		const firstId = await h.identity(first);
		const secondId = await h.identity(second);
		const one = await h.engine.runOperation(
			op({ kind: 'start', stackId: firstId }),
			OPERATOR
		);
		await h.cli.waitForCall('stack start');
		const two = await h.engine.runOperation(
			op({ kind: 'start', stackId: secondId }),
			OPERATOR
		);
		expect(two.message).toBe('Queued · new stacks start one at a time.');
		expect(h.engine.job(two.jobId ?? '')?.status).toBe('queued');
		expect(h.cli.count('stack start')).toBe(1);
		const cancel = await h.engine.runOperation(
			op({ kind: 'cancel-job', jobId: two.jobId }),
			OPERATOR
		);
		expect(cancel.completed).toBe(true);
		await h.until(() => h.engine.job(two.jobId ?? '')?.status === 'cancelled');
		release();
		await h.engine.waitForJob(one.jobId ?? '', 10_000);
		await h.settle();
		expect(h.engine.job(one.jobId ?? '')?.status).toBe('complete');
		expect(h.cli.count('stack start')).toBe(1);
	});

	it('interrupts a running creation on cancel and marks it interrupted', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const release = h.cli.hold('stack start');
		const stackId = await h.identity(repo);
		const receipt = await h.engine.runOperation(
			op({ kind: 'start', stackId }),
			OPERATOR
		);
		await h.cli.waitForCall('stack start');
		await h.engine.runOperation(
			op({ kind: 'cancel-job', jobId: receipt.jobId }),
			OPERATOR
		);
		await h.until(() => h.cli.interrupts.length > 0);
		release();
		await h.engine.waitForJob(receipt.jobId ?? '', 10_000);
		await h.settle();
		expect(h.cli.interrupts).toEqual(['stack start']);
		expect(h.engine.job(receipt.jobId ?? '')?.status).toBe('cancelled');
		expect(h.engine.stackStore.record(stackId)?.flags.interrupted).toBe(true);
	});

	it('lets callers that join an ensure learn its job', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const release = h.cli.hold('stack start');
		const stackId = await h.identity(repo);
		const receipt = await h.engine.runOperation(
			op({ kind: 'start', stackId }),
			OPERATOR
		);
		await h.cli.waitForCall('stack start');
		const up = h.engine.runAgentOperation(
			{ operation: 'up', target: { worktreePath: repo }, waitMs: 0 },
			{ requestId: 'request-1', holder: CLAUDE, synthetic: false },
			SIGNAL
		);
		const answer = await up;
		expect(answer).toMatchObject({ operation: 'up', jobId: receipt.jobId });
		release();
		await h.settle();
		expect(h.cli.count('stack start')).toBe(1);
		// The joined agent still gets its own hold once the stack runs.
		expect(
			h.engine.stackStore
				.record(stackId)
				?.holds.some((hold) => hold.agent.sessionId === 'session-a')
		).toBe(true);
	});

	it('tells an explicit caller the job its own flight runs, not an automatic one', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const stackId = await startStack(h, repo);
		await runToEnd(h, { kind: 'stop', stackIds: [stackId] });
		await h.settle();
		const facts = await h.engine.worktreeFacts(repo);
		if (!facts) throw new Error('The worktree has no facts.');
		const starts = h.cli.count('stack start');
		const release = h.cli.hold('stack start');
		const followJobs: string[] = [];
		const follow = h.engine.ensureStack(facts, {
			requestedBy: { kind: 'automatic', reason: 'follow' },
			createdBy: { via: 'desktop' },
			onJob: (jobId) => followJobs.push(jobId),
		});
		await h.until(() => h.cli.count('stack start') > starts);
		const operatorJobs: string[] = [];
		const start = h.engine.ensureStack(facts, {
			requestedBy: { kind: 'operator' },
			createdBy: { via: 'desktop' },
			onJob: (jobId) => operatorJobs.push(jobId),
		});
		// The follow's start fails; the operator's own one runs after it.
		h.cli.replyNext('stack start', {
			exitCode: 1,
			stdout: `${JSON.stringify({ _tag: 'Error', error: { code: 'ExperimentalStackStartError', message: 'database: initdb failed' } })}\n`,
			stderr: [],
		});
		release();
		await expect(follow).resolves.toMatchObject({ kind: 'refused' });
		await expect(start).resolves.toMatchObject({ kind: 'ready', stackId });
		const [followJob] = followJobs;
		const [operatorJob] = operatorJobs;
		expect(followJobs).toHaveLength(1);
		expect(operatorJobs).toHaveLength(1);
		expect(operatorJob).not.toBe(followJob);
		expect(h.engine.job(followJob ?? '')?.requestedBy).toEqual({
			kind: 'automatic',
			reason: 'follow',
		});
		expect(h.engine.job(operatorJob ?? '')).toMatchObject({
			status: 'complete',
			requestedBy: { kind: 'operator' },
		});
		expect(h.cli.count('stack start')).toBe(starts + 2);
	});

	it('waits for an automatic ensure that starts the stack, then attaches to it', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const { stackId, facts } = await stoppedStack(h, repo);
		const starts = h.cli.count('stack start');
		const release = h.cli.hold('stack start');
		const followJobs: string[] = [];
		const follow = h.engine.ensureStack(facts, {
			...FOLLOW,
			onJob: (jobId) => followJobs.push(jobId),
		});
		await h.until(() => h.cli.count('stack start') > starts);
		const calls = h.cli.count();
		const operatorJobs: string[] = [];
		const start = h.engine.ensureStack(facts, {
			requestedBy: { kind: 'operator' },
			createdBy: { via: 'desktop' },
			onJob: (jobId) => operatorJobs.push(jobId),
		});
		await h.settle();
		// One flight at a time: meanwhile it reads nothing and starts nothing.
		expect(h.engine.ensureQueued(stackId)).toBe(true);
		expect(h.cli.count()).toBe(calls);
		expect(operatorJobs).toEqual([]);
		release();
		await expect(follow).resolves.toMatchObject({ kind: 'ready', stackId });
		await expect(start).resolves.toMatchObject({ kind: 'ready', stackId });
		// The follow started it, so the operator's ensure only attached.
		expect(followJobs).toHaveLength(1);
		expect(operatorJobs).toEqual([]);
		expect(h.cli.count('stack start')).toBe(starts + 1);
		expect(h.engine.ensureQueued(stackId)).toBe(false);
	});

	it('stops calling an explicit ensure queued once the automatic one ends', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		const lane = fakeLane({ worktreePath: repo });
		h.lanes.lanes = [lane];
		await h.engine.start();
		await h.engine.settle();
		const { stackId, facts } = await needsRecreateStack(h, repo);
		const reads = h.cli.count('stack status');
		const releaseStatus = h.cli.hold('stack status');
		const follow = h.engine.ensureStack(facts, FOLLOW);
		await h.until(() => h.cli.count('stack status') > reads);
		const laneJobs: string[] = [];
		const laneEnsure = h.engine.ensureStack(facts, {
			requestedBy: { kind: 'lane', laneId: lane.id },
			createdBy: { via: 'desktop' },
			onJob: (jobId) => laneJobs.push(jobId),
		});
		expect(h.engine.ensureQueued(stackId)).toBe(true);
		// The follow is refused; the lane's own flight then lists again first.
		h.clock.now += 6_000;
		const lists = h.cli.count('stack list');
		const releaseList = h.cli.hold('stack list');
		releaseStatus();
		await expect(follow).resolves.toMatchObject({
			kind: 'refused',
			agentCode: 'needs_recreate',
		});
		await h.until(() => h.cli.count('stack list') > lists);
		// No longer behind an automatic start, though it has no job yet.
		expect(laneJobs).toEqual([]);
		expect(h.engine.ensureQueued(stackId)).toBe(false);
		releaseList();
		await expect(laneEnsure).resolves.toMatchObject({ kind: 'ready', stackId });
		expect(laneJobs).toHaveLength(1);
	});

	it('lets an automatic ensure that comes meanwhile join the explicit one', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		const lane = fakeLane({ worktreePath: repo });
		h.lanes.lanes = [lane];
		await h.engine.start();
		await h.engine.settle();
		const { stackId, facts } = await needsRecreateStack(h, repo);
		const starts = h.cli.count('stack start');
		const reads = h.cli.count('stack status');
		const releaseStatus = h.cli.hold('stack status');
		const follow = h.engine.ensureStack(facts, FOLLOW);
		await h.until(() => h.cli.count('stack status') > reads);
		const laneJobs: string[] = [];
		const laneEnsure = h.engine.ensureStack(facts, {
			requestedBy: { kind: 'lane', laneId: lane.id },
			createdBy: { via: 'desktop' },
			onJob: (jobId) => laneJobs.push(jobId),
		});
		// A follow that comes while the lane waits joins the lane's flight, so
		// none begins behind it and none gets the automatic refusal.
		const waitingJobs: string[] = [];
		const whileWaiting = h.engine.ensureStack(facts, {
			...FOLLOW,
			onJob: (jobId) => waitingJobs.push(jobId),
		});
		const releaseStart = h.cli.hold('stack start');
		releaseStatus();
		await expect(follow).resolves.toMatchObject({
			kind: 'refused',
			agentCode: 'needs_recreate',
		});
		await h.until(() => h.cli.count('stack start') > starts);
		// So does one that comes while the lane's own start runs.
		const runningJobs: string[] = [];
		const whileRunning = h.engine.ensureStack(facts, {
			...FOLLOW,
			onJob: (jobId) => runningJobs.push(jobId),
		});
		await h.settle();
		releaseStart();
		for (const joined of [laneEnsure, whileWaiting, whileRunning]) {
			await expect(joined).resolves.toMatchObject({ kind: 'ready', stackId });
		}
		expect(laneJobs).toHaveLength(1);
		expect(waitingJobs).toEqual(laneJobs);
		expect(runningJobs).toEqual(laneJobs);
		expect(h.cli.count('stack start')).toBe(starts + 1);
	});

	it('falls back to an argv-verified SIGTERM when stop fails', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const stackId = await startStack(h, repo);
		h.cli.replyNext('stack stop', {
			exitCode: 1,
			stdout: `${JSON.stringify({ _tag: 'Error', error: { code: 'ExperimentalStackStopError', message: 'stop failed' } })}\n`,
			stderr: [],
		});
		const receipt = await h.engine.runOperation(
			op({ kind: 'stop', stackIds: [stackId] }),
			OPERATOR
		);
		await h.until(() => h.signals.length > 0);
		await h.advance(1_000);
		expect(h.signals).toEqual([
			{ pid: h.cli.stacks.get(stackId)?.pid, signal: 'SIGTERM' },
		]);
		expect(h.engine.job(receipt.jobId ?? '')?.status).toBe('complete');
	});
});

describe('SupabaseEngine branch follow', () => {
	it('follows a held worktree to its new branch once HEAD settles for 30 s', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		h.agents.sessions = [fakeSession('session-a', '/Users/example/elsewhere')];
		await h.engine.start();
		await h.engine.settle();
		await agentUp(h, repo);
		const oldId = await h.identity(repo);
		await h.checkout(repo, 'feat-x');
		const newId = await h.identity(repo);
		await h.advance(15_000);
		expect(h.cli.stacks.has(newId)).toBe(false);
		await h.advance(31_000);
		expect(h.cli.stacks.get(newId)?.running).toBe(true);
		expect(h.cli.stacks.get(oldId)?.running).toBe(false);
		expect(
			h.engine.stackStore
				.record(newId)
				?.holds.some((hold) => hold.agent.sessionId === 'session-a')
		).toBe(true);
		expect(h.engine.stackStore.record(oldId)?.holds).toEqual([]);
		expect(h.engine.stackStore.record(oldId)?.flags.supersededAt).toBeTypeOf(
			'number'
		);
		// The old stack's data is kept.
		expect(h.cli.stacks.has(oldId)).toBe(true);
	});

	it('reattaches the old stack when the worktree switches back', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		h.agents.sessions = [fakeSession('session-a', '/Users/example/elsewhere')];
		await h.engine.start();
		await h.engine.settle();
		await agentUp(h, repo);
		const mainId = await h.identity(repo);
		await h.checkout(repo, 'feat-x');
		const featureId = await h.identity(repo);
		await h.advance(46_000);
		expect(h.cli.stacks.get(featureId)?.running).toBe(true);
		await h.checkout(repo, 'main');
		await h.advance(46_000);
		expect(h.cli.stacks.get(mainId)?.running).toBe(true);
		expect(h.cli.stacks.get(featureId)?.running).toBe(false);
		expect(h.cli.callsOf('stack start').at(-1)?.argv).toEqual(
			expect.arrayContaining(['--stack-id', mainId])
		);
		const record = h.engine.stackStore.record(mainId);
		expect(record?.flags.supersededAt).toBeUndefined();
		expect(
			record?.holds.some((hold) => hold.agent.sessionId === 'session-a')
		).toBe(true);
	});

	it('waits longer before each new try of a follow whose start keeps failing', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		h.agents.sessions = [fakeSession('session-a', '/Users/example/elsewhere')];
		await h.engine.start();
		await h.engine.settle();
		await agentUp(h, repo);
		const oldId = await h.identity(repo);
		await h.checkout(repo, 'feat-x');
		// The new branch has a broken migration: every create fails.
		for (let index = 0; index < 32; index += 1) {
			h.cli.replyNext('stack start', MIGRATION_FAILED);
		}
		await h.advance(5 * 60_000);
		const creates = () =>
			h.cli
				.callsOf('stack start')
				.filter((call) => call.argv.includes('--workdir')).length - 1;
		// A minute, then two, then four: not one try per 15 s tick.
		expect(creates()).toBe(3);
		expect(h.cli.stacks.get(oldId)?.running).toBe(true);
		await h.advance(60 * 60_000);
		expect(creates()).toBeLessThanOrEqual(7);
	});

	it('follows once a failed follow succeeds on its next try', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		h.agents.sessions = [fakeSession('session-a', '/Users/example/elsewhere')];
		await h.engine.start();
		await h.engine.settle();
		await agentUp(h, repo);
		const oldId = await h.identity(repo);
		await h.checkout(repo, 'feat-x');
		const newId = await h.identity(repo);
		h.cli.replyNext('stack start', MIGRATION_FAILED);
		await h.advance(46_000);
		expect(h.cli.count('stack start')).toBe(2);
		// No new try on the next ticks.
		await h.advance(45_000);
		expect(h.cli.count('stack start')).toBe(2);
		await h.advance(30_000);
		expect(h.cli.count('stack start')).toBe(3);
		expect(h.cli.stacks.get(newId)?.running).toBe(true);
		expect(h.cli.stacks.get(oldId)?.running).toBe(false);
		expect(
			h.engine.stackStore
				.record(newId)
				?.holds.some((hold) => hold.agent.sessionId === 'session-a')
		).toBe(true);
	});

	it('does not follow while a merge is in progress', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		h.agents.sessions = [fakeSession('session-a', '/Users/example/elsewhere')];
		await h.engine.start();
		await h.engine.settle();
		await agentUp(h, repo);
		await h.checkout(repo, 'feat-x');
		await writeFile(path.join(repo, '.git', 'MERGE_HEAD'), 'abc\n');
		const newId = await h.identity(repo);
		await h.advance(2 * 60_000);
		expect(h.cli.stacks.has(newId)).toBe(false);
	});

	it('only flags the stack in warn mode', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		h.agents.sessions = [fakeSession('session-a', '/Users/example/elsewhere')];
		await h.engine.start();
		await h.engine.settle();
		await h.engine.policyStore.updatePolicy({ branchSwitch: 'warn' });
		await agentUp(h, repo);
		const oldId = await h.identity(repo);
		await h.checkout(repo, 'feat-x');
		await h.advance(2 * 60_000);
		expect(h.cli.stacks.get(oldId)?.running).toBe(true);
		expect(h.cli.count('stack start')).toBe(1);
	});
});

describe('SupabaseEngine CLI drift', () => {
	it('restarts a stack whose owner binary vanished with the worktree CLI, once', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const stackId = await startStack(h, repo);
		// pnpm install replaced the binary the owner runs.
		const stack = h.cli.stacks.get(stackId);
		if (stack) stack.executable = '/opt/example/old/supabase';
		await h.advance(15_000);
		expect(stateOf(h, stackId)?.flags).toContain('cli-changed');
		await h.advance(45_000);
		expect(h.cli.count('stack stop')).toBe(1);
		expect(h.cli.callsOf('stack start').at(-1)?.argv).toContain('--stack-id');
		expect(h.cli.stacks.get(stackId)?.executable).not.toBe(
			'/opt/example/old/supabase'
		);
	});

	it('never restarts a stack again for a drift whose restart failed', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const stackId = await startStack(h, repo);
		const stack = h.cli.stacks.get(stackId);
		if (!stack) throw new Error('The stack did not start.');
		stack.executable = '/opt/example/old/supabase';
		// The restart stops it, but its start fails.
		h.cli.replyNext('stack start', MIGRATION_FAILED);
		await h.advance(60_000);
		expect(h.cli.count('stack stop')).toBe(1);
		expect(h.engine.getState().activity[0]).toMatchObject({
			kind: 'stop-and-start',
			outcome: 'failed',
		});
		// Another tool starts it again with the same binary: the same drift.
		stack.running = true;
		await h.advance(2 * 60_000);
		expect(h.cli.count('stack stop')).toBe(1);
		expect(stateOf(h, stackId)?.flags).toContain('cli-changed');
	});

	it('restarts a stack running another CLI release when an agent attaches', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		h.agents.sessions = [fakeSession('session-a', '/Users/example/elsewhere')];
		await h.engine.start();
		await h.engine.settle();
		const stackId = await startStack(h, repo);
		h.cli.replyNext(
			'stack status',
			h.cli.fixtureFor('status-release-mismatch', stackId)
		);
		h.cli.replyNext('stack status', h.cli.fixtureFor('status-awake', stackId));
		const result = await agentUp(h, repo);
		expect(result).toMatchObject({ operation: 'up' });
		expect(h.cli.count('stack stop')).toBe(1);
		expect(h.cli.callsOf('stack start').at(-1)?.argv).toEqual(
			expect.arrayContaining(['--stack-id', stackId])
		);
		expect(h.engine.getState().activity[0]).toMatchObject({
			kind: 'stop-and-start',
			outcome: 'complete',
		});
	});

	it('leaves a stack alone when the worktree CLI is not verified', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		const stackId = await startStack(h, repo);
		h.resolver.binaries.set('/opt/example/next/supabase', '2.130.0');
		h.resolver.worktreeBinaries.set(repo, '/opt/example/next/supabase');
		await h.engine.runOperation(
			op({
				kind: 'repository.recheck',
				repositoryId: stateOf(h, stackId)?.repositoryId,
			}),
			OPERATOR
		);
		await h.advance(2 * 60_000);
		expect(h.cli.count('stack stop')).toBe(0);
		expect(stateOf(h, stackId)?.mode.value).toBe('observed');
	});
});

describe('SupabaseEngine steering', () => {
	it('writes steering.json v1 for managed roots', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo', { lockfile: true });
		await h.engine.start();
		await h.engine.settle();
		await startStack(h, repo);
		await h.advance(15_000);
		const file = h.engine.steeringWriter.file;
		expect(path.dirname(file)).toBe(h.agentDirectory);
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		const steering = JSON.parse(await readFile(file, 'utf8'));
		expect(steering).toEqual({
			version: 1,
			writtenAt: expect.any(Number),
			desktopPid: process.pid,
			supabase: {
				enabled: true,
				roots: [
					{
						worktreeRoot: repo,
						projectRoot: repo,
						mode: 'managed',
						branchContext: 'refs/heads/main',
						stackReady: true,
						runner: 'pnpm exec supabase',
					},
				],
			},
		});
	});
});

describe('SupabaseEngine lane holds', () => {
	it.each([
		{
			backendPolicy: 'off' as const,
			environment: 'development',
			attached: false,
		},
		{ backendPolicy: undefined, environment: 'development', attached: false },
		{
			backendPolicy: 'auto' as const,
			environment: 'development',
			attached: true,
		},
		{
			backendPolicy: 'required' as const,
			environment: 'staging',
			attached: true,
		},
	])(
		'derives boot holds from persisted policy $backendPolicy in $environment',
		async ({ backendPolicy, environment, attached }) => {
			const h = await createEngineHarness({ enabled: true, start: false });
			const repo = await h.repository('repo');
			const stackId = await h.identity(repo);
			h.cli.addStack({ id: stackId, projectRoot: repo, running: true });
			const lane = fakeLane({ worktreePath: repo, backendPolicy, environment });
			h.lanes.lanes = [lane];
			await h.engine.start();
			await h.settle();
			expect(h.engine.attachment(lane.id)?.stackId).toBe(
				attached ? stackId : undefined
			);
		}
	);

	it('derives a boot hold for each lane on its own app project', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		const apps = ['mobile', 'admin'].map((name) =>
			path.join(repo, 'apps', name)
		);
		const ids: string[] = [];
		for (const [index, app] of apps.entries()) {
			await mkdir(path.join(app, 'supabase'), { recursive: true });
			await writeFile(
				path.join(app, 'supabase', 'config.toml'),
				'[experimental]\nstack = true\n'
			);
			const id = await h.identity(app);
			ids.push(id);
			h.cli.addStack({ id, projectRoot: app, running: true });
			h.lanes.lanes.push(
				fakeLane({
					id: `lane-11111111-2222-4333-8444-55555555555${index}`,
					worktreePath: repo,
					appPath: app,
					backendPolicy: 'auto',
				})
			);
		}
		await h.engine.start();
		await h.settle();
		for (const [index, lane] of h.lanes.lanes.entries()) {
			expect(h.engine.attachment(lane.id)?.stackId).toBe(ids[index]);
		}
	});

	it('keeps a Codex-over-MCP lane hold live from the monorepo root', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		const app = path.join(repo, 'apps', 'mobile');
		await mkdir(app, { recursive: true });
		const laneId = 'lane-11111111-2222-4333-8444-555555555555';
		// Codex over MCP attributes the lane to its shared client identity.
		const synthetic = {
			kind: 'codex',
			sessionId: 'mcp-codex-mcp-client',
		} as const;
		h.lanes.lanes = [
			fakeLane({
				id: laneId,
				worktreePath: repo,
				appPath: app,
				agent: { ...synthetic, lastSeenAt: h.clock.now },
			}),
		];
		// The session works from the checkout root, not the app directory.
		h.agents.sessions = [fakeSession('5d1b8f40-codex', repo, 'codex')];
		await h.engine.start();
		await h.engine.settle();
		await h.engine.ensureForLane({
			laneId,
			worktreePath: repo,
			appPath: app,
			branch: 'main',
			environmentId: 'development',
			policy: 'auto',
			agent: synthetic,
		});
		await h.settle();
		const stackId = h.engine.attachment(laneId)?.stackId as string;
		await h.engine.reconcileHolds();
		const atRoot = h.engine.holdsOf(stackId);
		expect(atRoot?.holds.find((hold) => hold.holder === 'lane')).toMatchObject({
			laneId,
			live: true,
			agent: { kind: 'codex', sessionId: synthetic.sessionId, synthetic: true },
		});
		expect(atRoot?.cwdKeepers).toEqual([]);
		expect(atRoot?.clocks).toEqual({});

		// From a sibling checkout the holder is gone, on a clock for that lane.
		h.agents.sessions = [fakeSession('5d1b8f40-codex', `${repo}-2`, 'codex')];
		await h.engine.reconcileHolds();
		const sibling = h.engine.holdsOf(stackId);
		expect(sibling?.holds.find((hold) => hold.holder === 'lane')).toMatchObject(
			{
				live: false,
			}
		);
		expect(Object.keys(sibling?.clocks ?? {})).toEqual([
			`codex:${synthetic.sessionId}@${repo}`,
		]);
	});
});

describe('SupabaseEngine releases', () => {
	it('releases a holder at once and leaves the stop to the linger', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		h.agents.sessions = [fakeSession('session-a', '/Users/example/elsewhere')];
		await h.engine.start();
		await h.engine.settle();
		await agentUp(h, repo);
		const stackId = await h.identity(repo);
		expect(h.engine.holderKeys()).toEqual([
			{ holder: CLAUDE, directory: repo },
		]);
		const released = await h.engine.releaseHolder({ holder: CLAUDE });
		expect(released).toEqual({
			releasedStackIds: [stackId],
			pendingStops: [stackId],
		});
		expect(h.cli.count('stack stop')).toBe(0);
		await h.advance(61_000);
		expect(h.cli.count('stack stop')).toBe(1);
	});

	it('skips an automatic stop that waited its turn while the stack was taken again', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const first = await h.repository('first');
		const second = await h.repository('second');
		const repo = await h.repository('repo');
		h.agents.sessions = [
			fakeSession('session-a', '/Users/example/elsewhere'),
			fakeSession('session-b', '/Users/example/elsewhere', 'codex'),
		];
		await h.engine.start();
		await h.engine.settle();
		const firstId = await startStack(h, first);
		const secondId = await startStack(h, second);
		await agentUp(h, repo);
		const stackId = await h.identity(repo);
		// Two restarts take both lifecycle slots.
		const release = h.cli.hold('stack restart');
		await h.engine.runOperation(
			op({ kind: 'restart', stackId: firstId }),
			OPERATOR
		);
		await h.engine.runOperation(
			op({ kind: 'restart', stackId: secondId }),
			OPERATOR
		);
		await h.until(() => h.cli.count('stack restart') === 2);
		await h.engine.releaseHolder({ holder: CLAUDE });
		await h.advance(61_000);
		// The stop is due, but waits behind the restarts.
		expect(
			h.engine.jobStore
				.activeJobs()
				.some((job) => job.kind === 'stop' && job.stackIds.includes(stackId))
		).toBe(true);
		await agentUp(h, repo, { kind: 'codex', sessionId: 'session-b' });
		release();
		await h.settle();
		expect(h.cli.stacks.get(stackId)?.running).toBe(true);
		expect(
			h.cli.callsOf('stack stop').filter((call) => call.argv.includes(stackId))
		).toEqual([]);
		expect(
			h.engine.stackStore
				.record(stackId)
				?.holds.some((hold) => hold.agent.sessionId === 'session-b')
		).toBe(true);
	});

	it('releases nothing for a synthetic holder without a session directory', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		await h.engine.start();
		await expect(
			h.engine.releaseHolder({
				holder: { kind: 'codex', sessionId: 'mcp-1234' },
			})
		).resolves.toEqual({ releasedStackIds: [], pendingStops: [] });
	});
});

describe('SupabaseEngine hardening toggles', () => {
	const PINNED = '[experimental]\nstack = true\n[api]\nport = 54321\n';

	it('refuses a pinned port another stack holds, unless leases are on', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const first = await h.repository('first', { config: PINNED });
		const second = await h.repository('second', { config: PINNED });
		await h.engine.start();
		await h.engine.settle();
		const firstId = await startStack(h, first);
		const stack = h.cli.stacks.get(firstId);
		if (stack) stack.apiPort = 54_321;
		await h.engine.runOperation(op({ kind: 'refresh' }), OPERATOR);
		await expect(agentUp(h, second)).rejects.toMatchObject({
			code: 'ports_pinned',
		});
		await h.engine.policyStore.updatePolicy({ pinnedPortsCompat: true });
		await agentUp(h, second);
		const lease = h.cli.callsOf('stack start').at(-1);
		expect(lease?.leasedPorts).toEqual({ SUPABASE_API_PORT: '33000' });
		expect(h.cli.callsOf('stack start')[0]?.leasedPorts).toBeUndefined();
	});

	it('passes --eager only for lane-driven creates with eager lanes on', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		const other = await h.repository('other');
		h.lanes.lanes = [
			fakeLane({
				id: 'lane-11111111-2222-4333-8444-555555555555',
				worktreePath: repo,
			}),
		];
		await h.engine.start();
		await h.engine.settle();
		await h.engine.policyStore.updatePolicy({ eagerLanes: true });
		await h.engine.ensureForLane({
			laneId: 'lane-11111111-2222-4333-8444-555555555555',
			worktreePath: repo,
			branch: 'main',
			environmentId: 'development',
			policy: 'auto',
		});
		await h.settle();
		expect(h.cli.callsOf('stack start')[0]?.argv).toContain('--eager');
		await startStack(h, other);
		expect(h.cli.callsOf('stack start')[1]?.argv).not.toContain('--eager');
	});

	it('writes per-stack keys before a start once git confirms they are ignored', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		await h.engine.policyStore.updatePolicy({ perStackKeys: true });
		await startStack(h, repo);
		const env = await readFile(
			path.join(repo, 'supabase', '.env.local'),
			'utf8'
		);
		expect(env).toMatch(/^SUPABASE_AUTH_SECRET_KEY=sb_secret_/m);
		expect(h.checkIgnores.length).toBeGreaterThan(0);
		// The lane no longer warns about the shared default keys.
		const stackId = await h.identity(repo);
		expect(stateOf(h, stackId)?.state).toBe('running');
		expect(JSON.stringify(h.engine.getState())).not.toMatch(SECRET_SHAPED);
	});

	it('never writes keys into a file git would commit', async () => {
		const h = await createEngineHarness({
			enabled: true,
			start: false,
			gitIgnored: false,
		});
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		await h.engine.policyStore.updatePolicy({ perStackKeys: true });
		await startStack(h, repo);
		await expect(
			stat(path.join(repo, 'supabase', '.env.local'))
		).rejects.toThrow();
	});
});

describe('SupabaseEngine adoption', () => {
	it('follows a child a previous desktop left running only when ps shows its command', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const root = path.join(h.userData, 'supabase');
		const progress = path.join(root, 'progress');
		await mkdir(progress, { recursive: true, mode: 0o700 });
		// What the desktop that quit mid-start wrote down.
		const previous = new SupabaseJobStore({
			directory: root,
			now: () => h.clock.now,
		});
		await previous.load();
		const stackId = 'a'.repeat(64);
		const command = `${fakeResolvedCli().binaryPath} stack start --stack-id ${stackId} --runtime native --output-format json`;
		const child = async (pid: number, uuid: string) => {
			const job = await previous.create({
				kind: 'resume',
				stackIds: [stackId],
				requestedBy: { kind: 'operator' },
				cancellable: true,
			});
			previous.start(job.id);
			const progressFile = path.join(
				progress,
				`start-${h.clock.now - 5_000}-${uuid}.log`
			);
			await writeFile(progressFile, '[task] done: Stack is ready.\n');
			await previous.recordChild({
				jobId: job.id,
				pid,
				startedAt: h.clock.now - 5_000,
				argvDigest: supabaseArgvDigest([command]),
				progressFile,
				stackIds: [stackId],
			});
			return job.id;
		};
		const ours = await child(4_242, '0f8fad5b-d9cb-469f-a165-70867728950e');
		const reused = await child(4_343, '1f8fad5b-d9cb-469f-a165-70867728950e');
		h.alivePids.add(4_242).add(4_343);
		h.discovery.commands.set(4_242, command);
		// After a reboot, another process got this pid.
		h.discovery.commands.set(4_343, '/usr/libexec/exampled --serve');
		await h.engine.start();
		expect(h.engine.job(ours)?.status).toBe('running');
		expect(h.engine.job(reused)?.status).toBe('lost');
		h.alivePids.delete(4_242);
		await h.advance(2_000);
		expect(h.engine.job(ours)?.status).toBe('complete');
		expect(await readdir(progress)).toEqual([]);
	});

	it('follows a child in a non-ASCII worktree from the line ps prints without a UTF-8 locale', async () => {
		// The desktop that quit: a create under ~/Développement, still running.
		const before = await createEngineHarness({ enabled: true, start: false });
		const repo = await before.repository('D\u00e9veloppement');
		const binary = path.join(
			repo,
			'node_modules/@supabase/cli-darwin-arm64/bin/supabase'
		);
		before.resolver.worktreeBinaries.set(repo, binary);
		before.resolver.binaries.set(binary, '2.121.0');
		await before.engine.start();
		await before.settle();
		const release = before.cli.hold('stack start');
		await before.engine.runOperation(
			op({ kind: 'start', stackId: await before.identity(repo) }),
			OPERATOR
		);
		await before.cli.waitForCall('stack start');
		await before.until(() => before.engine.jobStore.children().length === 1);
		const [recorded] = before.engine.jobStore.children();
		const [spawned] = before.cli.callsOf('stack start');
		release();
		await before.settle();
		if (!recorded || !spawned) throw new Error('No child was recorded.');
		expect(spawned.binaryPath).toBe(binary);
		// A desktop opened from the Dock has no LANG or LC_ALL, so ps runs in
		// the C locale and escapes every byte of `é`.
		const printed = [spawned.binaryPath, ...spawned.argv]
			.join(' ')
			.replaceAll('\u00e9', 'M-CM-)');
		expect(printed).toMatch(/^[\x20-\x7e]+$/);

		const h = await createEngineHarness({ enabled: true, start: false });
		const root = path.join(h.userData, 'supabase');
		const progress = path.join(root, 'progress');
		await mkdir(progress, { recursive: true, mode: 0o700 });
		const previous = new SupabaseJobStore({
			directory: root,
			now: () => h.clock.now,
		});
		await previous.load();
		const job = await previous.create({
			kind: 'create',
			stackIds: recorded.stackIds,
			requestedBy: { kind: 'operator' },
			cancellable: true,
		});
		previous.start(job.id);
		const progressFile = path.join(
			progress,
			`start-${h.clock.now - 5_000}-0f8fad5b-d9cb-469f-a165-70867728950e.log`
		);
		await writeFile(progressFile, '[task] done: Stack is ready.\n');
		await previous.recordChild({
			...recorded,
			jobId: job.id,
			startedAt: h.clock.now - 5_000,
			progressFile,
		});
		h.alivePids.add(recorded.pid);
		h.discovery.commands.set(recorded.pid, printed);
		await h.engine.start();
		expect(h.engine.job(job.id)?.status).toBe('running');
		h.alivePids.delete(recorded.pid);
		await h.advance(2_000);
		expect(h.engine.job(job.id)?.status).toBe('complete');
	});
});

describe('SupabaseEngine storage', () => {
	it('keeps its stores in a private <userData>/supabase', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		await h.engine.start();
		await h.engine.settle();
		await startStack(h, repo);
		const root = path.join(h.userData, 'supabase');
		expect((await stat(root)).mode & 0o777).toBe(0o700);
		for (const file of [
			h.engine.stackStore.file,
			h.engine.jobStore.file,
			h.engine.policyStore.file,
		]) {
			expect(path.dirname(file)).toBe(await realpath(root));
			expect((await stat(file)).mode & 0o777).toBe(0o600);
		}
		// Every CLI call ran from the neutral cwd, never a worktree.
		expect(h.engine.cwd).toBe(path.join(h.userData, 'supabase', 'cwd'));
	});

	it('removes the progress files of children no desktop will read again', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const progress = path.join(h.userData, 'supabase', 'progress');
		await mkdir(progress, { recursive: true, mode: 0o700 });
		const uuid = '0f8fad5b-d9cb-469f-a165-70867728950e';
		const leftover = path.join(
			progress,
			`create-${h.clock.now - 60_000}-${uuid}.log`
		);
		const newer = path.join(
			progress,
			`stop-${h.clock.now + 60_000}-${uuid}.log`
		);
		await writeFile(leftover, '[task] done: Stack is ready.\n');
		await writeFile(newer, '');
		await h.engine.start();
		await h.engine.settle();
		expect(await readdir(progress)).toEqual([path.basename(newer)]);
	});

	it('runs no CLI while a supabase/config.toml sits above its working directory', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		await h.repository('repo');
		await writeFile(path.join(h.userData, 'supabase', 'config.toml'), '');
		await h.engine.start();
		await h.engine.settle();
		expect(h.cli.count()).toBe(0);
		expect(h.engine.getState().discovery.listFailure?.message).toMatch(
			/Supabase CLI calls are blocked/
		);
		expect(h.logs.join('\n')).toMatch(
			/runs no Supabase CLI until it is removed/
		);
	});
});

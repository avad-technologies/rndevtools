import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Lane } from '../../shared/lane-protocol';
import {
	laneBackendSummarySchema,
	SUPABASE_APP_ENV_PRESET,
	supabaseOperationSchema,
} from '../../shared/supabase-protocol';
import { MainOnlyCredentials } from './cli-contract';
import { SECRET_SHAPED } from './cli-fixtures.test-support';
import {
	createEngineHarness,
	disposeEngineHarnesses,
	type EngineHarness,
	fakeLane,
} from './engine.test-support';
import { supabaseLaneEnv } from './lane-backend';
import type {
	LaneBackendEnsureInput,
	LaneBackendEnsureResult,
} from './service-ports';

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

const LANE_A = 'lane-11111111-2222-4333-8444-555555555555';
const LANE_B = 'lane-22222222-3333-4444-8555-666666666666';

function input(
	worktreePath: string,
	fields: Partial<LaneBackendEnsureInput> = {}
): LaneBackendEnsureInput {
	return {
		laneId: LANE_A,
		worktreePath,
		branch: 'main',
		environmentId: 'development',
		policy: 'auto',
		...fields,
	};
}

/** What every answer must be: a summary the lane wire accepts, public values only. */
function checked(result: LaneBackendEnsureResult): LaneBackendEnsureResult {
	laneBackendSummarySchema.parse(result.summary);
	expect(JSON.stringify(result.summary)).not.toMatch(SECRET_SHAPED);
	for (const [name, value] of Object.entries(result.laneEnv ?? {})) {
		expect(SUPABASE_APP_ENV_PRESET.map((entry) => entry.name)).toContain(name);
		expect(value).not.toMatch(/sb_secret_|postgres(?:ql)?:\/\/|eyJ/);
	}
	return result;
}

async function setup(options: { appDotenv?: string } = {}) {
	const h = await createEngineHarness({ enabled: true, start: false });
	const repo = await h.repository('repo', options);
	h.lanes.lanes = [fakeLane({ id: LANE_A, worktreePath: repo })];
	await h.engine.start();
	await h.engine.settle();
	return { h, repo, stackId: await h.identity(repo) };
}

function attached(h: EngineHarness, stackId: string): string[] {
	return (
		h.engine
			.getState()
			.stacks.find((stack) => stack.id === stackId)
			?.lanes.map((lane) => lane.laneId) ?? []
	);
}

describe('supabaseLaneEnv', () => {
	it('maps public values only, and leaves out what is unknown', () => {
		const lane = supabaseLaneEnv(
			[
				{ name: 'EXPO_PUBLIC_SUPABASE_URL', source: 'API_URL' },
				{ name: 'EXPO_PUBLIC_SUPABASE_KEY', source: 'PUBLISHABLE_KEY' },
				{ name: 'EXPO_PUBLIC_FUNCTIONS', source: 'FUNCTIONS_URL' },
			],
			{
				apiUrl: 'http://127.0.0.1:26211',
				restUrl: 'http://127.0.0.1:26211/rest/v1',
			},
			new MainOnlyCredentials({ publishableKey: 'sb_publishable_example' })
		);
		expect(lane.env).toEqual({
			EXPO_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:26211',
			EXPO_PUBLIC_SUPABASE_KEY: 'sb_publishable_example',
		});
		expect(lane.names).toEqual([
			'EXPO_PUBLIC_SUPABASE_URL',
			'EXPO_PUBLIC_SUPABASE_KEY',
		]);
		expect(lane.fingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(lane.fingerprint).not.toContain('sb_publishable_example');
	});

	it('never maps a URL that is not loopback', () => {
		const lane = supabaseLaneEnv(
			[{ name: 'EXPO_PUBLIC_SUPABASE_URL', source: 'API_URL' }],
			{ apiUrl: 'http://192.168.1.20:26211' },
			undefined
		);
		expect(lane.env).toEqual({});
	});
});

describe('ensureForLane', () => {
	it('starts the worktree stack and gives Metro the public values', async () => {
		const { h, stackId } = await setup();
		const repo = h.lanes.lanes[0]?.worktreePath ?? '';
		const result = checked(await h.engine.ensureForLane(input(repo)));
		expect(result.summary).toMatchObject({
			policy: 'auto',
			status: 'ready',
			stackId,
			appEnvNames: [
				'EXPO_PUBLIC_SUPABASE_URL',
				'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
			],
			warnings: ['shared-default-keys'],
		});
		expect(result.laneEnv).toEqual({
			EXPO_PUBLIC_SUPABASE_URL: result.summary.apiUrl,
			EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: h.cli.secrets.publishableKey,
		});
		expect(attached(h, stackId)).toEqual([LANE_A]);
		// A lane up never pins: the lane holds the stack.
		expect(h.engine.stackStore.record(stackId)?.pinned).toBe(false);
	});

	it('takes the identity from HEAD, not from the branch it is told', async () => {
		const { h, repo, stackId } = await setup();
		const result = checked(
			await h.engine.ensureForLane(input(repo, { branch: 'something-else' }))
		);
		expect(result.summary.stackId).toBe(stackId);
	});

	it('answers a waitMs 0 ask from its records, without running anything', async () => {
		const { h, repo } = await setup();
		const first = checked(await h.engine.ensureForLane(input(repo)));
		await h.settle();
		const calls = h.processCalls();
		const again = checked(
			await h.engine.ensureForLane(input(repo, { waitMs: 0 }))
		);
		expect(again.summary.status).toBe('ready');
		expect(again.laneEnv).toEqual(first.laneEnv);
		expect(h.processCalls()).toBe(calls);
	});

	it('answers starting past its wait, then attaches late without rejecting', async () => {
		const { h, repo, stackId } = await setup();
		const release = h.cli.hold('stack start');
		const pending = h.engine.ensureForLane(input(repo, { waitMs: 1_000 }));
		await h.cli.waitForCall('stack start');
		await h.advance(1_000);
		const result = checked(await pending);
		expect(result.summary).toMatchObject({ status: 'starting', stackId });
		expect(result.summary.jobId).toMatch(/^supabase-job-/);
		expect(result.laneEnv).toBeUndefined();
		release();
		const late = await result.lateAttach;
		expect(late?.summary.status).toBe('ready');
		expect(late?.laneEnv?.EXPO_PUBLIC_SUPABASE_URL).toMatch(
			/^http:\/\/127\.0\.0\.1:/
		);
		laneBackendSummarySchema.parse(late?.summary);
	});

	it('never waits on Metro restarts of the lanes it moves', async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const repo = await h.repository('repo');
		const lanes: Lane[] = [
			fakeLane({ id: LANE_A, worktreePath: repo }),
			fakeLane({
				id: LANE_B,
				worktreePath: repo,
				port: 8082,
				simulatorUdid: 'BBBBBBBB-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
			}),
		];
		h.lanes.lanes = lanes;
		await h.engine.start();
		await h.engine.settle();
		const stackId = await h.identity(repo);
		checked(await h.engine.ensureForLane(input(repo, { laneId: LANE_B })));
		await h.settle();
		// Stopped meanwhile; its next start moves the API port.
		const stop = await h.engine.runOperation(
			supabaseOperationSchema.parse({
				actionId: 'action-stop',
				kind: 'stop',
				stackIds: [stackId],
			}),
			{ actor: { kind: 'operator', senderId: 1 }, confirmed: false }
		);
		await h.engine.waitForJob(stop.jobId ?? '', 10_000);
		await h.settle();
		const stack = h.cli.stacks.get(stackId);
		if (stack) stack.moveApiTo = 26_999;
		// Restarting Metro asks this service again from inside the lane's queue.
		h.lanes.restartMetroImpl = () => new Promise(() => undefined);
		const result = checked(
			await h.engine.ensureForLane(input(repo, { laneId: LANE_A }))
		);
		expect(result.summary).toMatchObject({
			status: 'ready',
			apiUrl: 'http://127.0.0.1:26999',
		});
		expect(h.lanes.metroRestarts).toEqual([
			{ laneId: LANE_B, reason: 'ports-moved' },
		]);
	});

	it("warns when the lane's Simulator last ran against another stack", async () => {
		const h = await createEngineHarness({ enabled: true, start: false });
		const first = await h.repository('repo');
		const second = await h.repository('other');
		// Both lanes run on the same Simulator, one after the other.
		h.lanes.lanes = [
			fakeLane({ id: LANE_A, worktreePath: first }),
			fakeLane({ id: LANE_B, worktreePath: second, port: 8082 }),
		];
		await h.engine.start();
		await h.engine.settle();
		const warned = async (laneId: string, worktreePath: string) => {
			const result = checked(
				await h.engine.ensureForLane(input(worktreePath, { laneId }))
			);
			await h.settle();
			expect(result.summary.status).toBe('ready');
			return result.summary.warnings.includes('previous-session-on-simulator');
		};
		expect(await warned(LANE_A, first)).toBe(false);
		expect(await warned(LANE_A, first)).toBe(false);
		expect(await warned(LANE_B, second)).toBe(true);
		expect(await warned(LANE_A, first)).toBe(true);
		expect(await warned(LANE_A, first)).toBe(false);
		// The Simulator is listed only on the stack it last ran.
		const served = async (worktreePath: string) =>
			h.engine.stackStore
				.record(await h.identity(worktreePath))
				?.servedSimulators?.map((entry) => entry.udid);
		expect(await served(first)).toEqual([
			'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
		]);
		expect(await served(second)).toEqual([]);
	});

	it('detaches idempotently, including lanes it never saw', async () => {
		const { h, repo, stackId } = await setup();
		checked(await h.engine.ensureForLane(input(repo)));
		h.engine.detachLane(LANE_A);
		h.engine.detachLane(LANE_A);
		h.engine.detachLane(LANE_B);
		await h.settle();
		expect(attached(h, stackId)).toEqual([]);
	});

	it('never rejects over a backend problem', async () => {
		const { h, repo } = await setup();
		h.lanes.lanes = null as unknown as Lane[];
		const result = checked(await h.engine.ensureForLane(input(repo)));
		expect(result.summary.status).toBe('failed');
		const missing = checked(
			await h.engine.ensureForLane(
				input('/Users/example/code/missing', { laneId: LANE_B })
			)
		);
		expect(missing.summary).toMatchObject({
			status: 'skipped',
			reason: 'no-project',
		});
	});

	it('fails a lane whose start fails, and does not hold the stack', async () => {
		const { h, repo, stackId } = await setup();
		h.cli.replyNext('stack start', {
			exitCode: 1,
			stdout: `${JSON.stringify({ _tag: 'Error', error: { code: 'ExperimentalStackStartError', message: 'database: initdb failed' } })}\n`,
			stderr: [],
		});
		const result = checked(
			await h.engine.ensureForLane(input(repo, { policy: 'required' }))
		);
		expect(result.summary).toMatchObject({
			policy: 'required',
			status: 'failed',
		});
		expect(result.laneEnv).toBeUndefined();
		expect(attached(h, stackId)).toEqual([]);
	});

	it('warns about a shadowing app dotenv in auto mode and fails required', async () => {
		const { h, repo } = await setup({
			appDotenv: 'EXPO_PUBLIC_SUPABASE_URL=https://example.com\n',
		});
		const auto = checked(await h.engine.ensureForLane(input(repo)));
		expect(auto.summary).toMatchObject({
			status: 'shadowed',
			reason: 'dotenv-shadowed',
		});
		expect(auto.summary.warnings).toContain('dotenv-shadowed');
		expect(auto.summary.reasonText).toMatch(
			/\.env:1 sets EXPO_PUBLIC_SUPABASE_URL/
		);
		expect(auto.laneEnv).toBeDefined();
		const required = checked(
			await h.engine.ensureForLane(input(repo, { policy: 'required' }))
		);
		expect(required.summary.status).toBe('shadowed');
		expect(required.laneEnv).toBeUndefined();
	});

	it('makes no call for a lane whose backend is off', async () => {
		const { h, repo } = await setup();
		const calls = h.processCalls();
		const result = checked(
			await h.engine.ensureForLane(input(repo, { policy: 'off' }))
		);
		expect(result.summary).toMatchObject({ status: 'skipped', reason: 'off' });
		expect(h.processCalls()).toBe(calls);
	});
});

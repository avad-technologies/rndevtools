import { describe, expect, it } from 'vitest';
import {
	createSupabaseDemoState,
	SUPABASE_DEMO_IDS,
} from './supabase-demo-data';
import {
	applySupabasePolicyPatch,
	attentionItems,
	checkSupabaseOperation,
	EMPTY_SUPABASE_STATE,
	formatSupabaseSize,
	isLoopbackHttpUrl,
	isSupabaseJobId,
	type LaneBackendSummary,
	laneBackendChip,
	laneBackendSelectAvailability,
	laneBackendSummarySchema,
	laneDefaultBackend,
	laneWorktreeSupabaseSuffix,
	nextEvents,
	SUPABASE_AGENT_OPERATIONS,
	SUPABASE_CONFIRMATION_KINDS,
	SUPABASE_OPERATION_KINDS,
	SUPABASE_POLICY_DEFAULTS,
	SUPABASE_POLICY_ERRORS,
	SUPABASE_REASONS,
	SUPABASE_UNREADABLE_RECOVERY,
	type SupabaseAvailabilityContext,
	type SupabaseJob,
	type SupabaseMigrationsView,
	type SupabaseOperation,
	type SupabaseStackAction,
	type SupabaseStackChangeView,
	type SupabaseStackSummary,
	type SupabaseState,
	sanitizeSupabaseDisplayText,
	serviceStateLabel,
	sidebarBadge,
	stackStatus,
	supabaseActionAvailability,
	supabaseActivityStats,
	supabaseAgentEnvSchema,
	supabaseAgentLabel,
	supabaseAgentOperationFromCommand,
	supabaseAgentOperationSchema,
	supabaseAgentRecovery,
	supabaseAgentResultSchema,
	supabaseBranchLabel,
	supabaseCleanUpAvailability,
	supabaseConfirmationRequired,
	supabaseConfirmationResultSchema,
	supabaseDerivedCap,
	supabaseDesktopError,
	supabaseDoctorInfoSchema,
	supabaseErrorSchema,
	supabaseGlobalActionAvailability,
	supabaseInlineConfirmation,
	supabaseInterestSchema,
	supabaseJobLabel,
	supabaseOperationActions,
	supabaseOperationReceiptSchema,
	supabaseOperationSchema,
	supabasePlatformLabel,
	supabasePolicyPatchErrors,
	supabasePolicyTrustChanges,
	supabaseRepositoryActionAvailability,
	supabaseRequestActionAvailability,
	supabaseRevertKeepsStack,
	supabaseStackSummarySchema,
	supabaseStackTitle,
	supabaseStateSchema,
	visibleStackFlags,
	withSupabaseConfirmation,
} from './supabase-protocol';

const ids = SUPABASE_DEMO_IDS;
const now = 1_792_245_785_000;
const demo = createSupabaseDemoState({ now });
const ACTION = 'supabase-test-action';
const TOKEN = `confirmation-${'a'.repeat(64)}`;

function demoStack(id: string): SupabaseStackSummary {
	const stack = demo.stacks.find((candidate) => candidate.id === id);
	if (!stack) throw new Error(`missing demo stack ${id}`);
	return stack;
}

const checkout = demoStack(ids.featCheckout);
const stopped = demoStack(ids.featSearch);

function stackWith(
	base: SupabaseStackSummary,
	overrides: Partial<SupabaseStackSummary>
): SupabaseStackSummary {
	return { ...base, ...overrides };
}

const MAJOR_VERSION: SupabaseStackChangeView = {
	key: '[db] major_version',
	saved: '15',
	requested: '17',
	editable: true,
};
/** What a CLI upgrade reports: no setting controls the pinned build. */
const POSTGRES_BUILD: SupabaseStackChangeView = {
	key: 'Postgres build',
	saved: '17.4.1',
	requested: '17.6.1',
	editable: false,
};

/** A stack whose start the CLI refused over changes it can't adopt. */
function needsRecreate(
	stackChanges?: SupabaseStackChangeView[],
	base: SupabaseStackSummary = stopped
): SupabaseStackSummary {
	return stackWith(base, {
		state: 'needs-recreate',
		lastError: {
			...supabaseDesktopError('refused', 'x'),
			code: 'needs_recreate',
			details: stackChanges ? { stackChanges } : {},
		},
		...(stackChanges ? { recreateChanges: stackChanges } : {}),
	});
}

/** The same stack once a retry failed for another reason: lastError moved on. */
function retriedOtherwise(stack: SupabaseStackSummary): SupabaseStackSummary {
	return stackWith(stack, {
		lastError: {
			...supabaseDesktopError('refused', 'Port 54321 is in use.'),
			code: 'ports_conflict',
			details: { port: 54_321, portProblem: 'held-by-process' },
		},
	});
}

function job(overrides: Partial<SupabaseJob> = {}): SupabaseJob {
	return {
		id: 'supabase-job-00000000-0000-4000-8000-000000000001',
		kind: 'resume',
		stackIds: [checkout.id],
		status: 'running',
		startedAt: now - 1_000,
		updatedAt: now,
		cancellable: true,
		requestedBy: { kind: 'operator' },
		...overrides,
	};
}

function context(
	overrides: Partial<SupabaseAvailabilityContext> = {},
	state: Partial<SupabaseState> = {}
): SupabaseAvailabilityContext {
	return {
		bridgeAvailable: true,
		state: { ...demo, jobs: [], ...state },
		now,
		...overrides,
	};
}

describe('operation kinds', () => {
	it('lists every operation kind once', () => {
		expect(new Set(SUPABASE_OPERATION_KINDS).size).toBe(
			SUPABASE_OPERATION_KINDS.length
		);
		expect(SUPABASE_OPERATION_KINDS).toContain('request.approve');
		for (const kind of SUPABASE_CONFIRMATION_KINDS) {
			expect(SUPABASE_OPERATION_KINDS).toContain(kind);
		}
	});
});

describe('schemas', () => {
	it('parses the empty and demo states', () => {
		expect(supabaseStateSchema.parse(EMPTY_SUPABASE_STATE)).toEqual(
			EMPTY_SUPABASE_STATE
		);
		expect(supabaseStateSchema.parse(demo)).toEqual(demo);
	});

	it('is strict and keeps ids unique', () => {
		expect(
			supabaseStateSchema.safeParse({ ...demo, secretKey: 'x' }).success
		).toBe(false);
		expect(
			supabaseStateSchema.safeParse({
				...demo,
				stacks: [checkout, checkout],
			}).success
		).toBe(false);
		expect(
			supabaseStackSummarySchema.safeParse({ ...checkout, dbUrl: 'x' }).success
		).toBe(false);
		expect(
			supabaseStackSummarySchema.safeParse({ ...checkout, origin: 'expected' })
				.success
		).toBe(false);
		expect(
			supabaseStackSummarySchema.safeParse({
				...checkout,
				flags: ['stale-branch', 'stale-branch'],
			}).success
		).toBe(false);
	});

	it.each([
		['http://127.0.0.1:21734', true],
		['http://127.0.0.1:21734/rest/v1', true],
		['http://[::1]:21734', true],
		['http://localhost:21734', false],
		['http://0.0.0.0:21734', false],
		['http://192.168.1.20:21734', false],
		['https://127.0.0.1:21734', false],
		['http://127.0.0.1', false],
		['http://user:pw@127.0.0.1:21734', false],
		['http://127.0.0.1:21734/?apikey=x', false],
		['http://127.0.0.1:021734', false],
		['postgresql://postgres:pw@127.0.0.1:21736/postgres', false],
	])('treats %s as loopback http: %s', (url, expected) => {
		expect(isLoopbackHttpUrl(url)).toBe(expected);
		expect(
			supabaseStackSummarySchema.safeParse({ ...checkout, apiUrl: url }).success
		).toBe(expected);
	});

	it('takes ids only, never paths', () => {
		const valid = { actionId: ACTION, kind: 'start', stackId: checkout.id };
		expect(supabaseOperationSchema.safeParse(valid).success).toBe(true);
		for (const invalid of [
			{ ...valid, stackId: '/Users/dev/app' },
			{ ...valid, stackId: checkout.id.slice(0, 12) },
			{ ...valid, worktreePath: '/Users/dev/app' },
			{ actionId: ACTION, kind: 'prepare' },
			{
				actionId: ACTION,
				kind: 'prepare',
				repositoryId: ids.repositoryApp,
				stackId: checkout.id,
			},
			{ actionId: ACTION, kind: 'prepare', repositoryId: '/Users/dev/app' },
			{
				actionId: ACTION,
				kind: 'update-policy',
				patch: { supabaseHome: '/Users/dev/.supabase' },
			},
			{
				actionId: ACTION,
				kind: 'choose-path',
				field: 'supabase-home',
				path: '/',
			},
			{
				actionId: ACTION,
				kind: 'destroy',
				stackIds: [checkout.id, checkout.id],
				removeUploads: false,
			},
			{
				actionId: ACTION,
				kind: 'destroy',
				stackIds: [checkout.id],
				removeUploads: false,
				confirmationToken: 'confirmation-xyz',
			},
			{
				actionId: ACTION,
				kind: 'set-enabled',
				enabled: true,
				disposition: 'stop-managed',
			},
			{
				actionId: ACTION,
				kind: 'read-logs',
				stackId: checkout.id,
				tail: 5_000,
			},
			{
				actionId: ACTION,
				kind: 'read-logs',
				stackId: checkout.id,
				tail: 200,
				since: 'yesterday',
			},
		]) {
			expect(supabaseOperationSchema.safeParse(invalid).success).toBe(false);
		}
		expect(
			supabaseOperationSchema.safeParse({
				actionId: ACTION,
				kind: 'read-logs',
				stackId: checkout.id,
				services: ['rest', 'gateway'],
				tail: 1_000,
				since: '10m',
			}).success
		).toBe(true);
		expect(
			supabaseOperationSchema.safeParse({
				actionId: ACTION,
				kind: 'read-logs',
				stackId: checkout.id,
				tail: 1_000,
				since: '2026-10-17T14:00:00Z',
			}).success
		).toBe(true);
	});

	it('validates job and request ids', () => {
		expect(isSupabaseJobId(ids.jobFixAuth)).toBe(true);
		expect(isSupabaseJobId('simulator-job-1')).toBe(false);
		expect(
			supabaseOperationSchema.safeParse({
				actionId: ACTION,
				kind: 'request.deny',
				requestId: ids.requestOldUi,
			}).success
		).toBe(true);
		expect(
			supabaseOperationSchema.safeParse({
				actionId: ACTION,
				kind: 'request.deny',
				requestId: 'request-1',
			}).success
		).toBe(false);
	});

	it('only lets the stacks view inspect a stack', () => {
		expect(
			supabaseInterestSchema.safeParse({
				view: 'stacks',
				inspectStackId: checkout.id,
				sections: ['overview', 'logs'],
			}).success
		).toBe(true);
		expect(
			supabaseInterestSchema.safeParse({
				view: 'hidden',
				inspectStackId: checkout.id,
				sections: [],
			}).success
		).toBe(false);
		expect(
			supabaseInterestSchema.safeParse({
				view: 'stacks',
				sections: ['logs', 'logs'],
			}).success
		).toBe(false);
	});

	it('ties receipt payloads to their operation kind and bounds logs', () => {
		const base = { actionId: ACTION, completed: true };
		expect(
			supabaseOperationReceiptSchema.safeParse({
				...base,
				kind: 'copy',
				copy: { copied: true, what: 'publishable-key' },
			}).success
		).toBe(true);
		expect(
			supabaseOperationReceiptSchema.safeParse({
				...base,
				kind: 'refresh',
				copy: { copied: true, what: 'publishable-key' },
			}).success
		).toBe(false);
		const line = 'x'.repeat(2_000);
		const records = Array.from({ length: 33 }, () => ({
			type: 'entry',
			timestamp: '2026-10-17T14:00:00Z',
			source: 'history',
			service: 'rest',
			instanceId: 'abc',
			stream: 'stdout',
			line,
		}));
		expect(
			supabaseOperationReceiptSchema.safeParse({
				...base,
				kind: 'read-logs',
				logs: { records, truncated: false, bytes: 66_000, readAt: now },
			}).success
		).toBe(false);
		expect(
			supabaseOperationReceiptSchema.safeParse({
				...base,
				kind: 'read-logs',
				logs: {
					records: records.slice(0, 32),
					truncated: true,
					bytes: 64_000,
					readAt: now,
				},
			}).success
		).toBe(true);
	});

	it('issues tokens only for required, confirmed dialogs', () => {
		expect(
			supabaseConfirmationResultSchema.safeParse({
				actionId: ACTION,
				required: true,
				confirmed: true,
				token: TOKEN,
				expiresAt: now + 60_000,
				options: { removeUploads: true },
			}).success
		).toBe(true);
		expect(
			supabaseConfirmationResultSchema.safeParse({
				actionId: ACTION,
				required: false,
				confirmed: true,
				token: TOKEN,
			}).success
		).toBe(false);
	});

	it('keeps the error view bounded and its codes closed', () => {
		const error = supabaseDesktopError('refused', 'Stop it first.\u0007');
		expect(supabaseErrorSchema.parse(error)).toEqual(error);
		expect(error.message).toBe('Stop it first.');
		expect(
			supabaseErrorSchema.safeParse({ ...error, code: 'backend_failed' })
				.success
		).toBe(false);
		expect(SUPABASE_UNREADABLE_RECOVERY).not.toMatch(/destroy it/i);
	});

	it('keeps lane summaries loopback and names-only', () => {
		const summary: LaneBackendSummary = {
			policy: 'auto',
			status: 'ready',
			stackId: checkout.id,
			apiUrl: 'http://127.0.0.1:21734',
			appEnvNames: ['EXPO_PUBLIC_SUPABASE_URL'],
			warnings: ['shared-default-keys'],
		};
		expect(laneBackendSummarySchema.parse(summary)).toEqual(summary);
		expect(
			laneBackendSummarySchema.safeParse({
				...summary,
				apiUrl: 'http://192.168.1.5:21734',
			}).success
		).toBe(false);
		expect(
			laneBackendSummarySchema.safeParse({
				...summary,
				laneEnv: { EXPO_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:21734' },
			}).success
		).toBe(false);
	});
});

describe('agent surface', () => {
	it('parses agent operations with bounded waits and one target', () => {
		expect(
			supabaseAgentOperationSchema.safeParse({
				operation: 'up',
				target: { worktreePath: '/Users/dev/app-wt/feat-x' },
				waitMs: 30_000,
			}).success
		).toBe(true);
		for (const invalid of [
			{ operation: 'up', target: { worktreePath: 'relative' }, waitMs: 0 },
			{ operation: 'up', target: { stackId: 'abc' }, waitMs: 0 },
			{
				operation: 'up',
				target: { worktreePath: '/a', stackId: checkout.id },
				waitMs: 0,
			},
			{ operation: 'up', target: { worktreePath: '/a' }, waitMs: 45_001 },
			{
				operation: 'destroy',
				target: { stackId: checkout.id.slice(0, 8) },
				note: 'x'.repeat(961),
			},
			{ operation: 'stop-all' },
		]) {
			expect(supabaseAgentOperationSchema.safeParse(invalid).success).toBe(
				false
			);
		}
		expect(
			supabaseAgentOperationSchema.safeParse({
				operation: 'log',
				target: { stackId: checkout.id.slice(0, 8) },
				tail: 200,
				services: ['gateway'],
			}).success
		).toBe(true);
	});

	it('returns URLs and public keys only from env, never secrets', () => {
		const env = {
			API_URL: 'http://127.0.0.1:21734',
			PUBLISHABLE_KEY: 'sb_publishable_EXAMPLEKEY000',
		};
		expect(supabaseAgentEnvSchema.parse(env)).toEqual(env);
		for (const leak of [
			'SECRET_KEY',
			'SERVICE_ROLE_KEY',
			'DB_URL',
			'MCP_URL',
		]) {
			expect(
				supabaseAgentEnvSchema.safeParse({ ...env, [leak]: 'x' }).success
			).toBe(false);
		}
		const stack = {
			id: checkout.id,
			status: 'ready',
			origin: 'managed',
			mode: 'managed',
			runtime: 'native',
			exposure: 'loopback',
			apiPort: 21_734,
			laneIds: [],
			holders: [],
			yours: true,
		};
		const up = {
			operation: 'up',
			stack,
			appEnv: ['EXPO_PUBLIC_SUPABASE_URL'],
			metro: 'no-lane',
			next: 'Use the worktree CLI with --local.',
			warnings: [],
		};
		expect(supabaseAgentResultSchema.safeParse(up).success).toBe(true);
		expect(
			supabaseAgentResultSchema.safeParse({
				...up,
				stack: { ...stack, apiUrl: 'http://127.0.0.1:21734' },
			}).success
		).toBe(false);
		expect(
			supabaseAgentResultSchema.safeParse({
				operation: 'env',
				stackId: checkout.id,
				env: { ...env, SECRET_KEY: 'x' },
			}).success
		).toBe(false);
	});

	it('maps parsed commands onto operations with the defaults', () => {
		const worktreePath = '/Users/dev/app-wt/feat-x';
		expect(
			supabaseAgentOperationFromCommand({ operation: 'up', worktreePath })
		).toEqual({
			ok: true,
			operation: { operation: 'up', target: { worktreePath }, waitMs: 30_000 },
		});
		expect(
			supabaseAgentOperationFromCommand({
				operation: 'reset',
				stackId: checkout.id.slice(0, 8),
			})
		).toEqual({
			ok: true,
			operation: {
				operation: 'reset',
				target: { stackId: checkout.id.slice(0, 8) },
				seed: true,
			},
		});
		expect(
			supabaseAgentOperationFromCommand({
				operation: 'log',
				worktreePath,
				services: ['gateway'],
				since: '10m',
			})
		).toEqual({
			ok: true,
			operation: {
				operation: 'log',
				target: { worktreePath },
				tail: 200,
				services: ['gateway'],
				since: '10m',
			},
		});
		expect(supabaseAgentOperationFromCommand({ operation: 'ls' })).toEqual({
			ok: true,
			operation: { operation: 'ls' },
		});
		expect(
			supabaseAgentOperationFromCommand({
				operation: 'down',
				worktreePath,
				stackId: checkout.id,
			})
		).toEqual({
			ok: false,
			message: 'down takes exactly one of a worktree path or a stack id.',
		});
		expect(
			supabaseAgentOperationFromCommand({
				operation: 'ls',
				stackId: checkout.id,
			})
		).toEqual({ ok: false, message: 'ls takes at most a worktree path.' });
		expect(
			supabaseAgentOperationFromCommand({
				operation: 'up',
				worktreePath,
				waitMs: 90_000,
			})
		).toEqual({ ok: false, message: 'Invalid waitMs for supabase up.' });
	});

	it('lists every agent operation', () => {
		expect(
			supabaseAgentOperationSchema.options.map(
				(option) => option.shape.operation.value
			)
		).toEqual([...SUPABASE_AGENT_OPERATIONS]);
	});

	it('names the self-start fallback when RN Devtools is not managing', () => {
		expect(
			supabaseAgentRecovery('supabase_disabled', 'pnpm exec supabase')
		).toBe(
			'RN Devtools is not managing this worktree. Start it yourself from the worktree with `pnpm exec supabase start --runtime native` (never without --runtime native).'
		);
		expect(supabaseAgentRecovery('cli_mismatch')).toMatch(/Never destroy/);
		// Reverting keeps the stack; an up tries the start again.
		expect(supabaseAgentRecovery('needs_recreate')).toMatch(
			/revert that setting and call supabase with operation up again/
		);
	});

	it('computes local stats from activity, warm starts only for percentiles', () => {
		const stats = supabaseActivityStats([
			...demo.activity,
			{
				id: 'a-fail',
				kind: 'create',
				stackIds: [],
				outcome: 'failed',
				errorCode: 'ports_pinned',
				startedAt: now,
				durationMs: 800,
				requestedBy: 'lane',
			},
		]);
		expect(stats).toEqual({
			starts: 4,
			failures: 1,
			failuresByCode: { ports_pinned: 1 },
			p50Ms: 1_000,
			p95Ms: 4_500,
		});
		expect(supabaseActivityStats([])).toEqual({
			starts: 0,
			failures: 0,
			failuresByCode: {},
		});
		expect(
			supabaseDoctorInfoSchema.safeParse({
				enabled: true,
				capability: 'ready',
				platform: demo.availability.platform,
				repositories: [],
				running: 3,
				cap: 12,
				sysv: { used: 6, limit: 32 },
				containerEngine: demo.engines,
				stats,
				warnings: [],
			}).success
		).toBe(true);
	});
});

describe('stackStatus (status model A)', () => {
	const running = checkout;
	const mismatch = {
		ownerRelease: '0.1.0+8b6cc1ef8a8469e7',
		clientRelease: '0.1.0+a559977f2134f3a5',
	};
	const cases: readonly [
		string,
		SupabaseStackSummary,
		readonly SupabaseJob[],
		ReturnType<typeof stackStatus>['key'],
		string,
		ReturnType<typeof stackStatus>['tone'],
		ReturnType<typeof stackStatus>['icon'],
	][] = [
		[
			'a desktop job beats exposure',
			stackWith(running, { runtime: 'docker', activeJobId: job().id }),
			[job()],
			'in-flight',
			'Starting…',
			'info',
			'loader-circle',
		],
		[
			'a queued job',
			stackWith(running, { activeJobId: job().id }),
			[job({ status: 'queued', kind: 'create' })],
			'queued',
			'Queued',
			'info',
			'loader-circle',
		],
		[
			'a finished job is ignored',
			stackWith(running, { activeJobId: job().id }),
			[job({ status: 'complete' })],
			'running-idle',
			'Running · idle',
			'success',
			'status-dot-moon',
		],
		[
			'LAN exposure beats a failed start',
			stackWith(running, { runtime: 'podman', state: 'failed' }),
			[],
			'lan-exposed',
			'LAN-exposed',
			'danger',
			'shield-alert',
		],
		[
			'unknown exposure beats a failed start',
			stackWith(stopped, {
				state: 'failed',
				exposure: { verdict: 'unknown' },
			}),
			[],
			'exposure-unknown',
			'Exposure unknown',
			'danger',
			'shield-alert',
		],
		[
			'a failed start beats a CLI mismatch',
			stackWith(stopped, {
				state: 'failed',
				cli: { ...stopped.cli, mismatch },
			}),
			[],
			'failed',
			'Failed to start',
			'danger',
			'circle-x',
		],
		[
			'interrupted',
			stackWith(stopped, { state: 'interrupted' }),
			[],
			'interrupted',
			'Interrupted',
			'danger',
			'circle-x',
		],
		[
			'needs recreate',
			stackWith(stopped, { state: 'needs-recreate' }),
			[],
			'needs-recreate',
			'Needs recreate',
			'danger',
			'circle-x',
		],
		[
			'unhealthy beats a CLI mismatch',
			stackWith(running, {
				state: 'unhealthy',
				health: {
					...running.health,
					unhealthy: 1,
					unhealthyServices: ['rest'],
				},
				cli: { ...running.cli, mismatch },
			}),
			[],
			'unhealthy',
			'Unhealthy',
			'danger',
			'circle-x',
		],
		[
			'a running stack with an unhealthy member',
			stackWith(running, {
				health: {
					...running.health,
					unhealthy: 1,
					unhealthyServices: ['auth'],
				},
			}),
			[],
			'unhealthy',
			'Unhealthy',
			'danger',
			'circle-x',
		],
		[
			'unreadable',
			demoStack(ids.unreadable),
			[],
			'unreadable',
			'Unreadable',
			'warning',
			'circle-alert',
		],
		[
			'a CLI mismatch beats an unresponsive owner',
			stackWith(running, {
				cli: { ...running.cli, mismatch },
				ownerLiveness: 'not-responding',
			}),
			[],
			'cli-mismatch',
			'CLI mismatch',
			'warning',
			'git-compare-arrows',
		],
		[
			'an unresponsive owner beats partly stopped',
			stackWith(running, { state: 'partial', ownerLiveness: 'not-responding' }),
			[],
			'not-responding',
			'Not responding',
			'warning',
			'server-off',
		],
		[
			'partly stopped',
			stackWith(running, { state: 'partial' }),
			[],
			'partial',
			'Partly stopped',
			'warning',
			'circle-alert',
		],
		[
			'starting outside RN Devtools',
			stackWith(stopped, { state: 'starting', ownerLiveness: 'starting' }),
			[],
			'starting-outside',
			'Starting (outside)',
			'info',
			'loader-circle',
		],
		[
			'stopping outside RN Devtools',
			stackWith(running, { state: 'stopping' }),
			[],
			'stopping-outside',
			'Stopping (outside)',
			'info',
			'loader-circle',
		],
		[
			'running with every service awake',
			stackWith(running, {
				health: { ...running.health, awake: 7, sleeping: 0 },
			}),
			[],
			'running',
			'Running',
			'success',
			'status-dot',
		],
		[
			'running with lazy services asleep',
			running,
			[],
			'running-idle',
			'Running · idle',
			'success',
			'status-dot-moon',
		],
		[
			'running by stack list alone',
			stackWith(running, { lifecycle: null }),
			[],
			'checking',
			'Checking…',
			'default',
			'refresh-cw',
		],
		[
			'running with an absent owner',
			stackWith(running, { ownerLiveness: 'absent' }),
			[],
			'checking',
			'Checking…',
			'default',
			'refresh-cw',
		],
		[
			'stopped outside while held',
			stackWith(stopped, { flags: ['stopped-outside'] }),
			[],
			'stopped-outside',
			'Stopped outside',
			'warning',
			'square',
		],
		['stopped', stopped, [], 'stopped', 'Stopped', 'default', 'square'],
		[
			'never started',
			stackWith(stopped, { state: 'never-started' }),
			[],
			'never-started',
			'Never started',
			'default',
			'circle-dashed',
		],
		[
			'not created',
			demoStack(ids.featOnboarding),
			[],
			'not-created',
			'Not created',
			'default',
			'hollow-dot',
		],
		[
			'unknown',
			stackWith(stopped, { state: 'unknown' }),
			[],
			'checking',
			'Checking…',
			'default',
			'refresh-cw',
		],
	];

	it.each(cases)('%s', (_name, stack, jobs, key, label, tone, icon) => {
		const status = stackStatus(stack, { jobs });
		expect(status).toMatchObject({ key, label, tone, icon });
		expect(status.explanation.length).toBeGreaterThan(0);
	});

	it('names the unhealthy services and uses the job verb', () => {
		expect(
			stackStatus(
				stackWith(running, {
					state: 'unhealthy',
					health: {
						...running.health,
						unhealthy: 2,
						unhealthyServices: ['rest', 'auth'],
					},
				})
			).explanation
		).toBe('rest, auth are unhealthy. Restart services.');
		expect(supabaseJobLabel({ kind: 'prepare', status: 'running' })).toBe(
			'Downloading…'
		);
		expect(supabaseJobLabel({ kind: 'reset', status: 'running' })).toBe(
			'Resetting…'
		);
		expect(
			stackStatus(demoStack(ids.fixAuthRedirect), { jobs: demo.jobs }).label
		).toBe('Starting…');
	});

	it('advises reverting a needs-recreate stack only when every change is editable', () => {
		expect(supabaseRevertKeepsStack([MAJOR_VERSION])).toBe(true);
		const revert =
			'The saved stack cannot adopt this configuration. Revert the change to keep it, or recreate it.';
		expect(stackStatus(needsRecreate([MAJOR_VERSION])).explanation).toBe(
			revert
		);
		// A retry that failed for another reason changes nothing here.
		expect(
			stackStatus(retriedOtherwise(needsRecreate([MAJOR_VERSION]))).explanation
		).toBe(revert);
		for (const changes of [
			[POSTGRES_BUILD],
			[MAJOR_VERSION, POSTGRES_BUILD],
			[],
			undefined,
		]) {
			expect(supabaseRevertKeepsStack(changes)).toBe(false);
			expect(stackStatus(needsRecreate(changes)).explanation).toBe(
				'The saved stack cannot adopt this configuration. Recreate it.'
			);
		}
	});
});

describe('serviceStateLabel (status model D)', () => {
	it.each([
		[{ state: 'running', health: 'healthy' }, 'running · healthy', 'success'],
		[
			{ state: 'running', health: 'unhealthy' },
			'running · unhealthy',
			'danger',
		],
		[{ state: 'running', health: 'starting' }, 'running · starting', 'info'],
		[{ state: 'running', health: null }, 'running', 'info'],
		[{ state: 'starting' }, 'starting', 'info'],
		[{ state: 'stopping' }, 'stopping', 'info'],
		[
			{ state: 'sleeping', wakeHintMs: 400 },
			'sleeping · starts on first request (~0.4 s)',
			'default',
		],
		[
			{ state: 'sleeping', wakeHintMs: 18_000 },
			'sleeping · starts on first request (~18 s)',
			'default',
		],
		[{ state: 'sleeping' }, 'sleeping · starts on first request', 'default'],
		[{ state: 'stopped' }, 'stopped', 'default'],
		[{ state: 'unavailable' }, 'unavailable', 'default'],
		[{ state: 'excluded' }, 'excluded', 'default'],
		[{ state: 'unhealthy' }, 'unhealthy', 'danger'],
		[{ state: 'exited' }, 'exited', 'danger'],
	] as const)('labels %o', (member, label, tone) => {
		const result = serviceStateLabel(member);
		expect(result).toMatchObject({ label, tone });
		expect(result.icon).toBe(member.state === 'sleeping' ? 'moon' : undefined);
	});
});

describe('laneBackendChip (status model E)', () => {
	const summary = (
		status: LaneBackendSummary['status'],
		extra: Partial<LaneBackendSummary> = {}
	): LaneBackendSummary => ({
		policy: 'auto',
		status,
		appEnvNames: [],
		warnings: [],
		...extra,
	});
	it.each([
		[
			summary('ready', { apiUrl: 'http://127.0.0.1:21734' }),
			'db :21734',
			'success',
		],
		[summary('ready'), 'db ready', 'success'],
		[summary('starting'), 'db starting', 'warning'],
		[summary('stopped'), 'db stopped', 'warning'],
		[summary('stale'), 'db stale', 'warning'],
		[summary('shadowed'), 'db shadowed', 'warning'],
		[
			summary('blocked', { reason: 'ports-pinned' }),
			'db blocked · ports pinned',
			'warning',
		],
		[
			summary('skipped', { reason: 'capacity' }),
			'db skipped · capacity',
			'warning',
		],
		[summary('skipped', { reason: 'git-busy' }), 'db skipped', 'warning'],
		[summary('failed'), 'db failed', 'warning'],
		[
			summary('refused', { reason: 'lan-exposed' }),
			'db refused · LAN',
			'danger',
		],
	])('shows %o as %s', (value, label, tone) => {
		expect(laneBackendChip(value)).toEqual({ label, tone });
	});

	it('is hidden when the feature or the lane policy is off', () => {
		expect(laneBackendChip(undefined)).toBeUndefined();
		expect(
			laneBackendChip(summary('ready', { policy: 'off' }))
		).toBeUndefined();
		expect(
			laneBackendChip(summary('skipped', { reason: 'disabled' }))
		).toBeUndefined();
		expect(
			laneBackendChip(summary('skipped', { reason: 'off' }))
		).toBeUndefined();
	});
});

describe('lane start form', () => {
	it('suffixes worktrees and gates the Backend select', () => {
		const managed = { project: 'managed' } as const;
		const observed = {
			project: 'observed',
			reasonText: 'the stack flag is missing.',
		} as const;
		expect(laneWorktreeSupabaseSuffix(managed, true)).toBe('· Supabase');
		expect(laneWorktreeSupabaseSuffix(observed, true)).toBe(
			'· Supabase (needs opt-in)'
		);
		expect(
			laneWorktreeSupabaseSuffix(
				{ project: 'managed', portsPinned: true },
				true
			)
		).toBe('· Supabase (ports pinned)');
		expect(laneWorktreeSupabaseSuffix(managed, false)).toBeUndefined();
		expect(
			laneWorktreeSupabaseSuffix({ project: 'none' }, true)
		).toBeUndefined();
		expect(laneBackendSelectAvailability(managed, demo)).toEqual({
			allowed: true,
		});
		expect(laneBackendSelectAvailability(observed, demo)).toEqual({
			allowed: false,
			check: 'mode',
			reason: 'Observed only: the stack flag is missing.',
		});
		expect(laneBackendSelectAvailability(undefined, demo)).toEqual({
			allowed: false,
			check: 'mode',
			reason: 'This worktree has no Supabase project.',
		});
		expect(
			laneBackendSelectAvailability(managed, {
				...demo,
				feature: { enabled: false, policyHealth: 'ok' },
			})
		).toEqual({
			allowed: false,
			check: 'off',
			reason: 'Turn on local Supabase in the Supabase tab first.',
		});
	});

	it('defaults development lanes to auto and everything else to off', () => {
		expect(laneDefaultBackend(SUPABASE_POLICY_DEFAULTS, 'development')).toBe(
			'auto'
		);
		expect(laneDefaultBackend(SUPABASE_POLICY_DEFAULTS, 'staging')).toBe('off');
		expect(laneDefaultBackend(SUPABASE_POLICY_DEFAULTS, 'qa')).toBe('off');
	});
});

describe('visibleStackFlags', () => {
	it('shows at most two flags plus the always-shown ones, then +N', () => {
		expect(
			visibleStackFlags({
				flags: [
					'env-shadowed',
					'config-changed',
					'cli-changed',
					'stale-branch',
					'worktree-deleted',
					'transient',
					'stopped-outside',
				],
			})
		).toEqual({
			chips: [
				{
					flag: 'worktree-deleted',
					label: 'Worktree deleted',
					tone: 'warning',
				},
				{ flag: 'stale-branch', label: 'Stale branch', tone: 'warning' },
			],
			more: 3,
		});
		expect(
			visibleStackFlags({ flags: ['lan-exposed', 'not-opted-in'] }).chips
		).toEqual([
			{ flag: 'lan-exposed', label: 'LAN-exposed', tone: 'danger' },
			{ flag: 'not-opted-in', label: 'Not opted in', tone: 'default' },
		]);
	});
});

describe('attentionItems and sidebarBadge', () => {
	it('ranks the demo: danger, the request, warnings, then suggestions', () => {
		const items = attentionItems(demo, now);
		expect(items.map((item) => [item.rank, item.kind])).toEqual([
			['danger', 'lan-exposed'],
			['request', 'request'],
			['warning', 'stacks-need-attention'],
			['suggestion', 'stale-branch'],
			['suggestion', 'prune-suggested'],
		]);
		expect(items.map((item) => item.text)).toEqual([
			'1 stack listens on your network. It runs on Docker; RN Devtools stopped it once.',
			'Codex session 3c9e7a12 asks to destroy feat-old-ui (71 MB).',
			"1 stack needs attention: its state can't be read.",
			'1 stack belongs to a branch its worktree moved away from.',
			'3 stacks are suggested for clean up (179 MB). RN Devtools never deletes a database on its own.',
		]);
		expect(items[0]?.recovery).toEqual({
			kind: 'show-stacks',
			label: 'Show it',
			stackIds: [ids.legacyMain],
		});
		expect(items[1]?.recovery).toEqual({
			kind: 'review-request',
			label: 'Review',
			requestId: ids.requestOldUi,
		});
		expect(sidebarBadge(demo, now)).toEqual({
			value: 3,
			tone: 'danger',
			label: 'Supabase, 3 need attention',
		});
	});

	it('leaves stacks with an operation in flight out', () => {
		const failed = stackWith(stopped, {
			state: 'failed',
			activeJobId: job({ stackIds: [stopped.id] }).id,
			pruneGroup: undefined,
		});
		const state: SupabaseState = {
			...demo,
			stacks: [failed],
			requests: [],
			jobs: [job({ stackIds: [stopped.id] })],
			prune: { ...demo.prune, groups: [] },
		};
		expect(attentionItems(state, now)).toEqual([]);
		expect(
			attentionItems({ ...state, jobs: [] }, now).map((item) => item.text)
		).toEqual(['1 stack failed to start and left an empty stack.']);
	});

	it('advises reverting needs-recreate stacks only when every change is editable', () => {
		const textOf = (...stacks: SupabaseStackSummary[]) =>
			attentionItems(
				{
					...demo,
					stacks,
					requests: [],
					jobs: [],
					prune: { ...demo.prune, groups: [] },
				},
				now
			).find((item) => item.id === 'start-failed')?.text;
		const other = demoStack(ids.featGone);
		expect(textOf(needsRecreate([MAJOR_VERSION]))).toBe(
			"1 stack can't adopt its configuration: revert the change or recreate it."
		);
		expect(textOf(retriedOtherwise(needsRecreate([MAJOR_VERSION])))).toBe(
			"1 stack can't adopt its configuration: revert the change or recreate it."
		);
		expect(
			textOf(
				needsRecreate([MAJOR_VERSION]),
				needsRecreate([MAJOR_VERSION], other)
			)
		).toBe(
			"2 stacks can't adopt their configuration: revert the change or recreate them."
		);
		expect(textOf(needsRecreate([POSTGRES_BUILD]))).toBe(
			"1 stack can't adopt its configuration and must be recreated."
		);
		expect(
			textOf(
				needsRecreate(),
				needsRecreate([MAJOR_VERSION, POSTGRES_BUILD], other)
			)
		).toBe("2 stacks can't adopt their configuration and must be recreated.");
		expect(
			textOf(
				needsRecreate([MAJOR_VERSION]),
				needsRecreate([POSTGRES_BUILD], other)
			)
		).toBe("2 stacks can't adopt their configuration.");
	});

	it('aggregates warnings into one item with a breakdown', () => {
		const mismatch = {
			ownerRelease: '0.1.0+8b6cc1ef8a8469e7',
			clientRelease: '0.1.0+a559977f2134f3a5',
		};
		const state: SupabaseState = {
			...demo,
			requests: [],
			prune: { ...demo.prune, groups: [] },
			stacks: [
				stackWith(checkout, { cli: { ...checkout.cli, mismatch } }),
				stackWith(demoStack(ids.featPayments), {
					ownerLiveness: 'not-responding',
				}),
				stackWith(demoStack(ids.main), { state: 'partial' }),
				stackWith(stopped, { state: 'interrupted', pruneGroup: undefined }),
				stackWith(demoStack(ids.featGone), { state: 'needs-recreate' }),
			],
		};
		expect(attentionItems(state, now).map((item) => item.text)).toEqual([
			"2 stacks can't start: 1 was interrupted, 1 can't adopt its configuration.",
			"3 stacks need attention: 1 is partly stopped, 1 runs another CLI release, 1 isn't responding.",
		]);
		expect(sidebarBadge(state, now)?.tone).toBe('danger');
	});

	it('reports capacity, paused clocks, other homes and refresh failures', () => {
		const state: SupabaseState = {
			...demo,
			stacks: [checkout],
			requests: [],
			prune: { ...demo.prune, groups: [] },
			capacity: { ...demo.capacity, running: 12, cap: 12 },
			discovery: {
				...demo.discovery,
				sessions: 'unavailable',
				listFailure: { message: 'stack list timed out', at: now },
			},
			home: { label: '~/.supabase', foreign: ['~/alt/.supabase'] },
		};
		const items = attentionItems(state, now);
		expect(items.map((item) => item.kind)).toEqual([
			'state-unreadable',
			'capacity-full',
			'clocks-paused',
			'other-supabase-home',
		]);
		expect(items[1]?.text).toBe(
			'12 of 12 stacks are running and all are in use.'
		);
		expect(sidebarBadge(state, now)).toEqual({
			value: 4,
			tone: 'danger',
			label: 'Supabase, 4 need attention',
		});
	});

	it('shows only a quarantined policy while off, and no badge', () => {
		const off: SupabaseState = {
			...demo,
			feature: { enabled: false, policyHealth: 'quarantined' },
		};
		expect(attentionItems(off, now).map((item) => item.kind)).toEqual([
			'policy-quarantined',
		]);
		expect(sidebarBadge(off, now)).toBeUndefined();
	});

	it('falls back to a grey running count, and hides while discovery is off', () => {
		const calm: SupabaseState = {
			...demo,
			stacks: [checkout],
			requests: [],
			prune: { ...demo.prune, groups: [] },
		};
		expect(attentionItems(calm, now)).toEqual([]);
		expect(sidebarBadge(calm, now)).toEqual({
			value: demo.capacity.running,
			tone: 'default',
			label: `Supabase, ${demo.capacity.running} running`,
		});
		expect(
			sidebarBadge(
				{ ...demo, discovery: { ...demo.discovery, status: 'off' } },
				now
			)
		).toBeUndefined();
		const warnOnly: SupabaseState = {
			...calm,
			stacks: [stackWith(checkout, { state: 'partial' })],
		};
		expect(sidebarBadge(warnOnly, now)).toEqual({
			value: 1,
			tone: 'warning',
			label: 'Supabase, 1 needs attention',
		});
		expect(attentionItems(warnOnly, now)[0]?.text).toBe(
			'1 stack needs attention: it is partly stopped.'
		);
	});
});

describe('nextEvents', () => {
	const policy = SUPABASE_POLICY_DEFAULTS;

	it('explains who keeps a held stack running', () => {
		expect(nextEvents(checkout, policy, now)).toEqual([
			{
				kind: 'held',
				tone: 'default',
				icon: 'user',
				text: 'Keeps running while Claude 7f3a2c91 is live. 60 s after the last release it stops; data is kept. Never deleted on its own.',
				actions: [],
			},
		]);
		expect(nextEvents(demoStack(ids.featPayments), policy, now)[0]?.text).toBe(
			'Keeps running while Codex · by worktree is live. 60 s after the last release it stops; data is kept. Never deleted on its own.'
		);
		expect(nextEvents(demoStack(ids.main), policy, now)).toEqual([
			{
				kind: 'pinned',
				tone: 'default',
				icon: 'pin',
				text: 'Pinned by you · never stopped automatically',
				actions: ['unpin'],
			},
		]);
	});

	it('counts down an automatic stop, amber and with Keep running', () => {
		const unheld = stackWith(checkout, {
			holds: [],
			autoStopAt: now + 45_000,
			autoStopReason: 'released',
		});
		expect(nextEvents(unheld, policy, now)).toEqual([
			{
				kind: 'auto-stop',
				at: now + 45_000,
				tone: 'warning',
				icon: 'timer',
				text: 'Stops in 45 s · data kept',
				actions: ['keep-running'],
			},
		]);
		const abandoned = stackWith(checkout, {
			holds: (checkout.holds ?? []).filter((hold) => !hold.live),
			lanes: [],
			autoStopAt: now + 7 * 60_000,
			autoStopReason: 'abandoned',
		});
		expect(nextEvents(abandoned, policy, now)[0]).toMatchObject({
			kind: 'abandoned',
			text: 'Codex 5d1b8f40 is gone; stops in 7 min',
			actions: ['keep-running', 'stop'],
		});
		const noClock = stackWith(abandoned, {
			autoStopAt: undefined,
			autoStopReason: undefined,
		});
		expect(nextEvents(noClock, policy, now)[0]?.text).toBe(
			'Codex 5d1b8f40 is gone; stops in 7 min'
		);
		expect(
			nextEvents(noClock, policy, now, { clocksPaused: true }).map(
				(event) => event.kind
			)
		).toEqual(['clocks-paused']);
	});

	it('keeps the prune suggestion muted, separate and never automatic', () => {
		expect(nextEvents(stopped, policy, now)).toEqual([
			{
				kind: 'prune',
				at: stopped.pruneSuggestedAt,
				tone: 'muted',
				icon: 'calendar-clock',
				text: 'Suggested for clean up · never automatic',
				actions: [],
			},
		]);
		const later = stackWith(stopped, {
			pruneGroup: undefined,
			pruneSuggestedAt: now + 14 * 86_400_000,
		});
		expect(nextEvents(later, policy, now)[0]?.text).toBe(
			'Prune suggested in 14 days if still stopped · never automatic'
		);
		expect(
			nextEvents(
				stackWith(checkout, {
					pruneSuggestedAt: now + 1,
					pruneGroup: 'retention',
				}),
				policy,
				now
			).some((event) => event.kind === 'prune')
		).toBe(false);
	});

	it('says external stacks are never stopped automatically', () => {
		const external = stackWith(checkout, {
			origin: 'external',
			holds: [],
			lanes: [],
		});
		expect(
			nextEvents(external, policy, now).map((event) => event.kind)
		).toEqual(['never-automatic']);
	});
});

describe('supabaseActionAvailability', () => {
	const allowed = { allowed: true };
	const refused = (check: string, reason: string) => ({
		allowed: false,
		check,
		reason,
	});

	it('checks bridge, off, platform and in flight first', () => {
		const stack = stackWith(checkout, { activeJobId: job().id });
		const state = { jobs: [job()] };
		expect(
			supabaseActionAvailability(
				stack,
				'stop',
				context({ bridgeAvailable: false }, state)
			)
		).toEqual(refused('bridge', SUPABASE_REASONS.bridge));
		expect(
			supabaseActionAvailability(
				stack,
				'stop',
				context(
					{},
					{ ...state, feature: { enabled: false, policyHealth: 'ok' } }
				)
			)
		).toEqual(refused('off', 'Turn on local Supabase first.'));
		expect(
			supabaseActionAvailability(
				stack,
				'stop',
				context(
					{},
					{
						...state,
						availability: {
							platform: { supported: false, arch: 'x64', macosVersion: '13.6' },
						},
					}
				)
			)
		).toEqual(
			refused('platform', 'Needs Apple silicon and macOS 14 or later.')
		);
		expect(
			supabaseActionAvailability(stack, 'stop', context({}, state))
		).toEqual(
			refused('in-flight', 'Another operation is running on this stack.')
		);
		expect(
			supabaseActionAvailability(
				stack,
				'stop',
				context({}, { jobs: [job({ kind: 'stop' })] })
			)
		).toEqual(refused('in-flight', 'Stopping…'));
		expect(
			supabaseActionAvailability(
				checkout,
				'restart',
				context({ pending: true })
			)
		).toEqual(
			refused('in-flight', 'Another operation is running on this stack.')
		);
		expect(
			supabaseActionAvailability(stack, 'read-logs', context({}, state))
		).toEqual({ allowed: true });
	});

	it('cancels only a cancellable start in flight', () => {
		const stack = stackWith(checkout, { activeJobId: job().id });
		expect(
			supabaseActionAvailability(
				stack,
				'cancel-start',
				context({}, { jobs: [job()] })
			)
		).toEqual({ allowed: true });
		expect(
			supabaseActionAvailability(
				stack,
				'cancel-start',
				context({}, { jobs: [job({ cancelRequested: true })] })
			)
		).toEqual(
			refused('in-flight', 'Cancelling… the CLI is cleaning up (up to 45 s).')
		);
		expect(
			supabaseActionAvailability(checkout, 'cancel-start', context())
		).toEqual(refused('in-flight', 'Nothing is starting on this stack.'));
	});

	it('refuses by mode or CLI gate before anything else about the stack', () => {
		const observed = stackWith(stopped, {
			mode: {
				value: 'observed',
				reasonText: "Supabase CLI 2.122.0 isn't verified.",
			},
			cli: {
				...stopped.cli,
				gate: 'compatible',
				mismatch: { ownerRelease: 'a', clientRelease: 'b' },
			},
			runtime: 'docker',
			currentHead: { ref: 'refs/heads/other' },
		});
		expect(supabaseActionAvailability(observed, 'resume', context())).toEqual(
			refused('mode', "Observed only: Supabase CLI 2.122.0 isn't verified.")
		);
		expect(
			supabaseActionAvailability(
				stackWith(checkout, {
					mode: { value: 'observed' },
					cli: { ...checkout.cli, gate: 'compatible' },
				}),
				'stop-and-start',
				context()
			)
		).toEqual(refused('mode', SUPABASE_REASONS.cliUnverified));
		expect(
			supabaseActionAvailability(
				stackWith(checkout, { origin: 'external' }),
				'restart',
				context()
			)
		).toEqual(
			refused('mode', "RN Devtools didn't start this stack. Adopt it first.")
		);
		expect(
			supabaseActionAvailability(
				stackWith(stopped, { mode: { value: 'off' } }),
				'resume',
				context()
			)
		).toEqual(
			refused(
				'mode',
				'Local Supabase is off for this repository. Set it to Auto in Repositories.'
			)
		);
		expect(
			supabaseActionAvailability(
				stackWith(demoStack(ids.featOnboarding), {
					pinnedPort: {
						port: 54_321,
						key: 'api',
						holderLabel: '~/code/example-app-wt/spike-maps',
					},
				}),
				'start',
				context()
			)
		).toEqual(
			refused(
				'mode',
				'Port 54321 for api is pinned in supabase/config.toml and held by the stack for ~/code/example-app-wt/spike-maps.'
			)
		);
		expect(supabaseActionAvailability(observed, 'stop', context())).toEqual(
			refused('state', 'It is already stopped.')
		);
		expect(supabaseActionAvailability(observed, 'destroy', context())).toEqual(
			allowed
		);
	});

	it('refuses by release mismatch, then HEAD, then exposure', () => {
		const mismatch = { ownerRelease: 'a', clientRelease: 'b' };
		expect(
			supabaseActionAvailability(
				stackWith(checkout, { cli: { ...checkout.cli, mismatch } }),
				'restart',
				context()
			)
		).toEqual(refused('release', SUPABASE_REASONS.mismatchRestart));
		const stale = demoStack(ids.featOldUi);
		expect(supabaseActionAvailability(stale, 'resume', context())).toEqual(
			refused(
				'head',
				"The worktree is on feat-nav-v2. Starting this stack would load feat-nav-v2's settings. Switch back to feat-old-ui first."
			)
		);
		expect(supabaseActionAvailability(stale, 'reset', context())).toEqual(
			refused(
				'head',
				'The worktree is on feat-nav-v2. Switch back to feat-old-ui to change this database.'
			)
		);
		expect(
			supabaseActionAvailability(
				stackWith(stale, { state: 'interrupted' }),
				'recreate',
				context()
			)
		).toEqual(
			refused(
				'head',
				'The worktree is on feat-nav-v2, so a new stack would belong to feat-nav-v2. Switch back to feat-old-ui first.'
			)
		);
		expect(
			supabaseActionAvailability(
				stackWith(checkout, { currentHead: { ref: 'detached' } }),
				'migration-status',
				context()
			)
		).toEqual(
			refused(
				'head',
				"Migration status can't be worked out while the worktree is on a detached HEAD; its migration files belong to that branch."
			)
		);
		expect(supabaseActionAvailability(stale, 'restart', context())).toEqual(
			refused('state', 'Start the stack first.')
		);
		expect(
			supabaseActionAvailability(stale, 'resume-saved', context())
		).toEqual({ allowed: true });
		expect(
			supabaseActionAvailability(stopped, 'resume-saved', context())
		).toEqual(refused('head', SUPABASE_REASONS.notStale));
		expect(
			supabaseActionAvailability(demoStack(ids.featGone), 'resume', context())
		).toEqual(refused('head', SUPABASE_REASONS.worktreeDeleted));
		const docker = stackWith(stopped, { runtime: 'docker' });
		expect(supabaseActionAvailability(docker, 'resume', context())).toEqual(
			refused('exposure', SUPABASE_REASONS.containerResume)
		);
		expect(
			supabaseActionAvailability(
				stackWith(demoStack(ids.featOnboarding), { runtime: 'podman' }),
				'start',
				context()
			)
		).toEqual(
			refused(
				'exposure',
				"A Podman stack already uses this worktree's identity. Destroy it first; RN Devtools never attaches container stacks."
			)
		);
		expect(supabaseActionAvailability(docker, 'recreate', context())).toEqual(
			allowed
		);
		const externalDocker = stackWith(docker, { origin: 'external' });
		expect(
			supabaseActionAvailability(externalDocker, 'recreate', context())
		).toEqual({ allowed: true });
		expect(
			supabaseActionAvailability(externalDocker, 'resume', context())
		).toEqual(
			refused('mode', "RN Devtools didn't start this stack. Adopt it first.")
		);
		expect(
			supabaseActionAvailability(
				stackWith(externalDocker, { mode: { value: 'observed' } }),
				'recreate',
				context()
			)
		).toEqual(
			refused(
				'mode',
				'Observed only: RN Devtools does not manage this worktree.'
			)
		);
	});

	it('gates adoption on tracking, release, branch and runtime', () => {
		const external = stackWith(stopped, { origin: 'external' });
		expect(supabaseActionAvailability(external, 'adopt', context())).toEqual(
			allowed
		);
		expect(
			supabaseActionAvailability(
				stackWith(external, { repositoryId: undefined }),
				'adopt',
				context()
			)
		).toEqual(refused('mode', SUPABASE_REASONS.trackRepository));
		expect(
			supabaseActionAvailability(
				stackWith(external, {
					cli: {
						...external.cli,
						mismatch: { ownerRelease: 'a', clientRelease: 'b' },
					},
				}),
				'adopt',
				context()
			)
		).toEqual(refused('release', SUPABASE_REASONS.mismatchAdopt));
		expect(
			supabaseActionAvailability(
				stackWith(external, { currentHead: { ref: 'refs/heads/main' } }),
				'adopt',
				context()
			)
		).toEqual(
			refused(
				'head',
				"Its branch (feat-search) isn't checked out in that worktree anymore."
			)
		);
		expect(
			supabaseActionAvailability(
				stackWith(external, { runtime: 'docker' }),
				'adopt',
				context()
			)
		).toEqual(refused('exposure', SUPABASE_REASONS.containerAdopt));
		expect(supabaseActionAvailability(checkout, 'adopt', context())).toEqual(
			refused('mode', SUPABASE_REASONS.alreadyManaged)
		);
		expect(
			supabaseActionAvailability(
				demoStack(ids.featOnboarding),
				'adopt',
				context()
			)
		).toEqual(refused('state', SUPABASE_REASONS.notCreated));
	});

	it('refuses by holder before state, and by capacity before state', () => {
		expect(supabaseActionAvailability(checkout, 'destroy', context())).toEqual(
			refused(
				'holder',
				'Lane :8102 is attached and running. Stop the lane in Lanes first.'
			)
		);
		expect(
			supabaseActionAvailability(
				demoStack(ids.featPayments),
				'destroy',
				context()
			)
		).toEqual(
			refused('state', 'Stop it first. Destroy runs only on a stopped stack.')
		);
		expect(
			supabaseActionAvailability(demoStack(ids.main), 'reset', context())
		).toEqual(
			refused('holder', 'Pinned stacks are protected. Unpin it first.')
		);
		expect(supabaseActionAvailability(stopped, 'destroy', context())).toEqual(
			allowed
		);
		const full = { capacity: { ...demo.capacity, running: 12, cap: 12 } };
		expect(
			supabaseActionAvailability(stopped, 'resume', context({}, full))
		).toEqual(
			refused(
				'capacity',
				'12 of 12 stacks are running and all are in use. Stop one, or raise the limit in Settings.'
			)
		);
		expect(
			supabaseActionAvailability(
				stopped,
				'resume',
				context(
					{},
					{ capacity: { ...full.capacity, nextToStopId: ids.featPayments } }
				)
			)
		).toEqual({ allowed: true });
		expect(
			supabaseActionAvailability(
				stopped,
				'resume',
				context(
					{},
					{ capacity: { ...demo.capacity, sysv: { used: 31, limit: 32 } } }
				)
			)
		).toEqual(
			refused(
				'capacity',
				'Only 1 Postgres slot is free; a start needs 2. Stop an idle stack first.'
			)
		);
		expect(
			supabaseActionAvailability(
				stopped,
				'resume',
				context(
					{},
					{ capacity: { ...demo.capacity, memoryPressure: 'critical' } }
				)
			)
		).toEqual(
			refused(
				'capacity',
				'Memory pressure is critical. Stop stacks or Simulators first.'
			)
		);
		expect(
			supabaseActionAvailability(
				checkout,
				'enable-studio',
				context(
					{},
					{ capacity: { ...demo.capacity, memoryPressure: 'critical' } }
				)
			)
		).toEqual(
			refused(
				'capacity',
				'Memory pressure is critical; Studio needs about 1-2 GB.'
			)
		);
	});

	const stateCases: readonly [
		string,
		SupabaseStackSummary,
		SupabaseStackAction,
		string | undefined,
	][] = [
		[
			'destroy an unreadable stack',
			demoStack(ids.unreadable),
			'destroy',
			SUPABASE_REASONS.unreadableDestroy,
		],
		[
			'reveal an unreadable stack',
			demoStack(ids.unreadable),
			'reveal',
			undefined,
		],
		[
			'reveal a vanished folder',
			stackWith(demoStack(ids.unreadable), { stackFolderExists: false }),
			'reveal',
			'The folder is gone.',
		],
		[
			'start an unreadable stack',
			demoStack(ids.unreadable),
			'start',
			SUPABASE_REASONS.unreadable,
		],
		[
			'resume a stack that needs recreating',
			needsRecreate([MAJOR_VERSION]),
			'resume',
			'[db] major_version changed from 15 to 17. Revert it to keep this stack, or recreate it.',
		],
		[
			'resume it once a retry failed for another reason',
			retriedOtherwise(needsRecreate([MAJOR_VERSION])),
			'resume',
			'[db] major_version changed from 15 to 17. Revert it to keep this stack, or recreate it.',
		],
		[
			'resume a stack whose Postgres build changed',
			needsRecreate([POSTGRES_BUILD]),
			'resume',
			'This stack must be recreated: Postgres build changed from 17.4.1 to 17.6.1.',
		],
		[
			'start a stack whose changes are not all editable',
			needsRecreate([MAJOR_VERSION, POSTGRES_BUILD]),
			'start',
			'This stack must be recreated: Postgres build changed from 17.4.1 to 17.6.1.',
		],
		[
			'resume an interrupted stack',
			stackWith(stopped, { state: 'interrupted' }),
			'resume',
			SUPABASE_REASONS.interrupted,
		],
		[
			'start a stack that runs',
			checkout,
			'start',
			SUPABASE_REASONS.alreadyRunning,
		],
		[
			'start a failed stack',
			stackWith(stopped, { state: 'failed' }),
			'start',
			undefined,
		],
		[
			'pin a pinned stack',
			demoStack(ids.main),
			'pin',
			SUPABASE_REASONS.alreadyPinned,
		],
		['unpin a pinned stack', demoStack(ids.main), 'unpin', undefined],
		[
			'reset a stopped stack',
			stopped,
			'reset',
			SUPABASE_REASONS.notRunningReset,
		],
		[
			'read a stopped database',
			stopped,
			'read-database',
			SUPABASE_REASONS.notRunningDatabase,
		],
		[
			'read logs before any start',
			demoStack(ids.featOnboarding),
			'read-logs',
			SUPABASE_REASONS.noLogs,
		],
		['read logs of a stopped stack', stopped, 'read-logs', undefined],
		[
			'auto-refresh logs while stopped',
			stopped,
			'logs-auto-refresh',
			SUPABASE_REASONS.autoRefresh,
		],
		[
			'copy an unknown key',
			demoStack(ids.featOnboarding),
			'copy-key',
			SUPABASE_REASONS.keyUnknown,
		],
		[
			'copy the psql command while stopped',
			stopped,
			'copy-psql',
			SUPABASE_REASONS.databaseAddressUnknown,
		],
		['copy the psql command while running', checkout, 'copy-psql', undefined],
		[
			'copy app variables with none mapped',
			stackWith(checkout, { appEnvNames: [] }),
			'copy-app-env',
			SUPABASE_REASONS.noAppEnv,
		],
		[
			'copy the API URL before a first start',
			demoStack(ids.featOnboarding),
			'copy-api-url',
			SUPABASE_REASONS.apiUrlUnknown,
		],
		[
			'open Mailpit with mail excluded',
			stackWith(checkout, { excluded: ['studio', 'analytics', 'mail'] }),
			'open-mailpit',
			SUPABASE_REASONS.mailExcluded,
		],
		['open Mailpit', checkout, 'open-mailpit', undefined],
		[
			'open Studio while excluded',
			checkout,
			'open-studio',
			SUPABASE_REASONS.studioExcluded,
		],
		[
			'seed buckets with storage excluded',
			stackWith(checkout, { excluded: ['storage'] }),
			'seed-buckets',
			SUPABASE_REASONS.storageExcluded,
		],
		[
			'seed buckets with none configured',
			stackWith(checkout, { bucketsConfigured: false }),
			'seed-buckets',
			SUPABASE_REASONS.noBuckets,
		],
		[
			'export a stopped database',
			stopped,
			'export',
			SUPABASE_REASONS.notRunningExport,
		],
		[
			'enable Studio twice',
			stackWith(checkout, {
				studio: { included: true, operatorEnabled: true },
			}),
			'enable-studio',
			SUPABASE_REASONS.studioOn,
		],
		[
			'release with only a lane hold',
			demoStack(ids.fixAuthRedirect),
			'release',
			SUPABASE_REASONS.noReleasableHold,
		],
		['release an agent hold', checkout, 'release', undefined],
		[
			'restart Metro when it is current',
			checkout,
			'restart-metro',
			SUPABASE_REASONS.metroCurrent,
		],
		[
			'restart Metro with no lane',
			stopped,
			'restart-metro',
			SUPABASE_REASONS.noLane,
		],
		[
			'reapply exclusions with none drifted',
			checkout,
			'reapply-exclusions',
			SUPABASE_REASONS.exclusionsApplied,
		],
		[
			'switch CLI without a mismatch',
			checkout,
			'switch-cli',
			SUPABASE_REASONS.sameCli,
		],
		[
			'restart an unresponsive owner',
			stackWith(checkout, { ownerLiveness: 'not-responding' }),
			'restart',
			SUPABASE_REASONS.ownerUnreachable,
		],
		['stop a stopped stack', stopped, 'stop', SUPABASE_REASONS.alreadyStopped],
		[
			'stop an unresponsive owner',
			stackWith(stopped, { ownerLiveness: 'not-responding' }),
			'stop',
			undefined,
		],
	];

	it.each(stateCases)('%s', (_name, stack, action, reason) => {
		const result = supabaseActionAvailability(stack, action, context());
		expect(result).toEqual(
			reason === undefined
				? allowed
				: refused(expect.any(String) as unknown as string, reason)
		);
	});

	it('reads the migration controls from the last database read', () => {
		const comparable: Extract<SupabaseMigrationsView, { comparable: true }> = {
			comparable: true,
			state: 'pending',
			rows: [],
			total: 2,
			applied: 0,
			pending: ['2'],
			outOfOrder: [],
			missingLocal: [],
		};
		expect(
			supabaseActionAvailability(
				checkout,
				'apply-migrations',
				context({ migrations: comparable })
			)
		).toEqual({ allowed: true });
		expect(
			supabaseActionAvailability(
				checkout,
				'apply-migrations',
				context({
					migrations: { ...comparable, state: 'up-to-date', pending: [] },
				})
			)
		).toEqual(refused('state', 'No pending migrations.'));
		expect(
			supabaseActionAvailability(
				checkout,
				'apply-migrations',
				context({
					migrations: {
						...comparable,
						state: 'out-of-order',
						outOfOrder: ['20261001000000'],
					},
				})
			)
		).toEqual(
			refused(
				'state',
				'20261001000000 sorts before the last applied migration. Reset the database to apply it in order.'
			)
		);
		expect(
			supabaseActionAvailability(
				checkout,
				'apply-migrations',
				context({
					migrations: {
						...comparable,
						state: 'missing-local',
						missingLocal: ['1', '2'],
					},
				})
			)
		).toEqual(
			refused(
				'state',
				'2 applied migrations are missing from this branch. Switch to the branch that has them, or reset the database.'
			)
		);
	});

	it('follows a branch only once HEAD settled on another branch', () => {
		const stale = stackWith(demoStack(ids.featOldUi), {
			holds: [
				{
					holder: 'session',
					agent: {
						kind: 'claude',
						sessionId: ids.claudeCheckout,
						synthetic: false,
					},
					since: now - 60_000,
					live: true,
				},
			],
		});
		expect(
			supabaseActionAvailability(stale, 'follow-branch', context())
		).toEqual({ allowed: true });
		expect(
			supabaseActionAvailability(
				stackWith(stale, {
					currentHead: {
						ref: 'refs/heads/feat-nav-v2',
						gitOperation: 'rebase',
					},
				}),
				'follow-branch',
				context()
			)
		).toEqual(
			refused(
				'head',
				'A rebase is in progress in this worktree; following waits until it finishes.'
			)
		);
		expect(
			supabaseActionAvailability(
				stackWith(stale, {
					currentHead: {
						ref: 'refs/heads/feat-nav-v2',
						stableSince: now - 5_000,
					},
				}),
				'follow-branch',
				context()
			)
		).toEqual({ allowed: true });
		expect(
			supabaseActionAvailability(checkout, 'follow-branch', context())
		).toEqual(refused('head', 'The worktree is still on feat-checkout.'));
		expect(
			supabaseActionAvailability(
				demoStack(ids.featOldUi),
				'follow-branch',
				context()
			)
		).toEqual(refused('holder', SUPABASE_REASONS.notHeld));
	});
});

describe('global, repository, request and clean-up availability', () => {
	it('gates turning on and off', () => {
		const offState = {
			...demo,
			feature: { enabled: false, policyHealth: 'ok' as const },
		};
		expect(
			supabaseGlobalActionAvailability('turn-on', {
				bridgeAvailable: true,
				state: offState,
			})
		).toEqual({ allowed: true });
		expect(
			supabaseGlobalActionAvailability('turn-on', {
				bridgeAvailable: true,
				state: offState,
				pending: true,
			})
		).toEqual({ allowed: false, check: 'in-flight', reason: 'Turning on…' });
		// Off already, but a turn-off that stops managed stacks still runs.
		for (const waitingForStarts of [true, false]) {
			expect(
				supabaseGlobalActionAvailability('turn-on', {
					bridgeAvailable: true,
					state: {
						...offState,
						feature: {
							...offState.feature,
							disabling: { remaining: 2, total: 2, waitingForStarts },
						},
					},
				})
			).toEqual({
				allowed: false,
				check: 'in-flight',
				reason: 'Local Supabase is still turning off.',
			});
		}
		expect(
			supabaseGlobalActionAvailability('turn-off', {
				bridgeAvailable: true,
				state: {
					...demo,
					feature: {
						...demo.feature,
						disabling: { remaining: 1, total: 3, waitingForStarts: true },
					},
				},
			})
		).toEqual({
			allowed: false,
			check: 'in-flight',
			reason: 'Turning off… waiting for running starts to finish.',
		});
		expect(
			supabaseGlobalActionAvailability('choose-path', {
				bridgeAvailable: true,
				state: demo,
			})
		).toEqual({
			allowed: false,
			check: 'state',
			reason: 'Stop every managed stack before changing the Supabase home.',
		});
		expect(
			supabaseGlobalActionAvailability('refresh', {
				bridgeAvailable: false,
				state: demo,
			})
		).toEqual({
			allowed: false,
			check: 'bridge',
			reason: SUPABASE_REASONS.bridge,
		});
	});

	it('gates repository checks and pre-downloads', () => {
		const [app] = demo.repositories;
		if (!app) throw new Error('missing demo repository');
		const ctx = { bridgeAvailable: true, state: demo };
		expect(supabaseRepositoryActionAvailability(app, 'recheck', ctx)).toEqual({
			allowed: true,
		});
		expect(supabaseRepositoryActionAvailability(app, 'prepare', ctx)).toEqual({
			allowed: false,
			check: 'state',
			reason:
				'Services are already downloaded for Supabase CLI 2.121.0 (1.7 GB cache).',
		});
		expect(
			supabaseRepositoryActionAvailability(app, 'prepare', {
				...ctx,
				state: { ...demo, disk: { cacheState: 'cold' } },
			})
		).toEqual({ allowed: true });
		expect(
			supabaseRepositoryActionAvailability(
				{ ...app, counts: { ...app.counts, managed: 0 } },
				'prepare',
				{ ...ctx, state: { ...demo, disk: { cacheState: 'cold' } } }
			)
		).toEqual({
			allowed: false,
			check: 'mode',
			reason: 'No managed worktree in this repository yet.',
		});
		expect(
			supabaseRepositoryActionAvailability(app, 'recheck', {
				...ctx,
				state: { ...demo, feature: { enabled: false, policyHealth: 'ok' } },
			})
		).toEqual({
			allowed: false,
			check: 'off',
			reason: 'Turn on local Supabase first.',
		});
	});

	it('gates request cards', () => {
		const [request] = demo.requests;
		if (!request) throw new Error('missing demo request');
		const ctx = { bridgeAvailable: true, state: demo };
		expect(supabaseRequestActionAvailability(request, 'approve', ctx)).toEqual({
			allowed: true,
		});
		expect(
			supabaseRequestActionAvailability(
				{ ...request, status: 'settling' },
				'approve',
				ctx
			)
		).toEqual({
			allowed: false,
			check: 'in-flight',
			reason: 'This request is already being settled.',
		});
		expect(
			supabaseRequestActionAvailability(
				{
					...request,
					laneAttached: {
						laneId: ids.laneCheckout,
						port: 8_102,
						running: true,
						ownedByRequester: false,
					},
				},
				'approve',
				ctx
			)
		).toEqual({
			allowed: false,
			check: 'holder',
			reason:
				'Lane :8102 belongs to another session. Stop that lane first, or deny the request.',
		});
		expect(
			supabaseRequestActionAvailability(
				{ ...request, stackId: ids.unreadable },
				'approve',
				ctx
			)
		).toEqual({
			allowed: false,
			check: 'state',
			reason:
				"This CLI can't read the stack, so it can't destroy it. Deny the request.",
		});
		const capacity = { ...request, kind: 'start-capacity' as const };
		expect(supabaseRequestActionAvailability(capacity, 'approve', ctx)).toEqual(
			{
				allowed: false,
				check: 'state',
				reason: 'Choose a stack to stop.',
			}
		);
		expect(
			supabaseRequestActionAvailability(
				{ ...capacity, branchMovedTo: 'feat-x' },
				'approve',
				ctx
			)
		).toEqual({
			allowed: false,
			check: 'head',
			reason: 'The worktree moved to feat-x since the request. Dismiss it.',
		});
		expect(supabaseRequestActionAvailability(request, 'deny', ctx)).toEqual({
			allowed: true,
		});
	});

	it('gates clean up on a fresh, non-empty selection', () => {
		const ctx = { bridgeAvailable: true, state: demo };
		expect(
			supabaseCleanUpAvailability(
				{ stackIds: [], revision: demo.prune.revision },
				ctx
			)
		).toEqual({
			allowed: false,
			check: 'state',
			reason: 'Select at least one stack.',
		});
		expect(
			supabaseCleanUpAvailability(
				{ stackIds: [ids.featGone], revision: demo.prune.revision - 1 },
				ctx
			)
		).toEqual({
			allowed: false,
			check: 'state',
			reason: 'The list changed. Review the selection again.',
		});
		expect(
			supabaseCleanUpAvailability(
				{ stackIds: [ids.featGone], revision: demo.prune.revision },
				ctx
			)
		).toEqual({ allowed: true });
	});
});

describe('operations against the rules', () => {
	const op = (fields: Record<string, unknown>): SupabaseOperation =>
		supabaseOperationSchema.parse({ actionId: ACTION, ...fields });

	it('resolves start to create or resume', () => {
		expect(
			supabaseOperationActions(
				op({ kind: 'start', stackId: ids.featOnboarding }),
				demo.stacks
			)
		).toEqual([{ stackId: ids.featOnboarding, action: 'start' }]);
		expect(
			supabaseOperationActions(
				op({ kind: 'start', stackId: ids.featSearch }),
				demo.stacks
			)
		).toEqual([{ stackId: ids.featSearch, action: 'resume' }]);
		expect(
			supabaseOperationActions(
				op({ kind: 'copy', stackId: ids.featCheckout, what: 'psql-command' }),
				demo.stacks
			)
		).toEqual([{ stackId: ids.featCheckout, action: 'copy-psql' }]);
		expect(
			supabaseOperationActions(op({ kind: 'refresh' }), demo.stacks)
		).toEqual([]);
	});

	it('refuses with typed desktop errors', () => {
		const ctx = { bridgeAvailable: true, now };
		expect(
			checkSupabaseOperation(
				op({
					kind: 'destroy',
					stackIds: [ids.featCheckout],
					removeUploads: false,
				}),
				demo,
				ctx
			)
		).toEqual({
			allowed: false,
			error: supabaseDesktopError(
				'refused',
				'Lane :8102 is attached and running. Stop the lane in Lanes first.'
			),
		});
		expect(
			checkSupabaseOperation(
				op({
					kind: 'destroy',
					stackIds: [ids.featGone],
					removeUploads: false,
					pruneRevision: demo.prune.revision - 1,
				}),
				demo,
				ctx
			)
		).toMatchObject({ allowed: false, error: { code: 'stale_selection' } });
		expect(
			checkSupabaseOperation(
				op({
					kind: 'destroy',
					stackIds: ['f'.repeat(64)],
					removeUploads: false,
				}),
				demo,
				ctx
			)
		).toMatchObject({ allowed: false, error: { code: 'stale_selection' } });
		expect(
			checkSupabaseOperation(
				op({ kind: 'restart', stackId: 'f'.repeat(64) }),
				demo,
				ctx
			)
		).toMatchObject({ allowed: false, error: { code: 'unknown_target' } });
		expect(
			checkSupabaseOperation(
				op({ kind: 'stop', stackIds: [ids.featCheckout, ids.legacyMain] }),
				demo,
				ctx
			)
		).toMatchObject({
			allowed: false,
			error: {
				message: 'External stacks are stopped one at a time from their detail.',
			},
		});
		expect(
			checkSupabaseOperation(op({ kind: 'refresh' }), demo, {
				bridgeAvailable: false,
			})
		).toMatchObject({ allowed: false, error: { code: 'unavailable' } });
		expect(
			checkSupabaseOperation(
				op({ kind: 'refresh' }),
				{ ...demo, feature: { enabled: false, policyHealth: 'ok' } },
				ctx
			)
		).toMatchObject({ allowed: false, error: { code: 'feature_off' } });
		expect(
			checkSupabaseOperation(
				op({ kind: 'cancel-job', jobId: ids.jobFixAuth }),
				demo,
				ctx
			)
		).toEqual({ allowed: true });
		expect(
			checkSupabaseOperation(
				op({
					kind: 'release',
					stackId: ids.featCheckout,
					holder: {
						holder: 'session',
						agentKind: 'claude',
						sessionId: 'gone-session',
					},
				}),
				demo,
				ctx
			)
		).toMatchObject({ allowed: false, error: { code: 'unknown_target' } });
		expect(
			checkSupabaseOperation(
				op({ kind: 'restart-metro', laneId: ids.laneCheckout }),
				demo,
				ctx
			)
		).toMatchObject({
			allowed: false,
			error: { message: SUPABASE_REASONS.metroCurrent },
		});
	});

	it('makes room only by stopping a stack the capacity request offers', () => {
		const ctx = { bridgeAvailable: true, now };
		const [template] = demo.requests;
		const [job] = demo.jobs;
		if (!template || !job) throw new Error('missing demo request or job');
		const request = {
			...template,
			id: 'supabase-request-00000000-0000-4000-8000-0000000000aa',
			kind: 'start-capacity' as const,
			capacity: {
				running: 12,
				cap: 12,
				candidates: [
					{
						stackId: ids.featCheckout,
						branch: 'feat-checkout',
						liveHolder: true,
					},
				],
			},
		};
		const state = { ...demo, requests: [request] };
		const approve = (stopStackId: string, from = state) =>
			checkSupabaseOperation(
				op({ kind: 'request.approve', requestId: request.id, stopStackId }),
				from,
				ctx
			);
		expect(approve(ids.featCheckout)).toEqual({ allowed: true });
		// An external stack, a running one it doesn't offer, an unlisted id.
		for (const stopStackId of [ids.legacyMain, ids.main, 'f'.repeat(64)]) {
			expect(approve(stopStackId)).toEqual({
				allowed: false,
				error: supabaseDesktopError(
					'refused',
					"That stack isn't one to stop to make room. Choose another."
				),
			});
		}
		// The stop waits for the candidate's own operation, like a plain stop.
		const busy = {
			...state,
			jobs: [
				...state.jobs,
				{
					...job,
					id: 'supabase-job-00000000-0000-4000-8000-0000000000bb',
					stackIds: [ids.featCheckout],
				},
			],
		};
		expect(approve(ids.featCheckout, busy)).toEqual({
			allowed: false,
			error: supabaseDesktopError('refused', SUPABASE_REASONS.inFlight),
		});
		expect(
			supabaseRequestActionAvailability(request, 'approve', {
				bridgeAvailable: true,
				state,
				stopStackId: ids.legacyMain,
			})
		).toEqual({
			allowed: false,
			check: 'state',
			reason: "That stack isn't one to stop to make room. Choose another.",
		});
	});

	it('knows which operations need the native dialog', () => {
		const cases: [Record<string, unknown>, boolean][] = [
			[{ kind: 'set-enabled', enabled: true }, true],
			[{ kind: 'set-enabled', enabled: false }, true],
			[{ kind: 'stop', stackIds: [ids.featCheckout] }, false],
			[{ kind: 'stop', stackIds: [ids.legacyMain] }, true],
			[
				{ kind: 'destroy', stackIds: [ids.featGone], removeUploads: false },
				true,
			],
			[{ kind: 'reset', stackId: ids.featCheckout, seed: true }, true],
			[{ kind: 'recreate', stackId: ids.featCheckout }, true],
			[{ kind: 'set-studio', stackId: ids.featCheckout, enabled: true }, true],
			[
				{ kind: 'set-studio', stackId: ids.featCheckout, enabled: false },
				false,
			],
			[{ kind: 'update-policy', patch: { maxRunning: 4 } }, false],
			[{ kind: 'update-policy', patch: { exclude: ['analytics'] } }, true],
			[{ kind: 'update-policy', patch: { allowUnverifiedPatch: true } }, true],
			[{ kind: 'request.approve', requestId: ids.requestOldUi }, true],
			[{ kind: 'restart', stackId: ids.featCheckout }, false],
		];
		for (const [fields, required] of cases) {
			expect(supabaseConfirmationRequired(op(fields), demo)).toBe(required);
		}
		const calm = { ...demo, stacks: [stopped] };
		expect(
			supabaseConfirmationRequired(
				op({ kind: 'set-enabled', enabled: false }),
				calm
			)
		).toBe(false);
	});

	it('merges the dialog options and token into the same operation', () => {
		const destroy = op({
			kind: 'destroy',
			stackIds: [ids.featGone],
			removeUploads: false,
		});
		expect(
			withSupabaseConfirmation(destroy, {
				actionId: ACTION,
				required: true,
				confirmed: true,
				token: TOKEN,
				options: { removeUploads: true },
			})
		).toEqual({
			ok: true,
			operation: { ...destroy, removeUploads: true, confirmationToken: TOKEN },
		});
		const off = op({ kind: 'set-enabled', enabled: false });
		expect(
			withSupabaseConfirmation(off, {
				actionId: ACTION,
				required: true,
				confirmed: true,
				token: TOKEN,
				options: { disposition: 'stop-managed' },
			})
		).toEqual({
			ok: true,
			operation: {
				...off,
				disposition: 'stop-managed',
				confirmationToken: TOKEN,
			},
		});
		expect(
			withSupabaseConfirmation(destroy, {
				actionId: 'other',
				required: true,
				confirmed: true,
				token: TOKEN,
			})
		).toMatchObject({ ok: false });
		expect(
			withSupabaseConfirmation(destroy, {
				actionId: ACTION,
				required: true,
				confirmed: false,
				error: 'Cancelled by the operator.',
			})
		).toEqual({ ok: false, error: 'Cancelled by the operator.' });
		expect(
			withSupabaseConfirmation(destroy, {
				actionId: ACTION,
				required: true,
				confirmed: true,
			})
		).toMatchObject({ ok: false });
		const refresh = op({ kind: 'refresh' });
		expect(
			withSupabaseConfirmation(refresh, {
				actionId: ACTION,
				required: false,
				confirmed: true,
			})
		).toEqual({ ok: true, operation: refresh });
		expect(
			withSupabaseConfirmation(refresh, {
				actionId: ACTION,
				required: true,
				confirmed: true,
				token: TOKEN,
			})
		).toMatchObject({ ok: false });
	});

	it('asks inline only before interrupting a live agent', () => {
		expect(
			supabaseInlineConfirmation(
				op({ kind: 'stop', stackIds: [ids.featCheckout] }),
				demo
			)
		).toEqual({ required: true, agents: ['Claude 7f3a2c91'] });
		expect(
			supabaseInlineConfirmation(
				op({ kind: 'stop', stackIds: [ids.main] }),
				demo
			)
		).toEqual({ required: false, agents: [] });
		expect(
			supabaseInlineConfirmation(
				op({ kind: 'stop', stackIds: [ids.legacyMain] }),
				demo
			)
		).toEqual({ required: false, agents: [] });
		expect(
			supabaseInlineConfirmation(
				op({ kind: 'cancel-job', jobId: ids.jobFixAuth }),
				demo
			)
		).toEqual({ required: true, agents: [] });
		expect(
			supabaseInlineConfirmation(
				op({
					kind: 'release',
					stackId: ids.featCheckout,
					holder: {
						holder: 'session',
						agentKind: 'codex',
						sessionId: ids.codexAbandoned,
					},
				}),
				demo
			)
		).toEqual({ required: false, agents: [] });
		expect(
			supabaseInlineConfirmation(
				op({
					kind: 'release',
					stackId: ids.featPayments,
					holder: {
						holder: 'worktree',
						agentKind: 'codex',
						sessionId: ids.codexSynthetic,
					},
				}),
				demo
			)
		).toEqual({ required: true, agents: ['Codex · by worktree'] });
	});
});

describe('policy', () => {
	it.each([
		[{ maxRunning: 0 }, 'maxRunning', SUPABASE_POLICY_ERRORS.maxRunning],
		[{ maxRunning: 25 }, 'maxRunning', SUPABASE_POLICY_ERRORS.maxRunning],
		[{ maxRunning: 1.5 }, 'maxRunning', SUPABASE_POLICY_ERRORS.maxRunning],
		[
			{ unheldStopDelayMs: -1 },
			'unheldStopDelayMs',
			SUPABASE_POLICY_ERRORS.unheldStopDelayMs,
		],
		[
			{ unheldStopDelayMs: 3_600_001 },
			'unheldStopDelayMs',
			SUPABASE_POLICY_ERRORS.unheldStopDelayMs,
		],
		[
			{ retentionDays: 91 },
			'retentionDays',
			SUPABASE_POLICY_ERRORS.retentionDays,
		],
		[{}, 'form', SUPABASE_POLICY_ERRORS.empty],
		[
			{ appEnv: [{ name: 'expo_url', source: 'API_URL' }] },
			'appEnv.0',
			SUPABASE_POLICY_ERRORS.appEnvName,
		],
		[
			{ appEnv: [{ name: 'CI', source: 'API_URL' }] },
			'appEnv.0',
			SUPABASE_POLICY_ERRORS.appEnvReserved,
		],
		[
			{
				appEnv: [
					{
						name: 'EXPO_PUBLIC_SUPABASE_SECRET_KEY',
						source: 'PUBLISHABLE_KEY',
					},
				],
			},
			'appEnv.0',
			SUPABASE_POLICY_ERRORS.appEnvSecret,
		],
		[
			{
				appEnv: [
					{ name: 'EXPO_PUBLIC_URL', source: 'API_URL' },
					{ name: 'EXPO_PUBLIC_URL', source: 'REST_URL' },
				],
			},
			'appEnv.1',
			SUPABASE_POLICY_ERRORS.appEnvDuplicate,
		],
		[
			{ exclude: ['studio', 'studio'] },
			'exclude',
			SUPABASE_POLICY_ERRORS.exclude,
		],
	])('rejects %o on %s', (patch, field, message) => {
		expect(supabasePolicyPatchErrors(patch)[field]).toBe(message);
	});

	it('accepts a valid patch and applies only what it names', () => {
		const patch = {
			maxRunning: 8,
			appEnv: [
				{ name: 'EXPO_PUBLIC_SUPABASE_URL', source: 'API_URL' as const },
			],
		};
		expect(supabasePolicyPatchErrors(patch)).toEqual({});
		const next = applySupabasePolicyPatch(SUPABASE_POLICY_DEFAULTS, patch);
		expect(next.maxRunning).toBe(8);
		expect(next.appEnv).toEqual(patch.appEnv);
		expect(next.exclude).toEqual(SUPABASE_POLICY_DEFAULTS.exclude);
		expect(next.paths).toEqual(SUPABASE_POLICY_DEFAULTS.paths);
	});

	it('flags only the trust-weakening direction', () => {
		const current = SUPABASE_POLICY_DEFAULTS;
		expect(
			supabasePolicyTrustChanges({ exclude: ['analytics'] }, current)
		).toEqual(['include-studio']);
		expect(
			supabasePolicyTrustChanges(
				{ allowUnverifiedPatch: true, perStackKeys: true },
				current
			)
		).toEqual(['allow-unverified-patch', 'per-stack-keys']);
		expect(
			supabasePolicyTrustChanges(
				{ exclude: ['studio', 'analytics', 'pooler'] },
				current
			)
		).toEqual([]);
		expect(
			supabasePolicyTrustChanges(
				{ exclude: ['studio'] },
				{ ...current, exclude: ['analytics'] }
			)
		).toEqual([]);
		expect(
			supabasePolicyTrustChanges(
				{ allowUnverifiedPatch: false },
				{ ...current, allowUnverifiedPatch: true }
			)
		).toEqual([]);
	});

	it.each([
		[32, 12],
		[20, 6],
		[9, 1],
		[64, 12],
		[undefined, 12],
	])('derives a cap of %s segments as %d', (shmmni, cap) => {
		expect(supabaseDerivedCap(shmmni)).toBe(cap);
	});
});

describe('display helpers', () => {
	it.each([
		['refs/heads/feat/login-flow', 'feat/login-flow'],
		['detached', 'detached HEAD'],
		['ordinary-workspace', 'no git branch'],
		['refs/tags/v1', 'refs/tags/v1'],
		[undefined, undefined],
	])('labels the branch %s', (ref, label) => {
		expect(supabaseBranchLabel(ref)).toBe(label);
	});

	it('titles rows, agents, sizes and platforms', () => {
		expect(supabaseStackTitle(checkout)).toBe('feat-checkout');
		expect(supabaseStackTitle(demoStack(ids.unreadable))).toBe('c41d0e77…');
		expect(
			supabaseAgentLabel({ kind: 'claude', sessionId: ids.claudeCheckout })
		).toBe('Claude 7f3a2c91');
		expect(
			supabaseAgentLabel({ kind: 'codex', sessionId: 'mcp-codex-mcp-client' })
		).toBe('Codex · by worktree');
		expect(formatSupabaseSize(undefined)).toBe('—');
		expect(formatSupabaseSize(512)).toBe('512 B');
		expect(formatSupabaseSize(63 * 1_024)).toBe('63 KB');
		expect(formatSupabaseSize(2.5 * 1_024 * 1_024)).toBe('2.5 MB');
		expect(formatSupabaseSize(71 * 1_024 * 1_024)).toBe('71 MB');
		expect(formatSupabaseSize(1.7 * 1_024 ** 3)).toBe('1.7 GB');
		expect(supabasePlatformLabel({ arch: 'arm64', macosVersion: '15.1' })).toBe(
			'Apple silicon · macOS 15.1'
		);
		expect(supabasePlatformLabel({ arch: 'x64', macosVersion: '13.6' })).toBe(
			'Intel · macOS 13.6'
		);
	});

	it('sanitizes agent free text', () => {
		expect(sanitizeSupabaseDisplayText('Fresh‮db\n\tfor\u0000 tests', 240)).toBe(
			'Fresh db for tests'
		);
		expect(sanitizeSupabaseDisplayText('x'.repeat(300))).toHaveLength(240);
		expect(sanitizeSupabaseDisplayText('x'.repeat(300)).endsWith('…')).toBe(
			true
		);
	});
});

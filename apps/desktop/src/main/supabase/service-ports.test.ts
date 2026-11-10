import { describe, expect, it } from 'vitest';
import { createSupabaseDemoState } from '../../shared/supabase-demo-data';
import {
	type LaneBackendSummary,
	SUPABASE_EXCLUDABLE_CAPABILITIES as SHARED_EXCLUDABLE,
	SUPABASE_PREPARABLE_CAPABILITIES as SHARED_PREPARABLE,
	SUPABASE_CLI_ERROR_CODES,
	SUPABASE_UNREADABLE_RECOVERY,
	type SupabaseStackSummary,
	supabaseErrorSchema,
} from '../../shared/supabase-protocol';
import { parseSupabaseErrorEnvelope } from './cli-contract';
import {
	type ClassifiedSupabaseError,
	classifySupabaseError,
} from './cli-errors';
import {
	fixtureStdout,
	loadSupabaseCliFixture,
	type SupabaseCliFixtureName,
} from './cli-fixtures.test-support';
import { parseSupabaseJsonLine } from './cli-runner';
import {
	SUPABASE_EXCLUDABLE_CAPABILITIES,
	SUPABASE_PREPARABLE_CAPABILITIES,
} from './dialect';
import {
	describeSupabaseLaneBackend,
	LANE_BACKEND_DEFAULT_WAIT_MS,
	type SupabaseConfirmationFacts,
	supabaseConfirmationOutcome,
	supabaseMessageBoxOptions,
	supabaseSteeringFile,
	toSupabaseErrorView,
} from './service-ports';

function classified(code: string, message: string): ClassifiedSupabaseError {
	return classifySupabaseError({
		envelope: parseSupabaseErrorEnvelope({
			_tag: 'Error',
			error: { code, message },
		}),
		exitCode: 1,
	});
}

function classifiedFixture(
	name: SupabaseCliFixtureName
): ClassifiedSupabaseError {
	const fixture = loadSupabaseCliFixture(name);
	return classifySupabaseError({
		envelope: parseSupabaseErrorEnvelope(
			parseSupabaseJsonLine(fixtureStdout(fixture))
		),
		exitCode: fixture.exitCode,
		stderrLines: fixture.stderr,
	});
}

const ONE_OF_EACH_CODE: readonly ClassifiedSupabaseError[] = [
	classified('ExperimentalStackStatusError', 'Stack abcd1234 was not found'),
	classified('LocalDbRunningError', 'The local stack is not running.'),
	classifiedFixture('error-release-mismatch'),
	classifiedFixture('start-needs-recreate'),
	classifiedFixture('start-runtime-mismatch'),
	classifiedFixture('start-port-conflict'),
	classified(
		'ExperimentalStackStartError',
		'Port 8083 for analytics at 127.0.0.1 is in use by another process'
	),
	classified(
		'ExperimentalStackStartError',
		'The stack is in a partial lifecycle state'
	),
	classified(
		'ExperimentalStackStartError',
		'Another owner is sweeping this stack'
	),
	classified('ExperimentalStackStartError', 'No space left on device'),
	classified('ExperimentalStackListError', 'Stack state could not be read'),
	classified(
		'MigrationMissingLocalError',
		'Remote migration versions not found'
	),
	classified('MigrationApplyError', 'ERROR: syntax error at or near "tabel"'),
	classified('ResetLocalDbFailedError', 'Database reset failed'),
	classified('NonInteractiveError', 'This command requires confirmation'),
	classified('MissingOption', 'Missing required option --workdir'),
	classified('SomethingNewError', 'Something unexpected happened'),
];

describe('shared vocabulary', () => {
	it('mirrors the dialect capability lists', () => {
		expect([...SHARED_EXCLUDABLE]).toEqual([
			...SUPABASE_EXCLUDABLE_CAPABILITIES,
		]);
		expect([...SHARED_PREPARABLE]).toEqual([
			...SUPABASE_PREPARABLE_CAPABILITIES,
		]);
	});

	it('defaults the in-lane wait to 15 s', () => {
		expect(LANE_BACKEND_DEFAULT_WAIT_MS).toBe(15_000);
	});
});

describe('toSupabaseErrorView', () => {
	it('projects every classifier code into the renderer schema', () => {
		const views = ONE_OF_EACH_CODE.map((error) => toSupabaseErrorView(error));
		expect(new Set(views.map((view) => view.code))).toEqual(
			new Set(SUPABASE_CLI_ERROR_CODES)
		);
		for (const view of views) {
			expect(supabaseErrorSchema.parse(view)).toEqual(view);
		}
	});

	it('labels the holder of a pinned port everywhere it appears', () => {
		const error = classifiedFixture('start-port-conflict');
		const root = error.details.holderProjectRoot;
		expect(root).toBe('/private/tmp/supa-spike/work/wt-c');
		const view = toSupabaseErrorView(error, {
			pathLabel: (value) =>
				value.replace('/private/tmp/supa-spike/work', '~/spike'),
		});
		expect(view.code).toBe('ports_pinned');
		expect(view.details).toMatchObject({
			port: 54_321,
			key: 'api',
			portProblem: 'held-by-stack',
			holderProjectLabel: '~/spike/wt-c',
		});
		expect(JSON.stringify(view)).not.toContain('/private/tmp');
		expect(view.recovery).toContain('the stack of ~/spike/wt-c');
	});

	it('never offers Destroy for an unreadable stack', () => {
		const view = toSupabaseErrorView(
			classified('ExperimentalStackListError', 'Stack state could not be read')
		);
		expect(view.code).toBe('unreadable');
		expect(view.recovery).toBe(SUPABASE_UNREADABLE_RECOVERY);
	});

	it('keeps recreate facts and strips control characters', () => {
		const view = toSupabaseErrorView(classifiedFixture('start-needs-recreate'));
		expect(view.details.stackChanges?.[0]).toMatchObject({
			key: '[db] major_version',
			saved: '15',
			requested: '17',
			editable: true,
		});
		const noisy = toSupabaseErrorView({
			code: 'failed',
			title: `Supabase CLI failed\u0007${'x'.repeat(400)}`,
			message: `line one\nline\u0000two ${'y'.repeat(5_000)}`,
			recovery: 'Retry.',
			retry: 'none',
			details: { exitCode: 1, timedOut: true },
		});
		expect(noisy.title).toHaveLength(256);
		expect(noisy.title).not.toContain('\u0007');
		expect(noisy.message.startsWith('line one\nline two')).toBe(true);
		expect(noisy.message).toHaveLength(4_096);
		expect(noisy.details).toEqual({ exitCode: 1, timedOut: true });
	});

	it('falls back to an internal error when the projection would not parse', () => {
		const view = toSupabaseErrorView({
			code: 'failed',
			title: 'Supabase CLI failed',
			message: 'x',
			recovery: 'Retry.',
			retry: 'none',
			details: { upstreamCode: 'not a code!' },
		});
		expect(view.code).toBe('internal');
	});
});

describe('native confirmation', () => {
	const destroy: SupabaseConfirmationFacts = {
		title: 'Destroy the local Supabase stack for feat-old-ui?',
		lines: [
			"Deletes its database and logs. This can't be undone.",
			'Worktree ~/code/example-app-wt/old-ui',
		],
		choices: [{ label: 'Destroy feat-old-ui (71 MB)' }],
		checkbox: {
			label: 'Also delete Storage uploads (12 MB in …/stack-uploads/d3a9e5f2…)',
			checkedByDefault: false,
		},
	};
	const turnOff: SupabaseConfirmationFacts = {
		title: 'Turn off local Supabase?',
		lines: ['3 managed stacks are running.'],
		choices: [
			{ label: 'Leave them running', disposition: 'leave-running' },
			{ label: 'Stop managed stacks', disposition: 'stop-managed' },
		],
	};

	it('puts Cancel first, as the default and the cancel button', () => {
		expect(supabaseMessageBoxOptions(destroy)).toEqual({
			type: 'warning',
			title: destroy.title,
			message: destroy.title,
			detail: destroy.lines.join('\n'),
			buttons: ['Cancel', 'Destroy feat-old-ui (71 MB)'],
			defaultId: 0,
			cancelId: 0,
			noLink: true,
			checkboxLabel: destroy.checkbox?.label,
			checkboxChecked: false,
		});
		expect(supabaseMessageBoxOptions(turnOff).buttons).toEqual([
			'Cancel',
			'Leave them running',
			'Stop managed stacks',
		]);
	});

	it('reads the chosen button and checkbox back as options', () => {
		expect(
			supabaseConfirmationOutcome(destroy, {
				response: 1,
				checkboxChecked: true,
			})
		).toEqual({ confirmed: true, options: { removeUploads: true } });
		expect(supabaseConfirmationOutcome(destroy, { response: 1 })).toEqual({
			confirmed: true,
			options: { removeUploads: false },
		});
		expect(supabaseConfirmationOutcome(destroy, { response: 0 })).toEqual({
			confirmed: false,
			options: {},
		});
		expect(supabaseConfirmationOutcome(turnOff, { response: 2 })).toEqual({
			confirmed: true,
			options: { disposition: 'stop-managed' },
		});
		expect(supabaseConfirmationOutcome(turnOff, { response: 3 })).toEqual({
			confirmed: false,
			options: {},
		});
	});
});

describe('supabaseSteeringFile', () => {
	it('writes the v1 shape, and no roots while disabled', () => {
		const snapshot = {
			enabled: true,
			desktopPid: 4_242,
			writtenAt: 1_792_245_785_000,
			managedRoots: [
				{
					root: '/Users/dev/app-wt/feat-a',
					projectRoot: '/Users/dev/app-wt/feat-a',
					branchContext: 'refs/heads/feat-a',
					stackReady: true,
					runner: 'pnpm exec supabase',
				},
			],
		};
		expect(supabaseSteeringFile(snapshot)).toEqual({
			version: 1,
			writtenAt: snapshot.writtenAt,
			desktopPid: 4_242,
			supabase: {
				enabled: true,
				roots: [
					{
						worktreeRoot: '/Users/dev/app-wt/feat-a',
						projectRoot: '/Users/dev/app-wt/feat-a',
						mode: 'managed',
						branchContext: 'refs/heads/feat-a',
						stackReady: true,
						runner: 'pnpm exec supabase',
					},
				],
			},
		});
		expect(
			supabaseSteeringFile({ ...snapshot, enabled: false }).supabase
		).toEqual({
			enabled: false,
			roots: [],
		});
	});
});

describe('cached lane backend health', () => {
	const initial = createSupabaseDemoState();
	const template = initial.stacks[0];
	if (!template) throw new Error('Demo stack fixture missing.');
	const stack: SupabaseStackSummary = {
		...template,
		state: 'running',
		ownerLiveness: 'reachable',
		lifecycle: 'running',
		readiness: 'ready',
		mode: { value: 'managed' },
		exposure: { verdict: 'loopback' },
		flags: [],
		apiUrl: 'http://127.0.0.1:54321',
	};
	const previous: LaneBackendSummary = {
		policy: 'required',
		status: 'ready',
		stackId: stack.id,
		apiUrl: stack.apiUrl as string,
		appEnvNames: ['PUBLIC_API_URL'],
		warnings: [],
	};
	const state = {
		...initial,
		feature: { ...initial.feature, enabled: true },
		stacks: [stack],
	};
	it.each(['stopped', 'failed', 'unhealthy', 'partial', 'unknown'] as const)(
		'downgrades %s stacks without retaining stale endpoints',
		(status) => {
			const projected = describeSupabaseLaneBackend(previous, {
				...state,
				stacks: [{ ...stack, state: status }],
			});
			expect(projected.status).toBe(
				status === 'stopped' ? 'stopped' : 'failed'
			);
			expect(projected.apiUrl).toBeUndefined();
			expect(projected.appEnvNames).toEqual([]);
			expect(projected.reasonText).toContain(
				'Run `rndevtools lane --operation up --worktree <app directory>`'
			);
			// A running stack alone cannot prove this Metro received its new values.
			expect(describeSupabaseLaneBackend(projected, state)).toEqual(projected);
		}
	);
	it('reports disabled, missing, exposed, and moved backends from cached state', () => {
		expect(
			describeSupabaseLaneBackend(previous, {
				...state,
				feature: { ...state.feature, enabled: false },
			})
		).toMatchObject({ status: 'skipped', reason: 'disabled' });
		expect(
			describeSupabaseLaneBackend(previous, { ...state, stacks: [] }).status
		).toBe('stopped');
		expect(
			describeSupabaseLaneBackend(previous, {
				...state,
				stacks: [{ ...stack, exposure: { verdict: 'lan-exposed' } }],
			})
		).toMatchObject({ status: 'refused', reason: 'lan-exposed' });
		expect(
			describeSupabaseLaneBackend(previous, {
				...state,
				stacks: [{ ...stack, apiUrl: 'http://127.0.0.1:54322' }],
			}).status
		).toBe('stale');
	});
	it('preserves shadowed, stale and failed attachment evidence when the stack runs', () => {
		for (const status of ['shadowed', 'stale', 'failed', 'blocked'] as const) {
			const attached = {
				...previous,
				status,
				reasonText: 'Existing attachment diagnostic',
			};
			expect(describeSupabaseLaneBackend(attached, state)).toBe(attached);
		}
	});
});

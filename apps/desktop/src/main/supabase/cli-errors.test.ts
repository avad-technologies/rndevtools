import { describe, expect, it } from 'vitest';
import {
	parseSupabaseErrorEnvelope,
	parseSupabaseStackStart,
	parseSupabaseStackStatus,
} from './cli-contract';
import {
	type ClassifiedSupabaseError,
	classifySupabaseError,
	interpretSupabaseResult,
	type SupabaseErrorCode,
} from './cli-errors';
import {
	fixtureStdout,
	loadSupabaseCliFixture,
	realisticSecrets,
	type SupabaseCliFixtureName,
} from './cli-fixtures.test-support';
import { parseSupabaseJsonLine, SupabaseCliRunResult } from './cli-runner';

const STACK_A =
	'b2e7a5393a8054d7b4658b68c7c7bb12092465347f6e3fbb7afb6864534dd9e8';
const STACK_C =
	'caa17ef5f48a374c852df92e3c2f8d4d6f6d4e446b606b21388dc9fcdf555fb6';

function classifyFixture(
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

function classifyMessage(
	code: string,
	message: string,
	extra: Readonly<{ detail?: string; suggestion?: string }> = {}
): ClassifiedSupabaseError {
	return classifySupabaseError({
		envelope: parseSupabaseErrorEnvelope({
			_tag: 'Error',
			error: { code, message, ...extra },
		}),
		exitCode: 1,
	});
}

function resultOf(
	stdout: string,
	fields: Partial<ConstructorParameters<typeof SupabaseCliRunResult>[0]> = {}
): SupabaseCliRunResult {
	return new SupabaseCliRunResult(
		{
			exitCode: 0,
			signal: null,
			timedOut: false,
			cancelled: false,
			signalsSent: [],
			stdoutBytes: stdout.length,
			stdoutTruncated: false,
			stderrLines: [],
			stderrTruncated: false,
			durationMs: 5,
			...fields,
		},
		stdout
	);
}

describe('classifySupabaseError: recorded envelopes', () => {
	it('maps each recorded failure to a typed error', () => {
		const expectations: [SupabaseCliFixtureName, SupabaseErrorCode][] = [
			['status-unknown-id', 'not_found'],
			['error-status-no-stack', 'not_found'],
			['error-local-db-not-running', 'not_running'],
			['error-release-mismatch', 'cli_mismatch'],
			['start-port-conflict', 'ports_pinned'],
			['start-needs-recreate', 'needs_recreate'],
			['start-runtime-mismatch', 'container_runtime'],
			['destroy-partial', 'busy'],
			['error-db-connect-tls', 'flag_misuse'],
			['error-db-connect-refused', 'not_running'],
		];
		for (const [name, code] of expectations) {
			const classified = classifyFixture(name);
			expect({ name, code: classified.code }).toEqual({ name, code });
			expect(classified.title.length).toBeGreaterThan(0);
			expect(classified.recovery.length).toBeGreaterThan(0);
			expect(classified.message.length).toBeLessThanOrEqual(4096);
		}
	});

	it('names the stack, port and project holding a pinned port', () => {
		const classified = classifyFixture('start-port-conflict');
		expect(classified.details).toMatchObject({
			upstreamCode: 'ExperimentalStackStartError',
			port: 54321,
			key: 'api',
			portProblem: 'held-by-stack',
			holderProjectRoot: '/private/tmp/supa-spike/work/wt-c',
			holderStackId: STACK_C,
			upstreamSuggestion:
				'Set `api.port` in supabase/config.toml (or SUPABASE_API_PORT) to a free port.',
			exitCode: 1,
		});
		expect(classified.recovery).toContain('Port 54321 for api');
		expect(classified.recovery).toContain('/private/tmp/supa-spike/work/wt-c');
		expect(classified.retry).toBe('none');
	});

	it('extracts both releases from a mismatch', () => {
		expect(classifyFixture('error-release-mismatch').details).toMatchObject({
			stackId: STACK_A,
			ownerRelease: '0.1.0+a559977f2134f3a5',
			clientRelease: '0.1.0+8b6cc1ef8a8469e7',
		});
	});

	it('routes an incompatible saved stack to recreate, without a runnable command', () => {
		const classified = classifyFixture('start-needs-recreate');
		expect(classified.details.recreateStackId).toBe(STACK_A);
		expect(classified.details.stackChanges).toEqual([
			{
				service: 'database',
				path: 'config.version',
				key: '[db] major_version',
				saved: '15',
				requested: '17',
				editable: true,
			},
		]);
		expect(classified.recovery).toContain('Revert the listed settings');
		expect(JSON.stringify(classified)).not.toContain('recreate_command');
		expect(classified.retry).toBe('none');
	});

	it('advises reverting only when every listed change is editable', () => {
		const fixture = loadSupabaseCliFixture('start-needs-recreate');
		// The recorded refusal, listing these changes instead.
		const recoveryWith = (stackChanges: readonly object[]) =>
			classifySupabaseError({
				envelope: parseSupabaseErrorEnvelope({
					...(fixture.stdout as Record<string, unknown>),
					stack_changes: stackChanges,
				}),
				exitCode: fixture.exitCode,
				stderrLines: fixture.stderr,
			}).recovery;
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
		const recreateOnly =
			'This configuration needs a new stack. Destroy and recreate it from RN Devtools; that deletes its local database.';
		expect(recoveryWith([majorVersion])).toContain(
			'Revert the listed settings'
		);
		expect(recoveryWith([postgresBuild])).toBe(recreateOnly);
		// A change no setting controls blocks the start whatever else changed.
		expect(recoveryWith([majorVersion, postgresBuild])).toBe(recreateOnly);
		expect(recoveryWith([postgresBuild, majorVersion])).toBe(recreateOnly);
		// With none listed there is nothing to revert.
		expect(recoveryWith([])).toBe(recreateOnly);
	});

	it('flags a container stack on a native identity and drops advice to use auto', () => {
		const classified = classifyFixture('start-runtime-mismatch');
		expect(classified.details).toMatchObject({
			requestedRuntime: 'native',
			existingRuntime: 'docker',
		});
		expect(classified.details.upstreamSuggestion).toBeUndefined();
	});

	it('replaces Docker advice for native stacks with its own recovery', () => {
		const classified = classifyFixture('error-db-connect-refused');
		expect(classified.details.upstreamSuggestion).toBeUndefined();
		expect(JSON.stringify(classified)).not.toMatch(/docker/i);
		expect(classified.recovery).toContain('Start the stack');
	});

	it('reports what a partly failed batch destroy removed', () => {
		const classified = classifyFixture('destroy-partial');
		expect(classified.details.destroyedStackIds).toEqual([STACK_A]);
		expect(classified.retry).toBe('backoff');
		expect(classified.message).toContain(
			'Another process holds the stack lease'
		);
	});

	it('extracts the id a missing stack was asked for', () => {
		expect(classifyFixture('status-unknown-id').details.stackId).toBe(
			'ffffffffffff'
		);
	});
});

describe('classifySupabaseError: message table', () => {
	const id = STACK_A;
	const table: [string, string, SupabaseErrorCode, Record<string, unknown>?][] =
		[
			[
				'ExperimentalStackStartError',
				'The stack is in a partial lifecycle state',
				'partial',
				{ retry: 'once' },
			],
			[
				'ExperimentalStackStartError',
				'Another owner is sweeping this stack',
				'busy',
				{ retry: 'backoff' },
			],
			[
				'ExperimentalStackStartError',
				'Stack owner did not become reachable: connect ECONNREFUSED (owner log: /tmp/owner.log)',
				'busy',
				{ retry: 'backoff' },
			],
			[
				'ExperimentalStackStartError',
				'Timed out waiting for owner readiness',
				'busy',
				{ retry: 'backoff' },
			],
			[
				'ExperimentalStackStopError',
				'Stack registry is locked by another operation; retry shortly',
				'busy',
				{ retry: 'backoff' },
			],
			[
				'ExperimentalStackStartError',
				'Composition start had failures',
				'capacity',
				{
					detail:
						'database (13fcca92): FATAL: could not create shared memory segment: No space left on device',
				},
			],
			[
				'ExperimentalStackStatusError',
				`Stack ${id} could not be read: Unexpected token. Remove its directory /Users/example/.supabase/stacks/${id} to discard it.`,
				'unreadable',
			],
			[
				'ExperimentalStackListError',
				'The stack registry could not be listed',
				'unreadable',
			],
			[
				'MigrationMissingLocalError',
				'Remote migration versions not found in local migrations directory.',
				'migration_drift',
				{ migrationDrift: 'missing-local' },
			],
			[
				'MigrationMissingRemoteError',
				'Found local migration files to be inserted before the last migration on remote database.',
				'migration_drift',
				{ migrationDrift: 'missing-remote' },
			],
			[
				'MigrationApplyError',
				'ERROR: relation "notes" already exists',
				'migration_failed',
			],
			[
				'ResetLocalDbFailedError',
				'failed to start local stack services: rest exited',
				'reset_failed_partial',
			],
			[
				'ExperimentalStackDestroyError',
				'Destroying a stack requires confirmation; rerun with --yes.',
				'confirm_required',
			],
			['DbResetCancelledError', 'context canceled', 'confirm_required'],
			['MissingOption', 'Missing required flag --stack-id', 'flag_misuse'],
			[
				'ExperimentalStackStatusError',
				'Stack id prefix abcd matches 2 stacks: abcd1, abcd2',
				'flag_misuse',
			],
			[
				'ExperimentalStackStartError',
				'Port 54322 for db at 127.0.0.1:54322 is in use by another process; free it or configure a different port for db',
				'ports_conflict',
				{ portProblem: 'held-by-process', port: 54322, key: 'db' },
			],
			[
				'ExperimentalStackStartError',
				'Public port 15000 for api is inside 10000-19999, which is reserved for native service backends; configure a port outside that range',
				'ports_conflict',
				{ portProblem: 'reserved-range', port: 15000 },
			],
			[
				'ExperimentalStackStartError',
				'Public port 26000 for api is claimed by another listener of this stack',
				'ports_conflict',
				{ portProblem: 'own-listener' },
			],
			[
				'ExperimentalStackStartError',
				'No public port is available',
				'ports_conflict',
				{ portProblem: 'exhausted', retry: 'once' },
			],
			[
				'ExperimentalStackStartError',
				'rest native port collision\nlisten EADDRINUSE',
				'ports_conflict',
				{ portProblem: 'collision', retry: 'once' },
			],
			[
				'ExperimentalStackStartError',
				`Public port 54321 for api is in use by stack ${id}; run \`supabase stack stop\` in that project, or configure a different port for api`,
				'ports_pinned',
				{ holderStackId: id, port: 54321 },
			],
			[
				'ExperimentalStackRestartError',
				'The selected stack has not been configured yet.',
				'not_running',
			],
			[
				'ExperimentalStackLogsError',
				'The stack is not running, so there are no new lines to follow.',
				'not_running',
			],
			['UnknownError', 'Something unexpected happened', 'failed'],
		];

	it.each(table)('%s: %s', (code, message, expected, extra = {}) => {
		const { detail, retry, ...details } = extra as {
			detail?: string;
			retry?: string;
		} & Record<string, unknown>;
		const classified = classifyMessage(code, message, {
			...(detail === undefined ? {} : { detail }),
		});
		expect(classified.code).toBe(expected);
		expect(classified.retry).toBe(retry ?? 'none');
		expect(classified.details).toMatchObject({
			upstreamCode: code,
			...details,
		});
	});
});

describe('classifySupabaseError: without an envelope', () => {
	it('uses the failed task line from stderr', () => {
		const classified = classifySupabaseError({
			exitCode: 1,
			stderrLines: [
				'[task] start: Starting local Supabase stack...',
				'[task] failed: The stack is in a partial lifecycle state',
			],
		});
		expect(classified).toMatchObject({
			code: 'partial',
			message: 'The stack is in a partial lifecycle state',
			details: { exitCode: 1 },
		});
	});

	it('reports timeouts, cancellation and bare exit codes', () => {
		expect(
			classifySupabaseError({ exitCode: null, timedOut: true })
		).toMatchObject({
			code: 'failed',
			title: 'Supabase CLI timed out',
			details: { timedOut: true },
		});
		expect(
			classifySupabaseError({ exitCode: 130, cancelled: true })
		).toMatchObject({
			code: 'failed',
			title: 'Supabase CLI call cancelled',
			details: { cancelled: true, exitCode: 130 },
		});
		expect(classifySupabaseError({ exitCode: 1 })).toMatchObject({
			code: 'failed',
			message: 'The Supabase CLI exited with code 1.',
		});
		expect(
			classifySupabaseError({
				exitCode: 1,
				stderrLines: ['error running pg_dump: exit 1'],
			}).message
		).toBe('error running pg_dump: exit 1');
	});

	it('redacts and bounds every message', () => {
		const { secretKey, dbUrl, dbPassword, anonKey } = realisticSecrets();
		const classified = classifyMessage(
			'ExperimentalStackStartError',
			`Composition start had failures SECRET_KEY=${secretKey} ${dbUrl} ${anonKey}`,
			{ detail: 'x'.repeat(20_000), suggestion: `Use ${secretKey}` }
		);
		const rendered = JSON.stringify(classified);
		for (const secret of [secretKey, dbPassword, anonKey]) {
			expect(rendered.includes(secret)).toBe(false);
		}
		expect(classified.message.length).toBeLessThanOrEqual(4096);
	});
});

describe('interpretSupabaseResult', () => {
	it('projects a successful run and consumes its stdout', () => {
		const fixture = loadSupabaseCliFixture('start-fresh');
		const result = resultOf(fixtureStdout(fixture));
		const outcome = interpretSupabaseResult(result, parseSupabaseStackStart);
		expect(outcome.ok).toBe(true);
		if (outcome.ok) expect(outcome.value.runtime).toBe('native');
		expect(result.takeStdout()).toBe('');
	});

	it('classifies a failed run from its envelope', () => {
		const fixture = loadSupabaseCliFixture('start-port-conflict');
		const outcome = interpretSupabaseResult(
			resultOf(fixtureStdout(fixture), {
				exitCode: 1,
				stderrLines: fixture.stderr,
			}),
			parseSupabaseStackStart
		);
		expect(outcome).toMatchObject({
			ok: false,
			error: { code: 'ports_pinned' },
		});
	});

	it('turns contract drift and oversized output into an unexpected-output failure', () => {
		const status = loadSupabaseCliFixture('status-sleeping');
		const drift = interpretSupabaseResult(
			resultOf(fixtureStdout(status)),
			parseSupabaseStackStart
		);
		expect(drift).toMatchObject({
			ok: false,
			error: { code: 'failed', details: { unexpectedOutput: true } },
		});
		if (!drift.ok) expect(drift.error.message).toContain('stack.start');
		const truncated = interpretSupabaseResult(
			resultOf('{"partial":', { stdoutTruncated: true }),
			parseSupabaseStackStatus
		);
		expect(truncated).toMatchObject({
			ok: false,
			error: { code: 'failed', details: { unexpectedOutput: true } },
		});
	});

	it('accepts an empty stdout when no output is expected', () => {
		const fixture = loadSupabaseCliFixture('db-dump');
		const outcome = interpretSupabaseResult(
			resultOf(fixtureStdout(fixture), { stderrLines: fixture.stderr }),
			(json, stderrLines) => ({ json, lines: stderrLines.length }),
			{ expectOutput: 'none' }
		);
		expect(outcome).toEqual({ ok: true, value: { json: undefined, lines: 2 } });
		expect(
			interpretSupabaseResult(resultOf(''), () => 'unreachable')
		).toMatchObject({
			ok: false,
			error: { details: { unexpectedOutput: true } },
		});
	});

	it('classifies timeouts even when stdout is empty', () => {
		const outcome = interpretSupabaseResult(
			resultOf('', { exitCode: null, timedOut: true, signal: 'SIGTERM' }),
			parseSupabaseStackStart
		);
		expect(outcome).toMatchObject({
			ok: false,
			error: { code: 'failed', title: 'Supabase CLI timed out' },
		});
	});
});

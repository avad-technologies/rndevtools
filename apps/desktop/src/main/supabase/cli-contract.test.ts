import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
	deriveSupabaseMigrationStatus,
	MainOnlyCredentials,
	parseSupabaseDbReset,
	parseSupabaseErrorEnvelope,
	parseSupabaseInspectDbStats,
	parseSupabaseInspectTableStats,
	parseSupabaseMigrationList,
	parseSupabaseMigrationUp,
	parseSupabaseReleaseMismatch,
	parseSupabaseSeedBuckets,
	parseSupabaseStackDestroy,
	parseSupabaseStackList,
	parseSupabaseStackLogs,
	parseSupabaseStackPrepare,
	parseSupabaseStackRestart,
	parseSupabaseStackStart,
	parseSupabaseStackStatus,
	parseSupabaseStackStop,
	parseSupabaseVersion,
	SupabaseContractError,
} from './cli-contract';
import {
	fixtureStdout,
	loadSupabaseCliFixture,
	SECRET_SHAPED,
	SUPABASE_CLI_FIXTURES,
	type SupabaseCliFixtureName,
	withRealisticSecrets,
} from './cli-fixtures.test-support';
import { parseSupabaseJsonLine } from './cli-runner';

const STACK_A =
	'b2e7a5393a8054d7b4658b68c7c7bb12092465347f6e3fbb7afb6864534dd9e8';
const STACK_C =
	'caa17ef5f48a374c852df92e3c2f8d4d6f6d4e446b606b21388dc9fcdf555fb6';

function stdoutJson(name: SupabaseCliFixtureName): unknown {
	return parseSupabaseJsonLine(fixtureStdout(loadSupabaseCliFixture(name)));
}

function withSecrets(name: SupabaseCliFixtureName) {
	return withRealisticSecrets(stdoutJson(name));
}

function contractFailure(action: () => unknown): SupabaseContractError {
	try {
		action();
	} catch (error) {
		if (error instanceof SupabaseContractError) return error;
		throw error;
	}
	throw new Error('expected a contract error');
}

/** How each successful fixture is projected. */
const SUCCESS_PROJECTIONS: Partial<
	Record<
		SupabaseCliFixtureName,
		(json: unknown, stderr: readonly string[]) => unknown
	>
> = {
	'list-running': (json, stderr) => parseSupabaseStackList(json, stderr),
	'list-stopped': (json, stderr) => parseSupabaseStackList(json, stderr),
	'list-empty': (json, stderr) => parseSupabaseStackList(json, stderr),
	'list-unreadable': (json, stderr) => parseSupabaseStackList(json, stderr),
	'status-sleeping': parseSupabaseStackStatus,
	'status-awake': parseSupabaseStackStatus,
	'status-stopped': parseSupabaseStackStatus,
	'status-release-mismatch': parseSupabaseStackStatus,
	'status-never-started': parseSupabaseStackStatus,
	'start-fresh': parseSupabaseStackStart,
	'start-resume-studio': parseSupabaseStackStart,
	'start-already-running': parseSupabaseStackStart,
	'start-endpoint-changes': parseSupabaseStackStart,
	stop: parseSupabaseStackStop,
	restart: parseSupabaseStackRestart,
	'destroy-single': parseSupabaseStackDestroy,
	'destroy-multiple': parseSupabaseStackDestroy,
	logs: (json) => parseSupabaseStackLogs(json),
	prepare: parseSupabaseStackPrepare,
	'migration-list': parseSupabaseMigrationList,
	'migration-up': parseSupabaseMigrationUp,
	'db-reset': parseSupabaseDbReset,
	'inspect-db-stats': parseSupabaseInspectDbStats,
	'inspect-table-stats': parseSupabaseInspectTableStats,
	'seed-buckets': parseSupabaseSeedBuckets,
};

describe('recorded fixtures', () => {
	it('cover every surface and are marked recorded or synthesized', () => {
		for (const name of SUPABASE_CLI_FIXTURES) {
			const fixture = loadSupabaseCliFixture(name);
			expect(fixture.cli).toBe('2.121.0');
			expect(['recorded', 'synthesized']).toContain(fixture.provenance);
			expect(fixture.source.length).toBeGreaterThan(0);
		}
		const recorded = SUPABASE_CLI_FIXTURES.filter(
			(name) => loadSupabaseCliFixture(name).provenance === 'recorded'
		);
		expect(recorded.length).toBeGreaterThanOrEqual(20);
	});

	it('contain no key-shaped values, only placeholders', () => {
		// Env maps keep their variable names; only the values are replaced.
		const keyShaped =
			/sb_secret_|sb_publishable_|eyJ[\w-]+\.[\w-]+|postgres(?:ql)?:\/\/[^\s"]*:[^\s"@<]+@/;
		for (const name of SUPABASE_CLI_FIXTURES) {
			const text = JSON.stringify(loadSupabaseCliFixture(name));
			expect({ name, match: keyShaped.exec(text)?.[0] }).toEqual({
				name,
				match: undefined,
			});
		}
		expect(JSON.stringify(loadSupabaseCliFixture('status-awake'))).toContain(
			'"SECRET_KEY":"<secret-key>"'
		);
	});

	it('every successful fixture parses, and every failure is an error envelope', () => {
		for (const name of SUPABASE_CLI_FIXTURES) {
			const fixture = loadSupabaseCliFixture(name);
			if (name === 'version') {
				expect(parseSupabaseVersion(fixtureStdout(fixture))).toBe('2.121.0');
				continue;
			}
			if (name === 'db-dump') {
				expect(fixture.exitCode).toBe(0);
				expect(fixtureStdout(fixture)).toBe('');
				continue;
			}
			const json = parseSupabaseJsonLine(fixtureStdout(fixture));
			if (fixture.exitCode === 0) {
				const project = SUCCESS_PROJECTIONS[name];
				if (project === undefined) throw new Error(`no projection for ${name}`);
				expect(() => project(json, fixture.stderr)).not.toThrow();
			} else {
				expect(fixture.exitCode).toBe(1);
				expect(parseSupabaseErrorEnvelope(json)).toBeDefined();
			}
		}
	});

	it('never let a secret through a projection, even with realistic key shapes', () => {
		for (const name of SUPABASE_CLI_FIXTURES) {
			const project = SUCCESS_PROJECTIONS[name];
			if (project === undefined) continue;
			const fixture = loadSupabaseCliFixture(name);
			const { value, secrets } = withSecrets(name);
			const projection = project(value, fixture.stderr);
			for (const rendered of [
				JSON.stringify(projection),
				JSON.stringify(structuredClone(projection)),
				inspect(projection, { depth: 12, showHidden: true }),
			]) {
				expect({ name, shaped: SECRET_SHAPED.exec(rendered)?.[0] }).toEqual({
					name,
					shaped: undefined,
				});
				for (const secret of secrets) {
					expect(rendered.includes(secret)).toBe(false);
				}
			}
		}
	});
});

describe('stack status', () => {
	it('projects a running stack with idle services asleep', () => {
		const { value } = withSecrets('status-sleeping');
		const status = parseSupabaseStackStatus(value);
		expect(status.identity).toEqual({
			id: STACK_A,
			name: 'default',
			projectRoot: '/private/tmp/supa-spike/work/repo',
			branchContext: 'refs/heads/main',
		});
		expect(status).toMatchObject({
			runtime: 'native',
			owner: 'reachable',
			lifecycle: 'running',
			readiness: 'sleeping',
			releaseMismatch: undefined,
		});
		expect(status.members.map((member) => member.service)).toEqual([
			'database',
			'rest',
			'auth',
			'realtime',
			'storage',
			'functions',
			'mail',
		]);
		expect(status.members[0]).toEqual({
			id: '13fcca92-620e-4c85-9e1c-d1901558554c',
			service: 'database',
			activation: 'eager',
			state: 'running',
			lifecycle: 'running',
			health: 'healthy',
		});
		expect(status.members[1]).toMatchObject({
			activation: 'lazy',
			state: 'sleeping',
			lifecycle: 'stopped',
			health: null,
		});
		expect(status.services[0]?.endpoints).toEqual({
			sql: { protocol: 'tcp', address: '127.0.0.1', port: 30630 },
		});
		expect(status.endpoints['rest.http']).toEqual({
			protocol: 'http',
			address: '127.0.0.1',
			port: 26211,
		});
		expect(status.configDrift).toEqual({
			status: 'unchanged',
			message: 'Project configuration matches the saved composition members.',
			paths: [],
		});
		expect(status.publicEndpoints).toEqual({
			apiUrl: 'http://127.0.0.1:26211',
			restUrl: 'http://127.0.0.1:26211/rest/v1',
			functionsUrl: 'http://127.0.0.1:26211/functions/v1',
			mailpitUrl: 'http://127.0.0.1:21213',
		});
	});

	it('keeps the publishable key, anon key and DB_URL in main-only credentials', () => {
		const { value } = withSecrets('status-awake');
		const status = parseSupabaseStackStatus(value);
		expect(status.credentials).toBeInstanceOf(MainOnlyCredentials);
		expect(status.credentials.publishableKey).toMatch(/^sb_publishable_/);
		expect(status.credentials.anonKey).toMatch(/^eyJ/);
		expect(status.credentials.dbUrl).toMatch(/^postgresql:\/\/postgres:/);
		expect(JSON.stringify(status)).toContain('"credentials":"[redacted]"');
		// Fixture placeholders are not key-shaped, so they never become credentials.
		const placeholder = parseSupabaseStackStatus(stdoutJson('status-awake'));
		expect(placeholder.credentials.publishableKey).toBeUndefined();
		expect(placeholder.credentials.anonKey).toBeUndefined();
		expect(placeholder.credentials.dbUrl).toBeUndefined();
	});

	it('accepts JSON null lifecycle and health for a stopped stack', () => {
		const { value } = withSecrets('status-stopped');
		const status = parseSupabaseStackStatus(value);
		expect(status).toMatchObject({
			owner: 'unavailable',
			lifecycle: null,
			readiness: 'unavailable',
			publicEndpoints: undefined,
		});
		expect(status.endpoints).toEqual({});
		expect(
			status.services.every(
				(service) =>
					service.state === 'unavailable' &&
					service.lifecycle === null &&
					service.health === null
			)
		).toBe(true);
		// Saved keys are still reported while stopped; they stay main-only.
		expect(status.credentials.publishableKey).toBeDefined();
		expect(status.credentials.dbUrl).toBeUndefined();
	});

	it('detects a CLI release mismatch from the per-service error text', () => {
		const status = parseSupabaseStackStatus(
			stdoutJson('status-release-mismatch')
		);
		expect(status.owner).toBe('reachable');
		expect(status.releaseMismatch).toEqual({
			stackId: STACK_A,
			ownerRelease: '0.1.0+a559977f2134f3a5',
			clientRelease: '0.1.0+8b6cc1ef8a8469e7',
		});
		expect(status.services[0]?.error).toContain('is served by release');
		expect(parseSupabaseReleaseMismatch('unrelated')).toBeUndefined();
	});

	it('handles a prepared stack that never started', () => {
		const status = parseSupabaseStackStatus(stdoutJson('status-never-started'));
		expect(status.members).toEqual([]);
		expect(status.services).toEqual([]);
		expect(status.configDrift?.status).toBe('unavailable');
	});

	it('tolerates and strips fields it does not declare', () => {
		const { value } = withSecrets('status-sleeping');
		const extended = {
			...(value as Record<string, unknown>),
			future_field: { nested: true },
			env: {
				...((value as { env: Record<string, unknown> }).env ?? {}),
				NEW_SECRET_TOKEN: 'future-secret-value',
			},
		};
		const rendered = JSON.stringify(parseSupabaseStackStatus(extended));
		expect(rendered).not.toContain('future_field');
		expect(rendered).not.toContain('future-secret-value');
		expect(rendered).not.toContain('NEW_SECRET_TOKEN');
	});

	it('fails closed on non-loopback URLs without echoing them', () => {
		const { value } = withSecrets('status-sleeping');
		const status = value as { env: Record<string, unknown> };
		for (const apiUrl of [
			'http://0.0.0.0:26211',
			'http://192.168.1.20:26211',
			'http://localhost:26211',
			'https://127.0.0.1:26211',
			'http://user:secret-pass@127.0.0.1:26211',
		]) {
			const failure = contractFailure(() =>
				parseSupabaseStackStatus({
					...status,
					env: { ...status.env, API_URL: apiUrl },
				})
			);
			expect(failure.issues).toEqual(['env.API_URL: not_loopback_http']);
			expect(failure.message).not.toContain(apiUrl);
		}
		expect(
			parseSupabaseStackStatus({
				...status,
				env: {
					...status.env,
					API_URL: 'http://[::1]:26211',
					REST_URL: 'http://[::1]:26211/rest/v1',
				},
			}).publicEndpoints?.apiUrl
		).toBe('http://[::1]:26211');
	});

	it('reports paths and codes, never values, for shapes it does not know', () => {
		const { value, secrets } = withSecrets('status-sleeping');
		const secretKey = secrets[1] ?? '';
		const failure = contractFailure(() =>
			parseSupabaseStackStatus({
				...(value as Record<string, unknown>),
				identity: {
					id: secretKey,
					name: 'default',
					project_root: '/x',
					branch_context: 'x',
				},
				readiness: 'exploded',
			})
		);
		expect(failure.issues).toContain('identity.id: invalid_format');
		expect(failure.issues).toContain('readiness: invalid_value');
		expect(
			JSON.stringify({ message: failure.message, issues: failure.issues })
		).not.toContain(secretKey);
	});
});

describe('stack start', () => {
	it('projects a fresh native start with Studio and analytics excluded', () => {
		const { value } = withSecrets('start-fresh');
		const start = parseSupabaseStackStart(value);
		expect(start).toMatchObject({
			id: STACK_A,
			runtime: 'native',
			alreadyRunning: false,
			endpointChanges: [],
		});
		expect(start.lazyServices).toEqual([
			'rest',
			'auth',
			'realtime',
			'storage',
			'functions',
			'mail',
		]);
		expect(Object.keys(start.endpoints)).not.toContain('studio.http');
		expect(start.publicEndpoints).toEqual({
			apiUrl: 'http://127.0.0.1:26211',
			restUrl: 'http://127.0.0.1:26211/rest/v1',
			functionsUrl: 'http://127.0.0.1:26211/functions/v1',
			mailpitUrl: 'http://127.0.0.1:21213',
		});
		expect(start.credentials.anonKey).toBeDefined();
	});

	it('shows Studio coming back on a resume without exclusions', () => {
		const start = parseSupabaseStackStart(stdoutJson('start-resume-studio'));
		expect(start.publicEndpoints?.studioUrl).toBe('http://127.0.0.1:25998');
		expect(start.endpoints['studio.http']?.port).toBe(25998);
		expect(start.lazyServices).toContain('studio');
	});

	it('recognizes the already-running fast path and moved ports', () => {
		expect(
			parseSupabaseStackStart(stdoutJson('start-already-running'))
				.alreadyRunning
		).toBe(true);
		const moved = parseSupabaseStackStart(stdoutJson('start-endpoint-changes'));
		expect(moved.endpointChanges).toEqual([
			{
				endpoint: 'api',
				keys: [
					'rest.http',
					'auth.http',
					'realtime.http',
					'storage.http',
					'functions.http',
				],
				from: 26211,
				to: 26999,
			},
		]);
		expect(moved.publicEndpoints?.apiUrl).toBe('http://127.0.0.1:26999');
	});
});

describe('stack list, stop, restart, destroy, prepare', () => {
	it('projects list rows and turns skipped stacks into unreadable rows', () => {
		expect(parseSupabaseStackList(stdoutJson('list-running')).stacks).toEqual([
			{
				id: STACK_A,
				projectRoot: '/private/tmp/supa-spike/work/repo',
				name: 'default',
				branchContext: 'refs/heads/main',
				runtime: 'native',
				owner: 'reachable',
			},
			{
				id: 'b7d2540d73c761df0a9c08923965e2172482324bb631b0d9d71962daa1b499e6',
				projectRoot: '/private/tmp/supa-spike/work/wt-b',
				name: 'default',
				branchContext: 'refs/heads/feature-b',
				runtime: 'native',
				owner: 'reachable',
			},
		]);
		expect(
			parseSupabaseStackList(stdoutJson('list-stopped')).stacks[0]?.owner
		).toBe('unavailable');
		expect(parseSupabaseStackList(stdoutJson('list-empty'))).toEqual({
			stacks: [],
			unreadable: [],
		});
		const unreadable = loadSupabaseCliFixture('list-unreadable');
		expect(
			parseSupabaseStackList(stdoutJson('list-unreadable'), unreadable.stderr)
				.unreadable
		).toEqual([
			{ id: 'a'.repeat(64), message: 'state.json is not valid JSON' },
		]);
	});

	it('projects stop, restart, destroy and prepare results', () => {
		expect(parseSupabaseStackStop(stdoutJson('stop'))).toEqual({
			stopped: [STACK_A],
			notRunning: [],
		});
		const restart = parseSupabaseStackRestart(stdoutJson('restart'));
		expect(restart.id).toBe(STACK_A);
		expect(restart.services[0]).toEqual({
			id: '13fcca92-620e-4c85-9e1c-d1901558554c',
			service: 'database',
			lifecycle: 'running',
			health: 'healthy',
			wakeEnabled: true,
		});
		expect(restart.services[1]).toMatchObject({
			lifecycle: 'stopped',
			health: null,
		});
		expect(parseSupabaseStackDestroy(stdoutJson('destroy-single'))).toEqual({
			destroyedIds: [
				'b7d2540d73c761df0a9c08923965e2172482324bb631b0d9d71962daa1b499e6',
			],
		});
		expect(
			parseSupabaseStackDestroy(stdoutJson('destroy-multiple')).destroyedIds
		).toEqual([
			STACK_A,
			STACK_C,
			'618421ea4ddd4809d2f07d8daac2eff6ff5c75ff63569d1e7e258e9ddebdff59',
		]);
		expect(parseSupabaseStackPrepare(stdoutJson('prepare'))).toEqual({
			id: STACK_A,
			capabilities: [
				{ capability: 'database', version: '17.11' },
				{ capability: 'rest', version: '16.4' },
			],
		});
	});
});

describe('stack logs', () => {
	it('projects entries and launch markers in order', () => {
		const logs = parseSupabaseStackLogs(stdoutJson('logs'));
		expect(logs.truncated).toBe(false);
		expect(logs.records).toHaveLength(44);
		expect(logs.records[1]).toEqual({
			type: 'marker',
			timestamp: '2026-10-17T06:59:18.355Z',
			source: 'history',
			service: 'rest',
			instanceId: 'f2fba936-bc07-4c8d-b807-9a74cb55196a',
			kind: 'launch',
			stream: undefined,
			count: undefined,
		});
		const gateway = logs.records.find(
			(record) => record.type === 'entry' && record.service === 'gateway'
		);
		expect(gateway).toMatchObject({
			type: 'entry',
			stream: 'stdout',
			line: expect.stringContaining('GET /rest/v1/notes?select=id&limit=1'),
		});
	});

	it('strips control characters, redacts credentials, and keeps the newest lines within budget', () => {
		const { secretKey, anonKey, dbUrl } = {
			secretKey: ['sb', 'secret', 'Q1w2E3r4T5y6U7i8O9p0'].join('_'),
			anonKey: ['ey', 'JhbGciOiJIUzI1NiJ9.ey', 'JyZWYiOiJhbm9uIn0.c2ln'].join(
				''
			),
			dbUrl: `postgresql://postgres:${'p4ss'}@127.0.0.1:30630/postgres`,
		};
		const entry = (line: string, timestamp: string) => ({
			type: 'log-entry',
			timestamp,
			source: 'history',
			service: 'rest',
			instance_id: 'f2fba936-bc07-4c8d-b807-9a74cb55196a',
			stream: 'stdout',
			line,
		});
		const logs = parseSupabaseStackLogs(
			[
				entry('x'.repeat(1_500), '2026-10-17T06:00:00.000Z'),
				entry('x'.repeat(1_500), '2026-10-17T06:00:01.000Z'),
				entry(
					`\u001b[31mGET /rest/v1/x?apikey=${secretKey}&token=${anonKey} ${dbUrl}\u001b[0m\u202e`,
					'2026-10-17T06:00:02.000Z'
				),
				{
					type: 'log-marker',
					timestamp: '2026-10-17T06:00:03.000Z',
					source: 'history',
					service: 'rest',
					instance_id: 'f2fba936-bc07-4c8d-b807-9a74cb55196a',
					kind: 'lost',
					stream: 'stdout',
					count: 3,
				},
			],
			{ maxCharacters: 2_000 }
		);
		expect(logs.truncated).toBe(true);
		expect(logs.records.map((record) => record.timestamp)).toEqual([
			'2026-10-17T06:00:01.000Z',
			'2026-10-17T06:00:02.000Z',
			'2026-10-17T06:00:03.000Z',
		]);
		const second = logs.records[1];
		const line = second?.type === 'entry' ? second.line : '';
		expect(line.startsWith('GET /rest/v1/x?apikey=')).toBe(true);
		for (const secret of [secretKey, anonKey, 'p4ss', '\u001b', '\u202e']) {
			expect(line.includes(secret)).toBe(false);
		}
		expect(logs.records[2]).toMatchObject({
			kind: 'lost',
			count: 3,
			stream: 'stdout',
		});
	});
});

describe('migrations and database surfaces', () => {
	it('derives applied and pending migrations from the recorded list', () => {
		const list = parseSupabaseMigrationList(stdoutJson('migration-list'));
		expect(list.rows).toEqual([
			{
				local: '20261016000000',
				remote: '20261016000000',
				time: '2026-10-16 00:00:00',
			},
			{ local: '20261017000000', remote: '', time: '2026-10-17 00:00:00' },
		]);
		expect(list.status).toEqual({
			state: 'pending',
			rows: [
				{
					version: '20261016000000',
					time: '2026-10-16 00:00:00',
					status: 'applied',
				},
				{
					version: '20261017000000',
					time: '2026-10-17 00:00:00',
					status: 'pending',
				},
			],
			applied: 1,
			pending: ['20261017000000'],
			outOfOrder: [],
			missingLocal: [],
			canApply: true,
		});
	});

	it('classifies drift the way migration up refuses it', () => {
		const row = (local: string, remote: string) => ({
			local,
			remote,
			time: '',
		});
		expect(deriveSupabaseMigrationStatus([])).toMatchObject({
			state: 'up-to-date',
			canApply: false,
		});
		expect(
			deriveSupabaseMigrationStatus([row('20260101000000', '20260101000000')])
		).toMatchObject({ state: 'up-to-date', applied: 1 });
		// After a branch switch the database has a version this checkout lacks.
		const missing = deriveSupabaseMigrationStatus([
			row('20260101000000', '20260101000000'),
			row('', '20260102000000'),
			row('20260103000000', ''),
		]);
		expect(missing).toMatchObject({
			state: 'missing-local',
			missingLocal: ['20260102000000'],
			pending: ['20260103000000'],
			canApply: false,
		});
		// A local file older than the last applied version is out of order.
		const outOfOrder = deriveSupabaseMigrationStatus([
			row('20260101000000', '20260101000000'),
			row('20260102000000', ''),
			row('20260103000000', '20260103000000'),
			row('20260104000000', ''),
		]);
		expect(outOfOrder).toMatchObject({
			state: 'out-of-order',
			outOfOrder: ['20260102000000'],
			pending: ['20260104000000'],
			applied: 2,
			canApply: false,
		});
		expect(outOfOrder.rows.map((entry) => entry.status)).toEqual([
			'applied',
			'out-of-order',
			'applied',
			'pending',
		]);
		const trailingRemote = deriveSupabaseMigrationStatus([
			row('20260101000000', '20260101000000'),
			row('', '20260105000000'),
		]);
		expect(trailingRemote).toMatchObject({
			state: 'missing-local',
			missingLocal: ['20260105000000'],
		});
	});

	it('projects migration up, reset, inspect and seed results', () => {
		expect(parseSupabaseMigrationUp(stdoutJson('migration-up'))).toEqual({
			applied: ['20261017000000_tags.sql'],
		});
		expect(parseSupabaseDbReset(stdoutJson('db-reset'))).toEqual({
			target: 'local',
			version: '',
		});
		expect(parseSupabaseInspectDbStats(stdoutJson('inspect-db-stats'))).toEqual(
			{
				databaseSize: '11 MB',
				totalIndexSize: '56 kB',
				totalTableSize: '64 kB',
				totalToastSize: '0 bytes',
				timeSinceStatsReset: '00:01:11.432894',
				indexHitRate: '1.00',
				tableHitRate: '1.00',
				walSize: '32 MB',
			}
		);
		expect(
			parseSupabaseInspectDbStats({ rows: [], message: '' })
		).toBeUndefined();
		expect(
			parseSupabaseInspectTableStats(stdoutJson('inspect-table-stats'))
		).toEqual([
			{
				name: 'public.notes',
				tableSize: '96 kB',
				indexSize: '40 kB',
				totalSize: '136 kB',
				estimatedRowCount: '1000',
				seqScans: '2',
			},
			{
				name: 'public.tags',
				tableSize: '8192 bytes',
				indexSize: '16 kB',
				totalSize: '24 kB',
				estimatedRowCount: '0',
				seqScans: '2',
			},
		]);
		expect(parseSupabaseSeedBuckets(stdoutJson('seed-buckets'))).toEqual({
			bucketsCreated: ['avatars'],
			bucketsUpdated: [],
			bucketsSkipped: [],
			objectsUploaded: 1,
		});
	});
});

describe('error envelopes', () => {
	it('projects code, message, suggestion and root extras', () => {
		expect(parseSupabaseErrorEnvelope(stdoutJson('status-unknown-id'))).toEqual(
			{
				code: 'ExperimentalStackStatusError',
				message: 'Stack ffffffffffff was not found',
				detail: undefined,
				suggestion:
					'Run `supabase stack list` to see managed stacks and their IDs.',
				stackChanges: [],
				recreateSuggested: false,
				recreateStackId: undefined,
				destroyedStackIds: [],
			}
		);
		const recreate = parseSupabaseErrorEnvelope(
			stdoutJson('start-needs-recreate')
		);
		expect(recreate).toMatchObject({
			code: 'ExperimentalStackStartError',
			recreateSuggested: true,
			recreateStackId: STACK_A,
			stackChanges: [
				{
					service: 'database',
					path: 'config.version',
					key: '[db] major_version',
					saved: '15',
					requested: '17',
					editable: true,
				},
			],
		});
		// The runnable command itself is dropped.
		expect(JSON.stringify(recreate)).not.toContain('recreate_command');
		expect(
			parseSupabaseErrorEnvelope(stdoutJson('destroy-partial'))
				?.destroyedStackIds
		).toEqual([STACK_A]);
	});

	it('returns undefined for anything that is not an envelope', () => {
		for (const value of [
			null,
			'Error',
			[],
			{ _tag: 'Help' },
			{ error: {} },
			{ stacks: [] },
		]) {
			expect(parseSupabaseErrorEnvelope(value)).toBeUndefined();
		}
	});

	it('redacts and bounds envelope text', () => {
		const { secretKey, dbUrl } = {
			secretKey: ['sb', 'secret', 'Q1w2E3r4T5y6U7i8O9p0'].join('_'),
			dbUrl: `postgresql://postgres:${'hunter2'}@127.0.0.1:30630/postgres`,
		};
		const envelope = parseSupabaseErrorEnvelope({
			_tag: 'Error',
			error: {
				code: 'Weird Code; drop',
				message: `failed with ${secretKey} at ${dbUrl}\n${'z'.repeat(10_000)}`,
			},
		});
		expect(envelope?.code).toBe('UnknownError');
		expect(envelope?.message.length).toBeLessThanOrEqual(4096);
		expect(envelope?.message).not.toContain(secretKey);
		expect(envelope?.message).not.toContain('hunter2');
		expect(envelope?.message).toContain('127.0.0.1:30630');
	});
});

describe('version and credentials', () => {
	it('parses the bare --version line', () => {
		expect(parseSupabaseVersion('2.121.0\n')).toBe('2.121.0');
		expect(parseSupabaseVersion(' 3.0.0-next.15 ')).toBe('3.0.0-next.15');
		for (const output of [
			'',
			'supabase 2.121.0',
			'2.121',
			'{"version":"2.121.0"}',
		]) {
			expect(() => parseSupabaseVersion(output)).toThrow(SupabaseContractError);
		}
	});

	it('main-only credentials serialize to nothing', () => {
		const credentials = new MainOnlyCredentials({
			publishableKey: ['sb', 'publishable', 'Ab12Cd34Ef56'].join('_'),
			dbUrl: `postgresql://postgres:${'pw'}@127.0.0.1:1/postgres`,
		});
		expect(JSON.stringify({ credentials })).toBe(
			'{"credentials":"[redacted]"}'
		);
		expect(structuredClone(credentials)).toEqual({});
		expect(inspect(credentials, { showHidden: true })).toBe(
			'MainOnlyCredentials [redacted]'
		);
		expect(Object.keys(credentials)).toEqual([]);
		expect(credentials.publishableKey).toMatch(/^sb_publishable_/);
		expect(credentials.anonKey).toBeUndefined();
	});
});

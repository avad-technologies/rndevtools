import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	assertSupabaseArgvAllowed,
	buildSupabaseArgv,
	resolveSupabaseDialect,
	SUPABASE_EXCLUDABLE_CAPABILITIES,
	SUPABASE_MAX_CLI_TIMEOUT_MS,
	SUPABASE_PREPARABLE_CAPABILITIES,
	SupabaseArgvError,
	type SupabaseCliOperation,
	type SupabaseDialect,
	supabaseOperationBudget,
} from './dialect';

const STACK =
	'b2e7a5393a8054d7b4658b68c7c7bb12092465347f6e3fbb7afb6864534dd9e8';
const OTHER_STACK =
	'caa17ef5f48a374c852df92e3c2f8d4d6f6d4e446b606b21388dc9fcdf555fb6';
const WORKDIR = '/Users/example/ExampleApp';
const DB_URL = `postgresql://postgres:${'pa%40ss'}@127.0.0.1:30630/postgres`;
const verified = resolveSupabaseDialect('2.121.0');

function argvOf(operation: SupabaseCliOperation, dialect = verified) {
	return buildSupabaseArgv(dialect, operation);
}

function errorOf(action: () => unknown): unknown {
	try {
		action();
	} catch (error) {
		return error;
	}
	throw new Error('expected an error');
}

/** One instance of every operation the builder supports. */
const EVERY_OPERATION: readonly SupabaseCliOperation[] = [
	{ kind: 'version' },
	{ kind: 'stack.list' },
	{ kind: 'stack.status', stackId: STACK },
	{ kind: 'stack.start', workdir: WORKDIR, exclude: ['studio', 'analytics'] },
	{
		kind: 'stack.start',
		workdir: WORKDIR,
		exclude: ['studio', 'analytics'],
		eager: true,
	},
	{ kind: 'stack.start', stackId: STACK, exclude: ['studio', 'analytics'] },
	{ kind: 'stack.stop', stackId: STACK },
	{ kind: 'stack.restart', stackId: STACK },
	{ kind: 'stack.destroy', stackIds: [STACK, OTHER_STACK], confirmed: true },
	{ kind: 'stack.logs', stackId: STACK, tail: 200 },
	{
		kind: 'stack.logs',
		stackId: STACK,
		services: ['rest', 'gateway'],
		tail: 50,
		since: '10m',
	},
	{
		kind: 'stack.prepare',
		workdir: WORKDIR,
		capabilities: ['database', 'rest'],
	},
	{ kind: 'stack.prepare', stackId: STACK, capabilities: [] },
	{ kind: 'migration.list', workdir: WORKDIR, target: 'local' },
	{ kind: 'migration.list', workdir: WORKDIR, target: { dbUrl: DB_URL } },
	{ kind: 'migration.up', workdir: WORKDIR },
	{ kind: 'db.reset', workdir: WORKDIR },
	{ kind: 'db.reset', workdir: WORKDIR, noSeed: true },
	{ kind: 'inspect', name: 'db-stats', workdir: WORKDIR, target: 'local' },
	{
		kind: 'inspect',
		name: 'table-stats',
		workdir: WORKDIR,
		target: { dbUrl: DB_URL },
	},
	{
		kind: 'db.dump',
		workdir: WORKDIR,
		file: '/Users/example/Exports/data.sql',
		target: 'local',
		dataOnly: true,
	},
	{ kind: 'seed.buckets', workdir: WORKDIR },
];

describe('resolveSupabaseDialect', () => {
	it('maps the verified release, newer patches, and everything else', () => {
		expect(verified).toMatchObject({
			gate: 'verified',
			group: 'stack',
			verifiedVersion: '2.121.0',
			fixtures: 'supabase-2.121.0',
			manageable: true,
		});
		expect(resolveSupabaseDialect('2.121.3')).toMatchObject({
			gate: 'compatible',
			verifiedVersion: '2.121.0',
			manageable: false,
		});
		expect(
			resolveSupabaseDialect('2.121.3', { allowUnverifiedPatch: true })
		).toMatchObject({ gate: 'compatible', manageable: true });
		for (const version of ['2.122.0', '2.120.9', '3.0.0', '1.121.0']) {
			expect(resolveSupabaseDialect(version)).toMatchObject({
				gate: 'unsupported',
				reason: 'unverified-release',
			});
		}
		for (const version of ['3.0.0-next.15', '0.0.0-dev', '2.121.0-beta.27']) {
			expect(resolveSupabaseDialect(version)).toMatchObject({
				gate: 'unsupported',
				reason: 'prerelease',
			});
		}
		expect(resolveSupabaseDialect('supabase version 2')).toMatchObject({
			gate: 'unsupported',
			reason: 'unparseable',
		});
	});

	it('records what 2.121.0 can do, including the unclaimed native backend ports', () => {
		if (verified.gate === 'unsupported') throw new Error('unexpected gate');
		expect(verified.features).toEqual({
			multiDestroy: true,
			endpointChanges: true,
			nativeBackendPortClaims: false,
			logs: true,
			restart: true,
			prepare: true,
			migrations: true,
			inspect: true,
			dump: true,
		});
	});

	it('never echoes control characters from an unparseable version', () => {
		const dialect = resolveSupabaseDialect('\u001b[31m2.121.0\u0007');
		expect(
			[...dialect.version].every((character) => character.charCodeAt(0) >= 0x20)
		).toBe(true);
	});
});

describe('buildSupabaseArgv', () => {
	it('spells each operation exactly', () => {
		expect(buildSupabaseArgv(null, { kind: 'version' })).toEqual(['--version']);
		expect(argvOf({ kind: 'stack.list' })).toEqual([
			'stack',
			'list',
			'--output-format',
			'json',
		]);
		expect(argvOf({ kind: 'stack.status', stackId: STACK })).toEqual([
			'stack',
			'status',
			'--stack-id',
			STACK,
			'--output-format',
			'json',
		]);
		expect(
			argvOf({
				kind: 'stack.start',
				workdir: WORKDIR,
				exclude: ['analytics', 'studio', 'studio'],
			})
		).toEqual([
			'stack',
			'start',
			'--workdir',
			WORKDIR,
			'--runtime',
			'native',
			'--exclude',
			'studio,analytics',
			'--output-format',
			'json',
		]);
		expect(
			argvOf({ kind: 'stack.start', stackId: STACK, exclude: [] })
		).toEqual([
			'stack',
			'start',
			'--stack-id',
			STACK,
			'--runtime',
			'native',
			'--output-format',
			'json',
		]);
		expect(
			argvOf({
				kind: 'stack.destroy',
				stackIds: [STACK, OTHER_STACK],
				confirmed: true,
			})
		).toEqual([
			'stack',
			'destroy',
			'--stack-id',
			STACK,
			'--stack-id',
			OTHER_STACK,
			'--yes',
			'--output-format',
			'json',
		]);
		expect(
			argvOf({
				kind: 'stack.logs',
				stackId: STACK,
				services: ['rest', 'rest', 'gateway'],
				tail: 200,
				since: 'start',
			})
		).toEqual([
			'stack',
			'logs',
			'--stack-id',
			STACK,
			'--service',
			'rest',
			'--service',
			'gateway',
			'--tail',
			'200',
			'--since',
			'start',
			'--output-format',
			'json',
		]);
		expect(
			argvOf({
				kind: 'stack.prepare',
				workdir: WORKDIR,
				capabilities: ['rest', 'database'],
			})
		).toEqual([
			'stack',
			'prepare',
			'--workdir',
			WORKDIR,
			'--runtime',
			'native',
			'--capability',
			'database',
			'--capability',
			'rest',
			'--output-format',
			'json',
		]);
		expect(
			argvOf({ kind: 'migration.list', workdir: WORKDIR, target: 'local' })
		).toEqual([
			'migration',
			'list',
			'--local',
			'--workdir',
			WORKDIR,
			'--output-format',
			'json',
		]);
		expect(
			argvOf({ kind: 'db.reset', workdir: WORKDIR, noSeed: true })
		).toEqual([
			'db',
			'reset',
			'--local',
			'--no-seed',
			'--workdir',
			WORKDIR,
			'--output-format',
			'json',
		]);
		expect(
			argvOf({
				kind: 'inspect',
				name: 'db-stats',
				workdir: WORKDIR,
				target: 'local',
			})
		).toEqual([
			'inspect',
			'db',
			'db-stats',
			'--local',
			'--workdir',
			WORKDIR,
			'--output-format',
			'json',
		]);
		expect(
			argvOf({
				kind: 'db.dump',
				workdir: WORKDIR,
				file: '/Users/example/Exports/data.sql',
				target: 'local',
				dataOnly: true,
			})
		).toEqual([
			'db',
			'dump',
			'--local',
			'--workdir',
			WORKDIR,
			'--file',
			'/Users/example/Exports/data.sql',
			'--data-only',
			'--output-format',
			'json',
		]);
		expect(argvOf({ kind: 'seed.buckets', workdir: WORKDIR })).toEqual([
			'seed',
			'buckets',
			'--local',
			'--workdir',
			WORKDIR,
			'--output-format',
			'json',
		]);
	});

	it('passes --runtime native on every create and resume', () => {
		const creates = EVERY_OPERATION.filter(
			(operation) =>
				operation.kind === 'stack.start' || operation.kind === 'stack.prepare'
		);
		expect(creates.length).toBeGreaterThan(0);
		for (const operation of creates) {
			const argv = argvOf(operation);
			const runtime = argv.indexOf('--runtime');
			expect(runtime).toBeGreaterThan(0);
			expect(argv[runtime + 1]).toBe('native');
		}
	});

	it('never emits forbidden flags, and always asks for JSON output', () => {
		const forbidden = new Set([
			'--all',
			'--stack',
			'--env',
			'--override-name',
			'--debug',
			'--dry-run',
			'--linked',
			'--follow',
			'-f',
			'--include-all',
			'--password',
			'--project-ref',
			'auto',
			'docker',
			'podman',
		]);
		for (const operation of EVERY_OPERATION) {
			const argv = argvOf(operation);
			expect(argv.filter((token) => forbidden.has(token))).toEqual([]);
			if (operation.kind === 'version') continue;
			expect(argv.slice(-2)).toEqual(['--output-format', 'json']);
			// Only the stack group, never the top-level start/stop/status aliases.
			expect(['stack', 'migration', 'db', 'inspect', 'seed']).toContain(
				argv[0]
			);
		}
	});

	it('adds --eager only when requested for a create', () => {
		expect(
			argvOf({ kind: 'stack.start', workdir: WORKDIR, exclude: [] })
		).not.toContain('--eager');
		expect(
			argvOf({
				kind: 'stack.start',
				workdir: WORKDIR,
				exclude: [],
				eager: false,
			})
		).not.toContain('--eager');
		expect(
			argvOf({
				kind: 'stack.start',
				workdir: WORKDIR,
				exclude: [],
				eager: true,
			})
		).toContain('--eager');
		const resume = {
			kind: 'stack.start',
			stackId: STACK,
			exclude: [],
			eager: true,
		} as unknown as SupabaseCliOperation;
		expect(argvOf(resume)).not.toContain('--eager');
	});

	it('adds --yes only to a confirmed destroy', () => {
		const unconfirmed = {
			kind: 'stack.destroy',
			stackIds: [STACK],
			confirmed: false,
		} as unknown as SupabaseCliOperation;
		expect(argvOf(unconfirmed)).not.toContain('--yes');
		expect(
			argvOf({ kind: 'stack.destroy', stackIds: [STACK], confirmed: true })
		).toContain('--yes');
		for (const operation of EVERY_OPERATION) {
			if (operation.kind !== 'stack.destroy') {
				expect(argvOf(operation)).not.toContain('--yes');
			}
		}
	});

	it('always names the target of database reads, whose CLI default is the linked project', () => {
		for (const operation of EVERY_OPERATION) {
			if (
				operation.kind !== 'migration.list' &&
				operation.kind !== 'inspect' &&
				operation.kind !== 'db.dump'
			) {
				continue;
			}
			const argv = argvOf(operation);
			expect(
				Number(argv.includes('--local')) + Number(argv.includes('--db-url'))
			).toBe(1);
		}
	});

	it('appends sslmode=disable to loopback database URLs without touching userinfo', () => {
		const argv = argvOf({
			kind: 'migration.list',
			workdir: WORKDIR,
			target: { dbUrl: DB_URL },
		});
		expect(argv[argv.indexOf('--db-url') + 1]).toBe(
			`${DB_URL}?sslmode=disable`
		);
		const withQuery = argvOf({
			kind: 'inspect',
			name: 'table-stats',
			workdir: WORKDIR,
			target: { dbUrl: `${DB_URL}?application_name=rn&sslmode=require` },
		});
		expect(withQuery[withQuery.indexOf('--db-url') + 1]).toBe(
			`${DB_URL}?application_name=rn&sslmode=disable`
		);
		for (const dbUrl of [
			'postgresql://postgres:pw@localhost:5432/postgres',
			'postgresql://postgres:pw@db.example.com:5432/postgres',
			'postgresql://postgres:pw@192.0.2.20:5432/postgres',
			'mysql://root@127.0.0.1:3306/db',
			`${DB_URL}#fragment`,
			'not a url',
		]) {
			expect(
				errorOf(() =>
					argvOf({
						kind: 'migration.list',
						workdir: WORKDIR,
						target: { dbUrl },
					})
				)
			).toMatchObject({ reason: 'invalid-input' });
		}
	});

	it('runs database mutations only against --local, even when a URL is smuggled in', () => {
		for (const kind of ['migration.up', 'db.reset', 'seed.buckets'] as const) {
			const smuggled = {
				kind,
				workdir: WORKDIR,
				target: { dbUrl: DB_URL },
			} as unknown as SupabaseCliOperation;
			const argv = argvOf(smuggled);
			expect(argv).toContain('--local');
			expect(argv).not.toContain('--db-url');
			expect(argv.join(' ')).not.toContain('postgresql://');
		}
	});

	it('accepts only full stack ids, normalized absolute paths, and known capabilities', () => {
		const invalid: unknown[] = [
			{ kind: 'stack.status', stackId: STACK.slice(0, 12) },
			{ kind: 'stack.status', stackId: STACK.toUpperCase() },
			{ kind: 'stack.stop', stackId: `${STACK} --all` },
			{ kind: 'stack.start', workdir: 'relative/path', exclude: [] },
			{ kind: 'stack.start', workdir: `${WORKDIR}/`, exclude: [] },
			{ kind: 'stack.start', workdir: `${WORKDIR}/../Other`, exclude: [] },
			{ kind: 'stack.start', workdir: `${WORKDIR}\nnext`, exclude: [] },
			{ kind: 'stack.start', workdir: WORKDIR, stackId: STACK, exclude: [] },
			{ kind: 'stack.start', exclude: [] },
			{ kind: 'stack.start', workdir: WORKDIR, exclude: ['database'] },
			{ kind: 'stack.start', workdir: WORKDIR, exclude: 'studio' },
			{
				kind: 'stack.prepare',
				workdir: WORKDIR,
				capabilities: ['studio,rest'],
			},
			{ kind: 'stack.destroy', stackIds: [], confirmed: true },
			{ kind: 'stack.destroy', stackIds: [STACK, STACK], confirmed: true },
			{ kind: 'stack.logs', stackId: STACK, tail: -1 },
			{ kind: 'stack.logs', stackId: STACK, tail: 1.5 },
			{ kind: 'stack.logs', stackId: STACK, tail: 5000 },
			{ kind: 'stack.logs', stackId: STACK, tail: 10, since: 'yesterday' },
			{ kind: 'stack.logs', stackId: STACK, tail: 10, services: ['../etc'] },
			{ kind: 'inspect', name: 'locks', workdir: WORKDIR, target: 'local' },
			{ kind: 'db.dump', workdir: WORKDIR, file: 'data.sql', target: 'local' },
			{
				kind: 'db.dump',
				workdir: WORKDIR,
				file: '/tmp/data.sql',
				target: 'linked',
			},
			{ kind: 'secrets.list' },
		];
		for (const operation of invalid) {
			const error = errorOf(() => argvOf(operation as SupabaseCliOperation));
			expect(error).toBeInstanceOf(SupabaseArgvError);
			expect(error).toMatchObject({ reason: 'invalid-input' });
		}
	});

	it('accepts the log window grammar the CLI accepts', () => {
		for (const since of [
			'start',
			'10m',
			'1h30m',
			'1.5h',
			'2026-10-17T06:58:47Z',
		]) {
			expect(
				argvOf({ kind: 'stack.logs', stackId: STACK, tail: 10, since })
			).toContain(since);
		}
		const instance = '13fcca92-620e-4c85-9e1c-d1901558554c';
		expect(
			argvOf({
				kind: 'stack.logs',
				stackId: STACK,
				tail: 0,
				services: [instance],
			})
		).toContain(instance);
	});

	it('error messages never echo argument values', () => {
		const error = errorOf(() =>
			argvOf({
				kind: 'migration.list',
				workdir: WORKDIR,
				target: {
					dbUrl: 'postgresql://postgres:hunter2@db.example.com:5432/x',
				},
			})
		) as Error;
		expect(error.message).not.toContain('hunter2');
	});
});

describe('dialect gates', () => {
	it('lets an unsupported CLI report only its version', () => {
		const unsupported = resolveSupabaseDialect('2.122.0');
		expect(buildSupabaseArgv(unsupported, { kind: 'version' })).toEqual([
			'--version',
		]);
		for (const operation of EVERY_OPERATION) {
			if (operation.kind === 'version') continue;
			expect(errorOf(() => argvOf(operation, unsupported))).toMatchObject({
				reason: 'gate',
			});
		}
		expect(
			errorOf(() =>
				buildSupabaseArgv(null as unknown as SupabaseDialect, {
					kind: 'stack.list',
				})
			)
		).toMatchObject({ reason: 'gate' });
	});

	it('only observes, stops and destroys with an unverified patch', () => {
		const observed = resolveSupabaseDialect('2.121.3');
		const allowed = new Set([
			'version',
			'stack.list',
			'stack.status',
			'stack.logs',
			'migration.list',
			'inspect',
			'db.dump',
			'stack.stop',
			'stack.destroy',
		]);
		for (const operation of EVERY_OPERATION) {
			if (allowed.has(operation.kind)) {
				expect(argvOf(operation, observed).length).toBeGreaterThan(0);
			} else {
				expect(errorOf(() => argvOf(operation, observed))).toMatchObject({
					reason: 'gate',
				});
			}
		}
		const managed = resolveSupabaseDialect('2.121.3', {
			allowUnverifiedPatch: true,
		});
		for (const operation of EVERY_OPERATION) {
			expect(argvOf(operation, managed).length).toBeGreaterThan(0);
		}
	});

	it('refuses operations a dialect lacks', () => {
		if (verified.gate === 'unsupported') throw new Error('unexpected gate');
		const limited: SupabaseDialect = {
			...verified,
			features: { ...verified.features, logs: false, multiDestroy: false },
		};
		expect(
			errorOf(() =>
				argvOf({ kind: 'stack.logs', stackId: STACK, tail: 1 }, limited)
			)
		).toMatchObject({ reason: 'feature' });
		expect(
			errorOf(() =>
				argvOf(
					{
						kind: 'stack.destroy',
						stackIds: [STACK, OTHER_STACK],
						confirmed: true,
					},
					limited
				)
			)
		).toMatchObject({ reason: 'feature' });
		expect(
			argvOf(
				{ kind: 'stack.destroy', stackIds: [STACK], confirmed: true },
				limited
			)
		).toContain(STACK);
	});
});

describe('assertSupabaseArgvAllowed', () => {
	it('allows every argv the builder produces, and only reads in a read-only run', () => {
		const reads = [
			'version',
			'stack.list',
			'stack.status',
			'stack.logs',
			'migration.list',
			'inspect',
		];
		for (const operation of EVERY_OPERATION) {
			const argv = argvOf(operation);
			expect(assertSupabaseArgvAllowed(argv)).toBe(operation.kind);
			if (reads.includes(operation.kind)) {
				expect(assertSupabaseArgvAllowed(argv, true)).toBe(operation.kind);
			} else {
				expect(
					errorOf(() => assertSupabaseArgvAllowed(argv, true))
				).toMatchObject({ reason: 'read-only' });
			}
		}
	});

	it('rejects argv the builder would never produce', () => {
		const json = ['--output-format', 'json'];
		const rejected: string[][] = [
			['stack', 'stop', '--all', ...json],
			['stack', 'stop', ...json],
			['stack', 'status', '--stack-id', STACK, '--env', ...json],
			['stack', 'status', '--stack', 'feature-a', ...json],
			['stack', 'status', '--stack-id', STACK.slice(0, 8), ...json],
			['stack', 'status', '--stack-id', STACK, '--debug', ...json],
			['stack', 'start', '--workdir', WORKDIR, '--runtime', 'auto', ...json],
			['stack', 'start', '--workdir', WORKDIR, '--runtime', 'docker', ...json],
			['stack', 'start', '--workdir', WORKDIR, ...json],
			[
				'stack',
				'start',
				'--stack-id',
				STACK,
				'--runtime',
				'native',
				'--eager',
				...json,
			],
			[
				'stack',
				'start',
				'--workdir',
				WORKDIR,
				'--runtime',
				'native',
				'--exclude',
				'database',
				...json,
			],
			[
				'stack',
				'logs',
				'--stack-id',
				STACK,
				'--tail',
				'10',
				'--follow',
				...json,
			],
			[
				'stack',
				'logs',
				'--stack-id',
				STACK,
				'--tail',
				'10',
				'--output-format',
				'stream-json',
			],
			[
				'stack',
				'destroy',
				'--stack-id',
				STACK,
				'--stack-id',
				STACK,
				'--yes',
				...json,
			],
			['stack', 'restart', '--stack-id', STACK, '--yes', ...json],
			['migration', 'list', '--workdir', WORKDIR, ...json],
			['migration', 'list', '--linked', '--workdir', WORKDIR, ...json],
			['migration', 'list', '--db-url', DB_URL, '--workdir', WORKDIR, ...json],
			[
				'migration',
				'up',
				'--db-url',
				`${DB_URL}?sslmode=disable`,
				'--workdir',
				WORKDIR,
				...json,
			],
			[
				'migration',
				'up',
				'--local',
				'--include-all',
				'--workdir',
				WORKDIR,
				...json,
			],
			['db', 'reset', '--local', '--yes', '--workdir', WORKDIR, ...json],
			[
				'db',
				'reset',
				'--db-url',
				`${DB_URL}?sslmode=disable`,
				'--workdir',
				WORKDIR,
				...json,
			],
			[
				'db',
				'dump',
				'--local',
				'--workdir',
				WORKDIR,
				'--file',
				'/tmp/x.sql',
				'--dry-run',
				...json,
			],
			['inspect', 'db', 'locks', '--local', '--workdir', WORKDIR, ...json],
			['--debug', 'stack', 'list', ...json],
			['start', '--workdir', WORKDIR, ...json],
			['stack', 'list'],
			['stack', 'list', ...json, ...json],
			['stack', 'list', 'extra', ...json],
			['--version', '--debug'],
			[],
		];
		for (const argv of rejected) {
			expect(errorOf(() => assertSupabaseArgvAllowed(argv))).toBeInstanceOf(
				SupabaseArgvError
			);
		}
	});

	it('never echoes argument values when it rejects', () => {
		const error = errorOf(() =>
			assertSupabaseArgvAllowed([
				'migration',
				'list',
				'--db-url',
				'postgresql://postgres:hunter2@127.0.0.1:1/postgres',
				'--workdir',
				WORKDIR,
				'--output-format',
				'json',
			])
		) as Error;
		expect(error.message).not.toContain('hunter2');
		expect(error.message).not.toContain('postgresql');
	});
});

describe('supabaseOperationBudget', () => {
	it('interrupts lifecycle children gently and never SIGKILLs them', () => {
		for (const operation of EVERY_OPERATION) {
			const budget = supabaseOperationBudget(operation);
			expect(budget.timeoutMs).toBeGreaterThan(0);
			const mutation = ![
				'version',
				'stack.list',
				'stack.status',
				'stack.logs',
				'migration.list',
				'inspect',
				'db.dump',
			].includes(operation.kind);
			expect(budget.detached).toBe(mutation);
			if (mutation) {
				expect(budget.forceKillAfterMs).toBeUndefined();
				expect(budget.interruptGraceMs).toBe(45_000);
			} else {
				expect(budget.forceKillAfterMs).toBeGreaterThan(0);
			}
		}
		expect(
			supabaseOperationBudget({
				kind: 'stack.start',
				workdir: WORKDIR,
				exclude: [],
			}).timeoutMs
		).toBe(300_000);
		expect(
			supabaseOperationBudget({
				kind: 'stack.start',
				stackId: STACK,
				exclude: [],
			}).timeoutMs
		).toBe(120_000);
		expect(
			supabaseOperationBudget({
				kind: 'stack.prepare',
				stackId: STACK,
				capabilities: [],
			}).timeoutMs
		).toBe(600_000);
		expect(
			supabaseOperationBudget({ kind: 'db.reset', workdir: WORKDIR }).timeoutMs
		).toBe(180_000);
	});

	it('stays within what the runner accepts, for the largest destroy too', () => {
		// The most ids one destroy may name, each a distinct 64-hex id.
		const stackIds = Array.from({ length: 32 }, (_, index) =>
			index.toString(16).padStart(64, '0')
		);
		const destroy: SupabaseCliOperation = {
			kind: 'stack.destroy',
			stackIds,
			confirmed: true,
		};
		expect(
			argvOf(destroy).filter((value) => value === '--stack-id')
		).toHaveLength(32);
		for (const operation of [...EVERY_OPERATION, destroy]) {
			expect(supabaseOperationBudget(operation).timeoutMs).toBeLessThanOrEqual(
				SUPABASE_MAX_CLI_TIMEOUT_MS
			);
		}
		expect(supabaseOperationBudget(destroy).timeoutMs).toBe(
			SUPABASE_MAX_CLI_TIMEOUT_MS
		);
		expect(
			supabaseOperationBudget({
				kind: 'stack.destroy',
				stackIds: stackIds.slice(0, 3),
				confirmed: true,
			}).timeoutMs
		).toBe(360_000);
	});
});

describe('capability lists', () => {
	it('match the CLI start and prepare options at 2.121.0', () => {
		expect(SUPABASE_EXCLUDABLE_CAPABILITIES).toEqual([
			'rest',
			'auth',
			'realtime',
			'storage',
			'functions',
			'studio',
			'mail',
			'analytics',
			'pooler',
		]);
		expect(SUPABASE_PREPARABLE_CAPABILITIES).toEqual([
			'database',
			...SUPABASE_EXCLUDABLE_CAPABILITIES,
		]);
	});
});

describe('adapter sources', () => {
	const source = (name: string) =>
		readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8');
	const ADAPTER_FILES = [
		'cli-contract.ts',
		'cli-errors.ts',
		'cli-redact.ts',
		'cli-resolver.ts',
		'cli-runner.ts',
	];

	const quotedLiterals = (text: string) =>
		Array.from(
			text.matchAll(/'((?:\\.|[^'\\\n])*)'|"((?:\\.|[^"\\\n])*)"/g),
			(match) => match[1] ?? match[2] ?? ''
		);

	it('spell CLI flags only in the dialect module', () => {
		for (const file of ADAPTER_FILES) {
			const flags = quotedLiterals(source(file)).filter((literal) =>
				/^-{1,2}[a-z]/.test(literal)
			);
			expect({ file, flags }).toEqual({ file, flags: [] });
		}
		expect(
			quotedLiterals(source('dialect.ts')).filter((literal) =>
				/^-{1,2}[a-z]/.test(literal)
			).length
		).toBeGreaterThan(10);
	});

	it('emit --yes from one place and never name a non-native runtime', () => {
		const dialect = source('dialect.ts');
		// Once where a confirmed destroy emits it, once where the destroy
		// allowlist entry accepts it.
		expect(dialect.match(/'--yes'/g)).toHaveLength(2);
		expect(
			dialect.match(/operation\.confirmed === true \? \['--yes'\] : \[\]/g)
		).toHaveLength(1);
		expect(dialect.match(/'--yes': BOOLEAN/g)).toHaveLength(1);
		for (const literal of [
			"'auto'",
			"'docker'",
			"'podman'",
			"'--all'",
			"'--stack'",
			"'--env'",
			"'--override-name'",
			"'--debug'",
			"'--dry-run'",
			"'--linked'",
			"'--follow'",
			"'--include-all'",
			"'stream-json'",
		]) {
			expect(dialect).not.toContain(literal);
		}
	});
});

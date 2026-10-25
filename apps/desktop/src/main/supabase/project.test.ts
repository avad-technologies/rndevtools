import { readFileSync } from 'node:fs';
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeStaticFileSystem } from './bounded-read';
import {
	detectSupabaseProject,
	type SupabaseProjectDetection,
} from './project';

const PRESET_NAMES = [
	'EXPO_PUBLIC_SUPABASE_URL',
	'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
];
// Secret-shaped values are assembled at runtime so none is ever committed.
const PUBLISHABLE_SHAPED = `sb_${'publishable_'}${'X'.repeat(24)}`;
const SECRET_SHAPED = `sb_${'secret_'}${'Y'.repeat(24)}`;

let root: string;
let worktree: string;

function fixtureLines(name: string): string[] {
	const parsed: unknown = JSON.parse(
		readFileSync(
			new URL(`./__fixtures__/supabase-2.121.0/${name}`, import.meta.url),
			'utf8'
		)
	);
	const lines = (parsed as { lines?: unknown }).lines;
	if (
		!Array.isArray(lines) ||
		!lines.every((line): line is string => typeof line === 'string')
	) {
		throw new Error(`${name} has no lines array`);
	}
	return lines;
}

/** 1-based line of the first `text` after the `header` line. */
function lineAfter(
	lines: readonly string[],
	header: string,
	text: string
): number {
	const start = lines.indexOf(header);
	const index = lines.indexOf(text, start + 1);
	if (start === -1 || index === -1)
		throw new Error(`${header} / ${text} not found`);
	return index + 1;
}

async function write(file: string, content: string): Promise<string> {
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, content);
	return file;
}

function found(
	detection: SupabaseProjectDetection
): Extract<SupabaseProjectDetection, { status: 'found' }> {
	if (detection.status !== 'found') {
		throw new Error(`expected a project, got ${detection.reason}`);
	}
	return detection;
}

beforeEach(async () => {
	root = await realpath(
		await mkdtemp(path.join(os.tmpdir(), 'rndevtools-supabase-project-'))
	);
	worktree = path.join(root, 'example-app');
	await mkdir(worktree);
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe('detectSupabaseProject', () => {
	it('recognizes a project created by supabase init for the stack backend', async () => {
		const lines = fixtureLines('project-config-stack.json');
		const configPath = await write(
			path.join(worktree, 'supabase', 'config.toml'),
			`${lines.join('\n')}\n`
		);
		await write(
			path.join(worktree, 'pnpm-lock.yaml'),
			'lockfileVersion: 9.0\n'
		);
		const detection = await detectSupabaseProject({
			appPath: worktree,
			worktreePath: worktree,
			mappedNames: PRESET_NAMES,
		});
		expect(detection).toEqual({
			status: 'found',
			appRoot: worktree,
			worktreeRoot: worktree,
			projectRoot: worktree,
			configPath,
			stackFlag: {
				optedIn: true,
				line: lineAfter(lines, '[experimental]', 'stack = true'),
			},
			configConflict: false,
			projectId: 'example-app',
			studioEnabled: true,
			analyticsEnabled: true,
			s3ProtocolEnabled: true,
			pinnedListeners: [],
			shadowedAppVariables: [],
			runner: {
				command: 'pnpm exec',
				lockfile: path.join(worktree, 'pnpm-lock.yaml'),
			},
			fileIssues: [],
		});
	});

	it('lists every Docker-era pinned listener of the legacy template with its line', async () => {
		const lines = fixtureLines('project-config-legacy.json');
		const file = await write(
			path.join(worktree, 'supabase', 'config.toml'),
			`${lines.join('\n')}\n`
		);
		const detection = found(
			await detectSupabaseProject({ appPath: worktree, worktreePath: worktree })
		);
		expect(detection.stackFlag).toEqual({ optedIn: false, reason: 'missing' });
		const pin = (key: string, header: string, text: string, port: number) => ({
			source: 'config',
			file,
			line: lineAfter(lines, header, text),
			key,
			port,
		});
		expect(detection.pinnedListeners).toEqual([
			pin('api.port', '[api]', 'port = 54321', 54_321),
			pin('db.port', '[db]', 'port = 54322', 54_322),
			pin('db.shadow_port', '[db]', 'shadow_port = 54320', 54_320),
			pin('db.pooler.port', '[db.pooler]', 'port = 54329', 54_329),
			pin('studio.port', '[studio]', 'port = 54323', 54_323),
			pin('local_smtp.port', '[local_smtp]', 'port = 54324', 54_324),
			pin(
				'edge_runtime.inspector_port',
				'[edge_runtime]',
				'inspector_port = 8083',
				8083
			),
			pin('analytics.port', '[analytics]', 'port = 54327', 54_327),
		]);
		expect(detection.runner).toBeUndefined();
	});

	it('finds the deprecated [inbucket] alias and ignores non-listener ports', async () => {
		const file = await write(
			path.join(worktree, 'supabase', 'config.toml'),
			[
				'[inbucket]',
				'port = 54324',
				'smtp_port = 54325',
				'pop3_port = 54326',
				'[auth.email.smtp]',
				'port = 587',
				'[remotes.staging.api]',
				'port = 54331',
				'[db]',
				'pooler = { port = 54329 }',
			].join('\n')
		);
		const detection = found(
			await detectSupabaseProject({ appPath: worktree, worktreePath: worktree })
		);
		expect(detection.pinnedListeners).toEqual([
			{ source: 'config', file, line: 2, key: 'inbucket.port', port: 54_324 },
			{
				source: 'config',
				file,
				line: 3,
				key: 'inbucket.smtp_port',
				port: 54_325,
			},
			{
				source: 'config',
				file,
				line: 4,
				key: 'inbucket.pop3_port',
				port: 54_326,
			},
			{ source: 'config', file, line: 10, key: 'db.pooler.port', port: 54_329 },
		]);
	});

	it.each([
		[
			'table form',
			'[experimental]\nstack = true\n',
			{ optedIn: true, line: 2 },
		],
		['dotted form', 'experimental.stack = true\n', { optedIn: true, line: 1 }],
		[
			'inline table',
			'experimental = { stack = true }\n',
			{ optedIn: true, line: 1 },
		],
		[
			'false',
			'[experimental]\nstack = false\n',
			{ optedIn: false, reason: 'false', line: 2 },
		],
		[
			'a string',
			'[experimental]\nstack = "true"\n',
			{ optedIn: false, reason: 'not-boolean', line: 2 },
		],
		[
			'a number',
			'[experimental]\nstack = 1\n',
			{ optedIn: false, reason: 'not-boolean', line: 2 },
		],
		[
			'an env() reference',
			'[experimental]\nstack = "env(SUPABASE_EXPERIMENTAL_STACK)"\n',
			{ optedIn: false, reason: 'env-reference', line: 2 },
		],
		[
			'a redefinition',
			'experimental.stack = true\n[experimental]\nstack = true\n',
			{ optedIn: false, reason: 'duplicate', line: 3 },
		],
		[
			'another table',
			'[experimental.pgdelta]\nstack = true\n',
			{ optedIn: false, reason: 'missing' },
		],
	])('reads the stack opt-in in %s', async (_label, toml, expected) => {
		await write(path.join(worktree, 'supabase', 'config.toml'), toml);
		const detection = found(
			await detectSupabaseProject({ appPath: worktree, worktreePath: worktree })
		);
		expect(detection.stackFlag).toEqual(expected);
	});

	it('flags supabase/config.json next to config.toml as a conflict', async () => {
		await write(
			path.join(worktree, 'supabase', 'config.toml'),
			'[experimental]\nstack = true\n'
		);
		await write(path.join(worktree, 'supabase', 'config.json'), '{}\n');
		const detection = found(
			await detectSupabaseProject({ appPath: worktree, worktreePath: worktree })
		);
		expect(detection.configConflict).toBe(true);
		expect(detection.stackFlag).toEqual({ optedIn: true, line: 2 });
	});

	it('climbs from a monorepo app to the worktree root, nearest config first', async () => {
		const app = path.join(worktree, 'apps', 'mobile');
		await mkdir(app, { recursive: true });
		await write(
			path.join(worktree, 'supabase', 'config.toml'),
			'project_id = "root"\n'
		);
		await write(path.join(worktree, 'yarn.lock'), '# yarn\n');
		const fromRoot = found(
			await detectSupabaseProject({ appPath: app, worktreePath: worktree })
		);
		expect(fromRoot).toMatchObject({
			appRoot: app,
			projectRoot: worktree,
			projectId: 'root',
			runner: { command: 'yarn', lockfile: path.join(worktree, 'yarn.lock') },
		});
		await write(
			path.join(app, 'supabase', 'config.toml'),
			'project_id = "app"\n'
		);
		await write(path.join(app, 'bun.lock'), '{}\n');
		expect(
			await detectSupabaseProject({ appPath: app, worktreePath: worktree })
		).toMatchObject({
			projectRoot: app,
			projectId: 'app',
			runner: { command: 'bunx', lockfile: path.join(app, 'bun.lock') },
		});
	});

	it('never reads above the worktree root', async () => {
		await write(
			path.join(root, 'supabase', 'config.toml'),
			'[experimental]\nstack = true\n'
		);
		await write(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
		expect(
			await detectSupabaseProject({ appPath: worktree, worktreePath: worktree })
		).toEqual({ status: 'none', reason: 'no-config' });
		await write(path.join(worktree, 'supabase', 'config.toml'), '');
		expect(
			found(
				await detectSupabaseProject({
					appPath: worktree,
					worktreePath: worktree,
				})
			)
		).not.toHaveProperty('runner');
	});

	it('rejects paths it should not resolve', async () => {
		const outside = path.join(root, 'elsewhere');
		await mkdir(outside);
		expect(
			await detectSupabaseProject({ appPath: outside, worktreePath: worktree })
		).toEqual({ status: 'none', reason: 'app-outside-worktree' });
		expect(
			await detectSupabaseProject({
				appPath: 'apps/mobile',
				worktreePath: worktree,
			})
		).toEqual({ status: 'none', reason: 'invalid-path' });
		expect(
			await detectSupabaseProject({
				appPath: path.join(worktree, 'missing'),
				worktreePath: worktree,
			})
		).toEqual({ status: 'none', reason: 'missing-path' });
	});

	it('finds SUPABASE_*_PORT pins in supabase/ and project-root dotenv files', async () => {
		await write(path.join(worktree, 'supabase', 'config.toml'), '');
		const supabaseEnv = await write(
			path.join(worktree, 'supabase', '.env'),
			'# local overrides\nSUPABASE_API_PORT=54321\n'
		);
		const supabaseLocal = await write(
			path.join(worktree, 'supabase', '.env.local'),
			'export SUPABASE_DB_PORT="54322"\nSUPABASE_AUTH_EMAIL_SMTP_PORT=587\n'
		);
		const rootEnv = await write(
			path.join(worktree, '.env'),
			'SUPABASE_STUDIO_PORT = 54323\n# SUPABASE_DB_POOLER_PORT=54329\n'
		);
		const rootLocal = await write(
			path.join(worktree, '.env.local'),
			'OTHER=1\nSUPABASE_DB_SHADOW_PORT=env-dependent\n'
		);
		const rootDevelopment = await write(
			path.join(worktree, '.env.development'),
			'SUPABASE_ANALYTICS_PORT=54327\n'
		);
		const detection = found(
			await detectSupabaseProject({ appPath: worktree, worktreePath: worktree })
		);
		expect(detection.pinnedListeners).toEqual([
			{
				source: 'dotenv',
				file: supabaseLocal,
				line: 1,
				key: 'SUPABASE_DB_PORT',
				port: 54_322,
			},
			{
				source: 'dotenv',
				file: supabaseEnv,
				line: 2,
				key: 'SUPABASE_API_PORT',
				port: 54_321,
			},
			{
				source: 'dotenv',
				file: rootLocal,
				line: 2,
				key: 'SUPABASE_DB_SHADOW_PORT',
			},
			{
				source: 'dotenv',
				file: rootDevelopment,
				line: 1,
				key: 'SUPABASE_ANALYTICS_PORT',
				port: 54_327,
			},
			{
				source: 'dotenv',
				file: rootEnv,
				line: 1,
				key: 'SUPABASE_STUDIO_PORT',
				port: 54_323,
			},
		]);
	});

	it('lists app dotenv lines that would shadow mapped Metro variables, never values', async () => {
		const app = path.join(worktree, 'apps', 'mobile');
		await write(path.join(worktree, 'supabase', 'config.toml'), '');
		const files = {
			env: await write(
				path.join(app, '.env'),
				'EXPO_PUBLIC_SUPABASE_URL=https://example.supabase.co\n'
			),
			local: await write(
				path.join(app, '.env.local'),
				`# copied from status --env\nSECRET_KEY=${SECRET_SHAPED}\nEXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${PUBLISHABLE_SHAPED}\n`
			),
			development: await write(
				path.join(app, '.env.development'),
				'EXPO_PUBLIC_OTHER=1\n  export EXPO_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321"\n'
			),
			developmentLocal: await write(
				path.join(app, '.env.development.local'),
				'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY="<publishable-key>"\n'
			),
		};
		// The worktree root's .env belongs to the project, not to the app bundle.
		await write(
			path.join(worktree, '.env'),
			'EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:1\n'
		);
		const detection = found(
			await detectSupabaseProject({
				appPath: app,
				worktreePath: worktree,
				mappedNames: [...PRESET_NAMES, 'not valid', 'lower_case_ok'],
			})
		);
		expect(detection.shadowedAppVariables).toEqual([
			{ name: 'EXPO_PUBLIC_SUPABASE_URL', file: files.env, line: 1 },
			{
				name: 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
				file: files.local,
				line: 3,
			},
			{ name: 'EXPO_PUBLIC_SUPABASE_URL', file: files.development, line: 2 },
			{
				name: 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
				file: files.developmentLocal,
				line: 1,
			},
		]);
		const serialized = JSON.stringify(detection);
		for (const value of [
			PUBLISHABLE_SHAPED,
			SECRET_SHAPED,
			'example.supabase.co',
			'<publishable-key>',
			'127.0.0.1',
		]) {
			expect(serialized).not.toContain(value);
		}
	});

	it('skips the Expo dotenv scan when no names are mapped', async () => {
		await write(path.join(worktree, 'supabase', 'config.toml'), '');
		await write(path.join(worktree, '.env'), 'EXPO_PUBLIC_SUPABASE_URL=x\n');
		const detection = found(
			await detectSupabaseProject({ appPath: worktree, worktreePath: worktree })
		);
		expect(detection.shadowedAppVariables).toEqual([]);
	});

	it.each([
		['pnpm-lock.yaml', 'pnpm exec'],
		['package-lock.json', 'npx'],
		['yarn.lock', 'yarn'],
		['bun.lockb', 'bunx'],
		['bun.lock', 'bunx'],
	])('derives the runner from %s', async (lockfile, command) => {
		await write(path.join(worktree, 'supabase', 'config.toml'), '');
		await write(path.join(worktree, lockfile), '\n');
		expect(
			found(
				await detectSupabaseProject({
					appPath: worktree,
					worktreePath: worktree,
				})
			).runner
		).toEqual({ command, lockfile: path.join(worktree, lockfile) });
	});

	it('caps every static read at 256 KiB', async () => {
		const configPath = await write(
			path.join(worktree, 'supabase', 'config.toml'),
			`[experimental]\nstack = true\n${'# padding\n'.repeat(27_000)}`
		);
		const dotenv = await write(
			path.join(worktree, 'supabase', '.env'),
			`SUPABASE_API_PORT=54321\n${'#'.repeat(300 * 1024)}\n`
		);
		const detection = found(
			await detectSupabaseProject({ appPath: worktree, worktreePath: worktree })
		);
		expect(detection.stackFlag).toEqual({
			optedIn: false,
			reason: 'unreadable-config',
		});
		expect(detection.pinnedListeners).toEqual([]);
		expect(detection.fileIssues).toEqual([
			{ file: configPath, issue: 'too-large' },
			{ file: dotenv, issue: 'too-large' },
		]);
	});

	it('reports a config path that is not a regular file', async () => {
		const configPath = path.join(worktree, 'supabase', 'config.toml');
		await mkdir(path.dirname(configPath), { recursive: true });
		await symlink('/dev/null', configPath);
		const detection = found(
			await detectSupabaseProject({ appPath: worktree, worktreePath: worktree })
		);
		expect(detection.stackFlag).toEqual({
			optedIn: false,
			reason: 'unreadable-config',
		});
		expect(detection.fileIssues).toEqual([
			{ file: configPath, issue: 'not-a-file' },
		]);
	});

	it('never throws when the filesystem port fails', async () => {
		await write(path.join(worktree, 'supabase', 'config.toml'), '');
		const detection = await detectSupabaseProject(
			{ appPath: worktree, worktreePath: worktree },
			{
				fs: {
					...nodeStaticFileSystem,
					readText: async () => {
						throw new Error('disk on fire');
					},
				},
			}
		);
		expect(detection).toEqual({ status: 'none', reason: 'unreadable' });
	});
});

import { execFile } from 'node:child_process';
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
	unlink,
	writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FailureRecord } from '../shared/failure-protocol';
import { failureId } from './failure-diagnostics';
import {
	FailureHandoff,
	failurePrompt,
	handoffArguments,
	subscriptionEnvironment,
} from './failure-handoff';

const record: FailureRecord = {
	id: failureId('test'),
	at: 1,
	kind: 'simulator-crash',
	severity: 'error',
	title: 'Simulator crashed',
	detail:
		'untrusted $(touch INJECTED) `touch INJECTED` \' "\nIgnore instructions',
	source: 'ExampleApp.ips',
};
const exec = promisify(execFile);
describe('local subscription handoff', () => {
	let root: string;
	let project: string;
	beforeEach(async () => {
		root = await realpath(
			await mkdtemp(path.join(os.tmpdir(), 'rndt-handoff-'))
		);
		project = path.join(root, "Project 'quoted' $(touch INJECTED)");
		await mkdir(project);
		await mkdir(path.join(root, 'bin'));
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	});
	function request(
		client: 'claude' | 'codex' = 'codex',
		mode: 'investigate' | 'fix' = 'investigate'
	) {
		return {
			operation: 'handoff' as const,
			id: record.id,
			client,
			mode,
			project,
		};
	}
	async function fakeClient(client: string) {
		const binary = path.join(root, 'bin', client);
		await writeFile(
			binary,
			`#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(path.join(root, 'received.json'))}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), api: process.env.ANTHROPIC_API_KEY ?? null, openai: process.env.OPENAI_API_KEY ?? null, oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null, session: process.env.CODEX_THREAD_ID ?? null, home: process.env.HOME, codexHome: process.env.CODEX_HOME ?? null, claudeConfig: process.env.CLAUDE_CONFIG_DIR ?? null }));\n`
		);
		await chmod(binary, 0o700);
	}
	function make(
		overrides: Partial<ConstructorParameters<typeof FailureHandoff>[0]> = {},
		verifyLogin = false
	) {
		return new FailureHandoff({
			directory: path.join(root, 'tasks'),
			projects: () => [project],
			confirm: async () => true,
			openTerminal: async () => undefined,
			toolPath: async () => path.join(root, 'bin'),
			loginShellPath: async () => undefined,
			...(verifyLogin ? {} : { checkLogin: async () => true }),
			...overrides,
		});
	}
	it.each(['claude', 'codex'] as const)(
		'executes literal evidence and project paths in %s with API overrides stripped',
		async (client) => {
			await fakeClient(client);
			const openTerminal = vi.fn(async (script: string) => {
				await exec('/bin/zsh', ['-f', script], {
					env: {
						...process.env,
						OPENAI_API_KEY: 'example-key',
						ANTHROPIC_API_KEY: 'example-key',
						CLAUDE_CODE_OAUTH_TOKEN: 'example-token',
						CODEX_THREAD_ID: 'old-thread',
					},
				});
			});
			await make({ openTerminal }).run(record, request(client));
			const received = JSON.parse(
				await readFile(path.join(root, 'received.json'), 'utf8')
			);
			expect(received).toMatchObject({
				cwd: project,
				api: null,
				openai: null,
				oauth: null,
				session: null,
			});
			expect(received.args).toEqual(
				handoffArguments(
					client,
					'investigate',
					failurePrompt(record, 'investigate', project)
				)
			);
			await expect(stat(path.join(project, 'INJECTED'))).rejects.toMatchObject({
				code: 'ENOENT',
			});
			const script = openTerminal.mock.calls[0]?.[0] as string;
			expect((await stat(script)).mode & 0o777).toBe(0o700);
			expect((await stat(script.replace('.command', '.md'))).mode & 0o777).toBe(
				0o600
			);
		}
	);
	it('falls back to the login-shell PATH when Node is present but the selected CLI is missing', async () => {
		await fakeClient('codex');
		const openTerminal = vi.fn(async () => undefined);
		await make({
			toolPath: async () => '/usr/bin:/bin',
			loginShellPath: async () => path.join(root, 'bin'),
			openTerminal,
		}).run(record, request());
		expect(openTerminal).toHaveBeenCalledOnce();
	});
	it('launches with the same credential directories checked before confirmation', async () => {
		await fakeClient('codex');
		vi.stubEnv('CODEX_HOME', path.join(root, 'checked-config'));
		vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
		await make({
			openTerminal: async (script) => {
				await exec('/bin/zsh', ['-f', script], {
					env: {
						...process.env,
						HOME: '/different-home',
						CODEX_HOME: '/different-codex',
						CLAUDE_CONFIG_DIR: '/different-claude',
					},
				});
			},
		}).run(record, request());
		const received = JSON.parse(
			await readFile(path.join(root, 'received.json'), 'utf8')
		);
		expect(received).toMatchObject({
			home: process.env.HOME,
			codexHome: path.join(root, 'checked-config'),
			claudeConfig: null,
		});
	});
	it('cancels without writing tasks or opening a terminal', async () => {
		await fakeClient('codex');
		const openTerminal = vi.fn();
		expect(
			await make({ confirm: async () => false, openTerminal }).run(
				record,
				request()
			)
		).toEqual({ cancelled: true });
		expect(openTerminal).not.toHaveBeenCalled();
		await expect(readdir(path.join(root, 'tasks'))).rejects.toMatchObject({
			code: 'ENOENT',
		});
	});
	it('refuses unknown projects, missing tools and unverified subscription login before confirmation', async () => {
		const confirm = vi.fn(async () => true);
		await expect(
			make({ confirm }).run(record, { ...request(), project: root })
		).rejects.toThrow('registered');
		await expect(make({ confirm }).run(record, request())).rejects.toThrow(
			'Install'
		);
		await fakeClient('codex');
		await expect(
			make({ confirm, checkLogin: async () => false }).run(record, request())
		).rejects.toThrow('Subscription login could not be verified');
		expect(confirm).not.toHaveBeenCalled();
	});
	it('refuses a project symlink changed during confirmation', async () => {
		await fakeClient('codex');
		const target = project;
		const link = path.join(root, 'link');
		await symlink(target, link);
		project = link;
		await expect(
			make({
				confirm: async () => {
					await unlink(link);
					await symlink(root, link);
					return true;
				},
			}).run(record, request())
		).rejects.toThrow('project changed');
	});
	it.each([
		['codex', 'Logged in using ChatGPT', true],
		['codex', 'Logged in using an API key', false],
		[
			'claude',
			JSON.stringify({
				loggedIn: true,
				authMethod: 'claude.ai',
				apiProvider: 'firstParty',
			}),
			true,
		],
		[
			'claude',
			JSON.stringify({
				loggedIn: true,
				authMethod: 'api_key',
				apiProvider: 'firstParty',
			}),
			false,
		],
	] as const)(
		'verifies %s subscription status without invoking a model (%s)',
		async (client, output, accepted) => {
			const binary = path.join(root, 'bin', client);
			await writeFile(
				binary,
				`#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output)});\n`
			);
			await chmod(binary, 0o700);
			const openTerminal = vi.fn(async () => undefined);
			const result = make({ openTerminal }, true).run(record, request(client));
			if (accepted) {
				await result;
				expect(openTerminal).toHaveBeenCalledOnce();
			} else {
				await expect(result).rejects.toThrow(
					'Subscription login could not be verified'
				);
				expect(openTerminal).not.toHaveBeenCalled();
			}
		}
	);
	it('keeps normal CLI approval modes and only removes auth/session overrides', () => {
		expect(
			subscriptionEnvironment({
				PATH: '/usr/bin',
				OPENAI_API_KEY: 'secret',
				ANTHROPIC_BASE_URL: 'https://example.com',
				CODEX_THREAD_ID: 'old',
				KEEP: 'yes',
			})
		).toEqual({ PATH: '/usr/bin', KEEP: 'yes' });
		expect(handoffArguments('codex', 'fix', 'task')).toContain(
			'workspace-write'
		);
		expect(handoffArguments('claude', 'fix', 'task')).toContain('default');
		expect(handoffArguments('claude', 'investigate', 'task')).toContain('plan');
	});
});

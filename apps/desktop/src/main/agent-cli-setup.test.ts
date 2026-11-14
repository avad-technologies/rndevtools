import { describe, expect, it, vi } from 'vitest';
import { runAgentCliSetup, summarizeAgentCliSetup } from './agent-cli-setup';

const { execFile } = vi.hoisted(() => ({
	execFile: vi.fn(
		(
			_file: string,
			_args: string[],
			_options: object,
			callback: (error: null, result: { stdout: string }) => void
		) =>
			callback(null, {
				stdout: JSON.stringify({
					executable: '/x',
					changes: [],
					doctor: {
						ok: false,
						skipped: true,
						message: 'Skipped (--no-doctor).',
					},
				}),
			})
	),
}));
vi.mock('node:child_process', () => ({ execFile }));

describe('summarizeAgentCliSetup', () => {
	it('turns the CLI report into short lines with home-relative paths', () => {
		const lines = summarizeAgentCliSetup(
			JSON.stringify({
				dryRun: false,
				executable:
					'/Applications/RN Devtools.app/Contents/Resources/native/rndevtools',
				changes: [
					{
						path: '/Users/me/.local/bin/rndevtools',
						action: 'create',
						detail: 'symlink',
					},
					{ path: '/Users/me/.claude.json', action: 'update' },
					{ path: '/Users/me/.codex/config.toml', action: 'unchanged' },
					{
						path: '/Users/me/.cursor/mcp.json',
						action: 'skip',
						detail: 'not valid JSON; fix it by hand, then rerun setup',
					},
				],
				agentsBlock: '...',
				doctor: { ok: true, result: { healthy: true } },
			}),
			'/Users/me'
		);
		expect(lines).toEqual([
			'Created ~/.local/bin/rndevtools',
			'Updated ~/.claude.json',
			'Already current ~/.codex/config.toml',
			'Skipped ~/.cursor/mcp.json: not valid JSON; fix it by hand, then rerun setup',
			'Restart your coding agent to load updated MCP registrations and command rules.',
			'For Terminal commands, add ~/.local/bin to your shell PATH if needed; MCP uses the absolute executable path.',
			'The RN Devtools desktop connection is working.',
		]);
		expect(
			summarizeAgentCliSetup(
				JSON.stringify({
					executable: '/x',
					changes: [],
					doctor: { ok: true },
					codexHooksNeedTrust: true,
				}),
				'/Users/me'
			)
		).toEqual([
			'Review new or changed RN Devtools hooks once in Codex with /hooks. Unchanged hooks keep their approval.',
			'The RN Devtools desktop connection is working.',
		]);
	});

	it('explains an unreachable desktop and rejects an unexpected report', () => {
		const lines = summarizeAgentCliSetup(
			JSON.stringify({
				executable: '/x',
				changes: [],
				doctor: { ok: false, message: 'socket missing' },
			}),
			'/Users/me'
		);
		expect(lines).toEqual([
			'Agents will reach RN Devtools once it is running (socket missing).',
		]);
		expect(() => summarizeAgentCliSetup('{"nope":1}', '/Users/me')).toThrow();
	});

	it('skips the closing doctor on request and says so', async () => {
		// An isolated test home's setup would otherwise dial the socket under
		// the real home: an installed RN Devtools, not the desktop under test.
		await expect(
			runAgentCliSetup('/x/rndevtools', '/fixture', { doctor: false })
		).resolves.toEqual([
			'Setup skipped its RN Devtools desktop connection check.',
		]);
		expect(execFile).toHaveBeenLastCalledWith(
			'/x/rndevtools',
			['setup', '--config-home', '/fixture', '--no-doctor'],
			expect.anything(),
			expect.any(Function)
		);
		await runAgentCliSetup('/x/rndevtools', '/Users/me');
		expect(execFile.mock.lastCall?.[1]).toEqual([
			'setup',
			'--config-home',
			'/Users/me',
		]);
	});

	it('runs the CLI without the agent session the desktop was started from', async () => {
		// The CLI reads a session's identity from its environment and would set
		// up, and dial the desktop, as that session.
		await runAgentCliSetup('/x/rndevtools', '/Users/me', {
			environment: {
				HOME: '/Users/me',
				PATH: '/usr/bin:/bin',
				CLAUDE_CODE_SESSION_ID: 'session-1',
				CLAUDE_CODE_MESSAGING_TOKEN: 'example-token',
				CODEX_THREAD_ID: 'thread-1',
				RNDEVTOOLS_AGENT_SESSION_ID: 'session-2',
				EXAMPLE_AGENT_TOKEN: 'example-secret',
				RNDEVTOOLS_CHILD_ENV_STRIP: 'EXAMPLE_AGENT_*',
			},
		});
		const options = execFile.mock.lastCall?.[2] as
			| { env?: NodeJS.ProcessEnv }
			| undefined;
		expect(options?.env).toEqual({
			HOME: '/Users/me',
			PATH: '/usr/bin:/bin',
			RNDEVTOOLS_CHILD_ENV_STRIP: 'EXAMPLE_AGENT_*',
		});
	});

	it('runs nothing while RNDEVTOOLS_CHILD_ENV_STRIP cannot be read', async () => {
		const calls = execFile.mock.calls.length;
		await expect(
			runAgentCliSetup('/x/rndevtools', '/Users/me', {
				environment: {
					HOME: '/Users/me',
					RNDEVTOOLS_CHILD_ENV_STRIP: 'EXAMPLE_FIRST,EXAMPLE TOKEN',
				},
			})
		).rejects.toThrow(/^RNDEVTOOLS_CHILD_ENV_STRIP entry 2 is not /);
		expect(execFile.mock.calls).toHaveLength(calls);
	});
});

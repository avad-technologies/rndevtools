import { describe, expect, it } from 'vitest';
import { summarizeAgentCliSetup } from './agent-cli-setup';

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
			'Agents can reach RN Devtools now.',
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
			'Codex runs new hooks only after you trust them: open Codex and run /hooks.',
			'Agents can reach RN Devtools now.',
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
});

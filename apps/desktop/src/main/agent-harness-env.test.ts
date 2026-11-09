import { describe, expect, it } from 'vitest';
import {
	AGENT_SESSION_ENV_NAMES,
	childEnvironmentStrip,
	isAgentHarnessVariable,
} from './agent-harness-env';

describe('isAgentHarnessVariable', () => {
	it.each([
		// Claude Code and the Claude Agent SDK.
		'CLAUDECODE',
		'CLAUDE_CODE_ENTRYPOINT',
		'CLAUDE_CODE_SESSION_ID',
		'CLAUDE_CODE_MESSAGING_SOCKET',
		'CLAUDE_CODE_MESSAGING_TOKEN',
		'CLAUDE_CODE_OAUTH_TOKEN',
		'CLAUDE_AGENT_SDK_VERSION',
		'CLAUDE_CONFIG_DIR',
		'CLAUDE_PID',
		'DEBUG_CLAUDE_AGENT_SDK',
		// Codex.
		'CODEX_THREAD_ID',
		'CODEX_HOME',
		'CODEX_SANDBOX',
		// Any agent harness, and the rndevtools CLI's own override.
		'AI_AGENT',
		'RNDEVTOOLS_AGENT_SESSION_ID',
	])('strips %s', (name) => {
		expect(isAgentHarnessVariable(name)).toBe(true);
	});

	it.each([
		'DEBUG',
		'HOME',
		'PATH',
		'AWS_PROFILE',
		'NODE_OPTIONS',
		// Provider credentials may serve the app itself, such as an API route.
		'ANTHROPIC_API_KEY',
		'OPENAI_API_KEY',
		// A prefix matches only at the start of a name, and only in its case.
		'EXAMPLE_CLAUDE_MODEL',
		'EXAMPLE_CODEX_URL',
		'CLAUDE',
		'claude_code_session_id',
	])('keeps %s', (name) => {
		expect(isAgentHarnessVariable(name)).toBe(false);
	});

	it('covers every exact session name a failure handoff unsets', () => {
		for (const name of AGENT_SESSION_ENV_NAMES) {
			expect(isAgentHarnessVariable(name)).toBe(true);
			expect(name).toMatch(/^[A-Z_][A-Z0-9_]*$/);
		}
	});
});

describe('childEnvironmentStrip', () => {
	it('strips agent harness variables when the desktop lists nothing more', () => {
		for (const environment of [
			{},
			{ RNDEVTOOLS_CHILD_ENV_STRIP: '' },
			{ RNDEVTOOLS_CHILD_ENV_STRIP: ' , ,' },
		]) {
			const strip = childEnvironmentStrip(environment);
			expect(strip('CLAUDE_CODE_SESSION_ID')).toBe(true);
			expect(strip('AI_AGENT')).toBe(true);
			expect(strip('HOME')).toBe(false);
			expect(strip('EXAMPLE_AGENT_PORT')).toBe(false);
		}
	});

	it('adds the exact names and NAME_PREFIX* patterns RNDEVTOOLS_CHILD_ENV_STRIP lists', () => {
		const strip = childEnvironmentStrip({
			RNDEVTOOLS_CHILD_ENV_STRIP: ' EXAMPLE_AGENT_* , EXAMPLE_TOKEN,,',
		});
		expect(strip('EXAMPLE_AGENT_PORT')).toBe(true);
		expect(strip('EXAMPLE_AGENT_AUTH_TOKEN')).toBe(true);
		expect(strip('EXAMPLE_TOKEN')).toBe(true);
		// An exact name is only that name, a pattern only its prefix, and
		// both are case-sensitive.
		expect(strip('EXAMPLE_TOKEN_TTL')).toBe(false);
		expect(strip('EXAMPLE_AGENTS')).toBe(false);
		expect(strip('example_token')).toBe(false);
		expect(strip('HOME')).toBe(false);
		expect(strip('CODEX_THREAD_ID')).toBe(true);
	});

	it.each([
		['a bare star', '*'],
		['a dash', 'EXAMPLE-AGENT'],
		['a space', 'EXAMPLE TOKEN'],
		['an inner star', 'EXAMPLE_*_TOKEN'],
		['a leading star', '*_TOKEN'],
		['two stars', 'EXAMPLE_**'],
		['a value', 'EXAMPLE_TOKEN=example-secret'],
		['a leading digit', '1EXAMPLE'],
		['an oversized name', `EXAMPLE_${'X'.repeat(121)}`],
	])('refuses %s and says which entry, without echoing it', (_, entry) => {
		let failure: unknown;
		try {
			childEnvironmentStrip({
				RNDEVTOOLS_CHILD_ENV_STRIP: `EXAMPLE_FIRST,${entry}`,
			});
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		const message = (failure as Error).message;
		expect(message).toMatch(
			/^RNDEVTOOLS_CHILD_ENV_STRIP entry 2 is not a variable name or a NAME_PREFIX\* pattern\./
		);
		expect(message).not.toContain('example-secret');
		expect(message).not.toContain('XXXX');
	});

	it('refuses a list longer than its bounds', () => {
		const entries = Array.from(
			{ length: 65 },
			(_, index) => `EXAMPLE_${index}`
		);
		expect(() =>
			childEnvironmentStrip({ RNDEVTOOLS_CHILD_ENV_STRIP: entries.join(',') })
		).toThrow(/^RNDEVTOOLS_CHILD_ENV_STRIP lists more than 64 entries\./);
		expect(() =>
			childEnvironmentStrip({
				RNDEVTOOLS_CHILD_ENV_STRIP: entries.slice(0, 64).join(','),
			})
		).not.toThrow();
		expect(() =>
			childEnvironmentStrip({
				RNDEVTOOLS_CHILD_ENV_STRIP: `EXAMPLE_TOKEN,${' '.repeat(4_096)}`,
			})
		).toThrow(/^RNDEVTOOLS_CHILD_ENV_STRIP is longer than 4096 characters\./);
	});
});

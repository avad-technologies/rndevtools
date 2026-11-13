import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const desktopSource = fileURLToPath(new URL('./', import.meta.url));
/** Where the texts main hands to agents live: errors, recoveries, notes. */
const agentTextRoots = ['main', 'shared'].map((root) =>
	path.join(desktopSource, root)
);

/**
 * An rndevtools operation written as a positional word, as the CLI's
 * agent_text_test.go spells it. The CLI rejects `rndevtools lane up` with
 * "unexpected positional arguments": an operation is always the
 * --operation flag (`rndevtools lane --operation up`), or "the up
 * operation" where no command is meant.
 */
const POSITIONAL_OPERATION =
	/\b(?:lane\s+(?:up|down|ls|launch|log)|native\s+(?:plan|install)|simulator\s+(?:boot|shutdown)|supabase\s+(?:up|down))\b/g;

/**
 * Copy only the Supabase panel shows an operator, from its Controls spec
 * (experiments/supabase-backends/UI.md); nothing hands it to an agent.
 */
const OPERATOR_ONLY = new Set([
	'This stack runs on Docker and listens on your network. Destroy it; lane up then creates a native one.',
]);

/**
 * A lane up as a command, and what follows it on its line up to the next
 * backtick or quote. The CLI answers a lane up without --worktree with "The
 * up operation requires worktreePath.", so every lane up an agent is told to
 * run names the app directory it starts, as a placeholder or a path.
 */
const LANE_UP_COMMAND = /\blane --operation up\b([^`'"\n]*)/g;

/**
 * A native operation as a command, the word before it, and what follows it
 * on its line up to the next backtick or quote. The CLI refuses a native
 * command without an absolute worktree ("native requires an absolute
 * worktreePath") and an install without its udid, and a plan without one
 * cannot say whether the app is installed. So every native command an agent
 * is told to run is a whole rndevtools command that names its operation, its
 * app directory and its Simulator, as placeholders or values.
 */
const NATIVE_COMMAND =
	/(\S*)\s+native --operation (?:plan|install)\b([^`'"\n]*)/g;

function sourceFiles(directory: string): string[] {
	return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(entryPath);
		return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)
			? [entryPath]
			: [];
	});
}

/** `source` with its comments blanked, its lines where they were. */
function withoutComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
		.replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('agent-facing desktop texts', () => {
	it('spell every rndevtools operation as the CLI parses it', () => {
		const violations: string[] = [];
		for (const file of agentTextRoots.flatMap(sourceFiles)) {
			const source = fs.readFileSync(file, 'utf8');
			const code = withoutComments(source);
			for (const match of code.matchAll(POSITIONAL_OPERATION)) {
				const line = code.slice(0, match.index).split('\n').length;
				const text = source.split('\n')[line - 1] ?? '';
				if ([...OPERATOR_ONLY].some((copy) => text.includes(copy))) continue;
				violations.push(
					`${path.relative(desktopSource, file)}:${line}: ${match[0]}`
				);
			}
		}
		expect(violations).toEqual([]);
	});

	it('give every lane up the app directory it starts', () => {
		const violations: string[] = [];
		for (const file of agentTextRoots.flatMap(sourceFiles)) {
			const code = withoutComments(fs.readFileSync(file, 'utf8'));
			for (const match of code.matchAll(LANE_UP_COMMAND)) {
				if (/^\s*--worktree\b/.test(match[1] ?? '')) continue;
				const line = code.slice(0, match.index).split('\n').length;
				violations.push(
					`${path.relative(desktopSource, file)}:${line}: ${match[0].trim()}`
				);
			}
		}
		expect(violations).toEqual([]);
	});

	it('give every native command its operation, app directory and Simulator', () => {
		const violations: string[] = [];
		for (const file of agentTextRoots.flatMap(sourceFiles)) {
			const code = withoutComments(fs.readFileSync(file, 'utf8'));
			for (const match of code.matchAll(NATIVE_COMMAND)) {
				const flags = match[2] ?? '';
				if (
					/(?:^|[`'"])rndevtools$/.test(match[1] ?? '') &&
					/\s--worktree\s/.test(flags) &&
					/\s--udid\s/.test(flags)
				) {
					continue;
				}
				const line = code.slice(0, match.index).split('\n').length;
				violations.push(
					`${path.relative(desktopSource, file)}:${line}: ${match[0].trim()}`
				);
			}
		}
		expect(violations).toEqual([]);
	});
});

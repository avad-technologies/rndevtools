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
});

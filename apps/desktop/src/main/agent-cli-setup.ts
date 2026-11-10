import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { inheritedChildEnvironment } from './agent-harness-env';

const execFileAsync = promisify(execFile);

/** The report `rndevtools setup` prints; only the fields the desktop shows. */
const setupReportSchema = z.looseObject({
	executable: z.string(),
	changes: z.array(
		z.looseObject({
			path: z.string(),
			action: z.enum(['create', 'update', 'unchanged', 'skip']),
			detail: z.string().optional(),
		})
	),
	doctor: z.looseObject({
		ok: z.boolean(),
		message: z.string().optional(),
		/** `--no-doctor`: the connection was not checked. */
		skipped: z.boolean().optional(),
	}),
	codexHooksNeedTrust: z.boolean().optional(),
});

/**
 * Runs the verified CLI's `setup` and returns one line per touched file. The
 * CLI owns every edit (its Go code is tested against each agent's file
 * format); the desktop only launches it and relays the outcome. `doctor:
 * false` skips setup's closing doctor, which dials the socket under the real
 * home whatever `home` is: with an isolated test home that is an installed
 * RN Devtools, not this desktop. The CLI gets the desktop's `environment`
 * without the variables of the agent session the desktop may have been
 * started from, which it would otherwise act as (agent-harness-env.ts).
 */
export async function runAgentCliSetup(
	executablePath: string,
	home: string,
	options: { doctor?: boolean; environment?: NodeJS.ProcessEnv } = {}
): Promise<string[]> {
	const env = inheritedChildEnvironment(options.environment ?? process.env);
	const { stdout } = await execFileAsync(
		executablePath,
		[
			'setup',
			'--config-home',
			home,
			...(options.doctor === false ? ['--no-doctor'] : []),
		],
		{
			env,
			timeout: 60_000,
			maxBuffer: 1024 * 1024,
		}
	);
	return summarizeAgentCliSetup(stdout, home);
}

export function summarizeAgentCliSetup(stdout: string, home: string): string[] {
	const report = setupReportSchema.parse(JSON.parse(stdout));
	const lines = report.changes.map((change) => {
		const shortPath = change.path.startsWith(home)
			? `~${change.path.slice(home.length)}`
			: change.path;
		const verb = {
			create: 'Created',
			update: 'Updated',
			unchanged: 'Already current',
			skip: 'Skipped',
		}[change.action];
		return change.action === 'skip' && change.detail
			? `${verb} ${shortPath}: ${change.detail}`
			: `${verb} ${shortPath}`;
	});
	if (report.codexHooksNeedTrust) {
		lines.push(
			'Codex runs new hooks only after you trust them: open Codex and run /hooks.'
		);
	}
	if (
		report.changes.some(
			(change) =>
				['create', 'update'].includes(change.action) &&
				/\/(?:\.claude\.json|config\.toml|mcp\.json)$/.test(change.path)
		)
	) {
		lines.push(
			'Restart your coding agent or reload its MCP servers to use the updated registration.'
		);
	}
	if (
		report.changes.some(
			(change) =>
				['create', 'update'].includes(change.action) &&
				change.path.endsWith('/.local/bin/rndevtools')
		)
	) {
		lines.push(
			'For Terminal commands, add ~/.local/bin to your shell PATH if needed; MCP uses the absolute executable path.'
		);
	}
	lines.push(
		report.doctor.skipped
			? 'Setup skipped its RN Devtools desktop connection check.'
			: report.doctor.ok
				? 'The RN Devtools desktop connection is working.'
				: `Agents will reach RN Devtools once it is running${report.doctor.message ? ` (${report.doctor.message})` : ''}.`
	);
	return lines;
}

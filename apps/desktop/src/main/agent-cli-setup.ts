import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

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
	}),
	codexHooksNeedTrust: z.boolean().optional(),
});

/**
 * Runs the verified CLI's `setup` and returns one line per touched file. The
 * CLI owns every edit (its Go code is tested against each agent's file
 * format); the desktop only launches it and relays the outcome.
 */
export async function runAgentCliSetup(
	executablePath: string,
	home: string
): Promise<string[]> {
	const { stdout } = await execFileAsync(executablePath, ['setup'], {
		timeout: 60_000,
		maxBuffer: 1024 * 1024,
	});
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
	lines.push(
		report.doctor.ok
			? 'Agents can reach RN Devtools now.'
			: `Agents will reach RN Devtools once it is running${report.doctor.message ? ` (${report.doctor.message})` : ''}.`
	);
	return lines;
}

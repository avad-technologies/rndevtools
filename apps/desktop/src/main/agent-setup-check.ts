import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
	type AgentSetupPlan,
	type AgentSetupReport,
	type AgentSetupRequest,
	type AgentSetupResult,
	agentSetupPlanSchema,
	agentSetupProbeSchema,
	agentSetupReportSchema,
	agentSetupRequestSchema,
} from '../shared/agent-setup-protocol';
import { inheritedChildEnvironment } from './agent-harness-env';

const execute = promisify(execFile);

type Dependencies = {
	executable: () => Promise<string>;
	home: string;
	projects: () => readonly string[];
	confirm: (preview: { title: string; detail: string }) => Promise<boolean>;
	run?: (
		executable: string,
		args: string[],
		env: NodeJS.ProcessEnv
	) => Promise<string>;
	/**
	 * What the CLI inherits, less the variables of the agent session the
	 * desktop may have been started from, which it would otherwise act as
	 * (agent-harness-env.ts). The desktop's own environment by default.
	 */
	environment?: NodeJS.ProcessEnv;
};

/** One service for setup, the Agents view and doctor. It never probes foreign MCPs. */
export class AgentSetupCheckService {
	readonly #dependencies: Dependencies;
	readonly #plans = new Map<
		string,
		{ plan: AgentSetupPlan; project: string }
	>();
	readonly #cache = new Map<string, { report: AgentSetupReport; at: number }>();

	constructor(dependencies: Dependencies) {
		this.#dependencies = dependencies;
	}

	async #invoke(request: AgentSetupRequest): Promise<unknown> {
		const executable = await this.#dependencies.executable();
		const args = [
			'agent-check',
			'--operation',
			request.operation,
			'--config-home',
			this.#dependencies.home,
			'--executable',
			executable,
		];
		if (request.project) args.push('--project', request.project);
		if (request.findingId) args.push('--finding-id', request.findingId);
		if (request.planId) args.push('--plan-id', request.planId);
		// Outside the try: a list of what to strip that cannot be read fails
		// with its own reason, which names no value.
		const env = inheritedChildEnvironment(
			this.#dependencies.environment ?? process.env
		);
		try {
			const stdout = this.#dependencies.run
				? await this.#dependencies.run(executable, args, env)
				: (
						await execute(executable, args, {
							env,
							timeout: 70_000,
							maxBuffer: 2 * 1024 * 1024,
						})
					).stdout;
			return JSON.parse(stdout) as unknown;
		} catch (error) {
			// execFile errors embed arguments/stdout. Only the CLI's bounded error
			// message may leave main; never expose a whole configuration document.
			let message =
				'Agent setup check failed. Recheck the configuration and try again.';
			if (
				error &&
				typeof error === 'object' &&
				'stderr' in error &&
				typeof error.stderr === 'string'
			) {
				try {
					const parsed: unknown = JSON.parse(error.stderr);
					if (
						parsed &&
						typeof parsed === 'object' &&
						'error' in parsed &&
						parsed.error &&
						typeof parsed.error === 'object' &&
						'message' in parsed.error &&
						typeof parsed.error.message === 'string'
					) {
						message = parsed.error.message.slice(0, 1024);
					}
				} catch {
					/* Unstructured child output stays private. */
				}
			}
			throw new Error(message);
		}
	}

	async scan(project = '', cached = false): Promise<AgentSetupReport> {
		this.#assertProject(project);
		const previous = this.#cache.get(project);
		if (cached && previous && Date.now() - previous.at < 30_000)
			return previous.report;
		const report = agentSetupReportSchema.parse(
			await this.#invoke({ operation: 'scan', project })
		);
		this.#cache.set(project, { report, at: Date.now() });
		return report;
	}

	#assertProject(project: string): void {
		if (project && !this.#dependencies.projects().includes(project)) {
			throw new Error(
				'Choose a repository or worktree already added to RN Devtools.'
			);
		}
	}

	async run(value: AgentSetupRequest): Promise<AgentSetupResult> {
		const request = agentSetupRequestSchema.parse(value);
		const project = request.project ?? '';
		this.#assertProject(project);
		if (request.operation === 'scan')
			return { report: await this.scan(project) };
		if (request.operation === 'probe')
			return {
				probe: agentSetupProbeSchema.parse(await this.#invoke(request)),
			};
		if (request.operation === 'plan') {
			const plan = agentSetupPlanSchema.parse(await this.#invoke(request));
			for (const [id, entry] of this.#plans)
				if (entry.plan.expiresAt < Date.now()) this.#plans.delete(id);
			if (this.#plans.size >= 64)
				throw new Error('Too many repair previews. Reopen setup checks.');
			this.#plans.set(plan.id, { plan, project });
			return { plan };
		}
		let title: string;
		let detail: string;
		if (request.operation === 'apply') {
			const entry = this.#plans.get(request.planId ?? '');
			if (
				!entry ||
				entry.project !== project ||
				entry.plan.expiresAt < Date.now()
			) {
				throw new Error('Preview this fix again before applying it.');
			}
			title = entry.plan.title;
			// A dotfiles link is edited where it points: name that file too.
			const writes = entry.plan.target
				? `\nWrites ${entry.plan.target}, the file it links to.`
				: '';
			detail = `${entry.plan.scope}\n${entry.plan.source}${writes}\n\n${entry.plan.summary}`;
		} else {
			const report = await this.scan(project);
			const receipt = report.repairs.find(
				(item) => item.id === request.planId && item.status !== 'undone'
			);
			if (!receipt)
				throw new Error('This repair is no longer available to undo. Recheck.');
			title = `Undo: ${receipt.title}`;
			detail = `${receipt.scope}\n\nRestore the settings this repair changed. Newer edits to those settings will be preserved and reported. Reload the client afterward.`;
		}
		if (!(await this.#dependencies.confirm({ title, detail })))
			return { cancelled: true };
		const report = agentSetupReportSchema.parse(await this.#invoke(request));
		this.#plans.delete(request.planId ?? '');
		this.#cache.clear();
		return { report };
	}
}

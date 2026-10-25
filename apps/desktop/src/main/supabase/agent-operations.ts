import { randomUUID } from 'node:crypto';
import type { DeviceHolder } from '../../shared/device-hold';
import {
	formatHoldDuration,
	isSyntheticHolder,
} from '../../shared/device-hold';
import {
	isSupabaseStackRunning,
	LANE_BACKEND_WARNINGS,
	type SupabaseAgentEnv,
	type SupabaseAgentErrorCode,
	type SupabaseAgentOperation,
	type SupabaseAgentResult,
	type SupabaseAgentStack,
	type SupabaseDoctorInfo,
	type SupabaseLogRecord,
	type SupabaseStackSummary,
	sanitizeSupabaseDisplayText,
	supabaseActivityStats,
	supabaseAgentEnvSchema,
	supabaseAgentLabel,
	supabaseAgentRecovery,
	supabaseBranchLabel,
} from '../../shared/supabase-protocol';
import { AgentCliError } from '../agent-cli-service';
import { parseSupabaseDbReset } from './cli-contract';
import { SUPABASE_BRANCH_MOVED_TITLE } from './cli-errors';
import { hasSupabaseControlCharacters, supabaseWithin } from './engine-support';
import { initialSupabaseJobSteps } from './job-store';
import type { SupabaseWorktreeFacts } from './repositories';
import type {
	SupabaseEngine,
	SupabaseEnsureRefusal,
	SupabaseStackView,
} from './service-engine';
import type {
	SupabaseAgentContext,
	SupabaseReleaseResult,
} from './service-ports';
import type { SupabaseStoredHold } from './stack-store';

/**
 * `rndevtools supabase --operation …` and the MCP tool `supabase`. Identity
 * comes from the request envelope: a session hold for an attributed caller,
 * a worktree hold for a shared MCP identity. Results carry ports, never
 * URLs or keys, except `env`, which returns the public values only. Errors
 * are AgentCliError with a code from SUPABASE_AGENT_ERROR_CODES and the
 * recovery that names the next call. Destroy always becomes a request for
 * the user; a reset runs only for the stack's sole live holder.
 */

const REQUEST_TTL_MS = 30 * 60_000;
const RESET_WAIT_MS = 45_000;
const METRO_RESTART_WAIT_MS = 5_000;
const MAX_LOG_RECORDS = 5_000;

type AgentWarning = (typeof LANE_BACKEND_WARNINGS)[number];

function agentError(
	code: SupabaseAgentErrorCode | 'invalid_request',
	message: string,
	runner?: string,
	recovery?: string
): AgentCliError {
	return new AgentCliError({
		code,
		message: sanitizeSupabaseDisplayText(message, 1_024),
		retryable:
			code === 'supabase_capacity' ||
			code === 'job_lost' ||
			code === 'git_busy' ||
			code === 'supabase_failed',
		recovery:
			recovery ??
			(code === 'invalid_request'
				? 'Call supabase with operation ls to see the stacks, then retry with a full stack id or a worktree path.'
				: supabaseAgentRecovery(code, runner)),
	});
}

function runnerOf(
	facts: SupabaseWorktreeFacts | undefined
): string | undefined {
	return facts?.detection?.status === 'found' && facts.detection.runner
		? `${facts.detection.runner.command} supabase`
		: undefined;
}

function refusalError(refused: SupabaseEnsureRefusal): AgentCliError {
	const runner = runnerOf(refused.facts);
	if (refused.agentCode === 'supabase_capacity' && refused.requestId) {
		return agentError(
			'supabase_capacity',
			`${refused.message} RN Devtools asked the user to make room (request ${refused.requestId}).`,
			runner
		);
	}
	return agentError(refused.agentCode, refused.message, runner);
}

/** The holder an agent's `up` adds, or none when the CLI couldn't tell who asked. */
function holdFor(
	context: SupabaseAgentContext,
	now: number
): SupabaseStoredHold | undefined {
	const holder = context.holder;
	if (!holder) return undefined;
	const synthetic = context.synthetic || isSyntheticHolder(holder);
	return {
		holder: synthetic ? 'worktree' : 'session',
		agent: { kind: holder.kind, sessionId: holder.sessionId, synthetic },
		since: now,
	};
}

function isYours(
	stack: SupabaseStackSummary,
	holder: DeviceHolder | undefined
): boolean {
	if (!holder) return false;
	return (
		stack.holds.some(
			(hold) =>
				hold.holder !== 'operator' &&
				hold.agent?.kind === holder.kind &&
				hold.agent.sessionId === holder.sessionId
		) ||
		(stack.createdBy.agent?.kind === holder.kind &&
			stack.createdBy.agent.sessionId === holder.sessionId)
	);
}

function agentStatus(
	stack: SupabaseStackSummary
): SupabaseAgentStack['status'] {
	switch (stack.state) {
		case 'running':
			return 'ready';
		case 'not-created':
		case 'never-started':
		case 'starting':
		case 'stopping':
		case 'stopped':
		case 'failed':
		case 'unhealthy':
		case 'partial':
		case 'interrupted':
		case 'needs-recreate':
		case 'unreadable':
		case 'unknown':
			return stack.state;
	}
}

/** One stack as an agent sees it: ports only, absolute paths main resolved. */
function supabaseAgentStack(
	engine: SupabaseEngine,
	stack: SupabaseStackSummary,
	holder: DeviceHolder | undefined
): SupabaseAgentStack {
	const record = engine.stackStore.record(stack.id);
	const facts = engine.factsForStack(stack.id, record);
	const entry = engine.entry(stack.id);
	const worktreePath = facts?.worktreePath ?? record?.worktreePath;
	const projectRoot = entry?.projectRoot ?? record?.projectRoot;
	const runner = runnerOf(facts);
	const resolution = facts?.cli;
	const absolute = (value: string | undefined) =>
		value?.startsWith('/') &&
		value.length <= 1_024 &&
		!hasSupabaseControlCharacters(value)
			? value
			: undefined;
	const safeWorktree = absolute(worktreePath);
	const safeRoot = absolute(projectRoot);
	return {
		id: stack.id,
		status: agentStatus(stack),
		origin: stack.origin,
		mode: stack.mode.value,
		runtime: stack.runtime,
		exposure: stack.exposure.verdict,
		...(stack.branchContext ? { branchContext: stack.branchContext } : {}),
		...(safeWorktree ? { worktreePath: safeWorktree } : {}),
		...(safeRoot ? { projectRoot: safeRoot } : {}),
		...(stack.ports.api === undefined ? {} : { apiPort: stack.ports.api }),
		...(stack.ports.db === undefined ? {} : { dbPort: stack.ports.db }),
		laneIds: stack.lanes.map((lane) => lane.laneId),
		holders: stack.holds.map((hold) => ({
			holder: hold.holder,
			...(hold.holder !== 'operator' && hold.agent
				? { agent: { kind: hold.agent.kind, sessionId: hold.agent.sessionId } }
				: {}),
			live: hold.live,
		})),
		yours: isYours(stack, holder),
		cli: {
			...(resolution?.ok ? { version: resolution.cli.version } : {}),
			gate: resolution?.ok ? resolution.cli.dialect.gate : 'missing',
			...(runner ? { run: runner } : {}),
		},
		...(stack.mode.reasonText ? { reasonText: stack.mode.reasonText } : {}),
	};
}

function stackOf(
	engine: SupabaseEngine,
	stackId: string
): SupabaseStackSummary | undefined {
	return engine.getState().stacks.find((stack) => stack.id === stackId);
}

/**
 * The stack a target names: a worktree's current branch, or a unique
 * 8-64 hex prefix among the stacks main knows.
 */
async function resolveTarget(
	engine: SupabaseEngine,
	target: Extract<SupabaseAgentOperation, { target: unknown }>['target']
): Promise<Readonly<{ stackId: string; facts?: SupabaseWorktreeFacts }>> {
	if ('worktreePath' in target) {
		const facts = await engine.worktreeFacts(target.worktreePath);
		const refused = engine.preflight(facts);
		if (
			refused &&
			refused.reason !== 'git-busy' &&
			refused.reason !== 'ports-pinned'
		) {
			throw refusalError(refused);
		}
		if (!facts?.expectedStackId) {
			throw agentError(
				'not_found',
				'This worktree has no Supabase project RN Devtools can use.'
			);
		}
		return { stackId: facts.expectedStackId, facts };
	}
	const prefix = target.stackId;
	const known = new Set<string>([
		...engine.getState().stacks.map((stack) => stack.id),
		...engine.listEntries().map((entry) => entry.id),
		...engine.stackStore.records().map((record) => record.id),
	]);
	const matches = [...known].filter((id) => id.startsWith(prefix));
	if (matches.length === 0) {
		throw agentError('not_found', `No local Supabase stack has id ${prefix}.`);
	}
	if (matches.length > 1) {
		throw agentError(
			'invalid_request',
			`The stack id prefix ${prefix} matches ${matches.length} stacks.`
		);
	}
	const stackId = matches[0] as string;
	const facts = engine.factsForStack(stackId);
	return { stackId, ...(facts ? { facts } : {}) };
}

function warningsFor(
	engine: SupabaseEngine,
	stack: SupabaseStackSummary | undefined,
	extra: readonly string[]
): AgentWarning[] {
	const warnings = new Set<AgentWarning>();
	for (const warning of extra) {
		if ((LANE_BACKEND_WARNINGS as readonly string[]).includes(warning)) {
			warnings.add(warning as AgentWarning);
		}
	}
	if (!engine.policySnapshot().policy.perStackKeys) {
		warnings.add('shared-default-keys');
	}
	if (stack?.flags.includes('studio-back-on') || stack?.compositionDrift) {
		warnings.add('composition-drift');
	}
	if (stack?.flags.includes('env-shadowed')) warnings.add('dotenv-shadowed');
	return [...warnings].slice(0, 8);
}

async function up(
	engine: SupabaseEngine,
	operation: Extract<SupabaseAgentOperation, { operation: 'up' }>,
	context: SupabaseAgentContext,
	signal: AbortSignal
): Promise<SupabaseAgentResult> {
	const resolved = await resolveTarget(engine, operation.target);
	// Read the worktree again: an up decides on the branch checked out now.
	const known = resolved.facts;
	const facts =
		'worktreePath' in operation.target
			? known
			: await engine.worktreeFacts(
					known?.worktreePath ??
						engine.stackStore.record(resolved.stackId)?.worktreePath ??
						'/',
					known?.appPath
				);
	if (!facts) {
		throw agentError(
			'not_found',
			'The stack has no worktree RN Devtools tracks.'
		);
	}
	if (
		'stackId' in operation.target &&
		facts.expectedStackId !== resolved.stackId
	) {
		throw agentError(
			'branch_moved',
			`The worktree moved to ${supabaseBranchLabel(facts.head?.status === 'ok' ? facts.head.branchContext : undefined) ?? 'another branch'}; that stack belongs to its old branch.`,
			runnerOf(facts)
		);
	}
	const refused = engine.preflight(facts);
	if (refused) throw refusalError(refused);
	const holder = context.holder;
	const now = engine.now();
	const projectRoot =
		facts.detection?.status === 'found'
			? facts.detection.projectRoot
			: undefined;
	// Move this project's old holds only after its new branch is ready.
	const others = holder
		? engine.stackStore
				.records()
				.filter(
					(record) =>
						record.id !== facts.expectedStackId &&
						record.worktreePath === facts.worktreePath &&
						record.projectRoot === projectRoot &&
						record.holds.some(
							(hold) =>
								hold.agent.kind === holder.kind &&
								hold.agent.sessionId === holder.sessionId
						)
				)
				.map((record) => record.id)
		: [];
	let jobId: string | undefined;
	const hold = holdFor(context, now);
	const pending = engine.track(
		engine
			.ensureStack(facts, {
				requestedBy: holder
					? {
							kind: 'agent',
							agent: { kind: holder.kind, sessionId: holder.sessionId },
						}
					: { kind: 'operator' },
				createdBy: {
					via: 'agent',
					...(holder
						? { agent: { kind: holder.kind, sessionId: holder.sessionId } }
						: {}),
				},
				...(hold ? { hold } : {}),
				...(holder
					? {
							capacityRequester: {
								holder,
								synthetic: context.synthetic || isSyntheticHolder(holder),
							},
						}
					: {}),
				onJob: (id) => {
					jobId = id;
				},
			})
			.then(async (result) => {
				if (result.kind === 'ready' && holder && others.length > 0) {
					await engine.stackStore.releaseHolder(holder, {
						stackIds: others,
						...(context.sessionCwd ? { sessionCwd: context.sessionCwd } : {}),
					});
				}
				return result;
			})
	);
	const settled = await supabaseWithin(
		engine.timers,
		pending,
		operation.waitMs,
		signal
	);
	const stackId = facts.expectedStackId as string;
	const appEnv = engine
		.policySnapshot()
		.policy.appEnv.map((entry) => entry.name);
	const runner = runnerOf(facts);
	const cli =
		facts.cli?.ok && runner && projectRoot
			? { run: runner, workdir: projectRoot, version: facts.cli.cli.version }
			: undefined;
	const lanes = engine.attachmentsOf(stackId);
	if (!settled) {
		const stack = stackOf(engine, stackId);
		// Queued behind an automatic start of this stack, the up has no job of
		// its own yet; that start's job may fail while this up then succeeds.
		const queued = jobId === undefined && engine.ensureQueued(stackId);
		const job = queued
			? undefined
			: (jobId ?? engine.activeJobFor(stackId)?.id);
		return {
			operation: 'up',
			stack: stack
				? { ...supabaseAgentStack(engine, stack, holder), status: 'starting' }
				: {
						id: stackId,
						status: 'starting',
						origin: 'expected',
						mode: 'managed',
						runtime: 'native',
						exposure: 'unchecked',
						laneIds: [],
						holders: [],
						yours: true,
					},
			appEnv,
			metro: lanes.length > 0 ? 'pending' : 'no-lane',
			...(cli ? { cli } : {}),
			...(job ? { jobId: job } : {}),
			next: queued
				? "This up is queued behind RN Devtools' automatic start of the stack. Call supabase with operation up again in a few seconds."
				: job
					? `The stack is still starting (a first start on this Mac downloads services once). Call wait with condition job and job id ${job}, then call supabase with operation up again.`
					: 'The stack is still starting. Call supabase with operation up again in a few seconds.',
			warnings: warningsFor(engine, stack, []),
		};
	}
	if (settled.kind !== 'ready') throw refusalError(settled);
	const stack = stackOf(engine, stackId);
	if (!stack) {
		throw agentError(
			'supabase_failed',
			'The stack started but is not listed yet.',
			runner
		);
	}
	let metro: 'restarted' | 'unchanged' | 'no-lane' | 'pending' =
		lanes.length === 0 ? 'no-lane' : 'unchanged';
	const stale = lanes.filter((lane) => lane.needsMetroRestart && !lane.pending);
	if (stale.length > 0) {
		// Not inside a lane's queue here, so waiting a moment is safe.
		const restarts = Promise.allSettled(
			stale.map((lane) => engine.deps.lanes.restartMetro(lane.laneId, 'attach'))
		);
		const done = await supabaseWithin(
			engine.timers,
			restarts,
			METRO_RESTART_WAIT_MS,
			signal
		);
		metro = done ? 'restarted' : 'pending';
	}
	return {
		operation: 'up',
		stack: supabaseAgentStack(engine, stack, holder),
		appEnv,
		metro,
		...(cli ? { cli } : {}),
		next: projectRoot
			? `Run \`${runner ?? 'supabase'} migration up --local\`, \`db reset --local\` or \`gen types typescript --local\` from ${projectRoot}. Call supabase with operation env for the URL and publishable key.`
			: 'Call supabase with operation env for the URL and publishable key.',
		warnings: warningsFor(engine, stack, settled.warnings),
	};
}

async function down(
	engine: SupabaseEngine,
	operation: Extract<SupabaseAgentOperation, { operation: 'down' }>,
	context: SupabaseAgentContext
): Promise<SupabaseAgentResult> {
	const holder = context.holder;
	let stackIds: string[];
	if ('worktreePath' in operation.target) {
		const facts = await engine.worktreeFacts(operation.target.worktreePath);
		const projectRoot =
			facts?.detection?.status === 'found'
				? facts.detection.projectRoot
				: undefined;
		const held = holder
			? engine.stackStore
					.records()
					.filter(
						(record) =>
							facts !== undefined &&
							record.worktreePath === facts.worktreePath &&
							record.projectRoot === projectRoot &&
							record.holds.some(
								(hold) =>
									hold.agent.kind === holder.kind &&
									hold.agent.sessionId === holder.sessionId
							)
					)
					.map((record) => record.id)
			: [];
		const current = facts?.expectedStackId;
		stackIds = held.length > 0 ? held : current ? [current] : [];
		if (stackIds.length === 0) {
			throw agentError(
				'not_found',
				'This worktree has no local Supabase stack you hold.'
			);
		}
	} else {
		stackIds = [(await resolveTarget(engine, operation.target)).stackId];
	}
	const released = holder
		? await engine.stackStore.releaseHolder(holder, {
				stackIds,
				...(context.sessionCwd ? { sessionCwd: context.sessionCwd } : {}),
			})
		: [];
	const stackId = stackIds[0] as string;
	const record = engine.stackStore.record(stackId);
	const holds = record
		? engine.holdsIgnoring(
				record,
				holder
					? {
							holder,
							...(context.sessionCwd ? { sessionCwd: context.sessionCwd } : {}),
						}
					: { holder: { kind: 'other', sessionId: 'nobody' } }
			)
		: undefined;
	engine.track(engine.reconcileHolds());
	const keptBy = [
		...(holds?.holds ?? []).flatMap((hold) =>
			!hold.live
				? []
				: hold.holder === 'operator'
					? ['you (pinned in RN Devtools)']
					: hold.holder === 'lane'
						? [`lane ${hold.laneId.slice(0, 13)}`]
						: hold.agent &&
								!(
									holder &&
									hold.agent.kind === holder.kind &&
									hold.agent.sessionId === holder.sessionId
								)
							? [supabaseAgentLabel(hold.agent)]
							: []
		),
		...(holds?.cwdKeepers ?? []).map(
			(keeper) => `${supabaseAgentLabel(keeper.agent)} (works in this worktree)`
		),
	].slice(0, 16);
	const live = engine.isLive(stackId);
	const stopping = live && keptBy.length === 0;
	const delay = engine.policySnapshot().policy.unheldStopDelayMs;
	return {
		operation: 'down',
		stackId,
		released: released.includes(stackId),
		stopping,
		keptBy,
		next: stopping
			? `It stops in ${formatHoldDuration(delay)} unless something else uses it; its data is kept. Call supabase with operation up to get it back (about a second).`
			: live
				? 'It keeps running for the holders listed in keptBy; its data is kept.'
				: 'It is not running; its data is kept.',
	};
}

async function status(
	engine: SupabaseEngine,
	operation: Extract<SupabaseAgentOperation, { operation: 'status' }>,
	context: SupabaseAgentContext
): Promise<SupabaseAgentResult> {
	const resolved = await resolveTarget(engine, operation.target);
	await engine.freshList();
	const read = engine.entry(resolved.stackId)
		? await engine.readStatus(resolved.stackId)
		: undefined;
	const stack = stackOf(engine, resolved.stackId);
	if (!stack) {
		throw agentError('not_found', 'That stack is not listed on this Mac.');
	}
	const head =
		resolved.facts?.head?.status === 'ok'
			? resolved.facts.head.branchContext
			: undefined;
	const moved =
		stack.branchContext !== undefined &&
		head !== undefined &&
		head !== stack.branchContext;
	return {
		operation: 'status',
		stack: supabaseAgentStack(engine, stack, context.holder),
		services: (read?.members ?? []).slice(0, 32).map((member) => ({
			service: member.service,
			state: member.state,
			health: member.health,
		})),
		checkedAt: engine.now(),
		...(stack.state === 'not-created'
			? { next: 'Call supabase with operation up to create it.' }
			: moved
				? {
						next: "The worktree moved to another branch; call supabase with operation up to get that branch's stack.",
					}
				: stack.state === 'stopped'
					? {
							next: 'Call supabase with operation up to resume it (about a second).',
						}
					: {}),
	};
}

async function env(
	engine: SupabaseEngine,
	operation: Extract<SupabaseAgentOperation, { operation: 'env' }>
): Promise<SupabaseAgentResult> {
	const resolved = await resolveTarget(engine, operation.target);
	let endpoints = engine.endpointsOf(resolved.stackId);
	let credentials = engine.credentialsOf(resolved.stackId);
	if (!endpoints || !credentials?.publishableKey) {
		await engine.readStatus(resolved.stackId);
		endpoints = engine.endpointsOf(resolved.stackId);
		credentials = engine.credentialsOf(resolved.stackId);
	}
	const stack = stackOf(engine, resolved.stackId);
	if (!endpoints || !stack || !isSupabaseStackRunning(stack)) {
		throw agentError(
			'not_found',
			'That stack is not running, so its address is not known.',
			runnerOf(resolved.facts),
			'Call supabase with operation up first, then env.'
		);
	}
	const candidate: SupabaseAgentEnv = {
		API_URL: endpoints.apiUrl,
		...(endpoints.restUrl ? { REST_URL: endpoints.restUrl } : {}),
		...(endpoints.functionsUrl
			? { FUNCTIONS_URL: endpoints.functionsUrl }
			: {}),
		...(endpoints.mailpitUrl ? { MAILPIT_URL: endpoints.mailpitUrl } : {}),
		...(credentials?.publishableKey
			? { PUBLISHABLE_KEY: credentials.publishableKey }
			: {}),
		...(credentials?.anonKey ? { ANON_KEY: credentials.anonKey } : {}),
	};
	return {
		operation: 'env',
		stackId: resolved.stackId,
		env: supabaseAgentEnvSchema.parse(candidate),
	};
}

async function fileRequest(
	engine: SupabaseEngine,
	kind: 'destroy' | 'reset',
	view: SupabaseStackView,
	context: SupabaseAgentContext,
	extra: Readonly<{ seed?: boolean; note?: string | undefined }>
): Promise<Readonly<{ id: string; expiresAt: number }>> {
	const holder = context.holder;
	if (!holder) {
		throw agentError(
			'supabase_held',
			'RN Devtools could not tell which session asked, so it cannot file a request.'
		);
	}
	const existing = engine.stackStore
		.requests()
		.find(
			(request) =>
				request.kind === kind &&
				request.stackId === view.id &&
				request.status === 'pending' &&
				request.expiresAt > engine.now() &&
				request.requester.kind === holder.kind &&
				request.requester.sessionId === holder.sessionId
		);
	if (existing) return { id: existing.id, expiresAt: existing.expiresAt };
	const now = engine.now();
	const id = `supabase-request-${randomUUID()}`;
	const branch =
		supabaseBranchLabel(
			view.entry?.branchContext ?? view.record?.branchContext
		) ?? `${view.id.slice(0, 8)}…`;
	await engine.stackStore.putRequest({
		id,
		kind,
		status: 'pending',
		requester: {
			kind: holder.kind,
			sessionId: holder.sessionId,
			synthetic: context.synthetic || isSyntheticHolder(holder),
		},
		stackId: view.id,
		...(view.facts ? { worktreePath: view.facts.worktreePath } : {}),
		branch: sanitizeSupabaseDisplayText(branch, 256) || 'a branch',
		...(view.summary?.diskBytes === undefined
			? {}
			: { sizeBytes: view.summary.diskBytes }),
		...(extra.seed === undefined ? {} : { seed: extra.seed }),
		...(extra.note === undefined ? {} : { note: extra.note }),
		createdAt: now,
		expiresAt: now + REQUEST_TTL_MS,
	});
	return { id, expiresAt: now + REQUEST_TTL_MS };
}

async function reset(
	engine: SupabaseEngine,
	operation: Extract<SupabaseAgentOperation, { operation: 'reset' }>,
	context: SupabaseAgentContext,
	signal: AbortSignal
): Promise<SupabaseAgentResult> {
	const resolved = await resolveTarget(engine, operation.target);
	const view = engine.view(resolved.stackId);
	const runner = runnerOf(view.facts);
	if (!view.summary || !isSupabaseStackRunning(view.summary)) {
		throw agentError(
			'supabase_failed',
			'The stack is not running, so its database cannot be reset.',
			runner,
			'Call supabase with operation up first, then reset.'
		);
	}
	if (!(await engine.headMatches(view))) {
		throw agentError(
			'branch_moved',
			"The worktree is on another branch than this stack, so its migration files don't belong to it.",
			runner
		);
	}
	if (view.summary.cli.mismatch) {
		throw agentError(
			'cli_mismatch',
			'The stack runs on another Supabase CLI release.',
			runner
		);
	}
	const holder = context.holder;
	const record = view.record;
	const holds =
		record && holder
			? engine.holdsIgnoring(record, {
					holder,
					...(context.sessionCwd ? { sessionCwd: context.sessionCwd } : {}),
				})
			: undefined;
	const callerHolds =
		holder !== undefined &&
		view.summary.holds.some(
			(hold) =>
				hold.live &&
				hold.holder !== 'operator' &&
				hold.agent?.kind === holder.kind &&
				hold.agent.sessionId === holder.sessionId
		);
	const othersLive =
		view.summary.pinned ||
		(holds?.holds ?? []).some(
			(hold) =>
				hold.live &&
				!(
					hold.holder !== 'operator' &&
					holder &&
					hold.agent?.kind === holder.kind &&
					hold.agent.sessionId === holder.sessionId
				)
		) ||
		(holds?.cwdKeepers.length ?? 0) > 0;
	if (!callerHolds || othersLive) {
		const request = await fileRequest(engine, 'reset', view, context, {
			seed: operation.seed,
			...(operation.note === undefined ? {} : { note: operation.note }),
		});
		return {
			operation: 'reset',
			stackId: view.id,
			status: 'requested',
			seed: operation.seed,
			requestId: request.id,
			next: 'Someone else uses this stack, so the user decides. RN Devtools shows the request in its Supabase tab; call supabase with operation status later to see the outcome.',
		};
	}
	const facts = view.facts;
	const projectRoot =
		facts?.detection?.status === 'found'
			? facts.detection.projectRoot
			: undefined;
	if (!projectRoot) {
		throw agentError(
			'not_found',
			'The stack has no project RN Devtools tracks.'
		);
	}
	const { jobId, done } = await engine.startJob(
		{
			kind: 'reset',
			stackIds: [view.id],
			requestedBy: holder
				? {
						kind: 'agent',
						agent: { kind: holder.kind, sessionId: holder.sessionId },
					}
				: { kind: 'operator' },
			cancellable: false,
			steps: initialSupabaseJobSteps('reset', {
				migrationTotal: facts?.migrationCount ?? 0,
				seed: operation.seed,
			}),
		},
		(job) =>
			engine.lockStack(view.id, async () => {
				const off = engine.calledOff();
				if (off) return off;
				job.begin();
				const result = await engine.databaseStep(
					view,
					job,
					{
						kind: 'db.reset',
						workdir: projectRoot,
						...(operation.seed ? {} : { noSeed: true }),
					},
					(json) => {
						const parsed = parseSupabaseDbReset(json);
						if (parsed.target !== 'local') {
							throw new Error('The reset reported a non-local target.');
						}
						return parsed;
					},
					'reset'
				);
				await engine.readStatus(view.id);
				return result.ok
					? { status: 'complete' }
					: { status: 'failed', error: result.error };
			})
	);
	const outcome = await supabaseWithin(
		engine.timers,
		done,
		RESET_WAIT_MS,
		signal
	);
	if (outcome && outcome.status !== 'complete') {
		// The worktree switched branches while the reset waited its turn.
		if (outcome.error?.title === SUPABASE_BRANCH_MOVED_TITLE) {
			throw agentError('branch_moved', outcome.error.message, runner);
		}
		// Or the feature was turned off, and the reset was called off.
		if (outcome.error?.code === 'feature_off') {
			throw agentError(
				'supabase_disabled',
				'Local Supabase is off in RN Devtools, so it is not managing this worktree.'
			);
		}
		throw agentError(
			'supabase_failed',
			outcome.error?.message ?? 'The reset failed.',
			runner,
			outcome.error?.recovery
		);
	}
	return {
		operation: 'reset',
		stackId: view.id,
		status: outcome ? 'complete' : 'running',
		seed: operation.seed,
		...(outcome ? {} : { jobId }),
		next: outcome
			? 'The database was reset to its migrations' +
				(operation.seed ? ' and seed.' : '.')
			: `The reset is still running. Call wait with condition job and job id ${jobId}.`,
	};
}

async function log(
	engine: SupabaseEngine,
	operation: Extract<SupabaseAgentOperation, { operation: 'log' }>
): Promise<SupabaseAgentResult> {
	const resolved = await resolveTarget(engine, operation.target);
	const cli = await engine.ownerCli(resolved.stackId);
	if (!cli) {
		throw agentError(
			'cli_missing',
			'No Supabase CLI RN Devtools can run is available to read these logs.',
			runnerOf(resolved.facts)
		);
	}
	const outcome = await engine.readLogs(cli, {
		kind: 'stack.logs',
		stackId: resolved.stackId,
		tail: operation.tail,
		...(operation.services ? { services: operation.services } : {}),
		...(operation.since ? { since: operation.since } : {}),
	});
	if (!outcome.ok) {
		// Turned off while the read waited for a CLI slot: it never ran.
		if (!engine.enabled()) {
			throw agentError(
				'supabase_disabled',
				'Local Supabase is off in RN Devtools, so it is not managing this worktree.'
			);
		}
		throw agentError(
			outcome.error.code === 'not_found' ? 'not_found' : 'supabase_failed',
			outcome.error.message,
			runnerOf(resolved.facts),
			outcome.error.recovery
		);
	}
	return {
		operation: 'log',
		stackId: resolved.stackId,
		records: outcome.value.records.slice(-MAX_LOG_RECORDS).map(
			(record): SupabaseLogRecord =>
				record.type === 'entry'
					? record
					: {
							type: 'marker',
							timestamp: record.timestamp,
							source: record.source,
							service: record.service,
							instanceId: record.instanceId,
							kind: record.kind,
							...(record.stream ? { stream: record.stream } : {}),
							...(record.count === undefined ? {} : { count: record.count }),
						}
		),
		truncated: outcome.value.truncated,
	};
}

async function destroy(
	engine: SupabaseEngine,
	operation: Extract<SupabaseAgentOperation, { operation: 'destroy' }>,
	context: SupabaseAgentContext
): Promise<SupabaseAgentResult> {
	const resolved = await resolveTarget(engine, operation.target);
	await engine.freshList();
	const view = engine.view(resolved.stackId);
	if (!view.entry) {
		throw agentError(
			'not_found',
			'That stack does not exist, so there is nothing to destroy.'
		);
	}
	const request = await fileRequest(engine, 'destroy', view, context, {
		...(operation.note === undefined ? {} : { note: operation.note }),
	});
	return {
		operation: 'destroy',
		stackId: view.id,
		requestId: request.id,
		status: 'pending',
		expiresAt: request.expiresAt,
		next: `The user decides in RN Devtools › Supabase (the request expires in 30 min). To start fresh without waiting, call supabase with operation reset instead.`,
	};
}

export async function runSupabaseAgentOperation(
	engine: SupabaseEngine,
	operation: SupabaseAgentOperation,
	context: SupabaseAgentContext,
	signal: AbortSignal
): Promise<SupabaseAgentResult> {
	if (!engine.platform.supported) {
		throw agentError(
			'supabase_unsupported',
			engine.platform.reasonText ??
				'Native Supabase needs Apple silicon and macOS 14 or later.'
		);
	}
	if (!engine.policySnapshot().enabled) {
		throw agentError(
			'supabase_disabled',
			'Local Supabase is off in RN Devtools, so it is not managing this worktree.'
		);
	}
	switch (operation.operation) {
		case 'up':
			return up(engine, operation, context, signal);
		case 'down':
			return down(engine, operation, context);
		case 'ls': {
			await engine.freshList(30_000);
			const facts = operation.worktreePath
				? await engine.worktreeFacts(operation.worktreePath)
				: undefined;
			const stacks = engine
				.getState()
				.stacks.filter((stack) => {
					if (!operation.worktreePath) return true;
					const record = engine.stackStore.record(stack.id);
					return (
						facts !== undefined &&
						(record?.worktreePath === facts.worktreePath ||
							stack.id === facts.expectedStackId)
					);
				})
				.slice(0, 128);
			return {
				operation: 'ls',
				stacks: stacks.map((stack) =>
					supabaseAgentStack(engine, stack, context.holder)
				),
			};
		}
		case 'status':
			return status(engine, operation, context);
		case 'env':
			return env(engine, operation);
		case 'reset':
			return reset(engine, operation, context, signal);
		case 'log':
			return log(engine, operation);
		case 'destroy':
			return destroy(engine, operation, context);
	}
}

/**
 * `release --all` and SessionEnd: drops the session's holds in memory and on
 * disk at once (a synthetic MCP identity only where `sessionCwd` works), and
 * leaves the stops to the linger. Returns within the 2 s client budget.
 */
export async function releaseSupabaseHolder(
	engine: SupabaseEngine,
	input: Readonly<{
		holder?: DeviceHolder | undefined;
		sessionCwd?: string | undefined;
	}>
): Promise<SupabaseReleaseResult> {
	const holder = input.holder;
	if (!holder) return { releasedStackIds: [], pendingStops: [] };
	if (isSyntheticHolder(holder) && input.sessionCwd === undefined) {
		return { releasedStackIds: [], pendingStops: [] };
	}
	const released = await engine.stackStore.releaseHolder(holder, {
		...(input.sessionCwd ? { sessionCwd: input.sessionCwd } : {}),
	});
	const pendingStops = released.filter((stackId) => {
		const record = engine.stackStore.record(stackId);
		if (!record || !engine.isLive(stackId)) return false;
		const holds = engine.holdsIgnoring(record, {
			holder,
			...(input.sessionCwd ? { sessionCwd: input.sessionCwd } : {}),
		});
		return !holds.held;
	});
	if (released.length > 0) engine.track(engine.reconcileHolds());
	return { releasedStackIds: released, pendingStops };
}

/** What `doctor` reports about local Supabase. */
export function supabaseDoctorInfo(engine: SupabaseEngine): SupabaseDoctorInfo {
	const state = engine.getState();
	const snapshot = engine.policySnapshot();
	const capability: SupabaseDoctorInfo['capability'] = !engine.platform
		.supported
		? 'unsupported'
		: snapshot.health === 'quarantined'
			? 'quarantined'
			: !snapshot.enabled
				? 'off'
				: state.repositories.some((repository) => repository.counts.managed > 0)
					? 'ready'
					: 'needs-setup';
	const warnings: string[] = [];
	if (state.engines.docker === 'found') {
		warnings.push(
			'A Docker socket exists on this Mac: a Supabase start without --runtime native could pick Docker, whose ports listen on every interface.'
		);
	}
	if (state.notices.containerStacks.length > 0) {
		warnings.push(
			`${state.notices.containerStacks.length} container stacks use managed worktree identities; RN Devtools never attaches them.`
		);
	}
	if (state.home.foreign && state.home.foreign.length > 0) {
		warnings.push(
			'Another Supabase home is in use on this Mac; its stacks are not listed here.'
		);
	}
	if (snapshot.policy.pinnedPortsCompat) {
		warnings.push(
			"Pinned-port leases apply only to starts RN Devtools runs; an agent's own start re-plans from the pinned config."
		);
	}
	if (state.discovery.listFailure) {
		warnings.push(
			sanitizeSupabaseDisplayText(state.discovery.listFailure.message, 512)
		);
	}
	return {
		enabled: snapshot.enabled,
		capability,
		platform: state.availability.platform,
		repositories: state.repositories.slice(0, 32).map((repository) => ({
			label: repository.label,
			mode:
				repository.readiness === 'off'
					? 'off'
					: repository.readiness === 'no-supabase'
						? 'none'
						: repository.counts.managed > 0
							? 'managed'
							: 'observed',
			cli: {
				...(repository.cli.version ? { version: repository.cli.version } : {}),
				gate: repository.cli.gate ?? 'missing',
			},
		})),
		running: state.capacity.running,
		cap: state.capacity.cap,
		sysv: state.capacity.sysv,
		containerEngine: state.engines,
		stats: supabaseActivityStats(state.activity),
		warnings: warnings.slice(0, 16),
	};
}

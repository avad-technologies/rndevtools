import { MAX_METRO_ENV_VALUE_LENGTH } from '../../shared/lane-protocol';
import {
	isLoopbackHttpUrl,
	type LaneBackendSummary,
	SUPABASE_AGENT_MAX_WAIT_MS,
	type SupabaseAppEnvEntry,
	sanitizeSupabaseDisplayText,
} from '../../shared/supabase-protocol';
import type {
	MainOnlyCredentials,
	SupabasePublicEndpoints,
} from './cli-contract';
import { sha256Hex, supabaseWithin } from './engine-support';
import type { SupabaseWorktreeFacts } from './repositories';
import type {
	SupabaseEngine,
	SupabaseEnsureRefusal,
	SupabaseEnsureResult,
} from './service-engine';
import {
	LANE_BACKEND_DEFAULT_WAIT_MS,
	type LaneBackendEnsureInput,
	type LaneBackendEnsureResult,
	type LaneBackendLateAttach,
} from './service-ports';

/**
 * Lanes and their worktree's stack. `lane up` asks while the Simulator
 * boots; the answer never rejects over a backend problem, and its summary
 * always parses on the lane wire. Metro gets public values only: the mapped
 * URL names from the stack's loopback endpoints and the publishable or anon
 * key from main's in-memory credentials, never a secret.
 *
 * Two rules keep this from deadlocking the lane service, whose Metro
 * restarts call back into ensureForLane from inside the lane's own queue:
 * with waitMs 0 the answer comes from what main already knows, and nothing
 * here ever awaits lanes.restartMetro or launchDeferred for the lane being
 * ensured (other lanes on the stack are restarted without waiting).
 */

const MAX_REASON = 1_024;

export type SupabaseLaneEnv = Readonly<{
	env: Readonly<Record<string, string>>;
	names: readonly string[];
	/** Changes when any value changes; never the values themselves. */
	fingerprint: string;
}>;

/**
 * The policy's app variables with the values this stack has now. A name
 * whose source is unknown (an excluded service, a key not read yet) is left
 * out rather than sent empty.
 */
export function supabaseLaneEnv(
	appEnv: readonly SupabaseAppEnvEntry[],
	endpoints: SupabasePublicEndpoints | undefined,
	credentials: MainOnlyCredentials | undefined
): SupabaseLaneEnv {
	const env: Record<string, string> = {};
	for (const entry of appEnv) {
		let value: string | undefined;
		switch (entry.source) {
			case 'API_URL':
				value = endpoints?.apiUrl;
				break;
			case 'REST_URL':
				value = endpoints?.restUrl;
				break;
			case 'FUNCTIONS_URL':
				value = endpoints?.functionsUrl;
				break;
			case 'PUBLISHABLE_KEY':
				value = credentials?.publishableKey;
				break;
			case 'ANON_KEY':
				value = credentials?.anonKey;
				break;
		}
		if (
			value === undefined ||
			value.length === 0 ||
			value.length > MAX_METRO_ENV_VALUE_LENGTH
		) {
			continue;
		}
		if (
			(entry.source === 'API_URL' ||
				entry.source === 'REST_URL' ||
				entry.source === 'FUNCTIONS_URL') &&
			!isLoopbackHttpUrl(value)
		) {
			continue;
		}
		env[entry.name] = value;
	}
	const names = Object.keys(env);
	return {
		env,
		names,
		fingerprint: sha256Hex(
			JSON.stringify(
				Object.entries(env).sort(([left], [right]) => left.localeCompare(right))
			)
		),
	};
}

function reasonText(text: string): string {
	return sanitizeSupabaseDisplayText(text, MAX_REASON);
}

/** A summary the lane wire accepts: names only, bounded text. */
function summary(
	policy: LaneBackendSummary['policy'],
	status: LaneBackendSummary['status'],
	extra: Partial<LaneBackendSummary> = {}
): LaneBackendSummary {
	return { policy, status, appEnvNames: [], warnings: [], ...extra };
}

/** What a refusal reads as on the lane. */
function laneRefusalSummary(
	policy: LaneBackendSummary['policy'],
	refused: SupabaseEnsureRefusal
): LaneBackendSummary {
	const status: LaneBackendSummary['status'] =
		refused.reason === 'ports-pinned'
			? 'blocked'
			: refused.reason === 'lan-exposed'
				? 'refused'
				: refused.reason === 'failed' || refused.reason === 'cli-mismatch'
					? 'failed'
					: 'skipped';
	return summary(policy, status, {
		reason: refused.reason,
		...(refused.stackId ? { stackId: refused.stackId } : {}),
		reasonText: reasonText(refused.message),
	});
}

/**
 * The summary and values for a stack that serves the lane now. An app
 * dotenv file that defines a mapped name wins over Metro's value in Expo's
 * dev bundles: `auto` still gets the values with a warning, `required`
 * gets none and fails.
 */
function servedAnswer(
	engine: SupabaseEngine,
	input: LaneBackendEnsureInput,
	result: Extract<SupabaseEnsureResult, { kind: 'ready' }>
): LaneBackendLateAttach {
	const policy = engine.policySnapshot().policy;
	const endpoints = engine.endpointsOf(result.stackId);
	const lane = supabaseLaneEnv(
		policy.appEnv,
		endpoints,
		engine.credentialsOf(result.stackId)
	);
	const stack = engine
		.getState()
		.stacks.find((candidate) => candidate.id === result.stackId);
	const warnings = new Set<LaneBackendSummary['warnings'][number]>(
		result.warnings
	);
	if (!policy.perStackKeys) warnings.add('shared-default-keys');
	if (
		stack?.flags.includes('studio-back-on') ||
		stack?.compositionDrift !== undefined
	) {
		warnings.add('composition-drift');
	}
	const detection =
		result.facts.detection?.status === 'found'
			? result.facts.detection
			: undefined;
	const shadowed = (detection?.shadowedAppVariables ?? []).filter((variable) =>
		lane.names.includes(variable.name)
	);
	const apiUrl =
		endpoints?.apiUrl !== undefined && isLoopbackHttpUrl(endpoints.apiUrl)
			? endpoints.apiUrl
			: undefined;
	if (input.laneId) {
		engine.laneServed(input.laneId, lane.fingerprint);
		if (engine.noteServedSimulator(result.stackId, input.laneId)) {
			warnings.add('previous-session-on-simulator');
		}
	}
	if (shadowed.length > 0) {
		warnings.add('dotenv-shadowed');
		const [first] = shadowed;
		const where = first
			? `${first.file.replace(`${result.facts.realWorktreePath}/`, '')}:${first.line} sets ${first.name}`
			: 'An app .env file sets a mapped name';
		const text = reasonText(
			`${where}; Expo reads it instead of the lane's value. Remove it from the app's .env files.`
		);
		if (input.policy === 'required') {
			return {
				summary: summary(input.policy, 'shadowed', {
					reason: 'dotenv-shadowed',
					stackId: result.stackId,
					...(apiUrl ? { apiUrl } : {}),
					reasonText: text,
					warnings: [...warnings],
				}),
			};
		}
		return {
			summary: summary(input.policy, 'shadowed', {
				reason: 'dotenv-shadowed',
				stackId: result.stackId,
				...(apiUrl ? { apiUrl } : {}),
				appEnvNames: [...lane.names],
				reasonText: text,
				warnings: [...warnings],
			}),
			laneEnv: lane.env,
		};
	}
	return {
		summary: summary(input.policy, 'ready', {
			stackId: result.stackId,
			...(apiUrl ? { apiUrl } : {}),
			appEnvNames: [...lane.names],
			warnings: [...warnings],
		}),
		laneEnv: lane.env,
	};
}

function answerFor(
	engine: SupabaseEngine,
	input: LaneBackendEnsureInput,
	result: SupabaseEnsureResult
): LaneBackendLateAttach {
	if (result.kind === 'ready') return servedAnswer(engine, input, result);
	// A lane the backend refuses does not hold the stack.
	if (input.laneId) engine.detachLane(input.laneId);
	return { summary: laneRefusalSummary(input.policy, result) };
}

function failedAnswer(
	policy: LaneBackendSummary['policy'],
	text: string
): LaneBackendLateAttach {
	return {
		summary: summary(policy, 'failed', {
			reason: 'failed',
			reasonText: reasonText(text),
		}),
	};
}

/**
 * Lane up's backend: the worktree's identity comes from its HEAD (the
 * `branch` input is informational). Waits up to `waitMs` for the stack;
 * past that it answers `starting` with a late attach that never rejects.
 */
export async function ensureSupabaseForLane(
	engine: SupabaseEngine,
	input: LaneBackendEnsureInput,
	signal?: AbortSignal
): Promise<LaneBackendEnsureResult> {
	if (input.policy === 'off') {
		return {
			summary: summary('off', 'skipped', {
				reason: 'off',
				reasonText: 'The backend is off for this lane.',
			}),
		};
	}
	// The Mac first: turning the feature on would not help there.
	if (!engine.platform.supported) {
		return {
			summary: summary(input.policy, 'skipped', {
				reason: 'disabled',
				reasonText: reasonText(
					engine.platform.reasonText ??
						'Native Supabase needs Apple silicon and macOS 14 or later.'
				),
			}),
		};
	}
	if (!engine.policySnapshot().enabled) {
		return {
			summary: summary(input.policy, 'skipped', {
				reason: 'disabled',
				reasonText: 'Local Supabase is off in RN Devtools.',
			}),
		};
	}
	try {
		const waitMs = Math.max(
			0,
			Math.min(
				SUPABASE_AGENT_MAX_WAIT_MS,
				Math.floor(input.waitMs ?? LANE_BACKEND_DEFAULT_WAIT_MS)
			)
		);
		if (waitMs === 0) {
			const known = fromRecords(engine, input);
			if (known) return known;
		}
		const facts: SupabaseWorktreeFacts | undefined = await engine.worktreeFacts(
			input.worktreePath,
			input.appPath
		);
		const refused = engine.preflight(facts);
		if (refused || !facts?.expectedStackId) {
			if (input.laneId) engine.detachLane(input.laneId);
			return {
				summary: refused
					? laneRefusalSummary(input.policy, refused)
					: failedAnswer(input.policy, "This worktree's stack can't be named.")
							.summary,
			};
		}
		const stackId = facts.expectedStackId;
		const lane = input.laneId
			? engine.deps.lanes.laneById(input.laneId)
			: undefined;
		if (input.laneId) {
			engine.attachLane({
				laneId: input.laneId,
				stackId,
				worktreePath: input.worktreePath,
				...(input.agent ? { agent: input.agent } : {}),
			});
		}
		let jobId: string | undefined;
		const pending = engine.track(
			engine.ensureStack(facts, {
				requestedBy: input.laneId
					? { kind: 'lane', laneId: input.laneId }
					: { kind: 'operator' },
				createdBy: {
					via: input.agent ? 'agent' : 'desktop',
					...(input.agent ? { agent: input.agent } : {}),
					...(input.laneId ? { laneId: input.laneId } : {}),
				},
				...(input.laneId
					? {
							lane: {
								laneId: input.laneId,
								...(lane?.port === undefined ? {} : { port: lane.port }),
							},
						}
					: {}),
				onJob: (id) => {
					jobId = id;
				},
			})
		);
		const settled = await supabaseWithin(
			engine.timers,
			pending,
			waitMs,
			signal
		);
		if (settled) {
			const answer = answerFor(engine, input, settled);
			return {
				summary: answer.summary,
				...(answer.laneEnv ? { laneEnv: answer.laneEnv } : {}),
			};
		}
		const lateAttach = pending.then(
			(result) => answerFor(engine, input, result),
			() =>
				failedAnswer(input.policy, 'The local backend could not be started.')
		);
		return {
			summary: summary(input.policy, 'starting', {
				stackId,
				...(jobId ? { jobId } : {}),
				reasonText: "Starting this worktree's local Supabase.",
			}),
			lateAttach,
		};
	} catch (error) {
		engine.log(
			`Supabase lane ensure failed: ${error instanceof Error ? error.name : 'error'}`
		);
		// A lane without a backend holds nothing.
		if (input.laneId) engine.detachLane(input.laneId);
		return {
			summary: failedAnswer(
				input.policy,
				'RN Devtools could not ensure this lane’s local backend.'
			).summary,
		};
	}
}

/**
 * The answer from what main already knows, for a Metro restart asking with
 * waitMs 0: the lane's attached stack when it runs, or the job starting it.
 */
function fromRecords(
	engine: SupabaseEngine,
	input: LaneBackendEnsureInput
): LaneBackendEnsureResult | undefined {
	if (!input.laneId) return undefined;
	const attachment = engine.attachment(input.laneId);
	if (!attachment) return undefined;
	const stackId = attachment.stackId;
	const stack = engine
		.getState()
		.stacks.find((candidate) => candidate.id === stackId);
	const facts = engine.factsForStack(stackId);
	if (!stack || !facts) return undefined;
	if (
		stack.state === 'running' ||
		stack.state === 'partial' ||
		stack.state === 'unhealthy'
	) {
		const answer = servedAnswer(engine, input, {
			kind: 'ready',
			stackId,
			facts,
			warnings: [],
		});
		return {
			summary: answer.summary,
			...(answer.laneEnv ? { laneEnv: answer.laneEnv } : {}),
		};
	}
	const job = engine.activeJobFor(stackId);
	if (!job) return undefined;
	const lateAttach = engine
		.waitForJob(job.id, 10 * 60_000)
		.then(async (finished): Promise<LaneBackendLateAttach> => {
			if (finished?.status !== 'complete') {
				return failedAnswer(
					input.policy,
					finished?.error?.message ?? 'The local backend did not start.'
				);
			}
			return servedAnswer(engine, input, {
				kind: 'ready',
				stackId,
				facts,
				warnings: [],
			});
		})
		.catch(() =>
			failedAnswer(input.policy, 'The local backend did not start.')
		);
	return {
		summary: summary(input.policy, 'starting', {
			stackId,
			jobId: job.id,
			reasonText: "Starting this worktree's local Supabase.",
		}),
		lateAttach,
	};
}

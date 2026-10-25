import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
	type AgentCliCommand,
	type AgentCliTarget,
	type AgentReleaseAllResult,
	isSafeAgentConnectedAction,
} from '../shared/agent-cli-protocol';
import type {
	AgentKind,
	AgentOperation,
	AgentState,
} from '../shared/agent-protocol';
import {
	type DeviceAccessDecision,
	isPathInside,
	isSyntheticHolder,
} from '../shared/device-hold';
import {
	type Lane,
	type LaneOperation,
	type LaneOperationReceipt,
	type LaneState,
	laneAppDirectory,
} from '../shared/lane-protocol';
import type {
	DesktopAction,
	DesktopActionResult,
	DesktopState,
	DeviceSession,
} from '../shared/protocol';
import {
	desktopActionCapability,
	desktopActionSchema,
} from '../shared/protocol';
import type {
	SimulatorInput,
	SimulatorInputResult,
} from '../shared/simulator-input-protocol';
import type {
	SimulatorAction,
	SimulatorActionReceipt,
	SimulatorCapture,
	SimulatorJob,
	SimulatorState,
} from '../shared/simulator-protocol';
import {
	SLIMMING_CONFIRMATIONS,
	type SlimmingAction,
	type SlimmingActionReceipt,
	type SlimmingJob,
	type SlimmingState,
} from '../shared/slimming-protocol';
import {
	isSupabaseJobId,
	SUPABASE_AGENT_ERROR_CODES,
	type SupabaseAgentErrorCode,
	type SupabaseAgentOperation,
	type SupabaseAgentResult,
	type SupabaseDoctorInfo,
	type SupabaseJob,
	type SupabaseLogRecord,
	type SupabaseState,
	supabaseAgentOperationFromCommand,
	supabaseAgentRecovery,
	supabaseAgentResultSchema,
	supabaseBranchLabel,
	supabaseDoctorInfoSchema,
} from '../shared/supabase-protocol';
import { AgentCliError, type AgentCliHandler } from './agent-cli-service';
import { TERMINAL_JOB_STATUSES, waitForJob } from './job-wait';
import { NativeHostResponseError } from './native-host-client';
import type { NativePlanResult } from './native-plan';
import { sanitizeSupabaseText } from './supabase/cli-redact';
import type {
	SupabaseReleaseResult,
	SupabaseServiceApi,
} from './supabase/service-ports';

const CONNECTED_WAIT_SLICE_MS = 5_000;
/**
 * The connected-action contract's shortest wait (a `timeoutMs` of at least
 * 50 ms); a wait with less time left than this is over.
 */
const MIN_CONNECTED_WAIT_SLICE_MS = 50;
/**
 * Connected-app wait attempts start at least this far apart. The broker
 * answers some failures at once (the session is offline while the app
 * reloads, or another action is in flight), and retrying those back to back
 * would run on microtasks alone and starve the main process's event loop,
 * the request's abort included.
 */
const CONNECTED_WAIT_RETRY_MS = 250;
/**
 * How long `release --all` waits for its lane stops and for the Supabase
 * service to drop the session's stack holds. The session-end hook's client
 * gives up after 2 s, so stops still running then continue on their own and
 * are reported as pending.
 */
const RELEASE_STOP_BUDGET_MS = 1_500;
/** The contract's bound on one log line, kept after redacting it again. */
const MAX_SUPABASE_LOG_LINE = 2_000;
/**
 * How many recordings' starters are remembered. Only recordings still under
 * way are kept, and the simulator service holds at most 200 jobs without
 * ever dropping one under way, so this bound never forgets a live one.
 */
const MAX_RECORDING_STARTERS = 200;
const ALL_DOCTOR_CAPABILITIES = [
	'push-notifications',
	'storekit',
	'universal-links',
	'icloud-sync',
	'healthkit',
	'homekit',
	'photo-library',
	'contacts',
	'calendar',
	'siri',
	'spotlight',
	'app-store',
] as const;

type BrokerPort = {
	getState: () => DesktopState;
	dispatchAction: (action: DesktopAction) => Promise<DesktopActionResult>;
};

type SimulatorPort = {
	getState: () => SimulatorState;
	refresh: () => Promise<SimulatorState>;
	runAction: (
		action: SimulatorAction,
		context?: { selectedPath?: string }
	) => SimulatorActionReceipt;
	cancelJob: (jobId: string) => boolean;
	subscribe: (listener: (state: SimulatorState) => void) => () => void;
	/** Absolute path of a completed capture's file, verified against the store. */
	verifiedCapturePath?: (captureId: string) => Promise<string>;
};

/** Delivers native HID input to a Simulator; see `native-host-client.ts`. */
type SimulatorInputPort = (
	input: SimulatorInput,
	signal?: AbortSignal
) => Promise<SimulatorInputResult>;

/** Fingerprints a worktree; see `native-plan.ts`. Absent in tests that skip it. */
type NativePlanPort = (
	input: {
		projectRoot: string;
		platform: 'ios' | 'android';
		configuration: string;
	},
	signal?: AbortSignal
) => Promise<NativePlanResult>;

type SlimmingPort = {
	getState: () => SlimmingState;
	refresh: () => Promise<SlimmingState>;
	runAction: (action: SlimmingAction) => SlimmingActionReceipt;
	cancelJob: (jobId: string) => boolean;
	subscribe: (listener: (state: SlimmingState) => void) => () => void;
};

type LanePort = {
	getState: () => LaneState;
	refresh: () => Promise<LaneState>;
	runOperation: (
		operation: LaneOperation,
		signal: AbortSignal
	) => Promise<LaneOperationReceipt>;
};

type AgentPort = {
	getState: () => AgentState;
	refresh: () => Promise<AgentState>;
	runOperation: (operation: AgentOperation) => Promise<AgentState>;
	touch: (
		agent: { kind: AgentKind; sessionId: string },
		simulatorUdid: string
	) => void;
	/**
	 * Whether `requester` may claim the device, start, launch or stop a lane on
	 * it, send it input, install on it, slim it (apply, undo or restore), run a
	 * recipe on it, cancel its jobs, or stop its recordings. A device is free
	 * or held (by a lane or a claim); on a held one only the holder may, and an
	 * abandoned hold is still enforced until its releaseAt. The router does not
	 * ask when a session stops or cancels a recording it started, which it may
	 * always do, even on a device another session holds. Not gated at all: act,
	 * network set and clear, record start, recipe cancel, and the reads.
	 */
	access?: (
		simulatorUdid: string,
		requester: { kind: AgentKind; sessionId: string } | undefined
	) => DeviceAccessDecision;
};

type AgentRecipePort = {
	list: () => Promise<unknown> | unknown;
	get: (recipeId: string) => Promise<unknown> | unknown;
	run: (recipeId: string, udids: readonly string[]) => Promise<unknown>;
	cancel: (runId: string) => Promise<unknown> | unknown;
	status: (runId?: string) => Promise<unknown> | unknown;
};

/**
 * What the router asks of the Supabase service: agent operations, the
 * session release, jobs for `wait` and `jobs`, and state for the feature
 * gate, `agents` and `doctor`.
 */
export type AgentSupabasePort = Pick<
	SupabaseServiceApi,
	| 'getState'
	| 'runAgentOperation'
	| 'releaseHolder'
	| 'job'
	| 'waitForJob'
	| 'doctor'
>;

export type AgentCommandRouterDependencies = {
	broker: BrokerPort;
	simulator: SimulatorPort;
	slimming: SlimmingPort;
	recipes?: AgentRecipePort;
	lanes?: LanePort;
	agents?: AgentPort;
	nativePlan?: NativePlanPort;
	simulatorInput?: SimulatorInputPort;
	/** Absent in tests that skip it, and in builds without local Supabase. */
	supabase?: AgentSupabasePort;
};

function unavailable(message: string, recovery?: string): never {
	throw new AgentCliError({
		code: 'unavailable',
		message,
		retryable: false,
		...(recovery ? { recovery } : {}),
	});
}

function required(message: string): never {
	throw new AgentCliError({
		code: 'invalid_command',
		message,
		retryable: false,
	});
}

function connectedDeviceForTarget(
	state: DesktopState,
	target: AgentCliTarget
): DeviceSession {
	const matches =
		'deviceId' in target
			? state.devices.filter((device) => device.info.id === target.deviceId)
			: state.devices.filter(
					(device) =>
						device.info.simulatorUdid?.toLowerCase() ===
						target.udid.toLowerCase()
				);
	const online = matches.filter((device) => device.status !== 'offline');
	if (online.length === 1) return online[0] as DeviceSession;
	if (online.length > 1) {
		throw new AgentCliError({
			code: 'ambiguous_target',
			message: 'More than one connected app session matches this Simulator.',
			recovery: 'Retry with the exact connected deviceId.',
		});
	}
	if (matches.length > 0) {
		throw new AgentCliError({
			code: 'device_offline',
			message: 'The matching app session is offline.',
			retryable: true,
			recovery: 'Launch the development app in the Simulator and retry.',
		});
	}
	throw new AgentCliError({
		code: 'target_not_found',
		message: 'No connected app session matches the requested target.',
		retryable: true,
		recovery:
			'Run rndevtools doctor and retry with a connectedSessions deviceId or reported Simulator UDID.',
	});
}

function simulatorByUdid(state: SimulatorState, udid: string) {
	const simulator = state.devices.find(
		(device) => device.udid.toLowerCase() === udid.toLowerCase()
	);
	if (!simulator) {
		throw new AgentCliError({
			code: 'target_not_found',
			message:
				'The requested Simulator is not present in the fresh local inventory.',
			retryable: true,
		});
	}
	return simulator;
}

function actionId(requestId: string): string {
	return `agent-${requestId}-${randomUUID()}`.slice(0, 256);
}

async function dispatchConnectedAction(
	broker: BrokerPort,
	device: DeviceSession,
	requestId: string,
	action: { tool: string; command: string; payload: Record<string, unknown> }
): Promise<DesktopActionResult> {
	if (!isSafeAgentConnectedAction(action.tool, action.command)) {
		throw new AgentCliError({
			code: 'approval_required',
			message:
				'This connected-app action is not permitted through the unattended CLI.',
			recovery:
				'Run the action from the desktop app so its confirmation can be shown.',
		});
	}
	const parsed = desktopActionSchema.parse({
		actionId: actionId(requestId),
		deviceId: device.info.id,
		...action,
	});
	const result = await broker.dispatchAction(parsed);
	if (!result.ok) {
		throw new AgentCliError({
			code: 'action_failed',
			message: result.error ?? 'The connected-app action failed.',
			retryable: true,
		});
	}
	return result;
}

type ConnectedWaitAction = {
	tool: 'components';
	command: 'waitForElement' | 'waitForScreenChange';
	payload: Record<string, unknown>;
};

/**
 * Ends a connected wait that retrying cannot help: the app session is gone
 * from the broker, or it does not advertise the wait. An offline session is
 * waited out instead, since an app that reloads comes back as the same one.
 */
function assertWaitable(
	broker: BrokerPort,
	deviceId: string,
	action: ConnectedWaitAction
): void {
	const session = broker
		.getState()
		.devices.find((candidate) => candidate.info.id === deviceId);
	if (!session) {
		throw new AgentCliError({
			code: 'target_not_found',
			message: 'The app session ended while waiting.',
			retryable: true,
			recovery:
				'Run rndevtools doctor and retry with a connectedSessions deviceId or reported Simulator UDID.',
		});
	}
	const capability = desktopActionCapability(action.tool, action.command);
	if (capability && session.info.capabilities.includes(capability)) return;
	const name = capability ?? `${action.tool}.${action.command}`;
	throw new AgentCliError({
		code: 'capability_missing',
		message: `The connected app does not advertise ${name}, so it cannot wait for this condition.`,
		retryable: false,
		recovery: `Poll elements or screen until the condition holds, or have the app's desktop client advertise ${name}.`,
	});
}

async function dispatchConnectedWait(
	broker: BrokerPort,
	device: DeviceSession,
	requestId: string,
	action: ConnectedWaitAction,
	timeoutMs: number,
	signal: AbortSignal
): Promise<DesktopActionResult> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	for (;;) {
		if (signal.aborted) throw abortError();
		assertWaitable(broker, device.info.id, action);
		const startedAt = Date.now();
		const remainingMs = deadline - startedAt;
		if (remainingMs < MIN_CONNECTED_WAIT_SLICE_MS) break;
		try {
			return await dispatchConnectedAction(broker, device, requestId, {
				...action,
				payload: {
					...action.payload,
					timeoutMs: Math.min(CONNECTED_WAIT_SLICE_MS, remainingMs),
				},
			});
		} catch (error) {
			if (!(error instanceof AgentCliError) || error.code !== 'action_failed') {
				throw error;
			}
			lastError = error;
		}
		const pauseMs =
			Math.min(startedAt + CONNECTED_WAIT_RETRY_MS, deadline) - Date.now();
		if (pauseMs > 0) await delay(pauseMs, signal);
	}
	throw (
		lastError ??
		new AgentCliError({
			code: 'action_failed',
			message: 'The connected-app wait timed out.',
			retryable: true,
		})
	);
}

function abortError(): AgentCliError {
	return new AgentCliError({
		code: 'cancelled',
		message: 'The agent request was cancelled.',
		retryable: true,
	});
}

/** Resolves after `ms`, or rejects with {@link abortError} once `signal` aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
	return sleep(ms, undefined, { signal }).catch(() => {
		throw abortError();
	});
}

async function runSimulatorAction(
	service: SimulatorPort,
	action: SimulatorAction,
	signal: AbortSignal,
	wait = true,
	actionContext?: { selectedPath?: string }
): Promise<SimulatorActionReceipt | SimulatorJob> {
	const receipt = service.runAction(action, actionContext);
	if (!receipt.accepted || !receipt.jobId) {
		throw new AgentCliError({
			code: 'action_rejected',
			message: receipt.error ?? 'The Simulator action was rejected.',
			retryable: true,
		});
	}
	return wait
		? await waitForJob(service, receipt.jobId, signal, { abortError })
		: receipt;
}

async function runSlimmingAction(
	service: SlimmingPort,
	action: SlimmingAction,
	signal: AbortSignal
): Promise<SlimmingJob> {
	const receipt = service.runAction(action);
	if (!receipt.accepted || !receipt.jobId) {
		throw new AgentCliError({
			code: 'action_rejected',
			message:
				receipt.error ??
				'The read-only Simulator Slimming action was rejected.',
			retryable: true,
		});
	}
	return await waitForJob(service, receipt.jobId, signal, { abortError });
}

function ensureComplete<T extends { status: string; message: string }>(
	job: T
): T {
	if (job.status === 'complete') return job;
	throw new AgentCliError({
		code: job.status === 'cancelled' ? 'cancelled' : 'action_failed',
		message: job.message,
		retryable: job.status !== 'needs-attention',
	});
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

type SessionIdentity = { kind: AgentKind; sessionId: string };

/**
 * Which holds `release --all` may drop for `agent`. A session's own holds
 * match by id. A shared MCP identity (`mcp-*`) says nothing about which of
 * its sessions is asking, so its holds match only through a lane, when
 * `sessionCwd`, where the ending session worked, lies inside the lane's
 * checkout and in the lane's app or above it. A session at a monorepo
 * checkout's root so releases every app lane in it, and one inside an app
 * only that app's, never a sibling app's that another session may be using.
 * That holds whether the caller is the shared id itself or, from the
 * session-end hook, the session's own id.
 */
function releaseMatcher(agent: SessionIdentity, sessionCwd?: string) {
	const cwd = sessionCwd === undefined ? undefined : posix.resolve(sessionCwd);
	return (
		holder: SessionIdentity | undefined,
		lane: Pick<Lane, 'worktreePath' | 'appPath'> | undefined
	): boolean => {
		if (!holder) return false;
		if (!isSyntheticHolder(holder)) {
			return holder.kind === agent.kind && holder.sessionId === agent.sessionId;
		}
		if (holder.kind !== agent.kind || cwd === undefined || !lane) return false;
		const app = laneAppDirectory(lane);
		return (
			isPathInside(cwd, lane.worktreePath) &&
			(isPathInside(cwd, app) || isPathInside(app, cwd))
		);
	};
}

/**
 * Stops lanes together, detached from the request: the session-end client
 * hangs up after 2 s, and a stop it abandons must still finish. Stops not
 * settled by `deadline` are reported as pending and keep running.
 */
async function stopLanesWithin(
	lanes: LanePort,
	laneIds: readonly string[],
	requestId: string,
	deadline: number
): Promise<{ stopped: string[]; pending: string[]; errors: string[] }> {
	const detached = new AbortController().signal;
	const failures = new Map<string, string | undefined>();
	const stops = laneIds.map(async (laneId) => {
		try {
			const receipt = await lanes.runOperation(
				{ actionId: actionId(requestId), kind: 'lane.stop', laneId },
				detached
			);
			failures.set(
				laneId,
				receipt.completed
					? undefined
					: (receipt.error ??
							(receipt.cancelled
								? 'The lane stop was cancelled.'
								: 'The lane stop did not complete.'))
			);
		} catch (error) {
			failures.set(laneId, errorText(error));
		}
	});
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			Promise.all(stops),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
	const result = {
		stopped: [] as string[],
		pending: [] as string[],
		errors: [] as string[],
	};
	for (const laneId of laneIds) {
		if (!failures.has(laneId)) result.pending.push(laneId);
		else {
			const failure = failures.get(laneId);
			if (failure === undefined) result.stopped.push(laneId);
			else result.errors.push(`lane ${laneId}: ${failure}`);
		}
	}
	return result;
}

/** How a piece of work ended by a deadline; undefined while it still runs. */
type Settled<T> = { value: T } | { error: unknown } | undefined;

/** Waits for `work` until `deadline`, never rejecting. */
async function settleBy<T>(
	work: Promise<T>,
	deadline: number
): Promise<Settled<T>> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			work.then(
				(value) => ({ value }),
				(error: unknown) => ({ error })
			),
			new Promise<undefined>((resolve) => {
				timer = setTimeout(
					() => resolve(undefined),
					Math.max(0, deadline - Date.now())
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Drops the caller's holds on local Supabase stacks. The service releases
 * them in memory and only queues the stops of stacks nobody holds any more,
 * so the call is quick; it starts before the claims and lanes and is waited
 * for only up to the release deadline.
 */
async function releaseStacks(
	supabase: AgentSupabasePort,
	holder: SessionIdentity,
	sessionCwd: string | undefined
): Promise<SupabaseReleaseResult> {
	return await supabase.releaseHolder({
		holder,
		...(sessionCwd === undefined ? {} : { sessionCwd }),
	});
}

function stackReleaseOutcome(settled: Settled<SupabaseReleaseResult>): {
	releasedStacks: string[];
	pendingStops: string[];
	errors: string[];
} {
	if (settled === undefined) {
		return {
			releasedStacks: [],
			pendingStops: [],
			errors: [
				'supabase: dropping the stack holds took longer than 1.5 s and continues in the background.',
			],
		};
	}
	if ('error' in settled) {
		return {
			releasedStacks: [],
			pendingStops: [],
			errors: [
				`supabase: ${sanitizeSupabaseText(errorText(settled.error), { maxChars: 512 })}`,
			],
		};
	}
	return {
		releasedStacks: [...settled.value.releasedStackIds],
		pendingStops: [...settled.value.pendingStops],
		errors: [],
	};
}

/**
 * Drops every claim, stops every lane and drops every Supabase stack hold
 * the calling session has, within the session-end hook's 2 s. The stack
 * release starts first and claims go next: both are quick, and claims return
 * devices to the pool at once. Each failure is reported rather than aborting
 * the rest, because a session-end hook has one shot and a half-released pool
 * is better than none.
 */
async function releaseEverything(
	agents: AgentPort,
	lanes: LanePort | undefined,
	supabase: AgentSupabasePort | undefined,
	context: Parameters<AgentCliHandler>[1],
	sessionCwd: string | undefined
): Promise<AgentReleaseAllResult> {
	const agent = context.agent;
	if (!agent) {
		throw new AgentCliError({
			code: 'no_agent_session',
			message: 'release --all needs an agent session to release on behalf of.',
			retryable: false,
			recovery:
				'Run from Claude Code or Codex, or export RNDEVTOOLS_AGENT_SESSION_ID.',
		});
	}
	const deadline = Date.now() + RELEASE_STOP_BUDGET_MS;
	// A shared MCP identity names no one session, so without the directory it
	// worked in nothing of it is released, stack holds included.
	const unscoped = isSyntheticHolder(agent) && sessionCwd === undefined;
	const stacks =
		supabase && !unscoped
			? settleBy(
					releaseStacks(
						supabase,
						agent,
						sessionCwd === undefined ? undefined : posix.resolve(sessionCwd)
					),
					deadline
				)
			: undefined;
	const callerHolds = releaseMatcher(agent, sessionCwd);
	const laneList = lanes?.getState().lanes ?? [];
	const released: string[] = [];
	const errors: string[] = [];

	for (const claim of agents.getState().claims) {
		const holder = { kind: claim.kind, sessionId: claim.sessionId };
		// A claim has no directory of its own; a shared identity's claim goes
		// with its lane on the same device, when it runs one.
		const lane = laneList.find(
			(candidate) =>
				candidate.simulatorUdid.toUpperCase() ===
					claim.simulatorUdid.toUpperCase() &&
				candidate.agent?.kind === claim.kind &&
				candidate.agent.sessionId === claim.sessionId
		);
		if (!callerHolds(holder, lane)) continue;
		try {
			await agents.runOperation({
				kind: 'agent.release',
				simulatorUdid: claim.simulatorUdid,
				agent: holder,
			});
			released.push(claim.simulatorUdid);
		} catch (error) {
			errors.push(`claim ${claim.simulatorUdid}: ${errorText(error)}`);
		}
	}

	const laneIds = laneList
		.filter((lane) => callerHolds(lane.agent, lane))
		.map((lane) => lane.id);
	const outcome =
		lanes && laneIds.length > 0
			? await stopLanesWithin(lanes, laneIds, context.requestId, deadline)
			: { stopped: [], pending: [], errors: [] };
	const stackOutcome = stacks
		? stackReleaseOutcome(await stacks)
		: { releasedStacks: [], pendingStops: [], errors: [] };
	return {
		you: agent,
		stoppedLanes: outcome.stopped,
		pendingLanes: outcome.pending,
		releasedClaims: released,
		...(supabase
			? {
					releasedStacks: stackOutcome.releasedStacks,
					pendingStops: stackOutcome.pendingStops,
				}
			: {}),
		errors: [...errors, ...outcome.errors, ...stackOutcome.errors],
		...(unscoped
			? {
					next: supabase
						? `${agent.kind}:${agent.sessionId} is shared by every ${agent.kind} session connected over MCP, so release --all drops its lanes, claims, and Supabase stack holds only with sessionCwd, the directory you work in. Pass sessionCwd with all, or stop each of your lanes with lane --operation down, release each claim with release --udid, and drop each stack with supabase --operation down.`
						: `${agent.kind}:${agent.sessionId} is shared by every ${agent.kind} session connected over MCP, so release --all drops its lanes and claims only with sessionCwd, the directory you work in. Pass sessionCwd with all, or stop each of your lanes with lane --operation down and release each claim with release --udid.`,
				}
			: {}),
	};
}

const MUTATING_SLIMMING_OPERATIONS = new Set(['apply', 'undo', 'restore']);

/**
 * Builds the slimming action for a CLI command. Mutations carry the exact
 * confirmation literal the schema demands (the CLI is a trusted local peer
 * acting for a named session; the confirmation protects against stray payloads,
 * not against the agent) and the requesting session, so the service can check
 * who holds each device.
 */
function slimmingActionFor(
	command: Extract<AgentCliCommand, { kind: 'slimming' }>,
	canonicalUdids: string[],
	id: string,
	agent: { kind: AgentKind; sessionId: string } | undefined
): SlimmingAction {
	const requester = agent ? { requester: agent } : {};
	switch (command.operation) {
		case 'doctor':
			return {
				actionId: id,
				kind: 'doctor.run',
				simulatorUdids: canonicalUdids,
				requiredCapabilities: [...ALL_DOCTOR_CAPABILITIES],
			};
		case 'preview':
		case 'verify':
			return {
				actionId: id,
				kind:
					command.operation === 'preview'
						? 'profile.preview'
						: 'profile.verify',
				simulatorUdids: canonicalUdids,
				profileId:
					command.profileId ??
					required('Slimming preview and verify require profileId.'),
			};
		case 'apply':
			return {
				actionId: id,
				kind: 'profile.apply',
				simulatorUdids: canonicalUdids,
				profileId:
					command.profileId ?? required('Slimming apply requires profileId.'),
				confirmation: SLIMMING_CONFIRMATIONS.apply,
				...requester,
			};
		case 'undo':
			return {
				actionId: id,
				kind: 'profile.undo',
				simulatorUdids: canonicalUdids,
				confirmation: SLIMMING_CONFIRMATIONS.undo,
				...requester,
			};
		case 'restore':
			return {
				actionId: id,
				kind: 'profile.restore',
				simulatorUdids: canonicalUdids,
				confirmation: SLIMMING_CONFIRMATIONS.restore,
				...requester,
			};
		default:
			return required(`Unsupported slimming operation ${command.operation}.`);
	}
}

/**
 * Refuses an agent's request to touch a Simulator another holder has. The
 * operator (no agent on the request) is never refused here; the lane and
 * slimming services keep their own structural rules.
 */
function assertDeviceAccess(
	agents: AgentPort | undefined,
	simulatorUdid: string,
	requester: { kind: AgentKind; sessionId: string } | undefined
): void {
	if (!agents?.access || !requester) return;
	const decision = agents.access(simulatorUdid, requester);
	if (decision.allowed) return;
	throw new AgentCliError({
		code: 'device_held',
		message: decision.reason,
		retryable: true,
		recovery:
			'Run simulators and agents to find a free device, or ask the user to release this one in RN Devtools.',
	});
}

/**
 * Which agent session started each recording, so that session can always
 * stop it. Starting one needs no hold, since it only watches the screen, and
 * the device can be claimed or get another session's lane before the
 * recording ends, up to an hour later; the hold check that guards stopping
 * anyone else's recording would then strand it. A recording a shared MCP
 * identity started is any of its sessions' to stop: the identity cannot tell
 * them apart.
 */
function recordingStarters(simulator: SimulatorPort) {
	const starters = new Map<string, SessionIdentity>();
	return {
		add(jobId: string, agent: SessionIdentity): void {
			const underWay = new Set(
				simulator
					.getState()
					.jobs.filter((job) => !TERMINAL_JOB_STATUSES.has(job.status))
					.map((job) => job.id)
			);
			for (const id of starters.keys()) {
				if (!underWay.has(id)) starters.delete(id);
			}
			starters.set(jobId, { kind: agent.kind, sessionId: agent.sessionId });
			for (const id of starters.keys()) {
				if (starters.size <= MAX_RECORDING_STARTERS) break;
				starters.delete(id);
			}
		},
		/** Whether `agent` started recording `jobId`; never the operator. */
		startedBy(jobId: string, agent: SessionIdentity | undefined): boolean {
			const starter = starters.get(jobId);
			return (
				starter !== undefined &&
				agent !== undefined &&
				starter.kind === agent.kind &&
				starter.sessionId === agent.sessionId
			);
		},
	};
}

/** The Simulators a simulator or slimming job works on. */
function jobSimulators(
	simulatorState: SimulatorState,
	slimmingState: SlimmingState,
	jobId: string
): string[] {
	const simulatorJob = simulatorState.jobs.find((job) => job.id === jobId);
	if (simulatorJob) {
		return simulatorJob.deviceUdid ? [simulatorJob.deviceUdid] : [];
	}
	return (
		slimmingState.jobs
			.find((job) => job.id === jobId)
			?.targets.map((target) => target.simulatorUdid) ?? []
	);
}

function captureForJob(
	state: SimulatorState,
	job: SimulatorJob
): SimulatorCapture {
	const capture = state.captures.find(
		(candidate) => candidate.id === job.captureId
	);
	if (!capture) {
		throw new AgentCliError({
			code: 'capture_missing',
			message: 'The capture job completed without published capture metadata.',
			retryable: true,
		});
	}
	return capture;
}

function compactSimulatorState(
	state: SimulatorState,
	includeUnavailable: boolean
) {
	return {
		capability: state.capability,
		updatedAt: state.updatedAt,
		devices: state.devices
			.filter((device) => includeUnavailable || device.isAvailable)
			.map((device) => ({
				...device,
				metrics: state.metrics.byDevice[device.udid],
				apps: state.appsByDevice[device.udid]?.length ?? 0,
			})),
	};
}

function compactScreen(device: DeviceSession) {
	return {
		device: device.info,
		status: device.status,
		lastSeenAt: device.lastSeenAt,
		screenHash: device.tools.componentSummary.screenHash,
		componentSummary: device.tools.componentSummary,
		activeRoute: device.tools.routes.find((route) => route.isCurrent),
		viewport: device.info.viewport,
	};
}

function compactConnectedSession(device: DeviceSession) {
	return {
		deviceId: device.info.id,
		name: device.info.name,
		platform: device.info.platform,
		status: device.status,
		lastSeenAt: device.lastSeenAt,
		...(device.info.appVersion ? { appVersion: device.info.appVersion } : {}),
		...(device.info.variant ? { variant: device.info.variant } : {}),
		...(device.info.simulatorUdid
			? { simulatorUdid: device.info.simulatorUdid }
			: {}),
		...(device.info.bundleIdentifier
			? { bundleIdentifier: device.info.bundleIdentifier }
			: {}),
		capabilities: device.info.capabilities,
	};
}

async function waitForNetworkIdle(
	broker: BrokerPort,
	device: DeviceSession,
	quietMs: number,
	signal: AbortSignal
): Promise<{ idleAt: number }> {
	let quietSince = Date.now();
	while (!signal.aborted) {
		const current = broker
			.getState()
			.devices.find((candidate) => candidate.info.id === device.info.id);
		if (!current || current.status === 'offline') {
			throw new AgentCliError({
				code: 'device_offline',
				message: 'The app session disconnected while waiting for network idle.',
				retryable: true,
			});
		}
		if (current.tools.network.some((entry) => entry.state === 'pending')) {
			quietSince = Date.now();
		} else if (Date.now() - quietSince >= quietMs) {
			return { idleAt: Date.now() };
		}
		await delay(Math.min(quietMs, 250), signal);
	}
	throw abortError();
}

function laneForTarget(
	state: LaneState,
	target: { laneId?: string | undefined; worktreePath?: string | undefined }
) {
	const lane = target.laneId
		? state.lanes.find((candidate) => candidate.id === target.laneId)
		: state.lanes.find(
				(candidate) =>
					laneAppDirectory(candidate) === target.worktreePath ||
					candidate.worktreePath === target.worktreePath
			);
	if (!lane) {
		throw new AgentCliError({
			code: 'lane_not_found',
			message: target.laneId
				? `No lane ${target.laneId} exists.`
				: `No lane is running for worktree ${target.worktreePath}.`,
			retryable: false,
			recovery:
				'Run rndevtools lane --operation ls to see live lanes, or lane --operation up to start one.',
		});
	}
	return lane;
}

function laneReceiptResult(receipt: LaneOperationReceipt) {
	if (!receipt.completed) {
		throw new AgentCliError({
			code: receipt.cancelled ? 'cancelled' : 'lane_failed',
			message: receipt.error ?? 'The lane operation did not complete.',
			retryable: true,
		});
	}
	const { state: _state, actionId: _actionId, ...rest } = receipt;
	return rest;
}

/**
 * The Simulators a command drove, for agent attribution. Read after the
 * command succeeded so a rejected command never counts as a touch. Connected
 * app targets are resolved to the Simulator the session reported.
 */
function touchedSimulators(
	command: AgentCliCommand,
	broker: BrokerPort,
	result: unknown
): string[] {
	const fromTarget = (target: AgentCliTarget | undefined): string[] => {
		if (!target) return [];
		if ('udid' in target) return [target.udid];
		const device = broker
			.getState()
			.devices.find((candidate) => candidate.info.id === target.deviceId);
		return device?.info.simulatorUdid ? [device.info.simulatorUdid] : [];
	};
	switch (command.kind) {
		case 'apps':
		case 'capture':
		case 'record':
			return [command.udid];
		case 'screen':
		case 'elements':
		case 'act':
		case 'network':
		case 'wait':
			return fromTarget(command.target);
		case 'slimming':
		case 'recipe':
			return command.udids ?? [];
		case 'native':
			return command.udid ? [command.udid] : [];
		case 'input':
			return [command.input.udid];
		case 'lane': {
			const lane = (result as { lane?: { simulatorUdid?: string } } | null)
				?.lane;
			return lane?.simulatorUdid ? [lane.simulatorUdid] : [];
		}
		default:
			return [];
	}
}

function supabaseUnavailable(): never {
	return unavailable(
		'Local Supabase is not available in this desktop session.',
		'Update RN Devtools and retry.'
	);
}

/**
 * What an agent does while local Supabase is off: ask the user, or start its
 * own stack with the repository's CLI, and then only on the native runtime.
 */
function supabaseOffRecovery(runner?: string): string {
	const start =
		runner === undefined
			? "the repository's own Supabase CLI, through its package manager: `supabase start --runtime native`"
			: `\`${runner} start --runtime native\``;
	return `Ask the user to turn on local Supabase in RN Devtools › Supabase, then call supabase again. If you must have a database before then, start it yourself from the worktree with ${start} (never without --runtime native).`;
}

/**
 * Refuses before the service runs anything when RN Devtools cannot manage
 * local Supabase on this Mac, or the user has it off. A settings file the
 * desktop could not read counts as off.
 */
function assertSupabaseManaged(
	state: Pick<SupabaseState, 'availability' | 'feature'>
): void {
	if (!state.availability.platform.supported) {
		throw new AgentCliError({
			code: 'supabase_unsupported',
			message:
				state.availability.platform.reasonText ??
				'RN Devtools cannot run local Supabase on this Mac.',
			retryable: false,
			recovery: supabaseAgentRecovery('supabase_unsupported'),
		});
	}
	if (!state.feature.enabled || state.feature.policyHealth === 'quarantined') {
		throw new AgentCliError({
			code: 'supabase_disabled',
			message:
				state.feature.policyHealth === 'quarantined'
					? 'RN Devtools could not read its local Supabase settings, so local Supabase is off.'
					: 'Local Supabase is off in RN Devtools, so it is not managing this worktree.',
			retryable: false,
			recovery: supabaseOffRecovery(),
		});
	}
}

const SUPABASE_AGENT_CODES: ReadonlySet<string> = new Set(
	SUPABASE_AGENT_ERROR_CODES
);
/** Failures an agent can clear itself: by waiting, releasing, or calling up again. */
const RETRYABLE_SUPABASE_CODES: ReadonlySet<SupabaseAgentErrorCode> = new Set([
	'supabase_capacity',
	'cli_mismatch',
	'job_lost',
	'branch_moved',
	'git_busy',
	'supabase_failed',
]);
/** The renderer-facing codes whose agent meaning is unambiguous. */
const SUPABASE_AGENT_CODE_BY_VIEW_CODE: Readonly<
	Record<string, SupabaseAgentErrorCode>
> = {
	feature_off: 'supabase_disabled',
	platform_unsupported: 'supabase_unsupported',
	unknown_target: 'not_found',
	capacity: 'supabase_capacity',
};
/** A worktree runner such as `pnpm exec supabase`, safe inside backticks. */
const SUPABASE_RUNNER = /^[A-Za-z0-9./][A-Za-z0-9 ._/@:-]{0,63}$/;

function isSupabaseAgentErrorCode(
	code: string
): code is SupabaseAgentErrorCode {
	return SUPABASE_AGENT_CODES.has(code);
}

/** An own string property of a thrown value, read without running getters. */
function ownString(value: unknown, key: string): string | undefined {
	if (value === null || typeof value !== 'object') return undefined;
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return descriptor &&
			'value' in descriptor &&
			typeof descriptor.value === 'string'
			? descriptor.value
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * Turns a failed agent operation into a typed error whose recovery names the
 * next call. The service throws AgentCliError, or any error whose `code` is
 * one of SUPABASE_AGENT_ERROR_CODES (an own `runner` string names the
 * worktree's CLI). Renderer-shaped failures map onto the agent codes, and
 * their operator-facing recovery copy is replaced. Local Supabase being off
 * always reads the same way.
 */
function supabaseAgentFailure(
	error: unknown,
	signal: AbortSignal
): AgentCliError {
	const reportedRunner = ownString(error, 'runner');
	const runner =
		reportedRunner !== undefined && SUPABASE_RUNNER.test(reportedRunner)
			? reportedRunner
			: undefined;
	if (error instanceof AgentCliError) {
		const code = error.code;
		if (code === 'supabase_disabled') {
			return new AgentCliError({
				code,
				message: error.message,
				retryable: false,
				recovery: supabaseOffRecovery(runner),
			});
		}
		if (error.recovery !== undefined || !isSupabaseAgentErrorCode(code)) {
			return error;
		}
		return new AgentCliError({
			code,
			message: error.message,
			retryable: error.retryable,
			recovery: supabaseAgentRecovery(code, runner),
		});
	}
	if (signal.aborted) return abortError();
	const reportedCode = ownString(error, 'code');
	const agentCode =
		reportedCode !== undefined && isSupabaseAgentErrorCode(reportedCode)
			? reportedCode
			: undefined;
	const code =
		agentCode ??
		(reportedCode === undefined
			? undefined
			: SUPABASE_AGENT_CODE_BY_VIEW_CODE[reportedCode]) ??
		'supabase_failed';
	const message = ownString(error, 'message');
	const recovery =
		agentCode === undefined ? undefined : ownString(error, 'recovery');
	return new AgentCliError({
		code,
		message: message
			? sanitizeSupabaseText(message, { maxChars: 1_024 })
			: 'The local Supabase request failed.',
		retryable: RETRYABLE_SUPABASE_CODES.has(code),
		recovery:
			code === 'supabase_disabled'
				? supabaseOffRecovery(runner)
				: (recovery ?? supabaseAgentRecovery(code, runner)),
	});
}

/**
 * Key material that may cross the socket only as an `env` result's public
 * values: Supabase API keys, JWTs, and passwords in URLs.
 */
const SUPABASE_KEY_MATERIAL =
	/sb_(?:secret|publishable)_|(?<![\w-])eyJ[\w-]{2,}\.[\w-]*|\/\/[^\s:/?#@"]*:(?!\[REDACTED\]@)[^\s/?#"]*@/;

function withheldSupabaseResult(): AgentCliError {
	return new AgentCliError({
		code: 'supabase_failed',
		message:
			'RN Devtools withheld a local Supabase result that did not fit the agent contract.',
		retryable: true,
		recovery: supabaseAgentRecovery('supabase_failed'),
	});
}

function redactedLogRecord(record: SupabaseLogRecord): SupabaseLogRecord {
	return record.type === 'entry'
		? {
				...record,
				line: sanitizeSupabaseText(record.line, {
					maxChars: MAX_SUPABASE_LOG_LINE,
				}),
			}
		: record;
}

/**
 * Checks what the service answered before it crosses the socket: the strict
 * agent result for the operation asked, service log lines redacted once more
 * (they can carry query strings and SQL), and no key material outside `env`.
 */
function checkedSupabaseResult(
	operation: SupabaseAgentOperation,
	result: unknown
): SupabaseAgentResult {
	const parsed = supabaseAgentResultSchema.safeParse(result);
	if (!parsed.success || parsed.data.operation !== operation.operation) {
		throw withheldSupabaseResult();
	}
	const checked: SupabaseAgentResult =
		parsed.data.operation === 'log'
			? {
					...parsed.data,
					records: parsed.data.records.map(redactedLogRecord),
				}
			: parsed.data;
	if (
		checked.operation !== 'env' &&
		SUPABASE_KEY_MATERIAL.test(JSON.stringify(checked))
	) {
		throw withheldSupabaseResult();
	}
	return checked;
}

/**
 * Where the calling session works, when discovery has seen it. A shared MCP
 * identity stands for several sessions, so it has no one directory.
 */
function sessionCwdOf(
	agents: AgentPort | undefined,
	holder: SessionIdentity | undefined
): string | undefined {
	if (!agents || !holder || isSyntheticHolder(holder)) return undefined;
	const session = agents
		.getState()
		.sessions.find(
			(candidate) =>
				candidate.kind === holder.kind &&
				candidate.sessionId === holder.sessionId
		);
	return session?.cwd?.startsWith('/') ? session.cwd : undefined;
}

/** A Supabase job the service still follows; otherwise `job_lost`. */
function followedSupabaseJob(
	job: SupabaseJob | undefined,
	jobId: string
): SupabaseJob {
	if (job && job.status !== 'lost') return job;
	throw new AgentCliError({
		code: 'job_lost',
		message: job
			? `RN Devtools lost track of Supabase job ${jobId}, for example across a restart.`
			: `RN Devtools has no record of Supabase job ${jobId}.`,
		retryable: true,
		recovery: supabaseAgentRecovery('job_lost'),
	});
}

/**
 * Every agent session's hold on a local Supabase stack, shaped like the
 * Simulator holds beside it: through a lane, a session's own `supabase up`,
 * or the worktree a shared MCP identity's sessions work in.
 */
function supabaseHolds(state: Pick<SupabaseState, 'stacks'>) {
	return state.stacks.flatMap((stack) => {
		const branch = supabaseBranchLabel(stack.branchContext);
		return stack.holds.flatMap((hold) =>
			hold.holder === 'operator' || !hold.agent
				? []
				: [
						{
							stackId: stack.id,
							...(branch === undefined ? {} : { branch }),
							via: hold.holder,
							...(hold.holder === 'lane' ? { laneId: hold.laneId } : {}),
							holder: {
								kind: hold.agent.kind,
								sessionId: hold.agent.sessionId,
							},
							holderLive: hold.live,
							...(hold.abandonedSince === undefined
								? {}
								: { abandonedSince: hold.abandonedSince }),
							...(hold.releaseAt === undefined
								? {}
								: { releaseAt: hold.releaseAt }),
						},
					]
		);
	});
}

/** Doctor's Supabase section; a failure to read it never fails doctor. */
function supabaseDoctor(
	supabase: AgentSupabasePort
): SupabaseDoctorInfo | { capability: 'unavailable'; error: string } {
	try {
		return supabaseDoctorInfoSchema.parse(supabase.doctor());
	} catch {
		return {
			capability: 'unavailable',
			error: 'RN Devtools could not read its local Supabase state.',
		};
	}
}

/**
 * What lane up says about the worktree's local Supabase: the job to follow
 * while it is still starting, and why a lane that required it failed.
 */
function laneUpResult(receipt: LaneOperationReceipt) {
	const backend = receipt.backend;
	if (
		!receipt.completed &&
		!receipt.cancelled &&
		backend?.policy === 'required'
	) {
		throw new AgentCliError({
			code: 'lane_failed',
			message:
				receipt.error ??
				backend.reasonText ??
				"The lane requires this worktree's local Supabase, which did not start.",
			retryable: true,
			recovery:
				'Call supabase --operation up for this worktree to see why its stack cannot start, or run lane up with backend auto to start the lane without it.',
		});
	}
	const result = laneReceiptResult(receipt);
	if (backend?.status !== 'starting' || backend.jobId === undefined) {
		return result;
	}
	const launch =
		backend.launch === 'deferred'
			? '; the dev client launches once it is ready'
			: '';
	return {
		...result,
		next: `This worktree's local Supabase is still starting${launch}. Follow it with wait --condition job --job-id ${backend.jobId}.`,
	};
}

export function createAgentCommandRouter(
	dependencies: AgentCommandRouterDependencies
): AgentCliHandler {
	const route = createRoutes(dependencies);
	return async (command, context) => {
		const result = await route(command, context);
		if (context.agent && dependencies.agents) {
			for (const udid of touchedSimulators(
				command,
				dependencies.broker,
				result
			)) {
				dependencies.agents.touch(context.agent, udid);
			}
		}
		return result;
	};
}

function createRoutes({
	broker,
	simulator,
	slimming,
	recipes,
	lanes,
	agents,
	nativePlan,
	simulatorInput,
	supabase,
}: AgentCommandRouterDependencies): AgentCliHandler {
	const recordings = recordingStarters(simulator);
	return async (command, context) => {
		switch (command.kind) {
			case 'supabase': {
				if (!supabase) supabaseUnavailable();
				const mapped = supabaseAgentOperationFromCommand(command);
				if (!mapped.ok) required(mapped.message);
				assertSupabaseManaged(supabase.getState());
				// Identity comes from the envelope only. A shared MCP identity is
				// matched by worktree, so it carries no session directory.
				const holder = context.agent;
				const sessionCwd = sessionCwdOf(agents, holder);
				let result: SupabaseAgentResult;
				try {
					result = await supabase.runAgentOperation(
						mapped.operation,
						{
							requestId: context.requestId,
							synthetic: holder !== undefined && isSyntheticHolder(holder),
							...(holder ? { holder } : {}),
							...(sessionCwd ? { sessionCwd } : {}),
						},
						context.signal
					);
				} catch (error) {
					throw supabaseAgentFailure(error, context.signal);
				}
				return checkedSupabaseResult(mapped.operation, result);
			}
			case 'input': {
				if (!simulatorInput) {
					unavailable(
						'Native Simulator input is not available in this desktop session.',
						'Update RN Devtools and retry.'
					);
				}
				// Resolve against the fresh inventory so a typo in the UDID reads as
				// target_not_found rather than a HID error from the host.
				const target = simulatorByUdid(
					await simulator.refresh(),
					command.input.udid
				);
				if (target.state !== 'booted') {
					throw new AgentCliError({
						code: 'simulator_not_booted',
						message: `${target.name} is ${target.state}; input needs a booted Simulator.`,
						retryable: true,
						recovery:
							'Boot it (rndevtools lane up, or the desktop app) and retry.',
					});
				}
				assertDeviceAccess(agents, target.udid, context.agent);
				try {
					return await simulatorInput(
						{ ...command.input, udid: target.udid },
						context.signal
					);
				} catch (error) {
					if (error instanceof AgentCliError) throw error;
					const code =
						error instanceof NativeHostResponseError
							? error.code
							: 'input_failed';
					throw new AgentCliError({
						code: code.replace(/[^a-z0-9_]/g, '_'),
						message: error instanceof Error ? error.message : String(error),
						retryable: true,
						...(code === 'simulator_input_unavailable'
							? {
									recovery:
										'This Xcode does not expose the Simulator HID path the host needs; update Xcode or drive the app through its connected session instead.',
								}
							: {}),
					});
				}
			}
			case 'agents': {
				if (!agents) {
					unavailable(
						'Agent attribution is not available in this desktop session.',
						'Update RN Devtools and retry.'
					);
				}
				const state = await agents.refresh();
				return {
					sessions: state.sessions,
					devices: Object.entries(state.byDevice).map(([udid, attached]) => ({
						udid,
						agents: attached,
					})),
					claims: state.claims,
					// Which Simulators are held, by whom, and whether that holder is
					// still alive: the direct answer to "which device may I take".
					holds: Object.values(state.holds),
					// The same for each session's local Supabase stacks.
					...(supabase
						? { supabaseHolds: supabaseHolds(supabase.getState()) }
						: {}),
					discovery: state.discovery,
					...(context.agent ? { you: context.agent } : {}),
				};
			}
			case 'claim':
			case 'release': {
				if (!agents) {
					unavailable(
						'Agent attribution is not available in this desktop session.',
						'Update RN Devtools and retry.'
					);
				}
				if (!context.agent) {
					throw new AgentCliError({
						code: 'no_agent_session',
						message:
							'This CLI is not running inside a recognised agent session, so it cannot claim or release.',
						retryable: false,
						recovery:
							'Run from Claude Code or Codex, or export RNDEVTOOLS_AGENT_SESSION_ID.',
					});
				}
				if (command.kind === 'release' && command.all) {
					return releaseEverything(
						agents,
						lanes,
						supabase,
						context,
						command.sessionCwd
					);
				}
				const target = simulatorByUdid(
					await simulator.refresh(),
					command.udid ?? required('release requires udid or all.')
				);
				// A claim is a hold, so a device someone else holds is refused.
				// Nothing is awaited between this check and the claim, so two
				// sessions racing for a free device cannot both get it.
				if (command.kind === 'claim') {
					assertDeviceAccess(agents, target.udid, context.agent);
				}
				const state = await agents.runOperation(
					command.kind === 'claim'
						? {
								kind: 'agent.claim',
								simulatorUdid: target.udid,
								agent: context.agent,
								...(command.note ? { note: command.note } : {}),
							}
						: {
								kind: 'agent.release',
								simulatorUdid: target.udid,
								agent: context.agent,
							}
				);
				return {
					udid: target.udid,
					you: context.agent,
					agents: state.byDevice[target.udid] ?? [],
					claims: state.claims.filter(
						(claim) => claim.simulatorUdid === target.udid
					),
				};
			}
			case 'native': {
				if (!nativePlan) {
					unavailable(
						'Native build planning is not available in this desktop session.',
						'Update RN Devtools and retry.'
					);
				}
				const plan = await nativePlan(
					{
						projectRoot: command.worktreePath,
						platform: 'ios',
						configuration: command.configuration,
					},
					context.signal
				);
				// Installed state: list the Simulator's apps and look for the bundle
				// the worktree declares. Only when a UDID was given.
				let installed: boolean | undefined;
				let target: SimulatorState['devices'][number] | undefined;
				if (command.udid) {
					target = simulatorByUdid(await simulator.refresh(), command.udid);
					if (plan.bundleIdentifier) {
						await runSimulatorAction(
							simulator,
							{
								actionId: actionId(context.requestId),
								kind: 'app.list',
								udid: target.udid,
							},
							context.signal
						);
						const wanted = plan.bundleIdentifier.toLowerCase();
						installed = (
							simulator.getState().appsByDevice[target.udid] ?? []
						).some((app) => app.bundleIdentifier.toLowerCase() === wanted);
					}
				}
				// Debug is run:ios's default, and Expo CLI starts its own Metro (on
				// 8081, on every interface) whenever --configuration Debug is passed,
				// --no-bundler or not. Name the configuration only when it is another.
				const configurationFlag =
					plan.configuration === 'Debug'
						? ''
						: ` --configuration ${plan.configuration}`;
				const buildCommand = `npx expo run:ios${configurationFlag}${target ? ` --device ${target.udid}` : ''} --no-bundler`;
				const recommendation =
					installed === true
						? 'installed: the Simulator already has this native build; start or launch a lane.'
						: plan.cache === 'hit'
							? target
								? 'install: a cached binary matches this fingerprint; run native --operation install to put it on the Simulator without building.'
								: 'cached: a binary for this fingerprint exists; pass --udid to install it.'
							: plan.cache === 'miss'
								? `build: no cached binary for this fingerprint; run \`${buildCommand}\` once (the build cache will store it for every other worktree).`
								: `build: this project declares no buildCacheProvider, so every worktree builds; run \`${buildCommand}\`.`;
				if (command.operation === 'plan') {
					return {
						...plan,
						...(target ? { simulatorUdid: target.udid } : {}),
						...(installed !== undefined ? { installed } : {}),
						recommendation,
					};
				}
				if (!target) required('native install requires udid.');
				// Installing can replace the dev client a lane runs, so only the
				// device's holder may.
				assertDeviceAccess(agents, target.udid, context.agent);
				if (installed) {
					return {
						...plan,
						simulatorUdid: target.udid,
						installed: true,
						action: 'already-installed',
					};
				}
				if (plan.cache !== 'hit' || !plan.artifactPath) {
					throw new AgentCliError({
						code: 'cache_miss',
						message: `No cached binary for fingerprint ${plan.fingerprintHash}; build it first.`,
						retryable: false,
						recovery: buildCommand,
					});
				}
				const job = ensureComplete(
					(await runSimulatorAction(
						simulator,
						{
							actionId: actionId(context.requestId),
							kind: 'app.install',
							udid: target.udid,
						},
						context.signal,
						true,
						{ selectedPath: plan.artifactPath }
					)) as SimulatorJob
				);
				return {
					...plan,
					simulatorUdid: target.udid,
					installed: true,
					action: 'installed-from-cache',
					job,
				};
			}
			case 'doctor': {
				const [simulatorState, slimmingState] = await Promise.all([
					simulator.refresh(),
					slimming.refresh(),
				]);
				const brokerState = broker.getState();
				const { urls: _urls, ...brokerSummary } = brokerState.broker;
				const connectedSessions = brokerState.devices
					.filter((device) => device.status !== 'offline')
					.map(compactConnectedSession);
				return {
					broker: brokerSummary,
					connectedDevices: connectedSessions.length,
					connectedSessions,
					simulator: simulatorState.capability,
					native: simulatorState.native,
					slimming: slimmingState.helper,
					// Platform, whether it is on, and each repository's CLI gate.
					...(supabase ? { supabase: supabaseDoctor(supabase) } : {}),
				};
			}
			case 'simulators': {
				return compactSimulatorState(
					await simulator.refresh(),
					command.includeUnavailable
				);
			}
			case 'apps': {
				const fresh = await simulator.refresh();
				const target = simulatorByUdid(fresh, command.udid);
				const job = ensureComplete(
					(await runSimulatorAction(
						simulator,
						{
							actionId: actionId(context.requestId),
							kind: 'app.list',
							udid: target.udid,
						},
						context.signal
					)) as SimulatorJob
				);
				return {
					job,
					apps: simulator.getState().appsByDevice[target.udid] ?? [],
				};
			}
			case 'screen': {
				return compactScreen(
					connectedDeviceForTarget(broker.getState(), command.target)
				);
			}
			case 'elements': {
				const device = connectedDeviceForTarget(
					broker.getState(),
					command.target
				);
				const query = command.query?.trim().toLowerCase();
				const elements = device.tools.components
					.filter(
						(element) =>
							!query ||
							[
								element.name,
								element.testID,
								element.accessibilityLabel,
								element.accessibilityRole,
								element.route,
							]
								.filter(Boolean)
								.join(' ')
								.toLowerCase()
								.includes(query)
					)
					.slice(0, command.limit);
				return {
					screenHash: device.tools.componentSummary.screenHash,
					truncated:
						device.tools.componentSummary.truncated ||
						elements.length < device.tools.components.length,
					elements,
				};
			}
			case 'act': {
				const device = connectedDeviceForTarget(
					broker.getState(),
					command.target
				);
				return await dispatchConnectedAction(
					broker,
					device,
					context.requestId,
					command.action
				);
			}
			case 'wait': {
				if (command.condition.kind === 'job') {
					const jobId = command.condition.jobId;
					if (isSupabaseJobId(jobId)) {
						if (!supabase) supabaseUnavailable();
						let job: SupabaseJob | undefined;
						try {
							// Resolves at the timeout with the job still running.
							job = await supabase.waitForJob(
								jobId,
								command.timeoutMs,
								context.signal
							);
						} catch (error) {
							throw supabaseAgentFailure(error, context.signal);
						}
						return followedSupabaseJob(job, jobId);
					}
					const simulatorJob = simulator
						.getState()
						.jobs.find((job) => job.id === jobId);
					if (simulatorJob) {
						return await waitForJob(simulator, jobId, context.signal, {
							abortError,
						});
					}
					const slimmingJob = slimming
						.getState()
						.jobs.find((job) => job.id === jobId);
					if (slimmingJob) {
						return await waitForJob(slimming, jobId, context.signal, {
							abortError,
						});
					}
					throw new AgentCliError({
						code: 'target_not_found',
						message: 'The requested job was not found.',
						retryable: true,
					});
				}
				if (!command.target)
					required('This wait condition requires an exact target.');
				const device = connectedDeviceForTarget(
					broker.getState(),
					command.target
				);
				if (command.condition.kind === 'network-idle') {
					return await waitForNetworkIdle(
						broker,
						device,
						command.condition.quietMs,
						context.signal
					);
				}
				const action: ConnectedWaitAction =
					command.condition.kind === 'element'
						? {
								tool: 'components',
								command: 'waitForElement',
								payload: {
									id: command.condition.elementId,
									timeoutMs: command.timeoutMs,
								},
							}
						: {
								tool: 'components',
								command: 'waitForScreenChange',
								payload: {
									screenHash: command.condition.screenHash,
									timeoutMs: command.timeoutMs,
								},
							};
				return await dispatchConnectedWait(
					broker,
					device,
					context.requestId,
					action,
					command.timeoutMs,
					context.signal
				);
			}
			case 'capture': {
				const state = await simulator.refresh();
				const target = simulatorByUdid(state, command.udid);
				const job = ensureComplete(
					(await runSimulatorAction(
						simulator,
						{
							actionId: actionId(context.requestId),
							kind: 'capture.screenshot',
							udid: target.udid,
							format: command.format,
							mask: 'alpha',
							...(command.name ? { name: command.name } : {}),
						},
						context.signal
					)) as SimulatorJob
				);
				const capture = captureForJob(simulator.getState(), job);
				// The CLI is a verified local peer reading the operator's own files, so the
				// path lets it (and the MCP server built on it) return the image itself.
				const path = simulator.verifiedCapturePath
					? await simulator.verifiedCapturePath(capture.id)
					: undefined;
				return { job, capture, ...(path ? { path } : {}) };
			}
			case 'record': {
				if (command.operation === 'start') {
					const state = await simulator.refresh();
					const target = simulatorByUdid(state, command.udid);
					const receipt = (await runSimulatorAction(
						simulator,
						{
							actionId: actionId(context.requestId),
							kind: 'capture.video',
							udid: target.udid,
							codec: command.codec,
							mask: 'black',
							...(command.name ? { name: command.name } : {}),
						},
						context.signal,
						false
					)) as SimulatorActionReceipt;
					if (context.agent && receipt.jobId) {
						recordings.add(receipt.jobId, context.agent);
					}
					return receipt;
				}
				const target = simulatorByUdid(await simulator.refresh(), command.udid);
				const isActiveRecording = (candidate: SimulatorJob) =>
					candidate.kind === 'capture.video' &&
					candidate.deviceUdid === target.udid &&
					!TERMINAL_JOB_STATUSES.has(candidate.status);
				const jobs = simulator.getState().jobs;
				// Without a jobId the caller's own recording goes first, so a stop
				// never reaches for someone else's while the caller has one going.
				const job = command.jobId
					? jobs.find(
							(candidate) =>
								candidate.id === command.jobId && isActiveRecording(candidate)
						)
					: (jobs.find(
							(candidate) =>
								isActiveRecording(candidate) &&
								recordings.startedBy(candidate.id, context.agent)
						) ?? jobs.find(isActiveRecording));
				if (!job)
					required('No active recording matches this target and jobId.');
				// A session may always stop a recording it started. Anyone else's
				// recording on a held device is for the holder to stop.
				if (!recordings.startedBy(job.id, context.agent)) {
					assertDeviceAccess(agents, target.udid, context.agent);
				}
				if (!simulator.cancelJob(job.id))
					required('The recording is no longer active.');
				const finished = await waitForJob(simulator, job.id, context.signal, {
					abortError,
				});
				return {
					job: finished,
					...(finished.captureId
						? { capture: captureForJob(simulator.getState(), finished) }
						: {}),
				};
			}
			case 'network': {
				const device = connectedDeviceForTarget(
					broker.getState(),
					command.target
				);
				if (command.operation === 'status') {
					return (
						device.tools.networkProfile ?? {
							id: 'none',
							name: 'No profile',
							active: false,
							scope: 'instrumented-fetch',
						}
					);
				}
				return await dispatchConnectedAction(
					broker,
					device,
					context.requestId,
					command.operation === 'clear'
						? { tool: 'network', command: 'clearProfile', payload: {} }
						: {
								tool: 'network',
								command: 'setProfile',
								payload: { profileId: command.profileId },
							}
				);
			}
			case 'jobs': {
				const jobs = [
					...simulator
						.getState()
						.jobs.map((job) => ({ source: 'simulator', ...job })),
					...slimming
						.getState()
						.jobs.map((job) => ({ source: 'slimming', ...job })),
					...(supabase?.getState().jobs ?? []).map((job) => ({
						source: 'supabase',
						...job,
					})),
				];
				if (command.operation === 'list') return jobs;
				if (!command.jobId) required('jobs get and cancel require jobId.');
				if (isSupabaseJobId(command.jobId)) {
					if (!supabase) supabaseUnavailable();
					const job = followedSupabaseJob(
						supabase.job(command.jobId),
						command.jobId
					);
					if (command.operation === 'get') {
						return { source: 'supabase', ...job };
					}
					// A start or reset stops safely only from the desktop.
					return {
						cancelled: false,
						next: 'Agents cannot cancel local Supabase jobs. Wait for it with wait --condition job, or ask the user to cancel it in RN Devtools › Supabase.',
					};
				}
				const job = jobs.find((candidate) => candidate.id === command.jobId);
				if (!job) unavailable('The requested job was not found.');
				if (command.operation === 'get') return job;
				// A session may always cancel a recording it started. Cancelling
				// any other boot, recording, or slim on a held device breaks the
				// holder's work as surely as driving it would.
				if (!recordings.startedBy(command.jobId, context.agent)) {
					for (const udid of jobSimulators(
						simulator.getState(),
						slimming.getState(),
						command.jobId
					)) {
						assertDeviceAccess(agents, udid, context.agent);
					}
				}
				return {
					cancelled:
						simulator.cancelJob(command.jobId) ||
						slimming.cancelJob(command.jobId),
				};
			}
			case 'slimming': {
				if (command.operation === 'status') return await slimming.refresh();
				if (!command.udids?.length) {
					required(
						'Slimming preview, doctor, verify, apply, undo, and restore require one or more udids.'
					);
				}
				const simulatorInventory = await simulator.refresh();
				const canonicalUdids = command.udids.map(
					(udid) => simulatorByUdid(simulatorInventory, udid).udid
				);
				const action: SlimmingAction = slimmingActionFor(
					command,
					canonicalUdids,
					actionId(context.requestId),
					context.agent
				);
				if (MUTATING_SLIMMING_OPERATIONS.has(command.operation)) {
					// Ownership is also checked inside the slimming service; doing it
					// here first gives the agent the typed device_held error with its
					// recovery text instead of a generic action_rejected.
					for (const udid of canonicalUdids) {
						assertDeviceAccess(agents, udid, context.agent);
					}
				}
				const job = ensureComplete(
					await runSlimmingAction(slimming, action, context.signal)
				);
				const state = slimming.getState();
				return {
					job,
					statusBySimulator: Object.fromEntries(
						canonicalUdids.map((udid) => [udid, state.statusBySimulator[udid]])
					),
					previewBySimulator: Object.fromEntries(
						canonicalUdids.map((udid) => [udid, state.previewBySimulator[udid]])
					),
					doctorBySimulator: Object.fromEntries(
						canonicalUdids.map((udid) => [udid, state.doctorBySimulator[udid]])
					),
				};
			}
			case 'recipe': {
				if (!recipes) {
					unavailable(
						'The local recipe provider is not installed.',
						'Create or import a recipe in the Automation workspace first.'
					);
				}
				switch (command.operation) {
					case 'list':
						return await recipes.list();
					case 'get':
						return await recipes.get(
							command.recipeId ?? required('recipe get requires recipeId.')
						);
					case 'run': {
						const recipeUdids =
							command.udids ??
							required('recipe run requires one or more udids.');
						const recipeInventory = await simulator.refresh();
						const recipeId =
							command.recipeId ?? required('recipe run requires recipeId.');
						const targetUdids = recipeUdids.map(
							(udid) => simulatorByUdid(recipeInventory, udid).udid
						);
						// A recipe can shut down, boot, relaunch, and reconfigure every
						// target, so each must be free or the caller's.
						for (const udid of targetUdids) {
							assertDeviceAccess(agents, udid, context.agent);
						}
						return await recipes.run(recipeId, targetUdids);
					}
					case 'cancel':
						return await recipes.cancel(
							command.runId ?? required('recipe cancel requires runId.')
						);
					case 'status':
						return await recipes.status(command.runId);
					default:
						return required('Unsupported recipe operation.');
				}
			}
			case 'lane': {
				if (!lanes) {
					unavailable(
						'Lanes are not available in this desktop session.',
						'Update RN Devtools and retry.'
					);
				}
				const operationId = actionId(context.requestId);
				// The CLI fills `agent` from the session variables. Over MCP, Codex
				// passes none, and the envelope's synthetic `mcp-*` id is all there
				// is; without it the lane would belong to the operator and refuse
				// the very session that started it.
				const laneAgent = command.agent ?? context.agent;
				switch (command.operation) {
					case 'ls': {
						const state = await lanes.refresh();
						return {
							environments: state.environments,
							lanes: state.lanes,
							worktrees: state.worktrees,
							deviceRequests: state.deviceRequests,
							...(state.error ? { error: state.error } : {}),
						};
					}
					case 'up': {
						const worktreePath =
							command.worktreePath ??
							required('lane up requires worktreePath.');
						// A device another agent holds is refused before anything boots:
						// the named one or, without a udid, the device of the app's
						// existing lane, which the lane service resumes. With neither,
						// the lane service picks a free device itself. It checks the
						// resumed lane again in turn, for a lane that a start queued
						// ahead of this one creates.
						const appDirectory = posix.resolve(worktreePath);
						const udid =
							command.udid ??
							lanes
								.getState()
								.lanes.find((lane) => laneAppDirectory(lane) === appDirectory)
								?.simulatorUdid;
						if (udid) assertDeviceAccess(agents, udid, laneAgent);
						const receipt = await lanes.runOperation(
							{
								actionId: operationId,
								kind: 'lane.start',
								worktreePath,
								...(command.udid ? { simulatorUdid: command.udid } : {}),
								environment: command.environment ?? 'development',
								launch: command.launch ?? true,
								...(command.preferredPort !== undefined
									? { preferredPort: command.preferredPort }
									: {}),
								...(command.slimProfileId
									? { slimProfileId: command.slimProfileId }
									: {}),
								...(command.backend ? { backend: command.backend } : {}),
								...(laneAgent ? { agent: laneAgent } : {}),
							},
							context.signal
						);
						if (receipt.completed && receipt.deviceRequest) {
							return {
								...laneReceiptResult(receipt),
								next: `No free Simulator: ${receipt.deviceRequest.message} RN Devtools is asking the user to start this lane on an existing Simulator or a new clone. Poll lane --operation ls; the deviceRequests entry with id ${receipt.deviceRequest.id} reports fulfilled with a laneId, or dismissed.`,
							};
						}
						return laneUpResult(receipt);
					}
					case 'launch': {
						const lane = laneForTarget(lanes.getState(), command);
						// Launching drives the lane's device, so only its holder may.
						assertDeviceAccess(agents, lane.simulatorUdid, laneAgent);
						const receipt = await lanes.runOperation(
							{
								actionId: operationId,
								kind: 'lane.launch',
								laneId: lane.id,
								...(command.url ? { url: command.url } : {}),
								...(laneAgent ? { agent: laneAgent } : {}),
							},
							context.signal
						);
						return laneReceiptResult(receipt);
					}
					case 'down': {
						const lane = laneForTarget(lanes.getState(), command);
						assertDeviceAccess(agents, lane.simulatorUdid, context.agent);
						const receipt = await lanes.runOperation(
							{ actionId: operationId, kind: 'lane.stop', laneId: lane.id },
							context.signal
						);
						return { ...laneReceiptResult(receipt), laneId: lane.id };
					}
					case 'log': {
						const lane = laneForTarget(lanes.getState(), command);
						const receipt = await lanes.runOperation(
							{
								actionId: operationId,
								kind: 'lane.log',
								laneId: lane.id,
								maxCharacters: command.maxCharacters ?? 16 * 1024,
							},
							context.signal
						);
						return laneReceiptResult(receipt);
					}
				}
			}
		}
	};
}

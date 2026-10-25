import { z } from 'zod';
import { deviceHoldSchema, isPathInside } from './device-hold';
import { UDID_PATTERN } from './simulator-protocol';

/**
 * Agents: which coding-agent session is driving which Simulator.
 *
 * Three signals, strongest first:
 * - a **claim** the session made on purpose (`rndevtools claim`), kept until
 *   released or until the session is no longer live;
 * - a **touch**: any device-targeted CLI command that carried the session id,
 *   expiring after 30 minutes of silence;
 * - a **lane** whose checkout the session works in. The checkout root counts:
 *   in a monorepo the lane's app is a subdirectory of it.
 *
 * Live sessions are discovered from the agents' own local state, so nothing
 * has to be installed into Claude Code or Codex. A claim is also a hold (see
 * `device-hold.ts`): until it is released, or abandoned past its grace
 * period, the desktop refuses other agents' claims and mutations on the
 * device.
 */

const MAX_TEXT = 4 * 1024;
const MAX_SESSIONS = 200;
const MAX_DEVICES = 200;
/** Agents listed per Simulator; the weakest attachments beyond it are left out. */
const MAX_AGENTS_PER_DEVICE = 32;

export const AGENT_TOUCH_TTL_MS = 30 * 60 * 1_000;
/** Codex threads share one app-server process; recency is their liveness. */
export const CODEX_ACTIVE_WINDOW_MS = 30 * 60 * 1_000;

const identifierSchema = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const timestampSchema = z.number().finite().nonnegative();
const udidSchema = z.string().regex(UDID_PATTERN);
const pathSchema = z.string().min(1).max(1_024);

const agentKindSchema = z.enum(['claude', 'codex', 'other']);
export type AgentKind = z.infer<typeof agentKindSchema>;

export const agentSessionSchema = z.strictObject({
	kind: agentKindSchema,
	sessionId: identifierSchema,
	/** The agent's own name for the session, else the working directory name. */
	title: z.string().max(MAX_TEXT),
	cwd: pathSchema.optional(),
	status: z.string().max(256).optional(),
	pid: z.number().int().positive().optional(),
	startedAt: timestampSchema.optional(),
	updatedAt: timestampSchema.optional(),
});
export type AgentSession = z.infer<typeof agentSessionSchema>;

const agentAttachmentViaSchema = z.enum(['claim', 'touch', 'lane']);

const deviceAgentSchema = agentSessionSchema.extend({
	via: agentAttachmentViaSchema,
	lastSeenAt: timestampSchema,
	note: z.string().max(MAX_TEXT).optional(),
	/** Set when the session was not found live; the attachment is stale. */
	live: z.boolean(),
});
export type DeviceAgent = z.infer<typeof deviceAgentSchema>;

export const agentClaimSchema = z.strictObject({
	simulatorUdid: udidSchema,
	kind: agentKindSchema,
	sessionId: identifierSchema,
	note: z.string().max(MAX_TEXT).optional(),
	claimedAt: timestampSchema,
});
export type AgentClaim = z.infer<typeof agentClaimSchema>;

const agentTouchSchema = z.strictObject({
	simulatorUdid: udidSchema,
	kind: agentKindSchema,
	sessionId: identifierSchema,
	lastSeenAt: timestampSchema,
});
export type AgentTouch = z.infer<typeof agentTouchSchema>;

export const agentStateSchema = z.strictObject({
	revision: z.number().int().nonnegative(),
	updatedAt: timestampSchema,
	sessions: z.array(agentSessionSchema).max(MAX_SESSIONS),
	/** Attached agents per Simulator, strongest signal first. */
	byDevice: z.record(
		udidSchema,
		z.array(deviceAgentSchema).max(MAX_AGENTS_PER_DEVICE)
	),
	claims: z.array(agentClaimSchema).max(MAX_DEVICES),
	/**
	 * The hold on every held Simulator: who has it, through a lane or a claim,
	 * whether that holder is still alive, and when an abandoned hold releases.
	 * Keyed by canonical UDID.
	 */
	holds: z.record(udidSchema, deviceHoldSchema).default({}),
	discovery: z.strictObject({
		claude: z.enum(['ok', 'unavailable']),
		codex: z.enum(['ok', 'unavailable']),
		error: z.string().max(MAX_TEXT).optional(),
	}),
});
export type AgentState = z.infer<typeof agentStateSchema>;

export const agentOperationSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('agent.claim'),
		simulatorUdid: udidSchema,
		agent: z.strictObject({
			kind: agentKindSchema,
			sessionId: identifierSchema,
		}),
		note: z.string().max(MAX_TEXT).optional(),
	}),
	z.strictObject({
		kind: z.literal('agent.release'),
		simulatorUdid: udidSchema,
		/** When given, only this session's claim is released. */
		agent: z
			.strictObject({ kind: agentKindSchema, sessionId: identifierSchema })
			.optional(),
	}),
	z.strictObject({ kind: z.literal('agent.refresh') }),
]);
export type AgentOperation = z.infer<typeof agentOperationSchema>;

export type AgentBridge = {
	getAgentState: () => Promise<AgentState>;
	subscribeAgentState: (listener: (state: AgentState) => void) => () => void;
	runAgentOperation: (operation: AgentOperation) => Promise<AgentState>;
};

export function agentSessionKey(
	agent: Pick<AgentSession, 'kind' | 'sessionId'>
): string {
	return `${agent.kind}:${agent.sessionId}`;
}

/**
 * Attributes live sessions to Simulators from claims, touches, and lanes.
 * Pure, so the service and the renderer tests agree on the ordering: claims
 * first, then touches, then lane cwd matches, newest within each tier; a
 * session appears at most once per device, and a device lists at most
 * {@link MAX_AGENTS_PER_DEVICE} agents, the strongest.
 */
export function attributeAgents({
	sessions,
	claims,
	touches,
	lanes,
	now,
}: {
	sessions: readonly AgentSession[];
	claims: readonly AgentClaim[];
	touches: readonly AgentTouch[];
	/** Each lane's device and checkout (its worktree root). */
	lanes: readonly { simulatorUdid: string; worktreePath: string }[];
	now: number;
}): Record<string, DeviceAgent[]> {
	const live = new Map(
		sessions.map((session) => [agentSessionKey(session), session])
	);
	const byDevice = new Map<string, DeviceAgent[]>();
	const seen = new Set<string>();
	const push = (udid: string, agent: DeviceAgent) => {
		const key = `${udid.toUpperCase()}|${agentSessionKey(agent)}`;
		if (seen.has(key)) return;
		seen.add(key);
		const list = byDevice.get(udid.toUpperCase()) ?? [];
		// Pushed strongest first, so a full list already holds the ones to keep.
		if (list.length >= MAX_AGENTS_PER_DEVICE) return;
		list.push(agent);
		byDevice.set(udid.toUpperCase(), list);
	};
	const describe = (
		agent: Pick<AgentSession, 'kind' | 'sessionId'>
	): AgentSession =>
		live.get(agentSessionKey(agent)) ?? {
			kind: agent.kind,
			sessionId: agent.sessionId,
			title: `${agent.kind} ${agent.sessionId.slice(0, 8)}`,
		};

	for (const claim of [...claims].sort((a, b) => b.claimedAt - a.claimedAt)) {
		push(claim.simulatorUdid, {
			...describe(claim),
			via: 'claim',
			lastSeenAt: claim.claimedAt,
			...(claim.note ? { note: claim.note } : {}),
			live: live.has(agentSessionKey(claim)),
		});
	}
	for (const touch of [...touches]
		.filter((touch) => now - touch.lastSeenAt <= AGENT_TOUCH_TTL_MS)
		.sort((a, b) => b.lastSeenAt - a.lastSeenAt)) {
		push(touch.simulatorUdid, {
			...describe(touch),
			via: 'touch',
			lastSeenAt: touch.lastSeenAt,
			live: live.has(agentSessionKey(touch)),
		});
	}
	for (const lane of lanes) {
		for (const session of sessions) {
			// The same rule decides whether a synthetic holder is live on a lane.
			if (session.cwd && isPathInside(session.cwd, lane.worktreePath)) {
				push(lane.simulatorUdid, {
					...session,
					via: 'lane',
					lastSeenAt: session.updatedAt ?? now,
					live: true,
				});
			}
		}
	}
	return Object.fromEntries(byDevice);
}

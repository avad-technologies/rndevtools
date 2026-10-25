import { mkdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
	AGENT_TOUCH_TTL_MS,
	type AgentClaim,
	type AgentKind,
	type AgentOperation,
	type AgentSession,
	type AgentState,
	type AgentTouch,
	agentClaimSchema,
	agentOperationSchema,
	agentSessionKey,
	agentStateSchema,
	attributeAgents,
} from '../shared/agent-protocol';
import {
	type DeviceHold,
	type DeviceHolder,
	decideDeviceAccess,
	type HolderLiveness,
	type HolderLivenessInputs,
	holderClockKey,
	resolveDeviceHolds,
	resolveHolderLiveness,
} from '../shared/device-hold';
import {
	discoverAgentSessions,
	type SessionDiscoveryResult,
} from './agent-sessions';
import { writeFileAtomic } from './private-files';

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const MAX_CLAIMS = 200;
const MAX_TOUCHES = 1_000;
const EVERY_AGENT_KIND: ReadonlySet<AgentKind> = new Set([
	'claude',
	'codex',
	'other',
]);

/**
 * The agent kinds whose sessions cannot be seen right now. Their holders are
 * unknown rather than gone. Nothing discovers `other` sessions, so those are
 * never known to be gone.
 */
function unseenKinds(
	discovery: Pick<SessionDiscoveryResult, 'claude' | 'codex'>
): Set<AgentKind> {
	const kinds = new Set<AgentKind>(['other']);
	if (discovery.claude === 'unavailable') kinds.add('claude');
	if (discovery.codex === 'unavailable') kinds.add('codex');
	return kinds;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const storedClaimsSchema = z.strictObject({
	version: z.literal(1),
	claims: z.array(agentClaimSchema).max(MAX_CLAIMS),
});

/**
 * Claims survive a desktop restart because the agent that made one is
 * usually still running. Touches are in memory only: they expire in half an
 * hour, and after a restart every live session will touch again soon enough.
 */
class AgentClaimStore {
	readonly #file: string;
	#claims: AgentClaim[] = [];
	#writeQueue: Promise<void> = Promise.resolve();

	constructor(directory: string) {
		this.#file = path.join(directory, 'claims.json');
	}

	async start(): Promise<void> {
		await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
		try {
			const parsed = storedClaimsSchema.safeParse(
				JSON.parse(await readFile(this.#file, 'utf8'))
			);
			if (parsed.success) {
				this.#claims = parsed.data.claims;
			} else {
				await rename(this.#file, `${this.#file}.corrupt-${Date.now()}`).catch(
					() => undefined
				);
			}
		} catch {
			// No claims yet.
		}
	}

	claims(): readonly AgentClaim[] {
		return this.#claims;
	}

	/**
	 * Replaces the claims at once and persists them. Writes queue up, each
	 * through its own temporary file, so overlapping claims, releases, and
	 * expiries reach the disk in order and never fail each other's rename.
	 */
	async set(claims: readonly AgentClaim[]): Promise<void> {
		this.#claims = [...claims];
		const snapshot = `${JSON.stringify({ version: 1, claims: this.#claims }, null, '\t')}\n`;
		const write = this.#writeQueue.then(() =>
			writeFileAtomic(this.#file, snapshot, 'claims')
		);
		this.#writeQueue = write.catch(() => undefined);
		await write;
	}
}

export type AgentLaneSource = () => readonly {
	id: string;
	simulatorUdid: string;
	/**
	 * The lane's checkout, not the app inside it: sessions working anywhere in
	 * it are attributed to the lane and keep a synthetic owner's hold alive.
	 */
	worktreePath: string;
	agent?: { kind: 'claude' | 'codex' | 'other'; sessionId: string } | undefined;
	metro: 'starting' | 'ready' | 'stopped';
	startedAt: number;
	/**
	 * A start that has reserved its device but not stored its lane: it holds
	 * the device against newcomers and yields to an existing claim.
	 */
	starting?: boolean | undefined;
}[];

/**
 * Holders of resources other than lanes and claims, with the directory each
 * resource lives in. Their clocks run like a lane owner's.
 */
type AgentHolderSource = () => readonly {
	holder: DeviceHolder;
	directory?: string | undefined;
}[];

type AgentListener = (state: AgentState) => void;

/**
 * Discovers live sessions on a timer, keeps claims and touches, and derives
 * who is attached to which Simulator. A claim whose session is gone is kept
 * but reported `live: false` so a human can see what an agent left behind;
 * it is dropped once the session has been gone for the hold grace period.
 */
export class AgentService {
	readonly #store: AgentClaimStore;
	readonly #lanes: AgentLaneSource;
	readonly #holders: AgentHolderSource;
	readonly #discover: () => Promise<SessionDiscoveryResult>;
	readonly #now: () => number;
	readonly #pollIntervalMs: number;
	readonly #listeners = new Set<AgentListener>();
	readonly #touches = new Map<string, AgentTouch>();
	/**
	 * Abandonment clocks by `holderClockKey`: when each holder that a lane, a
	 * claim, or another resource names was first noticed missing. In memory
	 * only, so a desktop restart starts them over.
	 */
	readonly #missingSince = new Map<string, number>();
	/**
	 * Clocks paused because their holder's agent kind cannot be seen right now,
	 * with how long each had run when it paused.
	 */
	readonly #pausedClocks = new Map<string, number>();
	#sessions: AgentSession[] = [];
	#discovery: AgentState['discovery'] = { claude: 'ok', codex: 'ok' };
	#revision = 0;
	#updatedAt: number;
	#timer: NodeJS.Timeout | undefined;
	#pollingActive = true;
	#refreshPromise: Promise<AgentState> | undefined;
	#stopped = false;

	constructor({
		directory,
		lanes,
		holders = () => [],
		discover = discoverAgentSessions,
		pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
		now = Date.now,
	}: {
		directory: string;
		lanes: AgentLaneSource;
		/** Holders of other resources, so their clocks run; see `holderLiveness`. */
		holders?: AgentHolderSource;
		discover?: () => Promise<SessionDiscoveryResult>;
		pollIntervalMs?: number;
		now?: () => number;
	}) {
		this.#store = new AgentClaimStore(directory);
		this.#lanes = lanes;
		this.#holders = holders;
		this.#discover = discover;
		this.#pollIntervalMs = pollIntervalMs;
		this.#now = now;
		this.#updatedAt = now();
	}

	async start(): Promise<void> {
		await this.#store.start();
		await this.refresh();
		this.#timer = setInterval(() => {
			if (this.#pollingActive) void this.refresh().catch(() => undefined);
		}, this.#pollIntervalMs);
		this.#timer.unref?.();
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		if (this.#timer) clearInterval(this.#timer);
	}

	setPollingActive(active: boolean): void {
		this.#pollingActive = active;
	}

	/**
	 * The hold on every Simulator, derived from lanes, claims, and which agent
	 * sessions are alive right now. This is the one answer to "who has this
	 * device"; the lane and slimming services both consult it.
	 */
	holds(): Map<string, DeviceHold> {
		return resolveDeviceHolds({
			lanes: this.#lanes(),
			claims: this.#store.claims(),
			...this.#livenessInputs(),
		});
	}

	/**
	 * Whether the holder of some other resource is still around, on the same
	 * clocks as device holds. List the resource's holders in the `holders`
	 * option: a holder no lane, claim, or listed resource names has no clock,
	 * and reads as gone from now on every call.
	 */
	holderLiveness(holder: DeviceHolder, directory?: string): HolderLiveness {
		return resolveHolderLiveness(holder, this.#livenessInputs(), directory);
	}

	/** Whether `requester` (an agent, or the operator when undefined) may touch the device. */
	access(simulatorUdid: string, requester: DeviceHolder | undefined) {
		const hold = this.holds().get(simulatorUdid.toUpperCase());
		const lane = hold?.laneId
			? this.#lanes().find((candidate) => candidate.id === hold.laneId)
			: undefined;
		const session = requester
			? this.#sessions.find(
					(candidate) =>
						agentSessionKey(candidate) === agentSessionKey(requester)
				)
			: undefined;
		return decideDeviceAccess(hold, requester, this.#now(), {
			directory: lane?.worktreePath,
			requesterCwd: session?.cwd,
		});
	}

	subscribe(listener: AgentListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	getState = (): AgentState => {
		const now = this.#now();
		const byDevice = attributeAgents({
			sessions: this.#sessions,
			claims: this.#store.claims(),
			touches: [...this.#touches.values()],
			lanes: this.#lanes(),
			now,
		});
		return agentStateSchema.parse({
			revision: this.#revision,
			updatedAt: this.#updatedAt,
			sessions: this.#sessions,
			byDevice,
			claims: this.#store.claims(),
			holds: Object.fromEntries(this.holds()),
			discovery: this.#discovery,
		});
	};

	refresh(): Promise<AgentState> {
		if (!this.#refreshPromise) {
			this.#refreshPromise = this.#refreshInternal().finally(() => {
				this.#refreshPromise = undefined;
			});
		}
		return this.#refreshPromise;
	}

	/**
	 * Records that a session just drove a Simulator. Called by the CLI router
	 * for every device-targeted command that carried an agent id.
	 */
	touch(
		agent: Pick<AgentSession, 'kind' | 'sessionId'>,
		simulatorUdid: string
	): void {
		const udid = simulatorUdid.toUpperCase();
		const key = `${udid}|${agentSessionKey(agent)}`;
		this.#touches.set(key, {
			simulatorUdid: udid,
			kind: agent.kind,
			sessionId: agent.sessionId,
			lastSeenAt: this.#now(),
		});
		if (this.#touches.size > MAX_TOUCHES) {
			const oldest = [...this.#touches.entries()].sort(
				(a, b) => a[1].lastSeenAt - b[1].lastSeenAt
			)[0];
			if (oldest) this.#touches.delete(oldest[0]);
		}
		this.#touch();
	}

	async runOperation(value: AgentOperation): Promise<AgentState> {
		const operation = agentOperationSchema.parse(value);
		if (this.#stopped) throw new Error('Agents are shutting down.');
		switch (operation.kind) {
			case 'agent.claim': {
				const udid = operation.simulatorUdid.toUpperCase();
				const claim: AgentClaim = {
					simulatorUdid: udid,
					kind: operation.agent.kind,
					sessionId: operation.agent.sessionId,
					...(operation.note ? { note: operation.note } : {}),
					claimedAt: this.#now(),
				};
				const claims = this.#store.claims();
				const existing = claims.findIndex(
					(candidate) =>
						candidate.simulatorUdid === udid &&
						agentSessionKey(candidate) === agentSessionKey(operation.agent)
				);
				if (existing === -1 && claims.length >= MAX_CLAIMS) {
					throw new Error(`The ${MAX_CLAIMS}-claim limit is reached.`);
				}
				// A re-claim (to change the note, say) replaces the claim where it
				// stands: a device's first claim is its hold, and refreshing that
				// claim must not hand the device to a later claimant.
				await this.#store.set(
					existing === -1
						? [...claims, claim]
						: claims.map((candidate, index) =>
								index === existing ? claim : candidate
							)
				);
				this.touch(operation.agent, udid);
				return this.getState();
			}
			case 'agent.release': {
				const udid = operation.simulatorUdid.toUpperCase();
				const agent = operation.agent;
				const remaining = this.#store
					.claims()
					.filter(
						(claim) =>
							claim.simulatorUdid !== udid ||
							(agent !== undefined &&
								agentSessionKey(claim) !== agentSessionKey(agent))
					);
				if (remaining.length === this.#store.claims().length) {
					throw new Error(
						agent
							? `${agent.kind} ${agent.sessionId} holds no claim on ${udid}.`
							: `No claim exists on ${udid}.`
					);
				}
				await this.#store.set(remaining);
				this.#touch();
				return this.getState();
			}
			case 'agent.refresh':
				return this.refresh();
		}
	}

	async #refreshInternal(): Promise<AgentState> {
		let result: SessionDiscoveryResult;
		try {
			result = await this.#discover();
		} catch (error) {
			this.#discovery = { ...this.#discovery, error: errorText(error) };
			// Nothing was seen, so nobody is known to be gone.
			this.#runHolderClocks(EVERY_AGENT_KIND);
			this.#touch();
			return this.getState();
		}
		try {
			this.#sessions = result.sessions.slice(0, 200);
			this.#discovery = {
				claude: result.claude,
				codex: result.codex,
				...(result.error ? { error: result.error } : {}),
			};
			this.#runHolderClocks(unseenKinds(result));
			await this.#expireAbandonedClaims();
			this.#pruneTouches();
		} catch (error) {
			this.#discovery = { ...this.#discovery, error: errorText(error) };
		}
		this.#touch();
		return this.getState();
	}

	#livenessInputs(now = this.#now()): HolderLivenessInputs {
		let clocks: ReadonlyMap<string, number> = this.#missingSince;
		if (this.#pausedClocks.size > 0) {
			// A paused clock reads as having run exactly as long as it had when it
			// paused, so its release never comes closer while it is paused.
			const effective = new Map(this.#missingSince);
			for (const [key, elapsed] of this.#pausedClocks) {
				effective.set(key, now - elapsed);
			}
			clocks = effective;
		}
		return {
			liveSessionKeys: new Set(this.#sessions.map(agentSessionKey)),
			liveSessions: this.#sessions,
			missingSince: clocks,
			now,
		};
	}

	/** Every holder a lane, a claim, or another resource names. */
	#namedHolders(): { holder: DeviceHolder; directory?: string | undefined }[] {
		return [
			...this.#lanes().flatMap((lane) =>
				lane.agent
					? [
							{
								holder: {
									kind: lane.agent.kind,
									sessionId: lane.agent.sessionId,
								},
								directory: lane.worktreePath,
							},
						]
					: []
			),
			...this.#store.claims().map((claim) => ({
				holder: { kind: claim.kind, sessionId: claim.sessionId },
			})),
			...this.#holders(),
		];
	}

	/**
	 * Runs one abandonment clock per named holder. A clock starts when its
	 * holder goes missing and is dropped when the holder is live again or
	 * nothing names it any more. While a kind's sessions cannot be seen
	 * (`unseen`), its holders are unknown rather than gone: their running
	 * clocks pause, none start, and paused ones resume where they stopped once
	 * the kind can be seen again.
	 */
	#runHolderClocks(unseen: ReadonlySet<AgentKind>): void {
		const now = this.#now();
		const inputs = this.#livenessInputs(now);
		const named = new Set<string>();
		for (const { holder, directory } of this.#namedHolders()) {
			const key = holderClockKey(holder, directory);
			if (named.has(key)) continue;
			named.add(key);
			if (resolveHolderLiveness(holder, inputs, directory).live) {
				this.#missingSince.delete(key);
				this.#pausedClocks.delete(key);
				continue;
			}
			const since = this.#missingSince.get(key);
			if (unseen.has(holder.kind)) {
				if (since !== undefined) {
					this.#pausedClocks.set(key, now - since);
					this.#missingSince.delete(key);
				}
				continue;
			}
			const elapsed = this.#pausedClocks.get(key);
			if (elapsed !== undefined) {
				this.#missingSince.set(key, now - elapsed);
				this.#pausedClocks.delete(key);
			} else if (since === undefined) {
				this.#missingSince.set(key, now);
			}
		}
		for (const clocks of [this.#missingSince, this.#pausedClocks]) {
			for (const key of clocks.keys()) {
				if (!named.has(key)) clocks.delete(key);
			}
		}
	}

	/** Drops claims whose holder has been gone for the hold grace period. */
	async #expireAbandonedClaims(): Promise<void> {
		const inputs = this.#livenessInputs();
		const claims = this.#store.claims();
		const kept: AgentClaim[] = claims.filter((claim) => {
			const liveness = resolveHolderLiveness(
				{ kind: claim.kind, sessionId: claim.sessionId },
				inputs
			);
			// A claim is a hold; it expires on the same clock as every other hold
			// so a device never stays claimed after its lane would have released.
			return liveness.live || inputs.now < liveness.releaseAt;
		});
		if (kept.length !== claims.length) await this.#store.set(kept);
	}

	#pruneTouches(): void {
		const now = this.#now();
		for (const [key, touch] of this.#touches) {
			if (now - touch.lastSeenAt > AGENT_TOUCH_TTL_MS)
				this.#touches.delete(key);
		}
	}

	#touch(): void {
		this.#revision += 1;
		this.#updatedAt = this.#now();
		const state = this.getState();
		for (const listener of this.#listeners) {
			try {
				listener(state);
			} catch {
				// One failing subscriber must not starve the others.
			}
		}
	}
}

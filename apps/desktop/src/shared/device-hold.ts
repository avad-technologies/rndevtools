import { z } from 'zod';
import type { Lane } from './lane-protocol';

/**
 * Who may touch a Simulator.
 *
 * A device is **free** or **held**. It is held while a lane runs on it or an
 * agent has claimed it, and only the holder may claim it, start, launch or
 * stop a lane on it, send it input, install on it, slim it, run a recipe on
 * it, cancel its jobs, or stop its recordings. A session may always stop or
 * cancel a recording it started, even on a device another session holds. The
 * ungated operations are act, network set and clear, record start, recipe
 * cancel, and the reads, so a hold does not keep other sessions out of the
 * app itself. Metro status and agent attribution are details shown on a held
 * device, not states of their own: a lane whose Metro died still holds it. A
 * hold whose holder has gone away (its agent session exited) is **abandoned**
 * and still enforced until its releaseAt, {@link DEVICE_HOLD_GRACE_MS} after
 * the holder was first missed, when the desktop releases it so the device
 * returns to the pool without anyone's cooperation.
 *
 * A lane start holds its Simulator from the moment it reserves it, before
 * its lane is stored, but yields to a claim that was there first.
 *
 * Both the lane service and the slimming service ask this one resolver, so a
 * device cannot be rebooted by a slim while another agent's lane is on it.
 */

/** How long an abandoned hold survives before the desktop releases it. */
export const DEVICE_HOLD_GRACE_MS = 10 * 60 * 1_000;

/**
 * The CLI's MCP server makes up `mcp-<client name>` when the agent gave it no
 * session variable, as Codex does. Every MCP session of that agent then shares
 * the one id, so such a synthetic holder is matched by where its sessions
 * work, never by the id alone. Detected by prefix, so nothing new is stored.
 */
const SYNTHETIC_SESSION_PREFIX = 'mcp-';

const deviceHolderSchema = z.strictObject({
	kind: z.enum(['claude', 'codex', 'other']),
	sessionId: z.string().min(1).max(128),
});
export type DeviceHolder = z.infer<typeof deviceHolderSchema>;

export const deviceHoldSchema = z.strictObject({
	simulatorUdid: z.string(),
	/** What establishes the hold. A lane wins over a bare claim. */
	via: z.enum(['lane', 'claim']),
	laneId: z.string().optional(),
	/**
	 * The agent session that owns the hold. Absent for a lane a person started
	 * from the desktop, which belongs to the operator.
	 */
	holder: deviceHolderSchema.optional(),
	/** Whether the holder is still alive: its session is running, or it is the operator. */
	holderLive: z.boolean(),
	/** When the holder was last known alive, once it is not. */
	abandonedSince: z.number().int().nonnegative().optional(),
	/** When the desktop will release an abandoned hold, once it is abandoned. */
	releaseAt: z.number().int().nonnegative().optional(),
});
export type DeviceHold = z.infer<typeof deviceHoldSchema>;

/** `kind:sessionId`, the identity of one agent session (the same key the agent service uses). */
function holderKey(holder: DeviceHolder): string {
	return `${holder.kind}:${holder.sessionId}`;
}

/** Whether `holder` is a shared MCP identity rather than one session. */
export function isSyntheticHolder(
	holder: Pick<DeviceHolder, 'sessionId'>
): boolean {
	return holder.sessionId.startsWith(SYNTHETIC_SESSION_PREFIX);
}

/** Whether `child` is `parent` or lies inside it; trailing slashes are ignored. */
export function isPathInside(child: string, parent: string): boolean {
	const inner = child.replace(/\/+$/, '');
	const outer = parent.replace(/\/+$/, '');
	return inner === outer || inner.startsWith(`${outer}/`);
}

/**
 * The abandonment clock a holder runs on. One session's holds share a clock.
 * A synthetic holder gets one per resource directory, because its id stands
 * for several sessions and only some of its resources may still have one of
 * them working inside.
 */
export function holderClockKey(
	holder: DeviceHolder,
	directory?: string
): string {
	const key = holderKey(holder);
	return directory !== undefined && isSyntheticHolder(holder)
		? `${key}@${directory.replace(/\/+$/, '')}`
		: key;
}

export type HolderLivenessInputs = {
	/** `holderKey` of every agent session currently alive on this Mac. */
	liveSessionKeys: ReadonlySet<string>;
	/** Where the live sessions work; this is what decides synthetic holders. */
	liveSessions?: readonly {
		kind: DeviceHolder['kind'];
		cwd?: string | undefined;
	}[];
	/**
	 * When each absent holder was first noticed missing, by
	 * {@link holderClockKey}. A holder without a clock counts as missing from
	 * `now`, so its release never comes closer until a clock starts.
	 */
	missingSince: ReadonlyMap<string, number>;
	now: number;
};

export type HolderLiveness =
	| { live: true }
	| { live: false; abandonedSince: number; releaseAt: number };

/**
 * Whether the holder of a resource (a Simulator here, any held resource in
 * general) is still around and, when it is not, since when and until when the
 * hold survives. The operator (no holder) is always live. A synthetic holder
 * is live while a session of its kind works inside `directory`, the held
 * resource's directory; without a directory it never is.
 */
export function resolveHolderLiveness(
	holder: DeviceHolder | undefined,
	inputs: HolderLivenessInputs,
	directory?: string
): HolderLiveness {
	if (!holder || inputs.liveSessionKeys.has(holderKey(holder))) {
		return { live: true };
	}
	if (
		directory !== undefined &&
		isSyntheticHolder(holder) &&
		inputs.liveSessions?.some(
			(session) =>
				session.kind === holder.kind &&
				session.cwd !== undefined &&
				isPathInside(session.cwd, directory)
		)
	) {
		return { live: true };
	}
	const since =
		inputs.missingSince.get(holderClockKey(holder, directory)) ?? inputs.now;
	return {
		live: false,
		abandonedSince: since,
		releaseAt: since + DEVICE_HOLD_GRACE_MS,
	};
}

export type DeviceHoldInputs = HolderLivenessInputs & {
	lanes: readonly (Pick<
		Lane,
		'id' | 'simulatorUdid' | 'metro' | 'startedAt'
	> & {
		agent?: DeviceHolder | undefined;
		/**
		 * The lane's checkout, which synthetic holders are judged against. Not
		 * the app directory inside it: in a monorepo the agent's session works
		 * from the checkout root, above the app.
		 */
		worktreePath?: string | undefined;
		/**
		 * A start that has reserved the device but not stored its lane yet. It
		 * holds the device against anyone who comes later, but never takes it
		 * from a claim that is already there: the start checks again before it
		 * stores its lane, and fails instead.
		 */
		starting?: boolean | undefined;
	})[];
	/** Agent claims: a device, and the session that claimed it. */
	claims: readonly {
		simulatorUdid: string;
		kind: DeviceHolder['kind'];
		sessionId: string;
	}[];
};

/**
 * Derives the hold on every Simulator from lanes and claims. Pure, so the lane
 * service, the slimming service, the agent command router, and the renderer
 * all compute the same answer from the same inputs.
 */
export function resolveDeviceHolds(
	inputs: DeviceHoldInputs
): Map<string, DeviceHold> {
	const holds = new Map<string, DeviceHold>();
	const laneHold = (lane: DeviceHoldInputs['lanes'][number]): DeviceHold => {
		const holder = lane.agent
			? { kind: lane.agent.kind, sessionId: lane.agent.sessionId }
			: undefined;
		return finish(
			inputs,
			{
				simulatorUdid: lane.simulatorUdid.toUpperCase(),
				via: 'lane',
				laneId: lane.id,
				holder,
			},
			lane.worktreePath
		);
	};
	for (const lane of inputs.lanes) {
		if (!lane.starting) {
			holds.set(lane.simulatorUdid.toUpperCase(), laneHold(lane));
		}
	}
	for (const claim of inputs.claims) {
		const udid = claim.simulatorUdid.toUpperCase();
		if (holds.has(udid)) continue;
		holds.set(
			udid,
			finish(inputs, {
				simulatorUdid: udid,
				via: 'claim',
				holder: { kind: claim.kind, sessionId: claim.sessionId },
			})
		);
	}
	for (const lane of inputs.lanes) {
		const udid = lane.simulatorUdid.toUpperCase();
		if (lane.starting && !holds.has(udid)) holds.set(udid, laneHold(lane));
	}
	return holds;
}

function finish(
	inputs: HolderLivenessInputs,
	partial: Pick<DeviceHold, 'simulatorUdid' | 'via' | 'laneId' | 'holder'>,
	directory?: string
): DeviceHold {
	// An operator-started lane has no agent and is never abandoned by this rule;
	// the operator stops it from the panel.
	const liveness = resolveHolderLiveness(partial.holder, inputs, directory);
	if (liveness.live) {
		return { ...stripUndefined(partial), holderLive: true };
	}
	return {
		...stripUndefined(partial),
		holderLive: false,
		abandonedSince: liveness.abandonedSince,
		releaseAt: liveness.releaseAt,
	};
}

function stripUndefined<T extends object>(value: T): T {
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined)
	) as T;
}

export type DeviceAccessDecision =
	| { allowed: true }
	| { allowed: false; reason: string; hold: DeviceHold };

/**
 * Whether `requester` may mutate or drive the device. The operator (no
 * requester) may touch anything; an agent may touch a free device, a device it
 * holds, or a device whose hold is abandoned and past its grace period.
 *
 * A synthetic holder stands for every MCP session of its kind. A session of
 * that kind working inside the held lane's checkout (`scope`) is the one
 * keeping the hold alive, so it may use the device too, whether it calls over
 * MCP or the CLI.
 */
export function decideDeviceAccess(
	hold: DeviceHold | undefined,
	requester: DeviceHolder | undefined,
	now: number,
	scope?: {
		/** The held lane's checkout (its worktree root). */
		directory?: string | undefined;
		/** Where the requesting session works, when it was discovered. */
		requesterCwd?: string | undefined;
	}
): DeviceAccessDecision {
	if (!hold || !requester) return { allowed: true };
	if (hold.holder && holderKey(hold.holder) === holderKey(requester)) {
		return { allowed: true };
	}
	if (
		hold.holder &&
		isSyntheticHolder(hold.holder) &&
		!isSyntheticHolder(requester) &&
		hold.holder.kind === requester.kind &&
		scope?.directory !== undefined &&
		scope.requesterCwd !== undefined &&
		isPathInside(scope.requesterCwd, scope.directory)
	) {
		return { allowed: true };
	}
	if (
		!hold.holderLive &&
		hold.releaseAt !== undefined &&
		now >= hold.releaseAt
	) {
		return { allowed: true };
	}
	const owner = hold.holder
		? `${hold.holder.kind} session ${hold.holder.sessionId}`
		: 'the operator';
	const what =
		hold.via === 'lane' ? `lane ${hold.laneId ?? ''}`.trim() : 'a claim';
	const liveness = hold.holderLive
		? ''
		: ` (its session is gone; the hold releases ${
				hold.releaseAt
					? `in ${Math.max(0, Math.ceil((hold.releaseAt - now) / 60_000))} min`
					: 'soon'
			})`;
	return {
		allowed: false,
		hold,
		reason: `Simulator ${hold.simulatorUdid} is held by ${owner} through ${what}${liveness}. Pick a free device, or ask the user to release it.`,
	};
}

/**
 * A remaining time the way holds read it: `45 s`, `7 min`, `3 h`, `3 days`.
 * Rounds up, so a clock never reads as done before it is.
 */
export function formatHoldDuration(ms: number): string {
	const remaining = Number.isFinite(ms) ? Math.max(0, ms) : 0;
	const seconds = Math.ceil(remaining / 1_000);
	if (seconds < 60) return `${Math.max(1, seconds)} s`;
	const minutes = Math.ceil(remaining / 60_000);
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.ceil(remaining / 3_600_000);
	if (hours < 48) return `${hours} h`;
	const days = Math.ceil(remaining / 86_400_000);
	return `${days} ${days === 1 ? 'day' : 'days'}`;
}

/**
 * A stack's stop delay, the duration part only: whole seconds under two
 * minutes, else the way holds read it. Callers word a zero delay themselves.
 */
export function formatStopDelay(ms: number): string {
	return ms < 120_000 ? `${Math.round(ms / 1_000)} s` : formatHoldDuration(ms);
}

/**
 * What a hold label needs: whether the holder is alive, when an abandoned
 * hold ends, and what kind of holder it is. Device holds and Supabase stack
 * holds both fit this shape.
 */
export type HoldCountdownInput = {
	live: boolean;
	/** When an abandoned hold ends; absent while the holder is live. */
	releaseAt?: number | undefined;
	/**
	 * `operator` is the person at the desktop (a pin, a lane they started);
	 * `worktree` is a shared MCP identity matched by where its sessions work.
	 */
	holder?: 'operator' | 'lane' | 'claim' | 'session' | 'worktree' | undefined;
	/** A shared `mcp-*` identity; it reads as held by its worktree. */
	synthetic?: boolean | undefined;
};

export type HoldCountdownOptions = {
	/** What happens when the clock runs out: a device hold releases, a stack stops. */
	verb?: 'releases' | 'stops';
	/**
	 * The holder's sessions cannot be read right now, so abandonment clocks
	 * are frozen instead of running.
	 */
	clocksPaused?: boolean;
};

export type HoldCountdownLabel = {
	text: string;
	tone: 'success' | 'warning' | 'info' | 'default';
	/** Time left before the hold ends, while a clock runs. */
	remainingMs?: number;
};

/**
 * The one countdown wording for holds: `live`, `by worktree`, `operator`,
 * `clocks paused`, or `gone · stops in 7 min`. A Simulator hold and a
 * Supabase stack hold read the same, only the verb differs.
 */
export function holdCountdownLabel(
	hold: HoldCountdownInput,
	now: number,
	options: HoldCountdownOptions = {}
): HoldCountdownLabel {
	if (hold.holder === 'operator') return { text: 'operator', tone: 'default' };
	if (hold.live) {
		return hold.holder === 'worktree' || hold.synthetic === true
			? { text: 'by worktree', tone: 'success' }
			: { text: 'live', tone: 'success' };
	}
	if (options.clocksPaused === true) {
		return { text: 'clocks paused', tone: 'info' };
	}
	if (hold.releaseAt === undefined) return { text: 'gone', tone: 'warning' };
	const verb = options.verb ?? 'releases';
	const remainingMs = Math.max(0, hold.releaseAt - now);
	if (remainingMs === 0) {
		return {
			text: `gone · ${verb === 'stops' ? 'stopping' : 'releasing'} now`,
			tone: 'warning',
			remainingMs,
		};
	}
	return {
		text: `gone · ${verb} in ${formatHoldDuration(remainingMs)}`,
		tone: 'warning',
		remainingMs,
	};
}

/** The UDIDs with no hold at all, in the order given. */
export function freeDevices(
	udids: readonly string[],
	holds: ReadonlyMap<string, DeviceHold>,
	now: number
): string[] {
	return udids.filter((udid) => {
		const hold = holds.get(udid.toUpperCase());
		if (!hold) return true;
		return (
			!hold.holderLive && hold.releaseAt !== undefined && now >= hold.releaseAt
		);
	});
}

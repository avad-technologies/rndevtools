import { z } from 'zod';
import { UDID_PATTERN } from './simulator-protocol';
import {
	laneBackendSummarySchema,
	laneWorktreeSupabaseSchema,
} from './supabase-protocol';

/**
 * Lanes: one git worktree, running on one Simulator, served by one Metro on a
 * port the desktop leased for it. Lanes exist so several branches (and the
 * coding agents working on them) can run side by side without fighting over
 * port 8081 or a shared Simulator.
 *
 * The protocol is deliberately small. A lane never carries product identity:
 * the bundle identifier and URL scheme are read from the worktree's own Expo
 * config at start time and only echoed back for display.
 *
 * A lane may also get its worktree's own local backend. What main knows about
 * it travels on the wire only (`LaneView.backend`, receipts). The durable
 * lane keeps its policy and an environment hash so a restart can restore
 * backend holds without storing values or replacing a healthy Metro.
 */

const MAX_PATH_LENGTH = 1024;
const MAX_SHORT_TEXT_LENGTH = 4 * 1024;
const MAX_LANES = 64;
const MAX_WORKTREES = 128;
const MAX_ENVIRONMENTS = 16;
/** How many device requests lane state lists; main never keeps more. */
export const MAX_DEVICE_REQUESTS = 16;
const MAX_LOG_CHARACTERS = 64 * 1024;

export const LANE_METRO_HEALTH_TIMEOUT_MS = 15_000;

const identifierSchema = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const shortTextSchema = z.string().max(MAX_SHORT_TEXT_LENGTH);
const timestampSchema = z.number().finite().nonnegative();
const absolutePathSchema = z
	.string()
	.min(2)
	.max(MAX_PATH_LENGTH)
	.refine((value) => value.startsWith('/') && !value.includes('\0'), {
		message: 'Worktree paths must be absolute.',
	});
const portSchema = z.number().int().min(1_024).max(65_535);
const branchSchema = z
	.string()
	.min(1)
	.max(256)
	.regex(
		/^[^\s~^:?*[\\]+$/,
		'Branch names must not contain git-reserved characters.'
	);

export const laneIdSchema = z
	.string()
	.regex(/^lane-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);

const laneUdidSchema = z.string().regex(UDID_PATTERN);

const laneEnvironmentIdSchema = z
	.string()
	.regex(/^[a-z][a-z0-9-]{0,31}$/, 'Environment ids are lowercase slugs.');

/**
 * Names Metro's environment may carry from outside the desktop's own: an
 * environment's metroEnv, or a lane's laneEnv (see lane-metro.ts).
 */
export const METRO_ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
export const MAX_METRO_ENV_VALUE_LENGTH = 1_024;

const laneEnvironmentSchema = z
	.strictObject({
		id: laneEnvironmentIdSchema,
		/** Inclusive Metro port range this environment may lease from. */
		portRange: z.tuple([portSchema, portSchema]),
		/** Extra environment variables for Metro, selected in JavaScript only. */
		metroEnv: z
			.record(
				z.string().regex(METRO_ENV_NAME),
				z.string().max(MAX_METRO_ENV_VALUE_LENGTH)
			)
			.optional(),
	})
	.refine((value) => value.portRange[0] <= value.portRange[1], {
		message: 'Port range start must not exceed its end.',
		path: ['portRange'],
	});
export type LaneEnvironment = z.infer<typeof laneEnvironmentSchema>;

/**
 * Non-overlapping ranges per environment, so two lanes can never race for one
 * port and an agent can tell from the port alone which environment it hit.
 */
export const DEFAULT_LANE_ENVIRONMENTS: readonly LaneEnvironment[] = [
	{ id: 'development', portRange: [8_100, 8_199] },
	{ id: 'staging', portRange: [8_200, 8_299] },
	{ id: 'production', portRange: [8_300, 8_399] },
];

const laneAgentKindSchema = z.enum(['claude', 'codex', 'other']);

/**
 * Whether a lane start asks for its worktree's local backend. `auto` attaches
 * it when it can and never fails the lane over it; `required` fails the start
 * before Metro spawns when the backend cannot serve the lane; `off` leaves
 * the backend alone. A start that names none gets its environment's default.
 */
const laneBackendPolicySchema = z.enum(['auto', 'off', 'required']);
export type LaneBackendPolicy = z.infer<typeof laneBackendPolicySchema>;

export const laneAgentSchema = z.strictObject({
	kind: laneAgentKindSchema,
	sessionId: identifierSchema,
	/** Last time this agent touched the lane through the CLI. */
	lastSeenAt: timestampSchema,
});
export type LaneAgent = z.infer<typeof laneAgentSchema>;

/**
 * A URI scheme the dev client can be deep-linked through, as RFC 3986 spells
 * one, at most 64 characters. Main reads a worktree's scheme against this
 * before it starts anything, since a lane record refuses any other.
 */
export const laneSchemeSchema = z
	.string()
	.regex(/^[A-Za-z][A-Za-z0-9+.-]{0,63}$/);

const laneMetroStatusSchema = z.enum(['starting', 'ready', 'stopped']);

/**
 * Where a lane's SimSlim request stands. `applying` is transient (the profile
 * is being applied before Metro starts); the rest are terminal. The desktop
 * applies a requested profile itself, gated on the SimSlim setting, the
 * device's compatibility tuple, the helper's signed-parent check, and who
 * holds the device, not on a per-mutation dialog.
 */
const laneSlimStatusSchema = z.enum([
	'applying',
	'applied',
	'skipped',
	'failed',
]);

const laneSlimSchema = z.strictObject({
	profileId: identifierSchema,
	status: laneSlimStatusSchema,
	/** Why slimming was skipped or failed, for the operator and the agent. */
	message: shortTextSchema.optional(),
	/** The SimSlim job that applied the profile, when one ran. */
	jobId: identifierSchema.optional(),
	updatedAt: timestampSchema,
});
export type LaneSlim = z.infer<typeof laneSlimSchema>;

export const laneSchema = z.strictObject({
	id: laneIdSchema,
	/** The git checkout root this lane runs from. */
	worktreePath: absolutePathSchema,
	/**
	 * The Expo app directory inside the worktree, when it is not the root
	 * (monorepos). Metro runs here and the Expo config is read here. Absent
	 * when the app is the checkout itself.
	 */
	appPath: absolutePathSchema.optional(),
	branch: branchSchema,
	simulatorUdid: laneUdidSchema,
	environment: laneEnvironmentIdSchema,
	/** The resolved choice, including an explicit off, survives desktop restarts. */
	backendPolicy: laneBackendPolicySchema.optional(),
	/** SHA-256 of the current Metro's mapped backend environment; never values. */
	backendEnvHash: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
	port: portSchema,
	metroPid: z.number().int().positive().optional(),
	metro: laneMetroStatusSchema,
	logPath: absolutePathSchema,
	bundleIdentifier: z
		.string()
		.regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/)
		.optional(),
	scheme: laneSchemeSchema.optional(),
	startedAt: timestampSchema,
	lastLaunchedAt: timestampSchema.optional(),
	agent: laneAgentSchema.optional(),
	slim: laneSlimSchema.optional(),
});
export type Lane = z.infer<typeof laneSchema>;

/**
 * A lane as main reports it: the stored lane plus, while main knows it, its
 * local backend (names, never values). Wire-only: lanes.json validates with
 * the strict `laneSchema`, which refuses a `backend` field, and a desktop
 * restart rebuilds the summary while restoring active lanes' backend holds.
 */
const laneViewSchema = laneSchema.extend({
	backend: laneBackendSummarySchema.optional(),
});
export type LaneView = z.infer<typeof laneViewSchema>;

const laneWorktreeSchema = z.strictObject({
	path: absolutePathSchema,
	branch: branchSchema,
	repositoryRoot: absolutePathSchema,
	dirty: z.boolean(),
	laneId: laneIdSchema.optional(),
	/** Its Supabase project while local Supabase is on; never stored. */
	supabase: laneWorktreeSupabaseSchema.optional(),
});
export type LaneWorktree = z.infer<typeof laneWorktreeSchema>;

/**
 * What an agent asked for when it ran `lane up` without naming a Simulator,
 * kept once no free device could be picked. Agents cannot create Simulators,
 * so the request waits for the user: the Lanes panel offers to start the lane
 * on an existing device or on a fresh clone, or to dismiss the request. The
 * agent polls `lane ls` for this record; `fulfilled` names its lane.
 */
const laneDeviceRequestStatusSchema = z.enum([
	'pending',
	'starting',
	'fulfilled',
	'dismissed',
]);

const laneDeviceRequestSchema = z.strictObject({
	id: identifierSchema,
	status: laneDeviceRequestStatusSchema,
	requestedAt: timestampSchema,
	updatedAt: timestampSchema,
	/** Why no device was picked, or why the last attempt did not start. */
	message: shortTextSchema,
	/** The checkout and app directory the lane will run, resolved up front. */
	worktreePath: absolutePathSchema,
	appPath: absolutePathSchema.optional(),
	branch: branchSchema,
	environment: laneEnvironmentIdSchema,
	preferredPort: portSchema.optional(),
	launch: z.boolean(),
	slimProfileId: identifierSchema.optional(),
	/** The backend policy the start asked for, kept for when it runs. */
	backend: laneBackendPolicySchema.optional(),
	agent: laneAgentSchema.pick({ kind: true, sessionId: true }).optional(),
	/** The lane that satisfied the request, once it did. */
	laneId: laneIdSchema.optional(),
});
export type LaneDeviceRequest = z.infer<typeof laneDeviceRequestSchema>;

export const laneStateSchema = z.strictObject({
	revision: z.number().int().nonnegative(),
	updatedAt: timestampSchema,
	environments: z.array(laneEnvironmentSchema).min(1).max(MAX_ENVIRONMENTS),
	lanes: z.array(laneViewSchema).max(MAX_LANES),
	worktrees: z.array(laneWorktreeSchema).max(MAX_WORKTREES),
	/** Repository roots whose worktrees are listed above. */
	repositories: z.array(absolutePathSchema).max(32),
	/** Lane starts waiting on the user for a Simulator; see `laneDeviceRequestSchema`. */
	deviceRequests: z
		.array(laneDeviceRequestSchema)
		.max(MAX_DEVICE_REQUESTS)
		.default([]),
	error: shortTextSchema.optional(),
});
export type LaneState = z.infer<typeof laneStateSchema>;

const operationBase = { actionId: identifierSchema };

export const laneOperationSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		...operationBase,
		kind: z.literal('lane.start'),
		/**
		 * A checkout root, or any directory inside one: the containing worktree
		 * becomes the lane's worktree and this directory its Expo app.
		 */
		worktreePath: absolutePathSchema,
		/**
		 * The Simulator to run on. When omitted the desktop picks a free iPhone
		 * (nobody's lane, nobody's claim), booted ones first. When none is free
		 * the start is parked as a device request for the user to settle.
		 */
		simulatorUdid: laneUdidSchema.optional(),
		environment: laneEnvironmentIdSchema.default('development'),
		preferredPort: portSchema.optional(),
		/** Open the dev client against the leased Metro once it is healthy. */
		launch: z.boolean().default(true),
		/**
		 * Apply this SimSlim profile to the Simulator before Metro starts, so the
		 * dev client's first launch lands on a device whose services are already
		 * trimmed. See `laneSlimSchema` for the gates that still apply.
		 */
		slimProfileId: identifierSchema.optional(),
		/**
		 * Whether to ensure the worktree's local backend while the Simulator
		 * boots and hand Metro its public values; see `LaneBackendPolicy`.
		 * Omitted means the environment's default from the desktop's policy.
		 */
		backend: laneBackendPolicySchema.optional(),
		agent: laneAgentSchema.pick({ kind: true, sessionId: true }).optional(),
	}),
	/**
	 * Settles a device request from the Lanes panel: start the lane on an
	 * existing Simulator (`use`), on a new clone of one (`clone`), or drop the
	 * request (`dismiss`). `use` and `clone` name the device in `simulatorUdid`.
	 */
	z.strictObject({
		...operationBase,
		kind: z.literal('lane.provide-device'),
		requestId: identifierSchema,
		decision: z.enum(['use', 'clone', 'dismiss']),
		simulatorUdid: laneUdidSchema.optional(),
	}),
	z.strictObject({
		...operationBase,
		kind: z.literal('lane.launch'),
		laneId: laneIdSchema,
		/** A bare path uses the lane's scheme; a full URL passes through. */
		url: z.string().min(1).max(2_048).optional(),
		agent: laneAgentSchema.pick({ kind: true, sessionId: true }).optional(),
	}),
	z.strictObject({
		...operationBase,
		kind: z.literal('lane.stop'),
		laneId: laneIdSchema,
	}),
	z.strictObject({
		...operationBase,
		kind: z.literal('lane.log'),
		laneId: laneIdSchema,
		maxCharacters: z
			.number()
			.int()
			.min(256)
			.max(MAX_LOG_CHARACTERS)
			.default(16 * 1024),
	}),
	z.strictObject({
		...operationBase,
		kind: z.literal('lane.refresh'),
	}),
	/** Picks a repository through a native folder dialog owned by main. */
	z.strictObject({
		...operationBase,
		kind: z.literal('lane.add-repository'),
	}),
	z.strictObject({
		...operationBase,
		kind: z.literal('lane.remove-repository'),
		repositoryRoot: absolutePathSchema,
	}),
]);
export type LaneOperation = z.infer<typeof laneOperationSchema>;

export const laneOperationReceiptSchema = z.strictObject({
	actionId: identifierSchema,
	kind: z.enum([
		'lane.start',
		'lane.provide-device',
		'lane.launch',
		'lane.stop',
		'lane.log',
		'lane.refresh',
		'lane.add-repository',
		'lane.remove-repository',
	]),
	completed: z.boolean(),
	cancelled: z.boolean().optional(),
	error: shortTextSchema.optional(),
	lane: laneViewSchema.optional(),
	/**
	 * The lane's local backend after a `lane.start` or `lane.provide-device`,
	 * also when a `required` start failed over it (`completed: false`).
	 */
	backend: laneBackendSummarySchema.optional(),
	/**
	 * A `lane.start` that found no free Simulator completes without a lane and
	 * with the request now waiting on the user; `lane.provide-device` returns
	 * the settled request.
	 */
	deviceRequest: laneDeviceRequestSchema.optional(),
	log: z.string().max(MAX_LOG_CHARACTERS).optional(),
	state: laneStateSchema.optional(),
});
export type LaneOperationReceipt = z.infer<typeof laneOperationReceiptSchema>;

export type LaneBridge = {
	getLaneState: () => Promise<LaneState>;
	subscribeLaneState: (listener: (state: LaneState) => void) => () => void;
	runLaneOperation: (operation: LaneOperation) => Promise<LaneOperationReceipt>;
};

/**
 * Builds the Expo development-client launch URL for a lane. SDK 57 and earlier
 * only understand the `expo-development-client/?url=` form; SDK 58 keeps
 * accepting it, so it is the safe choice for an arbitrary worktree. The
 * automation parameters skip the onboarding sheet and the dev-menu auto-open
 * so an agent sees the app, not the launcher.
 */
export function laneDevClientLaunchUrl(
	scheme: string,
	port: number,
	host = '127.0.0.1'
): string {
	const metroUrl = `http://${host}:${port}`;
	const params = new URLSearchParams({
		url: metroUrl,
		disableOnboarding: '1',
		disableAutoLaunch: '1',
	});
	return `${scheme}://expo-development-client/?${params.toString()}`;
}

/**
 * Resolves what an agent or operator typed into a URL the Simulator can open.
 * Anything with a scheme passes through untouched; a bare path is prefixed with
 * the lane's own scheme so `lane launch --url checkout` opens `app://checkout`.
 */
export function laneDeepLink(
	lane: Pick<Lane, 'scheme'>,
	input: string
): string {
	const requested = input.trim();
	if (/^[a-z][a-z0-9+.-]*:/i.test(requested)) return requested;
	if (!lane.scheme) {
		throw new Error(
			'This lane has no URL scheme; pass a fully qualified URL instead.'
		);
	}
	return `${lane.scheme}://${requested.replace(/^\/+/, '')}`;
}

export type LaneHealth = {
	label: 'ready' | 'starting' | 'stopped';
	tone: 'success' | 'warning' | 'danger';
};

/** How a lane's slimming request reads in a row or a CLI summary. */
export function laneSlimSummary(
	slim: LaneSlim | undefined
):
	| { label: string; tone: 'success' | 'warning' | 'danger' | 'muted' }
	| undefined {
	if (!slim) return undefined;
	switch (slim.status) {
		case 'applied':
			return { label: `slim: ${slim.profileId}`, tone: 'success' };
		case 'applying':
			return { label: `slimming: ${slim.profileId}`, tone: 'warning' };
		case 'failed':
			return { label: 'slim failed', tone: 'danger' };
		default:
			return { label: 'slim skipped', tone: 'muted' };
	}
}

export function laneHealth(lane: Pick<Lane, 'metro'>): LaneHealth {
	switch (lane.metro) {
		case 'ready':
			return { label: 'ready', tone: 'success' };
		case 'starting':
			return { label: 'starting', tone: 'warning' };
		default:
			return { label: 'stopped', tone: 'danger' };
	}
}

/**
 * What a lane start has taken before its lane exists: its app directory from
 * the first moment, then its Simulator and its port as each is chosen. Main
 * keeps these in memory only, and concurrent starts check them alongside the
 * stored lanes, so two starts cannot both choose one device or one port.
 * Once a start has its Simulator it also names its lane-to-be (id, checkout,
 * agent, start time), so the agent service counts the device as held by it.
 */
export type LaneReservation = {
	appDirectory: string;
	simulatorUdid?: string;
	port?: number;
	laneId?: string;
	worktreePath?: string;
	agent?: Pick<LaneAgent, 'kind' | 'sessionId'>;
	startedAt?: number;
};

/**
 * Picks the next free port in an environment's range, skipping ports already
 * leased by a lane whose Metro is still alive. `isPortFree` is injected so the
 * bind probe stays in the main process and this stays unit-testable.
 *
 * `claim` takes the chosen port for an in-flight start, or returns false when
 * another start (or a lane stored meanwhile) holds it. It runs right after
 * the bind probe with no await in between, so two starts whose probes both
 * passed still leave with different ports.
 */
export async function allocateLanePort({
	environment,
	lanes,
	isPortFree,
	preferredPort,
	claim = () => true,
}: {
	environment: LaneEnvironment;
	lanes: readonly Pick<Lane, 'port' | 'metro'>[];
	isPortFree: (port: number) => Promise<boolean>;
	preferredPort?: number;
	claim?: (port: number) => boolean;
}): Promise<number> {
	const [start, end] = environment.portRange;
	const leased = new Set(
		lanes.filter((lane) => lane.metro !== 'stopped').map((lane) => lane.port)
	);
	if (preferredPort !== undefined) {
		if (preferredPort < start || preferredPort > end) {
			throw new Error(
				`Preferred port ${preferredPort} is outside ${environment.id}'s range ${start}-${end}.`
			);
		}
		if (
			leased.has(preferredPort) ||
			!(await isPortFree(preferredPort)) ||
			!claim(preferredPort)
		) {
			throw new Error(`Metro port ${preferredPort} is already in use.`);
		}
		return preferredPort;
	}
	for (let port = start; port <= end; port += 1) {
		if (leased.has(port)) continue;
		if ((await isPortFree(port)) && claim(port)) return port;
	}
	throw new Error(
		`No free Metro port remains in ${environment.id}'s range ${start}-${end}.`
	);
}

/** The directory a lane's Metro and Expo config live in. */
export function laneAppDirectory(
	lane: Pick<Lane, 'worktreePath' | 'appPath'>
): string {
	return lane.appPath ?? lane.worktreePath;
}

/**
 * Lane creation fails instead of stealing. An app directory, a Simulator, or
 * a port that another live lane owns is an error, never a takeover. Two apps
 * in one monorepo worktree may each have a lane; one app may not have two.
 * What other in-flight starts have reserved counts the same as a lane.
 */
export function findLaneConflict(
	lanes: readonly Lane[],
	candidate: Pick<Lane, 'worktreePath' | 'appPath' | 'simulatorUdid'>,
	reservations: readonly LaneReservation[] = []
): string | undefined {
	const udid = candidate.simulatorUdid.toUpperCase();
	const app = laneAppDirectory(candidate);
	for (const lane of lanes) {
		if (laneAppDirectory(lane) === app) {
			return `${app} already has lane ${lane.id}.`;
		}
		if (lane.simulatorUdid.toUpperCase() === udid) {
			return `Simulator ${candidate.simulatorUdid} is already assigned to lane ${lane.id}.`;
		}
	}
	for (const reservation of reservations) {
		if (reservation.appDirectory === app) {
			return `${app} already has a lane starting.`;
		}
		if (reservation.simulatorUdid?.toUpperCase() === udid) {
			return `Simulator ${candidate.simulatorUdid} is already assigned to a lane starting for ${reservation.appDirectory}.`;
		}
	}
	return undefined;
}

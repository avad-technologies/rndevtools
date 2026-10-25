import { z } from 'zod';
import {
	DEVICE_HOLD_GRACE_MS,
	formatHoldDuration,
	formatStopDelay,
	holdCountdownLabel,
} from './device-hold';
import { UDID_PATTERN } from './simulator-protocol';

/**
 * Local Supabase: one native stack per git worktree and branch, tracked,
 * started, stopped and cleaned up by the desktop for lanes and agents.
 *
 * This module is the renderer-facing contract. The renderer never receives a
 * key, a password, DB_URL, an MCP URL or raw CLI output, and never sends a
 * filesystem path back: every operation names a stack by its full 64-hex id
 * (an expected, not-created row uses the id main computed for it), a
 * repository by its main-issued `repo-<12hex>` id, and requests and jobs by
 * their identifiers. Path labels in the state are display text only.
 *
 * Destructive and trust-changing operations go through a main-owned native
 * dialog: the renderer asks `requestSupabaseConfirmation(op)`, then runs the
 * same operation (same actionId) with the one-time token and the options the
 * dialog returned (see `withSupabaseConfirmation`).
 *
 * Shared code is bundled into the sandboxed preload and the renderer, so it
 * imports only zod and other shared modules.
 */

// ---------------------------------------------------------------------------
// Primitives

const MAX_LABEL_LENGTH = 1_024;
const MAX_TEXT_LENGTH = 1_024;
const MAX_MESSAGE_LENGTH = 4_096;
const MAX_TITLE_LENGTH = 256;
const MAX_STACKS = 128;
const MAX_REPOSITORIES = 32;
const MAX_REQUESTS = 32;
const MAX_JOBS = 64;
const MAX_ACTIVITY = 64;
const MAX_STACK_HOLDS = 16;
const MAX_STACK_LANES = 16;
const MAX_APP_ENV = 8;
const MAX_LOG_RECORDS = 5_000;
/**
 * The newest 64 KiB of redacted log lines main keeps per read.
 */
export const SUPABASE_MAX_LOG_CHARACTERS = 64 * 1_024;
const MAX_LOG_LINE_LENGTH = 2_000;
const MAX_TOP_TABLES = 10;
const MAX_MIGRATION_ROWS = 500;
/**
 * Bulk Stop and Destroy act on at most 20 selected stacks.
 */
export const SUPABASE_MAX_BATCH = 20;
/**
 * One destroy call names at most 32 stacks (the dialect's limit).
 */
export const SUPABASE_MAX_DESTROY_IDS = 32;
const MAX_NOTE_LENGTH = 240;

function hasNoControlCharacters(
	value: string,
	allowNewlines: boolean
): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (allowNewlines && (code === 0x0a || code === 0x09)) continue;
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
	}
	return true;
}

/** Single-line display text with no control characters. */
const plainText = (max: number, min = 0) =>
	z
		.string()
		.min(min)
		.max(max)
		.refine((value) => hasNoControlCharacters(value, false), {
			message: 'Text must not contain control characters.',
		});
/** Display text that may span lines. */
const multilineText = (max: number) =>
	z
		.string()
		.max(max)
		.refine((value) => hasNoControlCharacters(value, true), {
			message: 'Text must not contain control characters.',
		});
/** A display-only label, such as `~/code/example-app-wt/feat-checkout`. */
const labelSchema = z
	.string()
	.min(1)
	.max(MAX_LABEL_LENGTH)
	.refine((value) => hasNoControlCharacters(value, false), {
		message: 'Labels must not contain control characters.',
	});

const identifierSchema = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const timestampSchema = z.number().int().nonnegative();
const durationSchema = z.number().int().nonnegative();
const bytesSchema = z.number().int().nonnegative();
const countSchema = z.number().int().nonnegative();
const portSchema = z.number().int().min(1).max(65_535);
const laneIdSchema = z
	.string()
	.regex(/^lane-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
const udidSchema = z.string().regex(UDID_PATTERN);
const environmentIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const confirmationTokenSchema = z.string().regex(/^confirmation-[a-f0-9]{64}$/);
/** `refs/heads/<branch>`, another full ref, `detached`, or `ordinary-workspace`. */
const branchContextSchema = plainText(1_024, 1);
const releaseSchema = z.string().regex(/^[0-9A-Za-z.+-]{1,80}$/);
const absolutePathSchema = z
	.string()
	.min(2)
	.max(1_024)
	.refine(
		(value) =>
			value.startsWith('/') &&
			!value.includes('\0') &&
			hasNoControlCharacters(value, false),
		{ message: 'The path must be absolute.' }
	);

/**
 * A stack's full id: sha256 over its project root, branch and name.
 */
export const supabaseStackIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
/**
 * Issued by main for a tracked repository; never a path.
 */
export const supabaseRepositoryIdSchema = z
	.string()
	.regex(/^repo-[0-9a-f]{12}$/);
export const supabaseJobIdSchema = z
	.string()
	.regex(
		/^supabase-job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
	);
export const supabaseRequestIdSchema = z
	.string()
	.regex(
		/^supabase-request-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
	);

/** Jobs are `supabase-job-<uuid>`, so `wait` and `jobs` can tell them apart. */
export function isSupabaseJobId(value: string): boolean {
	return supabaseJobIdSchema.safeParse(value).success;
}

/**
 * Whether a URL is a canonical `http://127.0.0.1:<port>[/path]` (or `[::1]`)
 * address with no credentials, query or fragment. The only URLs that reach
 * the renderer; `localhost`, `0.0.0.0`, LAN addresses and https are refused.
 */
export function isLoopbackHttpUrl(value: string): boolean {
	if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
		return false;
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]';
	const canonical = url.href === value || url.href === `${value}/`;
	return (
		url.protocol === 'http:' &&
		loopback &&
		url.port !== '' &&
		url.username === '' &&
		url.password === '' &&
		url.search === '' &&
		url.hash === '' &&
		canonical
	);
}

const loopbackHttpUrlSchema = z.string().max(256).refine(isLoopbackHttpUrl, {
	message: 'Only loopback http URLs reach the renderer.',
});

/**
 * Strips control and bidirectional-override characters, collapses
 * whitespace, and bounds the result. Main runs agent free text (a request's
 * note) through this before it is stored or shown.
 */
export function sanitizeSupabaseDisplayText(
	value: string,
	maxLength: number = MAX_NOTE_LENGTH
): string {
	const cleaned = Array.from(value.normalize('NFKC'))
		.map((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			const control =
				codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
			const bidirectional =
				(codePoint >= 0x202a && codePoint <= 0x202e) ||
				(codePoint >= 0x2066 && codePoint <= 0x2069) ||
				codePoint === 0x200e ||
				codePoint === 0x200f;
			return control || bidirectional ? ' ' : character;
		})
		.join('')
		.replace(/\s+/gu, ' ')
		.trim();
	const characters = Array.from(cleaned);
	return characters.length <= maxLength
		? cleaned
		: `${characters.slice(0, Math.max(0, maxLength - 1)).join('')}…`;
}

// ---------------------------------------------------------------------------
// Vocabulary

export const SUPABASE_EXCLUDABLE_CAPABILITIES = [
	'rest',
	'auth',
	'realtime',
	'storage',
	'functions',
	'studio',
	'mail',
	'analytics',
	'pooler',
] as const;
export type SupabaseExcludableCapability =
	(typeof SUPABASE_EXCLUDABLE_CAPABILITIES)[number];
export const SUPABASE_PREPARABLE_CAPABILITIES = [
	'database',
	...SUPABASE_EXCLUDABLE_CAPABILITIES,
] as const;
/** Every desktop create and resume excludes these unless the policy says otherwise. */
export const SUPABASE_DEFAULT_EXCLUSIONS: readonly SupabaseExcludableCapability[] =
	Object.freeze(['studio', 'analytics']);

const SUPABASE_SERVICE_KINDS = [
	'database',
	'rest',
	'auth',
	'realtime',
	'storage',
	'imgproxy',
	'functions',
	'studio',
	'pgmeta',
	'mail',
	'analytics',
	'pooler',
	'unknown',
] as const;
export type SupabaseServiceKind = (typeof SUPABASE_SERVICE_KINDS)[number];
/**
 * Service states in the CLI's own words.
 */
const SUPABASE_MEMBER_STATES = [
	'unavailable',
	'unhealthy',
	'exited',
	'sleeping',
	'stopped',
	'starting',
	'running',
	'stopping',
] as const;
export type SupabaseMemberState = (typeof SUPABASE_MEMBER_STATES)[number];

const capabilitySchema = z.enum(SUPABASE_EXCLUDABLE_CAPABILITIES);
const capabilityListSchema = z
	.array(capabilitySchema)
	.max(SUPABASE_EXCLUDABLE_CAPABILITIES.length)
	.refine((values) => new Set(values).size === values.length, {
		message: 'Capabilities must be distinct.',
	});
const serviceKindSchema = z.enum(SUPABASE_SERVICE_KINDS);
const memberStateSchema = z.enum(SUPABASE_MEMBER_STATES);
const lifecycleSchema = z.enum(['starting', 'stopping', 'running', 'stopped']);
const readinessSchema = z.enum([
	'unavailable',
	'starting',
	'sleeping',
	'stopped',
	'ready',
	'unhealthy',
]);
const healthSchema = z.enum(['starting', 'healthy', 'unhealthy']);
const runtimeSchema = z.enum(['native', 'docker', 'podman', 'unknown']);
const cliGateSchema = z.enum([
	'verified',
	'compatible',
	'unsupported',
	'missing',
]);
const agentKindSchema = z.enum(['claude', 'codex', 'other']);
const sessionIdSchema = identifierSchema;
const exposureVerdictSchema = z.enum([
	'loopback',
	'lan-exposed',
	'unknown',
	'unchecked',
]);
const modeValueSchema = z.enum(['managed', 'observed', 'off']);
const gitOperationSchema = z.enum([
	'rebase',
	'merge',
	'cherry-pick',
	'revert',
	'bisect',
]);

/**
 * How main maps git's in-progress markers onto {@link SupabaseStackSummary.currentHead}.
 */
export const SUPABASE_GIT_OPERATION_BY_MARKER = Object.freeze({
	'rebase-merge': 'rebase',
	'rebase-apply': 'rebase',
	MERGE_HEAD: 'merge',
	CHERRY_PICK_HEAD: 'cherry-pick',
	REVERT_HEAD: 'revert',
	BISECT_LOG: 'bisect',
} as const satisfies Readonly<
	Record<string, z.infer<typeof gitOperationSchema>>
>);

/**
 * Lifecycle states a row can be in. Exposure, a CLI release mismatch and an
 * unresponsive owner are separate fields, because each can overlay any state.
 */
const SUPABASE_STACK_STATES = [
	/** An expected row: this worktree's stack for its HEAD does not exist yet. */
	'not-created',
	/** Registered with an empty composition (prepared, or downloaded only). */
	'never-started',
	'starting',
	'running',
	/** A member is unhealthy or exited. */
	'unhealthy',
	/** A member stopped while the database runs. */
	'partial',
	'stopping',
	'stopped',
	/** The first start failed and left an empty, registered stack. */
	'failed',
	/** A first start stopped midway; it can't be resumed. */
	'interrupted',
	/** The saved stack cannot adopt the current configuration. */
	'needs-recreate',
	/** The CLI cannot decode its saved state. Never destroyed here. */
	'unreadable',
	/** Not known yet: at boot, or after an in-flight job was lost. */
	'unknown',
] as const;
export type SupabaseStackState = (typeof SUPABASE_STACK_STATES)[number];

export const SUPABASE_STACK_FLAGS = [
	/** The worktree directory is gone. */
	'worktree-deleted',
	/** The stack's project root is gone (two failed checks), worktree or not. */
	'orphaned',
	/** The worktree's HEAD moved off the stack's branch. */
	'stale-branch',
	/** A start without exclusions brought Studio back. */
	'studio-back-on',
	'config-changed',
	'ports-pinned',
	'config-json-conflict',
	'cli-unverified',
	/** The owner's binary changed or was replaced since it started. */
	'cli-changed',
	'cli-missing',
	/** An app .env file defines a mapped app variable; Expo reads that instead. */
	'env-shadowed',
	'other-supabase-home',
	/** The CLI's id differs from the one main predicted for the worktree. */
	'id-mismatch',
	'not-opted-in',
	/** A shadow database root (`supabase-shadow-*`), hidden behind its filter. */
	'transient',
	'lan-exposed',
	'exposure-unknown',
	/** Stopped outside RN Devtools while something still held it. */
	'stopped-outside',
	'prune-suggested',
	/** Agent sessions can't be read, so its abandonment clocks are frozen. */
	'clocks-paused',
] as const;
export type SupabaseStackFlag = (typeof SUPABASE_STACK_FLAGS)[number];

// ---------------------------------------------------------------------------
// Errors

/** Main's classifier codes (main/supabase/cli-errors.ts), mirrored. */
export const SUPABASE_CLI_ERROR_CODES = [
	'not_found',
	'not_running',
	'cli_mismatch',
	'needs_recreate',
	'container_runtime',
	'ports_pinned',
	'ports_conflict',
	'partial',
	'busy',
	'capacity',
	'unreadable',
	'migration_drift',
	'migration_failed',
	'reset_failed_partial',
	'confirm_required',
	'flag_misuse',
	'failed',
] as const;

/**
 * Refusals the desktop raises itself, before or instead of a CLI call.
 */
const SUPABASE_DESKTOP_ERROR_CODES = [
	/** A precondition failed; the message is the visible disabled reason. */
	'refused',
	'feature_off',
	'platform_unsupported',
	/** A required one-time token was missing, expired, or for another operation. */
	'confirmation_required',
	/** The ids are not in a fresh list, or the clean-up selection is stale. */
	'stale_selection',
	'unknown_target',
	'unavailable',
	'internal',
] as const;
export type SupabaseDesktopErrorCode =
	(typeof SUPABASE_DESKTOP_ERROR_CODES)[number];

const errorCodeSchema = z.enum([
	...SUPABASE_CLI_ERROR_CODES,
	...SUPABASE_DESKTOP_ERROR_CODES,
]);

const stackChangeSchema = z.strictObject({
	service: plainText(64).optional(),
	path: plainText(256).optional(),
	key: plainText(256).optional(),
	saved: plainText(256).optional(),
	requested: plainText(256).optional(),
	editable: z.boolean(),
});
export type SupabaseStackChangeView = z.infer<typeof stackChangeSchema>;

/**
 * Whether reverting the listed settings lets the saved stack start again
 * with its data. The CLI refuses the stack while any change is one no
 * setting controls, such as a new Postgres build, so every listed change
 * must be editable; with none listed there is nothing to revert.
 */
export function supabaseRevertKeepsStack(
	changes: readonly Readonly<{ editable: boolean }>[] | undefined
): boolean {
	return (
		changes !== undefined &&
		changes.length > 0 &&
		changes.every((change) => change.editable)
	);
}

const errorDetailsSchema = z.strictObject({
	upstreamCode: z
		.string()
		.regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
		.optional(),
	upstreamSuggestion: multilineText(1_024).optional(),
	/** A full id or the 4-64 hex prefix the CLI named. */
	stackId: z
		.string()
		.regex(/^[0-9a-f]{4,64}$/)
		.optional(),
	port: portSchema.optional(),
	key: plainText(64).optional(),
	portProblem: z
		.enum([
			'held-by-stack',
			'held-by-process',
			'own-listener',
			'reserved-range',
			'exhausted',
			'collision',
		])
		.optional(),
	/** Display label of the project whose stack holds a pinned port. */
	holderProjectLabel: labelSchema.optional(),
	holderStackId: supabaseStackIdSchema.optional(),
	ownerRelease: releaseSchema.optional(),
	clientRelease: releaseSchema.optional(),
	requestedRuntime: z.enum(['native', 'docker', 'podman']).optional(),
	existingRuntime: z.enum(['native', 'docker', 'podman']).optional(),
	migrationDrift: z.enum(['missing-local', 'missing-remote']).optional(),
	stackChanges: z.array(stackChangeSchema).max(64).optional(),
	recreateStackId: supabaseStackIdSchema.optional(),
	destroyedStackIds: z.array(supabaseStackIdSchema).max(64).optional(),
	exitCode: z.number().int().optional(),
	timedOut: z.literal(true).optional(),
	cancelled: z.literal(true).optional(),
	unexpectedOutput: z.literal(true).optional(),
});

/**
 * The renderer-safe projection of main's ClassifiedSupabaseError (same 17
 * codes, display-safe details only), plus the desktop's own refusal codes.
 * Title and recovery are RN Devtools copy; the message is the redacted
 * upstream text. Every CLI code maps to exactly one recovery action.
 */
export const supabaseErrorSchema = z.strictObject({
	code: errorCodeSchema,
	title: plainText(MAX_TITLE_LENGTH),
	message: multilineText(MAX_MESSAGE_LENGTH),
	recovery: multilineText(2_048),
	retry: z.enum(['none', 'once', 'backoff']),
	details: errorDetailsSchema,
});
export type SupabaseErrorView = z.infer<typeof supabaseErrorSchema>;

/**
 * The corrected recovery for unreadable stacks: the CLI fails on state it
 * cannot decode and the desktop never deletes stack folders, so Destroy is
 * never offered for them.
 */
export const SUPABASE_UNREADABLE_RECOVERY =
	"This CLI can't decode the stack's saved state; another Supabase CLI release may have saved it. RN Devtools never deletes stack folders. Reveal the folder in Finder; if no worktree uses another Supabase CLI release, removing the folder discards the stack.";

const DESKTOP_ERROR_COPY: Readonly<
	Record<
		SupabaseDesktopErrorCode,
		Readonly<{ title: string; recovery: string }>
	>
> = {
	refused: { title: 'Not available right now', recovery: '' },
	feature_off: {
		title: 'Local Supabase is off',
		recovery: 'Turn on local Supabase in the Supabase tab first.',
	},
	platform_unsupported: {
		title: 'Not available on this Mac',
		recovery: 'Native Supabase needs Apple silicon and macOS 14 or later.',
	},
	confirmation_required: {
		title: 'Confirmation required',
		recovery: 'Confirm it in the system dialog, then try again.',
	},
	stale_selection: {
		title: 'The list changed',
		recovery: 'Review the selection again.',
	},
	unknown_target: {
		title: 'Not found',
		recovery: 'Refresh the Supabase tab, then try again.',
	},
	unavailable: {
		title: 'Supabase controls are unavailable',
		recovery: 'Open the packaged RN Devtools app.',
	},
	internal: {
		title: 'Something went wrong',
		recovery: 'Try again. If it keeps failing, restart RN Devtools.',
	},
};

/** A desktop-side refusal or failure in the renderer-safe error shape. */
export function supabaseDesktopError(
	code: SupabaseDesktopErrorCode,
	message: string,
	options: Readonly<{ recovery?: string; title?: string }> = {}
): SupabaseErrorView {
	const copy = DESKTOP_ERROR_COPY[code];
	return {
		code,
		title: sanitizeSupabaseDisplayText(
			options.title ?? copy.title,
			MAX_TITLE_LENGTH
		),
		message: sanitizeSupabaseDisplayText(message, MAX_MESSAGE_LENGTH),
		recovery: sanitizeSupabaseDisplayText(
			options.recovery ?? copy.recovery,
			2_048
		),
		retry: 'none',
		details: {},
	};
}

// ---------------------------------------------------------------------------
// Stacks

const holdAgentSchema = z.strictObject({
	kind: agentKindSchema,
	sessionId: sessionIdSchema,
	/** A shared MCP identity (`mcp-*`) that stands for several sessions. */
	synthetic: z.boolean(),
});
export type SupabaseHoldAgent = z.infer<typeof holdAgentSchema>;

const holdTimes = {
	since: timestampSchema,
	live: z.boolean(),
	abandonedSince: timestampSchema.optional(),
	releaseAt: timestampSchema.optional(),
};

/**
 * Who keeps a stack running: a lane (with the agent driving it, if any), an
 * agent session's `supabase up`, a synthetic MCP caller held by worktree, or
 * the operator (a pin, or a start from the Supabase tab).
 */
export const supabaseHoldSchema = z
	.discriminatedUnion('holder', [
		z.strictObject({
			holder: z.literal('lane'),
			laneId: laneIdSchema,
			agent: holdAgentSchema.optional(),
			...holdTimes,
		}),
		z.strictObject({
			holder: z.literal('session'),
			agent: holdAgentSchema,
			...holdTimes,
		}),
		z.strictObject({
			holder: z.literal('worktree'),
			agent: holdAgentSchema,
			...holdTimes,
		}),
		z.strictObject({ holder: z.literal('operator'), ...holdTimes }),
	])
	.superRefine((hold, context) => {
		if (
			hold.live &&
			(hold.abandonedSince !== undefined || hold.releaseAt !== undefined)
		) {
			context.addIssue({
				code: 'custom',
				message: 'A live hold has no abandonment clock.',
			});
		}
		if (hold.holder === 'operator' && !hold.live) {
			context.addIssue({
				code: 'custom',
				message: 'The operator is always live.',
			});
		}
	});
export type SupabaseHold = z.infer<typeof supabaseHoldSchema>;

/**
 * Names one agent hold, for Release. Lane holds end with their lane.
 */
const supabaseHoldRefSchema = z.discriminatedUnion('holder', [
	z.strictObject({
		holder: z.literal('session'),
		agentKind: agentKindSchema,
		sessionId: sessionIdSchema,
	}),
	z.strictObject({
		holder: z.literal('worktree'),
		agentKind: agentKindSchema,
		sessionId: sessionIdSchema,
	}),
]);
export type SupabaseHoldRef = z.infer<typeof supabaseHoldRefSchema>;

/** Whether `hold` is the agent hold `ref` names. */
export function supabaseHoldMatches(
	hold: SupabaseHold,
	ref: SupabaseHoldRef
): boolean {
	return (
		(hold.holder === 'session' || hold.holder === 'worktree') &&
		hold.holder === ref.holder &&
		hold.agent.kind === ref.agentKind &&
		hold.agent.sessionId === ref.sessionId
	);
}

type AgentOrLaneHold = Exclude<SupabaseHold, { holder: 'operator' }>;

function isLiveAgentOrLaneHold(hold: SupabaseHold): hold is AgentOrLaneHold {
	return hold.live && hold.holder !== 'operator';
}

const stackLaneSchema = z.strictObject({
	laneId: laneIdSchema,
	simulatorUdid: udidSchema,
	/** Display name of the lane's Simulator, such as `iPhone 17 Pro`. */
	simulatorLabel: plainText(128).optional(),
	port: portSchema,
	environment: environmentIdSchema,
	metro: z.enum(['starting', 'ready', 'stopped']),
	/** Metro started before the stack attached, or its ports moved since. */
	needsMetroRestart: z.boolean(),
});
export type SupabaseStackLane = z.infer<typeof stackLaneSchema>;

const cwdKeeperSchema = z.strictObject({
	agent: holdAgentSchema,
	cwdLabel: labelSchema.optional(),
});

const createdBySchema = z.strictObject({
	via: z.enum([
		'lane-up',
		'agent-up',
		'operator',
		'pre-download',
		'outside',
		'unknown',
	]),
	agent: z
		.strictObject({ kind: agentKindSchema, sessionId: sessionIdSchema })
		.optional(),
	laneId: laneIdSchema.optional(),
	at: timestampSchema.optional(),
});

const stackCliSchema = z.strictObject({
	version: plainText(64).optional(),
	gate: cliGateSchema,
	/** The worktree's runner, such as `pnpm exec supabase`, built by main. */
	runnerLabel: plainText(64).optional(),
	/** Main-built command text; the renderer never spells CLI words. */
	inspectCommand: plainText(512).optional(),
	statusCommand: plainText(512).optional(),
	/** The owner serves another CLI release than this worktree's client. */
	mismatch: z
		.strictObject({
			ownerRelease: releaseSchema,
			clientRelease: releaseSchema,
			ownerVersion: plainText(64).optional(),
			clientVersion: plainText(64).optional(),
		})
		.optional(),
});

const currentHeadSchema = z.strictObject({
	/** The worktree's live HEAD: a full ref or `detached`. */
	ref: branchContextSchema,
	stableSince: timestampSchema.optional(),
	gitOperation: gitOperationSchema.optional(),
});

/**
 * Names Metro may carry: upper case, digits and underscores.
 */
export const supabaseAppEnvNameSchema = z
	.string()
	.regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const appEnvSourceSchema = z.enum([
	'API_URL',
	'REST_URL',
	'FUNCTIONS_URL',
	'PUBLISHABLE_KEY',
	'ANON_KEY',
]);
export type SupabaseAppEnvSource = z.infer<typeof appEnvSourceSchema>;
const appEnvEntrySchema = z.strictObject({
	name: supabaseAppEnvNameSchema,
	source: appEnvSourceSchema,
});
export type SupabaseAppEnvEntry = z.infer<typeof appEnvEntrySchema>;

export const supabaseStackSummarySchema = z
	.strictObject({
		id: supabaseStackIdSchema,
		/** The CLI's stack name; the desktop only ever uses `default`. */
		name: plainText(128),
		origin: z.enum(['managed', 'adopted', 'external', 'expected']),
		state: z.enum(SUPABASE_STACK_STATES),
		ownerLiveness: z.enum([
			'reachable',
			'absent',
			'starting',
			'sweeping',
			'not-responding',
			'unknown',
		]),
		/** From the last `stack status`; null when nothing was observed. */
		lifecycle: lifecycleSchema.nullable(),
		readiness: readinessSchema.nullable(),
		health: z.strictObject({
			members: countSchema,
			awake: countSchema,
			sleeping: countSchema,
			unhealthy: countSchema,
			unhealthyServices: z.array(serviceKindSchema).max(16),
			excluded: capabilityListSchema,
		}),
		runtime: runtimeSchema,
		/** From lsof over the stack's tree, never from JSON addresses. */
		exposure: z.strictObject({
			verdict: exposureVerdictSchema,
			checkedAt: timestampSchema.optional(),
		}),
		mode: z.strictObject({
			value: modeValueSchema,
			/** Main's reason, e.g. `Supabase CLI 2.122.0 isn't verified`. */
			reasonText: plainText(512).optional(),
		}),
		repositoryId: supabaseRepositoryIdSchema.optional(),
		worktreeLabel: labelSchema.optional(),
		projectRootLabel: labelSchema.optional(),
		/** The branch the stack belongs to; absent only for unreadable stacks. */
		branchContext: branchContextSchema.optional(),
		currentHead: currentHeadSchema.optional(),
		worktreeExists: z.boolean(),
		apiUrl: loopbackHttpUrlSchema.optional(),
		restUrl: loopbackHttpUrlSchema.optional(),
		functionsUrl: loopbackHttpUrlSchema.optional(),
		mailpitUrl: loopbackHttpUrlSchema.optional(),
		studioUrl: loopbackHttpUrlSchema.optional(),
		ports: z.strictObject({
			api: portSchema.optional(),
			db: portSchema.optional(),
			mail: portSchema.optional(),
			studio: portSchema.optional(),
		}),
		excluded: capabilityListSchema,
		studio: z.strictObject({
			/** Studio is a composition member right now. */
			included: z.boolean(),
			/** The operator enabled Studio for this stack; the choice persists. */
			operatorEnabled: z.boolean(),
		}),
		/** A pinned listener port another stack holds, from the static scan. */
		pinnedPort: z
			.strictObject({
				port: portSchema,
				key: plainText(64),
				holderLabel: labelSchema.optional(),
			})
			.optional(),
		lanes: z.array(stackLaneSchema).max(MAX_STACK_LANES),
		holds: z.array(supabaseHoldSchema).max(MAX_STACK_HOLDS),
		/** Live sessions whose cwd is inside the worktree; they keep it running. */
		cwdKeepers: z.array(cwdKeeperSchema).max(16),
		createdBy: createdBySchema,
		pinned: z.boolean(),
		autoStopAt: timestampSchema.optional(),
		autoStopReason: z
			.enum(['released', 'abandoned', 'orphaned', 'superseded', 'capacity'])
			.optional(),
		pruneGroup: z
			.enum([
				'worktree-deleted',
				'stale-branch',
				'retention',
				'failed-start',
				'unreadable',
			])
			.optional(),
		pruneSuggestedAt: timestampSchema.optional(),
		cli: stackCliSchema,
		flags: z
			.array(z.enum(SUPABASE_STACK_FLAGS))
			.max(SUPABASE_STACK_FLAGS.length)
			.refine((values) => new Set(values).size === values.length, {
				message: 'Flags must be distinct.',
			}),
		diskBytes: bytesSchema.optional(),
		uploadsBytes: bytesSchema.optional(),
		/** Uploads lived in the deleted worktree and are already gone. */
		uploadsInDeletedWorktree: z.boolean(),
		memoryBytes: bytesSchema.optional(),
		measuredAt: timestampSchema.optional(),
		lastUsedAt: timestampSchema.optional(),
		configDrift: z.strictObject({
			status: z.enum(['unchanged', 'changed', 'unavailable']),
			paths: z.array(plainText(256)).max(32).optional(),
		}),
		compositionDrift: z
			.strictObject({ reenabled: capabilityListSchema })
			.optional(),
		lastError: supabaseErrorSchema.optional(),
		/**
		 * Needs recreate: what the saved stack can't adopt, as the start that
		 * set the state listed it. It stays until the state clears, so a later
		 * failure for another reason replaces lastError but not this.
		 */
		recreateChanges: z.array(stackChangeSchema).max(64).optional(),
		/** Whether main holds each value in memory; the values never come here. */
		known: z.strictObject({
			publishableKey: z.boolean(),
			anonKey: z.boolean(),
			databaseAddress: z.boolean(),
		}),
		appEnvNames: z.array(supabaseAppEnvNameSchema).max(MAX_APP_ENV),
		envShadow: z
			.array(
				z.strictObject({
					file: labelSchema,
					line: z.number().int().min(1),
					name: supabaseAppEnvNameSchema,
				})
			)
			.max(16)
			.optional(),
		bucketsConfigured: z.boolean(),
		/** Local migration files, for the first-start step count. */
		migrationCount: countSchema,
		requestIds: z.array(supabaseRequestIdSchema).max(8),
		activeJobId: supabaseJobIdSchema.optional(),
		/** For unreadable stacks: whether `<home>/stacks/<id>` still exists. */
		stackFolderExists: z.boolean().optional(),
	})
	.superRefine((stack, context) => {
		if ((stack.origin === 'expected') !== (stack.state === 'not-created')) {
			context.addIssue({
				code: 'custom',
				message: 'Only an expected row is not created, and it always is.',
			});
		}
	});
export type SupabaseStackSummary = z.infer<typeof supabaseStackSummarySchema>;

/**
 * Live member detail, pushed only while a stack is inspected and visible.
 */
const supabaseInspectionSchema = z.strictObject({
	stackId: supabaseStackIdSchema,
	/** `stale`: the last good read, kept while status fails or mismatches. */
	status: z.enum(['live', 'stale', 'unavailable']),
	members: z
		.array(
			z.strictObject({
				service: serviceKindSchema,
				capability: z.enum(SUPABASE_PREPARABLE_CAPABILITIES).optional(),
				activation: z.enum(['eager', 'lazy']),
				state: memberStateSchema,
				lifecycle: lifecycleSchema.nullable(),
				health: healthSchema.nullable(),
				/** Measured wake time for a sleeping member. */
				wakeHintMs: durationSchema.optional(),
				error: plainText(512).optional(),
			})
		)
		.max(32),
	endpoints: z
		.array(
			z.strictObject({
				key: z.string().regex(/^[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9_-]{0,31}$/),
				port: portSchema,
			})
		)
		.max(64),
	checkedAt: timestampSchema,
	error: supabaseErrorSchema.optional(),
});
export type SupabaseInspection = z.infer<typeof supabaseInspectionSchema>;

// ---------------------------------------------------------------------------
// Repositories, requests, jobs, clean up

const SUPABASE_REPOSITORY_CHECK_IDS = [
	'platform',
	'project',
	'stack-flag',
	'config-json',
	'pinned-ports',
	'cli',
	'app-env-files',
	'recommended',
] as const;

const repositoryCheckSchema = z.strictObject({
	id: z.enum(SUPABASE_REPOSITORY_CHECK_IDS),
	status: z.enum(['ready', 'needs-fix', 'check', 'optional', 'checking']),
	summary: plainText(512),
	/** File and line facts from main's static scan; dotenv values are elided. */
	lines: z
		.array(
			z.strictObject({
				file: labelSchema,
				line: z.number().int().min(1),
				text: plainText(512),
			})
		)
		.max(16)
		.optional(),
	/** Copy-only: RN Devtools never edits repository files. */
	fix: z
		.strictObject({
			text: plainText(512),
			snippet: multilineText(2_048).optional(),
		})
		.optional(),
});

export const supabaseRepositorySummarySchema = z.strictObject({
	id: supabaseRepositoryIdSchema,
	label: labelSchema,
	appPathLabel: labelSchema.optional(),
	/** The row's readiness word. */
	readiness: z.enum([
		'ready',
		'needs-fix',
		'observed',
		'no-supabase',
		'off',
		'checking',
	]),
	/** Use local Supabase here: the per-repository policy override. */
	mode: z.enum(['auto', 'off']),
	counts: z.strictObject({
		worktrees: countSchema,
		managed: countSchema,
		observed: countSchema,
		running: countSchema,
	}),
	cli: z.strictObject({
		version: plainText(64).optional(),
		gate: cliGateSchema.optional(),
		runnerLabel: plainText(64).optional(),
	}),
	checks: z.array(repositoryCheckSchema).max(16),
	worktrees: z
		.array(
			z.strictObject({
				pathLabel: labelSchema,
				branch: plainText(256),
				mode: modeValueSchema,
				reasonText: plainText(512).optional(),
				stackId: supabaseStackIdSchema.optional(),
			})
		)
		.max(128),
	checkedAt: timestampSchema.optional(),
});
export type SupabaseRepositorySummary = z.infer<
	typeof supabaseRepositorySummarySchema
>;

/**
 * An agent asked for something only the user may approve: destroying a
 * stack, resetting a database others hold, or (P5) a start parked because
 * every slot is in use. Requests expire after 30 minutes.
 */
const supabaseAgentRequestSchema = z.strictObject({
	id: supabaseRequestIdSchema,
	kind: z.enum(['destroy', 'reset', 'start-capacity']),
	status: z.enum([
		'pending',
		'settling',
		'approved',
		'denied',
		'expired',
		'failed',
	]),
	requester: z.strictObject({
		kind: agentKindSchema,
		sessionId: sessionIdSchema,
		live: z.boolean(),
		synthetic: z.boolean(),
	}),
	stackId: supabaseStackIdSchema.optional(),
	/** The branch label the request is about. */
	branch: plainText(256),
	sizeBytes: bytesSchema.optional(),
	/** For reset requests. */
	seed: z.boolean().optional(),
	createdAt: timestampSchema,
	expiresAt: timestampSchema,
	/** The agent's sanitized note: shown on the card only, never in a dialog. */
	note: plainText(MAX_NOTE_LENGTH).optional(),
	otherHolders: z
		.array(
			z.strictObject({
				holder: z.enum(['lane', 'session', 'worktree', 'operator']),
				agent: holdAgentSchema.optional(),
				live: z.boolean(),
			})
		)
		.max(16),
	laneAttached: z
		.strictObject({
			laneId: laneIdSchema,
			port: portSchema,
			running: z.boolean(),
			ownedByRequester: z.boolean(),
		})
		.optional(),
	/** The requester's worktree moved to this branch since it asked. */
	branchMovedTo: plainText(256).optional(),
	/** Start-capacity requests: what could make room. */
	capacity: z
		.strictObject({
			running: countSchema,
			cap: countSchema,
			candidates: z
				.array(
					z.strictObject({
						stackId: supabaseStackIdSchema,
						branch: plainText(256),
						holderLabel: plainText(256).optional(),
						idleSinceAt: timestampSchema.optional(),
						liveHolder: z.boolean(),
					})
				)
				.max(16),
		})
		.optional(),
	error: supabaseErrorSchema.optional(),
});
export type SupabaseAgentRequest = z.infer<typeof supabaseAgentRequestSchema>;

const SUPABASE_JOB_KINDS = [
	'create',
	'resume',
	'stop',
	'restart',
	'stop-and-start',
	'destroy',
	'recreate',
	'reset',
	'migrate',
	'seed-buckets',
	'export',
	'prepare',
	'studio',
	'disable',
] as const;
export type SupabaseJobKind = (typeof SUPABASE_JOB_KINDS)[number];

export const supabaseJobSchema = z.strictObject({
	id: supabaseJobIdSchema,
	kind: z.enum(SUPABASE_JOB_KINDS),
	stackIds: z.array(supabaseStackIdSchema).max(SUPABASE_MAX_DESTROY_IDS),
	status: z.enum([
		'queued',
		'running',
		'complete',
		'failed',
		'cancelled',
		'lost',
	]),
	/** Steps parsed from redacted stderr, lsof and the lane attach; no percentages. */
	steps: z
		.array(
			z.strictObject({
				id: identifierSchema,
				label: plainText(256),
				state: z.enum(['done', 'current', 'pending', 'failed', 'skipped']),
				detail: plainText(256).optional(),
			})
		)
		.max(16)
		.optional(),
	migration: z
		.strictObject({ done: countSchema, total: countSchema })
		.optional(),
	/** The first start on this Mac downloads services once. */
	coldCache: z.boolean().optional(),
	/** The latest redacted progress line. */
	latestLine: plainText(512).optional(),
	startedAt: timestampSchema,
	updatedAt: timestampSchema,
	expectedMs: durationSchema.optional(),
	error: supabaseErrorSchema.optional(),
	cancellable: z.boolean(),
	cancelRequested: z.boolean().optional(),
	requestedBy: z.discriminatedUnion('kind', [
		z.strictObject({ kind: z.literal('operator') }),
		z.strictObject({
			kind: z.literal('agent'),
			agent: z.strictObject({
				kind: agentKindSchema,
				sessionId: sessionIdSchema,
			}),
		}),
		z.strictObject({ kind: z.literal('lane'), laneId: laneIdSchema }),
		z.strictObject({
			kind: z.literal('automatic'),
			reason: z.enum([
				'idle',
				'abandoned',
				'orphaned',
				'capacity',
				'follow',
				'container',
				'cli-upgrade',
				'disable',
			]),
		}),
	]),
});
export type SupabaseJob = z.infer<typeof supabaseJobSchema>;

const ACTIVE_JOB_STATUSES: ReadonlySet<SupabaseJob['status']> = new Set([
	'queued',
	'running',
]);

/**
 * Whether a job is still queued or running.
 */
export function isActiveSupabaseJob(job: Pick<SupabaseJob, 'status'>): boolean {
	return ACTIVE_JOB_STATUSES.has(job.status);
}

const SUPABASE_PRUNE_GROUPS = [
	'worktree-deleted',
	'stale-branch',
	'retention',
	'failed-start',
	'unreadable',
] as const;

export const supabasePruneSummarySchema = z.strictObject({
	/** A clean-up selection is valid only for the revision it was made on. */
	revision: countSchema,
	computedAt: timestampSchema,
	groups: z
		.array(
			z.strictObject({
				id: z.enum(SUPABASE_PRUNE_GROUPS),
				stackIds: z.array(supabaseStackIdSchema).max(MAX_STACKS),
				bytes: bytesSchema.optional(),
				/** Unreadable stacks are never selectable. */
				selectable: z.boolean(),
				preselected: z.boolean(),
			})
		)
		.max(SUPABASE_PRUNE_GROUPS.length),
	onDiskBytes: bytesSchema.optional(),
	suggestedBytes: bytesSchema.optional(),
	notSuggested: z.strictObject({
		held: countSchema,
		pinned: countSchema,
		starting: countSchema,
		external: countSchema,
		running: countSchema,
	}),
	lastResult: z
		.strictObject({
			at: timestampSchema,
			destroyed: countSchema,
			failed: countSchema,
			freedBytes: bytesSchema.optional(),
		})
		.optional(),
});
export type SupabasePruneSummary = z.infer<typeof supabasePruneSummarySchema>;

// ---------------------------------------------------------------------------
// Policy

/**
 * Names Metro sets itself on every lane; a mapping may not use them.
 */
const SUPABASE_METRO_RESERVED_ENV_NAMES: readonly string[] = Object.freeze([
	'NODE_ENV',
	'RCT_METRO_PORT',
	'EXPO_NO_DOTENV',
	'EXPO_NO_INTERACTIVE',
	'EXPO_NO_DEV_MENU',
	'CI',
	'NODE_OPTIONS',
]);
/** Metro refuses lane variables named like credentials (lane-metro.ts). */
const SECRET_LIKE_ENV_NAME =
	/(?:SECRET|SERVICE_ROLE|PASSWORD|PASSWD|PRIVATE_KEY|ROOT_KEY|DB_URL|DATABASE_URL)/;

/**
 * The Supabase + Expo preset for app variables.
 */
export const SUPABASE_APP_ENV_PRESET: readonly SupabaseAppEnvEntry[] =
	Object.freeze([
		{ name: 'EXPO_PUBLIC_SUPABASE_URL', source: 'API_URL' },
		{ name: 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY', source: 'PUBLISHABLE_KEY' },
	]);

const laneDefaultSchema = z.strictObject({
	environmentId: environmentIdSchema,
	/** Required stays a per-lane-start choice. */
	backend: z.enum(['auto', 'off']),
});

/**
 * The policy as the renderer sees it; paths are labels only.
 */
export const supabasePolicySchema = z.strictObject({
	maxRunning: z.number().int().min(1).max(24),
	exclude: capabilityListSchema,
	unheldStopDelayMs: z.number().int().min(0).max(3_600_000),
	/** Fixed: the same as Simulator holds. */
	abandonedGraceMs: durationSchema,
	retentionDays: z.number().int().min(1).max(90),
	branchSwitch: z.enum(['follow', 'warn']),
	allowUnverifiedPatch: z.boolean(),
	stopContainerStacksOnce: z.boolean(),
	appEnv: z.array(appEnvEntrySchema).max(MAX_APP_ENV),
	appEnvPreset: z.array(appEnvEntrySchema).max(MAX_APP_ENV),
	laneDefaults: z.array(laneDefaultSchema).max(16),
	repositories: z
		.array(
			z.strictObject({
				id: supabaseRepositoryIdSchema,
				mode: z.enum(['auto', 'off']),
			})
		)
		.max(MAX_REPOSITORIES),
	/** Set only through main-owned file dialogs (`choose-path`). */
	paths: z.strictObject({
		supabaseHomeLabel: labelSchema,
		customHome: z.boolean(),
		sslCertLabel: labelSchema.optional(),
	}),
	/** A full per-stack key set in a gitignored supabase/.env.local. */
	perStackKeys: z.boolean(),
	/** Lease SUPABASE_*_PORT blocks for repositories that pin ports. */
	pinnedPortsCompat: z.boolean(),
	/** Lanes start every service eagerly. */
	eagerLanes: z.boolean(),
});
export type SupabasePolicy = z.infer<typeof supabasePolicySchema>;

/** The defaults main's policy store starts from and restores on quarantine. */
export const SUPABASE_POLICY_DEFAULTS: SupabasePolicy =
	Object.freeze<SupabasePolicy>({
		maxRunning: 12,
		exclude: [...SUPABASE_DEFAULT_EXCLUSIONS],
		unheldStopDelayMs: 60_000,
		abandonedGraceMs: DEVICE_HOLD_GRACE_MS,
		retentionDays: 14,
		branchSwitch: 'follow',
		allowUnverifiedPatch: false,
		stopContainerStacksOnce: true,
		appEnv: SUPABASE_APP_ENV_PRESET.map((entry) => ({ ...entry })),
		appEnvPreset: SUPABASE_APP_ENV_PRESET.map((entry) => ({ ...entry })),
		laneDefaults: [
			{ environmentId: 'development', backend: 'auto' },
			{ environmentId: 'staging', backend: 'off' },
			{ environmentId: 'production', backend: 'off' },
		],
		repositories: [],
		paths: { supabaseHomeLabel: '~/.supabase', customHome: false },
		perStackKeys: false,
		pinnedPortsCompat: false,
		eagerLanes: false,
	});

/**
 * min(12, floor((shmmni − 8) / 2)), clamped to 1-24: one SysV segment per
 * postmaster, with 8 kept free for shadow databases. 12 when unknown.
 */
export function supabaseDerivedCap(shmmni?: number): number {
	if (shmmni === undefined || !Number.isFinite(shmmni)) return 12;
	return Math.max(1, Math.min(24, Math.min(12, Math.floor((shmmni - 8) / 2))));
}

/** Field errors use the Settings copy, so the renderer form and main agree. */
export const SUPABASE_POLICY_ERRORS = Object.freeze({
	maxRunning: 'Max running must be a whole number from 1 to 24.',
	unheldStopDelayMs: 'Stop after release must be 0 to 3600 seconds.',
	retentionDays: 'Suggest cleanup must be 1 to 90 days.',
	appEnvName:
		'Names use upper-case letters, digits and underscores, and start with a letter.',
	appEnvDuplicate: 'That name is already mapped.',
	appEnvReserved: 'That name is reserved for Metro.',
	appEnvSecret:
		'That name looks like a secret; app variables carry public values only.',
	appEnvCount: 'Map at most 8 app variables.',
	exclude: 'Exclusions must name known services once each.',
	laneDefaults: 'Each environment may have one lane default.',
	empty: 'Change a value to apply.',
});

/**
 * What `update-policy` may change. Paths change only through `choose-path`.
 */
export const supabasePolicyPatchSchema = z
	.strictObject({
		maxRunning: z
			.number(SUPABASE_POLICY_ERRORS.maxRunning)
			.int(SUPABASE_POLICY_ERRORS.maxRunning)
			.min(1, SUPABASE_POLICY_ERRORS.maxRunning)
			.max(24, SUPABASE_POLICY_ERRORS.maxRunning)
			.optional(),
		exclude: z
			.array(capabilitySchema, SUPABASE_POLICY_ERRORS.exclude)
			.max(
				SUPABASE_EXCLUDABLE_CAPABILITIES.length,
				SUPABASE_POLICY_ERRORS.exclude
			)
			.optional(),
		unheldStopDelayMs: z
			.number(SUPABASE_POLICY_ERRORS.unheldStopDelayMs)
			.int(SUPABASE_POLICY_ERRORS.unheldStopDelayMs)
			.min(0, SUPABASE_POLICY_ERRORS.unheldStopDelayMs)
			.max(3_600_000, SUPABASE_POLICY_ERRORS.unheldStopDelayMs)
			.optional(),
		retentionDays: z
			.number(SUPABASE_POLICY_ERRORS.retentionDays)
			.int(SUPABASE_POLICY_ERRORS.retentionDays)
			.min(1, SUPABASE_POLICY_ERRORS.retentionDays)
			.max(90, SUPABASE_POLICY_ERRORS.retentionDays)
			.optional(),
		branchSwitch: z.enum(['follow', 'warn']).optional(),
		allowUnverifiedPatch: z.boolean().optional(),
		stopContainerStacksOnce: z.boolean().optional(),
		appEnv: z
			.array(
				z.strictObject({
					name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, {
						message: SUPABASE_POLICY_ERRORS.appEnvName,
					}),
					source: appEnvSourceSchema,
				})
			)
			.max(MAX_APP_ENV, SUPABASE_POLICY_ERRORS.appEnvCount)
			.optional(),
		laneDefaults: z.array(laneDefaultSchema).max(16).optional(),
		perStackKeys: z.boolean().optional(),
		pinnedPortsCompat: z.boolean().optional(),
		eagerLanes: z.boolean().optional(),
	})
	.superRefine((patch, context) => {
		if (Object.keys(patch).length === 0) {
			context.addIssue({
				code: 'custom',
				message: SUPABASE_POLICY_ERRORS.empty,
			});
		}
		if (patch.exclude && new Set(patch.exclude).size !== patch.exclude.length) {
			context.addIssue({
				code: 'custom',
				path: ['exclude'],
				message: SUPABASE_POLICY_ERRORS.exclude,
			});
		}
		if (patch.laneDefaults) {
			const ids = patch.laneDefaults.map((entry) => entry.environmentId);
			if (new Set(ids).size !== ids.length) {
				context.addIssue({
					code: 'custom',
					path: ['laneDefaults'],
					message: SUPABASE_POLICY_ERRORS.laneDefaults,
				});
			}
		}
		const seen = new Set<string>();
		for (const [index, entry] of (patch.appEnv ?? []).entries()) {
			const path = ['appEnv', index, 'name'];
			if (seen.has(entry.name)) {
				context.addIssue({
					code: 'custom',
					path,
					message: SUPABASE_POLICY_ERRORS.appEnvDuplicate,
				});
			} else if (SUPABASE_METRO_RESERVED_ENV_NAMES.includes(entry.name)) {
				context.addIssue({
					code: 'custom',
					path,
					message: SUPABASE_POLICY_ERRORS.appEnvReserved,
				});
			} else if (SECRET_LIKE_ENV_NAME.test(entry.name)) {
				context.addIssue({
					code: 'custom',
					path,
					message: SUPABASE_POLICY_ERRORS.appEnvSecret,
				});
			}
			seen.add(entry.name);
		}
	});
export type SupabasePolicyPatch = z.infer<typeof supabasePolicyPatchSchema>;

/**
 * Field errors for a policy patch, keyed by field (`appEnv.<index>` for an
 * app variable row), in the Settings copy. Empty when the patch is valid.
 */
export function supabasePolicyPatchErrors(
	patch: unknown
): Readonly<Record<string, string>> {
	const parsed = supabasePolicyPatchSchema.safeParse(patch);
	if (parsed.success) return {};
	const errors: Record<string, string> = {};
	for (const issue of parsed.error.issues) {
		const [field, index] = issue.path;
		const key =
			typeof field !== 'string'
				? 'form'
				: field === 'appEnv' && typeof index === 'number'
					? `appEnv.${index}`
					: field;
		errors[key] ??= issue.message;
	}
	return errors;
}

/** Applies a validated patch; fields it leaves out keep their value. */
export function applySupabasePolicyPatch(
	policy: SupabasePolicy,
	patch: SupabasePolicyPatch
): SupabasePolicy {
	const next: SupabasePolicy = { ...policy };
	if (patch.maxRunning !== undefined) next.maxRunning = patch.maxRunning;
	if (patch.exclude !== undefined) next.exclude = [...patch.exclude];
	if (patch.unheldStopDelayMs !== undefined) {
		next.unheldStopDelayMs = patch.unheldStopDelayMs;
	}
	if (patch.retentionDays !== undefined)
		next.retentionDays = patch.retentionDays;
	if (patch.branchSwitch !== undefined) next.branchSwitch = patch.branchSwitch;
	if (patch.allowUnverifiedPatch !== undefined) {
		next.allowUnverifiedPatch = patch.allowUnverifiedPatch;
	}
	if (patch.stopContainerStacksOnce !== undefined) {
		next.stopContainerStacksOnce = patch.stopContainerStacksOnce;
	}
	if (patch.appEnv !== undefined) {
		next.appEnv = patch.appEnv.map((entry) => ({ ...entry }));
	}
	if (patch.laneDefaults !== undefined) {
		next.laneDefaults = patch.laneDefaults.map((entry) => ({ ...entry }));
	}
	if (patch.perStackKeys !== undefined) next.perStackKeys = patch.perStackKeys;
	if (patch.pinnedPortsCompat !== undefined) {
		next.pinnedPortsCompat = patch.pinnedPortsCompat;
	}
	if (patch.eagerLanes !== undefined) next.eagerLanes = patch.eagerLanes;
	return next;
}

/**
 * The trust-weakening changes in a patch, each needing the native dialog:
 * Studio no longer excluded by default, unverified patch releases allowed,
 * per-stack keys written into worktrees. The safer direction needs none.
 */
export function supabasePolicyTrustChanges(
	patch: SupabasePolicyPatch,
	current: Pick<
		SupabasePolicy,
		'exclude' | 'allowUnverifiedPatch' | 'perStackKeys'
	>
): readonly ('include-studio' | 'allow-unverified-patch' | 'per-stack-keys')[] {
	const changes: (
		| 'include-studio'
		| 'allow-unverified-patch'
		| 'per-stack-keys'
	)[] = [];
	if (
		patch.exclude !== undefined &&
		current.exclude.includes('studio') &&
		!patch.exclude.includes('studio')
	) {
		changes.push('include-studio');
	}
	if (patch.allowUnverifiedPatch === true && !current.allowUnverifiedPatch) {
		changes.push('allow-unverified-patch');
	}
	if (patch.perStackKeys === true && !current.perStackKeys) {
		changes.push('per-stack-keys');
	}
	return changes;
}

// ---------------------------------------------------------------------------
// App traffic signature (P5)

/**
 * API path prefixes that identify Supabase traffic in captured requests.
 */
const SUPABASE_API_PATH_PREFIXES: readonly string[] = Object.freeze([
	'/rest/v1',
	'/auth/v1',
	'/storage/v1',
	'/functions/v1',
	'/realtime/v1',
	'/graphql/v1',
]);
/**
 * Host suffixes of hosted projects; the first label is the project ref.
 */
const SUPABASE_HOSTED_SUFFIXES: readonly string[] = Object.freeze([
	'.supabase.co',
	'.supabase.in',
]);
/**
 * The Docker-era default API port.
 */
const SUPABASE_LEGACY_API_PORT = 54_321;

/**
 * What main tells the renderer so it can classify an app's captured traffic
 * without secrets: which loopback API port belongs to which stack, and how
 * hosted and legacy targets look.
 */
const supabaseTrafficSignatureSchema = z.strictObject({
	apiPorts: z
		.array(z.strictObject({ port: portSchema, stackId: supabaseStackIdSchema }))
		.max(MAX_STACKS),
	hostedSuffixes: z
		.array(
			z
				.string()
				.max(253)
				.regex(/^\.[a-z0-9-]+(?:\.[a-z0-9-]+)+$/)
		)
		.max(8),
	legacyPorts: z.array(portSchema).max(8),
	pathPrefixes: z
		.array(
			z
				.string()
				.max(64)
				.regex(/^\/[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/)
		)
		.max(16),
});
export type SupabaseTrafficSignature = z.infer<
	typeof supabaseTrafficSignatureSchema
>;

/** The signature main builds from its api-port index. */
export function supabaseTrafficSignature(
	apiPorts: readonly Readonly<{ port: number; stackId: string }>[]
): SupabaseTrafficSignature {
	return {
		apiPorts: apiPorts.map((entry) => ({
			port: entry.port,
			stackId: entry.stackId,
		})),
		hostedSuffixes: [...SUPABASE_HOSTED_SUFFIXES],
		legacyPorts: [SUPABASE_LEGACY_API_PORT],
		pathPrefixes: [...SUPABASE_API_PATH_PREFIXES],
	};
}

// ---------------------------------------------------------------------------
// State

const activityEntrySchema = z.strictObject({
	id: identifierSchema,
	kind: z.enum(SUPABASE_JOB_KINDS),
	stackIds: z.array(supabaseStackIdSchema).max(SUPABASE_MAX_DESTROY_IDS),
	outcome: z.enum(['complete', 'failed', 'cancelled', 'lost']),
	errorCode: errorCodeSchema.optional(),
	startedAt: timestampSchema,
	durationMs: durationSchema,
	requestedBy: z.enum(['operator', 'agent', 'lane', 'automatic']),
	coldCache: z.boolean().optional(),
});
export type SupabaseActivityEntry = z.infer<typeof activityEntrySchema>;

const platformSchema = z.strictObject({
	supported: z.boolean(),
	/** `arm64` or `x64`; empty until main has read it. */
	arch: plainText(32),
	macosVersion: plainText(32),
	reasonText: plainText(512).optional(),
});

/**
 * Everything the Supabase tab and the cross-panel chips render. Pushed on
 * change (coalesced to 100 ms), re-parsed in main, safe-parsed in preload,
 * and accepted by the renderer only when its revision is not older.
 */
export const supabaseStateSchema = z
	.strictObject({
		revision: countSchema,
		updatedAt: timestampSchema,
		source: z.enum(['live', 'demo']),
		availability: z.strictObject({ platform: platformSchema }),
		feature: z.strictObject({
			enabled: z.boolean(),
			acknowledgedAt: timestampSchema.optional(),
			policyHealth: z.enum(['ok', 'quarantined']),
			disabling: z
				.strictObject({
					remaining: countSchema,
					total: countSchema,
					waitingForStarts: z.boolean(),
				})
				.optional(),
		}),
		discovery: z.strictObject({
			status: z.enum(['live', 'paused', 'off']),
			lastListAt: timestampSchema.optional(),
			sessions: z.enum(['ok', 'unavailable']),
			/** The last refresh failed; the rest of the state is from before it. */
			listFailure: z
				.strictObject({ message: multilineText(1_024), at: timestampSchema })
				.optional(),
		}),
		capacity: z.strictObject({
			running: countSchema,
			starting: countSchema,
			queued: countSchema,
			cap: z.number().int().min(1).max(24),
			derivedCap: z.number().int().min(1).max(24),
			sysv: z
				.strictObject({ used: countSchema, limit: countSchema })
				.nullable(),
			memoryPressure: z.enum(['normal', 'warning', 'critical', 'unknown']),
			/** The unheld managed stack admission would stop to make room. */
			nextToStopId: supabaseStackIdSchema.optional(),
		}),
		footprint: z.strictObject({
			mode: z.enum(['measured', 'estimate']),
			bytes: bytesSchema,
			measuredAt: timestampSchema.optional(),
			awake: countSchema,
			idle: countSchema,
		}),
		disk: z.strictObject({
			stacksBytes: bytesSchema.optional(),
			uploadsBytes: bytesSchema.optional(),
			cacheBytes: bytesSchema.optional(),
			cacheState: z.enum(['cold', 'warm', 'unknown']),
			measuredAt: timestampSchema.optional(),
		}),
		home: z.strictObject({
			label: labelSchema,
			/** Other Supabase homes seen in the port registry. */
			foreign: z.array(labelSchema).max(8).optional(),
		}),
		engines: z.strictObject({
			docker: z.enum(['found', 'absent']),
			podman: z.enum(['found', 'absent']),
		}),
		policy: supabasePolicySchema,
		stacks: z.array(supabaseStackSummarySchema).max(MAX_STACKS),
		repositories: z
			.array(supabaseRepositorySummarySchema)
			.max(MAX_REPOSITORIES),
		requests: z.array(supabaseAgentRequestSchema).max(MAX_REQUESTS),
		jobs: z.array(supabaseJobSchema).max(MAX_JOBS),
		prune: supabasePruneSummarySchema,
		/** Shadow-database stacks, listed only under the Transient filter. */
		transientCount: countSchema,
		notices: z.strictObject({
			/** Docker or Podman stacks found on managed identities. */
			containerStacks: z.array(supabaseStackIdSchema).max(32),
			registryError: multilineText(1_024).optional(),
		}),
		inspection: supabaseInspectionSchema.optional(),
		trafficSignature: supabaseTrafficSignatureSchema,
		/** Recent outcomes with durations, for local stats and kill criteria. */
		activity: z.array(activityEntrySchema).max(MAX_ACTIVITY),
	})
	.superRefine((state, context) => {
		const unique = (
			values: readonly string[],
			field: 'stacks' | 'repositories' | 'requests' | 'jobs'
		) => {
			if (new Set(values).size !== values.length) {
				context.addIssue({
					code: 'custom',
					path: [field],
					message: `Every ${field.slice(0, -1)} id must be unique.`,
				});
			}
		};
		unique(
			state.stacks.map((stack) => stack.id),
			'stacks'
		);
		unique(
			state.repositories.map((repository) => repository.id),
			'repositories'
		);
		unique(
			state.requests.map((request) => request.id),
			'requests'
		);
		unique(
			state.jobs.map((job) => job.id),
			'jobs'
		);
	});
export type SupabaseState = z.infer<typeof supabaseStateSchema>;

/** The state before main has answered, and whenever the bridge is missing. */
export const EMPTY_SUPABASE_STATE: SupabaseState = Object.freeze<SupabaseState>(
	{
		revision: 0,
		updatedAt: 0,
		source: 'live',
		availability: {
			platform: { supported: false, arch: '', macosVersion: '' },
		},
		feature: { enabled: false, policyHealth: 'ok' },
		discovery: { status: 'off', sessions: 'ok' },
		capacity: {
			running: 0,
			starting: 0,
			queued: 0,
			cap: 12,
			derivedCap: 12,
			sysv: null,
			memoryPressure: 'unknown',
		},
		footprint: { mode: 'estimate', bytes: 0, awake: 0, idle: 0 },
		disk: { cacheState: 'unknown' },
		home: { label: '~/.supabase' },
		engines: { docker: 'absent', podman: 'absent' },
		policy: SUPABASE_POLICY_DEFAULTS,
		stacks: [],
		repositories: [],
		requests: [],
		jobs: [],
		prune: {
			revision: 0,
			computedAt: 0,
			groups: [],
			notSuggested: {
				held: 0,
				pinned: 0,
				starting: 0,
				external: 0,
				running: 0,
			},
		},
		transientCount: 0,
		notices: { containerStacks: [] },
		trafficSignature: supabaseTrafficSignature([]),
		activity: [],
	}
);

// ---------------------------------------------------------------------------
// Operations

const LOG_SERVICE_NAMES: ReadonlySet<string> = new Set([
	...SUPABASE_SERVICE_KINDS.filter((kind) => kind !== 'unknown'),
	'gateway',
]);
export const logServiceSchema = z
	.string()
	.max(64)
	.refine(
		(value) =>
			LOG_SERVICE_NAMES.has(value) ||
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
				value
			),
		{ message: 'Log services are service kinds, instance ids, or gateway.' }
	);
/** `start`, a duration such as `10m`, or an ISO-8601 time. */
export const logSinceSchema = z
	.string()
	.max(64)
	.refine(
		(value) =>
			value === 'start' ||
			/^(?:\d{1,6}(?:\.\d{1,3})?(?:ms|s|m|h|d)){1,6}$/.test(value) ||
			(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
				value
			) &&
				!Number.isNaN(Date.parse(value))),
		{ message: 'The log window is start, a duration, or an ISO-8601 time.' }
	);
const distinct = <T>(values: readonly T[]) =>
	new Set(values).size === values.length;

const operationBase = { actionId: identifierSchema };
const stackOperationBase = { ...operationBase, stackId: supabaseStackIdSchema };

/**
 * Every control in the Supabase tab and its cross-panel integrations. Ids
 * only: a stack by its full id, a repository by its main-issued id.
 * `confirmationToken` appears on the operations the native dialog guards
 * ({@link SUPABASE_CONFIRMATION_KINDS}).
 */
export const supabaseOperationSchema = z.discriminatedUnion('kind', [
	z.strictObject({ ...operationBase, kind: z.literal('refresh') }),
	z.strictObject({
		...stackOperationBase,
		kind: z.literal('read-logs'),
		services: z
			.array(logServiceSchema)
			.min(1)
			.max(16)
			.refine(distinct, { message: 'Name each service once.' })
			.optional(),
		tail: z.number().int().min(0).max(1_000),
		since: logSinceSchema.optional(),
	}),
	z.strictObject({ ...stackOperationBase, kind: z.literal('read-database') }),
	/** Creates an expected (not-created) row, or resumes a stopped stack. */
	z.strictObject({ ...stackOperationBase, kind: z.literal('start') }),
	/** `stack restart` on a stopped stack: its saved settings, any HEAD. */
	z.strictObject({ ...stackOperationBase, kind: z.literal('resume-saved') }),
	z.strictObject({
		...operationBase,
		kind: z.literal('stop'),
		stackIds: z
			.array(supabaseStackIdSchema)
			.min(1)
			.max(SUPABASE_MAX_BATCH)
			.refine(distinct, { message: 'Name each stack once.' }),
		/** Required when a stack is external. */
		confirmationToken: confirmationTokenSchema.optional(),
	}),
	z.strictObject({ ...stackOperationBase, kind: z.literal('restart') }),
	z.strictObject({
		...stackOperationBase,
		kind: z.literal('stop-and-start'),
		purpose: z.enum(['apply-config', 'switch-cli', 'recover-partial']),
	}),
	z.strictObject({
		...stackOperationBase,
		kind: z.literal('reapply-exclusions'),
	}),
	z.strictObject({ ...stackOperationBase, kind: z.literal('pin') }),
	z.strictObject({ ...stackOperationBase, kind: z.literal('unpin') }),
	z.strictObject({
		...stackOperationBase,
		kind: z.literal('release'),
		holder: supabaseHoldRefSchema,
	}),
	z.strictObject({ ...stackOperationBase, kind: z.literal('adopt') }),
	/** Pre-download services: `stack prepare` then a stop. */
	z
		.strictObject({
			...operationBase,
			kind: z.literal('prepare'),
			repositoryId: supabaseRepositoryIdSchema.optional(),
			stackId: supabaseStackIdSchema.optional(),
			capabilities: z
				.array(z.enum(SUPABASE_PREPARABLE_CAPABILITIES))
				.min(1)
				.max(SUPABASE_PREPARABLE_CAPABILITIES.length)
				.refine(distinct, { message: 'Name each capability once.' })
				.optional(),
		})
		.refine(
			(operation) =>
				(operation.repositoryId === undefined) !==
				(operation.stackId === undefined),
			{ message: 'Prepare takes exactly one of repositoryId or stackId.' }
		),
	z.strictObject({
		...stackOperationBase,
		kind: z.literal('apply-migrations'),
	}),
	z.strictObject({
		...stackOperationBase,
		kind: z.literal('reset'),
		seed: z.boolean(),
		confirmationToken: confirmationTokenSchema.optional(),
	}),
	z.strictObject({ ...stackOperationBase, kind: z.literal('seed-buckets') }),
	/** Main shows the save dialog; the renderer never names the file. */
	z.strictObject({
		...stackOperationBase,
		kind: z.literal('export'),
		content: z.enum(['schema', 'data']),
	}),
	/** Single, bulk and Clean up. Stopped stacks without a running lane only. */
	z.strictObject({
		...operationBase,
		kind: z.literal('destroy'),
		stackIds: z
			.array(supabaseStackIdSchema)
			.min(1)
			.max(SUPABASE_MAX_DESTROY_IDS)
			.refine(distinct, { message: 'Name each stack once.' }),
		/** Comes back from the dialog's checkbox; bound into the token. */
		removeUploads: z.boolean(),
		/** Set by Clean up: refused unless it equals the current prune revision. */
		pruneRevision: countSchema.optional(),
		confirmationToken: confirmationTokenSchema.optional(),
	}),
	/**
	 * Destroy, then create again from the worktree: "Destroy and recreate…"
	 * (needs recreate) and "Destroy and start again…" (interrupted or failed).
	 */
	z.strictObject({
		...stackOperationBase,
		kind: z.literal('recreate'),
		confirmationToken: confirmationTokenSchema.optional(),
	}),
	z.strictObject({
		...stackOperationBase,
		kind: z.literal('set-studio'),
		enabled: z.boolean(),
		/** Required to enable. */
		confirmationToken: confirmationTokenSchema.optional(),
	}),
	z.strictObject({ ...stackOperationBase, kind: z.literal('follow-branch') }),
	z.strictObject({
		...stackOperationBase,
		kind: z.literal('open'),
		surface: z.enum(['mailpit', 'studio']),
	}),
	/** Main writes the clipboard; the receipt never carries the value. */
	z.strictObject({
		...stackOperationBase,
		kind: z.literal('copy'),
		what: z.enum([
			'api-url',
			'publishable-key',
			'psql-command',
			'app-env',
			'status-command',
			'inspect-command',
		]),
	}),
	z.strictObject({
		...stackOperationBase,
		kind: z.literal('reveal'),
		what: z.enum(['uploads', 'stack-folder', 'config', 'export']),
	}),
	z.strictObject({
		...operationBase,
		kind: z.literal('request.approve'),
		requestId: supabaseRequestIdSchema,
		/** Start-capacity requests: the stack to stop to make room. */
		stopStackId: supabaseStackIdSchema.optional(),
		/** Destroy requests: from the dialog's checkbox. */
		removeUploads: z.boolean().optional(),
		confirmationToken: confirmationTokenSchema.optional(),
	}),
	z.strictObject({
		...operationBase,
		kind: z.literal('request.deny'),
		requestId: supabaseRequestIdSchema,
	}),
	z
		.strictObject({
			...operationBase,
			kind: z.literal('set-enabled'),
			enabled: z.boolean(),
			/** Turn off while managed stacks run: from the dialog's buttons. */
			disposition: z.enum(['leave-running', 'stop-managed']).optional(),
			confirmationToken: confirmationTokenSchema.optional(),
		})
		.refine(
			(operation) => !operation.enabled || operation.disposition === undefined,
			{ message: 'Only turning off takes a disposition.' }
		),
	z.strictObject({
		...operationBase,
		kind: z.literal('update-policy'),
		patch: supabasePolicyPatchSchema,
		/** Required for trust-weakening changes. */
		confirmationToken: confirmationTokenSchema.optional(),
	}),
	z.strictObject({
		...operationBase,
		kind: z.literal('repository.recheck'),
		repositoryId: supabaseRepositoryIdSchema,
	}),
	z.strictObject({
		...operationBase,
		kind: z.literal('repository.set-mode'),
		repositoryId: supabaseRepositoryIdSchema,
		mode: z.enum(['auto', 'off']),
	}),
	z.strictObject({
		...operationBase,
		kind: z.literal('cancel-job'),
		jobId: supabaseJobIdSchema,
	}),
	/** Restart a lane's Metro so it picks up its stack's address. */
	z.strictObject({
		...operationBase,
		kind: z.literal('restart-metro'),
		laneId: laneIdSchema,
	}),
	/** Main shows a file dialog; the renderer never sends a path. */
	z.strictObject({
		...operationBase,
		kind: z.literal('choose-path'),
		field: z.enum(['supabase-home', 'ssl-cert']),
	}),
]);
export type SupabaseOperation = z.infer<typeof supabaseOperationSchema>;
export type SupabaseOperationKind = SupabaseOperation['kind'];

/** Every operation kind, in schema order: what a receipt's `kind` may be. */
export const SUPABASE_OPERATION_KINDS: readonly SupabaseOperationKind[] =
	Object.freeze(
		supabaseOperationSchema.options.map((option) => option.shape.kind.value)
	);

/** Operation kinds the main-owned native dialog may guard. */
export const SUPABASE_CONFIRMATION_KINDS = Object.freeze([
	'set-enabled',
	'stop',
	'destroy',
	'recreate',
	'reset',
	'set-studio',
	'update-policy',
	'request.approve',
] as const satisfies readonly SupabaseOperationKind[]);

/**
 * Whether this operation needs the native dialog and a one-time token:
 * destroy, clean up, reset, recreate, enabling Studio, stopping an external
 * stack, turning the feature on, turning it off while managed stacks run,
 * the trust-weakening policy changes, and approving destroy or reset
 * requests. Main decides; this mirrors it so the renderer knows to ask.
 */
export function supabaseConfirmationRequired(
	operation: SupabaseOperation,
	state: Pick<SupabaseState, 'stacks' | 'requests' | 'policy'>
): boolean {
	switch (operation.kind) {
		case 'set-enabled':
			return (
				operation.enabled ||
				state.stacks.some(
					(stack) =>
						(stack.origin === 'managed' || stack.origin === 'adopted') &&
						isLiveStackState(stack.state)
				)
			);
		case 'stop':
			return operation.stackIds.some(
				(id) =>
					state.stacks.find((stack) => stack.id === id)?.origin === 'external'
			);
		case 'destroy':
		case 'recreate':
		case 'reset':
			return true;
		case 'set-studio':
			return operation.enabled;
		case 'update-policy':
			return (
				supabasePolicyTrustChanges(operation.patch, state.policy).length > 0
			);
		case 'request.approve': {
			const request = state.requests.find(
				(candidate) => candidate.id === operation.requestId
			);
			return request?.kind !== 'start-capacity';
		}
		default:
			return false;
	}
}

/** Options the native dialog collected, returned with its token. */
const confirmationOptionsSchema = z.strictObject({
	removeUploads: z.boolean().optional(),
	disposition: z.enum(['leave-running', 'stop-managed']).optional(),
});

export const supabaseConfirmationResultSchema = z
	.strictObject({
		actionId: identifierSchema,
		required: z.boolean(),
		confirmed: z.boolean(),
		token: confirmationTokenSchema.optional(),
		expiresAt: timestampSchema.optional(),
		options: confirmationOptionsSchema.optional(),
		error: plainText(MAX_TEXT_LENGTH).optional(),
	})
	.refine(
		(result) =>
			result.token === undefined || (result.required && result.confirmed),
		{ message: 'Only a required, confirmed dialog issues a token.' }
	);
export type SupabaseConfirmationResult = z.infer<
	typeof supabaseConfirmationResultSchema
>;

/**
 * The operation a confirmed dialog makes: the uploads checkbox and the
 * turn-off button substituted in. Main binds the one-time token to exactly
 * this, and withSupabaseConfirmation adds the token on top.
 */
export function supabaseConfirmedOperation(
	operation: SupabaseOperation,
	options: NonNullable<SupabaseConfirmationResult['options']>
): SupabaseOperation {
	switch (operation.kind) {
		case 'destroy':
			return {
				...operation,
				removeUploads: options.removeUploads ?? operation.removeUploads,
			};
		case 'request.approve': {
			const removeUploads = options.removeUploads ?? operation.removeUploads;
			return {
				...operation,
				...(removeUploads === undefined ? {} : { removeUploads }),
			};
		}
		case 'set-enabled': {
			const disposition = options.disposition ?? operation.disposition;
			return {
				...operation,
				...(disposition === undefined || operation.enabled
					? {}
					: { disposition }),
			};
		}
		default:
			return operation;
	}
}

/**
 * Turns a confirmation into the operation to run: the same actionId, the
 * options the dialog chose (the uploads checkbox, the turn-off button), and
 * the token when one was required. Main's token is bound to exactly that.
 */
export function withSupabaseConfirmation(
	operation: SupabaseOperation,
	result: SupabaseConfirmationResult
):
	| Readonly<{ ok: true; operation: SupabaseOperation }>
	| Readonly<{ ok: false; error: string }> {
	if (result.actionId !== operation.actionId) {
		return {
			ok: false,
			error:
				'Native confirmation returned a mismatched Supabase action identifier.',
		};
	}
	if (!result.confirmed) {
		return { ok: false, error: result.error ?? 'Cancelled.' };
	}
	if (!result.required) return { ok: true, operation };
	if (!result.token) {
		return {
			ok: false,
			error: 'Native confirmation did not issue a valid Supabase token.',
		};
	}
	const token = result.token;
	const confirmed = supabaseConfirmedOperation(operation, result.options ?? {});
	switch (confirmed.kind) {
		case 'destroy':
		case 'request.approve':
		case 'set-enabled':
		case 'stop':
		case 'recreate':
		case 'reset':
		case 'set-studio':
		case 'update-policy':
			return {
				ok: true,
				operation: { ...confirmed, confirmationToken: token },
			};
		default:
			return {
				ok: false,
				error: 'This Supabase operation does not take a confirmation token.',
			};
	}
}

// ---------------------------------------------------------------------------
// Receipts

const supabaseLogRecordSchema = z.discriminatedUnion('type', [
	z.strictObject({
		type: z.literal('entry'),
		timestamp: plainText(64),
		source: z.enum(['history', 'live']),
		service: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
		instanceId: z.string().regex(/^[0-9A-Za-z-]{1,64}$/),
		stream: z.enum(['stdout', 'stderr']),
		/** Control-stripped, redacted, at most 2,000 characters. */
		line: plainText(MAX_LOG_LINE_LENGTH),
	}),
	z.strictObject({
		type: z.literal('marker'),
		timestamp: plainText(64),
		source: z.enum(['history', 'live']),
		service: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
		instanceId: z.string().regex(/^[0-9A-Za-z-]{1,64}$/),
		kind: z.enum(['launch', 'lost']),
		stream: z.enum(['stdout', 'stderr']).optional(),
		count: countSchema.optional(),
	}),
]);
export type SupabaseLogRecord = z.infer<typeof supabaseLogRecordSchema>;

const logsPayloadSchema = z
	.strictObject({
		records: z.array(supabaseLogRecordSchema).max(MAX_LOG_RECORDS),
		/** Older records were dropped to fit 64 KiB. */
		truncated: z.boolean(),
		bytes: bytesSchema,
		readAt: timestampSchema,
	})
	.refine(
		(logs) =>
			logs.records.reduce(
				(total, record) =>
					total + (record.type === 'entry' ? record.line.length : 0),
				0
			) <= SUPABASE_MAX_LOG_CHARACTERS,
		{ message: 'Log lines exceed 64 KiB.' }
	);
export type SupabaseLogsPayload = z.infer<typeof logsPayloadSchema>;

const statText = plainText(128).optional();
const migrationsPayloadSchema = z.union([
	z.strictObject({
		comparable: z.literal(true),
		state: z.enum(['up-to-date', 'pending', 'out-of-order', 'missing-local']),
		rows: z
			.array(
				z.strictObject({
					version: z.string().regex(/^[+-]?\d{0,32}$/),
					time: plainText(64),
					status: z.enum([
						'applied',
						'pending',
						'out-of-order',
						'missing-local',
					]),
				})
			)
			.max(MAX_MIGRATION_ROWS),
		/** Rows before truncation to the newest 500. */
		total: countSchema,
		applied: countSchema,
		pending: z
			.array(z.string().regex(/^[+-]?\d{0,32}$/))
			.max(MAX_MIGRATION_ROWS),
		outOfOrder: z
			.array(z.string().regex(/^[+-]?\d{0,32}$/))
			.max(MAX_MIGRATION_ROWS),
		missingLocal: z
			.array(z.string().regex(/^[+-]?\d{0,32}$/))
			.max(MAX_MIGRATION_ROWS),
	}),
	/** Not computable: the worktree is on another branch than the stack. */
	z.strictObject({ comparable: z.literal(false), reasonText: plainText(512) }),
]);
export type SupabaseMigrationsView = z.infer<typeof migrationsPayloadSchema>;

const databasePayloadSchema = z.strictObject({
	/** `db-url`: read through the DB_URL main holds in memory (moved branch). */
	target: z.enum(['local', 'db-url']),
	stats: z
		.strictObject({
			databaseSize: statText,
			totalIndexSize: statText,
			totalTableSize: statText,
			totalToastSize: statText,
			timeSinceStatsReset: statText,
			indexHitRate: statText,
			tableHitRate: statText,
			walSize: statText,
		})
		.optional(),
	topTables: z
		.array(
			z.strictObject({
				name: plainText(256),
				tableSize: statText,
				indexSize: statText,
				totalSize: statText,
				estimatedRowCount: statText,
				seqScans: statText,
			})
		)
		.max(MAX_TOP_TABLES),
	migrations: migrationsPayloadSchema.optional(),
	readAt: timestampSchema,
});
export type SupabaseDatabasePayload = z.infer<typeof databasePayloadSchema>;

export const supabaseOperationReceiptSchema = z
	.strictObject({
		actionId: identifierSchema,
		kind: z.enum(SUPABASE_OPERATION_KINDS),
		completed: z.boolean(),
		cancelled: z.boolean().optional(),
		error: supabaseErrorSchema.optional(),
		/** Long work continues as this job; poll the state for its outcome. */
		jobId: supabaseJobIdSchema.optional(),
		state: supabaseStateSchema.optional(),
		/** Main's outcome copy, e.g. which lane's Metro restarted. */
		message: plainText(MAX_TEXT_LENGTH).optional(),
		logs: logsPayloadSchema.optional(),
		database: databasePayloadSchema.optional(),
		copy: z
			.strictObject({
				copied: z.boolean(),
				what: z.enum([
					'api-url',
					'publishable-key',
					'psql-command',
					'app-env',
					'status-command',
					'inspect-command',
				]),
				/** Main clears the clipboard after this, if it still holds the copy. */
				clearsAt: timestampSchema.optional(),
			})
			.optional(),
		open: z
			.strictObject({
				opened: z.boolean(),
				surface: z.enum(['mailpit', 'studio']),
			})
			.optional(),
		reveal: z
			.strictObject({
				revealed: z.boolean(),
				what: z.enum(['uploads', 'stack-folder', 'config', 'export']),
			})
			.optional(),
		export: z
			.strictObject({
				content: z.enum(['schema', 'data']),
				bytes: bytesSchema.optional(),
				/** `reveal {what: 'export'}` can show the file in Finder. */
				revealable: z.boolean(),
			})
			.optional(),
	})
	.superRefine((receipt, context) => {
		const payloads = [
			['logs', 'read-logs'],
			['database', 'read-database'],
			['copy', 'copy'],
			['open', 'open'],
			['reveal', 'reveal'],
			['export', 'export'],
		] as const;
		for (const [field, kind] of payloads) {
			if (receipt[field] !== undefined && receipt.kind !== kind) {
				context.addIssue({
					code: 'custom',
					path: [field],
					message: `Only a ${kind} receipt carries ${field}.`,
				});
			}
		}
	});
export type SupabaseOperationReceipt = z.infer<
	typeof supabaseOperationReceiptSchema
>;

/**
 * How long main lets a copied key, psql command or app variables linger.
 */
export const SUPABASE_CLIPBOARD_CLEAR_MS = 60_000;

// ---------------------------------------------------------------------------
// Interest

export const SUPABASE_DETAIL_SECTIONS = [
	'overview',
	'services',
	'database',
	'logs',
	'connect',
	'danger',
] as const;

/**
 * What the tab shows, so main reads only that: status every 10 s for the
 * inspected stack, footprint and disk while visible. Interest never extends
 * an auto-stop clock. `hidden` is no interest at all.
 */
export const supabaseInterestSchema = z
	.strictObject({
		view: z.enum(['stacks', 'repositories', 'requests', 'settings', 'hidden']),
		inspectStackId: supabaseStackIdSchema.optional(),
		sections: z
			.array(z.enum(SUPABASE_DETAIL_SECTIONS))
			.max(SUPABASE_DETAIL_SECTIONS.length)
			.refine(distinct, { message: 'Name each section once.' }),
	})
	.refine(
		(interest) =>
			interest.view === 'stacks' ||
			(interest.inspectStackId === undefined && interest.sections.length === 0),
		{ message: 'Only the Stacks view inspects a stack.' }
	);
export type SupabaseInterest = z.infer<typeof supabaseInterestSchema>;

/**
 * No interest: what the runtime sends when the last consumer goes away.
 */
export const SUPABASE_NO_INTEREST: SupabaseInterest = Object.freeze({
	view: 'hidden',
	sections: [],
});

// ---------------------------------------------------------------------------
// Bridge

export type SupabaseBridge = {
	getSupabaseState: () => Promise<SupabaseState>;
	subscribeSupabaseState: (
		listener: (state: SupabaseState) => void
	) => () => void;
	runSupabaseOperation: (
		operation: SupabaseOperation
	) => Promise<SupabaseOperationReceipt>;
	requestSupabaseConfirmation: (
		operation: SupabaseOperation
	) => Promise<SupabaseConfirmationResult>;
	/** Fire and forget; the runtime debounces it by 60 ms. */
	setSupabaseInterest: (interest: SupabaseInterest) => void;
};

// ---------------------------------------------------------------------------
// Lanes

const LANE_BACKEND_REASONS = [
	/** The lane's policy is off, or its environment defaults to off. */
	'off',
	/** Local Supabase is turned off. */
	'disabled',
	/** No supabase/config.toml between the app and the worktree root. */
	'no-project',
	/** Observed only: the flag, CLI or config isn't managed. */
	'not-managed',
	'capacity',
	'git-busy',
	'ports-pinned',
	'lan-exposed',
	'cli-mismatch',
	'branch-moved',
	'dotenv-shadowed',
	'timeout',
	'failed',
] as const;

export const LANE_BACKEND_WARNINGS = [
	'previous-session-on-simulator',
	'shared-default-keys',
	'cli-untested',
	'composition-drift',
	'pinned-by-environment',
	'dotenv-shadowed',
	'memory-warning',
] as const;

/**
 * A lane's backend on the lane wire (receipts and lane state, never
 * lanes.json): names only, never values.
 */
export const laneBackendSummarySchema = z.strictObject({
	policy: z.enum(['auto', 'off', 'required']),
	status: z.enum([
		'ready',
		'starting',
		'stopped',
		'skipped',
		'failed',
		'refused',
		'stale',
		'shadowed',
		'blocked',
	]),
	reason: z.enum(LANE_BACKEND_REASONS).optional(),
	stackId: supabaseStackIdSchema.optional(),
	apiUrl: loopbackHttpUrlSchema.optional(),
	appEnvNames: z.array(supabaseAppEnvNameSchema).max(MAX_APP_ENV),
	reasonText: plainText(MAX_TEXT_LENGTH).optional(),
	warnings: z
		.array(z.enum(LANE_BACKEND_WARNINGS))
		.max(LANE_BACKEND_WARNINGS.length)
		.refine(distinct, { message: 'Warnings must be distinct.' }),
	/** The job a late attach waits on. */
	jobId: supabaseJobIdSchema.optional(),
	/** The dev-client launch waits for the late attach. */
	launch: z.literal('deferred').optional(),
	metro: z.enum(['restarted', 'unchanged', 'needs-restart']).optional(),
});
export type LaneBackendSummary = z.infer<typeof laneBackendSummarySchema>;

export type LaneBackendChip = {
	label: string;
	tone: 'success' | 'warning' | 'danger';
};

/**
 * The lane-relative chip in Lanes, Fleet and Agents: `db :21734` when the
 * lane has its database, amber when it has none, red for a refused LAN
 * stack. Hidden (undefined) when the feature or the lane's policy is off.
 */
export function laneBackendChip(
	summary: LaneBackendSummary | undefined
): LaneBackendChip | undefined {
	if (!summary || summary.policy === 'off') return undefined;
	switch (summary.status) {
		case 'ready': {
			const port = summary.apiUrl ? new URL(summary.apiUrl).port : '';
			return { label: port ? `db :${port}` : 'db ready', tone: 'success' };
		}
		case 'starting':
			return { label: 'db starting', tone: 'warning' };
		case 'stopped':
			return { label: 'db stopped', tone: 'warning' };
		case 'stale':
			return { label: 'db stale', tone: 'warning' };
		case 'shadowed':
			return { label: 'db shadowed', tone: 'warning' };
		case 'blocked':
			return {
				label:
					summary.reason === 'ports-pinned' || summary.reason === undefined
						? 'db blocked · ports pinned'
						: 'db blocked',
				tone: 'warning',
			};
		case 'skipped':
			if (
				summary.reason === 'off' ||
				summary.reason === 'disabled' ||
				summary.reason === 'no-project'
			) {
				return undefined;
			}
			return {
				label:
					summary.reason === 'capacity'
						? 'db skipped · capacity'
						: 'db skipped',
				tone: 'warning',
			};
		case 'refused':
			return summary.reason === 'lan-exposed' || summary.reason === undefined
				? { label: 'db refused · LAN', tone: 'danger' }
				: { label: 'db refused', tone: 'danger' };
		case 'failed':
			return { label: 'db failed', tone: 'warning' };
	}
}

/**
 * A lane worktree's Supabase project, as main reports it on the lane wire
 * (never in lanes.json), for the start form's picker and Backend select.
 */
export const laneWorktreeSupabaseSchema = z.strictObject({
	/** `none`: no supabase/config.toml between the app and the worktree root. */
	project: z.enum(['managed', 'observed', 'none']),
	/** Why it is only observed, in main's words. */
	reasonText: plainText(512).optional(),
	/** A pinned listener port in this worktree's config. */
	portsPinned: z.boolean().optional(),
});
export type LaneWorktreeSupabase = z.infer<typeof laneWorktreeSupabaseSchema>;

/**
 * The worktree picker suffix: `· Supabase`, `· Supabase (ports pinned)` or
 * `· Supabase (needs opt-in)`; nothing without a project or while off.
 */
export function laneWorktreeSupabaseSuffix(
	worktree: LaneWorktreeSupabase | undefined,
	featureEnabled: boolean
): string | undefined {
	if (!featureEnabled || !worktree || worktree.project === 'none') {
		return undefined;
	}
	if (worktree.portsPinned === true) return '· Supabase (ports pinned)';
	return worktree.project === 'managed'
		? '· Supabase'
		: '· Supabase (needs opt-in)';
}

/**
 * Whether the start form's Backend select may offer Auto or Required for a
 * worktree; Off is always available. The reason is visible text.
 */
export function laneBackendSelectAvailability(
	worktree: LaneWorktreeSupabase | undefined,
	state: Pick<SupabaseState, 'feature' | 'availability'>
): SupabaseAvailability {
	if (!state.feature.enabled) {
		return {
			allowed: false,
			check: 'off',
			reason: 'Turn on local Supabase in the Supabase tab first.',
		};
	}
	if (!state.availability.platform.supported) {
		return {
			allowed: false,
			check: 'platform',
			reason: SUPABASE_REASONS.platform,
		};
	}
	if (!worktree || worktree.project === 'none') {
		return {
			allowed: false,
			check: 'mode',
			reason: 'This worktree has no Supabase project.',
		};
	}
	if (worktree.project === 'observed') {
		const reason = worktree.reasonText?.trim().replace(/\.$/, '');
		return {
			allowed: false,
			check: 'mode',
			reason: `Observed only: ${reason || 'RN Devtools does not manage this worktree'}.`,
		};
	}
	return { allowed: true };
}

/**
 * The Backend a lane starts with when the form or the agent names none: the
 * policy's lane default for its environment, else off. Required is only ever
 * a per-start choice.
 */
export function laneDefaultBackend(
	policy: Pick<SupabasePolicy, 'laneDefaults'>,
	environmentId: string
): 'auto' | 'off' {
	return (
		policy.laneDefaults.find((entry) => entry.environmentId === environmentId)
			?.backend ?? 'off'
	);
}

// ---------------------------------------------------------------------------
// Agent surface (rndevtools supabase --operation …, MCP tool `supabase`)

/**
 * `supabase up` waits this long by default before returning a job.
 */
export const SUPABASE_AGENT_DEFAULT_WAIT_MS = 30_000;
export const SUPABASE_AGENT_MAX_WAIT_MS = 45_000;
/** `lane up` waits at most this long past Metro's spawn for a cold backend. */
export const SUPABASE_LANE_WAIT_MS = 15_000;

/**
 * The `--operation` values of `rndevtools supabase` and the MCP tool
 * `supabase`, for the agent CLI schema.
 */
export const SUPABASE_AGENT_OPERATIONS = [
	'up',
	'down',
	'ls',
	'status',
	'env',
	'reset',
	'log',
	'destroy',
] as const satisfies readonly SupabaseAgentOperation['operation'][];

/**
 * A worktree path, or a stack id (8-64 hex; a prefix must be unique).
 */
const supabaseAgentTargetSchema = z.union([
	z.strictObject({ worktreePath: absolutePathSchema }),
	z.strictObject({ stackId: z.string().regex(/^[0-9a-f]{8,64}$/) }),
]);

/**
 * What an agent asked for, after the TS agent CLI layer parsed the command.
 * The agent's identity comes from the request envelope, never from here.
 * `destroy` only files a request for the user.
 */
export const supabaseAgentOperationSchema = z.discriminatedUnion('operation', [
	z.strictObject({
		operation: z.literal('up'),
		target: supabaseAgentTargetSchema,
		waitMs: z.number().int().min(0).max(SUPABASE_AGENT_MAX_WAIT_MS),
	}),
	z.strictObject({
		operation: z.literal('down'),
		target: supabaseAgentTargetSchema,
	}),
	z.strictObject({
		operation: z.literal('ls'),
		worktreePath: absolutePathSchema.optional(),
	}),
	z.strictObject({
		operation: z.literal('status'),
		target: supabaseAgentTargetSchema,
	}),
	z.strictObject({
		operation: z.literal('env'),
		target: supabaseAgentTargetSchema,
	}),
	z.strictObject({
		operation: z.literal('reset'),
		target: supabaseAgentTargetSchema,
		seed: z.boolean(),
		/** Shown on the request card when another session holds the stack. */
		note: z
			.string()
			.max(MAX_NOTE_LENGTH * 4)
			.optional(),
	}),
	z.strictObject({
		operation: z.literal('log'),
		target: supabaseAgentTargetSchema,
		services: z
			.array(logServiceSchema)
			.min(1)
			.max(16)
			.refine(distinct, { message: 'Name each service once.' })
			.optional(),
		tail: z.number().int().min(0).max(1_000),
		since: logSinceSchema.optional(),
	}),
	z.strictObject({
		operation: z.literal('destroy'),
		target: supabaseAgentTargetSchema,
		/** Free text; main sanitizes it and shows it only on the request card. */
		note: z
			.string()
			.max(MAX_NOTE_LENGTH * 4)
			.optional(),
	}),
]);
export type SupabaseAgentOperation = z.infer<
	typeof supabaseAgentOperationSchema
>;

/**
 * `supabase log` reads this many lines by default.
 */
const SUPABASE_AGENT_DEFAULT_LOG_TAIL = 200;

/** The flat fields of a parsed `rndevtools supabase` command. */
export type SupabaseAgentCommandFields = Readonly<{
	operation: SupabaseAgentOperation['operation'];
	worktreePath?: string | undefined;
	stackId?: string | undefined;
	waitMs?: number | undefined;
	seed?: boolean | undefined;
	services?: readonly string[] | undefined;
	tail?: number | undefined;
	since?: string | undefined;
	note?: string | undefined;
}>;

/**
 * Builds the semantic operation from a parsed command, applying the defaults
 * (wait 30 s, seed on, 200 log lines) and the target rules: `ls` takes at
 * most a worktree path; every other operation exactly one of a worktree path
 * or a stack id. The message is agent-facing.
 */
export function supabaseAgentOperationFromCommand(
	command: SupabaseAgentCommandFields
):
	| Readonly<{ ok: true; operation: SupabaseAgentOperation }>
	| Readonly<{ ok: false; message: string }> {
	const { operation } = command;
	let candidate: unknown;
	if (operation === 'ls') {
		if (command.stackId !== undefined) {
			return { ok: false, message: 'ls takes at most a worktree path.' };
		}
		candidate = {
			operation,
			...(command.worktreePath === undefined
				? {}
				: { worktreePath: command.worktreePath }),
		};
	} else {
		if (
			(command.worktreePath === undefined) ===
			(command.stackId === undefined)
		) {
			return {
				ok: false,
				message: `${operation} takes exactly one of a worktree path or a stack id.`,
			};
		}
		const target =
			command.worktreePath === undefined
				? { stackId: command.stackId }
				: { worktreePath: command.worktreePath };
		switch (operation) {
			case 'up':
				candidate = {
					operation,
					target,
					waitMs: command.waitMs ?? SUPABASE_AGENT_DEFAULT_WAIT_MS,
				};
				break;
			case 'reset':
				candidate = {
					operation,
					target,
					seed: command.seed ?? true,
					...(command.note === undefined ? {} : { note: command.note }),
				};
				break;
			case 'log':
				candidate = {
					operation,
					target,
					tail: command.tail ?? SUPABASE_AGENT_DEFAULT_LOG_TAIL,
					...(command.services === undefined
						? {}
						: { services: [...command.services] }),
					...(command.since === undefined ? {} : { since: command.since }),
				};
				break;
			case 'destroy':
				candidate = {
					operation,
					target,
					...(command.note === undefined ? {} : { note: command.note }),
				};
				break;
			default:
				candidate = { operation, target };
		}
	}
	const parsed = supabaseAgentOperationSchema.safeParse(candidate);
	if (parsed.success) return { ok: true, operation: parsed.data };
	const [issue] = parsed.error.issues;
	const field = issue?.path.join('.') || operation;
	return { ok: false, message: `Invalid ${field} for supabase ${operation}.` };
}

const agentStackSchema = z.strictObject({
	id: supabaseStackIdSchema,
	status: z.enum([
		'ready',
		'starting',
		'stopping',
		'stopped',
		'not-created',
		'never-started',
		'failed',
		'unhealthy',
		'partial',
		'interrupted',
		'needs-recreate',
		'unreadable',
		'unknown',
	]),
	origin: z.enum(['managed', 'adopted', 'external', 'expected']),
	mode: modeValueSchema,
	runtime: runtimeSchema,
	exposure: exposureVerdictSchema,
	branchContext: branchContextSchema.optional(),
	worktreePath: absolutePathSchema.optional(),
	projectRoot: absolutePathSchema.optional(),
	/** Ports only; URLs and keys come from `env`. */
	apiPort: portSchema.optional(),
	dbPort: portSchema.optional(),
	laneIds: z.array(laneIdSchema).max(MAX_STACK_LANES),
	holders: z
		.array(
			z.strictObject({
				holder: z.enum(['lane', 'session', 'worktree', 'operator']),
				agent: z
					.strictObject({ kind: agentKindSchema, sessionId: sessionIdSchema })
					.optional(),
				live: z.boolean(),
			})
		)
		.max(MAX_STACK_HOLDS),
	/** The calling session holds it, or created it. */
	yours: z.boolean(),
	cli: z
		.strictObject({
			version: plainText(64).optional(),
			gate: cliGateSchema,
			run: plainText(64).optional(),
		})
		.optional(),
	reasonText: plainText(512).optional(),
});
export type SupabaseAgentStack = z.infer<typeof agentStackSchema>;

/**
 * The public env an agent may read. A strict object, so SECRET_KEY,
 * SERVICE_ROLE_KEY, DB_URL, MCP_URL and the S3 keys can never be added.
 */
export const supabaseAgentEnvSchema = z.strictObject({
	API_URL: loopbackHttpUrlSchema,
	REST_URL: loopbackHttpUrlSchema.optional(),
	FUNCTIONS_URL: loopbackHttpUrlSchema.optional(),
	MAILPIT_URL: loopbackHttpUrlSchema.optional(),
	PUBLISHABLE_KEY: z
		.string()
		.regex(/^sb_publishable_[A-Za-z0-9_-]{8,256}$/)
		.optional(),
	ANON_KEY: z
		.string()
		.max(4_096)
		.regex(/^eyJ[\w-]+\.[\w-]+\.[\w-]*$/)
		.optional(),
});
export type SupabaseAgentEnv = z.infer<typeof supabaseAgentEnvSchema>;

const agentNextSchema = plainText(MAX_TEXT_LENGTH);

/**
 * Results returned to agents. URLs and the publishable and anon keys appear
 * only in the `env` result; secret keys and DB_URL never appear at all.
 */
export const supabaseAgentResultSchema = z.discriminatedUnion('operation', [
	z.strictObject({
		operation: z.literal('up'),
		stack: agentStackSchema,
		/** The names Metro gets for this worktree's lanes. */
		appEnv: z.array(supabaseAppEnvNameSchema).max(MAX_APP_ENV),
		metro: z.enum(['restarted', 'unchanged', 'no-lane', 'pending']),
		cli: z
			.strictObject({
				run: plainText(64),
				workdir: absolutePathSchema,
				version: plainText(64),
			})
			.optional(),
		/** Still starting: `wait --condition job --job-id <jobId>`. */
		jobId: supabaseJobIdSchema.optional(),
		next: agentNextSchema,
		warnings: z.array(z.enum(LANE_BACKEND_WARNINGS)).max(8),
	}),
	z.strictObject({
		operation: z.literal('down'),
		stackId: supabaseStackIdSchema,
		released: z.boolean(),
		stopping: z.boolean(),
		/** Who else keeps it running. */
		keptBy: z.array(plainText(256)).max(16),
		next: agentNextSchema,
	}),
	z.strictObject({
		operation: z.literal('ls'),
		stacks: z.array(agentStackSchema).max(MAX_STACKS),
	}),
	z.strictObject({
		operation: z.literal('status'),
		stack: agentStackSchema,
		services: z
			.array(
				z.strictObject({
					service: serviceKindSchema,
					state: memberStateSchema,
					health: healthSchema.nullable(),
				})
			)
			.max(32),
		checkedAt: timestampSchema,
		next: agentNextSchema.optional(),
	}),
	z.strictObject({
		operation: z.literal('env'),
		stackId: supabaseStackIdSchema,
		env: supabaseAgentEnvSchema,
	}),
	z.strictObject({
		operation: z.literal('reset'),
		stackId: supabaseStackIdSchema,
		/** `requested`: someone else holds it, so the user decides. */
		status: z.enum(['complete', 'running', 'requested']),
		seed: z.boolean(),
		jobId: supabaseJobIdSchema.optional(),
		requestId: supabaseRequestIdSchema.optional(),
		next: agentNextSchema,
	}),
	z.strictObject({
		operation: z.literal('log'),
		stackId: supabaseStackIdSchema,
		records: z.array(supabaseLogRecordSchema).max(MAX_LOG_RECORDS),
		truncated: z.boolean(),
	}),
	z.strictObject({
		operation: z.literal('destroy'),
		stackId: supabaseStackIdSchema,
		requestId: supabaseRequestIdSchema,
		status: z.literal('pending'),
		expiresAt: timestampSchema,
		next: agentNextSchema,
	}),
]);
export type SupabaseAgentResult = z.infer<typeof supabaseAgentResultSchema>;

/**
 * Typed agent errors; the recovery names the next call.
 */
export const SUPABASE_AGENT_ERROR_CODES = [
	'supabase_disabled',
	'supabase_unsupported',
	'cli_unverified',
	'cli_missing',
	'stack_flag_missing',
	'config_conflict',
	'ports_pinned',
	'container_runtime',
	'supabase_capacity',
	'supabase_held',
	'cli_mismatch',
	'job_lost',
	'branch_moved',
	'git_busy',
	'not_found',
	'needs_recreate',
	'supabase_failed',
] as const;
export type SupabaseAgentErrorCode =
	(typeof SUPABASE_AGENT_ERROR_CODES)[number];

/**
 * Recovery text for an agent error. `runner` is the worktree's runner from
 * main (for example `pnpm exec supabase`); agents fall back to starting
 * their own native stack whenever RN Devtools is not managing a worktree.
 */
export function supabaseAgentRecovery(
	code: SupabaseAgentErrorCode,
	runner = 'supabase'
): string {
	const selfStart = `RN Devtools is not managing this worktree. Start it yourself from the worktree with \`${runner} start --runtime native\` (never without --runtime native).`;
	switch (code) {
		case 'supabase_disabled':
		case 'supabase_unsupported':
		case 'cli_unverified':
			return selfStart;
		case 'cli_missing':
			return 'Install dependencies in this worktree; the repository should pin supabase as an exact devDependency. Do not use npx or dlx versions.';
		case 'stack_flag_missing':
		case 'config_conflict':
			return 'Ask the user to commit `[experimental] stack = true` in supabase/config.toml (and to remove supabase/config.json). Do not edit it yourself.';
		case 'ports_pinned':
			return 'Ask the user to delete the listed port settings. Never stop the other stack.';
		case 'container_runtime':
			return 'Ask the user to destroy that stack in RN Devtools › Supabase, then call supabase with operation up.';
		case 'supabase_capacity':
			return 'Release stacks you no longer need (supabase with operation down), or ask the user to raise the limit in RN Devtools › Supabase › Settings.';
		case 'supabase_held':
			return 'Another session holds this stack, so only the user can change it. Ask the user.';
		case 'cli_mismatch':
			return "Call supabase with operation up: RN Devtools restarts the stack with this worktree's CLI and keeps its data. Never destroy it to fix this.";
		case 'job_lost':
			return 'Call supabase with operation up again; it is idempotent.';
		case 'branch_moved':
			return "The worktree moved to another branch. Call supabase with operation up to get that branch's stack.";
		case 'git_busy':
			return 'A rebase or merge is in progress in this worktree. Finish it, then call supabase with operation up.';
		case 'not_found':
			return 'Call supabase with operation ls to see the stacks on this Mac, then retry with a worktree path.';
		case 'needs_recreate':
			return 'If your change caused it, revert that setting and call supabase with operation up again; the stack keeps its data. Otherwise ask the user to recreate the stack in RN Devtools › Supabase; that deletes its local database.';
		case 'supabase_failed':
			return 'Retry once. If it keeps failing, read the stack logs with supabase operation log.';
	}
}

const activityStatsSchema = z.strictObject({
	starts: countSchema,
	failures: countSchema,
	failuresByCode: z.record(z.string().max(64), countSchema),
	p50Ms: durationSchema.optional(),
	p95Ms: durationSchema.optional(),
});
export type SupabaseActivityStats = z.infer<typeof activityStatsSchema>;

const START_JOB_KINDS: ReadonlySet<SupabaseJobKind> = new Set([
	'create',
	'resume',
	'recreate',
]);

function percentile(sorted: readonly number[], fraction: number): number {
	const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
	return sorted[Math.min(index, sorted.length - 1)] ?? 0;
}

/**
 * Local-only stats for doctor and the kill criteria: starts, failures by
 * code, and warm-start p50/p95 (cold-cache starts excluded).
 */
export function supabaseActivityStats(
	activity: readonly SupabaseActivityEntry[]
): SupabaseActivityStats {
	const starts = activity.filter((entry) => START_JOB_KINDS.has(entry.kind));
	const failures = activity.filter((entry) => entry.outcome === 'failed');
	const failuresByCode: Record<string, number> = {};
	for (const entry of failures) {
		const code = entry.errorCode ?? 'failed';
		failuresByCode[code] = (failuresByCode[code] ?? 0) + 1;
	}
	const warm = starts
		.filter((entry) => entry.outcome === 'complete' && entry.coldCache !== true)
		.map((entry) => entry.durationMs)
		.sort((left, right) => left - right);
	return {
		starts: starts.length,
		failures: failures.length,
		failuresByCode,
		...(warm.length > 0
			? { p50Ms: percentile(warm, 0.5), p95Ms: percentile(warm, 0.95) }
			: {}),
	};
}

/** What `doctor` reports about local Supabase. */
export const supabaseDoctorInfoSchema = z.strictObject({
	enabled: z.boolean(),
	capability: z.enum([
		'ready',
		'needs-setup',
		'unsupported',
		'off',
		'quarantined',
	]),
	platform: platformSchema,
	repositories: z
		.array(
			z.strictObject({
				label: labelSchema,
				mode: z.enum(['managed', 'observed', 'off', 'none']),
				cli: z.strictObject({
					version: plainText(64).optional(),
					gate: cliGateSchema,
				}),
			})
		)
		.max(MAX_REPOSITORIES),
	running: countSchema,
	cap: z.number().int().min(1).max(24),
	sysv: z.strictObject({ used: countSchema, limit: countSchema }).nullable(),
	containerEngine: z.strictObject({
		docker: z.enum(['found', 'absent']),
		podman: z.enum(['found', 'absent']),
	}),
	stats: activityStatsSchema,
	warnings: z.array(plainText(512)).max(16),
});
export type SupabaseDoctorInfo = z.infer<typeof supabaseDoctorInfoSchema>;

// ---------------------------------------------------------------------------
// Display helpers

/** `feat-x` from `refs/heads/feat-x`; `detached HEAD`; other refs as they are. */
export function supabaseBranchLabel(
	ref: string | undefined
): string | undefined {
	if (ref === undefined || ref === '') return undefined;
	if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
	if (ref === 'detached') return 'detached HEAD';
	if (ref === 'ordinary-workspace') return 'no git branch';
	return ref;
}

/** A row's title: its branch, or a truncated id when nothing else is known. */
export function supabaseStackTitle(
	stack: Pick<SupabaseStackSummary, 'id' | 'branchContext'>
): string {
	return supabaseBranchLabel(stack.branchContext) ?? `${stack.id.slice(0, 8)}…`;
}

const AGENT_KIND_LABELS = { claude: 'Claude', codex: 'Codex', other: 'Agent' };

/** `Claude 9b1e2c00`, or `Codex · by worktree` for a shared MCP identity. */
export function supabaseAgentLabel(agent: {
	kind: 'claude' | 'codex' | 'other';
	sessionId: string;
	synthetic?: boolean;
}): string {
	const kind = AGENT_KIND_LABELS[agent.kind];
	return agent.synthetic === true || agent.sessionId.startsWith('mcp-')
		? `${kind} · by worktree`
		: `${kind} ${agent.sessionId.slice(0, 8)}`;
}

/** Sizes in KB, MB and GB the way the tab prints them; `—` when unknown. */
export function formatSupabaseSize(bytes: number | undefined): string {
	if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
	if (bytes < 1_024) return `${Math.round(bytes)} B`;
	if (bytes < 1_024 ** 2) return `${Math.round(bytes / 1_024)} KB`;
	if (bytes < 1_024 ** 3) {
		const megabytes = bytes / 1_024 ** 2;
		return megabytes < 10
			? `${megabytes.toFixed(1)} MB`
			: `${Math.round(megabytes)} MB`;
	}
	return `${(bytes / 1_024 ** 3).toFixed(1)} GB`;
}

/** `Apple silicon · macOS 15.1`, or `Intel · macOS 13.6`. */
export function supabasePlatformLabel(
	platform: Pick<
		SupabaseState['availability']['platform'],
		'arch' | 'macosVersion'
	>
): string {
	const arch =
		platform.arch === 'arm64'
			? 'Apple silicon'
			: platform.arch === 'x64'
				? 'Intel'
				: platform.arch || 'Unknown Mac';
	return platform.macosVersion
		? `${arch} · macOS ${platform.macosVersion}`
		: arch;
}

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

/** States in which a stack still holds processes. */
export function isLiveStackState(state: SupabaseStackState): boolean {
	return (
		state === 'running' ||
		state === 'starting' ||
		state === 'partial' ||
		state === 'unhealthy' ||
		state === 'stopping'
	);
}

/** States in which a stack has a database to talk to. */
export function isSupabaseStackRunning(
	stack: Pick<SupabaseStackSummary, 'state'>
): boolean {
	return (
		stack.state === 'running' ||
		stack.state === 'partial' ||
		stack.state === 'unhealthy'
	);
}

/**
 * Docker and Podman stacks listen on every interface.
 */
export function isSupabaseStackLanExposed(
	stack: Pick<SupabaseStackSummary, 'runtime' | 'exposure' | 'flags'>
): boolean {
	return (
		stack.runtime === 'docker' ||
		stack.runtime === 'podman' ||
		stack.exposure.verdict === 'lan-exposed' ||
		stack.flags.includes('lan-exposed')
	);
}

/** Whether the worktree's HEAD is on the stack's branch. Unknown counts as yes. */
export function supabaseHeadMatches(
	stack: Pick<SupabaseStackSummary, 'branchContext' | 'currentHead'>
): boolean {
	return (
		stack.currentHead === undefined ||
		stack.branchContext === undefined ||
		stack.currentHead.ref === stack.branchContext
	);
}

function activeJobFor(
	stack: Pick<SupabaseStackSummary, 'id' | 'activeJobId'>,
	jobs: readonly SupabaseJob[] | undefined
): SupabaseJob | undefined {
	if (!jobs) return undefined;
	const named =
		stack.activeJobId === undefined
			? undefined
			: jobs.find((job) => job.id === stack.activeJobId);
	if (named && isActiveSupabaseJob(named)) return named;
	return jobs.find(
		(job) => isActiveSupabaseJob(job) && job.stackIds.includes(stack.id)
	);
}

// ---------------------------------------------------------------------------
// Status model A: absolute stack status

export type SupabaseTone =
	| 'info'
	| 'success'
	| 'warning'
	| 'danger'
	| 'default';
export type SupabaseStatusIcon =
	| 'loader-circle'
	| 'status-dot'
	| 'status-dot-moon'
	| 'circle-x'
	| 'circle-alert'
	| 'square'
	| 'server-off'
	| 'git-compare-arrows'
	| 'circle-dashed'
	| 'shield-alert'
	| 'hollow-dot'
	| 'refresh-cw';

type SupabaseStatusKey =
	| 'in-flight'
	| 'queued'
	| 'lan-exposed'
	| 'exposure-unknown'
	| 'failed'
	| 'interrupted'
	| 'needs-recreate'
	| 'unhealthy'
	| 'unreadable'
	| 'cli-mismatch'
	| 'not-responding'
	| 'partial'
	| 'starting-outside'
	| 'stopping-outside'
	| 'running'
	| 'running-idle'
	| 'stopped-outside'
	| 'stopped'
	| 'never-started'
	| 'not-created'
	| 'checking';

export type SupabaseStackStatus = {
	key: SupabaseStatusKey;
	label: string;
	tone: SupabaseTone;
	icon: SupabaseStatusIcon;
	explanation: string;
};

const JOB_LABELS: Readonly<Record<SupabaseJobKind, string>> = {
	create: 'Creating…',
	resume: 'Starting…',
	stop: 'Stopping…',
	restart: 'Restarting…',
	'stop-and-start': 'Restarting…',
	destroy: 'Destroying…',
	recreate: 'Recreating…',
	reset: 'Resetting…',
	migrate: 'Migrating…',
	'seed-buckets': 'Seeding…',
	export: 'Exporting…',
	prepare: 'Downloading…',
	studio: 'Restarting…',
	disable: 'Stopping…',
};

/** The in-flight verb for a job, as rows, pills and the activity list read it. */
export function supabaseJobLabel(
	job: Pick<SupabaseJob, 'kind' | 'status'>
): string {
	return job.status === 'queued' ? 'Queued' : JOB_LABELS[job.kind];
}

function status(
	key: SupabaseStatusKey,
	label: string,
	tone: SupabaseTone,
	icon: SupabaseStatusIcon,
	explanation: string
): SupabaseStackStatus {
	return { key, label, tone, icon, explanation };
}

export type SupabaseStatusContext = {
	/** The state's jobs; an active one on this stack wins over everything. */
	jobs?: readonly SupabaseJob[];
};

/**
 * The absolute status of a stack, used by rows, the pill and the metrics.
 * Highest first: an in-flight job, LAN-exposed or exposure unknown, failed /
 * interrupted / needs recreate, unhealthy, unreadable, CLI mismatch, not
 * responding, partly stopped, running (or starting/stopping outside), stopped
 * outside, stopped, never started, not created, checking. Running needs a
 * status read: `stack list` saying the owner is reachable is never enough.
 */
export function stackStatus(
	stack: SupabaseStackSummary,
	context: SupabaseStatusContext = {}
): SupabaseStackStatus {
	const job = activeJobFor(stack, context.jobs);
	if (job) {
		return status(
			job.status === 'queued' ? 'queued' : 'in-flight',
			supabaseJobLabel(job),
			'info',
			'loader-circle',
			job.status === 'queued'
				? 'Queued · new stacks start one at a time.'
				: (job.latestLine ??
						'The operation is in flight; health keeps its last value.')
		);
	}
	if (isSupabaseStackLanExposed(stack)) {
		return status(
			'lan-exposed',
			'LAN-exposed',
			'danger',
			'shield-alert',
			`It runs on ${stack.runtime === 'podman' ? 'Podman' : 'Docker'} and listens on every interface. RN Devtools stops it once and never attaches it.`
		);
	}
	if (
		stack.exposure.verdict === 'unknown' ||
		stack.flags.includes('exposure-unknown')
	) {
		return status(
			'exposure-unknown',
			'Exposure unknown',
			'danger',
			'shield-alert',
			"Couldn't verify it listens only on this Mac, so it was stopped. Resume checks again."
		);
	}
	switch (stack.state) {
		case 'failed':
			return status(
				'failed',
				'Failed to start',
				'danger',
				'circle-x',
				'The first start failed and left an empty stack.'
			);
		case 'interrupted':
			return status(
				'interrupted',
				'Interrupted',
				'danger',
				'circle-x',
				"A first start stopped midway; it can't be resumed. Destroy and start again."
			);
		case 'needs-recreate':
			return status(
				'needs-recreate',
				'Needs recreate',
				'danger',
				'circle-x',
				supabaseRevertKeepsStack(stack.recreateChanges)
					? 'The saved stack cannot adopt this configuration. Revert the change to keep it, or recreate it.'
					: 'The saved stack cannot adopt this configuration. Recreate it.'
			);
		default:
			break;
	}
	if (
		stack.state === 'unhealthy' ||
		(stack.state === 'running' && stack.health.unhealthy > 0)
	) {
		const names = stack.health.unhealthyServices;
		return status(
			'unhealthy',
			'Unhealthy',
			'danger',
			'circle-x',
			names.length > 0
				? `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} unhealthy. Restart services.`
				: 'A service is unhealthy. Restart services.'
		);
	}
	if (stack.state === 'unreadable') {
		return status(
			'unreadable',
			'Unreadable',
			'warning',
			'circle-alert',
			"This CLI can't decode its state. It is never destroyed here."
		);
	}
	if (stack.cli.mismatch) {
		return status(
			'cli-mismatch',
			'CLI mismatch',
			'warning',
			'git-compare-arrows',
			"Stop, destroy and logs work; database tools don't."
		);
	}
	if (stack.ownerLiveness === 'not-responding') {
		return status(
			'not-responding',
			'Not responding',
			'warning',
			'server-off',
			'Its owner runs but does not answer. Stop asks it to shut down.'
		);
	}
	if (stack.state === 'partial') {
		return status(
			'partial',
			'Partly stopped',
			'warning',
			'circle-alert',
			'Some services stopped outside the idle cycle. Stop and start; data is kept.'
		);
	}
	if (stack.state === 'starting' || stack.ownerLiveness === 'starting') {
		return status(
			'starting-outside',
			'Starting (outside)',
			'info',
			'loader-circle',
			'Someone else is starting it.'
		);
	}
	if (stack.state === 'stopping') {
		return status(
			'stopping-outside',
			'Stopping (outside)',
			'info',
			'loader-circle',
			'Someone else is stopping it.'
		);
	}
	if (stack.state === 'running') {
		if (stack.lifecycle !== 'running' || stack.ownerLiveness !== 'reachable') {
			return status(
				'checking',
				'Checking…',
				'default',
				'refresh-cw',
				'Re-reading.'
			);
		}
		return stack.health.sleeping > 0
			? status(
					'running-idle',
					'Running · idle',
					'success',
					'status-dot-moon',
					'Other services start on first request.'
				)
			: status(
					'running',
					'Running',
					'success',
					'status-dot',
					'All services awake.'
				);
	}
	if (stack.state === 'stopped') {
		return stack.flags.includes('stopped-outside')
			? status(
					'stopped-outside',
					'Stopped outside',
					'warning',
					'square',
					'It was stopped outside RN Devtools while something still holds it.'
				)
			: status(
					'stopped',
					'Stopped',
					'default',
					'square',
					'Data and ports are kept; it resumes in about 1 s.'
				);
	}
	if (stack.state === 'never-started') {
		return status(
			'never-started',
			'Never started',
			'default',
			'circle-dashed',
			'Prepared, but never started.'
		);
	}
	if (stack.state === 'not-created') {
		return status(
			'not-created',
			'Not created',
			'default',
			'hollow-dot',
			'Start creates it (about 5 s).'
		);
	}
	return status(
		'checking',
		'Checking…',
		'default',
		'refresh-cw',
		'Re-reading.'
	);
}

// ---------------------------------------------------------------------------
// Status model D: service rows in the CLI's words

export type SupabaseServiceLabel = {
	label: string;
	tone: 'success' | 'info' | 'default' | 'danger';
	icon?: 'moon';
};

function wakeHint(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
	const seconds =
		ms < 10_000 ? Math.round(ms / 100) / 10 : Math.round(ms / 1_000);
	return ` (~${seconds} s)`;
}

/**
 * A service row: `running · healthy` in green; starting, stopping and
 * running without health in blue; `sleeping · starts on first request` calm
 * with a static moon; stopped, unavailable and excluded plain; unhealthy and
 * exited red.
 */
export function serviceStateLabel(member: {
	state: SupabaseMemberState | 'excluded';
	health?: 'starting' | 'healthy' | 'unhealthy' | null | undefined;
	wakeHintMs?: number | undefined;
}): SupabaseServiceLabel {
	switch (member.state) {
		case 'running':
			if (member.health === 'healthy') {
				return { label: 'running · healthy', tone: 'success' };
			}
			if (member.health === 'unhealthy') {
				return { label: 'running · unhealthy', tone: 'danger' };
			}
			if (member.health === 'starting') {
				return { label: 'running · starting', tone: 'info' };
			}
			return { label: 'running', tone: 'info' };
		case 'starting':
		case 'stopping':
			return { label: member.state, tone: 'info' };
		case 'sleeping':
			return {
				label: `sleeping · starts on first request${wakeHint(member.wakeHintMs)}`,
				tone: 'default',
				icon: 'moon',
			};
		case 'stopped':
		case 'unavailable':
		case 'excluded':
			return { label: member.state, tone: 'default' };
		case 'unhealthy':
		case 'exited':
			return { label: member.state, tone: 'danger' };
	}
}

// ---------------------------------------------------------------------------
// Row flags

const ALWAYS_SHOWN_FLAGS: ReadonlySet<SupabaseStackFlag> = new Set([
	'worktree-deleted',
	'stale-branch',
	'lan-exposed',
]);
/** Shown elsewhere: the status label, the Transient filter, nextEvents. */
const UNLISTED_FLAGS: ReadonlySet<SupabaseStackFlag> = new Set([
	'transient',
	'stopped-outside',
	'exposure-unknown',
	'prune-suggested',
	'clocks-paused',
]);
const FLAG_ORDER: readonly SupabaseStackFlag[] = [
	'lan-exposed',
	'worktree-deleted',
	'stale-branch',
	'studio-back-on',
	'config-changed',
	'orphaned',
	'ports-pinned',
	'config-json-conflict',
	'cli-unverified',
	'cli-changed',
	'cli-missing',
	'env-shadowed',
	'other-supabase-home',
	'id-mismatch',
	'not-opted-in',
];

export type SupabaseFlagChip = {
	flag: SupabaseStackFlag;
	label: string;
	tone: 'warning' | 'danger' | 'default';
};

const FLAG_LABELS: Readonly<Record<SupabaseStackFlag, string>> = {
	'worktree-deleted': 'Worktree deleted',
	orphaned: 'Project gone',
	'stale-branch': 'Stale branch',
	'studio-back-on': 'Studio back on',
	'config-changed': 'Config changed',
	'ports-pinned': 'Ports pinned',
	'config-json-conflict': 'config.json conflict',
	'cli-unverified': 'CLI unverified',
	'cli-changed': 'CLI changed',
	'cli-missing': 'CLI missing',
	'env-shadowed': 'Env shadowed',
	'other-supabase-home': 'Other Supabase home',
	'id-mismatch': 'Id mismatch',
	'not-opted-in': 'Not opted in',
	transient: 'Transient',
	'lan-exposed': 'LAN-exposed',
	'exposure-unknown': 'Exposure unknown',
	'stopped-outside': 'Stopped outside',
	'prune-suggested': 'Prune suggested',
	'clocks-paused': 'Clocks paused',
};

/**
 * The flag chips for a row's second line: at most `max`, then `+N`, except
 * that Worktree deleted, Stale branch and LAN-exposed always show. Flags the
 * status label or another surface already conveys are left out.
 */
export function visibleStackFlags(
	stack: Pick<SupabaseStackSummary, 'flags'>,
	max = 2
): Readonly<{ chips: readonly SupabaseFlagChip[]; more: number }> {
	const listed = FLAG_ORDER.filter(
		(flag) => stack.flags.includes(flag) && !UNLISTED_FLAGS.has(flag)
	);
	const chips: SupabaseFlagChip[] = [];
	let more = 0;
	for (const flag of listed) {
		if (chips.length < max || ALWAYS_SHOWN_FLAGS.has(flag)) {
			chips.push({
				flag,
				label: FLAG_LABELS[flag],
				tone:
					flag === 'lan-exposed'
						? 'danger'
						: flag === 'not-opted-in'
							? 'default'
							: 'warning',
			});
		} else {
			more += 1;
		}
	}
	return { chips, more };
}

// ---------------------------------------------------------------------------
// Attention: one ranker for notices, the badge and the Needs attention filter

export type SupabaseAttentionRank =
	| 'danger'
	| 'request'
	| 'warning'
	| 'suggestion';
type SupabaseAttentionKind =
	| 'policy-quarantined'
	| 'state-unreadable'
	| 'lan-exposed'
	| 'exposure-unknown'
	| 'start-failed'
	| 'request'
	| 'stacks-need-attention'
	| 'capacity-full'
	| 'clocks-paused'
	| 'other-supabase-home'
	| 'registry-unreadable'
	| 'stale-branch'
	| 'prune-suggested';

type SupabaseAttentionRecovery =
	| Readonly<{
			kind: 'show-stacks';
			label: string;
			stackIds: readonly string[];
	  }>
	| Readonly<{ kind: 'review-request'; label: string; requestId: string }>
	| Readonly<{ kind: 'resume'; label: string; stackId: string }>
	| Readonly<{ kind: 'open-settings'; label: string }>
	| Readonly<{ kind: 'retry-refresh'; label: string }>
	| Readonly<{ kind: 'show-running'; label: string }>
	| Readonly<{ kind: 'open-clean-up'; label: string }>;

export type SupabaseAttentionItem = Readonly<{
	/** Stable across pushes: the kind, or `request:<id>`. */
	id: string;
	rank: SupabaseAttentionRank;
	kind: SupabaseAttentionKind;
	tone: 'danger' | 'warning' | 'default';
	text: string;
	/** Secondary detail, e.g. the redacted refresh failure. */
	detail?: string;
	stackIds: readonly string[];
	requestId?: string;
	/** At most one recovery per item. */
	recovery?: SupabaseAttentionRecovery;
}>;

type WarningCondition = Readonly<{
	it: string;
	they: string;
	one: string;
	many: string;
}>;

const WARNING_CONDITIONS = {
	'studio-back-on': {
		it: 'it has Studio back on',
		they: 'they have Studio back on',
		one: 'has Studio back on',
		many: 'have Studio back on',
	},
	unhealthy: {
		it: 'it is unhealthy',
		they: 'they are unhealthy',
		one: 'is unhealthy',
		many: 'are unhealthy',
	},
	partial: {
		it: 'it is partly stopped',
		they: 'they are partly stopped',
		one: 'is partly stopped',
		many: 'are partly stopped',
	},
	'cli-mismatch': {
		it: 'it runs another CLI release',
		they: 'they run another CLI release',
		one: 'runs another CLI release',
		many: 'run another CLI release',
	},
	'not-responding': {
		it: "it isn't responding",
		they: "they aren't responding",
		one: "isn't responding",
		many: "aren't responding",
	},
	unreadable: {
		it: "its state can't be read",
		they: "their state can't be read",
		one: "can't be read",
		many: "can't be read",
	},
	'stopped-outside': {
		it: 'it was stopped outside RN Devtools',
		they: 'they were stopped outside RN Devtools',
		one: 'was stopped outside RN Devtools',
		many: 'were stopped outside RN Devtools',
	},
	'worktree-deleted': {
		it: 'its worktree was deleted',
		they: 'their worktrees were deleted',
		one: 'lost its worktree',
		many: 'lost their worktrees',
	},
	'config-changed': {
		it: 'its config changed since it started',
		they: 'their config changed since they started',
		one: 'has config changes to apply',
		many: 'have config changes to apply',
	},
	'ports-pinned': {
		it: 'it has a pinned port',
		they: 'they have pinned ports',
		one: 'has a pinned port',
		many: 'have pinned ports',
	},
	'cli-unverified': {
		it: 'it uses an unverified Supabase CLI',
		they: 'they use an unverified Supabase CLI',
		one: 'uses an unverified Supabase CLI',
		many: 'use an unverified Supabase CLI',
	},
	'cli-missing': {
		it: 'its worktree has no Supabase CLI',
		they: 'their worktrees have no Supabase CLI',
		one: 'has no Supabase CLI',
		many: 'have no Supabase CLI',
	},
	'cli-changed': {
		it: 'its Supabase CLI changed',
		they: 'their Supabase CLI changed',
		one: 'had its CLI changed',
		many: 'had their CLI changed',
	},
	'config-json-conflict': {
		it: 'it has a conflicting config.json',
		they: 'they have a conflicting config.json',
		one: 'has a conflicting config.json',
		many: 'have a conflicting config.json',
	},
	'env-shadowed': {
		it: '.env files shadow its app variables',
		they: '.env files shadow their app variables',
		one: 'has shadowed app variables',
		many: 'have shadowed app variables',
	},
	'id-mismatch': {
		it: "its id isn't the one RN Devtools expected",
		they: "their ids aren't the ones RN Devtools expected",
		one: 'has an unexpected id',
		many: 'have unexpected ids',
	},
} as const satisfies Readonly<Record<string, WarningCondition>>;
type WarningConditionKey = keyof typeof WARNING_CONDITIONS;

function warningConditionFor(
	stack: SupabaseStackSummary
): WarningConditionKey | undefined {
	const flags = new Set(stack.flags);
	if (flags.has('studio-back-on')) return 'studio-back-on';
	if (stack.state === 'unhealthy') return 'unhealthy';
	if (stack.state === 'partial') return 'partial';
	if (stack.cli.mismatch) return 'cli-mismatch';
	if (stack.ownerLiveness === 'not-responding') return 'not-responding';
	if (stack.state === 'unreadable') return 'unreadable';
	if (flags.has('stopped-outside') && stack.state === 'stopped') {
		return 'stopped-outside';
	}
	if (
		(flags.has('worktree-deleted') || flags.has('orphaned')) &&
		isLiveStackState(stack.state)
	) {
		return 'worktree-deleted';
	}
	if (flags.has('config-changed') && isLiveStackState(stack.state)) {
		return 'config-changed';
	}
	if (flags.has('ports-pinned')) return 'ports-pinned';
	if (flags.has('cli-unverified')) return 'cli-unverified';
	if (flags.has('cli-missing')) return 'cli-missing';
	if (flags.has('cli-changed')) return 'cli-changed';
	if (flags.has('config-json-conflict')) return 'config-json-conflict';
	if (flags.has('env-shadowed')) return 'env-shadowed';
	if (flags.has('id-mismatch')) return 'id-mismatch';
	return undefined;
}

const WARNING_ORDER = Object.keys(WARNING_CONDITIONS) as WarningConditionKey[];

function showStacks(stackIds: readonly string[]): SupabaseAttentionRecovery {
	return {
		kind: 'show-stacks',
		label: stackIds.length === 1 ? 'Show it' : 'Show them',
		stackIds,
	};
}

function engineWord(stacks: readonly SupabaseStackSummary[]): string {
	const docker = stacks.some((stack) => stack.runtime !== 'podman');
	const podman = stacks.some((stack) => stack.runtime === 'podman');
	return docker && podman ? 'Docker or Podman' : podman ? 'Podman' : 'Docker';
}

function requestText(request: SupabaseAgentRequest): string {
	const who = `${AGENT_KIND_LABELS[request.requester.kind]} session ${request.requester.sessionId.slice(0, 8)}`;
	switch (request.kind) {
		case 'destroy':
			return `${who} asks to destroy ${request.branch}${request.sizeBytes === undefined ? '' : ` (${formatSupabaseSize(request.sizeBytes)})`}.`;
		case 'reset':
			return `${who} asks to reset ${request.branch}'s database.`;
		case 'start-capacity':
			return request.capacity
				? `${who} needs a database for ${request.branch}; ${request.capacity.running} of ${request.capacity.cap} run, all in use.`
				: `${who} needs a database for ${request.branch}; every slot is in use.`;
	}
}

const RANK_ORDER: Readonly<Record<SupabaseAttentionRank, number>> = {
	danger: 0,
	request: 1,
	warning: 2,
	suggestion: 3,
};

/**
 * Everything that needs the operator, ranked danger, then agent requests,
 * then warnings, then suggestions. Stacks with an operation in flight are
 * left out (their row shows the job). Suggestions (stale branch, prune)
 * never become notices or badge counts. While the feature is off only a
 * quarantined policy is reported.
 */
export function attentionItems(
	state: SupabaseState,
	now: number = state.updatedAt
): readonly SupabaseAttentionItem[] {
	const items: SupabaseAttentionItem[] = [];
	if (state.feature.policyHealth === 'quarantined') {
		items.push({
			id: 'policy-quarantined',
			rank: 'danger',
			kind: 'policy-quarantined',
			tone: 'danger',
			text: "Supabase settings couldn't be read, so local Supabase was turned off. The file was set aside and defaults restored. Running stacks were left as they are.",
			stackIds: [],
			recovery: { kind: 'open-settings', label: 'Open settings' },
		});
	}
	if (!state.feature.enabled || !state.availability.platform.supported) {
		return items;
	}
	if (state.discovery.listFailure) {
		items.push({
			id: 'state-unreadable',
			rank: 'danger',
			kind: 'state-unreadable',
			tone: 'danger',
			text: 'Supabase state could not be read.',
			detail: state.discovery.listFailure.message,
			stackIds: [],
			recovery: { kind: 'retry-refresh', label: 'Retry' },
		});
	}
	const stacks = state.stacks.filter(
		(stack) =>
			!stack.flags.includes('transient') && !activeJobFor(stack, state.jobs)
	);
	const exposed = stacks.filter(isSupabaseStackLanExposed);
	if (exposed.length > 0) {
		const many = exposed.length > 1;
		const allStopped = exposed.every((stack) => !isLiveStackState(stack.state));
		items.push({
			id: 'lan-exposed',
			rank: 'danger',
			kind: 'lan-exposed',
			tone: 'danger',
			text: `${plural(exposed.length, 'stack listens', 'stacks listen')} on your network. ${many ? 'They run' : 'It runs'} on ${engineWord(exposed)}${allStopped ? `; RN Devtools stopped ${many ? 'them' : 'it'} once` : ''}.`,
			stackIds: exposed.map((stack) => stack.id),
			recovery: showStacks(exposed.map((stack) => stack.id)),
		});
	}
	const unknownExposure = stacks.filter(
		(stack) =>
			!isSupabaseStackLanExposed(stack) &&
			(stack.exposure.verdict === 'unknown' ||
				stack.flags.includes('exposure-unknown'))
	);
	if (unknownExposure.length > 0) {
		const [first] = unknownExposure;
		items.push({
			id: 'exposure-unknown',
			rank: 'danger',
			kind: 'exposure-unknown',
			tone: 'danger',
			text:
				unknownExposure.length === 1
					? "1 stack couldn't be verified to listen only on this Mac, so it was stopped."
					: `${unknownExposure.length} stacks couldn't be verified to listen only on this Mac, so they were stopped.`,
			stackIds: unknownExposure.map((stack) => stack.id),
			recovery:
				unknownExposure.length === 1 && first
					? { kind: 'resume', label: 'Resume', stackId: first.id }
					: showStacks(unknownExposure.map((stack) => stack.id)),
		});
	}
	const counted = new Set([
		...exposed.map((stack) => stack.id),
		...unknownExposure.map((stack) => stack.id),
	]);
	const failedKinds = { failed: 0, interrupted: 0, 'needs-recreate': 0 };
	const failed = stacks.filter((stack) => {
		if (counted.has(stack.id)) return false;
		if (
			stack.state === 'failed' ||
			stack.state === 'interrupted' ||
			stack.state === 'needs-recreate'
		) {
			failedKinds[stack.state] += 1;
			return true;
		}
		return false;
	});
	if (failed.length > 0) {
		const parts = [
			failedKinds.failed > 0 ? `${failedKinds.failed} failed to start` : '',
			failedKinds.interrupted > 0
				? `${failedKinds.interrupted} ${failedKinds.interrupted === 1 ? 'was' : 'were'} interrupted`
				: '',
			failedKinds['needs-recreate'] > 0
				? `${failedKinds['needs-recreate']} can't adopt ${failedKinds['needs-recreate'] === 1 ? 'its' : 'their'} configuration`
				: '',
		].filter(Boolean);
		const revertible = failed.filter(
			(stack) =>
				stack.state === 'needs-recreate' &&
				supabaseRevertKeepsStack(stack.recreateChanges)
		).length;
		const recreateAdvice =
			revertible === failed.length
				? `: revert the change or recreate ${failed.length === 1 ? 'it' : 'them'}`
				: revertible === 0
					? ' and must be recreated'
					: '';
		const text =
			parts.length > 1
				? `${failed.length} stacks can't start: ${parts.join(', ')}.`
				: failedKinds.failed > 0
					? `${plural(failed.length, 'stack', 'stacks')} failed to start and left ${failed.length === 1 ? 'an empty stack' : 'empty stacks'}.`
					: failedKinds.interrupted > 0
						? `${plural(failed.length, 'stack was', 'stacks were')} interrupted during ${failed.length === 1 ? 'its' : 'their'} first start.`
						: `${plural(failed.length, 'stack', 'stacks')} can't adopt ${failed.length === 1 ? 'its' : 'their'} configuration${recreateAdvice}.`;
		items.push({
			id: 'start-failed',
			rank: 'danger',
			kind: 'start-failed',
			tone: 'danger',
			text,
			stackIds: failed.map((stack) => stack.id),
			recovery: showStacks(failed.map((stack) => stack.id)),
		});
		for (const stack of failed) counted.add(stack.id);
	}
	for (const request of [...state.requests]
		.filter(
			(candidate) =>
				(candidate.status === 'pending' || candidate.status === 'settling') &&
				candidate.expiresAt > now
		)
		.sort((left, right) => left.createdAt - right.createdAt)) {
		items.push({
			id: `request:${request.id}`,
			rank: 'request',
			kind: 'request',
			tone: 'warning',
			text: requestText(request),
			stackIds: request.stackId === undefined ? [] : [request.stackId],
			requestId: request.id,
			recovery: {
				kind: 'review-request',
				label: 'Review',
				requestId: request.id,
			},
		});
	}
	const byCondition = new Map<WarningConditionKey, string[]>();
	for (const stack of stacks) {
		if (counted.has(stack.id)) continue;
		const condition = warningConditionFor(stack);
		if (condition === undefined) continue;
		const list = byCondition.get(condition) ?? [];
		list.push(stack.id);
		byCondition.set(condition, list);
	}
	if (byCondition.size > 0) {
		const ordered = WARNING_ORDER.flatMap((key) => {
			const ids = byCondition.get(key);
			return ids ? [[key, ids] as const] : [];
		});
		const stackIds = ordered.flatMap(([, ids]) => ids);
		const [only] = ordered;
		const text =
			ordered.length === 1 && only
				? `${plural(stackIds.length, 'stack needs', 'stacks need')} attention: ${stackIds.length === 1 ? WARNING_CONDITIONS[only[0]].it : WARNING_CONDITIONS[only[0]].they}.`
				: `${stackIds.length} stacks need attention: ${ordered
						.map(
							([key, ids]) =>
								`${ids.length} ${ids.length === 1 ? WARNING_CONDITIONS[key].one : WARNING_CONDITIONS[key].many}`
						)
						.join(', ')}.`;
		items.push({
			id: 'stacks-need-attention',
			rank: 'warning',
			kind: 'stacks-need-attention',
			tone: 'warning',
			text,
			stackIds,
			recovery: showStacks(stackIds),
		});
	}
	const { capacity } = state;
	if (capacity.running >= capacity.cap && capacity.nextToStopId === undefined) {
		items.push({
			id: 'capacity-full',
			rank: 'warning',
			kind: 'capacity-full',
			tone: 'warning',
			text: `${capacity.running} of ${capacity.cap} stacks are running and all are in use.`,
			stackIds: [],
			recovery: { kind: 'show-running', label: 'Show running stacks' },
		});
	}
	if (
		state.discovery.sessions === 'unavailable' &&
		state.stacks.some(
			(stack) =>
				(stack.origin === 'managed' || stack.origin === 'adopted') &&
				isLiveStackState(stack.state)
		)
	) {
		items.push({
			id: 'clocks-paused',
			rank: 'warning',
			kind: 'clocks-paused',
			tone: 'warning',
			text: "Auto-stop paused: agent sessions can't be read right now.",
			stackIds: [],
		});
	}
	if (state.home.foreign && state.home.foreign.length > 0) {
		items.push({
			id: 'other-supabase-home',
			rank: 'warning',
			kind: 'other-supabase-home',
			tone: 'warning',
			text: `Another Supabase home is in use on this Mac (${state.home.foreign.join(', ')}); its stacks aren't listed here.`,
			stackIds: [],
		});
	}
	if (state.notices.registryError !== undefined) {
		items.push({
			id: 'registry-unreadable',
			rank: 'warning',
			kind: 'registry-unreadable',
			tone: 'warning',
			text: "The Supabase port registry couldn't be read, so some ports may be missing.",
			detail: state.notices.registryError,
			stackIds: [],
		});
	}
	const stale = stacks.filter(
		(stack) =>
			!counted.has(stack.id) &&
			stack.flags.includes('stale-branch') &&
			!isLiveStackState(stack.state)
	);
	if (stale.length > 0) {
		items.push({
			id: 'stale-branch',
			rank: 'suggestion',
			kind: 'stale-branch',
			tone: 'default',
			text: `${plural(stale.length, 'stack belongs', 'stacks belong')} to a branch ${stale.length === 1 ? 'its worktree' : 'their worktrees'} moved away from.`,
			stackIds: stale.map((stack) => stack.id),
			recovery: showStacks(stale.map((stack) => stack.id)),
		});
	}
	const prunable = state.prune.groups
		.filter((group) => group.selectable)
		.flatMap((group) => group.stackIds);
	if (prunable.length > 0) {
		items.push({
			id: 'prune-suggested',
			rank: 'suggestion',
			kind: 'prune-suggested',
			tone: 'default',
			text: `${plural(prunable.length, 'stack is', 'stacks are')} suggested for clean up${state.prune.suggestedBytes === undefined ? '' : ` (${formatSupabaseSize(state.prune.suggestedBytes)})`}. RN Devtools never deletes a database on its own.`,
			stackIds: prunable,
			recovery: { kind: 'open-clean-up', label: 'Clean up' },
		});
	}
	return items.sort(
		(left, right) => RANK_ORDER[left.rank] - RANK_ORDER[right.rank]
	);
}

export type SupabaseSidebarBadge = {
	value: number;
	tone: 'danger' | 'warning' | 'default';
	/** Part of the nav item's accessible name. */
	label: string;
};

/**
 * The sidebar badge: red for any danger item, amber for requests or
 * warnings, otherwise a grey count of running stacks. Nothing while off,
 * unsupported or not live.
 */
export function sidebarBadge(
	state: SupabaseState,
	now: number = state.updatedAt
): SupabaseSidebarBadge | undefined {
	if (
		!state.feature.enabled ||
		!state.availability.platform.supported ||
		state.discovery.status !== 'live'
	) {
		return undefined;
	}
	const items = attentionItems(state, now).filter(
		(item) => item.rank !== 'suggestion'
	);
	if (items.length > 0) {
		return {
			value: items.length,
			tone: items.some((item) => item.rank === 'danger') ? 'danger' : 'warning',
			label: `Supabase, ${items.length} ${items.length === 1 ? 'needs' : 'need'} attention`,
		};
	}
	const running = state.capacity.running;
	return running > 0
		? { value: running, tone: 'default', label: `Supabase, ${running} running` }
		: undefined;
}

// ---------------------------------------------------------------------------
// What happens next

export type SupabaseNextEvent = Readonly<{
	kind:
		| 'pinned'
		| 'held'
		| 'kept-by-session'
		| 'never-automatic'
		| 'auto-stop'
		| 'abandoned'
		| 'clocks-paused'
		| 'prune';
	/** When it happens; the renderer may add the clock time. */
	at?: number;
	/** Amber Timer for an automatic stop; muted CalendarClock for a prune suggestion. */
	tone: 'warning' | 'muted' | 'default' | 'info';
	icon: 'timer' | 'calendar-clock' | 'pin' | 'circle-pause' | 'user';
	text: string;
	actions: readonly ('keep-running' | 'unpin' | 'stop')[];
}>;

function holdLabel(
	hold: SupabaseHold,
	lanes: readonly SupabaseStackLane[]
): string {
	if (hold.holder === 'operator') return 'you';
	if (hold.holder === 'lane' && !hold.agent) {
		const lane = lanes.find((candidate) => candidate.laneId === hold.laneId);
		return lane ? `lane :${lane.port}` : 'a lane';
	}
	return hold.agent ? supabaseAgentLabel(hold.agent) : 'a lane';
}

function joinNames(names: readonly string[]): string {
	if (names.length <= 1) return names[0] ?? '';
	return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The "What happens next" lines for a stack: who keeps it running, the
 * automatic stop countdown (amber, data kept), and the prune suggestion
 * (muted, never automatic). The two are separate events and never merged.
 */
export function nextEvents(
	stack: SupabaseStackSummary,
	policy: Pick<SupabasePolicy, 'unheldStopDelayMs'>,
	now: number,
	options: Readonly<{ clocksPaused?: boolean }> = {}
): readonly SupabaseNextEvent[] {
	const untimed: SupabaseNextEvent[] = [];
	const timed: SupabaseNextEvent[] = [];
	const tail: SupabaseNextEvent[] = [];
	const clocksPaused =
		options.clocksPaused === true || stack.flags.includes('clocks-paused');
	if (isLiveStackState(stack.state)) {
		if (stack.origin === 'external') {
			untimed.push({
				kind: 'never-automatic',
				tone: 'default',
				icon: 'user',
				text: "RN Devtools didn't start it, so it never stops it automatically.",
				actions: [],
			});
		}
		if (stack.pinned) {
			untimed.push({
				kind: 'pinned',
				tone: 'default',
				icon: 'pin',
				text: 'Pinned by you · never stopped automatically',
				actions: ['unpin'],
			});
		}
		const live = stack.holds.filter(isLiveAgentOrLaneHold);
		if (live.length > 0) {
			const names = [
				...new Set(live.map((hold) => holdLabel(hold, stack.lanes))),
			];
			const agents = live.some((hold) => hold.agent !== undefined);
			const delay =
				policy.unheldStopDelayMs === 0
					? 'It stops as soon as the last holder releases it'
					: `${formatStopDelay(policy.unheldStopDelayMs)} after the last release it stops`;
			untimed.push({
				kind: 'held',
				tone: 'default',
				icon: 'user',
				text: `Keeps running while ${joinNames(names)} ${agents ? (names.length === 1 ? 'is live' : 'are live') : names.length === 1 ? 'runs' : 'run'}. ${delay}; data is kept. Never deleted on its own.`,
				actions: [],
			});
		} else if (stack.cwdKeepers.length > 0) {
			untimed.push({
				kind: 'kept-by-session',
				tone: 'default',
				icon: 'user',
				text: `Kept running: ${joinNames(stack.cwdKeepers.map((keeper) => supabaseAgentLabel(keeper.agent)))} ${stack.cwdKeepers.length === 1 ? 'works' : 'work'} in this worktree`,
				actions: [],
			});
		}
		const abandoned = stack.holds.filter(
			(hold) => !hold.live && hold.releaseAt !== undefined
		);
		if (clocksPaused && stack.holds.some((hold) => !hold.live)) {
			tail.push({
				kind: 'clocks-paused',
				tone: 'info',
				icon: 'circle-pause',
				text: "Auto-stop paused: agent sessions can't be read right now.",
				actions: [],
			});
		} else if (stack.autoStopAt !== undefined) {
			const remaining = stack.autoStopAt - now;
			if (stack.autoStopReason === 'abandoned') {
				const [gone] = abandoned;
				const who = gone ? holdLabel(gone, stack.lanes) : 'Its holder';
				timed.push({
					kind: 'abandoned',
					at: stack.autoStopAt,
					tone: 'warning',
					icon: 'timer',
					text:
						remaining > 0
							? `${who} is gone; stops in ${formatHoldDuration(remaining)}`
							: `${who} is gone; stopping now`,
					actions: ['keep-running', 'stop'],
				});
			} else {
				const prefix =
					stack.autoStopReason === 'orphaned'
						? 'Its worktree was deleted; stops'
						: 'Stops';
				timed.push({
					kind: 'auto-stop',
					at: stack.autoStopAt,
					tone: 'warning',
					icon: 'timer',
					text:
						remaining > 0
							? `${prefix} in ${formatHoldDuration(remaining)} · data kept`
							: `${prefix} now · data kept`,
					actions: stack.autoStopReason === 'orphaned' ? [] : ['keep-running'],
				});
			}
		} else if (live.length === 0 && abandoned.length > 0) {
			const soonest = [...abandoned].sort(
				(left, right) => (left.releaseAt ?? 0) - (right.releaseAt ?? 0)
			)[0];
			if (soonest?.releaseAt !== undefined) {
				const label = holdCountdownLabel(
					{
						live: false,
						releaseAt: soonest.releaseAt,
						holder: soonest.holder,
					},
					now,
					{ verb: 'stops' }
				);
				timed.push({
					kind: 'abandoned',
					at: soonest.releaseAt,
					tone: 'warning',
					icon: 'timer',
					text: `${holdLabel(soonest, stack.lanes)} is ${label.text.replace(/^gone · /, 'gone; ')}`,
					actions: ['keep-running', 'stop'],
				});
			}
		}
	} else if (
		stack.state === 'stopped' ||
		stack.state === 'failed' ||
		stack.state === 'never-started' ||
		stack.state === 'interrupted' ||
		stack.state === 'needs-recreate' ||
		stack.state === 'unreadable'
	) {
		if (stack.pruneGroup !== undefined) {
			timed.push({
				kind: 'prune',
				at: stack.pruneSuggestedAt ?? now,
				tone: 'muted',
				icon: 'calendar-clock',
				text: 'Suggested for clean up · never automatic',
				actions: [],
			});
		} else if (stack.pruneSuggestedAt !== undefined) {
			const remaining = stack.pruneSuggestedAt - now;
			timed.push({
				kind: 'prune',
				at: stack.pruneSuggestedAt,
				tone: 'muted',
				icon: 'calendar-clock',
				text:
					remaining > 0
						? `Prune suggested in ${formatHoldDuration(remaining)} if still stopped · never automatic`
						: 'Prune suggested now if still stopped · never automatic',
				actions: [],
			});
		}
	}
	timed.sort((left, right) => (left.at ?? 0) - (right.at ?? 0));
	return [...untimed, ...timed, ...tail];
}

// ---------------------------------------------------------------------------
// Availability: one pure function decides every control

export type SupabaseStackAction =
	| 'start'
	| 'resume'
	| 'resume-saved'
	| 'stop'
	| 'restart'
	| 'stop-and-start'
	| 'reapply-exclusions'
	| 'switch-cli'
	| 'pin'
	| 'unpin'
	| 'adopt'
	| 'prepare'
	| 'destroy'
	| 'recreate'
	| 'reset'
	| 'apply-migrations'
	| 'seed-buckets'
	| 'export'
	| 'enable-studio'
	| 'disable-studio'
	| 'open-studio'
	| 'open-mailpit'
	| 'copy-api-url'
	| 'copy-key'
	| 'copy-psql'
	| 'copy-app-env'
	| 'copy-status-command'
	| 'copy-inspect-command'
	| 'read-logs'
	| 'logs-auto-refresh'
	| 'read-database'
	| 'migration-status'
	| 'follow-branch'
	| 'release'
	| 'reveal'
	| 'cancel-start'
	| 'restart-metro'
	| 'inspect';

/**
 * The precedence buckets, in the order they are checked.
 */
type SupabaseAvailabilityCheck =
	| 'bridge'
	| 'off'
	| 'platform'
	| 'in-flight'
	| 'mode'
	| 'release'
	| 'head'
	| 'exposure'
	| 'holder'
	| 'capacity'
	| 'state';

export type SupabaseAvailability =
	| Readonly<{ allowed: true }>
	| Readonly<{
			allowed: false;
			reason: string;
			check: SupabaseAvailabilityCheck;
	  }>;

export type SupabaseAvailabilityContext = Readonly<{
	bridgeAvailable: boolean;
	state: Pick<SupabaseState, 'feature' | 'availability' | 'capacity' | 'jobs'>;
	/** The renderer has this stack's operation pending before main's job shows. */
	pending?: boolean;
	/** The last database read, for the migration controls. */
	migrations?: SupabaseMigrationsView;
	now?: number;
}>;

/** A start needs two free SysV segments: its postmaster plus a shadow. */
export const SUPABASE_MIN_FREE_SYSV_SEGMENTS = 2;

/** Visible disabled-reason copy, from the Controls spec. */
export const SUPABASE_REASONS = Object.freeze({
	bridge:
		'Supabase controls need the secure desktop bridge. Open the packaged RN Devtools app.',
	off: 'Turn on local Supabase first.',
	platform: 'Needs Apple silicon and macOS 14 or later.',
	inFlight: 'Another operation is running on this stack.',
	stopping: 'Stopping…',
	cancelling: 'Cancelling… the CLI is cleaning up (up to 45 s).',
	turningOn: 'Turning on…',
	turningOffWaiting: 'Turning off… waiting for running starts to finish.',
	stillTurningOff: 'Local Supabase is still turning off.',
	notManagedByDesktop: "RN Devtools didn't start this stack. Adopt it first.",
	cliUnverified:
		"This worktree's Supabase CLI isn't verified for RN Devtools. Stop the stack, then start it from a terminal.",
	trackRepository:
		'Track this repository first (Repositories › Track repository…).',
	mismatchRestart:
		"This stack runs on another Supabase CLI release. Stop it, then start it with this worktree's CLI.",
	mismatchAdopt:
		'This stack runs on another Supabase CLI release. Stop it first.',
	worktreeDeleted:
		'Its worktree was deleted. Destroy this stack to free its ports and data.',
	containerIdentity:
		"A Docker stack already uses this worktree's identity. Destroy it first; RN Devtools never attaches container stacks.",
	containerResume:
		'This stack runs on Docker and listens on your network. Destroy it; lane up then creates a native one.',
	containerAdopt: 'Only native stacks can be adopted. This one runs on Docker.',
	laneAttached: (port: number) =>
		`Lane :${port} is attached and running. Stop the lane in Lanes first.`,
	pinnedReset: 'Pinned stacks are protected. Unpin it first.',
	capacityFull: (running: number, cap: number) =>
		`${running} of ${cap} stacks are running and all are in use. Stop one, or raise the limit in Settings.`,
	/** Fewer than SUPABASE_MIN_FREE_SYSV_SEGMENTS Postgres slots are free. */
	sysv: (free: number) =>
		free === 1
			? `Only 1 Postgres slot is free; a start needs ${SUPABASE_MIN_FREE_SYSV_SEGMENTS}. Stop an idle stack first.`
			: `No Postgres slot is free; a start needs ${SUPABASE_MIN_FREE_SYSV_SEGMENTS}. Stop an idle stack first.`,
	memoryCritical:
		'Memory pressure is critical. Stop stacks or Simulators first.',
	memoryCriticalStudio:
		'Memory pressure is critical; Studio needs about 1-2 GB.',
	stopFirst: 'Stop it first. Destroy runs only on a stopped stack.',
	unreadableDestroy:
		"This CLI can't read the stack, so it can't destroy it. See Clean up › Unreadable.",
	unreadable: "This CLI can't read the stack's state.",
	interrupted: "A first start stopped midway can't be resumed.",
	notRunningDatabase: 'Start the stack first. Database reads need it running.',
	notRunningReset: 'Start the stack first. A reset needs its database running.',
	notRunningMigrations:
		'Start the stack first. Migrations need a running database.',
	notRunningExport:
		'Start the stack first. An export reads the running database.',
	notRunningSeed:
		'Start the stack first. Storage must run to seed its buckets.',
	notRunning: 'Start the stack first.',
	noPending: 'No pending migrations.',
	noLogs: 'No logs yet: this stack never started.',
	autoRefresh: 'Auto-refresh needs a running stack; history stays readable.',
	apiUrlUnknown: "The API URL is known after the stack's first start.",
	keyUnknown: 'The key is read when the stack starts. Start it once.',
	databaseAddressUnknown:
		'Start the stack first. The database address is only known while it runs.',
	noAppEnv: 'No app variables are mapped. Add one in Settings.',
	commandUnknown:
		"The command is known once this worktree's Supabase CLI is found.",
	mailExcluded: 'Mail is excluded from this stack.',
	studioExcluded: 'Studio is excluded from this stack.',
	storageExcluded: 'Storage is excluded from this stack.',
	noBuckets: 'No buckets are configured for this project.',
	anotherExport: 'Another export is running.',
	folderGone: 'The folder is gone.',
	noReleasableHold:
		'Only agent holds can be released; lane holds end with their lane.',
	nothingStarting: 'Nothing is starting on this stack.',
	metroNotRunning: "Metro isn't running for this lane.",
	noLane: 'No lane is attached to this stack.',
	metroCurrent: "Metro already has this stack's address.",
	notHeld: 'Only a stack in use follows its branch.',
	headStill: (branch: string) => `The worktree is still on ${branch}.`,
	detachedHead: 'The worktree has a detached HEAD. Switch to a branch first.',
	alreadyRunning: 'It is already running.',
	alreadyStopped: 'It is already stopped.',
	alreadyPinned: 'It already keeps running until you unpin it.',
	notPinned: 'It is not pinned.',
	alreadyManaged: 'RN Devtools already manages this stack.',
	studioOn: 'Studio is already on for this stack.',
	studioOff: 'Studio is already off for this stack.',
	notCreated: 'This stack does not exist yet.',
	notStale: "Resume uses this worktree's current settings.",
	recreateOnly: "Recreate is offered only when a stack can't start as it is.",
	exclusionsApplied: 'Its exclusions are already applied.',
	sameCli: "It already runs on this worktree's Supabase CLI.",
	ownerUnreachable: "Its owner isn't answering. Stop it instead.",
	neverStarted: 'Prepared, but never started. Start it first.',
	prepareState:
		'Services can be downloaded only for a stack that is not running.',
});

function branchName(ref: string | undefined): string {
	return supabaseBranchLabel(ref) ?? 'another branch';
}

function currentName(stack: Pick<SupabaseStackSummary, 'currentHead'>): string {
	const ref = stack.currentHead?.ref;
	return ref === 'detached' ? 'a detached HEAD' : branchName(ref);
}

function headResumeReason(stack: SupabaseStackSummary): string {
	const current = currentName(stack);
	return `The worktree is on ${current}. Starting this stack would load ${current}'s settings. Switch back to ${branchName(stack.branchContext)} first.`;
}

function headMutateReason(stack: SupabaseStackSummary): string {
	return `The worktree is on ${currentName(stack)}. Switch back to ${branchName(stack.branchContext)} to change this database.`;
}

function headRecreateReason(stack: SupabaseStackSummary): string {
	const current = currentName(stack);
	return `The worktree is on ${current}, so a new stack would belong to ${current}. Switch back to ${branchName(stack.branchContext)} first.`;
}

function headMigrationReason(stack: SupabaseStackSummary): string {
	return `Migration status can't be worked out while the worktree is on ${currentName(stack)}; its migration files belong to that branch.`;
}

function observedReason(stack: SupabaseStackSummary): string {
	const reason = stack.mode.reasonText?.trim().replace(/\.$/, '');
	if (stack.mode.value === 'off') {
		return reason
			? `Local Supabase is off here: ${reason}.`
			: 'Local Supabase is off for this repository. Set it to Auto in Repositories.';
	}
	return `Observed only: ${reason || 'RN Devtools does not manage this worktree'}.`;
}

function engineName(stack: SupabaseStackSummary): string {
	return stack.runtime === 'podman' ? 'Podman' : 'Docker';
}

const READ_ONLY_ACTIONS: ReadonlySet<SupabaseStackAction> = new Set([
	'open-studio',
	'open-mailpit',
	'copy-api-url',
	'copy-key',
	'copy-psql',
	'copy-app-env',
	'copy-status-command',
	'copy-inspect-command',
	'read-logs',
	'logs-auto-refresh',
	'read-database',
	'migration-status',
	'reveal',
	'inspect',
]);

/** Actions that start a stack natively from its saved or current settings. */
const STARTING_ACTIONS: ReadonlySet<SupabaseStackAction> = new Set([
	'start',
	'resume',
	'resume-saved',
	'stop-and-start',
	'reapply-exclusions',
	'switch-cli',
	'enable-studio',
	'disable-studio',
	'follow-branch',
]);

/** Actions only a managed or adopted stack in a managed worktree may take. */
const MANAGED_ACTIONS: ReadonlySet<SupabaseStackAction> = new Set([
	'start',
	'resume',
	'resume-saved',
	'restart',
	'stop-and-start',
	'reapply-exclusions',
	'switch-cli',
	'pin',
	'unpin',
	'prepare',
	'recreate',
	'reset',
	'apply-migrations',
	'seed-buckets',
	'enable-studio',
	'disable-studio',
	'follow-branch',
]);

const SAME_RELEASE_ACTIONS: ReadonlySet<SupabaseStackAction> = new Set([
	'restart',
	'reset',
	'apply-migrations',
	'seed-buckets',
	'enable-studio',
	'disable-studio',
	'adopt',
]);

const CAPACITY_ACTIONS: ReadonlySet<SupabaseStackAction> = new Set([
	'start',
	'resume',
	'resume-saved',
	'follow-branch',
	'recreate',
	'enable-studio',
]);

type Check = (
	stack: SupabaseStackSummary,
	action: SupabaseStackAction,
	context: SupabaseAvailabilityContext
) => string | undefined;

const checkBridge: Check = (_stack, _action, context) =>
	context.bridgeAvailable ? undefined : SUPABASE_REASONS.bridge;

const checkOff: Check = (_stack, _action, context) =>
	context.state.feature.enabled ? undefined : SUPABASE_REASONS.off;

const checkPlatform: Check = (_stack, _action, context) =>
	context.state.availability.platform.supported
		? undefined
		: SUPABASE_REASONS.platform;

const checkInFlight: Check = (stack, action, context) => {
	const job = activeJobFor(stack, context.state.jobs);
	if (action === 'cancel-start') {
		if (
			!job ||
			!(
				job.kind === 'create' ||
				job.kind === 'resume' ||
				job.kind === 'prepare'
			)
		) {
			return SUPABASE_REASONS.nothingStarting;
		}
		if (job.cancelRequested === true) return SUPABASE_REASONS.cancelling;
		return job.cancellable ? undefined : SUPABASE_REASONS.inFlight;
	}
	if (action === 'export') {
		const exporting = context.state.jobs.some(
			(candidate) =>
				candidate.kind === 'export' && isActiveSupabaseJob(candidate)
		);
		if (exporting) return SUPABASE_REASONS.anotherExport;
	}
	if (READ_ONLY_ACTIONS.has(action)) return undefined;
	if (job) {
		return action === 'stop' && (job.kind === 'stop' || job.kind === 'disable')
			? SUPABASE_REASONS.stopping
			: SUPABASE_REASONS.inFlight;
	}
	return context.pending === true ? SUPABASE_REASONS.inFlight : undefined;
};

const checkMode: Check = (stack, action) => {
	if (action === 'adopt') {
		if (stack.origin === 'managed' || stack.origin === 'adopted') {
			return SUPABASE_REASONS.alreadyManaged;
		}
		if (stack.origin === 'expected') return undefined;
		if (stack.repositoryId === undefined)
			return SUPABASE_REASONS.trackRepository;
		return stack.mode.value === 'managed' ? undefined : observedReason(stack);
	}
	if (!MANAGED_ACTIONS.has(action)) return undefined;
	// A Docker or Podman stack on a managed identity can only be replaced:
	// destroy it and create the native one in its place.
	const replaceable = action === 'recreate' && isSupabaseStackLanExposed(stack);
	if (stack.origin === 'external' && !replaceable) {
		return SUPABASE_REASONS.notManagedByDesktop;
	}
	if (stack.mode.value === 'managed') {
		return action === 'start' && stack.pinnedPort
			? `Port ${stack.pinnedPort.port} for ${stack.pinnedPort.key} is pinned in supabase/config.toml and held by ${stack.pinnedPort.holderLabel === undefined ? 'another stack' : `the stack for ${stack.pinnedPort.holderLabel}`}.`
			: undefined;
	}
	if (
		(action === 'stop-and-start' ||
			action === 'reapply-exclusions' ||
			action === 'switch-cli') &&
		stack.cli.gate !== 'verified'
	) {
		return SUPABASE_REASONS.cliUnverified;
	}
	return observedReason(stack);
};

const checkRelease: Check = (stack, action) => {
	if (!stack.cli.mismatch || !SAME_RELEASE_ACTIONS.has(action))
		return undefined;
	return action === 'adopt'
		? SUPABASE_REASONS.mismatchAdopt
		: SUPABASE_REASONS.mismatchRestart;
};

const checkHead: Check = (stack, action) => {
	const resumeLike =
		action === 'resume' ||
		action === 'stop-and-start' ||
		action === 'reapply-exclusions' ||
		action === 'switch-cli' ||
		action === 'enable-studio' ||
		action === 'disable-studio' ||
		(action === 'start' && stack.state !== 'not-created');
	const mutate =
		action === 'reset' ||
		action === 'apply-migrations' ||
		action === 'seed-buckets';
	if (
		(resumeLike ||
			mutate ||
			action === 'recreate' ||
			action === 'resume-saved') &&
		!stack.worktreeExists
	) {
		return SUPABASE_REASONS.worktreeDeleted;
	}
	if (action === 'follow-branch') {
		const head = stack.currentHead;
		if (!head || head.ref === stack.branchContext) {
			return SUPABASE_REASONS.headStill(branchName(stack.branchContext));
		}
		if (head.gitOperation !== undefined) {
			return `A ${head.gitOperation} is in progress in this worktree; following waits until it finishes.`;
		}
		if (head.ref === 'detached') return SUPABASE_REASONS.detachedHead;
		// Asking is explicit, so it skips the 30 s debounce automatic follows
		// wait for; a git operation in progress still blocks it.
		return undefined;
	}
	if (action === 'resume-saved') {
		return supabaseHeadMatches(stack) ? SUPABASE_REASONS.notStale : undefined;
	}
	if (action === 'adopt') {
		return supabaseHeadMatches(stack)
			? undefined
			: `Its branch (${branchName(stack.branchContext)}) isn't checked out in that worktree anymore.`;
	}
	if (supabaseHeadMatches(stack)) return undefined;
	if (resumeLike) return headResumeReason(stack);
	if (mutate) return headMutateReason(stack);
	if (action === 'recreate') return headRecreateReason(stack);
	if (action === 'migration-status') return headMigrationReason(stack);
	return undefined;
};

const checkExposure: Check = (stack, action) => {
	if (!isSupabaseStackLanExposed(stack)) return undefined;
	const engine = engineName(stack);
	if (action === 'adopt') {
		return SUPABASE_REASONS.containerAdopt.replace('Docker', engine);
	}
	if (action === 'start') {
		return SUPABASE_REASONS.containerIdentity.replace(
			'A Docker',
			`A ${engine}`
		);
	}
	if (STARTING_ACTIONS.has(action)) {
		return SUPABASE_REASONS.containerResume.replace('Docker', engine);
	}
	return undefined;
};

const checkHolder: Check = (stack, action) => {
	if (action === 'destroy' || action === 'recreate') {
		const lane = stack.lanes.find((candidate) => candidate.metro !== 'stopped');
		return lane ? SUPABASE_REASONS.laneAttached(lane.port) : undefined;
	}
	if (action === 'reset') {
		return stack.pinned ? SUPABASE_REASONS.pinnedReset : undefined;
	}
	if (action === 'follow-branch') {
		return stack.holds.some((hold) => hold.live) || stack.lanes.length > 0
			? undefined
			: SUPABASE_REASONS.notHeld;
	}
	if (action === 'release') {
		return stack.holds.some(
			(hold) => hold.holder === 'session' || hold.holder === 'worktree'
		)
			? undefined
			: SUPABASE_REASONS.noReleasableHold;
	}
	return undefined;
};

const checkCapacity: Check = (_stack, action, context) => {
	if (!CAPACITY_ACTIONS.has(action)) return undefined;
	const { capacity } = context.state;
	if (action === 'enable-studio') {
		return capacity.memoryPressure === 'critical'
			? SUPABASE_REASONS.memoryCriticalStudio
			: undefined;
	}
	if (capacity.running >= capacity.cap && capacity.nextToStopId === undefined) {
		return SUPABASE_REASONS.capacityFull(capacity.running, capacity.cap);
	}
	if (capacity.sysv) {
		const free = Math.max(0, capacity.sysv.limit - capacity.sysv.used);
		if (free < SUPABASE_MIN_FREE_SYSV_SEGMENTS) {
			return SUPABASE_REASONS.sysv(free);
		}
	}
	return capacity.memoryPressure === 'critical'
		? SUPABASE_REASONS.memoryCritical
		: undefined;
};

function recreateReason(stack: SupabaseStackSummary): string | undefined {
	const changes = stack.recreateChanges ?? [];
	// Name the change that forces the recreate when one does.
	const change = changes.find((candidate) => !candidate.editable) ?? changes[0];
	if (!change?.key) return undefined;
	const changed = `${change.key} changed from ${change.saved ?? 'its saved value'} to ${change.requested ?? 'a new value'}`;
	return supabaseRevertKeepsStack(changes)
		? `${changed}. Revert it to keep this stack, or recreate it.`
		: `This stack must be recreated: ${changed}.`;
}

function stateReason(
	stack: SupabaseStackSummary,
	action: SupabaseStackAction,
	context: SupabaseAvailabilityContext
): string | undefined {
	const running = isSupabaseStackRunning(stack);
	const live = isLiveStackState(stack.state);
	if (stack.state === 'unreadable') {
		if (action === 'reveal') {
			return stack.stackFolderExists === false
				? SUPABASE_REASONS.folderGone
				: undefined;
		}
		return action === 'destroy'
			? SUPABASE_REASONS.unreadableDestroy
			: SUPABASE_REASONS.unreadable;
	}
	switch (action) {
		case 'start':
			if (
				stack.state === 'not-created' ||
				stack.state === 'never-started' ||
				stack.state === 'failed'
			) {
				return undefined;
			}
			return live
				? SUPABASE_REASONS.alreadyRunning
				: stack.state === 'interrupted'
					? SUPABASE_REASONS.interrupted
					: stack.state === 'needs-recreate'
						? (recreateReason(stack) ?? SUPABASE_REASONS.recreateOnly)
						: undefined;
		case 'resume':
		case 'resume-saved':
			if (stack.state === 'stopped') return undefined;
			if (stack.state === 'needs-recreate') {
				return recreateReason(stack) ?? SUPABASE_REASONS.recreateOnly;
			}
			if (stack.state === 'interrupted') return SUPABASE_REASONS.interrupted;
			if (stack.state === 'not-created') return SUPABASE_REASONS.notCreated;
			if (stack.state === 'never-started' || stack.state === 'failed') {
				return SUPABASE_REASONS.neverStarted;
			}
			return live ? SUPABASE_REASONS.alreadyRunning : undefined;
		case 'stop':
			if (stack.state === 'stopping') return SUPABASE_REASONS.stopping;
			return live ||
				stack.ownerLiveness === 'reachable' ||
				stack.ownerLiveness === 'starting' ||
				stack.ownerLiveness === 'not-responding'
				? undefined
				: SUPABASE_REASONS.alreadyStopped;
		case 'restart':
			if (stack.ownerLiveness === 'not-responding') {
				return SUPABASE_REASONS.ownerUnreachable;
			}
			if (stack.state === 'never-started') return SUPABASE_REASONS.neverStarted;
			return running ? undefined : SUPABASE_REASONS.notRunning;
		case 'stop-and-start':
		case 'reapply-exclusions':
		case 'switch-cli':
			if (!running) return SUPABASE_REASONS.notRunning;
			if (
				action === 'reapply-exclusions' &&
				!stack.flags.includes('studio-back-on') &&
				stack.compositionDrift === undefined
			) {
				return SUPABASE_REASONS.exclusionsApplied;
			}
			if (action === 'switch-cli' && !stack.cli.mismatch) {
				return SUPABASE_REASONS.sameCli;
			}
			return undefined;
		case 'pin':
			if (stack.pinned) return SUPABASE_REASONS.alreadyPinned;
			return live && stack.state !== 'stopping'
				? undefined
				: SUPABASE_REASONS.notRunning;
		case 'unpin':
			return stack.pinned ? undefined : SUPABASE_REASONS.notPinned;
		case 'adopt':
			return stack.state === 'not-created'
				? SUPABASE_REASONS.notCreated
				: undefined;
		case 'prepare':
			return live ? SUPABASE_REASONS.prepareState : undefined;
		case 'destroy':
			if (stack.state === 'not-created') return SUPABASE_REASONS.notCreated;
			return live || stack.ownerLiveness === 'not-responding'
				? SUPABASE_REASONS.stopFirst
				: undefined;
		case 'recreate':
			if (live) return SUPABASE_REASONS.stopFirst;
			return stack.state === 'needs-recreate' ||
				stack.state === 'interrupted' ||
				stack.state === 'failed' ||
				(stack.state === 'stopped' && isSupabaseStackLanExposed(stack))
				? undefined
				: SUPABASE_REASONS.recreateOnly;
		case 'reset':
			return running ? undefined : SUPABASE_REASONS.notRunningReset;
		case 'apply-migrations': {
			if (!running) return SUPABASE_REASONS.notRunningMigrations;
			const migrations = context.migrations;
			if (!migrations?.comparable) return undefined;
			if (migrations.state === 'out-of-order') {
				const version = migrations.outOfOrder[0] ?? 'A migration';
				return `${version} sorts before the last applied migration. Reset the database to apply it in order.`;
			}
			if (migrations.state === 'missing-local') {
				return `${migrations.missingLocal.length} applied migrations are missing from this branch. Switch to the branch that has them, or reset the database.`;
			}
			return migrations.state === 'pending'
				? undefined
				: SUPABASE_REASONS.noPending;
		}
		case 'seed-buckets':
			if (stack.excluded.includes('storage')) {
				return SUPABASE_REASONS.storageExcluded;
			}
			if (!stack.bucketsConfigured) return SUPABASE_REASONS.noBuckets;
			return running ? undefined : SUPABASE_REASONS.notRunningSeed;
		case 'export':
			return running ? undefined : SUPABASE_REASONS.notRunningExport;
		case 'enable-studio':
			return stack.studio.included ? SUPABASE_REASONS.studioOn : undefined;
		case 'disable-studio':
			return stack.studio.included || stack.studio.operatorEnabled
				? undefined
				: SUPABASE_REASONS.studioOff;
		case 'open-studio':
			if (!stack.studio.included) return SUPABASE_REASONS.studioExcluded;
			return running && stack.studioUrl !== undefined
				? undefined
				: SUPABASE_REASONS.notRunning;
		case 'open-mailpit':
			if (stack.excluded.includes('mail')) return SUPABASE_REASONS.mailExcluded;
			return running && stack.mailpitUrl !== undefined
				? undefined
				: SUPABASE_REASONS.notRunning;
		case 'copy-api-url':
			return stack.apiUrl ? undefined : SUPABASE_REASONS.apiUrlUnknown;
		case 'copy-key':
			return stack.known.publishableKey
				? undefined
				: SUPABASE_REASONS.keyUnknown;
		case 'copy-psql':
			return running && stack.known.databaseAddress
				? undefined
				: SUPABASE_REASONS.databaseAddressUnknown;
		case 'copy-app-env':
			if (stack.appEnvNames.length === 0) return SUPABASE_REASONS.noAppEnv;
			return stack.apiUrl && stack.known.publishableKey
				? undefined
				: SUPABASE_REASONS.keyUnknown;
		case 'copy-status-command':
			return stack.cli.statusCommand
				? undefined
				: SUPABASE_REASONS.commandUnknown;
		case 'copy-inspect-command':
			return stack.cli.inspectCommand
				? undefined
				: SUPABASE_REASONS.commandUnknown;
		case 'read-logs':
			return stack.state === 'not-created' || stack.state === 'never-started'
				? SUPABASE_REASONS.noLogs
				: undefined;
		case 'logs-auto-refresh':
			return running ? undefined : SUPABASE_REASONS.autoRefresh;
		case 'read-database':
		case 'migration-status':
			return running ? undefined : SUPABASE_REASONS.notRunningDatabase;
		case 'follow-branch':
		case 'release':
			return undefined;
		case 'reveal':
			return undefined;
		case 'cancel-start':
			return undefined;
		case 'restart-metro': {
			if (stack.lanes.length === 0) return SUPABASE_REASONS.noLane;
			const lane = stack.lanes.find((candidate) => candidate.needsMetroRestart);
			if (!lane) return SUPABASE_REASONS.metroCurrent;
			return lane.metro === 'stopped'
				? SUPABASE_REASONS.metroNotRunning
				: undefined;
		}
		case 'inspect':
			return stack.state === 'not-created'
				? SUPABASE_REASONS.notCreated
				: undefined;
	}
}

const UNREADABLE_SKIPS: ReadonlySet<SupabaseAvailabilityCheck> = new Set([
	'mode',
	'release',
	'head',
	'exposure',
	'holder',
	'capacity',
]);

const CHECKS: readonly (readonly [SupabaseAvailabilityCheck, Check])[] = [
	['bridge', checkBridge],
	['off', checkOff],
	['platform', checkPlatform],
	['in-flight', checkInFlight],
	['mode', checkMode],
	['release', checkRelease],
	['head', checkHead],
	['exposure', checkExposure],
	['holder', checkHolder],
	['capacity', checkCapacity],
	['state', stateReason],
];

/**
 * Whether a stack control is available, and the visible reason when not.
 * Checks run in a fixed order and the first failure wins: bridge, feature
 * off, platform, in flight, mode or CLI gate, release mismatch, HEAD,
 * exposure, holder, capacity, state. Main enforces the same function.
 */
export function supabaseActionAvailability(
	stack: SupabaseStackSummary,
	action: SupabaseStackAction,
	context: SupabaseAvailabilityContext
): SupabaseAvailability {
	for (const [check, run] of CHECKS) {
		// Nothing about an unreadable stack is known beyond its id, so only
		// the state check speaks for it.
		if (stack.state === 'unreadable' && UNREADABLE_SKIPS.has(check)) continue;
		const reason = run(stack, action, context);
		if (reason !== undefined) return { allowed: false, reason, check };
	}
	return { allowed: true };
}

export type SupabaseGlobalAction =
	| 'turn-on'
	| 'turn-off'
	| 'refresh'
	| 'update-policy'
	| 'choose-path';

/** Availability of the tab-level controls: on, off, refresh, policy, paths. */
export function supabaseGlobalActionAvailability(
	action: SupabaseGlobalAction,
	context: Readonly<{
		bridgeAvailable: boolean;
		state: Pick<SupabaseState, 'feature' | 'availability' | 'stacks'>;
		pending?: boolean;
	}>
): SupabaseAvailability {
	const refuse = (
		check: SupabaseAvailabilityCheck,
		reason: string
	): SupabaseAvailability => ({ allowed: false, reason, check });
	if (!context.bridgeAvailable)
		return refuse('bridge', SUPABASE_REASONS.bridge);
	const { feature, availability } = context.state;
	switch (action) {
		case 'turn-on':
			if (!availability.platform.supported) {
				return refuse('platform', SUPABASE_REASONS.platform);
			}
			if (context.pending === true) {
				return refuse('in-flight', SUPABASE_REASONS.turningOn);
			}
			// A turn-off that stops managed stacks runs until its last stop:
			// on again before that, its stops would run with the feature on.
			if (feature.disabling !== undefined) {
				return refuse('in-flight', SUPABASE_REASONS.stillTurningOff);
			}
			return feature.enabled
				? refuse('state', 'Local Supabase is already on.')
				: { allowed: true };
		case 'turn-off':
			if (!feature.enabled) {
				return refuse('state', 'Local Supabase is already off.');
			}
			return feature.disabling?.waitingForStarts === true ||
				context.pending === true
				? refuse('in-flight', SUPABASE_REASONS.turningOffWaiting)
				: { allowed: true };
		case 'refresh':
		case 'update-policy':
		case 'choose-path':
			if (!feature.enabled) return refuse('off', SUPABASE_REASONS.off);
			if (!availability.platform.supported) {
				return refuse('platform', SUPABASE_REASONS.platform);
			}
			if (
				action === 'choose-path' &&
				context.state.stacks.some(
					(stack) =>
						(stack.origin === 'managed' || stack.origin === 'adopted') &&
						isLiveStackState(stack.state)
				)
			) {
				return refuse(
					'state',
					'Stop every managed stack before changing the Supabase home.'
				);
			}
			return { allowed: true };
	}
}

export type SupabaseRepositoryAction = 'recheck' | 'set-mode' | 'prepare';

/** Availability of Re-check, Use local Supabase here, and Pre-download services. */
export function supabaseRepositoryActionAvailability(
	repository: SupabaseRepositorySummary,
	action: SupabaseRepositoryAction,
	context: Readonly<{
		bridgeAvailable: boolean;
		state: Pick<SupabaseState, 'feature' | 'availability' | 'jobs' | 'disk'>;
	}>
): SupabaseAvailability {
	const refuse = (
		check: SupabaseAvailabilityCheck,
		reason: string
	): SupabaseAvailability => ({ allowed: false, reason, check });
	if (!context.bridgeAvailable)
		return refuse('bridge', SUPABASE_REASONS.bridge);
	if (!context.state.feature.enabled)
		return refuse('off', SUPABASE_REASONS.off);
	if (action === 'recheck') {
		return repository.readiness === 'checking'
			? refuse('in-flight', 'Checking…')
			: { allowed: true };
	}
	if (action === 'set-mode') return { allowed: true };
	if (!context.state.availability.platform.supported) {
		return refuse('platform', SUPABASE_REASONS.platform);
	}
	const busy = context.state.jobs.some(
		(job) =>
			isActiveSupabaseJob(job) &&
			(job.kind === 'create' || job.kind === 'prepare')
	);
	if (busy) {
		return refuse(
			'in-flight',
			'A stack is being created; the download waits for it.'
		);
	}
	if (repository.counts.managed === 0) {
		return refuse('mode', 'No managed worktree in this repository yet.');
	}
	if (context.state.disk.cacheState === 'warm') {
		const version = repository.cli.version ?? 'this release';
		const size =
			context.state.disk.cacheBytes === undefined
				? ''
				: ` (${formatSupabaseSize(context.state.disk.cacheBytes)} cache)`;
		return refuse(
			'state',
			`Services are already downloaded for Supabase CLI ${version}${size}.`
		);
	}
	return { allowed: true };
}

/** Availability of Review and destroy… / Review and reset… / Deny on a request card. */
export function supabaseRequestActionAvailability(
	request: SupabaseAgentRequest,
	action: 'approve' | 'deny',
	context: Readonly<{
		bridgeAvailable: boolean;
		state: Pick<SupabaseState, 'feature' | 'availability' | 'stacks'>;
		/** Start-capacity requests: the stack the operator chose to stop. */
		stopStackId?: string;
	}>
): SupabaseAvailability {
	const refuse = (
		check: SupabaseAvailabilityCheck,
		reason: string
	): SupabaseAvailability => ({ allowed: false, reason, check });
	if (!context.bridgeAvailable)
		return refuse('bridge', SUPABASE_REASONS.bridge);
	if (!context.state.feature.enabled)
		return refuse('off', SUPABASE_REASONS.off);
	if (request.status === 'settling') {
		return refuse('in-flight', 'This request is already being settled.');
	}
	if (request.status !== 'pending') {
		return refuse('state', 'This request is already settled.');
	}
	if (action === 'deny') return { allowed: true };
	const stack = context.state.stacks.find(
		(candidate) => candidate.id === request.stackId
	);
	if (request.kind === 'start-capacity') {
		if (request.branchMovedTo !== undefined) {
			return refuse(
				'head',
				`The worktree moved to ${request.branchMovedTo} since the request. Dismiss it.`
			);
		}
		if (context.stopStackId === undefined) {
			return refuse('state', 'Choose a stack to stop.');
		}
		// Only a stack the request offers: one RN Devtools manages, running.
		return request.capacity?.candidates.some(
			(candidate) => candidate.stackId === context.stopStackId
		)
			? { allowed: true }
			: refuse(
					'state',
					"That stack isn't one to stop to make room. Choose another."
				);
	}
	if (!stack) {
		return refuse('state', 'The stack is no longer listed. Deny the request.');
	}
	if (stack.state === 'unreadable') {
		return refuse(
			'state',
			"This CLI can't read the stack, so it can't destroy it. Deny the request."
		);
	}
	if (request.kind === 'reset') {
		if (!supabaseHeadMatches(stack))
			return refuse('head', headMutateReason(stack));
		if (stack.pinned) return refuse('holder', SUPABASE_REASONS.pinnedReset);
		return isSupabaseStackRunning(stack)
			? { allowed: true }
			: refuse('state', SUPABASE_REASONS.notRunningReset);
	}
	if (
		request.laneAttached?.running === true &&
		!request.laneAttached.ownedByRequester
	) {
		return refuse(
			'holder',
			`Lane :${request.laneAttached.port} belongs to another session. Stop that lane first, or deny the request.`
		);
	}
	return { allowed: true };
}

/** The clean-up trigger: a non-empty selection made on the current prune revision. */
export function supabaseCleanUpAvailability(
	selection: Readonly<{ stackIds: readonly string[]; revision: number }>,
	context: Readonly<{
		bridgeAvailable: boolean;
		state: Pick<SupabaseState, 'feature' | 'prune'>;
	}>
): SupabaseAvailability {
	if (!context.bridgeAvailable) {
		return { allowed: false, reason: SUPABASE_REASONS.bridge, check: 'bridge' };
	}
	if (!context.state.feature.enabled) {
		return { allowed: false, reason: SUPABASE_REASONS.off, check: 'off' };
	}
	if (selection.stackIds.length === 0) {
		return {
			allowed: false,
			reason: 'Select at least one stack.',
			check: 'state',
		};
	}
	return selection.revision === context.state.prune.revision
		? { allowed: true }
		: {
				allowed: false,
				reason: 'The list changed. Review the selection again.',
				check: 'state',
			};
}

/**
 * The stack controls an operation exercises, so main (and the demo) can
 * enforce exactly what the renderer offered. `start` resolves to create or
 * resume from the stack's state.
 */
export function supabaseOperationActions(
	operation: SupabaseOperation,
	stacks: readonly SupabaseStackSummary[]
): readonly Readonly<{ stackId: string; action: SupabaseStackAction }>[] {
	const one = (stackId: string, action: SupabaseStackAction) => [
		{ stackId, action },
	];
	switch (operation.kind) {
		case 'start': {
			const stack = stacks.find(
				(candidate) => candidate.id === operation.stackId
			);
			const create =
				stack === undefined ||
				stack.state === 'not-created' ||
				stack.state === 'never-started' ||
				stack.state === 'failed';
			return one(operation.stackId, create ? 'start' : 'resume');
		}
		case 'stop':
			return operation.stackIds.map((stackId) => ({ stackId, action: 'stop' }));
		case 'destroy':
			return operation.stackIds.map((stackId) => ({
				stackId,
				action: 'destroy',
			}));
		case 'stop-and-start':
			return one(
				operation.stackId,
				operation.purpose === 'switch-cli' ? 'switch-cli' : 'stop-and-start'
			);
		case 'set-studio':
			return one(
				operation.stackId,
				operation.enabled ? 'enable-studio' : 'disable-studio'
			);
		case 'open':
			return one(
				operation.stackId,
				operation.surface === 'studio' ? 'open-studio' : 'open-mailpit'
			);
		case 'copy': {
			const actions = {
				'api-url': 'copy-api-url',
				'publishable-key': 'copy-key',
				'psql-command': 'copy-psql',
				'app-env': 'copy-app-env',
				'status-command': 'copy-status-command',
				'inspect-command': 'copy-inspect-command',
			} as const satisfies Record<string, SupabaseStackAction>;
			return one(operation.stackId, actions[operation.what]);
		}
		case 'prepare':
			return operation.stackId === undefined
				? []
				: one(operation.stackId, 'prepare');
		case 'read-logs':
		case 'read-database':
		case 'resume-saved':
		case 'restart':
		case 'reapply-exclusions':
		case 'pin':
		case 'unpin':
		case 'release':
		case 'adopt':
		case 'apply-migrations':
		case 'reset':
		case 'seed-buckets':
		case 'export':
		case 'recreate':
		case 'follow-branch':
		case 'reveal':
			return one(operation.stackId, operation.kind);
		default:
			return [];
	}
}

/**
 * The first refusal for an operation, across every control it exercises,
 * or allowed. Stack ids that are not listed are refused as unknown targets.
 */
export function checkSupabaseOperation(
	operation: SupabaseOperation,
	state: SupabaseState,
	context: Readonly<{
		bridgeAvailable: boolean;
		pending?: boolean;
		migrations?: SupabaseMigrationsView;
		now?: number;
	}>
):
	| Readonly<{ allowed: true }>
	| Readonly<{ allowed: false; error: SupabaseErrorView }> {
	const refused = (availability: SupabaseAvailability) =>
		availability.allowed
			? undefined
			: {
					allowed: false as const,
					error:
						availability.check === 'bridge'
							? supabaseDesktopError('unavailable', availability.reason)
							: availability.check === 'off'
								? supabaseDesktopError('feature_off', availability.reason)
								: availability.check === 'platform'
									? supabaseDesktopError(
											'platform_unsupported',
											availability.reason
										)
									: supabaseDesktopError('refused', availability.reason),
				};
	switch (operation.kind) {
		case 'set-enabled':
			return (
				refused(
					supabaseGlobalActionAvailability(
						operation.enabled ? 'turn-on' : 'turn-off',
						{ bridgeAvailable: context.bridgeAvailable, state }
					)
				) ?? { allowed: true }
			);
		case 'refresh':
		case 'update-policy':
		case 'choose-path':
			return (
				refused(
					supabaseGlobalActionAvailability(operation.kind, {
						bridgeAvailable: context.bridgeAvailable,
						state,
					})
				) ?? { allowed: true }
			);
		case 'repository.recheck':
		case 'repository.set-mode': {
			const repository = state.repositories.find(
				(candidate) => candidate.id === operation.repositoryId
			);
			if (!repository) {
				return {
					allowed: false,
					error: supabaseDesktopError(
						'unknown_target',
						'That repository is not tracked.'
					),
				};
			}
			return (
				refused(
					supabaseRepositoryActionAvailability(
						repository,
						operation.kind === 'repository.recheck' ? 'recheck' : 'set-mode',
						{ bridgeAvailable: context.bridgeAvailable, state }
					)
				) ?? { allowed: true }
			);
		}
		case 'request.approve':
		case 'request.deny': {
			const request = state.requests.find(
				(candidate) => candidate.id === operation.requestId
			);
			if (!request) {
				return {
					allowed: false,
					error: supabaseDesktopError(
						'unknown_target',
						'That request has expired.'
					),
				};
			}
			const stopStackId =
				operation.kind === 'request.approve'
					? operation.stopStackId
					: undefined;
			const refusal = refused(
				supabaseRequestActionAvailability(
					request,
					operation.kind === 'request.approve' ? 'approve' : 'deny',
					{
						bridgeAvailable: context.bridgeAvailable,
						state,
						...(stopStackId === undefined ? {} : { stopStackId }),
					}
				)
			);
			if (refusal || request.kind !== 'start-capacity' || !stopStackId) {
				return refusal ?? { allowed: true };
			}
			// Making room stops the chosen stack, under a plain stop's rules.
			const stop = state.stacks.find(
				(candidate) => candidate.id === stopStackId
			);
			if (!stop) {
				return {
					allowed: false,
					error: supabaseDesktopError(
						'unknown_target',
						'That stack is not in a fresh list.'
					),
				};
			}
			return (
				refused(
					supabaseActionAvailability(stop, 'stop', {
						bridgeAvailable: context.bridgeAvailable,
						state,
						...(context.pending === undefined
							? {}
							: { pending: context.pending }),
						...(context.now === undefined ? {} : { now: context.now }),
					})
				) ?? { allowed: true }
			);
		}
		case 'cancel-job': {
			const job = state.jobs.find(
				(candidate) => candidate.id === operation.jobId
			);
			if (!job || !isActiveSupabaseJob(job)) {
				return {
					allowed: false,
					error: supabaseDesktopError(
						'unknown_target',
						'That job has finished.'
					),
				};
			}
			if (job.cancelRequested === true) {
				return {
					allowed: false,
					error: supabaseDesktopError('refused', SUPABASE_REASONS.cancelling),
				};
			}
			return job.cancellable
				? { allowed: true }
				: {
						allowed: false,
						error: supabaseDesktopError(
							'refused',
							'This operation cannot be cancelled.'
						),
					};
		}
		case 'restart-metro': {
			const stack = state.stacks.find((candidate) =>
				candidate.lanes.some((lane) => lane.laneId === operation.laneId)
			);
			if (!stack) {
				return {
					allowed: false,
					error: supabaseDesktopError(
						'unknown_target',
						'The lane has stopped.'
					),
				};
			}
			return (
				refused(
					supabaseActionAvailability(stack, 'restart-metro', {
						bridgeAvailable: context.bridgeAvailable,
						state,
					})
				) ?? { allowed: true }
			);
		}
		case 'prepare':
			if (operation.repositoryId !== undefined) {
				const repository = state.repositories.find(
					(candidate) => candidate.id === operation.repositoryId
				);
				if (!repository) {
					return {
						allowed: false,
						error: supabaseDesktopError(
							'unknown_target',
							'That repository is not tracked.'
						),
					};
				}
				return (
					refused(
						supabaseRepositoryActionAvailability(repository, 'prepare', {
							bridgeAvailable: context.bridgeAvailable,
							state,
						})
					) ?? { allowed: true }
				);
			}
			break;
		case 'stop':
			if (
				operation.stackIds.length > 1 &&
				operation.stackIds.some(
					(id) =>
						state.stacks.find((candidate) => candidate.id === id)?.origin ===
						'external'
				)
			) {
				return {
					allowed: false,
					error: supabaseDesktopError(
						'refused',
						'External stacks are stopped one at a time from their detail.'
					),
				};
			}
			break;
		case 'release': {
			const stack = state.stacks.find(
				(candidate) => candidate.id === operation.stackId
			);
			if (
				stack &&
				!stack.holds.some((hold) => supabaseHoldMatches(hold, operation.holder))
			) {
				return {
					allowed: false,
					error: supabaseDesktopError(
						'unknown_target',
						'That hold is no longer listed.'
					),
				};
			}
			break;
		}
		case 'destroy':
			if (
				operation.pruneRevision !== undefined &&
				operation.pruneRevision !== state.prune.revision
			) {
				return {
					allowed: false,
					error: supabaseDesktopError(
						'stale_selection',
						'The list changed. Review the selection again.'
					),
				};
			}
			break;
		default:
			break;
	}
	for (const target of supabaseOperationActions(operation, state.stacks)) {
		const stack = state.stacks.find(
			(candidate) => candidate.id === target.stackId
		);
		if (!stack) {
			return {
				allowed: false,
				error: supabaseDesktopError(
					operation.kind === 'destroy' ? 'stale_selection' : 'unknown_target',
					'That stack is not in a fresh list.'
				),
			};
		}
		const availability = supabaseActionAvailability(stack, target.action, {
			bridgeAvailable: context.bridgeAvailable,
			state,
			...(context.pending === undefined ? {} : { pending: context.pending }),
			...(context.migrations === undefined
				? {}
				: { migrations: context.migrations }),
			...(context.now === undefined ? {} : { now: context.now }),
		});
		const refusal = refused(availability);
		if (refusal) return refusal;
	}
	return { allowed: true };
}

/**
 * Live agents an operation would interrupt, for the renderer's inline
 * ConfirmAction. Never shown in front of a native dialog, so operations the
 * dialog guards return none; Cancel start and Re-seed always confirm inline.
 */
export function supabaseInlineConfirmation(
	operation: SupabaseOperation,
	state: Pick<SupabaseState, 'stacks' | 'requests' | 'policy' | 'jobs'>
): Readonly<{ required: boolean; agents: readonly string[] }> {
	if (supabaseConfirmationRequired(operation, state)) {
		return { required: false, agents: [] };
	}
	const liveAgents = (stackId: string | undefined) => {
		const stack = state.stacks.find((candidate) => candidate.id === stackId);
		return stack ? supabaseLiveAgentLabels(stack) : [];
	};
	switch (operation.kind) {
		case 'cancel-job':
			return { required: true, agents: [] };
		case 'seed-buckets':
			return { required: true, agents: liveAgents(operation.stackId) };
		case 'stop': {
			const agents = [...new Set(operation.stackIds.flatMap(liveAgents))].slice(
				0,
				3
			);
			return { required: agents.length > 0, agents };
		}
		case 'restart':
		case 'stop-and-start':
		case 'reapply-exclusions':
		case 'apply-migrations':
		case 'set-studio': {
			const agents = liveAgents(operation.stackId);
			return { required: agents.length > 0, agents };
		}
		case 'release': {
			const stack = state.stacks.find(
				(candidate) => candidate.id === operation.stackId
			);
			const hold = stack?.holds.find(
				(candidate) =>
					candidate.holder !== 'lane' &&
					candidate.holder !== 'operator' &&
					supabaseHoldMatches(candidate, operation.holder)
			);
			return hold?.live === true &&
				hold.holder !== 'lane' &&
				hold.holder !== 'operator'
				? { required: true, agents: [supabaseAgentLabel(hold.agent)] }
				: { required: false, agents: [] };
		}
		case 'request.approve': {
			const agents = liveAgents(operation.stopStackId);
			return { required: agents.length > 0, agents };
		}
		default:
			return { required: false, agents: [] };
	}
}

/**
 * Labels of the live agents holding a stack, through a lane or a hold.
 */
export function supabaseLiveAgentLabels(
	stack: Pick<SupabaseStackSummary, 'holds'>
): readonly string[] {
	return [
		...new Set(
			stack.holds.flatMap((hold) =>
				hold.live && hold.holder !== 'operator' && hold.agent
					? [supabaseAgentLabel(hold.agent)]
					: []
			)
		),
	];
}

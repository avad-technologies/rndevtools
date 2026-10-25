import type { AgentSession, AgentState } from '../../shared/agent-protocol';
import type { DeviceHolder, HolderLiveness } from '../../shared/device-hold';
import type { Lane, LaneWorktree } from '../../shared/lane-protocol';
import {
	type LaneBackendSummary,
	type LaneWorktreeSupabase,
	SUPABASE_LANE_WAIT_MS,
	SUPABASE_UNREADABLE_RECOVERY,
	type SupabaseAgentOperation,
	type SupabaseAgentResult,
	type SupabaseDoctorInfo,
	type SupabaseErrorView,
	type SupabaseInterest,
	type SupabaseJob,
	type SupabaseOperation,
	type SupabaseOperationReceipt,
	type SupabaseState,
	supabaseDesktopError,
	supabaseErrorSchema,
} from '../../shared/supabase-protocol';
import type { ClassifiedSupabaseError } from './cli-errors';

/**
 * The seams between the Supabase service and everything around it: what the
 * service offers (IPC, lanes, the agent router, AgentService's holder
 * clocks, the steering writer), and what it needs injected (lanes, agent
 * sessions, Electron's dialog, shell and clipboard). Types only, plus small
 * pure helpers that keep both sides of a seam in step.
 */

// ---------------------------------------------------------------------------
// Who is asking

/**
 * The operator, through a trusted renderer (`senderId` binds confirmation
 * tokens and owns the dialog window), or an agent session through the CLI
 * socket. A synthetic agent (`mcp-*`) is matched by `sessionCwd`.
 */
type SupabaseActor =
	| Readonly<{ kind: 'operator'; senderId: number }>
	| Readonly<{
			kind: 'agent';
			holder: DeviceHolder;
			synthetic: boolean;
			sessionCwd?: string | undefined;
	  }>;

export type SupabaseOperationContext = Readonly<{
	actor: SupabaseActor;
	/**
	 * The IPC layer consumed a valid one-time token bound to exactly this
	 * operation (same actionId, ids, removeUploads, disposition).
	 */
	confirmed: boolean;
	signal?: AbortSignal | undefined;
}>;

/**
 * An agent's `supabase` call, with the identity from its request envelope.
 */
export type SupabaseAgentContext = Readonly<{
	requestId: string;
	/** Absent when the CLI could not tell which session it runs in. */
	holder?: DeviceHolder | undefined;
	synthetic: boolean;
	/** Where the session works; how a synthetic holder is matched. */
	sessionCwd?: string | undefined;
}>;

// ---------------------------------------------------------------------------
// Native confirmation

/**
 * What the main-owned dialog says, derived by main from a fresh stack list
 * and its own records. Never agent free text. Cancel is always button 0,
 * the default and the cancel id, so Return and Esc cancel.
 */
export type SupabaseConfirmationFacts = Readonly<{
	title: string;
	/** The dialog's detail, one fact per line, already sanitized. */
	lines: readonly string[];
	/**
	 * The buttons after Cancel. Usually one verb ("Destroy feat-x (71 MB)");
	 * turning off offers "Leave them running" and "Stop managed stacks".
	 */
	choices: readonly Readonly<{
		label: string;
		disposition?: 'leave-running' | 'stop-managed';
	}>[];
	/** Destroy's "Also delete Storage uploads" box; its state comes back as removeUploads. */
	checkbox?: Readonly<{ label: string; checkedByDefault: boolean }>;
}>;

/** The subset of Electron's MessageBoxOptions the Supabase dialogs use. */
export type SupabaseMessageBoxOptions = Readonly<{
	type: 'warning';
	title: string;
	message: string;
	detail: string;
	buttons: readonly string[];
	defaultId: 0;
	cancelId: 0;
	noLink: true;
	checkboxLabel?: string;
	checkboxChecked?: boolean;
}>;

/** The dialog options for a set of facts: Cancel first and default. */
export function supabaseMessageBoxOptions(
	facts: SupabaseConfirmationFacts
): SupabaseMessageBoxOptions {
	return {
		type: 'warning',
		title: facts.title,
		message: facts.title,
		detail: facts.lines.join('\n'),
		buttons: ['Cancel', ...facts.choices.map((choice) => choice.label)],
		defaultId: 0,
		cancelId: 0,
		noLink: true,
		...(facts.checkbox
			? {
					checkboxLabel: facts.checkbox.label,
					checkboxChecked: facts.checkbox.checkedByDefault,
				}
			: {}),
	};
}

/**
 * Reads the dialog's answer: confirmed unless Cancel (or an unknown button)
 * was chosen, with the options the token must then be bound to.
 */
export function supabaseConfirmationOutcome(
	facts: SupabaseConfirmationFacts,
	answer: Readonly<{ response: number; checkboxChecked?: boolean }>
): Readonly<{
	confirmed: boolean;
	options: Readonly<{
		removeUploads?: boolean;
		disposition?: 'leave-running' | 'stop-managed';
	}>;
}> {
	const choice =
		Number.isInteger(answer.response) && answer.response > 0
			? facts.choices[answer.response - 1]
			: undefined;
	if (!choice) return { confirmed: false, options: {} };
	return {
		confirmed: true,
		options: {
			...(facts.checkbox
				? { removeUploads: answer.checkboxChecked === true }
				: {}),
			...(choice.disposition ? { disposition: choice.disposition } : {}),
		},
	};
}

// ---------------------------------------------------------------------------
// Injected Electron capabilities

/**
 * Identifies the renderer that asked, so a dialog can be modal to its window.
 */
export type SupabaseDialogOwner = Readonly<{ senderId: number }>;

export type SupabaseDialogPort = Readonly<{
	showMessageBox: (
		options: SupabaseMessageBoxOptions,
		owner?: SupabaseDialogOwner
	) => Promise<Readonly<{ response: number; checkboxChecked: boolean }>>;
	/** Export: main picks the file; the renderer never names it. */
	showSaveDialog: (
		options: Readonly<{
			title: string;
			buttonLabel: string;
			defaultPath: string;
			filters: readonly Readonly<{
				name: string;
				extensions: readonly string[];
			}>[];
		}>,
		owner?: SupabaseDialogOwner
	) => Promise<Readonly<{ canceled: boolean; filePath?: string | undefined }>>;
	/** Paths (P5): the Supabase home or an SSL bundle. */
	showOpenDialog: (
		options: Readonly<{
			title: string;
			buttonLabel: string;
			properties: readonly ('openDirectory' | 'openFile' | 'createDirectory')[];
			defaultPath?: string;
		}>,
		owner?: SupabaseDialogOwner
	) => Promise<Readonly<{ canceled: boolean; filePaths: readonly string[] }>>;
}>;

export type SupabaseShellPort = Readonly<{
	/** Only main-validated loopback http URLs (Mailpit, Studio). */
	openExternal: (url: string) => Promise<void>;
	/** Only main-resolved paths (stack folder, uploads, config, an export). */
	showItemInFolder: (path: string) => void;
}>;

/**
 * Main writes keys, the psql command and app variables itself, then clears
 * the clipboard after SUPABASE_CLIPBOARD_CLEAR_MS if it still holds that text.
 */
export type SupabaseClipboardPort = Readonly<{
	/** Electron's main-process clipboard is promise-based. */
	writeText: (text: string) => Promise<void>;
	readText: () => Promise<string>;
}>;

// ---------------------------------------------------------------------------
// What the service needs from lanes and agents

export type SupabaseMetroRestartReason =
	| 'attach'
	| 'ports-moved'
	| 'follow'
	| 'detach'
	| 'operator';

/**
 * What the Supabase service reads from and asks of the lane service.
 */
export type SupabaseLanePort = Readonly<{
	lanes: () => readonly Lane[];
	laneById: (laneId: string) => Lane | undefined;
	worktrees: () => readonly LaneWorktree[];
	/** Tracked repository roots. */
	repositories: () => readonly string[];
	/**
	 * A PID-verified Metro stop and a restart on the same port, which asks the
	 * Supabase service for the lane's env again.
	 */
	restartMetro: (
		laneId: string,
		reason: SupabaseMetroRestartReason
	) => Promise<void>;
	/** Opens the dev client a late attach was holding back. */
	launchDeferred: (laneId: string) => Promise<void>;
	subscribe: (listener: () => void) => () => void;
}>;

/**
 * What the Supabase service reads from the agent service.
 */
export type SupabaseAgentPort = Readonly<{
	sessions: () => readonly AgentSession[];
	/** The shared resolver, on the same clocks as Simulator holds. */
	holderLiveness: (holder: DeviceHolder, directory?: string) => HolderLiveness;
	/** Whether each agent kind's sessions can be read right now. */
	discovery: () => Pick<AgentState['discovery'], 'claude' | 'codex'>;
	subscribe: (listener: () => void) => () => void;
}>;

/**
 * A holder the service names, with the directory its stack lives in: the
 * element type of AgentService's `holders` option, so their clocks run.
 */
export type SupabaseHolderKey = Readonly<{
	holder: DeviceHolder;
	directory?: string | undefined;
}>;

// ---------------------------------------------------------------------------
// Lanes ↔ Supabase

export type LaneBackendEnsureInput = Readonly<{
	laneId?: string | undefined;
	/** The checkout root. */
	worktreePath: string;
	/** The Expo app directory when it is not the root. */
	appPath?: string | undefined;
	branch: string;
	environmentId: string;
	policy: 'auto' | 'off' | 'required';
	agent?: Readonly<{ kind: 'claude' | 'codex' | 'other'; sessionId: string }>;
	/** How long the lane may wait past Metro's spawn; SUPABASE_LANE_WAIT_MS by default. */
	waitMs?: number | undefined;
}>;

export type LaneBackendLateAttach = Readonly<{
	summary: LaneBackendSummary;
	/** Public values only (URL, publishable or anon key) under the mapped names. */
	laneEnv?: Readonly<Record<string, string>> | undefined;
}>;

export type LaneBackendEnsureResult = Readonly<{
	summary: LaneBackendSummary;
	/** Public values for the Metro spawn env, when the backend is ready now. */
	laneEnv?: Readonly<Record<string, string>> | undefined;
	/**
	 * Present when the stack was not ready within the wait: resolves once it
	 * is (or fails), so the lane can restart Metro with laneEnv and launch.
	 * It never rejects; failures come back as a summary.
	 */
	lateAttach?: Promise<LaneBackendLateAttach> | undefined;
}>;

/** The default in-lane wait, re-exported for the lane service. */
export const LANE_BACKEND_DEFAULT_WAIT_MS = SUPABASE_LANE_WAIT_MS;

// ---------------------------------------------------------------------------
// Steering (the Go PreToolUse hook)

export type SteeringRoot = Readonly<{
	/** The worktree root. */
	root: string;
	/** The Supabase project root (holds supabase/config.toml). */
	projectRoot: string;
	branchContext: string;
	/** The branch's stack exists and runs; while false, shadow creators are blocked. */
	stackReady: boolean;
	/** The worktree's runner, e.g. `pnpm exec supabase`. */
	runner: string;
}>;

export type SteeringSnapshot = Readonly<{
	enabled: boolean;
	desktopPid: number;
	writtenAt: number;
	managedRoots: readonly SteeringRoot[];
}>;

/**
 * steering.json v1 as the Go hook reads it (0600, in the agent socket's 0700
 * directory). No Supabase rules apply when `supabase.enabled` is false.
 */
export type SupabaseSteeringFile = {
	version: 1;
	writtenAt: number;
	desktopPid: number;
	supabase: {
		enabled: boolean;
		roots: {
			worktreeRoot: string;
			projectRoot: string;
			mode: 'managed';
			branchContext: string;
			stackReady: boolean;
			runner: string;
		}[];
	};
};

/** Serializes a snapshot to the on-disk shape; a disabled snapshot lists no roots. */
export function supabaseSteeringFile(
	snapshot: SteeringSnapshot
): SupabaseSteeringFile {
	return {
		version: 1,
		writtenAt: snapshot.writtenAt,
		desktopPid: snapshot.desktopPid,
		supabase: {
			enabled: snapshot.enabled,
			roots: snapshot.enabled
				? snapshot.managedRoots.map((root) => ({
						worktreeRoot: root.root,
						projectRoot: root.projectRoot,
						mode: 'managed',
						branchContext: root.branchContext,
						stackReady: root.stackReady,
						runner: root.runner,
					}))
				: [],
		},
	};
}

// ---------------------------------------------------------------------------
// The service

export type SupabaseReleaseResult = Readonly<{
	/** Stacks this release dropped a hold on. */
	releasedStackIds: readonly string[];
	/** Of those, the stacks now unheld that will stop after the linger. */
	pendingStops: readonly string[];
}>;

/**
 * What the Supabase service offers. One owner of Supabase state in main;
 * IPC, lanes, the agent router, AgentService and the steering writer all go
 * through it.
 */
export interface SupabaseServiceApi {
	getState(): SupabaseState;
	/** Coalesced to 100 ms, only on change. */
	subscribe(listener: (state: SupabaseState) => void): () => void;
	/**
	 * Runs a renderer operation after the IPC layer validated it and, for
	 * the kinds in SUPABASE_CONFIRMATION_KINDS, consumed its token. Re-checks
	 * availability (checkSupabaseOperation) against a fresh list.
	 */
	runOperation(
		operation: SupabaseOperation,
		context: SupabaseOperationContext
	): Promise<SupabaseOperationReceipt>;
	/** The native dialog's facts, or undefined when no dialog is required. */
	describeConfirmation(
		operation: SupabaseOperation
	): Promise<SupabaseConfirmationFacts | undefined>;
	/** Per renderer; the union decides what main polls. Never extends auto-stop. */
	setInterest(senderKey: string, interest: SupabaseInterest): void;
	/** Lane up: ensure the worktree's stack within the wait, else attach late. */
	ensureForLane(
		input: LaneBackendEnsureInput,
		signal?: AbortSignal
	): Promise<LaneBackendEnsureResult>;
	/** Lane down: drop the lane's hold without waiting for a stop. */
	detachLane(laneId: string): void;
	/**
	 * A tracked worktree's project for the lane start form, from what main
	 * already read; undefined while off, unread, or its repository is off.
	 */
	describeWorktree(worktreePath: string): LaneWorktreeSupabase | undefined;
	runAgentOperation(
		operation: SupabaseAgentOperation,
		context: SupabaseAgentContext,
		signal: AbortSignal
	): Promise<SupabaseAgentResult>;
	/** `release --all` / SessionEnd: in memory first, stops queued, within 2 s. */
	releaseHolder(
		input: Readonly<{
			holder?: DeviceHolder | undefined;
			sessionCwd?: string | undefined;
		}>
	): Promise<SupabaseReleaseResult>;
	job(jobId: string): SupabaseJob | undefined;
	/** Resolves with the job once terminal or at the timeout; undefined when lost. */
	waitForJob(
		jobId: string,
		timeoutMs: number,
		signal?: AbortSignal
	): Promise<SupabaseJob | undefined>;
	doctor(): SupabaseDoctorInfo;
	/** Every holder the service names, for AgentService's holder clocks. */
	holderKeys(): readonly SupabaseHolderKey[];
	steering(): SteeringSnapshot;
	start(): Promise<void>;
	/** Clears timers and waits at most 15 s for lifecycle children; never stops stacks. */
	stop(): Promise<void>;
}

/** What main's index.ts builds the Supabase service from. */
export type SupabaseServiceDeps = Readonly<{
	/** Electron's userData; the service root is `<userData>/supabase` (0700). */
	userDataDirectory: string;
	/** The agent socket's 0700 directory, where steering.json lives. */
	agentSocketDirectory: string;
	lanes: SupabaseLanePort;
	agents: SupabaseAgentPort;
	dialog: SupabaseDialogPort;
	shell: SupabaseShellPort;
	clipboard: SupabaseClipboardPort;
	/**
	 * Serve the in-memory demo stacks and run nothing: an unpackaged build
	 * started with RNDEVTOOLS_DEMO=true (see demo-mode.ts).
	 */
	demo: boolean;
	/** `process.platform`, `process.arch` and the macOS version, e.g. `15.1.0`. */
	platform: Readonly<{
		platform: string;
		arch: string;
		macosVersion?: string | undefined;
	}>;
	now?: (() => number) | undefined;
	/** Redacted, bounded diagnostic lines; nothing is logged when absent. */
	log?: ((line: string) => void) | undefined;
}>;

export type CreateSupabaseService = (
	deps: SupabaseServiceDeps
) => SupabaseServiceApi;

// ---------------------------------------------------------------------------
// Errors for the renderer

function clamp(value: string, max: number): string {
	if (value.length <= max) return value;
	const cut = value.slice(0, max);
	const last = cut.charCodeAt(max - 1);
	return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Strips control characters (keeping newlines and tabs when asked) and bounds. */
function displayText(value: string, max: number, multiline = false): string {
	let output = '';
	for (const character of value) {
		const code = character.charCodeAt(0);
		const keep = multiline && (code === 0x0a || code === 0x09);
		output +=
			!keep && (code <= 0x1f || (code >= 0x7f && code <= 0x9f))
				? ' '
				: character;
	}
	return clamp(output, max);
}

const RELEASE = /^[0-9A-Za-z.+-]{1,80}$/;
const STACK_ID = /^[0-9a-f]{64}$/;
const RUNTIMES = new Set(['native', 'docker', 'podman']);

/**
 * Projects main's ClassifiedSupabaseError into the renderer-safe shape:
 * bounded, control-free text, display-safe details only, a holder's project
 * root turned into a label, and the corrected copy for unreadable stacks
 * (never offered Destroy). Falls back to an internal error when the result
 * would not parse.
 */
export function toSupabaseErrorView(
	error: ClassifiedSupabaseError,
	options: Readonly<{ pathLabel?: (absolutePath: string) => string }> = {}
): SupabaseErrorView {
	const label = options.pathLabel ?? ((value: string) => value);
	const details = error.details;
	const holderRoot = details.holderProjectRoot;
	const holderLabel =
		holderRoot === undefined
			? undefined
			: displayText(label(holderRoot), 1_024);
	// The holder's absolute root is shown as the same label everywhere.
	const relabel = (text: string) =>
		holderRoot !== undefined && holderLabel !== undefined
			? text.split(holderRoot).join(holderLabel)
			: text;
	const recovery = relabel(
		error.code === 'unreadable' ? SUPABASE_UNREADABLE_RECOVERY : error.recovery
	);
	const view = {
		code: error.code,
		title: displayText(error.title, 256),
		message: displayText(relabel(error.message), 4_096, true),
		recovery: displayText(recovery, 2_048, true),
		retry: error.retry,
		details: {
			...(details.upstreamCode === undefined
				? {}
				: { upstreamCode: details.upstreamCode }),
			...(details.upstreamSuggestion === undefined
				? {}
				: {
						upstreamSuggestion: displayText(
							details.upstreamSuggestion,
							1_024,
							true
						),
					}),
			...(details.stackId !== undefined &&
			/^[0-9a-f]{4,64}$/.test(details.stackId)
				? { stackId: details.stackId }
				: {}),
			...(details.port === undefined ? {} : { port: details.port }),
			...(details.key === undefined
				? {}
				: { key: displayText(details.key, 64) }),
			...(details.portProblem === undefined
				? {}
				: { portProblem: details.portProblem }),
			...(holderLabel ? { holderProjectLabel: holderLabel } : {}),
			...(details.holderStackId !== undefined &&
			STACK_ID.test(details.holderStackId)
				? { holderStackId: details.holderStackId }
				: {}),
			...(details.ownerRelease !== undefined &&
			RELEASE.test(details.ownerRelease)
				? { ownerRelease: details.ownerRelease }
				: {}),
			...(details.clientRelease !== undefined &&
			RELEASE.test(details.clientRelease)
				? { clientRelease: details.clientRelease }
				: {}),
			...(details.requestedRuntime !== undefined &&
			RUNTIMES.has(details.requestedRuntime)
				? {
						requestedRuntime: details.requestedRuntime as
							| 'native'
							| 'docker'
							| 'podman',
					}
				: {}),
			...(details.existingRuntime !== undefined &&
			RUNTIMES.has(details.existingRuntime)
				? {
						existingRuntime: details.existingRuntime as
							| 'native'
							| 'docker'
							| 'podman',
					}
				: {}),
			...(details.migrationDrift === undefined
				? {}
				: { migrationDrift: details.migrationDrift }),
			...(details.stackChanges === undefined
				? {}
				: {
						stackChanges: details.stackChanges.slice(0, 64).map((change) => ({
							...(change.service === undefined
								? {}
								: { service: displayText(change.service, 64) }),
							...(change.path === undefined
								? {}
								: { path: displayText(change.path, 256) }),
							...(change.key === undefined
								? {}
								: { key: displayText(change.key, 256) }),
							...(change.saved === undefined
								? {}
								: { saved: displayText(change.saved, 256) }),
							...(change.requested === undefined
								? {}
								: { requested: displayText(change.requested, 256) }),
							editable: change.editable,
						})),
					}),
			...(details.recreateStackId !== undefined &&
			STACK_ID.test(details.recreateStackId)
				? { recreateStackId: details.recreateStackId }
				: {}),
			...(details.destroyedStackIds === undefined
				? {}
				: {
						destroyedStackIds: details.destroyedStackIds
							.filter((id) => STACK_ID.test(id))
							.slice(0, 64),
					}),
			...(details.exitCode === undefined || !Number.isInteger(details.exitCode)
				? {}
				: { exitCode: details.exitCode }),
			...(details.timedOut === true ? { timedOut: true as const } : {}),
			...(details.cancelled === true ? { cancelled: true as const } : {}),
			...(details.unexpectedOutput === true
				? { unexpectedOutput: true as const }
				: {}),
		},
	};
	const parsed = supabaseErrorSchema.safeParse(view);
	return parsed.success
		? parsed.data
		: supabaseDesktopError(
				'internal',
				'The Supabase CLI failed in a way RN Devtools could not describe.'
			);
}

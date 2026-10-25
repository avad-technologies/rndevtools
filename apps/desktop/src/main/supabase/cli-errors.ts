import {
	SUPABASE_UNREADABLE_RECOVERY,
	supabaseRevertKeepsStack,
} from '../../shared/supabase-protocol';
import {
	parseSupabaseErrorEnvelope,
	parseSupabaseReleaseMismatch,
	type SupabaseErrorEnvelope,
	type SupabaseStackChange,
} from './cli-contract';
import { sanitizeSupabaseText } from './cli-redact';
import { parseSupabaseJsonLine, type SupabaseCliRunResult } from './cli-runner';

/**
 * Turns a failed Supabase CLI call into a typed, UI-ready error. The CLI's
 * error envelope carries only the thrown error's tag as `code` (the internal
 * reason is not serialized), so classification pairs that code with message
 * patterns recorded against the verified release. The upstream message is
 * kept, redacted and bounded, as secondary detail; titles and recovery text
 * are RN Devtools' own, because some upstream suggestions are wrong for
 * native stacks ("Make sure Docker is running").
 */

export type SupabaseErrorCode =
	| 'not_found'
	| 'not_running'
	| 'cli_mismatch'
	| 'needs_recreate'
	| 'container_runtime'
	| 'ports_pinned'
	| 'ports_conflict'
	| 'partial'
	| 'busy'
	| 'capacity'
	| 'unreadable'
	| 'migration_drift'
	| 'migration_failed'
	| 'reset_failed_partial'
	| 'confirm_required'
	| 'flag_misuse'
	| 'failed';

/**
 * How the caller may retry: never, once (stop then start), or with backoff.
 */
type SupabaseErrorRetry = 'none' | 'once' | 'backoff';

type SupabasePortProblem =
	| 'held-by-stack'
	| 'held-by-process'
	| 'own-listener'
	| 'reserved-range'
	| 'exhausted'
	| 'collision';

/**
 * Structured facts pulled from the failure; every field is display-safe.
 */
type SupabaseErrorDetails = Readonly<{
	upstreamCode?: string;
	/** The CLI's own suggestion, when it is not misleading for native stacks. */
	upstreamSuggestion?: string;
	stackId?: string;
	port?: number;
	key?: string;
	portProblem?: SupabasePortProblem;
	/** Project root of the stack that holds a pinned port. */
	holderProjectRoot?: string;
	holderStackId?: string;
	ownerRelease?: string;
	clientRelease?: string;
	requestedRuntime?: string;
	existingRuntime?: string;
	migrationDrift?: 'missing-local' | 'missing-remote';
	stackChanges?: readonly SupabaseStackChange[];
	/** The stack a recreate would replace; never a command to run. */
	recreateStackId?: string;
	destroyedStackIds?: readonly string[];
	exitCode?: number;
	timedOut?: boolean;
	cancelled?: boolean;
	unexpectedOutput?: boolean;
	/** More output than the runner reads: a smaller read may fit. Main only. */
	stdoutTruncated?: boolean;
}>;

export type ClassifiedSupabaseError = Readonly<{
	code: SupabaseErrorCode;
	title: string;
	/** The upstream message, redacted and at most 4096 characters. */
	message: string;
	recovery: string;
	retry: SupabaseErrorRetry;
	details: SupabaseErrorDetails;
}>;

export type SupabaseFailureInput = Readonly<{
	envelope?: SupabaseErrorEnvelope | undefined;
	exitCode?: number | null | undefined;
	/** Sanitized stderr lines from the run. */
	stderrLines?: readonly string[] | undefined;
	timedOut?: boolean | undefined;
	cancelled?: boolean | undefined;
}>;

const MESSAGE_MAX_CHARS = 4096;

type MutableDetails = {
	-readonly [Key in keyof SupabaseErrorDetails]: SupabaseErrorDetails[Key];
};

type Match = Readonly<{
	code: SupabaseErrorCode;
	retry?: SupabaseErrorRetry;
	details?: MutableDetails;
}>;

type RuleContext = Readonly<{
	upstream: string | undefined;
	text: string;
	envelope: SupabaseErrorEnvelope | undefined;
}>;

type Rule = (context: RuleContext) => Match | undefined;

function codeIn(context: RuleContext, codes: readonly string[]): boolean {
	return context.upstream !== undefined && codes.includes(context.upstream);
}

function portNumber(value: string | undefined): number | undefined {
	const port = Number(value);
	return Number.isInteger(port) && port >= 1 && port <= 65_535
		? port
		: undefined;
}

function portDetails(
	port: string | undefined,
	key: string | undefined,
	portProblem: SupabasePortProblem
): MutableDetails {
	const details: MutableDetails = { portProblem };
	const parsedPort = portNumber(port);
	if (parsedPort !== undefined) details.port = parsedPort;
	if (key !== undefined) details.key = key.slice(0, 64);
	return details;
}

const PORT_HELD_BY_PROJECT =
	/Public port (\d{1,5}) for ([^\s;]{1,64}) is in use by the stack of project (.{1,4096}) \(stack ([0-9a-f]{64})\)/;
const PORT_HELD_BY_STACK =
	/Public port (\d{1,5}) for ([^\s;]{1,64}) is in use by stack ([0-9a-f]{64})/;
const PORT_HELD_BY_PROCESS =
	/Port (\d{1,5}) for ([^\s;]{1,64}) at \S+ is in use by another process/;
const PORT_OWN_LISTENER =
	/Public port (\d{1,5}) for ([^\s;]{1,64}) is claimed by another listener of this stack/;
const PORT_RESERVED_RANGE =
	/Public port (\d{1,5}) for ([^\s;]{1,64}) is inside \d+-\d+/;

const RULES: readonly Rule[] = [
	(context) => {
		const envelope = context.envelope;
		if (
			(envelope?.stackChanges.length ?? 0) === 0 &&
			envelope?.recreateSuggested !== true &&
			!/The saved stack cannot adopt these changes/.test(context.text)
		) {
			return undefined;
		}
		const details: MutableDetails = {};
		if (envelope !== undefined && envelope.stackChanges.length > 0) {
			details.stackChanges = envelope.stackChanges;
		}
		if (envelope?.recreateStackId !== undefined) {
			details.recreateStackId = envelope.recreateStackId;
		}
		return { code: 'needs_recreate', details };
	},
	(context) => {
		const mismatch = parseSupabaseReleaseMismatch(context.text);
		if (mismatch === undefined) return undefined;
		const details: MutableDetails = {
			ownerRelease: mismatch.ownerRelease,
			clientRelease: mismatch.clientRelease,
		};
		if (mismatch.stackId !== undefined) details.stackId = mismatch.stackId;
		return { code: 'cli_mismatch', details };
	},
	(context) => {
		const match =
			/Requested runtime (native|docker|podman) does not match existing stack runtime (native|docker|podman)/.exec(
				context.text
			);
		const requestedRuntime = match?.[1];
		const existingRuntime = match?.[2];
		if (requestedRuntime === undefined || existingRuntime === undefined) {
			return undefined;
		}
		return {
			code: 'container_runtime',
			details: { requestedRuntime, existingRuntime },
		};
	},
	(context) => {
		const project = PORT_HELD_BY_PROJECT.exec(context.text);
		if (project !== null) {
			const details = portDetails(project[1], project[2], 'held-by-stack');
			const holderProjectRoot = project[3];
			const holderStackId = project[4];
			if (holderProjectRoot !== undefined) {
				details.holderProjectRoot = holderProjectRoot;
			}
			if (holderStackId !== undefined) details.holderStackId = holderStackId;
			return { code: 'ports_pinned', details };
		}
		const stack = PORT_HELD_BY_STACK.exec(context.text);
		if (stack === null) return undefined;
		const details = portDetails(stack[1], stack[2], 'held-by-stack');
		const holderStackId = stack[3];
		if (holderStackId !== undefined) details.holderStackId = holderStackId;
		return { code: 'ports_pinned', details };
	},
	(context) => {
		const otherProcess = PORT_HELD_BY_PROCESS.exec(context.text);
		if (otherProcess !== null) {
			return {
				code: 'ports_conflict',
				details: portDetails(
					otherProcess[1],
					otherProcess[2],
					'held-by-process'
				),
			};
		}
		const own = PORT_OWN_LISTENER.exec(context.text);
		if (own !== null) {
			return {
				code: 'ports_conflict',
				details: portDetails(own[1], own[2], 'own-listener'),
			};
		}
		const reserved = PORT_RESERVED_RANGE.exec(context.text);
		if (reserved !== null) {
			return {
				code: 'ports_conflict',
				details: portDetails(reserved[1], reserved[2], 'reserved-range'),
			};
		}
		if (/No public port is available/.test(context.text)) {
			return {
				code: 'ports_conflict',
				retry: 'once',
				details: { portProblem: 'exhausted' },
			};
		}
		if (/native port collision/.test(context.text)) {
			return {
				code: 'ports_conflict',
				retry: 'once',
				details: { portProblem: 'collision' },
			};
		}
		return undefined;
	},
	(context) =>
		/partial lifecycle state/i.test(context.text)
			? { code: 'partial', retry: 'once' }
			: undefined,
	(context) =>
		/Another process holds the stack lease|Another owner is sweeping this stack|Stack registry is locked|Stack owner did not become reachable|Timed out waiting for owner readiness/i.test(
			context.text
		)
			? { code: 'busy', retry: 'backoff' }
			: undefined,
	(context) =>
		/No space left on device|could not create shared memory segment|\bshmget\b|\bENOSPC\b/i.test(
			context.text
		)
			? { code: 'capacity' }
			: undefined,
	(context) =>
		/could not be read/i.test(context.text) ||
		codeIn(context, ['ExperimentalStackListError'])
			? { code: 'unreadable' }
			: undefined,
	(context) => {
		if (codeIn(context, ['MigrationMissingLocalError'])) {
			return {
				code: 'migration_drift',
				details: { migrationDrift: 'missing-local' },
			};
		}
		if (codeIn(context, ['MigrationMissingRemoteError'])) {
			return {
				code: 'migration_drift',
				details: { migrationDrift: 'missing-remote' },
			};
		}
		return undefined;
	},
	(context) =>
		codeIn(context, [
			'MigrationApplyError',
			'MigrationSeedError',
			'MigrationDropError',
			'MigrationsReadError',
			'DbResetMigrationFileError',
		])
			? { code: 'migration_failed' }
			: undefined,
	(context) =>
		codeIn(context, ['ResetLocalDbFailedError'])
			? { code: 'reset_failed_partial' }
			: undefined,
	(context) =>
		/requires confirmation|rerun with --yes/i.test(context.text) ||
		codeIn(context, ['NonInteractiveError', 'DbResetCancelledError'])
			? { code: 'confirm_required' }
			: undefined,
	(context) => {
		const missing = /Stack ([0-9a-f]{4,64}) was not found/.exec(context.text);
		const stackId = missing?.[1];
		if (stackId !== undefined) {
			return { code: 'not_found', details: { stackId } };
		}
		return /No managed stack exists/.test(context.text)
			? { code: 'not_found' }
			: undefined;
	},
	(context) =>
		codeIn(context, ['LocalDbRunningError', 'ResetLocalDbNotRunningError']) ||
		/The local stack is not running|The stack is not running|has not been configured yet|primary database is unavailable/i.test(
			context.text
		) ||
		(codeIn(context, ['DbConnectError']) &&
			/connection refused|ECONNREFUSED/i.test(context.text))
			? { code: 'not_running' }
			: undefined,
	(context) =>
		codeIn(context, [
			'MissingOption',
			'InvalidValue',
			'ShowHelp',
			'UnknownSubcommand',
			'ExperimentalFeatureFlagError',
			'MigrationTargetFlagsError',
			'MigrationPasswordFlagsError',
			'DbResetTargetFlagsError',
			'InspectMutuallyExclusiveFlagsError',
			'DbDumpMutuallyExclusiveFlagsError',
			'DbConfigParseUrlError',
		]) ||
		/cannot be used together|must be a lowercase hexadecimal stack id|Stack id prefix \S+ matches \d+ stacks|legacy -o\/--output flag|Invalid --since value|No service matches|does not accept TLS|does not support SSL/i.test(
			context.text
		)
			? { code: 'flag_misuse' }
			: undefined,
];

type Copy = Readonly<{
	title: string;
	recovery: (details: SupabaseErrorDetails) => string;
}>;

const COPY: Readonly<Record<SupabaseErrorCode, Copy>> = {
	not_found: {
		title: 'No local Supabase stack',
		recovery: () =>
			'Start the stack to create it. After a branch switch, the previous branch keeps its own stack and data.',
	},
	not_running: {
		title: 'Local Supabase is not running',
		recovery: () =>
			'Start the stack, then retry. Stopped stacks keep their data and resume in about a second.',
	},
	cli_mismatch: {
		title: 'Stack is served by another CLI release',
		recovery: () =>
			'Stop the stack (stopping works across CLI releases), then start it again with the CLI installed in this worktree. Data is kept; do not destroy the stack to fix this.',
	},
	needs_recreate: {
		title: 'Saved stack cannot adopt this configuration',
		// One change no setting controls forces the recreate whatever else
		// changed, as the renderer's notice, Resume reason and pill also say.
		recovery: (details) =>
			supabaseRevertKeepsStack(details.stackChanges)
				? 'Revert the listed settings to keep the stack and its data, or destroy and recreate it from RN Devtools, which deletes its local database.'
				: 'This configuration needs a new stack. Destroy and recreate it from RN Devtools; that deletes its local database.',
	},
	container_runtime: {
		title: 'Stack uses a container runtime',
		recovery: () =>
			'This stack was created with Docker or Podman, whose ports listen on every network interface. Destroy it from RN Devtools, then start it again with the native runtime.',
	},
	ports_pinned: {
		title: 'Port pinned by another stack',
		recovery: (details) =>
			`${details.port === undefined ? 'A configured port' : `Port ${details.port}${details.key === undefined ? '' : ` for ${details.key}`}`} is pinned in this project and held by ${details.holderProjectRoot === undefined ? 'another stack' : `the stack of ${details.holderProjectRoot}`}. Remove the pinned port from supabase/config.toml (or its SUPABASE_*_PORT variable) so every worktree gets automatic ports. Leave the other stack running.`,
	},
	ports_conflict: {
		title: 'Port unavailable',
		recovery: (details) => {
			switch (details.portProblem) {
				case 'held-by-process':
					return `Another process is using ${details.port === undefined ? 'a configured port' : `port ${details.port}`}. Free it, or remove the pinned port setting, then start again.`;
				case 'reserved-range':
					return 'A configured port is inside 10000-19999, which native services reserve. Choose a port outside that range, or remove the setting.';
				case 'own-listener':
					return 'Two services of this stack are configured with the same port. Give each its own port, or remove the settings.';
				default:
					return 'Start again. If it keeps failing, stop stacks you are not using.';
			}
		},
	},
	partial: {
		title: 'Stack is partly stopped',
		recovery: () => 'Stop the stack, then start it again.',
	},
	busy: {
		title: 'Stack is busy',
		recovery: () =>
			'Another operation is holding this stack. Wait a moment, then retry.',
	},
	capacity: {
		title: 'Out of database capacity',
		recovery: () =>
			'Postgres ran out of shared memory or disk. Stop stacks you are not using, free disk space, then retry.',
	},
	unreadable: {
		title: 'Stack state cannot be read',
		// Unreadable stacks are never destroyed here: the state is often written
		// by a newer CLI that another worktree still uses.
		recovery: () => SUPABASE_UNREADABLE_RECOVERY,
	},
	migration_drift: {
		title: 'Migration history does not match',
		recovery: (details) =>
			details.migrationDrift === 'missing-remote'
				? 'Some local migrations are older than the last applied one. Reset the database to replay every migration in order.'
				: 'The database has migrations this checkout does not, which usually follows a branch switch. Check out the branch that has them, or reset the database to this branch.',
	},
	migration_failed: {
		title: 'Migration failed',
		recovery: () =>
			'Fix the failing migration, then apply again. The failed migration was rolled back.',
	},
	reset_failed_partial: {
		title: 'Database reset did not finish',
		recovery: () =>
			'The stack may be partly stopped. Stop it, start it again, then retry the reset.',
	},
	confirm_required: {
		title: 'Confirmation required',
		recovery: () => 'Confirm the operation in RN Devtools, then retry.',
	},
	flag_misuse: {
		title: 'RN Devtools sent an invalid command',
		recovery: () =>
			'This is an RN Devtools bug. Report it with the message below.',
	},
	failed: {
		title: 'Supabase CLI failed',
		recovery: () =>
			'Retry. If it keeps failing, read the stack logs for the failing service.',
	},
};

const TASK_FAILED = /^\[task\] failed: (.+)$/;

function failureLines(stderrLines: readonly string[] | undefined): string[] {
	return (stderrLines ?? []).flatMap((line) => {
		const match = TASK_FAILED.exec(line.trim());
		const failure = match?.[1];
		return failure === undefined ? [] : [failure];
	});
}

function boundedMessage(parts: readonly (string | undefined)[]): string {
	const text = parts
		.filter((part) => part !== undefined && part !== '')
		.join('\n');
	return sanitizeSupabaseText(text, {
		maxChars: MESSAGE_MAX_CHARS,
		keepNewlines: true,
	});
}

function fallbackMessage(input: SupabaseFailureInput): string {
	if (input.timedOut === true)
		return 'The Supabase CLI did not finish within its time budget.';
	if (input.cancelled === true) return 'The Supabase CLI call was cancelled.';
	const lastLines = (input.stderrLines ?? []).slice(-3);
	if (lastLines.length > 0) return boundedMessage(lastLines);
	return typeof input.exitCode === 'number'
		? `The Supabase CLI exited with code ${input.exitCode}.`
		: 'The Supabase CLI ended without reporting an error.';
}

/** Classifies a failed call from its error envelope and stderr. */
export function classifySupabaseError(
	input: SupabaseFailureInput
): ClassifiedSupabaseError {
	const envelope = input.envelope;
	const failures = failureLines(input.stderrLines);
	const message =
		envelope === undefined
			? failures.length > 0
				? boundedMessage(failures.slice(-2))
				: fallbackMessage(input)
			: boundedMessage([envelope.message, envelope.detail]);
	const context: RuleContext = {
		upstream: envelope?.code,
		text: [message, ...failures].join('\n'),
		envelope,
	};
	let match: Match = { code: 'failed' };
	for (const rule of RULES) {
		const candidate = rule(context);
		if (candidate !== undefined) {
			match = candidate;
			break;
		}
	}
	const details: MutableDetails = { ...match.details };
	if (envelope !== undefined) {
		details.upstreamCode = envelope.code;
		// Container-engine and auto-runtime advice is wrong for native stacks.
		if (
			envelope.suggestion !== undefined &&
			!/docker|podman|runtime auto/i.test(envelope.suggestion)
		) {
			details.upstreamSuggestion = envelope.suggestion;
		}
		if (envelope.destroyedStackIds.length > 0) {
			details.destroyedStackIds = envelope.destroyedStackIds;
		}
	}
	if (typeof input.exitCode === 'number') details.exitCode = input.exitCode;
	if (input.timedOut === true) details.timedOut = true;
	if (input.cancelled === true) details.cancelled = true;
	const copy = COPY[match.code];
	const interrupted = input.timedOut === true || input.cancelled === true;
	return Object.freeze({
		code: match.code,
		title:
			match.code === 'failed' && interrupted
				? input.timedOut === true
					? 'Supabase CLI timed out'
					: 'Supabase CLI call cancelled'
				: copy.title,
		message,
		recovery: copy.recovery(details),
		retry: match.retry ?? 'none',
		details: Object.freeze(details),
	});
}

export type SupabaseOutcome<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: ClassifiedSupabaseError }>;

/** A `--local` call refused because the worktree switched branches meanwhile. */
export const SUPABASE_BRANCH_MOVED_TITLE = 'Worktree switched branches';

/**
 * The desktop's own refusal of a `--local` call: the CLI resolves the stack
 * from HEAD when it runs, so it would reach another branch's stack.
 */
export function supabaseBranchMovedError(): ClassifiedSupabaseError {
	return Object.freeze({
		code: 'failed',
		title: SUPABASE_BRANCH_MOVED_TITLE,
		message:
			"The worktree moved to another branch while this waited, so it didn't run; it would have reached that branch's stack instead.",
		recovery: "Switch the worktree back to the stack's branch, then retry.",
		retry: 'none',
		details: Object.freeze({}),
	});
}

function unexpectedOutput(
	result: SupabaseCliRunResult,
	reason: string
): ClassifiedSupabaseError {
	const details: MutableDetails = { unexpectedOutput: true };
	if (result.stdoutTruncated) details.stdoutTruncated = true;
	if (typeof result.exitCode === 'number') details.exitCode = result.exitCode;
	return Object.freeze({
		code: 'failed',
		title: 'Unexpected Supabase CLI output',
		message: reason,
		recovery:
			'The installed CLI may not match the verified release. Check the CLI version in Settings, then retry.',
		retry: 'none',
		details: Object.freeze(details),
	});
}

/**
 * Reads a finished run once: projects stdout with `project` on success, or
 * classifies the failure. Consumes the result's stdout either way, so the raw
 * text is never kept. `expectOutput: 'none'` accepts an empty stdout on
 * success (`db dump --file`).
 */
export function interpretSupabaseResult<T>(
	result: SupabaseCliRunResult,
	project: (json: unknown, stderrLines: readonly string[]) => T,
	options: Readonly<{ expectOutput?: 'json' | 'none' }> = {}
): SupabaseOutcome<T> {
	const stdout = result.takeStdout();
	if (result.stdoutTruncated) {
		return {
			ok: false,
			error: unexpectedOutput(
				result,
				'The Supabase CLI printed more output than RN Devtools reads.'
			),
		};
	}
	if (result.succeeded) {
		try {
			const json =
				options.expectOutput === 'none' && stdout.trim() === ''
					? undefined
					: parseSupabaseJsonLine(stdout);
			return { ok: true, value: project(json, result.stderrLines) };
		} catch (error) {
			// Contract and parse errors carry no values, only paths and codes.
			const reason =
				error instanceof Error
					? sanitizeSupabaseText(error.message, { maxChars: 512 })
					: 'The Supabase CLI output could not be read.';
			return { ok: false, error: unexpectedOutput(result, reason) };
		}
	}
	let envelope: SupabaseErrorEnvelope | undefined;
	try {
		envelope = parseSupabaseErrorEnvelope(parseSupabaseJsonLine(stdout));
	} catch {
		envelope = undefined;
	}
	return {
		ok: false,
		error: classifySupabaseError({
			envelope,
			exitCode: result.exitCode,
			stderrLines: result.stderrLines,
			timedOut: result.timedOut,
			cancelled: result.cancelled,
		}),
	};
}

import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { inspect } from 'node:util';
import { sanitizeSupabaseText } from './cli-redact';
import {
	assertSupabaseArgvAllowed,
	SUPABASE_MAX_CLI_TIMEOUT_MS,
} from './dialect';
import { hasSupabaseControlCharacters } from './engine-support';

/**
 * Runs a validated Supabase CLI binary. Nothing here knows Supabase command
 * words: argv comes from buildSupabaseArgv and is checked against the
 * allowlist right before every spawn.
 *
 * - argv array, `shell: false`, a curated environment, and a neutral 0700 cwd
 *   (stack owners inherit the cwd for life, so it must not be a worktree);
 * - stdout and stderr are separate pipes that are always drained, past their
 *   caps too, because the CLI misbehaves when a shared pipe closes;
 * - stderr is streamed line by line after control stripping and redaction;
 * - stdout is never logged: it carries DB_URL and secret keys, and the result
 *   hands it out once;
 * - cancellation interrupts first (SIGINT), then terminates (SIGTERM), and
 *   SIGKILL only when the caller's budget allows it, never for mutations;
 * - lifecycle children can run detached, in their own process group, with
 *   stderr in a 0600 progress file, so they survive the request and the app.
 */

const STDOUT_MAX_BYTES = 512 * 1024;
const STDERR_MAX_BYTES = 64 * 1024;
const STDERR_LINE_MAX_CHARS = 2_000;
const DEFAULT_INTERRUPT_GRACE_MS = 45_000;
const EXIT_DRAIN_GRACE_MS = 2_000;
const DEFAULT_PROGRESS_POLL_MS = 250;
const MAX_TIMEOUT_MS = SUPABASE_MAX_CLI_TIMEOUT_MS;
const MAX_ARGV_LENGTH = 128;
const MAX_ARGUMENT_LENGTH = 8192;
const MAX_ENVIRONMENT_VALUE_LENGTH = 4096;
const PINNED_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const PROGRESS_LABEL = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** `<label>-<ms>-<uuid>.log`, as spawnDetached names a progress file. */
const PROGRESS_FILE_NAME =
	/^[a-z0-9][a-z0-9-]{0,31}-(\d{1,16})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.log$/;

const FIXED_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({
	SUPABASE_EXPERIMENTAL_STACK: '1',
	SUPABASE_TELEMETRY_DISABLED: '1',
	DO_NOT_TRACK: '1',
	SUPABASE_NO_UPDATE_NOTIFIER: '1',
});
const INHERITED_NAMES = ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG'] as const;
const LOCALE_NAME = /^LC_[A-Z]{1,32}$/;
// Persistent service toggles; every CLI call reads them (stack-config.ts).
const TOGGLE_OVERRIDES: ReadonlySet<string> = new Set([
	'SUPABASE_STUDIO_ENABLED',
	'SUPABASE_ANALYTICS_ENABLED',
	'SUPABASE_STORAGE_S3_PROTOCOL_ENABLED',
	'SUPABASE_LOCAL_SMTP_ENABLED',
	'SUPABASE_REALTIME_ENABLED',
	'SUPABASE_EDGE_RUNTIME_ENABLED',
]);
// Per-stack key overrides.
const KEY_OVERRIDES: ReadonlySet<string> = new Set([
	'SUPABASE_AUTH_JWT_SECRET',
	'SUPABASE_AUTH_PUBLISHABLE_KEY',
	'SUPABASE_AUTH_SECRET_KEY',
	'SUPABASE_AUTH_SIGNING_KEYS_PATH',
]);
/**
 * Listener ports a desktop-run start may move with pinned-port leases.
 * Passed only as `leasedPorts`, never as `overrides`.
 */
export const SUPABASE_PORT_OVERRIDE_NAMES = [
	'SUPABASE_API_PORT',
	'SUPABASE_DB_PORT',
	'SUPABASE_DB_SHADOW_PORT',
	'SUPABASE_DB_POOLER_PORT',
	'SUPABASE_STUDIO_PORT',
	'SUPABASE_LOCAL_SMTP_PORT',
	'SUPABASE_LOCAL_SMTP_SMTP_PORT',
	'SUPABASE_LOCAL_SMTP_POP3_PORT',
	'SUPABASE_ANALYTICS_PORT',
	'SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT',
] as const;
const PORT_OVERRIDES: ReadonlySet<string> = new Set(
	SUPABASE_PORT_OVERRIDE_NAMES
);

export type SupabaseCliRunnerErrorKind =
	| 'invalid-request'
	| 'invalid-environment'
	| 'unsafe-directory'
	| 'spawn'
	| 'aborted';

/** Raised when a call cannot start. Messages never include argv or output. */
export class SupabaseCliRunnerError extends Error {
	readonly kind: SupabaseCliRunnerErrorKind;

	constructor(
		kind: SupabaseCliRunnerErrorKind,
		message: string,
		options?: ErrorOptions
	) {
		super(message, options);
		this.name = 'SupabaseCliRunnerError';
		this.kind = kind;
	}
}

export type SupabaseCliEnvironmentOptions = Readonly<{
	/** SUPABASE_HOME, only when the operator chose one; never inherited. */
	supabaseHome?: string;
	/** Certificate bundle for artifact downloads; overrides the inherited one. */
	sslCertFile?: string;
	sslCertDir?: string;
	/**
	 * Allowlisted SUPABASE_* overrides: service toggles (`true`/`false`) such as
	 * SUPABASE_STUDIO_ENABLED, and per-stack keys such as SUPABASE_AUTH_JWT_SECRET.
	 */
	overrides?: Readonly<Record<string, string>>;
	/**
	 * Leased listener ports (SUPABASE_API_PORT and the other names in
	 * SUPABASE_PORT_OVERRIDE_NAMES) for a repository that pins them.
	 */
	leasedPorts?: Readonly<Record<string, string>>;
}>;

function isAbsolutePath(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length >= 2 &&
		value.length <= 4096 &&
		path.isAbsolute(value) &&
		path.normalize(value) === value &&
		!hasSupabaseControlCharacters(value)
	);
}

function environmentError(message: string): SupabaseCliRunnerError {
	return new SupabaseCliRunnerError('invalid-environment', message);
}

function explicitPath(
	value: string | undefined,
	name: string
): string | undefined {
	if (value === undefined) return undefined;
	if (!isAbsolutePath(value))
		throw environmentError(`${name} must be an absolute path.`);
	return value;
}

function inheritedPath(value: string | undefined): string | undefined {
	return isAbsolutePath(value) ? value : undefined;
}

function overrideValue(name: string, value: unknown): string {
	if (typeof value !== 'string' || value.length === 0) {
		// An exported empty SUPABASE_* value masks the project's dotenv files.
		throw environmentError(`${name} must not be empty.`);
	}
	if (TOGGLE_OVERRIDES.has(name)) {
		if (value !== 'true' && value !== 'false') {
			throw environmentError(`${name} must be true or false.`);
		}
		return value;
	}
	if (!KEY_OVERRIDES.has(name)) {
		throw environmentError('That SUPABASE_* override is not allowlisted.');
	}
	if (
		value.length > MAX_ENVIRONMENT_VALUE_LENGTH ||
		hasSupabaseControlCharacters(value)
	) {
		throw environmentError(`${name} has an invalid value.`);
	}
	if (name === 'SUPABASE_AUTH_JWT_SECRET' && value.length < 16) {
		throw environmentError(`${name} must be at least 16 characters.`);
	}
	if (name === 'SUPABASE_AUTH_SIGNING_KEYS_PATH' && !isAbsolutePath(value)) {
		throw environmentError(`${name} must be an absolute path.`);
	}
	return value;
}

/**
 * The exact environment a Supabase CLI child gets. The owner a start
 * launches keeps it for life, so nothing is inherited beyond the identity,
 * locale and temp variables; SUPABASE_* comes only from the fixed switches and
 * the allowlisted overrides; PATH is pinned to the system directories plus the
 * binary's own directory.
 */
export function buildSupabaseCliEnvironment(
	input: Readonly<{
		binaryPath: string;
		parentEnvironment: Readonly<Record<string, string | undefined>>;
		options?: SupabaseCliEnvironmentOptions | undefined;
	}>
): Record<string, string> {
	if (!isAbsolutePath(input.binaryPath) || input.binaryPath.includes(':')) {
		throw new SupabaseCliRunnerError(
			'invalid-request',
			'The Supabase CLI path must be an absolute path without colons.'
		);
	}
	const parent = input.parentEnvironment;
	const options = input.options ?? {};
	const environment: Record<string, string> = {
		PATH: `${PINNED_PATH}:${path.dirname(input.binaryPath)}`,
	};
	for (const name of INHERITED_NAMES) {
		const value = parent[name];
		if (
			value !== undefined &&
			value !== '' &&
			!hasSupabaseControlCharacters(value)
		) {
			environment[name] = value;
		}
	}
	for (const [name, value] of Object.entries(parent)) {
		if (
			LOCALE_NAME.test(name) &&
			value !== undefined &&
			value !== '' &&
			!hasSupabaseControlCharacters(value)
		) {
			environment[name] = value;
		}
	}
	const sslCertFile =
		explicitPath(options.sslCertFile, 'SSL_CERT_FILE') ??
		inheritedPath(parent.SSL_CERT_FILE);
	if (sslCertFile !== undefined) environment.SSL_CERT_FILE = sslCertFile;
	const sslCertDir =
		explicitPath(options.sslCertDir, 'SSL_CERT_DIR') ??
		inheritedPath(parent.SSL_CERT_DIR);
	if (sslCertDir !== undefined) environment.SSL_CERT_DIR = sslCertDir;
	const supabaseHome = explicitPath(options.supabaseHome, 'SUPABASE_HOME');
	if (supabaseHome !== undefined) environment.SUPABASE_HOME = supabaseHome;
	for (const [name, value] of Object.entries(options.overrides ?? {})) {
		environment[name] = overrideValue(name, value);
	}
	for (const [name, value] of Object.entries(options.leasedPorts ?? {})) {
		environment[name] = leasedPortValue(name, value);
	}
	return { ...environment, ...FIXED_ENVIRONMENT };
}

function leasedPortValue(name: string, value: unknown): string {
	if (!PORT_OVERRIDES.has(name)) {
		throw environmentError('That listener port is not leased by RN Devtools.');
	}
	const port =
		typeof value === 'string' && /^\d{4,5}$/.test(value)
			? Number(value)
			: Number.NaN;
	if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
		throw environmentError(`${name} must be a port from 1024 to 65535.`);
	}
	return String(port);
}

/**
 * The subset of a Node child process the runner uses.
 */
export type SupabaseChildProcess = {
	readonly pid?: number | undefined;
	readonly stdout: Readable | null;
	readonly stderr: Readable | null;
	kill(signal: NodeJS.Signals): boolean;
	unref(): void;
	once(event: 'spawn', listener: () => void): unknown;
	once(event: 'error', listener: (error: Error) => void): unknown;
	once(
		event: 'exit' | 'close',
		listener: (code: number | null, signal: NodeJS.Signals | null) => void
	): unknown;
};

export type SupabaseSpawnOptions = Readonly<{
	cwd: string;
	env: Readonly<Record<string, string>>;
	detached: boolean;
	stdio: readonly ['ignore', 'pipe', 'pipe' | number];
}>;

export type SupabaseSpawnPort = (
	command: string,
	args: readonly string[],
	options: SupabaseSpawnOptions
) => SupabaseChildProcess;

export type SupabaseClockPort = Readonly<{
	now: () => number;
	setTimeout: (callback: () => void, ms: number) => unknown;
	clearTimeout: (handle: unknown) => void;
}>;

const nodeSpawnPort: SupabaseSpawnPort = (command, args, options) =>
	nodeSpawn(command, [...args], {
		cwd: options.cwd,
		env: { ...options.env },
		detached: options.detached,
		stdio: [...options.stdio],
		shell: false,
		windowsHide: true,
	});

const systemClock: SupabaseClockPort = {
	now: () => Date.now(),
	setTimeout: (callback, ms) => {
		const timer = setTimeout(callback, ms);
		timer.unref();
		return timer;
	},
	clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

type ResultFields = Readonly<{
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	cancelled: boolean;
	signalsSent: readonly NodeJS.Signals[];
	stdoutBytes: number;
	stdoutTruncated: boolean;
	stderrLines: readonly string[];
	stderrTruncated: boolean;
	durationMs: number;
}>;

/**
 * One finished CLI call. Stderr lines are already sanitized. Stdout is kept
 * in a private field: it is absent from JSON, structured clones and
 * `util.inspect`, and takeStdout hands it out once.
 */
export class SupabaseCliRunResult {
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly timedOut: boolean;
	readonly cancelled: boolean;
	/** Signals the runner sent, in order. */
	readonly signalsSent: readonly NodeJS.Signals[];
	readonly stdoutBytes: number;
	readonly stdoutTruncated: boolean;
	readonly stderrLines: readonly string[];
	readonly stderrTruncated: boolean;
	readonly durationMs: number;
	#stdout: string | undefined;

	constructor(fields: ResultFields, stdout: string) {
		this.exitCode = fields.exitCode;
		this.signal = fields.signal;
		this.timedOut = fields.timedOut;
		this.cancelled = fields.cancelled;
		this.signalsSent = Object.freeze([...fields.signalsSent]);
		this.stdoutBytes = fields.stdoutBytes;
		this.stdoutTruncated = fields.stdoutTruncated;
		this.stderrLines = Object.freeze([...fields.stderrLines]);
		this.stderrTruncated = fields.stderrTruncated;
		this.durationMs = fields.durationMs;
		this.#stdout = stdout;
	}

	/**
	 * Exited 0 by itself with complete output. A call that finished after its
	 * timeout or abort had already sent SIGINT still completed, so this can be
	 * true while `timedOut` or `cancelled` is set; the CLI exits 130 when an
	 * interrupt actually stops it.
	 */
	get succeeded(): boolean {
		return this.exitCode === 0 && this.signal === null && !this.stdoutTruncated;
	}

	/**
	 * Returns stdout once and forgets it. It can hold DB_URL, secret keys and
	 * service-role JWTs: project it right away, never log or store it.
	 */
	takeStdout(): string {
		const stdout = this.#stdout ?? '';
		this.#stdout = undefined;
		return stdout;
	}

	toJSON(): ResultFields {
		return {
			exitCode: this.exitCode,
			signal: this.signal,
			timedOut: this.timedOut,
			cancelled: this.cancelled,
			signalsSent: this.signalsSent,
			stdoutBytes: this.stdoutBytes,
			stdoutTruncated: this.stdoutTruncated,
			stderrLines: this.stderrLines,
			stderrTruncated: this.stderrTruncated,
			durationMs: this.durationMs,
		};
	}

	[inspect.custom](): string {
		return `SupabaseCliRunResult ${JSON.stringify(this.toJSON())}`;
	}
}

export type SupabaseCliRunRequest = Readonly<{
	/** A binary the resolver validated. */
	binaryPath: string;
	/** From buildSupabaseArgv; checked against the allowlist before spawning. */
	argv: readonly string[];
	/** Refuses any command that changes something: a binary not validated yet. */
	readOnly?: true;
	/** Neutral working directory; created 0700 when missing. */
	cwd: string;
	timeoutMs: number;
	/** After SIGINT, how long to wait before SIGTERM. Defaults to 45 s. */
	interruptGraceMs?: number;
	/** After SIGTERM, how long to wait before SIGKILL. Omit to never SIGKILL. */
	forceKillAfterMs?: number;
	/** Aborting interrupts the child (attached runs only). */
	signal?: AbortSignal;
	/** Receives each sanitized, bounded stderr line. */
	onStderrLine?: (line: string) => void;
	environment?: SupabaseCliEnvironmentOptions;
}>;

export type SupabaseCliDetachedRequest = Readonly<
	Omit<SupabaseCliRunRequest, 'signal'> & {
		/** Private directory for 0600 progress files; created 0700 when missing. */
		progressDirectory: string;
		/** Short lowercase slug used in the progress file name, e.g. `start`. */
		progressLabel: string;
	}
>;

export type SupabaseCliDetachedHandle = Readonly<{
	pid: number;
	progressFile: string;
	/** Settles when the child exits; never rejects. */
	result: Promise<SupabaseCliRunResult>;
	/** SIGINT, then SIGTERM after the grace period; idempotent. */
	interrupt: () => void;
}>;

export type SupabaseCliRunnerOptions = Readonly<{
	spawn?: SupabaseSpawnPort;
	/** Signals a process or, with a negative pid, a process group. */
	killProcess?: (pid: number, signal: NodeJS.Signals) => void;
	clock?: SupabaseClockPort;
	parentEnvironment?: Readonly<Record<string, string | undefined>>;
	uid?: number;
	progressPollMs?: number;
}>;

type PreparedRun = Readonly<{
	binaryPath: string;
	argv: readonly string[];
	cwd: string;
	environment: Record<string, string>;
	timeoutMs: number;
	interruptGraceMs: number;
	forceKillAfterMs: number | undefined;
}>;

function boundedDuration(
	value: number | undefined,
	fallback: number,
	name: string,
	minimum: number
): number {
	const duration = value ?? fallback;
	if (
		!Number.isSafeInteger(duration) ||
		duration < minimum ||
		duration > MAX_TIMEOUT_MS
	) {
		throw new SupabaseCliRunnerError(
			'invalid-request',
			`${name} is out of range.`
		);
	}
	return duration;
}

class InterruptEscalation {
	readonly sent: NodeJS.Signals[] = [];
	readonly #clock: SupabaseClockPort;
	readonly #send: (signal: NodeJS.Signals) => void;
	readonly #interruptGraceMs: number;
	readonly #forceKillAfterMs: number | undefined;
	#timers: unknown[] = [];
	#started = false;
	#finished = false;

	constructor(
		clock: SupabaseClockPort,
		send: (signal: NodeJS.Signals) => void,
		interruptGraceMs: number,
		forceKillAfterMs: number | undefined
	) {
		this.#clock = clock;
		this.#send = send;
		this.#interruptGraceMs = interruptGraceMs;
		this.#forceKillAfterMs = forceKillAfterMs;
	}

	start(): void {
		if (this.#started || this.#finished) return;
		this.#started = true;
		this.#signal('SIGINT');
		this.#timers.push(
			this.#clock.setTimeout(() => {
				this.#signal('SIGTERM');
				const forceKillAfterMs = this.#forceKillAfterMs;
				if (forceKillAfterMs === undefined) return;
				this.#timers.push(
					this.#clock.setTimeout(
						() => this.#signal('SIGKILL'),
						forceKillAfterMs
					)
				);
			}, this.#interruptGraceMs)
		);
	}

	finish(): void {
		this.#finished = true;
		for (const timer of this.#timers) this.#clock.clearTimeout(timer);
		this.#timers = [];
	}

	#signal(signal: NodeJS.Signals): void {
		if (this.#finished) return;
		this.sent.push(signal);
		try {
			this.#send(signal);
		} catch {
			// The child may have exited between the check and the signal.
		}
	}
}

class BoundedBytes {
	readonly #maxBytes: number;
	#chunks: Buffer[] = [];
	#bytes = 0;
	total = 0;
	truncated = false;

	constructor(maxBytes: number) {
		this.#maxBytes = maxBytes;
	}

	push(chunk: Buffer): void {
		this.total += chunk.byteLength;
		if (this.truncated) return;
		const room = this.#maxBytes - this.#bytes;
		if (chunk.byteLength <= room) {
			this.#chunks.push(chunk);
			this.#bytes += chunk.byteLength;
			return;
		}
		if (room > 0) this.#chunks.push(chunk.subarray(0, room));
		this.#bytes = this.#maxBytes;
		this.truncated = true;
	}

	takeText(): string {
		const text = Buffer.concat(this.#chunks).toString('utf8');
		this.#chunks = [];
		return text;
	}
}

class StderrLines {
	readonly lines: string[] = [];
	readonly #onLine: ((line: string) => void) | undefined;
	readonly #decoder = new StringDecoder('utf8');
	#bytes = 0;
	#pending = '';
	#ended = false;
	truncated = false;

	constructor(onLine: ((line: string) => void) | undefined) {
		this.#onLine = onLine;
	}

	push(chunk: Buffer): void {
		if (this.truncated || this.#ended) return;
		const room = STDERR_MAX_BYTES - this.#bytes;
		const accepted = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
		this.#bytes += accepted.byteLength;
		this.#consume(this.#decoder.write(accepted));
		if (accepted.byteLength < chunk.byteLength) {
			this.truncated = true;
			this.#flush();
		}
	}

	end(): void {
		if (this.#ended) return;
		this.#ended = true;
		if (!this.truncated) this.#consume(this.#decoder.end());
		this.#flush();
	}

	#consume(text: string): void {
		if (text === '') return;
		const parts = `${this.#pending}${text}`.split('\n');
		this.#pending = parts.pop() ?? '';
		for (const part of parts) this.#emit(part);
	}

	#flush(): void {
		const pending = this.#pending;
		this.#pending = '';
		if (pending !== '') this.#emit(pending);
	}

	#emit(raw: string): void {
		const line = sanitizeSupabaseText(raw, { maxChars: STDERR_LINE_MAX_CHARS });
		if (line.trim() === '') return;
		this.lines.push(line);
		try {
			this.#onLine?.(line);
		} catch {
			// A listener must not break supervision of the child.
		}
	}
}

const PROGRESS_READ_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
const PROGRESS_CREATE_FLAGS =
	fsConstants.O_CREAT |
	fsConstants.O_EXCL |
	fsConstants.O_WRONLY |
	fsConstants.O_NOFOLLOW;

/** Follows a detached child's progress file into the same bounded sink. */
class ProgressFileTail {
	readonly #file: string;
	readonly #sink: StderrLines;
	readonly #clock: SupabaseClockPort;
	readonly #pollMs: number;
	#offset = 0;
	#timer: unknown;
	#reading: Promise<void> = Promise.resolve();
	#stopped = false;

	constructor(
		file: string,
		sink: StderrLines,
		clock: SupabaseClockPort,
		pollMs: number
	) {
		this.#file = file;
		this.#sink = sink;
		this.#clock = clock;
		this.#pollMs = pollMs;
	}

	start(): void {
		this.#schedule();
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		if (this.#timer !== undefined) this.#clock.clearTimeout(this.#timer);
		await this.#reading;
		await this.#readAvailable();
		this.#sink.end();
	}

	#schedule(): void {
		if (this.#stopped) return;
		this.#timer = this.#clock.setTimeout(() => {
			this.#reading = this.#readAvailable().then(() => this.#schedule());
		}, this.#pollMs);
	}

	async #readAvailable(): Promise<void> {
		try {
			const handle = await open(this.#file, PROGRESS_READ_FLAGS);
			try {
				const buffer = Buffer.alloc(16 * 1024);
				while (!this.#sink.truncated) {
					const { bytesRead } = await handle.read(
						buffer,
						0,
						buffer.byteLength,
						this.#offset
					);
					if (bytesRead === 0) break;
					this.#offset += bytesRead;
					this.#sink.push(Buffer.from(buffer.subarray(0, bytesRead)));
				}
			} finally {
				await handle.close();
			}
		} catch {
			// Progress is best effort; the exit status remains authoritative.
		}
	}
}

type Supervision = Readonly<{
	spawned: Promise<void>;
	result: Promise<SupabaseCliRunResult>;
}>;

function superviseChild(
	input: Readonly<{
		child: SupabaseChildProcess;
		clock: SupabaseClockPort;
		timeoutMs: number;
		escalation: InterruptEscalation;
		stderrLines: StderrLines;
		progressTail?: ProgressFileTail;
		signal?: AbortSignal | undefined;
	}>
): Supervision {
	const { child, clock, escalation, stderrLines } = input;
	const startedAt = clock.now();
	const stdout = new BoundedBytes(STDOUT_MAX_BYTES);
	let spawnedSuccessfully = false;
	let timedOut = false;
	let cancelled = false;
	let exited = false;
	let exitCode: number | null = null;
	let exitSignal: NodeJS.Signals | null = null;

	child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
	child.stderr?.on('data', (chunk: Buffer) => stderrLines.push(chunk));
	// Stream errors are not authoritative; the exit status is.
	child.stdout?.on('error', () => undefined);
	child.stderr?.on('error', () => undefined);

	const spawned = new Promise<void>((resolve, reject) => {
		child.once('spawn', () => {
			spawnedSuccessfully = true;
			resolve();
		});
		child.once('error', (cause) => {
			if (spawnedSuccessfully) return;
			reject(
				new SupabaseCliRunnerError(
					'spawn',
					'The Supabase CLI could not start.',
					{
						cause,
					}
				)
			);
		});
	});
	// The caller awaits `spawned`; keep a failed spawn from also surfacing here.
	spawned.catch(() => undefined);

	const result = new Promise<SupabaseCliRunResult>((resolve) => {
		let settled = false;
		let drainTimer: unknown;
		const timeout = clock.setTimeout(() => {
			timedOut = true;
			escalation.start();
		}, input.timeoutMs);
		const onAbort = () => {
			cancelled = true;
			escalation.start();
		};
		if (input.signal?.aborted) onAbort();
		else input.signal?.addEventListener('abort', onAbort, { once: true });

		const finish = async () => {
			if (settled) return;
			settled = true;
			clock.clearTimeout(timeout);
			if (drainTimer !== undefined) clock.clearTimeout(drainTimer);
			escalation.finish();
			input.signal?.removeEventListener('abort', onAbort);
			if (input.progressTail) await input.progressTail.stop();
			else stderrLines.end();
			resolve(
				new SupabaseCliRunResult(
					{
						exitCode,
						signal: exitSignal,
						timedOut,
						cancelled,
						signalsSent: escalation.sent,
						stdoutBytes: stdout.total,
						stdoutTruncated: stdout.truncated,
						stderrLines: stderrLines.lines,
						stderrTruncated: stderrLines.truncated,
						durationMs: Math.max(0, clock.now() - startedAt),
					},
					stdout.takeText()
				)
			);
		};
		child.once('exit', (code, signal) => {
			exited = true;
			exitCode = code;
			exitSignal = signal;
			// A grandchild holding the pipes must not hang the call; keep draining
			// in the background and settle with what arrived.
			drainTimer = clock.setTimeout(() => void finish(), EXIT_DRAIN_GRACE_MS);
		});
		child.once('close', (code, signal) => {
			if (!exited) {
				exitCode = code;
				exitSignal = signal;
			}
			void finish();
		});
		// A failed spawn never exits; settle so no timer outlives it.
		child.once('error', () => {
			if (!spawnedSuccessfully) void finish();
		});
	});
	return { spawned, result };
}

/** Parses the last non-empty stdout line, which is where the CLI prints its one JSON value. */
export function parseSupabaseJsonLine(stdout: string): unknown {
	const lines = stdout.split('\n');
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index]?.trim() ?? '';
		if (line === '') continue;
		try {
			return JSON.parse(line) as unknown;
		} catch {
			throw new SupabaseCliOutputError(
				'invalid-json',
				'The Supabase CLI printed output that is not JSON.'
			);
		}
	}
	throw new SupabaseCliOutputError(
		'empty',
		'The Supabase CLI printed no output.'
	);
}

/** Never carries the output it failed to parse. */
export class SupabaseCliOutputError extends Error {
	readonly kind: 'empty' | 'invalid-json';

	constructor(kind: 'empty' | 'invalid-json', message: string) {
		super(message);
		this.name = 'SupabaseCliOutputError';
		this.kind = kind;
	}
}

/**
 * Removes a progress file once nothing reads it, and only such a file: a
 * regular file named the way spawnDetached names one, directly in
 * `directory`. False when there was nothing to remove.
 */
export async function removeSupabaseProgressFile(
	directory: string,
	file: string
): Promise<boolean> {
	if (
		path.dirname(file) !== directory ||
		!PROGRESS_FILE_NAME.test(path.basename(file))
	) {
		return false;
	}
	try {
		if (!(await lstat(file)).isFile()) return false;
		await unlink(file);
		return true;
	} catch {
		return false;
	}
}

/**
 * Removes the progress files earlier runs left in `directory`: those written
 * before `before` that `keep` does not name. Returns how many went.
 */
export async function pruneSupabaseProgressFiles(
	directory: string,
	options: Readonly<{ before: number; keep: ReadonlySet<string> }>
): Promise<number> {
	let names: string[];
	try {
		names = await readdir(directory);
	} catch {
		return 0;
	}
	let removed = 0;
	for (const name of names) {
		const written = Number(PROGRESS_FILE_NAME.exec(name)?.[1]);
		const file = path.join(directory, name);
		if (!(written < options.before) || options.keep.has(file)) continue;
		if (await removeSupabaseProgressFile(directory, file)) removed += 1;
	}
	return removed;
}

/**
 * Reads the sanitized tail of a detached child's progress file, for example
 * after the desktop restarted and adopted a child that is still running.
 */
export async function readSupabaseProgressLines(
	file: string,
	maxBytes: number = STDERR_MAX_BYTES
): Promise<string[]> {
	const handle = await open(file, PROGRESS_READ_FLAGS);
	try {
		const { size } = await handle.stat();
		const length = Math.min(size, Math.max(0, Math.floor(maxBytes)));
		const buffer = Buffer.alloc(length);
		const { bytesRead } = await handle.read(buffer, 0, length, size - length);
		const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
		// Starting mid-file means the first line is a fragment.
		if (length < size) lines.shift();
		return lines
			.map((line) =>
				sanitizeSupabaseText(line, { maxChars: STDERR_LINE_MAX_CHARS })
			)
			.filter((line) => line.trim() !== '');
	} finally {
		await handle.close();
	}
}

export class SupabaseCliRunner {
	readonly #spawn: SupabaseSpawnPort;
	readonly #killProcess: (pid: number, signal: NodeJS.Signals) => void;
	readonly #clock: SupabaseClockPort;
	readonly #parentEnvironment: Readonly<Record<string, string | undefined>>;
	readonly #uid: number;
	readonly #progressPollMs: number;

	constructor(options: SupabaseCliRunnerOptions = {}) {
		this.#spawn = options.spawn ?? nodeSpawnPort;
		this.#killProcess =
			options.killProcess ?? ((pid, signal) => process.kill(pid, signal));
		this.#clock = options.clock ?? systemClock;
		this.#parentEnvironment = options.parentEnvironment ?? process.env;
		this.#uid = options.uid ?? process.getuid?.() ?? -1;
		this.#progressPollMs = options.progressPollMs ?? DEFAULT_PROGRESS_POLL_MS;
	}

	/** Runs a read or short call attached to the caller; abort interrupts it. */
	async run(request: SupabaseCliRunRequest): Promise<SupabaseCliRunResult> {
		const prepared = this.#prepare(request);
		await this.#ensurePrivateDirectory(prepared.cwd);
		if (request.signal?.aborted) {
			throw new SupabaseCliRunnerError(
				'aborted',
				'The Supabase CLI call was cancelled before it started.'
			);
		}
		const child = this.#start(prepared, false, 'pipe');
		const escalation = new InterruptEscalation(
			this.#clock,
			(signal) => child.kill(signal),
			prepared.interruptGraceMs,
			prepared.forceKillAfterMs
		);
		const supervision = superviseChild({
			child,
			clock: this.#clock,
			timeoutMs: prepared.timeoutMs,
			escalation,
			stderrLines: new StderrLines(request.onStderrLine),
			signal: request.signal,
		});
		await supervision.spawned;
		return supervision.result;
	}

	/**
	 * Starts a lifecycle child in its own process group, not tied to the
	 * request or to the app: stdin is closed, stdout is piped (one JSON line),
	 * stderr goes to a new 0600 progress file. The budget still applies: on
	 * timeout the group is interrupted, then terminated.
	 */
	async spawnDetached(
		request: SupabaseCliDetachedRequest
	): Promise<SupabaseCliDetachedHandle> {
		const prepared = this.#prepare(request);
		if (!PROGRESS_LABEL.test(request.progressLabel)) {
			throw new SupabaseCliRunnerError(
				'invalid-request',
				'The progress label must be a short lowercase slug.'
			);
		}
		await this.#ensurePrivateDirectory(prepared.cwd);
		await this.#ensurePrivateDirectory(request.progressDirectory);
		const progressFile = path.join(
			request.progressDirectory,
			`${request.progressLabel}-${this.#clock.now()}-${randomUUID()}.log`
		);
		const stderrLines = new StderrLines(request.onStderrLine);
		const progressTail = new ProgressFileTail(
			progressFile,
			stderrLines,
			this.#clock,
			this.#progressPollMs
		);
		const progress = await open(progressFile, PROGRESS_CREATE_FLAGS, 0o600);
		const directory = path.dirname(progressFile);
		let started:
			| Readonly<{
					child: SupabaseChildProcess;
					escalation: InterruptEscalation;
					supervision: Supervision;
			  }>
			| undefined;
		try {
			const child = this.#start(prepared, true, progress.fd);
			const escalation = new InterruptEscalation(
				this.#clock,
				(signal) => this.#signalGroup(child, signal),
				prepared.interruptGraceMs,
				prepared.forceKillAfterMs
			);
			// Attach before awaiting anything: Node reports a spawn, or a spawn
			// failure, on the next tick.
			const supervision = superviseChild({
				child,
				clock: this.#clock,
				timeoutMs: prepared.timeoutMs,
				escalation,
				stderrLines,
				progressTail,
			});
			started = { child, escalation, supervision };
		} finally {
			// The child holds its own copy of the descriptor once spawn returns.
			await progress.close();
			if (!started) await removeSupabaseProgressFile(directory, progressFile);
		}
		const { child, escalation, supervision } = started;
		try {
			await supervision.spawned;
		} catch (error) {
			await removeSupabaseProgressFile(directory, progressFile);
			throw error;
		}
		const pid = child.pid;
		if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1) {
			escalation.start();
			await removeSupabaseProgressFile(directory, progressFile);
			throw new SupabaseCliRunnerError(
				'spawn',
				'The Supabase CLI started without a process id.'
			);
		}
		child.unref();
		progressTail.start();
		return Object.freeze({
			pid,
			progressFile,
			// Its lines are in the result; only a restarted desktop reads the
			// file of a child still running.
			result: supervision.result.finally(() =>
				removeSupabaseProgressFile(directory, progressFile)
			),
			interrupt: () => escalation.start(),
		});
	}

	#prepare(
		request: Readonly<Omit<SupabaseCliRunRequest, 'signal' | 'onStderrLine'>>
	): PreparedRun {
		if (
			!Array.isArray(request.argv) ||
			request.argv.length === 0 ||
			request.argv.length > MAX_ARGV_LENGTH ||
			request.argv.some(
				(argument) =>
					typeof argument !== 'string' ||
					argument.length > MAX_ARGUMENT_LENGTH ||
					argument.includes('\0')
			)
		) {
			throw new SupabaseCliRunnerError(
				'invalid-request',
				'The Supabase CLI argv is malformed.'
			);
		}
		assertSupabaseArgvAllowed(request.argv, request.readOnly === true);
		if (!isAbsolutePath(request.cwd)) {
			throw new SupabaseCliRunnerError(
				'invalid-request',
				'The Supabase CLI working directory must be an absolute path.'
			);
		}
		const timeoutMs = boundedDuration(request.timeoutMs, 0, 'timeoutMs', 1);
		const interruptGraceMs = boundedDuration(
			request.interruptGraceMs,
			DEFAULT_INTERRUPT_GRACE_MS,
			'interruptGraceMs',
			0
		);
		const forceKillAfterMs =
			request.forceKillAfterMs === undefined
				? undefined
				: boundedDuration(request.forceKillAfterMs, 0, 'forceKillAfterMs', 0);
		return {
			binaryPath: request.binaryPath,
			argv: [...request.argv],
			cwd: request.cwd,
			environment: buildSupabaseCliEnvironment({
				binaryPath: request.binaryPath,
				parentEnvironment: this.#parentEnvironment,
				options: request.environment,
			}),
			timeoutMs,
			interruptGraceMs,
			forceKillAfterMs,
		};
	}

	#start(
		prepared: PreparedRun,
		detached: boolean,
		stderr: 'pipe' | number
	): SupabaseChildProcess {
		try {
			return this.#spawn(prepared.binaryPath, prepared.argv, {
				cwd: prepared.cwd,
				env: prepared.environment,
				detached,
				stdio: ['ignore', 'pipe', stderr],
			});
		} catch (cause) {
			throw new SupabaseCliRunnerError(
				'spawn',
				'The Supabase CLI could not start.',
				{
					cause,
				}
			);
		}
	}

	#signalGroup(child: SupabaseChildProcess, signal: NodeJS.Signals): void {
		const pid = child.pid;
		// Never signal pid 0 or -1: those name the caller's own group or everything.
		if (pid !== undefined && Number.isSafeInteger(pid) && pid > 1) {
			try {
				this.#killProcess(-pid, signal);
				return;
			} catch {
				// The group may already be gone; fall back to the leader.
			}
		}
		child.kill(signal);
	}

	async #ensurePrivateDirectory(directory: string): Promise<void> {
		if (!isAbsolutePath(directory)) {
			throw new SupabaseCliRunnerError(
				'invalid-request',
				'Private directories must be absolute paths.'
			);
		}
		try {
			await mkdir(directory, { recursive: true, mode: 0o700 });
			const info = await lstat(directory);
			if (!info.isDirectory() || info.isSymbolicLink()) {
				throw new Error('not a plain directory');
			}
			if (info.uid !== this.#uid) throw new Error('owned by another user');
			if ((info.mode & 0o077) !== 0) await chmod(directory, 0o700);
		} catch (cause) {
			throw new SupabaseCliRunnerError(
				'unsafe-directory',
				'A Supabase CLI directory is missing, shared or not a plain directory.',
				{ cause }
			);
		}
	}
}

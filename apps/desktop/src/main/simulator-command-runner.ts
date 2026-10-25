import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import type { Writable } from 'node:stream';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const FORCE_KILL_DELAY_MS = 5_000;

export type SimulatorCommandResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

export type SimulatorCommandOptions = {
	stdin?: string;
	timeoutMs?: number;
	maxOutputBytes?: number;
	signal?: AbortSignal;
	cancelSignal?: NodeJS.Signals;
	forceKillDelayMs?: number;
	gracefulCancellationPipe?: boolean;
	simulatorAppEnvironment?: {
		timeZone?: string;
		slowAnimations?: boolean;
	};
	/**
	 * Set over the allowlisted environment for this call alone. Only the
	 * locale can be pinned, and only to C, so that a tool prints the same
	 * bytes whatever locale the desktop was launched in.
	 */
	environment?: { LC_ALL: 'C' };
};

export type SimulatorCommandErrorKind =
	| 'aborted'
	| 'failed'
	| 'output-limit'
	| 'spawn'
	| 'timeout';

export class SimulatorCommandError extends Error {
	readonly kind: SimulatorCommandErrorKind;
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;

	constructor(
		message: string,
		options: {
			kind: SimulatorCommandErrorKind;
			exitCode?: number | null;
			stdout?: string;
			stderr?: string;
			cause?: unknown;
		}
	) {
		super(message, { cause: options.cause });
		this.name = 'SimulatorCommandError';
		this.kind = options.kind;
		this.exitCode = options.exitCode ?? null;
		this.stdout = options.stdout ?? '';
		this.stderr = options.stderr ?? '';
	}
}

function positiveLimit(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isSafeInteger(value) && value > 0
		? value
		: fallback;
}

function commandLabel(executable: string): string {
	const executableName = executable.split('/').at(-1) || 'command';
	return executableName;
}

function closeReservedAuthorizationFd(fd: number | undefined): void {
	if (fd === undefined) return;
	try {
		closeSync(fd);
	} catch {
		// The descriptor is already gone; nothing further to release.
	}
}

function simulatorCommandEnvironment(
	appEnvironment: SimulatorCommandOptions['simulatorAppEnvironment'],
	gracefulCancellationPipe: boolean,
	overrides: SimulatorCommandOptions['environment']
): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {
		PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
	};
	for (const name of [
		'DEVELOPER_DIR',
		'HOME',
		'LANG',
		'LC_ALL',
		'LOGNAME',
		'TMPDIR',
		'USER',
	] as const) {
		const value = process.env[name];
		if (value !== undefined) environment[name] = value;
	}
	// LC_ALL outranks LANG and every LC_* variable.
	if (overrides?.LC_ALL === 'C') environment.LC_ALL = 'C';
	if (gracefulCancellationPipe) {
		environment.RNDEVTOOLS_HELPER_CONTROL_FD = '4';
	}
	if (appEnvironment?.timeZone !== undefined) {
		const timeZoneSegments = appEnvironment.timeZone.split('/');
		if (
			appEnvironment.timeZone.length > 128 ||
			!/^[A-Za-z0-9][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9][A-Za-z0-9._+-]*){0,3}$/.test(
				appEnvironment.timeZone
			) ||
			timeZoneSegments.some((segment) => segment === '.' || segment === '..')
		) {
			throw new SimulatorCommandError('Simulator app time zone is invalid.', {
				kind: 'spawn',
			});
		}
		environment.SIMCTL_CHILD_TZ = appEnvironment.timeZone;
	}
	if (appEnvironment?.slowAnimations !== undefined) {
		environment.SIMCTL_CHILD_RNDEVTOOLS_SLOW_ANIMATIONS =
			appEnvironment.slowAnimations ? '1' : '0';
	}
	return environment;
}

export async function runSimulatorCommand(
	executable: string,
	args: readonly string[],
	options: SimulatorCommandOptions = {}
): Promise<SimulatorCommandResult> {
	if (!executable.startsWith('/')) {
		throw new SimulatorCommandError(
			'Simulator executable must use an absolute path.',
			{
				kind: 'spawn',
			}
		);
	}
	if (options.signal?.aborted) {
		throw new SimulatorCommandError('Simulator command was cancelled.', {
			kind: 'aborted',
		});
	}

	const timeoutMs = positiveLimit(options.timeoutMs, DEFAULT_TIMEOUT_MS);
	const maxOutputBytes = positiveLimit(
		options.maxOutputBytes,
		DEFAULT_MAX_OUTPUT_BYTES
	);
	const label = commandLabel(executable);
	const forceKillDelayMs = positiveLimit(
		options.forceKillDelayMs,
		FORCE_KILL_DELAY_MS
	);

	return new Promise<SimulatorCommandResult>((resolve, reject) => {
		let settled = false;
		let timedOut = false;
		let aborted = false;
		let outputLimited = false;
		let outputBytes = 0;
		let controlPipeClosed = false;
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let forceKillTimer: NodeJS.Timeout | undefined;

		let child: ChildProcessWithoutNullStreams;
		// Descriptor 3 is reserved for the one-shot mutation authorization, and on a
		// read-only run it carries nothing. It still must be a character device
		// rather than 'ignore': above descriptor 2, 'ignore' yields a pollable FIFO
		// with no peer, which the helper's Go runtime registers with its netpoll
		// kqueue. The helper then closes descriptor 3 exactly once as the spent
		// authorization, tearing that registration down underneath the running
		// scheduler ("fatal error: runtime: netpoll failed"). /dev/null is never
		// added to the poller, so the same close is inert.
		let reservedAuthorizationFd: number | undefined;
		try {
			if (options.gracefulCancellationPipe) {
				reservedAuthorizationFd = openSync('/dev/null', 'r');
			}
			child = spawn(executable, [...args], {
				env: simulatorCommandEnvironment(
					options.simulatorAppEnvironment,
					options.gracefulCancellationPipe === true,
					options.environment
				),
				stdio:
					options.gracefulCancellationPipe &&
					reservedAuthorizationFd !== undefined
						? ['pipe', 'pipe', 'pipe', reservedAuthorizationFd, 'pipe']
						: ['pipe', 'pipe', 'pipe'],
				shell: false,
				windowsHide: true,
			}) as ChildProcessWithoutNullStreams;
		} catch (cause) {
			closeReservedAuthorizationFd(reservedAuthorizationFd);
			reject(
				new SimulatorCommandError(`${label} could not start.`, {
					kind: 'spawn',
					cause,
				})
			);
			return;
		}
		// The child holds its own duplicate once spawn returns.
		closeReservedAuthorizationFd(reservedAuthorizationFd);
		const controlPipe = options.gracefulCancellationPipe
			? (child.stdio[4] as Writable | null)
			: undefined;
		if (options.gracefulCancellationPipe && !controlPipe) {
			child.kill('SIGKILL');
			reject(
				new SimulatorCommandError(
					`${label} control pipe could not be created.`,
					{
						kind: 'spawn',
					}
				)
			);
			return;
		}
		controlPipe?.on('error', () => {
			// Process exit is authoritative; ignore a late EPIPE while requesting cleanup.
		});

		const requestGracefulCancellation = () => {
			if (!controlPipe || controlPipeClosed) return false;
			controlPipeClosed = true;
			controlPipe.end();
			return true;
		};

		const stop = (signal: NodeJS.Signals) => {
			if (child.exitCode !== null || child.signalCode !== null) return;
			if (!requestGracefulCancellation()) {
				try {
					child.kill(signal);
				} catch {
					// The child may have exited between the status check and signal.
				}
			}
			if (forceKillTimer) return;
			forceKillTimer = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) {
					try {
						child.kill('SIGKILL');
					} catch {
						// The child already exited.
					}
				}
			}, forceKillDelayMs);
			forceKillTimer.unref();
		};

		const timeout = setTimeout(() => {
			timedOut = true;
			stop(options.cancelSignal ?? 'SIGTERM');
		}, timeoutMs);
		timeout.unref();

		const onAbort = () => {
			aborted = true;
			stop(options.cancelSignal ?? 'SIGTERM');
		};
		options.signal?.addEventListener('abort', onAbort, { once: true });

		const append = (target: Buffer[], chunk: Buffer) => {
			if (outputLimited) return;
			outputBytes += chunk.byteLength;
			if (outputBytes > maxOutputBytes) {
				outputLimited = true;
				stop('SIGTERM');
				return;
			}
			target.push(chunk);
		};
		child.stdout.on('data', (chunk: Buffer) => append(stdoutChunks, chunk));
		child.stderr.on('data', (chunk: Buffer) => append(stderrChunks, chunk));
		child.stdin.on('error', () => {
			// Process exit is authoritative; ignore a late EPIPE while delivering stdin.
		});

		const cleanup = () => {
			requestGracefulCancellation();
			clearTimeout(timeout);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			options.signal?.removeEventListener('abort', onAbort);
		};

		child.once('error', (cause) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(
				new SimulatorCommandError(`${label} could not start.`, {
					kind: 'spawn',
					cause,
				})
			);
		});

		child.once('close', (code) => {
			if (settled) return;
			settled = true;
			cleanup();
			const stdout = Buffer.concat(stdoutChunks).toString('utf8');
			const stderr = Buffer.concat(stderrChunks).toString('utf8');
			if (outputLimited) {
				reject(
					new SimulatorCommandError(`${label} exceeded its output limit.`, {
						kind: 'output-limit',
						exitCode: code,
						stdout,
						stderr,
					})
				);
				return;
			}
			if (timedOut) {
				reject(
					new SimulatorCommandError(`${label} timed out.`, {
						kind: 'timeout',
						exitCode: code,
						stdout,
						stderr,
					})
				);
				return;
			}
			if (aborted) {
				reject(
					new SimulatorCommandError(`${label} was cancelled.`, {
						kind: 'aborted',
						exitCode: code,
						stdout,
						stderr,
					})
				);
				return;
			}
			if (code !== 0) {
				reject(
					new SimulatorCommandError(
						`${label} failed with exit code ${code ?? 'unknown'}.`,
						{
							kind: 'failed',
							exitCode: code,
							stdout,
							stderr,
						}
					)
				);
				return;
			}
			resolve({ stdout, stderr, exitCode: code });
		});

		if (options.stdin === undefined) {
			child.stdin.end();
		} else {
			child.stdin.end(options.stdin, 'utf8');
		}
	});
}

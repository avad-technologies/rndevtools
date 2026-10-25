import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';
import {
	diagnosticErrorText,
	redactDiagnosticText,
} from '@rndevtools/core/redact';
import {
	type AgentCliCommand,
	type AgentCliErrorBody,
	type AgentCliRequest,
	type AgentCliResponse,
	agentCliRequestSchema,
	RNDEVTOOLS_AGENT_CLI_PROTOCOL,
} from '../shared/agent-cli-protocol';
import { SUPABASE_AGENT_DEFAULT_WAIT_MS } from '../shared/supabase-protocol';

const MAX_CONNECTIONS = 8;
const MAX_REQUESTS_PER_WINDOW = 120;
const RATE_WINDOW_MS = 10_000;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
/**
 * Lane up and launch boot a Simulator and wait for Metro, and native plans
 * fingerprint a worktree with Expo's own tooling. The Go CLI waits 240 s for
 * them; stopping just short of that still reaches the agent as a typed error.
 */
const LONG_REQUEST_TIMEOUT_MS = 230_000;
/**
 * `supabase up` waits up to waitMs for the stack and then answers with a job,
 * so it gets that wait plus this margin. Reads (ls, status, env, log) answer
 * from quick CLI calls. down only queues a stop and destroy only files a
 * request, so both stay inside the Go CLI's 45 s deadline for them; reset
 * keeps the default, inside the CLI's 75 s.
 */
const SUPABASE_UP_MARGIN_MS = 10_000;
const SUPABASE_READ_TIMEOUT_MS = 30_000;
const SUPABASE_QUICK_TIMEOUT_MS = 40_000;
const MAX_REQUEST_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_ERROR_LENGTH = 4 * 1024;
/**
 * The CLI half-closes after its request, so by the time a handler runs the
 * socket has read its EOF and is no longer polled: a client that then hangs
 * up (a cancelled MCP call, a CLI deadline, a killed process) shows only when
 * something is written. While a handler runs, one space goes out this often.
 * A write to a closed peer fails at once (EPIPE), which closes the socket and
 * aborts the handler. JSON allows whitespace before a value, so the answer
 * still parses as one line.
 */
const LIVENESS_PROBE_INTERVAL_MS = 1_000;
/**
 * Bounds the probe spaces, which count toward MAX_RESPONSE_BYTES: more than
 * the longest handler budget needs at one a second.
 */
const MAX_LIVENESS_PROBES = 1_024;
const LIVENESS_PROBE = Buffer.from(' ', 'utf8');

type AgentCliHandlerContext = {
	requestId: string;
	signal: AbortSignal;
	/** Session attribution from the request envelope, when the CLI had one. */
	agent?: { kind: 'claude' | 'codex' | 'other'; sessionId: string };
};

export type AgentCliHandler = (
	command: AgentCliCommand,
	context: AgentCliHandlerContext
) => Promise<unknown>;

export type AgentCliServiceState = {
	status: 'stopped' | 'available' | 'unavailable';
	socketPath?: string;
	protocol: typeof RNDEVTOOLS_AGENT_CLI_PROTOCOL;
	error?: string;
};

export class AgentCliError extends Error {
	readonly code: string;
	readonly retryable: boolean;
	readonly recovery: string | undefined;

	constructor({
		code,
		message,
		retryable = false,
		recovery,
	}: {
		code: string;
		message: string;
		retryable?: boolean;
		recovery?: string;
	}) {
		super(message);
		this.name = 'AgentCliError';
		this.code = code;
		this.retryable = retryable;
		this.recovery = recovery;
	}
}

function safeErrorBody(error: unknown): AgentCliErrorBody {
	const known = error instanceof AgentCliError ? error : undefined;
	const message = redactDiagnosticText(
		known?.message ?? diagnosticErrorText(error)
	).slice(0, MAX_ERROR_LENGTH);
	return {
		code:
			known?.code && /^[a-z][a-z0-9_]{0,63}$/.test(known.code)
				? known.code
				: 'internal_error',
		message: message || 'The agent request failed.',
		retryable: known?.retryable ?? false,
		...(known?.recovery
			? {
					recovery: redactDiagnosticText(known.recovery).slice(
						0,
						MAX_ERROR_LENGTH
					),
				}
			: {}),
	};
}

function handlerTimeoutMs(command: AgentCliCommand): number {
	if (command.kind === 'wait') {
		return Math.min(MAX_REQUEST_TIMEOUT_MS, command.timeoutMs + 5_000);
	}
	if (command.kind === 'recipe' && command.operation === 'run') {
		return MAX_REQUEST_TIMEOUT_MS;
	}
	if (
		command.kind === 'native' ||
		(command.kind === 'lane' &&
			(command.operation === 'up' || command.operation === 'launch'))
	) {
		return LONG_REQUEST_TIMEOUT_MS;
	}
	if (command.kind === 'supabase') return supabaseTimeoutMs(command);
	return REQUEST_TIMEOUT_MS;
}

function supabaseTimeoutMs(
	command: Extract<AgentCliCommand, { kind: 'supabase' }>
): number {
	switch (command.operation) {
		case 'up':
			return (
				(command.waitMs ?? SUPABASE_AGENT_DEFAULT_WAIT_MS) +
				SUPABASE_UP_MARGIN_MS
			);
		case 'ls':
		case 'status':
		case 'env':
		case 'log':
			return SUPABASE_READ_TIMEOUT_MS;
		case 'destroy':
		case 'down':
			return SUPABASE_QUICK_TIMEOUT_MS;
		case 'reset':
			return REQUEST_TIMEOUT_MS;
	}
}

function failureResponse(
	id: string,
	error: AgentCliErrorBody
): AgentCliResponse {
	return {
		protocol: RNDEVTOOLS_AGENT_CLI_PROTOCOL,
		id: id.slice(0, 256),
		ok: false,
		error,
	};
}

/**
 * The response line, at most maxBytes long; the CLI counts the probe spaces
 * already written ahead of it toward the same limit.
 */
function encodeResponse(
	response: AgentCliResponse,
	maxBytes = MAX_RESPONSE_BYTES
): Buffer {
	let encoded: Buffer;
	try {
		encoded = Buffer.from(`${JSON.stringify(response)}\n`, 'utf8');
	} catch {
		encoded = Buffer.from(
			`${JSON.stringify(
				failureResponse(response.id, {
					code: 'response_not_serializable',
					message: 'The command result could not be serialized.',
					retryable: false,
				})
			)}\n`,
			'utf8'
		);
	}
	if (encoded.byteLength <= maxBytes) return encoded;
	return Buffer.from(
		`${JSON.stringify(
			failureResponse(response.id, {
				code: 'response_too_large',
				message: 'The command result exceeded the 512 KiB response limit.',
				retryable: false,
				recovery: 'Narrow the query or request fewer records.',
			})
		)}\n`,
		'utf8'
	);
}

function isMissingFile(error: unknown): boolean {
	return Boolean(
		error &&
			typeof error === 'object' &&
			'code' in error &&
			(error as { code?: unknown }).code === 'ENOENT'
	);
}

export class AgentCliService {
	readonly #socketPath: string;
	readonly #socketDirectory: string;
	readonly #handler: AgentCliHandler;
	readonly #platform: NodeJS.Platform;
	readonly #readiness: (() => Promise<void>) | undefined;
	readonly #livenessProbeMs: number;
	readonly #connections = new Set<Socket>();
	readonly #requestTimestamps: number[] = [];
	#server: Server | undefined;
	#state: AgentCliServiceState = {
		status: 'stopped',
		protocol: RNDEVTOOLS_AGENT_CLI_PROTOCOL,
	};

	constructor({
		socketPath,
		handler,
		platform = process.platform,
		readiness,
		livenessProbeMs = LIVENESS_PROBE_INTERVAL_MS,
	}: {
		socketPath: string;
		handler: AgentCliHandler;
		platform?: NodeJS.Platform;
		readiness?: () => Promise<void>;
		/** How often a running handler's socket is probed; tests shorten it. */
		livenessProbeMs?: number;
	}) {
		this.#socketPath = path.resolve(socketPath);
		this.#socketDirectory = path.dirname(this.#socketPath);
		this.#handler = handler;
		this.#platform = platform;
		this.#readiness = readiness;
		this.#livenessProbeMs = livenessProbeMs;
	}

	getState(): AgentCliServiceState {
		return { ...this.#state };
	}

	async start(): Promise<AgentCliServiceState> {
		if (this.#server) return this.getState();
		if (this.#platform !== 'darwin') {
			this.#state = {
				status: 'unavailable',
				protocol: RNDEVTOOLS_AGENT_CLI_PROTOCOL,
				error: 'The local agent CLI is currently available on macOS only.',
			};
			return this.getState();
		}

		try {
			await this.#readiness?.();
			await mkdir(this.#socketDirectory, { recursive: true, mode: 0o700 });
			await chmod(this.#socketDirectory, 0o700);
			const directoryMetadata = await lstat(this.#socketDirectory);
			if (
				!directoryMetadata.isDirectory() ||
				directoryMetadata.isSymbolicLink()
			) {
				throw new AgentCliError({
					code: 'unsafe_socket_directory',
					message:
						'The agent socket directory must be a real private directory.',
				});
			}
			await this.#removeStaleSocket();
			const server = createServer({ allowHalfOpen: true }, (socket) =>
				this.#accept(socket)
			);
			server.maxConnections = MAX_CONNECTIONS;
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error) => {
					server.off('listening', onListening);
					reject(error);
				};
				const onListening = () => {
					server.off('error', onError);
					resolve();
				};
				server.once('error', onError);
				server.once('listening', onListening);
				server.listen(this.#socketPath);
			});
			this.#server = server;
			await chmod(this.#socketPath, 0o600);
			this.#state = {
				status: 'available',
				protocol: RNDEVTOOLS_AGENT_CLI_PROTOCOL,
				socketPath: this.#socketPath,
			};
		} catch (error) {
			const server = this.#server;
			this.#server = undefined;
			if (server) {
				await new Promise<void>((resolve) => server.close(() => resolve()));
				await rm(this.#socketPath, { force: true }).catch(() => undefined);
			}
			for (const socket of this.#connections) socket.destroy();
			this.#connections.clear();
			this.#state = {
				status: 'unavailable',
				protocol: RNDEVTOOLS_AGENT_CLI_PROTOCOL,
				error: safeErrorBody(error).message,
			};
		}
		return this.getState();
	}

	async stop(): Promise<void> {
		const server = this.#server;
		this.#server = undefined;
		for (const socket of this.#connections) socket.destroy();
		this.#connections.clear();
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		if (server) {
			await rm(this.#socketPath, { force: true }).catch(() => undefined);
		}
		this.#state = {
			status: 'stopped',
			protocol: RNDEVTOOLS_AGENT_CLI_PROTOCOL,
		};
	}

	async #removeStaleSocket(): Promise<void> {
		try {
			const metadata = await lstat(this.#socketPath);
			if (!metadata.isSocket()) {
				throw new AgentCliError({
					code: 'unsafe_socket_path',
					message:
						'The configured agent socket path already contains a non-socket file.',
				});
			}
			await rm(this.#socketPath);
		} catch (error) {
			if (!isMissingFile(error)) throw error;
		}
	}

	#accept(socket: Socket): void {
		const now = Date.now();
		while (
			this.#requestTimestamps[0] !== undefined &&
			now - (this.#requestTimestamps[0] as number) >= RATE_WINDOW_MS
		) {
			this.#requestTimestamps.shift();
		}
		if (this.#connections.size >= MAX_CONNECTIONS) {
			socket.end(
				encodeResponse(
					failureResponse('', {
						code: 'server_busy',
						message: 'The local agent command limit has been reached.',
						retryable: true,
					})
				)
			);
			return;
		}
		if (this.#requestTimestamps.length >= MAX_REQUESTS_PER_WINDOW) {
			socket.end(
				encodeResponse(
					failureResponse('', {
						code: 'rate_limited',
						message: 'Too many local agent requests were opened.',
						retryable: true,
					})
				)
			);
			return;
		}
		this.#requestTimestamps.push(now);
		this.#connections.add(socket);
		socket.setTimeout(REQUEST_TIMEOUT_MS);
		let buffer = Buffer.alloc(0);
		let handled = false;
		const close = () => this.#connections.delete(socket);
		socket.once('close', close);
		socket.once('error', close);
		socket.once('timeout', () => {
			socket.end(
				encodeResponse(
					failureResponse('', {
						code: 'request_timeout',
						message: 'The local agent request timed out.',
						retryable: true,
					})
				)
			);
		});
		socket.on('data', (chunk: Buffer) => {
			if (handled) return;
			buffer = Buffer.concat(
				[buffer, chunk],
				buffer.byteLength + chunk.byteLength
			);
			if (buffer.byteLength > MAX_REQUEST_BYTES) {
				handled = true;
				socket.end(
					encodeResponse(
						failureResponse('', {
							code: 'request_too_large',
							message: 'The local agent request exceeded 256 KiB.',
							retryable: false,
						})
					)
				);
			}
		});
		socket.once('end', () => {
			if (handled) return;
			handled = true;
			const newline = buffer.indexOf(0x0a);
			if (newline === -1 || newline !== buffer.byteLength - 1) {
				socket.end(
					encodeResponse(
						failureResponse('', {
							code: 'multiple_requests',
							message:
								'Each connection requires exactly one LF-terminated command and no trailing bytes.',
							retryable: false,
						})
					)
				);
				return;
			}
			void this.#handle(socket, buffer.subarray(0, newline));
		});
	}

	async #handle(socket: Socket, raw: Buffer): Promise<void> {
		let request: AgentCliRequest;
		try {
			if (raw.includes(0)) throw new Error('NUL bytes are not valid JSON.');
			request = agentCliRequestSchema.parse(JSON.parse(raw.toString('utf8')));
		} catch {
			socket.end(
				encodeResponse(
					failureResponse('', {
						code: 'invalid_request',
						message: 'The command did not match rndevtools/1.',
						retryable: false,
						// Usually a CLI or tool list newer or older than this desktop.
						recovery:
							'Update RN Devtools, or restart the agent session to reload the rndevtools tools.',
					})
				)
			);
			return;
		}

		socket.setTimeout(0);
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(),
			handlerTimeoutMs(request.command)
		);
		const onClose = () => controller.abort();
		socket.once('close', onClose);
		// A client that hung up is seen only by a write; see
		// LIVENESS_PROBE_INTERVAL_MS.
		let probes = 0;
		const probe = setInterval(() => {
			if (socket.destroyed || probes >= MAX_LIVENESS_PROBES) {
				clearInterval(probe);
				return;
			}
			probes += 1;
			socket.write(LIVENESS_PROBE);
		}, this.#livenessProbeMs);
		try {
			const result = await this.#handler(request.command, {
				requestId: request.id,
				signal: controller.signal,
				...(request.agent ? { agent: request.agent } : {}),
			});
			if (!socket.destroyed) {
				socket.end(
					encodeResponse(
						{
							protocol: RNDEVTOOLS_AGENT_CLI_PROTOCOL,
							id: request.id,
							ok: true,
							result,
						},
						MAX_RESPONSE_BYTES - probes
					)
				);
			}
		} catch (error) {
			if (!socket.destroyed) {
				socket.end(
					encodeResponse(
						failureResponse(request.id, safeErrorBody(error)),
						MAX_RESPONSE_BYTES - probes
					)
				);
			}
		} finally {
			clearTimeout(timer);
			clearInterval(probe);
			socket.off('close', onClose);
		}
	}
}

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { createServer, type Server as HttpServer } from 'node:http';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { Duplex } from 'node:stream';
import { URL } from 'node:url';
import { redactDiagnosticText } from '@rndevtools/core/redact';
import { truncateText } from '@rndevtools/core/serialize';
import { WebSocket, WebSocketServer } from 'ws';
import { createDemoDevice, tickDemoDevice } from '../shared/demo-data';
import {
	createEmptyDeviceTools,
	DEFAULT_BROKER_HOST,
	DEFAULT_BROKER_PORT,
	DESKTOP_PROTOCOL_VERSION,
	type DesktopAction,
	type DesktopActionResult,
	type DesktopState,
	type DeviceInfo,
	type DeviceMessage,
	type DeviceSession,
	type DiagnosticEntry,
} from '../shared/protocol';
import { BrokerActionRouter } from './broker-actions';
import {
	brokerRawDataByteLength,
	parseBrokerDeviceMessage,
	safeBrokerErrorText,
} from './broker-inbound';
import { projectBrokerState } from './broker-state';

const MAX_DIAGNOSTICS = 500;
const MAX_DIAGNOSTIC_SCOPE_LENGTH = 256;
const MAX_DIAGNOSTIC_MESSAGE_BYTES = 8 * 1024;
const MAX_DEVICE_SESSIONS = 50;
const MAX_OPEN_CONNECTIONS = MAX_DEVICE_SESSIONS + 8;
const MAX_MESSAGES_PER_RATE_WINDOW = 8;
const MAX_MESSAGE_BYTES_PER_RATE_WINDOW = 24 * 1024 * 1024;
// The wire schema bounds individual arrays and fields, but not the retained
// total across 50 sessions. Charge each accepted snapshot by its raw frame size
// to keep that shared state bounded without a second serialization pass.
const MAX_RETAINED_SNAPSHOT_WIRE_BYTES = 64 * 1024 * 1024;
const MESSAGE_RATE_WINDOW_MS = 1_000;
const STATE_EMIT_INTERVAL_MS = 100;
const MAX_PORT_ATTEMPTS = 10;
const HELLO_TIMEOUT_MS = 5_000;
const DEVICE_STALE_MS = 15_000;
const OFFLINE_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MIN_BROKER_TOKEN_LENGTH = 16;
const MAX_BROKER_TOKEN_LENGTH = 512;

type BrokerListener = (state: DesktopState) => void;

type RemoteSession = {
	device: DeviceSession;
	socket?: WebSocket;
	snapshotWireBytes: number;
};

type DesktopBrokerLimits = {
	maxDiagnostics: number;
	maxOpenConnections: number;
	maxMessagesPerRateWindow: number;
	maxMessageBytesPerRateWindow: number;
	maxRetainedSnapshotWireBytes: number;
};

const DEFAULT_BROKER_LIMITS: DesktopBrokerLimits = {
	maxDiagnostics: MAX_DIAGNOSTICS,
	maxOpenConnections: MAX_OPEN_CONNECTIONS,
	maxMessagesPerRateWindow: MAX_MESSAGES_PER_RATE_WINDOW,
	maxMessageBytesPerRateWindow: MAX_MESSAGE_BYTES_PER_RATE_WINDOW,
	maxRetainedSnapshotWireBytes: MAX_RETAINED_SNAPSHOT_WIRE_BYTES,
};

export type DesktopBrokerOptions = {
	host?: string;
	port?: number;
	includeDemoDevice?: boolean;
	token?: string;
	allowWildcardBind?: boolean;
	now?: () => number;
	/** Test and embedding overrides; production uses the conservative defaults. */
	limits?: Partial<DesktopBrokerLimits>;
};

function positiveIntegerLimit(
	value: number | undefined,
	fallback: number
): number {
	if (value === undefined || !Number.isSafeInteger(value) || value <= 0)
		return fallback;
	return value;
}

function diagnosticId(now: number, sequence: number): string {
	return `broker-${now}-${sequence}`;
}

function socketAddress(request: IncomingMessage): string {
	return request.socket.remoteAddress ?? 'local client';
}

function availableLanAddresses(): string[] {
	const addresses = new Set<string>();
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.family === 'IPv4' && !entry.internal)
				addresses.add(entry.address);
		}
	}
	return [...addresses].sort();
}

function canonicalIpHost(host: string): string {
	const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
	if (isIP(normalized) !== 6) return normalized;
	try {
		return new URL(`ws://[${normalized}]:1/device`).hostname.replace(
			/^\[|\]$/g,
			''
		);
	} catch {
		return normalized;
	}
}

function isLoopbackHost(host: string): boolean {
	const normalized = canonicalIpHost(host);
	if (normalized === 'localhost') return true;
	if (isIP(normalized) === 4) return normalized.startsWith('127.');
	return normalized === '::1';
}

function isUnspecifiedAddress(address: string): boolean {
	const normalized = canonicalIpHost(address);
	return normalized === '0.0.0.0' || normalized === '::';
}

function isWildcardHost(host: string): boolean {
	return isUnspecifiedAddress(host);
}

function normalizeBrokerHost(host: string): string {
	const trimmed = host.trim();
	return trimmed.startsWith('[') && trimmed.endsWith(']')
		? trimmed.slice(1, -1)
		: trimmed;
}

function isValidBrokerHost(host: string): boolean {
	if (!host || host.length > 253 || /[\s/?#@]/.test(host)) return false;
	const displayHost = host.includes(':') ? `[${host}]` : host;
	try {
		const url = new URL(`ws://${displayHost}:1/device`);
		return url.hostname.length > 0 && url.port === '1';
	} catch {
		return false;
	}
}

function isAllowedUnauthenticatedOrigin(
	origin: string | string[] | undefined
): boolean {
	if (origin === undefined) return true;
	if (Array.isArray(origin) || origin.length > 8 * 1024) return false;
	try {
		const url = new URL(origin);
		return (
			(url.protocol === 'http:' || url.protocol === 'https:') &&
			isLoopbackHost(url.hostname) &&
			!url.username &&
			!url.password
		);
	} catch {
		return false;
	}
}

function websocketUrl(host: string, port: number, token?: string): string {
	const displayHost =
		host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
	const url = new URL(`ws://${displayHost}:${port}/device`);
	if (token) url.searchParams.set('token', token);
	return url.toString();
}

function brokerUrls(host: string, port: number, token?: string): string[] {
	if (!isWildcardHost(host)) {
		return [websocketUrl(host, port, token)];
	}
	return [
		websocketUrl('127.0.0.1', port, token),
		...availableLanAddresses().map((address) =>
			websocketUrl(address, port, token)
		),
	];
}

function requestUrl(request: IncomingMessage): URL | undefined {
	try {
		return new URL(request.url ?? '/', 'http://localhost');
	} catch {
		return undefined;
	}
}

function tokensMatch(expected: string, received: string | null): boolean {
	if (!received) return false;
	const expectedBytes = Buffer.from(expected);
	const receivedBytes = Buffer.from(received);
	return (
		expectedBytes.length === receivedBytes.length &&
		timingSafeEqual(expectedBytes, receivedBytes)
	);
}

function closeUpgrade(socket: Duplex, status: number, message: string): void {
	socket.write(
		`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
	);
	socket.destroy();
}

export class DesktopBroker {
	readonly #host: string;
	readonly #requestedPort: number;
	readonly #token: string | undefined;
	readonly #allowWildcardBind: boolean;
	readonly #configurationError: string | undefined;
	readonly #now: () => number;
	readonly #limits: DesktopBrokerLimits;
	readonly #actionRouter: BrokerActionRouter;
	readonly #listeners = new Set<BrokerListener>();
	readonly #sessions = new Map<string, RemoteSession>();
	readonly #diagnostics: DiagnosticEntry[] = [];
	#httpServer: HttpServer | undefined;
	#webSocketServer: WebSocketServer | undefined;
	#maintenanceTimer: NodeJS.Timeout | undefined;
	#stateEmitTimer: NodeJS.Timeout | undefined;
	#startPromise: Promise<void> | undefined;
	#stopRequested = false;
	#diagnosticSequence = 0;
	#retainedSnapshotWireBytes = 0;
	#status: DesktopState['broker']['status'] = 'starting';
	#port: number;
	#error: string | undefined;

	constructor(options: DesktopBrokerOptions = {}) {
		this.#host = normalizeBrokerHost(
			options.host?.trim() || DEFAULT_BROKER_HOST
		);
		this.#requestedPort = options.port ?? DEFAULT_BROKER_PORT;
		this.#port =
			Number.isInteger(this.#requestedPort) &&
			this.#requestedPort >= 1 &&
			this.#requestedPort <= 65_535
				? this.#requestedPort
				: DEFAULT_BROKER_PORT;
		this.#now = options.now ?? Date.now;
		this.#limits = {
			maxDiagnostics: positiveIntegerLimit(
				options.limits?.maxDiagnostics,
				DEFAULT_BROKER_LIMITS.maxDiagnostics
			),
			maxOpenConnections: positiveIntegerLimit(
				options.limits?.maxOpenConnections,
				DEFAULT_BROKER_LIMITS.maxOpenConnections
			),
			maxMessagesPerRateWindow: positiveIntegerLimit(
				options.limits?.maxMessagesPerRateWindow,
				DEFAULT_BROKER_LIMITS.maxMessagesPerRateWindow
			),
			maxMessageBytesPerRateWindow: positiveIntegerLimit(
				options.limits?.maxMessageBytesPerRateWindow,
				DEFAULT_BROKER_LIMITS.maxMessageBytesPerRateWindow
			),
			maxRetainedSnapshotWireBytes: positiveIntegerLimit(
				options.limits?.maxRetainedSnapshotWireBytes,
				DEFAULT_BROKER_LIMITS.maxRetainedSnapshotWireBytes
			),
		};
		this.#actionRouter = new BrokerActionRouter({
			getSession: (deviceId) => this.#sessions.get(deviceId),
			now: this.#now,
			record: (level, scope, message) => this.#record(level, scope, message),
			emit: () => this.#emit(),
		});
		this.#token = options.token?.trim() || undefined;
		this.#allowWildcardBind = options.allowWildcardBind === true;
		this.#configurationError = !isValidBrokerHost(this.#host)
			? 'The broker bind address is not a valid host.'
			: !Number.isInteger(this.#requestedPort) ||
					this.#requestedPort < 1 ||
					this.#requestedPort > 65_535
				? 'The broker port must be an integer between 1 and 65535.'
				: isWildcardHost(this.#host) && !this.#allowWildcardBind
					? 'Wildcard broker binding requires RNDEVTOOLS_ALLOW_WILDCARD=true.'
					: !isLoopbackHost(this.#host) &&
							(!this.#token || this.#token.length < MIN_BROKER_TOKEN_LENGTH)
						? `LAN binding requires RNDEVTOOLS_TOKEN with at least ${MIN_BROKER_TOKEN_LENGTH} characters.`
						: this.#token && this.#token.length > MAX_BROKER_TOKEN_LENGTH
							? `RNDEVTOOLS_TOKEN cannot exceed ${MAX_BROKER_TOKEN_LENGTH} characters.`
							: undefined;
		if (options.includeDemoDevice === true) {
			const demo = createDemoDevice(this.#now());
			const snapshotWireBytes = Buffer.byteLength(
				JSON.stringify(demo.tools),
				'utf8'
			);
			this.#retainedSnapshotWireBytes = snapshotWireBytes;
			this.#sessions.set(demo.info.id, { device: demo, snapshotWireBytes });
		}
	}

	getState = (): DesktopState => {
		this.#expireOfflineSessions();
		return projectBrokerState({
			broker: {
				status: this.#status,
				host: this.#host,
				port: this.#port,
				access: this.#token ? 'token' : 'loopback',
				urls: isValidBrokerHost(this.#host)
					? brokerUrls(this.#host, this.#port, this.#token)
					: [],
				error: this.#error,
			},
			sessions: this.#sessions.values(),
			diagnostics: this.#diagnostics,
		});
	};

	subscribe(listener: BrokerListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	start(): Promise<void> {
		if (this.#httpServer) return Promise.resolve();
		if (this.#startPromise) return this.#startPromise;
		this.#stopRequested = false;
		const startPromise = this.#startInternal().finally(() => {
			if (this.#startPromise === startPromise) this.#startPromise = undefined;
		});
		this.#startPromise = startPromise;
		return startPromise;
	}

	async #startInternal(): Promise<void> {
		this.#status = 'starting';
		this.#emit();
		if (this.#configurationError) {
			this.#status = 'error';
			this.#error = this.#configurationError;
			this.#record('error', 'configuration', this.#configurationError);
			this.#emit();
			return;
		}

		for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt += 1) {
			if (this.#stopRequested) return;
			const candidatePort = this.#requestedPort + attempt;
			if (candidatePort > 65_535) break;
			try {
				await this.#listen(candidatePort);
				if (this.#stopRequested) {
					await this.#closeServers();
					return;
				}
				this.#port = candidatePort;
				this.#status = 'listening';
				this.#error = undefined;
				this.#record(
					'info',
					'broker',
					`Listening on ${brokerUrls(this.#host, candidatePort).join(', ')}${this.#token ? ' with token authentication' : ''}.`
				);
				this.#startMaintenanceTicker();
				this.#emit();
				return;
			} catch (error) {
				await this.#closeServers();
				if (this.#stopRequested) return;
				const code =
					error && typeof error === 'object' && 'code' in error
						? String(error.code)
						: '';
				if (code !== 'EADDRINUSE' || attempt === MAX_PORT_ATTEMPTS - 1) {
					this.#status = 'error';
					this.#error = safeBrokerErrorText(error);
					this.#record('error', 'broker', `Failed to start: ${this.#error}`);
					this.#emit();
					return;
				}
			}
		}
		if (this.#stopRequested) return;
		this.#status = 'error';
		this.#error = 'No valid broker port remained in the configured range.';
		this.#record('error', 'broker', this.#error);
		this.#emit();
	}

	async stop(): Promise<void> {
		this.#stopRequested = true;
		await this.#startPromise?.catch(() => undefined);
		this.#stopMaintenanceTicker();
		this.#cancelScheduledEmit();
		this.#actionRouter.stop();
		for (const session of this.#sessions.values()) {
			session.socket?.close(1001, 'Desktop app shutting down');
		}
		await this.#closeServers();
		this.#cancelScheduledEmit();
		this.#status = 'stopped';
		this.#emit();
	}

	dispatchAction(action: DesktopAction): Promise<DesktopActionResult> {
		return this.#actionRouter.dispatch(action);
	}

	async #listen(port: number): Promise<void> {
		const webSocketServer = new WebSocketServer({
			noServer: true,
			// Collector stores are individually bounded; this cap accommodates one
			// complete multi-tool snapshot while still rejecting unbounded LAN input.
			maxPayload: 16 * 1024 * 1024,
			perMessageDeflate: false,
		});
		const server = createServer((request, response) => {
			const url = requestUrl(request);
			if (!url) {
				response.writeHead(400, {
					'content-type': 'text/plain; charset=utf-8',
				});
				response.end('Bad request');
				return;
			}
			const { pathname } = url;
			if (request.method === 'GET' && pathname === '/health') {
				if (
					this.#token &&
					!tokensMatch(this.#token, url.searchParams.get('token'))
				) {
					response.writeHead(401, {
						'content-type': 'text/plain; charset=utf-8',
						'cache-control': 'no-store',
					});
					response.end('Unauthorized');
					return;
				}
				response.writeHead(200, {
					'content-type': 'application/json; charset=utf-8',
					'cache-control': 'no-store',
				});
				response.end(
					JSON.stringify({
						name: 'RN Devtools',
						status: 'ok',
						protocolVersion: DESKTOP_PROTOCOL_VERSION,
						access: this.#token ? 'token' : 'loopback',
					})
				);
				return;
			}
			response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
			response.end('Not found');
		});
		server.headersTimeout = 5_000;
		server.requestTimeout = 5_000;
		server.keepAliveTimeout = 5_000;
		server.maxHeadersCount = 100;
		server.maxConnections = this.#limits.maxOpenConnections;

		server.on('upgrade', (request, socket, head) => {
			const url = requestUrl(request);
			if (!url) {
				closeUpgrade(socket, 400, 'Bad Request');
				return;
			}
			if (url.pathname !== '/device') {
				closeUpgrade(socket, 404, 'Not Found');
				return;
			}
			if (
				!this.#token &&
				!isAllowedUnauthenticatedOrigin(request.headers.origin)
			) {
				closeUpgrade(socket, 403, 'Forbidden');
				return;
			}
			if (
				this.#token &&
				!tokensMatch(this.#token, url.searchParams.get('token'))
			) {
				closeUpgrade(socket, 401, 'Unauthorized');
				return;
			}
			if (webSocketServer.clients.size >= this.#limits.maxOpenConnections) {
				closeUpgrade(socket, 503, 'Connection Limit Reached');
				return;
			}
			webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
				webSocketServer.emit('connection', webSocket, request);
			});
		});
		webSocketServer.on('connection', (socket, request) =>
			this.#handleConnection(socket, request)
		);

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
			server.listen(port, this.#host);
		});
		// `isWildcardHost` can only recognise spellings it knows. The host string
		// reaches the OS resolver, which also accepts abbreviated inet_aton forms
		// ('0', '0.0', '0x0') and IPv4-mapped addresses, and binds every interface
		// for each of them. Ask the listening socket what it actually bound so an
		// unrecognised spelling cannot slip past the wildcard opt-in.
		const bound = server.address();
		if (
			bound !== null &&
			typeof bound === 'object' &&
			isUnspecifiedAddress(bound.address) &&
			!this.#allowWildcardBind
		) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			webSocketServer.close();
			throw new Error(
				`The broker bind address resolved to ${bound.address}, which listens on every interface. Set RNDEVTOOLS_ALLOW_WILDCARD=true to allow it.`
			);
		}
		this.#httpServer = server;
		this.#webSocketServer = webSocketServer;
		const handleRuntimeError = (scope: string, error: Error) => {
			if (
				this.#httpServer !== server &&
				this.#webSocketServer !== webSocketServer
			) {
				return;
			}
			this.#status = 'error';
			this.#error = safeBrokerErrorText(error);
			this.#record('error', scope, `Broker server failed: ${this.#error}`);
			this.#stopMaintenanceTicker();
			void this.#closeServers().finally(() => this.#emit());
		};
		server.on('error', (error) => handleRuntimeError('http', error));
		webSocketServer.on('error', (error) =>
			handleRuntimeError('websocket', error)
		);
	}

	#handleConnection(socket: WebSocket, request: IncomingMessage): void {
		let deviceId: string | undefined;
		let rateWindowStartedAt = this.#now();
		let rateWindowMessageCount = 0;
		let rateWindowMessageBytes = 0;
		const helloTimer = setTimeout(() => {
			if (!deviceId) socket.close(1008, 'hello required');
		}, HELLO_TIMEOUT_MS);

		socket.on('message', (raw) => {
			if (socket.readyState !== WebSocket.OPEN) return;
			const now = this.#now();
			if (
				now < rateWindowStartedAt ||
				now - rateWindowStartedAt >= MESSAGE_RATE_WINDOW_MS
			) {
				rateWindowStartedAt = now;
				rateWindowMessageCount = 0;
				rateWindowMessageBytes = 0;
			}
			const messageBytes = brokerRawDataByteLength(raw);
			rateWindowMessageCount += 1;
			rateWindowMessageBytes += messageBytes;
			if (
				rateWindowMessageCount > this.#limits.maxMessagesPerRateWindow ||
				rateWindowMessageBytes > this.#limits.maxMessageBytesPerRateWindow
			) {
				this.#record(
					'warn',
					'protocol',
					`Closed ${deviceId ?? socketAddress(request)} after it exceeded the device message rate limit.`
				);
				socket.close(1008, 'device message rate limit exceeded');
				this.#scheduleEmit();
				return;
			}
			let message: DeviceMessage;
			try {
				message = parseBrokerDeviceMessage(raw);
			} catch (error) {
				this.#record(
					'warn',
					'protocol',
					`Rejected invalid device message: ${safeBrokerErrorText(error)}`
				);
				socket.close(1008, 'invalid protocol message');
				this.#scheduleEmit();
				return;
			}

			if (!deviceId) {
				if (message.type !== 'hello') {
					socket.close(1008, 'hello required');
					return;
				}
				clearTimeout(helloTimer);
				deviceId = this.#registerDevice(message.device, socket, request);
				return;
			}

			const session = this.#sessions.get(deviceId);
			if (!session || session.socket !== socket) {
				socket.close(1008, 'stale connection');
				return;
			}
			if (message.type === 'hello') {
				socket.close(1008, 'hello already received');
				return;
			}
			this.#handleDeviceMessage(deviceId, message, messageBytes);
		});

		socket.on('close', (_code, reason) => {
			clearTimeout(helloTimer);
			if (!deviceId) return;
			const session = this.#sessions.get(deviceId);
			if (!session || session.socket !== socket) return;
			delete session.socket;
			session.device.status = 'offline';
			session.device.lastSeenAt = this.#now();
			this.#actionRouter.rejectDevice(
				deviceId,
				'Device disconnected before acknowledging the action.'
			);
			this.#record(
				'warn',
				'connection',
				`${session.device.info.name} disconnected${reason.length ? `: ${reason.toString()}` : ''}.`
			);
			this.#scheduleEmit();
		});

		socket.on('error', (error) => {
			this.#record('warn', 'connection', `Socket error: ${error.message}`);
			this.#scheduleEmit();
		});
	}

	#registerDevice(
		info: DeviceInfo,
		socket: WebSocket,
		request: IncomingMessage
	): string | undefined {
		const now = this.#now();
		const existing = this.#sessions.get(info.id);
		if (!existing && this.#sessions.size >= MAX_DEVICE_SESSIONS) {
			this.#expireOfflineSessions();
			const oldestOffline = [...this.#sessions.entries()]
				.filter(([, session]) => session.device.status === 'offline')
				.sort(
					([, left], [, right]) =>
						left.device.lastSeenAt - right.device.lastSeenAt
				)[0];
			if (oldestOffline) this.#deleteSession(oldestOffline[0]);
		}
		if (!existing && this.#sessions.size >= MAX_DEVICE_SESSIONS) {
			this.#record(
				'warn',
				'connection',
				`Rejected ${info.name}: the ${MAX_DEVICE_SESSIONS}-device session limit is full.`
			);
			socket.close(1013, 'device session limit reached');
			this.#scheduleEmit();
			return undefined;
		}
		if (existing?.socket && existing.socket !== socket) {
			this.#actionRouter.rejectDevice(
				info.id,
				'Device reconnected before acknowledging the action.'
			);
			existing.socket.close(1008, 'replaced by a newer connection');
		}
		if (existing) this.#releaseSnapshot(existing);
		// A new session starts from empty tools under a new connectedAt, which
		// tells the preload's state parser to validate its tools afresh; see
		// #handleDeviceMessage for the rule.
		const device: DeviceSession = {
			info,
			status: 'online',
			connectedAt: now,
			lastSeenAt: now,
			sequence: 0,
			latencyMs: 0,
			tools: createEmptyDeviceTools(),
		};
		this.#sessions.set(info.id, { device, socket, snapshotWireBytes: 0 });
		this.#record(
			'info',
			'connection',
			`${info.name} connected (${socketAddress(request)}).`
		);
		this.#scheduleEmit();
		return info.id;
	}

	#handleDeviceMessage(
		deviceId: string,
		message: DeviceMessage,
		messageWireBytes: number
	): void {
		const session = this.#sessions.get(deviceId);
		if (!session) return;
		const now = this.#now();
		session.device.lastSeenAt = now;

		if (message.type === 'snapshot') {
			if (message.sequence <= session.device.sequence) return;
			if (!this.#reserveSnapshotBudget(deviceId, session, messageWireBytes)) {
				this.#record(
					'warn',
					'protocol',
					`Rejected ${session.device.info.name}'s snapshot because the retained snapshot budget is full.`
				);
				session.socket?.close(1009, 'retained snapshot budget exceeded');
				this.#scheduleEmit();
				return;
			}
			session.device.sequence = message.sequence;
			session.device.latencyMs = Math.max(0, now - message.sentAt);
			// Tools change only together with a higher sequence (here, and in
			// tickDemoDevice) or a new connectedAt (#registerDevice). The preload's
			// state parser reuses the tools it already validated while a session's
			// id, connectedAt and sequence are unchanged, so tools edited in place
			// without a new sequence would leave the renderer showing stale ones.
			session.device.tools = message.tools;
			this.#scheduleEmit();
			return;
		}
		if (message.type === 'heartbeat') {
			session.device.latencyMs = Math.max(0, now - message.sentAt);
			this.#scheduleEmit();
			return;
		}
		if (message.type === 'action-result') {
			this.#actionRouter.handleResult(deviceId, message);
		}
	}

	#reserveSnapshotBudget(
		deviceId: string,
		session: RemoteSession,
		messageWireBytes: number
	): boolean {
		let nextTotal =
			this.#retainedSnapshotWireBytes -
			session.snapshotWireBytes +
			messageWireBytes;
		if (nextTotal > this.#limits.maxRetainedSnapshotWireBytes) {
			const offlineSessions = [...this.#sessions.entries()]
				.filter(
					([id, candidate]) =>
						id !== deviceId && candidate.device.status === 'offline'
				)
				.sort(
					([, left], [, right]) =>
						left.device.lastSeenAt - right.device.lastSeenAt
				);
			for (const [offlineDeviceId] of offlineSessions) {
				this.#deleteSession(offlineDeviceId);
				nextTotal =
					this.#retainedSnapshotWireBytes -
					session.snapshotWireBytes +
					messageWireBytes;
				if (nextTotal <= this.#limits.maxRetainedSnapshotWireBytes) break;
			}
		}
		if (nextTotal > this.#limits.maxRetainedSnapshotWireBytes) return false;
		this.#retainedSnapshotWireBytes = nextTotal;
		session.snapshotWireBytes = messageWireBytes;
		return true;
	}

	#releaseSnapshot(session: RemoteSession): void {
		this.#retainedSnapshotWireBytes = Math.max(
			0,
			this.#retainedSnapshotWireBytes - session.snapshotWireBytes
		);
		session.snapshotWireBytes = 0;
	}

	#deleteSession(deviceId: string): boolean {
		const session = this.#sessions.get(deviceId);
		if (!session) return false;
		this.#releaseSnapshot(session);
		return this.#sessions.delete(deviceId);
	}

	#record(
		level: DiagnosticEntry['level'],
		scope: string,
		message: string
	): void {
		const now = this.#now();
		this.#diagnostics.unshift({
			id: diagnosticId(now, this.#diagnosticSequence),
			at: now,
			level,
			scope: scope.slice(0, MAX_DIAGNOSTIC_SCOPE_LENGTH),
			message: truncateText(
				redactDiagnosticText(message),
				MAX_DIAGNOSTIC_MESSAGE_BYTES
			).text,
		});
		this.#diagnosticSequence += 1;
		if (this.#diagnostics.length > this.#limits.maxDiagnostics) {
			this.#diagnostics.length = this.#limits.maxDiagnostics;
		}
	}

	#emit(): void {
		const state = this.getState();
		for (const listener of [...this.#listeners]) {
			try {
				listener(state);
			} catch {
				// One renderer listener must not interrupt broker lifecycle work.
			}
		}
	}

	#scheduleEmit(): void {
		if (this.#stateEmitTimer) return;
		this.#stateEmitTimer = setTimeout(() => {
			this.#stateEmitTimer = undefined;
			this.#emit();
		}, STATE_EMIT_INTERVAL_MS);
	}

	#cancelScheduledEmit(): void {
		if (this.#stateEmitTimer) clearTimeout(this.#stateEmitTimer);
		this.#stateEmitTimer = undefined;
	}

	#startMaintenanceTicker(): void {
		if (this.#maintenanceTimer) return;
		this.#maintenanceTimer = setInterval(() => {
			const now = this.#now();
			let changed = this.#expireOfflineSessions();
			for (const session of this.#sessions.values()) {
				if (session.device.status === 'simulated') {
					session.device = tickDemoDevice(session.device, now);
					changed = true;
				} else if (
					session.device.status === 'online' &&
					now - session.device.lastSeenAt > DEVICE_STALE_MS
				) {
					session.socket?.terminate();
				}
			}
			if (changed) this.#scheduleEmit();
		}, 1_000);
	}

	#stopMaintenanceTicker(): void {
		if (this.#maintenanceTimer) clearInterval(this.#maintenanceTimer);
		this.#maintenanceTimer = undefined;
	}

	#expireOfflineSessions(): boolean {
		const cutoff = this.#now() - OFFLINE_RETENTION_MS;
		let changed = false;
		for (const [id, session] of this.#sessions) {
			if (
				session.device.status === 'offline' &&
				session.device.lastSeenAt < cutoff
			) {
				this.#deleteSession(id);
				changed = true;
			}
		}
		return changed;
	}

	async #closeServers(): Promise<void> {
		const webSocketServer = this.#webSocketServer;
		const httpServer = this.#httpServer;
		this.#webSocketServer = undefined;
		this.#httpServer = undefined;
		if (webSocketServer) {
			for (const client of webSocketServer.clients) client.terminate();
			await new Promise<void>((resolve) =>
				webSocketServer.close(() => resolve())
			);
		}
		if (httpServer) {
			await new Promise<void>((resolve) => httpServer.close(() => resolve()));
		}
	}
}

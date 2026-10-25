import {
	type DesktopDeviceAction,
	type DesktopDeviceInfoSnapshot,
	type DesktopDeviceToolsSnapshot,
	RNDEVTOOLS_SNAPSHOT_LIMITS,
} from '@rndevtools/core/desktop-protocol';
import { utf8ByteLength } from '@rndevtools/core/serialize';
import {
	disableDevtoolsAuthorization,
	getDevtoolsAuthorization,
	setDevtoolsAuthorization,
} from '../authorization';
import type {
	DesktopClientHandle,
	DesktopClientHost,
	DesktopDiagnostic,
} from './client';
import {
	DesktopActionAdmissionController,
	DesktopActionReplayCache,
	desktopBrokerCandidates,
	limitDesktopProjection,
	shouldStartDesktopClient,
	simulatorUdidFromPath,
	startDesktopClient,
} from './client';

// `./desktop` is the entry point a headless host module imports. It must not
// load the core plugins barrel, which pulls in the panel UI, or the camera's
// optional peers; either factory throws if anything reaches it.
jest.mock('@rndevtools/core/plugins', () => {
	throw new Error('The ./desktop entry point loaded @rndevtools/core/plugins.');
});
jest.mock('expo-file-system', () => {
	throw new Error('The ./desktop entry point loaded expo-file-system.');
});
// A pass-through spy, so a test can tell which strings the client walked to
// count their UTF-8 bytes.
jest.mock('@rndevtools/core/serialize', () => {
	const actual = jest.requireActual<
		typeof import('@rndevtools/core/serialize')
	>('@rndevtools/core/serialize');
	return { ...actual, utf8ByteLength: jest.fn(actual.utf8ByteLength) };
});

const mockUtf8ByteLength = jest.mocked(utf8ByteLength);
// The client's private size limits.
const MAX_INCOMING_BYTES = 600 * 1024;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

const mockRunDesktopAction = jest.fn<
	Promise<void>,
	Parameters<DesktopClientHost['runAction']>
>();
const mockCaptureDesktopTools = jest.fn<
	DesktopDeviceToolsSnapshot,
	[readonly DesktopDiagnostic[]]
>(() => ({}) as never);

const testDevice: DesktopDeviceInfoSnapshot = {
	id: 'device-1',
	name: 'Test device',
	platform: 'ios',
	capabilities: ['console.clear'],
};

// The client is host-agnostic, so the suite injects a host rather than mocking
// a module. Anything a real app would supply is a plain function here.
const testHost: DesktopClientHost = {
	captureTools: mockCaptureDesktopTools,
	createDeviceInfo: () => testDevice,
	runAction: mockRunDesktopAction,
	getAuthorization: getDevtoolsAuthorization,
};

const BROKER_URL = 'ws://localhost:47931/device';

type CloseEvent = { code?: number; reason?: string };

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];

	readyState = 0;
	bufferedAmount = 0;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: ((event?: CloseEvent) => void) | null = null;
	send = jest.fn();
	close = jest.fn((code?: number, reason?: string) => {
		this.readyState = 3;
		this.onclose?.({ code: code ?? 1005, reason: reason ?? '' });
	});

	constructor(readonly url: string) {
		FakeWebSocket.instances.push(this);
	}

	open(): void {
		this.readyState = 1;
		this.onopen?.();
	}

	receive(value: unknown): void {
		this.onmessage?.({ data: JSON.stringify(value) });
	}

	/** Delivers a frame exactly as given, without serializing it. */
	receiveFrame(data: string): void {
		this.onmessage?.({ data });
	}

	/** The broker ends the connection, as it does for a policy violation. */
	serverClose(code: number, reason: string): void {
		this.readyState = 3;
		this.onclose?.({ code, reason });
	}
}

function latestSocket(): FakeWebSocket {
	const socket = FakeWebSocket.instances.at(-1);
	if (!socket) throw new Error('Expected the client to open a socket.');
	return socket;
}

function sentMessages(socket: FakeWebSocket): Record<string, unknown>[] {
	return socket.send.mock.calls.map(
		([message]) => JSON.parse(String(message)) as Record<string, unknown>,
	);
}

function actionResults(socket: FakeWebSocket): Record<string, unknown>[] {
	return sentMessages(socket).filter(
		(message) => message.type === 'action-result',
	);
}

function consoleClear(actionId: string, deviceId = 'device-1') {
	return {
		type: 'action',
		action: {
			actionId,
			deviceId,
			tool: 'console',
			command: 'clear',
			payload: {},
		},
	};
}

/** The diagnostics array the client hands to every snapshot capture. */
function clientDiagnosticMessages(): string[] {
	const diagnostics = mockCaptureDesktopTools.mock.calls[0]?.[0] ?? [];
	return diagnostics.map((diagnostic) => diagnostic.message);
}

async function flushPromises(): Promise<void> {
	for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

/** Advances fake time until the client opens its next socket. */
async function reconnectDelayMs(): Promise<number> {
	const before = FakeWebSocket.instances.length;
	const start = Date.now();
	while (
		FakeWebSocket.instances.length === before &&
		Date.now() - start < 60_000
	) {
		await jest.advanceTimersByTimeAsync(100);
	}
	return Date.now() - start;
}

describe('desktop devtools broker discovery', () => {
	it('requires encryption and authentication for explicit remote endpoints', () => {
		expect(
			desktopBrokerCandidates({
				explicitUrl: 'ws://192.0.2.20:49000',
				hostUri: '10.0.0.3:8081',
				platform: 'android',
			}),
		).toEqual([]);
		expect(
			desktopBrokerCandidates({
				explicitUrl: 'ws://192.0.2.20:49000?token=pairing-secret-123',
			}),
		).toEqual([]);
		expect(
			desktopBrokerCandidates({
				explicitUrl: 'wss://192.0.2.20:49000',
			}),
		).toEqual([]);
		expect(
			desktopBrokerCandidates({
				explicitUrl: 'ws://10.0.2.2:49000',
			}),
		).toEqual([]);
	});

	it('rejects an explicit URL that is not a WebSocket transport', () => {
		expect(
			desktopBrokerCandidates({
				explicitUrl: 'https://192.0.2.20:49000/device',
			}),
		).toEqual([]);
		expect(
			desktopBrokerCandidates({
				explicitUrl: 'ws://user:password@192.0.2.20:49000/device',
			}),
		).toEqual([]);
		expect(
			desktopBrokerCandidates({
				explicitUrl: 'ws://192.0.2.20:49000/device#fragment',
			}),
		).toEqual([]);
		expect(
			desktopBrokerCandidates({
				explicitUrl: 'ws://192.0.2.20:49000/other',
			}),
		).toEqual([]);
		expect(
			desktopBrokerCandidates({
				explicitUrl: 'ws://192.0.2.20:49000/device?password=private',
			}),
		).toEqual([]);
		expect(
			desktopBrokerCandidates({
				explicitUrl: `ws://localhost:49000/device?token=${'x'.repeat(513)}`,
			}),
		).toEqual([]);
	});

	it('omits the Android host alias on a physical device', () => {
		expect(
			desktopBrokerCandidates({
				hostUri: '192.168.1.20:8081',
				platform: 'android',
				isEmulator: false,
				port: 47932,
				portAttempts: 1,
			}),
		).toEqual(['ws://127.0.0.1:47932/device', 'ws://localhost:47932/device']);
	});

	it('keeps automatic discovery on local and emulator-safe addresses', () => {
		expect(
			desktopBrokerCandidates({
				hostUri: '192.168.1.20:8081',
				platform: 'android',
				isEmulator: true,
				port: 47932,
				portAttempts: 1,
			}),
		).toEqual([
			'ws://10.0.2.2:47932/device',
			'ws://127.0.0.1:47932/device',
			'ws://localhost:47932/device',
		]);

		expect(
			desktopBrokerCandidates({
				hostUri: 'localhost:8081',
				platform: 'ios',
				portAttempts: 1,
			}),
		).toEqual(['ws://localhost:47931/device', 'ws://127.0.0.1:47931/device']);
	});

	it('matches the desktop broker port fallback range', () => {
		expect(
			desktopBrokerCandidates({
				hostUri: undefined,
				platform: 'ios',
				port: 47931,
				portAttempts: 2,
			}),
		).toEqual([
			'ws://127.0.0.1:47931/device',
			'ws://localhost:47931/device',
			'ws://127.0.0.1:47932/device',
			'ws://localhost:47932/device',
		]);
	});

	it('preserves a token in an explicit broker URL', () => {
		expect(
			desktopBrokerCandidates({
				explicitUrl: 'wss://192.0.2.20:49000?token=pairing-secret-123',
			}),
		).toEqual(['wss://192.0.2.20:49000/device?token=pairing-secret-123']);
	});
});

describe('DesktopActionAdmissionController', () => {
	it('bounds pending work and accepted actions per time window', () => {
		let now = 1_000;
		const controller = new DesktopActionAdmissionController({
			maxPending: 1,
			maxPerWindow: 2,
			windowMs: 1_000,
			now: () => now,
		});
		const first = controller.admit();
		expect(first.accepted).toBe(true);
		expect(controller.admit()).toEqual({
			accepted: false,
			reason: 'queue-full',
		});
		if (!first.accepted) throw new Error('Expected first action admission.');
		first.release();

		const second = controller.admit();
		expect(second.accepted).toBe(true);
		if (!second.accepted) throw new Error('Expected second action admission.');
		second.release();
		expect(controller.admit()).toEqual({
			accepted: false,
			reason: 'rate-limited',
		});

		now += 1_001;
		expect(controller.admit().accepted).toBe(true);
	});
});

describe('DesktopActionReplayCache', () => {
	const action: DesktopDeviceAction = {
		actionId: 'action-1',
		deviceId: 'device-1',
		tool: 'console',
		command: 'clear',
		payload: {},
	};

	it('replays matching results and rejects reused identifiers', () => {
		const cache = new DesktopActionReplayCache();
		const result = {
			type: 'action-result' as const,
			actionId: 'action-1',
			ok: true,
		};

		expect(cache.lookup(action)).toEqual({ kind: 'new' });
		cache.remember(action, result);
		expect(cache.lookup(action)).toEqual({ kind: 'replay', result });
		expect(cache.lookup({ ...action, tool: 'network' })).toEqual({
			kind: 'conflict',
		});
	});

	it('tells a replay from a conflict by fingerprint for large payloads', () => {
		const cache = new DesktopActionReplayCache();
		const fixture = (dataBase64: string): DesktopDeviceAction => ({
			actionId: 'fixture-1',
			deviceId: 'device-1',
			tool: 'camera',
			command: 'setFixture',
			payload: { kind: 'qr', dataBase64 },
		});
		const large = 'A'.repeat(64 * 1024);
		const result = {
			type: 'action-result' as const,
			actionId: 'fixture-1',
			ok: true,
		};

		cache.remember(fixture(large), result);

		expect(cache.lookup(fixture(large))).toEqual({ kind: 'replay', result });
		expect(cache.lookup(fixture(`${large.slice(0, -1)}B`))).toEqual({
			kind: 'conflict',
		});
		expect(cache.lookup(fixture(`${large}A`))).toEqual({ kind: 'conflict' });
	});

	it('bounds retained results and validates its limit', () => {
		const cache = new DesktopActionReplayCache(1);
		cache.remember(action, {
			type: 'action-result',
			actionId: action.actionId,
			ok: true,
		});
		const next = { ...action, actionId: 'action-2' };
		cache.remember(next, {
			type: 'action-result',
			actionId: next.actionId,
			ok: false,
		});

		expect(cache.lookup(action)).toEqual({ kind: 'new' });
		expect(() => new DesktopActionReplayCache(0)).toThrow('positive integer');
	});
});

describe('desktop client', () => {
	const runtime = globalThis as typeof globalThis & {
		WebSocket: typeof WebSocket;
	};
	const originalWebSocket = runtime.WebSocket;

	beforeEach(() => {
		FakeWebSocket.instances = [];
		runtime.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
		mockRunDesktopAction.mockReset();
		mockCaptureDesktopTools.mockReset();
		mockCaptureDesktopTools.mockReturnValue({} as never);
	});

	afterEach(() => {
		disableDevtoolsAuthorization();
		runtime.WebSocket = originalWebSocket;
		jest.useRealTimers();
	});

	it('rechecks the authorized owner before queued actions execute', async () => {
		let finishFirstAction: (() => void) | undefined;
		mockRunDesktopAction.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finishFirstAction = resolve;
				}),
		);
		setDevtoolsAuthorization({ enabled: true, ownerId: 'owner-a' });
		const client = startDesktopClient({
			host: testHost,
			candidates: [BROKER_URL],
		});

		try {
			const socket = latestSocket();
			socket.open();
			socket.receive(consoleClear('first'));
			await flushPromises();
			expect(mockRunDesktopAction).toHaveBeenCalledTimes(1);

			socket.receive(consoleClear('second'));
			setDevtoolsAuthorization({ enabled: true, ownerId: 'owner-b' });
			finishFirstAction?.();
			await flushPromises();

			expect(mockRunDesktopAction).toHaveBeenCalledTimes(1);
			expect(actionResults(socket)).toContainEqual(
				expect.objectContaining({
					actionId: 'second',
					ok: false,
					error: expect.stringContaining('authorization changed'),
				}),
			);
		} finally {
			client.stop();
		}
	});

	it.each([
		// Over in UTF-16 code units, so the client never counts its bytes.
		['in UTF-16 code units', 'x'.repeat(MAX_SNAPSHOT_BYTES), false],
		// Two bytes per character: within the budget in code units, over in bytes.
		['in UTF-8 bytes alone', 'é'.repeat(MAX_SNAPSHOT_BYTES / 2), true],
	])(
		'refuses to send a snapshot over the aggregate wire budget %s',
		(_case, message, counted) => {
			mockCaptureDesktopTools.mockReturnValueOnce({
				diagnostics: [{ message }],
			} as never);
			const client = startDesktopClient({
				host: testHost,
				candidates: [BROKER_URL],
			});

			try {
				const socket = latestSocket();
				mockUtf8ByteLength.mockClear();
				socket.open();
				expect(sentMessages(socket).map((sent) => sent.type)).toEqual([
					'hello',
				]);
				expect(clientDiagnosticMessages()).toContain(
					'Desktop snapshot exceeded the 8 MiB wire budget and was not sent.',
				);
				expect(
					mockUtf8ByteLength.mock.calls.some(([text]) =>
						text.startsWith('{"type":"snapshot"'),
					),
				).toBe(counted);
			} finally {
				client.stop();
			}
		},
	);

	it.each([
		// Over in UTF-16 code units, so the client never counts its bytes.
		['in UTF-16 code units', 'x'.repeat(MAX_INCOMING_BYTES + 1), false],
		// Two bytes per character: within the limit in code units, over in bytes.
		['in UTF-8 bytes alone', 'é'.repeat(MAX_INCOMING_BYTES / 2 + 1), true],
	])(
		'closes on an incoming frame over the size limit %s',
		(_case, frame, counted) => {
			const client = startDesktopClient({
				host: testHost,
				candidates: [BROKER_URL],
			});

			try {
				const socket = latestSocket();
				socket.open();
				mockUtf8ByteLength.mockClear();
				socket.receiveFrame(frame);

				expect(socket.close).toHaveBeenCalledWith(
					1009,
					'desktop action too large',
				);
				expect(clientDiagnosticMessages()).toContain(
					'Rejected an oversized desktop action.',
				);
				expect(
					mockUtf8ByteLength.mock.calls.some(([text]) => text === frame),
				).toBe(counted);
			} finally {
				client.stop();
			}
		},
	);

	it.each([
		['one-byte', 'x'.repeat(MAX_INCOMING_BYTES)],
		['two-byte', 'é'.repeat(MAX_INCOMING_BYTES / 2)],
	])(
		'reads an incoming frame of %s characters exactly at the size limit',
		(_case, frame) => {
			const client = startDesktopClient({
				host: testHost,
				candidates: [BROKER_URL],
			});

			try {
				const socket = latestSocket();
				socket.open();
				socket.receiveFrame(frame);

				expect(socket.close).not.toHaveBeenCalled();
				expect(clientDiagnosticMessages()).toContain(
					'Ignored malformed desktop action JSON.',
				);
			} finally {
				client.stop();
			}
		},
	);

	it.each([
		[
			'a capability the device does not advertise',
			{ deviceId: 'device-1', tool: 'network', command: 'clear' },
			'Device does not advertise network.clear.',
			'desktop action not advertised',
		],
		[
			'another device',
			{ deviceId: 'device-2', tool: 'console', command: 'clear' },
			'Desktop action targets a different device.',
			'desktop action for another device',
		],
	])(
		'refuses an action for %s without running it',
		async (_case, target, error, closeReason) => {
			setDevtoolsAuthorization({ enabled: true, ownerId: 'owner-a' });
			const client = startDesktopClient({
				host: testHost,
				candidates: [BROKER_URL],
			});

			try {
				const socket = latestSocket();
				socket.open();
				socket.receive({
					type: 'action',
					action: { actionId: 'forged', payload: {}, ...target },
				});
				await flushPromises();

				expect(mockRunDesktopAction).not.toHaveBeenCalled();
				expect(actionResults(socket)).toEqual([
					{ type: 'action-result', actionId: 'forged', ok: false, error },
				]);
				expect(socket.close).toHaveBeenCalledWith(1008, closeReason);
			} finally {
				client.stop();
			}
		},
	);

	it('times out a host action that never settles and serves the next one', async () => {
		jest.useFakeTimers();
		let hungSignal: AbortSignal | undefined;
		mockRunDesktopAction
			.mockImplementationOnce((_action, { signal }) => {
				hungSignal = signal;
				return new Promise<void>(() => undefined);
			})
			.mockResolvedValueOnce(undefined);
		setDevtoolsAuthorization({ enabled: true, ownerId: 'owner-a' });
		const client = startDesktopClient({
			host: testHost,
			candidates: [BROKER_URL],
			actionTimeoutMs: 1_000,
		});

		try {
			const socket = latestSocket();
			socket.open();
			socket.receive(consoleClear('hung'));
			socket.receive(consoleClear('next'));
			await jest.advanceTimersByTimeAsync(999);
			expect(actionResults(socket)).toEqual([]);
			expect(hungSignal?.aborted).toBe(false);

			await jest.advanceTimersByTimeAsync(2_000);

			expect(hungSignal?.aborted).toBe(true);
			expect(mockRunDesktopAction).toHaveBeenCalledTimes(2);
			expect(actionResults(socket)).toEqual([
				{
					type: 'action-result',
					actionId: 'hung',
					ok: false,
					error:
						'Desktop action timed out after 1000 ms; its outcome is unknown.',
				},
				{ type: 'action-result', actionId: 'next', ok: true },
			]);
		} finally {
			client.stop();
		}
	});

	it.each(['stop', 'disconnect'] as const)(
		'aborts an active host action and clears its deadline on %s',
		async (reason) => {
			jest.useFakeTimers();
			let signal: AbortSignal | undefined;
			mockRunDesktopAction.mockImplementationOnce((_action, context) => {
				signal = context.signal;
				return new Promise<void>(() => undefined);
			});
			setDevtoolsAuthorization({ enabled: true, ownerId: 'owner-a' });
			const client = startDesktopClient({
				host: testHost,
				candidates: [BROKER_URL],
			});
			const socket = latestSocket();
			socket.open();
			socket.receive(consoleClear('pending-prompt'));
			await flushPromises();
			expect(signal?.aborted).toBe(false);

			if (reason === 'disconnect') socket.serverClose(1000, 'Broker closed');
			else client.stop();
			await flushPromises();

			expect(signal?.aborted).toBe(true);
			expect(jest.getTimerCount()).toBe(reason === 'disconnect' ? 1 : 0);
			expect(actionResults(socket)).toEqual([]);
			client.stop();
			expect(jest.getTimerCount()).toBe(0);
		},
	);

	it('rejects an action timeout a timer cannot represent', () => {
		let client: DesktopClientHandle | undefined;
		try {
			expect(() => {
				client = startDesktopClient({
					host: testHost,
					candidates: [BROKER_URL],
					actionTimeoutMs: 0,
				});
			}).toThrow('actionTimeoutMs');
			expect(FakeWebSocket.instances).toEqual([]);
		} finally {
			client?.stop();
		}
	});

	it('paces a burst of quick actions under the broker frame limit without dropping a result', async () => {
		jest.useFakeTimers();
		mockRunDesktopAction.mockResolvedValue(undefined);
		setDevtoolsAuthorization({ enabled: true, ownerId: 'owner-a' });
		const client = startDesktopClient({
			host: testHost,
			candidates: [BROKER_URL],
		});

		try {
			const socket = latestSocket();
			const sentAt: number[] = [];
			socket.send.mockImplementation(() => {
				sentAt.push(Date.now());
			});
			socket.open();
			const actionIds = Array.from(
				{ length: 6 },
				(_, index) => `burst-${index}`,
			);
			for (const actionId of actionIds) socket.receive(consoleClear(actionId));
			await jest.advanceTimersByTimeAsync(10_000);

			expect(socket.close).not.toHaveBeenCalled();
			expect(actionResults(socket)).toEqual(
				actionIds.map((actionId) => ({
					type: 'action-result',
					actionId,
					ok: true,
				})),
			);
			// The broker closes a device socket once one second holds 9 frames.
			const busiestSecond = Math.max(
				...sentAt.map(
					(start) =>
						sentAt.filter((at) => at >= start && at < start + 1_000).length,
				),
			);
			expect(busiestSecond).toBeLessThanOrEqual(8);
		} finally {
			client.stop();
		}
	});

	it('trims collections to the desktop row limits, keeping the newest rows', async () => {
		jest.useFakeTimers();
		const limit = RNDEVTOOLS_SNAPSHOT_LIMITS.network;
		mockCaptureDesktopTools.mockReturnValue({
			network: Array.from({ length: limit + 1 }, (_, index) => ({
				id: `request-${index}`,
			})),
		} as never);
		const client = startDesktopClient({
			host: testHost,
			candidates: [BROKER_URL],
		});

		try {
			const socket = latestSocket();
			socket.open();
			await jest.advanceTimersByTimeAsync(3_000);

			const snapshots = sentMessages(socket).filter(
				(message) => message.type === 'snapshot',
			);
			expect(snapshots.length).toBeGreaterThan(1);
			const [first] = snapshots;
			if (!first) throw new Error('Expected a snapshot.');
			const { network } = first.tools as { network: { id: string }[] };
			expect(network).toHaveLength(limit);
			expect(network[0]).toEqual({ id: 'request-1' });
			expect(network.at(-1)).toEqual({ id: `request-${limit}` });
			expect(
				clientDiagnosticMessages().filter((message) =>
					message.startsWith('Trimmed network to 2000 rows'),
				),
			).toHaveLength(1);
		} finally {
			client.stop();
		}
	});

	it('backs off after consecutive broker rejections and reports why', async () => {
		jest.useFakeTimers();
		const client = startDesktopClient({
			host: testHost,
			candidates: [BROKER_URL],
		});

		try {
			const delays: number[] = [];
			for (let attempt = 0; attempt < 4; attempt += 1) {
				const socket = latestSocket();
				socket.open();
				socket.serverClose(1008, 'invalid protocol message');
				delays.push(await reconnectDelayMs());
			}
			expect(delays).toEqual([2_500, 5_000, 10_000, 20_000]);
			expect(clientDiagnosticMessages()).toContain(
				`Disconnected from ${BROKER_URL} (1008: invalid protocol message); retrying in 20 s.`,
			);

			// A connection that stayed up long enough proves the device recovered.
			const healthy = latestSocket();
			healthy.open();
			await jest.advanceTimersByTimeAsync(10_000);
			healthy.serverClose(1008, 'device message rate limit exceeded');
			expect(await reconnectDelayMs()).toBe(2_500);
		} finally {
			client.stop();
		}
	});

	it('does not back off after closing a connection itself', async () => {
		jest.useFakeTimers();
		const client = startDesktopClient({
			host: testHost,
			candidates: [BROKER_URL],
		});

		try {
			const delays: number[] = [];
			for (let attempt = 0; attempt < 3; attempt += 1) {
				const socket = latestSocket();
				socket.open();
				// Unauthorized, so the client refuses and closes with 1008 itself.
				socket.receive(consoleClear(`unauthorized-${attempt}`));
				expect(socket.close).toHaveBeenCalledWith(
					1008,
					'internal tools authorization required',
				);
				delays.push(await reconnectDelayMs());
			}
			expect(delays).toEqual([2_500, 2_500, 2_500]);
		} finally {
			client.stop();
		}
	});
});

describe('desktop entry point', () => {
	it('gives a headless host its helpers without the plugins barrel', () => {
		expect(
			simulatorUdidFromPath(
				'/Users/dev/Library/Developer/CoreSimulator/Devices/0A1B2C3D-4E5F-6789-ABCD-EF0123456789/data/Documents',
			),
		).toBe('0A1B2C3D-4E5F-6789-ABCD-EF0123456789');
		expect(
			limitDesktopProjection([1, 2, 3], {
				maxItems: 2,
				maxBytes: 1_024,
				keepNewest: true,
			}),
		).toEqual({ items: [2, 3], omitted: 1 });
	});
});

describe('desktop client activation', () => {
	const originalNodeEnv = process.env.NODE_ENV;
	const originalDisabled = process.env.EXPO_PUBLIC_DESKTOP_DEVTOOLS_DISABLED;

	afterEach(() => {
		process.env.NODE_ENV = originalNodeEnv;
		process.env.EXPO_PUBLIC_DESKTOP_DEVTOOLS_DISABLED = originalDisabled;
	});

	it('never dials a broker from a preview build', () => {
		// Internal tools are enabled for preview too, but a tester's device has no
		// broker and no hostUri, so discovery would sweep loopback forever.
		process.env.NODE_ENV = 'development';

		expect(shouldStartDesktopClient({ isDevelopmentBuild: false })).toBe(false);
	});

	it('starts for a development build and honours the kill switch', () => {
		process.env.NODE_ENV = 'development';
		process.env.EXPO_PUBLIC_DESKTOP_DEVTOOLS_DISABLED = undefined;
		expect(shouldStartDesktopClient({ isDevelopmentBuild: true })).toBe(true);

		process.env.EXPO_PUBLIC_DESKTOP_DEVTOOLS_DISABLED = 'true';
		expect(shouldStartDesktopClient({ isDevelopmentBuild: true })).toBe(false);
	});

	it('stays inert under jest so suites never open sockets', () => {
		expect(process.env.NODE_ENV).toBe('test');
		expect(shouldStartDesktopClient({ isDevelopmentBuild: true })).toBe(false);
	});
});

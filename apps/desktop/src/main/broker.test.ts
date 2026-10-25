import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
	createEmptyDeviceTools,
	DESKTOP_PROTOCOL_VERSION,
	type DesktopState,
} from '../shared/protocol';
import { DesktopBroker } from './broker';

const brokers: DesktopBroker[] = [];

afterEach(async () => {
	await Promise.all(brokers.splice(0).map((broker) => broker.stop()));
});

function waitForState(
	broker: DesktopBroker,
	predicate: (state: DesktopState) => boolean,
	timeoutMs = 3_000
): Promise<DesktopState> {
	const initial = broker.getState();
	if (predicate(initial)) return Promise.resolve(initial);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			unsubscribe();
			reject(new Error('Timed out waiting for broker state.'));
		}, timeoutMs);
		const unsubscribe = broker.subscribe((state) => {
			if (!predicate(state)) return;
			clearTimeout(timer);
			unsubscribe();
			resolve(state);
		});
	});
}

function openSocket(url: string, origin?: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url, origin ? { origin } : undefined);
		socket.once('open', () => resolve(socket));
		socket.once('error', reject);
	});
}

function nextSocketMessage(
	socket: WebSocket
): Promise<Record<string, unknown>> {
	return new Promise((resolve) => {
		socket.once('message', (raw) => {
			resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
		});
	});
}

describe('DesktopBroker', () => {
	it('starts without a simulated device unless demo mode is explicit', () => {
		expect(new DesktopBroker().getState().devices).toEqual([]);
		expect(
			new DesktopBroker({ includeDemoDevice: true }).getState().devices[0]
				?.status
		).toBe('simulated');
	});

	it('deduplicates concurrent starts and reports invalid bind hosts safely', async () => {
		const invalid = new DesktopBroker({ host: 'bad/host' });
		brokers.push(invalid);
		expect(invalid.getState().broker.urls).toEqual([]);
		await invalid.start();
		expect(invalid.getState().broker).toMatchObject({
			status: 'error',
			error: expect.stringContaining('valid host'),
		});

		const broker = new DesktopBroker({
			port: 40_000 + Math.floor(Math.random() * 20_000),
		});
		brokers.push(broker);
		const firstStart = broker.start();
		const secondStart = broker.start();
		expect(secondStart).toBe(firstStart);
		await firstStart;
		expect(broker.getState().broker.status).toBe('listening');
	});

	it('registers devices, validates snapshots, and round-trips remote actions', async () => {
		const port = 40_000 + Math.floor(Math.random() * 20_000);
		const broker = new DesktopBroker({ port, includeDemoDevice: false });
		brokers.push(broker);
		await broker.start();
		expect(broker.getState().broker.status).toBe('listening');
		const listeningPort = broker.getState().broker.port;

		const health = await fetch(`http://127.0.0.1:${listeningPort}/health`);
		expect(health.status).toBe(200);
		expect(await health.json()).toMatchObject({
			name: 'RN Devtools',
			protocolVersion: DESKTOP_PROTOCOL_VERSION,
			access: 'loopback',
		});

		const socket = await openSocket(`ws://127.0.0.1:${listeningPort}/device`);
		socket.send(
			JSON.stringify({
				type: 'hello',
				protocolVersion: DESKTOP_PROTOCOL_VERSION,
				device: {
					id: 'test-device',
					name: 'Test iPhone',
					platform: 'ios',
					capabilities: ['console.clear'],
				},
			})
		);
		await waitForState(broker, (state) =>
			state.devices.some((device) => device.info.id === 'test-device')
		);

		socket.send(
			JSON.stringify({
				type: 'snapshot',
				sequence: 1,
				sentAt: Date.now(),
				tools: {
					...createEmptyDeviceTools(),
					console: [
						{
							id: 'log-1',
							at: Date.now(),
							level: 'info',
							message: 'Connected from test',
						},
					],
				},
			})
		);
		const snapshotState = await waitForState(
			broker,
			(state) => state.devices[0]?.sequence === 1
		);
		expect(snapshotState.devices[0]?.tools.console[0]?.message).toBe(
			'Connected from test'
		);

		socket.once('message', (raw) => {
			const envelope = JSON.parse(raw.toString()) as {
				type: string;
				action: { actionId: string };
			};
			expect(envelope.type).toBe('action');
			socket.send(
				JSON.stringify({
					type: 'action-result',
					actionId: envelope.action.actionId,
					ok: true,
				})
			);
		});
		await expect(
			broker.dispatchAction({
				actionId: 'action-1',
				deviceId: 'test-device',
				tool: 'console',
				command: 'clear',
				payload: {},
			})
		).resolves.toEqual({ actionId: 'action-1', ok: true });
		await expect(
			broker.dispatchAction({
				actionId: 'unsupported-action',
				deviceId: 'test-device',
				tool: 'query',
				command: 'refetch',
				payload: { id: 'query-1' },
			})
		).resolves.toMatchObject({
			ok: false,
			error: 'Device does not advertise query.refetch.',
		});

		socket.close(1000, 'test complete');
		await waitForState(
			broker,
			(state) => state.devices[0]?.status === 'offline'
		);
	});

	it('rejects clients that do not send hello first', async () => {
		const port = 40_000 + Math.floor(Math.random() * 20_000);
		const broker = new DesktopBroker({ port, includeDemoDevice: false });
		brokers.push(broker);
		await broker.start();
		const socket = await openSocket(
			`ws://127.0.0.1:${broker.getState().broker.port}/device`
		);
		const closed = new Promise<number>((resolve) => {
			socket.once('close', (code) => resolve(code));
		});
		socket.send(
			JSON.stringify({
				type: 'heartbeat',
				sentAt: Date.now(),
			})
		);
		await expect(closed).resolves.toBe(1008);
		expect(broker.getState().devices).toHaveLength(0);
	});

	it('keeps the session registry within the desktop wire limit', async () => {
		const broker = new DesktopBroker({
			port: 40_000 + Math.floor(Math.random() * 20_000),
			includeDemoDevice: false,
		});
		brokers.push(broker);
		await broker.start();
		const url = `ws://127.0.0.1:${broker.getState().broker.port}/device`;
		const sockets = await Promise.all(
			Array.from({ length: 51 }, () => openSocket(url))
		);
		for (const [index, socket] of sockets.entries()) {
			socket.send(
				JSON.stringify({
					type: 'hello',
					protocolVersion: DESKTOP_PROTOCOL_VERSION,
					device: {
						id: `bounded-device-${index}`,
						name: `Bounded device ${index}`,
						platform: 'ios',
						capabilities: [],
					},
				})
			);
		}

		await waitForState(broker, (state) => state.devices.length === 50);
		expect(broker.getState().devices).toHaveLength(50);
		for (const socket of sockets) socket.close(1000, 'test complete');
	});

	it('bounds open sockets before clients complete the hello handshake', async () => {
		const broker = new DesktopBroker({
			port: 40_000 + Math.floor(Math.random() * 20_000),
			includeDemoDevice: false,
			limits: { maxOpenConnections: 2 },
		});
		brokers.push(broker);
		await broker.start();
		const url = `ws://127.0.0.1:${broker.getState().broker.port}/device`;
		const first = await openSocket(url);
		const second = await openSocket(url);

		await expect(openSocket(url)).rejects.toThrow();

		first.close(1000, 'test complete');
		second.close(1000, 'test complete');
	});

	it('closes clients that exceed the pre-parse message rate limit', async () => {
		const broker = new DesktopBroker({
			port: 40_000 + Math.floor(Math.random() * 20_000),
			includeDemoDevice: false,
			limits: { maxMessagesPerRateWindow: 2 },
		});
		brokers.push(broker);
		await broker.start();
		const socket = await openSocket(
			`ws://127.0.0.1:${broker.getState().broker.port}/device`
		);
		const closed = new Promise<number>((resolve) => {
			socket.once('close', (code) => resolve(code));
		});
		socket.send(
			JSON.stringify({
				type: 'hello',
				protocolVersion: DESKTOP_PROTOCOL_VERSION,
				device: {
					id: 'rate-limited-device',
					name: 'Rate limited device',
					platform: 'ios',
					capabilities: [],
				},
			})
		);
		await waitForState(
			broker,
			(state) => state.devices[0]?.status === 'online'
		);
		for (let index = 0; index < 2; index += 1) {
			socket.send(JSON.stringify({ type: 'heartbeat', sentAt: Date.now() }));
		}

		await expect(closed).resolves.toBe(1008);
		expect(
			broker
				.getState()
				.diagnostics.some((entry) =>
					entry.message.includes('message rate limit')
				)
		).toBe(true);
	});

	it('enforces the cumulative byte budget before parsing device messages', async () => {
		const broker = new DesktopBroker({
			port: 40_000 + Math.floor(Math.random() * 20_000),
			includeDemoDevice: false,
			limits: { maxMessageBytesPerRateWindow: 64 },
		});
		brokers.push(broker);
		await broker.start();
		const socket = await openSocket(
			`ws://127.0.0.1:${broker.getState().broker.port}/device`
		);
		const closed = new Promise<number>((resolve) => {
			socket.once('close', (code) => resolve(code));
		});
		socket.send(
			JSON.stringify({
				type: 'hello',
				protocolVersion: DESKTOP_PROTOCOL_VERSION,
				device: {
					id: 'byte-limited-device',
					name: 'Byte limited device',
					platform: 'ios',
					capabilities: [],
				},
			})
		);

		await expect(closed).resolves.toBe(1008);
		expect(broker.getState().devices).toHaveLength(0);
	});

	it('evicts offline snapshots before rejecting an over-budget online snapshot', async () => {
		const snapshot = JSON.stringify({
			type: 'snapshot',
			sequence: 1,
			sentAt: Date.now(),
			tools: {
				...createEmptyDeviceTools(),
				console: [
					{
						id: 'budget-entry',
						at: Date.now(),
						level: 'info',
						message: 'x'.repeat(1_024),
					},
				],
			},
		});
		const broker = new DesktopBroker({
			port: 40_000 + Math.floor(Math.random() * 20_000),
			includeDemoDevice: false,
			limits: {
				maxRetainedSnapshotWireBytes: Buffer.byteLength(snapshot, 'utf8') + 32,
			},
		});
		brokers.push(broker);
		await broker.start();
		const url = `ws://127.0.0.1:${broker.getState().broker.port}/device`;
		const connect = async (id: string) => {
			const socket = await openSocket(url);
			socket.send(
				JSON.stringify({
					type: 'hello',
					protocolVersion: DESKTOP_PROTOCOL_VERSION,
					device: { id, name: id, platform: 'ios', capabilities: [] },
				})
			);
			await waitForState(broker, (state) =>
				state.devices.some(
					(device) => device.info.id === id && device.status === 'online'
				)
			);
			return socket;
		};

		const first = await connect('budget-first');
		first.send(snapshot);
		await waitForState(
			broker,
			(state) =>
				state.devices.find((device) => device.info.id === 'budget-first')
					?.sequence === 1
		);
		first.close(1000, 'make snapshot evictable');
		await waitForState(
			broker,
			(state) =>
				state.devices.find((device) => device.info.id === 'budget-first')
					?.status === 'offline'
		);

		const second = await connect('budget-second');
		second.send(snapshot);
		await waitForState(
			broker,
			(state) =>
				!state.devices.some((device) => device.info.id === 'budget-first') &&
				state.devices.find((device) => device.info.id === 'budget-second')
					?.sequence === 1
		);

		const third = await connect('budget-third');
		const thirdClosed = new Promise<number>((resolve) => {
			third.once('close', (code) => resolve(code));
		});
		third.send(snapshot);
		await expect(thirdClosed).resolves.toBe(1009);
		expect(
			broker
				.getState()
				.diagnostics.some((entry) => entry.message.includes('snapshot budget'))
		).toBe(true);
		expect(
			broker
				.getState()
				.devices.find((device) => device.info.id === 'budget-second')?.sequence
		).toBe(1);

		second.close(1000, 'test complete');
	});

	it('coalesces bursty device state broadcasts', async () => {
		const broker = new DesktopBroker({
			port: 40_000 + Math.floor(Math.random() * 20_000),
			includeDemoDevice: false,
		});
		brokers.push(broker);
		await broker.start();
		const socket = await openSocket(
			`ws://127.0.0.1:${broker.getState().broker.port}/device`
		);
		socket.send(
			JSON.stringify({
				type: 'hello',
				protocolVersion: DESKTOP_PROTOCOL_VERSION,
				device: {
					id: 'coalesced-device',
					name: 'Coalesced device',
					platform: 'ios',
					capabilities: [],
				},
			})
		);
		await waitForState(
			broker,
			(state) => state.devices[0]?.status === 'online'
		);
		let emissionCount = 0;
		const unsubscribe = broker.subscribe(() => {
			emissionCount += 1;
		});
		for (let index = 0; index < 5; index += 1) {
			socket.send(
				JSON.stringify({ type: 'heartbeat', sentAt: Date.now() - index - 1 })
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(emissionCount).toBe(1);
		unsubscribe();
		socket.close(1000, 'test complete');
	});

	it('caps retained broker diagnostics', async () => {
		const broker = new DesktopBroker({
			port: 40_000 + Math.floor(Math.random() * 20_000),
			includeDemoDevice: false,
			limits: { maxDiagnostics: 3 },
		});
		brokers.push(broker);
		await broker.start();
		const url = `ws://127.0.0.1:${broker.getState().broker.port}/device`;
		for (const id of ['diagnostic-first', 'diagnostic-second']) {
			const socket = await openSocket(url);
			socket.send(
				JSON.stringify({
					type: 'hello',
					protocolVersion: DESKTOP_PROTOCOL_VERSION,
					device: { id, name: id, platform: 'ios', capabilities: [] },
				})
			);
			await waitForState(broker, (state) =>
				state.devices.some(
					(device) => device.info.id === id && device.status === 'online'
				)
			);
			socket.close(1000, 'diagnostic cap test');
			await waitForState(broker, (state) =>
				state.devices.some(
					(device) => device.info.id === id && device.status === 'offline'
				)
			);
		}

		expect(broker.getState().diagnostics).toHaveLength(3);
		expect(
			broker
				.getState()
				.diagnostics.some((entry) => entry.message.startsWith('Listening on'))
		).toBe(false);
	});

	it('bounds diagnostic messages by UTF-8 bytes without splitting Unicode', async () => {
		const broker = new DesktopBroker({
			port: 40_000 + Math.floor(Math.random() * 20_000),
			includeDemoDevice: false,
		});
		brokers.push(broker);
		await broker.start();
		const socket = await openSocket(
			`ws://127.0.0.1:${broker.getState().broker.port}/device`
		);
		socket.send(
			JSON.stringify({
				type: 'hello',
				protocolVersion: DESKTOP_PROTOCOL_VERSION,
				device: {
					id: 'unicode-diagnostic-device',
					name: '🏋️'.repeat(1_300),
					platform: 'ios',
					capabilities: [],
				},
			})
		);
		const state = await waitForState(broker, (next) =>
			next.devices.some(
				(device) => device.info.id === 'unicode-diagnostic-device'
			)
		);
		const diagnostic = state.diagnostics.find(
			(entry) => entry.scope === 'connection'
		);

		expect(
			Buffer.byteLength(diagnostic?.message ?? '', 'utf8')
		).toBeLessThanOrEqual(8 * 1024);
		expect(diagnostic?.message).toMatch(/…$/u);
		expect(diagnostic?.message).not.toContain('\uFFFD');
		socket.close(1000, 'test complete');
	});

	it('binds pending actions to one device and rejects duplicate identifiers', async () => {
		const port = 40_000 + Math.floor(Math.random() * 20_000);
		const broker = new DesktopBroker({ port, includeDemoDevice: false });
		brokers.push(broker);
		await broker.start();
		const url = `ws://127.0.0.1:${broker.getState().broker.port}/device`;
		const first = await openSocket(url);
		const second = await openSocket(url);
		for (const [socket, id] of [
			[first, 'first-device'],
			[second, 'second-device'],
		] as const) {
			socket.send(
				JSON.stringify({
					type: 'hello',
					protocolVersion: DESKTOP_PROTOCOL_VERSION,
					device: {
						id,
						name: id,
						platform: 'ios',
						capabilities: ['console.clear'],
					},
				})
			);
		}
		await waitForState(broker, (state) => state.devices.length === 2);

		const firstEnvelope = nextSocketMessage(first);
		const action = broker.dispatchAction({
			actionId: 'shared-action-id',
			deviceId: 'first-device',
			tool: 'console',
			command: 'clear',
			payload: {},
		});
		await expect(firstEnvelope).resolves.toMatchObject({
			type: 'action',
			action: { actionId: 'shared-action-id', deviceId: 'first-device' },
		});

		second.send(
			JSON.stringify({
				type: 'action-result',
				actionId: 'shared-action-id',
				ok: true,
			})
		);
		await expect(
			broker.dispatchAction({
				actionId: 'shared-action-id',
				deviceId: 'second-device',
				tool: 'console',
				command: 'clear',
				payload: {},
			})
		).resolves.toMatchObject({
			ok: false,
			error: 'An action with this identifier is already pending.',
		});
		await expect(
			Promise.race([
				action.then(() => 'settled'),
				new Promise((resolve) => setTimeout(() => resolve('pending'), 40)),
			])
		).resolves.toBe('pending');
		await expect(
			broker.dispatchAction({
				actionId: 'second-first-device-action',
				deviceId: 'first-device',
				tool: 'console',
				command: 'clear',
				payload: {},
			})
		).resolves.toMatchObject({
			ok: false,
			error: 'Another action is already pending for this device.',
		});

		first.send(
			JSON.stringify({
				type: 'action-result',
				actionId: 'shared-action-id',
				ok: true,
			})
		);
		await expect(action).resolves.toEqual({
			actionId: 'shared-action-id',
			ok: true,
		});

		const disconnectEnvelope = nextSocketMessage(first);
		const interrupted = broker.dispatchAction({
			actionId: 'disconnect-action',
			deviceId: 'first-device',
			tool: 'console',
			command: 'clear',
			payload: {},
		});
		await disconnectEnvelope;
		first.close(1000, 'disconnect test');
		await expect(interrupted).resolves.toEqual({
			actionId: 'disconnect-action',
			ok: false,
			error: 'Device disconnected before acknowledging the action.',
		});
		second.close(1000, 'test complete');
	});

	it('requires explicit opt-in and a token for wildcard LAN mode', async () => {
		const deniedWildcard = new DesktopBroker({
			host: '0.0.0.0',
			port: 40_000 + Math.floor(Math.random() * 20_000),
			includeDemoDevice: false,
			token: 'a-development-token',
		});
		brokers.push(deniedWildcard);
		await deniedWildcard.start();
		expect(deniedWildcard.getState().broker).toMatchObject({
			status: 'error',
			error: expect.stringContaining('RNDEVTOOLS_ALLOW_WILDCARD'),
		});

		const missingToken = new DesktopBroker({
			host: '0:0:0:0:0:0:0:0',
			port: 40_000 + Math.floor(Math.random() * 20_000),
			includeDemoDevice: false,
			allowWildcardBind: true,
		});
		brokers.push(missingToken);
		await missingToken.start();
		expect(missingToken.getState().broker).toMatchObject({
			status: 'error',
			error: expect.stringContaining('RNDEVTOOLS_TOKEN'),
		});

		const port = 40_000 + Math.floor(Math.random() * 20_000);
		const broker = new DesktopBroker({
			host: '0.0.0.0',
			port,
			token: 'a-development-token',
			allowWildcardBind: true,
			includeDemoDevice: false,
		});
		brokers.push(broker);
		await broker.start();
		const listeningPort = broker.getState().broker.port;
		const unauthenticatedHealth = await fetch(
			`http://127.0.0.1:${listeningPort}/health`
		);
		expect(unauthenticatedHealth.status).toBe(401);
		const authenticatedHealth = await fetch(
			`http://127.0.0.1:${listeningPort}/health?token=a-development-token`
		);
		expect(authenticatedHealth.status).toBe(200);
		await expect(
			openSocket(`ws://127.0.0.1:${listeningPort}/device`)
		).rejects.toThrow('Unexpected server response: 401');
		const protectedUrl = broker.getState().broker.urls[0];
		expect(protectedUrl).toContain('token=a-development-token');
		const socket = await openSocket(protectedUrl ?? '');
		expect(
			broker
				.getState()
				.diagnostics.some((entry) =>
					entry.message.includes('a-development-token')
				)
		).toBe(false);
		socket.close(1000, 'authenticated');
	});

	it('rejects cross-site WebSocket origins in unauthenticated loopback mode', async () => {
		const broker = new DesktopBroker({
			port: 40_000 + Math.floor(Math.random() * 20_000),
		});
		brokers.push(broker);
		await broker.start();
		const url = `ws://127.0.0.1:${broker.getState().broker.port}/device`;
		await expect(openSocket(url, 'https://malicious.example')).rejects.toThrow(
			'Unexpected server response: 403'
		);
		const localPreview = await openSocket(url, 'http://localhost:5173');
		localPreview.close(1000, 'local preview accepted');
	});

	it('accepts a fresh sequence when the same app session reconnects', async () => {
		const port = 40_000 + Math.floor(Math.random() * 20_000);
		const broker = new DesktopBroker({ port, includeDemoDevice: false });
		brokers.push(broker);
		await broker.start();
		const url = `ws://127.0.0.1:${broker.getState().broker.port}/device`;
		const hello = {
			type: 'hello',
			protocolVersion: DESKTOP_PROTOCOL_VERSION,
			device: {
				id: 'reconnecting-device',
				name: 'Reconnect test',
				platform: 'ios',
				capabilities: [],
			},
		};
		const first = await openSocket(url);
		first.send(JSON.stringify(hello));
		await waitForState(
			broker,
			(state) => state.devices[0]?.status === 'online'
		);
		first.send(
			JSON.stringify({
				type: 'snapshot',
				sequence: 25,
				sentAt: Date.now(),
				tools: {
					...createEmptyDeviceTools(),
					console: [
						{ id: 'old', at: Date.now(), level: 'info', message: 'old' },
					],
				},
			})
		);
		await waitForState(broker, (state) => state.devices[0]?.sequence === 25);
		first.close(1000, 'reconnect');
		await waitForState(
			broker,
			(state) => state.devices[0]?.status === 'offline'
		);

		const second = await openSocket(url);
		second.send(JSON.stringify(hello));
		await waitForState(
			broker,
			(state) =>
				state.devices[0]?.status === 'online' &&
				state.devices[0]?.sequence === 0
		);
		expect(broker.getState().devices[0]?.tools.console).toEqual([]);
		second.send(
			JSON.stringify({
				type: 'snapshot',
				sequence: 1,
				sentAt: Date.now(),
				tools: {
					...createEmptyDeviceTools(),
					console: [
						{ id: 'new', at: Date.now(), level: 'info', message: 'fresh' },
					],
				},
			})
		);
		const state = await waitForState(
			broker,
			(next) => next.devices[0]?.sequence === 1
		);
		expect(state.devices[0]?.tools.console[0]?.message).toBe('fresh');
		second.close(1000, 'complete');
	});

	it('rejects pending work when a newer socket replaces the device', async () => {
		const port = 40_000 + Math.floor(Math.random() * 20_000);
		const broker = new DesktopBroker({ port, includeDemoDevice: false });
		brokers.push(broker);
		await broker.start();
		const url = `ws://127.0.0.1:${broker.getState().broker.port}/device`;
		const hello = {
			type: 'hello',
			protocolVersion: DESKTOP_PROTOCOL_VERSION,
			device: {
				id: 'replacement-device',
				name: 'Replacement test',
				platform: 'ios',
				capabilities: ['console.clear'],
			},
		};
		const first = await openSocket(url);
		first.send(JSON.stringify(hello));
		await waitForState(
			broker,
			(state) => state.devices[0]?.status === 'online'
		);

		const envelope = nextSocketMessage(first);
		const pending = broker.dispatchAction({
			actionId: 'replacement-action',
			deviceId: 'replacement-device',
			tool: 'console',
			command: 'clear',
			payload: {},
		});
		await envelope;

		const second = await openSocket(url);
		second.send(JSON.stringify(hello));
		await expect(pending).resolves.toEqual({
			actionId: 'replacement-action',
			ok: false,
			error: 'Device reconnected before acknowledging the action.',
		});
		second.close(1000, 'complete');
	});
});

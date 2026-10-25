import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDemoDevice } from '../shared/demo-data';
import { IPC_CHANNELS } from '../shared/ipc';
import {
	DESKTOP_PROTOCOL_VERSION,
	type DesktopState,
	desktopStateSchema,
} from '../shared/protocol';

const electron = vi.hoisted(() => ({
	exposeInMainWorld: vi.fn(),
	invoke: vi.fn(),
	send: vi.fn(),
	on: vi.fn(),
	removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
	contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
	ipcRenderer: {
		invoke: electron.invoke,
		send: electron.send,
		on: electron.on,
		removeListener: electron.removeListener,
	},
}));

type BridgeMethod = (...args: unknown[]) => unknown;
type IpcHandler = (event: unknown, ...args: unknown[]) => void;
type ChannelName = keyof typeof IPC_CHANNELS;

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const channelNames = Object.keys(IPC_CHANNELS) as ChannelName[];
let bridge: Record<string, BridgeMethod> = {};
let exposeCalls = 0;

function channelName(channel: unknown): ChannelName | undefined {
	return channelNames.find((name) => IPC_CHANNELS[name] === channel);
}

function sourceFiles(directory: string): string[] {
	return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(entryPath);
		return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)
			? [entryPath]
			: [];
	});
}

function channelsUsed(source: string, call: string): Set<string> {
	return new Set(
		Array.from(
			source.matchAll(new RegExp(`${call}\\(\\s*IPC_CHANNELS\\.(\\w+)`, 'g')),
			(match) => match[1] ?? ''
		)
	);
}

function subscriptions(): [string, BridgeMethod][] {
	return Object.entries(bridge).filter(([name]) =>
		name.startsWith('subscribe')
	);
}

function subscribeAndCapture(name: string, listener: unknown) {
	electron.on.mockClear();
	const unsubscribe = bridge[name]?.(listener) as () => void;
	expect(electron.on, name).toHaveBeenCalledTimes(1);
	const [channel, handler] = electron.on.mock.calls[0] as [string, IpcHandler];
	return { channel, handler, unsubscribe };
}

function desktopState(): DesktopState {
	return {
		protocolVersion: DESKTOP_PROTOCOL_VERSION,
		broker: {
			status: 'listening',
			host: '127.0.0.1',
			port: 47931,
			access: 'loopback',
			urls: ['ws://127.0.0.1:47931/device'],
		},
		devices: [createDemoDevice(1_800_000_000_000)],
		diagnostics: [],
	};
}

beforeAll(async () => {
	await import('./index');
	exposeCalls = electron.exposeInMainWorld.mock.calls.length;
	const [name, exposed] = electron.exposeInMainWorld.mock.calls[0] ?? [];
	expect(name).toBe('rnDevtools');
	bridge = exposed as Record<string, BridgeMethod>;
});

afterEach(() => {
	vi.resetAllMocks();
	vi.restoreAllMocks();
});

describe('preload bridge', () => {
	it('exposes one frozen object of wrapper functions', () => {
		expect(exposeCalls).toBe(1);
		expect(Object.isFrozen(bridge)).toBe(true);
		const ipcFunctions = Object.values(electron);
		for (const [name, member] of Object.entries(bridge)) {
			expect(typeof member, name).toBe('function');
			expect(ipcFunctions, name).not.toContain(member);
		}
	});

	it('rejects invalid arguments before anything reaches main', async () => {
		const methods = Object.entries(bridge).filter(
			([name, method]) => method.length > 0 && !name.startsWith('subscribe')
		);
		expect(methods.length).toBeGreaterThan(20);
		for (const [name, method] of methods) {
			await expect(
				(async () => method({ unexpected: true }))(),
				name
			).rejects.toThrow();
		}
		expect(electron.invoke).not.toHaveBeenCalled();
		expect(electron.send).not.toHaveBeenCalled();
	});

	it('validates what main returns before resolving', async () => {
		const getters = Object.entries(bridge).filter(
			([, method]) => method.length === 0
		);
		expect(getters.length).toBeGreaterThan(5);
		electron.invoke.mockResolvedValue({ unexpected: true });
		for (const [name, getter] of getters) {
			await expect(getter(), name).rejects.toThrow();
		}
		expect(electron.invoke).toHaveBeenCalledTimes(getters.length);

		electron.invoke.mockResolvedValueOnce({ ok: true });
		await expect(
			bridge.runAction?.({
				actionId: 'action-1',
				deviceId: 'device-1',
				tool: 'console',
				command: 'clear',
				payload: {},
			})
		).rejects.toThrow();
		expect(electron.invoke).toHaveBeenLastCalledWith(
			IPC_CHANNELS.runAction,
			expect.objectContaining({ tool: 'console', command: 'clear' })
		);
	});

	it('requires a listener and registers one removable handler per subscription', () => {
		const names = subscriptions().map(([name]) => name);
		expect(names.length).toBeGreaterThan(5);
		for (const name of names) {
			electron.on.mockClear();
			expect(() => bridge[name]?.('not a listener'), name).toThrow(TypeError);
			expect(electron.on, name).not.toHaveBeenCalled();

			const { channel, handler, unsubscribe } = subscribeAndCapture(
				name,
				vi.fn()
			);
			expect(channelName(channel), name).toBeDefined();
			unsubscribe();
			expect(electron.removeListener, name).toHaveBeenLastCalledWith(
				channel,
				handler
			);
		}
	});

	it('drops invalid pushed values and reports the first of a run without values', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		for (const [name] of subscriptions()) {
			warn.mockClear();
			const listener = vi.fn();
			const { handler } = subscribeAndCapture(name, listener);
			handler({}, { unexpected: 'private-value' }, new Uint8Array(1));
			handler({}, { unexpected: 'private-value' }, new Uint8Array(1));
			expect(listener, name).not.toHaveBeenCalled();
			// A dropped video frame is replaced by the next one, so it is not reported.
			if (name === 'subscribeSimulatorStreamFrames') continue;
			expect(warn, name).toHaveBeenCalledTimes(1);
			expect(String(warn.mock.calls[0]?.[0]), name).not.toContain(
				'private-value'
			);
		}
	});

	it('forwards valid desktop state and survives a throwing listener', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const listener = vi.fn(() => {
			throw new Error('renderer bug');
		});
		const { channel, handler } = subscribeAndCapture('subscribe', listener);
		expect(channel).toBe(IPC_CHANNELS.stateChanged);
		const state = desktopState();

		expect(() => handler({}, state)).not.toThrow();
		expect(listener).toHaveBeenCalledWith(desktopStateSchema.parse(state));

		const hiddenHost = `private-host-${'x'.repeat(5_000)}`;
		const invalid = { ...state, broker: { ...state.broker, host: hiddenHost } };
		handler({}, invalid);
		handler({}, invalid);
		handler({}, state);
		handler({}, invalid);
		expect(listener).toHaveBeenCalledTimes(2);
		expect(warn).toHaveBeenCalledTimes(2);
		expect(warn).toHaveBeenLastCalledWith(
			'Ignoring desktop state updates that fail validation: broker.host (too_big)'
		);
	});

	it('forwards a valid stream frame only with bounded bytes', () => {
		const listener = vi.fn();
		const { handler } = subscribeAndCapture(
			'subscribeSimulatorStreamFrames',
			listener
		);
		const frame = {
			udid: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
			quality: 'tile',
			sequence: 1,
			capturedAt: 1,
			width: 10,
			height: 10,
			mimeType: 'image/jpeg',
			captureMs: 5,
		};
		handler({}, frame, new Uint8Array(0));
		handler({}, frame, new Uint8Array(2 * 1024 * 1024 + 1));
		handler({}, frame, 'not bytes');
		expect(listener).not.toHaveBeenCalled();
		const bytes = new Uint8Array([1, 2, 3]);
		handler({}, frame, bytes);
		expect(listener).toHaveBeenCalledWith(frame, bytes);
	});

	it('bridges every channel, and main answers each one the preload uses', () => {
		const preload = fs.readFileSync(
			path.join(sourceRoot, 'preload/index.ts'),
			'utf8'
		);
		const invoked = channelsUsed(preload, 'ipcRenderer\\.invoke');
		const sent = channelsUsed(preload, 'ipcRenderer\\.send');
		const pushed = new Set<string>();
		for (const [name] of subscriptions()) {
			const { channel } = subscribeAndCapture(name, vi.fn());
			pushed.add(channelName(channel) ?? String(channel));
		}

		expect(new Set(Object.values(IPC_CHANNELS)).size).toBe(channelNames.length);
		expect([...invoked, ...sent, ...pushed].sort()).toEqual(
			[...channelNames].sort()
		);

		// Main registers its handlers while the app boots, which a unit test
		// cannot run, so the registrations are read from its sources.
		const main = sourceFiles(path.join(sourceRoot, 'main'))
			.map((file) => fs.readFileSync(file, 'utf8'))
			.join('\n');
		const handled = channelsUsed(main, 'ipcMain\\.handle');
		const listened = channelsUsed(main, 'ipcMain\\.on');
		const broadcast = channelsUsed(main, '(?:\\.send|\\bbroadcast)');
		expect([...invoked].filter((name) => !handled.has(name))).toEqual([]);
		expect([...sent].filter((name) => !listened.has(name))).toEqual([]);
		expect([...pushed].filter((name) => !broadcast.has(name))).toEqual([]);
	});
});

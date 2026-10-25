import { describe, expect, it } from 'vitest';
import { createDemoDevice } from '../shared/demo-data';
import { DESKTOP_PROTOCOL_VERSION } from '../shared/protocol';
import { projectBrokerState } from './broker-state';

describe('projectBrokerState', () => {
	it('orders detached device and diagnostic arrays deterministically', () => {
		const simulated = createDemoDevice(100);
		const online = {
			...createDemoDevice(90),
			info: { ...simulated.info, id: 'online', name: 'Online' },
			status: 'online' as const,
		};
		const offline = {
			...createDemoDevice(110),
			info: { ...simulated.info, id: 'offline', name: 'Offline' },
			status: 'offline' as const,
		};
		const diagnostics = [
			{
				id: 'diagnostic-1',
				at: 100,
				level: 'info' as const,
				scope: 'broker',
				message: 'Connected',
			},
		];

		const state = projectBrokerState({
			broker: {
				status: 'listening',
				host: '127.0.0.1',
				port: 47_931,
				access: 'loopback',
				urls: ['ws://127.0.0.1:47931/device'],
			},
			sessions: [
				{ device: offline },
				{ device: simulated },
				{ device: online },
			],
			diagnostics,
		});

		expect(state.protocolVersion).toBe(DESKTOP_PROTOCOL_VERSION);
		expect(state.devices.map((device) => device.info.id)).toEqual([
			'online',
			simulated.info.id,
			'offline',
		]);
		expect(state.diagnostics).toEqual(diagnostics);
		expect(state.diagnostics).not.toBe(diagnostics);
	});
});

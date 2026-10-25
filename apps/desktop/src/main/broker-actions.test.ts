import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
	createEmptyDeviceTools,
	type DesktopAction,
	type DeviceSession,
} from '../shared/protocol';
import {
	BrokerActionRouter,
	type BrokerActionRouterOptions,
	type BrokerActionSession,
} from './broker-actions';

const clearConsoleAction: DesktopAction = {
	actionId: 'clear-console',
	deviceId: 'action-device',
	tool: 'console',
	command: 'clear',
	payload: {},
};

function actionSession(capabilities: DeviceSession['info']['capabilities']): {
	session: BrokerActionSession;
	send: ReturnType<typeof vi.fn>;
} {
	const send = vi.fn();
	return {
		session: {
			device: {
				info: {
					id: 'action-device',
					name: 'Action device',
					platform: 'ios',
					capabilities,
				},
				status: 'online',
				connectedAt: 1,
				lastSeenAt: 1,
				sequence: 0,
				latencyMs: 0,
				tools: createEmptyDeviceTools(),
			},
			socket: {
				readyState: WebSocket.OPEN,
				send,
			} as unknown as WebSocket,
		},
		send,
	};
}

function actionRouter(session: BrokerActionSession): {
	router: BrokerActionRouter;
	record: ReturnType<typeof vi.fn>;
	emit: ReturnType<typeof vi.fn>;
} {
	const record = vi.fn<BrokerActionRouterOptions['record']>();
	const emit = vi.fn<BrokerActionRouterOptions['emit']>();
	return {
		router: new BrokerActionRouter({
			getSession: (deviceId) =>
				deviceId === session.device.info.id ? session : undefined,
			now: () => 100,
			record,
			emit,
		}),
		record,
		emit,
	};
}

describe('BrokerActionRouter', () => {
	it('rejects unsupported actions before sending to the device', async () => {
		const { session, send } = actionSession([]);
		const { router } = actionRouter(session);

		await expect(router.dispatch(clearConsoleAction)).resolves.toMatchObject({
			ok: false,
			error: 'Device does not advertise console.clear.',
		});
		expect(send).not.toHaveBeenCalled();
	});

	it('routes one action envelope and resolves its matching acknowledgement', async () => {
		const { session, send } = actionSession(['console.clear']);
		const { router } = actionRouter(session);

		const pending = router.dispatch(clearConsoleAction);
		expect(send).toHaveBeenCalledOnce();
		expect(JSON.parse(String(send.mock.calls[0]?.[0]))).toEqual({
			type: 'action',
			action: clearConsoleAction,
		});
		router.handleResult('action-device', {
			type: 'action-result',
			actionId: 'clear-console',
			ok: true,
		});

		await expect(pending).resolves.toEqual({
			actionId: 'clear-console',
			ok: true,
		});
	});

	it('redacts acknowledgement errors and rejects pending work on shutdown', async () => {
		const secret = 'private-action-token';
		const { session } = actionSession(['console.clear']);
		const { router } = actionRouter(session);
		const failed = router.dispatch(clearConsoleAction);
		router.handleResult('action-device', {
			type: 'action-result',
			actionId: 'clear-console',
			ok: false,
			error: `token=${secret}`,
		});
		const failure = await failed;
		expect(failure.error).not.toContain(secret);
		expect(failure.error).toContain('[REDACTED]');

		const interrupted = router.dispatch({
			...clearConsoleAction,
			actionId: 'interrupted-action',
		});
		router.stop();
		await expect(interrupted).resolves.toEqual({
			actionId: 'interrupted-action',
			ok: false,
			error: 'Broker stopped.',
		});
	});
});

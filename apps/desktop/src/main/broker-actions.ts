import { redactDiagnosticText } from '@rndevtools/core/redact';
import { truncateText } from '@rndevtools/core/serialize';
import { WebSocket } from 'ws';
import { applyDemoAction } from '../shared/demo-data';
import {
	type DesktopAction,
	type DesktopActionResult,
	type DeviceMessage,
	type DeviceSession,
	desktopActionCapability,
} from '../shared/protocol';
import { safeBrokerErrorText } from './broker-inbound';

const ACTION_TIMEOUT_MS = 8_000;
const LONG_ACTION_TIMEOUT_MS = 30_000;
const MAX_ACTION_ERROR_BYTES = 8 * 1024;

export type BrokerActionSession = {
	device: DeviceSession;
	socket?: WebSocket;
};

type PendingAction = {
	deviceId: string;
	resolve: (result: DesktopActionResult) => void;
	timer: NodeJS.Timeout;
	timedOut: boolean;
};

type ActionResultMessage = Extract<DeviceMessage, { type: 'action-result' }>;

export type BrokerActionRouterOptions = {
	getSession: (deviceId: string) => BrokerActionSession | undefined;
	now: () => number;
	record: (level: 'info' | 'warn', scope: string, message: string) => void;
	emit: () => void;
};

function actionTimeout(action: DesktopAction): number {
	if (
		action.tool === 'restore' ||
		(action.tool === 'query' && action.command === 'refetch')
	) {
		return LONG_ACTION_TIMEOUT_MS;
	}
	return ACTION_TIMEOUT_MS;
}

/** Owns remote-action policy, per-device serialization, and acknowledgements. */
export class BrokerActionRouter {
	readonly #getSession: BrokerActionRouterOptions['getSession'];
	readonly #now: BrokerActionRouterOptions['now'];
	readonly #record: BrokerActionRouterOptions['record'];
	readonly #emit: BrokerActionRouterOptions['emit'];
	readonly #pending = new Map<string, PendingAction>();

	constructor({ getSession, now, record, emit }: BrokerActionRouterOptions) {
		this.#getSession = getSession;
		this.#now = now;
		this.#record = record;
		this.#emit = emit;
	}

	async dispatch(action: DesktopAction): Promise<DesktopActionResult> {
		const session = this.#getSession(action.deviceId);
		if (!session) {
			return {
				actionId: action.actionId,
				ok: false,
				error: 'Device was not found.',
			};
		}
		const capability = desktopActionCapability(action.tool, action.command);
		if (!capability || !session.device.info.capabilities.includes(capability)) {
			return {
				actionId: action.actionId,
				ok: false,
				error: `Device does not advertise ${capability ?? `${action.tool}.${action.command}`}.`,
			};
		}

		if (session.device.status === 'simulated') {
			try {
				session.device = applyDemoAction(session.device, action, this.#now());
				this.#record(
					'info',
					action.tool,
					`Demo action completed: ${action.command}.`
				);
				this.#emit();
				return { actionId: action.actionId, ok: true };
			} catch (error) {
				return {
					actionId: action.actionId,
					ok: false,
					error: safeBrokerErrorText(error),
				};
			}
		}

		const socket = session.socket;
		if (!socket || socket.readyState !== WebSocket.OPEN) {
			return {
				actionId: action.actionId,
				ok: false,
				error: 'Device is offline.',
			};
		}
		if (this.#pending.has(action.actionId)) {
			return {
				actionId: action.actionId,
				ok: false,
				error: 'An action with this identifier is already pending.',
			};
		}
		if (
			[...this.#pending.values()].some(
				(pending) => pending.deviceId === action.deviceId
			)
		) {
			return {
				actionId: action.actionId,
				ok: false,
				error: 'Another action is already pending for this device.',
			};
		}

		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				const pending = this.#pending.get(action.actionId);
				if (pending) pending.timedOut = true;
				resolve({
					actionId: action.actionId,
					ok: false,
					error:
						'Device did not acknowledge the action in time. Its outcome is unknown; reconnect the device before sending another action.',
				});
				this.#record(
					'warn',
					action.tool,
					`Action ${action.actionId} timed out; the device must acknowledge it or reconnect before more actions are accepted.`
				);
				this.#emit();
			}, actionTimeout(action));
			this.#pending.set(action.actionId, {
				deviceId: action.deviceId,
				resolve,
				timer,
				timedOut: false,
			});
			try {
				socket.send(JSON.stringify({ type: 'action', action }), (error) => {
					if (!error) return;
					const pending = this.#pending.get(action.actionId);
					if (!pending || pending.deviceId !== action.deviceId) return;
					const errorText = safeBrokerErrorText(error);
					clearTimeout(pending.timer);
					this.#pending.delete(action.actionId);
					pending.resolve({
						actionId: action.actionId,
						ok: false,
						error: `Action could not be sent: ${errorText}`,
					});
					this.#record(
						'warn',
						action.tool,
						`Action ${action.actionId} could not be sent: ${errorText}`
					);
					this.#emit();
				});
			} catch (error) {
				const errorText = safeBrokerErrorText(error);
				clearTimeout(timer);
				this.#pending.delete(action.actionId);
				resolve({
					actionId: action.actionId,
					ok: false,
					error: `Action could not be sent: ${errorText}`,
				});
				this.#record(
					'warn',
					action.tool,
					`Action ${action.actionId} could not be sent: ${errorText}`
				);
				this.#emit();
			}
		});
	}

	handleResult(deviceId: string, message: ActionResultMessage): void {
		const pending = this.#pending.get(message.actionId);
		if (!pending || pending.deviceId !== deviceId) return;
		clearTimeout(pending.timer);
		this.#pending.delete(message.actionId);
		if (pending.timedOut) {
			this.#record(
				'info',
				'action',
				`Late acknowledgement received for ${message.actionId}; device actions are unblocked.`
			);
			this.#emit();
		}
		pending.resolve({
			actionId: message.actionId,
			ok: message.ok,
			error: message.error
				? truncateText(
						redactDiagnosticText(message.error),
						MAX_ACTION_ERROR_BYTES
					).text
				: undefined,
		});
	}

	rejectDevice(deviceId: string, error: string): void {
		for (const [actionId, pending] of this.#pending) {
			if (pending.deviceId !== deviceId) continue;
			clearTimeout(pending.timer);
			this.#pending.delete(actionId);
			pending.resolve({ actionId, ok: false, error });
		}
	}

	stop(error = 'Broker stopped.'): void {
		for (const [actionId, pending] of this.#pending) {
			clearTimeout(pending.timer);
			pending.resolve({ actionId, ok: false, error });
		}
		this.#pending.clear();
	}
}

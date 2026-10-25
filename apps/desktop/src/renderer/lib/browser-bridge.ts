import { errorText } from '@/lib/runtime-action';
import {
	type AppearanceBridge,
	appearancePreferenceSchema,
} from '../../shared/appearance-protocol';
import {
	applyDemoAction,
	createDemoDevice,
	tickDemoDevice,
} from '../../shared/demo-data';
import {
	DESKTOP_PROTOCOL_VERSION,
	type DesktopAction,
	type DesktopBridge,
	type DesktopState,
	desktopActionCapability,
	desktopActionSchema,
} from '../../shared/protocol';

const now = Date.now();
let state: DesktopState = {
	protocolVersion: DESKTOP_PROTOCOL_VERSION,
	broker: {
		status: 'listening',
		host: '127.0.0.1',
		port: 47931,
		access: 'loopback',
		urls: ['ws://127.0.0.1:47931/device'],
	},
	devices: [createDemoDevice(now)],
	diagnostics: [
		{
			id: 'browser-preview',
			at: now,
			level: 'info',
			scope: 'renderer',
			message: 'Running the browser preview with an in-memory device.',
		},
	],
};
const listeners = new Set<(next: DesktopState) => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function emit(): void {
	for (const listener of listeners) {
		try {
			listener(state);
		} catch {
			// A preview subscriber must not interrupt the simulated broker timer.
		}
	}
}

function ensureTimer(): void {
	if (timer) return;
	timer = setInterval(() => {
		state = {
			...state,
			devices: state.devices.map((device) =>
				device.status === 'simulated' ? tickDemoDevice(device) : device
			),
		};
		emit();
	}, 1_000);
}

function stopTimerWithoutSubscribers(): void {
	if (listeners.size > 0 || !timer) return;
	clearInterval(timer);
	timer = undefined;
}

async function runAction(value: DesktopAction) {
	const action = desktopActionSchema.parse(value);
	const device = state.devices.find(
		(candidate) => candidate.info.id === action.deviceId
	);
	if (!device) {
		return {
			actionId: action.actionId,
			ok: false,
			error: 'Device was not found.',
		};
	}
	const capability = desktopActionCapability(action.tool, action.command);
	if (!capability || !device.info.capabilities.includes(capability)) {
		return {
			actionId: action.actionId,
			ok: false,
			error: `Device does not advertise ${capability ?? `${action.tool}.${action.command}`}.`,
		};
	}
	try {
		state = {
			...state,
			devices: state.devices.map((device) =>
				device.info.id === action.deviceId
					? applyDemoAction(device, action)
					: device
			),
		};
		emit();
		return { actionId: action.actionId, ok: true };
	} catch (error) {
		return {
			actionId: action.actionId,
			ok: false,
			error: errorText(error),
		};
	}
}

export function createBrowserBridge(): DesktopBridge {
	return {
		getBootstrap: async () => ({
			state,
			platform: 'browser',
			versions: {
				app: '0.1.0',
				electron: 'browser preview',
				chrome: navigator.userAgent,
				node: 'not available',
			},
		}),
		subscribe: (listener) => {
			listeners.add(listener);
			ensureTimer();
			return () => {
				listeners.delete(listener);
				stopTimerWithoutSubscribers();
			};
		},
		runAction,
	};
}

const APPEARANCE_KEY = 'rndevtools.desktop.appearance';

/**
 * The preview keeps its appearance in local storage. It cannot move the
 * page's `prefers-color-scheme`, so Light and Dark hold through the class
 * the renderer sets instead.
 */
export function createBrowserAppearanceBridge(): AppearanceBridge {
	return {
		getAppearance: async () => {
			try {
				return appearancePreferenceSchema
					.catch('system')
					.parse(localStorage.getItem(APPEARANCE_KEY));
			} catch {
				return 'system';
			}
		},
		setAppearance: async (value) => {
			const preference = appearancePreferenceSchema.parse(value);
			try {
				localStorage.setItem(APPEARANCE_KEY, preference);
			} catch {
				// Persistence is optional in the preview; the choice still applies.
			}
			return preference;
		},
	};
}

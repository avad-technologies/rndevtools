import { desktopActionCapability } from '@rndevtools/core/desktop-protocol';
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import type { ActionStatus } from '@/lib/action-notice';
import { createBrowserBridge } from '@/lib/browser-bridge';
import { errorText, nextActionId } from '@/lib/runtime-action';
import type {
	DesktopActionResult,
	DesktopBootstrap,
	DesktopBridge,
	DesktopState,
	DeviceSession,
	ToolId,
} from '../../shared/protocol';

type DesktopRuntimeValue = {
	bootstrap: DesktopBootstrap | null;
	state: DesktopState | null;
	runtimeError: string | null;
	selectedDevice: DeviceSession | null;
	selectedDeviceId: string | null;
	setSelectedDeviceId: (deviceId: string) => void;
	actionStatus: ActionStatus;
	clearActionStatus: () => void;
	canRunAction: (tool: ToolId, command: string) => boolean;
	actionUnavailableReason: (tool: ToolId, command: string) => string | null;
	runAction: (
		tool: ToolId,
		command: string,
		payload?: Record<string, unknown>,
		successMessage?: string
	) => Promise<DesktopActionResult>;
};

const DesktopRuntimeContext = createContext<DesktopRuntimeValue | null>(null);

const SELECTED_DEVICE_KEY = 'rndevtools.desktop.selected-device';

function runtimeBridge(): DesktopBridge | null {
	if (window.rnDevtools) return window.rnDevtools;
	if (navigator.userAgent.toLowerCase().includes('electron')) return null;
	return createBrowserBridge();
}

function readSelectedDeviceId(): string | null {
	try {
		return localStorage.getItem(SELECTED_DEVICE_KEY);
	} catch {
		return null;
	}
}

function persistSelectedDeviceId(deviceId: string): void {
	try {
		localStorage.setItem(SELECTED_DEVICE_KEY, deviceId);
	} catch {
		// Selection persistence is optional; runtime inspection still works.
	}
}

export function DesktopRuntimeProvider({ children }: { children: ReactNode }) {
	const bridge = useMemo(runtimeBridge, []);
	const [bootstrap, setBootstrap] = useState<DesktopBootstrap | null>(null);
	const [state, setState] = useState<DesktopState | null>(null);
	const [runtimeError, setRuntimeError] = useState<string | null>(() =>
		bridge
			? null
			: 'The secure Electron preload bridge is unavailable. Reload the app or reinstall the desktop build.'
	);
	const [selectedDeviceId, setSelectedDeviceIdState] = useState<string | null>(
		readSelectedDeviceId
	);
	const [actionStatus, setActionStatus] = useState<ActionStatus>({
		kind: 'idle',
		message: '',
	});
	const latestActionId = useRef<string | null>(null);
	const dismissedActionId = useRef<string | null>(null);
	const actionPendingRef = useRef(false);
	const [actionPending, setActionPending] = useState(false);

	useEffect(() => {
		if (!bridge) return;
		let active = true;
		let receivedSubscriptionState = false;
		let subscriptionFailed = false;
		let unsubscribe = () => {};
		try {
			unsubscribe = bridge.subscribe((next) => {
				if (!active) return;
				receivedSubscriptionState = true;
				setState(next);
			});
		} catch (error) {
			subscriptionFailed = true;
			setRuntimeError(errorText(error));
		}
		void bridge
			.getBootstrap()
			.then((next) => {
				if (!active) return;
				setBootstrap(next);
				if (!receivedSubscriptionState) setState(next.state);
				if (!subscriptionFailed) setRuntimeError(null);
			})
			.catch((error: unknown) => {
				if (active) {
					setRuntimeError(errorText(error));
				}
			});
		return () => {
			active = false;
			try {
				unsubscribe();
			} catch {
				// A faulty bridge disposer must not break React teardown.
			}
		};
	}, [bridge]);

	// Falling back to the first device stays derived. Writing the fallback back
	// into `selectedDeviceId` would overwrite the operator's remembered choice —
	// it is only read once, in this state's initializer — so their device would
	// never be reselected once it reconnected.
	const selectedDevice = useMemo(() => {
		if (!state || state.devices.length === 0) return null;
		return (
			state.devices.find((device) => device.info.id === selectedDeviceId) ??
			state.devices[0] ??
			null
		);
	}, [selectedDeviceId, state]);

	const setSelectedDeviceId = useCallback((deviceId: string) => {
		setSelectedDeviceIdState(deviceId);
		persistSelectedDeviceId(deviceId);
	}, []);

	const actionUnavailableReason = useCallback(
		(tool: ToolId, command: string): string | null => {
			if (!selectedDevice) return 'No device is selected.';
			if (selectedDevice.status === 'offline')
				return 'The selected device is offline.';
			const capability = desktopActionCapability(tool, command);
			if (!capability) return `Unsupported desktop action: ${tool}.${command}.`;
			if (!selectedDevice.info.capabilities.includes(capability)) {
				return `The selected device does not support ${capability}.`;
			}
			if (actionPending) {
				return 'Another device action is already in progress.';
			}
			return null;
		},
		[actionPending, selectedDevice]
	);

	const canRunAction = useCallback(
		(tool: ToolId, command: string) =>
			actionUnavailableReason(tool, command) === null,
		[actionUnavailableReason]
	);

	const runAction = useCallback(
		async (
			tool: ToolId,
			command: string,
			payload: Record<string, unknown> = {},
			successMessage = 'Action completed.'
		): Promise<DesktopActionResult> => {
			const capability = desktopActionCapability(tool, command);
			const unavailable =
				capability && actionPendingRef.current
					? 'Another device action is already in progress.'
					: actionUnavailableReason(tool, command);
			if (unavailable || !selectedDevice || !bridge) {
				const result = {
					actionId: nextActionId('desktop'),
					ok: false,
					error: unavailable ?? 'The desktop bridge is unavailable.',
				};
				latestActionId.current = result.actionId;
				setActionStatus({ kind: 'error', message: result.error });
				return result;
			}
			const actionId = nextActionId('desktop');
			actionPendingRef.current = true;
			setActionPending(true);
			latestActionId.current = actionId;
			setActionStatus({
				kind: 'pending',
				message: 'Sending action to device…',
			});
			try {
				const result = await bridge.runAction({
					actionId,
					deviceId: selectedDevice.info.id,
					tool,
					command,
					payload,
				});
				const dismissed = dismissedActionId.current === actionId;
				if (latestActionId.current === actionId && !(result.ok && dismissed)) {
					setActionStatus(
						result.ok
							? { kind: 'success', message: successMessage }
							: {
									kind: 'error',
									message: result.error
										? errorText(result.error)
										: 'The device rejected the action.',
								}
					);
				}
				return result;
			} catch (error) {
				const message = errorText(error);
				if (latestActionId.current === actionId) {
					setActionStatus({ kind: 'error', message });
				}
				return { actionId, ok: false, error: message };
			} finally {
				actionPendingRef.current = false;
				setActionPending(false);
			}
		},
		[actionUnavailableReason, bridge, selectedDevice]
	);

	const clearActionStatus = useCallback(() => {
		// Keep tracking the action so a later rejection still reaches the operator;
		// dismissing a pending toast must not hide a write that did not happen.
		// Only its success notice is suppressed.
		dismissedActionId.current = latestActionId.current;
		setActionStatus({ kind: 'idle', message: '' });
	}, []);

	const value = useMemo<DesktopRuntimeValue>(
		() => ({
			bootstrap,
			state,
			runtimeError,
			selectedDevice,
			selectedDeviceId,
			setSelectedDeviceId,
			actionStatus,
			clearActionStatus,
			canRunAction,
			actionUnavailableReason,
			runAction,
		}),
		[
			actionUnavailableReason,
			actionStatus,
			bootstrap,
			canRunAction,
			clearActionStatus,
			runAction,
			runtimeError,
			selectedDevice,
			selectedDeviceId,
			setSelectedDeviceId,
			state,
		]
	);

	return (
		<DesktopRuntimeContext.Provider value={value}>
			{children}
		</DesktopRuntimeContext.Provider>
	);
}

export function useDesktopRuntime(): DesktopRuntimeValue {
	const value = useContext(DesktopRuntimeContext);
	if (!value)
		throw new Error('useDesktopRuntime must be used inside its provider.');
	return value;
}

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
import {
	errorText,
	jobNoticeKind,
	nextActionId,
	type WithoutActionId,
} from '@/lib/runtime-action';
import type {
	SimulatorAction,
	SimulatorActionReceipt,
	SimulatorBridge,
	SimulatorCaptureAccessResult,
	SimulatorCaptureOperation,
	SimulatorCaptureOperationReceipt,
	SimulatorCaptureRetentionState,
	SimulatorDevice,
	SimulatorOnboardingOperation,
	SimulatorOnboardingReceipt,
	SimulatorState,
} from '../../shared/simulator-protocol';

export type SimulatorActionInput = WithoutActionId<SimulatorAction>;
export type SimulatorCaptureOperationInput =
	WithoutActionId<SimulatorCaptureOperation>;
export type SimulatorOnboardingOperationInput =
	WithoutActionId<SimulatorOnboardingOperation>;

type RunSimulatorActionMessages = {
	pendingMessage?: string;
	successMessage?: string;
};

type CancelSimulatorJobMessages = Pick<
	RunSimulatorActionMessages,
	'successMessage'
>;

type SimulatorRuntimeValue = {
	state: SimulatorState;
	isLoading: boolean;
	isBridgeAvailable: boolean;
	runtimeError: string | null;
	selectedDevice: SimulatorDevice | null;
	selectedDeviceUdid: string | null;
	setSelectedDeviceUdid: (udid: string) => void;
	actionStatus: ActionStatus;
	clearActionStatus: () => void;
	refresh: () => Promise<void>;
	runAction: (
		action: SimulatorActionInput,
		messages?: RunSimulatorActionMessages
	) => Promise<SimulatorActionReceipt>;
	cancelJob: (
		jobId: string,
		messages?: CancelSimulatorJobMessages
	) => Promise<boolean>;
	getCaptureAccess: (
		captureId: string
	) => Promise<SimulatorCaptureAccessResult>;
	getCaptureRetention: () => Promise<SimulatorCaptureRetentionState>;
	runCaptureOperation: (
		operation: SimulatorCaptureOperationInput,
		messages?: RunSimulatorActionMessages
	) => Promise<SimulatorCaptureOperationReceipt>;
	runOnboardingOperation: (
		operation: SimulatorOnboardingOperationInput
	) => Promise<SimulatorOnboardingReceipt>;
};

const SimulatorRuntimeContext = createContext<SimulatorRuntimeValue | null>(
	null
);
const SELECTED_DEVICE_KEY = 'rndevtools.desktop.simulator.selected-device';

const EMPTY_SIMULATOR_STATE: SimulatorState = {
	revision: 0,
	updatedAt: 0,
	capability: {
		status: 'checking',
		platform: 'other',
		licenseStatus: 'unknown',
		hostArchitecture: 'other',
		runtimeAvailability: { total: 0, available: 0 },
		features: {
			deviceManagement: false,
			apps: false,
			deepLinks: false,
			location: false,
			push: false,
			privacy: false,
			ui: false,
			statusBar: false,
			keychain: false,
			screenshot: false,
			video: false,
		},
	},
	runtimes: [],
	deviceTypes: [],
	devices: [],
	appsByDevice: {},
	diskByDevice: {},
	jobs: [],
	captures: [],
	metrics: { status: 'checking', byDevice: {} },
	native: {
		status: 'checking',
		permissionInspection: false,
		permissionPrompting: false,
		permissions: [],
	},
};

function getSimulatorBridge(): SimulatorBridge | null {
	const candidate = window.rnDevtools;
	if (
		!candidate ||
		typeof candidate.getSimulatorState !== 'function' ||
		typeof candidate.subscribeSimulatorState !== 'function' ||
		typeof candidate.refreshSimulators !== 'function' ||
		typeof candidate.requestSimulatorConfirmation !== 'function' ||
		typeof candidate.runSimulatorAction !== 'function' ||
		typeof candidate.cancelSimulatorJob !== 'function' ||
		typeof candidate.getSimulatorCaptureAccess !== 'function' ||
		typeof candidate.getSimulatorCaptureRetention !== 'function' ||
		typeof candidate.runSimulatorCaptureOperation !== 'function' ||
		typeof candidate.runSimulatorOnboardingOperation !== 'function'
	) {
		return null;
	}
	return candidate;
}

function readSelectedDeviceUdid(): string | null {
	try {
		return localStorage.getItem(SELECTED_DEVICE_KEY);
	} catch {
		return null;
	}
}

function persistSelectedDeviceUdid(udid: string): void {
	try {
		localStorage.setItem(SELECTED_DEVICE_KEY, udid);
	} catch {
		// Selection persistence is optional and never blocks native Simulator actions.
	}
}

export function simulatorJobCancellationStatus(
	cancelled: boolean,
	messages: CancelSimulatorJobMessages = {}
): ActionStatus {
	return cancelled
		? { kind: 'success', message: messages.successMessage ?? 'Job cancelled.' }
		: { kind: 'error', message: 'The job could not be cancelled.' };
}

export function SimulatorRuntimeProvider({
	children,
}: {
	children: ReactNode;
}) {
	const bridge = useMemo(getSimulatorBridge, []);
	const [state, setState] = useState<SimulatorState>(EMPTY_SIMULATOR_STATE);
	const [isLoading, setIsLoading] = useState(Boolean(bridge));
	const [runtimeError, setRuntimeError] = useState<string | null>(() =>
		bridge
			? null
			: 'Simulator controls require the secure desktop bridge. Open this workspace in the installed desktop app.'
	);
	const [selectedDeviceUdid, setSelectedDeviceUdidState] = useState<
		string | null
	>(readSelectedDeviceUdid);
	const [actionStatus, setActionStatus] = useState<ActionStatus>({
		kind: 'idle',
		message: '',
	});
	const [submittedJobId, setSubmittedJobId] = useState<string | null>(null);
	useEffect(() => {
		const job = state.jobs.find((candidate) => candidate.id === submittedJobId);
		if (!job) return;
		const kind = jobNoticeKind(job.status);
		setActionStatus((current) =>
			current.kind === kind && current.message === job.message
				? current
				: { kind, message: job.message }
		);
		if (kind !== 'pending') setSubmittedJobId(null);
	}, [state.jobs, submittedJobId]);

	const pendingActionKeysRef = useRef(new Set<string>());
	const pendingCaptureOperationKeysRef = useRef(new Set<string>());
	const pendingOnboardingKeysRef = useRef(new Set<string>());
	const latestActionIdRef = useRef<string | null>(null);

	useEffect(() => {
		if (!bridge) return;
		let active = true;
		let unsubscribe = () => {};
		try {
			unsubscribe = bridge.subscribeSimulatorState((nextState) => {
				if (!active) return;
				setState((current) =>
					nextState.revision >= current.revision ? nextState : current
				);
				setRuntimeError(null);
				setIsLoading(false);
			});
		} catch (error) {
			setRuntimeError(errorText(error));
			setIsLoading(false);
		}

		void bridge
			.getSimulatorState()
			.then((nextState) => {
				if (!active) return;
				setState((current) =>
					nextState.revision >= current.revision ? nextState : current
				);
				setRuntimeError(null);
			})
			.catch((error: unknown) => {
				if (active) setRuntimeError(errorText(error));
			})
			.finally(() => {
				if (active) setIsLoading(false);
			});

		return () => {
			active = false;
			try {
				unsubscribe();
			} catch {
				// A faulty native disposer must not break React teardown.
			}
		};
	}, [bridge]);

	const selectedDevice = useMemo(() => {
		if (state.devices.length === 0) return null;
		return (
			state.devices.find((device) => device.udid === selectedDeviceUdid) ??
			state.devices.find((device) => device.state === 'booted') ??
			state.devices[0] ??
			null
		);
	}, [selectedDeviceUdid, state.devices]);

	const setSelectedDeviceUdid = useCallback((udid: string) => {
		setSelectedDeviceUdidState(udid);
		persistSelectedDeviceUdid(udid);
	}, []);

	const refresh = useCallback(async () => {
		if (!bridge) {
			setRuntimeError(
				'Simulator discovery is unavailable because the secure desktop bridge is missing.'
			);
			return;
		}
		setIsLoading(true);
		try {
			const nextState = await bridge.refreshSimulators();
			setState((current) =>
				nextState.revision >= current.revision ? nextState : current
			);
			setRuntimeError(null);
		} catch (error) {
			setRuntimeError(errorText(error));
		} finally {
			setIsLoading(false);
		}
	}, [bridge]);

	const runAction = useCallback(
		async (
			actionInput: SimulatorActionInput,
			messages: RunSimulatorActionMessages = {}
		): Promise<SimulatorActionReceipt> => {
			const actionId = nextActionId('simulator');
			const actionKey = JSON.stringify(actionInput);
			if (!bridge) {
				const error = 'Simulator actions require the secure desktop bridge.';
				setActionStatus({ kind: 'error', message: error });
				return { actionId, accepted: false, error };
			}
			if (pendingActionKeysRef.current.has(actionKey)) {
				const error = 'This exact Simulator action is already being submitted.';
				setActionStatus({ kind: 'error', message: error });
				return { actionId, accepted: false, error };
			}
			if (pendingActionKeysRef.current.size >= 32) {
				const error =
					'The Simulator submission queue is full. Wait for a receipt.';
				setActionStatus({ kind: 'error', message: error });
				return { actionId, accepted: false, error };
			}

			let action = { ...actionInput, actionId } as SimulatorAction;
			pendingActionKeysRef.current.add(actionKey);
			latestActionIdRef.current = actionId;
			setSubmittedJobId(null);
			setActionStatus({
				kind: 'pending',
				message: messages.pendingMessage ?? 'Submitting Simulator action…',
			});
			try {
				const confirmation = await bridge.requestSimulatorConfirmation(action);
				if (!confirmation.confirmed) {
					const error =
						confirmation.error ?? 'Action cancelled by the operator.';
					if (latestActionIdRef.current === actionId) {
						setActionStatus({ kind: 'error', message: error });
					}
					return { actionId, accepted: false, error };
				}
				if (confirmation.required) {
					if (!confirmation.token) {
						const error =
							'Native confirmation did not issue a valid action token.';
						if (latestActionIdRef.current === actionId) {
							setActionStatus({ kind: 'error', message: error });
						}
						return { actionId, accepted: false, error };
					}
					action = { ...action, confirmationToken: confirmation.token };
				}
				const receipt = await bridge.runSimulatorAction(action);
				if (latestActionIdRef.current === actionId) {
					if (receipt.accepted && receipt.jobId)
						setSubmittedJobId(receipt.jobId);
					setActionStatus(
						receipt.accepted
							? {
									kind: receipt.jobId ? 'pending' : 'success',
									message: receipt.jobId
										? 'Action queued…'
										: (messages.successMessage ?? 'Action accepted.'),
								}
							: {
									kind: 'error',
									message:
										receipt.error ?? 'The Simulator action was rejected.',
								}
					);
				}
				return receipt;
			} catch (error) {
				const message = errorText(error);
				if (latestActionIdRef.current === actionId) {
					setActionStatus({ kind: 'error', message });
				}
				return { actionId, accepted: false, error: message };
			} finally {
				pendingActionKeysRef.current.delete(actionKey);
			}
		},
		[bridge]
	);

	const cancelJob = useCallback(
		async (
			jobId: string,
			messages: CancelSimulatorJobMessages = {}
		): Promise<boolean> => {
			if (!bridge) {
				setActionStatus({
					kind: 'error',
					message: 'Job cancellation requires the secure desktop bridge.',
				});
				return false;
			}
			try {
				const cancelled = await bridge.cancelSimulatorJob(jobId);
				setActionStatus(simulatorJobCancellationStatus(cancelled, messages));
				return cancelled;
			} catch (error) {
				setActionStatus({ kind: 'error', message: errorText(error) });
				return false;
			}
		},
		[bridge]
	);

	const getCaptureAccess = useCallback(
		async (captureId: string): Promise<SimulatorCaptureAccessResult> => {
			if (!bridge)
				throw new Error('Capture access requires the secure desktop bridge.');
			return bridge.getSimulatorCaptureAccess(captureId);
		},
		[bridge]
	);

	const getCaptureRetention =
		useCallback(async (): Promise<SimulatorCaptureRetentionState> => {
			if (!bridge) {
				throw new Error(
					'Capture retention requires the secure desktop bridge.'
				);
			}
			return bridge.getSimulatorCaptureRetention();
		}, [bridge]);

	const runCaptureOperation = useCallback(
		async (
			operationInput: SimulatorCaptureOperationInput,
			messages: RunSimulatorActionMessages = {}
		): Promise<SimulatorCaptureOperationReceipt> => {
			const actionId = nextActionId('capture');
			const operationKey = JSON.stringify(operationInput);
			const failedReceipt = (
				error: string
			): SimulatorCaptureOperationReceipt => ({
				actionId,
				kind: operationInput.kind,
				completed: false,
				error,
			});
			if (!bridge) {
				const error = 'Capture operations require the secure desktop bridge.';
				setActionStatus({ kind: 'error', message: error });
				return failedReceipt(error);
			}
			if (pendingCaptureOperationKeysRef.current.has(operationKey)) {
				const error =
					'This exact capture operation is already being submitted.';
				setActionStatus({ kind: 'error', message: error });
				return failedReceipt(error);
			}
			if (pendingCaptureOperationKeysRef.current.size >= 8) {
				const error =
					'The capture operation queue is full. Wait for a receipt.';
				setActionStatus({ kind: 'error', message: error });
				return failedReceipt(error);
			}

			pendingCaptureOperationKeysRef.current.add(operationKey);
			latestActionIdRef.current = actionId;
			setSubmittedJobId(null);
			setActionStatus({
				kind: 'pending',
				message: messages.pendingMessage ?? 'Submitting capture operation…',
			});
			try {
				const receipt = await bridge.runSimulatorCaptureOperation({
					...operationInput,
					actionId,
				} as SimulatorCaptureOperation);
				if (latestActionIdRef.current === actionId) {
					setActionStatus(
						receipt.completed
							? {
									kind: 'success',
									message:
										messages.successMessage ?? 'Capture operation completed.',
								}
							: receipt.cancelled
								? { kind: 'success', message: 'Capture operation cancelled.' }
								: {
										kind: 'error',
										message: receipt.error ?? 'The capture operation failed.',
									}
					);
				}
				return receipt;
			} catch (error) {
				const message = errorText(error);
				if (latestActionIdRef.current === actionId) {
					setActionStatus({ kind: 'error', message });
				}
				return failedReceipt(message);
			} finally {
				pendingCaptureOperationKeysRef.current.delete(operationKey);
			}
		},
		[bridge]
	);

	const runOnboardingOperation = useCallback(
		async (
			operationInput: SimulatorOnboardingOperationInput
		): Promise<SimulatorOnboardingReceipt> => {
			const actionId = nextActionId('onboarding');
			const failed = (error: string): SimulatorOnboardingReceipt => ({
				actionId,
				kind: operationInput.kind,
				completed: false,
				error,
			});
			if (!bridge) {
				const error =
					'Simulator onboarding requires the secure desktop bridge.';
				setActionStatus({ kind: 'error', message: error });
				return failed(error);
			}
			const key = JSON.stringify(operationInput);
			if (pendingOnboardingKeysRef.current.has(key)) {
				const error = 'This onboarding action is already open.';
				setActionStatus({ kind: 'error', message: error });
				return failed(error);
			}
			pendingOnboardingKeysRef.current.add(key);
			latestActionIdRef.current = actionId;
			setSubmittedJobId(null);
			setActionStatus({
				kind: 'pending',
				message: 'Opening the trusted setup flow…',
			});
			try {
				const receipt = await bridge.runSimulatorOnboardingOperation({
					...operationInput,
					actionId,
				} as SimulatorOnboardingOperation);
				if (
					receipt.actionId !== actionId ||
					receipt.kind !== operationInput.kind
				) {
					const error = 'Onboarding returned a mismatched action receipt.';
					setActionStatus({ kind: 'error', message: error });
					return failed(error);
				}
				setActionStatus(
					receipt.completed
						? { kind: 'success', message: 'Setup action completed.' }
						: receipt.cancelled
							? { kind: 'success', message: 'Setup action cancelled.' }
							: {
									kind: 'error',
									message: receipt.error ?? 'Setup action failed.',
								}
				);
				if (receipt.completed && receipt.requiresRefresh) await refresh();
				return receipt;
			} catch (error) {
				const message = errorText(error);
				setActionStatus({ kind: 'error', message });
				return failed(message);
			} finally {
				pendingOnboardingKeysRef.current.delete(key);
			}
		},
		[bridge, refresh]
	);

	const clearActionStatus = useCallback(() => {
		setSubmittedJobId(null);
		setActionStatus({ kind: 'idle', message: '' });
	}, []);

	const value = useMemo<SimulatorRuntimeValue>(
		() => ({
			state,
			isLoading,
			isBridgeAvailable: Boolean(bridge),
			runtimeError,
			selectedDevice,
			selectedDeviceUdid,
			setSelectedDeviceUdid,
			actionStatus,
			clearActionStatus,
			refresh,
			runAction,
			cancelJob,
			getCaptureAccess,
			getCaptureRetention,
			runCaptureOperation,
			runOnboardingOperation,
		}),
		[
			actionStatus,
			bridge,
			cancelJob,
			clearActionStatus,
			getCaptureAccess,
			getCaptureRetention,
			isLoading,
			refresh,
			runAction,
			runCaptureOperation,
			runOnboardingOperation,
			runtimeError,
			selectedDevice,
			selectedDeviceUdid,
			setSelectedDeviceUdid,
			state,
		]
	);

	return (
		<SimulatorRuntimeContext.Provider value={value}>
			{children}
		</SimulatorRuntimeContext.Provider>
	);
}

export function useSimulatorRuntime(): SimulatorRuntimeValue {
	const value = useContext(SimulatorRuntimeContext);
	if (!value) {
		throw new Error(
			'useSimulatorRuntime must be used inside SimulatorRuntimeProvider.'
		);
	}
	return value;
}

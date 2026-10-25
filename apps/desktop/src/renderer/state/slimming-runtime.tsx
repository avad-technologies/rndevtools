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
	SlimmingAcknowledgementRequest,
	SlimmingAction,
	SlimmingActionReceipt,
	SlimmingBridge,
	SlimmingSettingReceipt,
	SlimmingSettingRequest,
	SlimmingState,
} from '../../shared/slimming-protocol';
import { SLIMMING_EXPERIMENTAL_ACKNOWLEDGEMENT } from '../../shared/slimming-protocol';

export type SlimmingActionInput = WithoutActionId<SlimmingAction>;
export type SlimmingSettingInput = WithoutActionId<SlimmingSettingRequest>;

type SlimmingActionMessages = {
	pendingMessage?: string;
	successMessage?: string;
};

type SlimmingRuntimeValue = {
	state: SlimmingState;
	isLoading: boolean;
	isBridgeAvailable: boolean;
	runtimeError: string | null;
	actionStatus: ActionStatus;
	clearActionStatus: () => void;
	refresh: () => Promise<void>;
	setEnabled: (request: SlimmingSettingInput) => Promise<void>;
	acknowledgeCompatibility: (input: {
		simulatorUdids: string[];
		acknowledgement: string;
	}) => Promise<{ accepted: boolean; error?: string }>;
	runAction: (
		action: SlimmingActionInput,
		messages?: SlimmingActionMessages
	) => Promise<SlimmingActionReceipt>;
	cancelJob: (jobId: string) => Promise<boolean>;
};

const EMPTY_SLIMMING_STATE: SlimmingState = {
	revision: 0,
	updatedAt: 0,
	setting: { experimentalMutationsEnabled: false },
	helper: { status: 'checking', readOnlyAvailable: false },
	categories: [],
	profiles: [],
	simulators: [],
	statusBySimulator: {},
	previewBySimulator: {},
	doctorBySimulator: {},
	jobs: [],
	checkpointBySimulator: {},
	operationsBySimulator: {},
};

const SlimmingRuntimeContext = createContext<SlimmingRuntimeValue | null>(null);

function slimmingBridge(): SlimmingBridge | null {
	const candidate = window.rnDevtools as
		| (NonNullable<typeof window.rnDevtools> & Partial<SlimmingBridge>)
		| undefined;
	if (
		!candidate ||
		typeof candidate.getSlimmingState !== 'function' ||
		typeof candidate.subscribeSlimmingState !== 'function' ||
		typeof candidate.refreshSlimming !== 'function' ||
		typeof candidate.setSlimmingEnabled !== 'function' ||
		typeof candidate.acknowledgeSlimmingCompatibility !== 'function' ||
		typeof candidate.requestSlimmingConfirmation !== 'function' ||
		typeof candidate.runSlimmingAction !== 'function' ||
		typeof candidate.cancelSlimmingJob !== 'function'
	) {
		return null;
	}
	return candidate as SlimmingBridge;
}

export function createSlimmingAcknowledgementRequest(
	actionId: string,
	input: { simulatorUdids: readonly string[]; acknowledgement: string }
): SlimmingAcknowledgementRequest | null {
	if (
		input.acknowledgement !== SLIMMING_EXPERIMENTAL_ACKNOWLEDGEMENT ||
		input.simulatorUdids.length === 0 ||
		input.simulatorUdids.length > 20 ||
		new Set(input.simulatorUdids).size !== input.simulatorUdids.length
	) {
		return null;
	}
	return {
		actionId,
		simulatorUdids: [...input.simulatorUdids],
		acknowledgement: SLIMMING_EXPERIMENTAL_ACKNOWLEDGEMENT,
	};
}

type ConfirmedSlimmingSettingRequest =
	| { confirmed: true; request: SlimmingSettingRequest }
	| { confirmed: false; error: string };

export async function confirmSlimmingSettingRequest(
	bridge: Pick<SlimmingBridge, 'requestSlimmingConfirmation'>,
	request: SlimmingSettingRequest
): Promise<ConfirmedSlimmingSettingRequest> {
	if (request.enabled || request.disposition === 'leave-overrides-in-place') {
		return { confirmed: true, request };
	}
	let confirmation: Awaited<
		ReturnType<SlimmingBridge['requestSlimmingConfirmation']>
	>;
	try {
		confirmation = await bridge.requestSlimmingConfirmation(request);
	} catch (error) {
		return { confirmed: false, error: errorText(error) };
	}
	if (confirmation.actionId !== request.actionId) {
		return {
			confirmed: false,
			error:
				'Native confirmation returned a mismatched Slimming action identifier.',
		};
	}
	if (!confirmation.confirmed) {
		return {
			confirmed: false,
			error:
				confirmation.error ??
				'Restore-and-disable was cancelled by the operator.',
		};
	}
	if (confirmation.required && !confirmation.token) {
		return {
			confirmed: false,
			error: 'Native confirmation did not issue a valid Slimming token.',
		};
	}
	return {
		confirmed: true,
		request: confirmation.required
			? { ...request, confirmationToken: confirmation.token }
			: request,
	};
}

export function SlimmingRuntimeProvider({ children }: { children: ReactNode }) {
	const bridge = useMemo(slimmingBridge, []);
	const [state, setState] = useState<SlimmingState>(EMPTY_SLIMMING_STATE);
	const [isLoading, setIsLoading] = useState(Boolean(bridge));
	const [runtimeError, setRuntimeError] = useState<string | null>(() =>
		bridge
			? null
			: 'Simulator Slimming requires the signed native helper and secure desktop bridge.'
	);
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

	const pendingActionRef = useRef<string | null>(null);
	const pendingSettingRef = useRef<string | null>(null);
	const pendingAcknowledgementRef = useRef<string | null>(null);

	useEffect(() => {
		if (!bridge) return;
		let active = true;
		let unsubscribe = () => {};
		try {
			unsubscribe = bridge.subscribeSlimmingState((nextState) => {
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
			.getSlimmingState()
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

	const refresh = useCallback(async () => {
		if (!bridge) {
			setRuntimeError('Slimming refresh requires the secure desktop bridge.');
			return;
		}
		setIsLoading(true);
		try {
			const nextState = await bridge.refreshSlimming();
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

	const setEnabled = useCallback(
		async (input: SlimmingSettingInput) => {
			const actionId = nextActionId('slimming');
			if (!bridge) {
				setActionStatus({
					kind: 'error',
					message:
						'The experimental mutation setting requires the secure bridge.',
				});
				return;
			}
			if (pendingSettingRef.current) {
				setActionStatus({
					kind: 'error',
					message:
						'Another Slimming setting change is already being submitted.',
				});
				return;
			}
			const request = { ...input, actionId } as SlimmingSettingRequest;
			pendingSettingRef.current = actionId;
			setSubmittedJobId(null);
			setActionStatus({
				kind: 'pending',
				message: input.enabled
					? 'Enabling experimental Simulator mutations…'
					: input.disposition === 'restore-and-verify'
						? 'Confirming restore and verification before disabling…'
						: 'Disabling while leaving managed overrides in place…',
			});
			try {
				const confirmed = await confirmSlimmingSettingRequest(bridge, request);
				if (!confirmed.confirmed) {
					setActionStatus({ kind: 'error', message: confirmed.error });
					return;
				}
				const receipt: SlimmingSettingReceipt = await bridge.setSlimmingEnabled(
					confirmed.request
				);
				if (receipt.actionId !== actionId) {
					setActionStatus({
						kind: 'error',
						message:
							'Slimming setting provider returned a mismatched action identifier.',
					});
					return;
				}
				if (!receipt.accepted) {
					setActionStatus({
						kind: 'error',
						message:
							receipt.error ?? 'The Slimming setting change was rejected.',
					});
					return;
				}
				setState((current) =>
					receipt.state.revision >= current.revision ? receipt.state : current
				);
				if (receipt.jobId) setSubmittedJobId(receipt.jobId);
				setActionStatus({
					kind: receipt.jobId ? 'pending' : 'success',
					message: receipt.jobId
						? 'Restoring services before disabling SimSlim…'
						: receipt.state.setting.experimentalMutationsEnabled
							? 'SimSlim enabled.'
							: receipt.state.setting.disabledDisposition ===
									'left-overrides-in-place'
								? 'SimSlim disabled. Managed services remain changed.'
								: 'SimSlim disabled.',
				});
			} catch (error) {
				setActionStatus({ kind: 'error', message: errorText(error) });
			} finally {
				if (pendingSettingRef.current === actionId)
					pendingSettingRef.current = null;
			}
		},
		[bridge]
	);

	const acknowledgeCompatibility = useCallback(
		async (input: {
			simulatorUdids: string[];
			acknowledgement: string;
		}): Promise<{ accepted: boolean; error?: string }> => {
			const actionId = nextActionId('slimming');
			const request = createSlimmingAcknowledgementRequest(actionId, input);
			if (!request) {
				const error =
					'Type EXPERIMENTAL exactly for one bounded set of unique Simulator targets.';
				setActionStatus({ kind: 'error', message: error });
				return { accepted: false, error };
			}
			if (!bridge) {
				const error =
					'Compatibility acknowledgement requires the secure bridge.';
				setActionStatus({ kind: 'error', message: error });
				return { accepted: false, error };
			}
			if (pendingAcknowledgementRef.current) {
				const error =
					'Another compatibility acknowledgement is being submitted.';
				setActionStatus({ kind: 'error', message: error });
				return { accepted: false, error };
			}
			pendingAcknowledgementRef.current = actionId;
			setSubmittedJobId(null);
			setActionStatus({
				kind: 'pending',
				message: 'Verifying and acknowledging the current compatibility tuple…',
			});
			try {
				const receipt = await bridge.acknowledgeSlimmingCompatibility(request);
				if (receipt.actionId !== actionId) {
					const error =
						'Compatibility acknowledgement returned a mismatched action identifier.';
					setActionStatus({ kind: 'error', message: error });
					return { accepted: false, error };
				}
				setState((current) =>
					receipt.state.revision >= current.revision ? receipt.state : current
				);
				setActionStatus(
					receipt.accepted
						? {
								kind: 'success',
								message: 'Current compatibility tuple acknowledged.',
							}
						: {
								kind: 'error',
								message:
									receipt.error ??
									'Compatibility acknowledgement was rejected.',
							}
				);
				return {
					accepted: receipt.accepted,
					...(receipt.error ? { error: receipt.error } : {}),
				};
			} catch (error) {
				const message = errorText(error);
				setActionStatus({ kind: 'error', message });
				return { accepted: false, error: message };
			} finally {
				if (pendingAcknowledgementRef.current === actionId) {
					pendingAcknowledgementRef.current = null;
				}
			}
		},
		[bridge]
	);

	const runAction = useCallback(
		async (
			actionInput: SlimmingActionInput,
			messages: SlimmingActionMessages = {}
		): Promise<SlimmingActionReceipt> => {
			const actionId = nextActionId('slimming');
			if (!bridge) {
				const error = 'Slimming actions require the secure desktop bridge.';
				setActionStatus({ kind: 'error', message: error });
				return { actionId, accepted: false, error };
			}
			if (pendingActionRef.current) {
				const error = 'Another Slimming action is already being submitted.';
				setActionStatus({ kind: 'error', message: error });
				return { actionId, accepted: false, error };
			}
			let action = { ...actionInput, actionId } as SlimmingAction;
			pendingActionRef.current = actionId;
			setSubmittedJobId(null);
			setActionStatus({
				kind: 'pending',
				message: messages.pendingMessage ?? 'Submitting Slimming action…',
			});
			try {
				const confirmation = await bridge.requestSlimmingConfirmation(action);
				if (!confirmation.confirmed) {
					const error =
						confirmation.error ?? 'Action cancelled by the operator.';
					if (pendingActionRef.current === actionId) {
						setActionStatus({ kind: 'error', message: error });
					}
					return { actionId, accepted: false, error };
				}
				if (confirmation.required) {
					if (!confirmation.token) {
						const error =
							'Native confirmation did not issue a valid Slimming token.';
						if (pendingActionRef.current === actionId) {
							setActionStatus({ kind: 'error', message: error });
						}
						return { actionId, accepted: false, error };
					}
					action = { ...action, confirmationToken: confirmation.token };
				}
				const receipt = await bridge.runSlimmingAction(action);
				if (receipt.accepted && receipt.jobId) setSubmittedJobId(receipt.jobId);
				if (pendingActionRef.current === actionId) {
					setActionStatus(
						receipt.accepted
							? {
									kind: receipt.jobId ? 'pending' : 'success',
									message: receipt.jobId
										? 'SimSlim job queued…'
										: (messages.successMessage ?? 'Action accepted.'),
								}
							: {
									kind: 'error',
									message: receipt.error ?? 'The Slimming action was rejected.',
								}
					);
				}
				return receipt;
			} catch (error) {
				const message = errorText(error);
				if (pendingActionRef.current === actionId) {
					setActionStatus({ kind: 'error', message });
				}
				return { actionId, accepted: false, error: message };
			} finally {
				if (pendingActionRef.current === actionId)
					pendingActionRef.current = null;
			}
		},
		[bridge]
	);

	const cancelJob = useCallback(
		async (jobId: string) => {
			if (!bridge) return false;
			try {
				const cancelled = await bridge.cancelSlimmingJob(jobId);
				setActionStatus(
					cancelled
						? { kind: 'success', message: 'Slimming job cancelled.' }
						: {
								kind: 'error',
								message: 'The Slimming job could not be cancelled.',
							}
				);
				return cancelled;
			} catch (error) {
				setActionStatus({ kind: 'error', message: errorText(error) });
				return false;
			}
		},
		[bridge]
	);

	const clearActionStatus = useCallback(() => {
		setSubmittedJobId(null);
		setActionStatus({ kind: 'idle', message: '' });
	}, []);

	const value = useMemo<SlimmingRuntimeValue>(
		() => ({
			state,
			isLoading,
			isBridgeAvailable: Boolean(bridge),
			runtimeError,
			actionStatus,
			clearActionStatus,
			refresh,
			setEnabled,
			acknowledgeCompatibility,
			runAction,
			cancelJob,
		}),
		[
			actionStatus,
			acknowledgeCompatibility,
			bridge,
			cancelJob,
			clearActionStatus,
			isLoading,
			refresh,
			runAction,
			runtimeError,
			setEnabled,
			state,
		]
	);

	return (
		<SlimmingRuntimeContext.Provider value={value}>
			{children}
		</SlimmingRuntimeContext.Provider>
	);
}

export function useSlimmingRuntime(): SlimmingRuntimeValue {
	const value = useContext(SlimmingRuntimeContext);
	if (!value) {
		throw new Error(
			'useSlimmingRuntime must be used inside SlimmingRuntimeProvider.'
		);
	}
	return value;
}

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
	nextActionId,
	type WithoutActionId,
} from '@/lib/runtime-action';
import {
	DEFAULT_LANE_ENVIRONMENTS,
	type LaneBridge,
	type LaneOperation,
	type LaneOperationReceipt,
	type LaneState,
} from '../../shared/lane-protocol';

/**
 * The run that put a notice up, and the operation it ran: its kind and the
 * lane, worktree, device request or repository it acts on. Runs that share
 * a subject are retries of one operation.
 */
type LaneNoticeOwner = Readonly<{ actionId: string; subject: string }>;

/** The shared Lanes notice and the run that put it up, if any. */
type LaneNotice = Readonly<{
	status: ActionStatus;
	owner: LaneNoticeOwner | null;
}>;

const IDLE_NOTICE: LaneNotice = {
	status: { kind: 'idle', message: '' },
	owner: null,
};

function laneOperationSubject(operation: LaneOperation): string {
	switch (operation.kind) {
		case 'lane.start':
			return `${operation.kind}:${operation.worktreePath}`;
		case 'lane.provide-device':
			return `${operation.kind}:${operation.requestId}`;
		case 'lane.launch':
		case 'lane.stop':
		case 'lane.log':
			return `${operation.kind}:${operation.laneId}`;
		case 'lane.remove-repository':
			return `${operation.kind}:${operation.repositoryRoot}`;
		case 'lane.refresh':
		case 'lane.add-repository':
			return operation.kind;
	}
}

export function laneNoticeOwner(operation: LaneOperation): LaneNoticeOwner {
	return {
		actionId: operation.actionId,
		subject: laneOperationSubject(operation),
	};
}

/**
 * The notice once a run settles. A failure or an explicit success takes it.
 * Anything else, a cancel included, clears only a notice no operation owns
 * (such as a failed first load), this run's own progress, or the outcome an
 * earlier run of the same operation left. So reading the Metro log never
 * wipes the launch error it is meant to explain, while a retry that works
 * clears the error of the attempt it replaces.
 */
export function settleLaneNotice(
	notice: LaneNotice,
	operation: LaneOperation,
	receipt: Pick<LaneOperationReceipt, 'completed' | 'cancelled' | 'error'>,
	successMessage?: string
): LaneNotice {
	const owner = laneNoticeOwner(operation);
	if (!receipt.cancelled && !receipt.completed) {
		return {
			status: {
				kind: 'error',
				message: receipt.error ?? 'The lane operation did not complete.',
			},
			owner,
		};
	}
	if (!receipt.cancelled && successMessage) {
		return { status: { kind: 'success', message: successMessage }, owner };
	}
	const current = notice.owner;
	const replaced =
		current === null ||
		current.actionId === owner.actionId ||
		// Another run's progress stays up until that run settles itself.
		(notice.status.kind !== 'pending' && current.subject === owner.subject);
	return replaced ? IDLE_NOTICE : notice;
}

type LaneOperationInput = WithoutActionId<LaneOperation>;

/**
 * Where another panel sends the operator in Lanes: a lane by id (a bare
 * string), or the Agents view, optionally at one session's card, keyed
 * `kind:sessionId` like agentSessionKey.
 */
export type LaneFocusTarget =
	| string
	| Readonly<{ view: 'lanes'; laneId?: string }>
	| Readonly<{ view: 'agents'; sessionKey?: string }>;

/** A focus request the Lanes panel applies once, then reports handled. */
type LaneFocusRequest = Readonly<{
	view: 'lanes' | 'agents';
	laneId?: string;
	sessionKey?: string;
	nonce: number;
}>;

export function laneFocusRequest(
	target: LaneFocusTarget,
	nonce: number
): LaneFocusRequest {
	if (typeof target === 'string') {
		return { view: 'lanes', laneId: target, nonce };
	}
	if (target.view === 'agents') {
		return {
			view: 'agents',
			...(target.sessionKey === undefined
				? {}
				: { sessionKey: target.sessionKey }),
			nonce,
		};
	}
	return {
		view: 'lanes',
		...(target.laneId === undefined ? {} : { laneId: target.laneId }),
		nonce,
	};
}

/**
 * What the Lanes panel does with a pending request: wait for the first lane
 * state when it names a lane not listed yet, or apply it. A lane that is gone
 * by then still opens Lanes, on its default selection.
 */
export function resolveLaneFocus(
	request: LaneFocusRequest,
	lanes: readonly Readonly<{ id: string }>[],
	isLoading: boolean
):
	| Readonly<{ kind: 'wait' }>
	| Readonly<{
			kind: 'apply';
			view: 'lanes' | 'agents';
			laneId?: string;
			sessionKey?: string;
	  }> {
	if (request.view === 'agents') {
		return {
			kind: 'apply',
			view: 'agents',
			...(request.sessionKey === undefined
				? {}
				: { sessionKey: request.sessionKey }),
		};
	}
	const listed =
		request.laneId !== undefined &&
		lanes.some((lane) => lane.id === request.laneId);
	if (request.laneId !== undefined && !listed && isLoading) {
		return { kind: 'wait' };
	}
	return {
		kind: 'apply',
		view: 'lanes',
		...(listed && request.laneId !== undefined
			? { laneId: request.laneId }
			: {}),
	};
}

type LaneRuntimeValue = {
	state: LaneState;
	isLoading: boolean;
	isBridgeAvailable: boolean;
	/** Operation kind currently in flight, or null. */
	pendingOperation: LaneOperation['kind'] | null;
	actionStatus: ActionStatus;
	clearActionStatus: () => void;
	refresh: () => Promise<void>;
	runOperation: (
		operation: LaneOperationInput,
		messages?: { pendingMessage?: string; successMessage?: string }
	) => Promise<LaneOperationReceipt | undefined>;
	laneForSimulator: (udid: string) => LaneState['lanes'][number] | undefined;
	/** The latest request to show a lane or an Agents card, until handled. */
	focus: LaneFocusRequest | null;
	/**
	 * Opens Lanes at a lane, or the Agents view at a session's card, and
	 * navigates to `#simulator/lanes`.
	 */
	focusLane: (target: LaneFocusTarget) => void;
	/** The Lanes panel applied the request with this nonce. */
	focusHandled: (nonce: number) => void;
};

const EMPTY_LANE_STATE: LaneState = {
	revision: 0,
	updatedAt: 0,
	environments: [...DEFAULT_LANE_ENVIRONMENTS],
	lanes: [],
	worktrees: [],
	repositories: [],
	deviceRequests: [],
};

const LaneRuntimeContext = createContext<LaneRuntimeValue | null>(null);

function laneBridge(): LaneBridge | null {
	const candidate = window.rnDevtools as
		| (NonNullable<typeof window.rnDevtools> & Partial<LaneBridge>)
		| undefined;
	if (
		!candidate ||
		typeof candidate.getLaneState !== 'function' ||
		typeof candidate.subscribeLaneState !== 'function' ||
		typeof candidate.runLaneOperation !== 'function'
	) {
		return null;
	}
	return candidate as LaneBridge;
}

export function LaneRuntimeProvider({ children }: { children: ReactNode }) {
	const bridge = useMemo(laneBridge, []);
	const [state, setState] = useState<LaneState>(EMPTY_LANE_STATE);
	const [isLoading, setIsLoading] = useState(Boolean(bridge));
	const [pendingOperation, setPendingOperation] = useState<
		LaneOperation['kind'] | null
	>(null);
	const [notice, setNotice] = useState<LaneNotice>(IDLE_NOTICE);

	useEffect(() => {
		if (!bridge) return;
		let active = true;
		let unsubscribe = () => {};
		try {
			unsubscribe = bridge.subscribeLaneState((next) => {
				if (active) setState(next);
			});
		} catch (error) {
			setNotice({
				status: { kind: 'error', message: errorText(error) },
				owner: null,
			});
		}
		void bridge
			.getLaneState()
			.then((next) => {
				if (active) setState(next);
			})
			.catch((error: unknown) => {
				if (active) {
					setNotice({
						status: { kind: 'error', message: errorText(error) },
						owner: null,
					});
				}
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

	const runOperation = useCallback<LaneRuntimeValue['runOperation']>(
		async (input, messages = {}) => {
			if (!bridge) {
				setNotice({
					status: {
						kind: 'error',
						message: 'Lanes require the secure desktop bridge.',
					},
					owner: null,
				});
				return undefined;
			}
			const operation = {
				...input,
				actionId: nextActionId('lane'),
			} as LaneOperation;
			setPendingOperation(operation.kind);
			if (messages.pendingMessage) {
				setNotice({
					status: { kind: 'pending', message: messages.pendingMessage },
					owner: laneNoticeOwner(operation),
				});
			}
			try {
				const receipt = await bridge.runLaneOperation(operation);
				if (receipt.state) setState(receipt.state);
				setNotice((current) =>
					settleLaneNotice(current, operation, receipt, messages.successMessage)
				);
				return receipt;
			} catch (error) {
				setNotice({
					status: { kind: 'error', message: errorText(error) },
					owner: laneNoticeOwner(operation),
				});
				return undefined;
			} finally {
				setPendingOperation(null);
			}
		},
		[bridge]
	);

	const refresh = useCallback(async () => {
		await runOperation({ kind: 'lane.refresh' });
	}, [runOperation]);

	// The Lanes panel mounts lazily and keeps its view and selection locally,
	// so a deep link waits here until the panel applies it.
	const [focus, setFocus] = useState<LaneFocusRequest | null>(null);
	const focusNonce = useRef(0);
	const focusLane = useCallback((target: LaneFocusTarget) => {
		focusNonce.current += 1;
		setFocus(laneFocusRequest(target, focusNonce.current));
		if (window.location.hash !== '#simulator/lanes') {
			window.location.hash = 'simulator/lanes';
		}
	}, []);
	const focusHandled = useCallback((nonce: number) => {
		setFocus((current) => (current?.nonce === nonce ? null : current));
	}, []);

	const value = useMemo<LaneRuntimeValue>(
		() => ({
			state,
			isLoading,
			isBridgeAvailable: Boolean(bridge),
			pendingOperation,
			actionStatus: notice.status,
			clearActionStatus: () => setNotice(IDLE_NOTICE),
			refresh,
			runOperation,
			laneForSimulator: (udid) =>
				state.lanes.find(
					(lane) => lane.simulatorUdid.toUpperCase() === udid.toUpperCase()
				),
			focus,
			focusLane,
			focusHandled,
		}),
		[
			state,
			isLoading,
			bridge,
			pendingOperation,
			notice.status,
			refresh,
			runOperation,
			focus,
			focusLane,
			focusHandled,
		]
	);

	return (
		<LaneRuntimeContext.Provider value={value}>
			{children}
		</LaneRuntimeContext.Provider>
	);
}

export function useLaneRuntime(): LaneRuntimeValue {
	const value = useContext(LaneRuntimeContext);
	if (!value) {
		throw new Error('useLaneRuntime must be used inside LaneRuntimeProvider.');
	}
	return value;
}

import { diagnosticErrorText } from '@rndevtools/core/redact';
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from 'react';
import type {
	AgentBridge,
	AgentOperation,
	AgentState,
	DeviceAgent,
} from '../../shared/agent-protocol';
import type { DeviceHold } from '../../shared/device-hold';

type AgentRuntimeValue = {
	state: AgentState;
	isLoading: boolean;
	isBridgeAvailable: boolean;
	error: string | null;
	refresh: () => Promise<void>;
	runOperation: (operation: AgentOperation) => Promise<boolean>;
	/** Agents attached to a Simulator, strongest signal first. */
	agentsForSimulator: (udid: string) => readonly DeviceAgent[];
	/** The hold on a Simulator, if any: who has it and whether they are still around. */
	holdForSimulator: (udid: string) => DeviceHold | undefined;
};

const EMPTY_AGENT_STATE: AgentState = {
	revision: 0,
	updatedAt: 0,
	sessions: [],
	byDevice: {},
	claims: [],
	holds: {},
	discovery: { claude: 'unavailable', codex: 'unavailable' },
};
const NO_AGENTS: readonly DeviceAgent[] = [];

const AgentRuntimeContext = createContext<AgentRuntimeValue | null>(null);

function agentBridge(): AgentBridge | null {
	const candidate = window.rnDevtools as
		| (NonNullable<typeof window.rnDevtools> & Partial<AgentBridge>)
		| undefined;
	if (
		!candidate ||
		typeof candidate.getAgentState !== 'function' ||
		typeof candidate.subscribeAgentState !== 'function' ||
		typeof candidate.runAgentOperation !== 'function'
	) {
		return null;
	}
	return candidate as AgentBridge;
}

export function AgentRuntimeProvider({ children }: { children: ReactNode }) {
	const bridge = useMemo(agentBridge, []);
	const [state, setState] = useState<AgentState>(EMPTY_AGENT_STATE);
	const [isLoading, setIsLoading] = useState(Boolean(bridge));
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!bridge) return;
		let active = true;
		let unsubscribe = () => {};
		try {
			unsubscribe = bridge.subscribeAgentState((next) => {
				if (active) setState(next);
			});
		} catch (caught) {
			setError(diagnosticErrorText(caught));
		}
		void bridge
			.getAgentState()
			.then((next) => {
				if (active) setState(next);
			})
			.catch((caught: unknown) => {
				if (active) setError(diagnosticErrorText(caught));
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

	const runOperation = useCallback<AgentRuntimeValue['runOperation']>(
		async (operation) => {
			if (!bridge) {
				setError('Agents require the secure desktop bridge.');
				return false;
			}
			try {
				setState(await bridge.runAgentOperation(operation));
				setError(null);
				return true;
			} catch (caught) {
				setError(diagnosticErrorText(caught));
				return false;
			}
		},
		[bridge]
	);

	const refresh = useCallback(async () => {
		await runOperation({ kind: 'agent.refresh' });
	}, [runOperation]);

	const value = useMemo<AgentRuntimeValue>(
		() => ({
			state,
			isLoading,
			isBridgeAvailable: Boolean(bridge),
			error,
			refresh,
			runOperation,
			agentsForSimulator: (udid) =>
				state.byDevice[udid.toUpperCase()] ?? NO_AGENTS,
			holdForSimulator: (udid) => state.holds[udid.toUpperCase()],
		}),
		[state, isLoading, bridge, error, refresh, runOperation]
	);
	return (
		<AgentRuntimeContext.Provider value={value}>
			{children}
		</AgentRuntimeContext.Provider>
	);
}

export function useAgentRuntime(): AgentRuntimeValue {
	const value = useContext(AgentRuntimeContext);
	if (!value) {
		throw new Error(
			'useAgentRuntime must be used inside AgentRuntimeProvider.'
		);
	}
	return value;
}

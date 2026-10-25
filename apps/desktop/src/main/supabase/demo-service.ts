import {
	applySupabaseDemoOperation,
	createSupabaseDemoState,
	supabaseDemoInspection,
} from '../../shared/supabase-demo-data';
import {
	EMPTY_SUPABASE_STATE,
	type SupabaseInterest,
	type SupabaseState,
	supabaseActivityStats,
	supabaseAgentRecovery,
} from '../../shared/supabase-protocol';
import { AgentCliError } from '../agent-cli-service';
import type { SupabaseServiceApi, SupabaseServiceDeps } from './service-ports';

/**
 * Demo mode (an unpackaged build started with RNDEVTOOLS_DEMO=true): the
 * demo stacks served from memory, through the same reducer the renderer's
 * e2e drives. It runs no processes, reads nothing from disk, writes no
 * steering file and touches no lane, agent, dialog, shell or clipboard port.
 * The state and the reducer read one clock, so stack timestamps and
 * updatedAt stay coherent after operations.
 */

const DEMO_TEXT = 'RN Devtools is showing demo stacks; nothing runs.';

export function createSupabaseDemoService(
	deps: Pick<SupabaseServiceDeps, 'now'>,
	platform: SupabaseState['availability']['platform']
): SupabaseServiceApi {
	const now = deps.now ?? Date.now;
	const listeners = new Set<(state: SupabaseState) => void>();
	const interests = new Map<string, SupabaseInterest>();
	let state = createSupabaseDemoState({ now: now() });
	const publish = () => {
		for (const listener of [...listeners]) {
			try {
				listener(state);
			} catch {
				// A subscriber must not fail the operation that changed the state.
			}
		}
	};
	// As in live mode, only the stack a window inspects gets its services.
	const inspect = (next: SupabaseState): SupabaseState => {
		const stackId = [...interests.values()].find(
			(interest) => interest.view === 'stacks' && interest.inspectStackId
		)?.inspectStackId;
		const { inspection: _previous, ...rest } = next;
		const inspection =
			stackId === undefined
				? undefined
				: supabaseDemoInspection(next, stackId, now());
		return inspection === undefined ? rest : { ...rest, inspection };
	};
	return {
		getState: () => state,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		runOperation: async (operation) => {
			const result = applySupabaseDemoOperation(state, operation, now());
			if (result.state !== state) {
				state = inspect(result.state);
				publish();
			}
			return result.receipt.state
				? { ...result.receipt, state }
				: result.receipt;
		},
		// The demo confirms without a dialog.
		describeConfirmation: async () => undefined,
		setInterest: (senderKey, interest) => {
			interests.set(senderKey, interest);
			const before = state.inspection;
			const next = inspect(state);
			if (
				next.inspection?.stackId === before?.stackId &&
				(next.inspection === undefined) === (before === undefined)
			) {
				return;
			}
			state = { ...next, revision: state.revision + 1 };
			publish();
		},
		ensureForLane: async (input) => ({
			summary: {
				policy: input.policy,
				status: 'skipped',
				reason: input.policy === 'off' ? 'off' : 'disabled',
				appEnvNames: [],
				warnings: [],
				reasonText:
					input.policy === 'off'
						? 'The backend is off for this lane.'
						: DEMO_TEXT,
			},
		}),
		detachLane: () => undefined,
		describeWorktree: () => undefined,
		runAgentOperation: async () => {
			throw new AgentCliError({
				code: 'supabase_disabled',
				message: DEMO_TEXT,
				recovery: supabaseAgentRecovery('supabase_disabled'),
			});
		},
		releaseHolder: async () => ({ releasedStackIds: [], pendingStops: [] }),
		job: () => undefined,
		waitForJob: async () => undefined,
		doctor: () => ({
			enabled: false,
			capability: platform.supported ? 'off' : 'unsupported',
			platform,
			repositories: [],
			running: 0,
			cap: EMPTY_SUPABASE_STATE.capacity.cap,
			sysv: null,
			containerEngine: { docker: 'absent', podman: 'absent' },
			stats: supabaseActivityStats([]),
			warnings: [DEMO_TEXT],
		}),
		holderKeys: () => [],
		steering: () => ({
			enabled: false,
			desktopPid: process.pid,
			writtenAt: now(),
			managedRoots: [],
		}),
		start: async () => undefined,
		stop: async () => undefined,
	};
}

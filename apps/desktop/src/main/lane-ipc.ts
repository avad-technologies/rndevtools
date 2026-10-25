import type { IpcMainInvokeEvent } from 'electron';
import {
	type LaneOperation,
	type LaneOperationReceipt,
	type LaneState,
	laneOperationReceiptSchema,
	laneOperationSchema,
	laneStateSchema,
} from '../shared/lane-protocol';
import { safeErrorText } from './security';

type LaneIpcService = {
	getState: () => LaneState;
	runOperation: (
		operation: LaneOperation,
		signal?: AbortSignal
	) => Promise<LaneOperationReceipt>;
	addRepository: (root: string) => Promise<LaneState>;
};

type LaneIpcDependencies = {
	service: LaneIpcService;
	assertTrustedRenderer: (event: IpcMainInvokeEvent) => void;
	/** Native folder picker; the renderer never names a path on its own. */
	selectRepository: (event: IpcMainInvokeEvent) => Promise<string | undefined>;
};

/**
 * Whether `worktreePath` is one main discovered: a listed worktree or a
 * registered repository root, matched exactly. A directory inside one, or a
 * path that only resolves to one, is not.
 */
function isDiscoveredWorktree(state: LaneState, worktreePath: string): boolean {
	return (
		state.worktrees.some((worktree) => worktree.path === worktreePath) ||
		state.repositories.includes(worktreePath)
	);
}

/**
 * Lane IPC. Every other lane operation names a lane id or a worktree the
 * service already discovered, and a lane.start naming any other path is
 * refused here; the one path the renderer can introduce — a new repository
 * root — comes from a dialog owned by the main process. Agent CLI starts do
 * not come through here.
 *
 * The start form's backend choice (auto, off, required) travels as the
 * schema validated it; the service resolves an omitted one from the
 * environment's default.
 */
export function createLaneIpcHandlers({
	service,
	assertTrustedRenderer,
	selectRepository,
}: LaneIpcDependencies) {
	return {
		getState: (event: IpcMainInvokeEvent): LaneState => {
			assertTrustedRenderer(event);
			return laneStateSchema.parse(service.getState());
		},
		runOperation: async (
			event: IpcMainInvokeEvent,
			value: unknown
		): Promise<LaneOperationReceipt> => {
			assertTrustedRenderer(event);
			const operation = laneOperationSchema.parse(value);
			if (
				operation.kind === 'lane.start' &&
				!isDiscoveredWorktree(service.getState(), operation.worktreePath)
			) {
				return laneOperationReceiptSchema.parse({
					actionId: operation.actionId,
					kind: operation.kind,
					completed: false,
					error: `${operation.worktreePath} is not a worktree RN Devtools discovered. Add its repository from the Lanes panel, then pick the worktree from the list.`,
				});
			}
			if (operation.kind !== 'lane.add-repository') {
				return service.runOperation(operation);
			}
			try {
				const selected = await selectRepository(event);
				if (!selected) {
					return laneOperationReceiptSchema.parse({
						actionId: operation.actionId,
						kind: operation.kind,
						completed: false,
						cancelled: true,
					});
				}
				const state = await service.addRepository(selected);
				return laneOperationReceiptSchema.parse({
					actionId: operation.actionId,
					kind: operation.kind,
					completed: true,
					state,
				});
			} catch (error) {
				return laneOperationReceiptSchema.parse({
					actionId: operation.actionId,
					kind: operation.kind,
					completed: false,
					error: safeErrorText(error),
				});
			}
		},
	};
}

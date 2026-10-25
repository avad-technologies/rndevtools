import { describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_LANE_ENVIRONMENTS,
	type Lane,
	type LaneState,
} from '../shared/lane-protocol';
import { createLaneIpcHandlers } from './lane-ipc';

const UDID = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
const pendingLane: Lane = {
	id: 'lane-11111111-2222-4333-8444-555555555555',
	worktreePath: '/Users/dev/app-feature',
	branch: 'feature',
	simulatorUdid: UDID,
	environment: 'development',
	port: 8_100,
	metro: 'ready',
	logPath: '/Users/dev/lane.log',
	startedAt: 1,
	slim: {
		profileId: 'rndevtools-development',
		status: 'applied',
		updatedAt: 1,
	},
};
const state: LaneState = {
	revision: 1,
	updatedAt: 1,
	environments: [...DEFAULT_LANE_ENVIRONMENTS],
	lanes: [pendingLane],
	worktrees: [
		{
			path: '/Users/dev/app-feature',
			branch: 'feature',
			repositoryRoot: '/Users/dev/app',
			dirty: false,
		},
	],
	repositories: ['/Users/dev/app'],
	deviceRequests: [],
};

function fixture(selected: string | null = '/Users/dev/app') {
	const service = {
		getState: vi.fn(() => state),
		runOperation: vi.fn(
			async (operation: { actionId: string; kind: string }) => ({
				actionId: operation.actionId,
				kind: operation.kind as 'lane.refresh',
				completed: true,
				state,
			})
		),
		addRepository: vi.fn(async () => state),
	};
	const assertTrustedRenderer = vi.fn();
	const selectRepository = vi.fn(async () => selected ?? undefined);
	const handlers = createLaneIpcHandlers({
		service,
		assertTrustedRenderer,
		selectRepository,
	});
	return {
		service,
		assertTrustedRenderer,
		selectRepository,
		handlers,
	};
}

describe('Lane IPC', () => {
	it('checks the renderer and validates the state it returns', () => {
		const { assertTrustedRenderer, handlers } = fixture();
		expect(handlers.getState({} as never)).toEqual(state);
		expect(assertTrustedRenderer).toHaveBeenCalledOnce();
	});

	it('rejects malformed operations before they reach the service', async () => {
		const { service, handlers } = fixture();
		await expect(
			handlers.runOperation({} as never, {
				actionId: 'op-1',
				kind: 'lane.start',
				worktreePath: '../escape',
				simulatorUdid: 'nope',
			})
		).rejects.toThrow();
		expect(service.runOperation).not.toHaveBeenCalled();
	});

	it('forwards ordinary operations to the service', async () => {
		const { service, handlers } = fixture();
		const receipt = await handlers.runOperation({} as never, {
			actionId: 'op-1',
			kind: 'lane.refresh',
		});
		expect(service.runOperation).toHaveBeenCalledWith(
			expect.objectContaining({ kind: 'lane.refresh' })
		);
		expect(receipt).toMatchObject({ completed: true });
	});

	it('resolves repository selection through the main-owned dialog', async () => {
		const { service, selectRepository, handlers } = fixture();
		const receipt = await handlers.runOperation({} as never, {
			actionId: 'op-2',
			kind: 'lane.add-repository',
		});
		expect(selectRepository).toHaveBeenCalledOnce();
		expect(service.addRepository).toHaveBeenCalledWith('/Users/dev/app');
		expect(service.runOperation).not.toHaveBeenCalled();
		expect(receipt).toMatchObject({ completed: true, state });
	});

	it('returns a typed cancellation when the dialog is dismissed', async () => {
		const { service, handlers } = fixture(null);
		await expect(
			handlers.runOperation({} as never, {
				actionId: 'op-3',
				kind: 'lane.add-repository',
			})
		).resolves.toMatchObject({ completed: false, cancelled: true });
		expect(service.addRepository).not.toHaveBeenCalled();
	});

	it('reports a non-repository selection as a redacted error', async () => {
		const { service, handlers } = fixture('/Users/dev/not-a-repo');
		service.addRepository.mockRejectedValueOnce(
			new Error('/Users/dev/not-a-repo is not inside a git repository.')
		);
		const receipt = await handlers.runOperation({} as never, {
			actionId: 'op-4',
			kind: 'lane.add-repository',
		});
		expect(receipt.completed).toBe(false);
		expect(receipt.error).toMatch(/not inside a git repository/);
	});

	it('forwards a lane.start with a slim profile straight to the service: the desktop applies it, no dialog', async () => {
		const { service, handlers } = fixture();
		const operation = {
			actionId: 'op-slim',
			kind: 'lane.start',
			worktreePath: '/Users/dev/app-feature',
			simulatorUdid: UDID,
			environment: 'development',
			launch: true,
			slimProfileId: 'rndevtools-development',
		};
		await handlers.runOperation({} as never, operation);
		expect(service.runOperation).toHaveBeenCalledTimes(1);
		expect(service.runOperation.mock.calls[0]?.[0]).toMatchObject({
			kind: 'lane.start',
			slimProfileId: 'rndevtools-development',
		});
		// Nothing out of schema rides along: there is no approval to assert.
		expect(service.runOperation.mock.calls[0]).toHaveLength(1);
	});

	it("passes the start form's backend choice through, and refuses one that is not a policy", async () => {
		const { service, handlers } = fixture();
		await handlers.runOperation({} as never, {
			actionId: 'op-backend',
			kind: 'lane.start',
			worktreePath: '/Users/dev/app-feature',
			simulatorUdid: UDID,
			backend: 'required',
		});
		expect(service.runOperation).toHaveBeenCalledTimes(1);
		expect(service.runOperation.mock.calls[0]?.[0]).toMatchObject({
			kind: 'lane.start',
			backend: 'required',
		});
		await expect(
			handlers.runOperation({} as never, {
				actionId: 'op-docker',
				kind: 'lane.start',
				worktreePath: '/Users/dev/app-feature',
				simulatorUdid: UDID,
				backend: 'docker',
			})
		).rejects.toThrow();
		expect(service.runOperation).toHaveBeenCalledTimes(1);
	});

	it("returns each lane's backend summary with the state", () => {
		const backend = {
			policy: 'auto' as const,
			status: 'ready' as const,
			apiUrl: 'http://127.0.0.1:21734',
			appEnvNames: ['EXPO_PUBLIC_SUPABASE_URL'],
			warnings: [],
		};
		const withBackend: LaneState = {
			...state,
			lanes: [{ ...pendingLane, backend }],
		};
		const handlers = createLaneIpcHandlers({
			service: {
				getState: () => withBackend,
				runOperation: vi.fn(),
				addRepository: vi.fn(),
			},
			assertTrustedRenderer: vi.fn(),
			selectRepository: vi.fn(),
		});
		expect(handlers.getState({} as never).lanes[0]?.backend).toEqual(backend);
	});

	it('refuses a lane.start for a path main has not discovered', async () => {
		const { service, handlers } = fixture();
		for (const worktreePath of [
			'/Users/dev/elsewhere',
			// Inside a discovered worktree is still not a discovered worktree.
			'/Users/dev/app-feature/examples/demo',
			'/Users/dev/app-feature/../app-other',
		]) {
			const receipt = await handlers.runOperation({} as never, {
				actionId: 'op-unknown',
				kind: 'lane.start',
				worktreePath,
				simulatorUdid: UDID,
			});
			expect(receipt).toMatchObject({
				actionId: 'op-unknown',
				kind: 'lane.start',
				completed: false,
			});
			expect(receipt.error).toMatch(/not a worktree RN Devtools discovered/);
		}
		expect(service.runOperation).not.toHaveBeenCalled();
	});

	it('forwards a lane.start for a discovered worktree or a registered repository', async () => {
		const { service, handlers } = fixture();
		for (const worktreePath of ['/Users/dev/app-feature', '/Users/dev/app']) {
			await handlers.runOperation({} as never, {
				actionId: 'op-known',
				kind: 'lane.start',
				worktreePath,
				simulatorUdid: UDID,
			});
		}
		expect(service.runOperation).toHaveBeenCalledTimes(2);
		expect(service.runOperation).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ worktreePath: '/Users/dev/app-feature' })
		);
		expect(service.runOperation).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ worktreePath: '/Users/dev/app' })
		);
	});
});

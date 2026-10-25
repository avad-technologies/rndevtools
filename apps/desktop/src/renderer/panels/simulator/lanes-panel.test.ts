import { describe, expect, it } from 'vitest';
import {
	DEFAULT_LANE_ENVIRONMENTS,
	type Lane,
	type LaneWorktree,
} from '../../../shared/lane-protocol';
import type { SimulatorDevice } from '../../../shared/simulator-protocol';
import {
	defaultLaneWorktree,
	laneDeviceOptions,
	laneSummaryCounts,
} from './lanes-panel';

const A = 'AAAAAAAA-0000-4000-8000-000000000001';
const B = 'BBBBBBBB-0000-4000-8000-000000000002';
const C = 'CCCCCCCC-0000-4000-8000-000000000003';

function worktree(path: string, laneId?: string): LaneWorktree {
	return {
		path,
		branch: path.split('-').at(-1) ?? 'main',
		repositoryRoot: '/Users/dev/app',
		dirty: false,
		...(laneId ? { laneId } : {}),
	};
}

function device(
	udid: string,
	name: string,
	state: SimulatorDevice['state'],
	isAvailable = true
): SimulatorDevice {
	return {
		udid,
		name,
		state,
		isAvailable,
		runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
	};
}

function lane(udid: string, branch: string): Lane {
	return {
		id: `lane-${udid.slice(0, 8).toLowerCase()}-0000-4000-8000-000000000000`,
		worktreePath: `/Users/dev/app-${branch}`,
		branch,
		simulatorUdid: udid,
		environment: 'development',
		port: 8_100,
		metro: 'ready',
		logPath: '/Users/dev/lane.log',
		startedAt: 1,
	};
}

describe('defaultLaneWorktree', () => {
	it('preselects the first worktree without a lane, falling back to the first', () => {
		const busy = lane(A, 'a');
		expect(
			defaultLaneWorktree([
				worktree('/Users/dev/app-a', busy.id),
				worktree('/Users/dev/app-b'),
			])
		).toBe('/Users/dev/app-b');
		expect(defaultLaneWorktree([worktree('/Users/dev/app-a', busy.id)])).toBe(
			'/Users/dev/app-a'
		);
		expect(defaultLaneWorktree([])).toBe('');
	});
});

describe('laneDeviceOptions', () => {
	it('lists booted devices first and disables devices another lane owns', () => {
		const options = laneDeviceOptions(
			[
				device(A, 'Zed', 'shutdown'),
				device(B, 'Alpha', 'booted'),
				device(C, 'Gone', 'shutdown', false),
			],
			[lane(A.toLowerCase(), 'feature')]
		);
		expect(options.map((option) => option.device.name)).toEqual([
			'Alpha',
			'Zed',
		]);
		expect(options[0]?.disabledReason).toBeUndefined();
		expect(options[1]?.disabledReason).toBe('lane feature');
	});
});

describe('laneSummaryCounts', () => {
	it('counts lanes, ready Metros, attached agents, and worktrees', () => {
		const counts = laneSummaryCounts({
			revision: 1,
			updatedAt: 1,
			environments: [...DEFAULT_LANE_ENVIRONMENTS],
			lanes: [
				lane(A, 'a'),
				{
					...lane(B, 'b'),
					metro: 'starting',
					agent: { kind: 'claude', sessionId: 's', lastSeenAt: 1 },
				},
			],
			worktrees: [worktree('/Users/dev/app-a'), worktree('/Users/dev/app-b')],
			repositories: ['/Users/dev/app'],
			deviceRequests: [],
		});
		expect(counts).toEqual({ lanes: 2, ready: 1, agents: 1, worktrees: 2 });
	});
});

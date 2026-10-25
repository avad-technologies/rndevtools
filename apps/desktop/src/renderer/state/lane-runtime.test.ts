import { describe, expect, it } from 'vitest';
import type { LaneOperation } from '../../shared/lane-protocol';
import {
	laneFocusRequest,
	laneNoticeOwner,
	resolveLaneFocus,
	settleLaneNotice,
} from './lane-runtime';

const LANE = 'lane-c69dc564-b12e-45d5-b0d5-3e9d034a072d';
const OTHER = 'lane-d3c29403-e3a7-4bc9-ab44-93684dacbc56';
const REPOSITORY = '/Users/example/ExampleApp';

describe('laneFocusRequest', () => {
	it('reads a bare id as a lane, and keeps the Agents session key', () => {
		expect(laneFocusRequest(LANE, 1)).toEqual({
			view: 'lanes',
			laneId: LANE,
			nonce: 1,
		});
		expect(
			laneFocusRequest({ view: 'agents', sessionKey: 'claude:7f3a2c91' }, 2)
		).toEqual({ view: 'agents', sessionKey: 'claude:7f3a2c91', nonce: 2 });
		expect(laneFocusRequest({ view: 'agents' }, 3)).toEqual({
			view: 'agents',
			nonce: 3,
		});
		expect(laneFocusRequest({ view: 'lanes' }, 4)).toEqual({
			view: 'lanes',
			nonce: 4,
		});
	});
});

describe('resolveLaneFocus', () => {
	const lanes = [{ id: OTHER }, { id: LANE }];

	it('selects a listed lane, not the first one', () => {
		expect(resolveLaneFocus(laneFocusRequest(LANE, 1), lanes, false)).toEqual({
			kind: 'apply',
			view: 'lanes',
			laneId: LANE,
		});
	});

	it('waits for the first lane state, then falls back to the default selection', () => {
		expect(resolveLaneFocus(laneFocusRequest(LANE, 1), [], true)).toEqual({
			kind: 'wait',
		});
		expect(resolveLaneFocus(laneFocusRequest(LANE, 1), [], false)).toEqual({
			kind: 'apply',
			view: 'lanes',
		});
		expect(
			resolveLaneFocus(laneFocusRequest(LANE, 1), [{ id: OTHER }], false)
		).toEqual({ kind: 'apply', view: 'lanes' });
	});

	it('opens the Agents view at once, at a session when one is named', () => {
		expect(
			resolveLaneFocus(
				laneFocusRequest({ view: 'agents', sessionKey: 'codex:3c9e7a12' }, 1),
				[],
				true
			)
		).toEqual({ kind: 'apply', view: 'agents', sessionKey: 'codex:3c9e7a12' });
	});
});

describe('settleLaneNotice', () => {
	const idle = { status: { kind: 'idle', message: '' }, owner: null } as const;
	// runOperation gives every run a fresh action id, retries included.
	const launch: LaneOperation = {
		kind: 'lane.launch',
		laneId: LANE,
		actionId: 'lane-1',
	};
	const readLog = (laneId: string, actionId: string): LaneOperation => ({
		kind: 'lane.log',
		laneId,
		maxCharacters: 16 * 1024,
		actionId,
	});
	const refresh = (actionId: string): LaneOperation => ({
		kind: 'lane.refresh',
		actionId,
	});
	const track = (actionId: string): LaneOperation => ({
		kind: 'lane.add-repository',
		actionId,
	});
	const untrack = (
		repositoryRoot: string,
		actionId: string
	): LaneOperation => ({
		kind: 'lane.remove-repository',
		repositoryRoot,
		actionId,
	});
	const launchFailed = settleLaneNotice(idle, launch, {
		completed: false,
		error:
			'Metro on port 8102 did not become ready within 15s. Read the lane log for the bundler error.',
	});

	it('keeps a launch error while the Metro log it points to is read', () => {
		expect(launchFailed.status.kind).toBe('error');
		expect(
			settleLaneNotice(launchFailed, readLog(LANE, 'lane-2'), {
				completed: true,
			})
		).toBe(launchFailed);
		expect(
			settleLaneNotice(launchFailed, refresh('lane-3'), {
				completed: true,
				cancelled: true,
			})
		).toBe(launchFailed);
	});

	it("clears an earlier run's error once the same operation runs again", () => {
		const trackFailed = settleLaneNotice(idle, track('lane-1'), {
			completed: false,
			error: 'git failed with exit code 128.',
		});
		expect(trackFailed.status.kind).toBe('error');
		expect(
			settleLaneNotice(trackFailed, track('lane-2'), { completed: true })
		).toEqual(idle);
		expect(
			settleLaneNotice(trackFailed, track('lane-3'), {
				completed: false,
				cancelled: true,
			})
		).toEqual(idle);

		const untrackFailed = settleLaneNotice(
			idle,
			untrack(REPOSITORY, 'lane-4'),
			{ completed: false, error: 'The repository could not be untracked.' }
		);
		expect(
			settleLaneNotice(untrackFailed, untrack(REPOSITORY, 'lane-5'), {
				completed: true,
			})
		).toEqual(idle);

		const refreshFailed = settleLaneNotice(idle, refresh('lane-6'), {
			completed: false,
		});
		expect(
			settleLaneNotice(refreshFailed, refresh('lane-7'), { completed: true })
		).toEqual(idle);

		const logFailed = settleLaneNotice(idle, readLog(LANE, 'lane-8'), {
			completed: false,
			error: 'The lane log could not be read.',
		});
		expect(
			settleLaneNotice(logFailed, readLog(LANE, 'lane-9'), {
				completed: true,
			})
		).toEqual(idle);
	});

	it('keeps an error the same kind of operation left on another target', () => {
		const logFailed = settleLaneNotice(idle, readLog(OTHER, 'lane-1'), {
			completed: false,
			error: 'The lane log could not be read.',
		});
		expect(
			settleLaneNotice(logFailed, readLog(LANE, 'lane-2'), {
				completed: true,
			})
		).toBe(logFailed);
		const untrackFailed = settleLaneNotice(
			idle,
			untrack(REPOSITORY, 'lane-3'),
			{ completed: false }
		);
		expect(
			settleLaneNotice(
				untrackFailed,
				untrack('/Users/example/OtherApp', 'lane-4'),
				{ completed: true }
			)
		).toBe(untrackFailed);
	});

	it("clears the pending notice a run put up itself, never another run's", () => {
		const pending = {
			status: { kind: 'pending', message: 'Waiting for Metro on :8102…' },
			owner: laneNoticeOwner(launch),
		} as const;
		expect(settleLaneNotice(pending, launch, { completed: true })).toEqual(
			idle
		);
		expect(
			settleLaneNotice(pending, launch, {
				completed: false,
				cancelled: true,
			}).status.kind
		).toBe('idle');
		expect(
			settleLaneNotice(
				pending,
				{ ...launch, actionId: 'lane-2' },
				{ completed: false, cancelled: true }
			)
		).toBe(pending);
	});

	it('lets the next completed operation clear a failed first load', () => {
		const loadFailed = {
			status: { kind: 'error', message: 'Lane state could not be read.' },
			owner: null,
		} as const;
		expect(
			settleLaneNotice(loadFailed, refresh('lane-2'), { completed: true })
		).toEqual(idle);
	});

	it('lets any failure or explicit success take the notice', () => {
		const logRead = readLog(LANE, 'lane-2');
		expect(
			settleLaneNotice(launchFailed, logRead, {
				completed: false,
				error: 'The lane log could not be read.',
			})
		).toEqual({
			status: { kind: 'error', message: 'The lane log could not be read.' },
			owner: laneNoticeOwner(logRead),
		});
		const stop: LaneOperation = {
			kind: 'lane.stop',
			laneId: LANE,
			actionId: 'lane-3',
		};
		expect(settleLaneNotice(idle, stop, { completed: false }).status).toEqual({
			kind: 'error',
			message: 'The lane operation did not complete.',
		});
		expect(
			settleLaneNotice(
				launchFailed,
				stop,
				{ completed: true },
				'Lane feat-checkout stopped.'
			)
		).toEqual({
			status: { kind: 'success', message: 'Lane feat-checkout stopped.' },
			owner: laneNoticeOwner(stop),
		});
	});
});

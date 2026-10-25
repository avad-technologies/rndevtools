import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { simulatorTools } from '@/simulator/simulator-config';
import {
	ACTION_SUCCESS_CLEAR_MS,
	type ActionNoticeRuntime,
	type ActionNoticeSource,
	type ActionStatus,
	actionNoticeRuntimes,
	createActionStatusOrder,
	createSuccessNoticeTimers,
	selectActionNotice,
} from './action-notice';

const RUNTIMES: readonly ActionNoticeRuntime[] = [
	'desktop',
	'simulator',
	'recipe',
	'slimming',
	'lanes',
	'supabase',
];

function idle(): ActionStatus {
	return { kind: 'idle', message: '' };
}

function sources(
	statuses: Partial<Record<ActionNoticeRuntime, ActionStatus>> = {},
	clears: Partial<Record<ActionNoticeRuntime, () => void>> = {}
): Record<ActionNoticeRuntime, ActionNoticeSource> {
	return Object.fromEntries(
		RUNTIMES.map((runtime) => [
			runtime,
			{
				status: statuses[runtime] ?? idle(),
				clear: clears[runtime] ?? (() => {}),
			},
		])
	) as Record<ActionNoticeRuntime, ActionNoticeSource>;
}

describe('actionNoticeRuntimes', () => {
	it('shows the lane runtime, and the stacks lanes start, on the Lanes tool', () => {
		expect(actionNoticeRuntimes('simulator', 'lanes')).toEqual([
			'lanes',
			'supabase',
		]);
	});

	it('shows only the Supabase runtime on the Supabase tool', () => {
		expect(actionNoticeRuntimes('simulator', 'supabase')).toEqual([
			'supabase',
			'lanes',
		]);
	});

	it('keeps the existing routes for the other tools and workspaces', () => {
		expect(actionNoticeRuntimes('connected', 'lanes')).toEqual(['desktop']);
		expect(actionNoticeRuntimes('simulator', 'automation')).toEqual(['recipe']);
		expect(actionNoticeRuntimes('simulator', 'slimming')).toEqual(['slimming']);
		for (const tool of ['actions', 'captures', 'builds', 'settings'] as const) {
			expect(actionNoticeRuntimes('simulator', tool)).toEqual(['simulator']);
		}
	});

	it('also shows lane and stack notices on the Simulators tool, which starts and stops lanes', () => {
		expect(actionNoticeRuntimes('simulator', 'fleet')).toEqual([
			'simulator',
			'lanes',
			'supabase',
		]);
	});

	it('never shows Supabase notices in the connected workspace', () => {
		expect(actionNoticeRuntimes('connected', 'supabase')).toEqual(['desktop']);
	});

	it('routes every Simulator tool to at least one runtime', () => {
		for (const tool of simulatorTools) {
			expect(actionNoticeRuntimes('simulator', tool.id).length).toBeGreaterThan(
				0
			);
		}
	});
});

describe('selectActionNotice', () => {
	it('shows a lane pending and success notice on the Lanes tool', () => {
		const order = createActionStatusOrder();
		const clearLane = vi.fn();
		const pending: ActionStatus = {
			kind: 'pending',
			message: 'Booting the Simulator and starting Metro…',
		};
		const notice = selectActionNotice(
			sources({ lanes: pending }, { lanes: clearLane }),
			actionNoticeRuntimes('simulator', 'lanes'),
			order
		);
		expect(notice?.status).toBe(pending);
		notice?.clear();
		expect(clearLane).toHaveBeenCalledOnce();

		const success: ActionStatus = { kind: 'success', message: 'Lane started.' };
		expect(
			selectActionNotice(
				sources({ lanes: success }),
				actionNoticeRuntimes('simulator', 'lanes'),
				order
			)?.status
		).toBe(success);
	});

	it('shows nothing when every routed runtime is idle', () => {
		const order = createActionStatusOrder();
		const elsewhere: ActionStatus = { kind: 'error', message: 'Boot failed.' };
		expect(
			selectActionNotice(
				sources({ simulator: elsewhere }),
				actionNoticeRuntimes('simulator', 'lanes'),
				order
			)
		).toBeUndefined();
	});

	it('shows the newest notice when a tool listens to several runtimes', () => {
		const order = createActionStatusOrder();
		const fleet = actionNoticeRuntimes('simulator', 'fleet');
		const stale: ActionStatus = { kind: 'error', message: 'Boot failed.' };
		expect(
			selectActionNotice(sources({ simulator: stale }), fleet, order)?.status
		).toBe(stale);

		// A lane launched from the fleet detail must not hide behind the old error.
		const launching: ActionStatus = {
			kind: 'pending',
			message: 'Waiting for Metro on :8100…',
		};
		expect(
			selectActionNotice(
				sources({ simulator: stale, lanes: launching }),
				fleet,
				order
			)?.status
		).toBe(launching);

		// Once the lane notice clears, the unresolved error shows again.
		expect(
			selectActionNotice(sources({ simulator: stale }), fleet, order)?.status
		).toBe(stale);
	});

	it('shows a stack started from the Lanes tool over an older lane notice', () => {
		const order = createActionStatusOrder();
		const lanes = actionNoticeRuntimes('simulator', 'lanes');
		const started: ActionStatus = { kind: 'success', message: 'Lane started.' };
		selectActionNotice(sources({ lanes: started }), lanes, order);
		const stopping: ActionStatus = {
			kind: 'pending',
			message: 'Stopping feat-checkout…',
		};
		expect(
			selectActionNotice(
				sources({ lanes: started, supabase: stopping }),
				lanes,
				order
			)?.status
		).toBe(stopping);
		// The Supabase tool shows lane notices too: Track repository… runs
		// through the lane runtime.
		const tracked: ActionStatus = {
			kind: 'success',
			message: 'Tracking example-app.',
		};
		expect(
			selectActionNotice(
				sources({ lanes: tracked }),
				actionNoticeRuntimes('simulator', 'supabase'),
				order
			)?.status
		).toBe(tracked);
	});

	it('ranks statuses by when they first appeared, even on another tool', () => {
		const order = createActionStatusOrder();
		const lanes = actionNoticeRuntimes('simulator', 'lanes');
		// The Simulator runtime reports while the Lanes tool is showing...
		const booted: ActionStatus = { kind: 'success', message: 'Booted.' };
		selectActionNotice(sources({ simulator: booted }), lanes, order);
		// ...and a lane action follows it.
		const launching: ActionStatus = {
			kind: 'pending',
			message: 'Waiting for Metro on :8100…',
		};
		selectActionNotice(
			sources({ simulator: booted, lanes: launching }),
			lanes,
			order
		);
		expect(
			selectActionNotice(
				sources({ simulator: booted, lanes: launching }),
				actionNoticeRuntimes('simulator', 'fleet'),
				order
			)?.status
		).toBe(launching);
	});
});

describe('createActionStatusOrder', () => {
	it('numbers each status object once, newest highest', () => {
		const order = createActionStatusOrder();
		const first = idle();
		const second = idle();
		expect(order(first)).toBe(order(first));
		expect(order(second)).toBeGreaterThan(order(first));
	});
});

describe('createSuccessNoticeTimers', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('clears a lane success after the notice delay', () => {
		const timers = createSuccessNoticeTimers();
		const clearLane = vi.fn();
		timers.sync(
			sources(
				{ lanes: { kind: 'success', message: 'Lane started.' } },
				{ lanes: clearLane }
			)
		);
		vi.advanceTimersByTime(ACTION_SUCCESS_CLEAR_MS - 1);
		expect(clearLane).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(clearLane).toHaveBeenCalledOnce();
		timers.dispose();
	});

	it('never clears pending or error notices', () => {
		const timers = createSuccessNoticeTimers();
		const clear = vi.fn();
		timers.sync(
			sources(
				{
					lanes: { kind: 'pending', message: 'Starting…' },
					simulator: { kind: 'error', message: 'Boot failed.' },
				},
				{ lanes: clear, simulator: clear }
			)
		);
		vi.advanceTimersByTime(ACTION_SUCCESS_CLEAR_MS * 4);
		expect(clear).not.toHaveBeenCalled();
		timers.dispose();
	});

	it('does not restart the clock on re-renders or a new clear function', () => {
		const timers = createSuccessNoticeTimers();
		const success: ActionStatus = { kind: 'success', message: 'Lane started.' };
		const clears = [vi.fn(), vi.fn(), vi.fn()];
		// The lane runtime hands out a new clear function whenever its state
		// changes; each sync below is such a re-render.
		for (const clear of clears) {
			timers.sync(sources({ lanes: success }, { lanes: clear }));
			vi.advanceTimersByTime(1_000);
		}
		vi.advanceTimersByTime(ACTION_SUCCESS_CLEAR_MS - 3_000);
		expect(clears[0]).not.toHaveBeenCalled();
		expect(clears[1]).not.toHaveBeenCalled();
		expect(clears[2]).toHaveBeenCalledOnce();
		timers.dispose();
	});

	it('cancels the clear when a newer status replaces the success', () => {
		const timers = createSuccessNoticeTimers();
		const clear = vi.fn();
		timers.sync(
			sources(
				{ simulator: { kind: 'success', message: 'Booted.' } },
				{ simulator: clear }
			)
		);
		vi.advanceTimersByTime(1_000);
		timers.sync(
			sources(
				{ simulator: { kind: 'pending', message: 'Erasing…' } },
				{ simulator: clear }
			)
		);
		vi.advanceTimersByTime(ACTION_SUCCESS_CLEAR_MS * 2);
		expect(clear).not.toHaveBeenCalled();
		timers.dispose();
	});

	it('times each runtime from its own success', () => {
		const timers = createSuccessNoticeTimers();
		const clearSimulator = vi.fn();
		const clearLane = vi.fn();
		const booted: ActionStatus = { kind: 'success', message: 'Booted.' };
		const clears = { simulator: clearSimulator, lanes: clearLane };
		timers.sync(sources({ simulator: booted }, clears));
		vi.advanceTimersByTime(2_000);
		timers.sync(
			sources(
				{
					simulator: booted,
					lanes: { kind: 'success', message: 'Lane stopped.' },
				},
				clears
			)
		);
		vi.advanceTimersByTime(ACTION_SUCCESS_CLEAR_MS - 2_000);
		expect(clearSimulator).toHaveBeenCalledOnce();
		expect(clearLane).not.toHaveBeenCalled();
		vi.advanceTimersByTime(2_000);
		expect(clearLane).toHaveBeenCalledOnce();
		timers.dispose();
	});

	it('clears a success only once even if the runtime keeps it', () => {
		const timers = createSuccessNoticeTimers();
		const success: ActionStatus = { kind: 'success', message: 'Saved.' };
		const clear = vi.fn();
		timers.sync(sources({ recipe: success }, { recipe: clear }));
		vi.advanceTimersByTime(ACTION_SUCCESS_CLEAR_MS);
		timers.sync(sources({ recipe: success }, { recipe: clear }));
		vi.advanceTimersByTime(ACTION_SUCCESS_CLEAR_MS * 2);
		expect(clear).toHaveBeenCalledOnce();
		timers.dispose();
	});

	it('cancels every timer on dispose', () => {
		const timers = createSuccessNoticeTimers();
		const clear = vi.fn();
		timers.sync(
			sources(
				{ desktop: { kind: 'success', message: 'Sent.' } },
				{ desktop: clear }
			)
		);
		timers.dispose();
		vi.advanceTimersByTime(ACTION_SUCCESS_CLEAR_MS * 2);
		expect(clear).not.toHaveBeenCalled();
	});
});

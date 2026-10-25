import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { setChecklistHidden } from '@/lib/onboarding';
import type { LaneView } from '../../../shared/lane-protocol';
import {
	createSupabaseDemoState,
	SUPABASE_DEMO_IDS,
} from '../../../shared/supabase-demo-data';
import {
	clampFleetTile,
	FLEET_TILE_RANGE,
	FleetPanel,
	parseSimulatorCreateCount,
	simulatorEraseAvailability,
	simulatorOpenPresentation,
} from './fleet-panel';

// What each runtime hook returns while FleetPanel renders; tests fill it in.
const runtimes = vi.hoisted(() => ({
	simulator: {} as Record<string, unknown>,
	lanes: {} as Record<string, unknown>,
	supabase: {} as Record<string, unknown>,
}));
vi.mock('@/state/simulator-runtime', () => ({
	useSimulatorRuntime: () => runtimes.simulator,
}));
vi.mock('@/state/lane-runtime', () => ({
	useLaneRuntime: () => runtimes.lanes,
}));
vi.mock('@/state/supabase-runtime', () => ({
	useSupabaseState: () => runtimes.supabase,
	useSupabaseNavigation: () => ({ openInSupabase: () => undefined }),
}));
vi.mock('@/state/desktop-runtime', () => ({
	useDesktopRuntime: () => ({
		state: { devices: [] },
		setSelectedDeviceId: () => undefined,
	}),
}));
vi.mock('@/state/slimming-runtime', () => ({
	useSlimmingRuntime: () => ({ state: { statusBySimulator: {} } }),
}));
vi.mock('@/state/agent-runtime', () => ({
	useAgentRuntime: () => ({ state: { byDevice: {} } }),
}));
vi.mock('@/state/simulator-stream-runtime', () => ({
	useLiveScreen: () => ({ screen: undefined, status: undefined }),
}));
vi.mock('@/state/recipe-runtime', () => ({
	useRecipeRuntime: () => ({ state: { recipes: [] } }),
}));

describe('Simulator Fleet destructive-action policy', () => {
	it('allows erase only for an available, shut-down target on a live bridge', () => {
		expect(
			simulatorEraseAvailability({ isAvailable: true, state: 'shutdown' }, true)
		).toEqual({
			allowed: true,
			reason: 'Permanently removes installed apps, accounts, and local data.',
		});
	});

	it.each(['booted', 'booting', 'shuttingDown'] as const)(
		'disables erase while the target is %s and tells the operator to shut down first',
		(state) => {
			const availability = simulatorEraseAvailability(
				{ isAvailable: true, state },
				true
			);
			expect(availability.allowed).toBe(false);
			expect(availability.reason).toContain('Shut down');
		}
	);

	it('fails closed when the bridge or target is unavailable', () => {
		expect(
			simulatorEraseAvailability(
				{ isAvailable: true, state: 'shutdown' },
				false
			)
		).toMatchObject({ allowed: false });
		expect(
			simulatorEraseAvailability(
				{ isAvailable: false, state: 'shutdown' },
				true
			)
		).toMatchObject({
			allowed: false,
			reason: expect.stringContaining('unavailable'),
		});
	});
});

describe('Simulator Fleet create validation', () => {
	it.each([
		['1', 1],
		[' 12 ', 12],
		['20', 20],
	] as const)('accepts bounded whole count %s', (value, expected) => {
		expect(parseSimulatorCreateCount(value)).toBe(expected);
	});

	it.each(['', '0', '-1', '1.5', 'abc', '21', '200'])(
		'rejects surprising or out-of-range count %j',
		(value) => {
			expect(parseSimulatorCreateCount(value)).toBeNull();
		}
	);
});

describe('Simulator Fleet open behavior', () => {
	it('opens an already booted target and boots a shutdown target', () => {
		expect(
			simulatorOpenPresentation({ isAvailable: true, state: 'booted' }, true)
		).toEqual({ allowed: true, label: 'Open Simulator' });
		expect(
			simulatorOpenPresentation({ isAvailable: true, state: 'shutdown' }, true)
		).toEqual({ allowed: true, label: 'Boot & open' });
	});

	it('disables open while unavailable or transitioning', () => {
		expect(
			simulatorOpenPresentation({ isAvailable: false, state: 'booted' }, true)
		).toMatchObject({ allowed: false });
		expect(
			simulatorOpenPresentation({ isAvailable: true, state: 'booting' }, true)
		).toMatchObject({ allowed: false });
		expect(
			simulatorOpenPresentation({ isAvailable: true, state: 'shutdown' }, false)
		).toMatchObject({ allowed: false });
	});
});

describe('Simulator Fleet wall tiles', () => {
	it('clamps and steps the wall tile size, falling back to the default', () => {
		expect(clampFleetTile(Number.NaN)).toBe(FLEET_TILE_RANGE.default);
		expect(clampFleetTile(0)).toBe(FLEET_TILE_RANGE.min);
		expect(clampFleetTile(10_000)).toBe(FLEET_TILE_RANGE.max);
		expect(clampFleetTile(207)).toBe(200);
		expect(clampFleetTile(211)).toBe(220);
	});
});

describe('Simulator Fleet backends', () => {
	const ids = SUPABASE_DEMO_IDS;
	const checkout: LaneView = {
		id: ids.laneCheckout,
		worktreePath: '/Users/dev/code/app-checkout',
		branch: 'feat-checkout',
		simulatorUdid: ids.simulatorCheckout,
		environment: 'development',
		port: 8_102,
		metro: 'ready',
		logPath: '/Users/dev/lane.log',
		startedAt: 1,
		backend: {
			policy: 'auto',
			status: 'ready',
			stackId: ids.featCheckout,
			apiUrl: 'http://127.0.0.1:21734',
			appEnvNames: ['EXAMPLE_SUPABASE_URL'],
			warnings: [],
		},
	};

	it('shows the lane stack chip on the wall and counts it in the filter', () => {
		runtimes.simulator = {
			isBridgeAvailable: true,
			isLoading: false,
			runtimeError: null,
			refresh: () => undefined,
			runAction: () => undefined,
			cancelJob: () => undefined,
			selectedDevice: undefined,
			setSelectedDeviceUdid: () => undefined,
			state: {
				devices: [
					{
						udid: ids.simulatorCheckout,
						name: 'iPhone 17 Pro',
						state: 'booted',
						runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
						isAvailable: true,
					},
				],
				runtimes: [],
				metrics: { byDevice: {}, status: 'available' },
				jobs: [],
				deviceTypes: [],
				appsByDevice: {},
				diskByDevice: {},
			},
		};
		runtimes.lanes = {
			state: { lanes: [checkout] },
			pendingOperation: null,
			runOperation: () => undefined,
			focusLane: () => undefined,
		};
		runtimes.supabase = { state: createSupabaseDemoState() };
		const html = renderToStaticMarkup(createElement(FleetPanel));
		expect(html).toContain('db :21734');
		expect(html).toContain('With backend (1)');
	});
});

describe('Simulator Fleet first discovery', () => {
	function renderWithoutTargets(
		status: 'checking' | 'available',
		isLoading: boolean
	) {
		runtimes.simulator = {
			isBridgeAvailable: true,
			isLoading,
			runtimeError: null,
			refresh: () => undefined,
			runAction: () => undefined,
			cancelJob: () => undefined,
			selectedDevice: undefined,
			setSelectedDeviceUdid: () => undefined,
			state: {
				capability: {
					status,
					runtimeAvailability: { total: 0, available: 0 },
				},
				devices: [],
				runtimes: [],
				captures: [],
				metrics: { byDevice: {}, status: 'checking' },
				jobs: [],
				deviceTypes: [],
				appsByDevice: {},
				diskByDevice: {},
			},
		};
		runtimes.lanes = {
			state: { lanes: [], repositories: [], worktrees: [] },
			pendingOperation: null,
			runOperation: () => undefined,
			focusLane: () => undefined,
		};
		runtimes.supabase = { state: createSupabaseDemoState() };
		return renderToStaticMarkup(createElement(FleetPanel));
	}

	it('reads as loading, not empty, until the first scan finishes', () => {
		for (const html of [
			renderWithoutTargets('checking', false),
			renderWithoutTargets('available', true),
		]) {
			expect(html).toContain('Looking for Simulators');
			expect(html).not.toContain('Welcome to RN Devtools');
		}
	});

	it('greets an empty fleet with Get started until it is hidden', () => {
		expect(renderWithoutTargets('available', false)).toContain(
			'Welcome to RN Devtools'
		);
		setChecklistHidden(true);
		try {
			expect(renderWithoutTargets('available', false)).toContain(
				'No Simulator target discovered'
			);
		} finally {
			setChecklistHidden(false);
		}
	});
});

import { describe, expect, it } from 'vitest';
import type { Lane, LaneView } from '../../shared/lane-protocol';
import type { DeviceSession } from '../../shared/protocol';
import type {
	SimulatorDevice,
	SimulatorDeviceMetrics,
} from '../../shared/simulator-protocol';
import type { SlimmingSimulatorStatus } from '../../shared/slimming-protocol';
import {
	createSupabaseDemoState,
	SUPABASE_DEMO_IDS,
} from '../../shared/supabase-demo-data';
import {
	agentLabel,
	buildFleetRows,
	connectedSessionsForSimulator,
	type FleetRow,
	fleetFilterCounts,
	fleetRowMatches,
	fleetSlimSummary,
	primaryAgent,
	shortPath,
} from './fleet-model';

const RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5';
const A = 'AAAAAAAA-0000-4000-8000-000000000001';
const B = 'BBBBBBBB-0000-4000-8000-000000000002';
const C = 'CCCCCCCC-0000-4000-8000-000000000003';
const D = 'DDDDDDDD-0000-4000-8000-000000000004';

function device(
	udid: string,
	name: string,
	state: SimulatorDevice['state']
): SimulatorDevice {
	return { udid, name, state, runtimeIdentifier: RUNTIME, isAvailable: true };
}

function lane(udid: string, overrides: Partial<Lane> = {}): Lane {
	return {
		id: `lane-${udid.slice(0, 8).toLowerCase()}-0000-4000-8000-000000000000`,
		worktreePath: '/Users/dev/code/app-feature',
		branch: 'feature/x',
		simulatorUdid: udid,
		environment: 'development',
		port: 8_100,
		metro: 'ready',
		logPath: '/Users/dev/lane.log',
		startedAt: 1,
		...overrides,
	};
}

function metrics(memoryBytes: number): SimulatorDeviceMetrics {
	return {
		deviceUdid: A,
		sampledAt: 1,
		cpuPercent: 1,
		memoryBytes,
		processCount: 70,
		processes: [],
	} as unknown as SimulatorDeviceMetrics;
}

function session(
	udid: string | undefined,
	status: DeviceSession['status']
): DeviceSession {
	return {
		info: {
			id: `session-${udid ?? 'none'}`,
			name: 'Demo',
			platform: 'ios',
			capabilities: [],
			...(udid ? { simulatorUdid: udid } : {}),
		},
		status,
		connectedAt: 1,
		lastSeenAt: 2,
		sequence: 1,
		tools: {} as DeviceSession['tools'],
	};
}

function slimStatus(
	condition: SlimmingSimulatorStatus['condition'],
	disabled: number
): SlimmingSimulatorStatus {
	return {
		simulatorUdid: A,
		condition,
		managedDisabledServiceIds: [],
		managedDisabledCount: disabled,
		managedServiceCount: 170,
		matchingProfileIds: [],
		checkedAt: 1,
		checkpointAvailable: false,
	} as unknown as SlimmingSimulatorStatus;
}

describe('buildFleetRows', () => {
	it('joins inventory, metrics, slim status, lanes, and sessions into one row per device', () => {
		const rows = buildFleetRows({
			devices: [device(A, 'Agent A', 'booted')],
			runtimes: [{ identifier: RUNTIME, name: 'iOS 26.5', isAvailable: true }],
			metricsByDevice: { [A]: metrics(900_000_000) },
			slimmingByDevice: { [A]: slimStatus('profile-match', 170) },
			lanes: [
				lane(A, { agent: { kind: 'claude', sessionId: 's1', lastSeenAt: 1 } }),
			],
			sessions: [session(A, 'online'), session(B, 'online')],
			supabase: undefined,
		});
		expect(rows).toHaveLength(1);
		const row = rows[0];
		expect(row?.runtimeName).toBe('iOS 26.5');
		expect(row?.memoryBytes).toBe(900_000_000);
		expect(row?.slim).toMatchObject({ level: 'slim', label: 'Slim' });
		expect(row?.lane?.port).toBe(8_100);
		expect(row?.laneHealth).toEqual({ label: 'ready', tone: 'success' });
		expect(row?.sessions).toHaveLength(1);
		expect(row?.rank).toBe(0);
	});

	it('ranks busy devices first: agent lane, lane, connected app, idle, transitioning, shut down', () => {
		const rows = buildFleetRows({
			devices: [
				device(A, 'Idle booted', 'booted'),
				device(B, 'Lane with agent', 'booted'),
				device(C, 'Shut down', 'shutdown'),
				device(D, 'Booting', 'booting'),
			],
			runtimes: [],
			metricsByDevice: {},
			slimmingByDevice: {},
			lanes: [
				lane(B, { agent: { kind: 'codex', sessionId: 't1', lastSeenAt: 1 } }),
			],
			sessions: [session(A, 'online')],
			supabase: undefined,
		});
		expect(rows.map((row) => row.device.name)).toEqual([
			'Lane with agent',
			'Idle booted',
			'Booting',
			'Shut down',
		]);
	});

	it('hides metrics for shut-down devices and matches UDIDs case-insensitively', () => {
		const rows = buildFleetRows({
			devices: [device(A, 'Sim', 'shutdown')],
			runtimes: [],
			metricsByDevice: { [A]: metrics(1) },
			slimmingByDevice: {},
			lanes: [lane(A.toLowerCase(), { metro: 'stopped' })],
			sessions: [],
			supabase: undefined,
		});
		expect(rows[0]?.memoryBytes).toBeUndefined();
		expect(rows[0]?.lane).toBeDefined();
		expect(rows[0]?.laneHealth?.label).toBe('stopped');
		expect(rows[0]?.slim.label).toBe('Stock');
	});
});

describe('fleetSlimSummary', () => {
	it('describes slim, partial, stock, and uninspected devices', () => {
		expect(fleetSlimSummary(slimStatus('profile-match', 170), true).level).toBe(
			'slim'
		);
		expect(fleetSlimSummary(slimStatus('drifted', 12), true)).toMatchObject({
			level: 'partial',
			detail: '12 of 170 managed services disabled',
		});
		expect(fleetSlimSummary(slimStatus('partial', 12), true).level).toBe(
			'partial'
		);
		expect(fleetSlimSummary(slimStatus('managed-clean', 0), true).level).toBe(
			'stock'
		);
		expect(fleetSlimSummary(slimStatus('needs-attention', 3), true).label).toBe(
			'Check required'
		);
		expect(fleetSlimSummary(slimStatus('unknown', 0), true).label).toBe(
			'Not inspected'
		);
		expect(fleetSlimSummary(undefined, true).label).toBe('Not inspected');
		expect(fleetSlimSummary(undefined, false).label).toBe('Stock');
	});
});

describe('fleetRowMatches and counts', () => {
	const rows = buildFleetRows({
		devices: [
			device(A, 'Agent A', 'booted'),
			device(B, 'Plain', 'booted'),
			device(C, 'Off', 'shutdown'),
		],
		runtimes: [{ identifier: RUNTIME, name: 'iOS 26.5', isAvailable: true }],
		metricsByDevice: {},
		slimmingByDevice: {},
		lanes: [
			lane(A, {
				branch: 'feature/checkout',
				agent: { kind: 'claude', sessionId: 'sess-42', lastSeenAt: 1 },
			}),
		],
		sessions: [],
		supabase: undefined,
	});

	it('filters by state, lane, and agent', () => {
		expect(fleetFilterCounts(rows)).toEqual({
			all: 3,
			booted: 2,
			shutdown: 1,
			'with-lane': 1,
			'with-agent': 1,
			'with-backend': 0,
		});
		expect(
			rows
				.filter((row) => fleetRowMatches(row, 'with-lane', ''))
				.map((r) => r.device.name)
		).toEqual(['Agent A']);
		expect(
			rows
				.filter((row) => fleetRowMatches(row, 'shutdown', ''))
				.map((r) => r.device.name)
		).toEqual(['Off']);
	});

	it('searches name, runtime, branch, port, and agent session', () => {
		const names = (query: string) =>
			rows
				.filter((row) => fleetRowMatches(row, 'all', query))
				.map((r) => r.device.name);
		expect(names('checkout')).toEqual(['Agent A']);
		expect(names(':8100')).toEqual(['Agent A']);
		expect(names('claude sess-42')).toEqual(['Agent A']);
		expect(names('26.5')).toHaveLength(3);
		expect(names('nothing-here')).toEqual([]);
	});
});

describe('helpers', () => {
	it('abbreviates home directories and labels agents', () => {
		expect(shortPath('/Users/dev/code/app')).toBe('~/code/app');
		expect(shortPath('/opt/app')).toBe('/opt/app');
		expect(shortPath('/Users/dev')).toBe('~');
		expect(agentLabel('claude')).toBe('Claude');
		expect(agentLabel('codex')).toBe('Codex');
		expect(agentLabel('other')).toBe('Agent');
	});
});

describe('agent attachments on rows', () => {
	it('ranks a device with a live attached agent with agent lanes, and exposes a primary agent', () => {
		const rows = buildFleetRows({
			devices: [device(A, 'Claimed', 'booted'), device(B, 'Plain', 'booted')],
			runtimes: [{ identifier: RUNTIME, name: 'iOS 26.5', isAvailable: true }],
			metricsByDevice: {},
			slimmingByDevice: {},
			lanes: [],
			sessions: [],
			supabase: undefined,
			agentsByDevice: {
				[A]: [
					{
						kind: 'codex',
						sessionId: 'thread-7',
						title: 'onboarding',
						via: 'claim',
						lastSeenAt: 5,
						live: true,
						note: 'reviewing onboarding',
					},
				],
			},
		});
		expect(rows.map((row) => row.device.name)).toEqual(['Claimed', 'Plain']);
		expect(primaryAgent(rows[0] as FleetRow)).toEqual(
			expect.objectContaining({ kind: 'codex', sessionId: 'thread-7' })
		);
		expect(primaryAgent(rows[1] as FleetRow)).toBeUndefined();
		expect(fleetFilterCounts(rows)['with-agent']).toBe(1);
		expect(fleetRowMatches(rows[0] as FleetRow, 'all', 'onboarding')).toBe(
			true
		);
	});

	it('prefers the lane agent over an attachment when both exist', () => {
		const rows = buildFleetRows({
			devices: [device(A, 'Both', 'booted')],
			runtimes: [],
			metricsByDevice: {},
			slimmingByDevice: {},
			lanes: [
				lane(A, {
					agent: { kind: 'claude', sessionId: 'lane-owner', lastSeenAt: 1 },
				}),
			],
			sessions: [],
			supabase: undefined,
			agentsByDevice: {
				[A]: [
					{
						kind: 'codex',
						sessionId: 'toucher',
						title: 't',
						via: 'touch',
						lastSeenAt: 9,
						live: true,
					},
				],
			},
		});
		expect(primaryAgent(rows[0] as FleetRow)?.sessionId).toBe('lane-owner');
	});
});

describe('connectedSessionsForSimulator', () => {
	const UDID = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
	function appSession(
		id: string,
		status: DeviceSession['status'],
		simulatorUdid: string | undefined,
		lastSeenAt: number
	): DeviceSession {
		return {
			...session(simulatorUdid, status),
			info: {
				id,
				name: id,
				platform: 'ios',
				capabilities: [],
				...(simulatorUdid ? { simulatorUdid } : {}),
			},
			lastSeenAt,
		};
	}

	it('matches UDIDs case-insensitively and orders online sessions first', () => {
		const result = connectedSessionsForSimulator(UDID, [
			appSession('offline-newer', 'offline', UDID, 30),
			appSession(
				'unmatched',
				'online',
				'11111111-2222-4333-8444-555555555555',
				40
			),
			appSession('online-older', 'online', UDID.toLowerCase(), 10),
			appSession('simulated', 'simulated', UDID, 100),
			appSession('v1', 'online', undefined, 50),
		]);

		expect(result.map((candidate) => candidate.info.id)).toEqual([
			'online-older',
			'simulated',
			'offline-newer',
		]);
	});
});

describe('lane backends on rows', () => {
	const ids = SUPABASE_DEMO_IDS;
	const supabase = createSupabaseDemoState();
	const checkout: LaneView = {
		...lane(ids.simulatorCheckout, {
			id: ids.laneCheckout,
			branch: 'feat-checkout',
			port: 8_102,
		}),
		backend: {
			policy: 'auto',
			status: 'ready',
			stackId: ids.featCheckout,
			apiUrl: 'http://127.0.0.1:21734',
			appEnvNames: ['EXPO_PUBLIC_SUPABASE_URL'],
			warnings: [],
		},
	};
	const plain = lane(B, { port: 8_120, branch: 'feature/plain' });
	const build = (state = supabase) =>
		buildFleetRows({
			devices: [
				device(ids.simulatorCheckout, 'iPhone 17 Pro', 'booted'),
				device(B, 'Plain lane', 'booted'),
				device(C, 'Idle', 'shutdown'),
			],
			runtimes: [],
			metricsByDevice: {},
			slimmingByDevice: {},
			lanes: [checkout, plain],
			sessions: [],
			supabase: state,
		});

	it('gives a lane its backend chip, ports and stack, and counts them', () => {
		const rows = build();
		const row = rows.find(
			(candidate) => candidate.lane?.id === ids.laneCheckout
		);
		expect(row?.backend).toMatchObject({
			chip: { label: 'db :21734', tone: 'success' },
			stackId: ids.featCheckout,
			apiPort: 21_734,
			dbPort: 21_736,
		});
		expect(row?.backend?.line).toMatch(/ · stack 64616c83…$/);
		expect(
			rows.find((candidate) => candidate.lane?.id === plain.id)?.backend
		).toBeUndefined();
		expect(fleetFilterCounts(rows)['with-backend']).toBe(1);
		expect(
			rows
				.filter((candidate) => fleetRowMatches(candidate, 'with-backend', ''))
				.map((candidate) => candidate.device.name)
		).toEqual(['iPhone 17 Pro']);
	});

	it('searches the API and database ports and the stack id prefix', () => {
		const rows = build();
		const names = (query: string) =>
			rows
				.filter((row) => fleetRowMatches(row, 'all', query))
				.map((row) => row.device.name);
		expect(names(':21734')).toEqual(['iPhone 17 Pro']);
		expect(names(':21736')).toEqual(['iPhone 17 Pro']);
		expect(names('64616c83')).toEqual(['iPhone 17 Pro']);
		expect(names('db :21734')).toEqual(['iPhone 17 Pro']);
	});

	it('hides every chip while local Supabase is off or not given', () => {
		const off = {
			...supabase,
			feature: { ...supabase.feature, enabled: false },
		};
		expect(build(off).some((row) => row.backend)).toBe(false);
		const rows = buildFleetRows({
			devices: [device(ids.simulatorCheckout, 'iPhone 17 Pro', 'booted')],
			runtimes: [],
			metricsByDevice: {},
			slimmingByDevice: {},
			lanes: [checkout],
			sessions: [],
			supabase: undefined,
		});
		expect(rows[0]?.backend).toBeUndefined();
		expect(fleetFilterCounts(rows)['with-backend']).toBe(0);
	});
});

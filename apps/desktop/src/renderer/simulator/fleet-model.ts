import {
	type LaneBackendBrief,
	laneBackendBrief,
} from '@/simulator/supabase-cross-panel';
import type { DeviceAgent } from '../../shared/agent-protocol';
import type {
	LaneAgent,
	LaneHealth,
	LaneView,
} from '../../shared/lane-protocol';
import { laneHealth } from '../../shared/lane-protocol';
import type { DeviceSession } from '../../shared/protocol';
import type {
	SimulatorDevice,
	SimulatorDeviceMetrics,
	SimulatorRuntime,
} from '../../shared/simulator-protocol';
import type { SlimmingSimulatorStatus } from '../../shared/slimming-protocol';
import type { SupabaseState } from '../../shared/supabase-protocol';

/**
 * One row on the fleet wall. The Simulator inventory, resource sample, slim
 * status, lane lease, the lane's local backend, and connected app sessions
 * arrive from five services; the panel should read one shape and never
 * re-derive these joins in JSX.
 */
export type FleetRow = {
	device: SimulatorDevice;
	runtimeName: string;
	live: boolean;
	transitioning: boolean;
	memoryBytes: number | undefined;
	processCount: number | undefined;
	slim: FleetSlimSummary;
	lane: LaneView | undefined;
	laneHealth: LaneHealth | undefined;
	/** The lane's local Supabase stack, while local Supabase is on. */
	backend: LaneBackendBrief | undefined;
	sessions: DeviceSession[];
	/** Coding-agent sessions attached by claim, touch, or lane cwd. */
	agents: readonly DeviceAgent[];
	/** Lower sorts first: busy devices (agents, lanes) rise above idle ones. */
	rank: number;
};

export type FleetSlimSummary = {
	level: 'slim' | 'partial' | 'stock' | 'unknown';
	label: string;
	detail: string;
};

export type FleetStateFilter =
	| 'all'
	| 'booted'
	| 'shutdown'
	| 'with-lane'
	| 'with-agent'
	| 'with-backend';

const TRANSITIONAL_STATES = new Set<SimulatorDevice['state']>([
	'booting',
	'shuttingDown',
	'creating',
]);

export function fleetSlimSummary(
	status: SlimmingSimulatorStatus | undefined,
	live: boolean
): FleetSlimSummary {
	if (!status || status.condition === 'unknown') {
		return {
			level: 'unknown',
			label: live ? 'Not inspected' : 'Stock',
			detail: live
				? 'Slimming has not inspected this Simulator yet.'
				: 'Boot the Simulator to inspect its service profile.',
		};
	}
	const counts = `${status.managedDisabledCount} of ${status.managedServiceCount} managed services disabled`;
	switch (status.condition) {
		case 'profile-match':
			return {
				level: 'slim',
				label: 'Slim',
				detail: `Profile applied · ${counts}`,
			};
		case 'drifted':
		case 'partial':
			return { level: 'partial', label: 'Partial', detail: counts };
		case 'needs-attention':
			return {
				level: 'partial',
				label: 'Check required',
				detail: status.message ?? 'Slimming needs attention on this Simulator.',
			};
		default:
			return {
				level: 'stock',
				label: 'Stock',
				detail: 'Stock service set; slim it to save memory.',
			};
	}
}

/** The agent to show first on a row: the lane's own, else the strongest attachment. */
export function primaryAgent(
	row: Pick<FleetRow, 'lane' | 'agents'>
): { kind: DeviceAgent['kind']; sessionId: string } | undefined {
	return (
		row.lane?.agent ?? row.agents.find((agent) => agent.live) ?? row.agents[0]
	);
}

function fleetRank(
	row: Pick<FleetRow, 'live' | 'transitioning' | 'lane' | 'sessions' | 'agents'>
): number {
	if (row.live) {
		if (row.lane?.agent || row.agents.some((agent) => agent.live)) return 0;
		if (row.lane) return 1;
		if (row.sessions.some((session) => session.status === 'online')) return 2;
		return 3;
	}
	if (row.transitioning) return 4;
	return row.lane ? 5 : 6;
}

export function buildFleetRows({
	devices,
	runtimes,
	metricsByDevice,
	slimmingByDevice,
	lanes,
	sessions,
	agentsByDevice = {},
	supabase,
}: {
	devices: readonly SimulatorDevice[];
	runtimes: readonly SimulatorRuntime[];
	metricsByDevice: Readonly<Record<string, SimulatorDeviceMetrics>>;
	slimmingByDevice: Readonly<Record<string, SlimmingSimulatorStatus>>;
	lanes: readonly LaneView[];
	sessions: readonly DeviceSession[];
	agentsByDevice?: Readonly<Record<string, readonly DeviceAgent[]>>;
	/**
	 * Local Supabase, for each lane's backend chip; undefined hides them.
	 * Required, so a caller cannot drop the chips by leaving it out.
	 */
	supabase: Pick<SupabaseState, 'feature' | 'stacks' | 'jobs'> | undefined;
}): FleetRow[] {
	const runtimeById = new Map(
		runtimes.map((runtime) => [runtime.identifier, runtime.name])
	);
	const laneByUdid = new Map(
		lanes.map((lane) => [lane.simulatorUdid.toUpperCase(), lane])
	);
	const sessionsByUdid = new Map<string, DeviceSession[]>();
	for (const session of sessions) {
		const udid = session.info.simulatorUdid?.toUpperCase();
		if (!udid) continue;
		const list = sessionsByUdid.get(udid) ?? [];
		list.push(session);
		sessionsByUdid.set(udid, list);
	}
	return devices
		.map((device) => {
			const key = device.udid.toUpperCase();
			const live = device.state === 'booted';
			const metrics = metricsByDevice[device.udid];
			const lane = laneByUdid.get(key);
			const partial = {
				live,
				transitioning: TRANSITIONAL_STATES.has(device.state),
				lane,
				sessions: (sessionsByUdid.get(key) ?? []).sort(
					(left, right) => right.lastSeenAt - left.lastSeenAt
				),
				agents: agentsByDevice[key] ?? agentsByDevice[device.udid] ?? [],
			};
			return {
				device,
				runtimeName:
					runtimeById.get(device.runtimeIdentifier) ?? device.runtimeIdentifier,
				...partial,
				memoryBytes: live ? metrics?.memoryBytes : undefined,
				processCount: live ? metrics?.processCount : undefined,
				slim: fleetSlimSummary(slimmingByDevice[device.udid], live),
				laneHealth: lane ? laneHealth(lane) : undefined,
				backend:
					lane && supabase ? laneBackendBrief(lane, supabase) : undefined,
				rank: fleetRank(partial),
			};
		})
		.sort(
			(left, right) =>
				left.rank - right.rank ||
				left.device.name.localeCompare(right.device.name) ||
				left.runtimeName.localeCompare(right.runtimeName)
		);
}

export function fleetRowMatches(
	row: FleetRow,
	filter: FleetStateFilter,
	query: string
): boolean {
	switch (filter) {
		case 'booted':
			if (!row.live) return false;
			break;
		case 'shutdown':
			if (row.device.state !== 'shutdown') return false;
			break;
		case 'with-lane':
			if (!row.lane) return false;
			break;
		case 'with-agent':
			if (!primaryAgent(row)) return false;
			break;
		case 'with-backend':
			if (!row.backend) return false;
			break;
		default:
			break;
	}
	const normalized = query.trim().toLowerCase();
	if (!normalized) return true;
	const haystack = [
		row.device.name,
		row.device.udid,
		row.runtimeName,
		row.device.state,
		row.lane?.branch,
		row.lane?.environment,
		row.lane ? `:${row.lane.port}` : undefined,
		row.lane?.agent
			? `${row.lane.agent.kind} ${row.lane.agent.sessionId}`
			: undefined,
		// A backend matches its chip, its API and database ports, and its stack id.
		row.backend?.chip.label,
		row.backend?.apiPort === undefined ? undefined : `:${row.backend.apiPort}`,
		row.backend?.dbPort === undefined ? undefined : `:${row.backend.dbPort}`,
		row.backend?.stackId,
		...row.agents.map(
			(agent) => `${agent.kind} ${agent.sessionId} ${agent.title}`
		),
		...row.sessions.map((session) => session.info.name),
	]
		.filter((value): value is string => Boolean(value))
		.join(' ')
		.toLowerCase();
	return normalized.split(/\s+/).every((term) => haystack.includes(term));
}

export function fleetFilterCounts(
	rows: readonly FleetRow[]
): Record<FleetStateFilter, number> {
	return {
		all: rows.length,
		booted: rows.filter((row) => row.live).length,
		shutdown: rows.filter((row) => row.device.state === 'shutdown').length,
		'with-lane': rows.filter((row) => row.lane).length,
		'with-agent': rows.filter((row) => primaryAgent(row)).length,
		'with-backend': rows.filter((row) => row.backend).length,
	};
}

/**
 * The app sessions that report this Simulator, online first, then the most
 * recently seen; UDIDs match case-insensitively.
 */
export function connectedSessionsForSimulator(
	udid: string,
	sessions: readonly DeviceSession[]
): DeviceSession[] {
	const normalizedUdid = udid.toUpperCase();
	const statusRank: Record<DeviceSession['status'], number> = {
		online: 0,
		simulated: 1,
		offline: 2,
	};
	return sessions
		.filter(
			(session) => session.info.simulatorUdid?.toUpperCase() === normalizedUdid
		)
		.sort((left, right) => {
			const rankDifference = statusRank[left.status] - statusRank[right.status];
			return rankDifference || right.lastSeenAt - left.lastSeenAt;
		});
}

/** Abbreviates `/Users/me/code/app-feature` to `~/code/app-feature`. */
export function shortPath(value: string, home?: string): string {
	const prefix = home ?? guessHome(value);
	return prefix && value.startsWith(prefix)
		? `~${value.slice(prefix.length)}`
		: value;
}

function guessHome(value: string): string | undefined {
	const match = /^(\/Users\/[^/]+)(?=\/|$)/.exec(value);
	return match?.[1];
}

export function agentLabel(kind: LaneAgent['kind']): string {
	switch (kind) {
		case 'claude':
			return 'Claude';
		case 'codex':
			return 'Codex';
		default:
			return 'Agent';
	}
}

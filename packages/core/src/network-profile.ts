import { utf8ByteLength } from './core/serialize';

export const NETWORK_SIMULATION_PREFERENCE_VERSION = 1 as const;
export const MAX_NETWORK_SIMULATION_PREFERENCE_BYTES = 1024;

export const NETWORK_SIMULATION_PROFILE_IDS = Object.freeze([
	'none',
	'offline',
	'edge',
	'3g',
	'lte',
	'wifi',
	'dsl',
	'very-bad',
] as const);

export type NetworkSimulationProfileId =
	(typeof NETWORK_SIMULATION_PROFILE_IDS)[number];

/**
 * A bounded, app-scoped condition applied only to requests made through an
 * instrumented fetch implementation. It never represents device-wide network
 * state or traffic from native SDKs, WebSockets, or other applications.
 */
export type NetworkSimulationProfile = {
	id: NetworkSimulationProfileId;
	name: string;
	description: string;
	offline: boolean;
	latencyMs: number;
	jitterMs: number;
	/**
	 * Deterministic whole-request drops at the instrumented fetch boundary. This
	 * is not device-level packet interception or a packet-accurate transport.
	 */
	packetLossPercent: number;
	failurePercent: number;
	/** Deadline for the complete simulated operation, including synthetic delays. */
	timeoutMs: number | null;
	downloadKbps: number | null;
	uploadKbps: number | null;
};

const NETWORK_SIMULATION_PROFILES = {
	none: {
		id: 'none',
		name: 'No profile',
		description: 'Requests use the host network without simulated conditions.',
		offline: false,
		latencyMs: 0,
		jitterMs: 0,
		packetLossPercent: 0,
		failurePercent: 0,
		timeoutMs: null,
		downloadKbps: null,
		uploadKbps: null,
	},
	offline: {
		id: 'offline',
		name: 'Offline',
		description:
			'Every instrumented request fails before reaching the network.',
		offline: true,
		latencyMs: 0,
		jitterMs: 0,
		packetLossPercent: 0,
		failurePercent: 0,
		timeoutMs: null,
		downloadKbps: null,
		uploadKbps: null,
	},
	edge: {
		id: 'edge',
		name: 'Edge',
		description: 'High latency and very limited throughput.',
		offline: false,
		latencyMs: 400,
		jitterMs: 100,
		packetLossPercent: 1,
		failurePercent: 2,
		timeoutMs: 15_000,
		downloadKbps: 240,
		uploadKbps: 200,
	},
	'3g': {
		id: '3g',
		name: '3G',
		description: 'Moderate latency with constrained mobile throughput.',
		offline: false,
		latencyMs: 180,
		jitterMs: 60,
		packetLossPercent: 0.5,
		failurePercent: 1,
		timeoutMs: 15_000,
		downloadKbps: 1_600,
		uploadKbps: 750,
	},
	lte: {
		id: 'lte',
		name: 'LTE',
		description: 'Typical mobile latency and throughput.',
		offline: false,
		latencyMs: 70,
		jitterMs: 25,
		packetLossPercent: 0.1,
		failurePercent: 0.2,
		timeoutMs: 20_000,
		downloadKbps: 12_000,
		uploadKbps: 5_000,
	},
	wifi: {
		id: 'wifi',
		name: 'Wi-Fi',
		description: 'Low-latency broadband conditions.',
		offline: false,
		latencyMs: 20,
		jitterMs: 10,
		packetLossPercent: 0,
		failurePercent: 0,
		timeoutMs: 30_000,
		downloadKbps: 50_000,
		uploadKbps: 20_000,
	},
	dsl: {
		id: 'dsl',
		name: 'DSL',
		description: 'Moderate latency and asymmetric fixed-line throughput.',
		offline: false,
		latencyMs: 100,
		jitterMs: 30,
		packetLossPercent: 0.2,
		failurePercent: 0.5,
		timeoutMs: 20_000,
		downloadKbps: 2_000,
		uploadKbps: 1_000,
	},
	'very-bad': {
		id: 'very-bad',
		name: 'Very Bad Network',
		description: 'Severe latency, jitter, loss, and throughput constraints.',
		offline: false,
		latencyMs: 900,
		jitterMs: 300,
		packetLossPercent: 10,
		failurePercent: 15,
		timeoutMs: 8_000,
		downloadKbps: 160,
		uploadKbps: 80,
	},
} as const satisfies Record<
	NetworkSimulationProfileId,
	NetworkSimulationProfile
>;

const networkSimulationProfileIds = new Set<string>(
	NETWORK_SIMULATION_PROFILE_IDS,
);

export function isNetworkSimulationProfileId(
	value: unknown,
): value is NetworkSimulationProfileId {
	return typeof value === 'string' && networkSimulationProfileIds.has(value);
}

export function getNetworkSimulationProfile(
	id: NetworkSimulationProfileId,
): NetworkSimulationProfile {
	if (!isNetworkSimulationProfileId(id)) {
		throw new Error('Network simulation profile is unsupported.');
	}
	return { ...NETWORK_SIMULATION_PROFILES[id] };
}

export type NetworkSimulationPreference = Readonly<{
	version: typeof NETWORK_SIMULATION_PREFERENCE_VERSION;
	profileId: NetworkSimulationProfileId;
}>;

/** Produces a small host-persistable preference, never an active global state. */
export function exportNetworkSimulationPreference(
	profileId: NetworkSimulationProfileId,
): string {
	if (!isNetworkSimulationProfileId(profileId)) {
		throw new Error('Network simulation profile is unsupported.');
	}
	return JSON.stringify({
		version: NETWORK_SIMULATION_PREFERENCE_VERSION,
		profileId,
	} satisfies NetworkSimulationPreference);
}

/**
 * Parses only the versioned named-profile preference. Custom/unbounded shaping
 * inputs are deliberately unsupported.
 */
export function importNetworkSimulationPreference(
	serialized: string,
): NetworkSimulationPreference {
	if (
		typeof serialized !== 'string' ||
		serialized.length > MAX_NETWORK_SIMULATION_PREFERENCE_BYTES ||
		utf8ByteLength(serialized) > MAX_NETWORK_SIMULATION_PREFERENCE_BYTES
	) {
		throw new Error('Network simulation preference exceeds the import limit.');
	}
	let value: unknown;
	try {
		value = JSON.parse(serialized);
	} catch {
		throw new Error('Network simulation preference is not valid JSON.');
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Network simulation preference has an invalid shape.');
	}
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const version = descriptors.version;
	const profileId = descriptors.profileId;
	if (
		!version ||
		!('value' in version) ||
		version.value !== NETWORK_SIMULATION_PREFERENCE_VERSION ||
		!profileId ||
		!('value' in profileId) ||
		!isNetworkSimulationProfileId(profileId.value)
	) {
		throw new Error('Network simulation preference is unsupported.');
	}
	return Object.freeze({
		version: NETWORK_SIMULATION_PREFERENCE_VERSION,
		profileId: profileId.value,
	});
}

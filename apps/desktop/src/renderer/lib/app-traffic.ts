import { useMemo, useSyncExternalStore } from 'react';
import {
	type AppTrafficView,
	appTrafficTarget,
	appTrafficView,
	type NetworkTargetBadge,
	type NetworkTargetFilter,
	networkTargetBadge,
	type StackAppTrafficRow,
	stackAppTrafficRow,
} from '@/simulator/app-traffic-model';
import { useDesktopRuntime } from '@/state/desktop-runtime';
import { useLaneRuntime } from '@/state/lane-runtime';
import { useSupabaseState } from '@/state/supabase-runtime';
import type { LaneView } from '../../shared/lane-protocol';
import type { DeviceSession, NetworkEntry } from '../../shared/protocol';
import {
	type SupabaseStackSummary,
	type SupabaseTrafficSignature,
	supabaseStackTitle,
} from '../../shared/supabase-protocol';
import type { SupabaseTrafficTarget } from '../../shared/supabase-traffic';

/**
 * The connected app's Supabase traffic for the banner, Network, Diagnostics
 * and Environment, plus the one-shot filter intent that lets the banner
 * open Network on a single backend. The intent lives here rather than in
 * the desktop runtime so a lazily mounted Network panel can pick it up
 * whenever it renders.
 */

type NetworkFilterIntent = Readonly<{
	/** The connected device the filter was asked for. */
	deviceId: string;
	target: NetworkTargetFilter;
	nonce: number;
}>;

type NetworkFilterIntents = Readonly<{
	request: (intent: Omit<NetworkFilterIntent, 'nonce'>) => void;
	/** The Network panel applied the intent with this nonce. */
	settle: (nonce: number) => void;
	subscribe: (listener: () => void) => () => void;
	current: () => NetworkFilterIntent | null;
}>;

/** A tiny observable slot for the latest Network filter intent. */
export function createNetworkFilterIntents(): NetworkFilterIntents {
	let current: NetworkFilterIntent | null = null;
	let nonce = 0;
	const listeners = new Set<() => void>();
	const notify = () => {
		for (const listener of listeners) listener();
	};
	return {
		request: (intent) => {
			nonce += 1;
			current = { ...intent, nonce };
			notify();
		},
		settle: (settled) => {
			if (current?.nonce !== settled) return;
			current = null;
			notify();
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		current: () => current,
	};
}

const networkFilterIntents = createNetworkFilterIntents();

/** Opens Network on one backend's requests: call it, then go to connected/network. */
export const requestNetworkFilter = networkFilterIntents.request;
export const settleNetworkFilter = networkFilterIntents.settle;

/** The pending Network filter intent, if any. */
export function useNetworkFilterIntent(): NetworkFilterIntent | null {
	return useSyncExternalStore(
		networkFilterIntents.subscribe,
		networkFilterIntents.current
	);
}

const NO_ENTRIES: readonly NetworkEntry[] = [];
const NO_DEVICES: readonly DeviceSession[] = [];

export type AppTraffic = AppTrafficView &
	Readonly<{
		/** The lane on the app's Simulator, when one runs there. */
		lane: LaneView | undefined;
		/** Where one captured request went, or undefined when it isn't Supabase. */
		targetFor: (entry: NetworkEntry) => SupabaseTrafficTarget | undefined;
		/** The host cell badge for a target. */
		badgeFor: (target: SupabaseTrafficTarget) => NetworkTargetBadge;
	}>;

type BadgeKey = Readonly<{
	expects: boolean;
	expectedPort: number | null;
	titles: readonly (readonly [string, string])[];
}>;

/**
 * The selected app's traffic classified against its lane's stack: device →
 * Simulator UDID → lane → stack. The view follows every capture; the
 * per-request target and badge functions change only when the signature,
 * the lane's stack or the stack names do, so grid columns built on them
 * stay put while requests stream in.
 */
export function useAppTraffic(): AppTraffic {
	const { selectedDevice } = useDesktopRuntime();
	const { laneForSimulator } = useLaneRuntime();
	const { state } = useSupabaseState();
	const udid = selectedDevice?.info.simulatorUdid;
	const lane = udid === undefined ? undefined : laneForSimulator(udid);
	const entries = selectedDevice?.tools.network ?? NO_ENTRIES;
	const view = useMemo(
		() =>
			appTrafficView({
				device: udid === undefined ? null : { info: { simulatorUdid: udid } },
				entries,
				lane,
				state,
			}),
		[entries, lane, state, udid]
	);
	const { enabled } = view;
	const { expectedStackId } = view;
	const signatureKey = JSON.stringify(state.trafficSignature);
	const targetFor = useMemo(() => {
		const signature = JSON.parse(signatureKey) as SupabaseTrafficSignature;
		return (entry: NetworkEntry) =>
			appTrafficTarget(entry, signature, { enabled, expectedStackId });
	}, [enabled, expectedStackId, signatureKey]);
	const badgeKey = JSON.stringify({
		expects: view.expects,
		expectedPort: view.labels.expectedPort ?? null,
		titles: state.stacks.map((stack) => [stack.id, supabaseStackTitle(stack)]),
	} satisfies BadgeKey);
	const badgeFor = useMemo(() => {
		const key = JSON.parse(badgeKey) as BadgeKey;
		const titles = new Map(key.titles);
		const context = {
			expects: key.expects,
			labels: {
				stackLabel: (stackId: string) => titles.get(stackId),
				...(key.expectedPort === null
					? {}
					: { expectedPort: key.expectedPort }),
			},
		};
		return (target: SupabaseTrafficTarget) =>
			networkTargetBadge(target, context);
	}, [badgeKey]);
	return useMemo(
		() => ({ ...view, lane, targetFor, badgeFor }),
		[badgeFor, lane, targetFor, view]
	);
}

/**
 * One stack's App traffic row in the Supabase tab: the connected app on one
 * of its lanes' Simulators, classified against it as requests stream in.
 */
export function useStackAppTraffic(
	stack: SupabaseStackSummary,
	now: number
): StackAppTrafficRow | undefined {
	const { state: desktop } = useDesktopRuntime();
	const { laneForSimulator } = useLaneRuntime();
	const { state } = useSupabaseState();
	const devices = desktop?.devices ?? NO_DEVICES;
	return useMemo(
		() => stackAppTrafficRow(stack, { devices, laneForSimulator, state, now }),
		[devices, laneForSimulator, now, stack, state]
	);
}

/**
 * Show traffic: selects the app, asks Network for that one backend, then
 * opens it.
 */
export function showAppTraffic(
	row: Pick<StackAppTrafficRow, 'deviceId' | 'filter'>,
	setSelectedDeviceId: (deviceId: string) => void
): void {
	if (!row.filter) return;
	setSelectedDeviceId(row.deviceId);
	requestNetworkFilter({ deviceId: row.deviceId, target: row.filter });
	window.location.hash = 'connected/network';
}

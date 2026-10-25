import {
	DESKTOP_PROTOCOL_VERSION,
	type DesktopState,
	type DeviceSession,
	type DiagnosticEntry,
} from '../shared/protocol';

type BrokerProjectableSession = {
	device: DeviceSession;
};

export type BrokerStateProjection = {
	broker: DesktopState['broker'];
	sessions: Iterable<BrokerProjectableSession>;
	diagnostics: readonly DiagnosticEntry[];
};

/** Create detached renderer arrays without owning session lifecycle. */
export function projectBrokerState({
	broker,
	sessions,
	diagnostics,
}: BrokerStateProjection): DesktopState {
	return {
		protocolVersion: DESKTOP_PROTOCOL_VERSION,
		broker,
		devices: [...sessions]
			.map((session) => session.device)
			.sort((left, right) => {
				const rank = { online: 0, simulated: 1, offline: 2 } as const;
				return (
					rank[left.status] - rank[right.status] ||
					right.lastSeenAt - left.lastSeenAt
				);
			}),
		diagnostics: [...diagnostics],
	};
}

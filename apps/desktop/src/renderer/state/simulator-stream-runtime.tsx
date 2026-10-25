import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react';
import type {
	SimulatorStreamBridge,
	SimulatorStreamFrame,
	SimulatorStreamQuality,
	SimulatorStreamStatus,
	SimulatorStreamSubscription,
} from '../../shared/simulator-stream-protocol';

export type LiveScreen = {
	/** Object URL for the latest frame; revoked when the next one arrives. */
	url: string;
	frame: SimulatorStreamFrame;
};

type ScreenRequest = { udid: string; quality: SimulatorStreamQuality };

type ObjectUrls = Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;

type LiveScreens = {
	screen: (udid: string) => LiveScreen | undefined;
	status: (udid: string) => SimulatorStreamStatus | undefined;
	/** Calls `listener` whenever this Simulator's frame or status changes. */
	subscribe: (udid: string, listener: () => void) => () => void;
	addFrame: (frame: SimulatorStreamFrame, bytes: Uint8Array) => void;
	setStatus: (status: SimulatorStreamStatus) => void;
	/** Revokes every frame's URL and forgets every Simulator. */
	clear: () => void;
};

type SimulatorStreamRuntimeValue = {
	isAvailable: boolean;
	screens: LiveScreens;
	/**
	 * Registers interest in a screen for as long as the returned disposer is
	 * not called. Many components may want the same UDID; the strongest
	 * quality wins and main sees one subscription per Simulator.
	 */
	request: (request: ScreenRequest) => () => void;
};

const SimulatorStreamContext =
	createContext<SimulatorStreamRuntimeValue | null>(null);

const SUBSCRIPTION_DEBOUNCE_MS = 60;

function streamBridge(): SimulatorStreamBridge | null {
	const candidate = window.rnDevtools as
		| (NonNullable<typeof window.rnDevtools> & Partial<SimulatorStreamBridge>)
		| undefined;
	if (
		!candidate ||
		typeof candidate.setSimulatorStreamSubscriptions !== 'function' ||
		typeof candidate.subscribeSimulatorStreamFrames !== 'function' ||
		typeof candidate.subscribeSimulatorStreamStatus !== 'function'
	) {
		return null;
	}
	return candidate as SimulatorStreamBridge;
}

/**
 * Collapses many component-level requests into the one subscription set the
 * main process wants. `focus` beats `tile` for the same Simulator.
 */
export function resolveStreamSubscriptions(
	requests: Iterable<ScreenRequest>
): SimulatorStreamSubscription[] {
	const byUdid = new Map<string, SimulatorStreamQuality>();
	for (const request of requests) {
		const key = request.udid.toUpperCase();
		const current = byUdid.get(key);
		if (!current || (current === 'tile' && request.quality === 'focus')) {
			byUdid.set(key, request.quality);
		}
	}
	return [...byUdid.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([udid, quality]) => ({ udid, quality }));
}

/**
 * The latest frame and status of each Simulator, kept outside React state.
 * A frame becomes an object URL here, in the IPC callback: StrictMode runs
 * state updaters twice, and a URL made in one would pin its JPEG for good.
 * Listeners subscribe per Simulator, so a frame re-renders the screens that
 * show that device, not the whole wall.
 */
export function createLiveScreens(urls: ObjectUrls = URL): LiveScreens {
	const screens = new Map<string, LiveScreen>();
	const statuses = new Map<string, SimulatorStreamStatus>();
	// The newest sequence shown per Simulator. Main restarts a poller, and its
	// count, whenever a device's quality changes, and announces each new poller
	// with `starting`, which clears this so the new count is not dropped.
	const sequences = new Map<string, number>();
	const listeners = new Map<string, Set<() => void>>();
	const notify = (key: string) => {
		for (const listener of listeners.get(key) ?? []) listener();
	};
	return {
		screen: (udid) => screens.get(udid.toUpperCase()),
		status: (udid) => statuses.get(udid.toUpperCase()),
		subscribe: (udid, listener) => {
			const key = udid.toUpperCase();
			const forKey = listeners.get(key) ?? new Set<() => void>();
			forKey.add(listener);
			listeners.set(key, forKey);
			return () => {
				forKey.delete(listener);
				if (forKey.size === 0 && listeners.get(key) === forKey) {
					listeners.delete(key);
				}
			};
		},
		addFrame: (frame, bytes) => {
			const key = frame.udid.toUpperCase();
			const newest = sequences.get(key);
			if (newest !== undefined && newest >= frame.sequence) return;
			sequences.set(key, frame.sequence);
			// Copy into a fresh ArrayBuffer-backed view: the structured-clone
			// result may be a view over a larger (or shared) buffer.
			const copy = new Uint8Array(bytes.byteLength);
			copy.set(bytes);
			const previous = screens.get(key);
			screens.set(key, {
				url: urls.createObjectURL(new Blob([copy], { type: frame.mimeType })),
				frame,
			});
			if (previous) urls.revokeObjectURL(previous.url);
			notify(key);
		},
		setStatus: (status) => {
			const key = status.udid.toUpperCase();
			if (status.status === 'stopped') {
				const screen = screens.get(key);
				if (screen) urls.revokeObjectURL(screen.url);
				screens.delete(key);
				statuses.delete(key);
				sequences.delete(key);
			} else {
				if (status.status === 'starting') sequences.delete(key);
				statuses.set(key, status);
			}
			notify(key);
		},
		clear: () => {
			const keys = new Set([...screens.keys(), ...statuses.keys()]);
			for (const { url } of screens.values()) urls.revokeObjectURL(url);
			screens.clear();
			statuses.clear();
			sequences.clear();
			for (const key of keys) notify(key);
		},
	};
}

export function SimulatorStreamProvider({ children }: { children: ReactNode }) {
	const bridge = useMemo(streamBridge, []);
	const [screens] = useState(() => createLiveScreens());
	const requests = useRef(new Map<symbol, ScreenRequest>());
	const lastSent = useRef<string>('[]');
	const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const flush = useCallback(() => {
		if (!bridge) return;
		const next = resolveStreamSubscriptions(requests.current.values());
		const serialized = JSON.stringify(next);
		if (serialized === lastSent.current) return;
		lastSent.current = serialized;
		void bridge.setSimulatorStreamSubscriptions(next).catch(() => {
			// Let the next change retry; the renderer has no way to recover here.
			lastSent.current = '';
		});
	}, [bridge]);

	const scheduleFlush = useCallback(() => {
		if (debounce.current) clearTimeout(debounce.current);
		debounce.current = setTimeout(flush, SUBSCRIPTION_DEBOUNCE_MS);
	}, [flush]);

	const request = useCallback<SimulatorStreamRuntimeValue['request']>(
		(value) => {
			const token = Symbol('stream-request');
			requests.current.set(token, value);
			scheduleFlush();
			return () => {
				requests.current.delete(token);
				scheduleFlush();
			};
		},
		[scheduleFlush]
	);

	useEffect(() => {
		if (!bridge) return;
		const unsubscribeFrames = bridge.subscribeSimulatorStreamFrames(
			(frame, bytes) => screens.addFrame(frame, bytes)
		);
		const unsubscribeStatus = bridge.subscribeSimulatorStreamStatus((status) =>
			screens.setStatus(status)
		);
		return () => {
			unsubscribeFrames();
			unsubscribeStatus();
			if (debounce.current) clearTimeout(debounce.current);
			requests.current.clear();
			lastSent.current = '[]';
			screens.clear();
			void bridge.setSimulatorStreamSubscriptions([]).catch(() => undefined);
		};
	}, [bridge, screens]);

	// Frames never change this value; they reach the screens that show their
	// Simulator through `screens.subscribe`.
	const value = useMemo<SimulatorStreamRuntimeValue>(
		() => ({ isAvailable: Boolean(bridge), screens, request }),
		[bridge, screens, request]
	);
	return (
		<SimulatorStreamContext.Provider value={value}>
			{children}
		</SimulatorStreamContext.Provider>
	);
}

function useSimulatorStream(): SimulatorStreamRuntimeValue {
	const value = useContext(SimulatorStreamContext);
	if (!value) {
		throw new Error(
			'useSimulatorStream must be used inside SimulatorStreamProvider.'
		);
	}
	return value;
}

/**
 * Subscribes to one Simulator's screen while `active` is true and returns the
 * latest frame. Components pass `active=false` for screens that are scrolled
 * out of view, so a long wall only streams what is on screen.
 */
export function useLiveScreen(
	udid: string | undefined,
	quality: SimulatorStreamQuality,
	active: boolean
): {
	screen: LiveScreen | undefined;
	status: SimulatorStreamStatus | undefined;
} {
	const { isAvailable, request, screens } = useSimulatorStream();
	useEffect(() => {
		if (!udid || !active || !isAvailable) return undefined;
		return request({ udid, quality });
	}, [udid, quality, active, isAvailable, request]);
	const subscribe = useCallback(
		(listener: () => void) =>
			udid ? screens.subscribe(udid, listener) : () => undefined,
		[screens, udid]
	);
	const screen = useSyncExternalStore(subscribe, () =>
		udid ? screens.screen(udid) : undefined
	);
	const status = useSyncExternalStore(subscribe, () =>
		udid ? screens.status(udid) : undefined
	);
	return { screen, status };
}

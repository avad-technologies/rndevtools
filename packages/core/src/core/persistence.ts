import type {
	DevToolsPosition,
	DevToolsPresentationMode,
	DevToolsSize,
} from '../types';
import { utf8ByteLength } from './serialize';

export const DEFAULT_PERSISTENCE_KEY = '@rndevtools/core/runtime-state';
const MAX_PERSISTED_STATE_BYTES = 64 * 1024;
const MAX_PERSISTED_POSITION = 1_000_000;
const MAX_PINNED_QUICK_ACTIONS = 32;
const MAX_PLUGIN_ID_LENGTH = 256;

export type DevToolsPersistedState = {
	version: 1;
	presentationMode: DevToolsPresentationMode;
	restoreMode: 'sheet' | 'window';
	launcherPosition?: DevToolsPosition;
	windowPosition?: DevToolsPosition;
	windowSize?: DevToolsSize;
	pillPosition?: DevToolsPosition;
	pinnedPillQuickActionIds?: readonly string[];
};

function isPosition(value: unknown): value is DevToolsPosition {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Partial<DevToolsPosition>;
	return (
		Number.isFinite(candidate.x) &&
		Number.isFinite(candidate.y) &&
		Math.abs(candidate.x ?? 0) <= MAX_PERSISTED_POSITION &&
		Math.abs(candidate.y ?? 0) <= MAX_PERSISTED_POSITION
	);
}

function isSize(value: unknown): value is DevToolsSize {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Partial<DevToolsSize>;
	return (
		Number.isFinite(candidate.width) &&
		Number.isFinite(candidate.height) &&
		(candidate.width ?? 0) > 0 &&
		(candidate.height ?? 0) > 0 &&
		(candidate.width ?? 0) <= MAX_PERSISTED_POSITION &&
		(candidate.height ?? 0) <= MAX_PERSISTED_POSITION
	);
}

function isPresentationMode(value: unknown): value is DevToolsPresentationMode {
	return value === 'sheet' || value === 'window' || value === 'pill';
}

function parsePinnedIds(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const ids = new Set<string>();
	for (const entry of value) {
		if (
			typeof entry !== 'string' ||
			!entry ||
			entry !== entry.trim() ||
			entry.length > MAX_PLUGIN_ID_LENGTH
		) {
			continue;
		}
		ids.add(entry);
		if (ids.size >= MAX_PINNED_QUICK_ACTIONS) break;
	}
	return [...ids];
}

export function parsePersistedState(
	value: string | null,
): DevToolsPersistedState | null {
	if (
		!value ||
		value.length > MAX_PERSISTED_STATE_BYTES ||
		utf8ByteLength(value) > MAX_PERSISTED_STATE_BYTES
	) {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(value);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return null;
		}
		const candidate = parsed as Partial<DevToolsPersistedState>;
		const pinnedPillQuickActionIds = parsePinnedIds(
			candidate.pinnedPillQuickActionIds,
		);
		if (
			candidate.version !== 1 ||
			!isPresentationMode(candidate.presentationMode) ||
			(candidate.restoreMode !== 'sheet' && candidate.restoreMode !== 'window')
		) {
			return null;
		}

		return {
			version: 1,
			presentationMode: candidate.presentationMode,
			restoreMode: candidate.restoreMode,
			...(isPosition(candidate.launcherPosition)
				? { launcherPosition: { ...candidate.launcherPosition } }
				: {}),
			...(isPosition(candidate.windowPosition)
				? { windowPosition: { ...candidate.windowPosition } }
				: {}),
			...(isSize(candidate.windowSize)
				? { windowSize: { ...candidate.windowSize } }
				: {}),
			...(isPosition(candidate.pillPosition)
				? { pillPosition: { ...candidate.pillPosition } }
				: {}),
			...(pinnedPillQuickActionIds ? { pinnedPillQuickActionIds } : {}),
		};
	} catch {
		return null;
	}
}

export class SerializedPersistenceWriter {
	readonly #chains = new WeakMap<object, Map<string, Promise<void>>>();

	write(
		storage: { setItem: (key: string, value: string) => void | Promise<void> },
		key: string,
		value: string,
	): Promise<void> {
		let storageChains = this.#chains.get(storage);
		if (!storageChains) {
			storageChains = new Map();
			this.#chains.set(storage, storageChains);
		}
		const previous = storageChains.get(key) ?? Promise.resolve();
		const next = previous.then(() => storage.setItem(key, value));
		const settled = next.catch(() => undefined);
		storageChains.set(key, settled);
		void settled.then(() => {
			if (storageChains?.get(key) === settled) storageChains.delete(key);
		});
		return next;
	}
}

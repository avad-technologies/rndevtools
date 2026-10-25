import {
	Button,
	ContentUnavailableView,
	DisclosureGroup,
	Host,
	Label,
	LabeledContent,
	List,
	Section,
	TextField,
	Text as UIText,
} from '@expo/ui/swift-ui';
import {
	autocorrectionDisabled,
	font,
	foregroundStyle,
	lineLimit,
	listStyle,
} from '@expo/ui/swift-ui/modifiers';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { Platform, PlatformColor } from 'react-native';
import {
	AndroidPanelRow,
	AndroidPanelScroll,
	AndroidPanelSearch,
	AndroidPanelSection,
	AndroidPanelTextBlock,
} from '../components/android-panel-ui';
import { NavIconButton } from '../components/nav-controls';
import { PanelShell } from '../components/panel-shell';
import type { DevtoolsEventStore } from '../core/event-store';
import { BoundedEventStore, ExternalStore } from '../core/external-store';
import { formatBytes, formatRelativeTime } from '../core/format';
import { assertPositiveFinite, assertPositiveInteger } from '../core/options';
import {
	diagnosticErrorText,
	sanitizeDiagnosticValueWithMetadata,
} from '../core/redact';
import {
	serializeValue,
	truncateText,
	utf8ByteLength,
} from '../core/serialize';
import type {
	DevToolsActionConfirmation,
	DevToolsPanelPlugin,
	DevToolsPanelProps,
	DevToolsSystemImage,
} from '../types';
import { canonicalizeRestoreValue } from './restore-points';

/**
 * A deliberately projected Zustand store. The host owns the projection so the
 * inspector never reaches into a global store registry or serializes raw state.
 */
export type DevToolsZustandAdapter = {
	id: string;
	title: string;
	description?: string;
	getInspectableState: () => unknown;
	subscribe: (listener: () => void) => () => void;
	/** Validates and returns a detached, canonical top-level patch. */
	validatePatch?: (patch: unknown) => unknown | Promise<unknown>;
	/** Applies only a patch returned by validatePatch. */
	applyPatch?: (patch: unknown) => void | Promise<void>;
	/** Restores the adapter's explicit, non-sensitive baseline. */
	reset?: () => void | Promise<void>;
	/** Whether the owning Zustand store persists state across app restarts. */
	persisted?: boolean;
	/** Diagnostic paths that mutation adapters must never accept. */
	sensitivePaths?: readonly string[];
	/** The inspectable projection is a complete patch that can be rolled back. */
	restorable?: boolean;
};

export type ZustandStoreSnapshot = {
	id: string;
	title: string;
	description?: string;
	stateText: string;
	stateBytes: number;
	truncated: boolean;
	keys: readonly string[];
	updatedAt: number;
	capabilities: Readonly<{
		writable: boolean;
		resettable: boolean;
		persisted: boolean;
		restorable: boolean;
		sensitivePaths: readonly string[];
	}>;
	error?: string;
};

export type ZustandInspectorSnapshot = {
	stores: readonly ZustandStoreSnapshot[];
	totalStoreCount: number;
	omittedStoreCount: number;
	truncated: boolean;
	error?: string;
};

export type ZustandChangeEvent = {
	id: number;
	at: number;
	storeId: string;
	storeTitle: string;
	changedKeys: readonly string[];
	stateText: string;
	truncated: boolean;
	error?: string;
};

export type ZustandMutationKind = 'patch' | 'reset' | 'jump';

export type ZustandMutationReceipt = Readonly<{
	id: string;
	storeId: string;
	kind: ZustandMutationKind;
	status: 'succeeded' | 'failed' | 'rolled-back' | 'needs-attention';
	startedAt: number;
	completedAt: number;
	changedKeys: readonly string[];
	correlationId?: string;
	snapshotId?: string;
	error?: string;
}>;

export type ZustandStateSnapshot = Readonly<{
	id: string;
	storeId: string;
	storeTitle: string;
	createdAt: number;
	stateText: string;
	stateBytes: number;
	truncated: boolean;
}>;

export type ZustandPluginOptions = {
	stores:
		| readonly DevToolsZustandAdapter[]
		| (() => readonly DevToolsZustandAdapter[]);
	subscribeToStores?: (listener: () => void) => () => void;
	maxValueBytes?: number;
	maxStores?: number;
	maxSnapshotBytes?: number;
	maxEvents?: number;
	/** Total estimated bytes retained across all events, not a per-event cap. */
	maxEventBytes?: number;
	maxStateSnapshots?: number;
	maxMutationReceipts?: number;
	maxMutationBytes?: number;
	eventStore?: DevtoolsEventStore;
	now?: () => number;
	title?: string;
	id?: string;
	description?: string;
	section?: string;
	systemImage?: DevToolsSystemImage;
};

export type ZustandPlugin = {
	plugin: DevToolsPanelPlugin;
	refresh: () => void;
	getSnapshot: () => ZustandInspectorSnapshot;
	getEvents: () => readonly ZustandChangeEvent[];
	clearEvents: () => void;
	applyPatch: (
		storeId: string,
		patch: unknown,
		correlationId?: string,
	) => Promise<ZustandMutationReceipt>;
	resetStore: (
		storeId: string,
		correlationId?: string,
	) => Promise<ZustandMutationReceipt>;
	jumpToState: (
		storeId: string,
		snapshotId: string,
		correlationId?: string,
	) => Promise<ZustandMutationReceipt>;
	captureState: (storeId: string) => Promise<ZustandStateSnapshot>;
	getStateSnapshots: (storeId?: string) => readonly ZustandStateSnapshot[];
	getMutationReceipts: () => readonly ZustandMutationReceipt[];
};

type StoreFingerprints = Readonly<Record<string, string>>;

type ZustandSubscription = {
	adapter: DevToolsZustandAdapter;
	dispose: () => void;
	active: boolean;
	captureQueued: boolean;
	dirtyDuringMutation: boolean;
};

type CanonicalZustandState = Readonly<{
	json: string;
	value: Readonly<Record<string, unknown>>;
	preview: string;
	bytes: number;
}>;

type PrivateZustandStateSnapshot = ZustandStateSnapshot & {
	json: string;
};

type RestorableZustandAdapter = DevToolsZustandAdapter & {
	validatePatch: NonNullable<DevToolsZustandAdapter['validatePatch']>;
	applyPatch: NonNullable<DevToolsZustandAdapter['applyPatch']>;
	restorable: true;
};
const MAX_INSPECTABLE_KEYS = 500;
const MAX_INSPECTABLE_STORES = 500;
const MAX_ZUSTAND_VALUE_BYTES = 1024 * 1024;
const MAX_ZUSTAND_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_ZUSTAND_EVENTS = 10_000;
const MAX_ZUSTAND_EVENT_BYTES = 16 * 1024 * 1024;
const MAX_SENSITIVE_PATHS = 500;
const MAX_SENSITIVE_PATH_BYTES = 1024;
const MAX_STATE_SNAPSHOTS = 100;
const MAX_MUTATION_RECEIPTS = 1_000;
const MAX_MUTATION_BYTES = 1024 * 1024;
const MAX_CORRELATION_ID_BYTES = 512;
const UNSAFE_PATCH_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const EMPTY_SENSITIVE_PATHS: readonly string[] = Object.freeze([]);

function errorMessage(error: unknown): string {
	return diagnosticErrorText(error);
}

function inspectableKeys(value: unknown): readonly string[] {
	if (Array.isArray(value))
		return [
			'length',
			...value.slice(0, MAX_INSPECTABLE_KEYS - 1).map((_, index) => `${index}`),
		];
	if (value && typeof value === 'object')
		return Object.keys(value).sort().slice(0, MAX_INSPECTABLE_KEYS);
	return ['value'];
}

function inspectableObjectKeys(value: object): readonly string[] {
	return Object.keys(value).sort().slice(0, MAX_INSPECTABLE_KEYS);
}

function normalizeSensitivePaths(value: unknown): readonly string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new Error('Zustand adapter sensitivePaths must be an array.');
	}
	const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
	const length =
		lengthDescriptor &&
		'value' in lengthDescriptor &&
		Number.isSafeInteger(lengthDescriptor.value)
			? lengthDescriptor.value
			: -1;
	if (length < 0 || length > MAX_SENSITIVE_PATHS) {
		throw new Error(
			`Zustand adapter sensitivePaths cannot exceed ${MAX_SENSITIVE_PATHS} entries.`,
		);
	}
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < length; index += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor || !('value' in descriptor)) {
			throw new Error(
				'Zustand adapter sensitivePaths cannot contain holes or accessors.',
			);
		}
		const path = descriptor.value;
		if (
			typeof path !== 'string' ||
			!path.trim() ||
			path !== path.trim() ||
			utf8ByteLength(path) > MAX_SENSITIVE_PATH_BYTES
		) {
			throw new Error(
				`Zustand adapter sensitive paths must be trimmed strings no longer than ${MAX_SENSITIVE_PATH_BYTES} bytes.`,
			);
		}
		if (!seen.has(path)) {
			seen.add(path);
			normalized.push(path);
		}
	}
	return Object.freeze(normalized);
}

function assertSafePatchKeys(value: unknown, path = '$'): void {
	if (!value || typeof value !== 'object') return;
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) {
			assertSafePatchKeys(value[index], `${path}[${index}]`);
		}
		return;
	}
	for (const [key, entry] of Object.entries(value)) {
		if (UNSAFE_PATCH_KEYS.has(key)) {
			throw new Error(`${path}.${key} is not allowed in a Zustand patch.`);
		}
		assertSafePatchKeys(entry, `${path}.${key}`);
	}
}

function canonicalizeTopLevelState(
	value: unknown,
	maxBytes: number,
	label: string,
): CanonicalZustandState {
	const canonical = canonicalizeRestoreValue(value, maxBytes);
	const detached: unknown = JSON.parse(canonical.json);
	if (!detached || typeof detached !== 'object' || Array.isArray(detached)) {
		throw new Error(`${label} must be a top-level JSON object.`);
	}
	assertSafePatchKeys(detached);
	return Object.freeze({
		json: canonical.json,
		value: detached as Readonly<Record<string, unknown>>,
		preview: canonical.preview,
		bytes: canonical.bytes,
	});
}

function normalizeCorrelationId(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (
		typeof value !== 'string' ||
		!value.trim() ||
		value !== value.trim() ||
		utf8ByteLength(value) > MAX_CORRELATION_ID_BYTES
	) {
		throw new Error(
			`Zustand correlation ids must be trimmed strings no longer than ${MAX_CORRELATION_ID_BYTES} bytes.`,
		);
	}
	return value;
}

function sensitivePathRoots(paths: readonly string[]): ReadonlySet<string> {
	const roots = new Set<string>();
	for (const path of paths) {
		const root = path.split(/[.[\]]/, 1)[0];
		if (root) roots.add(root);
	}
	return roots;
}

function assertPatchAvoidsSensitivePaths(
	patch: Readonly<Record<string, unknown>>,
	paths: readonly string[],
): void {
	const roots = sensitivePathRoots(paths);
	for (const key of Object.keys(patch)) {
		if (roots.has(key)) {
			throw new Error(
				`Zustand patch field ${key} is protected by the adapter's sensitive-path policy.`,
			);
		}
	}
}

function validateTimestamp(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error('Zustand mutation clock returned an invalid timestamp.');
	}
	return value;
}

/**
 * Fingerprints drive the change log, so a truncated prefix would hide any edit
 * that lands past the cut. Hash the whole projection instead: JSON.stringify
 * materializes the full string regardless of the retained budget, so hashing
 * costs no extra serialization and retains far less per key. Values that
 * exceed `maxValueBytes` still compare on their retained prefix, which the
 * `truncated` flag records.
 */
function fingerprintValue(value: unknown, maxValueBytes: number): string {
	const { text, truncated } = serializeValue(value, maxValueBytes);
	let hash = 2_166_136_261;
	for (let index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return `${text.length}:${(hash >>> 0).toString(36)}${truncated ? ':t' : ''}`;
}

function topLevelFingerprints(
	value: unknown,
	maxValueBytes: number,
): StoreFingerprints {
	if (!value || typeof value !== 'object') {
		return { value: fingerprintValue(value, maxValueBytes) };
	}
	if (Array.isArray(value)) {
		return Object.fromEntries([
			['length', String(value.length)],
			...value
				.slice(0, MAX_INSPECTABLE_KEYS - 1)
				.map((entry, index) => [
					String(index),
					fingerprintValue(entry, maxValueBytes),
				]),
		]);
	}
	return Object.fromEntries(
		inspectableObjectKeys(value).map((key) => [
			key,
			fingerprintValue((value as Record<string, unknown>)[key], maxValueBytes),
		]),
	);
}

export function changedZustandKeys(
	previous: StoreFingerprints | undefined,
	next: StoreFingerprints,
): readonly string[] {
	if (!previous) return Object.keys(next).sort();
	return [...new Set([...Object.keys(previous), ...Object.keys(next)])]
		.filter((key) => previous[key] !== next[key])
		.sort()
		.slice(0, MAX_INSPECTABLE_KEYS);
}

function describeStore(snapshot: ZustandStoreSnapshot): string {
	if (snapshot.error) return `Unavailable · ${snapshot.error}`;
	const keyCount = snapshot.keys.length;
	const keyLabel = keyCount === 1 ? '1 field' : `${keyCount} fields`;
	const truncated = snapshot.truncated ? ' · preview truncated' : '';
	return `${keyLabel} · ${formatBytes(snapshot.stateBytes)}${truncated}`;
}

function changeLabel(event: ZustandChangeEvent): string {
	if (event.error) return event.error;
	if (event.changedKeys.length === 0) return 'Projection refreshed';
	if (event.changedKeys.length <= 3) return event.changedKeys.join(', ');
	return `${event.changedKeys.slice(0, 3).join(', ')} +${event.changedKeys.length - 3}`;
}

function zustandCapabilityLabel(snapshot: ZustandStoreSnapshot): string {
	const mode = snapshot.capabilities.restorable
		? 'Reversible edits'
		: 'Read only';
	return snapshot.capabilities.persisted ? `${mode} · persisted` : mode;
}

export function createZustandPlugin(
	options: ZustandPluginOptions,
): ZustandPlugin {
	const title = options.title ?? 'Zustand';
	const id = options.id ?? 'zustand';
	const maxValueBytes = options.maxValueBytes ?? 64 * 1024;
	const maxStores = options.maxStores ?? 50;
	const maxSnapshotBytes = options.maxSnapshotBytes ?? 2 * 1024 * 1024;
	const maxEvents = options.maxEvents ?? 100;
	const maxEventBytes = options.maxEventBytes ?? 512 * 1024;
	const maxStateSnapshots = options.maxStateSnapshots ?? 20;
	const maxMutationReceipts = options.maxMutationReceipts ?? 100;
	const maxMutationBytes = options.maxMutationBytes ?? maxValueBytes;
	const now = options.now ?? Date.now;
	assertPositiveFinite(maxValueBytes, 'maxValueBytes');
	assertPositiveInteger(maxStores, 'maxStores');
	if (maxStores > MAX_INSPECTABLE_STORES) {
		throw new Error(`maxStores cannot exceed ${MAX_INSPECTABLE_STORES}`);
	}
	assertPositiveFinite(maxSnapshotBytes, 'maxSnapshotBytes');
	assertPositiveInteger(maxEvents, 'maxEvents');
	assertPositiveFinite(maxEventBytes, 'maxEventBytes');
	assertPositiveInteger(maxStateSnapshots, 'maxStateSnapshots');
	assertPositiveInteger(maxMutationReceipts, 'maxMutationReceipts');
	assertPositiveFinite(maxMutationBytes, 'maxMutationBytes');
	if (maxValueBytes > MAX_ZUSTAND_VALUE_BYTES) {
		throw new Error(`maxValueBytes cannot exceed ${MAX_ZUSTAND_VALUE_BYTES}`);
	}
	if (maxSnapshotBytes > MAX_ZUSTAND_SNAPSHOT_BYTES) {
		throw new Error(
			`maxSnapshotBytes cannot exceed ${MAX_ZUSTAND_SNAPSHOT_BYTES}`,
		);
	}
	if (maxEvents > MAX_ZUSTAND_EVENTS) {
		throw new Error(`maxEvents cannot exceed ${MAX_ZUSTAND_EVENTS}`);
	}
	if (maxEventBytes > MAX_ZUSTAND_EVENT_BYTES) {
		throw new Error(`maxEventBytes cannot exceed ${MAX_ZUSTAND_EVENT_BYTES}`);
	}
	if (maxStateSnapshots > MAX_STATE_SNAPSHOTS) {
		throw new Error(`maxStateSnapshots cannot exceed ${MAX_STATE_SNAPSHOTS}`);
	}
	if (maxMutationReceipts > MAX_MUTATION_RECEIPTS) {
		throw new Error(
			`maxMutationReceipts cannot exceed ${MAX_MUTATION_RECEIPTS}`,
		);
	}
	if (maxMutationBytes > MAX_MUTATION_BYTES) {
		throw new Error(`maxMutationBytes cannot exceed ${MAX_MUTATION_BYTES}`);
	}
	if (typeof now !== 'function') {
		throw new Error('Zustand mutation now must be a function.');
	}

	const snapshotStore = new ExternalStore<ZustandInspectorSnapshot>({
		stores: [],
		totalStoreCount: 0,
		omittedStoreCount: 0,
		truncated: false,
	});
	const eventStore = new BoundedEventStore<ZustandChangeEvent>({
		maxEvents,
		maxBytes: maxEventBytes,
		estimateBytes: (event) =>
			serializeValue(event, maxValueBytes + 8 * 1024).estimatedBytes,
	});
	const stateSnapshotStore = new ExternalStore<
		readonly PrivateZustandStateSnapshot[]
	>([]);
	const mutationReceiptStore = new ExternalStore<
		readonly ZustandMutationReceipt[]
	>([]);
	const snapshots = new Map<string, ZustandStoreSnapshot>();
	const snapshotSizes = new Map<string, number>();
	const fingerprints = new Map<string, StoreFingerprints>();
	const subscriptions = new Map<string, ZustandSubscription>();
	let installCount = 0;
	let nextEventId = 1;
	let nextStateSnapshotId = 1;
	let nextMutationReceiptId = 1;
	let mutationQueue = Promise.resolve();
	const mutatingStoreIds = new Set<string>();
	let storeRegistrySubscription:
		| { active: boolean; dispose: () => void }
		| undefined;
	let totalStoreCount = 0;
	const normalizedAdapterCache = new WeakMap<object, DevToolsZustandAdapter>();

	const getAdapters = (): unknown =>
		typeof options.stores === 'function' ? options.stores() : options.stores;
	const adapterField = (adapter: object, key: string): unknown => {
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = Object.getOwnPropertyDescriptor(adapter, key);
		} catch {
			throw new Error(`Zustand adapter field ${key} is unreadable.`);
		}
		if (!descriptor || !('value' in descriptor)) {
			throw new Error(`Zustand adapter field ${key} must be plain data.`);
		}
		return descriptor.value;
	};
	const optionalAdapterField = (adapter: object, key: string): unknown => {
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = Object.getOwnPropertyDescriptor(adapter, key);
		} catch {
			throw new Error(`Zustand adapter field ${key} is unreadable.`);
		}
		if (!descriptor) return undefined;
		if (!('value' in descriptor)) {
			throw new Error(`Zustand adapter field ${key} must be plain data.`);
		}
		return descriptor.value;
	};
	const normalizeAdapter = (candidate: unknown): DevToolsZustandAdapter => {
		if (!candidate || typeof candidate !== 'object') {
			throw new Error('Zustand adapters must be objects.');
		}
		const cached = normalizedAdapterCache.get(candidate);
		if (cached) return cached;
		const id = adapterField(candidate, 'id');
		const title = adapterField(candidate, 'title');
		const description = optionalAdapterField(candidate, 'description');
		const getInspectableState = adapterField(candidate, 'getInspectableState');
		const subscribe = adapterField(candidate, 'subscribe');
		const validatePatch = optionalAdapterField(candidate, 'validatePatch');
		const applyPatch = optionalAdapterField(candidate, 'applyPatch');
		const reset = optionalAdapterField(candidate, 'reset');
		const persisted = optionalAdapterField(candidate, 'persisted');
		const restorable = optionalAdapterField(candidate, 'restorable');
		const sensitivePaths = normalizeSensitivePaths(
			optionalAdapterField(candidate, 'sensitivePaths'),
		);
		if (typeof id !== 'string' || !id.trim() || id !== id.trim()) {
			throw new Error(
				'Zustand adapter ids must be non-empty and cannot have surrounding whitespace.',
			);
		}
		if (id.length > 256) {
			throw new Error('Zustand adapter ids cannot exceed 256 characters.');
		}
		if (typeof title !== 'string' || !title.trim() || title.length > 4 * 1024) {
			throw new Error(
				'Zustand adapter titles must be non-empty and at most 4096 characters.',
			);
		}
		if (
			description !== undefined &&
			(typeof description !== 'string' || description.length > 4 * 1024)
		) {
			throw new Error(
				'Zustand adapter descriptions cannot exceed 4096 characters.',
			);
		}
		if (
			typeof getInspectableState !== 'function' ||
			typeof subscribe !== 'function'
		) {
			throw new Error(
				'Zustand adapters require projection and subscription callbacks.',
			);
		}
		if (
			(validatePatch === undefined) !== (applyPatch === undefined) ||
			(validatePatch !== undefined && typeof validatePatch !== 'function') ||
			(applyPatch !== undefined && typeof applyPatch !== 'function')
		) {
			throw new Error(
				'Writable Zustand adapters require both validatePatch and applyPatch callbacks.',
			);
		}
		if (reset !== undefined && typeof reset !== 'function') {
			throw new Error('Zustand adapter reset must be a function.');
		}
		if (persisted !== undefined && typeof persisted !== 'boolean') {
			throw new Error('Zustand adapter persisted must be a boolean.');
		}
		if (restorable !== undefined && typeof restorable !== 'boolean') {
			throw new Error('Zustand adapter restorable must be a boolean.');
		}
		if (restorable === true && (!validatePatch || !applyPatch)) {
			throw new Error(
				'Restorable Zustand adapters require writable patch callbacks.',
			);
		}
		if (restorable === true && sensitivePaths.length > 0) {
			throw new Error(
				'Restorable Zustand projections cannot contain sensitive paths.',
			);
		}
		const adapter: DevToolsZustandAdapter = Object.freeze({
			id,
			title,
			...(typeof description === 'string' ? { description } : {}),
			getInspectableState: getInspectableState as () => unknown,
			subscribe: subscribe as (listener: () => void) => () => void,
			...(typeof validatePatch === 'function'
				? {
						validatePatch:
							validatePatch as DevToolsZustandAdapter['validatePatch'],
						applyPatch: applyPatch as DevToolsZustandAdapter['applyPatch'],
					}
				: {}),
			...(typeof reset === 'function'
				? { reset: reset as DevToolsZustandAdapter['reset'] }
				: {}),
			...(persisted === true ? { persisted: true } : {}),
			...(restorable === true ? { restorable: true } : {}),
			...(sensitivePaths.length > 0 ? { sensitivePaths } : {}),
		});
		normalizedAdapterCache.set(candidate, adapter);
		return adapter;
	};

	const validatedAdapters = (): readonly DevToolsZustandAdapter[] => {
		const rawAdapters = getAdapters();
		if (!Array.isArray(rawAdapters)) {
			throw new Error('Zustand adapters must be returned as an array.');
		}
		let rawAdapterCount: number;
		try {
			const descriptor = Object.getOwnPropertyDescriptor(rawAdapters, 'length');
			if (
				!descriptor ||
				!('value' in descriptor) ||
				!Number.isSafeInteger(descriptor.value) ||
				descriptor.value < 0
			) {
				throw new Error('invalid length');
			}
			rawAdapterCount = descriptor.value;
		} catch {
			throw new Error('Zustand adapter list has an invalid length.');
		}
		totalStoreCount = rawAdapterCount;
		const selectedAdapters: DevToolsZustandAdapter[] = [];
		for (
			let index = 0;
			index < Math.min(rawAdapterCount, maxStores);
			index += 1
		) {
			let descriptor: PropertyDescriptor | undefined;
			try {
				descriptor = Object.getOwnPropertyDescriptor(
					rawAdapters,
					String(index),
				);
			} catch {
				throw new Error('Zustand adapter list contains an unreadable item.');
			}
			if (!descriptor || !('value' in descriptor)) {
				throw new Error(
					'Zustand adapter lists cannot contain holes or accessors.',
				);
			}
			selectedAdapters.push(normalizeAdapter(descriptor.value));
		}
		const ids = new Set<string>();
		for (const adapter of selectedAdapters) {
			if (ids.has(adapter.id)) {
				throw new Error(`Duplicate Zustand adapter id: ${adapter.id}`);
			}
			ids.add(adapter.id);
		}
		return selectedAdapters;
	};

	const reportError = (error: unknown): void => {
		snapshotStore.set({
			...snapshotStore.getSnapshot(),
			error: truncateText(errorMessage(error), 8 * 1024).text,
		});
	};
	const adapterCapabilities = (adapter: DevToolsZustandAdapter) =>
		Object.freeze({
			writable: Boolean(adapter.validatePatch && adapter.applyPatch),
			resettable: Boolean(adapter.reset),
			persisted: adapter.persisted === true,
			restorable: adapter.restorable === true,
			sensitivePaths: adapter.sensitivePaths ?? EMPTY_SENSITIVE_PATHS,
		});
	const retainSnapshot = (snapshot: ZustandStoreSnapshot): void => {
		const serialized = serializeValue(
			snapshot,
			Math.ceil(maxSnapshotBytes) + 1,
		);
		snapshots.set(snapshot.id, snapshot);
		snapshotSizes.set(
			snapshot.id,
			serialized.truncated
				? Math.ceil(maxSnapshotBytes) + 1
				: serialized.estimatedBytes,
		);
	};

	const publish = (adapters: readonly DevToolsZustandAdapter[]) => {
		const stores: ZustandStoreSnapshot[] = [];
		let snapshotBytes = 0;
		for (const adapter of adapters) {
			const snapshot = snapshots.get(adapter.id);
			if (!snapshot) continue;
			const nextBytes =
				snapshotSizes.get(adapter.id) ?? Math.ceil(maxSnapshotBytes) + 1;
			if (snapshotBytes + nextBytes > maxSnapshotBytes) continue;
			snapshotBytes += nextBytes;
			stores.push(snapshot);
		}
		const omittedStoreCount = Math.max(0, totalStoreCount - stores.length);
		snapshotStore.set({
			stores,
			totalStoreCount,
			omittedStoreCount,
			truncated: omittedStoreCount > 0,
		});
	};

	const capture = (
		adapter: DevToolsZustandAdapter,
		recordChange: boolean,
	): void => {
		const at = Date.now();
		let nextFingerprints: StoreFingerprints = {};
		let snapshot: ZustandStoreSnapshot;
		try {
			const projectedState = adapter.getInspectableState();
			const sanitized = sanitizeDiagnosticValueWithMetadata(projectedState);
			const serialized = serializeValue(sanitized.value, maxValueBytes);
			nextFingerprints = topLevelFingerprints(sanitized.value, maxValueBytes);
			snapshot = {
				id: adapter.id,
				title: adapter.title,
				description: adapter.description,
				stateText: serialized.text,
				stateBytes: serialized.estimatedBytes,
				truncated: serialized.truncated || sanitized.truncated,
				keys: inspectableKeys(sanitized.value),
				updatedAt: at,
				capabilities: adapterCapabilities(adapter),
			};
		} catch (error) {
			const message = truncateText(errorMessage(error), 8 * 1024).text;
			snapshot = {
				id: adapter.id,
				title: adapter.title,
				description: adapter.description,
				stateText: '',
				stateBytes: 0,
				truncated: false,
				keys: [],
				updatedAt: at,
				capabilities: adapterCapabilities(adapter),
				error: message,
			};
		}

		const previousSnapshot = snapshots.get(adapter.id);
		const changedKeys = changedZustandKeys(
			fingerprints.get(adapter.id),
			nextFingerprints,
		);
		fingerprints.set(adapter.id, nextFingerprints);
		retainSnapshot(snapshot);
		if (
			recordChange &&
			(changedKeys.length > 0 || previousSnapshot?.error !== snapshot.error)
		) {
			eventStore.append({
				id: nextEventId,
				at,
				storeId: adapter.id,
				storeTitle: adapter.title,
				changedKeys,
				stateText: snapshot.stateText,
				truncated: snapshot.truncated,
				error: snapshot.error,
			});
			nextEventId += 1;
		}
	};

	const refresh = (): void => {
		try {
			const adapters = validatedAdapters();
			for (const adapter of adapters) capture(adapter, false);
			const activeIds = new Set(adapters.map((adapter) => adapter.id));
			for (const storeId of snapshots.keys()) {
				if (!activeIds.has(storeId)) {
					snapshots.delete(storeId);
					snapshotSizes.delete(storeId);
					fingerprints.delete(storeId);
				}
			}
			publish(adapters);
		} catch (error) {
			reportError(error);
			throw error;
		}
	};

	const enqueueMutation = <Result,>(
		operation: () => Promise<Result>,
	): Promise<Result> => {
		const result = mutationQueue.then(operation, operation);
		mutationQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};
	const normalizeStoreId = (storeId: unknown): string => {
		if (
			typeof storeId !== 'string' ||
			!storeId.trim() ||
			storeId !== storeId.trim() ||
			storeId.length > 256
		) {
			throw new Error('Zustand store id is invalid.');
		}
		return storeId;
	};
	const resolveAdapter = (storeId: unknown): DevToolsZustandAdapter => {
		const normalizedStoreId = normalizeStoreId(storeId);
		const adapter = validatedAdapters().find(
			(candidate) => candidate.id === normalizedStoreId,
		);
		if (!adapter) throw new Error('Zustand store is unavailable.');
		return adapter;
	};
	const resolveRestorableAdapter = (
		storeId: unknown,
	): RestorableZustandAdapter => {
		const adapter = resolveAdapter(storeId);
		if (
			adapter.restorable !== true ||
			!adapter.validatePatch ||
			!adapter.applyPatch
		) {
			throw new Error(
				'Zustand store is read-only because it has no complete rollback adapter.',
			);
		}
		return adapter as RestorableZustandAdapter;
	};
	const assertCurrentAdapter = (adapter: DevToolsZustandAdapter): void => {
		if (resolveAdapter(adapter.id) !== adapter) {
			throw new Error(
				'Zustand store adapter changed during the operation; refresh and try again.',
			);
		}
	};
	const canonicalizeWithAdapter = async (
		adapter: RestorableZustandAdapter,
		value: unknown,
		label: string,
	): Promise<CanonicalZustandState> => {
		const untrusted = canonicalizeTopLevelState(value, maxMutationBytes, label);
		assertPatchAvoidsSensitivePaths(
			untrusted.value,
			adapter.sensitivePaths ?? EMPTY_SENSITIVE_PATHS,
		);
		const validated = await adapter.validatePatch(JSON.parse(untrusted.json));
		const canonical = canonicalizeTopLevelState(
			validated,
			maxMutationBytes,
			`${label} validation result`,
		);
		assertPatchAvoidsSensitivePaths(
			canonical.value,
			adapter.sensitivePaths ?? EMPTY_SENSITIVE_PATHS,
		);
		return canonical;
	};
	const captureCanonicalState = async (
		adapter: RestorableZustandAdapter,
	): Promise<CanonicalZustandState> => {
		const observed = canonicalizeTopLevelState(
			adapter.getInspectableState(),
			maxMutationBytes,
			`Zustand state for ${adapter.id}`,
		);
		return canonicalizeWithAdapter(
			adapter,
			JSON.parse(observed.json),
			`Zustand state for ${adapter.id}`,
		);
	};
	const publicStateSnapshot = (
		snapshot: PrivateZustandStateSnapshot,
	): ZustandStateSnapshot =>
		Object.freeze({
			id: snapshot.id,
			storeId: snapshot.storeId,
			storeTitle: snapshot.storeTitle,
			createdAt: snapshot.createdAt,
			stateText: snapshot.stateText,
			stateBytes: snapshot.stateBytes,
			truncated: snapshot.truncated,
		});
	const recordStateSnapshot = (
		adapter: DevToolsZustandAdapter,
		canonical: CanonicalZustandState,
	): ZustandStateSnapshot => {
		const snapshot: PrivateZustandStateSnapshot = Object.freeze({
			id: `zustand-state-${nextStateSnapshotId++}`,
			storeId: adapter.id,
			storeTitle: adapter.title,
			createdAt: validateTimestamp(now()),
			stateText: canonical.preview,
			stateBytes: canonical.bytes,
			truncated: canonical.bytes > 8 * 1024,
			json: canonical.json,
		});
		stateSnapshotStore.set(
			Object.freeze(
				[...stateSnapshotStore.getSnapshot(), snapshot].slice(
					-maxStateSnapshots,
				),
			),
		);
		return publicStateSnapshot(snapshot);
	};
	const appendMutationEvent = (receipt: ZustandMutationReceipt): void => {
		try {
			options.eventStore?.append({
				source: 'zustand',
				kind: `mutation-${receipt.status}`,
				level:
					receipt.status === 'succeeded'
						? 'info'
						: receipt.status === 'needs-attention'
							? 'error'
							: 'warn',
				title: `Zustand ${receipt.kind} ${receipt.status}`,
				summary: receipt.error,
				...(receipt.correlationId
					? { correlationId: receipt.correlationId }
					: {}),
				resourceRef: { toolId: id, resourceId: receipt.id },
				attributes: {
					storeId: receipt.storeId,
					kind: receipt.kind,
					status: receipt.status,
				},
			});
		} catch {
			// The shared diagnostics timeline cannot change mutation outcomes.
		}
	};
	const recordMutationReceipt = (
		receipt: ZustandMutationReceipt,
	): ZustandMutationReceipt => {
		const frozen = Object.freeze({
			...receipt,
			changedKeys: Object.freeze([...receipt.changedKeys]),
		});
		mutationReceiptStore.set(
			Object.freeze(
				[...mutationReceiptStore.getSnapshot(), frozen].slice(
					-maxMutationReceipts,
				),
			),
		);
		appendMutationEvent(frozen);
		return frozen;
	};
	const settleMutationCapture = (adapter: DevToolsZustandAdapter): void => {
		const subscription = subscriptions.get(adapter.id);
		if (subscription) subscription.dirtyDuringMutation = false;
		try {
			assertCurrentAdapter(adapter);
			capture(adapter, true);
			publish(validatedAdapters());
		} catch (error) {
			reportError(error);
		}
	};
	const verifyPatchApplied = (
		patch: CanonicalZustandState,
		result: CanonicalZustandState,
	): void => {
		for (const key of Object.keys(patch.value)) {
			if (
				JSON.stringify(result.value[key]) !== JSON.stringify(patch.value[key])
			) {
				throw new Error(
					`Zustand adapter did not apply the validated ${key} field.`,
				);
			}
		}
	};
	const runMutation = (
		kind: ZustandMutationKind,
		storeId: string,
		payload: unknown,
		correlationValue?: string,
	): Promise<ZustandMutationReceipt> =>
		enqueueMutation(async () => {
			const startedAt = validateTimestamp(now());
			const receiptId = `zustand-mutation-${nextMutationReceiptId++}`;
			let correlationId: string | undefined;
			let adapter: RestorableZustandAdapter | undefined;
			let before: CanonicalZustandState | undefined;
			let observedBefore: CanonicalZustandState | undefined;
			let mutationStarted = false;
			let snapshotId: string | undefined;
			let changedKeys: readonly string[] = [];
			try {
				correlationId = normalizeCorrelationId(correlationValue);
				adapter = resolveRestorableAdapter(storeId);
				if (kind === 'reset' && !adapter.reset) {
					throw new Error('Zustand store has no explicit reset adapter.');
				}
				observedBefore = canonicalizeTopLevelState(
					adapter.getInspectableState(),
					maxMutationBytes,
					`Zustand state for ${adapter.id}`,
				);
				before = await canonicalizeWithAdapter(
					adapter,
					JSON.parse(observedBefore.json),
					`Zustand state for ${adapter.id}`,
				);
				let desired: CanonicalZustandState | undefined;
				if (kind === 'patch') {
					desired = await canonicalizeWithAdapter(
						adapter,
						payload,
						`Zustand patch for ${adapter.id}`,
					);
				} else if (kind === 'jump') {
					if (
						typeof payload !== 'string' ||
						!payload.trim() ||
						payload !== payload.trim() ||
						payload.length > 256
					) {
						throw new Error('Zustand state snapshot id is invalid.');
					}
					const snapshot = stateSnapshotStore
						.getSnapshot()
						.find(
							(candidate) =>
								candidate.id === payload && candidate.storeId === adapter?.id,
						);
					if (!snapshot) {
						throw new Error(
							'Zustand state snapshot is unavailable or belongs to another store.',
						);
					}
					snapshotId = snapshot.id;
					desired = await canonicalizeWithAdapter(
						adapter,
						JSON.parse(snapshot.json),
						`Zustand snapshot ${snapshot.id}`,
					);
				}
				assertCurrentAdapter(adapter);
				const currentObserved = canonicalizeTopLevelState(
					adapter.getInspectableState(),
					maxMutationBytes,
					`Zustand state for ${adapter.id}`,
				);
				if (currentObserved.json !== observedBefore.json) {
					throw new Error(
						'Zustand store changed while the operation was being validated; retry with the latest state.',
					);
				}
				mutatingStoreIds.add(adapter.id);
				mutationStarted = true;
				if (kind === 'reset') {
					await adapter.reset?.();
				} else if (desired) {
					await adapter.applyPatch(JSON.parse(desired.json));
				}
				assertCurrentAdapter(adapter);
				const after = await captureCanonicalState(adapter);
				if (kind === 'jump' && desired?.json !== after.json) {
					throw new Error(
						'Zustand adapter did not restore the complete captured state.',
					);
				}
				if (kind === 'patch' && desired) verifyPatchApplied(desired, after);
				changedKeys = changedZustandKeys(
					topLevelFingerprints(before.value, maxMutationBytes),
					topLevelFingerprints(after.value, maxMutationBytes),
				);
				recordStateSnapshot(adapter, before);
				const afterSnapshot = recordStateSnapshot(adapter, after);
				if (kind !== 'jump') snapshotId = afterSnapshot.id;
				const receipt = recordMutationReceipt({
					id: receiptId,
					storeId: adapter.id,
					kind,
					status: 'succeeded',
					startedAt,
					completedAt: validateTimestamp(now()),
					changedKeys,
					...(correlationId ? { correlationId } : {}),
					...(snapshotId ? { snapshotId } : {}),
				});
				return receipt;
			} catch (error) {
				let status: ZustandMutationReceipt['status'] = 'failed';
				let failure = truncateText(errorMessage(error), 8 * 1024).text;
				let shouldRollback = mutationStarted;
				if (!shouldRollback && adapter && before && observedBefore) {
					try {
						const currentObserved = canonicalizeTopLevelState(
							adapter.getInspectableState(),
							maxMutationBytes,
							`Zustand state for ${adapter.id}`,
						);
						shouldRollback = currentObserved.json !== observedBefore.json;
					} catch {
						shouldRollback = true;
					}
				}
				if (shouldRollback && adapter && before) {
					try {
						await adapter.applyPatch(JSON.parse(before.json));
						const restored = await captureCanonicalState(adapter);
						if (restored.json !== before.json) {
							throw new Error(
								'Rollback verification did not match prior state.',
							);
						}
						status = 'rolled-back';
					} catch (rollbackError) {
						status = 'needs-attention';
						failure = `${failure} Rollback failed: ${truncateText(errorMessage(rollbackError), 4 * 1024).text}`;
					}
				}
				const receipt = recordMutationReceipt({
					id: receiptId,
					storeId:
						adapter?.id ??
						(typeof storeId === 'string' ? storeId.slice(0, 256) : 'unknown'),
					kind,
					status,
					startedAt,
					completedAt: validateTimestamp(now()),
					changedKeys,
					...(correlationId ? { correlationId } : {}),
					...(snapshotId ? { snapshotId } : {}),
					error: failure,
				});
				throw new Error(
					`${receipt.error}${status === 'rolled-back' ? ' The prior state was restored.' : ''}`,
				);
			} finally {
				if (adapter) {
					mutatingStoreIds.delete(adapter.id);
					settleMutationCapture(adapter);
				}
			}
		});
	const captureState = (storeId: string): Promise<ZustandStateSnapshot> =>
		enqueueMutation(async () => {
			const adapter = resolveRestorableAdapter(storeId);
			const canonical = await captureCanonicalState(adapter);
			assertCurrentAdapter(adapter);
			return recordStateSnapshot(adapter, canonical);
		});

	const scheduleCapture = (subscription: ZustandSubscription): void => {
		if (mutatingStoreIds.has(subscription.adapter.id)) {
			subscription.dirtyDuringMutation = true;
			return;
		}
		if (subscription.captureQueued) return;
		subscription.captureQueued = true;
		const runCapture = () => {
			subscription.captureQueued = false;
			if (!subscription.active || installCount === 0) return;
			try {
				capture(subscription.adapter, true);
				publish(validatedAdapters());
			} catch (error) {
				reportError(error);
			}
		};
		try {
			queueMicrotask(runCapture);
		} catch (error) {
			subscription.captureQueued = false;
			reportError(error);
		}
	};

	const reconcileSubscriptions = (): void => {
		const adapters = validatedAdapters();
		const activeIds = new Set(adapters.map((adapter) => adapter.id));
		for (const [storeId, subscription] of subscriptions) {
			const nextAdapter = adapters.find((adapter) => adapter.id === storeId);
			if (!activeIds.has(storeId) || nextAdapter !== subscription.adapter) {
				subscription.active = false;
				try {
					subscription.dispose();
				} catch {
					// A diagnostic adapter disposer must not interrupt the host app.
				}
				subscriptions.delete(storeId);
			}
		}
		for (const adapter of adapters) {
			if (subscriptions.has(adapter.id)) continue;
			capture(adapter, false);
			const subscription: ZustandSubscription = {
				adapter,
				dispose: () => {},
				active: true,
				captureQueued: false,
				dirtyDuringMutation: false,
			};
			try {
				const dispose = adapter.subscribe(() => {
					if (!subscription.active || installCount === 0) return;
					// A capture sanitizes and serializes the whole projection several
					// times over. Host stores can call set() many times per frame (a
					// store that updates every second plus once per edit), so
					// coalesce to one capture per task instead of one per set().
					scheduleCapture(subscription);
				});
				if (typeof dispose !== 'function') {
					throw new Error('Subscription did not return a disposer.');
				}
				subscription.dispose = dispose;
				subscriptions.set(adapter.id, subscription);
			} catch (error) {
				subscription.active = false;
				const subscriptionError = truncateText(
					`Subscription failed: ${errorMessage(error)}`,
					8 * 1024,
				).text;
				const snapshot = snapshots.get(adapter.id);
				if (snapshot) {
					retainSnapshot({
						...snapshot,
						updatedAt: Date.now(),
						error: subscriptionError,
					});
				}
				eventStore.append({
					id: nextEventId,
					at: Date.now(),
					storeId: adapter.id,
					storeTitle: adapter.title,
					changedKeys: [],
					stateText: '',
					truncated: false,
					error: subscriptionError,
				});
				nextEventId += 1;
			}
		}
		const activeSnapshots = new Set(adapters.map((adapter) => adapter.id));
		for (const storeId of snapshots.keys()) {
			if (!activeSnapshots.has(storeId)) {
				snapshots.delete(storeId);
				snapshotSizes.delete(storeId);
				fingerprints.delete(storeId);
			}
		}
		publish(adapters);
	};

	function ZustandPanel({ onBack, actions }: DevToolsPanelProps) {
		const snapshot = useSyncExternalStore(
			snapshotStore.subscribe,
			snapshotStore.getSnapshot,
			snapshotStore.getServerSnapshot,
		);
		const events = useSyncExternalStore(
			eventStore.subscribe,
			eventStore.getSnapshot,
			eventStore.getServerSnapshot,
		);
		const stateSnapshotHistory = useSyncExternalStore(
			stateSnapshotStore.subscribe,
			stateSnapshotStore.getSnapshot,
			stateSnapshotStore.getServerSnapshot,
		);
		const mutationReceipts = useSyncExternalStore(
			mutationReceiptStore.subscribe,
			mutationReceiptStore.getSnapshot,
			mutationReceiptStore.getServerSnapshot,
		);
		const [search, setSearch] = useState('');
		const [patchDrafts, setPatchDrafts] = useState<Record<string, string>>({});
		const needle = search.trim().toLowerCase();
		const visibleStores = useMemo(
			() =>
				snapshot.stores.filter(
					(store) =>
						!needle ||
						store.title.toLowerCase().includes(needle) ||
						store.id.toLowerCase().includes(needle) ||
						store.keys.some((key) => key.toLowerCase().includes(needle)),
				),
			[snapshot.stores, needle],
		);
		const recentEvents = [...events].reverse().slice(0, 20);
		const recentMutationReceipts = [...mutationReceipts].reverse().slice(0, 20);
		const now = Date.now();
		const patchDraft = (storeId: string): string =>
			patchDrafts[storeId] ?? '{}';
		const updatePatchDraft = (storeId: string, value: string): void => {
			setPatchDrafts((current) => ({ ...current, [storeId]: value }));
		};
		const storeStateSnapshots = (
			storeId: string,
		): readonly ZustandStateSnapshot[] =>
			stateSnapshotHistory
				.filter((snapshot) => snapshot.storeId === storeId)
				.map(publicStateSnapshot);
		const runStoreMutation = (
			label: string,
			action: () => unknown | Promise<unknown>,
			confirmation?: DevToolsActionConfirmation,
		): void => {
			void actions.run({ pluginId: id, label, action, confirmation });
		};
		const applyStoreDraft = (store: ZustandStoreSnapshot): void => {
			runStoreMutation(`Apply Zustand patch to ${store.title}`, () => {
				const patch: unknown = JSON.parse(patchDraft(store.id));
				return runMutation('patch', store.id, patch);
			});
		};
		const captureStoreState = (store: ZustandStoreSnapshot): void => {
			runStoreMutation(`Capture Zustand state for ${store.title}`, () =>
				captureState(store.id),
			);
		};
		const resetStoreState = (store: ZustandStoreSnapshot): void => {
			runStoreMutation(
				`Reset Zustand store ${store.title}`,
				() => runMutation('reset', store.id, undefined),
				{
					title: `Reset ${store.title}?`,
					message:
						'The store will be reset through its explicit adapter. The prior state is restored if verification fails.',
					confirmLabel: 'Reset',
					destructive: true,
				},
			);
		};
		const jumpToStoreSnapshot = (
			store: ZustandStoreSnapshot,
			stateSnapshot: ZustandStateSnapshot,
		): void => {
			runStoreMutation(
				`Restore Zustand state for ${store.title}`,
				() => runMutation('jump', store.id, stateSnapshot.id),
				{
					title: `Restore ${store.title}?`,
					message: `Restore the state captured at ${new Date(stateSnapshot.createdAt).toLocaleTimeString()}? The current state is checkpointed first.`,
					confirmLabel: 'Restore',
				},
			);
		};
		const clearRecordedChanges = () => {
			void actions.run({
				pluginId: id,
				label: 'Clear Zustand changes',
				action: eventStore.clear,
			});
		};

		return (
			<PanelShell
				onBack={onBack}
				title={title}
				trailing={
					<NavIconButton
						accessibilityLabel="Refresh Zustand projections"
						onPress={() => {
							void actions.run({
								pluginId: id,
								label: 'Refresh Zustand projections',
								action: refresh,
							});
						}}
						systemImage="arrow.clockwise"
						testID="devtools-zustand-refresh"
					/>
				}
			>
				{Platform.OS === 'ios' ? (
					<Host style={{ flex: 1 }}>
						<List modifiers={[listStyle('insetGrouped')]}>
							<Section>
								<TextField
									modifiers={[autocorrectionDisabled()]}
									onTextChange={setSearch}
									placeholder="Search stores or fields"
								/>
							</Section>
							<Section
								footer={
									<UIText>
										Only host-declared projections are captured. Raw Zustand
										stores are never discovered automatically.
									</UIText>
								}
								title={`Stores · ${visibleStores.length}`}
							>
								{snapshot.error ? (
									<Label
										color={PlatformColor('systemOrangeColor')}
										systemImage="exclamationmark.triangle.fill"
										title={`Inspector unavailable · ${snapshot.error}`}
									/>
								) : null}
								{snapshot.truncated ? (
									<Label
										color={PlatformColor('systemOrangeColor')}
										systemImage="exclamationmark.triangle.fill"
										title={`${snapshot.omittedStoreCount} ${snapshot.omittedStoreCount === 1 ? 'store was' : 'stores were'} omitted by safe capture limits`}
									/>
								) : null}
								{visibleStores.length === 0 ? (
									<ContentUnavailableView
										description={
											needle
												? 'No registered projection matches this search.'
												: 'The host has not registered an inspectable store.'
										}
										systemImage="shippingbox"
										title={needle ? 'No matching stores' : 'No stores'}
									/>
								) : (
									visibleStores.map((store) => (
										<DisclosureGroup
											key={store.id}
											label={`${store.title} — ${describeStore(store)}`}
										>
											{store.description ? (
												<UIText>{store.description}</UIText>
											) : null}
											<LabeledContent label="Adapter">
												<UIText>{store.id}</UIText>
											</LabeledContent>
											<LabeledContent label="Updated">
												<UIText>
													{formatRelativeTime(store.updatedAt, now)}
												</UIText>
											</LabeledContent>
											<LabeledContent label="Access">
												<UIText>{zustandCapabilityLabel(store)}</UIText>
											</LabeledContent>
											{store.error ? (
												<Label
													color={PlatformColor('systemOrangeColor')}
													systemImage="exclamationmark.triangle.fill"
													title={store.error}
												/>
											) : (
												<UIText
													modifiers={[
														font({
															design: 'monospaced',
															textStyle: 'footnote',
														}),
														foregroundStyle('secondary'),
														lineLimit(20),
													]}
												>
													{store.stateText}
												</UIText>
											)}
											{store.capabilities.restorable ? (
												<>
													<TextField
														axis="vertical"
														modifiers={[
															autocorrectionDisabled(),
															font({
																design: 'monospaced',
																textStyle: 'footnote',
															}),
															lineLimit(8),
														]}
														onTextChange={(value) =>
															updatePatchDraft(store.id, value)
														}
														placeholder='{"field":"value"}'
													/>
													<Button
														label="Apply validated patch"
														onPress={() => applyStoreDraft(store)}
													/>
													<Button
														label="Capture state"
														onPress={() => captureStoreState(store)}
													/>
													{store.capabilities.resettable ? (
														<Button
															label="Reset store"
															onPress={() => resetStoreState(store)}
														/>
													) : null}
													{storeStateSnapshots(store.id)
														.slice(-3)
														.reverse()
														.map((stateSnapshot) => (
															<Button
																key={stateSnapshot.id}
																label={`Restore ${new Date(stateSnapshot.createdAt).toLocaleTimeString()}`}
																onPress={() =>
																	jumpToStoreSnapshot(store, stateSnapshot)
																}
															/>
														))}
												</>
											) : null}
										</DisclosureGroup>
									))
								)}
							</Section>
							<Section title={`Recent changes · ${recentEvents.length}`}>
								{recentEvents.length === 0 ? (
									<UIText modifiers={[foregroundStyle('secondary')]}>
										No projected state changes recorded this session.
									</UIText>
								) : (
									recentEvents.map((event) => (
										<DisclosureGroup
											key={event.id}
											label={`${event.storeTitle} — ${changeLabel(event)}`}
										>
											<UIText modifiers={[foregroundStyle('secondary')]}>
												{new Date(event.at).toLocaleTimeString()}
											</UIText>
											{event.stateText ? (
												<UIText
													modifiers={[
														font({
															design: 'monospaced',
															textStyle: 'footnote',
														}),
														lineLimit(12),
													]}
												>
													{event.stateText}
												</UIText>
											) : null}
										</DisclosureGroup>
									))
								)}
								{events.length > 0 ? (
									<Button
										label="Clear recorded changes"
										onPress={clearRecordedChanges}
									/>
								) : null}
							</Section>
							<Section
								title={`Mutation receipts · ${recentMutationReceipts.length}`}
							>
								{recentMutationReceipts.length === 0 ? (
									<UIText modifiers={[foregroundStyle('secondary')]}>
										No Zustand mutations recorded.
									</UIText>
								) : (
									recentMutationReceipts.map((receipt) => (
										<Label
											key={receipt.id}
											systemImage={
												receipt.status === 'succeeded'
													? 'checkmark.circle.fill'
													: 'exclamationmark.triangle.fill'
											}
											title={`${receipt.storeId} · ${receipt.kind} · ${receipt.status}`}
										/>
									))
								)}
							</Section>
						</List>
					</Host>
				) : (
					<AndroidPanelScroll>
						<AndroidPanelSearch
							onChangeText={setSearch}
							placeholder="Search stores or fields"
							value={search}
						/>
						<AndroidPanelSection
							footer="Only host-declared projections are captured. Raw Zustand stores are never discovered automatically."
							title={`Stores · ${visibleStores.length}`}
						>
							{snapshot.error ? (
								<AndroidPanelRow
									detail={snapshot.error}
									label="Inspector unavailable"
									tone="warning"
								/>
							) : null}
							{snapshot.truncated ? (
								<AndroidPanelRow
									detail={`${snapshot.omittedStoreCount} ${snapshot.omittedStoreCount === 1 ? 'store was' : 'stores were'} omitted by safe capture limits.`}
									label="Capture limited"
									tone="warning"
								/>
							) : null}
							{visibleStores.length === 0 ? (
								<AndroidPanelRow
									detail={
										needle
											? 'No registered projection matches this search.'
											: 'The host has not registered an inspectable store.'
									}
									label={needle ? 'No matching stores' : 'No stores'}
								/>
							) : null}
						</AndroidPanelSection>
						{visibleStores.map((store) => (
							<AndroidPanelSection
								footer={store.description}
								key={store.id}
								title={store.title}
							>
								<AndroidPanelRow label="Adapter" value={store.id} />
								<AndroidPanelRow
									label="Updated"
									value={formatRelativeTime(store.updatedAt, now)}
								/>
								<AndroidPanelRow
									label="Projection"
									value={describeStore(store)}
								/>
								<AndroidPanelRow
									label="Access"
									value={zustandCapabilityLabel(store)}
								/>
								<AndroidPanelTextBlock
									label={store.error ? 'Error' : 'State'}
									tone={store.error ? 'warning' : 'default'}
									value={store.error ?? store.stateText}
								/>
								{store.capabilities.restorable ? (
									<>
										<AndroidPanelSearch
											onChangeText={(value) =>
												updatePatchDraft(store.id, value)
											}
											placeholder='JSON patch, for example {"field":"value"}'
											value={patchDraft(store.id)}
										/>
										<AndroidPanelRow
											label="Apply validated patch"
											onPress={() => applyStoreDraft(store)}
										/>
										<AndroidPanelRow
											label="Capture state"
											onPress={() => captureStoreState(store)}
										/>
										{store.capabilities.resettable ? (
											<AndroidPanelRow
												label="Reset store"
												onPress={() => resetStoreState(store)}
											/>
										) : null}
										{storeStateSnapshots(store.id)
											.slice(-3)
											.reverse()
											.map((stateSnapshot) => (
												<AndroidPanelRow
													key={stateSnapshot.id}
													label={`Restore ${new Date(stateSnapshot.createdAt).toLocaleTimeString()}`}
													onPress={() =>
														jumpToStoreSnapshot(store, stateSnapshot)
													}
												/>
											))}
									</>
								) : null}
							</AndroidPanelSection>
						))}
						<AndroidPanelSection
							title={`Recent changes · ${recentEvents.length}`}
						>
							{recentEvents.length === 0 ? (
								<AndroidPanelRow label="No projected state changes this session" />
							) : (
								recentEvents.map((event) => (
									<AndroidPanelTextBlock
										key={event.id}
										label={`${event.storeTitle} · ${new Date(event.at).toLocaleTimeString()}`}
										tone={event.error ? 'warning' : 'default'}
										value={`${changeLabel(event)}${event.stateText ? `\n${event.stateText}` : ''}`}
									/>
								))
							)}
							{events.length > 0 ? (
								<AndroidPanelRow
									label="Clear recorded changes"
									onPress={clearRecordedChanges}
								/>
							) : null}
						</AndroidPanelSection>
						<AndroidPanelSection
							title={`Mutation receipts · ${recentMutationReceipts.length}`}
						>
							{recentMutationReceipts.length === 0 ? (
								<AndroidPanelRow label="No Zustand mutations recorded" />
							) : (
								recentMutationReceipts.map((receipt) => (
									<AndroidPanelRow
										key={receipt.id}
										label={`${receipt.storeId} · ${receipt.kind}`}
										tone={
											receipt.status === 'succeeded' ? 'default' : 'warning'
										}
										value={receipt.status}
									/>
								))
							)}
						</AndroidPanelSection>
					</AndroidPanelScroll>
				)}
			</PanelShell>
		);
	}

	const plugin: DevToolsPanelPlugin = {
		id,
		title,
		description:
			options.description ??
			'Inspect explicit, privacy-safe Zustand projections',
		systemImage: options.systemImage ?? 'shippingbox.fill',
		tint:
			Platform.OS === 'ios' ? PlatformColor('systemPurpleColor') : '#AF52DE',
		section: options.section,
		Panel: ZustandPanel,
		install: () => {
			installCount += 1;
			if (installCount === 1) {
				try {
					reconcileSubscriptions();
				} catch (error) {
					reportError(error);
				}
				let pendingRegistrySubscription:
					| { active: boolean; dispose: () => void }
					| undefined;
				try {
					if (options.subscribeToStores) {
						const registrySubscription = {
							active: true,
							dispose: () => {},
						};
						pendingRegistrySubscription = registrySubscription;
						const dispose = options.subscribeToStores(() => {
							if (!registrySubscription.active || installCount === 0) return;
							try {
								reconcileSubscriptions();
							} catch (error) {
								reportError(error);
							}
						});
						if (typeof dispose !== 'function') {
							registrySubscription.active = false;
							throw new Error(
								'Store registry subscription did not return a disposer.',
							);
						}
						registrySubscription.dispose = dispose;
						storeRegistrySubscription = registrySubscription;
					}
				} catch (error) {
					if (pendingRegistrySubscription) {
						pendingRegistrySubscription.active = false;
					}
					storeRegistrySubscription = undefined;
					reportError(error);
				}
			}
			let referenceActive = true;
			return () => {
				if (!referenceActive) return;
				referenceActive = false;
				installCount = Math.max(0, installCount - 1);
				if (installCount !== 0) return;
				const registrySubscription = storeRegistrySubscription;
				storeRegistrySubscription = undefined;
				if (registrySubscription) registrySubscription.active = false;
				try {
					registrySubscription?.dispose();
				} catch {
					// Unmount remains safe when a registry disposer is faulty.
				}
				for (const subscription of subscriptions.values()) {
					subscription.active = false;
					try {
						subscription.dispose();
					} catch {
						// Continue disposing the remaining adapters.
					}
				}
				subscriptions.clear();
			};
		},
	};

	return {
		plugin,
		refresh,
		getSnapshot: snapshotStore.getSnapshot,
		getEvents: eventStore.getSnapshot,
		clearEvents: eventStore.clear,
		applyPatch: (storeId, patch, correlationId) =>
			runMutation('patch', storeId, patch, correlationId),
		resetStore: (storeId, correlationId) =>
			runMutation('reset', storeId, undefined, correlationId),
		jumpToState: (storeId, snapshotId, correlationId) =>
			runMutation('jump', storeId, snapshotId, correlationId),
		captureState,
		getStateSnapshots: (storeId) => {
			const normalizedStoreId =
				storeId === undefined ? undefined : normalizeStoreId(storeId);
			return Object.freeze(
				stateSnapshotStore
					.getSnapshot()
					.filter(
						(snapshot) =>
							!normalizedStoreId || snapshot.storeId === normalizedStoreId,
					)
					.map(publicStateSnapshot),
			);
		},
		getMutationReceipts: mutationReceiptStore.getSnapshot,
	};
}

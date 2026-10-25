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
import { ExternalStore } from '../core/external-store';
import { assertPositiveFinite, assertPositiveInteger } from '../core/options';
import {
	diagnosticErrorText,
	redactDiagnosticText,
	sanitizeDiagnosticValue,
	sanitizeDiagnosticValueWithMetadata,
} from '../core/redact';
import { createRefCountedInstaller } from '../core/ref-counted-installer';
import {
	serializeValue,
	truncateText,
	utf8ByteLength,
} from '../core/serialize';
import type {
	DevToolsPanelPlugin,
	DevToolsPanelProps,
	DevToolsSystemImage,
} from '../types';

export type ComponentTargetBounds = {
	x: number;
	y: number;
	width: number;
	height: number;
};

const COMPONENT_TARGET_ACTIONS = [
	'activate',
	'focus',
	'setText',
	'scroll',
] as const;

export type ComponentTargetAction = (typeof COMPONENT_TARGET_ACTIONS)[number];

export type ComponentTargetActionRequest =
	| { type: 'activate' }
	| { type: 'focus' }
	| { type: 'setText'; text: string }
	| {
			type: 'scroll';
			direction: 'up' | 'down' | 'left' | 'right';
			amount?: number;
	  };

/** Plain metadata for a component the host has deliberately made inspectable. */
export type ComponentTargetInput = {
	/** Source-addressable identifier for this mounted instance. */
	id: string;
	/** Logical target identity. Multiple mounted instances may share it. */
	targetId?: string;
	/** Source-addressable parent instance identifier. */
	parentId?: string;
	depth?: number;
	zIndex?: number;
	name: string;
	kind?: string;
	feature?: string;
	route?: string;
	testID?: string;
	targetKey?: string;
	sourceFiles?: readonly string[];
	instance?: Readonly<Record<string, unknown>>;
	bounds?: ComponentTargetBounds | null;
	isFocused?: boolean;
	accessibilityLabel?: string;
	accessibilityHint?: string;
	accessibilityRole?: string;
	accessibilityValue?: string;
	accessibilityState?: Readonly<Record<string, boolean | string>>;
	/** Explicitly allowlisted computed attributes; never raw React props. */
	styles?: Readonly<Record<string, unknown>>;
	actions?: readonly ComponentTargetAction[];
};

export type ComponentTargetSnapshot = {
	id: string;
	targetId: string;
	parentId?: string;
	depth: number;
	zIndex: number;
	name: string;
	kind: string;
	feature?: string;
	route?: string;
	testID?: string;
	targetKey?: string;
	sourceFiles: readonly string[];
	instanceText?: string;
	instanceTruncated: boolean;
	bounds: ComponentTargetBounds | null;
	isFocused: boolean;
	accessibilityLabel?: string;
	accessibilityHint?: string;
	accessibilityRole?: string;
	accessibilityValue?: string;
	accessibilityState?: Readonly<Record<string, boolean | string>>;
	styleText?: string;
	styleTruncated: boolean;
	actions: readonly ComponentTargetAction[];
	screenHash: string;
};

export type ComponentRegistrationDiagnostic = Readonly<{
	code: 'duplicate-target-id' | 'orphan-parent' | 'invalid-hierarchy';
	targetId: string;
	instanceIds: readonly string[];
	message: string;
}>;

export type ComponentRenderPhase = 'mount' | 'update' | 'nested-update';
export type ComponentRenderCause =
	| 'mount'
	| 'props'
	| 'tracked-state'
	| 'parent'
	| 'unknown';

/** A bounded profiler envelope. It intentionally contains no props or state. */
export type ComponentRenderEventInput = Readonly<{
	id: string;
	targetId: string;
	at: number;
	phase: ComponentRenderPhase;
	actualDuration: number;
	baseDuration: number;
	startTime: number;
	commitTime: number;
	renderCount: number;
	cause?: ComponentRenderCause;
	changedKeys?: readonly string[];
}>;

export type ComponentRenderEvent = Readonly<{
	id: string;
	targetId: string;
	at: number;
	phase: ComponentRenderPhase;
	actualDuration: number;
	baseDuration: number;
	startTime: number;
	commitTime: number;
	renderCount: number;
	cause: ComponentRenderCause;
	changedKeys: readonly string[];
}>;

export type ComponentRenderSource = {
	getSnapshot: () => readonly ComponentRenderEventInput[];
	subscribe: (listener: () => void) => () => void;
};

export type ComponentTargetSource = {
	getSnapshot: () => readonly ComponentTargetInput[];
	subscribe: (listener: () => void) => () => void;
	refresh?: () => void | Promise<void>;
	highlight?: (targetId: string) => void | Promise<void>;
	performAction?: (
		targetId: string,
		action: ComponentTargetActionRequest,
	) => void | Promise<void>;
};

export type ComponentInspectorPluginOptions = {
	source: ComponentTargetSource;
	renderSource?: ComponentRenderSource;
	visuals?: ComponentInspectorVisualController;
	maxTargets?: number;
	maxRenderEvents?: number;
	maxInstanceBytes?: number;
	maxTextBytes?: number;
	maxSnapshotBytes?: number;
	title?: string;
	id?: string;
	description?: string;
	section?: string;
	systemImage?: DevToolsSystemImage;
};

export type ComponentInspectorVisualState = Readonly<{
	debugBorders: boolean;
	inspectMode: boolean;
	updateHighlights: boolean;
}>;

export type ComponentInspectorVisualController = {
	getSnapshot: () => ComponentInspectorVisualState;
	getServerSnapshot?: () => ComponentInspectorVisualState;
	subscribe: (listener: () => void) => () => void;
	setDebugBorders: (enabled: boolean) => void;
	setInspectMode: (enabled: boolean) => void;
	setUpdateHighlights: (enabled: boolean) => void;
};

export type ComponentInspectorSnapshot = {
	targets: readonly ComponentTargetSnapshot[];
	diagnostics: readonly ComponentRegistrationDiagnostic[];
	sourceTargetCount: number;
	omittedTargetCount: number;
	screenHash: string;
	error?: string;
};

export type ComponentInspectorPlugin = {
	plugin: DevToolsPanelPlugin;
	subscribe: (listener: () => void) => () => void;
	subscribeRenderEvents: (listener: () => void) => () => void;
	refresh: () => Promise<void>;
	getTargets: () => readonly ComponentTargetSnapshot[];
	getSnapshot: () => ComponentInspectorSnapshot;
	getRenderEvents: () => readonly ComponentRenderEvent[];
	highlight: (targetId: string) => Promise<void>;
	inspectPoint: (point: {
		x: number;
		y: number;
	}) => readonly ComponentTargetSnapshot[];
	performAction: (
		targetId: string,
		screenHash: string,
		action: ComponentTargetActionRequest,
	) => Promise<void>;
	waitForElement: (targetId: string, timeoutMs: number) => Promise<void>;
	waitForScreenChange: (screenHash: string, timeoutMs: number) => Promise<void>;
};

const MAX_COMPONENT_TARGETS = 5_000;
const MAX_COMPONENT_RENDER_EVENTS = 5_000;
const MAX_COMPONENT_INSTANCE_BYTES = 1024 * 1024;
const MAX_COMPONENT_TEXT_BYTES = 64 * 1024;
const MAX_COMPONENT_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const componentTargetActions = new Set<string>(COMPONENT_TARGET_ACTIONS);
const ACCESSIBILITY_STATE_KEYS = new Set([
	'busy',
	'checked',
	'disabled',
	'expanded',
	'selected',
]);
const DISABLED_VISUAL_STATE: ComponentInspectorVisualState = {
	debugBorders: false,
	inspectMode: false,
	updateHighlights: false,
};
const subscribeToDisabledVisualState = (): (() => void) => () => {};
const getDisabledVisualState = (): ComponentInspectorVisualState =>
	DISABLED_VISUAL_STATE;

function componentTargetArrayLength(value: unknown): number | null {
	try {
		if (!Array.isArray(value)) return null;
		const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
		return descriptor &&
			'value' in descriptor &&
			Number.isSafeInteger(descriptor.value) &&
			descriptor.value >= 0
			? descriptor.value
			: null;
	} catch {
		return null;
	}
}

function componentErrorText(error: unknown): string {
	return truncateText(diagnosticErrorText(error), 8 * 1024).text;
}

function roundedFinite(value: number): number {
	return Math.round(value * 10) / 10;
}

function normalizeBounds(
	bounds: ComponentTargetBounds | null | undefined,
): ComponentTargetBounds | null {
	if (!bounds || typeof bounds !== 'object') return null;
	if (
		![bounds.x, bounds.y, bounds.width, bounds.height].every(
			(value) => typeof value === 'number' && Number.isFinite(value),
		)
	) {
		return null;
	}
	return {
		x: roundedFinite(bounds.x),
		y: roundedFinite(bounds.y),
		width: Math.max(0, roundedFinite(bounds.width)),
		height: Math.max(0, roundedFinite(bounds.height)),
	};
}

function normalizedText(value: unknown, maxBytes: number): string | undefined {
	if (typeof value !== 'string') return undefined;
	const normalized = truncateText(
		redactDiagnosticText(value.trim()),
		maxBytes,
	).text;
	return normalized || undefined;
}

function normalizedTextList(
	values: readonly string[] | undefined,
	maxBytes: number,
	maxItems: number,
): readonly string[] {
	const sourceCount = componentTargetArrayLength(values);
	if (sourceCount === null) return [];
	const normalized = new Set<string>();
	const scanLimit = Math.min(sourceCount, Math.max(maxItems, maxItems * 4));
	for (let index = 0; index < scanLimit; index += 1) {
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = Object.getOwnPropertyDescriptor(values, String(index));
		} catch {
			continue;
		}
		if (!descriptor || !('value' in descriptor)) continue;
		const value = descriptor.value;
		if (typeof value !== 'string') continue;
		const next = normalizedText(value, maxBytes);
		if (next) normalized.add(next);
		if (normalized.size >= maxItems) break;
	}
	return [...normalized];
}

function normalizeComponentActions(
	value: unknown,
): readonly ComponentTargetAction[] {
	const sanitized = sanitizeDiagnosticValue(value);
	if (!Array.isArray(sanitized)) return [];
	const actions = new Set<ComponentTargetAction>();
	for (const entry of sanitized) {
		if (typeof entry !== 'string' || !componentTargetActions.has(entry))
			continue;
		actions.add(entry as ComponentTargetAction);
	}
	return [...actions];
}

function normalizeAccessibilityState(
	value: unknown,
	maxTextBytes: number,
): Readonly<Record<string, boolean | string>> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		return undefined;
	let descriptors: Record<string, PropertyDescriptor>;
	try {
		descriptors = Object.getOwnPropertyDescriptors(value);
	} catch {
		return undefined;
	}
	const state: Record<string, boolean | string> = Object.create(null);
	for (const [key, descriptor] of Object.entries(descriptors)) {
		if (!ACCESSIBILITY_STATE_KEYS.has(key) || !('value' in descriptor))
			continue;
		if (typeof descriptor.value === 'boolean') {
			state[key] = descriptor.value;
			continue;
		}
		const normalized = normalizedText(descriptor.value, maxTextBytes);
		if (normalized) state[key] = normalized;
	}
	return Object.keys(state).length > 0 ? state : undefined;
}

function componentScreenHash(
	targets: readonly ComponentTargetSnapshot[],
): string {
	let hash = 0x811c9dc5;
	const update = (value: string): void => {
		for (let index = 0; index < value.length; index += 1) {
			hash ^= value.charCodeAt(index);
			hash = Math.imul(hash, 0x01000193);
		}
	};
	for (const target of targets) {
		update(target.id);
		update(target.targetId);
		update(target.parentId ?? '');
		update(String(target.depth));
		update(String(target.zIndex));
		update(target.name);
		update(target.route ?? '');
		update(target.accessibilityLabel ?? '');
		update(target.accessibilityValue ?? '');
		update(JSON.stringify(target.accessibilityState ?? {}));
		update(JSON.stringify(target.bounds));
		update(target.isFocused ? '1' : '0');
		update(target.actions.join(','));
	}
	return `screen-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function normalizeHierarchyNumber(
	value: unknown,
	options: { integer: boolean; minimum: number; maximum: number },
): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
	const normalized = options.integer ? Math.trunc(value) : roundedFinite(value);
	return Math.min(options.maximum, Math.max(options.minimum, normalized));
}

function normalizeComponentCapture(
	targets: readonly ComponentTargetInput[],
	options: {
		maxTargets: number;
		maxInstanceBytes: number;
		maxTextBytes: number;
		maxSnapshotBytes?: number;
	},
): Readonly<{
	targets: readonly ComponentTargetSnapshot[];
	diagnostics: readonly ComponentRegistrationDiagnostic[];
}> {
	const sourceTargetCount = componentTargetArrayLength(targets);
	if (sourceTargetCount === null) return { targets: [], diagnostics: [] };
	const normalized: ComponentTargetSnapshot[] = [];
	const maxSnapshotBytes = options.maxSnapshotBytes ?? Number.POSITIVE_INFINITY;
	let snapshotBytes = 0;
	const ids = new Set<string>();
	for (
		let index = 0;
		index < Math.min(sourceTargetCount, MAX_COMPONENT_TARGETS);
		index += 1
	) {
		if (normalized.length >= options.maxTargets) break;
		let targetDescriptor: PropertyDescriptor | undefined;
		try {
			targetDescriptor = Object.getOwnPropertyDescriptor(
				targets,
				String(index),
			);
		} catch {
			continue;
		}
		if (!targetDescriptor || !('value' in targetDescriptor)) continue;
		const target = targetDescriptor.value;
		if (!target || typeof target !== 'object') continue;
		let descriptors: Record<string, PropertyDescriptor>;
		try {
			descriptors = Object.getOwnPropertyDescriptors(target);
		} catch {
			continue;
		}
		const dataProperty = (key: keyof ComponentTargetInput): unknown => {
			const descriptor = descriptors[key];
			return descriptor && 'value' in descriptor ? descriptor.value : undefined;
		};
		const rawId = dataProperty('id');
		const rawName = dataProperty('name');
		if (typeof rawId !== 'string' || typeof rawName !== 'string') continue;
		const id = rawId;
		const name = normalizedText(rawName, options.maxTextBytes);
		if (
			!id.trim() ||
			id !== id.trim() ||
			name === undefined ||
			utf8ByteLength(id) > 256 ||
			ids.has(id)
		) {
			continue;
		}
		const rawInstance = dataProperty('instance');
		const sanitizedInstance =
			rawInstance !== undefined
				? sanitizeDiagnosticValueWithMetadata(rawInstance)
				: undefined;
		const instance = sanitizedInstance
			? serializeValue(sanitizedInstance.value, options.maxInstanceBytes)
			: undefined;
		const rawStyles = dataProperty('styles');
		const sanitizedStyles =
			rawStyles === undefined
				? undefined
				: sanitizeDiagnosticValueWithMetadata(rawStyles);
		const styles = sanitizedStyles
			? serializeValue(
					sanitizedStyles.value,
					Math.min(options.maxInstanceBytes, 8 * 1024),
				)
			: undefined;
		const targetId =
			normalizedText(dataProperty('targetId'), 256) ??
			normalizedText(dataProperty('targetKey'), 256) ??
			normalizedText(dataProperty('testID'), 256) ??
			id;
		const next: ComponentTargetSnapshot = {
			id,
			targetId,
			parentId: normalizedText(dataProperty('parentId'), 256),
			depth: normalizeHierarchyNumber(dataProperty('depth'), {
				integer: true,
				minimum: 0,
				maximum: 100,
			}),
			zIndex: normalizeHierarchyNumber(dataProperty('zIndex'), {
				integer: false,
				minimum: -100_000,
				maximum: 100_000,
			}),
			name,
			kind:
				normalizedText(dataProperty('kind'), options.maxTextBytes) ??
				'component',
			feature: normalizedText(dataProperty('feature'), options.maxTextBytes),
			route: normalizedText(dataProperty('route'), options.maxTextBytes),
			testID: normalizedText(dataProperty('testID'), options.maxTextBytes),
			targetKey: normalizedText(
				dataProperty('targetKey'),
				options.maxTextBytes,
			),
			sourceFiles: normalizedTextList(
				sanitizeDiagnosticValue(dataProperty('sourceFiles')) as
					| readonly string[]
					| undefined,
				options.maxTextBytes,
				20,
			),
			instanceText: instance?.text,
			instanceTruncated:
				(instance?.truncated ?? false) ||
				(sanitizedInstance?.truncated ?? false),
			bounds: normalizeBounds(
				sanitizeDiagnosticValue(
					dataProperty('bounds'),
				) as ComponentTargetBounds | null,
			),
			isFocused: dataProperty('isFocused') === true,
			accessibilityLabel: normalizedText(
				dataProperty('accessibilityLabel'),
				options.maxTextBytes,
			),
			accessibilityHint: normalizedText(
				dataProperty('accessibilityHint'),
				options.maxTextBytes,
			),
			accessibilityRole: normalizedText(
				dataProperty('accessibilityRole'),
				options.maxTextBytes,
			),
			accessibilityValue: normalizedText(
				dataProperty('accessibilityValue'),
				options.maxTextBytes,
			),
			accessibilityState: normalizeAccessibilityState(
				dataProperty('accessibilityState'),
				options.maxTextBytes,
			),
			styleText: styles?.text,
			styleTruncated:
				(styles?.truncated ?? false) || (sanitizedStyles?.truncated ?? false),
			actions: normalizeComponentActions(dataProperty('actions')),
			screenHash: 'screen-00000000',
		};
		const nextBytes = utf8ByteLength(JSON.stringify(next));
		if (snapshotBytes + nextBytes > maxSnapshotBytes) continue;
		snapshotBytes += nextBytes;
		ids.add(id);
		normalized.push(next);
	}
	const screenHash = componentScreenHash(normalized);
	const normalizedWithHash = normalized.map((target) => ({
		...target,
		screenHash,
	}));
	const diagnostics: ComponentRegistrationDiagnostic[] = [];
	const byTargetId = new Map<string, string[]>();
	const byInstanceId = new Map(
		normalizedWithHash.map((target) => [target.id, target] as const),
	);
	for (const target of normalizedWithHash) {
		const instances = byTargetId.get(target.targetId) ?? [];
		instances.push(target.id);
		byTargetId.set(target.targetId, instances);
		if (target.parentId && !byInstanceId.has(target.parentId)) {
			diagnostics.push({
				code: 'orphan-parent',
				targetId: target.targetId,
				instanceIds: [target.id],
				message: `Parent instance is not registered: ${target.parentId}`,
			});
			continue;
		}
		const parent = target.parentId
			? byInstanceId.get(target.parentId)
			: undefined;
		if (
			target.parentId === target.id ||
			(parent !== undefined && parent.depth >= target.depth)
		) {
			diagnostics.push({
				code: 'invalid-hierarchy',
				targetId: target.targetId,
				instanceIds: [target.id],
				message: 'Component parent/depth metadata is inconsistent.',
			});
		}
	}
	for (const [targetId, instanceIds] of byTargetId) {
		if (instanceIds.length < 2) continue;
		diagnostics.push({
			code: 'duplicate-target-id',
			targetId,
			instanceIds,
			message: `${instanceIds.length} mounted instances share this target id.`,
		});
	}
	return { targets: normalizedWithHash, diagnostics };
}

export function normalizeComponentTargets(
	targets: readonly ComponentTargetInput[],
	options: {
		maxTargets: number;
		maxInstanceBytes: number;
		maxTextBytes: number;
		maxSnapshotBytes?: number;
	},
): readonly ComponentTargetSnapshot[] {
	return normalizeComponentCapture(targets, options).targets;
}

const COMPONENT_RENDER_PHASES = new Set<ComponentRenderPhase>([
	'mount',
	'update',
	'nested-update',
]);
const COMPONENT_RENDER_CAUSES = new Set<ComponentRenderCause>([
	'mount',
	'props',
	'tracked-state',
	'parent',
	'unknown',
]);

function finiteRenderMetric(
	value: unknown,
	maximum: number,
): number | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return Math.min(maximum, roundedFinite(value));
}

export function normalizeComponentRenderEvents(
	events: readonly ComponentRenderEventInput[],
	maxEvents: number,
): readonly ComponentRenderEvent[] {
	const sourceCount = componentTargetArrayLength(events);
	if (
		sourceCount === null ||
		!Number.isSafeInteger(maxEvents) ||
		maxEvents <= 0 ||
		maxEvents > MAX_COMPONENT_RENDER_EVENTS
	) {
		return [];
	}
	const normalized: ComponentRenderEvent[] = [];
	const seenIds = new Set<string>();
	const scanLimit = Math.min(sourceCount, maxEvents * 4);
	const start = Math.max(0, sourceCount - scanLimit);
	for (let index = start; index < sourceCount; index += 1) {
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = Object.getOwnPropertyDescriptor(events, String(index));
		} catch {
			continue;
		}
		if (!descriptor || !('value' in descriptor)) continue;
		const value = descriptor.value;
		if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
		let fields: Record<string, PropertyDescriptor>;
		try {
			fields = Object.getOwnPropertyDescriptors(value);
		} catch {
			continue;
		}
		const data = (key: keyof ComponentRenderEventInput): unknown => {
			const field = fields[key];
			return field && 'value' in field ? field.value : undefined;
		};
		const id = normalizedText(data('id'), 256);
		const targetId = normalizedText(data('targetId'), 256);
		const at = finiteRenderMetric(data('at'), 1_000_000_000_000_000);
		const actualDuration = finiteRenderMetric(data('actualDuration'), 60_000);
		const baseDuration = finiteRenderMetric(data('baseDuration'), 60_000);
		const startTime = finiteRenderMetric(
			data('startTime'),
			1_000_000_000_000_000,
		);
		const commitTime = finiteRenderMetric(
			data('commitTime'),
			1_000_000_000_000_000,
		);
		const phase = data('phase');
		const renderCount = data('renderCount');
		if (
			!id ||
			!targetId ||
			seenIds.has(id) ||
			at === undefined ||
			actualDuration === undefined ||
			baseDuration === undefined ||
			startTime === undefined ||
			commitTime === undefined ||
			typeof phase !== 'string' ||
			!COMPONENT_RENDER_PHASES.has(phase as ComponentRenderPhase) ||
			!Number.isSafeInteger(renderCount) ||
			(renderCount as number) <= 0 ||
			(renderCount as number) > 1_000_000_000
		) {
			continue;
		}
		const requestedCause = data('cause');
		const cause =
			typeof requestedCause === 'string' &&
			COMPONENT_RENDER_CAUSES.has(requestedCause as ComponentRenderCause)
				? (requestedCause as ComponentRenderCause)
				: phase === 'mount'
					? 'mount'
					: 'unknown';
		seenIds.add(id);
		normalized.push({
			id,
			targetId,
			at,
			phase: phase as ComponentRenderPhase,
			actualDuration,
			baseDuration,
			startTime,
			commitTime,
			renderCount: renderCount as number,
			cause,
			changedKeys: normalizedTextList(
				data('changedKeys') as readonly string[] | undefined,
				128,
				20,
			),
		});
		if (normalized.length > maxEvents) normalized.shift();
	}
	return normalized;
}

function boundsLabel(bounds: ComponentTargetBounds | null): string {
	if (!bounds) return 'Not measured';
	return `${bounds.width} × ${bounds.height} at (${bounds.x}, ${bounds.y})`;
}

function targetSearchText(target: ComponentTargetSnapshot): string {
	return [
		target.name,
		target.targetId,
		target.parentId,
		target.kind,
		target.feature,
		target.route,
		target.testID,
		target.targetKey,
		...target.sourceFiles,
	]
		.filter(Boolean)
		.join(' ')
		.toLowerCase();
}

export function componentTargetsAtPoint(
	targets: readonly ComponentTargetSnapshot[],
	point: { x: number; y: number },
): readonly ComponentTargetSnapshot[] {
	if (
		!Number.isFinite(point.x) ||
		!Number.isFinite(point.y) ||
		Math.abs(point.x) > 100_000 ||
		Math.abs(point.y) > 100_000
	) {
		return [];
	}
	return targets
		.filter((target) => {
			const bounds = target.bounds;
			return (
				target.isFocused &&
				bounds !== null &&
				point.x >= bounds.x &&
				point.x <= bounds.x + bounds.width &&
				point.y >= bounds.y &&
				point.y <= bounds.y + bounds.height
			);
		})
		.sort((left, right) => {
			const zDelta = right.zIndex - left.zIndex;
			if (zDelta !== 0) return zDelta;
			const depthDelta = right.depth - left.depth;
			if (depthDelta !== 0) return depthDelta;
			const leftArea = (left.bounds?.width ?? 0) * (left.bounds?.height ?? 0);
			const rightArea =
				(right.bounds?.width ?? 0) * (right.bounds?.height ?? 0);
			const areaDelta = leftArea - rightArea;
			return areaDelta !== 0 ? areaDelta : left.id.localeCompare(right.id);
		});
}

export function createComponentInspectorPlugin(
	options: ComponentInspectorPluginOptions,
): ComponentInspectorPlugin {
	const title = options.title ?? 'Component Inspector';
	const id = options.id ?? 'components';
	const maxTargets = options.maxTargets ?? 500;
	const maxRenderEvents = options.maxRenderEvents ?? 500;
	const maxInstanceBytes = options.maxInstanceBytes ?? 8 * 1024;
	const maxTextBytes = options.maxTextBytes ?? 2 * 1024;
	const maxSnapshotBytes = options.maxSnapshotBytes ?? 512 * 1024;
	assertPositiveInteger(maxTargets, 'maxTargets');
	assertPositiveInteger(maxRenderEvents, 'maxRenderEvents');
	assertPositiveFinite(maxInstanceBytes, 'maxInstanceBytes');
	assertPositiveFinite(maxTextBytes, 'maxTextBytes');
	assertPositiveFinite(maxSnapshotBytes, 'maxSnapshotBytes');
	if (maxTargets > MAX_COMPONENT_TARGETS) {
		throw new Error(`maxTargets cannot exceed ${MAX_COMPONENT_TARGETS}`);
	}
	if (maxRenderEvents > MAX_COMPONENT_RENDER_EVENTS) {
		throw new Error(
			`maxRenderEvents cannot exceed ${MAX_COMPONENT_RENDER_EVENTS}`,
		);
	}
	if (maxInstanceBytes > MAX_COMPONENT_INSTANCE_BYTES) {
		throw new Error(
			`maxInstanceBytes cannot exceed ${MAX_COMPONENT_INSTANCE_BYTES}`,
		);
	}
	if (maxTextBytes > MAX_COMPONENT_TEXT_BYTES) {
		throw new Error(`maxTextBytes cannot exceed ${MAX_COMPONENT_TEXT_BYTES}`);
	}
	if (maxSnapshotBytes > MAX_COMPONENT_SNAPSHOT_BYTES) {
		throw new Error(
			`maxSnapshotBytes cannot exceed ${MAX_COMPONENT_SNAPSHOT_BYTES}`,
		);
	}
	const targetStore = new ExternalStore<ComponentInspectorSnapshot>({
		targets: [],
		diagnostics: [],
		sourceTargetCount: 0,
		omittedTargetCount: 0,
		screenHash: componentScreenHash([]),
	});
	const renderStore = new ExternalStore<readonly ComponentRenderEvent[]>([]);
	let active = false;
	let lifecycleGeneration = 0;

	const capture = (generation = lifecycleGeneration): void => {
		if (!active || generation !== lifecycleGeneration) return;
		try {
			const sourceTargets = options.source.getSnapshot();
			const sourceTargetCount = componentTargetArrayLength(sourceTargets);
			if (sourceTargetCount === null) {
				throw new Error(
					'Component target source returned an invalid snapshot.',
				);
			}
			const normalized = normalizeComponentCapture(sourceTargets, {
				maxTargets,
				maxInstanceBytes,
				maxTextBytes,
				maxSnapshotBytes,
			});
			targetStore.set({
				targets: normalized.targets,
				diagnostics: normalized.diagnostics,
				sourceTargetCount,
				omittedTargetCount: Math.max(
					0,
					sourceTargetCount - normalized.targets.length,
				),
				screenHash:
					normalized.targets[0]?.screenHash ??
					componentScreenHash(normalized.targets),
			});
		} catch (error) {
			targetStore.set({
				...targetStore.getSnapshot(),
				error: componentErrorText(error),
			});
		}
	};
	const captureRenderEvents = (generation = lifecycleGeneration): void => {
		if (
			!active ||
			generation !== lifecycleGeneration ||
			!options.renderSource
		) {
			return;
		}
		try {
			renderStore.set(
				normalizeComponentRenderEvents(
					options.renderSource.getSnapshot(),
					maxRenderEvents,
				),
			);
		} catch {
			// Render diagnostics are supplemental and must not break target capture.
		}
	};

	const refresh = async (): Promise<void> => {
		if (!active) return;
		const generation = lifecycleGeneration;
		await options.source.refresh?.();
		capture(generation);
	};
	const inspectPoint = (point: {
		x: number;
		y: number;
	}): readonly ComponentTargetSnapshot[] =>
		componentTargetsAtPoint(targetStore.getSnapshot().targets, point);
	const highlight = async (targetId: string): Promise<void> => {
		if (!active) {
			throw new Error(
				'Component inspector is unavailable while tools are disabled.',
			);
		}
		if (
			!targetStore
				.getSnapshot()
				.targets.some((target) => target.id === targetId)
		) {
			throw new Error('Component target is no longer available.');
		}
		if (!options.source.highlight) {
			throw new Error('This component source does not support highlighting.');
		}
		await options.source.highlight(targetId);
	};
	const performAction = async (
		targetId: string,
		screenHash: string,
		action: ComponentTargetActionRequest,
	): Promise<void> => {
		if (!active) {
			throw new Error(
				'Component inspector is unavailable while tools are disabled.',
			);
		}
		const snapshot = targetStore.getSnapshot();
		if (snapshot.screenHash !== screenHash) {
			throw new Error('The app screen changed; refresh component targets.');
		}
		const target = snapshot.targets.find(
			(candidate) => candidate.id === targetId,
		);
		if (!target) throw new Error('Component target is no longer available.');
		if (!target.actions.includes(action.type)) {
			throw new Error(`Component target does not support ${action.type}.`);
		}
		if (!options.source.performAction) {
			throw new Error(
				'This component source does not support semantic actions.',
			);
		}
		if (action.type === 'setText' && utf8ByteLength(action.text) > 64 * 1024) {
			throw new Error('Component text exceeds the 64 KiB action limit.');
		}
		if (
			action.type === 'scroll' &&
			action.amount !== undefined &&
			(!Number.isFinite(action.amount) ||
				action.amount <= 0 ||
				action.amount > 1)
		) {
			throw new Error('Scroll amount must be greater than 0 and at most 1.');
		}
		await options.source.performAction(targetId, action);
		capture();
	};
	const waitForSnapshot = (
		predicate: (snapshot: ComponentInspectorSnapshot) => boolean,
		timeoutMs: number,
		timeoutMessage: string,
	): Promise<void> => {
		if (!active) {
			return Promise.reject(
				new Error(
					'Component inspector is unavailable while tools are disabled.',
				),
			);
		}
		if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 10_000) {
			return Promise.reject(
				new Error('Component wait timeout must be between 50 and 10000 ms.'),
			);
		}
		if (predicate(targetStore.getSnapshot())) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			let unsubscribe = (): void => {};
			const finish = (error?: Error): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				unsubscribe();
				if (error) reject(error);
				else resolve();
			};
			const timer = setTimeout(
				() => finish(new Error(timeoutMessage)),
				timeoutMs,
			);
			unsubscribe = targetStore.subscribe(() => {
				if (predicate(targetStore.getSnapshot())) finish();
			});
			if (predicate(targetStore.getSnapshot())) finish();
		});
	};
	const waitForElement = (targetId: string, timeoutMs: number): Promise<void> =>
		waitForSnapshot(
			(snapshot) => snapshot.targets.some((target) => target.id === targetId),
			timeoutMs,
			'Component target did not appear before the timeout.',
		);
	const waitForScreenChange = (
		screenHash: string,
		timeoutMs: number,
	): Promise<void> =>
		waitForSnapshot(
			(snapshot) => snapshot.screenHash !== screenHash,
			timeoutMs,
			'The app screen did not change before the timeout.',
		);
	const install = createRefCountedInstaller(({ addCleanup }) => {
		active = true;
		lifecycleGeneration += 1;
		const generation = lifecycleGeneration;
		const deactivate = () => {
			if (!active || generation !== lifecycleGeneration) return;
			active = false;
			lifecycleGeneration += 1;
		};
		addCleanup(deactivate);
		capture(generation);
		captureRenderEvents(generation);
		try {
			const dispose = options.source.subscribe(() => capture(generation));
			if (typeof dispose !== 'function') {
				throw new Error('Subscription did not return a disposer.');
			}
			addCleanup(() => {
				deactivate();
				dispose();
			});
		} catch (error) {
			targetStore.set({
				...targetStore.getSnapshot(),
				error: `Subscription failed: ${componentErrorText(error)}`,
			});
		}
		if (options.renderSource) {
			try {
				const disposeRenders = options.renderSource.subscribe(() =>
					captureRenderEvents(generation),
				);
				if (typeof disposeRenders === 'function') {
					addCleanup(disposeRenders);
				}
			} catch {
				// Render diagnostics are supplemental and fail closed.
			}
		}
		void refresh().catch((error: unknown) => {
			if (!active || generation !== lifecycleGeneration) return;
			targetStore.set({
				...targetStore.getSnapshot(),
				error: `Refresh failed: ${componentErrorText(error)}`,
			});
		});
	});

	function ComponentInspectorPanel({
		onBack,
		onClose,
		actions,
	}: DevToolsPanelProps) {
		const snapshot = useSyncExternalStore(
			targetStore.subscribe,
			targetStore.getSnapshot,
			targetStore.getServerSnapshot,
		);
		const renderEvents = useSyncExternalStore(
			renderStore.subscribe,
			renderStore.getSnapshot,
			renderStore.getServerSnapshot,
		);
		const visualState = useSyncExternalStore(
			options.visuals?.subscribe ?? subscribeToDisabledVisualState,
			options.visuals?.getSnapshot ?? getDisabledVisualState,
			options.visuals?.getServerSnapshot ??
				options.visuals?.getSnapshot ??
				getDisabledVisualState,
		);
		const { targets } = snapshot;
		const [search, setSearch] = useState('');
		const needle = search.trim().toLowerCase();
		const visibleTargets = useMemo(
			() =>
				targets.filter(
					(target) => !needle || targetSearchText(target).includes(needle),
				),
			[targets, needle],
		);
		const groupedTargets = useMemo(() => {
			const groups = new Map<string, ComponentTargetSnapshot[]>();
			for (const target of visibleTargets) {
				const route = target.route ?? 'Unknown route';
				const entries = groups.get(route) ?? [];
				entries.push(target);
				groups.set(route, entries);
			}
			return [...groups.entries()];
		}, [visibleTargets]);
		const targetNames = useMemo(
			() => new Map(targets.map((target) => [target.id, target.name] as const)),
			[targets],
		);
		const recentRenderEvents = useMemo(
			() => [...renderEvents].reverse().slice(0, 20),
			[renderEvents],
		);
		const highlightTarget = (target: ComponentTargetSnapshot) => {
			onClose();
			void actions.run({
				pluginId: id,
				label: `Highlight ${target.name}`,
				action: () => highlight(target.id),
			});
		};

		return (
			<PanelShell
				onBack={onBack}
				title={title}
				trailing={
					<NavIconButton
						accessibilityLabel="Refresh component measurements"
						onPress={() => {
							void actions.run({
								pluginId: id,
								label: 'Refresh component measurements',
								action: refresh,
							});
						}}
						systemImage="arrow.clockwise"
						testID="devtools-components-refresh"
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
									placeholder="Search targets, routes, or source files"
								/>
							</Section>
							<Section
								footer={
									<UIText>
										Only components explicitly registered by the host appear
										here. The inspector does not traverse React fibers or native
										view hierarchies.
									</UIText>
								}
							>
								{options.visuals ? (
									<>
										<Button
											label={
												visualState.debugBorders
													? 'Hide debug borders'
													: 'Show debug borders'
											}
											onPress={() =>
												options.visuals?.setDebugBorders(
													!visualState.debugBorders,
												)
											}
										/>
										<Button
											label={
												visualState.inspectMode
													? 'Stop inspect mode'
													: 'Inspect a point'
											}
											onPress={() => {
												options.visuals?.setInspectMode(
													!visualState.inspectMode,
												);
												onClose();
											}}
										/>
										<Button
											label={
												visualState.updateHighlights
													? 'Stop update highlights'
													: 'Highlight updates'
											}
											onPress={() => {
												options.visuals?.setUpdateHighlights(
													!visualState.updateHighlights,
												);
												onClose();
											}}
										/>
									</>
								) : null}
								{snapshot.error ? (
									<Label
										color={PlatformColor('systemOrangeColor')}
										systemImage="exclamationmark.triangle.fill"
										title={`Capture failed · ${snapshot.error}`}
									/>
								) : null}
								<Label
									color={PlatformColor('systemBlueColor')}
									systemImage="scope"
									title={`${visibleTargets.length} of ${targets.length} registered targets`}
								/>
								{snapshot.omittedTargetCount > 0 ? (
									<Label
										color={PlatformColor('systemOrangeColor')}
										systemImage="exclamationmark.triangle.fill"
										title={`${snapshot.omittedTargetCount} source ${snapshot.omittedTargetCount === 1 ? 'target was' : 'targets were'} invalid, duplicated, or over the safe capture limits`}
									/>
								) : null}
								{snapshot.diagnostics.length > 0 ? (
									<Label
										color={PlatformColor('systemOrangeColor')}
										systemImage="point.3.connected.trianglepath.dotted"
										title={`${snapshot.diagnostics.length} registration ${snapshot.diagnostics.length === 1 ? 'diagnostic' : 'diagnostics'}`}
									/>
								) : null}
							</Section>
							{recentRenderEvents.length > 0 ? (
								<Section title={`Recent renders · ${renderEvents.length}`}>
									{recentRenderEvents.map((event) => (
										<DisclosureGroup
											key={event.id}
											label={`${targetNames.get(event.targetId) ?? event.targetId} · ${event.actualDuration.toFixed(1)} ms`}
										>
											<LabeledContent label="Phase / cause">
												<UIText>{`${event.phase} / ${event.cause}`}</UIText>
											</LabeledContent>
											<LabeledContent label="Render count">
												<UIText>{String(event.renderCount)}</UIText>
											</LabeledContent>
											<LabeledContent label="Actual / base">
												<UIText>{`${event.actualDuration.toFixed(1)} / ${event.baseDuration.toFixed(1)} ms`}</UIText>
											</LabeledContent>
										</DisclosureGroup>
									))}
								</Section>
							) : null}
							{groupedTargets.length === 0 ? (
								<Section>
									<ContentUnavailableView
										description={
											needle
												? 'No registered component matches this search.'
												: 'Open a screen containing registered feedback targets, then refresh.'
										}
										systemImage="scope"
										title={needle ? 'No matching targets' : 'No targets'}
									/>
								</Section>
							) : (
								groupedTargets.map(([route, routeTargets]) => (
									<Section
										key={route}
										title={`${route} · ${routeTargets.length}`}
									>
										{routeTargets.map((target) => (
											<DisclosureGroup
												key={target.id}
												label={`${target.name} — ${target.kind}`}
											>
												<Label
													color={PlatformColor(
														target.isFocused
															? 'systemGreenColor'
															: 'systemGrayColor',
													)}
													systemImage={
														target.isFocused ? 'viewfinder' : 'eye.slash'
													}
													title={target.isFocused ? 'Focused' : 'Not focused'}
												/>
												<LabeledContent label="Bounds">
													<UIText>{boundsLabel(target.bounds)}</UIText>
												</LabeledContent>
												<LabeledContent label="Instance id">
													<UIText>{target.id}</UIText>
												</LabeledContent>
												<LabeledContent label="Target id">
													<UIText>{target.targetId}</UIText>
												</LabeledContent>
												{target.parentId ? (
													<LabeledContent label="Parent instance">
														<UIText>{target.parentId}</UIText>
													</LabeledContent>
												) : null}
												<LabeledContent label="Depth / z-index">
													<UIText>{`${target.depth} / ${target.zIndex}`}</UIText>
												</LabeledContent>
												{target.feature ? (
													<LabeledContent label="Feature">
														<UIText>{target.feature}</UIText>
													</LabeledContent>
												) : null}
												{target.testID ? (
													<LabeledContent label="Test id">
														<UIText>{target.testID}</UIText>
													</LabeledContent>
												) : null}
												{target.targetKey ? (
													<LabeledContent label="Target key">
														<UIText>{target.targetKey}</UIText>
													</LabeledContent>
												) : null}
												{target.sourceFiles.length > 0 ? (
													<LabeledContent label="Source">
														<UIText modifiers={[lineLimit(8)]}>
															{target.sourceFiles.join('\n')}
														</UIText>
													</LabeledContent>
												) : null}
												{target.instanceText ? (
													<UIText
														modifiers={[
															font({
																design: 'monospaced',
																textStyle: 'footnote',
															}),
															foregroundStyle('secondary'),
															lineLimit(12),
														]}
													>
														{target.instanceText}
													</UIText>
												) : null}
												{target.styleText ? (
													<UIText
														modifiers={[
															font({
																design: 'monospaced',
																textStyle: 'footnote',
															}),
															foregroundStyle('secondary'),
															lineLimit(12),
														]}
													>
														{target.styleText}
													</UIText>
												) : null}
												{options.source.highlight && target.bounds ? (
													<Button
														label="Highlight target"
														onPress={() => highlightTarget(target)}
													/>
												) : null}
											</DisclosureGroup>
										))}
									</Section>
								))
							)}
						</List>
					</Host>
				) : (
					<AndroidPanelScroll>
						<AndroidPanelSearch
							onChangeText={setSearch}
							placeholder="Search targets, routes, or source files"
							value={search}
						/>
						<AndroidPanelSection
							footer="Only explicitly registered targets appear here; React fibers and native view hierarchies are not traversed."
							title="Overview"
						>
							{options.visuals ? (
								<>
									<AndroidPanelRow
										label={
											visualState.debugBorders
												? 'Hide debug borders'
												: 'Show debug borders'
										}
										onPress={() =>
											options.visuals?.setDebugBorders(
												!visualState.debugBorders,
											)
										}
									/>
									<AndroidPanelRow
										label={
											visualState.inspectMode
												? 'Stop inspect mode'
												: 'Inspect a point'
										}
										onPress={() => {
											options.visuals?.setInspectMode(!visualState.inspectMode);
											onClose();
										}}
									/>
									<AndroidPanelRow
										label={
											visualState.updateHighlights
												? 'Stop update highlights'
												: 'Highlight updates'
										}
										onPress={() => {
											options.visuals?.setUpdateHighlights(
												!visualState.updateHighlights,
											);
											onClose();
										}}
									/>
								</>
							) : null}
							<AndroidPanelRow
								label="Registered targets"
								value={`${visibleTargets.length} of ${targets.length}`}
							/>
							{snapshot.error ? (
								<AndroidPanelRow
									detail={snapshot.error}
									label="Capture failed"
									tone="warning"
								/>
							) : null}
							{snapshot.omittedTargetCount > 0 ? (
								<AndroidPanelRow
									detail={`${snapshot.omittedTargetCount} source ${snapshot.omittedTargetCount === 1 ? 'target was' : 'targets were'} invalid, duplicated, or over the safe capture limits.`}
									label="Targets omitted"
									tone="warning"
								/>
							) : null}
							{snapshot.diagnostics.length > 0 ? (
								<AndroidPanelRow
									detail={snapshot.diagnostics
										.slice(0, 5)
										.map((diagnostic) => diagnostic.message)
										.join('\n')}
									label="Registration diagnostics"
									tone="warning"
									value={String(snapshot.diagnostics.length)}
								/>
							) : null}
							{visibleTargets.length === 0 ? (
								<AndroidPanelRow
									detail={
										needle
											? 'No registered component matches this search.'
											: 'Open a screen containing registered feedback targets, then refresh.'
									}
									label={needle ? 'No matching targets' : 'No targets'}
								/>
							) : null}
						</AndroidPanelSection>
						{recentRenderEvents.length > 0 ? (
							<AndroidPanelSection
								title={`Recent renders · ${renderEvents.length}`}
							>
								{recentRenderEvents.map((event) => (
									<AndroidPanelRow
										detail={`${event.phase} · ${event.cause} · render ${event.renderCount} · base ${event.baseDuration.toFixed(1)} ms`}
										key={event.id}
										label={targetNames.get(event.targetId) ?? event.targetId}
										value={`${event.actualDuration.toFixed(1)} ms`}
									/>
								))}
							</AndroidPanelSection>
						) : null}
						{visibleTargets.map((target) => (
							<AndroidPanelSection
								key={target.id}
								title={`${target.route ?? 'Unscoped'} · ${target.name}`}
							>
								<AndroidPanelRow label="Kind" value={target.kind} />
								<AndroidPanelRow
									label="Focus"
									tone={target.isFocused ? 'success' : 'default'}
									value={target.isFocused ? 'Focused' : 'Not focused'}
								/>
								<AndroidPanelRow
									label="Bounds"
									value={boundsLabel(target.bounds)}
								/>
								<AndroidPanelRow label="Instance id" value={target.id} />
								<AndroidPanelRow label="Target id" value={target.targetId} />
								{target.parentId ? (
									<AndroidPanelRow
										label="Parent instance"
										value={target.parentId}
									/>
								) : null}
								<AndroidPanelRow
									label="Depth / z-index"
									value={`${target.depth} / ${target.zIndex}`}
								/>
								{target.feature ? (
									<AndroidPanelRow label="Feature" value={target.feature} />
								) : null}
								{target.testID ? (
									<AndroidPanelRow label="Test id" value={target.testID} />
								) : null}
								{target.targetKey ? (
									<AndroidPanelRow
										label="Target key"
										value={target.targetKey}
									/>
								) : null}
								{target.sourceFiles.length > 0 ? (
									<AndroidPanelTextBlock
										label="Source"
										value={target.sourceFiles.join('\n')}
									/>
								) : null}
								{target.instanceText ? (
									<AndroidPanelTextBlock
										label="Instance"
										value={target.instanceText}
									/>
								) : null}
								{target.styleText ? (
									<AndroidPanelTextBlock
										label="Safe styles"
										value={target.styleText}
									/>
								) : null}
								{options.source.highlight && target.bounds ? (
									<AndroidPanelRow
										label="Highlight target"
										onPress={() => highlightTarget(target)}
									/>
								) : null}
							</AndroidPanelSection>
						))}
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
			'Inspect explicit component targets and measurements',
		systemImage: options.systemImage ?? 'scope',
		tint: Platform.OS === 'ios' ? PlatformColor('systemBlueColor') : '#007AFF',
		section: options.section,
		Panel: ComponentInspectorPanel,
		install,
	};

	return {
		plugin,
		subscribe: targetStore.subscribe,
		subscribeRenderEvents: renderStore.subscribe,
		refresh,
		getTargets: () => targetStore.getSnapshot().targets,
		getSnapshot: targetStore.getSnapshot,
		getRenderEvents: renderStore.getSnapshot,
		highlight,
		inspectPoint,
		performAction,
		waitForElement,
		waitForScreenChange,
	};
}

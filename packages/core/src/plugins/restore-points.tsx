import {
	Button,
	ContentUnavailableView,
	DisclosureGroup,
	Host,
	Label,
	LabeledContent,
	List,
	Section,
	Text as UIText,
} from '@expo/ui/swift-ui';
import {
	disabled,
	font,
	foregroundStyle,
	lineLimit,
	listStyle,
} from '@expo/ui/swift-ui/modifiers';
import { useSyncExternalStore } from 'react';
import { Platform, PlatformColor } from 'react-native';
import {
	AndroidPanelRow,
	AndroidPanelScroll,
	AndroidPanelSection,
	AndroidPanelTextBlock,
} from '../components/android-panel-ui';
import { PanelShell } from '../components/panel-shell';
import { ExternalStore } from '../core/external-store';
import { formatBytes, formatRelativeTime } from '../core/format';
import { assertPositiveFinite, assertPositiveInteger } from '../core/options';
import { diagnosticErrorText, redactDiagnosticText } from '../core/redact';
import { truncateText, utf8ByteLength } from '../core/serialize';
import type {
	DevToolsPanelPlugin,
	DevToolsPanelProps,
	DevToolsSystemImage,
} from '../types';
import {
	DEFAULT_RESTORE_POINTS_KEY,
	estimateRestorePointBytes,
	RestorePointRepository,
	type RestorePointStorage,
} from './restore-repository';
import {
	type RestoreTransactionOptions,
	type RestoreTransactionReceipt,
	runResetToBaselineTransaction,
	runRestoreTransaction,
} from './restore-transaction';

export type {
	RestorePointImportMode,
	RestorePointStorage,
} from './restore-repository';
export type {
	RestoreTransactionOptions,
	RestoreTransactionReceipt,
	RestoreTransactionSourceResult,
	RestoreTransactionStatus,
} from './restore-transaction';

/**
 * Restore is intentionally explicit: sources decide what can be captured and
 * how that known snapshot is safely applied. No arbitrary store mutation API is
 * exposed by this plugin.
 */
export type RestorePointSource = {
	id: string;
	title: string;
	description?: string;
	dependencies?: readonly string[];
	capture: () => unknown | Promise<unknown>;
	validate?: (snapshot: unknown) => unknown | Promise<unknown>;
	restore: (snapshot: unknown) => void | Promise<void>;
	resetToBaseline?: () => void | Promise<void>;
};

export type RestorePointSourceSnapshot = {
	sourceId: string;
	sourceTitle: string;
	json: string;
	preview: string;
	bytes: number;
};

export type RestorePoint = {
	id: string;
	label: string;
	createdAt: number;
	sources: readonly RestorePointSourceSnapshot[];
	estimatedBytes: number;
};

export type RestorePointsPluginOptions = {
	sources: readonly RestorePointSource[];
	persistence?: Readonly<{
		storage: RestorePointStorage;
		key?: string;
	}>;
	maxPoints?: number;
	maxSourceBytes?: number;
	maxTotalBytes?: number;
	title?: string;
	id?: string;
	description?: string;
	section?: string;
	systemImage?: DevToolsSystemImage;
};

export type RestorePointsPlugin = {
	plugin: DevToolsPanelPlugin;
	ready: Promise<void>;
	capture: (label?: string) => Promise<RestorePoint>;
	restore: (
		restorePointId: string,
		options?: RestoreTransactionOptions,
	) => Promise<void>;
	restoreDetailed: (
		restorePointId: string,
		options?: RestoreTransactionOptions,
	) => Promise<RestoreTransactionReceipt>;
	resetToBaseline: (
		options?: RestoreTransactionOptions,
	) => Promise<RestoreTransactionReceipt>;
	rename: (restorePointId: string, label: string) => Promise<RestorePoint>;
	duplicate: (restorePointId: string, label?: string) => Promise<RestorePoint>;
	remove: (restorePointId: string) => Promise<void>;
	clear: () => Promise<void>;
	exportJson: () => string;
	importJson: (value: string, mode?: 'replace' | 'merge') => Promise<void>;
	getPoints: () => readonly RestorePoint[];
	getReceipts: () => readonly RestoreTransactionReceipt[];
};

type CanonicalSnapshot = {
	json: string;
	preview: string;
	bytes: number;
};

const MAX_RESTORE_SOURCE_BYTES = 1024 * 1024;
const MAX_RESTORE_VALIDATION_DEPTH = 64;
const MAX_RESTORE_VALIDATION_ENTRIES = 100_000;
const DANGEROUS_RESTORE_KEYS = new Set([
	'__proto__',
	'constructor',
	'prototype',
]);

type JsonCloneState = {
	seen: WeakSet<object>;
	remainingEntries: number;
};

function errorMessage(error: unknown): string {
	return diagnosticErrorText(error);
}

function cloneJsonValue(
	value: unknown,
	path: string,
	state: JsonCloneState,
	depth: number,
): unknown {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean'
	) {
		return value;
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new Error(`${path} must be a finite JSON number.`);
		}
		return value;
	}
	if (typeof value !== 'object') {
		throw new Error(`${path} contains a non-JSON ${typeof value} value.`);
	}
	if (depth >= MAX_RESTORE_VALIDATION_DEPTH) {
		throw new Error(
			`${path} exceeds the restore snapshot depth limit of ${MAX_RESTORE_VALIDATION_DEPTH}.`,
		);
	}
	if (state.seen.has(value))
		throw new Error(`${path} contains a circular or shared reference.`);
	state.seen.add(value);
	let symbols: symbol[];
	let isArray: boolean;
	try {
		symbols = Object.getOwnPropertySymbols(value);
		isArray = Array.isArray(value);
	} catch {
		throw new Error(`${path} is not a readable JSON value.`);
	}
	if (symbols.length > 0) {
		throw new Error(`${path} contains symbol properties.`);
	}
	if (isArray) {
		let lengthDescriptor: PropertyDescriptor | undefined;
		try {
			lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
		} catch {
			throw new Error(`${path} has an unreadable array length.`);
		}
		const length =
			lengthDescriptor &&
			'value' in lengthDescriptor &&
			typeof lengthDescriptor.value === 'number'
				? lengthDescriptor.value
				: -1;
		if (!Number.isSafeInteger(length) || length < 0) {
			throw new Error(`${path} has an invalid array length.`);
		}
		if (length > state.remainingEntries) {
			throw new Error(
				`${path} exceeds the restore snapshot entry limit of ${MAX_RESTORE_VALIDATION_ENTRIES}.`,
			);
		}
		state.remainingEntries -= length;
		let descriptors: Record<string, PropertyDescriptor>;
		try {
			descriptors = Object.getOwnPropertyDescriptors(value);
		} catch {
			throw new Error(`${path} contains unreadable array entries.`);
		}
		const output: unknown[] = [];
		for (let index = 0; index < length; index += 1) {
			const descriptor = descriptors[String(index)];
			if (!descriptor) {
				throw new Error(`${path}[${index}] is a sparse array entry.`);
			}
			if (!descriptor.enumerable) {
				throw new Error(`${path}[${index}] is non-enumerable.`);
			}
			if (!('value' in descriptor)) {
				throw new Error(`${path}[${index}] is an accessor.`);
			}
			output.push(
				cloneJsonValue(descriptor.value, `${path}[${index}]`, state, depth + 1),
			);
		}
		for (const key of Object.keys(descriptors)) {
			if (key === 'length') continue;
			const index = Number(key);
			if (
				!Number.isSafeInteger(index) ||
				String(index) !== key ||
				index < 0 ||
				index >= length
			) {
				throw new Error(`${path}.${key} is not a JSON array index.`);
			}
		}
		return output;
	}
	let prototype: object | null;
	let descriptors: Record<string, PropertyDescriptor>;
	try {
		prototype = Object.getPrototypeOf(value);
		descriptors = Object.getOwnPropertyDescriptors(value);
	} catch {
		throw new Error(`${path} is not a readable JSON object.`);
	}
	if (prototype !== Object.prototype && prototype !== null) {
		throw new Error(`${path} must be a plain JSON object.`);
	}
	const entries = Object.entries(descriptors);
	if (entries.length > state.remainingEntries) {
		throw new Error(
			`${path} exceeds the restore snapshot entry limit of ${MAX_RESTORE_VALIDATION_ENTRIES}.`,
		);
	}
	state.remainingEntries -= entries.length;
	const output = Object.create(null) as Record<string, unknown>;
	for (const [key, descriptor] of entries) {
		if (DANGEROUS_RESTORE_KEYS.has(key)) {
			throw new Error(`${path}.${key} is not allowed in restore snapshots.`);
		}
		if (!descriptor.enumerable) {
			throw new Error(`${path}.${key} is non-enumerable.`);
		}
		if (!('value' in descriptor)) {
			throw new Error(`${path}.${key} is an accessor.`);
		}
		output[key] = cloneJsonValue(
			descriptor.value,
			`${path}.${key}`,
			state,
			depth + 1,
		);
	}
	return output;
}

export function canonicalizeRestoreValue(
	value: unknown,
	maxBytes: number,
): CanonicalSnapshot {
	assertPositiveFinite(maxBytes, 'maxBytes');
	if (maxBytes > MAX_RESTORE_SOURCE_BYTES) {
		throw new Error(`maxBytes cannot exceed ${MAX_RESTORE_SOURCE_BYTES}`);
	}
	const detached = cloneJsonValue(
		value,
		'$',
		{
			seen: new WeakSet(),
			remainingEntries: MAX_RESTORE_VALIDATION_ENTRIES,
		},
		0,
	);
	let json: string | undefined;
	try {
		json = JSON.stringify(detached);
	} catch (error) {
		throw new Error(
			`Restore snapshot must be JSON-compatible: ${errorMessage(error)}`,
		);
	}
	if (json === undefined) {
		throw new Error('Restore snapshot must resolve to a JSON value.');
	}
	const bytes = utf8ByteLength(json);
	if (bytes > maxBytes) {
		throw new Error(
			`Restore snapshot is ${formatBytes(bytes)}; the per-source limit is ${formatBytes(maxBytes)}.`,
		);
	}
	// Parsing rejects any non-standard output and severs references to live state.
	JSON.parse(json);
	return {
		json,
		preview: truncateText(
			redactDiagnosticText(json),
			Math.min(maxBytes, 8 * 1024),
		).text,
		bytes,
	};
}

function validateSources(
	sources: readonly RestorePointSource[],
): readonly RestorePointSource[] {
	if (!Array.isArray(sources)) {
		throw new Error('Restore-point sources must be provided as an array.');
	}
	const lengthDescriptor = Object.getOwnPropertyDescriptor(sources, 'length');
	const sourceCount =
		lengthDescriptor &&
		'value' in lengthDescriptor &&
		Number.isSafeInteger(lengthDescriptor.value)
			? lengthDescriptor.value
			: -1;
	if (sourceCount < 0) {
		throw new Error('Restore-point sources have an invalid array length.');
	}
	if (sourceCount > 50) {
		throw new Error('Restore points support at most 50 explicit sources.');
	}
	const ids = new Set<string>();
	const normalized: RestorePointSource[] = [];
	for (let index = 0; index < sourceCount; index += 1) {
		const sourceDescriptor = Object.getOwnPropertyDescriptor(
			sources,
			String(index),
		);
		if (!sourceDescriptor || !('value' in sourceDescriptor)) {
			throw new Error(
				'Restore-point source lists cannot contain holes or accessors.',
			);
		}
		const source = sourceDescriptor.value;
		if (!source || typeof source !== 'object') {
			throw new Error('Restore-point sources must be objects.');
		}
		const descriptors = Object.getOwnPropertyDescriptors(source);
		const field = (key: keyof RestorePointSource): unknown => {
			const descriptor = descriptors[key];
			return descriptor && 'value' in descriptor ? descriptor.value : undefined;
		};
		const sourceId = field('id');
		const sourceTitle = field('title');
		const sourceDescription = field('description');
		const dependencies = field('dependencies');
		const capture = field('capture');
		const validate = field('validate');
		const restore = field('restore');
		const resetToBaseline = field('resetToBaseline');
		if (
			typeof sourceId !== 'string' ||
			!sourceId.trim() ||
			sourceId !== sourceId.trim()
		) {
			throw new Error(
				'Restore-point source ids must be non-empty and cannot have surrounding whitespace.',
			);
		}
		if (sourceId.length > 256) {
			throw new Error('Restore-point source ids cannot exceed 256 characters.');
		}
		if (
			typeof sourceTitle !== 'string' ||
			!sourceTitle.trim() ||
			sourceTitle.length > 4 * 1024
		) {
			throw new Error(
				'Restore-point source titles must be non-empty and at most 4096 characters.',
			);
		}
		if (
			sourceDescription !== undefined &&
			(typeof sourceDescription !== 'string' ||
				sourceDescription.length > 4 * 1024)
		) {
			throw new Error(
				'Restore-point source descriptions cannot exceed 4096 characters.',
			);
		}
		if (typeof capture !== 'function' || typeof restore !== 'function') {
			throw new Error(
				'Restore-point sources require capture and restore functions.',
			);
		}
		if (validate !== undefined && typeof validate !== 'function') {
			throw new Error('Restore-point source validate must be a function.');
		}
		if (
			resetToBaseline !== undefined &&
			typeof resetToBaseline !== 'function'
		) {
			throw new Error(
				'Restore-point source resetToBaseline must be a function.',
			);
		}
		let normalizedDependencies: string[] | undefined;
		if (dependencies !== undefined) {
			if (!Array.isArray(dependencies) || dependencies.length > 50) {
				throw new Error('Restore-point source dependencies must be an array.');
			}
			normalizedDependencies = dependencies.map((_, dependencyIndex) => {
				const descriptor = Object.getOwnPropertyDescriptor(
					dependencies,
					String(dependencyIndex),
				);
				if (
					!descriptor ||
					!('value' in descriptor) ||
					typeof descriptor.value !== 'string' ||
					!descriptor.value.trim() ||
					descriptor.value !== descriptor.value.trim() ||
					descriptor.value.length > 256
				) {
					throw new Error('Restore-point source dependency ids are invalid.');
				}
				return descriptor.value;
			});
			if (
				new Set(normalizedDependencies).size !== normalizedDependencies.length
			) {
				throw new Error('Restore-point source dependencies must be unique.');
			}
		}
		if (ids.has(sourceId)) {
			throw new Error(`Duplicate restore-point source id: ${sourceId}`);
		}
		ids.add(sourceId);
		normalized.push({
			id: sourceId,
			title: sourceTitle,
			...(typeof sourceDescription === 'string'
				? { description: sourceDescription }
				: {}),
			...(normalizedDependencies
				? { dependencies: normalizedDependencies }
				: {}),
			capture: capture as RestorePointSource['capture'],
			...(typeof validate === 'function'
				? { validate: validate as RestorePointSource['validate'] }
				: {}),
			restore: restore as RestorePointSource['restore'],
			...(typeof resetToBaseline === 'function'
				? {
						resetToBaseline:
							resetToBaseline as RestorePointSource['resetToBaseline'],
					}
				: {}),
		});
	}
	for (const source of normalized) {
		for (const dependencyId of source.dependencies ?? []) {
			if (dependencyId === source.id || !ids.has(dependencyId)) {
				throw new Error(
					`Restore-point source ${source.id} has invalid dependency ${dependencyId}.`,
				);
			}
		}
	}
	return normalized;
}

function describePoint(point: RestorePoint): string {
	const sourceLabel =
		point.sources.length === 1 ? '1 source' : `${point.sources.length} sources`;
	return `${sourceLabel} · ${formatBytes(point.estimatedBytes)}`;
}

export function createRestorePointsPlugin(
	options: RestorePointsPluginOptions,
): RestorePointsPlugin {
	const title = options.title ?? 'Restore Points';
	const id = options.id ?? 'restore-points';
	const sources = validateSources(options.sources);
	const maxPoints = options.maxPoints ?? 8;
	const maxSourceBytes = options.maxSourceBytes ?? 64 * 1024;
	const maxTotalBytes = options.maxTotalBytes ?? 512 * 1024;
	assertPositiveInteger(maxPoints, 'maxPoints');
	assertPositiveFinite(maxSourceBytes, 'maxSourceBytes');
	assertPositiveFinite(maxTotalBytes, 'maxTotalBytes');
	if (maxPoints > 50) throw new Error('maxPoints cannot exceed 50');
	if (maxSourceBytes > MAX_RESTORE_SOURCE_BYTES) {
		throw new Error(`maxSourceBytes cannot exceed ${MAX_RESTORE_SOURCE_BYTES}`);
	}
	if (maxTotalBytes > 16 * 1024 * 1024) {
		throw new Error(`maxTotalBytes cannot exceed ${16 * 1024 * 1024}`);
	}
	const repository = new RestorePointRepository({
		maxPoints,
		maxSourceBytes,
		maxTotalBytes,
		...(options.persistence
			? {
					storage: options.persistence.storage,
					key: options.persistence.key ?? DEFAULT_RESTORE_POINTS_KEY,
				}
			: {}),
	});
	const operationStore = new ExternalStore(false);
	const receiptStore = new ExternalStore<readonly RestoreTransactionReceipt[]>(
		[],
	);

	const captureSource = async (
		source: RestorePointSource,
	): Promise<RestorePointSourceSnapshot> => {
		const canonical = canonicalizeRestoreValue(
			await source.capture(),
			maxSourceBytes,
		);
		return {
			sourceId: source.id,
			sourceTitle: source.title,
			...canonical,
		};
	};

	const capturePoint = async (label?: string): Promise<RestorePoint> => {
		await repository.ready;
		if (sources.length === 0) {
			throw new Error('No explicit restore-point sources are registered.');
		}
		const createdAt = Date.now();
		const sourceSnapshots = await Promise.all(sources.map(captureSource));
		const pointWithoutSize = {
			id: repository.createId(createdAt),
			label:
				truncateText(redactDiagnosticText(label?.trim() ?? ''), 256).text ||
				`Restore point ${repository.getSnapshot().length + 1}`,
			createdAt,
			sources: sourceSnapshots,
		};
		const estimatedBytes = estimateRestorePointBytes(pointWithoutSize);
		if (estimatedBytes > maxTotalBytes) {
			throw new Error(
				`Restore point is ${formatBytes(estimatedBytes)}; the repository limit is ${formatBytes(maxTotalBytes)}.`,
			);
		}
		const point: RestorePoint = { ...pointWithoutSize, estimatedBytes };
		return repository.add(point);
	};
	const capture = async (label?: string): Promise<RestorePoint> => {
		if (operationStore.getSnapshot()) {
			throw new Error('Another restore-point operation is already running.');
		}
		operationStore.set(true);
		try {
			return await capturePoint(label);
		} finally {
			operationStore.set(false);
		}
	};

	const restoreDetailed = async (
		restorePointId: string,
		restoreOptions?: RestoreTransactionOptions,
	): Promise<RestoreTransactionReceipt> => {
		if (operationStore.getSnapshot()) {
			throw new Error('Another restore-point operation is already running.');
		}
		operationStore.set(true);
		try {
			await repository.ready;
			const point = repository
				.getSnapshot()
				.find((candidate) => candidate.id === restorePointId);
			if (!point) throw new Error('Restore point is no longer available.');
			const receipt = await runRestoreTransaction(
				point,
				sources,
				captureSource,
				restoreOptions,
			);
			receiptStore.set([...receiptStore.getSnapshot(), receipt].slice(-20));
			return receipt;
		} finally {
			operationStore.set(false);
		}
	};
	const restore = async (
		restorePointId: string,
		restoreOptions?: RestoreTransactionOptions,
	): Promise<void> => {
		const receipt = await restoreDetailed(restorePointId, restoreOptions);
		if (receipt.status === 'complete') return;
		if (receipt.status === 'rolled-back') {
			throw new Error(
				`Restore failed: ${receipt.error ?? 'A source rejected the snapshot.'} The pre-restore state was reapplied.`,
			);
		}
		if (receipt.status === 'needs-attention') {
			const rollbackErrors = receipt.sourceResults
				.filter((result) => result.rollback === 'failed')
				.map(
					(result) =>
						`${result.sourceTitle}: ${result.rollbackError ?? 'unknown rollback error'}`,
				)
				.join('; ');
			throw new Error(
				`Restore failed and rollback needs attention. ${rollbackErrors}`,
			);
		}
		throw new Error(
			`Restore was not started: ${receipt.error ?? 'preflight failed'}`,
		);
	};
	const resetToBaseline = async (
		resetOptions?: RestoreTransactionOptions,
	): Promise<RestoreTransactionReceipt> => {
		if (operationStore.getSnapshot()) {
			throw new Error('Another restore-point operation is already running.');
		}
		operationStore.set(true);
		try {
			const receipt = await runResetToBaselineTransaction(
				sources,
				captureSource,
				resetOptions,
			);
			receiptStore.set([...receiptStore.getSnapshot(), receipt].slice(-20));
			return receipt;
		} finally {
			operationStore.set(false);
		}
	};

	const ensureIdle = (message: string): void => {
		if (operationStore.getSnapshot()) {
			throw new Error(message);
		}
	};
	const rename = async (restorePointId: string, label: string) => {
		ensureIdle('Cannot rename a restore point during an active operation.');
		return repository.rename(restorePointId, label);
	};
	const duplicate = async (restorePointId: string, label?: string) => {
		ensureIdle('Cannot duplicate a restore point during an active operation.');
		return repository.duplicate(restorePointId, label);
	};
	const remove = async (restorePointId: string): Promise<void> => {
		ensureIdle('Cannot remove a restore point during an active operation.');
		await repository.remove(restorePointId);
	};
	const clear = async (): Promise<void> => {
		ensureIdle('Cannot clear restore points during an active operation.');
		await repository.clear();
	};
	const importJson = async (
		value: string,
		mode: 'replace' | 'merge' = 'replace',
	): Promise<void> => {
		ensureIdle('Cannot import restore points during an active operation.');
		await repository.importJson(value, mode);
	};
	const retentionDescription = options.persistence
		? 'persisted in the dedicated devtools namespace'
		: 'held in memory for this tools session';

	function RestorePointsPanel({ onBack, actions }: DevToolsPanelProps) {
		const points = useSyncExternalStore(
			repository.subscribe,
			repository.getSnapshot,
			repository.getServerSnapshot,
		);
		const operationInFlight = useSyncExternalStore(
			operationStore.subscribe,
			operationStore.getSnapshot,
			operationStore.getServerSnapshot,
		);
		const now = Date.now();
		const capturePoint = () => {
			void actions.run({
				pluginId: id,
				label: 'Capture restore point',
				action: () => capture(),
			});
		};
		const resetBaseline = () => {
			void actions.run({
				pluginId: id,
				label: 'Reset explicit sources to baseline',
				confirmation: {
					title: 'Reset explicit sources to baseline?',
					message:
						'Only sources that explicitly implement resetToBaseline will change. Rollback data is captured first.',
					confirmLabel: 'Reset safely',
				},
				action: async () => {
					const receipt = await resetToBaseline();
					if (receipt.status !== 'complete') {
						throw new Error(
							`Baseline reset ${receipt.status}: ${receipt.error ?? 'review the transaction receipt'}`,
						);
					}
				},
			});
		};
		const restorePoint = (point: RestorePoint) => {
			void actions.run({
				pluginId: id,
				label: `Restore ${point.label}`,
				confirmation: {
					title: `Restore ${point.label}?`,
					message:
						'Current values for the declared sources will be replaced. A rollback snapshot is captured first.',
					confirmLabel: 'Restore',
				},
				action: () => restore(point.id),
			});
		};
		const deletePoint = (point: RestorePoint) => {
			void actions.run({
				pluginId: id,
				label: `Delete ${point.label}`,
				confirmation: {
					title: `Delete ${point.label}?`,
					message:
						'This permanently removes the saved restore point. It does not change current app state.',
					confirmLabel: 'Delete',
					destructive: true,
				},
				action: () => remove(point.id),
			});
		};
		return (
			<PanelShell onBack={onBack} title={title}>
				{Platform.OS === 'ios' ? (
					<Host style={{ flex: 1 }}>
						<List modifiers={[listStyle('insetGrouped')]}>
							<Section
								footer={
									<UIText>
										Restore points are JSON-only, size-bounded, and{' '}
										{retentionDescription}. A rollback snapshot is taken before
										every restore.
									</UIText>
								}
							>
								<Button
									label="Capture restore point"
									modifiers={[disabled(operationInFlight)]}
									onPress={capturePoint}
								/>
								<Button
									label="Reset explicit baselines"
									modifiers={[disabled(operationInFlight)]}
									onPress={resetBaseline}
								/>
							</Section>
							<Section title={`Saved points · ${points.length}`}>
								{points.length === 0 ? (
									<ContentUnavailableView
										description="Capture a known-safe state before reproducing an issue."
										systemImage="clock.arrow.circlepath"
										title="No restore points"
									/>
								) : (
									[...points].reverse().map((point) => (
										<DisclosureGroup
											key={point.id}
											label={`${point.label} — ${formatRelativeTime(point.createdAt, now)}`}
										>
											<LabeledContent label="Contents">
												<UIText>{describePoint(point)}</UIText>
											</LabeledContent>
											{point.sources.map((snapshot) => (
												<DisclosureGroup
													key={snapshot.sourceId}
													label={`${snapshot.sourceTitle} — ${formatBytes(snapshot.bytes)}`}
												>
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
														{snapshot.preview}
													</UIText>
												</DisclosureGroup>
											))}
											<Button
												label="Restore this point"
												modifiers={[disabled(operationInFlight)]}
												onPress={() => restorePoint(point)}
											/>
											<Button
												label="Delete restore point"
												modifiers={[disabled(operationInFlight)]}
												onPress={() => deletePoint(point)}
											/>
										</DisclosureGroup>
									))
								)}
							</Section>
							<Section title="Registered sources">
								{sources.length === 0 ? (
									<Label
										color={PlatformColor('systemOrangeColor')}
										systemImage="exclamationmark.triangle.fill"
										title="No sources registered"
									/>
								) : (
									sources.map((source) => (
										<DisclosureGroup key={source.id} label={source.title}>
											<UIText>
												{source.description ??
													'Explicit app-owned state source'}
											</UIText>
											<LabeledContent label="Source id">
												<UIText>{source.id}</UIText>
											</LabeledContent>
										</DisclosureGroup>
									))
								)}
							</Section>
						</List>
					</Host>
				) : (
					<AndroidPanelScroll>
						<AndroidPanelSection
							footer={`Restore points are JSON-only, bounded, and ${retentionDescription}. A rollback snapshot is taken before every restore.`}
							title="Safety"
						>
							<AndroidPanelRow
								label="Capture restore point"
								onPress={operationInFlight ? undefined : capturePoint}
								value={operationInFlight ? 'Working…' : undefined}
							/>
							<AndroidPanelRow
								label="Reset explicit baselines"
								onPress={operationInFlight ? undefined : resetBaseline}
								value={operationInFlight ? 'Working…' : undefined}
							/>
						</AndroidPanelSection>
						{points.length === 0 ? (
							<AndroidPanelSection title="Saved points · 0">
								<AndroidPanelRow
									detail="Capture a known-safe state before reproducing an issue."
									label="No restore points"
								/>
							</AndroidPanelSection>
						) : (
							[...points].reverse().map((point) => (
								<AndroidPanelSection
									key={point.id}
									title={`${point.label} · ${formatRelativeTime(point.createdAt, now)}`}
								>
									<AndroidPanelRow
										label="Contents"
										value={describePoint(point)}
									/>
									{point.sources.map((snapshot) => (
										<AndroidPanelTextBlock
											key={snapshot.sourceId}
											label={`${snapshot.sourceTitle} · ${formatBytes(snapshot.bytes)}`}
											value={snapshot.preview}
										/>
									))}
									<AndroidPanelRow
										label="Restore this point"
										onPress={
											operationInFlight ? undefined : () => restorePoint(point)
										}
										value={operationInFlight ? 'Working…' : undefined}
									/>
									<AndroidPanelRow
										label="Delete restore point"
										onPress={
											operationInFlight ? undefined : () => deletePoint(point)
										}
										tone="danger"
										value={operationInFlight ? 'Working…' : undefined}
									/>
								</AndroidPanelSection>
							))
						)}
						<AndroidPanelSection title="Registered sources">
							{sources.length === 0 ? (
								<AndroidPanelRow label="No sources registered" tone="warning" />
							) : (
								sources.map((source) => (
									<AndroidPanelRow
										detail={
											source.description ?? 'Explicit app-owned state source'
										}
										key={source.id}
										label={source.title}
										value={source.id}
									/>
								))
							)}
						</AndroidPanelSection>
					</AndroidPanelScroll>
				)}
			</PanelShell>
		);
	}

	return {
		plugin: {
			id,
			title,
			description:
				options.description ?? 'Capture and safely restore explicit app state',
			systemImage: options.systemImage ?? 'clock.arrow.circlepath',
			tint:
				Platform.OS === 'ios' ? PlatformColor('systemTealColor') : '#30B0C7',
			section: options.section,
			Panel: RestorePointsPanel,
		},
		ready: repository.ready,
		capture,
		restore,
		restoreDetailed,
		resetToBaseline,
		rename,
		duplicate,
		remove,
		clear,
		exportJson: () => repository.exportJson(),
		importJson,
		getPoints: repository.getSnapshot,
		getReceipts: receiptStore.getSnapshot,
	};
}

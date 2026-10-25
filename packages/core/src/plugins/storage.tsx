import {
	Button,
	ContentUnavailableView,
	DisclosureGroup,
	Host,
	HStack,
	Image,
	Label,
	LabeledContent,
	List,
	Section,
	Spacer,
	TextField,
	Text as UIText,
	VStack,
} from '@expo/ui/swift-ui';
import {
	autocorrectionDisabled,
	font,
	foregroundStyle,
	listStyle,
	refreshable,
} from '@expo/ui/swift-ui/modifiers';
import { Fragment, useMemo, useState, useSyncExternalStore } from 'react';
import { Platform, PlatformColor } from 'react-native';
import {
	AndroidPanelRow,
	AndroidPanelScroll,
	AndroidPanelSearch,
	AndroidPanelSection,
	AndroidPanelTabs,
} from '../components/android-panel-ui';
import { NavIconButton } from '../components/nav-controls';
import { PanelShell } from '../components/panel-shell';
import { BoundedEventStore, ExternalStore } from '../core/external-store';
import { formatBytes, formatRelativeTime } from '../core/format';
import { assertPositiveFinite, assertPositiveInteger } from '../core/options';
import { serializeValue } from '../core/serialize';
import type {
	DevToolsPanelPlugin,
	DevToolsPanelProps,
	DevToolsSystemImage,
} from '../types';
import {
	type DevToolsStorageAdapter,
	diffStorageValues,
	normalizeStorageConfiguration,
	parseStorageDraft,
	type StorageAdapterSnapshot,
	type StorageChangeEvent,
	type StorageEntrySnapshot,
	type StorageKeyRule,
	type StorageSnapshot,
	snapshotStorageAdapter,
	validateStorageSnapshot,
} from './storage-model';

export type {
	DevToolsStorageAdapter,
	StorageAdapterCapabilities,
	StorageAdapterSnapshot,
	StorageChangeEvent,
	StorageEntrySnapshot,
	StorageKeyRule,
	StorageRegisteredKey,
	StorageSnapshot,
	StorageSnapshotLimits,
	StorageStructuralDiffEntry,
	StorageValidationResult,
} from './storage-model';
export {
	diffStorageValues,
	isStorageEntryEditable,
	parseStorageDraft,
	validateStorageSnapshot,
} from './storage-model';

export type StoragePluginOptions = {
	adapters: readonly DevToolsStorageAdapter[];
	rules?: readonly StorageKeyRule[];
	maxValueBytes?: number;
	maxEntriesPerAdapter?: number;
	maxAdapterBytes?: number;
	maxTotalBytes?: number;
	maxEvents?: number;
	title?: string;
	id?: string;
	description?: string;
	section?: string;
	systemImage?: DevToolsSystemImage;
};

export type StoragePlugin = {
	plugin: DevToolsPanelPlugin;
	refresh: () => Promise<void>;
	getSnapshot: () => StorageSnapshot;
	getEvents: () => readonly StorageChangeEvent[];
	clearEvents: () => void;
	toggleEventBookmark: (eventId: number) => void;
	undoEvent: (eventId: number) => Promise<boolean>;
};

const MAX_VALUE_BYTES = 1024 * 1024;
const MAX_ENTRIES_PER_ADAPTER = 10_000;
const MAX_ADAPTER_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_STORAGE_EVENTS = 10_000;

import {
	ActivityEventRow,
	AndroidStorageEntryDetails,
	countStorageChars,
	describeAdapterSnapshot,
	describeStorageEntry,
	describeStorageEvent,
	describeStorageGroup,
	describeValidationIssue,
	describeValueLength,
	groupStorageEntries,
	pluralizeKeys,
	type RunStorageMutation,
	SectionInfoHeader,
	StorageEntryRow,
	StorageEventLabel,
	type StorageTab,
	StorageTabPicker,
} from './storage-panel-components';

export function createStoragePlugin({
	adapters,
	rules = [],
	maxValueBytes = 256 * 1024,
	maxEntriesPerAdapter = 500,
	maxAdapterBytes = 2 * 1024 * 1024,
	maxTotalBytes = 4 * 1024 * 1024,
	maxEvents = 200,
	title = 'Storage',
	id = 'storage',
	description = 'Registered application storage adapters',
	section,
	systemImage = 'externaldrive.fill',
}: StoragePluginOptions): StoragePlugin {
	assertPositiveFinite(maxValueBytes, 'maxValueBytes');
	assertPositiveInteger(maxEntriesPerAdapter, 'maxEntriesPerAdapter');
	assertPositiveFinite(maxAdapterBytes, 'maxAdapterBytes');
	assertPositiveFinite(maxTotalBytes, 'maxTotalBytes');
	assertPositiveInteger(maxEvents, 'maxEvents');
	if (maxValueBytes > MAX_VALUE_BYTES) {
		throw new Error(`maxValueBytes cannot exceed ${MAX_VALUE_BYTES}`);
	}
	if (maxEntriesPerAdapter > MAX_ENTRIES_PER_ADAPTER) {
		throw new Error(
			`maxEntriesPerAdapter cannot exceed ${MAX_ENTRIES_PER_ADAPTER}`,
		);
	}
	if (maxAdapterBytes > MAX_ADAPTER_BYTES) {
		throw new Error(`maxAdapterBytes cannot exceed ${MAX_ADAPTER_BYTES}`);
	}
	if (maxTotalBytes > MAX_TOTAL_BYTES) {
		throw new Error(`maxTotalBytes cannot exceed ${MAX_TOTAL_BYTES}`);
	}
	if (maxEvents > MAX_STORAGE_EVENTS) {
		throw new Error(`maxEvents cannot exceed ${MAX_STORAGE_EVENTS}`);
	}
	const configuration = normalizeStorageConfiguration(adapters, rules);
	adapters = configuration.adapters;
	rules = configuration.rules;
	const store = new ExternalStore<StorageSnapshot>({
		loading: false,
		adapters: [],
	});
	const eventStore = new BoundedEventStore<StorageChangeEvent>({
		maxEvents,
		maxBytes: 2 * 1024 * 1024,
		estimateBytes: (event) => serializeValue(event, 128 * 1024).estimatedBytes,
	});
	let installCount = 0;
	let subscriptions: Array<() => void> = [];
	let lifecycleGeneration = 0;
	let nextEventId = 1;
	const undoRetentionMs = 10 * 60 * 1_000;
	const adapterBaselines = new Set<string>();
	const eventLifecycles = new Map<number, number>();
	const undoInFlight = new Set<number>();
	let refreshInFlight: Promise<void> | undefined;
	let refreshRequested = false;
	const stopLoading = (): void => {
		const snapshot = store.getSnapshot();
		if (snapshot.loading) store.set({ ...snapshot, loading: false });
	};
	const canRestoreEntryValue = (
		entry: StorageEntrySnapshot | undefined,
	): entry is StorageEntrySnapshot & { value: string } =>
		entry !== undefined &&
		!entry.valueHidden &&
		!entry.truncated &&
		!entry.redacted &&
		!entry.binary &&
		!entry.readError &&
		entry.value !== undefined;
	const appendEvent = (event: Omit<StorageChangeEvent, 'id'>): void => {
		const id = nextEventId++;
		eventStore.append({ id, ...event });
		eventLifecycles.set(id, lifecycleGeneration);
		const retainedIds = new Set(
			eventStore.getSnapshot().map((candidate) => candidate.id),
		);
		for (const retainedId of eventLifecycles.keys()) {
			if (!retainedIds.has(retainedId)) eventLifecycles.delete(retainedId);
		}
	};
	const clearEvents = (): void => {
		eventLifecycles.clear();
		eventStore.clear();
	};

	const recordChanges = (previous: StorageSnapshot, next: StorageSnapshot) => {
		for (const adapter of next.adapters) {
			const oldAdapter = previous.adapters.find(
				(candidate) => candidate.id === adapter.id,
			);
			if (
				adapter.error ||
				oldAdapter?.error ||
				adapter.truncated ||
				oldAdapter?.truncated
			) {
				continue;
			}
			if (!adapterBaselines.has(adapter.id)) {
				adapterBaselines.add(adapter.id);
				continue;
			}
			const oldEntries = new Map(
				(oldAdapter?.entries ?? []).map((entry) => [entry.key, entry]),
			);
			const newEntries = new Map(
				adapter.entries.map((entry) => [entry.key, entry]),
			);
			for (const entry of adapter.entries) {
				const old = oldEntries.get(entry.key);
				if (
					!old ||
					old.value !== entry.value ||
					old.valueHidden !== entry.valueHidden ||
					old.readError !== entry.readError
				) {
					appendEvent({
						at: Date.now(),
						adapterId: adapter.id,
						adapterTitle: adapter.title,
						key: entry.key,
						type: old ? 'updated' : 'added',
						previousValue: entry.valueHidden ? undefined : old?.value,
						previousValueType: entry.valueHidden ? undefined : old?.valueType,
						value: entry.valueHidden ? undefined : entry.value,
						valueType: entry.valueHidden ? undefined : entry.valueType,
						valueHidden: entry.valueHidden,
						undoAvailable: old
							? canRestoreEntryValue(old) &&
								adapter.capabilities?.writable === true
							: adapter.capabilities?.deletable === true,
						undoExpiresAt: Date.now() + undoRetentionMs,
						undoStatus: 'available',
						structuralDiff: entry.valueHidden
							? undefined
							: diffStorageValues(old?.value, entry.value),
					});
				}
			}
			for (const old of oldEntries.values()) {
				if (!newEntries.has(old.key))
					appendEvent({
						at: Date.now(),
						adapterId: adapter.id,
						adapterTitle: adapter.title,
						key: old.key,
						type: 'removed',
						previousValue: old.valueHidden ? undefined : old.value,
						previousValueType: old.valueHidden ? undefined : old.valueType,
						valueHidden: old.valueHidden,
						undoAvailable:
							canRestoreEntryValue(old) &&
							adapter.capabilities?.writable === true,
						undoExpiresAt: Date.now() + undoRetentionMs,
						undoStatus: 'available',
						structuralDiff: old.valueHidden
							? undefined
							: diffStorageValues(old.value, undefined),
					});
			}
		}
	};

	const performRefresh = async (generation: number): Promise<void> => {
		store.set({ ...store.getSnapshot(), loading: true });
		const snapshots: StorageAdapterSnapshot[] = [];
		let remainingBytes = maxTotalBytes;
		for (const adapter of adapters) {
			const snapshot = await snapshotStorageAdapter(adapter, maxValueBytes, {
				maxEntries: maxEntriesPerAdapter,
				maxSnapshotBytes: Math.min(maxAdapterBytes, remainingBytes),
			});
			snapshots.push(snapshot);
			remainingBytes = Math.max(0, remainingBytes - snapshot.estimatedBytes);
		}
		if (generation !== lifecycleGeneration) return;
		const next = { loading: false, adapters: snapshots };
		recordChanges(store.getSnapshot(), next);
		store.set(next);
	};

	const refresh = async (): Promise<void> => {
		if (refreshInFlight) {
			refreshRequested = true;
			return refreshInFlight;
		}
		refreshInFlight = (async () => {
			do {
				refreshRequested = false;
				await performRefresh(lifecycleGeneration);
			} while (refreshRequested);
		})();
		try {
			await refreshInFlight;
		} finally {
			refreshInFlight = undefined;
		}
	};

	const scheduleRefresh = (): void => {
		if (refreshRequested) return;
		refreshRequested = true;
		const scheduledGeneration = lifecycleGeneration;
		try {
			queueMicrotask(() => {
				if (scheduledGeneration !== lifecycleGeneration || installCount === 0) {
					refreshRequested = false;
					return;
				}
				void refresh();
			});
		} catch {
			refreshRequested = false;
			stopLoading();
		}
	};

	function StoragePanel({ onBack, actions }: DevToolsPanelProps) {
		const snapshot = useSyncExternalStore(
			store.subscribe,
			store.getSnapshot,
			store.getServerSnapshot,
		);
		const events = useSyncExternalStore(
			eventStore.subscribe,
			eventStore.getSnapshot,
			eventStore.getServerSnapshot,
		);
		const [tab, setTab] = useState<StorageTab>('stores');
		const [openAdapterId, setOpenAdapterId] = useState<string | null>(null);
		const [search, setSearch] = useState('');
		const [expandedKey, setExpandedKey] = useState<string | null>(null);

		const runMutation: RunStorageMutation = (label, mutation, confirmation) => {
			void actions.run({
				pluginId: id,
				label,
				confirmation,
				action: async () => {
					await mutation();
					await refresh();
				},
			});
		};

		const openSnapshot = snapshot.adapters.find(
			(candidate) => candidate.id === openAdapterId,
		);
		const openAdapter = adapters.find(
			(candidate) => candidate.id === openAdapterId,
		);
		const browsing =
			openSnapshot && openAdapter
				? { adapter: openAdapter, snapshot: openSnapshot }
				: undefined;

		const validation = useMemo(
			() => validateStorageSnapshot(snapshot, rules),
			[snapshot],
		);
		const failing = validation.filter(
			(result) =>
				result.status === 'missing' ||
				result.status === 'typeMismatch' ||
				result.status === 'notCaptured',
		);

		const openStore = (adapterId: string) => {
			setSearch('');
			setExpandedKey(null);
			setOpenAdapterId(adapterId);
		};

		const now = Date.now();
		const recentEvents = events.slice(-3).reverse();
		const orderedEvents = [...events].reverse();
		const activitySections = [
			{
				title: 'Just now',
				events: orderedEvents.filter((event) => now - event.at < 60_000),
			},
			{
				title: 'Earlier this session',
				events: orderedEvents.filter((event) => now - event.at >= 60_000),
			},
		].filter((ageGroup) => ageGroup.events.length > 0);

		const totalChars = snapshot.adapters.reduce(
			(sum, adapter) => sum + countStorageChars(adapter),
			0,
		);

		const needle = search.trim().toLowerCase();
		const visibleEntries = browsing
			? browsing.snapshot.entries.filter(
					(entry) => !needle || entry.key.toLowerCase().includes(needle),
				)
			: [];
		const groups = groupStorageEntries(visibleEntries);

		return (
			<PanelShell
				backLabel={browsing ? title : undefined}
				onBack={browsing ? () => setOpenAdapterId(null) : onBack}
				title={browsing ? browsing.snapshot.title : title}
				trailing={
					browsing?.adapter.clear &&
					(browsing.snapshot.capabilities?.clearable ?? true) ? (
						<NavIconButton
							accessibilityLabel={`Clear ${browsing.snapshot.title}`}
							destructive
							onPress={() =>
								runMutation(
									'Clear storage adapter',
									() => browsing.adapter.clear?.(),
									{
										title: `Clear ${browsing.snapshot.title}?`,
										message: 'This cannot be undone.',
										confirmLabel: 'Clear',
										destructive: true,
									},
								)
							}
							systemImage="trash"
							testID="devtools-storage-clear-store"
						/>
					) : !browsing && tab === 'activity' ? (
						<NavIconButton
							accessibilityLabel="Clear activity"
							destructive
							onPress={() =>
								runMutation('Clear storage activity', clearEvents, {
									title: 'Clear recorded activity?',
									message:
										'The captured reads and writes are only held in memory, so this cannot be undone.',
									confirmLabel: 'Clear',
									destructive: true,
								})
							}
							systemImage="trash"
							testID="devtools-storage-clear-activity"
						/>
					) : undefined
				}
			>
				{Platform.OS === 'ios' ? (
					<Host style={{ flex: 1 }}>
						{browsing ? (
							<List
								key={`store:${browsing.snapshot.id}`}
								modifiers={[listStyle('insetGrouped'), refreshable(refresh)]}
							>
								<Section>
									<TextField
										modifiers={[autocorrectionDisabled()]}
										onTextChange={setSearch}
										placeholder={`Search ${pluralizeKeys(browsing.snapshot.entries.length)}`}
									/>
								</Section>
								{browsing.snapshot.error ? (
									<Section>
										<Label
											color={PlatformColor('systemOrangeColor')}
											systemImage="exclamationmark.triangle.fill"
											title="Store unavailable"
										/>
										<UIText
											modifiers={[
												font({ textStyle: 'footnote' }),
												foregroundStyle('secondary'),
											]}
										>
											{browsing.snapshot.error}
										</UIText>
									</Section>
								) : null}
								{browsing.snapshot.truncated ? (
									<Section>
										<Label
											color={PlatformColor('systemOrangeColor')}
											systemImage="exclamationmark.triangle.fill"
											title="Snapshot limited"
										/>
										<UIText
											modifiers={[
												font({ textStyle: 'footnote' }),
												foregroundStyle('secondary'),
											]}
										>
											{`${browsing.snapshot.omittedKeyCount} ${browsing.snapshot.omittedKeyCount === 1 ? 'key was' : 'keys were'} omitted by the safe capture limits.`}
										</UIText>
									</Section>
								) : null}
								{groups.length === 0 ? (
									<Section>
										<ContentUnavailableView
											description={
												needle
													? `No keys match "${search.trim()}".`
													: browsing.snapshot.truncated
														? 'No keys fit within the safe capture limits.'
														: 'This store is empty.'
											}
											systemImage={needle ? 'magnifyingglass' : 'externaldrive'}
											title={needle ? 'No matching keys' : 'No keys'}
										/>
									</Section>
								) : (
									groups.map((group, index) => (
										<Section
											header={
												index === 0 ? (
													<SectionInfoHeader
														title={describeStorageGroup(group)}
													/>
												) : undefined
											}
											key={group.prefix}
											title={
												index === 0 ? undefined : describeStorageGroup(group)
											}
										>
											{group.entries.map((entry) => (
												<StorageEntryRow
													adapter={browsing.adapter}
													entry={entry}
													expanded={expandedKey === entry.key}
													key={entry.key}
													onExpandedChange={(next) =>
														setExpandedKey(next ? entry.key : null)
													}
													runMutation={runMutation}
												/>
											))}
										</Section>
									))
								)}
							</List>
						) : tab === 'stores' ? (
							<List
								modifiers={[listStyle('insetGrouped'), refreshable(refresh)]}
							>
								<StorageTabPicker onChange={setTab} selection={tab} />
								<Section
									header={
										<SectionInfoHeader
											title={
												totalChars > 0
													? `On this device · ${formatBytes(totalChars)}`
													: 'On this device'
											}
										/>
									}
								>
									{snapshot.adapters.length === 0 ? (
										<ContentUnavailableView
											description="No storage adapters are registered."
											systemImage="externaldrive"
											title="No stores"
										/>
									) : (
										snapshot.adapters.map((adapterSnapshot) => (
											<Button
												key={adapterSnapshot.id}
												onPress={() => openStore(adapterSnapshot.id)}
											>
												<HStack spacing={12}>
													<Image
														color={
															adapterSnapshot.sensitive
																? PlatformColor('systemYellowColor')
																: PlatformColor('systemGrayColor')
														}
														size={20}
														systemName={
															adapterSnapshot.sensitive
																? 'lock.fill'
																: 'externaldrive.fill'
														}
													/>
													<VStack alignment="leading" spacing={2}>
														<UIText
															modifiers={[
																foregroundStyle(PlatformColor('labelColor')),
															]}
														>
															{adapterSnapshot.title}
														</UIText>
														<UIText
															modifiers={[
																font({ textStyle: 'footnote' }),
																foregroundStyle('secondary'),
															]}
														>
															{describeAdapterSnapshot(adapterSnapshot)}
														</UIText>
													</VStack>
													<Spacer />
													<Image
														color={PlatformColor('tertiaryLabelColor')}
														size={13}
														systemName="chevron.right"
													/>
												</HStack>
											</Button>
										))
									)}
								</Section>
								{validation.length > 0 ? (
									<Section title="Health">
										{failing.length === 0 ? (
											<Label
												color={PlatformColor('systemGreenColor')}
												systemImage="checkmark.circle.fill"
												title={`All expected keys present · ${validation.length} ${validation.length === 1 ? 'check' : 'checks'}`}
											/>
										) : (
											<>
												<Label
													color={PlatformColor('systemOrangeColor')}
													systemImage="exclamationmark.triangle.fill"
													title={`${failing.length} of ${validation.length} ${validation.length === 1 ? 'check' : 'checks'} failing`}
												/>
												{failing.map((result) => (
													<DisclosureGroup
														key={`${result.adapterId}:${result.key}`}
														label={`${result.key} — ${describeValidationIssue(result)}`}
													>
														{result.description ? (
															<UIText>{result.description}</UIText>
														) : null}
														<LabeledContent label="Store">
															<UIText>{result.adapterId}</UIText>
														</LabeledContent>
														<LabeledContent label="Expected">
															<UIText>
																{result.expectedType ?? 'present'}
															</UIText>
														</LabeledContent>
														{result.actualType ? (
															<LabeledContent label="Actual">
																<UIText>{result.actualType}</UIText>
															</LabeledContent>
														) : null}
													</DisclosureGroup>
												))}
											</>
										)}
									</Section>
								) : null}
								<Section header={<SectionInfoHeader title="Recent activity" />}>
									{recentEvents.length === 0 ? (
										<UIText
											modifiers={[
												font({ textStyle: 'footnote' }),
												foregroundStyle('secondary'),
											]}
										>
											No changes recorded this session.
										</UIText>
									) : (
										recentEvents.map((event) => (
											<StorageEventLabel
												detail={`${event.adapterTitle} · ${formatRelativeTime(event.at, now)}`}
												event={event}
												key={event.id}
											/>
										))
									)}
									<Button
										label="See all activity"
										onPress={() => setTab('activity')}
									/>
								</Section>
							</List>
						) : (
							<List modifiers={[listStyle('insetGrouped')]}>
								<StorageTabPicker onChange={setTab} selection={tab} />
								{activitySections.length === 0 ? (
									<Section>
										<ContentUnavailableView
											description="Storage mutations will appear here."
											systemImage="clock.arrow.circlepath"
											title="No storage activity"
										/>
									</Section>
								) : (
									activitySections.map((ageGroup, index) => (
										<Section
											header={
												index === 0 ? (
													<SectionInfoHeader title={ageGroup.title} />
												) : undefined
											}
											key={ageGroup.title}
											title={index === 0 ? undefined : ageGroup.title}
										>
											{ageGroup.events.map((event) => (
												<ActivityEventRow
													event={event}
													key={event.id}
													onBookmark={() => toggleEventBookmark(event.id)}
													onUndo={() => void undoEvent(event.id)}
												/>
											))}
										</Section>
									))
								)}
							</List>
						)}
					</Host>
				) : (
					<AndroidPanelScroll>
						{browsing ? (
							<>
								<AndroidPanelSearch
									onChangeText={setSearch}
									placeholder={`Search ${pluralizeKeys(browsing.snapshot.entries.length)}`}
									value={search}
								/>
								{browsing.snapshot.error || browsing.snapshot.truncated ? (
									<AndroidPanelSection title="Capture status">
										{browsing.snapshot.error ? (
											<AndroidPanelRow
												detail={browsing.snapshot.error}
												label="Store unavailable"
												tone="warning"
											/>
										) : null}
										{browsing.snapshot.truncated ? (
											<AndroidPanelRow
												detail={`${browsing.snapshot.omittedKeyCount} ${browsing.snapshot.omittedKeyCount === 1 ? 'key was' : 'keys were'} omitted by the safe capture limits.`}
												label="Snapshot limited"
												tone="warning"
											/>
										) : null}
									</AndroidPanelSection>
								) : null}
								{groups.length === 0 ? (
									<AndroidPanelSection title="Keys">
										<AndroidPanelRow
											detail={
												needle
													? `No keys match "${search.trim()}".`
													: browsing.snapshot.truncated
														? 'No keys fit within the safe capture limits.'
														: 'This store is empty.'
											}
											label={needle ? 'No matching keys' : 'No keys'}
										/>
									</AndroidPanelSection>
								) : null}
								{groups.map((group) => (
									<AndroidPanelSection
										key={group.prefix}
										title={`${group.prefix} · ${describeStorageGroup(group)}`}
									>
										{group.entries.map((entry) => {
											const expanded = expandedKey === entry.key;
											return (
												<Fragment key={entry.key}>
													<AndroidPanelRow
														detail={describeStorageEntry(entry)}
														label={entry.key}
														onPress={() =>
															setExpandedKey(expanded ? null : entry.key)
														}
														value={expanded ? 'Hide' : 'Inspect'}
													/>
													{expanded ? (
														<AndroidStorageEntryDetails
															adapter={browsing.adapter}
															entry={entry}
															key={`details:${entry.value ?? ''}`}
															runMutation={runMutation}
														/>
													) : null}
												</Fragment>
											);
										})}
									</AndroidPanelSection>
								))}
								<AndroidPanelSection title="Actions">
									<AndroidPanelRow
										label={
											snapshot.loading ? 'Refreshing…' : 'Refresh snapshot'
										}
										onPress={
											snapshot.loading
												? undefined
												: () =>
														void actions.run({
															pluginId: id,
															label: 'Refresh storage snapshot',
															action: refresh,
														})
										}
									/>
								</AndroidPanelSection>
							</>
						) : (
							<>
								<AndroidPanelTabs
									onSelect={setTab}
									options={[
										{ label: 'Stores', value: 'stores' },
										{ label: 'Activity', value: 'activity' },
									]}
									selected={tab}
								/>
								{tab === 'stores' ? (
									<>
										<AndroidPanelSection title="Stores">
											{snapshot.adapters.length === 0 ? (
												<AndroidPanelRow
													label={
														snapshot.loading ? 'Loading stores…' : 'No stores'
													}
												/>
											) : null}
											{snapshot.adapters.map((adapter) => (
												<AndroidPanelRow
													key={adapter.id}
													label={adapter.title}
													detail={adapter.description}
													onPress={() => openStore(adapter.id)}
													tone={adapter.error ? 'warning' : 'default'}
													value={describeAdapterSnapshot(adapter)}
												/>
											))}
										</AndroidPanelSection>
										{validation.length > 0 ? (
											<AndroidPanelSection title="Health">
												<AndroidPanelRow
													label={
														failing.length === 0
															? 'All expected keys present'
															: `${failing.length} checks failing`
													}
													tone={failing.length === 0 ? 'success' : 'warning'}
												/>
											</AndroidPanelSection>
										) : null}
										<AndroidPanelSection
											title="Recent activity"
											footer={`${describeValueLength(totalChars)} captured`}
										>
											{recentEvents.length === 0 ? (
												<AndroidPanelRow label="No changes recorded this session" />
											) : (
												recentEvents.map((event) => (
													<AndroidPanelRow
														key={event.id}
														label={event.key}
														detail={event.adapterTitle}
														value={describeStorageEvent(event)}
													/>
												))
											)}
										</AndroidPanelSection>
									</>
								) : (
									<AndroidPanelSection title={`Activity · ${events.length}`}>
										{orderedEvents.length === 0 ? (
											<AndroidPanelRow label="No storage activity" />
										) : (
											orderedEvents.map((event) => (
												<AndroidPanelRow
													key={event.id}
													label={event.key}
													detail={event.adapterTitle}
													value={describeStorageEvent(event)}
												/>
											))
										)}
									</AndroidPanelSection>
								)}
							</>
						)}
					</AndroidPanelScroll>
				)}
			</PanelShell>
		);
	}

	const plugin: DevToolsPanelPlugin = {
		id,
		title,
		description,
		systemImage,
		section,
		Panel: StoragePanel,
		install: () => {
			installCount += 1;
			if (installCount === 1) {
				lifecycleGeneration += 1;
				const installedGeneration = lifecycleGeneration;
				void refresh();
				const installedSubscriptions: Array<() => void> = [];
				try {
					for (const adapter of adapters) {
						if (adapter.subscribe) {
							const subscription = {
								active: true,
								dispose: undefined as (() => void) | undefined,
							};
							installedSubscriptions.push(() => {
								subscription.active = false;
								subscription.dispose?.();
							});
							const unsubscribe = adapter.subscribe(() => {
								if (
									!subscription.active ||
									installCount === 0 ||
									installedGeneration !== lifecycleGeneration
								)
									return;
								scheduleRefresh();
							});
							if (typeof unsubscribe !== 'function') {
								throw new Error(
									`Storage adapter ${adapter.id} did not return an unsubscribe function.`,
								);
							}
							subscription.dispose = unsubscribe;
						}
					}
					subscriptions = installedSubscriptions;
				} catch (error) {
					for (const unsubscribe of installedSubscriptions) {
						try {
							unsubscribe();
						} catch {
							// Continue rollback so one broken adapter cannot leak others.
						}
					}
					installCount = 0;
					lifecycleGeneration += 1;
					stopLoading();
					throw error;
				}
			}
			let referenceActive = true;
			return () => {
				if (!referenceActive) return;
				referenceActive = false;
				installCount = Math.max(0, installCount - 1);
				if (installCount === 0) {
					lifecycleGeneration += 1;
					for (const unsubscribe of subscriptions) {
						try {
							unsubscribe();
						} catch {
							// Dispose every adapter even if one listener throws.
						}
					}
					subscriptions = [];
					refreshRequested = false;
					adapterBaselines.clear();
					clearEvents();
					store.set({ loading: false, adapters: [] });
				}
			};
		},
	};

	const toggleEventBookmark = (eventId: number): void => {
		const event = eventStore
			.getSnapshot()
			.find((candidate) => candidate.id === eventId);
		if (!event) return;
		eventStore.replace((candidate) => candidate.id === eventId, {
			...event,
			bookmarked: !event.bookmarked,
		});
	};

	const undoEvent = async (eventId: number): Promise<boolean> => {
		if (undoInFlight.has(eventId)) return false;
		const generation = lifecycleGeneration;
		let event = eventStore
			.getSnapshot()
			.find((candidate) => candidate.id === eventId);
		if (
			!event?.undoAvailable ||
			event.valueHidden ||
			eventLifecycles.get(eventId) !== generation
		) {
			return false;
		}
		if (!event.undoExpiresAt || event.undoExpiresAt <= Date.now()) {
			eventStore.replace((candidate) => candidate.id === eventId, {
				...event,
				undoAvailable: false,
				undoStatus: 'expired',
			});
			return false;
		}
		const adapterId = event.adapterId;
		const adapter = adapters.find((candidate) => candidate.id === adapterId);
		if (!adapter) return false;
		undoInFlight.add(eventId);
		try {
			await refresh();
			if (
				generation !== lifecycleGeneration ||
				eventLifecycles.get(eventId) !== generation
			) {
				return false;
			}
			event = eventStore
				.getSnapshot()
				.find((candidate) => candidate.id === eventId);
			if (!event?.undoAvailable || event.valueHidden) return false;
			const currentAdapter = store
				.getSnapshot()
				.adapters.find((candidate) => candidate.id === event?.adapterId);
			const currentEntry = currentAdapter?.entries.find(
				(candidate) => candidate.key === event?.key,
			);
			const currentStateMatches =
				currentAdapter !== undefined &&
				!currentAdapter.error &&
				!currentAdapter.truncated &&
				(event.type === 'removed'
					? currentEntry === undefined
					: currentEntry !== undefined &&
						!currentEntry.valueHidden &&
						!currentEntry.truncated &&
						!currentEntry.redacted &&
						!currentEntry.binary &&
						!currentEntry.readError &&
						currentEntry.value === event.value &&
						currentEntry.valueType === event.valueType);
			if (!currentStateMatches) {
				eventStore.replace((candidate) => candidate.id === eventId, {
					...event,
					undoAvailable: false,
					undoStatus: 'failed',
				});
				return false;
			}
			if (event.type === 'added') {
				if (!adapter.removeValue) return false;
				await adapter.removeValue(event.key);
			} else {
				if (!adapter.setValue || event.previousValue === undefined)
					return false;
				const value = adapter.parseValue
					? adapter.parseValue(
							event.key,
							event.previousValue,
							event.previousValueType ?? 'string',
						)
					: parseStorageDraft(
							event.previousValue,
							event.previousValueType ?? 'string',
						);
				await adapter.setValue(event.key, value);
			}
			if (generation !== lifecycleGeneration) return false;
			eventStore.replace((candidate) => candidate.id === eventId, {
				...event,
				undoAvailable: false,
				undoStatus: 'succeeded',
			});
			await refresh();
			return true;
		} catch {
			if (generation === lifecycleGeneration && event) {
				eventStore.replace((candidate) => candidate.id === eventId, {
					...event,
					undoAvailable: false,
					undoStatus: 'failed',
				});
			}
			return false;
		} finally {
			undoInFlight.delete(eventId);
		}
	};

	return {
		plugin,
		refresh,
		getSnapshot: store.getSnapshot,
		getEvents: eventStore.getSnapshot,
		clearEvents,
		toggleEventBookmark,
		undoEvent,
	};
}

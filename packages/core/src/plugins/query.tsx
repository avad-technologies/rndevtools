import {
	Button,
	ContentUnavailableView,
	DisclosureGroup,
	Host,
	HStack,
	Image,
	LabeledContent,
	List,
	Picker,
	Section,
	SwipeActions,
	TextField,
	Text as UIText,
	VStack,
} from '@expo/ui/swift-ui';
import {
	autocorrectionDisabled,
	badge,
	disabled,
	font,
	foregroundColor,
	listStyle,
	pickerStyle,
	tag,
	tint,
} from '@expo/ui/swift-ui/modifiers';
import type { Query, QueryClient } from '@tanstack/react-query';
import { Fragment, useMemo, useState, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import {
	AndroidPanelRow,
	AndroidPanelScroll,
	AndroidPanelSearch,
	AndroidPanelSection,
	AndroidPanelTabs,
	AndroidPanelTextBlock,
} from '../components/android-panel-ui';
import { PanelShell } from '../components/panel-shell';
import { ExternalStore } from '../core/external-store';
import { formatRelativeTime } from '../core/format';
import { assertPositiveFinite, assertPositiveInteger } from '../core/options';
import { diagnosticErrorText, sanitizeDiagnosticValue } from '../core/redact';
import { createRefCountedInstaller } from '../core/ref-counted-installer';
import { serializeValue, truncateText } from '../core/serialize';
import type {
	DevToolsPanelPlugin,
	DevToolsPanelProps,
	DevToolsSystemImage,
} from '../types';
import {
	createMutationSnapshot,
	createQuerySnapshot,
	type MutationSnapshot,
	type QueryPluginSnapshot,
	type QuerySnapshot,
	queryDiagnosticId,
} from './query-model';
import type {
	ActiveQuerySimulation,
	QuerySimulationController,
	QuerySimulationMode,
} from './query-simulation';

export type {
	MutationSnapshot,
	QueryPluginSnapshot,
	QuerySnapshot,
} from './query-model';
export { createMutationSnapshot } from './query-model';
export {
	type ActiveQuerySimulation,
	createQuerySimulationController,
	QUERY_SIMULATION_MODES,
	type QuerySimulationController,
	type QuerySimulationFamilyAdapter,
	type QuerySimulationFamilySnapshot,
	type QuerySimulationLease,
	type QuerySimulationMode,
	type QuerySimulationSnapshot,
} from './query-simulation';

export type QueryPluginOptions = {
	queryClient: QueryClient;
	simulation?: QuerySimulationController;
	captureData?: boolean;
	maxQueries?: number;
	maxMutations?: number;
	maxSnapshotBytes?: number;
	maxStoreBytes?: number;
	title?: string;
	id?: string;
	description?: string;
	section?: string;
	systemImage?: DevToolsSystemImage;
	tint?: string;
};

export type QueryPlugin = DevToolsPanelPlugin & {
	refresh: () => void;
	getSnapshot: () => QueryPluginSnapshot;
	captureSnapshot: () => QueryPluginSnapshot;
	runQueryAction: (
		queryId: string,
		action: 'invalidate' | 'refetch',
	) => Promise<void>;
	runSimulation: (
		familyId: string,
		mode: QuerySimulationMode,
	) => Promise<ActiveQuerySimulation>;
	clearSimulation: (receiptId?: string) => Promise<void>;
};

const MAX_QUERY_ENTRIES = 1_000;
const MAX_QUERY_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_QUERY_STORE_BYTES = 16 * 1024 * 1024;
const QUERY_SIMULATION_LABELS: Readonly<Record<QuerySimulationMode, string>> = {
	loading: 'Loading',
	error: 'Error',
	paused: 'Paused',
	offline: 'Offline',
};

function mostRecent<T>(
	values: readonly T[],
	limit: number,
	timestamp: (value: T) => number,
): readonly T[] {
	const selected: Array<{ value: T; at: number }> = [];
	for (const value of values) {
		const candidateAt = timestamp(value);
		const at = Number.isFinite(candidateAt) ? candidateAt : 0;
		if (
			selected.length === limit &&
			at <= (selected[selected.length - 1]?.at ?? 0)
		) {
			continue;
		}
		let low = 0;
		let high = selected.length;
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			if ((selected[middle]?.at ?? 0) >= at) low = middle + 1;
			else high = middle;
		}
		selected.splice(low, 0, { value, at });
		if (selected.length > limit) selected.pop();
	}
	return selected.map((entry) => entry.value);
}

function captureSnapshotsWithinBytes<
	Input,
	Snapshot extends QuerySnapshot | MutationSnapshot,
>(
	values: readonly Input[],
	budget: number,
	capture: (value: Input) => Snapshot,
): readonly Snapshot[] {
	const retained: Snapshot[] = [];
	let usedBytes = 0;
	for (const value of values) {
		const remainingBytes = Math.max(0, Math.floor(budget - usedBytes));
		if (remainingBytes === 0) break;
		const snapshot = capture(value);
		const serialized = serializeValue(snapshot, remainingBytes + 1);
		if (serialized.truncated || serialized.estimatedBytes > remainingBytes) {
			continue;
		}
		retained.push(snapshot);
		usedBytes += serialized.estimatedBytes;
	}
	return retained;
}

import {
	formatQueryKey,
	formatQueryKeyRemainder,
	formatTimestamp,
	groupQueriesByRoot,
	type InspectorTab,
	mutationDotColor,
	palette,
	queryStatusKind,
	type RunQueryAction,
	statusDotColors,
	statusLabels,
	summarizeError,
} from './query-presentation';

export * from './query-presentation';

function secondaryFootnote() {
	return [font({ textStyle: 'footnote' }), foregroundColor(palette.secondary)];
}

function MetadataRow({ label, value }: { label: string; value: string }) {
	return (
		<LabeledContent label={label}>
			<UIText>{value}</UIText>
		</LabeledContent>
	);
}

function SnapshotPreview({
	label,
	text,
	isError = false,
}: {
	label: string;
	text?: string;
	isError?: boolean;
}) {
	if (text === undefined) return null;
	return (
		<VStack alignment="leading" spacing={4}>
			<UIText
				modifiers={[
					font({ textStyle: 'footnote' }),
					foregroundColor(isError ? palette.red : palette.secondary),
				]}
			>
				{label}
			</UIText>
			<UIText modifiers={[font({ design: 'monospaced', size: 12 })]}>
				{text}
			</UIText>
		</VStack>
	);
}

export function createQueryPlugin({
	queryClient,
	simulation,
	captureData = false,
	maxQueries = 100,
	maxMutations = 100,
	maxSnapshotBytes = 64 * 1024,
	maxStoreBytes = 2 * 1024 * 1024,
	title = 'Queries',
	id = 'queries',
	description = 'TanStack Query and mutation cache state',
	section,
	systemImage = 'square.stack.3d.up.fill',
	tint: pluginTint = '#AF52DE',
}: QueryPluginOptions): QueryPlugin {
	assertPositiveInteger(maxQueries, 'maxQueries');
	assertPositiveInteger(maxMutations, 'maxMutations');
	assertPositiveFinite(maxSnapshotBytes, 'maxSnapshotBytes');
	assertPositiveFinite(maxStoreBytes, 'maxStoreBytes');
	if (maxQueries > MAX_QUERY_ENTRIES) {
		throw new Error(`maxQueries cannot exceed ${MAX_QUERY_ENTRIES}`);
	}
	if (maxMutations > MAX_QUERY_ENTRIES) {
		throw new Error(`maxMutations cannot exceed ${MAX_QUERY_ENTRIES}`);
	}
	if (maxSnapshotBytes > MAX_QUERY_SNAPSHOT_BYTES) {
		throw new Error(
			`maxSnapshotBytes cannot exceed ${MAX_QUERY_SNAPSHOT_BYTES}`,
		);
	}
	if (maxStoreBytes > MAX_QUERY_STORE_BYTES) {
		throw new Error(`maxStoreBytes cannot exceed ${MAX_QUERY_STORE_BYTES}`);
	}
	const store = new ExternalStore<QueryPluginSnapshot>({
		queries: [],
		mutations: [],
		sourceQueryCount: 0,
		omittedQueryCount: 0,
		sourceMutationCount: 0,
		omittedMutationCount: 0,
		...(simulation ? { simulation: simulation.getSnapshot() } : {}),
	});
	let installed = false;
	let refreshQueued = false;

	const buildSnapshot = (includeData: boolean): QueryPluginSnapshot => {
		const queryBudget = Math.floor(maxStoreBytes / 2);
		const mutationBudget = maxStoreBytes - queryBudget;
		const allQueries = queryClient.getQueryCache().getAll();
		const selectedQueries = mostRecent(
			allQueries,
			maxQueries,
			// A query that has never resolved has dataUpdatedAt 0, so ranking on it
			// alone drops in-flight and freshly-mounted queries first — exactly the
			// ones being debugged. Rank those by when they started fetching.
			(query) =>
				Math.max(query.state.dataUpdatedAt, query.state.errorUpdatedAt) ||
				(query.state.fetchStatus === 'fetching' ? Date.now() : 0),
		);
		const allMutations = queryClient.getMutationCache().getAll();
		const selectedMutations = mostRecent(
			allMutations,
			maxMutations,
			(mutation) => mutation.state.submittedAt,
		);
		const retainedQueries = captureSnapshotsWithinBytes(
			selectedQueries,
			queryBudget,
			(query) =>
				createQuerySnapshot(
					query,
					includeData && captureData,
					maxSnapshotBytes,
				),
		);
		const retainedMutations = captureSnapshotsWithinBytes(
			selectedMutations,
			mutationBudget,
			(mutation) =>
				createMutationSnapshot(
					mutation,
					includeData && captureData,
					maxSnapshotBytes,
				),
		);
		return {
			queries: retainedQueries,
			mutations: retainedMutations,
			sourceQueryCount: allQueries.length,
			omittedQueryCount: Math.max(
				0,
				allQueries.length - retainedQueries.length,
			),
			sourceMutationCount: allMutations.length,
			omittedMutationCount: Math.max(
				0,
				allMutations.length - retainedMutations.length,
			),
			...(simulation ? { simulation: simulation.getSnapshot() } : {}),
		};
	};
	const captureSnapshot = (): QueryPluginSnapshot => buildSnapshot(true);
	const reportSnapshotError = (error: unknown): void => {
		store.set({
			...store.getSnapshot(),
			error: truncateText(diagnosticErrorText(error), 8 * 1024).text,
		});
	};
	const refresh = () => {
		refreshQueued = false;
		if (!installed) return;
		try {
			store.set(buildSnapshot(false));
		} catch (error) {
			reportSnapshotError(error);
		}
	};
	const scheduleRefresh = () => {
		if (refreshQueued) return;
		refreshQueued = true;
		try {
			queueMicrotask(refresh);
		} catch (error) {
			refreshQueued = false;
			reportSnapshotError(error);
		}
	};
	const filtersFor = (query: QuerySnapshot) => ({
		predicate: (candidate: Query) =>
			queryDiagnosticId(candidate) === query.hash,
	});
	const findLiveQuery = (queryId: string): Query | undefined =>
		queryClient
			.getQueryCache()
			.getAll()
			.find((candidate) => queryDiagnosticId(candidate) === queryId);
	const runQueryAction: QueryPlugin['runQueryAction'] = async (
		queryId,
		action,
	) => {
		if (action !== 'invalidate' && action !== 'refetch') {
			throw new Error('Unsupported query action.');
		}
		const query = findLiveQuery(queryId);
		if (!query) throw new Error('Query is no longer available.');
		const filters = { predicate: (candidate: Query) => candidate === query };
		if (action === 'invalidate') {
			await queryClient.invalidateQueries({ ...filters, refetchType: 'none' });
		} else {
			await queryClient.refetchQueries({ ...filters, type: 'all' });
		}
		refresh();
	};
	const install = createRefCountedInstaller(({ addCleanup }) => {
		installed = true;
		addCleanup(() => {
			installed = false;
			refreshQueued = false;
		});
		refresh();
		addCleanup(queryClient.getQueryCache().subscribe(scheduleRefresh));
		addCleanup(queryClient.getMutationCache().subscribe(scheduleRefresh));
		if (simulation) {
			addCleanup(simulation.subscribe(scheduleRefresh));
			addCleanup(() => {
				void simulation.clear();
			});
		}
	});
	const queryPreviews = (query: QuerySnapshot) => {
		const liveQuery = findLiveQuery(query.hash);
		return {
			data:
				captureData && liveQuery
					? serializeValue(
							sanitizeDiagnosticValue(liveQuery.state.data),
							maxSnapshotBytes,
						)
					: undefined,
			error: liveQuery?.state.error
				? serializeValue(
						sanitizeDiagnosticValue(liveQuery.state.error),
						maxSnapshotBytes,
					)
				: undefined,
		};
	};

	function QueryDetails({ query }: { query: QuerySnapshot }) {
		const { data, error } = queryPreviews(query);
		return (
			<>
				<MetadataRow label="Hash" value={query.hash} />
				<MetadataRow label="Status" value={query.status} />
				<MetadataRow label="Fetch status" value={query.fetchStatus} />
				<MetadataRow label="Observers" value={String(query.observerCount)} />
				<MetadataRow
					label="Updated at"
					value={formatTimestamp(query.dataUpdatedAt)}
				/>
				<MetadataRow
					label="Failure count"
					value={String(query.fetchFailureCount)}
				/>
				<SnapshotPreview label="Data" text={data?.text} />
				<SnapshotPreview isError label="Error" text={error?.text} />
			</>
		);
	}

	function AndroidQueryRow({
		query,
		runAction,
	}: {
		query: QuerySnapshot;
		runAction: RunQueryAction;
	}) {
		const [expanded, setExpanded] = useState(false);
		const { data, error } = expanded ? queryPreviews(query) : {};
		return (
			<Fragment>
				<AndroidPanelRow
					detail={`${query.fetchStatus} · ${query.observerCount} observers`}
					label={formatQueryKeyRemainder(query.keySegments)}
					onPress={() => setExpanded((current) => !current)}
					tone={
						query.status === 'error'
							? 'danger'
							: query.isStale
								? 'warning'
								: 'success'
					}
					value={expanded ? 'Hide' : query.status}
				/>
				{expanded ? (
					<>
						<AndroidPanelRow label="Diagnostic ID" value={query.hash} />
						<AndroidPanelRow label="Status" value={query.status} />
						<AndroidPanelRow label="Fetch status" value={query.fetchStatus} />
						<AndroidPanelRow
							label="Updated at"
							value={formatTimestamp(query.dataUpdatedAt)}
						/>
						<AndroidPanelRow
							label="Failure count"
							value={String(query.fetchFailureCount)}
						/>
						{data ? (
							<AndroidPanelTextBlock label="Data" value={data.text} />
						) : null}
						{error ? (
							<AndroidPanelTextBlock
								label="Error"
								tone="danger"
								value={error.text}
							/>
						) : null}
						<AndroidPanelRow
							label="Invalidate query"
							onPress={() =>
								runAction('Invalidate query', () =>
									queryClient.invalidateQueries(filtersFor(query)),
								)
							}
						/>
						<AndroidPanelRow
							label="Refetch query"
							onPress={() =>
								runAction('Refetch query', () =>
									queryClient.refetchQueries(filtersFor(query)),
								)
							}
						/>
						<AndroidPanelRow
							label="Remove query"
							onPress={() =>
								runAction(
									'Remove query',
									() => queryClient.removeQueries(filtersFor(query)),
									{
										title: 'Remove query?',
										message: query.key,
										confirmLabel: 'Remove',
										destructive: true,
									},
								)
							}
							tone="danger"
						/>
					</>
				) : null}
			</Fragment>
		);
	}

	function QueryRow({
		query,
		runAction,
	}: {
		query: QuerySnapshot;
		runAction: RunQueryAction;
	}) {
		const [isExpanded, setIsExpanded] = useState(false);
		const kind = queryStatusKind(query);
		const updatedBadge = formatRelativeTime(query.dataUpdatedAt);
		// Row subtitles render from the captured snapshot only; reading the live
		// query cache during render tears against React Compiler caching.
		const errorLine =
			kind === 'error' ? summarizeError(query.error, undefined) : undefined;
		return (
			<SwipeActions>
				<DisclosureGroup
					isExpanded={isExpanded}
					onIsExpandedChange={setIsExpanded}
				>
					<DisclosureGroup.Label>
						<HStack
							modifiers={updatedBadge ? [badge(updatedBadge)] : undefined}
							spacing={12}
						>
							<Image
								color={statusDotColors[kind]}
								size={10}
								systemName="circle.fill"
							/>
							<VStack alignment="leading" spacing={2}>
								<UIText modifiers={[font({ design: 'monospaced', size: 15 })]}>
									{formatQueryKeyRemainder(query.keySegments)}
								</UIText>
								<UIText modifiers={secondaryFootnote()}>
									{`${query.observerCount} observer${query.observerCount === 1 ? '' : 's'} · ${statusLabels[kind]}`}
								</UIText>
								{errorLine ? (
									<UIText
										modifiers={[
											font({ textStyle: 'footnote' }),
											foregroundColor(palette.red),
										]}
									>
										{errorLine}
									</UIText>
								) : null}
							</VStack>
						</HStack>
					</DisclosureGroup.Label>
					{isExpanded ? <QueryDetails query={query} /> : null}
				</DisclosureGroup>
				<SwipeActions.Actions edge="trailing">
					{/* biome-ignore lint/a11y/useValidAriaRole: SwiftUI ButtonRole, not ARIA */}
					<Button
						label="Remove"
						onPress={() =>
							runAction(
								'Remove query',
								() => queryClient.removeQueries(filtersFor(query)),
								{
									title: 'Remove query?',
									message: query.key,
									confirmLabel: 'Remove',
									destructive: true,
								},
							)
						}
						role="destructive"
						systemImage="trash"
					/>
					<Button
						label="Refetch"
						modifiers={[tint(palette.orange)]}
						onPress={() =>
							runAction('Refetch query', () =>
								queryClient.refetchQueries(filtersFor(query)),
							)
						}
						systemImage="arrow.clockwise"
					/>
					<Button
						label="Invalidate"
						modifiers={[tint(palette.blue)]}
						onPress={() =>
							runAction('Invalidate query', () =>
								queryClient.invalidateQueries(filtersFor(query)),
							)
						}
						systemImage="arrow.triangle.2.circlepath"
					/>
				</SwipeActions.Actions>
			</SwipeActions>
		);
	}

	function MutationDetails({ mutation }: { mutation: MutationSnapshot }) {
		const liveMutation = queryClient
			.getMutationCache()
			.getAll()
			.find((candidate) => candidate.mutationId === mutation.id);
		const variables =
			captureData && liveMutation
				? serializeValue(
						sanitizeDiagnosticValue(liveMutation.state.variables),
						maxSnapshotBytes,
					)
				: undefined;
		const data =
			captureData && liveMutation
				? serializeValue(
						sanitizeDiagnosticValue(liveMutation.state.data),
						maxSnapshotBytes,
					)
				: undefined;
		const error = liveMutation?.state.error
			? serializeValue(
					sanitizeDiagnosticValue(liveMutation.state.error),
					maxSnapshotBytes,
				)
			: undefined;
		return (
			<>
				<MetadataRow label="ID" value={String(mutation.id)} />
				<MetadataRow label="Status" value={mutation.status} />
				<MetadataRow
					label="Submitted at"
					value={formatTimestamp(mutation.submittedAt)}
				/>
				<MetadataRow
					label="Failure count"
					value={String(mutation.failureCount)}
				/>
				<MetadataRow label="Paused" value={mutation.isPaused ? 'Yes' : 'No'} />
				<SnapshotPreview label="Variables" text={variables?.text} />
				<SnapshotPreview label="Data" text={data?.text} />
				<SnapshotPreview isError label="Error" text={error?.text} />
			</>
		);
	}

	function AndroidMutationRow({ mutation }: { mutation: MutationSnapshot }) {
		const [expanded, setExpanded] = useState(false);
		return (
			<Fragment>
				<AndroidPanelRow
					detail={`${mutation.failureCount} failures${mutation.isPaused ? ' · paused' : ''}`}
					label={formatQueryKey(mutation.keySegments)}
					onPress={() => setExpanded((current) => !current)}
					tone={mutation.status === 'error' ? 'danger' : 'default'}
					value={expanded ? 'Hide' : mutation.status}
				/>
				{expanded ? (
					<>
						<AndroidPanelRow label="ID" value={String(mutation.id)} />
						<AndroidPanelRow label="Status" value={mutation.status} />
						<AndroidPanelRow
							label="Submitted at"
							value={formatTimestamp(mutation.submittedAt)}
						/>
						<AndroidPanelRow
							label="Paused"
							value={mutation.isPaused ? 'Yes' : 'No'}
						/>
						{mutation.variables ? (
							<AndroidPanelTextBlock
								label="Variables"
								value={mutation.variables}
							/>
						) : null}
						{mutation.data ? (
							<AndroidPanelTextBlock label="Data" value={mutation.data} />
						) : null}
						{mutation.error ? (
							<AndroidPanelTextBlock
								label="Error"
								tone="danger"
								value={mutation.error}
							/>
						) : null}
					</>
				) : null}
			</Fragment>
		);
	}

	function MutationRow({ mutation }: { mutation: MutationSnapshot }) {
		const [isExpanded, setIsExpanded] = useState(false);
		return (
			<DisclosureGroup
				isExpanded={isExpanded}
				onIsExpandedChange={setIsExpanded}
			>
				<DisclosureGroup.Label>
					<HStack modifiers={[badge(mutation.status)]} spacing={12}>
						<Image
							color={mutationDotColor(mutation.status)}
							size={10}
							systemName="circle.fill"
						/>
						<VStack alignment="leading" spacing={2}>
							<UIText modifiers={[font({ design: 'monospaced', size: 15 })]}>
								{formatQueryKey(mutation.keySegments)}
							</UIText>
							<UIText modifiers={secondaryFootnote()}>
								{`${mutation.failureCount} failure${mutation.failureCount === 1 ? '' : 's'}${mutation.isPaused ? ' · paused' : ''}`}
							</UIText>
						</VStack>
					</HStack>
				</DisclosureGroup.Label>
				{isExpanded ? <MutationDetails mutation={mutation} /> : null}
			</DisclosureGroup>
		);
	}

	function QueryPanel({ onBack, actions }: DevToolsPanelProps) {
		const snapshot = useSyncExternalStore(
			store.subscribe,
			store.getSnapshot,
			store.getServerSnapshot,
		);
		const [tab, setTab] = useState<InspectorTab>('queries');
		const [search, setSearch] = useState('');
		const needle = search.trim().toLowerCase();
		const visibleQueries = useMemo(
			() =>
				snapshot.queries.filter(
					(query) => !needle || query.key.toLowerCase().includes(needle),
				),
			[needle, snapshot.queries],
		);
		const visibleMutations = useMemo(
			() =>
				snapshot.mutations.filter(
					(mutation) =>
						!needle ||
						mutation.key.toLowerCase().includes(needle) ||
						mutation.status.includes(needle),
				),
			[needle, snapshot.mutations],
		);
		const queryGroups = useMemo(
			() => groupQueriesByRoot(visibleQueries),
			[visibleQueries],
		);
		const runAction: RunQueryAction = (label, action, confirmation) => {
			void actions.run({ pluginId: id, label, action, confirmation });
		};
		const simulationSnapshot = snapshot.simulation;
		const activeSimulation = simulationSnapshot?.active;
		const [selectedFamilyId, setSelectedFamilyId] = useState(
			simulationSnapshot?.active?.familyId ??
				simulationSnapshot?.families[0]?.id ??
				'',
		);
		const selectedFamily =
			simulationSnapshot?.families.find(
				(candidate) => candidate.id === selectedFamilyId,
			) ?? simulationSnapshot?.families[0];
		const runSimulation = (mode: QuerySimulationMode): void => {
			if (!simulation || !selectedFamily) return;
			runAction(`Simulate query ${mode}`, () =>
				simulation.apply(selectedFamily.id, mode),
			);
		};
		const clearActiveSimulation = (): void => {
			if (!simulation || !activeSimulation) return;
			runAction('Reset query simulation', () =>
				simulation.clear(activeSimulation.receiptId),
			);
		};
		const fetching = snapshot.queries.filter(
			(query) => query.fetchStatus === 'fetching',
		).length;
		const stale = snapshot.queries.filter((query) => query.isStale).length;
		const errors = snapshot.queries.filter(
			(query) => query.status === 'error',
		).length;
		const capturedQueryCount =
			snapshot.omittedQueryCount > 0
				? `${snapshot.queries.length} OF ${snapshot.sourceQueryCount}`
				: String(snapshot.queries.length);
		const summary = `${capturedQueryCount} CACHED · ${fetching} FETCHING · ${stale} STALE · ${errors} ${errors === 1 ? 'ERROR' : 'ERRORS'}`;

		return (
			<PanelShell onBack={onBack} title={title}>
				{Platform.OS === 'ios' ? (
					<Host style={{ flex: 1 }}>
						<List modifiers={[listStyle('insetGrouped')]}>
							{simulationSnapshot && selectedFamily ? (
								<Section
									title={
										simulationSnapshot.active
											? 'Simulation active'
											: 'Simulation'
									}
								>
									{simulationSnapshot.active ? (
										<UIText modifiers={[foregroundColor(palette.orange)]}>
											{`${simulationSnapshot.active.familyLabel} · ${QUERY_SIMULATION_LABELS[simulationSnapshot.active.mode]}`}
										</UIText>
									) : null}
									{simulationSnapshot.families.length > 1 ? (
										<Picker
											onSelectionChange={(selection) =>
												setSelectedFamilyId(String(selection))
											}
											selection={selectedFamily.id}
										>
											{simulationSnapshot.families.map((family) => (
												<UIText key={family.id} modifiers={[tag(family.id)]}>
													{family.label}
												</UIText>
											))}
										</Picker>
									) : (
										<UIText modifiers={secondaryFootnote()}>
											{selectedFamily.description ?? selectedFamily.label}
										</UIText>
									)}
									{selectedFamily.modes.map((mode) => (
										<Fragment key={mode.mode}>
											<Button
												label={`Simulate ${QUERY_SIMULATION_LABELS[mode.mode]}`}
												modifiers={
													mode.supported ? undefined : [disabled(true)]
												}
												onPress={() => runSimulation(mode.mode)}
											/>
											{!mode.supported && mode.reason ? (
												<UIText modifiers={secondaryFootnote()}>
													{mode.reason}
												</UIText>
											) : null}
										</Fragment>
									))}
									{simulationSnapshot.active ? (
										<Button
											label="Reset simulation"
											onPress={clearActiveSimulation}
										/>
									) : null}
								</Section>
							) : null}
							<Section>
								<Picker
									modifiers={[pickerStyle('segmented')]}
									onSelectionChange={(selection) =>
										setTab(selection === 'mutations' ? 'mutations' : 'queries')
									}
									selection={tab}
								>
									<UIText modifiers={[tag('queries')]}>Queries</UIText>
									<UIText modifiers={[tag('mutations')]}>Mutations</UIText>
								</Picker>
								<TextField
									modifiers={[autocorrectionDisabled()]}
									onTextChange={setSearch}
									placeholder={
										tab === 'queries' ? 'Search query keys' : 'Search mutations'
									}
								/>
							</Section>
							{snapshot.error ? (
								<Section title="Capture unavailable">
									<UIText modifiers={[foregroundColor(palette.red)]}>
										{snapshot.error}
									</UIText>
								</Section>
							) : null}
							{tab === 'queries' ? (
								<>
									<Section
										header={
											<HStack spacing={5}>
												<UIText modifiers={secondaryFootnote()}>
													{summary}
												</UIText>
												<Image
													color={palette.secondary}
													size={13}
													systemName="info.circle"
												/>
											</HStack>
										}
									>
										{null}
									</Section>
									{queryGroups.length === 0 ? (
										<Section>
											<ContentUnavailableView
												description={
													snapshot.queries.length === 0
														? 'Query cache activity will appear here.'
														: 'No queries match the current search.'
												}
												systemImage="square.stack.3d.up"
												title="No queries to show"
											/>
										</Section>
									) : null}
									{queryGroups.map((group) => (
										<Section
											key={group.segment}
											title={`${group.segment} · ${group.queries.length}`}
										>
											{group.queries.map((query) => (
												<QueryRow
													key={query.hash}
													query={query}
													runAction={runAction}
												/>
											))}
										</Section>
									))}
								</>
							) : null}
							{tab === 'mutations' ? (
								visibleMutations.length === 0 ? (
									<Section>
										<ContentUnavailableView
											description={
												snapshot.mutations.length === 0
													? 'Mutation activity will appear here.'
													: 'No mutations match the current search.'
											}
											systemImage="bolt.horizontal"
											title="No mutations yet"
										/>
									</Section>
								) : (
									<Section title={`recent · ${visibleMutations.length}`}>
										{visibleMutations.map((mutation) => (
											<MutationRow key={mutation.id} mutation={mutation} />
										))}
									</Section>
								)
							) : null}
							<Section>
								<Button
									label="Invalidate all"
									onPress={() =>
										runAction(
											'Invalidate all queries',
											() => queryClient.invalidateQueries(),
											{
												title: 'Invalidate all queries?',
												message: 'Marks every cached query as stale.',
												confirmLabel: 'Invalidate',
											},
										)
									}
								/>
								{/* biome-ignore lint/a11y/useValidAriaRole: SwiftUI ButtonRole, not ARIA */}
								<Button
									label="Clear query cache"
									onPress={() =>
										runAction('Clear query cache', () => queryClient.clear(), {
											title: 'Clear query cache?',
											message: 'Removes every cached query and mutation.',
											confirmLabel: 'Clear',
											destructive: true,
										})
									}
									role="destructive"
								/>
							</Section>
						</List>
					</Host>
				) : (
					<AndroidPanelScroll>
						<AndroidPanelTabs
							onSelect={setTab}
							options={[
								{ label: 'Queries', value: 'queries' },
								{ label: 'Mutations', value: 'mutations' },
							]}
							selected={tab}
						/>
						<AndroidPanelSearch
							onChangeText={setSearch}
							placeholder={
								tab === 'queries' ? 'Search query keys' : 'Search mutations'
							}
							value={search}
						/>
						{simulationSnapshot && selectedFamily ? (
							<AndroidPanelSection
								title={
									simulationSnapshot.active
										? 'Simulation active'
										: `Simulation · ${selectedFamily.label}`
								}
							>
								{simulationSnapshot.active ? (
									<AndroidPanelRow
										detail="Only the registered host adapter is affected."
										label={simulationSnapshot.active.familyLabel}
										tone="warning"
										value={
											QUERY_SIMULATION_LABELS[simulationSnapshot.active.mode]
										}
									/>
								) : null}
								{selectedFamily.modes.map((mode) => (
									<AndroidPanelRow
										detail={mode.supported ? undefined : mode.reason}
										key={mode.mode}
										label={`Simulate ${QUERY_SIMULATION_LABELS[mode.mode]}`}
										onPress={
											mode.supported
												? () => runSimulation(mode.mode)
												: undefined
										}
										value={mode.supported ? 'Available' : 'Unsupported'}
									/>
								))}
								{simulationSnapshot.active ? (
									<AndroidPanelRow
										label="Reset simulation"
										onPress={clearActiveSimulation}
									/>
								) : null}
							</AndroidPanelSection>
						) : null}
						{snapshot.error ? (
							<AndroidPanelSection title="Capture unavailable">
								<AndroidPanelRow
									detail={snapshot.error}
									label="Query cache could not be refreshed"
									tone="danger"
								/>
							</AndroidPanelSection>
						) : null}
						{tab === 'queries' ? (
							<>
								<AndroidPanelSection title={summary}>
									{visibleQueries.length === 0 ? (
										<AndroidPanelRow label="No queries to show" />
									) : null}
								</AndroidPanelSection>
								{queryGroups.map((group) => (
									<AndroidPanelSection
										key={group.segment}
										title={`${group.segment} · ${group.queries.length}`}
									>
										{group.queries.map((query) => (
											<AndroidQueryRow
												key={query.hash}
												query={query}
												runAction={runAction}
											/>
										))}
									</AndroidPanelSection>
								))}
							</>
						) : (
							<AndroidPanelSection
								title={`Recent · ${visibleMutations.length}`}
							>
								{visibleMutations.length === 0 ? (
									<AndroidPanelRow label="No mutations yet" />
								) : (
									visibleMutations.map((mutation) => (
										<AndroidMutationRow key={mutation.id} mutation={mutation} />
									))
								)}
							</AndroidPanelSection>
						)}
						<AndroidPanelSection title="Actions">
							<AndroidPanelRow
								label="Invalidate all"
								onPress={() =>
									runAction(
										'Invalidate all queries',
										() => queryClient.invalidateQueries(),
										{
											title: 'Invalidate all queries?',
											message: 'Marks every cached query as stale.',
											confirmLabel: 'Invalidate',
										},
									)
								}
							/>
							<AndroidPanelRow
								label="Clear query cache"
								onPress={() =>
									runAction('Clear query cache', () => queryClient.clear(), {
										title: 'Clear query cache?',
										message: 'Removes every cached query and mutation.',
										confirmLabel: 'Clear',
										destructive: true,
									})
								}
								tone="danger"
							/>
						</AndroidPanelSection>
					</AndroidPanelScroll>
				)}
			</PanelShell>
		);
	}

	const simulationQuickAction = simulation
		? {
				options: () => {
					const snapshot = simulation.getSnapshot();
					if (snapshot.active) {
						const active = snapshot.active;
						return [
							{
								id: `reset:${active.receiptId}`,
								label: `Reset ${active.familyLabel} ${active.mode}`,
								action: () => simulation.clear(active.receiptId),
							},
						];
					}
					const family = snapshot.families[0];
					return (
						family?.modes
							.filter((mode) => mode.supported)
							.map((mode) => ({
								id: `${family.id}:${mode.mode}`,
								label: `${family.label} · ${QUERY_SIMULATION_LABELS[mode.mode]}`,
								action: () => simulation.apply(family.id, mode.mode),
							})) ?? []
					);
				},
				getSelectedOptionId: () => {
					const active = simulation.getSnapshot().active;
					return active ? `reset:${active.receiptId}` : null;
				},
				getIsHighlighted: () => simulation.getSnapshot().active !== undefined,
				openPanelLabel: 'Query simulation',
				subscribe: simulation.subscribe,
			}
		: undefined;

	return Object.assign(
		{
			id,
			title,
			description,
			systemImage,
			tint: pluginTint,
			section,
			Panel: QueryPanel,
			install,
			...(simulationQuickAction
				? { pillQuickAction: simulationQuickAction }
				: {}),
		},
		{
			refresh,
			getSnapshot: store.getSnapshot,
			captureSnapshot,
			runQueryAction,
			runSimulation: (familyId: string, mode: QuerySimulationMode) => {
				if (!simulation) {
					return Promise.reject(
						new Error('Query simulation is not configured by this host.'),
					);
				}
				return simulation.apply(familyId, mode);
			},
			clearSimulation: (receiptId?: string) => {
				if (!simulation) {
					return Promise.reject(
						new Error('Query simulation is not configured by this host.'),
					);
				}
				return simulation.clear(receiptId);
			},
		},
	);
}

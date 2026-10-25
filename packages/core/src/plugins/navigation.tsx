import {
	Button,
	DisclosureGroup,
	Host,
	HStack,
	Image,
	LabeledContent,
	List,
	Section,
	Spacer,
	SwipeActions,
	TextField,
	type TextFieldRef,
	Text as UIText,
	VStack,
} from '@expo/ui/swift-ui';
import {
	autocorrectionDisabled,
	buttonStyle,
	controlSize,
	disabled,
	fixedSize,
	font,
	foregroundStyle,
	keyboardType,
	lineLimit,
	listStyle,
	onSubmit,
	textInputAutocapitalization,
} from '@expo/ui/swift-ui/modifiers';
import { Fragment, useRef, useState, useSyncExternalStore } from 'react';
import { Platform, PlatformColor, View } from 'react-native';
import {
	AndroidPanelRow,
	AndroidPanelScroll,
	AndroidPanelSearch,
	AndroidPanelSection,
} from '../components/android-panel-ui';
import { NavIconButton } from '../components/nav-controls';
import { PanelShell } from '../components/panel-shell';
import type { DevtoolsEventStore } from '../core/event-store';
import { BoundedEventStore, ExternalStore } from '../core/external-store';
import { formatRelativeTime } from '../core/format';
import { diagnosticErrorText } from '../core/redact';
import { serializeValue } from '../core/serialize';
import type {
	DevToolsPanelPlugin,
	DevToolsPanelProps,
	DevToolsSystemImage,
} from '../types';
import {
	buildNavigationRoutePath,
	DEFAULT_MAX_CATALOG_BYTES,
	DEFAULT_MAX_ROUTES,
	DEFAULT_MAX_STACK_ENTRIES,
	getPinnedRoutes,
	getScreensSessionStore,
	MAX_NAVIGATION_CATALOG_BYTES,
	MAX_NAVIGATION_EVENTS,
	MAX_NAVIGATION_ROUTES,
	MAX_NAVIGATION_STACK_ENTRIES,
	type NavigationAction,
	type NavigationEvent,
	type NavigationRouteDescriptor,
	type NavigationStackEntry,
	type NavigationTransitionContext,
	type NavigationTransitionEvent,
	type NavigationTransitionPhase,
	navigationRouteDisplayName,
	normalizeNavigationRecordOptions,
	normalizeNavigationRoutes,
	normalizeNavigationStack,
	normalizeNavigationText,
	normalizeNavigationTransitionContext,
	positiveIntegerOption,
	rememberParamValues,
	routeGroupLabel,
	routeMatches,
	routeParamNames,
	setRoutePinned,
	stripGroupParens,
	subscribePinnedRoutes,
	truncateMiddleValue,
} from './navigation-model';

export type {
	NavigationAction,
	NavigationEvent,
	NavigationRouteDescriptor,
	NavigationRouteKind,
	NavigationStackEntry,
	NavigationTransitionContext,
} from './navigation-model';
export {
	buildNavigationRoutePath,
	getPinnedRoutes,
	inferNavigationRouteKind,
	navigationRouteDisplayName,
	routeParamNames,
	setRoutePinned,
	subscribePinnedRoutes,
} from './navigation-model';

export type NavigationPluginOptions = {
	actions?: readonly NavigationAction[];
	maxEvents?: number;
	maxRoutes?: number;
	maxStackEntries?: number;
	maxCatalogBytes?: number;
	title?: string;
	id?: string;
	description?: string;
	section?: string;
	systemImage?: DevToolsSystemImage;
	tint?: string;
	/**
	 * Jump handler: the host closes the tools and routes to the given path.
	 * When absent the panel renders route rows without tap navigation.
	 */
	onNavigate?: (path: string) => unknown | Promise<unknown>;
	/** Opens a raw deep link URL. When absent the deep link section is hidden. */
	onOpenDeepLink?: (url: string) => unknown | Promise<unknown>;
	/**
	 * Host URL scheme used to build the deep link field placeholder so the hint
	 * reads in the host's own scheme. Defaults to a neutral example.
	 */
	deepLinkScheme?: string;
	/** Optional shared, metadata-only timeline owned by the host. */
	eventStore?: DevtoolsEventStore;
	/** Injectable monotonic wall clock for deterministic hosts and tests. */
	now?: () => number;
};
export type NavigationPlugin = {
	plugin: DevToolsPanelPlugin;
	record: (
		route: string,
		options?: {
			segments?: readonly string[];
			metadata?: Readonly<Record<string, unknown>>;
		},
	) => void;
	updateRoutes: (routes: readonly NavigationRouteDescriptor[]) => void;
	updateStack: (stack: readonly NavigationStackEntry[]) => void;
	beginTransition: (
		route: string,
		context?: NavigationTransitionContext,
	) => string;
	failTransition: (transitionId: string, error: unknown) => void;
	navigate: (
		route: string,
		context?: NavigationTransitionContext,
	) => Promise<void>;
	clear: () => void;
	getEvents: () => readonly NavigationEvent[];
	getTransitions: () => readonly NavigationTransitionEvent[];
	getRoutes: () => readonly NavigationRouteDescriptor[];
	getStack: () => readonly NavigationStackEntry[];
};

const secondaryText = () => [
	font({ textStyle: 'footnote' }),
	foregroundStyle({ type: 'hierarchical', style: 'secondary' }),
];

const monoPathText = () => [
	font({ textStyle: 'footnote', design: 'monospaced' }),
	foregroundStyle({ type: 'hierarchical', style: 'secondary' }),
	lineLimit(1),
];

const groupLabelText = () => [
	font({ textStyle: 'footnote', weight: 'semibold' }),
	foregroundStyle({ type: 'hierarchical', style: 'secondary' }),
];

function SectionHeaderWithInfo({ title }: { title: string }) {
	return <UIText>{title}</UIText>;
}

export function createNavigationPlugin(
	options: NavigationPluginOptions = {},
): NavigationPlugin {
	const title = options.title ?? 'Screens';
	const id = options.id ?? 'navigation';
	const maxRoutes = positiveIntegerOption(
		options.maxRoutes,
		DEFAULT_MAX_ROUTES,
		'maxRoutes',
		MAX_NAVIGATION_ROUTES,
	);
	const maxStackEntries = positiveIntegerOption(
		options.maxStackEntries,
		DEFAULT_MAX_STACK_ENTRIES,
		'maxStackEntries',
		MAX_NAVIGATION_STACK_ENTRIES,
	);
	const maxCatalogBytes = positiveIntegerOption(
		options.maxCatalogBytes,
		DEFAULT_MAX_CATALOG_BYTES,
		'maxCatalogBytes',
		MAX_NAVIGATION_CATALOG_BYTES,
	);
	const maxEvents = positiveIntegerOption(
		options.maxEvents,
		100,
		'maxEvents',
		MAX_NAVIGATION_EVENTS,
	);
	const screensSessionStore = getScreensSessionStore(id);
	const historyStore = new BoundedEventStore<NavigationEvent>({
		maxEvents,
		maxBytes: 512 * 1024,
		estimateBytes: (event) => serializeValue(event, 64 * 1024).estimatedBytes,
	});
	const transitionStore = new BoundedEventStore<NavigationTransitionEvent>({
		maxEvents,
		maxBytes: 512 * 1024,
		estimateBytes: (event) => serializeValue(event, 64 * 1024).estimatedBytes,
	});
	const routesStore = new ExternalStore<readonly NavigationRouteDescriptor[]>(
		[],
	);
	const stackStore = new ExternalStore<readonly NavigationStackEntry[]>([]);
	const now = options.now ?? Date.now;
	let nextId = 1;
	let nextTransitionId = 1;
	type PendingTransition = {
		transitionId: string;
		route: string;
		requestedAt: number;
		committedAt?: number;
		source: NavigationTransitionEvent['source'];
		correlationId?: string;
	};
	const pendingTransitions = new Map<string, PendingTransition>();

	const appendTransition = (
		pending: PendingTransition,
		phase: NavigationTransitionPhase,
		at: number,
		extra: Readonly<{ durationMs?: number; error?: string }> = {},
	): void => {
		const event: NavigationTransitionEvent = Object.freeze({
			id: `${pending.transitionId}:${phase}`,
			transitionId: pending.transitionId,
			at,
			phase,
			route: pending.route,
			source: pending.source,
			...(pending.correlationId
				? { correlationId: pending.correlationId }
				: {}),
			...(extra.durationMs === undefined
				? {}
				: { durationMs: extra.durationMs }),
			...(extra.error ? { error: extra.error } : {}),
		});
		transitionStore.append(event);
		try {
			options.eventStore?.append({
				source: 'navigation',
				kind: `transition-${phase}`,
				level: phase === 'failed' ? 'error' : 'info',
				title: `Navigation ${phase}`,
				summary: pending.route,
				...(pending.correlationId
					? { correlationId: pending.correlationId }
					: {}),
				resourceRef: {
					toolId: 'routes',
					resourceId: pending.transitionId,
				},
				attributes: {
					phase,
					source: pending.source,
					...(extra.durationMs === undefined
						? {}
						: { durationMs: extra.durationMs }),
				},
			});
		} catch {
			// Shared diagnostics cannot interrupt application navigation.
		}
	};

	const transitionTimestamp = (): number => {
		const value = now();
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new Error(
				'Navigation transition clock returned an invalid timestamp.',
			);
		}
		return value;
	};

	const failPendingTransition = (
		pending: PendingTransition,
		error: unknown,
	): void => {
		if (!pendingTransitions.has(pending.transitionId)) return;
		const at = transitionTimestamp();
		appendTransition(pending, 'failed', at, {
			durationMs: Math.max(0, at - pending.requestedAt),
			error: normalizeNavigationText(diagnosticErrorText(error)),
		});
		pendingTransitions.delete(pending.transitionId);
	};

	const prunePendingTransitions = (at: number): void => {
		for (const pending of pendingTransitions.values()) {
			if (at - pending.requestedAt <= 30_000) continue;
			appendTransition(pending, 'failed', at, {
				durationMs: Math.max(0, at - pending.requestedAt),
				error: 'Timed out waiting for the requested route to focus.',
			});
			pendingTransitions.delete(pending.transitionId);
		}
	};

	const makeRoomForPendingTransition = (at: number): void => {
		prunePendingTransitions(at);
		while (pendingTransitions.size >= maxEvents) {
			const oldest = pendingTransitions.values().next().value as
				| PendingTransition
				| undefined;
			if (!oldest) break;
			appendTransition(oldest, 'failed', at, {
				durationMs: Math.max(0, at - oldest.requestedAt),
				error: 'Superseded because the pending transition limit was reached.',
			});
			pendingTransitions.delete(oldest.transitionId);
		}
	};

	const commitPendingTransition = (
		pending: PendingTransition,
		at: number,
	): void => {
		if (pending.committedAt !== undefined) return;
		pending.committedAt = at;
		appendTransition(pending, 'committed', at, {
			durationMs: Math.max(0, at - pending.requestedAt),
		});
	};

	const beginTransition = (
		routeValue: string,
		contextValue?: NavigationTransitionContext,
	): string => {
		const route = normalizeNavigationText(routeValue);
		if (!route) throw new Error('Navigation transition route is required.');
		const context = normalizeNavigationTransitionContext(contextValue);
		const at = transitionTimestamp();
		makeRoomForPendingTransition(at);
		const transitionId = `navigation-transition-${nextTransitionId++}`;
		const pending: PendingTransition = {
			transitionId,
			route,
			requestedAt: at,
			source: context.source ?? 'app',
			...(context.correlationId
				? { correlationId: context.correlationId }
				: {}),
		};
		pendingTransitions.set(transitionId, pending);
		appendTransition(pending, 'requested', at);
		return transitionId;
	};

	const failTransition = (transitionIdValue: string, error: unknown): void => {
		const transitionId = normalizeNavigationText(transitionIdValue);
		const pending = pendingTransitions.get(transitionId);
		if (!pending) {
			throw new Error('Navigation transition is no longer pending.');
		}
		failPendingTransition(pending, error);
	};

	const navigate = async (
		route: string,
		context?: NavigationTransitionContext,
	): Promise<void> => {
		if (!options.onNavigate) {
			throw new Error('Navigation is not configured by this host.');
		}
		const normalizedContext = normalizeNavigationTransitionContext(context);
		const transitionId = beginTransition(route, {
			...(normalizedContext.correlationId
				? { correlationId: normalizedContext.correlationId }
				: {}),
			source: normalizedContext.source ?? 'panel',
		});
		try {
			await options.onNavigate(normalizeNavigationText(route));
		} catch (error) {
			failTransition(transitionId, error);
			throw error;
		}
	};

	const clearNavigationDiagnostics = (): void => {
		historyStore.clear();
		transitionStore.clear();
		pendingTransitions.clear();
	};

	function ScreensPanel({ onBack, actions }: DevToolsPanelProps) {
		const events = useSyncExternalStore(
			historyStore.subscribe,
			historyStore.getSnapshot,
			historyStore.getServerSnapshot,
		);
		const transitions = useSyncExternalStore(
			transitionStore.subscribe,
			transitionStore.getSnapshot,
			transitionStore.getServerSnapshot,
		);
		const routes = useSyncExternalStore(
			routesStore.subscribe,
			routesStore.getSnapshot,
			routesStore.getServerSnapshot,
		);
		const stack = useSyncExternalStore(
			stackStore.subscribe,
			stackStore.getSnapshot,
			stackStore.getServerSnapshot,
		);
		const session = useSyncExternalStore(
			screensSessionStore.subscribe,
			screensSessionStore.getSnapshot,
			screensSessionStore.getServerSnapshot,
		);
		const [search, setSearch] = useState('');
		const [historyExpanded, setHistoryExpanded] = useState(false);
		const [expandedParamsKey, setExpandedParamsKey] = useState<string | null>(
			null,
		);
		const [paramDrafts, setParamDrafts] = useState<
			Readonly<Record<string, string>>
		>({});
		const [deepLink, setDeepLink] = useState('');
		const deepLinkField = useRef<TextFieldRef>(null);

		const { onNavigate, onOpenDeepLink } = options;
		const deepLinkPlaceholder = `${options.deepLinkScheme ?? 'myapp'}://…`;
		const needle = search.trim().toLowerCase();
		const current = events.at(-1);
		const mountedCount = stack.length;
		const visibleCount = stack.filter((entry) => entry.visible).length;
		const backAction = options.actions?.find(
			(action) => action.id === 'back' || action.title === 'Go back',
		);
		const currentSummary = `${
			current?.segments?.length
				? `${current.segments.map(stripGroupParens).join(' › ')} — `
				: ''
		}${mountedCount} mounted, ${visibleCount} visible`;
		const recentTransitions = [...transitions].reverse().slice(0, 20);
		const transitionDetail = (
			transition: NavigationTransitionEvent,
		): string => {
			const duration =
				transition.durationMs === undefined
					? ''
					: ` · ${transition.durationMs} ms`;
			const correlation = transition.correlationId
				? ` · ${transition.correlationId}`
				: '';
			return `${transition.source}${duration}${correlation}`;
		};

		// The sitemap can expose the same path twice (e.g. a group root and its
		// index route); one jump row per path is enough.
		const seenJumpablePaths = new Set<string>();
		const jumpableRoutes = routes.filter((route) => {
			if (route.kind === 'layout' || route.kind === 'internal') return false;
			if (seenJumpablePaths.has(route.path)) return false;
			seenJumpablePaths.add(route.path);
			return true;
		});
		const visibleJumpable = jumpableRoutes.filter((route) =>
			routeMatches(route.path, needle),
		);
		const visibleInternal = routes.filter(
			(route) =>
				(route.kind === 'layout' || route.kind === 'internal') &&
				routeMatches(route.path, needle),
		);
		const groups: { label: string; routes: NavigationRouteDescriptor[] }[] = [];
		for (const route of visibleJumpable) {
			const label = routeGroupLabel(route.path);
			const group = groups.find((candidate) => candidate.label === label);
			if (group) group.routes.push(route);
			else groups.push({ label, routes: [route] });
		}

		const visiblePinned = session.pinnedPaths.filter((path) =>
			routeMatches(path, needle),
		);
		const recents: NavigationEvent[] = [];
		for (let index = events.length - 1; index >= 0; index -= 1) {
			const event = events[index];
			if (!event || event.route === current?.route) continue;
			if (recents.some((existing) => existing.route === event.route)) continue;
			recents.push(event);
			if (recents.length === 5) break;
		}
		const visibleRecents = recents.filter((event) =>
			routeMatches(event.route, needle),
		);

		const draftFor = (path: string, param: string): string => {
			const key = `${path}:${param}`;
			return paramDrafts[key] ?? session.lastParamValues[key] ?? '';
		};
		const runNavigation = (path: string) => {
			if (!onNavigate) return;
			void actions.run({
				pluginId: id,
				label: `Open ${navigationRouteDisplayName(path)}`,
				action: () => navigate(path, { source: 'panel' }),
			});
		};

		const navigateWithParams = (path: string) => {
			const values: Record<string, string> = {};
			for (const param of routeParamNames(path)) {
				const value = draftFor(path, param).trim();
				if (!value) return;
				values[param] = value;
			}
			rememberParamValues(
				screensSessionStore,
				Object.fromEntries(
					Object.entries(values).map(([param, value]) => [
						`${path}:${param}`,
						value,
					]),
				),
			);
			setExpandedParamsKey(null);
			runNavigation(buildNavigationRoutePath(path, values));
		};

		const handleRouteTap = (path: string, expandKey: string) => {
			if (!onNavigate) return;
			if (routeParamNames(path).length > 0) {
				setExpandedParamsKey((key) => {
					if (key === expandKey) {
						// Collapsing discards unsubmitted drafts so an invisible value
						// can never drive the next Go.
						setParamDrafts((drafts) => {
							const next = { ...drafts };
							for (const draftKey of Object.keys(next)) {
								if (draftKey.startsWith(`${path}:`)) delete next[draftKey];
							}
							return next;
						});
						return null;
					}
					return expandKey;
				});
				return;
			}
			runNavigation(path);
		};

		const openDeepLink = () => {
			const url = deepLink.trim();
			if (!url || !onOpenDeepLink) return;
			void actions.run({
				pluginId: id,
				label: 'Open deep link',
				action: async () => {
					const transitionId = beginTransition(url, { source: 'deep-link' });
					try {
						await onOpenDeepLink(url);
						const pending = pendingTransitions.get(transitionId);
						if (pending) {
							commitPendingTransition(pending, transitionTimestamp());
							pendingTransitions.delete(transitionId);
						}
					} catch (error) {
						failTransition(transitionId, error);
						throw error;
					}
				},
			});
		};
		const clearHistory = () => {
			void actions.run({
				pluginId: id,
				label: 'Clear navigation history',
				confirmation: {
					title: 'Clear navigation history?',
					confirmLabel: 'Clear',
					destructive: true,
				},
				action: clearNavigationDiagnostics,
			});
		};

		const renderParamEditorRow = (path: string) => {
			const params = routeParamNames(path);
			const canGo = params.every(
				(param) => draftFor(path, param).trim().length > 0,
			);
			const fields = params.map((param) => {
				const key = `${path}:${param}`;
				const remembered = session.lastParamValues[key];
				return (
					<TextField
						key={key}
						modifiers={[
							autocorrectionDisabled(true),
							textInputAutocapitalization('never'),
						]}
						onTextChange={(text) =>
							setParamDrafts((drafts) => ({ ...drafts, [key]: text }))
						}
						placeholder={
							remembered
								? `${param} — last: ${truncateMiddleValue(remembered)}`
								: param
						}
					/>
				);
			});
			const goButton = (
				<Button
					label="Go"
					modifiers={[
						buttonStyle('borderedProminent'),
						controlSize('small'),
						disabled(!canGo),
					]}
					onPress={() => navigateWithParams(path)}
				/>
			);
			return params.length === 1 ? (
				<HStack spacing={8}>
					{fields}
					{goButton}
				</HStack>
			) : (
				<VStack alignment="leading" spacing={8}>
					{fields}
					{goButton}
				</VStack>
			);
		};

		const renderRouteRow = (
			path: string,
			expandKey: string,
			rowOptions?: { star?: boolean; subtitle?: string },
		) => {
			const pinned = session.pinnedPaths.includes(path);
			const expanded =
				expandedParamsKey === expandKey &&
				onNavigate !== undefined &&
				routeParamNames(path).length > 0;
			const content = (
				<HStack spacing={12}>
					{rowOptions?.star ? (
						<Image
							color={PlatformColor('systemOrangeColor')}
							size={14}
							systemName="star.fill"
						/>
					) : null}
					<VStack alignment="leading" spacing={2}>
						<UIText>{navigationRouteDisplayName(path)}</UIText>
						<UIText modifiers={monoPathText()}>
							{rowOptions?.subtitle ?? path}
						</UIText>
					</VStack>
					<Spacer />
					{onNavigate ? (
						<Image
							color={PlatformColor('tertiaryLabelColor')}
							size={12}
							systemName="chevron.right"
						/>
					) : null}
				</HStack>
			);
			return (
				<Fragment key={expandKey}>
					<SwipeActions>
						{onNavigate ? (
							<Button
								modifiers={[buttonStyle('plain')]}
								onPress={() => handleRouteTap(path, expandKey)}
							>
								{content}
							</Button>
						) : (
							content
						)}
						<SwipeActions.Actions edge="trailing">
							<Button
								label={pinned ? 'Unpin' : 'Pin'}
								onPress={() => setRoutePinned(path, !pinned, id)}
							/>
						</SwipeActions.Actions>
					</SwipeActions>
					{expanded ? renderParamEditorRow(path) : null}
				</Fragment>
			);
		};

		const renderAndroidRouteRow = (path: string, expandKey: string) => {
			const params = routeParamNames(path);
			const expanded =
				expandedParamsKey === expandKey &&
				onNavigate !== undefined &&
				params.length > 0;
			const canGo = params.every(
				(param) => draftFor(path, param).trim().length > 0,
			);
			const pinned = session.pinnedPaths.includes(path);

			return (
				<Fragment key={expandKey}>
					<AndroidPanelRow
						label={navigationRouteDisplayName(path)}
						detail={path}
						onPress={
							onNavigate ? () => handleRouteTap(path, expandKey) : undefined
						}
					/>
					<AndroidPanelRow
						detail={path}
						label={pinned ? 'Unpin screen' : 'Pin screen'}
						onPress={() => setRoutePinned(path, !pinned, id)}
					/>
					{expanded ? (
						<View style={{ gap: 8, padding: 12 }}>
							{params.map((param) => {
								const key = `${path}:${param}`;
								return (
									<AndroidPanelSearch
										key={key}
										onChangeText={(text) =>
											setParamDrafts((drafts) => ({
												...drafts,
												[key]: text,
											}))
										}
										placeholder={param}
										value={draftFor(path, param)}
									/>
								);
							})}
							<AndroidPanelRow
								label="Go"
								onPress={canGo ? () => navigateWithParams(path) : undefined}
							/>
						</View>
					) : null}
				</Fragment>
			);
		};

		return (
			<PanelShell
				onBack={onBack}
				title={title}
				trailing={
					onOpenDeepLink ? (
						<NavIconButton
							accessibilityLabel="Focus deep link field"
							onPress={() => {
								void deepLinkField.current?.focus();
							}}
							systemImage="link"
							testID="devtools-navigation-deeplink"
						/>
					) : undefined
				}
			>
				{Platform.OS === 'ios' ? (
					<Host style={{ flex: 1 }}>
						<List modifiers={[listStyle('insetGrouped')]}>
							<Section>
								<TextField
									modifiers={[
										autocorrectionDisabled(true),
										textInputAutocapitalization('never'),
									]}
									onTextChange={setSearch}
									placeholder="Jump to any screen…"
								/>
							</Section>
							<Section title="Current">
								<HStack spacing={12}>
									<Image
										color={PlatformColor(
											current ? 'systemGreenColor' : 'systemGrayColor',
										)}
										size={10}
										systemName="circle.fill"
									/>
									<VStack alignment="leading" spacing={2}>
										<UIText
											modifiers={[
												font({ textStyle: 'body', weight: 'semibold' }),
											]}
										>
											{current
												? navigationRouteDisplayName(current.route)
												: 'No route recorded'}
										</UIText>
										<UIText modifiers={monoPathText()}>
											{current?.route ?? '—'}
										</UIText>
									</VStack>
									<Spacer />
									{backAction ? (
										<Button
											label="Back"
											modifiers={[
												buttonStyle('bordered'),
												controlSize('small'),
												fixedSize(),
											]}
											onPress={() =>
												void actions.run({
													pluginId: id,
													label: backAction.title,
													action: backAction.run,
												})
											}
										/>
									) : null}
								</HStack>
								<UIText modifiers={secondaryText()}>{currentSummary}</UIText>
								<DisclosureGroup label={`Stack · ${stack.length}`}>
									{stack.map((entry) => (
										<LabeledContent
											key={entry.key}
											label={entry.visible ? 'Visible' : 'Mounted'}
										>
											<UIText modifiers={monoPathText()}>
												{entry.path ?? entry.name}
											</UIText>
										</LabeledContent>
									))}
									{stack.length === 0 ? (
										<UIText modifiers={secondaryText()}>
											No stack entries
										</UIText>
									) : null}
								</DisclosureGroup>
							</Section>
							<Section
								footer={<UIText>Swipe any screen to pin it here.</UIText>}
								title="Pinned"
							>
								{visiblePinned.length === 0 ? (
									<UIText modifiers={secondaryText()}>
										{needle
											? 'No pinned screens match.'
											: 'Nothing pinned yet.'}
									</UIText>
								) : (
									visiblePinned.map((path) =>
										renderRouteRow(path, `pinned:${path}`, { star: true }),
									)
								)}
							</Section>
							<Section
								header={
									<SectionHeaderWithInfo
										title={`All screens · ${visibleJumpable.length}`}
									/>
								}
							>
								{groups.map((group) => (
									<Fragment key={group.label}>
										<UIText modifiers={groupLabelText()}>{group.label}</UIText>
										{group.routes.map((route) =>
											renderRouteRow(route.path, `all:${route.id}`),
										)}
									</Fragment>
								))}
								{visibleJumpable.length === 0 ? (
									<UIText modifiers={secondaryText()}>
										{routes.length === 0
											? 'No screens registered yet.'
											: 'No screens match.'}
									</UIText>
								) : null}
								{visibleInternal.length > 0 ? (
									<DisclosureGroup
										label={`Internal & layouts · ${visibleInternal.length}`}
									>
										{visibleInternal.map((route) => (
											<UIText key={route.id} modifiers={monoPathText()}>
												{route.path}
											</UIText>
										))}
									</DisclosureGroup>
								) : null}
							</Section>
							{visibleRecents.length > 0 ? (
								<Section title="Recent">
									{visibleRecents.map((event) =>
										renderRouteRow(event.route, `recent:${event.id}`, {
											subtitle: `${event.route} · ${formatRelativeTime(event.at)}`,
										}),
									)}
								</Section>
							) : null}
							{onOpenDeepLink ? (
								<Section header={<SectionHeaderWithInfo title="Deep link" />}>
									<HStack spacing={8}>
										<TextField
											modifiers={[
												keyboardType('url'),
												autocorrectionDisabled(true),
												textInputAutocapitalization('never'),
												onSubmit(openDeepLink),
											]}
											onTextChange={setDeepLink}
											placeholder={deepLinkPlaceholder}
											ref={deepLinkField}
										/>
										<Button
											label="Open"
											modifiers={[
												buttonStyle('borderedProminent'),
												controlSize('small'),
												disabled(deepLink.trim().length === 0),
											]}
											onPress={openDeepLink}
										/>
									</HStack>
								</Section>
							) : null}
							<Section title={`Transitions · ${transitions.length}`}>
								{recentTransitions.length === 0 ? (
									<UIText modifiers={secondaryText()}>
										No navigation transitions
									</UIText>
								) : (
									recentTransitions.map((transition) => (
										<VStack alignment="leading" key={transition.id} spacing={2}>
											<UIText>{`${transition.phase} · ${transition.route}`}</UIText>
											<UIText modifiers={secondaryText()}>
												{`${transitionDetail(transition)} · ${formatRelativeTime(transition.at)}`}
											</UIText>
											{transition.error ? (
												<UIText modifiers={secondaryText()}>
													{transition.error}
												</UIText>
											) : null}
										</VStack>
									))
								)}
							</Section>
							<Section>
								<DisclosureGroup
									isExpanded={historyExpanded}
									label={`History · ${events.length}`}
									onIsExpandedChange={setHistoryExpanded}
								>
									{historyExpanded
										? [...events].reverse().map((event) => (
												<LabeledContent key={event.id} label={event.route}>
													<UIText>{formatRelativeTime(event.at)}</UIText>
												</LabeledContent>
											))
										: null}
									{events.length === 0 ? (
										<UIText modifiers={secondaryText()}>
											No route history
										</UIText>
									) : (
										// biome-ignore lint/a11y/useValidAriaRole: SwiftUI ButtonRole, not ARIA
										<Button
											label="Clear history"
											onPress={clearHistory}
											role="destructive"
										/>
									)}
								</DisclosureGroup>
							</Section>
						</List>
					</Host>
				) : (
					<AndroidPanelScroll>
						<AndroidPanelSearch
							onChangeText={setSearch}
							placeholder="Jump to any screen…"
							value={search}
						/>
						<AndroidPanelSection title="Current">
							<AndroidPanelRow
								label={
									current
										? navigationRouteDisplayName(current.route)
										: 'No route recorded'
								}
								detail={current?.route ?? '—'}
								tone={current ? 'success' : 'default'}
								value={`${mountedCount} mounted · ${visibleCount} visible`}
							/>
							{backAction ? (
								<AndroidPanelRow
									label="Go back"
									onPress={() =>
										void actions.run({
											pluginId: id,
											label: backAction.title,
											action: backAction.run,
										})
									}
								/>
							) : null}
						</AndroidPanelSection>
						<AndroidPanelSection title={`Stack · ${stack.length}`}>
							{stack.length === 0 ? (
								<AndroidPanelRow label="No stack entries" />
							) : (
								stack.map((entry) => (
									<AndroidPanelRow
										key={entry.key}
										label={entry.path ?? entry.name}
										tone={entry.visible ? 'success' : 'default'}
										value={entry.visible ? 'Visible' : 'Mounted'}
									/>
								))
							)}
						</AndroidPanelSection>
						<AndroidPanelSection title="Pinned">
							{visiblePinned.length === 0 ? (
								<AndroidPanelRow
									label={
										needle ? 'No pinned screens match' : 'Nothing pinned yet'
									}
								/>
							) : (
								visiblePinned.map((path) =>
									renderAndroidRouteRow(path, `pinned:${path}`),
								)
							)}
						</AndroidPanelSection>
						{groups.map((group) => (
							<AndroidPanelSection key={group.label} title={group.label}>
								{group.routes.map((route) =>
									renderAndroidRouteRow(route.path, `all:${route.id}`),
								)}
							</AndroidPanelSection>
						))}
						{visibleRecents.length > 0 ? (
							<AndroidPanelSection title="Recent">
								{visibleRecents.map((event) =>
									renderAndroidRouteRow(event.route, `recent:${event.id}`),
								)}
							</AndroidPanelSection>
						) : null}
						{visibleInternal.length > 0 ? (
							<AndroidPanelSection title="Internal & layouts">
								{visibleInternal.map((route) => (
									<AndroidPanelRow key={route.id} label={route.path} />
								))}
							</AndroidPanelSection>
						) : null}
						{onOpenDeepLink ? (
							<AndroidPanelSection title="Deep link">
								<AndroidPanelSearch
									onChangeText={setDeepLink}
									placeholder={deepLinkPlaceholder}
									value={deepLink}
								/>
								<AndroidPanelRow
									label="Open deep link"
									onPress={openDeepLink}
								/>
							</AndroidPanelSection>
						) : null}
						<AndroidPanelSection title={`Transitions · ${transitions.length}`}>
							{recentTransitions.length === 0 ? (
								<AndroidPanelRow label="No navigation transitions" />
							) : (
								recentTransitions.map((transition) => (
									<AndroidPanelRow
										detail={transition.error ?? transitionDetail(transition)}
										key={transition.id}
										label={`${transition.phase} · ${navigationRouteDisplayName(transition.route)}`}
										value={formatRelativeTime(transition.at)}
									/>
								))
							)}
						</AndroidPanelSection>
						<AndroidPanelSection title={`History · ${events.length}`}>
							{[...events]
								.reverse()
								.slice(0, 20)
								.map((event) => (
									<AndroidPanelRow
										key={event.id}
										label={navigationRouteDisplayName(event.route)}
										detail={event.route}
										value={formatRelativeTime(event.at)}
									/>
								))}
							{events.length > 0 ? (
								<AndroidPanelRow
									label="Clear history"
									onPress={clearHistory}
									tone="danger"
								/>
							) : null}
						</AndroidPanelSection>
					</AndroidPanelScroll>
				)}
			</PanelShell>
		);
	}

	const onNavigate = options.onNavigate;
	return {
		plugin: {
			id,
			title,
			description:
				options.description ??
				'Jump to any screen, pins, live stack, and route history',
			systemImage:
				options.systemImage ?? 'arrow.triangle.turn.up.right.diamond.fill',
			tint: options.tint ?? '#30B0C7',
			section: options.section,
			Panel: ScreensPanel,
			...(onNavigate
				? {
						pillQuickAction: {
							systemImage: 'location.fill' as const,
							openPanelLabel: title,
							subscribe: (listener) => subscribePinnedRoutes(listener, id),
							// Dynamic routes need their param editor; the menu's
							// "Open …" item covers them.
							options: () =>
								getPinnedRoutes(id)
									.filter((path) => routeParamNames(path).length === 0)
									.map((path) => ({
										id: path,
										label: navigationRouteDisplayName(path),
										systemImage: 'arrow.up.forward' as const,
										action: () => navigate(path, { source: 'panel' }),
									})),
						},
					}
				: {}),
		},
		record: (route, recordOptions) => {
			const normalizedRoute = normalizeNavigationText(route);
			if (!normalizedRoute) return;
			const { segments, metadata } =
				normalizeNavigationRecordOptions(recordOptions);
			const previous = historyStore.getSnapshot().at(-1);
			const duplicate =
				previous?.route === normalizedRoute &&
				JSON.stringify(previous.segments) === JSON.stringify(segments) &&
				serializeValue(previous.metadata).text ===
					serializeValue(metadata).text;
			const at = transitionTimestamp();
			prunePendingTransitions(at);
			let pending = [...pendingTransitions.values()].find(
				(candidate) =>
					candidate.route === normalizedRoute &&
					candidate.committedAt === undefined,
			);
			if (!pending && duplicate) return;
			if (!pending) {
				makeRoomForPendingTransition(at);
				const transitionId = `navigation-transition-${nextTransitionId++}`;
				pending = {
					transitionId,
					route: normalizedRoute,
					requestedAt: at,
					source: 'app',
				};
				pendingTransitions.set(transitionId, pending);
			}
			if (pending.committedAt === undefined) {
				if (pending.requestedAt === at && pending.source === 'app') {
					appendTransition(pending, 'requested', at);
				}
				commitPendingTransition(pending, at);
			}
			if (duplicate) return;
			historyStore.append({
				id: nextId++,
				at,
				route: normalizedRoute,
				segments,
				metadata,
			});
		},
		updateRoutes: (routes) => {
			const retained = normalizeNavigationRoutes(
				routes,
				maxRoutes,
				maxCatalogBytes,
			);
			routesStore.set(retained);

			// An empty inventory means the catalog has not resolved yet, not that
			// every route disappeared. Expo Router's sitemap is null until the root
			// navigator mounts, so pruning here would clear the operator's pins on
			// each launch. Real removals still prune on the next populated update.
			if (retained.length === 0) return;

			const retainedPaths = new Set(retained.map((route) => route.path));
			const session = screensSessionStore.getSnapshot();
			const pinnedPaths = session.pinnedPaths.filter((path) =>
				retainedPaths.has(path),
			);
			if (pinnedPaths.length !== session.pinnedPaths.length) {
				screensSessionStore.set({ ...session, pinnedPaths });
			}
		},
		updateStack: (stack) => {
			const normalized = normalizeNavigationStack(
				stack,
				maxStackEntries,
				maxCatalogBytes,
			);
			stackStore.set(normalized);
			const visiblePaths = new Set(
				normalized
					.filter((entry) => entry.visible && entry.path)
					.map((entry) => entry.path as string),
			);
			if (visiblePaths.size === 0) return;
			const at = transitionTimestamp();
			prunePendingTransitions(at);
			for (const pending of [...pendingTransitions.values()]) {
				if (!visiblePaths.has(pending.route)) continue;
				commitPendingTransition(pending, at);
				appendTransition(pending, 'focused', at, {
					durationMs: Math.max(0, at - pending.requestedAt),
				});
				pendingTransitions.delete(pending.transitionId);
			}
		},
		beginTransition,
		failTransition,
		navigate,
		clear: clearNavigationDiagnostics,
		getEvents: historyStore.getSnapshot,
		getTransitions: transitionStore.getSnapshot,
		getRoutes: routesStore.getSnapshot,
		getStack: stackStore.getSnapshot,
	};
}

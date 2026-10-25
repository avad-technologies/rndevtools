import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from '@testing-library/react-native';
import { Platform } from 'react-native';
import { DevtoolsEventStore } from '../core/event-store';
import type { DevToolsPanelPlugin, DevToolsPanelProps } from '../types';
import {
	buildNavigationRoutePath,
	createNavigationPlugin,
	getPinnedRoutes,
	inferNavigationRouteKind,
	type NavigationTransitionContext,
	navigationRouteDisplayName,
	setRoutePinned,
	subscribePinnedRoutes,
} from './navigation';

jest.mock('@expo/ui/swift-ui', () => {
	const ReactRuntime = jest.requireActual('react');
	const Native = jest.requireActual('react-native');
	const Container = ({ children }: { children?: React.ReactNode }) =>
		ReactRuntime.createElement(Native.View, null, children);
	const SwipeActionsMock = Object.assign(Container, {
		Actions: Container,
	});
	return {
		Host: ({
			children,
			testID,
		}: {
			children?: React.ReactNode;
			testID?: string;
		}) =>
			ReactRuntime.createElement(
				Native.View,
				{
					testID,
				},
				children,
			),
		HStack: Container,
		VStack: Container,
		List: Container,
		Spacer: () => ReactRuntime.createElement(Native.View),
		SwipeActions: SwipeActionsMock,
		Section: ({
			children,
			footer,
			header,
			title,
		}: {
			children?: React.ReactNode;
			footer?: React.ReactNode;
			header?: React.ReactNode;
			title?: string;
		}) =>
			ReactRuntime.createElement(
				Native.View,
				null,
				title ? ReactRuntime.createElement(Native.Text, null, title) : null,
				header ?? null,
				children,
				footer ?? null,
			),
		Button: ({
			children,
			label,
			onPress,
		}: {
			children?: React.ReactNode;
			label?: string;
			onPress?: () => void;
		}) =>
			ReactRuntime.createElement(
				Native.Pressable,
				{
					accessibilityLabel: label,
					onPress,
				},
				children ?? ReactRuntime.createElement(Native.Text, null, label),
			),
		DisclosureGroup: ({
			children,
			isExpanded,
			label,
			onIsExpandedChange,
		}: {
			children?: React.ReactNode;
			isExpanded?: boolean;
			label?: string;
			onIsExpandedChange?: (isExpanded: boolean) => void;
		}) => {
			const [open, setOpen] = ReactRuntime.useState(false);
			const expanded = isExpanded ?? open;
			return ReactRuntime.createElement(
				Native.View,
				null,
				ReactRuntime.createElement(
					Native.Pressable,
					{
						onPress: () => {
							setOpen(!expanded);
							onIsExpandedChange?.(!expanded);
						},
					},
					ReactRuntime.createElement(Native.Text, null, label),
				),
				expanded ? children : null,
			);
		},
		Image: ({ systemName }: { systemName?: string }) =>
			ReactRuntime.createElement(Native.View, {
				testID: `sf-${systemName}`,
			}),
		LabeledContent: ({
			children,
			label,
		}: {
			children?: React.ReactNode;
			label?: string;
		}) =>
			ReactRuntime.createElement(
				Native.View,
				null,
				ReactRuntime.createElement(Native.Text, null, label),
				children,
			),
		Text: ({ children }: { children?: React.ReactNode }) =>
			ReactRuntime.createElement(Native.Text, null, children),
		TextField: ({
			onTextChange,
			placeholder,
		}: {
			onTextChange?: (text: string) => void;
			placeholder?: string;
		}) =>
			ReactRuntime.createElement(Native.TextInput, {
				onChangeText: onTextChange,
				placeholder,
			}),
	};
});
jest.mock('@expo/ui/swift-ui/modifiers', () => ({
	autocorrectionDisabled: (value: unknown) => value,
	buttonStyle: (value: unknown) => value,
	controlSize: (value: unknown) => value,
	disabled: (value: unknown) => value,
	font: (value: unknown) => value,
	foregroundStyle: (value: unknown) => value,
	frame: (value: unknown) => value,
	keyboardType: (value: unknown) => value,
	fixedSize: (value?: unknown) => value,
	lineLimit: (value: unknown) => value,
	listStyle: (value: unknown) => value,
	onSubmit: (value: unknown) => value,
	textInputAutocapitalization: (value: unknown) => value,
	tint: (value: unknown) => value,
}));
const panelProps: DevToolsPanelProps = {
	onBack: jest.fn(),
	onClose: jest.fn(),
	presentationMode: 'window',
	onPresentationModeChange: jest.fn(),
	actions: {
		run: jest.fn(async (request) => {
			await request.action();
			return true;
		}),
	},
};
async function renderPanel(plugin: DevToolsPanelPlugin) {
	const Panel = plugin.Panel;
	return await render(<Panel {...panelProps} />);
}
afterEach(async () => {
	for (const path of [...getPinnedRoutes()]) setRoutePinned(path, false);
	await cleanup();
});
describe('createNavigationPlugin', () => {
	it('tracks requested, committed, and focused route transitions with one correlation', async () => {
		let at = 100;
		const eventStore = new DevtoolsEventStore({
			maxEvents: 20,
			maxBytes: 64 * 1024,
			now: () => at,
		});
		const navigation = createNavigationPlugin({
			eventStore,
			now: () => at,
			onNavigate: jest.fn(),
		});
		await navigation.navigate('/profile', {
			correlationId: 'desktop-action-17',
			source: 'desktop',
		});
		at = 125;
		navigation.record('/profile');
		at = 140;
		navigation.updateStack([
			{
				key: 'profile',
				name: 'profile',
				path: '/profile',
				depth: 0,
				visible: true,
			},
		]);
		expect(navigation.getTransitions()).toEqual([
			expect.objectContaining({
				phase: 'requested',
				route: '/profile',
				source: 'desktop',
				correlationId: 'desktop-action-17',
			}),
			expect.objectContaining({
				phase: 'committed',
				durationMs: 25,
			}),
			expect.objectContaining({
				phase: 'focused',
				durationMs: 40,
			}),
		]);
		expect(eventStore.getSnapshot().events.map((event) => event.kind)).toEqual([
			'transition-requested',
			'transition-committed',
			'transition-focused',
		]);
		expect(
			eventStore.getSnapshot().events.map((event) => event.correlationId),
		).toEqual(['desktop-action-17', 'desktop-action-17', 'desktop-action-17']);
	});
	it('tracks direct app navigation as requested, committed, then focused', () => {
		let at = 200;
		const navigation = createNavigationPlugin({
			now: () => at,
		});
		navigation.record('/home');
		at = 215;
		navigation.updateStack([
			{
				key: 'home',
				name: 'home',
				path: '/home',
				depth: 0,
				visible: true,
			},
		]);
		expect(
			navigation.getTransitions().map((transition) => transition.phase),
		).toEqual(['requested', 'committed', 'focused']);
		expect(navigation.getTransitions().at(-1)?.durationMs).toBe(15);
	});
	it('fails rejected navigation and does not invoke context accessors', async () => {
		const getter = jest.fn(() => 'desktop');
		const context = {} as NavigationTransitionContext;
		Object.defineProperty(context, 'source', {
			enumerable: true,
			get: getter,
		});
		const navigation = createNavigationPlugin({
			onNavigate: jest.fn(async () => {
				throw new Error('router rejected');
			}),
		});
		await expect(navigation.navigate('/blocked', context)).rejects.toThrow(
			'router rejected',
		);
		expect(getter).not.toHaveBeenCalled();
		expect(navigation.getTransitions()).toEqual([
			expect.objectContaining({
				phase: 'requested',
				source: 'panel',
			}),
			expect.objectContaining({
				phase: 'failed',
				error: 'router rejected',
			}),
		]);
	});
	it('rejects stale transition failures and clears all navigation diagnostics', () => {
		const navigation = createNavigationPlugin();
		const transitionId = navigation.beginTransition('/settings');
		navigation.failTransition(transitionId, new Error('cancelled'));
		expect(() => navigation.failTransition(transitionId, 'again')).toThrow(
			'no longer pending',
		);
		navigation.record('/settings');
		navigation.clear();
		expect(navigation.getEvents()).toEqual([]);
		expect(navigation.getTransitions()).toEqual([]);
	});
	it('bounds pending transitions and fails the oldest request', () => {
		const navigation = createNavigationPlugin({
			maxEvents: 2,
		});
		const first = navigation.beginTransition('/first');
		navigation.beginTransition('/second');
		navigation.beginTransition('/third');
		expect(navigation.getTransitions()).toEqual([
			expect.objectContaining({
				phase: 'failed',
				route: '/first',
				error: expect.stringContaining('pending transition limit'),
			}),
			expect.objectContaining({
				phase: 'requested',
				route: '/third',
			}),
		]);
		expect(() => navigation.failTransition(first, 'late failure')).toThrow(
			'no longer pending',
		);
	});
	it('records route changes and deduplicates identical consecutive routes', () => {
		const navigation = createNavigationPlugin();
		navigation.record('/home', {
			segments: ['(tabs)', 'home'],
		});
		navigation.record('/home', {
			segments: ['(tabs)', 'home'],
		});
		navigation.record('/profile');
		expect(navigation.getEvents().map((event) => event.route)).toEqual([
			'/home',
			'/profile',
		]);
	});
	it('stores route inventory and live stack snapshots', () => {
		const navigation = createNavigationPlugin();
		navigation.updateRoutes([
			{
				id: 'item',
				path: '/items/[id]',
				kind: inferNavigationRouteKind('/items/[id]'),
			},
		]);
		navigation.updateStack([
			{
				key: 'home',
				name: 'index',
				depth: 0,
				visible: true,
			},
		]);
		expect(navigation.getRoutes()[0]?.kind).toBe('dynamic');
		expect(navigation.getStack()[0]?.visible).toBe(true);
	});
	it('keeps pinned routes when the route catalog has not resolved yet', () => {
		const pluginId = 'navigation-empty-catalog';
		const navigation = createNavigationPlugin({
			id: pluginId,
		});
		navigation.updateRoutes([
			{
				id: 'home',
				path: '/home',
				kind: inferNavigationRouteKind('/home'),
			},
		]);
		setRoutePinned('/home', true, pluginId);
		expect(getPinnedRoutes(pluginId)).toEqual(['/home']);

		// Expo Router reports a null sitemap until the root navigator mounts, so
		// the host sends an empty inventory on every launch.
		navigation.updateRoutes([]);
		expect(getPinnedRoutes(pluginId)).toEqual(['/home']);

		// A populated inventory that genuinely drops the route still prunes it.
		navigation.updateRoutes([
			{
				id: 'other',
				path: '/other',
				kind: inferNavigationRouteKind('/other'),
			},
		]);
		expect(getPinnedRoutes(pluginId)).toEqual([]);
	});
	it('records metadata changes and identifies grouped layout routes as layouts', () => {
		const navigation = createNavigationPlugin();
		navigation.record('/home', {
			metadata: {
				source: 'tab',
			},
		});
		navigation.record('/home', {
			metadata: {
				source: 'deep-link',
			},
		});
		expect(navigation.getEvents()).toHaveLength(2);
		expect(inferNavigationRouteKind('(tabs)/_layout')).toBe('layout');
	});
	it('detaches and redacts retained route metadata and stack params', () => {
		const navigation = createNavigationPlugin();
		const metadata = {
			email: 'person@example.com',
			nested: {
				count: 1,
			},
		};
		const params = {
			accessToken: 'secret',
			nested: {
				count: 2,
			},
		};
		navigation.record('/profile/person@example.com', {
			metadata,
		});
		navigation.updateStack([
			{
				key: 'profile',
				name: 'profile',
				depth: 0,
				visible: true,
				params,
			},
		]);
		metadata.nested.count = 9;
		params.nested.count = 9;
		expect(navigation.getEvents()[0]).toMatchObject({
			route: '/profile/[REDACTED EMAIL]',
			metadata: {
				email: '[REDACTED]',
				nested: {
					count: 1,
				},
			},
		});
		expect(navigation.getStack()[0]?.params).toMatchObject({
			accessToken: '[REDACTED]',
			nested: {
				count: 2,
			},
		});
	});
	it('bounds route and stack inventories', () => {
		const navigation = createNavigationPlugin({
			maxRoutes: 2,
			maxStackEntries: 1,
		});
		navigation.updateRoutes([
			{
				id: 'c',
				path: '/c',
				kind: 'static',
			},
			{
				id: 'a',
				path: '/a',
				kind: 'static',
			},
			{
				id: 'b',
				path: '/b',
				kind: 'static',
			},
		]);
		navigation.updateStack([
			{
				key: 'a',
				name: 'a',
				depth: 0,
				visible: true,
			},
			{
				key: 'b',
				name: 'b',
				depth: 1,
				visible: false,
			},
		]);
		expect(navigation.getRoutes().map((route) => route.path)).toEqual([
			'/a',
			'/b',
		]);
		expect(navigation.getStack()).toHaveLength(1);
	});
	it('does not invoke accessors while normalizing route diagnostics', () => {
		const getter = jest.fn(() => '/unsafe');
		const route = {
			id: 'unsafe',
			kind: 'static',
		} as Record<string, unknown>;
		Object.defineProperty(route, 'path', {
			enumerable: true,
			get: getter,
		});
		const segmentList: string[] = [];
		Object.defineProperty(segmentList, '0', {
			enumerable: true,
			get: getter,
		});
		segmentList.length = 1;
		const navigation = createNavigationPlugin();
		navigation.updateRoutes([route] as unknown as Parameters<
			typeof navigation.updateRoutes
		>[0]);
		navigation.record('/safe', {
			segments: segmentList,
		});
		expect(getter).not.toHaveBeenCalled();
		expect(navigation.getRoutes()).toEqual([]);
		expect(navigation.getEvents()[0]).toMatchObject({
			route: '/safe',
		});
	});
	it('caps navigation configuration at safe upper bounds', () => {
		expect(() =>
			createNavigationPlugin({
				maxRoutes: 10_001,
			}),
		).toThrow('maxRoutes cannot exceed');
		expect(() =>
			createNavigationPlugin({
				maxEvents: 10_001,
			}),
		).toThrow('maxEvents cannot exceed');
	});
	it('encodes dynamic and catch-all route values', () => {
		expect(
			buildNavigationRoutePath('/users/[id]', {
				id: 'a/b c',
			}),
		).toBe('/users/a%2Fb%20c');
		expect(
			buildNavigationRoutePath('/docs/[...slug]', {
				slug: 'guide/a b',
			}),
		).toBe('/docs/guide/a%20b');
		const getter = jest.fn(() => 'unsafe');
		const values = {} as Record<string, string>;
		Object.defineProperty(values, 'id', {
			enumerable: true,
			get: getter,
		});
		expect(buildNavigationRoutePath('/users/[id]', values)).toBe('/users/[id]');
		expect(getter).not.toHaveBeenCalled();
	});
	it('defaults to the Screens title while keeping the navigation plugin id', () => {
		const navigation = createNavigationPlugin();
		expect(navigation.plugin.title).toBe('Screens');
		expect(navigation.plugin.id).toBe('navigation');
	});
	it('derives human names from the last meaningful path segment', () => {
		expect(navigationRouteDisplayName('/(tabs)/(home)')).toBe('Home');
		expect(navigationRouteDisplayName('/items/session/[sessionId]')).toBe(
			'Session Id',
		);
		expect(navigationRouteDisplayName('/items/item-complete')).toBe(
			'Item Complete',
		);
		expect(navigationRouteDisplayName('/')).toBe('Root');
	});
});
describe('Screens panel', () => {
	it('collects dynamic route parameters before navigating on Android', async () => {
		const originalPlatform = Platform.OS;
		Object.defineProperty(Platform, 'OS', {
			configurable: true,
			value: 'android',
		});
		try {
			const onNavigate = jest.fn();
			const navigation = createNavigationPlugin({
				onNavigate,
			});
			navigation.record('/projects');
			navigation.updateRoutes([
				{
					id: 'task',
					path: '/projects/task/[taskId]',
					kind: 'dynamic',
				},
			]);
			navigation.updateStack([
				{
					key: 'projects',
					name: 'projects',
					depth: 0,
					visible: true,
				},
			]);
			await renderPanel(navigation.plugin);
			expect(screen.getByText('Stack · 1')).toBeOnTheScreen();
			await fireEvent.press(screen.getByText('Pin screen'));
			expect(getPinnedRoutes()).toContain('/projects/task/[taskId]');
			const taskRoute = screen.getAllByText('Task Id')[0];
			if (!taskRoute) throw new Error('Expected an Android route row.');
			await fireEvent.press(taskRoute);
			await fireEvent.changeText(
				screen.getByPlaceholderText('taskId'),
				'tsk_81',
			);
			await fireEvent.press(screen.getByText('Go'));
			expect(onNavigate).toHaveBeenCalledWith('/projects/task/tsk_81');
			await fireEvent.press(screen.getByText('Clear history'));
			expect(navigation.getEvents()).toEqual([]);
			expect(panelProps.actions.run).toHaveBeenCalledWith(
				expect.objectContaining({
					label: 'Clear navigation history',
					confirmation: expect.objectContaining({
						destructive: true,
					}),
				}),
			);
		} finally {
			Object.defineProperty(Platform, 'OS', {
				configurable: true,
				value: originalPlatform,
			});
		}
	});
	it('renders the current route, stack summary, and back host action', async () => {
		const backRun = jest.fn();
		const navigation = createNavigationPlugin({
			actions: [
				{
					id: 'back',
					title: 'Go back',
					run: backRun,
				},
			],
			onNavigate: jest.fn(),
		});
		navigation.record('/(tabs)/(home)', {
			segments: ['(tabs)', '(home)'],
		});
		navigation.updateStack([
			{
				key: 'tabs',
				name: '(tabs)',
				depth: 0,
				visible: true,
			},
			{
				key: 'home',
				name: '(home)',
				path: '/(tabs)/(home)',
				depth: 1,
				visible: false,
			},
		]);
		await renderPanel(navigation.plugin);
		expect(screen.getByText('Screens')).toBeOnTheScreen();
		expect(screen.getByText('Home')).toBeOnTheScreen();
		expect(screen.getByText('/(tabs)/(home)')).toBeOnTheScreen();
		expect(
			screen.getByText('tabs › home — 2 mounted, 1 visible'),
		).toBeOnTheScreen();
		await fireEvent.press(screen.getByLabelText('Back'));
		await Promise.resolve();
		expect(panelProps.actions.run).toHaveBeenCalledWith(
			expect.objectContaining({
				pluginId: 'navigation',
				label: 'Go back',
			}),
		);
		expect(backRun).toHaveBeenCalledTimes(1);
		expect(screen.queryByText('Visible')).not.toBeOnTheScreen();
		await fireEvent.press(screen.getByText(/Stack · \d+/));
		expect(screen.getByText('Visible')).toBeOnTheScreen();
		expect(screen.getByText('Mounted')).toBeOnTheScreen();
	});
	it('jumps to routes, expands dynamic params, and remembers the last value', async () => {
		const onNavigate = jest.fn();
		const makePlugin = () => {
			const navigation = createNavigationPlugin({
				onNavigate,
			});
			navigation.updateRoutes([
				{
					id: 'items',
					path: '/(tabs)/(items)',
					kind: 'group',
				},
				{
					id: 'task',
					path: '/projects/task/[taskId]',
					kind: 'dynamic',
				},
				{
					id: 'layout',
					path: '/(tabs)/_layout',
					kind: 'layout',
				},
			]);
			return navigation;
		};
		const first = await renderPanel(makePlugin().plugin);
		expect(screen.getByText('TABS')).toBeOnTheScreen();
		expect(screen.getByText('All screens · 2')).toBeOnTheScreen();
		await fireEvent.press(screen.getByText('Items'));
		expect(onNavigate).toHaveBeenCalledWith('/(tabs)/(items)');
		await fireEvent.press(screen.getByText('Task Id'));
		await fireEvent.changeText(
			screen.getByPlaceholderText(/^taskId(?: — last: tsk_81)?$/),
			'tsk_81',
		);
		await fireEvent.press(screen.getByLabelText('Go'));
		expect(onNavigate).toHaveBeenCalledWith('/projects/task/tsk_81');
		expect(screen.queryByText('/(tabs)/_layout')).not.toBeOnTheScreen();
		await fireEvent.press(screen.getByText('Internal & layouts · 1'));
		expect(screen.getByText('/(tabs)/_layout')).toBeOnTheScreen();
		await first.unmount();
		await renderPanel(makePlugin().plugin);
		await fireEvent.press(screen.getByText('Task Id'));
		expect(
			screen.getByPlaceholderText('taskId — last: tsk_81'),
		).toBeOnTheScreen();
	});
	it('pins and unpins routes through swipe actions and the module store', async () => {
		const pinListener = jest.fn();
		const unsubscribe = subscribePinnedRoutes(pinListener);
		const navigation = createNavigationPlugin({
			onNavigate: jest.fn(),
		});
		navigation.updateRoutes([
			{
				id: 'inbox',
				path: '/(tabs)/(inbox)',
				kind: 'group',
			},
		]);
		await renderPanel(navigation.plugin);
		expect(screen.getByText('Nothing pinned yet.')).toBeOnTheScreen();
		expect(
			screen.getByText('Swipe any screen to pin it here.'),
		).toBeOnTheScreen();
		await fireEvent.press(screen.getByLabelText('Pin'));
		expect(getPinnedRoutes()).toEqual(['/(tabs)/(inbox)']);
		expect(pinListener).toHaveBeenCalled();
		expect(screen.getAllByText('/(tabs)/(inbox)')).toHaveLength(2);
		expect(screen.getByTestId('sf-star.fill')).toBeOnTheScreen();
		const [unpinButton] = screen.getAllByLabelText('Unpin');
		if (!unpinButton) throw new Error('missing Unpin swipe action');
		await fireEvent.press(unpinButton);
		expect(getPinnedRoutes()).toEqual([]);
		expect(screen.getByText('Nothing pinned yet.')).toBeOnTheScreen();
		unsubscribe();
	});
	it('hides jump and deep link affordances when the host handlers are absent', async () => {
		const navigation = createNavigationPlugin();
		navigation.updateRoutes([
			{
				id: 'settings',
				path: '/settings',
				kind: 'static',
			},
		]);
		await renderPanel(navigation.plugin);
		expect(screen.getByText('/settings')).toBeOnTheScreen();
		expect(screen.queryByTestId('sf-chevron.right')).not.toBeOnTheScreen();
		expect(screen.queryByPlaceholderText('myapp://…')).not.toBeOnTheScreen();
		expect(
			screen.queryByTestId('devtools-navigation-deeplink'),
		).not.toBeOnTheScreen();
	});
	it('opens deep links and filters route rows by search', async () => {
		const onOpenDeepLink = jest.fn();
		const navigation = createNavigationPlugin({
			onNavigate: jest.fn(),
			onOpenDeepLink,
		});
		navigation.updateRoutes([
			{
				id: 'items',
				path: '/(tabs)/(items)',
				kind: 'group',
			},
			{
				id: 'onboarding',
				path: '/(onboarding)',
				kind: 'group',
			},
		]);
		await renderPanel(navigation.plugin);
		expect(
			screen.getByTestId('devtools-navigation-deeplink'),
		).toBeOnTheScreen();
		await fireEvent.changeText(
			screen.getByPlaceholderText('myapp://…'),
			'myapp://items',
		);
		await fireEvent.press(screen.getByLabelText('Open'));
		expect(onOpenDeepLink).toHaveBeenCalledWith('myapp://items');
		await waitFor(() =>
			expect(
				navigation.getTransitions().map((transition) => transition.phase),
			).toEqual(['requested', 'committed']),
		);
		expect(screen.getByText('/(onboarding)')).toBeOnTheScreen();
		await fireEvent.changeText(
			screen.getByPlaceholderText('Jump to any screen…'),
			'items',
		);
		expect(screen.queryByText('/(onboarding)')).not.toBeOnTheScreen();
		expect(screen.getByText('/(tabs)/(items)')).toBeOnTheScreen();
		expect(screen.getByText('All screens · 1')).toBeOnTheScreen();
	});
	it('lists recent distinct routes and the full history disclosure', async () => {
		const onNavigate = jest.fn();
		const navigation = createNavigationPlugin({
			onNavigate,
		});
		navigation.record('/subscribe');
		navigation.record('/items/complete');
		navigation.record('/subscribe');
		navigation.record('/home');
		await renderPanel(navigation.plugin);
		expect(screen.getByText('Recent')).toBeOnTheScreen();
		expect(screen.getAllByText(/\/subscribe · /)).toHaveLength(1);
		expect(screen.getByText(/\/items\/complete · /)).toBeOnTheScreen();
		await fireEvent.press(screen.getByText('Subscribe'));
		expect(onNavigate).toHaveBeenCalledWith('/subscribe');
		await fireEvent.press(screen.getByText('History · 4'));
		expect(screen.getAllByText('/subscribe').length).toBeGreaterThanOrEqual(2);
		await fireEvent.press(screen.getByLabelText('Clear history'));
		expect(navigation.getEvents()).toHaveLength(0);
	});
});

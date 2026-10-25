import { fireEvent, render, screen } from '@testing-library/react-native';
import { Platform, Text } from 'react-native';
import type {
	DevToolsPanelPlugin,
	DevToolsPluginWithPillQuickAction,
} from '../types';
import { FloatingLauncher } from './floating-launcher';
import { MiniPill } from './mini-pill';
import { ToolsSheet } from './tools-sheet';

jest.mock('@expo/ui', () => {
	const ReactRuntime = jest.requireActual('react');
	const Native = jest.requireActual('react-native');
	const Container = ({ children }: { children?: React.ReactNode }) =>
		ReactRuntime.createElement(Native.View, null, children);
	const Icon = Object.assign(
		({ testID }: { testID?: string }) =>
			ReactRuntime.createElement(Native.View, { testID }),
		{ select: ({ ios }: { ios: string }) => ios },
	);
	const Picker = Object.assign(
		({ children }: { children?: React.ReactNode }) =>
			ReactRuntime.createElement(Native.View, null, children),
		{ Item: () => null },
	);
	return {
		BottomSheet: ({
			children,
			onDismiss,
		}: {
			children?: React.ReactNode;
			onDismiss: () => void;
		}) =>
			ReactRuntime.createElement(
				Native.View,
				null,
				children,
				ReactRuntime.createElement(
					Native.Pressable,
					{ accessibilityLabel: 'Dismiss native sheet', onPress: onDismiss },
					ReactRuntime.createElement(Native.Text, null, 'Dismiss'),
				),
			),
		Button: Container,
		Host: Container,
		Icon,
		Picker,
		RNHostView: Container,
	};
});

jest.mock('@expo/ui/community/menu', () => {
	const ReactRuntime = jest.requireActual('react');
	const Native = jest.requireActual('react-native');
	return {
		MenuView: ({
			actions,
			children,
			onPressAction,
		}: {
			actions: Array<{ id?: string; title: string }>;
			children?: React.ReactNode;
			onPressAction?: (event: { nativeEvent: { event: string } }) => void;
		}) =>
			ReactRuntime.createElement(
				Native.View,
				null,
				children,
				...actions.map((action) =>
					ReactRuntime.createElement(
						Native.Pressable,
						{
							accessibilityLabel: action.title,
							key: action.id ?? action.title,
							onPress: () =>
								onPressAction?.({
									nativeEvent: { event: action.id ?? action.title },
								}),
						},
						ReactRuntime.createElement(Native.Text, null, action.title),
					),
				),
			),
	};
});

jest.mock('@expo/ui/swift-ui', () => {
	const fail = () => {
		throw new Error('Android rendered a SwiftUI component');
	};
	return {
		BottomSheet: fail,
		Button: fail,
		ContextMenu: Object.assign(fail, { Items: fail, Trigger: fail }),
		Divider: fail,
		Group: fail,
		Host: fail,
		HStack: fail,
		Image: fail,
		LabeledContent: fail,
		List: fail,
		Menu: fail,
		Picker: fail,
		RNHostView: fail,
		Section: fail,
		Spacer: fail,
		Text: fail,
		TextField: fail,
		VStack: fail,
	};
});

jest.mock('@expo/ui/swift-ui/modifiers', () => ({
	accessibilityLabel: (value: unknown) => value,
	autocorrectionDisabled: (value: unknown) => value,
	backgroundOverlay: (value: unknown) => value,
	buttonStyle: (value: unknown) => value,
	clipShape: (value: unknown) => value,
	fixedSize: (value: unknown) => value,
	font: (value: unknown) => value,
	foregroundStyle: (value: unknown) => value,
	frame: (value: unknown) => value,
	glassEffect: (value: unknown) => value,
	listSectionMargins: (value: unknown) => value,
	listSectionSpacing: (value: unknown) => value,
	padding: (value: unknown) => value,
	pickerStyle: (value: unknown) => value,
	presentationDetents: (value: unknown) => value,
	presentationDragIndicator: (value: unknown) => value,
	scrollContentBackground: (value: unknown) => value,
	tag: (value: unknown) => value,
	tint: (value: unknown) => value,
}));

jest.mock('react-native-safe-area-context', () => ({
	useSafeAreaInsets: () => ({ top: 24, right: 0, bottom: 24, left: 0 }),
}));

jest.mock('react-native-worklets', () => ({
	scheduleOnRN: (
		callback: (...args: readonly unknown[]) => void,
		...args: []
	) => callback(...args),
}));

jest.mock('react-native-reanimated', () => {
	const Native = jest.requireActual('react-native');
	return {
		__esModule: true,
		default: { View: Native.View },
		ReduceMotion: { System: 'system' },
		useAnimatedStyle: (factory: () => unknown) => factory(),
		useSharedValue: (value: unknown) => ({ value }),
		withSpring: (value: unknown) => value,
	};
});

jest.mock('react-native-gesture-handler', () => {
	const ReactRuntime = jest.requireActual('react');
	const Native = jest.requireActual('react-native');
	const createPan = () => {
		const gesture = {
			minDistance: () => gesture,
			onBegin: () => gesture,
			onUpdate: () => gesture,
			onEnd: () => gesture,
		};
		return gesture;
	};
	return {
		Gesture: { Pan: createPan },
		GestureDetector: ({ children }: { children?: React.ReactNode }) =>
			ReactRuntime.createElement(ReactRuntime.Fragment, null, children),
		RectButton: Native.Pressable,
		ScrollView: Native.ScrollView,
	};
});

const originalPlatform = Platform.OS;

beforeAll(() => {
	Object.defineProperty(Platform, 'OS', {
		configurable: true,
		value: 'android',
	});
});

afterAll(() => {
	Object.defineProperty(Platform, 'OS', {
		configurable: true,
		value: originalPlatform,
	});
});

const plugin: DevToolsPanelPlugin = {
	id: 'example',
	title: 'Example',
	description: 'Example diagnostics',
	systemImage: 'wrench',
	Panel: ({ presentationMode }) => (
		<Text>{`Panel in ${presentationMode}`}</Text>
	),
};

const actions = { run: jest.fn(async () => true) };

describe('Android presentation boundary', () => {
	it('renders and opens the launcher without mounting SwiftUI', async () => {
		const onOpen = jest.fn();
		await render(<FloatingLauncher label="Open diagnostics" onOpen={onOpen} />);

		await fireEvent.press(screen.getByLabelText('Open diagnostics'));
		expect(onOpen).toHaveBeenCalledTimes(1);
		expect(
			screen.getByTestId('system-icon-wrench.and.screwdriver.fill'),
		).toBeOnTheScreen();
	});

	it('uses the scrollable React Native sheet and community menu on Android', async () => {
		const onPresentationModeChange = jest.fn();
		const onSelectPlugin = jest.fn();
		const onClose = jest.fn();
		await render(
			<ToolsSheet
				actions={actions}
				isPresented
				onBack={jest.fn()}
				onClose={onClose}
				onPresentationModeChange={onPresentationModeChange}
				onQuickActionPinnedChange={jest.fn()}
				onSelectPlugin={onSelectPlugin}
				pinnedPillQuickActionIds={[]}
				plugins={[plugin]}
				safeAreaTop={24}
				title="Developer Tools"
			/>,
		);

		await fireEvent.press(screen.getByLabelText('Window'));
		await fireEvent.press(screen.getByTestId('devtools-tool-row-example'));
		await fireEvent.press(screen.getByTestId('devtools-sheet-close'));

		expect(onPresentationModeChange).toHaveBeenCalledWith('window');
		expect(onSelectPlugin).toHaveBeenCalledWith(plugin);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('uses the community menu for Android pill quick actions', async () => {
		const quickAction = jest.fn();
		const quickActionPlugin: DevToolsPluginWithPillQuickAction = {
			...plugin,
			pillQuickAction: {
				options: [{ id: 'run', label: 'Run action', action: quickAction }],
			},
		};
		await render(
			<MiniPill
				actions={{
					run: jest.fn(async (request) => {
						await request.action();
						return true;
					}),
				}}
				label="Developer Tools"
				onQuickActionPinnedChange={jest.fn()}
				onRestore={jest.fn()}
				quickActionPlugins={[quickActionPlugin]}
			/>,
		);

		await fireEvent.press(screen.getByLabelText('Run action'));
		expect(quickAction).toHaveBeenCalledTimes(1);
	});
});

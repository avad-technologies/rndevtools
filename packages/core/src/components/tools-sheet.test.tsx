import { fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import type { DevToolsPanelPlugin } from '../types';
import { ToolsSheet } from './tools-sheet';

jest.mock('@expo/ui/swift-ui', () => {
	const ReactRuntime = jest.requireActual('react');
	const Native = jest.requireActual('react-native');
	const Container = ({ children }: { children?: React.ReactNode }) =>
		ReactRuntime.createElement(Native.View, null, children);
	return {
		Host: Container,
		Group: Container,
		HStack: Container,
		VStack: Container,
		List: Container,
		Menu: ({
			children,
			label,
		}: {
			children?: React.ReactNode;
			label?: React.ReactNode;
		}) => ReactRuntime.createElement(Native.View, null, label, children),
		RNHostView: Container,
		Spacer: () => null,
		Image: () => ReactRuntime.createElement(Native.View),
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
				label ? ReactRuntime.createElement(Native.Text, null, label) : null,
				children,
			),
		Section: ({
			children,
			title,
			header,
			footer,
		}: {
			children?: React.ReactNode;
			title?: string;
			header?: React.ReactNode;
			footer?: React.ReactNode;
		}) =>
			ReactRuntime.createElement(
				Native.View,
				null,
				title ? ReactRuntime.createElement(Native.Text, null, title) : null,
				header ?? null,
				children,
				footer ?? null,
			),
		BottomSheet: ({
			children,
			onIsPresentedChange,
		}: {
			children?: React.ReactNode;
			onIsPresentedChange: (isPresented: boolean) => void;
		}) =>
			ReactRuntime.createElement(
				Native.View,
				null,
				children,
				ReactRuntime.createElement(
					Native.Pressable,
					{
						accessibilityLabel: 'Dismiss native sheet',
						onPress: () => onIsPresentedChange(false),
					},
					ReactRuntime.createElement(Native.Text, null, 'Dismiss'),
				),
			),
		Button: ({
			children,
			label,
			onPress,
			testID,
		}: {
			children?: React.ReactNode;
			label?: string;
			onPress: () => void;
			testID?: string;
		}) =>
			ReactRuntime.createElement(
				Native.Pressable,
				{ accessibilityLabel: label, onPress, testID },
				children ?? ReactRuntime.createElement(Native.Text, null, label),
			),
		TextField: ({
			onTextChange,
			placeholder,
		}: {
			onTextChange?: (text: string) => void;
			placeholder?: string;
		}) =>
			ReactRuntime.createElement(Native.TextInput, {
				accessibilityLabel: placeholder,
				onChangeText: onTextChange,
				placeholder,
			}),
		Text: ({ children }: { children?: React.ReactNode }) =>
			ReactRuntime.createElement(Native.Text, null, children),
	};
});

jest.mock('@expo/ui/swift-ui/modifiers', () => ({
	autocorrectionDisabled: (value: unknown) => value,
	backgroundOverlay: (value: unknown) => value,
	buttonStyle: (value: unknown) => value,
	clipShape: (value: unknown) => value,
	fixedSize: (value?: unknown) => value,
	font: (value: unknown) => value,
	foregroundStyle: (value: unknown) => value,
	frame: (value: unknown) => value,
	listSectionMargins: (value: unknown) => value,
	listSectionSpacing: (value: unknown) => value,
	padding: (value: unknown) => value,
	presentationBackground: (value: unknown) => value,
	presentationDetents: (value: unknown) => value,
	presentationDragIndicator: (value: unknown) => value,
	scrollContentBackground: (value: unknown) => value,
}));

const plugin: DevToolsPanelPlugin = {
	id: 'example',
	title: 'Example',
	description: 'Example diagnostics',
	systemImage: 'wrench',
	Panel: ({ presentationMode, safeAreaTop }) => (
		<Text>{`Panel in ${presentationMode} · top ${safeAreaTop}`}</Text>
	),
};

const actions = { run: jest.fn(async () => true) };

async function renderSheet(overrides: Record<string, unknown> = {}) {
	const handlers = {
		onSelectPlugin: jest.fn(),
		onPresentationModeChange: jest.fn(),
		onClose: jest.fn(),
		onOpenPlugin: jest.fn(),
	};
	await render(
		<ToolsSheet
			actions={actions}
			isPresented
			onBack={jest.fn()}
			onClose={handlers.onClose}
			onOpenPlugin={handlers.onOpenPlugin}
			onPresentationModeChange={handlers.onPresentationModeChange}
			onQuickActionPinnedChange={jest.fn()}
			onSelectPlugin={handlers.onSelectPlugin}
			pinnedPillQuickActionIds={[]}
			plugins={[plugin]}
			safeAreaTop={59}
			title="Developer Tools"
			{...overrides}
		/>,
	);
	return handlers;
}

describe('ToolsSheet', () => {
	it('selects a tool, switches presentation from the menu, and handles native dismissal', async () => {
		const handlers = await renderSheet();

		await fireEvent.press(screen.getByTestId('devtools-tool-row-example'));
		await fireEvent.press(screen.getByLabelText('Window'));
		await fireEvent.press(screen.getByLabelText('Dismiss native sheet'));
		expect(handlers.onSelectPlugin).toHaveBeenCalledWith(plugin);
		expect(handlers.onPresentationModeChange).toHaveBeenCalledWith('window');
		expect(handlers.onClose).toHaveBeenCalledTimes(1);
	});

	it('closes from the header control', async () => {
		const handlers = await renderSheet();
		await fireEvent.press(screen.getByTestId('devtools-sheet-close'));
		expect(handlers.onClose).toHaveBeenCalledTimes(1);
	});

	it('filters tool rows from the search field', async () => {
		await renderSheet();
		expect(screen.getByTestId('devtools-tool-row-example')).toBeOnTheScreen();
		await fireEvent.changeText(screen.getByLabelText('Search tools'), 'zzz');
		expect(
			screen.queryByTestId('devtools-tool-row-example'),
		).not.toBeOnTheScreen();
	});

	// The native search field unmounts with the home branch, so a query that
	// outlived it would filter the tool list behind an empty search box.
	it('drops the search when a tool opens', async () => {
		const other: DevToolsPanelPlugin = {
			...plugin,
			id: 'other',
			title: 'Other',
		};
		const handlers = await renderSheet({ plugins: [plugin, other] });

		await fireEvent.changeText(
			screen.getByLabelText('Search tools'),
			'example',
		);
		expect(
			screen.queryByTestId('devtools-tool-row-other'),
		).not.toBeOnTheScreen();
		await fireEvent.press(screen.getByTestId('devtools-tool-row-example'));

		expect(handlers.onSelectPlugin).toHaveBeenCalledWith(plugin);
		expect(screen.getByTestId('devtools-tool-row-other')).toBeOnTheScreen();
	});

	it('drops the search when a status row opens its plugin', async () => {
		const other: DevToolsPanelPlugin = {
			...plugin,
			id: 'other',
			title: 'Other',
		};
		const handlers = await renderSheet({
			plugins: [plugin, other],
			homeStatus: [
				{
					id: 'backend',
					label: 'Backend',
					value: 'Remote',
					onPressPluginId: 'example',
				},
			],
		});

		await fireEvent.changeText(
			screen.getByLabelText('Search tools'),
			'example',
		);
		await fireEvent.press(screen.getByText('Backend'));

		expect(handlers.onOpenPlugin).toHaveBeenCalledWith('example');
		expect(screen.getByTestId('devtools-tool-row-other')).toBeOnTheScreen();
	});

	it('renders status rows and opens the linked plugin', async () => {
		const handlers = await renderSheet({
			homeStatus: [
				{
					id: 'backend',
					label: 'Backend',
					value: 'Remote',
					badge: { label: 'PREVIEW', tone: 'info' },
					onPressPluginId: 'example',
				},
			],
		});
		expect(screen.getByText('Backend')).toBeOnTheScreen();
		expect(screen.getByText('PREVIEW')).toBeOnTheScreen();
		await fireEvent.press(screen.getByText('Backend'));
		expect(handlers.onOpenPlugin).toHaveBeenCalledWith('example');
	});

	it('hosts a selected React Native panel in sheet mode', async () => {
		await renderSheet({ selectedPlugin: plugin });
		expect(screen.getByText('Panel in sheet · top 59')).toBeOnTheScreen();
	});
});

import { fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { createLazyCustomPlugin } from '../plugins/custom';
import type { DevToolsPanelPlugin, DevToolsPanelProps } from '../types';
import { PluginPanelRenderer } from './plugin-panel-renderer';

jest.mock('@expo/ui/swift-ui', () => {
	const ReactRuntime = jest.requireActual('react');
	const Native = jest.requireActual('react-native');
	const Container = ({ children }: { children?: React.ReactNode }) =>
		ReactRuntime.createElement(Native.View, null, children);
	return {
		Button: ({ label, onPress }: { label?: string; onPress?: () => void }) =>
			ReactRuntime.createElement(
				Native.Pressable,
				{ accessibilityLabel: label, onPress },
				ReactRuntime.createElement(Native.Text, null, label),
			),
		ContentUnavailableView: ({
			title,
			description,
		}: {
			title?: string;
			description?: string;
		}) =>
			ReactRuntime.createElement(
				Native.View,
				null,
				ReactRuntime.createElement(Native.Text, null, title),
				ReactRuntime.createElement(Native.Text, null, description),
			),
		Host: Container,
		Image: () => ReactRuntime.createElement(Native.View),
		List: Container,
		Section: ({
			children,
			title,
		}: {
			children?: React.ReactNode;
			title?: string;
		}) =>
			ReactRuntime.createElement(
				Native.View,
				null,
				title ? ReactRuntime.createElement(Native.Text, null, title) : null,
				children,
			),
		Text: ({ children }: { children?: React.ReactNode }) =>
			ReactRuntime.createElement(Native.Text, null, children),
	};
});

jest.mock('@expo/ui/swift-ui/modifiers', () => ({
	buttonStyle: (value: unknown) => value,
	controlSize: (value: unknown) => value,
	disabled: (value: unknown) => value,
	frame: (value: unknown) => value,
	foregroundStyle: (value: unknown) => value,
	listStyle: (value: unknown) => value,
	tint: (value: unknown) => value,
}));

jest.mock('react-native-gesture-handler', () => {
	const Native = jest.requireActual('react-native');
	return {
		RectButton: Native.Pressable,
		FlatList: Native.FlatList,
		ScrollView: Native.ScrollView,
	};
});

const panelProps: DevToolsPanelProps = {
	onBack: jest.fn(),
	onClose: jest.fn(),
	presentationMode: 'window',
	onPresentationModeChange: jest.fn(),
	actions: { run: jest.fn(async () => true) },
};

describe('PluginPanelRenderer', () => {
	it('contains a panel crash and reports the plugin identity', async () => {
		const consoleError = jest.spyOn(console, 'error').mockImplementation();
		const onError = jest.fn();
		const plugin: DevToolsPanelPlugin = {
			id: 'broken',
			title: 'Broken tool',
			description: 'Crashes for testing',
			systemImage: 'exclamationmark.triangle',
			Panel: () => {
				throw new Error('panel exploded');
			},
		};

		await render(
			<PluginPanelRenderer
				onError={onError}
				panelProps={panelProps}
				plugin={plugin}
			/>,
		);

		expect(screen.getByText('This tool could not render')).toBeOnTheScreen();
		expect(screen.getByText('panel exploded')).toBeOnTheScreen();
		expect(onError).toHaveBeenCalledWith(expect.any(Error), 'broken');
		await fireEvent.press(screen.getByText('Return to tools'));
		expect(panelProps.onBack).toHaveBeenCalledTimes(1);
		consoleError.mockRestore();
	});

	it('retries a rejected lazy panel with a fresh load', async () => {
		const consoleError = jest.spyOn(console, 'error').mockImplementation();
		let attempts = 0;
		const plugin = createLazyCustomPlugin({
			id: 'retryable',
			title: 'Retryable',
			description: 'Retries failed imports',
			systemImage: 'arrow.clockwise',
			load: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error('temporary load failure');
				return () => <Text>Recovered panel</Text>;
			},
		});

		await render(
			<PluginPanelRenderer panelProps={panelProps} plugin={plugin} />,
		);

		expect(
			await screen.findByText('This tool could not render'),
		).toBeOnTheScreen();
		await fireEvent.press(screen.getByText('Retry'));
		expect(await screen.findByText('Recovered panel')).toBeOnTheScreen();
		expect(attempts).toBe(2);
		consoleError.mockRestore();
	});
});

import { render, screen } from '@testing-library/react-native';
import { createEnvironmentPlugin } from './environment';

jest.mock('@expo/ui/swift-ui', () => {
	const ReactRuntime = jest.requireActual('react');
	const Native = jest.requireActual('react-native');
	const Container = ({ children }: { children?: React.ReactNode }) =>
		ReactRuntime.createElement(Native.View, null, children);
	return {
		Host: Container,
		List: Container,
		Section: ({
			children,
			footer,
			title,
		}: {
			children?: React.ReactNode;
			footer?: React.ReactNode;
			title?: string;
		}) =>
			ReactRuntime.createElement(
				Native.View,
				null,
				title ? ReactRuntime.createElement(Native.Text, null, title) : null,
				children,
				footer ?? null,
			),
		Text: ({ children }: { children?: React.ReactNode }) =>
			ReactRuntime.createElement(Native.Text, null, children),
		Label: ({ title }: { title?: string }) =>
			ReactRuntime.createElement(Native.Text, null, title),
		Image: () => ReactRuntime.createElement(Native.View),
		Button: ({ label, onPress }: { label?: string; onPress?: () => void }) =>
			ReactRuntime.createElement(
				Native.Pressable,
				{ accessibilityLabel: label, onPress },
				ReactRuntime.createElement(Native.Text, null, label),
			),
		DisclosureGroup: ({
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
	};
});

jest.mock('@expo/ui/swift-ui/modifiers', () => ({
	buttonStyle: (value: unknown) => value,
	frame: (value: unknown) => value,
	listStyle: (value: unknown) => value,
	tint: (value: unknown) => value,
}));

describe('EnvironmentPanel', () => {
	it('names both sides of a failing value check', async () => {
		const plugin = createEnvironmentPlugin({
			sections: [{ title: 'Device', values: { PLATFORM: 'android' } }],
			rules: [{ key: 'PLATFORM', section: 'Device', expectedValue: 'ios' }],
		});
		const Panel = plugin.Panel;

		await render(
			<Panel
				actions={{ run: jest.fn(async () => true) }}
				onBack={jest.fn()}
				onClose={jest.fn()}
				onPresentationModeChange={jest.fn()}
				presentationMode="sheet"
			/>,
		);

		expect(screen.getByText('1 of 1 checks failing')).toBeOnTheScreen();
		// A serialized expected value would be truncated away in the collapsed
		// label, so the row stays short and both values live in the expansion.
		expect(screen.getByText('Platform — Unexpected value')).toBeOnTheScreen();
		expect(screen.getByText('Expected')).toBeOnTheScreen();
		expect(screen.getByText('ios')).toBeOnTheScreen();
		expect(screen.getByText('Actual')).toBeOnTheScreen();
		// Once in the failing check's expansion, once in the manifest listing.
		expect(screen.getAllByText('android')).toHaveLength(2);
	});

	it('redacts sensitive environment entries', async () => {
		const plugin = createEnvironmentPlugin({
			sections: [
				{
					title: 'Runtime',
					values: { API_SECRET: 'do-not-render', MODE: 'development' },
				},
			],
		});
		const Panel = plugin.Panel;

		await render(
			<Panel
				actions={{ run: jest.fn(async () => true) }}
				onBack={jest.fn()}
				onClose={jest.fn()}
				onPresentationModeChange={jest.fn()}
				presentationMode="sheet"
			/>,
		);

		expect(screen.getByText('[REDACTED]')).toBeOnTheScreen();
		expect(screen.queryByText('do-not-render')).not.toBeOnTheScreen();
	});
});

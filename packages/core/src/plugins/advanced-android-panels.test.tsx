import { render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import type { DevToolsPanelPlugin, DevToolsPanelProps } from '../types';
import { createComponentInspectorPlugin } from './component-inspector';
import { type ConsoleLogInput, createConsolePlugin } from './console';
import { createPerformancePlugin } from './performance';
import { createRestorePointsPlugin } from './restore-points';
import { createZustandPlugin } from './zustand';

jest.mock('@expo/ui/swift-ui', () => {
	const fail = () => {
		throw new Error('Android rendered a SwiftUI component');
	};
	return {
		Button: fail,
		ContentUnavailableView: fail,
		DisclosureGroup: fail,
		Host: fail,
		Label: fail,
		LabeledContent: fail,
		List: fail,
		Picker: fail,
		Section: fail,
		Text: fail,
		TextField: fail,
	};
});

jest.mock('@expo/ui/swift-ui/modifiers', () => ({
	autocorrectionDisabled: (value: unknown) => value,
	disabled: (value: unknown) => value,
	font: (value: unknown) => value,
	foregroundStyle: (value: unknown) => value,
	lineLimit: (value: unknown) => value,
	listRowBackground: (value: unknown) => value,
	listStyle: (value: unknown) => value,
	pickerStyle: (value: unknown) => value,
	tag: (value: unknown) => value,
}));

jest.mock('../components/nav-controls', () => {
	const ReactRuntime = jest.requireActual('react');
	const Native = jest.requireActual('react-native');
	return {
		NavIconButton: ({
			accessibilityLabel,
			onPress,
		}: {
			accessibilityLabel: string;
			onPress: () => void;
		}) =>
			ReactRuntime.createElement(
				Native.Pressable,
				{ accessibilityLabel, onPress },
				ReactRuntime.createElement(Native.Text, null, accessibilityLabel),
			),
	};
});

jest.mock('../components/system-icon', () => {
	const ReactRuntime = jest.requireActual('react');
	const Native = jest.requireActual('react-native');
	return {
		SystemIcon: () => ReactRuntime.createElement(Native.View),
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

const panelProps: DevToolsPanelProps = {
	actions: { run: jest.fn(async () => true) },
	onBack: jest.fn(),
	onClose: jest.fn(),
	onPresentationModeChange: jest.fn(),
	presentationMode: 'sheet',
};

async function renderPanel(plugin: DevToolsPanelPlugin) {
	const Panel = plugin.Panel;
	return await render(<Panel {...panelProps} />);
}

describe('advanced Android diagnostic panels', () => {
	it('runs the panel suite with the Android renderer selected', () => {
		expect(Platform.OS).toBe('android');
	});

	it('renders logger-backed Console content without SwiftUI', async () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (next) => {
					listener = next;
					return () => {
						listener = undefined;
					};
				},
			},
		});
		const dispose = diagnostics.plugin.install?.();
		listener?.({ level: 'info', message: 'Ready' });

		await renderPanel(diagnostics.plugin);

		expect(screen.getByText('Logs · 1')).toBeOnTheScreen();
		expect(screen.getByText('Ready')).toBeOnTheScreen();
		dispose?.();
	});

	it('keeps Console row ids unique when a log arrives during a store update', async () => {
		let listener: ((event: ConsoleLogInput) => void) | undefined;
		const diagnostics = createConsolePlugin({
			source: {
				subscribe: (next) => {
					listener = next;
					return () => {
						listener = undefined;
					};
				},
			},
		});
		const dispose = diagnostics.plugin.install?.();
		// A host logger that also captures console output. React reports the
		// Console panel's store update during another component's render
		// synchronously, from inside the store's append.
		let forwarded = 0;
		const consoleError = jest
			.spyOn(console, 'error')
			.mockImplementation((message: unknown) => {
				forwarded += 1;
				if (forwarded <= 5)
					listener?.({ level: 'error', message: String(message) });
			});
		function RenderLogger({ message }: { message?: string }) {
			if (message) listener?.({ level: 'info', message });
			return null;
		}
		const Panel = diagnostics.plugin.Panel;

		try {
			const view = await render(
				<>
					<Panel {...panelProps} />
					<RenderLogger />
				</>,
			);
			await view.rerender(
				<>
					<Panel {...panelProps} />
					<RenderLogger message="logged during render" />
				</>,
			);

			const ids = diagnostics.getEvents().map((event) => event.id);
			expect(forwarded).toBeGreaterThan(0);
			expect(ids.length).toBeGreaterThan(1);
			expect(new Set(ids).size).toBe(ids.length);
		} finally {
			consoleError.mockRestore();
			dispose?.();
		}
	});

	it('renders Zustand projections and changes without SwiftUI', async () => {
		let state = { count: 1 };
		const diagnostics = createZustandPlugin({
			stores: [
				{
					id: 'counter',
					title: 'Counter',
					getInspectableState: () => state,
					subscribe: () => () => {},
					validatePatch: (patch) => patch,
					applyPatch: (patch) => {
						state = { ...state, ...(patch as typeof state) };
					},
					reset: () => {
						state = { count: 0 };
					},
					restorable: true,
				},
			],
		});
		const dispose = diagnostics.plugin.install?.();

		await renderPanel(diagnostics.plugin);

		expect(screen.getByText('Stores · 1')).toBeOnTheScreen();
		expect(screen.getByText('Counter')).toBeOnTheScreen();
		expect(screen.getByText('Apply validated patch')).toBeOnTheScreen();
		expect(screen.getByText('Capture state')).toBeOnTheScreen();
		expect(screen.getByText('Reset store')).toBeOnTheScreen();
		dispose?.();
	});

	it('renders restore-point controls without SwiftUI', async () => {
		const diagnostics = createRestorePointsPlugin({ sources: [] });

		await renderPanel(diagnostics.plugin);

		expect(screen.getByText('Capture restore point')).toBeOnTheScreen();
		expect(screen.getByText('No restore points')).toBeOnTheScreen();
	});

	it('renders the performance-review workflow without SwiftUI', async () => {
		const diagnostics = createPerformancePlugin();

		await renderPanel(diagnostics.plugin);

		expect(screen.getByText('Start review')).toBeOnTheScreen();
		expect(screen.getByText('No performance samples')).toBeOnTheScreen();
	});

	it('renders registered component targets without SwiftUI', async () => {
		const diagnostics = createComponentInspectorPlugin({
			source: {
				getSnapshot: () => [
					{
						id: 'card',
						name: 'Example card',
						bounds: { x: 0, y: 0, width: 100, height: 40 },
					},
				],
				highlight: () => {},
				subscribe: () => () => {},
			},
		});
		const dispose = diagnostics.plugin.install?.();

		await renderPanel(diagnostics.plugin);

		expect(screen.getByText('Registered targets')).toBeOnTheScreen();
		expect(screen.getByText('Unscoped · Example card')).toBeOnTheScreen();
		expect(screen.getByText('Highlight target')).toBeOnTheScreen();
		dispose?.();
	});
});

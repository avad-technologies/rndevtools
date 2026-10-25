import { act, render } from '@testing-library/react-native';
import { useState } from 'react';
import type { DevToolsPosition } from '../types';
import { FloatingLauncher } from './floating-launcher';
import { MiniPill } from './mini-pill';

type PanEvent = { translationX: number; translationY: number };

// The latest pan callbacks and animated style, so a test can drag the control
// and then read what the UI thread would render.
const mockGesture: {
	begin?: () => void;
	update?: (event: PanEvent) => void;
	end?: () => void;
} = {};
const mockAnimatedStyle: { current?: () => unknown } = {};

jest.mock('@expo/ui/swift-ui', () => {
	const ReactRuntime = jest.requireActual('react');
	const Native = jest.requireActual('react-native');
	return {
		Host: ({ children }: { children?: React.ReactNode }) =>
			ReactRuntime.createElement(Native.View, null, children),
		Image: () => ReactRuntime.createElement(Native.View),
	};
});

jest.mock('@expo/ui/swift-ui/modifiers', () => ({
	frame: (value: unknown) => value,
	glassEffect: (value: unknown) => value,
	padding: (value: unknown) => value,
}));

jest.mock('react-native-worklets', () => ({
	scheduleOnRN: (
		callback: (...args: readonly unknown[]) => void,
		...args: readonly unknown[]
	) => callback(...args),
}));

jest.mock('react-native-reanimated', () => {
	const ReactRuntime = jest.requireActual('react');
	const Native = jest.requireActual('react-native');
	return {
		__esModule: true,
		default: { View: Native.View },
		ReduceMotion: { System: 'system' },
		useAnimatedStyle: (factory: () => unknown) => {
			mockAnimatedStyle.current = factory;
			return factory();
		},
		// Shared values keep their identity across renders, as on device.
		useSharedValue: (initial: unknown) =>
			ReactRuntime.useRef({ value: initial }).current,
		// A running spring, distinguishable from a plain position write.
		withSpring: (target: number) => ({ springTo: target }),
	};
});

jest.mock('react-native-gesture-handler', () => {
	const ReactRuntime = jest.requireActual('react');
	const Native = jest.requireActual('react-native');
	const createPan = () => {
		const gesture = {
			minDistance: () => gesture,
			onBegin: (callback: () => void) => {
				mockGesture.begin = callback;
				return gesture;
			},
			onUpdate: (callback: (event: PanEvent) => void) => {
				mockGesture.update = callback;
				return gesture;
			},
			onEnd: (callback: () => void) => {
				mockGesture.end = callback;
				return gesture;
			},
		};
		return gesture;
	};
	return {
		Gesture: { Pan: createPan },
		GestureDetector: ({ children }: { children?: React.ReactNode }) =>
			ReactRuntime.createElement(ReactRuntime.Fragment, null, children),
		RectButton: Native.Pressable,
	};
});

function renderedTranslation(): { translateX: unknown; translateY: unknown } {
	const style = mockAnimatedStyle.current?.() as {
		transform: [{ translateX: unknown }, { translateY: unknown }];
	};
	return {
		translateX: style.transform[0].translateX,
		translateY: style.transform[1].translateY,
	};
}

async function dragFarLeft(): Promise<void> {
	await act(async () => {
		mockGesture.begin?.();
		mockGesture.update?.({ translationX: -10_000, translationY: -100 });
		mockGesture.end?.();
	});
}

describe('draggable floating controls', () => {
	it('lets the launcher spring to the edge after the host stores the drop', async () => {
		const committed: DevToolsPosition[] = [];
		function LauncherHost() {
			const [position, setPosition] = useState<DevToolsPosition>();
			return (
				<FloatingLauncher
					initialPosition={position}
					label="Open diagnostics"
					onOpen={jest.fn()}
					onPositionChange={(next) => {
						committed.push(next);
						setPosition(next);
					}}
				/>
			);
		}
		await render(<LauncherHost />);

		await dragFarLeft();

		// The host re-rendered with the dropped position; the launcher must still
		// be springing there rather than jumping to it.
		expect(committed).toEqual([{ x: 10, y: expect.any(Number) }]);
		expect(renderedTranslation()).toEqual({
			translateX: { springTo: 10 },
			translateY: committed[0]?.y,
		});
	});

	it('still moves the launcher to a position the host changes', async () => {
		const view = await render(
			<FloatingLauncher
				initialPosition={{ x: 10, y: 300 }}
				label="Open diagnostics"
				onOpen={jest.fn()}
				onPositionChange={jest.fn()}
			/>,
		);
		await dragFarLeft();

		await view.rerender(
			<FloatingLauncher
				initialPosition={{ x: 200, y: 320 }}
				label="Open diagnostics"
				onOpen={jest.fn()}
				onPositionChange={jest.fn()}
			/>,
		);

		expect(renderedTranslation()).toEqual({ translateX: 200, translateY: 320 });
	});

	it('lets the pill spring to the edge after the host stores the drop', async () => {
		const committed: DevToolsPosition[] = [];
		function PillHost() {
			const [position, setPosition] = useState<DevToolsPosition>();
			return (
				<MiniPill
					actions={{ run: jest.fn(async () => true) }}
					initialPosition={position}
					label="Dev Tools"
					onPositionChange={(next) => {
						committed.push(next);
						setPosition(next);
					}}
					onQuickActionPinnedChange={jest.fn()}
					onRestore={jest.fn()}
				/>
			);
		}
		await render(<PillHost />);

		await dragFarLeft();

		expect(committed).toEqual([{ x: 10, y: expect.any(Number) }]);
		expect(renderedTranslation()).toEqual({
			translateX: { springTo: 10 },
			translateY: committed[0]?.y,
		});
	});
});

import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { createRef } from 'react';
import { Alert } from 'react-native';
import type {
	DevToolsPlugin,
	InternalToolsHandle,
	InternalToolsProps,
} from '../types';
import { InternalTools } from './internal-tools';

jest.mock('./floating-launcher', () => {
	const { Pressable } = jest.requireActual('react-native');
	return {
		FloatingLauncher: ({ onOpen }: { onOpen: () => void }) => (
			<Pressable onPress={onOpen} testID="launcher" />
		),
	};
});

jest.mock('./tools-sheet', () => {
	const { Pressable, Text, View } = jest.requireActual('react-native');
	return {
		ToolsSheet: ({
			selectedPlugin,
			onPresentationModeChange,
			onQuickActionPinnedChange,
		}: {
			selectedPlugin?: DevToolsPlugin;
			onPresentationModeChange: InternalToolsProps['onPresentationModeChange'];
			onQuickActionPinnedChange: (pluginId: string, isPinned: boolean) => void;
		}) => (
			<View testID="sheet">
				<Text>{selectedPlugin?.id ?? 'list'}</Text>
				<Pressable
					onPress={() => onPresentationModeChange?.('window')}
					testID="to-window"
				/>
				{selectedPlugin?.pillQuickAction ? (
					<Pressable
						onPress={() => onQuickActionPinnedChange(selectedPlugin.id, true)}
						testID="pin-quick-action"
					/>
				) : null}
			</View>
		),
	};
});

jest.mock('./floating-window', () => {
	const { Pressable, Text, View } = jest.requireActual('react-native');
	return {
		FloatingWindow: ({
			selectedPlugin,
			onPresentationModeChange,
		}: {
			selectedPlugin?: DevToolsPlugin;
			onPresentationModeChange: InternalToolsProps['onPresentationModeChange'];
		}) => (
			<View testID="window">
				<Text>{selectedPlugin?.id ?? 'list'}</Text>
				<Pressable
					onPress={() => onPresentationModeChange?.('pill')}
					testID="to-pill"
				/>
			</View>
		),
	};
});

jest.mock('./mini-pill', () => {
	const { Pressable, Text, View } = jest.requireActual('react-native');
	return {
		MiniPill: ({
			onRestore,
			quickActionPlugins,
		}: {
			onRestore: () => void;
			quickActionPlugins: readonly DevToolsPlugin[];
		}) => (
			<View testID="pill">
				<Pressable onPress={onRestore} testID="restore-pill" />
				<Text>{quickActionPlugins.map((entry) => entry.id).join(',')}</Text>
			</View>
		),
	};
});

const Panel = () => null;
const plugin: DevToolsPlugin = {
	id: 'example',
	title: 'Example',
	description: 'Example panel',
	systemImage: 'wrench',
	Panel,
};
const quickActionPlugin: DevToolsPlugin = {
	...plugin,
	id: 'state',
	title: 'State',
	pillQuickAction: {
		options: [{ id: 'loading', label: 'Loading', action: () => {} }],
	},
};

describe('InternalTools', () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('opens plugins imperatively and preserves selection across presentations', async () => {
		const ref = createRef<InternalToolsHandle>();
		await render(<InternalTools enabled plugins={[plugin]} ref={ref} />);

		await act(() => ref.current?.openPlugin('example'));
		expect(screen.getByTestId('sheet')).toBeOnTheScreen();
		expect(screen.getByText('example')).toBeOnTheScreen();

		await fireEvent.press(screen.getByTestId('to-window'));
		expect(screen.getByTestId('window')).toBeOnTheScreen();
		expect(screen.getByText('example')).toBeOnTheScreen();

		await fireEvent.press(screen.getByTestId('to-pill'));
		expect(screen.getByTestId('pill')).toBeOnTheScreen();

		await fireEvent.press(screen.getByTestId('restore-pill'));
		expect(screen.getByTestId('window')).toBeOnTheScreen();

		await act(() => ref.current?.close());
		expect(screen.getByTestId('launcher')).toBeOnTheScreen();
	});

	it('persists pinned quick actions and supplies them to the pill', async () => {
		const setItem = jest.fn();
		const storage = { getItem: jest.fn(() => null), setItem };
		const ref = createRef<InternalToolsHandle>();
		await render(
			<InternalTools
				enabled
				persistence={{ storage, key: 'quick-actions' }}
				plugins={[quickActionPlugin]}
				ref={ref}
			/>,
		);
		await act(async () => Promise.resolve());

		await act(() => ref.current?.openPlugin('state'));
		await fireEvent.press(screen.getByTestId('pin-quick-action'));
		await act(() => ref.current?.setPresentationMode('pill'));
		await act(async () => Promise.resolve());

		expect(screen.getByText('state')).toBeOnTheScreen();
		expect(setItem).toHaveBeenLastCalledWith(
			'quick-actions',
			expect.stringContaining('"pinnedPillQuickActionIds":["state"]'),
		);
	});

	it('hydrates and persists runtime presentation state', async () => {
		const setItem = jest.fn();
		const storage = {
			getItem: jest.fn(() =>
				JSON.stringify({
					version: 1,
					presentationMode: 'window',
					restoreMode: 'window',
				}),
			),
			setItem,
		};
		const ref = createRef<InternalToolsHandle>();
		await render(
			<InternalTools
				enabled
				persistence={{ storage, key: 'test-tools' }}
				plugins={[plugin]}
				ref={ref}
			/>,
		);
		await act(async () => Promise.resolve());

		await act(() => ref.current?.open());
		expect(screen.getByTestId('window')).toBeOnTheScreen();
		await act(() => ref.current?.setPresentationMode('pill'));
		await act(async () => Promise.resolve());

		expect(setItem).toHaveBeenLastCalledWith(
			'test-tools',
			expect.stringContaining('"presentationMode":"pill"'),
		);
	});

	it('reports rejected custom actions without crashing the host', async () => {
		const error = new Error('action failed');
		const onError = jest.fn();
		const actionPlugin: DevToolsPlugin = {
			id: 'failing-action',
			title: 'Failing action',
			description: 'Rejects for testing',
			systemImage: 'exclamationmark.triangle',
			kind: 'action',
			onPress: async () => {
				throw error;
			},
		};
		const ref = createRef<InternalToolsHandle>();
		await render(
			<InternalTools
				enabled
				onError={onError}
				plugins={[actionPlugin]}
				ref={ref}
			/>,
		);

		await act(async () => {
			ref.current?.openPlugin('failing-action');
			await Promise.resolve();
		});

		expect(onError).toHaveBeenCalledWith(error, {
			kind: 'action',
			pluginId: 'failing-action',
		});
	});

	it('honors declarative confirmation for custom action plugins', async () => {
		const action = jest.fn();
		const onAuditEvent = jest.fn();
		jest
			.spyOn(Alert, 'alert')
			.mockImplementation((_title, _message, buttons) => {
				buttons?.[0]?.onPress?.();
			});
		const actionPlugin: DevToolsPlugin = {
			id: 'confirmed-action',
			title: 'Confirmed action',
			description: 'Requires confirmation',
			systemImage: 'exclamationmark.triangle',
			kind: 'action',
			confirmation: { title: 'Continue?' },
			onPress: action,
		};
		const ref = createRef<InternalToolsHandle>();
		await render(
			<InternalTools
				enabled
				onAuditEvent={onAuditEvent}
				plugins={[actionPlugin]}
				ref={ref}
			/>,
		);

		await act(async () => {
			ref.current?.openPlugin('confirmed-action');
			await Promise.resolve();
		});

		expect(action).not.toHaveBeenCalled();
		expect(onAuditEvent).toHaveBeenCalledWith(
			expect.objectContaining({ status: 'cancelled' }),
		);
	});

	it('keeps collectors installed while the launcher is hidden', async () => {
		const dispose = jest.fn();
		const install = jest.fn(() => dispose);
		const hiddenPlugin: DevToolsPlugin = { ...plugin, install };
		const view = await render(
			<InternalTools enabled plugins={[hiddenPlugin]} visible={false} />,
		);

		expect(install).toHaveBeenCalledTimes(1);
		expect(screen.queryByTestId('launcher')).toBeNull();
		await view.rerender(
			<InternalTools enabled plugins={[hiddenPlugin]} visible />,
		);
		expect(screen.getByTestId('launcher')).toBeOnTheScreen();
		expect(install).toHaveBeenCalledTimes(1);

		await view.unmount();
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it('does not let late hydration overwrite a user presentation change', async () => {
		let resolveHydration: ((value: string) => void) | undefined;
		const storage = {
			getItem: jest.fn(
				() =>
					new Promise<string>((resolve) => {
						resolveHydration = resolve;
					}),
			),
			setItem: jest.fn(),
		};
		const ref = createRef<InternalToolsHandle>();
		await render(
			<InternalTools
				enabled
				persistence={{ storage }}
				plugins={[plugin]}
				ref={ref}
			/>,
		);

		await act(() => ref.current?.setPresentationMode('window'));
		await act(async () => {
			resolveHydration?.(
				JSON.stringify({
					version: 1,
					presentationMode: 'sheet',
					restoreMode: 'sheet',
				}),
			);
			await Promise.resolve();
		});
		await act(() => ref.current?.open());

		expect(screen.getByTestId('window')).toBeOnTheScreen();
	});

	it('does not write to a replacement storage before hydrating it', async () => {
		const firstStorage = {
			getItem: jest.fn(() => null),
			setItem: jest.fn(),
		};
		let resolveSecondHydration: ((value: string | null) => void) | undefined;
		const secondStorage = {
			getItem: jest.fn(
				() =>
					new Promise<string | null>((resolve) => {
						resolveSecondHydration = resolve;
					}),
			),
			setItem: jest.fn(),
		};
		const view = await render(
			<InternalTools
				enabled
				persistence={{ storage: firstStorage, key: 'same-key' }}
				plugins={[plugin]}
			/>,
		);
		await act(async () => Promise.resolve());

		await view.rerender(
			<InternalTools
				enabled
				persistence={{ storage: secondStorage, key: 'same-key' }}
				plugins={[plugin]}
			/>,
		);
		await act(async () => Promise.resolve());
		expect(secondStorage.setItem).not.toHaveBeenCalled();

		await act(async () => {
			resolveSecondHydration?.(null);
			await Promise.resolve();
		});
		expect(secondStorage.setItem).toHaveBeenCalledTimes(1);
	});

	it('reports synchronous persistence reads without crashing the host', async () => {
		const error = new Error('storage unavailable');
		const onError = jest.fn();
		const storage = {
			getItem: jest.fn(() => {
				throw error;
			}),
			setItem: jest.fn(),
		};

		await render(
			<InternalTools
				enabled
				onError={onError}
				persistence={{ storage }}
				plugins={[plugin]}
			/>,
		);
		await act(async () => Promise.resolve());

		expect(onError).toHaveBeenCalledWith(error, { kind: 'persistence' });
		expect(storage.setItem).not.toHaveBeenCalled();
		expect(screen.getByTestId('launcher')).toBeOnTheScreen();
	});

	it('does not overwrite malformed persisted state with defaults', async () => {
		const onError = jest.fn();
		const storage = {
			getItem: jest.fn(() => '{not valid json'),
			setItem: jest.fn(),
		};

		await render(
			<InternalTools
				enabled
				onError={onError}
				persistence={{ storage }}
				plugins={[plugin]}
			/>,
		);
		await act(async () => Promise.resolve());

		expect(onError).toHaveBeenCalledWith(expect.any(Error), {
			kind: 'persistence',
		});
		expect(storage.setItem).not.toHaveBeenCalled();
	});
});

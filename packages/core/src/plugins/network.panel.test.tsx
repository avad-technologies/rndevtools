import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from '@testing-library/react-native';
import { Share } from 'react-native';
import { createDevToolsActionCoordinator } from '../core/action-policy';
import type {
	DevToolsActionRequest,
	DevToolsActionServices,
	DevToolsPanelProps,
} from '../types';
import {
	createNetworkPlugin as createNetworkPluginBase,
	type NetworkPluginOptions,
} from './network';

function createNetworkPlugin(options: NetworkPluginOptions = {}) {
	return createNetworkPluginBase({
		trustExplicitFetchRequests: true,
		trustExplicitFetchResponses: true,
		trustGlobalFetchRequests: true,
		trustGlobalFetchResponses: true,
		...options,
	});
}

jest.mock('@expo/ui/swift-ui', () => {
	const ReactRuntime = jest.requireActual('react');
	const Native = jest.requireActual('react-native');
	const Container = ({
		children,
		testID,
	}: {
		children?: React.ReactNode;
		testID?: string;
	}) => ReactRuntime.createElement(Native.View, { testID }, children);
	return {
		Host: Container,
		List: Container,
		HStack: Container,
		VStack: Container,
		Spacer: () => ReactRuntime.createElement(Native.View),
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
		Text: ({
			children,
			testID,
		}: {
			children?: React.ReactNode;
			testID?: string;
		}) => ReactRuntime.createElement(Native.Text, { testID }, children),
		Button: ({
			children,
			label,
			onPress,
			testID,
		}: {
			children?: React.ReactNode;
			label?: string;
			onPress?: () => void;
			testID?: string;
		}) =>
			ReactRuntime.createElement(
				Native.Pressable,
				{
					accessibilityLabel: label,
					accessibilityRole: 'button',
					onPress,
					testID,
				},
				children ?? ReactRuntime.createElement(Native.Text, null, label),
			),
		Toggle: ({
			children,
			isOn,
			onIsOnChange,
			testID,
		}: {
			children?: React.ReactNode;
			isOn?: boolean;
			onIsOnChange?: (isOn: boolean) => void;
			testID?: string;
		}) =>
			ReactRuntime.createElement(
				Native.Pressable,
				{
					accessibilityRole: 'switch',
					accessibilityState: { checked: isOn },
					onPress: () => onIsOnChange?.(!isOn),
					testID,
				},
				children,
			),
		Picker: ({
			children,
			onSelectionChange,
		}: {
			children?: React.ReactNode;
			onSelectionChange?: (value: string) => void;
		}) =>
			ReactRuntime.createElement(
				Native.View,
				null,
				ReactRuntime.Children.map(
					children,
					(
						child: React.ReactElement<{
							children?: React.ReactNode;
							modifiers?: readonly string[];
						}>,
					) => {
						const value = child?.props?.modifiers?.[0];
						return ReactRuntime.createElement(
							Native.Pressable,
							{
								accessibilityLabel: `network-filter-${value}`,
								onPress: () => onSelectionChange?.(String(value)),
							},
							ReactRuntime.createElement(
								Native.Text,
								null,
								child?.props?.children,
							),
						);
					},
				),
			),
		TextField: ({
			onTextChange,
			placeholder,
			testID,
		}: {
			onTextChange?: (text: string) => void;
			placeholder?: string;
			testID?: string;
		}) =>
			ReactRuntime.createElement(Native.TextInput, {
				onChangeText: onTextChange,
				placeholder,
				testID,
			}),
		Image: ({ onPress, testID }: { onPress?: () => void; testID?: string }) =>
			onPress
				? ReactRuntime.createElement(Native.Pressable, { onPress, testID })
				: ReactRuntime.createElement(Native.View, { testID }),
		LabeledContent: ({
			children,
			label,
		}: {
			children?: React.ReactNode;
			label?: React.ReactNode;
		}) =>
			ReactRuntime.createElement(
				Native.View,
				null,
				typeof label === 'string'
					? ReactRuntime.createElement(Native.Text, null, label)
					: (label ?? null),
				children,
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
		ContentUnavailableView: ({
			description,
			testID,
			title,
		}: {
			description?: string;
			testID?: string;
			title?: string;
		}) =>
			ReactRuntime.createElement(
				Native.View,
				{ testID },
				ReactRuntime.createElement(Native.Text, null, title),
				description
					? ReactRuntime.createElement(Native.Text, null, description)
					: null,
			),
	};
});

jest.mock('@expo/ui/swift-ui/modifiers', () => ({
	autocorrectionDisabled: () => 'autocorrectionDisabled',
	badge: (value: unknown) => ({ badge: value }),
	buttonStyle: (value: unknown) => value,
	font: (value: unknown) => value,
	foregroundStyle: (value: unknown) => value,
	frame: (value: unknown) => value,
	listStyle: (value: unknown) => value,
	pickerStyle: (value: unknown) => value,
	tag: (value: unknown) => value,
	textSelection: (value: unknown) => value,
	tint: (value: unknown) => value,
}));

function streamedBodyClone(body: string) {
	const bytes = new TextEncoder().encode(body);
	let sent = false;
	return {
		body: {
			getReader: () => ({
				read: async () => {
					if (sent) return { done: true, value: undefined };
					sent = true;
					return { done: false, value: bytes };
				},
				cancel: async () => {},
			}),
		},
	};
}

function response(body: string, status = 200): Response {
	const headers = new Headers({
		'content-length': String(new TextEncoder().encode(body).byteLength),
		'content-type': 'application/json',
	});
	return {
		status,
		headers,
		clone: () => streamedBodyClone(body),
	} as unknown as Response;
}

async function flushCapture(): Promise<void> {
	for (let index = 0; index < 32; index += 1) await Promise.resolve();
}

async function disposeDiagnostics(
	dispose: (() => void) | undefined,
): Promise<void> {
	await act(() => dispose?.());
}

function createActions(): DevToolsActionServices & { run: jest.Mock } {
	return {
		run: jest.fn(async (request: DevToolsActionRequest) => {
			await request.action();
			return true;
		}),
	};
}

function panelProps(actions: DevToolsActionServices): DevToolsPanelProps {
	return {
		actions,
		onBack: jest.fn(),
		onClose: jest.fn(),
		onPresentationModeChange: jest.fn(),
		presentationMode: 'sheet',
		safeAreaTop: 0,
	};
}

async function seededDiagnostics() {
	const previousFetch = globalThis.fetch;
	const baseFetch = jest
		.fn()
		.mockResolvedValue(response('{"ok":true}')) as unknown as typeof fetch;
	globalThis.fetch = baseFetch;
	const diagnostics = createNetworkPlugin({
		enableRequestReplay: true,
		patchGlobalFetch: true,
	});
	const disposePlugin = diagnostics.plugin.install?.();
	await globalThis.fetch('https://abc.supabase.co/rest/v1/items?select=id');
	await globalThis.fetch('https://o123.ingest.sentry.io/api/1/envelope/', {
		method: 'POST',
	});
	await flushCapture();
	const dispose = () => {
		disposePlugin?.();
		globalThis.fetch = previousFetch;
	};
	return { baseFetch, diagnostics, dispose };
}

describe('NetworkPanel', () => {
	it('lists requests, hides system traffic by default, and filters segments', async () => {
		const { diagnostics, dispose } = await seededDiagnostics();
		await render(<diagnostics.plugin.Panel {...panelProps(createActions())} />);

		expect(screen.getByText('items')).toBeOnTheScreen();
		expect(screen.queryByTestId('devtools-network-row-2')).toBeNull();
		expect(screen.getByText('1 hidden')).toBeOnTheScreen();

		await fireEvent.press(screen.getByTestId('devtools-network-hide-system'));
		expect(screen.getByTestId('devtools-network-row-2')).toBeOnTheScreen();
		expect(screen.getByText('1 shown')).toBeOnTheScreen();

		await fireEvent.press(screen.getByLabelText('network-filter-errors'));
		expect(screen.queryByText('items')).toBeNull();
		expect(screen.getByText('No matches')).toBeOnTheScreen();

		await disposeDiagnostics(dispose);
	});

	it('removes an idle owner capture from a mounted panel synchronously', async () => {
		let owner = 'owner-a';
		let authorityListener = (): void => {};
		const diagnostics = createNetworkPlugin({
			captureAuthority: () => owner,
			subscribeCaptureAuthority: (listener) => {
				authorityListener = listener;
				return () => {
					authorityListener = (): void => {};
				};
			},
		});
		const dispose = diagnostics.plugin.install?.();
		await diagnostics.instrumentFetch(
			jest.fn(async () => response('{}')) as unknown as typeof fetch,
		)('https://example.test/owner-a-private');
		await render(<diagnostics.plugin.Panel {...panelProps(createActions())} />);
		expect(screen.getByText('owner-a-private')).toBeOnTheScreen();

		await act(() => {
			owner = 'owner-b';
			authorityListener();
		});

		expect(screen.queryByText('owner-a-private')).toBeNull();
		expect(screen.getByText('No requests')).toBeOnTheScreen();
		await disposeDiagnostics(dispose);
	});

	it('opens the request detail sub-view and returns to the list', async () => {
		const { diagnostics, dispose } = await seededDiagnostics();
		await render(<diagnostics.plugin.Panel {...panelProps(createActions())} />);

		// The native search field does not survive the detail round trip, so the
		// list must come back unfiltered rather than behind an empty search box.
		await fireEvent.changeText(
			screen.getByTestId('devtools-network-search'),
			'items',
		);
		await fireEvent.press(screen.getByTestId('devtools-network-row-1'));
		expect(screen.getByText('GET items')).toBeOnTheScreen();
		expect(screen.getByText('Overview')).toBeOnTheScreen();
		expect(screen.getByText('Timing')).toBeOnTheScreen();
		expect(screen.getByText('Transport / response')).toBeOnTheScreen();
		expect(screen.getByTestId('devtools-network-share')).toBeOnTheScreen();

		await fireEvent.press(screen.getByTestId('devtools-panel-back'));
		expect(screen.getByTestId('devtools-network-search')).toBeOnTheScreen();
		await fireEvent.press(screen.getByTestId('devtools-network-hide-system'));
		expect(screen.getByTestId('devtools-network-row-2')).toBeOnTheScreen();

		await disposeDiagnostics(dispose);
	});

	it('reports app-scoped capability state and changes profiles through policy actions', async () => {
		const diagnostics = createNetworkPlugin({
			enableSimulation: true,
			actionCoordinator: createDevToolsActionCoordinator({
				confirm: async () => true,
			}),
		});
		const dispose = diagnostics.plugin.install?.();
		const actions = createActions();
		await render(<diagnostics.plugin.Panel {...panelProps(actions)} />);

		expect(screen.getByText('Network conditions')).toBeOnTheScreen();
		expect(
			screen.getByTestId('devtools-network-active-profile'),
		).toHaveTextContent('No profile');
		expect(
			screen.getByText(/No native SDK, WebSocket, or other-app traffic/),
		).toBeOnTheScreen();
		await fireEvent.press(screen.getByLabelText('network-filter-offline'));

		await waitFor(() => {
			expect(diagnostics.getSimulationProfile().id).toBe('offline');
			expect(
				screen.getByTestId('devtools-network-active-profile'),
			).toHaveTextContent('Offline');
		});
		expect(actions.run).not.toHaveBeenCalled();
		await disposeDiagnostics(dispose);
	});

	it('treats a cancelled profile confirmation as cancellation, not failure', async () => {
		const confirm = jest.fn(async () => false);
		const onReceipt = jest.fn();
		const diagnostics = createNetworkPlugin({
			enableSimulation: true,
			actionCoordinator: createDevToolsActionCoordinator({
				confirm,
				onReceipt,
			}),
		});
		const dispose = diagnostics.plugin.install?.();
		let actionFailure: unknown;
		const actions: DevToolsActionServices = {
			run: jest.fn(async (request: DevToolsActionRequest) => {
				try {
					await request.action();
					return true;
				} catch (error) {
					actionFailure = error;
					return false;
				}
			}),
		};
		await render(<diagnostics.plugin.Panel {...panelProps(actions)} />);

		await fireEvent.press(screen.getByLabelText('network-filter-offline'));
		await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));

		expect(actionFailure).toBeUndefined();
		expect(actions.run).not.toHaveBeenCalled();
		expect(onReceipt).toHaveBeenCalledWith(
			expect.objectContaining({ status: 'cancelled' }),
		);
		expect(diagnostics.getSimulationProfile().id).toBe('none');
		await disposeDiagnostics(dispose);
	});

	it('shows aggregate duplicate and cache insights', async () => {
		const diagnostics = createNetworkPlugin();
		const dispose = diagnostics.plugin.install?.();
		const instrumented = diagnostics.instrumentFetch(
			jest.fn(async () => {
				const headers = new Headers({
					'content-length': '2',
					'content-type': 'application/json',
					'x-cache': 'HIT',
				});
				return {
					status: 200,
					headers,
					clone: () => ({ text: async () => '{}' }),
				} as unknown as Response;
			}) as unknown as typeof fetch,
		);
		await instrumented('https://example.test/items');
		await instrumented('https://example.test/items');
		await flushCapture();
		await render(<diagnostics.plugin.Panel {...panelProps(createActions())} />);

		expect(screen.getByText('Insights')).toBeOnTheScreen();
		expect(screen.getByText('Duplicate requests')).toBeOnTheScreen();
		expect(screen.getByText('HTTP cache evidence')).toBeOnTheScreen();
		expect(screen.getByText('2 hit')).toBeOnTheScreen();
		await disposeDiagnostics(dispose);
	});

	it('clears requests through a destructive confirmation', async () => {
		const { diagnostics, dispose } = await seededDiagnostics();
		const actions = createActions();
		await render(<diagnostics.plugin.Panel {...panelProps(actions)} />);

		await fireEvent.press(
			within(screen.getByTestId('devtools-network-clear')).getByRole('button'),
		);

		expect(await screen.findByText('No requests')).toBeOnTheScreen();
		expect(actions.run).toHaveBeenCalledWith(
			expect.objectContaining({
				pluginId: 'network',
				label: 'Clear requests',
				confirmation: expect.objectContaining({ destructive: true }),
			}),
		);
		expect(diagnostics.getEvents()).toEqual([]);

		await disposeDiagnostics(dispose);
	});

	it('cancels a live body reader when the panel clears requests', async () => {
		const cancel = jest.fn(async () => {});
		const diagnostics = createNetworkPlugin({ captureBody: true });
		const dispose = diagnostics.plugin.install?.();
		const stalledResponse = {
			status: 200,
			headers: new Headers({
				'content-length': '1',
				'content-type': 'text/plain',
			}),
			clone: () => ({
				body: {
					getReader: () => ({
						read: () => new Promise<never>(() => {}),
						cancel,
					}),
				},
			}),
		} as unknown as Response;
		await diagnostics.instrumentFetch(jest.fn(async () => stalledResponse))(
			'https://example.test/panel-clear-reader',
		);
		await render(<diagnostics.plugin.Panel {...panelProps(createActions())} />);

		await fireEvent.press(
			within(screen.getByTestId('devtools-network-clear')).getByRole('button'),
		);
		await flushCapture();

		expect(cancel).toHaveBeenCalledTimes(1);
		expect(diagnostics.getEvents()).toEqual([]);
		await disposeDiagnostics(dispose);
	});

	it('toggles capture pause from the nav bar', async () => {
		const { diagnostics, dispose } = await seededDiagnostics();
		await render(<diagnostics.plugin.Panel {...panelProps(createActions())} />);

		await fireEvent.press(
			within(screen.getByTestId('devtools-network-pause')).getByRole('button'),
		);
		expect(diagnostics.isPaused()).toBe(true);
		await fireEvent.press(
			within(screen.getByTestId('devtools-network-pause')).getByRole('button'),
		);
		expect(diagnostics.isPaused()).toBe(false);

		await disposeDiagnostics(dispose);
	});

	it('does not let a delayed pause action cross tools sessions', async () => {
		const { diagnostics, dispose } = await seededDiagnostics();
		let pendingRequest: DevToolsActionRequest | undefined;
		const actions: DevToolsActionServices = {
			run: jest.fn(async (request: DevToolsActionRequest) => {
				pendingRequest = request;
				return true;
			}),
		};
		await render(<diagnostics.plugin.Panel {...panelProps(actions)} />);

		await fireEvent.press(
			within(screen.getByTestId('devtools-network-pause')).getByRole('button'),
		);
		expect(pendingRequest).toEqual(
			expect.objectContaining({ label: 'Pause network capture' }),
		);

		await disposeDiagnostics(dispose);
		let disposeNextSession: (() => void) | undefined;
		await act(() => {
			disposeNextSession = diagnostics.plugin.install?.();
		});
		expect(diagnostics.isPaused()).toBe(false);
		if (!pendingRequest) throw new Error('Expected a pending pause action.');
		await expect(
			Promise.resolve().then(() => pendingRequest?.action()),
		).rejects.toThrow('network tools session changed');
		expect(diagnostics.isPaused()).toBe(false);
		await disposeDiagnostics(disposeNextSession);
	});

	it('re-sends the captured request and shares a cURL command from the detail view', async () => {
		const { baseFetch, diagnostics, dispose } = await seededDiagnostics();
		const actions = createActions();
		const shareSpy = jest
			.spyOn(Share, 'share')
			.mockResolvedValue({ action: 'sharedAction' } as Awaited<
				ReturnType<typeof Share.share>
			>);
		await render(<diagnostics.plugin.Panel {...panelProps(actions)} />);

		await fireEvent.press(screen.getByTestId('devtools-network-row-1'));
		await fireEvent.press(screen.getByTestId('devtools-network-resend'));
		await waitFor(() => {
			expect(baseFetch).toHaveBeenCalledWith(
				'https://abc.supabase.co/rest/v1/items?select=id',
				expect.objectContaining({ method: 'GET' }),
			);
		});
		expect(actions.run).toHaveBeenCalledWith(
			expect.objectContaining({ label: 'Re-send request' }),
		);

		await fireEvent.press(screen.getByTestId('devtools-network-copy-curl'));
		expect(shareSpy).toHaveBeenCalledWith({
			message: expect.stringContaining("curl -X 'GET'"),
		});

		shareSpy.mockRestore();
		await disposeDiagnostics(dispose);
	});

	it('binds replay to immutable request details after confirmation starts', async () => {
		const { baseFetch, diagnostics, dispose } = await seededDiagnostics();
		let pendingRequest: DevToolsActionRequest | undefined;
		const actions: DevToolsActionServices = {
			run: jest.fn(async (request: DevToolsActionRequest) => {
				pendingRequest = request;
				return true;
			}),
		};
		await render(<diagnostics.plugin.Panel {...panelProps(actions)} />);

		await fireEvent.press(screen.getByTestId('devtools-network-row-1'));
		await fireEvent.press(screen.getByTestId('devtools-network-resend'));
		const confirmedEvent = diagnostics.getEvents()[0];
		try {
			Reflect.set(confirmedEvent ?? {}, 'url', 'https://attacker.test');
			Reflect.set(
				confirmedEvent?.requestHeaders ?? {},
				'authorization',
				'Bearer attacker',
			);
		} catch {
			// Strict runtimes throw for frozen request details.
		}
		if (!pendingRequest) throw new Error('Expected a pending replay action.');
		await act(async () => {
			await pendingRequest?.action();
		});

		expect(baseFetch).toHaveBeenCalledWith(
			'https://abc.supabase.co/rest/v1/items?select=id',
			expect.objectContaining({ method: 'GET', headers: {} }),
		);
		await disposeDiagnostics(dispose);
	});

	it('rejects replay when the owned global fetch changes during confirmation', async () => {
		const { baseFetch, diagnostics, dispose } = await seededDiagnostics();
		let pendingRequest: DevToolsActionRequest | undefined;
		const actions: DevToolsActionServices = {
			run: jest.fn(async (request: DevToolsActionRequest) => {
				pendingRequest = request;
				return true;
			}),
		};
		await render(<diagnostics.plugin.Panel {...panelProps(actions)} />);
		await fireEvent.press(screen.getByTestId('devtools-network-row-1'));
		await fireEvent.press(screen.getByTestId('devtools-network-resend'));
		if (!pendingRequest) throw new Error('Expected a pending replay action.');
		const ownedFetch = globalThis.fetch;
		const replacementFetch = jest
			.fn()
			.mockResolvedValue(
				response('{"replacement":true}'),
			) as unknown as typeof fetch;
		globalThis.fetch = replacementFetch;
		try {
			await expect(pendingRequest.action()).rejects.toThrow(
				'owned fetch transport was replaced',
			);
			expect(replacementFetch).not.toHaveBeenCalled();
			expect(baseFetch).toHaveBeenCalledTimes(2);
		} finally {
			globalThis.fetch = ownedFetch;
			await disposeDiagnostics(dispose);
		}
	});

	it('does not let a delayed replay cross tools sessions', async () => {
		const { baseFetch, diagnostics, dispose } = await seededDiagnostics();
		let pendingRequest: DevToolsActionRequest | undefined;
		const actions: DevToolsActionServices = {
			run: jest.fn(async (request: DevToolsActionRequest) => {
				pendingRequest = request;
				return true;
			}),
		};
		await render(<diagnostics.plugin.Panel {...panelProps(actions)} />);

		await fireEvent.press(screen.getByTestId('devtools-network-row-1'));
		await fireEvent.press(screen.getByTestId('devtools-network-resend'));
		expect(pendingRequest).toEqual(
			expect.objectContaining({ label: 'Re-send request' }),
		);

		await disposeDiagnostics(dispose);
		let disposeNextSession: (() => void) | undefined;
		await act(() => {
			disposeNextSession = diagnostics.plugin.install?.();
		});
		if (!pendingRequest) throw new Error('Expected a pending replay action.');
		await expect(
			Promise.resolve().then(() => pendingRequest?.action()),
		).rejects.toThrow('network tools session changed');
		expect(baseFetch).toHaveBeenCalledTimes(2);

		await disposeDiagnostics(disposeNextSession);
	});

	it('does not let a delayed replay cross capability authorities', async () => {
		const previousFetch = globalThis.fetch;
		const baseFetch = jest.fn().mockResolvedValue(response('{"ok":true}'));
		globalThis.fetch = baseFetch as unknown as typeof fetch;
		let capabilityId = 'network.set-profile.authority-a';
		let capabilityListener = (): void => {};
		const diagnostics = createNetworkPlugin({
			enableRequestReplay: true,
			enableSimulation: true,
			patchGlobalFetch: true,
			simulationCapability: () => ({
				schemaVersion: 1,
				id: capabilityId,
				availability: 'available',
			}),
			subscribeSimulationCapability: (listener) => {
				capabilityListener = listener;
				return () => {
					capabilityListener = (): void => {};
				};
			},
		});
		const dispose = diagnostics.plugin.install?.();
		try {
			await globalThis.fetch('https://example.test/authority-a');
			await flushCapture();
			let pendingRequest: DevToolsActionRequest | undefined;
			const actions: DevToolsActionServices = {
				run: jest.fn(async (request: DevToolsActionRequest) => {
					pendingRequest = request;
					return true;
				}),
			};
			await render(<diagnostics.plugin.Panel {...panelProps(actions)} />);
			await fireEvent.press(screen.getByTestId('devtools-network-row-1'));
			await fireEvent.press(screen.getByTestId('devtools-network-resend'));
			if (!pendingRequest) throw new Error('Expected a pending replay action.');

			capabilityId = 'network.set-profile.authority-b';
			await act(() => capabilityListener());

			expect(diagnostics.getEvents()).toEqual([]);
			await expect(
				Promise.resolve().then(() => pendingRequest?.action()),
			).rejects.toThrow('network tools session changed');
			expect(baseFetch).toHaveBeenCalledTimes(1);
		} finally {
			await disposeDiagnostics(dispose);
			globalThis.fetch = previousFetch;
		}
	});

	it('keeps request replay disabled without an owned global-fetch layer', async () => {
		const diagnostics = createNetworkPlugin({ enableRequestReplay: true });
		const dispose = diagnostics.plugin.install?.();
		await diagnostics.instrumentFetch(
			jest
				.fn()
				.mockResolvedValue(response('{"ok":true}')) as unknown as typeof fetch,
		)('https://example.test/read-only');
		await flushCapture();
		await render(<diagnostics.plugin.Panel {...panelProps(createActions())} />);

		await fireEvent.press(screen.getByTestId('devtools-network-row-1'));

		expect(screen.queryByTestId('devtools-network-resend')).toBeNull();
		expect(
			screen.getByText(
				'Re-send unavailable: Request replay is disabled by this host.',
			),
		).toBeOnTheScreen();
		await disposeDiagnostics(dispose);
	});

	it('does not replay an explicit client through the global fetch transport', async () => {
		const previousFetch = globalThis.fetch;
		const globalFetch = jest
			.fn()
			.mockResolvedValue(
				response('{"global":true}'),
			) as unknown as typeof fetch;
		globalThis.fetch = globalFetch;
		const diagnostics = createNetworkPlugin({
			enableRequestReplay: true,
			patchGlobalFetch: true,
		});
		const dispose = diagnostics.plugin.install?.();
		try {
			const explicitFetch = jest
				.fn()
				.mockResolvedValue(
					response('{"explicit":true}'),
				) as unknown as typeof fetch;
			await diagnostics.instrumentFetch(explicitFetch)(
				'https://example.test/explicit-client',
			);
			await flushCapture();
			const actions = createActions();
			await render(<diagnostics.plugin.Panel {...panelProps(actions)} />);

			await fireEvent.press(screen.getByTestId('devtools-network-row-1'));

			expect(screen.queryByTestId('devtools-network-resend')).toBeNull();
			expect(
				screen.getByText(/explicit fetch client whose original transport/),
			).toBeOnTheScreen();
			expect(globalFetch).not.toHaveBeenCalled();
			expect(actions.run).not.toHaveBeenCalledWith(
				expect.objectContaining({ label: 'Re-send request' }),
			);
		} finally {
			await disposeDiagnostics(dispose);
			globalThis.fetch = previousFetch;
		}
	});

	it('replays compact safe JSON only through its owned global transport', async () => {
		const previousFetch = globalThis.fetch;
		const baseFetch = jest
			.fn()
			.mockResolvedValue(response('{"ok":true}')) as unknown as typeof fetch;
		globalThis.fetch = baseFetch;
		const diagnostics = createNetworkPlugin({
			captureBody: true,
			enableRequestReplay: true,
			patchGlobalFetch: true,
		});
		const dispose = diagnostics.plugin.install?.();
		const body = '{"name":"Example","count":3}';
		try {
			await globalThis.fetch('https://example.test/safe-json', {
				method: 'POST',
				body,
			});
			await flushCapture();
			expect(diagnostics.getEvents()[0]).toEqual(
				expect.objectContaining({
					captureTransport: 'global-fetch',
					requestBody: body,
					requestProjectionComplete: true,
				}),
			);
			await render(
				<diagnostics.plugin.Panel {...panelProps(createActions())} />,
			);
			await fireEvent.press(screen.getByTestId('devtools-network-row-1'));
			await fireEvent.press(screen.getByTestId('devtools-network-resend'));

			await waitFor(() => expect(baseFetch).toHaveBeenCalledTimes(2));
			expect(baseFetch).toHaveBeenLastCalledWith(
				'https://example.test/safe-json',
				expect.objectContaining({ method: 'POST', body }),
			);
		} finally {
			await disposeDiagnostics(dispose);
			globalThis.fetch = previousFetch;
		}
	});

	it('replays a complete bodyless POST without inventing a request body', async () => {
		const previousFetch = globalThis.fetch;
		const baseFetch = jest.fn().mockResolvedValue(response('{"ok":true}'));
		globalThis.fetch = baseFetch as unknown as typeof fetch;
		const diagnostics = createNetworkPlugin({
			captureBody: true,
			enableRequestReplay: true,
			patchGlobalFetch: true,
		});
		const dispose = diagnostics.plugin.install?.();
		try {
			await globalThis.fetch('https://example.test/bodyless', {
				method: 'POST',
			});
			await flushCapture();
			expect(diagnostics.getEvents()[0]).toEqual(
				expect.objectContaining({
					requestBody: undefined,
					requestProjectionComplete: true,
				}),
			);
			await render(
				<diagnostics.plugin.Panel {...panelProps(createActions())} />,
			);
			await fireEvent.press(screen.getByTestId('devtools-network-row-1'));
			await fireEvent.press(screen.getByTestId('devtools-network-resend'));

			await waitFor(() => expect(baseFetch).toHaveBeenCalledTimes(2));
			const replayInit = baseFetch.mock.calls[1]?.[1];
			expect(replayInit).toEqual({ method: 'POST', headers: {} });
			expect(replayInit).not.toHaveProperty('body');
		} finally {
			await disposeDiagnostics(dispose);
			globalThis.fetch = previousFetch;
		}
	});

	it('keeps secret JSON ineligible for global request replay', async () => {
		const previousFetch = globalThis.fetch;
		const baseFetch = jest
			.fn()
			.mockResolvedValue(response('{"ok":true}')) as unknown as typeof fetch;
		globalThis.fetch = baseFetch;
		const diagnostics = createNetworkPlugin({
			captureBody: true,
			enableRequestReplay: true,
			patchGlobalFetch: true,
		});
		const dispose = diagnostics.plugin.install?.();
		try {
			await globalThis.fetch('https://example.test/secret-json', {
				method: 'POST',
				body: '{"password":"shared-secret","name":"Example"}',
			});
			await flushCapture();
			expect(diagnostics.getEvents()[0]).toEqual(
				expect.objectContaining({ requestProjectionComplete: false }),
			);
			expect(JSON.stringify(diagnostics.getEvents()[0])).not.toContain(
				'shared-secret',
			);
			await render(
				<diagnostics.plugin.Panel {...panelProps(createActions())} />,
			);
			await fireEvent.press(screen.getByTestId('devtools-network-row-1'));

			expect(screen.queryByTestId('devtools-network-resend')).toBeNull();
			expect(baseFetch).toHaveBeenCalledTimes(1);
		} finally {
			await disposeDiagnostics(dispose);
			globalThis.fetch = previousFetch;
		}
	});

	it('disables replay when any request credential was redacted', async () => {
		const diagnostics = createNetworkPlugin({
			captureBody: true,
			enableRequestReplay: true,
			patchGlobalFetch: true,
		});
		const dispose = diagnostics.plugin.install?.();
		const instrumented = diagnostics.instrumentFetch(
			jest
				.fn()
				.mockResolvedValue(response('{"ok":true}')) as unknown as typeof fetch,
		);
		await instrumented('https://abc.supabase.co/rest/v1/items', {
			method: 'POST',
			headers: {
				authorization: 'Bearer real-token',
				accept: 'application/json',
			},
			body: '{"name":"Example"}',
		});
		await flushCapture();
		const actions = createActions();
		const previousFetch = globalThis.fetch;
		const fetchMock = jest
			.fn()
			.mockResolvedValue(response('{"ok":true}')) as unknown as typeof fetch;
		globalThis.fetch = fetchMock;
		await render(<diagnostics.plugin.Panel {...panelProps(actions)} />);

		await fireEvent.press(screen.getByTestId('devtools-network-row-1'));

		expect(screen.queryByTestId('devtools-network-resend')).toBeNull();
		expect(
			screen.getByText(/Re-send unavailable: The complete original request/),
		).toBeOnTheScreen();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(actions.run).not.toHaveBeenCalledWith(
			expect.objectContaining({ label: 'Re-send request' }),
		);

		globalThis.fetch = previousFetch;
		await disposeDiagnostics(dispose);
	});
});

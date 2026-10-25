import { QueryClient } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { formatRelativeTime } from '../core/format';
import {
	createMutationSnapshot,
	createQueryPlugin,
	createQuerySimulationController,
	formatQueryKey,
	formatQueryKeyRemainder,
	type QueryPlugin,
	summarizeError,
} from './query';
import { createQuerySnapshot } from './query-model';

jest.mock('@expo/ui/swift-ui', () => {
	const ReactRuntime = jest.requireActual('react');
	const Native = jest.requireActual('react-native');
	const Container = ({ children }: { children?: React.ReactNode }) =>
		ReactRuntime.createElement(Native.View, null, children);
	const DisclosureGroup = Object.assign(
		({
			children,
			isExpanded,
			onIsExpandedChange,
		}: {
			children?: React.ReactNode;
			isExpanded?: boolean;
			onIsExpandedChange?: (isExpanded: boolean) => void;
		}) =>
			ReactRuntime.createElement(
				Native.Pressable,
				{ onPress: () => onIsExpandedChange?.(!isExpanded) },
				children,
			),
		{ Label: Container },
	);
	const SwipeActions = Object.assign(Container, { Actions: Container });
	return {
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
				{ accessibilityLabel: label, onPress },
				children ?? ReactRuntime.createElement(Native.Text, null, label),
			),
		ContentUnavailableView: ({
			description,
			title,
		}: {
			description?: string;
			title?: string;
		}) =>
			ReactRuntime.createElement(
				Native.View,
				null,
				title ? ReactRuntime.createElement(Native.Text, null, title) : null,
				description
					? ReactRuntime.createElement(Native.Text, null, description)
					: null,
			),
		DisclosureGroup,
		Host: Container,
		HStack: Container,
		Image: () => ReactRuntime.createElement(Native.View),
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
					: label,
				children,
			),
		List: Container,
		Picker: ({
			children,
			onSelectionChange,
			selection,
		}: {
			children?: React.ReactNode;
			onSelectionChange?: (value: string) => void;
			selection?: string;
		}) =>
			ReactRuntime.createElement(
				Native.View,
				null,
				ReactRuntime.Children.map(children, (child: React.ReactElement) => {
					const option = child.props as {
						children?: React.ReactNode;
						modifiers?: ReadonlyArray<Record<string, unknown>>;
					};
					const tagged = option.modifiers?.find(
						(modifier) => 'tag' in modifier,
					) as { tag?: string } | undefined;
					const value = tagged?.tag;
					return ReactRuntime.createElement(
						Native.Pressable,
						{
							accessibilityRole: 'tab',
							accessibilityState: { selected: selection === value },
							onPress: () => {
								if (value !== undefined) onSelectionChange?.(value);
							},
						},
						ReactRuntime.createElement(Native.Text, null, option.children),
					);
				}),
			),
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
		SwipeActions,
		Text: ({
			children,
			modifiers,
		}: {
			children?: React.ReactNode;
			modifiers?: unknown[];
		}) => ReactRuntime.createElement(Native.Text, { modifiers }, children),
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
		VStack: Container,
	};
});

jest.mock('@expo/ui/swift-ui/modifiers', () => ({
	autocorrectionDisabled: () => ({ autocorrectionDisabled: true }),
	badge: (value: unknown) => ({ badge: value }),
	disabled: (value: unknown) => ({ disabled: value }),
	font: (value: unknown) => ({ font: value }),
	foregroundColor: (value: unknown) => ({ foregroundColor: value }),
	frame: (value: unknown) => ({ frame: value }),
	listStyle: (value: unknown) => ({ listStyle: value }),
	pickerStyle: (value: unknown) => ({ pickerStyle: value }),
	tag: (value: unknown) => ({ tag: value }),
	tint: (value: unknown) => ({ tint: value }),
}));

async function renderPanel(plugin: QueryPlugin) {
	const run = jest.fn(async () => true);
	const Panel = plugin.Panel;
	await render(
		<Panel
			actions={{ run }}
			onBack={jest.fn()}
			onClose={jest.fn()}
			onPresentationModeChange={jest.fn()}
			presentationMode="window"
		/>,
	);
	return run;
}

describe('createQuerySnapshot', () => {
	it('formats query keys as readable breadcrumbs', () => {
		expect(formatQueryKey(['projects', 'today', { userId: 42 }])).toBe(
			'projects › today › { "userId": "[REDACTED]" }',
		);
		expect(formatQueryKey(undefined)).toBe('Anonymous mutation');
	});

	it('does not invoke query-key accessors or throw for revoked proxies', () => {
		const getter = jest.fn(() => 'unsafe');
		const queryKey: unknown[] = [];
		Object.defineProperty(queryKey, '0', { enumerable: true, get: getter });
		queryKey.length = 1;
		const revoked = Proxy.revocable<unknown[]>([], {});
		revoked.revoke();

		expect(formatQueryKey(queryKey)).toBe('Anonymous mutation');
		expect(formatQueryKey(revoked.proxy)).toBe('Anonymous mutation');
		expect(getter).not.toHaveBeenCalled();
	});

	it('captures public query state and optional data', () => {
		const queryClient = new QueryClient({
			defaultOptions: { mutations: { gcTime: Number.POSITIVE_INFINITY } },
		});
		queryClient.setQueryData(['projects', { page: 1 }], { items: [1, 2] });
		const query = queryClient.getQueryCache().getAll()[0];
		if (!query) throw new Error('Expected cached query');

		const snapshot = createQuerySnapshot(query, true, 1024);

		expect(snapshot.key).toContain('projects');
		expect(snapshot.status).toBe('success');
		expect(snapshot.data).toContain('items');
		expect(snapshot.dataUpdateCount).toBe(1);
		queryClient.clear();
	});

	it('stores detached redacted query keys instead of live key references', () => {
		const queryClient = new QueryClient();
		const privateKey = { accessToken: 'private-key-value', page: 1 };
		queryClient.setQueryData(['projects', privateKey], { ok: true });
		const query = queryClient.getQueryCache().getAll()[0];
		if (!query) throw new Error('Expected cached query');

		const snapshot = createQuerySnapshot(query, false, 1024);
		privateKey.accessToken = 'changed-after-capture';

		expect(snapshot).not.toHaveProperty('queryKey');
		expect(snapshot.keySegments).toHaveLength(2);
		expect(JSON.stringify(snapshot)).toContain('[REDACTED]');
		expect(JSON.stringify(snapshot)).not.toContain('private-key-value');
		expect(JSON.stringify(snapshot)).not.toContain('changed-after-capture');
		queryClient.clear();
	});

	it('bounds individual query-key segments', () => {
		const queryClient = new QueryClient();
		queryClient.setQueryData(['projects', 'x'.repeat(10_000)], { ok: true });
		const query = queryClient.getQueryCache().getAll()[0];
		if (!query) throw new Error('Expected cached query');

		const snapshot = createQuerySnapshot(query, false, 1024);

		expect(
			new TextEncoder().encode(snapshot.keySegments[1]).byteLength,
		).toBeLessThanOrEqual(512);
		expect(snapshot.truncated).toBe(true);
		queryClient.clear();
	});
});

describe('query panel formatting helpers', () => {
	it('titles rows with the key segments after the grouping segment', () => {
		expect(formatQueryKeyRemainder(['projects', 'list', 'page-12'])).toBe(
			'list · page-12',
		);
		expect(formatQueryKeyRemainder(['stats', 12])).toBe('12');
		expect(formatQueryKeyRemainder(['projects'])).toBe('projects');
	});

	it('formats relative update times', () => {
		const now = Date.now();
		expect(formatRelativeTime(0, now)).toBeUndefined();
		expect(formatRelativeTime(now - 500, now)).toBe('now');
		expect(formatRelativeTime(now - 5_000, now)).toBe('5s');
		expect(formatRelativeTime(now - 120_000, now)).toBe('2m');
		expect(formatRelativeTime(now - 2 * 3_600_000, now)).toBe('2h');
		expect(formatRelativeTime(now - 3 * 86_400_000, now)).toBe('3d');
	});

	it('summarizes live and serialized errors to one line', () => {
		expect(summarizeError(undefined, new Error('boom\nstack'))).toBe(
			'Error: boom',
		);
		expect(
			summarizeError('{"name":"ZodError","message":"expected number"}', null),
		).toBe('ZodError: expected number');
		expect(summarizeError('plain text\nsecond line', null)).toBe('plain text');
		expect(summarizeError(undefined, new Error('token=private-token'))).toBe(
			'Error: token=[REDACTED]',
		);
		expect(summarizeError(undefined, null)).toBeUndefined();
	});
});

describe('createQueryPlugin', () => {
	it('limits raw cache entries before snapshotting and defers payload serialization', () => {
		const queryClient = new QueryClient();
		for (let index = 0; index < 10; index += 1) {
			queryClient.setQueryData(['query', index], {
				payload: 'x'.repeat(10_000),
			});
		}
		const plugin = createQueryPlugin({
			queryClient,
			captureData: true,
			maxQueries: 2,
			maxStoreBytes: 32 * 1024,
		});
		const dispose = plugin.install?.();

		expect(plugin.getSnapshot().queries).toHaveLength(2);
		expect(plugin.getSnapshot().queries[0]?.data).toBeUndefined();
		expect(plugin.getSnapshot()).toMatchObject({
			sourceQueryCount: 10,
			omittedQueryCount: 8,
		});
		expect(plugin.captureSnapshot().queries[0]?.data).toContain('payload');

		dispose?.();
		queryClient.clear();
	});

	it('retains the most recently updated queries when the cache exceeds its limit', () => {
		const queryClient = new QueryClient();
		queryClient.setQueryData(
			['query', 'oldest'],
			{ ok: true },
			{ updatedAt: 10 },
		);
		queryClient.setQueryData(
			['query', 'newest'],
			{ ok: true },
			{ updatedAt: 30 },
		);
		queryClient.setQueryData(
			['query', 'middle'],
			{ ok: true },
			{ updatedAt: 20 },
		);
		const plugin = createQueryPlugin({ queryClient, maxQueries: 2 });
		const dispose = plugin.install?.();

		expect(
			plugin.getSnapshot().queries.map((query) => query.keySegments[1]),
		).toEqual(['newest', 'middle']);
		expect(plugin.getSnapshot().omittedQueryCount).toBe(1);

		dispose?.();
		queryClient.clear();
	});

	it('supports reusable metadata overrides', () => {
		const queryClient = new QueryClient();
		const plugin = createQueryPlugin({
			queryClient,
			id: 'example-query',
			title: 'Example Query',
			description: 'Custom description',
			section: 'Diagnostics',
			systemImage: 'bolt.fill',
		});

		expect(plugin).toEqual(
			expect.objectContaining({
				id: 'example-query',
				title: 'Example Query',
				description: 'Custom description',
				section: 'Diagnostics',
				systemImage: 'bolt.fill',
			}),
		);
	});

	it('runs targeted actions through opaque snapshot identifiers', async () => {
		const queryClient = new QueryClient();
		queryClient.setQueryData(
			['private', { accessToken: 'never-retain-this' }],
			{ ok: true },
		);
		const plugin = createQueryPlugin({ queryClient });
		const dispose = plugin.install?.();
		const snapshot = plugin.getSnapshot().queries[0];
		if (!snapshot) throw new Error('Expected query snapshot');

		expect(snapshot.hash).toMatch(/^query-\d+$/);
		expect(snapshot.hash).not.toContain('never-retain-this');
		await plugin.runQueryAction(snapshot.hash, 'invalidate');
		expect(queryClient.getQueryCache().getAll()[0]?.state.isInvalidated).toBe(
			true,
		);
		await expect(
			plugin.runQueryAction('query-missing', 'invalidate'),
		).rejects.toThrow('no longer available');

		dispose?.();
		queryClient.clear();
	});

	it('rejects invalid retention bounds', () => {
		const queryClient = new QueryClient();
		expect(() => createQueryPlugin({ queryClient, maxQueries: 0 })).toThrow(
			'maxQueries',
		);
		expect(() =>
			createQueryPlugin({ queryClient, maxStoreBytes: Number.NaN }),
		).toThrow('maxStoreBytes');
		expect(() => createQueryPlugin({ queryClient, maxQueries: 1_001 })).toThrow(
			'maxQueries cannot exceed 1000',
		);
		expect(() =>
			createQueryPlugin({ queryClient, maxMutations: 1_001 }),
		).toThrow('maxMutations cannot exceed 1000');
		expect(() =>
			createQueryPlugin({ queryClient, maxSnapshotBytes: 1024 * 1024 + 1 }),
		).toThrow('maxSnapshotBytes cannot exceed 1048576');
		expect(() =>
			createQueryPlugin({ queryClient, maxStoreBytes: 16 * 1024 * 1024 + 1 }),
		).toThrow('maxStoreBytes cannot exceed 16777216');
	});

	it('contains cache refresh failures and recovers on the next refresh', () => {
		const queryClient = new QueryClient();
		queryClient.setQueryData(['ready'], true);
		const plugin = createQueryPlugin({ queryClient });
		const dispose = plugin.install?.();
		const getAll = jest.spyOn(queryClient.getQueryCache(), 'getAll');
		getAll.mockImplementationOnce(() => {
			throw new Error('cache read failed');
		});

		expect(() => plugin.refresh()).not.toThrow();
		expect(plugin.getSnapshot().error).toContain('cache read failed');
		plugin.refresh();
		expect(plugin.getSnapshot().error).toBeUndefined();

		dispose?.();
		queryClient.clear();
	});

	it('rejects unsupported runtime action values', async () => {
		const queryClient = new QueryClient();
		queryClient.setQueryData(['ready'], true);
		const plugin = createQueryPlugin({ queryClient });
		const dispose = plugin.install?.();
		const queryId = plugin.getSnapshot().queries[0]?.hash ?? '';

		await expect(
			plugin.runQueryAction(
				queryId,
				'remove' as Parameters<typeof plugin.runQueryAction>[1],
			),
		).rejects.toThrow('Unsupported query action');

		dispose?.();
		queryClient.clear();
	});

	it('projects host-owned simulation state and delegates typed operations', async () => {
		const release = jest.fn();
		const simulation = createQuerySimulationController([
			{
				id: 'all',
				label: 'All queries',
				operations: { offline: () => ({ release }) },
				unsupportedReasons: {
					loading: 'Loading requires an explicit presentation adapter.',
				},
			},
		]);
		const queryClient = new QueryClient();
		const plugin = createQueryPlugin({ queryClient, simulation });
		const dispose = plugin.install?.();
		const run = await renderPanel(plugin);

		expect(
			screen.getByText('Loading requires an explicit presentation adapter.'),
		).toBeOnTheScreen();
		await fireEvent.press(screen.getByLabelText('Simulate Offline'));
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({ label: 'Simulate query offline' }),
		);

		let active: Awaited<ReturnType<typeof plugin.runSimulation>> | undefined;
		await act(async () => {
			active = await plugin.runSimulation('all', 'offline');
		});
		if (!active) throw new Error('Expected active simulation');
		expect(plugin.getSnapshot().simulation?.active).toEqual(active);
		const receiptId = active.receiptId;
		await act(async () => {
			await plugin.clearSimulation(receiptId);
		});
		expect(release).toHaveBeenCalledTimes(1);

		dispose?.();
		queryClient.clear();
	});

	it('rejects simulation commands when the host did not register an adapter', async () => {
		const queryClient = new QueryClient();
		const plugin = createQueryPlugin({ queryClient });
		await expect(plugin.runSimulation('all', 'offline')).rejects.toThrow(
			'not configured',
		);
		await expect(plugin.clearSimulation('receipt')).rejects.toThrow(
			'not configured',
		);
		queryClient.clear();
	});
});

describe('createMutationSnapshot', () => {
	it('captures mutation metadata and variables without private state APIs', () => {
		const queryClient = new QueryClient({
			defaultOptions: { mutations: { gcTime: Number.POSITIVE_INFINITY } },
		});
		const mutation = queryClient.getMutationCache().build(queryClient, {
			mutationKey: ['save-project'],
			mutationFn: async (variables: { id: string }) => variables,
		});

		const snapshot = createMutationSnapshot(mutation, true, 1024);

		expect(snapshot.key).toContain('save-project');
		expect(snapshot.status).toBe('idle');
		expect(snapshot.id).toBe(mutation.mutationId);
		queryClient.clear();
	});
});

describe('QueryPanel', () => {
	it('keeps cache-wide confirmations on Android', async () => {
		const originalPlatform = Platform.OS;
		Object.defineProperty(Platform, 'OS', {
			configurable: true,
			value: 'android',
		});
		try {
			const queryClient = new QueryClient();
			queryClient.setQueryData(['profile', 'detail'], { ready: true });
			const plugin = createQueryPlugin({ queryClient, captureData: true });
			const dispose = plugin.install?.();
			const run = await renderPanel(plugin);

			await fireEvent.press(screen.getByText('Invalidate all'));
			expect(run).toHaveBeenCalledWith(
				expect.objectContaining({
					confirmation: expect.objectContaining({
						title: 'Invalidate all queries?',
					}),
				}),
			);
			await fireEvent.press(screen.getByText('Clear query cache'));
			expect(run).toHaveBeenCalledWith(
				expect.objectContaining({
					confirmation: expect.objectContaining({ destructive: true }),
				}),
			);
			run.mockClear();
			await fireEvent.press(screen.getByText('detail'));
			expect(screen.getByText('Diagnostic ID')).toBeOnTheScreen();
			expect(screen.getByText(/"ready": true/)).toBeOnTheScreen();
			await fireEvent.press(screen.getByText('Invalidate query'));
			await fireEvent.press(screen.getByText('Refetch query'));
			await fireEvent.press(screen.getByText('Remove query'));
			expect(run).toHaveBeenCalledWith(
				expect.objectContaining({ label: 'Invalidate query' }),
			);
			expect(run).toHaveBeenCalledWith(
				expect.objectContaining({ label: 'Refetch query' }),
			);
			expect(run).toHaveBeenCalledWith(
				expect.objectContaining({
					label: 'Remove query',
					confirmation: expect.objectContaining({ destructive: true }),
				}),
			);

			dispose?.();
			queryClient.clear();
		} finally {
			Object.defineProperty(Platform, 'OS', {
				configurable: true,
				value: originalPlatform,
			});
		}
	});

	it('groups queries by first key segment with a summary header and search', async () => {
		const queryClient = new QueryClient();
		queryClient.setQueryData(['projects', 'list', 'page-12'], { items: [1] });
		queryClient.setQueryData(['projects', 'detail', 'prj_1'], { id: 'prj_1' });
		queryClient.setQueryData(['stats', 'weekly-total'], { total: 3 });
		const plugin = createQueryPlugin({ queryClient });
		const dispose = plugin.install?.();
		await renderPanel(plugin);

		expect(
			screen.getByText('3 CACHED · 0 FETCHING · 0 STALE · 0 ERRORS'),
		).toBeOnTheScreen();
		expect(screen.getByText('projects · 2')).toBeOnTheScreen();
		expect(screen.getByText('stats · 1')).toBeOnTheScreen();
		expect(screen.getByText('list · page-12')).toBeOnTheScreen();
		expect(screen.getByText('weekly-total')).toBeOnTheScreen();
		expect(screen.getAllByText('0 observers · fresh')).toHaveLength(3);

		await fireEvent.changeText(
			screen.getByPlaceholderText('Search query keys'),
			'stats',
		);
		expect(screen.queryByText('projects · 2')).toBeNull();
		expect(screen.getByText('stats · 1')).toBeOnTheScreen();

		dispose?.();
		queryClient.clear();
	});

	it('expands a query row into metadata rows and lazy data previews', async () => {
		const queryClient = new QueryClient();
		queryClient.setQueryData(['home', 'snapshot'], { count: 2 });
		const plugin = createQueryPlugin({ queryClient, captureData: true });
		const dispose = plugin.install?.();
		await renderPanel(plugin);

		expect(screen.queryByText('Hash')).toBeNull();
		await fireEvent.press(screen.getByText('snapshot'));
		expect(screen.getByText('Hash')).toBeOnTheScreen();
		expect(screen.getByText('Status')).toBeOnTheScreen();
		expect(screen.getByText('Fetch status')).toBeOnTheScreen();
		expect(screen.getByText('Observers')).toBeOnTheScreen();
		expect(screen.getByText('Updated at')).toBeOnTheScreen();
		expect(screen.getByText('Failure count')).toBeOnTheScreen();
		expect(screen.getByText('Data')).toBeOnTheScreen();
		expect(screen.getByText(/"count": 2/)).toBeOnTheScreen();

		dispose?.();
		queryClient.clear();
	});

	it('surfaces query errors in the summary, subtitle, and message line', async () => {
		const queryClient = new QueryClient();
		await queryClient.prefetchQuery({
			queryKey: ['stats', 'progression'],
			queryFn: async () => {
				throw new Error('expected number, got null');
			},
			retry: false,
		});
		const plugin = createQueryPlugin({ queryClient });
		const dispose = plugin.install?.();
		await renderPanel(plugin);

		expect(
			screen.getByText('1 CACHED · 0 FETCHING · 1 STALE · 1 ERROR'),
		).toBeOnTheScreen();
		expect(screen.getByText('0 observers · error')).toBeOnTheScreen();
		expect(
			screen.getByText('Error: expected number, got null'),
		).toBeOnTheScreen();

		dispose?.();
		queryClient.clear();
	});

	it('runs row swipe actions through the action service', async () => {
		const queryClient = new QueryClient();
		queryClient.setQueryData(['projects', 'list'], { items: [] });
		const plugin = createQueryPlugin({ queryClient });
		const dispose = plugin.install?.();
		const run = await renderPanel(plugin);

		await fireEvent.press(screen.getByLabelText('Refetch'));
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({
				pluginId: 'queries',
				label: 'Refetch query',
				confirmation: undefined,
			}),
		);
		await fireEvent.press(screen.getByLabelText('Invalidate'));
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({ label: 'Invalidate query' }),
		);
		await fireEvent.press(screen.getByLabelText('Remove'));
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({
				label: 'Remove query',
				confirmation: expect.objectContaining({
					destructive: true,
					title: 'Remove query?',
				}),
			}),
		);

		dispose?.();
		queryClient.clear();
	});

	it('switches to the mutations tab and expands mutation details', async () => {
		const queryClient = new QueryClient({
			defaultOptions: { mutations: { gcTime: Number.POSITIVE_INFINITY } },
		});
		queryClient.getMutationCache().build(queryClient, {
			mutationKey: ['save-project'],
			mutationFn: async (variables: { id: string }) => variables,
		});
		const plugin = createQueryPlugin({ queryClient, captureData: true });
		const dispose = plugin.install?.();
		await renderPanel(plugin);

		await fireEvent.press(screen.getByRole('tab', { name: 'Mutations' }));
		expect(screen.getByPlaceholderText('Search mutations')).toBeOnTheScreen();
		expect(screen.getByText('recent · 1')).toBeOnTheScreen();
		expect(screen.getByText('0 failures')).toBeOnTheScreen();
		await fireEvent.press(screen.getByText('save-project'));
		expect(screen.getByText('Submitted at')).toBeOnTheScreen();
		expect(screen.getByText('Paused')).toBeOnTheScreen();

		dispose?.();
		queryClient.clear();
	});

	it('renders an empty state per tab', async () => {
		const queryClient = new QueryClient();
		const plugin = createQueryPlugin({ queryClient });
		const dispose = plugin.install?.();
		await renderPanel(plugin);

		expect(screen.getByText('No queries to show')).toBeOnTheScreen();
		expect(
			screen.getByText('Query cache activity will appear here.'),
		).toBeOnTheScreen();
		await fireEvent.press(screen.getByRole('tab', { name: 'Mutations' }));
		expect(screen.getByText('No mutations yet')).toBeOnTheScreen();
		expect(
			screen.getByText('Mutation activity will appear here.'),
		).toBeOnTheScreen();

		dispose?.();
	});

	it('offers cache-wide actions with confirmations', async () => {
		const queryClient = new QueryClient();
		const plugin = createQueryPlugin({ queryClient });
		const dispose = plugin.install?.();
		const run = await renderPanel(plugin);

		await fireEvent.press(screen.getByLabelText('Invalidate all'));
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({
				label: 'Invalidate all queries',
				confirmation: expect.objectContaining({
					title: 'Invalidate all queries?',
				}),
			}),
		);
		await fireEvent.press(screen.getByLabelText('Clear query cache'));
		expect(run).toHaveBeenCalledWith(
			expect.objectContaining({
				label: 'Clear query cache',
				confirmation: expect.objectContaining({ destructive: true }),
			}),
		);

		dispose?.();
	});
});

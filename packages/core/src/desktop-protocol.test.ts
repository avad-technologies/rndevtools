import {
	desktopActionCapability,
	parseDesktopActionEnvelope,
	parseDesktopDeviceAction,
	RNDEVTOOLS_PROTOCOL_VERSION,
	RNDEVTOOLS_SUPPORTED_PROTOCOL_VERSIONS,
} from './desktop-protocol';

describe('desktop action protocol', () => {
	it('advertises protocol v2 while retaining v1 compatibility', () => {
		expect(RNDEVTOOLS_PROTOCOL_VERSION).toBe(2);
		expect(RNDEVTOOLS_SUPPORTED_PROTOCOL_VERSIONS).toEqual([1, 2]);
	});

	it.each([
		['network', 'clear', {}],
		['network', 'setProfile', { profileId: '3g' }],
		['network', 'clearProfile', {}],
		['console', 'clear', {}],
		['storage', 'set', { id: 'entry', valueText: 'next' }],
		['storage', 'undo', { id: 'event' }],
		['storage', 'bookmark', { id: 'event' }],
		['query', 'refetch', { id: 'query' }],
		['query', 'invalidate', { id: 'query' }],
		['query', 'simulate', { familyId: 'all-example-queries', mode: 'offline' }],
		['query', 'clearSimulation', { receiptId: 'query-simulation-1' }],
		['routes', 'navigate', { path: '/settings' }],
		['zustand', 'refresh', {}],
		['zustand', 'capture', { storeId: 'dev-menu-store' }],
		[
			'zustand',
			'patch',
			{ storeId: 'dev-menu-store', patchText: '{"showDebugBadges":true}' },
		],
		[
			'zustand',
			'jump',
			{ storeId: 'dev-menu-store', snapshotId: 'zustand-state-1' },
		],
		['restore', 'capture', { label: 'Before repro' }],
		['restore', 'restore', { id: 'point' }],
		['restore', 'restore', { id: 'point', sourceIds: ['developer-overrides'] }],
		['restore', 'resetBaseline', {}],
		['restore', 'rename', { id: 'point', label: 'Before scenario' }],
		['restore', 'duplicate', { id: 'point', label: 'Before scenario copy' }],
		['restore', 'remove', { id: 'point' }],
		[
			'scenarios',
			'execute',
			{ id: 'example.powerUser', version: 1, definitionToken: 'definition-1' },
		],
		[
			'scenarios',
			'execute',
			{
				id: 'example.custom',
				version: 2,
				definitionToken: 'definition-2',
				variables: { account: 'demo', count: 3 },
			},
		],
		['scenarios', 'undo', { receiptId: 'scenario-receipt-1' }],
		[
			'scenarios',
			'discardRecovery',
			{ recoveryError: 'Stored scenario recovery could not be loaded.' },
		],
		['scenarios', 'import', { json: '{"schemaVersion":1}', mode: 'merge' }],
		[
			'scenarios',
			'remove',
			{ id: 'example.custom', version: 2, definitionToken: 'definition-2' },
		],
		['identity', 'start', { personaId: 'power' }],
		['identity', 'stop', {}],
		['performance', 'start', {}],
		['performance', 'stop', {}],
		['components', 'refresh', {}],
		['components', 'highlight', { id: 'target' }],
		['components', 'activate', { id: 'target', screenHash: 'screen-12345678' }],
		['components', 'focus', { id: 'target', screenHash: 'screen-12345678' }],
		[
			'components',
			'setText',
			{ id: 'target', screenHash: 'screen-12345678', text: 'hello' },
		],
		[
			'components',
			'scroll',
			{
				id: 'target',
				screenHash: 'screen-12345678',
				direction: 'down',
				amount: 0.5,
			},
		],
		['components', 'waitForElement', { id: 'target', timeoutMs: 1_000 }],
		[
			'components',
			'waitForScreenChange',
			{ screenHash: 'screen-12345678', timeoutMs: 1_000 },
		],
		['camera', 'clearFixture', {}],
		[
			'camera',
			'setFixture',
			{
				kind: 'still',
				label: 'Example card',
				mimeType: 'image/png',
				dataBase64: 'iVBORw==',
				width: 320,
				height: 240,
			},
		],
	] as const)(
		'accepts the allowlisted %s.%s command',
		(tool, command, payload) => {
			expect(
				parseDesktopDeviceAction({
					actionId: 'action-1',
					deviceId: 'device-1',
					tool,
					command,
					payload,
				}),
			).toMatchObject({ tool, command, payload });
		},
	);

	it('normalizes allowlisted actions and permits an empty storage string', () => {
		expect(
			parseDesktopDeviceAction({
				actionId: ' action-1 ',
				deviceId: ' device-1 ',
				tool: 'storage',
				command: 'set',
				payload: { id: ' storage-1 ', valueText: '' },
			}),
		).toEqual({
			actionId: 'action-1',
			deviceId: 'device-1',
			tool: 'storage',
			command: 'set',
			payload: { id: 'storage-1', valueText: '' },
		});
	});

	it('rejects unsupported commands, extra fields, and malformed payloads', () => {
		const base = {
			actionId: 'action-1',
			deviceId: 'device-1',
			tool: 'network',
			payload: {},
		};
		expect(
			parseDesktopDeviceAction({ ...base, command: 'evaluate' }),
		).toBeNull();
		expect(
			parseDesktopDeviceAction({
				actionId: 'action-1',
				deviceId: 'device-1',
				tool: 'zustand',
				command: 'patch',
				payload: { storeId: 'dev-menu-store' },
			}),
		).toBeNull();
		expect(
			parseDesktopDeviceAction({
				actionId: 'action-1',
				deviceId: 'device-1',
				tool: 'zustand',
				command: 'jump',
				payload: { storeId: 'dev-menu-store', snapshotId: '' },
			}),
		).toBeNull();
		expect(
			parseDesktopDeviceAction({
				actionId: 'action-1',
				deviceId: 'device-1',
				tool: 'query',
				command: 'simulate',
				payload: { familyId: 'all', mode: 'disconnected' },
			}),
		).toBeNull();
		expect(
			parseDesktopDeviceAction({
				actionId: 'action-1',
				deviceId: 'device-1',
				tool: 'query',
				command: 'clearSimulation',
				payload: {},
			}),
		).toBeNull();
		expect(
			parseDesktopDeviceAction({
				actionId: 'action-1',
				deviceId: 'device-1',
				tool: 'camera',
				command: 'setFixture',
				payload: {
					kind: 'still',
					mimeType: 'image/png',
					dataBase64: 'not base64',
					width: 100,
					height: 100,
				},
			}),
		).toBeNull();
		expect(
			parseDesktopDeviceAction({
				actionId: 'action-1',
				deviceId: 'device-1',
				tool: 'camera',
				command: 'setFixture',
				payload: {
					kind: 'unavailable',
					dataBase64: 'iVBORw==',
				},
			}),
		).toBeNull();
		expect(
			parseDesktopDeviceAction({
				...base,
				command: 'setProfile',
				payload: { profileId: 'satellite' },
			}),
		).toBeNull();
		expect(
			parseDesktopDeviceAction({
				actionId: 'action-1',
				deviceId: 'device-1',
				tool: 'components',
				command: 'activate',
				payload: { id: 'target', screenHash: '' },
			}),
		).toBeNull();
		expect(
			parseDesktopDeviceAction({
				actionId: 'action-1',
				deviceId: 'device-1',
				tool: 'components',
				command: 'scroll',
				payload: {
					id: 'target',
					screenHash: 'screen-12345678',
					direction: 'diagonal',
				},
			}),
		).toBeNull();
		expect(
			parseDesktopDeviceAction({ ...base, command: 'clear', unexpected: true }),
		).toBeNull();
		expect(
			parseDesktopDeviceAction({
				...base,
				command: 'clear',
				payload: { unexpected: true },
			}),
		).toBeNull();
		expect(
			parseDesktopDeviceAction({
				actionId: 'action-1',
				deviceId: 'device-1',
				tool: 'routes',
				command: 'navigate',
				payload: { path: `/${'x'.repeat(4 * 1024)}` },
			}),
		).toBeNull();
	});

	it('parses only an exact action envelope and maps capabilities', () => {
		expect(
			parseDesktopActionEnvelope({
				type: 'action',
				action: {
					actionId: 'action-1',
					deviceId: 'device-1',
					tool: 'performance',
					command: 'start',
					payload: {},
				},
			}),
		).toMatchObject({ tool: 'performance', command: 'start' });
		expect(desktopActionCapability('performance', 'stop')).toBe(
			'performance.review',
		);
		expect(desktopActionCapability('components', 'highlight')).toBe(
			'components.highlight',
		);
		expect(desktopActionCapability('query', 'simulate')).toBe('query.simulate');
		expect(desktopActionCapability('scenarios', 'execute')).toBe(
			'scenarios.execute',
		);
		expect(desktopActionCapability('identity', 'stop')).toBe('identity.stop');
		expect(desktopActionCapability('diagnostics', 'clear')).toBeUndefined();
	});

	it('rejects hostile protocol objects instead of throwing', () => {
		const hostile = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error('ownKeys failed');
				},
			},
		);

		expect(() => parseDesktopDeviceAction(hostile)).not.toThrow();
		expect(parseDesktopDeviceAction(hostile)).toBeNull();
		expect(parseDesktopActionEnvelope(hostile)).toBeNull();
	});

	it('rejects accessors without invoking them and applies byte limits', () => {
		const getter = jest.fn(() => 'action-1');
		const action = {
			deviceId: 'device-1',
			tool: 'network',
			command: 'clear',
			payload: {},
		} as Record<string, unknown>;
		Object.defineProperty(action, 'actionId', {
			enumerable: true,
			get: getter,
		});

		expect(parseDesktopDeviceAction(action)).toBeNull();
		expect(getter).not.toHaveBeenCalled();
		expect(
			parseDesktopDeviceAction({
				actionId: 'action-1',
				deviceId: 'device-1',
				tool: 'restore',
				command: 'capture',
				payload: { label: '🏋️'.repeat(1_500) },
			}),
		).toBeNull();
	});

	it('rejects empty, duplicate, and oversized selective restore source lists', () => {
		const action = (sourceIds: readonly string[]) =>
			parseDesktopDeviceAction({
				actionId: 'action-1',
				deviceId: 'device-1',
				tool: 'restore',
				command: 'restore',
				payload: { id: 'point', sourceIds },
			});

		expect(action([])).toBeNull();
		expect(action(['one', 'one'])).toBeNull();
		expect(
			action(Array.from({ length: 51 }, (_, index) => `source-${index}`)),
		).toBeNull();
	});

	it('rejects malformed or oversized scenario variables and imports', () => {
		const action = (payload: Record<string, unknown>) =>
			parseDesktopDeviceAction({
				actionId: 'action-1',
				deviceId: 'device-1',
				tool: 'scenarios',
				command: 'execute',
				payload,
			});

		expect(
			action({
				id: 'scenario',
				version: 1,
				definitionToken: 'definition-1',
				variables: { nested: {} },
			}),
		).toBeNull();
		expect(
			action({
				id: 'scenario',
				version: 1,
				definitionToken: 'definition-1',
				variables: Object.fromEntries(
					Array.from({ length: 26 }, (_, index) => [`value-${index}`, index]),
				),
			}),
		).toBeNull();
		expect(
			parseDesktopDeviceAction({
				actionId: 'action-1',
				deviceId: 'device-1',
				tool: 'scenarios',
				command: 'import',
				payload: { json: 'x'.repeat(512 * 1024 + 1), mode: 'replace' },
			}),
		).toBeNull();
	});
});

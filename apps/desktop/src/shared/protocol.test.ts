import { describe, expect, it } from 'vitest';
import { createDemoDevice } from './demo-data';
import {
	createDesktopStateParser,
	createEmptyDeviceTools,
	DESKTOP_PROTOCOL_VERSION,
	DESKTOP_SUPPORTED_PROTOCOL_VERSIONS,
	type DesktopState,
	type DeviceSession,
	desktopBootstrapSchema,
	desktopStateSchema,
	deviceHelloMessageSchema,
	deviceSnapshotMessageSchema,
} from './protocol';

function desktopState(devices: DeviceSession[]): DesktopState {
	return {
		protocolVersion: DESKTOP_PROTOCOL_VERSION,
		broker: {
			status: 'listening',
			host: '127.0.0.1',
			port: 47931,
			access: 'loopback',
			urls: ['ws://127.0.0.1:47931/device'],
		},
		devices,
		diagnostics: [],
	};
}

function storageEntry(id: string, key: string, valueText: string) {
	return {
		id,
		adapterId: 'standard',
		adapterTitle: 'Standard storage',
		key,
		valueText,
		valueType: 'string' as const,
		bytes: valueText.length,
		sensitive: false,
		editable: true,
	};
}

function storageSnapshot(
	storage: ReturnType<typeof storageEntry>[],
	storageEvents: unknown[]
) {
	return deviceSnapshotMessageSchema.parse({
		type: 'snapshot',
		sequence: 1,
		sentAt: Date.now(),
		tools: { ...createEmptyDeviceTools(), storage, storageEvents },
	}).tools;
}

describe('redaction stays inside the advertised text bounds', () => {
	it('re-parses its own output when redaction expands the text', () => {
		// Redaction lengthens text (`jwt:a` -> `jwt:[REDACTED]`), and Zod applies
		// `.max()` before the transform. Whatever this schema produces is stored by
		// the broker and re-validated by the preload bridge, so an over-long
		// transform output would make the broker's own state unparseable and
		// silently drop every later renderer broadcast.
		const hello = {
			type: 'hello' as const,
			protocolVersion: DESKTOP_PROTOCOL_VERSION,
			device: {
				id: 'device-1',
				name: 'jwt:a,'.repeat(682),
				platform: 'ios' as const,
			},
		};
		const parsed = deviceHelloMessageSchema.parse(hello);
		expect(parsed.device.name).toContain('[REDACTED]');
		expect(parsed.device.name.length).toBeLessThanOrEqual(4 * 1024);
		// The parsed value must itself satisfy the schema it came from.
		expect(() =>
			deviceHelloMessageSchema.parse({ ...hello, device: parsed.device })
		).not.toThrow();
	});
});

describe('desktop IPC and device schemas', () => {
	it('defaults Zustand mutation fields for legacy snapshots', () => {
		const tools = createEmptyDeviceTools();
		const {
			zustandStateSnapshots: _stateSnapshots,
			zustandMutationReceipts: _receipts,
			...legacyTools
		} = tools;
		const parsed = deviceSnapshotMessageSchema.parse({
			type: 'snapshot',
			sequence: 1,
			sentAt: Date.now(),
			tools: {
				...legacyTools,
				zustandStores: [
					{
						id: 'legacy-store',
						title: 'Legacy store',
						stateText: '{}',
						keys: [],
						updatedAt: Date.now(),
					},
				],
			},
		});

		expect(parsed.tools.zustandStateSnapshots).toEqual([]);
		expect(parsed.tools.zustandMutationReceipts).toEqual([]);
		expect(parsed.tools.zustandStores[0]?.capabilities).toEqual({
			writable: false,
			resettable: false,
			persisted: false,
			restorable: false,
		});
	});

	it('accepts both supported hello versions and v2 process metadata', () => {
		expect(DESKTOP_SUPPORTED_PROTOCOL_VERSIONS).toEqual([1, 2]);
		const legacy = deviceHelloMessageSchema.parse({
			type: 'hello',
			protocolVersion: 1,
			device: {
				id: 'legacy-device',
				name: 'Legacy device',
				platform: 'ios',
				capabilities: [],
			},
		});
		expect(legacy.protocolVersion).toBe(1);

		const current = deviceHelloMessageSchema.parse({
			type: 'hello',
			protocolVersion: 2,
			device: {
				id: 'simulator-device',
				name: 'Simulator device',
				platform: 'simulator',
				simulatorUdid: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
				bundleIdentifier: 'com.example.app',
				processId: 1234,
				capabilities: [],
			},
		});
		expect(current.device).toMatchObject({
			simulatorUdid: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
			bundleIdentifier: 'com.example.app',
			processId: 1234,
		});
	});

	it('accepts bounded component hierarchy diagnostics without raw style objects', () => {
		const tools = createEmptyDeviceTools();
		const component = {
			id: 'row-instance-1',
			targetId: 'exercise-row',
			parentId: 'list-instance',
			depth: 2,
			zIndex: 4,
			name: 'Exercise row',
			kind: 'component',
			sourceFiles: [],
			instanceTruncated: false,
			bounds: { x: 10, y: 20, width: 100, height: 44 },
			isFocused: true,
			styleText: '{"display":"flex"}',
			styleTruncated: false,
			actions: ['activate'] as const,
			screenHash: 'screen-12345678',
		};
		const message = {
			type: 'snapshot' as const,
			sequence: 1,
			sentAt: Date.now(),
			tools: {
				...tools,
				components: [component],
				componentRenders: [
					{
						id: 'render-1',
						targetId: 'row-instance-1',
						at: Date.now(),
						phase: 'update' as const,
						actualDuration: 4.2,
						baseDuration: 8,
						startTime: 100,
						commitTime: 105,
						renderCount: 3,
						cause: 'unknown' as const,
						changedKeys: [],
					},
				],
				componentSummary: {
					...tools.componentSummary,
					registrationDiagnostics: [
						{
							code: 'duplicate-target-id' as const,
							targetId: 'exercise-row',
							instanceIds: ['row-instance-1', 'row-instance-2'],
							message: '2 mounted instances share this target id.',
						},
					],
				},
			},
		};

		const parsed = deviceSnapshotMessageSchema.parse(message);
		expect(parsed.tools.components[0]).toMatchObject({
			targetId: 'exercise-row',
			parentId: 'list-instance',
			depth: 2,
			zIndex: 4,
		});
		expect(parsed.tools.componentSummary.registrationDiagnostics).toHaveLength(
			1
		);
		expect(parsed.tools.componentRenders).toEqual([
			expect.objectContaining({
				id: 'render-1',
				targetId: 'row-instance-1',
				cause: 'unknown',
			}),
		]);
		expect(() =>
			deviceSnapshotMessageSchema.parse({
				...message,
				tools: {
					...message.tools,
					components: [{ ...component, styles: { display: 'flex' } }],
				},
			})
		).toThrow();
	});

	it('accepts the complete browser-preview bootstrap', () => {
		const demo = createDemoDevice();
		expect(
			desktopBootstrapSchema.parse({
				state: {
					protocolVersion: DESKTOP_PROTOCOL_VERSION,
					broker: {
						status: 'listening',
						host: '127.0.0.1',
						port: 47931,
						access: 'loopback',
						urls: ['ws://127.0.0.1:47931/device'],
					},
					devices: [demo],
					diagnostics: [],
				},
				platform: 'browser',
				versions: {
					app: '0.1.0',
					electron: 'browser preview',
					chrome: 'test',
					node: 'not available',
				},
			})
		).toMatchObject({ platform: 'browser' });
		expect(demo.tools.querySimulation?.active).toMatchObject({
			familyId: 'all-example-queries',
			mode: 'offline',
		});
	});

	it('rejects inconsistent query simulation snapshots', () => {
		const demo = createDemoDevice();
		const simulation = demo.tools.querySimulation;
		if (!simulation) throw new Error('Expected demo query simulation');
		const family = simulation.families[0];
		if (!family) throw new Error('Expected demo query family');

		expect(() =>
			deviceSnapshotMessageSchema.parse({
				type: 'snapshot',
				sequence: 1,
				sentAt: Date.now(),
				tools: {
					...createEmptyDeviceTools(),
					querySimulation: {
						families: [
							{
								...family,
								modes: family.modes.map(() => family.modes[0]),
							},
						],
						active: simulation.active,
					},
				},
			})
		).toThrow('every mode once');

		expect(() =>
			deviceSnapshotMessageSchema.parse({
				type: 'snapshot',
				sequence: 2,
				sentAt: Date.now(),
				tools: {
					...createEmptyDeviceTools(),
					querySimulation: {
						...simulation,
						active: {
							...simulation.active,
							familyId: 'missing-family',
						},
					},
				},
			})
		).toThrow('supported family mode');
	});

	it('rejects unadvertised capability names', () => {
		expect(() =>
			deviceHelloMessageSchema.parse({
				type: 'hello',
				protocolVersion: DESKTOP_PROTOCOL_VERSION,
				device: {
					id: 'device',
					name: 'Device',
					platform: 'ios',
					capabilities: ['runtime.evaluate'],
				},
			})
		).toThrow();
	});

	it('bounds network header maps before they enter broker state', () => {
		const requestHeaders = Object.fromEntries(
			Array.from({ length: 201 }, (_, index) => [`x-test-${index}`, 'value'])
		);
		expect(() =>
			deviceSnapshotMessageSchema.parse({
				type: 'snapshot',
				sequence: 1,
				sentAt: Date.now(),
				tools: {
					...createEmptyDeviceTools(),
					network: [
						{
							id: 'request',
							at: Date.now(),
							method: 'GET',
							url: 'https://example.test',
							host: 'example.test',
							path: '/',
							state: 'success',
							requestHeaders,
						},
					],
				},
			})
		).toThrow('Header maps');
	});

	it('accepts rich logger metadata while retaining legacy console rows', () => {
		const parsed = deviceSnapshotMessageSchema.parse({
			type: 'snapshot',
			sequence: 1,
			sentAt: Date.now(),
			tools: {
				...createEmptyDeviceTools(),
				console: [
					{
						id: 'legacy',
						at: 100,
						level: 'info',
						message: 'Legacy row',
					},
					{
						id: 'rich',
						at: 250,
						firstAt: 200,
						lastAt: 250,
						level: 'error',
						message: 'Request failed',
						scope: 'network.request',
						correlationId: 'request-42',
						groupId: 'network-error',
						repeatCount: 2,
						errorName: 'NetworkError',
						errorStack: 'NetworkError: request failed',
						sourceLocation: { file: 'client.ts', line: 42, column: 7 },
					},
				],
			},
		});
		expect(parsed.tools.console[0]?.repeatCount).toBeUndefined();
		expect(parsed.tools.console[1]).toMatchObject({
			repeatCount: 2,
			scope: 'network.request',
			correlationId: 'request-42',
		});
	});

	it('accepts correlated navigation phases and rejects invalid duration data', () => {
		const tools = createEmptyDeviceTools();
		const parsed = deviceSnapshotMessageSchema.parse({
			type: 'snapshot',
			sequence: 1,
			sentAt: Date.now(),
			tools: {
				...tools,
				routeEvents: [
					{
						id: 'route-transition-1-focused',
						at: 500,
						route: '/profile',
						transitionId: 'navigation-transition-1',
						phase: 'focused',
						source: 'desktop',
						correlationId: 'desktop-action-7',
						durationMs: 42,
					},
				],
			},
		});
		expect(parsed.tools.routeEvents[0]).toMatchObject({
			phase: 'focused',
			source: 'desktop',
			correlationId: 'desktop-action-7',
			durationMs: 42,
		});

		expect(() =>
			deviceSnapshotMessageSchema.parse({
				type: 'snapshot',
				sequence: 2,
				sentAt: Date.now(),
				tools: {
					...tools,
					routeEvents: [
						{
							id: 'bad-route-transition',
							at: 500,
							route: '/profile',
							phase: 'focused',
							durationMs: -1,
						},
					],
				},
			})
		).toThrow();
	});

	it('defaults legacy camera state and rejects inconsistent fixture metadata', () => {
		const legacy = deviceSnapshotMessageSchema.parse({
			type: 'snapshot',
			sequence: 1,
			sentAt: Date.now(),
			tools: { ...createEmptyDeviceTools(), cameraFixture: undefined },
		});
		expect(legacy.tools.cameraFixture).toEqual({ active: false });

		expect(() =>
			deviceSnapshotMessageSchema.parse({
				type: 'snapshot',
				sequence: 2,
				sentAt: Date.now(),
				tools: {
					...createEmptyDeviceTools(),
					cameraFixture: {
						active: true,
						kind: 'video',
						mimeType: 'image/png',
						bytes: 512,
						width: 100,
						height: 100,
						durationMs: 1_000,
					},
				},
			})
		).toThrow('Camera fixture metadata');
	});

	it('accepts bounded scenario state and defaults it for legacy snapshots', () => {
		const empty = createEmptyDeviceTools();
		const {
			scenarios: _scenarios,
			scenarioRuntime: _runtime,
			scenarioReceipts: _receipts,
			...legacy
		} = empty;
		const legacyParsed = deviceSnapshotMessageSchema.parse({
			type: 'snapshot',
			sequence: 1,
			sentAt: Date.now(),
			tools: legacy,
		});
		expect(legacyParsed.tools.scenarios).toEqual([]);
		expect(legacyParsed.tools.scenarioRuntime).toEqual({ running: false });
		expect(legacyParsed.tools.scenarioReceipts).toEqual([]);

		const parsed = deviceSnapshotMessageSchema.parse({
			type: 'snapshot',
			sequence: 2,
			sentAt: Date.now(),
			tools: {
				...empty,
				scenarios: [
					{
						id: 'example.persona',
						version: 1,
						definitionToken: 'definition-1',
						name: 'Persona',
						bundled: true,
						variables: [],
						preconditionCount: 0,
						steps: [{ id: 'route', type: 'navigation' }],
					},
				],
				scenarioRuntime: {
					running: false,
					active: {
						receiptId: 'receipt-1',
						scenarioId: 'example.persona',
						scenarioVersion: 1,
						scenarioName: 'Persona',
						activatedAt: Date.now(),
						stepCount: 1,
						privileged: false,
						warnings: [],
						recoveryRequired: false,
					},
				},
			},
		});
		expect(parsed.tools.scenarioRuntime.active?.scenarioId).toBe(
			'example.persona'
		);
	});

	it('accepts only redacted identity sessions and defaults legacy snapshots', () => {
		const empty = createEmptyDeviceTools();
		const { identitySession: _identitySession, ...legacy } = empty;
		const legacyParsed = deviceSnapshotMessageSchema.parse({
			type: 'snapshot',
			sequence: 1,
			sentAt: Date.now(),
			tools: legacy,
		});
		expect(legacyParsed.tools.identitySession).toEqual({
			running: false,
			history: [],
			personas: [],
		});

		const tools = {
			...empty,
			identitySession: {
				running: false,
				active: {
					historyId: 'identity-1',
					startedAt: Date.now(),
					actor: { kind: 'account', label: 'Original account' },
					target: {
						kind: 'persona',
						label: 'Frequent user',
						personaId: 'power',
					},
					status: 'active',
				},
				history: [],
				personas: [{ id: 'power', label: 'Frequent user', note: 'Power user' }],
			},
		};
		const parsed = deviceSnapshotMessageSchema.parse({
			type: 'snapshot',
			sequence: 2,
			sentAt: Date.now(),
			tools,
		});
		expect(parsed.tools.identitySession.active?.target.personaId).toBe('power');
		expect(() =>
			deviceSnapshotMessageSchema.parse({
				type: 'snapshot',
				sequence: 3,
				sentAt: Date.now(),
				tools: {
					...tools,
					identitySession: {
						...tools.identitySession,
						active: {
							...tools.identitySession.active,
							accessToken: 'must-never-cross-the-broker',
						},
					},
				},
			})
		).toThrow();
	});

	it('redacts headers and environment values using their sensitive field names', () => {
		const parsed = deviceSnapshotMessageSchema.parse({
			type: 'snapshot',
			sequence: 1,
			sentAt: Date.now(),
			tools: {
				...createEmptyDeviceTools(),
				network: [
					{
						id: 'request',
						at: Date.now(),
						method: 'GET',
						url: 'https://example.test',
						host: 'example.test',
						path: '/',
						state: 'success',
						requestHeaders: {
							Authorization: 'Basic opaque-credential',
							'X-API-Key': 'opaque-api-key',
							Accept: 'application/json',
						},
					},
				],
				environment: [
					{
						id: 'environment-token',
						section: 'Runtime',
						key: 'API_TOKEN',
						valueText: 'opaque-environment-credential',
						status: 'valid',
					},
				],
			},
		});

		expect(parsed.tools.network[0]?.requestHeaders).toEqual({
			Accept: 'application/json',
			Authorization: '[REDACTED]',
			'X-API-Key': '[REDACTED]',
		});
		expect(parsed.tools.environment[0]?.valueText).toBe('[REDACTED]');
	});

	it('rejects timestamps outside the JavaScript Date range', () => {
		const tools = createDemoDevice().tools;
		expect(() =>
			deviceSnapshotMessageSchema.parse({
				type: 'snapshot',
				sequence: 1,
				sentAt: Number.MAX_VALUE,
				tools,
			})
		).toThrow();
	});

	it('requires snapshots to contain every tool projection', () => {
		expect(() =>
			deviceSnapshotMessageSchema.parse({
				type: 'snapshot',
				sequence: 1,
				sentAt: Date.now(),
				tools: { network: [] },
			})
		).toThrow();
	});

	it('rejects unknown fields inside wire entries', () => {
		expect(() =>
			deviceSnapshotMessageSchema.parse({
				type: 'snapshot',
				sequence: 1,
				sentAt: Date.now(),
				tools: {
					...createEmptyDeviceTools(),
					console: [
						{
							id: 'log',
							at: Date.now(),
							level: 'info',
							message: 'hello',
							unexpected: 'not allowed',
						},
					],
				},
			})
		).toThrow();
	});

	it('scrubs values and size metadata from sensitive storage entries', () => {
		const parsed = deviceSnapshotMessageSchema.parse({
			type: 'snapshot',
			sequence: 1,
			sentAt: Date.now(),
			tools: {
				...createEmptyDeviceTools(),
				storage: [
					{
						id: 'secret-entry',
						adapterId: 'secure',
						adapterTitle: 'Secure storage',
						key: 'auth.token',
						valueText: 'must-not-cross-the-boundary',
						valueType: 'hidden',
						bytes: 128,
						sensitive: true,
						editable: true,
					},
					{
						id: 'misclassified-entry',
						adapterId: 'standard',
						adapterTitle: 'Standard storage',
						key: 'legacy.value',
						valueText: 'token=unexpected-secret',
						valueType: 'string',
						bytes: 23,
						sensitive: false,
						editable: true,
					},
				],
				storageEvents: [
					{
						id: 'secret-event',
						at: Date.now(),
						adapterId: 'secure',
						key: 'auth.token',
						kind: 'updated',
						previousText: 'before-secret',
						nextText: 'after-secret',
						structuralDiff: [
							{
								path: '$.token',
								kind: 'changed',
								previousText: 'before-secret',
								nextText: 'after-secret',
							},
						],
					},
				],
			},
		});

		expect(parsed.tools.storage?.[0]).toMatchObject({
			bytes: 0,
			sensitive: true,
			editable: false,
		});
		expect(parsed.tools.storage?.[0]?.valueText).toBeUndefined();
		expect(parsed.tools.storage?.[1]).toMatchObject({
			valueType: 'hidden',
			bytes: 0,
			sensitive: true,
			editable: false,
		});
		expect(parsed.tools.storage?.[1]?.valueText).toBeUndefined();
		expect(parsed.tools.storageEvents?.[0]?.previousText).toBeUndefined();
		expect(parsed.tools.storageEvents?.[0]?.nextText).toBeUndefined();
		expect(parsed.tools.storageEvents?.[0]?.structuralDiff).toBeUndefined();
	});

	it('hides storage values whose keys name a credential', () => {
		const tools = storageSnapshot(
			[
				storageEntry('refresh-token', 'auth.refreshToken', 'q8Zx3kLm9PwT'),
				storageEntry('password', 'user_password', 'hunter2-example'),
				storageEntry('theme', 'appearance/theme', 'dark'),
			],
			[
				{
					id: 'refresh-token-event',
					at: 1,
					adapterId: 'standard',
					key: 'auth.refreshToken',
					kind: 'updated',
					previousText: 'r4Wq9TzX2bLm',
					nextText: 'q8Zx3kLm9PwT',
					structuralDiff: [{ path: '$', kind: 'changed' }],
				},
				{
					id: 'theme-event',
					at: 2,
					adapterId: 'standard',
					key: 'appearance/theme',
					kind: 'updated',
					previousText: 'light',
					nextText: 'dark',
				},
			]
		);

		for (const entry of tools.storage.slice(0, 2)) {
			expect(entry).toMatchObject({
				valueType: 'hidden',
				bytes: 0,
				sensitive: true,
				editable: false,
			});
			expect(entry.valueText).toBeUndefined();
		}
		expect(tools.storage[2]).toMatchObject({
			valueText: 'dark',
			sensitive: false,
			editable: true,
		});
		const [secretEvent, themeEvent] = tools.storageEvents;
		expect(secretEvent?.previousText).toBeUndefined();
		expect(secretEvent?.nextText).toBeUndefined();
		expect(secretEvent?.structuralDiff).toBeUndefined();
		// A hidden key does not take the history of its adapter's other keys.
		expect(themeEvent).toMatchObject({
			previousText: 'light',
			nextText: 'dark',
		});
	});

	it('drops event text for keys the snapshot does not list in clear', () => {
		const tools = storageSnapshot(
			[storageEntry('theme', 'appearance/theme', 'dark')],
			[
				// A secure store emptied on sign-out lists no entries any more.
				{
					id: 'secure-removed',
					at: 1,
					adapterId: 'secure',
					key: 'cached.blob',
					kind: 'removed',
					previousText: 'q8Zr3p0LkV2mXn7Ab9Cd',
				},
				{
					id: 'standard-removed',
					at: 2,
					adapterId: 'standard',
					key: 'legacy.flag',
					kind: 'removed',
					previousText: 'opaque-legacy-value',
				},
				{
					id: 'theme-updated',
					at: 3,
					adapterId: 'standard',
					key: 'appearance/theme',
					kind: 'updated',
					previousText: 'light',
					nextText: 'dark',
				},
			]
		);

		expect(tools.storageEvents.map((event) => event.previousText)).toEqual([
			undefined,
			undefined,
			'light',
		]);
	});

	it('redacts diagnostic strings while preserving explicit pairing URLs', () => {
		const parsed = desktopBootstrapSchema.parse({
			state: {
				protocolVersion: DESKTOP_PROTOCOL_VERSION,
				broker: {
					status: 'listening',
					host: '0.0.0.0',
					port: 47931,
					access: 'token',
					urls: ['ws://192.168.1.10:47931/device?token=pairing-secret'],
				},
				devices: [],
				diagnostics: [
					{
						id: 'diagnostic',
						at: Date.now(),
						level: 'warn',
						scope: 'test',
						message: '{"token":"device-secret"}',
					},
				],
			},
			platform: 'browser',
			versions: {
				app: '0.1.0',
				electron: 'test',
				chrome: 'test',
				node: 'test',
			},
		});

		expect(parsed.state.diagnostics[0]?.message).toBe('{"token":"[REDACTED]"}');
		expect(parsed.state.broker.urls[0]).toContain('token=pairing-secret');
	});
});

describe('desktop state parser', () => {
	function consoleDevice(message: string): DeviceSession {
		return {
			...createDemoDevice(1_800_000_000_000),
			tools: {
				...createEmptyDeviceTools(),
				console: [{ id: 'log', at: 1, level: 'info', message }],
			},
		};
	}

	function messageOf(
		result: ReturnType<ReturnType<typeof createDesktopStateParser>>
	) {
		if (!result.success) throw result.error;
		return result.data.devices[0]?.tools.console[0]?.message;
	}

	it('accepts and returns what the full state schema does', () => {
		const parse = createDesktopStateParser();
		const state = desktopState([createDemoDevice(1_800_000_000_000)]);
		const parsed = parse(state);
		expect(parsed.success && parsed.data).toEqual(
			desktopStateSchema.parse(state)
		);

		const [device] = state.devices;
		if (!device) throw new Error('Expected the demo device');
		const overfull = desktopState([
			{
				...device,
				sequence: device.sequence + 1,
				tools: {
					...device.tools,
					restorePoints: Array.from({ length: 101 }, (_, index) => ({
						id: `point-${index}`,
						label: 'Point',
						createdAt: 1,
						estimatedBytes: 0,
						sources: [],
					})),
				},
			},
		]);
		const rejected = parse(overfull);
		expect(desktopStateSchema.safeParse(overfull).success).toBe(false);
		expect(rejected.success).toBe(false);
		expect(
			rejected.success ? [] : rejected.error.issues.map((issue) => issue.path)
		).toEqual([['devices', 0, 'tools', 'restorePoints']]);

		const badBroker = parse({
			...state,
			broker: { ...state.broker, port: 0 },
		});
		expect(
			badBroker.success ? [] : badBroker.error.issues.map((issue) => issue.path)
		).toEqual([['broker', 'port']]);
	});

	it("parses a device's tools again only when its session or sequence changes", () => {
		const parse = createDesktopStateParser();
		const device = consoleDevice('first');
		expect(messageOf(parse(desktopState([device])))).toBe('first');

		// Main replaces tools only with a higher sequence, so the same id,
		// connectedAt and sequence carry the tools that were already parsed.
		const heartbeat = parse(
			desktopState([
				{ ...consoleDevice('not read again'), lastSeenAt: 1_800_000_000_500 },
			])
		);
		expect(messageOf(heartbeat)).toBe('first');
		expect(heartbeat.success && heartbeat.data.devices[0]?.lastSeenAt).toBe(
			1_800_000_000_500
		);

		const snapshot = {
			...consoleDevice('second'),
			sequence: device.sequence + 1,
		};
		expect(messageOf(parse(desktopState([snapshot])))).toBe('second');

		const reconnected = {
			...consoleDevice('reconnected'),
			connectedAt: device.connectedAt + 1,
			sequence: snapshot.sequence,
		};
		expect(messageOf(parse(desktopState([reconnected])))).toBe('reconnected');

		// A device that left the state is forgotten.
		expect(parse(desktopState([])).success).toBe(true);
		const returned = { ...reconnected, tools: consoleDevice('back').tools };
		expect(messageOf(parse(desktopState([returned])))).toBe('back');
	});
});

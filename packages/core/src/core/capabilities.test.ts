import {
	createDevToolsCapabilityRegistry,
	DEVTOOLS_CAPABILITY_REGISTRY_VERSION,
	type DevToolsRuntimeCapability,
	normalizeDevToolsRuntimeCapability,
} from './capabilities';

function capability(
	overrides: Partial<DevToolsRuntimeCapability> = {},
): DevToolsRuntimeCapability {
	return {
		schemaVersion: DEVTOOLS_CAPABILITY_REGISTRY_VERSION,
		toolId: 'storage',
		version: 2,
		availability: 'available',
		read: ['inspect', 'export'],
		mutate: ['write', 'remove'],
		platform: 'both',
		...overrides,
	};
}

describe('DevTools capability registry', () => {
	it('normalizes bounded capabilities without invoking accessors', () => {
		const getter = jest.fn(() => 'storage');
		const unsafe = Object.defineProperty({}, 'toolId', { get: getter });
		expect(normalizeDevToolsRuntimeCapability(unsafe)).toBeNull();
		expect(getter).not.toHaveBeenCalled();

		expect(
			normalizeDevToolsRuntimeCapability(
				capability({
					read: ['inspect', 'inspect', 'export'],
					reason: 'token=secret-value',
				}),
			),
		).toMatchObject({
			read: ['export', 'inspect'],
			reason: expect.not.stringContaining('secret-value'),
		});
	});

	it('rejects malformed, ambiguous, and unavailable capabilities without reasons', () => {
		expect(
			normalizeDevToolsRuntimeCapability(
				capability({ availability: 'disabled', reason: undefined }),
			),
		).toBeNull();
		expect(
			normalizeDevToolsRuntimeCapability({ ...capability(), extra: true }),
		).toBeNull();
		expect(
			normalizeDevToolsRuntimeCapability(capability({ read: ['bad value'] })),
		).toBeNull();
	});

	it('resolves explicit read and mutation operations with typed failures', () => {
		const registry = createDevToolsCapabilityRegistry([capability()]);
		expect(registry.resolve('storage', 'read', 'inspect')).toMatchObject({
			allowed: true,
			operationKind: 'read',
		});
		expect(registry.resolve('storage', 'mutate', 'inspect')).toMatchObject({
			allowed: false,
			reason: { code: 'unsupported' },
		});
		expect(registry.resolve('missing', 'read', 'inspect')).toMatchObject({
			allowed: false,
			reason: { code: 'unsupported' },
		});
	});

	it('treats degraded capabilities as explicit partial support', () => {
		const registry = createDevToolsCapabilityRegistry([
			capability({
				availability: 'degraded',
				reason: 'Native metrics are unavailable.',
				read: ['js-metrics'],
				mutate: [],
			}),
		]);
		expect(registry.resolve('storage', 'read', 'js-metrics').allowed).toBe(
			true,
		);
		expect(registry.resolve('storage', 'read', 'native-metrics')).toMatchObject(
			{
				allowed: false,
				reason: { code: 'unsupported' },
			},
		);
	});

	it('reconciles atomically, sorts snapshots, and notifies subscribers once', () => {
		const registry = createDevToolsCapabilityRegistry();
		const listener = jest.fn();
		const unsubscribe = registry.subscribe(listener);
		registry.reconcile([
			capability({ toolId: 'zustand' }),
			capability({ toolId: 'network' }),
		]);

		expect(listener).toHaveBeenCalledTimes(1);
		expect(registry.getSnapshot()).toMatchObject({
			revision: 1,
			capabilities: [{ toolId: 'network' }, { toolId: 'zustand' }],
		});
		expect(() =>
			registry.reconcile([
				capability({ toolId: 'network' }),
				capability({ toolId: 'network' }),
			]),
		).toThrow('unique');
		expect(registry.getSnapshot().capabilities).toHaveLength(2);
		unsubscribe();
		registry.reconcile([]);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it('adapts mutation decisions to the shared action policy', () => {
		const registry = createDevToolsCapabilityRegistry([
			capability({
				availability: 'disabled',
				reason: 'Turn on experimental storage mutation.',
			}),
		]);
		expect(registry.toActionCapability('storage', 'write')).toMatchObject({
			id: 'storage.write',
			availability: 'unavailable',
			reason: {
				code: 'disabled',
				message: 'Turn on experimental storage mutation.',
			},
		});
	});
});

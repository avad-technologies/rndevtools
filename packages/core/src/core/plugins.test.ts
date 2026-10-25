import type { DevToolsPillQuickActionOption, DevToolsPlugin } from '../types';
import {
	assertUniquePluginIds,
	groupPlugins,
	hasPillQuickAction,
	isPanelPlugin,
	resolvePillQuickActionOptions,
} from './plugins';

const Panel = () => null;

describe('plugin helpers', () => {
	it('groups plugins by section while preserving declaration order', () => {
		const plugins: DevToolsPlugin[] = [
			{
				id: 'network',
				title: 'Network',
				description: 'Requests',
				systemImage: 'network',
				Panel,
			},
			{
				id: 'feedback',
				title: 'Feedback',
				description: 'Report an issue',
				systemImage: 'exclamationmark.bubble',
				section: 'Example',
				kind: 'action',
				onPress: () => {},
			},
			{
				id: 'queries',
				title: 'Queries',
				description: 'Cache',
				systemImage: 'square.stack.3d.up',
				Panel,
			},
		];

		expect(groupPlugins(plugins)).toEqual([
			{ title: 'Diagnostics', plugins: [plugins[0], plugins[2]] },
			{ title: 'Example', plugins: [plugins[1]] },
		]);
	});

	it('distinguishes panels from actions', () => {
		const panel: DevToolsPlugin = {
			id: 'panel',
			title: 'Panel',
			description: 'Panel',
			systemImage: 'square',
			Panel,
		};
		const action: DevToolsPlugin = {
			id: 'action',
			title: 'Action',
			description: 'Action',
			systemImage: 'bolt',
			kind: 'action',
			onPress: () => {},
		};

		expect(isPanelPlugin(panel)).toBe(true);
		expect(isPanelPlugin(action)).toBe(false);
		expect(hasPillQuickAction(panel)).toBe(false);
	});

	it('rejects duplicate quick-action option identifiers within a plugin', () => {
		const panelPlugin: DevToolsPlugin = {
			id: 'state',
			title: 'State',
			description: 'State overrides',
			systemImage: 'list.bullet',
			Panel,
			pillQuickAction: {
				options: [
					{ id: 'loading', label: 'Loading', action: () => {} },
					{ id: 'loading', label: 'Still loading', action: () => {} },
				],
			},
		};

		expect(() => assertUniquePluginIds([panelPlugin])).toThrow(
			'Duplicate pill quick-action option id for plugin state: loading',
		);
	});

	it('rejects quick-action menus without options', () => {
		const panelPlugin: DevToolsPlugin = {
			id: 'empty-menu',
			title: 'Empty menu',
			description: 'No actions',
			systemImage: 'ellipsis.circle',
			Panel,
			pillQuickAction: { options: [] },
		};

		expect(() => assertUniquePluginIds([panelPlugin])).toThrow(
			'Pill quick actions require at least one option for plugin: empty-menu',
		);
	});

	it('does not execute dynamic option getters during plugin validation', () => {
		const options = jest.fn(() => []);
		const panelPlugin: DevToolsPlugin = {
			id: 'dynamic-menu',
			title: 'Dynamic menu',
			description: 'Runtime options',
			systemImage: 'ellipsis.circle',
			Panel,
			pillQuickAction: { options },
		};

		expect(() => assertUniquePluginIds([panelPlugin])).not.toThrow();
		expect(options).not.toHaveBeenCalled();
	});

	it('rejects option ids reserved for host menu actions', () => {
		const panelPlugin: DevToolsPlugin = {
			id: 'reserved-menu',
			title: 'Reserved menu',
			description: 'Invalid option id',
			systemImage: 'ellipsis.circle',
			Panel,
			pillQuickAction: {
				options: [{ id: '__unpin', label: 'Collision', action: () => {} }],
			},
		};

		expect(() => assertUniquePluginIds([panelPlugin])).toThrow(
			'Reserved pill quick-action option id',
		);
	});

	it('rejects malformed confirmations instead of silently running the action', () => {
		const action = jest.fn();
		const confirmation = {} as Record<string, unknown>;
		const getter = jest.fn(() => 'Delete everything?');
		Object.defineProperty(confirmation, 'title', {
			enumerable: true,
			get: getter,
		});
		const declared = [
			{
				id: 'delete',
				label: 'Delete',
				action,
				confirmation,
			},
		] as unknown as Parameters<typeof resolvePillQuickActionOptions>[0];

		expect(resolvePillQuickActionOptions(declared)).toEqual([]);
		expect(getter).not.toHaveBeenCalled();
	});

	it('detaches validated confirmation data from extension-owned objects', () => {
		const confirmation = { title: 'Continue?', destructive: true };
		const resolved = resolvePillQuickActionOptions([
			{ id: 'continue', label: 'Continue', action: () => {}, confirmation },
		]);
		confirmation.title = 'Changed after capture';

		expect(resolved[0]?.confirmation).toEqual({
			title: 'Continue?',
			destructive: true,
		});
	});

	it('bounds and redacts dynamic option labels before rendering them', () => {
		const resolved = resolvePillQuickActionOptions([
			{
				id: 'inspect',
				label: `email=person@example.com ${'🏋️'.repeat(200)}`,
				action: () => {},
			},
		]);

		expect(resolved[0]?.label).toContain('email=[REDACTED]');
		expect(resolved[0]?.label).not.toContain('person@example.com');
		expect(
			new TextEncoder().encode(resolved[0]?.label).length,
		).toBeLessThanOrEqual(256);
		expect(resolved[0]?.label).not.toContain('\uFFFD');
	});

	it('does not invoke dynamic option-array accessors', () => {
		const getter = jest.fn(() => ({
			id: 'unsafe',
			label: 'Unsafe',
			action: () => {},
		}));
		const options: unknown[] = [];
		Object.defineProperty(options, '0', { get: getter });
		options.length = 1;

		expect(
			resolvePillQuickActionOptions(
				() => options as readonly DevToolsPillQuickActionOption[],
			),
		).toEqual([]);
		expect(getter).not.toHaveBeenCalled();
	});

	it('fails closed for a revoked dynamic option-array proxy', () => {
		const revoked = Proxy.revocable<DevToolsPillQuickActionOption[]>([], {});
		revoked.revoke();

		expect(resolvePillQuickActionOptions(() => revoked.proxy)).toEqual([]);
	});
});

describe('assertUniquePluginIds', () => {
	it('rejects duplicate plugin identifiers', () => {
		const panelPlugin: DevToolsPlugin = {
			id: 'network',
			title: 'Network',
			description: 'Requests',
			systemImage: 'network',
			Panel,
		};
		const duplicate = { ...panelPlugin, id: 'network' };
		expect(() => assertUniquePluginIds([panelPlugin, duplicate])).toThrow(
			'Duplicate developer-tools plugin id: network',
		);
	});

	it('rejects static option-array accessors without invoking them', () => {
		const getter = jest.fn(() => ({
			id: 'unsafe',
			label: 'Unsafe',
			action: () => {},
		}));
		const options: unknown[] = [];
		Object.defineProperty(options, '0', { get: getter });
		options.length = 1;
		const plugin: DevToolsPlugin = {
			id: 'state',
			title: 'State',
			description: 'State',
			systemImage: 'list.bullet',
			Panel,
			pillQuickAction: {
				options: options as readonly DevToolsPillQuickActionOption[],
			},
		};

		expect(() => assertUniquePluginIds([plugin])).toThrow(
			'Invalid pill quick-action option',
		);
		expect(getter).not.toHaveBeenCalled();
	});
});

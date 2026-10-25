import { createActionPlugin, createCustomPlugin } from './custom';

describe('custom plugins', () => {
	it('creates a typed panel plugin from a render function', () => {
		const pillQuickAction = {
			options: [{ id: 'mock', label: 'Mock data', action: () => {} }],
		};
		const plugin = createCustomPlugin({
			id: 'fixtures',
			title: 'Fixtures',
			description: 'Manage fixtures',
			systemImage: 'shippingbox',
			section: 'Application',
			pillQuickAction,
			render: () => null,
		});

		expect(plugin).toMatchObject({
			id: 'fixtures',
			kind: 'panel',
			section: 'Application',
		});
		expect(plugin.Panel).toBeInstanceOf(Function);
		expect(plugin.pillQuickAction).toBe(pillQuickAction);
	});

	it('passes the runtime context to custom actions', () => {
		const action = jest.fn();
		const plugin = createActionPlugin({
			id: 'reseed',
			title: 'Reseed',
			description: 'Reseed fixtures',
			systemImage: 'arrow.clockwise',
			confirmation: { title: 'Reseed fixtures?' },
			action,
		});
		const context = {
			close: jest.fn(),
			presentationMode: 'window' as const,
			setPresentationMode: jest.fn(),
		};

		plugin.onPress(context);

		expect(action).toHaveBeenCalledWith(context);
		expect(plugin.confirmation).toEqual({ title: 'Reseed fixtures?' });
	});
});

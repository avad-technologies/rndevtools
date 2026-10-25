import type { DevToolsPlugin } from '../types';
import { PluginInstallerRegistry } from './plugin-installer-registry';

function plugin(id: string, install: () => () => void): DevToolsPlugin {
	return {
		id,
		title: id,
		description: id,
		systemImage: 'wrench',
		Panel: () => null,
		install,
	};
}

describe('PluginInstallerRegistry', () => {
	it('keeps collectors installed when only the plugin array identity changes', () => {
		const dispose = jest.fn();
		const install = jest.fn(() => dispose);
		const registry = new PluginInstallerRegistry();

		registry.update(true, [plugin('network', install)]);
		registry.update(true, [plugin('network', install)]);

		expect(install).toHaveBeenCalledTimes(1);
		expect(dispose).not.toHaveBeenCalled();
	});

	it('reconciles changed collectors and disposes them when disabled', () => {
		const firstDispose = jest.fn();
		const secondDispose = jest.fn();
		const firstInstall = jest.fn(() => firstDispose);
		const secondInstall = jest.fn(() => secondDispose);
		const registry = new PluginInstallerRegistry();

		registry.update(true, [plugin('network', firstInstall)]);
		registry.update(true, [plugin('network', secondInstall)]);
		registry.update(false, [plugin('network', secondInstall)]);

		expect(firstDispose).toHaveBeenCalledTimes(1);
		expect(secondInstall).toHaveBeenCalledTimes(1);
		expect(secondDispose).toHaveBeenCalledTimes(1);
	});

	it('disposes all collectors in reverse installation order', () => {
		const order: string[] = [];
		const registry = new PluginInstallerRegistry();

		registry.update(true, [
			plugin('network', () => () => order.push('network')),
			plugin('query', () => () => order.push('query')),
		]);
		registry.dispose();

		expect(order).toEqual(['query', 'network']);
	});

	it('isolates collector installation and disposal errors', () => {
		const onError = jest.fn();
		const registry = new PluginInstallerRegistry();
		registry.setErrorHandler(onError);

		registry.update(true, [
			plugin('broken-install', () => {
				throw new Error('install failed');
			}),
			plugin('broken-dispose', () => () => {
				throw new Error('dispose failed');
			}),
		]);
		registry.dispose();

		expect(onError).toHaveBeenCalledTimes(2);
		expect(onError.mock.calls.map((call) => call[1])).toEqual([
			'broken-install',
			'broken-dispose',
		]);
	});

	it('rejects invalid installer return values without poisoning teardown', () => {
		const onError = jest.fn();
		const registry = new PluginInstallerRegistry();
		registry.setErrorHandler(onError);
		const invalidInstall = jest.fn(
			() => undefined,
		) as unknown as () => () => void;

		expect(() =>
			registry.update(true, [plugin('invalid-disposer', invalidInstall)]),
		).not.toThrow();
		expect(() => registry.dispose()).not.toThrow();
		expect(onError).toHaveBeenCalledWith(
			expect.objectContaining({
				message: 'Plugin installer did not return a disposer.',
			}),
			'invalid-disposer',
		);
	});
});

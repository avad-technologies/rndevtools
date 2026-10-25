import type { DevToolsPlugin } from '../types';

type Install = NonNullable<DevToolsPlugin['install']>;

type InstalledPlugin = {
	install: Install;
	dispose: () => void;
};

export class PluginInstallerRegistry {
	private readonly installed = new Map<string, InstalledPlugin>();
	private onError?: (error: unknown, pluginId: string) => void;

	setErrorHandler(
		onError: ((error: unknown, pluginId: string) => void) | undefined,
	): void {
		this.onError = onError;
	}

	private reportError(error: unknown, pluginId: string): void {
		try {
			this.onError?.(error, pluginId);
		} catch {
			// Host reporters are outside the collector lifecycle boundary.
		}
	}

	update(enabled: boolean, plugins: readonly DevToolsPlugin[]): void {
		const nextInstallers = new Map(
			enabled
				? plugins.flatMap((plugin) =>
						plugin.install ? [[plugin.id, plugin.install] as const] : [],
					)
				: [],
		);

		for (const [id, installedPlugin] of this.installed) {
			const nextInstall = nextInstallers.get(id);
			if (!nextInstall || nextInstall !== installedPlugin.install) {
				this.disposePlugin(id, installedPlugin);
				this.installed.delete(id);
			}
		}

		for (const [id, install] of nextInstallers) {
			if (this.installed.has(id)) continue;
			try {
				const dispose = install();
				if (typeof dispose !== 'function') {
					throw new Error('Plugin installer did not return a disposer.');
				}
				this.installed.set(id, { install, dispose });
			} catch (error) {
				this.reportError(error, id);
			}
		}
	}

	dispose(): void {
		for (const [id, installedPlugin] of [
			...this.installed.entries(),
		].reverse()) {
			this.disposePlugin(id, installedPlugin);
		}
		this.installed.clear();
	}

	private disposePlugin(id: string, plugin: InstalledPlugin): void {
		try {
			plugin.dispose();
		} catch (error) {
			this.reportError(error, id);
		}
	}
}

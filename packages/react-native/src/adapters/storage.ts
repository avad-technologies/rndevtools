import type { DevToolsStorageAdapter } from '@rndevtools/core/plugins/storage';

export type AsyncStorageLike = {
	getAllKeys: () => Promise<readonly string[]>;
	getItem: (key: string) => Promise<string | null>;
	setItem: (key: string, value: string) => Promise<void>;
	removeItem: (key: string) => Promise<void>;
	clear: () => Promise<void>;
};

/**
 * Names this module in its errors. A release bundle keeps string literals but
 * drops comments and import paths, so `rndevtools-verify-bundle` looks for
 * this one, and both factories use it so a minifier cannot drop it.
 */
const STORAGE_ADAPTERS_MODULE = '@rndevtools/react-native/adapters/storage';

/** A missing store would otherwise only surface as failed reads in the panel. */
function assertStorage(storage: unknown, factory: string): void {
	if (storage == null) {
		throw new TypeError(
			`${STORAGE_ADAPTERS_MODULE}: ${factory} needs a storage object.`,
		);
	}
}

/**
 * How an adapter is identified in the storage panel. Each registered adapter
 * needs its own `id`, so a host that registers two stores of one kind, such as
 * two AsyncStorage databases, names at least one of them.
 */
export type DevtoolsStorageAdapterOptions = Readonly<{
	id?: string;
	title?: string;
	description?: string;
}>;

export function createAsyncStorageDevtoolsAdapter(
	storage: AsyncStorageLike,
	options: DevtoolsStorageAdapterOptions = {},
): DevToolsStorageAdapter {
	assertStorage(storage, 'createAsyncStorageDevtoolsAdapter');
	return {
		id: options.id ?? 'async-storage',
		title: options.title ?? 'AsyncStorage',
		description:
			options.description ?? 'React Native asynchronous key-value storage',
		capabilities: {
			enumerable: true,
			readable: true,
			writable: true,
			deletable: true,
			clearable: true,
			sensitive: false,
			requiresAuthentication: false,
		},
		getAllKeys: () => storage.getAllKeys(),
		getValue: (key) => storage.getItem(key),
		setValue: (key, value) => storage.setItem(key, String(value)),
		parseValue: (_key, draft) => draft,
		removeValue: (key) => storage.removeItem(key),
		clear: () => storage.clear(),
	};
}

export type SecureStoreManifestEntry = Readonly<{
	key: string;
	description: string;
	requiresAuthentication?: boolean;
	revealable?: boolean;
	options?: Readonly<Record<string, unknown>>;
}>;

export type SecureStoreLike = {
	getItemAsync: (
		key: string,
		options?: Readonly<Record<string, unknown>>,
	) => Promise<string | null>;
};

export function createSecureStoreDevtoolsAdapter(
	storage: SecureStoreLike,
	manifest: readonly SecureStoreManifestEntry[],
	options: DevtoolsStorageAdapterOptions = {},
): DevToolsStorageAdapter {
	assertStorage(storage, 'createSecureStoreDevtoolsAdapter');
	const entries = new Map(manifest.map((entry) => [entry.key, entry]));
	return {
		id: options.id ?? 'secure-store',
		title: options.title ?? 'SecureStore',
		description:
			options.description ??
			'Explicitly registered keychain metadata; values stay on device',
		capabilities: {
			enumerable: false,
			readable: true,
			writable: false,
			deletable: false,
			clearable: false,
			sensitive: true,
			requiresAuthentication: false,
		},
		registeredKeys: manifest.map(
			({ key, description, requiresAuthentication, revealable }) => ({
				key,
				description,
				...(requiresAuthentication ? { requiresAuthentication: true } : {}),
				...(revealable ? { revealable: true } : {}),
			}),
		),
		revealValue: async (key) => {
			const entry = entries.get(key);
			if (!entry) throw new Error('SecureStore key is not registered.');
			if (entry.revealable !== true) {
				throw new Error('SecureStore key is metadata-only.');
			}
			return storage.getItemAsync(key, entry.options);
		},
	};
}

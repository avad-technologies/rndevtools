import {
	type AsyncStorageLike,
	createAsyncStorageDevtoolsAdapter,
	createSecureStoreDevtoolsAdapter,
	type SecureStoreLike,
} from './storage';

describe('storage diagnostic adapters', () => {
	it('maps AsyncStorage through the enumerable writable contract', async () => {
		const storage = {
			getAllKeys: jest.fn(async () => ['theme']),
			getItem: jest.fn(async () => 'dark'),
			setItem: jest.fn(async () => undefined),
			removeItem: jest.fn(async () => undefined),
			clear: jest.fn(async () => undefined),
		};
		const adapter = createAsyncStorageDevtoolsAdapter(storage);

		expect(adapter.capabilities).toMatchObject({
			enumerable: true,
			readable: true,
			writable: true,
		});
		expect(await adapter.getAllKeys?.()).toEqual(['theme']);
		expect(await adapter.getValue?.('theme')).toBe('dark');
		await adapter.setValue?.('theme', 42);
		expect(storage.setItem).toHaveBeenCalledWith('theme', '42');
	});

	it('lists SecureStore manifest metadata without reading until explicit reveal', async () => {
		const getItemAsync = jest.fn(async () => 'protected-value');
		const adapter = createSecureStoreDevtoolsAdapter({ getItemAsync }, [
			{
				key: 'biometric-token',
				description: 'Biometric credential',
				requiresAuthentication: true,
				revealable: true,
				options: { requireAuthentication: true },
			},
		]);

		expect(adapter.capabilities).toMatchObject({
			enumerable: false,
			sensitive: true,
		});
		expect(adapter.registeredKeys).toEqual([
			{
				key: 'biometric-token',
				description: 'Biometric credential',
				requiresAuthentication: true,
				revealable: true,
			},
		]);
		expect(getItemAsync).not.toHaveBeenCalled();
		expect(await adapter.revealValue?.('biometric-token')).toBe(
			'protected-value',
		);
		expect(getItemAsync).toHaveBeenCalledWith('biometric-token', {
			requireAuthentication: true,
		});
	});

	it('keeps registered encryption material metadata-only', async () => {
		const getItemAsync = jest.fn(async () => 'encryption-secret');
		const adapter = createSecureStoreDevtoolsAdapter({ getItemAsync }, [
			{
				key: 'example-mmkv-encryption-key',
				description: 'Encryption material',
			},
		]);

		expect(adapter.registeredKeys).toEqual([
			{
				key: 'example-mmkv-encryption-key',
				description: 'Encryption material',
			},
		]);
		await expect(
			adapter.revealValue?.('example-mmkv-encryption-key'),
		).rejects.toThrow('metadata-only');
		expect(getItemAsync).not.toHaveBeenCalled();
	});

	it('uses neutral ids and lets a host name each store it registers', () => {
		const storage = {
			getAllKeys: jest.fn(async () => []),
			getItem: jest.fn(async () => null),
			setItem: jest.fn(async () => undefined),
			removeItem: jest.fn(async () => undefined),
			clear: jest.fn(async () => undefined),
		};
		const secureStore = { getItemAsync: jest.fn(async () => null) };

		expect(createAsyncStorageDevtoolsAdapter(storage)).toMatchObject({
			id: 'async-storage',
			title: 'AsyncStorage',
		});
		expect(createSecureStoreDevtoolsAdapter(secureStore, [])).toMatchObject({
			id: 'secure-store',
			title: 'SecureStore',
		});
		expect(
			createAsyncStorageDevtoolsAdapter(storage, {
				id: 'offline-cache',
				title: 'Offline cache',
				description: 'Second AsyncStorage database',
			}),
		).toMatchObject({
			id: 'offline-cache',
			title: 'Offline cache',
			description: 'Second AsyncStorage database',
		});
		expect(
			createSecureStoreDevtoolsAdapter(secureStore, [], {
				id: 'device-keychain',
			}),
		).toMatchObject({ id: 'device-keychain', title: 'SecureStore' });
	});

	it('throws when a factory is given no store, naming this module', () => {
		expect(() =>
			createAsyncStorageDevtoolsAdapter(
				undefined as unknown as AsyncStorageLike,
			),
		).toThrow(
			new TypeError(
				'@rndevtools/react-native/adapters/storage: createAsyncStorageDevtoolsAdapter needs a storage object.',
			),
		);
		expect(() =>
			createSecureStoreDevtoolsAdapter(null as unknown as SecureStoreLike, [
				{ key: 'session-token', description: 'Signed-in session' },
			]),
		).toThrow(
			new TypeError(
				'@rndevtools/react-native/adapters/storage: createSecureStoreDevtoolsAdapter needs a storage object.',
			),
		);
	});

	it('rejects reveal attempts for undeclared secure keys', async () => {
		const adapter = createSecureStoreDevtoolsAdapter(
			{ getItemAsync: jest.fn(async () => null) },
			[],
		);
		await expect(adapter.revealValue?.('unknown')).rejects.toThrow(
			'not registered',
		);
	});
});

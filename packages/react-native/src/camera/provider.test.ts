import {
	disableDevtoolsAuthorization,
	setDevtoolsAuthorization,
} from '../authorization';
import { devtoolsCameraProvider } from './provider';

type MockFile = {
	uri: string;
	exists: boolean;
	create: jest.Mock;
	write: jest.Mock;
	info: jest.Mock;
	delete: jest.Mock;
};

const mockFiles: MockFile[] = [];

jest.mock('expo-file-system', () => ({
	Paths: { cache: 'file:///cache' },
	File: jest.fn().mockImplementation((_root: unknown, filename: string) => {
		const file: MockFile = {
			uri: `file:///cache/${filename}`,
			exists: true,
			create: jest.fn(),
			write: jest.fn(),
			info: jest.fn(() => ({ size: 6 })),
			delete: jest.fn(function (this: MockFile) {
				this.exists = false;
			}),
		};
		mockFiles.push(file);
		return file;
	}),
}));

describe('devtoolsCameraProvider', () => {
	beforeEach(async () => {
		setDevtoolsAuthorization({ enabled: true, ownerId: 'camera-owner' });
		await devtoolsCameraProvider.clearDebugFixture();
		mockFiles.length = 0;
	});

	afterEach(() => {
		disableDevtoolsAuthorization();
	});

	it('materializes a bounded image and bypasses the real camera', async () => {
		await devtoolsCameraProvider.setDebugFixture({
			kind: 'qr',
			label: 'Login QR',
			mimeType: 'image/png',
			dataBase64: 'iVBORw==',
			width: 320,
			height: 240,
		});
		const realCamera = jest.fn();

		const result = await devtoolsCameraProvider.launchCameraAsync(
			{ launchCameraAsync: realCamera },
			{ mediaTypes: ['images'], base64: true },
		);

		expect(realCamera).not.toHaveBeenCalled();
		expect(result).toEqual({
			canceled: false,
			assets: [
				expect.objectContaining({
					uri: 'file:///cache/rndevtools-debug-camera-1.png',
					width: 320,
					height: 240,
					type: 'image',
					mimeType: 'image/png',
					base64: 'iVBORw==',
				}),
			],
		});
		expect(devtoolsCameraProvider.getDebugFixtureSnapshot()).toEqual({
			active: true,
			kind: 'qr',
			label: 'Login QR',
			mimeType: 'image/png',
			bytes: 6,
			width: 320,
			height: 240,
		});
	});

	it('supports deterministic unavailable and error fixtures', async () => {
		await devtoolsCameraProvider.setDebugFixture({ kind: 'unavailable' });
		await expect(
			devtoolsCameraProvider.launchCameraAsync({
				launchCameraAsync: jest.fn(),
			}),
		).rejects.toMatchObject({ name: 'DebugCameraUnavailableError' });

		await devtoolsCameraProvider.setDebugFixture({
			kind: 'error',
			errorMessage: 'Synthetic scan failure',
		});
		await expect(
			devtoolsCameraProvider.launchCameraAsync({
				launchCameraAsync: jest.fn(),
			}),
		).rejects.toMatchObject({
			name: 'DebugCameraFixtureError',
			message: 'Synthetic scan failure',
		});
	});

	it('clears media when authorization is disabled or changes owner', async () => {
		await devtoolsCameraProvider.setDebugFixture({
			kind: 'still',
			mimeType: 'image/jpeg',
			dataBase64: '/9j/2Q==',
			width: 10,
			height: 10,
		});
		const file = mockFiles[0];

		setDevtoolsAuthorization({ enabled: true, ownerId: 'another-owner' });

		expect(file?.delete).toHaveBeenCalledTimes(1);
		expect(devtoolsCameraProvider.getDebugFixtureSnapshot()).toEqual({
			active: false,
		});
	});

	it('falls through to the real camera without an active fixture', async () => {
		const expected = { canceled: true, assets: null } as const;
		const realCamera = jest.fn().mockResolvedValue(expected);

		await expect(
			devtoolsCameraProvider.launchCameraAsync({
				launchCameraAsync: realCamera,
			}),
		).resolves.toBe(expected);
		expect(realCamera).toHaveBeenCalledWith(undefined);
	});
});

import type { ImageOverlaySourceInput } from '@rndevtools/core/plugins/image-overlay';
import { fetch as expoFetch } from 'expo/fetch';

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
// The overlay and its import helper take their controller and validators from
// the overlay's own core subpath. The plugins barrel pulls in every panel, so
// this factory throws if either module reaches it.
jest.mock('@rndevtools/core/plugins', () => {
	throw new Error(
		'./diagnostics/image-overlay loaded the @rndevtools/core/plugins barrel.',
	);
});

type ImageOverlayModule = typeof import('./image-overlay');

const remoteSource: ImageOverlaySourceInput = {
	kind: 'remote',
	uri: 'https://designs.example.com/reference.png',
	renderUri: 'file:///cache/reference.png',
	mimeType: 'image/png',
	bytes: 1_024,
	width: 390,
	height: 844,
};

function loadImageOverlay(): ImageOverlayModule {
	let loaded: ImageOverlayModule | undefined;
	jest.isolateModules(() => {
		loaded = require('./image-overlay') as ImageOverlayModule;
	});
	if (!loaded) throw new Error('image-overlay did not load');
	return loaded;
}

describe('image overlay remote hosts', () => {
	const savedEnv = { ...process.env };

	beforeEach(() => {
		jest.mocked(expoFetch).mockReset();
	});

	afterEach(() => {
		process.env = { ...savedEnv };
	});

	it('allows no remote host by default, whatever the app environment holds', async () => {
		process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://project.example.com';
		process.env.EXPO_PUBLIC_IMAGE_OVERLAY_ORIGIN =
			'https://designs.example.com';
		const overlay = loadImageOverlay();

		expect(overlay.RNDEVTOOLS_IMAGE_OVERLAY_LIMITS.allowedRemoteHosts).toEqual(
			[],
		);
		expect(() => overlay.imageOverlay.setSource(remoteSource)).toThrow(
			'not allowlisted',
		);
		await expect(
			overlay.setRemoteImageOverlaySource(
				'https://project.example.com/storage/v1/object/public/a.png',
			),
		).rejects.toThrow('not allowlisted');
		expect(expoFetch).not.toHaveBeenCalled();
	});

	it('takes hosts from an explicit option as hostnames or HTTPS URLs', () => {
		const overlay = loadImageOverlay();
		overlay.configureImageOverlay({
			allowedRemoteHosts: [
				'https://Designs.Example.com/figma/export',
				'cdn.example.com',
				'cdn.example.com',
				undefined,
				'  ',
				'http://insecure.example.com',
				'not a host%',
			],
		});

		const hosts = overlay.RNDEVTOOLS_IMAGE_OVERLAY_LIMITS.allowedRemoteHosts;
		expect(hosts).toEqual(['designs.example.com', 'cdn.example.com']);
		expect(Object.isFrozen(hosts)).toBe(true);
		overlay.imageOverlay.setSource(remoteSource);
		expect(overlay.imageOverlay.getSnapshot().source?.uri).toBe(
			remoteSource.uri,
		);
	});

	it('replaces the allowlist on every call', () => {
		const overlay = loadImageOverlay();
		overlay.configureImageOverlay({
			allowedRemoteHosts: ['designs.example.com'],
		});
		overlay.configureImageOverlay({ allowedRemoteHosts: ['cdn.example.com'] });
		expect(overlay.RNDEVTOOLS_IMAGE_OVERLAY_LIMITS.allowedRemoteHosts).toEqual([
			'cdn.example.com',
		]);
		expect(() => overlay.imageOverlay.setSource(remoteSource)).toThrow(
			'not allowlisted',
		);

		overlay.configureImageOverlay({});
		expect(overlay.RNDEVTOOLS_IMAGE_OVERLAY_LIMITS.allowedRemoteHosts).toEqual(
			[],
		);
	});
});

describe('image overlay entry point', () => {
	it('drives the overlay without the core plugins barrel', () => {
		const overlay = loadImageOverlay();
		overlay.setLocalImageOverlaySource({
			kind: 'file',
			uri: 'file:///cache/reference.png',
			mimeType: 'image/png',
			bytes: 1_024,
			width: 390,
			height: 844,
		});
		expect(overlay.imageOverlay.getSnapshot().source?.kind).toBe('file');

		overlay.clearImageOverlay();
		expect(overlay.imageOverlay.getSnapshot().source).toBeUndefined();
	});
});

import type { DesktopCameraFixtureSnapshot } from '@rndevtools/core/desktop-protocol';
import { File, Paths } from 'expo-file-system';
import type {
	ImagePickerAsset,
	ImagePickerOptions,
	ImagePickerResult,
} from 'expo-image-picker';
import {
	getDevtoolsAuthorization,
	subscribeToDevtoolsAuthorization,
} from '../authorization';
import type {
	DebugCameraFixture,
	DevtoolsCameraPicker,
	DevtoolsCameraProvider,
} from './contract';

const MAX_FIXTURE_BASE64_LENGTH = 512 * 1024;
const MAX_DIMENSION = 16_384;
const MAX_VIDEO_DURATION_MS = 10 * 60 * 1_000;

type ActiveMediaFixture = Extract<
	DebugCameraFixture,
	{ kind: 'still' | 'qr' | 'video' }
> & {
	file: File;
	bytes: number;
	revision: number;
};

type ActiveFixture =
	| ActiveMediaFixture
	| (Extract<DebugCameraFixture, { kind: 'unavailable' | 'error' }> & {
			revision: number;
	  });

let activeFixture: ActiveFixture | null = null;
let fixtureRevision = 0;
let authorizationOwnerId = getDevtoolsAuthorization().ownerId;

function assertAuthorized(): void {
	if (!__DEV__ || !getDevtoolsAuthorization().enabled) {
		throw new Error(
			'Debug camera fixtures require an authorized development session.',
		);
	}
}

function assertBoundedFixture(fixture: DebugCameraFixture): void {
	if (fixture.kind === 'unavailable') return;
	if (fixture.kind === 'error') {
		if (
			!fixture.errorMessage.trim() ||
			fixture.errorMessage.length > 4 * 1024
		) {
			throw new Error('Debug camera error text is invalid.');
		}
		return;
	}
	if (
		fixture.dataBase64.length === 0 ||
		fixture.dataBase64.length > MAX_FIXTURE_BASE64_LENGTH ||
		fixture.dataBase64.length % 4 !== 0 ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(fixture.dataBase64)
	) {
		throw new Error('Debug camera fixture data is invalid.');
	}
	if (
		!Number.isSafeInteger(fixture.width) ||
		!Number.isSafeInteger(fixture.height) ||
		fixture.width <= 0 ||
		fixture.height <= 0 ||
		fixture.width > MAX_DIMENSION ||
		fixture.height > MAX_DIMENSION
	) {
		throw new Error('Debug camera fixture dimensions are invalid.');
	}
	if (
		fixture.kind === 'video' &&
		(!Number.isSafeInteger(fixture.durationMs) ||
			(fixture.durationMs ?? 0) <= 0 ||
			(fixture.durationMs ?? 0) > MAX_VIDEO_DURATION_MS)
	) {
		throw new Error('Debug camera video duration is invalid.');
	}
}

function fixtureBytes(base64: string): number {
	const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
	return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function extensionForFixture(fixture: Pick<ActiveMediaFixture, 'mimeType'>) {
	if (fixture.mimeType === 'image/jpeg') return 'jpg';
	if (fixture.mimeType === 'image/png') return 'png';
	if (fixture.mimeType === 'image/webp') return 'webp';
	if (fixture.mimeType === 'video/quicktime') return 'mov';
	return 'mp4';
}

function safeLabel(label: string | undefined, fallback: string): string {
	const normalized = (label ?? fallback)
		.normalize('NFKC')
		.replaceAll(/[^A-Za-z0-9._-]+/g, '-')
		.replaceAll(/^[._-]+|[._-]+$/g, '')
		.slice(0, 80);
	return normalized || fallback;
}

function deleteFixtureFile(fixture: ActiveFixture | null): void {
	if (!fixture || !('file' in fixture)) return;
	try {
		if (fixture.file.exists) fixture.file.delete();
	} catch {
		// Cache cleanup is best-effort and never exposes a path or fixture payload.
	}
}

function clearFixtureWithoutAuthorization(): void {
	const previous = activeFixture;
	activeFixture = null;
	deleteFixtureFile(previous);
}

subscribeToDevtoolsAuthorization(() => {
	const authorization = getDevtoolsAuthorization();
	if (
		!authorization.enabled ||
		authorization.ownerId !== authorizationOwnerId
	) {
		clearFixtureWithoutAuthorization();
	}
	authorizationOwnerId = authorization.ownerId;
});

async function setDebugFixture(fixture: DebugCameraFixture): Promise<void> {
	assertAuthorized();
	assertBoundedFixture(fixture);
	const revision = fixtureRevision + 1;
	if (fixture.kind === 'unavailable' || fixture.kind === 'error') {
		const previous = activeFixture;
		activeFixture = { ...fixture, revision };
		fixtureRevision = revision;
		deleteFixtureFile(previous);
		return;
	}

	const filename = `rndevtools-debug-camera-${revision}.${extensionForFixture(fixture)}`;
	const file = new File(Paths.cache, filename);
	try {
		file.create({ overwrite: true });
		file.write(fixture.dataBase64, { encoding: 'base64' });
		const info = file.info();
		const bytes = info.size ?? fixtureBytes(fixture.dataBase64);
		if (bytes <= 0 || bytes > (MAX_FIXTURE_BASE64_LENGTH * 3) / 4) {
			throw new Error('Debug camera fixture file size is invalid.');
		}
		const previous = activeFixture;
		activeFixture = { ...fixture, file, bytes, revision };
		fixtureRevision = revision;
		deleteFixtureFile(previous);
	} catch (error) {
		try {
			if (file.exists) file.delete();
		} catch {
			// Preserve the original bounded fixture error.
		}
		throw error;
	}
}

async function clearDebugFixture(): Promise<void> {
	assertAuthorized();
	clearFixtureWithoutAuthorization();
}

function getDebugFixtureSnapshot(): DesktopCameraFixtureSnapshot {
	if (!__DEV__ || !getDevtoolsAuthorization().enabled || !activeFixture) {
		return { active: false };
	}
	const fixture = activeFixture;
	if (!('file' in fixture)) {
		return {
			active: true,
			kind: fixture.kind,
			...(fixture.label ? { label: fixture.label } : {}),
		};
	}
	return {
		active: true,
		kind: fixture.kind,
		...(fixture.label ? { label: fixture.label } : {}),
		mimeType: fixture.mimeType,
		bytes: fixture.bytes,
		width: fixture.width,
		height: fixture.height,
		...(fixture.durationMs ? { durationMs: fixture.durationMs } : {}),
	};
}

function acceptsVideo(options: ImagePickerOptions | undefined): boolean {
	return options?.mediaTypes?.includes('videos') ?? false;
}

async function fixtureAsset(
	fixture: ActiveMediaFixture,
	options: ImagePickerOptions | undefined,
): Promise<ImagePickerAsset> {
	if (!fixture.file.exists) {
		throw new Error('The debug camera fixture is no longer available.');
	}
	const video = fixture.kind === 'video';
	if (video && !acceptsVideo(options)) {
		throw new Error(
			'The active debug camera fixture is a video, but this camera flow accepts images only.',
		);
	}
	if (
		!video &&
		options?.mediaTypes?.length === 1 &&
		options.mediaTypes[0] === 'videos'
	) {
		throw new Error(
			'The active debug camera fixture is an image, but this camera flow accepts videos only.',
		);
	}
	return {
		assetId: `rndevtools-debug-camera-${fixture.revision}`,
		uri: fixture.file.uri,
		width: fixture.width,
		height: fixture.height,
		type: video ? 'video' : 'image',
		fileName: `${safeLabel(fixture.label, fixture.kind)}.${extensionForFixture(fixture)}`,
		fileSize: fixture.bytes,
		mimeType: fixture.mimeType,
		...(video && fixture.durationMs ? { duration: fixture.durationMs } : {}),
		...(options?.base64 ? { base64: fixture.dataBase64 } : {}),
	};
}

async function launchCameraAsync(
	picker: DevtoolsCameraPicker,
	options?: ImagePickerOptions,
): Promise<ImagePickerResult> {
	const authorization = getDevtoolsAuthorization();
	const fixture = __DEV__ && authorization.enabled ? activeFixture : null;
	if (!fixture) return picker.launchCameraAsync(options);
	if (fixture.kind === 'unavailable') {
		const error = new Error(
			'The debug camera provider is configured as unavailable.',
		);
		error.name = 'DebugCameraUnavailableError';
		throw error;
	}
	if (fixture.kind === 'error') {
		const error = new Error(fixture.errorMessage);
		error.name = 'DebugCameraFixtureError';
		throw error;
	}
	return { canceled: false, assets: [await fixtureAsset(fixture, options)] };
}

export const devtoolsCameraProvider: DevtoolsCameraProvider = Object.freeze({
	launchCameraAsync,
	setDebugFixture,
	clearDebugFixture,
	getDebugFixtureSnapshot,
});

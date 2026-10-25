import type {
	DesktopCameraFixtureKind,
	DesktopCameraFixtureSnapshot,
} from '@rndevtools/core/desktop-protocol';
import type { ImagePickerOptions, ImagePickerResult } from 'expo-image-picker';

export type DevtoolsCameraPicker = {
	launchCameraAsync: (
		options?: ImagePickerOptions,
	) => Promise<ImagePickerResult>;
};

type MediaFixture = {
	kind: Extract<DesktopCameraFixtureKind, 'still' | 'qr' | 'video'>;
	label?: string;
	mimeType:
		| 'image/jpeg'
		| 'image/png'
		| 'image/webp'
		| 'video/mp4'
		| 'video/quicktime';
	dataBase64: string;
	width: number;
	height: number;
	durationMs?: number;
};

export type DebugCameraFixture =
	| MediaFixture
	| { kind: 'unavailable'; label?: string }
	| { kind: 'error'; label?: string; errorMessage: string };

export type DevtoolsCameraProvider = {
	launchCameraAsync: (
		picker: DevtoolsCameraPicker,
		options?: ImagePickerOptions,
	) => Promise<ImagePickerResult>;
	setDebugFixture: (fixture: DebugCameraFixture) => Promise<void>;
	clearDebugFixture: () => Promise<void>;
	getDebugFixtureSnapshot: () => DesktopCameraFixtureSnapshot;
};

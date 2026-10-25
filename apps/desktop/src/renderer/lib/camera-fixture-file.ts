// A picked file turned into a camera fixture, shared by the Camera panel and
// the recipe Camera fixture step. Each caller keeps its own order of checks.

const MAX_FIXTURE_BYTES = 384 * 1024;
const MAX_ENCODED_FIXTURE_BYTES = 512 * 1024;
export const IMAGE_MIME_TYPES = [
	'image/jpeg',
	'image/png',
	'image/webp',
] as const;
export const VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime'] as const;

export function assertFixtureSize(file: File): void {
	if (file.size === 0 || file.size > MAX_FIXTURE_BYTES) {
		throw new Error('Choose a non-empty fixture no larger than 384 KiB.');
	}
}

/** The file's bytes as base64, refused when they outgrow the envelope. */
export async function readFixtureBase64(
	file: File,
	envelope: 'action' | 'recipe'
): Promise<string> {
	const dataBase64 = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () =>
			reject(new Error('The selected fixture could not be read.'));
		reader.onload = () => {
			const result = reader.result;
			if (typeof result !== 'string') {
				reject(new Error('The selected fixture produced an invalid payload.'));
				return;
			}
			const separator = result.indexOf(',');
			if (separator < 0) {
				reject(new Error('The selected fixture produced an invalid data URL.'));
				return;
			}
			resolve(result.slice(separator + 1));
		};
		reader.readAsDataURL(file);
	});
	if (
		new TextEncoder().encode(dataBase64).byteLength > MAX_ENCODED_FIXTURE_BYTES
	) {
		throw new Error(
			`The encoded fixture exceeds the 512 KiB ${envelope} envelope.`
		);
	}
	return dataBase64;
}

export async function inspectImageFixture(
	file: File
): Promise<{ width: number; height: number }> {
	if (
		!IMAGE_MIME_TYPES.includes(file.type as (typeof IMAGE_MIME_TYPES)[number])
	) {
		throw new Error('Still and QR fixtures must be JPEG, PNG, or WebP images.');
	}
	const bitmap = await createImageBitmap(file);
	try {
		return { width: bitmap.width, height: bitmap.height };
	} finally {
		bitmap.close();
	}
}

export async function inspectVideoFixture(
	file: File
): Promise<{ width: number; height: number; durationMs: number }> {
	if (
		!VIDEO_MIME_TYPES.includes(file.type as (typeof VIDEO_MIME_TYPES)[number])
	) {
		throw new Error('Video fixtures must be MP4 or QuickTime files.');
	}
	const objectUrl = URL.createObjectURL(file);
	try {
		return await new Promise((resolve, reject) => {
			const video = document.createElement('video');
			video.preload = 'metadata';
			video.onerror = () =>
				reject(new Error('Video metadata could not be decoded.'));
			video.onloadedmetadata = () => {
				const durationMs = Math.round(video.duration * 1_000);
				if (video.videoWidth <= 0 || video.videoHeight <= 0) {
					reject(
						new Error('The selected video does not report valid dimensions.')
					);
					return;
				}
				if (
					!Number.isFinite(durationMs) ||
					durationMs <= 0 ||
					durationMs > 600_000
				) {
					reject(new Error('Choose a video between 1 ms and 10 minutes.'));
					return;
				}
				resolve({
					width: video.videoWidth,
					height: video.videoHeight,
					durationMs,
				});
			};
			video.src = objectUrl;
		});
	} finally {
		URL.revokeObjectURL(objectUrl);
	}
}

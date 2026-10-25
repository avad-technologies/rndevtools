import type {
	ImageOverlayLimits,
	ImageOverlaySource,
} from '@rndevtools/core/plugins/image-overlay';
import {
	validateImageOverlayRemoteUrl,
	validateImageOverlaySource,
} from '@rndevtools/core/plugins/image-overlay';
import { fetch as expoFetch } from 'expo/fetch';
import { File, Paths } from 'expo-file-system';

const REMOTE_IMAGE_TIMEOUT_MS = 15_000;
const JPEG_SOF_MARKERS = new Set([
	0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

type VerifiedImageMetadata = Readonly<{
	mimeType: ImageOverlaySource['mimeType'];
	width: number;
	height: number;
}>;

type RemoteFetchResponse = Pick<
	Response,
	'body' | 'headers' | 'ok' | 'redirected' | 'status' | 'url'
>;

export type RemoteImageFetcher = (
	url: string,
	init: RequestInit,
) => Promise<RemoteFetchResponse>;

export type PreparedRemoteImage = Readonly<{
	source: ImageOverlaySource;
	file: File;
}>;

function readUint24LittleEndian(view: DataView, offset: number): number {
	return view.getUint16(offset, true) + view.getUint8(offset + 2) * 65_536;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
	return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function inspectPng(bytes: Uint8Array): VerifiedImageMetadata | null {
	if (
		bytes.length < 24 ||
		bytes[0] !== 0x89 ||
		ascii(bytes, 1, 3) !== 'PNG' ||
		bytes[4] !== 0x0d ||
		bytes[5] !== 0x0a ||
		bytes[6] !== 0x1a ||
		bytes[7] !== 0x0a ||
		ascii(bytes, 12, 4) !== 'IHDR'
	) {
		return null;
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return {
		mimeType: 'image/png',
		width: view.getUint32(16),
		height: view.getUint32(20),
	};
}

function inspectJpeg(bytes: Uint8Array): VerifiedImageMetadata | null {
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = 2;
	while (offset + 3 < bytes.length) {
		while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
		if (offset >= bytes.length) break;
		const marker = view.getUint8(offset);
		offset += 1;
		if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
		if (marker === 0xd9 || marker === 0xda || offset + 1 >= bytes.length) break;
		const segmentLength = view.getUint16(offset);
		if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
		if (JPEG_SOF_MARKERS.has(marker) && segmentLength >= 7) {
			return {
				mimeType: 'image/jpeg',
				height: view.getUint16(offset + 3),
				width: view.getUint16(offset + 5),
			};
		}
		offset += segmentLength;
	}
	return null;
}

function inspectWebp(bytes: Uint8Array): VerifiedImageMetadata | null {
	if (
		bytes.length < 20 ||
		ascii(bytes, 0, 4) !== 'RIFF' ||
		ascii(bytes, 8, 4) !== 'WEBP'
	) {
		return null;
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let offset = 12;
	while (offset + 8 <= bytes.length) {
		const chunk = ascii(bytes, offset, 4);
		const chunkSize = view.getUint32(offset + 4, true);
		const payload = offset + 8;
		if (chunkSize > bytes.length - payload) return null;
		if (chunk === 'VP8X' && chunkSize >= 10) {
			return {
				mimeType: 'image/webp',
				width: readUint24LittleEndian(view, payload + 4) + 1,
				height: readUint24LittleEndian(view, payload + 7) + 1,
			};
		}
		if (chunk === 'VP8L' && chunkSize >= 5 && bytes[payload] === 0x2f) {
			const b1 = view.getUint8(payload + 1);
			const b2 = view.getUint8(payload + 2);
			const b3 = view.getUint8(payload + 3);
			const b4 = view.getUint8(payload + 4);
			return {
				mimeType: 'image/webp',
				width: 1 + (((b2 & 0x3f) << 8) | b1),
				height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
			};
		}
		if (
			chunk === 'VP8 ' &&
			chunkSize >= 10 &&
			bytes[payload + 3] === 0x9d &&
			bytes[payload + 4] === 0x01 &&
			bytes[payload + 5] === 0x2a
		) {
			return {
				mimeType: 'image/webp',
				width: view.getUint16(payload + 6, true) & 0x3fff,
				height: view.getUint16(payload + 8, true) & 0x3fff,
			};
		}
		offset = payload + chunkSize + (chunkSize % 2);
	}
	return null;
}

export function inspectReferenceImageBytes(
	bytes: Uint8Array,
): VerifiedImageMetadata {
	const metadata =
		inspectPng(bytes) ?? inspectJpeg(bytes) ?? inspectWebp(bytes);
	if (!metadata || metadata.width <= 0 || metadata.height <= 0) {
		throw new Error(
			'Remote reference is not a valid PNG, JPEG, or WebP image.',
		);
	}
	return metadata;
}

function parseContentLength(value: string | null, maximum: number): void {
	if (value === null) return;
	if (!/^\d+$/.test(value)) {
		throw new Error('Remote reference reported an invalid content length.');
	}
	const bytes = Number(value);
	if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > maximum) {
		throw new Error(`Remote reference cannot exceed ${maximum} bytes.`);
	}
}

export async function fetchBoundedRemoteImage(
	inputUrl: string,
	limits: ImageOverlayLimits,
	fetcher: RemoteImageFetcher = expoFetch,
): Promise<
	Readonly<{ bytes: Uint8Array; sourceUrl: string }> & VerifiedImageMetadata
> {
	const sourceUrl = validateImageOverlayRemoteUrl(inputUrl.trim(), limits);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REMOTE_IMAGE_TIMEOUT_MS);
	try {
		const response = await fetcher(sourceUrl, {
			credentials: 'omit',
			headers: { Accept: 'image/png,image/jpeg,image/webp' },
			redirect: 'error',
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`Remote reference request failed (${response.status}).`);
		}
		if (response.redirected) {
			throw new Error('Remote reference redirects are not allowed.');
		}
		if (response.url) validateImageOverlayRemoteUrl(response.url, limits);
		parseContentLength(response.headers.get('content-length'), limits.maxBytes);
		const reader = response.body?.getReader();
		if (!reader)
			throw new Error('Remote reference response body is unavailable.');
		const chunks: Uint8Array[] = [];
		let byteCount = 0;
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			if (!result.value) continue;
			byteCount += result.value.byteLength;
			if (byteCount > limits.maxBytes) {
				controller.abort();
				await reader.cancel().catch(() => undefined);
				throw new Error(
					`Remote reference cannot exceed ${limits.maxBytes} bytes.`,
				);
			}
			chunks.push(result.value);
		}
		if (byteCount <= 0) throw new Error('Remote reference image is empty.');
		const bytes = new Uint8Array(byteCount);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return { bytes, sourceUrl, ...inspectReferenceImageBytes(bytes) };
	} finally {
		clearTimeout(timeout);
	}
}

let remoteFileSequence = 0;

export async function prepareRemoteImageOverlay(
	url: string,
	limits: ImageOverlayLimits,
): Promise<PreparedRemoteImage> {
	const fetched = await fetchBoundedRemoteImage(url, limits);
	const extension =
		fetched.mimeType === 'image/png'
			? 'png'
			: fetched.mimeType === 'image/webp'
				? 'webp'
				: 'jpg';
	remoteFileSequence += 1;
	const file = new File(
		Paths.cache,
		`rndevtools-reference-${Date.now()}-${remoteFileSequence}.${extension}`,
	);
	try {
		file.create({ overwrite: false });
		file.write(fetched.bytes);
		if (file.size !== fetched.bytes.byteLength) {
			throw new Error('Remote reference cache write was incomplete.');
		}
		const source = validateImageOverlaySource(
			{
				kind: 'remote',
				uri: fetched.sourceUrl,
				renderUri: file.uri,
				mimeType: fetched.mimeType,
				bytes: fetched.bytes.byteLength,
				width: fetched.width,
				height: fetched.height,
			},
			limits,
		);
		return { source, file };
	} catch (error) {
		try {
			if (file.exists) file.delete();
		} catch {
			// Preserve the bounded import error.
		}
		throw error;
	}
}

export function deletePreparedRemoteImage(
	prepared: PreparedRemoteImage | null,
): void {
	if (!prepared) return;
	try {
		if (prepared.file.exists) prepared.file.delete();
	} catch {
		// The image is in an app-owned cache; cleanup remains best-effort.
	}
}

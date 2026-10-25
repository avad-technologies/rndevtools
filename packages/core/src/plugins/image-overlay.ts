import { ExternalStore } from '../core/external-store';
import { assertPositiveInteger } from '../core/options';

export type ImageOverlayFit = 'contain' | 'cover' | 'stretch';
export type ImageOverlaySourceKind = 'file' | 'clipboard' | 'remote';

export type ImageOverlaySourceInput = Readonly<{
	kind: ImageOverlaySourceKind;
	uri: string;
	/** A bounded app-cache URI used to render a verified remote image. */
	renderUri?: string;
	mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
	bytes: number;
	width: number;
	height: number;
}>;

export type ImageOverlaySource = ImageOverlaySourceInput;

export type ImageOverlayState = Readonly<{
	source?: ImageOverlaySource;
	opacity: number;
	scale: number;
	offsetX: number;
	offsetY: number;
	flipX: boolean;
	flipY: boolean;
	locked: boolean;
	outline: boolean;
	anchorTargetId?: string;
	fit: ImageOverlayFit;
}>;

export type ImageOverlayPatch = Partial<
	Omit<ImageOverlayState, 'source' | 'anchorTargetId'>
> &
	Readonly<{ anchorTargetId?: string | null }>;

export type ImageOverlayController = Readonly<{
	getSnapshot: () => ImageOverlayState;
	getServerSnapshot: () => ImageOverlayState;
	subscribe: (listener: () => void) => () => void;
	setSource: (source: ImageOverlaySourceInput) => void;
	patch: (patch: ImageOverlayPatch) => void;
	clear: () => void;
}>;

export type ImageOverlayLimits = Readonly<{
	maxBytes: number;
	maxDimension: number;
	maxPixels: number;
	allowedRemoteHosts?: readonly string[];
}>;

const DEFAULT_STATE: ImageOverlayState = Object.freeze({
	opacity: 0.5,
	scale: 1,
	offsetX: 0,
	offsetY: 0,
	flipX: false,
	flipY: false,
	locked: true,
	outline: false,
	fit: 'contain',
});
const FITS = new Set<ImageOverlayFit>(['contain', 'cover', 'stretch']);
const SOURCE_KINDS = new Set<ImageOverlaySourceKind>([
	'file',
	'clipboard',
	'remote',
]);
const MIME_TYPES = new Set<ImageOverlaySourceInput['mimeType']>([
	'image/jpeg',
	'image/png',
	'image/webp',
]);

function boundedFinite(
	value: unknown,
	minimum: number,
	maximum: number,
	name: string,
): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new Error(`${name} must be finite.`);
	}
	return Math.min(maximum, Math.max(minimum, value));
}

function optionalBoolean(
	value: unknown,
	current: boolean,
	name: string,
): boolean {
	if (value === undefined) return current;
	if (typeof value !== 'boolean') throw new Error(`${name} must be boolean.`);
	return value;
}

export function validateImageOverlayRemoteUrl(
	uri: string,
	limits: ImageOverlayLimits,
): string {
	if (typeof uri !== 'string' || uri.length > 16_384) {
		throw new Error('Reference image URL is invalid.');
	}
	let url: URL;
	try {
		url = new URL(uri);
	} catch {
		throw new Error('Reference image URL is invalid.');
	}
	if (url.protocol !== 'https:') {
		throw new Error('Remote reference images require HTTPS.');
	}
	if (url.username || url.password) {
		throw new Error('Remote reference image URLs cannot contain credentials.');
	}
	const host = url.hostname.toLowerCase();
	const allowed = new Set(
		(limits.allowedRemoteHosts ?? []).map((value) =>
			value.trim().toLowerCase(),
		),
	);
	if (!allowed.has(host)) {
		throw new Error(`Remote reference image host is not allowlisted: ${host}`);
	}
	return url.toString();
}

export function validateImageOverlaySource(
	input: ImageOverlaySourceInput,
	limits: ImageOverlayLimits,
): ImageOverlaySource {
	assertPositiveInteger(limits.maxBytes, 'maxBytes');
	assertPositiveInteger(limits.maxDimension, 'maxDimension');
	assertPositiveInteger(limits.maxPixels, 'maxPixels');
	if (!input || typeof input !== 'object') {
		throw new Error('Reference image metadata is required.');
	}
	if (!SOURCE_KINDS.has(input.kind)) {
		throw new Error('Reference image source kind is unsupported.');
	}
	if (!MIME_TYPES.has(input.mimeType)) {
		throw new Error('Reference image type is unsupported.');
	}
	if (
		!Number.isSafeInteger(input.bytes) ||
		input.bytes <= 0 ||
		input.bytes > limits.maxBytes
	) {
		throw new Error(`Reference image cannot exceed ${limits.maxBytes} bytes.`);
	}
	if (
		!Number.isSafeInteger(input.width) ||
		!Number.isSafeInteger(input.height) ||
		input.width <= 0 ||
		input.height <= 0 ||
		input.width > limits.maxDimension ||
		input.height > limits.maxDimension ||
		input.width * input.height > limits.maxPixels
	) {
		throw new Error(
			'Reference image dimensions exceed the safe decode budget.',
		);
	}
	if (typeof input.uri !== 'string') {
		throw new Error('Reference image URI is invalid.');
	}
	const uri = input.uri.trim();
	if (uri.length === 0 || uri.length > limits.maxBytes * 2) {
		throw new Error('Reference image URI is invalid.');
	}
	if (input.kind === 'remote') {
		validateImageOverlayRemoteUrl(uri, limits);
		if (
			typeof input.renderUri !== 'string' ||
			!input.renderUri.startsWith('file:')
		) {
			throw new Error('Remote reference images require a verified cache file.');
		}
	} else if (input.renderUri !== undefined) {
		throw new Error('Local reference images cannot define a render override.');
	} else if (
		input.kind === 'file' &&
		!uri.startsWith('file:') &&
		!uri.startsWith('content:')
	) {
		throw new Error('File reference images require a file or content URI.');
	} else if (
		input.kind === 'clipboard' &&
		!uri.startsWith(`data:${input.mimeType};base64,`)
	) {
		throw new Error(
			'Clipboard reference images require a matching base64 URI.',
		);
	}
	return Object.freeze({
		...input,
		uri,
		...(input.renderUri ? { renderUri: input.renderUri.trim() } : {}),
	});
}

export function createImageOverlayController(
	limits: ImageOverlayLimits,
): ImageOverlayController {
	const store = new ExternalStore<ImageOverlayState>(DEFAULT_STATE);
	return {
		getSnapshot: store.getSnapshot,
		getServerSnapshot: store.getServerSnapshot,
		subscribe: store.subscribe,
		setSource: (source) => {
			store.set({
				...store.getSnapshot(),
				source: validateImageOverlaySource(source, limits),
			});
		},
		patch: (patch) => {
			const current = store.getSnapshot();
			const { anchorTargetId: _anchorTargetId, ...currentWithoutAnchor } =
				current;
			const next: ImageOverlayState = {
				...currentWithoutAnchor,
				opacity:
					patch.opacity === undefined
						? current.opacity
						: boundedFinite(patch.opacity, 0.05, 1, 'opacity'),
				scale:
					patch.scale === undefined
						? current.scale
						: boundedFinite(patch.scale, 0.1, 5, 'scale'),
				offsetX:
					patch.offsetX === undefined
						? current.offsetX
						: boundedFinite(patch.offsetX, -5_000, 5_000, 'offsetX'),
				offsetY:
					patch.offsetY === undefined
						? current.offsetY
						: boundedFinite(patch.offsetY, -5_000, 5_000, 'offsetY'),
				flipX: optionalBoolean(patch.flipX, current.flipX, 'flipX'),
				flipY: optionalBoolean(patch.flipY, current.flipY, 'flipY'),
				locked: optionalBoolean(patch.locked, current.locked, 'locked'),
				outline: optionalBoolean(patch.outline, current.outline, 'outline'),
				fit: patch.fit === undefined ? current.fit : patch.fit,
				...(patch.anchorTargetId === undefined
					? current.anchorTargetId
						? { anchorTargetId: current.anchorTargetId }
						: {}
					: patch.anchorTargetId?.trim()
						? { anchorTargetId: patch.anchorTargetId.trim().slice(0, 256) }
						: {}),
			};
			if (!FITS.has(next.fit))
				throw new Error('Reference image fit is invalid.');
			store.set(Object.freeze(next));
		},
		clear: () => store.set(DEFAULT_STATE),
	};
}

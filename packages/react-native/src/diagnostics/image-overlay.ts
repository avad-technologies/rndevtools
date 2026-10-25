import {
	createImageOverlayController,
	type ImageOverlaySourceInput,
} from '@rndevtools/core/plugins/image-overlay';
import {
	deletePreparedRemoteImage,
	type PreparedRemoteImage,
	prepareRemoteImageOverlay,
} from './image-overlay-import';

export type ImageOverlayOptions = Readonly<{
	/**
	 * Hosts that remote reference images may be downloaded from, as hostnames
	 * or HTTPS URLs (an app can pass its own storage URL). Unset, blank, and
	 * non-HTTPS entries are ignored. Defaults to none, which refuses every
	 * remote reference.
	 */
	allowedRemoteHosts?: readonly (string | null | undefined)[];
}>;

function remoteHost(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	try {
		const url = new URL(
			trimmed.includes('://') ? trimmed : `https://${trimmed}`,
		);
		return url.protocol === 'https:' ? url.hostname.toLowerCase() : undefined;
	} catch {
		return undefined;
	}
}

let allowedRemoteHosts: readonly string[] = Object.freeze([]);

export const RNDEVTOOLS_IMAGE_OVERLAY_LIMITS = Object.freeze({
	maxBytes: 20 * 1024 * 1024,
	maxDimension: 8_192,
	maxPixels: 40_000_000,
	// Read on every validation, so the controller sees later configuration.
	get allowedRemoteHosts(): readonly string[] {
		return allowedRemoteHosts;
	},
});

export const imageOverlay = createImageOverlayController(
	RNDEVTOOLS_IMAGE_OVERLAY_LIMITS,
);

/**
 * Replaces the image overlay options. Later remote imports use the new
 * allowlist; an image already on screen stays until it is replaced.
 */
export function configureImageOverlay(options: ImageOverlayOptions): void {
	const hosts = (options.allowedRemoteHosts ?? [])
		.map(remoteHost)
		.filter((host): host is string => host !== undefined);
	allowedRemoteHosts = Object.freeze([...new Set(hosts)]);
}

let remoteImportGeneration = 0;
let activeRemoteImage: PreparedRemoteImage | null = null;

export function setLocalImageOverlaySource(
	source: ImageOverlaySourceInput,
): void {
	remoteImportGeneration += 1;
	imageOverlay.setSource(source);
	const previous = activeRemoteImage;
	activeRemoteImage = null;
	deletePreparedRemoteImage(previous);
}

export async function setRemoteImageOverlaySource(url: string): Promise<void> {
	remoteImportGeneration += 1;
	const generation = remoteImportGeneration;
	const prepared = await prepareRemoteImageOverlay(
		url,
		RNDEVTOOLS_IMAGE_OVERLAY_LIMITS,
	);
	if (generation !== remoteImportGeneration) {
		deletePreparedRemoteImage(prepared);
		return;
	}
	try {
		imageOverlay.setSource(prepared.source);
	} catch (error) {
		deletePreparedRemoteImage(prepared);
		throw error;
	}
	const previous = activeRemoteImage;
	activeRemoteImage = prepared;
	deletePreparedRemoteImage(previous);
}

export function clearImageOverlay(): void {
	remoteImportGeneration += 1;
	imageOverlay.clear();
	const previous = activeRemoteImage;
	activeRemoteImage = null;
	deletePreparedRemoteImage(previous);
}

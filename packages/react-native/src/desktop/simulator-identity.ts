/**
 * Container paths contain the CoreSimulator UDID. Reading an existing path
 * links the connected app to its Simulator and lane without private APIs.
 */

const SIMULATOR_DEVICE_PATH =
	/\/CoreSimulator\/Devices\/([0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12})\//i;

/**
 * Extracts the Simulator UDID from a container path or `file://` URI. Returns
 * `undefined` on a physical device, on Android, or for any path that does not
 * come from a CoreSimulator device set.
 */
export function simulatorUdidFromPath(
	pathOrUri: string | null | undefined,
): string | undefined {
	if (!pathOrUri || pathOrUri.length > 4_096) return undefined;
	let decoded = pathOrUri;
	try {
		decoded = decodeURIComponent(pathOrUri);
	} catch {
		// A path with a stray percent sign is still worth matching verbatim.
	}
	const match = SIMULATOR_DEVICE_PATH.exec(decoded);
	return match?.[1]?.toUpperCase();
}

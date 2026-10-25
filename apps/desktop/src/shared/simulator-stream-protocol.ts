import { z } from 'zod';
import { UDID_PATTERN } from './simulator-protocol';

/**
 * Live Simulator screens.
 *
 * Apple exposes no public streaming API for the Simulator window, and a
 * long-lived capture session cannot be made crash-safe inside the one-request
 * native helper. Live screens therefore come from bounded, main-owned
 * `simctl io <udid> screenshot` polling: one short-lived process per frame,
 * written to a private temporary file, downscaled with Electron's own image
 * codec, and pushed to the renderer as JPEG bytes. Nothing here opens a
 * network listener or persists a frame.
 *
 * Measured on an M4 Pro with an iOS 26.5 iPhone 17 Pro: a full-resolution JPEG
 * capture costs ~180 ms and ~290 KiB; four concurrent captures finish in
 * ~250 ms. The qualities below trade that against how many tiles a wall shows.
 */

const MAX_SUBSCRIPTIONS = 32;
export const SIMULATOR_STREAM_MAX_FRAME_BYTES = 2 * 1024 * 1024;

const simulatorStreamUdidSchema = z.string().regex(UDID_PATTERN);

/**
 * `tile` is for the device wall: small, cheap, a few frames a second. `focus`
 * is for the single device the operator is looking at: full width of the pane,
 * polled as fast as simctl allows.
 */
const simulatorStreamQualitySchema = z.enum(['tile', 'focus']);
export type SimulatorStreamQuality = z.infer<
	typeof simulatorStreamQualitySchema
>;

export const SIMULATOR_STREAM_PROFILES: Record<
	SimulatorStreamQuality,
	{ intervalMs: number; maxWidth: number; jpegQuality: number }
> = {
	tile: { intervalMs: 1_000, maxWidth: 360, jpegQuality: 70 },
	focus: { intervalMs: 250, maxWidth: 900, jpegQuality: 82 },
};

const simulatorStreamSubscriptionSchema = z.strictObject({
	udid: simulatorStreamUdidSchema,
	quality: simulatorStreamQualitySchema,
});
export type SimulatorStreamSubscription = z.infer<
	typeof simulatorStreamSubscriptionSchema
>;

/**
 * The renderer declares the complete set of screens it currently shows. Main
 * diffs that against its running pollers, so a tile that scrolls out of view
 * or a window that loses focus stops costing anything without a per-tile
 * unsubscribe round trip.
 */
export const simulatorStreamSubscriptionsSchema = z
	.array(simulatorStreamSubscriptionSchema)
	.max(MAX_SUBSCRIPTIONS)
	.refine(
		(items) =>
			new Set(items.map((item) => item.udid.toUpperCase())).size ===
			items.length,
		{ message: 'Each Simulator may be subscribed once.' }
	);

export const simulatorStreamFrameSchema = z.strictObject({
	udid: simulatorStreamUdidSchema,
	quality: simulatorStreamQualitySchema,
	/**
	 * Monotonic per poller and counted from 1, so a late frame never overwrites
	 * a newer one. A quality change restarts the poller and its count; every new
	 * poller is announced with a `starting` status before its first frame.
	 */
	sequence: z.number().int().nonnegative(),
	capturedAt: z.number().finite().nonnegative(),
	width: z.number().int().positive().max(8_192),
	height: z.number().int().positive().max(8_192),
	mimeType: z.literal('image/jpeg'),
	/** How long the capture process ran; shown as a quality hint. */
	captureMs: z.number().int().nonnegative(),
});
export type SimulatorStreamFrame = z.infer<typeof simulatorStreamFrameSchema>;

export const simulatorStreamStatusSchema = z.strictObject({
	udid: simulatorStreamUdidSchema,
	status: z.enum(['starting', 'live', 'stalled', 'stopped']),
	/** Present when the last capture failed; the renderer keeps the last frame. */
	error: z
		.string()
		.max(4 * 1024)
		.optional(),
	consecutiveFailures: z.number().int().nonnegative(),
	updatedAt: z.number().finite().nonnegative(),
});
export type SimulatorStreamStatus = z.infer<typeof simulatorStreamStatusSchema>;

export type SimulatorStreamBridge = {
	setSimulatorStreamSubscriptions: (
		subscriptions: readonly SimulatorStreamSubscription[]
	) => Promise<void>;
	subscribeSimulatorStreamFrames: (
		listener: (frame: SimulatorStreamFrame, bytes: Uint8Array) => void
	) => () => void;
	subscribeSimulatorStreamStatus: (
		listener: (status: SimulatorStreamStatus) => void
	) => () => void;
};

/**
 * Pollers back off after repeated failures so a Simulator that is shutting
 * down does not pin a core with 4 failing simctl spawns a second.
 */
export function simulatorStreamRetryDelayMs(
	consecutiveFailures: number,
	baseIntervalMs: number
): number {
	if (consecutiveFailures <= 0) return baseIntervalMs;
	return Math.min(
		10_000,
		baseIntervalMs * 2 ** Math.min(consecutiveFailures, 5)
	);
}

/** Fits an image inside `maxWidth` while keeping its aspect ratio. */
export function simulatorStreamTargetSize(
	width: number,
	height: number,
	maxWidth: number
): { width: number; height: number } {
	if (width <= maxWidth || width <= 0 || height <= 0) return { width, height };
	const scale = maxWidth / width;
	return {
		width: maxWidth,
		height: Math.max(1, Math.round(height * scale)),
	};
}

/**
 * Diffs the renderer's desired set against the running pollers. Quality
 * changes count as a restart so a tile that becomes the focused device
 * immediately gets the sharper, faster profile.
 */
export function diffSimulatorStreamSubscriptions(
	current: ReadonlyMap<string, SimulatorStreamQuality>,
	desired: readonly SimulatorStreamSubscription[]
): {
	start: SimulatorStreamSubscription[];
	stop: string[];
} {
	const wanted = new Map(
		desired.map((item) => [item.udid.toUpperCase(), item.quality])
	);
	const start: SimulatorStreamSubscription[] = [];
	const stop: string[] = [];
	for (const [udid, quality] of wanted) {
		if (current.get(udid) !== quality) start.push({ udid, quality });
	}
	for (const udid of current.keys()) {
		if (!wanted.has(udid)) stop.push(udid);
	}
	return { start, stop };
}

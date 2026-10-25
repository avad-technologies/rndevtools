import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import {
	diffSimulatorStreamSubscriptions,
	SIMULATOR_STREAM_MAX_FRAME_BYTES,
	SIMULATOR_STREAM_PROFILES,
	type SimulatorStreamFrame,
	type SimulatorStreamQuality,
	type SimulatorStreamStatus,
	type SimulatorStreamSubscription,
	simulatorStreamRetryDelayMs,
	simulatorStreamSubscriptionsSchema,
	simulatorStreamTargetSize,
} from '../shared/simulator-stream-protocol';
import { safeErrorText } from './security';
import {
	runSimulatorCommand,
	type SimulatorCommandOptions,
	type SimulatorCommandResult,
} from './simulator-command-runner';

const XCRUN_PATH = '/usr/bin/xcrun';
const CAPTURE_TIMEOUT_MS = 8_000;
const STALLED_AFTER_FAILURES = 3;

/**
 * Downscales and re-encodes a captured frame. Electron's nativeImage is the
 * production implementation; tests inject a stub so the service stays
 * runnable under Node.
 */
export type SimulatorFrameEncoder = (
	jpegBytes: Buffer,
	maxWidth: number,
	jpegQuality: number
) => Promise<{ bytes: Buffer; width: number; height: number }>;

export type SimulatorStreamListener = (
	frame: SimulatorStreamFrame,
	bytes: Uint8Array
) => void;
export type SimulatorStreamStatusListener = (
	status: SimulatorStreamStatus
) => void;

type Poller = {
	udid: string;
	quality: SimulatorStreamQuality;
	controller: AbortController;
	sequence: number;
	consecutiveFailures: number;
	timer: NodeJS.Timeout | undefined;
	inFlight: boolean;
	status: SimulatorStreamStatus['status'];
};

/**
 * Bounded live screens through `simctl io screenshot`. One short-lived process
 * per frame, one private temporary file per capture, one poller per
 * subscribed Simulator. The renderer declares the full set of screens it
 * shows; anything not in that set stops polling, so hidden tiles and blurred
 * windows cost nothing.
 *
 * Xcode 26's simctl treats `-` as a literal file name rather than stdout, so
 * frames go through a 0700 temporary directory owned by this process and are
 * deleted as soon as they are read.
 */
export class SimulatorStreamService {
	readonly #run: (
		executable: string,
		args: readonly string[],
		options?: SimulatorCommandOptions
	) => Promise<SimulatorCommandResult>;
	readonly #encode: SimulatorFrameEncoder;
	readonly #frameDirectory: string;
	readonly #now: () => number;
	readonly #pollers = new Map<string, Poller>();
	readonly #frameListeners = new Set<SimulatorStreamListener>();
	readonly #statusListeners = new Set<SimulatorStreamStatusListener>();
	#paused = false;
	#stopped = false;
	#ready: Promise<void> | undefined;

	constructor({
		frameDirectory,
		encode,
		run = runSimulatorCommand,
		now = Date.now,
	}: {
		frameDirectory: string;
		encode: SimulatorFrameEncoder;
		run?: typeof runSimulatorCommand;
		now?: () => number;
	}) {
		this.#frameDirectory = path.resolve(frameDirectory);
		this.#encode = encode;
		this.#run = run;
		this.#now = now;
	}

	subscribeFrames(listener: SimulatorStreamListener): () => void {
		this.#frameListeners.add(listener);
		return () => this.#frameListeners.delete(listener);
	}

	subscribeStatus(listener: SimulatorStreamStatusListener): () => void {
		this.#statusListeners.add(listener);
		return () => this.#statusListeners.delete(listener);
	}

	/** Snapshot of running pollers, for tests and diagnostics. */
	activeSubscriptions(): SimulatorStreamSubscription[] {
		return [...this.#pollers.values()].map((poller) => ({
			udid: poller.udid,
			quality: poller.quality,
		}));
	}

	/**
	 * Replaces the desired set. Called whenever the renderer's visible tiles
	 * change; cheap to call often because unchanged pollers are left alone.
	 */
	async setSubscriptions(value: unknown): Promise<void> {
		if (this.#stopped) return;
		const desired = simulatorStreamSubscriptionsSchema.parse(value);
		const current = new Map(
			[...this.#pollers.values()].map((poller) => [poller.udid, poller.quality])
		);
		const { start, stop } = diffSimulatorStreamSubscriptions(current, desired);
		for (const udid of stop) this.#stopPoller(udid, 'stopped');
		for (const subscription of start) {
			this.#stopPoller(subscription.udid, 'stopped', { silent: true });
			this.#startPoller(subscription);
		}
	}

	/**
	 * Pausing keeps subscriptions but stops spawning captures, for a hidden or
	 * blurred window. Resuming schedules the next frame immediately.
	 */
	setPaused(paused: boolean): void {
		if (this.#paused === paused) return;
		this.#paused = paused;
		for (const poller of this.#pollers.values()) {
			if (paused) {
				if (poller.timer) clearTimeout(poller.timer);
				poller.timer = undefined;
			} else {
				this.#schedule(poller, 0);
			}
		}
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		for (const udid of [...this.#pollers.keys()]) {
			this.#stopPoller(udid, 'stopped', { silent: true });
		}
		await rm(this.#frameDirectory, { recursive: true, force: true }).catch(
			() => undefined
		);
	}

	#startPoller(subscription: SimulatorStreamSubscription): void {
		const udid = subscription.udid.toUpperCase();
		const poller: Poller = {
			udid,
			quality: subscription.quality,
			controller: new AbortController(),
			sequence: 0,
			consecutiveFailures: 0,
			timer: undefined,
			inFlight: false,
			status: 'starting',
		};
		this.#pollers.set(udid, poller);
		this.#emitStatus(poller);
		if (!this.#paused) this.#schedule(poller, 0);
	}

	#stopPoller(
		udid: string,
		status: SimulatorStreamStatus['status'],
		{ silent = false } = {}
	): void {
		const key = udid.toUpperCase();
		const poller = this.#pollers.get(key);
		if (!poller) return;
		if (poller.timer) clearTimeout(poller.timer);
		poller.controller.abort();
		this.#pollers.delete(key);
		if (!silent) {
			poller.status = status;
			this.#emitStatus(poller);
		}
	}

	#schedule(poller: Poller, delayMs: number): void {
		if (poller.timer) clearTimeout(poller.timer);
		poller.timer = setTimeout(() => {
			poller.timer = undefined;
			void this.#capture(poller);
		}, delayMs);
		poller.timer.unref?.();
	}

	async #capture(poller: Poller): Promise<void> {
		if (
			this.#stopped ||
			this.#paused ||
			poller.inFlight ||
			poller.controller.signal.aborted ||
			this.#pollers.get(poller.udid) !== poller
		) {
			return;
		}
		poller.inFlight = true;
		const profile = SIMULATOR_STREAM_PROFILES[poller.quality];
		const startedAt = this.#now();
		try {
			await this.#ensureFrameDirectory();
			const framePath = path.join(
				this.#frameDirectory,
				`${poller.udid}-${randomUUID()}.jpg`
			);
			let raw: Buffer;
			try {
				await this.#run(
					XCRUN_PATH,
					[
						'simctl',
						'io',
						poller.udid,
						'screenshot',
						'--type=jpeg',
						'--mask=ignored',
						framePath,
					],
					{
						timeoutMs: CAPTURE_TIMEOUT_MS,
						maxOutputBytes: 64 * 1024,
						signal: poller.controller.signal,
					}
				);
				raw = await readFile(framePath);
			} finally {
				await rm(framePath, { force: true }).catch(() => undefined);
			}
			if (raw.length === 0 || raw.length > SIMULATOR_STREAM_MAX_FRAME_BYTES) {
				throw new Error(
					`Simulator screenshot was ${raw.length} bytes; expected a bounded JPEG.`
				);
			}
			const encoded = await this.#encode(
				raw,
				profile.maxWidth,
				profile.jpegQuality
			);
			if (
				poller.controller.signal.aborted ||
				this.#pollers.get(poller.udid) !== poller
			) {
				return;
			}
			poller.sequence += 1;
			poller.consecutiveFailures = 0;
			const frame: SimulatorStreamFrame = {
				udid: poller.udid,
				quality: poller.quality,
				sequence: poller.sequence,
				capturedAt: startedAt,
				width: encoded.width,
				height: encoded.height,
				mimeType: 'image/jpeg',
				captureMs: Math.max(0, Math.round(this.#now() - startedAt)),
			};
			for (const listener of this.#frameListeners) {
				try {
					listener(frame, new Uint8Array(encoded.bytes));
				} catch {
					// One failing subscriber must not starve the others.
				}
			}
			if (poller.status !== 'live') {
				poller.status = 'live';
				this.#emitStatus(poller);
			}
			// Pace from capture start so slow captures do not drift the cadence.
			const elapsed = this.#now() - startedAt;
			this.#schedule(poller, Math.max(0, profile.intervalMs - elapsed));
		} catch (error) {
			if (poller.controller.signal.aborted) return;
			poller.consecutiveFailures += 1;
			const next =
				poller.consecutiveFailures >= STALLED_AFTER_FAILURES
					? 'stalled'
					: poller.status === 'live'
						? 'live'
						: 'starting';
			poller.status = next;
			this.#emitStatus(poller, safeErrorText(error));
			this.#schedule(
				poller,
				simulatorStreamRetryDelayMs(
					poller.consecutiveFailures,
					profile.intervalMs
				)
			);
		} finally {
			poller.inFlight = false;
		}
	}

	#ensureFrameDirectory(): Promise<void> {
		if (!this.#ready) {
			this.#ready = mkdir(this.#frameDirectory, {
				recursive: true,
				mode: 0o700,
			}).then(() => undefined);
		}
		return this.#ready;
	}

	#emitStatus(poller: Poller, error?: string): void {
		const status: SimulatorStreamStatus = {
			udid: poller.udid,
			status: poller.status,
			consecutiveFailures: poller.consecutiveFailures,
			updatedAt: this.#now(),
			...(error ? { error } : {}),
		};
		for (const listener of this.#statusListeners) {
			try {
				listener(status);
			} catch {
				// One failing subscriber must not starve the others.
			}
		}
	}
}

/**
 * Production encoder backed by Electron's nativeImage. Kept out of the class
 * so the service has no Electron import and stays unit-testable.
 */
export function createNativeImageFrameEncoder(nativeImage: {
	createFromBuffer: (buffer: Buffer) => {
		getSize: () => { width: number; height: number };
		resize: (options: {
			width: number;
			height: number;
			quality: 'good' | 'better' | 'best';
		}) => { toJPEG: (quality: number) => Buffer };
		toJPEG: (quality: number) => Buffer;
	};
}): SimulatorFrameEncoder {
	return async (jpegBytes, maxWidth, jpegQuality) => {
		const image = nativeImage.createFromBuffer(jpegBytes);
		const size = image.getSize();
		if (size.width <= 0 || size.height <= 0) {
			throw new Error('Simulator screenshot could not be decoded.');
		}
		const target = simulatorStreamTargetSize(size.width, size.height, maxWidth);
		if (target.width === size.width) {
			return { bytes: image.toJPEG(jpegQuality), ...size };
		}
		const resized = image.resize({ ...target, quality: 'good' });
		return { bytes: resized.toJPEG(jpegQuality), ...target };
	};
}

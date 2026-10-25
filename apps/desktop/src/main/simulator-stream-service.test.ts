import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	SimulatorStreamFrame,
	SimulatorStreamStatus,
} from '../shared/simulator-stream-protocol';
import type {
	SimulatorCommandOptions,
	SimulatorCommandResult,
} from './simulator-command-runner';
import {
	createNativeImageFrameEncoder,
	type SimulatorFrameEncoder,
	SimulatorStreamService,
} from './simulator-stream-service';

const A = 'AAAAAAAA-0000-4000-8000-000000000001';
const B = 'BBBBBBBB-0000-4000-8000-000000000002';

const encoder: SimulatorFrameEncoder = async (bytes, maxWidth) => ({
	bytes: Buffer.concat([Buffer.from('enc:'), bytes]),
	width: Math.min(maxWidth, 1_206),
	height: 783,
});

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('SimulatorStreamService', () => {
	let root: string;
	let calls: Array<{
		args: readonly string[];
		options?: SimulatorCommandOptions;
	}>;
	let failFor: Set<string>;
	let frames: Array<{ frame: SimulatorStreamFrame; bytes: Uint8Array }>;
	let statuses: SimulatorStreamStatus[];
	let service: SimulatorStreamService;

	const run = vi.fn(
		async (
			_executable: string,
			args: readonly string[],
			options?: SimulatorCommandOptions
		): Promise<SimulatorCommandResult> => {
			calls.push({ args, ...(options ? { options } : {}) });
			const udid = args[2] as string;
			const framePath = args.at(-1) as string;
			if (failFor.has(udid)) {
				throw new Error(
					`Unable to lookup in current state: Shutdown (${udid})`
				);
			}
			await writeFile(framePath, Buffer.from(`jpeg-${udid}-${calls.length}`));
			return { stdout: '', stderr: '', exitCode: 0 };
		}
	);

	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), 'rndevtools-stream-'));
		calls = [];
		failFor = new Set();
		frames = [];
		statuses = [];
		service = new SimulatorStreamService({
			frameDirectory: path.join(root, 'frames'),
			encode: encoder,
			run,
		});
		service.subscribeFrames((frame, bytes) => frames.push({ frame, bytes }));
		service.subscribeStatus((status) => statuses.push(status));
	});

	afterEach(async () => {
		await service.stop();
		await rm(root, { recursive: true, force: true });
	});

	it('captures through a private temp file, downscales, deletes the file, and emits sequenced frames', async () => {
		await service.setSubscriptions([{ udid: A, quality: 'tile' }]);
		await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(1));
		const first = frames[0] as {
			frame: SimulatorStreamFrame;
			bytes: Uint8Array;
		};
		expect(first.frame).toMatchObject({
			udid: A,
			quality: 'tile',
			sequence: 1,
			width: 360,
			mimeType: 'image/jpeg',
		});
		expect(Buffer.from(first.bytes).toString()).toMatch(/^enc:jpeg-AAAAAAAA/);
		const capture = calls[0] as { args: readonly string[] };
		expect(capture.args.slice(0, 6)).toEqual([
			'simctl',
			'io',
			A,
			'screenshot',
			'--type=jpeg',
			'--mask=ignored',
		]);
		expect(capture.args.at(-1)).toMatch(
			new RegExp(`^${path.join(root, 'frames')}/${A}-[0-9a-f-]+\\.jpg$`)
		);
		// The frame file is gone once it has been read.
		expect(await readdir(path.join(root, 'frames'))).toEqual([]);
		expect(statuses.map((status) => status.status)).toEqual([
			'starting',
			'live',
		]);
	});

	it('diffs the desired set: unchanged pollers stay, removed ones stop, re-qualified ones restart', async () => {
		await service.setSubscriptions([
			{ udid: A, quality: 'tile' },
			{ udid: B, quality: 'tile' },
		]);
		expect(service.activeSubscriptions()).toHaveLength(2);
		await service.setSubscriptions([
			{ udid: A.toLowerCase(), quality: 'focus' },
		]);
		expect(service.activeSubscriptions()).toEqual([
			{ udid: A, quality: 'focus' },
		]);
		expect(
			statuses.some(
				(status) => status.udid === B && status.status === 'stopped'
			)
		).toBe(true);
		await vi.waitFor(() =>
			expect(frames.some((entry) => entry.frame.quality === 'focus')).toBe(true)
		);
		// The focus profile asks for a wider image.
		expect(
			frames.find((entry) => entry.frame.quality === 'focus')?.frame.width
		).toBe(900);
	});

	it('rejects malformed subscription sets before touching any poller', async () => {
		await expect(
			service.setSubscriptions([{ udid: 'booted', quality: 'tile' }])
		).rejects.toThrow();
		expect(service.activeSubscriptions()).toEqual([]);
		expect(run).not.toHaveBeenCalled();
	});

	it('reports failures, backs off, and marks the poller stalled after repeated misses', async () => {
		failFor.add(A);
		await service.setSubscriptions([{ udid: A, quality: 'focus' }]);
		await vi.waitFor(
			() =>
				expect(
					statuses.filter((status) => status.udid === A && status.error).length
				).toBeGreaterThanOrEqual(1),
			{ timeout: 2_000 }
		);
		const failed = statuses.find(
			(status) => status.error
		) as SimulatorStreamStatus;
		expect(failed.error).toMatch(/Unable to lookup/);
		expect(failed.consecutiveFailures).toBe(1);
		expect(frames).toHaveLength(0);
		// Recovery: the next capture succeeds and the poller goes live.
		failFor.delete(A);
		await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(1), {
			timeout: 3_000,
		});
		expect(statuses.at(-1)?.status).toBe('live');
		expect(statuses.at(-1)?.consecutiveFailures).toBe(0);
	});

	it('pauses without dropping subscriptions and resumes immediately', async () => {
		await service.setSubscriptions([{ udid: A, quality: 'tile' }]);
		await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(1));
		service.setPaused(true);
		const callsWhilePaused = calls.length;
		await sleep(150);
		expect(calls.length).toBe(callsWhilePaused);
		expect(service.activeSubscriptions()).toEqual([
			{ udid: A, quality: 'tile' },
		]);
		service.setPaused(false);
		await vi.waitFor(() =>
			expect(calls.length).toBeGreaterThan(callsWhilePaused)
		);
	});

	it('stop() tears down every poller and removes the frame directory', async () => {
		await service.setSubscriptions([{ udid: A, quality: 'tile' }]);
		await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(1));
		await service.stop();
		expect(service.activeSubscriptions()).toEqual([]);
		await expect(readdir(path.join(root, 'frames'))).rejects.toThrow();
		await service.setSubscriptions([{ udid: B, quality: 'tile' }]);
		expect(service.activeSubscriptions()).toEqual([]);
	});
});

describe('createNativeImageFrameEncoder', () => {
	it('downscales to the profile width and re-encodes, or passes small images through', async () => {
		const resize = vi.fn(() => ({ toJPEG: () => Buffer.from('small') }));
		const encode = createNativeImageFrameEncoder({
			createFromBuffer: (buffer) => ({
				getSize: () =>
					buffer.toString() === 'big'
						? { width: 1_206, height: 2_622 }
						: { width: 200, height: 400 },
				resize,
				toJPEG: () => Buffer.from('same'),
			}),
		});
		await expect(encode(Buffer.from('big'), 360, 70)).resolves.toEqual({
			bytes: Buffer.from('small'),
			width: 360,
			height: 783,
		});
		expect(resize).toHaveBeenCalledWith({
			width: 360,
			height: 783,
			quality: 'good',
		});
		await expect(encode(Buffer.from('tiny'), 360, 70)).resolves.toEqual({
			bytes: Buffer.from('same'),
			width: 200,
			height: 400,
		});
	});

	it('refuses an undecodable image', async () => {
		const encode = createNativeImageFrameEncoder({
			createFromBuffer: () => ({
				getSize: () => ({ width: 0, height: 0 }),
				resize: () => ({ toJPEG: () => Buffer.alloc(0) }),
				toJPEG: () => Buffer.alloc(0),
			}),
		});
		await expect(encode(Buffer.from('x'), 360, 70)).rejects.toThrow(/decoded/);
	});
});

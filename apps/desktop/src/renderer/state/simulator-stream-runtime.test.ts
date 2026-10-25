import { describe, expect, it, vi } from 'vitest';
import type {
	SimulatorStreamFrame,
	SimulatorStreamStatus,
} from '../../shared/simulator-stream-protocol';
import {
	createLiveScreens,
	resolveStreamSubscriptions,
} from './simulator-stream-runtime';

const A = 'AAAAAAAA-0000-4000-8000-000000000001';
const B = 'BBBBBBBB-0000-4000-8000-000000000002';

describe('resolveStreamSubscriptions', () => {
	it('collapses many component requests into one subscription per Simulator', () => {
		expect(
			resolveStreamSubscriptions([
				{ udid: A, quality: 'tile' },
				{ udid: A.toLowerCase(), quality: 'tile' },
				{ udid: B, quality: 'tile' },
			])
		).toEqual([
			{ udid: A, quality: 'tile' },
			{ udid: B, quality: 'tile' },
		]);
	});

	it('lets a focus request win over tile requests for the same Simulator', () => {
		expect(
			resolveStreamSubscriptions([
				{ udid: A, quality: 'tile' },
				{ udid: A, quality: 'focus' },
				{ udid: A, quality: 'tile' },
			])
		).toEqual([{ udid: A, quality: 'focus' }]);
	});

	it('returns a stable, sorted order so unchanged sets serialize identically', () => {
		const first = resolveStreamSubscriptions([
			{ udid: B, quality: 'tile' },
			{ udid: A, quality: 'focus' },
		]);
		const second = resolveStreamSubscriptions([
			{ udid: A, quality: 'focus' },
			{ udid: B, quality: 'tile' },
		]);
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		expect(resolveStreamSubscriptions([])).toEqual([]);
	});
});

describe('createLiveScreens', () => {
	function fakeUrls() {
		let next = 0;
		const live = new Set<string>();
		return {
			live,
			created: () => next,
			createObjectURL: vi.fn(() => {
				next += 1;
				const url = `blob:frame-${next}`;
				live.add(url);
				return url;
			}),
			revokeObjectURL: vi.fn((url: string) => {
				live.delete(url);
			}),
		};
	}

	const bytes = new Uint8Array([0xff, 0xd8, 0xff]);

	function frame(
		sequence: number,
		quality: SimulatorStreamFrame['quality'] = 'tile',
		udid = A
	): SimulatorStreamFrame {
		return {
			udid,
			quality,
			sequence,
			capturedAt: sequence,
			width: quality === 'tile' ? 360 : 900,
			height: quality === 'tile' ? 780 : 1_950,
			mimeType: 'image/jpeg',
			captureMs: 180,
		};
	}

	function status(
		value: SimulatorStreamStatus['status'],
		udid = A
	): SimulatorStreamStatus {
		return { udid, status: value, consecutiveFailures: 0, updatedAt: 1 };
	}

	it('shows the first frames of a poller main restarted for a new quality', () => {
		const screens = createLiveScreens(fakeUrls());
		for (let sequence = 1; sequence <= 300; sequence += 1) {
			screens.addFrame(frame(sequence), bytes);
		}
		// Selecting the tile restarts its poller silently: no `stopped`, a new
		// `starting`, and a count that begins at 1 again.
		screens.setStatus(status('starting'));
		screens.addFrame(frame(1, 'focus'), bytes);
		expect(screens.screen(A)?.frame).toMatchObject({
			quality: 'focus',
			sequence: 1,
		});
		screens.addFrame(frame(2, 'focus'), bytes);
		expect(screens.screen(A)?.frame.sequence).toBe(2);
	});

	it('never lets an older frame of the same poller replace a newer one', () => {
		const screens = createLiveScreens(fakeUrls());
		screens.addFrame(frame(6), bytes);
		screens.addFrame(frame(5), bytes);
		screens.addFrame(frame(6), bytes);
		expect(screens.screen(A)?.frame.sequence).toBe(6);
		screens.setStatus(status('live'));
		screens.addFrame(frame(1), bytes);
		expect(screens.screen(A)?.frame.sequence).toBe(6);
	});

	it('makes one object URL per shown frame and revokes every one it replaces', () => {
		const urls = fakeUrls();
		const screens = createLiveScreens(urls);
		for (let sequence = 1; sequence <= 40; sequence += 1) {
			screens.addFrame(frame(sequence), bytes);
		}
		screens.addFrame(frame(12), bytes);
		expect(urls.created()).toBe(40);
		expect([...urls.live]).toEqual([screens.screen(A)?.url]);
		screens.setStatus(status('stopped'));
		expect(screens.screen(A)).toBeUndefined();
		expect(screens.status(A)).toBeUndefined();
		expect(urls.live.size).toBe(0);
	});

	it('revokes every remaining URL when the provider goes away', () => {
		const urls = fakeUrls();
		const screens = createLiveScreens(urls);
		screens.addFrame(frame(1, 'tile', A), bytes);
		screens.addFrame(frame(1, 'focus', B), bytes);
		screens.setStatus(status('live', B));
		const listener = vi.fn();
		screens.subscribe(B, listener);
		screens.clear();
		expect(urls.live.size).toBe(0);
		expect(screens.screen(A)).toBeUndefined();
		expect(screens.status(B)).toBeUndefined();
		expect(listener).toHaveBeenCalledTimes(1);
		// A cleared store starts over, as after a StrictMode remount.
		screens.addFrame(frame(1, 'tile', A), bytes);
		expect(screens.screen(A)?.frame.sequence).toBe(1);
	});

	it('notifies only the screens that show the Simulator a frame is for', () => {
		const screens = createLiveScreens(fakeUrls());
		const onA = vi.fn();
		const onB = vi.fn();
		const unsubscribeA = screens.subscribe(A.toLowerCase(), onA);
		screens.subscribe(B, onB);
		screens.addFrame(frame(1, 'tile', A), bytes);
		screens.setStatus(status('live', A));
		screens.addFrame(frame(1, 'tile', A), bytes);
		expect(onA).toHaveBeenCalledTimes(2);
		expect(onB).not.toHaveBeenCalled();
		// Snapshots stay identical between changes, as useSyncExternalStore needs.
		expect(screens.screen(A)).toBe(screens.screen(A.toLowerCase()));
		unsubscribeA();
		screens.addFrame(frame(2, 'tile', A), bytes);
		expect(onA).toHaveBeenCalledTimes(2);
	});
});

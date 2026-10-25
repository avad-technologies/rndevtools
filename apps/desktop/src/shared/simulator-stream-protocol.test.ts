import { describe, expect, it } from 'vitest';
import {
	diffSimulatorStreamSubscriptions,
	SIMULATOR_STREAM_PROFILES,
	simulatorStreamFrameSchema,
	simulatorStreamRetryDelayMs,
	simulatorStreamSubscriptionsSchema,
	simulatorStreamTargetSize,
} from './simulator-stream-protocol';

const A = 'AAAAAAAA-0000-4000-8000-000000000001';
const B = 'BBBBBBBB-0000-4000-8000-000000000002';

describe('simulator stream protocol', () => {
	it('rejects duplicate subscriptions and oversized sets', () => {
		expect(
			simulatorStreamSubscriptionsSchema.safeParse([
				{ udid: A, quality: 'tile' },
				{ udid: A.toLowerCase(), quality: 'focus' },
			]).success
		).toBe(false);
		expect(
			simulatorStreamSubscriptionsSchema.safeParse(
				Array.from({ length: 33 }, (_, index) => ({
					udid: `${index.toString(16).padStart(8, '0').toUpperCase()}-0000-4000-8000-000000000000`,
					quality: 'tile',
				}))
			).success
		).toBe(false);
		expect(
			simulatorStreamSubscriptionsSchema.safeParse([
				{ udid: A, quality: 'tile' },
				{ udid: B, quality: 'focus' },
			]).success
		).toBe(true);
	});

	it('validates frame metadata strictly', () => {
		expect(
			simulatorStreamFrameSchema.safeParse({
				udid: A,
				quality: 'tile',
				sequence: 3,
				capturedAt: 1,
				width: 360,
				height: 782,
				mimeType: 'image/jpeg',
				captureMs: 180,
			}).success
		).toBe(true);
		expect(
			simulatorStreamFrameSchema.safeParse({
				udid: A,
				quality: 'tile',
				sequence: 3,
				capturedAt: 1,
				width: 360,
				height: 782,
				mimeType: 'image/png',
				captureMs: 180,
			}).success
		).toBe(false);
	});

	it('keeps the focus profile faster and larger than the tile profile', () => {
		expect(SIMULATOR_STREAM_PROFILES.focus.intervalMs).toBeLessThan(
			SIMULATOR_STREAM_PROFILES.tile.intervalMs
		);
		expect(SIMULATOR_STREAM_PROFILES.focus.maxWidth).toBeGreaterThan(
			SIMULATOR_STREAM_PROFILES.tile.maxWidth
		);
	});
});

describe('simulatorStreamRetryDelayMs', () => {
	it('backs off exponentially and caps at ten seconds', () => {
		expect(simulatorStreamRetryDelayMs(0, 250)).toBe(250);
		expect(simulatorStreamRetryDelayMs(1, 250)).toBe(500);
		expect(simulatorStreamRetryDelayMs(3, 250)).toBe(2_000);
		expect(simulatorStreamRetryDelayMs(9, 1_000)).toBe(10_000);
	});
});

describe('simulatorStreamTargetSize', () => {
	it('scales down to the max width and never upscales', () => {
		expect(simulatorStreamTargetSize(1_206, 2_622, 360)).toEqual({
			width: 360,
			height: 783,
		});
		expect(simulatorStreamTargetSize(300, 600, 360)).toEqual({
			width: 300,
			height: 600,
		});
	});
});

describe('diffSimulatorStreamSubscriptions', () => {
	it('starts new or re-qualified screens and stops the rest', () => {
		const current = new Map<string, 'tile' | 'focus'>([
			[A, 'tile'],
			[B, 'tile'],
		]);
		expect(
			diffSimulatorStreamSubscriptions(current, [
				{ udid: A.toLowerCase(), quality: 'focus' },
			])
		).toEqual({
			start: [{ udid: A, quality: 'focus' }],
			stop: [B],
		});
		expect(
			diffSimulatorStreamSubscriptions(current, [
				{ udid: A, quality: 'tile' },
				{ udid: B, quality: 'tile' },
			])
		).toEqual({ start: [], stop: [] });
	});
});

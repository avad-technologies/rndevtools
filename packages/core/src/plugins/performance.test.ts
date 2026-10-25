import {
	createPerformancePlugin,
	type PerformanceSample,
	type PerformanceScheduler,
	summarizePerformanceSamples,
} from './performance';

describe('summarizePerformanceSamples', () => {
	it('grades a responsive JS review as healthy', () => {
		const summary = summarizePerformanceSamples([
			{
				at: 1,
				durationMs: 1_000,
				frameCount: 60,
				slowFrameCount: 1,
				frozenFrameCount: 0,
				longestFrameMs: 24,
				worstEventLoopDelayMs: 12,
			},
		]);

		expect(summary).toEqual(
			expect.objectContaining({
				grade: 'healthy',
				averageJsFps: 60,
				frozenFrameCount: 0,
			}),
		);
	});

	it('marks severe stalls as critical', () => {
		const summary = summarizePerformanceSamples([
			{
				at: 1,
				durationMs: 1_000,
				frameCount: 20,
				slowFrameCount: 8,
				frozenFrameCount: 1,
				longestFrameMs: 300,
				worstEventLoopDelayMs: 275,
			},
		]);

		expect(summary.grade).toBe('critical');
	});
});

describe('createPerformancePlugin', () => {
	it('starts only while installed and stops sampling on disposal', () => {
		let now = 0;
		const cancelled = new Set<unknown>();
		const scheduler: PerformanceScheduler = {
			now: () => now,
			requestFrame: () => 'frame',
			cancelFrame: (handle) => cancelled.add(handle),
			setTimer: (_callback, delayMs) => `timer:${delayMs}`,
			clearTimer: (handle) => cancelled.add(handle),
		};
		const diagnostics = createPerformancePlugin({
			scheduler,
			appState: { getCurrentState: () => 'active', subscribe: () => () => {} },
		});

		expect(() => diagnostics.startReview()).toThrow('tools are disabled');
		const dispose = diagnostics.plugin.install?.();
		diagnostics.startReview();
		expect(diagnostics.getSnapshot().status).toBe('recording');
		expect(() => diagnostics.startReview()).toThrow('already recording');
		now = 1_000;
		dispose?.();

		expect(diagnostics.getSnapshot().status).toBe('stopped');
		expect(cancelled).toEqual(new Set(['frame', 'timer:250', 'timer:1000']));
	});

	it('pauses scheduling while backgrounded and resumes with a fresh window', () => {
		let appStateListener: ((state: string) => void) | undefined;
		let now = 0;
		let frameCallback: ((timestamp: number) => void) | undefined;
		const cancelled: unknown[] = [];
		const scheduler: PerformanceScheduler = {
			now: () => now,
			requestFrame: (callback) => {
				frameCallback = callback;
				return `frame-${now}`;
			},
			cancelFrame: (handle) => cancelled.push(handle),
			setTimer: (_callback, delay) => `timer-${delay}-${now}`,
			clearTimer: (handle) => cancelled.push(handle),
		};
		const diagnostics = createPerformancePlugin({
			scheduler,
			appState: {
				getCurrentState: () => 'active',
				subscribe: (listener) => {
					appStateListener = listener;
					return () => {
						appStateListener = undefined;
					};
				},
			},
		});
		const dispose = diagnostics.plugin.install?.();
		diagnostics.startReview();
		frameCallback?.(16);
		now = 50;
		appStateListener?.('background');
		now = 10_000;
		appStateListener?.('active');
		frameCallback?.(10_016);
		diagnostics.stopReview();

		expect(diagnostics.getSnapshot().summary.longestFrameMs).toBeLessThan(100);
		expect(cancelled.length).toBeGreaterThan(0);
		dispose?.();
	});

	it('ignores cancelled callbacks after backgrounding and rescheduling', () => {
		let appStateListener: ((state: string) => void) | undefined;
		const frameCallbacks: Array<(timestamp: number) => void> = [];
		const timerCallbacks: Array<() => void> = [];
		const scheduler: PerformanceScheduler = {
			now: () => 0,
			requestFrame: (callback) => {
				frameCallbacks.push(callback);
				return frameCallbacks.length;
			},
			cancelFrame: () => {},
			setTimer: (callback) => {
				timerCallbacks.push(callback);
				return timerCallbacks.length;
			},
			clearTimer: () => {},
		};
		const diagnostics = createPerformancePlugin({
			scheduler,
			appState: {
				getCurrentState: () => 'active',
				subscribe: (listener) => {
					appStateListener = listener;
					return () => {};
				},
			},
		});
		const dispose = diagnostics.plugin.install?.();
		diagnostics.startReview();
		const staleFrame = frameCallbacks[0];
		const staleTimers = timerCallbacks.slice();

		appStateListener?.('background');
		appStateListener?.('active');
		expect(frameCallbacks).toHaveLength(2);
		expect(timerCallbacks).toHaveLength(4);

		staleFrame?.(16);
		for (const callback of staleTimers) callback();

		expect(frameCallbacks).toHaveLength(2);
		expect(timerCallbacks).toHaveLength(4);
		dispose?.();
	});

	it('rejects invalid thresholds and samples', () => {
		expect(() =>
			createPerformancePlugin({
				slowFrameThresholdMs: 100,
				frozenFrameThresholdMs: 50,
			}),
		).toThrow('greater than or equal');
		const diagnostics = createPerformancePlugin();
		expect(() =>
			diagnostics.recordSample({
				at: Number.NaN,
				durationMs: 1,
				frameCount: 1,
				slowFrameCount: 0,
				frozenFrameCount: 0,
				longestFrameMs: 1,
				worstEventLoopDelayMs: 0,
			}),
		).toThrow('non-negative safe number');
	});

	it('retains a detached sample instead of a caller-owned object', () => {
		const diagnostics = createPerformancePlugin();
		const sample = {
			at: 1,
			durationMs: 1_000,
			frameCount: 60,
			slowFrameCount: 1,
			frozenFrameCount: 0,
			longestFrameMs: 20,
			worstEventLoopDelayMs: 5,
		};

		diagnostics.recordSample(sample);
		sample.frameCount = 0;

		expect(diagnostics.getSnapshot().samples[0]?.frameCount).toBe(60);
	});

	it('does not invoke sample accessors', () => {
		const diagnostics = createPerformancePlugin();
		const getter = jest.fn(() => 1);
		const sample = {
			durationMs: 1,
			frameCount: 1,
			slowFrameCount: 0,
			frozenFrameCount: 0,
			longestFrameMs: 1,
			worstEventLoopDelayMs: 0,
		} as Record<string, unknown>;
		Object.defineProperty(sample, 'at', { enumerable: true, get: getter });

		expect(() =>
			diagnostics.recordSample(sample as unknown as PerformanceSample),
		).toThrow('sample at');
		expect(getter).not.toHaveBeenCalled();
	});

	it('rolls back installation when the app-state source fails', () => {
		const diagnostics = createPerformancePlugin({
			appState: {
				getCurrentState: () => {
					throw new Error('state failed');
				},
				subscribe: () => () => {},
			},
		});

		expect(() => diagnostics.plugin.install?.()).toThrow('state failed');
		expect(() => diagnostics.startReview()).toThrow('tools are disabled');
	});

	it('rejects unsafe performance retention limits', () => {
		expect(() => createPerformancePlugin({ maxSamples: 10_001 })).toThrow(
			'maxSamples cannot exceed',
		);
		expect(() =>
			createPerformancePlugin({ maxSampleBytes: 16 * 1024 * 1024 + 1 }),
		).toThrow('maxSampleBytes cannot exceed');
	});

	it('stops safely when an asynchronous scheduler callback fails', () => {
		let frameCallback: ((timestamp: number) => void) | undefined;
		let frameRequests = 0;
		const scheduler: PerformanceScheduler = {
			now: () => 0,
			requestFrame: (callback) => {
				frameRequests += 1;
				if (frameRequests > 1) throw new Error('frame scheduler failed');
				frameCallback = callback;
				return 'frame';
			},
			cancelFrame: () => {},
			setTimer: () => 'timer',
			clearTimer: () => {},
		};
		const diagnostics = createPerformancePlugin({
			scheduler,
			appState: { getCurrentState: () => 'active', subscribe: () => () => {} },
		});
		diagnostics.plugin.install?.();
		diagnostics.startReview();

		expect(() => frameCallback?.(16)).not.toThrow();
		expect(diagnostics.getSnapshot()).toMatchObject({
			status: 'stopped',
			error: expect.stringContaining('frame scheduler failed'),
		});
	});
});

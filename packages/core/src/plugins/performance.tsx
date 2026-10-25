import {
	Button,
	ContentUnavailableView,
	DisclosureGroup,
	Host,
	Label,
	LabeledContent,
	List,
	Section,
	Text as UIText,
} from '@expo/ui/swift-ui';
import { font, foregroundStyle, listStyle } from '@expo/ui/swift-ui/modifiers';
import { useSyncExternalStore } from 'react';
import { AppState, Platform, PlatformColor } from 'react-native';
import {
	AndroidPanelRow,
	AndroidPanelScroll,
	AndroidPanelSection,
	AndroidPanelTextBlock,
} from '../components/android-panel-ui';
import { NavIconButton } from '../components/nav-controls';
import { PanelShell } from '../components/panel-shell';
import { BoundedEventStore, ExternalStore } from '../core/external-store';
import { formatDuration } from '../core/format';
import { assertPositiveFinite, assertPositiveInteger } from '../core/options';
import { diagnosticErrorText } from '../core/redact';
import { createRefCountedInstaller } from '../core/ref-counted-installer';
import { serializeValue, truncateText } from '../core/serialize';
import { shareDiagnosticContent } from '../core/share';
import type {
	DevToolsPanelPlugin,
	DevToolsPanelProps,
	DevToolsSystemImage,
} from '../types';

export type PerformanceSample = {
	at: number;
	durationMs: number;
	frameCount: number;
	slowFrameCount: number;
	frozenFrameCount: number;
	longestFrameMs: number;
	worstEventLoopDelayMs: number;
};

export type PerformanceReviewGrade =
	| 'notEnoughData'
	| 'healthy'
	| 'needsAttention'
	| 'critical';

export type PerformanceReviewSummary = {
	grade: PerformanceReviewGrade;
	durationMs: number;
	averageJsFps: number;
	slowFrameRatio: number;
	frozenFrameCount: number;
	longestFrameMs: number;
	worstEventLoopDelayMs: number;
	sampleCount: number;
};

export type PerformanceReviewSnapshot = {
	status: 'idle' | 'recording' | 'stopped';
	startedAt: number | null;
	stoppedAt: number | null;
	samples: readonly PerformanceSample[];
	summary: PerformanceReviewSummary;
	droppedSampleCount: number;
	error?: string;
};

export type PerformanceScheduler = {
	now: () => number;
	requestFrame: (callback: (timestamp: number) => void) => unknown;
	cancelFrame: (handle: unknown) => void;
	setTimer: (callback: () => void, delayMs: number) => unknown;
	clearTimer: (handle: unknown) => void;
};

export type PerformanceAppStateSource = {
	getCurrentState: () => string;
	subscribe: (listener: (state: string) => void) => () => void;
};

export type PerformancePluginOptions = {
	sampleIntervalMs?: number;
	eventLoopIntervalMs?: number;
	slowFrameThresholdMs?: number;
	frozenFrameThresholdMs?: number;
	maxSamples?: number;
	maxSampleBytes?: number;
	scheduler?: PerformanceScheduler;
	appState?: PerformanceAppStateSource;
	title?: string;
	id?: string;
	description?: string;
	section?: string;
	systemImage?: DevToolsSystemImage;
};

export type PerformancePlugin = {
	plugin: DevToolsPanelPlugin;
	startReview: () => void;
	stopReview: () => PerformanceReviewSummary;
	recordSample: (sample: PerformanceSample) => void;
	getSnapshot: () => PerformanceReviewSnapshot;
};

const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000;
const MAX_PERFORMANCE_INTERVAL_MS = 60 * 60 * 1000;
const MAX_PERFORMANCE_SAMPLES = 10_000;
const MAX_PERFORMANCE_SAMPLE_BYTES = 16 * 1024 * 1024;

function defaultNow(): number {
	return typeof performance !== 'undefined' &&
		typeof performance.now === 'function'
		? performance.now()
		: Date.now();
}

function defaultScheduler(): PerformanceScheduler {
	return {
		now: defaultNow,
		requestFrame: (callback) => {
			if (typeof globalThis.requestAnimationFrame === 'function') {
				return globalThis.requestAnimationFrame(callback);
			}
			return setTimeout(() => callback(defaultNow()), 16);
		},
		cancelFrame: (handle) => {
			if (
				typeof handle === 'number' &&
				typeof globalThis.cancelAnimationFrame === 'function'
			) {
				globalThis.cancelAnimationFrame(handle);
				return;
			}
			clearTimeout(handle as ReturnType<typeof setTimeout>);
		},
		setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
		clearTimer: (handle) =>
			clearTimeout(handle as ReturnType<typeof setTimeout>),
	};
}

function defaultAppStateSource(): PerformanceAppStateSource {
	return {
		getCurrentState: () => AppState.currentState,
		subscribe: (listener) => {
			const subscription = AppState.addEventListener('change', listener);
			return () => subscription.remove();
		},
	};
}

export function summarizePerformanceSamples(
	samples: readonly PerformanceSample[],
): PerformanceReviewSummary {
	let durationMs = 0;
	let frameCount = 0;
	let reportedSlowFrameCount = 0;
	let reportedFrozenFrameCount = 0;
	let longestFrameMs = 0;
	let worstEventLoopDelayMs = 0;
	for (const sample of samples) {
		durationMs += Number.isFinite(sample.durationMs)
			? Math.max(0, sample.durationMs)
			: 0;
		frameCount += Number.isFinite(sample.frameCount)
			? Math.max(0, sample.frameCount)
			: 0;
		reportedSlowFrameCount += Number.isFinite(sample.slowFrameCount)
			? Math.max(0, sample.slowFrameCount)
			: 0;
		reportedFrozenFrameCount += Number.isFinite(sample.frozenFrameCount)
			? Math.max(0, sample.frozenFrameCount)
			: 0;
		longestFrameMs = Math.max(
			longestFrameMs,
			Number.isFinite(sample.longestFrameMs)
				? Math.max(0, sample.longestFrameMs)
				: 0,
		);
		worstEventLoopDelayMs = Math.max(
			worstEventLoopDelayMs,
			Number.isFinite(sample.worstEventLoopDelayMs)
				? Math.max(0, sample.worstEventLoopDelayMs)
				: 0,
		);
	}
	const slowFrameCount = Math.min(frameCount, reportedSlowFrameCount);
	const frozenFrameCount = Math.min(slowFrameCount, reportedFrozenFrameCount);
	const averageJsFps =
		durationMs > 0 ? Math.round((frameCount * 100_000) / durationMs) / 100 : 0;
	const slowFrameRatio =
		frameCount > 0
			? Math.round((slowFrameCount / frameCount) * 10_000) / 10_000
			: 0;
	let grade: PerformanceReviewGrade = 'notEnoughData';
	if (samples.length > 0 && durationMs >= 500) {
		if (
			averageJsFps < 30 ||
			frozenFrameCount > 0 ||
			worstEventLoopDelayMs >= 250
		) {
			grade = 'critical';
		} else if (
			averageJsFps < 50 ||
			slowFrameRatio > 0.1 ||
			worstEventLoopDelayMs >= 100
		) {
			grade = 'needsAttention';
		} else {
			grade = 'healthy';
		}
	}
	return {
		grade,
		durationMs,
		averageJsFps,
		slowFrameRatio,
		frozenFrameCount,
		longestFrameMs: Math.round(longestFrameMs * 10) / 10,
		worstEventLoopDelayMs: Math.round(worstEventLoopDelayMs * 10) / 10,
		sampleCount: samples.length,
	};
}

function gradePresentation(grade: PerformanceReviewGrade): {
	label: string;
	color: string;
	image: DevToolsSystemImage;
} {
	if (grade === 'healthy') {
		return {
			label: 'JS responsiveness looks healthy',
			color: 'systemGreenColor',
			image: 'checkmark.circle.fill',
		};
	}
	if (grade === 'critical') {
		return {
			label: 'Severe JS stalls detected',
			color: 'systemRedColor',
			image: 'exclamationmark.octagon.fill',
		};
	}
	if (grade === 'needsAttention') {
		return {
			label: 'JS responsiveness needs review',
			color: 'systemOrangeColor',
			image: 'exclamationmark.triangle.fill',
		};
	}
	return {
		label: 'Record at least one interaction',
		color: 'systemGrayColor',
		image: 'timer',
	};
}

export function createPerformancePlugin(
	options: PerformancePluginOptions = {},
): PerformancePlugin {
	const title = options.title ?? 'Performance Review';
	const id = options.id ?? 'performance';
	const sampleIntervalMs = options.sampleIntervalMs ?? 1_000;
	const eventLoopIntervalMs = options.eventLoopIntervalMs ?? 250;
	const slowFrameThresholdMs = options.slowFrameThresholdMs ?? 34;
	const frozenFrameThresholdMs = options.frozenFrameThresholdMs ?? 100;
	const maxSamples = options.maxSamples ?? 300;
	const maxSampleBytes = options.maxSampleBytes ?? 256 * 1024;
	assertPositiveFinite(sampleIntervalMs, 'sampleIntervalMs');
	assertPositiveFinite(eventLoopIntervalMs, 'eventLoopIntervalMs');
	assertPositiveFinite(slowFrameThresholdMs, 'slowFrameThresholdMs');
	assertPositiveFinite(frozenFrameThresholdMs, 'frozenFrameThresholdMs');
	if (frozenFrameThresholdMs < slowFrameThresholdMs) {
		throw new Error(
			'frozenFrameThresholdMs must be greater than or equal to slowFrameThresholdMs',
		);
	}
	assertPositiveInteger(maxSamples, 'maxSamples');
	assertPositiveFinite(maxSampleBytes, 'maxSampleBytes');
	for (const [name, value] of [
		['sampleIntervalMs', sampleIntervalMs],
		['eventLoopIntervalMs', eventLoopIntervalMs],
		['slowFrameThresholdMs', slowFrameThresholdMs],
		['frozenFrameThresholdMs', frozenFrameThresholdMs],
	] as const) {
		if (value > MAX_PERFORMANCE_INTERVAL_MS) {
			throw new Error(`${name} cannot exceed ${MAX_PERFORMANCE_INTERVAL_MS}`);
		}
	}
	if (maxSamples > MAX_PERFORMANCE_SAMPLES) {
		throw new Error(`maxSamples cannot exceed ${MAX_PERFORMANCE_SAMPLES}`);
	}
	if (maxSampleBytes > MAX_PERFORMANCE_SAMPLE_BYTES) {
		throw new Error(
			`maxSampleBytes cannot exceed ${MAX_PERFORMANCE_SAMPLE_BYTES}`,
		);
	}
	const scheduler = options.scheduler ?? defaultScheduler();
	const appStateSource = options.appState ?? defaultAppStateSource();
	const sampleStore = new BoundedEventStore<PerformanceSample>({
		maxEvents: maxSamples,
		maxBytes: maxSampleBytes,
		estimateBytes: (sample) => serializeValue(sample, 4 * 1024).estimatedBytes,
	});
	const reviewStore = new ExternalStore<PerformanceReviewSnapshot>({
		status: 'idle',
		startedAt: null,
		stoppedAt: null,
		samples: [],
		summary: summarizePerformanceSamples([]),
		droppedSampleCount: 0,
	});
	let collectorActive = false;
	let recording = false;
	let currentAppState = 'unknown';
	let startedAt: number | null = null;
	let stoppedAt: number | null = null;
	let windowStartedAt = 0;
	let lastFrameAt: number | null = null;
	let frameCount = 0;
	let slowFrameCount = 0;
	let frozenFrameCount = 0;
	let longestFrameMs = 0;
	let worstEventLoopDelayMs = 0;
	let expectedEventLoopAt = 0;
	let frameHandle: unknown;
	let eventLoopHandle: unknown;
	let sampleHandle: unknown;
	let schedulerError: string | undefined;
	let totalSampleCount = 0;
	let scheduleGeneration = 0;

	const publish = (status?: PerformanceReviewSnapshot['status']): void => {
		const samples = sampleStore.getSnapshot();
		reviewStore.set({
			status:
				status ??
				(recording ? 'recording' : stoppedAt === null ? 'idle' : 'stopped'),
			startedAt,
			stoppedAt,
			samples,
			summary: summarizePerformanceSamples(samples),
			droppedSampleCount: Math.max(0, totalSampleCount - samples.length),
			error: schedulerError,
		});
	};

	const recordSample = (sample: PerformanceSample): void => {
		let descriptors: Record<string, PropertyDescriptor>;
		try {
			descriptors = Object.getOwnPropertyDescriptors(sample);
		} catch {
			throw new Error('Performance sample must be a readable object.');
		}
		const value = (key: keyof PerformanceSample): number => {
			const descriptor = descriptors[key];
			const candidate =
				descriptor && 'value' in descriptor ? descriptor.value : undefined;
			if (
				typeof candidate !== 'number' ||
				!Number.isFinite(candidate) ||
				candidate < 0 ||
				candidate > Number.MAX_SAFE_INTEGER
			) {
				throw new Error(
					`Performance sample ${key} must be a non-negative safe number.`,
				);
			}
			return candidate;
		};
		const detachedSample: PerformanceSample = {
			at: value('at'),
			durationMs: value('durationMs'),
			frameCount: value('frameCount'),
			slowFrameCount: value('slowFrameCount'),
			frozenFrameCount: value('frozenFrameCount'),
			longestFrameMs: value('longestFrameMs'),
			worstEventLoopDelayMs: value('worstEventLoopDelayMs'),
		};
		if (detachedSample.at > MAX_DATE_TIMESTAMP) {
			throw new Error('Performance sample at must be a valid timestamp.');
		}
		for (const key of [
			'frameCount',
			'slowFrameCount',
			'frozenFrameCount',
		] as const) {
			if (!Number.isSafeInteger(detachedSample[key])) {
				throw new Error(`Performance sample ${key} must be an integer.`);
			}
		}
		if (
			detachedSample.slowFrameCount > detachedSample.frameCount ||
			detachedSample.frozenFrameCount > detachedSample.slowFrameCount
		) {
			throw new Error(
				'Performance sample counts must satisfy frozen <= slow <= total frames.',
			);
		}
		sampleStore.append(detachedSample);
		totalSampleCount += 1;
		publish();
	};

	const resetWindow = (at: number): void => {
		windowStartedAt = at;
		lastFrameAt = null;
		frameCount = 0;
		slowFrameCount = 0;
		frozenFrameCount = 0;
		longestFrameMs = 0;
		worstEventLoopDelayMs = 0;
	};

	const flushWindow = (): void => {
		const at = scheduler.now();
		const durationMs = Math.max(0, at - windowStartedAt);
		if (durationMs > 0 && (frameCount > 0 || worstEventLoopDelayMs > 0)) {
			recordSample({
				at: Date.now(),
				durationMs,
				frameCount,
				slowFrameCount,
				frozenFrameCount,
				longestFrameMs,
				worstEventLoopDelayMs,
			});
		}
		resetWindow(at);
	};

	const isCurrentSchedule = (generation: number): boolean =>
		recording &&
		currentAppState === 'active' &&
		generation === scheduleGeneration;

	const onFrame = (generation: number, timestamp: number): void => {
		if (!isCurrentSchedule(generation)) return;
		try {
			const at = Number.isFinite(timestamp) ? timestamp : scheduler.now();
			if (lastFrameAt !== null) {
				const frameDuration = Math.max(0, at - lastFrameAt);
				frameCount += 1;
				longestFrameMs = Math.max(longestFrameMs, frameDuration);
				if (frameDuration >= slowFrameThresholdMs) slowFrameCount += 1;
				if (frameDuration >= frozenFrameThresholdMs) frozenFrameCount += 1;
			}
			lastFrameAt = at;
			frameHandle = scheduler.requestFrame((nextTimestamp) =>
				onFrame(generation, nextTimestamp),
			);
		} catch (error) {
			failScheduler(error);
		}
	};

	const onEventLoopTick = (generation: number): void => {
		if (!isCurrentSchedule(generation)) return;
		try {
			const at = scheduler.now();
			worstEventLoopDelayMs = Math.max(
				worstEventLoopDelayMs,
				Math.max(0, at - expectedEventLoopAt),
			);
			expectedEventLoopAt = at + eventLoopIntervalMs;
			eventLoopHandle = scheduler.setTimer(
				() => onEventLoopTick(generation),
				eventLoopIntervalMs,
			);
		} catch (error) {
			failScheduler(error);
		}
	};

	const onSampleTick = (generation: number): void => {
		if (!isCurrentSchedule(generation)) return;
		try {
			flushWindow();
			sampleHandle = scheduler.setTimer(
				() => onSampleTick(generation),
				sampleIntervalMs,
			);
		} catch (error) {
			failScheduler(error);
		}
	};

	const cancelScheduledWork = (): void => {
		const pendingFrame = frameHandle;
		const pendingEventLoop = eventLoopHandle;
		const pendingSample = sampleHandle;
		frameHandle = undefined;
		eventLoopHandle = undefined;
		sampleHandle = undefined;
		scheduleGeneration += 1;
		try {
			if (pendingFrame !== undefined) scheduler.cancelFrame(pendingFrame);
		} catch {
			// Continue clearing the remaining scheduler work.
		}
		try {
			if (pendingEventLoop !== undefined)
				scheduler.clearTimer(pendingEventLoop);
		} catch {
			// Continue clearing the remaining scheduler work.
		}
		try {
			if (pendingSample !== undefined) scheduler.clearTimer(pendingSample);
		} catch {
			// A custom diagnostic scheduler cannot make cleanup fatal.
		}
	};

	const failScheduler = (error: unknown): void => {
		if (!recording) return;
		recording = false;
		stoppedAt = Date.now();
		schedulerError = truncateText(
			`Performance scheduler failed: ${diagnosticErrorText(error)}`,
			8 * 1024,
		).text;
		cancelScheduledWork();
		publish('stopped');
	};

	const scheduleWork = (): void => {
		const now = scheduler.now();
		const generation = scheduleGeneration + 1;
		scheduleGeneration = generation;
		resetWindow(now);
		expectedEventLoopAt = now + eventLoopIntervalMs;
		frameHandle = scheduler.requestFrame((timestamp) =>
			onFrame(generation, timestamp),
		);
		eventLoopHandle = scheduler.setTimer(
			() => onEventLoopTick(generation),
			eventLoopIntervalMs,
		);
		sampleHandle = scheduler.setTimer(
			() => onSampleTick(generation),
			sampleIntervalMs,
		);
	};

	const startReview = (): void => {
		if (!collectorActive) {
			throw new Error(
				'Performance review is unavailable while tools are disabled.',
			);
		}
		if (recording) {
			throw new Error('A performance review is already recording.');
		}
		// Re-read rather than trusting the cached value: the state observed at
		// install can be 'unknown'/'inactive' during launch, and a source that
		// never emits a transition would otherwise wedge the review permanently.
		try {
			currentAppState = appStateSource.getCurrentState();
		} catch {
			// A faulty host source must not block a review the collector can run.
		}
		if (currentAppState !== 'active') {
			throw new Error('Performance review requires the app to be active.');
		}
		cancelScheduledWork();
		sampleStore.clear();
		totalSampleCount = 0;
		schedulerError = undefined;
		recording = true;
		startedAt = Date.now();
		stoppedAt = null;
		try {
			scheduleWork();
		} catch (error) {
			recording = false;
			stoppedAt = Date.now();
			schedulerError = truncateText(
				`Performance scheduler could not start: ${diagnosticErrorText(error)}`,
				8 * 1024,
			).text;
			cancelScheduledWork();
			publish('stopped');
			throw new Error(schedulerError);
		}
		publish('recording');
	};

	const stopReview = (): PerformanceReviewSummary => {
		if (recording) {
			try {
				flushWindow();
			} catch (error) {
				failScheduler(error);
				return reviewStore.getSnapshot().summary;
			}
			recording = false;
			stoppedAt = Date.now();
			cancelScheduledWork();
			publish('stopped');
		}
		return reviewStore.getSnapshot().summary;
	};

	const handleAppStateChange = (nextState: string): void => {
		const wasActive = currentAppState === 'active';
		const isActive = nextState === 'active';
		currentAppState = nextState;
		if (!recording || wasActive === isActive) return;
		if (!isActive) {
			try {
				flushWindow();
			} catch (error) {
				failScheduler(error);
				return;
			}
			cancelScheduledWork();
			lastFrameAt = null;
			return;
		}
		try {
			scheduleWork();
		} catch (error) {
			failScheduler(error);
		}
	};

	const install = createRefCountedInstaller(({ addCleanup }) => {
		collectorActive = true;
		addCleanup(() => {
			collectorActive = false;
			stopReview();
		});
		currentAppState = appStateSource.getCurrentState();
		const dispose = appStateSource.subscribe(handleAppStateChange);
		if (typeof dispose !== 'function') {
			throw new Error(
				'Performance app-state subscription requires a disposer.',
			);
		}
		addCleanup(dispose);
	});

	function PerformancePanel({ onBack, actions }: DevToolsPanelProps) {
		const review = useSyncExternalStore(
			reviewStore.subscribe,
			reviewStore.getSnapshot,
			reviewStore.getServerSnapshot,
		);
		const summary = review.summary;
		const grade = gradePresentation(summary.grade);
		const shareReview = () => {
			shareDiagnosticContent({
				title,
				message: serializeValue(
					{
						measurement: 'React Native runtime / JavaScript responsiveness',
						startedAt: review.startedAt,
						stoppedAt: review.stoppedAt,
						error: review.error,
						summary,
						samples: review.samples,
					},
					1024 * 1024,
				).text,
			});
		};
		const startPerformanceReview = () => {
			void actions.run({
				pluginId: id,
				label: 'Start performance review',
				action: startReview,
			});
		};
		const stopPerformanceReview = () => {
			void actions.run({
				pluginId: id,
				label: 'Stop performance review',
				action: stopReview,
			});
		};

		return (
			<PanelShell
				onBack={onBack}
				title={title}
				trailing={
					review.samples.length > 0 ? (
						<NavIconButton
							accessibilityLabel="Share performance review"
							onPress={shareReview}
							systemImage="square.and.arrow.up"
							testID="devtools-performance-share"
						/>
					) : undefined
				}
			>
				{Platform.OS === 'ios' ? (
					<Host style={{ flex: 1 }}>
						<List modifiers={[listStyle('insetGrouped')]}>
							<Section
								footer={
									<UIText>
										Measures callbacks visible to the React Native runtime. This
										is not native UI-thread FPS, CPU, memory, or a production
										profiler. Start, close the tools, reproduce the interaction,
										then return and stop.
									</UIText>
								}
							>
								{review.error ? (
									<Label
										color={PlatformColor('systemRedColor')}
										systemImage="exclamationmark.octagon.fill"
										title={review.error}
									/>
								) : null}
								<Label
									color={PlatformColor(
										review.status === 'recording'
											? 'systemBlueColor'
											: grade.color,
									)}
									systemImage={
										review.status === 'recording'
											? 'record.circle'
											: grade.image
									}
									title={
										review.status === 'recording'
											? 'Review recording'
											: grade.label
									}
								/>
								{review.status === 'recording' ? (
									<Button label="Stop review" onPress={stopPerformanceReview} />
								) : (
									<Button
										label={
											review.status === 'stopped'
												? 'Start new review'
												: 'Start review'
										}
										onPress={startPerformanceReview}
									/>
								)}
							</Section>
							{review.samples.length === 0 ? (
								<Section>
									<ContentUnavailableView
										description="Record a focused interaction to generate a review."
										systemImage="timer"
										title="No performance samples"
									/>
								</Section>
							) : (
								<>
									<Section title="Review summary">
										<LabeledContent label="Duration">
											<UIText>{formatDuration(summary.durationMs)}</UIText>
										</LabeledContent>
										<LabeledContent label="Average JS cadence">
											<UIText>{`${summary.averageJsFps} fps`}</UIText>
										</LabeledContent>
										<LabeledContent label="Slow JS frames">
											<UIText>{`${Math.round(summary.slowFrameRatio * 1_000) / 10}%`}</UIText>
										</LabeledContent>
										<LabeledContent label="Longest JS frame">
											<UIText>{`${summary.longestFrameMs} ms`}</UIText>
										</LabeledContent>
										<LabeledContent label="Worst event-loop delay">
											<UIText>{`${summary.worstEventLoopDelayMs} ms`}</UIText>
										</LabeledContent>
										<LabeledContent label="100 ms+ stalls">
											<UIText>{String(summary.frozenFrameCount)}</UIText>
										</LabeledContent>
									</Section>
									<Section title={`Samples · ${review.samples.length}`}>
										{[...review.samples]
											.reverse()
											.slice(0, 30)
											.map((sample) => {
												const fps =
													sample.durationMs > 0
														? Math.round(
																(sample.frameCount * 100_000) /
																	sample.durationMs,
															) / 100
														: 0;
												return (
													<DisclosureGroup
														key={`${sample.at}-${sample.durationMs}-${sample.frameCount}`}
														label={`${new Date(sample.at).toLocaleTimeString()} — ${fps} fps`}
													>
														<UIText
															modifiers={[
																font({
																	design: 'monospaced',
																	textStyle: 'footnote',
																}),
																foregroundStyle('secondary'),
															]}
														>
															{`slow=${sample.slowFrameCount} frozen=${sample.frozenFrameCount} longest=${Math.round(sample.longestFrameMs)}ms loop=${Math.round(sample.worstEventLoopDelayMs)}ms`}
														</UIText>
													</DisclosureGroup>
												);
											})}
									</Section>
								</>
							)}
						</List>
					</Host>
				) : (
					<AndroidPanelScroll>
						<AndroidPanelSection
							footer="Measures React Native runtime and JavaScript responsiveness—not native UI-thread FPS, CPU, memory, or a production profiler."
							title="Review"
						>
							{review.error ? (
								<AndroidPanelRow
									detail={review.error}
									label="Scheduler error"
									tone="danger"
								/>
							) : null}
							<AndroidPanelRow
								label={
									review.status === 'recording'
										? 'Review recording'
										: grade.label
								}
								tone={
									review.status === 'recording'
										? 'default'
										: summary.grade === 'healthy'
											? 'success'
											: summary.grade === 'critical'
												? 'danger'
												: summary.grade === 'needsAttention'
													? 'warning'
													: 'default'
								}
								value={review.status === 'recording' ? 'Active' : undefined}
							/>
							<AndroidPanelRow
								label={
									review.status === 'recording'
										? 'Stop review'
										: review.status === 'stopped'
											? 'Start new review'
											: 'Start review'
								}
								onPress={
									review.status === 'recording'
										? stopPerformanceReview
										: startPerformanceReview
								}
							/>
						</AndroidPanelSection>
						{review.samples.length === 0 ? (
							<AndroidPanelSection title="Results">
								<AndroidPanelRow
									detail="Record a focused interaction to generate a review."
									label="No performance samples"
								/>
							</AndroidPanelSection>
						) : (
							<>
								<AndroidPanelSection title="Review summary">
									<AndroidPanelRow
										label="Duration"
										value={formatDuration(summary.durationMs)}
									/>
									<AndroidPanelRow
										label="Average JS cadence"
										value={`${summary.averageJsFps} fps`}
									/>
									<AndroidPanelRow
										label="Slow JS frames"
										value={`${Math.round(summary.slowFrameRatio * 1_000) / 10}%`}
									/>
									<AndroidPanelRow
										label="Longest JS frame"
										value={`${summary.longestFrameMs} ms`}
									/>
									<AndroidPanelRow
										label="Worst event-loop delay"
										value={`${summary.worstEventLoopDelayMs} ms`}
									/>
									<AndroidPanelRow
										label="100 ms+ stalls"
										value={String(summary.frozenFrameCount)}
									/>
								</AndroidPanelSection>
								<AndroidPanelSection
									title={`Samples · ${review.samples.length}`}
								>
									{[...review.samples]
										.reverse()
										.slice(0, 30)
										.map((sample) => {
											const fps =
												sample.durationMs > 0
													? Math.round(
															(sample.frameCount * 100_000) / sample.durationMs,
														) / 100
													: 0;
											return (
												<AndroidPanelTextBlock
													key={`${sample.at}-${sample.durationMs}-${sample.frameCount}`}
													label={`${new Date(sample.at).toLocaleTimeString()} · ${fps} fps`}
													value={`slow=${sample.slowFrameCount} frozen=${sample.frozenFrameCount} longest=${Math.round(sample.longestFrameMs)}ms loop=${Math.round(sample.worstEventLoopDelayMs)}ms`}
												/>
											);
										})}
								</AndroidPanelSection>
							</>
						)}
					</AndroidPanelScroll>
				)}
			</PanelShell>
		);
	}

	const plugin: DevToolsPanelPlugin = {
		id,
		title,
		description:
			options.description ?? 'Record an honest review of JS responsiveness',
		systemImage: options.systemImage ?? 'timer',
		tint:
			Platform.OS === 'ios' ? PlatformColor('systemOrangeColor') : '#FF9500',
		section: options.section,
		Panel: PerformancePanel,
		install,
	};

	return {
		plugin,
		startReview,
		stopReview,
		recordSample,
		getSnapshot: reviewStore.getSnapshot,
	};
}

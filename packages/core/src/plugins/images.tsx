import {
	Button,
	Host,
	Label,
	LabeledContent,
	List,
	Section,
	Text as UIText,
} from '@expo/ui/swift-ui';
import { listStyle } from '@expo/ui/swift-ui/modifiers';
import { useSyncExternalStore } from 'react';
import { Platform, PlatformColor } from 'react-native';
import {
	AndroidPanelRow,
	AndroidPanelScroll,
	AndroidPanelSection,
	AndroidPanelTextBlock,
} from '../components/android-panel-ui';
import { PanelShell } from '../components/panel-shell';
import type { DevtoolsEventStore } from '../core/event-store';
import { BoundedEventStore } from '../core/external-store';
import { formatBytes, formatDuration } from '../core/format';
import { assertPositiveInteger } from '../core/options';
import { diagnosticErrorText, redactDiagnosticText } from '../core/redact';
import { createRefCountedInstaller } from '../core/ref-counted-installer';
import { serializeValue, truncateText } from '../core/serialize';
import { shareDiagnosticContent } from '../core/share';
import type {
	DevToolsPanelPlugin,
	DevToolsPanelProps,
	DevToolsSystemImage,
} from '../types';

export type ImageCachePolicy = 'disk' | 'memory' | 'memory-disk' | 'none';
export type ImageCacheType = 'disk' | 'memory' | 'none';
export type ImageContentFit =
	| 'contain'
	| 'cover'
	| 'fill'
	| 'none'
	| 'scale-down';
export type ImageDiagnosticState = 'loading' | 'loaded' | 'displayed' | 'error';

export type ImageDiagnosticSize = Readonly<{ width: number; height: number }>;

export type ImageSourceDescriptor = Readonly<{
	kind: 'asset' | 'data' | 'local' | 'native' | 'remote' | 'symbol' | 'unknown';
	fingerprint: string;
	label: string;
	redacted: boolean;
}>;

export type ImageDiagnosticEntry = Readonly<{
	id: string;
	targetId?: string;
	source: ImageSourceDescriptor;
	state: ImageDiagnosticState;
	startedAt: number;
	progressAt?: number;
	loadedAt?: number;
	displayedAt?: number;
	errorAt?: number;
	loadedBytes?: number;
	totalBytes?: number;
	intrinsicSize?: ImageDiagnosticSize;
	renderedSize?: ImageDiagnosticSize;
	cachePolicy?: ImageCachePolicy;
	cacheType?: ImageCacheType;
	contentFit?: ImageContentFit;
	accessibility: 'decorative' | 'labeled' | 'missing';
	error?: string;
}>;

export type ImageDiagnosticFindingStatus =
	| 'likely'
	| 'not-detected'
	| 'unavailable';

export type ImageDiagnosticAnalysis = Readonly<{
	upscaling: ImageDiagnosticFindingStatus;
	excessiveDecodedPixels: ImageDiagnosticFindingStatus;
	aspectMismatch: ImageDiagnosticFindingStatus;
	repeatedFailure: boolean;
	missingAccessibilityLabel: boolean;
	decodedPixels?: number;
	decodedBytes?: number;
	loadDurationMs?: number;
	displayDurationMs?: number;
}>;

export type ImageDiagnosticsSummary = Readonly<{
	total: number;
	loading: number;
	displayed: number;
	failed: number;
	likelyIssues: number;
}>;

export type ImageLoadStartInput = Readonly<{
	source: unknown;
	targetId?: string;
	renderedSize?: ImageDiagnosticSize;
	cachePolicy?: ImageCachePolicy | null;
	contentFit?: ImageContentFit;
	accessibilityLabel?: string | null;
	decorative?: boolean;
}>;

export type ImageLoadSuccessInput = Readonly<{
	intrinsicSize?: ImageDiagnosticSize;
	cacheType?: ImageCacheType;
}>;

export type ImageDiagnosticsPluginOptions = Readonly<{
	id?: string;
	title?: string;
	description?: string;
	section?: string;
	systemImage?: DevToolsSystemImage;
	maxEntries?: number;
	maxBytes?: number;
	now?: () => number;
	eventStore?: DevtoolsEventStore;
}>;

export type ImageDiagnosticsPlugin = Readonly<{
	plugin: DevToolsPanelPlugin;
	beginLoad: (input: ImageLoadStartInput) => string | null;
	recordProgress: (id: string, loaded: number, total: number) => void;
	recordLoad: (id: string, input: ImageLoadSuccessInput) => void;
	recordLayout: (id: string, size: ImageDiagnosticSize) => void;
	recordDisplay: (id: string) => void;
	recordError: (id: string, error: unknown) => void;
	getEntries: () => readonly ImageDiagnosticEntry[];
	subscribe: (listener: () => void) => () => void;
	clear: () => void;
}>;

const MAX_IMAGE_ENTRIES = 10_000;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 100_000;
const PROGRESS_PUBLISH_INTERVAL_MS = 250;
const LIKELY_LARGE_DECODED_PIXELS = 4_000_000;
const LIKELY_DECODE_TO_RENDER_RATIO = 4;

function dataProperty(value: unknown, key: string): unknown {
	if (!value || typeof value !== 'object') return undefined;
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return descriptor && 'value' in descriptor ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

function arrayLength(value: unknown): number {
	if (!Array.isArray(value)) return 0;
	const length = dataProperty(value, 'length');
	return Number.isSafeInteger(length) && (length as number) >= 0
		? Math.min(length as number, 100)
		: 0;
}

function fingerprint(value: string): string {
	let hash = 2_166_136_261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return `img-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function boundedLabel(value: string): string {
	return truncateText(value, 2 * 1024).text;
}

function describeSourceString(
	value: string,
): Omit<ImageSourceDescriptor, 'fingerprint'> {
	const trimmed = value.trim();
	if (trimmed.startsWith('sf:')) {
		return {
			kind: 'symbol',
			label: boundedLabel(trimmed.slice(0, 256)),
			redacted: false,
		};
	}
	if (trimmed.startsWith('data:')) {
		const mediaType = /^data:([^;,]+)/i.exec(trimmed)?.[1]?.toLowerCase();
		return {
			kind: 'data',
			label: `data:${mediaType ?? 'unknown'};[payload redacted]`,
			redacted: true,
		};
	}
	try {
		const url = new URL(trimmed);
		if (url.protocol === 'http:' || url.protocol === 'https:') {
			const hadSensitiveParts = Boolean(
				url.search || url.hash || url.username || url.password,
			);
			return {
				kind: 'remote',
				label: boundedLabel(`${url.origin}${url.pathname}`),
				redacted: hadSensitiveParts,
			};
		}
		if (url.protocol === 'file:' || url.protocol === 'content:') {
			const extension = /\.([A-Za-z0-9]{1,10})$/.exec(url.pathname)?.[1];
			return {
				kind: 'local',
				label: `${url.protocol}//[local]${extension ? `.${extension.toLowerCase()}` : ''}`,
				redacted: true,
			};
		}
	} catch {
		// Non-URL React Native resources are summarized without retaining text.
	}
	return { kind: 'unknown', label: '[opaque image source]', redacted: true };
}

export function describeImageSource(source: unknown): ImageSourceDescriptor {
	let described: Omit<ImageSourceDescriptor, 'fingerprint'>;
	if (typeof source === 'string') {
		described = describeSourceString(source);
	} else if (typeof source === 'number' && Number.isSafeInteger(source)) {
		described = {
			kind: 'asset',
			label: `bundled-asset:${source}`,
			redacted: false,
		};
	} else if (Array.isArray(source)) {
		const count = arrayLength(source);
		const first = count > 0 ? dataProperty(source, '0') : undefined;
		const firstDescriptor = describeImageSource(first);
		described = {
			kind: firstDescriptor.kind,
			label: `responsive:${count}:${firstDescriptor.label}`,
			redacted: firstDescriptor.redacted || count > 1,
		};
	} else {
		const uri = dataProperty(source, 'uri');
		if (typeof uri === 'string') described = describeSourceString(uri);
		else {
			described = {
				kind: source && typeof source === 'object' ? 'native' : 'unknown',
				label:
					source && typeof source === 'object'
						? '[native image reference]'
						: '[missing image source]',
				redacted: false,
			};
		}
	}
	return Object.freeze({
		...described,
		fingerprint: fingerprint(`${described.kind}:${described.label}`),
	});
}

function safeSize(
	value: ImageDiagnosticSize | undefined,
): ImageDiagnosticSize | undefined {
	if (!value) return undefined;
	if (
		typeof value.width !== 'number' ||
		typeof value.height !== 'number' ||
		!Number.isFinite(value.width) ||
		!Number.isFinite(value.height) ||
		value.width <= 0 ||
		value.height <= 0 ||
		value.width > MAX_IMAGE_DIMENSION ||
		value.height > MAX_IMAGE_DIMENSION
	) {
		return undefined;
	}
	return Object.freeze({ width: value.width, height: value.height });
}

function safeTimestamp(value: number): number {
	return Number.isFinite(value) && value >= 0 ? value : Date.now();
}

function boundedTargetId(value: string | undefined): string | undefined {
	if (typeof value !== 'string') return undefined;
	const redacted = redactDiagnosticText(value.trim());
	return redacted ? truncateText(redacted, 512).text : undefined;
}

function accessibilityStatus(
	label: string | null | undefined,
	decorative: boolean | undefined,
): ImageDiagnosticEntry['accessibility'] {
	if (decorative === true) return 'decorative';
	return typeof label === 'string' && label.trim() ? 'labeled' : 'missing';
}

export function analyzeImageDiagnostic(
	entry: ImageDiagnosticEntry,
	entries: readonly ImageDiagnosticEntry[] = [entry],
): ImageDiagnosticAnalysis {
	const intrinsic = entry.intrinsicSize;
	const rendered = entry.renderedSize;
	const decodedPixels = intrinsic
		? Math.round(intrinsic.width * intrinsic.height)
		: undefined;
	const renderedPixels = rendered
		? Math.max(1, rendered.width * rendered.height)
		: undefined;
	const upscaling =
		intrinsic && rendered
			? rendered.width > intrinsic.width * 1.1 ||
				rendered.height > intrinsic.height * 1.1
				? 'likely'
				: 'not-detected'
			: 'unavailable';
	const excessiveDecodedPixels =
		decodedPixels === undefined
			? 'unavailable'
			: decodedPixels >= LIKELY_LARGE_DECODED_PIXELS &&
					(renderedPixels === undefined ||
						decodedPixels / renderedPixels >= LIKELY_DECODE_TO_RENDER_RATIO)
				? 'likely'
				: 'not-detected';
	const aspectMismatch =
		intrinsic && rendered
			? Math.abs(
					intrinsic.width / intrinsic.height - rendered.width / rendered.height,
				) /
					(intrinsic.width / intrinsic.height) >
				0.05
				? 'likely'
				: 'not-detected'
			: 'unavailable';
	const failureCount = entries.filter(
		(candidate) =>
			candidate.source.fingerprint === entry.source.fingerprint &&
			candidate.state === 'error',
	).length;
	return Object.freeze({
		upscaling,
		excessiveDecodedPixels,
		aspectMismatch,
		repeatedFailure: failureCount >= 2,
		missingAccessibilityLabel: entry.accessibility === 'missing',
		...(decodedPixels === undefined
			? {}
			: { decodedPixels, decodedBytes: decodedPixels * 4 }),
		...(entry.loadedAt === undefined
			? {}
			: { loadDurationMs: Math.max(0, entry.loadedAt - entry.startedAt) }),
		...(entry.displayedAt === undefined
			? {}
			: {
					displayDurationMs: Math.max(0, entry.displayedAt - entry.startedAt),
				}),
	});
}

export function summarizeImageDiagnostics(
	entries: readonly ImageDiagnosticEntry[],
): ImageDiagnosticsSummary {
	let likelyIssues = 0;
	for (const entry of entries) {
		const analysis = analyzeImageDiagnostic(entry, entries);
		if (
			analysis.upscaling === 'likely' ||
			analysis.excessiveDecodedPixels === 'likely' ||
			analysis.aspectMismatch === 'likely' ||
			analysis.repeatedFailure ||
			analysis.missingAccessibilityLabel
		) {
			likelyIssues += 1;
		}
	}
	return Object.freeze({
		total: entries.length,
		loading: entries.filter((entry) => entry.state === 'loading').length,
		displayed: entries.filter((entry) => entry.state === 'displayed').length,
		failed: entries.filter((entry) => entry.state === 'error').length,
		likelyIssues,
	});
}

function statusLabel(entry: ImageDiagnosticEntry): string {
	if (entry.state === 'error') return 'Failed';
	if (entry.state === 'displayed') return 'Displayed';
	if (entry.state === 'loaded') return 'Loaded';
	return 'Loading';
}

function findingSummary(analysis: ImageDiagnosticAnalysis): string {
	const findings = [
		analysis.upscaling === 'likely' ? 'upscaled' : null,
		analysis.excessiveDecodedPixels === 'likely' ? 'large decode' : null,
		analysis.aspectMismatch === 'likely' ? 'aspect mismatch' : null,
		analysis.repeatedFailure ? 'repeated failure' : null,
		analysis.missingAccessibilityLabel ? 'missing label' : null,
	].filter((value): value is string => Boolean(value));
	return findings.length > 0
		? findings.join(' · ')
		: 'No likely issue detected';
}

export function createImageDiagnosticsPlugin(
	options: ImageDiagnosticsPluginOptions = {},
): ImageDiagnosticsPlugin {
	const id = options.id ?? 'images';
	const title = options.title ?? 'Images';
	const maxEntries = options.maxEntries ?? 300;
	const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
	assertPositiveInteger(maxEntries, 'maxEntries');
	assertPositiveInteger(maxBytes, 'maxBytes');
	if (maxEntries > MAX_IMAGE_ENTRIES) {
		throw new Error(`maxEntries cannot exceed ${MAX_IMAGE_ENTRIES}`);
	}
	if (maxBytes > MAX_IMAGE_BYTES) {
		throw new Error(`maxBytes cannot exceed ${MAX_IMAGE_BYTES}`);
	}
	if (options.now !== undefined && typeof options.now !== 'function') {
		throw new Error('now must be a function');
	}
	const now = options.now ?? Date.now;
	const store = new BoundedEventStore<ImageDiagnosticEntry>({
		maxEvents: maxEntries,
		maxBytes,
		estimateBytes: (entry) => serializeValue(entry, 16 * 1024).estimatedBytes,
	});
	const lastProgressAt = new Map<string, number>();
	let collecting = false;
	let nextSequence = 1;

	const update = (
		entryId: string,
		patch: Partial<ImageDiagnosticEntry>,
	): ImageDiagnosticEntry | undefined => {
		const current = store.getSnapshot().find((entry) => entry.id === entryId);
		if (!current) return undefined;
		const next = Object.freeze({ ...current, ...patch });
		store.replace((entry) => entry.id === entryId, next);
		return next;
	};

	const appendTimelineEvent = (
		entry: ImageDiagnosticEntry,
		kind: string,
		level: 'debug' | 'info' | 'error',
	): void => {
		options.eventStore?.append({
			at:
				entry.errorAt ?? entry.displayedAt ?? entry.loadedAt ?? entry.startedAt,
			source: id,
			kind,
			level,
			title: `${statusLabel(entry)} image`,
			summary: entry.source.label,
			resourceRef: { toolId: id, resourceId: entry.id },
			attributes: {
				fingerprint: entry.source.fingerprint,
				state: entry.state,
				...(entry.targetId ? { targetId: entry.targetId } : {}),
			},
		});
	};

	const beginLoad = (input: ImageLoadStartInput): string | null => {
		if (!collecting) return null;
		const at = safeTimestamp(now());
		const targetId = boundedTargetId(input.targetId);
		const renderedSize = safeSize(input.renderedSize);
		const entry = Object.freeze({
			id: `image-${nextSequence}`,
			...(targetId ? { targetId } : {}),
			source: describeImageSource(input.source),
			state: 'loading' as const,
			startedAt: at,
			...(renderedSize ? { renderedSize } : {}),
			...(input.cachePolicy ? { cachePolicy: input.cachePolicy } : {}),
			...(input.contentFit ? { contentFit: input.contentFit } : {}),
			accessibility: accessibilityStatus(
				input.accessibilityLabel,
				input.decorative,
			),
		}) satisfies ImageDiagnosticEntry;
		nextSequence += 1;
		store.append(entry);
		const retained = new Set(
			store.getSnapshot().map((candidate) => candidate.id),
		);
		if (!retained.has(entry.id)) return null;
		for (const retainedId of lastProgressAt.keys()) {
			if (!retained.has(retainedId)) lastProgressAt.delete(retainedId);
		}
		appendTimelineEvent(entry, 'image.load.started', 'debug');
		return entry.id;
	};

	const recordProgress = (
		entryId: string,
		loaded: number,
		total: number,
	): void => {
		if (!collecting) return;
		if (
			!Number.isSafeInteger(loaded) ||
			!Number.isSafeInteger(total) ||
			loaded < 0 ||
			total < 0
		) {
			return;
		}
		const at = safeTimestamp(now());
		const prior = lastProgressAt.get(entryId) ?? 0;
		if (loaded < total && at - prior < PROGRESS_PUBLISH_INTERVAL_MS) return;
		if (
			update(entryId, {
				progressAt: at,
				loadedBytes: loaded,
				totalBytes: total,
			})
		) {
			lastProgressAt.set(entryId, at);
		}
	};

	const recordLoad = (entryId: string, input: ImageLoadSuccessInput): void => {
		if (!collecting) return;
		const intrinsicSize = safeSize(input.intrinsicSize);
		const entry = update(entryId, {
			state: 'loaded',
			loadedAt: safeTimestamp(now()),
			...(intrinsicSize ? { intrinsicSize } : {}),
			...(input.cacheType ? { cacheType: input.cacheType } : {}),
		});
		if (entry) appendTimelineEvent(entry, 'image.load.completed', 'info');
	};

	const recordLayout = (entryId: string, size: ImageDiagnosticSize): void => {
		if (!collecting) return;
		const renderedSize = safeSize(size);
		if (renderedSize) update(entryId, { renderedSize });
	};

	const recordDisplay = (entryId: string): void => {
		if (!collecting) return;
		const entry = update(entryId, {
			state: 'displayed',
			displayedAt: safeTimestamp(now()),
		});
		if (entry) appendTimelineEvent(entry, 'image.displayed', 'info');
	};

	const recordError = (entryId: string, error: unknown): void => {
		if (!collecting) return;
		const errorText = truncateText(
			redactDiagnosticText(diagnosticErrorText(error)),
			4 * 1024,
		).text;
		const entry = update(entryId, {
			state: 'error',
			errorAt: safeTimestamp(now()),
			error: errorText,
		});
		if (entry) appendTimelineEvent(entry, 'image.load.failed', 'error');
	};

	const install = createRefCountedInstaller(({ addCleanup }) => {
		collecting = true;
		addCleanup(() => {
			collecting = false;
			lastProgressAt.clear();
		});
	});

	function ImagesPanel({ onBack, actions }: DevToolsPanelProps) {
		const entries = useSyncExternalStore(
			store.subscribe,
			store.getSnapshot,
			store.getServerSnapshot,
		);
		const summary = summarizeImageDiagnostics(entries);
		const recent = [...entries].reverse().slice(0, 80);
		const clear = (): void => {
			void actions.run({
				pluginId: id,
				label: 'Clear image diagnostics',
				action: store.clear,
			});
		};
		const share = (): void => {
			shareDiagnosticContent({
				title: 'Image diagnostics',
				message: serializeValue(
					{
						summary,
						images: entries.map((entry) => ({
							...entry,
							analysis: analyzeImageDiagnostic(entry, entries),
						})),
					},
					1024 * 1024,
				).text,
			});
		};
		return (
			<PanelShell onBack={onBack} title={title}>
				{Platform.OS === 'ios' ? (
					<Host style={{ flex: 1 }}>
						<List modifiers={[listStyle('insetGrouped')]}>
							<Section title="Session">
								<LabeledContent label="Observed">
									<UIText>{`${summary.total}`}</UIText>
								</LabeledContent>
								<LabeledContent label="Likely issues">
									<UIText>{`${summary.likelyIssues}`}</UIText>
								</LabeledContent>
								<LabeledContent label="Failures">
									<UIText>{`${summary.failed}`}</UIText>
								</LabeledContent>
								<Button label="Share report" onPress={share} />
								{entries.length > 0 ? (
									<Button label="Clear session" onPress={clear} />
								) : null}
							</Section>
							<Section title={`Recent · ${recent.length}`}>
								{recent.length === 0 ? (
									<UIText>Tracked images will appear as they load.</UIText>
								) : (
									recent.map((entry) => {
										const analysis = analyzeImageDiagnostic(entry, entries);
										return (
											<Label
												key={entry.id}
												color={PlatformColor(
													entry.state === 'error'
														? 'systemRedColor'
														: 'secondaryLabelColor',
												)}
												systemImage={
													entry.state === 'error'
														? 'exclamationmark.triangle.fill'
														: 'photo'
												}
												title={`${statusLabel(entry)} · ${entry.source.label}\n${findingSummary(analysis)}`}
											/>
										);
									})
								)}
							</Section>
						</List>
					</Host>
				) : (
					<AndroidPanelScroll>
						<AndroidPanelSection title="Session">
							<AndroidPanelRow label="Observed" value={`${summary.total}`} />
							<AndroidPanelRow
								label="Likely issues"
								tone={summary.likelyIssues > 0 ? 'warning' : 'success'}
								value={`${summary.likelyIssues}`}
							/>
							<AndroidPanelRow label="Share report" onPress={share} />
							{entries.length > 0 ? (
								<AndroidPanelRow label="Clear session" onPress={clear} />
							) : null}
						</AndroidPanelSection>
						<AndroidPanelSection title={`Recent · ${recent.length}`}>
							{recent.length === 0 ? (
								<AndroidPanelRow label="No tracked image loads yet" />
							) : (
								recent.map((entry) => {
									const analysis = analyzeImageDiagnostic(entry, entries);
									const duration =
										analysis.displayDurationMs ?? analysis.loadDurationMs;
									return (
										<AndroidPanelTextBlock
											key={entry.id}
											label={`${statusLabel(entry)} · ${entry.source.label}`}
											value={`${findingSummary(analysis)}${duration === undefined ? '' : ` · ${formatDuration(duration)}`}${analysis.decodedBytes === undefined ? '' : ` · decoded ${formatBytes(analysis.decodedBytes)}`}`}
										/>
									);
								})
							)}
						</AndroidPanelSection>
					</AndroidPanelScroll>
				)}
			</PanelShell>
		);
	}

	const plugin: DevToolsPanelPlugin = {
		id,
		title,
		description:
			options.description ??
			'Track image loads, display timing, failures, and likely efficiency issues',
		systemImage: options.systemImage ?? 'photo.stack',
		tint:
			Platform.OS === 'ios' ? PlatformColor('systemIndigoColor') : '#5856D6',
		section: options.section,
		Panel: ImagesPanel,
		install,
	};

	return Object.freeze({
		plugin,
		beginLoad,
		recordProgress,
		recordLoad,
		recordLayout,
		recordDisplay,
		recordError,
		getEntries: store.getSnapshot,
		subscribe: store.subscribe,
		clear: store.clear,
	});
}

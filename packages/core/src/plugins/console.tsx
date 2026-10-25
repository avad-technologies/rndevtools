import {
	Button,
	ContentUnavailableView,
	DisclosureGroup,
	Host,
	Label,
	LabeledContent,
	List,
	Picker,
	Section,
	TextField,
	Text as UIText,
} from '@expo/ui/swift-ui';
import {
	autocorrectionDisabled,
	font,
	foregroundStyle,
	lineLimit,
	listRowBackground,
	listStyle,
	pickerStyle,
	tag,
} from '@expo/ui/swift-ui/modifiers';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { Platform, PlatformColor } from 'react-native';
import {
	AndroidPanelRow,
	AndroidPanelScroll,
	AndroidPanelSearch,
	AndroidPanelSection,
	AndroidPanelTabs,
	AndroidPanelTextBlock,
} from '../components/android-panel-ui';
import { NavIconButton } from '../components/nav-controls';
import { PanelShell } from '../components/panel-shell';
import {
	createKeyWalker,
	type KeyWalker,
	redactWithinWindow,
	stringObjectText,
	VALUE_OMITTED,
	VALUE_UNITS,
} from '../core/bounded-redaction';
import { BoundedEventStore, ExternalStore } from '../core/external-store';
import { assertPositiveFinite, assertPositiveInteger } from '../core/options';
import {
	isSensitiveDiagnosticKey,
	redactDiagnosticText,
	sanitizeDiagnosticValue,
} from '../core/redact';
import { createRefCountedInstaller } from '../core/ref-counted-installer';
import { serializeValue, truncateText } from '../core/serialize';
import { shareDiagnosticContent } from '../core/share';
import type {
	DevToolsPanelPlugin,
	DevToolsPanelProps,
	DevToolsSystemImage,
} from '../types';

export type ConsoleLogLevel =
	| 'trace'
	| 'debug'
	| 'info'
	| 'warn'
	| 'error'
	| 'fatal';

export type ConsoleLogInput = {
	at?: number;
	level: ConsoleLogLevel;
	message: string;
	attributes?: Readonly<Record<string, unknown>>;
	scope?: string;
	correlationId?: string;
	groupId?: string;
	error?: unknown;
	sourceLocation?: {
		file: string;
		line?: number;
		column?: number;
	};
};

export type ConsoleLogEvent = {
	id: number;
	at: number;
	firstAt: number;
	lastAt: number;
	level: ConsoleLogLevel;
	message: string;
	messageTruncated: boolean;
	attributesText?: string;
	attributesTruncated: boolean;
	scope?: string;
	correlationId?: string;
	groupId: string;
	repeatCount: number;
	errorName?: string;
	errorStack?: string;
	sourceLocation?: {
		file: string;
		line?: number;
		column?: number;
	};
};

export type ConsoleLogSource = {
	subscribe: (listener: (event: ConsoleLogInput) => void) => () => void;
};

export type ConsolePluginOptions = {
	source: ConsoleLogSource;
	/** Optional host sanitizer. Built-in credential and identifier redaction runs after it. */
	sanitize?: (event: ConsoleLogInput) => ConsoleLogInput | null;
	maxEvents?: number;
	/** Total estimated bytes retained across all events, not a per-event cap. */
	maxEventBytes?: number;
	maxMessageBytes?: number;
	maxAttributesBytes?: number;
	maxStackBytes?: number;
	groupingWindowMs?: number;
	title?: string;
	id?: string;
	description?: string;
	section?: string;
	systemImage?: DevToolsSystemImage;
};

export type ConsolePlugin = {
	plugin: DevToolsPanelPlugin;
	getEvents: () => readonly ConsoleLogEvent[];
	getBookmarkedEventIds: () => readonly number[];
	toggleBookmark: (eventId: number) => boolean;
	clear: () => void;
};

type ConsoleFilter = 'all' | 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS = new Set<ConsoleLogLevel>([
	'trace',
	'debug',
	'info',
	'warn',
	'error',
	'fatal',
]);

const SENSITIVE_KEY =
	/(^|[_-])(authorization|body|content|cookie|email|id|message|name|password|path|phone|prompt|query|response|secret|token|url)([_-]|$)/i;
/**
 * `SENSITIVE_KEY` only matches separator-delimited words, so `accessToken` and
 * `userId` slip past it. Insert a separator at each camelCase boundary and
 * collapse the rest, then re-test with the same anchored pattern. Stripping the
 * separators instead would make every listed word a bare substring, which
 * redacts ordinary keys such as `width`, `isValid` and `gridSize` (all contain
 * `id`).
 */
function separatorNormalizedKey(key: string): string {
	return key
		.replace(/([a-z\d])([A-Z])/g, '$1_$2')
		.replace(/[^a-z\d]+/gi, '_')
		.toLowerCase();
}
const UUID =
	/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000;
const MAX_CONSOLE_EVENTS = 10_000;
const MAX_CONSOLE_STORE_BYTES = 16 * 1024 * 1024;
const MAX_CONSOLE_MESSAGE_BYTES = 64 * 1024;
const MAX_CONSOLE_ATTRIBUTES_BYTES = 1024 * 1024;
const MAX_CONSOLE_STACK_BYTES = 64 * 1024;
const MAX_GROUPING_WINDOW_MS = 60_000;
// The work that the attributes of one event share, in code units: every code
// unit of a string or key tested or redacted, or of a key copied again, and
// `VALUE_UNITS` for every value, hole and accessor read and for every key
// listed, so a wide tree of values without text runs out too. Once it is
// spent, the strings and objects still reached are omitted, and so are the
// keys of more than 1 Ki code units.
const MAX_ATTRIBUTE_REDACTION_UNITS = 2 * MAX_CONSOLE_ATTRIBUTES_BYTES;
// The most entries of one array and keys of one object that attributes keep.
const MAX_ATTRIBUTE_ARRAY_ENTRIES = 50;
const MAX_ATTRIBUTE_OBJECT_KEYS = 100;

function isConsoleLogLevel(value: unknown): value is ConsoleLogLevel {
	return typeof value === 'string' && LOG_LEVELS.has(value as ConsoleLogLevel);
}

function consoleMarkers(text: string): string {
	return text
		.replaceAll('[REDACTED EMAIL]', '[REDACTED_EMAIL]')
		.replaceAll('[REDACTED JWT]', '[REDACTED_TOKEN]');
}

export function redactConsoleText(value: string): string {
	// Markers already in the text are renamed first, so the rules see what a
	// second redaction would: dropping the space can let a URL password run on.
	return consoleMarkers(redactDiagnosticText(consoleMarkers(value))).replace(
		UUID,
		'[REDACTED_ID]',
	);
}

/** What one event's attributes may still redact, and whether any was cut. */
type AttributeRedaction = {
	units: number;
	maxBytes: number;
	truncated: boolean;
	walkKey: KeyWalker;
};

/**
 * The Console's own key names, and the shared ones: `serializeValue` replaces
 * the value of every key `isSensitiveDiagnosticKey` flags, so testing those
 * here too spares the walk, and the truncated flag, values it would replace
 * anyway.
 */
function isSensitiveConsoleKey(key: string): boolean {
	return (
		SENSITIVE_KEY.test(key) ||
		SENSITIVE_KEY.test(separatorNormalizedKey(key)) ||
		isSensitiveDiagnosticKey(key)
	);
}

function redactAttributeText(
	text: string,
	redaction: AttributeRedaction,
): string {
	try {
		const bounded = redactWithinWindow(
			text,
			redaction.maxBytes,
			redactConsoleText,
			redaction,
		);
		if (bounded.truncated) redaction.truncated = true;
		return bounded.text;
	} catch {
		// An engine with a smaller regexp stack than V8 can fail on one window.
		// The value is left out rather than kept unredacted.
		redaction.truncated = true;
		return '[Value omitted: redaction failed]';
	}
}

function redactConsoleValue(
	value: unknown,
	depth: number,
	seen: WeakSet<object>,
	redaction: AttributeRedaction,
): unknown {
	// A value without text costs a value too, so that an array of them runs
	// out. It is kept even once the budget is spent: no object is opened after
	// that, so only the ones already open can list more.
	if (
		value === null ||
		typeof value === 'number' ||
		typeof value === 'boolean'
	) {
		redaction.units -= VALUE_UNITS;
		return value;
	}
	if (typeof value !== 'string' && typeof value !== 'object') {
		// Undefined, a function, a symbol or a bigint, which are left out.
		redaction.units -= VALUE_UNITS;
		return undefined;
	}
	if (redaction.units <= 0) {
		redaction.truncated = true;
		return VALUE_OMITTED;
	}
	redaction.units -= VALUE_UNITS;
	if (typeof value === 'string') return redactAttributeText(value, redaction);
	const text = stringObjectText(value);
	if (text !== undefined) return redactAttributeText(text, redaction);
	if (depth >= 6) return '[Max depth]';
	if (seen.has(value)) return '[Circular]';
	seen.add(value);
	try {
		return redactConsoleObject(value, depth, seen, redaction);
	} finally {
		// `seen` is the ancestor path, not a visited-set: leaving entries behind
		// would report a value referenced twice in a tree as a cycle.
		seen.delete(value);
	}
}

function redactConsoleObject(
	value: object,
	depth: number,
	seen: WeakSet<object>,
	redaction: AttributeRedaction,
): unknown {
	// A typed array has an own property per element; the shared sanitizer
	// summarizes it rather than walking a multi-megabyte buffer.
	if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) {
		return sanitizeDiagnosticValue(value);
	}
	// Descriptors are read one at a time, and only for entries within the caps:
	// collecting them all first cost time and memory in proportion to the size
	// of the logged value. Nested levels catch their own read failures.
	const redactedEntry = (key: string, sensitive: boolean): unknown => {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor && 'value' in descriptor && !sensitive) {
			return redactConsoleValue(descriptor.value, depth + 1, seen, redaction);
		}
		// A hole, an accessor and a hidden value cost a value each too.
		redaction.units -= VALUE_UNITS;
		if (!descriptor || !('value' in descriptor)) return '[Accessor omitted]';
		return '[REDACTED]';
	};
	try {
		if (Array.isArray(value)) {
			const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
			const length =
				lengthDescriptor &&
				'value' in lengthDescriptor &&
				typeof lengthDescriptor.value === 'number'
					? lengthDescriptor.value
					: 0;
			if (length > MAX_ATTRIBUTE_ARRAY_ENTRIES) redaction.truncated = true;
			return Array.from(
				{ length: Math.min(length, MAX_ATTRIBUTE_ARRAY_ENTRIES) },
				(_unused, index) => redactedEntry(String(index), false),
			);
		}
		const keys = Object.keys(value);
		// Listing costs time for every key, however few are kept.
		redaction.units -= keys.length * VALUE_UNITS;
		if (keys.length > MAX_ATTRIBUTE_OBJECT_KEYS) redaction.truncated = true;
		const output = Object.create(null) as Record<string, unknown>;
		for (const key of keys.slice(0, MAX_ATTRIBUTE_OBJECT_KEYS)) {
			const stored = redaction.walkKey(key, output, redaction);
			if (stored.truncated) redaction.truncated = true;
			output[stored.key] = stored.omitted
				? VALUE_OMITTED
				: redactedEntry(key, stored.sensitive);
		}
		return output;
	} catch {
		return '[Unreadable object]';
	}
}

function matchesFilter(level: ConsoleLogLevel, filter: ConsoleFilter): boolean {
	if (filter === 'all') return true;
	if (filter === 'debug') return level === 'trace' || level === 'debug';
	if (filter === 'error') return level === 'error' || level === 'fatal';
	return level === filter;
}

function levelColor(level: ConsoleLogLevel): string {
	if (level === 'fatal' || level === 'error') return 'systemRedColor';
	if (level === 'warn') return 'systemOrangeColor';
	if (level === 'info') return 'systemBlueColor';
	return 'systemGrayColor';
}

function levelImage(level: ConsoleLogLevel): DevToolsSystemImage {
	if (level === 'fatal' || level === 'error') return 'xmark.octagon.fill';
	if (level === 'warn') return 'exclamationmark.triangle.fill';
	if (level === 'info') return 'info.circle.fill';
	return 'ladybug.fill';
}

function eventSearchText(event: ConsoleLogEvent): string {
	return `${event.level} ${event.scope ?? ''} ${event.message} ${event.errorName ?? ''} ${event.errorStack ?? ''} ${event.attributesText ?? ''}`.toLowerCase();
}

/**
 * An own data property, read without running a getter. Fields are read one at
 * a time: listing every descriptor costs time in proportion to the object,
 * such as a String object, which lists every index.
 */
function dataProperty(value: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function boundedConsoleText(
	value: unknown,
	maxBytes: number,
): { text?: string; truncated: boolean } {
	if (typeof value !== 'string' || !value.trim()) return { truncated: false };
	const result = redactWithinWindow(value.trim(), maxBytes, redactConsoleText);
	return { text: result.text, truncated: result.truncated };
}

function boundedConsoleIdentifier(
	value: unknown,
	maxBytes: number,
): string | undefined {
	const text = boundedConsoleText(value, maxBytes).text;
	return text && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text) ? text : undefined;
}

function consoleErrorFields(
	value: unknown,
	maxStackBytes: number,
): { name?: string; stack?: string; truncated: boolean } {
	if (!value || typeof value !== 'object') return { truncated: false };
	let rawName: unknown;
	let rawStack: unknown;
	try {
		rawName = dataProperty(value, 'name');
		rawStack = dataProperty(value, 'stack');
	} catch {
		return { truncated: false };
	}
	const name = boundedConsoleText(rawName, 256);
	const stack = boundedConsoleText(rawStack, maxStackBytes);
	return {
		...(name.text ? { name: name.text } : {}),
		...(stack.text ? { stack: stack.text } : {}),
		truncated: name.truncated || stack.truncated,
	};
}

function consoleSourceLocation(
	value: unknown,
): ConsoleLogEvent['sourceLocation'] | undefined {
	if (!value || typeof value !== 'object') return undefined;
	let rawFile: unknown;
	let line: unknown;
	let column: unknown;
	try {
		rawFile = dataProperty(value, 'file');
		line = dataProperty(value, 'line');
		column = dataProperty(value, 'column');
	} catch {
		return undefined;
	}
	const file = boundedConsoleText(rawFile, 2 * 1024).text;
	if (!file) return undefined;
	return Object.freeze({
		file,
		...(typeof line === 'number' && Number.isSafeInteger(line) && line > 0
			? { line }
			: {}),
		...(typeof column === 'number' && Number.isSafeInteger(column) && column > 0
			? { column }
			: {}),
	});
}

function consoleGroupFingerprint(parts: readonly unknown[]): string {
	const value = parts.join('\u0000');
	let hash = 2_166_136_261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return `auto-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function createConsolePlugin(
	options: ConsolePluginOptions,
): ConsolePlugin {
	const title = options.title ?? 'Console';
	const id = options.id ?? 'console';
	const maxEvents = options.maxEvents ?? 300;
	const maxEventBytes = options.maxEventBytes ?? 512 * 1024;
	const maxMessageBytes = options.maxMessageBytes ?? 2 * 1024;
	const maxAttributesBytes = options.maxAttributesBytes ?? 16 * 1024;
	const maxStackBytes = options.maxStackBytes ?? 16 * 1024;
	const groupingWindowMs = options.groupingWindowMs ?? 1_000;
	assertPositiveInteger(maxEvents, 'maxEvents');
	assertPositiveFinite(maxEventBytes, 'maxEventBytes');
	assertPositiveFinite(maxMessageBytes, 'maxMessageBytes');
	assertPositiveFinite(maxAttributesBytes, 'maxAttributesBytes');
	assertPositiveFinite(maxStackBytes, 'maxStackBytes');
	assertPositiveFinite(groupingWindowMs, 'groupingWindowMs');
	if (maxEvents > MAX_CONSOLE_EVENTS) {
		throw new Error(`maxEvents cannot exceed ${MAX_CONSOLE_EVENTS}`);
	}
	if (maxEventBytes > MAX_CONSOLE_STORE_BYTES) {
		throw new Error(`maxEventBytes cannot exceed ${MAX_CONSOLE_STORE_BYTES}`);
	}
	if (maxMessageBytes > MAX_CONSOLE_MESSAGE_BYTES) {
		throw new Error(
			`maxMessageBytes cannot exceed ${MAX_CONSOLE_MESSAGE_BYTES}`,
		);
	}
	if (maxAttributesBytes > MAX_CONSOLE_ATTRIBUTES_BYTES) {
		throw new Error(
			`maxAttributesBytes cannot exceed ${MAX_CONSOLE_ATTRIBUTES_BYTES}`,
		);
	}
	if (maxStackBytes > MAX_CONSOLE_STACK_BYTES) {
		throw new Error(`maxStackBytes cannot exceed ${MAX_CONSOLE_STACK_BYTES}`);
	}
	if (groupingWindowMs > MAX_GROUPING_WINDOW_MS) {
		throw new Error(`groupingWindowMs cannot exceed ${MAX_GROUPING_WINDOW_MS}`);
	}

	const eventStore = new BoundedEventStore<ConsoleLogEvent>({
		maxEvents,
		maxBytes: maxEventBytes,
		estimateBytes: (event) =>
			serializeValue(
				event,
				maxMessageBytes + maxAttributesBytes + maxStackBytes + 8 * 1024,
			).estimatedBytes,
	});
	const bookmarksStore = new ExternalStore<readonly number[]>(
		Object.freeze([]),
	);
	const reconcileBookmarks = (): void => {
		const retained = new Set(eventStore.getSnapshot().map((event) => event.id));
		const current = bookmarksStore.getSnapshot();
		const next = current.filter((eventId) => retained.has(eventId));
		if (next.length !== current.length) bookmarksStore.set(Object.freeze(next));
	};
	const toggleBookmark = (eventId: number): boolean => {
		if (!Number.isSafeInteger(eventId) || eventId <= 0) return false;
		if (!eventStore.getSnapshot().some((event) => event.id === eventId))
			return false;
		const current = bookmarksStore.getSnapshot();
		const isBookmarked = current.includes(eventId);
		bookmarksStore.set(
			Object.freeze(
				isBookmarked
					? current.filter((candidate) => candidate !== eventId)
					: [...current, eventId].slice(-1_000),
			),
		);
		return !isBookmarked;
	};
	let nextEventId = 1;

	const ingest = (input: ConsoleLogInput): void => {
		let hostSanitized: ConsoleLogInput | null;
		try {
			hostSanitized = options.sanitize ? options.sanitize(input) : input;
		} catch {
			return;
		}
		if (!hostSanitized || typeof hostSanitized !== 'object') return;
		const sanitized: object = hostSanitized;
		// A read that throws drops the event, as the source subscription catches.
		const field = (key: keyof ConsoleLogInput): unknown =>
			dataProperty(sanitized, key);
		const level = field('level');
		const rawMessage = field('message');
		if (!isConsoleLogLevel(level) || typeof rawMessage !== 'string') return;
		const message = redactWithinWindow(
			rawMessage,
			maxMessageBytes,
			redactConsoleText,
		);
		const attributeRedaction: AttributeRedaction = {
			units: MAX_ATTRIBUTE_REDACTION_UNITS,
			// Two bytes over, so a string cut here still overflows the serialized
			// attributes, which then cut it where they would cut the whole string.
			maxBytes: maxAttributesBytes + 2,
			truncated: false,
			walkKey: createKeyWalker(redactConsoleText, isSensitiveConsoleKey),
		};
		const redactedAttributes = redactConsoleValue(
			field('attributes') ?? {},
			0,
			new WeakSet(),
			attributeRedaction,
		);
		const attributes = serializeValue(redactedAttributes, maxAttributesBytes);
		const hasAttributes =
			attributes.text !== '{}' && attributes.text !== 'undefined';
		const rawTimestamp = field('at');
		const at =
			typeof rawTimestamp === 'number' &&
			Number.isFinite(rawTimestamp) &&
			rawTimestamp >= 0 &&
			rawTimestamp <= MAX_DATE_TIMESTAMP
				? rawTimestamp
				: Date.now();
		const scope = boundedConsoleText(field('scope'), 256).text;
		const correlationId = boundedConsoleIdentifier(field('correlationId'), 512);
		const explicitGroupId = boundedConsoleIdentifier(field('groupId'), 512);
		const error = consoleErrorFields(field('error'), maxStackBytes);
		const sourceLocation = consoleSourceLocation(field('sourceLocation'));
		const groupId =
			explicitGroupId ??
			consoleGroupFingerprint([
				level,
				scope ?? '',
				message.text,
				attributes.text,
				error.name ?? '',
				error.stack ?? '',
				sourceLocation?.file ?? '',
				sourceLocation?.line ?? '',
			]);
		const priorEvents = eventStore.getSnapshot();
		const candidate = priorEvents[priorEvents.length - 1];
		const previous =
			candidate?.groupId === groupId &&
			at >= candidate.lastAt &&
			at - candidate.lastAt <= groupingWindowMs
				? candidate
				: undefined;
		if (previous) {
			eventStore.replace((event) => event.id === previous.id, {
				...previous,
				at,
				lastAt: at,
				repeatCount: previous.repeatCount + 1,
			});
			reconcileBookmarks();
			return;
		}
		// Reserve the id first: store subscribers run inside append, and one that
		// logs (React warns about a render-phase update) re-enters ingest, which
		// would otherwise reuse this id and give the panel duplicate row keys.
		const eventId = nextEventId;
		nextEventId += 1;
		eventStore.append({
			id: eventId,
			at,
			firstAt: at,
			lastAt: at,
			level,
			message: message.text,
			messageTruncated: message.truncated,
			attributesText: hasAttributes ? attributes.text : undefined,
			attributesTruncated:
				attributes.truncated || attributeRedaction.truncated || error.truncated,
			...(scope ? { scope } : {}),
			...(correlationId ? { correlationId } : {}),
			groupId,
			repeatCount: 1,
			...(error.name ? { errorName: error.name } : {}),
			...(error.stack ? { errorStack: error.stack } : {}),
			...(sourceLocation ? { sourceLocation } : {}),
		});
		reconcileBookmarks();
	};
	const install = createRefCountedInstaller(({ addCleanup }) => {
		let active = true;
		addCleanup(() => {
			active = false;
		});
		const dispose = options.source.subscribe((event) => {
			if (!active) return;
			try {
				ingest(event);
			} catch {
				// A malformed diagnostic event must not affect the logger source.
			}
		});
		if (typeof dispose !== 'function') {
			throw new Error('Console source subscription did not return a disposer.');
		}
		addCleanup(() => {
			active = false;
			dispose();
		});
	});

	function ConsolePanel({ onBack, actions }: DevToolsPanelProps) {
		const events = useSyncExternalStore(
			eventStore.subscribe,
			eventStore.getSnapshot,
			eventStore.getServerSnapshot,
		);
		const [filter, setFilter] = useState<ConsoleFilter>('all');
		const [search, setSearch] = useState('');
		const bookmarkedIds = useSyncExternalStore(
			bookmarksStore.subscribe,
			bookmarksStore.getSnapshot,
			bookmarksStore.getServerSnapshot,
		);
		const bookmarked = useMemo(() => new Set(bookmarkedIds), [bookmarkedIds]);
		const needle = search.trim().toLowerCase();
		const visibleEvents = useMemo(
			() =>
				[...events]
					.reverse()
					.filter(
						(event) =>
							matchesFilter(event.level, filter) &&
							(!needle || eventSearchText(event).includes(needle)),
					),
			[events, filter, needle],
		);
		const shareEvents = () => {
			shareDiagnosticContent({
				title,
				message: truncateText(
					events
						.map(
							(event) =>
								`${new Date(event.at).toISOString()} [${event.level.toUpperCase()}]${event.scope ? ` [${event.scope}]` : ''} ${event.message}${event.repeatCount > 1 ? ` ×${event.repeatCount}` : ''}${event.errorStack ? `\n${event.errorStack}` : ''}${event.attributesText ? ` ${event.attributesText}` : ''}`,
						)
						.join('\n'),
					1024 * 1024,
				).text,
			});
		};
		const clearCapturedLogs = () => {
			void actions.run({
				pluginId: id,
				label: 'Clear captured logs',
				confirmation: {
					title: 'Clear captured logs?',
					confirmLabel: 'Clear',
					destructive: true,
				},
				action: () => {
					eventStore.clear();
					bookmarksStore.set(Object.freeze([]));
				},
			});
		};

		return (
			<PanelShell
				onBack={onBack}
				title={title}
				trailing={
					<NavIconButton
						accessibilityLabel="Share structured logs"
						onPress={shareEvents}
						systemImage="square.and.arrow.up"
						testID="devtools-console-share"
					/>
				}
			>
				{Platform.OS === 'ios' ? (
					<Host style={{ flex: 1 }}>
						<List modifiers={[listStyle('insetGrouped')]}>
							<Section>
								<Picker
									label="Log level"
									modifiers={[
										pickerStyle('segmented'),
										listRowBackground('clear'),
									]}
									onSelectionChange={setFilter}
									selection={filter}
								>
									<UIText modifiers={[tag('all')]}>All</UIText>
									<UIText modifiers={[tag('debug')]}>Debug</UIText>
									<UIText modifiers={[tag('info')]}>Info</UIText>
									<UIText modifiers={[tag('warn')]}>Warn</UIText>
									<UIText modifiers={[tag('error')]}>Error</UIText>
								</Picker>
								<TextField
									modifiers={[autocorrectionDisabled()]}
									onTextChange={setSearch}
									placeholder="Search structured logs"
								/>
							</Section>
							<Section
								footer={
									<UIText>
										This view subscribes to the app logger; it does not replace
										or monkey-patch the global console. Credentials and common
										identifiers are redacted before storage.
									</UIText>
								}
								title={`Logs · ${visibleEvents.length}`}
							>
								{visibleEvents.length === 0 ? (
									<ContentUnavailableView
										description={
											events.length === 0
												? 'Structured logger events will appear while internal tools are enabled.'
												: 'No logs match the selected filter.'
										}
										systemImage="terminal"
										title={
											events.length === 0 ? 'No logs yet' : 'No matching logs'
										}
									/>
								) : (
									visibleEvents.map((event) => (
										<DisclosureGroup
											key={event.id}
											label={`${bookmarked.has(event.id) ? '★ ' : ''}${event.level.toUpperCase()} — ${event.message}${event.repeatCount > 1 ? ` ×${event.repeatCount}` : ''}`}
										>
											<Label
												color={PlatformColor(levelColor(event.level))}
												systemImage={levelImage(event.level)}
												title={new Date(event.at).toLocaleTimeString()}
											/>
											<LabeledContent label="Message">
												<UIText modifiers={[lineLimit(12)]}>
													{event.message}
												</UIText>
											</LabeledContent>
											{event.scope ? (
												<LabeledContent label="Scope">
													<UIText>{event.scope}</UIText>
												</LabeledContent>
											) : null}
											{event.repeatCount > 1 ? (
												<LabeledContent label="Repeated">
													<UIText>{`${event.repeatCount} times`}</UIText>
												</LabeledContent>
											) : null}
											{event.errorStack ? (
												<UIText
													modifiers={[
														font({
															design: 'monospaced',
															textStyle: 'footnote',
														}),
														foregroundStyle('secondary'),
														lineLimit(20),
													]}
												>
													{event.errorStack}
												</UIText>
											) : null}
											{event.attributesText ? (
												<UIText
													modifiers={[
														font({
															design: 'monospaced',
															textStyle: 'footnote',
														}),
														foregroundStyle('secondary'),
														lineLimit(20),
													]}
												>
													{event.attributesText}
												</UIText>
											) : null}
											<Button
												label={
													bookmarked.has(event.id)
														? 'Remove bookmark'
														: 'Bookmark'
												}
												onPress={() => toggleBookmark(event.id)}
											/>
										</DisclosureGroup>
									))
								)}
							</Section>
							{events.length > 0 ? (
								<Section>
									<Button
										label="Clear captured logs"
										onPress={clearCapturedLogs}
									/>
								</Section>
							) : null}
						</List>
					</Host>
				) : (
					<AndroidPanelScroll>
						<AndroidPanelTabs
							onSelect={setFilter}
							options={[
								{ label: 'All', value: 'all' },
								{ label: 'Debug', value: 'debug' },
								{ label: 'Info', value: 'info' },
								{ label: 'Warn', value: 'warn' },
								{ label: 'Error', value: 'error' },
							]}
							selected={filter}
						/>
						<AndroidPanelSearch
							onChangeText={setSearch}
							placeholder="Search structured logs"
							value={search}
						/>
						<AndroidPanelSection
							footer="Subscribes to the app logger without patching the global console. Sensitive values are redacted before storage."
							title={`Logs · ${visibleEvents.length}`}
						>
							{visibleEvents.length === 0 ? (
								<AndroidPanelRow
									detail={
										events.length === 0
											? 'Structured logger events will appear while internal tools are enabled.'
											: 'Change the level or search filter.'
									}
									label={
										events.length === 0 ? 'No logs yet' : 'No matching logs'
									}
								/>
							) : (
								visibleEvents.map((event) => (
									<AndroidPanelTextBlock
										key={event.id}
										label={`${bookmarked.has(event.id) ? '★ · ' : ''}${event.level.toUpperCase()} · ${new Date(event.at).toLocaleTimeString()}${event.repeatCount > 1 ? ` · ×${event.repeatCount}` : ''}`}
										tone={
											event.level === 'error' || event.level === 'fatal'
												? 'danger'
												: event.level === 'warn'
													? 'warning'
													: 'default'
										}
										value={`${event.scope ? `[${event.scope}] ` : ''}${event.message}${event.errorStack ? `\n${event.errorStack}` : ''}${event.attributesText ? `\n${event.attributesText}` : ''}`}
									/>
								))
							)}
						</AndroidPanelSection>
						{events.length > 0 ? (
							<AndroidPanelSection title="Actions">
								<AndroidPanelRow
									label="Clear captured logs"
									onPress={clearCapturedLogs}
									tone="danger"
								/>
							</AndroidPanelSection>
						) : null}
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
			'Search bounded events from the structured app logger',
		systemImage: options.systemImage ?? 'terminal.fill',
		tint: Platform.OS === 'ios' ? PlatformColor('systemGrayColor') : '#8E8E93',
		section: options.section,
		Panel: ConsolePanel,
		install,
	};

	return {
		plugin,
		getEvents: eventStore.getSnapshot,
		getBookmarkedEventIds: bookmarksStore.getSnapshot,
		toggleBookmark,
		clear: () => {
			eventStore.clear();
			bookmarksStore.set(Object.freeze([]));
		},
	};
}

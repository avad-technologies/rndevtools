import { ExternalStore } from '../core/external-store';
import { redactDiagnosticText, sanitizeDiagnosticValue } from '../core/redact';
import { serializeValue, truncateText } from '../core/serialize';

export type NavigationEvent = {
	id: number;
	at: number;
	route: string;
	segments?: readonly string[];
	metadata?: Readonly<Record<string, unknown>>;
};

export type NavigationTransitionPhase =
	| 'requested'
	| 'committed'
	| 'focused'
	| 'failed';

type NavigationTransitionSource =
	| 'app'
	| 'panel'
	| 'desktop'
	| 'scenario'
	| 'restore'
	| 'deep-link';

export type NavigationTransitionContext = Readonly<{
	correlationId?: string;
	source?: NavigationTransitionSource;
}>;

export type NavigationTransitionEvent = Readonly<{
	id: string;
	transitionId: string;
	at: number;
	phase: NavigationTransitionPhase;
	route: string;
	source: NavigationTransitionSource;
	correlationId?: string;
	durationMs?: number;
	error?: string;
}>;

export type NavigationAction = {
	id: string;
	title: string;
	run: () => unknown | Promise<unknown>;
};

export type NavigationRouteKind =
	| 'static'
	| 'dynamic'
	| 'catchAll'
	| 'layout'
	| 'group'
	| 'internal';

export type NavigationRouteDescriptor = {
	id: string;
	path: string;
	kind: NavigationRouteKind;
	filename?: string;
	isInitial?: boolean;
	isInternal?: boolean;
};

export type NavigationStackEntry = {
	key: string;
	name: string;
	path?: string;
	depth: number;
	visible: boolean;
	params?: Readonly<Record<string, unknown>>;
};

export type ScreensSessionState = {
	pinnedPaths: readonly string[];
	lastParamValues: Readonly<Record<string, string>>;
};

export const DEFAULT_MAX_ROUTES = 500;
export const DEFAULT_MAX_STACK_ENTRIES = 100;
export const DEFAULT_MAX_CATALOG_BYTES = 1024 * 1024;
export const MAX_NAVIGATION_ROUTES = 10_000;
export const MAX_NAVIGATION_STACK_ENTRIES = 1_000;
export const MAX_NAVIGATION_CATALOG_BYTES = 16 * 1024 * 1024;
export const MAX_NAVIGATION_EVENTS = 10_000;
const MAX_ROUTE_TEXT_BYTES = 4 * 1024;
const MAX_METADATA_BYTES = 16 * 1024;
const MAX_PINNED_ROUTES = 32;
const MAX_REMEMBERED_PARAMS = 100;
const MAX_PARAM_VALUE_BYTES = 1024;
const NAVIGATION_TRANSITION_SOURCES = new Set<NavigationTransitionSource>([
	'app',
	'panel',
	'desktop',
	'scenario',
	'restore',
	'deep-link',
]);

/** Session state is shared by the panel and its pill quick actions. */
const screensSessionStores = new Map<
	string,
	ExternalStore<ScreensSessionState>
>();

export function getScreensSessionStore(
	pluginId = 'navigation',
): ExternalStore<ScreensSessionState> {
	let store = screensSessionStores.get(pluginId);
	if (!store) {
		store = new ExternalStore<ScreensSessionState>({
			pinnedPaths: [],
			lastParamValues: {},
		});
		screensSessionStores.set(pluginId, store);
	}
	return store;
}

export function getPinnedRoutes(pluginId = 'navigation'): readonly string[] {
	return getScreensSessionStore(pluginId).getSnapshot().pinnedPaths;
}

export function subscribePinnedRoutes(
	listener: () => void,
	pluginId = 'navigation',
): () => void {
	return getScreensSessionStore(pluginId).subscribe(listener);
}

export function setRoutePinned(
	path: string,
	pinned: boolean,
	pluginId = 'navigation',
): void {
	const store = getScreensSessionStore(pluginId);
	const normalizedPath = normalizeNavigationText(path);
	if (!normalizedPath) return;
	const state = store.getSnapshot();
	if (pinned === state.pinnedPaths.includes(normalizedPath)) return;
	store.set({
		...state,
		pinnedPaths: pinned
			? [...state.pinnedPaths, normalizedPath].slice(-MAX_PINNED_ROUTES)
			: state.pinnedPaths.filter((candidate) => candidate !== normalizedPath),
	});
}

export function rememberParamValues(
	store: ExternalStore<ScreensSessionState>,
	values: Readonly<Record<string, string>>,
): void {
	const state = store.getSnapshot();
	const entries = Object.entries({ ...state.lastParamValues, ...values })
		.filter(([key, value]) => key.length > 0 && typeof value === 'string')
		.slice(-MAX_REMEMBERED_PARAMS)
		.map(([key, value]) => [
			truncateText(key, MAX_ROUTE_TEXT_BYTES).text,
			truncateText(redactDiagnosticText(value), MAX_PARAM_VALUE_BYTES).text,
		]);
	store.set({
		...state,
		lastParamValues: Object.fromEntries(entries),
	});
}

export function normalizeNavigationText(value: unknown): string {
	if (typeof value !== 'string') return '';
	return truncateText(redactDiagnosticText(value), MAX_ROUTE_TEXT_BYTES).text;
}

function sanitizeDiagnosticRecord(
	value: unknown,
): Readonly<Record<string, unknown>> | undefined {
	if (value === undefined) return undefined;
	const sanitized = sanitizeDiagnosticValue(value);
	if (
		typeof sanitized !== 'object' ||
		sanitized === null ||
		Array.isArray(sanitized)
	) {
		return { value: sanitized };
	}
	if (serializeValue(sanitized, MAX_METADATA_BYTES).truncated) {
		return { omitted: '[Diagnostic value exceeds size limit]' };
	}
	return sanitized as Readonly<Record<string, unknown>>;
}

export function positiveIntegerOption(
	value: number | undefined,
	fallback: number,
	name: string,
	maximum = Number.MAX_SAFE_INTEGER,
): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	if (value > maximum) throw new Error(`${name} cannot exceed ${maximum}`);
	return value;
}

function boundedCollection<T>(
	values: readonly T[],
	maxEntries: number,
	maxBytes: number,
): readonly T[] {
	const retained: T[] = [];
	let retainedBytes = 0;
	for (const value of values) {
		if (retained.length >= maxEntries) break;
		const serialized = serializeValue(value, maxBytes);
		if (serialized.truncated) continue;
		if (retainedBytes + serialized.estimatedBytes > maxBytes) break;
		retained.push(value);
		retainedBytes += serialized.estimatedBytes;
	}
	return retained;
}

function ownDataValue(record: object, key: string): unknown {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(record, key);
		return descriptor && 'value' in descriptor ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

function arrayDataPrefix(value: unknown, maximum: number): readonly unknown[] {
	if (!Array.isArray(value)) return [];
	const length = ownDataValue(value, 'length');
	if (!Number.isSafeInteger(length) || (length as number) < 0) return [];
	const values: unknown[] = [];
	for (let index = 0; index < Math.min(length as number, maximum); index += 1) {
		const entry = ownDataValue(value, String(index));
		if (entry !== undefined) values.push(entry);
	}
	return values;
}

export function normalizeNavigationRecordOptions(value: unknown): {
	segments?: readonly string[];
	metadata?: Readonly<Record<string, unknown>>;
} {
	if (!value || typeof value !== 'object') return {};
	const segments = arrayDataPrefix(ownDataValue(value, 'segments'), 64)
		.map(normalizeNavigationText)
		.filter(Boolean);
	const metadata = sanitizeDiagnosticRecord(ownDataValue(value, 'metadata'));
	return {
		...(segments.length > 0 ? { segments } : {}),
		...(metadata === undefined ? {} : { metadata }),
	};
}

export function normalizeNavigationTransitionContext(
	value: unknown,
): NavigationTransitionContext {
	if (value === undefined) return {};
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	const rawCorrelationId = ownDataValue(value, 'correlationId');
	const rawSource = ownDataValue(value, 'source');
	const correlationId = normalizeNavigationText(rawCorrelationId);
	const source = NAVIGATION_TRANSITION_SOURCES.has(
		rawSource as NavigationTransitionSource,
	)
		? (rawSource as NavigationTransitionSource)
		: undefined;
	return {
		...(correlationId ? { correlationId } : {}),
		...(source ? { source } : {}),
	};
}

export function normalizeNavigationRoutes(
	value: unknown,
	maxRoutes: number,
	maxBytes: number,
): readonly NavigationRouteDescriptor[] {
	const seen = new Set<string>();
	const normalized: NavigationRouteDescriptor[] = [];
	for (const candidate of arrayDataPrefix(value, MAX_NAVIGATION_ROUTES)) {
		if (!candidate || typeof candidate !== 'object') continue;
		const path = normalizeNavigationText(ownDataValue(candidate, 'path'));
		const id = normalizeNavigationText(ownDataValue(candidate, 'id'));
		if (!path || !id) continue;
		const signature = `${id}\0${path}`;
		if (seen.has(signature)) continue;
		seen.add(signature);
		const filename = normalizeNavigationText(
			ownDataValue(candidate, 'filename'),
		);
		const isInitial = ownDataValue(candidate, 'isInitial') === true;
		const isInternal = ownDataValue(candidate, 'isInternal') === true;
		normalized.push({
			id,
			path,
			kind: inferNavigationRouteKind(path, isInternal),
			...(filename ? { filename } : {}),
			...(isInitial ? { isInitial: true } : {}),
			...(isInternal ? { isInternal: true } : {}),
		});
	}
	normalized.sort((left, right) => left.path.localeCompare(right.path));
	return boundedCollection(normalized, maxRoutes, maxBytes);
}

export function normalizeNavigationStack(
	value: unknown,
	maxEntries: number,
	maxBytes: number,
): readonly NavigationStackEntry[] {
	const normalized: NavigationStackEntry[] = [];
	for (const candidate of arrayDataPrefix(
		value,
		MAX_NAVIGATION_STACK_ENTRIES,
	)) {
		if (!candidate || typeof candidate !== 'object') continue;
		const key = normalizeNavigationText(ownDataValue(candidate, 'key'));
		const name = normalizeNavigationText(ownDataValue(candidate, 'name'));
		if (!key || !name) continue;
		const path = normalizeNavigationText(ownDataValue(candidate, 'path'));
		const rawDepth = ownDataValue(candidate, 'depth');
		const params = sanitizeDiagnosticRecord(ownDataValue(candidate, 'params'));
		normalized.push({
			key,
			name,
			...(path ? { path } : {}),
			depth:
				typeof rawDepth === 'number' &&
				Number.isInteger(rawDepth) &&
				rawDepth >= 0
					? Math.min(rawDepth, MAX_NAVIGATION_STACK_ENTRIES)
					: 0,
			visible: ownDataValue(candidate, 'visible') === true,
			...(params === undefined ? {} : { params }),
		});
	}
	return boundedCollection(normalized, maxEntries, maxBytes);
}

function isParamSegment(segment: string): boolean {
	return segment.startsWith('[') && segment.endsWith(']');
}

function paramNameFromSegment(segment: string): string {
	return segment.replace(/^\[+\.{0,3}|\]+$/g, '');
}

export function stripGroupParens(segment: string): string {
	return segment.replace(/^\(+|\)+$/g, '');
}

/** Derives a human name from the last meaningful path segment. */
export function navigationRouteDisplayName(path: string): string {
	const segments = path
		.split('/')
		.filter(
			(segment) => segment && segment !== 'index' && segment !== '_layout',
		);
	const last = segments.at(-1);
	if (!last) return 'Root';
	const words = paramNameFromSegment(stripGroupParens(last))
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.split(/[-_.\s]+/)
		.filter(Boolean);
	if (words.length === 0) return 'Root';
	return words
		.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
		.join(' ');
}

export function routeGroupLabel(path: string): string {
	const first = path.split('/').find((segment) => segment.length > 0);
	if (!first) return 'ROOT';
	const cleaned = paramNameFromSegment(stripGroupParens(first));
	return cleaned ? cleaned.toUpperCase() : 'ROOT';
}

export function routeParamNames(path: string): readonly string[] {
	return path.split('/').filter(isParamSegment).map(paramNameFromSegment);
}

function encodePathValue(value: string): string {
	let wellFormed = '';
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				wellFormed += value[index] ?? '';
				wellFormed += value[index + 1] ?? '';
				index += 1;
			} else wellFormed += '\uFFFD';
		} else if (code >= 0xdc00 && code <= 0xdfff) wellFormed += '\uFFFD';
		else wellFormed += value[index] ?? '';
	}
	return encodeURIComponent(wellFormed);
}

/** Substitutes and URL-encodes dynamic route values without changing route groups. */
export function buildNavigationRoutePath(
	path: string,
	values: Readonly<Record<string, string>>,
): string {
	return path
		.split('/')
		.map((segment) => {
			if (!isParamSegment(segment)) return segment;
			const value = ownDataValue(values, paramNameFromSegment(segment));
			if (typeof value !== 'string') return segment;
			if (segment.startsWith('[...') || segment.startsWith('[[...')) {
				return value.split('/').map(encodePathValue).join('/');
			}
			return encodePathValue(value);
		})
		.join('/');
}

export function routeMatches(path: string, needle: string): boolean {
	if (!needle) return true;
	return (
		path.toLowerCase().includes(needle) ||
		navigationRouteDisplayName(path).toLowerCase().includes(needle)
	);
}

export function truncateMiddleValue(value: string, maxLength = 18): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength - 1)}…`;
}

export function inferNavigationRouteKind(
	path: string,
	isInternal = false,
): NavigationRouteKind {
	if (isInternal) return 'internal';
	if (path.endsWith('/_layout') || path === '_layout') return 'layout';
	if (path.includes('[...') || path.includes('[[...')) return 'catchAll';
	if (path.includes('[')) return 'dynamic';
	if (
		path
			.split('/')
			.some((segment) => segment.startsWith('(') && segment.endsWith(')'))
	)
		return 'group';
	return 'static';
}

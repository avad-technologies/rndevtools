import { ExternalStore } from '../core/external-store';
import { redactDiagnosticText } from '../core/redact';
import { truncateText, utf8ByteLength } from '../core/serialize';
import type {
	RestorePoint,
	RestorePointSourceSnapshot,
} from './restore-points';

export const DEFAULT_RESTORE_POINTS_KEY = '@rndevtools/core/restore-points/v1';

export type RestorePointStorage = Readonly<{
	getItem: (
		key: string,
	) => string | null | undefined | Promise<string | null | undefined>;
	setItem: (key: string, value: string) => void | Promise<void>;
	removeItem?: (key: string) => void | Promise<void>;
}>;

export type RestorePointRepositoryOptions = Readonly<{
	storage?: RestorePointStorage;
	key?: string;
	maxPoints: number;
	maxSourceBytes: number;
	maxTotalBytes: number;
}>;

export type RestorePointImportMode = 'replace' | 'merge';

type PersistedRestorePoints = Readonly<{
	schemaVersion: 1;
	namespace: 'rndevtools-restore-points';
	points: readonly RestorePoint[];
}>;

const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_ENTRIES = 100_000;
const MAX_SOURCE_COUNT = 50;
const MAX_POINT_COUNT = 50;
const MAX_ID_BYTES = 256;
const MAX_LABEL_BYTES = 256;
const MAX_TITLE_BYTES = 4 * 1024;
const ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value: unknown, label: string, maxBytes: number): string {
	if (
		typeof value !== 'string' ||
		!value.trim() ||
		value !== value.trim() ||
		utf8ByteLength(value) > maxBytes
	) {
		throw new Error(`${label} is invalid or exceeds ${maxBytes} bytes.`);
	}
	return value;
}

function validateJsonTree(
	value: unknown,
	path: string,
	state: { remaining: number },
	depth: number,
): void {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean'
	) {
		return;
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new Error(`${path} is not finite.`);
		return;
	}
	if (!value || typeof value !== 'object') {
		throw new Error(`${path} is not JSON-compatible.`);
	}
	if (depth >= MAX_JSON_DEPTH) {
		throw new Error(`${path} exceeds the restore-point depth limit.`);
	}
	const entries = Array.isArray(value)
		? value.map((entry, index) => [String(index), entry] as const)
		: Object.entries(value);
	if (entries.length > state.remaining) {
		throw new Error(`${path} exceeds the restore-point entry limit.`);
	}
	state.remaining -= entries.length;
	for (const [key, entry] of entries) {
		if (!Array.isArray(value) && DANGEROUS_KEYS.has(key)) {
			throw new Error(`${path}.${key} is not allowed in restore-point data.`);
		}
		validateJsonTree(entry, `${path}.${key}`, state, depth + 1);
	}
}

function parseSnapshot(
	value: unknown,
	maxSourceBytes: number,
): RestorePointSourceSnapshot {
	if (!isRecord(value)) throw new Error('Restore source snapshot is invalid.');
	const sourceId = boundedText(
		value.sourceId,
		'Restore source id',
		MAX_ID_BYTES,
	);
	if (!ID_PATTERN.test(sourceId))
		throw new Error('Restore source id is invalid.');
	const sourceTitle = boundedText(
		value.sourceTitle,
		'Restore source title',
		MAX_TITLE_BYTES,
	);
	if (typeof value.json !== 'string') {
		throw new Error('Restore source JSON is missing.');
	}
	const bytes = utf8ByteLength(value.json);
	if (bytes > maxSourceBytes) {
		throw new Error('Restore source JSON exceeds the configured limit.');
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(value.json);
	} catch {
		throw new Error('Restore source JSON is malformed.');
	}
	validateJsonTree(parsed, '$', { remaining: MAX_JSON_ENTRIES }, 0);
	return {
		sourceId,
		sourceTitle,
		json: value.json,
		preview: truncateText(
			redactDiagnosticText(value.json),
			Math.min(maxSourceBytes, 8 * 1024),
		).text,
		bytes,
	};
}

export function estimateRestorePointBytes(
	point: Omit<RestorePoint, 'estimatedBytes'>,
): number {
	let estimatedBytes = 0;
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const next = utf8ByteLength(JSON.stringify({ ...point, estimatedBytes }));
		if (next === estimatedBytes) break;
		estimatedBytes = next;
	}
	return estimatedBytes;
}

function parsePoint(value: unknown, maxSourceBytes: number): RestorePoint {
	if (!isRecord(value)) throw new Error('Restore point is invalid.');
	const id = boundedText(value.id, 'Restore point id', MAX_ID_BYTES);
	if (!ID_PATTERN.test(id)) throw new Error('Restore point id is invalid.');
	const label = boundedText(
		value.label,
		'Restore point label',
		MAX_LABEL_BYTES,
	);
	if (
		!Number.isSafeInteger(value.createdAt) ||
		(value.createdAt as number) <= 0
	) {
		throw new Error('Restore point timestamp is invalid.');
	}
	if (
		!Array.isArray(value.sources) ||
		value.sources.length < 1 ||
		value.sources.length > MAX_SOURCE_COUNT
	) {
		throw new Error('Restore point sources are invalid.');
	}
	const sourceIds = new Set<string>();
	const sources = value.sources.map((snapshot) => {
		const parsed = parseSnapshot(snapshot, maxSourceBytes);
		if (sourceIds.has(parsed.sourceId)) {
			throw new Error(`Duplicate restore source: ${parsed.sourceId}`);
		}
		sourceIds.add(parsed.sourceId);
		return parsed;
	});
	const pointWithoutSize = {
		id,
		label,
		createdAt: value.createdAt as number,
		sources,
	};
	return {
		...pointWithoutSize,
		estimatedBytes: estimateRestorePointBytes(pointWithoutSize),
	};
}

function documentFor(points: readonly RestorePoint[]): PersistedRestorePoints {
	return {
		schemaVersion: 1,
		namespace: 'rndevtools-restore-points',
		points,
	};
}

function parseDocument(
	value: string,
	maxSourceBytes: number,
	allowPartial: boolean,
): { points: readonly RestorePoint[]; discarded: number } {
	if (!value || utf8ByteLength(value) > MAX_DOCUMENT_BYTES) {
		throw new Error('Restore-point document is empty or oversized.');
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error('Restore-point document is malformed.');
	}
	if (
		!isRecord(parsed) ||
		parsed.schemaVersion !== 1 ||
		parsed.namespace !== 'rndevtools-restore-points' ||
		!Array.isArray(parsed.points)
	) {
		throw new Error('Restore-point document has an unsupported schema.');
	}
	if (parsed.points.length > MAX_POINT_COUNT) {
		throw new Error('Restore-point document exceeds the point-count limit.');
	}
	const ids = new Set<string>();
	const points: RestorePoint[] = [];
	let discarded = 0;
	for (const candidate of parsed.points) {
		try {
			const point = parsePoint(candidate, maxSourceBytes);
			if (ids.has(point.id)) throw new Error('Duplicate restore point id.');
			ids.add(point.id);
			points.push(point);
		} catch (error) {
			if (!allowPartial) throw error;
			discarded += 1;
		}
	}
	return { points, discarded };
}

function retainWithinLimits(
	points: readonly RestorePoint[],
	maxPoints: number,
	maxTotalBytes: number,
): readonly RestorePoint[] {
	const retained = [...points].sort(
		(left, right) => left.createdAt - right.createdAt,
	);
	let totalBytes = retained.reduce(
		(sum, point) => sum + point.estimatedBytes,
		0,
	);
	while (
		retained.length > maxPoints ||
		(totalBytes > maxTotalBytes && retained.length > 0)
	) {
		totalBytes -= retained.shift()?.estimatedBytes ?? 0;
	}
	return retained;
}

function validateRepositoryPoints(
	points: readonly RestorePoint[],
	maxPoints: number,
	maxTotalBytes: number,
): void {
	if (
		!Array.isArray(points) ||
		points.length > maxPoints ||
		points.length > MAX_POINT_COUNT
	) {
		throw new Error('Restore points exceed the repository count limit.');
	}
	const ids = new Set<string>();
	let totalBytes = 0;
	for (const point of points) {
		if (ids.has(point.id)) {
			throw new Error(`Duplicate restore point id: ${point.id}`);
		}
		ids.add(point.id);
		if (
			!Number.isSafeInteger(point.estimatedBytes) ||
			point.estimatedBytes < 0 ||
			point.estimatedBytes > maxTotalBytes
		) {
			throw new Error('Restore point exceeds the repository byte limit.');
		}
		totalBytes += point.estimatedBytes;
		if (!Number.isSafeInteger(totalBytes) || totalBytes > maxTotalBytes) {
			throw new Error('Restore points exceed the repository byte limit.');
		}
	}
}

export class RestorePointRepository {
	readonly #store = new ExternalStore<readonly RestorePoint[]>([]);
	readonly #storage?: RestorePointStorage;
	readonly #key: string;
	readonly #maxPoints: number;
	readonly #maxSourceBytes: number;
	readonly #maxTotalBytes: number;
	#serial: Promise<void> = Promise.resolve();
	#nextId = 1;
	#loadError?: string;
	readonly ready: Promise<void>;

	constructor(options: RestorePointRepositoryOptions) {
		if (
			!Number.isSafeInteger(options.maxPoints) ||
			options.maxPoints < 1 ||
			options.maxPoints > MAX_POINT_COUNT
		) {
			throw new Error(`maxPoints must be between 1 and ${MAX_POINT_COUNT}.`);
		}
		if (
			!Number.isSafeInteger(options.maxSourceBytes) ||
			options.maxSourceBytes < 1 ||
			options.maxSourceBytes > MAX_DOCUMENT_BYTES
		) {
			throw new Error('maxSourceBytes is outside the supported range.');
		}
		if (
			!Number.isSafeInteger(options.maxTotalBytes) ||
			options.maxTotalBytes < 1 ||
			options.maxTotalBytes > MAX_DOCUMENT_BYTES
		) {
			throw new Error('maxTotalBytes is outside the supported range.');
		}
		this.#storage = options.storage;
		this.#key = options.key ?? DEFAULT_RESTORE_POINTS_KEY;
		this.#maxPoints = options.maxPoints;
		this.#maxSourceBytes = options.maxSourceBytes;
		this.#maxTotalBytes = options.maxTotalBytes;
		this.ready = this.#hydrate();
	}

	readonly subscribe = (listener: () => void): (() => void) =>
		this.#store.subscribe(listener);

	readonly getSnapshot = (): readonly RestorePoint[] =>
		this.#store.getSnapshot();

	readonly getServerSnapshot = (): readonly RestorePoint[] =>
		this.#store.getServerSnapshot();

	getLoadError(): string | undefined {
		return this.#loadError;
	}

	async add(point: RestorePoint): Promise<RestorePoint> {
		const parsed = parsePoint(point, this.#maxSourceBytes);
		if (parsed.estimatedBytes > this.#maxTotalBytes) {
			throw new Error('Restore point exceeds the repository byte limit.');
		}
		await this.#mutate((points) => {
			if (points.some((candidate) => candidate.id === parsed.id)) {
				throw new Error('Restore point id already exists.');
			}
			return retainWithinLimits(
				[...points, parsed],
				this.#maxPoints,
				this.#maxTotalBytes,
			);
		});
		return parsed;
	}

	async rename(id: string, label: string): Promise<RestorePoint> {
		const nextLabel = boundedText(
			label.trim(),
			'Restore point label',
			MAX_LABEL_BYTES,
		);
		let renamed: RestorePoint | undefined;
		await this.#mutate((points) =>
			points.map((point) => {
				if (point.id !== id) return point;
				const pointWithoutSize = { ...point, label: nextLabel };
				const { estimatedBytes: _estimatedBytes, ...withoutSize } =
					pointWithoutSize;
				renamed = {
					...withoutSize,
					estimatedBytes: estimateRestorePointBytes(withoutSize),
				};
				return renamed;
			}),
		);
		if (!renamed) throw new Error('Restore point is no longer available.');
		return renamed;
	}

	async duplicate(id: string, label?: string): Promise<RestorePoint> {
		await this.ready;
		const source = this.#store
			.getSnapshot()
			.find((candidate) => candidate.id === id);
		if (!source) throw new Error('Restore point is no longer available.');
		const createdAt = Date.now();
		const pointWithoutSize = {
			id: this.createId(createdAt),
			label: truncateText(
				redactDiagnosticText(label?.trim() || `${source.label} copy`),
				MAX_LABEL_BYTES,
			).text,
			createdAt,
			sources: source.sources.map((snapshot) => ({ ...snapshot })),
		};
		const duplicate: RestorePoint = {
			...pointWithoutSize,
			estimatedBytes: estimateRestorePointBytes(pointWithoutSize),
		};
		return this.add(duplicate);
	}

	async remove(id: string): Promise<void> {
		await this.#mutate((points) => {
			if (!points.some((candidate) => candidate.id === id)) {
				throw new Error('Restore point is no longer available.');
			}
			return points.filter((candidate) => candidate.id !== id);
		});
	}

	async clear(): Promise<void> {
		await this.#mutate(() => []);
	}

	exportJson(): string {
		return JSON.stringify(documentFor(this.#store.getSnapshot()), null, 2);
	}

	async importJson(
		value: string,
		mode: RestorePointImportMode = 'replace',
	): Promise<readonly RestorePoint[]> {
		if (mode !== 'replace' && mode !== 'merge') {
			throw new Error('Restore-point import mode is invalid.');
		}
		const imported = parseDocument(value, this.#maxSourceBytes, false).points;
		await this.#mutate((points) => {
			const combined = mode === 'merge' ? [...points, ...imported] : imported;
			const ids = new Set<string>();
			for (const point of combined) {
				if (ids.has(point.id)) {
					throw new Error(`Duplicate restore point id: ${point.id}`);
				}
				ids.add(point.id);
			}
			const retained = retainWithinLimits(
				combined,
				this.#maxPoints,
				this.#maxTotalBytes,
			);
			if (retained.length !== combined.length) {
				throw new Error('Imported restore points exceed repository limits.');
			}
			return retained;
		});
		return imported;
	}

	createId(createdAt = Date.now()): string {
		const id = `${createdAt.toString(36)}-${this.#nextId.toString(36)}`;
		this.#nextId += 1;
		return id;
	}

	async #hydrate(): Promise<void> {
		if (!this.#storage) return;
		try {
			const raw = await this.#storage.getItem(this.#key);
			if (!raw) return;
			const parsed = parseDocument(raw, this.#maxSourceBytes, true);
			const retained = retainWithinLimits(
				parsed.points,
				this.#maxPoints,
				this.#maxTotalBytes,
			);
			this.#store.set(retained);
			if (parsed.discarded > 0 || retained.length !== parsed.points.length) {
				await this.#storage.setItem(
					this.#key,
					JSON.stringify(documentFor(retained)),
				);
			}
		} catch (error) {
			this.#loadError =
				error instanceof Error
					? error.message
					: 'Restore points could not be loaded.';
		}
	}

	#mutate(
		operation: (points: readonly RestorePoint[]) => readonly RestorePoint[],
	): Promise<void> {
		const run = this.#serial.then(async () => {
			await this.ready;
			const previous = this.#store.getSnapshot();
			const next = operation(previous);
			validateRepositoryPoints(next, this.#maxPoints, this.#maxTotalBytes);
			if (this.#storage) {
				await this.#storage.setItem(
					this.#key,
					JSON.stringify(documentFor(next)),
				);
			}
			this.#store.set(next);
		});
		this.#serial = run.catch(() => undefined);
		return run;
	}
}

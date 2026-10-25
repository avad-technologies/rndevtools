import { randomUUID } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
	BuildInsight,
	BuildInsightSource,
	BuildInsightsState,
	BuildInsightsStats,
} from '../shared/build-insights-protocol';
import {
	buildInsightSchema,
	buildInsightSourceSchema,
	buildInsightsStateSchema,
} from '../shared/build-insights-protocol';

const RETENTION_MONTHS = 12;
const MAX_PUBLIC_BUILDS = 2_000;

type StoredSource = BuildInsightSource & { sourcePath: string };
type StoredBuildInput = Omit<
	BuildInsight,
	'id' | 'sourceId' | 'sourceLabel'
> & {
	artifactPath: string;
};

export class BuildInsightsStore {
	readonly #root: string;
	readonly #now: () => number;
	#database: DatabaseSync | undefined;
	#revision = 0;

	constructor(root: string, { now = Date.now }: { now?: () => number } = {}) {
		this.#root = path.resolve(root);
		this.#now = now;
	}

	async start(): Promise<void> {
		await mkdir(this.#root, { recursive: true, mode: 0o700 });
		await chmod(this.#root, 0o700);
		const database = new DatabaseSync(
			path.join(this.#root, 'build-insights.sqlite'),
			{
				allowExtension: false,
				readOnly: false,
			}
		);
		database.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA foreign_keys = ON;
			PRAGMA synchronous = FULL;
			CREATE TABLE IF NOT EXISTS sources (
				id TEXT PRIMARY KEY,
				label TEXT NOT NULL,
				kind TEXT NOT NULL CHECK (kind IN ('xcresult', 'derived-data-root')),
				source_path TEXT NOT NULL UNIQUE,
				added_at INTEGER NOT NULL,
				last_scanned_at INTEGER,
				status TEXT NOT NULL CHECK (status IN ('ready', 'scanning', 'error')),
				error TEXT
			) STRICT;
			CREATE TABLE IF NOT EXISTS builds (
				id TEXT PRIMARY KEY,
				source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
				artifact_path TEXT NOT NULL UNIQUE,
				name TEXT NOT NULL,
				configuration TEXT,
				scheme TEXT,
				destination TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				started_at INTEGER NOT NULL,
				ended_at INTEGER NOT NULL,
				duration_ms REAL NOT NULL,
				status TEXT NOT NULL,
				classification TEXT NOT NULL,
				classification_confidence TEXT NOT NULL,
				warnings INTEGER NOT NULL,
				errors INTEGER NOT NULL,
				analyzer_warnings INTEGER NOT NULL,
				xcode_version TEXT
			) STRICT;
			CREATE INDEX IF NOT EXISTS builds_created_at ON builds(created_at DESC);
			CREATE INDEX IF NOT EXISTS builds_source_id ON builds(source_id);
		`);
		this.#database = database;
		this.prune();
		this.#touch();
	}

	stop(): void {
		this.#database?.close();
		this.#database = undefined;
	}

	upsertSource({
		sourcePath,
		label,
		kind,
	}: {
		sourcePath: string;
		label: string;
		kind: BuildInsightSource['kind'];
	}): StoredSource {
		const database = this.#requireDatabase();
		const existing = database
			.prepare('SELECT id FROM sources WHERE source_path = ?')
			.get(sourcePath) as { id?: unknown } | undefined;
		const id =
			typeof existing?.id === 'string'
				? existing.id
				: `build-source-${randomUUID()}`;
		const source = buildInsightSourceSchema.parse({
			id,
			label,
			kind,
			addedAt: this.#now(),
			status: 'ready',
		});
		database
			.prepare(`
				INSERT INTO sources (id, label, kind, source_path, added_at, status)
				VALUES (?, ?, ?, ?, ?, 'ready')
				ON CONFLICT(source_path) DO UPDATE SET label = excluded.label, kind = excluded.kind
			`)
			.run(source.id, source.label, source.kind, sourcePath, source.addedAt);
		this.#touch();
		return this.getStoredSource(id) as StoredSource;
	}

	getStoredSource(sourceId: string): StoredSource | undefined {
		const row = this.#requireDatabase()
			.prepare('SELECT * FROM sources WHERE id = ?')
			.get(sourceId) as Record<string, unknown> | undefined;
		return row ? sourceFromRow(row) : undefined;
	}

	listStoredSources(): StoredSource[] {
		return (
			this.#requireDatabase()
				.prepare('SELECT * FROM sources ORDER BY added_at ASC')
				.all() as Array<Record<string, unknown>>
		).map(sourceFromRow);
	}

	updateSource(
		sourceId: string,
		update: {
			status: BuildInsightSource['status'];
			lastScannedAt?: number;
			error?: string;
		}
	): void {
		this.#requireDatabase()
			.prepare(
				'UPDATE sources SET status = ?, last_scanned_at = ?, error = ? WHERE id = ?'
			)
			.run(
				update.status,
				update.lastScannedAt ?? null,
				update.error ?? null,
				sourceId
			);
		this.#touch();
	}

	insertBuild(source: StoredSource, input: StoredBuildInput): boolean {
		const { artifactPath, ...publicInput } = input;
		const build = buildInsightSchema.parse({
			id: `build-${randomUUID()}`,
			sourceId: source.id,
			sourceLabel: source.label,
			...publicInput,
		});
		const result = this.#requireDatabase()
			.prepare(`
				INSERT INTO builds (
					id, source_id, artifact_path, name, configuration, scheme, destination,
					created_at, started_at, ended_at, duration_ms, status, classification,
					classification_confidence, warnings, errors, analyzer_warnings, xcode_version
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(artifact_path) DO UPDATE SET
					source_id = excluded.source_id,
					name = excluded.name,
					configuration = excluded.configuration,
					scheme = excluded.scheme,
					destination = excluded.destination,
					created_at = excluded.created_at,
					started_at = excluded.started_at,
					ended_at = excluded.ended_at,
					duration_ms = excluded.duration_ms,
					status = excluded.status,
					classification = excluded.classification,
					classification_confidence = excluded.classification_confidence,
					warnings = excluded.warnings,
					errors = excluded.errors,
					analyzer_warnings = excluded.analyzer_warnings,
					xcode_version = excluded.xcode_version
				WHERE
					builds.source_id IS NOT excluded.source_id OR
					builds.name IS NOT excluded.name OR
					builds.configuration IS NOT excluded.configuration OR
					builds.scheme IS NOT excluded.scheme OR
					builds.destination IS NOT excluded.destination OR
					builds.created_at IS NOT excluded.created_at OR
					builds.started_at IS NOT excluded.started_at OR
					builds.ended_at IS NOT excluded.ended_at OR
					builds.duration_ms IS NOT excluded.duration_ms OR
					builds.status IS NOT excluded.status OR
					builds.classification IS NOT excluded.classification OR
					builds.classification_confidence IS NOT excluded.classification_confidence OR
					builds.warnings IS NOT excluded.warnings OR
					builds.errors IS NOT excluded.errors OR
					builds.analyzer_warnings IS NOT excluded.analyzer_warnings OR
					builds.xcode_version IS NOT excluded.xcode_version
			`)
			.run(
				build.id,
				build.sourceId,
				artifactPath,
				build.name,
				build.configuration ?? null,
				build.scheme ?? null,
				build.destination,
				build.createdAt,
				build.startedAt,
				build.endedAt,
				build.durationMs,
				build.status,
				build.classification,
				build.classificationConfidence,
				build.warnings,
				build.errors,
				build.analyzerWarnings,
				build.xcodeVersion ?? null
			);
		const inserted = Number(result.changes) > 0;
		if (inserted) this.#touch();
		return inserted;
	}

	prune(): void {
		const cutoffDate = new Date(this.#now());
		cutoffDate.setUTCMonth(cutoffDate.getUTCMonth() - RETENTION_MONTHS);
		const result = this.#requireDatabase()
			.prepare('DELETE FROM builds WHERE created_at < ?')
			.run(cutoffDate.getTime());
		if (Number(result.changes) > 0) this.#touch();
	}

	getState(): BuildInsightsState {
		const database = this.#requireDatabase();
		const sources = this.listStoredSources().map(
			({ sourcePath: _sourcePath, ...source }) => source
		);
		const builds = (
			database
				.prepare(`
					SELECT builds.*, sources.label AS source_label
					FROM builds JOIN sources ON sources.id = builds.source_id
					ORDER BY builds.created_at DESC LIMIT ?
				`)
				.all(MAX_PUBLIC_BUILDS) as Array<Record<string, unknown>>
		).map(buildFromRow);
		const statisticRows = database
			.prepare(
				'SELECT duration_ms, status, created_at FROM builds ORDER BY duration_ms ASC'
			)
			.all() as Array<Record<string, unknown>>;
		return buildInsightsStateSchema.parse({
			revision: this.#revision,
			updatedAt: this.#now(),
			retentionMonths: RETENTION_MONTHS,
			sources,
			builds,
			stats: buildStats(statisticRows, this.#now()),
		});
	}

	#requireDatabase(): DatabaseSync {
		if (!this.#database) throw new Error('Build Insights storage is not open.');
		return this.#database;
	}

	#touch(): void {
		this.#revision += 1;
	}
}

function sourceFromRow(row: Record<string, unknown>): StoredSource {
	return {
		id: String(row.id),
		label: String(row.label),
		kind: row.kind === 'xcresult' ? 'xcresult' : 'derived-data-root',
		sourcePath: String(row.source_path),
		addedAt: Number(row.added_at),
		...(row.last_scanned_at === null || row.last_scanned_at === undefined
			? {}
			: { lastScannedAt: Number(row.last_scanned_at) }),
		status:
			row.status === 'scanning' || row.status === 'error'
				? row.status
				: 'ready',
		...(typeof row.error === 'string' ? { error: row.error } : {}),
	};
}

function buildFromRow(row: Record<string, unknown>): BuildInsight {
	return {
		id: String(row.id),
		sourceId: String(row.source_id),
		sourceLabel: String(row.source_label),
		name: String(row.name),
		...(typeof row.configuration === 'string'
			? { configuration: row.configuration }
			: {}),
		...(typeof row.scheme === 'string' ? { scheme: row.scheme } : {}),
		destination: String(row.destination),
		createdAt: Number(row.created_at),
		startedAt: Number(row.started_at),
		endedAt: Number(row.ended_at),
		durationMs: Number(row.duration_ms),
		status:
			row.status === 'succeeded' ||
			row.status === 'failed' ||
			row.status === 'cancelled'
				? row.status
				: 'unknown',
		classification:
			row.classification === 'clean' || row.classification === 'incremental'
				? row.classification
				: 'unknown',
		classificationConfidence:
			row.classification_confidence === 'confirmed' ||
			row.classification_confidence === 'inferred'
				? row.classification_confidence
				: 'unknown',
		warnings: Number(row.warnings),
		errors: Number(row.errors),
		analyzerWarnings: Number(row.analyzer_warnings),
		...(typeof row.xcode_version === 'string'
			? { xcodeVersion: row.xcode_version }
			: {}),
	};
}

function percentile(values: number[], fraction: number): number | undefined {
	if (values.length === 0) return undefined;
	const index = Math.min(
		values.length - 1,
		Math.ceil(values.length * fraction) - 1
	);
	return values[index];
}

function buildStats(
	rows: Array<Record<string, unknown>>,
	now: number
): BuildInsightsStats {
	const builds = rows.map((row) => ({
		durationMs: Number(row.duration_ms),
		status: String(row.status),
		createdAt: Number(row.created_at),
	}));
	const durations = builds.map((build) => build.durationMs);
	const medianDurationMs = percentile(durations, 0.5);
	const p75DurationMs = percentile(durations, 0.75);
	const p95DurationMs = percentile(durations, 0.95);
	const recent = builds.filter(
		(build) => build.createdAt >= now - 7 * 24 * 60 * 60 * 1_000
	);
	const activity = new Map<
		string,
		{ count: number; totalDurationMs: number }
	>();
	for (const build of builds) {
		const date = new Date(build.createdAt);
		const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
		const current = activity.get(month) ?? { count: 0, totalDurationMs: 0 };
		current.count += 1;
		current.totalDurationMs += build.durationMs;
		activity.set(month, current);
	}
	return {
		totalBuilds: builds.length,
		succeededBuilds: builds.filter((build) => build.status === 'succeeded')
			.length,
		...(medianDurationMs === undefined ? {} : { medianDurationMs }),
		...(p75DurationMs === undefined ? {} : { p75DurationMs }),
		...(p95DurationMs === undefined ? {} : { p95DurationMs }),
		...(recent.length === 0
			? {}
			: {
					sevenDayAverageMs:
						recent.reduce((total, build) => total + build.durationMs, 0) /
						recent.length,
				}),
		activity: [...activity.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.slice(-12)
			.map(([month, value]) => ({ month, ...value })),
	};
}

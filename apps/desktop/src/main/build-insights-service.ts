import { type FSWatcher, watch } from 'node:fs';
import { lstat, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type {
	BuildInsight,
	BuildInsightSource,
	BuildInsightsState,
} from '../shared/build-insights-protocol';
import { buildInsightSchema } from '../shared/build-insights-protocol';
import type { BuildInsightsStore } from './build-insights-store';
import { safeErrorText } from './security';
import { runSimulatorCommand } from './simulator-command-runner';

const MAX_XCRESULT_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_SCAN_ENTRIES = 5_000;
const MAX_SCAN_RESULTS = 100;
const MAX_SCAN_DEPTH = 4;
const WATCH_DEBOUNCE_MS = 1_500;
/** Build results remembered as read, so a rescan can skip them. */
const MAX_REMEMBERED_ARTIFACTS = 1_000;
const SPREADSHEET_FORMULA_PREFIXES = new Set([
	'=',
	'+',
	'-',
	'@',
	'\t',
	'\r',
	'\n',
]);

const externalDestinationSchema = z
	.object({
		deviceName: z.string().max(128).optional(),
		platform: z.string().max(64).optional(),
		osVersion: z.string().max(64).optional(),
		architecture: z.string().max(64).optional(),
	})
	.optional();
const externalBuildResultSchema = z.object({
	actionTitle: z.string().max(128).optional(),
	destination: externalDestinationSchema,
	startTime: z.union([z.number(), z.string().max(128)]).optional(),
	endTime: z.union([z.number(), z.string().max(128)]).optional(),
	status: z.string().max(64).optional(),
	warningCount: z.number().int().nonnegative().max(1_000_000).optional(),
	errorCount: z.number().int().nonnegative().max(1_000_000).optional(),
	analyzerWarningCount: z
		.number()
		.int()
		.nonnegative()
		.max(1_000_000)
		.optional(),
});
const projectedBuildInsightSchema = buildInsightSchema.omit({
	id: true,
	sourceId: true,
	sourceLabel: true,
});

type BuildInsightsListener = (state: BuildInsightsState) => void;
type XcresultRunner = (
	artifactPath: string,
	signal?: AbortSignal
) => Promise<unknown>;
type WatchFactory = (
	sourcePath: string,
	/** Gets the changed path relative to the root, or null when unknown. */
	listener: (filename: string | null) => void
) => FSWatcher;

/** A refresh of one source and whether another pass was asked for meanwhile. */
type SourceRefresh = { again: boolean; done: Promise<void> };

export class BuildInsightsService {
	readonly #store: BuildInsightsStore;
	readonly #runXcresult: XcresultRunner;
	readonly #watchFactory: WatchFactory;
	readonly #now: () => number;
	readonly #listeners = new Set<BuildInsightsListener>();
	readonly #watchers = new Map<string, FSWatcher>();
	readonly #watchTimers = new Map<string, NodeJS.Timeout>();
	readonly #watchErrors = new Map<string, string>();
	readonly #sourceRefreshes = new Map<string, SourceRefresh>();
	/** How each scanned build result looked when it was read, by source and path. */
	readonly #readArtifacts = new Map<string, string>();
	#stopped = false;

	constructor({
		store,
		runXcresult = readXcresult,
		watchFactory = (sourcePath, listener) =>
			watch(sourcePath, { recursive: true }, (_event, filename) =>
				listener(filename)
			),
		now = Date.now,
	}: {
		store: BuildInsightsStore;
		runXcresult?: XcresultRunner;
		watchFactory?: WatchFactory;
		now?: () => number;
	}) {
		this.#store = store;
		this.#runXcresult = runXcresult;
		this.#watchFactory = watchFactory;
		this.#now = now;
	}

	async start(): Promise<void> {
		this.#stopped = false;
		await this.#store.start();
		for (const source of this.#store.listStoredSources()) {
			if (source.kind === 'derived-data-root') this.#watchSource(source);
		}
		this.#emit();
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		for (const timer of this.#watchTimers.values()) clearTimeout(timer);
		this.#watchTimers.clear();
		for (const watcher of this.#watchers.values()) watcher.close();
		this.#watchers.clear();
		this.#watchErrors.clear();
		this.#store.stop();
	}

	getState(): BuildInsightsState {
		return this.#store.getState();
	}

	subscribe(listener: BuildInsightsListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async importXcresult(selectedPath: string): Promise<BuildInsightsState> {
		const artifactPath = await verifiedSourcePath(selectedPath, 'xcresult');
		const source = this.#store.upsertSource({
			sourcePath: artifactPath,
			label: sourceLabel(artifactPath),
			kind: 'xcresult',
		});
		await this.#ingest(source, artifactPath);
		this.#store.prune();
		this.#emit();
		return this.getState();
	}

	async addWatchRoot(selectedPath: string): Promise<BuildInsightsState> {
		const sourcePath = await verifiedSourcePath(
			selectedPath,
			'derived-data-root'
		);
		const source = this.#store.upsertSource({
			sourcePath,
			label: sourceLabel(sourcePath),
			kind: 'derived-data-root',
		});
		this.#watchSource(source);
		await this.refresh(source.id);
		return this.getState();
	}

	async refresh(sourceId?: string): Promise<BuildInsightsState> {
		const sources = sourceId
			? [this.#store.getStoredSource(sourceId)].filter(
					(source): source is NonNullable<typeof source> => Boolean(source)
				)
			: this.#store.listStoredSources();
		if (sourceId && sources.length === 0)
			throw new Error('Build source was not found.');
		for (const source of sources) await this.#refreshSource(source.id);
		this.#store.prune();
		this.#emit();
		return this.getState();
	}

	/**
	 * Refreshes one source, one pass at a time. Asked again while a pass
	 * runs, it runs one more pass after it, however many asked meanwhile, and
	 * every caller waits for that last pass.
	 */
	#refreshSource(sourceId: string): Promise<void> {
		const running = this.#sourceRefreshes.get(sourceId);
		if (running) {
			running.again = true;
			return running.done;
		}
		const pass: SourceRefresh = { again: false, done: Promise.resolve() };
		this.#sourceRefreshes.set(sourceId, pass);
		pass.done = (async () => {
			try {
				do {
					pass.again = false;
					const source = this.#store.getStoredSource(sourceId);
					if (!source) return;
					if (source.kind === 'xcresult') {
						await this.#ingest(source, source.sourcePath);
					} else {
						await this.#scanRoot(source);
					}
				} while (pass.again && !this.#stopped);
			} finally {
				if (this.#sourceRefreshes.get(sourceId) === pass) {
					this.#sourceRefreshes.delete(sourceId);
				}
			}
		})();
		return pass.done;
	}

	async export(format: 'csv' | 'json', destinationPath: string): Promise<void> {
		const state = this.getState();
		const content =
			format === 'json'
				? `${JSON.stringify({ format: 'rndevtools-build-insights', version: 1, ...state }, null, 2)}\n`
				: buildsCsv(state.builds);
		await writeFile(destinationPath, content, {
			encoding: 'utf8',
			mode: 0o600,
		});
	}

	async #scanRoot(
		source: ReturnType<BuildInsightsStore['getStoredSource']> extends infer T
			? NonNullable<T>
			: never
	): Promise<void> {
		this.#store.updateSource(source.id, { status: 'scanning' });
		this.#emit();
		try {
			const artifacts = await discoverXcresults(source.sourcePath);
			const failures: string[] = [];
			for (const artifactPath of artifacts) {
				// A result read before and unchanged since would read the same.
				const key = `${source.id}\0${artifactPath}`;
				const signature = await artifactSignature(artifactPath);
				if (this.#readArtifacts.get(key) === signature) continue;
				try {
					await this.#ingest(source, artifactPath, false);
					this.#rememberArtifact(key, signature);
				} catch (error) {
					this.#readArtifacts.delete(key);
					failures.push(safeErrorText(error));
				}
			}
			const watchError =
				source.kind === 'derived-data-root'
					? this.#watchErrors.get(source.id)
					: undefined;
			const scanError =
				failures.length > 0
					? `${artifacts.length - failures.length} of ${artifacts.length} build results imported; ${failures.length} failed. ${failures[0] ?? ''}`.slice(
							0,
							4 * 1_024
						)
					: undefined;
			const sourceError = watchError ?? scanError;
			this.#store.updateSource(
				source.id,
				sourceError
					? {
							status: 'error',
							lastScannedAt: this.#now(),
							error: sourceError,
						}
					: { status: 'ready', lastScannedAt: this.#now() }
			);
		} catch (error) {
			this.#store.updateSource(source.id, {
				status: 'error',
				lastScannedAt: this.#now(),
				error: safeErrorText(error),
			});
		}
	}

	async #ingest(
		source: NonNullable<ReturnType<BuildInsightsStore['getStoredSource']>>,
		artifactPath: string,
		updateSource = true
	): Promise<void> {
		if (updateSource) {
			this.#store.updateSource(source.id, { status: 'scanning' });
			this.#emit();
		}
		try {
			const parsed = projectBuildResult(
				externalBuildResultSchema.parse(await this.#runXcresult(artifactPath)),
				artifactPath,
				this.#now()
			);
			this.#store.insertBuild(source, { artifactPath, ...parsed });
			if (updateSource) {
				this.#store.updateSource(source.id, {
					status: 'ready',
					lastScannedAt: this.#now(),
				});
			}
		} catch (error) {
			if (updateSource) {
				this.#store.updateSource(source.id, {
					status: 'error',
					lastScannedAt: this.#now(),
					error: safeErrorText(error),
				});
			}
			throw error;
		}
	}

	#rememberArtifact(key: string, signature: string): void {
		this.#readArtifacts.delete(key);
		this.#readArtifacts.set(key, signature);
		for (const oldest of this.#readArtifacts.keys()) {
			if (this.#readArtifacts.size <= MAX_REMEMBERED_ARTIFACTS) break;
			this.#readArtifacts.delete(oldest);
		}
	}

	#watchSource(
		source: NonNullable<ReturnType<BuildInsightsStore['getStoredSource']>>
	): void {
		if (this.#watchers.has(source.id)) return;
		try {
			const watcher = this.#watchFactory(source.sourcePath, (filename) => {
				// Indexing, builds and caches write under DerivedData all the
				// time; only a change to a build result is worth a scan.
				if (!touchesBuildResult(filename)) return;
				const current = this.#watchTimers.get(source.id);
				if (current) clearTimeout(current);
				const timer = setTimeout(() => {
					this.#watchTimers.delete(source.id);
					if (!this.#stopped)
						void this.refresh(source.id).catch(() => undefined);
				}, WATCH_DEBOUNCE_MS);
				timer.unref();
				this.#watchTimers.set(source.id, timer);
			});
			watcher.on('error', (error) => {
				if (this.#watchers.get(source.id) !== watcher) return;
				this.#watchers.delete(source.id);
				watcher.close();
				const timer = this.#watchTimers.get(source.id);
				if (timer) clearTimeout(timer);
				this.#watchTimers.delete(source.id);
				const message = safeErrorText(error);
				this.#watchErrors.set(source.id, message);
				this.#store.updateSource(source.id, {
					status: 'error',
					error: message,
				});
				this.#emit();
			});
			this.#watchers.set(source.id, watcher);
			this.#watchErrors.delete(source.id);
		} catch (error) {
			const message = safeErrorText(error);
			this.#watchErrors.set(source.id, message);
			this.#store.updateSource(source.id, {
				status: 'error',
				error: message,
			});
		}
	}

	#emit(): void {
		if (this.#stopped) return;
		const state = this.getState();
		for (const listener of [...this.#listeners]) {
			try {
				listener(state);
			} catch {
				// Listener isolation keeps the local watcher healthy.
			}
		}
	}
}

async function readXcresult(
	artifactPath: string,
	signal?: AbortSignal
): Promise<unknown> {
	const result = await runSimulatorCommand(
		'/usr/bin/xcrun',
		[
			'xcresulttool',
			'get',
			'build-results',
			'--path',
			artifactPath,
			'--compact',
		],
		{
			...(signal ? { signal } : {}),
			timeoutMs: 30_000,
			maxOutputBytes: MAX_XCRESULT_OUTPUT_BYTES,
		}
	);
	return JSON.parse(result.stdout) as unknown;
}

async function verifiedSourcePath(
	selectedPath: string,
	kind: BuildInsightSource['kind']
): Promise<string> {
	const resolved = await realpath(path.resolve(selectedPath));
	const metadata = await lstat(resolved);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
		throw new Error('Build Insights sources must be local directories.');
	}
	if (
		kind === 'xcresult' &&
		path.extname(resolved).toLowerCase() !== '.xcresult'
	) {
		throw new Error('Selected build result must use the .xcresult extension.');
	}
	if (kind === 'derived-data-root' && path.parse(resolved).root === resolved) {
		throw new Error('Build Insights cannot watch an entire filesystem root.');
	}
	return resolved;
}

function sourceLabel(sourcePath: string): string {
	const label = path.basename(sourcePath).trim();
	if (label.length === 0 || label.length > 128) {
		throw new Error(
			'Build Insights source names must contain 1 to 128 characters.'
		);
	}
	return label;
}

/** Whether a change under a watched root may touch a build result. */
function touchesBuildResult(filename: string | null): boolean {
	// A change without a name could be anywhere, so it counts.
	return (
		filename === null ||
		filename
			.split(path.sep)
			.some((segment) => segment.toLowerCase().endsWith('.xcresult'))
	);
}

/**
 * When a build result last changed: the bundle itself, its Info.plist (which
 * points at the result's root object) and its Data directory (one file per
 * object written). The same signature means xcresulttool would read the
 * same result again.
 */
async function artifactSignature(artifactPath: string): Promise<string> {
	const parts = await Promise.all(
		[
			artifactPath,
			path.join(artifactPath, 'Info.plist'),
			path.join(artifactPath, 'Data'),
		].map(async (entry) => {
			const info = await stat(entry).catch(() => undefined);
			return info ? `${info.mtimeMs}:${info.size}` : '-';
		})
	);
	return parts.join('|');
}

async function discoverXcresults(root: string): Promise<string[]> {
	const results: string[] = [];
	const queue: Array<{ directory: string; depth: number }> = [
		{ directory: root, depth: 0 },
	];
	let visited = 0;
	while (queue.length > 0 && results.length < MAX_SCAN_RESULTS) {
		const current = queue.shift();
		if (!current) break;
		for (const entry of await readdir(current.directory, {
			withFileTypes: true,
		})) {
			visited += 1;
			if (visited > MAX_SCAN_ENTRIES) return results;
			if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
			const candidate = path.join(current.directory, entry.name);
			if (entry.name.toLowerCase().endsWith('.xcresult')) {
				results.push(await realpath(candidate));
				if (results.length >= MAX_SCAN_RESULTS) return results;
			} else if (current.depth < MAX_SCAN_DEPTH) {
				queue.push({ directory: candidate, depth: current.depth + 1 });
			}
		}
	}
	return results;
}

function timestamp(
	value: number | string | undefined,
	fallback: number
): number {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value < 10_000_000_000 ? value * 1_000 : value;
	}
	if (typeof value === 'string') {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

function projectBuildResult(
	result: z.infer<typeof externalBuildResultSchema>,
	artifactPath: string,
	now: number
): Omit<BuildInsight, 'id' | 'sourceId' | 'sourceLabel'> {
	const endedAt = timestamp(result.endTime, now);
	const startedAt = Math.min(timestamp(result.startTime, endedAt), endedAt);
	const statusText = result.status?.toLowerCase() ?? '';
	const status = statusText.includes('succeed')
		? 'succeeded'
		: statusText.includes('fail')
			? 'failed'
			: statusText.includes('cancel')
				? 'cancelled'
				: 'unknown';
	const destination = result.destination
		? [
				result.destination.deviceName,
				result.destination.platform,
				result.destination.osVersion,
				result.destination.architecture,
			]
				.filter((value): value is string => Boolean(value))
				.join(' · ')
		: 'Unknown destination';
	return projectedBuildInsightSchema.parse({
		name:
			result.actionTitle?.trim() || path.basename(artifactPath, '.xcresult'),
		destination,
		createdAt: endedAt,
		startedAt,
		endedAt,
		durationMs: Math.max(0, endedAt - startedAt),
		status,
		classification: 'unknown',
		classificationConfidence: 'unknown',
		warnings: result.warningCount ?? 0,
		errors: result.errorCount ?? 0,
		analyzerWarnings: result.analyzerWarningCount ?? 0,
	});
}

function buildsCsv(builds: BuildInsight[]): string {
	const rows = [
		[
			'id',
			'name',
			'source',
			'scheme',
			'configuration',
			'xcode_version',
			'created_at',
			'duration_ms',
			'status',
			'classification',
			'classification_confidence',
			'warnings',
			'errors',
			'destination',
		],
		...builds.map((build) => [
			build.id,
			build.name,
			build.sourceLabel,
			build.scheme ?? '',
			build.configuration ?? '',
			build.xcodeVersion ?? '',
			new Date(build.createdAt).toISOString(),
			String(build.durationMs),
			build.status,
			build.classification,
			build.classificationConfidence,
			String(build.warnings),
			String(build.errors),
			build.destination,
		]),
	];
	return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

function csvCell(value: string): string {
	// Spreadsheet-safety policy: every exported value is text at this boundary.
	// Prefix formula triggers (including negative numeric-looking text) before
	// RFC 4180 quoting; validated numeric metrics are already nonnegative.
	const neutralized = SPREADSHEET_FORMULA_PREFIXES.has(value[0] ?? '')
		? `'${value}`
		: value;
	return `"${neutralized.replaceAll('"', '""')}"`;
}

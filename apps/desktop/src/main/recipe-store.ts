import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
	type RecipeDefinition,
	type RecipeEvidenceManifest,
	type RecipeRun,
	type RecipeState,
	type RecipeSummary,
	RNDEVTOOLS_RECIPE_FORMAT_VERSION,
	recipeDefinitionSchema,
	recipeEvidenceIdSchema,
	recipeEvidenceManifestSchema,
	recipeIdSchema,
	recipeImportFileSchema,
	recipeRunIdSchema,
	recipeRunSchema,
	recipeStateSchema,
} from '../shared/recipe-protocol';
import {
	ensurePrivateDirectory,
	isMissing,
	syncDirectory,
	writeFileAtomic,
} from './private-files';
import { recipeRequiresRunApproval } from './recipe-policy';

const MAX_RECIPES = 200;
const MAX_RUNS = 500;
const MAX_RECIPE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_RUN_FILE_BYTES = 16 * 1024 * 1024;
const MAX_IMPORT_FILE_BYTES = MAX_RECIPE_FILE_BYTES;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;
const DEFAULT_HISTORY_DAYS = 30;
const MAX_TIMELINE_EVENTS = 5_000;
const RECIPE_FILE_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._:-]{0,255})\.json$/;
const RUN_FILE_PATTERN =
	/^(recipe-run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/i;
const ACTIVE_RUN_STATUSES = new Set([
	'queued',
	'resolving',
	'running',
	'cancelling',
]);

const persistedRunSchema = z.strictObject({
	format: z.literal('rndevtools-recipe-run'),
	formatVersion: z.literal(RNDEVTOOLS_RECIPE_FORMAT_VERSION),
	run: recipeRunSchema,
	evidence: recipeEvidenceManifestSchema,
});
export type RecipeRunRecord = {
	run: RecipeRun;
	evidence: RecipeEvidenceManifest;
};

export function recipeSummary(recipe: RecipeDefinition): RecipeSummary {
	return {
		id: recipe.id,
		name: recipe.name,
		...(recipe.description === undefined
			? {}
			: { description: recipe.description }),
		revision: recipe.revision,
		updatedAt: recipe.updatedAt,
		stepCount: recipe.steps.length,
		teardownStepCount: recipe.teardown.length,
		requiresMutationApproval: recipeRequiresRunApproval(recipe),
	};
}

export class RecipeStore {
	readonly #root: string;
	readonly #now: () => number;
	readonly #historyDays: number;
	readonly #recipes = new Map<string, RecipeDefinition>();
	readonly #runs = new Map<string, RecipeRunRecord>();
	#recipesDirectory: string | undefined;
	#runsDirectory: string | undefined;
	#initializePromise: Promise<void> | undefined;
	#mutationQueue: Promise<void> = Promise.resolve();
	#revision = 0;
	#updatedAt: number;

	constructor(
		root: string,
		{
			now = Date.now,
			historyDays = DEFAULT_HISTORY_DAYS,
		}: { now?: () => number; historyDays?: number } = {}
	) {
		this.#root = path.resolve(root);
		this.#now = now;
		this.#updatedAt = now();
		this.#historyDays =
			Number.isSafeInteger(historyDays) &&
			historyDays >= 1 &&
			historyDays <= 365
				? historyDays
				: DEFAULT_HISTORY_DAYS;
	}

	initialize(): Promise<void> {
		if (this.#initializePromise) return this.#initializePromise;
		const initialization = this.#initializeInternal().catch(
			(error: unknown) => {
				if (this.#initializePromise === initialization) {
					this.#initializePromise = undefined;
				}
				throw error;
			}
		);
		this.#initializePromise = initialization;
		return initialization;
	}

	getState(): RecipeState {
		return recipeStateSchema.parse({
			revision: this.#revision,
			updatedAt: this.#updatedAt,
			recipes: [...this.#recipes.values()]
				.sort(
					(left, right) =>
						right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)
				)
				.map(recipeSummary),
			runs: [...this.#runs.values()]
				.map((record) => record.run)
				.sort(
					(left, right) =>
						right.createdAt - left.createdAt || right.id.localeCompare(left.id)
				)
				.slice(0, MAX_RUNS),
		});
	}

	getRecipe(recipeId: string): RecipeDefinition | undefined {
		return this.#recipes.get(recipeIdSchema.parse(recipeId));
	}

	getRun(runId: string): RecipeRunRecord | undefined {
		return this.#runs.get(recipeRunIdSchema.parse(runId));
	}

	getEvidence(evidenceId: string): RecipeEvidenceManifest | undefined {
		const id = recipeEvidenceIdSchema.parse(evidenceId);
		return [...this.#runs.values()].find((record) => record.evidence.id === id)
			?.evidence;
	}

	async saveRecipe(value: RecipeDefinition): Promise<RecipeSummary> {
		await this.initialize();
		return this.#mutate(async () => {
			const recipe = recipeDefinitionSchema.parse(value);
			const current = this.#recipes.get(recipe.id);
			if (!current && this.#recipes.size >= MAX_RECIPES) {
				throw new Error(`Recipe storage is limited to ${MAX_RECIPES} recipes.`);
			}
			if (current && recipe.revision <= current.revision) {
				throw new Error(
					'Recipe revision must increase when replacing a recipe.'
				);
			}
			if (current && recipe.createdAt !== current.createdAt) {
				throw new Error('Recipe creation time cannot change across revisions.');
			}
			await this.#writeAtomicJson(
				this.#recipePath(recipe.id),
				{
					format: 'rndevtools-recipe',
					formatVersion: RNDEVTOOLS_RECIPE_FORMAT_VERSION,
					recipe,
				},
				MAX_RECIPE_FILE_BYTES
			);
			this.#recipes.set(recipe.id, recipe);
			this.#touch();
			return recipeSummary(recipe);
		});
	}

	async deleteRecipe(recipeId: string): Promise<boolean> {
		await this.initialize();
		return this.#mutate(async () => {
			const id = recipeIdSchema.parse(recipeId);
			if (!this.#recipes.has(id)) return false;
			await rm(this.#recipePath(id), { force: true });
			await syncDirectory(this.#requiredRecipesDirectory());
			this.#recipes.delete(id);
			this.#touch();
			return true;
		});
	}

	async saveRun(value: RecipeRunRecord): Promise<void> {
		await this.initialize();
		await this.#mutate(async () => {
			const record = persistedRunSchema.parse({
				format: 'rndevtools-recipe-run',
				formatVersion: RNDEVTOOLS_RECIPE_FORMAT_VERSION,
				run: value.run,
				evidence: value.evidence,
			});
			if (record.run.evidenceId !== record.evidence.id) {
				throw new Error('Run evidence identifiers did not match.');
			}
			if (record.run.id !== record.evidence.runId) {
				throw new Error('Evidence did not belong to the run.');
			}
			await this.#writeAtomicJson(
				this.#runPath(record.run.id),
				record,
				MAX_RUN_FILE_BYTES
			);
			this.#runs.set(record.run.id, {
				run: record.run,
				evidence: record.evidence,
			});
			await this.#pruneRuns();
			this.#touch();
		});
	}

	async importRecipe(filePath: string): Promise<RecipeSummary> {
		await this.initialize();
		const value = await this.#readBoundedJson(filePath, MAX_IMPORT_FILE_BYTES);
		const imported = recipeImportFileSchema.parse(value).recipe;
		return this.saveRecipe(imported);
	}

	async exportRecipe(recipeId: string, destinationPath: string): Promise<void> {
		await this.initialize();
		const recipe = this.getRecipe(recipeId);
		if (!recipe) throw new Error('Recipe was not found.');
		await this.#writeExternalJson(destinationPath, {
			format: 'rndevtools-recipe',
			formatVersion: RNDEVTOOLS_RECIPE_FORMAT_VERSION,
			recipe,
		});
	}

	async exportEvidence(
		evidenceId: string,
		destinationPath: string
	): Promise<void> {
		await this.initialize();
		const evidence = this.getEvidence(evidenceId);
		if (!evidence) throw new Error('Evidence bundle was not found.');
		await this.#writeExternalJson(destinationPath, evidence);
	}

	async #initializeInternal(): Promise<void> {
		const root = await ensurePrivateDirectory(this.#root, 'Recipe storage');
		this.#recipesDirectory = await ensurePrivateDirectory(
			path.join(root, 'recipes'),
			'Recipe storage'
		);
		this.#runsDirectory = await ensurePrivateDirectory(
			path.join(root, 'runs'),
			'Recipe storage'
		);
		await Promise.all([this.#loadRecipes(), this.#loadRuns()]);
		await this.#recoverInterruptedRuns();
		await this.#pruneRuns();
		this.#touch();
	}

	async #loadRecipes(): Promise<void> {
		const directory = this.#requiredRecipesDirectory();
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const candidatePath = path.join(directory, entry.name);
			if (entry.name.includes('.tmp')) {
				await rm(candidatePath, { force: true }).catch(() => undefined);
				continue;
			}
			const match = RECIPE_FILE_PATTERN.exec(entry.name);
			if (!match) continue;
			try {
				if (!entry.isFile() || entry.isSymbolicLink()) {
					throw new Error('Recipe metadata was not a regular file.');
				}
				const imported = recipeImportFileSchema.parse(
					await this.#readBoundedJson(candidatePath, MAX_RECIPE_FILE_BYTES)
				);
				if (imported.recipe.id !== match[1]) {
					throw new Error('Recipe identifier did not match its filename.');
				}
				if (this.#recipes.size >= MAX_RECIPES) {
					throw new Error('Recipe storage exceeded its record limit.');
				}
				this.#recipes.set(imported.recipe.id, imported.recipe);
			} catch {
				await this.#quarantine(candidatePath, 'recipe');
			}
		}
	}

	async #loadRuns(): Promise<void> {
		const directory = this.#requiredRunsDirectory();
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const candidatePath = path.join(directory, entry.name);
			if (entry.name.includes('.tmp')) {
				await rm(candidatePath, { force: true }).catch(() => undefined);
				continue;
			}
			const match = RUN_FILE_PATTERN.exec(entry.name);
			if (!match) continue;
			try {
				if (!entry.isFile() || entry.isSymbolicLink()) {
					throw new Error('Recipe run metadata was not a regular file.');
				}
				const persisted = persistedRunSchema.parse(
					await this.#readBoundedJson(candidatePath, MAX_RUN_FILE_BYTES)
				);
				if (
					persisted.run.id.toLowerCase() !== match[1]?.toLowerCase() ||
					persisted.run.id !== persisted.evidence.runId ||
					persisted.run.evidenceId !== persisted.evidence.id
				) {
					throw new Error('Recipe run metadata identifiers did not match.');
				}
				this.#runs.set(persisted.run.id, {
					run: persisted.run,
					evidence: persisted.evidence,
				});
			} catch {
				await this.#quarantine(candidatePath, 'recipe-run');
			}
		}
	}

	async #recoverInterruptedRuns(): Promise<void> {
		for (const [runId, record] of this.#runs) {
			if (!ACTIVE_RUN_STATUSES.has(record.run.status)) continue;
			const now = this.#now();
			const targets = record.run.targets.map((target) => ({
				...target,
				status: ['complete', 'failed', 'cancelled'].includes(target.status)
					? target.status
					: ('interrupted' as const),
				message: ['complete', 'failed', 'cancelled'].includes(target.status)
					? target.message
					: 'Interrupted by an application restart.',
				cleanup:
					target.cleanup.status === 'complete' ||
					target.cleanup.status === 'failed'
						? target.cleanup
						: { ...target.cleanup, status: 'interrupted' as const },
			}));
			const run = recipeRunSchema.parse({
				...record.run,
				status: 'interrupted',
				finishedAt: now,
				progressSequence: record.run.progressSequence + 1,
				message: 'Interrupted by an application restart.',
				targets,
			});
			const evidence = recipeEvidenceManifestSchema.parse({
				...record.evidence,
				status: 'interrupted',
				finishedAt: now,
				targets: record.evidence.targets.map((target) => ({
					...target,
					status: ['complete', 'failed', 'cancelled'].includes(target.status)
						? target.status
						: 'interrupted',
					cleanupStatus:
						target.cleanupStatus === 'complete' ? 'complete' : 'interrupted',
				})),
				timeline: [
					...record.evidence.timeline.slice(-(MAX_TIMELINE_EVENTS - 1)),
					{
						sequence: Math.min(
							(record.evidence.timeline.at(-1)?.sequence ?? -1) + 1,
							Number.MAX_SAFE_INTEGER
						),
						at: now,
						phase: 'recovery',
						status: 'interrupted',
						message: 'Run was interrupted by an application restart.',
					},
				],
			});
			const persisted = persistedRunSchema.parse({
				format: 'rndevtools-recipe-run',
				formatVersion: RNDEVTOOLS_RECIPE_FORMAT_VERSION,
				run,
				evidence,
			});
			await this.#writeAtomicJson(
				this.#runPath(runId),
				persisted,
				MAX_RUN_FILE_BYTES
			);
			this.#runs.set(runId, { run, evidence });
		}
	}

	async #pruneRuns(): Promise<void> {
		const cutoff = this.#now() - this.#historyDays * MILLISECONDS_PER_DAY;
		const sorted = [...this.#runs.values()].sort(
			(left, right) =>
				left.run.createdAt - right.run.createdAt ||
				left.run.id.localeCompare(right.run.id)
		);
		const remove = sorted.filter((record, index) => {
			if (ACTIVE_RUN_STATUSES.has(record.run.status)) return false;
			return record.run.createdAt < cutoff || sorted.length - index > MAX_RUNS;
		});
		for (const record of remove) {
			await rm(this.#runPath(record.run.id), { force: true });
			this.#runs.delete(record.run.id);
		}
		if (remove.length > 0) await syncDirectory(this.#requiredRunsDirectory());
	}

	async #readBoundedJson(
		filePath: string,
		maximumBytes: number
	): Promise<unknown> {
		const resolved = path.resolve(filePath);
		const metadata = await lstat(resolved);
		if (
			!metadata.isFile() ||
			metadata.isSymbolicLink() ||
			metadata.size <= 0 ||
			metadata.size > maximumBytes
		) {
			throw new Error('Recipe JSON was not a bounded regular file.');
		}
		const handle = await open(
			resolved,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
		);
		try {
			const openedMetadata = await handle.stat();
			if (
				!openedMetadata.isFile() ||
				openedMetadata.size <= 0 ||
				openedMetadata.size > maximumBytes
			) {
				throw new Error('Recipe JSON was not a bounded regular file.');
			}
			const contents = await handle.readFile();
			if (contents.byteLength <= 0 || contents.byteLength > maximumBytes) {
				throw new Error('Recipe JSON exceeded its safe size limit.');
			}
			return JSON.parse(contents.toString('utf8')) as unknown;
		} finally {
			await handle.close();
		}
	}

	async #writeAtomicJson(
		destinationPath: string,
		value: unknown,
		maximumBytes: number
	): Promise<void> {
		const serialized = `${JSON.stringify(value)}\n`;
		if (Buffer.byteLength(serialized, 'utf8') > maximumBytes) {
			throw new Error('Recipe JSON exceeded its safe size limit.');
		}
		await writeFileAtomic(destinationPath, serialized, 'recipe');
	}

	async #writeExternalJson(
		destinationPath: string,
		value: unknown
	): Promise<void> {
		const destination = path.resolve(destinationPath);
		const directory = await realpath(path.dirname(destination));
		const managedRoot = await realpath(this.#root);
		if (
			directory === managedRoot ||
			directory.startsWith(`${managedRoot}${path.sep}`)
		) {
			throw new Error('Recipe exports cannot target managed storage.');
		}
		await this.#writeAtomicJson(
			path.join(directory, path.basename(destination)),
			value,
			MAX_RUN_FILE_BYTES
		);
	}

	async #quarantine(filePath: string, label: string): Promise<void> {
		try {
			const directory = path.dirname(filePath);
			await rename(
				filePath,
				path.join(directory, `.${label}.corrupt-${randomUUID()}`)
			);
			await syncDirectory(directory);
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
	}

	#recipePath(recipeId: string): string {
		const id = recipeIdSchema.parse(recipeId);
		const directory = this.#requiredRecipesDirectory();
		const candidate = path.resolve(directory, `${id}.json`);
		if (!candidate.startsWith(`${directory}${path.sep}`)) {
			throw new Error('Recipe path escaped managed storage.');
		}
		return candidate;
	}

	#runPath(runId: string): string {
		const id = recipeRunIdSchema.parse(runId);
		const directory = this.#requiredRunsDirectory();
		const candidate = path.resolve(directory, `${id}.json`);
		if (!candidate.startsWith(`${directory}${path.sep}`)) {
			throw new Error('Recipe run path escaped managed storage.');
		}
		return candidate;
	}

	#requiredRecipesDirectory(): string {
		if (!this.#recipesDirectory)
			throw new Error('Recipe storage is not initialized.');
		return this.#recipesDirectory;
	}

	#requiredRunsDirectory(): string {
		if (!this.#runsDirectory)
			throw new Error('Recipe storage is not initialized.');
		return this.#runsDirectory;
	}

	#touch(): void {
		this.#revision += 1;
		this.#updatedAt = this.#now();
	}

	async #mutate<T>(operation: () => Promise<T>): Promise<T> {
		const task = this.#mutationQueue.then(operation);
		this.#mutationQueue = task.then(
			() => undefined,
			() => undefined
		);
		return task;
	}
}

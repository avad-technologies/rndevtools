import {
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
	RecipeDefinition,
	RecipeEvidenceManifest,
	RecipeRun,
} from '../shared/recipe-protocol';
import { RecipeStore } from './recipe-store';

const UDID = '11111111-2222-3333-4444-555555555555';
const roots: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(
		path.join(os.tmpdir(), 'rndevtools-recipe-store-')
	);
	roots.push(directory);
	return directory;
}

function recipe(revision = 1): RecipeDefinition {
	return {
		formatVersion: 1,
		id: 'smoke-test',
		name: 'Smoke test',
		revision,
		createdAt: 1,
		updatedAt: revision,
		defaultConcurrency: 2,
		steps: [{ id: 'wait', kind: 'wait', durationMs: 0 }],
		teardown: [],
	};
}

function runRecord({
	status = 'running',
	createdAt = 1,
	id = '12345678-1234-4123-8123-123456789abc',
}: {
	status?: RecipeRun['status'];
	createdAt?: number;
	id?: string;
} = {}): { run: RecipeRun; evidence: RecipeEvidenceManifest } {
	const runId = `recipe-run-${id}`;
	const evidenceId = `evidence-${id}`;
	const targetStatus =
		status === 'complete'
			? 'complete'
			: status === 'failed'
				? 'failed'
				: 'running';
	const cleanupStatus = status === 'complete' ? 'complete' : 'not-started';
	return {
		run: {
			id: runId,
			actionId: `action-${id}`,
			recipeId: 'smoke-test',
			recipeRevision: 1,
			evidenceId,
			status,
			createdAt,
			progressSequence: 1,
			message: 'Running.',
			concurrency: 1,
			targetUdids: [UDID],
			targets: [
				{
					udid: UDID,
					status: targetStatus,
					completedSteps: status === 'complete' ? 1 : 0,
					totalSteps: 1,
					message: 'Target.',
					cleanup: {
						status: cleanupStatus,
						completedSteps: 0,
						totalSteps: 0,
						failures: [],
					},
				},
			],
		},
		evidence: {
			format: 'rndevtools-evidence-bundle',
			formatVersion: 1,
			id: evidenceId,
			runId,
			recipe: { id: 'smoke-test', name: 'Smoke test', revision: 1 },
			createdAt,
			status,
			targets: [
				{
					udid: UDID,
					status: targetStatus,
					cleanupStatus,
					captureIds: [],
					diagnosticCorrelationIds: [],
				},
			],
			timeline: [],
			captureIds: [],
			diagnosticCorrelationIds: [],
		},
	};
}

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
	);
});

describe('RecipeStore', () => {
	it('atomically persists versioned recipes and rejects stale replacement revisions', async () => {
		const root = await temporaryDirectory();
		const store = new RecipeStore(root);
		await store.initialize();
		await expect(store.saveRecipe(recipe())).resolves.toMatchObject({
			revision: 1,
		});
		await expect(store.saveRecipe(recipe())).rejects.toThrow(
			'revision must increase'
		);
		await expect(store.saveRecipe(recipe(2))).resolves.toMatchObject({
			revision: 2,
		});

		const persisted = JSON.parse(
			await readFile(path.join(root, 'recipes', 'smoke-test.json'), 'utf8')
		) as Record<string, unknown>;
		expect(persisted).toMatchObject({
			format: 'rndevtools-recipe',
			formatVersion: 1,
			recipe: { revision: 2 },
		});
		expect(
			(await readdir(path.join(root, 'recipes'))).some((name) =>
				name.includes('.tmp')
			)
		).toBe(false);
	});

	it('quarantines corrupt metadata and symlinks without following them', async () => {
		const root = await temporaryDirectory();
		await mkdir(path.join(root, 'recipes'), { recursive: true });
		await mkdir(path.join(root, 'runs'), { recursive: true });
		await writeFile(path.join(root, 'recipes', 'broken.json'), '{bad json');
		const outside = path.join(root, 'outside.json');
		await writeFile(outside, JSON.stringify({ secret: true }));
		await symlink(outside, path.join(root, 'recipes', 'linked.json'));

		const store = new RecipeStore(root);
		await store.initialize();
		expect(store.getState().recipes).toEqual([]);
		const names = await readdir(path.join(root, 'recipes'));
		expect(names.filter((name) => name.includes('.corrupt-'))).toHaveLength(2);
		expect(await readFile(outside, 'utf8')).toContain('secret');
	});

	it('marks active runs and cleanup as interrupted on restart', async () => {
		const root = await temporaryDirectory();
		const first = new RecipeStore(root, { now: () => 10 });
		await first.initialize();
		await first.saveRun(runRecord());

		const restarted = new RecipeStore(root, { now: () => 20 });
		await restarted.initialize();
		const recovered = restarted.getState().runs[0];
		expect(recovered).toMatchObject({
			status: 'interrupted',
			finishedAt: 20,
			targets: [{ status: 'interrupted', cleanup: { status: 'interrupted' } }],
		});
		expect(restarted.getEvidence(recovered?.evidenceId ?? '')).toMatchObject({
			status: 'interrupted',
			timeline: [{ phase: 'recovery', status: 'interrupted' }],
		});
	});

	it('keeps restart recovery bounded when the evidence timeline is already full', async () => {
		const root = await temporaryDirectory();
		const record = runRecord();
		record.evidence.timeline = Array.from({ length: 5_000 }, (_, sequence) => ({
			sequence,
			at: sequence,
			phase: 'step' as const,
			status: 'info' as const,
			message: 'Progress.',
		}));
		const first = new RecipeStore(root, { now: () => 10_000 });
		await first.initialize();
		await first.saveRun(record);

		const restarted = new RecipeStore(root, { now: () => 20_000 });
		await restarted.initialize();
		const evidence = restarted.getEvidence(record.evidence.id);
		expect(evidence?.timeline).toHaveLength(5_000);
		expect(evidence?.timeline.at(-1)).toMatchObject({
			sequence: 5_000,
			phase: 'recovery',
			status: 'interrupted',
		});
	});

	it('prunes terminal history beyond the bounded age while retaining current runs', async () => {
		const now = 10 * 24 * 60 * 60 * 1_000;
		const root = await temporaryDirectory();
		const store = new RecipeStore(root, { now: () => now, historyDays: 1 });
		await store.initialize();
		await store.saveRun(
			runRecord({
				status: 'complete',
				createdAt: now - 2 * 24 * 60 * 60 * 1_000,
			})
		);
		await store.saveRun(
			runRecord({
				status: 'running',
				createdAt: now - 2 * 24 * 60 * 60 * 1_000,
				id: '22345678-1234-4123-8123-123456789abc',
			})
		);
		expect(store.getState().runs).toHaveLength(1);
		expect(store.getState().runs[0]?.status).toBe('running');
	});

	it('imports and exports through bounded files and rejects symlink imports', async () => {
		const root = await temporaryDirectory();
		const external = await temporaryDirectory();
		const source = path.join(external, 'recipe.json');
		await writeFile(
			source,
			JSON.stringify({
				format: 'rndevtools-recipe',
				formatVersion: 1,
				recipe: recipe(),
			})
		);
		const store = new RecipeStore(root);
		await store.initialize();
		await expect(store.importRecipe(source)).resolves.toMatchObject({
			id: 'smoke-test',
		});
		const destination = path.join(external, 'export.json');
		await store.exportRecipe('smoke-test', destination);
		expect(JSON.parse(await readFile(destination, 'utf8'))).toMatchObject({
			formatVersion: 1,
			recipe: { id: 'smoke-test' },
		});

		const linked = path.join(external, 'linked.json');
		await symlink(source, linked);
		await expect(store.importRecipe(linked)).rejects.toThrow('regular file');
		expect(() => store.getRecipe('../escape')).toThrow();
	});

	it('removes its atomic temporary file when fsync fails', async () => {
		const root = await temporaryDirectory();
		const store = new RecipeStore(root);
		await store.initialize();
		const probePath = path.join(root, 'sync-probe');
		const probe = await open(probePath, 'w');
		const fileHandlePrototype = Object.getPrototypeOf(probe) as {
			sync: () => Promise<void>;
		};
		await probe.close();
		await rm(probePath, { force: true });
		const sync = vi
			.spyOn(fileHandlePrototype, 'sync')
			.mockRejectedValueOnce(new Error('injected fsync failure'));

		await expect(store.saveRecipe(recipe())).rejects.toThrow(
			'injected fsync failure'
		);
		sync.mockRestore();
		expect(
			(await readdir(path.join(root, 'recipes'))).filter((name) =>
				name.startsWith('.recipe-')
			)
		).toEqual([]);
	});
});

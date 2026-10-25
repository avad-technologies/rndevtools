import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BuildInsightsStore } from './build-insights-store';

const temporaryRoots: string[] = [];

afterEach(async () => {
	for (const root of temporaryRoots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
});

async function createStore(now: number): Promise<BuildInsightsStore> {
	const root = await mkdtemp(
		path.join(tmpdir(), 'rndevtools-build-insights-store-')
	);
	temporaryRoots.push(root);
	const store = new BuildInsightsStore(root, { now: () => now });
	await store.start();
	return store;
}

describe('BuildInsightsStore', () => {
	it('keeps source and artifact paths outside renderer state and deduplicates artifacts', async () => {
		const now = Date.UTC(2026, 7, 30);
		const store = await createStore(now);
		const source = store.upsertSource({
			sourcePath: '/private/DerivedData/ExampleApp',
			label: 'ExampleApp',
			kind: 'derived-data-root',
		});
		const build = {
			artifactPath: '/private/DerivedData/ExampleApp/Logs/Build/one.xcresult',
			name: 'Build ExampleApp',
			destination: 'iPhone 17 Pro · iOS Simulator',
			createdAt: now,
			startedAt: now - 12_000,
			endedAt: now,
			durationMs: 12_000,
			status: 'succeeded' as const,
			classification: 'unknown' as const,
			classificationConfidence: 'unknown' as const,
			warnings: 2,
			errors: 0,
			analyzerWarnings: 1,
		};

		expect(store.insertBuild(source, build)).toBe(true);
		expect(store.insertBuild(source, build)).toBe(false);
		const state = store.getState();
		expect(state.builds).toHaveLength(1);
		expect(state.stats).toMatchObject({
			totalBuilds: 1,
			succeededBuilds: 1,
			medianDurationMs: 12_000,
			p75DurationMs: 12_000,
			p95DurationMs: 12_000,
			sevenDayAverageMs: 12_000,
		});
		expect(JSON.stringify(state)).not.toContain('/private/DerivedData');
		store.stop();
	});

	it('prunes builds older than the twelve-month calendar window', async () => {
		const now = Date.UTC(2026, 7, 30);
		const store = await createStore(now);
		const source = store.upsertSource({
			sourcePath: '/private/result.xcresult',
			label: 'result.xcresult',
			kind: 'xcresult',
		});
		const createdAt = Date.UTC(2025, 6, 29);
		store.insertBuild(source, {
			artifactPath: '/private/result.xcresult',
			name: 'Old build',
			destination: 'Unknown destination',
			createdAt,
			startedAt: createdAt,
			endedAt: createdAt,
			durationMs: 0,
			status: 'unknown',
			classification: 'unknown',
			classificationConfidence: 'unknown',
			warnings: 0,
			errors: 0,
			analyzerWarnings: 0,
		});

		store.prune();
		expect(store.getState().builds).toEqual([]);
		store.stop();
	});

	it('updates a previously incomplete artifact and computes stats across all retained rows', async () => {
		const now = Date.UTC(2026, 7, 30);
		const store = await createStore(now);
		const source = store.upsertSource({
			sourcePath: '/private/DerivedData/ExampleApp',
			label: 'ExampleApp',
			kind: 'derived-data-root',
		});
		const base = {
			name: 'Build ExampleApp',
			destination: 'iPhone 17 Pro',
			createdAt: now,
			startedAt: now - 1_000,
			endedAt: now,
			durationMs: 1_000,
			classification: 'unknown' as const,
			classificationConfidence: 'unknown' as const,
			warnings: 0,
			errors: 0,
			analyzerWarnings: 0,
		};
		expect(
			store.insertBuild(source, {
				...base,
				artifactPath: '/private/DerivedData/ExampleApp/incomplete.xcresult',
				status: 'unknown',
			})
		).toBe(true);
		expect(
			store.insertBuild(source, {
				...base,
				artifactPath: '/private/DerivedData/ExampleApp/incomplete.xcresult',
				status: 'succeeded',
			})
		).toBe(true);
		expect(store.getState().builds[0]?.status).toBe('succeeded');

		for (let index = 0; index < 2_000; index += 1) {
			store.insertBuild(source, {
				...base,
				artifactPath: `/private/DerivedData/ExampleApp/${index}.xcresult`,
				status: 'succeeded',
			});
		}
		const state = store.getState();
		expect(state.builds).toHaveLength(2_000);
		expect(state.stats).toMatchObject({
			totalBuilds: 2_001,
			succeededBuilds: 2_001,
			sevenDayAverageMs: 1_000,
		});
		store.stop();
	}, 15_000);
});

import { describe, expect, it } from 'vitest';
import {
	buildInsightsOperationSchema,
	buildInsightsStateSchema,
} from './build-insights-protocol';

describe('build insights protocol', () => {
	it('accepts local-only bounded state without source paths', () => {
		const state = buildInsightsStateSchema.parse({
			revision: 1,
			updatedAt: 1,
			retentionMonths: 12,
			sources: [],
			builds: [],
			stats: { totalBuilds: 0, succeededBuilds: 0, activity: [] },
		});
		expect(JSON.stringify(state)).not.toContain('/Users/');
	});

	it('rejects renderer paths and unknown operation fields', () => {
		expect(
			buildInsightsOperationSchema.safeParse({
				actionId: 'build-1',
				kind: 'build.import-xcresult',
				path: '/tmp/unsafe.xcresult',
			}).success
		).toBe(false);
	});
});

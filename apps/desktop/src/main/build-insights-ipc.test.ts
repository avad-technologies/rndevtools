import { describe, expect, it, vi } from 'vitest';
import type { BuildInsightsState } from '../shared/build-insights-protocol';
import { createBuildInsightsIpcHandlers } from './build-insights-ipc';

const state: BuildInsightsState = {
	revision: 1,
	updatedAt: 1,
	retentionMonths: 12,
	sources: [],
	builds: [],
	stats: { totalBuilds: 0, succeededBuilds: 0, activity: [] },
};

function fixture() {
	const service = {
		getState: vi.fn(() => state),
		importXcresult: vi.fn(async () => state),
		addWatchRoot: vi.fn(async () => state),
		refresh: vi.fn(async () => state),
		export: vi.fn(async () => undefined),
	};
	const assertTrustedRenderer = vi.fn();
	const handlers = createBuildInsightsIpcHandlers({
		service,
		assertTrustedRenderer,
		selectXcresult: vi.fn(async () => '/private/result.xcresult'),
		selectWatchRoot: vi.fn(async () => '/private/DerivedData'),
		selectExportDestination: vi.fn(async () => '/private/build-insights.json'),
	});
	return { service, assertTrustedRenderer, handlers };
}

describe('Build Insights IPC', () => {
	it('uses a main-owned source selection rather than a renderer path', async () => {
		const { service, assertTrustedRenderer, handlers } = fixture();
		const receipt = await handlers.runOperation({} as never, {
			actionId: 'build-import-1',
			kind: 'build.import-xcresult',
		});

		expect(assertTrustedRenderer).toHaveBeenCalledOnce();
		expect(service.importXcresult).toHaveBeenCalledWith(
			'/private/result.xcresult'
		);
		expect(receipt).toMatchObject({ completed: true, state });
	});

	it('returns a typed cancellation when a dialog is dismissed', async () => {
		const { service, assertTrustedRenderer } = fixture();
		const handlers = createBuildInsightsIpcHandlers({
			service,
			assertTrustedRenderer,
			selectXcresult: vi.fn(async () => undefined),
			selectWatchRoot: vi.fn(async () => undefined),
			selectExportDestination: vi.fn(async () => undefined),
		});

		await expect(
			handlers.runOperation({} as never, {
				actionId: 'build-export-1',
				kind: 'build.export',
				format: 'json',
			})
		).resolves.toMatchObject({ completed: false, cancelled: true });
		expect(service.export).not.toHaveBeenCalled();
	});
});

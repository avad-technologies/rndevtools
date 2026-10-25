import { expect, test } from '@playwright/test';
import { DesktopHarness } from './harness';

let harness: DesktopHarness;

test.beforeAll(async () => {
	harness = await DesktopHarness.launch();
});

test.afterAll(async () => {
	await harness?.close();
});

test('build insights panel renders KPIs, history, and export actions', async () => {
	await harness.openPanel('simulator/builds');
	expect(await harness.hasErrorBoundary()).toBe(false);
	await expect(
		harness.window.getByRole('heading', { name: 'Build Insights', level: 1 })
	).toBeVisible();
	await expect(harness.window.locator('.sim-metric-grid')).toBeVisible();
	await expect(
		harness.window.getByRole('button', { name: 'Import result' })
	).toBeVisible();
	await expect(
		harness.window.getByRole('button', { name: 'Add build folder' })
	).toBeVisible();
	await harness.screenshot('simulator-build-insights');
});

test('build insights exposes export controls in the detail pane', async () => {
	await harness.openPanel('simulator/builds');
	// Export actions render in both the empty and populated detail panes.
	await expect(
		harness.window.getByRole('button', { name: 'Export JSON' })
	).toBeVisible();
	await expect(
		harness.window.getByRole('button', { name: 'Export CSV' })
	).toBeVisible();
});

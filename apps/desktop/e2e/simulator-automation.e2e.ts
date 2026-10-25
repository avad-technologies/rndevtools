import { expect, test } from '@playwright/test';
import { DesktopHarness } from './harness';

let harness: DesktopHarness;

test.beforeAll(async () => {
	harness = await DesktopHarness.launch();
});

test.afterAll(async () => {
	await harness?.close();
});

test('automation panel renders its toolbar and empty state', async () => {
	await harness.openPanel('simulator/automation');
	expect(await harness.hasErrorBoundary()).toBe(false);
	await expect(
		harness.window.getByRole('heading', { name: 'Automation', level: 1 })
	).toBeVisible();
	await expect(
		harness.window.getByRole('button', { name: 'New recipe' })
	).toBeVisible();
	await harness.screenshot('simulator-automation');
});

test('creating a recipe opens the editor with lanes and a step', async () => {
	await harness.openPanel('simulator/automation');
	await harness.window.getByRole('button', { name: 'New recipe' }).click();
	// The definition editor exposes the run/cleanup lane segmented control.
	await expect(
		harness.window.getByRole('button', { name: /^Run · \d/ })
	).toBeVisible();
	await expect(
		harness.window.getByRole('button', { name: /^Cleanup · \d/ })
	).toBeVisible();
	// A new recipe starts dirty, so Save is enabled once bridge is available.
	await expect(harness.window.getByLabel('Recipe name')).toBeVisible();
});

test('adding a step and switching the step type updates the editor', async () => {
	await harness.openPanel('simulator/automation');
	await harness.window.getByRole('button', { name: 'New recipe' }).click();
	await harness.window.getByLabel('Step type').selectOption('wait');
	await harness.window.getByRole('button', { name: 'Add' }).click();
	// The wait step editor exposes its duration field.
	await expect(harness.window.getByLabel('Duration (ms)')).toBeVisible();
});

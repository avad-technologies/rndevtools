import { expect, test } from '@playwright/test';
import { DesktopHarness } from './harness';

let harness: DesktopHarness;

test.beforeAll(async () => {
	harness = await DesktopHarness.launch();
});

test.afterAll(async () => {
	await harness?.close();
});

test('fleet panel renders its header, metrics, and creation toggle', async () => {
	await harness.openPanel('simulator/fleet');
	expect(await harness.hasErrorBoundary()).toBe(false);
	await expect(
		harness.window.getByRole('heading', { name: 'Simulators', level: 1 })
	).toBeVisible();
	// KPI row is always present, even when metrics are unavailable ("—").
	await expect(harness.window.locator('.sim-metric-grid')).toBeVisible();
	await expect(
		harness.window.getByRole('button', { name: /New simulator|Close creation/ })
	).toBeVisible();
	await harness.screenshot('simulator-fleet');
});

test('fleet creation drawer opens and exposes the create form', async () => {
	await harness.openPanel('simulator/fleet');
	const toggle = harness.window.getByRole('button', {
		name: /New simulator|Close creation/,
	});
	await toggle.click();
	// The create row exposes the Name field regardless of runtime availability.
	await expect(
		harness.window.getByLabel('Simulator name', { exact: true })
	).toBeVisible();
	await toggle.click();
	await expect(
		harness.window.getByLabel('Simulator name', { exact: true })
	).toBeHidden();
});

test('fleet batch selection toggle flips its label', async () => {
	await harness.openPanel('simulator/fleet');
	const batch = harness.window.getByRole('button', {
		name: 'Select multiple',
	});
	// Only present when at least one target is discovered; skip gracefully if not.
	if ((await batch.count()) === 0) {
		test.skip(true, 'No simulator targets discovered on this host.');
		return;
	}
	await batch.click();
	await expect(
		harness.window.getByRole('button', { name: 'Done selecting' })
	).toBeVisible();
});

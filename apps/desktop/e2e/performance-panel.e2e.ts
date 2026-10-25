import { expect, test } from '@playwright/test';
import { DesktopHarness } from './harness';

let harness: DesktopHarness;

test.beforeAll(async () => {
	harness = await DesktopHarness.launch();
});

test.afterAll(async () => {
	await harness?.close();
});

test('performance panel renders KPIs, the interaction trace, and the sample tables', async () => {
	await harness.openPanel('performance');
	expect(await harness.hasErrorBoundary()).toBe(false);

	// The four demo KPI labels render.
	await expect(harness.window.getByText('JS FPS').first()).toBeVisible();
	await expect(harness.window.getByText('Event loop lag')).toBeVisible();

	// The interaction trace SVG is present and labelled.
	await expect(
		harness.window.getByRole('img', { name: 'Performance trace', exact: true })
	).toBeVisible();

	// Sections render via the shared SectionCard.
	await expect(harness.window.getByText('Review summary')).toBeVisible();
	await expect(harness.window.getByText('Route ranking')).toBeVisible();
	await expect(harness.window.getByText('Latest samples')).toBeVisible();

	// The demo review is active and reports routes, so the ranking is populated
	// (not the empty-state copy).
	await expect(
		harness.window.getByText(
			'Record an interaction to compare responsiveness by route.'
		)
	).toHaveCount(0);

	await harness.screenshot('performance-review');
});

test('performance review control is reachable and reflects the active review', async () => {
	await harness.openPanel('performance');

	// performance.review is a supported demo capability, and the demo review is
	// active — so the header exposes an enabled Stop control.
	const stop = harness.window.getByRole('button', { name: /Stop review/ });
	await expect(stop).toBeVisible();
	await expect(stop).toBeEnabled();

	await harness.screenshot('performance-controls');
});

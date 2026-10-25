import { expect, test } from '@playwright/test';
import { DesktopHarness } from './harness';

let harness: DesktopHarness;

test.beforeAll(async () => {
	harness = await DesktopHarness.launch();
});

test.afterAll(async () => {
	await harness?.close();
});

test('environment panel shows the health dial and grouped sections', async () => {
	await harness.openPanel('environment');
	expect(await harness.hasErrorBoundary()).toBe(false);

	await expect(
		harness.window.getByRole('heading', { name: 'Environment' })
	).toBeVisible();
	// Section headers from the demo device.
	await expect(harness.window.getByText('Application').first()).toBeVisible();
	await expect(harness.window.getByText('Observability').first()).toBeVisible();
	await harness.screenshot('environment-overview');
});

test('environment search filters entries to a match', async () => {
	await harness.openPanel('environment');

	const search = harness.window.getByRole('searchbox', {
		name: 'Search environment',
	});
	await search.fill('SENTRY');
	await expect(harness.window.getByText('SENTRY_DSN')).toBeVisible();
	// A non-matching key is filtered out.
	await expect(harness.window.getByText('APP_VARIANT')).toHaveCount(0);
	await harness.screenshot('environment-filtered');

	await search.fill('nonexistent-key-xyz');
	await expect(harness.window.getByText('No matching values')).toBeVisible();
});

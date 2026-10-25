import { expect, test } from '@playwright/test';
import { DesktopHarness } from './harness';

let harness: DesktopHarness;

test.beforeAll(async () => {
	harness = await DesktopHarness.launch();
});

test.afterAll(async () => {
	await harness?.close();
});

test('routes panel lists the sitemap and marks the current route', async () => {
	await harness.openPanel('routes');
	expect(await harness.hasErrorBoundary()).toBe(false);

	// The demo current route is "Active workout"; it shows a Current pill.
	await expect(harness.window.getByText('Current').first()).toBeVisible();
	await expect(
		harness.window.getByRole('button', { name: /Active workout/ })
	).toBeVisible();
	await harness.screenshot('routes-list');
});

test('routes search filters the list and Navigate reflects selection', async () => {
	await harness.openPanel('routes');

	const search = harness.window.getByRole('searchbox', {
		name: 'Search routes',
	});
	await search.fill('settings');
	const settings = harness.window.getByRole('button', { name: /Settings/ });
	await expect(settings).toBeVisible();
	await settings.click();

	// A static, non-current route is navigable on device.
	await expect(
		harness.window.getByRole('button', { name: 'Navigate on device' })
	).toBeEnabled();
	await harness.screenshot('routes-navigable');

	// Clearing back to the current route shows the disabled "Currently visible".
	await search.fill('active workout');
	await harness.window.getByRole('button', { name: /Active workout/ }).click();
	await expect(
		harness.window.getByRole('button', { name: 'Currently visible' })
	).toBeDisabled();
});

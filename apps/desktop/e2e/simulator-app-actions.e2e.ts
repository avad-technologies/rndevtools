import { expect, test } from '@playwright/test';
import { DesktopHarness } from './harness';

let harness: DesktopHarness;

test.beforeAll(async () => {
	harness = await DesktopHarness.launch();
});

test.afterAll(async () => {
	await harness?.close();
});

test('app actions panel lists actions and shows a workbench', async () => {
	await harness.openPanel('simulator/actions');
	expect(await harness.hasErrorBoundary()).toBe(false);
	await expect(
		harness.window.getByRole('heading', { name: 'App Actions', level: 1 })
	).toBeVisible();
	// The default selected action renders a workbench with a run footer button.
	await expect(harness.window.locator('.sim-workbench')).toBeVisible();
	await harness.screenshot('simulator-app-actions');
});

test('category filter narrows the action list to Environment', async () => {
	await harness.openPanel('simulator/actions');
	await harness.window
		.getByLabel('Filter action category')
		.selectOption('Environment');
	// "Set location" is an Environment action and should remain visible.
	await expect(
		harness.window.getByText('Set location', { exact: true }).first()
	).toBeVisible();
	// An App-only action such as "Push notification" should be filtered out.
	await expect(
		harness.window.getByText('Push notification', { exact: true })
	).toHaveCount(0);
});

test('search narrows the action list and the workbench shows a run footer', async () => {
	await harness.openPanel('simulator/actions');
	// Reset the category filter so a prior test's selection does not hide the
	// App-category action this test searches for.
	await harness.window.getByLabel('Filter action category').selectOption('All');
	await harness.window
		.getByRole('searchbox', { name: 'Search Simulator actions' })
		.fill('deep link');
	// The matching action is visible and non-matching ones are filtered out.
	await expect(
		harness.window.getByText('Open deep link', { exact: true }).first()
	).toBeVisible();
	await expect(
		harness.window.getByText('Push notification', { exact: true })
	).toHaveCount(0);
	// The run footer always states readiness (either "ready" or a blocking
	// reason), and its primary button is present.
	const runFooter = harness.window.locator('.sim-run-footer');
	await expect(runFooter).toBeVisible();
	await expect(runFooter.getByRole('button')).toBeVisible();
});

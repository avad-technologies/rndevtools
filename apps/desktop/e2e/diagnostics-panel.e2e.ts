import { expect, test } from '@playwright/test';
import { DesktopHarness } from './harness';

let harness: DesktopHarness;

test.beforeAll(async () => {
	harness = await DesktopHarness.launch();
});

test.afterAll(async () => {
	await harness?.close();
});

test.beforeEach(async () => {
	await harness.openPanel('diagnostics');
});

test('diagnostics panel renders health cards and sections', async () => {
	expect(await harness.hasErrorBoundary()).toBe(false);
	await expect(
		harness.window.getByRole('heading', { name: 'Diagnostics', exact: true })
	).toBeVisible();
	await expect(
		harness.window.getByText('Broker', { exact: true })
	).toBeVisible();
	await expect(harness.window.getByText('Connection endpoints')).toBeVisible();
	await expect(
		harness.window.getByText('Runtime', { exact: true })
	).toBeVisible();
	await expect(harness.window.getByText('Internal event stream')).toBeVisible();
	await harness.screenshot('diagnostics-overview');
});

test('search filters the internal event stream', async () => {
	const search = harness.window.getByRole('searchbox', {
		name: 'Search diagnostics',
	});
	await search.fill('zzz-no-match-zzz');
	await expect(harness.window.getByText('No diagnostic events')).toBeVisible();
	await search.fill('');
	await expect(harness.window.getByText(/of \d+ events/).first()).toBeVisible();
});

test('copy endpoint control is reachable', async () => {
	const copyButtons = harness.window.getByRole('button', {
		name: /Copy endpoint/,
	});
	// The demo broker exposes at least one endpoint with a copy affordance.
	await expect(copyButtons.first()).toBeVisible();
	await copyButtons.first().click();
});

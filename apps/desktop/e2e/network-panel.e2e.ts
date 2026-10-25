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
	await harness.openPanel('network');
});

test('network panel renders requests without crashing', async () => {
	expect(await harness.hasErrorBoundary()).toBe(false);
	await expect(
		harness.window.getByRole('heading', { name: 'Network', exact: true })
	).toBeVisible();
	// Demo device seeds traffic, so the grid renders.
	await expect(harness.window.locator('.desktop-grid')).toBeVisible();
});

test('filter buttons toggle aria-pressed and re-filter the grid', async () => {
	const errors = harness.window.getByRole('button', { name: 'Errors' });
	await errors.click();
	await expect(errors).toHaveAttribute('aria-pressed', 'true');
	await expect(
		harness.window.getByText(/of \d+ requests/).first()
	).toBeVisible();

	const all = harness.window.getByRole('button', { name: 'All', exact: true });
	await all.click();
	await expect(all).toHaveAttribute('aria-pressed', 'true');
	await expect(errors).toHaveAttribute('aria-pressed', 'false');
});

test('search narrows the list and can be cleared', async () => {
	const search = harness.window.getByRole('searchbox', {
		name: 'Search network requests',
	});
	await search.fill('zzz-no-match-zzz');
	await expect(harness.window.getByText('No matching requests')).toBeVisible();
	await search.fill('');
	await expect(harness.window.locator('.desktop-grid')).toBeVisible();
});

test('pause toggles between live and paused view', async () => {
	const pause = harness.window.getByRole('button', { name: 'Pause view' });
	await pause.click();
	await expect(
		harness.window.getByRole('button', { name: 'Resume view' })
	).toBeVisible();
	await expect(harness.window.getByText('View paused')).toBeVisible();
	await harness.window.getByRole('button', { name: 'Resume view' }).click();
	await expect(
		harness.window.getByRole('button', { name: 'Pause view' })
	).toBeVisible();
});

test('selecting a request switches detail tabs', async () => {
	const firstRow = harness.window.locator('.desktop-grid [role="row"]').nth(1);
	await firstRow.click();
	const headersTab = harness.window.getByRole('tab', {
		name: 'Headers',
		exact: true,
	});
	await headersTab.click();
	await expect(headersTab).toHaveAttribute('aria-selected', 'true');
	await expect(
		harness.window.getByText('Request headers').first()
	).toBeVisible();
	await harness.screenshot('network-detail-headers');
});

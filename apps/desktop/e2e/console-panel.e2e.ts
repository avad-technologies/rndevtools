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
	await harness.openPanel('console');
});

test('console panel renders logger events', async () => {
	expect(await harness.hasErrorBoundary()).toBe(false);
	await expect(
		harness.window.getByRole('heading', { name: 'Console', exact: true })
	).toBeVisible();
	await expect(harness.window.locator('.desktop-grid')).toBeVisible();
});

test('level filters toggle aria-pressed', async () => {
	const errorFilter = harness.window.getByRole('button', { name: /^error/i });
	await errorFilter.click();
	await expect(errorFilter).toHaveAttribute('aria-pressed', 'true');

	const allFilter = harness.window.getByRole('button', {
		name: 'all',
		exact: true,
	});
	await allFilter.click();
	await expect(allFilter).toHaveAttribute('aria-pressed', 'true');
	await expect(errorFilter).toHaveAttribute('aria-pressed', 'false');
});

test('search narrows to no matches then recovers', async () => {
	const search = harness.window.getByRole('searchbox', {
		name: 'Search console events',
	});
	await search.fill('zzz-no-match-zzz');
	await expect(
		harness.window.getByText('No matching logger events')
	).toBeVisible();
	await search.fill('');
	await expect(harness.window.locator('.desktop-grid')).toBeVisible();
});

test('selecting an event exposes a working bookmark toggle', async () => {
	const firstRow = harness.window.locator('.desktop-grid [role="row"]').nth(1);
	await firstRow.click();
	const bookmark = harness.window.getByRole('button', {
		name: 'Bookmark',
		exact: true,
	});
	await bookmark.click();
	await expect(
		harness.window.getByRole('button', { name: 'Remove bookmark' })
	).toBeVisible();
	// Bookmarks-only toggle now has a count of 1.
	await expect(
		harness.window.getByRole('button', { name: /Bookmarks 1/ })
	).toBeVisible();
	await harness.screenshot('console-detail-bookmarked');
});

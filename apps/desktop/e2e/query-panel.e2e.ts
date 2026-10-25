import { expect, type Page, test } from '@playwright/test';
import { DesktopHarness } from './harness';

let harness: DesktopHarness;

test.beforeAll(async () => {
	harness = await DesktopHarness.launch();
});

test.afterAll(async () => {
	await harness?.close();
});

// The shared broker can surface a real connected device alongside the demo
// device. Pin the demo device so demo-only projections (query simulation) are
// present regardless of what else is connected.
async function selectDemoDevice(window: Page): Promise<void> {
	const picker = window.getByRole('combobox', {
		name: 'Selected development device',
	});
	if ((await picker.count()) === 0) return;
	const demoOption = picker.locator('option', { hasText: 'Demo' });
	if ((await demoOption.count()) === 0) return;
	const value = await demoOption.first().getAttribute('value');
	if (value) await picker.selectOption(value);
}

test('query panel switches tabs and filters', async () => {
	await harness.openPanel('query');
	const window = harness.window;
	await selectDemoDevice(window);

	await expect(
		window.getByRole('heading', { name: 'React Query' })
	).toBeVisible();
	await expect(window.locator('.desktop-grid')).toBeVisible({
		timeout: 20_000,
	});

	// Status filters toggle aria-pressed.
	const errors = window.getByRole('button', { name: 'errors', exact: true });
	await errors.click();
	await expect(errors).toHaveAttribute('aria-pressed', 'true');

	// Mutations tab renders its own view.
	await window.getByRole('button', { name: /^Mutations/ }).click();
	await expect(
		window.getByRole('button', { name: /^Mutations/ })
	).toHaveAttribute('aria-pressed', 'true');
	await harness.screenshot('query-mutations');
	// Restore the Queries tab for subsequent tests sharing this window.
	await window.getByRole('button', { name: /^Queries/ }).click();
});

test('query simulation exposes reset and explains unsupported modes', async () => {
	await harness.openPanel('query');
	const window = harness.window;
	await selectDemoDevice(window);

	await expect(
		window.getByRole('heading', { name: 'React Query' })
	).toBeVisible();

	// The Query simulation section renders (SectionCard title).
	await expect(window.getByText('Query simulation')).toBeVisible({
		timeout: 20_000,
	});

	// Demo device has an active (offline) simulation -> Reset is available.
	await expect(window.getByRole('button', { name: 'Reset' })).toBeVisible();

	// Loading/Error modes are unsupported and their reason is visible.
	await expect(window.getByText('Loading unavailable')).toBeVisible();
	await expect(
		window.getByText(/No presentation adapter is registered/).first()
	).toBeVisible();
	await harness.screenshot('query-simulation');
});

test('query detail exposes refetch and invalidate on a selected query', async () => {
	await harness.openPanel('query');
	const window = harness.window;
	await selectDemoDevice(window);

	await expect(
		window.getByRole('heading', { name: 'React Query' })
	).toBeVisible();
	await window.getByRole('button', { name: 'all', exact: true }).click();
	await expect(window.locator('.desktop-grid')).toBeVisible({
		timeout: 20_000,
	});
	await window.locator('.desktop-grid [role="row"]').nth(1).click();

	await expect(window.getByRole('button', { name: 'Refetch' })).toBeEnabled();
	await expect(
		window.getByRole('button', { name: 'Invalidate' })
	).toBeEnabled();
	await harness.screenshot('query-detail');
});

import { expect, type Page, test } from '@playwright/test';
import { DesktopHarness } from './harness';

let harness: DesktopHarness;

test.beforeAll(async () => {
	harness = await DesktopHarness.launch();
});

test.afterAll(async () => {
	await harness?.close();
});

// Pin the demo device: the shared broker may also surface a real device.
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

test('storage panel renders keys and adapter filters', async () => {
	await harness.openPanel('storage');
	const window = harness.window;
	await selectDemoDevice(window);

	// Gate on the panel heading (proves the panel mounted) before content.
	await expect(window.getByRole('heading', { name: 'Storage' })).toBeVisible();
	await expect(window.locator('.desktop-grid')).toBeVisible({
		timeout: 20_000,
	});

	// Adapter toolbar buttons are reachable and toggle aria-pressed.
	const allAdapters = window.getByRole('button', { name: 'All adapters' });
	await expect(allAdapters).toHaveAttribute('aria-pressed', 'true');
	const secure = window.getByRole('button', { name: 'Secure', exact: true });
	await secure.click();
	await expect(secure).toHaveAttribute('aria-pressed', 'true');

	// Secure adapter hides the value and shows the never-leave-device note.
	await expect(
		window.getByText('Value intentionally hidden').first()
	).toBeVisible();
	await harness.screenshot('storage-secure');
	// Restore the All-adapters view for the next test sharing this window.
	await allAdapters.click();
});

test('storage write action explains why it is disabled until edited', async () => {
	await harness.openPanel('storage');
	const window = harness.window;
	await selectDemoDevice(window);

	await expect(window.getByRole('heading', { name: 'Storage' })).toBeVisible();
	// Standard adapter has an editable key. Select the first data row.
	await window.getByRole('button', { name: 'All adapters' }).click();
	await expect(window.locator('.desktop-grid')).toBeVisible({
		timeout: 20_000,
	});
	await window.locator('.desktop-grid [role="row"]').nth(1).click();

	// The write action starts disabled with a visible reason (no change yet).
	await expect(window.locator('#storage-write-reason')).toContainText(
		'Edit the value to enable saving'
	);
	await harness.screenshot('storage-write-reason');
});

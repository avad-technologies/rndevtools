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

test('zustand panel lists stores and refreshes projections', async () => {
	await harness.openPanel('zustand');
	const window = harness.window;
	await selectDemoDevice(window);

	await expect(window.getByRole('heading', { name: 'Zustand' })).toBeVisible();
	await expect(
		window.getByRole('button', { name: 'Refresh projection' })
	).toBeEnabled();

	// Store list renders selectable store buttons.
	await expect(window.getByText('Active session').first()).toBeVisible({
		timeout: 20_000,
	});
	await harness.screenshot('zustand-stores');
});

test('reversible store exposes the validated JSON patch editor', async () => {
	await harness.openPanel('zustand');
	const window = harness.window;
	await selectDemoDevice(window);

	await expect(window.getByRole('heading', { name: 'Zustand' })).toBeVisible();

	// The Developer overrides store is restorable -> patch editor appears.
	// Scope to the store-list button to avoid matching the projection heading.
	await window
		.getByRole('button', { name: /Developer overrides/ })
		.first()
		.click({ timeout: 20_000 });
	await expect(window.getByText('Validated JSON patch')).toBeVisible();
	await expect(
		window.getByRole('button', { name: 'Capture state' })
	).toBeEnabled();

	// The editor seeds a '{}' draft, so Apply patch is enabled by default.
	await expect(
		window.getByRole('button', { name: 'Apply patch' })
	).toBeEnabled();
	await harness.screenshot('zustand-patch');
});

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

test('restore panel exposes capture and lists checkpoints', async () => {
	await harness.openPanel('restore');
	const window = harness.window;
	await selectDemoDevice(window);

	await expect(
		window.getByRole('heading', { name: 'Restore Points' })
	).toBeVisible();

	// Capture control is enabled with the default label.
	await expect(
		window.getByRole('button', { name: 'Capture current state' })
	).toBeEnabled();

	// A demo checkpoint is listed.
	await expect(window.getByText('Before empty-state QA').first()).toBeVisible({
		timeout: 20_000,
	});
	await harness.screenshot('restore-list');
});

test('restore detail surfaces unsupported-action reasons and safe destructive actions', async () => {
	await harness.openPanel('restore');
	const window = harness.window;
	await selectDemoDevice(window);

	await expect(
		window.getByRole('heading', { name: 'Restore Points' })
	).toBeVisible();
	await window
		.getByText('Before empty-state QA')
		.first()
		.click({ timeout: 20_000 });

	// Rename/Duplicate are unsupported on the demo device -> a reason is shown.
	await expect(
		window.getByText(/does not support restore\.(rename|duplicate)/).first()
	).toBeVisible();

	// Destructive Delete + state-changing Restore are present as confirm triggers.
	await expect(
		window.getByRole('button', { name: 'Delete', exact: true })
	).toBeVisible();
	await expect(
		window.getByRole('button', { name: 'Restore', exact: true })
	).toBeVisible();
	await harness.screenshot('restore-detail');
});

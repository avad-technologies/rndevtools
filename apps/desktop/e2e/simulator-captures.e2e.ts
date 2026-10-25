import { expect, test } from '@playwright/test';
import { DesktopHarness } from './harness';

let harness: DesktopHarness;

test.beforeAll(async () => {
	harness = await DesktopHarness.launch();
});

test.afterAll(async () => {
	await harness?.close();
});

test('captures panel renders capture and record controls', async () => {
	await harness.openPanel('simulator/captures');
	expect(await harness.hasErrorBoundary()).toBe(false);
	await expect(
		harness.window.getByRole('heading', { name: 'Captures', level: 1 })
	).toBeVisible();
	await expect(
		harness.window.getByRole('button', { name: 'Screenshot' })
	).toBeVisible();
	await harness.screenshot('simulator-captures');
});

test('capture inspector actions are gated until a capture is available', async () => {
	await harness.openPanel('simulator/captures');
	// Export / Show file require a readable selected capture; disabled otherwise.
	const exportButton = harness.window.getByRole('button', { name: 'Export' });
	if ((await exportButton.count()) > 0) {
		await expect(exportButton).toBeDisabled();
	}
	// The preview pane always explains the empty/selected state.
	await expect(
		harness.window.getByText('Select a capture', { exact: true })
	).toBeVisible();
});

test('storage and cleanup disclosure reveals the retention controls', async () => {
	await harness.openPanel('simulator/captures');
	await harness.window
		.locator('summary', { hasText: 'Storage & cleanup' })
		.click();
	await expect(
		harness.window.getByRole('heading', { name: 'Retention' })
	).toBeVisible();
	await expect(
		harness.window.getByLabel('Maximum capture age in days')
	).toBeVisible();
});

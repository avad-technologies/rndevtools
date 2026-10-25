import { expect, test } from '@playwright/test';
import { DesktopHarness } from './harness';

let harness: DesktopHarness;

test.beforeAll(async () => {
	harness = await DesktopHarness.launch();
});

test.afterAll(async () => {
	await harness?.close();
});

test('camera panel switches fixture kind and edits the label/error fields', async () => {
	await harness.openPanel('camera');
	expect(await harness.hasErrorBoundary()).toBe(false);

	// Fixture-kind select drives the drop-zone copy.
	await expect(
		harness.window.getByRole('heading', { name: /Choose a still image/ })
	).toBeVisible();
	await harness.window.getByLabel('Camera fixture kind').selectOption('video');
	await expect(
		harness.window.getByRole('heading', { name: /Choose a video/ })
	).toBeVisible();

	// The label field is editable.
	const label = harness.window.getByLabel('Camera fixture label');
	await label.fill('E2E fixture');
	await expect(label).toHaveValue('E2E fixture');

	// The simulated-error field is editable.
	const errorField = harness.window.getByLabel('Simulated camera error');
	await errorField.fill('Camera denied by test');
	await expect(errorField).toHaveValue('Camera denied by test');

	await harness.screenshot('camera-fields');
});

test('camera fixture actions are gated with a visible reason on the demo device', async () => {
	await harness.openPanel('camera');

	// The demo device does not advertise camera.setFixture, so Apply and the
	// preset Set buttons are disabled and the reason is surfaced as a notice.
	await expect(
		harness.window.getByRole('button', { name: /Apply fixture/ })
	).toBeDisabled();
	await expect(
		harness.window.getByText('Fixture actions are unavailable.')
	).toBeVisible();

	// Clear fixture is disabled because no fixture is active.
	await expect(
		harness.window.getByRole('button', { name: /Clear fixture/ })
	).toBeDisabled();

	await harness.screenshot('camera-gated');
});

import { expect, test } from '@playwright/test';
import { DesktopHarness } from './harness';

let harness: DesktopHarness;

test.beforeAll(async () => {
	harness = await DesktopHarness.launch();
});

test.afterAll(async () => {
	await harness?.close();
});

test('scenarios panel lists bundled scenarios and can select one', async () => {
	await harness.openPanel('scenarios');
	expect(await harness.hasErrorBoundary()).toBe(false);

	// The demo device advertises two bundled scenarios (Frequent user, New user).
	const sarah = harness.window.getByRole('button', { name: /New user/ });
	await expect(sarah).toBeVisible();
	await sarah.click();
	await expect(sarah).toHaveAttribute('aria-pressed', 'true');

	// The detail pane surfaces the Run action.
	await expect(
		harness.window.getByRole('button', { name: 'Run', exact: true })
	).toBeVisible();
	await harness.screenshot('scenarios-selected');
});

test('scenarios import is gated until the JSON is valid', async () => {
	await harness.openPanel('scenarios');

	const merge = harness.window.getByRole('button', { name: 'Merge import' });
	await expect(merge).toBeVisible();

	// The default template has an empty scenarios array → merge disabled with a
	// visible reason.
	await expect(merge).toBeDisabled();
	await expect(
		harness.window.getByText('Add at least one scenario to import.')
	).toBeVisible();

	// Provide a valid document → merge becomes enabled.
	const importArea = harness.window.getByRole('textbox', {
		name: 'Scenario import JSON',
	});
	await importArea.fill('{"scenarios":[{"id":"demo"}]}');
	await expect(merge).toBeEnabled();
	await expect(harness.window.getByText(/Document looks valid/)).toBeVisible();
	await harness.screenshot('scenarios-import-valid');
});

test('scenarios Run opens a confirming dialog and executes', async () => {
	await harness.openPanel('scenarios');
	await harness.window.getByRole('button', { name: /Frequent user/ }).click();

	await harness.window
		.getByRole('button', { name: 'Run', exact: true })
		.click();
	// ConfirmAction renders an AlertDialog with the run confirmation.
	const confirm = harness.window.getByRole('button', {
		name: 'Run transaction',
	});
	await expect(confirm).toBeVisible();
	await confirm.click();
	// After confirming, no error boundary and the dialog dismisses.
	await expect(confirm).toBeHidden();
	expect(await harness.hasErrorBoundary()).toBe(false);
});

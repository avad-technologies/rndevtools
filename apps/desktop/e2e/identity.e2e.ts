import { expect, test } from '@playwright/test';
import { DesktopHarness } from './harness';

let harness: DesktopHarness;

test.beforeAll(async () => {
	harness = await DesktopHarness.launch();
});

test.afterAll(async () => {
	await harness?.close();
});

test('identity panel lists seeded personas with Start actions', async () => {
	await harness.openPanel('identity');
	expect(await harness.hasErrorBoundary()).toBe(false);

	await expect(
		harness.window.getByRole('heading', { name: 'Test Identities' })
	).toBeVisible();

	// Demo advertises Empty account, Frequent user, New user — each with a Start trigger.
	const startButtons = harness.window.getByRole('button', { name: 'Start' });
	await expect(startButtons.first()).toBeVisible();
	expect(await startButtons.count()).toBeGreaterThanOrEqual(3);
	await harness.screenshot('identity-personas');
});

test('identity Start opens a confirming dialog and switches actor', async () => {
	await harness.openPanel('identity');

	await harness.window.getByRole('button', { name: 'Start' }).first().click();
	const confirm = harness.window.getByRole('button', {
		name: 'Start identity',
	});
	await expect(confirm).toBeVisible();
	await confirm.click();
	await expect(confirm).toBeHidden();
	expect(await harness.hasErrorBoundary()).toBe(false);
	await harness.screenshot('identity-active');
});

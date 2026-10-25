import { expect, test } from '@playwright/test';
import { DesktopHarness } from './harness';

let harness: DesktopHarness;

test.beforeAll(async () => {
	harness = await DesktopHarness.launch();
});

test.afterAll(async () => {
	await harness?.close();
});

test('settings panel lists required capabilities with status pills', async () => {
	await harness.openPanel('simulator/settings');
	expect(await harness.hasErrorBoundary()).toBe(false);
	await expect(
		harness.window.getByRole('heading', { name: 'Settings', level: 1 })
	).toBeVisible();
	// The two required capabilities are always rendered.
	await expect(
		harness.window.getByText('Xcode toolchain', { exact: true })
	).toBeVisible();
	await expect(
		harness.window.getByText('Simulator control', { exact: true })
	).toBeVisible();
	await harness.screenshot('simulator-settings');
});

test('optional features disclosure reveals more capabilities', async () => {
	await harness.openPanel('simulator/settings');
	await harness.window
		.locator('summary', { hasText: 'Optional features & permissions' })
		.click();
	await expect(
		harness.window.getByText('Screen Recording', { exact: true })
	).toBeVisible();
});

test('advanced tools disclosure exposes the verified CLI action', async () => {
	await harness.openPanel('simulator/settings');
	await harness.window
		.locator('summary', { hasText: 'Advanced tools & permissions' })
		.click();
	await expect(
		harness.window.getByRole('button', { name: 'Reveal verified CLI' })
	).toBeVisible();
});

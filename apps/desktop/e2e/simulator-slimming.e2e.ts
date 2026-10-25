import { expect, test } from '@playwright/test';
import { DesktopHarness } from './harness';

let harness: DesktopHarness;

test.beforeAll(async () => {
	harness = await DesktopHarness.launch();
});

test.afterAll(async () => {
	await harness?.close();
});

test('slimming panel renders its header, metrics, and enable switch', async () => {
	await harness.openPanel('simulator/slimming');
	expect(await harness.hasErrorBoundary()).toBe(false);
	await expect(
		harness.window.getByRole('heading', { name: 'SimSlim', level: 1 })
	).toBeVisible();
	await expect(harness.window.locator('.sim-metric-grid')).toBeVisible();
	// The Enable SimSlim switch is present; it is disabled when the signed
	// helper is unavailable (the expected unsigned-local-build state).
	await expect(
		harness.window.getByRole('switch', { name: 'Enable SimSlim' })
	).toBeVisible();
	await harness.screenshot('simulator-slimming');
});

test('slimming exposes an explained empty or degraded state', async () => {
	await harness.openPanel('simulator/slimming');
	// Either the "no targets" empty panel or a target workspace renders; both
	// are valid. When the helper errored, a danger notice explains why.
	const hasEmpty =
		(await harness.window.getByText('No Simulator slimming targets').count()) >
		0;
	const hasWorkspace =
		(await harness.window.getByText('Simulator targets').count()) > 0;
	expect(hasEmpty || hasWorkspace).toBe(true);
});

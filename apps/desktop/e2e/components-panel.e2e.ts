import { expect, test } from '@playwright/test';
import { DesktopHarness } from './harness';

let harness: DesktopHarness;

test.beforeAll(async () => {
	harness = await DesktopHarness.launch();
});

test.afterAll(async () => {
	await harness?.close();
});

test('components panel selects targets from the list and coordinate map', async () => {
	await harness.openPanel('components');
	expect(await harness.hasErrorBoundary()).toBe(false);

	// The demo device registers three explicit targets; the list is reachable.
	const setRow = harness.window.getByRole('button', { name: /ProjectTaskRow/ });
	await expect(setRow.first()).toBeVisible();
	await setRow.first().click();
	// aria-pressed reflects the selected list row.
	await expect(setRow.first()).toHaveAttribute('aria-pressed', 'true');

	// The measured coordinate map exposes an "Inspect …" button per mapped target.
	const overlayBox = harness.window.getByRole('button', {
		name: /Inspect FocusTimerOverlay/,
	});
	await expect(overlayBox).toBeVisible();
	await overlayBox.click();
	await expect(overlayBox).toHaveAttribute('aria-pressed', 'true');

	// Selected-target detail renders the accessibility + source sections.
	await expect(
		harness.window.getByText('Accessibility semantics')
	).toBeVisible();
	await expect(harness.window.getByText('Source')).toBeVisible();

	await harness.screenshot('components-selected');
});

test('components refresh is enabled and semantic mutations explain why they are blocked', async () => {
	await harness.openPanel('components');

	// Refresh is a supported demo capability.
	const refresh = harness.window.getByRole('button', {
		name: /Refresh targets/,
	});
	await expect(refresh).toBeEnabled();

	// activate/focus/setText/scroll are not advertised by the demo device, so
	// the controls are disabled AND a visible reason is shown (no dead buttons).
	await expect(
		harness.window.getByRole('button', { name: /^Activate/ })
	).toBeDisabled();
	await expect(
		harness.window.getByText(/Semantic mutations are disabled:/)
	).toBeVisible();

	await harness.screenshot('components-gated');
});

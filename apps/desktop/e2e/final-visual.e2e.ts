import { expect, test } from '@playwright/test';
import { allPanelIds, DesktopHarness } from './harness';

/**
 * Integration-stage final visual pass. Opens every panel at the 1040x700
 * minimum window size and screenshots it into the `final` directory for
 * comparison against `baseline`. Also asserts no panel renders an error
 * boundary and the shell shows no horizontal overflow at the minimum size.
 *
 * Not part of the panel-agent contract; kept out of `quality` (matches
 * `*.e2e.ts`). Screenshot dir is overridden to `/tmp/rndevtools-ux/final`
 * via `RNDEVTOOLS_E2E_SCREENSHOT_DIR` when the integration agent runs it.
 */

let harness: DesktopHarness;

test.beforeAll(async () => {
	harness = await DesktopHarness.launch();
	await harness.window.setViewportSize({ width: 1040, height: 700 });
});

test.afterAll(async () => {
	await harness?.close();
});

test('final visual pass: every panel at 1040x700', async () => {
	for (const id of allPanelIds) {
		await harness.openPanel(id);
		expect(await harness.hasErrorBoundary(), `${id} crashed`).toBe(false);
		const overflow = await harness.window.evaluate(
			() =>
				document.documentElement.scrollWidth >
				document.documentElement.clientWidth
		);
		expect(overflow, `${id} overflows horizontally at 1040x700`).toBe(false);
		await harness.screenshot(id.replace('/', '-'));
	}
});

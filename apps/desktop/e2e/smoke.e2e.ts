import { expect, test } from '@playwright/test';
import {
	allPanelIds,
	connectedToolIds,
	DesktopHarness,
	panelHeadings,
	simulatorToolIds,
} from './harness';

let harness: DesktopHarness;

test.beforeAll(async () => {
	harness = await DesktopHarness.launch();
});

test.afterAll(async () => {
	await harness?.close();
});

test('every panel opens its own view without an error boundary', async () => {
	const failures: string[] = [];
	const misrouted: string[] = [];

	for (const panelId of allPanelIds) {
		await harness.openPanel(panelId);
		// A hash the app does not know falls back to the Simulators panel instead
		// of failing, so each id must show its own panel's heading.
		const expected = panelHeadings[panelId];
		const heading = await harness.panelHeading(expected);
		const safeName = panelId.replace('/', '-');
		await harness.screenshot(safeName);

		if (await harness.hasErrorBoundary()) {
			failures.push(panelId);
		} else if (heading !== expected) {
			misrouted.push(`${panelId} showed ${heading ?? 'no panel heading'}`);
		}
	}

	expect(failures, `panels that crashed: ${failures.join(', ')}`).toEqual([]);
	expect(
		misrouted,
		`panels that did not open: ${misrouted.join('; ')}`
	).toEqual([]);
});

test('the harness lists every tool the sidebars offer', async () => {
	// A tool missing from the harness lists is never opened by the pass above.
	await harness.openPanel('simulator/fleet');
	// Nine Simulator tools: Supabase on ⌘8 and Settings on ⌘9 included.
	expect(simulatorToolIds).toHaveLength(9);
	await expect(
		harness.window.locator('.simulator-sidebar .tool-nav-item')
	).toHaveCount(simulatorToolIds.length);
	await harness.openPanel('network');
	await expect(
		harness.window.locator(
			'.desktop-sidebar:not(.simulator-sidebar) .tool-nav-item'
		)
	).toHaveCount(connectedToolIds.length);
});

test('the app shell exposes both workspaces and the sidebar', async () => {
	await harness.openPanel('network');
	// Workspace switcher and sidebar navigation are the shell's primary controls.
	await expect(
		harness.window.getByRole('button', { name: /Connected App/ })
	).toBeVisible();
	await expect(
		harness.window.getByRole('button', { name: /Simulator/ }).first()
	).toBeVisible();
	await expect(harness.window.locator('.desktop-sidebar')).toBeVisible();
});

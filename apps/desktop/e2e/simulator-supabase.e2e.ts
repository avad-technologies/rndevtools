import { expect, type Page, test } from '@playwright/test';
import { SUPABASE_DEMO_IDS } from '../src/shared/supabase-demo-data';
import { DesktopHarness } from './harness';

/**
 * The Supabase tab against the demo stacks (RNDEVTOOLS_DEMO=true in an
 * unpackaged build): Mod+8, the demo notice and rows, every detail section
 * including the inspected stack's services, a pin round-trip, the
 * Repositories, Requests and Settings views, no horizontal overflow at the
 * 1040x700 minimum, and turning the feature off and on again.
 */

let harness: DesktopHarness;

test.beforeAll(async () => {
	harness = await DesktopHarness.launch();
});

test.afterAll(async () => {
	await harness?.close();
});

async function modifier(window: Page): Promise<'Meta' | 'Control'> {
	const isMac = await window.evaluate(() =>
		navigator.platform.toLowerCase().includes('mac')
	);
	return isMac ? 'Meta' : 'Control';
}

/** Lists one stack by searching for its branch, which also selects it. */
async function selectStack(window: Page, branch: string): Promise<void> {
	await harness.openPanel('simulator/supabase');
	const stacks = window.getByRole('button', { name: 'Stacks', exact: true });
	if ((await stacks.getAttribute('aria-pressed')) !== 'true') {
		await stacks.click();
	}
	const search = window.getByRole('searchbox', {
		name: 'Search Supabase stacks by branch, port or agent',
	});
	await search.fill(branch);
	await expect(
		window.locator('.supabase-detail h2', { hasText: branch })
	).toBeVisible();
}

async function horizontalOverflow(window: Page): Promise<string[]> {
	return window.evaluate(() => {
		const offenders: string[] = [];
		if (
			document.documentElement.scrollWidth >
			document.documentElement.clientWidth
		) {
			offenders.push('document');
		}
		for (const selector of [
			'.supabase-panel',
			'.supabase-panel .panel-header',
			'.supabase-panel .panel-toolbar',
			'.supabase-panel .sim-list-pane',
			'.supabase-panel .sim-virtual-list',
			'.supabase-panel .sim-detail-pane',
			'.supabase-panel .supabase-column',
			'.supabase-panel .sim-settings-scroll',
		]) {
			for (const element of document.querySelectorAll(selector)) {
				if (element.scrollWidth - element.clientWidth > 1) {
					offenders.push(selector);
				}
			}
		}
		return offenders;
	});
}

test('Mod+8 opens Supabase with the demo notice, metrics and stacks', async () => {
	const { window } = harness;
	await harness.openPanel('network');
	const mod = await modifier(window);
	await window.keyboard.press(`${mod}+Shift+S`);
	await window.keyboard.press(`${mod}+8`);
	await expect(window).toHaveURL(/#simulator\/supabase$/);
	expect(await harness.panelHeading('Supabase')).toBe('Supabase');
	expect(await harness.hasErrorBoundary()).toBe(false);
	await expect(
		window.getByText('Demo stacks. Nothing runs and nothing is saved')
	).toBeVisible();
	await expect(window.locator('.sim-metric-grid')).toBeVisible();
	await expect(window.locator('.supabase-header-meta')).toContainText(
		'3 running'
	);
	const list = window.getByRole('grid', { name: 'Supabase stacks' });
	await expect(list.getByText('legacy-main', { exact: true })).toBeVisible();
	await expect(list.getByText('feat-old-ui', { exact: true })).toBeVisible();
	await expect(
		window.getByText('1 stack listens on your network.')
	).toBeVisible();
});

test('a running stack opens Overview, Services, Database, Logs, Connect and the Danger zone', async () => {
	const { window } = harness;
	await selectStack(window, 'feat-checkout');
	const detail = window.locator('.supabase-detail');
	const id = SUPABASE_DEMO_IDS.featCheckout;
	await expect(detail).toContainText(`${id.slice(0, 8)}…${id.slice(-4)}`);
	await expect(detail.getByText('Who holds this')).toBeVisible();
	await expect(detail).toContainText('What happens next');
	// Demo mode pushes the inspected stack's services, as a status read would.
	const services = detail.locator('summary', { hasText: 'Services' });
	if ((await services.locator('xpath=..').getAttribute('open')) === null) {
		await services.click();
	}
	await expect(detail.getByText('running · healthy · eager')).toBeVisible();
	await expect(
		detail.getByText('sleeping · starts on first request (~0.8 s)')
	).toBeVisible();
	await detail.locator('summary', { hasText: 'Database' }).click();
	await expect(detail.getByText('public.notes', { exact: true })).toBeVisible();
	await expect(detail).toContainText('Migrations · 12 applied · 2 pending');
	await detail.locator('summary', { hasText: 'Logs' }).click();
	await expect(
		detail.getByRole('log', { name: 'Redacted logs for feat-checkout' })
	).toContainText('database system is ready to accept connections');
	await expect(
		detail.getByRole('log', { name: 'Redacted logs for feat-checkout' })
	).toContainText('--- launch');
	const connect = detail.locator('summary', { hasText: 'Connect' });
	if ((await connect.locator('xpath=..').getAttribute('open')) === null) {
		await connect.click();
	}
	await expect(
		detail.getByText('http://127.0.0.1:21734', { exact: true })
	).toBeVisible();
	await expect(
		detail.getByRole('button', { name: 'Copy key for feat-checkout' })
	).toBeVisible();
	await detail.locator('summary', { hasText: 'Danger zone' }).click();
	await expect(
		detail.getByText('Destroy stack', { exact: true })
	).toBeVisible();
	await expect(
		detail.getByText(
			'Lane :8102 is attached and running. Stop the lane in Lanes first.'
		)
	).toBeVisible();
	expect(await harness.hasErrorBoundary()).toBe(false);
});

test('Keep running and Unpin round-trip on the demo state', async () => {
	const { window } = harness;
	await selectStack(window, 'feat-checkout');
	const keep = window.getByRole('button', {
		name: 'Keep running feat-checkout',
	});
	await keep.click();
	const unpin = window.getByRole('button', { name: 'Unpin feat-checkout' });
	await expect(unpin).toBeVisible();
	await expect(window.locator('.supabase-detail')).toContainText(
		'Pinned by you · never stopped automatically'
	);
	await unpin.click();
	await expect(keep).toBeVisible();
});

test('Repositories and Requests list the demo repository and request', async () => {
	const { window } = harness;
	await harness.openPanel('simulator/supabase');
	await window
		.getByRole('button', { name: 'Repositories', exact: true })
		.click();
	await expect(
		window
			.getByRole('grid', { name: 'Repositories' })
			.getByText('~/code/example-app', {
				exact: true,
			})
	).toBeVisible();
	await expect(
		window.getByRole('button', { name: 'Re-check ~/code/example-app' })
	).toBeVisible();
	await expect(window.getByText('Pinned ports', { exact: true })).toBeVisible();
	await window.getByRole('button', { name: /^Requests/ }).click();
	await expect(
		window.getByRole('heading', { name: 'Agent requests', level: 2 })
	).toBeVisible();
	const column = window.locator('.supabase-column');
	await expect(
		column.getByText(/asks to destroy feat-old-ui \(71 MB\)/)
	).toBeVisible();
	await expect(
		window.getByText("Agent's note: Fresh database for the migration test.")
	).toBeVisible();
	await expect(
		window.getByRole('heading', { name: 'Clean up', level: 2 })
	).toBeVisible();
	await expect(
		window.getByRole('button', { name: /^Destroy 1 stack \(64 MB\)…$/ })
	).toBeVisible();
	await window.getByRole('button', { name: 'Stacks', exact: true }).click();
});

test('the gear opens Supabase settings and returns to the view', async () => {
	const { window } = harness;
	await harness.openPanel('simulator/supabase');
	const gear = window.getByRole('button', { name: 'Supabase settings' });
	await gear.click();
	await expect(gear).toHaveAttribute('aria-pressed', 'true');
	await expect(
		window.getByRole('heading', { name: 'Local Supabase (alpha)' })
	).toBeVisible();
	await expect(
		window.getByRole('heading', { name: 'Capacity and idle' })
	).toBeVisible();
	await expect(
		window.getByText('No unsaved changes. Change a value to apply.')
	).toBeVisible();
	for (const name of [
		'Per-stack keys',
		'Pinned-ports compatibility',
		'Eager lanes',
	]) {
		await expect(window.getByRole('switch', { name, exact: true })).toHaveCount(
			1
		);
	}
	await gear.click();
	await expect(gear).toHaveAttribute('aria-pressed', 'false');
});

test('fits 1040x700 without horizontal overflow, in every view', async () => {
	const { window } = harness;
	await window.setViewportSize({ width: 1040, height: 700 });
	try {
		await selectStack(window, 'feat-checkout');
		expect(await horizontalOverflow(window)).toEqual([]);
		await window
			.getByRole('searchbox', {
				name: 'Search Supabase stacks by branch, port or agent',
			})
			.fill('');
		await expect(
			window
				.getByRole('grid', { name: 'Supabase stacks' })
				.getByText('legacy-main', {
					exact: true,
				})
		).toBeVisible();
		// Named apart from the smoke spec's default-size capture of this panel.
		await harness.screenshot('simulator-supabase-1040x700');
		await window.getByRole('button', { name: 'Select multiple' }).click();
		expect(await horizontalOverflow(window)).toEqual([]);
		await window.getByRole('button', { name: 'Done selecting' }).click();
		for (const view of ['Repositories', 'Requests'] as const) {
			await window
				.getByRole('button', { name: view === 'Requests' ? /^Requests/ : view })
				.first()
				.click();
			expect(await horizontalOverflow(window), view).toEqual([]);
		}
		await window.getByRole('button', { name: 'Supabase settings' }).click();
		expect(await horizontalOverflow(window), 'Settings').toEqual([]);
		await window.getByRole('button', { name: 'Supabase settings' }).click();
		await window.getByRole('button', { name: 'Stacks', exact: true }).click();
	} finally {
		await window.setViewportSize({ width: 1280, height: 832 });
	}
});

test('turning off shows the off state, and turning on lists the stacks again', async () => {
	const { window } = harness;
	await harness.openPanel('simulator/supabase');
	const gear = window.getByRole('button', { name: 'Supabase settings' });
	await gear.click();
	const toggle = window.getByRole('switch', { name: 'Local Supabase' });
	await expect(toggle).toBeChecked();
	// Demo state confirms without the native dialog.
	await toggle.click({ force: true });
	await expect(toggle).not.toBeChecked();
	await gear.click();
	await expect(
		window.getByText('Off means off: nothing runs or polls.')
	).toBeVisible();
	await window.getByRole('button', { name: 'Turn on local Supabase…' }).click();
	await expect(
		window.getByRole('grid', { name: 'Supabase stacks' })
	).toBeVisible();
	expect(await harness.hasErrorBoundary()).toBe(false);
});

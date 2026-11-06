import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { DesktopHarness } from './harness';

test('fresh setup and persistent checks repair and undo both clients without touching the real home', async () => {
	const configHome = await mkdtemp(join(tmpdir(), 'rndt-agent-check-e2e-'));
	await mkdir(join(configHome, '.codex'), { recursive: true });
	await mkdir(join(configHome, '.claude'), { recursive: true });
	await writeFile(
		join(configHome, '.codex/config.toml'),
		'# Preserve this comment\n[plugins."simview@tools"]\nenabled = true\n'
	);
	await writeFile(
		join(configHome, '.claude/settings.json'),
		JSON.stringify({
			enabledPlugins: { 'simview@tools': true },
			permissions: { allow: ['Read'] },
		})
	);
	let harness: DesktopHarness | undefined;
	try {
		harness = await DesktopHarness.launch({
			agentConfigHome: configHome,
			onboarding: true,
		});
		const { window, app } = harness;
		await window.emulateMedia({ colorScheme: 'dark' });
		await app.evaluate(({ dialog }) => {
			dialog.showMessageBox = async () => ({
				response: 1,
				checkboxChecked: false,
			});
		});
		const dialog = window.getByRole('dialog');
		await dialog.getByRole('button', { name: /^Get started/ }).click();
		for (let step = 0; step < 3; step++)
			await dialog.getByRole('button', { name: /^Continue/ }).click();
		const check = dialog.getByRole('region', { name: 'Agent setup check' });
		await expect(
			check.locator('[data-agent-check-rule="plugin-controller"]')
		).toHaveCount(2);
		await expect(
			check.getByText('MCP needs setup', { exact: false })
		).toHaveCount(2);
		await dialog.getByRole('button', { name: 'Set up', exact: true }).click();
		await expect(
			check.getByText('MCP registered', { exact: false })
		).toHaveCount(2, { timeout: 60_000 });
		await expect(check.locator('[data-agent-check-rule="hooks"]')).toHaveCount(
			0
		);
		// Cancellation is tested through the real renderer -> main path.
		await app.evaluate(({ dialog }) => {
			dialog.showMessageBox = async () => ({
				response: 0,
				checkboxChecked: false,
			});
		});
		await check
			.getByRole('button', { name: 'Disable plugin in Codex', exact: true })
			.click();
		await expect(check.getByText('No settings changed.')).toBeVisible();
		expect(
			await readFile(join(configHome, '.codex/config.toml'), 'utf8')
		).toContain('enabled = true');
		await app.evaluate(({ dialog }) => {
			dialog.showMessageBox = async () => ({
				response: 1,
				checkboxChecked: false,
			});
		});
		for (const client of ['Codex', 'Claude']) {
			await check
				.getByRole('button', {
					name: `Disable plugin in ${client}`,
					exact: true,
				})
				.click();
			await expect(
				check.getByRole('button', {
					name: `Disable plugin in ${client}`,
					exact: true,
				})
			).toHaveCount(0);
		}
		await expect(
			check.getByRole('button', { name: 'Undo', exact: true })
		).toHaveCount(2);
		await check
			.getByRole('button', { name: 'Undo', exact: true })
			.first()
			.click();
		await expect(
			check.getByRole('button', { name: 'Undo', exact: true })
		).toHaveCount(1);
		await check.getByRole('button', { name: 'Undo', exact: true }).click();
		await expect(
			check.locator('[data-agent-check-rule="plugin-controller"]')
		).toHaveCount(2);
		for (let client = 0; client < 2; client++) {
			await check
				.getByRole('button', { name: 'Add routing instructions', exact: true })
				.first()
				.click();
			await expect(
				check.locator('[data-agent-check-rule="routing"]')
			).toHaveCount(1 - client);
		}
		await harness.screenshot('agent-check-onboarding-dark');
		await dialog.getByRole('button', { name: 'Close setup' }).click();
		await harness.openPanel('simulator/lanes');
		await window.getByRole('button', { name: /^Agents(?: \(\d+\))?$/ }).click();
		const persistent = window.getByRole('region', {
			name: 'Agent setup check',
		});
		await expect(
			persistent.locator('[data-agent-check-rule="plugin-controller"]')
		).toHaveCount(2);
		await expect(
			persistent.locator('[data-agent-check-rule="routing"]')
		).toHaveCount(0);
		// An out-of-band config edit is picked up by post-setup Recheck.
		const settings = JSON.parse(
			await readFile(join(configHome, '.claude/settings.json'), 'utf8')
		);
		settings.enabledPlugins['simview@tools'] = false;
		await writeFile(
			join(configHome, '.claude/settings.json'),
			JSON.stringify(settings)
		);
		await persistent
			.getByRole('button', { name: 'Recheck', exact: true })
			.click();
		await expect(
			persistent.locator('[data-agent-check-rule="plugin-controller"]')
		).toHaveCount(1);
		expect(settings.permissions.allow).toEqual(['Read']);
		await app.evaluate(({ BrowserWindow }) => {
			BrowserWindow.getAllWindows()[0]?.setSize(1040, 700);
		});
		await harness.screenshot('agent-check-post-setup-dark');
		expect(
			await window.evaluate(
				() =>
					document.documentElement.scrollWidth <=
					document.documentElement.clientWidth
			)
		).toBe(true);
		await window.emulateMedia({ colorScheme: 'light' });
		await harness.screenshot('agent-check-post-setup-light');
	} catch (error) {
		if (harness) {
			console.log(
				'Agent check failure view:',
				await harness.window.locator('body').innerText()
			);
			await harness.screenshot('agent-check-failure');
		}
		throw error;
	} finally {
		await harness?.close();
		await rm(configHome, { recursive: true, force: true });
	}
});

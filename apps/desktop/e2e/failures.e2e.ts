import { execFileSync } from 'node:child_process';
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { DesktopHarness } from './harness';

test('failure history persists and subscription actions use a registered project at the minimum window size', async () => {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), 'rndt-failure-e2e-'))
	);
	const reports = join(root, 'reports');
	const profile = join(root, 'profile');
	const project = join(root, 'ExampleApp');
	await mkdir(reports);
	await mkdir(project);
	execFileSync('git', ['init', '-q', project]);
	await writeFile(
		join(reports, 'SpringBoard.ips'),
		JSON.stringify({
			procName: 'SpringBoard',
			parentProc: 'launchd_sim',
			coalitionName:
				'com.apple.CoreSimulator.SimDevice.AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
			exception: { type: 'EXC_CRASH', signal: 'SIGABRT' },
			threads: [{ frames: [{ symbol: 'exampleSnapshotFrame' }] }],
		})
	);
	await writeFile(
		join(reports, 'CoreSimulator.diag'),
		'Command: com.apple.CoreSimulator.CoreSimulatorService\nEvent: disk writes\nAction taken: none'
	);
	let harness: DesktopHarness | undefined;
	try {
		harness = await DesktopHarness.launch({
			failureReports: reports,
			userDataDir: profile,
		});
		let { window, app } = harness;
		await app.evaluate(({ BrowserWindow }) => {
			BrowserWindow.getAllWindows()[0]?.setSize(1040, 700);
		});
		await harness.openPanel('simulator/lanes');
		await window.getByRole('button', { name: 'Failures', exact: true }).click();
		let region = window.getByRole('region', { name: 'Failure history' });
		await expect(region.locator('.failure-row')).toHaveCount(2);
		await region.getByRole('button', { name: /SpringBoard crashed/ }).click();
		await expect(
			region.getByRole('button', { name: 'Investigate', exact: true })
		).toBeDisabled();
		await expect(region.locator('.failure-evidence')).toContainText('SIGABRT');
		await region.getByRole('button', { name: 'Mark resolved' }).click();
		await expect(region.locator('.failure-row')).toHaveCount(1);
		await expect(region.locator('.failure-evidence')).toContainText(
			'does not itself establish a process crash'
		);
		await region.getByRole('button', { name: 'Scan now' }).click();
		await expect(region.locator('.failure-row')).toHaveCount(1);
		await harness.close();
		harness = await DesktopHarness.launch({
			failureReports: reports,
			userDataDir: profile,
		});
		({ window, app } = harness);
		await harness.openPanel('simulator/lanes');
		await app.evaluate(({ dialog }, selected) => {
			dialog.showOpenDialog = async () => ({
				canceled: false,
				filePaths: [selected],
			});
		}, project);
		await window
			.getByRole('button', { name: 'Track repository', exact: true })
			.click();
		await window.getByRole('button', { name: 'Failures', exact: true }).click();
		region = window.getByRole('region', { name: 'Failure history' });
		await region.getByLabel('Failure filter').selectOption('resolved');
		await expect(region.locator('.failure-row')).toHaveCount(1);
		await region.getByRole('button', { name: 'Reopen', exact: true }).click();
		await region.getByLabel('Failure filter').selectOption('open');
		await expect(region.locator('.failure-row')).toHaveCount(2);
		await region.getByRole('button', { name: /SpringBoard crashed/ }).click();
		await region.getByLabel('Failure project').selectOption(project);
		await expect(
			region.getByRole('button', { name: 'Investigate', exact: true })
		).toBeEnabled();
		// Opt-in verification on a Mac signed into both subscription clients.
		// Exercise the real auth checks and generated task, intercept only Terminal launch.
		if (process.env.RNDEVTOOLS_E2E_SUBSCRIPTION_LOGIN === 'true') {
			await app.evaluate(({ dialog, shell }) => {
				dialog.showMessageBox = async () => ({
					response: 1,
					checkboxChecked: false,
				});
				shell.openPath = async (script) => {
					process.env.RNDEVTOOLS_E2E_OPENED_TASK = script;
					return '';
				};
			});
			for (const client of ['claude', 'codex']) {
				await region.getByLabel('Failure agent').selectOption(client);
				await region
					.getByRole('button', {
						name: client === 'claude' ? 'Fix with Claude' : 'Fix with Codex',
						exact: true,
					})
					.click();
				await expect(
					region.getByText('opened in Terminal', { exact: false })
				).toBeVisible({ timeout: 30_000 });
				const script = await app.evaluate(
					() => process.env.RNDEVTOOLS_E2E_OPENED_TASK
				);
				expect(await readFile(script as string, 'utf8')).toContain(
					'unset OPENAI_API_KEY'
				);
			}
			await app.evaluate(({ dialog }) => {
				dialog.showMessageBox = async () => ({
					response: 0,
					checkboxChecked: false,
				});
			});
			await region
				.getByRole('button', { name: 'Investigate', exact: true })
				.click();
			await expect(region.getByText('Task cancelled.')).toBeVisible({
				timeout: 30_000,
			});
		}
		await app.evaluate(({ BrowserWindow }) => {
			BrowserWindow.getAllWindows()[0]?.setSize(1040, 700);
		});
		await window.emulateMedia({ colorScheme: 'dark' });
		await harness.screenshot('failures-dark');
		expect(
			await window.evaluate(
				() =>
					document.documentElement.scrollWidth <=
					document.documentElement.clientWidth
			)
		).toBe(true);
		await window.emulateMedia({ colorScheme: 'light' });
		await harness.screenshot('failures-light');
	} finally {
		await harness?.close();
		await rm(root, { recursive: true, force: true });
	}
});

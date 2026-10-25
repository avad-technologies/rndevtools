import {
	chmod,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createSimulatorOnboardingIpcHandlers,
	resolveXcodeDeveloperDirectory,
	validateXcodeDeveloperDirectory,
} from './simulator-onboarding-ipc';

const event = { sender: { id: 7 } } as unknown as IpcMainInvokeEvent;
const roots: string[] = [];

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true }))
	);
});

describe('Simulator onboarding IPC', () => {
	it('validates a selected Xcode bundle without exposing its path to the renderer', async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), 'rndevtools-xcode-'));
		roots.push(root);
		const application = path.join(root, 'Xcode Test.app');
		const developerDirectory = path.join(application, 'Contents', 'Developer');
		const xcodebuild = path.join(
			developerDirectory,
			'usr',
			'bin',
			'xcodebuild'
		);
		await mkdir(path.dirname(xcodebuild), { recursive: true });
		await writeFile(xcodebuild, '#!/bin/sh\nexit 0\n');
		await chmod(xcodebuild, 0o755);

		const activate = vi.fn(async () => undefined);
		const handlers = createSimulatorOnboardingIpcHandlers({
			assertTrustedRenderer: vi.fn(),
			selectXcodeApplication: vi.fn(async () => application),
			activateXcodeDeveloperDirectory: activate,
			openPrivacySettings: vi.fn(async () => undefined),
			revealAgentCli: vi.fn(async () => undefined),
			setupAgentCli: vi.fn(async () => []),
		});
		const receipt = await handlers.runOperation(event, {
			actionId: 'choose-xcode',
			kind: 'toolchain.selectXcode',
		});
		expect(receipt).toEqual({
			actionId: 'choose-xcode',
			kind: 'toolchain.selectXcode',
			completed: true,
			requiresRefresh: true,
		});
		expect(activate).toHaveBeenCalledWith(
			await resolveXcodeDeveloperDirectory(application)
		);
		expect(await validateXcodeDeveloperDirectory(developerDirectory)).toBe(
			await realpath(developerDirectory)
		);
		expect(JSON.stringify(receipt)).not.toContain(root);
	});

	it('maps only typed privacy and CLI operations after checking renderer trust', async () => {
		const assertTrustedRenderer = vi.fn();
		const openPrivacySettings = vi.fn(async () => undefined);
		const revealAgentCli = vi.fn(async () => undefined);
		const setupAgentCli = vi.fn(async () => [
			'Updated ~/.claude.json',
			'Agents can reach RN Devtools now.',
		]);
		const handlers = createSimulatorOnboardingIpcHandlers({
			assertTrustedRenderer,
			selectXcodeApplication: vi.fn(async () => undefined),
			activateXcodeDeveloperDirectory: vi.fn(async () => undefined),
			openPrivacySettings,
			revealAgentCli,
			setupAgentCli,
		});
		await expect(
			handlers.runOperation(event, {
				actionId: 'privacy',
				kind: 'privacy.openSettings',
				permission: 'screen_recording',
			})
		).resolves.toMatchObject({ completed: true });
		await expect(
			handlers.runOperation(event, {
				actionId: 'cli',
				kind: 'agentCli.reveal',
			})
		).resolves.toMatchObject({ completed: true });
		await expect(
			handlers.runOperation(event, {
				actionId: 'setup',
				kind: 'agentCli.setup',
			})
		).resolves.toMatchObject({
			completed: true,
			summary: ['Updated ~/.claude.json', 'Agents can reach RN Devtools now.'],
		});
		expect(openPrivacySettings).toHaveBeenCalledWith('screen_recording');
		expect(revealAgentCli).toHaveBeenCalledOnce();
		expect(setupAgentCli).toHaveBeenCalledOnce();
		expect(assertTrustedRenderer).toHaveBeenCalledTimes(3);
		await expect(
			handlers.runOperation(event, {
				actionId: 'unsafe',
				kind: 'privacy.openSettings',
				permission: '../../terminal',
			})
		).rejects.toThrow();
	});
});

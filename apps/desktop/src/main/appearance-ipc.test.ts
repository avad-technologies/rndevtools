import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { AppearancePreference } from '../shared/appearance-protocol';
import {
	createAppearanceIpcHandlers,
	windowChromeColors,
} from './appearance-ipc';

const event = { sender: { id: 7 } } as unknown as IpcMainInvokeEvent;

function handlers(stored: AppearancePreference = 'system') {
	const calls: string[] = [];
	const assertTrustedRenderer = vi.fn();
	const saveAppearance = vi.fn(async (preference: AppearancePreference) => {
		calls.push(`save:${preference}`);
	});
	const applyAppearance = vi.fn((preference: AppearancePreference) => {
		calls.push(`apply:${preference}`);
	});
	return {
		calls,
		assertTrustedRenderer,
		saveAppearance,
		applyAppearance,
		...createAppearanceIpcHandlers({
			assertTrustedRenderer,
			readAppearance: () => stored,
			saveAppearance,
			applyAppearance,
		}),
	};
}

describe('Appearance IPC', () => {
	it('reads the stored preference for a trusted renderer', () => {
		const ipc = handlers('dark');
		expect(ipc.getAppearance(event)).toBe('dark');
		expect(ipc.assertTrustedRenderer).toHaveBeenCalledWith(event);
	});

	it('saves a preference before the window follows it', async () => {
		const ipc = handlers();
		await expect(ipc.setAppearance(event, 'light')).resolves.toBe('light');
		expect(ipc.calls).toEqual(['save:light', 'apply:light']);
	});

	it('changes nothing when the preference is invalid, untrusted or unsaved', async () => {
		const invalid = handlers();
		await expect(invalid.setAppearance(event, 'sepia')).rejects.toThrow();
		expect(invalid.calls).toEqual([]);

		const untrusted = handlers();
		untrusted.assertTrustedRenderer.mockImplementation(() => {
			throw new Error('Rejected IPC from an untrusted renderer.');
		});
		await expect(untrusted.setAppearance(event, 'dark')).rejects.toThrow(
			'untrusted renderer'
		);
		expect(() => untrusted.getAppearance(event)).toThrow('untrusted renderer');
		expect(untrusted.calls).toEqual([]);

		const unsaved = handlers();
		unsaved.saveAppearance.mockRejectedValueOnce(new Error('disk full'));
		await expect(unsaved.setAppearance(event, 'dark')).rejects.toThrow(
			'disk full'
		);
		expect(unsaved.applyAppearance).not.toHaveBeenCalled();
	});

	it('paints the native window in the theme the renderer shows', () => {
		expect(windowChromeColors(true).background).toBe('#000000');
		expect(windowChromeColors(false).background).toBe('#ffffff');
		expect(windowChromeColors(false).titleBarSymbol).not.toBe(
			windowChromeColors(false).titleBar
		);
	});
});

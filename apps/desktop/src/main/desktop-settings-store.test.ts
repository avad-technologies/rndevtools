import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopSettingsStore } from './desktop-settings-store';

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true }))
	);
});

async function fixture() {
	const root = await mkdtemp(
		path.join(tmpdir(), 'rndevtools-desktop-settings-')
	);
	roots.push(root);
	return { root, store: new DesktopSettingsStore(root) };
}

describe('DesktopSettingsStore', () => {
	it('atomically persists the selected developer directory with private permissions', async () => {
		const { root, store } = await fixture();
		await store.load();
		await store.setXcodeDeveloperDirectory(
			'/Applications/Xcode.app/Contents/Developer'
		);
		const file = path.join(root, 'settings-v1.json');
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
			version: 1,
			xcodeDeveloperDirectory: '/Applications/Xcode.app/Contents/Developer',
		});
		expect(await new DesktopSettingsStore(root).load()).toMatchObject({
			xcodeDeveloperDirectory: '/Applications/Xcode.app/Contents/Developer',
		});
	});

	it('defaults the appearance to system and persists a chosen one', async () => {
		const { root, store } = await fixture();
		await store.load();
		expect(store.appearance).toBe('system');
		await store.setAppearance('light');
		expect(store.appearance).toBe('light');
		const reloaded = new DesktopSettingsStore(root);
		expect(await reloaded.load()).toEqual({ version: 1, appearance: 'light' });
		expect(reloaded.appearance).toBe('light');
	});

	it('keeps every other field when one changes, even with writes queued together', async () => {
		const { root, store } = await fixture();
		await store.load();
		await Promise.all([
			store.setXcodeDeveloperDirectory(
				'/Applications/Xcode.app/Contents/Developer'
			),
			store.setAppearance('dark'),
		]);
		expect(await new DesktopSettingsStore(root).load()).toEqual({
			version: 1,
			xcodeDeveloperDirectory: '/Applications/Xcode.app/Contents/Developer',
			appearance: 'dark',
		});

		await store.setXcodeDeveloperDirectory(undefined);
		expect(
			JSON.parse(await readFile(path.join(root, 'settings-v1.json'), 'utf8'))
		).toEqual({ version: 1, appearance: 'dark' });
	});

	it('fails closed on malformed state instead of replacing it', async () => {
		const { root, store } = await fixture();
		await writeFile(path.join(root, 'settings-v1.json'), '{"version":2}');
		await expect(store.load()).rejects.toThrow();
	});

	it('recovers its write queue after failure and persists only a successful selection', async () => {
		const { root, store } = await fixture();
		await store.load();
		await rm(root, { recursive: true });
		await writeFile(root, 'blocks directory recreation');

		await expect(
			store.setXcodeDeveloperDirectory(
				'/Applications/Failed.app/Contents/Developer'
			)
		).rejects.toThrow();

		await rm(root);
		await mkdir(root);
		await store.setXcodeDeveloperDirectory(
			'/Applications/Xcode.app/Contents/Developer'
		);
		expect(await new DesktopSettingsStore(root).load()).toEqual({
			version: 1,
			xcodeDeveloperDirectory: '/Applications/Xcode.app/Contents/Developer',
		});
	});
});

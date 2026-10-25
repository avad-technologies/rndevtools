import { chmod, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
	type AppearancePreference,
	appearancePreferenceSchema,
} from '../shared/appearance-protocol';
import { writeFileAtomic } from './private-files';

const MAX_SETTINGS_BYTES = 64 * 1024;
const settingsSchema = z.strictObject({
	version: z.literal(1),
	xcodeDeveloperDirectory: z
		.string()
		.min(1)
		.max(4 * 1024)
		.optional(),
	appearance: appearancePreferenceSchema.optional(),
});
type DesktopSettings = z.infer<typeof settingsSchema>;
type DesktopSettingsPatch = Partial<Omit<DesktopSettings, 'version'>>;

export class DesktopSettingsStore {
	readonly #directory: string;
	readonly #filePath: string;
	#settings: DesktopSettings = { version: 1 };
	#writeQueue: Promise<void> = Promise.resolve();

	constructor(directory: string) {
		this.#directory = path.resolve(directory);
		this.#filePath = path.join(this.#directory, 'settings-v1.json');
	}

	async load(): Promise<DesktopSettings> {
		await mkdir(this.#directory, { recursive: true, mode: 0o700 });
		await chmod(this.#directory, 0o700);
		try {
			const text = await readFile(this.#filePath, 'utf8');
			if (Buffer.byteLength(text, 'utf8') > MAX_SETTINGS_BYTES) {
				throw new Error('Desktop settings exceed the safe size limit.');
			}
			this.#settings = settingsSchema.parse(JSON.parse(text) as unknown);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			this.#settings = { version: 1 };
		}
		return { ...this.#settings };
	}

	get appearance(): AppearancePreference {
		return this.#settings.appearance ?? 'system';
	}

	async setXcodeDeveloperDirectory(value: string | undefined): Promise<void> {
		await this.#update({ xcodeDeveloperDirectory: value || undefined });
	}

	async setAppearance(value: AppearancePreference): Promise<void> {
		await this.#update({ appearance: value });
	}

	/**
	 * Applies a patch to the settings in effect when its turn in the queue
	 * comes, so queued writes to different fields never undo each other. An
	 * undefined field is removed.
	 */
	async #update(patch: DesktopSettingsPatch): Promise<void> {
		const write = this.#writeQueue
			.catch(() => undefined)
			.then(async () => {
				const nextSettings = settingsSchema.parse(
					Object.fromEntries(
						Object.entries({ ...this.#settings, ...patch }).filter(
							([, value]) => value !== undefined
						)
					)
				);
				await this.#writeAtomically(JSON.stringify(nextSettings));
				this.#settings = nextSettings;
			});
		this.#writeQueue = write;
		await write;
	}

	async #writeAtomically(contents: string): Promise<void> {
		await mkdir(this.#directory, { recursive: true, mode: 0o700 });
		await chmod(this.#directory, 0o700);
		await writeFileAtomic(this.#filePath, `${contents}\n`, 'settings-v1');
	}
}

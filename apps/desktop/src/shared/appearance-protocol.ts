import { z } from 'zod';

/** `system` follows macOS; `light` and `dark` hold whatever macOS shows. */
export const appearancePreferenceSchema = z.enum(['system', 'light', 'dark']);
export type AppearancePreference = z.infer<typeof appearancePreferenceSchema>;

export type AppearanceBridge = {
	getAppearance: () => Promise<AppearancePreference>;
	setAppearance: (
		preference: AppearancePreference
	) => Promise<AppearancePreference>;
};

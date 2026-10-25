import type { IpcMainInvokeEvent } from 'electron';
import {
	type AppearancePreference,
	appearancePreferenceSchema,
} from '../shared/appearance-protocol';

/**
 * The native colours around the renderer: the window background matches its
 * `--background` so a resize never flashes the other theme, and the Windows
 * and Linux caption buttons sit on its titlebar `--chrome`.
 */
export function windowChromeColors(dark: boolean): {
	background: string;
	titleBar: string;
	titleBarSymbol: string;
} {
	return dark
		? { background: '#000000', titleBar: '#0a0a0a', titleBarSymbol: '#a1a1a1' }
		: { background: '#ffffff', titleBar: '#fafafa', titleBarSymbol: '#575757' };
}

type AppearanceIpcDependencies = {
	assertTrustedRenderer: (event: IpcMainInvokeEvent) => void;
	readAppearance: () => AppearancePreference;
	saveAppearance: (preference: AppearancePreference) => Promise<void>;
	/** Hands the preference to `nativeTheme`, which the renderer follows. */
	applyAppearance: (preference: AppearancePreference) => void;
};

export function createAppearanceIpcHandlers({
	assertTrustedRenderer,
	readAppearance,
	saveAppearance,
	applyAppearance,
}: AppearanceIpcDependencies) {
	return {
		getAppearance: (event: IpcMainInvokeEvent): AppearancePreference => {
			assertTrustedRenderer(event);
			return readAppearance();
		},
		setAppearance: async (
			event: IpcMainInvokeEvent,
			value: unknown
		): Promise<AppearancePreference> => {
			assertTrustedRenderer(event);
			const preference = appearancePreferenceSchema.parse(value);
			// Saved first, so the window never shows a theme the next launch
			// would not.
			await saveAppearance(preference);
			applyAppearance(preference);
			return preference;
		},
	};
}

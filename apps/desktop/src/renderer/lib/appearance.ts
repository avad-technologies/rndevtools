import { useSyncExternalStore } from 'react';
import { createBrowserAppearanceBridge } from '@/lib/browser-bridge';
import { errorText } from '@/lib/runtime-action';
import type {
	AppearanceBridge,
	AppearancePreference,
} from '../../shared/appearance-protocol';

export type ResolvedTheme = 'light' | 'dark';

export type AppearanceSnapshot = {
	preference: AppearancePreference;
	/** What the window shows: the preference, or macOS's choice for system. */
	theme: ResolvedTheme;
	/** False when nothing can store a preference, so the control is disabled. */
	available: boolean;
	error: string | null;
};

/** The theme a preference shows while macOS is light or dark. */
export function resolveTheme(
	preference: AppearancePreference,
	systemDark: boolean
): ResolvedTheme {
	if (preference === 'system') return systemDark ? 'dark' : 'light';
	return preference;
}

/**
 * Mirrors the theme onto the root element for HeroUI's variables and
 * Tailwind's `dark:` variant. The app's own tokens follow `color-scheme`,
 * which the class pins too.
 */
export function applyTheme(
	root: Pick<HTMLElement, 'classList' | 'dataset'>,
	theme: ResolvedTheme
): void {
	root.classList.toggle('dark', theme === 'dark');
	root.classList.toggle('light', theme === 'light');
	root.dataset.theme = theme;
}

function appearanceBridge(): AppearanceBridge | null {
	const candidate = window.rnDevtools as Partial<AppearanceBridge> | undefined;
	if (
		typeof candidate?.getAppearance === 'function' &&
		typeof candidate.setAppearance === 'function'
	) {
		return candidate as AppearanceBridge;
	}
	if (candidate || navigator.userAgent.toLowerCase().includes('electron')) {
		return null;
	}
	return createBrowserAppearanceBridge();
}

let bridge: AppearanceBridge | null = null;
let systemDark: MediaQueryList | null = null;
let snapshot: AppearanceSnapshot = {
	preference: 'system',
	theme: 'dark',
	available: false,
	error: null,
};
let latestRequest = 0;
let shownTheme: ResolvedTheme | null = null;
const listeners = new Set<() => void>();

function render(): void {
	const theme = snapshot.theme;
	if (theme === shownTheme) return;
	const root = document.documentElement;
	const switching = shownTheme !== null;
	shownTheme = theme;
	if (switching) root.classList.add('theme-switching');
	applyTheme(root, theme);
	if (switching) {
		// Reading a style computes the new colours while transitions are off,
		// so no control fades from the old theme; a timer, unlike a frame
		// callback, still restores them in a hidden window.
		void getComputedStyle(document.body).color;
		setTimeout(() => root.classList.remove('theme-switching'), 0);
	}
}

function publish(next: Partial<Omit<AppearanceSnapshot, 'theme'>> = {}): void {
	const merged = { ...snapshot, ...next };
	snapshot = {
		...merged,
		theme: resolveTheme(merged.preference, systemDark?.matches ?? false),
	};
	render();
	for (const listener of listeners) listener();
}

/**
 * Paints the theme before the first render and keeps it in step with macOS.
 * In the desktop app `prefers-color-scheme` already reflects the stored
 * preference, because main sets `nativeTheme.themeSource` before the window
 * opens; reading the preference here only labels the control.
 */
export function startAppearance(): void {
	bridge = appearanceBridge();
	systemDark = window.matchMedia('(prefers-color-scheme: dark)');
	systemDark.addEventListener('change', () => publish());
	publish({ available: bridge !== null });
	bridge?.getAppearance().then(
		(preference) => {
			if (latestRequest === 0) publish({ preference });
		},
		() => {
			// The window keeps following its own color scheme.
		}
	);
}

/** Shows the choice at once, then keeps what main saved or reverts. */
export async function setAppearancePreference(
	preference: AppearancePreference
): Promise<void> {
	if (!bridge) return;
	const request = ++latestRequest;
	const previous = snapshot.preference;
	publish({ preference, error: null });
	try {
		const saved = await bridge.setAppearance(preference);
		if (request === latestRequest) publish({ preference: saved });
	} catch (error) {
		if (request === latestRequest) {
			publish({ preference: previous, error: errorText(error) });
		}
	}
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function useAppearance(): AppearanceSnapshot {
	const read = () => snapshot;
	return useSyncExternalStore(subscribe, read, read);
}

import { useSyncExternalStore } from 'react';

const SETUP_KEY = 'rndevtools.desktop.onboarding.setup';
const CHECKLIST_KEY = 'rndevtools.desktop.onboarding.checklist';

export const SETUP_STEPS = [
	'welcome',
	'mac',
	'project',
	'app',
	'extras',
	'ready',
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export type OnboardingSnapshot = Readonly<{
	/** The setup window and the step it shows. */
	setup: Readonly<{ open: boolean; step: SetupStep }>;
	/** Setup was finished or closed, so it no longer opens by itself. */
	setupDone: boolean;
	/** The Get started checklist was hidden from the sidebar. */
	checklistHidden: boolean;
}>;

function read(key: string): string | null {
	try {
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
}

function write(key: string, value: string | null): void {
	try {
		if (value === null) window.localStorage.removeItem(key);
		else window.localStorage.setItem(key, value);
	} catch {
		// Onboarding preferences are best-effort; setup still works without them.
	}
}

let snapshot: OnboardingSnapshot = {
	setup: { open: false, step: 'welcome' },
	setupDone: read(SETUP_KEY) === 'done',
	checklistHidden: read(CHECKLIST_KEY) === 'hidden',
};
const listeners = new Set<() => void>();

function publish(next: Partial<OnboardingSnapshot>): void {
	snapshot = { ...snapshot, ...next };
	for (const listener of listeners) listener();
}

export function openSetup(step: SetupStep = 'welcome'): void {
	publish({ setup: { open: true, step } });
}

export function setSetupStep(step: SetupStep): void {
	publish({ setup: { ...snapshot.setup, step } });
}

/** Closing setup, finished or not, keeps it from opening by itself again. */
export function closeSetup(): void {
	write(SETUP_KEY, 'done');
	publish({ setup: { ...snapshot.setup, open: false }, setupDone: true });
}

export function setChecklistHidden(hidden: boolean): void {
	write(CHECKLIST_KEY, hidden ? 'hidden' : null);
	publish({ checklistHidden: hidden });
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function useOnboarding(): OnboardingSnapshot {
	const read = () => snapshot;
	return useSyncExternalStore(subscribe, read, read);
}

/** The step before or after, or the same step at either end. */
export function adjacentSetupStep(step: SetupStep, offset: -1 | 1): SetupStep {
	const index = SETUP_STEPS.indexOf(step) + offset;
	return (
		SETUP_STEPS[Math.min(Math.max(index, 0), SETUP_STEPS.length - 1)] ?? step
	);
}

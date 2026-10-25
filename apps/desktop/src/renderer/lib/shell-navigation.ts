/**
 * The Simulators panel, `#simulator/fleet`. It needs no connected app, so it
 * is where a failed view sends the operator.
 */
export const SIMULATORS_PANEL = 'simulator/fleet';

type PanelRecovery =
	| { kind: 'open'; label: string; hash: string }
	| { kind: 'retry'; label: string };

/**
 * What a failed panel offers. A reload keeps the hash and lands on the same
 * panel, so the fallback opens the Simulators panel instead. When that is the
 * panel that failed, opening it would change nothing, so it retries in place.
 */
export function panelRecovery(panel: string): PanelRecovery {
	return panel === SIMULATORS_PANEL
		? { kind: 'retry', label: 'Try again' }
		: { kind: 'open', label: 'Open Simulators', hash: `#${SIMULATORS_PANEL}` };
}

/** Formats shortcut digits for a hint: '1–8', or '1–3, 5' around a gap. */
export function formatShortcutRange(shortcuts: readonly number[]): string {
	const sorted = [...new Set(shortcuts)].sort((left, right) => left - right);
	const runs: Array<{ first: number; last: number }> = [];
	for (const shortcut of sorted) {
		const run = runs.at(-1);
		if (run && shortcut === run.last + 1) run.last = shortcut;
		else runs.push({ first: shortcut, last: shortcut });
	}
	return runs
		.map(({ first, last }) =>
			first === last ? `${first}` : `${first}–${last}`
		)
		.join(', ');
}

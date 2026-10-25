import { describe, expect, it } from 'vitest';
import { isSimulatorToolId } from '@/simulator/simulator-config';
import {
	formatShortcutRange,
	panelRecovery,
	SIMULATORS_PANEL,
} from './shell-navigation';

describe('panelRecovery', () => {
	it('sends a failed panel to the Simulators panel instead of reloading it', () => {
		expect(panelRecovery('simulator/lanes')).toEqual({
			kind: 'open',
			label: 'Open Simulators',
			hash: '#simulator/fleet',
		});
		expect(panelRecovery('connected/network')).toEqual({
			kind: 'open',
			label: 'Open Simulators',
			hash: '#simulator/fleet',
		});
	});

	it('retries in place when the Simulators panel itself failed', () => {
		// Opening the panel that is already showing would change nothing.
		expect(panelRecovery(SIMULATORS_PANEL)).toEqual({
			kind: 'retry',
			label: 'Try again',
		});
	});

	it('names a real Simulator tool', () => {
		const [workspace, tool = ''] = SIMULATORS_PANEL.split('/');
		expect(workspace).toBe('simulator');
		expect(isSimulatorToolId(tool)).toBe(true);
	});
});

describe('formatShortcutRange', () => {
	it('formats contiguous shortcuts as one range', () => {
		expect(formatShortcutRange([1, 2, 3, 4, 5, 6, 7, 8])).toBe('1–8');
	});

	it('sorts and deduplicates before formatting', () => {
		expect(formatShortcutRange([3, 1, 2, 2])).toBe('1–3');
	});

	it('lists gaps instead of implying a shortcut that does nothing', () => {
		expect(formatShortcutRange([1, 2, 3, 5, 7, 8])).toBe('1–3, 5, 7–8');
	});

	it('handles a single shortcut and none', () => {
		expect(formatShortcutRange([4])).toBe('4');
		expect(formatShortcutRange([])).toBe('');
	});
});

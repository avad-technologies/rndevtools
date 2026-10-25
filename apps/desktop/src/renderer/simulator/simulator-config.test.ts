import { describe, expect, it } from 'vitest';
import {
	isSimulatorToolId,
	SIMULATOR_TOOL_GROUPS,
	simulatorToolSections,
	simulatorTools,
} from './simulator-config';

describe('simulatorTools', () => {
	it('gives every tool its own shortcut digit, 1–9 in sidebar order', () => {
		const shortcuts = simulatorTools.map((tool) => tool.shortcut);
		expect(new Set(shortcuts).size).toBe(shortcuts.length);
		expect(shortcuts).toEqual(shortcuts.map((_, index) => index + 1));
		// Electron owns 0, so nothing may bind it.
		expect(shortcuts.every((digit) => digit >= 1 && digit <= 9)).toBe(true);
	});

	it('lists the groups in order, each tool contiguous with its group', () => {
		const order = SIMULATOR_TOOL_GROUPS.map((group) => group.id);
		const seen = simulatorTools.map((tool) => order.indexOf(tool.group));
		expect(seen.every((index) => index >= 0)).toBe(true);
		expect([...seen].sort((left, right) => left - right)).toEqual(seen);
	});

	it('registers Supabase in the Backend group on ⌘8 and moves Settings to ⌘9', () => {
		const supabase = simulatorTools.find((tool) => tool.id === 'supabase');
		expect(supabase).toMatchObject({
			label: 'Supabase',
			shortcut: 8,
			group: 'backend',
		});
		expect(simulatorTools.find((tool) => tool.id === 'settings')).toMatchObject(
			{ shortcut: 9, group: 'system' }
		);
		expect(
			simulatorTools
				.filter((tool) => tool.id !== 'supabase' && tool.id !== 'settings')
				.every((tool) => tool.group === 'simulator')
		).toBe(true);
	});

	it('knows its own ids only', () => {
		expect(isSimulatorToolId('supabase')).toBe(true);
		expect(isSimulatorToolId('backends')).toBe(false);
	});
});

describe('simulatorToolSections', () => {
	it('renders SIMULATOR, BACKEND and SYSTEM with one entry per tool', () => {
		const sections = simulatorToolSections();
		expect(sections.map((section) => section.label)).toEqual([
			'Simulator',
			'Backend',
			'System',
		]);
		expect(sections.flatMap((section) => section.tools)).toEqual(
			simulatorTools
		);
		expect(sections[1]?.tools.map((tool) => tool.id)).toEqual(['supabase']);
		expect(sections[2]?.tools.map((tool) => tool.id)).toEqual(['settings']);
	});

	it('leaves out a section with no tools', () => {
		const sections = simulatorToolSections(
			simulatorTools.filter((tool) => tool.group !== 'backend')
		);
		expect(sections.map((section) => section.id)).toEqual([
			'simulator',
			'system',
		]);
	});
});

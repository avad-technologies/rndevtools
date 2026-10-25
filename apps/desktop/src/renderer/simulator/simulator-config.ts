import {
	AppWindow,
	Bot,
	Camera,
	DatabaseZap,
	Gauge,
	Layers3,
	Settings2,
	Smartphone,
	Waypoints,
} from 'lucide-react';
import type { ComponentType } from 'react';

export type SimulatorToolId =
	| 'fleet'
	| 'actions'
	| 'slimming'
	| 'captures'
	| 'automation'
	| 'builds'
	| 'lanes'
	| 'supabase'
	| 'settings';

/**
 * The sidebar section a tool is listed under.
 */
export type SimulatorToolGroup = 'simulator' | 'backend' | 'system';

export type SimulatorToolDefinition = {
	id: SimulatorToolId;
	label: string;
	icon: ComponentType<{ className?: string }>;
	shortcut: number;
	group: SimulatorToolGroup;
	/** A short release-stage tag beside the label, such as Alpha. */
	tag?: string;
};

/**
 * The sidebar sections in order. Tools are listed in the order below and
 * their shortcuts count up across the sections, so the digits read 1–9 from
 * top to bottom.
 */
export const SIMULATOR_TOOL_GROUPS: readonly {
	id: SimulatorToolGroup;
	label: string;
}[] = [
	{ id: 'simulator', label: 'Simulator' },
	{ id: 'backend', label: 'Backend' },
	{ id: 'system', label: 'System' },
];

export const simulatorTools: SimulatorToolDefinition[] = [
	{
		id: 'fleet',
		label: 'Simulators',
		icon: Smartphone,
		shortcut: 1,
		group: 'simulator',
	},
	{
		id: 'actions',
		label: 'App Actions',
		icon: AppWindow,
		shortcut: 2,
		group: 'simulator',
	},
	{
		id: 'slimming',
		label: 'SimSlim',
		icon: Layers3,
		shortcut: 3,
		group: 'simulator',
	},
	{
		id: 'captures',
		label: 'Captures',
		icon: Camera,
		shortcut: 4,
		group: 'simulator',
	},
	{
		id: 'automation',
		label: 'Automation',
		icon: Bot,
		shortcut: 5,
		group: 'simulator',
	},
	{
		id: 'builds',
		label: 'Build Insights',
		icon: Gauge,
		shortcut: 6,
		group: 'simulator',
	},
	{
		id: 'lanes',
		label: 'Lanes',
		icon: Waypoints,
		shortcut: 7,
		group: 'simulator',
	},
	{
		id: 'supabase',
		label: 'Supabase',
		icon: DatabaseZap,
		shortcut: 8,
		group: 'backend',
		tag: 'Alpha',
	},
	{
		id: 'settings',
		label: 'Settings',
		icon: Settings2,
		shortcut: 9,
		group: 'system',
	},
];

export function isSimulatorToolId(value: string): value is SimulatorToolId {
	return simulatorTools.some((tool) => tool.id === value);
}

/** The sidebar sections with their tools; sections without tools are left out. */
export function simulatorToolSections(
	tools: readonly SimulatorToolDefinition[] = simulatorTools
): {
	id: SimulatorToolGroup;
	label: string;
	tools: SimulatorToolDefinition[];
}[] {
	return SIMULATOR_TOOL_GROUPS.flatMap((group) => {
		const members = tools.filter((tool) => tool.group === group.id);
		return members.length === 0 ? [] : [{ ...group, tools: members }];
	});
}

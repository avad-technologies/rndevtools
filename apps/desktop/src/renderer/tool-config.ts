import {
	Activity,
	BoxSelect,
	Camera,
	Database,
	FileClock,
	Logs,
	Network,
	Orbit,
	Route,
	Settings2,
	Store,
	TerminalSquare,
	UserRoundCheck,
	Workflow,
} from 'lucide-react';
import type { ComponentType } from 'react';
import type { DeviceSession, ToolId } from '../shared/protocol';

type ToolDefinition = {
	id: ToolId;
	label: string;
	icon: ComponentType<{ className?: string }>;
	count: (device: DeviceSession | null) => number | undefined;
};

type ToolGroup = {
	label: string;
	tools: ToolDefinition[];
};

export const toolGroups: ToolGroup[] = [
	{
		label: 'Traffic',
		tools: [
			{
				id: 'network',
				label: 'Network',
				icon: Network,
				count: (device) => device?.tools.network.length,
			},
			{
				id: 'console',
				label: 'Console',
				icon: Logs,
				count: (device) => device?.tools.console.length,
			},
		],
	},
	{
		label: 'State & data',
		tools: [
			{
				id: 'storage',
				label: 'Storage',
				icon: Database,
				count: (device) => device?.tools.storage.length,
			},
			{
				id: 'query',
				label: 'Query cache',
				icon: Orbit,
				count: (device) => device?.tools.queries.length,
			},
			{
				id: 'zustand',
				label: 'Zustand',
				icon: Store,
				count: (device) => device?.tools.zustandStores.length,
			},
			{
				id: 'restore',
				label: 'Restore points',
				icon: FileClock,
				count: (device) => device?.tools.restorePoints.length,
			},
			{
				id: 'scenarios',
				label: 'Scenarios',
				icon: Workflow,
				count: (device) => device?.tools.scenarios.length,
			},
			{
				id: 'identity',
				label: 'Test identities',
				icon: UserRoundCheck,
				count: (device) =>
					device?.tools.identitySession.active ? 1 : undefined,
			},
		],
	},
	{
		label: 'App',
		tools: [
			{
				id: 'routes',
				label: 'Routes',
				icon: Route,
				count: (device) => device?.tools.routes.length,
			},
			{
				id: 'environment',
				label: 'Environment',
				icon: Settings2,
				count: (device) =>
					device?.tools.environment.filter(
						(entry) => !['valid', 'unchecked'].includes(entry.status)
					).length,
			},
			{
				id: 'components',
				label: 'Components',
				icon: BoxSelect,
				count: (device) => device?.tools.components.length,
			},
			{
				id: 'camera',
				label: 'Camera fixtures',
				icon: Camera,
				count: (device) => (device?.tools.cameraFixture.active ? 1 : 0),
			},
			{
				id: 'performance',
				label: 'Performance',
				icon: Activity,
				count: (device) => device?.tools.performance.samples.length,
			},
		],
	},
	{
		label: 'System',
		tools: [
			{
				id: 'diagnostics',
				label: 'Diagnostics',
				icon: TerminalSquare,
				count: (device) => device?.tools.diagnostics.length,
			},
		],
	},
];

const allTools = toolGroups.flatMap((group) => group.tools);

export function isToolId(value: string): value is ToolId {
	return allTools.some((tool) => tool.id === value);
}

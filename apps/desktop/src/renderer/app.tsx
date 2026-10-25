import { Button } from '@heroui/react/button';
import { Tooltip } from '@heroui/react/tooltip';
import { NativeSelect } from '@heroui-pro/react/native-select';
import {
	Cable,
	ChevronDown,
	Cpu,
	DatabaseZap,
	Moon,
	PanelLeftClose,
	PanelLeftOpen,
	Radio,
	Settings2,
	Smartphone,
	Sun,
	TerminalSquare,
} from 'lucide-react';
import {
	type ComponentType,
	type LazyExoticComponent,
	lazy,
	memo,
	Suspense,
	useEffect,
	useState,
} from 'react';
import { PanelErrorBoundary } from '@/components/error-boundary';
import { GetStartedCard, useGetStarted } from '@/components/get-started';
import { SetupFlow } from '@/components/setup-flow';
import { ActionNotice, StatusPill } from '@/components/status-ui';
import {
	type ActionNoticeRuntime,
	type ActionNoticeSource,
	actionNoticeRuntimes,
	createActionStatusOrder,
	createSuccessNoticeTimers,
	selectActionNotice,
} from '@/lib/action-notice';
import { requestNetworkFilter, useAppTraffic } from '@/lib/app-traffic';
import { setAppearancePreference, useAppearance } from '@/lib/appearance';
import { useOnboarding } from '@/lib/onboarding';
import { formatShortcutRange } from '@/lib/shell-navigation';
import { appTrafficBanner } from '@/simulator/app-traffic-model';
import {
	isSimulatorToolId,
	type SimulatorToolId,
	simulatorToolSections,
	simulatorTools,
} from '@/simulator/simulator-config';
import { useDesktopRuntime } from '@/state/desktop-runtime';
import { useLaneRuntime } from '@/state/lane-runtime';
import { useRecipeRuntime } from '@/state/recipe-runtime';
import { useSimulatorRuntime } from '@/state/simulator-runtime';
import { useSlimmingRuntime } from '@/state/slimming-runtime';
import {
	useSupabaseActions,
	useSupabaseActiveJobCount,
	useSupabaseNavigation,
	useSupabaseSidebarBadge,
} from '@/state/supabase-runtime';
import { isToolId, toolGroups } from '@/tool-config';
import type { DeviceSession, ToolId } from '../shared/protocol';
import type { SupabaseSidebarBadge } from '../shared/supabase-protocol';

type WorkspaceId = 'simulator' | 'connected';
type WorkspaceRoute = {
	workspace: WorkspaceId;
	connectedTool: ToolId;
	simulatorTool: SimulatorToolId;
};

const PLATFORM_LABELS: Record<DeviceSession['info']['platform'], string> = {
	ios: 'iOS',
	android: 'Android',
	web: 'Web',
	simulator: 'Simulator',
	unknown: 'Unknown platform',
};

function sidebarShortcut(platform: string | undefined): string {
	return platform === 'darwin' ? '⌘B' : 'Ctrl+B';
}

/** `booted` as `Booted`, for status words shown at the start of a line. */
function sentenceCase(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

function countLabel(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function workspaceShortcut(
	platform: string | undefined,
	workspace: WorkspaceId
): string {
	const key = workspace === 'simulator' ? 'S' : 'C';
	return platform === 'darwin' ? `⇧⌘${key}` : `Ctrl+Shift+${key}`;
}

const NetworkPanel = lazy(() =>
	import('@/panels/network-panel').then((module) => ({
		default: module.NetworkPanel,
	}))
);
const ConsolePanel = lazy(() =>
	import('@/panels/console-panel').then((module) => ({
		default: module.ConsolePanel,
	}))
);
const StoragePanel = lazy(() =>
	import('@/panels/storage-panel').then((module) => ({
		default: module.StoragePanel,
	}))
);
const QueryPanel = lazy(() =>
	import('@/panels/query-panel').then((module) => ({
		default: module.QueryPanel,
	}))
);
const RoutesPanel = lazy(() =>
	import('@/panels/routes-panel').then((module) => ({
		default: module.RoutesPanel,
	}))
);
const EnvironmentPanel = lazy(() =>
	import('@/panels/environment-panel').then((module) => ({
		default: module.EnvironmentPanel,
	}))
);
const ZustandPanel = lazy(() =>
	import('@/panels/zustand-panel').then((module) => ({
		default: module.ZustandPanel,
	}))
);
const RestorePanel = lazy(() =>
	import('@/panels/restore-panel').then((module) => ({
		default: module.RestorePanel,
	}))
);
const ScenariosPanel = lazy(() =>
	import('@/panels/scenarios-panel').then((module) => ({
		default: module.ScenariosPanel,
	}))
);
const IdentityPanel = lazy(() =>
	import('@/panels/identity-panel').then((module) => ({
		default: module.IdentityPanel,
	}))
);
const PerformancePanel = lazy(() =>
	import('@/panels/performance-panel').then((module) => ({
		default: module.PerformancePanel,
	}))
);
const ComponentsPanel = lazy(() =>
	import('@/panels/components-panel').then((module) => ({
		default: module.ComponentsPanel,
	}))
);
const CameraPanel = lazy(() =>
	import('@/panels/camera-panel').then((module) => ({
		default: module.CameraPanel,
	}))
);
const DiagnosticsPanel = lazy(() =>
	import('@/panels/diagnostics-panel').then((module) => ({
		default: module.DiagnosticsPanel,
	}))
);

const FleetPanel = lazy(() =>
	import('@/panels/simulator/fleet-panel').then((module) => ({
		default: module.FleetPanel,
	}))
);
const AppActionsPanel = lazy(() =>
	import('@/panels/simulator/app-actions-panel').then((module) => ({
		default: module.AppActionsPanel,
	}))
);
const SlimmingPanel = lazy(() =>
	import('@/panels/simulator/slimming-panel').then((module) => ({
		default: module.SlimmingPanel,
	}))
);
const CapturesPanel = lazy(() =>
	import('@/panels/simulator/captures-panel').then((module) => ({
		default: module.CapturesPanel,
	}))
);
const AutomationPanel = lazy(() =>
	import('@/panels/simulator/automation-panel').then((module) => ({
		default: module.AutomationPanel,
	}))
);
const BuildInsightsPanel = lazy(() =>
	import('@/panels/simulator/build-insights-panel').then((module) => ({
		default: module.BuildInsightsPanel,
	}))
);
const LanesPanel = lazy(() =>
	import('@/panels/simulator/lanes-panel').then((module) => ({
		default: module.LanesPanel,
	}))
);
const SupabasePanel = lazy(() =>
	import('@/panels/simulator/supabase-panel').then((module) => ({
		default: module.SupabasePanel,
	}))
);
const SimulatorSettingsPanel = lazy(() =>
	import('@/panels/simulator/settings-panel').then((module) => ({
		default: module.SettingsPanel,
	}))
);

const TOOL_PANELS: Record<ToolId, LazyExoticComponent<ComponentType>> = {
	network: NetworkPanel,
	console: ConsolePanel,
	storage: StoragePanel,
	query: QueryPanel,
	routes: RoutesPanel,
	environment: EnvironmentPanel,
	zustand: ZustandPanel,
	restore: RestorePanel,
	scenarios: ScenariosPanel,
	identity: IdentityPanel,
	performance: PerformancePanel,
	components: ComponentsPanel,
	camera: CameraPanel,
	diagnostics: DiagnosticsPanel,
};

const SIMULATOR_PANELS: Record<
	SimulatorToolId,
	LazyExoticComponent<ComponentType>
> = {
	fleet: FleetPanel,
	actions: AppActionsPanel,
	slimming: SlimmingPanel,
	captures: CapturesPanel,
	automation: AutomationPanel,
	builds: BuildInsightsPanel,
	lanes: LanesPanel,
	supabase: SupabasePanel,
	settings: SimulatorSettingsPanel,
};

const SIMULATOR_TOOL_LABELS = new Map(
	simulatorTools.map((tool) => [tool.id, tool.label])
);
const CONNECTED_TOOL_LABELS = new Map(
	toolGroups
		.flatMap((group) => group.tools)
		.map((tool) => [tool.id, tool.label])
);
const SIMULATOR_SHORTCUT_RANGE = formatShortcutRange(
	simulatorTools.map((tool) => tool.shortcut)
);
const SIMULATOR_TOOL_SECTIONS = simulatorToolSections();
/** Tools that work without Xcode, so the setup banner stays off them. */
const TOOLS_WITHOUT_SETUP_BANNER: ReadonlySet<SimulatorToolId> = new Set([
	'settings',
	'supabase',
]);

function routeFromHash(): WorkspaceRoute {
	const hash = window.location.hash.slice(1);
	const [workspace, panel] = hash.split('/');
	if (workspace === 'simulator' && panel && isSimulatorToolId(panel)) {
		return { workspace, simulatorTool: panel, connectedTool: 'network' };
	}
	if (workspace === 'connected' && panel && isToolId(panel)) {
		return { workspace, connectedTool: panel, simulatorTool: 'fleet' };
	}
	if (isToolId(hash)) {
		return {
			workspace: 'connected',
			connectedTool: hash,
			simulatorTool: 'fleet',
		};
	}
	return {
		workspace: 'simulator',
		simulatorTool: 'fleet',
		connectedTool: 'network',
	};
}

function replaceHash(
	workspace: WorkspaceId,
	panel: ToolId | SimulatorToolId
): void {
	window.history.replaceState(null, '', `#${workspace}/${panel}`);
}

function isEditableTarget(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement ||
		(target instanceof HTMLElement && target.isContentEditable)
	);
}

export function App() {
	const desktop = useDesktopRuntime();
	const recipe = useRecipeRuntime();
	const simulator = useSimulatorRuntime();
	const slimming = useSlimmingRuntime();
	const lanes = useLaneRuntime();
	const supabase = useSupabaseActions();
	const [route, setRoute] = useState<WorkspaceRoute>(routeFromHash);
	const [sidebarOpen, setSidebarOpen] = useState(true);
	const [statusOrder] = useState(createActionStatusOrder);
	const [successTimers] = useState(createSuccessNoticeTimers);
	// Every runtime that reports an actionStatus. Which of them the active tool
	// shows is decided by actionNoticeRuntimes.
	const noticeSources: Record<ActionNoticeRuntime, ActionNoticeSource> = {
		desktop: { status: desktop.actionStatus, clear: desktop.clearActionStatus },
		simulator: {
			status: simulator.actionStatus,
			clear: simulator.clearActionStatus,
		},
		recipe: { status: recipe.actionStatus, clear: recipe.clearActionStatus },
		slimming: {
			status: slimming.actionStatus,
			clear: slimming.clearActionStatus,
		},
		lanes: { status: lanes.actionStatus, clear: lanes.clearActionStatus },
		supabase: {
			status: supabase.actionStatus,
			clear: supabase.clearActionStatus,
		},
	};

	// Syncing on every render is cheap: a status keeps its timer until the
	// runtime replaces it.
	useEffect(() => {
		successTimers.sync(noticeSources);
	});
	useEffect(() => () => successTimers.dispose(), [successTimers]);

	useEffect(() => {
		const onHashChange = () => setRoute(routeFromHash());
		window.addEventListener('hashchange', onHashChange);
		return () => window.removeEventListener('hashchange', onHashChange);
	}, []);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				event.repeat ||
				event.altKey ||
				isEditableTarget(event.target)
			) {
				return;
			}
			const hasPlatformModifier =
				desktop.bootstrap?.platform === 'darwin'
					? event.metaKey
					: event.ctrlKey;
			if (!hasPlatformModifier) return;
			if (!event.shiftKey && event.key.toLowerCase() === 'b') {
				event.preventDefault();
				setSidebarOpen((open) => !open);
				return;
			}
			if (event.shiftKey && event.key.toLowerCase() === 's') {
				event.preventDefault();
				setRoute((current) => {
					const next = { ...current, workspace: 'simulator' as const };
					replaceHash('simulator', next.simulatorTool);
					return next;
				});
				return;
			}
			if (event.shiftKey && event.key.toLowerCase() === 'c') {
				event.preventDefault();
				setRoute((current) => {
					const next = { ...current, workspace: 'connected' as const };
					replaceHash('connected', next.connectedTool);
					return next;
				});
				return;
			}
			if (route.workspace !== 'simulator' || event.shiftKey) return;
			const shortcut = Number(event.key);
			const tool = simulatorTools.find(
				(candidate) => candidate.shortcut === shortcut
			);
			if (!tool) return;
			event.preventDefault();
			setRoute((current) => ({ ...current, simulatorTool: tool.id }));
			replaceHash('simulator', tool.id);
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [desktop.bootstrap?.platform, route.workspace]);

	const setWorkspace = (workspace: WorkspaceId) => {
		setRoute((current) => {
			const panel =
				workspace === 'simulator'
					? current.simulatorTool
					: current.connectedTool;
			replaceHash(workspace, panel);
			return { ...current, workspace };
		});
	};
	const setConnectedTool = (tool: ToolId) => {
		setRoute((current) => ({
			...current,
			workspace: 'connected',
			connectedTool: tool,
		}));
		replaceHash('connected', tool);
	};
	const setSimulatorTool = (tool: SimulatorToolId) => {
		setRoute((current) => ({
			...current,
			workspace: 'simulator',
			simulatorTool: tool,
		}));
		replaceHash('simulator', tool);
	};
	const notice = selectActionNotice(
		noticeSources,
		actionNoticeRuntimes(route.workspace, route.simulatorTool),
		statusOrder
	);

	return (
		<div className="desktop-provider" data-workspace={route.workspace}>
			<Titlebar
				connectedTool={route.connectedTool}
				sidebarOpen={sidebarOpen}
				workspace={route.workspace}
				setConnectedTool={setConnectedTool}
				setSidebarOpen={setSidebarOpen}
				setWorkspace={setWorkspace}
			/>
			<div className="desktop-body">
				{sidebarOpen ? (
					route.workspace === 'simulator' ? (
						<SimulatorSidebar
							activeTool={route.simulatorTool}
							setActiveTool={setSimulatorTool}
						/>
					) : (
						<DesktopSidebar
							activeTool={route.connectedTool}
							setActiveTool={setConnectedTool}
						/>
					)
				) : null}
				<main className="desktop-main">
					<div className="desktop-content">
						{route.workspace === 'simulator' ? (
							<SimulatorContent
								activeTool={route.simulatorTool}
								setActiveTool={setSimulatorTool}
							/>
						) : (
							<ConnectedContent activeTool={route.connectedTool} />
						)}
					</div>
				</main>
			</div>
			{notice ? (
				<ActionNotice
					kind={notice.status.kind}
					message={notice.status.message}
					onDismiss={notice.clear}
				/>
			) : null}
			<SetupFlow />
		</div>
	);
}

function Titlebar({
	workspace,
	connectedTool,
	sidebarOpen,
	setWorkspace,
	setConnectedTool,
	setSidebarOpen,
}: {
	workspace: WorkspaceId;
	connectedTool: ToolId;
	sidebarOpen: boolean;
	setWorkspace: (workspace: WorkspaceId) => void;
	setConnectedTool: (tool: ToolId) => void;
	setSidebarOpen: (open: boolean) => void;
}) {
	const desktop = useDesktopRuntime();
	const recipe = useRecipeRuntime();
	const simulator = useSimulatorRuntime();
	const slimming = useSlimmingRuntime();
	const supabaseJobs = useSupabaseActiveJobCount();
	const shortcut = sidebarShortcut(desktop.bootstrap?.platform);
	const latest = desktop.selectedDevice?.tools.performance.samples.at(-1);
	const connected =
		desktop.state?.devices.filter((device) => device.status === 'online')
			.length ?? 0;
	const booted = simulator.state.devices.filter(
		(device) => device.state === 'booted'
	).length;
	const activeJobStatuses = new Set([
		'queued',
		'preflight',
		'running',
		'verifying',
		'rolling-back',
	]);
	const activeJobs =
		simulator.state.jobs.filter((job) => activeJobStatuses.has(job.status))
			.length +
		slimming.state.jobs.filter((job) => activeJobStatuses.has(job.status))
			.length +
		recipe.state.runs.filter((run) =>
			[
				'queued',
				'needs-approval',
				'resolving',
				'running',
				'cancelling',
			].includes(run.status)
		).length +
		supabaseJobs;

	return (
		<header
			className={`titlebar ${desktop.bootstrap?.platform === 'darwin' ? 'is-macos' : ''}`}
		>
			<div className="titlebar-safe-area">
				<div className="titlebar-lead">
					<span className="titlebar-title">RN Devtools</span>
					<span aria-hidden="true" className="titlebar-rule" />
					<div className="titlebar-control no-drag">
						<Tooltip delay={500}>
							<Button
								aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
								className="titlebar-icon-button"
								isIconOnly
								variant="ghost"
								onPress={() => setSidebarOpen(!sidebarOpen)}
							>
								{sidebarOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
							</Button>
							<Tooltip.Content>
								{sidebarOpen ? 'Hide sidebar' : 'Show sidebar'} · {shortcut}
							</Tooltip.Content>
						</Tooltip>
					</div>
					<WorkspaceSwitcher
						platform={desktop.bootstrap?.platform}
						workspace={workspace}
						setWorkspace={setWorkspace}
					/>
				</div>
				<div className="titlebar-trail">
					{workspace === 'simulator' ? (
						<div className="titlebar-readouts">
							<span className="titlebar-readout">
								{booted > 0 ? (
									<span
										aria-hidden="true"
										className="connection-dot is-online"
									/>
								) : null}
								<strong>{booted}</strong> booted
							</span>
							<span className="titlebar-readout">
								<strong>{activeJobs}</strong>{' '}
								{activeJobs === 1 ? 'job' : 'jobs'}
							</span>
							{simulator.state.capability.xcodeVersion ? (
								<span className="titlebar-readout is-optional">
									Xcode{' '}
									<strong>{simulator.state.capability.xcodeVersion}</strong>
								</span>
							) : null}
						</div>
					) : (
						<div className="titlebar-readouts">
							<Tooltip delay={500}>
								<button
									aria-current={
										connectedTool === 'diagnostics' ? 'page' : undefined
									}
									aria-label={`${connected} live ${connected === 1 ? 'connection' : 'connections'} · open Diagnostics`}
									className="titlebar-readout is-button no-drag"
									type="button"
									onClick={() => {
										if (connectedTool !== 'diagnostics')
											setConnectedTool('diagnostics');
									}}
								>
									<span
										aria-hidden="true"
										className={`connection-dot ${desktop.state?.broker.status === 'listening' ? 'is-online' : ''}`}
									/>
									<strong>{connected}</strong> live
								</button>
								<Tooltip.Content>
									{connected} live{' '}
									{connected === 1 ? 'connection' : 'connections'} · open
									Diagnostics
								</Tooltip.Content>
							</Tooltip>
							{latest ? (
								<>
									<span className="titlebar-readout">
										<strong>{latest.jsFps.toFixed(0)}</strong> fps
									</span>
									<span className="titlebar-readout">
										<strong>{latest.eventLoopLagMs.toFixed(1)} ms</strong> lag
									</span>
									{latest.memoryMb === undefined ? null : (
										<span className="titlebar-readout is-optional">
											<strong>{latest.memoryMb.toFixed(0)} MB</strong> memory
										</span>
									)}
								</>
							) : null}
						</div>
					)}
					<div className="titlebar-controls no-drag">
						{workspace === 'simulator' ? (
							<NativeSelect
								className="device-select"
								fullWidth={false}
								variant="secondary"
							>
								<NativeSelect.Trigger
									aria-label="Selected Simulator"
									disabled={simulator.state.devices.length === 0}
									value={simulator.selectedDevice?.udid ?? ''}
									onChange={(event) =>
										simulator.setSelectedDeviceUdid(event.currentTarget.value)
									}
								>
									{simulator.state.devices.length === 0 ? (
										<NativeSelect.Option value="">
											No Simulator
										</NativeSelect.Option>
									) : null}
									{simulator.state.devices.map((device) => (
										<NativeSelect.Option key={device.udid} value={device.udid}>
											{device.name} · {device.state}
										</NativeSelect.Option>
									))}
									<NativeSelect.Indicator>
										<ChevronDown className="h-3 w-3" />
									</NativeSelect.Indicator>
								</NativeSelect.Trigger>
							</NativeSelect>
						) : (
							<NativeSelect
								className="device-select"
								fullWidth={false}
								variant="secondary"
							>
								<NativeSelect.Trigger
									aria-label="Selected development device"
									disabled={!desktop.state?.devices.length}
									value={desktop.selectedDevice?.info.id ?? ''}
									onChange={(event) =>
										desktop.setSelectedDeviceId(event.currentTarget.value)
									}
								>
									{!desktop.state?.devices.length ? (
										<NativeSelect.Option value="">
											No device
										</NativeSelect.Option>
									) : null}
									{desktop.state?.devices.map((device) => (
										<NativeSelect.Option
											key={device.info.id}
											value={device.info.id}
										>
											{device.info.name} · {device.status}
										</NativeSelect.Option>
									))}
									<NativeSelect.Indicator>
										<ChevronDown className="h-3 w-3" />
									</NativeSelect.Indicator>
								</NativeSelect.Trigger>
							</NativeSelect>
						)}
						<AppearanceToggle />
					</div>
				</div>
			</div>
		</header>
	);
}

function WorkspaceSwitcher({
	workspace,
	platform,
	setWorkspace,
}: {
	workspace: WorkspaceId;
	platform: string | undefined;
	setWorkspace: (workspace: WorkspaceId) => void;
}) {
	return (
		<fieldset
			className="workspace-switcher no-drag"
			aria-label="Desktop workspace"
		>
			<Button
				aria-pressed={workspace === 'simulator'}
				className={workspace === 'simulator' ? 'is-current' : ''}
				variant="ghost"
				onPress={() => setWorkspace('simulator')}
			>
				<Smartphone className="h-3 w-3" /> Simulator
				<kbd>{workspaceShortcut(platform, 'simulator')}</kbd>
			</Button>
			<Button
				aria-pressed={workspace === 'connected'}
				className={workspace === 'connected' ? 'is-current' : ''}
				variant="ghost"
				onPress={() => setWorkspace('connected')}
			>
				<Cable className="h-3 w-3" /> Connected App
				<kbd>{workspaceShortcut(platform, 'connected')}</kbd>
			</Button>
		</fieldset>
	);
}

/**
 * Flips between light and dark. It sets an explicit preference; System is
 * chosen in Settings.
 */
function AppearanceToggle() {
	const { theme, available } = useAppearance();
	const next = theme === 'dark' ? 'light' : 'dark';
	const label = `Switch to ${next} appearance`;
	return (
		<Tooltip delay={500}>
			<Button
				aria-label={label}
				className="titlebar-icon-button"
				isDisabled={!available}
				isIconOnly
				variant="ghost"
				onPress={() => void setAppearancePreference(next)}
			>
				{theme === 'dark' ? <Sun /> : <Moon />}
			</Button>
			<Tooltip.Content>{label}</Tooltip.Content>
		</Tooltip>
	);
}

function SimulatorSidebar({
	activeTool,
	setActiveTool,
}: {
	activeTool: SimulatorToolId;
	setActiveTool: (tool: SimulatorToolId) => void;
}) {
	const { state, selectedDevice } = useSimulatorRuntime();
	const { bootstrap } = useDesktopRuntime();
	const recipe = useRecipeRuntime();
	const supabase = useSupabaseSidebarBadge();
	const navigationModifier = bootstrap?.platform === 'darwin' ? '⌘' : 'Ctrl+';
	return (
		<aside
			className="desktop-sidebar simulator-sidebar"
			aria-label="Simulator workspace"
		>
			<header className="device-summary">
				<div
					className={`device-icon ${selectedDevice?.state === 'booted' ? 'is-live' : ''}`}
				>
					<Smartphone className="h-4 w-4" />
				</div>
				<div className="min-w-0 flex-1">
					<p className="device-name">
						{selectedDevice?.name ?? 'Simulator workspace'}
					</p>
					<p className="device-meta">
						{selectedDevice
							? `${sentenceCase(selectedDevice.state)} · ${countLabel(state.runtimes.length, 'runtime')}`
							: 'No mobile connection required'}
					</p>
				</div>
				<output
					aria-label={`Simulator capability ${state.capability.status}`}
					className={`device-status ${state.capability.status === 'available' ? 'is-online' : 'is-empty'}`}
				/>
			</header>
			<nav className="desktop-sidebar-content" aria-label="Simulator tools">
				{SIMULATOR_TOOL_SECTIONS.map((section) => (
					<section className="tool-group" key={section.id}>
						<h2 className="tool-group-label">{section.label}</h2>
						<div className="space-y-0.5">
							{section.tools.map((tool) => {
								const Icon = tool.icon;
								const badge = simulatorBadge(tool.id, {
									state,
									recipeCount: recipe.state.recipes.length,
									supabase,
								});
								return (
									<Button
										{...(activeTool === tool.id
											? { 'aria-current': 'page' as const }
											: {})}
										{...(badge?.label ? { 'aria-label': badge.label } : {})}
										className={`tool-nav-item ${activeTool === tool.id ? 'is-current' : ''}`}
										key={tool.id}
										variant="ghost"
										onPress={() => setActiveTool(tool.id)}
									>
										<Icon className="h-3.5 w-3.5" />
										<span className="flex-1 text-left">{tool.label}</span>
										{tool.tag ? (
											<span className="tool-tag">{tool.tag}</span>
										) : null}
										{badge?.dot ? (
											<span
												aria-hidden="true"
												className={`tool-dot is-${badge.tone}`}
											/>
										) : badge &&
											(badge.value > 0 || badge.tone !== 'default') ? (
											<span
												className={`tool-count ${badge.tone === 'default' ? '' : `is-${badge.tone}`}`}
											>
												{badge.value}
											</span>
										) : null}
										<kbd className="tool-shortcut">
											{navigationModifier}
											{tool.shortcut}
										</kbd>
									</Button>
								);
							})}
						</div>
					</section>
				))}
			</nav>
			<footer className="desktop-sidebar-footer">
				<GetStartedCard />
				<button
					aria-label={`Simulator capability ${state.capability.status}${state.capability.xcodeVersion ? ` · Xcode ${state.capability.xcodeVersion}` : ''} · open Settings`}
					className="broker-summary simulator-capability-summary"
					type="button"
					onClick={() => setActiveTool('settings')}
				>
					<Cpu className="h-3.5 w-3.5" />
					<div className="min-w-0 flex-1 text-left">
						<p>{CAPABILITY_STATUS_LABELS[state.capability.status]}</p>
						<code>
							{state.capability.xcodeVersion
								? `Xcode ${state.capability.xcodeVersion}`
								: 'Check setup'}
						</code>
					</div>
					<span
						className={`connection-dot ${state.capability.status === 'available' ? 'is-online' : ''}`}
					/>
				</button>
				<p className="shortcut-hint">
					{navigationModifier}
					{SIMULATOR_SHORTCUT_RANGE} switch tools ·{' '}
					{sidebarShortcut(bootstrap?.platform)} sidebar
				</p>
			</footer>
		</aside>
	);
}

type SimulatorBadge = Readonly<{
	value: number;
	tone: 'default' | 'warning' | 'danger';
	/** Replaces the nav item's accessible name when the count needs words. */
	label?: string;
	/** Shows a dot instead of the count. */
	dot?: boolean;
}>;

const CAPABILITY_STATUS_LABELS = {
	checking: 'Checking setup',
	available: 'Ready',
	unavailable: 'Needs setup',
} as const;

/**
 * The count beside a Simulator tool: plain counts for most tools (a zero is
 * not shown), an amber dot on Settings while required setup is incomplete,
 * and the Supabase runtime's memoised badge (red for danger, amber for
 * requests and warnings, a grey running count).
 */
function simulatorBadge(
	tool: SimulatorToolId,
	context: {
		state: ReturnType<typeof useSimulatorRuntime>['state'];
		recipeCount: number;
		supabase: SupabaseSidebarBadge | undefined;
	}
): SimulatorBadge | undefined {
	const { state } = context;
	switch (tool) {
		case 'fleet':
			return { value: state.devices.length, tone: 'default' };
		case 'captures':
			return { value: state.captures.length, tone: 'default' };
		case 'automation':
			return { value: context.recipeCount, tone: 'default' };
		case 'actions':
			return {
				value: state.devices.filter((device) => device.state === 'booted')
					.length,
				tone: 'default',
			};
		case 'supabase':
			return context.supabase;
		case 'settings':
			return state.capability.status === 'unavailable'
				? {
						value: 0,
						tone: 'warning',
						dot: true,
						label: 'Settings · setup needs attention',
					}
				: undefined;
		default:
			return undefined;
	}
}

function DesktopSidebar({
	activeTool,
	setActiveTool,
}: {
	activeTool: ToolId;
	setActiveTool: (tool: ToolId) => void;
}) {
	const { bootstrap, selectedDevice, state } = useDesktopRuntime();
	return (
		<aside
			className="desktop-sidebar"
			aria-label="Connected app developer tools"
		>
			<header className="device-summary">
				<div
					className={`device-icon ${selectedDevice && selectedDevice.status !== 'offline' ? 'is-live' : ''}`}
				>
					<Cable className="h-4 w-4" />
				</div>
				<div className="min-w-0 flex-1">
					<p className="device-name">
						{selectedDevice?.info.name ?? 'No device'}
					</p>
					<p className="device-meta">
						{selectedDevice
							? `${selectedDevice.info.appVersion ?? 'dev'} · ${PLATFORM_LABELS[selectedDevice.info.platform]}`
							: 'Waiting for connection'}
					</p>
				</div>
				<output
					aria-label={
						selectedDevice ? `Device ${selectedDevice.status}` : 'No device'
					}
					className={`device-status is-${selectedDevice?.status ?? 'empty'}`}
				/>
			</header>
			<nav
				className="desktop-sidebar-content"
				aria-label="Connected app tool panels"
			>
				{toolGroups.map((group) => (
					<section className="tool-group" key={group.label}>
						<h2 className="tool-group-label">{group.label}</h2>
						<div className="space-y-0.5">
							{group.tools.map((tool) => {
								const Icon = tool.icon;
								const count = tool.count(selectedDevice);
								return (
									<Button
										{...(activeTool === tool.id
											? { 'aria-current': 'page' as const }
											: {})}
										className={`tool-nav-item ${activeTool === tool.id ? 'is-current' : ''}`}
										key={tool.id}
										variant="ghost"
										onPress={() => setActiveTool(tool.id)}
									>
										<Icon className="h-3.5 w-3.5" />
										<span className="flex-1 text-left">{tool.label}</span>
										{count ? <span className="tool-count">{count}</span> : null}
									</Button>
								);
							})}
						</div>
					</section>
				))}
			</nav>
			<footer className="desktop-sidebar-footer">
				<button
					aria-label={`Broker ${state?.broker.status ?? 'starting'} on ${state ? `${state.broker.host}:${state.broker.port}` : '127.0.0.1'} · open Diagnostics`}
					className="broker-summary"
					type="button"
					onClick={() => setActiveTool('diagnostics')}
				>
					<Radio className="h-3.5 w-3.5" />
					<div className="min-w-0 flex-1 text-left">
						<p>{sentenceCase(state?.broker.status ?? 'starting broker')}</p>
						<code>
							{state
								? `${state.broker.host}:${state.broker.port}`
								: '127.0.0.1'}
						</code>
					</div>
					<span
						className={`connection-dot ${state?.broker.status === 'listening' ? 'is-online' : ''}`}
					/>
				</button>
				<p className="shortcut-hint">
					{sidebarShortcut(bootstrap?.platform)} shows or hides the sidebar
				</p>
			</footer>
		</aside>
	);
}

function SimulatorContent({
	activeTool,
	setActiveTool,
}: {
	activeTool: SimulatorToolId;
	setActiveTool: (tool: SimulatorToolId) => void;
}) {
	const { state } = useSimulatorRuntime();
	const { checklistHidden } = useOnboarding();
	const { progress } = useGetStarted();
	// While Get started shows in the sidebar it already says what is left.
	const checklistShown = !checklistHidden && !progress.complete;
	return (
		<>
			{state.capability.status !== 'available' &&
			!checklistShown &&
			!TOOLS_WITHOUT_SETUP_BANNER.has(activeTool) ? (
				<button
					aria-label="Simulator setup needs attention · open Settings"
					className="simulator-onboarding-banner"
					type="button"
					onClick={() => setActiveTool('settings')}
				>
					<span className="connection-dot" />
					<strong>Simulator setup needs attention</strong>
					<span>
						{state.capability.error ??
							'Review Xcode and native capability status.'}
					</span>
					<Settings2 className="h-3.5 w-3.5" />
				</button>
			) : null}
			<div className="min-h-0 flex-1">
				<SimulatorToolPanel tool={activeTool} />
			</div>
		</>
	);
}

// Native fleet polling must not rerender the connected app inspector.
const ConnectedContent = memo(function ConnectedContent({
	activeTool,
}: {
	activeTool: ToolId;
}) {
	const { runtimeError, selectedDevice, state } = useDesktopRuntime();
	return (
		<>
			{runtimeError ? <RuntimeBanner message={runtimeError} /> : null}
			{!state ? (
				<DesktopLoading />
			) : selectedDevice ? (
				<>
					{selectedDevice.status === 'offline' ? (
						<output className="offline-banner">
							Showing the last snapshot from an offline device. Remote actions
							are disabled until it reconnects.
						</output>
					) : null}
					<AppTrafficBanner />
					<div className="min-h-0 flex-1">
						<ConnectedToolPanel tool={activeTool} />
					</div>
				</>
			) : (
				<WaitingForDevice />
			)}
		</>
	);
});

/**
 * The connected app talks to another backend than its lane's stack. Only a
 * real mismatch shows; no traffic, an unlinked app or a lane without a
 * backend never does. It reads the lane and Supabase runtimes itself, so
 * their pushes re-render this banner and not the memoised inspector.
 */
function AppTrafficBanner() {
	const traffic = useAppTraffic();
	const { selectedDevice } = useDesktopRuntime();
	const { openInSupabase } = useSupabaseNavigation();
	const banner = selectedDevice
		? appTrafficBanner(traffic, selectedDevice.info.name)
		: undefined;
	if (!banner || !selectedDevice) return null;
	const deviceId = selectedDevice.info.id;
	const { filter, stackId } = banner;
	return (
		<section
			aria-label="App traffic"
			className={`offline-banner app-traffic-banner is-${banner.tone}`}
		>
			<DatabaseZap aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
			<strong className="app-traffic-banner-text">{banner.text}</strong>
			<span className="app-traffic-banner-actions">
				<Button
					size="sm"
					variant="ghost"
					onPress={() =>
						openInSupabase(stackId === undefined ? {} : { stackId })
					}
				>
					Open in Supabase
				</Button>
				{filter ? (
					<Button
						size="sm"
						variant="ghost"
						onPress={() => {
							requestNetworkFilter({ deviceId, target: filter });
							window.location.hash = 'connected/network';
						}}
					>
						Show this traffic
					</Button>
				) : null}
			</span>
			{/* The verdict is announced when it changes; the running counts are not. */}
			{banner.tone === 'danger' ? (
				<span className="sr-only" role="alert">
					{banner.announcement}
				</span>
			) : (
				<output className="sr-only">{banner.announcement}</output>
			)}
		</section>
	);
}

function ConnectedToolPanel({ tool }: { tool: ToolId }) {
	const Panel = TOOL_PANELS[tool];
	return (
		<PanelErrorBoundary
			key={tool}
			label={CONNECTED_TOOL_LABELS.get(tool) ?? tool}
			panel={`connected/${tool}`}
		>
			<Suspense fallback={<PanelLoading />}>
				<Panel />
			</Suspense>
		</PanelErrorBoundary>
	);
}

function SimulatorToolPanel({ tool }: { tool: SimulatorToolId }) {
	const Panel = SIMULATOR_PANELS[tool];
	return (
		<PanelErrorBoundary
			key={tool}
			label={SIMULATOR_TOOL_LABELS.get(tool) ?? tool}
			panel={`simulator/${tool}`}
		>
			<Suspense fallback={<PanelLoading />}>
				<Panel />
			</Suspense>
		</PanelErrorBoundary>
	);
}

function PanelLoading() {
	return (
		<output className="panel-loading" aria-label="Loading tool panel">
			<span />
			<span />
			<span />
		</output>
	);
}

function DesktopLoading() {
	return (
		<output className="waiting-state">
			<div className="waiting-icon">
				<TerminalSquare className="h-5 w-5" />
			</div>
			<h1>Starting RN Devtools</h1>
			<p>
				Initializing the secure renderer bridge and local diagnostics broker.
			</p>
		</output>
	);
}

function RuntimeBanner({ message }: { message: string }) {
	return (
		<div className="runtime-banner" role="alert">
			<strong>Desktop runtime issue</strong>
			<span>{message}</span>
		</div>
	);
}

function WaitingForDevice() {
	const { state } = useDesktopRuntime();
	const brokerError =
		state?.broker.status === 'error' ? state.broker.error : undefined;
	return (
		<div className="waiting-state">
			<div className="waiting-icon">
				<TerminalSquare className="h-5 w-5" />
			</div>
			<StatusPill tone={brokerError ? 'danger' : 'warning'} dot>
				{brokerError ? 'Broker error' : 'Listening'}
			</StatusPill>
			<h1>
				{brokerError
					? 'The device broker could not start'
					: 'Waiting for a development device'}
			</h1>
			<p>
				{brokerError ??
					'Open your app in development mode. The local client will discover this desktop broker and publish only registered diagnostic projections.'}
			</p>
		</div>
	);
}

import { Button } from '@heroui/react/button';
import { Input } from '@heroui/react/input';
import { Switch } from '@heroui/react/switch';
import { NativeSelect } from '@heroui-pro/react/native-select';
import {
	ChevronDown,
	Copy,
	Cpu,
	DatabaseZap,
	HardDrive,
	LayoutGrid,
	List,
	MemoryStick,
	Pencil,
	Play,
	Plus,
	Power,
	Rocket,
	RotateCcw,
	ScrollText,
	Smartphone,
	Square,
	SquareCheckBig,
	Trash2,
	Waypoints,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ControllableScreen } from '@/components/controllable-screen';
import { DeviceScreen } from '@/components/device-screen';
import { GetStartedChecklist, useGetStarted } from '@/components/get-started';
import { AgentBadge, AgentGlyph } from '@/components/lane-ui';
import {
	BridgeUnavailableNotice,
	DenseVirtualList,
	formatBytes,
	NoSimulatorTarget,
	RefreshSimulatorsButton,
	SimulatorDiscoveryPending,
	SimulatorMetric,
	TargetStatePill,
} from '@/components/simulator-ui';
import {
	ConfirmAction,
	Disclosure,
	InfoPopover,
	KeyValue,
	PanelHeader,
	PanelNotice,
	SearchControl,
	StatusPill,
	Toolbar,
} from '@/components/ui';
import { useOnboarding } from '@/lib/onboarding';
import {
	defaultDiskCleanupCategoryIds,
	diskInventorySelectionRevision,
	sanitizeDiskCleanupCategoryIds,
} from '@/simulator/disk-inventory-model';
import {
	buildFleetRows,
	connectedSessionsForSimulator,
	type FleetRow,
	type FleetStateFilter,
	fleetFilterCounts,
	fleetRowMatches,
	primaryAgent,
	shortPath,
} from '@/simulator/fleet-model';
import { supabaseChipsVisible } from '@/simulator/supabase-cross-panel';
import { targetConfig } from '@/simulator/target-config';
import { useAgentRuntime } from '@/state/agent-runtime';
import { useDesktopRuntime } from '@/state/desktop-runtime';
import { useLaneRuntime } from '@/state/lane-runtime';
import {
	type SimulatorActionInput,
	useSimulatorRuntime,
} from '@/state/simulator-runtime';
import { useSlimmingRuntime } from '@/state/slimming-runtime';
import {
	useSupabaseNavigation,
	useSupabaseState,
} from '@/state/supabase-runtime';
import {
	type Lane,
	type LaneView,
	laneHealth,
} from '../../../shared/lane-protocol';
import type { DeviceSession } from '../../../shared/protocol';
import type {
	SimulatorApp,
	SimulatorDevice,
	SimulatorDeviceMetrics,
	SimulatorDeviceType,
	SimulatorDiskCleanupCategoryId,
	SimulatorDiskInventory,
	SimulatorRuntime,
} from '../../../shared/simulator-protocol';

export function parseSimulatorCreateCount(value: string): number | null {
	const trimmed = value.trim();
	if (!/^(?:[1-9]|1\d|20)$/.test(trimmed)) return null;
	return Number(trimmed);
}

export function simulatorEraseAvailability(
	target: Pick<SimulatorDevice, 'isAvailable' | 'state'>,
	isBridgeAvailable: boolean
): { allowed: boolean; reason: string } {
	if (!isBridgeAvailable) {
		return {
			allowed: false,
			reason: 'Desktop Simulator controls are unavailable.',
		};
	}
	if (!target.isAvailable) {
		return {
			allowed: false,
			reason: 'This Simulator is unavailable in Xcode.',
		};
	}
	if (target.state !== 'shutdown') {
		return {
			allowed: false,
			reason:
				'Shut down this Simulator first; erase is only valid while shut down.',
		};
	}
	return {
		allowed: true,
		reason: 'Permanently removes installed apps, accounts, and local data.',
	};
}

export function simulatorOpenPresentation(
	target: Pick<SimulatorDevice, 'isAvailable' | 'state'>,
	isBridgeAvailable: boolean
): { allowed: boolean; label: 'Boot & open' | 'Open Simulator' } {
	return {
		allowed:
			isBridgeAvailable &&
			target.isAvailable &&
			(target.state === 'shutdown' || target.state === 'booted'),
		label: target.state === 'booted' ? 'Open Simulator' : 'Boot & open',
	};
}

type FleetLayout = 'wall' | 'list';
const FLEET_LAYOUT_KEY = 'rndevtools.desktop.fleet.layout';
const LIVE_SCREEN_OPEN_KEY = 'rndevtools.desktop.fleet.live-screen-open';
const FLEET_TILE_KEY = 'rndevtools.desktop.fleet.tile';
export const FLEET_TILE_RANGE = { min: 140, max: 320, step: 20, default: 200 };

function readStoredLayout(): FleetLayout {
	try {
		return window.localStorage.getItem(FLEET_LAYOUT_KEY) === 'list'
			? 'list'
			: 'wall';
	} catch {
		return 'wall';
	}
}

export function clampFleetTile(value: number): number {
	if (!Number.isFinite(value)) return FLEET_TILE_RANGE.default;
	const stepped =
		Math.round((value - FLEET_TILE_RANGE.min) / FLEET_TILE_RANGE.step) *
			FLEET_TILE_RANGE.step +
		FLEET_TILE_RANGE.min;
	return Math.min(
		FLEET_TILE_RANGE.max,
		Math.max(FLEET_TILE_RANGE.min, stepped)
	);
}

/** The detail pane's live screen stays as the person last left it. */
function readStoredLiveScreenOpen(): boolean {
	try {
		return window.localStorage.getItem(LIVE_SCREEN_OPEN_KEY) === 'true';
	} catch {
		return false;
	}
}

function readStoredTile(): number {
	try {
		return clampFleetTile(Number(window.localStorage.getItem(FLEET_TILE_KEY)));
	} catch {
		return FLEET_TILE_RANGE.default;
	}
}

export function FleetPanel() {
	const desktop = useDesktopRuntime();
	const {
		isBridgeAvailable,
		isLoading,
		runAction,
		cancelJob,
		selectedDevice,
		setSelectedDeviceUdid,
		state,
	} = useSimulatorRuntime();
	const slimming = useSlimmingRuntime();
	const lanes = useLaneRuntime();
	const agents = useAgentRuntime();
	const { state: supabase } = useSupabaseState();
	const { openInSupabase } = useSupabaseNavigation();
	const backendsShown = supabaseChipsVisible(supabase);
	const [query, setQuery] = useState('');
	const [filter, setFilter] = useState<FleetStateFilter>('all');
	const [layout, setLayout] = useState<FleetLayout>(readStoredLayout);
	const [tile, setTile] = useState<number>(readStoredTile);
	const [batchUdids, setBatchUdids] = useState<string[]>([]);
	const [showCreate, setShowCreate] = useState(false);
	const [batchMode, setBatchMode] = useState(false);
	const [createdJobId, setCreatedJobId] = useState<string | null>(null);
	const recentJobs = state.jobs
		.filter((job) => job.kind.startsWith('device.'))
		.toReversed();
	const activeJobs = recentJobs.filter((job) => !job.finishedAt);
	useEffect(() => {
		const job = state.jobs.find((item) => item.id === createdJobId);
		if (job?.deviceUdid) {
			setSelectedDeviceUdid(job.deviceUdid);
			setCreatedJobId(null);
		}
	}, [createdJobId, state.jobs, setSelectedDeviceUdid]);
	const runtimeById = useMemo(
		() =>
			new Map(state.runtimes.map((runtime) => [runtime.identifier, runtime])),
		[state.runtimes]
	);
	const rows = useMemo(
		() =>
			buildFleetRows({
				devices: state.devices,
				runtimes: state.runtimes,
				metricsByDevice: state.metrics.byDevice,
				slimmingByDevice: slimming.state.statusBySimulator,
				lanes: lanes.state.lanes,
				sessions: desktop.state?.devices ?? [],
				agentsByDevice: agents.state.byDevice,
				supabase,
			}),
		[
			state.devices,
			state.runtimes,
			state.metrics.byDevice,
			slimming.state.statusBySimulator,
			lanes.state.lanes,
			agents.state.byDevice,
			desktop.state?.devices,
			supabase,
		]
	);
	const filterCounts = useMemo(() => fleetFilterCounts(rows), [rows]);
	const rowByUdid = useMemo(
		() => new Map(rows.map((row) => [row.device.udid, row])),
		[rows]
	);
	const deviceTypeById = useMemo(
		() =>
			new Map(
				state.deviceTypes.map((deviceType) => [
					deviceType.identifier,
					deviceType,
				])
			),
		[state.deviceTypes]
	);
	const targets = useMemo(
		() =>
			rows
				.filter((row) => fleetRowMatches(row, filter, query))
				.map((row) => row.device),
		[filter, query, rows]
	);
	const booted = state.devices.filter(
		(target) => target.state === 'booted'
	).length;
	const available = state.devices.filter((target) => target.isAvailable).length;
	const deviceMetrics = Object.values(state.metrics.byDevice);
	const totalSimulatorMemory = deviceMetrics.reduce(
		(total, metrics) => total + metrics.memoryBytes,
		0
	);
	const totalSimulatorProcesses = deviceMetrics.reduce(
		(total, metrics) => total + metrics.processCount,
		0
	);
	const associatedSessions = useMemo(
		() =>
			selectedDevice
				? connectedSessionsForSimulator(
						selectedDevice.udid,
						desktop.state?.devices ?? []
					)
				: [],
		[desktop.state?.devices, selectedDevice]
	);

	useEffect(() => {
		try {
			window.localStorage.setItem(FLEET_LAYOUT_KEY, layout);
			window.localStorage.setItem(FLEET_TILE_KEY, String(tile));
		} catch {
			// Preferences are best-effort.
		}
	}, [layout, tile]);
	useEffect(() => {
		const known = new Set(state.devices.map((device) => device.udid));
		setBatchUdids((current) => {
			const retained = current.filter((udid) => known.has(udid));
			return retained.length === current.length ? current : retained;
		});
	}, [state.devices]);

	const bootableUdids = batchUdids.filter((udid) =>
		state.devices.some(
			(device) =>
				device.udid === udid &&
				device.isAvailable &&
				device.state === 'shutdown'
		)
	);
	const stoppableUdids = batchUdids.filter((udid) =>
		state.devices.some(
			(device) => device.udid === udid && device.state === 'booted'
		)
	);
	const runBatchLifecycle = (kind: 'device.boot' | 'device.shutdown') => {
		for (const udid of kind === 'device.boot'
			? bootableUdids
			: stoppableUdids) {
			void runAction(
				{ kind, udid },
				{
					successMessage:
						kind === 'device.boot'
							? 'Simulator boot queued.'
							: 'Simulator shutdown queued.',
				}
			);
		}
	};

	return (
		<section className="panel-root">
			<PanelHeader
				actions={
					<>
						<RefreshSimulatorsButton compact />
						<Button
							isDisabled={!isBridgeAvailable}
							size="sm"
							variant="primary"
							aria-expanded={showCreate}
							onPress={() => setShowCreate((shown) => !shown)}
						>
							<Plus className="h-4 w-4" />
							{showCreate ? 'Close creation' : 'New simulator'}
						</Button>
					</>
				}
				description="Create a simulator, open it, and run your app. Select a row to inspect it, or use Select multiple for batch actions."
				meta={`${state.devices.length} discovered`}
				title="Simulators"
			/>
			<BridgeUnavailableNotice />
			{state.metrics.error ? (
				<PanelNotice title="Resource metrics unavailable." tone="warning">
					{state.metrics.error}
				</PanelNotice>
			) : null}
			<div className="sim-metric-grid">
				<SimulatorMetric
					detail="active now"
					icon={<Play className="h-3.5 w-3.5" />}
					label="Booted"
					tone={booted > 0 ? 'success' : 'default'}
					value={String(booted)}
				/>
				<SimulatorMetric
					detail={
						state.metrics.status === 'available'
							? 'sampled Simulators'
							: state.metrics.status
					}
					icon={<MemoryStick className="h-3.5 w-3.5" />}
					label="Simulator RAM"
					value={
						state.metrics.status === 'available'
							? formatBytes(totalSimulatorMemory)
							: '—'
					}
				/>
				<SimulatorMetric
					detail={
						lanes.state.lanes.length > 0
							? `${filterCounts['with-lane']} with a lane · ${filterCounts['with-agent']} driven by agents`
							: `${available} usable targets`
					}
					icon={<Cpu className="h-3.5 w-3.5" />}
					label="Processes"
					value={
						state.metrics.status === 'available'
							? String(totalSimulatorProcesses)
							: '—'
					}
				/>
				<SimulatorMetric
					detail={
						state.metrics.host
							? `${state.metrics.host.memoryPressure} pressure`
							: 'host sample'
					}
					icon={<HardDrive className="h-3.5 w-3.5" />}
					label="Host free"
					tone={
						state.metrics.host?.memoryPressure === 'critical'
							? 'warning'
							: isBridgeAvailable
								? 'success'
								: 'warning'
					}
					value={
						state.metrics.host
							? `${Math.round(state.metrics.host.freePercent)}%`
							: '—'
					}
				/>
			</div>
			<Toolbar>
				<SearchControl
					ariaLabel="Search Simulator targets, branches, and agents"
					placeholder="Search name, branch, :port, agent"
					value={query}
					onChange={setQuery}
				/>
				<NativeSelect className="sim-filter-select" fullWidth={false}>
					<NativeSelect.Trigger
						aria-label="Filter targets"
						value={filter}
						onChange={(event) =>
							setFilter(event.currentTarget.value as FleetStateFilter)
						}
					>
						<NativeSelect.Option value="all">
							All targets ({filterCounts.all})
						</NativeSelect.Option>
						<NativeSelect.Option value="booted">
							Booted ({filterCounts.booted})
						</NativeSelect.Option>
						<NativeSelect.Option value="shutdown">
							Shut down ({filterCounts.shutdown})
						</NativeSelect.Option>
						<NativeSelect.Option value="with-lane">
							With lane ({filterCounts['with-lane']})
						</NativeSelect.Option>
						<NativeSelect.Option value="with-agent">
							With agent ({filterCounts['with-agent']})
						</NativeSelect.Option>
						{backendsShown || filter === 'with-backend' ? (
							<NativeSelect.Option value="with-backend">
								With backend ({filterCounts['with-backend']})
							</NativeSelect.Option>
						) : null}
						<NativeSelect.Indicator>
							<ChevronDown className="h-3 w-3" />
						</NativeSelect.Indicator>
					</NativeSelect.Trigger>
				</NativeSelect>
				<span className="sim-toolbar-separator" />
				<fieldset className="sim-layout-toggle">
					<legend className="sr-only">Fleet layout</legend>
					<Button
						aria-label="Show as wall of live screens"
						aria-pressed={layout === 'wall'}
						className="sim-icon-button"
						isIconOnly
						size="sm"
						variant={layout === 'wall' ? 'secondary' : 'ghost'}
						onPress={() => setLayout('wall')}
					>
						<LayoutGrid className="h-3.5 w-3.5" />
					</Button>
					<Button
						aria-label="Show as list"
						aria-pressed={layout === 'list'}
						className="sim-icon-button"
						isIconOnly
						size="sm"
						variant={layout === 'list' ? 'secondary' : 'ghost'}
						onPress={() => setLayout('list')}
					>
						<List className="h-3.5 w-3.5" />
					</Button>
				</fieldset>
				{layout === 'wall' ? (
					<label className="sim-tile-size">
						<span>Tile</span>
						<input
							aria-label="Tile size"
							max={FLEET_TILE_RANGE.max}
							min={FLEET_TILE_RANGE.min}
							step={FLEET_TILE_RANGE.step}
							type="range"
							value={tile}
							onChange={(event) =>
								setTile(clampFleetTile(Number(event.currentTarget.value)))
							}
						/>
					</label>
				) : null}
				{batchMode ? (
					<>
						<span className="sim-toolbar-separator" />
						<Button
							isDisabled={!isBridgeAvailable || bootableUdids.length === 0}
							size="sm"
							variant="secondary"
							onPress={() => runBatchLifecycle('device.boot')}
						>
							<Play className="h-3.5 w-3.5" /> Start{' '}
							{bootableUdids.length || ''}
						</Button>
						<Button
							isDisabled={!isBridgeAvailable || stoppableUdids.length === 0}
							size="sm"
							variant="ghost"
							onPress={() => runBatchLifecycle('device.shutdown')}
						>
							<Power className="h-3.5 w-3.5" /> Shut down{' '}
							{stoppableUdids.length || ''}
						</Button>
					</>
				) : null}
				<Button
					size="sm"
					variant={batchMode ? 'secondary' : 'ghost'}
					aria-pressed={batchMode}
					onPress={() => {
						setBatchMode(!batchMode);
						setBatchUdids([]);
					}}
				>
					{batchMode ? 'Done selecting' : 'Select multiple'}
				</Button>
				<span className="sim-toolbar-meta sim-fleet-toolbar-meta">
					{targets.length} matching · {batchUdids.length} selected
				</span>
			</Toolbar>
			{showCreate ? (
				<CreateFleetControls
					deviceTypes={state.deviceTypes}
					preferredDeviceTypeId={selectedDevice?.deviceTypeIdentifier}
					isBridgeAvailable={isBridgeAvailable}
					runtimes={state.runtimes}
					onCreate={async (action) => {
						const receipt = await runAction(action, {
							successMessage: 'Simulator creation queued.',
						});
						if (receipt.accepted && receipt.jobId) {
							setCreatedJobId(receipt.jobId);
							setShowCreate(false);
						}
					}}
				/>
			) : null}
			{state.devices.length === 0 ? (
				<div className="min-h-0 flex-1">
					{isLoading ||
					(isBridgeAvailable && state.capability.status === 'checking') ? (
						<SimulatorDiscoveryPending />
					) : (
						<FleetEmptyState />
					)}
				</div>
			) : (
				<div className="sim-fleet-layout">
					<div className="sim-list-pane">
						{layout === 'wall' && !batchMode ? (
							<DeviceWall
								rows={targets
									.map((target) => rowByUdid.get(target.udid))
									.filter((row): row is FleetRow => Boolean(row))}
								selectedUdid={selectedDevice?.udid}
								tile={tile}
								onSelect={setSelectedDeviceUdid}
							/>
						) : (
							<DenseVirtualList
								ariaLabel="Simulator fleet"
								emptyDescription="Try a different name, state, runtime, or device identifier."
								emptyTitle="No targets match these filters"
								items={targets}
								getId={(target) => target.udid}
								dependencies={[rowByUdid, runtimeById]}
								rowHeight={64}
								selectedId={selectedDevice?.udid}
								selectedIds={batchMode ? batchUdids : undefined}
								onSelectedIdsChange={
									batchMode
										? (ids) => setBatchUdids(ids.slice(0, 20))
										: undefined
								}
								textValue={(target) =>
									`${target.name} ${runtimeById.get(target.runtimeIdentifier)?.name ?? ''}`
								}
								onSelect={(target) => setSelectedDeviceUdid(target.udid)}
								renderItem={(target) => {
									const row = rowByUdid.get(target.udid);
									return (
										<>
											{!batchMode ? (
												<div className="sim-list-leading">
													{row && primaryAgent(row) ? (
														<AgentGlyph
															kind={primaryAgent(row)?.kind ?? 'other'}
														/>
													) : (
														<Smartphone className="h-4 w-4" />
													)}
												</div>
											) : null}
											<FleetRowText row={row} target={target} />
											<TargetStatePill state={target.state} />
										</>
									);
								}}
							/>
						)}
					</div>
					<div className="sim-detail-pane panel-scroll">
						{selectedDevice ? (
							<TargetDetail
								connectedSessions={associatedSessions}
								key={selectedDevice.udid}
								isBridgeAvailable={isBridgeAvailable}
								lane={rowByUdid.get(selectedDevice.udid)?.lane}
								backend={rowByUdid.get(selectedDevice.udid)?.backend}
								onOpenInSupabase={(stackId) =>
									openInSupabase(stackId === undefined ? {} : { stackId })
								}
								attachedAgents={
									rowByUdid.get(selectedDevice.udid)?.agents ?? []
								}
								laneBusy={lanes.pendingOperation !== null}
								onLaneLaunch={(lane) =>
									void lanes.runOperation(
										{ kind: 'lane.launch', laneId: lane.id },
										{
											pendingMessage: `Waiting for Metro on :${lane.port}…`,
											successMessage: `${lane.branch} launched.`,
										}
									)
								}
								onLaneStop={(lane) =>
									void lanes.runOperation(
										{ kind: 'lane.stop', laneId: lane.id },
										{ successMessage: `Lane ${lane.branch} stopped.` }
									)
								}
								onOpenLanes={(laneId) => {
									if (laneId === undefined) {
										window.location.hash = 'simulator/lanes';
									} else {
										lanes.focusLane(laneId);
									}
								}}
								slim={rowByUdid.get(selectedDevice.udid)?.slim}
								target={selectedDevice}
								runtime={runtimeById.get(selectedDevice.runtimeIdentifier)}
								deviceTypeName={
									selectedDevice.deviceTypeIdentifier
										? deviceTypeById.get(selectedDevice.deviceTypeIdentifier)
												?.name
										: undefined
								}
								apps={state.appsByDevice[selectedDevice.udid] ?? []}
								disk={state.diskByDevice[selectedDevice.udid]}
								metrics={state.metrics.byDevice[selectedDevice.udid]}
								onRunAction={(action, successMessage) =>
									void runAction(action, { successMessage })
								}
								onOpenConnectedSession={(deviceId) => {
									desktop.setSelectedDeviceId(deviceId);
									window.location.hash = 'connected/network';
								}}
							/>
						) : null}
					</div>
				</div>
			)}
			{recentJobs.length > 0 ? (
				<div className="sim-fleet-activity">
					<Disclosure
						title={
							activeJobs.length
								? `Simulator activity · ${activeJobs.length} running`
								: 'Recent simulator activity'
						}
					>
						<div className="sim-activity-list panel-scroll">
							{recentJobs.slice(0, 20).map((job) => (
								<div className="sim-activity-row" key={job.id}>
									<div>
										<strong>
											{state.devices.find(
												(device) => device.udid === job.deviceUdid
											)?.name ?? 'New simulator'}
										</strong>
										<span>{job.message}</span>
									</div>
									<StatusPill
										tone={
											job.status === 'failed' ||
											job.status === 'needs-attention'
												? 'danger'
												: job.finishedAt
													? 'default'
													: 'info'
										}
									>
										{job.status}
									</StatusPill>
									{!job.finishedAt ? (
										<Button
											size="sm"
											variant="ghost"
											onPress={() => void cancelJob(job.id)}
										>
											Cancel
										</Button>
									) : null}
								</div>
							))}
						</div>
					</Disclosure>
				</div>
			) : null}
		</section>
	);
}

/**
 * Nothing to list yet: Get started while it has tasks left, otherwise how to
 * add a target. Only this branch reads the checklist's runtimes.
 */
function FleetEmptyState() {
	const { checklistHidden } = useOnboarding();
	const { progress } = useGetStarted();
	if (!checklistHidden && !progress.complete) {
		return (
			<div className="get-started-inline panel-scroll">
				<GetStartedChecklist inline />
			</div>
		);
	}
	return (
		<NoSimulatorTarget
			onOpenSettings={() => {
				window.location.hash = 'simulator/settings';
			}}
		/>
	);
}

/**
 * The wall: every Simulator as a live tile, busiest first. Tiles stream only
 * while on screen (IntersectionObserver), the selected tile gets the focus
 * profile, and the tile slider sets the column width.
 */
function DeviceWall({
	rows,
	selectedUdid,
	tile,
	onSelect,
}: {
	rows: readonly FleetRow[];
	selectedUdid: string | undefined;
	tile: number;
	onSelect: (udid: string) => void;
}) {
	if (rows.length === 0) {
		return (
			<div className="sim-list-empty">
				<strong>No targets match these filters</strong>
				<span>Try a different name, state, branch, or agent.</span>
			</div>
		);
	}
	return (
		<ul
			className="device-wall panel-scroll"
			aria-label="Simulator wall"
			style={{ '--tile': `${tile}px` } as React.CSSProperties}
		>
			{rows.map((row) => {
				const selected = row.device.udid === selectedUdid;
				return (
					<li
						key={row.device.udid}
						className={`device-tile ${selected ? 'is-selected' : ''} ${row.live ? 'is-live' : ''}`}
					>
						<DeviceScreen
							className="device-tile-screen"
							live={row.live}
							name={row.device.name}
							quality="tile"
							udid={row.device.udid}
							onActivate={() => onSelect(row.device.udid)}
						/>
						<button
							type="button"
							className="device-tile-body"
							aria-current={selected ? 'true' : undefined}
							onClick={() => onSelect(row.device.udid)}
						>
							<span className="device-tile-title">
								{primaryAgent(row) ? (
									<AgentGlyph kind={primaryAgent(row)?.kind ?? 'other'} />
								) : null}
								<strong className="device-tile-name">{row.device.name}</strong>
								<span
									className={`device-tile-dot ${row.live ? 'is-live' : row.transitioning ? 'is-transitioning' : ''}`}
									aria-hidden="true"
								/>
								<span className="sr-only">{row.device.state}</span>
							</span>
							<span className="device-tile-meta">
								<span className="sim-list-subtitle-item">
									{row.runtimeName}
								</span>
								{row.memoryBytes !== undefined ? (
									<>
										<span aria-hidden="true">·</span>
										<span className="sim-list-memory">
											{formatBytes(row.memoryBytes)}
										</span>
									</>
								) : null}
							</span>
							<FleetRowFacts row={row} />
						</button>
					</li>
				);
			})}
		</ul>
	);
}

/**
 * A row's two lines: the name with its runtime and memory, then the lane,
 * Metro and backend as quiet mono text. The only pill is the state.
 */
function FleetRowText({
	row,
	target,
}: {
	row: FleetRow | undefined;
	target: SimulatorDevice;
}) {
	return (
		<div className="sim-list-copy">
			<span className="fleet-row-line">
				<strong className="fleet-row-name">{target.name}</strong>
				<span
					className="fleet-row-meta"
					title={
						row?.memoryBytes === undefined
							? undefined
							: `${row.processCount ?? '?'} processes · physical footprint of the Simulator process tree`
					}
				>
					{row?.runtimeName ?? target.runtimeIdentifier}
					{row?.memoryBytes === undefined
						? ''
						: ` · ${formatBytes(row.memoryBytes)}`}
				</span>
			</span>
			{row ? <FleetRowFacts row={row} /> : null}
		</div>
	);
}

/** Branch, Metro and backend in one muted line; a dot carries Metro's state. */
function FleetRowFacts({ row }: { row: FleetRow }) {
	const { lane, backend } = row;
	const slim = row.live && row.slim.level !== 'unknown' ? row.slim : undefined;
	if (!lane && !backend && !slim) return null;
	return (
		<span className="fleet-row-facts">
			{lane ? (
				<>
					<code className="fleet-row-branch" title={lane.worktreePath}>
						{lane.branch}
					</code>
					<span className={`fleet-row-metro is-${lane.metro}`}>
						<span aria-hidden="true" className="fleet-row-dot" />:{lane.port}{' '}
						{row.laneHealth?.label ?? lane.metro}
					</span>
				</>
			) : null}
			{backend ? (
				<span className={`fleet-row-backend is-${backend.chip.tone}`}>
					{backend.chip.label}
				</span>
			) : null}
			{slim ? <span title={slim.detail}>{slim.label}</span> : null}
		</span>
	);
}

function CreateFleetControls({
	runtimes,
	deviceTypes,
	preferredDeviceTypeId,
	isBridgeAvailable,
	onCreate,
}: {
	runtimes: SimulatorRuntime[];
	deviceTypes: SimulatorDeviceType[];
	preferredDeviceTypeId?: string | undefined;
	isBridgeAvailable: boolean;
	onCreate: (action: SimulatorActionInput) => void;
}) {
	const availableRuntimes = useMemo(
		() => runtimes.filter((runtime) => runtime.isAvailable),
		[runtimes]
	);
	const [nameTemplate, setNameTemplate] = useState(
		targetConfig.deviceNameTemplate
	);
	const [countText, setCountText] = useState('1');
	const [bootAfterCreate, setBootAfterCreate] = useState(true);
	const [runtimeId, setRuntimeId] = useState(
		availableRuntimes[0]?.identifier ?? ''
	);
	const defaultDeviceTypeId =
		deviceTypes.find((type) => type.identifier === preferredDeviceTypeId)
			?.identifier ??
		deviceTypes
			.filter((type) => /^iPhone \d/.test(type.name))
			.sort((a, b) =>
				b.name.localeCompare(a.name, undefined, { numeric: true })
			)[0]?.identifier ??
		deviceTypes[0]?.identifier ??
		'';
	const [deviceTypeId, setDeviceTypeId] = useState(defaultDeviceTypeId);
	useEffect(() => {
		if (
			!availableRuntimes.some((runtime) => runtime.identifier === runtimeId)
		) {
			setRuntimeId(availableRuntimes[0]?.identifier ?? '');
		}
		if (
			!deviceTypes.some((deviceType) => deviceType.identifier === deviceTypeId)
		) {
			setDeviceTypeId(defaultDeviceTypeId);
		}
	}, [
		availableRuntimes,
		defaultDeviceTypeId,
		deviceTypeId,
		deviceTypes,
		runtimeId,
	]);
	const count = parseSimulatorCreateCount(countText);
	const canCreate =
		isBridgeAvailable &&
		nameTemplate.trim().length > 0 &&
		count !== null &&
		Boolean(runtimeId) &&
		Boolean(deviceTypeId);
	return (
		<div className="sim-fleet-create">
			<div className="sim-toolbar-field sim-toolbar-field-grow">
				<span>Name</span>
				<Input
					aria-label="Simulator name"
					placeholder={`${targetConfig.deviceNameTemplate} {n}`}
					value={nameTemplate}
					onChange={(event) => setNameTemplate(event.currentTarget.value)}
				/>
			</div>
			<div className="sim-toolbar-field sim-create-count">
				<span>Count</span>
				<Input
					aria-label="Number of Simulators to create"
					aria-invalid={count === null}
					inputMode="numeric"
					value={countText}
					onChange={(event) => setCountText(event.currentTarget.value)}
				/>
				{count === null ? (
					<small className="sim-field-error" role="alert">
						Enter a whole number from 1–20.
					</small>
				) : null}
			</div>
			<NativeSelect className="sim-create-select" fullWidth={false}>
				<NativeSelect.Trigger
					aria-label="Simulator runtime for new devices"
					disabled={availableRuntimes.length === 0}
					value={runtimeId}
					onChange={(event) => setRuntimeId(event.currentTarget.value)}
				>
					{runtimes.map((runtime) => (
						<NativeSelect.Option
							disabled={!runtime.isAvailable}
							key={runtime.identifier}
							value={runtime.identifier}
						>
							{runtime.name}
							{runtime.isAvailable ? '' : ' — unavailable'}
						</NativeSelect.Option>
					))}
					<NativeSelect.Indicator>
						<ChevronDown className="h-3 w-3" />
					</NativeSelect.Indicator>
				</NativeSelect.Trigger>
			</NativeSelect>
			<NativeSelect className="sim-create-select" fullWidth={false}>
				<NativeSelect.Trigger
					aria-label="Simulator device type for new devices"
					disabled={deviceTypes.length === 0}
					value={deviceTypeId}
					onChange={(event) => setDeviceTypeId(event.currentTarget.value)}
				>
					{deviceTypes.map((deviceType) => (
						<NativeSelect.Option
							key={deviceType.identifier}
							value={deviceType.identifier}
						>
							{deviceType.name}
						</NativeSelect.Option>
					))}
					<NativeSelect.Indicator>
						<ChevronDown className="h-3 w-3" />
					</NativeSelect.Indicator>
				</NativeSelect.Trigger>
			</NativeSelect>
			<Switch
				isSelected={bootAfterCreate}
				onChange={setBootAfterCreate}
				size="sm"
			>
				<Switch.Control>
					<Switch.Thumb />
				</Switch.Control>
				<Switch.Content>Open when ready</Switch.Content>
			</Switch>
			<Button
				isDisabled={!canCreate}
				size="sm"
				variant="primary"
				onPress={() => {
					if (count === null) return;
					for (let index = 1; index <= count; index += 1) {
						const baseName = nameTemplate.trim();
						const name = baseName.includes('{n}')
							? baseName.replaceAll('{n}', String(index))
							: count === 1
								? baseName
								: `${baseName} ${index}`;
						onCreate({
							kind: 'device.create',
							bootAfterCreate,
							name,
							deviceTypeIdentifier: deviceTypeId,
							runtimeIdentifier: runtimeId,
						});
					}
				}}
			>
				<Plus className="h-3.5 w-3.5" />{' '}
				{bootAfterCreate ? 'Create & open' : 'Create'}
				{count !== null && count > 1 ? ` ${count}` : ''}
			</Button>
			{availableRuntimes.length === 0 ? (
				<span className="sim-field-error">
					Install an iOS runtime in Xcode first.
				</span>
			) : null}
			<InfoPopover label="Creating simulators">
				Create up to 20 simulators. Names are numbered automatically; use{' '}
				{'{n}'} to choose where the number goes. Open when ready starts each
				simulator after creation.
			</InfoPopover>
		</div>
	);
}

function TargetDetail({
	target,
	runtime,
	deviceTypeName,
	apps,
	disk,
	metrics,
	connectedSessions,
	isBridgeAvailable,
	lane,
	backend,
	attachedAgents,
	laneBusy,
	slim,
	onRunAction,
	onOpenConnectedSession,
	onLaneLaunch,
	onLaneStop,
	onOpenLanes,
	onOpenInSupabase,
}: {
	target: SimulatorDevice;
	runtime: SimulatorRuntime | undefined;
	deviceTypeName: string | undefined;
	apps: SimulatorApp[];
	disk: SimulatorDiskInventory | undefined;
	metrics: SimulatorDeviceMetrics | undefined;
	connectedSessions: DeviceSession[];
	isBridgeAvailable: boolean;
	lane: LaneView | undefined;
	backend: FleetRow['backend'];
	attachedAgents: FleetRow['agents'];
	laneBusy: boolean;
	slim: FleetRow['slim'] | undefined;
	onRunAction: (action: SimulatorActionInput, successMessage: string) => void;
	onOpenConnectedSession: (deviceId: string) => void;
	onLaneLaunch: (lane: Lane) => void;
	onLaneStop: (lane: Lane) => void;
	/** Opens Lanes on this lane, or on the start form without one. */
	onOpenLanes: (laneId?: string) => void;
	onOpenInSupabase: (stackId?: string) => void;
}) {
	const [renameName, setRenameName] = useState(target.name);
	const [cloneName, setCloneName] = useState(`${target.name} Copy`);
	const openPresentation = simulatorOpenPresentation(target, isBridgeAvailable);
	const canStop = isBridgeAvailable && target.state === 'booted';
	const eraseAvailability = simulatorEraseAvailability(
		target,
		isBridgeAvailable
	);
	const activeApp = metrics?.activeApp;
	const activeAppName = activeApp
		? apps.find((app) => app.bundleIdentifier === activeApp.bundleIdentifier)
				?.displayName
		: undefined;
	const shownSlim =
		slim && target.state === 'booted' && slim.level !== 'unknown'
			? slim
			: undefined;
	const health = lane ? laneHealth(lane) : undefined;
	const [liveOpen, setLiveOpen] = useState(readStoredLiveScreenOpen);
	const toggleLive = (open: boolean) => {
		setLiveOpen(open);
		try {
			window.localStorage.setItem(LIVE_SCREEN_OPEN_KEY, String(open));
		} catch {
			// Preferences are best-effort.
		}
	};
	return (
		<div className="sim-target-detail">
			<div className="sim-detail-heading">
				<div>
					<h2>{target.name}</h2>
					<span>
						{[
							deviceTypeName ?? 'iOS Simulator',
							runtime?.name,
							metrics ? formatBytes(metrics.memoryBytes) : undefined,
						]
							.filter(Boolean)
							.join(' · ')}
						{shownSlim ? (
							<span title={shownSlim.detail}> · {shownSlim.label}</span>
						) : null}
					</span>
				</div>
				<TargetStatePill state={target.state} />
			</div>
			<div className="sim-action-row">
				<Button
					isDisabled={!openPresentation.allowed}
					size="sm"
					variant="primary"
					onPress={() =>
						onRunAction(
							{ kind: 'device.boot', udid: target.udid },
							target.state === 'booted'
								? `${target.name} opened in Simulator.`
								: `${target.name} is booting.`
						)
					}
				>
					<Play className="h-3.5 w-3.5" /> {openPresentation.label}
				</Button>
				{lane ? (
					<Button
						isDisabled={laneBusy || lane.metro === 'stopped' || !lane.scheme}
						size="sm"
						variant="secondary"
						onPress={() => onLaneLaunch(lane)}
					>
						<Rocket className="h-3.5 w-3.5" /> Launch app
					</Button>
				) : null}
				<Button
					isDisabled={!canStop}
					size="sm"
					variant="ghost"
					onPress={() =>
						onRunAction(
							{ kind: 'device.shutdown', udid: target.udid },
							`${target.name} is shutting down.`
						)
					}
				>
					<Power className="h-3.5 w-3.5" /> Shut down
				</Button>
			</div>
			<section className="sim-detail-section">
				<div className="sim-section-heading">
					<div>
						<h3>Lane</h3>
						<InfoPopover label="Lanes">
							A lane runs one worktree on this Simulator with its own Metro
							port, so several branches and agents can work in parallel.
						</InfoPopover>
					</div>
					{health ? (
						<span className={`sim-lane-health is-${health.tone}`}>
							<span aria-hidden="true" className="fleet-row-dot" />
							Metro {health.label}
						</span>
					) : (
						<Waypoints className="h-3.5 w-3.5" />
					)}
				</div>
				{attachedAgents.length > 0 ? (
					<ul className="sim-agent-list">
						{attachedAgents.map((agent) => (
							<li
								key={`${agent.kind}:${agent.sessionId}`}
								className="sim-agent-row"
							>
								<AgentBadge
									agent={{ ...agent, lastSeenAt: agent.lastSeenAt }}
								/>
								<span className="sim-inline-note">
									{agent.title} · {agent.via}
									{agent.live ? '' : ' · session gone'}
									{agent.note ? ` · ${agent.note}` : ''}
								</span>
							</li>
						))}
					</ul>
				) : null}
				{lane ? (
					<div className="sim-lane-section">
						<dl className="sim-lane-facts">
							<dt>Worktree</dt>
							<dd>
								<code>{lane.branch}</code> · {lane.environment}
							</dd>
							<dt>Metro</dt>
							<dd>
								<code>http://127.0.0.1:{lane.port}</code>
								{lane.metroPid ? ` · pid ${lane.metroPid}` : ''}
							</dd>
							<dt>Path</dt>
							<dd>
								<code title={lane.worktreePath}>
									{shortPath(lane.worktreePath)}
								</code>
							</dd>
							{backend ? (
								<>
									<dt>Backend</dt>
									<dd>
										<span
											className={`fleet-row-backend is-${backend.chip.tone}`}
										>
											{backend.chip.label}
										</span>{' '}
										· {backend.line}
									</dd>
								</>
							) : null}
							{lane.agent ? (
								<>
									<dt>Agent</dt>
									<dd>
										<AgentBadge agent={lane.agent} />
									</dd>
								</>
							) : null}
						</dl>
						<div className="sim-action-row">
							<Button
								size="sm"
								variant="secondary"
								onPress={() => onOpenLanes(lane.id)}
							>
								<ScrollText className="h-3.5 w-3.5" /> Open in Lanes
							</Button>
							{backend ? (
								<Button
									aria-label={`Open the backend of ${lane.branch} in Supabase`}
									size="sm"
									variant="secondary"
									onPress={() => onOpenInSupabase(backend.stackId)}
								>
									<DatabaseZap className="h-3.5 w-3.5" /> Open in Supabase
								</Button>
							) : null}
							<ConfirmAction
								confirmLabel="Stop lane"
								description={`Metro on port ${lane.port} stops and ${target.name} is released for another worktree.`}
								isDisabled={laneBusy}
								title={`Stop lane ${lane.branch}?`}
								triggerIcon={<Square className="h-3.5 w-3.5" />}
								triggerLabel="Stop lane"
								onConfirm={() => onLaneStop(lane)}
							/>
						</div>
					</div>
				) : (
					<div className="sim-lane-section">
						<p className="sim-section-empty">No lane runs on this Simulator.</p>
						<Button size="sm" variant="secondary" onPress={() => onOpenLanes()}>
							<Waypoints className="h-3.5 w-3.5" /> Start a lane here
						</Button>
					</div>
				)}
			</section>
			<section className="sim-detail-section">
				<div className="sim-section-heading">
					<div>
						<h3>Connected app sessions</h3>
						<InfoPopover label="Connected app sessions">
							Open your app with Metro running to connect. Linking it here
							requires the app to report this simulator’s identifier. All
							sessions are available in Connected App.
						</InfoPopover>
					</div>
					<span>{connectedSessions.length}</span>
				</div>
				{connectedSessions.length > 0 ? (
					<div className="sim-installed-apps sim-connected-sessions">
						{connectedSessions.map((session) => (
							<div key={session.info.id}>
								<span
									aria-hidden="true"
									className={`connection-dot ${session.status === 'online' ? 'is-online' : ''}`}
								/>
								<div>
									<strong>
										{session.info.variant ?? session.info.name}
										{session.info.bundleIdentifier
											? ` · ${session.info.bundleIdentifier}`
											: ''}
									</strong>
									<code>
										{session.status}
										{session.info.processId
											? ` · PID ${session.info.processId}`
											: ''}
										{` · ${session.info.id}`}
									</code>
								</div>
								<Button
									size="sm"
									variant="ghost"
									onPress={() => onOpenConnectedSession(session.info.id)}
								>
									Open diagnostics
								</Button>
							</div>
						))}
					</div>
				) : (
					<p className="sim-section-empty">
						No app session linked to this simulator.
					</p>
				)}
			</section>
			<div className="sim-detail-rows">
				<Disclosure
					meta={
						target.state !== 'booted'
							? 'Shut down'
							: liveOpen
								? undefined
								: 'Paused'
					}
					open={liveOpen}
					title="Live screen"
					onToggle={toggleLive}
				>
					<div className="sim-focus-screen">
						<ControllableScreen
							live={target.state === 'booted'}
							name={target.name}
							udid={target.udid}
						/>
						<p className="sim-inline-note">
							Frames come from bounded <code>simctl io screenshot</code>{' '}
							polling, about four a second for this view and one a second per
							wall tile. Nothing is recorded; the view pauses when the window is
							unfocused or this row is closed.
						</p>
					</div>
				</Disclosure>
				<Disclosure title="Target information">
					<dl>
						<KeyValue label="UDID" mono value={target.udid} />
						<KeyValue
							label="Runtime"
							value={runtime?.name ?? target.runtimeIdentifier}
						/>
						<KeyValue label="OS" value={runtime?.version ?? 'Unknown'} />
						<KeyValue label="Device type" value={deviceTypeName ?? 'Unknown'} />
						<KeyValue label="Installed apps" value={apps.length} />
						<KeyValue
							label="Largest app process"
							mono={Boolean(activeApp)}
							value={
								activeApp
									? `${activeAppName ? `${activeAppName} · ` : ''}${activeApp.bundleIdentifier} · PID ${activeApp.processId}`
									: target.state === 'booted'
										? 'No app process sampled'
										: 'Simulator is shut down'
							}
						/>
						<KeyValue
							label="Resource sample"
							value={
								metrics
									? new Date(metrics.sampledAt).toLocaleTimeString()
									: 'Unavailable'
							}
						/>
					</dl>
				</Disclosure>
				<DiskInventorySection
					disk={disk}
					isBridgeAvailable={isBridgeAvailable}
					target={target}
					onRunAction={onRunAction}
				/>
				<Disclosure
					meta={
						metrics
							? `${metrics.cpuPercent.toFixed(0)}% CPU · ${formatBytes(metrics.memoryBytes)}`
							: undefined
					}
					title="Resource monitoring"
				>
					<p className="sim-inline-note">
						Live process footprint, sampled every five seconds while the desktop
						is visible. Shared memory can affect totals; compare the same
						workload.
					</p>
					{metrics ? (
						<>
							<div className="sim-device-metrics">
								<div>
									<span>CPU</span>
									<strong>{metrics.cpuPercent.toFixed(1)}%</strong>
								</div>
								<div>
									<span>Memory</span>
									<strong>{formatBytes(metrics.memoryBytes)}</strong>
								</div>
								<div>
									<span>Processes</span>
									<strong>{metrics.processCount}</strong>
								</div>
								<div>
									<span>Disk allocated</span>
									<strong>
										{metrics.diskAllocatedBytes === undefined
											? '—'
											: formatBytes(metrics.diskAllocatedBytes)}
									</strong>
								</div>
							</div>
							<Disclosure title="Processes using the most memory">
								<div className="sim-process-list">
									{[...metrics.processes]
										.sort((left, right) => right.memoryBytes - left.memoryBytes)
										.slice(0, 20)
										.map((processMetric) => (
											<div key={processMetric.processId}>
												<span>
													<strong title={processMetric.name}>
														{apps.find(
															(app) =>
																app.bundleIdentifier ===
																processMetric.bundleIdentifier
														)?.displayName ?? processMetric.name}
													</strong>
													<code>PID {processMetric.processId}</code>
												</span>
												<span>
													<code>
														{processMetric.cpuPercent.toFixed(1)}% CPU
													</code>
													<code>{formatBytes(processMetric.memoryBytes)}</code>
												</span>
											</div>
										))}
								</div>
							</Disclosure>
						</>
					) : (
						<p className="sim-section-empty">
							No native resource sample is available for this target.
						</p>
					)}
				</Disclosure>
				<Disclosure meta={String(apps.length)} title="Installed apps">
					<div className="sim-row-actions">
						<Button
							isDisabled={!isBridgeAvailable || target.state !== 'booted'}
							size="sm"
							variant="secondary"
							onPress={() =>
								onRunAction(
									{ kind: 'app.list', udid: target.udid },
									'Installed apps refreshed.'
								)
							}
						>
							<RotateCcw className="h-3.5 w-3.5" /> Refresh apps
						</Button>
					</div>
					{apps.length > 0 ? (
						<div className="sim-installed-apps">
							{apps.slice(0, 20).map((app) => (
								<div key={app.bundleIdentifier}>
									<span className="sim-app-icon">
										{app.displayName.slice(0, 1).toUpperCase()}
									</span>
									<div>
										<strong>{app.displayName}</strong>
										<code>{app.bundleIdentifier}</code>
									</div>
									{!app.isSystem ? (
										<ConfirmAction
											confirmLabel="Uninstall app"
											description={`Remove ${app.displayName} and its app data from ${target.name}. Native confirmation is required.`}
											isDisabled={!isBridgeAvailable}
											title={`Uninstall ${app.displayName}?`}
											triggerIcon={<Trash2 className="h-3 w-3" />}
											triggerLabel="Uninstall"
											onConfirm={() =>
												onRunAction(
													{
														kind: 'app.uninstall',
														udid: target.udid,
														bundleIdentifier: app.bundleIdentifier,
													},
													`${app.displayName} uninstall queued.`
												)
											}
										/>
									) : null}
								</div>
							))}
						</div>
					) : (
						<p className="sim-section-empty">
							No user-installed apps were reported.
						</p>
					)}
				</Disclosure>
				<Disclosure title="Manage target">
					<div className="sim-section-heading">
						<div>
							<p>Rename or create a repairable clone</p>
						</div>
						<Pencil className="h-3.5 w-3.5" />
					</div>
					<div className="sim-manage-target-row">
						<Input
							aria-label="New Simulator name"
							value={renameName}
							onChange={(event) => setRenameName(event.currentTarget.value)}
						/>
						<Button
							isDisabled={
								!isBridgeAvailable ||
								renameName.trim().length === 0 ||
								renameName.trim() === target.name
							}
							size="sm"
							variant="secondary"
							onPress={() =>
								onRunAction(
									{
										kind: 'device.rename',
										udid: target.udid,
										name: renameName.trim(),
									},
									`${target.name} was renamed.`
								)
							}
						>
							<Pencil className="h-3.5 w-3.5" /> Rename
						</Button>
					</div>
					<div className="sim-manage-target-row">
						<Input
							aria-label="Cloned Simulator name"
							value={cloneName}
							onChange={(event) => setCloneName(event.currentTarget.value)}
						/>
						<Button
							isDisabled={!isBridgeAvailable || cloneName.trim().length === 0}
							size="sm"
							variant="secondary"
							onPress={() =>
								onRunAction(
									{
										kind: 'device.clone',
										udid: target.udid,
										name: cloneName.trim(),
									},
									`${target.name} clone queued.`
								)
							}
						>
							<Copy className="h-3.5 w-3.5" /> Clone
						</Button>
					</div>
					<p className="sim-inline-note">
						A clone is the supported repair path today. If cloning fails, the
						backend reports the exact simctl error without mutating the source.
					</p>
				</Disclosure>
			</div>
			<section className="sim-danger-zone">
				<div>
					<strong>Erase content and settings</strong>
					<span>{eraseAvailability.reason}</span>
				</div>
				<ConfirmAction
					confirmLabel="Erase Simulator"
					description={`This removes every app and all data from ${target.name}. The target must be shut down first.`}
					isDisabled={!eraseAvailability.allowed}
					title={`Erase ${target.name}?`}
					triggerIcon={<RotateCcw className="h-3.5 w-3.5" />}
					triggerLabel="Erase"
					onConfirm={() =>
						onRunAction(
							{ kind: 'device.erase', udid: target.udid },
							`${target.name} was erased.`
						)
					}
				/>
			</section>
			<section className="sim-danger-zone">
				<div>
					<strong>Delete Simulator</strong>
					<span>Permanently removes this target and its local data.</span>
				</div>
				<ConfirmAction
					confirmLabel="Delete Simulator"
					description={`Permanently delete ${target.name}. Native confirmation issues a short-lived token bound to this exact request.`}
					isDisabled={!isBridgeAvailable}
					title={`Delete ${target.name}?`}
					triggerIcon={<Trash2 className="h-3.5 w-3.5" />}
					triggerLabel="Delete"
					onConfirm={() =>
						onRunAction(
							{ kind: 'device.delete', udid: target.udid },
							`${target.name} deletion queued.`
						)
					}
				/>
			</section>
		</div>
	);
}

function DiskInventorySection({
	disk,
	target,
	isBridgeAvailable,
	onRunAction,
}: {
	disk: SimulatorDiskInventory | undefined;
	target: SimulatorDevice;
	isBridgeAvailable: boolean;
	onRunAction: (action: SimulatorActionInput, successMessage: string) => void;
}) {
	const [selection, setSelection] = useState<{
		revision: string;
		categoryIds: SimulatorDiskCleanupCategoryId[];
	}>({ revision: 'none', categoryIds: [] });
	const inventoryRevision = diskInventorySelectionRevision(disk);

	const selected = disk
		? selection.revision === inventoryRevision
			? sanitizeDiskCleanupCategoryIds(disk, selection.categoryIds)
			: defaultDiskCleanupCategoryIds(disk)
		: [];
	const selectedBytes = disk
		? disk.categories
				.filter((category) =>
					selected.includes(category.id as SimulatorDiskCleanupCategoryId)
				)
				.reduce((total, category) => total + category.bytes, 0)
		: 0;

	return (
		<Disclosure
			meta={disk ? formatBytes(disk.totalBytes) : undefined}
			title="Disk inventory"
		>
			<div className="sim-disk-inventory">
				<div className="sim-row-actions">
					<p className="sim-inline-note">
						Inspect storage to find disposable caches and logs. App data and
						user files are protected.
					</p>
					<Button
						isDisabled={!isBridgeAvailable || !target.isAvailable}
						size="sm"
						variant="ghost"
						onPress={() =>
							onRunAction(
								{ kind: 'disk.inspect', udid: target.udid },
								`${target.name} disk inventory refresh queued.`
							)
						}
					>
						<HardDrive className="h-3.5 w-3.5" /> {disk ? 'Refresh' : 'Inspect'}
					</Button>
				</div>
				{disk ? (
					<>
						<div className="sim-disk-summary">
							<div>
								<span>Simulator data</span>
								<strong>{formatBytes(disk.totalBytes)}</strong>
							</div>
							<div>
								<span>Known cleanable</span>
								<strong>{formatBytes(disk.cleanableBytes)}</strong>
							</div>
							<div>
								<span>Selected</span>
								<strong>{formatBytes(selectedBytes)}</strong>
							</div>
						</div>
						<section
							className="sim-disk-storage"
							aria-label="Protected disk storage"
						>
							{disk.storage.map((item) => (
								<div key={item.id}>
									<span>
										<strong>{item.name}</strong>
										<small>{item.description}</small>
									</span>
									<code>{formatBytes(item.bytes)}</code>
								</div>
							))}
						</section>
						<fieldset className="sim-disk-categories">
							<legend>Allowlisted cleanup categories</legend>
							{disk.categories.map((category) => {
								const categoryId =
									category.id as SimulatorDiskCleanupCategoryId;
								const isSelected = selected.includes(categoryId);
								return (
									<button
										aria-pressed={category.canClean ? isSelected : undefined}
										className={`${isSelected ? 'is-selected' : ''} ${category.canClean ? '' : 'is-protected'}`}
										disabled={!category.canClean}
										key={category.id}
										type="button"
										onClick={() => {
											if (!disk || !category.canClean) return;
											const next = isSelected
												? selected.filter((id) => id !== categoryId)
												: [...selected, categoryId];
											setSelection({
												revision: inventoryRevision,
												categoryIds: sanitizeDiskCleanupCategoryIds(disk, next),
											});
										}}
									>
										<span className="sim-disk-category-check">
											{isSelected ? (
												<SquareCheckBig className="h-3.5 w-3.5" />
											) : (
												<Square className="h-3.5 w-3.5" />
											)}
										</span>
										<span>
											<strong>{category.name}</strong>
											<small>{category.description}</small>
											<em>
												{category.canClean
													? `Risk ${category.risk} · ${category.downside} Recovery: ${category.recovery}`
													: `Protected · ${category.downside}`}
											</em>
										</span>
										<code>{formatBytes(category.bytes)}</code>
									</button>
								);
							})}
						</fieldset>
						<div className="sim-disk-cleanup-action">
							<div>
								<strong>{selected.length} categories selected</strong>
								<span>
									Cleanup is scoped to known Simulator paths and requires exact
									native confirmation.
								</span>
							</div>
							<ConfirmAction
								confirmLabel="Clean selected data"
								description={`Remove ${formatBytes(selectedBytes)} of allowlisted caches and generated data from ${target.name}. The backend preserves and verifies the prior boot state.`}
								isDisabled={!isBridgeAvailable || selected.length === 0}
								title={`Clean disk data from ${target.name}?`}
								triggerIcon={<Trash2 className="h-3 w-3" />}
								triggerLabel="Clean selected"
								onConfirm={() =>
									onRunAction(
										{
											kind: 'disk.cleanup',
											udid: target.udid,
											categoryIds: selected,
										},
										`${target.name} cleanup queued.`
									)
								}
							/>
						</div>
						{disk.lastCleanup ? (
							<p className="sim-disk-last-cleanup" role="status">
								Last cleanup reclaimed{' '}
								{formatBytes(disk.lastCleanup.reclaimedBytes)} ·{' '}
								{disk.lastCleanup.bootStateRestored
									? 'original boot state restored'
									: 'boot state needs attention'}{' '}
								· {new Date(disk.lastCleanup.cleanedAt).toLocaleString()}
							</p>
						) : null}
						<p className="sim-inline-note">
							Inspected {new Date(disk.inspectedAt).toLocaleString()}. Installed
							apps, Documents, app data, user media, and required Siri assets
							are never cleanup targets.
						</p>
					</>
				) : (
					<p className="sim-section-empty">
						Inspect storage to see what can be cleaned.
					</p>
				)}
			</div>
		</Disclosure>
	);
}

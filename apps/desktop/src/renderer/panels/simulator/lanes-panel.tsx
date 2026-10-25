import { Button } from '@heroui/react/button';
import { NativeSelect } from '@heroui-pro/react/native-select';
import {
	Bot,
	ChevronDown,
	Copy,
	DatabaseZap,
	FolderGit2,
	FolderPlus,
	Play,
	RefreshCw,
	RotateCcw,
	ScrollText,
	Square,
	Waypoints,
	X,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ControllableScreen } from '@/components/controllable-screen';
import { DeviceScreen } from '@/components/device-screen';
import {
	AgentBadge,
	AgentGlyph,
	LaneChip,
	LaneSlimBadge,
	WorktreeLabel,
} from '@/components/lane-ui';
import { SimulatorMetric } from '@/components/simulator-ui';
import { SupabaseChip } from '@/components/supabase-ui';
import {
	ConfirmAction,
	CopyButton,
	DisabledReason,
	Disclosure,
	InfoPopover,
	KeyValue,
	PanelHeader,
	PanelNotice,
	StatusPill,
} from '@/components/ui';
import { shortPath } from '@/simulator/fleet-model';
import {
	type LaneBackendChoice,
	laneBackendSelect,
	laneBackendStack,
	laneBackendView,
	laneChipFor,
	laneRestartMetroAvailability,
	laneStartPendingMessage,
	laneStopBackend,
	laneWorktreeBackend,
	laneWorktreeOptionSuffix,
	supabaseChipsVisible,
} from '@/simulator/supabase-cross-panel';
import {
	supabaseStackDeadlines,
	supabaseStateClock,
} from '@/simulator/supabase-model';
import { useAgentRuntime } from '@/state/agent-runtime';
import { resolveLaneFocus, useLaneRuntime } from '@/state/lane-runtime';
import { useSimulatorRuntime } from '@/state/simulator-runtime';
import { useSlimmingRuntime } from '@/state/slimming-runtime';
import {
	useSupabaseActions,
	useSupabaseNavigation,
	useSupabaseNow,
	useSupabaseState,
} from '@/state/supabase-runtime';
import { holdCountdownLabel } from '../../../shared/device-hold';
import type {
	Lane,
	LaneDeviceRequest,
	LaneEnvironment,
	LaneState,
	LaneView,
	LaneWorktree,
} from '../../../shared/lane-protocol';
import {
	LANE_METRO_HEALTH_TIMEOUT_MS,
	laneDevClientLaunchUrl,
} from '../../../shared/lane-protocol';
import type { SimulatorDevice } from '../../../shared/simulator-protocol';
import type { SlimmingProfile } from '../../../shared/slimming-protocol';
import {
	type SupabaseState,
	supabaseStackTitle,
} from '../../../shared/supabase-protocol';
import { AgentsView } from './agents-view';

/** The DOM id of a lane row, so a deep link can scroll it into view. */
function laneRowId(laneId: string): string {
	return `lane-row-${laneId}`;
}

/**
 * Picks the worktree to preselect: the first one without a lane, so a second
 * "Start lane" never silently targets a checkout that is already running.
 */
export function defaultLaneWorktree(
	worktrees: readonly LaneWorktree[]
): string {
	return (
		worktrees.find((worktree) => !worktree.laneId)?.path ??
		worktrees[0]?.path ??
		''
	);
}

/**
 * Devices are offered booted-first, then shut down; devices another lane owns
 * stay visible but disabled so the operator sees why they cannot be chosen.
 */
export function laneDeviceOptions(
	devices: readonly SimulatorDevice[],
	lanes: readonly Lane[]
): Array<{ device: SimulatorDevice; disabledReason?: string }> {
	const laneByUdid = new Map(
		lanes.map((lane) => [lane.simulatorUdid.toUpperCase(), lane])
	);
	return devices
		.filter((device) => device.isAvailable)
		.map((device) => {
			const lane = laneByUdid.get(device.udid.toUpperCase());
			return lane
				? { device, disabledReason: `lane ${lane.branch}` }
				: { device };
		})
		.sort(
			(left, right) =>
				Number(right.device.state === 'booted') -
					Number(left.device.state === 'booted') ||
				left.device.name.localeCompare(right.device.name)
		);
}

export function laneSummaryCounts(state: LaneState): {
	lanes: number;
	ready: number;
	agents: number;
	worktrees: number;
} {
	return {
		lanes: state.lanes.length,
		ready: state.lanes.filter((lane) => lane.metro === 'ready').length,
		agents: state.lanes.filter((lane) => lane.agent).length,
		worktrees: state.worktrees.length,
	};
}

export function LanesPanel() {
	const slimming = useSlimmingRuntime();
	const lanes = useLaneRuntime();
	const simulator = useSimulatorRuntime();
	const { state: supabase } = useSupabaseState();
	const chipsVisible = supabaseChipsVisible(supabase);
	const [selectedLaneId, setSelectedLaneId] = useState<string>('');
	const [showStart, setShowStart] = useState(false);
	const [view, setView] = useState<'lanes' | 'agents'>('lanes');
	const [focusedSessionKey, setFocusedSessionKey] = useState<string | null>(
		null
	);
	// Set by a deep link; the lane detail takes focus once, then clears it.
	const [focusDetail, setFocusDetail] = useState(false);
	const agents = useAgentRuntime();
	const liveAgentCount = agents.state.sessions.length;
	const [log, setLog] = useState<{ laneId: string; text: string } | null>(null);
	const counts = laneSummaryCounts(lanes.state);
	const hostFree = simulator.state.metrics.host;

	useEffect(() => {
		if (!lanes.state.lanes.some((lane) => lane.id === selectedLaneId)) {
			setSelectedLaneId(lanes.state.lanes[0]?.id ?? '');
		}
	}, [lanes.state.lanes, selectedLaneId]);

	// Another panel asked for a lane or an Agents card (lanes.focusLane).
	const { focus, focusHandled, isLoading } = lanes;
	useEffect(() => {
		if (!focus) return;
		const decision = resolveLaneFocus(focus, lanes.state.lanes, isLoading);
		if (decision.kind === 'wait') return;
		setView(decision.view);
		if (decision.view === 'agents') {
			setFocusedSessionKey(decision.sessionKey ?? null);
		} else if (decision.laneId !== undefined) {
			setSelectedLaneId(decision.laneId);
			setFocusDetail(true);
		}
		focusHandled(focus.nonce);
	}, [focus, focusHandled, isLoading, lanes.state.lanes]);
	useEffect(() => {
		if (!focusDetail) return;
		document
			.getElementById(laneRowId(selectedLaneId))
			?.scrollIntoView({ block: 'nearest' });
	}, [focusDetail, selectedLaneId]);

	const selectedLane = lanes.state.lanes.find(
		(lane) => lane.id === selectedLaneId
	);
	const deviceByUdid = useMemo(
		() =>
			new Map(
				simulator.state.devices.map((device) => [
					device.udid.toUpperCase(),
					device,
				])
			),
		[simulator.state.devices]
	);

	const launch = (lane: Lane) =>
		void lanes.runOperation(
			{ kind: 'lane.launch', laneId: lane.id },
			{
				pendingMessage: `Waiting for Metro on :${lane.port}…`,
				successMessage: `${lane.branch} launched on ${deviceByUdid.get(lane.simulatorUdid.toUpperCase())?.name ?? 'its Simulator'}.`,
			}
		);
	const stop = (lane: Lane) =>
		void lanes.runOperation(
			{ kind: 'lane.stop', laneId: lane.id },
			{ successMessage: `Lane ${lane.branch} stopped; its Simulator is free.` }
		);
	const readLog = async (lane: Lane) => {
		const receipt = await lanes.runOperation({
			kind: 'lane.log',
			laneId: lane.id,
			maxCharacters: 16 * 1024,
		});
		if (receipt?.completed) {
			setLog({ laneId: lane.id, text: receipt.log ?? '' });
		}
	};

	return (
		<section className="panel-root">
			<PanelHeader
				actions={
					<>
						<Button
							aria-label="Refresh lanes"
							className="sim-icon-button"
							isDisabled={
								!lanes.isBridgeAvailable || lanes.pendingOperation !== null
							}
							isIconOnly
							size="sm"
							variant="secondary"
							onPress={() => void lanes.refresh()}
						>
							<RefreshCw
								className={`h-3.5 w-3.5 ${lanes.pendingOperation === 'lane.refresh' ? 'animate-spin' : ''}`}
							/>
						</Button>
						<fieldset className="sim-layout-toggle">
							<legend className="sr-only">Lanes view</legend>
							<Button
								aria-pressed={view === 'lanes'}
								size="sm"
								variant={view === 'lanes' ? 'secondary' : 'ghost'}
								onPress={() => setView('lanes')}
							>
								<Waypoints className="h-3.5 w-3.5" /> Lanes
							</Button>
							<Button
								aria-pressed={view === 'agents'}
								size="sm"
								variant={view === 'agents' ? 'secondary' : 'ghost'}
								onPress={() => setView('agents')}
							>
								<Bot className="h-3.5 w-3.5" /> Agents
								{liveAgentCount > 0 ? ` (${liveAgentCount})` : ''}
							</Button>
						</fieldset>
						<Button
							isDisabled={!lanes.isBridgeAvailable}
							size="sm"
							variant="primary"
							aria-expanded={showStart}
							onPress={() => {
								setView('lanes');
								setShowStart((shown) => !shown);
							}}
						>
							<Waypoints className="h-4 w-4" />
							{showStart ? 'Close' : 'Start lane'}
						</Button>
					</>
				}
				description="One worktree on one Simulator, served by one Metro on a leased port. Lanes let several branches, and the agents working on them, run side by side."
				meta={`${counts.lanes} active`}
				title="Lanes"
			/>
			{!lanes.isBridgeAvailable ? (
				<PanelNotice
					title="Lanes require the secure desktop bridge."
					tone="warning"
				>
					Open this window from the packaged RN Devtools app to manage lanes.
				</PanelNotice>
			) : null}
			{lanes.state.error ? (
				<PanelNotice
					title="Some repositories could not be read."
					tone="warning"
				>
					{lanes.state.error}
				</PanelNotice>
			) : null}
			{lanes.actionStatus.kind === 'error' ? (
				<PanelNotice title="Lane action failed." tone="danger">
					{lanes.actionStatus.message}
				</PanelNotice>
			) : null}
			<div className="sim-metric-grid">
				<SimulatorMetric
					detail={`${counts.ready} Metro ready`}
					icon={<Waypoints className="h-3.5 w-3.5" />}
					label="Lanes"
					tone={counts.lanes > 0 ? 'success' : 'default'}
					value={String(counts.lanes)}
				/>
				<SimulatorMetric
					detail={`${counts.agents} attached to lanes`}
					icon={<Bot className="h-3.5 w-3.5" />}
					label="Live agents"
					tone={liveAgentCount > 0 ? 'info' : 'default'}
					value={String(liveAgentCount)}
				/>
				<SimulatorMetric
					detail={`${lanes.state.repositories.length} repositories`}
					icon={<FolderGit2 className="h-3.5 w-3.5" />}
					label="Worktrees"
					value={String(counts.worktrees)}
				/>
				<SimulatorMetric
					detail={
						hostFree ? `${hostFree.memoryPressure} pressure` : 'host sample'
					}
					icon={<ScrollText className="h-3.5 w-3.5" />}
					label="Host free"
					tone={hostFree?.memoryPressure === 'critical' ? 'warning' : 'default'}
					value={hostFree ? `${Math.round(hostFree.freePercent)}%` : '—'}
				/>
			</div>
			{showStart ? (
				<StartLaneForm
					devices={simulator.state.devices}
					environments={lanes.state.environments}
					isBusy={lanes.pendingOperation === 'lane.start'}
					lanes={lanes.state.lanes}
					slimProfiles={
						slimming.state.helper.status === 'available'
							? slimming.state.profiles
							: []
					}
					slimUnavailableReason={
						slimming.state.helper.status === 'available'
							? (slimming.state.helper.mutationUnavailableReason ??
								(slimming.state.setting.experimentalMutationsEnabled
									? undefined
									: 'Enable experimental mutations in the SimSlim panel first.'))
							: 'The SimSlim helper is not available.'
					}
					supabase={supabase}
					worktrees={lanes.state.worktrees}
					onAddRepository={() =>
						void lanes.runOperation({ kind: 'lane.add-repository' })
					}
					onStart={async (input, { startsBackend }) => {
						const receipt = await lanes.runOperation(
							{ kind: 'lane.start', ...input },
							{
								pendingMessage: laneStartPendingMessage({
									slim: Boolean(input.slimProfileId),
									backend: startsBackend,
								}),
								successMessage: 'Lane started.',
							}
						);
						if (receipt?.completed && receipt.lane) {
							setSelectedLaneId(receipt.lane.id);
							setShowStart(false);
						}
					}}
				/>
			) : null}
			{view === 'agents' ? (
				<AgentsView
					devices={simulator.state.devices}
					focusSessionKey={focusedSessionKey}
					onFocusHandled={() => setFocusedSessionKey(null)}
					onSelectSimulator={(udid) => {
						simulator.setSelectedDeviceUdid(udid);
						window.location.hash = 'simulator/fleet';
					}}
				/>
			) : (
				<div className="sim-fleet-layout">
					<div className="sim-list-pane panel-scroll">
						{lanes.state.deviceRequests
							.filter(
								(request) =>
									request.status === 'pending' || request.status === 'starting'
							)
							.map((request) => (
								<DeviceRequestCard
									key={request.id}
									devices={simulator.state.devices}
									isBusy={lanes.pendingOperation !== null}
									lanes={lanes.state.lanes}
									request={request}
									onDecide={async (decision, simulatorUdid) => {
										const receipt = await lanes.runOperation(
											{
												kind: 'lane.provide-device',
												requestId: request.id,
												decision,
												...(simulatorUdid ? { simulatorUdid } : {}),
											},
											decision === 'dismiss'
												? { successMessage: 'Device request dismissed.' }
												: {
														pendingMessage:
															decision === 'clone'
																? 'Cloning the Simulator, then booting and starting Metro…'
																: 'Booting the Simulator and starting Metro…',
														successMessage: `Lane ${request.branch} started.`,
													}
										);
										if (receipt?.completed && receipt.lane) {
											setSelectedLaneId(receipt.lane.id);
										}
									}}
								/>
							))}
						{lanes.state.lanes.length === 0 ? (
							<div className="lane-empty">
								<Waypoints className="h-5 w-5" />
								<strong>No lanes yet</strong>
								<span>
									Start a lane to run a worktree on its own Simulator with its
									own Metro port, or let an agent run{' '}
									<code>rndevtools lane --operation up</code>.
								</span>
							</div>
						) : (
							<ul className="lane-list" aria-label="Lanes">
								{lanes.state.lanes.map((lane) => {
									const device = deviceByUdid.get(
										lane.simulatorUdid.toUpperCase()
									);
									const selected = lane.id === selectedLaneId;
									return (
										<li key={lane.id}>
											<button
												type="button"
												className={`lane-row ${selected ? 'is-selected' : ''}`}
												aria-pressed={selected}
												id={laneRowId(lane.id)}
												onClick={() => setSelectedLaneId(lane.id)}
											>
												<DeviceScreen
													className="lane-row-thumb"
													live={device?.state === 'booted'}
													name={device?.name ?? lane.branch}
													quality="tile"
													size="thumb"
													udid={lane.simulatorUdid}
												/>
												<div className="lane-row-copy">
													<div className="lane-row-main">
														<WorktreeLabel
															path={lane.worktreePath}
															branch={lane.branch}
														/>
														<LaneChip lane={lane} compact />
													</div>
													<div className="lane-row-meta">
														<span className="lane-row-device">
															{device?.name ?? lane.simulatorUdid}
															{device ? ` · ${device.state}` : ''}
														</span>
														<span className="lane-row-badges">
															{lane.agent ? (
																<AgentBadge agent={lane.agent} />
															) : null}
															<LaneSlimBadge lane={lane} />
															<SupabaseChip
																featureEnabled={chipsVisible}
																summary={lane.backend}
															/>
														</span>
													</div>
												</div>
											</button>
										</li>
									);
								})}
							</ul>
						)}
					</div>
					<div className="sim-detail-pane panel-scroll">
						{selectedLane ? (
							<LaneDetail
								key={selectedLane.id}
								device={deviceByUdid.get(
									selectedLane.simulatorUdid.toUpperCase()
								)}
								focusHeading={focusDetail}
								isBusy={lanes.pendingOperation !== null}
								lane={selectedLane}
								log={log?.laneId === selectedLane.id ? log.text : undefined}
								onCloseLog={() => setLog(null)}
								onHeadingFocused={() => setFocusDetail(false)}
								onLaunch={() => launch(selectedLane)}
								onLog={() => void readLog(selectedLane)}
								onOpenSimulator={() => {
									simulator.setSelectedDeviceUdid(selectedLane.simulatorUdid);
									window.location.hash = 'simulator/fleet';
								}}
								onStop={() => stop(selectedLane)}
							/>
						) : (
							<WorktreesOverview
								lanes={lanes.state.lanes}
								onAddRepository={() =>
									void lanes.runOperation({ kind: 'lane.add-repository' })
								}
								onRemoveRepository={(root) =>
									void lanes.runOperation({
										kind: 'lane.remove-repository',
										repositoryRoot: root,
									})
								}
								repositories={lanes.state.repositories}
								worktrees={lanes.state.worktrees}
							/>
						)}
					</div>
				</div>
			)}
		</section>
	);
}

function StartLaneForm({
	worktrees,
	devices,
	environments,
	lanes,
	slimProfiles,
	slimUnavailableReason,
	supabase,
	isBusy,
	onStart,
	onAddRepository,
}: {
	worktrees: readonly LaneWorktree[];
	devices: readonly SimulatorDevice[];
	environments: readonly LaneEnvironment[];
	lanes: readonly Lane[];
	slimProfiles: readonly SlimmingProfile[];
	/** Why the slim select is disabled, when it is. */
	slimUnavailableReason: string | undefined;
	/** Local Supabase, for the Backend select and the worktree suffixes. */
	supabase: SupabaseState;
	isBusy: boolean;
	onStart: (
		input: {
			worktreePath: string;
			simulatorUdid: string;
			environment: string;
			launch: boolean;
			slimProfileId?: string;
			backend?: 'auto' | 'off' | 'required';
		},
		meta: { startsBackend: boolean }
	) => Promise<void>;
	onAddRepository: () => void;
}) {
	const [worktreePath, setWorktreePath] = useState(() =>
		defaultLaneWorktree(worktrees)
	);
	const [udid, setUdid] = useState('');
	const [environmentId, setEnvironmentId] = useState(
		environments[0]?.id ?? 'development'
	);
	const [slimProfileId, setSlimProfileId] = useState('');
	const [backendChoice, setBackendChoice] =
		useState<LaneBackendChoice>('default');
	const backendHintId = useId();
	const options = useMemo(
		() => laneDeviceOptions(devices, lanes),
		[devices, lanes]
	);
	const environment = environments.find(
		(candidate) => candidate.id === environmentId
	);
	const worktree = worktrees.find(
		(candidate) => candidate.path === worktreePath
	);
	const suffixes = useMemo(
		() =>
			new Map(
				worktrees.map((candidate) => [
					candidate.path,
					laneWorktreeOptionSuffix(
						laneWorktreeBackend(candidate, supabase),
						supabase
					),
				])
			),
		[supabase, worktrees]
	);
	const backend = laneBackendSelect({
		info: worktree
			? laneWorktreeBackend(worktree, supabase)
			: { unknown: true },
		environmentId,
		choice: backendChoice,
		state: supabase,
	});

	useEffect(() => {
		if (!worktrees.some((candidate) => candidate.path === worktreePath)) {
			setWorktreePath(defaultLaneWorktree(worktrees));
		}
	}, [worktrees, worktreePath]);
	useEffect(() => {
		if (
			udid &&
			!options.some(
				(option) => option.device.udid === udid && !option.disabledReason
			)
		) {
			setUdid('');
		}
	}, [options, udid]);

	const canStart =
		!isBusy && Boolean(worktreePath) && Boolean(udid) && Boolean(environment);

	return (
		<form
			className="lane-start-form"
			onSubmit={(event) => {
				event.preventDefault();
				if (!canStart) return;
				void onStart(
					{
						worktreePath,
						simulatorUdid: udid,
						environment: environmentId,
						launch: true,
						...(slimProfileId && !slimUnavailableReason
							? { slimProfileId }
							: {}),
						// Only a choice other than the environment's default travels.
						...(backend.backend !== undefined
							? { backend: backend.backend }
							: {}),
					},
					{ startsBackend: backend.starts }
				);
			}}
		>
			<div className="lane-start-fields">
				<div className="sim-toolbar-field sim-toolbar-field-grow">
					<span>Worktree</span>
					<NativeSelect fullWidth>
						<NativeSelect.Trigger
							aria-label="Worktree"
							disabled={worktrees.length === 0}
							value={worktreePath}
							onChange={(event) => setWorktreePath(event.currentTarget.value)}
						>
							{worktrees.length === 0 ? (
								<NativeSelect.Option value="">
									No repositories tracked yet
								</NativeSelect.Option>
							) : null}
							{worktrees.map((candidate) => (
								<NativeSelect.Option
									key={candidate.path}
									value={candidate.path}
								>
									{candidate.branch} · {shortPath(candidate.path)}
									{candidate.dirty ? ' · dirty' : ''}
									{candidate.laneId ? ' · has lane' : ''}
									{suffixes.get(candidate.path) ?? ''}
								</NativeSelect.Option>
							))}
							<NativeSelect.Indicator>
								<ChevronDown className="h-3 w-3" />
							</NativeSelect.Indicator>
						</NativeSelect.Trigger>
					</NativeSelect>
				</div>
				<div className="sim-toolbar-field sim-toolbar-field-grow">
					<span>Simulator</span>
					<NativeSelect fullWidth>
						<NativeSelect.Trigger
							aria-label="Simulator"
							disabled={options.length === 0}
							value={udid}
							onChange={(event) => setUdid(event.currentTarget.value)}
						>
							<NativeSelect.Option value="">
								Choose a Simulator
							</NativeSelect.Option>
							{options.map(({ device, disabledReason }) => (
								<NativeSelect.Option
									disabled={Boolean(disabledReason)}
									key={device.udid}
									value={device.udid}
								>
									{device.name} · {device.state}
									{disabledReason ? ` · ${disabledReason}` : ''}
								</NativeSelect.Option>
							))}
							<NativeSelect.Indicator>
								<ChevronDown className="h-3 w-3" />
							</NativeSelect.Indicator>
						</NativeSelect.Trigger>
					</NativeSelect>
				</div>
				<div className="sim-toolbar-field">
					<span>Environment</span>
					<NativeSelect fullWidth={false}>
						<NativeSelect.Trigger
							aria-label="Lane environment"
							value={environmentId}
							onChange={(event) => setEnvironmentId(event.currentTarget.value)}
						>
							{environments.map((candidate) => (
								<NativeSelect.Option key={candidate.id} value={candidate.id}>
									{candidate.id}
								</NativeSelect.Option>
							))}
							<NativeSelect.Indicator>
								<ChevronDown className="h-3 w-3" />
							</NativeSelect.Indicator>
						</NativeSelect.Trigger>
					</NativeSelect>
				</div>
				<div className="sim-toolbar-field">
					<span>Slim</span>
					<NativeSelect fullWidth={false}>
						<NativeSelect.Trigger
							aria-label="SimSlim profile"
							disabled={Boolean(slimUnavailableReason)}
							title={slimUnavailableReason}
							value={slimProfileId}
							onChange={(event) => setSlimProfileId(event.currentTarget.value)}
						>
							<NativeSelect.Option value="">No slimming</NativeSelect.Option>
							{slimProfiles.map((profile) => (
								<NativeSelect.Option key={profile.id} value={profile.id}>
									{profile.name}
								</NativeSelect.Option>
							))}
							<NativeSelect.Indicator>
								<ChevronDown className="h-3 w-3" />
							</NativeSelect.Indicator>
						</NativeSelect.Trigger>
					</NativeSelect>
				</div>
				<div className="sim-toolbar-field">
					<span>Backend</span>
					<NativeSelect fullWidth={false}>
						<NativeSelect.Trigger
							aria-describedby={backendHintId}
							aria-label="Lane backend"
							disabled={!backend.availability.allowed}
							value={backend.value}
							onChange={(event) => {
								const next = backend.options.find(
									(option) => option.value === event.currentTarget.value
								);
								if (next) setBackendChoice(next.value);
							}}
						>
							{backend.options.map((option) => (
								<NativeSelect.Option key={option.value} value={option.value}>
									{option.label}
								</NativeSelect.Option>
							))}
							<NativeSelect.Indicator>
								<ChevronDown className="h-3 w-3" />
							</NativeSelect.Indicator>
						</NativeSelect.Trigger>
					</NativeSelect>
				</div>
				<Button
					isDisabled={!canStart}
					size="sm"
					type="submit"
					variant="primary"
				>
					<Play className="h-3.5 w-3.5" />{' '}
					{isBusy ? 'Starting…' : 'Start Metro'}
				</Button>
				<Button size="sm" variant="ghost" onPress={onAddRepository}>
					<FolderPlus className="h-3.5 w-3.5" /> Track repository
				</Button>
			</div>
			{backend.availability.allowed ? (
				<p className="sim-field-help lane-backend-hint" id={backendHintId}>
					<DatabaseZap aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
					<span>{backend.hint}</span>
				</p>
			) : (
				<div>
					<DisabledReason id={backendHintId}>{backend.hint}</DisabledReason>
				</div>
			)}
			<p className="sim-inline-note lane-start-hint">
				{environment ? (
					<>
						Metro ports{' '}
						<code>
							{environment.portRange[0]}–{environment.portRange[1]}
						</code>
						{worktree?.dirty ? ' · the worktree has uncommitted changes' : ''}
						{' · '}the dev client is opened against the leased port once Metro
						answers, within {LANE_METRO_HEALTH_TIMEOUT_MS / 1_000}s.
					</>
				) : (
					'Choose an environment to see its Metro port range.'
				)}
				<InfoPopover label="Starting a lane">
					A lane boots the Simulator if needed, optionally applies a SimSlim
					profile (you confirm it in a native dialog; the signed helper applies
					it), starts <code>expo start --dev-client --localhost</code> from the
					worktree on the leased port, and deep-links the installed dev client
					to it. The dev client must already be installed on the Simulator;
					lanes never trigger a native build.
				</InfoPopover>
			</p>
		</form>
	);
}

/**
 * An agent ran `lane up` without a Simulator and none was free. Agents cannot
 * create Simulators, so the user settles it here: start the lane on an
 * existing device (held ones are labelled, the choice is theirs), on a fresh
 * clone of one, or drop the request. A failed attempt leaves the card up with
 * the reason.
 */
function DeviceRequestCard({
	request,
	devices,
	lanes,
	isBusy,
	onDecide,
}: {
	request: LaneDeviceRequest;
	devices: readonly SimulatorDevice[];
	lanes: readonly Lane[];
	isBusy: boolean;
	onDecide: (
		decision: 'use' | 'clone' | 'dismiss',
		simulatorUdid?: string
	) => Promise<void>;
}) {
	const { holdForSimulator } = useAgentRuntime();
	const options = useMemo(
		() => laneDeviceOptions(devices, lanes),
		[devices, lanes]
	);
	const [udid, setUdid] = useState(
		() => options.find((option) => !option.disabledReason)?.device.udid ?? ''
	);
	useEffect(() => {
		if (udid && !options.some((option) => option.device.udid === udid)) {
			setUdid('');
		}
	}, [options, udid]);
	const chosen = options.find((option) => option.device.udid === udid);
	const starting = request.status === 'starting';
	const hold = udid ? holdForSimulator(udid) : undefined;
	const who =
		request.agent === undefined
			? 'An agent'
			: `A ${request.agent.kind} session (${request.agent.sessionId})`;
	return (
		<PanelNotice
			title={
				starting
					? `Starting ${request.branch}…`
					: `${request.branch} needs a Simulator.`
			}
			tone={starting ? 'info' : 'warning'}
		>
			{who} asked to run <code>{request.branch}</code>
			{request.slimProfileId ? (
				<>
					{' '}
					slimmed with <code>{request.slimProfileId}</code>
				</>
			) : null}{' '}
			and no free Simulator was left. {request.message}
			{starting ? null : (
				<div className="lane-device-request-controls">
					<NativeSelect fullWidth>
						<NativeSelect.Trigger
							aria-label="Simulator for the lane"
							disabled={isBusy || options.length === 0}
							value={udid}
							onChange={(event) => setUdid(event.currentTarget.value)}
						>
							<NativeSelect.Option value="">
								Choose a Simulator
							</NativeSelect.Option>
							{options.map(({ device, disabledReason }) => {
								const deviceHold = holdForSimulator(device.udid);
								const note =
									disabledReason ??
									(deviceHold
										? `held by ${deviceHold.holder?.kind ?? 'operator'}`
										: 'free');
								return (
									<NativeSelect.Option key={device.udid} value={device.udid}>
										{device.name} · {device.state} · {note}
									</NativeSelect.Option>
								);
							})}
							<NativeSelect.Indicator>
								<ChevronDown className="h-3 w-3" />
							</NativeSelect.Indicator>
						</NativeSelect.Trigger>
					</NativeSelect>
					<div className="sim-action-row">
						<Button
							isDisabled={isBusy || !chosen || Boolean(chosen.disabledReason)}
							size="sm"
							variant="primary"
							onPress={() => void onDecide('use', udid)}
						>
							<Play className="h-3.5 w-3.5" />
							{hold ? 'Use it anyway' : 'Use this Simulator'}
						</Button>
						<Button
							isDisabled={isBusy || !chosen}
							size="sm"
							variant="secondary"
							onPress={() => void onDecide('clone', udid)}
						>
							<Copy className="h-3.5 w-3.5" />
							Clone it for this lane
						</Button>
						<Button
							isDisabled={isBusy}
							size="sm"
							variant="ghost"
							onPress={() => void onDecide('dismiss')}
						>
							Dismiss
						</Button>
					</div>
					{hold ? (
						<span className="sim-inline-note is-warning">
							Another session holds this Simulator; starting the lane here takes
							it from them.
						</span>
					) : null}
				</div>
			)}
		</PanelNotice>
	);
}

/**
 * Whether the lane's owner is still around. A hold whose agent session has
 * gone counts down to its automatic release; the lane stays usable until then
 * and a person can stop it sooner from the panel.
 */
function LaneHoldNote({ udid }: { udid: string }) {
	const { holdForSimulator } = useAgentRuntime();
	const hold = holdForSimulator(udid);
	const [now, setNow] = useState(() => Date.now());
	const counting = hold !== undefined && !hold.holderLive;
	const releaseAt = hold?.releaseAt;
	// The last two minutes tick every second, like every other hold clock.
	const cadence =
		releaseAt !== undefined && releaseAt - now > 0 && releaseAt - now < 120_000
			? 1_000
			: 15_000;
	useEffect(() => {
		if (!counting) return;
		const timer = setInterval(() => setNow(Date.now()), cadence);
		return () => clearInterval(timer);
	}, [cadence, counting]);
	if (!hold) return null;
	if (hold.holderLive) {
		return (
			<span className="sim-inline-note">
				Session active · holds this Simulator
			</span>
		);
	}
	const countdown = holdCountdownLabel(
		{ live: false, releaseAt: hold.releaseAt, holder: hold.via },
		now
	);
	return (
		<span className="sim-inline-note is-warning">
			Session {countdown.text}; stop the lane to release it sooner
		</span>
	);
}

/**
 * The lane's Simulator last ran against another local stack. supabase-js
 * keys its session by the first host label, so every local stack shares
 * sb-127-auth-token and a signed-in session can carry over.
 */
function LaneCarryOverNotice({ lane }: { lane: LaneView }) {
	const { state } = useSupabaseState();
	if (
		!supabaseChipsVisible(state) ||
		lane.backend?.warnings.includes('previous-session-on-simulator') !== true
	) {
		return null;
	}
	return (
		<PanelNotice title="A signed-in session may carry over." tone="warning">
			This Simulator last ran against another local stack, and supabase-js keeps
			its session as <code>sb-127-auth-token</code> for every local stack. Sign
			out in the app if requests fail with auth errors.
		</PanelNotice>
	);
}

/**
 * The lane detail's Backend section: the chip, what the stack is doing and
 * why, the API URL (loopback and public, so it is copied here), the names
 * Metro got, who holds the stack, and the three actions.
 */
function LaneBackendSection({
	lane,
	laneBusy,
}: {
	lane: LaneView;
	laneBusy: boolean;
}) {
	const { state, isBridgeAvailable } = useSupabaseState();
	const { run, isPending, isStackPending } = useSupabaseActions();
	const { openInSupabase } = useSupabaseNavigation();
	const restartReasonId = useId();
	const stopReasonId = useId();
	const stack = laneBackendStack(lane, state);
	const now = supabaseStateClock(
		state,
		useSupabaseNow({ deadlines: stack ? supabaseStackDeadlines(stack) : [] })
	);
	const view = laneBackendView(lane, state, now);
	if (!view) return null;
	const restart = view.needsMetroRestart
		? laneRestartMetroAvailability(lane, {
				bridgeAvailable: isBridgeAvailable,
				state,
				pending: laneBusy || isPending(`lane:${lane.id}`),
			})
		: undefined;
	const stop = laneStopBackend(view.stack, state, {
		bridgeAvailable: isBridgeAvailable,
		pending: view.stack ? isStackPending(view.stack.id) : false,
	});
	const title = view.stack ? supabaseStackTitle(view.stack) : lane.branch;
	const stopNow = () => {
		if (stop) void run(stop.operation);
	};
	return (
		<Disclosure
			defaultOpen
			meta={laneChipFor(lane, state)?.label}
			title="Backend"
		>
			<div className="lane-backend">
				<div className="sim-lane-summary">
					<SupabaseChip summary={lane.backend} />
					<span className={`lane-backend-status is-${view.status.tone}`}>
						{view.status.text}
					</span>
				</div>
				{view.reason ? <p className="sim-field-help">{view.reason}</p> : null}
				{view.apiUrl ? (
					<p className="lane-backend-api">
						<span>API</span>
						<code className="lane-backend-api-url">{view.apiUrl}</code>
						<CopyButton label="Copy API URL" value={view.apiUrl} />
					</p>
				) : null}
				<p className="sim-field-help">
					{view.appEnvNames.length > 0
						? `Injected names only: ${view.appEnvNames.join(', ')}`
						: 'Metro got no Supabase variables for this lane.'}
				</p>
				{view.holder ? (
					<p className="sim-field-help lane-backend-holder">
						{view.holder.agent ? (
							<AgentGlyph kind={view.holder.agent.kind} />
						) : null}
						<span>{view.holder.text}</span>
					</p>
				) : null}
				{view.others.length > 0 ? (
					<p className="sim-field-help">
						Also held by {view.others.join(', ')}
					</p>
				) : null}
				{view.notes.map((note) => (
					<p className="sim-field-help lane-backend-note" key={note}>
						{note}
					</p>
				))}
				<div className="sim-action-row">
					<Button
						aria-label={`Open the backend of ${lane.branch} in Supabase`}
						size="sm"
						variant="secondary"
						onPress={() =>
							openInSupabase(
								view.stack
									? { stackId: view.stack.id }
									: { view: 'repositories' }
							)
						}
					>
						<DatabaseZap className="h-3.5 w-3.5" /> Open in Supabase
					</Button>
					{restart ? (
						<>
							<Button
								{...(restart.allowed
									? {}
									: { 'aria-describedby': restartReasonId })}
								isDisabled={!restart.allowed}
								size="sm"
								variant="ghost"
								onPress={() =>
									void run({ kind: 'restart-metro', laneId: lane.id })
								}
							>
								<RotateCcw className="h-3.5 w-3.5" /> Restart Metro to attach
							</Button>
							{restart.allowed ? null : (
								<DisabledReason id={restartReasonId}>
									{restart.reason}
								</DisabledReason>
							)}
						</>
					) : null}
					{stop ? (
						stop.confirmation.kind === 'inline' ? (
							<ConfirmAction
								ariaLabel={`Stop the backend of ${lane.branch}`}
								confirmLabel="Stop backend"
								description={`${stop.confirmation.agents.join(', ')} ${stop.confirmation.agents.length === 1 ? 'uses' : 'use'} ${title}'s database. Stopping keeps its data and ports; the app has no database until it starts again.`}
								{...(stop.availability.allowed
									? {}
									: { disabledReason: stop.availability.reason })}
								title={`Stop ${title}'s database?`}
								tone="warning"
								triggerIcon={<Square className="h-3.5 w-3.5" />}
								triggerLabel={stop.label}
								onConfirm={stopNow}
							/>
						) : (
							<>
								<Button
									{...(stop.availability.allowed
										? {}
										: { 'aria-describedby': stopReasonId })}
									aria-label={`Stop the backend of ${lane.branch}`}
									isDisabled={!stop.availability.allowed}
									size="sm"
									variant="ghost"
									onPress={stopNow}
								>
									<Square className="h-3.5 w-3.5" /> {stop.label}
								</Button>
								{stop.availability.allowed ? null : (
									<DisabledReason id={stopReasonId}>
										{stop.availability.reason}
									</DisabledReason>
								)}
							</>
						)
					) : null}
				</div>
			</div>
		</Disclosure>
	);
}

function LaneDetail({
	lane,
	device,
	focusHeading,
	isBusy,
	log,
	onLaunch,
	onLog,
	onCloseLog,
	onHeadingFocused,
	onStop,
	onOpenSimulator,
}: {
	lane: LaneView;
	device: SimulatorDevice | undefined;
	/** A deep link landed here: focus the heading once, then report it. */
	focusHeading: boolean;
	isBusy: boolean;
	log: string | undefined;
	onLaunch: () => void;
	onLog: () => void;
	onCloseLog: () => void;
	onHeadingFocused: () => void;
	onStop: () => void;
	onOpenSimulator: () => void;
}) {
	const launchUrl = lane.scheme
		? laneDevClientLaunchUrl(lane.scheme, lane.port)
		: undefined;
	const headingRef = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		if (!focusHeading) return;
		headingRef.current?.focus();
		onHeadingFocused();
	}, [focusHeading, onHeadingFocused]);
	return (
		<div className="sim-target-detail">
			<div className="sim-detail-heading">
				<div>
					<p className="sim-eyebrow">Lane</p>
					<h2 ref={headingRef} tabIndex={-1}>
						<code>{lane.branch}</code>
					</h2>
					<span title={lane.appPath ?? lane.worktreePath}>
						{shortPath(lane.appPath ?? lane.worktreePath)}
					</span>
				</div>
				<LaneChip lane={lane} compact />
			</div>
			<div className="sim-focus-screen">
				<ControllableScreen
					live={device?.state === 'booted'}
					name={device?.name ?? lane.branch}
					udid={lane.simulatorUdid}
				/>
			</div>
			<div className="sim-action-row">
				<Button
					isDisabled={isBusy || lane.metro === 'stopped' || !lane.scheme}
					size="sm"
					variant="primary"
					onPress={onLaunch}
				>
					<Play className="h-3.5 w-3.5" /> Launch app
				</Button>
				<Button
					isDisabled={isBusy}
					size="sm"
					variant="secondary"
					onPress={onLog}
				>
					<ScrollText className="h-3.5 w-3.5" /> Metro log
				</Button>
				<Button size="sm" variant="ghost" onPress={onOpenSimulator}>
					Open in Simulators
				</Button>
				<ConfirmAction
					confirmLabel="Stop lane"
					description={`Metro on port ${lane.port} stops and ${device?.name ?? 'the Simulator'} is released for another worktree. The Simulator keeps running.`}
					isDisabled={isBusy}
					title={`Stop lane ${lane.branch}?`}
					triggerIcon={<Square className="h-3.5 w-3.5" />}
					triggerLabel="Stop"
					onConfirm={onStop}
				/>
			</div>
			{lane.metro === 'stopped' ? (
				<PanelNotice title="Metro is not running." tone="warning">
					The bundler for this lane exited. Read the log, then stop the lane and
					start it again.
				</PanelNotice>
			) : null}
			<LaneCarryOverNotice lane={lane} />
			{lane.slim ? (
				<PanelNotice
					title={
						lane.slim.status === 'applied'
							? `Slimmed with ${lane.slim.profileId}.`
							: lane.slim.status === 'applying'
								? `Applying ${lane.slim.profileId}…`
								: lane.slim.status === 'failed'
									? `Slimming with ${lane.slim.profileId} failed.`
									: `Slimming with ${lane.slim.profileId} was skipped.`
					}
					tone={
						lane.slim.status === 'failed'
							? 'danger'
							: lane.slim.status === 'applied'
								? 'info'
								: 'warning'
					}
				>
					{lane.slim.message ?? 'The SimSlim job finished.'}
				</PanelNotice>
			) : null}
			{!lane.scheme ? (
				<PanelNotice title="No URL scheme in app.json." tone="info">
					The worktree declares no <code>expo.scheme</code>, so the dev client
					cannot be deep-linked. Agents can still pass a full URL with{' '}
					<code>lane --operation launch --url</code>.
				</PanelNotice>
			) : null}
			<section className="sim-detail-section">
				<div className="sim-section-heading">
					<div>
						<h3>Agent</h3>
					</div>
				</div>
				{lane.agent ? (
					<div className="lane-agent-card">
						<AgentBadge agent={lane.agent} showSession />
						<LaneHoldNote udid={lane.simulatorUdid} />
					</div>
				) : (
					<p className="sim-section-empty">
						No coding agent has touched this lane. Agents are attributed from{' '}
						<code>CLAUDE_CODE_SESSION_ID</code> or <code>CODEX_THREAD_ID</code>{' '}
						when they use the CLI.
					</p>
				)}
			</section>
			<LaneBackendSection lane={lane} laneBusy={isBusy} />
			<Disclosure defaultOpen title="Lane details">
				<dl>
					<KeyValue label="Lane id" mono value={lane.id} />
					<KeyValue label="Worktree" mono value={lane.worktreePath} />
					{lane.appPath ? (
						<KeyValue label="App directory" mono value={lane.appPath} />
					) : null}
					<KeyValue label="Branch" mono value={lane.branch} />
					<KeyValue
						label="Simulator"
						value={
							device
								? `${device.name} · ${device.state} · ${device.udid}`
								: lane.simulatorUdid
						}
					/>
					<KeyValue label="Environment" value={lane.environment} />
					{lane.slim ? (
						<KeyValue
							label="Slim request"
							value={`${lane.slim.profileId} · ${lane.slim.status}${lane.slim.jobId ? ` · job ${lane.slim.jobId}` : ''}`}
						/>
					) : null}
					<KeyValue
						label="Metro"
						value={`http://127.0.0.1:${lane.port} · ${lane.metro}${lane.metroPid ? ` · pid ${lane.metroPid}` : ''}`}
					/>
					<KeyValue
						label="Bundle"
						mono
						value={lane.bundleIdentifier ?? 'not declared'}
					/>
					<KeyValue label="Scheme" mono value={lane.scheme ?? 'not declared'} />
					{launchUrl ? (
						<KeyValue label="Launch URL" mono value={launchUrl} />
					) : null}
					<KeyValue
						label="Started"
						value={new Date(lane.startedAt).toLocaleString()}
					/>
					{lane.lastLaunchedAt ? (
						<KeyValue
							label="Last launch"
							value={new Date(lane.lastLaunchedAt).toLocaleString()}
						/>
					) : null}
					<KeyValue label="Log" mono value={lane.logPath} />
				</dl>
			</Disclosure>
			{log !== undefined ? (
				<section className="sim-detail-section lane-log">
					<div className="sim-section-heading">
						<div>
							<h3>Metro log</h3>
						</div>
						<Button
							aria-label="Close log"
							className="sim-icon-button"
							isIconOnly
							size="sm"
							variant="ghost"
							onPress={onCloseLog}
						>
							<X className="h-3.5 w-3.5" />
						</Button>
					</div>
					<pre className="lane-log-output">
						{log || 'The log is empty so far.'}
					</pre>
				</section>
			) : null}
		</div>
	);
}

function WorktreesOverview({
	worktrees,
	repositories,
	lanes,
	onAddRepository,
	onRemoveRepository,
}: {
	worktrees: readonly LaneWorktree[];
	repositories: readonly string[];
	lanes: readonly Lane[];
	onAddRepository: () => void;
	onRemoveRepository: (root: string) => void;
}) {
	const laneById = new Map(lanes.map((lane) => [lane.id, lane]));
	return (
		<div className="sim-target-detail">
			<div className="sim-detail-heading">
				<div>
					<p className="sim-eyebrow">Repositories</p>
					<h2>Worktrees</h2>
					<span>Every checkout of a tracked repository can become a lane.</span>
				</div>
				<Button size="sm" variant="secondary" onPress={onAddRepository}>
					<FolderPlus className="h-3.5 w-3.5" /> Track repository
				</Button>
			</div>
			{repositories.length === 0 ? (
				<p className="sim-section-empty">
					Track a repository to list its worktrees here. Starting a lane from
					the CLI tracks the repository automatically.
				</p>
			) : null}
			{repositories.map((root) => {
				const members = worktrees.filter(
					(worktree) => worktree.repositoryRoot === root
				);
				return (
					<section className="sim-detail-section" key={root}>
						<div className="sim-section-heading">
							<div>
								<h3 title={root}>{shortPath(root)}</h3>
							</div>
							<ConfirmAction
								confirmLabel="Stop tracking"
								description={`${shortPath(root)} and its worktrees stop appearing here. Running lanes are not affected.`}
								title="Stop tracking this repository?"
								tone="warning"
								triggerLabel="Untrack"
								onConfirm={() => onRemoveRepository(root)}
							/>
						</div>
						{members.length === 0 ? (
							<p className="sim-section-empty">No worktrees were discovered.</p>
						) : (
							<ul className="worktree-list">
								{members.map((worktree) => {
									const lane = worktree.laneId
										? laneById.get(worktree.laneId)
										: undefined;
									return (
										<li key={worktree.path}>
											<WorktreeLabel
												path={worktree.path}
												branch={worktree.branch}
											/>
											<span className="worktree-list-meta">
												{worktree.dirty ? (
													<StatusPill tone="warning">dirty</StatusPill>
												) : null}
												{lane ? <LaneChip lane={lane} compact /> : null}
											</span>
										</li>
									);
								})}
							</ul>
						)}
					</section>
				);
			})}
			<p className="sim-inline-note">
				Keep worktrees as siblings of the main checkout, never nested inside it;
				Metro's file watcher would otherwise see both trees.
			</p>
		</div>
	);
}

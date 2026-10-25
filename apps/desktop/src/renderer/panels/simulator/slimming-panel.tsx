import { AlertDialog } from '@heroui/react/alert-dialog';
import { Button } from '@heroui/react/button';
import { Input } from '@heroui/react/input';
import { Switch } from '@heroui/react/switch';
import { NativeSelect } from '@heroui-pro/react/native-select';
import {
	Activity,
	BadgeCheck,
	Ban,
	Check,
	ChevronDown,
	CircleAlert,
	ClipboardCheck,
	Cpu,
	Gauge,
	HardDriveDownload,
	HeartPulse,
	History,
	ListRestart,
	RefreshCw,
	RotateCcw,
	ShieldAlert,
	Sparkles,
	Square,
	Undo2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
	DenseVirtualList,
	formatBytes,
	SimulatorMetric,
} from '@/components/simulator-ui';
import {
	ConfirmAction,
	Disclosure,
	EmptyPanel,
	InfoPopover,
	KeyValue,
	PanelHeader,
	PanelNotice,
	StatusPill,
	Toolbar,
} from '@/components/ui';
import {
	allSelectedCheckpointsAvailable,
	allSelectedNeedAttention,
	managedOverrideUdids,
	restoreAndDisableInput,
	type UnknownTupleAcknowledgement,
	unknownCompatibilityBinding,
} from '@/simulator/slimming-ui-model';
import { useSimulatorRuntime } from '@/state/simulator-runtime';
import {
	type SlimmingActionInput,
	useSlimmingRuntime,
} from '@/state/slimming-runtime';
import {
	SLIMMING_CONFIRMATIONS,
	SLIMMING_EXPERIMENTAL_ACKNOWLEDGEMENT,
	type SlimmingCondition,
	type SlimmingDoctorResult,
	type SlimmingJob,
	type SlimmingPlan,
	type SlimmingProfile,
	type SlimmingSimulator,
	type SlimmingSimulatorStatus,
} from '../../../shared/slimming-protocol';

const MAX_BATCH_SIZE = 20;
const DEFAULT_DOCTOR_CAPABILITIES = [
	'push-notifications',
	'storekit',
	'healthkit',
	'universal-links',
	'photo-library',
] as const;

export function SlimmingPanel() {
	const simulatorRuntime = useSimulatorRuntime();
	const {
		state,
		isBridgeAvailable,
		isLoading,
		runtimeError,
		refresh,
		setEnabled,
		acknowledgeCompatibility,
		runAction,
		cancelJob,
	} = useSlimmingRuntime();
	const [selectedProfileId, setSelectedProfileId] = useState('');
	const [selectedUdids, setSelectedUdids] = useState<string[]>([]);
	const [disableDialogOpen, setDisableDialogOpen] = useState(false);

	useEffect(() => {
		if (state.profiles.some((profile) => profile.id === selectedProfileId))
			return;
		setSelectedProfileId(state.profiles[0]?.id ?? '');
	}, [selectedProfileId, state.profiles]);

	// A convenience default belongs only on the first populated discovery. Seeding
	// it whenever the selection is empty makes the last target impossible to clear:
	// unticking it immediately re-adds the first booted Simulator.
	const hasSeededSelection = useRef(false);

	useEffect(() => {
		const available = new Set(
			state.simulators.map((simulator) => simulator.udid)
		);
		const seedDefault =
			!hasSeededSelection.current && state.simulators.length > 0;
		if (state.simulators.length > 0) hasSeededSelection.current = true;
		setSelectedUdids((current) => {
			const retained = current.filter((udid) => available.has(udid));
			if (seedDefault && retained.length === 0) {
				const initial =
					state.simulators.find((simulator) => simulator.state === 'booted') ??
					state.simulators[0];
				if (initial) return [initial.udid];
			}
			// Discovery re-runs on every refresh. Returning a fresh array of the same
			// targets would re-render the virtualized list continuously and drop clicks.
			return retained.length === current.length ? current : retained;
		});
	}, [state.simulators]);

	const selectedProfile =
		state.profiles.find((profile) => profile.id === selectedProfileId) ?? null;
	const selectedSimulators = state.simulators.filter((simulator) =>
		selectedUdids.includes(simulator.udid)
	);
	const selectedStatuses = selectedUdids
		.map((udid) => state.statusBySimulator[udid])
		.filter((status): status is SlimmingSimulatorStatus => Boolean(status));
	const selectedPlans = selectedUdids
		.map((udid) => state.previewBySimulator[udid])
		.filter((plan): plan is SlimmingPlan =>
			Boolean(plan && plan.profileId === selectedProfileId)
		);
	const currentMetricSamples = selectedUdids
		.map((udid) => simulatorRuntime.state.metrics.byDevice[udid])
		.filter(
			(metrics): metrics is NonNullable<typeof metrics> =>
				metrics !== undefined &&
				!metrics.error &&
				simulatorRuntime.state.devices.some(
					(device) =>
						device.udid === metrics.deviceUdid && device.state === 'booted'
				)
		);
	const hasCompleteCurrentMetrics =
		selectedUdids.length > 0 &&
		currentMetricSamples.length === selectedUdids.length;
	const currentMemoryBytes = hasCompleteCurrentMetrics
		? currentMetricSamples.reduce(
				(sum, metrics) => sum + metrics.memoryBytes,
				0
			)
		: null;
	const currentProcessCount = hasCompleteCurrentMetrics
		? currentMetricSamples.reduce(
				(sum, metrics) => sum + metrics.processCount,
				0
			)
		: null;
	const categoryById = useMemo(
		() => new Map(state.categories.map((category) => [category.id, category])),
		[state.categories]
	);
	const profileCategories = selectedProfile
		? selectedProfile.categoryIds
				.map((id) => categoryById.get(id))
				.filter((category) => category !== undefined)
		: [];
	const changingServices = selectedPlans.reduce(
		(total, plan) =>
			total + plan.toDisableServiceIds.length + plan.toEnableServiceIds.length,
		0
	);
	const selectedUnknownTupleBinding =
		unknownCompatibilityBinding(selectedStatuses);
	const plansReady =
		selectedUdids.length > 0 &&
		selectedPlans.length === selectedUdids.length &&
		selectedPlans.every(
			(plan) => plan.profileId === selectedProfileId && plan.executable
		);
	const mutationAvailable =
		isBridgeAvailable &&
		state.helper.status === 'available' &&
		!state.helper.mutationUnavailableReason &&
		state.setting.experimentalMutationsEnabled;
	const canApply =
		mutationAvailable &&
		Boolean(selectedProfile) &&
		plansReady &&
		!selectedUnknownTupleBinding;
	const managedUdids = managedOverrideUdids(state.statusBySimulator);
	const managedStatuses = managedUdids
		.map((udid) => state.statusBySimulator[udid])
		.filter((status): status is SlimmingSimulatorStatus => Boolean(status));
	const needsAttention = selectedStatuses.filter(
		(status) => status.condition === 'needs-attention'
	).length;

	const submit = (action: SlimmingActionInput, successMessage: string) =>
		void runAction(action, { successMessage });

	return (
		<section className="panel-root">
			<SlimmingDisableDialog
				isOpen={disableDialogOpen}
				managedStatuses={managedStatuses}
				managedUdids={managedUdids}
				onLeaveOverrides={() =>
					void setEnabled({
						enabled: false,
						disposition: 'leave-overrides-in-place',
					})
				}
				onOpenChange={setDisableDialogOpen}
				onRestore={async (typedAcknowledgement) => {
					const binding = unknownCompatibilityBinding(managedStatuses);
					const validated = restoreAndDisableInput(
						managedUdids,
						binding,
						typedAcknowledgement
					);
					if (!validated) return;
					if (binding) {
						const acknowledgement = await acknowledgeCompatibility({
							simulatorUdids: managedUdids,
							acknowledgement: typedAcknowledgement,
						});
						if (!acknowledgement.accepted) return;
					}
					const request = restoreAndDisableInput(managedUdids, null, '');
					if (request) await setEnabled(request);
				}}
			/>
			<PanelHeader
				actions={
					<div className="sim-slimming-header-actions">
						<Switch
							aria-label="Enable SimSlim"
							isDisabled={
								!isBridgeAvailable ||
								state.helper.status !== 'available' ||
								Boolean(state.helper.mutationUnavailableReason)
							}
							isSelected={state.setting.experimentalMutationsEnabled}
							size="sm"
							onChange={(selected) => {
								if (selected) {
									void setEnabled({ enabled: true });
									return;
								}
								if (managedUdids.length === 0) {
									void setEnabled({
										enabled: false,
										disposition: 'leave-overrides-in-place',
									});
									return;
								}
								setDisableDialogOpen(true);
							}}
						>
							<Switch.Content>
								<span className="sim-slimming-switch-label">
									Enable SimSlim
								</span>
							</Switch.Content>
							<Switch.Control>
								<Switch.Thumb />
							</Switch.Control>
						</Switch>
						<Button
							aria-label="Refresh Simulator Slimming state"
							isDisabled={!isBridgeAvailable || isLoading}
							isIconOnly
							size="sm"
							variant="secondary"
							onPress={() => void refresh()}
						>
							<RefreshCw
								className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`}
							/>
						</Button>
					</div>
				}
				description="Reduce background services on existing simulators. Create a test simulator in Simulators first, then choose a profile, preview its changes, and apply. SimSlim is experimental and may restart the simulator. A checkpoint allows you to undo changes."
				meta={<HelperStatus status={state.helper.status} />}
				title="SimSlim"
			/>
			{runtimeError ? (
				<PanelNotice title="Slimming helper unavailable." tone="danger">
					{runtimeError}
				</PanelNotice>
			) : null}
			{state.helper.error ? (
				<PanelNotice title="Native helper reported an error." tone="danger">
					{state.helper.error}
				</PanelNotice>
			) : null}
			{state.setting.warning ? (
				<PanelNotice title="Managed overrides remain in place." tone="warning">
					{state.setting.warning}
				</PanelNotice>
			) : null}
			<Toolbar>
				<div className="sim-toolbar-field">
					<span>Profile</span>
					<NativeSelect
						className="sim-slimming-profile-select"
						fullWidth={false}
					>
						<NativeSelect.Trigger
							aria-label="Slimming profile"
							disabled={state.profiles.length === 0}
							value={selectedProfileId}
							onChange={(event) => {
								setSelectedProfileId(event.currentTarget.value);
							}}
						>
							{state.profiles.length === 0 ? (
								<NativeSelect.Option value="">
									No profiles available
								</NativeSelect.Option>
							) : null}
							{state.profiles.map((profile) => (
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
				<span className="sim-toolbar-meta">
					{selectedUdids.length} selected
				</span>
				<span className="sim-toolbar-spacer" />
				<Button
					isDisabled={
						!state.helper.readOnlyAvailable ||
						selectedUdids.length === 0 ||
						!selectedProfile
					}
					size="sm"
					variant={plansReady ? 'secondary' : 'primary'}
					onPress={() =>
						submit(
							{
								kind: 'profile.preview',
								profileId: selectedProfileId,
								simulatorUdids: selectedUdids,
							},
							'Profile preview completed.'
						)
					}
				>
					<ClipboardCheck className="h-3.5 w-3.5" /> Preview changes
				</Button>
				<Button
					isDisabled={
						!state.helper.readOnlyAvailable ||
						selectedUdids.length === 0 ||
						!selectedProfile
					}
					size="sm"
					variant="ghost"
					onPress={() =>
						submit(
							{
								kind: 'profile.verify',
								profileId: selectedProfileId,
								simulatorUdids: selectedUdids,
							},
							'Profile verification completed.'
						)
					}
				>
					<BadgeCheck className="h-3.5 w-3.5" /> Check profile
				</Button>
			</Toolbar>
			<div className="sim-metric-grid">
				<SimulatorMetric
					detail="selected targets"
					icon={<Gauge className="h-3.5 w-3.5" />}
					label="Selected"
					value={String(selectedUdids.length)}
				/>
				<SimulatorMetric
					detail="selected running simulators"
					icon={<Cpu className="h-3.5 w-3.5" />}
					label="Memory now"
					value={
						currentMemoryBytes === null ? '—' : formatBytes(currentMemoryBytes)
					}
				/>
				<SimulatorMetric
					detail="planned changes"
					icon={<HardDriveDownload className="h-3.5 w-3.5" />}
					label="Services"
					value={plansReady ? String(changingServices) : '—'}
				/>
				<SimulatorMetric
					detail="selected targets"
					icon={<ShieldAlert className="h-3.5 w-3.5" />}
					label="Attention"
					tone={needsAttention > 0 ? 'warning' : 'default'}
					value={String(needsAttention)}
				/>
			</div>
			{state.simulators.length === 0 ? (
				<div className="sim-slimming-empty panel-scroll min-h-0 flex-1">
					<EmptyPanel
						compact
						description="Install an iOS runtime, create a Simulator, then refresh the signed helper. Slimming never requires a connected mobile session."
						icon={<Activity className="h-5 w-5" />}
						title="No Simulator slimming targets"
					/>
				</div>
			) : (
				<div className="sim-slimming-layout">
					<section className="sim-surface sim-slimming-targets">
						<header className="sim-surface-header">
							<div>
								<p className="sim-eyebrow">Fleet selection</p>
								<h2>Simulator targets</h2>
							</div>
							<Button
								size="sm"
								variant="ghost"
								onPress={() => {
									setSelectedUdids(
										selectedUdids.length ===
											Math.min(MAX_BATCH_SIZE, state.simulators.length)
											? []
											: state.simulators
													.slice(0, MAX_BATCH_SIZE)
													.map((simulator) => simulator.udid)
									);
								}}
							>
								{selectedUdids.length ===
								Math.min(MAX_BATCH_SIZE, state.simulators.length)
									? 'Clear selection'
									: `Select ${Math.min(MAX_BATCH_SIZE, state.simulators.length)}`}
							</Button>
						</header>
						<DenseVirtualList
							ariaLabel="Simulator slimming targets"
							className="sim-slimming-target-list"
							items={state.simulators}
							getId={(simulator) => simulator.udid}
							rowHeight={62}
							textValue={(simulator) => simulator.name}
							selectedIds={selectedUdids}
							onSelectedIdsChange={(ids) =>
								setSelectedUdids(ids.slice(0, MAX_BATCH_SIZE))
							}
							renderItem={(simulator) => {
								const status = state.statusBySimulator[simulator.udid];
								return (
									<>
										<div className="sim-list-copy">
											<strong>{simulator.name}</strong>
											<span>
												{simulator.runtimeIdentifier
													.replace('com.apple.CoreSimulator.SimRuntime.', '')
													.replace('-', ' ')
													.replaceAll('-', '.')}{' '}
												· {simulator.state === 'booted' ? 'Running' : 'Off'}
											</span>
										</div>
										{status &&
										['needs-attention', 'drifted', 'partial'].includes(
											status.condition
										) ? (
											<ConditionPill condition={status.condition} />
										) : null}
									</>
								);
							}}
						/>
					</section>
					<section className="sim-surface panel-scroll">
						<ProfileWorkspace
							canApply={canApply}
							categories={profileCategories}
							cancelJob={(jobId) => void cancelJob(jobId)}
							currentMemoryBytes={currentMemoryBytes}
							currentProcessCount={currentProcessCount}
							mutationAvailable={mutationAvailable}
							onRun={submit}
							plans={selectedPlans}
							profile={selectedProfile}
							selectedSimulators={selectedSimulators}
							selectedStatuses={selectedStatuses}
							selectedUdids={selectedUdids}
							state={state}
							onAcknowledgeUnknownTuple={async (acknowledgement) => {
								if (acknowledgement.binding !== selectedUnknownTupleBinding)
									return;
								await acknowledgeCompatibility({
									simulatorUdids: selectedUdids,
									acknowledgement: acknowledgement.value,
								});
							}}
							unknownTupleBinding={selectedUnknownTupleBinding}
						/>
					</section>
				</div>
			)}
		</section>
	);
}

function ProfileWorkspace({
	profile,
	categories,
	selectedUdids,
	selectedSimulators,
	selectedStatuses,
	plans,
	currentMemoryBytes,
	currentProcessCount,
	mutationAvailable,
	canApply,
	unknownTupleBinding,
	onAcknowledgeUnknownTuple,
	state,
	onRun,
	cancelJob,
}: {
	profile: SlimmingProfile | null;
	categories: Array<{
		id: string;
		name: string;
		description: string;
		downside: string;
	}>;
	selectedUdids: string[];
	selectedSimulators: SlimmingSimulator[];
	selectedStatuses: SlimmingSimulatorStatus[];
	plans: SlimmingPlan[];
	currentMemoryBytes: number | null;
	currentProcessCount: number | null;
	mutationAvailable: boolean;
	canApply: boolean;
	unknownTupleBinding: string | null;
	onAcknowledgeUnknownTuple: (
		acknowledgement: UnknownTupleAcknowledgement
	) => void | Promise<void>;
	state: ReturnType<typeof useSlimmingRuntime>['state'];
	onRun: (action: SlimmingActionInput, successMessage: string) => void;
	cancelJob: (jobId: string) => void;
}) {
	if (!profile) {
		return (
			<EmptyPanel
				description="The signed helper did not publish a profile catalog. Refresh after helper verification completes."
				icon={<Ban className="h-5 w-5" />}
				title="No slimming profiles available"
			/>
		);
	}
	const hasUnknownTuple = Boolean(unknownTupleBinding);
	const unknownTupleReady = !hasUnknownTuple;
	const canUndo =
		mutationAvailable &&
		allSelectedCheckpointsAvailable(selectedUdids, state.statusBySimulator) &&
		unknownTupleReady;
	// Offered where the needs-attention state shows; main asks before it runs.
	const canForget =
		state.helper.status === 'available' &&
		allSelectedNeedAttention(selectedUdids, state.statusBySimulator);

	return (
		<div className="sim-slimming-workspace">
			<header className="sim-report-heading">
				<div>
					<p className="sim-eyebrow">Selected profile</p>
					<div className="flex items-center gap-2">
						<h2>{profile.name}</h2>
						<InfoPopover label={profile.name}>
							<p>{profile.description}</p>
							{Boolean(profile.preservedServiceIds?.length) && (
								<>
									<p className="mt-2">
										These services stay enabled because they remained registered
										after reboot during iOS 26.5 testing:
									</p>
									<ul className="mt-2 space-y-1 font-mono text-[12px] break-all">
										{profile.preservedServiceIds?.map((serviceId) => (
											<li key={serviceId}>{serviceId}</li>
										))}
									</ul>
								</>
							)}
						</InfoPopover>
					</div>
				</div>
				<StatusPill tone={profile.experimental ? 'warning' : 'default'}>
					{profile.experimental ? 'Experimental' : 'Built-in profile'}
				</StatusPill>
			</header>

			<section className="sim-slimming-action-card">
				<div className="sim-slimming-action-copy">
					<strong>{selectedUdids.length} Simulator targets</strong>
					<span>
						{plans.length === selectedUdids.length && selectedUdids.length > 0
							? `${plans.reduce((sum, plan) => sum + plan.toDisableServiceIds.length, 0)} disable and ${plans.reduce((sum, plan) => sum + plan.toEnableServiceIds.length, 0)} restore operations previewed`
							: 'Preview this exact profile and target set before applying.'}
					</span>
				</div>
				<div className="sim-action-row sim-slimming-action-buttons">
					<ConfirmAction
						confirmLabel="Apply profile"
						description={`Create a checkpoint, then apply ${profile.name} sequentially to ${selectedUdids.length} selected Simulator${selectedUdids.length === 1 ? '' : 's'}. The native backend will ask for final confirmation.`}
						isDisabled={!canApply}
						title={`Apply ${profile.name}?`}
						triggerIcon={<Sparkles className="h-3.5 w-3.5" />}
						triggerLabel="Apply profile"
						triggerVariant="primary"
						tone="warning"
						onConfirm={() =>
							onRun(
								{
									kind: 'profile.apply',
									profileId: profile.id,
									simulatorUdids: selectedUdids,
									confirmation: SLIMMING_CONFIRMATIONS.apply,
								},
								`${profile.name} was queued for ${selectedUdids.length} Simulator targets.`
							)
						}
					/>
					<ConfirmAction
						confirmLabel="Undo last mutation"
						description={`Roll back the latest recovery checkpoint for all ${selectedUdids.length} selected Simulator targets.`}
						isDisabled={!canUndo}
						title="Undo the last managed mutation?"
						triggerIcon={<Undo2 className="h-3.5 w-3.5" />}
						triggerLabel="Undo last change"
						triggerVariant="secondary"
						tone="warning"
						onConfirm={() =>
							onRun(
								{
									kind: 'profile.undo',
									simulatorUdids: selectedUdids,
									confirmation: SLIMMING_CONFIRMATIONS.undo,
								},
								'Checkpoint rollback queued.'
							)
						}
					/>
					<ConfirmAction
						confirmLabel="Restore all"
						description={`Restore every managed service on ${selectedUdids.length} selected targets. Unmanaged host services remain untouched.`}
						isDisabled={
							!mutationAvailable ||
							selectedUdids.length === 0 ||
							!unknownTupleReady
						}
						title="Restore all managed services?"
						triggerIcon={<ListRestart className="h-3.5 w-3.5" />}
						triggerLabel="Restore services"
						triggerVariant="ghost"
						onConfirm={() =>
							onRun(
								{
									kind: 'profile.restore',
									simulatorUdids: selectedUdids,
									confirmation: SLIMMING_CONFIRMATIONS.restore,
								},
								'Managed-service restore queued.'
							)
						}
					/>
					{canForget ? (
						<Button
							size="sm"
							variant="ghost"
							onPress={() =>
								onRun(
									{
										kind: 'pending.forget',
										simulatorUdids: selectedUdids,
										confirmation: SLIMMING_CONFIRMATIONS.forget,
									},
									'Emergency restore point forgotten.'
								)
							}
						>
							<Ban className="h-3.5 w-3.5" /> Forget restore point
						</Button>
					) : null}
					<Button
						isDisabled={
							!state.helper.readOnlyAvailable || selectedUdids.length === 0
						}
						size="sm"
						variant="ghost"
						onPress={() =>
							onRun(
								{
									kind: 'doctor.run',
									simulatorUdids: selectedUdids,
									requiredCapabilities: [...DEFAULT_DOCTOR_CAPABILITIES],
								},
								'Capability doctor completed.'
							)
						}
					>
						<HeartPulse className="h-3.5 w-3.5" /> Check app features
					</Button>
				</div>
				{!mutationAvailable ? (
					<p className="sim-inline-note is-warning">
						{state.helper.mutationUnavailableReason ??
							'Enable SimSlim to apply a profile.'}
					</p>
				) : null}
				{mutationAvailable && hasUnknownTuple && unknownTupleBinding ? (
					<UnknownTupleAcknowledgementDialog
						binding={unknownTupleBinding}
						onAcknowledge={onAcknowledgeUnknownTuple}
						statuses={selectedStatuses}
					/>
				) : null}
			</section>

			<Disclosure title="Service groups, tradeoffs & resource use">
				<section className="sim-slimming-grid">
					<div className="sim-detail-section">
						<div className="sim-section-heading">
							<div>
								<h3>Profile categories</h3>
							</div>
							<span>{categories.length}</span>
						</div>
						<div className="sim-profile-categories">
							{categories.map((category) => (
								<div key={category.id}>
									<Check className="h-3.5 w-3.5" />
									<span>
										<strong>{category.name}</strong>
										<InfoPopover label={category.name}>
											{category.description}
										</InfoPopover>
										<em>{category.downside}</em>
									</span>
								</div>
							))}
						</div>
					</div>
					<div className="sim-detail-section">
						<div className="sim-section-heading">
							<h3>Current resource use</h3>
							<InfoPopover label="Current resource use">
								Live process footprint from the selected running simulators.
								These readings do not measure savings. Compare the same app
								workload before and after a successful apply.
							</InfoPopover>
						</div>
						<div className="sim-evidence-grid">
							<div>
								<span>Memory</span>
								<strong>
									{currentMemoryBytes === null
										? '—'
										: formatBytes(currentMemoryBytes)}
								</strong>
							</div>
							<div>
								<span>Processes</span>
								<strong>{currentProcessCount ?? '—'}</strong>
							</div>
						</div>
					</div>
				</section>
			</Disclosure>
			<section className="sim-detail-section">
				<div className="sim-section-heading">
					<div>
						<h3>Selected target status</h3>
						<p>Drift, compatibility, checkpoints, and doctor results</p>
					</div>
					<span>{selectedSimulators.length}</span>
				</div>
				<div className="sim-target-status-table">
					{selectedSimulators.map((simulator) => {
						const status = state.statusBySimulator[simulator.udid];
						const preview = state.previewBySimulator[simulator.udid];
						const plan =
							preview?.profileId === profile.id ? preview : undefined;
						const doctor = state.doctorBySimulator[simulator.udid];
						const checkpoint = state.checkpointBySimulator[simulator.udid];
						return (
							<details key={simulator.udid}>
								<summary>
									<span>
										<strong>{simulator.name}</strong>
										<code>{simulator.udid}</code>
									</span>
									<ConditionPill condition={status?.condition} />
								</summary>
								<dl>
									<KeyValue
										label="Compatibility"
										value={status?.compatibility?.status ?? 'Not checked'}
									/>
									<KeyValue
										label="Managed services"
										value={
											status
												? `${status.managedDisabledCount}/${status.managedServiceCount} disabled`
												: 'Not checked'
										}
									/>
									<KeyValue
										label="Preview"
										value={
											plan
												? `${plan.toDisableServiceIds.length} disable · ${plan.toEnableServiceIds.length} restore${plan.requiresReboot ? ' · reboot' : ''}`
												: 'Not previewed'
										}
									/>
									<KeyValue
										label="Checkpoint"
										value={
											checkpoint
												? new Date(checkpoint.createdAt).toLocaleString()
												: 'None'
										}
									/>
									<KeyValue
										label="App feature services"
										value={
											doctor
												? doctor.healthy
													? 'Healthy'
													: `${doctor.capabilities.filter((capability) => !capability.available).length} capabilities blocked`
												: 'Not run'
										}
									/>
								</dl>
								{doctor ? <FeatureChecks result={doctor} /> : null}
							</details>
						);
					})}
				</div>
			</section>

			<section className="sim-detail-section">
				<div className="sim-section-heading">
					<div>
						<h3>Recent activity</h3>
						<InfoPopover label="SimSlim activity">
							Each simulator is changed and verified in sequence. An
							unsuccessful change triggers recovery.
						</InfoPopover>
					</div>
					<History className="h-3.5 w-3.5" />
				</div>
				{state.jobs.length === 0 ? (
					<p className="sim-section-empty">No Slimming operations have run.</p>
				) : (
					<div className="sim-slimming-jobs">
						{state.jobs
							.toReversed()
							.slice(0, 8)
							.map((job) => (
								<JobRow
									job={job}
									key={job.id}
									onCancel={() => cancelJob(job.id)}
								/>
							))}
					</div>
				)}
			</section>
		</div>
	);
}

function FeatureChecks({ result }: { result: SlimmingDoctorResult }) {
	const labels: Record<string, string> = {
		'push-notifications': 'Push notifications',
		storekit: 'StoreKit',
		healthkit: 'HealthKit',
		'universal-links': 'Universal links',
		'photo-library': 'Photos',
	};
	return (
		<div className="p-3">
			<div className="flex items-center gap-2">
				<strong>App service checks</strong>
				<InfoPopover label="App service checks">
					Checks whether simulator service overrides block these features. Use
					your app to test actual purchases, permissions, notifications, and
					links after applying a profile.
				</InfoPopover>
			</div>
			<ul
				className="mt-2 space-y-2 text-sm"
				aria-label="App service check results"
			>
				{result.capabilities.map((capability) => (
					<li
						key={capability.id}
						className="flex items-center justify-between gap-3"
					>
						<span>{labels[capability.id] ?? capability.id}</span>
						<StatusPill tone={capability.available ? 'success' : 'danger'}>
							{capability.available ? 'Available' : 'Blocked'}
						</StatusPill>
					</li>
				))}
			</ul>
		</div>
	);
}

function UnknownTupleAcknowledgementDialog({
	binding,
	statuses,
	onAcknowledge,
}: {
	binding: string;
	statuses: SlimmingSimulatorStatus[];
	onAcknowledge: (
		acknowledgement: UnknownTupleAcknowledgement
	) => void | Promise<void>;
}) {
	const [typedValue, setTypedValue] = useState('');
	const unknownCompatibilities = statuses.flatMap((status) => {
		const compatibility = status.compatibility;
		return compatibility?.status === 'unknown' &&
			compatibility.acknowledgementRequired &&
			!compatibility.acknowledged
			? [{ simulatorUdid: status.simulatorUdid, compatibility }]
			: [];
	});
	const exact = typedValue === SLIMMING_EXPERIMENTAL_ACKNOWLEDGEMENT;
	return (
		<AlertDialog
			onOpenChange={(open) => (open ? undefined : setTypedValue(''))}
		>
			<AlertDialog.Trigger className="sim-unknown-ack">
				<Square className="h-4 w-4" />
				<span>
					<strong>Review system compatibility</strong>
					<small>
						Apply, undo, and restore remain blocked until the exact
						acknowledgement is entered for this tuple set.
					</small>
				</span>
			</AlertDialog.Trigger>
			<AlertDialog.Backdrop className="bg-black/40 backdrop-blur-sm dark:bg-black/70">
				<AlertDialog.Container
					className="border border-foreground/12 bg-overlay shadow-2xl"
					size="lg"
				>
					<AlertDialog.Dialog>
						<AlertDialog.Header>
							<AlertDialog.Icon status="warning">
								<ShieldAlert className="h-5 w-5" />
							</AlertDialog.Icon>
							<AlertDialog.Heading>
								Acknowledge unknown compatibility
							</AlertDialog.Heading>
						</AlertDialog.Header>
						<AlertDialog.Body>
							<div className="sim-ack-dialog-body">
								<p>
									These exact macOS, Xcode, runtime, architecture, and catalog
									tuples have not been verified. This acknowledgement is held
									only for the currently displayed tuple set.
								</p>
								<div className="sim-tuple-list">
									{unknownCompatibilities.map(
										({ simulatorUdid, compatibility }) => (
											<div key={`${simulatorUdid}-${compatibility.key}`}>
												<code>{simulatorUdid}</code>
												<span>
													macOS {compatibility.tuple.macOSBuild} · Xcode{' '}
													{compatibility.tuple.xcodeBuild} ·{' '}
													{compatibility.tuple.runtimeIdentifier} ·{' '}
													{compatibility.tuple.hostArchitecture} · catalog{' '}
													{compatibility.tuple.catalogVersion}
												</span>
											</div>
										)
									)}
								</div>
								<div className="sim-ack-input">
									<span>
										Type <code>{SLIMMING_EXPERIMENTAL_ACKNOWLEDGEMENT}</code>{' '}
										exactly
									</span>
									<Input
										aria-label="Unknown compatibility acknowledgement"
										autoComplete="off"
										value={typedValue}
										onChange={(event) =>
											setTypedValue(event.currentTarget.value)
										}
									/>
								</div>
							</div>
						</AlertDialog.Body>
						<AlertDialog.Footer>
							<Button size="sm" slot="close" variant="ghost">
								Cancel
							</Button>
							<Button
								isDisabled={!exact}
								size="sm"
								slot="close"
								variant="primary"
								onPress={() => onAcknowledge({ binding, value: typedValue })}
							>
								Acknowledge this system
							</Button>
						</AlertDialog.Footer>
					</AlertDialog.Dialog>
				</AlertDialog.Container>
			</AlertDialog.Backdrop>
		</AlertDialog>
	);
}

function SlimmingDisableDialog({
	isOpen,
	managedStatuses,
	managedUdids,
	onOpenChange,
	onRestore,
	onLeaveOverrides,
}: {
	isOpen: boolean;
	managedStatuses: SlimmingSimulatorStatus[];
	managedUdids: string[];
	onOpenChange: (open: boolean) => void;
	onRestore: (typedAcknowledgement: string) => void;
	onLeaveOverrides: () => void;
}) {
	const [typedAcknowledgement, setTypedAcknowledgement] = useState('');
	const unknownBinding = unknownCompatibilityBinding(managedStatuses);
	const restoreInput = restoreAndDisableInput(
		managedUdids,
		unknownBinding,
		typedAcknowledgement
	);
	return (
		<AlertDialog
			isOpen={isOpen}
			onOpenChange={(open) => {
				onOpenChange(open);
				if (!open) setTypedAcknowledgement('');
			}}
		>
			<AlertDialog.Backdrop className="bg-black/40 backdrop-blur-sm dark:bg-black/70">
				<AlertDialog.Container
					className="border border-foreground/12 bg-overlay shadow-2xl"
					size="lg"
				>
					<AlertDialog.Dialog>
						<AlertDialog.Header>
							<AlertDialog.Icon status="warning">
								<ListRestart className="h-5 w-5" />
							</AlertDialog.Icon>
							<AlertDialog.Heading>
								Managed services are still changed
							</AlertDialog.Heading>
						</AlertDialog.Header>
						<AlertDialog.Body>
							<div className="sim-disable-dialog-body">
								<p>
									Choose how to handle {managedUdids.length} Simulator
									{managedUdids.length === 1 ? '' : 's'} before experimental
									mutations are disabled.
								</p>
								<div className="sim-managed-targets">
									{managedUdids.map((udid) => (
										<code key={udid}>{udid}</code>
									))}
								</div>
								<div className="sim-disable-choice is-recommended">
									<strong>Recommended: restore, verify, then disable</strong>
									<span>
										The helper restores every listed target sequentially,
										verifies the managed services, and disables mutations only
										after success.
									</span>
								</div>
								<div className="sim-disable-choice is-risky">
									<strong>Leave overrides in place and disable</strong>
									<span>
										No services are restored. Fleet remains in read-only mode
										with a persistent warning and restoration guidance.
									</span>
								</div>
								{managedUdids.length > MAX_BATCH_SIZE ? (
									<p className="sim-field-error" role="alert">
										Restore-and-disable supports at most {MAX_BATCH_SIZE}{' '}
										managed targets. Restore smaller batches from this workspace
										first.
									</p>
								) : null}
								{unknownBinding ? (
									<div className="sim-ack-input">
										<span>
											Unknown compatibility is present. Type{' '}
											<code>{SLIMMING_EXPERIMENTAL_ACKNOWLEDGEMENT}</code>{' '}
											exactly to restore and verify.
										</span>
										<Input
											aria-label="Restore unknown compatibility acknowledgement"
											autoComplete="off"
											value={typedAcknowledgement}
											onChange={(event) =>
												setTypedAcknowledgement(event.currentTarget.value)
											}
										/>
									</div>
								) : null}
							</div>
						</AlertDialog.Body>
						<AlertDialog.Footer>
							<Button size="sm" slot="close" variant="ghost">
								Cancel
							</Button>
							<Button
								className="bg-danger text-danger-foreground hover:bg-danger/90"
								size="sm"
								slot="close"
								variant="ghost"
								onPress={onLeaveOverrides}
							>
								Leave overrides &amp; disable
							</Button>
							<Button
								isDisabled={!restoreInput}
								size="sm"
								slot="close"
								variant="primary"
								onPress={() => onRestore(typedAcknowledgement)}
							>
								Restore, verify &amp; disable
							</Button>
						</AlertDialog.Footer>
					</AlertDialog.Dialog>
				</AlertDialog.Container>
			</AlertDialog.Backdrop>
		</AlertDialog>
	);
}

function HelperStatus({
	status,
}: {
	status: 'checking' | 'available' | 'unavailable' | 'untrusted';
}) {
	return (
		<span className={`sim-helper-status is-${status}`}>
			{status === 'available' ? (
				<BadgeCheck className="h-3 w-3" />
			) : (
				<CircleAlert className="h-3 w-3" />
			)}
			{status === 'available' ? 'Ready' : status}
		</span>
	);
}

function ConditionPill({
	condition,
}: {
	condition: SlimmingCondition | undefined;
}) {
	const tone =
		condition === 'managed-clean' || condition === 'profile-match'
			? 'success'
			: condition === 'drifted' || condition === 'partial'
				? 'warning'
				: condition === 'needs-attention'
					? 'danger'
					: 'default';
	const labels: Record<SlimmingCondition, string> = {
		'managed-clean': 'Unmodified',
		'profile-match': 'Profile applied',
		drifted: 'Changed',
		partial: 'Partial',
		unknown: 'Not checked',
		'needs-attention': 'Check required',
	};
	return (
		<StatusPill tone={tone}>
			{condition ? labels[condition] : 'Not checked'}
		</StatusPill>
	);
}

function JobRow({ job, onCancel }: { job: SlimmingJob; onCancel: () => void }) {
	const running = [
		'queued',
		'preflight',
		'running',
		'verifying',
		'rolling-back',
	].includes(job.status);
	const percent = Math.min(
		100,
		Math.max(0, (job.currentIndex / job.total) * 100)
	);
	return (
		<div className="sim-slimming-job">
			<header>
				<span>
					<strong>
						{
							{
								'profile.preview': 'Preview profile',
								'profile.verify': 'Check profile',
								'profile.apply': 'Apply profile',
								'profile.restore': 'Restore services',
								'profile.undo': 'Undo last change',
								'doctor.run': 'Check app features',
								'pending.forget': 'Forget restore point',
							}[job.kind]
						}
					</strong>
				</span>
				<StatusPill
					tone={
						job.status === 'complete'
							? 'success'
							: job.status === 'failed' || job.status === 'needs-attention'
								? 'danger'
								: running
									? 'info'
									: 'default'
					}
				>
					{job.status}
				</StatusPill>
			</header>
			<p>{job.message}</p>
			<div className="sim-job-progress">
				<span style={{ width: `${percent}%` }} />
			</div>
			<footer>
				<span>
					{job.currentIndex}/{job.total} targets
				</span>
				{running ? (
					<Button size="sm" variant="ghost" onPress={onCancel}>
						<RotateCcw className="h-3 w-3" /> Cancel
					</Button>
				) : null}
			</footer>
		</div>
	);
}

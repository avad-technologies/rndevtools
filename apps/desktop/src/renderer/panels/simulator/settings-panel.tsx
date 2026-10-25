import { Button } from '@heroui/react/button';
import {
	Accessibility,
	ArrowUpRight,
	AudioLines,
	Camera,
	Command,
	DatabaseZap,
	FolderCog,
	Frame,
	Laptop,
	LockKeyhole,
	Monitor,
	MonitorUp,
	Moon,
	Network,
	Rocket,
	ShieldCheck,
	Smartphone,
	Sun,
	SunMoon,
	TerminalSquare,
	Video,
} from 'lucide-react';
import { type ComponentType, useMemo, useState } from 'react';
import {
	BridgeUnavailableNotice,
	RefreshSimulatorsButton,
} from '@/components/simulator-ui';
import {
	Disclosure,
	PanelHeader,
	PanelNotice,
	ReadinessRow,
	type ReadinessStatus,
} from '@/components/ui';
import { setAppearancePreference, useAppearance } from '@/lib/appearance';
import { openSetup, setChecklistHidden, useOnboarding } from '@/lib/onboarding';
import {
	type SimulatorOnboardingOperationInput,
	useSimulatorRuntime,
} from '@/state/simulator-runtime';
import {
	useSupabaseNavigation,
	useSupabaseState,
} from '@/state/supabase-runtime';
import type { AppearancePreference } from '../../../shared/appearance-protocol';
import type {
	SimulatorCapability,
	SimulatorNativeState,
} from '../../../shared/simulator-protocol';
import {
	SUPABASE_REASONS,
	type SupabaseState,
	supabasePlatformLabel,
} from '../../../shared/supabase-protocol';

type CapabilityId =
	| 'xcode'
	| 'simctl'
	| 'screen-recording'
	| 'accessibility'
	| 'camera'
	| 'live-capture'
	| 'audio-capture'
	| 'hardware-video'
	| 'image-composition'
	| 'build-insights'
	| 'network-extension'
	| 'physical-devices'
	| 'agent-cli';

type CapabilityDefinition = {
	id: CapabilityId;
	label: string;
	description: string;
	required: boolean;
	icon: ComponentType<{ className?: string }>;
	mechanism: string;
	unavailableGuidance: string;
	featureLink?: { label: string; hash: string };
	feature?: keyof SimulatorCapability['features'];
	nativeCapability?:
		| 'live-window'
		| 'system-audio'
		| 'hardware-video'
		| 'image-composition'
		| 'network-extension';
};

const CAPABILITIES: CapabilityDefinition[] = [
	{
		id: 'xcode',
		label: 'Xcode toolchain',
		description:
			'Find an explicit Xcode installation and installed iOS runtimes.',
		required: true,
		icon: FolderCog,
		mechanism: 'xcode-select and xcrun',
		unavailableGuidance:
			'Use Select Xcode below to choose an installed Xcode.app. Install an iOS runtime in Xcode if none are available.',
	},
	{
		id: 'simctl',
		label: 'Simulator control',
		description: 'Discover targets and invoke allowlisted Simulator commands.',
		required: true,
		icon: Smartphone,
		mechanism: 'CoreSimulator and simctl',
		unavailableGuidance:
			'Finish Xcode and runtime setup, then use Refresh above to repeat discovery.',
		feature: 'deviceManagement',
	},
	{
		id: 'screen-recording',
		label: 'Screen Recording',
		description:
			'Capture or compose windows only when simulator-native recording is insufficient.',
		required: false,
		icon: MonitorUp,
		mechanism: 'macOS ScreenCaptureKit permission',
		unavailableGuidance:
			'Grant this installed app Screen Recording access in macOS System Settings > Privacy & Security, then restart it.',
		featureLink: { label: 'Open Captures', hash: 'simulator/captures' },
	},
	{
		id: 'accessibility',
		label: 'Native accessibility groundwork',
		description:
			'Prepare host permission for the later arbitrary-app accessibility provider. Semantic actions do not require it.',
		required: false,
		icon: Accessibility,
		mechanism: 'macOS Accessibility permission',
		unavailableGuidance:
			'Connected Components works through the devtools protocol today. Grant this only when evaluating the later native provider.',
	},
	{
		id: 'camera',
		label: 'Camera input',
		description:
			'Route an explicit camera source into supported simulator workflows.',
		required: false,
		icon: Camera,
		mechanism: 'macOS Camera permission',
		unavailableGuidance:
			'Grant this installed app Camera access in macOS System Settings > Privacy & Security when native camera input is needed.',
		featureLink: { label: 'Open Camera Fixtures', hash: 'connected/camera' },
	},
	{
		id: 'live-capture',
		label: 'Live window capture provider',
		description:
			'Probe ScreenCaptureKit support for the later persistent live-mirroring provider.',
		required: false,
		icon: MonitorUp,
		mechanism: 'ScreenCaptureKit capability probe',
		unavailableGuidance:
			'Check Screen Recording permission and the signed native-host capability, then review the target in Captures.',
		featureLink: { label: 'Open Captures', hash: 'simulator/captures' },
		nativeCapability: 'live-window',
	},
	{
		id: 'audio-capture',
		label: 'Audio capture provider',
		description:
			'Probe system and microphone audio support for the later persistent recorder.',
		required: false,
		icon: AudioLines,
		mechanism: 'ScreenCaptureKit and AVFoundation capability probes',
		unavailableGuidance:
			'Grant Microphone access only if narration is needed; system audio also requires the signed native host.',
		featureLink: { label: 'Open Captures', hash: 'simulator/captures' },
		nativeCapability: 'system-audio',
	},
	{
		id: 'hardware-video',
		label: 'Advanced video provider',
		description:
			'Probe H.264, HEVC, and real-time 30/60/120 FPS support for the later capture provider.',
		required: false,
		icon: Video,
		mechanism: 'VideoToolbox hardware configuration probe',
		unavailableGuidance:
			'No accepted hardware encoder configuration was reported for this Mac; standard Simulator recording remains available.',
		featureLink: { label: 'Open Captures', hash: 'simulator/captures' },
		nativeCapability: 'hardware-video',
	},
	{
		id: 'image-composition',
		label: 'Capture Design Studio',
		description:
			'Render local screenshot treatments, comparisons, and export canvases.',
		required: false,
		icon: Frame,
		mechanism: 'Signed native ImageIO compositor',
		unavailableGuidance:
			'The signed image compositor is unavailable in this build; raw captures remain available.',
		featureLink: { label: 'Open Captures', hash: 'simulator/captures' },
		nativeCapability: 'image-composition',
	},
	{
		id: 'build-insights',
		label: 'Build Insights scans',
		description:
			'Inspect explicitly selected Xcode results with the bounded build-results adapter.',
		required: false,
		icon: FolderCog,
		mechanism: 'Path-scoped local scan capability probe',
		unavailableGuidance:
			'The local build-results adapter is unavailable; advanced Swift FSEvents watching is deferred.',
		featureLink: { label: 'Open Build Insights', hash: 'simulator/builds' },
	},
	{
		id: 'network-extension',
		label: 'Whole-Simulator networking',
		description:
			'Shape target traffic only when the signed extension is entitled.',
		required: false,
		icon: Network,
		mechanism: 'Network Extension entitlement probe',
		unavailableGuidance:
			'This build has no approved Network Extension entitlement. App-scoped network profiles remain the fallback.',
		featureLink: { label: 'Open Network', hash: 'connected/network' },
		nativeCapability: 'network-extension',
	},
	{
		id: 'physical-devices',
		label: 'Physical devices',
		description:
			'Discover paired development devices through Apple developer tooling.',
		required: false,
		icon: Laptop,
		mechanism: 'Xcode device services and pairing',
		unavailableGuidance:
			'Physical-device control is outside the Simulator-only launch scope and has no setup action in this build.',
	},
];

export function SettingsPanel() {
	const { isBridgeAvailable, runOnboardingOperation, state } =
		useSimulatorRuntime();
	const [agentSetup, setAgentSetup] = useState<{
		busy: boolean;
		lines: string[];
	}>({ busy: false, lines: [] });
	const runAgentSetup = async () => {
		setAgentSetup({ busy: true, lines: [] });
		const receipt = await runOnboardingOperation({ kind: 'agentCli.setup' });
		setAgentSetup({
			busy: false,
			lines: receipt.completed
				? (receipt.summary ?? ['Setup completed.'])
				: [receipt.error ?? 'Setup failed.'],
		});
	};
	const capabilities = useMemo(
		() =>
			CAPABILITIES.map((definition) => {
				const nativeDetail =
					nativeAdvancedDetail(definition, state.native) ??
					nativePermissionDetail(definition, state.native);
				return {
					...definition,
					status: capabilityStatus(definition, state.capability, state.native),
					detail:
						definition.id === 'xcode'
							? xcodeCapabilityDetail(state.capability)
							: nativeDetail,
				};
			}),
		[state.capability, state.native]
	);
	const requiredReady = capabilities
		.filter((capability) => capability.required)
		.every((capability) => capability.status === 'available');
	const renderCapability = (capability: (typeof capabilities)[number]) => (
		<CapabilityRow
			capability={capability}
			isBridgeAvailable={isBridgeAvailable}
			key={capability.id}
			onRunOnboarding={(operation) => void runOnboardingOperation(operation)}
		/>
	);

	return (
		<section className="panel-root">
			<PanelHeader
				actions={<RefreshSimulatorsButton />}
				description="Check Xcode, manage optional macOS permissions, and choose a theme. Basic simulator controls work without a connected app."
				meta={requiredReady ? 'Core controls ready' : 'Setup required'}
				title="Settings"
			/>
			<BridgeUnavailableNotice />
			{state.capability.licenseStatus === 'required' ? (
				<PanelNotice title="Xcode license required">
					Accept the Xcode license in a trusted terminal, then refresh Simulator
					discovery. The renderer cannot accept it on your behalf.
				</PanelNotice>
			) : null}
			<div className="sim-settings-scroll panel-scroll">
				<div className="sim-settings-layout">
					<section className="sim-surface">
						<header className="sim-surface-header">
							<div>
								<h2>Simulator setup</h2>
							</div>
						</header>
						<div className="sim-capability-list">
							{capabilities
								.filter((capability) => capability.required)
								.map(renderCapability)}
						</div>
						<Disclosure title="Optional features & permissions">
							<div className="sim-capability-list">
								<LocalSupabaseRow />
								{capabilities
									.filter((capability) => !capability.required)
									.map(renderCapability)}
							</div>
						</Disclosure>
					</section>

					<AppearanceSurface />

					<GetStartedSurface />

					<aside className="sim-settings-aside">
						<Disclosure title="Advanced tools & permissions">
							<section className="sim-security-boundary">
								<header>
									<TerminalSquare className="h-4 w-4" />
									<strong>Local agent CLI</strong>
								</header>
								<p>
									Packaged startup verifies the signed CLI before opening its
									private socket. Set up coding agents registers the CLI as an
									MCP server with Claude Code, Codex, Cursor, and Kiro, installs
									the lanes skill where each discovers skills, links the CLI
									into <code className="sim-inline-code">~/.local/bin</code>,
									and adds a Claude Code hook that steers raw{' '}
									<code className="sim-inline-code">simctl</code> back here.
									Existing configuration is preserved; nothing else on your
									shell path changes.
								</p>
								<div className="sim-settings-actions">
									<Button
										isDisabled={!isBridgeAvailable || agentSetup.busy}
										size="sm"
										variant="primary"
										onPress={() => void runAgentSetup()}
									>
										{agentSetup.busy ? 'Setting up…' : 'Set up coding agents'}
									</Button>
									<Button
										isDisabled={!isBridgeAvailable}
										size="sm"
										variant="secondary"
										onPress={() =>
											void runOnboardingOperation({ kind: 'agentCli.reveal' })
										}
									>
										Reveal verified CLI
									</Button>
								</div>
								{agentSetup.lines.length > 0 ? (
									<ul className="sim-settings-outcome">
										{agentSetup.lines.map((line) => (
											<li key={line}>{line}</li>
										))}
									</ul>
								) : null}
							</section>
							<section className="sim-security-boundary">
								<header>
									<LockKeyhole className="h-4 w-4" />
									<strong>Privilege boundary</strong>
								</header>
								<p>
									The renderer cannot invoke a shell, enumerate arbitrary files,
									or grant its own permissions. It sends allowlisted requests
									through a typed, sandboxed preload bridge.
								</p>
								<div>
									<span>
										<ShieldCheck /> Context isolation
									</span>
									<span>
										<Command /> Explicit actions
									</span>
								</div>
							</section>
						</Disclosure>
					</aside>
				</div>
			</div>
		</section>
	);
}

const APPEARANCE_OPTIONS: readonly {
	value: AppearancePreference;
	label: string;
	icon: ComponentType<{ className?: string }>;
}[] = [
	{ value: 'system', label: 'System', icon: Monitor },
	{ value: 'light', label: 'Light', icon: Sun },
	{ value: 'dark', label: 'Dark', icon: Moon },
];

function AppearanceSurface() {
	const { preference, available, error } = useAppearance();
	return (
		<section className="sim-surface">
			<header className="sim-surface-header">
				<div>
					<h2>Appearance</h2>
				</div>
			</header>
			<div className="sim-capability-list">
				<div className="sim-capability-row">
					<span className="sim-capability-icon">
						<SunMoon className="h-4 w-4" />
					</span>
					<div className="sim-capability-copy">
						<div>
							<strong>Theme</strong>
						</div>
						<p>System follows macOS. Light and Dark stay fixed.</p>
						{error ? <p className="sim-field-error">{error}</p> : null}
					</div>
					<fieldset className="sim-layout-toggle">
						<legend className="sr-only">Theme</legend>
						{APPEARANCE_OPTIONS.map(({ value, label, icon: Icon }) => (
							<Button
								aria-pressed={preference === value}
								isDisabled={!available}
								key={value}
								size="sm"
								variant={preference === value ? 'secondary' : 'ghost'}
								onPress={() => void setAppearancePreference(value)}
							>
								<Icon className="h-3.5 w-3.5" />
								{label}
							</Button>
						))}
					</fieldset>
				</div>
			</div>
		</section>
	);
}

/** Setup again, and the way back for a hidden Get started. */
function GetStartedSurface() {
	const { checklistHidden } = useOnboarding();
	return (
		<section className="sim-surface">
			<header className="sim-surface-header">
				<div>
					<h2>Get started</h2>
				</div>
			</header>
			<div className="sim-capability-list">
				<div className="sim-capability-row">
					<span className="sim-capability-icon">
						<Rocket className="h-4 w-4" />
					</span>
					<div className="sim-capability-copy">
						<div>
							<strong>Setup and checklist</strong>
						</div>
						<p>
							{checklistHidden
								? 'Get started is hidden from the sidebar.'
								: 'Get started stays in the sidebar until every task is done.'}
						</p>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						{checklistHidden ? (
							<Button
								size="sm"
								variant="ghost"
								onPress={() => setChecklistHidden(false)}
							>
								Show in sidebar
							</Button>
						) : null}
						<Button size="sm" variant="secondary" onPress={() => openSetup()}>
							Run setup again
						</Button>
					</div>
				</div>
			</div>
		</section>
	);
}

function xcodeCapabilityDetail(capability: SimulatorCapability): string {
	return [
		capability.xcodeVersion ? `Xcode ${capability.xcodeVersion}` : undefined,
		capability.xcodeBuild ? `build ${capability.xcodeBuild}` : undefined,
		`${capability.runtimeAvailability.available}/${capability.runtimeAvailability.total} runtimes available`,
		`${capability.hostArchitecture} host`,
		capability.selectedDeveloperDirectoryLabel,
		`license ${capability.licenseStatus}`,
	]
		.filter((detail): detail is string => Boolean(detail))
		.join(' · ');
}

function CapabilityRow({
	capability,
	isBridgeAvailable,
	onRunOnboarding,
}: {
	capability: CapabilityDefinition & {
		status: SimulatorCapability['status'];
		detail: string | undefined;
	};
	isBridgeAvailable: boolean;
	onRunOnboarding: (operation: SimulatorOnboardingOperationInput) => void;
}) {
	const readiness = capabilityReadiness(capability);
	const onboarding = capabilityOnboardingAction(capability.id);
	return (
		<ReadinessRow
			actions={
				<>
					{onboarding ? (
						<Button
							isDisabled={!isBridgeAvailable}
							size="sm"
							variant="secondary"
							onPress={() => onRunOnboarding(onboarding.operation)}
						>
							{onboarding.label}
						</Button>
					) : null}
					{capability.featureLink ? (
						<Button
							aria-label={`${capability.featureLink.label} for ${capability.label}`}
							className="sim-capability-feature-link"
							size="sm"
							variant="ghost"
							onPress={() => {
								window.location.hash = capability.featureLink?.hash ?? '';
							}}
						>
							{capability.featureLink.label}
							<ArrowUpRight className="h-3 w-3" />
						</Button>
					) : null}
				</>
			}
			{...(capability.status === 'available'
				? {}
				: { detail: capabilityGuidance(capability, isBridgeAvailable) })}
			icon={capability.icon}
			info={
				<>
					<p>{capability.description}</p>
					<p className="mt-2 break-words">
						{capability.detail ?? capability.mechanism}
					</p>
				</>
			}
			label={capability.label}
			status={readiness.status}
			statusLabel={readiness.label}
			tag={capability.required ? 'Required' : 'Optional'}
		/>
	);
}

/** A capability's pill: Ready, Checking, Needs setup (required) or Not available. */
export function capabilityReadiness(capability: {
	status: SimulatorCapability['status'];
	required: boolean;
}): { status: ReadinessStatus; label: string } {
	if (capability.status === 'available') {
		return { status: 'ready', label: 'Ready' };
	}
	if (capability.status === 'checking') {
		return { status: 'checking', label: 'Checking' };
	}
	return capability.required
		? { status: 'needs-fix', label: 'Needs setup' }
		: { status: 'optional', label: 'Not available' };
}

/**
 * The global Local Supabase row: the platform verdict and whether the
 * feature is on. It is optional, so it never adds to the Settings count.
 */
export function localSupabaseReadiness(
	state: Pick<
		SupabaseState,
		'availability' | 'feature' | 'capacity' | 'repositories'
	>,
	bridgeAvailable: boolean
): { status: ReadinessStatus; label: string; detail: string } {
	if (!bridgeAvailable) {
		return {
			status: 'optional',
			label: 'Not available',
			detail: SUPABASE_REASONS.bridge,
		};
	}
	const platform = supabasePlatformLabel(state.availability.platform);
	if (!state.availability.platform.supported) {
		return {
			status: 'optional',
			label: 'Not available',
			detail: `Native Supabase needs Apple silicon and macOS 14 or later. This Mac: ${platform}.`,
		};
	}
	if (state.feature.policyHealth === 'quarantined') {
		return {
			status: 'check',
			label: 'Off',
			detail:
				"Supabase settings couldn't be read, so local Supabase was turned off and defaults restored.",
		};
	}
	if (!state.feature.enabled) {
		return {
			status: 'optional',
			label: 'Off',
			detail: `This Mac can run it (${platform}). Off means off: nothing runs or polls.`,
		};
	}
	const { running } = state.capacity;
	if (running > 0) {
		return {
			status: 'ready',
			label: `On · ${running} running`,
			detail: `One local Supabase stack per worktree and branch · ${platform}.`,
		};
	}
	const needsSetup =
		state.repositories.length > 0 &&
		!state.repositories.some(
			(repository) => repository.readiness === 'ready'
		) &&
		state.repositories.some(
			(repository) => repository.readiness === 'needs-fix'
		);
	return needsSetup
		? {
				status: 'check',
				label: 'Needs setup',
				detail:
					'No tracked repository is ready for local Supabase yet. Review them in the Supabase tab.',
			}
		: {
				status: 'ready',
				label: 'On',
				detail: `One local Supabase stack per worktree and branch · ${platform}.`,
			};
}

function LocalSupabaseRow() {
	const { state, isBridgeAvailable } = useSupabaseState();
	const { openInSupabase } = useSupabaseNavigation();
	const readiness = localSupabaseReadiness(state, isBridgeAvailable);
	return (
		<ReadinessRow
			actions={
				<Button
					className="sim-capability-feature-link"
					size="sm"
					variant="ghost"
					onPress={() => openInSupabase({ view: 'settings' })}
				>
					Open Supabase settings
					<ArrowUpRight className="h-3 w-3" />
				</Button>
			}
			detail={readiness.detail}
			icon={DatabaseZap}
			info={
				<p>
					One local Supabase stack per worktree and branch, on 127.0.0.1, using
					Supabase&apos;s native runtime. It is optional and alpha; turn it on
					in the Supabase tab.
				</p>
			}
			label="Local Supabase (alpha)"
			status={readiness.status}
			statusLabel={readiness.label}
			tag="Optional"
		/>
	);
}

export function capabilityOnboardingAction(id: CapabilityId): {
	label: string;
	operation: SimulatorOnboardingOperationInput;
} | null {
	if (id === 'xcode') {
		return {
			label: 'Select Xcode…',
			operation: { kind: 'toolchain.selectXcode' },
		};
	}
	if (id === 'screen-recording' || id === 'live-capture') {
		return {
			label: 'Open System Settings',
			operation: {
				kind: 'privacy.openSettings',
				permission: 'screen_recording',
			},
		};
	}
	if (id === 'accessibility') {
		return {
			label: 'Open System Settings',
			operation: { kind: 'privacy.openSettings', permission: 'accessibility' },
		};
	}
	if (id === 'camera') {
		return {
			label: 'Open System Settings',
			operation: { kind: 'privacy.openSettings', permission: 'camera' },
		};
	}
	if (id === 'audio-capture') {
		return {
			label: 'Open System Settings',
			operation: { kind: 'privacy.openSettings', permission: 'microphone' },
		};
	}
	if (id === 'agent-cli') {
		return { label: 'Reveal CLI', operation: { kind: 'agentCli.reveal' } };
	}
	return null;
}

export function capabilityGuidance(
	capability: Pick<CapabilityDefinition, 'unavailableGuidance'> & {
		status: SimulatorCapability['status'];
	},
	isBridgeAvailable: boolean
): string {
	if (!isBridgeAvailable) {
		return 'Open this workspace in the installed desktop app to inspect this capability.';
	}
	if (capability.status === 'checking') {
		return 'Capability discovery is still running. Use Refresh above if it does not finish.';
	}
	if (capability.status === 'available') {
		return 'Ready. Open the feature-owned workspace to use its controls.';
	}
	return capability.unavailableGuidance;
}

function capabilityStatus(
	definition: CapabilityDefinition,
	capability: SimulatorCapability,
	native: SimulatorNativeState
): SimulatorCapability['status'] {
	if (capability.status === 'checking') return 'checking';
	if (definition.id === 'xcode') return capability.status;
	if (definition.id === 'build-insights') {
		return capability.platform === 'darwin' && capability.status === 'available'
			? 'available'
			: 'unavailable';
	}
	if (definition.nativeCapability) {
		if (native.status === 'checking') return 'checking';
		const advanced = native.advanced;
		if (!advanced) return 'unavailable';
		if (definition.nativeCapability === 'live-window') {
			return persistentCaptureProviderStatus(
				native.liveCaptureSessions,
				advanced.screenCaptureKit.liveWindowCapture === 'available'
			);
		}
		if (definition.nativeCapability === 'system-audio') {
			return persistentCaptureProviderStatus(
				native.liveCaptureSessions,
				advanced.screenCaptureKit.systemAudioCapture === 'available'
			);
		}
		if (definition.nativeCapability === 'hardware-video') {
			return persistentCaptureProviderStatus(
				native.liveCaptureSessions,
				advanced.videoToolbox.codecs.some(
					(codec) =>
						codec.hardwareEncodeSupported &&
						codec.acceptedRealtimeConfigurationFrameRates.length > 0
				)
			);
		}
		if (definition.nativeCapability === 'image-composition') {
			return native.imageComposition ? 'available' : 'unavailable';
		}
		return advanced.networkExtension.trafficInterception === 'available'
			? 'available'
			: 'unavailable';
	}
	const permissionId = nativePermissionId(definition);
	if (permissionId) {
		if (native.status === 'checking') return 'checking';
		const permission = native.permissions.find(
			(item) => item.id === permissionId
		);
		return permission?.value === 'granted' ? 'available' : 'unavailable';
	}
	if (definition.feature) {
		return capability.features[definition.feature]
			? 'available'
			: 'unavailable';
	}
	return 'unavailable';
}

export function persistentCaptureProviderStatus(
	persistentSessions: boolean | undefined,
	underlyingCapabilityAvailable: boolean
): SimulatorCapability['status'] {
	return persistentSessions === true && underlyingCapabilityAvailable
		? 'available'
		: 'unavailable';
}

function nativePermission(
	definition: CapabilityDefinition,
	native: SimulatorNativeState
): SimulatorNativeState['permissions'][number] | undefined {
	const permissionId = nativePermissionId(definition);
	return permissionId
		? native.permissions.find((permission) => permission.id === permissionId)
		: undefined;
}

function nativePermissionId(
	definition: CapabilityDefinition
): SimulatorNativeState['permissions'][number]['id'] | undefined {
	if (definition.id === 'screen-recording') return 'screen_recording';
	if (definition.id === 'accessibility' || definition.id === 'camera') {
		return definition.id;
	}
	return undefined;
}

function nativePermissionDetail(
	definition: CapabilityDefinition,
	native: SimulatorNativeState
): string | undefined {
	const permission = nativePermission(definition, native);
	if (!permission) return undefined;
	const value = permission.value.replaceAll('_', ' ');
	return native.permissionInspection
		? `${value} · read-only inspection${native.helperVersion ? ` · helper ${native.helperVersion}` : ''}`
		: 'Permission inspection unavailable';
}

function nativeAdvancedDetail(
	definition: CapabilityDefinition,
	native: SimulatorNativeState
): string | undefined {
	const advanced = native.advanced;
	if (!definition.nativeCapability || !advanced) return undefined;
	if (definition.nativeCapability === 'live-window') {
		return `${advanced.screenCaptureKit.liveWindowCapture} API · ${advanced.screenCaptureKit.screenRecordingPermission.replaceAll('_', ' ')} permission · ${advanced.screenCaptureKit.requestableFrameRates.join('/')} FPS probe · persistent provider ${native.liveCaptureSessions ? 'available' : 'deferred'}`;
	}
	if (definition.nativeCapability === 'system-audio') {
		return `system ${advanced.screenCaptureKit.systemAudioCapture} API · microphone ${advanced.screenCaptureKit.microphoneCapture} · persistent provider ${native.liveCaptureSessions ? 'available' : 'deferred'}`;
	}
	if (definition.nativeCapability === 'hardware-video') {
		return `${advanced.videoToolbox.codecs
			.map(
				(codec) =>
					`${codec.id.toUpperCase()} ${codec.hardwareEncodeSupported ? 'hardware' : 'software'} · ${codec.acceptedRealtimeConfigurationFrameRates.join('/')} FPS`
			)
			.join(
				' · '
			)} · persistent provider ${native.liveCaptureSessions ? 'available' : 'deferred'}`;
	}
	if (definition.nativeCapability === 'image-composition') {
		return native.imageComposition
			? 'available · signed helper · atomic local outputs · no paths exposed'
			: 'unavailable in this desktop build';
	}
	return `${advanced.networkExtension.trafficInterception} · entitlement ${advanced.networkExtension.entitlementPresent ? 'present' : 'missing'} · no preferences read`;
}

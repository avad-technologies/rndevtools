import { Button } from '@heroui/react/button';
import { Input } from '@heroui/react/input';
import { Switch } from '@heroui/react/switch';
import { NativeSelect } from '@heroui-pro/react/native-select';
import {
	Accessibility,
	Bell,
	ChevronDown,
	Clipboard,
	CloudSun,
	Command,
	Download,
	ExternalLink,
	FolderOpen,
	KeyRound,
	Link,
	MapPin,
	Moon,
	Navigation,
	Play,
	RefreshCw,
	RotateCw,
	ShieldCheck,
	Sun,
	Trash2,
	Type,
	Upload,
} from 'lucide-react';
import { type ComponentType, useEffect, useId, useMemo, useState } from 'react';
import { InfoPopover, PanelHeader } from '@/components/ui';
import { targetConfig } from '@/simulator/target-config';
import type { SimulatorCapability } from '../../../shared/simulator-protocol';
import {
	BridgeUnavailableNotice,
	DenseVirtualList,
	SimulatorTargetSelect,
} from '../../components/simulator-ui';
import { Badge, SearchControl, Toolbar } from '../../components/ui';
import {
	type SimulatorActionInput,
	useSimulatorRuntime,
} from '../../state/simulator-runtime';

type ActionCategory = 'App' | 'Environment' | 'Data' | 'Accessibility';

type AppActionDefinition = {
	id: string;
	label: string;
	description: string;
	category: ActionCategory;
	icon: ComponentType<{ className?: string }>;
	config:
		| 'url'
		| 'location'
		| 'launch'
		| 'text'
		| 'permission'
		| 'dynamic-type'
		| 'none';
	feature?: keyof SimulatorCapability['features'];
};

const APP_ACTIONS: AppActionDefinition[] = [
	{
		id: 'install-app',
		label: 'Install .app bundle',
		description:
			'Choose a local Simulator .app bundle through a native file dialog.',
		category: 'App',
		icon: Download,
		config: 'none',
		feature: 'apps',
	},
	{
		id: 'refresh-apps',
		label: 'Refresh installed apps',
		description: 'Reload installed application metadata for the exact target.',
		category: 'App',
		icon: RefreshCw,
		config: 'none',
		feature: 'apps',
	},
	{
		id: 'launch-app',
		label: 'Launch app',
		description:
			'Launch the selected app with optional locale and debug controls.',
		category: 'App',
		icon: Play,
		config: 'launch',
		feature: 'apps',
	},
	{
		id: 'relaunch-app',
		label: 'Relaunch app',
		description:
			'Terminate and launch the selected app with the same overrides.',
		category: 'App',
		icon: RotateCw,
		config: 'launch',
		feature: 'apps',
	},
	{
		id: 'open-deep-link',
		label: 'Open deep link',
		description: 'Launch a universal link or registered app URL scheme.',
		category: 'App',
		icon: Link,
		config: 'url',
		feature: 'deepLinks',
	},
	{
		id: 'open-universal-link',
		label: 'Open universal link',
		description: 'Route an HTTPS URL through associated domains.',
		category: 'App',
		icon: ExternalLink,
		config: 'url',
		feature: 'deepLinks',
	},
	{
		id: 'send-push-notification',
		label: 'Push notification',
		description: 'Deliver an APNs payload to an installed app.',
		category: 'App',
		icon: Bell,
		config: 'text',
		feature: 'push',
	},
	{
		id: 'terminate-app',
		label: 'Terminate app',
		description:
			'End the selected app process without shutting down the target.',
		category: 'App',
		icon: Command,
		config: 'none',
		feature: 'apps',
	},
	{
		id: 'uninstall-app',
		label: 'Uninstall app',
		description:
			'Remove the selected app and its local data after confirmation.',
		category: 'App',
		icon: Trash2,
		config: 'none',
		feature: 'apps',
	},
	{
		id: 'reveal-app-container',
		label: 'Reveal app bundle',
		description: 'Reveal the verified app container in Finder.',
		category: 'Data',
		icon: FolderOpen,
		config: 'none',
		feature: 'apps',
	},
	{
		id: 'reveal-data-container',
		label: 'Reveal app data',
		description: 'Reveal the verified data container in Finder.',
		category: 'Data',
		icon: FolderOpen,
		config: 'none',
		feature: 'apps',
	},
	{
		id: 'reveal-group-containers',
		label: 'Reveal group containers',
		description:
			'Reveal the selected app’s verified group-container directory.',
		category: 'Data',
		icon: FolderOpen,
		config: 'none',
		feature: 'apps',
	},
	{
		id: 'reveal-app-group',
		label: 'Reveal App Group',
		description:
			'Reveal one exact App Group container after native path verification.',
		category: 'Data',
		icon: FolderOpen,
		config: 'text',
		feature: 'apps',
	},
	{
		id: 'set-location',
		label: 'Set location',
		description: 'Apply a coordinate or repeatable route preset.',
		category: 'Environment',
		icon: MapPin,
		config: 'location',
		feature: 'location',
	},
	{
		id: 'simulate-route',
		label: 'Built-in route',
		description: 'Replay a deterministic waypoint route against Core Location.',
		category: 'Environment',
		icon: Navigation,
		config: 'location',
		feature: 'location',
	},
	{
		id: 'import-gpx-route',
		label: 'Import GPX route',
		description:
			'Choose and stream a bounded GPX route through the native dialog.',
		category: 'Environment',
		icon: Upload,
		config: 'none',
		feature: 'location',
	},
	{
		id: 'clear-location',
		label: 'Clear simulated location',
		description: 'Restore the target’s default Core Location behavior.',
		category: 'Environment',
		icon: MapPin,
		config: 'none',
		feature: 'location',
	},
	{
		id: 'set-appearance-light',
		label: 'Light appearance',
		description: 'Override the target interface style to light.',
		category: 'Environment',
		icon: Sun,
		config: 'none',
		feature: 'ui',
	},
	{
		id: 'set-appearance-dark',
		label: 'Dark appearance',
		description: 'Override the target interface style to dark.',
		category: 'Environment',
		icon: Moon,
		config: 'none',
		feature: 'ui',
	},
	{
		id: 'override-status-bar',
		label: 'Status bar preset',
		description: 'Normalize time, network, battery, and carrier values.',
		category: 'Environment',
		icon: CloudSun,
		config: 'none',
		feature: 'statusBar',
	},
	{
		id: 'clear-status-bar',
		label: 'Clear status bar overrides',
		description: 'Restore Simulator-managed status-bar values.',
		category: 'Environment',
		icon: CloudSun,
		config: 'none',
		feature: 'statusBar',
	},
	{
		id: 'set-dynamic-type',
		label: 'Dynamic Type',
		description: 'Apply a content-size category to the target.',
		category: 'Environment',
		icon: Type,
		config: 'dynamic-type',
		feature: 'ui',
	},
	{
		id: 'increase-contrast',
		label: 'Increase Contrast',
		description: 'Enable the Simulator accessibility contrast setting.',
		category: 'Accessibility',
		icon: Accessibility,
		config: 'none',
		feature: 'ui',
	},
	{
		id: 'decrease-contrast',
		label: 'Standard Contrast',
		description: 'Disable the Simulator accessibility contrast override.',
		category: 'Accessibility',
		icon: Accessibility,
		config: 'none',
		feature: 'ui',
	},
	{
		id: 'pasteboard-to-simulator',
		label: 'Paste into simulator',
		description:
			'Synchronize the host pasteboard into the exact Simulator target.',
		category: 'Data',
		icon: Clipboard,
		config: 'none',
		feature: 'apps',
	},
	{
		id: 'pasteboard-from-simulator',
		label: 'Copy from simulator',
		description: 'Synchronize the exact Simulator pasteboard back to the host.',
		category: 'Data',
		icon: Clipboard,
		config: 'none',
		feature: 'apps',
	},
	{
		id: 'add-root-certificate',
		label: 'Add trusted certificate',
		description:
			'Choose a bounded certificate and add it to the Simulator keychain.',
		category: 'Data',
		icon: KeyRound,
		config: 'none',
		feature: 'keychain',
	},
	{
		id: 'reset-keychain',
		label: 'Reset keychain',
		description:
			'Remove all Simulator keychain entries after native confirmation.',
		category: 'Data',
		icon: KeyRound,
		config: 'none',
		feature: 'keychain',
	},
	{
		id: 'grant-permission',
		label: 'Grant app permission',
		description: 'Grant one scoped TCC permission to an installed app.',
		category: 'Accessibility',
		icon: ShieldCheck,
		config: 'permission',
		feature: 'privacy',
	},
	{
		id: 'revoke-permission',
		label: 'Revoke app permission',
		description: 'Revoke one scoped TCC permission from the selected app.',
		category: 'Accessibility',
		icon: ShieldCheck,
		config: 'permission',
		feature: 'privacy',
	},
	{
		id: 'reset-permission',
		label: 'Reset app permission state',
		description:
			'Reset one TCC permission for the selected installed app after native confirmation.',
		category: 'Accessibility',
		icon: ShieldCheck,
		config: 'permission',
		feature: 'privacy',
	},
];

const ACTION_CATEGORIES: Array<ActionCategory | 'All'> = [
	'All',
	'App',
	'Environment',
	'Data',
	'Accessibility',
];

export function AppActionsPanel() {
	const { isBridgeAvailable, runAction, selectedDevice, state } =
		useSimulatorRuntime();
	const [query, setQuery] = useState('');
	const [category, setCategory] = useState<ActionCategory | 'All'>('All');
	const [selectedActionId, setSelectedActionId] = useState(
		APP_ACTIONS[0]?.id ?? ''
	);
	const [selectedBundleIdentifier, setSelectedBundleIdentifier] = useState('');
	const normalizedQuery = query.trim().toLowerCase();
	const actions = useMemo(
		() =>
			APP_ACTIONS.filter((action) => {
				const matchesCategory =
					category === 'All' || action.category === category;
				const matchesQuery =
					normalizedQuery.length === 0 ||
					`${action.label} ${action.description} ${action.category}`
						.toLowerCase()
						.includes(normalizedQuery);
				return matchesCategory && matchesQuery;
			}),
		[category, normalizedQuery]
	);
	const selectedAction =
		APP_ACTIONS.find((action) => action.id === selectedActionId) ??
		APP_ACTIONS[0];
	const installedApps = useMemo(
		() =>
			selectedDevice
				? (state.appsByDevice[selectedDevice.udid] ?? []).filter(
						(app) => !app.isSystem
					)
				: [],
		[selectedDevice, state.appsByDevice]
	);
	useEffect(() => {
		if (
			installedApps.some(
				(app) => app.bundleIdentifier === selectedBundleIdentifier
			)
		) {
			return;
		}
		setSelectedBundleIdentifier(installedApps[0]?.bundleIdentifier ?? '');
	}, [installedApps, selectedBundleIdentifier]);

	return (
		<section className="panel-root">
			<PanelHeader
				actions={<SimulatorTargetSelect />}
				description="Compose safe, explicit simulator commands without adding debug code to the mobile app. Semantic input is capability-gated and always visible in the action receipt."
				meta={`${APP_ACTIONS.length} actions`}
				title="App Actions"
			/>
			<BridgeUnavailableNotice />
			<Toolbar>
				<SearchControl
					ariaLabel="Search Simulator actions"
					placeholder="Search actions"
					value={query}
					onChange={setQuery}
				/>
				<NativeSelect className="sim-filter-select" fullWidth={false}>
					<NativeSelect.Trigger
						aria-label="Filter action category"
						value={category}
						onChange={(event) =>
							setCategory(event.currentTarget.value as ActionCategory | 'All')
						}
					>
						{ACTION_CATEGORIES.map((option) => (
							<NativeSelect.Option key={option} value={option}>
								{option}
							</NativeSelect.Option>
						))}
						<NativeSelect.Indicator>
							<ChevronDown className="h-3 w-3" />
						</NativeSelect.Indicator>
					</NativeSelect.Trigger>
				</NativeSelect>
				<NativeSelect className="sim-filter-select" fullWidth={false}>
					<NativeSelect.Trigger
						aria-label="Select installed application"
						disabled={installedApps.length === 0}
						value={selectedBundleIdentifier}
						onChange={(event) =>
							setSelectedBundleIdentifier(event.currentTarget.value)
						}
					>
						{installedApps.length === 0 ? (
							<NativeSelect.Option value="">No app loaded</NativeSelect.Option>
						) : (
							installedApps.map((app) => (
								<NativeSelect.Option
									key={app.bundleIdentifier}
									value={app.bundleIdentifier}
								>
									{app.displayName}
								</NativeSelect.Option>
							))
						)}
						<NativeSelect.Indicator>
							<ChevronDown className="h-3 w-3" />
						</NativeSelect.Indicator>
					</NativeSelect.Trigger>
				</NativeSelect>
				<span className="sim-toolbar-meta">
					{selectedDevice ? selectedDevice.name : 'Select a booted target'}
				</span>
			</Toolbar>
			<div className="sim-action-layout">
				<div className="sim-list-pane">
					<DenseVirtualList
						ariaLabel="Simulator app actions"
						emptyDescription="Try a broader search or choose another category."
						emptyTitle="No actions match"
						items={actions}
						getId={(action) => action.id}
						rowHeight={62}
						selectedId={selectedAction?.id}
						textValue={(action) => action.label}
						onSelect={(action) => setSelectedActionId(action.id)}
						renderItem={(action) => {
							const Icon = action.icon;
							return (
								<>
									<div className="sim-list-leading">
										<Icon className="h-3.5 w-3.5" />
									</div>
									<div className="sim-list-copy">
										<strong>{action.label}</strong>
										<span>{action.description}</span>
									</div>
									<Badge tone={actionCategoryTone(action.category)}>
										{action.category}
									</Badge>
								</>
							);
						}}
					/>
				</div>
				<div className="sim-detail-pane panel-scroll">
					{selectedAction ? (
						<ActionWorkbench
							key={selectedAction.id}
							action={selectedAction}
							bundleIdentifier={selectedBundleIdentifier || undefined}
							featureAvailable={
								selectedAction.feature
									? state.capability.features[selectedAction.feature]
									: false
							}
							isRuntimeReady={Boolean(
								isBridgeAvailable && selectedDevice?.state === 'booted'
							)}
							targetName={selectedDevice?.name}
							targetUdid={selectedDevice?.udid}
							onRun={(actionInput) =>
								void runAction(actionInput, {
									successMessage: `${selectedAction.label} was submitted.`,
								})
							}
						/>
					) : null}
				</div>
			</div>
		</section>
	);
}

function ActionWorkbench({
	action,
	isRuntimeReady,
	featureAvailable,
	targetUdid,
	targetName,
	bundleIdentifier,
	onRun,
}: {
	action: AppActionDefinition;
	isRuntimeReady: boolean;
	featureAvailable: boolean;
	targetUdid: string | undefined;
	targetName: string | undefined;
	bundleIdentifier: string | undefined;
	onRun: (action: SimulatorActionInput) => void;
}) {
	const Icon = action.icon;
	const reasonId = useId();
	const [value, setValue] = useState('');
	const [preset, setPreset] = useState(() => defaultPreset(action.config));
	const [locale, setLocale] = useState('');
	const [languages, setLanguages] = useState('');
	const [timeZone, setTimeZone] = useState('');
	const [slowAnimations, setSlowAnimations] = useState(false);
	const [customLatitude, setCustomLatitude] = useState('');
	const [customLongitude, setCustomLongitude] = useState('');
	const actionInput = useMemo(
		() =>
			buildSimulatorAction({
				actionId: action.id,
				bundleIdentifier,
				customLatitude,
				customLongitude,
				languages,
				locale,
				preset,
				slowAnimations,
				targetUdid,
				timeZone,
				value,
			}),
		[
			action,
			bundleIdentifier,
			customLatitude,
			customLongitude,
			languages,
			locale,
			preset,
			slowAnimations,
			targetUdid,
			timeZone,
			value,
		]
	);
	const canRun = isRuntimeReady && featureAvailable && actionInput !== null;
	return (
		<div className="sim-workbench">
			<div className="sim-workbench-icon">
				<Icon className="h-5 w-5 text-(--brand-text)" />
			</div>
			<p className="sim-eyebrow">{action.category} action</p>
			<div className="panel-heading">
				<h2>{action.label}</h2>
				<InfoPopover label={action.label}>{action.description}</InfoPopover>
			</div>
			<div className="sim-form-stack">
				<ActionConfiguration
					action={action}
					customLatitude={customLatitude}
					customLongitude={customLongitude}
					languages={languages}
					locale={locale}
					preset={preset}
					setLanguages={setLanguages}
					setLocale={setLocale}
					setCustomLatitude={setCustomLatitude}
					setCustomLongitude={setCustomLongitude}
					setPreset={setPreset}
					setSlowAnimations={setSlowAnimations}
					setTimeZone={setTimeZone}
					setValue={setValue}
					slowAnimations={slowAnimations}
					timeZone={timeZone}
					value={value}
				/>
			</div>
			{!featureAvailable ? (
				<div className="sim-inline-note is-warning">
					<Command className="h-3.5 w-3.5" />
					This action is visible for planning, but the current native provider
					does not expose it yet.
				</div>
			) : null}
			{action.config === 'permission' && !bundleIdentifier ? (
				<div className="sim-inline-note is-warning">
					<ShieldCheck className="h-3.5 w-3.5" />
					Select an installed app. Permission grant, revoke, and reset never
					apply to all apps.
				</div>
			) : null}
			<div className="sim-run-footer">
				<div>
					<strong>{targetName ?? 'No target selected'}</strong>
					<span id={reasonId}>
						{canRun
							? 'Booted and ready'
							: actionInput
								? 'Choose a booted target to run'
								: 'Complete the required action fields'}
					</span>
				</div>
				<Button
					{...(canRun ? {} : { 'aria-describedby': reasonId })}
					isDisabled={!canRun}
					size="sm"
					variant="primary"
					onPress={() => {
						if (actionInput) onRun(actionInput);
					}}
				>
					<Command className="h-3.5 w-3.5" /> {action.label}
				</Button>
			</div>
		</div>
	);
}

export function actionCategoryTone(
	category: ActionCategory
): 'brand' | 'info' | 'warning' | 'default' {
	switch (category) {
		case 'App':
			return 'brand';
		case 'Environment':
			return 'info';
		case 'Accessibility':
			return 'warning';
		default:
			return 'default';
	}
}

export function defaultPreset(config: AppActionDefinition['config']): string {
	if (config === 'permission') return 'microphone';
	if (config === 'dynamic-type') return 'large';
	return 'apple-park';
}

function ActionConfiguration({
	action,
	value,
	setValue,
	preset,
	setPreset,
	customLatitude,
	setCustomLatitude,
	customLongitude,
	setCustomLongitude,
	locale,
	setLocale,
	languages,
	setLanguages,
	timeZone,
	setTimeZone,
	slowAnimations,
	setSlowAnimations,
}: {
	action: AppActionDefinition;
	value: string;
	setValue: (value: string) => void;
	preset: string;
	setPreset: (preset: string) => void;
	customLatitude: string;
	setCustomLatitude: (latitude: string) => void;
	customLongitude: string;
	setCustomLongitude: (longitude: string) => void;
	locale: string;
	setLocale: (locale: string) => void;
	languages: string;
	setLanguages: (languages: string) => void;
	timeZone: string;
	setTimeZone: (timeZone: string) => void;
	slowAnimations: boolean;
	setSlowAnimations: (slowAnimations: boolean) => void;
}) {
	if (action.config === 'none') {
		return (
			<div className="sim-inline-note">
				<RotateCw className="h-3.5 w-3.5" />
				This action is ready with its safe default configuration.
			</div>
		);
	}
	if (action.config === 'launch') {
		return (
			<>
				<div className="sim-field">
					<span>Locale</span>
					<Input
						aria-label="App locale override"
						placeholder="en_US (optional)"
						value={locale}
						onChange={(event) => setLocale(event.currentTarget.value)}
					/>
				</div>
				<div className="sim-field">
					<span>Languages</span>
					<Input
						aria-label="App language overrides"
						placeholder="en, fr-CA (optional)"
						value={languages}
						onChange={(event) => setLanguages(event.currentTarget.value)}
					/>
				</div>
				<div className="sim-field">
					<span>Time zone</span>
					<Input
						aria-label="App time-zone override"
						placeholder="America/Los_Angeles (optional)"
						value={timeZone}
						onChange={(event) => setTimeZone(event.currentTarget.value)}
					/>
				</div>
				<Switch
					isSelected={slowAnimations}
					size="sm"
					onChange={setSlowAnimations}
				>
					<Switch.Content>
						<span className="sim-switch-copy">
							<strong>Slow app animations</strong>
							<small>Development-only app environment control.</small>
						</span>
					</Switch.Content>
					<Switch.Control>
						<Switch.Thumb />
					</Switch.Control>
				</Switch>
			</>
		);
	}
	if (action.config === 'location') {
		const customCoordinate = parseCustomCoordinate(
			customLatitude,
			customLongitude
		);
		const hasCustomInput =
			customLatitude.trim().length > 0 || customLongitude.trim().length > 0;
		return (
			<>
				<div className="sim-field">
					<span>Location preset</span>
					<NativeSelect fullWidth>
						<NativeSelect.Trigger
							aria-label="Location preset"
							value={preset}
							onChange={(event) => setPreset(event.currentTarget.value)}
						>
							<NativeSelect.Option value="apple-park">
								Apple Park
							</NativeSelect.Option>
							<NativeSelect.Option value="san-francisco">
								San Francisco
							</NativeSelect.Option>
							<NativeSelect.Option value="new-york">
								New York
							</NativeSelect.Option>
							<NativeSelect.Option value="custom">
								Custom coordinate
							</NativeSelect.Option>
							<NativeSelect.Indicator>
								<ChevronDown className="h-3 w-3" />
							</NativeSelect.Indicator>
						</NativeSelect.Trigger>
					</NativeSelect>
				</div>
				{preset === 'custom' ? (
					<>
						<div className="sim-coordinate-fields">
							<div className="sim-field">
								<span>Latitude</span>
								<Input
									aria-label="Custom latitude"
									aria-invalid={hasCustomInput && customCoordinate === null}
									max={90}
									min={-90}
									placeholder="-90 to 90"
									step="any"
									type="number"
									value={customLatitude}
									onChange={(event) =>
										setCustomLatitude(event.currentTarget.value)
									}
								/>
							</div>
							<div className="sim-field">
								<span>Longitude</span>
								<Input
									aria-label="Custom longitude"
									aria-invalid={hasCustomInput && customCoordinate === null}
									max={180}
									min={-180}
									placeholder="-180 to 180"
									step="any"
									type="number"
									value={customLongitude}
									onChange={(event) =>
										setCustomLongitude(event.currentTarget.value)
									}
								/>
							</div>
						</div>
						{hasCustomInput && customCoordinate === null ? (
							<p className="sim-field-error" role="alert">
								Enter a finite latitude from −90 to 90 and longitude from −180
								to 180.
							</p>
						) : (
							<p className="sim-field-help">
								Both values are required. Routes begin at this exact coordinate.
							</p>
						)}
					</>
				) : null}
			</>
		);
	}
	if (action.config === 'permission') {
		return (
			<div className="sim-field">
				<span>Scoped permission</span>
				<NativeSelect fullWidth>
					<NativeSelect.Trigger
						aria-label="Scoped app permission"
						value={preset}
						onChange={(event) => setPreset(event.currentTarget.value)}
					>
						<NativeSelect.Option value="microphone">
							Microphone
						</NativeSelect.Option>
						<NativeSelect.Option value="photos">Photos</NativeSelect.Option>
						<NativeSelect.Option value="location">Location</NativeSelect.Option>
						<NativeSelect.Option value="calendar">Calendar</NativeSelect.Option>
						<NativeSelect.Indicator>
							<ChevronDown className="h-3 w-3" />
						</NativeSelect.Indicator>
					</NativeSelect.Trigger>
				</NativeSelect>
			</div>
		);
	}
	if (action.config === 'dynamic-type') {
		return (
			<div className="sim-field">
				<span>Content size</span>
				<NativeSelect fullWidth>
					<NativeSelect.Trigger
						aria-label="Dynamic Type content size"
						value={preset}
						onChange={(event) => setPreset(event.currentTarget.value)}
					>
						{[
							['medium', 'Medium'],
							['large', 'Large'],
							['extra-extra-extra-large', 'XXXL'],
							['accessibility-large', 'Accessibility Large'],
							['accessibility-extra-extra-extra-large', 'Accessibility XXXL'],
						].map(([option, label]) => (
							<NativeSelect.Option key={option} value={option}>
								{label}
							</NativeSelect.Option>
						))}
						<NativeSelect.Indicator>
							<ChevronDown className="h-3 w-3" />
						</NativeSelect.Indicator>
					</NativeSelect.Trigger>
				</NativeSelect>
			</div>
		);
	}
	const isUrl = action.config === 'url';
	const trimmedValue = value.trim();
	const isInvalidUrl =
		isUrl &&
		trimmedValue.length > 0 &&
		(action.id === 'open-universal-link'
			? !isValidHttpsUrl(trimmedValue)
			: !isValidUrl(trimmedValue));
	const placeholder = isUrl
		? targetConfig.deepLinkExample
		: action.id === 'send-push-notification'
			? '{"aps":{"alert":"Hello"}}'
			: action.id === 'reveal-app-group'
				? targetConfig.appGroupExample
				: 'Enter deterministic input';
	return (
		<>
			<div className="sim-field">
				<span>{isUrl ? 'URL' : 'Value'}</span>
				<Input
					aria-label={isUrl ? 'Action URL' : 'Action value'}
					aria-invalid={isInvalidUrl}
					placeholder={placeholder}
					value={value}
					onChange={(event) => setValue(event.currentTarget.value)}
				/>
			</div>
			{isInvalidUrl ? (
				<p className="sim-field-error" role="alert">
					{action.id === 'open-universal-link'
						? 'Universal links require an https:// URL.'
						: 'Enter a safe, absolute app or web URL.'}
				</p>
			) : null}
		</>
	);
}

export function buildSimulatorAction({
	actionId,
	targetUdid,
	bundleIdentifier,
	value,
	preset,
	customLatitude,
	customLongitude,
	locale,
	languages,
	timeZone,
	slowAnimations,
}: {
	actionId: string;
	targetUdid: string | undefined;
	bundleIdentifier: string | undefined;
	value: string;
	preset: string;
	customLatitude: string;
	customLongitude: string;
	locale: string;
	languages: string;
	timeZone: string;
	slowAnimations: boolean;
}): SimulatorActionInput | null {
	if (!targetUdid) return null;
	const trimmedValue = value.trim();
	switch (actionId) {
		case 'install-app':
			return { kind: 'app.install', udid: targetUdid };
		case 'refresh-apps':
			return { kind: 'app.list', udid: targetUdid };
		case 'launch-app':
		case 'relaunch-app': {
			if (!bundleIdentifier) return null;
			const localeValue = locale.trim();
			const timeZoneValue = timeZone.trim();
			const languageList = languages
				.split(',')
				.map((language) => language.trim())
				.filter(Boolean);
			if (
				(localeValue && !isValidLocale(localeValue)) ||
				languageList.length > 10 ||
				languageList.some((language) => !isValidLanguage(language)) ||
				(timeZoneValue && !isValidTimeZone(timeZoneValue))
			) {
				return null;
			}
			return {
				kind: 'app.launch',
				udid: targetUdid,
				bundleIdentifier,
				terminateRunning: actionId === 'relaunch-app',
				arguments: [],
				...(localeValue ? { locale: localeValue } : {}),
				...(languageList.length > 0 ? { languages: languageList } : {}),
				...(timeZoneValue ? { timeZone: timeZoneValue } : {}),
				...(slowAnimations ? { slowAnimations: true } : {}),
			};
		}
		case 'open-deep-link':
			return isValidUrl(trimmedValue)
				? { kind: 'url.open', udid: targetUdid, url: trimmedValue }
				: null;
		case 'open-universal-link':
			return isValidHttpsUrl(trimmedValue)
				? { kind: 'app.openUniversalLink', udid: targetUdid, url: trimmedValue }
				: null;
		case 'send-push-notification':
			return bundleIdentifier && isJsonObject(trimmedValue)
				? {
						kind: 'push.send',
						udid: targetUdid,
						bundleIdentifier,
						payloadJson: trimmedValue,
					}
				: null;
		case 'terminate-app':
			return bundleIdentifier
				? { kind: 'app.terminate', udid: targetUdid, bundleIdentifier }
				: null;
		case 'uninstall-app':
			return bundleIdentifier
				? { kind: 'app.uninstall', udid: targetUdid, bundleIdentifier }
				: null;
		case 'reveal-app-container':
		case 'reveal-data-container':
		case 'reveal-group-containers':
			return bundleIdentifier
				? {
						kind: 'app.revealContainer',
						udid: targetUdid,
						bundleIdentifier,
						container:
							actionId === 'reveal-app-container'
								? 'app'
								: actionId === 'reveal-data-container'
									? 'data'
									: 'groups',
					}
				: null;
		case 'reveal-app-group':
			return bundleIdentifier && isValidBundleIdentifier(trimmedValue)
				? {
						kind: 'app.revealContainer',
						udid: targetUdid,
						bundleIdentifier,
						container: 'app-group',
						appGroupIdentifier: trimmedValue,
					}
				: null;
		case 'set-location': {
			const coordinate = locationCoordinate(
				preset,
				customLatitude,
				customLongitude
			);
			return coordinate
				? { kind: 'location.set', udid: targetUdid, ...coordinate }
				: null;
		}
		case 'simulate-route': {
			const waypoints = routeWaypoints(preset, customLatitude, customLongitude);
			return waypoints
				? {
						kind: 'location.start',
						udid: targetUdid,
						waypoints,
						intervalSeconds: 2,
					}
				: null;
		}
		case 'import-gpx-route':
			return { kind: 'location.importGpx', udid: targetUdid };
		case 'clear-location':
			return { kind: 'location.clear', udid: targetUdid };
		case 'set-appearance-light':
			return {
				kind: 'ui.update',
				udid: targetUdid,
				setting: 'appearance',
				value: 'light',
			};
		case 'set-appearance-dark':
			return {
				kind: 'ui.update',
				udid: targetUdid,
				setting: 'appearance',
				value: 'dark',
			};
		case 'override-status-bar':
			return {
				kind: 'statusBar.override',
				udid: targetUdid,
				overrides: {
					time: '9:41',
					dataNetwork: 'wifi',
					wifiBars: 3,
					batteryState: 'charged',
					batteryLevel: 100,
				},
			};
		case 'clear-status-bar':
			return { kind: 'statusBar.clear', udid: targetUdid };
		case 'set-dynamic-type':
			return {
				kind: 'ui.update',
				udid: targetUdid,
				setting: 'content_size',
				value: dynamicTypeValue(preset),
			};
		case 'increase-contrast':
		case 'decrease-contrast':
			return {
				kind: 'ui.update',
				udid: targetUdid,
				setting: 'increase_contrast',
				value: actionId === 'increase-contrast' ? 'enabled' : 'disabled',
			};
		case 'pasteboard-to-simulator':
		case 'pasteboard-from-simulator':
			return {
				kind: 'pasteboard.sync',
				udid: targetUdid,
				direction:
					actionId === 'pasteboard-to-simulator'
						? 'host-to-simulator'
						: 'simulator-to-host',
			};
		case 'add-root-certificate':
			return {
				kind: 'keychain.addCertificate',
				udid: targetUdid,
				trustRoot: true,
			};
		case 'reset-keychain':
			return { kind: 'keychain.reset', udid: targetUdid };
		case 'grant-permission':
		case 'revoke-permission':
		case 'reset-permission':
			return bundleIdentifier
				? {
						kind: 'privacy.update',
						udid: targetUdid,
						operation:
							actionId === 'grant-permission'
								? 'grant'
								: actionId === 'revoke-permission'
									? 'revoke'
									: 'reset',
						service: preset as
							| 'microphone'
							| 'photos'
							| 'location'
							| 'calendar',
						bundleIdentifier,
					}
				: null;
		default:
			return null;
	}
}

function isValidTimeZone(value: string): boolean {
	return (
		value.length <= 128 &&
		/^[A-Za-z0-9][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9][A-Za-z0-9._+-]*){0,3}$/.test(
			value
		) &&
		value.split('/').every((segment) => segment !== '.' && segment !== '..')
	);
}

function isValidLocale(value: string): boolean {
	const segments = value.split(/[-_]/);
	const language = segments.shift();
	return Boolean(
		language &&
			language.length >= 2 &&
			language.length <= 3 &&
			/^[A-Za-z]+$/.test(language) &&
			segments.every(
				(segment) =>
					segment.length >= 2 &&
					segment.length <= 8 &&
					/^[A-Za-z0-9]+$/.test(segment)
			)
	);
}

function isValidLanguage(value: string): boolean {
	return !value.includes('_') && isValidLocale(value);
}

function isValidBundleIdentifier(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 255 &&
		/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(value)
	);
}

function dynamicTypeValue(
	value: string
): Extract<SimulatorActionInput, { kind: 'ui.update' }>['value'] {
	if (
		value === 'medium' ||
		value === 'large' ||
		value === 'extra-extra-extra-large' ||
		value === 'accessibility-large' ||
		value === 'accessibility-extra-extra-extra-large'
	) {
		return value;
	}
	return 'large';
}

type LocationCoordinate = { latitude: number; longitude: number };

export function parseCustomCoordinate(
	latitudeText: string,
	longitudeText: string
): LocationCoordinate | null {
	const latitudeValue = latitudeText.trim();
	const longitudeValue = longitudeText.trim();
	if (
		latitudeValue.length === 0 ||
		longitudeValue.length === 0 ||
		latitudeValue.length > 32 ||
		longitudeValue.length > 32
	) {
		return null;
	}
	const latitude = Number(latitudeValue);
	const longitude = Number(longitudeValue);
	if (
		!Number.isFinite(latitude) ||
		!Number.isFinite(longitude) ||
		latitude < -90 ||
		latitude > 90 ||
		longitude < -180 ||
		longitude > 180
	) {
		return null;
	}
	return { latitude, longitude };
}

function locationCoordinate(
	preset: string,
	customLatitude: string,
	customLongitude: string
): LocationCoordinate | null {
	if (preset === 'custom') {
		return parseCustomCoordinate(customLatitude, customLongitude);
	}
	if (preset === 'apple-park')
		return { latitude: 37.3349, longitude: -122.009 };
	if (preset === 'san-francisco')
		return { latitude: 37.7749, longitude: -122.4194 };
	if (preset === 'new-york') return { latitude: 40.7128, longitude: -74.006 };
	return null;
}

function routeWaypoints(
	preset: string,
	customLatitude: string,
	customLongitude: string
): LocationCoordinate[] | null {
	const origin = locationCoordinate(preset, customLatitude, customLongitude);
	if (!origin) return null;
	const latitudeDirection = origin.latitude <= 89.992 ? 1 : -1;
	const longitudeDirection = origin.longitude <= 179.992 ? 1 : -1;
	return [
		origin,
		{
			latitude: origin.latitude + 0.004 * latitudeDirection,
			longitude: origin.longitude + 0.004 * longitudeDirection,
		},
		{
			latitude: origin.latitude + 0.008 * latitudeDirection,
			longitude: origin.longitude + 0.008 * longitudeDirection,
		},
	];
}

function isValidUrl(value: string): boolean {
	if (value.length === 0) return false;
	try {
		const protocol = new URL(value).protocol.toLowerCase();
		return ![
			'about:',
			'blob:',
			'data:',
			'file:',
			'javascript:',
			'vbscript:',
		].includes(protocol);
	} catch {
		return false;
	}
}

function isValidHttpsUrl(value: string): boolean {
	if (!isValidUrl(value)) return false;
	try {
		return new URL(value).protocol.toLowerCase() === 'https:';
	} catch {
		return false;
	}
}

function isJsonObject(value: string): boolean {
	if (
		value.length === 0 ||
		new TextEncoder().encode(value).byteLength > 4_096
	) {
		return false;
	}
	try {
		const parsed: unknown = JSON.parse(value);
		if (
			typeof parsed !== 'object' ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			return false;
		}
		const aps = Object.getOwnPropertyDescriptor(parsed, 'aps');
		return Boolean(
			aps &&
				'value' in aps &&
				typeof aps.value === 'object' &&
				aps.value !== null &&
				!Array.isArray(aps.value)
		);
	} catch {
		return false;
	}
}

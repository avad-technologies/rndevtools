import { Input } from '@heroui/react/input';
import { Switch } from '@heroui/react/switch';
import { TextArea } from '@heroui/react/textarea';
import { NativeSelect } from '@heroui-pro/react/native-select';
import {
	AlertTriangle,
	ChevronDown,
	FileImage,
	FileVideo,
	Upload,
} from 'lucide-react';
import { useId, useState } from 'react';
import {
	assertFixtureSize,
	IMAGE_MIME_TYPES,
	inspectImageFixture,
	inspectVideoFixture,
	readFixtureBase64,
	VIDEO_MIME_TYPES,
} from '@/lib/camera-fixture-file';
import {
	createAssertion,
	createCameraFixture,
	createSemanticAction,
	createSimulatorAction,
	createWaitForCondition,
	issuesForPath,
	type RecipeValidationIssue,
} from '@/simulator/recipe-model';
import type { RecipeStep } from '../../shared/recipe-protocol';

type SimulatorStep = Extract<RecipeStep, { kind: 'simulator' }>;
type SimulatorAction = SimulatorStep['action'];
type AppLaunchAction = Extract<SimulatorAction, { operation: 'app.launch' }>;
type LocationRouteAction = Extract<
	SimulatorAction,
	{ operation: 'location.start' }
>;
type PrivacyAction = Extract<SimulatorAction, { operation: 'privacy.update' }>;
type UiUpdateAction = Extract<SimulatorAction, { operation: 'ui.update' }>;
type StatusBarAction = Extract<
	SimulatorAction,
	{ operation: 'statusBar.override' }
>;
type SemanticStep = Extract<RecipeStep, { kind: 'semantic' }>;
type NetworkStep = Extract<RecipeStep, { kind: 'network' }>;
type CameraStep = Extract<RecipeStep, { kind: 'camera' }>;
type CameraSetStep = Extract<CameraStep, { operation: 'set' }>;
type CaptureStep = Extract<RecipeStep, { kind: 'capture' }>;
type WaitStep = Extract<RecipeStep, { kind: 'wait' }>;
type WaitForStep = Extract<RecipeStep, { kind: 'wait-for' }>;
type AssertStep = Extract<RecipeStep, { kind: 'assert' }>;
type RestorePointStep = Extract<RecipeStep, { kind: 'restore-point' }>;
type SlimmingStep = Extract<RecipeStep, { kind: 'slimming.mutation' }>;

type SelectOption = { value: string; label: string };

export function RecipeStepEditor({
	step,
	path,
	issues,
	onChange,
}: {
	step: RecipeStep;
	path: string;
	issues: readonly RecipeValidationIssue[];
	onChange: (step: RecipeStep) => void;
}) {
	const stepIssues = issuesForPath(issues, path);
	return (
		<div className="recipe-step-editor">
			<header className="recipe-editor-section-heading">
				<div>
					<p className="sim-eyebrow">Selected step</p>
					<h3>{step.kind}</h3>
				</div>
				<code>{step.id}</code>
			</header>
			<div className="recipe-field-grid">
				<LabeledInput
					label="Step ID"
					value={step.id}
					onChange={(id) => onChange({ ...step, id })}
				/>
				<LabeledInput
					label="Display label"
					placeholder="Generated from operation"
					value={step.label ?? ''}
					onChange={(label) =>
						onChange({ ...step, label: label.length > 0 ? label : undefined })
					}
				/>
				<LabeledInput
					label="Timeout (ms)"
					max={600_000}
					min={100}
					placeholder="Provider default"
					type="number"
					value={step.timeoutMs === undefined ? '' : String(step.timeoutMs)}
					onChange={(value) =>
						onChange({
							...step,
							timeoutMs: value.length === 0 ? undefined : Number(value),
						})
					}
				/>
			</div>
			<div className="recipe-step-kind-fields">
				<StepKindFields step={step} onChange={onChange} />
			</div>
			{stepIssues.length > 0 ? (
				<div className="recipe-inline-errors" role="alert">
					<AlertTriangle className="h-3.5 w-3.5" />
					<div>
						{stepIssues.map((issue) => (
							<p key={`${issue.path}:${issue.message}`}>
								<strong>{issue.path.replace(`${path}.`, '')}</strong>{' '}
								{issue.message}
							</p>
						))}
					</div>
				</div>
			) : null}
		</div>
	);
}

function StepKindFields({
	step,
	onChange,
}: {
	step: RecipeStep;
	onChange: (step: RecipeStep) => void;
}) {
	switch (step.kind) {
		case 'simulator':
			return <SimulatorFields step={step} onChange={onChange} />;
		case 'semantic':
			return <SemanticFields step={step} onChange={onChange} />;
		case 'network':
			return <NetworkFields step={step} onChange={onChange} />;
		case 'camera':
			return <CameraFields step={step} onChange={onChange} />;
		case 'capture':
			return <CaptureFields step={step} onChange={onChange} />;
		case 'wait':
			return <WaitFields step={step} onChange={onChange} />;
		case 'wait-for':
			return <WaitForFields step={step} onChange={onChange} />;
		case 'assert':
			return <AssertFields step={step} onChange={onChange} />;
		case 'restore-point':
			return <RestorePointFields step={step} onChange={onChange} />;
		case 'slimming.mutation':
			return <SlimmingFields step={step} onChange={onChange} />;
	}
}

function SimulatorFields({
	step,
	onChange,
}: {
	step: SimulatorStep;
	onChange: (step: RecipeStep) => void;
}) {
	const action = step.action;
	return (
		<>
			<LabeledSelect
				label="Simulator operation"
				options={SIMULATOR_OPERATIONS}
				value={action.operation}
				onChange={(operation) =>
					onChange({
						...step,
						action: createSimulatorAction(
							operation as Parameters<typeof createSimulatorAction>[0]
						),
					})
				}
			/>
			{action.operation === 'app.launch' ||
			action.operation === 'app.terminate' ||
			action.operation === 'push.send' ? (
				<LabeledInput
					label="Bundle identifier"
					value={action.bundleIdentifier}
					onChange={(bundleIdentifier) =>
						onChange({ ...step, action: { ...action, bundleIdentifier } })
					}
				/>
			) : null}
			{action.operation === 'app.launch' ? (
				<AppLaunchFields action={action} step={step} onChange={onChange} />
			) : null}
			{action.operation === 'pasteboard.sync' ? (
				<>
					<LabeledSelect
						label="Clipboard direction"
						options={[
							{ value: 'host-to-simulator', label: 'Host → Simulator' },
							{ value: 'simulator-to-host', label: 'Simulator → host' },
						]}
						value={action.direction}
						onChange={(direction) =>
							onChange({
								...step,
								action: {
									...action,
									direction: direction as typeof action.direction,
								},
							})
						}
					/>
					<p className="recipe-scope-note">
						The transfer uses Simulator pasteboard tooling and may replace the
						destination clipboard.
					</p>
				</>
			) : null}
			{action.operation === 'url.open' ? (
				<LabeledInput
					label="Safe URL"
					value={action.url}
					onChange={(url) => onChange({ ...step, action: { ...action, url } })}
				/>
			) : null}
			{action.operation === 'location.set' ? (
				<div className="recipe-field-grid">
					<LabeledInput
						label="Latitude"
						max={90}
						min={-90}
						type="number"
						value={String(action.latitude)}
						onChange={(value) =>
							onChange({
								...step,
								action: { ...action, latitude: Number(value) },
							})
						}
					/>
					<LabeledInput
						label="Longitude"
						max={180}
						min={-180}
						type="number"
						value={String(action.longitude)}
						onChange={(value) =>
							onChange({
								...step,
								action: { ...action, longitude: Number(value) },
							})
						}
					/>
				</div>
			) : null}
			{action.operation === 'location.start' ? (
				<LocationRouteFields
					key={step.id}
					action={action}
					step={step}
					onChange={onChange}
				/>
			) : null}
			{action.operation === 'push.send' ? (
				<LabeledTextArea
					description="Must be a JSON object with an aps object and at most 4,096 UTF-8 bytes."
					label="Push payload"
					mono
					value={action.payloadJson}
					onChange={(payloadJson) =>
						onChange({ ...step, action: { ...action, payloadJson } })
					}
				/>
			) : null}
			{action.operation === 'privacy.update' ? (
				<PrivacyFields action={action} step={step} onChange={onChange} />
			) : null}
			{action.operation === 'ui.appearance' ? (
				<LabeledSelect
					label="Appearance"
					options={[
						{ value: 'light', label: 'Light' },
						{ value: 'dark', label: 'Dark' },
					]}
					value={action.value}
					onChange={(value) =>
						onChange({
							...step,
							action: { ...action, value: value as 'light' | 'dark' },
						})
					}
				/>
			) : null}
			{action.operation === 'ui.update' ? (
				<UiUpdateFields action={action} step={step} onChange={onChange} />
			) : null}
			{action.operation === 'statusBar.override' ? (
				<StatusBarFields action={action} step={step} onChange={onChange} />
			) : null}
			{action.operation === 'keychain.reset' ? (
				<p className="recipe-danger-note">
					This permanently clears the selected Simulator keychain. A
					short-lived, exact native confirmation is mandatory at run time.
				</p>
			) : null}
		</>
	);
}

function AppLaunchFields({
	action,
	step,
	onChange,
}: {
	action: AppLaunchAction;
	step: SimulatorStep;
	onChange: (step: RecipeStep) => void;
}) {
	return (
		<>
			<BooleanSwitch
				description="Terminate an existing process before launching."
				isSelected={action.terminateRunning}
				label="Terminate running app"
				onChange={(terminateRunning) =>
					onChange({ ...step, action: { ...action, terminateRunning } })
				}
			/>
			<LabeledTextArea
				description="One launch argument per line; maximum 50."
				label="Launch arguments"
				value={action.arguments.join('\n')}
				onChange={(value) =>
					onChange({
						...step,
						action: {
							...action,
							arguments: value.length === 0 ? [] : value.split('\n'),
						},
					})
				}
			/>
			<div className="recipe-field-grid">
				<LabeledInput
					label="Locale"
					placeholder="App default (for example en_US)"
					value={action.locale ?? ''}
					onChange={(locale) =>
						onChange({
							...step,
							action: { ...action, locale: locale || undefined },
						})
					}
				/>
				<LabeledInput
					label="Time zone"
					placeholder="App default (for example America/Los_Angeles)"
					value={action.timeZone ?? ''}
					onChange={(timeZone) =>
						onChange({
							...step,
							action: { ...action, timeZone: timeZone || undefined },
						})
					}
				/>
			</div>
			<LabeledTextArea
				description="One BCP 47 language tag per line; maximum 10."
				label="Preferred languages"
				value={action.languages?.join('\n') ?? ''}
				onChange={(value) => {
					const languages = value
						.split('\n')
						.map((item) => item.trim())
						.filter(Boolean);
					onChange({
						...step,
						action: {
							...action,
							languages: languages.length === 0 ? undefined : languages,
						},
					});
				}}
			/>
			<LabeledSelect
				label="Slow animations"
				options={[
					{ value: '', label: 'Use app default' },
					{ value: 'true', label: 'Enabled' },
					{ value: 'false', label: 'Disabled' },
				]}
				value={
					action.slowAnimations === undefined
						? ''
						: String(action.slowAnimations)
				}
				onChange={(value) =>
					onChange({
						...step,
						action: {
							...action,
							slowAnimations: value === '' ? undefined : value === 'true',
						},
					})
				}
			/>
		</>
	);
}

function LocationRouteFields({
	action,
	step,
	onChange,
}: {
	action: LocationRouteAction;
	step: SimulatorStep;
	onChange: (step: RecipeStep) => void;
}) {
	const [waypointText, setWaypointText] = useState(() =>
		action.waypoints
			.map((waypoint) => `${waypoint.latitude}, ${waypoint.longitude}`)
			.join('\n')
	);
	const updateOptionalNumber = (
		field: 'speedMetersPerSecond' | 'distanceMeters' | 'intervalSeconds',
		value: string
	) => {
		const nextAction = {
			...action,
			[field]: value === '' ? undefined : Number(value),
		};
		if (field === 'distanceMeters' && value !== '')
			nextAction.intervalSeconds = undefined;
		if (field === 'intervalSeconds' && value !== '')
			nextAction.distanceMeters = undefined;
		onChange({ ...step, action: nextAction });
	};
	return (
		<>
			<LabeledTextArea
				description="One latitude, longitude pair per line; 2–500 waypoints."
				label="Route waypoints"
				mono
				value={waypointText}
				onChange={(value) => {
					setWaypointText(value);
					const waypoints = value.split('\n').map((line) => {
						const [latitude = '', longitude = ''] = line.split(',');
						return {
							latitude: Number(latitude.trim()),
							longitude: Number(longitude.trim()),
						};
					});
					onChange({ ...step, action: { ...action, waypoints } });
				}}
			/>
			<div className="recipe-field-grid">
				<LabeledInput
					label="Speed (m/s)"
					min={0.01}
					placeholder="Provider default"
					step="0.1"
					type="number"
					value={
						action.speedMetersPerSecond === undefined
							? ''
							: String(action.speedMetersPerSecond)
					}
					onChange={(value) =>
						updateOptionalNumber('speedMetersPerSecond', value)
					}
				/>
				<LabeledInput
					label="Distance cadence (m)"
					min={0.01}
					placeholder="Optional"
					step="0.1"
					type="number"
					value={
						action.distanceMeters === undefined
							? ''
							: String(action.distanceMeters)
					}
					onChange={(value) => updateOptionalNumber('distanceMeters', value)}
				/>
				<LabeledInput
					label="Interval cadence (s)"
					min={0.01}
					placeholder="Optional"
					step="0.1"
					type="number"
					value={
						action.intervalSeconds === undefined
							? ''
							: String(action.intervalSeconds)
					}
					onChange={(value) => updateOptionalNumber('intervalSeconds', value)}
				/>
			</div>
			<p className="recipe-scope-note">
				Distance and interval cadence are mutually exclusive; entering one
				clears the other.
			</p>
		</>
	);
}

function PrivacyFields({
	action,
	step,
	onChange,
}: {
	action: PrivacyAction;
	step: SimulatorStep;
	onChange: (step: RecipeStep) => void;
}) {
	return (
		<>
			<div className="recipe-field-grid">
				<LabeledSelect
					label="Privacy operation"
					options={[
						{ value: 'grant', label: 'Grant' },
						{ value: 'revoke', label: 'Revoke' },
						{ value: 'reset', label: 'Reset decision' },
					]}
					value={action.privacyOperation}
					onChange={(privacyOperation) =>
						onChange({
							...step,
							action: {
								...action,
								privacyOperation:
									privacyOperation as PrivacyAction['privacyOperation'],
							},
						})
					}
				/>
				<LabeledSelect
					label="Privacy service"
					options={PRIVACY_SERVICES}
					value={action.service}
					onChange={(service) =>
						onChange({
							...step,
							action: {
								...action,
								service: service as PrivacyAction['service'],
							},
						})
					}
				/>
			</div>
			<LabeledInput
				label="Bundle identifier"
				placeholder="Required for grant, revoke, and reset"
				value={action.bundleIdentifier}
				onChange={(bundleIdentifier) =>
					onChange({
						...step,
						action: {
							...action,
							bundleIdentifier,
						},
					})
				}
			/>
			<p className="recipe-danger-note">
				Privacy reset removes persisted decisions and requires exact native
				approval. Grant and revoke remain restricted to the allowlisted service
				and bundle.
			</p>
		</>
	);
}

function UiUpdateFields({
	action,
	step,
	onChange,
}: {
	action: UiUpdateAction;
	step: SimulatorStep;
	onChange: (step: RecipeStep) => void;
}) {
	return (
		<div className="recipe-field-grid">
			<LabeledSelect
				label="UI setting"
				options={UI_SETTINGS}
				value={action.setting}
				onChange={(settingValue) => {
					const setting = settingValue as UiUpdateAction['setting'];
					onChange({
						...step,
						action: {
							...action,
							setting,
							value: UI_DEFAULT_VALUES[setting],
						},
					});
				}}
			/>
			<LabeledSelect
				label="Value"
				options={UI_VALUE_OPTIONS[action.setting]}
				value={action.value}
				onChange={(value) =>
					onChange({
						...step,
						action: { ...action, value: value as UiUpdateAction['value'] },
					})
				}
			/>
		</div>
	);
}

function StatusBarFields({
	action,
	step,
	onChange,
}: {
	action: StatusBarAction;
	step: SimulatorStep;
	onChange: (step: RecipeStep) => void;
}) {
	const updateOverrides = (overrides: StatusBarAction['overrides']) =>
		onChange({ ...step, action: { ...action, overrides } });
	return (
		<>
			<div className="recipe-field-grid">
				<LabeledInput
					label="Time"
					placeholder="Unchanged"
					value={action.overrides.time ?? ''}
					onChange={(time) =>
						updateOverrides({ ...action.overrides, time: time || undefined })
					}
				/>
				<LabeledInput
					label="Operator name"
					placeholder="Unchanged"
					value={action.overrides.operatorName ?? ''}
					onChange={(operatorName) =>
						updateOverrides({
							...action.overrides,
							operatorName: operatorName || undefined,
						})
					}
				/>
				<LabeledSelect
					label="Data network"
					options={STATUS_DATA_NETWORKS}
					value={action.overrides.dataNetwork ?? ''}
					onChange={(dataNetwork) =>
						updateOverrides({
							...action.overrides,
							dataNetwork: (dataNetwork ||
								undefined) as StatusBarAction['overrides']['dataNetwork'],
						})
					}
				/>
				<LabeledSelect
					label="Wi-Fi state"
					options={STATUS_WIFI_MODES}
					value={action.overrides.wifiMode ?? ''}
					onChange={(wifiMode) =>
						updateOverrides({
							...action.overrides,
							wifiMode: (wifiMode ||
								undefined) as StatusBarAction['overrides']['wifiMode'],
						})
					}
				/>
				<LabeledSelect
					label="Wi-Fi bars"
					options={optionalIntegerOptions(3)}
					value={
						action.overrides.wifiBars === undefined
							? ''
							: String(action.overrides.wifiBars)
					}
					onChange={(wifiBars) =>
						updateOverrides({
							...action.overrides,
							wifiBars: wifiBars === '' ? undefined : Number(wifiBars),
						})
					}
				/>
				<LabeledSelect
					label="Cellular state"
					options={STATUS_CELLULAR_MODES}
					value={action.overrides.cellularMode ?? ''}
					onChange={(cellularMode) =>
						updateOverrides({
							...action.overrides,
							cellularMode: (cellularMode ||
								undefined) as StatusBarAction['overrides']['cellularMode'],
						})
					}
				/>
				<LabeledSelect
					label="Cellular bars"
					options={optionalIntegerOptions(4)}
					value={
						action.overrides.cellularBars === undefined
							? ''
							: String(action.overrides.cellularBars)
					}
					onChange={(cellularBars) =>
						updateOverrides({
							...action.overrides,
							cellularBars:
								cellularBars === '' ? undefined : Number(cellularBars),
						})
					}
				/>
				<LabeledSelect
					label="Battery state"
					options={STATUS_BATTERY_STATES}
					value={action.overrides.batteryState ?? ''}
					onChange={(batteryState) =>
						updateOverrides({
							...action.overrides,
							batteryState: (batteryState ||
								undefined) as StatusBarAction['overrides']['batteryState'],
						})
					}
				/>
				<LabeledInput
					label="Battery level"
					max={100}
					min={0}
					placeholder="Unchanged"
					type="number"
					value={
						action.overrides.batteryLevel === undefined
							? ''
							: String(action.overrides.batteryLevel)
					}
					onChange={(batteryLevel) =>
						updateOverrides({
							...action.overrides,
							batteryLevel:
								batteryLevel === '' ? undefined : Number(batteryLevel),
						})
					}
				/>
			</div>
			<p className="recipe-scope-note">
				At least one override is required. Use “Clear status bar overrides” as a
				separate step to return to Simulator defaults.
			</p>
		</>
	);
}

function SemanticFields({
	step,
	onChange,
}: {
	step: SemanticStep;
	onChange: (step: RecipeStep) => void;
}) {
	const action = step.action;
	return (
		<>
			<LabeledSelect
				label="Semantic action"
				options={SEMANTIC_OPERATIONS}
				value={action.action}
				onChange={(value) =>
					onChange({
						...step,
						action: createSemanticAction(
							value as Parameters<typeof createSemanticAction>[0]
						),
					})
				}
			/>
			<LabeledInput
				label="Component ID"
				value={action.componentId}
				onChange={(componentId) =>
					onChange({ ...step, action: { ...action, componentId } })
				}
			/>
			{action.action === 'setText' ? (
				<LabeledTextArea
					label="Text"
					value={action.text}
					onChange={(text) =>
						onChange({ ...step, action: { ...action, text } })
					}
				/>
			) : null}
			{action.action === 'scroll' ? (
				<div className="recipe-field-grid">
					<LabeledSelect
						label="Direction"
						options={['up', 'down', 'left', 'right'].map((value) => ({
							value,
							label: value,
						}))}
						value={action.direction}
						onChange={(direction) =>
							onChange({
								...step,
								action: {
									...action,
									direction: direction as typeof action.direction,
								},
							})
						}
					/>
					<LabeledInput
						label="Amount (0–1)"
						max={1}
						min={0.01}
						step="0.05"
						type="number"
						value={action.amount === undefined ? '' : String(action.amount)}
						onChange={(amount) =>
							onChange({
								...step,
								action: {
									...action,
									amount: amount.length === 0 ? undefined : Number(amount),
								},
							})
						}
					/>
				</div>
			) : null}
		</>
	);
}

function NetworkFields({
	step,
	onChange,
}: {
	step: NetworkStep;
	onChange: (step: RecipeStep) => void;
}) {
	return (
		<>
			<LabeledSelect
				label="Operation"
				options={[
					{ value: 'set', label: 'Set profile' },
					{ value: 'clear', label: 'Clear profile' },
				]}
				value={step.operation}
				onChange={(operation) =>
					onChange(
						operation === 'set'
							? { ...step, operation, profileId: 'wifi' }
							: {
									...commonStepFields(step),
									kind: step.kind,
									operation: 'clear',
								}
					)
				}
			/>
			{step.operation === 'set' ? (
				<LabeledSelect
					label="Instrumented fetch profile"
					options={NETWORK_PROFILES}
					value={step.profileId ?? 'wifi'}
					onChange={(profileId) =>
						onChange({
							...step,
							profileId: profileId as Exclude<typeof step.profileId, undefined>,
						})
					}
				/>
			) : null}
			<p className="recipe-scope-note">
				This shapes only the app’s instrumented fetch client, not Simulator or
				host traffic.
			</p>
		</>
	);
}

function CameraFields({
	step,
	onChange,
}: {
	step: CameraStep;
	onChange: (step: RecipeStep) => void;
}) {
	const [isPreparing, setIsPreparing] = useState(false);
	const [fileError, setFileError] = useState<string | null>(null);
	const setStep = step.operation === 'set' ? step : null;
	const prepareFile = async (file: File | null) => {
		if (!file || !setStep) return;
		setIsPreparing(true);
		setFileError(null);
		try {
			const fixture = await prepareFixtureFile(
				file,
				setStep.fixture.fixtureKind
			);
			onChange({ ...setStep, fixture });
		} catch (error) {
			setFileError(
				error instanceof Error
					? error.message
					: 'Camera fixture could not be read.'
			);
		} finally {
			setIsPreparing(false);
		}
	};
	return (
		<>
			<LabeledSelect
				label="Operation"
				options={[
					{ value: 'set', label: 'Set fixture' },
					{ value: 'clear', label: 'Clear fixture' },
				]}
				value={step.operation}
				onChange={(operation) =>
					onChange(
						operation === 'set'
							? {
									...step,
									operation,
									fixture: createCameraFixture('unavailable'),
								}
							: {
									...commonStepFields(step),
									kind: step.kind,
									operation: 'clear',
								}
					)
				}
			/>
			{setStep ? (
				<>
					<LabeledSelect
						label="Fixture kind"
						options={CAMERA_FIXTURE_KINDS}
						value={setStep.fixture.fixtureKind}
						onChange={(fixtureKind) =>
							onChange({
								...setStep,
								fixture: createCameraFixture(
									fixtureKind as Parameters<typeof createCameraFixture>[0]
								),
							})
						}
					/>
					<LabeledInput
						label="Fixture label"
						value={setStep.fixture.label ?? ''}
						onChange={(label) =>
							onChange({
								...setStep,
								fixture: {
									...setStep.fixture,
									label: label.length > 0 ? label : undefined,
								},
							})
						}
					/>
					{setStep.fixture.fixtureKind === 'error' ? (
						<LabeledTextArea
							label="Provider error"
							value={setStep.fixture.errorMessage}
							onChange={(errorMessage) => {
								const fixture = setStep.fixture;
								if (fixture.fixtureKind !== 'error') return;
								onChange({
									...setStep,
									fixture: { ...fixture, errorMessage },
								});
							}}
						/>
					) : null}
					{['still', 'qr', 'video'].includes(setStep.fixture.fixtureKind) ? (
						<div className="recipe-fixture-picker">
							{setStep.fixture.fixtureKind === 'video' ? (
								<FileVideo className="h-4 w-4" />
							) : (
								<FileImage className="h-4 w-4" />
							)}
							<div>
								<strong>Bounded media fixture</strong>
								<span>384 KiB raw / 512 KiB encoded; no path is retained.</span>
							</div>
							<label>
								<Upload className="h-3 w-3" />{' '}
								{isPreparing ? 'Reading…' : 'Choose'}
								<input
									accept={
										setStep.fixture.fixtureKind === 'video'
											? VIDEO_MIME_TYPES.join(',')
											: IMAGE_MIME_TYPES.join(',')
									}
									disabled={isPreparing}
									type="file"
									onChange={(event) =>
										void prepareFile(event.currentTarget.files?.[0] ?? null)
									}
								/>
							</label>
						</div>
					) : null}
					{fileError ? (
						<p className="sim-field-error" role="alert">
							{fileError}
						</p>
					) : null}
					<p className="recipe-scope-note">
						Fixtures target only the app’s instrumented development camera and
						never change macOS camera permission.
					</p>
				</>
			) : null}
		</>
	);
}

function CaptureFields({
	step,
	onChange,
}: {
	step: CaptureStep;
	onChange: (step: RecipeStep) => void;
}) {
	return (
		<>
			<div className="recipe-field-grid">
				<LabeledSelect
					label="Format"
					options={[
						{ value: 'png', label: 'PNG' },
						{ value: 'jpeg', label: 'JPEG' },
					]}
					value={step.format}
					onChange={(format) =>
						onChange({ ...step, format: format as CaptureStep['format'] })
					}
				/>
				<LabeledSelect
					label="Screen mask"
					options={['ignored', 'alpha', 'black'].map((value) => ({
						value,
						label: value,
					}))}
					value={step.mask}
					onChange={(mask) =>
						onChange({ ...step, mask: mask as CaptureStep['mask'] })
					}
				/>
			</div>
			<LabeledInput
				label="Evidence name"
				placeholder="Generated filename"
				value={step.name ?? ''}
				onChange={(name) =>
					onChange({ ...step, name: name.length > 0 ? name : undefined })
				}
			/>
		</>
	);
}

function WaitFields({
	step,
	onChange,
}: {
	step: WaitStep;
	onChange: (step: RecipeStep) => void;
}) {
	return (
		<LabeledInput
			label="Duration (ms)"
			max={600_000}
			min={0}
			type="number"
			value={String(step.durationMs)}
			onChange={(durationMs) =>
				onChange({ ...step, durationMs: Number(durationMs) })
			}
		/>
	);
}

function WaitForFields({
	step,
	onChange,
}: {
	step: WaitForStep;
	onChange: (step: RecipeStep) => void;
}) {
	const waitFor = step.waitFor;
	return (
		<>
			<LabeledSelect
				label="Condition"
				options={WAIT_FOR_CONDITIONS}
				value={waitFor.condition}
				onChange={(condition) =>
					onChange({
						...step,
						waitFor: createWaitForCondition(
							condition as Parameters<typeof createWaitForCondition>[0]
						),
					})
				}
			/>
			{waitFor.condition === 'component.exists' ? (
				<LabeledInput
					label="Component ID"
					value={waitFor.componentId}
					onChange={(componentId) =>
						onChange({ ...step, waitFor: { ...waitFor, componentId } })
					}
				/>
			) : null}
			{waitFor.condition === 'screen.change' ? (
				<LabeledInput
					label="Starting screen hash"
					placeholder="Current screen when omitted"
					value={waitFor.fromHash ?? ''}
					onChange={(fromHash) =>
						onChange({
							...step,
							waitFor: {
								...waitFor,
								fromHash: fromHash.length > 0 ? fromHash : undefined,
							},
						})
					}
				/>
			) : null}
			{waitFor.condition === 'network.idle' ? (
				<LabeledInput
					label="Quiet window (ms)"
					max={60_000}
					min={100}
					type="number"
					value={String(waitFor.quietMs)}
					onChange={(quietMs) =>
						onChange({
							...step,
							waitFor: { ...waitFor, quietMs: Number(quietMs) },
						})
					}
				/>
			) : null}
		</>
	);
}

function AssertFields({
	step,
	onChange,
}: {
	step: AssertStep;
	onChange: (step: RecipeStep) => void;
}) {
	const assertion = step.assertion;
	return (
		<>
			<LabeledSelect
				label="Assertion"
				options={ASSERTION_CONDITIONS}
				value={assertion.condition}
				onChange={(condition) =>
					onChange({
						...step,
						assertion: createAssertion(
							condition as Parameters<typeof createAssertion>[0]
						),
					})
				}
			/>
			{assertion.condition === 'simulator.state' ? (
				<LabeledSelect
					label="Expected state"
					options={[
						{ value: 'booted', label: 'Booted' },
						{ value: 'shutdown', label: 'Shut down' },
					]}
					value={assertion.expected}
					onChange={(expected) =>
						onChange({
							...step,
							assertion: {
								...assertion,
								expected: expected as typeof assertion.expected,
							},
						})
					}
				/>
			) : null}
			{assertion.condition === 'connected' ||
			assertion.condition === 'camera.active' ? (
				<BooleanSwitch
					description="The run fails when the observed value differs."
					isSelected={assertion.expected}
					label="Expected active"
					onChange={(expected) =>
						onChange({ ...step, assertion: { ...assertion, expected } })
					}
				/>
			) : null}
			{assertion.condition === 'component.exists' ? (
				<>
					<LabeledInput
						label="Component ID"
						value={assertion.componentId}
						onChange={(componentId) =>
							onChange({ ...step, assertion: { ...assertion, componentId } })
						}
					/>
					<BooleanSwitch
						description="Turn off to assert that the component is absent."
						isSelected={assertion.expected}
						label="Must exist"
						onChange={(expected) =>
							onChange({ ...step, assertion: { ...assertion, expected } })
						}
					/>
				</>
			) : null}
			{assertion.condition === 'screen.hash' ? (
				<LabeledInput
					label="Expected screen hash"
					value={assertion.expectedHash}
					onChange={(expectedHash) =>
						onChange({ ...step, assertion: { ...assertion, expectedHash } })
					}
				/>
			) : null}
			{assertion.condition === 'network.profile' ? (
				<LabeledSelect
					label="Expected profile"
					options={[{ value: 'none', label: 'None' }, ...NETWORK_PROFILES]}
					value={assertion.expectedProfileId}
					onChange={(expectedProfileId) =>
						onChange({
							...step,
							assertion: {
								...assertion,
								expectedProfileId:
									expectedProfileId as typeof assertion.expectedProfileId,
							},
						})
					}
				/>
			) : null}
		</>
	);
}

function RestorePointFields({
	step,
	onChange,
}: {
	step: RestorePointStep;
	onChange: (step: RecipeStep) => void;
}) {
	return (
		<>
			<LabeledSelect
				label="Operation"
				options={[
					{ value: 'capture', label: 'Capture restore point' },
					{ value: 'restore', label: 'Restore checkpoint' },
					{ value: 'remove', label: 'Remove checkpoint' },
				]}
				value={step.operation}
				onChange={(operation) =>
					onChange(
						operation === 'capture'
							? {
									id: step.id,
									kind: step.kind,
									operation,
									saveAs: 'checkpoint',
									label: step.label,
									timeoutMs: step.timeoutMs,
								}
							: {
									id: step.id,
									kind: step.kind,
									operation: operation as 'restore' | 'remove',
									reference: 'checkpoint',
									label: step.label,
									timeoutMs: step.timeoutMs,
								}
					)
				}
			/>
			<LabeledInput
				label={
					step.operation === 'capture' ? 'Save as' : 'Checkpoint reference'
				}
				value={step.operation === 'capture' ? step.saveAs : step.reference}
				onChange={(value) =>
					onChange(
						step.operation === 'capture'
							? { ...step, saveAs: value }
							: { ...step, reference: value }
					)
				}
			/>
			{step.operation !== 'capture' ? (
				<p className="recipe-danger-note">
					Restore and remove can replace or discard managed app state and
					require native approval before execution.
				</p>
			) : null}
		</>
	);
}

function SlimmingFields({
	step,
	onChange,
}: {
	step: SlimmingStep;
	onChange: (step: RecipeStep) => void;
}) {
	return (
		<>
			<LabeledSelect
				label="Mutation"
				options={[
					{ value: 'apply', label: 'Apply profile' },
					{ value: 'undo', label: 'Undo last mutation' },
					{ value: 'restore', label: 'Restore managed services' },
				]}
				value={step.operation}
				onChange={(operation) =>
					onChange(
						operation === 'apply'
							? {
									id: step.id,
									kind: step.kind,
									operation,
									profileId: 'balanced',
									label: step.label,
									timeoutMs: step.timeoutMs,
								}
							: {
									id: step.id,
									kind: step.kind,
									operation: operation as 'restore' | 'undo',
									label: step.label,
									timeoutMs: step.timeoutMs,
								}
					)
				}
			/>
			{step.operation === 'apply' ? (
				<LabeledInput
					label="Profile ID"
					value={step.profileId}
					onChange={(profileId) => onChange({ ...step, profileId })}
				/>
			) : null}
			<p className="recipe-danger-note">
				Recipes never store experimental acknowledgement. For an unknown
				compatibility tuple, type the exact acknowledgement in Simulator
				Slimming before running; compatibility checks, native confirmation,
				verification, and rollback remain mandatory.
			</p>
		</>
	);
}

function LabeledInput({
	label,
	value,
	onChange,
	placeholder,
	type = 'text',
	min,
	max,
	step,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	type?: 'text' | 'number';
	min?: number;
	max?: number;
	step?: string;
}) {
	const labelId = useId();
	return (
		<div className="recipe-field">
			<span id={labelId}>{label}</span>
			<Input
				aria-labelledby={labelId}
				{...(max === undefined ? {} : { max })}
				{...(min === undefined ? {} : { min })}
				{...(placeholder === undefined ? {} : { placeholder })}
				{...(step === undefined ? {} : { step })}
				type={type}
				value={value}
				onChange={(event) => onChange(event.currentTarget.value)}
			/>
		</div>
	);
}

function LabeledTextArea({
	label,
	value,
	onChange,
	description,
	mono = false,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	description?: string;
	mono?: boolean;
}) {
	const labelId = useId();
	return (
		<div className="recipe-field">
			<span id={labelId}>{label}</span>
			<TextArea
				aria-labelledby={labelId}
				{...(mono ? { className: 'is-mono' } : {})}
				value={value}
				onChange={(event) => onChange(event.currentTarget.value)}
			/>
			{description ? <small>{description}</small> : null}
		</div>
	);
}

function LabeledSelect({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: string;
	options: readonly SelectOption[];
	onChange: (value: string) => void;
}) {
	const labelId = useId();
	return (
		<div className="recipe-field">
			<span id={labelId}>{label}</span>
			<NativeSelect fullWidth variant="secondary">
				<NativeSelect.Trigger
					aria-labelledby={labelId}
					value={value}
					onChange={(event) => onChange(event.currentTarget.value)}
				>
					{options.map((option) => (
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
	);
}

function commonStepFields(step: RecipeStep): {
	id: string;
	label?: string;
	timeoutMs?: number;
} {
	return {
		id: step.id,
		...(step.label === undefined ? {} : { label: step.label }),
		...(step.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs }),
	};
}

function BooleanSwitch({
	label,
	description,
	isSelected,
	onChange,
}: {
	label: string;
	description: string;
	isSelected: boolean;
	onChange: (selected: boolean) => void;
}) {
	return (
		<Switch isSelected={isSelected} size="sm" onChange={onChange}>
			<Switch.Content>
				<span className="sim-switch-copy">
					<strong>{label}</strong>
					<small>{description}</small>
				</span>
			</Switch.Content>
			<Switch.Control>
				<Switch.Thumb />
			</Switch.Control>
		</Switch>
	);
}

async function prepareFixtureFile(
	file: File,
	fixtureKind: CameraSetStep['fixture']['fixtureKind']
): Promise<CameraSetStep['fixture']> {
	if (
		fixtureKind !== 'still' &&
		fixtureKind !== 'qr' &&
		fixtureKind !== 'video'
	) {
		throw new Error(
			'Choose a still, QR, or video fixture before selecting a file.'
		);
	}
	assertFixtureSize(file);
	const dataBase64 = await readFixtureBase64(file, 'recipe');
	if (fixtureKind === 'video') {
		const media = await inspectVideoFixture(file);
		return {
			fixtureKind,
			label: file.name,
			mimeType: file.type as 'video/mp4' | 'video/quicktime',
			dataBase64,
			...media,
		};
	}
	const { width, height } = await inspectImageFixture(file);
	return {
		fixtureKind,
		label: file.name,
		mimeType: file.type as 'image/jpeg' | 'image/png' | 'image/webp',
		dataBase64,
		width,
		height,
	};
}

const SIMULATOR_OPERATIONS: SelectOption[] = [
	{ value: 'device.boot', label: 'Boot device' },
	{ value: 'device.shutdown', label: 'Shut down device' },
	{ value: 'app.launch', label: 'Launch app' },
	{ value: 'app.terminate', label: 'Terminate app' },
	{ value: 'pasteboard.sync', label: 'Sync pasteboard' },
	{ value: 'url.open', label: 'Open URL' },
	{ value: 'location.set', label: 'Set location' },
	{ value: 'location.start', label: 'Play location route' },
	{ value: 'location.clear', label: 'Clear location' },
	{ value: 'push.send', label: 'Send push' },
	{ value: 'privacy.update', label: 'Update privacy decision' },
	{ value: 'ui.update', label: 'Update UI environment' },
	{ value: 'ui.appearance', label: 'Set appearance (legacy)' },
	{ value: 'statusBar.override', label: 'Override status bar' },
	{ value: 'statusBar.clear', label: 'Clear status bar overrides' },
	{ value: 'keychain.reset', label: 'Reset keychain' },
];

const PRIVACY_SERVICES: SelectOption[] = [
	{ value: 'all', label: 'All services' },
	{ value: 'calendar', label: 'Calendar' },
	{ value: 'contacts-limited', label: 'Contacts (limited)' },
	{ value: 'contacts', label: 'Contacts' },
	{ value: 'location', label: 'Location while using' },
	{ value: 'location-always', label: 'Location always' },
	{ value: 'photos-add', label: 'Add photos' },
	{ value: 'photos', label: 'Photos' },
	{ value: 'media-library', label: 'Media library' },
	{ value: 'microphone', label: 'Microphone' },
	{ value: 'motion', label: 'Motion' },
	{ value: 'reminders', label: 'Reminders' },
	{ value: 'siri', label: 'Siri' },
];

const UI_SETTINGS: SelectOption[] = [
	{ value: 'appearance', label: 'Appearance' },
	{ value: 'increase_contrast', label: 'Increase contrast' },
	{ value: 'content_size', label: 'Dynamic Type size' },
];

const UI_DEFAULT_VALUES: Record<
	UiUpdateAction['setting'],
	UiUpdateAction['value']
> = {
	appearance: 'dark',
	increase_contrast: 'enabled',
	content_size: 'large',
};

const UI_VALUE_OPTIONS: Record<UiUpdateAction['setting'], SelectOption[]> = {
	appearance: [
		{ value: 'light', label: 'Light' },
		{ value: 'dark', label: 'Dark' },
	],
	increase_contrast: [
		{ value: 'enabled', label: 'Enabled' },
		{ value: 'disabled', label: 'Disabled' },
	],
	content_size: [
		{ value: 'extra-small', label: 'Extra small' },
		{ value: 'small', label: 'Small' },
		{ value: 'medium', label: 'Medium' },
		{ value: 'large', label: 'Large' },
		{ value: 'extra-large', label: 'Extra large' },
		{ value: 'extra-extra-large', label: 'Extra extra large' },
		{ value: 'extra-extra-extra-large', label: 'Extra extra extra large' },
		{ value: 'accessibility-medium', label: 'Accessibility medium' },
		{ value: 'accessibility-large', label: 'Accessibility large' },
		{ value: 'accessibility-extra-large', label: 'Accessibility extra large' },
		{
			value: 'accessibility-extra-extra-large',
			label: 'Accessibility extra extra large',
		},
		{
			value: 'accessibility-extra-extra-extra-large',
			label: 'Accessibility maximum',
		},
	],
};

const STATUS_DATA_NETWORKS: SelectOption[] = [
	{ value: '', label: 'Unchanged' },
	...[
		'hide',
		'wifi',
		'3g',
		'4g',
		'lte',
		'lte-a',
		'lte+',
		'5g',
		'5g+',
		'5g-uwb',
		'5g-uc',
	].map((value) => ({ value, label: value.toUpperCase() })),
];

const STATUS_WIFI_MODES: SelectOption[] = [
	{ value: '', label: 'Unchanged' },
	{ value: 'searching', label: 'Searching' },
	{ value: 'failed', label: 'Failed' },
	{ value: 'active', label: 'Active' },
];

const STATUS_CELLULAR_MODES: SelectOption[] = [
	{ value: '', label: 'Unchanged' },
	{ value: 'notSupported', label: 'Not supported' },
	{ value: 'searching', label: 'Searching' },
	{ value: 'failed', label: 'Failed' },
	{ value: 'active', label: 'Active' },
];

const STATUS_BATTERY_STATES: SelectOption[] = [
	{ value: '', label: 'Unchanged' },
	{ value: 'charging', label: 'Charging' },
	{ value: 'charged', label: 'Charged' },
	{ value: 'discharging', label: 'Discharging' },
];

function optionalIntegerOptions(max: number): SelectOption[] {
	return [
		{ value: '', label: 'Unchanged' },
		...Array.from({ length: max + 1 }, (_, value) => ({
			value: String(value),
			label: String(value),
		})),
	];
}

const SEMANTIC_OPERATIONS: SelectOption[] = [
	{ value: 'highlight', label: 'Highlight' },
	{ value: 'activate', label: 'Activate' },
	{ value: 'focus', label: 'Focus' },
	{ value: 'setText', label: 'Set text' },
	{ value: 'scroll', label: 'Scroll' },
];

const NETWORK_PROFILES: SelectOption[] = [
	{ value: 'offline', label: 'Offline' },
	{ value: 'edge', label: 'EDGE' },
	{ value: '3g', label: '3G' },
	{ value: 'lte', label: 'LTE' },
	{ value: 'wifi', label: 'Wi-Fi' },
	{ value: 'dsl', label: 'DSL' },
	{ value: 'very-bad', label: 'Very bad network' },
];

const CAMERA_FIXTURE_KINDS: SelectOption[] = [
	{ value: 'unavailable', label: 'Unavailable' },
	{ value: 'error', label: 'Provider error' },
	{ value: 'still', label: 'Still image file' },
	{ value: 'qr', label: 'QR image file' },
	{ value: 'video', label: 'Short video file' },
];

const WAIT_FOR_CONDITIONS: SelectOption[] = [
	{ value: 'component.exists', label: 'Component exists' },
	{ value: 'screen.change', label: 'Screen changes' },
	{ value: 'network.idle', label: 'Network becomes idle' },
];

const ASSERTION_CONDITIONS: SelectOption[] = [
	{ value: 'simulator.state', label: 'Simulator state' },
	{ value: 'connected', label: 'Development app connected' },
	{ value: 'component.exists', label: 'Component exists' },
	{ value: 'screen.hash', label: 'Screen hash' },
	{ value: 'network.profile', label: 'Network profile' },
	{ value: 'camera.active', label: 'Camera fixture active' },
];

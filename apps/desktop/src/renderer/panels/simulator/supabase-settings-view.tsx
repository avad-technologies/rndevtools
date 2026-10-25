import { Button } from '@heroui/react/button';
import { Input } from '@heroui/react/input';
import { Switch } from '@heroui/react/switch';
import {
	Check,
	FolderOpen,
	Laptop,
	ListChecks,
	Plus,
	RotateCcw,
	SquareTerminal,
	X,
} from 'lucide-react';
import {
	type ReactNode,
	type RefObject,
	useEffect,
	useId,
	useRef,
	useState,
} from 'react';
import { SupabaseNotice, SupabaseSelect } from '@/components/supabase-ui';
import {
	DisabledReason,
	InfoPopover,
	KeyValue,
	ReadinessRow,
} from '@/components/ui';
import { supabaseDisablingText } from '@/simulator/supabase-model';
import { useLaneRuntime } from '@/state/lane-runtime';
import {
	type SupabaseFocusRequest,
	useSupabaseActions,
	useSupabaseNavigation,
} from '@/state/supabase-runtime';
import { formatHoldDuration } from '../../../shared/device-hold';
import {
	laneDefaultBackend,
	SUPABASE_POLICY_ERRORS,
	type SupabaseAppEnvSource,
	type SupabaseExcludableCapability,
	type SupabasePolicy,
	type SupabasePolicyPatch,
	type SupabaseState,
	supabaseGlobalActionAvailability,
	supabasePlatformLabel,
	supabasePolicyPatchErrors,
	supabasePolicyPatchSchema,
	supabaseRepositoryActionAvailability,
} from '../../../shared/supabase-protocol';

/**
 * The Settings view behind the gear: the feature switch and its facts, the
 * policy form (Apply / Reset, field errors in the shared Settings copy),
 * switches that act at once (the trust changes go through main's dialog),
 * repository modes, paths and optional hardening.
 */

const APP_ENV_SOURCES: readonly SupabaseAppEnvSource[] = [
	'API_URL',
	'REST_URL',
	'FUNCTIONS_URL',
	'PUBLISHABLE_KEY',
	'ANON_KEY',
];

/** Exclusions the form edits; Studio is a trust change that acts at once. */
const FORM_EXCLUSIONS = ['analytics', 'pooler'] as const;

type LaneDefault = SupabasePolicy['laneDefaults'][number];
type AppEnvRow = Readonly<{ name: string; source: SupabaseAppEnvSource }>;

/** What the person changed in the policy form; untouched fields follow main. */
type SupabasePolicyForm = Readonly<{
	maxRunning?: string;
	unheldStopDelaySeconds?: string;
	retentionDays?: string;
	excludeAnalytics?: boolean;
	excludePooler?: boolean;
	stopContainerStacksOnce?: boolean;
	branchSwitch?: SupabasePolicy['branchSwitch'];
	appEnv?: readonly AppEnvRow[];
	laneDefaults?: readonly LaneDefault[];
}>;

/** A whole number from the field, or NaN so the shared schema says what's wrong. */
function wholeNumber(value: string): number {
	const trimmed = value.trim();
	return /^\d{1,7}$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

function sameAppEnv(
	left: readonly AppEnvRow[],
	right: readonly AppEnvRow[]
): boolean {
	return (
		left.length === right.length &&
		left.every(
			(entry, index) =>
				entry.name === right[index]?.name &&
				entry.source === right[index]?.source
		)
	);
}

/**
 * Lane defaults for every environment the Lanes runtime knows, in the
 * policy's order first; environments without an entry default to Off.
 */
export function supabaseLaneDefaults(
	policy: Pick<SupabasePolicy, 'laneDefaults'>,
	environmentIds: readonly string[]
): readonly LaneDefault[] {
	const listed = policy.laneDefaults.map((entry) => entry.environmentId);
	return [
		...policy.laneDefaults,
		...environmentIds
			.filter((id) => !listed.includes(id))
			.map((environmentId) => ({
				environmentId,
				backend: laneDefaultBackend(policy, environmentId),
			})),
	];
}

/**
 * The form as it reads on screen, the patch it would apply (only fields that
 * differ from main's policy), the number of changes, and field errors from
 * the shared patch schema keyed like supabasePolicyPatchErrors.
 */
export function supabasePolicyFormState(
	policy: SupabasePolicy,
	form: SupabasePolicyForm,
	environmentIds: readonly string[] = []
): Readonly<{
	values: Readonly<{
		maxRunning: string;
		unheldStopDelaySeconds: string;
		retentionDays: string;
		excludeAnalytics: boolean;
		excludePooler: boolean;
		stopContainerStacksOnce: boolean;
		branchSwitch: SupabasePolicy['branchSwitch'];
		appEnv: readonly AppEnvRow[];
		laneDefaults: readonly LaneDefault[];
	}>;
	patch: Readonly<Record<string, unknown>>;
	changes: number;
	errors: Readonly<Record<string, string>>;
	/** The validated patch, once there is a change and no error. */
	parsed?: SupabasePolicyPatch;
}> {
	const laneDefaults = supabaseLaneDefaults(policy, environmentIds);
	const values = {
		maxRunning: form.maxRunning ?? String(policy.maxRunning),
		unheldStopDelaySeconds:
			form.unheldStopDelaySeconds ??
			String(Math.round(policy.unheldStopDelayMs / 1_000)),
		retentionDays: form.retentionDays ?? String(policy.retentionDays),
		excludeAnalytics:
			form.excludeAnalytics ?? policy.exclude.includes('analytics'),
		excludePooler: form.excludePooler ?? policy.exclude.includes('pooler'),
		stopContainerStacksOnce:
			form.stopContainerStacksOnce ?? policy.stopContainerStacksOnce,
		branchSwitch: form.branchSwitch ?? policy.branchSwitch,
		appEnv: form.appEnv ?? policy.appEnv,
		laneDefaults: form.laneDefaults ?? laneDefaults,
	};
	const patch: Record<string, unknown> = {};
	if (form.maxRunning !== undefined) {
		const maxRunning = wholeNumber(form.maxRunning);
		if (maxRunning !== policy.maxRunning) patch.maxRunning = maxRunning;
	}
	if (form.unheldStopDelaySeconds !== undefined) {
		const seconds = wholeNumber(form.unheldStopDelaySeconds);
		const ms = Number.isNaN(seconds) ? seconds : seconds * 1_000;
		if (ms !== policy.unheldStopDelayMs) patch.unheldStopDelayMs = ms;
	}
	if (form.retentionDays !== undefined) {
		const days = wholeNumber(form.retentionDays);
		if (days !== policy.retentionDays) patch.retentionDays = days;
	}
	const exclude: SupabaseExcludableCapability[] = [
		...policy.exclude.filter(
			(capability) => capability !== 'analytics' && capability !== 'pooler'
		),
		...FORM_EXCLUSIONS.filter((capability) =>
			capability === 'analytics'
				? values.excludeAnalytics
				: values.excludePooler
		),
	];
	const excludeChanged =
		exclude.length !== policy.exclude.length ||
		exclude.some((capability) => !policy.exclude.includes(capability));
	if (excludeChanged) patch.exclude = exclude;
	if (
		form.stopContainerStacksOnce !== undefined &&
		form.stopContainerStacksOnce !== policy.stopContainerStacksOnce
	) {
		patch.stopContainerStacksOnce = form.stopContainerStacksOnce;
	}
	if (
		form.branchSwitch !== undefined &&
		form.branchSwitch !== policy.branchSwitch
	) {
		patch.branchSwitch = form.branchSwitch;
	}
	if (form.appEnv !== undefined && !sameAppEnv(form.appEnv, policy.appEnv)) {
		patch.appEnv = form.appEnv.map((entry) => ({ ...entry }));
	}
	if (form.laneDefaults !== undefined) {
		const changed = form.laneDefaults.some(
			(entry) =>
				laneDefaultBackend(policy, entry.environmentId) !== entry.backend
		);
		if (changed) {
			patch.laneDefaults = form.laneDefaults.map((entry) => ({ ...entry }));
		}
	}
	const changes = Object.keys(patch).length;
	if (changes === 0) return { values, patch, changes, errors: {} };
	// The schema checks names (reserved, duplicate, secret-like) only once the
	// plain fields parse, so app variables are checked on their own too and
	// every error shows at once.
	const errors = {
		...(patch.appEnv === undefined
			? {}
			: supabasePolicyPatchErrors({ appEnv: patch.appEnv })),
		...supabasePolicyPatchErrors(patch),
	};
	const parsed = supabasePolicyPatchSchema.safeParse(patch);
	return {
		values,
		patch,
		changes,
		errors,
		...(parsed.success ? { parsed: parsed.data } : {}),
	};
}

/** `2 verified, 1 not` across tracked repositories that have a CLI. */
export function supabaseCliReadiness(
	state: Pick<SupabaseState, 'repositories'>
): Readonly<{
	text: string;
	status: 'ready' | 'needs-fix' | 'optional';
}> {
	const withCli = state.repositories.filter(
		(repository) => repository.cli.version !== undefined
	);
	const verified = withCli.filter(
		(repository) => repository.cli.gate === 'verified'
	).length;
	const not = withCli.length - verified;
	if (withCli.length === 0) {
		return {
			text: 'No tracked repository has a Supabase CLI yet.',
			status: 'optional',
		};
	}
	return {
		text:
			not === 0 ? `${verified} verified` : `${verified} verified, ${not} not`,
		status: not === 0 ? 'ready' : 'needs-fix',
	};
}

const acknowledgedFormat = new Intl.DateTimeFormat(undefined, {
	month: 'short',
	day: 'numeric',
});

export function SupabaseSettingsView({
	state,
	isBridgeAvailable,
	onOpenRepositories,
}: {
	state: SupabaseState;
	isBridgeAvailable: boolean;
	onOpenRepositories: () => void;
}) {
	const { run, isPending } = useSupabaseActions();
	const { navigation, navigate } = useSupabaseNavigation();
	const lanes = useLaneRuntime();
	const offReasonId = useId();
	const headingRef = useRef<HTMLHeadingElement>(null);
	const [form, setForm] = useState<SupabasePolicyForm>({});
	const environmentIds = lanes.state.environments.map(
		(environment) => environment.id
	);
	const { policy } = state;
	const formState = supabasePolicyFormState(policy, form, environmentIds);
	const { values } = formState;
	const editable = supabaseGlobalActionAvailability('update-policy', {
		bridgeAvailable: isBridgeAvailable,
		state,
	});
	const saving = isPending('policy');
	const locked = !editable.allowed || saving;
	const lockedProps = editable.allowed
		? {}
		: { 'aria-describedby': offReasonId };
	const focus: SupabaseFocusRequest | null = navigation.focus;
	useEffect(() => {
		if (focus?.target !== 'settings') return;
		headingRef.current?.focus();
		navigate({ type: 'focus-handled', nonce: focus.nonce });
	}, [focus, navigate]);

	const update = (next: SupabasePolicyForm) =>
		setForm((current) => ({ ...current, ...next }));
	const applyNow = (patch: SupabasePolicyPatch) =>
		void run({ kind: 'update-policy', patch });
	const apply = async () => {
		if (!formState.parsed) return;
		const receipt = await run({
			kind: 'update-policy',
			patch: formState.parsed,
		});
		if (receipt.completed && receipt.cancelled !== true && !receipt.error) {
			setForm({});
		}
	};
	const applyReason = !editable.allowed
		? editable.reason
		: formState.changes === 0
			? SUPABASE_POLICY_ERRORS.empty
			: !formState.parsed
				? 'Fix the fields marked above, then apply.'
				: undefined;

	return (
		<div className="sim-settings-scroll panel-scroll supabase-settings">
			<div className="sim-settings-layout">
				<FeatureSurface
					headingRef={headingRef}
					isBridgeAvailable={isBridgeAvailable}
					state={state}
					onOpenRepositories={onOpenRepositories}
					onSetEnabled={(enabled) => void run({ kind: 'set-enabled', enabled })}
				/>
				{editable.allowed ? null : (
					<p className="supabase-settings-locked">
						<DisabledReason id={offReasonId}>
							{editable.reason} Settings apply once it is on.
						</DisabledReason>
					</p>
				)}
				<SettingsSurface title="Capacity and idle">
					<div className="supabase-field-grid">
						<NumberField
							disabled={locked}
							error={formState.errors.maxRunning}
							hint={`1–24 · this Mac's safe ceiling is ${state.capacity.derivedCap}${state.capacity.sysv ? ` (${state.capacity.sysv.limit} slots, 8 kept free)` : ''}`}
							label="Max running"
							lockedProps={lockedProps}
							was={
								form.maxRunning === undefined
									? undefined
									: String(policy.maxRunning)
							}
							value={values.maxRunning}
							onChange={(maxRunning) => update({ maxRunning })}
						/>
						<NumberField
							disabled={locked}
							error={formState.errors.unheldStopDelayMs}
							hint="when nothing holds a stack; data is kept"
							label="Stop after release"
							lockedProps={lockedProps}
							unit="s"
							was={
								form.unheldStopDelaySeconds === undefined
									? undefined
									: String(Math.round(policy.unheldStopDelayMs / 1_000))
							}
							value={values.unheldStopDelaySeconds}
							onChange={(unheldStopDelaySeconds) =>
								update({ unheldStopDelaySeconds })
							}
						/>
						<div className="supabase-field">
							<span className="supabase-field-label">Abandoned grace</span>
							<strong className="supabase-field-static">
								{formatHoldDuration(policy.abandonedGraceMs)}
							</strong>
							<small className="supabase-field-help">
								the same as Simulator holds
							</small>
						</div>
						<NumberField
							disabled={locked}
							error={formState.errors.retentionDays}
							hint="RN Devtools never deletes on its own"
							label="Suggest cleanup"
							lockedProps={lockedProps}
							unit="days"
							was={
								form.retentionDays === undefined
									? undefined
									: String(policy.retentionDays)
							}
							value={values.retentionDays}
							onChange={(retentionDays) => update({ retentionDays })}
						/>
					</div>
				</SettingsSurface>
				<SettingsSurface title="Services">
					<p className="supabase-settings-note">
						Exclude by default · new starts and every resume pass these
						exclusions again.
					</p>
					<SettingSwitch
						description="Turning this off asks first in a system dialog: Studio's SQL endpoint has no authentication while it runs."
						disabled={!editable.allowed || saving}
						label="Studio"
						lockedProps={lockedProps}
						selected={policy.exclude.includes('studio')}
						onChange={(selected) =>
							applyNow({
								exclude: selected
									? [...policy.exclude, 'studio']
									: policy.exclude.filter(
											(capability) => capability !== 'studio'
										),
							})
						}
					/>
					<SettingSwitch
						description="Analytics wakes with Studio and keeps logs in a local service."
						disabled={locked}
						label="Analytics"
						lockedProps={lockedProps}
						selected={values.excludeAnalytics}
						onChange={(excludeAnalytics) => update({ excludeAnalytics })}
					/>
					<SettingSwitch
						description="The connection pooler; most apps talk to the database directly."
						disabled={locked}
						label="Pooler"
						lockedProps={lockedProps}
						selected={values.excludePooler}
						onChange={(excludePooler) => update({ excludePooler })}
					/>
					{formState.errors.exclude ? (
						<p className="sim-field-error">{formState.errors.exclude}</p>
					) : null}
				</SettingsSurface>
				<SettingsSurface title="Safety">
					<SettingSwitch
						description="They listen on every interface; they are never attached to a lane."
						disabled={locked}
						label="Stop Docker or Podman stacks on managed worktrees, once per session"
						lockedProps={lockedProps}
						selected={values.stopContainerStacksOnce}
						onChange={(stopContainerStacksOnce) =>
							update({ stopContainerStacksOnce })
						}
					/>
					<SettingSwitch
						description="Patch releases of the verified Supabase CLI line pass a live contract check first. Turning this on asks first in a system dialog."
						disabled={!editable.allowed || saving}
						label="Allow unverified patch releases"
						lockedProps={lockedProps}
						selected={policy.allowUnverifiedPatch}
						onChange={(allowUnverifiedPatch) =>
							applyNow({ allowUnverifiedPatch })
						}
					/>
				</SettingsSurface>
				<AppVariables
					error={formState.errors.appEnv}
					errors={formState.errors}
					locked={locked}
					lockedProps={lockedProps}
					policy={policy}
					rows={values.appEnv}
					onChange={(appEnv) => update({ appEnv })}
				/>
				<SettingsSurface title="Lane defaults">
					<p className="supabase-settings-note">
						Auto · Off · Required is a per-lane choice in the Lanes start form.
					</p>
					<div className="supabase-lane-defaults">
						{values.laneDefaults.map((entry) => (
							<div className="supabase-field" key={entry.environmentId}>
								<span className="supabase-field-label">
									{entry.environmentId}
								</span>
								<SupabaseSelect
									{...(editable.allowed ? {} : { describedBy: offReasonId })}
									disabled={locked}
									label={`Lane default for ${entry.environmentId}`}
									options={[
										{ value: 'auto', label: 'Auto' },
										{ value: 'off', label: 'Off' },
									]}
									value={entry.backend}
									onChange={(backend) =>
										update({
											laneDefaults: values.laneDefaults.map((candidate) =>
												candidate.environmentId === entry.environmentId
													? { ...candidate, backend }
													: candidate
											),
										})
									}
								/>
							</div>
						))}
					</div>
					{formState.errors.laneDefaults ? (
						<p className="sim-field-error">{formState.errors.laneDefaults}</p>
					) : null}
				</SettingsSurface>
				<RepositoryModes
					isBridgeAvailable={isBridgeAvailable}
					state={state}
					onOpenRepositories={onOpenRepositories}
				/>
				<SettingsSurface title="Branch switch and paths">
					<div className="supabase-field">
						<span className="supabase-field-label">Branch switch</span>
						<fieldset className="sim-layout-toggle supabase-segmented">
							<legend className="sr-only">Branch switch</legend>
							{(['follow', 'warn'] as const).map((mode) => (
								<Button
									{...lockedProps}
									aria-pressed={values.branchSwitch === mode}
									isDisabled={locked}
									key={mode}
									size="sm"
									variant={values.branchSwitch === mode ? 'secondary' : 'ghost'}
									onPress={() => update({ branchSwitch: mode })}
								>
									{mode === 'follow' ? 'Follow' : 'Warn'}
								</Button>
							))}
						</fieldset>
						<small className="supabase-field-help">
							{values.branchSwitch === 'follow'
								? 'Follow moves held stacks after HEAD is stable for 30 s and no rebase or merge is running.'
								: 'Warn keeps the stack on its branch and says so; switching back reattaches it.'}
						</small>
					</div>
					<PathRows
						isBridgeAvailable={isBridgeAvailable}
						state={state}
						onChoose={(field) => void run({ kind: 'choose-path', field })}
					/>
				</SettingsSurface>
				<SettingsSurface title="Hardening (optional)">
					<p className="supabase-settings-note">
						Optional per-stack keys, compatible port allocation, and eager
						service startup. Each is off by default.
					</p>
					<SettingSwitch
						description="Writes a full key set into each worktree's gitignored supabase/.env.local, with the signing key in a 0600 file outside the repository. Agents' own restarts keep the keys. Turning this on asks first in a system dialog."
						disabled={!editable.allowed || saving}
						label="Per-stack keys"
						lockedProps={lockedProps}
						selected={policy.perStackKeys}
						warning="Changes worktree files: commit nothing from supabase/.env.local."
						onChange={(perStackKeys) => applyNow({ perStackKeys })}
					/>
					<SettingSwitch
						description="Leases a block of SUPABASE_*_PORT values from a range RN Devtools owns, so repositories that pin ports can run several worktrees."
						disabled={!editable.allowed || saving}
						label="Pinned-ports compatibility"
						lockedProps={lockedProps}
						selected={policy.pinnedPortsCompat}
						warning="Only for repositories that pin ports; others need nothing."
						onChange={(pinnedPortsCompat) => applyNow({ pinnedPortsCompat })}
					/>
					<SettingSwitch
						description="Lanes start every service at once instead of on first request, for UI automation that can't wait for a service to wake."
						disabled={!editable.allowed || saving}
						label="Eager lanes"
						lockedProps={lockedProps}
						selected={policy.eagerLanes}
						warning="Uses about 1 GB more memory per running lane stack."
						onChange={(eagerLanes) => applyNow({ eagerLanes })}
					/>
				</SettingsSurface>
			</div>
			<SettingsFooter
				applyReason={applyReason}
				changes={formState.changes}
				saving={saving}
				onApply={() => void apply()}
				onReset={() => setForm({})}
			/>
		</div>
	);
}

function SettingsSurface({
	title,
	actions,
	children,
}: {
	title: string;
	actions?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="sim-surface supabase-settings-surface">
			<header className="sim-surface-header">
				<h2>{title}</h2>
				{actions}
			</header>
			<div className="supabase-settings-body">{children}</div>
		</section>
	);
}

function FeatureSurface({
	state,
	isBridgeAvailable,
	headingRef,
	onSetEnabled,
	onOpenRepositories,
}: {
	state: SupabaseState;
	isBridgeAvailable: boolean;
	headingRef: RefObject<HTMLHeadingElement | null>;
	onSetEnabled: (enabled: boolean) => void;
	onOpenRepositories: () => void;
}) {
	const { isPending } = useSupabaseActions();
	const switchReasonId = useId();
	const enabled = state.feature.enabled;
	const availability = supabaseGlobalActionAvailability(
		enabled ? 'turn-off' : 'turn-on',
		{
			bridgeAvailable: isBridgeAvailable,
			state,
			pending: isPending('feature'),
		}
	);
	const disabling = state.feature.disabling;
	const cli = supabaseCliReadiness(state);
	const platform = state.availability.platform;
	const engines = [
		`Docker ${state.engines.docker === 'found' ? 'found · never used' : 'not found'}`,
		`Podman ${state.engines.podman === 'found' ? 'found · never used' : 'not found'}`,
	];
	return (
		<section className="sim-surface supabase-settings-surface">
			<header className="sim-surface-header">
				<h2 ref={headingRef} tabIndex={-1}>
					Local Supabase (alpha)
				</h2>
				<div className="supabase-feature-switch">
					<Switch
						{...(availability.allowed
							? {}
							: { 'aria-describedby': switchReasonId })}
						aria-label="Local Supabase"
						isDisabled={!availability.allowed}
						isSelected={enabled}
						size="sm"
						onChange={onSetEnabled}
					>
						<Switch.Content>
							<span className="supabase-switch-label">
								{isPending('feature')
									? enabled
										? 'Turning off…'
										: 'Turning on…'
									: enabled
										? 'On'
										: 'Off'}
							</span>
						</Switch.Content>
						<Switch.Control>
							<Switch.Thumb />
						</Switch.Control>
					</Switch>
					<span className="supabase-field-hint">
						{enabled ? 'Turn off…' : 'Turn on…'}
					</span>
				</div>
			</header>
			<div className="supabase-settings-body">
				{availability.allowed ? null : (
					<DisabledReason id={switchReasonId}>
						{availability.reason}
					</DisabledReason>
				)}
				{disabling ? (
					<p className="supabase-progress-line" role="status">
						{supabaseDisablingText(disabling)}
					</p>
				) : null}
				{state.feature.policyHealth === 'quarantined' ? (
					<SupabaseNotice
						inset
						title="Supabase settings couldn't be read."
						tone="danger"
					>
						Local Supabase was turned off, the file was set aside and defaults
						restored. Running stacks were left as they are.
					</SupabaseNotice>
				) : null}
				<div className="sim-capability-list">
					<ReadinessRow
						detail={supabasePlatformLabel(platform)}
						icon={Laptop}
						label="Platform"
						status={platform.supported ? 'ready' : 'needs-fix'}
						{...(platform.supported ? {} : { statusLabel: 'Not available' })}
					/>
					<ReadinessRow
						actions={
							<Button size="sm" variant="ghost" onPress={onOpenRepositories}>
								Open Repositories
							</Button>
						}
						detail={cli.text}
						icon={SquareTerminal}
						label="Supabase CLI"
						status={cli.status}
						{...(cli.status === 'needs-fix'
							? { statusLabel: 'Needs setup' }
							: {})}
					/>
				</div>
				<dl className="supabase-facts">
					<KeyValue label="Container engines" value={engines.join(' · ')} />
					<KeyValue label="Supabase home" mono value={state.home.label} />
					<KeyValue
						label="Postgres slots"
						value={
							state.capacity.sysv
								? `${state.capacity.sysv.used} of ${state.capacity.sysv.limit} in use`
								: 'not measured'
						}
					/>
					<KeyValue
						label="Trust model"
						value={
							state.feature.acknowledgedAt === undefined
								? 'not accepted yet; turning on asks first'
								: `accepted ${acknowledgedFormat.format(state.feature.acknowledgedAt)}`
						}
					/>
				</dl>
			</div>
		</section>
	);
}

function NumberField({
	label,
	value,
	unit,
	hint,
	error,
	was,
	disabled,
	lockedProps,
	onChange,
}: {
	label: string;
	value: string;
	unit?: string;
	hint: string;
	error?: string | undefined;
	was?: string | undefined;
	disabled: boolean;
	lockedProps: Readonly<{ 'aria-describedby'?: string }>;
	onChange: (value: string) => void;
}) {
	const errorId = useId();
	const describedBy = [lockedProps['aria-describedby'], error ? errorId : '']
		.filter(Boolean)
		.join(' ');
	return (
		<div className="supabase-field">
			<span className="supabase-field-label">{label}</span>
			<span className="supabase-field-input">
				<Input
					{...(describedBy ? { 'aria-describedby': describedBy } : {})}
					aria-invalid={error ? true : undefined}
					aria-label={label}
					disabled={disabled}
					inputMode="numeric"
					value={value}
					onChange={(event) => onChange(event.currentTarget.value)}
				/>
				{unit ? <span className="supabase-field-unit">{unit}</span> : null}
				{was !== undefined && was !== value ? (
					<span className="supabase-field-was">was {was}</span>
				) : null}
			</span>
			<small className="supabase-field-help">{hint}</small>
			{error ? (
				<p className="sim-field-error" id={errorId}>
					{error}
				</p>
			) : null}
		</div>
	);
}

function SettingSwitch({
	label,
	description,
	warning,
	selected,
	disabled,
	lockedProps,
	onChange,
}: {
	label: string;
	description: string;
	warning?: string;
	selected: boolean;
	disabled: boolean;
	lockedProps: Readonly<{ 'aria-describedby'?: string }>;
	onChange: (selected: boolean) => void;
}) {
	return (
		<div className="supabase-switch-row">
			<Switch
				{...lockedProps}
				aria-label={label}
				isDisabled={disabled}
				isSelected={selected}
				size="sm"
				onChange={onChange}
			>
				<Switch.Content>
					<span className="sim-switch-copy">
						<strong>{label}</strong>
						<small>{description}</small>
						{warning ? (
							<small className="supabase-switch-warning">{warning}</small>
						) : null}
					</span>
				</Switch.Content>
				<Switch.Control>
					<Switch.Thumb />
				</Switch.Control>
			</Switch>
		</div>
	);
}

function AppVariables({
	policy,
	rows,
	errors,
	error,
	locked,
	lockedProps,
	onChange,
}: {
	policy: SupabasePolicy;
	rows: readonly AppEnvRow[];
	errors: Readonly<Record<string, string>>;
	error: string | undefined;
	locked: boolean;
	lockedProps: Readonly<{ 'aria-describedby'?: string }>;
	onChange: (rows: readonly AppEnvRow[]) => void;
}) {
	const addReasonId = useId();
	const full = rows.length >= 8;
	const presetApplied = sameAppEnv(rows, policy.appEnvPreset);
	return (
		<SettingsSurface
			actions={
				<InfoPopover label="App variables">
					Metro gets these names for each lane, with values from the lane's own
					stack. Values stay in RN Devtools; nothing is written to a .env file.
				</InfoPopover>
			}
			title="App variables"
		>
			<p className="supabase-settings-note">
				Names Metro gets for each lane; values stay in RN Devtools.
			</p>
			{rows.length === 0 ? (
				<p className="sim-section-empty">No app variables are mapped.</p>
			) : (
				<ul className="supabase-app-env-form">
					{rows.map((row, index) => {
						const rowError = errors[`appEnv.${index}`];
						return (
							<AppVariableRow
								error={rowError}
								index={index}
								key={index}
								locked={locked}
								lockedProps={lockedProps}
								row={row}
								onChange={(next) =>
									onChange(
										rows.map((candidate, position) =>
											position === index ? next : candidate
										)
									)
								}
								onRemove={() =>
									onChange(rows.filter((_, position) => position !== index))
								}
							/>
						);
					})}
				</ul>
			)}
			{error ? <p className="sim-field-error">{error}</p> : null}
			<div className="supabase-settings-actions">
				<Button
					{...(full ? { 'aria-describedby': addReasonId } : lockedProps)}
					isDisabled={locked || full}
					size="sm"
					variant="ghost"
					onPress={() => onChange([...rows, { name: '', source: 'API_URL' }])}
				>
					<Plus aria-hidden="true" className="h-3.5 w-3.5" />
					Add variable
				</Button>
				<Button
					{...lockedProps}
					aria-pressed={presetApplied}
					isDisabled={locked}
					size="sm"
					variant="ghost"
					onPress={() => onChange(policy.appEnvPreset)}
				>
					<ListChecks aria-hidden="true" className="h-3.5 w-3.5" />
					Use Supabase + Expo preset
				</Button>
				{full ? (
					<DisabledReason id={addReasonId}>
						{SUPABASE_POLICY_ERRORS.appEnvCount}
					</DisabledReason>
				) : null}
			</div>
		</SettingsSurface>
	);
}

function AppVariableRow({
	row,
	index,
	error,
	locked,
	lockedProps,
	onChange,
	onRemove,
}: {
	row: AppEnvRow;
	index: number;
	error: string | undefined;
	locked: boolean;
	lockedProps: Readonly<{ 'aria-describedby'?: string }>;
	onChange: (row: AppEnvRow) => void;
	onRemove: () => void;
}) {
	const errorId = useId();
	const describedBy = [lockedProps['aria-describedby'], error ? errorId : '']
		.filter(Boolean)
		.join(' ');
	return (
		<li>
			<Input
				{...(describedBy ? { 'aria-describedby': describedBy } : {})}
				aria-invalid={error ? true : undefined}
				aria-label={`App variable ${index + 1} name`}
				className="supabase-app-env-name"
				disabled={locked}
				placeholder="EXPO_PUBLIC_…"
				value={row.name}
				onChange={(event) =>
					onChange({ ...row, name: event.currentTarget.value.toUpperCase() })
				}
			/>
			<span aria-hidden="true" className="supabase-app-env-arrow">
				←
			</span>
			<SupabaseSelect
				disabled={locked}
				label={`App variable ${index + 1} value`}
				options={APP_ENV_SOURCES.map((source) => ({
					value: source,
					label: source,
				}))}
				value={row.source}
				onChange={(source) => onChange({ ...row, source })}
			/>
			<Button
				{...lockedProps}
				aria-label={`Remove ${row.name || `app variable ${index + 1}`}`}
				className="sim-icon-button"
				isDisabled={locked}
				isIconOnly
				size="sm"
				variant="ghost"
				onPress={onRemove}
			>
				<X aria-hidden="true" className="h-3.5 w-3.5" />
			</Button>
			{error ? (
				<p className="sim-field-error" id={errorId}>
					{error}
				</p>
			) : null}
		</li>
	);
}

function RepositoryModes({
	state,
	isBridgeAvailable,
	onOpenRepositories,
}: {
	state: SupabaseState;
	isBridgeAvailable: boolean;
	onOpenRepositories: () => void;
}) {
	const { run, isPending } = useSupabaseActions();
	return (
		<SettingsSurface
			actions={
				<Button size="sm" variant="ghost" onPress={onOpenRepositories}>
					Open Repositories
				</Button>
			}
			title="Repositories"
		>
			<p className="supabase-settings-note">
				Use local Supabase here · Off never stops running stacks; lanes in that
				repository just get no database.
			</p>
			{state.repositories.length === 0 ? (
				<p className="sim-section-empty">
					No repository is tracked in Lanes yet.
				</p>
			) : (
				<div className="supabase-repository-modes">
					{state.repositories.map((repository) => (
						<RepositoryMode
							busy={isPending(`repository:${repository.id}`)}
							key={repository.id}
							repository={repository}
							state={state}
							isBridgeAvailable={isBridgeAvailable}
							onChange={(mode) =>
								void run({
									kind: 'repository.set-mode',
									repositoryId: repository.id,
									mode,
								})
							}
						/>
					))}
				</div>
			)}
		</SettingsSurface>
	);
}

function RepositoryMode({
	repository,
	state,
	isBridgeAvailable,
	busy,
	onChange,
}: {
	repository: SupabaseState['repositories'][number];
	state: SupabaseState;
	isBridgeAvailable: boolean;
	busy: boolean;
	onChange: (mode: 'auto' | 'off') => void;
}) {
	const reasonId = useId();
	const availability = supabaseRepositoryActionAvailability(
		repository,
		'set-mode',
		{ bridgeAvailable: isBridgeAvailable, state }
	);
	return (
		<div className="supabase-field">
			<span className="supabase-field-label supabase-mono">
				{repository.label}
			</span>
			<SupabaseSelect
				describedBy={availability.allowed ? undefined : reasonId}
				disabled={!availability.allowed || busy}
				label={`Use local Supabase in ${repository.label}`}
				options={[
					{ value: 'auto', label: 'Auto' },
					{ value: 'off', label: 'Off' },
				]}
				value={repository.mode}
				onChange={onChange}
			/>
			{availability.allowed ? null : (
				<DisabledReason id={reasonId}>{availability.reason}</DisabledReason>
			)}
		</div>
	);
}

function PathRows({
	state,
	isBridgeAvailable,
	onChoose,
}: {
	state: SupabaseState;
	isBridgeAvailable: boolean;
	onChoose: (field: 'supabase-home' | 'ssl-cert') => void;
}) {
	const { isPending } = useSupabaseActions();
	const reasonId = useId();
	const availability = supabaseGlobalActionAvailability('choose-path', {
		bridgeAvailable: isBridgeAvailable,
		state,
	});
	const rows = [
		{
			field: 'supabase-home' as const,
			label: 'Supabase home',
			value: state.policy.paths.supabaseHomeLabel,
		},
		{
			field: 'ssl-cert' as const,
			label: 'Extra CA certificates',
			value: state.policy.paths.sslCertLabel ?? 'none',
		},
	];
	return (
		<div className="supabase-paths">
			{rows.map((row) => (
				<div className="supabase-path-row" key={row.field}>
					<span className="supabase-field-label">{row.label}</span>
					<code className="supabase-path-value">{row.value}</code>
					<Button
						{...(availability.allowed ? {} : { 'aria-describedby': reasonId })}
						aria-label={`Choose ${row.label}…`}
						isDisabled={!availability.allowed || isPending(`path:${row.field}`)}
						size="sm"
						variant="ghost"
						onPress={() => onChoose(row.field)}
					>
						<FolderOpen aria-hidden="true" className="h-3.5 w-3.5" />
						Choose…
					</Button>
				</div>
			))}
			{availability.allowed ? null : (
				<DisabledReason id={reasonId}>{availability.reason}</DisabledReason>
			)}
		</div>
	);
}

function SettingsFooter({
	changes,
	applyReason,
	saving,
	onApply,
	onReset,
}: {
	changes: number;
	applyReason: string | undefined;
	saving: boolean;
	onApply: () => void;
	onReset: () => void;
}) {
	const reasonId = useId();
	const statusId = useId();
	return (
		<div className="supabase-settings-footer">
			<span className="supabase-settings-changes" id={statusId} role="status">
				{changes === 0
					? 'No unsaved changes. Change a value to apply.'
					: `${changes} unsaved ${changes === 1 ? 'change' : 'changes'}`}
			</span>
			{applyReason && changes > 0 ? (
				<DisabledReason id={reasonId}>{applyReason}</DisabledReason>
			) : null}
			<Button
				{...(changes === 0 ? { 'aria-describedby': statusId } : {})}
				isDisabled={changes === 0 || saving}
				size="sm"
				variant="ghost"
				onPress={onReset}
			>
				<RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
				Reset
			</Button>
			<Button
				{...(applyReason === undefined
					? {}
					: { 'aria-describedby': changes > 0 ? reasonId : statusId })}
				isDisabled={applyReason !== undefined || saving}
				size="sm"
				variant="primary"
				onPress={onApply}
			>
				<Check aria-hidden="true" className="h-3.5 w-3.5" />
				{saving
					? 'Applying…'
					: changes > 1
						? `Apply ${changes} changes`
						: 'Apply'}
			</Button>
		</div>
	);
}

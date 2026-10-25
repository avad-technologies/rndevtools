import { createHash, randomUUID } from 'node:crypto';
import { redactDiagnosticText } from '@rndevtools/core/redact';
import type { DeviceAccessDecision } from '../shared/device-hold';
import type {
	SlimmingAcknowledgementReceipt,
	SlimmingAcknowledgementRequest,
	SlimmingAction,
	SlimmingActionReceipt,
	SlimmingCheckpointMetadata,
	SlimmingCompatibility,
	SlimmingCondition,
	SlimmingJob,
	SlimmingOperationMetadata,
	SlimmingSettingReceipt,
	SlimmingSettingRequest,
	SlimmingSimulator,
	SlimmingSimulatorStatus,
	SlimmingState,
} from '../shared/slimming-protocol';
import {
	type SlimmingRequester,
	slimmingAcknowledgementRequestSchema,
	slimmingActionSchema,
	slimmingSettingRequestSchema,
	slimmingStateSchema,
} from '../shared/slimming-protocol';
import { safeErrorText } from './security';
import {
	compatibilityForPublic,
	mutationEvidenceFromError,
	SimHelperClient,
	type SimHelperCompatibility,
	type SimHelperDevice,
	SimHelperError,
	type SimHelperHandshake,
	type SimHelperMutation,
	type SimHelperStatus,
} from './sim-helper-client';
import {
	SimulatorMutationCoordinator,
	type SimulatorMutationCoordinatorPort,
	type SimulatorMutationLease,
} from './simulator-mutation-coordinator';
import {
	type PendingSlimmingMutation,
	type PersistedSlimmingSetting,
	SlimmingPersistence,
} from './slimming-persistence';

/** Answers whether `requester` (an agent, or the operator when undefined) may mutate the device. */
export type DeviceAccessPort = (
	simulatorUdid: string,
	requester: SlimmingRequester | undefined
) => DeviceAccessDecision;

const DEFAULT_POLL_INTERVAL_MS = 15_000;
/** The longest a record that stays ambiguous waits between inspections. */
const MAX_RECONCILE_BACKOFF_MS = 10 * 60_000;
const MAX_JOBS = 100;
const ACTIVE_JOB_STATUSES = new Set([
	'queued',
	'preflight',
	'running',
	'verifying',
	'rolling-back',
]);
const MUTATION_KINDS = new Set([
	'profile.apply',
	'profile.restore',
	'profile.undo',
]);
/**
 * Jobs that run under the shared per-Simulator lease: the mutations, and
 * forgetting a pending record, which must not interleave with them or with
 * reconciliation of that record.
 */
const LEASED_KINDS = new Set([...MUTATION_KINDS, 'pending.forget']);
const PENDING_RECORD_MESSAGE =
	'An interrupted mutation left a durable emergency restore point. Use Undo to restore it; other mutations are blocked. If Undo can no longer succeed, for example after an Xcode, runtime, or helper update, forget the restore point.';
const PENDING_RECORD_SHUTDOWN_MESSAGE =
	'An interrupted mutation left a durable emergency restore point. Boot this Simulator so RN Devtools can reconcile it, or use Undo to restore it; other mutations are blocked. If Undo can no longer succeed, forget the restore point.';

/**
 * When a pending record is next inspected. `key` names what was inspected:
 * the record, its recovery attempt, and the Simulator's state; a new key
 * starts the schedule over.
 */
type ReconcileSchedule = {
	key: string;
	attempts: number;
	nextAt: number;
	message?: string | undefined;
};
const NO_MUTATION_ERROR_CODES = new Set([
	'checkpoint_required',
	'invalid_checkpoint',
	'checkpoint_simulator_mismatch',
	'checkpoint_tuple_mismatch',
	'checkpoint_state_mismatch',
	'checkpoint_intent_mismatch',
	'checkpoint_not_representable',
	'mutation_target_not_representable',
	'preexisting_state_unverified',
	'process_mapping_inconclusive',
	'experimental_acknowledgement_required',
	'limited_operation_blocked',
	'mutation_policy_blocked',
	// The helper denies these before it constructs the simulator service
	// (cmd/rndevtools-sim-helper/main.go), and Electron raises the broker one before
	// spawning anything, so neither can have touched a Simulator. Leaving them
	// out reported a refused attestation as a mutation needing restart
	// reconciliation.
	'mutation_authorization_required',
	'mutation_broker_unavailable',
]);

export type SlimmingHelperProvider = Pick<
	SimHelperClient,
	| 'handshake'
	| 'listSimulators'
	| 'listProfiles'
	| 'simulatorStatus'
	| 'previewProfile'
	| 'verifyProfile'
	| 'doctor'
	| 'prepareMutation'
	| 'applyProfile'
	| 'restoreManaged'
	| 'undoLast'
>;

type SlimmingListener = (state: SlimmingState) => void;
type InternalJob = {
	public: SlimmingJob;
	controller: AbortController;
	action: SlimmingAction;
	disableWhenFinished: boolean;
	mutationLease?: SimulatorMutationLease;
	emergencyRecoveryTargets: Set<string>;
};

function helperStateFromError(error: unknown): SlimmingState['helper'] {
	const kind =
		error && typeof error === 'object' && 'kind' in error
			? (error as { kind?: unknown }).kind
			: undefined;
	return {
		status: kind === 'untrusted' ? 'untrusted' : 'unavailable',
		readOnlyAvailable: false,
		error: safeErrorText(error),
	};
}

function mapDeviceState(
	state: string
): SlimmingState['simulators'][number]['state'] {
	switch (state.toLowerCase()) {
		case 'booted':
			return 'booted';
		case 'shutdown':
			return 'shutdown';
		case 'booting':
			return 'booting';
		case 'shutting down':
		case 'shutting-down':
			return 'shutting-down';
		case 'creating':
			return 'creating';
		default:
			return 'unknown';
	}
}

function mutationOperation(
	action: SlimmingAction
): 'apply_profile' | 'restore_managed' | 'undo_last' | undefined {
	if (action.kind === 'profile.apply') return 'apply_profile';
	if (action.kind === 'profile.restore') return 'restore_managed';
	if (action.kind === 'profile.undo') return 'undo_last';
	return undefined;
}

function profileId(action: SlimmingAction): string | undefined {
	return 'profileId' in action ? action.profileId : undefined;
}

function conditionForStatus(
	status: Pick<
		SlimmingSimulatorStatus,
		'managedDisabledCount' | 'matchingProfileIds' | 'checkpointAvailable'
	>
): SlimmingCondition {
	if (status.managedDisabledCount === 0) return 'managed-clean';
	if (status.matchingProfileIds.length > 0) return 'profile-match';
	return status.checkpointAvailable ? 'drifted' : 'partial';
}

function sameManagedServiceSet(
	left: readonly string[],
	right: readonly string[]
): boolean {
	if (left.length !== right.length) return false;
	const sortedLeft = [...left].sort();
	const sortedRight = [...right].sort();
	return sortedLeft.every(
		(serviceId, index) => serviceId === sortedRight[index]
	);
}

function actionKindForMutation(
	operation: 'apply_profile' | 'restore_managed' | 'undo_last'
): 'profile.apply' | 'profile.restore' | 'profile.undo' {
	if (operation === 'apply_profile') return 'profile.apply';
	if (operation === 'restore_managed') return 'profile.restore';
	return 'profile.undo';
}

const MAX_EVIDENCE_IDS = 8;

function abbreviatedIds(ids: readonly string[]): string {
	const shown = ids.slice(0, MAX_EVIDENCE_IDS).join(', ');
	return ids.length > MAX_EVIDENCE_IDS
		? `${shown} (+${ids.length - MAX_EVIDENCE_IDS} more)`
		: shown;
}

/**
 * The helper's own account of a failed mutation: its failure code, the prose
 * from the layer that refused, and the exact services or processes that did
 * not verify. Reducing all of that to one fixed sentence left a rolled-back
 * apply indistinguishable from any other.
 */
function mutationFailureDetail(error: unknown): string {
	const evidence =
		error instanceof SimHelperError
			? mutationEvidenceFromError(error)
			: undefined;
	if (!evidence) return '';
	const parts: string[] = [];
	if (evidence.failureCode)
		parts.push(`helper failure ${evidence.failureCode}`);
	if (evidence.failureDetail) parts.push(evidence.failureDetail);
	const verification = evidence.verification;
	if (!verification.verified) {
		if (!verification.overridesMatch) {
			const missing = abbreviatedIds(verification.missingDisabledServiceIds);
			const unexpected = abbreviatedIds(
				verification.unexpectedDisabledServiceIds
			);
			parts.push(
				`overrides did not match${missing ? `; missing: ${missing}` : ''}${unexpected ? `; unexpected: ${unexpected}` : ''}`
			);
		}
		if (!verification.disabledLaunchdJobRegistrationsAbsent) {
			parts.push(
				`still registered: ${abbreviatedIds(verification.registeredDisabledLaunchdJobIds)}`
			);
		}
		if (!verification.observedPreMutationProcessesAbsent) {
			parts.push(
				`still running: ${abbreviatedIds(verification.presentObservedProcessNames)}`
			);
		}
	}
	parts.push(
		evidence.rollback.attempted
			? evidence.rollback.succeeded
				? 'rollback succeeded'
				: `rollback failed${evidence.rollback.errorCode ? ` (${evidence.rollback.errorCode})` : ''}`
			: 'rollback not attempted'
	);
	return ` [${parts.join('; ')}]`;
}

function describeMutationFailure(error: unknown): string {
	return `${safeErrorText(error)}${redactDiagnosticText(mutationFailureDetail(error))}`.slice(
		0,
		4 * 1024
	);
}

function mutationFailureIsProvenSafe(error: unknown): boolean {
	const evidence =
		error instanceof SimHelperError
			? mutationEvidenceFromError(error)
			: undefined;
	return (
		Boolean(evidence?.rollback.succeeded) ||
		(error instanceof SimHelperError && NO_MUTATION_ERROR_CODES.has(error.code))
	);
}

function compatibilityKey(
	compatibility: SimHelperCompatibility,
	handshake: SimHelperHandshake,
	appVersion: string
): string {
	const canonical = JSON.stringify({
		appVersion,
		helperVersion: handshake.helperVersion,
		buildCommit: handshake.buildCommit,
		matrixVersion: compatibility.matrixVersion,
		tuple: compatibility.tuple,
	});
	return `compatibility-${createHash('sha256').update(canonical).digest('hex')}`;
}

export class SlimmingService {
	readonly #helper: SlimmingHelperProvider;
	readonly #persistence: SlimmingPersistence;
	readonly #appVersion: string;
	readonly #mutationUnavailableReason: string | undefined;
	readonly #now: () => number;
	readonly #pollIntervalMs: number;
	readonly #mutationCoordinator: SimulatorMutationCoordinatorPort;
	readonly #deviceAccess: DeviceAccessPort | undefined;
	readonly #listeners = new Set<SlimmingListener>();
	readonly #jobs: InternalJob[] = [];
	readonly #tasks = new Set<Promise<void>>();
	#queue: Promise<void> = Promise.resolve();
	#mutationQueue: Promise<void> = Promise.resolve();
	#refreshPromise: Promise<SlimmingState> | undefined;
	#pollingActive = true;
	#pollTimer: NodeJS.Timeout | undefined;
	#stopped = false;
	/** Aborted by stop(), so background reconciliation takes no new lease. */
	#lifecycle = new AbortController();
	/**
	 * The first reconciliation pass after start() is restart reconciliation:
	 * the one pass that may boot a shut-down Simulator to inspect it.
	 */
	#restartReconciliationDue = false;
	readonly #reconcileSchedule = new Map<string, ReconcileSchedule>();
	#persistenceHealthy = true;
	#handshake: SimHelperHandshake | undefined;
	#state: SlimmingState;

	constructor({
		resourceDirectory,
		persistenceDirectory,
		appVersion,
		mutationUnavailableReason,
		helper = new SimHelperClient({ resourceDirectory, appVersion }),
		mutationCoordinator = new SimulatorMutationCoordinator(),
		deviceAccess,
		pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
		now = Date.now,
	}: {
		resourceDirectory: string;
		persistenceDirectory: string;
		appVersion: string;
		mutationUnavailableReason?: string;
		helper?: SlimmingHelperProvider;
		mutationCoordinator?: SimulatorMutationCoordinatorPort;
		/**
		 * Who holds each device. When set, a mutation on a device another
		 * session holds is refused for every caller, agent or GUI alike.
		 */
		deviceAccess?: DeviceAccessPort;
		pollIntervalMs?: number;
		now?: () => number;
	}) {
		this.#helper = helper;
		this.#mutationCoordinator = mutationCoordinator;
		this.#deviceAccess = deviceAccess;
		this.#persistence = new SlimmingPersistence(persistenceDirectory);
		this.#appVersion = appVersion;
		this.#mutationUnavailableReason = mutationUnavailableReason;
		this.#now = now;
		this.#pollIntervalMs =
			Number.isFinite(pollIntervalMs) && pollIntervalMs >= 1_000
				? pollIntervalMs
				: DEFAULT_POLL_INTERVAL_MS;
		this.#state = {
			revision: 0,
			updatedAt: now(),
			setting: { experimentalMutationsEnabled: false },
			helper: { status: 'checking', readOnlyAvailable: false },
			categories: [],
			profiles: [],
			simulators: [],
			statusBySimulator: {},
			previewBySimulator: {},
			doctorBySimulator: {},
			jobs: [],
			checkpointBySimulator: {},
			operationsBySimulator: {},
		};
	}

	getState(): SlimmingState {
		return slimmingStateSchema.parse({
			...this.#state,
			jobs: this.#jobs.map((job) => job.public),
		});
	}

	subscribe(listener: SlimmingListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	setPollingActive(active: boolean): void {
		if (this.#pollingActive === active) return;
		this.#pollingActive = active;
		if (active && !this.#stopped) void this.refresh().catch(() => undefined);
	}

	async start(): Promise<void> {
		this.#stopped = false;
		this.#lifecycle = new AbortController();
		this.#restartReconciliationDue = true;
		try {
			const persisted = await this.#persistence.load();
			this.#state.setting = persisted.setting;
			this.#state.checkpointBySimulator = persisted.checkpointBySimulator;
			this.#state.operationsBySimulator = persisted.operationsBySimulator;
		} catch (error) {
			this.#persistenceHealthy = false;
			this.#state.setting = {
				experimentalMutationsEnabled: false,
				disabledDisposition: 'restore-failed',
				warning: `Safety state could not load. Mutations are blocked: ${safeErrorText(error)}`,
			};
		}
		await this.refresh();
		if (this.#stopped || this.#pollTimer) return;
		this.#pollTimer = setInterval(() => {
			// Recovery remains supervised even with every window hidden, at the
			// pace reconciliation backs off to. Running jobs own their
			// verification; idle discovery does not need to wake simulators.
			if (!this.#pollingActive && !this.#reconciliationDue()) return;
			void this.refresh().catch(() => undefined);
		}, this.#pollIntervalMs);
		this.#pollTimer.unref();
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		this.#lifecycle.abort();
		if (this.#pollTimer) clearInterval(this.#pollTimer);
		this.#pollTimer = undefined;
		for (const job of this.#jobs) {
			if (!ACTIVE_JOB_STATUSES.has(job.public.status)) continue;
			job.controller.abort();
			if (job.public.status === 'queued') {
				job.public = {
					...job.public,
					status: 'cancelled',
					progressSequence: job.public.progressSequence + 1,
					phase: 'cancelled',
					finishedAt: this.#now(),
					message: 'Cancelled during shutdown.',
					targets: job.public.targets.map((target) => ({
						...target,
						status: 'cancelled',
						message: 'Cancelled during shutdown.',
					})),
				};
			}
		}
		await Promise.allSettled([...this.#tasks]);
		this.#touch();
	}

	refresh(): Promise<SlimmingState> {
		if (this.#jobs.some((job) => ACTIVE_JOB_STATUSES.has(job.public.status))) {
			return Promise.resolve(this.getState());
		}
		if (this.#refreshPromise) return this.#refreshPromise;
		const refresh = this.#refreshInternal().finally(() => {
			if (this.#refreshPromise === refresh) this.#refreshPromise = undefined;
		});
		this.#refreshPromise = refresh;
		return refresh;
	}

	async setEnabled(
		value: SlimmingSettingRequest
	): Promise<SlimmingSettingReceipt> {
		let request = slimmingSettingRequestSchema.parse(value);
		if (!request.enabled && request.disposition === 'restore-and-verify') {
			request = slimmingSettingRequestSchema.parse({
				...request,
				simulatorUdids: this.#canonicalSimulatorUdids(request.simulatorUdids),
			});
		}
		if (!this.#persistenceHealthy) {
			return {
				actionId: request.actionId,
				accepted: false,
				state: this.getState(),
				error: 'Mutations are blocked because the safety state could not load.',
			};
		}
		if (request.enabled) {
			const setting: PersistedSlimmingSetting = {
				experimentalMutationsEnabled: true,
				updatedAt: this.#now(),
			};
			await this.#persistence.setSetting(setting);
			this.#state.setting = setting;
			this.#touch();
			return {
				actionId: request.actionId,
				accepted: true,
				state: this.getState(),
			};
		}
		const hasManagedOverrides = Object.values(
			this.#state.statusBySimulator
		).some(
			(status) =>
				status.managedDisabledCount > 0 ||
				(status.checkpointAvailable &&
					['unknown', 'needs-attention'].includes(status.condition))
		);
		if (!hasManagedOverrides) {
			const setting: PersistedSlimmingSetting = {
				experimentalMutationsEnabled: false,
				updatedAt: this.#now(),
			};
			await this.#persistence.setSetting(setting);
			this.#state.setting = setting;
			this.#touch();
			return {
				actionId: request.actionId,
				accepted: true,
				state: this.getState(),
			};
		}
		if (request.disposition === 'leave-overrides-in-place') {
			const setting: PersistedSlimmingSetting = {
				experimentalMutationsEnabled: false,
				updatedAt: this.#now(),
				disabledDisposition: 'left-overrides-in-place',
				warning:
					'Experimental mutations are disabled, but managed Simulator overrides may remain in place.',
			};
			await this.#persistence.setSetting(setting);
			this.#state.setting = setting;
			this.#touch();
			return {
				actionId: request.actionId,
				accepted: true,
				state: this.getState(),
			};
		}
		const requestedTargets = new Set(request.simulatorUdids);
		const unrestoredTargets = Object.values(this.#state.statusBySimulator)
			.filter(
				(status) =>
					status.managedDisabledCount > 0 ||
					(status.checkpointAvailable &&
						['unknown', 'needs-attention'].includes(status.condition))
			)
			.map((status) => status.simulatorUdid)
			.filter((udid) => !requestedTargets.has(udid));
		if (unrestoredTargets.length > 0) {
			return {
				actionId: request.actionId,
				accepted: false,
				state: this.getState(),
				error:
					'Restore-and-verify must include every Simulator with known or potentially active managed overrides.',
			};
		}

		const pending: PersistedSlimmingSetting = {
			experimentalMutationsEnabled: true,
			updatedAt: this.#now(),
			disabledDisposition: 'restore-pending',
			warning:
				'Experimental mutations will be disabled after every selected Simulator is restored and verified.',
		};
		await this.#persistence.setSetting(pending);
		this.#state.setting = pending;
		this.#touch();
		const action = slimmingActionSchema.parse({
			actionId: request.actionId,
			kind: 'profile.restore',
			simulatorUdids: request.simulatorUdids,
			confirmation: request.confirmation,
			...(request.confirmationToken
				? { confirmationToken: request.confirmationToken }
				: {}),
		});
		const receipt = this.#enqueueAction(action, true);
		if (!receipt.accepted) {
			const failed: PersistedSlimmingSetting = {
				experimentalMutationsEnabled: false,
				updatedAt: this.#now(),
				disabledDisposition: 'restore-failed',
				warning: `Restore-all could not start: ${receipt.error ?? 'unknown error'}`,
			};
			await this.#persistence.setSetting(failed);
			this.#state.setting = failed;
			this.#touch();
		}
		return { ...receipt, state: this.getState() };
	}

	async acknowledgeCompatibility(
		value: SlimmingAcknowledgementRequest
	): Promise<SlimmingAcknowledgementReceipt> {
		const request = slimmingAcknowledgementRequestSchema.parse(value);
		if (!this.#persistenceHealthy) {
			return {
				actionId: request.actionId,
				accepted: false,
				state: this.getState(),
				error: 'Safety persistence is unavailable.',
			};
		}
		if (!this.#state.setting.experimentalMutationsEnabled) {
			return {
				actionId: request.actionId,
				accepted: false,
				state: this.getState(),
				error: 'Experimental Simulator mutations are disabled.',
			};
		}
		await this.refresh();
		if (
			this.#state.helper.status !== 'available' ||
			!this.#state.helper.readOnlyAvailable ||
			!this.#handshake
		) {
			return {
				actionId: request.actionId,
				accepted: false,
				state: this.getState(),
				error:
					this.#state.helper.error ??
					'Native helper inspection is unavailable.',
			};
		}
		const simulatorUdids = this.#canonicalSimulatorUdids(
			request.simulatorUdids
		);
		const knownSimulatorUdids = new Set(
			this.#state.simulators.map((simulator) => simulator.udid)
		);
		if (simulatorUdids.some((udid) => !knownSimulatorUdids.has(udid))) {
			return {
				actionId: request.actionId,
				accepted: false,
				state: this.getState(),
				error: 'Every target must exist in the fresh signed helper inventory.',
			};
		}
		try {
			const compatibilities = await Promise.all(
				simulatorUdids.map(async (simulatorUdid) => ({
					simulatorUdid,
					compatibility: await this.#probeCompatibility(simulatorUdid),
				}))
			);
			const blocked = compatibilities.find(
				({ compatibility }) => compatibility.status === 'blocked'
			);
			if (blocked) {
				return {
					actionId: request.actionId,
					accepted: false,
					state: this.getState(),
					error: `${blocked.simulatorUdid} is blocked by the immutable compatibility policy.`,
				};
			}
			const keys = compatibilities
				.filter(({ compatibility }) => compatibility.status === 'unknown')
				.map(({ compatibility }) => compatibility.key);
			if (keys.length === 0) {
				return {
					actionId: request.actionId,
					accepted: true,
					state: this.getState(),
				};
			}
			await this.#persistence.acknowledgeAll([...new Set(keys)], this.#now());
			for (const { simulatorUdid, compatibility } of compatibilities) {
				if (compatibility.status !== 'unknown') continue;
				this.#setCompatibilityForDevice(simulatorUdid, {
					...compatibility,
					acknowledged: true,
				});
			}
			this.#touch();
			return {
				actionId: request.actionId,
				accepted: true,
				state: this.getState(),
			};
		} catch (error) {
			return {
				actionId: request.actionId,
				accepted: false,
				state: this.getState(),
				error: safeErrorText(error),
			};
		}
	}

	runAction(
		value: SlimmingAction,
		mutationLease?: SimulatorMutationLease
	): SlimmingActionReceipt {
		const action = slimmingActionSchema.parse(value);
		return this.#enqueueAction(
			slimmingActionSchema.parse({
				...action,
				simulatorUdids: this.#canonicalSimulatorUdids(action.simulatorUdids),
			}),
			false,
			mutationLease
		);
	}

	/**
	 * Drops the oldest finished jobs until one more fits, as the Simulator
	 * service does, so a long session never fills the queue with history.
	 * False only when every listed job is still active.
	 */
	#makeJobRoom(): boolean {
		while (this.#jobs.length >= MAX_JOBS) {
			const index = this.#jobs.findIndex(
				(job) => !ACTIVE_JOB_STATUSES.has(job.public.status)
			);
			if (index < 0) return false;
			this.#jobs.splice(index, 1);
		}
		return true;
	}

	cancelJob(jobId: string): boolean {
		const job = this.#jobs.find((candidate) => candidate.public.id === jobId);
		if (!job || !ACTIVE_JOB_STATUSES.has(job.public.status)) return false;
		job.controller.abort();
		if (job.public.status === 'queued') {
			job.public = {
				...job.public,
				status: 'cancelled',
				progressSequence: job.public.progressSequence + 1,
				phase: 'cancelled',
				finishedAt: this.#now(),
				message: 'Cancelled before execution.',
				targets: job.public.targets.map((target) => ({
					...target,
					status: 'cancelled',
					message: 'Cancelled before execution.',
				})),
			};
			this.#touch();
		}
		return true;
	}

	#enqueueAction(
		action: SlimmingAction,
		disableWhenFinished: boolean,
		mutationLease?: SimulatorMutationLease
	): SlimmingActionReceipt {
		if (this.#stopped)
			return this.#reject(action, 'Slimming controls are shutting down.');
		if (this.#state.helper.status !== 'available') {
			return this.#reject(
				action,
				this.#state.helper.error ?? 'Native helper is unavailable.'
			);
		}
		if (!this.#state.helper.readOnlyAvailable) {
			return this.#reject(
				action,
				'Native helper read-only capabilities are unavailable.'
			);
		}
		if (MUTATION_KINDS.has(action.kind)) {
			if (!this.#persistenceHealthy) {
				return this.#reject(action, 'Safety persistence is unavailable.');
			}
			if (!this.#state.setting.experimentalMutationsEnabled) {
				return this.#reject(
					action,
					'Experimental Simulator mutations are disabled.'
				);
			}
			const operation = mutationOperation(action);
			for (const udid of action.simulatorUdids) {
				const compatibility = this.#compatibilityForDevice(udid);
				if (!compatibility) {
					return this.#reject(
						action,
						`${udid} has no fresh compatibility tuple; refresh or preview it before mutation.`
					);
				}
				if (compatibility.status === 'blocked') {
					return this.#reject(
						action,
						`${udid} is blocked by the immutable compatibility policy.`
					);
				}
				if (
					compatibility.status === 'limited' &&
					operation &&
					!compatibility.verifiedOperations.includes(operation)
				) {
					return this.#reject(
						action,
						`${operation} is not verified for ${udid}.`
					);
				}
				if (compatibility.status === 'unknown' && !compatibility.acknowledged) {
					return this.#reject(
						action,
						`${udid} requires the exact EXPERIMENTAL acknowledgement.`
					);
				}
				// Slimming reboots the device. A device another session holds (its
				// lane or claim) is refused whoever asks, so one agent's slim can
				// never restart another agent's Simulator.
				const access = this.#deviceAccess?.(
					udid,
					'requester' in action ? action.requester : undefined
				);
				if (access && !access.allowed) {
					return this.#reject(action, access.reason);
				}
			}
		}
		if (action.kind === 'pending.forget') {
			// Forgetting touches no Simulator, so neither the experimental
			// setting nor the compatibility gates apply, only the safety store.
			if (!this.#persistenceHealthy) {
				return this.#reject(action, 'Safety persistence is unavailable.');
			}
			const missing = action.simulatorUdids.find(
				(udid) => !this.#persistence.pendingMutation(udid)
			);
			if (missing) {
				return this.#reject(
					action,
					`${missing} has no emergency restore point to forget.`
				);
			}
		}
		if (this.#jobs.some((job) => job.public.actionId === action.actionId)) {
			return this.#reject(
				action,
				'A Slimming action with this identifier already exists.'
			);
		}
		if (!this.#makeJobRoom()) {
			return this.#reject(
				action,
				`The ${MAX_JOBS}-job Slimming queue is full.`
			);
		}
		if (
			mutationLease &&
			(action.simulatorUdids.length !== 1 ||
				action.simulatorUdids[0]?.toUpperCase() !== mutationLease.simulatorUdid)
		) {
			return this.#reject(
				action,
				'An inherited Simulator mutation lease must match exactly one target.'
			);
		}
		const knownDevices = new Set(
			this.#state.simulators.map((simulator) => simulator.udid)
		);
		if (action.simulatorUdids.some((udid) => !knownDevices.has(udid))) {
			return this.#reject(
				action,
				'Every target must exist in the signed helper inventory.'
			);
		}

		const jobId = `slimming-${randomUUID()}`;
		const job: InternalJob = {
			action,
			controller: new AbortController(),
			disableWhenFinished,
			emergencyRecoveryTargets: new Set(),
			...(mutationLease ? { mutationLease } : {}),
			public: {
				id: jobId,
				actionId: action.actionId,
				kind: action.kind,
				status: 'queued',
				progressSequence: 0,
				phase: 'queued',
				message: 'Waiting for earlier Slimming work…',
				createdAt: this.#now(),
				currentIndex: 0,
				total: action.simulatorUdids.length,
				...(profileId(action) ? { profileId: profileId(action) } : {}),
				targets: action.simulatorUdids.map((simulatorUdid) => ({
					simulatorUdid,
					status: 'queued',
					message: 'Queued.',
				})),
			},
		};
		this.#jobs.push(job);
		this.#touch();
		const task = LEASED_KINDS.has(action.kind)
			? this.#runJob(job)
			: this.#queue.catch(() => undefined).then(() => this.#runJob(job));
		if (!LEASED_KINDS.has(action.kind)) this.#queue = task;
		this.#tasks.add(task);
		void task.finally(() => this.#tasks.delete(task));
		return { actionId: action.actionId, accepted: true, jobId };
	}

	async #runJob(job: InternalJob): Promise<void> {
		if (job.controller.signal.aborted) return;
		this.#updateJob(job, {
			status: 'preflight',
			phase: 'preflight',
			startedAt: this.#now(),
			message: 'Validating helper, targets, compatibility, and restore points…',
		});
		for (let index = 0; index < job.public.targets.length; index += 1) {
			if (job.controller.signal.aborted) {
				this.#cancelRemaining(job, index);
				break;
			}
			const target = job.public.targets[index];
			if (!target) continue;
			this.#updateTarget(job, index, {
				status: 'running',
				message: `Running ${job.action.kind}…`,
			});
			this.#updateJob(job, {
				status: 'running',
				phase: 'executing',
				currentIndex: index + 1,
				message: `Processing ${index + 1} of ${job.public.total}…`,
			});
			try {
				const executeTarget = () =>
					this.#withMutationQueue(job.controller.signal, () =>
						this.#executeTarget(
							job,
							target.simulatorUdid,
							job.controller.signal
						)
					);
				const result = LEASED_KINDS.has(job.action.kind)
					? await this.#mutationCoordinator.runExclusive(
							target.simulatorUdid,
							job.controller.signal,
							executeTarget,
							job.mutationLease
						)
					: await this.#executeTarget(
							job,
							target.simulatorUdid,
							job.controller.signal
						);
				this.#updateTarget(job, index, {
					status: 'complete',
					message: result.message,
					...(result.condition ? { condition: result.condition } : {}),
					...(result.changed !== undefined ? { changed: result.changed } : {}),
					checkpointAvailable:
						this.#state.checkpointBySimulator[target.simulatorUdid] !==
							undefined ||
						this.#persistence.pendingMutation(target.simulatorUdid) !==
							undefined,
				});
			} catch (error) {
				const cancelled = job.controller.signal.aborted;
				const provenSafe = mutationFailureIsProvenSafe(error);
				const pendingAtFailure = this.#persistence.pendingMutation(
					target.simulatorUdid
				);
				const recoveringEmergencyCheckpoint = job.emergencyRecoveryTargets.has(
					target.simulatorUdid
				);
				// A forget that failed touched no Simulator and left its record as
				// it was: a plain failure, not a mutation outcome to reconcile.
				const needsAttention =
					job.action.kind !== 'pending.forget' &&
					(recoveringEmergencyCheckpoint ||
						(pendingAtFailure !== undefined &&
							(!provenSafe || pendingAtFailure.recovery !== undefined)) ||
						(error instanceof SimHelperError &&
							[
								'mutation_failed_needs_attention',
								'simulator_needs_attention',
							].includes(error.code)));
				const terminal = needsAttention
					? 'needs-attention'
					: cancelled
						? 'cancelled'
						: 'failed';
				await this.#recordFailedMutation(
					job.action,
					target.simulatorUdid,
					error,
					terminal,
					recoveringEmergencyCheckpoint
				);
				if (needsAttention) {
					const previousStatus =
						this.#state.statusBySimulator[target.simulatorUdid];
					if (previousStatus) {
						this.#state.statusBySimulator[target.simulatorUdid] = {
							...previousStatus,
							condition: 'needs-attention',
							checkpointAvailable: true,
							checkedAt: this.#now(),
							message:
								'A private durable emergency restore point is retained. Use Undo to recover before other mutations.',
						};
					}
				}
				this.#updateTarget(job, index, {
					status: terminal,
					message:
						cancelled && !needsAttention
							? 'Cancelled.'
							: needsAttention
								? `Mutation outcome requires restart reconciliation.${redactDiagnosticText(mutationFailureDetail(error))}`.slice(
										0,
										4 * 1024
									)
								: describeMutationFailure(error),
					condition: needsAttention ? 'needs-attention' : 'unknown',
					...(error instanceof SimHelperError ? { errorCode: error.code } : {}),
					checkpointAvailable:
						this.#state.checkpointBySimulator[target.simulatorUdid] !==
							undefined ||
						this.#persistence.pendingMutation(target.simulatorUdid) !==
							undefined,
				});
				if (cancelled) {
					this.#cancelRemaining(job, index + 1);
					break;
				}
			} finally {
				if (MUTATION_KINDS.has(job.action.kind)) {
					this.#clearInspections(target.simulatorUdid);
				}
			}
		}

		const statuses = job.public.targets.map((target) => target.status);
		const status = statuses.includes('needs-attention')
			? 'needs-attention'
			: statuses.includes('failed')
				? 'failed'
				: statuses.includes('cancelled')
					? 'cancelled'
					: 'complete';
		if (job.disableWhenFinished) await this.#finishDisableFlow(status);
		this.#updateJob(job, {
			status,
			phase: status,
			finishedAt: this.#now(),
			message:
				status === 'complete'
					? `Completed ${job.public.total} Simulator target${job.public.total === 1 ? '' : 's'}.`
					: status === 'needs-attention'
						? 'At least one Simulator could not be proven safe after rollback.'
						: status === 'failed'
							? 'One or more Simulator targets failed.'
							: 'Slimming job cancelled.',
		});
	}

	async #withMutationQueue<T>(
		signal: AbortSignal,
		operation: () => Promise<T>
	): Promise<T> {
		const previous = this.#mutationQueue;
		let release: () => void = () => undefined;
		this.#mutationQueue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous.catch(() => undefined);
		try {
			if (signal.aborted) {
				throw signal.reason ?? new Error('Slimming mutation was cancelled.');
			}
			return await operation();
		} finally {
			release();
		}
	}

	async #executeTarget(
		job: InternalJob,
		simulatorUdid: string,
		signal: AbortSignal
	): Promise<{
		message: string;
		condition?: SlimmingCondition;
		changed?: boolean;
	}> {
		const action = job.action;
		if (action.kind === 'profile.preview') {
			const plan = await this.#helper.previewProfile(
				simulatorUdid,
				action.profileId,
				signal
			);
			const compatibility = plan.compatibility
				? this.#publicCompatibility(plan.compatibility)
				: undefined;
			this.#state.previewBySimulator[simulatorUdid] = {
				simulatorUdid,
				profileId: plan.profileId,
				currentDisabledServiceIds: plan.currentDisabledServiceIds,
				desiredDisabledServiceIds: plan.desiredDisabledServiceIds,
				toDisableServiceIds: plan.toDisableServiceIds,
				toEnableServiceIds: plan.toEnableServiceIds,
				requiresCheckpoint: plan.requiresCheckpoint,
				requiresReboot: plan.requiresReboot,
				executable: plan.executable,
				...(plan.blockedReason ? { blockedReason: plan.blockedReason } : {}),
				...(compatibility ? { compatibility } : {}),
				previewedAt: this.#now(),
			};
			if (compatibility && this.#state.statusBySimulator[simulatorUdid]) {
				this.#state.statusBySimulator[simulatorUdid] = {
					...this.#state.statusBySimulator[simulatorUdid],
					compatibility,
				};
			}
			this.#touch();
			return { message: 'Profile preview completed.' };
		}
		if (action.kind === 'profile.verify') {
			this.#updateJob(job, {
				status: 'verifying',
				phase: 'verifying',
				message: 'Verifying managed overrides and disabled launchd jobs…',
			});
			const verification = await this.#helper.verifyProfile(
				simulatorUdid,
				action.profileId,
				signal
			);
			const status = this.#statusFromManagedSet(
				simulatorUdid,
				verification.currentManagedDisabledServiceIds,
				verification.verified ? [action.profileId] : []
			);
			this.#state.statusBySimulator[simulatorUdid] = status;
			this.#touch();
			return {
				message: verification.verified
					? 'Profile verified.'
					: 'Profile does not match.',
				condition: status.condition,
			};
		}
		if (action.kind === 'doctor.run') {
			const doctor = await this.#helper.doctor(
				simulatorUdid,
				action.requiredCapabilities,
				signal
			);
			this.#state.doctorBySimulator[simulatorUdid] = {
				simulatorUdid,
				healthy: doctor.healthy,
				checkedAt: this.#now(),
				managedDisabledServiceIds: doctor.managedDisabledServiceIds,
				capabilities: doctor.capabilities,
			};
			this.#touch();
			return {
				message: doctor.healthy
					? 'Capability checks passed.'
					: 'Capability conflicts found.',
			};
		}
		if (action.kind === 'pending.forget') {
			return this.#forgetPendingMutation(action, simulatorUdid);
		}

		const publicCompatibility = this.#compatibilityForDevice(simulatorUdid);
		this.#clearInspections(simulatorUdid);
		if (!publicCompatibility) {
			throw new Error(
				`${simulatorUdid} has no inspected compatibility tuple; refresh before mutation.`
			);
		}
		const operation = mutationOperation(action);
		if (publicCompatibility.status === 'blocked') {
			throw new Error(
				`${simulatorUdid} is blocked by the immutable compatibility policy.`
			);
		}
		if (
			publicCompatibility.status === 'limited' &&
			operation &&
			!publicCompatibility.verifiedOperations.includes(operation)
		) {
			throw new Error(`${operation} is not verified for ${simulatorUdid}.`);
		}
		if (
			publicCompatibility.status === 'unknown' &&
			!publicCompatibility.acknowledged
		) {
			throw new Error(
				`${simulatorUdid} requires a separately persisted exact EXPERIMENTAL acknowledgement for its current compatibility tuple.`
			);
		}
		let acknowledgement: 'EXPERIMENTAL' | undefined =
			publicCompatibility.status === 'unknown' &&
			publicCompatibility.acknowledged
				? 'EXPERIMENTAL'
				: undefined;
		const interruptedPending = this.#persistence.pendingMutation(simulatorUdid);
		const recoveringInterruptedMutation =
			action.kind === 'profile.undo' ? interruptedPending : undefined;
		if (recoveringInterruptedMutation) {
			job.emergencyRecoveryTargets.add(simulatorUdid);
		}
		const targetCheckpointToken =
			action.kind === 'profile.undo'
				? (recoveringInterruptedMutation?.checkpointToken ??
					this.#persistence.checkpointToken(simulatorUdid))
				: undefined;
		if (action.kind === 'profile.undo' && !targetCheckpointToken) {
			throw new Error('No restart-safe checkpoint exists for this Simulator.');
		}
		if (interruptedPending && !recoveringInterruptedMutation) {
			throw new Error(
				'A prior Simulator mutation still requires restart reconciliation.'
			);
		}
		const prepared = await this.#helper.prepareMutation(
			simulatorUdid,
			operation ?? 'restore_managed',
			profileId(action),
			targetCheckpointToken,
			signal
		);
		const preparedCompatibility = this.#publicCompatibility(
			prepared.compatibility
		);
		if (preparedCompatibility.status === 'blocked') {
			throw new Error(
				`${simulatorUdid} changed to a blocked compatibility tuple during preflight.`
			);
		}
		if (
			preparedCompatibility.status === 'limited' &&
			operation &&
			!preparedCompatibility.verifiedOperations.includes(operation)
		) {
			throw new Error(
				`${operation} is not verified for the refreshed ${simulatorUdid} tuple.`
			);
		}
		if (
			preparedCompatibility.status === 'unknown' &&
			!preparedCompatibility.acknowledged
		) {
			throw new Error(
				`${simulatorUdid} changed to an unacknowledged compatibility tuple during preflight.`
			);
		}
		acknowledgement =
			preparedCompatibility.status === 'unknown' &&
			preparedCompatibility.acknowledged
				? 'EXPERIMENTAL'
				: undefined;
		const operationId = `operation-${randomUUID()}`;
		const pendingId = `pending-${randomUUID()}`;
		if (prepared.changed) {
			if (recoveringInterruptedMutation) {
				await this.#persistence.beginPendingRecovery(
					simulatorUdid,
					recoveringInterruptedMutation.id,
					{
						id: pendingId,
						startedAt: this.#now(),
						checkpointToken: prepared.checkpointToken,
						beforeServiceIds: prepared.before.managedDisabledServiceIds,
					}
				);
			} else {
				await this.#persistence.beginPendingMutation(simulatorUdid, {
					id: pendingId,
					actionId: action.actionId,
					operation: prepared.operation,
					...(prepared.profileId ? { profileId: prepared.profileId } : {}),
					startedAt: this.#now(),
					checkpointToken: prepared.checkpointToken,
					originalBootState: prepared.originalBootState,
					beforeServiceIds: prepared.before.managedDisabledServiceIds,
					desiredServiceIds: prepared.desired.managedDisabledServiceIds,
					compatibilityKey: preparedCompatibility.key,
					compatibilityStatus: preparedCompatibility.status,
					matrixVersion: prepared.compatibility.matrixVersion,
					tuple: prepared.compatibility.tuple,
				});
			}
			this.#syncPersistenceState();
		}
		let mutation: SimHelperMutation;
		if (action.kind === 'profile.apply') {
			mutation = await this.#helper.applyProfile(
				simulatorUdid,
				action.profileId,
				prepared.checkpointToken,
				acknowledgement,
				signal
			);
		} else if (action.kind === 'profile.restore') {
			mutation = await this.#helper.restoreManaged(
				simulatorUdid,
				prepared.checkpointToken,
				acknowledgement,
				signal
			);
		} else {
			mutation = await this.#helper.undoLast(
				simulatorUdid,
				prepared.checkpointToken,
				targetCheckpointToken as string,
				acknowledgement,
				signal
			);
		}
		if (!mutation.verification.verified) {
			throw new SimHelperError(
				'mutation_failed_needs_attention',
				'The helper did not prove the exact launchd registration state after the mutation; the durable emergency restore point was retained.',
				false,
				mutation
			);
		}

		this.#updateJob(job, {
			status: 'verifying',
			phase: 'verifying',
			message: 'Persisting the verified restore point and final evidence…',
		});
		const condition = this.#conditionAfterMutation(action, mutation);
		const completedOperation = this.#operationMetadata(
			action,
			operationId,
			'complete',
			condition,
			mutation.changed,
			'Helper mutation and verification completed.'
		);
		if (recoveringInterruptedMutation) {
			await this.#persistence.resolvePendingMutation(
				simulatorUdid,
				recoveringInterruptedMutation.id,
				{ kind: 'complete', operation: completedOperation }
			);
		} else if (prepared.changed) {
			await this.#persistence.resolvePendingMutation(simulatorUdid, pendingId, {
				kind: 'complete',
				...(mutation.changed
					? {
							checkpointMetadata: this.#checkpointMetadata(
								operationId,
								profileId(action)
							),
						}
					: {}),
				operation: completedOperation,
			});
		} else {
			await this.#persistence.recordOperation(
				simulatorUdid,
				completedOperation
			);
		}
		this.#syncPersistenceState();
		this.#state.statusBySimulator[simulatorUdid] = this.#statusFromMutation(
			action,
			simulatorUdid,
			mutation,
			condition
		);
		this.#touch();
		return {
			message: mutation.changed
				? 'Mutation applied and verified.'
				: 'Simulator already matched.',
			condition,
			changed: mutation.changed,
		};
	}

	/**
	 * Drops the Simulator's pending record through the persistence `clear`
	 * path, recording who forgot it, so nothing reconciles the interrupted
	 * mutation or undoes it through its emergency restore point any more. Runs
	 * under the job's lease, never beside a reconciliation of that record or a
	 * mutation of that Simulator. The last completed change's checkpoint stays.
	 */
	async #forgetPendingMutation(
		action: Extract<SlimmingAction, { kind: 'pending.forget' }>,
		simulatorUdid: string
	): Promise<{
		message: string;
		condition: SlimmingCondition;
		changed: false;
	}> {
		const pending = this.#persistence.pendingMutation(simulatorUdid);
		if (!pending) {
			throw new Error(
				'No emergency restore point is pending for this Simulator.'
			);
		}
		await this.#persistence.resolvePendingMutation(simulatorUdid, pending.id, {
			kind: 'clear',
			operation: this.#operationMetadata(
				action,
				`operation-${randomUUID()}`,
				'complete',
				'unknown',
				false,
				`The operator forgot the emergency restore point of an interrupted ${actionKindForMutation(pending.operation)}; nothing reconciled its outcome.`
			),
		});
		this.#reconcileSchedule.delete(simulatorUdid);
		this.#syncPersistenceState();
		const status = this.#state.statusBySimulator[simulatorUdid];
		if (status) {
			this.#state.statusBySimulator[simulatorUdid] = {
				...status,
				condition: 'unknown',
				checkpointAvailable:
					this.#state.checkpointBySimulator[simulatorUdid] !== undefined,
				checkedAt: this.#now(),
				message:
					'The emergency restore point was forgotten. Restore services, or preview and apply a profile, to return this Simulator to a known state.',
			};
		}
		this.#touch();
		return {
			message: 'Emergency restore point forgotten.',
			condition: 'unknown',
			changed: false,
		};
	}

	#clearInspections(simulatorUdid: string): void {
		// A mutation invalidates earlier plans and capability checks, including
		// inspections requested while it was running or before a failed attempt.
		if (
			!this.#state.previewBySimulator[simulatorUdid] &&
			!this.#state.doctorBySimulator[simulatorUdid]
		) {
			return;
		}
		delete this.#state.previewBySimulator[simulatorUdid];
		delete this.#state.doctorBySimulator[simulatorUdid];
		this.#touch();
	}

	#checkpointMetadata(
		operationId: string,
		exactProfileId?: string
	): SlimmingCheckpointMetadata {
		if (!this.#handshake) throw new Error('Helper handshake is unavailable.');
		return {
			id: `checkpoint-${randomUUID()}`,
			createdAt: this.#now(),
			sourceOperationId: operationId,
			...(exactProfileId ? { profileId: exactProfileId } : {}),
			helperVersion: this.#handshake.helperVersion,
			catalogVersion: this.#handshake.catalogVersion,
			compatibilityMatrixVersion:
				this.#handshake.capabilities.compatibilityMatrixVersion,
		};
	}

	#operationMetadata(
		action: SlimmingAction,
		operationId: string,
		status: 'complete' | 'failed' | 'needs-attention' | 'cancelled',
		condition: SlimmingCondition,
		changed: boolean | undefined,
		message: string,
		errorCode?: string
	): SlimmingOperationMetadata {
		return {
			id: operationId,
			actionId: action.actionId,
			kind: action.kind,
			status,
			startedAt: this.#now(),
			finishedAt: this.#now(),
			...(profileId(action) ? { profileId: profileId(action) } : {}),
			...(changed !== undefined ? { changed } : {}),
			condition,
			...(errorCode ? { errorCode } : {}),
			message,
		};
	}

	#syncPersistenceState(): void {
		const persisted = this.#persistence.snapshot();
		this.#state.checkpointBySimulator = persisted.checkpointBySimulator;
		this.#state.operationsBySimulator = persisted.operationsBySimulator;
	}

	async #recordFailedMutation(
		action: SlimmingAction,
		simulatorUdid: string,
		error: unknown,
		status: 'failed' | 'needs-attention' | 'cancelled',
		retainEmergencyCheckpoint: boolean
	): Promise<void> {
		if (!MUTATION_KINDS.has(action.kind)) return;
		const evidence =
			error instanceof SimHelperError
				? mutationEvidenceFromError(error)
				: undefined;
		const condition: SlimmingCondition =
			status === 'needs-attention' ? 'needs-attention' : 'unknown';
		try {
			const pending = this.#persistence.pendingMutation(simulatorUdid);
			const safeResolution = mutationFailureIsProvenSafe(error);
			const errorCode =
				error instanceof SimHelperError ? error.code : undefined;
			const operation = this.#operationMetadata(
				action,
				`operation-${randomUUID()}`,
				safeResolution ? status : 'needs-attention',
				safeResolution ? condition : 'needs-attention',
				evidence?.changed,
				describeMutationFailure(error),
				errorCode
			);
			if (pending) {
				if (retainEmergencyCheckpoint) {
					await this.#persistence.recordPendingRecoveryFailure(
						simulatorUdid,
						pending.id,
						{
							...operation,
							status: 'needs-attention',
							condition: 'needs-attention',
							message:
								'The recovery attempt was not fully verified, so the original emergency restore point remains available.',
						}
					);
				} else if (pending.recovery && safeResolution) {
					await this.#persistence.recordPendingRecoveryFailure(
						simulatorUdid,
						pending.id,
						{
							...operation,
							status: 'needs-attention',
							condition: 'needs-attention',
							message:
								'Recovery attempt did not mutate or was fully rolled back; the original emergency restore point remains available.',
						}
					);
				} else {
					await this.#persistence.resolvePendingMutation(
						simulatorUdid,
						pending.id,
						safeResolution
							? { kind: 'complete', operation }
							: { kind: 'needs-attention', operation }
					);
				}
			} else {
				await this.#persistence.recordOperation(simulatorUdid, operation);
			}
			this.#syncPersistenceState();
		} catch {
			this.#persistenceHealthy = false;
			this.#state.setting = {
				experimentalMutationsEnabled: false,
				disabledDisposition: 'restore-failed',
				warning:
					'Safety metadata could not be persisted. Further mutations are blocked.',
			};
		}
	}

	#conditionAfterMutation(
		action: SlimmingAction,
		mutation: SimHelperMutation
	): SlimmingCondition {
		if (!mutation.verification.verified) return 'needs-attention';
		if (mutation.after.count === 0) return 'managed-clean';
		if (action.kind === 'profile.apply') return 'profile-match';
		return 'partial';
	}

	#statusFromMutation(
		action: SlimmingAction,
		simulatorUdid: string,
		mutation: SimHelperMutation,
		condition: SlimmingCondition
	): SlimmingSimulatorStatus {
		const previous = this.#state.statusBySimulator[simulatorUdid];
		return {
			simulatorUdid,
			condition,
			managedDisabledServiceIds: mutation.after.managedDisabledServiceIds,
			managedDisabledCount: mutation.after.count,
			managedServiceCount:
				previous?.managedServiceCount ??
				mutation.after.managedDisabledServiceIds.length,
			matchingProfileIds:
				action.kind === 'profile.apply' && mutation.verification.verified
					? [action.profileId]
					: [],
			checkedAt: this.#now(),
			checkpointAvailable:
				this.#state.checkpointBySimulator[simulatorUdid] !== undefined ||
				this.#persistence.pendingMutation(simulatorUdid) !== undefined,
			compatibility: this.#publicCompatibility(mutation.compatibility),
		};
	}

	#statusFromManagedSet(
		simulatorUdid: string,
		managedDisabledServiceIds: string[],
		matchingProfileIds: string[]
	): SlimmingSimulatorStatus {
		const previous = this.#state.statusBySimulator[simulatorUdid];
		const partial = {
			simulatorUdid,
			managedDisabledServiceIds,
			managedDisabledCount: managedDisabledServiceIds.length,
			managedServiceCount:
				previous?.managedServiceCount ?? managedDisabledServiceIds.length,
			matchingProfileIds,
			checkedAt: this.#now(),
			checkpointAvailable:
				this.#state.checkpointBySimulator[simulatorUdid] !== undefined,
			...(previous?.compatibility
				? { compatibility: previous.compatibility }
				: {}),
		};
		return { ...partial, condition: conditionForStatus(partial) };
	}

	#publicCompatibility(
		compatibility: SimHelperCompatibility
	): SlimmingCompatibility {
		if (!this.#handshake) throw new Error('Helper handshake is unavailable.');
		const key = compatibilityKey(
			compatibility,
			this.#handshake,
			this.#appVersion
		);
		return compatibilityForPublic(
			compatibility,
			key,
			this.#persistence.isAcknowledged(key)
		);
	}

	#compatibilityForDevice(
		simulatorUdid: string
	): SlimmingCompatibility | undefined {
		return (
			this.#state.previewBySimulator[simulatorUdid]?.compatibility ??
			this.#state.statusBySimulator[simulatorUdid]?.compatibility
		);
	}

	async #probeCompatibility(
		simulatorUdid: string,
		profileId?: string,
		signal?: AbortSignal
	): Promise<SlimmingCompatibility> {
		const selectedProfileId = profileId ?? this.#state.profiles[0]?.id;
		if (!selectedProfileId) {
			throw new Error(
				'No signed Slimming profile is available for compatibility inspection.'
			);
		}
		const plan = await this.#helper.previewProfile(
			simulatorUdid,
			selectedProfileId,
			signal
		);
		if (!plan.compatibility) {
			throw new Error(
				'The helper did not return an exact compatibility tuple.'
			);
		}
		const compatibility = this.#publicCompatibility(plan.compatibility);
		this.#setCompatibilityForDevice(simulatorUdid, compatibility);
		return compatibility;
	}

	#setCompatibilityForDevice(
		simulatorUdid: string,
		compatibility: SlimmingCompatibility
	): void {
		const status = this.#state.statusBySimulator[simulatorUdid];
		if (status) {
			this.#state.statusBySimulator[simulatorUdid] = {
				...status,
				compatibility,
			};
		}
		const preview = this.#state.previewBySimulator[simulatorUdid];
		if (preview) {
			this.#state.previewBySimulator[simulatorUdid] = {
				...preview,
				compatibility,
			};
		}
	}

	#canonicalSimulatorUdids(simulatorUdids: readonly string[]): string[] {
		return simulatorUdids.map(
			(udid) =>
				this.#state.simulators.find(
					(simulator) => simulator.udid.toLowerCase() === udid.toLowerCase()
				)?.udid ?? udid
		);
	}

	async #finishDisableFlow(status: SlimmingJob['status']): Promise<void> {
		const completed = status === 'complete';
		const setting: PersistedSlimmingSetting = {
			experimentalMutationsEnabled: false,
			updatedAt: this.#now(),
			disabledDisposition: completed
				? 'restored-and-verified'
				: 'restore-failed',
			...(completed
				? {}
				: {
						warning:
							'Restore-all did not verify every Simulator. Review targets that failed or need attention.',
					}),
		};
		try {
			await this.#persistence.setSetting(setting);
			this.#state.setting = setting;
		} catch {
			this.#persistenceHealthy = false;
			this.#state.setting = {
				experimentalMutationsEnabled: false,
				disabledDisposition: 'restore-failed',
				warning: 'The disabled setting could not be persisted safely.',
			};
		}
		this.#touch();
	}

	async #refreshInternal(): Promise<SlimmingState> {
		try {
			const handshake = await this.#helper.handshake();
			this.#handshake = handshake;
			const [profiles, devices] = await Promise.all([
				this.#helper.listProfiles(),
				this.#helper.listSimulators(),
			]);
			if (profiles.catalogVersion !== handshake.catalogVersion) {
				throw new Error('Helper catalog version changed during refresh.');
			}
			this.#state.helper = {
				status: 'available',
				readOnlyAvailable: handshake.capabilities.readOnlyAvailable,
				helperVersion: handshake.helperVersion,
				buildCommit: handshake.buildCommit,
				catalogVersion: handshake.catalogVersion,
				compatibilityMatrixVersion:
					handshake.capabilities.compatibilityMatrixVersion,
				mutationMode: handshake.capabilities.mutationMode,
				mutationReason: handshake.capabilities.mutationSafety,
				...(this.#mutationUnavailableReason
					? { mutationUnavailableReason: this.#mutationUnavailableReason }
					: {}),
				verifiedMutationTuples: handshake.capabilities.verifiedMutationTuples,
				verifiedAt: this.#now(),
				...(!this.#persistenceHealthy
					? {
							error:
								'Safety persistence is unavailable; mutations are blocked.',
						}
					: {}),
			};
			this.#state.categories = profiles.categories.map((category) => ({
				id: category.id,
				name: category.name,
				description: category.description,
				downside: category.downside,
				approxMemoryMb: category.approxMemoryMB,
				serviceIds: category.serviceIds,
			}));
			this.#state.profiles = profiles.profiles;
			this.#state.simulators = devices.slice(0, 200).map((device) => ({
				udid: device.id,
				name: device.name,
				state: mapDeviceState(device.state),
				runtimeIdentifier: device.runtimeIdentifier,
				deviceTypeIdentifier: device.deviceTypeIdentifier,
				isAvailable: device.available,
			}));
			await this.#refreshStatuses(devices.slice(0, 200));
			await this.#reconcilePendingMutations();
		} catch (error) {
			this.#handshake = undefined;
			this.#state.helper = helperStateFromError(error);
		}
		this.#touch();
		return this.getState();
	}

	/** One pass over every pending record; #reconcileWhenFree has the rules. */
	async #reconcilePendingMutations(): Promise<void> {
		const restartPass = this.#restartReconciliationDue;
		this.#restartReconciliationDue = false;
		for (const simulatorUdid of Object.keys(
			this.#persistence.pendingMutations()
		)) {
			if (this.#stopped) break;
			await this.#reconcileWhenFree(simulatorUdid, restartPass);
		}
		for (const simulatorUdid of [...this.#reconcileSchedule.keys()]) {
			if (!this.#persistence.pendingMutation(simulatorUdid)) {
				this.#reconcileSchedule.delete(simulatorUdid);
			}
		}
		this.#syncPersistenceState();
	}

	/**
	 * Reconciles one pending record when nothing else owns its Simulator. A
	 * job on the Simulator owns the record until the job ends, including the
	 * failure bookkeeping it does after its lease. Anyone else holding the
	 * lease (a Fleet action, a lane or recipe, which also refresh SimSlim from
	 * inside their own lease) is never waited for: the record is retried on a
	 * later pass. The restart pass inspects every record once, booting a
	 * shut-down Simulator for it. After that, inspection waits until the
	 * Simulator is booted, and a record that stays ambiguous is inspected less
	 * often each time.
	 */
	async #reconcileWhenFree(
		simulatorUdid: string,
		restartPass: boolean
	): Promise<void> {
		if (this.#hasActiveJob(simulatorUdid)) return;
		const pending = this.#persistence.pendingMutation(simulatorUdid);
		if (!pending) return;
		const deviceState = this.#deviceState(simulatorUdid);
		const key = `${pending.id}|${pending.recovery?.id ?? ''}|${deviceState}`;
		let schedule = this.#reconcileSchedule.get(simulatorUdid);
		if (schedule?.key !== key) {
			schedule = { key, attempts: 0, nextAt: 0 };
			this.#reconcileSchedule.set(simulatorUdid, schedule);
		}
		if (!restartPass && deviceState !== 'booted') {
			// Inspecting a Simulator that is not booted boots it.
			this.#markPendingNeedsAttention(
				simulatorUdid,
				PENDING_RECORD_SHUTDOWN_MESSAGE
			);
			this.#backOff(schedule);
			return;
		}
		if (!restartPass && this.#now() < schedule.nextAt) {
			this.#markPendingNeedsAttention(simulatorUdid, schedule.message);
			return;
		}
		const inspected = await this.#mutationCoordinator.tryRunExclusive(
			simulatorUdid,
			this.#lifecycle.signal,
			async () => {
				// A job may have started, or settled the record, before the lease.
				const current = this.#persistence.pendingMutation(simulatorUdid);
				if (
					this.#hasActiveJob(simulatorUdid) ||
					!current ||
					current.id !== pending.id ||
					current.recovery?.id !== pending.recovery?.id
				) {
					return false;
				}
				await this.#reconcilePendingMutation(simulatorUdid, current);
				return true;
			}
		);
		if (!inspected.acquired) {
			this.#markPendingNeedsAttention(simulatorUdid, schedule.message);
			return;
		}
		if (!inspected.value) return;
		if (this.#persistence.pendingMutation(simulatorUdid)) {
			schedule.message = this.#state.statusBySimulator[simulatorUdid]?.message;
			this.#backOff(schedule);
		} else {
			this.#reconcileSchedule.delete(simulatorUdid);
		}
	}

	/** Shows a pending record that was not inspected this pass as what it is. */
	#markPendingNeedsAttention(
		simulatorUdid: string,
		message = PENDING_RECORD_MESSAGE
	): void {
		const status = this.#state.statusBySimulator[simulatorUdid];
		this.#state.statusBySimulator[simulatorUdid] = {
			...(status ?? {
				simulatorUdid,
				managedDisabledServiceIds: [],
				managedDisabledCount: 0,
				managedServiceCount: 0,
				matchingProfileIds: [],
				checkedAt: this.#now(),
			}),
			condition: 'needs-attention',
			checkpointAvailable: true,
			message,
		};
	}

	/** Two polls after the first attempt, then twice as long each time. */
	#backOff(schedule: ReconcileSchedule): void {
		schedule.attempts += 1;
		schedule.nextAt =
			this.#now() +
			Math.min(
				this.#pollIntervalMs * 2 ** schedule.attempts,
				MAX_RECONCILE_BACKOFF_MS
			);
	}

	/** Whether a pending record is due another look; drives hidden polling. */
	#reconciliationDue(): boolean {
		const now = this.#now();
		return Object.keys(this.#persistence.pendingMutations()).some(
			(simulatorUdid) =>
				now >= (this.#reconcileSchedule.get(simulatorUdid)?.nextAt ?? 0)
		);
	}

	#hasActiveJob(simulatorUdid: string): boolean {
		const udid = simulatorUdid.toUpperCase();
		return this.#jobs.some(
			(job) =>
				ACTIVE_JOB_STATUSES.has(job.public.status) &&
				job.action.simulatorUdids.some(
					(target) => target.toUpperCase() === udid
				)
		);
	}

	#deviceState(simulatorUdid: string): SlimmingSimulator['state'] {
		const udid = simulatorUdid.toUpperCase();
		return (
			this.#state.simulators.find(
				(simulator) => simulator.udid.toUpperCase() === udid
			)?.state ?? 'unknown'
		);
	}

	/**
	 * Inspects one pending record and settles it when the inspection proves the
	 * mutation's outcome. Called only under the Simulator's lease, with no job
	 * on it (see #reconcileWhenFree).
	 */
	async #reconcilePendingMutation(
		simulatorUdid: string,
		pending: PendingSlimmingMutation
	): Promise<void> {
		const persisted = this.#persistence.snapshot();
		let status = this.#state.statusBySimulator[simulatorUdid];
		const recoveryOperationId = `recovery-${pending.id}`;
		const recoveryOperation = (
			operationStatus: 'complete' | 'failed' | 'needs-attention' | 'cancelled',
			condition: SlimmingCondition,
			message: string
		): SlimmingOperationMetadata => ({
			id: recoveryOperationId,
			actionId: pending.actionId,
			kind: actionKindForMutation(pending.operation),
			status: operationStatus,
			startedAt: pending.startedAt,
			finishedAt: this.#now(),
			...(pending.profileId ? { profileId: pending.profileId } : {}),
			changed: operationStatus === 'complete',
			condition,
			message,
		});
		const normalUndoTarget =
			pending.operation === 'undo_last'
				? this.#persistence.checkpointToken(simulatorUdid)
				: undefined;
		const inspection = await this.#helper
			.prepareMutation(
				simulatorUdid,
				'undo_last',
				undefined,
				pending.checkpointToken
			)
			.catch(() => undefined);
		const currentServiceIds = inspection?.before.managedDisabledServiceIds;
		if (inspection) {
			const compatibility = this.#publicCompatibility(inspection.compatibility);
			const reconciledStatus: SlimmingSimulatorStatus = {
				...(status ?? {
					simulatorUdid,
					managedServiceCount: Math.max(
						inspection.before.count,
						inspection.desired.count
					),
					matchingProfileIds: [],
					checkedAt: this.#now(),
				}),
				managedDisabledServiceIds: inspection.before.managedDisabledServiceIds,
				managedDisabledCount: inspection.before.count,
				checkpointAvailable: true,
				compatibility,
				condition: conditionForStatus({
					managedDisabledCount: inspection.before.count,
					matchingProfileIds: status?.matchingProfileIds ?? [],
					checkpointAvailable: true,
				}),
			};
			status = reconciledStatus;
			this.#state.statusBySimulator[simulatorUdid] = reconciledStatus;
		}

		if (
			currentServiceIds &&
			sameManagedServiceSet(currentServiceIds, pending.beforeServiceIds) &&
			inspection?.verification.verified
		) {
			await this.#persistence.resolvePendingMutation(
				simulatorUdid,
				pending.id,
				{
					kind: 'complete',
					operation: recoveryOperation(
						'cancelled',
						status?.condition ?? 'unknown',
						'Restart reconciliation proved the pre-mutation state; the prior restore point was preserved.'
					),
				}
			);
			const checkpointAvailable =
				this.#persistence.snapshot().checkpointBySimulator[simulatorUdid] !==
				undefined;
			const reconciled = this.#state.statusBySimulator[simulatorUdid];
			if (reconciled) {
				this.#state.statusBySimulator[simulatorUdid] = {
					...reconciled,
					checkpointAvailable,
					condition: conditionForStatus({
						...reconciled,
						checkpointAvailable,
					}),
				};
			}
			return;
		}
		if (
			pending.recovery &&
			currentServiceIds &&
			sameManagedServiceSet(
				currentServiceIds,
				pending.recovery.beforeServiceIds
			) &&
			inspection?.verification.verified
		) {
			await this.#persistence.recordPendingRecoveryFailure(
				simulatorUdid,
				pending.id,
				recoveryOperation(
					'needs-attention',
					'needs-attention',
					'Restart reconciliation proved the recovery attempt did not start or rolled back, so the original emergency restore point was retained.'
				)
			);
			this.#state.statusBySimulator[simulatorUdid] = {
				...(status ?? {
					simulatorUdid,
					managedDisabledServiceIds: currentServiceIds,
					managedDisabledCount: currentServiceIds.length,
					managedServiceCount: currentServiceIds.length,
					matchingProfileIds: [],
					checkedAt: this.#now(),
				}),
				condition: 'needs-attention',
				checkpointAvailable: true,
				message:
					'The interrupted mutation still has a durable emergency restore point. Use Undo to retry recovery.',
			};
			return;
		}

		let targetVerification:
			| Awaited<ReturnType<SlimmingHelperProvider['prepareMutation']>>
			| undefined;
		if (
			currentServiceIds &&
			sameManagedServiceSet(currentServiceIds, pending.desiredServiceIds)
		) {
			targetVerification = await this.#helper
				.prepareMutation(
					simulatorUdid,
					pending.operation,
					pending.profileId,
					normalUndoTarget
				)
				.catch(() => undefined);
		}
		const desiredVerified =
			targetVerification?.changed === false &&
			targetVerification.verification.verified;
		const targetCompatibility = targetVerification
			? this.#publicCompatibility(targetVerification.compatibility)
			: undefined;
		const tupleStillMatches =
			targetCompatibility?.key === pending.compatibilityKey;
		if (desiredVerified && tupleStillMatches) {
			await this.#persistence.resolvePendingMutation(
				simulatorUdid,
				pending.id,
				{
					kind: 'complete',
					checkpointMetadata: this.#checkpointMetadata(
						recoveryOperationId,
						pending.profileId
					),
					operation: recoveryOperation(
						'complete',
						status?.condition ?? 'unknown',
						'Restart reconciliation verified the exact intended state and promoted the durable pre-mutation restore point.'
					),
				}
			);
			return;
		}

		const existingRecovery = persisted.operationsBySimulator[
			simulatorUdid
		]?.some((operation) => operation.id === recoveryOperationId);
		if (!existingRecovery) {
			await this.#persistence.resolvePendingMutation(
				simulatorUdid,
				pending.id,
				{
					kind: 'needs-attention',
					operation: recoveryOperation(
						'needs-attention',
						'needs-attention',
						'Restart reconciliation could not prove either the exact before state or the exact verified target state.'
					),
				}
			);
		}
		this.#state.statusBySimulator[simulatorUdid] = {
			...(status ?? {
				simulatorUdid,
				managedDisabledServiceIds: [],
				managedDisabledCount: 0,
				managedServiceCount: 0,
				matchingProfileIds: [],
				checkedAt: this.#now(),
			}),
			condition: 'needs-attention',
			checkpointAvailable: true,
			message:
				'A durable emergency restore point is retained because the interrupted mutation outcome is ambiguous. Use Undo to restore it; other mutations are blocked. If Undo can no longer succeed, for example after an Xcode, runtime, or helper update, forget the restore point.',
		};
	}

	async #refreshStatuses(devices: SimHelperDevice[]): Promise<void> {
		const next: Record<string, SlimmingSimulatorStatus> = {};
		const probeProfileId = this.#state.profiles[0]?.id;
		for (let index = 0; index < devices.length; index += 4) {
			const group = devices.slice(index, index + 4);
			const results = await Promise.allSettled(
				group.map(async (device) => {
					if (mapDeviceState(device.state) !== 'booted') {
						return { status: undefined, compatibility: undefined };
					}
					const status = await this.#helper.simulatorStatus(device.id);
					const plan = probeProfileId
						? await this.#helper
								.previewProfile(device.id, probeProfileId)
								.catch(() => undefined)
						: undefined;
					return { status, compatibility: plan?.compatibility };
				})
			);
			for (let offset = 0; offset < group.length; offset += 1) {
				const device = group[offset];
				const result = results[offset];
				if (!device || !result) continue;
				if (result.status === 'fulfilled' && result.value.status) {
					next[device.id] = {
						...this.#statusFromHelper(result.value.status),
						...(result.value.compatibility
							? {
									compatibility: this.#publicCompatibility(
										result.value.compatibility
									),
								}
							: {}),
					};
				} else {
					const previous = this.#state.statusBySimulator[device.id];
					next[device.id] = {
						simulatorUdid: device.id,
						condition: 'unknown',
						managedDisabledServiceIds: [],
						managedDisabledCount: 0,
						managedServiceCount: previous?.managedServiceCount ?? 0,
						matchingProfileIds: [],
						checkedAt: this.#now(),
						checkpointAvailable:
							this.#state.checkpointBySimulator[device.id] !== undefined ||
							this.#persistence.pendingMutation(device.id) !== undefined,
						...(previous?.compatibility
							? { compatibility: previous.compatibility }
							: {}),
						message:
							mapDeviceState(device.state) === 'shutdown'
								? 'Preview or mutate to inspect this Shutdown Simulator through a temporary, automatically restored boot.'
								: result.status === 'rejected'
									? safeErrorText(result.reason)
									: 'Managed service inspection is unavailable while the Simulator changes state.',
					};
				}
			}
		}
		this.#state.statusBySimulator = next;
	}

	#statusFromHelper(status: SimHelperStatus): SlimmingSimulatorStatus {
		const previous = this.#state.statusBySimulator[status.device.id];
		const partial = {
			simulatorUdid: status.device.id,
			managedDisabledServiceIds: status.managedDisabledServiceIds,
			managedDisabledCount: status.managedDisabledCount,
			managedServiceCount: status.managedServiceCount,
			matchingProfileIds: status.matchingProfileIds,
			checkedAt: this.#now(),
			checkpointAvailable:
				this.#state.checkpointBySimulator[status.device.id] !== undefined ||
				this.#persistence.pendingMutation(status.device.id) !== undefined,
			...(previous?.compatibility
				? { compatibility: previous.compatibility }
				: {}),
		};
		return { ...partial, condition: conditionForStatus(partial) };
	}

	#reject(action: SlimmingAction, error: string): SlimmingActionReceipt {
		return { actionId: action.actionId, accepted: false, error };
	}

	#updateTarget(
		job: InternalJob,
		index: number,
		patch: Partial<SlimmingJob['targets'][number]>
	): void {
		job.public = {
			...job.public,
			targets: job.public.targets.map((target, targetIndex) =>
				targetIndex === index ? { ...target, ...patch } : target
			),
		};
		this.#touch();
	}

	#updateJob(job: InternalJob, patch: Partial<SlimmingJob>): void {
		job.public = {
			...job.public,
			...patch,
			progressSequence: job.public.progressSequence + 1,
		};
		this.#touch();
	}

	#cancelRemaining(job: InternalJob, startIndex: number): void {
		job.public = {
			...job.public,
			targets: job.public.targets.map((target, index) =>
				index >= startIndex && target.status === 'queued'
					? { ...target, status: 'cancelled', message: 'Cancelled.' }
					: target
			),
		};
		this.#touch();
	}

	#touch(): void {
		this.#state.revision += 1;
		this.#state.updatedAt = this.#now();
		const state = this.getState();
		for (const listener of this.#listeners) {
			try {
				listener(state);
			} catch {
				// Observers cannot interrupt native helper supervision.
			}
		}
	}
}

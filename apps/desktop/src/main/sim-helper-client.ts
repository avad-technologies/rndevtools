import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { UDID_PATTERN } from '../shared/simulator-protocol';
import type { SlimmingCompatibility } from '../shared/slimming-protocol';
import {
	NativeHelperTrustError,
	type VerifiedSimulatorHelper,
	verifySimulatorHelper,
} from './native-helper-trust';
import { NativeHostResponseError } from './native-host-client';
import {
	runSimulatorCommand,
	SimulatorCommandError,
} from './simulator-command-runner';

const PROTOCOL_VERSION = 2;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 32 * 1024;
const READ_TIMEOUT_MS = 45_000;
const MINUTE_MS = 60 * 1_000;
const identifierSchema = z.string().trim().min(1).max(256);
const shortTextSchema = z.string().max(4 * 1024);
const serviceIdSchema = z
	.string()
	.trim()
	.min(3)
	.max(128)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]+$/);
const serviceIdsSchema = z.array(serviceIdSchema).max(1_000);
const processNamesSchema = z
	.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/))
	.max(256);
const udidSchema = z.string().regex(UDID_PATTERN);

function boundedCheckpointToken(value: string): string {
	if (
		value.length === 0 ||
		value.trim() !== value ||
		Buffer.byteLength(value, 'utf8') > MAX_CHECKPOINT_BYTES
	) {
		throw new SimHelperError(
			'invalid_checkpoint',
			'checkpointToken must be a non-empty bounded opaque token.'
		);
	}
	return value;
}

const operationSchema = z.enum([
	'handshake',
	'list_simulators',
	'clone_simulator',
	'disk_cleanup_plan',
	'disk_cleanup',
	'list_profiles',
	'simulator_status',
	'preview_profile',
	'verify_profile',
	'doctor',
	'prepare_mutation',
	'apply_profile',
	'restore_managed',
	'undo_last',
]);
export type SimHelperOperation = z.infer<typeof operationSchema>;

type OperationBudget = Readonly<{
	timeoutMs: number;
	forceKillDelayMs?: number;
}>;

const operationBudgets: Readonly<Record<SimHelperOperation, OperationBudget>> =
	{
		handshake: { timeoutMs: READ_TIMEOUT_MS },
		list_simulators: { timeoutMs: READ_TIMEOUT_MS },
		clone_simulator: {
			timeoutMs: 32 * MINUTE_MS,
			forceKillDelayMs: 21 * MINUTE_MS,
		},
		disk_cleanup_plan: {
			timeoutMs: 11 * MINUTE_MS,
			forceKillDelayMs: MINUTE_MS,
		},
		disk_cleanup: {
			timeoutMs: 11 * MINUTE_MS,
			forceKillDelayMs: 11 * MINUTE_MS,
		},
		list_profiles: { timeoutMs: READ_TIMEOUT_MS },
		simulator_status: {
			timeoutMs: 12 * MINUTE_MS,
			forceKillDelayMs: 11 * MINUTE_MS,
		},
		preview_profile: {
			timeoutMs: 12 * MINUTE_MS,
			forceKillDelayMs: 11 * MINUTE_MS,
		},
		verify_profile: {
			timeoutMs: 12 * MINUTE_MS,
			forceKillDelayMs: 11 * MINUTE_MS,
		},
		doctor: { timeoutMs: 12 * MINUTE_MS, forceKillDelayMs: 11 * MINUTE_MS },
		prepare_mutation: {
			timeoutMs: 31 * MINUTE_MS,
			forceKillDelayMs: 11 * MINUTE_MS,
		},
		apply_profile: {
			timeoutMs: 31 * MINUTE_MS,
			forceKillDelayMs: 31 * MINUTE_MS,
		},
		restore_managed: {
			timeoutMs: 31 * MINUTE_MS,
			forceKillDelayMs: 31 * MINUTE_MS,
		},
		undo_last: { timeoutMs: 31 * MINUTE_MS, forceKillDelayMs: 31 * MINUTE_MS },
	};
const mutationOperations = new Set<SimHelperOperation>([
	'clone_simulator',
	'disk_cleanup',
	'apply_profile',
	'restore_managed',
	'undo_last',
]);

const helperCompatibilitySchema = z.strictObject({
	status: z.enum(['verified', 'limited', 'unknown', 'blocked']),
	matrixVersion: shortTextSchema,
	tuple: z.strictObject({
		macOSBuild: shortTextSchema,
		xcodeBuild: shortTextSchema,
		coreSimulatorBuild: shortTextSchema,
		runtimeIdentifier: shortTextSchema,
		runtimeBuild: shortTextSchema,
		hostArchitecture: z.enum(['arm64', 'x64']),
		helperVersion: shortTextSchema,
		helperBuildCommit: z
			.string()
			.regex(/^[a-f0-9]{40}(?:-dirty:[a-f0-9]{64})?$/),
		catalogVersion: shortTextSchema,
	}),
	verifiedOperations: z
		.array(z.enum(['apply_profile', 'restore_managed', 'undo_last']))
		.max(3),
});
export type SimHelperCompatibility = z.infer<typeof helperCompatibilitySchema>;

const helperDeviceSchema = z.strictObject({
	id: udidSchema,
	name: shortTextSchema,
	state: shortTextSchema,
	runtimeIdentifier: shortTextSchema,
	deviceTypeIdentifier: shortTextSchema,
	available: z.boolean(),
});
export type SimHelperDevice = z.infer<typeof helperDeviceSchema>;

const helperCloneResultSchema = z.strictObject({
	sourceSimulatorId: udidSchema,
	simulatorId: udidSchema,
	name: shortTextSchema,
});
export type SimHelperCloneResult = z.infer<typeof helperCloneResultSchema>;

const diskCategoryIdSchema = z.enum([
	'caches',
	'logs',
	'temporary',
	'linguistic-data',
	'required-siri-assets',
]);
const diskCleanupCategoryIdSchema = z.enum([
	'caches',
	'logs',
	'temporary',
	'linguistic-data',
]);
const helperDiskPlanSchema = z.strictObject({
	simulatorId: udidSchema,
	totalBytes: z.number().int().nonnegative(),
	cleanableBytes: z.number().int().nonnegative(),
	categories: z
		.array(
			z.strictObject({
				id: diskCategoryIdSchema,
				name: shortTextSchema,
				description: shortTextSchema,
				downside: shortTextSchema,
				recovery: shortTextSchema,
				risk: shortTextSchema,
				defaultSelected: z.boolean(),
				canClean: z.boolean(),
				bytes: z.number().int().nonnegative(),
				targets: z.number().int().nonnegative().max(1_000_000),
			})
		)
		.max(5),
	storage: z
		.array(
			z.strictObject({
				id: z.enum(['installed-apps', 'documents', 'app-data', 'user-media']),
				name: shortTextSchema,
				description: shortTextSchema,
				bytes: z.number().int().nonnegative(),
			})
		)
		.max(4),
});
export type SimHelperDiskPlan = z.infer<typeof helperDiskPlanSchema>;

const helperDiskCleanupResultSchema = z.strictObject({
	simulatorId: udidSchema,
	categoryIds: z.array(diskCleanupCategoryIdSchema).min(1).max(4),
	beforeBytes: z.number().int().nonnegative(),
	afterBytes: z.number().int().nonnegative(),
	reclaimedBytes: z.number().int().nonnegative(),
	wasBooted: z.boolean(),
	bootStateRestored: z.boolean(),
});
export type SimHelperDiskCleanupResult = z.infer<
	typeof helperDiskCleanupResultSchema
>;

const helperStatusSchema = z.strictObject({
	device: helperDeviceSchema,
	managedDisabledServiceIds: serviceIdsSchema,
	managedDisabledCount: z.number().int().nonnegative().max(1_000),
	managedServiceCount: z.number().int().nonnegative().max(1_000),
	matchingProfileIds: z.array(identifierSchema).max(100),
});
export type SimHelperStatus = z.infer<typeof helperStatusSchema>;

const helperPlanSchema = z.strictObject({
	simulatorId: udidSchema,
	profileId: identifierSchema.optional(),
	currentDisabledServiceIds: serviceIdsSchema,
	desiredDisabledServiceIds: serviceIdsSchema,
	toDisableServiceIds: serviceIdsSchema,
	toEnableServiceIds: serviceIdsSchema,
	requiresCheckpoint: z.boolean(),
	requiresReboot: z.boolean(),
	executable: z.boolean(),
	blockedReason: shortTextSchema.optional(),
	compatibility: helperCompatibilitySchema.optional(),
});
export type SimHelperPlan = z.infer<typeof helperPlanSchema>;

const helperVerificationSchema = z.strictObject({
	verified: z.boolean(),
	currentManagedDisabledServiceIds: serviceIdsSchema,
	desiredManagedDisabledServiceIds: serviceIdsSchema,
	overridesMatch: z.boolean(),
	missingDisabledServiceIds: serviceIdsSchema,
	unexpectedDisabledServiceIds: serviceIdsSchema,
	disabledLaunchdJobRegistrationsAbsent: z.boolean(),
	checkedDisabledLaunchdJobRegistrationCount: z
		.number()
		.int()
		.nonnegative()
		.max(1_000),
	registeredDisabledLaunchdJobIds: serviceIdsSchema,
	observedPreMutationProcessesAbsent: z.boolean(),
	checkedObservedProcessNames: processNamesSchema,
	presentObservedProcessNames: processNamesSchema,
});
export type SimHelperVerification = z.infer<typeof helperVerificationSchema>;

const helperStateEvidenceSchema = z.strictObject({
	managedDisabledServiceIds: serviceIdsSchema,
	count: z.number().int().nonnegative().max(1_000),
});

const helperRollbackSchema = z.strictObject({
	attempted: z.boolean(),
	succeeded: z.boolean(),
	rebooted: z.boolean(),
	before: helperStateEvidenceSchema.optional(),
	after: helperStateEvidenceSchema.optional(),
	verification: helperVerificationSchema.optional(),
	errorCode: identifierSchema.optional(),
});

const helperMutationSchema = z.strictObject({
	operation: z.enum(['apply_profile', 'restore_managed', 'undo_last']),
	profileId: identifierSchema.optional(),
	failureCode: identifierSchema.optional(),
	failureDetail: z.string().max(2_048).optional(),
	changed: z.boolean(),
	checkpointToken: z
		.string()
		.refine(
			(value) => Buffer.byteLength(value, 'utf8') <= MAX_CHECKPOINT_BYTES,
			'checkpointToken exceeds 32 KiB.'
		),
	compatibility: helperCompatibilitySchema,
	originalBootState: z.enum(['Booted', 'Shutdown']),
	finalBootState: z.enum(['Booted', 'Shutdown', 'Unknown']),
	temporarilyBooted: z.boolean(),
	rebooted: z.boolean(),
	before: helperStateEvidenceSchema,
	desired: helperStateEvidenceSchema,
	plan: z.strictObject({
		toDisableServiceIds: serviceIdsSchema,
		toEnableServiceIds: serviceIdsSchema,
	}),
	after: helperStateEvidenceSchema,
	verification: helperVerificationSchema,
	rollback: helperRollbackSchema,
});
export type SimHelperMutation = z.infer<typeof helperMutationSchema>;

const helperPreparedMutationSchema = z.strictObject({
	operation: z.enum(['apply_profile', 'restore_managed', 'undo_last']),
	simulatorId: udidSchema,
	profileId: identifierSchema.optional(),
	changed: z.boolean(),
	checkpointToken: z
		.string()
		.refine(
			(value) => Buffer.byteLength(value, 'utf8') <= MAX_CHECKPOINT_BYTES,
			'checkpointToken exceeds 32 KiB.'
		),
	compatibility: helperCompatibilitySchema,
	originalBootState: z.enum(['Booted', 'Shutdown']),
	before: helperStateEvidenceSchema,
	desired: helperStateEvidenceSchema,
	plan: z.strictObject({
		toDisableServiceIds: serviceIdsSchema,
		toEnableServiceIds: serviceIdsSchema,
	}),
	verification: helperVerificationSchema,
	observedRunningProcessNames: processNamesSchema,
});
type SimHelperPreparedMutation = z.infer<typeof helperPreparedMutationSchema>;

const MAX_FAILURE_DETAIL_CHARS = 300;

/**
 * The helper writes its own diagnostics to stderr, and a crashed process leaves
 * nothing on stdout to parse. Without this, every spawn-level failure collapses
 * into one indistinguishable sentence and the real cause is only reachable from
 * a debugger.
 */
function helperFailureDetail(error: unknown): string {
	const parts: string[] = [];
	if (error instanceof SimulatorCommandError) {
		parts.push(error.kind);
		if (error.exitCode !== null) parts.push(`exit ${error.exitCode}`);
		const stderr = error.stderr.trim();
		if (stderr) parts.push(stderr);
	} else if (error instanceof NativeHostResponseError) {
		parts.push(`native host ${error.code}`);
		if (error.message.trim()) parts.push(error.message.trim());
	} else if (error instanceof Error && error.message.trim()) {
		parts.push(error.message.trim());
	}
	if (parts.length === 0) return '';
	const detail = parts.join(': ').replace(/\s+/g, ' ');
	return ` ${
		detail.length > MAX_FAILURE_DETAIL_CHARS
			? `${detail.slice(0, MAX_FAILURE_DETAIL_CHARS)}…`
			: detail
	}`;
}

export function mutationEvidenceFromError(
	error: SimHelperError
): SimHelperMutation | undefined {
	const direct = helperMutationSchema.safeParse(error.details);
	if (direct.success) return direct.data;
	const wrapped = z
		.strictObject({
			primaryErrorCode: identifierSchema,
			evidence: helperMutationSchema,
		})
		.safeParse(error.details);
	return wrapped.success ? wrapped.data.evidence : undefined;
}

const helperDoctorSchema = z.strictObject({
	simulatorId: udidSchema,
	healthy: z.boolean(),
	managedDisabledServiceIds: serviceIdsSchema,
	capabilities: z
		.array(
			z.strictObject({
				id: identifierSchema,
				available: z.boolean(),
				blockedByServiceIds: serviceIdsSchema,
			})
		)
		.max(20),
});
export type SimHelperDoctor = z.infer<typeof helperDoctorSchema>;

const helperHandshakeSchema = z.strictObject({
	helperVersion: shortTextSchema,
	buildCommit: shortTextSchema,
	signingTeamIdentifier: z
		.string()
		.regex(/^(?:[A-Z0-9]{10})?$/)
		.optional(),
	protocolVersion: z.literal(PROTOCOL_VERSION),
	platform: z.literal('darwin'),
	architecture: z.enum(['arm64', 'x64']),
	catalogVersion: shortTextSchema,
	catalogSource: z.strictObject({
		repository: z.literal('https://github.com/MobAI-App/simslim'),
		commit: z.string().regex(/^[a-f0-9]{40}$/),
		profilesSha256: z.string().regex(/^[a-f0-9]{64}$/),
		patchSet: z.literal('rndevtools.1'),
		upstreamSourceManifestSha256: z.literal(
			'bbd7640e2738197be54564d9f9926710a0dc5e13ee674d6e00e48bd5714b6172'
		),
		patchSha256: z.literal(
			'99703cfc6fa2bddf360f364b115edd0f235df82282e3e809daff543641a472f0'
		),
		vendoredSourceManifestSha256: z.literal(
			'887daa4543b0aecaefbdd9c7edb6e46e00205fecaba254c09527579dc84175d2'
		),
	}),
	capabilities: z.strictObject({
		operations: z.array(operationSchema).min(1).max(20),
		readOnlyAvailable: z.boolean(),
		mutationMode: shortTextSchema,
		mutationSafety: shortTextSchema,
		compatibilityMatrixVersion: shortTextSchema,
		compatibilityStates: z
			.array(z.enum(['verified', 'limited', 'unknown', 'blocked']))
			.max(4),
		verifiedMutationTuples: z.number().int().nonnegative(),
		checkpointTokenMaxBytes: z.literal(MAX_CHECKPOINT_BYTES),
		runtimeDownloads: z.literal(false),
	}),
});
export type SimHelperHandshake = z.infer<typeof helperHandshakeSchema>;

const helperProfilesSchema = z.strictObject({
	catalogVersion: shortTextSchema,
	categories: z
		.array(
			z.strictObject({
				id: identifierSchema,
				name: shortTextSchema,
				description: shortTextSchema,
				downside: shortTextSchema,
				approxMemoryMB: z.number().int().nonnegative().max(1_000_000),
				serviceIds: serviceIdsSchema,
			})
		)
		.max(100),
	profiles: z
		.array(
			z.strictObject({
				id: identifierSchema,
				name: shortTextSchema,
				description: shortTextSchema,
				categoryIds: z.array(identifierSchema).max(100),
				preservedServiceIds: serviceIdsSchema.optional(),
				experimental: z.boolean(),
			})
		)
		.max(100),
	doctorCapabilities: z
		.array(
			z.strictObject({ id: identifierSchema, displayName: shortTextSchema })
		)
		.max(20),
});
export type SimHelperProfiles = z.infer<typeof helperProfilesSchema>;

const helperErrorSchema = z.strictObject({
	code: identifierSchema,
	message: shortTextSchema,
	retryable: z.boolean(),
	details: z.unknown().optional(),
});

const helperResponseSchema = z.union([
	z.strictObject({
		protocolVersion: z.literal(PROTOCOL_VERSION),
		requestId: identifierSchema,
		ok: z.literal(true),
		result: z.unknown(),
	}),
	z.strictObject({
		protocolVersion: z.literal(PROTOCOL_VERSION),
		requestId: identifierSchema,
		ok: z.literal(false),
		error: helperErrorSchema,
	}),
]);

export class SimHelperError extends Error {
	readonly code: string;
	readonly retryable: boolean;
	readonly details: unknown;

	constructor(
		code: string,
		message: string,
		retryable = false,
		details?: unknown,
		options?: ErrorOptions
	) {
		super(message, options);
		this.name = 'SimHelperError';
		this.code = code;
		this.retryable = retryable;
		this.details = details;
	}
}

type CommandRunner = typeof runSimulatorCommand;
type TrustVerifier = typeof verifySimulatorHelper;
export type SimHelperMutationBroker = {
	runSimulatorMutation(
		helperRequest: string,
		options: OperationBudget & { signal?: AbortSignal }
	): Promise<string>;
};

export class SimHelperClient {
	readonly #resourceDirectory: string;
	readonly #appVersion: string;
	readonly #runner: CommandRunner;
	readonly #trustVerifier: TrustVerifier;
	readonly #mutationBroker: SimHelperMutationBroker | undefined;
	#verifiedHelper: Promise<VerifiedSimulatorHelper> | undefined;

	constructor({
		resourceDirectory,
		appVersion,
		runner = runSimulatorCommand,
		trustVerifier = verifySimulatorHelper,
		mutationBroker,
	}: {
		resourceDirectory: string;
		appVersion: string;
		runner?: CommandRunner;
		trustVerifier?: TrustVerifier;
		mutationBroker?: SimHelperMutationBroker;
	}) {
		this.#resourceDirectory = resourceDirectory;
		this.#appVersion = appVersion;
		this.#runner = runner;
		this.#trustVerifier = trustVerifier;
		this.#mutationBroker = mutationBroker;
	}

	async handshake(signal?: AbortSignal): Promise<SimHelperHandshake> {
		const handshake = helperHandshakeSchema.parse(
			await this.#call('handshake', {}, signal)
		);
		const verified = await this.#verifiedHelper;
		if (!verified) {
			throw new NativeHelperTrustError(
				'Native helper verification state was lost.',
				'untrusted'
			);
		}
		const manifest = verified.manifest;
		const operations = new Set(handshake.capabilities.operations);
		const compatibilityStates = new Set(
			handshake.capabilities.compatibilityStates
		);
		if (
			handshake.helperVersion !== manifest.appVersion ||
			handshake.buildCommit !== manifest.buildCommit ||
			handshake.architecture !== manifest.architecture ||
			handshake.catalogVersion !== manifest.catalog.version ||
			handshake.catalogSource.commit !== manifest.catalog.upstreamCommit ||
			handshake.capabilities.compatibilityMatrixVersion !==
				manifest.compatibilityMatrixVersion ||
			operations.size !== operationSchema.options.length ||
			operationSchema.options.some((operation) => !operations.has(operation)) ||
			compatibilityStates.size !== 4 ||
			(['verified', 'limited', 'unknown', 'blocked'] as const).some(
				(status) => !compatibilityStates.has(status)
			)
		) {
			throw new NativeHelperTrustError(
				'Native helper handshake does not match its verified manifest and protocol.',
				'untrusted'
			);
		}
		return handshake;
	}

	async listSimulators(signal?: AbortSignal): Promise<SimHelperDevice[]> {
		const result = z
			.strictObject({ simulators: z.array(helperDeviceSchema).max(512) })
			.parse(await this.#call('list_simulators', {}, signal));
		return result.simulators;
	}

	async cloneSimulator(
		simulatorId: string,
		name: string,
		signal?: AbortSignal
	): Promise<SimHelperCloneResult> {
		return helperCloneResultSchema.parse(
			await this.#call(
				'clone_simulator',
				{
					simulatorId: udidSchema.parse(simulatorId),
					name: z.string().trim().min(1).max(128).parse(name),
				},
				signal
			)
		);
	}

	async planDiskCleanup(
		simulatorId: string,
		signal?: AbortSignal
	): Promise<SimHelperDiskPlan> {
		const exactSimulatorId = udidSchema.parse(simulatorId);
		const plan = helperDiskPlanSchema.parse(
			await this.#call(
				'disk_cleanup_plan',
				{ simulatorId: exactSimulatorId },
				signal
			)
		);
		if (plan.simulatorId.toUpperCase() !== exactSimulatorId.toUpperCase()) {
			throw new SimHelperError(
				'response_mismatch',
				'Native helper disk plan did not match the exact Simulator target.'
			);
		}
		return plan;
	}

	async cleanDisk(
		simulatorId: string,
		categoryIds: readonly z.infer<typeof diskCleanupCategoryIdSchema>[],
		signal?: AbortSignal
	): Promise<SimHelperDiskCleanupResult> {
		const parsedCategoryIds = z
			.array(diskCleanupCategoryIdSchema)
			.min(1)
			.max(4)
			.refine((values) => new Set(values).size === values.length)
			.parse(categoryIds);
		const exactSimulatorId = udidSchema.parse(simulatorId);
		const result = helperDiskCleanupResultSchema.parse(
			await this.#call(
				'disk_cleanup',
				{
					simulatorId: exactSimulatorId,
					categoryIds: parsedCategoryIds,
					confirmation: 'CLEAN_SIMULATOR_DISK',
				},
				signal
			)
		);
		if (
			result.simulatorId.toUpperCase() !== exactSimulatorId.toUpperCase() ||
			result.categoryIds.length !== parsedCategoryIds.length ||
			result.categoryIds.some(
				(categoryId) => !parsedCategoryIds.includes(categoryId)
			)
		) {
			throw new SimHelperError(
				'response_mismatch',
				'Native helper disk cleanup result did not match the exact request.'
			);
		}
		return result;
	}

	async listProfiles(signal?: AbortSignal): Promise<SimHelperProfiles> {
		return helperProfilesSchema.parse(
			await this.#call('list_profiles', {}, signal)
		);
	}

	async simulatorStatus(
		simulatorId: string,
		signal?: AbortSignal
	): Promise<SimHelperStatus> {
		return helperStatusSchema.parse(
			await this.#call(
				'simulator_status',
				{ simulatorId: udidSchema.parse(simulatorId) },
				signal
			)
		);
	}

	async previewProfile(
		simulatorId: string,
		profileId: string,
		signal?: AbortSignal
	): Promise<SimHelperPlan> {
		return helperPlanSchema.parse(
			await this.#call(
				'preview_profile',
				{
					simulatorId: udidSchema.parse(simulatorId),
					profileId: identifierSchema.parse(profileId),
				},
				signal
			)
		);
	}

	async verifyProfile(
		simulatorId: string,
		profileId: string,
		signal?: AbortSignal
	): Promise<
		SimHelperVerification & { simulatorId: string; profileId: string }
	> {
		return helperVerificationSchema
			.extend({ simulatorId: udidSchema, profileId: identifierSchema })
			.strict()
			.parse(
				await this.#call(
					'verify_profile',
					{
						simulatorId: udidSchema.parse(simulatorId),
						profileId: identifierSchema.parse(profileId),
					},
					signal
				)
			);
	}

	async doctor(
		simulatorId: string,
		requiredCapabilities: readonly string[],
		signal?: AbortSignal
	): Promise<SimHelperDoctor> {
		return helperDoctorSchema.parse(
			await this.#call(
				'doctor',
				{
					simulatorId: udidSchema.parse(simulatorId),
					requiredCapabilities: [...requiredCapabilities],
				},
				signal
			)
		);
	}

	async prepareMutation(
		simulatorId: string,
		operation: 'apply_profile' | 'restore_managed' | 'undo_last',
		profileId: string | undefined,
		targetCheckpointToken: string | undefined,
		signal?: AbortSignal
	): Promise<SimHelperPreparedMutation> {
		const exactSimulatorId = udidSchema.parse(simulatorId);
		const exactProfileId =
			operation === 'apply_profile'
				? identifierSchema.parse(profileId)
				: z.literal(undefined).parse(profileId);
		const exactTargetCheckpoint =
			operation === 'undo_last'
				? boundedCheckpointToken(z.string().parse(targetCheckpointToken))
				: z.literal(undefined).parse(targetCheckpointToken);
		const prepared = helperPreparedMutationSchema.parse(
			await this.#call(
				'prepare_mutation',
				{
					simulatorId: exactSimulatorId,
					operation,
					profileId: exactProfileId ?? '',
					checkpointToken: exactTargetCheckpoint ?? '',
				},
				signal
			)
		);
		if (
			prepared.simulatorId.toUpperCase() !== exactSimulatorId.toUpperCase() ||
			prepared.operation !== operation ||
			prepared.profileId !== exactProfileId
		) {
			throw new SimHelperError(
				'response_mismatch',
				'Native helper mutation preparation did not match the exact request.'
			);
		}
		return prepared;
	}

	async applyProfile(
		simulatorId: string,
		profileId: string,
		checkpointToken: string,
		acknowledgement: 'EXPERIMENTAL' | undefined,
		signal?: AbortSignal
	): Promise<SimHelperMutation> {
		return helperMutationSchema.parse(
			await this.#call(
				'apply_profile',
				{
					simulatorId: udidSchema.parse(simulatorId),
					profileId: identifierSchema.parse(profileId),
					checkpointToken: boundedCheckpointToken(checkpointToken),
					confirmation: 'APPLY_EXPERIMENTAL_PROFILE',
					acknowledgement: acknowledgement ?? '',
				},
				signal
			)
		);
	}

	async restoreManaged(
		simulatorId: string,
		checkpointToken: string,
		acknowledgement: 'EXPERIMENTAL' | undefined,
		signal?: AbortSignal
	): Promise<SimHelperMutation> {
		return helperMutationSchema.parse(
			await this.#call(
				'restore_managed',
				{
					simulatorId: udidSchema.parse(simulatorId),
					checkpointToken: boundedCheckpointToken(checkpointToken),
					confirmation: 'RESTORE_ALL_MANAGED_SERVICES',
					acknowledgement: acknowledgement ?? '',
				},
				signal
			)
		);
	}

	async undoLast(
		simulatorId: string,
		preparedCheckpointToken: string,
		checkpointToken: string,
		acknowledgement: 'EXPERIMENTAL' | undefined,
		signal?: AbortSignal
	): Promise<SimHelperMutation> {
		return helperMutationSchema.parse(
			await this.#call(
				'undo_last',
				{
					simulatorId: udidSchema.parse(simulatorId),
					preparedCheckpointToken: boundedCheckpointToken(
						preparedCheckpointToken
					),
					checkpointToken: boundedCheckpointToken(checkpointToken),
					confirmation: 'UNDO_EXPERIMENTAL_MUTATION',
					acknowledgement: acknowledgement ?? '',
				},
				signal
			)
		);
	}

	async #call(
		operation: SimHelperOperation,
		payload: Readonly<Record<string, unknown>>,
		signal?: AbortSignal
	): Promise<unknown> {
		const requestId = `helper-${randomUUID()}`;
		const input = `${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, requestId, operation, payload })}\n`;
		if (Buffer.byteLength(input, 'utf8') > MAX_REQUEST_BYTES) {
			throw new SimHelperError(
				'request_too_large',
				'Helper request exceeds 64 KiB.'
			);
		}
		let helper: VerifiedSimulatorHelper;
		try {
			this.#verifiedHelper ??= this.#trustVerifier({
				resourceDirectory: this.#resourceDirectory,
				appVersion: this.#appVersion,
			});
			helper = await this.#verifiedHelper;
		} catch (error) {
			if (error instanceof NativeHelperTrustError) {
				this.#verifiedHelper = undefined;
				throw error;
			}
			throw new SimHelperError(
				'helper_trust_failed',
				'Native helper trust verification failed.',
				false,
				undefined,
				{ cause: error }
			);
		}

		let stdout: string;
		const budget = operationBudgets[operation];
		try {
			if (mutationOperations.has(operation)) {
				if (!this.#mutationBroker) {
					throw new SimHelperError(
						'mutation_broker_unavailable',
						'Simulator mutations require the authenticated packaged desktop broker.'
					);
				}
				stdout = await this.#mutationBroker.runSimulatorMutation(input, {
					...budget,
					...(signal ? { signal } : {}),
				});
			} else {
				stdout = (
					await this.#runner(helper.executablePath, [], {
						stdin: input,
						...(signal ? { signal } : {}),
						timeoutMs: budget.timeoutMs,
						...(budget.forceKillDelayMs
							? { forceKillDelayMs: budget.forceKillDelayMs }
							: {}),
						gracefulCancellationPipe: true,
						maxOutputBytes: MAX_RESPONSE_BYTES,
					})
				).stdout;
			}
		} catch (error) {
			if (error instanceof SimHelperError) throw error;
			if (error instanceof SimulatorCommandError && error.stdout) {
				stdout = error.stdout;
			} else {
				throw new SimHelperError(
					'helper_process_failed',
					`Native helper process failed.${helperFailureDetail(error)}`,
					false,
					undefined,
					{ cause: error }
				);
			}
		}

		let parsedJson: unknown;
		try {
			parsedJson = JSON.parse(stdout);
		} catch (cause) {
			throw new SimHelperError(
				'invalid_helper_response',
				'Native helper returned invalid JSON.',
				false,
				undefined,
				{ cause }
			);
		}
		const response = helperResponseSchema.parse(parsedJson);
		if (response.requestId !== requestId) {
			throw new SimHelperError(
				'response_mismatch',
				'Native helper response identifier did not match the request.'
			);
		}
		if (!response.ok) {
			throw new SimHelperError(
				response.error.code,
				response.error.message,
				response.error.retryable,
				response.error.details
			);
		}
		return response.result;
	}
}

export function compatibilityForPublic(
	compatibility: SimHelperCompatibility,
	key: string,
	acknowledged: boolean
): SlimmingCompatibility {
	return {
		key,
		...compatibility,
		acknowledgementRequired: compatibility.status === 'unknown',
		acknowledged,
	};
}

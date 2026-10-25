import { z } from 'zod';
import { UDID_PATTERN } from './simulator-protocol';

const MAX_SHORT_TEXT = 4 * 1024;
const MAX_SERVICE_IDS = 1_000;
const MAX_BATCH_SIZE = 20;
const confirmationTokenSchema = z.string().regex(/^confirmation-[a-f0-9]{64}$/);

const identifierSchema = z.string().trim().min(1).max(256);
const shortTextSchema = z.string().max(MAX_SHORT_TEXT);
const timestampSchema = z.number().finite().nonnegative();
const simulatorUdidSchema = z.string().regex(UDID_PATTERN);
const serviceIdentifierSchema = z
	.string()
	.trim()
	.min(3)
	.max(128)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]+$/);
const serviceIdentifiersSchema = z
	.array(serviceIdentifierSchema)
	.max(MAX_SERVICE_IDS);
const simulatorUdidsSchema = z
	.array(simulatorUdidSchema)
	.min(1)
	.max(MAX_BATCH_SIZE)
	.refine(
		(values) =>
			new Set(values.map((value) => value.toUpperCase())).size ===
			values.length,
		{
			message: 'Simulator batch targets must be unique.',
		}
	);

export const SLIMMING_EXPERIMENTAL_ACKNOWLEDGEMENT = 'EXPERIMENTAL' as const;
export const SLIMMING_CONFIRMATIONS = {
	apply: 'APPLY_EXPERIMENTAL_PROFILE',
	restore: 'RESTORE_ALL_MANAGED_SERVICES',
	undo: 'UNDO_EXPERIMENTAL_MUTATION',
	forget: 'FORGET_EMERGENCY_RESTORE_POINT',
} as const;

const slimmingConditionSchema = z.enum([
	'managed-clean',
	'profile-match',
	'drifted',
	'partial',
	'unknown',
	'needs-attention',
]);
export type SlimmingCondition = z.infer<typeof slimmingConditionSchema>;

const slimmingJobStatusSchema = z.enum([
	'queued',
	'preflight',
	'running',
	'verifying',
	'rolling-back',
	'complete',
	'failed',
	'needs-attention',
	'cancelled',
]);

const slimmingCategorySchema = z.strictObject({
	id: identifierSchema,
	name: shortTextSchema,
	description: shortTextSchema,
	downside: shortTextSchema,
	approxMemoryMb: z.number().int().nonnegative().max(1_000_000),
	serviceIds: serviceIdentifiersSchema,
});

const slimmingProfileSchema = z.strictObject({
	id: identifierSchema,
	name: shortTextSchema,
	description: shortTextSchema,
	categoryIds: z.array(identifierSchema).max(100),
	preservedServiceIds: serviceIdentifiersSchema.optional(),
	experimental: z.boolean(),
});
export type SlimmingProfile = z.infer<typeof slimmingProfileSchema>;

const slimmingSimulatorSchema = z.strictObject({
	udid: simulatorUdidSchema,
	name: shortTextSchema,
	state: z.enum([
		'booted',
		'shutdown',
		'booting',
		'shutting-down',
		'creating',
		'unknown',
	]),
	runtimeIdentifier: shortTextSchema,
	deviceTypeIdentifier: shortTextSchema.optional(),
	isAvailable: z.boolean(),
});
export type SlimmingSimulator = z.infer<typeof slimmingSimulatorSchema>;

const slimmingCompatibilityOperationSchema = z.enum([
	'apply_profile',
	'restore_managed',
	'undo_last',
]);

const slimmingCompatibilitySchema = z.strictObject({
	key: identifierSchema,
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
	verifiedOperations: z.array(slimmingCompatibilityOperationSchema).max(3),
	acknowledgementRequired: z.boolean(),
	acknowledged: z.boolean(),
	message: shortTextSchema.optional(),
});
export type SlimmingCompatibility = z.infer<typeof slimmingCompatibilitySchema>;

const slimmingSimulatorStatusSchema = z.strictObject({
	simulatorUdid: simulatorUdidSchema,
	condition: slimmingConditionSchema,
	managedDisabledServiceIds: serviceIdentifiersSchema,
	managedDisabledCount: z.number().int().nonnegative().max(MAX_SERVICE_IDS),
	managedServiceCount: z.number().int().nonnegative().max(MAX_SERVICE_IDS),
	matchingProfileIds: z.array(identifierSchema).max(100),
	checkedAt: timestampSchema,
	checkpointAvailable: z.boolean(),
	compatibility: slimmingCompatibilitySchema.optional(),
	message: shortTextSchema.optional(),
});
export type SlimmingSimulatorStatus = z.infer<
	typeof slimmingSimulatorStatusSchema
>;

const slimmingPlanSchema = z.strictObject({
	simulatorUdid: simulatorUdidSchema,
	profileId: identifierSchema.optional(),
	currentDisabledServiceIds: serviceIdentifiersSchema,
	desiredDisabledServiceIds: serviceIdentifiersSchema,
	toDisableServiceIds: serviceIdentifiersSchema,
	toEnableServiceIds: serviceIdentifiersSchema,
	requiresCheckpoint: z.boolean(),
	requiresReboot: z.boolean(),
	executable: z.boolean(),
	blockedReason: shortTextSchema.optional(),
	compatibility: slimmingCompatibilitySchema.optional(),
	previewedAt: timestampSchema,
});
export type SlimmingPlan = z.infer<typeof slimmingPlanSchema>;

const slimmingDoctorResultSchema = z.strictObject({
	simulatorUdid: simulatorUdidSchema,
	healthy: z.boolean(),
	checkedAt: timestampSchema,
	managedDisabledServiceIds: serviceIdentifiersSchema,
	capabilities: z
		.array(
			z.strictObject({
				id: identifierSchema,
				available: z.boolean(),
				blockedByServiceIds: serviceIdentifiersSchema,
			})
		)
		.max(20),
});
export type SlimmingDoctorResult = z.infer<typeof slimmingDoctorResultSchema>;

const slimmingCheckpointMetadataSchema = z.strictObject({
	id: identifierSchema,
	createdAt: timestampSchema,
	sourceOperationId: identifierSchema,
	profileId: identifierSchema.optional(),
	helperVersion: shortTextSchema,
	catalogVersion: shortTextSchema,
	compatibilityMatrixVersion: shortTextSchema,
});
export type SlimmingCheckpointMetadata = z.infer<
	typeof slimmingCheckpointMetadataSchema
>;

const slimmingOperationMetadataSchema = z.strictObject({
	id: identifierSchema,
	actionId: identifierSchema,
	kind: shortTextSchema,
	status: z.enum(['complete', 'failed', 'needs-attention', 'cancelled']),
	startedAt: timestampSchema,
	finishedAt: timestampSchema,
	profileId: identifierSchema.optional(),
	changed: z.boolean().optional(),
	condition: slimmingConditionSchema.optional(),
	errorCode: identifierSchema.optional(),
	message: shortTextSchema,
});
export type SlimmingOperationMetadata = z.infer<
	typeof slimmingOperationMetadataSchema
>;

const slimmingJobTargetSchema = z.strictObject({
	simulatorUdid: simulatorUdidSchema,
	status: z.enum([
		'queued',
		'running',
		'complete',
		'failed',
		'needs-attention',
		'cancelled',
	]),
	message: shortTextSchema,
	condition: slimmingConditionSchema.optional(),
	changed: z.boolean().optional(),
	checkpointAvailable: z.boolean().optional(),
	errorCode: identifierSchema.optional(),
});

const slimmingJobSchema = z.strictObject({
	id: identifierSchema,
	actionId: identifierSchema,
	kind: shortTextSchema,
	status: slimmingJobStatusSchema,
	progressSequence: z.number().int().nonnegative(),
	phase: shortTextSchema,
	message: shortTextSchema,
	createdAt: timestampSchema,
	startedAt: timestampSchema.optional(),
	finishedAt: timestampSchema.optional(),
	currentIndex: z.number().int().nonnegative().max(MAX_BATCH_SIZE),
	total: z.number().int().positive().max(MAX_BATCH_SIZE),
	profileId: identifierSchema.optional(),
	targets: z.array(slimmingJobTargetSchema).min(1).max(MAX_BATCH_SIZE),
});
export type SlimmingJob = z.infer<typeof slimmingJobSchema>;

const slimmingHelperStateSchema = z.strictObject({
	status: z.enum(['checking', 'available', 'unavailable', 'untrusted']),
	readOnlyAvailable: z.boolean(),
	helperVersion: shortTextSchema.optional(),
	buildCommit: shortTextSchema.optional(),
	catalogVersion: shortTextSchema.optional(),
	compatibilityMatrixVersion: shortTextSchema.optional(),
	mutationMode: shortTextSchema.optional(),
	mutationReason: shortTextSchema.optional(),
	mutationUnavailableReason: shortTextSchema.optional(),
	verifiedMutationTuples: z.number().int().nonnegative().optional(),
	verifiedAt: timestampSchema.optional(),
	error: shortTextSchema.optional(),
});

function boundedUdidRecord<T extends z.ZodType>(valueSchema: T) {
	return z
		.record(simulatorUdidSchema, valueSchema)
		.refine((value) => Object.keys(value).length <= 200, {
			message: 'Simulator record cannot contain more than 200 entries.',
		});
}

export const slimmingStateSchema = z.strictObject({
	revision: z.number().int().nonnegative(),
	updatedAt: timestampSchema,
	setting: z.strictObject({
		experimentalMutationsEnabled: z.boolean(),
		updatedAt: timestampSchema.optional(),
		disabledDisposition: z
			.enum([
				'restored-and-verified',
				'left-overrides-in-place',
				'restore-pending',
				'restore-failed',
			])
			.optional(),
		warning: shortTextSchema.optional(),
	}),
	helper: slimmingHelperStateSchema,
	categories: z.array(slimmingCategorySchema).max(100),
	profiles: z.array(slimmingProfileSchema).max(100),
	simulators: z.array(slimmingSimulatorSchema).max(200),
	statusBySimulator: boundedUdidRecord(slimmingSimulatorStatusSchema),
	previewBySimulator: boundedUdidRecord(slimmingPlanSchema),
	doctorBySimulator: boundedUdidRecord(slimmingDoctorResultSchema),
	jobs: z.array(slimmingJobSchema).max(100),
	checkpointBySimulator: boundedUdidRecord(slimmingCheckpointMetadataSchema),
	operationsBySimulator: boundedUdidRecord(
		z.array(slimmingOperationMetadataSchema).max(20)
	),
});
export type SlimmingState = z.infer<typeof slimmingStateSchema>;

/**
 * The agent session asking for a mutation. Absent on actions the operator
 * starts from the desktop. A held device may be mutated only by its holder,
 * so the service needs to know who is asking.
 */
const slimmingRequesterSchema = z.strictObject({
	kind: z.enum(['claude', 'codex', 'other']),
	sessionId: identifierSchema,
});
export type SlimmingRequester = z.infer<typeof slimmingRequesterSchema>;

const actionBase = {
	actionId: identifierSchema,
	simulatorUdids: simulatorUdidsSchema,
	confirmationToken: confirmationTokenSchema.optional(),
	requester: slimmingRequesterSchema.optional(),
};
const profileActionBase = {
	...actionBase,
	profileId: identifierSchema,
};

// Kept in one shared allowlist so renderer choices and the helper request
// boundary cannot silently diverge. The helper validates the same values.
const slimmingDoctorCapabilitySchema = z.enum([
	'push-notifications',
	'storekit',
	'universal-links',
	'icloud-sync',
	'healthkit',
	'homekit',
	'photo-library',
	'contacts',
	'calendar',
	'siri',
	'spotlight',
	'app-store',
]);

export const slimmingActionSchema = z.union([
	z.strictObject({ ...profileActionBase, kind: z.literal('profile.preview') }),
	z.strictObject({
		...profileActionBase,
		kind: z.literal('profile.apply'),
		confirmation: z.literal(SLIMMING_CONFIRMATIONS.apply),
	}),
	z.strictObject({
		...actionBase,
		kind: z.literal('profile.undo'),
		confirmation: z.literal(SLIMMING_CONFIRMATIONS.undo),
	}),
	z.strictObject({
		...actionBase,
		kind: z.literal('profile.restore'),
		confirmation: z.literal(SLIMMING_CONFIRMATIONS.restore),
	}),
	z.strictObject({ ...profileActionBase, kind: z.literal('profile.verify') }),
	/**
	 * Forgets the emergency restore point an interrupted mutation left behind
	 * (its pending reconciliation record), for when Undo can no longer use it,
	 * as after an Xcode, runtime or helper update. Never the last completed
	 * change's checkpoint. Operator only: it has no requester, so no agent
	 * request can express it, and main asks before every one.
	 */
	z.strictObject({
		actionId: identifierSchema,
		kind: z.literal('pending.forget'),
		simulatorUdids: simulatorUdidsSchema,
		confirmation: z.literal(SLIMMING_CONFIRMATIONS.forget),
		confirmationToken: confirmationTokenSchema.optional(),
	}),
	z.strictObject({
		...actionBase,
		kind: z.literal('doctor.run'),
		requiredCapabilities: z
			.array(slimmingDoctorCapabilitySchema)
			.min(1)
			.max(20)
			.refine((values) => new Set(values).size === values.length, {
				message: 'Doctor capabilities must be unique.',
			}),
	}),
]);
export type SlimmingAction = z.infer<typeof slimmingActionSchema>;

export const slimmingJobIdSchema = identifierSchema;
export const slimmingActionReceiptSchema = z.strictObject({
	actionId: identifierSchema,
	accepted: z.boolean(),
	jobId: slimmingJobIdSchema.optional(),
	error: shortTextSchema.optional(),
});
export type SlimmingActionReceipt = z.infer<typeof slimmingActionReceiptSchema>;

export const slimmingSettingRequestSchema = z.union([
	z.strictObject({
		actionId: identifierSchema,
		enabled: z.literal(true),
	}),
	z.strictObject({
		actionId: identifierSchema,
		enabled: z.literal(false),
		disposition: z.literal('leave-overrides-in-place'),
	}),
	z.strictObject({
		actionId: identifierSchema,
		enabled: z.literal(false),
		disposition: z.literal('restore-and-verify'),
		simulatorUdids: simulatorUdidsSchema,
		confirmation: z.literal(SLIMMING_CONFIRMATIONS.restore),
		confirmationToken: confirmationTokenSchema.optional(),
	}),
]);
export type SlimmingSettingRequest = z.infer<
	typeof slimmingSettingRequestSchema
>;

export const slimmingSettingReceiptSchema = z.strictObject({
	actionId: identifierSchema,
	accepted: z.boolean(),
	jobId: slimmingJobIdSchema.optional(),
	state: slimmingStateSchema,
	error: shortTextSchema.optional(),
});
export type SlimmingSettingReceipt = z.infer<
	typeof slimmingSettingReceiptSchema
>;

export const slimmingAcknowledgementRequestSchema = z.strictObject({
	actionId: identifierSchema,
	simulatorUdids: simulatorUdidsSchema,
	acknowledgement: z.literal(SLIMMING_EXPERIMENTAL_ACKNOWLEDGEMENT),
});
export type SlimmingAcknowledgementRequest = z.infer<
	typeof slimmingAcknowledgementRequestSchema
>;

export const slimmingAcknowledgementReceiptSchema = z.strictObject({
	actionId: identifierSchema,
	accepted: z.boolean(),
	state: slimmingStateSchema,
	error: shortTextSchema.optional(),
});
export type SlimmingAcknowledgementReceipt = z.infer<
	typeof slimmingAcknowledgementReceiptSchema
>;

export const slimmingConfirmationTargetSchema = z.union([
	slimmingActionSchema,
	slimmingSettingRequestSchema,
]);
export type SlimmingConfirmationTarget = z.infer<
	typeof slimmingConfirmationTargetSchema
>;

export const slimmingConfirmationResultSchema = z.strictObject({
	actionId: identifierSchema,
	required: z.boolean(),
	confirmed: z.boolean(),
	token: confirmationTokenSchema.optional(),
	expiresAt: timestampSchema.optional(),
	error: shortTextSchema.optional(),
});
export type SlimmingConfirmationResult = z.infer<
	typeof slimmingConfirmationResultSchema
>;

export type SlimmingBridge = {
	getSlimmingState: () => Promise<SlimmingState>;
	subscribeSlimmingState: (
		listener: (state: SlimmingState) => void
	) => () => void;
	refreshSlimming: () => Promise<SlimmingState>;
	setSlimmingEnabled: (
		request: SlimmingSettingRequest
	) => Promise<SlimmingSettingReceipt>;
	acknowledgeSlimmingCompatibility: (
		request: SlimmingAcknowledgementRequest
	) => Promise<SlimmingAcknowledgementReceipt>;
	requestSlimmingConfirmation: (
		target: SlimmingConfirmationTarget
	) => Promise<SlimmingConfirmationResult>;
	runSlimmingAction: (action: SlimmingAction) => Promise<SlimmingActionReceipt>;
	cancelSlimmingJob: (jobId: string) => Promise<boolean>;
};

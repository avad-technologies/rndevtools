import { z } from 'zod';
import { UDID_PATTERN } from './simulator-protocol';

export const RNDEVTOOLS_RECIPE_FORMAT_VERSION = 1 as const;
export const DEFAULT_RECIPE_RUN_CONCURRENCY = 2;

const MAX_SHORT_TEXT = 4 * 1024;
const MAX_CAMERA_BASE64 = 512 * 1024;
export const MAX_RECIPE_STEPS = 100;
export const MAX_RECIPE_TARGETS = 20;
export const MAX_RECIPE_CONCURRENCY = 8;
const MAX_TIMELINE_EVENTS = 5_000;
const MAX_HISTORY = 500;
const MAX_RECIPE_BYTES = 8 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 12 * 1024 * 1024;

const recipeIdentifierSchema = z
	.string()
	.trim()
	.min(1)
	.max(256)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const identifierSchema = recipeIdentifierSchema;
const shortTextSchema = z.string().max(MAX_SHORT_TEXT);
const evidenceMessageSchema = z.string().max(256);
const cleanupFailureSchema = z.string().max(1_024);
const timestampSchema = z.number().finite().nonnegative();
const udidSchema = z.string().regex(UDID_PATTERN);
const bundleIdentifierSchema = z
	.string()
	.trim()
	.min(1)
	.max(255)
	.regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/);
const appLocaleSchema = z
	.string()
	.trim()
	.min(2)
	.max(64)
	.regex(/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/);
const appLanguageSchema = z
	.string()
	.trim()
	.min(2)
	.max(35)
	.regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/);
const timeZoneSchema = z
	.string()
	.trim()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9][A-Za-z0-9._+-]*){0,3}$/)
	.refine(
		(value) =>
			value.split('/').every((segment) => segment !== '.' && segment !== '..'),
		{ message: 'Invalid time-zone identifier.' }
	);
const timeoutSchema = z
	.number()
	.int()
	.min(100)
	.max(10 * 60 * 1_000);
const confirmationTokenSchema = z.string().regex(/^confirmation-[a-f0-9]{64}$/);
const captureIdSchema = z
	.string()
	.regex(
		/^capture-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
	);
export const recipeIdSchema = identifierSchema;
export const recipeRunIdSchema = z
	.string()
	.regex(
		/^recipe-run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
	);
export const recipeEvidenceIdSchema = z
	.string()
	.regex(
		/^evidence-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
	);
const targetUdidsSchema = z
	.array(udidSchema)
	.min(1)
	.max(MAX_RECIPE_TARGETS)
	.refine(
		(values) =>
			new Set(values.map((value) => value.toUpperCase())).size ===
			values.length,
		{ message: 'Recipe target UDIDs must be unique.' }
	);

const stepBase = {
	id: identifierSchema,
	label: shortTextSchema.optional(),
	timeoutMs: timeoutSchema.optional(),
};

const safeUrlSchema = z
	.string()
	.url()
	.max(8 * 1024)
	.refine((value) => {
		try {
			return !new Set([
				'about:',
				'blob:',
				'data:',
				'file:',
				'javascript:',
				'vbscript:',
			]).has(new URL(value).protocol.toLowerCase());
		} catch {
			return false;
		}
	}, 'URL scheme is not safe for a recipe.');

const coordinateSchema = z.strictObject({
	latitude: z.number().finite().min(-90).max(90),
	longitude: z.number().finite().min(-180).max(180),
});

const privacyServiceSchema = z.enum([
	'all',
	'calendar',
	'contacts-limited',
	'contacts',
	'location',
	'location-always',
	'photos-add',
	'photos',
	'media-library',
	'microphone',
	'motion',
	'reminders',
	'siri',
]);

const uiValueSchema = z.enum([
	'light',
	'dark',
	'enabled',
	'disabled',
	'extra-small',
	'small',
	'medium',
	'large',
	'extra-large',
	'extra-extra-large',
	'extra-extra-extra-large',
	'accessibility-medium',
	'accessibility-large',
	'accessibility-extra-large',
	'accessibility-extra-extra-large',
	'accessibility-extra-extra-extra-large',
]);

const statusBarOverridesSchema = z
	.strictObject({
		time: z.string().max(64).optional(),
		dataNetwork: z
			.enum([
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
			])
			.optional(),
		wifiMode: z.enum(['searching', 'failed', 'active']).optional(),
		wifiBars: z.number().int().min(0).max(3).optional(),
		cellularMode: z
			.enum(['notSupported', 'searching', 'failed', 'active'])
			.optional(),
		cellularBars: z.number().int().min(0).max(4).optional(),
		operatorName: z.string().max(64).optional(),
		batteryState: z.enum(['charging', 'charged', 'discharging']).optional(),
		batteryLevel: z.number().int().min(0).max(100).optional(),
	})
	.refine(
		(overrides) =>
			Object.values(overrides).some((value) => value !== undefined),
		{ message: 'At least one status-bar override is required.' }
	);

const simulatorTemplateSchema = z.union([
	z.strictObject({ operation: z.literal('device.boot') }),
	z.strictObject({ operation: z.literal('device.shutdown') }),
	z.strictObject({
		operation: z.literal('app.launch'),
		bundleIdentifier: bundleIdentifierSchema,
		terminateRunning: z.boolean().default(false),
		arguments: z.array(z.string().max(MAX_SHORT_TEXT)).max(50).default([]),
		locale: appLocaleSchema.optional(),
		languages: z.array(appLanguageSchema).min(1).max(10).optional(),
		timeZone: timeZoneSchema.optional(),
		slowAnimations: z.boolean().optional(),
	}),
	z.strictObject({
		operation: z.literal('app.terminate'),
		bundleIdentifier: bundleIdentifierSchema,
	}),
	z.strictObject({
		operation: z.literal('pasteboard.sync'),
		direction: z.enum(['host-to-simulator', 'simulator-to-host']),
	}),
	z.strictObject({ operation: z.literal('url.open'), url: safeUrlSchema }),
	z.strictObject({
		operation: z.literal('location.set'),
		...coordinateSchema.shape,
	}),
	z.strictObject({ operation: z.literal('location.clear') }),
	z
		.strictObject({
			operation: z.literal('location.start'),
			waypoints: z.array(coordinateSchema).min(2).max(500),
			speedMetersPerSecond: z
				.number()
				.finite()
				.positive()
				.max(1_000)
				.optional(),
			distanceMeters: z.number().finite().positive().max(1_000_000).optional(),
			intervalSeconds: z.number().finite().positive().max(3_600).optional(),
		})
		.refine(
			(action) =>
				action.distanceMeters === undefined ||
				action.intervalSeconds === undefined,
			{ message: 'Location distance and interval are mutually exclusive.' }
		),
	z.strictObject({
		operation: z.literal('push.send'),
		bundleIdentifier: bundleIdentifierSchema,
		payloadJson: z
			.string()
			.min(1)
			.refine(
				(value) => new TextEncoder().encode(value).byteLength <= 4_096,
				'Push payload exceeds 4,096 UTF-8 bytes.'
			)
			.refine((value) => {
				try {
					const parsed = JSON.parse(value) as unknown;
					return Boolean(
						parsed &&
							typeof parsed === 'object' &&
							!Array.isArray(parsed) &&
							'aps' in parsed &&
							(parsed as { aps?: unknown }).aps &&
							typeof (parsed as { aps: unknown }).aps === 'object' &&
							!Array.isArray((parsed as { aps: unknown }).aps)
					);
				} catch {
					return false;
				}
			}, 'Push payload must contain an aps object.'),
	}),
	z.strictObject({
		operation: z.literal('privacy.update'),
		privacyOperation: z.enum(['grant', 'revoke', 'reset']),
		service: privacyServiceSchema,
		bundleIdentifier: bundleIdentifierSchema,
	}),
	z.strictObject({
		operation: z.literal('ui.appearance'),
		value: z.enum(['light', 'dark']),
	}),
	z
		.strictObject({
			operation: z.literal('ui.update'),
			setting: z.enum(['appearance', 'increase_contrast', 'content_size']),
			value: uiValueSchema,
		})
		.refine(
			(action) =>
				(action.setting === 'appearance' &&
					['light', 'dark'].includes(action.value)) ||
				(action.setting === 'increase_contrast' &&
					['enabled', 'disabled'].includes(action.value)) ||
				(action.setting === 'content_size' &&
					!['light', 'dark', 'enabled', 'disabled'].includes(action.value)),
			{ message: 'UI setting and value are incompatible.' }
		),
	z.strictObject({ operation: z.literal('statusBar.clear') }),
	z.strictObject({
		operation: z.literal('statusBar.override'),
		overrides: statusBarOverridesSchema,
	}),
	z.strictObject({ operation: z.literal('keychain.reset') }),
]);

const semanticActionSchema = z.discriminatedUnion('action', [
	z.strictObject({
		action: z.literal('highlight'),
		componentId: identifierSchema,
	}),
	z.strictObject({
		action: z.literal('activate'),
		componentId: identifierSchema,
	}),
	z.strictObject({ action: z.literal('focus'), componentId: identifierSchema }),
	z.strictObject({
		action: z.literal('setText'),
		componentId: identifierSchema,
		text: z.string().max(64 * 1024),
	}),
	z.strictObject({
		action: z.literal('scroll'),
		componentId: identifierSchema,
		direction: z.enum(['up', 'down', 'left', 'right']),
		amount: z.number().finite().positive().max(1).optional(),
	}),
]);

const cameraFixtureSchema = z.discriminatedUnion('fixtureKind', [
	z.strictObject({
		fixtureKind: z.enum(['still', 'qr']),
		label: shortTextSchema.optional(),
		mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
		dataBase64: z
			.string()
			.min(4)
			.max(MAX_CAMERA_BASE64)
			.regex(/^[A-Za-z0-9+/]*={0,2}$/)
			.refine(
				(value) => value.length % 4 === 0,
				'Camera fixture base64 is invalid.'
			),
		width: z.number().int().positive().max(16_384),
		height: z.number().int().positive().max(16_384),
	}),
	z.strictObject({
		fixtureKind: z.literal('video'),
		label: shortTextSchema.optional(),
		mimeType: z.enum(['video/mp4', 'video/quicktime']),
		dataBase64: z
			.string()
			.min(4)
			.max(MAX_CAMERA_BASE64)
			.regex(/^[A-Za-z0-9+/]*={0,2}$/)
			.refine(
				(value) => value.length % 4 === 0,
				'Camera fixture base64 is invalid.'
			),
		width: z.number().int().positive().max(16_384),
		height: z.number().int().positive().max(16_384),
		durationMs: z
			.number()
			.int()
			.positive()
			.max(10 * 60 * 1_000),
	}),
	z.strictObject({
		fixtureKind: z.literal('unavailable'),
		label: shortTextSchema.optional(),
	}),
	z.strictObject({
		fixtureKind: z.literal('error'),
		label: shortTextSchema.optional(),
		errorMessage: shortTextSchema,
	}),
]);

const assertionSchema = z.discriminatedUnion('condition', [
	z.strictObject({
		condition: z.literal('simulator.state'),
		expected: z.enum(['booted', 'shutdown']),
	}),
	z.strictObject({
		condition: z.literal('connected'),
		expected: z.boolean().default(true),
	}),
	z.strictObject({
		condition: z.literal('component.exists'),
		componentId: identifierSchema,
		expected: z.boolean().default(true),
	}),
	z.strictObject({
		condition: z.literal('screen.hash'),
		expectedHash: identifierSchema,
	}),
	z.strictObject({
		condition: z.literal('network.profile'),
		expectedProfileId: z.enum([
			'none',
			'offline',
			'edge',
			'3g',
			'lte',
			'wifi',
			'dsl',
			'very-bad',
		]),
	}),
	z.strictObject({
		condition: z.literal('camera.active'),
		expected: z.boolean(),
	}),
]);

const waitConditionSchema = z.discriminatedUnion('condition', [
	z.strictObject({
		condition: z.literal('component.exists'),
		componentId: identifierSchema,
	}),
	z.strictObject({
		condition: z.literal('screen.change'),
		fromHash: identifierSchema.optional(),
	}),
	z.strictObject({
		condition: z.literal('network.idle'),
		quietMs: z.number().int().min(100).max(60_000).default(1_000),
	}),
]);

const recipeStepSchema = z.union([
	z.strictObject({
		...stepBase,
		kind: z.literal('simulator'),
		action: simulatorTemplateSchema,
	}),
	z.strictObject({
		...stepBase,
		kind: z.literal('semantic'),
		action: semanticActionSchema,
	}),
	z
		.strictObject({
			...stepBase,
			kind: z.literal('network'),
			operation: z.enum(['set', 'clear']),
			profileId: z
				.enum(['offline', 'edge', '3g', 'lte', 'wifi', 'dsl', 'very-bad'])
				.optional(),
		})
		.refine(
			(step) =>
				(step.operation === 'set' && step.profileId !== undefined) ||
				(step.operation === 'clear' && step.profileId === undefined),
			{ message: 'Only a network set step accepts profileId.' }
		),
	z.strictObject({
		...stepBase,
		kind: z.literal('camera'),
		operation: z.literal('set'),
		fixture: cameraFixtureSchema,
	}),
	z.strictObject({
		...stepBase,
		kind: z.literal('camera'),
		operation: z.literal('clear'),
	}),
	z.strictObject({
		...stepBase,
		kind: z.literal('capture'),
		format: z.enum(['png', 'jpeg']).default('png'),
		mask: z.enum(['ignored', 'alpha', 'black']).default('alpha'),
		name: z.string().trim().min(1).max(128).optional(),
	}),
	z.strictObject({
		...stepBase,
		kind: z.literal('wait'),
		durationMs: z
			.number()
			.int()
			.min(0)
			.max(10 * 60 * 1_000),
	}),
	z.strictObject({
		...stepBase,
		kind: z.literal('wait-for'),
		waitFor: waitConditionSchema,
	}),
	z.strictObject({
		...stepBase,
		kind: z.literal('assert'),
		assertion: assertionSchema,
	}),
	z.strictObject({
		...stepBase,
		kind: z.literal('restore-point'),
		operation: z.literal('capture'),
		saveAs: identifierSchema,
		label: shortTextSchema.optional(),
	}),
	z.strictObject({
		...stepBase,
		kind: z.literal('restore-point'),
		operation: z.enum(['restore', 'remove']),
		reference: identifierSchema,
	}),
	z.strictObject({
		...stepBase,
		kind: z.literal('slimming.mutation'),
		operation: z.literal('apply'),
		profileId: identifierSchema,
		// Accepted only to migrate older local/imported recipes. The transform
		// deliberately discards it: tuple acknowledgement is operator-owned state.
		acknowledgement: z.literal('EXPERIMENTAL').optional(),
	}),
	z.strictObject({
		...stepBase,
		kind: z.literal('slimming.mutation'),
		operation: z.enum(['restore', 'undo']),
		acknowledgement: z.literal('EXPERIMENTAL').optional(),
	}),
]);
export type RecipeStep = z.infer<typeof recipeStepSchema>;

export const recipeDefinitionSchema = z
	.strictObject({
		formatVersion: z.literal(RNDEVTOOLS_RECIPE_FORMAT_VERSION),
		id: recipeIdSchema,
		name: z.string().trim().min(1).max(128),
		description: shortTextSchema.optional(),
		revision: z.number().int().positive().max(1_000_000),
		createdAt: timestampSchema,
		updatedAt: timestampSchema,
		defaultConcurrency: z
			.number()
			.int()
			.min(1)
			.max(MAX_RECIPE_CONCURRENCY)
			.default(DEFAULT_RECIPE_RUN_CONCURRENCY),
		steps: z.array(recipeStepSchema).min(1).max(MAX_RECIPE_STEPS),
		teardown: z.array(recipeStepSchema).max(MAX_RECIPE_STEPS).default([]),
	})
	.superRefine((recipe, context) => {
		if (recipe.steps.length + recipe.teardown.length > MAX_RECIPE_STEPS) {
			context.addIssue({
				code: 'custom',
				message: `A recipe cannot exceed ${MAX_RECIPE_STEPS} total steps.`,
			});
		}
		const ids = [...recipe.steps, ...recipe.teardown].map((step) => step.id);
		if (new Set(ids).size !== ids.length) {
			context.addIssue({
				code: 'custom',
				message: 'Recipe step IDs must be unique.',
			});
		}
		if (recipe.updatedAt < recipe.createdAt) {
			context.addIssue({
				code: 'custom',
				message: 'updatedAt cannot precede createdAt.',
			});
		}
		if (
			new TextEncoder().encode(JSON.stringify(recipe)).byteLength >
			MAX_RECIPE_BYTES
		) {
			context.addIssue({
				code: 'custom',
				message: `A recipe cannot exceed ${MAX_RECIPE_BYTES} UTF-8 bytes.`,
			});
		}
	});
export type RecipeDefinition = z.infer<typeof recipeDefinitionSchema>;

export const recipeSummarySchema = z.strictObject({
	id: recipeIdSchema,
	name: z.string().max(128),
	description: shortTextSchema.optional(),
	revision: z.number().int().positive(),
	updatedAt: timestampSchema,
	stepCount: z.number().int().nonnegative().max(MAX_RECIPE_STEPS),
	teardownStepCount: z.number().int().nonnegative().max(MAX_RECIPE_STEPS),
	requiresMutationApproval: z.boolean(),
});
export type RecipeSummary = z.infer<typeof recipeSummarySchema>;

const cleanupSchema = z.strictObject({
	status: z.enum([
		'not-started',
		'running',
		'complete',
		'partial',
		'failed',
		'interrupted',
	]),
	completedSteps: z.number().int().nonnegative().max(MAX_RECIPE_STEPS),
	totalSteps: z.number().int().nonnegative().max(MAX_RECIPE_STEPS),
	failures: z.array(cleanupFailureSchema).max(MAX_RECIPE_STEPS),
});

const recipeRunTargetSchema = z.strictObject({
	udid: udidSchema,
	status: z.enum([
		'queued',
		'resolving',
		'running',
		'complete',
		'failed',
		'cancelled',
		'interrupted',
	]),
	currentStepId: identifierSchema.optional(),
	completedSteps: z.number().int().nonnegative().max(MAX_RECIPE_STEPS),
	totalSteps: z.number().int().nonnegative().max(MAX_RECIPE_STEPS),
	message: shortTextSchema,
	cleanup: cleanupSchema,
});

const recipePendingRunRequestSchema = z.strictObject({
	actionId: identifierSchema,
	recipeId: recipeIdSchema,
	targetUdids: targetUdidsSchema,
	concurrency: z.number().int().min(1).max(MAX_RECIPE_CONCURRENCY),
});

export const recipeRunSchema = z
	.strictObject({
		id: recipeRunIdSchema,
		actionId: identifierSchema,
		recipeId: recipeIdSchema,
		recipeRevision: z.number().int().positive(),
		evidenceId: recipeEvidenceIdSchema,
		status: z.enum([
			'queued',
			'needs-approval',
			'resolving',
			'running',
			'cancelling',
			'complete',
			'failed',
			'cancelled',
			'interrupted',
		]),
		createdAt: timestampSchema,
		startedAt: timestampSchema.optional(),
		finishedAt: timestampSchema.optional(),
		progressSequence: z.number().int().nonnegative(),
		message: shortTextSchema,
		concurrency: z.number().int().min(1).max(MAX_RECIPE_CONCURRENCY),
		targetUdids: targetUdidsSchema,
		targets: z.array(recipeRunTargetSchema).min(1).max(MAX_RECIPE_TARGETS),
		pendingRequest: recipePendingRunRequestSchema.optional(),
	})
	.superRefine((run, context) => {
		if ((run.status === 'needs-approval') !== Boolean(run.pendingRequest)) {
			context.addIssue({
				code: 'custom',
				path: ['pendingRequest'],
				message:
					'Only a run awaiting approval may carry its exact pending request.',
			});
		}
	});
export type RecipeRun = z.infer<typeof recipeRunSchema>;

const evidenceTimelineEventSchema = z.strictObject({
	sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	at: timestampSchema,
	phase: z.enum(['run', 'step', 'teardown', 'recovery']),
	status: z.enum([
		'started',
		'complete',
		'failed',
		'cancelled',
		'interrupted',
		'info',
	]),
	message: evidenceMessageSchema,
	targetUdid: udidSchema.optional(),
	stepId: identifierSchema.optional(),
	captureId: captureIdSchema.optional(),
	diagnosticCorrelationIds: z.array(identifierSchema).max(3).optional(),
});

const evidenceTargetSchema = z.strictObject({
	udid: udidSchema,
	connectedDeviceId: identifierSchema.optional(),
	status: z.enum([
		'queued',
		'resolving',
		'running',
		'complete',
		'failed',
		'cancelled',
		'interrupted',
	]),
	cleanupStatus: cleanupSchema.shape.status,
	captureIds: z.array(captureIdSchema).max(MAX_RECIPE_STEPS),
	diagnosticCorrelationIds: z.array(identifierSchema).max(500),
});

export const recipeEvidenceManifestSchema = z
	.strictObject({
		format: z.literal('rndevtools-evidence-bundle'),
		formatVersion: z.literal(RNDEVTOOLS_RECIPE_FORMAT_VERSION),
		id: recipeEvidenceIdSchema,
		runId: recipeRunIdSchema,
		recipe: z.strictObject({
			id: recipeIdSchema,
			name: z.string().max(128),
			revision: z.number().int().positive(),
		}),
		createdAt: timestampSchema,
		finishedAt: timestampSchema.optional(),
		status: recipeRunSchema.shape.status,
		targets: z.array(evidenceTargetSchema).min(1).max(MAX_RECIPE_TARGETS),
		timeline: z.array(evidenceTimelineEventSchema).max(MAX_TIMELINE_EVENTS),
		captureIds: z
			.array(captureIdSchema)
			.max(MAX_RECIPE_STEPS * MAX_RECIPE_TARGETS),
		diagnosticCorrelationIds: z.array(identifierSchema).max(2_000),
	})
	.superRefine((evidence, context) => {
		if (
			new TextEncoder().encode(JSON.stringify(evidence)).byteLength >
			MAX_EVIDENCE_BYTES
		) {
			context.addIssue({
				code: 'custom',
				message: `Evidence cannot exceed ${MAX_EVIDENCE_BYTES} UTF-8 bytes.`,
			});
		}
	});
export type RecipeEvidenceManifest = z.infer<
	typeof recipeEvidenceManifestSchema
>;

export const recipeStateSchema = z.strictObject({
	revision: z.number().int().nonnegative(),
	updatedAt: timestampSchema,
	recipes: z.array(recipeSummarySchema).max(200),
	runs: z.array(recipeRunSchema).max(MAX_HISTORY),
});
export type RecipeState = z.infer<typeof recipeStateSchema>;

export const recipeRunRequestSchema = z.strictObject({
	actionId: identifierSchema,
	recipeId: recipeIdSchema,
	targetUdids: targetUdidsSchema,
	concurrency: z.number().int().min(1).max(MAX_RECIPE_CONCURRENCY).optional(),
	confirmationToken: confirmationTokenSchema.optional(),
});
export type RecipeRunRequest = z.infer<typeof recipeRunRequestSchema>;

export const recipeRunReceiptSchema = z.strictObject({
	actionId: identifierSchema,
	accepted: z.boolean(),
	runId: recipeRunIdSchema.optional(),
	needsApproval: z.boolean().optional(),
	error: shortTextSchema.optional(),
});
export type RecipeRunReceipt = z.infer<typeof recipeRunReceiptSchema>;

export const recipeRunConfirmationResultSchema = z.strictObject({
	actionId: identifierSchema,
	required: z.boolean(),
	confirmed: z.boolean(),
	token: confirmationTokenSchema.optional(),
	expiresAt: timestampSchema.optional(),
	error: shortTextSchema.optional(),
});
export type RecipeRunConfirmationResult = z.infer<
	typeof recipeRunConfirmationResultSchema
>;

export const recipeFileOperationSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		actionId: identifierSchema,
		kind: z.literal('recipe.import'),
	}),
	z.strictObject({
		actionId: identifierSchema,
		kind: z.literal('recipe.export'),
		recipeId: recipeIdSchema,
	}),
	z.strictObject({
		actionId: identifierSchema,
		kind: z.literal('recipe.delete'),
		recipeId: recipeIdSchema,
	}),
	z.strictObject({
		actionId: identifierSchema,
		kind: z.literal('evidence.export'),
		evidenceId: recipeEvidenceIdSchema,
	}),
]);
export type RecipeFileOperation = z.infer<typeof recipeFileOperationSchema>;

export const recipeFileOperationReceiptSchema = z.strictObject({
	actionId: identifierSchema,
	kind: z.enum([
		'recipe.import',
		'recipe.export',
		'recipe.delete',
		'evidence.export',
	]),
	completed: z.boolean(),
	cancelled: z.boolean().optional(),
	recipe: recipeSummarySchema.optional(),
	error: shortTextSchema.optional(),
});
export type RecipeFileOperationReceipt = z.infer<
	typeof recipeFileOperationReceiptSchema
>;

export const recipeImportFileSchema = z.strictObject({
	format: z.literal('rndevtools-recipe'),
	formatVersion: z.literal(RNDEVTOOLS_RECIPE_FORMAT_VERSION),
	recipe: recipeDefinitionSchema,
});

export type RecipeBridge = {
	getRecipeState: () => Promise<RecipeState>;
	subscribeRecipeState: (listener: (state: RecipeState) => void) => () => void;
	getRecipe: (recipeId: string) => Promise<RecipeDefinition | null>;
	getRecipeEvidence: (
		evidenceId: string
	) => Promise<RecipeEvidenceManifest | null>;
	saveRecipe: (recipe: RecipeDefinition) => Promise<RecipeSummary>;
	runRecipe: (request: RecipeRunRequest) => Promise<RecipeRunReceipt>;
	requestRecipeRunConfirmation: (
		request: RecipeRunRequest
	) => Promise<RecipeRunConfirmationResult>;
	cancelRecipeRun: (runId: string) => Promise<boolean>;
	runRecipeFileOperation: (
		operation: RecipeFileOperation
	) => Promise<RecipeFileOperationReceipt>;
};

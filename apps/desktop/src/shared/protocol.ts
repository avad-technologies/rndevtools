import {
	type DesktopDeviceAction,
	type DesktopDeviceInfoSnapshot,
	type DesktopDeviceToolsSnapshot,
	desktopActionCapability,
	parseDesktopDeviceAction,
	RNDEVTOOLS_ACTION_CAPABILITIES,
	RNDEVTOOLS_PROTOCOL_VERSION,
	RNDEVTOOLS_SNAPSHOT_LIMITS,
	RNDEVTOOLS_SUPPORTED_PROTOCOL_VERSIONS,
	RNDEVTOOLS_TOOL_IDS,
} from '@rndevtools/core/desktop-protocol';
import {
	isSensitiveDiagnosticKey,
	redactDiagnosticText,
} from '@rndevtools/core/redact';
import { z } from 'zod';
import { UDID_PATTERN } from './simulator-protocol';

export const DESKTOP_PROTOCOL_VERSION = RNDEVTOOLS_PROTOCOL_VERSION;
export const DESKTOP_SUPPORTED_PROTOCOL_VERSIONS =
	RNDEVTOOLS_SUPPORTED_PROTOCOL_VERSIONS;
export const DEFAULT_BROKER_HOST = '127.0.0.1';
export const DEFAULT_BROKER_PORT = 47931;

export { desktopActionCapability };

const SHORT_TEXT_MAX_LENGTH = 4 * 1024;
const LONG_TEXT_MAX_LENGTH = 512 * 1024;

/**
 * Redaction can lengthen text — `jwt:a` becomes `jwt:[REDACTED]` — so a value
 * that satisfied the raw bound can exceed it once transformed. Anything parsed
 * here is stored and later re-validated against this same schema by the preload
 * bridge, so an over-long transform output would make the broker's own state
 * unparseable and silently drop every later broadcast. Clamp after redacting so
 * the parsed value always satisfies the bound it was checked against.
 */
function redactWithinLength(value: string, maxLength: number): string {
	const redacted = redactDiagnosticText(value);
	if (redacted.length <= maxLength) return redacted;
	const clamped = redacted.slice(0, maxLength);
	const lastUnit = clamped.charCodeAt(maxLength - 1);
	// Never end on a high surrogate; that would leave a lone surrogate behind.
	return lastUnit >= 0xd800 && lastUnit <= 0xdbff
		? clamped.slice(0, -1)
		: clamped;
}

const identifierSchema = z.string().trim().min(1).max(256);
const networkSimulationProfileIds = [
	'none',
	'offline',
	'edge',
	'3g',
	'lte',
	'wifi',
	'dsl',
	'very-bad',
] as const;
const rawShortTextSchema = z.string().max(SHORT_TEXT_MAX_LENGTH);
const shortTextSchema = rawShortTextSchema.transform((value) =>
	redactWithinLength(value, SHORT_TEXT_MAX_LENGTH)
);
const rawLongTextSchema = z.string().max(LONG_TEXT_MAX_LENGTH);
const longTextSchema = rawLongTextSchema.transform((value) =>
	redactWithinLength(value, LONG_TEXT_MAX_LENGTH)
);
const timestampSchema = z
	.number()
	.finite()
	.nonnegative()
	.max(8_640_000_000_000_000);
const optionalTextSchema = shortTextSchema.optional();
const headerRecordSchema = z
	.record(z.string().max(256), longTextSchema)
	.refine((headers) => Object.keys(headers).length <= 200, {
		message: 'Header maps cannot contain more than 200 fields.',
	})
	.transform((headers) => {
		const output = Object.create(null) as Record<string, string>;
		for (const [name, value] of Object.entries(headers)) {
			output[name] = isSensitiveDiagnosticKey(name) ? '[REDACTED]' : value;
		}
		return output;
	});

const toolIdSchema = z.enum(RNDEVTOOLS_TOOL_IDS);
export type ToolId = z.infer<typeof toolIdSchema>;

const devicePlatformSchema = z.enum([
	'ios',
	'android',
	'web',
	'simulator',
	'unknown',
]);
const simulatorUdidSchema = z.string().regex(UDID_PATTERN);
const bundleIdentifierSchema = z
	.string()
	.trim()
	.min(1)
	.max(255)
	.regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/);
const deviceInfoObjectSchema = z.strictObject({
	id: identifierSchema,
	name: shortTextSchema,
	platform: devicePlatformSchema,
	model: shortTextSchema.optional(),
	osVersion: shortTextSchema.optional(),
	appVersion: shortTextSchema.optional(),
	buildVersion: shortTextSchema.optional(),
	runtimeVersion: shortTextSchema.optional(),
	variant: shortTextSchema.optional(),
	simulatorUdid: simulatorUdidSchema.optional(),
	bundleIdentifier: bundleIdentifierSchema.optional(),
	processId: z.number().int().positive().max(2_147_483_647).optional(),
	viewport: z
		.strictObject({
			width: z.number().finite().positive(),
			height: z.number().finite().positive(),
		})
		.optional(),
	capabilities: z
		.array(z.enum(RNDEVTOOLS_ACTION_CAPABILITIES))
		.max(RNDEVTOOLS_ACTION_CAPABILITIES.length)
		.default([]),
});
type DeviceInfoObject = z.infer<typeof deviceInfoObjectSchema>;
type ContractCompatibleDeviceInfo =
	DeviceInfoObject extends DesktopDeviceInfoSnapshot ? DeviceInfoObject : never;
const deviceInfoSchema = deviceInfoObjectSchema.transform(
	(device: ContractCompatibleDeviceInfo) => device
);
export type DeviceInfo = z.infer<typeof deviceInfoSchema>;

const networkEntrySchema = z.strictObject({
	id: identifierSchema,
	at: timestampSchema,
	method: z.string().trim().min(1).max(16),
	url: longTextSchema,
	host: shortTextSchema,
	path: longTextSchema,
	status: z.number().int().min(0).max(999).optional(),
	state: z.enum(['pending', 'success', 'error', 'aborted']),
	durationMs: z.number().finite().nonnegative().optional(),
	requestBytes: z.number().int().nonnegative().optional(),
	responseBytes: z.number().int().nonnegative().optional(),
	requestHeaders: headerRecordSchema.optional(),
	responseHeaders: headerRecordSchema.optional(),
	requestBody: longTextSchema.optional(),
	responseBody: longTextSchema.optional(),
	contentType: shortTextSchema.optional(),
	source: shortTextSchema.optional(),
	error: longTextSchema.optional(),
});
export type NetworkEntry = z.infer<typeof networkEntrySchema>;

const consoleEntrySchema = z.strictObject({
	id: identifierSchema,
	at: timestampSchema,
	firstAt: timestampSchema.optional(),
	lastAt: timestampSchema.optional(),
	level: z.enum(['debug', 'info', 'warn', 'error']),
	message: longTextSchema,
	attributesText: longTextSchema.optional(),
	source: shortTextSchema.optional(),
	scope: shortTextSchema.optional(),
	correlationId: identifierSchema.optional(),
	groupId: identifierSchema.optional(),
	repeatCount: z
		.number()
		.int()
		.positive()
		.max(Number.MAX_SAFE_INTEGER)
		.optional(),
	errorName: shortTextSchema.optional(),
	errorStack: longTextSchema.optional(),
	sourceLocation: z
		.strictObject({
			file: longTextSchema,
			line: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
			column: z
				.number()
				.int()
				.positive()
				.max(Number.MAX_SAFE_INTEGER)
				.optional(),
		})
		.optional(),
});
export type ConsoleEntry = z.infer<typeof consoleEntrySchema>;

const storageEntrySchema = z
	.strictObject({
		id: identifierSchema,
		adapterId: identifierSchema,
		adapterTitle: shortTextSchema,
		key: longTextSchema,
		valueText: rawLongTextSchema.optional(),
		valueType: z.enum([
			'string',
			'number',
			'boolean',
			'json',
			'binary',
			'hidden',
		]),
		bytes: z.number().int().nonnegative(),
		sensitive: z.boolean().default(false),
		editable: z.boolean().default(false),
		updatedAt: timestampSchema.optional(),
	})
	.transform((entry) => {
		const redactedValue =
			entry.valueText === undefined
				? undefined
				: redactDiagnosticText(entry.valueText);
		// As with header and environment names, a credential-named key hides its
		// value: opaque refresh tokens and passwords have no shape to recognize.
		const mustHide =
			entry.sensitive ||
			isSensitiveDiagnosticKey(entry.key) ||
			(entry.valueText !== undefined && redactedValue !== entry.valueText);
		if (mustHide) {
			const { valueText: _valueText, ...entryWithoutValue } = entry;
			return {
				...entryWithoutValue,
				valueType: 'hidden' as const,
				bytes: 0,
				sensitive: true,
				editable: false,
			};
		}
		return entry.valueText === undefined
			? entry
			: { ...entry, valueText: redactedValue };
	});
export type StorageEntry = z.infer<typeof storageEntrySchema>;

const storageEventSchema = z.strictObject({
	id: identifierSchema,
	at: timestampSchema,
	adapterId: identifierSchema,
	key: longTextSchema,
	kind: z.enum(['added', 'updated', 'removed']),
	previousText: longTextSchema.optional(),
	nextText: longTextSchema.optional(),
	bookmarked: z.boolean().optional(),
	undoAvailable: z.boolean().optional(),
	undoStatus: z
		.enum(['available', 'expired', 'succeeded', 'failed'])
		.optional(),
	structuralDiff: z
		.array(
			z.strictObject({
				path: shortTextSchema,
				kind: z.enum(['added', 'changed', 'removed']),
				previousText: shortTextSchema.optional(),
				nextText: shortTextSchema.optional(),
			})
		)
		.max(200)
		.optional(),
});
const boundedCountSchema = z
	.number()
	.int()
	.nonnegative()
	.max(Number.MAX_SAFE_INTEGER);

const storageSummarySchema = z.strictObject({
	adapterCount: boundedCountSchema,
	totalKeyCount: boundedCountSchema,
	omittedKeyCount: boundedCountSchema,
	truncated: z.boolean(),
	errors: z
		.array(
			z.strictObject({
				adapterId: identifierSchema,
				adapterTitle: shortTextSchema,
				message: longTextSchema,
			})
		)
		.max(10),
});
const queryEntrySchema = z.strictObject({
	id: identifierSchema,
	hash: longTextSchema,
	keyText: longTextSchema,
	status: z.enum(['pending', 'success', 'error']),
	fetchStatus: z.enum(['idle', 'fetching', 'paused']),
	updatedAt: timestampSchema,
	observers: z.number().int().nonnegative(),
	isStale: z.boolean(),
	dataText: longTextSchema.optional(),
	errorText: longTextSchema.optional(),
	truncated: z.boolean().default(false),
});
export type QueryEntry = z.infer<typeof queryEntrySchema>;

const mutationEntrySchema = z.strictObject({
	id: identifierSchema,
	keyText: longTextSchema,
	status: z.enum(['idle', 'pending', 'success', 'error']),
	submittedAt: timestampSchema.optional(),
	variablesText: longTextSchema.optional(),
	errorText: longTextSchema.optional(),
	truncated: z.boolean().default(false),
});
const querySummarySchema = z.strictObject({
	sourceQueryCount: boundedCountSchema,
	omittedQueryCount: boundedCountSchema,
	sourceMutationCount: boundedCountSchema,
	omittedMutationCount: boundedCountSchema,
	truncated: z.boolean(),
});
const querySimulationModeSchema = z.enum([
	'loading',
	'error',
	'paused',
	'offline',
]);
const querySimulationSchema = z
	.strictObject({
		families: z
			.array(
				z.strictObject({
					id: identifierSchema,
					label: shortTextSchema,
					description: longTextSchema.optional(),
					modes: z
						.array(
							z.strictObject({
								mode: querySimulationModeSchema,
								supported: z.boolean(),
								reason: longTextSchema.optional(),
							})
						)
						.length(4),
				})
			)
			.min(1)
			.max(50),
		active: z
			.strictObject({
				familyId: identifierSchema,
				familyLabel: shortTextSchema,
				mode: querySimulationModeSchema,
				receiptId: identifierSchema,
				startedAt: timestampSchema,
			})
			.optional(),
	})
	.superRefine((simulation, context) => {
		const familyIds = new Set<string>();
		for (const [familyIndex, family] of simulation.families.entries()) {
			if (familyIds.has(family.id)) {
				context.addIssue({
					code: 'custom',
					message: 'Query simulation family IDs must be unique.',
					path: ['families', familyIndex, 'id'],
				});
			}
			familyIds.add(family.id);
			const modes = new Set(family.modes.map((mode) => mode.mode));
			if (modes.size !== querySimulationModeSchema.options.length) {
				context.addIssue({
					code: 'custom',
					message: 'Query simulation families must describe every mode once.',
					path: ['families', familyIndex, 'modes'],
				});
			}
			for (const [modeIndex, mode] of family.modes.entries()) {
				if (!mode.supported && !mode.reason) {
					context.addIssue({
						code: 'custom',
						message: 'Unsupported query simulation modes require a reason.',
						path: ['families', familyIndex, 'modes', modeIndex, 'reason'],
					});
				}
			}
		}
		if (simulation.active) {
			const activeFamily = simulation.families.find(
				(family) => family.id === simulation.active?.familyId
			);
			const activeMode = activeFamily?.modes.find(
				(mode) => mode.mode === simulation.active?.mode
			);
			if (
				!activeFamily ||
				!activeMode?.supported ||
				activeFamily.label !== simulation.active.familyLabel
			) {
				context.addIssue({
					code: 'custom',
					message:
						'Active query simulation must reference a supported family mode.',
					path: ['active'],
				});
			}
		}
	});
const routeEntrySchema = z.strictObject({
	id: identifierSchema,
	path: longTextSchema,
	name: shortTextSchema,
	kind: z.enum([
		'static',
		'dynamic',
		'catchAll',
		'layout',
		'group',
		'internal',
	]),
	filename: longTextSchema.optional(),
	isCurrent: z.boolean().default(false),
	isVisible: z.boolean().default(false),
	depth: z.number().int().nonnegative().default(0),
});
export type RouteEntry = z.infer<typeof routeEntrySchema>;

const routeEventSchema = z.strictObject({
	id: identifierSchema,
	at: timestampSchema,
	route: longTextSchema,
	metadataText: longTextSchema.optional(),
	transitionId: identifierSchema.optional(),
	phase: z.enum(['requested', 'committed', 'focused', 'failed']).optional(),
	source: z
		.enum(['app', 'panel', 'desktop', 'scenario', 'restore', 'deep-link'])
		.optional(),
	correlationId: identifierSchema.optional(),
	durationMs: z.number().finite().nonnegative().optional(),
	error: longTextSchema.optional(),
});
export type RouteEvent = z.infer<typeof routeEventSchema>;
const environmentEntrySchema = z
	.strictObject({
		id: identifierSchema,
		section: shortTextSchema,
		key: shortTextSchema,
		valueText: longTextSchema,
		status: z.enum([
			'valid',
			'missing',
			'typeMismatch',
			'valueMismatch',
			'unchecked',
		]),
		description: longTextSchema.optional(),
	})
	.transform((entry) =>
		isSensitiveDiagnosticKey(entry.key)
			? { ...entry, valueText: '[REDACTED]' }
			: entry
	);
export type EnvironmentEntry = z.infer<typeof environmentEntrySchema>;

const zustandStoreSchema = z.strictObject({
	id: identifierSchema,
	title: shortTextSchema,
	description: optionalTextSchema,
	stateText: longTextSchema,
	keys: z.array(shortTextSchema).max(RNDEVTOOLS_SNAPSHOT_LIMITS.storageKeys),
	updatedAt: timestampSchema,
	capabilities: z
		.strictObject({
			writable: z.boolean(),
			resettable: z.boolean(),
			persisted: z.boolean(),
			restorable: z.boolean(),
		})
		.default({
			writable: false,
			resettable: false,
			persisted: false,
			restorable: false,
		}),
	error: longTextSchema.optional(),
});
const zustandChangeSchema = z.strictObject({
	id: identifierSchema,
	at: timestampSchema,
	storeId: identifierSchema,
	storeTitle: shortTextSchema,
	changedKeys: z
		.array(shortTextSchema)
		.max(RNDEVTOOLS_SNAPSHOT_LIMITS.zustandChangedKeys),
	stateText: longTextSchema,
	error: longTextSchema.optional(),
});
const zustandStateSnapshotSchema = z.strictObject({
	id: identifierSchema,
	storeId: identifierSchema,
	storeTitle: shortTextSchema,
	createdAt: timestampSchema,
	stateText: longTextSchema,
	stateBytes: z
		.number()
		.int()
		.nonnegative()
		.max(1024 * 1024),
	truncated: z.boolean(),
});
const zustandMutationReceiptSchema = z.strictObject({
	id: identifierSchema,
	storeId: identifierSchema,
	kind: z.enum(['patch', 'reset', 'jump']),
	status: z.enum(['succeeded', 'failed', 'rolled-back', 'needs-attention']),
	startedAt: timestampSchema,
	completedAt: timestampSchema,
	changedKeys: z
		.array(shortTextSchema)
		.max(RNDEVTOOLS_SNAPSHOT_LIMITS.zustandChangedKeys),
	correlationId: identifierSchema.optional(),
	snapshotId: identifierSchema.optional(),
	error: longTextSchema.optional(),
});
const zustandSummarySchema = z.strictObject({
	totalStoreCount: boundedCountSchema,
	omittedStoreCount: boundedCountSchema,
	truncated: z.boolean(),
	error: longTextSchema.optional(),
});
const restoreSourceSchema = z.strictObject({
	id: identifierSchema,
	title: shortTextSchema,
	preview: longTextSchema,
	bytes: z.number().int().nonnegative(),
});
const restorePointSchema = z.strictObject({
	id: identifierSchema,
	label: shortTextSchema,
	createdAt: timestampSchema,
	estimatedBytes: z.number().int().nonnegative(),
	sources: z
		.array(restoreSourceSchema)
		.max(RNDEVTOOLS_SNAPSHOT_LIMITS.restoreSources),
});
const restoreSourceResultSchema = z.strictObject({
	sourceId: identifierSchema,
	sourceTitle: shortTextSchema,
	preflight: z.enum(['pending', 'passed', 'failed']),
	apply: z.enum(['not-run', 'succeeded', 'failed']),
	rollback: z.enum(['not-needed', 'succeeded', 'failed']),
	error: longTextSchema.optional(),
	rollbackError: longTextSchema.optional(),
});
const restoreReceiptSchema = z.strictObject({
	id: identifierSchema,
	pointId: identifierSchema,
	pointLabel: shortTextSchema,
	startedAt: timestampSchema,
	completedAt: timestampSchema,
	status: z.enum([
		'complete',
		'preflight-failed',
		'rolled-back',
		'needs-attention',
	]),
	error: longTextSchema.optional(),
	sourceResults: z
		.array(restoreSourceResultSchema)
		.max(RNDEVTOOLS_SNAPSHOT_LIMITS.restoreSources),
});
const performanceSampleSchema = z.strictObject({
	id: identifierSchema,
	at: timestampSchema,
	jsFps: z.number().finite().min(0).max(240),
	uiFps: z.number().finite().min(0).max(240).optional(),
	cpuPercent: z.number().finite().min(0).max(100).optional(),
	memoryMb: z.number().finite().nonnegative().optional(),
	eventLoopLagMs: z.number().finite().nonnegative(),
	longFrames: z.number().int().nonnegative(),
	maxFrameMs: z.number().finite().nonnegative(),
	route: longTextSchema.optional(),
});
export type PerformanceSample = z.infer<typeof performanceSampleSchema>;

const performanceSummarySchema = z.strictObject({
	grade: z.enum(['idle', 'healthy', 'needsAttention', 'critical']),
	durationMs: z.number().finite().nonnegative(),
	sampleCount: z.number().int().nonnegative(),
	averageJsFps: z.number().finite().nonnegative(),
	averageUiFps: z.number().finite().nonnegative().optional(),
	averageEventLoopLagMs: z.number().finite().nonnegative(),
	p95EventLoopLagMs: z.number().finite().nonnegative(),
	maxEventLoopLagMs: z.number().finite().nonnegative(),
	longFrameCount: z.number().int().nonnegative(),
});
const performanceReviewSchema = z.strictObject({
	isActive: z.boolean(),
	startedAt: timestampSchema.nullable(),
	stoppedAt: timestampSchema.nullable(),
	error: longTextSchema.optional(),
	droppedSampleCount: boundedCountSchema.default(0),
	samples: z
		.array(performanceSampleSchema)
		.max(RNDEVTOOLS_SNAPSHOT_LIMITS.performanceSamples),
	summary: performanceSummarySchema,
});
export type PerformanceReview = z.infer<typeof performanceReviewSchema>;

const scenarioPrimitiveSchema = z.union([
	z.string().max(16 * 1024),
	z.number().finite(),
	z.boolean(),
	z.null(),
]);
const scenarioStepTypeSchema = z.enum([
	'network-profile',
	'storage-write',
	'zustand-write',
	'query-simulation',
	'developer-overrides',
	'impersonation',
	'navigation',
	'custom-action',
]);
const scenarioVariableSchema = z
	.strictObject({
		id: identifierSchema,
		label: shortTextSchema,
		type: z.enum(['string', 'number', 'boolean']),
		required: z.boolean(),
		defaultValue: scenarioPrimitiveSchema.optional(),
		options: z.array(scenarioPrimitiveSchema).max(50).optional(),
	})
	.refine(
		(variable) =>
			variable.defaultValue === undefined ||
			typeof variable.defaultValue === variable.type,
		{ message: 'Scenario variable defaults must match their declared type.' }
	);
const scenarioDefinitionSummarySchema = z.strictObject({
	id: identifierSchema,
	version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	definitionToken: identifierSchema,
	name: shortTextSchema,
	description: z
		.string()
		.max(16 * 1024)
		.optional(),
	bundled: z.boolean(),
	variables: z
		.array(scenarioVariableSchema)
		.max(RNDEVTOOLS_SNAPSHOT_LIMITS.scenarioVariables),
	preconditionCount: boundedCountSchema,
	steps: z
		.array(
			z.strictObject({
				id: identifierSchema,
				type: scenarioStepTypeSchema,
				label: shortTextSchema.optional(),
			})
		)
		.max(RNDEVTOOLS_SNAPSHOT_LIMITS.scenarioSteps),
});
export type ScenarioDefinitionSummary = z.infer<
	typeof scenarioDefinitionSummarySchema
>;
const activeScenarioSchema = z.strictObject({
	receiptId: identifierSchema,
	scenarioId: identifierSchema,
	scenarioVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	scenarioName: shortTextSchema,
	activatedAt: timestampSchema,
	stepCount: boundedCountSchema,
	privileged: z.boolean(),
	warnings: z.array(shortTextSchema).max(100),
	recoveryRequired: z.boolean(),
});
const scenarioRuntimeSchema = z.strictObject({
	running: z.boolean(),
	recoveryError: longTextSchema.optional(),
	active: activeScenarioSchema.optional(),
});
const scenarioStepReceiptSchema = z.strictObject({
	stepId: identifierSchema,
	stepType: scenarioStepTypeSchema,
	label: shortTextSchema,
	preflight: z.enum(['pending', 'passed', 'failed']),
	apply: z.enum(['not-run', 'succeeded', 'failed']),
	rollback: z.enum(['not-needed', 'succeeded', 'failed']),
	reversible: z.boolean().optional(),
	privileged: z.boolean().optional(),
	warnings: z.array(shortTextSchema).max(100).optional(),
	summary: shortTextSchema.optional(),
	error: longTextSchema.optional(),
	rollbackError: longTextSchema.optional(),
});
const scenarioReceiptSchema = z.strictObject({
	id: identifierSchema,
	scenarioId: identifierSchema,
	scenarioVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	scenarioName: shortTextSchema,
	startedAt: timestampSchema,
	completedAt: timestampSchema,
	status: z.enum([
		'complete',
		'preflight-failed',
		'rolled-back',
		'needs-attention',
	]),
	error: longTextSchema.optional(),
	stepResults: z
		.array(scenarioStepReceiptSchema)
		.max(RNDEVTOOLS_SNAPSHOT_LIMITS.scenarioSteps),
});

const identitySchema = z
	.strictObject({
		kind: z.enum(['signed-out', 'account', 'persona']),
		label: shortTextSchema,
		personaId: identifierSchema.optional(),
	})
	.refine(
		(identity) =>
			identity.kind === 'persona'
				? identity.personaId !== undefined
				: identity.personaId === undefined,
		{ message: 'Only persona identities may include a persona identifier.' }
	);
const identitySessionSchema = z.strictObject({
	running: z.boolean(),
	active: z
		.strictObject({
			historyId: identifierSchema,
			startedAt: timestampSchema,
			actor: identitySchema,
			target: identitySchema,
			status: z.enum(['active', 'needs-attention']),
			error: longTextSchema.optional(),
		})
		.optional(),
	history: z
		.array(
			z.strictObject({
				id: identifierSchema,
				startedAt: timestampSchema,
				stoppedAt: timestampSchema.optional(),
				actor: identitySchema,
				target: identitySchema,
				status: z.enum(['active', 'stopped', 'needs-attention']),
				error: longTextSchema.optional(),
			})
		)
		.max(RNDEVTOOLS_SNAPSHOT_LIMITS.identityHistory),
	personas: z
		.array(
			z.strictObject({
				id: identifierSchema,
				label: shortTextSchema,
				note: shortTextSchema,
			})
		)
		.max(RNDEVTOOLS_SNAPSHOT_LIMITS.identityPersonas),
});

const componentTargetSchema = z.strictObject({
	id: identifierSchema,
	targetId: identifierSchema.optional(),
	parentId: identifierSchema.optional(),
	depth: z.number().int().min(0).max(100).optional(),
	zIndex: z.number().finite().min(-100_000).max(100_000).optional(),
	name: shortTextSchema,
	kind: shortTextSchema,
	feature: optionalTextSchema,
	route: longTextSchema.optional(),
	testID: optionalTextSchema,
	targetKey: optionalTextSchema,
	sourceFiles: z
		.array(longTextSchema)
		.max(RNDEVTOOLS_SNAPSHOT_LIMITS.componentSourceFiles),
	instanceText: longTextSchema.optional(),
	instanceTruncated: z.boolean().default(false),
	bounds: z
		.strictObject({
			x: z.number().finite(),
			y: z.number().finite(),
			width: z.number().finite().nonnegative(),
			height: z.number().finite().nonnegative(),
		})
		.nullable(),
	isFocused: z.boolean(),
	accessibilityLabel: optionalTextSchema,
	accessibilityHint: optionalTextSchema,
	accessibilityRole: optionalTextSchema,
	accessibilityValue: optionalTextSchema,
	accessibilityState: z
		.record(shortTextSchema, z.union([z.boolean(), shortTextSchema]))
		.refine((state) => Object.keys(state).length <= 50, {
			message: 'Accessibility state cannot contain more than 50 fields.',
		})
		.optional(),
	styleText: longTextSchema.optional(),
	styleTruncated: z.boolean().optional(),
	// Snapshot frames do not repeat the negotiated hello version. Keep these
	// optional so supported v1 sessions continue through the same bounded parser.
	actions: z
		.array(z.enum(['activate', 'focus', 'setText', 'scroll']))
		.max(4)
		.optional(),
	screenHash: identifierSchema.optional(),
});
export type ComponentTarget = z.infer<typeof componentTargetSchema>;

const componentRenderSchema = z.strictObject({
	id: identifierSchema,
	targetId: identifierSchema,
	at: timestampSchema,
	phase: z.enum(['mount', 'update', 'nested-update']),
	actualDuration: z.number().finite().nonnegative().max(60_000),
	baseDuration: z.number().finite().nonnegative().max(60_000),
	startTime: timestampSchema,
	commitTime: timestampSchema,
	renderCount: z.number().int().positive().max(1_000_000_000),
	cause: z.enum(['mount', 'props', 'tracked-state', 'parent', 'unknown']),
	changedKeys: z.array(shortTextSchema).max(20),
});

const componentSummarySchema = z.strictObject({
	sourceTargetCount: boundedCountSchema,
	omittedTargetCount: boundedCountSchema,
	truncated: z.boolean(),
	screenHash: identifierSchema.optional(),
	registrationDiagnostics: z
		.array(
			z.strictObject({
				code: z.enum([
					'duplicate-target-id',
					'orphan-parent',
					'invalid-hierarchy',
				]),
				targetId: identifierSchema,
				instanceIds: z
					.array(identifierSchema)
					.max(RNDEVTOOLS_SNAPSHOT_LIMITS.components),
				message: longTextSchema,
			})
		)
		.max(RNDEVTOOLS_SNAPSHOT_LIMITS.componentDiagnostics)
		.optional(),
	error: longTextSchema.optional(),
});
const cameraFixtureSchema = z
	.strictObject({
		active: z.boolean(),
		kind: z.enum(['still', 'qr', 'video', 'unavailable', 'error']).optional(),
		label: shortTextSchema.optional(),
		mimeType: z
			.enum([
				'image/jpeg',
				'image/png',
				'image/webp',
				'video/mp4',
				'video/quicktime',
			])
			.optional(),
		bytes: z
			.number()
			.int()
			.nonnegative()
			.max(384 * 1024)
			.optional(),
		width: z.number().int().positive().max(16_384).optional(),
		height: z.number().int().positive().max(16_384).optional(),
		durationMs: z
			.number()
			.int()
			.positive()
			.max(10 * 60 * 1_000)
			.optional(),
	})
	.refine(
		(fixture) => {
			const details = [
				fixture.kind,
				fixture.label,
				fixture.mimeType,
				fixture.bytes,
				fixture.width,
				fixture.height,
				fixture.durationMs,
			];
			if (!fixture.active) return details.every((value) => value === undefined);
			if (!fixture.kind) return false;
			if (fixture.kind === 'unavailable' || fixture.kind === 'error') {
				return (
					fixture.mimeType === undefined &&
					fixture.bytes === undefined &&
					fixture.width === undefined &&
					fixture.height === undefined &&
					fixture.durationMs === undefined
				);
			}
			const hasMedia =
				fixture.mimeType !== undefined &&
				fixture.bytes !== undefined &&
				fixture.bytes > 0 &&
				fixture.width !== undefined &&
				fixture.height !== undefined;
			if (!hasMedia) return false;
			if (fixture.kind === 'video') {
				return (
					(fixture.mimeType === 'video/mp4' ||
						fixture.mimeType === 'video/quicktime') &&
					fixture.durationMs !== undefined
				);
			}
			return (
				(fixture.mimeType === 'image/jpeg' ||
					fixture.mimeType === 'image/png' ||
					fixture.mimeType === 'image/webp') &&
				fixture.durationMs === undefined
			);
		},
		{ message: 'Camera fixture metadata is inconsistent.' }
	);
const diagnosticEntrySchema = z.strictObject({
	id: identifierSchema,
	at: timestampSchema,
	level: z.enum(['debug', 'info', 'warn', 'error']),
	scope: shortTextSchema,
	message: longTextSchema,
});
export type DiagnosticEntry = z.infer<typeof diagnosticEntrySchema>;

const deviceToolsObjectSchema = z.strictObject({
	network: z.array(networkEntrySchema).max(RNDEVTOOLS_SNAPSHOT_LIMITS.network),
	networkProfile: z
		.strictObject({
			id: z.enum(networkSimulationProfileIds),
			name: shortTextSchema,
			active: z.boolean(),
			scope: z.literal('instrumented-fetch'),
		})
		.optional(),
	console: z.array(consoleEntrySchema).max(RNDEVTOOLS_SNAPSHOT_LIMITS.console),
	storage: z.array(storageEntrySchema).max(RNDEVTOOLS_SNAPSHOT_LIMITS.storage),
	storageEvents: z
		.array(storageEventSchema)
		.max(RNDEVTOOLS_SNAPSHOT_LIMITS.storageEvents),
	storageSummary: storageSummarySchema,
	queries: z.array(queryEntrySchema).max(RNDEVTOOLS_SNAPSHOT_LIMITS.queries),
	mutations: z
		.array(mutationEntrySchema)
		.max(RNDEVTOOLS_SNAPSHOT_LIMITS.mutations),
	querySummary: querySummarySchema,
	querySimulation: querySimulationSchema.optional(),
	routes: z.array(routeEntrySchema).max(RNDEVTOOLS_SNAPSHOT_LIMITS.routes),
	routeEvents: z
		.array(routeEventSchema)
		.max(RNDEVTOOLS_SNAPSHOT_LIMITS.routeEvents),
	environment: z
		.array(environmentEntrySchema)
		.max(RNDEVTOOLS_SNAPSHOT_LIMITS.environment),
	zustandStores: z
		.array(zustandStoreSchema)
		.max(RNDEVTOOLS_SNAPSHOT_LIMITS.zustandStores),
	zustandChanges: z
		.array(zustandChangeSchema)
		.max(RNDEVTOOLS_SNAPSHOT_LIMITS.zustandChanges),
	zustandStateSnapshots: z
		.array(zustandStateSnapshotSchema)
		.max(RNDEVTOOLS_SNAPSHOT_LIMITS.zustandStateSnapshots)
		.default([]),
	zustandMutationReceipts: z
		.array(zustandMutationReceiptSchema)
		.max(RNDEVTOOLS_SNAPSHOT_LIMITS.zustandMutationReceipts)
		.default([]),
	zustandSummary: zustandSummarySchema,
	restorePoints: z
		.array(restorePointSchema)
		.max(RNDEVTOOLS_SNAPSHOT_LIMITS.restorePoints),
	restoreReceipts: z
		.array(restoreReceiptSchema)
		.max(RNDEVTOOLS_SNAPSHOT_LIMITS.restoreReceipts)
		.default([]),
	scenarios: z
		.array(scenarioDefinitionSummarySchema)
		.max(RNDEVTOOLS_SNAPSHOT_LIMITS.scenarios)
		.default([]),
	scenarioRuntime: scenarioRuntimeSchema.default({ running: false }),
	scenarioReceipts: z
		.array(scenarioReceiptSchema)
		.max(RNDEVTOOLS_SNAPSHOT_LIMITS.scenarioReceipts)
		.default([]),
	identitySession: identitySessionSchema.default({
		running: false,
		history: [],
		personas: [],
	}),
	performance: performanceReviewSchema,
	components: z
		.array(componentTargetSchema)
		.max(RNDEVTOOLS_SNAPSHOT_LIMITS.components),
	componentRenders: z
		.array(componentRenderSchema)
		.max(RNDEVTOOLS_SNAPSHOT_LIMITS.componentRenders)
		.default([]),
	componentSummary: componentSummarySchema,
	cameraFixture: cameraFixtureSchema.default({ active: false }),
	diagnostics: z
		.array(diagnosticEntrySchema)
		.max(RNDEVTOOLS_SNAPSHOT_LIMITS.diagnostics),
});

type DeviceToolsObject = z.infer<typeof deviceToolsObjectSchema>;
type ContractCompatibleDeviceTools =
	DeviceToolsObject extends DesktopDeviceToolsSnapshot
		? DeviceToolsObject
		: never;

function storageKeyId(adapterId: string, key: string): string {
	return JSON.stringify([adapterId, key]);
}

function scrubSensitiveStorage(
	tools: ContractCompatibleDeviceTools
): DeviceToolsObject {
	// Events carry no sensitivity of their own, so one keeps its value text only
	// while this snapshot lists its key in clear. Events of a hidden entry lose
	// it, and so do events of a removed key or of an adapter with no entries
	// here, such as a secure store emptied on sign-out. The storage panel shows
	// history only for a listed entry, so those last two were never visible.
	const visibleKeyIds = new Set(
		tools.storage
			.filter((entry) => !entry.sensitive)
			.map((entry) => storageKeyId(entry.adapterId, entry.key))
	);
	return {
		...tools,
		storage: tools.storage.map((entry) => {
			if (!entry.sensitive) return entry;
			const { valueText: _valueText, ...entryWithoutValue } = entry;
			return {
				...entryWithoutValue,
				bytes: 0,
				editable: false,
			};
		}),
		storageEvents: tools.storageEvents.map((event) => ({
			...event,
			...(visibleKeyIds.has(storageKeyId(event.adapterId, event.key))
				? {
						structuralDiff: event.structuralDiff
							? [...event.structuralDiff]
							: undefined,
					}
				: {
						previousText: undefined,
						nextText: undefined,
						structuralDiff: undefined,
					}),
		})),
	};
}

const deviceToolsSchema = deviceToolsObjectSchema.transform(
	scrubSensitiveStorage
);
export type DeviceTools = z.infer<typeof deviceToolsSchema>;

export function createEmptyDeviceTools(): DeviceTools {
	return {
		network: [],
		console: [],
		storage: [],
		storageEvents: [],
		storageSummary: {
			adapterCount: 0,
			totalKeyCount: 0,
			omittedKeyCount: 0,
			truncated: false,
			errors: [],
		},
		queries: [],
		mutations: [],
		querySummary: {
			sourceQueryCount: 0,
			omittedQueryCount: 0,
			sourceMutationCount: 0,
			omittedMutationCount: 0,
			truncated: false,
		},
		routes: [],
		routeEvents: [],
		environment: [],
		zustandStores: [],
		zustandChanges: [],
		zustandStateSnapshots: [],
		zustandMutationReceipts: [],
		zustandSummary: {
			totalStoreCount: 0,
			omittedStoreCount: 0,
			truncated: false,
		},
		restorePoints: [],
		restoreReceipts: [],
		scenarios: [],
		scenarioRuntime: { running: false },
		scenarioReceipts: [],
		identitySession: { running: false, history: [], personas: [] },
		performance: {
			isActive: false,
			startedAt: null,
			stoppedAt: null,
			droppedSampleCount: 0,
			samples: [],
			summary: {
				grade: 'idle',
				durationMs: 0,
				sampleCount: 0,
				averageJsFps: 0,
				averageEventLoopLagMs: 0,
				p95EventLoopLagMs: 0,
				maxEventLoopLagMs: 0,
				longFrameCount: 0,
			},
		},
		components: [],
		componentRenders: [],
		componentSummary: {
			sourceTargetCount: 0,
			omittedTargetCount: 0,
			truncated: false,
			screenHash: 'empty',
			registrationDiagnostics: [],
		},
		cameraFixture: { active: false },
		diagnostics: [],
	};
}

export const deviceSessionSchema = z.strictObject({
	info: deviceInfoSchema,
	status: z.enum(['online', 'offline', 'simulated']),
	connectedAt: timestampSchema,
	lastSeenAt: timestampSchema,
	sequence: z.number().int().nonnegative(),
	latencyMs: z.number().finite().nonnegative().optional(),
	tools: deviceToolsSchema,
});
export type DeviceSession = z.infer<typeof deviceSessionSchema>;

const brokerInfoSchema = z.strictObject({
	status: z.enum(['starting', 'listening', 'error', 'stopped']),
	host: shortTextSchema,
	port: z.number().int().min(1).max(65_535),
	access: z.enum(['loopback', 'token']),
	// Pairing URLs intentionally retain the broker token so the operator can
	// copy them to a device. They are never logged by the desktop client.
	urls: z.array(rawShortTextSchema).max(50),
	error: longTextSchema.optional(),
});
const MAX_DESKTOP_DEVICES = 50;
export const desktopStateSchema = z.strictObject({
	protocolVersion: z.literal(DESKTOP_PROTOCOL_VERSION),
	broker: brokerInfoSchema,
	devices: z.array(deviceSessionSchema).max(MAX_DESKTOP_DEVICES),
	diagnostics: z.array(diagnosticEntrySchema).max(2_000),
});
export type DesktopState = z.infer<typeof desktopStateSchema>;

// Everything `desktopStateSchema` checks except each device's tools.
const desktopStateEnvelopeSchema = desktopStateSchema.extend({
	devices: z
		.array(deviceSessionSchema.extend({ tools: z.unknown() }))
		.max(MAX_DESKTOP_DEVICES),
});

type AcceptedDeviceTools = {
	connectedAt: number;
	sequence: number;
	tools: DeviceTools;
};

type DesktopStateParseResult =
	| { success: true; data: DesktopState }
	| { success: false; error: z.ZodError };

/**
 * Accepts and returns what `desktopStateSchema` would, but parses a device's
 * tools only when they changed. The broker re-sends every device's tools on
 * each emit, up to several MiB each with every text field redacted again,
 * although main replaces a session's tools only together with a higher
 * sequence and starts a reconnected session with a new `connectedAt`. A device
 * whose id, `connectedAt` and `sequence` match the last accepted state reuses
 * the tools parsed then; the incoming copy is discarded, so nothing reaches the
 * listener unvalidated.
 */
export function createDesktopStateParser(): (
	value: unknown
) => DesktopStateParseResult {
	let accepted = new Map<string, AcceptedDeviceTools>();
	return (value) => {
		const envelope = desktopStateEnvelopeSchema.safeParse(value);
		if (!envelope.success) return { success: false, error: envelope.error };
		const next = new Map<string, AcceptedDeviceTools>();
		const devices: DeviceSession[] = [];
		for (const [index, device] of envelope.data.devices.entries()) {
			const previous = accepted.get(device.info.id);
			let tools: DeviceTools;
			if (
				previous?.connectedAt === device.connectedAt &&
				previous.sequence === device.sequence
			) {
				tools = previous.tools;
			} else {
				const parsed = deviceToolsSchema.safeParse(device.tools);
				if (!parsed.success) {
					return {
						success: false,
						error: new z.ZodError(
							parsed.error.issues.map((issue) => ({
								...issue,
								path: ['devices', index, 'tools', ...issue.path],
							}))
						),
					};
				}
				tools = parsed.data;
			}
			next.set(device.info.id, {
				connectedAt: device.connectedAt,
				sequence: device.sequence,
				tools,
			});
			devices.push({ ...device, tools });
		}
		accepted = next;
		return { success: true, data: { ...envelope.data, devices } };
	};
}

export const deviceHelloMessageSchema = z.strictObject({
	type: z.literal('hello'),
	protocolVersion: z.union([
		z.literal(DESKTOP_SUPPORTED_PROTOCOL_VERSIONS[0]),
		z.literal(DESKTOP_SUPPORTED_PROTOCOL_VERSIONS[1]),
	]),
	device: deviceInfoSchema,
});

export const deviceSnapshotMessageSchema = z.strictObject({
	type: z.literal('snapshot'),
	sequence: z.number().int().nonnegative(),
	sentAt: timestampSchema,
	tools: deviceToolsSchema,
});

const deviceHeartbeatMessageSchema = z.strictObject({
	type: z.literal('heartbeat'),
	sentAt: timestampSchema,
});

const deviceActionResultMessageSchema = z.strictObject({
	type: z.literal('action-result'),
	actionId: identifierSchema,
	ok: z.boolean(),
	error: longTextSchema.optional(),
});

export const deviceMessageSchema = z.discriminatedUnion('type', [
	deviceHelloMessageSchema,
	deviceSnapshotMessageSchema,
	deviceHeartbeatMessageSchema,
	deviceActionResultMessageSchema,
]);
export type DeviceMessage = z.infer<typeof deviceMessageSchema>;

export const desktopActionSchema = z.unknown().transform((value, context) => {
	const action = parseDesktopDeviceAction(value);
	if (action) return action;
	context.addIssue({
		code: 'custom',
		message: 'Desktop action is not on the explicit command allowlist.',
	});
	return z.NEVER;
});
export type DesktopAction = DesktopDeviceAction;

export const desktopActionResultSchema = z.strictObject({
	actionId: identifierSchema,
	ok: z.boolean(),
	error: longTextSchema.optional(),
});
export type DesktopActionResult = z.infer<typeof desktopActionResultSchema>;

const desktopPlatformSchema = z.enum([
	'aix',
	'android',
	'browser',
	'cygwin',
	'darwin',
	'freebsd',
	'haiku',
	'linux',
	'netbsd',
	'openbsd',
	'sunos',
	'win32',
]);

export const desktopBootstrapSchema = z.strictObject({
	state: desktopStateSchema,
	platform: desktopPlatformSchema,
	versions: z.strictObject({
		app: shortTextSchema,
		electron: shortTextSchema,
		chrome: shortTextSchema,
		node: shortTextSchema,
	}),
});
export type DesktopBootstrap = z.infer<typeof desktopBootstrapSchema>;

export type DesktopBridge = {
	getBootstrap: () => Promise<DesktopBootstrap>;
	subscribe: (listener: (state: DesktopState) => void) => () => void;
	runAction: (action: DesktopAction) => Promise<DesktopActionResult>;
};

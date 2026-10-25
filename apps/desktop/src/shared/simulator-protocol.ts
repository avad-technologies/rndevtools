import { z } from 'zod';

const MAX_SHORT_TEXT = 4 * 1024;
const MAX_LONG_TEXT = 512 * 1024;

const identifierSchema = z.string().trim().min(1).max(256);
const shortTextSchema = z.string().max(MAX_SHORT_TEXT);
const optionalShortTextSchema = shortTextSchema.optional();
const timestampSchema = z.number().finite().nonnegative();
/** A Simulator UDID, in either letter case. */
export const UDID_PATTERN = /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i;
export const udidSchema = z
	.string()
	.regex(UDID_PATTERN, 'Invalid simulator UDID.');
const bundleIdentifierSchema = z
	.string()
	.trim()
	.min(1)
	.max(255)
	.regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/, 'Invalid bundle identifier.');
const runtimeIdentifierSchema = z
	.string()
	.trim()
	.min(1)
	.max(512)
	.regex(/^com\.apple\.CoreSimulator\.SimRuntime\.[A-Za-z0-9.-]+$/);
const deviceTypeIdentifierSchema = z
	.string()
	.trim()
	.min(1)
	.max(512)
	.regex(/^com\.apple\.CoreSimulator\.SimDeviceType\.[A-Za-z0-9.-]+$/);
const nameSchema = z.string().trim().min(1).max(128);
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
const MAX_PUSH_PAYLOAD_BYTES = 4_096;
const MIN_CAPTURE_RETENTION_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_CAPTURE_RETENTION_BYTES = 100 * 1024 * 1024 * 1024;
const UNSAFE_URL_PROTOCOLS = new Set([
	'about:',
	'blob:',
	'data:',
	'file:',
	'javascript:',
	'vbscript:',
]);

const simulatorUrlSchema = z
	.string()
	.url()
	.max(8 * 1024)
	.refine((value) => {
		try {
			return !UNSAFE_URL_PROTOCOLS.has(new URL(value).protocol.toLowerCase());
		} catch {
			return false;
		}
	}, 'URL scheme is not supported for Simulator deep links.');

const simulatorUniversalLinkSchema = simulatorUrlSchema.refine(
	(value) => new URL(value).protocol.toLowerCase() === 'https:',
	'Universal links must use HTTPS.'
);

const pushPayloadSchema = z
	.string()
	.min(1)
	.max(16 * 1024)
	.refine(
		(value) =>
			new TextEncoder().encode(value).byteLength <= MAX_PUSH_PAYLOAD_BYTES,
		'Push payload exceeds the 4,096-byte Simulator limit.'
	)
	.refine((value) => {
		try {
			const parsed = JSON.parse(value) as unknown;
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
				return false;
			const aps = Object.getOwnPropertyDescriptor(parsed, 'aps');
			return Boolean(
				aps &&
					'value' in aps &&
					aps.value &&
					typeof aps.value === 'object' &&
					!Array.isArray(aps.value)
			);
		} catch {
			return false;
		}
	}, 'Push payload must be a JSON object containing an aps object.');

export const simulatorJobIdSchema = identifierSchema;

const simulatorCapabilitySchema = z.strictObject({
	status: z.enum(['checking', 'available', 'unavailable']),
	platform: z.enum(['darwin', 'win32', 'linux', 'other']),
	xcodeVersion: optionalShortTextSchema,
	xcodeBuild: optionalShortTextSchema,
	selectedDeveloperDirectoryLabel: optionalShortTextSchema,
	licenseStatus: z.enum(['accepted', 'required', 'unknown']),
	hostArchitecture: z.enum(['arm64', 'x64', 'other']),
	runtimeAvailability: z.strictObject({
		total: z.number().int().nonnegative().max(500),
		available: z.number().int().nonnegative().max(500),
	}),
	error: optionalShortTextSchema,
	features: z.strictObject({
		deviceManagement: z.boolean(),
		apps: z.boolean(),
		deepLinks: z.boolean(),
		location: z.boolean(),
		push: z.boolean(),
		privacy: z.boolean(),
		ui: z.boolean(),
		statusBar: z.boolean(),
		keychain: z.boolean(),
		screenshot: z.boolean(),
		video: z.boolean(),
	}),
});
export type SimulatorCapability = z.infer<typeof simulatorCapabilitySchema>;

const simulatorRuntimeSchema = z.strictObject({
	identifier: runtimeIdentifierSchema,
	name: shortTextSchema,
	version: optionalShortTextSchema,
	buildVersion: optionalShortTextSchema,
	isAvailable: z.boolean(),
	availabilityError: optionalShortTextSchema,
});
export type SimulatorRuntime = z.infer<typeof simulatorRuntimeSchema>;

const simulatorDeviceTypeSchema = z.strictObject({
	identifier: deviceTypeIdentifierSchema,
	name: shortTextSchema,
	productFamily: optionalShortTextSchema,
	modelIdentifier: optionalShortTextSchema,
});
export type SimulatorDeviceType = z.infer<typeof simulatorDeviceTypeSchema>;

const simulatorDeviceSchema = z.strictObject({
	udid: udidSchema,
	name: shortTextSchema,
	state: z.enum([
		'booted',
		'shutdown',
		'booting',
		'shuttingDown',
		'creating',
		'unknown',
	]),
	runtimeIdentifier: runtimeIdentifierSchema,
	deviceTypeIdentifier: deviceTypeIdentifierSchema.optional(),
	isAvailable: z.boolean(),
	availabilityError: optionalShortTextSchema,
});
export type SimulatorDevice = z.infer<typeof simulatorDeviceSchema>;

const simulatorAppSchema = z.strictObject({
	bundleIdentifier: bundleIdentifierSchema,
	displayName: shortTextSchema,
	version: optionalShortTextSchema,
	buildVersion: optionalShortTextSchema,
	applicationType: optionalShortTextSchema,
	isSystem: z.boolean(),
});
export type SimulatorApp = z.infer<typeof simulatorAppSchema>;

export const SIMULATOR_CAPTURE_PROTOCOL_SCHEME = 'rndevtools-capture';

export const simulatorCaptureIdSchema = z
	.string()
	.regex(
		/^capture-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
		'Invalid capture identifier.'
	);

const simulatorCaptureSchema = z.strictObject({
	id: simulatorCaptureIdSchema,
	deviceUdid: udidSchema,
	kind: z.enum(['screenshot', 'video']),
	status: z.enum(['complete', 'partial']),
	createdAt: timestampSchema,
	name: shortTextSchema,
	mimeType: z.enum(['image/png', 'image/jpeg', 'video/mp4']),
	bytes: z.number().int().nonnegative(),
});
export type SimulatorCapture = z.infer<typeof simulatorCaptureSchema>;

export const simulatorCaptureRetentionPolicySchema = z.strictObject({
	maxAgeDays: z.number().int().min(1).max(3_650),
	maxTotalBytes: z
		.number()
		.int()
		.min(MIN_CAPTURE_RETENTION_BYTES)
		.max(MAX_CAPTURE_RETENTION_BYTES),
});
export type SimulatorCaptureRetentionPolicy = z.infer<
	typeof simulatorCaptureRetentionPolicySchema
>;

export const simulatorCaptureRetentionStateSchema = z.strictObject({
	policy: simulatorCaptureRetentionPolicySchema,
	captureCount: z.number().int().nonnegative().max(5_000),
	totalBytes: z.number().int().nonnegative().max(MAX_CAPTURE_RETENTION_BYTES),
	lastPrunedAt: timestampSchema.optional(),
});
export type SimulatorCaptureRetentionState = z.infer<
	typeof simulatorCaptureRetentionStateSchema
>;

export const simulatorCaptureAccessResultSchema = z.strictObject({
	captureId: simulatorCaptureIdSchema,
	available: z.boolean(),
	url: z
		.string()
		.regex(
			/^rndevtools-capture:\/\/capture\/capture-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
		)
		.optional(),
});
export type SimulatorCaptureAccessResult = z.infer<
	typeof simulatorCaptureAccessResultSchema
>;

export const simulatorCaptureOperationSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		actionId: identifierSchema,
		kind: z.literal('capture.delete'),
		captureId: simulatorCaptureIdSchema,
	}),
	z.strictObject({
		actionId: identifierSchema,
		kind: z.literal('capture.export'),
		captureId: simulatorCaptureIdSchema,
	}),
	z.strictObject({
		actionId: identifierSchema,
		kind: z.literal('capture.reveal'),
		captureId: simulatorCaptureIdSchema,
	}),
	z.strictObject({
		actionId: identifierSchema,
		kind: z.literal('capture.retention.update'),
		policy: simulatorCaptureRetentionPolicySchema,
	}),
]);
export type SimulatorCaptureOperation = z.infer<
	typeof simulatorCaptureOperationSchema
>;

export const simulatorCaptureOperationReceiptSchema = z.strictObject({
	actionId: identifierSchema,
	kind: z.enum([
		'capture.delete',
		'capture.export',
		'capture.reveal',
		'capture.retention.update',
	]),
	completed: z.boolean(),
	cancelled: z.boolean().optional(),
	captureId: simulatorCaptureIdSchema.optional(),
	retention: simulatorCaptureRetentionStateSchema.optional(),
	error: shortTextSchema.optional(),
});
export type SimulatorCaptureOperationReceipt = z.infer<
	typeof simulatorCaptureOperationReceiptSchema
>;

const simulatorJobSchema = z.strictObject({
	id: simulatorJobIdSchema,
	actionId: identifierSchema,
	kind: shortTextSchema,
	deviceUdid: udidSchema.optional(),
	status: z.enum([
		'queued',
		'preflight',
		'running',
		'verifying',
		'rolling-back',
		'complete',
		'failed',
		'needs-attention',
		'cancelled',
	]),
	progressSequence: z.number().int().nonnegative(),
	phase: shortTextSchema,
	createdAt: timestampSchema,
	startedAt: timestampSchema.optional(),
	finishedAt: timestampSchema.optional(),
	message: shortTextSchema,
	captureId: simulatorCaptureIdSchema.optional(),
});
export type SimulatorJob = z.infer<typeof simulatorJobSchema>;

const simulatorProcessMetricSchema = z.strictObject({
	processId: z.number().int().positive().max(2_147_483_647),
	name: shortTextSchema,
	cpuPercent: z.number().finite().nonnegative().max(10_000),
	memoryBytes: z.number().int().nonnegative(),
	bundleIdentifier: bundleIdentifierSchema.optional(),
});
export type SimulatorProcessMetric = z.infer<
	typeof simulatorProcessMetricSchema
>;

const simulatorDeviceMetricsSchema = z.strictObject({
	deviceUdid: udidSchema,
	sampledAt: timestampSchema,
	cpuPercent: z.number().finite().nonnegative().max(100_000),
	memoryBytes: z.number().int().nonnegative(),
	processCount: z.number().int().nonnegative().max(10_000),
	diskAllocatedBytes: z.number().int().nonnegative().optional(),
	diskSampledAt: timestampSchema.optional(),
	activeApp: z
		.strictObject({
			bundleIdentifier: bundleIdentifierSchema,
			processId: z.number().int().positive().max(2_147_483_647),
		})
		.optional(),
	processes: z.array(simulatorProcessMetricSchema).max(100),
	error: optionalShortTextSchema,
});
export type SimulatorDeviceMetrics = z.infer<
	typeof simulatorDeviceMetricsSchema
>;

const simulatorMetricsSchema = z.strictObject({
	status: z.enum(['checking', 'available', 'unavailable']),
	sampledAt: timestampSchema.optional(),
	host: z
		.strictObject({
			memoryPressure: z.enum(['normal', 'warning', 'critical', 'unknown']),
			totalMemoryBytes: z.number().int().positive(),
			freeMemoryBytes: z.number().int().nonnegative(),
			usedMemoryBytes: z.number().int().nonnegative(),
			freePercent: z.number().finite().min(0).max(100),
		})
		.optional(),
	byDevice: z.record(udidSchema, simulatorDeviceMetricsSchema),
	error: optionalShortTextSchema,
});
export type SimulatorMetrics = z.infer<typeof simulatorMetricsSchema>;

const simulatorDiskCategoryIdSchema = z.enum([
	'caches',
	'logs',
	'temporary',
	'linguistic-data',
	'required-siri-assets',
]);
const simulatorDiskCleanupCategoryIdSchema = z.enum([
	'caches',
	'logs',
	'temporary',
	'linguistic-data',
]);
export type SimulatorDiskCleanupCategoryId = z.infer<
	typeof simulatorDiskCleanupCategoryIdSchema
>;

const simulatorDiskCategorySchema = z.strictObject({
	id: simulatorDiskCategoryIdSchema,
	name: shortTextSchema,
	description: shortTextSchema,
	downside: shortTextSchema,
	recovery: shortTextSchema,
	risk: shortTextSchema,
	defaultSelected: z.boolean(),
	canClean: z.boolean(),
	bytes: z.number().int().nonnegative(),
	targets: z.number().int().nonnegative().max(1_000_000),
});

const simulatorDiskStorageSchema = z.strictObject({
	id: z.enum(['installed-apps', 'documents', 'app-data', 'user-media']),
	name: shortTextSchema,
	description: shortTextSchema,
	bytes: z.number().int().nonnegative(),
});

const simulatorDiskCleanupResultSchema = z.strictObject({
	categoryIds: z.array(simulatorDiskCleanupCategoryIdSchema).min(1).max(4),
	beforeBytes: z.number().int().nonnegative(),
	afterBytes: z.number().int().nonnegative(),
	reclaimedBytes: z.number().int().nonnegative(),
	wasBooted: z.boolean(),
	bootStateRestored: z.boolean(),
	cleanedAt: timestampSchema,
});

const simulatorDiskInventorySchema = z.strictObject({
	simulatorUdid: udidSchema,
	totalBytes: z.number().int().nonnegative(),
	cleanableBytes: z.number().int().nonnegative(),
	categories: z.array(simulatorDiskCategorySchema).max(5),
	storage: z.array(simulatorDiskStorageSchema).max(4),
	inspectedAt: timestampSchema,
	lastCleanup: simulatorDiskCleanupResultSchema.optional(),
});
export type SimulatorDiskInventory = z.infer<
	typeof simulatorDiskInventorySchema
>;

const nativeAvailabilitySchema = z.enum(['available', 'gated', 'unavailable']);
const nativePermissionValueSchema = z.enum([
	'granted',
	'denied',
	'restricted',
	'not_determined',
	'not_granted',
	'unknown',
]);
export const simulatorNativeCapabilitiesSchema = z.strictObject({
	checkedAtMilliseconds: timestampSchema,
	architecture: shortTextSchema,
	operatingSystemVersion: shortTextSchema,
	screenCaptureKit: z.strictObject({
		frameworkAvailable: z.boolean(),
		screenRecordingPermission: nativePermissionValueSchema,
		liveWindowCapture: nativeAvailabilitySchema,
		systemAudioCapture: nativeAvailabilitySchema,
		microphoneCapture: nativeAvailabilitySchema,
		requestableFrameRates: z
			.array(z.number().int().positive().max(240))
			.max(10),
		windowEnumerationPerformed: z.literal(false),
		contentPickerPresented: z.literal(false),
		persistentSessionOperationsExposed: z.literal(false),
	}),
	avFoundation: z.strictObject({
		frameworkAvailable: z.boolean(),
		cameraPermission: nativePermissionValueSchema,
		microphonePermission: nativePermissionValueSchema,
		cameraDeviceAvailable: z.boolean(),
		microphoneDeviceAvailable: z.boolean(),
		cameraCapture: nativeAvailabilitySchema,
		microphoneCapture: nativeAvailabilitySchema,
		permissionRequestsPerformed: z.literal(false),
	}),
	videoToolbox: z.strictObject({
		frameworkAvailable: z.boolean(),
		referenceWidth: z.number().int().positive().max(16_384),
		referenceHeight: z.number().int().positive().max(16_384),
		probeKind: shortTextSchema,
		codecs: z
			.array(
				z.strictObject({
					id: z.enum(['h264', 'hevc']),
					hardwareEncodeSupported: z.boolean(),
					hardwareDecodeSupported: z.boolean(),
					sessionCreationStatus: z
						.number()
						.int()
						.min(-2_147_483_648)
						.max(2_147_483_647),
					acceptedRealtimeConfigurationFrameRates: z
						.array(z.number().int().positive().max(240))
						.max(10),
				})
			)
			.max(4),
		framesEncoded: z.literal(0),
	}),
	accessibility: z.strictObject({
		frameworkAvailable: z.boolean(),
		permission: nativePermissionValueSchema,
		elementInspection: nativeAvailabilitySchema,
		permissionPromptPerformed: z.literal(false),
	}),
	buildInsights: z.strictObject({
		fseventsFrameworkAvailable: z.boolean(),
		currentEventID: shortTextSchema,
		pathScopedObservation: nativeAvailabilitySchema,
		protectedPathObservation: nativeAvailabilitySchema,
		requiresExplicitSourceRoots: z.boolean(),
		fullDiskAccessPreflightAvailable: z.boolean(),
		sourceRootsInspected: z.literal(false),
		xcodeProcessesLaunched: z.literal(false),
	}),
	networkExtension: z.strictObject({
		frameworkAvailable: z.boolean(),
		vpnManagerAPIAvailable: z.boolean(),
		packetTunnelProviderAPIAvailable: z.boolean(),
		appProxyProviderAPIAvailable: z.boolean(),
		contentFilterAPIAvailable: z.boolean(),
		entitlementPresent: z.boolean(),
		configurationInspection: nativeAvailabilitySchema,
		trafficInterception: nativeAvailabilitySchema,
		preferenceReadsPerformed: z.literal(false),
	}),
	safety: z.strictObject({
		permissionPrompts: z.literal(false),
		externalStateMutations: z.literal(false),
		contentEnumerated: z.literal(false),
		persistentSessions: z.literal(false),
		networkPreferencesRead: z.literal(false),
	}),
});
const simulatorNativeStateSchema = z.strictObject({
	status: z.enum(['checking', 'available', 'unavailable', 'untrusted']),
	helperVersion: optionalShortTextSchema,
	permissionInspection: z.boolean(),
	permissionPrompting: z.boolean(),
	capabilityInspection: z.boolean().optional(),
	liveCaptureSessions: z.boolean().optional(),
	imageComposition: z.boolean().optional(),
	permissions: z
		.array(
			z.strictObject({
				id: z.enum([
					'accessibility',
					'screen_recording',
					'camera',
					'microphone',
				]),
				value: z.enum([
					'granted',
					'denied',
					'restricted',
					'not_determined',
					'not_granted',
					'unknown',
				]),
				canPrompt: z.literal(false),
			})
		)
		.max(4),
	advanced: simulatorNativeCapabilitiesSchema.optional(),
	checkedAt: timestampSchema.optional(),
	error: optionalShortTextSchema,
});
export type SimulatorNativeState = z.infer<typeof simulatorNativeStateSchema>;

export const simulatorStateSchema = z.strictObject({
	revision: z.number().int().nonnegative(),
	updatedAt: timestampSchema,
	capability: simulatorCapabilitySchema,
	runtimes: z.array(simulatorRuntimeSchema).max(500),
	deviceTypes: z.array(simulatorDeviceTypeSchema).max(500),
	devices: z.array(simulatorDeviceSchema).max(2_000),
	appsByDevice: z.record(udidSchema, z.array(simulatorAppSchema).max(5_000)),
	diskByDevice: z.record(udidSchema, simulatorDiskInventorySchema).default({}),
	jobs: z.array(simulatorJobSchema).max(200),
	captures: z.array(simulatorCaptureSchema).max(5_000),
	metrics: simulatorMetricsSchema,
	native: simulatorNativeStateSchema,
});
export type SimulatorState = z.infer<typeof simulatorStateSchema>;

const actionBase = {
	actionId: identifierSchema,
	confirmationToken: z
		.string()
		.regex(/^confirmation-[a-f0-9]{64}$/)
		.optional(),
};
const deviceActionBase = {
	...actionBase,
	udid: udidSchema,
};

const coordinateSchema = z.strictObject({
	latitude: z.number().finite().min(-90).max(90),
	longitude: z.number().finite().min(-180).max(180),
});

const locationStartActionSchema = z
	.strictObject({
		...deviceActionBase,
		kind: z.literal('location.start'),
		waypoints: z.array(coordinateSchema).min(2).max(500),
		speedMetersPerSecond: z.number().finite().positive().max(1_000).optional(),
		distanceMeters: z.number().finite().positive().max(1_000_000).optional(),
		intervalSeconds: z.number().finite().positive().max(3_600).optional(),
	})
	.refine(
		(action) =>
			action.distanceMeters === undefined ||
			action.intervalSeconds === undefined,
		{ message: 'Location distance and interval are mutually exclusive.' }
	);

const privacyActionSchema = z.strictObject({
	...deviceActionBase,
	kind: z.literal('privacy.update'),
	operation: z.enum(['grant', 'revoke', 'reset']),
	service: z.enum([
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
	]),
	bundleIdentifier: bundleIdentifierSchema,
});

const uiActionSchema = z
	.strictObject({
		...deviceActionBase,
		kind: z.literal('ui.update'),
		setting: z.enum(['appearance', 'increase_contrast', 'content_size']),
		value: z.enum([
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
		]),
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
	);

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
		{
			message: 'At least one status-bar override is required.',
		}
	);

const captureNameSchema = z.string().trim().min(1).max(128).optional();
const captureColorSchema = z.string().regex(/^#[0-9A-F]{6}(?:[0-9A-F]{2})?$/i);
const isBoundedCaptureMetadata = (value: string): boolean =>
	new TextEncoder().encode(value).byteLength <= 512 &&
	value.split('\n').length <= 8 &&
	value
		.split('\n')
		.every((line) => new TextEncoder().encode(line).byteLength <= 96) &&
	[...value].every((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return character === '\n' || (codePoint >= 0x20 && codePoint <= 0x7e);
	});
const captureColorIsOpaque = (color: string): boolean =>
	color.length === 7 || color.slice(-2).toLowerCase() === 'ff';
const captureCompositionComparisonSchema = z.discriminatedUnion('mode', [
	z.strictObject({
		mode: z.literal('side_by_side'),
		gap: z.number().int().min(0).max(512),
	}),
	z.strictObject({
		mode: z.literal('opacity'),
		secondaryOpacityBasisPoints: z.number().int().min(0).max(10_000),
	}),
	z.strictObject({ mode: z.literal('difference') }),
]);

export const captureCompositionRecipeSchema = z
	.strictObject({
		outputFormat: z.enum(['png', 'jpeg']),
		jpegQuality: z.number().int().min(1).max(100).optional(),
		canvas: z.strictObject({
			size: z.union([
				z.strictObject({
					mode: z.literal('pixels'),
					width: z.number().int().positive().max(8_192),
					height: z.number().int().positive().max(8_192),
				}),
				z.strictObject({
					mode: z.literal('aspect'),
					ratioWidth: z.number().int().positive().max(1_000),
					ratioHeight: z.number().int().positive().max(1_000),
					longEdge: z.number().int().min(64).max(8_192),
				}),
			]),
			background: z.discriminatedUnion('kind', [
				z.strictObject({ kind: z.literal('transparent') }),
				z.strictObject({ kind: z.literal('solid'), color: captureColorSchema }),
				z.strictObject({
					kind: z.literal('linear_gradient'),
					startColor: captureColorSchema,
					endColor: captureColorSchema,
					direction: z.enum([
						'top_to_bottom',
						'left_to_right',
						'top_left_to_bottom_right',
					]),
				}),
			]),
		}),
		layout: z.strictObject({
			padding: z.strictObject({
				top: z.number().int().min(0).max(2_048),
				right: z.number().int().min(0).max(2_048),
				bottom: z.number().int().min(0).max(2_048),
				left: z.number().int().min(0).max(2_048),
			}),
			contentMode: z.enum(['fit', 'fill']),
			rotation: z.union([
				z.literal(0),
				z.literal(90),
				z.literal(180),
				z.literal(270),
			]),
			cornerRadius: z.number().int().min(0).max(1_024),
			bezel: z.enum(['none', 'rndevtools-generic-v1']),
			shadow: z
				.strictObject({
					color: captureColorSchema,
					blurRadius: z.number().int().min(0).max(256),
					offsetX: z.number().int().min(-512).max(512),
					offsetY: z.number().int().min(-512).max(512),
				})
				.optional(),
		}),
		metadata: z
			.strictObject({
				text: z
					.string()
					.min(1)
					.max(512)
					.refine(
						isBoundedCaptureMetadata,
						'Metadata must be bounded printable text.'
					),
				placement: z.enum(['top', 'bottom']),
				textColor: captureColorSchema,
				backgroundColor: captureColorSchema,
				fontSize: z.number().int().min(8).max(96),
				padding: z.number().int().min(0).max(64),
			})
			.optional(),
		comparison: captureCompositionComparisonSchema.optional(),
	})
	.superRefine((recipe, context) => {
		if (recipe.outputFormat === 'png' && recipe.jpegQuality !== undefined) {
			context.addIssue({
				code: 'custom',
				message: 'JPEG quality is valid only for JPEG output.',
				path: ['jpegQuality'],
			});
		}
		const background = recipe.canvas.background;
		const jpegBackgroundIsOpaque =
			background.kind === 'solid'
				? captureColorIsOpaque(background.color)
				: background.kind === 'linear_gradient'
					? captureColorIsOpaque(background.startColor) &&
						captureColorIsOpaque(background.endColor)
					: false;
		if (recipe.outputFormat === 'jpeg' && !jpegBackgroundIsOpaque) {
			context.addIssue({
				code: 'custom',
				message: 'JPEG output requires an opaque background.',
				path: ['canvas', 'background'],
			});
		}
		const canvasSize =
			recipe.canvas.size.mode === 'pixels'
				? recipe.canvas.size
				: recipe.canvas.size.ratioWidth >= recipe.canvas.size.ratioHeight
					? {
							width: recipe.canvas.size.longEdge,
							height: Math.max(
								1,
								Math.round(
									(recipe.canvas.size.longEdge *
										recipe.canvas.size.ratioHeight) /
										recipe.canvas.size.ratioWidth
								)
							),
						}
					: {
							width: Math.max(
								1,
								Math.round(
									(recipe.canvas.size.longEdge *
										recipe.canvas.size.ratioWidth) /
										recipe.canvas.size.ratioHeight
								)
							),
							height: recipe.canvas.size.longEdge,
						};
		if (canvasSize.width * canvasSize.height > 40_000_000) {
			context.addIssue({
				code: 'custom',
				message: 'Composition canvases cannot exceed 40 megapixels.',
				path: ['canvas', 'size'],
			});
		}
		const contentWidth =
			canvasSize.width -
			recipe.layout.padding.left -
			recipe.layout.padding.right;
		const contentHeight =
			canvasSize.height -
			recipe.layout.padding.top -
			recipe.layout.padding.bottom;
		let frameWidth = contentWidth;
		if (recipe.comparison?.mode === 'side_by_side') {
			frameWidth = Math.floor((contentWidth - recipe.comparison.gap) / 2);
		}
		if (frameWidth <= 0 || contentHeight <= 0) {
			context.addIssue({
				code: 'custom',
				message:
					'Composition padding or comparison gap leaves no drawable area.',
				path: ['layout', 'padding'],
			});
		} else {
			if (
				recipe.layout.cornerRadius >
				Math.floor(Math.min(frameWidth, contentHeight) / 2)
			) {
				context.addIssue({
					code: 'custom',
					message: 'Corner radius exceeds the available image frame.',
					path: ['layout', 'cornerRadius'],
				});
			}
			if (
				recipe.layout.bezel === 'rndevtools-generic-v1' &&
				Math.min(frameWidth, contentHeight) < 64
			) {
				context.addIssue({
					code: 'custom',
					message: 'The device frame requires at least 64 pixels per side.',
					path: ['layout', 'bezel'],
				});
			}
		}
	});
export type CaptureCompositionRecipe = z.infer<
	typeof captureCompositionRecipeSchema
>;

export const simulatorActionSchema = z.union([
	z.strictObject({ ...deviceActionBase, kind: z.literal('device.boot') }),
	z.strictObject({ ...deviceActionBase, kind: z.literal('device.shutdown') }),
	z.strictObject({ ...deviceActionBase, kind: z.literal('device.erase') }),
	z.strictObject({ ...deviceActionBase, kind: z.literal('device.delete') }),
	z.strictObject({
		...actionBase,
		kind: z.literal('device.create'),
		name: nameSchema,
		bootAfterCreate: z.boolean().optional(),
		deviceTypeIdentifier: deviceTypeIdentifierSchema,
		runtimeIdentifier: runtimeIdentifierSchema.optional(),
	}),
	z.strictObject({
		...deviceActionBase,
		kind: z.literal('device.clone'),
		name: nameSchema,
	}),
	z.strictObject({
		...deviceActionBase,
		kind: z.literal('device.rename'),
		name: nameSchema,
	}),
	z.strictObject({ ...deviceActionBase, kind: z.literal('disk.inspect') }),
	z
		.strictObject({
			...deviceActionBase,
			kind: z.literal('disk.cleanup'),
			categoryIds: z.array(simulatorDiskCleanupCategoryIdSchema).min(1).max(4),
		})
		.refine(
			(action) =>
				new Set(action.categoryIds).size === action.categoryIds.length,
			{
				message: 'Disk cleanup categories must be unique.',
			}
		),
	z.strictObject({ ...deviceActionBase, kind: z.literal('app.list') }),
	z.strictObject({ ...deviceActionBase, kind: z.literal('app.install') }),
	z.strictObject({
		...deviceActionBase,
		kind: z.literal('app.uninstall'),
		bundleIdentifier: bundleIdentifierSchema,
	}),
	z.strictObject({
		...deviceActionBase,
		kind: z.literal('app.launch'),
		bundleIdentifier: bundleIdentifierSchema,
		terminateRunning: z.boolean().default(false),
		arguments: z.array(z.string().max(MAX_SHORT_TEXT)).max(50).default([]),
		locale: appLocaleSchema.optional(),
		languages: z.array(appLanguageSchema).min(1).max(10).optional(),
		timeZone: timeZoneSchema.optional(),
		slowAnimations: z.boolean().optional(),
	}),
	z.strictObject({
		...deviceActionBase,
		kind: z.literal('app.terminate'),
		bundleIdentifier: bundleIdentifierSchema,
	}),
	z.strictObject({
		...deviceActionBase,
		kind: z.literal('app.openUniversalLink'),
		url: simulatorUniversalLinkSchema,
	}),
	z
		.strictObject({
			...deviceActionBase,
			kind: z.literal('app.revealContainer'),
			bundleIdentifier: bundleIdentifierSchema,
			container: z.enum(['app', 'data', 'groups', 'app-group']),
			appGroupIdentifier: bundleIdentifierSchema.optional(),
		})
		.refine(
			(action) =>
				(action.container === 'app-group' &&
					action.appGroupIdentifier !== undefined) ||
				(action.container !== 'app-group' &&
					action.appGroupIdentifier === undefined),
			{ message: 'Only an app-group container requires appGroupIdentifier.' }
		),
	z.strictObject({
		...deviceActionBase,
		kind: z.literal('pasteboard.sync'),
		direction: z.enum(['host-to-simulator', 'simulator-to-host']),
	}),
	z.strictObject({
		...deviceActionBase,
		kind: z.literal('url.open'),
		url: simulatorUrlSchema,
	}),
	z.strictObject({
		...deviceActionBase,
		kind: z.literal('location.set'),
		...coordinateSchema.shape,
	}),
	z.strictObject({ ...deviceActionBase, kind: z.literal('location.clear') }),
	locationStartActionSchema,
	z.strictObject({
		...deviceActionBase,
		kind: z.literal('location.importGpx'),
		speedMetersPerSecond: z.number().finite().positive().max(1_000).optional(),
	}),
	z.strictObject({
		...deviceActionBase,
		kind: z.literal('location.run'),
		scenario: nameSchema,
	}),
	z.strictObject({
		...deviceActionBase,
		kind: z.literal('push.send'),
		bundleIdentifier: bundleIdentifierSchema,
		payloadJson: pushPayloadSchema,
	}),
	privacyActionSchema,
	uiActionSchema,
	z.strictObject({ ...deviceActionBase, kind: z.literal('statusBar.clear') }),
	z.strictObject({
		...deviceActionBase,
		kind: z.literal('statusBar.override'),
		overrides: statusBarOverridesSchema,
	}),
	z.strictObject({ ...deviceActionBase, kind: z.literal('keychain.reset') }),
	z.strictObject({
		...deviceActionBase,
		kind: z.literal('keychain.addCertificate'),
		trustRoot: z.boolean().default(false),
	}),
	z.strictObject({
		...deviceActionBase,
		kind: z.literal('capture.screenshot'),
		name: captureNameSchema,
		format: z.enum(['png', 'jpeg']).default('png'),
		mask: z.enum(['ignored', 'alpha', 'black']).default('alpha'),
	}),
	z
		.strictObject({
			...deviceActionBase,
			kind: z.literal('capture.compose'),
			primaryCaptureId: simulatorCaptureIdSchema,
			secondaryCaptureId: simulatorCaptureIdSchema.optional(),
			recipe: captureCompositionRecipeSchema,
			name: captureNameSchema,
		})
		.refine(
			(action) =>
				Boolean(action.recipe.comparison) ===
					Boolean(action.secondaryCaptureId) &&
				action.primaryCaptureId !== action.secondaryCaptureId,
			{
				message:
					'A distinct secondary capture is required exactly when comparison is enabled.',
			}
		),
	z.strictObject({
		...deviceActionBase,
		kind: z.literal('capture.video'),
		name: captureNameSchema,
		codec: z.enum(['h264', 'hevc']).default('h264'),
		mask: z.enum(['ignored', 'black']).default('black'),
	}),
]);
export type SimulatorAction = z.infer<typeof simulatorActionSchema>;

export const simulatorActionReceiptSchema = z.strictObject({
	actionId: identifierSchema,
	accepted: z.boolean(),
	jobId: simulatorJobIdSchema.optional(),
	error: z.string().max(MAX_LONG_TEXT).optional(),
});
export type SimulatorActionReceipt = z.infer<
	typeof simulatorActionReceiptSchema
>;

export const simulatorConfirmationResultSchema = z.strictObject({
	actionId: identifierSchema,
	required: z.boolean(),
	confirmed: z.boolean(),
	token: z
		.string()
		.regex(/^confirmation-[a-f0-9]{64}$/)
		.optional(),
	expiresAt: timestampSchema.optional(),
	error: shortTextSchema.optional(),
});
export type SimulatorConfirmationResult = z.infer<
	typeof simulatorConfirmationResultSchema
>;

export const simulatorOnboardingOperationSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		actionId: identifierSchema,
		kind: z.literal('toolchain.selectXcode'),
	}),
	z.strictObject({
		actionId: identifierSchema,
		kind: z.literal('privacy.openSettings'),
		permission: z.enum([
			'screen_recording',
			'accessibility',
			'camera',
			'microphone',
		]),
	}),
	z.strictObject({
		actionId: identifierSchema,
		kind: z.literal('agentCli.reveal'),
	}),
	z.strictObject({
		actionId: identifierSchema,
		/**
		 * Run the verified CLI's `setup`: register the MCP server, install the
		 * lanes skill, and add the simctl guard for the coding agents on this Mac.
		 */
		kind: z.literal('agentCli.setup'),
	}),
]);
export type SimulatorOnboardingOperation = z.infer<
	typeof simulatorOnboardingOperationSchema
>;

export const simulatorOnboardingReceiptSchema = z.strictObject({
	actionId: identifierSchema,
	kind: z.enum([
		'toolchain.selectXcode',
		'privacy.openSettings',
		'agentCli.reveal',
		'agentCli.setup',
	]),
	completed: z.boolean(),
	cancelled: z.boolean().optional(),
	requiresRefresh: z.boolean().optional(),
	error: shortTextSchema.optional(),
	/** Human-readable outcome lines, e.g. one per file `agentCli.setup` touched. */
	summary: z.array(shortTextSchema).max(32).optional(),
});
export type SimulatorOnboardingReceipt = z.infer<
	typeof simulatorOnboardingReceiptSchema
>;

export type SimulatorBridge = {
	getSimulatorState: () => Promise<SimulatorState>;
	subscribeSimulatorState: (
		listener: (state: SimulatorState) => void
	) => () => void;
	refreshSimulators: () => Promise<SimulatorState>;
	requestSimulatorConfirmation: (
		action: SimulatorAction
	) => Promise<SimulatorConfirmationResult>;
	runSimulatorAction: (
		action: SimulatorAction
	) => Promise<SimulatorActionReceipt>;
	cancelSimulatorJob: (jobId: string) => Promise<boolean>;
	getSimulatorCaptureAccess: (
		captureId: string
	) => Promise<SimulatorCaptureAccessResult>;
	getSimulatorCaptureRetention: () => Promise<SimulatorCaptureRetentionState>;
	runSimulatorCaptureOperation: (
		operation: SimulatorCaptureOperation
	) => Promise<SimulatorCaptureOperationReceipt>;
	runSimulatorOnboardingOperation: (
		operation: SimulatorOnboardingOperation
	) => Promise<SimulatorOnboardingReceipt>;
};

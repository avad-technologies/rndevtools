import { utf8ByteLength } from './core/serialize';
import {
	isNetworkSimulationProfileId,
	type NetworkSimulationProfileId,
} from './network-profile';

export const RNDEVTOOLS_PROTOCOL_VERSION = 2 as const;
export const RNDEVTOOLS_SUPPORTED_PROTOCOL_VERSIONS = [1, 2] as const;

export type DesktopProtocolVersion =
	(typeof RNDEVTOOLS_SUPPORTED_PROTOCOL_VERSIONS)[number];

export const RNDEVTOOLS_TOOL_IDS = [
	'network',
	'console',
	'storage',
	'query',
	'routes',
	'environment',
	'zustand',
	'restore',
	'scenarios',
	'identity',
	'performance',
	'components',
	'camera',
	'diagnostics',
] as const;

export type DesktopToolId = (typeof RNDEVTOOLS_TOOL_IDS)[number];

/** Shared collection limits keep mobile projections within the desktop schema. */
export const RNDEVTOOLS_SNAPSHOT_LIMITS = {
	network: 2_000,
	console: 5_000,
	storage: 5_000,
	storageEvents: 2_000,
	storageKeys: 500,
	queries: 2_000,
	mutations: 2_000,
	routes: 5_000,
	routeEvents: 2_000,
	environment: 2_000,
	zustandStores: 500,
	zustandChanges: 2_000,
	zustandChangedKeys: 500,
	zustandStateSnapshots: 100,
	zustandMutationReceipts: 1_000,
	restorePoints: 100,
	restoreSources: 50,
	restoreReceipts: 100,
	scenarios: 100,
	scenarioVariables: 25,
	scenarioSteps: 100,
	scenarioReceipts: 100,
	identityHistory: 20,
	identityPersonas: 50,
	components: 2_000,
	componentRenders: 2_000,
	componentSourceFiles: 20,
	componentDiagnostics: 500,
	performanceSamples: 1_500,
	diagnostics: 2_000,
} as const;

export type DesktopSnapshotLimit = keyof typeof RNDEVTOOLS_SNAPSHOT_LIMITS;

/**
 * Every remotely invokable operation has one capability with the same
 * `tool.command` spelling. Read-only tools intentionally have no capability.
 */
export const RNDEVTOOLS_ACTION_CAPABILITIES = [
	'network.clear',
	'network.setProfile',
	'network.clearProfile',
	'console.clear',
	'storage.write',
	'storage.undo',
	'storage.bookmark',
	'query.refetch',
	'query.invalidate',
	'query.simulate',
	'query.clearSimulation',
	'routes.navigate',
	'zustand.refresh',
	'zustand.capture',
	'zustand.patch',
	'zustand.jump',
	'restore.capture',
	'restore.restore',
	'restore.resetBaseline',
	'restore.rename',
	'restore.duplicate',
	'restore.remove',
	'scenarios.execute',
	'scenarios.undo',
	'scenarios.discardRecovery',
	'scenarios.import',
	'scenarios.remove',
	'identity.start',
	'identity.stop',
	'performance.review',
	'components.refresh',
	'components.highlight',
	'components.activate',
	'components.focus',
	'components.setText',
	'components.scroll',
	'components.waitForElement',
	'components.waitForScreenChange',
	'camera.setFixture',
	'camera.clearFixture',
] as const;

export type DesktopActionCapability =
	(typeof RNDEVTOOLS_ACTION_CAPABILITIES)[number];

export type DesktopDeviceAction = {
	actionId: string;
	deviceId: string;
	tool: DesktopToolId;
	command: string;
	payload: Record<string, unknown>;
};

export type DesktopDeviceInfoSnapshot = {
	id: string;
	name: string;
	platform: 'ios' | 'android' | 'web' | 'simulator' | 'unknown';
	model?: string | undefined;
	osVersion?: string | undefined;
	appVersion?: string | undefined;
	buildVersion?: string | undefined;
	runtimeVersion?: string | undefined;
	variant?: string | undefined;
	simulatorUdid?: string | undefined;
	bundleIdentifier?: string | undefined;
	processId?: number | undefined;
	viewport?: { width: number; height: number } | undefined;
	capabilities: readonly DesktopActionCapability[];
};

/**
 * Supplies every required collection. Override the tools the host collects:
 * `{ ...createEmptyDesktopToolsSnapshot(), network: myNetworkProjection }`.
 */
export function createEmptyDesktopToolsSnapshot(): DesktopDeviceToolsSnapshot {
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
		},
		diagnostics: [],
	};
}

export type DesktopCameraFixtureKind =
	| 'still'
	| 'qr'
	| 'video'
	| 'unavailable'
	| 'error';

export type DesktopCameraFixtureSnapshot = {
	active: boolean;
	kind?: DesktopCameraFixtureKind | undefined;
	label?: string | undefined;
	mimeType?: string | undefined;
	bytes?: number | undefined;
	width?: number | undefined;
	height?: number | undefined;
	durationMs?: number | undefined;
};

type DesktopIdentitySnapshot = {
	kind: 'signed-out' | 'account' | 'persona';
	label: string;
	personaId?: string | undefined;
};

type DesktopNetworkSnapshot = {
	id: string;
	at: number;
	method: string;
	url: string;
	host: string;
	path: string;
	status?: number | undefined;
	state: 'pending' | 'success' | 'error' | 'aborted';
	durationMs?: number | undefined;
	requestBytes?: number | undefined;
	responseBytes?: number | undefined;
	requestHeaders?: Readonly<Record<string, string>> | undefined;
	responseHeaders?: Readonly<Record<string, string>> | undefined;
	requestBody?: string | undefined;
	responseBody?: string | undefined;
	contentType?: string | undefined;
	source?: string | undefined;
	error?: string | undefined;
};

type DesktopConsoleSnapshot = {
	id: string;
	at: number;
	firstAt?: number | undefined;
	lastAt?: number | undefined;
	level: 'debug' | 'info' | 'warn' | 'error';
	message: string;
	attributesText?: string | undefined;
	source?: string | undefined;
	scope?: string | undefined;
	correlationId?: string | undefined;
	groupId?: string | undefined;
	repeatCount?: number | undefined;
	errorName?: string | undefined;
	errorStack?: string | undefined;
	sourceLocation?:
		| {
				file: string;
				line?: number | undefined;
				column?: number | undefined;
		  }
		| undefined;
};

type DesktopStorageSnapshot = {
	id: string;
	adapterId: string;
	adapterTitle: string;
	key: string;
	valueText?: string | undefined;
	valueType: 'string' | 'number' | 'boolean' | 'json' | 'binary' | 'hidden';
	bytes: number;
	sensitive: boolean;
	editable: boolean;
	updatedAt?: number | undefined;
};

type DesktopStorageEventSnapshot = {
	id: string;
	at: number;
	adapterId: string;
	key: string;
	kind: 'added' | 'updated' | 'removed';
	previousText?: string | undefined;
	nextText?: string | undefined;
	bookmarked?: boolean | undefined;
	undoAvailable?: boolean | undefined;
	undoStatus?: 'available' | 'expired' | 'succeeded' | 'failed' | undefined;
	structuralDiff?:
		| readonly {
				path: string;
				kind: 'added' | 'changed' | 'removed';
				previousText?: string | undefined;
				nextText?: string | undefined;
		  }[]
		| undefined;
};

type DesktopQuerySnapshot = {
	id: string;
	hash: string;
	keyText: string;
	status: 'pending' | 'success' | 'error';
	fetchStatus: 'idle' | 'fetching' | 'paused';
	updatedAt: number;
	observers: number;
	isStale: boolean;
	dataText?: string | undefined;
	errorText?: string | undefined;
	truncated: boolean;
};

type DesktopMutationSnapshot = {
	id: string;
	keyText: string;
	status: 'idle' | 'pending' | 'success' | 'error';
	submittedAt?: number | undefined;
	variablesText?: string | undefined;
	errorText?: string | undefined;
	truncated: boolean;
};

type DesktopQuerySimulationSnapshot = {
	families: readonly {
		id: string;
		label: string;
		description?: string | undefined;
		modes: readonly {
			mode: 'loading' | 'error' | 'paused' | 'offline';
			supported: boolean;
			reason?: string | undefined;
		}[];
	}[];
	active?:
		| {
				familyId: string;
				familyLabel: string;
				mode: 'loading' | 'error' | 'paused' | 'offline';
				receiptId: string;
				startedAt: number;
		  }
		| undefined;
};

type DesktopRouteSnapshot = {
	id: string;
	path: string;
	name: string;
	kind: 'static' | 'dynamic' | 'catchAll' | 'layout' | 'group' | 'internal';
	filename?: string | undefined;
	isCurrent: boolean;
	isVisible: boolean;
	depth: number;
};

type DesktopEnvironmentSnapshot = {
	id: string;
	section: string;
	key: string;
	valueText: string;
	status: 'valid' | 'missing' | 'typeMismatch' | 'valueMismatch' | 'unchecked';
	description?: string | undefined;
};

type DesktopPerformanceSampleSnapshot = {
	id: string;
	at: number;
	jsFps: number;
	uiFps?: number | undefined;
	cpuPercent?: number | undefined;
	memoryMb?: number | undefined;
	eventLoopLagMs: number;
	longFrames: number;
	maxFrameMs: number;
	route?: string | undefined;
};

type DesktopDiagnosticSnapshot = {
	id: string;
	at: number;
	level: 'debug' | 'info' | 'warn' | 'error';
	scope: string;
	message: string;
};

/**
 * Versioned mobile-to-desktop snapshot DTO. Both the mobile projector and the
 * desktop Zod boundary compile against this contract so protocol drift fails
 * type checking before a device can connect.
 */
export type DesktopDeviceToolsSnapshot = {
	network: readonly DesktopNetworkSnapshot[];
	networkProfile?:
		| {
				id: NetworkSimulationProfileId;
				name: string;
				active: boolean;
				scope: 'instrumented-fetch';
		  }
		| undefined;
	console: readonly DesktopConsoleSnapshot[];
	storage: readonly DesktopStorageSnapshot[];
	storageEvents: readonly DesktopStorageEventSnapshot[];
	storageSummary: {
		adapterCount: number;
		totalKeyCount: number;
		omittedKeyCount: number;
		truncated: boolean;
		errors: readonly {
			adapterId: string;
			adapterTitle: string;
			message: string;
		}[];
	};
	queries: readonly DesktopQuerySnapshot[];
	mutations: readonly DesktopMutationSnapshot[];
	querySummary: {
		sourceQueryCount: number;
		omittedQueryCount: number;
		sourceMutationCount: number;
		omittedMutationCount: number;
		truncated: boolean;
	};
	querySimulation?: DesktopQuerySimulationSnapshot | undefined;
	routes: readonly DesktopRouteSnapshot[];
	routeEvents: readonly {
		id: string;
		at: number;
		route: string;
		metadataText?: string | undefined;
		transitionId?: string | undefined;
		phase?: 'requested' | 'committed' | 'focused' | 'failed' | undefined;
		source?:
			| 'app'
			| 'panel'
			| 'desktop'
			| 'scenario'
			| 'restore'
			| 'deep-link'
			| undefined;
		correlationId?: string | undefined;
		durationMs?: number | undefined;
		error?: string | undefined;
	}[];
	environment: readonly DesktopEnvironmentSnapshot[];
	zustandStores: readonly {
		id: string;
		title: string;
		description?: string | undefined;
		stateText: string;
		keys: readonly string[];
		updatedAt: number;
		capabilities: {
			writable: boolean;
			resettable: boolean;
			persisted: boolean;
			restorable: boolean;
		};
		error?: string | undefined;
	}[];
	zustandChanges: readonly {
		id: string;
		at: number;
		storeId: string;
		storeTitle: string;
		changedKeys: readonly string[];
		stateText: string;
		error?: string | undefined;
	}[];
	zustandStateSnapshots: readonly {
		id: string;
		storeId: string;
		storeTitle: string;
		createdAt: number;
		stateText: string;
		stateBytes: number;
		truncated: boolean;
	}[];
	zustandMutationReceipts: readonly {
		id: string;
		storeId: string;
		kind: 'patch' | 'reset' | 'jump';
		status: 'succeeded' | 'failed' | 'rolled-back' | 'needs-attention';
		startedAt: number;
		completedAt: number;
		changedKeys: readonly string[];
		correlationId?: string | undefined;
		snapshotId?: string | undefined;
		error?: string | undefined;
	}[];
	zustandSummary: {
		totalStoreCount: number;
		omittedStoreCount: number;
		truncated: boolean;
		error?: string | undefined;
	};
	restorePoints: readonly {
		id: string;
		label: string;
		createdAt: number;
		estimatedBytes: number;
		sources: readonly {
			id: string;
			title: string;
			preview: string;
			bytes: number;
		}[];
	}[];
	restoreReceipts: readonly {
		id: string;
		pointId: string;
		pointLabel: string;
		startedAt: number;
		completedAt: number;
		status: 'complete' | 'preflight-failed' | 'rolled-back' | 'needs-attention';
		error?: string | undefined;
		sourceResults: readonly {
			sourceId: string;
			sourceTitle: string;
			preflight: 'pending' | 'passed' | 'failed';
			apply: 'not-run' | 'succeeded' | 'failed';
			rollback: 'not-needed' | 'succeeded' | 'failed';
			error?: string | undefined;
			rollbackError?: string | undefined;
		}[];
	}[];
	scenarios: readonly {
		id: string;
		version: number;
		definitionToken: string;
		name: string;
		description?: string | undefined;
		bundled: boolean;
		variables: readonly {
			id: string;
			label: string;
			type: 'string' | 'number' | 'boolean';
			required: boolean;
			defaultValue?: string | number | boolean | null | undefined;
			options?: readonly (string | number | boolean | null)[] | undefined;
		}[];
		preconditionCount: number;
		steps: readonly {
			id: string;
			type:
				| 'network-profile'
				| 'storage-write'
				| 'zustand-write'
				| 'query-simulation'
				| 'developer-overrides'
				| 'impersonation'
				| 'navigation'
				| 'custom-action';
			label?: string | undefined;
		}[];
	}[];
	scenarioRuntime: {
		running: boolean;
		recoveryError?: string | undefined;
		active?:
			| {
					receiptId: string;
					scenarioId: string;
					scenarioVersion: number;
					scenarioName: string;
					activatedAt: number;
					stepCount: number;
					privileged: boolean;
					warnings: readonly string[];
					recoveryRequired: boolean;
			  }
			| undefined;
	};
	scenarioReceipts: readonly {
		id: string;
		scenarioId: string;
		scenarioVersion: number;
		scenarioName: string;
		startedAt: number;
		completedAt: number;
		status: 'complete' | 'preflight-failed' | 'rolled-back' | 'needs-attention';
		error?: string | undefined;
		stepResults: readonly {
			stepId: string;
			stepType:
				| 'network-profile'
				| 'storage-write'
				| 'zustand-write'
				| 'query-simulation'
				| 'developer-overrides'
				| 'impersonation'
				| 'navigation'
				| 'custom-action';
			label: string;
			preflight: 'pending' | 'passed' | 'failed';
			apply: 'not-run' | 'succeeded' | 'failed';
			rollback: 'not-needed' | 'succeeded' | 'failed';
			reversible?: boolean | undefined;
			privileged?: boolean | undefined;
			warnings?: readonly string[] | undefined;
			summary?: string | undefined;
			error?: string | undefined;
			rollbackError?: string | undefined;
		}[];
	}[];
	identitySession: {
		running: boolean;
		active?:
			| {
					historyId: string;
					startedAt: number;
					actor: DesktopIdentitySnapshot;
					target: DesktopIdentitySnapshot;
					status: 'active' | 'needs-attention';
					error?: string | undefined;
			  }
			| undefined;
		history: readonly {
			id: string;
			startedAt: number;
			stoppedAt?: number | undefined;
			actor: DesktopIdentitySnapshot;
			target: DesktopIdentitySnapshot;
			status: 'active' | 'stopped' | 'needs-attention';
			error?: string | undefined;
		}[];
		personas: readonly {
			id: string;
			label: string;
			note: string;
		}[];
	};
	performance: {
		isActive: boolean;
		startedAt: number | null;
		stoppedAt: number | null;
		error?: string | undefined;
		droppedSampleCount: number;
		samples: readonly DesktopPerformanceSampleSnapshot[];
		summary: {
			grade: 'idle' | 'healthy' | 'needsAttention' | 'critical';
			durationMs: number;
			sampleCount: number;
			averageJsFps: number;
			averageUiFps?: number | undefined;
			averageEventLoopLagMs: number;
			p95EventLoopLagMs: number;
			maxEventLoopLagMs: number;
			longFrameCount: number;
		};
	};
	components: readonly {
		id: string;
		targetId?: string | undefined;
		parentId?: string | undefined;
		depth?: number | undefined;
		zIndex?: number | undefined;
		name: string;
		kind: string;
		feature?: string | undefined;
		route?: string | undefined;
		testID?: string | undefined;
		targetKey?: string | undefined;
		sourceFiles: readonly string[];
		instanceText?: string | undefined;
		instanceTruncated: boolean;
		bounds: {
			x: number;
			y: number;
			width: number;
			height: number;
		} | null;
		isFocused: boolean;
		accessibilityLabel?: string | undefined;
		accessibilityHint?: string | undefined;
		accessibilityRole?: string | undefined;
		accessibilityValue?: string | undefined;
		accessibilityState?: Readonly<Record<string, boolean | string>> | undefined;
		styleText?: string | undefined;
		styleTruncated?: boolean | undefined;
		/** Protocol v2 semantic actions; absent on protocol v1 snapshots. */
		actions?:
			| readonly ('activate' | 'focus' | 'setText' | 'scroll')[]
			| undefined;
		/** Protocol v2 screen identity; absent on protocol v1 snapshots. */
		screenHash?: string | undefined;
	}[];
	componentRenders: readonly {
		id: string;
		targetId: string;
		at: number;
		phase: 'mount' | 'update' | 'nested-update';
		actualDuration: number;
		baseDuration: number;
		startTime: number;
		commitTime: number;
		renderCount: number;
		cause: 'mount' | 'props' | 'tracked-state' | 'parent' | 'unknown';
		changedKeys: readonly string[];
	}[];
	componentSummary: {
		sourceTargetCount: number;
		omittedTargetCount: number;
		truncated: boolean;
		/** Protocol v2 screen identity; absent on protocol v1 snapshots. */
		screenHash?: string | undefined;
		registrationDiagnostics?:
			| readonly {
					code: 'duplicate-target-id' | 'orphan-parent' | 'invalid-hierarchy';
					targetId: string;
					instanceIds: readonly string[];
					message: string;
			  }[]
			| undefined;
		error?: string | undefined;
	};
	/** Protocol v2 camera fixture status; absent on protocol v1 snapshots. */
	cameraFixture?: DesktopCameraFixtureSnapshot | undefined;
	diagnostics: readonly DesktopDiagnosticSnapshot[];
};

const toolIds = new Set<string>(RNDEVTOOLS_TOOL_IDS);
const actionCapabilities = new Set<string>(RNDEVTOOLS_ACTION_CAPABILITIES);

const MAX_IDENTIFIER_BYTES = 256;
const MAX_COMMAND_BYTES = 128;
const MAX_SHORT_TEXT_BYTES = 4 * 1024;
const MAX_LONG_TEXT_BYTES = 512 * 1024;
// Camera fixture actions share the bounded desktop action channel, whose full
// JSON envelope is capped at 600 KiB by the mobile client. Keep the encoded
// payload below that boundary so metadata and JSON overhead cannot turn an
// otherwise valid fixture into an oversized action.
const MAX_CAMERA_FIXTURE_BASE64_BYTES = 512 * 1024;

function dataRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	try {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return null;
		if (Object.getOwnPropertySymbols(value).length > 0) return null;
		const output = Object.create(null) as Record<string, unknown>;
		for (const [key, descriptor] of Object.entries(
			Object.getOwnPropertyDescriptors(value),
		)) {
			if (!descriptor.enumerable || !('value' in descriptor)) return null;
			output[key] = descriptor.value;
		}
		return output;
	} catch {
		return null;
	}
}

function hasOnlyKeys(
	value: Record<string, unknown>,
	allowedKeys: readonly string[],
): boolean {
	const allowed = new Set(allowedKeys);
	return Object.keys(value).every((key) => allowed.has(key));
}

function boundedTrimmedText(
	value: unknown,
	maxBytes: number,
): string | undefined {
	if (typeof value !== 'string') return undefined;
	const normalized = value.trim();
	if (!normalized || utf8ByteLength(normalized) > maxBytes) return undefined;
	return normalized;
}

function boundedText(value: unknown, maxBytes: number): string | undefined {
	if (typeof value !== 'string' || utf8ByteLength(value) > maxBytes) {
		return undefined;
	}
	return value;
}

function emptyPayload(
	value: Record<string, unknown>,
): Record<string, unknown> | null {
	return Object.keys(value).length === 0 ? {} : null;
}

function identifierPayload(
	value: Record<string, unknown>,
): Record<string, unknown> | null {
	if (!hasOnlyKeys(value, ['id'])) return null;
	const id = boundedTrimmedText(value.id, MAX_IDENTIFIER_BYTES);
	return id ? { id } : null;
}

function identifierList(
	value: unknown,
	maximum: number,
): readonly string[] | null {
	if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
		return null;
	}
	const identifiers: string[] = [];
	const seen = new Set<string>();
	for (const candidate of value) {
		const identifier = boundedTrimmedText(candidate, MAX_IDENTIFIER_BYTES);
		if (!identifier || seen.has(identifier)) return null;
		seen.add(identifier);
		identifiers.push(identifier);
	}
	return identifiers;
}

function scenarioVariables(
	value: unknown,
): Readonly<Record<string, string | number | boolean | null>> | null {
	const record = dataRecord(value);
	if (!record || Object.keys(record).length > 25) return null;
	const output = Object.create(null) as Record<
		string,
		string | number | boolean | null
	>;
	for (const [key, candidate] of Object.entries(record)) {
		const id = boundedTrimmedText(key, MAX_IDENTIFIER_BYTES);
		if (!id || id !== key) return null;
		if (typeof candidate === 'string') {
			if (utf8ByteLength(candidate) > 16 * 1024) return null;
			output[id] = candidate;
			continue;
		}
		if (
			candidate === null ||
			typeof candidate === 'boolean' ||
			(typeof candidate === 'number' && Number.isFinite(candidate))
		) {
			output[id] = candidate;
			continue;
		}
		return null;
	}
	return output;
}

function componentTargetPayload(
	value: Record<string, unknown>,
): { id: string; screenHash: string } | null {
	const id = boundedTrimmedText(value.id, MAX_IDENTIFIER_BYTES);
	const screenHash = boundedTrimmedText(value.screenHash, MAX_IDENTIFIER_BYTES);
	return id && screenHash ? { id, screenHash } : null;
}

function boundedTimeout(value: unknown): number | undefined {
	return typeof value === 'number' &&
		Number.isInteger(value) &&
		value >= 50 &&
		value <= 10_000
		? value
		: undefined;
}

function boundedPositiveInteger(
	value: unknown,
	maximum: number,
): number | undefined {
	return typeof value === 'number' &&
		Number.isSafeInteger(value) &&
		value > 0 &&
		value <= maximum
		? value
		: undefined;
}

function cameraFixturePayload(
	payload: Record<string, unknown>,
): Record<string, unknown> | null {
	if (
		!hasOnlyKeys(payload, [
			'kind',
			'label',
			'mimeType',
			'dataBase64',
			'width',
			'height',
			'durationMs',
			'errorMessage',
		])
	) {
		return null;
	}
	const kind = payload.kind;
	if (
		kind !== 'still' &&
		kind !== 'qr' &&
		kind !== 'video' &&
		kind !== 'unavailable' &&
		kind !== 'error'
	) {
		return null;
	}
	const label =
		payload.label === undefined
			? undefined
			: boundedTrimmedText(payload.label, MAX_SHORT_TEXT_BYTES);
	if (payload.label !== undefined && !label) return null;
	if (kind === 'unavailable') {
		return Object.keys(payload).every(
			(key) => key === 'kind' || key === 'label',
		)
			? { kind, ...(label ? { label } : {}) }
			: null;
	}
	if (kind === 'error') {
		if (
			!Object.keys(payload).every((key) =>
				['kind', 'label', 'errorMessage'].includes(key),
			)
		) {
			return null;
		}
		const errorMessage = boundedTrimmedText(
			payload.errorMessage,
			MAX_SHORT_TEXT_BYTES,
		);
		return errorMessage
			? { kind, errorMessage, ...(label ? { label } : {}) }
			: null;
	}

	const mimeType = boundedTrimmedText(payload.mimeType, 128)?.toLowerCase();
	const dataBase64 = boundedText(
		payload.dataBase64,
		MAX_CAMERA_FIXTURE_BASE64_BYTES,
	);
	const width = boundedPositiveInteger(payload.width, 16_384);
	const height = boundedPositiveInteger(payload.height, 16_384);
	if (!mimeType || !dataBase64 || !width || !height) return null;
	if (
		dataBase64.length === 0 ||
		dataBase64.length % 4 !== 0 ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)
	) {
		return null;
	}
	if (kind === 'still' || kind === 'qr') {
		if (
			mimeType !== 'image/jpeg' &&
			mimeType !== 'image/png' &&
			mimeType !== 'image/webp'
		) {
			return null;
		}
		if (
			payload.durationMs !== undefined ||
			payload.errorMessage !== undefined
		) {
			return null;
		}
		return {
			kind,
			mimeType,
			dataBase64,
			width,
			height,
			...(label ? { label } : {}),
		};
	}
	if (mimeType !== 'video/mp4' && mimeType !== 'video/quicktime') return null;
	if (payload.errorMessage !== undefined) return null;
	const durationMs = boundedPositiveInteger(
		payload.durationMs,
		10 * 60 * 1_000,
	);
	if (!durationMs) return null;
	return {
		kind,
		mimeType,
		dataBase64,
		width,
		height,
		durationMs,
		...(label ? { label } : {}),
	};
}

function actionPayload(
	tool: DesktopToolId,
	command: string,
	payload: Record<string, unknown>,
): Record<string, unknown> | null {
	const action = `${tool}.${command}`;
	if (action === 'network.clear' || action === 'console.clear') {
		return emptyPayload(payload);
	}
	if (action === 'network.clearProfile') return emptyPayload(payload);
	if (action === 'network.setProfile') {
		if (!hasOnlyKeys(payload, ['profileId'])) return null;
		return isNetworkSimulationProfileId(payload.profileId) &&
			payload.profileId !== 'none'
			? { profileId: payload.profileId }
			: null;
	}
	if (action === 'storage.set') {
		if (!hasOnlyKeys(payload, ['id', 'valueText'])) return null;
		const id = boundedTrimmedText(payload.id, MAX_IDENTIFIER_BYTES);
		const valueText = boundedText(payload.valueText, MAX_LONG_TEXT_BYTES);
		return id && valueText !== undefined ? { id, valueText } : null;
	}
	if (action === 'storage.undo' || action === 'storage.bookmark') {
		return identifierPayload(payload);
	}
	if (action === 'query.refetch' || action === 'query.invalidate') {
		return identifierPayload(payload);
	}
	if (action === 'query.simulate') {
		if (!hasOnlyKeys(payload, ['familyId', 'mode'])) return null;
		const familyId = boundedTrimmedText(payload.familyId, MAX_IDENTIFIER_BYTES);
		const mode = payload.mode;
		return familyId &&
			(mode === 'loading' ||
				mode === 'error' ||
				mode === 'paused' ||
				mode === 'offline')
			? { familyId, mode }
			: null;
	}
	if (action === 'query.clearSimulation') {
		if (!hasOnlyKeys(payload, ['receiptId'])) return null;
		const receiptId = boundedTrimmedText(
			payload.receiptId,
			MAX_IDENTIFIER_BYTES,
		);
		return receiptId ? { receiptId } : null;
	}
	if (action === 'routes.navigate') {
		if (!hasOnlyKeys(payload, ['path'])) return null;
		const path = boundedTrimmedText(payload.path, MAX_SHORT_TEXT_BYTES);
		return path ? { path } : null;
	}
	if (action === 'zustand.refresh' || action === 'components.refresh') {
		return emptyPayload(payload);
	}
	if (action === 'zustand.capture') {
		if (!hasOnlyKeys(payload, ['storeId'])) return null;
		const storeId = boundedTrimmedText(payload.storeId, MAX_IDENTIFIER_BYTES);
		return storeId ? { storeId } : null;
	}
	if (action === 'zustand.patch') {
		if (!hasOnlyKeys(payload, ['storeId', 'patchText'])) return null;
		const storeId = boundedTrimmedText(payload.storeId, MAX_IDENTIFIER_BYTES);
		const patchText = boundedText(payload.patchText, MAX_LONG_TEXT_BYTES);
		return storeId && patchText ? { storeId, patchText } : null;
	}
	if (action === 'zustand.jump') {
		if (!hasOnlyKeys(payload, ['storeId', 'snapshotId'])) return null;
		const storeId = boundedTrimmedText(payload.storeId, MAX_IDENTIFIER_BYTES);
		const snapshotId = boundedTrimmedText(
			payload.snapshotId,
			MAX_IDENTIFIER_BYTES,
		);
		return storeId && snapshotId ? { storeId, snapshotId } : null;
	}
	if (action === 'components.highlight') return identifierPayload(payload);
	if (action === 'components.activate' || action === 'components.focus') {
		if (!hasOnlyKeys(payload, ['id', 'screenHash'])) return null;
		return componentTargetPayload(payload);
	}
	if (action === 'components.setText') {
		if (!hasOnlyKeys(payload, ['id', 'screenHash', 'text'])) return null;
		const target = componentTargetPayload(payload);
		const text = boundedText(payload.text, 64 * 1024);
		return target && text !== undefined ? { ...target, text } : null;
	}
	if (action === 'components.scroll') {
		if (!hasOnlyKeys(payload, ['id', 'screenHash', 'direction', 'amount'])) {
			return null;
		}
		const target = componentTargetPayload(payload);
		const direction = payload.direction;
		if (
			!target ||
			(direction !== 'up' &&
				direction !== 'down' &&
				direction !== 'left' &&
				direction !== 'right')
		) {
			return null;
		}
		if (payload.amount === undefined) return { ...target, direction };
		return typeof payload.amount === 'number' &&
			Number.isFinite(payload.amount) &&
			payload.amount > 0 &&
			payload.amount <= 1
			? { ...target, direction, amount: payload.amount }
			: null;
	}
	if (action === 'components.waitForElement') {
		if (!hasOnlyKeys(payload, ['id', 'timeoutMs'])) return null;
		const id = boundedTrimmedText(payload.id, MAX_IDENTIFIER_BYTES);
		const timeoutMs = boundedTimeout(payload.timeoutMs);
		return id && timeoutMs ? { id, timeoutMs } : null;
	}
	if (action === 'components.waitForScreenChange') {
		if (!hasOnlyKeys(payload, ['screenHash', 'timeoutMs'])) return null;
		const screenHash = boundedTrimmedText(
			payload.screenHash,
			MAX_IDENTIFIER_BYTES,
		);
		const timeoutMs = boundedTimeout(payload.timeoutMs);
		return screenHash && timeoutMs ? { screenHash, timeoutMs } : null;
	}
	if (action === 'camera.clearFixture') return emptyPayload(payload);
	if (action === 'camera.setFixture') return cameraFixturePayload(payload);
	if (action === 'restore.capture') {
		if (!hasOnlyKeys(payload, ['label'])) return null;
		if (payload.label === undefined) return {};
		const label = boundedTrimmedText(payload.label, MAX_SHORT_TEXT_BYTES);
		return label ? { label } : null;
	}
	if (action === 'restore.resetBaseline') return emptyPayload(payload);
	if (action === 'restore.restore') {
		if (!hasOnlyKeys(payload, ['id', 'sourceIds'])) return null;
		const id = boundedTrimmedText(payload.id, MAX_IDENTIFIER_BYTES);
		if (!id) return null;
		if (payload.sourceIds === undefined) return { id };
		const sourceIds = identifierList(
			payload.sourceIds,
			RNDEVTOOLS_SNAPSHOT_LIMITS.restoreSources,
		);
		return sourceIds ? { id, sourceIds } : null;
	}
	if (action === 'restore.remove') return identifierPayload(payload);
	if (action === 'restore.rename' || action === 'restore.duplicate') {
		if (!hasOnlyKeys(payload, ['id', 'label'])) return null;
		const id = boundedTrimmedText(payload.id, MAX_IDENTIFIER_BYTES);
		const label = boundedTrimmedText(payload.label, MAX_SHORT_TEXT_BYTES);
		return id && label ? { id, label } : null;
	}
	if (action === 'scenarios.execute') {
		if (
			!hasOnlyKeys(payload, ['id', 'version', 'definitionToken', 'variables'])
		)
			return null;
		const id = boundedTrimmedText(payload.id, MAX_IDENTIFIER_BYTES);
		const version = boundedPositiveInteger(
			payload.version,
			Number.MAX_SAFE_INTEGER,
		);
		const definitionToken = boundedTrimmedText(
			payload.definitionToken,
			MAX_IDENTIFIER_BYTES,
		);
		if (!id || !version || !definitionToken) return null;
		if (payload.variables === undefined)
			return { id, version, definitionToken };
		const variables = scenarioVariables(payload.variables);
		return variables ? { id, version, definitionToken, variables } : null;
	}
	if (action === 'scenarios.undo') {
		if (!hasOnlyKeys(payload, ['receiptId'])) return null;
		const receiptId = boundedTrimmedText(
			payload.receiptId,
			MAX_IDENTIFIER_BYTES,
		);
		return receiptId ? { receiptId } : null;
	}
	if (action === 'scenarios.discardRecovery') {
		if (!hasOnlyKeys(payload, ['recoveryError'])) return null;
		const recoveryError = boundedTrimmedText(
			payload.recoveryError,
			MAX_LONG_TEXT_BYTES,
		);
		return recoveryError ? { recoveryError } : null;
	}
	if (action === 'scenarios.import') {
		if (!hasOnlyKeys(payload, ['json', 'mode'])) return null;
		const json = boundedText(payload.json, MAX_LONG_TEXT_BYTES);
		const mode = payload.mode;
		return json !== undefined && (mode === 'replace' || mode === 'merge')
			? { json, mode }
			: null;
	}
	if (action === 'scenarios.remove') {
		if (!hasOnlyKeys(payload, ['id', 'version', 'definitionToken']))
			return null;
		const id = boundedTrimmedText(payload.id, MAX_IDENTIFIER_BYTES);
		const version = boundedPositiveInteger(
			payload.version,
			Number.MAX_SAFE_INTEGER,
		);
		const definitionToken = boundedTrimmedText(
			payload.definitionToken,
			MAX_IDENTIFIER_BYTES,
		);
		return id && version && definitionToken
			? { id, version, definitionToken }
			: null;
	}
	if (action === 'identity.start') {
		if (!hasOnlyKeys(payload, ['personaId'])) return null;
		const personaId = boundedTrimmedText(
			payload.personaId,
			MAX_IDENTIFIER_BYTES,
		);
		return personaId ? { personaId } : null;
	}
	if (action === 'identity.stop') return emptyPayload(payload);
	if (action === 'performance.start' || action === 'performance.stop') {
		return emptyPayload(payload);
	}
	return null;
}

export function isDesktopToolId(value: unknown): value is DesktopToolId {
	return typeof value === 'string' && toolIds.has(value);
}

export function desktopActionCapability(
	tool: DesktopToolId,
	command: string,
): DesktopActionCapability | undefined {
	const action = `${tool}.${command}`;
	const capability =
		action === 'storage.set'
			? 'storage.write'
			: action === 'storage.undo'
				? 'storage.undo'
				: action === 'storage.bookmark'
					? 'storage.bookmark'
					: action === 'performance.start' || action === 'performance.stop'
						? 'performance.review'
						: action;
	return actionCapabilities.has(capability)
		? (capability as DesktopActionCapability)
		: undefined;
}

/** Parse and normalize the untrusted body of a desktop action envelope. */
export function parseDesktopDeviceAction(
	value: unknown,
): DesktopDeviceAction | null {
	try {
		const record = dataRecord(value);
		if (!record) return null;
		if (
			!hasOnlyKeys(record, [
				'actionId',
				'deviceId',
				'tool',
				'command',
				'payload',
			])
		) {
			return null;
		}
		const actionId = boundedTrimmedText(record.actionId, MAX_IDENTIFIER_BYTES);
		const deviceId = boundedTrimmedText(record.deviceId, MAX_IDENTIFIER_BYTES);
		const command = boundedTrimmedText(record.command, MAX_COMMAND_BYTES);
		const payloadRecord = dataRecord(record.payload);
		if (
			!actionId ||
			!deviceId ||
			!isDesktopToolId(record.tool) ||
			!command ||
			!payloadRecord ||
			!desktopActionCapability(record.tool, command)
		) {
			return null;
		}
		const payload = actionPayload(record.tool, command, payloadRecord);
		if (!payload) return null;
		return { actionId, deviceId, tool: record.tool, command, payload };
	} catch {
		// Untrusted proxies and coercion hooks are invalid protocol values.
		return null;
	}
}

export function parseDesktopActionEnvelope(
	value: unknown,
): DesktopDeviceAction | null {
	try {
		const record = dataRecord(value);
		if (
			!record ||
			!hasOnlyKeys(record, ['type', 'action']) ||
			record.type !== 'action'
		) {
			return null;
		}
		return parseDesktopDeviceAction(record.action);
	} catch {
		return null;
	}
}

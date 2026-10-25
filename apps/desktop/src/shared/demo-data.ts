import { RNDEVTOOLS_SNAPSHOT_LIMITS } from '@rndevtools/core/desktop-protocol';
import {
	DEFAULT_SCENARIO_USER_LIMIT,
	parseScenarioDocumentJson,
	SCENARIO_DOCUMENT_MAX_BYTES,
	type ScenarioDefinition,
} from '@rndevtools/core/scenario-model';
import {
	createEmptyDeviceTools,
	type DesktopAction,
	type DeviceSession,
	type DeviceTools,
	deviceSessionSchema,
	type PerformanceReview,
	type PerformanceSample,
	type ScenarioDefinitionSummary,
} from './protocol';

const DEMO_DEVICE_ID = 'rndevtools-demo-ios';

function samplePerformance(now: number): PerformanceReview {
	const samples: PerformanceSample[] = Array.from(
		{ length: 36 },
		(_, index) => {
			const dip = index === 13 || index === 14 || index === 27;
			const lag = dip ? 38 + (index % 3) * 12 : 3 + ((index * 7) % 8);
			return {
				id: `perf-${index}`,
				at: now - (35 - index) * 1_000,
				jsFps: dip ? 42 + (index % 5) : 57 + (index % 4),
				uiFps: dip ? 49 + (index % 4) : 59 + (index % 2),
				cpuPercent: dip ? 43 + (index % 7) : 16 + ((index * 3) % 13),
				memoryMb: 186 + index * 0.35,
				eventLoopLagMs: lag,
				longFrames: dip ? 2 : index % 12 === 0 ? 1 : 0,
				maxFrameMs: dip ? 66 + index : 17 + (index % 8),
				route: index < 18 ? '/(tabs)' : '/project/active',
			};
		}
	);

	return {
		isActive: true,
		startedAt: now - 36_000,
		stoppedAt: null,
		droppedSampleCount: 0,
		samples,
		summary: summarizePerformance(samples, now - 36_000, now),
	};
}

function percentile(values: number[], fraction: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	return (
		sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
		0
	);
}

function summarizePerformance(
	samples: PerformanceSample[],
	startedAt: number | null,
	endedAt: number
): PerformanceReview['summary'] {
	const jsFps = samples.map((sample) => sample.jsFps);
	const uiFps = samples.flatMap((sample) =>
		sample.uiFps === undefined ? [] : [sample.uiFps]
	);
	const lags = samples.map((sample) => sample.eventLoopLagMs);
	const average = (values: number[]) =>
		values.length === 0
			? 0
			: values.reduce((total, value) => total + value, 0) / values.length;
	const averageLag = average(lags);
	const p95 = percentile(lags, 0.95);
	const grade = p95 > 80 ? 'critical' : p95 > 32 ? 'needsAttention' : 'healthy';

	return {
		grade: samples.length === 0 ? 'idle' : grade,
		durationMs: startedAt === null ? 0 : Math.max(0, endedAt - startedAt),
		sampleCount: samples.length,
		averageJsFps: average(jsFps),
		averageUiFps: uiFps.length > 0 ? average(uiFps) : undefined,
		averageEventLoopLagMs: averageLag,
		p95EventLoopLagMs: p95,
		maxEventLoopLagMs: Math.max(0, ...lags),
		longFrameCount: samples.reduce(
			(total, sample) => total + sample.longFrames,
			0
		),
	};
}

function demoTools(now: number): DeviceTools {
	return {
		...createEmptyDeviceTools(),
		network: [
			{
				id: 'net-6',
				at: now - 2_300,
				method: 'POST',
				url: 'https://api.example.com/functions/v1/assistant-message',
				host: 'api.example.com',
				path: '/functions/v1/assistant-message',
				status: 200,
				state: 'success',
				durationMs: 742,
				requestBytes: 628,
				responseBytes: 4_896,
				contentType: 'application/json',
				source: 'edge function',
				requestHeaders: {
					'content-type': 'application/json',
					authorization: 'Bearer [REDACTED]',
				},
				requestBody: JSON.stringify(
					{ threadId: '[REDACTED_ID]', message: '[REDACTED]' },
					null,
					2
				),
				responseBody: JSON.stringify(
					{
						response: 'Organized the next project milestones and open tasks.',
						toolCalls: ['get_project_context', 'update_project'],
					},
					null,
					2
				),
			},
			{
				id: 'net-5',
				at: now - 6_700,
				method: 'GET',
				url: 'https://api.example.com/rest/v1/projects?limit=20',
				host: 'api.example.com',
				path: '/rest/v1/projects',
				status: 200,
				state: 'success',
				durationMs: 186,
				responseBytes: 18_420,
				contentType: 'application/json',
				source: 'rest',
				responseBody: '[{"id":"[REDACTED_ID]","status":"complete"}]',
			},
			{
				id: 'net-4',
				at: now - 12_900,
				method: 'PATCH',
				url: 'https://api.example.com/rest/v1/tasks?id=eq.[REDACTED_ID]',
				host: 'api.example.com',
				path: '/rest/v1/tasks',
				status: 204,
				state: 'success',
				durationMs: 129,
				requestBytes: 86,
				responseBytes: 0,
				contentType: 'application/json',
				source: 'rest',
				requestBody: '{"priority":2,"progress":75,"archived":false}',
			},
			{
				id: 'net-3',
				at: now - 18_400,
				method: 'GET',
				url: 'https://api.example.com/rest/v1/project_plans?active=eq.true',
				host: 'api.example.com',
				path: '/rest/v1/project_plans',
				status: 503,
				state: 'error',
				durationMs: 1_842,
				responseBytes: 142,
				contentType: 'application/json',
				source: 'rest',
				error: 'Upstream connection timed out',
				responseBody: '{"code":"UPSTREAM_TIMEOUT","retryable":true}',
			},
			{
				id: 'net-2',
				at: now - 24_100,
				method: 'POST',
				url: 'https://api.example.com/rest/v1/device_tokens',
				host: 'api.example.com',
				path: '/rest/v1/device_tokens',
				status: 201,
				state: 'success',
				durationMs: 211,
				requestBytes: 160,
				responseBytes: 74,
				contentType: 'application/json',
				source: 'rest',
			},
		],
		console: [
			{
				id: 'log-7',
				at: now - 1_900,
				level: 'info',
				message: 'Assistant response completed',
				attributesText: '{\n  "duration_ms": 742,\n  "tools": 2\n}',
				source: 'assistant',
			},
			{
				id: 'log-6',
				at: now - 4_800,
				level: 'debug',
				message: 'Query cache updated',
				attributesText: '{\n  "query": "projects",\n  "rows": 20\n}',
				source: 'query',
			},
			{
				id: 'log-5',
				at: now - 12_300,
				level: 'info',
				message: 'Task saved',
				attributesText: '{\n  "priority": 2,\n  "progress": 75\n}',
				source: 'active-project',
			},
			{
				id: 'log-4',
				at: now - 18_100,
				level: 'error',
				message: 'Project plan request failed',
				attributesText: '{\n  "status": 503,\n  "retryable": true\n}',
				source: 'network',
			},
			{
				id: 'log-3',
				at: now - 31_000,
				level: 'warn',
				message: 'JS frame exceeded interaction budget',
				attributesText: '{\n  "frame_ms": 67,\n  "route": "/project/active"\n}',
				source: 'performance',
			},
		],
		storage: [
			{
				id: 'storage-theme',
				adapterId: 'example-standard-mmkv',
				adapterTitle: 'Standard MMKV',
				key: 'appearance/theme',
				valueText: 'dark',
				valueType: 'string',
				bytes: 4,
				editable: true,
				sensitive: false,
				updatedAt: now - 86_400_000,
			},
			{
				id: 'storage-devtools',
				adapterId: 'example-standard-mmkv',
				adapterTitle: 'Standard MMKV',
				key: '@rndevtools/core/runtime-state',
				valueText:
					'{"dataSourceMode":"real","showDebugBadges":true,"customFlags":{"newStats":true}}',
				valueType: 'string',
				bytes: 91,
				editable: true,
				sensitive: false,
				updatedAt: now - 42_000,
			},
			{
				id: 'storage-unit',
				adapterId: 'example-standard-mmkv',
				adapterTitle: 'Standard MMKV',
				key: 'preferences/date-format',
				valueText: 'MD',
				valueType: 'string',
				bytes: 2,
				editable: true,
				sensitive: false,
				updatedAt: now - 5_400_000,
			},
			{
				id: 'storage-auth',
				adapterId: 'example-secure-mmkv',
				adapterTitle: 'Secure MMKV',
				key: 'supabase.auth.token',
				valueType: 'hidden',
				bytes: 0,
				editable: false,
				sensitive: true,
				updatedAt: now - 3_600_000,
			},
		],
		storageEvents: [
			{
				id: 'storage-event-2',
				at: now - 42_000,
				adapterId: 'example-standard-mmkv',
				key: '@rndevtools/core/runtime-state',
				kind: 'updated',
				previousText: '{"showDebugBadges":false}',
				nextText: '{"showDebugBadges":true}',
				undoAvailable: true,
				undoStatus: 'available',
				structuralDiff: [
					{
						path: '$.showDebugBadges',
						kind: 'changed',
						previousText: 'false',
						nextText: 'true',
					},
				],
			},
		],
		storageSummary: {
			adapterCount: 2,
			totalKeyCount: 4,
			omittedKeyCount: 0,
			truncated: false,
			errors: [],
		},
		queries: [
			{
				id: 'query-profile',
				hash: 'query-1',
				keyText: '["profile", "current"]',
				status: 'success',
				fetchStatus: 'idle',
				updatedAt: now - 52_000,
				observers: 4,
				isStale: false,
				dataText: '{"displayName":"[REDACTED]","projectsCreated":4}',
				truncated: false,
			},
			{
				id: 'query-active-project',
				hash: 'query-2',
				keyText: '["project", "active"]',
				status: 'success',
				fetchStatus: 'fetching',
				updatedAt: now - 9_000,
				observers: 2,
				isStale: true,
				dataText: '{"taskCount":6,"completedTasks":11,"totalTasks":24}',
				truncated: false,
			},
			{
				id: 'query-project-plan',
				hash: 'query-3',
				keyText: '["project-plan", "active"]',
				status: 'error',
				fetchStatus: 'idle',
				updatedAt: now - 18_000,
				observers: 1,
				isStale: true,
				errorText: 'Upstream connection timed out',
				truncated: false,
			},
			{
				id: 'query-templates',
				hash: 'query-4',
				keyText: '["templates", "catalog"]',
				status: 'success',
				fetchStatus: 'idle',
				updatedAt: now - 820_000,
				observers: 0,
				isStale: false,
				dataText: '{"count":1248,"source":"catalog"}',
				truncated: false,
			},
		],
		mutations: [
			{
				id: 'mutation-task',
				keyText: '["project-task", "save"]',
				status: 'success',
				submittedAt: now - 12_900,
				variablesText: '{"priority":2,"progress":75}',
				truncated: false,
			},
		],
		querySummary: {
			sourceQueryCount: 4,
			omittedQueryCount: 0,
			sourceMutationCount: 1,
			omittedMutationCount: 0,
			truncated: false,
		},
		querySimulation: {
			families: [
				{
					id: 'all-example-queries',
					label: 'All app queries',
					description:
						'Uses the supported TanStack Query online manager; native SDKs and non-query traffic are unaffected.',
					modes: [
						{
							mode: 'loading',
							supported: false,
							reason:
								'No presentation adapter is registered to force loading without mutating private query state.',
						},
						{
							mode: 'error',
							supported: false,
							reason:
								'No presentation adapter is registered to force an error without mutating private query state.',
						},
						{ mode: 'paused', supported: true },
						{ mode: 'offline', supported: true },
					],
				},
			],
			active: {
				familyId: 'all-example-queries',
				familyLabel: 'All app queries',
				mode: 'offline',
				receiptId: 'query-simulation-demo',
				startedAt: now - 5_000,
			},
		},
		routes: [
			{
				id: 'route-tabs',
				path: '/(tabs)',
				name: 'Home',
				kind: 'group',
				filename: 'app/(tabs)/index.tsx',
				isCurrent: false,
				isVisible: false,
				depth: 0,
			},
			{
				id: 'route-project',
				path: '/project/active',
				name: 'Active project',
				kind: 'static',
				filename: 'app/project/active.tsx',
				isCurrent: true,
				isVisible: true,
				depth: 1,
			},
			{
				id: 'route-template',
				path: '/templates/[templateId]',
				name: 'Template detail',
				kind: 'dynamic',
				filename: 'app/templates/[templateId].tsx',
				isCurrent: false,
				isVisible: false,
				depth: 0,
			},
			{
				id: 'route-settings',
				path: '/settings',
				name: 'Settings',
				kind: 'static',
				filename: 'app/settings.tsx',
				isCurrent: false,
				isVisible: false,
				depth: 0,
			},
		],
		routeEvents: [
			{
				id: 'route-event-3',
				at: now - 35_000,
				route: '/project/active',
				transitionId: 'navigation-transition-3',
				phase: 'focused',
				source: 'app',
				durationMs: 118,
			},
			{
				id: 'route-event-2',
				at: now - 81_000,
				route: '/(tabs)',
				transitionId: 'navigation-transition-2',
				phase: 'focused',
				source: 'app',
				durationMs: 74,
			},
		],
		environment: [
			{
				id: 'env-variant',
				section: 'Application',
				key: 'APP_VARIANT',
				valueText: 'development',
				status: 'valid',
			},
			{
				id: 'env-id',
				section: 'Application',
				key: 'APPLICATION_ID',
				valueText: 'com.example.app.development',
				status: 'valid',
			},
			{
				id: 'env-version',
				section: 'Application',
				key: 'APP_VERSION',
				valueText: '1.0.1 (482)',
				status: 'valid',
			},
			{
				id: 'env-update',
				section: 'Updates',
				key: 'UPDATE_CHANNEL',
				valueText: 'development',
				status: 'valid',
			},
			{
				id: 'env-runtime',
				section: 'Updates',
				key: 'RUNTIME_VERSION',
				valueText: '1.0.1',
				status: 'valid',
			},
			{
				id: 'env-platform',
				section: 'Device',
				key: 'PLATFORM',
				valueText: 'ios',
				status: 'valid',
			},
			{
				id: 'env-backend',
				section: 'Backend',
				key: 'DATABASE_CONNECTION',
				valueText: 'LOCAL',
				status: 'valid',
			},
			{
				id: 'env-sentry',
				section: 'Observability',
				key: 'SENTRY_DSN',
				valueText: 'Not set',
				status: 'missing',
				description: 'Optional in local development.',
			},
		],
		zustandStores: [
			{
				id: 'active-project',
				title: 'Active project',
				description: 'Explicit active project projection',
				stateText:
					'{\n  "status": "active",\n  "taskCount": 6,\n  "completedTasks": 11,\n  "pendingTaskCount": 13,\n  "elapsedSeconds": 1842\n}',
				keys: [
					'status',
					'taskCount',
					'completedTasks',
					'pendingTaskCount',
					'elapsedSeconds',
				],
				updatedAt: now - 2_500,
				capabilities: {
					writable: false,
					resettable: false,
					persisted: true,
					restorable: false,
				},
			},
			{
				id: 'focus-timer',
				title: 'Focus timer',
				description: 'Timer state without notification identifiers',
				stateText:
					'{\n  "status": "running",\n  "durationSeconds": 120,\n  "remainingSeconds": 48,\n  "isVisible": true\n}',
				keys: ['status', 'durationSeconds', 'remainingSeconds', 'isVisible'],
				updatedAt: now - 1_000,
				capabilities: {
					writable: false,
					resettable: false,
					persisted: true,
					restorable: false,
				},
			},
			{
				id: 'dev-menu',
				title: 'Developer overrides',
				description: 'Explicit, restorable diagnostic settings',
				stateText:
					'{\n  "dataSourceMode": "real",\n  "globalStateOverride": "none",\n  "showDebugBadges": true,\n  "customFlags": { "newStats": true }\n}',
				keys: [
					'dataSourceMode',
					'globalStateOverride',
					'showDebugBadges',
					'customFlags',
				],
				updatedAt: now - 42_000,
				capabilities: {
					writable: true,
					resettable: true,
					persisted: true,
					restorable: true,
				},
			},
		],
		zustandChanges: [
			{
				id: 'zustand-change-3',
				at: now - 1_000,
				storeId: 'focus-timer',
				storeTitle: 'Focus timer',
				changedKeys: ['remainingSeconds'],
				stateText: '{"remainingSeconds":48}',
			},
			{
				id: 'zustand-change-2',
				at: now - 2_500,
				storeId: 'active-project',
				storeTitle: 'Active project',
				changedKeys: ['completedTasks', 'pendingTaskCount'],
				stateText: '{"completedTasks":11,"pendingTaskCount":13}',
			},
		],
		zustandStateSnapshots: [],
		zustandMutationReceipts: [],
		zustandSummary: {
			totalStoreCount: 3,
			omittedStoreCount: 0,
			truncated: false,
		},
		restorePoints: [
			{
				id: 'restore-before-empty-state',
				label: 'Before empty-state QA',
				createdAt: now - 420_000,
				estimatedBytes: 382,
				sources: [
					{
						id: 'developer-overrides',
						title: 'Developer overrides',
						preview:
							'{"dataSourceMode":"real","globalStateOverride":"none","showDebugBadges":true}',
						bytes: 382,
					},
				],
			},
		],
		restoreReceipts: [
			{
				id: 'restore-receipt-demo',
				pointId: 'restore-before-empty-state',
				pointLabel: 'Before empty-state QA',
				startedAt: now - 90_000,
				completedAt: now - 89_800,
				status: 'complete',
				sourceResults: [
					{
						sourceId: 'developer-overrides',
						sourceTitle: 'Developer overrides',
						preflight: 'passed',
						apply: 'succeeded',
						rollback: 'not-needed',
					},
				],
			},
		],
		scenarios: [
			{
				id: 'example.powerUser',
				version: 1,
				definitionToken: 'demo-power-user-v1',
				name: 'Frequent user',
				description: 'Frequent-user project history and active plan fixtures.',
				bundled: true,
				variables: [],
				preconditionCount: 0,
				steps: [
					{
						id: 'developer-overrides',
						type: 'developer-overrides',
						label: 'Apply frequent-user persona',
					},
					{ id: 'home-route', type: 'navigation', label: 'Open Home' },
				],
			},
			{
				id: 'example.freshUser',
				version: 1,
				definitionToken: 'demo-fresh-user-v1',
				name: 'New user',
				description: 'Fresh-user fixtures for onboarding and empty states.',
				bundled: true,
				variables: [],
				preconditionCount: 0,
				steps: [
					{
						id: 'developer-overrides',
						type: 'developer-overrides',
						label: 'Apply new-user persona',
					},
					{ id: 'home-route', type: 'navigation', label: 'Open Home' },
				],
			},
		],
		scenarioRuntime: { running: false },
		scenarioReceipts: [],
		identitySession: {
			running: false,
			history: [
				{
					id: 'identity-history-demo',
					startedAt: now - 720_000,
					stoppedAt: now - 540_000,
					actor: { kind: 'account', label: 'Original account' },
					target: { kind: 'persona', label: 'New user', personaId: 'visual' },
					status: 'stopped',
				},
			],
			personas: [
				{
					id: 'fresh',
					label: 'Empty account',
					note: 'Onboarded · no projects yet',
				},
				{
					id: 'power',
					label: 'Frequent user',
					note: 'Onboarded · full project history',
				},
				{
					id: 'visual',
					label: 'New user',
					note: 'Onboarded · visual regression history',
				},
			],
		},
		performance: samplePerformance(now),
		components: [
			{
				id: 'feedback-active-project',
				name: 'ActiveProjectScreen',
				kind: 'screen',
				feature: 'active-project',
				route: '/project/active',
				testID: 'active-project-screen',
				targetKey: 'active-project',
				sourceFiles: [
					'apps/mobile/src/features/active-project/screens/active-project-screen.tsx',
				],
				instanceText:
					'{\n  "taskCount": 6,\n  "completedTasks": 11,\n  "isFocused": true\n}',
				instanceTruncated: false,
				bounds: { x: 0, y: 94, width: 393, height: 758 },
				isFocused: true,
			},
			{
				id: 'feedback-task-row',
				name: 'ProjectTaskRow',
				kind: 'component',
				feature: 'active-project',
				route: '/project/active',
				testID: 'project-task-row-11',
				targetKey: 'task-row',
				sourceFiles: [
					'apps/mobile/src/features/active-project/components/project-task-row.tsx',
				],
				instanceText:
					'{\n  "taskNumber": 3,\n  "priority": 2,\n  "progress": 75,\n  "status": "complete"\n}',
				instanceTruncated: false,
				bounds: { x: 16, y: 438, width: 361, height: 64 },
				isFocused: true,
			},
			{
				id: 'feedback-focus-timer',
				name: 'FocusTimerOverlay',
				kind: 'overlay',
				feature: 'active-project',
				route: '/project/active',
				testID: 'focus-timer-overlay',
				targetKey: 'focus-timer',
				sourceFiles: [
					'apps/mobile/src/features/active-project/components/focus-timer-overlay.tsx',
				],
				instanceText:
					'{\n  "remainingSeconds": 48,\n  "durationSeconds": 120\n}',
				instanceTruncated: false,
				bounds: { x: 16, y: 726, width: 361, height: 92 },
				isFocused: true,
			},
		],
		componentRenders: [
			{
				id: 'demo-render-1',
				targetId: 'feedback-task-row',
				at: now - 9_500,
				phase: 'update',
				actualDuration: 5.8,
				baseDuration: 11.4,
				startTime: 1_024,
				commitTime: 1_031,
				renderCount: 4,
				cause: 'unknown',
				changedKeys: [],
			},
		],
		componentSummary: {
			sourceTargetCount: 3,
			omittedTargetCount: 0,
			truncated: false,
		},
		cameraFixture: { active: false },
		diagnostics: [
			{
				id: 'diag-ready',
				at: now - 74_000,
				level: 'info',
				scope: 'device',
				message: 'Demo session registered with protocol v1.',
			},
			{
				id: 'diag-redaction',
				at: now - 70_000,
				level: 'info',
				scope: 'privacy',
				message: 'Console and network payload redaction enabled.',
			},
		],
	};
}

export function createDemoDevice(now = Date.now()): DeviceSession {
	return {
		info: {
			id: DEMO_DEVICE_ID,
			name: 'iPhone 16 Pro · Demo',
			platform: 'simulator',
			model: 'iPhone 16 Pro',
			osVersion: 'iOS 19.6',
			appVersion: '1.0.1',
			buildVersion: '482',
			runtimeVersion: '1.0.1',
			variant: 'development',
			viewport: { width: 393, height: 852 },
			capabilities: [
				'network.clear',
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
			],
		},
		status: 'simulated',
		connectedAt: now - 84_000,
		lastSeenAt: now,
		sequence: 42,
		latencyMs: 0,
		tools: demoTools(now),
	};
}

function payloadString(action: DesktopAction, key: string): string | undefined {
	const value = action.payload[key];
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function scenarioSummary(
	definition: ScenarioDefinition
): ScenarioDefinitionSummary {
	return {
		id: definition.id,
		version: definition.version,
		definitionToken: `demo-import-${definition.id}-${definition.version}-${Math.random().toString(36).slice(2, 14)}`,
		name: definition.name,
		...(definition.description ? { description: definition.description } : {}),
		bundled: false,
		variables: definition.variables.map(({ options, ...variable }) => ({
			...variable,
			...(options ? { options: [...options] } : {}),
		})),
		preconditionCount: definition.preconditions.length,
		steps: definition.steps.map((step) => ({
			id: step.id,
			type: step.type,
			...(step.label ? { label: step.label } : {}),
		})),
	};
}

function importedDemoScenarios(
	current: readonly ScenarioDefinitionSummary[],
	json: string,
	mode: unknown
): readonly ScenarioDefinitionSummary[] {
	if (mode !== 'replace' && mode !== 'merge') {
		throw new Error('Scenario import mode is invalid.');
	}
	const imported =
		parseScenarioDocumentJson(json).scenarios.map(scenarioSummary);
	const bundled = current.filter((scenario) => scenario.bundled);
	const user = current.filter((scenario) => !scenario.bundled);
	const bundledIds = new Set(bundled.map((scenario) => scenario.id));
	for (const scenario of imported) {
		if (bundledIds.has(scenario.id)) {
			throw new Error(
				`Imported scenario conflicts with bundled id: ${scenario.id}`
			);
		}
	}
	let nextUser: readonly ScenarioDefinitionSummary[];
	if (mode === 'replace') {
		nextUser = imported;
	} else {
		const userIds = new Set(user.map((scenario) => scenario.id));
		for (const scenario of imported) {
			if (userIds.has(scenario.id)) {
				throw new Error(`Imported scenario id already exists: ${scenario.id}`);
			}
		}
		nextUser = [...user, ...imported];
	}
	if (nextUser.length > DEFAULT_SCENARIO_USER_LIMIT) {
		throw new Error('Imported scenarios exceed the user scenario-count limit.');
	}
	if (
		new TextEncoder().encode(JSON.stringify(nextUser)).byteLength >
		SCENARIO_DOCUMENT_MAX_BYTES
	) {
		throw new Error('Imported scenarios exceed the user scenario byte limit.');
	}
	return [...bundled, ...nextUser];
}

/**
 * Keeps the newest rows of every collection a demo action adds to, as a real
 * device's bounded projection does. Most collections list the newest row first;
 * the Zustand history lists it last.
 */
function boundDemoTools(tools: DeviceTools): void {
	const limits = RNDEVTOOLS_SNAPSHOT_LIMITS;
	tools.storageEvents = tools.storageEvents.slice(0, limits.storageEvents);
	tools.routeEvents = tools.routeEvents.slice(0, limits.routeEvents);
	tools.restorePoints = tools.restorePoints.slice(0, limits.restorePoints);
	tools.restoreReceipts = tools.restoreReceipts.slice(
		0,
		limits.restoreReceipts
	);
	tools.scenarioReceipts = tools.scenarioReceipts.slice(
		0,
		limits.scenarioReceipts
	);
	tools.diagnostics = tools.diagnostics.slice(0, limits.diagnostics);
	tools.zustandChanges = tools.zustandChanges.slice(-limits.zustandChanges);
	tools.zustandStateSnapshots = tools.zustandStateSnapshots.slice(
		-limits.zustandStateSnapshots
	);
	tools.zustandMutationReceipts = tools.zustandMutationReceipts.slice(
		-limits.zustandMutationReceipts
	);
}

/**
 * The broker stores a demo action's result without the inbound parse a real
 * device's snapshot gets, and one state outside the schema makes the preload
 * drop every later broadcast. So the result is bounded, and an action whose
 * result still does not fit fails and leaves the device as it was.
 */
export function applyDemoAction(
	device: DeviceSession,
	action: DesktopAction,
	now = Date.now()
): DeviceSession {
	const next = applyUnboundedDemoAction(device, action, now);
	boundDemoTools(next.tools);
	if (!deviceSessionSchema.safeParse(next).success) {
		throw new Error('The demo device cannot hold the result of this action.');
	}
	return next;
}

function applyUnboundedDemoAction(
	device: DeviceSession,
	action: DesktopAction,
	now: number
): DeviceSession {
	const next = structuredClone(device);
	next.lastSeenAt = now;
	next.sequence += 1;

	if (action.tool === 'network' && action.command === 'clear') {
		next.tools.network = [];
		return next;
	}
	if (action.tool === 'console' && action.command === 'clear') {
		next.tools.console = [];
		return next;
	}
	if (action.tool === 'storage' && action.command === 'set') {
		const id = payloadString(action, 'id');
		const valueText = payloadString(action, 'valueText');
		if (!id || valueText === undefined)
			throw new Error('Storage value is invalid.');
		const entry = next.tools.storage.find((candidate) => candidate.id === id);
		if (!entry?.editable || entry.sensitive) {
			throw new Error('This storage entry cannot be edited.');
		}
		const previousText = entry.valueText;
		entry.valueText = valueText;
		entry.bytes = new TextEncoder().encode(valueText).byteLength;
		entry.updatedAt = now;
		next.tools.storageEvents.unshift({
			id: `storage-event-${now}`,
			at: now,
			adapterId: entry.adapterId,
			key: entry.key,
			kind: 'updated',
			previousText,
			nextText: valueText,
			undoAvailable: true,
			undoStatus: 'available',
		});
		return next;
	}
	if (action.tool === 'storage' && action.command === 'bookmark') {
		const id = payloadString(action, 'id');
		const event = next.tools.storageEvents.find(
			(candidate) => candidate.id === id
		);
		if (!event) throw new Error('Storage history entry was not found.');
		event.bookmarked = !event.bookmarked;
		return next;
	}
	if (action.tool === 'storage' && action.command === 'undo') {
		const id = payloadString(action, 'id');
		const event = next.tools.storageEvents.find(
			(candidate) => candidate.id === id
		);
		if (!event?.undoAvailable || event.previousText === undefined) {
			throw new Error('Storage history entry cannot be undone.');
		}
		const entry = next.tools.storage.find(
			(candidate) =>
				candidate.adapterId === event.adapterId && candidate.key === event.key
		);
		if (!entry?.editable) throw new Error('Storage value cannot be restored.');
		entry.valueText = event.previousText;
		entry.bytes = new TextEncoder().encode(event.previousText).byteLength;
		event.undoAvailable = false;
		event.undoStatus = 'succeeded';
		return next;
	}
	if (
		action.tool === 'query' &&
		['invalidate', 'refetch'].includes(action.command)
	) {
		const id = payloadString(action, 'id');
		const query = next.tools.queries.find((candidate) => candidate.id === id);
		if (!query) throw new Error('Query was not found.');
		if (action.command === 'invalidate') {
			query.isStale = true;
		} else {
			query.fetchStatus = 'fetching';
			query.status = 'success';
			query.errorText = undefined;
			query.updatedAt = now;
		}
		return next;
	}
	if (action.tool === 'routes' && action.command === 'navigate') {
		const path = payloadString(action, 'path');
		if (!path) throw new Error('Route path is required.');
		for (const route of next.tools.routes) {
			route.isCurrent = route.path === path;
			route.isVisible = route.path === path;
		}
		next.tools.routeEvents.unshift({
			id: `route-event-${now}`,
			at: now,
			route: path,
			transitionId: `navigation-transition-${now}`,
			phase: 'focused',
			source: 'desktop',
			correlationId: action.actionId,
			durationMs: 96,
		});
		return next;
	}
	if (action.tool === 'restore' && action.command === 'capture') {
		const label = payloadString(action, 'label') ?? 'Desktop checkpoint';
		const preview =
			next.tools.zustandStores.find((store) => store.id === 'dev-menu')
				?.stateText ?? '{}';
		next.tools.restorePoints.unshift({
			id: `restore-${now}`,
			label,
			createdAt: now,
			estimatedBytes: new TextEncoder().encode(preview).byteLength,
			sources: [
				{
					id: 'developer-overrides',
					title: 'Developer overrides',
					preview,
					bytes: new TextEncoder().encode(preview).byteLength,
				},
			],
		});
		return next;
	}
	if (action.tool === 'restore' && action.command === 'resetBaseline') {
		next.tools.restoreReceipts.unshift({
			id: `restore-receipt-${now}`,
			pointId: 'baseline',
			pointLabel: 'Reset to baseline',
			startedAt: now,
			completedAt: now + 50,
			status: 'complete',
			sourceResults: [
				{
					sourceId: 'safe-standard-preferences',
					sourceTitle: 'Safe standard preferences',
					preflight: 'passed',
					apply: 'succeeded',
					rollback: 'not-needed',
				},
			],
		});
		return next;
	}
	if (action.tool === 'restore' && action.command === 'remove') {
		const id = payloadString(action, 'id');
		next.tools.restorePoints = next.tools.restorePoints.filter(
			(point) => point.id !== id
		);
		return next;
	}
	if (action.tool === 'restore' && action.command === 'rename') {
		const id = payloadString(action, 'id');
		const label = payloadString(action, 'label');
		const point = next.tools.restorePoints.find(
			(candidate) => candidate.id === id
		);
		if (!point || !label) throw new Error('Restore point was not found.');
		point.label = label;
		return next;
	}
	if (action.tool === 'restore' && action.command === 'duplicate') {
		const id = payloadString(action, 'id');
		const label = payloadString(action, 'label');
		const point = next.tools.restorePoints.find(
			(candidate) => candidate.id === id
		);
		if (!point || !label) throw new Error('Restore point was not found.');
		next.tools.restorePoints.unshift({
			...point,
			id: `restore-${now}`,
			label,
			createdAt: now,
			sources: point.sources.map((source) => ({ ...source })),
		});
		return next;
	}
	if (action.tool === 'restore' && action.command === 'restore') {
		const id = payloadString(action, 'id');
		const point = next.tools.restorePoints.find(
			(candidate) => candidate.id === id
		);
		if (!point) {
			throw new Error('Restore point was not found.');
		}
		const sourceIds = Array.isArray(action.payload.sourceIds)
			? new Set(
					action.payload.sourceIds.filter(
						(value): value is string => typeof value === 'string'
					)
				)
			: new Set(point.sources.map((source) => source.id));
		next.tools.restoreReceipts.unshift({
			id: `restore-receipt-${now}`,
			pointId: point.id,
			pointLabel: point.label,
			startedAt: now,
			completedAt: now + 75,
			status: 'complete',
			sourceResults: point.sources
				.filter((source) => sourceIds.has(source.id))
				.map((source) => ({
					sourceId: source.id,
					sourceTitle: source.title,
					preflight: 'passed',
					apply: 'succeeded',
					rollback: 'not-needed',
				})),
		});
		next.tools.diagnostics.unshift({
			id: `diag-restore-${now}`,
			at: now,
			level: 'info',
			scope: 'restore',
			message: `Restored explicit developer state from ${id}.`,
		});
		return next;
	}
	if (action.tool === 'scenarios' && action.command === 'execute') {
		if (next.tools.scenarioRuntime.active) {
			throw new Error('Undo the active scenario before running another one.');
		}
		const id = payloadString(action, 'id');
		const scenario = next.tools.scenarios.find(
			(candidate) => candidate.id === id
		);
		if (
			!scenario ||
			action.payload.version !== scenario.version ||
			action.payload.definitionToken !== scenario.definitionToken
		) {
			throw new Error(
				'The scenario definition changed after confirmation. Review it and try again.'
			);
		}
		const receiptId = `scenario-receipt-${now}`;
		next.tools.scenarioRuntime = {
			running: false,
			active: {
				receiptId,
				scenarioId: scenario.id,
				scenarioVersion: scenario.version,
				scenarioName: scenario.name,
				activatedAt: now,
				stepCount: scenario.steps.length,
				privileged: false,
				warnings: [],
				recoveryRequired: false,
			},
		};
		next.tools.scenarioReceipts.unshift({
			id: receiptId,
			scenarioId: scenario.id,
			scenarioVersion: scenario.version,
			scenarioName: scenario.name,
			startedAt: now,
			completedAt: now + 80,
			status: 'complete',
			stepResults: scenario.steps.map((step) => ({
				stepId: step.id,
				stepType: step.type,
				label: step.label ?? step.id,
				preflight: 'passed',
				apply: 'succeeded',
				rollback: 'not-needed',
				reversible: true,
			})),
		});
		return next;
	}
	if (action.tool === 'scenarios' && action.command === 'undo') {
		const active = next.tools.scenarioRuntime.active;
		if (!active) {
			throw new Error('No scenario is active.');
		}
		if (action.payload.receiptId !== active.receiptId) {
			throw new Error(
				'The active scenario changed after confirmation. Review it and try again.'
			);
		}
		next.tools.scenarioRuntime = { running: false };
		return next;
	}
	if (action.tool === 'scenarios' && action.command === 'remove') {
		const id = payloadString(action, 'id');
		const scenario = next.tools.scenarios.find(
			(candidate) => candidate.id === id
		);
		if (
			!scenario ||
			scenario.bundled ||
			action.payload.version !== scenario.version ||
			action.payload.definitionToken !== scenario.definitionToken
		) {
			throw new Error('Only user scenarios can be removed.');
		}
		next.tools.scenarios = next.tools.scenarios.filter(
			(candidate) => candidate.id !== id
		);
		return next;
	}
	if (action.tool === 'scenarios' && action.command === 'import') {
		const json = payloadString(action, 'json');
		if (!json) throw new Error('Scenario document is required.');
		const imported = importedDemoScenarios(
			next.tools.scenarios,
			json,
			action.payload.mode
		);
		next.tools.scenarios = [...imported];
		next.tools.diagnostics.unshift({
			id: `diag-scenario-import-${now}`,
			at: now,
			level: 'info',
			scope: 'scenarios',
			message: `Imported user scenario document in ${String(action.payload.mode)} mode.`,
		});
		return next;
	}
	if (action.tool === 'identity' && action.command === 'start') {
		if (next.tools.scenarioRuntime.active) {
			throw new Error(
				'Undo the active scenario before changing its test identity.'
			);
		}
		const personaId = payloadString(action, 'personaId');
		const persona = next.tools.identitySession.personas.find(
			(candidate) => candidate.id === personaId
		);
		if (!persona) throw new Error('Test identity was not found.');
		const previous = next.tools.identitySession.active;
		if (previous?.target.personaId === persona.id) return next;
		if (previous) {
			next.tools.identitySession.history =
				next.tools.identitySession.history.map((entry) =>
					entry.id === previous.historyId
						? { ...entry, stoppedAt: now, status: 'stopped' as const }
						: entry
				);
		}
		const actor = previous?.actor ?? {
			kind: 'account' as const,
			label: 'Original account',
		};
		const target = {
			kind: 'persona' as const,
			label: persona.label,
			personaId: persona.id,
		};
		const historyId = `identity-${now}`;
		next.tools.identitySession.active = {
			historyId,
			startedAt: now,
			actor,
			target,
			status: 'active',
		};
		next.tools.identitySession.history = [
			{
				id: historyId,
				startedAt: now,
				actor,
				target,
				status: 'active' as const,
			},
			...next.tools.identitySession.history,
		].slice(0, 20);
		return next;
	}
	if (action.tool === 'identity' && action.command === 'stop') {
		if (next.tools.scenarioRuntime.active) {
			throw new Error('Undo the active scenario to restore its test identity.');
		}
		const active = next.tools.identitySession.active;
		if (!active) throw new Error('No test identity is active.');
		next.tools.identitySession.history = next.tools.identitySession.history.map(
			(entry) =>
				entry.id === active.historyId
					? { ...entry, stoppedAt: now, status: 'stopped' as const }
					: entry
		);
		next.tools.identitySession.active = undefined;
		return next;
	}
	if (action.tool === 'performance' && action.command === 'start') {
		next.tools.performance = {
			isActive: true,
			startedAt: now,
			stoppedAt: null,
			droppedSampleCount: 0,
			samples: [],
			summary: summarizePerformance([], now, now),
		};
		return next;
	}
	if (action.tool === 'performance' && action.command === 'stop') {
		next.tools.performance.isActive = false;
		next.tools.performance.stoppedAt = now;
		next.tools.performance.summary = summarizePerformance(
			next.tools.performance.samples,
			next.tools.performance.startedAt,
			now
		);
		return next;
	}
	if (action.tool === 'components' && action.command === 'refresh') {
		next.tools.diagnostics.unshift({
			id: `diag-components-${now}`,
			at: now,
			level: 'debug',
			scope: 'components',
			message: `Refreshed ${next.tools.components.length} explicit component targets.`,
		});
		return next;
	}
	if (action.tool === 'components' && action.command === 'highlight') {
		const id = payloadString(action, 'id');
		const target = next.tools.components.find(
			(candidate) => candidate.id === id
		);
		if (!target?.isFocused) {
			throw new Error('Component target is not currently visible.');
		}
		next.tools.diagnostics.unshift({
			id: `diag-components-highlight-${now}`,
			at: now,
			level: 'info',
			scope: 'components',
			message: `Highlighted ${target.name} on the simulated device.`,
		});
		return next;
	}
	if (action.tool === 'zustand' && action.command === 'refresh') {
		next.tools.diagnostics.unshift({
			id: `diag-zustand-${now}`,
			at: now,
			level: 'debug',
			scope: 'zustand',
			message: `Refreshed ${next.tools.zustandStores.length} explicit Zustand projections.`,
		});
		for (const store of next.tools.zustandStores) store.updatedAt = now;
		return next;
	}
	if (action.tool === 'zustand' && action.command === 'capture') {
		const storeId = payloadString(action, 'storeId');
		const store = next.tools.zustandStores.find(
			(candidate) => candidate.id === storeId
		);
		if (!store?.capabilities.restorable) {
			throw new Error('Store has no complete rollback adapter.');
		}
		next.tools.zustandStateSnapshots.push({
			id: `zustand-state-${action.actionId}`,
			storeId: store.id,
			storeTitle: store.title,
			createdAt: now,
			stateText: store.stateText,
			stateBytes: new TextEncoder().encode(store.stateText).byteLength,
			truncated: false,
		});
		return next;
	}
	if (action.tool === 'zustand' && action.command === 'patch') {
		const storeId = payloadString(action, 'storeId');
		const patchText = payloadString(action, 'patchText');
		const store = next.tools.zustandStores.find(
			(candidate) => candidate.id === storeId
		);
		if (!store?.capabilities.restorable || !patchText) {
			throw new Error('Store does not accept reversible patches.');
		}
		const current: unknown = JSON.parse(store.stateText);
		const patch: unknown = JSON.parse(patchText);
		if (
			!current ||
			typeof current !== 'object' ||
			Array.isArray(current) ||
			!patch ||
			typeof patch !== 'object' ||
			Array.isArray(patch)
		) {
			throw new Error('Patch and projected state must be JSON objects.');
		}
		const changedKeys = Object.keys(patch);
		const previousText = store.stateText;
		store.stateText = JSON.stringify({ ...current, ...patch }, null, 2);
		store.keys = Object.keys(JSON.parse(store.stateText));
		store.updatedAt = now;
		const snapshotId = `zustand-state-after-${action.actionId}`;
		next.tools.zustandStateSnapshots.push({
			id: `zustand-state-before-${action.actionId}`,
			storeId: store.id,
			storeTitle: store.title,
			createdAt: now,
			stateText: previousText,
			stateBytes: new TextEncoder().encode(previousText).byteLength,
			truncated: false,
		});
		next.tools.zustandStateSnapshots.push({
			id: snapshotId,
			storeId: store.id,
			storeTitle: store.title,
			createdAt: now,
			stateText: store.stateText,
			stateBytes: new TextEncoder().encode(store.stateText).byteLength,
			truncated: false,
		});
		next.tools.zustandMutationReceipts.push({
			id: `zustand-mutation-${action.actionId}`,
			storeId: store.id,
			kind: 'patch',
			status: 'succeeded',
			startedAt: now,
			completedAt: now,
			changedKeys,
			correlationId: action.actionId,
			snapshotId,
		});
		next.tools.zustandChanges.push({
			id: `zustand-change-${action.actionId}`,
			at: now,
			storeId: store.id,
			storeTitle: store.title,
			changedKeys,
			stateText: store.stateText,
		});
		return next;
	}
	if (action.tool === 'zustand' && action.command === 'jump') {
		const storeId = payloadString(action, 'storeId');
		const snapshotId = payloadString(action, 'snapshotId');
		const store = next.tools.zustandStores.find(
			(candidate) => candidate.id === storeId
		);
		const snapshot = next.tools.zustandStateSnapshots.find(
			(candidate) =>
				candidate.id === snapshotId && candidate.storeId === storeId
		);
		if (!store?.capabilities.restorable || !snapshot) {
			throw new Error('State snapshot is unavailable for this store.');
		}
		const previous = JSON.parse(store.stateText) as Record<string, unknown>;
		const restored = JSON.parse(snapshot.stateText) as Record<string, unknown>;
		store.stateText = snapshot.stateText;
		store.keys = Object.keys(restored);
		store.updatedAt = now;
		const changedKeys = [
			...new Set([...Object.keys(previous), ...Object.keys(restored)]),
		]
			.filter(
				(key) => JSON.stringify(previous[key]) !== JSON.stringify(restored[key])
			)
			.sort();
		next.tools.zustandMutationReceipts.push({
			id: `zustand-mutation-${action.actionId}`,
			storeId: store.id,
			kind: 'jump',
			status: 'succeeded',
			startedAt: now,
			completedAt: now,
			changedKeys,
			correlationId: action.actionId,
			snapshotId: snapshot.id,
		});
		next.tools.zustandChanges.push({
			id: `zustand-change-${action.actionId}`,
			at: now,
			storeId: store.id,
			storeTitle: store.title,
			changedKeys,
			stateText: store.stateText,
		});
		return next;
	}

	throw new Error(`Unsupported demo action: ${action.tool}.${action.command}`);
}

export function tickDemoDevice(
	device: DeviceSession,
	now = Date.now()
): DeviceSession {
	const next = structuredClone(device);
	next.lastSeenAt = now;
	next.sequence += 1;
	const review = next.tools.performance;
	if (review.isActive) {
		const index = review.samples.length;
		const lag = index % 19 === 0 ? 41 : 3 + ((index * 5) % 9);
		review.samples.push({
			id: `perf-live-${now}`,
			at: now,
			jsFps: lag > 30 ? 45 : 58 + (index % 3),
			uiFps: lag > 30 ? 52 : 60,
			cpuPercent: lag > 30 ? 44 : 18 + (index % 10),
			memoryMb: 198 + index * 0.08,
			eventLoopLagMs: lag,
			longFrames: lag > 30 ? 2 : 0,
			maxFrameMs: lag > 30 ? 58 : 18 + (index % 5),
			route:
				next.tools.routes.find((route) => route.isCurrent)?.path ?? '/(tabs)',
		});
		const omitted = Math.max(0, review.samples.length - 1_500);
		review.samples = review.samples.slice(-1_500);
		review.droppedSampleCount += omitted;
		review.summary = summarizePerformance(
			review.samples,
			review.startedAt,
			now
		);
	}
	return next;
}

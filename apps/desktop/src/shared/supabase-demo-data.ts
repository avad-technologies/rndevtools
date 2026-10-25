import {
	applySupabasePolicyPatch,
	checkSupabaseOperation,
	formatSupabaseSize,
	isSupabaseStackRunning,
	SUPABASE_DEFAULT_EXCLUSIONS,
	SUPABASE_POLICY_DEFAULTS,
	type SupabaseActivityEntry,
	type SupabaseAgentRequest,
	type SupabaseConfirmationResult,
	type SupabaseDatabasePayload,
	type SupabaseHold,
	type SupabaseInspection,
	type SupabaseJob,
	type SupabaseLogRecord,
	type SupabaseOperation,
	type SupabaseOperationReceipt,
	type SupabaseRepositorySummary,
	type SupabaseStackSummary,
	type SupabaseState,
	supabaseDesktopError,
	supabaseHeadMatches,
	supabaseHoldMatches,
	supabaseStackTitle,
	supabaseTrafficSignature,
} from './supabase-protocol';

/**
 * Deterministic demo state for the Supabase tab (demo set A from the UI
 * spec): ten stacks across three repositories, one agent destroy request and
 * one job, with `example.com`-style data only. The reducer applies any
 * operation to it with no processes, so e2e can drive every control. Nothing
 * here is a real key, password or database URL.
 */

/** 2026-10-17 14:03:05 UTC: the moment the demo state describes. */
export const SUPABASE_DEMO_NOW = 1_792_245_785_000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MB = 1_024 * 1_024;
const GB = 1_024 * MB;

/** Ids used by the demo, for tests and e2e. */
export const SUPABASE_DEMO_IDS = Object.freeze({
	legacyMain:
		'e0c4a7b11611f0cc166827c89200007cae3e8bfb7ae9c0dfdf254787d8bf9d22',
	fixAuthRedirect:
		'b8f2d6e92e6f6d662e52a0df24529c6062baeff31901576e8c22097f17ed07a1',
	featCheckout:
		'64616c83912c48442ec266f86ee2d7f004d2be5c8b7f31a6d6b4c2634f82145f',
	featPayments:
		'9a0b2c7d70d453d6c4d4985dc1fb18098b2f6439a1334d687d2600e6ba4de41a',
	main: '1f6e3a90e36703ebd37c00722f5891d28b0e2811dc114b129215123adccec58b',
	featOldUi: 'd3a9e5f2191c95dc03588f1726b870d6ccd26ceb6329e1c70193fb3690146b10',
	featSearch:
		'47c1b0decd0d19663ced3c726cb06097c635cdb218d8e80057055b833b37a3f9',
	featGone: '5e8d2c4a0dd56d5dbdb7ff75a690bcd42da7565efd8b89a10228ee09a5161f07',
	unreadable:
		'c41d0e770b1f352b33853bf17e408ba64e0b14423d4f7137a20906ed2e588e2c',
	featOnboarding:
		'a51c6e2f1ba7e1f9f193306137aadb77da46944564b77b6289aa807d3ead3d07',
	repositoryApp: 'repo-dad429621166',
	repositoryAdmin: 'repo-1e2ef31faec5',
	repositorySite: 'repo-355f588f8df6',
	laneCheckout: 'lane-c69dc564-b12e-45d5-b0d5-3e9d034a072d',
	laneFixAuth: 'lane-d3c29403-e3a7-4bc9-ab44-93684dacbc56',
	simulatorCheckout: '380DAF54-343E-4E1B-BE43-1B116A9D03C4',
	simulatorFixAuth: '2CF8BBD0-469A-4D62-8A03-22BB64DF0460',
	claudeCheckout: '7f3a2c91-4e13-4197-ae82-9220dd39e202',
	codexAbandoned: '5d1b8f40-d3a7-4d59-9404-307007580094',
	codexRequester: '3c9e7a12-2c82-4f9e-8d9e-ecd778e869fc',
	codexSynthetic: 'mcp-codex-mcp-client',
	jobFixAuth: 'supabase-job-86509e6e-884b-4176-93dc-08d486577973',
	requestOldUi: 'supabase-request-75e6b385-095b-43c1-9f93-6fb5f84c85a9',
});

const ids = SUPABASE_DEMO_IDS;
const RUNNER = 'pnpm exec supabase';

function loopback(port: number, path = ''): string {
	return `http://127.0.0.1:${port}${path}`;
}

type StackOverrides = Partial<SupabaseStackSummary> &
	Pick<SupabaseStackSummary, 'id'>;

/** A stopped, managed stack in the example app's repository, then overrides. */
function stack(overrides: StackOverrides): SupabaseStackSummary {
	return compact({
		name: 'default',
		origin: 'managed',
		state: 'stopped',
		ownerLiveness: 'absent',
		lifecycle: null,
		readiness: 'unavailable',
		health: {
			members: 0,
			awake: 0,
			sleeping: 0,
			unhealthy: 0,
			unhealthyServices: [],
			excluded: [...SUPABASE_DEFAULT_EXCLUSIONS],
		},
		runtime: 'native',
		exposure: { verdict: 'unchecked' },
		mode: { value: 'managed' },
		repositoryId: ids.repositoryApp,
		worktreeExists: true,
		ports: {},
		excluded: [...SUPABASE_DEFAULT_EXCLUSIONS],
		studio: { included: false, operatorEnabled: false },
		lanes: [],
		holds: [],
		cwdKeepers: [],
		createdBy: { via: 'lane-up' },
		pinned: false,
		cli: {
			version: '2.121.0',
			gate: 'verified',
			runnerLabel: RUNNER,
			inspectCommand: `${RUNNER} stack status --stack-id ${overrides.id}`,
			statusCommand: `${RUNNER} status`,
		},
		flags: [],
		uploadsInDeletedWorktree: false,
		configDrift: { status: 'unchanged' },
		known: { publishableKey: true, anonKey: true, databaseAddress: false },
		appEnvNames: SUPABASE_POLICY_DEFAULTS.appEnv.map((entry) => entry.name),
		bucketsConfigured: true,
		migrationCount: 14,
		requestIds: [],
		...overrides,
	});
}

function runningHealth(awake: number): SupabaseStackSummary['health'] {
	return {
		members: 7,
		awake,
		sleeping: 7 - awake,
		unhealthy: 0,
		unhealthyServices: [],
		excluded: [...SUPABASE_DEFAULT_EXCLUSIONS],
	};
}

function endpoints(
	api: number
): Pick<
	SupabaseStackSummary,
	'apiUrl' | 'restUrl' | 'functionsUrl' | 'mailpitUrl' | 'ports'
> {
	return {
		apiUrl: loopback(api),
		restUrl: loopback(api, '/rest/v1'),
		functionsUrl: loopback(api, '/functions/v1'),
		mailpitUrl: loopback(api + 5),
		ports: { api, db: api + 2, mail: api + 5 },
	};
}

function running(
	now: number,
	awake: number,
	api: number
): Partial<SupabaseStackSummary> {
	return {
		state: 'running',
		ownerLiveness: 'reachable',
		lifecycle: 'running',
		readiness: 'sleeping',
		health: runningHealth(awake),
		exposure: { verdict: 'loopback', checkedAt: now - 2 * MINUTE },
		known: { publishableKey: true, anonKey: true, databaseAddress: true },
		measuredAt: now - MINUTE,
		lastUsedAt: now - 5_000,
		...endpoints(api),
	};
}

function demoStacks(now: number): SupabaseStackSummary[] {
	return [
		stack({
			id: ids.legacyMain,
			origin: 'external',
			runtime: 'docker',
			exposure: { verdict: 'lan-exposed', checkedAt: now - 10 * MINUTE },
			mode: {
				value: 'observed',
				reasonText: "its repository isn't tracked in Lanes",
			},
			repositoryId: undefined,
			worktreeLabel: '~/code/example-legacy',
			projectRootLabel: '~/code/example-legacy',
			branchContext: 'refs/heads/legacy-main',
			currentHead: { ref: 'refs/heads/legacy-main' },
			health: { ...runningHealth(0), members: 0, sleeping: 0, excluded: [] },
			excluded: [],
			createdBy: { via: 'outside' },
			cli: { gate: 'missing' },
			flags: ['lan-exposed'],
			diskBytes: 88 * MB,
			known: { publishableKey: false, anonKey: false, databaseAddress: false },
			appEnvNames: [],
			bucketsConfigured: false,
			migrationCount: 0,
			lastUsedAt: now - 3 * DAY,
		}),
		stack({
			id: ids.fixAuthRedirect,
			state: 'starting',
			ownerLiveness: 'starting',
			lifecycle: 'starting',
			readiness: 'starting',
			worktreeLabel: '~/code/example-app-wt/fix-auth-redirect',
			projectRootLabel: '~/code/example-app-wt/fix-auth-redirect',
			branchContext: 'refs/heads/fix-auth-redirect',
			currentHead: {
				ref: 'refs/heads/fix-auth-redirect',
				stableSince: now - 3 * HOUR,
			},
			...endpoints(23_310),
			lanes: [
				{
					laneId: ids.laneFixAuth,
					simulatorUdid: ids.simulatorFixAuth,
					simulatorLabel: 'iPhone 17',
					port: 8_106,
					environment: 'development',
					metro: 'starting',
					needsMetroRestart: false,
				},
			],
			holds: [
				{
					holder: 'lane',
					laneId: ids.laneFixAuth,
					since: now - 2_000,
					live: true,
				},
			],
			createdBy: { via: 'lane-up', laneId: ids.laneFixAuth, at: now - 2 * DAY },
			diskBytes: 58 * MB,
			activeJobId: ids.jobFixAuth,
			lastUsedAt: now - 2 * DAY,
		}),
		stack({
			id: ids.featCheckout,
			...running(now, 2, 21_734),
			worktreeLabel: '~/code/example-app-wt/feat-checkout',
			projectRootLabel: '~/code/example-app-wt/feat-checkout',
			branchContext: 'refs/heads/feat-checkout',
			currentHead: {
				ref: 'refs/heads/feat-checkout',
				stableSince: now - 2 * HOUR,
			},
			lanes: [
				{
					laneId: ids.laneCheckout,
					simulatorUdid: ids.simulatorCheckout,
					simulatorLabel: 'iPhone 17 Pro',
					port: 8_102,
					environment: 'development',
					metro: 'ready',
					needsMetroRestart: false,
				},
			],
			holds: [
				{
					holder: 'lane',
					laneId: ids.laneCheckout,
					agent: {
						kind: 'claude',
						sessionId: ids.claudeCheckout,
						synthetic: false,
					},
					since: now - 2 * HOUR,
					live: true,
				},
				{
					holder: 'session',
					agent: {
						kind: 'codex',
						sessionId: ids.codexAbandoned,
						synthetic: false,
					},
					since: now - HOUR,
					live: false,
					abandonedSince: now - 3 * MINUTE,
					releaseAt: now + 7 * MINUTE,
				},
			],
			createdBy: {
				via: 'lane-up',
				agent: { kind: 'claude', sessionId: ids.claudeCheckout },
				laneId: ids.laneCheckout,
				at: now - 2 * HOUR,
			},
			diskBytes: 64 * MB,
			uploadsBytes: 2 * MB,
			memoryBytes: 180 * MB,
		}),
		stack({
			id: ids.featPayments,
			...running(now, 1, 24_410),
			worktreeLabel: '~/code/example-app-wt/feat-payments',
			projectRootLabel: '~/code/example-app-wt/feat-payments',
			branchContext: 'refs/heads/feat-payments',
			currentHead: {
				ref: 'refs/heads/feat-payments',
				stableSince: now - 5 * HOUR,
			},
			holds: [
				{
					holder: 'worktree',
					agent: {
						kind: 'codex',
						sessionId: ids.codexSynthetic,
						synthetic: true,
					},
					since: now - 3 * HOUR,
					live: true,
				},
			],
			createdBy: {
				via: 'agent-up',
				agent: { kind: 'codex', sessionId: ids.codexSynthetic },
				at: now - 3 * HOUR,
			},
			diskBytes: 52 * MB,
			memoryBytes: 160 * MB,
		}),
		stack({
			id: ids.main,
			...running(now, 1, 22_990),
			worktreeLabel: '~/code/example-app',
			projectRootLabel: '~/code/example-app',
			branchContext: 'refs/heads/main',
			currentHead: { ref: 'refs/heads/main', stableSince: now - 3 * DAY },
			holds: [{ holder: 'operator', since: now - DAY, live: true }],
			pinned: true,
			createdBy: { via: 'operator', at: now - 5 * DAY },
			diskBytes: 58 * MB,
			memoryBytes: 165 * MB,
		}),
		stack({
			id: ids.featOldUi,
			worktreeLabel: '~/code/example-app-wt/old-ui',
			projectRootLabel: '~/code/example-app-wt/old-ui',
			branchContext: 'refs/heads/feat-old-ui',
			currentHead: {
				ref: 'refs/heads/feat-nav-v2',
				stableSince: now - 20 * MINUTE,
			},
			...endpoints(26_211),
			flags: ['stale-branch'],
			pruneGroup: 'stale-branch',
			pruneSuggestedAt: now - 20 * MINUTE,
			diskBytes: 71 * MB,
			requestIds: [ids.requestOldUi],
			createdBy: { via: 'lane-up', at: now - 6 * DAY },
			lastUsedAt: now - DAY,
		}),
		stack({
			id: ids.featSearch,
			worktreeLabel: '~/code/example-app-wt/feat-search',
			projectRootLabel: '~/code/example-app-wt/feat-search',
			branchContext: 'refs/heads/feat-search',
			currentHead: { ref: 'refs/heads/feat-search' },
			...endpoints(27_402),
			flags: ['prune-suggested'],
			pruneGroup: 'retention',
			pruneSuggestedAt: now - 2 * DAY,
			diskBytes: 44 * MB,
			createdBy: { via: 'lane-up', at: now - 20 * DAY },
			lastUsedAt: now - 16 * DAY,
		}),
		stack({
			id: ids.featGone,
			worktreeLabel: '~/code/example-app-wt/feat-gone',
			projectRootLabel: '~/code/example-app-wt/feat-gone',
			branchContext: 'refs/heads/feat-gone',
			worktreeExists: false,
			...endpoints(28_840),
			flags: ['worktree-deleted', 'orphaned'],
			pruneGroup: 'worktree-deleted',
			pruneSuggestedAt: now - HOUR,
			diskBytes: 64 * MB,
			uploadsInDeletedWorktree: true,
			createdBy: { via: 'lane-up', at: now - 4 * DAY },
			lastUsedAt: now - HOUR,
		}),
		stack({
			id: ids.unreadable,
			origin: 'external',
			state: 'unreadable',
			ownerLiveness: 'unknown',
			readiness: null,
			runtime: 'unknown',
			mode: { value: 'observed', reasonText: "its state can't be read" },
			repositoryId: undefined,
			worktreeExists: false,
			health: { ...runningHealth(0), members: 0, sleeping: 0, excluded: [] },
			excluded: [],
			createdBy: { via: 'unknown' },
			cli: { gate: 'missing' },
			pruneGroup: 'unreadable',
			diskBytes: 12 * MB,
			known: { publishableKey: false, anonKey: false, databaseAddress: false },
			appEnvNames: [],
			bucketsConfigured: false,
			migrationCount: 0,
			stackFolderExists: true,
		}),
		stack({
			id: ids.featOnboarding,
			origin: 'expected',
			state: 'not-created',
			runtime: 'unknown',
			worktreeLabel: '~/code/example-app-wt/feat-onboarding',
			projectRootLabel: '~/code/example-app-wt/feat-onboarding',
			branchContext: 'refs/heads/feat-onboarding',
			currentHead: {
				ref: 'refs/heads/feat-onboarding',
				stableSince: now - DAY,
			},
			createdBy: { via: 'unknown' },
			configDrift: { status: 'unavailable' },
			known: { publishableKey: false, anonKey: false, databaseAddress: false },
			migrationCount: 3,
		}),
	];
}

function demoRepositories(now: number): SupabaseRepositorySummary[] {
	const worktree = (
		pathLabel: string,
		branch: string,
		stackId?: string,
		extra: Partial<SupabaseRepositorySummary['worktrees'][number]> = {}
	): SupabaseRepositorySummary['worktrees'][number] => ({
		pathLabel,
		branch,
		mode: 'managed',
		...(stackId === undefined ? {} : { stackId }),
		...extra,
	});
	return [
		{
			id: ids.repositoryApp,
			label: '~/code/example-app',
			appPathLabel: 'apps/mobile',
			readiness: 'needs-fix',
			mode: 'auto',
			counts: { worktrees: 9, managed: 7, observed: 2, running: 3 },
			cli: { version: '2.121.0', gate: 'verified', runnerLabel: RUNNER },
			checks: [
				{
					id: 'platform',
					status: 'ready',
					summary: 'Apple silicon · macOS 15.1',
				},
				{
					id: 'stack-flag',
					status: 'needs-fix',
					summary: 'Missing in feat-legal-copy, spike-maps.',
					fix: {
						text: 'Add it to supabase/config.toml:',
						snippet: '[experimental]\nstack = true',
					},
				},
				{
					id: 'config-json',
					status: 'ready',
					summary: 'None (no conflicting supabase/config.json)',
				},
				{
					id: 'pinned-ports',
					status: 'needs-fix',
					summary: 'spike-maps pins a port another stack needs.',
					lines: [
						{
							file: 'supabase/config.toml',
							line: 12,
							text: 'api.port = 54321',
						},
					],
					fix: {
						text: 'Delete these lines. Only one stack at a time can use a pinned port; the others fail to start.',
					},
				},
				{
					id: 'cli',
					status: 'ready',
					summary: `2.121.0 · verified · ${RUNNER}`,
				},
				{
					id: 'app-env-files',
					status: 'check',
					summary: 'apps/mobile/.env.local:3 shadows a mapped name',
					lines: [
						{
							file: 'apps/mobile/.env.local',
							line: 3,
							text: 'EXPO_PUBLIC_SUPABASE_URL=…',
						},
					],
				},
				{
					id: 'recommended',
					status: 'optional',
					summary: 'Disable Studio and analytics for every worktree',
					fix: {
						text: 'Add to supabase/config.toml:',
						snippet: '[studio]\nenabled = false\n[analytics]\nenabled = false',
					},
				},
			],
			worktrees: [
				worktree('~/code/example-app', 'main', ids.main),
				worktree(
					'~/code/example-app-wt/feat-checkout',
					'feat-checkout',
					ids.featCheckout
				),
				worktree(
					'~/code/example-app-wt/fix-auth-redirect',
					'fix-auth-redirect',
					ids.fixAuthRedirect
				),
				worktree(
					'~/code/example-app-wt/feat-payments',
					'feat-payments',
					ids.featPayments
				),
				worktree('~/code/example-app-wt/old-ui', 'feat-nav-v2', undefined, {
					reasonText: 'was feat-old-ui',
				}),
				worktree(
					'~/code/example-app-wt/feat-search',
					'feat-search',
					ids.featSearch
				),
				worktree(
					'~/code/example-app-wt/feat-onboarding',
					'feat-onboarding',
					ids.featOnboarding
				),
				worktree(
					'~/code/example-app-wt/feat-legal-copy',
					'feat-legal-copy',
					undefined,
					{
						mode: 'observed',
						reasonText: 'stack flag missing',
					}
				),
				worktree('~/code/example-app-wt/spike-maps', 'spike-maps', undefined, {
					mode: 'observed',
					reasonText: 'ports pinned',
				}),
			],
			checkedAt: now - MINUTE,
		},
		{
			id: ids.repositoryAdmin,
			label: '~/code/example-admin',
			readiness: 'observed',
			mode: 'auto',
			counts: { worktrees: 1, managed: 0, observed: 1, running: 0 },
			cli: { version: '2.122.0', gate: 'unsupported', runnerLabel: RUNNER },
			checks: [
				{
					id: 'platform',
					status: 'ready',
					summary: 'Apple silicon · macOS 15.1',
				},
				{
					id: 'stack-flag',
					status: 'ready',
					summary: 'Set in every worktree.',
				},
				{
					id: 'cli',
					status: 'needs-fix',
					summary: "2.122.0 isn't verified for RN Devtools",
					fix: {
						text: 'Pin supabase to 2.121.0 as an exact devDependency.',
					},
				},
			],
			worktrees: [
				worktree('~/code/example-admin', 'main', undefined, {
					mode: 'observed',
					reasonText: "Supabase CLI 2.122.0 isn't verified",
				}),
			],
			checkedAt: now - MINUTE,
		},
		{
			id: ids.repositorySite,
			label: '~/code/example-site',
			readiness: 'no-supabase',
			mode: 'auto',
			counts: { worktrees: 1, managed: 0, observed: 0, running: 0 },
			cli: {},
			checks: [
				{
					id: 'project',
					status: 'optional',
					summary: 'No supabase/config.toml in this repository.',
				},
			],
			worktrees: [
				worktree('~/code/example-site', 'main', undefined, {
					mode: 'off',
					reasonText: 'no supabase/config.toml',
				}),
			],
			checkedAt: now - MINUTE,
		},
	];
}

function demoRequests(now: number): SupabaseAgentRequest[] {
	return [
		{
			id: ids.requestOldUi,
			kind: 'destroy',
			status: 'pending',
			requester: {
				kind: 'codex',
				sessionId: ids.codexRequester,
				live: true,
				synthetic: false,
			},
			stackId: ids.featOldUi,
			branch: 'feat-old-ui',
			sizeBytes: 71 * MB,
			createdAt: now - 4 * MINUTE,
			expiresAt: now + 26 * MINUTE,
			note: 'Fresh database for the migration test.',
			otherHolders: [],
		},
	];
}

function demoJobs(now: number): SupabaseJob[] {
	return [
		{
			id: ids.jobFixAuth,
			kind: 'resume',
			stackIds: [ids.fixAuthRedirect],
			status: 'running',
			steps: [
				{
					id: 'room',
					label: 'Check room · 3 of 12 running · 26 Postgres slots free',
					state: 'done',
				},
				{ id: 'database', label: 'Start the database', state: 'current' },
				{
					id: 'verify',
					label: 'Verify it listens only on 127.0.0.1',
					state: 'pending',
				},
				{ id: 'attach', label: 'Attach to lane :8106', state: 'pending' },
			],
			latestLine: 'Starting local Supabase stack...',
			startedAt: now - 2_000,
			updatedAt: now - 500,
			expectedMs: 5_000,
			cancellable: true,
			requestedBy: { kind: 'lane', laneId: ids.laneFixAuth },
		},
	];
}

function demoActivity(now: number): SupabaseActivityEntry[] {
	return [
		{
			id: 'activity-1',
			kind: 'create',
			stackIds: [ids.featCheckout],
			outcome: 'complete',
			startedAt: now - 2 * HOUR,
			durationMs: 4_500,
			requestedBy: 'lane',
		},
		{
			id: 'activity-2',
			kind: 'resume',
			stackIds: [ids.featPayments],
			outcome: 'complete',
			startedAt: now - 3 * HOUR,
			durationMs: 1_000,
			requestedBy: 'agent',
		},
		{
			id: 'activity-3',
			kind: 'create',
			stackIds: [ids.main],
			outcome: 'complete',
			startedAt: now - 5 * DAY,
			durationMs: 42_600,
			requestedBy: 'operator',
			coldCache: true,
		},
		{
			id: 'activity-4',
			kind: 'stop',
			stackIds: [ids.featGone],
			outcome: 'complete',
			startedAt: now - HOUR,
			durationMs: 3_200,
			requestedBy: 'automatic',
		},
	];
}

export type SupabaseDemoVariant = 'full' | 'off' | 'unsupported' | 'empty';

/**
 * The demo state. `off` and `unsupported` keep the platform verdict and
 * nothing else; `empty` is on with no stacks.
 */
export function createSupabaseDemoState(
	options: Readonly<{ now?: number; variant?: SupabaseDemoVariant }> = {}
): SupabaseState {
	const now = options.now ?? SUPABASE_DEMO_NOW;
	const variant = options.variant ?? 'full';
	const stacks = variant === 'full' ? demoStacks(now) : [];
	const base: SupabaseState = {
		revision: 1,
		updatedAt: now,
		source: 'demo',
		availability: {
			platform:
				variant === 'unsupported'
					? {
							supported: false,
							arch: 'x64',
							macosVersion: '13.6',
							reasonText:
								'Native Supabase needs Apple silicon and macOS 14 or later.',
						}
					: { supported: true, arch: 'arm64', macosVersion: '15.1' },
		},
		feature: {
			enabled: variant === 'full' || variant === 'empty',
			...(variant === 'full' || variant === 'empty'
				? { acknowledgedAt: now - DAY }
				: {}),
			policyHealth: 'ok',
		},
		discovery: {
			status: variant === 'full' || variant === 'empty' ? 'live' : 'off',
			...(variant === 'full' ? { lastListAt: now - 30_000 } : {}),
			sessions: 'ok',
		},
		capacity: {
			running: 0,
			starting: 0,
			queued: 0,
			cap: 12,
			derivedCap: 12,
			sysv: variant === 'full' ? { used: 6, limit: 32 } : null,
			memoryPressure: variant === 'full' ? 'normal' : 'unknown',
		},
		footprint:
			variant === 'full'
				? {
						mode: 'measured',
						bytes: Math.round(1.2 * GB),
						measuredAt: now - 5_000,
						awake: 1,
						idle: 2,
					}
				: { mode: 'estimate', bytes: 0, awake: 0, idle: 0 },
		disk:
			variant === 'full'
				? {
						stacksBytes: 412 * MB,
						uploadsBytes: 2 * MB,
						cacheBytes: Math.round(1.7 * GB),
						cacheState: 'warm',
						measuredAt: now - 10 * MINUTE,
					}
				: { cacheState: 'unknown' },
		home: { label: '~/.supabase' },
		engines: { docker: 'found', podman: 'absent' },
		policy: {
			...SUPABASE_POLICY_DEFAULTS,
			repositories:
				variant === 'full'
					? [
							{ id: ids.repositoryApp, mode: 'auto' },
							{ id: ids.repositoryAdmin, mode: 'auto' },
						]
					: [],
		},
		stacks,
		repositories: variant === 'full' ? demoRepositories(now) : [],
		requests: variant === 'full' ? demoRequests(now) : [],
		jobs: variant === 'full' ? demoJobs(now) : [],
		prune: {
			revision: 3,
			computedAt: now - 30_000,
			groups: [],
			notSuggested: {
				held: 0,
				pinned: 0,
				starting: 0,
				external: 0,
				running: 0,
			},
			...(variant === 'full'
				? {
						lastResult: {
							at: now - 2 * DAY,
							destroyed: 2,
							failed: 0,
							freedBytes: 120 * MB,
						},
					}
				: {}),
		},
		transientCount: 0,
		notices: {
			containerStacks: variant === 'full' ? [ids.legacyMain] : [],
		},
		trafficSignature: supabaseTrafficSignature([]),
		activity: variant === 'full' ? demoActivity(now) : [],
	};
	return derive(base, false);
}

// ---------------------------------------------------------------------------
// Derived fields

const PRUNE_ORDER = [
	'worktree-deleted',
	'stale-branch',
	'retention',
	'failed-start',
	'unreadable',
] as const;

function isManaged(stack: SupabaseStackSummary): boolean {
	return stack.origin === 'managed' || stack.origin === 'adopted';
}

/**
 * Why each stack outside clean up is not suggested, one reason per stack:
 * starting, then pinned, held, external, running.
 */
function notSuggested(
	stacks: readonly SupabaseStackSummary[]
): SupabaseState['prune']['notSuggested'] {
	const counts = { held: 0, pinned: 0, starting: 0, external: 0, running: 0 };
	for (const stack of stacks) {
		if (stack.state === 'starting') counts.starting += 1;
		else if (stack.pinned) counts.pinned += 1;
		else if (stack.holds.some((hold) => hold.live)) counts.held += 1;
		else if (stack.origin === 'external') counts.external += 1;
		else if (isSupabaseStackRunning(stack)) counts.running += 1;
	}
	return counts;
}

/** Recomputes capacity, prune groups and the traffic signature from the stacks. */
function derive(state: SupabaseState, bumpPrune: boolean): SupabaseState {
	const stacks = state.stacks;
	const groups = PRUNE_ORDER.flatMap((id) => {
		const members = stacks.filter((stack) => stack.pruneGroup === id);
		if (members.length === 0) return [];
		return [
			{
				id,
				stackIds: members.map((stack) => stack.id),
				bytes: members.reduce(
					(total, stack) => total + (stack.diskBytes ?? 0),
					0
				),
				selectable: id !== 'unreadable',
				preselected: id === 'worktree-deleted' || id === 'failed-start',
			},
		];
	});
	const candidates = new Set(groups.flatMap((group) => group.stackIds));
	const suggestedBytes = groups
		.filter((group) => group.selectable)
		.reduce((total, group) => total + (group.bytes ?? 0), 0);
	const changed =
		JSON.stringify(state.prune.groups.map((group) => group.stackIds)) !==
		JSON.stringify(groups.map((group) => group.stackIds));
	const others = stacks.filter((stack) => !candidates.has(stack.id));
	return {
		...state,
		capacity: {
			...state.capacity,
			running: stacks.filter(
				(stack) => isManaged(stack) && isSupabaseStackRunning(stack)
			).length,
			starting: stacks.filter((stack) => stack.state === 'starting').length,
			queued: state.jobs.filter((job) => job.status === 'queued').length,
		},
		prune: {
			...state.prune,
			revision: state.prune.revision + (bumpPrune && changed ? 1 : 0),
			groups,
			onDiskBytes: stacks.reduce(
				(total, stack) =>
					total + (stack.diskBytes ?? 0) + (stack.uploadsBytes ?? 0),
				0
			),
			suggestedBytes,
			notSuggested: notSuggested(others),
		},
		trafficSignature: supabaseTrafficSignature(
			stacks.flatMap((stack) =>
				stack.ports.api === undefined
					? []
					: [{ port: stack.ports.api, stackId: stack.id }]
			)
		),
	};
}

// ---------------------------------------------------------------------------
// Reducer

/** FNV-1a, stretched to 64 hex characters: deterministic ids for new demo stacks. */
function demoHex(seed: string): string {
	let output = '';
	for (let round = 0; output.length < 64; round += 1) {
		let hash = 0x811c9dc5 ^ round;
		for (const character of `${round}:${seed}`) {
			hash ^= character.codePointAt(0) ?? 0;
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		output += hash.toString(16).padStart(8, '0');
	}
	return output.slice(0, 64);
}

function freePort(state: SupabaseState, seed: string): number {
	const taken = new Set(
		state.stacks.flatMap((stack) =>
			stack.ports.api === undefined
				? []
				: [stack.ports.api, stack.ports.api + 5]
		)
	);
	let port = 20_000 + (Number.parseInt(seed.slice(0, 4), 16) % 12_000);
	while (taken.has(port) || taken.has(port + 5)) port += 10;
	return port;
}

function receiptFor(
	operation: SupabaseOperation,
	fields: Partial<SupabaseOperationReceipt> = {}
): SupabaseOperationReceipt {
	return {
		actionId: operation.actionId,
		kind: operation.kind,
		completed: true,
		...fields,
	};
}

function startedStack(
	state: SupabaseState,
	stack: SupabaseStackSummary,
	now: number,
	operatorHold: boolean
): SupabaseStackSummary {
	const api = stack.ports.api ?? freePort(state, stack.id);
	const holds = stack.holds.filter((hold) => hold.holder !== 'operator');
	const pin = operatorHold && !holds.some((hold) => hold.live);
	return {
		...stack,
		...running(now, 1, api),
		origin: stack.origin === 'expected' ? 'managed' : stack.origin,
		holds: pin
			? [...holds, { holder: 'operator', since: now, live: true }]
			: stack.holds,
		pinned: stack.pinned || pin,
		createdBy:
			stack.origin === 'expected'
				? { via: 'operator', at: now }
				: stack.createdBy,
		flags: stack.flags.filter(
			(flag) =>
				flag !== 'stopped-outside' &&
				flag !== 'exposure-unknown' &&
				flag !== 'prune-suggested'
		),
		lastError: undefined,
		pruneGroup: undefined,
		pruneSuggestedAt: undefined,
		diskBytes: stack.diskBytes ?? 52 * MB,
	};
}

function stoppedStack(stack: SupabaseStackSummary): SupabaseStackSummary {
	return {
		...stack,
		state: 'stopped',
		ownerLiveness: 'absent',
		lifecycle: null,
		readiness: 'unavailable',
		health: { ...stack.health, awake: 0, sleeping: 0, unhealthy: 0 },
		pinned: false,
		holds: stack.holds.filter((hold) => hold.holder !== 'operator'),
		memoryBytes: undefined,
		autoStopAt: undefined,
		autoStopReason: undefined,
		known: { ...stack.known, databaseAddress: false },
	};
}

/** Drops optional fields whose value is `undefined`, so the state stays strict. */
function compact<T extends object>(value: T): T {
	return Object.fromEntries(
		Object.entries(value).filter(([, entry]) => entry !== undefined)
	) as T;
}

function activity(
	state: SupabaseState,
	entry: Omit<SupabaseActivityEntry, 'id'>
): SupabaseActivityEntry[] {
	return [
		...state.activity,
		{ ...entry, id: `activity-${state.revision + 1}` },
	].slice(-64);
}

function demoLogs(now: number): SupabaseLogRecord[] {
	const at = (offset: number) => new Date(now - offset).toISOString();
	const entry = (
		offset: number,
		service: string,
		line: string
	): SupabaseLogRecord => ({
		type: 'entry',
		timestamp: at(offset),
		source: 'history',
		service,
		instanceId: '7c0f4b2e-1d3a-4e5f-8a9b-0c1d2e3f4a5b',
		stream: 'stdout',
		line,
	});
	return [
		{
			type: 'marker',
			timestamp: at(70_000),
			source: 'history',
			service: 'rest',
			instanceId: '7c0f4b2e-1d3a-4e5f-8a9b-0c1d2e3f4a5b',
			kind: 'launch',
		},
		entry(
			67_000,
			'database',
			'LOG: database system is ready to accept connections'
		),
		entry(54_000, 'gateway', 'GET /rest/v1/notes?select=id&limit=1 200 3ms'),
		entry(
			53_000,
			'gateway',
			'GET /rest/v1/notes?select=*&order=created_at.desc 200 6ms'
		),
		entry(25_000, 'auth', 'POST /token?grant_type=[REDACTED] 200 41ms'),
		entry(
			13_000,
			'database',
			'LOG: statement: SELECT id, title FROM public.notes WHERE owner = $1'
		),
		{
			type: 'marker',
			timestamp: at(8_000),
			source: 'history',
			service: 'rest',
			instanceId: '7c0f4b2e-1d3a-4e5f-8a9b-0c1d2e3f4a5b',
			kind: 'lost',
			stream: 'stdout',
			count: 3,
		},
		entry(4_000, 'gateway', 'PATCH /rest/v1/notes?id=eq.42 204 5ms'),
		entry(3_000, 'rest', 'apikey=[REDACTED] role=authenticated'),
	];
}

function demoDatabase(
	stack: SupabaseStackSummary,
	now: number
): SupabaseDatabasePayload {
	const headMatches = supabaseHeadMatches(stack);
	return {
		target: headMatches ? 'local' : 'db-url',
		stats: {
			databaseSize: '11 MB',
			totalIndexSize: '1 MB',
			totalTableSize: '9 MB',
			totalToastSize: '8 kB',
			timeSinceStatsReset: '02:01:12',
			indexHitRate: '0.998',
			tableHitRate: '0.991',
			walSize: '16 MB',
		},
		topTables: [
			{
				name: 'public.notes',
				tableSize: '2.1 MB',
				totalSize: '2.3 MB',
				estimatedRowCount: '1000',
				seqScans: '12',
			},
			{
				name: 'public.profiles',
				tableSize: '48 kB',
				totalSize: '64 kB',
				estimatedRowCount: '42',
				seqScans: '3',
			},
			{
				name: 'storage.objects',
				tableSize: '32 kB',
				totalSize: '48 kB',
				estimatedRowCount: '14',
				seqScans: '1',
			},
		],
		migrations: headMatches
			? {
					comparable: true,
					state: 'pending',
					rows: [
						{
							version: '20261014120000',
							time: '2026-10-14 12:00:00',
							status: 'applied',
						},
						{
							version: '20261015093000',
							time: '2026-10-15 09:30:00',
							status: 'applied',
						},
						{
							version: '20261016090000',
							time: '2026-10-16 09:00:00',
							status: 'pending',
						},
						{
							version: '20261017080000',
							time: '2026-10-17 08:00:00',
							status: 'pending',
						},
					],
					total: 14,
					applied: 12,
					pending: ['20261016090000', '20261017080000'],
					outOfOrder: [],
					missingLocal: [],
				}
			: {
					comparable: false,
					reasonText: `Migration status can't be worked out while the worktree is on ${stack.currentHead?.ref.replace(/^refs\/heads\//, '') ?? 'another branch'}; its migration files belong to that branch.`,
				},
		readAt: now,
	};
}

function updateStacks(
	state: SupabaseState,
	ids: readonly string[],
	update: (stack: SupabaseStackSummary) => SupabaseStackSummary
): SupabaseStackSummary[] {
	const targets = new Set(ids);
	return state.stacks.map((stack) =>
		targets.has(stack.id) ? compact(update(stack)) : stack
	);
}

const DEMO_LIVE_STATES: ReadonlySet<SupabaseStackSummary['state']> = new Set([
	'running',
	'starting',
	'partial',
	'unhealthy',
	'stopping',
]);

/** The services a demo stack runs after the database, in the CLI's order. */
const DEMO_LAZY_SERVICES = [
	'rest',
	'auth',
	'realtime',
	'storage',
	'functions',
	'mail',
] as const;

/** The wake times the live inspection reports (measured, CLI 2.121.0). */
const DEMO_WAKE_HINT_MS: Partial<
	Record<(typeof DEMO_LAZY_SERVICES)[number], number>
> = {
	rest: 400,
	auth: 800,
	realtime: 2_600,
	storage: 1_400,
	functions: 600,
};

/**
 * What a status read would push for the inspected demo stack: the database
 * and the lazy services it doesn't exclude, as many awake as its health
 * says. A stack that isn't running has no services to show.
 */
export function supabaseDemoInspection(
	state: Pick<SupabaseState, 'stacks'>,
	stackId: string,
	now: number
): SupabaseInspection | undefined {
	const stack = state.stacks.find((candidate) => candidate.id === stackId);
	if (!stack || stack.origin === 'expected') return undefined;
	if (!DEMO_LIVE_STATES.has(stack.state)) {
		return {
			stackId,
			status: 'live',
			members: [],
			endpoints: [],
			checkedAt: now,
		};
	}
	const unhealthy = new Set<string>(stack.health.unhealthyServices);
	const lazy = DEMO_LAZY_SERVICES.filter(
		(service) => !stack.excluded.includes(service)
	);
	let awake = Math.max(0, stack.health.awake - 1);
	const members: SupabaseInspection['members'] = [
		{
			service: 'database',
			capability: 'database',
			activation: 'eager',
			state: 'running',
			lifecycle: 'running',
			health: 'healthy',
		},
		...lazy.map((service): SupabaseInspection['members'][number] => {
			if (unhealthy.has(service)) {
				return {
					service,
					capability: service,
					activation: 'lazy',
					state: 'unhealthy',
					lifecycle: 'running',
					health: 'unhealthy',
				};
			}
			const running = awake > 0;
			if (running) awake -= 1;
			const wakeHintMs = running ? undefined : DEMO_WAKE_HINT_MS[service];
			return {
				service,
				capability: service,
				activation: 'lazy',
				state: running ? 'running' : 'sleeping',
				lifecycle: running ? 'running' : 'stopped',
				health: running ? 'healthy' : null,
				...(wakeHintMs === undefined ? {} : { wakeHintMs }),
			};
		}),
	];
	const { api, db, mail } = stack.ports;
	const endpoints: { key: string; port: number }[] = [];
	if (db !== undefined) endpoints.push({ key: 'database.sql', port: db });
	if (api !== undefined) {
		for (const service of lazy) {
			if (service !== 'mail')
				endpoints.push({ key: `${service}.http`, port: api });
		}
	}
	if (mail !== undefined && lazy.includes('mail')) {
		endpoints.push({ key: 'mail.http', port: mail });
	}
	return { stackId, status: 'live', members, endpoints, checkedAt: now };
}

/**
 * Applies one operation to the demo state the way main would, minus every
 * process: availability is checked with the shared rules first, so a
 * refused control is refused here too. Pure; returns a new state.
 */
export function applySupabaseDemoOperation(
	state: SupabaseState,
	operation: SupabaseOperation,
	now: number
): Readonly<{ state: SupabaseState; receipt: SupabaseOperationReceipt }> {
	const check = checkSupabaseOperation(operation, state, {
		bridgeAvailable: true,
		now,
	});
	if (!check.allowed) {
		return {
			state,
			receipt: receiptFor(operation, { completed: false, error: check.error }),
		};
	}
	const done = (
		next: SupabaseState,
		fields: Partial<SupabaseOperationReceipt> = {}
	) => {
		const nextState = derive(
			{ ...next, revision: state.revision + 1, updatedAt: now },
			true
		);
		return {
			state: nextState,
			receipt: receiptFor(operation, { state: nextState, ...fields }),
		};
	};
	const byId = (stackId: string) =>
		state.stacks.find((candidate) => candidate.id === stackId);
	switch (operation.kind) {
		case 'refresh':
			return done({
				...state,
				discovery: { ...state.discovery, lastListAt: now },
			});
		case 'read-logs': {
			const records = demoLogs(now);
			return {
				state,
				receipt: receiptFor(operation, {
					logs: {
						records,
						truncated: false,
						bytes: records.reduce(
							(total, record) =>
								total + (record.type === 'entry' ? record.line.length : 0),
							0
						),
						readAt: now,
					},
				}),
			};
		}
		case 'read-database': {
			const stack = byId(operation.stackId);
			if (!stack) break;
			return {
				state,
				receipt: receiptFor(operation, { database: demoDatabase(stack, now) }),
			};
		}
		case 'start':
		case 'resume-saved':
		case 'recreate': {
			const stack = byId(operation.stackId);
			if (!stack) break;
			const fresh = operation.kind === 'recreate';
			return done(
				{
					...state,
					stacks: updateStacks(state, [stack.id], (current) =>
						startedStack(
							state,
							fresh
								? {
										...current,
										state: 'not-created',
										origin: 'expected',
										flags: current.flags.filter(
											(flag) =>
												flag !== 'stale-branch' && flag !== 'lan-exposed'
										),
										runtime: 'native',
										exposure: { verdict: 'unchecked' },
										ports: {},
									}
								: current,
							now,
							operation.kind === 'start'
						)
					),
					activity: activity(state, {
						kind: fresh || stack.state === 'not-created' ? 'create' : 'resume',
						stackIds: [stack.id],
						outcome: 'complete',
						startedAt: now,
						durationMs: fresh || stack.state === 'not-created' ? 4_500 : 1_000,
						requestedBy: 'operator',
					}),
				},
				{
					message: `${supabaseStackTitle(stack)} is running.`,
				}
			);
		}
		case 'stop':
			return done(
				{
					...state,
					stacks: updateStacks(state, operation.stackIds, stoppedStack),
					activity: activity(state, {
						kind: 'stop',
						stackIds: [...operation.stackIds],
						outcome: 'complete',
						startedAt: now,
						durationMs: 3_200,
						requestedBy: 'operator',
					}),
				},
				{
					message:
						operation.stackIds.length === 1
							? `${supabaseStackTitle(byId(operation.stackIds[0] ?? '') ?? { id: operation.stackIds[0] ?? '' })} stopped. Data and ports are kept; Resume brings it back in about a second.`
							: `Stopped ${operation.stackIds.length} stacks. Data and ports are kept.`,
				}
			);
		case 'restart':
			return done(state, {
				message: `${supabaseStackTitle(byId(operation.stackId) ?? { id: operation.stackId })}'s services restarted. Saved settings, exclusions, data and keys were kept.`,
			});
		case 'stop-and-start':
		case 'reapply-exclusions': {
			const purpose =
				operation.kind === 'reapply-exclusions'
					? 'reapply-exclusions'
					: operation.purpose;
			return done({
				...state,
				stacks: updateStacks(state, [operation.stackId], (stack) => ({
					...stack,
					state: 'running',
					flags: stack.flags.filter(
						(flag) =>
							!(
								(purpose === 'apply-config' && flag === 'config-changed') ||
								(purpose === 'reapply-exclusions' && flag === 'studio-back-on')
							)
					),
					configDrift:
						purpose === 'apply-config'
							? { status: 'unchanged' }
							: stack.configDrift,
					compositionDrift:
						purpose === 'reapply-exclusions'
							? undefined
							: stack.compositionDrift,
					studio:
						purpose === 'reapply-exclusions'
							? { ...stack.studio, included: stack.studio.operatorEnabled }
							: stack.studio,
					cli:
						purpose === 'switch-cli'
							? compact({ ...stack.cli, mismatch: undefined })
							: stack.cli,
				})),
			});
		}
		case 'pin':
		case 'unpin': {
			const pinned = operation.kind === 'pin';
			return done({
				...state,
				stacks: updateStacks(state, [operation.stackId], (stack) => ({
					...stack,
					pinned,
					holds: pinned
						? [
								...stack.holds.filter((hold) => hold.holder !== 'operator'),
								{ holder: 'operator', since: now, live: true },
							]
						: stack.holds.filter((hold) => hold.holder !== 'operator'),
				})),
			});
		}
		case 'release':
			return done({
				...state,
				stacks: updateStacks(state, [operation.stackId], (stack) => ({
					...stack,
					holds: stack.holds.filter(
						(hold: SupabaseHold) => !supabaseHoldMatches(hold, operation.holder)
					),
				})),
			});
		case 'adopt':
			return done({
				...state,
				stacks: updateStacks(state, [operation.stackId], (stack) => ({
					...stack,
					origin: 'adopted',
				})),
			});
		case 'prepare':
			return done(
				{
					...state,
					disk: { ...state.disk, cacheState: 'warm' },
					stacks:
						operation.stackId === undefined
							? state.stacks
							: updateStacks(state, [operation.stackId], (stack) =>
									stack.state === 'not-created'
										? { ...stack, state: 'never-started', origin: 'managed' }
										: stack
								),
				},
				{ message: 'Services downloaded. New stacks now start in about 5 s.' }
			);
		case 'apply-migrations':
			return done(state, { message: 'Applied 2 migrations.' });
		case 'reset':
			return done(state, {
				message: operation.seed
					? 'Reset to migrations and seed.'
					: 'Reset to migrations; seed skipped.',
			});
		case 'seed-buckets':
			return done(state, {
				message: 'Buckets seeded: 1 created, 1 updated, 14 files uploaded.',
			});
		case 'export':
			return {
				state,
				receipt: receiptFor(operation, {
					export: {
						content: operation.content,
						bytes: 63 * 1_024,
						revealable: true,
					},
					message: `Exported the ${operation.content} (${formatSupabaseSize(63 * 1_024)}). Storage files aren't included.`,
				}),
			};
		case 'destroy': {
			const removed = new Set(operation.stackIds);
			const freed = state.stacks
				.filter((stack) => removed.has(stack.id))
				.reduce((total, stack) => total + (stack.diskBytes ?? 0), 0);
			return done(
				{
					...state,
					stacks: state.stacks.filter((stack) => !removed.has(stack.id)),
					requests: state.requests.filter(
						(request) =>
							request.stackId === undefined || !removed.has(request.stackId)
					),
					prune: {
						...state.prune,
						lastResult: {
							at: now,
							destroyed: removed.size,
							failed: 0,
							freedBytes: freed,
						},
					},
					activity: activity(state, {
						kind: 'destroy',
						stackIds: [...operation.stackIds],
						outcome: 'complete',
						startedAt: now,
						durationMs: 2_000,
						requestedBy: 'operator',
					}),
				},
				{
					message: `Destroyed ${removed.size === 1 ? '1 stack' : `${removed.size} stacks`}. Freed ${formatSupabaseSize(freed)} and ${removed.size * 10} ports.`,
				}
			);
		}
		case 'set-studio':
			return done({
				...state,
				stacks: updateStacks(state, [operation.stackId], (stack) => ({
					...stack,
					studio: {
						included: operation.enabled,
						operatorEnabled: operation.enabled,
					},
					excluded: operation.enabled
						? stack.excluded.filter((capability) => capability !== 'studio')
						: [...new Set([...stack.excluded, 'studio' as const])],
					studioUrl:
						operation.enabled && stack.ports.api !== undefined
							? loopback(stack.ports.api + 3)
							: undefined,
					ports: compact({
						...stack.ports,
						studio:
							operation.enabled && stack.ports.api !== undefined
								? stack.ports.api + 3
								: undefined,
					}),
				})),
			});
		case 'follow-branch': {
			const stack = byId(operation.stackId);
			if (!stack?.currentHead) break;
			const nextId = demoHex(
				`${stack.worktreeLabel ?? stack.id}|${stack.currentHead.ref}`
			);
			const follower = compact(
				startedStack(
					state,
					compact({
						...stack,
						id: nextId,
						branchContext: stack.currentHead.ref,
						flags: [],
						requestIds: [],
						holds: stack.holds,
						pinned: false,
						ports: {},
						activeJobId: undefined,
						diskBytes: undefined,
						cli: {
							...stack.cli,
							inspectCommand: `${RUNNER} stack status --stack-id ${nextId}`,
						},
					}),
					now,
					false
				)
			);
			return done({
				...state,
				stacks: [
					...updateStacks(state, [stack.id], (current) => ({
						...stoppedStack(current),
						holds: [],
					})),
					follower,
				],
			});
		}
		case 'open':
			return {
				state,
				receipt: receiptFor(operation, {
					open: { opened: true, surface: operation.surface },
				}),
			};
		case 'copy':
			return {
				state,
				receipt: receiptFor(operation, {
					copy: {
						copied: true,
						what: operation.what,
						...(operation.what === 'publishable-key' ||
						operation.what === 'psql-command' ||
						operation.what === 'app-env'
							? { clearsAt: now + 60_000 }
							: {}),
					},
				}),
			};
		case 'reveal':
			return {
				state,
				receipt: receiptFor(operation, {
					reveal: { revealed: true, what: operation.what },
				}),
			};
		case 'request.approve': {
			const request = state.requests.find(
				(candidate) => candidate.id === operation.requestId
			);
			if (!request) break;
			const remaining = state.requests.filter(
				(candidate) => candidate.id !== request.id
			);
			if (request.kind === 'destroy' && request.stackId !== undefined) {
				const target = request.stackId;
				return done(
					{
						...state,
						stacks: state.stacks.filter((stack) => stack.id !== target),
						requests: remaining,
					},
					{
						message: `Destroyed ${request.branch} as the ${request.requester.kind === 'codex' ? 'Codex' : request.requester.kind === 'claude' ? 'Claude' : 'agent'} session asked.`,
					}
				);
			}
			const stopId = operation.stopStackId;
			return done({
				...state,
				requests: remaining,
				stacks:
					stopId === undefined
						? state.stacks
						: updateStacks(state, [stopId], stoppedStack),
			});
		}
		case 'request.deny':
			return done(
				{
					...state,
					requests: state.requests.filter(
						(request) => request.id !== operation.requestId
					),
				},
				{ message: 'Request denied. The session is told on its next call.' }
			);
		case 'set-enabled':
			return done({
				...state,
				feature: compact({
					...state.feature,
					enabled: operation.enabled,
					acknowledgedAt: operation.enabled
						? now
						: state.feature.acknowledgedAt,
				}),
				discovery: {
					...state.discovery,
					status: operation.enabled ? 'live' : 'off',
				},
				stacks:
					!operation.enabled && operation.disposition === 'stop-managed'
						? state.stacks.map((stack) =>
								isManaged(stack) && isSupabaseStackRunning(stack)
									? compact(stoppedStack(stack))
									: stack
							)
						: state.stacks,
			});
		case 'update-policy':
			return done(
				{
					...state,
					policy: applySupabasePolicyPatch(state.policy, operation.patch),
				},
				{
					message:
						'Supabase settings saved. They apply to the next start; running stacks keep theirs.',
				}
			);
		case 'repository.recheck':
			return done({
				...state,
				repositories: state.repositories.map((repository) =>
					repository.id === operation.repositoryId
						? { ...repository, checkedAt: now }
						: repository
				),
			});
		case 'repository.set-mode':
			return done({
				...state,
				repositories: state.repositories.map((repository) =>
					repository.id === operation.repositoryId
						? { ...repository, mode: operation.mode }
						: repository
				),
				policy: {
					...state.policy,
					repositories: [
						...state.policy.repositories.filter(
							(entry) => entry.id !== operation.repositoryId
						),
						{ id: operation.repositoryId, mode: operation.mode },
					],
				},
			});
		case 'cancel-job': {
			const job = state.jobs.find(
				(candidate) => candidate.id === operation.jobId
			);
			if (!job) break;
			return done({
				...state,
				jobs: state.jobs.map((candidate) =>
					candidate.id === job.id
						? { ...candidate, status: 'cancelled', updatedAt: now }
						: candidate
				),
				stacks: updateStacks(state, job.stackIds, (stack) => ({
					...stoppedStack(stack),
					activeJobId: undefined,
					lanes: stack.lanes,
				})),
			});
		}
		case 'restart-metro':
			return done(
				{
					...state,
					stacks: state.stacks.map((stack) => ({
						...stack,
						lanes: stack.lanes.map((lane) =>
							lane.laneId === operation.laneId
								? { ...lane, needsMetroRestart: false }
								: lane
						),
					})),
				},
				{ message: "Metro restarted with the stack's address." }
			);
		case 'choose-path':
			return {
				state,
				receipt: receiptFor(operation, { completed: false, cancelled: true }),
			};
	}
	return {
		state,
		receipt: receiptFor(operation, {
			completed: false,
			error: supabaseDesktopError(
				'unknown_target',
				'That target is not listed.'
			),
		}),
	};
}

/**
 * The demo never shows a system dialog: every confirmation is granted
 * without a token, so the renderer's confirm-then-run flow runs unchanged.
 */
export function confirmSupabaseDemoOperation(
	operation: SupabaseOperation
): SupabaseConfirmationResult {
	return { actionId: operation.actionId, required: false, confirmed: true };
}

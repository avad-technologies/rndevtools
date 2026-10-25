import { describe, expect, it } from 'vitest';
import type { Lane } from '../../shared/lane-protocol';
import {
	attentionItems,
	SUPABASE_POLICY_DEFAULTS,
	type SupabaseHold,
	type SupabaseJob,
	type SupabaseStackSummary,
	stackStatus,
	supabaseDesktopError,
	supabaseStateSchema,
} from '../../shared/supabase-protocol';
import {
	parseSupabaseStackList,
	parseSupabaseStackStatus,
	type SupabaseStackStatus,
} from './cli-contract';
import {
	loadSupabaseCliFixture,
	realisticSecrets,
	SECRET_SHAPED,
	type SupabaseCliFixtureName,
	withRealisticSecrets,
} from './cli-fixtures.test-support';
import type { SupabaseCliResolution } from './cli-resolver';
import { resolveSupabaseDialect } from './dialect';
import type { SupabaseHoldsResult } from './holds';
import { expectedStackId } from './identity';
import type { SupabasePolicySnapshot } from './policy-store';
import {
	type SupabaseRepositoryFacts,
	type SupabaseWorktreeFacts,
	supabaseRepositoryId,
} from './repositories';
import type { SupabaseRequestRecord, SupabaseStackRecord } from './stack-store';
import {
	assembleSupabaseState,
	type SupabaseStateInputs,
	supabasePathLabel,
} from './state-assembly';

const NOW = 1_792_245_785_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MB = 1_024 * 1_024;
const REPO = '/private/tmp/supa-spike/work/repo';
const WT_B = '/private/tmp/supa-spike/work/wt-b';
const REPO_ID =
	'b2e7a5393a8054d7b4658b68c7c7bb12092465347f6e3fbb7afb6864534dd9e8';
const WT_B_ID =
	'b7d2540d73c761df0a9c08923965e2172482324bb631b0d9d71962daa1b499e6';
const LANE_ID = 'lane-c69dc564-b12e-45d5-b0d5-3e9d034a072d';
const UDID = '380DAF54-343E-4E1B-BE43-1B116A9D03C4';
const CLAUDE = { kind: 'claude' as const, sessionId: '7f3a2c91-claude' };
const CODEX = { kind: 'codex' as const, sessionId: '3c9e7a12-codex' };
const SECRETS = realisticSecrets();

function list(name: SupabaseCliFixtureName) {
	const fixture = loadSupabaseCliFixture(name);
	return parseSupabaseStackList(fixture.stdout, fixture.stderr);
}

function status(
	name: SupabaseCliFixtureName,
	mutate: (value: Record<string, unknown>) => void = () => undefined
): SupabaseStackStatus {
	const { value } = withRealisticSecrets(loadSupabaseCliFixture(name).stdout);
	mutate(value as Record<string, unknown>);
	return parseSupabaseStackStatus(value);
}

function entry(
	id: string,
	projectRoot: string,
	branchContext: string,
	overrides: Record<string, string> = {}
) {
	return {
		id,
		project_root: projectRoot,
		name: 'default',
		branch_context: branchContext,
		runtime: 'native',
		owner: 'unavailable',
		...overrides,
	};
}

function verified(): SupabaseCliResolution {
	return {
		ok: true,
		cli: {
			binaryPath: `${REPO}/node_modules/@supabase/cli-darwin-arm64/bin/supabase`,
			binaryDirectory: `${REPO}/node_modules/@supabase/cli-darwin-arm64/bin`,
			packageRoot: `${REPO}/node_modules/supabase`,
			platformPackageRoot: `${REPO}/node_modules/@supabase/cli-darwin-arm64`,
			version: '2.121.0',
			dialect: resolveSupabaseDialect('2.121.0'),
			fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4 },
		},
	};
}

function worktree(
	overrides: Partial<SupabaseWorktreeFacts> = {},
	branchContext = 'refs/heads/main'
): SupabaseWorktreeFacts {
	const root = overrides.worktreePath ?? REPO;
	return {
		worktreePath: root,
		realWorktreePath: root,
		appPath: root,
		repositoryRoot: REPO,
		repositoryId: supabaseRepositoryId(REPO),
		branch: 'main',
		exists: true,
		detection: {
			status: 'found',
			appRoot: root,
			worktreeRoot: root,
			projectRoot: root,
			configPath: `${root}/supabase/config.toml`,
			stackFlag: { optedIn: true, line: 7 },
			configConflict: false,
			pinnedListeners: [],
			shadowedAppVariables: [],
			runner: { command: 'pnpm exec', lockfile: `${root}/pnpm-lock.yaml` },
			fileIssues: [],
		},
		head: {
			status: 'ok',
			branchContext,
			gitDir: `${root}/.git`,
			commonDir: `${root}/.git`,
		},
		expectedStackId: expectedStackId({ projectRoot: root, branchContext }),
		cli: verified(),
		mode: { value: 'managed' },
		bucketsConfigured: true,
		migrationCount: 2,
		...overrides,
	};
}

function repository(
	worktrees: readonly SupabaseWorktreeFacts[] = [worktree()]
): SupabaseRepositoryFacts {
	return {
		root: REPO,
		realRoot: REPO,
		id: supabaseRepositoryId(REPO),
		mode: 'auto',
		appRelativePath: '',
		worktrees,
		checkedAt: NOW - MINUTE,
	};
}

function record(
	overrides: Partial<SupabaseStackRecord> = {}
): SupabaseStackRecord {
	return {
		id: REPO_ID,
		origin: 'managed',
		name: 'default',
		projectRoot: REPO,
		worktreePath: REPO,
		appPaths: [REPO],
		repositoryId: supabaseRepositoryId(REPO),
		branchContext: 'refs/heads/main',
		createdBy: { via: 'agent', agent: CLAUDE, laneId: LANE_ID },
		createdAt: NOW - DAY,
		lastStartedAt: NOW - 10 * MINUTE,
		lastUsedAt: NOW - MINUTE,
		cliVersion: '2.121.0',
		runtime: 'native',
		pinned: false,
		holds: [],
		clocks: {},
		exclusions: ['studio', 'analytics'],
		studioEnabled: false,
		flags: {},
		...overrides,
	};
}

const lane: Lane = {
	id: LANE_ID,
	worktreePath: REPO,
	branch: 'main',
	simulatorUdid: UDID,
	environment: 'development',
	port: 8_102,
	metro: 'ready',
	logPath: '/private/tmp/lane.log',
	startedAt: NOW - 30 * MINUTE,
	agent: { ...CLAUDE, lastSeenAt: NOW - MINUTE },
};

function held(
	holds: readonly SupabaseHold[] = [
		{
			holder: 'lane',
			laneId: LANE_ID,
			agent: { ...CLAUDE, synthetic: false },
			since: NOW - 30 * MINUTE,
			live: true,
		},
	],
	overrides: Partial<SupabaseHoldsResult> = {}
): SupabaseHoldsResult {
	return {
		holds,
		cwdKeepers: [],
		held: holds.some((hold) => hold.live),
		clocksPaused: false,
		clocks: {},
		...overrides,
	};
}

function policy(
	overrides: Partial<SupabasePolicySnapshot> = {}
): SupabasePolicySnapshot {
	return {
		enabled: true,
		acknowledgedAt: NOW - DAY,
		health: 'ok',
		policy: SUPABASE_POLICY_DEFAULTS,
		paths: {},
		...overrides,
	};
}

function inputs(
	overrides: Partial<SupabaseStateInputs> = {}
): SupabaseStateInputs {
	return {
		now: NOW,
		revision: 7,
		platform: { supported: true, arch: 'arm64', macosVersion: '15.1' },
		policy: policy(),
		discovery: {
			status: 'live',
			lastListAt: NOW - 2_000,
			sessions: { claude: 'ok', codex: 'ok' },
		},
		records: [],
		lanes: [],
		repositories: [],
		holds: new Map(),
		jobs: [],
		pathLabel: (value) => value.replace('/private/tmp/supa-spike', '~/code'),
		...overrides,
	};
}

function stack(
	state: { stacks: readonly SupabaseStackSummary[] },
	id: string
): SupabaseStackSummary {
	const found = state.stacks.find((candidate) => candidate.id === id);
	if (!found) throw new Error(`no stack ${id}`);
	return found;
}

/** The repo stack running, read through `stack status`, held by its lane. */
function runningInputs(
	overrides: Partial<SupabaseStateInputs> = {}
): SupabaseStateInputs {
	const awake = status('status-awake');
	return inputs({
		list: list('list-running'),
		statuses: new Map([[REPO_ID, { status: awake, checkedAt: NOW - 1_000 }]]),
		credentials: new Map([[REPO_ID, awake.credentials]]),
		records: [record()],
		lanes: [lane],
		laneAttachments: new Map([
			[LANE_ID, { stackId: REPO_ID, needsMetroRestart: true }],
		]),
		simulatorNames: new Map([[UDID, 'iPhone 17 Pro']]),
		repositories: [repository()],
		holds: new Map([[REPO_ID, held()]]),
		exposure: new Map([
			[REPO_ID, { verdict: 'loopback', checkedAt: NOW - 1_000 }],
		]),
		...overrides,
	});
}

function assertNoSecrets(value: unknown): void {
	const text = JSON.stringify(value);
	expect(text).not.toMatch(SECRET_SHAPED);
	for (const secret of [
		SECRETS.publishableKey,
		SECRETS.secretKey,
		SECRETS.anonKey,
		SECRETS.serviceRoleKey,
		SECRETS.dbPassword,
		SECRETS.s3AccessKey,
		SECRETS.s3Secret,
	]) {
		expect(text).not.toContain(secret);
	}
}

describe('assembleSupabaseState while off', () => {
	it('reports the platform and policy and probes nothing', () => {
		const state = assembleSupabaseState(
			runningInputs({ policy: policy({ enabled: false }) })
		);
		expect(supabaseStateSchema.parse(state)).toEqual(state);
		expect(state.feature).toEqual({
			enabled: false,
			acknowledgedAt: NOW - DAY,
			policyHealth: 'ok',
		});
		expect(state.discovery.status).toBe('off');
		expect(state.stacks).toEqual([]);
		expect(state.repositories).toEqual([]);
		expect(state.policy).toEqual(SUPABASE_POLICY_DEFAULTS);
		expect(state.revision).toBe(7);
		expect(state.source).toBe('live');
	});

	it('keeps the feature off and says why while the policy is quarantined', () => {
		const state = assembleSupabaseState(
			runningInputs({
				policy: policy({ enabled: false, health: 'quarantined' }),
			})
		);
		expect(state.feature.policyHealth).toBe('quarantined');
		expect(attentionItems(state).map((item) => item.kind)).toEqual([
			'policy-quarantined',
		]);
	});

	it('lists nothing on an unsupported Mac', () => {
		const state = assembleSupabaseState(
			runningInputs({
				platform: {
					supported: false,
					arch: 'x64',
					macosVersion: '13.6',
					reasonText:
						'Native Supabase needs Apple silicon and macOS 14 or later.',
				},
			})
		);
		expect(state.stacks).toEqual([]);
		expect(state.availability.platform.supported).toBe(false);
		expect(state.discovery.status).toBe('off');
	});
});

describe('assembleSupabaseState stacks', () => {
	it('shows Running only from a status read, never from the list alone', () => {
		const state = assembleSupabaseState(runningInputs());
		const repo = stack(state, REPO_ID);
		expect(repo).toMatchObject({
			origin: 'managed',
			state: 'running',
			ownerLiveness: 'reachable',
			lifecycle: 'running',
			readiness: 'sleeping',
			health: {
				members: 7,
				awake: 5,
				sleeping: 2,
				unhealthy: 0,
				excluded: ['studio', 'analytics', 'pooler'],
			},
			runtime: 'native',
			exposure: { verdict: 'loopback', checkedAt: NOW - 1_000 },
			mode: { value: 'managed' },
			worktreeLabel: '~/code/work/repo',
			branchContext: 'refs/heads/main',
			currentHead: { ref: 'refs/heads/main' },
			apiUrl: 'http://127.0.0.1:26211',
			restUrl: 'http://127.0.0.1:26211/rest/v1',
			functionsUrl: 'http://127.0.0.1:26211/functions/v1',
			mailpitUrl: 'http://127.0.0.1:21213',
			ports: { api: 26_211, db: 30_630, mail: 21_213 },
			studio: { included: false, operatorEnabled: false },
			lanes: [
				{
					laneId: LANE_ID,
					simulatorUdid: UDID,
					simulatorLabel: 'iPhone 17 Pro',
					port: 8_102,
					environment: 'development',
					metro: 'ready',
					needsMetroRestart: true,
				},
			],
			createdBy: {
				via: 'lane-up',
				agent: CLAUDE,
				laneId: LANE_ID,
				at: NOW - DAY,
			},
			cli: {
				version: '2.121.0',
				gate: 'verified',
				runnerLabel: 'pnpm exec supabase',
				inspectCommand: `pnpm exec supabase stack status --stack-id ${REPO_ID}`,
				statusCommand: 'pnpm exec supabase stack status',
			},
			known: { publishableKey: true, anonKey: true, databaseAddress: true },
			appEnvNames: [
				'EXPO_PUBLIC_SUPABASE_URL',
				'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
			],
			bucketsConfigured: true,
			migrationCount: 2,
			configDrift: { status: 'unchanged' },
		});
		expect(repo.flags).toEqual([]);
		expect(stackStatus(repo).key).toBe('running-idle');

		// Listed as reachable, never read: Checking…, not Running.
		const other = stack(state, WT_B_ID);
		expect(other).toMatchObject({
			origin: 'external',
			state: 'unknown',
			ownerLiveness: 'reachable',
			mode: {
				value: 'observed',
				reasonText: "its repository isn't tracked in Lanes",
			},
			createdBy: { via: 'outside' },
			cli: { gate: 'missing' },
			appEnvNames: [],
		});
		expect(stackStatus(other).key).toBe('checking');

		expect(state.capacity).toMatchObject({
			running: 1,
			cap: 12,
			derivedCap: 12,
		});
		expect(state.trafficSignature.apiPorts).toEqual([
			{ port: 26_211, stackId: REPO_ID },
		]);
		expect(state.repositories).toHaveLength(1);
		expect(state.repositories[0]?.worktrees[0]?.stackId).toBe(REPO_ID);
		assertNoSecrets(state);
	});

	it('attaches lanes by the service attachments, else by worktree HEAD', () => {
		const derived = assembleSupabaseState(
			runningInputs({ laneAttachments: undefined })
		);
		expect(stack(derived, REPO_ID).lanes.map((entry) => entry.laneId)).toEqual([
			LANE_ID,
		]);
		expect(stack(derived, REPO_ID).lanes[0]?.needsMetroRestart).toBe(false);
		// A lane started with its backend off is not attached.
		const detached = assembleSupabaseState(
			runningInputs({ laneAttachments: new Map() })
		);
		expect(stack(detached, REPO_ID).lanes).toEqual([]);
	});

	it('flags a stack stopped outside RN Devtools while something holds it', () => {
		const stopped = status('status-stopped');
		const outside = assembleSupabaseState(
			runningInputs({
				list: list('list-stopped'),
				statuses: new Map([[REPO_ID, { status: stopped, checkedAt: NOW }]]),
				credentials: new Map(),
			})
		);
		const repo = stack(outside, REPO_ID);
		expect(repo.state).toBe('stopped');
		expect(repo.flags).toContain('stopped-outside');
		expect(stackStatus(repo).key).toBe('stopped-outside');
		expect(repo.health).toMatchObject({ members: 7, awake: 0 });
		// Stopped stacks keep their last known ports and URLs.
		expect(repo.ports.db).toBeUndefined();
		expect(repo.known.databaseAddress).toBe(false);

		const byDesktop = assembleSupabaseState(
			runningInputs({
				list: list('list-stopped'),
				statuses: new Map([[REPO_ID, { status: stopped, checkedAt: NOW }]]),
				records: [record({ lastStoppedAt: NOW - MINUTE })],
				endpoints: new Map([[REPO_ID, { apiUrl: 'http://127.0.0.1:26211' }]]),
			})
		);
		const resumed = stack(byDesktop, REPO_ID);
		expect(resumed.flags).not.toContain('stopped-outside');
		expect(stackStatus(resumed).key).toBe('stopped');
		expect(resumed.apiUrl).toBe('http://127.0.0.1:26211');
	});

	it("keeps what a needs-recreate stack can't adopt once lastError moves on", () => {
		const change = {
			service: 'database',
			path: 'config.version',
			key: '[db] major_version',
			saved: '15',
			requested: '17',
			editable: true,
		};
		const recreate = {
			...supabaseDesktopError('refused', 'The saved stack cannot adopt it.'),
			code: 'needs_recreate' as const,
			details: { stackChanges: [change] },
		};
		const conflict = {
			...supabaseDesktopError('refused', 'Port 54321 is in use.'),
			code: 'ports_conflict' as const,
		};
		const summaryOf = (overrides: Partial<SupabaseStackRecord>) =>
			stack(
				assembleSupabaseState(
					runningInputs({
						list: list('list-stopped'),
						statuses: new Map([
							[REPO_ID, { status: status('status-stopped'), checkedAt: NOW }],
						]),
						credentials: new Map(),
						records: [record(overrides)],
					})
				),
				REPO_ID
			);
		// A retry failed for another reason, so lastError is that failure.
		const retried = summaryOf({
			flags: { needsRecreate: true },
			lastError: conflict,
			recreateError: recreate,
		});
		expect(retried).toMatchObject({
			state: 'needs-recreate',
			lastError: { code: 'ports_conflict' },
			recreateChanges: [change],
		});
		expect(stackStatus(retried).explanation).toBe(
			'The saved stack cannot adopt this configuration. Revert the change to keep it, or recreate it.'
		);
		// A record saved before recreateError existed.
		expect(
			summaryOf({ flags: { needsRecreate: true }, lastError: recreate })
				.recreateChanges
		).toEqual([change]);
		// Without the flag nothing is listed, whatever the record kept.
		const cleared = summaryOf({ lastError: conflict, recreateError: recreate });
		expect(cleared.state).toBe('stopped');
		expect(cleared).not.toHaveProperty('recreateChanges');
	});

	it('lists an unreadable stack as observed, revealable and never destroyable', () => {
		const state = assembleSupabaseState(
			runningInputs({
				list: list('list-unreadable'),
				stackFolders: new Map([['a'.repeat(64), true]]),
			})
		);
		const unreadable = stack(state, 'a'.repeat(64));
		expect(unreadable).toMatchObject({
			origin: 'external',
			state: 'unreadable',
			ownerLiveness: 'unknown',
			mode: { value: 'observed', reasonText: "its state can't be read" },
			worktreeExists: false,
			uploadsInDeletedWorktree: false,
			stackFolderExists: true,
			pruneGroup: 'unreadable',
			createdBy: { via: 'unknown' },
		});
		const group = state.prune.groups.find((entry) => entry.id === 'unreadable');
		expect(group).toMatchObject({ selectable: false, preselected: false });
	});

	it('adds an expected row for an opted-in worktree with no stack yet', () => {
		const job: SupabaseJob = {
			id: 'supabase-job-86509e6e-884b-4176-93dc-08d486577973',
			kind: 'create',
			stackIds: [REPO_ID],
			status: 'running',
			startedAt: NOW - 2_000,
			updatedAt: NOW - 500,
			cancellable: true,
			requestedBy: { kind: 'operator' },
		};
		const state = assembleSupabaseState(
			inputs({
				list: list('list-empty'),
				repositories: [repository()],
				jobs: [job],
			})
		);
		expect(state.stacks.map((entry) => entry.id)).toEqual([REPO_ID]);
		const expected = stack(state, REPO_ID);
		expect(expected).toMatchObject({
			origin: 'expected',
			state: 'not-created',
			ownerLiveness: 'absent',
			runtime: 'unknown',
			mode: { value: 'managed' },
			excluded: ['studio', 'analytics'],
			createdBy: { via: 'unknown' },
			migrationCount: 2,
			activeJobId: job.id,
			configDrift: { status: 'unavailable' },
		});
		expect(stackStatus(expected, { jobs: state.jobs }).label).toBe('Creating…');
		expect(stackStatus(expected).key).toBe('not-created');
		expect(state.capacity.starting).toBe(1);

		// No expected rows before the first list: the stacks are unknown then.
		const early = assembleSupabaseState(
			inputs({ repositories: [repository()], records: [record()] })
		);
		expect(early.stacks.map((entry) => [entry.id, entry.state])).toEqual([
			[REPO_ID, 'unknown'],
		]);
	});

	it('trusts the CLI id when it lists the worktree branch under another id', () => {
		const other = 'c'.repeat(64);
		const state = assembleSupabaseState(
			inputs({
				list: parseSupabaseStackList({
					stacks: [entry(other, REPO, 'refs/heads/main')],
				}),
				repositories: [repository()],
			})
		);
		expect(state.stacks.map((candidate) => candidate.id)).toEqual([other]);
		expect(stack(state, other).flags).toContain('id-mismatch');
	});

	it('hides shadow databases behind the transient filter', () => {
		const shadow = 'd'.repeat(64);
		const state = assembleSupabaseState(
			runningInputs({
				list: parseSupabaseStackList({
					stacks: [
						entry(
							shadow,
							'/private/tmp/supabase-shadow-1a2b',
							'refs/heads/main'
						),
						...(
							loadSupabaseCliFixture('list-running').stdout as {
								stacks: unknown[];
							}
						).stacks,
					],
				}),
			})
		);
		expect(state.stacks.at(-1)?.id).toBe(shadow);
		expect(stack(state, shadow).flags).toContain('transient');
		expect(state.transientCount).toBe(1);
	});

	it('marks Docker stacks on a managed identity as LAN-exposed', () => {
		const state = assembleSupabaseState(
			inputs({
				list: parseSupabaseStackList({
					stacks: [
						entry(REPO_ID, REPO, 'refs/heads/main', {
							runtime: 'docker',
							owner: 'reachable',
						}),
					],
				}),
				repositories: [repository()],
			})
		);
		const docker = stack(state, REPO_ID);
		expect(docker.flags).toContain('lan-exposed');
		expect(docker.exposure.verdict).toBe('lan-exposed');
		expect(stackStatus(docker).key).toBe('lan-exposed');
		expect(state.notices.containerStacks).toEqual([REPO_ID]);
		expect(attentionItems(state)[0]?.kind).toBe('lan-exposed');
	});

	it('shows an lsof failure as exposure unknown', () => {
		const state = assembleSupabaseState(
			runningInputs({
				exposure: new Map([[REPO_ID, { verdict: 'unknown', checkedAt: NOW }]]),
			})
		);
		const repo = stack(state, REPO_ID);
		expect(repo.flags).toContain('exposure-unknown');
		expect(stackStatus(repo).key).toBe('exposure-unknown');
	});

	it('notices a moved HEAD and offers the new branch its own stack', () => {
		const moved = worktree({}, 'refs/heads/feat-y');
		const state = assembleSupabaseState(
			runningInputs({
				repositories: [repository([moved])],
				headStableSince: new Map([[REPO, NOW - 5 * MINUTE]]),
			})
		);
		const repo = stack(state, REPO_ID);
		expect(repo.flags).toContain('stale-branch');
		expect(repo.currentHead).toEqual({
			ref: 'refs/heads/feat-y',
			stableSince: NOW - 5 * MINUTE,
		});
		const next = stack(state, moved.expectedStackId as string);
		expect(next).toMatchObject({
			origin: 'expected',
			branchContext: 'refs/heads/feat-y',
		});
	});

	it('reads a CLI release mismatch from the per-service errors', () => {
		const mismatch = status('status-release-mismatch');
		const state = assembleSupabaseState(
			runningInputs({
				statuses: new Map([[REPO_ID, { status: mismatch, checkedAt: NOW }]]),
				credentials: new Map([[REPO_ID, mismatch.credentials]]),
			})
		);
		const repo = stack(state, REPO_ID);
		expect(repo.state).toBe('running');
		expect(repo.cli.mismatch).toEqual({
			ownerRelease: '0.1.0+a559977f2134f3a5',
			clientRelease: '0.1.0+8b6cc1ef8a8469e7',
			clientVersion: '2.121.0',
		});
		expect(stackStatus(repo).key).toBe('cli-mismatch');
		expect(repo.known.databaseAddress).toBe(false);
	});

	it('tells an owner that is starting from one that is not responding', () => {
		const owners = {
			status: 'ok' as const,
			owners: [
				{
					pid: 20_075,
					executable: `${REPO}/node_modules/@supabase/cli-darwin-arm64/bin/supabase`,
					stackId: REPO_ID,
				},
			],
		};
		const starting = assembleSupabaseState(
			inputs({
				list: list('list-stopped'),
				records: [record()],
				repositories: [repository()],
				owners,
				ownerFirstSeen: new Map([[REPO_ID, NOW - 10_000]]),
			})
		);
		expect(stack(starting, REPO_ID)).toMatchObject({
			state: 'starting',
			ownerLiveness: 'starting',
		});
		expect(stackStatus(stack(starting, REPO_ID)).key).toBe('starting-outside');
		const stuck = assembleSupabaseState(
			inputs({
				list: list('list-stopped'),
				records: [record()],
				repositories: [repository()],
				owners,
				ownerFirstSeen: new Map([[REPO_ID, NOW - 40_000]]),
			})
		);
		expect(stack(stuck, REPO_ID)).toMatchObject({
			state: 'unknown',
			ownerLiveness: 'not-responding',
		});
		expect(stackStatus(stack(stuck, REPO_ID)).key).toBe('not-responding');
		// The owner binary differs from the one that started it.
		expect(stack(stuck, REPO_ID).flags).not.toContain('cli-changed');
		const replaced = assembleSupabaseState(
			inputs({
				list: list('list-stopped'),
				records: [record({ binaryPath: '/private/tmp/old/bin/supabase' })],
				repositories: [repository()],
				owners,
			})
		);
		expect(stack(replaced, REPO_ID).flags).toContain('cli-changed');
		const sweeping = assembleSupabaseState(
			inputs({
				list: list('list-running'),
				records: [record()],
				repositories: [repository()],
				statuses: new Map([
					[
						REPO_ID,
						{
							failure: {
								error: {
									...supabaseDesktopError('internal', 'x'),
									code: 'busy',
									message: 'Another owner is sweeping this stack',
								},
								at: NOW,
							},
						},
					],
				]),
			})
		);
		expect(stack(sweeping, REPO_ID).ownerLiveness).toBe('sweeping');
	});

	it('suggests clean up for stopped, deleted and stale stacks', () => {
		const state = assembleSupabaseState(
			inputs({
				list: parseSupabaseStackList({
					stacks: [
						entry(REPO_ID, REPO, 'refs/heads/main'),
						entry(WT_B_ID, WT_B, 'refs/heads/feature-b'),
					],
				}),
				records: [
					record({ lastStoppedAt: NOW - 20 * DAY }),
					record({
						id: WT_B_ID,
						projectRoot: WT_B,
						worktreePath: WT_B,
						appPaths: [],
						branchContext: 'refs/heads/feature-b',
						lastStoppedAt: NOW - DAY,
					}),
				],
				repositories: [repository()],
				pathChecks: new Map([
					[
						WT_B_ID,
						{
							worktreeExists: false,
							projectRootMissingChecks: 2,
							missingSince: NOW - 30_000,
						},
					],
				]),
				measurements: {
					disk: new Map([
						[REPO_ID, { stackBytes: 44 * MB, measuredAt: NOW }],
						[
							WT_B_ID,
							{ stackBytes: 64 * MB, uploadsBytes: MB, measuredAt: NOW },
						],
					]),
				},
				previousPrune: {
					revision: 2,
					computedAt: NOW - MINUTE,
					groups: [],
					notSuggested: {
						held: 0,
						pinned: 0,
						starting: 0,
						external: 0,
						running: 0,
					},
				},
			})
		);
		const old = stack(state, REPO_ID);
		expect(old).toMatchObject({
			pruneGroup: 'retention',
			pruneSuggestedAt: NOW - 6 * DAY,
		});
		expect(old.flags).toContain('prune-suggested');
		const gone = stack(state, WT_B_ID);
		expect(gone).toMatchObject({
			worktreeExists: false,
			uploadsInDeletedWorktree: true,
			pruneGroup: 'worktree-deleted',
			pruneSuggestedAt: NOW - 30_000,
		});
		expect(gone.flags).toEqual(
			expect.arrayContaining(['worktree-deleted', 'orphaned'])
		);
		expect(state.prune).toMatchObject({
			revision: 3,
			suggestedBytes: 108 * MB,
			onDiskBytes: 109 * MB,
		});
		expect(state.disk).toMatchObject({
			stacksBytes: 108 * MB,
			uploadsBytes: MB,
			cacheState: 'unknown',
		});
	});
});

describe('assembleSupabaseState capacity and requests', () => {
	function twoRunning(
		overrides: Partial<SupabaseStateInputs> = {}
	): SupabaseStateInputs {
		const awake = status('status-awake');
		const other = status('status-sleeping', (value) => {
			value.identity = {
				id: WT_B_ID,
				name: 'default',
				project_root: WT_B,
				branch_context: 'refs/heads/feature-b',
			};
		});
		return runningInputs({
			statuses: new Map([
				[REPO_ID, { status: awake, checkedAt: NOW }],
				[WT_B_ID, { status: other, checkedAt: NOW }],
			]),
			records: [
				record({ lastUsedAt: NOW - MINUTE }),
				record({
					id: WT_B_ID,
					projectRoot: WT_B,
					worktreePath: WT_B,
					appPaths: [],
					branchContext: 'refs/heads/feature-b',
					lastUsedAt: NOW - 2 * DAY,
				}),
			],
			holds: new Map([
				[REPO_ID, held([])],
				[WT_B_ID, held([])],
			]),
			...overrides,
		});
	}

	it('names the stack admission would stop when the cap is full', () => {
		const state = assembleSupabaseState(
			twoRunning({
				policy: policy({
					policy: { ...SUPABASE_POLICY_DEFAULTS, maxRunning: 2 },
				}),
				measurements: {
					sysv: {
						status: 'ok',
						shmmni: 32,
						segments: { status: 'ok', used: 6, free: 26 },
					},
					memoryPressure: 'normal',
				},
			})
		);
		expect(state.capacity).toMatchObject({
			running: 2,
			cap: 2,
			derivedCap: 12,
			sysv: { used: 6, limit: 32 },
			memoryPressure: 'normal',
			nextToStopId: WT_B_ID,
		});
		// Below the cap nothing has to stop.
		expect(
			assembleSupabaseState(twoRunning()).capacity.nextToStopId
		).toBeUndefined();
	});

	it('measures the footprint when every running stack was measured', () => {
		const estimate = assembleSupabaseState(twoRunning());
		expect(estimate.footprint).toEqual({
			mode: 'estimate',
			bytes: Math.round(0.17 * 1_024 ** 3 + 0.9 * 1_024 ** 3),
			awake: 1,
			idle: 1,
		});
		const measured = assembleSupabaseState(
			twoRunning({
				measurements: {
					memory: new Map([
						[REPO_ID, { bytes: 180 * MB, measuredAt: NOW - 5_000 }],
						[WT_B_ID, { bytes: 160 * MB, measuredAt: NOW - 2_000 }],
					]),
				},
			})
		);
		expect(measured.footprint).toEqual({
			mode: 'measured',
			bytes: 340 * MB,
			measuredAt: NOW - 5_000,
			awake: 1,
			idle: 1,
		});
		expect(stack(measured, REPO_ID).memoryBytes).toBe(180 * MB);
	});

	it('projects agent requests with what the reviewer needs', () => {
		const requests: SupabaseRequestRecord[] = [
			{
				id: 'supabase-request-75e6b385-095b-43c1-9f93-6fb5f84c85a9',
				kind: 'destroy',
				status: 'pending',
				requester: { ...CODEX, synthetic: false },
				stackId: REPO_ID,
				branch: 'main',
				note: 'Fresh database for the migration test.',
				createdAt: NOW - 4 * MINUTE,
				expiresAt: NOW + 26 * MINUTE,
			},
			{
				id: 'supabase-request-00000000-0000-4000-8000-000000000001',
				kind: 'reset',
				status: 'pending',
				requester: { ...CODEX, synthetic: false },
				stackId: REPO_ID,
				branch: 'main',
				seed: true,
				createdAt: NOW - 40 * MINUTE,
				expiresAt: NOW - 10 * MINUTE,
			},
			{
				id: 'supabase-request-00000000-0000-4000-8000-000000000002',
				kind: 'start-capacity',
				status: 'pending',
				requester: {
					kind: 'codex',
					sessionId: 'mcp-codex-mcp-client',
					synthetic: true,
				},
				worktreePath: REPO,
				branch: 'feat-z',
				createdAt: NOW - MINUTE,
				expiresAt: NOW + 29 * MINUTE,
			},
		];
		const state = assembleSupabaseState(
			twoRunning({
				requests,
				sessions: [{ ...CODEX, title: 'codex', cwd: `${REPO}/apps/mobile` }],
				measurements: {
					disk: new Map([[REPO_ID, { stackBytes: 71 * MB, measuredAt: NOW }]]),
				},
				holds: new Map([
					[REPO_ID, held()],
					[WT_B_ID, held([])],
				]),
			})
		);
		const [destroy, reset, parked] = state.requests;
		expect(destroy).toMatchObject({
			kind: 'destroy',
			status: 'pending',
			requester: { kind: 'codex', live: true, synthetic: false },
			sizeBytes: 71 * MB,
			note: 'Fresh database for the migration test.',
			otherHolders: [
				{
					holder: 'lane',
					agent: { ...CLAUDE, synthetic: false },
					live: true,
				},
			],
			laneAttached: {
				laneId: LANE_ID,
				port: 8_102,
				running: true,
				ownedByRequester: false,
			},
		});
		expect(reset?.status).toBe('expired');
		expect(parked).toMatchObject({
			kind: 'start-capacity',
			requester: { live: true, synthetic: true },
			capacity: { running: 2, cap: 12 },
		});
		expect(parked?.capacity?.candidates.map((entry) => entry.stackId)).toEqual([
			REPO_ID,
			WT_B_ID,
		]);
		expect(stack(state, REPO_ID).requestIds).toEqual([
			'supabase-request-75e6b385-095b-43c1-9f93-6fb5f84c85a9',
		]);
	});
});

describe('assembleSupabaseState details', () => {
	it('pushes the inspection only for the stack being inspected', () => {
		const inspected = assembleSupabaseState(
			runningInputs({
				interest: { view: 'stacks', inspectStackId: REPO_ID, sections: [] },
			})
		);
		expect(inspected.inspection).toMatchObject({
			stackId: REPO_ID,
			status: 'live',
			checkedAt: NOW - 1_000,
		});
		expect(inspected.inspection?.members).toHaveLength(7);
		expect(inspected.inspection?.members[0]).toEqual({
			service: 'database',
			capability: 'database',
			activation: 'eager',
			state: 'running',
			lifecycle: 'running',
			health: 'healthy',
		});
		expect(
			inspected.inspection?.endpoints.find(
				(entry) => entry.key === 'database.sql'
			)
		).toEqual({ key: 'database.sql', port: 30_630 });
		// Sleeping members carry the measured wake time; mail has none.
		const sleeping = status('status-sleeping');
		const asleep = assembleSupabaseState(
			runningInputs({
				interest: { view: 'stacks', inspectStackId: REPO_ID, sections: [] },
				statuses: new Map([
					[REPO_ID, { status: sleeping, checkedAt: NOW - 1_000 }],
				]),
			})
		).inspection?.members;
		expect(
			asleep?.map((member) => [member.service, member.wakeHintMs])
		).toEqual([
			['database', undefined],
			['rest', 400],
			['auth', 800],
			['realtime', 2_600],
			['storage', 1_400],
			['functions', 600],
			['mail', undefined],
		]);
		expect(
			assembleSupabaseState(
				runningInputs({ interest: { view: 'repositories', sections: [] } })
			).inspection
		).toBeUndefined();

		const failure = supabaseDesktopError('internal', 'status timed out');
		const stale = assembleSupabaseState(
			runningInputs({
				interest: { view: 'stacks', inspectStackId: REPO_ID, sections: [] },
				statuses: new Map([
					[
						REPO_ID,
						{
							status: status('status-awake'),
							checkedAt: NOW - 20_000,
							failure: { error: failure, at: NOW - 1_000 },
						},
					],
				]),
			})
		);
		expect(stale.inspection).toMatchObject({ status: 'stale', error: failure });
		// The summary no longer claims Running from the older good read.
		expect(stackStatus(stack(stale, REPO_ID)).key).toBe('checking');
	});

	it('notices another Supabase home and an unreadable registry', () => {
		const state = assembleSupabaseState(
			runningInputs({
				homeStateRoot: '/Users/example/.supabase/stacks',
				reservations: {
					status: 'ok',
					file: '/Users/example/.supabase/ports.sqlite',
					skippedRows: 0,
					truncated: false,
					reservations: [
						{
							stateRoot: '/private/tmp/supa-spike/home/stacks',
							stackId: REPO_ID,
							endpoint: 'api',
							port: 26_211,
						},
					],
				},
			})
		);
		expect(stack(state, REPO_ID).flags).toContain('other-supabase-home');
		expect(state.home.foreign).toEqual(['~/code/home']);
		const unreadable = assembleSupabaseState(
			runningInputs({
				reservations: { status: 'unavailable', reason: 'busy' },
			})
		);
		expect(unreadable.notices.registryError).toBe(
			"The port registry couldn't be read (busy)."
		);
	});

	it('flags project findings: pinned ports, conflicts, CLI and shadowed variables', () => {
		const flagged = worktree({
			detection: {
				status: 'found',
				appRoot: REPO,
				worktreeRoot: REPO,
				projectRoot: REPO,
				configPath: `${REPO}/supabase/config.toml`,
				stackFlag: { optedIn: false, reason: 'missing' },
				configConflict: true,
				pinnedListeners: [
					{
						source: 'config',
						file: `${REPO}/supabase/config.toml`,
						line: 4,
						key: 'api.port',
						port: 26_211,
					},
				],
				shadowedAppVariables: [
					{
						name: 'EXPO_PUBLIC_SUPABASE_URL',
						file: `${REPO}/.env.local`,
						line: 3,
					},
				],
				fileIssues: [],
			},
			cli: {
				ok: false,
				reason: 'not-installed',
				message: 'CLI not installed in this worktree',
				recovery: 'Install dependencies.',
				path: undefined,
			},
			mode: { value: 'observed', reasonText: 'stack flag missing' },
		});
		const state = assembleSupabaseState(
			runningInputs({
				repositories: [repository([flagged])],
				reservations: {
					status: 'ok',
					file: '/Users/example/.supabase/ports.sqlite',
					skippedRows: 0,
					truncated: false,
					reservations: [
						{
							stateRoot: '/Users/example/.supabase/stacks',
							stackId: WT_B_ID,
							endpoint: 'api',
							port: 26_211,
						},
					],
				},
			})
		);
		const repo = stack(state, REPO_ID);
		expect(repo.flags).toEqual(
			expect.arrayContaining([
				'ports-pinned',
				'config-json-conflict',
				'cli-missing',
				'env-shadowed',
				'not-opted-in',
			])
		);
		expect(repo.mode).toEqual({
			value: 'observed',
			reasonText: 'stack flag missing',
		});
		expect(repo.pinnedPort).toEqual({
			port: 26_211,
			key: 'api',
			holderLabel: '~/code/work/wt-b',
		});
		expect(repo.envShadow).toEqual([
			{ file: '.env.local', line: 3, name: 'EXPO_PUBLIC_SUPABASE_URL' },
		]);
		expect(repo.cli.gate).toBe('missing');
	});

	it('drops a stack that would not parse and keeps the rest', () => {
		const lines: string[] = [];
		const state = assembleSupabaseState(
			runningInputs({
				holds: new Map([
					[
						REPO_ID,
						held([
							{
								holder: 'session',
								agent: { ...CODEX, synthetic: false },
								since: NOW,
								live: true,
								releaseAt: NOW,
							},
						]),
					],
				]),
				log: (line) => lines.push(line),
			})
		);
		expect(state.stacks.map((candidate) => candidate.id)).toEqual([WT_B_ID]);
		expect(lines.some((line) => line.includes(REPO_ID.slice(0, 8)))).toBe(true);
		expect(lines.join('\n')).not.toMatch(SECRET_SHAPED);
	});

	it('never lets a secret into the state, whatever the inputs carry', () => {
		const leaky = supabaseDesktopError('internal', 'failed');
		const state = assembleSupabaseState(
			runningInputs({
				records: [
					record({
						lastError: {
							...leaky,
							message: `connect ${SECRETS.dbUrl} with ${SECRETS.secretKey}`,
						},
					}),
				],
				discovery: {
					status: 'live',
					lastListAt: NOW,
					sessions: { claude: 'ok', codex: 'unavailable' },
					listFailure: { message: `list failed: ${SECRETS.anonKey}`, at: NOW },
				},
				interest: { view: 'stacks', inspectStackId: REPO_ID, sections: [] },
			})
		);
		expect(state.discovery.sessions).toBe('unavailable');
		assertNoSecrets(state);
	});
});

describe('supabasePathLabel', () => {
	it('shortens paths under the home directory', () => {
		expect(supabasePathLabel('/Users/example/code/app', '/Users/example')).toBe(
			'~/code/app'
		);
		expect(supabasePathLabel('/Users/example', '/Users/example')).toBe('~');
		expect(supabasePathLabel('/Users/another/app', '/Users/example')).toBe(
			'/Users/another/app'
		);
	});
});

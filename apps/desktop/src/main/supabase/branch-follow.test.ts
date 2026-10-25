import { describe, expect, it } from 'vitest';
import {
	SUPABASE_POLICY_DEFAULTS,
	type SupabaseStackSummary,
} from '../../shared/supabase-protocol';
import {
	isSupabaseStackHeld,
	nextSupabaseFollowRetry,
	observeSupabaseHeads,
	planSupabaseFollows,
	SUPABASE_FOLLOW_DEBOUNCE_MS,
	SUPABASE_FOLLOW_RETRY_MS,
} from './branch-follow';
import type { SupabaseWorktreeFacts } from './repositories';
import type { SupabaseStackRecord } from './stack-store';

const NOW = Date.UTC(2026, 9, 17, 9, 0, 0);
const WORKTREE = '/Users/example/code/example-app';
const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);

function facts(
	fields: Partial<SupabaseWorktreeFacts> & {
		branchContext?: string;
		operation?: 'MERGE_HEAD';
	} = {}
): SupabaseWorktreeFacts {
	const { branchContext = 'refs/heads/feat-x', operation, ...rest } = fields;
	return {
		worktreePath: WORKTREE,
		realWorktreePath: WORKTREE,
		appPath: WORKTREE,
		repositoryRoot: WORKTREE,
		repositoryId: 'repo-000000000000',
		branch: 'feat-x',
		exists: true,
		detection: {
			status: 'found',
			appRoot: WORKTREE,
			worktreeRoot: WORKTREE,
			projectRoot: WORKTREE,
			configPath: `${WORKTREE}/supabase/config.toml`,
			stackFlag: { optedIn: true, line: 2 },
			configConflict: false,
			pinnedListeners: [],
			shadowedAppVariables: [],
			issues: [],
		} as unknown as SupabaseWorktreeFacts['detection'],
		head: {
			status: 'ok',
			branchContext,
			gitDir: `${WORKTREE}/.git`,
			commonDir: `${WORKTREE}/.git`,
			...(operation ? { operation } : {}),
		},
		expectedStackId: NEW,
		mode: { value: 'managed' },
		bucketsConfigured: false,
		migrationCount: 0,
		...rest,
	} as SupabaseWorktreeFacts;
}

function stack(
	fields: Partial<SupabaseStackSummary> = {}
): SupabaseStackSummary {
	return {
		id: OLD,
		branchContext: 'refs/heads/main',
		runtime: 'native',
		holds: [
			{
				holder: 'session',
				agent: { kind: 'claude', sessionId: 'session-a' },
				live: true,
				since: NOW,
			},
		],
		lanes: [],
		cwdKeepers: [],
		...fields,
	} as unknown as SupabaseStackSummary;
}

const records = new Map<string, SupabaseStackRecord>([
	[
		OLD,
		{
			id: OLD,
			origin: 'managed',
			worktreePath: WORKTREE,
			projectRoot: WORKTREE,
		} as unknown as SupabaseStackRecord,
	],
]);

function plan(
	overrides: Partial<Parameters<typeof planSupabaseFollows>[0]> = {}
) {
	return planSupabaseFollows({
		policy: SUPABASE_POLICY_DEFAULTS,
		facts: [facts()],
		stacks: [stack()],
		records,
		headStableSince: new Map([[WORKTREE, NOW]]),
		now: NOW,
		...overrides,
	});
}

describe('observeSupabaseHeads', () => {
	it('starts a stable period when HEAD moves and keeps it otherwise', () => {
		const first = observeSupabaseHeads(new Map(), [facts()], NOW);
		expect(first.heads.get(WORKTREE)).toEqual({
			ref: 'refs/heads/feat-x',
			since: NOW,
		});
		expect(first.changed).toEqual([]);
		const same = observeSupabaseHeads(first.heads, [facts()], NOW + 5_000);
		expect(same.heads.get(WORKTREE)?.since).toBe(NOW);
		const moved = observeSupabaseHeads(
			same.heads,
			[facts({ branchContext: 'refs/heads/feat-y' })],
			NOW + 9_000
		);
		expect(moved.heads.get(WORKTREE)?.since).toBe(NOW + 9_000);
		expect(moved.changed).toEqual([WORKTREE]);
		// The end of a merge is a change too.
		const merging = observeSupabaseHeads(
			moved.heads,
			[facts({ branchContext: 'refs/heads/feat-y', operation: 'MERGE_HEAD' })],
			NOW + 10_000
		);
		expect(merging.changed).toEqual([WORKTREE]);
	});
});

describe('planSupabaseFollows', () => {
	it('follows each project in a checkout independently', () => {
		const mobile = `${WORKTREE}/apps/mobile`;
		const admin = `${WORKTREE}/apps/admin`;
		const adminOld = 'c'.repeat(64);
		const adminNew = 'd'.repeat(64);
		const nested = (app: string, target: string) => {
			const source = facts({ appPath: app, expectedStackId: target });
			return {
				...source,
				detection: {
					...source.detection,
					status: 'found',
					appRoot: app,
					projectRoot: app,
				},
			} as SupabaseWorktreeFacts;
		};
		const result = plan({
			now: NOW + SUPABASE_FOLLOW_DEBOUNCE_MS,
			facts: [nested(mobile, NEW), nested(admin, adminNew)],
			stacks: [stack(), stack({ id: adminOld })],
			records: new Map([
				[
					OLD,
					{ ...records.get(OLD), projectRoot: mobile } as SupabaseStackRecord,
				],
				[
					adminOld,
					{
						...records.get(OLD),
						id: adminOld,
						projectRoot: admin,
					} as SupabaseStackRecord,
				],
			]),
		});
		expect(
			result.due.map((candidate) => ({
				app: candidate.appPath,
				from: candidate.fromStackIds,
				to: candidate.toStackId,
			}))
		).toEqual([
			{ app: mobile, from: [OLD], to: NEW },
			{ app: admin, from: [adminOld], to: adminNew },
		]);
	});

	it('follows a held stack 30 s after HEAD settled on another branch', () => {
		expect(plan()).toEqual({
			due: [],
			nextDueAt: NOW + SUPABASE_FOLLOW_DEBOUNCE_MS,
		});
		expect(plan({ now: NOW + SUPABASE_FOLLOW_DEBOUNCE_MS }).due).toEqual([
			{
				worktreePath: WORKTREE,
				appPath: WORKTREE,
				projectRoot: WORKTREE,
				fromStackIds: [OLD],
				toBranchContext: 'refs/heads/feat-x',
				toStackId: NEW,
				dueAt: NOW + SUPABASE_FOLLOW_DEBOUNCE_MS,
			},
		]);
	});

	it('never follows during a git operation, from a detached HEAD, or in warn mode', () => {
		const later = NOW + 5 * 60_000;
		expect(
			plan({ now: later, facts: [facts({ operation: 'MERGE_HEAD' })] }).due
		).toEqual([]);
		expect(
			plan({ now: later, facts: [facts({ branchContext: 'detached' })] }).due
		).toEqual([]);
		expect(
			plan({
				now: later,
				policy: { ...SUPABASE_POLICY_DEFAULTS, branchSwitch: 'warn' },
			}).due
		).toEqual([]);
	});

	it('leaves unheld, container, external and busy stacks alone', () => {
		const later = NOW + 5 * 60_000;
		expect(plan({ now: later, stacks: [stack({ holds: [] })] }).due).toEqual(
			[]
		);
		expect(
			plan({ now: later, stacks: [stack({ runtime: 'docker' })] }).due
		).toEqual([]);
		expect(
			plan({
				now: later,
				records: new Map([
					[
						OLD,
						{ ...records.get(OLD), origin: 'external' } as SupabaseStackRecord,
					],
				]),
			}).due
		).toEqual([]);
		expect(plan({ now: later, busy: new Set([WORKTREE]) }).due).toEqual([]);
	});

	it('skips the debounce for a forced follow, even in warn mode', () => {
		expect(
			plan({
				policy: { ...SUPABASE_POLICY_DEFAULTS, branchSwitch: 'warn' },
				headStableSince: new Map(),
				force: OLD,
			}).due.map((candidate) => candidate.fromStackIds)
		).toEqual([[OLD]]);
	});

	it('waits longer after each failed follow to the same stack', () => {
		const first = nextSupabaseFollowRetry(undefined, NEW, NOW);
		expect(first).toEqual({
			toStackId: NEW,
			failures: 1,
			retryAt: NOW + SUPABASE_FOLLOW_RETRY_MS,
		});
		const second = nextSupabaseFollowRetry(first, NEW, NOW);
		expect(second.retryAt).toBe(NOW + 2 * SUPABASE_FOLLOW_RETRY_MS);
		let many = second;
		for (let index = 0; index < 20; index += 1) {
			many = nextSupabaseFollowRetry(many, NEW, NOW);
		}
		expect(many.retryAt).toBe(NOW + 30 * 60_000);
		// Another target starts over.
		expect(nextSupabaseFollowRetry(many, OLD, NOW).failures).toBe(1);
		const later = NOW + 5 * 60_000;
		const retries = new Map([
			[WORKTREE, { toStackId: NEW, failures: 3, retryAt: later + 60_000 }],
		]);
		expect(plan({ now: later, retries })).toEqual({
			due: [],
			nextDueAt: later + 60_000,
		});
		expect(plan({ now: later + 60_000, retries }).due).toHaveLength(1);
		// HEAD moved on: the failures were for another stack.
		const moved = new Map([
			[WORKTREE, { toStackId: OLD, failures: 3, retryAt: later + 60_000 }],
		]);
		expect(plan({ now: later, retries: moved }).due).toHaveLength(1);
		// The operator's Follow does not wait.
		expect(
			plan({ now: later, retries, headStableSince: new Map(), force: OLD }).due
		).toHaveLength(1);
	});

	it('counts lanes and sessions working there as holders', () => {
		expect(
			isSupabaseStackHeld({
				holds: [],
				lanes: [{ laneId: 'lane-1' }] as never,
				cwdKeepers: [],
			})
		).toBe(true);
		expect(isSupabaseStackHeld({ holds: [], lanes: [], cwdKeepers: [] })).toBe(
			false
		);
	});
});

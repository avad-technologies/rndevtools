import { describe, expect, it } from 'vitest';
import type { AgentSession } from '../../shared/agent-protocol';
import { DEVICE_HOLD_GRACE_MS } from '../../shared/device-hold';
import {
	SUPABASE_POLICY_DEFAULTS,
	supabaseHoldSchema,
} from '../../shared/supabase-protocol';
import {
	resolveSupabaseHolds,
	type SupabaseHoldsInput,
	sameSupabaseClocks,
	supabaseHoldAgent,
	supabaseHolderKeys,
	supabaseHoldsStack,
} from './holds';
import type { SupabaseStoredHold } from './stack-store';

const NOW = 1_792_245_785_000;
const MINUTE = 60_000;
const DAY_MS = 24 * 60 * MINUTE;
const WORKTREE = '/Users/example/code/example-app-wt/feat-checkout';
const LANE = 'lane-c69dc564-b12e-45d5-b0d5-3e9d034a072d';
const CLAUDE = { kind: 'claude' as const, sessionId: '7f3a2c91-claude' };
const CODEX = { kind: 'codex' as const, sessionId: '5d1b8f40-codex' };
const SYNTHETIC = { kind: 'codex' as const, sessionId: 'mcp-codex-mcp-client' };

function session(
	agent: { kind: 'claude' | 'codex'; sessionId: string },
	cwd?: string
): AgentSession {
	return {
		kind: agent.kind,
		sessionId: agent.sessionId,
		title: agent.sessionId,
		...(cwd === undefined ? {} : { cwd }),
	};
}

function stored(
	holder: 'session' | 'worktree',
	agent: { kind: 'claude' | 'codex' | 'other'; sessionId: string },
	since = NOW - 30 * MINUTE
): SupabaseStoredHold {
	return {
		holder,
		agent: {
			...agent,
			synthetic: agent.sessionId.startsWith('mcp-'),
		},
		since,
	};
}

function input(
	overrides: Partial<Omit<SupabaseHoldsInput, 'stack'>> & {
		stack?: Partial<SupabaseHoldsInput['stack']>;
	} = {}
): SupabaseHoldsInput {
	const { stack, ...rest } = overrides;
	return {
		now: NOW,
		policy: SUPABASE_POLICY_DEFAULTS,
		lanes: [],
		sessions: [],
		discovery: { claude: 'ok', codex: 'ok' },
		...rest,
		stack: {
			origin: 'managed',
			live: true,
			directory: WORKTREE,
			pinned: false,
			holds: [],
			orphaned: false,
			clocks: {},
			...stack,
		},
	};
}

describe('resolveSupabaseHolds', () => {
	it('keeps a stack running while a lane, session or pin holds it', () => {
		const result = resolveSupabaseHolds(
			input({
				stack: {
					pinned: true,
					pinnedAt: NOW - 10 * MINUTE,
					holds: [stored('session', CLAUDE)],
				},
				lanes: [
					{
						laneId: LANE,
						agent: CLAUDE,
						worktreePath: WORKTREE,
						since: NOW - MINUTE,
					},
					{
						laneId: 'lane-d3c29403-e3a7-4bc9-ab44-93684dacbc56',
						worktreePath: WORKTREE,
						since: NOW - 2 * MINUTE,
					},
				],
				sessions: [session(CLAUDE, '/Users/example/elsewhere')],
			})
		);
		expect(result.held).toBe(true);
		expect(result.autoStopAt).toBeUndefined();
		expect(result.holds.map((hold) => [hold.holder, hold.live])).toEqual([
			['operator', true],
			['lane', true],
			['lane', true],
			['session', true],
		]);
		for (const hold of result.holds) supabaseHoldSchema.parse(hold);
		expect(result.clocks).toEqual({});
	});

	it('starts an abandonment clock and stops after the grace', () => {
		const first = resolveSupabaseHolds(
			input({ stack: { holds: [stored('session', CODEX)] } })
		);
		expect(first.held).toBe(false);
		expect(first.holds[0]).toMatchObject({
			holder: 'session',
			live: false,
			abandonedSince: NOW,
			releaseAt: NOW + DEVICE_HOLD_GRACE_MS,
		});
		expect(first.clocks).toEqual({
			[`codex:${CODEX.sessionId}`]: { missingSince: NOW },
		});
		expect(first).toMatchObject({
			autoStopAt: NOW + DEVICE_HOLD_GRACE_MS,
			autoStopReason: 'abandoned',
			clocksPaused: false,
		});

		// A persisted clock survives a desktop restart: the deadline does not move.
		const later = resolveSupabaseHolds(
			input({
				now: NOW + 4 * MINUTE,
				stack: { holds: [stored('session', CODEX)], clocks: first.clocks },
			})
		);
		expect(later.autoStopAt).toBe(NOW + DEVICE_HOLD_GRACE_MS);
		expect(sameSupabaseClocks(later.clocks, first.clocks)).toBe(true);

		// The holder came back: its clock is dropped.
		const back = resolveSupabaseHolds(
			input({
				stack: { holds: [stored('session', CODEX)], clocks: first.clocks },
				sessions: [session(CODEX)],
			})
		);
		expect(back.held).toBe(true);
		expect(back.clocks).toEqual({});
	});

	it('stops when the last of several abandoned holders runs out', () => {
		const result = resolveSupabaseHolds(
			input({
				stack: {
					holds: [stored('session', CODEX), stored('session', CLAUDE)],
					clocks: {
						[`codex:${CODEX.sessionId}`]: { missingSince: NOW - 8 * MINUTE },
						[`claude:${CLAUDE.sessionId}`]: { missingSince: NOW - 2 * MINUTE },
					},
				},
			})
		);
		expect(result.autoStopAt).toBe(NOW - 2 * MINUTE + DEVICE_HOLD_GRACE_MS);
	});

	it('pauses clocks while an agent kind cannot be seen, then resumes them', () => {
		const running = {
			[`codex:${CODEX.sessionId}`]: { missingSince: NOW - 4 * MINUTE },
		};
		const paused = resolveSupabaseHolds(
			input({
				stack: { holds: [stored('session', CODEX)], clocks: running },
				discovery: { claude: 'ok', codex: 'unavailable' },
			})
		);
		expect(paused.clocksPaused).toBe(true);
		expect(paused.autoStopAt).toBeUndefined();
		expect(paused.holds[0]).toMatchObject({ live: false });
		expect(paused.holds[0]?.releaseAt).toBeUndefined();
		expect(paused.clocks).toEqual({
			[`codex:${CODEX.sessionId}`]: { pausedElapsedMs: 4 * MINUTE },
		});

		// Twenty minutes later the kind is visible again: four minutes had run.
		const resumed = resolveSupabaseHolds(
			input({
				now: NOW + 20 * MINUTE,
				stack: { holds: [stored('session', CODEX)], clocks: paused.clocks },
			})
		);
		expect(resumed.clocks).toEqual({
			[`codex:${CODEX.sessionId}`]: { missingSince: NOW + 16 * MINUTE },
		});
		expect(resumed.autoStopAt).toBe(NOW + 16 * MINUTE + DEVICE_HOLD_GRACE_MS);
	});

	it('never starts a clock or a linger while sessions cannot be read', () => {
		const abandoned = resolveSupabaseHolds(
			input({
				stack: { holds: [stored('session', CLAUDE)] },
				discovery: { claude: 'ok', codex: 'unavailable' },
			})
		);
		// Claude's clock runs, but a Codex session might still work there.
		expect(abandoned.clocks).toEqual({
			[`claude:${CLAUDE.sessionId}`]: { missingSince: NOW },
		});
		expect(abandoned.clocksPaused).toBe(true);
		expect(abandoned.autoStopAt).toBeUndefined();

		const unheld = resolveSupabaseHolds(
			input({
				stack: { releasedAt: NOW - MINUTE },
				discovery: { claude: 'unavailable', codex: 'ok' },
			})
		);
		expect(unheld.clocksPaused).toBe(true);
		expect(unheld.autoStopAt).toBeUndefined();
	});

	it('keeps a synthetic worktree hold live while a session of its kind works there', () => {
		const live = resolveSupabaseHolds(
			input({
				stack: { holds: [stored('worktree', SYNTHETIC)] },
				sessions: [session(CODEX, `${WORKTREE}/apps/mobile`)],
			})
		);
		expect(live.holds[0]).toMatchObject({
			holder: 'worktree',
			live: true,
			agent: { synthetic: true },
		});
		expect(live.held).toBe(true);
		expect(live.cwdKeepers).toEqual([]);

		const gone = resolveSupabaseHolds(
			input({
				stack: { holds: [stored('worktree', SYNTHETIC)] },
				sessions: [session(CODEX, '/Users/example/code/other')],
			})
		);
		expect(gone.holds[0]).toMatchObject({ live: false });
		expect(Object.keys(gone.clocks)).toEqual([
			`codex:${SYNTHETIC.sessionId}@${WORKTREE}`,
		]);
	});

	it('keeps an unheld stack running for a live session in its worktree', () => {
		const kept = resolveSupabaseHolds(
			input({
				stack: { releasedAt: NOW - 5 * MINUTE },
				sessions: [session(CLAUDE, `${WORKTREE}/src`), session(CODEX, '/tmp')],
			})
		);
		expect(kept.held).toBe(true);
		expect(kept.autoStopAt).toBeUndefined();
		expect(kept.cwdKeepers).toEqual([
			{ agent: supabaseHoldAgent(CLAUDE), cwd: `${WORKTREE}/src` },
		]);

		// The requester's own down ignores its cwd.
		const down = resolveSupabaseHolds(
			input({
				stack: { releasedAt: NOW - 5 * MINUTE },
				sessions: [session(CLAUDE, `${WORKTREE}/src`)],
				ignore: { holder: CLAUDE },
			})
		);
		expect(down.cwdKeepers).toEqual([]);
		expect(down.autoStopAt).toBe(
			NOW - 5 * MINUTE + SUPABASE_POLICY_DEFAULTS.unheldStopDelayMs
		);

		// A synthetic requester is matched by where it asked from.
		const synthetic = resolveSupabaseHolds(
			input({
				sessions: [
					session(CODEX, `${WORKTREE}/apps/mobile`),
					session(
						{ kind: 'codex', sessionId: 'other-codex' },
						`${WORKTREE}/docs`
					),
				],
				ignore: {
					holder: SYNTHETIC,
					sessionCwd: `${WORKTREE}/apps/mobile`,
				},
			})
		);
		expect(
			synthetic.cwdKeepers.map((keeper) => keeper.agent.sessionId)
		).toEqual(['other-codex']);
	});

	it('stops 60 s after the last release, recording when that was', () => {
		const fresh = resolveSupabaseHolds(input());
		expect(fresh).toMatchObject({
			held: false,
			release: { at: NOW },
			autoStopAt: NOW + SUPABASE_POLICY_DEFAULTS.unheldStopDelayMs,
			autoStopReason: 'released',
		});
		const recorded = resolveSupabaseHolds(
			input({ stack: { releasedAt: NOW - 30_000 } })
		);
		expect(recorded.release).toBeUndefined();
		expect(recorded.autoStopAt).toBe(NOW + 30_000);
		const superseded = resolveSupabaseHolds(
			input({ stack: { supersededAt: NOW - 10_000 } })
		);
		expect(superseded).toMatchObject({
			autoStopAt: NOW + 50_000,
			autoStopReason: 'superseded',
			release: { at: NOW - 10_000 },
		});
	});

	it('restarts the linger from the last release, never an older one', () => {
		// A session released while a lane still held the stack...
		const laneHeld = resolveSupabaseHolds(
			input({
				stack: { releasedAt: NOW - 60 * MINUTE },
				lanes: [{ laneId: LANE, worktreePath: WORKTREE, since: NOW - DAY_MS }],
			})
		);
		expect(laneHeld.release).toBe('clear');
		expect(laneHeld.autoStopAt).toBeUndefined();
		// ...so once the lane goes, the linger starts now, not an hour ago.
		const afterLane = resolveSupabaseHolds(input());
		expect(afterLane.release).toEqual({ at: NOW });
		expect(afterLane.autoStopAt).toBe(
			NOW + SUPABASE_POLICY_DEFAULTS.unheldStopDelayMs
		);
		// Nothing to clear when nothing was recorded.
		expect(
			resolveSupabaseHolds(
				input({
					lanes: [{ laneId: LANE, worktreePath: WORKTREE, since: NOW }],
				})
			).release
		).toBeUndefined();
	});

	it('keeps ignoring the session whose own down released the stack', () => {
		const result = resolveSupabaseHolds(
			input({
				stack: {
					releasedAt: NOW - 10_000,
					releasedBy: { holder: CLAUDE },
				},
				sessions: [session(CLAUDE, `${WORKTREE}/src`)],
			})
		);
		expect(result.cwdKeepers).toEqual([]);
		expect(result.release).toBeUndefined();
		expect(result.autoStopAt).toBe(
			NOW - 10_000 + SUPABASE_POLICY_DEFAULTS.unheldStopDelayMs
		);
		// Another session working there still keeps it, and clears the release.
		const kept = resolveSupabaseHolds(
			input({
				stack: {
					releasedAt: NOW - 10_000,
					releasedBy: { holder: CLAUDE },
				},
				sessions: [session(CODEX, `${WORKTREE}/docs`)],
			})
		);
		expect(kept.held).toBe(true);
		expect(kept.release).toBe('clear');
	});

	it('stops an orphaned stack at once, but never a pinned or external one', () => {
		expect(
			resolveSupabaseHolds(
				input({
					stack: {
						orphaned: true,
						orphanedAt: NOW - 15_000,
						holds: [stored('session', CLAUDE)],
					},
					sessions: [session(CLAUDE)],
				})
			)
		).toMatchObject({ autoStopAt: NOW - 15_000, autoStopReason: 'orphaned' });
		const pinned = resolveSupabaseHolds(
			input({ stack: { orphaned: true, pinned: true } })
		);
		expect(pinned.autoStopAt).toBeUndefined();
		const external = resolveSupabaseHolds(
			input({ stack: { origin: 'external' } })
		);
		expect(external.autoStopAt).toBeUndefined();
		expect(external.release).toBeUndefined();
		const stopped = resolveSupabaseHolds(input({ stack: { live: false } }));
		expect(stopped.autoStopAt).toBeUndefined();
	});

	it('counts other agents as live, since nothing discovers their sessions', () => {
		const result = resolveSupabaseHolds(
			input({
				stack: {
					holds: [stored('session', { kind: 'other', sessionId: 'other-1' })],
				},
			})
		);
		expect(result.holds[0]).toMatchObject({ live: true });
		expect(result.autoStopAt).toBeUndefined();
		expect(result.clocks).toEqual({});
	});

	it('keeps a monorepo lane live while Codex works over MCP from the checkout root', () => {
		// The lane's app is apps/mobile; Codex calls over MCP (one synthetic
		// holder) from the repository root, above it.
		const lanes = [
			{
				laneId: LANE,
				agent: SYNTHETIC,
				worktreePath: WORKTREE,
				since: NOW - MINUTE,
			},
		];
		const atRoot = resolveSupabaseHolds(
			input({ lanes, sessions: [session(CODEX, WORKTREE)] })
		);
		expect(atRoot.holds[0]).toMatchObject({
			holder: 'lane',
			laneId: LANE,
			live: true,
			agent: { kind: 'codex', sessionId: SYNTHETIC.sessionId, synthetic: true },
		});
		expect(atRoot.held).toBe(true);
		// The live hold stands for that session, so it is not a keeper too.
		expect(atRoot.cwdKeepers).toEqual([]);
		expect(atRoot.clocks).toEqual({});

		// From a sibling checkout the lane is gone; its clock is keyed by the
		// checkout, as its device hold's is.
		const sibling = resolveSupabaseHolds(
			input({ lanes, sessions: [session(CODEX, `${WORKTREE}-2`)] })
		);
		expect(sibling.holds[0]).toMatchObject({ holder: 'lane', live: false });
		expect(Object.keys(sibling.clocks)).toEqual([
			`codex:${SYNTHETIC.sessionId}@${WORKTREE}`,
		]);
	});

	it('bounds the holds it reports to 16', () => {
		const holds = Array.from({ length: 16 }, (_, index) =>
			stored('session', { kind: 'claude', sessionId: `claude-${index}` })
		);
		const result = resolveSupabaseHolds(
			input({ stack: { pinned: true, holds } })
		);
		expect(result.holds).toHaveLength(16);
		expect(result.holds[0]?.holder).toBe('operator');
	});
});

describe('supabaseHoldsStack', () => {
	it('maps a stored record onto the holds input', () => {
		const stack = supabaseHoldsStack(
			{
				origin: 'adopted',
				projectRoot: `${WORKTREE}/apps/mobile`,
				worktreePath: WORKTREE,
				pinned: true,
				pinnedAt: NOW - MINUTE,
				holds: [stored('session', CLAUDE)],
				releasedAt: NOW - 2 * MINUTE,
				releasedBy: { holder: CODEX, sessionCwd: `${WORKTREE}/docs` },
				flags: { supersededAt: NOW - 3 * MINUTE },
				clocks: { [`claude:${CLAUDE.sessionId}`]: { missingSince: NOW } },
			},
			{ live: true, orphaned: false }
		);
		expect(stack).toEqual({
			origin: 'adopted',
			live: true,
			directory: WORKTREE,
			pinned: true,
			pinnedAt: NOW - MINUTE,
			holds: [stored('session', CLAUDE)],
			releasedAt: NOW - 2 * MINUTE,
			releasedBy: { holder: CODEX, sessionCwd: `${WORKTREE}/docs` },
			supersededAt: NOW - 3 * MINUTE,
			orphaned: false,
			clocks: { [`claude:${CLAUDE.sessionId}`]: { missingSince: NOW } },
		});
		// The result feeds resolveSupabaseHolds as it is.
		expect(resolveSupabaseHolds(input({ stack })).holds[0]?.holder).toBe(
			'operator'
		);
	});
});

describe('holder keys and clocks', () => {
	it('names every stored holder once, with its stack directory', () => {
		const keys = supabaseHolderKeys([
			{
				holds: [stored('session', CLAUDE), stored('worktree', SYNTHETIC)],
				worktreePath: WORKTREE,
				projectRoot: WORKTREE,
			},
			{
				holds: [stored('session', CLAUDE)],
				projectRoot: '/Users/example/code/other',
			},
			{
				holds: [stored('worktree', SYNTHETIC)],
				projectRoot: '/Users/example/code/other',
			},
		]);
		expect(keys).toEqual([
			{ holder: CLAUDE, directory: WORKTREE },
			{ holder: SYNTHETIC, directory: WORKTREE },
			{ holder: SYNTHETIC, directory: '/Users/example/code/other' },
		]);
	});

	it('compares clock maps', () => {
		expect(
			sameSupabaseClocks({ a: { missingSince: 1 } }, { a: { missingSince: 1 } })
		).toBe(true);
		expect(
			sameSupabaseClocks(
				{ a: { missingSince: 1 } },
				{ a: { pausedElapsedMs: 1 } }
			)
		).toBe(false);
		expect(sameSupabaseClocks({}, { a: { missingSince: 1 } })).toBe(false);
	});
});

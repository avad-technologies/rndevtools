import { describe, expect, it } from 'vitest';
import {
	DEVICE_HOLD_GRACE_MS,
	decideDeviceAccess,
	formatHoldDuration,
	freeDevices,
	type HoldCountdownInput,
	type HoldCountdownOptions,
	holdCountdownLabel,
	holderClockKey,
	isPathInside,
	isSyntheticHolder,
	resolveDeviceHolds,
	resolveHolderLiveness,
} from './device-hold';

const A = 'AAAAAAAA-0000-4000-8000-000000000001';
const B = 'AAAAAAAA-0000-4000-8000-000000000002';
const C = 'AAAAAAAA-0000-4000-8000-000000000003';
const now = 1_700_000_000_000;
const claude = { kind: 'claude', sessionId: 's1' } as const;
const codex = { kind: 'codex', sessionId: 't1' } as const;

function lane(
	udid: string,
	agent?: { kind: 'claude' | 'codex' | 'other'; sessionId: string }
) {
	return {
		id: `lane-${udid.slice(-1)}`,
		simulatorUdid: udid.toLowerCase(),
		metro: 'ready' as const,
		startedAt: now - 60_000,
		...(agent ? { agent: { ...agent, lastSeenAt: now } } : {}),
	};
}

describe('resolveDeviceHolds', () => {
	it('derives one hold per device, lane over claim, canonical UDID', () => {
		const holds = resolveDeviceHolds({
			lanes: [lane(A, claude)],
			claims: [
				{ simulatorUdid: A, ...codex },
				{ simulatorUdid: B, ...codex },
			],
			liveSessionKeys: new Set(['claude:s1', 'codex:t1']),
			missingSince: new Map(),
			now,
		});
		expect(holds.get(A)).toEqual({
			simulatorUdid: A,
			via: 'lane',
			laneId: 'lane-1',
			holder: claude,
			holderLive: true,
		});
		expect(holds.get(B)).toMatchObject({
			via: 'claim',
			holder: codex,
			holderLive: true,
		});
		expect(holds.has(C)).toBe(false);
	});

	it('lets a starting lane hold a free device but never take one a claim already has', () => {
		const holds = resolveDeviceHolds({
			lanes: [
				{ ...lane(A, claude), starting: true },
				{ ...lane(B, claude), starting: true },
			],
			claims: [{ simulatorUdid: B, ...codex }],
			liveSessionKeys: new Set(['claude:s1', 'codex:t1']),
			missingSince: new Map(),
			now,
		});
		expect(holds.get(A)).toMatchObject({
			via: 'lane',
			laneId: 'lane-1',
			holder: claude,
		});
		expect(holds.get(B)).toMatchObject({ via: 'claim', holder: codex });
		// So the claimant keeps its device, and the start is the one refused.
		expect(decideDeviceAccess(holds.get(A), codex, now).allowed).toBe(false);
		expect(decideDeviceAccess(holds.get(B), claude, now).allowed).toBe(false);
	});

	it('marks a hold abandoned when its session is gone and schedules the release', () => {
		const since = now - 4 * 60_000;
		const holds = resolveDeviceHolds({
			lanes: [lane(A, claude)],
			claims: [],
			liveSessionKeys: new Set(),
			missingSince: new Map([['claude:s1', since]]),
			now,
		});
		expect(holds.get(A)).toMatchObject({
			holderLive: false,
			abandonedSince: since,
			releaseAt: since + DEVICE_HOLD_GRACE_MS,
		});
		// First sighting of a missing holder starts the clock now.
		const fresh = resolveDeviceHolds({
			lanes: [lane(A, claude)],
			claims: [],
			liveSessionKeys: new Set(),
			missingSince: new Map(),
			now,
		});
		expect(fresh.get(A)?.releaseAt).toBe(now + DEVICE_HOLD_GRACE_MS);
	});

	it('treats an operator-started lane as live and owned by nobody', () => {
		const holds = resolveDeviceHolds({
			lanes: [lane(A)],
			claims: [],
			liveSessionKeys: new Set(),
			missingSince: new Map(),
			now,
		});
		expect(holds.get(A)).toEqual({
			simulatorUdid: A,
			via: 'lane',
			laneId: 'lane-1',
			holderLive: true,
		});
	});
});

describe('decideDeviceAccess', () => {
	const held = resolveDeviceHolds({
		lanes: [lane(A, claude), lane(C)],
		claims: [{ simulatorUdid: B, ...codex }],
		liveSessionKeys: new Set(['claude:s1', 'codex:t1']),
		missingSince: new Map(),
		now,
	});

	it('lets the holder, and the operator, through; refuses other agents with the owner named', () => {
		expect(decideDeviceAccess(held.get(A), claude, now)).toEqual({
			allowed: true,
		});
		expect(decideDeviceAccess(held.get(A), undefined, now)).toEqual({
			allowed: true,
		});
		expect(decideDeviceAccess(undefined, codex, now)).toEqual({
			allowed: true,
		});
		const refused = decideDeviceAccess(held.get(A), codex, now);
		expect(refused.allowed).toBe(false);
		if (!refused.allowed) {
			expect(refused.reason).toContain('claude session s1');
			expect(refused.reason).toContain('lane lane-1');
		}
		const claimRefused = decideDeviceAccess(held.get(B), claude, now);
		expect(claimRefused.allowed).toBe(false);
		if (!claimRefused.allowed) expect(claimRefused.reason).toContain('a claim');
	});

	it('refuses agents on an operator-started lane', () => {
		const refused = decideDeviceAccess(held.get(C), claude, now);
		expect(refused.allowed).toBe(false);
		if (!refused.allowed) expect(refused.reason).toContain('the operator');
	});

	it('opens an abandoned hold only once the grace period has passed', () => {
		const since = now - 3 * 60_000;
		const abandoned = resolveDeviceHolds({
			lanes: [lane(A, claude)],
			claims: [],
			liveSessionKeys: new Set(),
			missingSince: new Map([['claude:s1', since]]),
			now,
		}).get(A);
		const early = decideDeviceAccess(abandoned, codex, now);
		expect(early.allowed).toBe(false);
		if (!early.allowed) expect(early.reason).toMatch(/releases in 7 min/);
		expect(
			decideDeviceAccess(abandoned, codex, since + DEVICE_HOLD_GRACE_MS)
		).toEqual({ allowed: true });
	});
});

describe('freeDevices', () => {
	it('lists devices with no live hold, including abandoned holds past grace', () => {
		const since = now - DEVICE_HOLD_GRACE_MS - 1;
		const holds = resolveDeviceHolds({
			lanes: [lane(A, claude)],
			claims: [{ simulatorUdid: B, ...codex }],
			liveSessionKeys: new Set(['codex:t1']),
			missingSince: new Map([['claude:s1', since]]),
			now,
		});
		expect(freeDevices([A, B, C], holds, now)).toEqual([A, C]);
	});
});

describe('resolveHolderLiveness', () => {
	const app = '/Users/dev/app-checkout';
	const synthetic = {
		kind: 'codex',
		sessionId: 'mcp-codex-mcp-client',
	} as const;
	const inputs = {
		liveSessionKeys: new Set(['claude:s1']),
		liveSessions: [
			{ kind: 'codex' as const, cwd: `${app}/src/` },
			{ kind: 'claude' as const, cwd: '/Users/dev/app-onboarding' },
		],
		missingSince: new Map<string, number>(),
		now,
	};

	it('treats the operator and live sessions as live, and runs a clock for the rest', () => {
		expect(resolveHolderLiveness(undefined, inputs)).toEqual({ live: true });
		expect(resolveHolderLiveness(claude, inputs)).toEqual({ live: true });
		const since = now - 60_000;
		expect(
			resolveHolderLiveness(codex, {
				...inputs,
				missingSince: new Map([['codex:t1', since]]),
			})
		).toEqual({
			live: false,
			abandonedSince: since,
			releaseAt: since + DEVICE_HOLD_GRACE_MS,
		});
		// No clock yet: missing from now, so the release never comes closer.
		expect(resolveHolderLiveness(codex, inputs)).toEqual({
			live: false,
			abandonedSince: now,
			releaseAt: now + DEVICE_HOLD_GRACE_MS,
		});
	});

	it('keeps a synthetic holder live only while a session of its kind works inside the directory', () => {
		expect(isSyntheticHolder(synthetic)).toBe(true);
		expect(isSyntheticHolder(codex)).toBe(false);
		expect(resolveHolderLiveness(synthetic, inputs, app)).toEqual({
			live: true,
		});
		// A sibling directory, another kind's session, or no directory at all.
		expect(
			resolveHolderLiveness(synthetic, inputs, '/Users/dev/app-check').live
		).toBe(false);
		expect(
			resolveHolderLiveness(
				{ kind: 'claude', sessionId: 'mcp-claude-code' },
				inputs,
				app
			).live
		).toBe(false);
		expect(resolveHolderLiveness(synthetic, inputs).live).toBe(false);
	});

	it('gives a synthetic holder one clock per directory and a session one clock overall', () => {
		expect(holderClockKey(synthetic, app)).not.toBe(
			holderClockKey(synthetic, '/Users/dev/app-onboarding')
		);
		expect(holderClockKey(synthetic, `${app}/`)).toBe(
			holderClockKey(synthetic, app)
		);
		expect(holderClockKey(codex, app)).toBe(holderClockKey(codex));
		const since = now - 2 * 60_000;
		expect(
			resolveHolderLiveness(
				synthetic,
				{
					...inputs,
					missingSince: new Map([
						[holderClockKey(synthetic, '/Users/dev/other'), since],
					]),
				},
				'/Users/dev/other'
			)
		).toMatchObject({ abandonedSince: since });
	});

	it('matches paths by whole segments', () => {
		expect(isPathInside('/Users/dev/app', '/Users/dev/app/')).toBe(true);
		expect(isPathInside('/Users/dev/app/src', '/Users/dev/app')).toBe(true);
		expect(isPathInside('/Users/dev/app-2', '/Users/dev/app')).toBe(false);
		expect(isPathInside('/Users/dev', '/Users/dev/app')).toBe(false);
	});

	it('judges synthetic lane holders against the lane checkout', () => {
		const holds = resolveDeviceHolds({
			...inputs,
			lanes: [
				{ ...lane(A, synthetic), worktreePath: app },
				{ ...lane(B, synthetic), worktreePath: '/Users/dev/app-onboarding' },
			],
			claims: [{ simulatorUdid: C, ...synthetic }],
		});
		expect(holds.get(A)).toMatchObject({ holder: synthetic, holderLive: true });
		expect(holds.get(B)).toMatchObject({ holderLive: false });
		// A claim has no directory, so a synthetic claim is never live by cwd.
		expect(holds.get(C)).toMatchObject({ via: 'claim', holderLive: false });
	});

	it('keeps a monorepo app lane live while a session works from the checkout root', () => {
		// The lane's Expo app is /Users/dev/repo/examples/expo-demo; Codex runs
		// from the repository root, above it.
		const repo = '/Users/dev/repo';
		const atRoot = {
			...inputs,
			liveSessions: [{ kind: 'codex' as const, cwd: repo }],
		};
		const holds = resolveDeviceHolds({
			...atRoot,
			lanes: [{ ...lane(A, synthetic), worktreePath: repo }],
			claims: [],
		});
		expect(holds.get(A)).toMatchObject({ holder: synthetic, holderLive: true });
		expect(
			decideDeviceAccess(holds.get(A), codex, now, {
				directory: repo,
				requesterCwd: repo,
			})
		).toEqual({ allowed: true });
		// A sibling checkout is still someone else's.
		expect(
			resolveHolderLiveness(synthetic, atRoot, '/Users/dev/repo-2').live
		).toBe(false);
	});
});

describe('decideDeviceAccess for synthetic holders', () => {
	const app = '/Users/dev/app-checkout';
	const synthetic = {
		kind: 'codex',
		sessionId: 'mcp-codex-mcp-client',
	} as const;
	const hold = resolveDeviceHolds({
		lanes: [{ ...lane(A, synthetic), worktreePath: app }],
		claims: [],
		liveSessionKeys: new Set(),
		liveSessions: [{ kind: 'codex', cwd: app }],
		missingSince: new Map(),
		now,
	}).get(A);

	it('lets the shared id through, and a session of its kind working inside the lane', () => {
		expect(decideDeviceAccess(hold, synthetic, now)).toEqual({ allowed: true });
		expect(
			decideDeviceAccess(hold, codex, now, {
				directory: app,
				requesterCwd: `${app}/src`,
			})
		).toEqual({ allowed: true });
	});

	it('refuses sessions working elsewhere, other kinds, and unknown working directories', () => {
		for (const [requester, scope] of [
			[codex, { directory: app, requesterCwd: '/Users/dev/app-onboarding' }],
			[codex, { directory: app }],
			[codex, undefined],
			[claude, { directory: app, requesterCwd: app }],
			[
				{ kind: 'codex', sessionId: 'mcp-other-client' },
				{ directory: app, requesterCwd: app },
			],
		] as const) {
			const decision = decideDeviceAccess(hold, requester, now, scope);
			expect(decision.allowed).toBe(false);
			if (!decision.allowed) {
				expect(decision.reason).toContain('codex session mcp-codex-mcp-client');
			}
		}
	});

	it('never lets a synthetic requester through a real session’s hold', () => {
		const real = resolveDeviceHolds({
			lanes: [{ ...lane(A, codex), worktreePath: app }],
			claims: [],
			liveSessionKeys: new Set(['codex:t1']),
			missingSince: new Map(),
			now,
		}).get(A);
		expect(
			decideDeviceAccess(real, synthetic, now, {
				directory: app,
				requesterCwd: app,
			}).allowed
		).toBe(false);
	});
});

describe('formatHoldDuration', () => {
	it.each([
		[0, '1 s'],
		[400, '1 s'],
		[45_000, '45 s'],
		[59_001, '1 min'],
		[60_000, '1 min'],
		[7 * 60_000 - 1, '7 min'],
		[59 * 60_000 + 30_000, '1 h'],
		[3 * 3_600_000, '3 h'],
		[47 * 3_600_000, '47 h'],
		[48 * 3_600_000, '2 days'],
		[86_400_000 * 3 - 1, '3 days'],
		[-5_000, '1 s'],
		[Number.NaN, '1 s'],
	])('formats %d ms as %s', (ms, text) => {
		expect(formatHoldDuration(ms)).toBe(text);
	});
});

describe('holdCountdownLabel', () => {
	const cases: readonly [
		string,
		HoldCountdownInput,
		HoldCountdownOptions,
		ReturnType<typeof holdCountdownLabel>,
	][] = [
		[
			'a live session',
			{ live: true, holder: 'session' },
			{},
			{ text: 'live', tone: 'success' },
		],
		[
			'a live synthetic holder',
			{ live: true, holder: 'lane', synthetic: true },
			{},
			{ text: 'by worktree', tone: 'success' },
		],
		[
			'a live worktree hold',
			{ live: true, holder: 'worktree' },
			{ verb: 'stops' },
			{ text: 'by worktree', tone: 'success' },
		],
		[
			'the operator',
			{ live: true, holder: 'operator' },
			{ clocksPaused: true },
			{ text: 'operator', tone: 'default' },
		],
		[
			'an abandoned stack hold',
			{ live: false, holder: 'session', releaseAt: now + 7 * 60_000 },
			{ verb: 'stops' },
			{
				text: 'gone · stops in 7 min',
				tone: 'warning',
				remainingMs: 7 * 60_000,
			},
		],
		[
			'an abandoned device hold',
			{ live: false, holder: 'lane', releaseAt: now + 45_000 },
			{},
			{
				text: 'gone · releases in 45 s',
				tone: 'warning',
				remainingMs: 45_000,
			},
		],
		[
			'a hold whose clock ran out',
			{ live: false, releaseAt: now - 1 },
			{ verb: 'stops' },
			{ text: 'gone · stopping now', tone: 'warning', remainingMs: 0 },
		],
		[
			'a device hold whose clock ran out',
			{ live: false, releaseAt: now },
			{},
			{ text: 'gone · releasing now', tone: 'warning', remainingMs: 0 },
		],
		[
			'a gone holder with no clock yet',
			{ live: false, holder: 'claim' },
			{},
			{ text: 'gone', tone: 'warning' },
		],
		[
			'a gone holder while clocks are paused',
			{ live: false, holder: 'session', releaseAt: now + 60_000 },
			{ clocksPaused: true, verb: 'stops' },
			{ text: 'clocks paused', tone: 'info' },
		],
	];

	it.each(cases)('labels %s', (_name, hold, options, expected) => {
		expect(holdCountdownLabel(hold, now, options)).toEqual(expected);
	});

	it('reads a resolved device hold directly', () => {
		const since = now - 3 * 60_000;
		const hold = resolveDeviceHolds({
			lanes: [lane(A, claude)],
			claims: [],
			liveSessionKeys: new Set(),
			missingSince: new Map([['claude:s1', since]]),
			now,
		}).get(A);
		expect(hold).toBeDefined();
		if (!hold) return;
		expect(
			holdCountdownLabel(
				{
					live: hold.holderLive,
					releaseAt: hold.releaseAt,
					holder: hold.via,
				},
				now
			).text
		).toBe('gone · releases in 7 min');
	});
});

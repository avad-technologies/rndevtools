import { describe, expect, it } from 'vitest';
import {
	SUPABASE_MIN_FREE_SYSV_SEGMENTS,
	SUPABASE_REASONS,
} from '../../shared/supabase-protocol';
import {
	decideSupabaseAdmission,
	SUPABASE_CREATION_CONCURRENCY,
	SUPABASE_LIFECYCLE_CONCURRENCY,
	SUPABASE_MAX_CLI_CHILDREN,
	type SupabaseAdmissionInput,
	type SupabaseAdmissionStack,
	supabaseAdmissionCandidates,
	supabaseNextToStop,
	supabaseRunningCap,
} from './admission';

function hex(seed: number): string {
	return seed.toString(16).padStart(64, '0');
}

function admission(
	overrides: Partial<SupabaseAdmissionInput> = {}
): SupabaseAdmissionInput {
	return {
		running: 3,
		starting: 0,
		cap: 12,
		sysv: { used: 6, limit: 32 },
		memoryPressure: 'normal',
		candidates: [],
		...overrides,
	};
}

describe('supabaseRunningCap', () => {
	it('derives the cap from shmmni unless the operator set one', () => {
		expect(supabaseRunningCap({ maxRunning: 12, shmmni: 32 })).toEqual({
			cap: 12,
			derivedCap: 12,
		});
		expect(supabaseRunningCap({ maxRunning: 12, shmmni: 16 })).toEqual({
			cap: 4,
			derivedCap: 4,
		});
		expect(supabaseRunningCap({ maxRunning: 12, shmmni: 9 })).toEqual({
			cap: 1,
			derivedCap: 1,
		});
		expect(supabaseRunningCap({ maxRunning: 12 })).toEqual({
			cap: 12,
			derivedCap: 12,
		});
		// An operator override stands, within 1-24, above or below the derived cap.
		expect(supabaseRunningCap({ maxRunning: 6, shmmni: 32 })).toEqual({
			cap: 6,
			derivedCap: 12,
		});
		expect(supabaseRunningCap({ maxRunning: 20, shmmni: 16 })).toEqual({
			cap: 20,
			derivedCap: 4,
		});
	});
});

describe('decideSupabaseAdmission', () => {
	it('allows a start below the cap with free segments', () => {
		expect(decideSupabaseAdmission(admission())).toEqual({
			kind: 'allow',
			warnings: [],
		});
		expect(
			decideSupabaseAdmission(
				admission({ memoryPressure: 'warning', sysv: null })
			)
		).toEqual({ kind: 'allow', warnings: ['memory-warning', 'sysv-unknown'] });
	});

	it('refuses at critical memory pressure, whatever else is free', () => {
		expect(
			decideSupabaseAdmission(
				admission({
					memoryPressure: 'critical',
					candidates: [{ stackId: hex(1) }],
				})
			)
		).toEqual({
			kind: 'refuse',
			reason: 'memory',
			message: SUPABASE_REASONS.memoryCritical,
		});
	});

	it('stops the least recently used unheld stack when the cap is full', () => {
		expect(
			decideSupabaseAdmission(
				admission({
					running: 11,
					starting: 1,
					candidates: [
						{ stackId: hex(1), lastUsedAt: 300 },
						{ stackId: hex(2), lastUsedAt: 100 },
						{ stackId: hex(3), lastUsedAt: 200 },
					],
				})
			)
		).toEqual({ kind: 'stop-lru', stackId: hex(2), reason: 'capacity' });
		expect(
			decideSupabaseAdmission(admission({ running: 12, candidates: [] }))
		).toEqual({
			kind: 'refuse',
			reason: 'capacity',
			message: SUPABASE_REASONS.capacityFull(12, 12),
		});
	});

	it('needs two free SysV segments, counting starts in flight', () => {
		expect(
			decideSupabaseAdmission(
				admission({ sysv: { used: 30, limit: 32 }, starting: 1 })
			)
		).toEqual({
			kind: 'refuse',
			reason: 'sysv',
			message:
				'Only 1 Postgres slot is free; a start needs 2. Stop an idle stack first.',
		});
		expect(
			decideSupabaseAdmission(admission({ sysv: { used: 32, limit: 32 } }))
		).toMatchObject({
			kind: 'refuse',
			message:
				'No Postgres slot is free; a start needs 2. Stop an idle stack first.',
		});
		expect(
			decideSupabaseAdmission(
				admission({
					sysv: { used: 31, limit: 32 },
					candidates: [{ stackId: hex(4) }],
				})
			)
		).toEqual({ kind: 'stop-lru', stackId: hex(4), reason: 'sysv' });
		expect(
			decideSupabaseAdmission(admission({ sysv: { used: 30, limit: 32 } }))
		).toEqual({ kind: 'allow', warnings: [] });
	});
});

describe('admission candidates', () => {
	const stack = (
		seed: number,
		overrides: Partial<SupabaseAdmissionStack> = {}
	): SupabaseAdmissionStack => ({
		stackId: hex(seed),
		origin: 'managed',
		running: true,
		pinned: false,
		held: false,
		inFlight: false,
		lastUsedAt: seed * 100,
		...overrides,
	});

	it('offers only unheld, unpinned, running managed stacks, LRU first', () => {
		const candidates = supabaseAdmissionCandidates([
			stack(5),
			stack(1, { held: true }),
			stack(2, { pinned: true }),
			stack(3, { origin: 'external' }),
			stack(4, { running: false }),
			stack(6, { inFlight: true }),
			stack(7, { origin: 'adopted', lastUsedAt: undefined }),
			stack(8, { origin: 'expected' }),
		]);
		expect(candidates).toEqual([
			{ stackId: hex(7) },
			{ stackId: hex(5), lastUsedAt: 500 },
		]);
		expect(supabaseNextToStop(candidates)?.stackId).toBe(hex(7));
		expect(supabaseNextToStop([])).toBeUndefined();
	});

	it('exports the concurrency limits', () => {
		expect(SUPABASE_CREATION_CONCURRENCY).toBe(1);
		expect(SUPABASE_LIFECYCLE_CONCURRENCY).toBe(2);
		expect(SUPABASE_MAX_CLI_CHILDREN).toBe(4);
		expect(SUPABASE_MIN_FREE_SYSV_SEGMENTS).toBe(2);
	});
});

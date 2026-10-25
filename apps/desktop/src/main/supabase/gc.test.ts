import { describe, expect, it } from 'vitest';
import { supabasePruneSummarySchema } from '../../shared/supabase-protocol';
import {
	computeSupabasePrune,
	dueSupabaseStops,
	type SupabaseGcStack,
} from './gc';

const NOW = 1_792_245_785_000;
const DAY = 24 * 60 * 60 * 1_000;
const MB = 1_024 * 1_024;

function hex(seed: number): string {
	return seed.toString(16).padStart(64, '0');
}

function stack(
	seed: number,
	overrides: Partial<SupabaseGcStack> = {}
): SupabaseGcStack {
	return {
		id: hex(seed),
		origin: 'managed',
		state: 'stopped',
		pinned: false,
		held: false,
		inFlight: false,
		laneRunning: false,
		flags: [],
		idleSince: NOW - DAY,
		diskBytes: seed * MB,
		...overrides,
	};
}

describe('computeSupabasePrune', () => {
	it('groups clean up candidates in order, with sizes', () => {
		const { summary, marks } = computeSupabasePrune({
			now: NOW,
			retentionDays: 14,
			stacks: [
				stack(1, {
					flags: ['worktree-deleted', 'orphaned'],
					flaggedAt: NOW - 3_600_000,
				}),
				stack(2, { flags: ['stale-branch'] }),
				stack(3, { idleSince: NOW - 15 * DAY }),
				stack(4, { state: 'failed' }),
				stack(5, { state: 'interrupted' }),
				stack(6, { state: 'unreadable', origin: 'external' }),
				stack(7),
			],
		});
		expect(supabasePruneSummarySchema.parse(summary)).toEqual(summary);
		expect(
			summary.groups.map((group) => [
				group.id,
				group.stackIds,
				group.bytes,
				group.selectable,
				group.preselected,
			])
		).toEqual([
			['worktree-deleted', [hex(1)], 1 * MB, true, true],
			['stale-branch', [hex(2)], 2 * MB, true, false],
			['retention', [hex(3)], 3 * MB, true, false],
			['failed-start', [hex(4), hex(5)], 9 * MB, true, true],
			['unreadable', [hex(6)], 6 * MB, false, false],
		]);
		// Unreadable stacks are shown but never part of what can be freed.
		expect(summary.suggestedBytes).toBe(15 * MB);
		expect(summary.onDiskBytes).toBe(28 * MB);
		expect(marks.get(hex(1))).toEqual({
			group: 'worktree-deleted',
			suggestedAt: NOW - 3_600_000,
		});
		expect(marks.get(hex(3))).toEqual({
			group: 'retention',
			suggestedAt: NOW - DAY,
		});
		expect(marks.get(hex(6))).toEqual({ group: 'unreadable' });
		// Not suggested yet: the date it will be, if it stays stopped.
		expect(marks.get(hex(7))).toEqual({ suggestedAt: NOW + 13 * DAY });
	});

	it('never suggests held, pinned, external, running or busy stacks', () => {
		const { summary } = computeSupabasePrune({
			now: NOW,
			retentionDays: 14,
			stacks: [
				stack(1, { held: true, flags: ['worktree-deleted'] }),
				stack(2, { pinned: true, idleSince: NOW - 40 * DAY }),
				stack(3, { origin: 'external', flags: ['stale-branch'] }),
				stack(4, { state: 'running', flags: ['worktree-deleted'] }),
				stack(5, { state: 'starting' }),
				stack(6, { inFlight: true, state: 'failed' }),
				stack(7, { laneRunning: true, state: 'never-started' }),
				stack(8, { flags: ['transient'], state: 'failed' }),
				stack(9, { origin: 'expected', state: 'not-created' }),
			],
		});
		expect(summary.groups).toEqual([]);
		expect(summary.notSuggested).toEqual({
			held: 1,
			pinned: 1,
			starting: 2,
			external: 1,
			running: 1,
		});
		expect(summary.suggestedBytes).toBeUndefined();
	});

	it('moves the revision only when a group changes, keeping the last result', () => {
		const lastResult = { at: NOW - DAY, destroyed: 2, failed: 0 };
		const first = computeSupabasePrune({
			now: NOW,
			retentionDays: 14,
			stacks: [stack(1, { state: 'failed' })],
			previous: {
				revision: 4,
				computedAt: NOW - 1,
				groups: [],
				notSuggested: {
					held: 0,
					pinned: 0,
					starting: 0,
					external: 0,
					running: 0,
				},
				lastResult,
			},
		}).summary;
		expect(first.revision).toBe(5);
		expect(first.lastResult).toEqual(lastResult);
		const same = computeSupabasePrune({
			now: NOW + 1_000,
			retentionDays: 14,
			stacks: [stack(1, { state: 'failed', diskBytes: 9 * MB })],
			previous: first,
		}).summary;
		expect(same.revision).toBe(5);
		const changed = computeSupabasePrune({
			now: NOW + 2_000,
			retentionDays: 14,
			stacks: [stack(1, { state: 'failed' }), stack(2, { state: 'failed' })],
			previous: same,
		}).summary;
		expect(changed.revision).toBe(6);
		expect(
			computeSupabasePrune({ now: NOW, retentionDays: 14, stacks: [] }).summary
				.revision
		).toBe(0);
	});
});

describe('dueSupabaseStops', () => {
	it('lists the stops due now, soonest first, never for a stack in flight', () => {
		expect(
			dueSupabaseStops(
				[
					{
						stackId: hex(1),
						autoStopAt: NOW - 1_000,
						autoStopReason: 'released',
						inFlight: false,
					},
					{
						stackId: hex(2),
						autoStopAt: NOW - 5_000,
						autoStopReason: 'orphaned',
						inFlight: false,
					},
					{
						stackId: hex(3),
						autoStopAt: NOW + 1_000,
						autoStopReason: 'abandoned',
						inFlight: false,
					},
					{
						stackId: hex(4),
						autoStopAt: NOW - 9_000,
						autoStopReason: 'superseded',
						inFlight: true,
					},
					{ stackId: hex(5), inFlight: false },
				],
				NOW
			)
		).toEqual([
			{
				stackId: hex(2),
				reason: 'orphaned',
				requestedBy: { kind: 'automatic', reason: 'orphaned' },
			},
			{
				stackId: hex(1),
				reason: 'released',
				requestedBy: { kind: 'automatic', reason: 'idle' },
			},
		]);
	});
});

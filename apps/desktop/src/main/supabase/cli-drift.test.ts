import { describe, expect, it } from 'vitest';
import {
	planSupabaseDrift,
	SUPABASE_DRIFT_DEBOUNCE_MS,
	type SupabaseDriftStack,
} from './cli-drift';
import type { SupabaseCliResolution } from './cli-resolver';
import { fakeResolvedCli } from './engine.test-support';

const NOW = Date.UTC(2026, 9, 17, 9, 0, 0);
const ID = 'a'.repeat(64);
const OLD_BINARY = '/opt/example/old/node_modules/.bin/supabase';
const NEW_BINARY = '/opt/example/new/node_modules/.bin/supabase';

function ok(binary: string, version: string, manageable = true) {
	const cli = fakeResolvedCli(binary, version, manageable);
	return { ok: true, cli } as const satisfies SupabaseCliResolution;
}

const gone: SupabaseCliResolution = {
	ok: false,
	reason: 'not-installed',
	message: 'the binary is gone',
	recovery: 'Install dependencies.',
	path: OLD_BINARY,
};

function drift(fields: Partial<SupabaseDriftStack> = {}): SupabaseDriftStack {
	return {
		stackId: ID,
		recordedBinary: OLD_BINARY,
		recordedVersion: '2.121.0',
		ownerExecutable: OLD_BINARY,
		ownerValidation: ok(OLD_BINARY, '2.121.0'),
		worktreeCli: ok(OLD_BINARY, '2.121.0'),
		inFlight: false,
		...fields,
	};
}

describe('planSupabaseDrift', () => {
	it('does nothing while the owner runs the worktree CLI', () => {
		expect(
			planSupabaseDrift({ stacks: [drift()], previous: new Map(), now: NOW })
		).toEqual({ restart: [], changed: new Set(), pending: new Map() });
	});

	it('restarts with the worktree CLI 30 s after the owner binary vanished', () => {
		const stack = drift({
			ownerValidation: gone,
			worktreeCli: ok(NEW_BINARY, '2.121.0'),
		});
		const first = planSupabaseDrift({
			stacks: [stack],
			previous: new Map(),
			now: NOW,
		});
		expect(first.restart).toEqual([]);
		expect(first.changed).toEqual(new Set([ID]));
		expect(first.nextDueAt).toBe(NOW + SUPABASE_DRIFT_DEBOUNCE_MS);
		const due = planSupabaseDrift({
			stacks: [stack],
			previous: first.pending,
			now: NOW + SUPABASE_DRIFT_DEBOUNCE_MS,
		});
		expect(due.restart).toEqual([
			{ stackId: ID, signature: '2.121.0->2.121.0' },
		]);
		// Tried once for this drift: never again.
		expect(
			planSupabaseDrift({
				stacks: [stack],
				previous: new Map(),
				attempted: new Map([[ID, '2.121.0->2.121.0']]),
				now: NOW + 10 * 60_000,
			}).restart
		).toEqual([]);
	});

	it('restarts on a version change of a manageable worktree CLI', () => {
		const stack = drift({ worktreeCli: ok(NEW_BINARY, '2.121.1', true) });
		const first = planSupabaseDrift({
			stacks: [stack],
			previous: new Map(),
			now: NOW,
		});
		expect(first.pending.get(ID)?.signature).toBe('2.121.0->2.121.1');
		expect(
			planSupabaseDrift({
				stacks: [stack],
				previous: first.pending,
				now: NOW + SUPABASE_DRIFT_DEBOUNCE_MS,
			}).restart
		).toHaveLength(1);
	});

	it('only flags a stack whose worktree CLI is not manageable, or one in flight', () => {
		const unverified = drift({
			ownerValidation: gone,
			worktreeCli: ok(NEW_BINARY, '2.130.0'),
		});
		const later = NOW + 10 * 60_000;
		const result = planSupabaseDrift({
			stacks: [unverified],
			previous: new Map(),
			now: later,
		});
		expect(result.restart).toEqual([]);
		expect(result.changed).toEqual(new Set([ID]));
		const busy = drift({
			ownerValidation: gone,
			worktreeCli: ok(NEW_BINARY, '2.121.0'),
			inFlight: true,
		});
		const first = planSupabaseDrift({
			stacks: [busy],
			previous: new Map(),
			now: NOW,
		});
		expect(
			planSupabaseDrift({
				stacks: [busy],
				previous: first.pending,
				now: later,
			}).restart
		).toEqual([]);
	});
});

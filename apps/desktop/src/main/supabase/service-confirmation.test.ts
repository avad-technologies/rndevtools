import { describe, expect, it } from 'vitest';
import {
	createSupabaseDemoState,
	SUPABASE_DEMO_IDS,
	SUPABASE_DEMO_NOW,
} from '../../shared/supabase-demo-data';
import {
	type SupabaseOperation,
	type SupabaseState,
	supabaseConfirmationRequired,
	supabaseDesktopError,
	supabaseOperationSchema,
} from '../../shared/supabase-protocol';
import { describeSupabaseConfirmation } from './service-confirmation';

const ids = SUPABASE_DEMO_IDS;
const now = SUPABASE_DEMO_NOW;

let counter = 0;
function op(fields: Record<string, unknown>): SupabaseOperation {
	counter += 1;
	return supabaseOperationSchema.parse({
		actionId: `action-${counter}`,
		...fields,
	});
}

function onState(state: SupabaseState) {
	return {
		state,
		now,
		reservedPorts: (stackId: string) => (stackId === ids.featOldUi ? 9 : 0),
	};
}

/** Every operation a stack row or a global control can ask for. */
function operationsFor(state: SupabaseState): SupabaseOperation[] {
	const operations: SupabaseOperation[] = [
		op({ kind: 'set-enabled', enabled: true }),
		op({ kind: 'set-enabled', enabled: false }),
		op({ kind: 'update-policy', patch: { perStackKeys: true } }),
		op({ kind: 'update-policy', patch: { allowUnverifiedPatch: true } }),
		op({
			kind: 'update-policy',
			patch: { exclude: ['analytics'], perStackKeys: true },
		}),
		op({
			kind: 'destroy',
			stackIds: state.stacks.slice(0, 3).map((stack) => stack.id),
			removeUploads: false,
		}),
	];
	for (const stack of state.stacks) {
		operations.push(
			op({ kind: 'stop', stackIds: [stack.id] }),
			op({ kind: 'destroy', stackIds: [stack.id], removeUploads: false }),
			op({ kind: 'recreate', stackId: stack.id }),
			op({ kind: 'reset', stackId: stack.id, seed: true }),
			op({ kind: 'reset', stackId: stack.id, seed: false }),
			op({ kind: 'set-studio', stackId: stack.id, enabled: true }),
			op({ kind: 'apply-migrations', stackId: stack.id }),
			op({ kind: 'seed-buckets', stackId: stack.id })
		);
	}
	for (const request of state.requests) {
		operations.push(op({ kind: 'request.approve', requestId: request.id }));
	}
	return operations;
}

describe('describeSupabaseConfirmation', () => {
	it('describes every operation that needs the dialog, never with empty text', () => {
		const state = createSupabaseDemoState({ now });
		let described = 0;
		for (const operation of operationsFor(state)) {
			const facts = describeSupabaseConfirmation(operation, onState(state));
			if (!supabaseConfirmationRequired(operation, state)) {
				expect(facts).toBeUndefined();
				continue;
			}
			described += 1;
			expect(facts, operation.kind).toBeDefined();
			expect(facts?.title.trim().length).toBeGreaterThan(0);
			expect(facts?.choices.length).toBeGreaterThan(0);
			for (const choice of facts?.choices ?? []) {
				expect(choice.label.trim().length).toBeGreaterThan(0);
			}
			for (const line of facts?.lines ?? []) {
				expect(line.trim().length).toBeGreaterThan(0);
			}
			expect(JSON.stringify(facts)).not.toMatch(/sb_secret_|eyJ|postgres/);
		}
		expect(described).toBeGreaterThan(5);
	});

	it('names the branch, size and uploads when destroying one stack', () => {
		const state = createSupabaseDemoState({ now });
		const facts = describeSupabaseConfirmation(
			op({
				kind: 'destroy',
				stackIds: [ids.featOldUi],
				removeUploads: false,
			}),
			onState(state)
		);
		const stack = state.stacks.find((entry) => entry.id === ids.featOldUi);
		expect(facts?.title).toMatch(/^Destroy the local Supabase stack for /);
		expect(facts?.lines[0]).toBe(
			"Deletes its database and logs. This can't be undone."
		);
		expect(facts?.lines.join('\n')).toContain(
			`Stack ${ids.featOldUi.slice(0, 8)}…`
		);
		expect(facts?.lines.join('\n')).toContain('frees 9 ports');
		expect(facts?.choices).toHaveLength(1);
		if (stack?.worktreeExists) {
			expect(facts?.checkbox).toMatchObject({
				label: expect.stringContaining(
					`…/stack-uploads/${ids.featOldUi.slice(0, 8)}…`
				),
				checkedByDefault: false,
			});
		}
	});

	it('says the uploads are gone with a deleted worktree, and offers no checkbox', () => {
		const state = createSupabaseDemoState({ now });
		const gone = state.stacks.find((stack) => !stack.worktreeExists);
		expect(gone).toBeDefined();
		const facts = describeSupabaseConfirmation(
			op({
				kind: 'destroy',
				stackIds: [gone?.id ?? ''],
				removeUploads: false,
			}),
			onState(state)
		);
		expect(facts?.checkbox).toBeUndefined();
		expect(facts?.lines).toContain(
			'Uploads lived in the deleted worktree and are already gone.'
		);
	});

	it('offers both turn-off dispositions with what runs now', () => {
		const state = createSupabaseDemoState({ now });
		const facts = describeSupabaseConfirmation(
			op({ kind: 'set-enabled', enabled: false }),
			onState(state)
		);
		expect(facts?.choices).toEqual([
			{ label: 'Leave them running', disposition: 'leave-running' },
			{ label: 'Stop managed stacks', disposition: 'stop-managed' },
		]);
		expect(facts?.lines[0]).toMatch(/^\d+ managed stacks? (?:is|are) running/);
	});

	it('names each trust change of a policy update', () => {
		const state = createSupabaseDemoState({ now });
		const keys = describeSupabaseConfirmation(
			op({ kind: 'update-policy', patch: { perStackKeys: true } }),
			onState(state)
		);
		expect(keys?.title).toBe('Write per-stack keys into each worktree?');
		expect(keys?.choices).toEqual([{ label: 'Write per-stack keys' }]);
		const both = describeSupabaseConfirmation(
			op({
				kind: 'update-policy',
				patch: { perStackKeys: true, allowUnverifiedPatch: true },
			}),
			onState(state)
		);
		expect(both?.title).toBe('Apply these Supabase trust changes?');
		expect(both?.lines).toHaveLength(2);
	});

	it('shows who asked for a request, never their note', () => {
		const state = createSupabaseDemoState({ now });
		const request = state.requests.find(
			(entry) => entry.id === ids.requestOldUi
		);
		expect(request).toBeDefined();
		const facts = describeSupabaseConfirmation(
			op({ kind: 'request.approve', requestId: ids.requestOldUi }),
			onState(state)
		);
		const text = facts?.lines.join('\n') ?? '';
		expect(text).toMatch(/asked to (?:destroy|reset) it/);
		if (request?.note) expect(text).not.toContain(request.note);
	});

	it("lists what a needs-recreate stack can't adopt, after any later failure", () => {
		const demo = createSupabaseDemoState({ now });
		// A retry failed for another reason: lastError is that failure.
		const state: SupabaseState = {
			...demo,
			stacks: demo.stacks.map((stack) =>
				stack.id === ids.featSearch
					? {
							...stack,
							state: 'needs-recreate',
							recreateChanges: [
								{
									key: '[db] major_version',
									saved: '15',
									requested: '17',
									editable: true,
								},
							],
							lastError: {
								...supabaseDesktopError('refused', 'Port 54321 is in use.'),
								code: 'ports_conflict',
							},
						}
					: stack
			),
		};
		const facts = describeSupabaseConfirmation(
			op({ kind: 'recreate', stackId: ids.featSearch }),
			onState(state)
		);
		expect(facts?.lines[0]).toBe('[db] major_version: saved 15, requested 17.');
	});

	it('answers nothing for a stack that is not listed', () => {
		const state = createSupabaseDemoState({ now });
		expect(
			describeSupabaseConfirmation(
				op({ kind: 'recreate', stackId: 'f'.repeat(64) }),
				onState(state)
			)
		).toBeUndefined();
	});
});

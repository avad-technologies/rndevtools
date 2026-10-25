import { describe, expect, it } from 'vitest';
import {
	applySupabaseDemoOperation,
	confirmSupabaseDemoOperation,
	createSupabaseDemoState,
	SUPABASE_DEMO_IDS,
	SUPABASE_DEMO_NOW,
} from './supabase-demo-data';
import {
	attentionItems,
	SUPABASE_OPERATION_KINDS,
	type SupabaseOperation,
	type SupabaseState,
	sidebarBadge,
	stackStatus,
	supabaseConfirmationResultSchema,
	supabaseOperationReceiptSchema,
	supabaseOperationSchema,
	supabaseStackTitle,
	supabaseStateSchema,
	withSupabaseConfirmation,
} from './supabase-protocol';

const ids = SUPABASE_DEMO_IDS;
const now = SUPABASE_DEMO_NOW;
const SECRET_SHAPES = [
	/sb_secret_/,
	/sb_publishable_/,
	/eyJ/,
	/postgres(?:ql)?:\/\//,
	/SERVICE_ROLE/,
];

function expectNoSecrets(value: unknown): void {
	const serialized = JSON.stringify(value);
	for (const shape of SECRET_SHAPES) expect(serialized).not.toMatch(shape);
}

let counter = 0;
function op(fields: Record<string, unknown>): SupabaseOperation {
	counter += 1;
	return supabaseOperationSchema.parse({
		actionId: `demo-action-${counter}`,
		...fields,
	});
}

function apply(state: SupabaseState, operation: SupabaseOperation) {
	const result = applySupabaseDemoOperation(state, operation, now + 1_000);
	expect(supabaseStateSchema.parse(result.state)).toEqual(result.state);
	expect(supabaseOperationReceiptSchema.parse(result.receipt)).toEqual(
		result.receipt
	);
	expectNoSecrets(result);
	// No `undefined`-valued keys: what is sent is exactly what is kept.
	expect(result.state).toStrictEqual(JSON.parse(JSON.stringify(result.state)));
	return result;
}

function stackIn(state: SupabaseState, id: string) {
	return state.stacks.find((stack) => stack.id === id);
}

describe('createSupabaseDemoState', () => {
	it('is deterministic, strict and free of secrets in every variant', () => {
		for (const variant of ['full', 'off', 'unsupported', 'empty'] as const) {
			const state = createSupabaseDemoState({ variant });
			expect(supabaseStateSchema.parse(state)).toEqual(state);
			expect(createSupabaseDemoState({ variant })).toEqual(state);
			expect(state).toStrictEqual(JSON.parse(JSON.stringify(state)));
			expect(state.source).toBe('demo');
			expectNoSecrets(state);
		}
		const off = createSupabaseDemoState({ variant: 'off' });
		expect(off.feature.enabled).toBe(false);
		expect(off.stacks).toEqual([]);
		const unsupported = createSupabaseDemoState({ variant: 'unsupported' });
		expect(unsupported.availability.platform.supported).toBe(false);
	});

	it('mirrors demo set A', () => {
		const state = createSupabaseDemoState();
		const rows = state.stacks.map((stack) => [
			supabaseStackTitle(stack),
			stackStatus(stack, { jobs: state.jobs }).label,
		]);
		expect(rows).toEqual([
			['legacy-main', 'LAN-exposed'],
			['fix-auth-redirect', 'Starting…'],
			['feat-checkout', 'Running · idle'],
			['feat-payments', 'Running · idle'],
			['main', 'Running · idle'],
			['feat-old-ui', 'Stopped'],
			['feat-search', 'Stopped'],
			['feat-gone', 'Stopped'],
			['c41d0e77…', 'Unreadable'],
			['feat-onboarding', 'Not created'],
		]);
		expect(state.capacity).toMatchObject({
			running: 3,
			starting: 1,
			cap: 12,
			sysv: { used: 6, limit: 32 },
		});
		expect(state.requests).toHaveLength(1);
		expect(state.jobs).toHaveLength(1);
		const selectable = state.prune.groups
			.filter((group) => group.selectable)
			.flatMap((group) => group.stackIds);
		expect(selectable).toEqual([ids.featGone, ids.featOldUi, ids.featSearch]);
		expect(state.prune.suggestedBytes).toBe(179 * 1_024 * 1_024);
		expect(state.prune.notSuggested).toEqual({
			held: 2,
			pinned: 1,
			starting: 1,
			external: 1,
			running: 0,
		});
		expect(sidebarBadge(state, now)).toMatchObject({
			value: 3,
			tone: 'danger',
		});
		expect(
			attentionItems(state, now)
				.filter((item) => item.rank !== 'suggestion')
				.map((item) => item.kind)
		).toEqual(['lan-exposed', 'request', 'stacks-need-attention']);
		expect(state.trafficSignature.apiPorts).toContainEqual({
			port: 21_734,
			stackId: ids.featCheckout,
		});
	});
});

describe('applySupabaseDemoOperation', () => {
	it('starts an expected row as a pinned, managed stack', () => {
		const state = createSupabaseDemoState();
		const { state: next, receipt } = apply(
			state,
			op({ kind: 'start', stackId: ids.featOnboarding })
		);
		expect(receipt.completed).toBe(true);
		expect(next.revision).toBe(state.revision + 1);
		const started = stackIn(next, ids.featOnboarding);
		expect(started).toMatchObject({
			origin: 'managed',
			state: 'running',
			pinned: true,
			createdBy: { via: 'operator' },
		});
		expect(started?.holds).toEqual([
			{ holder: 'operator', since: now + 1_000, live: true },
		]);
		expect(started?.apiUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(next.capacity.running).toBe(4);
		expect(next.activity.at(-1)).toMatchObject({
			kind: 'create',
			outcome: 'complete',
		});
	});

	it('stops, then resumes, keeping lane holds and data', () => {
		const state = createSupabaseDemoState();
		const stopped = apply(
			state,
			op({ kind: 'stop', stackIds: [ids.featCheckout] })
		);
		expect(stackIn(stopped.state, ids.featCheckout)).toMatchObject({
			state: 'stopped',
			lifecycle: null,
		});
		expect(stopped.receipt.message).toBe(
			'feat-checkout stopped. Data and ports are kept; Resume brings it back in about a second.'
		);
		const resumed = apply(
			stopped.state,
			op({ kind: 'start', stackId: ids.featCheckout })
		);
		expect(stackIn(resumed.state, ids.featCheckout)).toMatchObject({
			state: 'running',
			pinned: false,
		});
	});

	it('refuses what the shared rules refuse, with the visible reason', () => {
		const state = createSupabaseDemoState();
		const { state: next, receipt } = apply(
			state,
			op({
				kind: 'destroy',
				stackIds: [ids.featCheckout],
				removeUploads: false,
			})
		);
		expect(next).toBe(state);
		expect(receipt).toMatchObject({
			completed: false,
			error: {
				code: 'refused',
				message:
					'Lane :8102 is attached and running. Stop the lane in Lanes first.',
			},
		});
		expect(
			apply(state, op({ kind: 'reset', stackId: ids.main, seed: true })).receipt
				.error?.message
		).toBe('Pinned stacks are protected. Unpin it first.');
		expect(
			apply(state, op({ kind: 'restart', stackId: ids.fixAuthRedirect }))
				.receipt.error?.message
		).toBe('Another operation is running on this stack.');
		expect(
			apply(
				state,
				op({
					kind: 'destroy',
					stackIds: [ids.unreadable],
					removeUploads: false,
				})
			).receipt.error?.message
		).toBe(
			"This CLI can't read the stack, so it can't destroy it. See Clean up › Unreadable."
		);
	});

	it('destroys stopped stacks and recomputes clean up', () => {
		const state = createSupabaseDemoState();
		const { state: next, receipt } = apply(
			state,
			op({
				kind: 'destroy',
				stackIds: [ids.featGone],
				removeUploads: false,
				pruneRevision: state.prune.revision,
			})
		);
		expect(stackIn(next, ids.featGone)).toBeUndefined();
		expect(receipt.message).toBe(
			'Destroyed 1 stack. Freed 64 MB and 10 ports.'
		);
		expect(next.prune.revision).toBe(state.prune.revision + 1);
		expect(next.prune.lastResult).toMatchObject({ destroyed: 1, failed: 0 });
		const stale = apply(
			next,
			op({
				kind: 'destroy',
				stackIds: [ids.featSearch],
				removeUploads: false,
				pruneRevision: state.prune.revision,
			})
		);
		expect(stale.receipt.error?.code).toBe('stale_selection');
	});

	it('settles agent requests', () => {
		const state = createSupabaseDemoState();
		const approved = apply(
			state,
			op({
				kind: 'request.approve',
				requestId: ids.requestOldUi,
				removeUploads: false,
			})
		);
		expect(approved.state.requests).toEqual([]);
		expect(stackIn(approved.state, ids.featOldUi)).toBeUndefined();
		const denied = apply(
			state,
			op({ kind: 'request.deny', requestId: ids.requestOldUi })
		);
		expect(denied.state.requests).toEqual([]);
		expect(stackIn(denied.state, ids.featOldUi)).toBeDefined();
	});

	it('reads logs and the database without changing state', () => {
		const state = createSupabaseDemoState();
		const logs = apply(
			state,
			op({ kind: 'read-logs', stackId: ids.featCheckout, tail: 200 })
		);
		expect(logs.state).toBe(state);
		expect(logs.receipt.logs?.records.length).toBeGreaterThan(0);
		const database = apply(
			state,
			op({ kind: 'read-database', stackId: ids.featCheckout })
		);
		expect(database.receipt.database).toMatchObject({
			target: 'local',
			migrations: { comparable: true, state: 'pending', applied: 12 },
		});
		const staleDatabase = apply(
			state,
			op({ kind: 'read-database', stackId: ids.featOldUi })
		);
		expect(staleDatabase.receipt.error?.message).toBe(
			'Start the stack first. Database reads need it running.'
		);
	});

	it('turns the feature off, stopping managed stacks when asked', () => {
		const state = createSupabaseDemoState();
		const { state: next } = apply(
			state,
			op({ kind: 'set-enabled', enabled: false, disposition: 'stop-managed' })
		);
		expect(next.feature.enabled).toBe(false);
		expect(next.capacity.running).toBe(0);
		expect(stackIn(next, ids.legacyMain)?.state).toBe('stopped');
		const back = apply(next, op({ kind: 'set-enabled', enabled: true }));
		expect(back.state.feature.enabled).toBe(true);
	});

	it('follows a held stale stack to its new branch', () => {
		const base = createSupabaseDemoState();
		const state: SupabaseState = {
			...base,
			stacks: base.stacks.map((stack) =>
				stack.id === ids.featOldUi
					? {
							...stack,
							holds: [
								{
									holder: 'session',
									agent: {
										kind: 'claude',
										sessionId: ids.claudeCheckout,
										synthetic: false,
									},
									since: now - 60_000,
									live: true,
								},
							],
						}
					: stack
			),
		};
		const { state: next } = apply(
			state,
			op({ kind: 'follow-branch', stackId: ids.featOldUi })
		);
		const follower = next.stacks.find(
			(stack) => stack.branchContext === 'refs/heads/feat-nav-v2'
		);
		expect(follower).toMatchObject({ state: 'running', origin: 'managed' });
		expect(follower?.holds).toHaveLength(1);
		expect(stackIn(next, ids.featOldUi)?.holds).toEqual([]);
		expect(
			apply(base, op({ kind: 'follow-branch', stackId: ids.featOldUi })).receipt
				.error?.message
		).toBe('Only a stack in use follows its branch.');
	});

	it('answers every operation kind with a valid receipt', () => {
		const state = createSupabaseDemoState();
		const operations: SupabaseOperation[] = [
			op({ kind: 'refresh' }),
			op({ kind: 'read-logs', stackId: ids.featCheckout, tail: 200 }),
			op({ kind: 'read-database', stackId: ids.featCheckout }),
			op({ kind: 'start', stackId: ids.featSearch }),
			op({ kind: 'resume-saved', stackId: ids.featOldUi }),
			op({ kind: 'stop', stackIds: [ids.featPayments, ids.main] }),
			op({ kind: 'restart', stackId: ids.featCheckout }),
			op({
				kind: 'stop-and-start',
				stackId: ids.featCheckout,
				purpose: 'apply-config',
			}),
			op({ kind: 'reapply-exclusions', stackId: ids.featCheckout }),
			op({ kind: 'pin', stackId: ids.featCheckout }),
			op({ kind: 'unpin', stackId: ids.main }),
			op({
				kind: 'release',
				stackId: ids.featCheckout,
				holder: {
					holder: 'session',
					agentKind: 'codex',
					sessionId: ids.codexAbandoned,
				},
			}),
			op({ kind: 'adopt', stackId: ids.legacyMain }),
			op({ kind: 'prepare', repositoryId: ids.repositoryApp }),
			op({ kind: 'apply-migrations', stackId: ids.featCheckout }),
			op({ kind: 'reset', stackId: ids.featCheckout, seed: false }),
			op({ kind: 'seed-buckets', stackId: ids.featCheckout }),
			op({ kind: 'export', stackId: ids.featCheckout, content: 'data' }),
			op({ kind: 'destroy', stackIds: [ids.featSearch], removeUploads: true }),
			op({ kind: 'recreate', stackId: ids.featGone }),
			op({ kind: 'set-studio', stackId: ids.featCheckout, enabled: true }),
			op({ kind: 'follow-branch', stackId: ids.featOldUi }),
			op({ kind: 'open', stackId: ids.featCheckout, surface: 'mailpit' }),
			op({ kind: 'copy', stackId: ids.featCheckout, what: 'publishable-key' }),
			op({ kind: 'reveal', stackId: ids.unreadable, what: 'stack-folder' }),
			op({ kind: 'request.approve', requestId: ids.requestOldUi }),
			op({ kind: 'request.deny', requestId: ids.requestOldUi }),
			op({ kind: 'set-enabled', enabled: false, disposition: 'leave-running' }),
			op({ kind: 'update-policy', patch: { maxRunning: 6 } }),
			op({ kind: 'repository.recheck', repositoryId: ids.repositoryApp }),
			op({
				kind: 'repository.set-mode',
				repositoryId: ids.repositoryAdmin,
				mode: 'off',
			}),
			op({ kind: 'cancel-job', jobId: ids.jobFixAuth }),
			op({ kind: 'restart-metro', laneId: ids.laneCheckout }),
			op({ kind: 'choose-path', field: 'supabase-home' }),
		];
		expect(new Set(operations.map((operation) => operation.kind))).toEqual(
			new Set(SUPABASE_OPERATION_KINDS)
		);
		for (const operation of operations) {
			const { receipt } = apply(state, operation);
			expect(receipt.actionId).toBe(operation.actionId);
			expect(receipt.kind).toBe(operation.kind);
		}
		const copy = apply(
			state,
			op({ kind: 'copy', stackId: ids.featCheckout, what: 'app-env' })
		).receipt;
		expect(copy.copy).toEqual({
			copied: true,
			what: 'app-env',
			clearsAt: now + 61_000,
		});
		expect(
			apply(state, op({ kind: 'cancel-job', jobId: ids.jobFixAuth })).state
				.jobs[0]?.status
		).toBe('cancelled');
	});

	it('confirms without a dialog, so confirm-then-run works unchanged', () => {
		const destroy = op({
			kind: 'destroy',
			stackIds: [ids.featGone],
			removeUploads: false,
		});
		const result = confirmSupabaseDemoOperation(destroy);
		expect(supabaseConfirmationResultSchema.parse(result)).toEqual(result);
		expect(withSupabaseConfirmation(destroy, result)).toEqual({
			ok: true,
			operation: destroy,
		});
	});
});

import { describe, expect, it, vi } from 'vitest';
import {
	applySupabaseDemoOperation,
	confirmSupabaseDemoOperation,
	createSupabaseDemoState,
	SUPABASE_DEMO_IDS,
	SUPABASE_DEMO_NOW,
} from '../../shared/supabase-demo-data';
import {
	SUPABASE_NO_INTEREST,
	type SupabaseBridge,
	type SupabaseConfirmationResult,
	type SupabaseErrorView,
	type SupabaseInterest,
	type SupabaseJob,
	type SupabaseOperation,
	type SupabaseOperationReceipt,
	type SupabaseState,
	supabaseDesktopError,
	supabaseInterestSchema,
	supabaseOperationSchema,
} from '../../shared/supabase-protocol';
import {
	acceptSupabaseState,
	confirmThenRunSupabaseOperation,
	createSupabaseActionId,
	INITIAL_SUPABASE_NAVIGATION,
	initialSupabaseNavigation,
	readSupabaseNavigationPreferences,
	resolveSupabaseBridge,
	resolveSupabaseInterest,
	SUPABASE_BULK_PENDING_KEY,
	type SupabaseJobWatch,
	type SupabaseNavigation,
	settleSupabaseJobs,
	supabaseActionCopy,
	supabaseFailureText,
	supabaseJobNotice,
	supabaseNavigationReducer,
	supabasePendingKeys,
	supabaseReceiptNotice,
	supabaseStackPendingKey,
	withSupabaseActionId,
	writeSupabaseNavigationPreferences,
} from './supabase-runtime';

const ids = SUPABASE_DEMO_IDS;
const now = SUPABASE_DEMO_NOW;
const TOKEN = `confirmation-${'a'.repeat(64)}`;

function demo(): SupabaseState {
	return createSupabaseDemoState();
}

function receipt(
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

function op(fields: Record<string, unknown>): SupabaseOperation {
	return supabaseOperationSchema.parse({
		actionId: createSupabaseActionId(),
		...fields,
	});
}

function fakeBridge(
	confirmation: (operation: SupabaseOperation) => SupabaseConfirmationResult,
	answer: (operation: SupabaseOperation) => SupabaseOperationReceipt = (
		operation
	) => receipt(operation)
) {
	return {
		requestSupabaseConfirmation: vi.fn(async (operation: SupabaseOperation) =>
			confirmation(operation)
		),
		runSupabaseOperation: vi.fn(async (operation: SupabaseOperation) =>
			answer(operation)
		),
	};
}

describe('bridge and revisions', () => {
	const methods = {
		getSupabaseState: async () => demo(),
		subscribeSupabaseState: () => () => {},
		runSupabaseOperation: async () => ({}),
		requestSupabaseConfirmation: async () => ({}),
		setSupabaseInterest: () => {},
	};

	it('finds the bridge only when every Supabase method is there', () => {
		expect(resolveSupabaseBridge(Object.freeze({ ...methods }))).not.toBeNull();
		const { setSupabaseInterest: _missing, ...partial } = methods;
		expect(resolveSupabaseBridge(partial)).toBeNull();
		expect(resolveSupabaseBridge(undefined)).toBeNull();
		expect(resolveSupabaseBridge('bridge')).toBeNull();
	});

	it('accepts a state only when its revision is not older', () => {
		const current = { ...demo(), revision: 5 };
		const older = { ...current, revision: 4 };
		const same = { ...current };
		const newer = { ...current, revision: 6 };
		expect(acceptSupabaseState(current, older)).toBe(current);
		expect(acceptSupabaseState(current, same)).toBe(same);
		expect(acceptSupabaseState(current, newer)).toBe(newer);
		expect(acceptSupabaseState(current, undefined)).toBe(current);
	});

	it('issues action ids the operation schema accepts', () => {
		const actionId = createSupabaseActionId();
		expect(actionId).toMatch(/^supabase-[0-9a-f-]{36}$/);
		expect(
			supabaseOperationSchema.parse(
				withSupabaseActionId({ kind: 'refresh' }, actionId)
			)
		).toEqual({ kind: 'refresh', actionId });
	});
});

describe('supabasePendingKeys', () => {
	it('keys stack operations by stack and bulk ones by every stack plus bulk', () => {
		expect(supabasePendingKeys({ kind: 'start', stackId: ids.main })).toEqual([
			supabaseStackPendingKey(ids.main),
		]);
		expect(supabasePendingKeys({ kind: 'stop', stackIds: [ids.main] })).toEqual(
			[`stack:${ids.main}`]
		);
		expect(
			supabasePendingKeys({
				kind: 'destroy',
				stackIds: [ids.featGone, ids.featSearch],
				removeUploads: false,
			})
		).toEqual([
			SUPABASE_BULK_PENDING_KEY,
			`stack:${ids.featGone}`,
			`stack:${ids.featSearch}`,
		]);
	});

	it('gives reads and global controls keys of their own', () => {
		expect(
			supabasePendingKeys({ kind: 'read-logs', stackId: ids.main, tail: 200 })
		).toEqual([`read-logs:${ids.main}`]);
		expect(
			supabasePendingKeys({
				kind: 'copy',
				stackId: ids.main,
				what: 'publishable-key',
			})
		).toEqual([`copy:${ids.main}:publishable-key`]);
		expect(supabasePendingKeys({ kind: 'set-enabled', enabled: true })).toEqual(
			['feature']
		);
		expect(
			supabasePendingKeys({ kind: 'prepare', repositoryId: ids.repositoryApp })
		).toEqual([`repository:${ids.repositoryApp}`]);
		expect(
			supabasePendingKeys({ kind: 'request.deny', requestId: ids.requestOldUi })
		).toEqual([`request:${ids.requestOldUi}`]);
		expect(supabasePendingKeys({ kind: 'refresh' })).toEqual(['refresh']);
	});

	it('keys a background read apart, so auto-refresh never refuses the operator', () => {
		const manual = supabasePendingKeys({
			kind: 'read-logs',
			stackId: ids.main,
			services: ['auth'],
			tail: 200,
		});
		const tick = supabasePendingKeys(
			{
				kind: 'read-logs',
				stackId: ids.main,
				tail: 1_000,
				since: '2026-10-17T14:02:11.000Z',
			},
			{ background: true }
		);
		expect(tick).toEqual([`background:read-logs:${ids.main}`]);
		expect(tick.some((key) => manual.includes(key))).toBe(false);
		// Two ticks still share a key, so a slow one is never doubled.
		expect(
			supabasePendingKeys(
				{ kind: 'read-logs', stackId: ids.main, tail: 1_000, since: '5s' },
				{ background: true }
			)
		).toEqual(tick);
	});
});

describe('confirmThenRunSupabaseOperation', () => {
	const state = demo();

	it('runs at once when nothing guards the operation', async () => {
		const bridge = fakeBridge(() => {
			throw new Error('no dialog expected');
		});
		const start = op({ kind: 'start', stackId: ids.featOnboarding });
		expect(
			await confirmThenRunSupabaseOperation(bridge, start, state)
		).toMatchObject({ actionId: start.actionId, completed: true });
		expect(bridge.requestSupabaseConfirmation).not.toHaveBeenCalled();
		expect(bridge.runSupabaseOperation).toHaveBeenCalledWith(start);
	});

	it('asks the native dialog first and runs with its token and options', async () => {
		const destroy = op({
			kind: 'destroy',
			stackIds: [ids.featGone],
			removeUploads: false,
		});
		const bridge = fakeBridge((operation) => ({
			actionId: operation.actionId,
			required: true,
			confirmed: true,
			token: TOKEN,
			options: { removeUploads: true },
		}));
		await confirmThenRunSupabaseOperation(bridge, destroy, state);
		expect(bridge.requestSupabaseConfirmation).toHaveBeenCalledWith(destroy);
		expect(bridge.runSupabaseOperation).toHaveBeenCalledWith({
			...destroy,
			removeUploads: true,
			confirmationToken: TOKEN,
		});
	});

	it('comes back cancelled, without running, when the dialog is dismissed', async () => {
		const reset = op({ kind: 'reset', stackId: ids.featCheckout, seed: true });
		const bridge = fakeBridge((operation) => ({
			actionId: operation.actionId,
			required: true,
			confirmed: false,
		}));
		expect(await confirmThenRunSupabaseOperation(bridge, reset, state)).toEqual(
			{
				actionId: reset.actionId,
				kind: 'reset',
				completed: false,
				cancelled: true,
			}
		);
		expect(bridge.runSupabaseOperation).not.toHaveBeenCalled();
	});

	it('refuses a missing token or a mismatched action', async () => {
		const recreate = op({ kind: 'recreate', stackId: ids.featOldUi });
		for (const result of [
			{ actionId: recreate.actionId, required: true, confirmed: true },
			{
				actionId: 'other-action',
				required: true,
				confirmed: true,
				token: TOKEN,
			},
			{
				actionId: recreate.actionId,
				required: true,
				confirmed: false,
				error: 'The dialog could not open.',
			},
		]) {
			const bridge = fakeBridge(() => result);
			const answer = await confirmThenRunSupabaseOperation(
				bridge,
				recreate,
				state
			);
			expect(answer.completed).toBe(false);
			expect(answer.error?.code).toBe('confirmation_required');
			expect(bridge.runSupabaseOperation).not.toHaveBeenCalled();
		}
	});

	it('asks once when main wants a dialog the renderer did not expect', async () => {
		const stop = op({ kind: 'stop', stackIds: [ids.main] });
		let calls = 0;
		const bridge = fakeBridge(
			(operation) => ({
				actionId: operation.actionId,
				required: true,
				confirmed: true,
				token: TOKEN,
			}),
			(operation) => {
				calls += 1;
				return calls === 1
					? receipt(operation, {
							completed: false,
							error: supabaseDesktopError(
								'confirmation_required',
								'Confirm it first.'
							),
						})
					: receipt(operation);
			}
		);
		const answer = await confirmThenRunSupabaseOperation(bridge, stop, state);
		expect(answer.completed).toBe(true);
		expect(bridge.requestSupabaseConfirmation).toHaveBeenCalledOnce();
		expect(bridge.runSupabaseOperation).toHaveBeenLastCalledWith({
			...stop,
			confirmationToken: TOKEN,
		});
	});

	it('runs a demo destroy end to end with the demo seam', async () => {
		let current = demo();
		const bridge: Pick<
			SupabaseBridge,
			'requestSupabaseConfirmation' | 'runSupabaseOperation'
		> = {
			requestSupabaseConfirmation: async (operation) =>
				confirmSupabaseDemoOperation(operation),
			runSupabaseOperation: async (operation) => {
				const result = applySupabaseDemoOperation(current, operation, now);
				current = result.state;
				return result.receipt;
			},
		};
		const destroy = op({
			kind: 'destroy',
			stackIds: [ids.featGone],
			removeUploads: false,
		});
		const answer = await confirmThenRunSupabaseOperation(
			bridge,
			destroy,
			current
		);
		expect(answer.completed).toBe(true);
		expect(current.stacks.some((stack) => stack.id === ids.featGone)).toBe(
			false
		);
	});
});

describe('notice copy', () => {
	const state = demo();
	const error: SupabaseErrorView = {
		...supabaseDesktopError(
			'refused',
			'Another operation is running on this stack.'
		),
	};

	it('words starts, resumes and stops for the stack they act on', () => {
		const create = supabaseActionCopy(
			{ kind: 'start', stackId: ids.featOnboarding },
			state
		);
		expect(create.pending).toBe(
			'Starting Supabase for feat-onboarding… about 5 s'
		);
		const started = applySupabaseDemoOperation(
			state,
			{ actionId: 'copy-start', kind: 'start', stackId: ids.featOnboarding },
			now
		).state;
		expect(create.success?.(started)).toMatch(
			/^feat-onboarding is running on :\d+\.$/
		);
		expect(create.cancelled).toBe('Start of feat-onboarding cancelled.');
		const resume = supabaseActionCopy(
			{ kind: 'start', stackId: ids.featSearch },
			state
		);
		expect(resume.pending).toBe('Starting feat-search…');
		// A stopped stack keeps its ports, so the resume names the one it reuses.
		expect(resume.success?.(state)).toBe(
			'feat-search resumed on :27402. Data was kept.'
		);
		expect(
			supabaseActionCopy(
				{ kind: 'stop', stackIds: [ids.featCheckout] },
				state
			).success?.(state)
		).toBe(
			'feat-checkout stopped. Data and ports are kept; Resume brings it back in about a second.'
		);
		expect(
			supabaseActionCopy(
				{ kind: 'stop', stackIds: [ids.legacyMain] },
				state
			).success?.(state)
		).toBe(
			"legacy-main stopped. RN Devtools still doesn't manage it; data and ports are kept."
		);
		expect(
			supabaseActionCopy(
				{
					kind: 'stop',
					stackIds: [ids.featCheckout, ids.main, ids.featPayments],
				},
				state
			)
		).toMatchObject({
			pending: 'Stopping 3 stacks…',
			failure: 'Could not stop all 3 stacks',
		});
	});

	it('words holds, requests, repositories and the feature switch', () => {
		expect(
			supabaseActionCopy({ kind: 'unpin', stackId: ids.main }, state).success?.(
				state
			)
		).toBe('Unpinned. main stops 60 s after nothing holds it.');
		expect(
			supabaseActionCopy(
				{
					kind: 'release',
					stackId: ids.featCheckout,
					holder: {
						holder: 'session',
						agentKind: 'codex',
						sessionId: ids.codexAbandoned,
					},
				},
				state
			).success?.(state)
		).toBe("Released Codex 5d1b8f40's hold.");
		const approve = supabaseActionCopy(
			{ kind: 'request.approve', requestId: ids.requestOldUi },
			state
		);
		expect(approve.pending).toBe('Destroying feat-old-ui…');
		expect(approve.success?.(state)).toBe(
			'Destroyed feat-old-ui as Codex session 3c9e7a12 asked.'
		);
		expect(
			supabaseActionCopy(
				{ kind: 'request.deny', requestId: ids.requestOldUi },
				state
			).success?.(state)
		).toBe('Request denied. Codex session 3c9e7a12 is told on its next call.');
		expect(
			supabaseActionCopy(
				{ kind: 'repository.recheck', repositoryId: ids.repositoryApp },
				state
			).success?.(state)
		).toBe('~/code/example-app checked · 2 fixes needed.');
		expect(
			supabaseActionCopy(
				{ kind: 'set-enabled', enabled: false, disposition: 'leave-running' },
				state
			).success?.(state)
			// Three run and one is starting; all four keep going.
		).toBe('Local Supabase is off. 4 stacks keep running.');
		expect(
			supabaseActionCopy(
				{ kind: 'read-logs', stackId: ids.main, tail: 200 },
				state
			)
		).toEqual({ quiet: true });
	});

	it('leads a failure with the action, then main title, message and recovery', () => {
		expect(supabaseFailureText('Could not stop feat-x', error)).toBe(
			'Could not stop feat-x: Not available right now. Another operation is running on this stack.'
		);
		expect(
			supabaseFailureText(undefined, {
				...error,
				title: 'Busy',
				message: 'Another process holds the stack lease',
				recovery: 'Wait a moment, then retry.',
			})
		).toBe(
			'Busy. Another process holds the stack lease. Wait a moment, then retry.'
		);
	});

	it('maps receipts to the shared notice, main message first', () => {
		const copy = supabaseActionCopy({ kind: 'pin', stackId: ids.main }, state);
		const pin = op({ kind: 'pin', stackId: ids.featPayments });
		expect(
			supabaseReceiptNotice(receipt(pin, { cancelled: true }), copy, {}, state)
		).toEqual({ kind: 'idle', message: '' });
		expect(
			supabaseReceiptNotice(
				receipt(pin, { message: 'Pinned by main.' }),
				copy,
				{ success: 'Pinned by the control.' },
				state
			)
		).toEqual({ kind: 'success', message: 'Pinned by main.' });
		expect(
			supabaseReceiptNotice(receipt(pin), copy, { success: 'Pinned.' }, state)
		).toEqual({ kind: 'success', message: 'Pinned.' });
		expect(supabaseReceiptNotice(receipt(pin), copy, {}, state)).toEqual({
			kind: 'success',
			message: 'main keeps running until you unpin or stop it.',
		});
		expect(
			supabaseReceiptNotice(
				receipt(pin, { completed: false, error }),
				copy,
				{},
				state
			)
		).toEqual({
			kind: 'error',
			message:
				'Could not save the pin: Not available right now. Another operation is running on this stack.',
		});
		expect(
			supabaseReceiptNotice(
				receipt(
					op({ kind: 'reveal', stackId: ids.unreadable, what: 'stack-folder' })
				),
				supabaseActionCopy(
					{ kind: 'reveal', stackId: ids.unreadable, what: 'stack-folder' },
					state
				),
				{},
				state
			)
		).toEqual({ kind: 'idle', message: '' });
	});

	it('maps a tracked job to the notice once it ends', () => {
		const copy = supabaseActionCopy(
			{ kind: 'start', stackId: ids.featOnboarding },
			state
		);
		expect(
			supabaseJobNotice({ status: 'running' }, copy, {}, state)
		).toBeUndefined();
		expect(supabaseJobNotice({ status: 'cancelled' }, copy, {}, state)).toEqual(
			{
				kind: 'success',
				message: 'Start of feat-onboarding cancelled.',
			}
		);
		expect(
			supabaseJobNotice(
				{
					status: 'failed',
					error: {
						...error,
						title: 'Migration failed',
						message: '',
						recovery: '',
					},
				},
				copy,
				{},
				state
			)
		).toEqual({
			kind: 'error',
			message: 'Could not start feat-onboarding: Migration failed.',
		});
		expect(
			supabaseJobNotice({ status: 'lost' }, copy, {}, state)?.message
		).toBe(
			'Could not start feat-onboarding: RN Devtools lost track of it when it restarted. Refresh to see where it stands.'
		);
		expect(
			supabaseJobNotice({ status: 'complete' }, copy, {}, state)?.kind
		).toBe('success');
	});
});

describe('settleSupabaseJobs', () => {
	const state = demo();
	const copy = supabaseActionCopy(
		{ kind: 'start', stackId: ids.featOnboarding },
		state
	);
	const watch = (fields: Partial<SupabaseJobWatch> = {}): SupabaseJobWatch => ({
		actionId: 'start-action',
		copy,
		messages: {},
		quiet: false,
		revision: state.revision,
		...fields,
	});
	const running = state.jobs[0] as SupabaseJob;
	const withJob = (
		status: SupabaseJob['status'],
		revision = state.revision
	) => ({
		...state,
		revision,
		jobs: [{ ...running, status }],
	});

	it('keeps watching a running job and remembers it', () => {
		const settled = settleSupabaseJobs(
			new Map([[running.id, watch()]]),
			withJob('running')
		);
		expect(settled.notices).toEqual([]);
		expect(settled.watches.get(running.id)?.last?.status).toBe('running');
	});

	it('leaves the ending notice and stops watching', () => {
		const done = settleSupabaseJobs(
			new Map([[running.id, watch()]]),
			withJob('complete')
		);
		expect(done.watches.size).toBe(0);
		expect(done.notices).toEqual([
			{
				actionId: 'start-action',
				quiet: false,
				status: {
					kind: 'success',
					message: expect.stringMatching(/^feat-onboarding is running/),
				},
			},
		]);
		expect(
			settleSupabaseJobs(new Map([[running.id, watch()]]), withJob('failed'))
				.notices[0]?.status.kind
		).toBe('error');
	});

	it('clears rather than claims an outcome for a job that vanished', () => {
		const seen = watch({ last: running });
		expect(
			settleSupabaseJobs(new Map([[running.id, seen]]), { ...state, jobs: [] })
				.notices
		).toEqual([
			{
				actionId: 'start-action',
				quiet: false,
				status: { kind: 'idle', message: '' },
			},
		]);
		const unseen = new Map([[running.id, watch()]]);
		expect(
			settleSupabaseJobs(unseen, {
				...state,
				jobs: [],
				revision: state.revision + 1,
			}).watches.size
		).toBe(1);
		expect(
			settleSupabaseJobs(unseen, {
				...state,
				jobs: [],
				revision: state.revision + 3,
			}).notices
		).toHaveLength(1);
	});
});

describe('resolveSupabaseInterest', () => {
	const stacks = (
		fields: Partial<SupabaseInterest> = {}
	): SupabaseInterest => ({
		view: 'stacks',
		sections: [],
		...fields,
	});

	it('sends no interest when nothing on screen registers one', () => {
		expect(resolveSupabaseInterest([])).toBe(SUPABASE_NO_INTEREST);
		expect(resolveSupabaseInterest([{ view: 'hidden', sections: [] }])).toBe(
			SUPABASE_NO_INTEREST
		);
	});

	it('merges the inspected stack and its open sections in display order', () => {
		const merged = resolveSupabaseInterest([
			stacks(),
			stacks({ inspectStackId: ids.main, sections: ['logs', 'overview'] }),
			stacks({ inspectStackId: ids.main, sections: ['services'] }),
		]);
		expect(merged).toEqual({
			view: 'stacks',
			inspectStackId: ids.main,
			sections: ['overview', 'services', 'logs'],
		});
		expect(supabaseInterestSchema.parse(merged)).toEqual(merged);
	});

	it('lets the newest view win and never inspects outside Stacks', () => {
		const interest = resolveSupabaseInterest([
			stacks({ inspectStackId: ids.main, sections: ['overview'] }),
			{ view: 'repositories', sections: [] },
		]);
		expect(interest).toEqual({ view: 'repositories', sections: [] });
		expect(supabaseInterestSchema.safeParse(interest).success).toBe(true);
	});
});

describe('supabaseNavigationReducer', () => {
	const start = initialSupabaseNavigation({});

	it('deep-links to a stack: Stacks view, unfiltered, section open, heading focused', () => {
		const filtered: SupabaseNavigation = {
			...start,
			filter: 'external',
			query: 'legacy',
			batchMode: true,
			batchIds: [ids.main],
		};
		const next = supabaseNavigationReducer(filtered, {
			type: 'open',
			intent: { stackId: ids.featCheckout, section: 'logs' },
		});
		expect(next).toMatchObject({
			view: 'stacks',
			selectedStackId: ids.featCheckout,
			filter: 'all',
			query: '',
			batchMode: false,
			batchIds: [],
			sections: { [ids.featCheckout]: { logs: true } },
			focus: { target: 'stack', id: ids.featCheckout, nonce: 1 },
		});
		const handled = supabaseNavigationReducer(next, {
			type: 'focus-handled',
			nonce: 1,
		});
		expect(handled.focus).toBeNull();
		expect(
			supabaseNavigationReducer(next, { type: 'focus-handled', nonce: 0 }).focus
		).toEqual(next.focus);
	});

	it('opens Clean up in Requests and Settings through the gear', () => {
		expect(
			supabaseNavigationReducer(start, {
				type: 'open',
				intent: { section: 'clean-up' },
			})
		).toMatchObject({ view: 'requests', focus: { target: 'clean-up' } });
		const repositories = supabaseNavigationReducer(start, {
			type: 'set-view',
			view: 'repositories',
		});
		const settings = supabaseNavigationReducer(repositories, {
			type: 'toggle-settings',
		});
		expect(settings).toMatchObject({
			view: 'settings',
			returnView: 'repositories',
		});
		expect(
			supabaseNavigationReducer(settings, { type: 'toggle-settings' }).view
		).toBe('repositories');
		expect(
			supabaseNavigationReducer(start, {
				type: 'open',
				intent: { view: 'settings' },
			})
		).toMatchObject({
			view: 'settings',
			returnView: 'stacks',
			focus: { target: 'settings' },
		});
	});

	it('caps the batch at 20 and toggles single stacks', () => {
		const many = Array.from({ length: 25 }, (_, index) => `${index}`);
		const capped = supabaseNavigationReducer(start, {
			type: 'set-batch',
			stackIds: [...many, '1'],
		});
		expect(capped.batchIds).toHaveLength(20);
		expect(
			supabaseNavigationReducer(capped, { type: 'toggle-batch', stackId: '99' })
				.batchIds
		).toHaveLength(20);
		const toggled = supabaseNavigationReducer(capped, {
			type: 'toggle-batch',
			stackId: '0',
		});
		expect(toggled.batchIds).not.toContain('0');
		expect(
			supabaseNavigationReducer(toggled, {
				type: 'set-batch-mode',
				enabled: false,
			}).batchIds
		).toEqual([]);
	});

	it('remembers section choices per stack, for at most 128 stacks', () => {
		let navigation = start;
		for (let index = 0; index < 130; index += 1) {
			navigation = supabaseNavigationReducer(navigation, {
				type: 'set-section',
				stackId: `stack-${index}`,
				section: 'database',
				open: true,
			});
		}
		expect(Object.keys(navigation.sections)).toHaveLength(128);
		expect(navigation.sections['stack-129']).toEqual({ database: true });
		expect(navigation.sections['stack-0']).toBeUndefined();
		const closed = supabaseNavigationReducer(navigation, {
			type: 'set-section',
			stackId: 'stack-129',
			section: 'logs',
			open: false,
		});
		expect(closed.sections['stack-129']).toEqual({
			database: true,
			logs: false,
		});
	});
});

describe('navigation preferences', () => {
	it('restores a known view and filter, and ignores the rest', () => {
		const stored = new Map<string, string>([
			['rndevtools.desktop.supabase.view', 'repositories'],
			['rndevtools.desktop.supabase.filter', 'attention'],
		]);
		const storage = { getItem: (key: string) => stored.get(key) ?? null };
		expect(readSupabaseNavigationPreferences(storage)).toEqual({
			view: 'repositories',
			filter: 'attention',
		});
		stored.set('rndevtools.desktop.supabase.view', 'tables');
		stored.set('rndevtools.desktop.supabase.filter', 'everything');
		expect(readSupabaseNavigationPreferences(storage)).toEqual({});
		expect(
			readSupabaseNavigationPreferences({
				getItem: () => {
					throw new Error('Storage is disabled.');
				},
			})
		).toEqual({});
		expect(readSupabaseNavigationPreferences(undefined)).toEqual({});
	});

	it('writes the view and filter, tolerating a full storage', () => {
		const setItem = vi.fn();
		writeSupabaseNavigationPreferences(
			{ setItem },
			{
				view: 'requests',
				filter: 'running',
			}
		);
		expect(setItem.mock.calls).toEqual([
			['rndevtools.desktop.supabase.view', 'requests'],
			['rndevtools.desktop.supabase.filter', 'running'],
		]);
		expect(() =>
			writeSupabaseNavigationPreferences(
				{
					setItem: () => {
						throw new Error('Quota exceeded.');
					},
				},
				{ view: 'stacks', filter: 'all' }
			)
		).not.toThrow();
	});

	it('returns from a restored Settings view to Stacks', () => {
		expect(initialSupabaseNavigation({ view: 'settings' })).toMatchObject({
			view: 'settings',
			returnView: 'stacks',
		});
		expect(initialSupabaseNavigation({})).toEqual(INITIAL_SUPABASE_NAVIGATION);
	});
});

describe('navigation additions for the views', () => {
	const start = initialSupabaseNavigation({});

	it('keeps the Repositories search apart from the Stacks search', () => {
		const searched = supabaseNavigationReducer(
			supabaseNavigationReducer(start, { type: 'set-query', query: 'feat' }),
			{ type: 'set-repository-query', query: 'example-admin' }
		);
		expect(searched).toMatchObject({
			query: 'feat',
			repositoryQuery: 'example-admin',
		});
		expect(
			supabaseNavigationReducer(start, {
				type: 'set-repository-query',
				query: 'x'.repeat(400),
			}).repositoryQuery
		).toHaveLength(256);
	});

	it('carries a deep link’s section to the focus request, so the view reads it', () => {
		const next = supabaseNavigationReducer(start, {
			type: 'open',
			intent: { stackId: ids.featCheckout, section: 'database' },
		});
		expect(next.focus).toEqual({
			target: 'stack',
			id: ids.featCheckout,
			section: 'database',
			nonce: 1,
		});
		expect(
			supabaseNavigationReducer(start, {
				type: 'open',
				intent: { section: 'clean-up' },
			}).focus
		).toEqual({ target: 'clean-up', nonce: 1 });
	});

	it('focuses a heading without moving the view or the filters', () => {
		const filtered = supabaseNavigationReducer(start, {
			type: 'set-filter',
			filter: 'running',
		});
		const focused = supabaseNavigationReducer(filtered, {
			type: 'request-focus',
			target: 'stack',
		});
		expect(focused).toMatchObject({
			view: 'stacks',
			filter: 'running',
			focus: { target: 'stack', nonce: 1 },
		});
		expect(focused.focus?.id).toBeUndefined();
		expect(
			supabaseNavigationReducer(focused, { type: 'focus-handled', nonce: 1 })
				.focus
		).toBeNull();
	});
});

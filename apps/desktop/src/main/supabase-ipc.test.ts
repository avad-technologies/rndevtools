import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createSupabaseDemoState,
	SUPABASE_DEMO_IDS,
	SUPABASE_DEMO_NOW,
} from '../shared/supabase-demo-data';
import {
	SUPABASE_NO_INTEREST,
	type SupabaseInterest,
	type SupabaseOperation,
	type SupabaseOperationReceipt,
	type SupabaseState,
	supabaseOperationSchema,
	withSupabaseConfirmation,
} from '../shared/supabase-protocol';
import { ActionConfirmationStore } from './action-confirmation-store';
import type {
	SupabaseConfirmationFacts,
	SupabaseDialogOwner,
	SupabaseMessageBoxOptions,
	SupabaseOperationContext,
} from './supabase/service-ports';
import {
	createSupabaseInterestGate,
	createSupabaseIpcHandlers,
	createSupabaseStatePublisher,
	supabaseInterestKey,
} from './supabase-ipc';

const ids = SUPABASE_DEMO_IDS;
const SENDER = { sender: { id: 7 } };
const OTHER_SENDER = { sender: { id: 8 } };
const TOKEN = /^confirmation-[a-f0-9]{64}$/;

/** Demo set A, as if main had listed it: tokens apply. */
function liveState(
	variant: 'full' | 'off' = 'full',
	overrides: Partial<SupabaseState> = {}
): SupabaseState {
	return {
		...createSupabaseDemoState({ variant }),
		source: 'live',
		...overrides,
	};
}

let counter = 0;
function op(fields: Record<string, unknown>): SupabaseOperation {
	counter += 1;
	return supabaseOperationSchema.parse({
		actionId: `action-${counter}`,
		...fields,
	});
}

const destroyFacts: SupabaseConfirmationFacts = {
	title: 'Destroy the local Supabase stack for feat-gone?',
	lines: [
		"Deletes its database and logs and frees 10 ports. This can't be undone.",
		'Stack 5e8d2c4a… · native · 64 MB',
	],
	choices: [{ label: 'Destroy feat-gone (64 MB)' }],
	checkbox: { label: 'Also delete Storage uploads', checkedByDefault: false },
};

const turnOffFacts: SupabaseConfirmationFacts = {
	title: 'Turn off local Supabase?',
	lines: ['3 managed stacks are running.'],
	choices: [
		{ label: 'Leave them running', disposition: 'leave-running' },
		{ label: 'Stop managed stacks', disposition: 'stop-managed' },
	],
};

function fixture({
	state = liveState(),
	facts = destroyFacts,
	answer = { response: 1, checkboxChecked: false },
}: {
	state?: SupabaseState;
	/** `null`: main cannot describe the dialog. */
	facts?: SupabaseConfirmationFacts | null;
	answer?: { response: number; checkboxChecked: boolean };
} = {}) {
	let clock = SUPABASE_DEMO_NOW;
	let current = state;
	const service = {
		getState: vi.fn(() => current),
		runOperation: vi.fn(
			async (
				operation: SupabaseOperation,
				_context: SupabaseOperationContext
			): Promise<SupabaseOperationReceipt> => ({
				actionId: operation.actionId,
				kind: operation.kind,
				completed: true,
			})
		),
		describeConfirmation: vi.fn(
			async (_operation: SupabaseOperation) => facts ?? undefined
		),
		setInterest: vi.fn(),
	};
	const showConfirmationDialog = vi.fn(
		async (_options: SupabaseMessageBoxOptions, _owner?: SupabaseDialogOwner) =>
			answer
	);
	const assertTrustedSender = vi.fn();
	const handlers = createSupabaseIpcHandlers({
		service,
		confirmations: new ActionConfirmationStore({ now: () => clock }),
		showConfirmationDialog,
		assertTrustedSender,
		now: () => clock,
	});
	return {
		service,
		showConfirmationDialog,
		assertTrustedSender,
		handlers,
		advance: (milliseconds: number) => {
			clock += milliseconds;
		},
		setState: (next: SupabaseState) => {
			current = next;
		},
	};
}

type Handlers = ReturnType<typeof fixture>['handlers'];

/** The renderer's confirm-then-run step, up to the run. */
async function confirmed(
	handlers: Handlers,
	requested: SupabaseOperation,
	event = SENDER
): Promise<SupabaseOperation> {
	const result = await handlers.requestConfirmation(event, requested);
	const merged = withSupabaseConfirmation(requested, result);
	if (!merged.ok) throw new Error(merged.error);
	return merged.operation;
}

describe('Supabase IPC', () => {
	it('checks the sender and validates the state it returns', () => {
		const { handlers, assertTrustedSender } = fixture();
		expect(handlers.getState(SENDER)).toEqual(liveState());
		expect(assertTrustedSender).toHaveBeenCalledWith(SENDER);
	});

	it('refuses an untrusted sender before touching the service', async () => {
		const { handlers, service, assertTrustedSender } = fixture();
		assertTrustedSender.mockImplementation(() => {
			throw new Error('Rejected IPC from an untrusted renderer.');
		});
		const destroy = op({
			kind: 'destroy',
			stackIds: [ids.featGone],
			removeUploads: false,
		});
		expect(() => handlers.getState(SENDER)).toThrow(/untrusted/);
		await expect(handlers.runOperation(SENDER, destroy)).rejects.toThrow(
			/untrusted/
		);
		await expect(handlers.requestConfirmation(SENDER, destroy)).rejects.toThrow(
			/untrusted/
		);
		expect(service.getState).not.toHaveBeenCalled();
		expect(service.runOperation).not.toHaveBeenCalled();
	});

	it('rejects malformed operations before they reach the service', async () => {
		const { handlers, service, showConfirmationDialog } = fixture();
		for (const value of [
			{
				actionId: 'a-1',
				kind: 'destroy',
				stackIds: ['../x'],
				removeUploads: false,
			},
			// Operations name ids only; a path never rides along.
			{
				actionId: 'a-2',
				kind: 'start',
				stackId: ids.featGone,
				worktreePath: '/Users/example/code/example-app',
			},
			{ actionId: 'a-3', kind: 'run-shell', command: 'supabase stop --all' },
		]) {
			await expect(handlers.runOperation(SENDER, value)).rejects.toThrow();
			await expect(
				handlers.requestConfirmation(SENDER, value)
			).rejects.toThrow();
		}
		expect(service.runOperation).not.toHaveBeenCalled();
		expect(service.describeConfirmation).not.toHaveBeenCalled();
		expect(showConfirmationDialog).not.toHaveBeenCalled();
	});

	it('turns a refusal from the shared rules into a receipt without running', async () => {
		const off = fixture({ state: liveState('off') });
		await expect(
			off.handlers.runOperation(SENDER, op({ kind: 'refresh' }))
		).resolves.toMatchObject({
			kind: 'refresh',
			completed: false,
			error: { code: 'feature_off' },
		});
		const { handlers, service, showConfirmationDialog } = fixture();
		const attached = op({
			kind: 'destroy',
			stackIds: [ids.featCheckout],
			removeUploads: false,
		});
		const refused = await handlers.runOperation(SENDER, attached);
		expect(refused).toMatchObject({
			actionId: attached.actionId,
			completed: false,
			error: {
				code: 'refused',
				message:
					'Lane :8102 is attached and running. Stop the lane in Lanes first.',
			},
		});
		// No dialog is shown for something that would be refused anyway.
		await expect(
			handlers.requestConfirmation(SENDER, attached)
		).resolves.toEqual({
			actionId: attached.actionId,
			required: true,
			confirmed: false,
			error:
				'Lane :8102 is attached and running. Stop the lane in Lanes first.',
		});
		await expect(
			handlers.runOperation(
				SENDER,
				op({ kind: 'start', stackId: 'f'.repeat(64) })
			)
		).resolves.toMatchObject({ error: { code: 'unknown_target' } });
		expect(service.runOperation).not.toHaveBeenCalled();
		expect(off.service.runOperation).not.toHaveBeenCalled();
		expect(showConfirmationDialog).not.toHaveBeenCalled();
	});

	it('makes room only by stopping a stack the capacity request offers', async () => {
		const base = liveState();
		const [template] = base.requests;
		if (!template) throw new Error('missing demo request');
		const request = {
			...template,
			id: 'supabase-request-00000000-0000-4000-8000-0000000000aa',
			kind: 'start-capacity' as const,
			capacity: {
				running: 12,
				cap: 12,
				candidates: [
					{
						stackId: ids.featPayments,
						branch: 'feat-payments',
						liveHolder: true,
					},
				],
			},
		};
		const { handlers, service, showConfirmationDialog } = fixture({
			state: { ...base, requests: [request] },
		});
		// An external stack is stopped only from its detail, behind the dialog.
		for (const stopStackId of [ids.legacyMain, 'f'.repeat(64)]) {
			await expect(
				handlers.runOperation(
					SENDER,
					op({ kind: 'request.approve', requestId: request.id, stopStackId })
				)
			).resolves.toMatchObject({
				completed: false,
				error: {
					code: 'refused',
					message: "That stack isn't one to stop to make room. Choose another.",
				},
			});
		}
		expect(service.runOperation).not.toHaveBeenCalled();
		const offered = op({
			kind: 'request.approve',
			requestId: request.id,
			stopStackId: ids.featPayments,
		});
		await expect(handlers.runOperation(SENDER, offered)).resolves.toMatchObject(
			{ completed: true }
		);
		expect(service.runOperation).toHaveBeenCalledTimes(1);
		expect(showConfirmationDialog).not.toHaveBeenCalled();
	});

	it('runs what needs no dialog as the operator, unconfirmed', async () => {
		const { handlers, service, showConfirmationDialog } = fixture();
		const stop = op({ kind: 'stop', stackIds: [ids.featPayments] });
		await expect(handlers.requestConfirmation(SENDER, stop)).resolves.toEqual({
			actionId: stop.actionId,
			required: false,
			confirmed: true,
		});
		expect(service.describeConfirmation).not.toHaveBeenCalled();
		expect(showConfirmationDialog).not.toHaveBeenCalled();
		await expect(handlers.runOperation(SENDER, stop)).resolves.toEqual({
			actionId: stop.actionId,
			kind: 'stop',
			completed: true,
		});
		expect(service.runOperation).toHaveBeenCalledWith(stop, {
			actor: { kind: 'operator', senderId: 7 },
			confirmed: false,
		});
	});

	it('shows main-built, sanitized facts with Cancel first and default', async () => {
		const { handlers, service, showConfirmationDialog } = fixture({
			facts: {
				...destroyFacts,
				title: 'Destroy the local Supabase stack for feat-gone\u{202e}?\n',
				lines: ['Deletes its database\u0007 and logs.', ''],
			},
			answer: { response: 0, checkboxChecked: false },
		});
		const destroy = op({
			kind: 'destroy',
			stackIds: [ids.featGone],
			removeUploads: false,
		});
		await handlers.requestConfirmation(SENDER, destroy);
		expect(service.describeConfirmation).toHaveBeenCalledWith(destroy);
		expect(showConfirmationDialog).toHaveBeenCalledWith(
			{
				type: 'warning',
				title: 'Destroy the local Supabase stack for feat-gone ?',
				message: 'Destroy the local Supabase stack for feat-gone ?',
				detail: 'Deletes its database and logs.\n',
				buttons: ['Cancel', 'Destroy feat-gone (64 MB)'],
				defaultId: 0,
				cancelId: 0,
				noLink: true,
				checkboxLabel: 'Also delete Storage uploads',
				checkboxChecked: false,
			},
			{ senderId: 7 }
		);
	});

	it('treats Cancel as no confirmation and issues no token', async () => {
		const { handlers, service } = fixture({
			answer: { response: 0, checkboxChecked: true },
		});
		const destroy = op({
			kind: 'destroy',
			stackIds: [ids.featGone],
			removeUploads: false,
		});
		const result = await handlers.requestConfirmation(SENDER, destroy);
		expect(result).toEqual({
			actionId: destroy.actionId,
			required: true,
			confirmed: false,
		});
		expect(withSupabaseConfirmation(destroy, result).ok).toBe(false);
		await expect(handlers.runOperation(SENDER, destroy)).resolves.toMatchObject(
			{ completed: false, error: { code: 'confirmation_required' } }
		);
		expect(service.runOperation).not.toHaveBeenCalled();
	});

	it('binds the dialog choice into a single-use token for the asking renderer', async () => {
		const { handlers, service } = fixture({
			answer: { response: 1, checkboxChecked: true },
		});
		const destroy = op({
			kind: 'destroy',
			stackIds: [ids.featGone],
			removeUploads: false,
		});
		const result = await handlers.requestConfirmation(SENDER, destroy);
		expect(result).toMatchObject({
			actionId: destroy.actionId,
			required: true,
			confirmed: true,
			expiresAt: SUPABASE_DEMO_NOW + 60_000,
			options: { removeUploads: true },
		});
		expect(result.token).toMatch(TOKEN);
		const merged = withSupabaseConfirmation(destroy, result);
		if (!merged.ok) throw new Error(merged.error);
		await expect(
			handlers.runOperation(SENDER, merged.operation)
		).resolves.toMatchObject({ completed: true });
		expect(service.runOperation).toHaveBeenCalledWith(
			expect.objectContaining({ kind: 'destroy', removeUploads: true }),
			{ actor: { kind: 'operator', senderId: 7 }, confirmed: true }
		);
		// The token is spent.
		await expect(
			handlers.runOperation(SENDER, merged.operation)
		).resolves.toMatchObject({
			completed: false,
			error: { code: 'confirmation_required' },
		});
		expect(service.runOperation).toHaveBeenCalledTimes(1);
	});

	it('refuses a token used for another action, option, target or renderer', async () => {
		const { handlers, service } = fixture();
		const request = () =>
			op({ kind: 'destroy', stackIds: [ids.featGone], removeUploads: false });
		const confirmedDestroy = async () => {
			const operation = await confirmed(handlers, request());
			if (operation.kind !== 'destroy') throw new Error('Not a destroy.');
			return operation;
		};
		const tampered: SupabaseOperation[] = [
			{ ...(await confirmedDestroy()), actionId: 'action-other' },
			{ ...(await confirmedDestroy()), removeUploads: true },
			{ ...(await confirmedDestroy()), stackIds: [ids.featSearch] },
			{
				...(await confirmedDestroy()),
				stackIds: [ids.featGone, ids.featSearch],
			},
		];
		for (const operation of tampered) {
			await expect(
				handlers.runOperation(SENDER, operation)
			).resolves.toMatchObject({
				completed: false,
				error: { code: 'confirmation_required' },
			});
		}
		const elsewhere = await confirmedDestroy();
		await expect(
			handlers.runOperation(OTHER_SENDER, elsewhere)
		).resolves.toMatchObject({ error: { code: 'confirmation_required' } });
		expect(service.runOperation).not.toHaveBeenCalled();
	});

	it('binds a batch to its set of stacks, not their order', async () => {
		const { handlers, service } = fixture();
		const operation = await confirmed(
			handlers,
			op({
				kind: 'destroy',
				stackIds: [ids.featGone, ids.featSearch],
				removeUploads: false,
			})
		);
		if (operation.kind !== 'destroy') throw new Error('Not a destroy.');
		await expect(
			handlers.runOperation(SENDER, {
				...operation,
				stackIds: [ids.featSearch, ids.featGone],
			})
		).resolves.toMatchObject({ completed: true });
		expect(service.runOperation).toHaveBeenCalledOnce();
	});

	it('refuses an expired token', async () => {
		const { handlers, service, advance } = fixture();
		const operation = await confirmed(
			handlers,
			op({ kind: 'destroy', stackIds: [ids.featGone], removeUploads: false })
		);
		advance(60_001);
		await expect(
			handlers.runOperation(SENDER, operation)
		).resolves.toMatchObject({ error: { code: 'confirmation_required' } });
		expect(service.runOperation).not.toHaveBeenCalled();
	});

	it('checks a run before spending its token', async () => {
		const { handlers, service, setState } = fixture();
		const operation = await confirmed(
			handlers,
			op({ kind: 'destroy', stackIds: [ids.featGone], removeUploads: false })
		);
		setState(
			liveState('full', { feature: { enabled: false, policyHealth: 'ok' } })
		);
		await expect(
			handlers.runOperation(SENDER, operation)
		).resolves.toMatchObject({ error: { code: 'feature_off' } });
		setState(liveState());
		await expect(
			handlers.runOperation(SENDER, operation)
		).resolves.toMatchObject({ completed: true });
		expect(service.runOperation).toHaveBeenCalledOnce();
	});

	it('binds the turn-off button into the token', async () => {
		const { handlers, service, showConfirmationDialog } = fixture({
			facts: turnOffFacts,
			answer: { response: 2, checkboxChecked: false },
		});
		const turnOff = op({ kind: 'set-enabled', enabled: false });
		const result = await handlers.requestConfirmation(SENDER, turnOff);
		expect(result).toMatchObject({
			confirmed: true,
			options: { disposition: 'stop-managed' },
		});
		expect(showConfirmationDialog.mock.calls[0]?.[0]).toMatchObject({
			buttons: ['Cancel', 'Leave them running', 'Stop managed stacks'],
			defaultId: 0,
			cancelId: 0,
		});
		const merged = withSupabaseConfirmation(turnOff, result);
		if (!merged.ok) throw new Error(merged.error);
		await expect(
			handlers.runOperation(SENDER, merged.operation)
		).resolves.toMatchObject({ completed: true });
		expect(service.runOperation).toHaveBeenCalledWith(
			expect.objectContaining({ disposition: 'stop-managed' }),
			expect.objectContaining({ confirmed: true })
		);
		const again = await confirmed(handlers, turnOff);
		await expect(
			handlers.runOperation(SENDER, { ...again, disposition: 'leave-running' })
		).resolves.toMatchObject({ error: { code: 'confirmation_required' } });
	});

	it("binds an approved agent request's uploads choice into the token", async () => {
		const { handlers, service } = fixture({
			answer: { response: 1, checkboxChecked: true },
		});
		const approve = op({
			kind: 'request.approve',
			requestId: ids.requestOldUi,
		});
		const operation = await confirmed(handlers, approve);
		expect(operation).toMatchObject({ removeUploads: true });
		await expect(
			handlers.runOperation(SENDER, { ...operation, removeUploads: false })
		).resolves.toMatchObject({ error: { code: 'confirmation_required' } });
		const retried = await confirmed(handlers, approve);
		await expect(handlers.runOperation(SENDER, retried)).resolves.toMatchObject(
			{ completed: true }
		);
		expect(service.runOperation).toHaveBeenCalledOnce();
		expect(service.runOperation).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'request.approve',
				removeUploads: true,
			}),
			expect.objectContaining({ confirmed: true })
		);
	});

	it('asks only for trust-weakening policy changes', async () => {
		const { handlers, service, showConfirmationDialog } = fixture({
			facts: {
				title: 'Allow unverified Supabase CLI patch releases?',
				lines: ['RN Devtools has not tested them.'],
				choices: [{ label: 'Allow unverified releases' }],
			},
		});
		const limit = op({ kind: 'update-policy', patch: { maxRunning: 6 } });
		await expect(
			handlers.requestConfirmation(SENDER, limit)
		).resolves.toMatchObject({ required: false, confirmed: true });
		const trust = op({
			kind: 'update-policy',
			patch: { allowUnverifiedPatch: true },
		});
		await expect(handlers.runOperation(SENDER, trust)).resolves.toMatchObject({
			error: { code: 'confirmation_required' },
		});
		const confirmedTrust = await confirmed(handlers, trust);
		await expect(
			handlers.runOperation(SENDER, confirmedTrust)
		).resolves.toMatchObject({ completed: true });
		expect(showConfirmationDialog).toHaveBeenCalledOnce();
		expect(service.runOperation).toHaveBeenCalledWith(
			expect.objectContaining({ patch: { allowUnverifiedPatch: true } }),
			expect.objectContaining({ confirmed: true })
		);
	});

	it('refuses a request that already carries a token', async () => {
		const { handlers, showConfirmationDialog } = fixture();
		const destroy = await confirmed(
			handlers,
			op({ kind: 'destroy', stackIds: [ids.featGone], removeUploads: false })
		);
		await expect(
			handlers.requestConfirmation(SENDER, destroy)
		).resolves.toEqual({
			actionId: destroy.actionId,
			required: true,
			confirmed: false,
			error: 'Confirmation requests cannot reuse an existing token.',
		});
		expect(showConfirmationDialog).toHaveBeenCalledOnce();
	});

	it('refuses to show a dialog main cannot describe', async () => {
		const destroy = op({
			kind: 'destroy',
			stackIds: [ids.featGone],
			removeUploads: false,
		});
		for (const facts of [
			null,
			{ ...destroyFacts, choices: [] },
			{ ...destroyFacts, choices: [{ label: '\u{202e}\u0007 ' }] },
			{ ...destroyFacts, title: '\n' },
		]) {
			const { handlers, showConfirmationDialog } = fixture({ facts });
			await expect(
				handlers.requestConfirmation(SENDER, destroy)
			).resolves.toEqual({
				actionId: destroy.actionId,
				required: true,
				confirmed: false,
				error:
					'RN Devtools could not describe this action. Refresh the Supabase tab, then try again.',
			});
			expect(showConfirmationDialog).not.toHaveBeenCalled();
		}
	});

	it('redacts and bounds what fails', async () => {
		const { handlers, service } = fixture();
		const secret =
			'postgresql://postgres:hunter2@127.0.0.1:54322/postgres sb_secret_exampleexample';
		service.describeConfirmation.mockRejectedValueOnce(
			new Error(`Could not list stacks: ${secret}\n${'x'.repeat(5_000)}`)
		);
		const result = await handlers.requestConfirmation(
			SENDER,
			op({ kind: 'destroy', stackIds: [ids.featGone], removeUploads: false })
		);
		expect(result).toMatchObject({ required: true, confirmed: false });
		expect(result.error).toMatch(/^Could not list stacks/);
		expect(result.error?.length).toBeLessThanOrEqual(1_024);
		expect(JSON.stringify(result)).not.toMatch(/hunter2|sb_secret_/);

		service.runOperation.mockRejectedValueOnce(
			new Error(`${secret} ${'y'.repeat(5_000)}`)
		);
		const failed = await handlers.runOperation(
			SENDER,
			op({ kind: 'stop', stackIds: [ids.featPayments] })
		);
		expect(failed).toMatchObject({
			completed: false,
			error: { code: 'internal' },
		});
		expect(failed.error?.message.length).toBeLessThanOrEqual(4_096);
		expect(JSON.stringify(failed)).not.toMatch(/hunter2|sb_secret_/);

		service.runOperation.mockResolvedValueOnce({
			actionId: 'action-someone-else',
			kind: 'stop',
			completed: true,
		});
		await expect(
			handlers.runOperation(
				SENDER,
				op({ kind: 'stop', stackIds: [ids.featPayments] })
			)
		).resolves.toMatchObject({
			completed: false,
			error: {
				code: 'internal',
				message:
					'RN Devtools could not read the result of this Supabase action.',
			},
		});
	});

	it('shows no dialog and needs no token for demo stacks', async () => {
		const { handlers, service, showConfirmationDialog } = fixture({
			state: createSupabaseDemoState(),
		});
		const destroy = op({
			kind: 'destroy',
			stackIds: [ids.featGone],
			removeUploads: false,
		});
		await expect(
			handlers.requestConfirmation(SENDER, destroy)
		).resolves.toEqual({
			actionId: destroy.actionId,
			required: false,
			confirmed: true,
		});
		await expect(handlers.runOperation(SENDER, destroy)).resolves.toMatchObject(
			{ completed: true }
		);
		expect(service.runOperation).toHaveBeenCalledWith(destroy, {
			actor: { kind: 'operator', senderId: 7 },
			confirmed: false,
		});
		expect(service.describeConfirmation).not.toHaveBeenCalled();
		expect(showConfirmationDialog).not.toHaveBeenCalled();
	});

	it('forwards interest per renderer and drops bad messages', () => {
		const { handlers, service, assertTrustedSender } = fixture();
		const interest: SupabaseInterest = {
			view: 'stacks',
			inspectStackId: ids.featCheckout,
			sections: ['overview', 'logs'],
		};
		expect(handlers.setInterest(SENDER, interest)).toBe(true);
		expect(service.setInterest).toHaveBeenCalledWith('renderer-7', interest);
		expect(
			handlers.setInterest(SENDER, {
				view: 'settings',
				inspectStackId: ids.featCheckout,
				sections: [],
			})
		).toBe(false);
		assertTrustedSender.mockImplementation(() => {
			throw new Error('Rejected IPC from an untrusted renderer.');
		});
		expect(handlers.setInterest(OTHER_SENDER, interest)).toBe(false);
		expect(service.setInterest).toHaveBeenCalledOnce();
	});
});

describe('Supabase interest gate', () => {
	const stacks: SupabaseInterest = {
		view: 'stacks',
		inspectStackId: ids.featCheckout,
		sections: ['overview'],
	};
	const settings: SupabaseInterest = { view: 'settings', sections: [] };

	it('passes interest on only while the window is visible', () => {
		const setInterest = vi.fn();
		const gate = createSupabaseInterestGate(setInterest);
		const key = supabaseInterestKey(3);
		gate.setVisible(key, false);
		expect(setInterest).not.toHaveBeenCalled();
		gate.setInterest(key, stacks);
		expect(setInterest).toHaveBeenLastCalledWith(key, SUPABASE_NO_INTEREST);
		gate.setVisible(key, true);
		expect(setInterest).toHaveBeenLastCalledWith(key, stacks);
		gate.setVisible(key, true);
		expect(setInterest).toHaveBeenCalledTimes(2);
		gate.setVisible(key, false);
		expect(setInterest).toHaveBeenLastCalledWith(key, SUPABASE_NO_INTEREST);
		gate.setInterest(key, settings);
		gate.setVisible(key, true);
		expect(setInterest).toHaveBeenLastCalledWith(key, settings);
	});

	it('treats a window it was never told about as visible', () => {
		const setInterest = vi.fn();
		const gate = createSupabaseInterestGate(setInterest);
		gate.setInterest('renderer-4', stacks);
		expect(setInterest).toHaveBeenCalledWith('renderer-4', stacks);
	});

	it('drops a closed window once', () => {
		const setInterest = vi.fn();
		const gate = createSupabaseInterestGate(setInterest);
		gate.drop('renderer-5');
		expect(setInterest).not.toHaveBeenCalled();
		gate.setInterest('renderer-5', stacks);
		gate.drop('renderer-5');
		gate.drop('renderer-5');
		expect(setInterest).toHaveBeenCalledTimes(2);
		expect(setInterest).toHaveBeenLastCalledWith(
			'renderer-5',
			SUPABASE_NO_INTEREST
		);
	});
});

describe('Supabase state publisher', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	const at = (revision: number): SupabaseState => ({
		...liveState(),
		revision,
	});

	it('coalesces pushes to one per 100 ms, only on a new revision', () => {
		vi.useFakeTimers();
		const send = vi.fn();
		const publisher = createSupabaseStatePublisher(send);
		publisher.publish(at(2));
		publisher.publish(at(3));
		vi.advanceTimersByTime(99);
		expect(send).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(send).toHaveBeenCalledOnce();
		expect(send.mock.calls[0]?.[0]).toMatchObject({ revision: 3 });
		publisher.publish(at(3));
		vi.advanceTimersByTime(100);
		expect(send).toHaveBeenCalledOnce();
		publisher.publish(at(4));
		vi.advanceTimersByTime(100);
		expect(send).toHaveBeenCalledTimes(2);
	});

	it('never pushes a state that does not validate', () => {
		vi.useFakeTimers();
		const send = vi.fn();
		const publisher = createSupabaseStatePublisher(send);
		publisher.publish({
			...at(5),
			stacks: [{ id: 'not-a-stack-id' }],
		} as unknown as SupabaseState);
		vi.advanceTimersByTime(100);
		expect(send).not.toHaveBeenCalled();
		publisher.publish(at(5));
		vi.advanceTimersByTime(100);
		expect(send).toHaveBeenCalledOnce();
	});

	it('drops a pending push when disposed', () => {
		vi.useFakeTimers();
		const send = vi.fn();
		const publisher = createSupabaseStatePublisher(send);
		publisher.publish(at(6));
		publisher.dispose();
		vi.advanceTimersByTime(1_000);
		publisher.publish(at(7));
		vi.advanceTimersByTime(1_000);
		expect(send).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});

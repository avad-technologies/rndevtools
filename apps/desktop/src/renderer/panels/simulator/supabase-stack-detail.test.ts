import { describe, expect, it } from 'vitest';
import {
	createSupabaseDemoState,
	SUPABASE_DEMO_IDS,
	SUPABASE_DEMO_NOW,
} from '../../../shared/supabase-demo-data';
import {
	type SupabaseAvailability,
	type SupabaseLogRecord,
	type SupabaseLogsPayload,
	type SupabaseStackSummary,
	type SupabaseState,
	supabaseDesktopError,
} from '../../../shared/supabase-protocol';
import {
	type SupabaseStackReads,
	supabaseActionReasons,
	supabaseLogsAfterRefresh,
	supabaseNoticeControls,
	supabaseStudioControls,
} from './supabase-stack-detail';

const ids = SUPABASE_DEMO_IDS;
const context = { bridgeAvailable: true, now: SUPABASE_DEMO_NOW };
const allowed: SupabaseAvailability = { allowed: true };

function refused(reason: string): SupabaseAvailability {
	return { allowed: false, reason, check: 'state' };
}

function stackIn(state: SupabaseState, id: string): SupabaseStackSummary {
	const stack = state.stacks.find((candidate) => candidate.id === id);
	if (!stack) throw new Error(`No demo stack ${id}`);
	return stack;
}

describe('supabaseNoticeControls', () => {
	it('drops notice buttons the action row already shows', () => {
		const control = (id: string) => ({
			id,
			label: id,
			availability: allowed,
			confirmation: { kind: 'none' } as const,
		});
		expect(
			supabaseNoticeControls(
				{ controls: [control('try-again'), control('destroy')] },
				new Set(['try-again', 'open-logs'])
			).map((item) => item.id)
		).toEqual(['destroy']);
	});
});

describe('supabaseActionReasons', () => {
	it('lists each refusal once, with every control it explains', () => {
		expect(
			supabaseActionReasons([
				{ id: 'stop', availability: refused('Another operation is running.') },
				{ id: 'restart', availability: allowed },
				{ id: 'pin', availability: refused('Another operation is running.') },
				{ id: 'resume', availability: refused('The worktree moved.') },
			])
		).toEqual([
			{
				reason: 'Another operation is running.',
				controlIds: ['stop', 'pin'],
			},
			{ reason: 'The worktree moved.', controlIds: ['resume'] },
		]);
		expect(
			supabaseActionReasons([{ id: 'stop', availability: allowed }])
		).toEqual([]);
	});
});

describe('supabaseStudioControls', () => {
	it('offers Enable Studio… while it is excluded, through the native dialog', () => {
		const state = createSupabaseDemoState();
		const controls = supabaseStudioControls(
			stackIn(state, ids.featCheckout),
			state,
			context
		);
		expect(controls.map((control) => control.label)).toEqual([
			'Enable Studio…',
		]);
		expect(controls[0]).toMatchObject({
			operation: {
				kind: 'set-studio',
				stackId: ids.featCheckout,
				enabled: true,
			},
			confirmation: { kind: 'native' },
			availability: { allowed: true },
		});
	});

	it('offers Open and Disable once Studio runs, Disable confirming with live agents', () => {
		const base = createSupabaseDemoState();
		const state: SupabaseState = {
			...base,
			stacks: base.stacks.map((stack) =>
				stack.id === ids.featCheckout
					? {
							...stack,
							studio: { included: true, operatorEnabled: true },
							excluded: ['analytics'],
							studioUrl: 'http://127.0.0.1:21737',
							ports: { ...stack.ports, studio: 21_737 },
						}
					: stack
			),
		};
		const controls = supabaseStudioControls(
			stackIn(state, ids.featCheckout),
			state,
			context
		);
		expect(controls.map((control) => control.label)).toEqual([
			'Open Studio',
			'Disable Studio',
		]);
		expect(controls[1]?.confirmation).toEqual({
			kind: 'inline',
			agents: ['Claude 7f3a2c91'],
		});
	});

	it('shows the reason when the stack belongs to someone else', () => {
		const state = createSupabaseDemoState();
		const [enable] = supabaseStudioControls(
			stackIn(state, ids.legacyMain),
			state,
			context
		);
		expect(enable?.availability).toMatchObject({
			allowed: false,
			reason: "RN Devtools didn't start this stack. Adopt it first.",
		});
	});
});

describe('supabaseLogsAfterRefresh', () => {
	const line = (timestamp: string, service: string): SupabaseLogRecord => ({
		type: 'entry',
		timestamp,
		source: 'live',
		service,
		instanceId: 'container-1',
		stream: 'stdout',
		line: `${service} line`,
	});
	const payload = (...records: SupabaseLogRecord[]): SupabaseLogsPayload => ({
		records,
		truncated: false,
		bytes: records.length * 9,
		readAt: SUPABASE_DEMO_NOW,
	});
	const started = {
		status: 'ready',
		payload: payload(line('2026-10-17T14:02:11.000Z', 'rest')),
		window: 'tail',
		service: 'all',
	} as const;
	const tick = payload(line('2026-10-17T14:02:16.000Z', 'storage'));

	it('appends the tick to the read it started from', () => {
		const reads: SupabaseStackReads = { logs: started };
		expect(
			supabaseLogsAfterRefresh(reads, started, tick).logs?.payload?.records.map(
				(record) => record.service
			)
		).toEqual(['rest', 'storage']);
	});

	it('drops the tick once the operator picked another service or window', () => {
		// readLogs marks the new filter as reading before main answers.
		const switching: SupabaseStackReads = {
			logs: { ...started, status: 'reading', service: 'auth' },
		};
		expect(supabaseLogsAfterRefresh(switching, started, tick)).toBe(switching);
		const wider: SupabaseStackReads = {
			logs: { ...started, status: 'reading', window: '1h' },
		};
		expect(supabaseLogsAfterRefresh(wider, started, tick)).toBe(wider);
	});

	it('leaves a newer manual read and a failed one alone', () => {
		const fresh: SupabaseStackReads = {
			logs: {
				...started,
				service: 'auth',
				payload: payload(line('2026-10-17T14:02:15.000Z', 'auth')),
			},
		};
		expect(supabaseLogsAfterRefresh(fresh, started, tick)).toBe(fresh);
		const failed: SupabaseStackReads = {
			logs: {
				...started,
				status: 'error',
				error: supabaseDesktopError('internal', 'The read did not complete.'),
			},
		};
		expect(supabaseLogsAfterRefresh(failed, started, tick)).toBe(failed);
	});
});

import { describe, expect, it } from 'vitest';
import { supabaseBulkEligibility } from '@/simulator/supabase-model';
import {
	createSupabaseDemoState,
	SUPABASE_DEMO_IDS,
	SUPABASE_DEMO_NOW,
} from '../../../shared/supabase-demo-data';
import {
	SUPABASE_BULK_REASON_IDS,
	supabaseGettingStarted,
	supabaseSelectionSummary,
} from './supabase-stacks-view';

const ids = SUPABASE_DEMO_IDS;
const context = { bridgeAvailable: true, now: SUPABASE_DEMO_NOW };

describe('supabaseSelectionSummary', () => {
	it('describes each selected stack and what Stop N does to the eligible ones', () => {
		const state = createSupabaseDemoState();
		const selected = [
			ids.featCheckout,
			ids.featPayments,
			ids.main,
			ids.featOldUi,
		];
		const bulk = supabaseBulkEligibility(state, selected, context);
		const summary = supabaseSelectionSummary(state, selected, bulk);
		expect(summary.items).toEqual([
			{
				id: ids.featCheckout,
				title: 'feat-checkout',
				text: 'running · idle · Claude 7f3a2c91 (live) · 64 MB',
			},
			{
				id: ids.featPayments,
				title: 'feat-payments',
				text: 'running · idle · Codex · by worktree (live) · 52 MB',
			},
			{
				id: ids.main,
				title: 'main',
				text: 'running · idle · pinned · 58 MB',
			},
			{
				id: ids.featOldUi,
				title: 'feat-old-ui',
				text: 'stopped · 71 MB · requested for destroy',
			},
		]);
		expect(summary.stopEffect).toBe(
			'2 live agents lose their database. Data is kept; the pin on main clears.'
		);
		expect(summary.destroyEffect).toMatch(
			/stopped stacks without a running lane/i
		);
	});

	it('explains Stop N when nothing selected is running', () => {
		const state = createSupabaseDemoState();
		const selected = [ids.featOldUi, ids.featSearch];
		const summary = supabaseSelectionSummary(
			state,
			selected,
			supabaseBulkEligibility(state, selected, context)
		);
		expect(summary.stopEffect).toBe(
			'Stops the running stacks you select; data and ports are kept.'
		);
		expect(summary.items).toHaveLength(2);
	});

	it('skips ids that are no longer listed', () => {
		const state = createSupabaseDemoState();
		const selected = ['f'.repeat(64), ids.main];
		const summary = supabaseSelectionSummary(
			state,
			selected,
			supabaseBulkEligibility(state, selected, context)
		);
		expect(summary.items.map((item) => item.id)).toEqual([ids.main]);
		expect(summary.stopEffect).toBe(
			'Their apps lose the database until something starts them again. Data is kept; the pin on main clears.'
		);
	});
});

describe('supabaseGettingStarted', () => {
	it('lists every tracked repository with a readiness pill', () => {
		expect(supabaseGettingStarted(createSupabaseDemoState())).toEqual([
			{
				id: ids.repositoryApp,
				title: '~/code/example-app',
				detail: '9 worktrees · 7 managed · 3 running',
				pill: { label: 'Needs fix', tone: 'warning' },
			},
			{
				id: ids.repositoryAdmin,
				title: '~/code/example-admin',
				detail: 'CLI 2.122.0 not verified',
				pill: { label: 'Check', tone: 'warning' },
			},
			{
				id: ids.repositorySite,
				title: '~/code/example-site',
				detail: 'No supabase/config.toml',
				pill: { label: 'No Supabase', tone: 'default' },
			},
		]);
		expect(
			supabaseGettingStarted(createSupabaseDemoState({ variant: 'empty' }))
		).toEqual([]);
	});
});

describe('SUPABASE_BULK_REASON_IDS', () => {
	it('names one visible reason per bulk control', () => {
		expect(new Set(Object.values(SUPABASE_BULK_REASON_IDS)).size).toBe(2);
	});
});

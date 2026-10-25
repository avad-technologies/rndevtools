import { describe, expect, it } from 'vitest';
import {
	createSupabaseDemoState,
	SUPABASE_DEMO_IDS,
} from '../../../shared/supabase-demo-data';
import {
	type SupabaseStackSummary,
	supabaseInterestSchema,
} from '../../../shared/supabase-protocol';
import {
	noticeLead,
	supabaseEffectiveView,
	supabaseInterestFor,
	supabaseToggleViews,
} from './supabase-panel';

const ids = SUPABASE_DEMO_IDS;

function stack(id: string): SupabaseStackSummary {
	const found = createSupabaseDemoState().stacks.find(
		(candidate) => candidate.id === id
	);
	if (!found) throw new Error(`No demo stack ${id}`);
	return found;
}

describe('supabaseEffectiveView', () => {
	it.each([
		['requests', 'off', 'stacks'],
		['repositories', 'off', 'repositories'],
		['settings', 'off', 'settings'],
		['settings', 'loading', 'settings'],
		['repositories', 'loading', 'stacks'],
		['settings', 'unsupported', 'stacks'],
		['requests', 'bridge-missing', 'stacks'],
		['requests', 'ready', 'requests'],
		['repositories', 'empty', 'repositories'],
	] as const)('shows %s as %s while the tab is %s', (view, tab, expected) => {
		expect(supabaseEffectiveView(view, tab)).toBe(expected);
	});
});

describe('supabaseToggleViews', () => {
	it('offers Requests only while the feature is on', () => {
		expect(supabaseToggleViews('ready')).toEqual([
			'stacks',
			'repositories',
			'requests',
		]);
		expect(supabaseToggleViews('empty')).toContain('requests');
		expect(supabaseToggleViews('off')).toEqual(['stacks', 'repositories']);
		expect(supabaseToggleViews('loading')).toEqual(['stacks', 'repositories']);
	});
});

describe('supabaseInterestFor', () => {
	it('inspects the selected stack with its open sections in Stacks only', () => {
		const running = stack(ids.featCheckout);
		const interest = supabaseInterestFor('stacks', running, {
			[running.id]: { logs: true, connect: false },
		});
		expect(interest).toEqual({
			view: 'stacks',
			inspectStackId: running.id,
			sections: ['overview', 'services', 'logs'],
		});
		expect(supabaseInterestSchema.safeParse(interest).success).toBe(true);
		expect(supabaseInterestFor('repositories', running, {})).toEqual({
			view: 'repositories',
			sections: [],
		});
		expect(supabaseInterestFor('settings', undefined, {})).toEqual({
			view: 'settings',
			sections: [],
		});
	});

	it('inspects nothing for a not-created row or a batch selection', () => {
		expect(
			supabaseInterestFor('stacks', stack(ids.featOnboarding), {})
		).toEqual({ view: 'stacks', sections: [] });
		expect(supabaseInterestFor('stacks', undefined, {})).toEqual({
			view: 'stacks',
			sections: [],
		});
	});
});

describe('noticeLead', () => {
	it('splits a notice into its bold lead and the rest', () => {
		expect(
			noticeLead(
				'1 stack listens on your network. It runs on Docker; RN Devtools stopped it once.'
			)
		).toEqual({
			title: '1 stack listens on your network.',
			rest: 'It runs on Docker; RN Devtools stopped it once.',
		});
		expect(
			noticeLead('3 stacks need attention: 1 failed to start, 2 are unhealthy.')
		).toEqual({
			title: '3 stacks need attention:',
			rest: '1 failed to start, 2 are unhealthy.',
		});
	});

	it('keeps one sentence whole, versions and paths included', () => {
		expect(
			noticeLead('Codex session 3c9e7a12 asks to destroy feat-old-ui (71 MB).')
		).toEqual({
			title: 'Codex session 3c9e7a12 asks to destroy feat-old-ui (71 MB).',
			rest: '',
		});
		expect(
			noticeLead(
				'Another Supabase home is in use on this Mac (~/alt/.supabase); its stacks with CLI 2.121.0 are not listed.'
			).rest
		).toBe('');
	});
});

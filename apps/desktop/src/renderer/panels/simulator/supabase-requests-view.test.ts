import { describe, expect, it } from 'vitest';
import { buildSupabaseRequestCards } from '@/simulator/supabase-model';
import {
	createSupabaseDemoState,
	SUPABASE_DEMO_IDS,
	SUPABASE_DEMO_NOW,
} from '../../../shared/supabase-demo-data';
import {
	supabaseApproveOperation,
	supabaseEffectivePruneSelection,
} from './supabase-requests-view';

const ids = SUPABASE_DEMO_IDS;

describe('supabaseApproveOperation', () => {
	it('approves a destroy request by id; main adds the token and the uploads choice', () => {
		const [card] = buildSupabaseRequestCards(
			createSupabaseDemoState(),
			SUPABASE_DEMO_NOW,
			{ bridgeAvailable: true }
		);
		if (!card) throw new Error('The demo has a destroy request.');
		expect(supabaseApproveOperation(card, ids.featSearch)).toEqual({
			kind: 'request.approve',
			requestId: ids.requestOldUi,
		});
	});

	it('names the stack to stop for a capacity request, once chosen', () => {
		const card = {
			id: 'supabase-request-00000000-0000-4000-8000-000000000009',
			request: { kind: 'start-capacity' as const },
		};
		expect(supabaseApproveOperation(card, undefined)).toEqual({
			kind: 'request.approve',
			requestId: card.id,
		});
		expect(supabaseApproveOperation(card, ids.featSearch)).toEqual({
			kind: 'request.approve',
			requestId: card.id,
			stopStackId: ids.featSearch,
		});
	});
});

describe('supabaseEffectivePruneSelection', () => {
	const { prune } = createSupabaseDemoState();

	it('follows main’s preselection until the person changes it', () => {
		expect(supabaseEffectivePruneSelection(null, prune)).toEqual({
			selection: { revision: prune.revision, stackIds: [ids.featGone] },
			stale: false,
		});
	});

	it('keeps the person’s choice, and says when the list moved under it', () => {
		const touched = { revision: prune.revision, stackIds: [ids.featSearch] };
		expect(supabaseEffectivePruneSelection(touched, prune)).toEqual({
			selection: touched,
			stale: false,
		});
		expect(
			supabaseEffectivePruneSelection(
				{ revision: prune.revision - 1, stackIds: [ids.featSearch] },
				prune
			).stale
		).toBe(true);
	});
});

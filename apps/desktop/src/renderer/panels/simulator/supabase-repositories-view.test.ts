import { describe, expect, it } from 'vitest';
import { formatClock } from '@/lib/format';
import {
	createSupabaseDemoState,
	SUPABASE_DEMO_NOW,
} from '../../../shared/supabase-demo-data';
import { supabaseRepositorySubtitle } from './supabase-repositories-view';

describe('supabaseRepositorySubtitle', () => {
	it('names the app directory, worktrees, running stacks and the last check', () => {
		const [app, admin] = createSupabaseDemoState().repositories;
		if (!app || !admin) throw new Error('The demo has repositories.');
		expect(supabaseRepositorySubtitle(app)).toBe(
			`app apps/mobile · 9 worktrees · 3 running · checked ${formatClock(SUPABASE_DEMO_NOW - 60_000)}`
		);
		expect(
			supabaseRepositorySubtitle({
				...admin,
				checkedAt: undefined,
			})
		).toBe('1 worktree');
	});
});

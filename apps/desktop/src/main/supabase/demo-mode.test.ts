import { describe, expect, it } from 'vitest';
import { shouldUseSupabaseDemo } from './demo-mode';

describe('Supabase demo mode', () => {
	it('serves demo stacks only to an unpackaged build that asked for them', () => {
		expect(shouldUseSupabaseDemo('true', false)).toBe(true);
		expect(shouldUseSupabaseDemo(undefined, false)).toBe(false);
		expect(shouldUseSupabaseDemo('', false)).toBe(false);
		expect(shouldUseSupabaseDemo('false', false)).toBe(false);
		expect(shouldUseSupabaseDemo('1', false)).toBe(false);
		expect(shouldUseSupabaseDemo('TRUE', false)).toBe(false);
		expect(shouldUseSupabaseDemo(' true', false)).toBe(false);
	});

	it('never serves demo stacks from a packaged app', () => {
		expect(shouldUseSupabaseDemo('true', true)).toBe(false);
		expect(shouldUseSupabaseDemo(undefined, true)).toBe(false);
	});
});

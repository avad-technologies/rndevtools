import { describe, expect, it } from 'vitest';
import { formatSupabaseSize } from '../../shared/supabase-protocol';
import { boundedTextExport, formatAgo, formatSize } from './format';

describe('boundedTextExport', () => {
	it('joins entries without changing an export inside the limit', () => {
		expect(boundedTextExport(['one', 'two'], (value) => value, 100)).toEqual({
			text: 'one\n\ntwo',
			truncated: false,
		});
	});

	it('never exceeds the requested limit and marks truncation', () => {
		const result = boundedTextExport(['a'.repeat(80)], (value) => value, 64);
		expect(result.truncated).toBe(true);
		expect(result.text).toHaveLength(64);
		expect(result.text).toContain('[Export truncated');
	});
});

describe('formatAgo', () => {
	const now = Date.UTC(2026, 9, 17, 14, 3, 5);

	it('rounds down in spaced units', () => {
		expect(formatAgo(now - 2_000, now)).toBe('just now');
		expect(formatAgo(now - 45_000, now)).toBe('45 s ago');
		expect(formatAgo(now - 4 * 60_000 - 59_000, now)).toBe('4 min ago');
		expect(formatAgo(now - 3 * 3_600_000, now)).toBe('3 h ago');
		expect(formatAgo(now - 16 * 86_400_000, now)).toBe('16 days ago');
	});

	it('never reads a future time as ago, and dashes an invalid one', () => {
		expect(formatAgo(now + 60_000, now)).toBe('just now');
		expect(formatAgo(Number.NaN, now)).toBe('—');
	});
});

describe('formatSize', () => {
	const MB = 1_024 * 1_024;

	it('formats B, KB, MB and GB', () => {
		expect(formatSize(512)).toBe('512 B');
		expect(formatSize(48 * 1_024)).toBe('48 KB');
		expect(formatSize(2.1 * MB)).toBe('2.1 MB');
		expect(formatSize(71 * MB)).toBe('71 MB');
		expect(formatSize(1.7 * 1_024 * MB)).toBe('1.7 GB');
	});

	it('shows a dash when the size is unknown', () => {
		expect(formatSize(undefined)).toBe('—');
		expect(formatSize(Number.NaN)).toBe('—');
		expect(formatSize(-1)).toBe('—');
	});

	it('reads the same as the sizes main writes into its messages', () => {
		for (const bytes of [
			0,
			900,
			12_345,
			64 * MB,
			9.5 * MB,
			179 * MB,
			3.2 * 1_024 * MB,
		]) {
			expect(formatSize(bytes)).toBe(formatSupabaseSize(bytes));
		}
	});
});

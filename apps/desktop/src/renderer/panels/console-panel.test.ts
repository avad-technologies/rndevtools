import { describe, expect, it } from 'vitest';
import type { ConsoleEntry } from '../../shared/protocol';
import {
	copyFeedbackLabel,
	exportLine,
	levelTone,
	retainedBookmarks,
} from './console-panel';

function entry(overrides: Partial<ConsoleEntry> = {}): ConsoleEntry {
	return {
		id: 'log-1',
		at: Date.parse('2026-01-02T03:04:05.000Z'),
		level: 'info',
		message: 'hello world',
		...overrides,
	} as ConsoleEntry;
}

describe('levelTone', () => {
	it('maps log levels to status tones', () => {
		expect(levelTone('error')).toBe('danger');
		expect(levelTone('warn')).toBe('warning');
		expect(levelTone('info')).toBe('info');
		expect(levelTone('debug')).toBe('default');
	});
});

describe('exportLine', () => {
	it('formats a plain entry with ISO timestamp and upper level', () => {
		expect(exportLine(entry())).toBe(
			'[2026-01-02T03:04:05.000Z] INFO hello world'
		);
	});
	it('includes scope, repeat count, stack, and attributes', () => {
		const line = exportLine(
			entry({
				level: 'error',
				scope: 'auth',
				repeatCount: 3,
				errorStack: 'at foo',
				attributesText: 'userId=redacted',
			})
		);
		expect(line).toContain('ERROR [auth]');
		expect(line).toContain('(repeated 3x)');
		expect(line).toContain('\nat foo');
		expect(line).toContain('\nuserId=redacted');
	});
});

describe('copyFeedbackLabel', () => {
	it('reflects the last copy outcome', () => {
		expect(copyFeedbackLabel(null)).toBe('Copy visible');
		expect(copyFeedbackLabel({ ok: true, truncated: false })).toBe('Copied');
		expect(copyFeedbackLabel({ ok: true, truncated: true })).toBe(
			'Copied (bounded)'
		);
		expect(copyFeedbackLabel({ ok: false, truncated: false })).toBe(
			'Copy failed'
		);
	});
});

describe('retainedBookmarks', () => {
	const pushed = [
		entry({ id: 'log-1' }),
		entry({ id: 'log-2' }),
		entry({ id: 'log-3' }),
	];

	it('keeps the same set when a push drops no bookmarked entry', () => {
		// React bails out on an identical state, so the grid renders once.
		const bookmarks = new Set(['log-2']);
		expect(retainedBookmarks(bookmarks, pushed)).toBe(bookmarks);
		const none = new Set<string>();
		expect(retainedBookmarks(none, pushed)).toBe(none);
	});

	it('drops bookmarks whose entries left the bounded buffer', () => {
		const bookmarks = new Set(['log-0', 'log-3']);
		const retained = retainedBookmarks(bookmarks, pushed);
		expect(retained).not.toBe(bookmarks);
		expect([...retained]).toEqual(['log-3']);
	});
});

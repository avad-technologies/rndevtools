import { describe, expect, it } from 'vitest';
import type { QueryEntry } from '../../shared/protocol';
import { mutationTone, queryLabel, queryTone } from './query-panel';

function entry(overrides: Partial<QueryEntry>): QueryEntry {
	return {
		id: 'q1',
		hash: 'hash',
		keyText: '["key"]',
		dataText: '{}',
		status: 'success',
		fetchStatus: 'idle',
		isStale: false,
		observers: 1,
		updatedAt: 1,
		truncated: false,
		...overrides,
	} as QueryEntry;
}

describe('queryTone / queryLabel', () => {
	it('classifies errors as danger regardless of other state', () => {
		expect(queryTone(entry({ status: 'error' }))).toBe('danger');
		expect(queryLabel(entry({ status: 'error' }))).toBe('error');
	});

	it('marks in-flight fetches as info/fetching', () => {
		expect(queryTone(entry({ fetchStatus: 'fetching' }))).toBe('info');
		expect(queryLabel(entry({ fetchStatus: 'fetching' }))).toBe('fetching');
	});

	it('marks stale but idle queries as warning/stale', () => {
		expect(queryTone(entry({ isStale: true }))).toBe('warning');
		expect(queryLabel(entry({ isStale: true }))).toBe('stale');
	});

	it('treats fresh idle queries as success', () => {
		expect(queryTone(entry({}))).toBe('success');
		expect(queryLabel(entry({}))).toBe('fresh');
	});
});

describe('mutationTone', () => {
	it('maps each mutation status to its semantic tone', () => {
		expect(mutationTone('error')).toBe('danger');
		expect(mutationTone('pending')).toBe('info');
		expect(mutationTone('success')).toBe('success');
		expect(mutationTone('idle')).toBe('default');
	});
});

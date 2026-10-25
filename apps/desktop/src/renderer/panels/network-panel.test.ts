import { describe, expect, it } from 'vitest';
import type { NetworkEntry } from '../../shared/protocol';
import {
	durationBarPercent,
	durationTone,
	headersText,
	matchesNetworkTarget,
	networkSegmentCounts,
	prettyBody,
	redactedCount,
	statusLabel,
	statusTone,
} from './network-panel';

function request(overrides: Partial<NetworkEntry>): NetworkEntry {
	return {
		id: 'request-1',
		at: 1,
		method: 'GET',
		url: 'https://api.example.com/rest/v1/projects',
		host: 'api.example.com',
		path: '/rest/v1/projects',
		state: 'success',
		status: 200,
		durationMs: 120,
		...overrides,
	};
}

describe('duration bars', () => {
	it('share one 0 to 2 s scale with a visible minimum', () => {
		expect(durationBarPercent(undefined)).toBe(0);
		expect(durationBarPercent(10)).toBe(3);
		expect(durationBarPercent(1_000)).toBe(50);
		expect(durationBarPercent(9_000)).toBe(100);
	});

	it('are red for failures, amber when slow and green otherwise', () => {
		expect(durationTone(request({ durationMs: 80 }))).toBe('success');
		expect(durationTone(request({ durationMs: 1_000 }))).toBe('warning');
		expect(durationTone(request({ status: 503, durationMs: 80 }))).toBe(
			'danger'
		);
		expect(durationTone(request({ state: 'pending' }))).toBe('info');
	});
});

describe('statusLabel', () => {
	it('adds the reason phrase for common codes only', () => {
		expect(statusLabel({ state: 'success', status: 200 })).toBe('200 OK');
		expect(statusLabel({ state: 'success', status: 503 })).toBe(
			'503 Service Unavailable'
		);
		expect(statusLabel({ state: 'success', status: 299 })).toBe('299');
		expect(statusLabel({ state: 'pending' })).toBe('Pending');
		expect(statusLabel({ state: 'aborted' })).toBe('aborted');
	});
});

describe('request bodies', () => {
	it('indents JSON and leaves anything else as captured', () => {
		expect(prettyBody('{"a":1,"b":[true]}')).toBe(
			'{\n  "a": 1,\n  "b": [\n    true\n  ]\n}'
		);
		expect(prettyBody('{"cut": "off')).toBe('{"cut": "off');
		expect(prettyBody('plain text')).toBe('plain text');
	});

	it('counts the values the device redacted', () => {
		expect(redactedCount(undefined)).toBe(0);
		expect(
			redactedCount(
				'{"id":"[REDACTED_ID]","email":"[REDACTED_EMAIL]","note":"[REDACTED]"}'
			)
		).toBe(3);
	});
});

describe('networkSegmentCounts', () => {
	it('counts each view filter over every captured request', () => {
		const counts = networkSegmentCounts([
			request({ id: 'ok' }),
			request({ id: 'slow', durationMs: 1_500 }),
			request({ id: 'failed', status: 500 }),
		]);
		expect(counts.all).toBe(3);
		expect(counts.slow).toBe(1);
		expect(counts.errors).toBe(1);
	});
});

describe('statusTone', () => {
	it('treats pending as info', () => {
		expect(statusTone({ state: 'pending' })).toBe('info');
	});
	it('treats error, aborted, and 4xx+ as danger', () => {
		expect(statusTone({ state: 'error' })).toBe('danger');
		expect(statusTone({ state: 'aborted' })).toBe('danger');
		expect(statusTone({ state: 'success', status: 404 })).toBe('danger');
		expect(statusTone({ state: 'success', status: 500 })).toBe('danger');
	});
	it('treats 3xx as warning and 2xx as success', () => {
		expect(statusTone({ state: 'success', status: 301 })).toBe('warning');
		expect(statusTone({ state: 'success', status: 200 })).toBe('success');
	});
});

describe('headersText', () => {
	it('reports an explicit empty message', () => {
		expect(headersText(undefined)).toBe('No captured headers.');
		expect(headersText({})).toBe('No captured headers.');
	});
	it('sorts headers alphabetically and joins as key: value lines', () => {
		expect(
			headersText({ 'X-Trace': '1', 'Content-Type': 'application/json' })
		).toBe('Content-Type: application/json\nX-Trace: 1');
	});
});

describe('matchesNetworkTarget', () => {
	const stack = 'a'.repeat(64);
	const filter = { key: `stack:${stack}`, label: 'origin 127.0.0.1:24410' };

	it('keeps every request without a backend filter', () => {
		expect(matchesNetworkTarget(undefined, null)).toBe(true);
	});

	it('keeps only requests to the filtered backend', () => {
		expect(
			matchesNetworkTarget(
				{ kind: 'other-stack', stackId: stack, port: 24_410 },
				filter
			)
		).toBe(true);
		expect(
			matchesNetworkTarget(
				{
					kind: 'hosted',
					host: 'abcd1234.supabase.co',
					projectRef: 'abcd1234',
				},
				filter
			)
		).toBe(false);
		expect(matchesNetworkTarget(undefined, filter)).toBe(false);
	});
});

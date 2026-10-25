import { describe, expect, it } from 'vitest';
import { supabaseTrafficSignature } from './supabase-protocol';
import {
	appTrafficLabel,
	classifyAppTraffic,
	explainAppTraffic,
	SUPABASE_TRAFFIC_DOMINANCE,
	type SupabaseTrafficEntry,
	supabaseTrafficTarget,
	supabaseTrafficTone,
} from './supabase-traffic';

const lane = 'a'.repeat(64);
const other = 'b'.repeat(64);
const signature = supabaseTrafficSignature([
	{ port: 21_734, stackId: lane },
	{ port: 24_410, stackId: other },
]);
const at = 1_792_245_785_000;

function entry(url: string, offset = 0): SupabaseTrafficEntry {
	const parsed = new URL(url);
	return {
		at: at + offset,
		url,
		host: parsed.host,
		path: `${parsed.pathname}${parsed.search}`,
	};
}

function times(count: number, url: string): SupabaseTrafficEntry[] {
	return Array.from({ length: count }, (_, index) => entry(url, index));
}

describe('supabaseTrafficTarget', () => {
	it.each([
		[
			'http://127.0.0.1:21734/rest/v1/notes',
			{ kind: 'this-stack', stackId: lane, port: 21_734 },
		],
		[
			'http://localhost:24410/auth/v1/token?grant_type=[REDACTED]',
			{ kind: 'other-stack', stackId: other, port: 24_410 },
		],
		[
			'http://[::1]:21734/anything',
			{ kind: 'this-stack', stackId: lane, port: 21_734 },
		],
		['http://127.0.0.1:54321/rest/v1/notes', { kind: 'legacy', port: 54_321 }],
		[
			'http://127.0.0.1:9999/storage/v1/object/a.png',
			{ kind: 'unknown-local', port: 9_999 },
		],
		[
			'https://abcd1234.supabase.co/storage/v1/object/public/a.png',
			{ kind: 'hosted', host: 'abcd1234.supabase.co', projectRef: 'abcd1234' },
		],
		[
			'https://api.example.com/rest/v1/orders',
			{ kind: 'remote', host: 'api.example.com' },
		],
		['https://api.example.com/v1/catalog?page=2', undefined],
		['http://127.0.0.1:8102/index.bundle', undefined],
		['http://127.0.0.1:9999/rest/v10/x', undefined],
	])('classifies %s', (url, target) => {
		expect(supabaseTrafficTarget(entry(url), signature, lane)).toEqual(target);
	});

	it('falls back to host and path when the URL does not parse', () => {
		expect(
			supabaseTrafficTarget(
				{
					at,
					url: 'not a url',
					host: '127.0.0.1:24410',
					path: '/rest/v1/x?y=1',
				},
				signature,
				lane
			)
		).toEqual({ kind: 'other-stack', stackId: other, port: 24_410 });
		expect(
			supabaseTrafficTarget({ at, url: '', host: '', path: '' }, signature)
		).toBeUndefined();
	});
});

describe('classifyAppTraffic (status model F)', () => {
	it.each([
		[
			'uses-this-stack',
			times(48, 'http://127.0.0.1:21734/rest/v1/notes'),
			'success',
			'uses this stack',
		],
		[
			'other-stack',
			[
				...times(12, 'http://127.0.0.1:24410/rest/v1/orders'),
				...times(2, 'http://127.0.0.1:21734/rest/v1/notes'),
			],
			'warning',
			'other stack · feat-payments (:24410)',
		],
		[
			'hosted',
			times(3, 'https://abcd1234.supabase.co/rest/v1/x'),
			'warning',
			'hosted abcd1234',
		],
		[
			'remote',
			times(3, 'https://db.example.com/rest/v1/x'),
			'warning',
			'remote',
		],
		[
			'unknown-local',
			times(3, 'http://127.0.0.1:9999/rest/v1/x'),
			'warning',
			'unknown local',
		],
		[
			'legacy-54321',
			times(5, 'http://127.0.0.1:54321/rest/v1/x'),
			'danger',
			'legacy :54321',
		],
		[
			'mixed',
			[
				...times(5, 'http://127.0.0.1:21734/rest/v1/x'),
				...times(5, 'https://abcd1234.supabase.co/rest/v1/x'),
			],
			'warning',
			'mixed',
		],
		[
			'no-traffic',
			times(4, 'https://api.example.com/v1/catalog'),
			'default',
			'no app traffic seen',
		],
	] as const)('reads %s', (verdict, entries, tone, label) => {
		const result = classifyAppTraffic(entries, signature, {
			expectedStackId: lane,
			linked: true,
		});
		expect(result.verdict).toBe(verdict);
		expect(result.tone).toBe(tone);
		expect(supabaseTrafficTone(verdict)).toBe(tone);
		expect(
			appTrafficLabel(result, {
				stackLabel: (id) => (id === other ? 'feat-payments' : undefined),
			})
		).toBe(label);
	});

	it('never calls an unlinked app OK, and counts nothing for it', () => {
		const result = classifyAppTraffic(
			times(10, 'http://127.0.0.1:21734/rest/v1/notes'),
			signature,
			{ expectedStackId: lane, linked: false }
		);
		expect(result).toMatchObject({
			verdict: 'not-linked',
			tone: 'default',
			matching: 0,
		});
		expect(result.dominant).toBeUndefined();
		expect(appTrafficLabel(result)).toBe('app not linked');
	});

	it('counts only recent requests and reports shares', () => {
		const result = classifyAppTraffic(
			[
				...times(3, 'http://127.0.0.1:24410/rest/v1/orders').map((value) => ({
					...value,
					at: at - 60_000,
				})),
				...times(4, 'http://127.0.0.1:21734/rest/v1/notes'),
			],
			signature,
			{ expectedStackId: lane, linked: true, since: at - 1_000 }
		);
		expect(result).toMatchObject({
			verdict: 'uses-this-stack',
			total: 4,
			matching: 4,
			lastAt: at + 3,
		});
		expect(result.targets).toHaveLength(1);
	});

	it('treats every local stack as another stack when the lane has none', () => {
		const result = classifyAppTraffic(
			times(2, 'http://127.0.0.1:21734/rest/v1/notes'),
			signature,
			{ linked: true }
		);
		expect(result.verdict).toBe('other-stack');
	});

	it('needs a 75% share to call a verdict', () => {
		expect(SUPABASE_TRAFFIC_DOMINANCE).toBe(0.75);
		const threeQuarters = classifyAppTraffic(
			[
				...times(3, 'http://127.0.0.1:21734/rest/v1/x'),
				...times(1, 'http://127.0.0.1:24410/rest/v1/x'),
			],
			signature,
			{ expectedStackId: lane, linked: true }
		);
		expect(threeQuarters.verdict).toBe('uses-this-stack');
		expect(threeQuarters.targets.map((target) => target.count)).toEqual([3, 1]);
	});
});

describe('explainAppTraffic', () => {
	const labels = {
		stackLabel: (id: string) => (id === other ? 'feat-payments' : undefined),
		expectedPort: 21_734,
	};

	it('writes the connected-banner sentence', () => {
		const result = classifyAppTraffic(
			[
				...times(12, 'http://127.0.0.1:24410/rest/v1/orders'),
				...times(2, 'http://127.0.0.1:21734/rest/v1/notes'),
			],
			signature,
			{ expectedStackId: lane, linked: true }
		);
		expect(explainAppTraffic(result, labels)).toBe(
			"Talks to the stack for feat-payments (:24410), not its lane's stack (:21734): 12 of 14 requests."
		);
	});

	it.each([
		[
			times(2, 'http://127.0.0.1:21734/rest/v1/x'),
			'Uses this stack: 2 of 2 requests.',
		],
		[
			times(2, 'https://abcd1234.supabase.co/rest/v1/x'),
			"Talks to the hosted project abcd1234, not its lane's stack (:21734): 2 of 2 requests.",
		],
		[
			times(1, 'http://127.0.0.1:54321/rest/v1/x'),
			"Talks to :54321, the Docker-era default port, not its lane's stack (:21734): 1 of 1 requests. A Docker stack there listens on your network.",
		],
		[[], 'No app traffic seen yet. This is not proof the app uses this stack.'],
	])('explains %#', (entries, sentence) => {
		const result = classifyAppTraffic(entries, signature, {
			expectedStackId: lane,
			linked: true,
		});
		expect(explainAppTraffic(result, labels)).toBe(sentence);
	});
});

import { describe, expect, it } from 'vitest';
import { sessionsWithDevices } from './agents-view';

const A = 'AAAAAAAA-0000-4000-8000-000000000001';
const B = 'BBBBBBBB-0000-4000-8000-000000000002';

describe('sessionsWithDevices', () => {
	it('groups attachments by session, keeps idle sessions, and sorts busy ones first', () => {
		const rows = sessionsWithDevices({
			sessions: [
				{ kind: 'claude', sessionId: 'idle', title: 'idle one', updatedAt: 9 },
				{ kind: 'claude', sessionId: 'busy', title: 'busy one', updatedAt: 1 },
			],
			byDevice: {
				[A]: [
					{
						kind: 'claude',
						sessionId: 'busy',
						title: 'busy one',
						via: 'claim',
						lastSeenAt: 5,
						live: true,
					},
				],
				[B]: [
					{
						kind: 'claude',
						sessionId: 'busy',
						title: 'busy one',
						via: 'touch',
						lastSeenAt: 6,
						live: true,
					},
					// A session that is no longer live still shows what it left behind.
					{
						kind: 'codex',
						sessionId: 'gone',
						title: 'codex gone',
						via: 'claim',
						lastSeenAt: 2,
						live: false,
					},
				],
			},
		});
		expect(
			rows.map((row) => [row.session.sessionId, row.devices.length])
		).toEqual([
			['busy', 2],
			['gone', 1],
			['idle', 0],
		]);
		expect(
			rows[0]?.devices.map((entry) => [entry.udid, entry.attachment.via])
		).toEqual([
			[A, 'claim'],
			[B, 'touch'],
		]);
	});
});

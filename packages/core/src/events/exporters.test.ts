import { utf8ByteLength } from '../core/serialize';
import { exportDevtoolsEvents } from './exporters';
import {
	DEVTOOLS_EVENT_VERSION,
	type DevtoolsEvent,
	type DevtoolsEventLevel,
} from './types';

function event(
	sequence: number,
	level: DevtoolsEventLevel = 'info',
	overrides: Partial<DevtoolsEvent> = {},
): DevtoolsEvent {
	return {
		version: DEVTOOLS_EVENT_VERSION,
		id: `event-${sequence}`,
		at: 1_700_000_000_000 + sequence,
		sequence,
		source: 'network',
		kind: 'request.completed',
		level,
		title: `Request ${sequence}`,
		correlationId: 'correlation-1',
		redacted: false,
		truncated: false,
		...overrides,
	};
}

describe('event text exporters', () => {
	it.each(['markdown', 'bug-report'] as const)(
		'exports bounded, re-redacted complete %s rows',
		(format) => {
			const result = exportDevtoolsEvents(
				[
					event(1, 'info', {
						title: 'Request | Bearer should-not-export',
					}),
					event(2, 'warn'),
				],
				{ format, maxBytes: 16 * 1024 },
			);
			expect(result.text).toContain('RN Devtools');
			expect(result.text).toContain('Request \\| Bearer [REDACTED]');
			expect(result.text).not.toContain('should-not-export');
			expect(result.eventCount).toBe(2);
			expect(result.estimatedBytes).toBe(utf8ByteLength(result.text));
		},
	);

	it('exports only errors and accounts for filtered events', () => {
		const result = exportDevtoolsEvents(
			[event(1), event(2, 'error'), event(3, 'warn')],
			{ format: 'errors-only', maxBytes: 16 * 1024 },
		);
		expect(result.text).toContain('Request 2');
		expect(result.text).not.toContain('Request 1');
		expect(result.eventCount).toBe(1);
		expect(result.omittedEvents).toBe(2);
		expect(result.truncated).toBe(true);
	});

	it('produces a safe Mermaid sequence without directive injection', () => {
		const result = exportDevtoolsEvents(
			[
				event(1, 'error', {
					source: 'network; participant Attacker',
					title: 'failed;\nparticipant Secret',
				}),
			],
			{ format: 'mermaid', maxBytes: 16 * 1024 },
		);
		expect(result.text).toContain('sequenceDiagram');
		expect(result.text).toContain('source_network__participant_Attacker');
		expect(result.text).not.toContain('\nparticipant Secret');
		expect(result.eventCount).toBe(1);
	});

	it('keeps the newest complete text rows inside the exact byte bound', () => {
		const all = exportDevtoolsEvents([event(1), event(2), event(3)], {
			format: 'markdown',
			maxBytes: 16 * 1024,
		});
		const withoutFirst = exportDevtoolsEvents([event(2), event(3)], {
			format: 'markdown',
			maxBytes: 16 * 1024,
		});
		const bounded = exportDevtoolsEvents([event(1), event(2), event(3)], {
			format: 'markdown',
			maxBytes: withoutFirst.estimatedBytes,
		});
		expect(bounded.text).not.toContain('Request 1');
		expect(bounded.text).toContain('Request 2');
		expect(bounded.text).toContain('Request 3');
		expect(bounded.estimatedBytes).toBeLessThan(all.estimatedBytes);
		expect(bounded.estimatedBytes).toBeLessThanOrEqual(
			withoutFirst.estimatedBytes,
		);
	});
});

import { DEVTOOLS_EVENT_VERSION, type DevtoolsEvent } from '../events/types';
import {
	correlateDevToolsEvent,
	createDevToolsCorrelationScope,
	inferDevToolsCorrelationScope,
} from './correlation';

function event(
	id: string,
	at: number,
	sequence: number,
	overrides: Partial<DevtoolsEvent> = {},
): DevtoolsEvent {
	return {
		version: DEVTOOLS_EVENT_VERSION,
		id,
		at,
		sequence,
		source: 'network',
		kind: 'request',
		level: 'info',
		title: id,
		correlationId: 'request-1',
		redacted: false,
		truncated: false,
		...overrides,
	};
}

describe('correlation scopes', () => {
	it('creates explicit scopes and carries them into event envelopes', () => {
		const scope = createDevToolsCorrelationScope({
			id: 'scenario-42',
			startedAt: 100,
			parentEventId: 'action-1',
		});
		expect(
			correlateDevToolsEvent(
				{ source: 'routes', kind: 'committed', title: 'Opened item' },
				scope,
			),
		).toMatchObject({
			correlationId: 'scenario-42',
			parentEventId: 'action-1',
			attributes: { 'correlation.relation': 'explicit' },
		});
	});

	it('chooses the latest deterministic candidate inside the inference window', () => {
		const inferred = inferDevToolsCorrelationScope(
			[
				event('first', 100, 1, { correlationId: 'first-correlation' }),
				event('second', 150, 2, { correlationId: 'second-correlation' }),
				event('tie-winner', 150, 3, { correlationId: 'winner-correlation' }),
			],
			{ at: 200, windowMs: 100 },
		);
		expect(inferred).toEqual({
			id: 'winner-correlation',
			relation: 'inferred',
			startedAt: 200,
			parentEventId: 'tie-winner',
			evidenceEventId: 'tie-winner',
		});
	});

	it('returns no inference outside the window or source filter', () => {
		const events = [event('request', 100, 1)];
		expect(
			inferDevToolsCorrelationScope(events, { at: 201, windowMs: 100 }),
		).toBeNull();
		expect(
			inferDevToolsCorrelationScope(events, {
				at: 150,
				windowMs: 100,
				source: 'routes',
			}),
		).toBeNull();
	});

	it('labels inferred event correlation and preserves evidence', () => {
		const scope = inferDevToolsCorrelationScope([event('request', 100, 1)], {
			at: 125,
			windowMs: 100,
		});
		if (!scope) throw new Error('expected inferred scope');
		expect(
			correlateDevToolsEvent(
				{ source: 'query', kind: 'updated', title: 'Todos updated' },
				scope,
			),
		).toMatchObject({
			attributes: {
				'correlation.relation': 'inferred',
				'correlation.evidenceEventId': 'request',
			},
		});
	});

	it('rejects invalid explicit IDs and unbounded inference windows', () => {
		expect(() =>
			createDevToolsCorrelationScope({ id: 'bad id', startedAt: 0 }),
		).toThrow('Invalid');
		expect(() =>
			inferDevToolsCorrelationScope([], { at: 0, windowMs: 60_001 }),
		).toThrow('Invalid');
	});
});

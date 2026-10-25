import { describe, expect, it } from 'vitest';
import { brokerTone, levelTone, trafficHealthTone } from './diagnostics-panel';

describe('levelTone', () => {
	it('maps diagnostic levels to status tones', () => {
		expect(levelTone('error')).toBe('danger');
		expect(levelTone('warn')).toBe('warning');
		expect(levelTone('info')).toBe('info');
		expect(levelTone('debug')).toBe('default');
	});
});

describe('brokerTone', () => {
	it('uses brand green for a healthy listener, never blue', () => {
		expect(brokerTone('listening')).toBe('brand');
	});
	it('uses danger for an errored broker', () => {
		expect(brokerTone('error')).toBe('danger');
	});
	it('uses warning for starting or unknown states', () => {
		expect(brokerTone(undefined)).toBe('warning');
		expect(brokerTone('starting')).toBe('warning');
	});
});

describe('trafficHealthTone', () => {
	it('is green only when the app uses its lane stack', () => {
		expect(trafficHealthTone('success')).toBe('brand');
		expect(trafficHealthTone('warning')).toBe('warning');
		expect(trafficHealthTone('danger')).toBe('danger');
		expect(trafficHealthTone('default')).toBe('default');
	});
});

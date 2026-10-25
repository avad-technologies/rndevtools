import { describe, expect, it } from 'vitest';
import type { EnvironmentEntry } from '../../shared/protocol';
import {
	createSupabaseDemoState,
	SUPABASE_DEMO_IDS,
} from '../../shared/supabase-demo-data';
import {
	environmentHealth,
	laneStackPhrase,
	statusLabel,
	validationTone,
} from './environment-panel';

function entry(status: EnvironmentEntry['status']): EnvironmentEntry {
	return {
		id: `e-${status}`,
		section: 'Application',
		key: 'KEY',
		valueText: 'v',
		status,
	};
}

describe('validationTone', () => {
	it('maps statuses to tones', () => {
		expect(validationTone('valid')).toBe('success');
		expect(validationTone('unchecked')).toBe('default');
		expect(validationTone('missing')).toBe('warning');
		expect(validationTone('typeMismatch')).toBe('danger');
		expect(validationTone('valueMismatch')).toBe('danger');
	});
});

describe('statusLabel', () => {
	it('shortens mismatch labels', () => {
		expect(statusLabel('typeMismatch')).toBe('type');
		expect(statusLabel('valueMismatch')).toBe('value');
		expect(statusLabel('valid')).toBe('valid');
	});
});

describe('environmentHealth', () => {
	it('reports not-evaluated when nothing is checked', () => {
		expect(environmentHealth([entry('unchecked')])).toEqual({
			hasChecks: false,
			valid: 0,
			failures: 0,
			score: 0,
		});
	});

	it('scores valid entries and ignores unchecked ones', () => {
		const health = environmentHealth([
			entry('valid'),
			entry('valid'),
			entry('missing'),
			entry('unchecked'),
		]);
		expect(health.hasChecks).toBe(true);
		expect(health.valid).toBe(2);
		expect(health.failures).toBe(1);
		expect(health.score).toBe(67);
	});

	it('reports full health when all checked entries are valid', () => {
		expect(environmentHealth([entry('valid')]).score).toBe(100);
	});
});

describe('laneStackPhrase', () => {
	const stack = createSupabaseDemoState().stacks.find(
		(candidate) => candidate.id === SUPABASE_DEMO_IDS.featCheckout
	);

	it('names the lane stack the declared URL is compared with', () => {
		expect(
			laneStackPhrase({
				...(stack ? { expectedStack: stack } : {}),
				labels: { expectedPort: 21_734 },
			})
		).toBe('the stack for feat-checkout (:21734)');
		expect(laneStackPhrase({ labels: {} })).toBe("this lane's stack");
	});
});

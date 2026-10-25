import { describe, expect, it } from 'vitest';
import { validateScenarioImport } from './scenarios-panel';

describe('validateScenarioImport', () => {
	it('rejects empty and whitespace input', () => {
		expect(validateScenarioImport('')).toEqual({
			ok: false,
			error: 'Paste a scenario document.',
		});
		expect(validateScenarioImport('   \n ').ok).toBe(false);
	});

	it('rejects invalid JSON', () => {
		expect(validateScenarioImport('{ not json')).toEqual({
			ok: false,
			error: 'Document is not valid JSON.',
		});
	});

	it('rejects non-object top levels', () => {
		expect(validateScenarioImport('[]').error).toBe(
			'Top level must be a JSON object.'
		);
		expect(validateScenarioImport('42').error).toBe(
			'Top level must be a JSON object.'
		);
	});

	it('requires a non-empty scenarios array', () => {
		expect(validateScenarioImport('{}').error).toBe(
			'Missing a "scenarios" array.'
		);
		expect(validateScenarioImport('{"scenarios":[]}').error).toBe(
			'Add at least one scenario to import.'
		);
	});

	it('accepts a document with at least one scenario', () => {
		expect(validateScenarioImport('{"scenarios":[{"id":"x"}]}')).toEqual({
			ok: true,
		});
	});
});

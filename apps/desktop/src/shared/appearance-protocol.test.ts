import { describe, expect, it } from 'vitest';
import { appearancePreferenceSchema } from './appearance-protocol';

describe('appearance protocol', () => {
	it('accepts only the three named preferences', () => {
		for (const preference of ['system', 'light', 'dark']) {
			expect(appearancePreferenceSchema.parse(preference)).toBe(preference);
		}
		for (const value of ['Dark', 'auto', '', null, undefined, 1]) {
			expect(() => appearancePreferenceSchema.parse(value)).toThrow();
		}
	});
});

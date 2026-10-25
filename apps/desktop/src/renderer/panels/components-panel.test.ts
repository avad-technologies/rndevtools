import { describe, expect, it } from 'vitest';
import { canMutateSemanticTarget } from './components-panel';

describe('canMutateSemanticTarget', () => {
	it('requires a focused target and a current screen hash', () => {
		expect(canMutateSemanticTarget({ isFocused: true }, 'screen-current')).toBe(
			true
		);
		expect(
			canMutateSemanticTarget({ isFocused: false }, 'screen-current')
		).toBe(false);
		expect(canMutateSemanticTarget({ isFocused: true }, undefined)).toBe(false);
		expect(canMutateSemanticTarget(null, 'screen-current')).toBe(false);
	});
});

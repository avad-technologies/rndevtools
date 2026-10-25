import { describe, expect, it } from 'vitest';
import type { RecipeDefinition, RecipeStep } from '../shared/recipe-protocol';
import { recipeRequiresRunApproval } from './recipe-policy';

function recipe(step: RecipeStep): RecipeDefinition {
	return {
		formatVersion: 1,
		id: 'policy-test',
		name: 'Policy test',
		revision: 1,
		createdAt: 1,
		updatedAt: 1,
		defaultConcurrency: 1,
		steps: [step],
		teardown: [],
	};
}

describe('recipe approval policy', () => {
	it('requires approval for restore-point restore and removal but not capture', () => {
		expect(
			recipeRequiresRunApproval(
				recipe({
					id: 'capture',
					kind: 'restore-point',
					operation: 'capture',
					saveAs: 'before',
				})
			)
		).toBe(false);
		for (const operation of ['restore', 'remove'] as const) {
			expect(
				recipeRequiresRunApproval(
					recipe({
						id: operation,
						kind: 'restore-point',
						operation,
						reference: 'before',
					})
				)
			).toBe(true);
		}
	});
});

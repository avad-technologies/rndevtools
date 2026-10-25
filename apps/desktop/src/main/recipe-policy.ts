import type { RecipeDefinition } from '../shared/recipe-protocol';

/** How many steps of each privileged kind a recipe has, teardown included. */
export type RecipeApprovalCounts = {
	mutations: number;
	sensitiveResets: number;
	restorePointChanges: number;
};

export function recipeApprovalCounts(
	recipe: RecipeDefinition
): RecipeApprovalCounts {
	const steps = [...recipe.steps, ...recipe.teardown];
	return {
		mutations: steps.filter((step) => step.kind === 'slimming.mutation').length,
		sensitiveResets: steps.filter(
			(step) =>
				step.kind === 'simulator' &&
				(step.action.operation === 'keychain.reset' ||
					(step.action.operation === 'privacy.update' &&
						step.action.privacyOperation === 'reset'))
		).length,
		restorePointChanges: steps.filter(
			(step) =>
				step.kind === 'restore-point' &&
				(step.operation === 'restore' || step.operation === 'remove')
		).length,
	};
}

export function recipeRequiresRunApproval(recipe: RecipeDefinition): boolean {
	return Object.values(recipeApprovalCounts(recipe)).some((count) => count > 0);
}

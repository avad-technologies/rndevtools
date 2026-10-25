import { describe, expect, it } from 'vitest';
import type { RecipeSummary } from '../../shared/recipe-protocol';
import {
	analyzeRecipeApprovals,
	createRecipeDefinition,
	createRecipeStep,
	createSimulatorAction,
	duplicateRecipeDefinition,
	issuesForPath,
	prepareRecipeForSave,
	RECIPE_STEP_PALETTE,
	recipeStepTitle,
	stripRecipeAcknowledgements,
	validateRecipeDefinition,
} from './recipe-model';

describe('recipe editor model', () => {
	it('creates a schema-valid recipe with a bounded default', () => {
		const recipe = createRecipeDefinition({ id: 'smoke', now: 100 });
		expect(validateRecipeDefinition(recipe)).toEqual([]);
		expect(recipe.defaultConcurrency).toBe(2);
		expect(recipe.steps).toHaveLength(1);
	});

	it('creates one valid default for every supported step kind', () => {
		const recipe = createRecipeDefinition({ id: 'all-steps', now: 100 });
		recipe.steps = RECIPE_STEP_PALETTE.map(({ kind }, index) =>
			createRecipeStep(kind, `step-${index + 1}`)
		);
		expect(validateRecipeDefinition(recipe)).toEqual([]);
		expect(
			recipe.steps.find((step) => step.kind === 'slimming.mutation')
		).not.toHaveProperty('acknowledgement');
	});

	it('creates schema-valid defaults for every Simulator operation', () => {
		const operations = [
			'device.boot',
			'device.shutdown',
			'app.launch',
			'app.terminate',
			'pasteboard.sync',
			'url.open',
			'location.set',
			'location.clear',
			'location.start',
			'push.send',
			'privacy.update',
			'ui.appearance',
			'ui.update',
			'statusBar.clear',
			'statusBar.override',
			'keychain.reset',
		] as const;
		const recipe = createRecipeDefinition({
			id: 'simulator-actions',
			now: 100,
		});
		recipe.steps = operations.map((operation, index) => ({
			id: `simulator-${index + 1}`,
			kind: 'simulator' as const,
			action: createSimulatorAction(operation),
		}));
		expect(validateRecipeDefinition(recipe)).toEqual([]);
	});

	it('maps nested schema failures to an inline editor path', () => {
		const recipe = createRecipeDefinition({ id: 'invalid', now: 100 });
		recipe.steps = [];
		const issues = validateRecipeDefinition(recipe);
		expect(issuesForPath(issues, 'steps')).toEqual([
			expect.objectContaining({ path: 'steps', message: expect.any(String) }),
		]);
	});

	it('increments a persisted revision and preserves creation time', () => {
		const recipe = createRecipeDefinition({ id: 'versioned', now: 100 });
		const persisted = summaryFor(recipe);
		const result = prepareRecipeForSave(recipe, { now: 250, persisted });
		expect(result).toEqual({
			ok: true,
			recipe: expect.objectContaining({
				revision: 2,
				createdAt: 100,
				updatedAt: 250,
			}),
		});
	});

	it('refuses to overwrite a newer stored revision', () => {
		const recipe = createRecipeDefinition({ id: 'stale', now: 100 });
		const result = prepareRecipeForSave(recipe, {
			now: 250,
			persisted: { ...summaryFor(recipe), revision: 3 },
		});
		expect(result).toEqual({
			ok: false,
			error: expect.stringContaining('Revision 3 is stored'),
		});
	});

	it('keeps a first save at revision one', () => {
		const recipe = createRecipeDefinition({ id: 'new-recipe', now: 100 });
		const result = prepareRecipeForSave(recipe, { now: 125 });
		expect(result).toEqual({
			ok: true,
			recipe: expect.objectContaining({ revision: 1, updatedAt: 125 }),
		});
	});

	it('duplicates content into a fresh version lineage', () => {
		const source = createRecipeDefinition({ id: 'source', now: 100 });
		source.revision = 9;
		source.steps = [
			{
				id: 'legacy-slimming',
				kind: 'slimming.mutation',
				operation: 'undo',
				acknowledgement: 'EXPERIMENTAL',
			},
		];
		const copy = duplicateRecipeDefinition(source, { id: 'copy', now: 500 });
		expect(copy).toMatchObject({
			id: 'copy',
			name: 'Untitled recipe copy',
			revision: 1,
			createdAt: 500,
			updatedAt: 500,
		});
		expect(copy.steps).not.toBe(source.steps);
		expect(copy.steps[0]).not.toHaveProperty('acknowledgement');
	});

	it('strips legacy experimental acknowledgements before save or edit', () => {
		const source = createRecipeDefinition({ id: 'legacy', now: 100 });
		source.steps = [
			{
				id: 'apply',
				kind: 'slimming.mutation',
				operation: 'apply',
				profileId: 'balanced',
				acknowledgement: 'EXPERIMENTAL',
			},
		];
		const stripped = stripRecipeAcknowledgements(source);
		expect(stripped.removed).toBe(true);
		expect(stripped.recipe.steps[0]).not.toHaveProperty('acknowledgement');
		expect(source.steps[0]).toHaveProperty('acknowledgement', 'EXPERIMENTAL');

		const prepared = prepareRecipeForSave(source, { now: 200 });
		expect(prepared.ok).toBe(true);
		if (prepared.ok) {
			expect(prepared.recipe.steps[0]).not.toHaveProperty('acknowledgement');
		}
	});

	it('previews destructive, privacy-sensitive, and slimming mutations', () => {
		const recipe = createRecipeDefinition({ id: 'approval', now: 100 });
		recipe.steps = [
			{
				id: 'shutdown',
				kind: 'simulator',
				action: { operation: 'device.shutdown' },
			},
			{
				id: 'location',
				kind: 'simulator',
				action: { operation: 'location.set', latitude: 1, longitude: 2 },
			},
			{
				id: 'slim',
				kind: 'slimming.mutation',
				operation: 'undo',
			},
		];
		const approval = analyzeRecipeApprovals(recipe);
		expect(approval).toMatchObject({
			destructiveCount: 1,
			privacyCount: 1,
			slimmingCount: 1,
		});
		expect(approval.findings.map((item) => item.stepId)).toEqual([
			'shutdown',
			'location',
			'slim',
		]);
	});

	it('surfaces native approval for privacy and keychain resets', () => {
		const recipe = createRecipeDefinition({ id: 'reset-approval', now: 100 });
		recipe.steps = [
			{
				id: 'privacy-reset',
				kind: 'simulator',
				action: {
					operation: 'privacy.update',
					privacyOperation: 'reset',
					service: 'all',
					bundleIdentifier: 'com.example.app',
				},
			},
			{
				id: 'keychain-reset',
				kind: 'simulator',
				action: { operation: 'keychain.reset' },
			},
		];
		const approval = analyzeRecipeApprovals(recipe);
		expect(approval).toMatchObject({ destructiveCount: 2, privacyCount: 1 });
		expect(approval.findings.map((finding) => finding.label)).toEqual([
			'reset all',
			'privacy reset',
			'keychain.reset',
		]);
	});

	it('uses explicit step labels before generated operation titles', () => {
		const step = createRecipeStep('capture', 'capture');
		expect(recipeStepTitle(step)).toBe('capture.png');
		step.label = 'Golden image';
		expect(recipeStepTitle(step)).toBe('Golden image');
	});
});

function summaryFor(
	recipe: ReturnType<typeof createRecipeDefinition>
): RecipeSummary {
	return {
		id: recipe.id,
		name: recipe.name,
		description: recipe.description,
		revision: recipe.revision,
		updatedAt: recipe.updatedAt,
		stepCount: recipe.steps.length,
		teardownStepCount: recipe.teardown.length,
		requiresMutationApproval: false,
	};
}

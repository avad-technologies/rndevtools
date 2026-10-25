import { describe, expect, it, vi } from 'vitest';
import type {
	RecipeBridge,
	RecipeRun,
	RecipeRunRequest,
} from '../../shared/recipe-protocol';
import {
	confirmAndRunRecipe,
	pendingRecipeApprovalRequest,
} from './recipe-runtime';

const REQUEST: RecipeRunRequest = {
	actionId: 'recipe-action',
	recipeId: 'smoke',
	targetUdids: ['AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE'],
	concurrency: 2,
};

describe('recipe confirmation runtime', () => {
	it('reuses the exact pending action, recipe, targets, and concurrency', () => {
		const run = pendingRun();
		expect(pendingRecipeApprovalRequest(run)).toEqual(REQUEST);
		expect(
			pendingRecipeApprovalRequest({ ...run, status: 'running' })
		).toBeNull();
		expect(
			pendingRecipeApprovalRequest({
				...run,
				pendingRequest: {
					actionId: run.actionId,
					recipeId: run.recipeId,
					targetUdids: [...run.targetUdids],
					concurrency: 3,
				},
			})
		).toBeNull();
	});

	it('passes the exact native token only when approval is required', async () => {
		const token = `confirmation-${'a'.repeat(64)}`;
		const requestRecipeRunConfirmation = vi.fn(async () => ({
			actionId: REQUEST.actionId,
			required: true,
			confirmed: true,
			token,
			expiresAt: 1_000,
		}));
		const runRecipe = vi.fn(async () => ({
			actionId: REQUEST.actionId,
			accepted: true,
			runId: 'recipe-run-12345678-1234-4123-8123-123456789abc',
		}));
		const receipt = await confirmAndRunRecipe(
			{ requestRecipeRunConfirmation, runRecipe },
			REQUEST
		);
		expect(receipt.accepted).toBe(true);
		expect(runRecipe).toHaveBeenCalledWith({
			...REQUEST,
			confirmationToken: token,
		});
	});

	it('runs an approval-free recipe without injecting a token', async () => {
		const bridge = bridgeFor({ required: false, confirmed: true });
		await confirmAndRunRecipe(bridge, REQUEST);
		expect(bridge.runRecipe).toHaveBeenCalledWith(REQUEST);
	});

	it('does not run when the operator cancels native confirmation', async () => {
		const bridge = bridgeFor({ required: true, confirmed: false });
		const receipt = await confirmAndRunRecipe(bridge, REQUEST);
		expect(receipt).toMatchObject({ accepted: false, needsApproval: true });
		expect(bridge.runRecipe).not.toHaveBeenCalled();
	});

	it('does not run an approved mutation without a bound token', async () => {
		const bridge = bridgeFor({ required: true, confirmed: true });
		const receipt = await confirmAndRunRecipe(bridge, REQUEST);
		expect(receipt).toMatchObject({
			accepted: false,
			needsApproval: true,
			error: expect.stringContaining('valid recipe token'),
		});
		expect(bridge.runRecipe).not.toHaveBeenCalled();
	});

	it('rejects a confirmation response bound to another action', async () => {
		const bridge = bridgeFor({
			actionId: 'recipe-other',
			required: false,
			confirmed: true,
		});
		const receipt = await confirmAndRunRecipe(bridge, REQUEST);
		expect(receipt.error).toContain('mismatched action identifier');
		expect(bridge.runRecipe).not.toHaveBeenCalled();
	});
});

function pendingRun(): RecipeRun {
	return {
		id: 'recipe-run-12345678-1234-4123-8123-123456789abc',
		actionId: REQUEST.actionId,
		recipeId: REQUEST.recipeId,
		recipeRevision: 1,
		evidenceId: 'evidence-12345678-1234-4123-8123-123456789abc',
		status: 'needs-approval',
		createdAt: 100,
		progressSequence: 1,
		message: 'Desktop approval required.',
		concurrency: REQUEST.concurrency ?? 1,
		targetUdids: [...REQUEST.targetUdids],
		pendingRequest: {
			actionId: REQUEST.actionId,
			recipeId: REQUEST.recipeId,
			targetUdids: [...REQUEST.targetUdids],
			concurrency: REQUEST.concurrency ?? 1,
		},
		targets: REQUEST.targetUdids.map((udid) => ({
			udid,
			status: 'queued',
			completedSteps: 0,
			totalSteps: 1,
			message: 'Waiting for approval.',
			cleanup: {
				status: 'not-started',
				completedSteps: 0,
				totalSteps: 0,
				failures: [],
			},
		})),
	};
}

function bridgeFor(
	confirmation: Omit<
		Awaited<ReturnType<RecipeBridge['requestRecipeRunConfirmation']>>,
		'actionId'
	> & { actionId?: string }
): Pick<RecipeBridge, 'requestRecipeRunConfirmation' | 'runRecipe'> & {
	runRecipe: ReturnType<typeof vi.fn<RecipeBridge['runRecipe']>>;
} {
	const runRecipe = vi.fn<RecipeBridge['runRecipe']>(async () => ({
		actionId: REQUEST.actionId,
		accepted: true,
		runId: 'recipe-run-12345678-1234-4123-8123-123456789abc',
	}));
	return {
		requestRecipeRunConfirmation: vi.fn(async () => ({
			actionId: REQUEST.actionId,
			...confirmation,
		})),
		runRecipe,
	};
}

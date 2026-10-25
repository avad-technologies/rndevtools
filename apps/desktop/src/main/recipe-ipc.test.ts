import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type {
	RecipeDefinition,
	RecipeRunRequest,
} from '../shared/recipe-protocol';
import { createRecipeIpcHandlers, type RecipeIpcService } from './recipe-ipc';

const UDID = '11111111-2222-3333-4444-555555555555';
const event = { sender: { id: 7 } } as unknown as IpcMainInvokeEvent;

function recipe(mutation = false): RecipeDefinition {
	return {
		formatVersion: 1,
		id: 'smoke-test',
		name: 'Smoke test',
		revision: 1,
		createdAt: 1,
		updatedAt: 1,
		defaultConcurrency: 2,
		steps: mutation
			? [
					{
						id: 'slim',
						kind: 'slimming.mutation',
						operation: 'apply',
						profileId: 'rndevtools-development',
					},
				]
			: [{ id: 'wait', kind: 'wait', durationMs: 0 }],
		teardown: [],
	};
}

function sensitiveRecipe(): RecipeDefinition {
	return {
		...recipe(),
		steps: [
			{
				id: 'reset-keychain',
				kind: 'simulator',
				action: { operation: 'keychain.reset' },
			},
		],
	};
}

const request: RecipeRunRequest = {
	actionId: 'run-one',
	recipeId: 'smoke-test',
	targetUdids: [UDID],
};

function fixture({
	trusted = true,
	mutation = false,
	sensitive = false,
	approved = false,
} = {}) {
	const definition = sensitive ? sensitiveRecipe() : recipe(mutation);
	const requiresApproval = mutation || sensitive;
	const runRecipe = vi.fn(async (value: RecipeRunRequest) => ({
		actionId: value.actionId,
		accepted: true,
		runId: 'recipe-run-12345678-1234-4123-8123-123456789abc',
	}));
	const service: RecipeIpcService = {
		getState: vi.fn(() => ({
			revision: 0,
			updatedAt: 1,
			recipes: [],
			runs: [],
		})),
		getRecipe: vi.fn(() => definition),
		getEvidence: vi.fn(() => null),
		saveRecipe: vi.fn(async (value) => ({
			id: value.id,
			name: value.name,
			revision: value.revision,
			updatedAt: value.updatedAt,
			stepCount: value.steps.length,
			teardownStepCount: value.teardown.length,
			requiresMutationApproval: requiresApproval,
		})),
		runRecipe,
		cancelRun: vi.fn(() => true),
		deleteRecipe: vi.fn(async () => true),
		importRecipe: vi.fn(async () => ({
			id: definition.id,
			name: definition.name,
			revision: 1,
			updatedAt: 1,
			stepCount: 1,
			teardownStepCount: 0,
			requiresMutationApproval: requiresApproval,
		})),
		exportRecipe: vi.fn(async () => undefined),
		exportEvidence: vi.fn(async () => undefined),
	};
	const dependencies = {
		service,
		assertTrustedRenderer: () => {
			if (!trusted) throw new Error('Rejected IPC from an untrusted renderer.');
		},
		requestRunConfirmation: vi.fn(async () => ({
			actionId: request.actionId,
			required: true,
			confirmed: true,
			token: `confirmation-${'a'.repeat(64)}`,
			expiresAt: 100,
		})),
		consumeRunConfirmation: vi.fn(() => approved),
		confirmDelete: vi.fn(async () => true),
		selectImportPath: vi.fn(async () => '/main/selected/import.json'),
		selectRecipeExportDestination: vi.fn(
			async () => '/main/selected/export.json'
		),
		selectEvidenceExportDestination: vi.fn(
			async () => '/main/selected/evidence.json'
		),
	};
	return {
		dependencies,
		handlers: createRecipeIpcHandlers(dependencies),
		runRecipe,
		service,
	};
}

describe('recipe IPC', () => {
	it('checks renderer trust before parsing or invoking every endpoint', async () => {
		const { handlers, service } = fixture({ trusted: false });
		expect(() => handlers.getState(event)).toThrow('untrusted renderer');
		expect(() => handlers.getRecipe(event, 'smoke-test')).toThrow(
			'untrusted renderer'
		);
		expect(() =>
			handlers.getEvidence(
				event,
				'evidence-12345678-1234-4123-8123-123456789abc'
			)
		).toThrow('untrusted renderer');
		await expect(handlers.saveRecipe(event, recipe())).rejects.toThrow(
			'untrusted renderer'
		);
		await expect(
			handlers.requestRunConfirmation(event, request)
		).rejects.toThrow('untrusted renderer');
		await expect(handlers.runRecipe(event, request)).rejects.toThrow(
			'untrusted renderer'
		);
		expect(() =>
			handlers.cancelRun(
				event,
				'recipe-run-12345678-1234-4123-8123-123456789abc'
			)
		).toThrow('untrusted renderer');
		await expect(
			handlers.runFileOperation(event, {
				actionId: 'export',
				kind: 'recipe.export',
				recipeId: 'smoke-test',
			})
		).rejects.toThrow('untrusted renderer');
		expect(service.getState).not.toHaveBeenCalled();
	});

	it('rejects renderer paths and internal approval flags at the strict boundary', async () => {
		const { handlers, service } = fixture();
		await expect(
			handlers.runFileOperation(event, {
				actionId: 'export',
				kind: 'recipe.export',
				recipeId: 'smoke-test',
				destinationPath: '/renderer/chosen.json',
			})
		).rejects.toThrow();
		await expect(
			handlers.runRecipe(event, { ...request, runApproved: true })
		).rejects.toThrow();
		expect(service.exportRecipe).not.toHaveBeenCalled();
	});

	it('never passes mutation approval without consuming an exact main token', async () => {
		const denied = fixture({ mutation: true, approved: false });
		await denied.handlers.runRecipe(event, request);
		expect(denied.runRecipe).toHaveBeenCalledWith(request);
		expect(denied.runRecipe).not.toHaveBeenCalledWith(request, {
			runApproved: true,
		});

		const accepted = fixture({ mutation: true, approved: true });
		await accepted.handlers.runRecipe(event, request);
		expect(accepted.dependencies.consumeRunConfirmation).toHaveBeenCalledWith(
			event,
			request,
			recipe(true)
		);
		expect(accepted.runRecipe).toHaveBeenCalledWith(request, {
			runApproved: true,
		});
	});

	it('confirms and resumes the exact persisted pending request without a new action id', async () => {
		const pendingRequest: RecipeRunRequest = { ...request, concurrency: 2 };
		const approved = fixture({ mutation: true, approved: true });
		const confirmation = await approved.handlers.requestRunConfirmation(
			event,
			pendingRequest
		);
		expect(confirmation).toMatchObject({
			actionId: pendingRequest.actionId,
			confirmed: true,
		});
		const exactRequest = {
			...pendingRequest,
			confirmationToken: confirmation.token,
		};
		await approved.handlers.runRecipe(event, exactRequest);
		expect(approved.dependencies.requestRunConfirmation).toHaveBeenCalledWith(
			event,
			pendingRequest,
			recipe(true)
		);
		expect(approved.dependencies.consumeRunConfirmation).toHaveBeenCalledWith(
			event,
			exactRequest,
			recipe(true)
		);
		expect(approved.runRecipe).toHaveBeenCalledWith(exactRequest, {
			runApproved: true,
		});
	});

	it('requests native confirmation only for recipes containing privileged actions', async () => {
		const safe = fixture();
		await expect(
			safe.handlers.requestRunConfirmation(event, request)
		).resolves.toEqual({
			actionId: 'run-one',
			required: false,
			confirmed: true,
		});
		expect(safe.dependencies.requestRunConfirmation).not.toHaveBeenCalled();

		const mutation = fixture({ mutation: true });
		await expect(
			mutation.handlers.requestRunConfirmation(event, request)
		).resolves.toMatchObject({ required: true, confirmed: true });
		expect(mutation.dependencies.requestRunConfirmation).toHaveBeenCalled();

		const sensitive = fixture({ sensitive: true });
		await expect(
			sensitive.handlers.requestRunConfirmation(event, request)
		).resolves.toMatchObject({ required: true, confirmed: true });
		expect(sensitive.dependencies.requestRunConfirmation).toHaveBeenCalledWith(
			event,
			request,
			sensitiveRecipe()
		);
	});

	it('keeps import/export paths main-owned and absent from receipts', async () => {
		const { handlers, service } = fixture();
		const imported = await handlers.runFileOperation(event, {
			actionId: 'import',
			kind: 'recipe.import',
		});
		expect(service.importRecipe).toHaveBeenCalledWith(
			'/main/selected/import.json'
		);
		expect(JSON.stringify(imported)).not.toContain('/main/selected');

		const exported = await handlers.runFileOperation(event, {
			actionId: 'export',
			kind: 'recipe.export',
			recipeId: 'smoke-test',
		});
		expect(service.exportRecipe).toHaveBeenCalledWith(
			'smoke-test',
			'/main/selected/export.json'
		);
		expect(JSON.stringify(exported)).not.toContain('/main/selected');
	});
});

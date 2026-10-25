import type { IpcMainInvokeEvent } from 'electron';
import type {
	RecipeDefinition,
	RecipeEvidenceManifest,
	RecipeFileOperationReceipt,
	RecipeRunConfirmationResult,
	RecipeRunReceipt,
	RecipeRunRequest,
	RecipeState,
	RecipeSummary,
} from '../shared/recipe-protocol';
import {
	recipeDefinitionSchema,
	recipeEvidenceIdSchema,
	recipeFileOperationReceiptSchema,
	recipeFileOperationSchema,
	recipeIdSchema,
	recipeRunConfirmationResultSchema,
	recipeRunIdSchema,
	recipeRunReceiptSchema,
	recipeRunRequestSchema,
	recipeStateSchema,
} from '../shared/recipe-protocol';
import { recipeRequiresRunApproval } from './recipe-policy';
import { recipeSummary } from './recipe-store';
import { safeErrorText } from './security';

export type RecipeIpcService = {
	getState: () => RecipeState;
	getRecipe: (recipeId: string) => RecipeDefinition | null;
	getEvidence: (evidenceId: string) => RecipeEvidenceManifest | null;
	saveRecipe: (recipe: RecipeDefinition) => Promise<RecipeSummary>;
	runRecipe: (
		request: RecipeRunRequest,
		options?: { runApproved?: boolean }
	) => Promise<RecipeRunReceipt>;
	cancelRun: (runId: string) => boolean;
	deleteRecipe: (recipeId: string) => Promise<boolean>;
	importRecipe: (filePath: string) => Promise<RecipeSummary>;
	exportRecipe: (recipeId: string, destinationPath: string) => Promise<void>;
	exportEvidence: (
		evidenceId: string,
		destinationPath: string
	) => Promise<void>;
};

type RecipeIpcDependencies = {
	service: RecipeIpcService;
	assertTrustedRenderer: (event: IpcMainInvokeEvent) => void;
	requestRunConfirmation: (
		event: IpcMainInvokeEvent,
		request: RecipeRunRequest,
		recipe: RecipeDefinition
	) => Promise<RecipeRunConfirmationResult>;
	consumeRunConfirmation: (
		event: IpcMainInvokeEvent,
		request: RecipeRunRequest,
		recipe: RecipeDefinition
	) => boolean;
	confirmDelete: (
		event: IpcMainInvokeEvent,
		recipe: RecipeSummary
	) => Promise<boolean>;
	selectImportPath: (event: IpcMainInvokeEvent) => Promise<string | undefined>;
	selectRecipeExportDestination: (
		event: IpcMainInvokeEvent,
		recipe: RecipeDefinition
	) => Promise<string | undefined>;
	selectEvidenceExportDestination: (
		event: IpcMainInvokeEvent,
		evidence: RecipeEvidenceManifest
	) => Promise<string | undefined>;
};

function failedFileOperation(
	actionId: string,
	kind: RecipeFileOperationReceipt['kind'],
	error: unknown
): RecipeFileOperationReceipt {
	return recipeFileOperationReceiptSchema.parse({
		actionId,
		kind,
		completed: false,
		error: safeErrorText(error),
	});
}

export function createRecipeIpcHandlers({
	service,
	assertTrustedRenderer,
	requestRunConfirmation,
	consumeRunConfirmation,
	confirmDelete,
	selectImportPath,
	selectRecipeExportDestination,
	selectEvidenceExportDestination,
}: RecipeIpcDependencies) {
	return {
		getState: (event: IpcMainInvokeEvent): RecipeState => {
			assertTrustedRenderer(event);
			return recipeStateSchema.parse(service.getState());
		},
		getRecipe: (
			event: IpcMainInvokeEvent,
			value: unknown
		): RecipeDefinition | null => {
			assertTrustedRenderer(event);
			return service.getRecipe(recipeIdSchema.parse(value));
		},
		getEvidence: (
			event: IpcMainInvokeEvent,
			value: unknown
		): RecipeEvidenceManifest | null => {
			assertTrustedRenderer(event);
			return service.getEvidence(recipeEvidenceIdSchema.parse(value));
		},
		saveRecipe: async (
			event: IpcMainInvokeEvent,
			value: unknown
		): Promise<RecipeSummary> => {
			assertTrustedRenderer(event);
			return service.saveRecipe(recipeDefinitionSchema.parse(value));
		},
		requestRunConfirmation: async (
			event: IpcMainInvokeEvent,
			value: unknown
		): Promise<RecipeRunConfirmationResult> => {
			assertTrustedRenderer(event);
			const request = recipeRunRequestSchema.parse(value);
			if (request.confirmationToken) {
				return recipeRunConfirmationResultSchema.parse({
					actionId: request.actionId,
					required: true,
					confirmed: false,
					error: 'Confirmation requests cannot reuse an existing token.',
				});
			}
			const recipe = service.getRecipe(request.recipeId);
			if (!recipe) {
				return recipeRunConfirmationResultSchema.parse({
					actionId: request.actionId,
					required: false,
					confirmed: false,
					error: 'Recipe was not found.',
				});
			}
			if (!recipeRequiresRunApproval(recipe)) {
				return recipeRunConfirmationResultSchema.parse({
					actionId: request.actionId,
					required: false,
					confirmed: true,
				});
			}
			return recipeRunConfirmationResultSchema.parse(
				await requestRunConfirmation(event, request, recipe)
			);
		},
		runRecipe: async (
			event: IpcMainInvokeEvent,
			value: unknown
		): Promise<RecipeRunReceipt> => {
			assertTrustedRenderer(event);
			const request = recipeRunRequestSchema.parse(value);
			const recipe = service.getRecipe(request.recipeId);
			if (!recipe) {
				return recipeRunReceiptSchema.parse({
					actionId: request.actionId,
					accepted: false,
					error: 'Recipe was not found.',
				});
			}
			if (!recipeRequiresRunApproval(recipe)) return service.runRecipe(request);
			if (!consumeRunConfirmation(event, request, recipe)) {
				return service.runRecipe(request);
			}
			return service.runRecipe(request, { runApproved: true });
		},
		cancelRun: (event: IpcMainInvokeEvent, value: unknown): boolean => {
			assertTrustedRenderer(event);
			return service.cancelRun(recipeRunIdSchema.parse(value));
		},
		runFileOperation: async (
			event: IpcMainInvokeEvent,
			value: unknown
		): Promise<RecipeFileOperationReceipt> => {
			assertTrustedRenderer(event);
			const operation = recipeFileOperationSchema.parse(value);
			try {
				if (operation.kind === 'recipe.import') {
					const sourcePath = await selectImportPath(event);
					if (!sourcePath) {
						return recipeFileOperationReceiptSchema.parse({
							actionId: operation.actionId,
							kind: operation.kind,
							completed: false,
							cancelled: true,
						});
					}
					const recipe = await service.importRecipe(sourcePath);
					return recipeFileOperationReceiptSchema.parse({
						actionId: operation.actionId,
						kind: operation.kind,
						completed: true,
						recipe,
					});
				}
				if (operation.kind === 'recipe.delete') {
					const recipe = service.getRecipe(operation.recipeId);
					if (!recipe) throw new Error('Recipe was not found.');
					const summary = recipeSummary(recipe);
					if (!(await confirmDelete(event, summary))) {
						return recipeFileOperationReceiptSchema.parse({
							actionId: operation.actionId,
							kind: operation.kind,
							completed: false,
							cancelled: true,
							recipe: summary,
						});
					}
					if (!(await service.deleteRecipe(operation.recipeId))) {
						throw new Error('Recipe is no longer available.');
					}
					return recipeFileOperationReceiptSchema.parse({
						actionId: operation.actionId,
						kind: operation.kind,
						completed: true,
						recipe: summary,
					});
				}
				if (operation.kind === 'recipe.export') {
					const recipe = service.getRecipe(operation.recipeId);
					if (!recipe) throw new Error('Recipe was not found.');
					const destinationPath = await selectRecipeExportDestination(
						event,
						recipe
					);
					if (!destinationPath) {
						return recipeFileOperationReceiptSchema.parse({
							actionId: operation.actionId,
							kind: operation.kind,
							completed: false,
							cancelled: true,
						});
					}
					await service.exportRecipe(operation.recipeId, destinationPath);
					return recipeFileOperationReceiptSchema.parse({
						actionId: operation.actionId,
						kind: operation.kind,
						completed: true,
					});
				}
				const evidence = service.getEvidence(operation.evidenceId);
				if (!evidence) throw new Error('Evidence bundle was not found.');
				const destinationPath = await selectEvidenceExportDestination(
					event,
					evidence
				);
				if (!destinationPath) {
					return recipeFileOperationReceiptSchema.parse({
						actionId: operation.actionId,
						kind: operation.kind,
						completed: false,
						cancelled: true,
					});
				}
				await service.exportEvidence(operation.evidenceId, destinationPath);
				return recipeFileOperationReceiptSchema.parse({
					actionId: operation.actionId,
					kind: operation.kind,
					completed: true,
				});
			} catch (error) {
				return failedFileOperation(operation.actionId, operation.kind, error);
			}
		},
	};
}

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import type { ActionStatus } from '@/lib/action-notice';
import {
	errorText,
	nextActionId,
	type WithoutActionId,
} from '@/lib/runtime-action';
import type {
	RecipeBridge,
	RecipeDefinition,
	RecipeEvidenceManifest,
	RecipeFileOperation,
	RecipeFileOperationReceipt,
	RecipeRun,
	RecipeRunConfirmationResult,
	RecipeRunReceipt,
	RecipeRunRequest,
	RecipeState,
	RecipeSummary,
} from '../../shared/recipe-protocol';

export type RecipeRunInput = WithoutActionId<RecipeRunRequest>;
export type RecipeFileOperationInput = WithoutActionId<RecipeFileOperation>;

type RecipeRuntimeValue = {
	state: RecipeState;
	isLoading: boolean;
	isBridgeAvailable: boolean;
	runtimeError: string | null;
	actionStatus: ActionStatus;
	clearActionStatus: () => void;
	refresh: () => Promise<void>;
	getRecipe: (recipeId: string) => Promise<RecipeDefinition | null>;
	getEvidence: (evidenceId: string) => Promise<RecipeEvidenceManifest | null>;
	saveRecipe: (recipe: RecipeDefinition) => Promise<RecipeSummary>;
	runRecipe: (request: RecipeRunInput) => Promise<RecipeRunReceipt>;
	approveRun: (run: RecipeRun) => Promise<RecipeRunReceipt>;
	cancelRun: (runId: string) => Promise<boolean>;
	runFileOperation: (
		operation: RecipeFileOperationInput
	) => Promise<RecipeFileOperationReceipt>;
};

const EMPTY_RECIPE_STATE: RecipeState = {
	revision: 0,
	updatedAt: 0,
	recipes: [],
	runs: [],
};

const RecipeRuntimeContext = createContext<RecipeRuntimeValue | null>(null);

function getRecipeBridge(): RecipeBridge | null {
	const candidate = window.rnDevtools as Partial<RecipeBridge> | undefined;
	if (
		!candidate ||
		typeof candidate.getRecipeState !== 'function' ||
		typeof candidate.subscribeRecipeState !== 'function' ||
		typeof candidate.getRecipe !== 'function' ||
		typeof candidate.getRecipeEvidence !== 'function' ||
		typeof candidate.saveRecipe !== 'function' ||
		typeof candidate.runRecipe !== 'function' ||
		typeof candidate.requestRecipeRunConfirmation !== 'function' ||
		typeof candidate.cancelRecipeRun !== 'function' ||
		typeof candidate.runRecipeFileOperation !== 'function'
	) {
		return null;
	}
	return candidate as RecipeBridge;
}

export async function confirmAndRunRecipe(
	bridge: Pick<RecipeBridge, 'requestRecipeRunConfirmation' | 'runRecipe'>,
	request: RecipeRunRequest
): Promise<RecipeRunReceipt> {
	let confirmation: RecipeRunConfirmationResult;
	try {
		confirmation = await bridge.requestRecipeRunConfirmation(request);
	} catch (error) {
		return {
			actionId: request.actionId,
			accepted: false,
			error: errorText(error),
		};
	}
	if (confirmation.actionId !== request.actionId) {
		return {
			actionId: request.actionId,
			accepted: false,
			error: 'Native confirmation returned a mismatched action identifier.',
		};
	}
	if (!confirmation.confirmed) {
		return {
			actionId: request.actionId,
			accepted: false,
			needsApproval: confirmation.required,
			error: confirmation.error ?? 'Recipe run cancelled by the operator.',
		};
	}
	if (confirmation.required && !confirmation.token) {
		return {
			actionId: request.actionId,
			accepted: false,
			needsApproval: true,
			error: 'Native confirmation did not issue a valid recipe token.',
		};
	}
	const confirmedRequest: RecipeRunRequest = confirmation.required
		? { ...request, confirmationToken: confirmation.token }
		: request;
	try {
		const receipt = await bridge.runRecipe(confirmedRequest);
		if (receipt.actionId !== request.actionId) {
			return {
				actionId: request.actionId,
				accepted: false,
				error: 'Recipe provider returned a mismatched action identifier.',
			};
		}
		return receipt;
	} catch (error) {
		return {
			actionId: request.actionId,
			accepted: false,
			error: errorText(error),
		};
	}
}

export function pendingRecipeApprovalRequest(
	run: RecipeRun
): RecipeRunRequest | null {
	const pending = run.pendingRequest;
	if (
		run.status !== 'needs-approval' ||
		!pending ||
		pending.actionId !== run.actionId ||
		pending.recipeId !== run.recipeId ||
		pending.concurrency !== run.concurrency ||
		pending.targetUdids.length !== run.targetUdids.length ||
		pending.targetUdids.some((udid, index) => udid !== run.targetUdids[index])
	) {
		return null;
	}
	return {
		actionId: pending.actionId,
		recipeId: pending.recipeId,
		targetUdids: [...pending.targetUdids],
		concurrency: pending.concurrency,
	};
}

export function RecipeRuntimeProvider({ children }: { children: ReactNode }) {
	const bridge = useMemo(getRecipeBridge, []);
	const [state, setState] = useState<RecipeState>(EMPTY_RECIPE_STATE);
	const [isLoading, setIsLoading] = useState(Boolean(bridge));
	const [runtimeError, setRuntimeError] = useState<string | null>(() =>
		bridge
			? null
			: 'Recipe automation requires the secure desktop bridge. Update and reopen the installed desktop app.'
	);
	const [actionStatus, setActionStatus] = useState<ActionStatus>({
		kind: 'idle',
		message: '',
	});
	const pendingKeysRef = useRef(new Set<string>());
	const latestActionIdRef = useRef<string | null>(null);

	useEffect(() => {
		if (!bridge) return;
		let active = true;
		let unsubscribe = () => {};
		try {
			unsubscribe = bridge.subscribeRecipeState((nextState) => {
				if (!active) return;
				setState(nextState);
				setRuntimeError(null);
				setIsLoading(false);
			});
		} catch (error) {
			setRuntimeError(errorText(error));
			setIsLoading(false);
		}
		void bridge
			.getRecipeState()
			.then((nextState) => {
				if (!active) return;
				setState(nextState);
				setRuntimeError(null);
			})
			.catch((error: unknown) => {
				if (active) setRuntimeError(errorText(error));
			})
			.finally(() => {
				if (active) setIsLoading(false);
			});
		return () => {
			active = false;
			try {
				unsubscribe();
			} catch {
				// A faulty native disposer must not break React teardown.
			}
		};
	}, [bridge]);

	const refresh = useCallback(async () => {
		if (!bridge) {
			setRuntimeError(
				'Recipe state is unavailable because the bridge is missing.'
			);
			return;
		}
		setIsLoading(true);
		try {
			const nextState = await bridge.getRecipeState();
			setState(nextState);
			setRuntimeError(null);
		} catch (error) {
			setRuntimeError(errorText(error));
		} finally {
			setIsLoading(false);
		}
	}, [bridge]);

	const getRecipe = useCallback(
		async (recipeId: string) => {
			if (!bridge)
				throw new Error('Recipe loading requires the secure bridge.');
			return bridge.getRecipe(recipeId);
		},
		[bridge]
	);

	const getEvidence = useCallback(
		async (evidenceId: string) => {
			if (!bridge)
				throw new Error('Evidence loading requires the secure bridge.');
			return bridge.getRecipeEvidence(evidenceId);
		},
		[bridge]
	);

	const saveRecipe = useCallback(
		async (recipe: RecipeDefinition): Promise<RecipeSummary> => {
			if (!bridge) {
				throw new Error('Recipe saving requires the secure desktop bridge.');
			}
			const key = `save:${recipe.id}`;
			if (pendingKeysRef.current.has(key)) {
				throw new Error('This recipe is already being saved.');
			}
			pendingKeysRef.current.add(key);
			setActionStatus({ kind: 'pending', message: `Saving ${recipe.name}…` });
			try {
				const summary = await bridge.saveRecipe(recipe);
				setActionStatus({ kind: 'success', message: `${summary.name} saved.` });
				await refresh();
				return summary;
			} catch (error) {
				const message = errorText(error);
				setActionStatus({ kind: 'error', message });
				throw new Error(message);
			} finally {
				pendingKeysRef.current.delete(key);
			}
		},
		[bridge, refresh]
	);

	const runRecipe = useCallback(
		async (input: RecipeRunInput): Promise<RecipeRunReceipt> => {
			const actionId = nextActionId('recipe');
			if (!bridge) {
				const error = 'Recipe execution requires the secure desktop bridge.';
				setActionStatus({ kind: 'error', message: error });
				return { actionId, accepted: false, error };
			}
			const key = `run:${input.recipeId}:${[...input.targetUdids].sort().join(',')}`;
			if (pendingKeysRef.current.has(key)) {
				const error = 'This exact recipe run is already being submitted.';
				setActionStatus({ kind: 'error', message: error });
				return { actionId, accepted: false, error };
			}
			if (pendingKeysRef.current.size >= 16) {
				const error =
					'The recipe submission queue is full. Wait for a receipt.';
				setActionStatus({ kind: 'error', message: error });
				return { actionId, accepted: false, error };
			}
			pendingKeysRef.current.add(key);
			latestActionIdRef.current = actionId;
			setActionStatus({
				kind: 'pending',
				message: 'Reviewing exact recipe targets and mutations…',
			});
			try {
				const receipt = await confirmAndRunRecipe(bridge, {
					...input,
					actionId,
				});
				if (latestActionIdRef.current === actionId) {
					setActionStatus(
						receipt.accepted
							? { kind: 'success', message: 'Recipe run accepted.' }
							: {
									kind: 'error',
									message: receipt.error ?? 'Recipe run was rejected.',
								}
					);
				}
				return receipt;
			} finally {
				pendingKeysRef.current.delete(key);
			}
		},
		[bridge]
	);

	const approveRun = useCallback(
		async (run: RecipeRun): Promise<RecipeRunReceipt> => {
			const request = pendingRecipeApprovalRequest(run);
			const actionId = run.actionId;
			if (!request) {
				const error =
					'This run no longer carries the exact pending recipe request. Refresh before approving it.';
				setActionStatus({ kind: 'error', message: error });
				return { actionId, accepted: false, error };
			}
			if (!bridge) {
				const error = 'Recipe approval requires the secure desktop bridge.';
				setActionStatus({ kind: 'error', message: error });
				return { actionId, accepted: false, error };
			}
			const key = `approve:${actionId}`;
			if (pendingKeysRef.current.has(key)) {
				const error = 'This exact pending run is already being reviewed.';
				setActionStatus({ kind: 'error', message: error });
				return { actionId, accepted: false, error };
			}
			if (pendingKeysRef.current.size >= 16) {
				const error =
					'The recipe submission queue is full. Wait for a receipt.';
				setActionStatus({ kind: 'error', message: error });
				return { actionId, accepted: false, error };
			}
			pendingKeysRef.current.add(key);
			latestActionIdRef.current = actionId;
			setActionStatus({
				kind: 'pending',
				message: 'Reviewing the exact pending agent request…',
			});
			try {
				const receipt = await confirmAndRunRecipe(bridge, request);
				if (latestActionIdRef.current === actionId) {
					setActionStatus(
						receipt.accepted
							? { kind: 'success', message: 'Pending recipe run approved.' }
							: {
									kind: 'error',
									message: receipt.error ?? 'Recipe approval was rejected.',
								}
					);
				}
				return receipt;
			} finally {
				pendingKeysRef.current.delete(key);
			}
		},
		[bridge]
	);

	const cancelRun = useCallback(
		async (runId: string): Promise<boolean> => {
			if (!bridge) {
				setActionStatus({
					kind: 'error',
					message: 'Recipe cancellation requires the secure bridge.',
				});
				return false;
			}
			try {
				const cancelled = await bridge.cancelRecipeRun(runId);
				setActionStatus(
					cancelled
						? { kind: 'success', message: 'Recipe cancellation requested.' }
						: {
								kind: 'error',
								message: 'The recipe run could not be cancelled.',
							}
				);
				return cancelled;
			} catch (error) {
				setActionStatus({ kind: 'error', message: errorText(error) });
				return false;
			}
		},
		[bridge]
	);

	const runFileOperation = useCallback(
		async (
			input: RecipeFileOperationInput
		): Promise<RecipeFileOperationReceipt> => {
			const actionId = nextActionId('recipe-file');
			const failed = (error: string): RecipeFileOperationReceipt => ({
				actionId,
				kind: input.kind,
				completed: false,
				error,
			});
			if (!bridge) {
				const error = 'Recipe file operations require the secure bridge.';
				setActionStatus({ kind: 'error', message: error });
				return failed(error);
			}
			const key = JSON.stringify(input);
			if (pendingKeysRef.current.has(key)) {
				const error = 'This exact file operation is already open.';
				setActionStatus({ kind: 'error', message: error });
				return failed(error);
			}
			pendingKeysRef.current.add(key);
			setActionStatus({
				kind: 'pending',
				message:
					input.kind === 'recipe.import'
						? 'Waiting for a recipe file…'
						: input.kind === 'recipe.delete'
							? 'Waiting for native delete confirmation…'
							: 'Waiting for an export destination…',
			});
			try {
				const receipt = await bridge.runRecipeFileOperation({
					...input,
					actionId,
				} as RecipeFileOperation);
				setActionStatus(
					receipt.completed
						? { kind: 'success', message: fileOperationSuccess(receipt.kind) }
						: receipt.cancelled
							? { kind: 'success', message: 'File operation cancelled.' }
							: {
									kind: 'error',
									message: receipt.error ?? 'File operation failed.',
								}
				);
				if (
					receipt.completed &&
					['recipe.import', 'recipe.delete'].includes(input.kind)
				) {
					await refresh();
				}
				return receipt;
			} catch (error) {
				const message = errorText(error);
				setActionStatus({ kind: 'error', message });
				return failed(message);
			} finally {
				pendingKeysRef.current.delete(key);
			}
		},
		[bridge, refresh]
	);

	const clearActionStatus = useCallback(() => {
		setActionStatus({ kind: 'idle', message: '' });
	}, []);

	const value = useMemo<RecipeRuntimeValue>(
		() => ({
			state,
			isLoading,
			isBridgeAvailable: Boolean(bridge),
			runtimeError,
			actionStatus,
			clearActionStatus,
			refresh,
			getRecipe,
			getEvidence,
			saveRecipe,
			runRecipe,
			approveRun,
			cancelRun,
			runFileOperation,
		}),
		[
			actionStatus,
			approveRun,
			bridge,
			cancelRun,
			clearActionStatus,
			getEvidence,
			getRecipe,
			isLoading,
			refresh,
			runFileOperation,
			runRecipe,
			runtimeError,
			saveRecipe,
			state,
		]
	);

	return (
		<RecipeRuntimeContext.Provider value={value}>
			{children}
		</RecipeRuntimeContext.Provider>
	);
}

export function useRecipeRuntime(): RecipeRuntimeValue {
	const value = useContext(RecipeRuntimeContext);
	if (!value) {
		throw new Error(
			'useRecipeRuntime must be used inside RecipeRuntimeProvider.'
		);
	}
	return value;
}

function fileOperationSuccess(
	kind: RecipeFileOperationReceipt['kind']
): string {
	switch (kind) {
		case 'recipe.import':
			return 'Recipe imported.';
		case 'recipe.export':
			return 'Recipe exported.';
		case 'recipe.delete':
			return 'Recipe deleted.';
		case 'evidence.export':
			return 'Evidence bundle exported.';
	}
}

import { contextBridge, ipcRenderer } from 'electron';
import {
	type AgentBridge,
	type AgentOperation,
	type AgentState,
	agentOperationSchema,
	agentStateSchema,
} from '../shared/agent-protocol';
import {
	type AppearanceBridge,
	type AppearancePreference,
	appearancePreferenceSchema,
} from '../shared/appearance-protocol';
import {
	type BuildInsightsBridge,
	type BuildInsightsOperation,
	type BuildInsightsOperationReceipt,
	type BuildInsightsState,
	buildInsightsOperationReceiptSchema,
	buildInsightsOperationSchema,
	buildInsightsStateSchema,
} from '../shared/build-insights-protocol';
import { IPC_CHANNELS } from '../shared/ipc';
import {
	type LaneBridge,
	type LaneOperation,
	type LaneOperationReceipt,
	type LaneState,
	laneOperationReceiptSchema,
	laneOperationSchema,
	laneStateSchema,
} from '../shared/lane-protocol';
import {
	createDesktopStateParser,
	type DesktopAction,
	type DesktopActionResult,
	type DesktopBootstrap,
	type DesktopBridge,
	type DesktopState,
	desktopActionResultSchema,
	desktopActionSchema,
	desktopBootstrapSchema,
} from '../shared/protocol';
import {
	type RecipeBridge,
	type RecipeDefinition,
	type RecipeEvidenceManifest,
	type RecipeFileOperation,
	type RecipeFileOperationReceipt,
	type RecipeRunConfirmationResult,
	type RecipeRunReceipt,
	type RecipeRunRequest,
	type RecipeState,
	type RecipeSummary,
	recipeDefinitionSchema,
	recipeEvidenceIdSchema,
	recipeEvidenceManifestSchema,
	recipeFileOperationReceiptSchema,
	recipeFileOperationSchema,
	recipeIdSchema,
	recipeRunConfirmationResultSchema,
	recipeRunIdSchema,
	recipeRunReceiptSchema,
	recipeRunRequestSchema,
	recipeStateSchema,
	recipeSummarySchema,
} from '../shared/recipe-protocol';
import {
	type SimulatorInput,
	type SimulatorInputBridge,
	type SimulatorInputResult,
	simulatorInputResultSchema,
	simulatorInputSchema,
} from '../shared/simulator-input-protocol';
import {
	type SimulatorAction,
	type SimulatorActionReceipt,
	type SimulatorBridge,
	type SimulatorCaptureAccessResult,
	type SimulatorCaptureOperation,
	type SimulatorCaptureOperationReceipt,
	type SimulatorCaptureRetentionState,
	type SimulatorConfirmationResult,
	type SimulatorOnboardingOperation,
	type SimulatorOnboardingReceipt,
	type SimulatorState,
	simulatorActionReceiptSchema,
	simulatorActionSchema,
	simulatorCaptureAccessResultSchema,
	simulatorCaptureIdSchema,
	simulatorCaptureOperationReceiptSchema,
	simulatorCaptureOperationSchema,
	simulatorCaptureRetentionStateSchema,
	simulatorConfirmationResultSchema,
	simulatorJobIdSchema,
	simulatorOnboardingOperationSchema,
	simulatorOnboardingReceiptSchema,
	simulatorStateSchema,
} from '../shared/simulator-protocol';
import {
	SIMULATOR_STREAM_MAX_FRAME_BYTES,
	type SimulatorStreamBridge,
	type SimulatorStreamFrame,
	type SimulatorStreamStatus,
	type SimulatorStreamSubscription,
	simulatorStreamFrameSchema,
	simulatorStreamStatusSchema,
	simulatorStreamSubscriptionsSchema,
} from '../shared/simulator-stream-protocol';
import {
	type SlimmingAcknowledgementReceipt,
	type SlimmingAcknowledgementRequest,
	type SlimmingAction,
	type SlimmingActionReceipt,
	type SlimmingBridge,
	type SlimmingConfirmationResult,
	type SlimmingConfirmationTarget,
	type SlimmingSettingReceipt,
	type SlimmingSettingRequest,
	type SlimmingState,
	slimmingAcknowledgementReceiptSchema,
	slimmingAcknowledgementRequestSchema,
	slimmingActionReceiptSchema,
	slimmingActionSchema,
	slimmingConfirmationResultSchema,
	slimmingConfirmationTargetSchema,
	slimmingJobIdSchema,
	slimmingSettingReceiptSchema,
	slimmingSettingRequestSchema,
	slimmingStateSchema,
} from '../shared/slimming-protocol';
import {
	type SupabaseBridge,
	type SupabaseConfirmationResult,
	type SupabaseInterest,
	type SupabaseOperation,
	type SupabaseOperationReceipt,
	type SupabaseState,
	supabaseConfirmationResultSchema,
	supabaseInterestSchema,
	supabaseOperationReceiptSchema,
	supabaseOperationSchema,
	supabaseStateSchema,
} from '../shared/supabase-protocol';

type StateParseResult<T> =
	| { success: true; data: T }
	| {
			success: false;
			error: {
				issues: readonly { path: readonly PropertyKey[]; code: string }[];
			};
	  };

const MAX_REPORTED_ISSUES = 5;

// A path can hold keys the app chose, such as header names. Anything but a
// short plain name prints as `?`, so URLs, emails and other text stay out.
function issuePath(path: readonly PropertyKey[]): string {
	return (
		path
			.map((segment) =>
				typeof segment === 'number' ||
				(typeof segment === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(segment))
					? String(segment)
					: '?'
			)
			.join('.') || '(root)'
	);
}

/**
 * Forwards each pushed state that validates. Main sends whole states, so one
 * that fails would otherwise freeze a panel without a trace: the first of a
 * run of rejected updates is reported with its issue paths and codes, never
 * the values.
 */
function subscribeToState<T>(
	channel: string,
	label: string,
	parse: (value: unknown) => StateParseResult<T>,
	listener: (state: T) => void
): () => void {
	if (typeof listener !== 'function') {
		throw new TypeError(`${label} listener must be a function.`);
	}
	let rejecting = false;
	const wrapped = (_event: Electron.IpcRendererEvent, state: unknown) => {
		const parsed = parse(state);
		if (!parsed.success) {
			if (!rejecting) {
				rejecting = true;
				const issues = parsed.error.issues
					.slice(0, MAX_REPORTED_ISSUES)
					.map((issue) => `${issuePath(issue.path)} (${issue.code})`);
				console.warn(
					`Ignoring ${label.toLowerCase()} updates that fail validation: ${issues.join(', ')}`
				);
			}
			return;
		}
		rejecting = false;
		try {
			listener(parsed.data);
		} catch {
			// A renderer callback must not break the isolated IPC event handler.
		}
	};
	ipcRenderer.on(channel, wrapped);
	return () => ipcRenderer.removeListener(channel, wrapped);
}

const bridge: DesktopBridge &
	AppearanceBridge &
	SimulatorBridge &
	SlimmingBridge &
	RecipeBridge &
	BuildInsightsBridge &
	LaneBridge &
	AgentBridge &
	SimulatorInputBridge &
	SimulatorStreamBridge &
	SupabaseBridge = {
	getBootstrap: async () =>
		desktopBootstrapSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.getBootstrap)
		) as DesktopBootstrap,
	subscribe: (listener: (state: DesktopState) => void) =>
		subscribeToState(
			IPC_CHANNELS.stateChanged,
			'Desktop state',
			createDesktopStateParser(),
			listener
		),
	runAction: async (action: DesktopAction) => {
		const validatedAction = desktopActionSchema.parse(action);
		return desktopActionResultSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.runAction, validatedAction)
		) as DesktopActionResult;
	},
	getAppearance: async () =>
		appearancePreferenceSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.getAppearance)
		) as AppearancePreference,
	setAppearance: async (preference: AppearancePreference) => {
		const validated = appearancePreferenceSchema.parse(preference);
		return appearancePreferenceSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.setAppearance, validated)
		) as AppearancePreference;
	},
	getSimulatorState: async () =>
		simulatorStateSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.getSimulatorState)
		) as SimulatorState,
	subscribeSimulatorState: (listener: (state: SimulatorState) => void) =>
		subscribeToState(
			IPC_CHANNELS.simulatorStateChanged,
			'Simulator state',
			(value) => simulatorStateSchema.safeParse(value),
			listener
		),
	refreshSimulators: async () =>
		simulatorStateSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.refreshSimulators)
		) as SimulatorState,
	requestSimulatorConfirmation: async (action: SimulatorAction) => {
		const validatedAction = simulatorActionSchema.parse(action);
		return simulatorConfirmationResultSchema.parse(
			await ipcRenderer.invoke(
				IPC_CHANNELS.requestSimulatorConfirmation,
				validatedAction
			)
		) as SimulatorConfirmationResult;
	},
	runSimulatorAction: async (action: SimulatorAction) => {
		const validatedAction = simulatorActionSchema.parse(action);
		return simulatorActionReceiptSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.runSimulatorAction, validatedAction)
		) as SimulatorActionReceipt;
	},
	cancelSimulatorJob: async (jobId: string) => {
		const validatedJobId = simulatorJobIdSchema.parse(jobId);
		return Boolean(
			await ipcRenderer.invoke(IPC_CHANNELS.cancelSimulatorJob, validatedJobId)
		);
	},
	getSimulatorCaptureAccess: async (captureId: string) => {
		const validatedCaptureId = simulatorCaptureIdSchema.parse(captureId);
		return simulatorCaptureAccessResultSchema.parse(
			await ipcRenderer.invoke(
				IPC_CHANNELS.getSimulatorCaptureAccess,
				validatedCaptureId
			)
		) as SimulatorCaptureAccessResult;
	},
	getSimulatorCaptureRetention: async () =>
		simulatorCaptureRetentionStateSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.getSimulatorCaptureRetention)
		) as SimulatorCaptureRetentionState,
	runSimulatorCaptureOperation: async (
		operation: SimulatorCaptureOperation
	) => {
		const validatedOperation = simulatorCaptureOperationSchema.parse(operation);
		return simulatorCaptureOperationReceiptSchema.parse(
			await ipcRenderer.invoke(
				IPC_CHANNELS.runSimulatorCaptureOperation,
				validatedOperation
			)
		) as SimulatorCaptureOperationReceipt;
	},
	runSimulatorOnboardingOperation: async (
		operation: SimulatorOnboardingOperation
	) => {
		const validatedOperation =
			simulatorOnboardingOperationSchema.parse(operation);
		return simulatorOnboardingReceiptSchema.parse(
			await ipcRenderer.invoke(
				IPC_CHANNELS.runSimulatorOnboardingOperation,
				validatedOperation
			)
		) as SimulatorOnboardingReceipt;
	},
	getSlimmingState: async () =>
		slimmingStateSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.getSlimmingState)
		) as SlimmingState,
	subscribeSlimmingState: (listener: (state: SlimmingState) => void) =>
		subscribeToState(
			IPC_CHANNELS.slimmingStateChanged,
			'Slimming state',
			(value) => slimmingStateSchema.safeParse(value),
			listener
		),
	refreshSlimming: async () =>
		slimmingStateSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.refreshSlimming)
		) as SlimmingState,
	setSlimmingEnabled: async (request: SlimmingSettingRequest) => {
		const validated = slimmingSettingRequestSchema.parse(request);
		return slimmingSettingReceiptSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.setSlimmingEnabled, validated)
		) as SlimmingSettingReceipt;
	},
	acknowledgeSlimmingCompatibility: async (
		request: SlimmingAcknowledgementRequest
	) => {
		const validated = slimmingAcknowledgementRequestSchema.parse(request);
		return slimmingAcknowledgementReceiptSchema.parse(
			await ipcRenderer.invoke(
				IPC_CHANNELS.acknowledgeSlimmingCompatibility,
				validated
			)
		) as SlimmingAcknowledgementReceipt;
	},
	requestSlimmingConfirmation: async (target: SlimmingConfirmationTarget) => {
		const validated = slimmingConfirmationTargetSchema.parse(target);
		return slimmingConfirmationResultSchema.parse(
			await ipcRenderer.invoke(
				IPC_CHANNELS.requestSlimmingConfirmation,
				validated
			)
		) as SlimmingConfirmationResult;
	},
	runSlimmingAction: async (action: SlimmingAction) => {
		const validated = slimmingActionSchema.parse(action);
		return slimmingActionReceiptSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.runSlimmingAction, validated)
		) as SlimmingActionReceipt;
	},
	cancelSlimmingJob: async (jobId: string) => {
		const validated = slimmingJobIdSchema.parse(jobId);
		return Boolean(
			await ipcRenderer.invoke(IPC_CHANNELS.cancelSlimmingJob, validated)
		);
	},
	getRecipeState: async () =>
		recipeStateSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.getRecipeState)
		) as RecipeState,
	subscribeRecipeState: (listener: (state: RecipeState) => void) =>
		subscribeToState(
			IPC_CHANNELS.recipeStateChanged,
			'Recipe state',
			(value) => recipeStateSchema.safeParse(value),
			listener
		),
	getRecipe: async (recipeId: string) => {
		const result = await ipcRenderer.invoke(
			IPC_CHANNELS.getRecipe,
			recipeIdSchema.parse(recipeId)
		);
		return result === null
			? null
			: (recipeDefinitionSchema.parse(result) as RecipeDefinition);
	},
	getRecipeEvidence: async (evidenceId: string) => {
		const result = await ipcRenderer.invoke(
			IPC_CHANNELS.getRecipeEvidence,
			recipeEvidenceIdSchema.parse(evidenceId)
		);
		return result === null
			? null
			: (recipeEvidenceManifestSchema.parse(result) as RecipeEvidenceManifest);
	},
	saveRecipe: async (recipe: RecipeDefinition) =>
		recipeSummarySchema.parse(
			await ipcRenderer.invoke(
				IPC_CHANNELS.saveRecipe,
				recipeDefinitionSchema.parse(recipe)
			)
		) as RecipeSummary,
	runRecipe: async (request: RecipeRunRequest) =>
		recipeRunReceiptSchema.parse(
			await ipcRenderer.invoke(
				IPC_CHANNELS.runRecipe,
				recipeRunRequestSchema.parse(request)
			)
		) as RecipeRunReceipt,
	requestRecipeRunConfirmation: async (request: RecipeRunRequest) =>
		recipeRunConfirmationResultSchema.parse(
			await ipcRenderer.invoke(
				IPC_CHANNELS.requestRecipeRunConfirmation,
				recipeRunRequestSchema.parse(request)
			)
		) as RecipeRunConfirmationResult,
	cancelRecipeRun: async (runId: string) =>
		Boolean(
			await ipcRenderer.invoke(
				IPC_CHANNELS.cancelRecipeRun,
				recipeRunIdSchema.parse(runId)
			)
		),
	runRecipeFileOperation: async (operation: RecipeFileOperation) =>
		recipeFileOperationReceiptSchema.parse(
			await ipcRenderer.invoke(
				IPC_CHANNELS.runRecipeFileOperation,
				recipeFileOperationSchema.parse(operation)
			)
		) as RecipeFileOperationReceipt,
	getBuildInsightsState: async () =>
		buildInsightsStateSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.getBuildInsightsState)
		) as BuildInsightsState,
	subscribeBuildInsightsState: (
		listener: (state: BuildInsightsState) => void
	) =>
		subscribeToState(
			IPC_CHANNELS.buildInsightsStateChanged,
			'Build Insights state',
			(value) => buildInsightsStateSchema.safeParse(value),
			listener
		),
	runBuildInsightsOperation: async (operation: BuildInsightsOperation) => {
		const validated = buildInsightsOperationSchema.parse(operation);
		return buildInsightsOperationReceiptSchema.parse(
			await ipcRenderer.invoke(
				IPC_CHANNELS.runBuildInsightsOperation,
				validated
			)
		) as BuildInsightsOperationReceipt;
	},
	getLaneState: async () =>
		laneStateSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.getLaneState)
		) as LaneState,
	subscribeLaneState: (listener: (state: LaneState) => void) =>
		subscribeToState(
			IPC_CHANNELS.laneStateChanged,
			'Lane state',
			(value) => laneStateSchema.safeParse(value),
			listener
		),
	runLaneOperation: async (operation: LaneOperation) => {
		const validated = laneOperationSchema.parse(operation);
		return laneOperationReceiptSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.runLaneOperation, validated)
		) as LaneOperationReceipt;
	},
	sendSimulatorInput: async (input: SimulatorInput) => {
		const validated = simulatorInputSchema.parse(input);
		return simulatorInputResultSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.sendSimulatorInput, validated)
		) as SimulatorInputResult;
	},
	getAgentState: async () =>
		agentStateSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.getAgentState)
		) as AgentState,
	subscribeAgentState: (listener: (state: AgentState) => void) =>
		subscribeToState(
			IPC_CHANNELS.agentStateChanged,
			'Agent state',
			(value) => agentStateSchema.safeParse(value),
			listener
		),
	runAgentOperation: async (operation: AgentOperation) => {
		const validated = agentOperationSchema.parse(operation);
		return agentStateSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.runAgentOperation, validated)
		) as AgentState;
	},
	setSimulatorStreamSubscriptions: async (
		subscriptions: readonly SimulatorStreamSubscription[]
	) => {
		await ipcRenderer.invoke(
			IPC_CHANNELS.setSimulatorStreamSubscriptions,
			simulatorStreamSubscriptionsSchema.parse(subscriptions)
		);
	},
	subscribeSimulatorStreamFrames: (
		listener: (frame: SimulatorStreamFrame, bytes: Uint8Array) => void
	) => {
		if (typeof listener !== 'function') {
			throw new TypeError('Stream frame listener must be a function.');
		}
		const wrapped = (
			_event: Electron.IpcRendererEvent,
			frame: unknown,
			bytes: unknown
		) => {
			const parsed = simulatorStreamFrameSchema.safeParse(frame);
			if (
				!parsed.success ||
				!(bytes instanceof Uint8Array) ||
				bytes.byteLength === 0 ||
				bytes.byteLength > SIMULATOR_STREAM_MAX_FRAME_BYTES
			) {
				return;
			}
			try {
				listener(parsed.data, bytes);
			} catch {
				// A renderer callback must not break the isolated IPC event handler.
			}
		};
		ipcRenderer.on(IPC_CHANNELS.simulatorStreamFrame, wrapped);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.simulatorStreamFrame, wrapped);
	},
	subscribeSimulatorStreamStatus: (
		listener: (status: SimulatorStreamStatus) => void
	) =>
		subscribeToState(
			IPC_CHANNELS.simulatorStreamStatus,
			'Stream status',
			(value) => simulatorStreamStatusSchema.safeParse(value),
			listener
		),
	getSupabaseState: async () =>
		supabaseStateSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.getSupabaseState)
		) as SupabaseState,
	subscribeSupabaseState: (listener: (state: SupabaseState) => void) =>
		subscribeToState(
			IPC_CHANNELS.supabaseStateChanged,
			'Supabase state',
			(value) => supabaseStateSchema.safeParse(value),
			listener
		),
	runSupabaseOperation: async (operation: SupabaseOperation) => {
		const validated = supabaseOperationSchema.parse(operation);
		return supabaseOperationReceiptSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.runSupabaseOperation, validated)
		) as SupabaseOperationReceipt;
	},
	requestSupabaseConfirmation: async (operation: SupabaseOperation) => {
		const validated = supabaseOperationSchema.parse(operation);
		return supabaseConfirmationResultSchema.parse(
			await ipcRenderer.invoke(
				IPC_CHANNELS.requestSupabaseConfirmation,
				validated
			)
		) as SupabaseConfirmationResult;
	},
	setSupabaseInterest: (interest: SupabaseInterest) => {
		ipcRenderer.send(
			IPC_CHANNELS.setSupabaseInterest,
			supabaseInterestSchema.parse(interest)
		);
	},
};

contextBridge.exposeInMainWorld('rnDevtools', Object.freeze(bridge));

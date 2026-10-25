export const IPC_CHANNELS = {
	getBootstrap: 'rndevtools-desktop:get-bootstrap',
	stateChanged: 'rndevtools-desktop:state-changed',
	runAction: 'rndevtools-desktop:run-action',
	getAppearance: 'rndevtools-desktop:appearance:get',
	setAppearance: 'rndevtools-desktop:appearance:set',
	getSimulatorState: 'rndevtools-desktop:simulator:get-state',
	simulatorStateChanged: 'rndevtools-desktop:simulator:state-changed',
	refreshSimulators: 'rndevtools-desktop:simulator:refresh',
	requestSimulatorConfirmation:
		'rndevtools-desktop:simulator:request-confirmation',
	runSimulatorAction: 'rndevtools-desktop:simulator:run-action',
	cancelSimulatorJob: 'rndevtools-desktop:simulator:cancel-job',
	getSimulatorCaptureAccess: 'rndevtools-desktop:simulator:capture:get-access',
	getSimulatorCaptureRetention:
		'rndevtools-desktop:simulator:capture:get-retention',
	runSimulatorCaptureOperation:
		'rndevtools-desktop:simulator:capture:run-operation',
	runSimulatorOnboardingOperation:
		'rndevtools-desktop:simulator:onboarding:run-operation',
	getSlimmingState: 'rndevtools-desktop:slimming:get-state',
	slimmingStateChanged: 'rndevtools-desktop:slimming:state-changed',
	refreshSlimming: 'rndevtools-desktop:slimming:refresh',
	setSlimmingEnabled: 'rndevtools-desktop:slimming:set-enabled',
	acknowledgeSlimmingCompatibility:
		'rndevtools-desktop:slimming:acknowledge-compatibility',
	requestSlimmingConfirmation:
		'rndevtools-desktop:slimming:request-confirmation',
	runSlimmingAction: 'rndevtools-desktop:slimming:run-action',
	cancelSlimmingJob: 'rndevtools-desktop:slimming:cancel-job',
	getRecipeState: 'rndevtools-desktop:recipe:get-state',
	recipeStateChanged: 'rndevtools-desktop:recipe:state-changed',
	getRecipe: 'rndevtools-desktop:recipe:get',
	getRecipeEvidence: 'rndevtools-desktop:recipe:get-evidence',
	saveRecipe: 'rndevtools-desktop:recipe:save',
	requestRecipeRunConfirmation:
		'rndevtools-desktop:recipe:request-confirmation',
	runRecipe: 'rndevtools-desktop:recipe:run',
	cancelRecipeRun: 'rndevtools-desktop:recipe:cancel-run',
	runRecipeFileOperation: 'rndevtools-desktop:recipe:file-operation',
	getBuildInsightsState: 'rndevtools-desktop:build-insights:get-state',
	buildInsightsStateChanged: 'rndevtools-desktop:build-insights:state-changed',
	runBuildInsightsOperation: 'rndevtools-desktop:build-insights:run-operation',
	getLaneState: 'rndevtools-desktop:lane:get-state',
	laneStateChanged: 'rndevtools-desktop:lane:state-changed',
	runLaneOperation: 'rndevtools-desktop:lane:run-operation',
	sendSimulatorInput: 'rndevtools-desktop:simulator:send-input',
	getAgentState: 'rndevtools-desktop:agent:get-state',
	agentStateChanged: 'rndevtools-desktop:agent:state-changed',
	runAgentOperation: 'rndevtools-desktop:agent:run-operation',
	setSimulatorStreamSubscriptions:
		'rndevtools-desktop:simulator:stream:set-subscriptions',
	simulatorStreamFrame: 'rndevtools-desktop:simulator:stream:frame',
	simulatorStreamStatus: 'rndevtools-desktop:simulator:stream:status',
	getSupabaseState: 'rndevtools-desktop:supabase:get-state',
	supabaseStateChanged: 'rndevtools-desktop:supabase:state-changed',
	runSupabaseOperation: 'rndevtools-desktop:supabase:run-operation',
	requestSupabaseConfirmation:
		'rndevtools-desktop:supabase:request-confirmation',
	/** Fire and forget (`ipcRenderer.send`); main handles it with `ipcMain.on`. */
	setSupabaseInterest: 'rndevtools-desktop:supabase:set-interest',
} as const;

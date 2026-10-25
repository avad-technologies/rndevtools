import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { diagnosticErrorText } from '@rndevtools/core/redact';
import {
	app,
	BrowserWindow,
	clipboard,
	dialog,
	type IpcMainInvokeEvent,
	ipcMain,
	nativeImage,
	nativeTheme,
	net,
	protocol,
	shell,
} from 'electron';
import { agentOperationSchema } from '../shared/agent-protocol';
import { IPC_CHANNELS } from '../shared/ipc';
import {
	DEFAULT_BROKER_HOST,
	DEFAULT_BROKER_PORT,
	type DesktopBootstrap,
	desktopActionSchema,
} from '../shared/protocol';
import type {
	RecipeDefinition,
	RecipeEvidenceManifest,
	RecipeRunConfirmationResult,
	RecipeRunRequest,
	RecipeSummary,
} from '../shared/recipe-protocol';
import { recipeRunConfirmationResultSchema } from '../shared/recipe-protocol';
import { simulatorInputSchema } from '../shared/simulator-input-protocol';
import {
	SIMULATOR_CAPTURE_PROTOCOL_SCHEME,
	type SimulatorAction,
	type SimulatorActionReceipt,
	type SimulatorConfirmationResult,
	type SimulatorState,
	simulatorActionReceiptSchema,
	simulatorActionSchema,
	simulatorConfirmationResultSchema,
	simulatorJobIdSchema,
} from '../shared/simulator-protocol';
import { simulatorStreamSubscriptionsSchema } from '../shared/simulator-stream-protocol';
import {
	type SlimmingAcknowledgementReceipt,
	type SlimmingActionReceipt,
	type SlimmingConfirmationResult,
	type SlimmingConfirmationTarget,
	type SlimmingSettingReceipt,
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
} from '../shared/slimming-protocol';
import { laneDefaultBackend } from '../shared/supabase-protocol';
import { ActionConfirmationStore } from './action-confirmation-store';
import { AgentCliService } from './agent-cli-service';
import { runAgentCliSetup } from './agent-cli-setup';
import { createAgentCommandRouter } from './agent-command-router';
import { AgentService } from './agent-service';
import {
	createAppearanceIpcHandlers,
	windowChromeColors,
} from './appearance-ipc';
import { DesktopBroker } from './broker';
import { createBuildInsightsIpcHandlers } from './build-insights-ipc';
import { BuildInsightsService } from './build-insights-service';
import { BuildInsightsStore } from './build-insights-store';
import { desktopActionConfirmationCopy } from './desktop-action-confirmation';
import { DesktopSettingsStore } from './desktop-settings-store';
import { createLaneIpcHandlers } from './lane-ipc';
import { LaneService } from './lane-service';
import { LaneStore } from './lane-store';
import { verifyAgentCli } from './native-helper-trust';
import { NativeHostClient } from './native-host-client';
import { runNativePlan } from './native-plan';
import { stopForQuit } from './quit-sequence';
import { createRecipeIpcHandlers } from './recipe-ipc';
import {
	type RecipeApprovalCounts,
	recipeApprovalCounts,
} from './recipe-policy';
import { RecipeService } from './recipe-service';
import { RecipeStore } from './recipe-store';
import {
	PACKAGED_RENDERER_CONTENT_SECURITY_POLICY,
	PACKAGED_RENDERER_SCHEME,
	PACKAGED_RENDERER_URL,
	packagedRendererAssetPath,
	trustedDevelopmentRendererUrl,
	trustedLoopbackHttpUrl,
	urlsMatchWithoutHash,
} from './security';
import { SimHelperClient } from './sim-helper-client';
import { createSimulatorCaptureIpcHandlers } from './simulator-capture-ipc';
import { serveSimulatorCaptureRequest } from './simulator-capture-protocol';
import { SimulatorCaptureStore } from './simulator-capture-store';
import {
	simulatorActionNeedsConfirmation,
	simulatorConfirmationCopy,
} from './simulator-confirmation';
import { SimulatorMutationCoordinator } from './simulator-mutation-coordinator';
import {
	createSimulatorOnboardingIpcHandlers,
	validateXcodeDeveloperDirectory,
} from './simulator-onboarding-ipc';
import { SimulatorService } from './simulator-service';
import {
	createNativeImageFrameEncoder,
	SimulatorStreamService,
} from './simulator-stream-service';
import { slimmingConfirmationCopy } from './slimming-confirmation';
import { SlimmingService } from './slimming-service';
import { StagedCertificateStore } from './staged-certificate-store';
import { shouldUseSupabaseDemo } from './supabase/demo-mode';
import type {
	SupabaseAgentPort,
	SupabaseClipboardPort,
	SupabaseDialogPort,
	SupabaseLanePort,
	SupabaseServiceApi,
	SupabaseServiceDeps,
	SupabaseShellPort,
} from './supabase/service-ports';
import { createSupabaseService } from './supabase/supabase-service';
import {
	createSupabaseInterestGate,
	createSupabaseIpcHandlers,
	createSupabaseStatePublisher,
	supabaseInterestKey,
} from './supabase-ipc';

protocol.registerSchemesAsPrivileged([
	{
		scheme: PACKAGED_RENDERER_SCHEME,
		privileges: {
			codeCache: true,
			secure: true,
			standard: true,
		},
	},
	{
		scheme: SIMULATOR_CAPTURE_PROTOCOL_SCHEME,
		privileges: {
			corsEnabled: true,
			secure: true,
			standard: true,
			stream: true,
			supportFetchAPI: true,
		},
	},
]);

const brokerToken = process.env.RNDEVTOOLS_TOKEN;
const broker = new DesktopBroker({
	host: process.env.RNDEVTOOLS_BIND_ADDRESS ?? DEFAULT_BROKER_HOST,
	port: Number(process.env.RNDEVTOOLS_PORT ?? DEFAULT_BROKER_PORT),
	...(brokerToken === undefined ? {} : { token: brokerToken }),
	allowWildcardBind: process.env.RNDEVTOOLS_ALLOW_WILDCARD === 'true',
	includeDemoDevice: process.env.RNDEVTOOLS_DEMO === 'true',
});
const windows = new Set<BrowserWindow>();
const confirmationStore = new ActionConfirmationStore();
let brokerStopped = false;
let shutdownStarted = false;
let simulatorService: SimulatorService | undefined;
let slimmingService: SlimmingService | undefined;
let recipeService: RecipeService | undefined;
let agentCliService: AgentCliService | undefined;
let buildInsightsService: BuildInsightsService | undefined;
let laneService: LaneService | undefined;
let agentService: AgentService | undefined;
let simulatorStreamService: SimulatorStreamService | undefined;
let stagedCertificateStore: StagedCertificateStore | undefined;
let supabaseService: SupabaseServiceApi | undefined;
// Each window's Supabase interest counts only while it is visible; both the
// gate and the state pushes reach the service once it exists.
const supabaseInterest = createSupabaseInterestGate((senderKey, interest) =>
	supabaseService?.setInterest(senderKey, interest)
);
const supabaseStatePublisher = createSupabaseStatePublisher((state) =>
	broadcast(IPC_CHANNELS.supabaseStateChanged, state)
);

function rendererEntryUrl(): string {
	return (
		trustedDevelopmentRendererUrl(
			process.env.ELECTRON_RENDERER_URL,
			app.isPackaged
		) ?? PACKAGED_RENDERER_URL
	);
}

function registerRendererProtocol(): void {
	const rendererRoot = path.join(__dirname, '../renderer');
	protocol.handle(PACKAGED_RENDERER_SCHEME, async (request) => {
		const assetPath = packagedRendererAssetPath(rendererRoot, request.url);
		if (!assetPath) {
			return new Response('Not found', {
				headers: { 'content-type': 'text/plain; charset=utf-8' },
				status: 404,
			});
		}
		const response = await net.fetch(pathToFileURL(assetPath).href);
		if (path.extname(assetPath).toLowerCase() !== '.html') return response;
		const headers = new Headers(response.headers);
		headers.set(
			'content-security-policy',
			PACKAGED_RENDERER_CONTENT_SECURITY_POLICY
		);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	});
}

function registerSimulatorCaptureProtocol(store: SimulatorCaptureStore): void {
	protocol.handle(SIMULATOR_CAPTURE_PROTOCOL_SCHEME, (request) =>
		serveSimulatorCaptureRequest(store, request)
	);
}

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
	const senderUrl = event.senderFrame?.url ?? event.sender.getURL();
	if (!urlsMatchWithoutHash(senderUrl, rendererEntryUrl())) {
		throw new Error('Rejected IPC from an untrusted renderer.');
	}
}

/** Sends one message to every open renderer, skipping any that is gone. */
function broadcast(channel: string, ...args: unknown[]): void {
	for (const window of windows) {
		const webContents = window.webContents;
		if (webContents.isDestroyed()) continue;
		try {
			webContents.send(channel, ...args);
		} catch {
			// A renderer can disappear between the destroyed check and send.
		}
	}
}

function ownerWindow(event: IpcMainInvokeEvent): BrowserWindow | undefined {
	return BrowserWindow.fromWebContents(event.sender) ?? undefined;
}

// Each dialog is modal to the window that asked for it, when there is one.
function showMessageBox(
	owner: BrowserWindow | undefined,
	options: Electron.MessageBoxOptions
): Promise<Electron.MessageBoxReturnValue> {
	return owner
		? dialog.showMessageBox(owner, options)
		: dialog.showMessageBox(options);
}

function showOpenDialog(
	owner: BrowserWindow | undefined,
	options: Electron.OpenDialogOptions
): Promise<Electron.OpenDialogReturnValue> {
	return owner
		? dialog.showOpenDialog(owner, options)
		: dialog.showOpenDialog(options);
}

function showSaveDialog(
	owner: BrowserWindow | undefined,
	options: Electron.SaveDialogOptions
): Promise<Electron.SaveDialogReturnValue> {
	return owner
		? dialog.showSaveDialog(owner, options)
		: dialog.showSaveDialog(options);
}

/** A warning whose default is Cancel; true once the operator confirms. */
async function confirmWarning(
	event: IpcMainInvokeEvent,
	title: string,
	detail: string,
	confirmLabel: string
): Promise<boolean> {
	const result = await showMessageBox(ownerWindow(event), {
		type: 'warning',
		title,
		message: title,
		detail,
		buttons: ['Cancel', confirmLabel],
		defaultId: 0,
		cancelId: 0,
		noLink: true,
	});
	return result.response === 1;
}

async function confirmCaptureDelete(
	event: IpcMainInvokeEvent,
	capture: { name: string }
): Promise<boolean> {
	return confirmWarning(
		event,
		'Delete this capture?',
		`${capture.name} will be permanently removed from local capture storage.`,
		'Delete'
	);
}

async function selectCaptureExportDestination(
	event: IpcMainInvokeEvent,
	capture: { mimeType: string; name: string }
): Promise<string | undefined> {
	const extensions =
		capture.mimeType === 'image/png'
			? ['png']
			: capture.mimeType === 'image/jpeg'
				? ['jpeg', 'jpg']
				: ['mp4'];
	const result = await showSaveDialog(ownerWindow(event), {
		title: 'Export Simulator capture',
		buttonLabel: 'Export',
		defaultPath: capture.name,
		filters: [{ name: 'Simulator capture', extensions }],
	});
	return result.canceled ? undefined : result.filePath;
}

async function confirmCaptureRetentionUpdate(
	event: IpcMainInvokeEvent,
	policy: { maxAgeDays: number; maxTotalBytes: number },
	current: { captureCount: number }
): Promise<boolean> {
	const gibibytes = policy.maxTotalBytes / (1024 * 1024 * 1024);
	return confirmWarning(
		event,
		'Update capture retention?',
		`Captures older than ${policy.maxAgeDays} day${policy.maxAgeDays === 1 ? '' : 's'} or beyond ${gibibytes.toFixed(1)} GiB will be removed immediately. ${current.captureCount} capture${current.captureCount === 1 ? '' : 's'} are currently stored.`,
		'Update Retention'
	);
}

async function confirmSimulatorAction(
	event: IpcMainInvokeEvent,
	action: SimulatorAction,
	target: { name: string; udid: string },
	certificate?: { sha256: string; sizeBytes: number; subject?: string }
): Promise<boolean> {
	const copy = simulatorConfirmationCopy(action, target, certificate);
	if (!copy) return true;
	return confirmWarning(event, copy.title, copy.detail, 'Continue');
}

async function confirmSlimmingTarget(
	event: IpcMainInvokeEvent,
	target: SlimmingConfirmationTarget
): Promise<boolean> {
	const copy = slimmingConfirmationCopy(target);
	if (!copy) return true;
	return confirmWarning(event, copy.title, copy.detail, 'Continue');
}

/** How the run approval dialog names each kind of privileged recipe step. */
const RECIPE_APPROVAL_STEP_NOUNS: Record<keyof RecipeApprovalCounts, string> = {
	mutations: 'experimental SimSlim mutation step',
	sensitiveResets: 'sensitive reset step',
	restorePointChanges: 'restore-point restore/removal step',
};

async function requestRecipeRunConfirmation(
	event: IpcMainInvokeEvent,
	request: RecipeRunRequest,
	recipe: RecipeDefinition
): Promise<RecipeRunConfirmationResult> {
	const counts = recipeApprovalCounts(recipe);
	const title =
		counts.mutations > 0
			? 'Run a privileged experimental Simulator recipe?'
			: 'Run a privileged Simulator recipe?';
	const actionDescription = (
		Object.keys(RECIPE_APPROVAL_STEP_NOUNS) as (keyof RecipeApprovalCounts)[]
	)
		.filter((kind) => counts[kind] > 0)
		.map(
			(kind) =>
				`${counts[kind]} ${RECIPE_APPROVAL_STEP_NOUNS[kind]}${counts[kind] === 1 ? '' : 's'}`
		)
		.join(' and ');
	const confirmed = await confirmWarning(
		event,
		title,
		`${recipe.name} revision ${recipe.revision} contains ${actionDescription} and targets these exact Simulator UDIDs: ${request.targetUdids.join(', ')}. ${counts.mutations > 0 ? 'SimSlim mutations remain serialized and verified by the signed helper.' : 'Sensitive resets will run only after this one-time exact confirmation.'}`,
		'Run Recipe'
	);
	if (!confirmed) {
		return recipeRunConfirmationResultSchema.parse({
			actionId: request.actionId,
			required: true,
			confirmed: false,
			error: 'Recipe run cancelled by the operator.',
		});
	}
	const confirmation = confirmationStore.issue('recipe', event.sender.id, {
		...request,
		recipeRevision: recipe.revision,
	});
	return recipeRunConfirmationResultSchema.parse({
		actionId: request.actionId,
		required: true,
		confirmed: true,
		token: confirmation.token,
		expiresAt: confirmation.expiresAt,
	});
}

async function confirmRecipeDelete(
	event: IpcMainInvokeEvent,
	recipe: RecipeSummary
): Promise<boolean> {
	return confirmWarning(
		event,
		'Delete this recipe?',
		`${recipe.name} revision ${recipe.revision} will be permanently removed. Existing run evidence remains in local history.`,
		'Delete'
	);
}

async function selectRecipeImportPath(
	event: IpcMainInvokeEvent
): Promise<string | undefined> {
	const result = await showOpenDialog(ownerWindow(event), {
		title: 'Import recipe',
		buttonLabel: 'Import',
		properties: ['openFile'],
		filters: [{ name: 'Recipe JSON', extensions: ['json'] }],
	});
	return result.canceled ? undefined : result.filePaths[0];
}

async function selectRecipeExportDestination(
	event: IpcMainInvokeEvent,
	recipe: RecipeDefinition
): Promise<string | undefined> {
	const result = await showSaveDialog(ownerWindow(event), {
		title: 'Export recipe',
		buttonLabel: 'Export',
		defaultPath: `${recipe.id}.rndevtools-recipe.json`,
		filters: [{ name: 'Recipe JSON', extensions: ['json'] }],
	});
	return result.canceled ? undefined : result.filePath;
}

async function selectEvidenceExportDestination(
	event: IpcMainInvokeEvent,
	evidence: RecipeEvidenceManifest
): Promise<string | undefined> {
	const result = await showSaveDialog(ownerWindow(event), {
		title: 'Export evidence manifest',
		buttonLabel: 'Export',
		defaultPath: `${evidence.id}.rndevtools-evidence.json`,
		filters: [{ name: 'Evidence JSON', extensions: ['json'] }],
	});
	return result.canceled ? undefined : result.filePath;
}

async function selectBuildInsightsSource(
	event: IpcMainInvokeEvent,
	kind: 'derived-data-root' | 'xcresult'
): Promise<string | undefined> {
	const result = await showOpenDialog(ownerWindow(event), {
		title:
			kind === 'xcresult'
				? 'Import an Xcode result bundle'
				: 'Watch a DerivedData directory',
		buttonLabel: kind === 'xcresult' ? 'Import Result' : 'Watch Directory',
		properties: ['openDirectory'],
	});
	return result.canceled ? undefined : result.filePaths[0];
}

async function selectLaneRepository(
	event: IpcMainInvokeEvent
): Promise<string | undefined> {
	const result = await showOpenDialog(ownerWindow(event), {
		title: 'Track a repository for lanes',
		message:
			'Choose a git checkout. Its worktrees become available as lane targets.',
		buttonLabel: 'Track Repository',
		properties: ['openDirectory'],
	});
	return result.canceled ? undefined : result.filePaths[0];
}

async function selectBuildInsightsExportDestination(
	event: IpcMainInvokeEvent,
	format: 'csv' | 'json'
): Promise<string | undefined> {
	const extension = format === 'csv' ? 'csv' : 'json';
	const result = await showSaveDialog(ownerWindow(event), {
		title: 'Export local Build Insights',
		buttonLabel: 'Export',
		defaultPath: `rndevtools-build-insights.${extension}`,
		filters: [
			{
				name:
					format === 'csv' ? 'Comma-separated values' : 'Build Insights JSON',
				extensions: [extension],
			},
		],
	});
	return result.canceled ? undefined : result.filePath;
}

async function selectXcodeApplication(
	event: IpcMainInvokeEvent
): Promise<string | undefined> {
	const result = await showOpenDialog(ownerWindow(event), {
		title: 'Choose an Xcode application',
		buttonLabel: 'Use Xcode',
		properties: ['openFile'],
		filters: [{ name: 'Xcode application', extensions: ['app'] }],
	});
	return result.canceled ? undefined : result.filePaths[0];
}

async function selectSimulatorInput(
	event: IpcMainInvokeEvent,
	action: SimulatorAction
): Promise<string | undefined> {
	let options: Electron.OpenDialogOptions | undefined;
	if (action.kind === 'app.install') {
		options = {
			title: 'Select a Simulator application',
			buttonLabel: 'Install',
			properties: ['openFile'],
			filters: [{ name: 'iOS Simulator application', extensions: ['app'] }],
		};
	} else if (action.kind === 'keychain.addCertificate') {
		options = {
			title: 'Select a certificate',
			buttonLabel: 'Add Certificate',
			properties: ['openFile'],
			filters: [
				{ name: 'Certificates', extensions: ['cer', 'crt', 'der', 'pem'] },
			],
		};
	} else if (action.kind === 'location.importGpx') {
		options = {
			title: 'Select a GPX route',
			buttonLabel: 'Import Route',
			properties: ['openFile'],
			filters: [{ name: 'GPS Exchange Format', extensions: ['gpx'] }],
		};
	}
	if (!options) return undefined;
	const result = await showOpenDialog(ownerWindow(event), options);
	return result.canceled ? undefined : result.filePaths[0];
}

function windowForSender(senderId: number): BrowserWindow | undefined {
	for (const window of windows) {
		if (!window.isDestroyed() && window.webContents.id === senderId) {
			return window;
		}
	}
	return undefined;
}

/** Electron's dialogs for the Supabase service, modal to the asking window. */
const supabaseDialog: SupabaseDialogPort = {
	showMessageBox: async (options, owner) => {
		const window = owner ? windowForSender(owner.senderId) : undefined;
		const messageBox: Electron.MessageBoxOptions = {
			...options,
			buttons: [...options.buttons],
		};
		const result = await showMessageBox(window, messageBox);
		return {
			response: result.response,
			checkboxChecked: result.checkboxChecked,
		};
	},
	showSaveDialog: async (options, owner) => {
		const window = owner ? windowForSender(owner.senderId) : undefined;
		const save: Electron.SaveDialogOptions = {
			title: options.title,
			buttonLabel: options.buttonLabel,
			defaultPath: options.defaultPath,
			filters: options.filters.map((filter) => ({
				name: filter.name,
				extensions: [...filter.extensions],
			})),
		};
		const result = await showSaveDialog(window, save);
		return result.canceled || !result.filePath
			? { canceled: true }
			: { canceled: false, filePath: result.filePath };
	},
	showOpenDialog: async (options, owner) => {
		const window = owner ? windowForSender(owner.senderId) : undefined;
		const open: Electron.OpenDialogOptions = {
			title: options.title,
			buttonLabel: options.buttonLabel,
			properties: [...options.properties],
			...(options.defaultPath === undefined
				? {}
				: { defaultPath: options.defaultPath }),
		};
		const result = await showOpenDialog(window, open);
		return { canceled: result.canceled, filePaths: result.filePaths };
	},
};

const supabaseShell: SupabaseShellPort = {
	// Mailpit and Studio only: loopback http, never another host or scheme.
	openExternal: async (url) => {
		const trusted = trustedLoopbackHttpUrl(url);
		if (!trusted) {
			throw new Error('Only loopback http addresses open outside RN Devtools.');
		}
		await shell.openExternal(trusted);
	},
	// Paths come from the service's own records; the renderer never names one.
	showItemInFolder: (itemPath) => {
		if (!path.isAbsolute(itemPath) || itemPath.includes('\0')) {
			throw new Error('Only an absolute path can be revealed in Finder.');
		}
		shell.showItemInFolder(itemPath);
	},
};

// The service compares what it reads back before clearing, so a delayed clear
// never wipes something the user copied since.
const supabaseClipboard: SupabaseClipboardPort = {
	writeText: (text) => clipboard.writeText(text),
	readText: () => clipboard.readText(),
};

function supabaseLanePort(lanes: LaneService): SupabaseLanePort {
	return {
		lanes: () => lanes.getState().lanes,
		laneById: (laneId) =>
			lanes.getState().lanes.find((lane) => lane.id === laneId),
		worktrees: () => lanes.getState().worktrees,
		repositories: () => lanes.getState().repositories,
		restartMetro: (laneId, reason) => lanes.restartMetro(laneId, reason),
		launchDeferred: (laneId) => lanes.launchDeferred(laneId),
		subscribe: (listener) => lanes.subscribe(() => listener()),
	};
}

function supabaseAgentPort(agents: AgentService): SupabaseAgentPort {
	return {
		sessions: () => agents.getState().sessions,
		holderLiveness: (holder, directory) =>
			agents.holderLiveness(holder, directory),
		discovery: () => {
			const { claude, codex } = agents.getState().discovery;
			return { claude, codex };
		},
		subscribe: (listener) => agents.subscribe(() => listener()),
	};
}

function supabasePlatform(): SupabaseServiceDeps['platform'] {
	return {
		platform: process.platform,
		arch: process.arch,
		macosVersion:
			process.platform === 'darwin' ? process.getSystemVersion() : undefined,
	};
}

function registerSupabaseIpc(service: SupabaseServiceApi): void {
	const handlers = createSupabaseIpcHandlers({
		service: {
			getState: () => service.getState(),
			runOperation: (operation, context) =>
				service.runOperation(operation, context),
			describeConfirmation: (operation) =>
				service.describeConfirmation(operation),
			setInterest: supabaseInterest.setInterest,
		},
		confirmations: confirmationStore,
		showConfirmationDialog: supabaseDialog.showMessageBox,
		assertTrustedSender: assertTrustedRenderer,
		now: Date.now,
	});
	ipcMain.handle(IPC_CHANNELS.getSupabaseState, handlers.getState);
	ipcMain.handle(IPC_CHANNELS.runSupabaseOperation, handlers.runOperation);
	ipcMain.handle(
		IPC_CHANNELS.requestSupabaseConfirmation,
		handlers.requestConfirmation
	);
	ipcMain.on(IPC_CHANNELS.setSupabaseInterest, handlers.setInterest);
}

function rejectedSimulatorAction(
	action: SimulatorAction,
	error: string
): SimulatorActionReceipt {
	return simulatorActionReceiptSchema.parse({
		actionId: action.actionId,
		accepted: false,
		error,
	});
}

function registerIpc(
	simulator: SimulatorService,
	slimming: SlimmingService,
	recipes: RecipeService,
	buildInsights: BuildInsightsService,
	lanes: LaneService,
	nativeHost: NativeHostClient,
	certificates: StagedCertificateStore,
	nativeResourceDirectory: string,
	settings: DesktopSettingsStore
): void {
	const captureHandlers = createSimulatorCaptureIpcHandlers({
		service: simulator,
		assertTrustedRenderer,
		confirmDelete: confirmCaptureDelete,
		confirmRetentionUpdate: confirmCaptureRetentionUpdate,
		selectExportDestination: selectCaptureExportDestination,
		revealPath: (capturePath) => shell.showItemInFolder(capturePath),
	});
	const recipeHandlers = createRecipeIpcHandlers({
		service: recipes,
		assertTrustedRenderer,
		requestRunConfirmation: requestRecipeRunConfirmation,
		consumeRunConfirmation: (event, request, recipe) =>
			confirmationStore.consume(
				'recipe',
				event.sender.id,
				{ ...request, recipeRevision: recipe.revision },
				request.confirmationToken
			),
		confirmDelete: confirmRecipeDelete,
		selectImportPath: selectRecipeImportPath,
		selectRecipeExportDestination,
		selectEvidenceExportDestination,
	});
	const buildInsightsHandlers = createBuildInsightsIpcHandlers({
		service: buildInsights,
		assertTrustedRenderer,
		selectXcresult: (event) => selectBuildInsightsSource(event, 'xcresult'),
		selectWatchRoot: (event) =>
			selectBuildInsightsSource(event, 'derived-data-root'),
		selectExportDestination: selectBuildInsightsExportDestination,
	});
	const laneHandlers = createLaneIpcHandlers({
		service: lanes,
		assertTrustedRenderer,
		selectRepository: selectLaneRepository,
	});
	const simulatorOnboardingHandlers = createSimulatorOnboardingIpcHandlers({
		assertTrustedRenderer,
		selectXcodeApplication,
		activateXcodeDeveloperDirectory: async (developerDirectory) => {
			await settings.setXcodeDeveloperDirectory(developerDirectory);
			process.env.DEVELOPER_DIR = developerDirectory;
			await simulator.rediscover();
		},
		openPrivacySettings: async (permission) => {
			const pane = {
				screen_recording: 'Privacy_ScreenCapture',
				accessibility: 'Privacy_Accessibility',
				camera: 'Privacy_Camera',
				microphone: 'Privacy_Microphone',
			}[permission];
			await shell.openExternal(
				`x-apple.systempreferences:com.apple.preference.security?${pane}`
			);
		},
		revealAgentCli: async () => {
			const cli = await verifyAgentCli({
				resourceDirectory: nativeResourceDirectory,
				appVersion: app.getVersion(),
			});
			shell.showItemInFolder(cli.executablePath);
		},
		setupAgentCli: async () => {
			// The verified CLI edits the operator's own agent configuration; the
			// desktop only launches it and relays its report. Mutations stay in
			// the Go code, which is tested against each file format.
			const cli = await verifyAgentCli({
				resourceDirectory: nativeResourceDirectory,
				appVersion: app.getVersion(),
			});
			return runAgentCliSetup(cli.executablePath, app.getPath('home'));
		},
	});
	const appearanceHandlers = createAppearanceIpcHandlers({
		assertTrustedRenderer,
		readAppearance: () => settings.appearance,
		saveAppearance: (preference) => settings.setAppearance(preference),
		applyAppearance: (preference) => {
			nativeTheme.themeSource = preference;
		},
	});
	ipcMain.handle(IPC_CHANNELS.getAppearance, appearanceHandlers.getAppearance);
	ipcMain.handle(IPC_CHANNELS.setAppearance, appearanceHandlers.setAppearance);
	ipcMain.handle(IPC_CHANNELS.getBootstrap, (event): DesktopBootstrap => {
		assertTrustedRenderer(event);
		return {
			state: broker.getState(),
			platform: process.platform,
			versions: {
				app: app.getVersion(),
				electron: process.versions.electron,
				chrome: process.versions.chrome,
				node: process.versions.node,
			},
		};
	});
	ipcMain.handle(IPC_CHANNELS.runAction, async (event, value: unknown) => {
		assertTrustedRenderer(event);
		const action = desktopActionSchema.parse(value);
		const confirmation = desktopActionConfirmationCopy(action);
		if (confirmation) {
			const result = await showMessageBox(ownerWindow(event), {
				type: confirmation.destructive ? 'warning' : 'question',
				title: confirmation.title,
				message: confirmation.message,
				detail: confirmation.detail,
				buttons: ['Cancel', confirmation.confirmLabel],
				defaultId: 0,
				cancelId: 0,
				noLink: true,
			});
			if (result.response !== 1) {
				return {
					actionId: action.actionId,
					ok: false,
					error: 'Action cancelled by the desktop operator.',
				};
			}
		}
		return broker.dispatchAction(action);
	});
	ipcMain.handle(IPC_CHANNELS.getSimulatorState, (event): SimulatorState => {
		assertTrustedRenderer(event);
		return simulator.getState();
	});
	ipcMain.handle(IPC_CHANNELS.refreshSimulators, async (event) => {
		assertTrustedRenderer(event);
		await Promise.all([simulator.refresh(), simulator.refreshNative()]);
		return simulator.refreshMetrics();
	});
	ipcMain.handle(
		IPC_CHANNELS.requestSimulatorConfirmation,
		async (event, value: unknown): Promise<SimulatorConfirmationResult> => {
			assertTrustedRenderer(event);
			const action = simulatorActionSchema.parse(value);
			if (action.confirmationToken) {
				return simulatorConfirmationResultSchema.parse({
					actionId: action.actionId,
					required: simulatorActionNeedsConfirmation(action),
					confirmed: false,
					error: 'Confirmation requests cannot reuse an existing token.',
				});
			}
			if (!simulatorActionNeedsConfirmation(action)) {
				return simulatorConfirmationResultSchema.parse({
					actionId: action.actionId,
					required: false,
					confirmed: true,
				});
			}
			if (!('udid' in action)) {
				return simulatorConfirmationResultSchema.parse({
					actionId: action.actionId,
					required: true,
					confirmed: false,
					error:
						'The destructive action does not identify an exact Simulator target.',
				});
			}
			let stagedCertificate:
				| Awaited<ReturnType<StagedCertificateStore['stage']>>
				| undefined;
			try {
				if (action.kind === 'keychain.addCertificate' && action.trustRoot) {
					const selectedPath = await selectSimulatorInput(event, action);
					if (!selectedPath) {
						return simulatorConfirmationResultSchema.parse({
							actionId: action.actionId,
							required: true,
							confirmed: false,
							error: 'File selection was cancelled.',
						});
					}
					stagedCertificate = await certificates.stage(
						selectedPath,
						event.sender.id
					);
					if (event.sender.isDestroyed()) {
						await stagedCertificate.cleanup();
						return simulatorConfirmationResultSchema.parse({
							actionId: action.actionId,
							required: true,
							confirmed: false,
							error: 'The requesting desktop window was closed.',
						});
					}
				}
				const target = await simulator.resolveConfirmationTarget(action.udid);
				if (
					!(await confirmSimulatorAction(
						event,
						action,
						target,
						stagedCertificate?.identity
					))
				) {
					await stagedCertificate?.cleanup();
					return simulatorConfirmationResultSchema.parse({
						actionId: action.actionId,
						required: true,
						confirmed: false,
						error: 'Action cancelled by the operator.',
					});
				}
				const confirmationTarget = {
					action,
					target,
					...(stagedCertificate
						? { certificate: stagedCertificate.identity }
						: {}),
				};
				const confirmation = confirmationStore.issue(
					'simulator',
					event.sender.id,
					confirmationTarget
				);
				if (action.kind === 'keychain.addCertificate' && stagedCertificate) {
					certificates.bind(
						confirmation.token,
						event.sender.id,
						action,
						stagedCertificate
					);
				}
				return simulatorConfirmationResultSchema.parse({
					actionId: action.actionId,
					required: true,
					confirmed: true,
					token: confirmation.token,
					expiresAt: confirmation.expiresAt,
				});
			} catch (error) {
				await stagedCertificate?.cleanup();
				return simulatorConfirmationResultSchema.parse({
					actionId: action.actionId,
					required: true,
					confirmed: false,
					error: diagnosticErrorText(error).slice(0, 512),
				});
			}
		}
	);
	ipcMain.handle(
		IPC_CHANNELS.runSimulatorAction,
		async (event, value: unknown): Promise<SimulatorActionReceipt> => {
			assertTrustedRenderer(event);
			const action = simulatorActionSchema.parse(value);
			let stagedCertificate:
				| Awaited<ReturnType<StagedCertificateStore['stage']>>
				| undefined;
			if (simulatorActionNeedsConfirmation(action)) {
				if (!('udid' in action)) {
					return rejectedSimulatorAction(
						action,
						'The destructive action does not identify an exact Simulator target.'
					);
				}
				if (action.kind === 'keychain.addCertificate' && action.trustRoot) {
					stagedCertificate = await certificates.claim(
						action.confirmationToken,
						event.sender.id,
						action
					);
				}
				let target: { name: string; udid: string };
				try {
					target = await simulator.resolveConfirmationTarget(action.udid);
				} catch {
					await stagedCertificate?.cleanup();
					return rejectedSimulatorAction(
						action,
						'The exact Simulator target is no longer present in the fresh inventory.'
					);
				}
				const confirmationTarget = {
					action,
					target,
					...(stagedCertificate
						? { certificate: stagedCertificate.identity }
						: action.kind === 'keychain.addCertificate'
							? { certificate: null }
							: {}),
				};
				if (
					!confirmationStore.consume(
						'simulator',
						event.sender.id,
						confirmationTarget,
						action.confirmationToken
					)
				) {
					await stagedCertificate?.cleanup();
					return rejectedSimulatorAction(
						action,
						'A fresh, exact action confirmation is required.'
					);
				}
			}
			let selectedPath: string | undefined;
			try {
				selectedPath = stagedCertificate
					? undefined
					: await selectSimulatorInput(event, action);
			} catch (error) {
				await stagedCertificate?.cleanup();
				throw error;
			}
			if (
				(action.kind === 'app.install' ||
					action.kind === 'keychain.addCertificate' ||
					action.kind === 'location.importGpx') &&
				!selectedPath &&
				!stagedCertificate
			) {
				return rejectedSimulatorAction(action, 'File selection was cancelled.');
			}
			let rawReceipt: SimulatorActionReceipt;
			try {
				rawReceipt = simulator.runAction(action, {
					...(stagedCertificate
						? { materializeCertificatePath: stagedCertificate.materialize }
						: {}),
					...(selectedPath ? { selectedPath } : {}),
					...(stagedCertificate
						? { cleanupSelectedInput: stagedCertificate.cleanup }
						: {}),
				});
			} catch (error) {
				await stagedCertificate?.cleanup();
				throw error;
			}
			const receipt = simulatorActionReceiptSchema.parse(rawReceipt);
			if (!receipt.accepted) await stagedCertificate?.cleanup();
			return receipt;
		}
	);
	ipcMain.handle(IPC_CHANNELS.cancelSimulatorJob, (event, value: unknown) => {
		assertTrustedRenderer(event);
		return simulator.cancelJob(simulatorJobIdSchema.parse(value));
	});
	ipcMain.handle(
		IPC_CHANNELS.getSimulatorCaptureAccess,
		captureHandlers.getAccess
	);
	ipcMain.handle(
		IPC_CHANNELS.getSimulatorCaptureRetention,
		captureHandlers.getRetention
	);
	ipcMain.handle(
		IPC_CHANNELS.runSimulatorCaptureOperation,
		captureHandlers.runOperation
	);
	ipcMain.handle(
		IPC_CHANNELS.runSimulatorOnboardingOperation,
		simulatorOnboardingHandlers.runOperation
	);
	ipcMain.handle(IPC_CHANNELS.getSlimmingState, (event): SlimmingState => {
		assertTrustedRenderer(event);
		return slimming.getState();
	});
	ipcMain.handle(IPC_CHANNELS.refreshSlimming, async (event) => {
		assertTrustedRenderer(event);
		return slimming.refresh();
	});
	ipcMain.handle(
		IPC_CHANNELS.requestSlimmingConfirmation,
		async (event, value: unknown): Promise<SlimmingConfirmationResult> => {
			assertTrustedRenderer(event);
			const target = slimmingConfirmationTargetSchema.parse(value);
			if ('confirmationToken' in target && target.confirmationToken) {
				return slimmingConfirmationResultSchema.parse({
					actionId: target.actionId,
					required: Boolean(slimmingConfirmationCopy(target)),
					confirmed: false,
					error: 'Confirmation requests cannot reuse an existing token.',
				});
			}
			if (!slimmingConfirmationCopy(target)) {
				return slimmingConfirmationResultSchema.parse({
					actionId: target.actionId,
					required: false,
					confirmed: true,
				});
			}
			if (!(await confirmSlimmingTarget(event, target))) {
				return slimmingConfirmationResultSchema.parse({
					actionId: target.actionId,
					required: true,
					confirmed: false,
					error: 'Action cancelled by the operator.',
				});
			}
			const confirmation = confirmationStore.issue(
				'slimming',
				event.sender.id,
				target
			);
			return slimmingConfirmationResultSchema.parse({
				actionId: target.actionId,
				required: true,
				confirmed: true,
				token: confirmation.token,
				expiresAt: confirmation.expiresAt,
			});
		}
	);
	ipcMain.handle(
		IPC_CHANNELS.setSlimmingEnabled,
		async (event, value: unknown): Promise<SlimmingSettingReceipt> => {
			assertTrustedRenderer(event);
			const request = slimmingSettingRequestSchema.parse(value);
			if (
				!request.enabled &&
				request.disposition === 'restore-and-verify' &&
				!confirmationStore.consume(
					'slimming',
					event.sender.id,
					request,
					request.confirmationToken
				)
			) {
				return slimmingSettingReceiptSchema.parse({
					actionId: request.actionId,
					accepted: false,
					state: slimming.getState(),
					error: 'A fresh, exact restore confirmation is required.',
				});
			}
			return slimmingSettingReceiptSchema.parse(
				await slimming.setEnabled(request)
			);
		}
	);
	ipcMain.handle(
		IPC_CHANNELS.acknowledgeSlimmingCompatibility,
		async (event, value: unknown): Promise<SlimmingAcknowledgementReceipt> => {
			assertTrustedRenderer(event);
			const request = slimmingAcknowledgementRequestSchema.parse(value);
			return slimmingAcknowledgementReceiptSchema.parse(
				await slimming.acknowledgeCompatibility(request)
			);
		}
	);
	ipcMain.handle(
		IPC_CHANNELS.runSlimmingAction,
		(event, value: unknown): SlimmingActionReceipt => {
			assertTrustedRenderer(event);
			const action = slimmingActionSchema.parse(value);
			if (
				slimmingConfirmationCopy(action) &&
				!confirmationStore.consume(
					'slimming',
					event.sender.id,
					action,
					action.confirmationToken
				)
			) {
				return slimmingActionReceiptSchema.parse({
					actionId: action.actionId,
					accepted: false,
					error: 'A fresh, exact action confirmation is required.',
				});
			}
			return slimmingActionReceiptSchema.parse(slimming.runAction(action));
		}
	);
	ipcMain.handle(IPC_CHANNELS.cancelSlimmingJob, (event, value: unknown) => {
		assertTrustedRenderer(event);
		return slimming.cancelJob(slimmingJobIdSchema.parse(value));
	});
	ipcMain.handle(IPC_CHANNELS.getRecipeState, recipeHandlers.getState);
	ipcMain.handle(IPC_CHANNELS.getRecipe, recipeHandlers.getRecipe);
	ipcMain.handle(IPC_CHANNELS.getRecipeEvidence, recipeHandlers.getEvidence);
	ipcMain.handle(IPC_CHANNELS.saveRecipe, recipeHandlers.saveRecipe);
	ipcMain.handle(
		IPC_CHANNELS.requestRecipeRunConfirmation,
		recipeHandlers.requestRunConfirmation
	);
	ipcMain.handle(IPC_CHANNELS.runRecipe, recipeHandlers.runRecipe);
	ipcMain.handle(IPC_CHANNELS.cancelRecipeRun, recipeHandlers.cancelRun);
	ipcMain.handle(
		IPC_CHANNELS.runRecipeFileOperation,
		recipeHandlers.runFileOperation
	);
	ipcMain.handle(
		IPC_CHANNELS.getBuildInsightsState,
		buildInsightsHandlers.getState
	);
	ipcMain.handle(
		IPC_CHANNELS.runBuildInsightsOperation,
		buildInsightsHandlers.runOperation
	);
	ipcMain.handle(IPC_CHANNELS.getLaneState, laneHandlers.getState);
	ipcMain.handle(IPC_CHANNELS.runLaneOperation, laneHandlers.runOperation);
	ipcMain.handle(
		IPC_CHANNELS.sendSimulatorInput,
		async (event, value: unknown) => {
			assertTrustedRenderer(event);
			return nativeHost.sendSimulatorInput(simulatorInputSchema.parse(value));
		}
	);
	ipcMain.handle(IPC_CHANNELS.getAgentState, (event) => {
		assertTrustedRenderer(event);
		if (!agentService) throw new Error('Agents are not available.');
		return agentService.getState();
	});
	ipcMain.handle(
		IPC_CHANNELS.runAgentOperation,
		async (event, value: unknown) => {
			assertTrustedRenderer(event);
			if (!agentService) throw new Error('Agents are not available.');
			return agentService.runOperation(agentOperationSchema.parse(value));
		}
	);
	ipcMain.handle(
		IPC_CHANNELS.setSimulatorStreamSubscriptions,
		async (event, value: unknown) => {
			assertTrustedRenderer(event);
			await simulatorStreamService?.setSubscriptions(
				simulatorStreamSubscriptionsSchema.parse(value)
			);
		}
	);
}

function updateSimulatorPolling(): void {
	const visible = [...windows].some(
		(window) =>
			!window.isDestroyed() && window.isVisible() && !window.isMinimized()
	);
	simulatorService?.setPollingActive(visible);
	slimmingService?.setPollingActive(visible);
	agentService?.setPollingActive(visible);
	// Live screens are the most expensive poller; they also stop when every
	// window is merely unfocused, not just hidden.
	const focused = [...windows].some(
		(window) => !window.isDestroyed() && window.isFocused()
	);
	simulatorStreamService?.setPaused(!(visible && focused));
}

/** Repaints the native window colours when the theme changes. */
function updateWindowChrome(): void {
	const chrome = windowChromeColors(nativeTheme.shouldUseDarkColors);
	for (const window of windows) {
		if (window.isDestroyed()) continue;
		window.setBackgroundColor(chrome.background);
		if (process.platform !== 'darwin') {
			window.setTitleBarOverlay({
				color: chrome.titleBar,
				symbolColor: chrome.titleBarSymbol,
			});
		}
	}
}

function createWindow(): BrowserWindow {
	const chrome = windowChromeColors(nativeTheme.shouldUseDarkColors);
	const window = new BrowserWindow({
		width: 1480,
		height: 940,
		minWidth: 1040,
		minHeight: 700,
		show: false,
		backgroundColor: chrome.background,
		title: 'RN Devtools',
		titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
		// Centers the 12px traffic lights in the 48px titlebar the renderer draws.
		trafficLightPosition: { x: 16, y: 18 },
		titleBarOverlay:
			process.platform === 'darwin'
				? false
				: {
						color: chrome.titleBar,
						symbolColor: chrome.titleBarSymbol,
						height: 48,
					},
		webPreferences: {
			preload: path.join(__dirname, '../preload/index.js'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webSecurity: true,
			allowRunningInsecureContent: false,
			devTools: !app.isPackaged,
			navigateOnDragDrop: false,
			safeDialogs: true,
			spellcheck: false,
			webviewTag: false,
		},
	});
	windows.add(window);
	window.on('closed', () => {
		windows.delete(window);
		updateSimulatorPolling();
	});
	window.on('show', updateSimulatorPolling);
	window.on('hide', updateSimulatorPolling);
	window.on('focus', updateSimulatorPolling);
	window.on('blur', updateSimulatorPolling);
	window.on('minimize', updateSimulatorPolling);
	window.on('restore', updateSimulatorPolling);
	const senderId = window.webContents.id;
	stagedCertificateStore?.registerSender(senderId);
	// A hidden or minimized window has no Supabase interest; its last one comes
	// back when it is shown again.
	const supabaseKey = supabaseInterestKey(senderId);
	const updateSupabaseInterest = () =>
		supabaseInterest.setVisible(
			supabaseKey,
			!window.isDestroyed() && window.isVisible() && !window.isMinimized()
		);
	updateSupabaseInterest();
	window.on('show', updateSupabaseInterest);
	window.on('hide', updateSupabaseInterest);
	window.on('minimize', updateSupabaseInterest);
	window.on('restore', updateSupabaseInterest);
	window.webContents.once('destroyed', () => {
		confirmationStore.revokeSender(senderId);
		void stagedCertificateStore?.revokeSender(senderId);
		supabaseInterest.drop(supabaseKey);
	});
	window.once('ready-to-show', () => window.show());
	window.webContents.session.setPermissionRequestHandler(
		(webContents, permission, callback, details) => {
			callback(
				webContents === window.webContents &&
					details.isMainFrame &&
					urlsMatchWithoutHash(details.requestingUrl, rendererEntryUrl()) &&
					permission === 'clipboard-sanitized-write'
			);
		}
	);
	window.webContents.session.setPermissionCheckHandler(
		(webContents, permission, _requestingOrigin, details) =>
			webContents === window.webContents &&
			details.isMainFrame &&
			details.requestingUrl !== undefined &&
			urlsMatchWithoutHash(details.requestingUrl, rendererEntryUrl()) &&
			permission === 'clipboard-sanitized-write'
	);

	window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
	window.webContents.on('will-attach-webview', (event) =>
		event.preventDefault()
	);
	window.webContents.on('will-navigate', (event, url) => {
		if (!urlsMatchWithoutHash(url, rendererEntryUrl())) event.preventDefault();
	});
	window.webContents.on('will-redirect', (event, url) => {
		if (!urlsMatchWithoutHash(url, rendererEntryUrl())) event.preventDefault();
	});

	const rendererLoad = window.loadURL(rendererEntryUrl());
	void rendererLoad.catch((error: unknown) => {
		dialog.showErrorBox(
			'RN Devtools renderer could not load',
			diagnosticErrorText(error).slice(0, 8 * 1024)
		);
		if (!window.isDestroyed()) window.destroy();
		app.quit();
	});
	return window;
}

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on('second-instance', () => {
		const window = BrowserWindow.getAllWindows()[0];
		if (!window) return;
		if (window.isMinimized()) window.restore();
		window.focus();
	});

	void app
		.whenReady()
		.then(async () => {
			nativeTheme.on('updated', updateWindowChrome);
			if (
				!trustedDevelopmentRendererUrl(
					process.env.ELECTRON_RENDERER_URL,
					app.isPackaged
				)
			) {
				registerRendererProtocol();
			}
			const settings = new DesktopSettingsStore(
				path.join(app.getPath('userData'), 'desktop-settings')
			);
			try {
				const storedSettings = await settings.load();
				// Set before any window exists: the renderer's `color-scheme`
				// follows it, so the first frame is already in the right theme.
				nativeTheme.themeSource = settings.appearance;
				if (storedSettings.xcodeDeveloperDirectory) {
					try {
						process.env.DEVELOPER_DIR = await validateXcodeDeveloperDirectory(
							storedSettings.xcodeDeveloperDirectory
						);
					} catch {
						await settings.setXcodeDeveloperDirectory(undefined);
					}
				}
			} catch {
				// Malformed settings fail closed without replacing caller-supplied toolchain state.
			}
			const nativeResourceDirectory = app.isPackaged
				? path.join(process.resourcesPath, 'native')
				: path.join(app.getAppPath(), 'build', 'native', `mac-${process.arch}`);
			const captureStore = new SimulatorCaptureStore(
				path.join(app.getPath('userData'), 'simulator-captures')
			);
			stagedCertificateStore = new StagedCertificateStore({
				directory: path.join(
					app.getPath('userData'),
					'simulator-staged-certificates'
				),
			});
			await stagedCertificateStore.start();
			registerSimulatorCaptureProtocol(captureStore);
			const nativeHostClient = new NativeHostClient({
				resourceDirectory: nativeResourceDirectory,
				appVersion: app.getVersion(),
				compositionWorkspaceDirectory: path.join(
					app.getPath('userData'),
					'Capture Design Studio',
					'workspaces'
				),
			});
			const simHelperClient = new SimHelperClient({
				resourceDirectory: nativeResourceDirectory,
				appVersion: app.getVersion(),
				mutationBroker: nativeHostClient,
			});
			const simulatorMutationCoordinator = new SimulatorMutationCoordinator();
			simulatorService = new SimulatorService({
				captureStore,
				nativeHostProvider: nativeHostClient,
				imageCompositor: nativeHostClient,
				cloneProvider: simHelperClient,
				diskProvider: simHelperClient,
				mutationCoordinator: simulatorMutationCoordinator,
			});
			slimmingService = new SlimmingService({
				...(!app.isPackaged
					? {
							mutationUnavailableReason:
								'Preview is available. Applying or restoring services requires a signed, packaged RN Devtools app.',
						}
					: {}),
				resourceDirectory: nativeResourceDirectory,
				persistenceDirectory: path.join(
					app.getPath('userData'),
					'simulator-slimming'
				),
				appVersion: app.getVersion(),
				helper: simHelperClient,
				mutationCoordinator: simulatorMutationCoordinator,
				// The agent service is constructed after this one; resolve it late so
				// every mutation, from the panel or an agent, checks who holds the
				// device at the moment it is enqueued.
				deviceAccess: (simulatorUdid, requester) =>
					agentService?.access(simulatorUdid, requester) ?? { allowed: true },
			});
			recipeService = new RecipeService({
				store: new RecipeStore(path.join(app.getPath('userData'), 'recipes')),
				broker,
				simulator: simulatorService,
				slimming: slimmingService,
				mutationCoordinator: simulatorMutationCoordinator,
			});
			buildInsightsService = new BuildInsightsService({
				store: new BuildInsightsStore(
					path.join(app.getPath('userData'), 'build-insights')
				),
			});
			laneService = new LaneService({
				store: new LaneStore(path.join(app.getPath('userData'), 'lanes')),
				simulator: simulatorService,
				slimming: slimmingService,
				mutationCoordinator: simulatorMutationCoordinator,
				// The agent service is constructed next; it knows which sessions are
				// alive, which is what decides whether a lane's owner is gone.
				holds: () => agentService?.holds() ?? new Map(),
				// Resolved late for the same reason. A queued lane up asks it when its
				// turn comes, so it resumes the app's lane only for a session that
				// lane's holder lets in.
				deviceAccess: (simulatorUdid, requester) =>
					agentService?.access(simulatorUdid, requester) ?? { allowed: true },
				// The Supabase service is constructed after the agent service, and
				// before any lane can start.
				backends: {
					ensureForLane: async (input, signal) =>
						supabaseService
							? supabaseService.ensureForLane(input, signal)
							: {
									summary: {
										policy: input.policy,
										status: 'skipped',
										reason: 'disabled',
										appEnvNames: [],
										warnings: [],
										reasonText: 'Local Supabase is not ready yet.',
									},
								},
					detachLane: (laneId) => {
						supabaseService?.detachLane(laneId);
					},
					// Lanes default to no backend unless the feature is on and the
					// Mac supports it; otherwise every development lane would ask.
					defaultPolicy: (environmentId) => {
						const state = supabaseService?.getState();
						return state?.feature.enabled &&
							state.availability.platform.supported
							? laneDefaultBackend(state.policy, environmentId)
							: 'off';
					},
					describeWorktree: (worktreePath) =>
						supabaseService?.describeWorktree(worktreePath),
				},
			});
			agentService = new AgentService({
				directory: path.join(app.getPath('userData'), 'agents'),
				// Stored lanes and the starts still booting toward one, so a claim
				// cannot land on a device a lane is about to take.
				lanes: () => laneService?.holdingLanes() ?? [],
				// Supabase stack holders get the same abandonment clocks as lanes.
				holders: () => supabaseService?.holderKeys() ?? [],
			});
			const agentSocketPath = path.join(
				app.getPath('userData'),
				'agent',
				'rndevtools.sock'
			);
			supabaseService = createSupabaseService({
				userDataDirectory: app.getPath('userData'),
				agentSocketDirectory: path.dirname(agentSocketPath),
				lanes: supabaseLanePort(laneService),
				agents: supabaseAgentPort(agentService),
				dialog: supabaseDialog,
				shell: supabaseShell,
				clipboard: supabaseClipboard,
				demo: shouldUseSupabaseDemo(
					process.env.RNDEVTOOLS_DEMO,
					app.isPackaged
				),
				platform: supabasePlatform(),
			});
			simulatorStreamService = new SimulatorStreamService({
				frameDirectory: path.join(
					app.getPath('temp'),
					`rndevtools-stream-${process.pid}`
				),
				encode: createNativeImageFrameEncoder(nativeImage),
			});
			agentCliService = new AgentCliService({
				socketPath: agentSocketPath,
				handler: createAgentCommandRouter({
					broker,
					simulator: simulatorService,
					slimming: slimmingService,
					lanes: laneService,
					agents: agentService,
					supabase: supabaseService,
					nativePlan: runNativePlan,
					simulatorInput: (input, signal) =>
						nativeHostClient.sendSimulatorInput(input, signal),
					recipes: {
						list: () => recipeService?.getState().recipes ?? [],
						get: (recipeId) => recipeService?.getRecipe(recipeId) ?? null,
						run: (recipeId, udids) => {
							if (!recipeService)
								throw new Error('Recipe service is not available.');
							return recipeService.runRecipe({
								actionId: `agent-recipe-${randomUUID()}`,
								recipeId,
								targetUdids: [...udids],
								concurrency: Math.min(4, udids.length),
							});
						},
						cancel: (runId) => recipeService?.cancelRun(runId) ?? false,
						status: (runId) => {
							const runs = recipeService?.getState().runs ?? [];
							return runId
								? (runs.find((run) => run.id === runId) ?? null)
								: runs;
						},
					},
				}),
				...(app.isPackaged
					? {
							readiness: async () => {
								await verifyAgentCli({
									resourceDirectory: nativeResourceDirectory,
									appVersion: app.getVersion(),
								});
							},
						}
					: {}),
			});
			registerIpc(
				simulatorService,
				slimmingService,
				recipeService,
				buildInsightsService,
				laneService,
				nativeHostClient,
				stagedCertificateStore,
				nativeResourceDirectory,
				settings
			);
			registerSupabaseIpc(supabaseService);
			broker.subscribe((state) => broadcast(IPC_CHANNELS.stateChanged, state));
			simulatorService.subscribe((state) =>
				broadcast(IPC_CHANNELS.simulatorStateChanged, state)
			);
			slimmingService.subscribe((state) =>
				broadcast(IPC_CHANNELS.slimmingStateChanged, state)
			);
			recipeService.subscribe((state) =>
				broadcast(IPC_CHANNELS.recipeStateChanged, state)
			);
			buildInsightsService.subscribe((state) =>
				broadcast(IPC_CHANNELS.buildInsightsStateChanged, state)
			);
			laneService.subscribe((state) =>
				broadcast(IPC_CHANNELS.laneStateChanged, state)
			);
			agentService.subscribe((state) =>
				broadcast(IPC_CHANNELS.agentStateChanged, state)
			);
			supabaseService.subscribe(supabaseStatePublisher.publish);
			// The lane start form reads each worktree's project from lane state.
			supabaseService.subscribe(() => laneService?.backendsChanged());
			simulatorStreamService.subscribeFrames((frame, bytes) =>
				broadcast(IPC_CHANNELS.simulatorStreamFrame, frame, bytes)
			);
			simulatorStreamService.subscribeStatus((status) =>
				broadcast(IPC_CHANNELS.simulatorStreamStatus, status)
			);
			await Promise.all([
				broker.start(),
				simulatorService.start(),
				slimmingService.start(),
				recipeService.start(),
				buildInsightsService.start(),
				agentService.start(),
				supabaseService.start(),
			]);
			// Restored lanes reacquire backend holds after policy and stack state load.
			await laneService.start();
			await agentCliService.start();
			if (shutdownStarted) return;
			createWindow();

			app.on('activate', () => {
				if (!shutdownStarted && BrowserWindow.getAllWindows().length === 0) {
					createWindow();
				}
			});
		})
		.catch((error: unknown) => {
			dialog.showErrorBox(
				'RN Devtools could not start',
				diagnosticErrorText(error).slice(0, 8 * 1024)
			);
			app.quit();
		});
}

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
	if (brokerStopped) return;
	event.preventDefault();
	if (shutdownStarted) return;
	shutdownStarted = true;
	supabaseStatePublisher.dispose();
	// Running recipes cancel first: their teardown still needs the Simulator,
	// slimming, and broker services, which stop once it has finished.
	void stopForQuit(recipeService?.stop(), () => {
		const simulatorShutdown = simulatorService?.stop();
		const certificateShutdown = simulatorShutdown
			? simulatorShutdown.finally(() => stagedCertificateStore?.stop())
			: stagedCertificateStore?.stop();
		return [
			broker.stop(),
			simulatorShutdown,
			slimmingService?.stop(),
			buildInsightsService?.stop(),
			laneService?.stop(),
			agentService?.stop(),
			// Stopping the service never stops a stack; they outlive the app.
			supabaseService?.stop(),
			simulatorStreamService?.stop(),
			agentCliService?.stop(),
			certificateShutdown,
		];
	}).finally(() => {
		brokerStopped = true;
		app.quit();
	});
});

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createEmptyDeviceTools,
	type DesktopAction,
	type DesktopState,
} from '../shared/protocol';
import type { RecipeDefinition } from '../shared/recipe-protocol';
import type {
	SimulatorAction,
	SimulatorCapability,
	SimulatorJob,
	SimulatorState,
} from '../shared/simulator-protocol';
import type {
	SlimmingAction,
	SlimmingJob,
	SlimmingState,
} from '../shared/slimming-protocol';
import {
	type RecipeBrokerPort,
	RecipeService,
	type RecipeSimulatorPort,
	type RecipeSlimmingPort,
} from './recipe-service';
import { RecipeStore } from './recipe-store';
import { SimulatorMutationCoordinator } from './simulator-mutation-coordinator';
import {
	type SimulatorHostProvider,
	SimulatorService,
} from './simulator-service';

const UDID_ONE = '11111111-2222-3333-4444-555555555555';
const UDID_TWO = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
const roots: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(
		path.join(os.tmpdir(), 'rndevtools-recipe-service-')
	);
	roots.push(directory);
	return directory;
}

function definition(
	steps: RecipeDefinition['steps'],
	teardown: RecipeDefinition['teardown'] = [],
	defaultConcurrency = 2
): RecipeDefinition {
	return {
		formatVersion: 1,
		id: 'service-test',
		name: 'Service test',
		revision: 1,
		createdAt: 1,
		updatedAt: 1,
		defaultConcurrency,
		steps,
		teardown,
	};
}

function desktopState(udids = [UDID_ONE, UDID_TWO]): DesktopState {
	return {
		protocolVersion: 2,
		broker: {
			status: 'listening',
			host: '127.0.0.1',
			port: 47931,
			access: 'loopback',
			urls: [],
		},
		devices: udids.map((udid, index) => ({
			info: {
				id: `device-${index}`,
				name: `Device ${index}`,
				platform: 'simulator',
				simulatorUdid: udid,
				capabilities: [
					'components.activate',
					'components.waitForElement',
					'network.clearProfile',
				],
			},
			status: 'online',
			connectedAt: 1,
			lastSeenAt: 1,
			sequence: 1,
			tools: {
				...createEmptyDeviceTools(),
				components: [
					{
						id: 'button',
						name: 'Button',
						kind: 'Pressable',
						sourceFiles: [],
						instanceTruncated: false,
						bounds: null,
						isFocused: false,
						actions: ['activate'],
						screenHash: 'screen-one',
					},
				],
				componentSummary: {
					sourceTargetCount: 1,
					omittedTargetCount: 0,
					truncated: false,
					screenHash: 'screen-one',
				},
			},
		})),
		diagnostics: [],
	};
}

class FakeBroker implements RecipeBrokerPort {
	state = desktopState();
	actions: Array<{ deviceId: string; command: string }> = [];
	dispatched: DesktopAction[] = [];
	waitFailuresRemaining = 0;
	active = 0;
	maxActive = 0;
	beforeDispatch: (() => Promise<void>) | undefined;

	getState = () => this.state;

	dispatchAction = async (
		action: Parameters<RecipeBrokerPort['dispatchAction']>[0]
	) => {
		this.actions.push({ deviceId: action.deviceId, command: action.command });
		this.dispatched.push(action);
		await this.beforeDispatch?.();
		if (
			action.tool === 'components' &&
			action.command.startsWith('waitFor') &&
			this.waitFailuresRemaining > 0
		) {
			this.waitFailuresRemaining -= 1;
			return {
				actionId: action.actionId,
				ok: false,
				error: 'Wait slice elapsed.',
			};
		}
		this.active += 1;
		this.maxActive = Math.max(this.maxActive, this.active);
		await new Promise((resolve) => setTimeout(resolve, 100));
		this.active -= 1;
		return { actionId: action.actionId, ok: true };
	};
}

const AVAILABLE_SIMULATOR_CAPABILITY: SimulatorCapability = {
	status: 'available',
	platform: 'darwin',
	licenseStatus: 'accepted',
	hostArchitecture: 'arm64',
	runtimeAvailability: { total: 1, available: 1 },
	features: {
		deviceManagement: true,
		apps: true,
		deepLinks: true,
		location: true,
		push: true,
		privacy: true,
		ui: true,
		statusBar: true,
		keychain: true,
		screenshot: true,
		video: true,
	},
};

class CoordinatedRecipeSimulatorProvider implements SimulatorHostProvider {
	readonly commands: readonly string[][] = [];

	discover = async () => AVAILABLE_SIMULATOR_CAPABILITY;
	inventory = async () => ({
		runtimes: [],
		deviceTypes: [],
		devices: [
			{
				udid: UDID_ONE,
				name: 'Recipe coordination target',
				state: 'booted' as const,
				runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-0',
				isAvailable: true,
			},
		],
	});
	listApps = async () => [];
	openSimulator = async () => undefined;
	runSimctl = async (args: readonly string[]) => {
		(this.commands as string[][]).push([...args]);
		return { stdout: '', stderr: '', exitCode: 0 };
	};
}

function deferred() {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

class FakeSimulator implements RecipeSimulatorPort {
	readonly listeners = new Set<(state: SimulatorState) => void>();
	jobs: SimulatorJob[] = [];
	actions: SimulatorAction[] = [];
	refreshCount = 0;
	stateByUdid: Record<string, 'booted' | 'shutdown'> = {
		[UDID_ONE]: 'shutdown',
		[UDID_TWO]: 'shutdown',
	};

	getState = (): SimulatorState =>
		({
			revision: 1,
			updatedAt: 1,
			capability: {
				status: 'available',
				platform: 'darwin',
				licenseStatus: 'accepted',
				hostArchitecture: 'arm64',
				runtimeAvailability: { total: 1, available: 1 },
				features: {
					deviceManagement: true,
					apps: true,
					deepLinks: true,
					location: true,
					push: true,
					privacy: true,
					ui: true,
					statusBar: true,
					keychain: true,
					screenshot: true,
					video: true,
				},
			},
			runtimes: [],
			deviceTypes: [],
			devices: Object.entries(this.stateByUdid).map(([udid, state]) => ({
				udid,
				name: udid,
				state,
				runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-0',
				isAvailable: true,
			})),
			appsByDevice: {},
			diskByDevice: {},
			jobs: this.jobs,
			captures: [],
			metrics: { status: 'available', byDevice: {} },
			native: {
				status: 'available',
				permissionInspection: true,
				permissionPrompting: false,
				permissions: [],
			},
		}) as SimulatorState;

	refresh = async () => {
		this.refreshCount += 1;
		return this.getState();
	};

	runAction = (action: SimulatorAction) => {
		this.actions.push(action);
		const jobId = `simulator-job-${this.jobs.length}`;
		if (action.kind === 'device.boot') this.stateByUdid[action.udid] = 'booted';
		if (action.kind === 'device.shutdown')
			this.stateByUdid[action.udid] = 'shutdown';
		this.jobs.push({
			id: jobId,
			actionId: action.actionId,
			kind: action.kind,
			deviceUdid: 'udid' in action ? action.udid : undefined,
			status: 'complete',
			progressSequence: 1,
			phase: 'complete',
			createdAt: 1,
			finishedAt: 1,
			message: 'Complete.',
		});
		for (const listener of this.listeners) listener(this.getState());
		return { actionId: action.actionId, accepted: true, jobId };
	};

	cancelJob = () => true;

	subscribe = (listener: (state: SimulatorState) => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
}

class FakeSlimming implements RecipeSlimmingPort {
	readonly listeners = new Set<(state: SlimmingState) => void>();
	readonly actions: SlimmingAction[] = [];
	jobs: SlimmingJob[] = [];
	active = 0;
	acknowledged = false;
	maxActive = 0;
	mutations = 0;
	requiresExternalAcknowledgement = false;

	getState = (): SlimmingState =>
		({
			revision: 1,
			updatedAt: 1,
			setting: { experimentalMutationsEnabled: true },
			helper: { status: 'available', readOnlyAvailable: true },
			categories: [],
			profiles: [],
			simulators: [],
			statusBySimulator: {},
			previewBySimulator: {},
			doctorBySimulator: {},
			jobs: this.jobs,
			checkpointBySimulator: {},
			operationsBySimulator: {},
		}) as SlimmingState;

	refresh = async () => this.getState();

	runAction = (action: SlimmingAction) => {
		this.actions.push(action);
		if (this.requiresExternalAcknowledgement && !this.acknowledged) {
			return {
				actionId: action.actionId,
				accepted: false,
				error:
					'Unknown tuple requires a separately persisted exact EXPERIMENTAL acknowledgement.',
			};
		}
		this.mutations += 1;
		this.active += 1;
		this.maxActive = Math.max(this.maxActive, this.active);
		const jobId = `slimming-job-${this.jobs.length}`;
		const job: SlimmingJob = {
			id: jobId,
			actionId: action.actionId,
			kind: action.kind,
			status: 'running',
			progressSequence: 1,
			phase: 'running',
			message: 'Running.',
			createdAt: 1,
			currentIndex: 1,
			total: 1,
			targets: [
				{
					simulatorUdid: action.simulatorUdids[0] ?? UDID_ONE,
					status: 'running',
					message: 'Running.',
				},
			],
		};
		this.jobs.push(job);
		setTimeout(() => {
			job.status = 'complete';
			job.message = 'Complete.';
			job.phase = 'complete';
			const target = job.targets[0];
			if (target) job.targets[0] = { ...target, status: 'complete' };
			this.active -= 1;
			for (const listener of this.listeners) listener(this.getState());
		}, 15);
		return { actionId: action.actionId, accepted: true, jobId };
	};

	cancelJob = () => true;

	subscribe = (listener: (state: SlimmingState) => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
}

async function serviceFixture(recipe: RecipeDefinition) {
	const broker = new FakeBroker();
	const simulator = new FakeSimulator();
	const slimming = new FakeSlimming();
	const service = new RecipeService({
		store: new RecipeStore(await temporaryDirectory()),
		broker,
		simulator,
		slimming,
	});
	await service.start();
	await service.saveRecipe(recipe);
	return { broker, service, simulator, slimming };
}

async function waitForTerminal(service: RecipeService, runId: string) {
	for (let index = 0; index < 300; index += 1) {
		const run = service
			.getState()
			.runs.find((candidate) => candidate.id === runId);
		if (
			run &&
			['complete', 'failed', 'cancelled', 'interrupted'].includes(run.status)
		) {
			return run;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(
		`Recipe run did not finish: ${JSON.stringify(service.getState().runs)}`
	);
}

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
	);
});

describe('RecipeService', () => {
	it('honors saved long waits through bounded mobile-action slices', async () => {
		const { broker, service } = await serviceFixture(
			definition([
				{
					id: 'wait-long',
					kind: 'wait-for',
					timeoutMs: 60_000,
					waitFor: { condition: 'component.exists', componentId: 'button' },
				},
			])
		);
		broker.waitFailuresRemaining = 2;
		const receipt = await service.runRecipe({
			actionId: 'long-wait-run',
			recipeId: 'service-test',
			targetUdids: [UDID_ONE],
		});
		expect((await waitForTerminal(service, receipt.runId ?? '')).status).toBe(
			'complete'
		);
		const timeouts = broker.dispatched
			.filter(
				(action) =>
					action.tool === 'components' && action.command === 'waitForElement'
			)
			.map((action) => Number(action.payload.timeoutMs));
		expect(timeouts).toEqual([5_000, 5_000, 5_000]);
		expect(service.getRecipe('service-test')?.steps[0]).toMatchObject({
			timeoutMs: 60_000,
		});
	});

	it('spaces wait-for attempts with a timer, so failures answered at once never starve the event loop', async () => {
		const { broker, service } = await serviceFixture(
			definition([
				{
					id: 'wait-refused',
					kind: 'wait-for',
					timeoutMs: 600,
					waitFor: { condition: 'component.exists', componentId: 'button' },
				},
			])
		);
		// Refused at once, as the broker does while another action is in flight.
		broker.waitFailuresRemaining = Number.POSITIVE_INFINITY;
		let ticks = 0;
		const ticker = setInterval(() => {
			ticks += 1;
		}, 20);
		try {
			const receipt = await service.runRecipe({
				actionId: 'refused-wait-run',
				recipeId: 'service-test',
				targetUdids: [UDID_ONE],
			});
			const run = await waitForTerminal(service, receipt.runId ?? '');
			expect(run.targets[0]?.status).toBe('failed');
			// The broker's answer or the step timeout, never a contract error.
			expect(run.targets[0]?.message).toMatch(/Wait slice elapsed|timed out/);
		} finally {
			clearInterval(ticker);
		}
		const attempts = broker.dispatched.filter(
			(action) => action.command === 'waitForElement'
		).length;
		expect(attempts).toBeGreaterThanOrEqual(2);
		expect(attempts).toBeLessThanOrEqual(4);
		expect(ticks).toBeGreaterThanOrEqual(10);
	});

	it('fails a wait-for step at once when the app does not advertise it or goes offline', async () => {
		const { broker, service } = await serviceFixture(
			definition([
				{
					id: 'wait-screen',
					kind: 'wait-for',
					timeoutMs: 60_000,
					waitFor: { condition: 'screen.change' },
				},
			])
		);
		const unadvertised = await service.runRecipe({
			actionId: 'unadvertised-wait-run',
			recipeId: 'service-test',
			targetUdids: [UDID_ONE],
		});
		expect(
			(await waitForTerminal(service, unadvertised.runId ?? '')).targets[0]
		).toMatchObject({
			status: 'failed',
			message:
				'The connected app does not advertise components.waitForScreenChange.',
		});
		expect(broker.dispatched).toEqual([]);

		await service.saveRecipe({
			...definition([
				{
					id: 'wait-button',
					kind: 'wait-for',
					timeoutMs: 60_000,
					waitFor: { condition: 'component.exists', componentId: 'button' },
				},
			]),
			revision: 2,
		});
		broker.waitFailuresRemaining = Number.POSITIVE_INFINITY;
		broker.beforeDispatch = async () => {
			// The app disconnects while its first slice is out.
			broker.state = {
				...broker.state,
				devices: broker.state.devices.map((device) => ({
					...device,
					status: 'offline' as const,
				})),
			};
		};
		const offline = await service.runRecipe({
			actionId: 'offline-wait-run',
			recipeId: 'service-test',
			targetUdids: [UDID_ONE],
		});
		expect(
			(await waitForTerminal(service, offline.runId ?? '')).targets[0]
		).toMatchObject({
			status: 'failed',
			message: 'The exact connected app instance went offline.',
		});
		expect(broker.dispatched).toHaveLength(1);
	});

	it('resolves a fresh exact inventory and runs targets concurrently but steps sequentially', async () => {
		const { broker, service, simulator } = await serviceFixture(
			definition([
				{
					id: 'first',
					kind: 'semantic',
					action: { action: 'activate', componentId: 'button' },
				},
				{
					id: 'second',
					kind: 'semantic',
					action: { action: 'activate', componentId: 'button' },
				},
			])
		);
		const receipt = await service.runRecipe({
			actionId: 'concurrent-run',
			recipeId: 'service-test',
			targetUdids: [UDID_ONE.toLowerCase(), UDID_TWO],
			concurrency: 2,
		});
		expect(receipt.accepted).toBe(true);
		const run = await waitForTerminal(service, receipt.runId ?? '');
		expect(run.status).toBe('complete');
		expect(simulator.refreshCount).toBe(1);
		expect(run.targetUdids).toEqual([UDID_ONE, UDID_TWO]);
		expect(broker.maxActive).toBe(2);
		expect(
			broker.actions.filter((action) => action.deviceId === 'device-0')
		).toHaveLength(2);
	});

	it('holds a recipe-wide target lease while nested Simulator jobs bypass queued direct work', async () => {
		const coordinator = new SimulatorMutationCoordinator();
		const provider = new CoordinatedRecipeSimulatorProvider();
		const simulator = new SimulatorService({
			captureDirectory: await temporaryDirectory(),
			provider,
			metricsProvider: {
				sample: vi.fn(async () => ({
					status: 'available' as const,
					byDevice: {},
				})),
			},
			mutationCoordinator: coordinator,
			pollIntervalMs: 60_000,
		});
		await simulator.start();
		const broker = new FakeBroker();
		const brokerEntered = deferred();
		const releaseBroker = deferred();
		let blockFirstDispatch = true;
		broker.beforeDispatch = async () => {
			if (!blockFirstDispatch) return;
			blockFirstDispatch = false;
			brokerEntered.resolve();
			await releaseBroker.promise;
		};
		const recipe = definition([
			{
				id: 'claim-target',
				kind: 'semantic',
				action: { action: 'activate', componentId: 'button' },
			},
			{
				id: 'nested-launch',
				kind: 'simulator',
				action: {
					operation: 'app.launch',
					bundleIdentifier: 'com.example.recipe',
					terminateRunning: false,
					arguments: [],
				},
			},
		]);
		const service = new RecipeService({
			store: new RecipeStore(await temporaryDirectory()),
			broker,
			simulator,
			slimming: new FakeSlimming(),
			mutationCoordinator: coordinator,
		});
		await service.start();
		await service.saveRecipe(recipe);
		const recipeReceipt = await service.runRecipe({
			actionId: 'coordinated-recipe',
			recipeId: recipe.id,
			targetUdids: [UDID_ONE],
		});
		await brokerEntered.promise;

		const directReceipt = simulator.runAction({
			actionId: 'queued-direct-launch',
			kind: 'app.launch',
			udid: UDID_ONE,
			bundleIdentifier: 'com.example.external',
			terminateRunning: false,
			arguments: [],
		});
		expect(directReceipt.accepted).toBe(true);
		releaseBroker.resolve();
		expect(
			(await waitForTerminal(service, recipeReceipt.runId ?? '')).status
		).toBe('complete');
		await vi.waitFor(() => {
			expect(
				simulator.getState().jobs.find((job) => job.id === directReceipt.jobId)
					?.status
			).toBe('complete');
		});
		const launches = provider.commands.filter((args) => args[0] === 'launch');
		expect(launches.map((args) => args[2])).toEqual([
			'com.example.recipe',
			'com.example.external',
		]);
		await service.stop();
		await simulator.stop();
	});

	it('always runs teardown after a failed step and records cleanup independently', async () => {
		const { broker, service } = await serviceFixture(
			definition(
				[
					{
						id: 'must-be-booted',
						kind: 'assert',
						assertion: {
							condition: 'simulator.state',
							expected: 'booted',
						},
					},
				],
				[{ id: 'clear-network', kind: 'network', operation: 'clear' }]
			)
		);
		const receipt = await service.runRecipe({
			actionId: 'failed-run',
			recipeId: 'service-test',
			targetUdids: [UDID_ONE],
		});
		const run = await waitForTerminal(service, receipt.runId ?? '');
		expect(run).toMatchObject({
			status: 'failed',
			targets: [{ status: 'failed', cleanup: { status: 'complete' } }],
		});
		expect(broker.actions).toContainEqual({
			deviceId: 'device-0',
			command: 'clearProfile',
		});
	});

	it('preflights a connected app when only teardown requires one', async () => {
		const { broker, service } = await serviceFixture(
			definition(
				[{ id: 'local-step', kind: 'wait', durationMs: 0 }],
				[{ id: 'clear-network', kind: 'network', operation: 'clear' }]
			)
		);
		broker.state = desktopState([]);
		const receipt = await service.runRecipe({
			actionId: 'teardown-connected-preflight',
			recipeId: 'service-test',
			targetUdids: [UDID_ONE],
		});
		const run = await waitForTerminal(service, receipt.runId ?? '');
		expect(run).toMatchObject({
			status: 'failed',
			targets: [
				{
					status: 'failed',
					message:
						'No connected app instance matched the exact Simulator UDID.',
				},
			],
		});
		expect(broker.actions).toEqual([]);
	});

	it('requires approval before mutations and globally serializes approved targets', async () => {
		const { service, slimming } = await serviceFixture(
			definition([
				{
					id: 'slim',
					kind: 'slimming.mutation',
					operation: 'apply',
					profileId: 'rndevtools-development',
				},
			])
		);
		const request = {
			actionId: 'mutation-run',
			recipeId: 'service-test',
			targetUdids: [UDID_ONE, UDID_TWO],
			concurrency: 2,
		};
		const pending = await service.runRecipe(request);
		expect(pending).toMatchObject({ accepted: false, needsApproval: true });
		expect(
			service.getState().runs.find((run) => run.actionId === request.actionId)
		).toMatchObject({
			status: 'needs-approval',
			pendingRequest: {
				actionId: request.actionId,
				recipeId: request.recipeId,
				targetUdids: request.targetUdids,
				concurrency: 2,
			},
		});
		expect(slimming.mutations).toBe(0);
		await expect(
			service.runRecipe({ ...request, concurrency: 1 }, { runApproved: true })
		).resolves.toMatchObject({
			accepted: false,
			error: 'Approved request no longer matches its pending run.',
		});

		const accepted = await service.runRecipe(request, { runApproved: true });
		const run = await waitForTerminal(service, accepted.runId ?? '');
		expect(run.status).toBe('complete');
		expect(run).not.toHaveProperty('pendingRequest');
		expect(slimming.mutations).toBe(2);
		expect(slimming.maxActive).toBe(1);
	});

	it('never turns a recipe field into unknown-tuple acknowledgement authority', async () => {
		const { service, slimming } = await serviceFixture(
			definition([
				{
					id: 'legacy-slim',
					kind: 'slimming.mutation',
					operation: 'apply',
					profileId: 'rndevtools-development',
					acknowledgement: 'EXPERIMENTAL',
				},
			])
		);
		slimming.requiresExternalAcknowledgement = true;
		const blocked = await service.runRecipe(
			{
				actionId: 'legacy-ack-blocked',
				recipeId: 'service-test',
				targetUdids: [UDID_ONE],
			},
			{ runApproved: true }
		);
		expect((await waitForTerminal(service, blocked.runId ?? '')).status).toBe(
			'failed'
		);
		expect(slimming.actions[0]).not.toHaveProperty('acknowledgement');
		expect(slimming.mutations).toBe(0);

		slimming.acknowledged = true;
		const accepted = await service.runRecipe(
			{
				actionId: 'persisted-ack-accepted',
				recipeId: 'service-test',
				targetUdids: [UDID_ONE],
			},
			{ runApproved: true }
		);
		expect((await waitForTerminal(service, accepted.runId ?? '')).status).toBe(
			'complete'
		);
		expect(slimming.mutations).toBe(1);
	});

	it('gates sensitive simulator resets and normalizes legacy appearance steps', async () => {
		const { service, simulator } = await serviceFixture(
			definition([
				{
					id: 'appearance',
					kind: 'simulator',
					action: { operation: 'ui.appearance', value: 'dark' },
				},
				{
					id: 'reset-keychain',
					kind: 'simulator',
					action: { operation: 'keychain.reset' },
				},
			])
		);
		const request = {
			actionId: 'sensitive-run',
			recipeId: 'service-test',
			targetUdids: [UDID_ONE],
		};
		expect(service.getState().recipes[0]?.requiresMutationApproval).toBe(true);
		await expect(service.runRecipe(request)).resolves.toMatchObject({
			accepted: false,
			needsApproval: true,
		});
		expect(simulator.actions).toEqual([]);

		const accepted = await service.runRecipe(request, { runApproved: true });
		expect((await waitForTerminal(service, accepted.runId ?? '')).status).toBe(
			'complete'
		);
		expect(simulator.actions.map((action) => action.kind)).toEqual([
			'ui.update',
			'keychain.reset',
		]);
	});

	it('cancels active work but still completes teardown', async () => {
		const { broker, service } = await serviceFixture(
			definition(
				[{ id: 'pause', kind: 'wait', durationMs: 5_000 }],
				[{ id: 'clear-network', kind: 'network', operation: 'clear' }]
			)
		);
		const receipt = await service.runRecipe({
			actionId: 'cancel-run',
			recipeId: 'service-test',
			targetUdids: [UDID_ONE],
		});
		expect(service.cancelRun(receipt.runId ?? '')).toBe(true);
		const run = await waitForTerminal(service, receipt.runId ?? '');
		expect(run).toMatchObject({
			status: 'cancelled',
			targets: [{ status: 'cancelled', cleanup: { status: 'complete' } }],
		});
		expect(
			broker.actions.some((action) => action.command === 'clearProfile')
		).toBe(true);
	});

	it('bounds generated progress messages for valid maximum-length labels', async () => {
		const { service } = await serviceFixture(
			definition([
				{
					id: 'long-label',
					label: 'x'.repeat(4 * 1_024),
					kind: 'wait',
					durationMs: 0,
				},
			])
		);
		const receipt = await service.runRecipe({
			actionId: 'long-label-run',
			recipeId: 'service-test',
			targetUdids: [UDID_ONE],
		});
		const run = await waitForTerminal(service, receipt.runId ?? '');
		expect(run.status).toBe('complete');
		expect(run.targets[0]?.message.length).toBeLessThanOrEqual(4 * 1_024);
	});
});

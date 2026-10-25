import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import type {
	DesktopAction,
	DesktopActionResult,
	DesktopState,
	DeviceSession,
} from '../shared/protocol';
import {
	desktopActionCapability,
	desktopActionSchema,
} from '../shared/protocol';
import {
	DEFAULT_RECIPE_RUN_CONCURRENCY,
	type RecipeDefinition,
	type RecipeEvidenceManifest,
	type RecipeRun,
	type RecipeRunReceipt,
	type RecipeRunRequest,
	type RecipeState,
	type RecipeStep,
	type RecipeSummary,
	RNDEVTOOLS_RECIPE_FORMAT_VERSION,
	recipeDefinitionSchema,
	recipeEvidenceManifestSchema,
	recipeRunReceiptSchema,
	recipeRunRequestSchema,
	recipeRunSchema,
} from '../shared/recipe-protocol';
import type {
	SimulatorAction,
	SimulatorActionReceipt,
	SimulatorState,
} from '../shared/simulator-protocol';
import { simulatorActionSchema } from '../shared/simulator-protocol';
import {
	SLIMMING_CONFIRMATIONS,
	type SlimmingAction,
	type SlimmingActionReceipt,
	type SlimmingState,
	slimmingActionSchema,
} from '../shared/slimming-protocol';
import { waitForJob } from './job-wait';
import { recipeRequiresRunApproval } from './recipe-policy';
import type { RecipeRunRecord, RecipeStore } from './recipe-store';
import { safeErrorText } from './security';
import {
	SimulatorMutationCoordinator,
	type SimulatorMutationCoordinatorPort,
	type SimulatorMutationLease,
} from './simulator-mutation-coordinator';

const DEFAULT_STEP_TIMEOUT_MS = 30_000;
const MAX_ACTIVE_RUNS = 20;
const MAX_EVIDENCE_TIMELINE_EVENTS = 5_000;
const SIMULATOR_CANCEL_SETTLE_TIMEOUT_MS = 30_000;
const SLIMMING_CANCEL_SETTLE_TIMEOUT_MS = 6 * 60 * 1_000;
const MAX_RUN_MESSAGE_LENGTH = 4 * 1_024;
const MAX_CLEANUP_FAILURE_LENGTH = 1_024;
const CONNECTED_WAIT_SLICE_MS = 5_000;
/**
 * The connected-action contract's shortest wait (a `timeoutMs` of at least
 * 50 ms); a wait-for step with less time left than this is over.
 */
const MIN_CONNECTED_WAIT_SLICE_MS = 50;
/**
 * Wait-for attempts start at least this far apart. The broker answers some
 * failures at once (another action is in flight for the device), and retrying
 * those back to back would run on microtasks alone and starve the main
 * process's event loop, the step timeout and cancellation included.
 */
const CONNECTED_WAIT_RETRY_MS = 250;

export type RecipeBrokerPort = {
	getState: () => DesktopState;
	dispatchAction: (action: DesktopAction) => Promise<DesktopActionResult>;
};

export type RecipeSimulatorPort = {
	getState: () => SimulatorState;
	refresh: () => Promise<SimulatorState>;
	runAction: (
		action: SimulatorAction,
		context?: Record<string, never>,
		mutationLease?: SimulatorMutationLease
	) => SimulatorActionReceipt;
	cancelJob: (jobId: string) => boolean;
	subscribe: (listener: (state: SimulatorState) => void) => () => void;
};

export type RecipeSlimmingPort = {
	getState: () => SlimmingState;
	refresh: () => Promise<SlimmingState>;
	runAction: (
		action: SlimmingAction,
		mutationLease?: SimulatorMutationLease
	) => SlimmingActionReceipt;
	cancelJob: (jobId: string) => boolean;
	subscribe: (listener: (state: SlimmingState) => void) => () => void;
};

type RecipeListener = (state: RecipeState) => void;
type ActiveRun = {
	record: RecipeRunRecord;
	recipe: RecipeDefinition;
	controller: AbortController;
	task: Promise<void>;
};
type TargetContext = {
	index: number;
	udid: string;
	connectedDeviceId?: string;
	restorePointIds: Map<string, string>;
	diagnosticBaseline: Set<string>;
	mutationLease: SimulatorMutationLease;
};

function actionId(): string {
	return `recipe-action-${randomUUID()}`;
}

function needsConnectedDevice(step: RecipeStep): boolean {
	if (
		['semantic', 'network', 'camera', 'wait-for', 'restore-point'].includes(
			step.kind
		)
	) {
		return true;
	}
	return (
		step.kind === 'assert' &&
		step.assertion.condition !== 'simulator.state' &&
		!(step.assertion.condition === 'connected' && !step.assertion.expected)
	);
}

function exactConnectedDevice(
	state: DesktopState,
	udid: string
): DeviceSession | undefined {
	const normalized = udid.toUpperCase();
	const matches = state.devices.filter(
		(device) =>
			device.info.simulatorUdid?.toUpperCase() === normalized &&
			(device.status === 'online' || device.status === 'simulated')
	);
	if (matches.length > 1) {
		throw new Error(
			'More than one connected app instance claimed the exact Simulator.'
		);
	}
	return matches[0];
}

function currentDevice(
	state: DesktopState,
	context: TargetContext
): DeviceSession {
	if (!context.connectedDeviceId) {
		throw new Error(
			'No connected app instance is available for this Simulator.'
		);
	}
	const device = state.devices.find(
		(candidate) =>
			candidate.info.id === context.connectedDeviceId &&
			candidate.info.simulatorUdid?.toUpperCase() ===
				context.udid.toUpperCase() &&
			(candidate.status === 'online' || candidate.status === 'simulated')
	);
	if (!device)
		throw new Error('The exact connected app instance went offline.');
	return device;
}

/** Refuses an action the app instance does not advertise; retrying cannot change that. */
function assertAdvertised(
	device: DeviceSession,
	action: Pick<DesktopAction, 'tool' | 'command'>
): void {
	const capability = desktopActionCapability(action.tool, action.command);
	if (capability && device.info.capabilities.includes(capability)) return;
	throw new Error(
		`The connected app does not advertise ${capability ?? `${action.tool}.${action.command}`}.`
	);
}

function diagnosticIds(state: DesktopState, deviceId?: string): Set<string> {
	const ids = new Set(state.diagnostics.map((entry) => entry.id));
	const device = deviceId
		? state.devices.find((candidate) => candidate.info.id === deviceId)
		: undefined;
	for (const diagnostic of device?.tools.diagnostics ?? [])
		ids.add(diagnostic.id);
	return ids;
}

function runTarget(
	record: RecipeRunRecord,
	index: number
): RecipeRun['targets'][number] {
	const target = record.run.targets[index];
	if (!target) throw new Error('Recipe target index is invalid.');
	return target;
}

function evidenceTarget(
	record: RecipeRunRecord,
	index: number
): RecipeEvidenceManifest['targets'][number] {
	const target = record.evidence.targets[index];
	if (!target) throw new Error('Evidence target index is invalid.');
	return target;
}

function waitForDelay(durationMs: number, signal: AbortSignal): Promise<void> {
	return wait(durationMs, undefined, { signal }).catch(() => {
		throw new Error('Recipe run cancelled.');
	});
}

function timeoutSignal(
	parent: AbortSignal,
	timeoutMs: number
): {
	signal: AbortSignal;
	dispose: () => void;
} {
	const controller = new AbortController();
	const onAbort = () => controller.abort(parent.reason);
	if (parent.aborted) controller.abort(parent.reason);
	else parent.addEventListener('abort', onAbort, { once: true });
	const timer = setTimeout(
		() =>
			controller.abort(
				new Error(`Recipe step timed out after ${timeoutMs}ms.`)
			),
		timeoutMs
	);
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer);
			parent.removeEventListener('abort', onAbort);
		},
	};
}

export class RecipeService {
	readonly #store: RecipeStore;
	readonly #broker: RecipeBrokerPort;
	readonly #simulator: RecipeSimulatorPort;
	readonly #slimming: RecipeSlimmingPort;
	readonly #mutationCoordinator: SimulatorMutationCoordinatorPort;
	readonly #now: () => number;
	readonly #listeners = new Set<RecipeListener>();
	readonly #active = new Map<string, ActiveRun>();
	readonly #claimedTargets = new Map<string, string>();
	#slimmingQueue: Promise<void> = Promise.resolve();
	#stopped = false;

	constructor({
		store,
		broker,
		simulator,
		slimming,
		mutationCoordinator = new SimulatorMutationCoordinator(),
		now = Date.now,
	}: {
		store: RecipeStore;
		broker: RecipeBrokerPort;
		simulator: RecipeSimulatorPort;
		slimming: RecipeSlimmingPort;
		mutationCoordinator?: SimulatorMutationCoordinatorPort;
		now?: () => number;
	}) {
		this.#store = store;
		this.#broker = broker;
		this.#simulator = simulator;
		this.#slimming = slimming;
		this.#mutationCoordinator = mutationCoordinator;
		this.#now = now;
	}

	async start(): Promise<void> {
		this.#stopped = false;
		await this.#store.initialize();
		this.#emit();
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		for (const active of this.#active.values()) active.controller.abort();
		await Promise.allSettled(
			[...this.#active.values()].map((active) => active.task)
		);
	}

	getState(): RecipeState {
		return this.#store.getState();
	}

	getRecipe(recipeId: string): RecipeDefinition | null {
		return this.#store.getRecipe(recipeId) ?? null;
	}

	getEvidence(evidenceId: string): RecipeEvidenceManifest | null {
		return this.#store.getEvidence(evidenceId) ?? null;
	}

	subscribe(listener: RecipeListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async saveRecipe(value: RecipeDefinition): Promise<RecipeSummary> {
		const summary = await this.#store.saveRecipe(
			recipeDefinitionSchema.parse(value)
		);
		this.#emit();
		return summary;
	}

	async deleteRecipe(recipeId: string): Promise<boolean> {
		if (
			[...this.#active.values()].some((active) => active.recipe.id === recipeId)
		) {
			throw new Error('A running recipe cannot be deleted.');
		}
		const deleted = await this.#store.deleteRecipe(recipeId);
		if (deleted) this.#emit();
		return deleted;
	}

	importRecipe(filePath: string): Promise<RecipeSummary> {
		return this.#store.importRecipe(filePath).then((summary) => {
			this.#emit();
			return summary;
		});
	}

	exportRecipe(recipeId: string, destinationPath: string): Promise<void> {
		return this.#store.exportRecipe(recipeId, destinationPath);
	}

	exportEvidence(evidenceId: string, destinationPath: string): Promise<void> {
		return this.#store.exportEvidence(evidenceId, destinationPath);
	}

	async runRecipe(
		value: RecipeRunRequest,
		{ runApproved = false }: { runApproved?: boolean } = {}
	): Promise<RecipeRunReceipt> {
		const request = recipeRunRequestSchema.parse(value);
		if (this.#stopped)
			return this.#reject(request, 'Recipe execution is shutting down.');
		const recipe = this.#store.getRecipe(request.recipeId);
		if (!recipe) return this.#reject(request, 'Recipe was not found.');
		if (this.#active.size >= MAX_ACTIVE_RUNS) {
			return this.#reject(
				request,
				`No more than ${MAX_ACTIVE_RUNS} runs may be active.`
			);
		}
		const prior = this.#store
			.getState()
			.runs.find((run) => run.actionId === request.actionId);
		if (prior && prior.status !== 'needs-approval') {
			return this.#reject(
				request,
				'A run already uses this action identifier.'
			);
		}

		let simulatorState: SimulatorState;
		try {
			simulatorState = await this.#simulator.refresh();
		} catch (error) {
			return this.#reject(
				request,
				`Fresh Simulator inventory failed: ${safeErrorText(error)}`
			);
		}
		const canonicalUdids: string[] = [];
		for (const requestedUdid of request.targetUdids) {
			const matches = simulatorState.devices.filter(
				(device) => device.udid.toUpperCase() === requestedUdid.toUpperCase()
			);
			if (matches.length !== 1 || !matches[0]?.isAvailable) {
				return this.#reject(
					request,
					`Exact Simulator target ${requestedUdid} is unavailable in the fresh inventory.`
				);
			}
			canonicalUdids.push(matches[0].udid);
		}
		for (const udid of canonicalUdids) {
			if (this.#claimedTargets.has(udid.toUpperCase())) {
				return this.#reject(
					request,
					`${udid} is already claimed by another run.`
				);
			}
		}

		const concurrency = Math.min(
			request.concurrency ??
				recipe.defaultConcurrency ??
				DEFAULT_RECIPE_RUN_CONCURRENCY,
			canonicalUdids.length
		);
		let record =
			prior?.status === 'needs-approval'
				? this.#store.getRun(prior.id)
				: undefined;
		if (
			record &&
			(record.run.recipeId !== recipe.id ||
				record.run.recipeRevision !== recipe.revision ||
				record.run.concurrency !== concurrency ||
				record.run.targetUdids.join('|').toUpperCase() !==
					canonicalUdids.join('|').toUpperCase())
		) {
			return this.#reject(
				request,
				'Approved request no longer matches its pending run.'
			);
		}
		if (!record)
			record = this.#newRecord(request, recipe, canonicalUdids, concurrency);

		if (recipeRequiresRunApproval(recipe) && !runApproved) {
			record.run = recipeRunSchema.parse({
				...record.run,
				status: 'needs-approval',
				pendingRequest: {
					actionId: request.actionId,
					recipeId: recipe.id,
					targetUdids: canonicalUdids,
					concurrency,
				},
				message: 'A fresh, exact recipe mutation confirmation is required.',
				progressSequence: record.run.progressSequence + 1,
			});
			record.evidence = recipeEvidenceManifestSchema.parse({
				...record.evidence,
				status: 'needs-approval',
				timeline: [
					...record.evidence.timeline,
					{
						sequence: record.evidence.timeline.length,
						at: this.#now(),
						phase: 'run',
						status: 'info',
						message: 'Run is waiting for exact mutation approval.',
					},
				],
			});
			await this.#save(record);
			return recipeRunReceiptSchema.parse({
				actionId: request.actionId,
				accepted: false,
				runId: record.run.id,
				needsApproval: true,
				error: 'A fresh, exact recipe mutation confirmation is required.',
			});
		}

		for (const udid of canonicalUdids) {
			this.#claimedTargets.set(udid.toUpperCase(), record.run.id);
		}
		const { pendingRequest: _pendingRequest, ...approvedRun } = record.run;
		record.run = recipeRunSchema.parse({
			...approvedRun,
			status: 'queued',
			message: 'Recipe queued.',
			progressSequence: record.run.progressSequence + 1,
		});
		record.evidence = recipeEvidenceManifestSchema.parse({
			...record.evidence,
			status: 'queued',
		});
		await this.#save(record);
		const controller = new AbortController();
		const task = this.#executeRun(record, recipe, controller.signal).finally(
			() => {
				this.#active.delete(record.run.id);
				for (const udid of record.run.targetUdids) {
					if (this.#claimedTargets.get(udid.toUpperCase()) === record.run.id) {
						this.#claimedTargets.delete(udid.toUpperCase());
					}
				}
			}
		);
		this.#active.set(record.run.id, { record, recipe, controller, task });
		void task.catch(() => undefined);
		return { actionId: request.actionId, accepted: true, runId: record.run.id };
	}

	cancelRun(runId: string): boolean {
		const active = this.#active.get(runId);
		if (!active || active.controller.signal.aborted) return false;
		active.record.run = recipeRunSchema.parse({
			...active.record.run,
			status: 'cancelling',
			message: 'Cancelling active steps; teardown will still run.',
			progressSequence: active.record.run.progressSequence + 1,
		});
		active.controller.abort();
		void this.#save(active.record);
		return true;
	}

	async #executeRun(
		record: RecipeRunRecord,
		recipe: RecipeDefinition,
		signal: AbortSignal
	): Promise<void> {
		try {
			const now = this.#now();
			record.run = recipeRunSchema.parse({
				...record.run,
				status: 'running',
				startedAt: record.run.startedAt ?? now,
				message: 'Running recipe targets.',
				progressSequence: record.run.progressSequence + 1,
				targets: record.run.targets.map((target) => ({
					...target,
					status: 'resolving',
					message: 'Resolving exact target.',
				})),
			});
			record.evidence = recipeEvidenceManifestSchema.parse({
				...record.evidence,
				status: 'running',
				targets: record.evidence.targets.map((target) => ({
					...target,
					status: 'resolving',
				})),
				timeline: [
					...record.evidence.timeline,
					{
						sequence: record.evidence.timeline.length,
						at: now,
						phase: 'run',
						status: 'started',
						message: 'Recipe run started.',
					},
				],
			});
			await this.#save(record);

			let nextIndex = 0;
			const worker = async () => {
				while (nextIndex < record.run.targets.length) {
					const index = nextIndex;
					nextIndex += 1;
					await this.#executeTarget(record, recipe, index, signal);
				}
			};
			await Promise.all(
				Array.from({ length: record.run.concurrency }, () => worker())
			);
		} catch (error) {
			this.#appendTimeline(record, {
				phase: 'run',
				status: signal.aborted ? 'cancelled' : 'failed',
				message: signal.aborted
					? 'Recipe run cancelled.'
					: safeErrorText(error),
			});
		} finally {
			const statuses = record.run.targets.map((target) => target.status);
			const cleanupFailed = record.run.targets.some((target) =>
				['failed', 'partial', 'interrupted'].includes(target.cleanup.status)
			);
			const status = signal.aborted
				? 'cancelled'
				: statuses.includes('failed') || cleanupFailed
					? 'failed'
					: statuses.includes('interrupted')
						? 'interrupted'
						: 'complete';
			const finishedAt = this.#now();
			record.run = recipeRunSchema.parse({
				...record.run,
				status,
				finishedAt,
				message:
					status === 'complete'
						? 'Recipe completed on every target.'
						: status === 'cancelled'
							? 'Recipe cancelled; teardown results are recorded independently.'
							: 'Recipe failed; inspect target and cleanup evidence.',
				progressSequence: record.run.progressSequence + 1,
			});
			record.evidence = recipeEvidenceManifestSchema.parse({
				...record.evidence,
				status,
				finishedAt,
				targets: record.run.targets.map((target, index) => ({
					...evidenceTarget(record, index),
					status: target.status,
					cleanupStatus: target.cleanup.status,
				})),
			});
			this.#appendTimeline(record, {
				phase: 'run',
				status:
					status === 'complete'
						? 'complete'
						: status === 'cancelled'
							? 'cancelled'
							: status === 'interrupted'
								? 'interrupted'
								: 'failed',
				message: record.run.message,
			});
			await this.#save(record);
		}
	}

	async #executeTarget(
		record: RecipeRunRecord,
		recipe: RecipeDefinition,
		index: number,
		runSignal: AbortSignal
	): Promise<void> {
		const target = runTarget(record, index);
		try {
			await this.#mutationCoordinator.runExclusive(
				target.udid,
				runSignal,
				(mutationLease) =>
					this.#executeTargetWithLease(
						record,
						recipe,
						index,
						runSignal,
						mutationLease
					)
			);
		} catch (error) {
			this.#updateTarget(record, index, {
				status: runSignal.aborted ? 'cancelled' : 'failed',
				currentStepId: undefined,
				message: runSignal.aborted
					? 'Recipe target cancelled before execution.'
					: safeErrorText(error),
			});
			const cleanupController = new AbortController();
			try {
				await this.#mutationCoordinator.runExclusive(
					target.udid,
					cleanupController.signal,
					async (mutationLease) => {
						const connected = exactConnectedDevice(
							this.#broker.getState(),
							target.udid
						);
						await this.#runTeardown(
							record,
							{
								index,
								udid: target.udid,
								restorePointIds: new Map(),
								diagnosticBaseline: diagnosticIds(
									this.#broker.getState(),
									connected?.info.id
								),
								mutationLease,
								...(connected ? { connectedDeviceId: connected.info.id } : {}),
							},
							recipe.teardown
						);
					}
				);
			} catch (cleanupError) {
				this.#updateCleanup(record, index, {
					status: 'failed',
					failures: [
						safeErrorText(cleanupError).slice(0, MAX_CLEANUP_FAILURE_LENGTH),
					],
					message: 'Teardown could not acquire the simulator mutation lease.',
				});
			}
			record.evidence.targets[index] = {
				...evidenceTarget(record, index),
				status: runTarget(record, index).status,
				cleanupStatus: runTarget(record, index).cleanup.status,
			};
			await this.#save(record);
		}
	}

	async #executeTargetWithLease(
		record: RecipeRunRecord,
		recipe: RecipeDefinition,
		index: number,
		runSignal: AbortSignal,
		mutationLease: SimulatorMutationLease
	): Promise<void> {
		const target = runTarget(record, index);
		const connectedRequired = [...recipe.steps, ...recipe.teardown].some(
			needsConnectedDevice
		);
		let connected: DeviceSession | undefined;
		const context: TargetContext = {
			index,
			udid: target.udid,
			restorePointIds: new Map(),
			diagnosticBaseline: diagnosticIds(this.#broker.getState()),
			mutationLease,
		};
		try {
			connected = exactConnectedDevice(this.#broker.getState(), target.udid);
			if (connectedRequired && !connected) {
				throw new Error(
					'No connected app instance matched the exact Simulator UDID.'
				);
			}
			if (connected) context.connectedDeviceId = connected.info.id;
			context.diagnosticBaseline = diagnosticIds(
				this.#broker.getState(),
				connected?.info.id
			);
			this.#updateTarget(record, index, {
				status: 'running',
				message: 'Running recipe steps.',
			});
			const evidence = evidenceTarget(record, index);
			record.evidence.targets[index] = {
				...evidence,
				status: 'running',
				...(connected ? { connectedDeviceId: connected.info.id } : {}),
			};
			await this.#save(record);

			for (const step of recipe.steps) {
				if (runSignal.aborted) throw new Error('Recipe run cancelled.');
				await this.#executeRecordedStep(
					record,
					context,
					step,
					runSignal,
					'step'
				);
				const current = runTarget(record, index);
				this.#updateTarget(record, index, {
					completedSteps: current.completedSteps + 1,
					message: `Completed ${step.label ?? step.id}.`,
				});
				await this.#save(record);
			}
			this.#updateTarget(record, index, {
				status: 'complete',
				currentStepId: undefined,
				message: 'Recipe steps completed.',
			});
		} catch (error) {
			this.#updateTarget(record, index, {
				status: runSignal.aborted ? 'cancelled' : 'failed',
				currentStepId: undefined,
				message: runSignal.aborted
					? 'Recipe target cancelled.'
					: safeErrorText(error),
			});
		} finally {
			if (!context.connectedDeviceId) {
				const teardownDevice = exactConnectedDevice(
					this.#broker.getState(),
					target.udid
				);
				if (teardownDevice) context.connectedDeviceId = teardownDevice.info.id;
			}
			await this.#runTeardown(record, context, recipe.teardown);
			const targetStatus = runTarget(record, index).status;
			record.evidence.targets[index] = {
				...evidenceTarget(record, index),
				status: targetStatus,
				cleanupStatus: runTarget(record, index).cleanup.status,
			};
			await this.#save(record);
		}
	}

	async #runTeardown(
		record: RecipeRunRecord,
		context: TargetContext,
		steps: RecipeStep[]
	): Promise<void> {
		const index = context.index;
		this.#updateCleanup(record, index, {
			status: 'running',
			message: 'Running teardown.',
		});
		await this.#save(record);
		const failures: string[] = [];
		for (const step of steps) {
			const cleanupController = new AbortController();
			try {
				await this.#executeRecordedStep(
					record,
					context,
					step,
					cleanupController.signal,
					'teardown'
				);
				const cleanup = runTarget(record, index).cleanup;
				this.#updateCleanup(record, index, {
					completedSteps: cleanup.completedSteps + 1,
					message: `Completed teardown ${step.label ?? step.id}.`,
				});
			} catch (error) {
				failures.push(
					`${step.id}: ${safeErrorText(error)}`.slice(
						0,
						MAX_CLEANUP_FAILURE_LENGTH
					)
				);
			}
			await this.#save(record);
		}
		this.#updateCleanup(record, index, {
			status:
				failures.length === 0
					? 'complete'
					: failures.length === steps.length
						? 'failed'
						: 'partial',
			failures,
			message:
				failures.length === 0
					? 'Teardown completed.'
					: 'One or more teardown steps failed.',
		});
	}

	async #executeRecordedStep(
		record: RecipeRunRecord,
		context: TargetContext,
		step: RecipeStep,
		parentSignal: AbortSignal,
		phase: 'step' | 'teardown'
	): Promise<void> {
		const target = runTarget(record, context.index);
		const preservePrimaryFailure = [
			'failed',
			'cancelled',
			'interrupted',
		].includes(target.status);
		this.#updateTarget(record, context.index, {
			currentStepId: step.id,
			...(preservePrimaryFailure
				? {}
				: { message: `Running ${step.label ?? step.id}.` }),
		});
		this.#appendTimeline(record, {
			phase,
			status: 'started',
			message: `Started ${step.label ?? step.id}.`,
			targetUdid: context.udid,
			stepId: step.id,
		});
		await this.#save(record);
		const scoped = timeoutSignal(
			parentSignal,
			step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
		);
		try {
			const captureId = await this.#executeStep(
				record,
				context,
				step,
				scoped.signal
			);
			const newDiagnostics = this.#collectDiagnostics(record, context);
			this.#appendTimeline(record, {
				phase,
				status: 'complete',
				message: `Completed ${step.label ?? step.id}.`,
				targetUdid: context.udid,
				stepId: step.id,
				...(captureId ? { captureId } : {}),
				...(newDiagnostics.length > 0
					? { diagnosticCorrelationIds: newDiagnostics }
					: {}),
			});
		} catch (error) {
			this.#appendTimeline(record, {
				phase,
				status:
					scoped.signal.aborted && parentSignal.aborted
						? 'cancelled'
						: 'failed',
				message: safeErrorText(scoped.signal.reason ?? error),
				targetUdid: context.udid,
				stepId: step.id,
			});
			throw scoped.signal.reason ?? error;
		} finally {
			scoped.dispose();
		}
	}

	async #executeStep(
		record: RecipeRunRecord,
		context: TargetContext,
		step: RecipeStep,
		signal: AbortSignal
	): Promise<string | undefined> {
		if (step.kind === 'wait') {
			await waitForDelay(step.durationMs, signal);
			return undefined;
		}
		if (step.kind === 'simulator') {
			if (step.action.operation === 'ui.appearance') {
				return this.#runSimulatorAction(
					simulatorActionSchema.parse({
						actionId: actionId(),
						kind: 'ui.update',
						udid: context.udid,
						setting: 'appearance',
						value: step.action.value,
					}),
					signal,
					context.mutationLease
				);
			}
			if (step.action.operation === 'privacy.update') {
				const {
					privacyOperation,
					operation: _operation,
					...payload
				} = step.action;
				return this.#runSimulatorAction(
					simulatorActionSchema.parse({
						actionId: actionId(),
						kind: 'privacy.update',
						udid: context.udid,
						operation: privacyOperation,
						...payload,
					}),
					signal,
					context.mutationLease
				);
			}
			const { operation, ...payload } = step.action;
			return this.#runSimulatorAction(
				simulatorActionSchema.parse({
					actionId: actionId(),
					kind: operation,
					udid: context.udid,
					...payload,
				}),
				signal,
				context.mutationLease
			);
		}
		if (step.kind === 'capture') {
			return this.#runSimulatorAction(
				simulatorActionSchema.parse({
					actionId: actionId(),
					kind: 'capture.screenshot',
					udid: context.udid,
					format: step.format,
					mask: step.mask,
					...(step.name ? { name: step.name } : {}),
				}),
				signal,
				context.mutationLease,
				record,
				context.index
			);
		}
		if (step.kind === 'slimming.mutation') {
			await this.#runSlimmingMutation(
				step,
				context.udid,
				signal,
				context.mutationLease
			);
			return undefined;
		}
		if (step.kind === 'assert') {
			this.#assertStep(step, context);
			return undefined;
		}
		if (step.kind === 'wait-for') {
			await this.#waitForStep(step, context, signal);
			return undefined;
		}
		if (step.kind === 'semantic') {
			const device = currentDevice(this.#broker.getState(), context);
			const component = device.tools.components.find(
				(candidate) => candidate.id === step.action.componentId
			);
			if (!component) throw new Error('Semantic component does not exist.');
			const screenHash =
				component.screenHash ?? device.tools.componentSummary.screenHash;
			const {
				action: command,
				componentId: _componentId,
				...actionPayload
			} = step.action;
			const payload =
				command === 'highlight'
					? { id: component.id }
					: {
							id: component.id,
							screenHash,
							...actionPayload,
						};
			await this.#runDesktopAction({
				actionId: actionId(),
				deviceId: device.info.id,
				tool: 'components',
				command,
				payload,
			});
			return undefined;
		}
		if (step.kind === 'network') {
			const device = currentDevice(this.#broker.getState(), context);
			await this.#runDesktopAction({
				actionId: actionId(),
				deviceId: device.info.id,
				tool: 'network',
				command: step.operation === 'set' ? 'setProfile' : 'clearProfile',
				payload: step.operation === 'set' ? { profileId: step.profileId } : {},
			});
			return undefined;
		}
		if (step.kind === 'camera') {
			const device = currentDevice(this.#broker.getState(), context);
			const payload =
				step.operation === 'clear'
					? {}
					: (() => {
							const { fixtureKind, ...fixture } = step.fixture;
							return { kind: fixtureKind, ...fixture };
						})();
			await this.#runDesktopAction({
				actionId: actionId(),
				deviceId: device.info.id,
				tool: 'camera',
				command: step.operation === 'set' ? 'setFixture' : 'clearFixture',
				payload,
			});
			return undefined;
		}
		await this.#runRestorePointStep(step, context, signal);
		return undefined;
	}

	async #runSimulatorAction(
		action: SimulatorAction,
		signal: AbortSignal,
		mutationLease: SimulatorMutationLease,
		record?: RecipeRunRecord,
		targetIndex?: number
	): Promise<string | undefined> {
		const receipt = this.#simulator.runAction(action, {}, mutationLease);
		if (!receipt.accepted || !receipt.jobId) {
			throw new Error(receipt.error ?? 'Simulator action was rejected.');
		}
		const job = await waitForJob(this.#simulator, receipt.jobId, signal, {
			cancel: true,
			settleMs: SIMULATOR_CANCEL_SETTLE_TIMEOUT_MS,
			abortError: () =>
				new Error('Cancelled Simulator action did not reach a terminal state.'),
		});
		if (job.status !== 'complete') throw new Error(job.message);
		if (job.captureId && record !== undefined && targetIndex !== undefined) {
			const target = evidenceTarget(record, targetIndex);
			record.evidence.targets[targetIndex] = {
				...target,
				captureIds: [...new Set([...target.captureIds, job.captureId])],
			};
			record.evidence = {
				...record.evidence,
				captureIds: [
					...new Set([...record.evidence.captureIds, job.captureId]),
				],
			};
		}
		return job.captureId;
	}

	async #runDesktopAction(value: unknown): Promise<void> {
		const action = desktopActionSchema.parse(value);
		const result = await this.#broker.dispatchAction(action);
		if (!result.ok) throw new Error(result.error ?? 'Connected action failed.');
	}

	/**
	 * Waits on the app in bounded slices until `timeoutMs`. The exact app
	 * instance is looked up for every attempt, so one that went offline fails
	 * the step as it fails any other step, and so does one that does not
	 * advertise the wait.
	 */
	async #runBoundedDesktopWait(
		value: Omit<DesktopAction, 'actionId' | 'deviceId'>,
		context: TargetContext,
		timeoutMs: number,
		signal: AbortSignal
	): Promise<void> {
		const deadline = this.#now() + timeoutMs;
		let lastError: unknown;
		for (;;) {
			if (signal.aborted)
				throw signal.reason ?? new Error('Recipe run cancelled.');
			const device = currentDevice(this.#broker.getState(), context);
			assertAdvertised(device, value);
			const startedAt = this.#now();
			const remainingMs = deadline - startedAt;
			if (remainingMs < MIN_CONNECTED_WAIT_SLICE_MS) break;
			try {
				await this.#runDesktopAction({
					...value,
					actionId: actionId(),
					deviceId: device.info.id,
					payload: {
						...value.payload,
						timeoutMs: Math.min(CONNECTED_WAIT_SLICE_MS, remainingMs),
					},
				});
				return;
			} catch (error) {
				lastError = error;
			}
			const pauseMs =
				Math.min(startedAt + CONNECTED_WAIT_RETRY_MS, deadline) - this.#now();
			if (pauseMs > 0) await waitForDelay(pauseMs, signal);
		}
		throw lastError ?? new Error('Connected-app wait timed out.');
	}

	async #runSlimmingMutation(
		step: Extract<RecipeStep, { kind: 'slimming.mutation' }>,
		udid: string,
		signal: AbortSignal,
		mutationLease: SimulatorMutationLease
	): Promise<void> {
		const previous = this.#slimmingQueue;
		let release: () => void = () => undefined;
		this.#slimmingQueue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous.catch(() => undefined);
		try {
			if (signal.aborted)
				throw signal.reason ?? new Error('Recipe run cancelled.');
			await this.#slimming.refresh();
			const action = slimmingActionSchema.parse({
				actionId: actionId(),
				kind:
					step.operation === 'apply'
						? 'profile.apply'
						: step.operation === 'restore'
							? 'profile.restore'
							: 'profile.undo',
				simulatorUdids: [udid],
				...(step.operation === 'apply' ? { profileId: step.profileId } : {}),
				confirmation:
					step.operation === 'apply'
						? SLIMMING_CONFIRMATIONS.apply
						: step.operation === 'restore'
							? SLIMMING_CONFIRMATIONS.restore
							: SLIMMING_CONFIRMATIONS.undo,
			});
			const receipt = this.#slimming.runAction(action, mutationLease);
			if (!receipt.accepted || !receipt.jobId) {
				throw new Error(receipt.error ?? 'Slimming mutation was rejected.');
			}
			const job = await waitForJob(this.#slimming, receipt.jobId, signal, {
				cancel: true,
				settleMs: SLIMMING_CANCEL_SETTLE_TIMEOUT_MS,
				abortError: () =>
					new Error(
						'Cancelled Slimming mutation did not reach a terminal state.'
					),
			});
			if (job.status !== 'complete') throw new Error(job.message);
		} finally {
			release();
		}
	}

	#assertStep(
		step: Extract<RecipeStep, { kind: 'assert' }>,
		context: TargetContext
	): void {
		const assertion = step.assertion;
		if (assertion.condition === 'simulator.state') {
			const device = this.#simulator
				.getState()
				.devices.find(
					(candidate) =>
						candidate.udid.toUpperCase() === context.udid.toUpperCase()
				);
			if (device?.state !== assertion.expected) {
				throw new Error(
					`Expected Simulator state ${assertion.expected}; received ${device?.state ?? 'missing'}.`
				);
			}
			return;
		}
		if (assertion.condition === 'connected') {
			const connected = exactConnectedDevice(
				this.#broker.getState(),
				context.udid
			);
			if (Boolean(connected) !== assertion.expected) {
				throw new Error('Exact connected-instance assertion failed.');
			}
			return;
		}
		const device = currentDevice(this.#broker.getState(), context);
		if (assertion.condition === 'component.exists') {
			const exists = device.tools.components.some(
				(component) => component.id === assertion.componentId
			);
			if (exists !== assertion.expected)
				throw new Error('Component assertion failed.');
			return;
		}
		if (assertion.condition === 'screen.hash') {
			if (device.tools.componentSummary.screenHash !== assertion.expectedHash) {
				throw new Error('Screen hash assertion failed.');
			}
			return;
		}
		if (assertion.condition === 'network.profile') {
			const actual = device.tools.networkProfile?.active
				? device.tools.networkProfile.id
				: 'none';
			if (actual !== assertion.expectedProfileId) {
				throw new Error(
					`Expected network profile ${assertion.expectedProfileId}.`
				);
			}
			return;
		}
		if (device.tools.cameraFixture.active !== assertion.expected) {
			throw new Error('Camera fixture assertion failed.');
		}
	}

	async #waitForStep(
		step: Extract<RecipeStep, { kind: 'wait-for' }>,
		context: TargetContext,
		signal: AbortSignal
	): Promise<void> {
		const waitFor = step.waitFor;
		if (waitFor.condition === 'component.exists') {
			await this.#runBoundedDesktopWait(
				{
					tool: 'components',
					command: 'waitForElement',
					payload: { id: waitFor.componentId },
				},
				context,
				step.timeoutMs ?? 10_000,
				signal
			);
			return;
		}
		if (waitFor.condition === 'screen.change') {
			const device = currentDevice(this.#broker.getState(), context);
			const screenHash =
				waitFor.fromHash ?? device.tools.componentSummary.screenHash;
			if (!screenHash) throw new Error('No starting screen hash is available.');
			await this.#runBoundedDesktopWait(
				{
					tool: 'components',
					command: 'waitForScreenChange',
					payload: { screenHash },
				},
				context,
				step.timeoutMs ?? 10_000,
				signal
			);
			return;
		}
		let quietSince: number | undefined;
		while (!signal.aborted) {
			const device = currentDevice(this.#broker.getState(), context);
			const pending = device.tools.network.some(
				(entry) => entry.state === 'pending'
			);
			if (pending) quietSince = undefined;
			else quietSince ??= this.#now();
			if (
				quietSince !== undefined &&
				this.#now() - quietSince >= waitFor.quietMs
			) {
				return;
			}
			await waitForDelay(Math.min(100, waitFor.quietMs), signal);
		}
		throw signal.reason ?? new Error('Recipe run cancelled.');
	}

	async #runRestorePointStep(
		step: Extract<RecipeStep, { kind: 'restore-point' }>,
		context: TargetContext,
		signal: AbortSignal
	): Promise<void> {
		const device = currentDevice(this.#broker.getState(), context);
		if (step.operation === 'capture') {
			const before = new Set(
				device.tools.restorePoints.map((point) => point.id)
			);
			await this.#runDesktopAction({
				actionId: actionId(),
				deviceId: device.info.id,
				tool: 'restore',
				command: 'capture',
				payload: step.label ? { label: step.label } : {},
			});
			while (!signal.aborted) {
				const refreshed = currentDevice(this.#broker.getState(), context);
				const created = refreshed.tools.restorePoints.find(
					(point) => !before.has(point.id)
				);
				if (created) {
					context.restorePointIds.set(step.saveAs, created.id);
					return;
				}
				await waitForDelay(50, signal);
			}
			throw signal.reason ?? new Error('Recipe run cancelled.');
		}
		const restorePointId = context.restorePointIds.get(step.reference);
		if (!restorePointId)
			throw new Error('Restore-point reference was not captured.');
		await this.#runDesktopAction({
			actionId: actionId(),
			deviceId: device.info.id,
			tool: 'restore',
			command: step.operation,
			payload: { id: restorePointId },
		});
		if (step.operation === 'remove')
			context.restorePointIds.delete(step.reference);
	}

	#collectDiagnostics(
		record: RecipeRunRecord,
		context: TargetContext
	): string[] {
		const current = diagnosticIds(
			this.#broker.getState(),
			context.connectedDeviceId
		);
		const added = [...current].filter(
			(id) => !context.diagnosticBaseline.has(id)
		);
		context.diagnosticBaseline = current;
		if (added.length === 0) return [];
		const target = evidenceTarget(record, context.index);
		record.evidence.targets[context.index] = {
			...target,
			diagnosticCorrelationIds: [
				...new Set([...target.diagnosticCorrelationIds, ...added]),
			].slice(-500),
		};
		record.evidence = {
			...record.evidence,
			diagnosticCorrelationIds: [
				...new Set([...record.evidence.diagnosticCorrelationIds, ...added]),
			].slice(-2_000),
		};
		return added.slice(0, 3);
	}

	#newRecord(
		request: RecipeRunRequest,
		recipe: RecipeDefinition,
		targetUdids: string[],
		concurrency: number
	): RecipeRunRecord {
		const now = this.#now();
		const runId = `recipe-run-${randomUUID()}`;
		const evidenceId = `evidence-${randomUUID()}`;
		const cleanup = {
			status: 'not-started' as const,
			completedSteps: 0,
			totalSteps: recipe.teardown.length,
			failures: [],
		};
		const run = recipeRunSchema.parse({
			id: runId,
			actionId: request.actionId,
			recipeId: recipe.id,
			recipeRevision: recipe.revision,
			evidenceId,
			status: 'queued',
			createdAt: now,
			progressSequence: 0,
			message: 'Recipe queued.',
			concurrency,
			targetUdids,
			targets: targetUdids.map((udid) => ({
				udid,
				status: 'queued',
				completedSteps: 0,
				totalSteps: recipe.steps.length,
				message: 'Queued.',
				cleanup,
			})),
		});
		const evidence = recipeEvidenceManifestSchema.parse({
			format: 'rndevtools-evidence-bundle',
			formatVersion: RNDEVTOOLS_RECIPE_FORMAT_VERSION,
			id: evidenceId,
			runId,
			recipe: { id: recipe.id, name: recipe.name, revision: recipe.revision },
			createdAt: now,
			status: 'queued',
			targets: targetUdids.map((udid) => ({
				udid,
				status: 'queued',
				cleanupStatus: 'not-started',
				captureIds: [],
				diagnosticCorrelationIds: [],
			})),
			timeline: [],
			captureIds: [],
			diagnosticCorrelationIds: [],
		});
		return { run, evidence };
	}

	#updateTarget(
		record: RecipeRunRecord,
		index: number,
		patch: Partial<RecipeRun['targets'][number]>
	): void {
		record.run.targets[index] = {
			...runTarget(record, index),
			...patch,
			...(patch.message
				? { message: patch.message.slice(0, MAX_RUN_MESSAGE_LENGTH) }
				: {}),
		};
		record.run = {
			...record.run,
			progressSequence: record.run.progressSequence + 1,
		};
	}

	#updateCleanup(
		record: RecipeRunRecord,
		index: number,
		patch: Partial<RecipeRun['targets'][number]['cleanup']> & {
			message?: string;
		}
	): void {
		const { message, ...cleanupPatch } = patch;
		const target = runTarget(record, index);
		const preservePrimaryFailure = [
			'failed',
			'cancelled',
			'interrupted',
		].includes(target.status);
		record.run.targets[index] = {
			...target,
			...(message && !preservePrimaryFailure
				? { message: message.slice(0, MAX_RUN_MESSAGE_LENGTH) }
				: {}),
			cleanup: { ...target.cleanup, ...cleanupPatch },
		};
		record.run = {
			...record.run,
			progressSequence: record.run.progressSequence + 1,
		};
	}

	#appendTimeline(
		record: RecipeRunRecord,
		event: Omit<RecipeEvidenceManifest['timeline'][number], 'sequence' | 'at'>
	): void {
		const nextSequence = Math.min(
			(record.evidence.timeline.at(-1)?.sequence ?? -1) + 1,
			Number.MAX_SAFE_INTEGER
		);
		record.evidence = {
			...record.evidence,
			timeline: [
				...record.evidence.timeline.slice(-(MAX_EVIDENCE_TIMELINE_EVENTS - 1)),
				{
					...event,
					message: event.message.slice(0, 256),
					sequence: nextSequence,
					at: this.#now(),
				},
			],
		};
	}

	async #save(record: RecipeRunRecord): Promise<void> {
		record.run = recipeRunSchema.parse(record.run);
		record.evidence = recipeEvidenceManifestSchema.parse(record.evidence);
		await this.#store.saveRun(record);
		this.#emit();
	}

	#emit(): void {
		const state = this.getState();
		for (const listener of this.#listeners) {
			try {
				listener(state);
			} catch {
				// A consumer cannot break recipe persistence or execution.
			}
		}
	}

	#reject(request: RecipeRunRequest, error: string): RecipeRunReceipt {
		return recipeRunReceiptSchema.parse({
			actionId: request.actionId,
			accepted: false,
			error,
		});
	}
}

import { ExternalStore } from '../core/external-store';
import { diagnosticErrorText } from '../core/redact';
import { utf8ByteLength } from '../core/serialize';
import type {
	ScenarioDefinition,
	ScenarioPrecondition,
	ScenarioPreconditionType,
	ScenarioPrimitive,
	ScenarioResolvedValue,
	ScenarioStep,
	ScenarioStepType,
	ScenarioTemplateValue,
	ScenarioVariableReference,
} from './scenario';
import { parseScenarioDefinition } from './scenario';

export type ScenarioPreflightResult = Readonly<{
	summary: string;
	reversible: boolean;
	privileged?: boolean;
	warnings?: readonly string[];
}>;

export type ScenarioExecutionContext = Readonly<{
	scenario: ScenarioDefinition;
	variables: Readonly<Record<string, ScenarioPrimitive>>;
}>;

export type ScenarioPreconditionEvaluator = Readonly<{
	type: ScenarioPreconditionType;
	evaluate: (request: {
		precondition: ScenarioPrecondition;
		input: Readonly<Record<string, ScenarioResolvedValue>>;
		context: ScenarioExecutionContext;
		signal: AbortSignal;
	}) => void | Promise<void>;
}>;

export type ScenarioActionAdapter = Readonly<{
	type: ScenarioStepType;
	/** Bump when this adapter's persisted rollback value or semantics change. */
	recoveryVersion?: number;
	preflight: (request: {
		step: ScenarioStep;
		input: Readonly<Record<string, ScenarioResolvedValue>>;
		context: ScenarioExecutionContext;
		signal: AbortSignal;
	}) => ScenarioPreflightResult | Promise<ScenarioPreflightResult>;
	captureRollback?: (request: {
		step: ScenarioStep;
		input: Readonly<Record<string, ScenarioResolvedValue>>;
		context: ScenarioExecutionContext;
		signal: AbortSignal;
	}) => unknown | Promise<unknown>;
	apply: (request: {
		step: ScenarioStep;
		input: Readonly<Record<string, ScenarioResolvedValue>>;
		context: ScenarioExecutionContext;
		signal: AbortSignal;
	}) => void | Promise<void>;
	rollback?: (request: {
		step: ScenarioStep;
		input: Readonly<Record<string, ScenarioResolvedValue>>;
		rollback: unknown;
		context: ScenarioExecutionContext;
		signal: AbortSignal;
	}) => void | Promise<void>;
}>;

export type ScenarioStepReceipt = Readonly<{
	stepId: string;
	stepType: ScenarioStepType;
	label: string;
	preflight: 'pending' | 'passed' | 'failed';
	apply: 'not-run' | 'succeeded' | 'failed';
	rollback: 'not-needed' | 'succeeded' | 'failed';
	reversible?: boolean;
	privileged?: boolean;
	warnings?: readonly string[];
	summary?: string;
	error?: string;
	rollbackError?: string;
}>;

export type ScenarioExecutionStatus =
	| 'complete'
	| 'preflight-failed'
	| 'rolled-back'
	| 'needs-attention';

export type ScenarioExecutionReceipt = Readonly<{
	id: string;
	scenarioId: string;
	scenarioVersion: number;
	scenarioName: string;
	startedAt: number;
	completedAt: number;
	status: ScenarioExecutionStatus;
	stepResults: readonly ScenarioStepReceipt[];
	error?: string;
}>;

export type ActiveScenario = Readonly<{
	receiptId: string;
	scenarioId: string;
	scenarioVersion: number;
	scenarioName: string;
	activatedAt: number;
	stepCount: number;
	privileged: boolean;
	warnings: readonly string[];
	recoveryRequired: boolean;
}>;

export type ScenarioEngineSnapshot = Readonly<{
	running: boolean;
	active?: ActiveScenario;
	receipts: readonly ScenarioExecutionReceipt[];
	recoveryError?: string;
}>;

export type ScenarioExecuteOptions = Readonly<{
	variables?: Readonly<Record<string, ScenarioPrimitive>>;
	allowNonReversible?: boolean;
	allowPrivileged?: boolean;
	signal?: AbortSignal;
	timeoutMs?: number;
}>;

export type ScenarioRecoveryStorage = Readonly<{
	load: () => string | undefined;
	save: (serializedRecovery: string) => void;
	clear: () => void;
}>;

export type ScenarioEngineOptions = Readonly<{
	stepAdapters: readonly ScenarioActionAdapter[];
	preconditionEvaluators?: readonly ScenarioPreconditionEvaluator[];
	recoveryStorage?: ScenarioRecoveryStorage;
	recoveryCompatibilityId?: string;
	operationTimeoutMs?: number;
	resetQuiescenceTimeoutMs?: number;
}>;

type PreparedStep = Readonly<{
	step: ScenarioStep;
	input: Readonly<Record<string, ScenarioResolvedValue>>;
	adapter: ScenarioActionAdapter;
	preflight: ScenarioPreflightResult;
}>;

type ActiveExecution = Readonly<{
	public: ActiveScenario;
	context: ScenarioExecutionContext;
	steps: readonly PreparedStep[];
	rollbackByStepId: ReadonlyMap<string, unknown>;
	cleanupOnly: boolean;
}>;

type OperationScope = Readonly<{
	controller: AbortController;
	stop: () => void;
}>;

type RollbackResult = Readonly<{
	failed: boolean;
	failedStepIds: readonly string[];
}>;

class ScenarioOperationInterruptedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ScenarioOperationInterruptedError';
	}
}

type MutableStepReceipt = {
	stepId: string;
	stepType: ScenarioStepType;
	label: string;
	preflight: ScenarioStepReceipt['preflight'];
	apply: ScenarioStepReceipt['apply'];
	rollback: ScenarioStepReceipt['rollback'];
	reversible?: boolean;
	privileged?: boolean;
	warnings?: readonly string[];
	summary?: string;
	error?: string;
	rollbackError?: string;
};

const MAX_ADAPTERS = 50;
const MAX_RECEIPTS = 20;
const MAX_VARIABLES = 25;
const MAX_STRING_BYTES = 16 * 1024;
const MAX_RECOVERY_BYTES = 1024 * 1024;
const MAX_RECOVERY_VALUE_DEPTH = 20;
const MAX_RECOVERY_VALUE_ENTRIES = 10_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const DEFAULT_RESET_QUIESCENCE_TIMEOUT_MS = 5_000;
const MAX_OPERATION_TIMEOUT_MS = 5 * 60_000;
const RECOVERY_NAMESPACE = 'rndevtools-scenario-recovery';
let receiptSequence = 0;

function nextReceiptId(
	at: number,
	scenarioId: string,
	suffix?: string,
): string {
	receiptSequence += 1;
	return `${at.toString(36)}-${receiptSequence.toString(36)}-${scenarioId}${suffix ? `-${suffix}` : ''}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	label: string,
): void {
	const allowedKeys = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!allowedKeys.has(key))
			throw new Error(`${label} has unknown key: ${key}`);
	}
}

function boundedRecoveryText(
	value: unknown,
	label: string,
	maxBytes = 4 * 1024,
): string {
	if (
		typeof value !== 'string' ||
		!value.trim() ||
		value !== value.trim() ||
		utf8ByteLength(value) > maxBytes
	) {
		throw new Error(`${label} is invalid.`);
	}
	return value;
}

function recoveryWarnings(value: unknown): readonly string[] {
	if (!Array.isArray(value) || value.length > 100) {
		throw new Error('Scenario recovery warnings are invalid.');
	}
	return value.map((warning, index) =>
		boundedRecoveryText(warning, `Scenario recovery warning ${index + 1}`),
	);
}

function recoveryValue(
	value: unknown,
	label: string,
	state = { remaining: MAX_RECOVERY_VALUE_ENTRIES },
	depth = 0,
): ScenarioResolvedValue {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean'
	) {
		if (typeof value === 'string' && utf8ByteLength(value) > MAX_STRING_BYTES) {
			throw new Error(`${label} contains an oversized string.`);
		}
		return value;
	}
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (!value || typeof value !== 'object') {
		throw new Error(`${label} is not JSON-safe.`);
	}
	if (depth >= MAX_RECOVERY_VALUE_DEPTH) {
		throw new Error(`${label} exceeds the recovery depth limit.`);
	}
	if (Array.isArray(value)) {
		if (value.length > state.remaining) {
			throw new Error(`${label} exceeds the recovery entry limit.`);
		}
		state.remaining -= value.length;
		return value.map((entry, index) =>
			recoveryValue(entry, `${label}[${index}]`, state, depth + 1),
		);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new Error(`${label} must contain plain JSON objects.`);
	}
	const entries = Object.entries(value);
	if (entries.length > state.remaining) {
		throw new Error(`${label} exceeds the recovery entry limit.`);
	}
	state.remaining -= entries.length;
	const output = Object.create(null) as Record<string, ScenarioResolvedValue>;
	for (const [key, entry] of entries) {
		if (
			!key ||
			['__proto__', 'constructor', 'prototype'].includes(key) ||
			utf8ByteLength(key) > 256
		) {
			throw new Error(`${label} contains an unsafe key.`);
		}
		output[key] = recoveryValue(entry, `${label}.${key}`, state, depth + 1);
	}
	return output;
}

function operationTimeout(value: number | undefined, fallback: number): number {
	const candidate = value ?? fallback;
	if (
		!Number.isSafeInteger(candidate) ||
		candidate < 1 ||
		candidate > MAX_OPERATION_TIMEOUT_MS
	) {
		throw new Error(
			`Scenario timeout must be between 1 and ${MAX_OPERATION_TIMEOUT_MS} milliseconds.`,
		);
	}
	return candidate;
}

function abortMessage(signal: AbortSignal): string {
	return signal.reason instanceof Error
		? signal.reason.message
		: typeof signal.reason === 'string' && signal.reason
			? signal.reason
			: 'Scenario operation was cancelled.';
}

function copyReceipts(
	results: readonly MutableStepReceipt[],
): readonly ScenarioStepReceipt[] {
	return results.map((result) => ({ ...result }));
}

function validateAdapterRegistry<T extends { type: string }>(
	entries: readonly T[],
	label: string,
): ReadonlyMap<string, T> {
	if (!Array.isArray(entries) || entries.length > MAX_ADAPTERS) {
		throw new Error(`${label} must be a bounded array.`);
	}
	const registry = new Map<string, T>();
	for (const entry of entries) {
		if (!entry || typeof entry !== 'object' || typeof entry.type !== 'string') {
			throw new Error(`${label} entries are invalid.`);
		}
		if (registry.has(entry.type)) {
			throw new Error(`Duplicate ${label} type: ${entry.type}`);
		}
		registry.set(entry.type, entry);
	}
	return registry;
}

function resolveVariables(
	scenario: ScenarioDefinition,
	provided: Readonly<Record<string, ScenarioPrimitive>> | undefined,
): Readonly<Record<string, ScenarioPrimitive>> {
	if (provided && (typeof provided !== 'object' || Array.isArray(provided))) {
		throw new Error('Scenario variables must be an object.');
	}
	const providedEntries = Object.entries(provided ?? {});
	if (providedEntries.length > MAX_VARIABLES) {
		throw new Error('Scenario variable input exceeds the supported limit.');
	}
	const definitions = new Map(
		scenario.variables.map((variable) => [variable.id, variable]),
	);
	for (const [id] of providedEntries) {
		if (!definitions.has(id))
			throw new Error(`Unknown scenario variable: ${id}`);
	}
	const resolved = Object.create(null) as Record<string, ScenarioPrimitive>;
	for (const variable of scenario.variables) {
		const value = Object.hasOwn(provided ?? {}, variable.id)
			? provided?.[variable.id]
			: variable.defaultValue;
		if (value === undefined) {
			if (variable.required) {
				throw new Error(
					`Required scenario variable is missing: ${variable.id}`,
				);
			}
			continue;
		}
		if (typeof value !== variable.type) {
			throw new Error(`Scenario variable has wrong type: ${variable.id}`);
		}
		if (typeof value === 'string' && utf8ByteLength(value) > MAX_STRING_BYTES) {
			throw new Error(`Scenario variable is oversized: ${variable.id}`);
		}
		if (variable.options && !variable.options.includes(value)) {
			throw new Error(
				`Scenario variable is outside its options: ${variable.id}`,
			);
		}
		resolved[variable.id] = value;
	}
	return resolved;
}

function resolveTemplate(
	value: ScenarioTemplateValue,
	variables: Readonly<Record<string, ScenarioPrimitive>>,
): ScenarioResolvedValue {
	if (value === null || typeof value !== 'object') return value;
	if (Array.isArray(value)) {
		return value.map((entry) => resolveTemplate(entry, variables));
	}
	if ((value as ScenarioVariableReference).kind === 'variable') {
		const variableId = (value as ScenarioVariableReference).variableId;
		if (!Object.hasOwn(variables, variableId)) {
			throw new Error(`Scenario variable has no resolved value: ${variableId}`);
		}
		return variables[variableId] ?? null;
	}
	const output = Object.create(null) as Record<string, ScenarioResolvedValue>;
	for (const [key, entry] of Object.entries(value)) {
		output[key] = resolveTemplate(entry, variables);
	}
	return output;
}

function stepLabel(step: ScenarioStep): string {
	return step.label ?? `${step.type}: ${step.id}`;
}

export class ScenarioEngine {
	readonly #stepAdapters: ReadonlyMap<string, ScenarioActionAdapter>;
	readonly #preconditionEvaluators: ReadonlyMap<
		string,
		ScenarioPreconditionEvaluator
	>;
	readonly #recoveryStorage?: ScenarioRecoveryStorage;
	readonly #recoveryCompatibilityId?: string;
	readonly #operationTimeoutMs: number;
	readonly #resetQuiescenceTimeoutMs: number;
	readonly #store = new ExternalStore<ScenarioEngineSnapshot>({
		running: false,
		receipts: [],
	});
	#activeExecution?: ActiveExecution;
	#operationScope?: OperationScope;
	readonly #unsettledCallbacks = new Set<Promise<unknown>>();

	constructor(options: ScenarioEngineOptions) {
		this.#stepAdapters = validateAdapterRegistry(
			options.stepAdapters,
			'Scenario action adapters',
		) as ReadonlyMap<string, ScenarioActionAdapter>;
		this.#preconditionEvaluators = validateAdapterRegistry(
			options.preconditionEvaluators ?? [],
			'Scenario precondition evaluators',
		) as ReadonlyMap<string, ScenarioPreconditionEvaluator>;
		this.#operationTimeoutMs = operationTimeout(
			options.operationTimeoutMs,
			DEFAULT_OPERATION_TIMEOUT_MS,
		);
		this.#resetQuiescenceTimeoutMs = operationTimeout(
			options.resetQuiescenceTimeoutMs,
			DEFAULT_RESET_QUIESCENCE_TIMEOUT_MS,
		);
		this.#recoveryStorage = options.recoveryStorage;
		this.#recoveryCompatibilityId = options.recoveryStorage
			? boundedRecoveryText(
					options.recoveryCompatibilityId,
					'Scenario recovery compatibility id',
					256,
				)
			: undefined;
		if (this.#recoveryStorage) {
			try {
				const stored = this.#recoveryStorage.load();
				if (stored !== undefined) {
					this.#activeExecution = this.#parseRecovery(stored);
					this.#store.set({
						running: false,
						active: this.#activeExecution.public,
						receipts: [],
					});
				}
			} catch (error) {
				this.#store.set({
					running: false,
					receipts: [],
					recoveryError: `Stored scenario recovery could not be loaded: ${diagnosticErrorText(error)}`,
				});
			}
		}
	}

	readonly subscribe = (listener: () => void): (() => void) =>
		this.#store.subscribe(listener);

	readonly getSnapshot = (): ScenarioEngineSnapshot =>
		this.#store.getSnapshot();

	readonly getServerSnapshot = (): ScenarioEngineSnapshot =>
		this.#store.getServerSnapshot();

	readonly cancel = (reason = 'Scenario operation was cancelled.'): boolean => {
		const scope = this.#operationScope;
		if (!scope || scope.controller.signal.aborted) return false;
		scope.controller.abort(new Error(reason));
		return true;
	};

	readonly discardRecovery = (): Promise<void> =>
		this.#discardRecovery({ storageWillBeClearedByOwner: false });

	readonly invalidateRecoveryForReset = (): Promise<void> =>
		this.#discardRecovery({ storageWillBeClearedByOwner: true });

	readonly quiesceForAppReset = (): Promise<void> => this.#quiesceForAppReset();

	async #discardRecovery(options: {
		storageWillBeClearedByOwner: boolean;
	}): Promise<void> {
		await this.#quiesceForAppReset();
		try {
			this.#clearRecovery();
		} catch (error) {
			if (!options.storageWillBeClearedByOwner) throw error;
			// The application reset owner clears the entire dedicated store after
			// this method proves that all callbacks have quiesced.
		}
		this.#activeExecution = undefined;
		const current = this.#store.getSnapshot();
		this.#store.set({
			running: current.running,
			receipts: current.receipts,
		});
	}

	async #quiesceForAppReset(): Promise<void> {
		this.cancel('Scenario recovery was invalidated by an application reset.');
		// A callback that ignores AbortSignal may still mutate host state after the
		// cancellation race resolves. Full-reset owners await this method before
		// clearing app/auth state, so late adapter work cannot repopulate a reset
		// store or identity after teardown.
		if (this.#unsettledCallbacks.size > 0) {
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					Promise.allSettled([...this.#unsettledCallbacks]),
					new Promise<never>((_resolve, reject) => {
						timeout = setTimeout(
							() =>
								reject(
									new Error(
										`Scenario reset could not safely quiesce an adapter within ${this.#resetQuiescenceTimeoutMs} milliseconds. Recovery remains quarantined.`,
									),
								),
							this.#resetQuiescenceTimeoutMs,
						);
					}),
				]);
			} finally {
				if (timeout) clearTimeout(timeout);
			}
		}
	}

	async execute(
		scenario: ScenarioDefinition,
		options: ScenarioExecuteOptions = {},
	): Promise<ScenarioExecutionReceipt> {
		const current = this.#store.getSnapshot();
		if (current.running)
			throw new Error('Another scenario operation is running.');
		if (this.#unsettledCallbacks.size > 0) {
			throw new Error(
				'A previously interrupted scenario adapter is still settling.',
			);
		}
		if (current.recoveryError) {
			throw new Error(
				'Scenario recovery data needs attention before another scenario can run.',
			);
		}
		if (current.active) {
			throw new Error(
				`Scenario ${current.active.scenarioName} is active. Undo it before running another scenario.`,
			);
		}
		this.#setRunning(true);
		const startedAt = Date.now();
		const receiptId = nextReceiptId(startedAt, scenario.id);
		const results: MutableStepReceipt[] = scenario.steps.map((step) => ({
			stepId: step.id,
			stepType: step.type,
			label: stepLabel(step),
			preflight: 'pending',
			apply: 'not-run',
			rollback: 'not-needed',
		}));
		const resultById = new Map(
			results.map((result) => [result.stepId, result]),
		);
		try {
			let variables: Readonly<Record<string, ScenarioPrimitive>>;
			try {
				variables = resolveVariables(scenario, options.variables);
			} catch (error) {
				return this.#finish({
					id: receiptId,
					scenarioId: scenario.id,
					scenarioVersion: scenario.version,
					scenarioName: scenario.name,
					startedAt,
					completedAt: Date.now(),
					status: 'preflight-failed',
					stepResults: copyReceipts(results),
					error: diagnosticErrorText(error),
				});
			}
			const context: ScenarioExecutionContext = { scenario, variables };
			for (const precondition of scenario.preconditions) {
				const evaluator = this.#preconditionEvaluators.get(precondition.type);
				if (!evaluator) {
					return this.#finish({
						id: receiptId,
						scenarioId: scenario.id,
						scenarioVersion: scenario.version,
						scenarioName: scenario.name,
						startedAt,
						completedAt: Date.now(),
						status: 'preflight-failed',
						stepResults: copyReceipts(results),
						error: `No evaluator is registered for precondition ${precondition.type}.`,
					});
				}
				try {
					await this.#runBounded(
						(signal) =>
							evaluator.evaluate({
								precondition,
								input: resolveTemplate(
									precondition.input,
									variables,
								) as Readonly<Record<string, ScenarioResolvedValue>>,
								context,
								signal,
							}),
						options,
					);
				} catch (error) {
					return this.#finish({
						id: receiptId,
						scenarioId: scenario.id,
						scenarioVersion: scenario.version,
						scenarioName: scenario.name,
						startedAt,
						completedAt: Date.now(),
						status: 'preflight-failed',
						stepResults: copyReceipts(results),
						error: `Precondition ${precondition.id} failed: ${diagnosticErrorText(error)}`,
					});
				}
			}

			const prepared: PreparedStep[] = [];
			for (const step of scenario.steps) {
				const result = resultById.get(step.id);
				const adapter = this.#stepAdapters.get(step.type);
				if (!adapter) {
					if (result) {
						result.preflight = 'failed';
						result.error = `No adapter is registered for ${step.type}.`;
					}
					return this.#finish({
						id: receiptId,
						scenarioId: scenario.id,
						scenarioVersion: scenario.version,
						scenarioName: scenario.name,
						startedAt,
						completedAt: Date.now(),
						status: 'preflight-failed',
						stepResults: copyReceipts(results),
						error: result?.error,
					});
				}
				try {
					const input = resolveTemplate(step.input, variables) as Readonly<
						Record<string, ScenarioResolvedValue>
					>;
					const preflight = await this.#runBounded(
						(signal) => adapter.preflight({ step, input, context, signal }),
						options,
					);
					if (
						preflight.reversible &&
						(!adapter.captureRollback || !adapter.rollback)
					) {
						throw new Error(
							`${step.type} declared a reversible step without rollback support.`,
						);
					}
					if (
						this.#recoveryStorage &&
						(!Number.isSafeInteger(adapter.recoveryVersion) ||
							Number(adapter.recoveryVersion) < 1)
					) {
						throw new Error(
							`${step.type} must declare a positive recoveryVersion for durable recovery.`,
						);
					}
					if (!preflight.reversible && !options.allowNonReversible) {
						throw new Error(
							`${stepLabel(step)} is non-reversible and requires explicit approval.`,
						);
					}
					if (preflight.privileged && !options.allowPrivileged) {
						throw new Error(
							`${stepLabel(step)} is privileged and requires explicit approval.`,
						);
					}
					if (result) {
						result.preflight = 'passed';
						result.reversible = preflight.reversible;
						result.privileged = preflight.privileged;
						result.warnings = preflight.warnings;
					}
					prepared.push({ step, input, adapter, preflight });
				} catch (error) {
					if (result) {
						result.preflight = 'failed';
						result.error = diagnosticErrorText(error);
					}
					return this.#finish({
						id: receiptId,
						scenarioId: scenario.id,
						scenarioVersion: scenario.version,
						scenarioName: scenario.name,
						startedAt,
						completedAt: Date.now(),
						status: 'preflight-failed',
						stepResults: copyReceipts(results),
						error: `Preflight failed for ${stepLabel(step)}: ${diagnosticErrorText(error)}`,
					});
				}
			}

			const rollbackByStepId = new Map<string, unknown>();
			for (const preparedStep of prepared) {
				if (!preparedStep.preflight.reversible) continue;
				try {
					rollbackByStepId.set(
						preparedStep.step.id,
						await this.#runBounded(
							(signal) =>
								preparedStep.adapter.captureRollback?.({
									step: preparedStep.step,
									input: preparedStep.input,
									context,
									signal,
								}),
							options,
						),
					);
				} catch (error) {
					const result = resultById.get(preparedStep.step.id);
					if (result) {
						result.preflight = 'failed';
						result.error = diagnosticErrorText(error);
					}
					return this.#finish({
						id: receiptId,
						scenarioId: scenario.id,
						scenarioVersion: scenario.version,
						scenarioName: scenario.name,
						startedAt,
						completedAt: Date.now(),
						status: 'preflight-failed',
						stepResults: copyReceipts(results),
						error: `Rollback capture failed for ${stepLabel(preparedStep.step)}: ${diagnosticErrorText(error)}`,
					});
				}
			}

			const warnings = prepared.flatMap(
				(preparedStep) => preparedStep.preflight.warnings ?? [],
			);
			const recovering: ActiveExecution = {
				public: {
					receiptId,
					scenarioId: scenario.id,
					scenarioVersion: scenario.version,
					scenarioName: scenario.name,
					activatedAt: Date.now(),
					stepCount: prepared.length,
					privileged: prepared.some(
						(preparedStep) => preparedStep.preflight.privileged === true,
					),
					warnings,
					recoveryRequired: true,
				},
				context,
				steps: prepared,
				rollbackByStepId,
				cleanupOnly: false,
			};
			const attempted: PreparedStep[] = [];
			let applyError: string | undefined;
			let applyInterrupted = false;
			for (const preparedStep of prepared) {
				const result = resultById.get(preparedStep.step.id);
				const nextAttempted = [...attempted, preparedStep];
				const checkpoint = this.#recoveryForAttemptedSteps(
					recovering,
					nextAttempted,
				);
				try {
					// The current step is journaled before apply so a crash after a
					// partial side effect conservatively treats it as attempted. Later
					// steps are deliberately absent until their own apply begins.
					this.#saveRecovery(checkpoint);
					this.#activeExecution = checkpoint;
				} catch (error) {
					applyError = `Recovery checkpoint could not be saved before mutation: ${diagnosticErrorText(error)}`;
					if (result) {
						result.apply = 'failed';
						result.error = applyError;
					}
					break;
				}
				attempted.push(preparedStep);
				try {
					await this.#runBounded(
						(signal) =>
							preparedStep.adapter.apply({
								step: preparedStep.step,
								input: preparedStep.input,
								context,
								signal,
							}),
						options,
					);
					if (result) {
						result.apply = 'succeeded';
						result.summary = preparedStep.preflight.summary;
					}
				} catch (error) {
					applyError = diagnosticErrorText(error);
					applyInterrupted = error instanceof ScenarioOperationInterruptedError;
					if (result) {
						result.apply = 'failed';
						result.error = applyError;
					}
					break;
				}
			}
			if (applyError) {
				if (attempted.length === 0) {
					this.#activeExecution = undefined;
					return this.#finish({
						id: receiptId,
						scenarioId: scenario.id,
						scenarioVersion: scenario.version,
						scenarioName: scenario.name,
						startedAt,
						completedAt: Date.now(),
						status: 'preflight-failed',
						stepResults: copyReceipts(results),
						error: applyError,
					});
				}
				if (applyInterrupted) {
					return this.#finish({
						id: receiptId,
						scenarioId: scenario.id,
						scenarioVersion: scenario.version,
						scenarioName: scenario.name,
						startedAt,
						completedAt: Date.now(),
						status: 'needs-attention',
						stepResults: copyReceipts(results),
						error: `${applyError} Recovery remains available; wait for the interrupted adapter to settle before undoing.`,
					});
				}
				const rollback = await this.#rollback(
					attempted,
					rollbackByStepId,
					context,
					resultById,
				);
				let cleanupError: string | undefined;
				if (rollback.failed) {
					this.#activeExecution = this.#recoveryForFailedSteps(
						recovering,
						rollback.failedStepIds,
					);
					try {
						this.#saveRecovery(this.#activeExecution);
					} catch (error) {
						cleanupError = `Unresolved recovery could not be checkpointed: ${diagnosticErrorText(error)}`;
					}
				} else {
					try {
						this.#clearRecovery();
						this.#activeExecution = undefined;
					} catch (error) {
						cleanupError = `Recovery checkpoint cleanup failed: ${diagnosticErrorText(error)}`;
						this.#activeExecution = this.#cleanupPending(recovering);
						try {
							this.#saveRecovery(this.#activeExecution);
						} catch (saveError) {
							cleanupError += ` Cleanup-only state could not be checkpointed: ${diagnosticErrorText(saveError)}`;
						}
					}
				}
				return this.#finish({
					id: receiptId,
					scenarioId: scenario.id,
					scenarioVersion: scenario.version,
					scenarioName: scenario.name,
					startedAt,
					completedAt: Date.now(),
					status:
						rollback.failed || cleanupError ? 'needs-attention' : 'rolled-back',
					stepResults: copyReceipts(results),
					error: cleanupError ? `${applyError} ${cleanupError}` : applyError,
				});
			}

			const active: ActiveExecution = {
				public: { ...recovering.public, recoveryRequired: false },
				context,
				steps: prepared,
				rollbackByStepId,
				cleanupOnly: false,
			};
			try {
				this.#saveRecovery(active);
				this.#activeExecution = active;
			} catch (error) {
				return this.#finish({
					id: receiptId,
					scenarioId: scenario.id,
					scenarioVersion: scenario.version,
					scenarioName: scenario.name,
					startedAt,
					completedAt: Date.now(),
					status: 'needs-attention',
					stepResults: copyReceipts(results),
					error: `Scenario applied, but its final recovery checkpoint could not be saved: ${diagnosticErrorText(error)}`,
				});
			}
			return this.#finish({
				id: receiptId,
				scenarioId: scenario.id,
				scenarioVersion: scenario.version,
				scenarioName: scenario.name,
				startedAt,
				completedAt: Date.now(),
				status: 'complete',
				stepResults: copyReceipts(results),
			});
		} finally {
			this.#setRunning(false);
		}
	}

	async undo(expectedReceiptId: string): Promise<ScenarioExecutionReceipt> {
		const current = this.#store.getSnapshot();
		if (current.running)
			throw new Error('Another scenario operation is running.');
		if (this.#unsettledCallbacks.size > 0) {
			throw new Error(
				'An interrupted scenario adapter is still settling; recovery is quarantined.',
			);
		}
		const active = this.#activeExecution;
		if (!active) throw new Error('No active scenario is available to undo.');
		if (active.public.receiptId !== expectedReceiptId) {
			throw new Error(
				'The active scenario changed after confirmation. Review it and try again.',
			);
		}
		this.#setRunning(true);
		const startedAt = Date.now();
		const results: MutableStepReceipt[] = active.steps.map((preparedStep) => ({
			stepId: preparedStep.step.id,
			stepType: preparedStep.step.type,
			label: stepLabel(preparedStep.step),
			preflight: 'passed',
			apply: 'not-run',
			rollback: 'not-needed',
			reversible: preparedStep.preflight.reversible,
		}));
		const resultById = new Map(
			results.map((result) => [result.stepId, result]),
		);
		try {
			const rollback = active.cleanupOnly
				? { failed: false, failedStepIds: [] }
				: await this.#rollback(
						[...active.steps],
						active.rollbackByStepId,
						active.context,
						resultById,
					);
			let cleanupError: string | undefined;
			if (rollback.failed) {
				this.#activeExecution = this.#recoveryForFailedSteps(
					active,
					rollback.failedStepIds,
				);
				try {
					this.#saveRecovery(this.#activeExecution);
				} catch (error) {
					cleanupError = `Unresolved recovery could not be checkpointed: ${diagnosticErrorText(error)}`;
				}
			} else {
				try {
					this.#clearRecovery();
					this.#activeExecution = undefined;
				} catch (error) {
					cleanupError = diagnosticErrorText(error);
					this.#activeExecution = this.#cleanupPending(active);
					try {
						this.#saveRecovery(this.#activeExecution);
					} catch (saveError) {
						cleanupError += ` Cleanup-only state could not be checkpointed: ${diagnosticErrorText(saveError)}`;
					}
				}
			}
			return this.#finish({
				id: nextReceiptId(startedAt, active.public.scenarioId, 'undo'),
				scenarioId: active.public.scenarioId,
				scenarioVersion: active.public.scenarioVersion,
				scenarioName: `${active.public.scenarioName} undo`,
				startedAt,
				completedAt: Date.now(),
				status:
					rollback.failed || cleanupError ? 'needs-attention' : 'complete',
				stepResults: copyReceipts(results),
				...(rollback.failed
					? {
							error: cleanupError
								? `One or more scenario rollback steps failed. ${cleanupError}`
								: 'One or more scenario rollback steps failed.',
						}
					: cleanupError
						? { error: `Recovery checkpoint cleanup failed: ${cleanupError}` }
						: {}),
			});
		} finally {
			this.#setRunning(false);
		}
	}

	async #rollback(
		attempted: readonly PreparedStep[],
		rollbackByStepId: ReadonlyMap<string, unknown>,
		context: ScenarioExecutionContext,
		resultById: ReadonlyMap<string, MutableStepReceipt>,
	): Promise<RollbackResult> {
		const failedStepIds: string[] = [];
		const rollbackOrder = [...attempted].reverse();
		for (const [index, preparedStep] of rollbackOrder.entries()) {
			const result = resultById.get(preparedStep.step.id);
			if (!preparedStep.preflight.reversible) {
				failedStepIds.push(preparedStep.step.id);
				if (result) {
					result.rollback = 'failed';
					result.rollbackError = 'Step is non-reversible.';
				}
				continue;
			}
			try {
				await this.#runBounded((signal) =>
					preparedStep.adapter.rollback?.({
						step: preparedStep.step,
						input: preparedStep.input,
						rollback: rollbackByStepId.get(preparedStep.step.id),
						context,
						signal,
					}),
				);
				if (result) result.rollback = 'succeeded';
			} catch (error) {
				failedStepIds.push(preparedStep.step.id);
				if (result) {
					result.rollback = 'failed';
					result.rollbackError = diagnosticErrorText(error);
				}
				if (error instanceof ScenarioOperationInterruptedError) {
					// A timed-out adapter may have ignored AbortSignal and still be
					// mutating. Starting an earlier rollback now would violate reverse
					// ordering, so quarantine the entire unattempted remainder.
					for (const pending of rollbackOrder.slice(index + 1)) {
						failedStepIds.push(pending.step.id);
						const pendingResult = resultById.get(pending.step.id);
						if (pendingResult) {
							pendingResult.rollback = 'failed';
							pendingResult.rollbackError =
								'Rollback was not started because a later rollback is still settling.';
						}
					}
					break;
				}
			}
		}
		return { failed: failedStepIds.length > 0, failedStepIds };
	}

	#recoveryForAttemptedSteps(
		active: ActiveExecution,
		steps: readonly PreparedStep[],
	): ActiveExecution {
		return {
			...active,
			public: {
				...active.public,
				stepCount: steps.length,
				recoveryRequired: true,
			},
			steps,
			cleanupOnly: false,
		};
	}

	#recoveryForFailedSteps(
		active: ActiveExecution,
		failedStepIds: readonly string[],
	): ActiveExecution {
		const failed = new Set(failedStepIds);
		const steps = active.steps.filter((preparedStep) =>
			failed.has(preparedStep.step.id),
		);
		return {
			...active,
			public: {
				...active.public,
				stepCount: steps.length,
				recoveryRequired: true,
			},
			steps,
			cleanupOnly: false,
		};
	}

	#cleanupPending(active: ActiveExecution): ActiveExecution {
		return {
			...active,
			public: {
				...active.public,
				stepCount: 0,
				recoveryRequired: true,
			},
			steps: [],
			cleanupOnly: true,
		};
	}

	async #runBounded<T>(
		callback: (signal: AbortSignal) => T | Promise<T>,
		options: Pick<ScenarioExecuteOptions, 'signal' | 'timeoutMs'> = {},
	): Promise<T> {
		const controller = new AbortController();
		const timeoutMs = operationTimeout(
			options.timeoutMs,
			this.#operationTimeoutMs,
		);
		const onExternalAbort = () =>
			controller.abort(
				options.signal?.reason ??
					new Error('Scenario operation was cancelled.'),
			);
		if (options.signal?.aborted) onExternalAbort();
		else
			options.signal?.addEventListener('abort', onExternalAbort, {
				once: true,
			});
		const timeout = setTimeout(
			() =>
				controller.abort(
					new Error(
						`Scenario operation timed out after ${timeoutMs} milliseconds.`,
					),
				),
			timeoutMs,
		);
		const stop = () => {
			clearTimeout(timeout);
			options.signal?.removeEventListener('abort', onExternalAbort);
		};
		const scope: OperationScope = { controller, stop };
		this.#operationScope = scope;
		try {
			if (controller.signal.aborted) {
				throw new ScenarioOperationInterruptedError(
					abortMessage(controller.signal),
				);
			}
			const task = Promise.resolve().then(() => callback(controller.signal));
			this.#unsettledCallbacks.add(task);
			void task.then(
				() => this.#unsettledCallbacks.delete(task),
				() => this.#unsettledCallbacks.delete(task),
			);
			const aborted = new Promise<never>((_resolve, reject) => {
				controller.signal.addEventListener(
					'abort',
					() =>
						reject(
							new ScenarioOperationInterruptedError(
								abortMessage(controller.signal),
							),
						),
					{ once: true },
				);
			});
			return await Promise.race([task, aborted]);
		} finally {
			stop();
			if (this.#operationScope === scope) this.#operationScope = undefined;
		}
	}

	#saveRecovery(active: ActiveExecution): void {
		if (!this.#recoveryStorage) return;
		const serialized = JSON.stringify({
			schemaVersion: 2,
			namespace: RECOVERY_NAMESPACE,
			compatibilityId: this.#recoveryCompatibilityId,
			receiptId: active.public.receiptId,
			activatedAt: active.public.activatedAt,
			recoveryRequired: active.public.recoveryRequired,
			cleanupOnly: active.cleanupOnly,
			scenario: active.context.scenario,
			variables: active.context.variables,
			steps: active.steps.map((preparedStep) => {
				const stepId = preparedStep.step.id;
				const rollback = active.rollbackByStepId.get(stepId);
				return {
					stepId,
					adapterRecoveryVersion: preparedStep.adapter.recoveryVersion,
					preflight: preparedStep.preflight,
					...(rollback === undefined
						? {}
						: {
								rollback: recoveryValue(
									rollback,
									`Scenario recovery rollback ${stepId}`,
								),
							}),
				};
			}),
		});
		if (utf8ByteLength(serialized) > MAX_RECOVERY_BYTES) {
			throw new Error('Scenario recovery checkpoint exceeds its byte limit.');
		}
		this.#recoveryStorage.save(serialized);
	}

	#clearRecovery(): void {
		this.#recoveryStorage?.clear();
	}

	#parseRecovery(serialized: string): ActiveExecution {
		if (
			typeof serialized !== 'string' ||
			utf8ByteLength(serialized) > MAX_RECOVERY_BYTES
		) {
			throw new Error('Scenario recovery checkpoint exceeds its byte limit.');
		}
		const raw: unknown = JSON.parse(serialized);
		if (!isRecord(raw)) throw new Error('Scenario recovery must be an object.');
		assertExactKeys(
			raw,
			[
				'schemaVersion',
				'namespace',
				'compatibilityId',
				'receiptId',
				'activatedAt',
				'recoveryRequired',
				'cleanupOnly',
				'scenario',
				'variables',
				'steps',
			],
			'Scenario recovery',
		);
		if (raw.schemaVersion !== 2 || raw.namespace !== RECOVERY_NAMESPACE) {
			throw new Error('Scenario recovery version is unsupported.');
		}
		if (raw.compatibilityId !== this.#recoveryCompatibilityId) {
			throw new Error(
				'Scenario recovery was created by an incompatible app or adapter build.',
			);
		}
		const receiptId = boundedRecoveryText(
			raw.receiptId,
			'Scenario recovery receipt',
		);
		if (!Number.isSafeInteger(raw.activatedAt) || Number(raw.activatedAt) < 0) {
			throw new Error('Scenario recovery activation time is invalid.');
		}
		if (typeof raw.recoveryRequired !== 'boolean') {
			throw new Error('Scenario recovery state is invalid.');
		}
		if (typeof raw.cleanupOnly !== 'boolean') {
			throw new Error('Scenario recovery cleanup state is invalid.');
		}
		const scenario = parseScenarioDefinition(raw.scenario);
		if (!isRecord(raw.variables)) {
			throw new Error('Scenario recovery variables are invalid.');
		}
		const variables = resolveVariables(
			scenario,
			raw.variables as Readonly<Record<string, ScenarioPrimitive>>,
		);
		if (
			!Array.isArray(raw.steps) ||
			(raw.cleanupOnly ? raw.steps.length !== 0 : raw.steps.length < 1) ||
			raw.steps.length > scenario.steps.length
		) {
			throw new Error('Scenario recovery steps do not match the scenario.');
		}
		const storedSteps = raw.steps;
		const context: ScenarioExecutionContext = { scenario, variables };
		const rollbackByStepId = new Map<string, unknown>();
		const scenarioStepById = new Map(
			scenario.steps.map((step, index) => [step.id, { step, index }]),
		);
		const recoveredIds = new Set<string>();
		let previousScenarioIndex = -1;
		const prepared = storedSteps.map((storedStep, index): PreparedStep => {
			if (!isRecord(storedStep)) {
				throw new Error(`Scenario recovery step ${index + 1} is invalid.`);
			}
			assertExactKeys(
				storedStep,
				['stepId', 'adapterRecoveryVersion', 'preflight', 'rollback'],
				`Scenario recovery step ${index + 1}`,
			);
			const stepId = boundedRecoveryText(
				storedStep.stepId,
				`Scenario recovery step id ${index + 1}`,
			);
			const matchedStep = scenarioStepById.get(stepId);
			if (
				!matchedStep ||
				recoveredIds.has(stepId) ||
				matchedStep.index <= previousScenarioIndex ||
				!isRecord(storedStep.preflight)
			) {
				throw new Error(`Scenario recovery step ${index + 1} does not match.`);
			}
			recoveredIds.add(stepId);
			previousScenarioIndex = matchedStep.index;
			const step = matchedStep.step;
			assertExactKeys(
				storedStep.preflight,
				['summary', 'reversible', 'privileged', 'warnings'],
				`Scenario recovery preflight ${index + 1}`,
			);
			const summary = boundedRecoveryText(
				storedStep.preflight.summary,
				`Scenario recovery summary ${index + 1}`,
			);
			if (typeof storedStep.preflight.reversible !== 'boolean') {
				throw new Error(`Scenario recovery step ${index + 1} is invalid.`);
			}
			if (
				storedStep.preflight.privileged !== undefined &&
				typeof storedStep.preflight.privileged !== 'boolean'
			) {
				throw new Error(`Scenario recovery step ${index + 1} is invalid.`);
			}
			const adapter = this.#stepAdapters.get(step.type);
			if (!adapter) {
				throw new Error(
					`No adapter is registered for recovered step ${step.type}.`,
				);
			}
			if (
				!Number.isSafeInteger(storedStep.adapterRecoveryVersion) ||
				storedStep.adapterRecoveryVersion !== adapter.recoveryVersion
			) {
				throw new Error(
					`Recovered step ${step.type} has an incompatible adapter recovery version.`,
				);
			}
			const reversible = storedStep.preflight.reversible;
			if (reversible && (!adapter.captureRollback || !adapter.rollback)) {
				throw new Error(`Recovered step ${step.type} has no rollback support.`);
			}
			if (Object.hasOwn(storedStep, 'rollback')) {
				rollbackByStepId.set(
					step.id,
					recoveryValue(
						storedStep.rollback,
						`Scenario recovery rollback ${index + 1}`,
					),
				);
			}
			return {
				step,
				input: resolveTemplate(step.input, variables) as Readonly<
					Record<string, ScenarioResolvedValue>
				>,
				adapter,
				preflight: {
					summary,
					reversible,
					...(typeof storedStep.preflight.privileged === 'boolean'
						? { privileged: storedStep.preflight.privileged }
						: {}),
					...(storedStep.preflight.warnings === undefined
						? {}
						: { warnings: recoveryWarnings(storedStep.preflight.warnings) }),
				},
			};
		});
		const warnings = prepared.flatMap(
			(preparedStep) => preparedStep.preflight.warnings ?? [],
		);
		return {
			public: {
				receiptId,
				scenarioId: scenario.id,
				scenarioVersion: scenario.version,
				scenarioName: scenario.name,
				activatedAt: Number(raw.activatedAt),
				stepCount: prepared.length,
				privileged: prepared.some(
					(preparedStep) => preparedStep.preflight.privileged === true,
				),
				warnings,
				recoveryRequired: raw.recoveryRequired,
			},
			context,
			steps: prepared,
			rollbackByStepId,
			cleanupOnly: raw.cleanupOnly,
		};
	}

	#finish(receipt: ScenarioExecutionReceipt): ScenarioExecutionReceipt {
		const current = this.#store.getSnapshot();
		this.#store.set({
			running: current.running,
			...(this.#activeExecution
				? { active: this.#activeExecution.public }
				: {}),
			receipts: [...current.receipts, receipt].slice(-MAX_RECEIPTS),
			...(current.recoveryError
				? { recoveryError: current.recoveryError }
				: {}),
		});
		return receipt;
	}

	#setRunning(running: boolean): void {
		const current = this.#store.getSnapshot();
		this.#store.set({
			running,
			...(this.#activeExecution
				? { active: this.#activeExecution.public }
				: {}),
			receipts: current.receipts,
			...(current.recoveryError
				? { recoveryError: current.recoveryError }
				: {}),
		});
	}
}

import { ExternalStore } from '../core/external-store';
import { utf8ByteLength } from '../core/serialize';
import type { RestorePointStorage } from './restore-points';
import {
	DEFAULT_SCENARIO_DEFINITION_LIMITS,
	DEFAULT_SCENARIO_USER_LIMIT,
	parseScenarioDefinition,
	parseScenarioJson,
	SCENARIO_SCHEMA_VERSION,
	type ScenarioDefinition,
	type ScenarioDefinitionLimits,
} from './scenario';

export const DEFAULT_SCENARIO_REPOSITORY_KEY =
	'@rndevtools/core/scenario-definitions/v1';

export type ScenarioRepositorySnapshot = Readonly<{
	bundled: readonly ScenarioDefinition[];
	user: readonly ScenarioDefinition[];
	all: readonly ScenarioDefinition[];
}>;

export type ScenarioRepositoryOptions = Readonly<{
	bundled?: readonly ScenarioDefinition[];
	storage?: RestorePointStorage;
	key?: string;
	maxUserScenarios?: number;
	maxTotalBytes?: number;
	limits?: ScenarioDefinitionLimits;
}>;

export type ScenarioImportMode = 'replace' | 'merge';

export type ScenarioDefinitionTarget = Readonly<{
	id: string;
	version: number;
	definitionToken: string;
}>;

type PersistedScenarioDocument = Readonly<{
	schemaVersion: 1;
	namespace: 'rndevtools-scenarios';
	scenarios: readonly ScenarioDefinition[];
}>;

const MAX_USER_SCENARIOS = 50;
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
let definitionTokenSequence = 0;

function nextDefinitionToken(): string {
	definitionTokenSequence += 1;
	return `${Date.now().toString(36)}-${definitionTokenSequence.toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function freezeScenarioValue<T>(value: T): T {
	if (!value || typeof value !== 'object' || Object.isFrozen(value))
		return value;
	for (const nested of Object.values(value)) freezeScenarioValue(nested);
	return Object.freeze(value);
}

function freezeScenarioDefinition(
	definition: ScenarioDefinition,
): ScenarioDefinition {
	return freezeScenarioValue(definition);
}

function documentFor(
	scenarios: readonly ScenarioDefinition[],
): PersistedScenarioDocument {
	return {
		schemaVersion: SCENARIO_SCHEMA_VERSION,
		namespace: 'rndevtools-scenarios',
		scenarios,
	};
}

function parseDocument(
	value: string,
	limits: ScenarioDefinitionLimits,
	allowPartial: boolean,
): { scenarios: readonly ScenarioDefinition[]; discarded: number } {
	if (!value || utf8ByteLength(value) > MAX_DOCUMENT_BYTES) {
		throw new Error('Scenario document is empty or oversized.');
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error('Scenario document is malformed.');
	}
	if (
		!parsed ||
		typeof parsed !== 'object' ||
		Array.isArray(parsed) ||
		(parsed as Record<string, unknown>).schemaVersion !== 1 ||
		(parsed as Record<string, unknown>).namespace !== 'rndevtools-scenarios' ||
		!Array.isArray((parsed as Record<string, unknown>).scenarios)
	) {
		throw new Error('Scenario document has an unsupported schema.');
	}
	const candidates = (parsed as { scenarios: unknown[] }).scenarios;
	if (candidates.length > MAX_USER_SCENARIOS) {
		throw new Error('Scenario document exceeds the scenario-count limit.');
	}
	const scenarios: ScenarioDefinition[] = [];
	const ids = new Set<string>();
	let discarded = 0;
	for (const candidate of candidates) {
		try {
			const scenario = parseScenarioDefinition(candidate, limits);
			if (ids.has(scenario.id)) throw new Error('Duplicate scenario id.');
			ids.add(scenario.id);
			scenarios.push(freezeScenarioDefinition(scenario));
		} catch (error) {
			if (!allowPartial) throw error;
			discarded += 1;
		}
	}
	return { scenarios, discarded };
}

export class ScenarioRepository {
	readonly #store: ExternalStore<ScenarioRepositorySnapshot>;
	readonly #bundled: readonly ScenarioDefinition[];
	readonly #bundledIds: ReadonlySet<string>;
	readonly #storage?: RestorePointStorage;
	readonly #key: string;
	readonly #maxUserScenarios: number;
	readonly #maxTotalBytes: number;
	readonly #limits: ScenarioDefinitionLimits;
	readonly #definitionTokens = new Map<string, string>();
	#serial: Promise<void> = Promise.resolve();
	#loadError?: string;
	readonly ready: Promise<void>;

	constructor(options: ScenarioRepositoryOptions = {}) {
		this.#limits = options.limits ?? DEFAULT_SCENARIO_DEFINITION_LIMITS;
		this.#maxUserScenarios =
			options.maxUserScenarios ?? DEFAULT_SCENARIO_USER_LIMIT;
		this.#maxTotalBytes = options.maxTotalBytes ?? 1024 * 1024;
		if (
			!Number.isSafeInteger(this.#maxUserScenarios) ||
			this.#maxUserScenarios < 1 ||
			this.#maxUserScenarios > MAX_USER_SCENARIOS
		) {
			throw new Error('maxUserScenarios must be between 1 and 50.');
		}
		if (
			!Number.isSafeInteger(this.#maxTotalBytes) ||
			this.#maxTotalBytes < 1 ||
			this.#maxTotalBytes > MAX_DOCUMENT_BYTES
		) {
			throw new Error('maxTotalBytes is outside the supported range.');
		}
		const bundled = (options.bundled ?? []).map((definition) =>
			freezeScenarioDefinition(
				parseScenarioDefinition(definition, this.#limits),
			),
		);
		const bundledIds = new Set<string>();
		for (const scenario of bundled) {
			if (bundledIds.has(scenario.id)) {
				throw new Error(`Duplicate bundled scenario id: ${scenario.id}`);
			}
			bundledIds.add(scenario.id);
		}
		this.#bundled = Object.freeze([...bundled]);
		this.#bundledIds = bundledIds;
		for (const scenario of bundled) {
			this.#definitionTokens.set(scenario.id, nextDefinitionToken());
		}
		this.#storage = options.storage;
		this.#key = options.key ?? DEFAULT_SCENARIO_REPOSITORY_KEY;
		this.#store = new ExternalStore(this.#snapshotFor([]));
		this.ready = this.#hydrate();
	}

	readonly subscribe = (listener: () => void): (() => void) =>
		this.#store.subscribe(listener);

	readonly getSnapshot = (): ScenarioRepositorySnapshot =>
		this.#store.getSnapshot();

	readonly getServerSnapshot = (): ScenarioRepositorySnapshot =>
		this.#store.getServerSnapshot();

	getLoadError(): string | undefined {
		return this.#loadError;
	}

	getTarget(id: string): ScenarioDefinitionTarget | undefined {
		const scenario = this.#store
			.getSnapshot()
			.all.find((candidate) => candidate.id === id);
		const definitionToken = this.#definitionTokens.get(id);
		return scenario && definitionToken
			? { id: scenario.id, version: scenario.version, definitionToken }
			: undefined;
	}

	resolveTarget(target: ScenarioDefinitionTarget): ScenarioDefinition {
		return this.#resolveTarget(target, this.#store.getSnapshot().all);
	}

	async save(definition: ScenarioDefinition): Promise<ScenarioDefinition> {
		const parsed = freezeScenarioDefinition(
			parseScenarioDefinition(definition, this.#limits),
		);
		if (this.#bundledIds.has(parsed.id)) {
			throw new Error(
				'Bundled scenarios are immutable and cannot be replaced.',
			);
		}
		await this.#mutate((scenarios) => {
			const existingIndex = scenarios.findIndex(
				(scenario) => scenario.id === parsed.id,
			);
			if (existingIndex < 0) return [...scenarios, parsed];
			const next = [...scenarios];
			next[existingIndex] = parsed;
			return next;
		});
		return parsed;
	}

	async remove(target: ScenarioDefinitionTarget): Promise<void> {
		if (this.#bundledIds.has(target.id)) {
			throw new Error('Bundled scenarios are immutable and cannot be removed.');
		}
		await this.#mutate((scenarios) => {
			this.#resolveTarget(target, scenarios);
			return scenarios.filter((scenario) => scenario.id !== target.id);
		});
	}

	exportJson(): string {
		return JSON.stringify(documentFor(this.#store.getSnapshot().user), null, 2);
	}

	async importJson(
		value: string,
		mode: ScenarioImportMode = 'replace',
	): Promise<readonly ScenarioDefinition[]> {
		if (mode !== 'replace' && mode !== 'merge') {
			throw new Error('Scenario import mode is invalid.');
		}
		const imported = parseDocument(value, this.#limits, false).scenarios;
		for (const scenario of imported) {
			if (this.#bundledIds.has(scenario.id)) {
				throw new Error(
					`Imported scenario conflicts with bundled id: ${scenario.id}`,
				);
			}
		}
		await this.#mutate((scenarios) =>
			mode === 'replace' ? imported : [...scenarios, ...imported],
		);
		return imported;
	}

	parseJson(value: string): ScenarioDefinition {
		return freezeScenarioDefinition(parseScenarioJson(value, this.#limits));
	}

	async #hydrate(): Promise<void> {
		if (!this.#storage) return;
		try {
			const raw = await this.#storage.getItem(this.#key);
			if (!raw) return;
			const parsed = parseDocument(raw, this.#limits, true);
			const user = parsed.scenarios.filter(
				(scenario) => !this.#bundledIds.has(scenario.id),
			);
			this.#validateUserScenarios(user);
			this.#syncDefinitionTokens([], user);
			this.#store.set(this.#snapshotFor(user));
			if (parsed.discarded > 0 || user.length !== parsed.scenarios.length) {
				await this.#storage.setItem(
					this.#key,
					JSON.stringify(documentFor(user)),
				);
			}
		} catch (error) {
			this.#loadError =
				error instanceof Error
					? error.message
					: 'Scenarios could not be loaded.';
		}
	}

	#mutate(
		operation: (
			scenarios: readonly ScenarioDefinition[],
		) => readonly ScenarioDefinition[],
	): Promise<void> {
		const run = this.#serial.then(async () => {
			await this.ready;
			const previous = this.#store.getSnapshot().user;
			const next = operation(previous);
			this.#validateUserScenarios(next);
			if (this.#storage) {
				await this.#storage.setItem(
					this.#key,
					JSON.stringify(documentFor(next)),
				);
			}
			this.#syncDefinitionTokens(previous, next);
			this.#store.set(this.#snapshotFor(next));
		});
		this.#serial = run.catch(() => undefined);
		return run;
	}

	#resolveTarget(
		target: ScenarioDefinitionTarget,
		scenarios: readonly ScenarioDefinition[],
	): ScenarioDefinition {
		if (
			!target ||
			typeof target.id !== 'string' ||
			!Number.isSafeInteger(target.version) ||
			typeof target.definitionToken !== 'string'
		) {
			throw new Error('Scenario target is invalid.');
		}
		const scenario = scenarios.find((candidate) => candidate.id === target.id);
		if (
			!scenario ||
			scenario.version !== target.version ||
			this.#definitionTokens.get(target.id) !== target.definitionToken
		) {
			throw new Error(
				'The scenario definition changed after confirmation. Review it and try again.',
			);
		}
		return scenario;
	}

	#syncDefinitionTokens(
		previous: readonly ScenarioDefinition[],
		next: readonly ScenarioDefinition[],
	): void {
		const previousById = new Map(
			previous.map((scenario) => [scenario.id, scenario]),
		);
		const nextIds = new Set(this.#bundledIds);
		for (const scenario of next) {
			nextIds.add(scenario.id);
			if (previousById.get(scenario.id) !== scenario) {
				this.#definitionTokens.set(scenario.id, nextDefinitionToken());
			}
		}
		for (const id of this.#definitionTokens.keys()) {
			if (!nextIds.has(id)) this.#definitionTokens.delete(id);
		}
	}

	#validateUserScenarios(scenarios: readonly ScenarioDefinition[]): void {
		if (
			!Array.isArray(scenarios) ||
			scenarios.length > this.#maxUserScenarios
		) {
			throw new Error('User scenarios exceed the repository count limit.');
		}
		const ids = new Set<string>();
		for (const scenario of scenarios) {
			if (ids.has(scenario.id)) {
				throw new Error(`Duplicate scenario id: ${scenario.id}`);
			}
			if (this.#bundledIds.has(scenario.id)) {
				throw new Error(`Scenario conflicts with bundled id: ${scenario.id}`);
			}
			ids.add(scenario.id);
		}
		if (
			utf8ByteLength(JSON.stringify(documentFor(scenarios))) >
			this.#maxTotalBytes
		) {
			throw new Error('User scenarios exceed the repository byte limit.');
		}
	}

	#snapshotFor(
		user: readonly ScenarioDefinition[],
	): ScenarioRepositorySnapshot {
		const frozenUser = Object.freeze([...user]);
		return Object.freeze({
			bundled: this.#bundled,
			user: frozenUser,
			all: Object.freeze([...this.#bundled, ...frozenUser]),
		});
	}
}

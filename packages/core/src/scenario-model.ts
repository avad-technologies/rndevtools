import { utf8ByteLength } from './core/serialize';
import {
	DEFAULT_SCENARIO_DEFINITION_LIMITS,
	DEFAULT_SCENARIO_USER_LIMIT,
	parseScenarioDefinition,
	parseScenarioJson,
	SCENARIO_PRECONDITION_TYPES,
	SCENARIO_SCHEMA_VERSION,
	SCENARIO_STEP_TYPES,
	type ScenarioDefinition,
	type ScenarioDefinitionLimits,
	type ScenarioPrecondition,
	type ScenarioPreconditionType,
	type ScenarioPrimitive,
	type ScenarioResolvedObject,
	type ScenarioResolvedValue,
	type ScenarioStep,
	type ScenarioStepType,
	type ScenarioTemplateObject,
	type ScenarioTemplateValue,
	type ScenarioVariable,
	type ScenarioVariableReference,
	type ScenarioVariableType,
} from './plugins/scenario';

export type {
	ScenarioDefinition,
	ScenarioDefinitionLimits,
	ScenarioPrecondition,
	ScenarioPreconditionType,
	ScenarioPrimitive,
	ScenarioResolvedObject,
	ScenarioResolvedValue,
	ScenarioStep,
	ScenarioStepType,
	ScenarioTemplateObject,
	ScenarioTemplateValue,
	ScenarioVariable,
	ScenarioVariableReference,
	ScenarioVariableType,
};
export {
	DEFAULT_SCENARIO_DEFINITION_LIMITS,
	DEFAULT_SCENARIO_USER_LIMIT,
	parseScenarioDefinition,
	parseScenarioJson,
	SCENARIO_PRECONDITION_TYPES,
	SCENARIO_SCHEMA_VERSION,
	SCENARIO_STEP_TYPES,
};

export const SCENARIO_DOCUMENT_NAMESPACE = 'rndevtools-scenarios' as const;
export const SCENARIO_DOCUMENT_MAX_BYTES = 512 * 1024;
export const SCENARIO_DOCUMENT_MAX_SCENARIOS = 50;

export type ScenarioDocument = Readonly<{
	schemaVersion: typeof SCENARIO_SCHEMA_VERSION;
	namespace: typeof SCENARIO_DOCUMENT_NAMESPACE;
	scenarios: readonly ScenarioDefinition[];
}>;

export type ScenarioDocumentParseOptions = Readonly<{
	maxDocumentBytes?: number;
	maxScenarios?: number;
	definitionLimits?: ScenarioDefinitionLimits;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedPositiveInteger(
	value: number | undefined,
	fallback: number,
	maximum: number,
	label: string,
): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
		throw new Error(`${label} is outside the supported range.`);
	}
	return resolved;
}

/**
 * Parses the portable scenario document format without importing any React
 * Native runtime or UI code. The returned definitions have already passed the
 * same strict schema and byte limits used by the on-device scenario engine.
 */
export function parseScenarioDocumentJson(
	value: string,
	options: ScenarioDocumentParseOptions = {},
): ScenarioDocument {
	const maxDocumentBytes = boundedPositiveInteger(
		options.maxDocumentBytes,
		SCENARIO_DOCUMENT_MAX_BYTES,
		SCENARIO_DOCUMENT_MAX_BYTES,
		'maxDocumentBytes',
	);
	const maxScenarios = boundedPositiveInteger(
		options.maxScenarios,
		SCENARIO_DOCUMENT_MAX_SCENARIOS,
		SCENARIO_DOCUMENT_MAX_SCENARIOS,
		'maxScenarios',
	);
	if (!value || utf8ByteLength(value) > maxDocumentBytes) {
		throw new Error('Scenario document is empty or oversized.');
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error('Scenario document is malformed.');
	}
	if (!isRecord(parsed)) {
		throw new Error('Scenario document has an unsupported schema.');
	}
	const allowedKeys = new Set(['schemaVersion', 'namespace', 'scenarios']);
	if (Object.keys(parsed).some((key) => !allowedKeys.has(key))) {
		throw new Error('Scenario document has an unsupported schema.');
	}
	if (
		parsed.schemaVersion !== SCENARIO_SCHEMA_VERSION ||
		parsed.namespace !== SCENARIO_DOCUMENT_NAMESPACE ||
		!Array.isArray(parsed.scenarios)
	) {
		throw new Error('Scenario document has an unsupported schema.');
	}
	if (parsed.scenarios.length > maxScenarios) {
		throw new Error('Scenario document exceeds the scenario-count limit.');
	}

	const definitionLimits =
		options.definitionLimits ?? DEFAULT_SCENARIO_DEFINITION_LIMITS;
	const scenarios: ScenarioDefinition[] = [];
	const ids = new Set<string>();
	for (const candidate of parsed.scenarios) {
		const scenario = parseScenarioDefinition(candidate, definitionLimits);
		if (ids.has(scenario.id)) {
			throw new Error(`Duplicate scenario id: ${scenario.id}`);
		}
		ids.add(scenario.id);
		scenarios.push(scenario);
	}

	return {
		schemaVersion: SCENARIO_SCHEMA_VERSION,
		namespace: SCENARIO_DOCUMENT_NAMESPACE,
		scenarios,
	};
}

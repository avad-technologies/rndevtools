import { utf8ByteLength } from '../core/serialize';

export const SCENARIO_SCHEMA_VERSION = 1 as const;
export const DEFAULT_SCENARIO_USER_LIMIT = 25;

export const SCENARIO_STEP_TYPES = [
	'network-profile',
	'storage-write',
	'zustand-write',
	'query-simulation',
	'developer-overrides',
	'impersonation',
	'navigation',
	'custom-action',
] as const;

export const SCENARIO_PRECONDITION_TYPES = [
	'capability',
	'environment',
	'custom',
] as const;

export type ScenarioStepType = (typeof SCENARIO_STEP_TYPES)[number];
export type ScenarioPreconditionType =
	(typeof SCENARIO_PRECONDITION_TYPES)[number];
export type ScenarioVariableType = 'string' | 'number' | 'boolean';
export type ScenarioPrimitive = string | number | boolean | null;
export type ScenarioVariableReference = Readonly<{
	kind: 'variable';
	variableId: string;
}>;
export interface ScenarioTemplateObject
	extends Readonly<Record<string, ScenarioTemplateValue>> {}
export type ScenarioTemplateValue =
	| ScenarioPrimitive
	| ScenarioVariableReference
	| readonly ScenarioTemplateValue[]
	| ScenarioTemplateObject;
export interface ScenarioResolvedObject
	extends Readonly<Record<string, ScenarioResolvedValue>> {}
export type ScenarioResolvedValue =
	| ScenarioPrimitive
	| readonly ScenarioResolvedValue[]
	| ScenarioResolvedObject;

export type ScenarioVariable = Readonly<{
	id: string;
	label: string;
	type: ScenarioVariableType;
	required: boolean;
	defaultValue?: ScenarioPrimitive;
	options?: readonly ScenarioPrimitive[];
}>;

export type ScenarioPrecondition = Readonly<{
	id: string;
	type: ScenarioPreconditionType;
	input: Readonly<Record<string, ScenarioTemplateValue>>;
}>;

export type ScenarioStep = Readonly<{
	id: string;
	type: ScenarioStepType;
	label?: string;
	input: Readonly<Record<string, ScenarioTemplateValue>>;
}>;

export type ScenarioDefinition = Readonly<{
	schemaVersion: typeof SCENARIO_SCHEMA_VERSION;
	id: string;
	version: number;
	name: string;
	description?: string;
	variables: readonly ScenarioVariable[];
	preconditions: readonly ScenarioPrecondition[];
	steps: readonly ScenarioStep[];
	finalRoute?: string;
}>;

export type ScenarioDefinitionLimits = Readonly<{
	maxDefinitionBytes: number;
	maxStepBytes: number;
}>;

export const DEFAULT_SCENARIO_DEFINITION_LIMITS: ScenarioDefinitionLimits = {
	maxDefinitionBytes: 256 * 1024,
	maxStepBytes: 64 * 1024,
};

const MAX_ID_BYTES = 256;
const MAX_LABEL_BYTES = 4 * 1024;
const MAX_DESCRIPTION_BYTES = 16 * 1024;
const MAX_ROUTE_BYTES = 4 * 1024;
const MAX_VARIABLES = 25;
const MAX_PRECONDITIONS = 25;
const MAX_STEPS = 100;
const MAX_TEMPLATE_DEPTH = 20;
const MAX_TEMPLATE_ENTRIES = 2_000;
const MAX_TEMPLATE_STRING_BYTES = 16 * 1024;
const ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const STEP_TYPES = new Set<string>(SCENARIO_STEP_TYPES);
const PRECONDITION_TYPES = new Set<string>(SCENARIO_PRECONDITION_TYPES);

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

function boundedText(
	value: unknown,
	label: string,
	maxBytes: number,
	pattern?: RegExp,
): string {
	if (
		typeof value !== 'string' ||
		!value.trim() ||
		value !== value.trim() ||
		utf8ByteLength(value) > maxBytes ||
		(pattern && !pattern.test(value))
	) {
		throw new Error(`${label} is invalid or exceeds its byte limit.`);
	}
	return value;
}

function parsePrimitive(value: unknown, label: string): ScenarioPrimitive {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean'
	) {
		if (
			typeof value === 'string' &&
			utf8ByteLength(value) > MAX_TEMPLATE_STRING_BYTES
		) {
			throw new Error(`${label} string exceeds its byte limit.`);
		}
		return value;
	}
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	throw new Error(`${label} must be a JSON primitive.`);
}

function parseTemplateValue(
	value: unknown,
	label: string,
	state: { remaining: number },
	depth: number,
): ScenarioTemplateValue {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean' ||
		typeof value === 'number'
	) {
		return parsePrimitive(value, label);
	}
	if (!value || typeof value !== 'object') {
		throw new Error(`${label} is not a supported scenario value.`);
	}
	if (depth >= MAX_TEMPLATE_DEPTH) {
		throw new Error(`${label} exceeds the scenario value depth limit.`);
	}
	if (Array.isArray(value)) {
		if (value.length > state.remaining) {
			throw new Error(`${label} exceeds the scenario value entry limit.`);
		}
		state.remaining -= value.length;
		return value.map((entry, index) =>
			parseTemplateValue(entry, `${label}[${index}]`, state, depth + 1),
		);
	}
	const record = value as Record<string, unknown>;
	if (record.kind === 'variable') {
		assertExactKeys(record, ['kind', 'variableId'], label);
		return {
			kind: 'variable',
			variableId: boundedText(
				record.variableId,
				`${label}.variableId`,
				MAX_ID_BYTES,
				ID_PATTERN,
			),
		};
	}
	const entries = Object.entries(record);
	if (entries.length > state.remaining) {
		throw new Error(`${label} exceeds the scenario value entry limit.`);
	}
	state.remaining -= entries.length;
	const output = Object.create(null) as Record<string, ScenarioTemplateValue>;
	for (const [key, entry] of entries) {
		if (DANGEROUS_KEYS.has(key)) {
			throw new Error(`${label}.${key} is not allowed in scenario values.`);
		}
		if (!key || utf8ByteLength(key) > MAX_ID_BYTES) {
			throw new Error(`${label} contains an invalid key.`);
		}
		output[key] = parseTemplateValue(
			entry,
			`${label}.${key}`,
			state,
			depth + 1,
		);
	}
	return output;
}

function parseTemplateRecord(
	value: unknown,
	label: string,
): Readonly<Record<string, ScenarioTemplateValue>> {
	if (!isRecord(value)) throw new Error(`${label} must be an object.`);
	return parseTemplateValue(
		value,
		label,
		{ remaining: MAX_TEMPLATE_ENTRIES },
		0,
	) as Readonly<Record<string, ScenarioTemplateValue>>;
}

function parseVariable(value: unknown, index: number): ScenarioVariable {
	const label = `Scenario variable ${index + 1}`;
	if (!isRecord(value)) throw new Error(`${label} must be an object.`);
	assertExactKeys(
		value,
		['id', 'label', 'type', 'required', 'defaultValue', 'options'],
		label,
	);
	const id = boundedText(value.id, `${label} id`, MAX_ID_BYTES, ID_PATTERN);
	const variableLabel = boundedText(
		value.label,
		`${label} label`,
		MAX_LABEL_BYTES,
	);
	if (!['string', 'number', 'boolean'].includes(String(value.type))) {
		throw new Error(`${label} has an unsupported type.`);
	}
	if (typeof value.required !== 'boolean') {
		throw new Error(`${label} required must be boolean.`);
	}
	const type = value.type as ScenarioVariableType;
	const defaultValue =
		value.defaultValue === undefined
			? undefined
			: parsePrimitive(value.defaultValue, `${label} default`);
	if (defaultValue !== undefined && typeof defaultValue !== type) {
		throw new Error(`${label} default does not match its type.`);
	}
	let options: readonly ScenarioPrimitive[] | undefined;
	if (value.options !== undefined) {
		if (!Array.isArray(value.options) || value.options.length > 50) {
			throw new Error(`${label} options are invalid.`);
		}
		options = value.options.map((option, optionIndex) => {
			const parsed = parsePrimitive(
				option,
				`${label} option ${optionIndex + 1}`,
			);
			if (typeof parsed !== type) {
				throw new Error(`${label} option does not match its type.`);
			}
			return parsed;
		});
		if (new Set(options).size !== options.length) {
			throw new Error(`${label} options must be unique.`);
		}
		if (defaultValue !== undefined && !options.includes(defaultValue)) {
			throw new Error(`${label} default must be one of its options.`);
		}
	}
	return {
		id,
		label: variableLabel,
		type,
		required: value.required,
		...(defaultValue !== undefined ? { defaultValue } : {}),
		...(options ? { options } : {}),
	};
}

function parsePrecondition(
	value: unknown,
	index: number,
): ScenarioPrecondition {
	const label = `Scenario precondition ${index + 1}`;
	if (!isRecord(value)) throw new Error(`${label} must be an object.`);
	assertExactKeys(value, ['id', 'type', 'input'], label);
	const type = boundedText(value.type, `${label} type`, MAX_ID_BYTES);
	if (!PRECONDITION_TYPES.has(type)) {
		throw new Error(`${label} has unknown type: ${type}`);
	}
	return {
		id: boundedText(value.id, `${label} id`, MAX_ID_BYTES, ID_PATTERN),
		type: type as ScenarioPreconditionType,
		input: parseTemplateRecord(value.input, `${label} input`),
	};
}

function parseStep(
	value: unknown,
	index: number,
	limits: ScenarioDefinitionLimits,
): ScenarioStep {
	const label = `Scenario step ${index + 1}`;
	if (!isRecord(value)) throw new Error(`${label} must be an object.`);
	assertExactKeys(value, ['id', 'type', 'label', 'input'], label);
	const type = boundedText(value.type, `${label} type`, MAX_ID_BYTES);
	if (!STEP_TYPES.has(type))
		throw new Error(`${label} has unknown type: ${type}`);
	const stepLabel =
		value.label === undefined
			? undefined
			: boundedText(value.label, `${label} label`, MAX_LABEL_BYTES);
	const step: ScenarioStep = {
		id: boundedText(value.id, `${label} id`, MAX_ID_BYTES, ID_PATTERN),
		type: type as ScenarioStepType,
		...(stepLabel ? { label: stepLabel } : {}),
		input: parseTemplateRecord(value.input, `${label} input`),
	};
	if (utf8ByteLength(JSON.stringify(step)) > limits.maxStepBytes) {
		throw new Error(`${label} exceeds the configured byte limit.`);
	}
	return step;
}

export function parseScenarioDefinition(
	value: unknown,
	limits: ScenarioDefinitionLimits = DEFAULT_SCENARIO_DEFINITION_LIMITS,
): ScenarioDefinition {
	if (!isRecord(value))
		throw new Error('Scenario definition must be an object.');
	assertExactKeys(
		value,
		[
			'schemaVersion',
			'id',
			'version',
			'name',
			'description',
			'variables',
			'preconditions',
			'steps',
			'finalRoute',
		],
		'Scenario definition',
	);
	if (value.schemaVersion !== SCENARIO_SCHEMA_VERSION) {
		throw new Error('Scenario definition has an unsupported schema version.');
	}
	if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) {
		throw new Error('Scenario definition version must be a positive integer.');
	}
	if (
		!Array.isArray(value.variables) ||
		value.variables.length > MAX_VARIABLES
	) {
		throw new Error('Scenario variables exceed the supported limit.');
	}
	if (
		!Array.isArray(value.preconditions) ||
		value.preconditions.length > MAX_PRECONDITIONS
	) {
		throw new Error('Scenario preconditions exceed the supported limit.');
	}
	if (
		!Array.isArray(value.steps) ||
		value.steps.length < 1 ||
		value.steps.length > MAX_STEPS
	) {
		throw new Error('Scenario steps must contain between 1 and 100 entries.');
	}
	const variables = value.variables.map(parseVariable);
	const preconditions = value.preconditions.map(parsePrecondition);
	const steps = value.steps.map((step, index) =>
		parseStep(step, index, limits),
	);
	const ids = new Set<string>();
	for (const item of [...variables, ...preconditions, ...steps]) {
		if (ids.has(item.id))
			throw new Error(`Duplicate scenario item id: ${item.id}`);
		ids.add(item.id);
	}
	const variableIds = new Set(variables.map((variable) => variable.id));
	const visit = (template: ScenarioTemplateValue): void => {
		if (
			template &&
			typeof template === 'object' &&
			!Array.isArray(template) &&
			(template as ScenarioVariableReference).kind === 'variable'
		) {
			const variableId = (template as ScenarioVariableReference).variableId;
			if (!variableIds.has(variableId)) {
				throw new Error(`Scenario references unknown variable: ${variableId}`);
			}
			return;
		}
		if (Array.isArray(template)) {
			for (const entry of template) visit(entry);
		} else if (template && typeof template === 'object') {
			for (const entry of Object.values(template)) visit(entry);
		}
	};
	for (const item of [...preconditions, ...steps]) visit(item.input);
	const definition: ScenarioDefinition = {
		schemaVersion: SCENARIO_SCHEMA_VERSION,
		id: boundedText(value.id, 'Scenario id', MAX_ID_BYTES, ID_PATTERN),
		version: value.version as number,
		name: boundedText(value.name, 'Scenario name', MAX_LABEL_BYTES),
		...(value.description === undefined
			? {}
			: {
					description: boundedText(
						value.description,
						'Scenario description',
						MAX_DESCRIPTION_BYTES,
					),
				}),
		variables,
		preconditions,
		steps,
		...(value.finalRoute === undefined
			? {}
			: {
					finalRoute: boundedText(
						value.finalRoute,
						'Scenario final route',
						MAX_ROUTE_BYTES,
					),
				}),
	};
	if (utf8ByteLength(JSON.stringify(definition)) > limits.maxDefinitionBytes) {
		throw new Error('Scenario definition exceeds the configured byte limit.');
	}
	return definition;
}

export function parseScenarioJson(
	value: string,
	limits: ScenarioDefinitionLimits = DEFAULT_SCENARIO_DEFINITION_LIMITS,
): ScenarioDefinition {
	if (!value || utf8ByteLength(value) > limits.maxDefinitionBytes) {
		throw new Error('Scenario JSON is empty or oversized.');
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error('Scenario JSON is malformed.');
	}
	return parseScenarioDefinition(parsed, limits);
}

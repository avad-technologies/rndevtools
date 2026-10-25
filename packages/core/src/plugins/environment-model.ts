export type EnvironmentValueType =
	| 'string'
	| 'number'
	| 'boolean'
	| 'object'
	| 'array';

export type EnvironmentIssueSeverity = 'error' | 'warning';

export type EnvironmentTypedValidation =
	| { kind: 'boolean'; expected?: boolean }
	| { kind: 'number'; integer?: boolean; minimum?: number; maximum?: number }
	| { kind: 'url'; protocols?: readonly string[] }
	| { kind: 'enum'; values: readonly string[]; caseSensitive?: boolean }
	| { kind: 'version'; exact?: string; minimum?: string; maximum?: string };

export type EnvironmentValueRule = {
	key: string;
	section?: string;
	description?: string;
	required?: boolean;
	severity?: EnvironmentIssueSeverity;
	expectedType?: EnvironmentValueType;
	expectedValue?: unknown;
	validation?: EnvironmentTypedValidation;
};

export type EnvironmentValidationStatus =
	| 'valid'
	| 'missing'
	| 'typeMismatch'
	| 'valueMismatch';

export type EnvironmentValidationIssueCode =
	| 'missing'
	| 'type'
	| 'boolean'
	| 'number'
	| 'url'
	| 'enum'
	| 'version'
	| 'value';

export type EnvironmentValidationResult = EnvironmentValueRule & {
	status: EnvironmentValidationStatus;
	actualValue?: unknown;
	actualType?: string;
	normalizedValue?: boolean | number | string;
	issueCode?: EnvironmentValidationIssueCode;
};

export type EnvironmentSection = {
	title: string;
	values: Readonly<Record<string, unknown>>;
};

export type EnvironmentRuleBuilderOptions = {
	key: string;
	section?: string;
	description?: string;
	required?: boolean;
	severity?: EnvironmentIssueSeverity;
};

export type EnvironmentHealthIssue = {
	id: string;
	key: string;
	section: string;
	status: Exclude<EnvironmentValidationStatus, 'valid'>;
	issueCode: EnvironmentValidationIssueCode;
	severity: EnvironmentIssueSeverity;
	description?: string;
	result: EnvironmentValidationResult;
};

export type EnvironmentHealthGroup = {
	section: string;
	issues: readonly EnvironmentHealthIssue[];
};

export type EnvironmentHealthSummary = {
	score: number;
	status: 'healthy' | 'degraded' | 'unhealthy';
	totalChecks: number;
	passingChecks: number;
	failingChecks: number;
	issues: readonly EnvironmentHealthIssue[];
	groups: readonly EnvironmentHealthGroup[];
};

const MAX_ENVIRONMENT_ENTRIES_PER_SECTION = 5_000;
const MAX_ENVIRONMENT_COMPARISON_DEPTH = 32;
const MAX_ENVIRONMENT_COMPARISON_ENTRIES = 10_000;
const MAX_ENVIRONMENT_TEXT_LENGTH = 4 * 1024;
const MAX_ENUM_VALUES = 100;
const MAX_VERSION_COMPONENTS = 4;

export function createEnvironmentBooleanRule(
	options: EnvironmentRuleBuilderOptions & { expected?: boolean },
): EnvironmentValueRule {
	const { expected, ...base } = options;
	return {
		...base,
		validation: {
			kind: 'boolean',
			...(expected === undefined ? {} : { expected }),
		},
	};
}

export function createEnvironmentNumberRule(
	options: EnvironmentRuleBuilderOptions & {
		integer?: boolean;
		minimum?: number;
		maximum?: number;
	},
): EnvironmentValueRule {
	const { integer, minimum, maximum, ...base } = options;
	return {
		...base,
		validation: {
			kind: 'number',
			...(integer === undefined ? {} : { integer }),
			...(minimum === undefined ? {} : { minimum }),
			...(maximum === undefined ? {} : { maximum }),
		},
	};
}

export function createEnvironmentUrlRule(
	options: EnvironmentRuleBuilderOptions & { protocols?: readonly string[] },
): EnvironmentValueRule {
	const { protocols, ...base } = options;
	return {
		...base,
		validation: {
			kind: 'url',
			...(protocols ? { protocols: [...protocols] } : {}),
		},
	};
}

export function createEnvironmentEnumRule<const Value extends string>(
	options: EnvironmentRuleBuilderOptions & {
		values: readonly Value[];
		caseSensitive?: boolean;
	},
): EnvironmentValueRule {
	const { values, caseSensitive, ...base } = options;
	return {
		...base,
		validation: {
			kind: 'enum',
			values: [...values],
			...(caseSensitive === undefined ? {} : { caseSensitive }),
		},
	};
}

export function createEnvironmentVersionRule(
	options: EnvironmentRuleBuilderOptions & {
		exact?: string;
		minimum?: string;
		maximum?: string;
	},
): EnvironmentValueRule {
	const { exact, minimum, maximum, ...base } = options;
	return {
		...base,
		validation: {
			kind: 'version',
			...(exact === undefined ? {} : { exact }),
			...(minimum === undefined ? {} : { minimum }),
			...(maximum === undefined ? {} : { maximum }),
		},
	};
}

function valueType(value: unknown): string {
	if (Array.isArray(value)) return 'array';
	if (value === null) return 'null';
	return typeof value;
}

function isMissing(value: unknown): boolean {
	return value === undefined || value === null || value === '';
}

export function environmentSectionEntries(
	section: EnvironmentSection,
	rejectOverflow = false,
): readonly (readonly [string, unknown])[] {
	let descriptors: Record<string, PropertyDescriptor>;
	try {
		descriptors = Object.getOwnPropertyDescriptors(section.values);
	} catch {
		return [];
	}
	const entries = Object.entries(descriptors).filter(
		([, descriptor]) => descriptor.enumerable,
	);
	if (entries.length > MAX_ENVIRONMENT_ENTRIES_PER_SECTION) {
		if (rejectOverflow) {
			throw new Error(
				`Environment sections support at most ${MAX_ENVIRONMENT_ENTRIES_PER_SECTION} values.`,
			);
		}
		entries.length = MAX_ENVIRONMENT_ENTRIES_PER_SECTION;
	}
	return entries.map(
		([key, descriptor]) =>
			[
				key,
				'value' in descriptor ? descriptor.value : '[Accessor omitted]',
			] as const,
	);
}

type EnvironmentComparisonState = {
	remaining: number;
	seen: WeakMap<object, WeakSet<object>>;
};

function environmentValuesEqual(
	left: unknown,
	right: unknown,
	state: EnvironmentComparisonState = {
		remaining: MAX_ENVIRONMENT_COMPARISON_ENTRIES,
		seen: new WeakMap<object, WeakSet<object>>(),
	},
	depth = 0,
): boolean {
	if (Object.is(left, right)) return true;
	if (depth >= MAX_ENVIRONMENT_COMPARISON_DEPTH || state.remaining <= 0) {
		return false;
	}
	state.remaining -= 1;
	if (
		!left ||
		!right ||
		typeof left !== 'object' ||
		typeof right !== 'object' ||
		Array.isArray(left) !== Array.isArray(right)
	) {
		return false;
	}
	try {
		if (left instanceof Date || right instanceof Date) {
			return (
				left instanceof Date &&
				right instanceof Date &&
				Date.prototype.getTime.call(left) === Date.prototype.getTime.call(right)
			);
		}
		if (!Array.isArray(left)) {
			const leftPrototype = Object.getPrototypeOf(left);
			const rightPrototype = Object.getPrototypeOf(right);
			const leftIsPlain =
				leftPrototype === Object.prototype || leftPrototype === null;
			const rightIsPlain =
				rightPrototype === Object.prototype || rightPrototype === null;
			if (!leftIsPlain || !rightIsPlain) return false;
		}
	} catch {
		return false;
	}
	const matched = state.seen.get(left);
	if (matched?.has(right)) return true;
	if (matched) matched.add(right);
	else state.seen.set(left, new WeakSet([right]));

	let leftDescriptors: Record<string, PropertyDescriptor>;
	let rightDescriptors: Record<string, PropertyDescriptor>;
	try {
		leftDescriptors = Object.getOwnPropertyDescriptors(left);
		rightDescriptors = Object.getOwnPropertyDescriptors(right);
	} catch {
		return false;
	}
	if (Array.isArray(left) && Array.isArray(right)) {
		const leftLength = leftDescriptors.length;
		const rightLength = rightDescriptors.length;
		if (
			!leftLength ||
			!rightLength ||
			!('value' in leftLength) ||
			!('value' in rightLength) ||
			leftLength.value !== rightLength.value ||
			typeof leftLength.value !== 'number' ||
			leftLength.value > MAX_ENVIRONMENT_COMPARISON_ENTRIES
		) {
			return false;
		}
		for (let index = 0; index < leftLength.value; index += 1) {
			const leftDescriptor = leftDescriptors[String(index)];
			const rightDescriptor = rightDescriptors[String(index)];
			if (
				!leftDescriptor ||
				!rightDescriptor ||
				!('value' in leftDescriptor) ||
				!('value' in rightDescriptor) ||
				!environmentValuesEqual(
					leftDescriptor.value,
					rightDescriptor.value,
					state,
					depth + 1,
				)
			) {
				return false;
			}
		}
		return true;
	}
	const leftKeys = Object.entries(leftDescriptors)
		.filter(([, descriptor]) => descriptor.enumerable)
		.map(([key]) => key);
	const rightKeys = Object.entries(rightDescriptors)
		.filter(([, descriptor]) => descriptor.enumerable)
		.map(([key]) => key);
	if (
		leftKeys.length > MAX_ENVIRONMENT_COMPARISON_ENTRIES ||
		rightKeys.length > MAX_ENVIRONMENT_COMPARISON_ENTRIES
	) {
		return false;
	}
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every((key) => {
			const leftDescriptor = leftDescriptors[key];
			const rightDescriptor = rightDescriptors[key];
			return (
				leftDescriptor !== undefined &&
				rightDescriptor !== undefined &&
				'value' in leftDescriptor &&
				'value' in rightDescriptor &&
				environmentValuesEqual(
					leftDescriptor.value,
					rightDescriptor.value,
					state,
					depth + 1,
				)
			);
		})
	);
}

const environmentValueTypes = new Set<EnvironmentValueType>([
	'string',
	'number',
	'boolean',
	'object',
	'array',
]);

function validFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function parseNumber(value: unknown): number | undefined {
	if (validFiniteNumber(value)) return value;
	if (
		typeof value !== 'string' ||
		!value.trim() ||
		!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim())
	) {
		return undefined;
	}
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
	if (typeof value === 'boolean') return value;
	if (value === 'true') return true;
	if (value === 'false') return false;
	return undefined;
}

function normalizeProtocol(protocol: string): string {
	return protocol.endsWith(':')
		? protocol.toLowerCase()
		: `${protocol.toLowerCase()}:`;
}

function parseVersion(value: unknown): readonly number[] | undefined {
	if (typeof value !== 'string') return undefined;
	const match = /^v?(\d+(?:\.\d+){0,3})$/.exec(value.trim());
	if (!match?.[1]) return undefined;
	const components = match[1].split('.').map(Number);
	if (
		components.length === 0 ||
		components.length > MAX_VERSION_COMPONENTS ||
		components.some(
			(component) => !Number.isSafeInteger(component) || component < 0,
		)
	) {
		return undefined;
	}
	return components;
}

function compareVersions(
	left: readonly number[],
	right: readonly number[],
): number {
	for (let index = 0; index < MAX_VERSION_COMPONENTS; index += 1) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) return difference < 0 ? -1 : 1;
	}
	return 0;
}

function typedValidationResult(
	validation: EnvironmentTypedValidation,
	actualValue: unknown,
): Pick<
	EnvironmentValidationResult,
	'status' | 'issueCode' | 'normalizedValue'
> {
	switch (validation.kind) {
		case 'boolean': {
			const parsed = parseBoolean(actualValue);
			if (parsed === undefined) {
				return { status: 'typeMismatch', issueCode: 'boolean' };
			}
			if (validation.expected !== undefined && parsed !== validation.expected) {
				return {
					status: 'valueMismatch',
					issueCode: 'boolean',
					normalizedValue: parsed,
				};
			}
			return { status: 'valid', normalizedValue: parsed };
		}
		case 'number': {
			const parsed = parseNumber(actualValue);
			if (parsed === undefined) {
				return { status: 'typeMismatch', issueCode: 'number' };
			}
			if (
				(validation.integer === true && !Number.isInteger(parsed)) ||
				(validation.minimum !== undefined && parsed < validation.minimum) ||
				(validation.maximum !== undefined && parsed > validation.maximum)
			) {
				return {
					status: 'valueMismatch',
					issueCode: 'number',
					normalizedValue: parsed,
				};
			}
			return { status: 'valid', normalizedValue: parsed };
		}
		case 'url': {
			if (typeof actualValue !== 'string') {
				return { status: 'typeMismatch', issueCode: 'url' };
			}
			try {
				const parsed = new URL(actualValue);
				const protocols = (validation.protocols ?? ['https:']).map(
					normalizeProtocol,
				);
				if (
					!protocols.includes(parsed.protocol.toLowerCase()) ||
					!parsed.host
				) {
					return { status: 'valueMismatch', issueCode: 'url' };
				}
				return { status: 'valid', normalizedValue: parsed.toString() };
			} catch {
				return { status: 'valueMismatch', issueCode: 'url' };
			}
		}
		case 'enum': {
			if (typeof actualValue !== 'string') {
				return { status: 'typeMismatch', issueCode: 'enum' };
			}
			const candidate =
				validation.caseSensitive === false
					? actualValue.toLowerCase()
					: actualValue;
			const values =
				validation.caseSensitive === false
					? validation.values.map((value) => value.toLowerCase())
					: validation.values;
			return values.includes(candidate)
				? { status: 'valid', normalizedValue: actualValue }
				: { status: 'valueMismatch', issueCode: 'enum' };
		}
		case 'version': {
			const parsed = parseVersion(actualValue);
			if (!parsed) return { status: 'valueMismatch', issueCode: 'version' };
			const exact = validation.exact
				? parseVersion(validation.exact)
				: undefined;
			const minimum = validation.minimum
				? parseVersion(validation.minimum)
				: undefined;
			const maximum = validation.maximum
				? parseVersion(validation.maximum)
				: undefined;
			if (
				(exact && compareVersions(parsed, exact) !== 0) ||
				(minimum && compareVersions(parsed, minimum) < 0) ||
				(maximum && compareVersions(parsed, maximum) > 0)
			) {
				return { status: 'valueMismatch', issueCode: 'version' };
			}
			return { status: 'valid', normalizedValue: String(actualValue) };
		}
	}
}

function assertTypedValidation(rule: EnvironmentValueRule): void {
	const validation = rule.validation;
	if (!validation) return;
	if (rule.expectedType !== undefined || Object.hasOwn(rule, 'expectedValue')) {
		throw new Error(
			`Typed environment rule ${rule.key} cannot also use legacy expectations.`,
		);
	}
	switch (validation.kind) {
		case 'boolean':
			if (
				validation.expected !== undefined &&
				typeof validation.expected !== 'boolean'
			) {
				throw new Error(`Invalid boolean environment rule ${rule.key}.`);
			}
			break;
		case 'number':
			if (
				(validation.minimum !== undefined &&
					!validFiniteNumber(validation.minimum)) ||
				(validation.maximum !== undefined &&
					!validFiniteNumber(validation.maximum)) ||
				(validation.minimum !== undefined &&
					validation.maximum !== undefined &&
					validation.minimum > validation.maximum)
			) {
				throw new Error(`Invalid numeric environment rule ${rule.key}.`);
			}
			break;
		case 'url': {
			const protocols = validation.protocols ?? ['https:'];
			if (
				protocols.length === 0 ||
				protocols.length > 10 ||
				protocols.some(
					(protocol) =>
						typeof protocol !== 'string' ||
						!/^[a-z][a-z0-9+.-]*:?$/i.test(protocol),
				)
			) {
				throw new Error(`Invalid URL environment rule ${rule.key}.`);
			}
			break;
		}
		case 'enum':
			if (
				validation.values.length === 0 ||
				validation.values.length > MAX_ENUM_VALUES ||
				validation.values.some(
					(value) => typeof value !== 'string' || !value || value.length > 256,
				) ||
				new Set(validation.values).size !== validation.values.length
			) {
				throw new Error(`Invalid enum environment rule ${rule.key}.`);
			}
			break;
		case 'version': {
			const exact = validation.exact
				? parseVersion(validation.exact)
				: undefined;
			const minimum = validation.minimum
				? parseVersion(validation.minimum)
				: undefined;
			const maximum = validation.maximum
				? parseVersion(validation.maximum)
				: undefined;
			if (
				(validation.exact !== undefined && !exact) ||
				(validation.minimum !== undefined && !minimum) ||
				(validation.maximum !== undefined && !maximum) ||
				(minimum && maximum && compareVersions(minimum, maximum) > 0)
			) {
				throw new Error(`Invalid version environment rule ${rule.key}.`);
			}
			break;
		}
	}
}

export function assertEnvironmentRules(
	sections: readonly EnvironmentSection[],
	rules: readonly EnvironmentValueRule[],
): void {
	const sectionTitles = new Set(sections.map((entry) => entry.title));
	const signatures = new Set<string>();
	const scopesByKey = new Map<string, Set<string>>();
	for (const rule of rules) {
		if (
			!rule ||
			typeof rule !== 'object' ||
			typeof rule.key !== 'string' ||
			!rule.key.trim() ||
			rule.key.length > MAX_ENVIRONMENT_TEXT_LENGTH
		) {
			throw new Error('Environment rule keys must be 1–4096 characters.');
		}
		if (
			rule.description !== undefined &&
			(typeof rule.description !== 'string' ||
				rule.description.length > MAX_ENVIRONMENT_TEXT_LENGTH)
		) {
			throw new Error(
				'Environment rule descriptions cannot exceed 4096 characters.',
			);
		}
		if (rule.severity && !['error', 'warning'].includes(rule.severity)) {
			throw new Error(`Invalid environment severity for ${rule.key}.`);
		}
		if (rule.section && !sectionTitles.has(rule.section)) {
			throw new Error(`Unknown environment rule section: ${rule.section}`);
		}
		if (
			rule.expectedType !== undefined &&
			!environmentValueTypes.has(rule.expectedType)
		) {
			throw new Error(
				`Invalid expected type for environment rule ${rule.key}.`,
			);
		}
		assertTypedValidation(rule);
		const signature = `${rule.section ?? '*'}\u0000${rule.key}`;
		if (signatures.has(signature)) {
			throw new Error(
				`Duplicate environment rule: ${rule.section ?? '*'}:${rule.key}`,
			);
		}
		signatures.add(signature);
		const scope = rule.section ?? '*';
		const existingScopes = scopesByKey.get(rule.key) ?? new Set<string>();
		if (existingScopes.size > 0 && (scope === '*' || existingScopes.has('*'))) {
			throw new Error(
				`Overlapping environment rules require explicit, non-global sections: ${rule.key}`,
			);
		}
		existingScopes.add(scope);
		scopesByKey.set(rule.key, existingScopes);
		if (!rule.section) {
			const matchingSectionCount = sections.filter((entry) =>
				environmentSectionEntries(entry).some(([key]) => key === rule.key),
			).length;
			if (matchingSectionCount > 1) {
				throw new Error(
					`Environment rule ${rule.key} is ambiguous; specify its section.`,
				);
			}
		}
	}
}

export function validateEnvironmentValues(
	sections: readonly EnvironmentSection[],
	rules: readonly EnvironmentValueRule[],
): readonly EnvironmentValidationResult[] {
	return rules.map((rule) => {
		const candidates = rule.section
			? sections.filter((section) => section.title === rule.section)
			: sections;
		const sectionEntry = candidates
			.flatMap((entry) =>
				environmentSectionEntries(entry).map(([key, value]) => ({
					key,
					value,
				})),
			)
			.find((entry) => entry.key === rule.key);
		const actualValue = sectionEntry?.value;
		const actualType = valueType(actualValue);
		if (isMissing(actualValue)) {
			return {
				...rule,
				actualValue,
				actualType,
				status: rule.required === false ? 'valid' : 'missing',
				...(rule.required === false ? {} : { issueCode: 'missing' as const }),
			};
		}
		if (rule.validation) {
			return {
				...rule,
				actualValue,
				actualType,
				...typedValidationResult(rule.validation, actualValue),
			};
		}
		if (rule.expectedType && actualType !== rule.expectedType) {
			return {
				...rule,
				actualValue,
				actualType,
				status: 'typeMismatch',
				issueCode: 'type',
			};
		}
		if (
			Object.hasOwn(rule, 'expectedValue') &&
			!environmentValuesEqual(actualValue, rule.expectedValue)
		) {
			return {
				...rule,
				actualValue,
				actualType,
				status: 'valueMismatch',
				issueCode: 'value',
			};
		}
		return { ...rule, actualValue, actualType, status: 'valid' };
	});
}

function issueIdentifier(result: EnvironmentValidationResult): string {
	return `${result.section ?? 'Validation'}:${result.key}`;
}

export function summarizeEnvironmentHealth(
	results: readonly EnvironmentValidationResult[],
): EnvironmentHealthSummary {
	const totalWeight = results.reduce(
		(total, result) => total + (result.severity === 'warning' ? 1 : 2),
		0,
	);
	const passingWeight = results.reduce(
		(total, result) =>
			total +
			(result.status === 'valid' ? (result.severity === 'warning' ? 1 : 2) : 0),
		0,
	);
	const issues = results
		.filter(
			(
				result,
			): result is EnvironmentValidationResult & {
				status: Exclude<EnvironmentValidationStatus, 'valid'>;
			} => result.status !== 'valid',
		)
		.map((result) => ({
			id: issueIdentifier(result),
			key: result.key,
			section: result.section ?? 'Validation',
			status: result.status,
			issueCode: result.issueCode ?? 'value',
			severity: result.severity ?? 'error',
			...(result.description ? { description: result.description } : {}),
			result,
		}))
		.sort(
			(left, right) =>
				left.section.localeCompare(right.section) ||
				left.key.localeCompare(right.key) ||
				left.status.localeCompare(right.status),
		);
	const groupMap = new Map<string, EnvironmentHealthIssue[]>();
	for (const issue of issues) {
		const group = groupMap.get(issue.section) ?? [];
		group.push(issue);
		groupMap.set(issue.section, group);
	}
	const groups = [...groupMap]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([section, groupIssues]) => ({ section, issues: groupIssues }));
	const score =
		totalWeight === 0 ? 100 : Math.round((passingWeight / totalWeight) * 100);
	return {
		score,
		status:
			issues.length === 0 ? 'healthy' : score >= 70 ? 'degraded' : 'unhealthy',
		totalChecks: results.length,
		passingChecks: results.length - issues.length,
		failingChecks: issues.length,
		issues,
		groups,
	};
}

export function evaluateEnvironmentHealth(
	sections: readonly EnvironmentSection[],
	rules: readonly EnvironmentValueRule[],
): EnvironmentHealthSummary {
	return summarizeEnvironmentHealth(validateEnvironmentValues(sections, rules));
}

export function searchEnvironmentHealthIssues(
	health: EnvironmentHealthSummary,
	query: string,
): readonly EnvironmentHealthGroup[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return health.groups;
	return health.groups.flatMap((group) => {
		const issues = group.issues.filter((issue) =>
			[
				issue.section,
				issue.key,
				issue.status,
				issue.issueCode,
				issue.severity,
				issue.description ?? '',
			]
				.join(' ')
				.toLowerCase()
				.includes(needle),
		);
		return issues.length > 0 ? [{ section: group.section, issues }] : [];
	});
}

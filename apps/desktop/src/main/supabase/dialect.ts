import path from 'node:path';
import { hasSupabaseControlCharacters } from './engine-support';

/**
 * Supabase CLI dialects: the CLI releases RN Devtools has verified, what each
 * one can do, and the only argv builder for them. This is the one module that
 * spells Supabase CLI subcommand words and flags; every other module passes a
 * typed operation through buildSupabaseArgv.
 *
 * The `stack` command group is outside Supabase's compatibility promise, so the
 * table fails closed: an exact verified release is managed, a newer patch of
 * the same minor is observed only (unless the operator allows unverified
 * patches), and anything else may only be asked for its version.
 *
 * Rules baked into the builder, each enforced again by the argv allowlist:
 * - every stack create or resume passes `--runtime native`;
 * - stack-level operations address a stack by its full 64-hex id;
 * - nothing ever stops every stack, selects a stack by name, exports the env
 *   map, follows logs, or turns on debug or dry-run output;
 * - `--eager` only when requested, `--yes` only on a confirmed destroy;
 * - database reads always name their target (their CLI default is the linked
 *   hosted project) and a `--db-url` target is loopback with TLS disabled;
 * - database mutations only ever target `--local`, never a URL.
 */

const VERSION_PATTERN =
	/^(\d{1,4})\.(\d{1,4})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,64}))?(?:\+([0-9A-Za-z.-]{1,64}))?$/;
const STACK_ID_PATTERN = /^[0-9a-f]{64}$/;
const INSTANCE_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SINCE_DURATION_PATTERN = /^(?:\d{1,6}(?:\.\d{1,3})?(?:ms|s|m|h|d)){1,6}$/;
const SINCE_TIMESTAMP_PATTERN =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_PATH_LENGTH = 4096;
const MAX_DATABASE_URL_LENGTH = 2048;
const MAX_ARGV_LENGTH = 128;
const MAX_ARGUMENT_LENGTH = 8192;
const MAX_LOG_TAIL = 1000;
const MAX_LOG_SERVICES = 16;
const MAX_DESTROY_STACKS = 32;

/**
 * What a verified CLI release can do.
 */
type SupabaseDialectFeatures = Readonly<{
	/** `stack destroy` accepts several `--stack-id` flags in one call. */
	multiDestroy: boolean;
	/** `stack start` reports `endpoint_changes` when ports moved. */
	endpointChanges: boolean;
	/** The port registry claims native backend ports; false means creations must be serialized. */
	nativeBackendPortClaims: boolean;
	logs: boolean;
	restart: boolean;
	prepare: boolean;
	migrations: boolean;
	inspect: boolean;
	dump: boolean;
}>;

type SupabaseUnsupportedReason =
	| 'unparseable'
	| 'prerelease'
	| 'unverified-release';

export type SupabaseDialect =
	| Readonly<{
			gate: 'verified' | 'compatible';
			/** The version the CLI reported. */
			version: string;
			/** The verified release this version is interpreted as. */
			verifiedVersion: string;
			/** The command group that holds the stack lifecycle commands. */
			group: 'stack';
			/** Name of the recorded fixture set that pins this dialect's shapes. */
			fixtures: string;
			features: SupabaseDialectFeatures;
			/**
			 * Whether lifecycle and database-mutating operations are allowed: always
			 * for a verified release, and for a compatible patch only with
			 * `allowUnverifiedPatch`. Otherwise the stacks are observed, stopped and
			 * destroyed, never created or changed.
			 */
			manageable: boolean;
	  }>
	| Readonly<{
			gate: 'unsupported';
			version: string;
			reason: SupabaseUnsupportedReason;
			manageable: false;
	  }>;

type VerifiedDialectRow = Readonly<{
	version: string;
	major: number;
	minor: number;
	patch: number;
	group: 'stack';
	fixtures: string;
	features: SupabaseDialectFeatures;
}>;

const VERIFIED_DIALECTS: readonly VerifiedDialectRow[] = Object.freeze([
	Object.freeze({
		version: '2.121.0',
		major: 2,
		minor: 121,
		patch: 0,
		group: 'stack',
		fixtures: 'supabase-2.121.0',
		features: Object.freeze({
			multiDestroy: true,
			endpointChanges: true,
			// Only Supabase's develop branch registers native backend ports.
			nativeBackendPortClaims: false,
			logs: true,
			restart: true,
			prepare: true,
			migrations: true,
			inspect: true,
			dump: true,
		}),
	}),
]);

function displayVersion(value: string): string {
	return value.slice(0, 64).replace(/[^0-9A-Za-z.+-]/g, '?');
}

/**
 * Maps the version a CLI binary reports to its dialect. Pre-releases and
 * builds with metadata are unsupported even when they share a verified
 * release's sources, because nothing pins their shapes.
 */
export function resolveSupabaseDialect(
	version: string,
	options: Readonly<{ allowUnverifiedPatch?: boolean }> = {}
): SupabaseDialect {
	const reported = version.trim();
	const match = VERSION_PATTERN.exec(reported);
	if (!match) {
		return {
			gate: 'unsupported',
			version: displayVersion(reported),
			reason: 'unparseable',
			manageable: false,
		};
	}
	if (match[4] !== undefined || match[5] !== undefined) {
		return {
			gate: 'unsupported',
			version: reported,
			reason: 'prerelease',
			manageable: false,
		};
	}
	const major = Number(match[1]);
	const minor = Number(match[2]);
	const patch = Number(match[3]);
	const exact = VERIFIED_DIALECTS.find(
		(row) => row.major === major && row.minor === minor && row.patch === patch
	);
	if (exact) {
		return {
			gate: 'verified',
			version: reported,
			verifiedVersion: exact.version,
			group: exact.group,
			fixtures: exact.fixtures,
			features: exact.features,
			manageable: true,
		};
	}
	const base = VERIFIED_DIALECTS.filter(
		(row) => row.major === major && row.minor === minor && row.patch < patch
	).sort((left, right) => right.patch - left.patch)[0];
	if (base) {
		return {
			gate: 'compatible',
			version: reported,
			verifiedVersion: base.version,
			group: base.group,
			fixtures: base.fixtures,
			features: base.features,
			manageable: options.allowUnverifiedPatch === true,
		};
	}
	return {
		gate: 'unsupported',
		version: reported,
		reason: 'unverified-release',
		manageable: false,
	};
}

/** Capabilities `stack start --exclude` accepts. */
export const SUPABASE_EXCLUDABLE_CAPABILITIES = Object.freeze([
	'rest',
	'auth',
	'realtime',
	'storage',
	'functions',
	'studio',
	'mail',
	'analytics',
	'pooler',
] as const);
type SupabaseExcludableCapability =
	(typeof SUPABASE_EXCLUDABLE_CAPABILITIES)[number];

/** Capabilities `stack prepare --capability` accepts. */
export const SUPABASE_PREPARABLE_CAPABILITIES = Object.freeze([
	'database',
	...SUPABASE_EXCLUDABLE_CAPABILITIES,
] as const);
export type SupabasePreparableCapability =
	(typeof SUPABASE_PREPARABLE_CAPABILITIES)[number];

const LOG_SERVICE_NAMES: ReadonlySet<string> = new Set([
	'database',
	'rest',
	'auth',
	'realtime',
	'storage',
	'imgproxy',
	'functions',
	'studio',
	'pgmeta',
	'mail',
	'analytics',
	'pooler',
	// The shared API gateway's access log.
	'gateway',
]);

/**
 * Read-only `inspect db` reports the desktop runs.
 */
type SupabaseInspectReport = 'db-stats' | 'table-stats';
const INSPECT_REPORTS: readonly SupabaseInspectReport[] = [
	'db-stats',
	'table-stats',
];

/**
 * Where a database read goes: the worktree's current-branch stack (`--local`)
 * or a loopback DB_URL the desktop holds in main memory. A URL is how a read
 * reaches a stack whose branch is not checked out; `sslmode=disable` is added
 * because native Postgres has no TLS and a non-matching URL counts as remote.
 */
type SupabaseDatabaseTarget = 'local' | Readonly<{ dbUrl: string }>;

export type SupabaseCliOperation =
	| Readonly<{ kind: 'version' }>
	| Readonly<{ kind: 'stack.list' }>
	| Readonly<{ kind: 'stack.status'; stackId: string }>
	| Readonly<{
			kind: 'stack.start';
			/** Realpath of the Supabase project root: creates the stack if needed. */
			workdir: string;
			stackId?: never;
			exclude: readonly SupabaseExcludableCapability[];
			/** Activate every service and disable idle stops. Never set by default. */
			eager?: boolean;
	  }>
	| Readonly<{
			kind: 'stack.start';
			/** Resume an existing stack by its full id. */
			stackId: string;
			workdir?: never;
			exclude: readonly SupabaseExcludableCapability[];
	  }>
	| Readonly<{ kind: 'stack.stop'; stackId: string }>
	| Readonly<{ kind: 'stack.restart'; stackId: string }>
	| Readonly<{
			kind: 'stack.destroy';
			stackIds: readonly string[];
			/** Set only after the main-owned dialog consumed its one-time token. */
			confirmed: true;
	  }>
	| Readonly<{
			kind: 'stack.logs';
			stackId: string;
			/** Service kinds, instance ids, or `gateway`; all members when omitted. */
			services?: readonly string[];
			tail: number;
			/** `start`, a duration such as `10m`, or an ISO-8601 time. */
			since?: string;
	  }>
	| Readonly<{
			kind: 'stack.prepare';
			workdir: string;
			stackId?: never;
			capabilities: readonly SupabasePreparableCapability[];
	  }>
	| Readonly<{
			kind: 'stack.prepare';
			stackId: string;
			workdir?: never;
			capabilities: readonly SupabasePreparableCapability[];
	  }>
	| Readonly<{
			kind: 'migration.list';
			workdir: string;
			target: SupabaseDatabaseTarget;
	  }>
	| Readonly<{ kind: 'migration.up'; workdir: string }>
	| Readonly<{ kind: 'db.reset'; workdir: string; noSeed?: boolean }>
	| Readonly<{
			kind: 'inspect';
			name: SupabaseInspectReport;
			workdir: string;
			target: SupabaseDatabaseTarget;
	  }>
	| Readonly<{
			kind: 'db.dump';
			workdir: string;
			/** Absolute, main-owned output path. */
			file: string;
			target: SupabaseDatabaseTarget;
			dataOnly?: boolean;
	  }>
	| Readonly<{ kind: 'seed.buckets'; workdir: string }>;

export type SupabaseCliOperationKind = SupabaseCliOperation['kind'];
type VersionOperation = Extract<SupabaseCliOperation, { kind: 'version' }>;
type GroupOperation = Exclude<SupabaseCliOperation, VersionOperation>;

export type SupabaseArgvErrorReason =
	| 'gate'
	| 'feature'
	| 'invalid-input'
	| 'not-allowed'
	| 'read-only';

/** Raised before anything is spawned. Messages never echo argument values. */
export class SupabaseArgvError extends Error {
	readonly reason: SupabaseArgvErrorReason;

	constructor(reason: SupabaseArgvErrorReason, message: string) {
		super(message);
		this.name = 'SupabaseArgvError';
		this.reason = reason;
	}
}

// Operations allowed while a dialect is only observed: reads, plus stop and
// destroy, which work across CLI releases.
const OBSERVER_KINDS: ReadonlySet<SupabaseCliOperationKind> = new Set([
	'version',
	'stack.list',
	'stack.status',
	'stack.logs',
	'migration.list',
	'inspect',
	'db.dump',
	'stack.stop',
	'stack.destroy',
]);

const FEATURE_FOR_KIND: Partial<
	Record<SupabaseCliOperationKind, keyof SupabaseDialectFeatures>
> = {
	'stack.logs': 'logs',
	'stack.restart': 'restart',
	'stack.prepare': 'prepare',
	'migration.list': 'migrations',
	'migration.up': 'migrations',
	inspect: 'inspect',
	'db.dump': 'dump',
};

/**
 * Builds the argv for one operation. `null` is accepted only for `version`,
 * which is how a binary's dialect is found in the first place. Inputs are
 * re-validated here because they may have crossed IPC; the result is then
 * checked against the same allowlist assertSupabaseArgvAllowed uses.
 */
export function buildSupabaseArgv(
	dialect: null,
	operation: VersionOperation
): readonly string[];
export function buildSupabaseArgv(
	dialect: SupabaseDialect,
	operation: SupabaseCliOperation
): readonly string[];
export function buildSupabaseArgv(
	dialect: SupabaseDialect | null,
	operation: SupabaseCliOperation
): readonly string[] {
	if (operation.kind === 'version') return Object.freeze(['--version']);
	if (dialect === null) {
		throw new SupabaseArgvError(
			'gate',
			'A Supabase CLI dialect is required for this operation.'
		);
	}
	const group = groupFor(dialect, operation);
	const argv = argvFor(group, operation);
	identifySupabaseArgv(argv);
	return Object.freeze(argv);
}

function groupFor(
	dialect: SupabaseDialect,
	operation: GroupOperation
): 'stack' {
	if (dialect.gate === 'unsupported') {
		throw new SupabaseArgvError(
			'gate',
			`Supabase CLI ${dialect.version} is not supported; only its version can be read.`
		);
	}
	if (!dialect.manageable && !OBSERVER_KINDS.has(operation.kind)) {
		throw new SupabaseArgvError(
			'gate',
			`Supabase CLI ${dialect.version} is not verified; RN Devtools only reads, stops and destroys its stacks.`
		);
	}
	const feature = FEATURE_FOR_KIND[operation.kind];
	if (feature !== undefined && !dialect.features[feature]) {
		throw new SupabaseArgvError(
			'feature',
			`Supabase CLI ${dialect.version} does not support ${operation.kind}.`
		);
	}
	if (
		operation.kind === 'stack.destroy' &&
		Array.isArray(operation.stackIds) &&
		operation.stackIds.length > 1 &&
		!dialect.features.multiDestroy
	) {
		throw new SupabaseArgvError(
			'feature',
			`Supabase CLI ${dialect.version} destroys one stack per call.`
		);
	}
	return dialect.group;
}

const JSON_OUTPUT = ['--output-format', 'json'] as const;

function argvFor(group: 'stack', operation: GroupOperation): string[] {
	switch (operation.kind) {
		case 'stack.list':
			return [group, 'list', ...JSON_OUTPUT];
		case 'stack.status':
			return [
				group,
				'status',
				'--stack-id',
				stackIdOf(operation.stackId),
				...JSON_OUTPUT,
			];
		case 'stack.start':
			return [
				group,
				'start',
				...stackTarget(operation),
				'--runtime',
				'native',
				...excludeFlags(operation.exclude),
				...(eagerRequested(operation) ? ['--eager'] : []),
				...JSON_OUTPUT,
			];
		case 'stack.stop':
			return [
				group,
				'stop',
				'--stack-id',
				stackIdOf(operation.stackId),
				...JSON_OUTPUT,
			];
		case 'stack.restart':
			return [
				group,
				'restart',
				'--stack-id',
				stackIdOf(operation.stackId),
				...JSON_OUTPUT,
			];
		case 'stack.destroy':
			return [
				group,
				'destroy',
				...destroyTargets(operation.stackIds),
				...(operation.confirmed === true ? ['--yes'] : []),
				...JSON_OUTPUT,
			];
		case 'stack.logs':
			return [
				group,
				'logs',
				'--stack-id',
				stackIdOf(operation.stackId),
				...logServiceFlags(operation.services),
				'--tail',
				String(logTailOf(operation.tail)),
				...(operation.since === undefined
					? []
					: ['--since', logSinceOf(operation.since)]),
				...JSON_OUTPUT,
			];
		case 'stack.prepare':
			return [
				group,
				'prepare',
				...stackTarget(operation),
				'--runtime',
				'native',
				...capabilityFlags(operation.capabilities),
				...JSON_OUTPUT,
			];
		case 'migration.list':
			return [
				'migration',
				'list',
				...readTarget(operation.target),
				'--workdir',
				absolutePathOf(operation.workdir, 'workdir'),
				...JSON_OUTPUT,
			];
		case 'migration.up':
			return [
				'migration',
				'up',
				'--local',
				'--workdir',
				absolutePathOf(operation.workdir, 'workdir'),
				...JSON_OUTPUT,
			];
		case 'db.reset':
			return [
				'db',
				'reset',
				'--local',
				...(operation.noSeed === true ? ['--no-seed'] : []),
				'--workdir',
				absolutePathOf(operation.workdir, 'workdir'),
				...JSON_OUTPUT,
			];
		case 'inspect':
			return [
				'inspect',
				'db',
				inspectReportOf(operation.name),
				...readTarget(operation.target),
				'--workdir',
				absolutePathOf(operation.workdir, 'workdir'),
				...JSON_OUTPUT,
			];
		case 'db.dump':
			return [
				'db',
				'dump',
				...readTarget(operation.target),
				'--workdir',
				absolutePathOf(operation.workdir, 'workdir'),
				'--file',
				absolutePathOf(operation.file, 'file'),
				...(operation.dataOnly === true ? ['--data-only'] : []),
				...JSON_OUTPUT,
			];
		case 'seed.buckets':
			return [
				'seed',
				'buckets',
				'--local',
				'--workdir',
				absolutePathOf(operation.workdir, 'workdir'),
				...JSON_OUTPUT,
			];
		default:
			return unknownOperation(operation);
	}
}

function unknownOperation(operation: never): never {
	const kind = (operation as { kind?: unknown }).kind;
	throw new SupabaseArgvError(
		'invalid-input',
		`Unknown Supabase CLI operation ${typeof kind === 'string' ? JSON.stringify(kind.slice(0, 40)) : ''}.`
	);
}

function isStackId(value: string): boolean {
	return STACK_ID_PATTERN.test(value);
}

function isAbsolutePath(value: string): boolean {
	return (
		value.length >= 2 &&
		value.length <= MAX_PATH_LENGTH &&
		path.isAbsolute(value) &&
		path.normalize(value) === value &&
		!value.endsWith('/') &&
		!hasSupabaseControlCharacters(value)
	);
}

function stackIdOf(value: unknown): string {
	if (typeof value !== 'string' || !isStackId(value)) {
		throw new SupabaseArgvError(
			'invalid-input',
			'A stack is addressed by its full 64-character lowercase hex id.'
		);
	}
	return value;
}

function absolutePathOf(value: unknown, field: string): string {
	if (typeof value !== 'string' || !isAbsolutePath(value)) {
		throw new SupabaseArgvError(
			'invalid-input',
			`The ${field} must be a normalized absolute path.`
		);
	}
	return value;
}

function eagerRequested(
	operation: Readonly<{ workdir?: unknown; eager?: unknown }>
): boolean {
	return typeof operation.workdir === 'string' && operation.eager === true;
}

function stackTarget(
	operation: Readonly<{ workdir?: unknown; stackId?: unknown }>
): string[] {
	const hasWorkdir = operation.workdir !== undefined;
	const hasStackId = operation.stackId !== undefined;
	if (hasWorkdir === hasStackId) {
		throw new SupabaseArgvError(
			'invalid-input',
			'Pass exactly one of a workdir or a stack id.'
		);
	}
	return hasWorkdir
		? ['--workdir', absolutePathOf(operation.workdir, 'workdir')]
		: ['--stack-id', stackIdOf(operation.stackId)];
}

function capabilityList<T extends string>(
	values: unknown,
	allowed: readonly T[],
	field: string
): T[] {
	if (!Array.isArray(values)) {
		throw new SupabaseArgvError(
			'invalid-input',
			`The ${field} must be a list.`
		);
	}
	const selected = new Set<string>();
	for (const value of values) {
		if (
			typeof value !== 'string' ||
			!(allowed as readonly string[]).includes(value)
		) {
			throw new SupabaseArgvError(
				'invalid-input',
				`The ${field} may only name known capabilities.`
			);
		}
		selected.add(value);
	}
	// Canonical order keeps argv, and anything fingerprinting it, stable.
	return allowed.filter((capability) => selected.has(capability));
}

function excludeFlags(values: unknown): string[] {
	const capabilities = capabilityList(
		values,
		SUPABASE_EXCLUDABLE_CAPABILITIES,
		'exclusions'
	);
	return capabilities.length === 0 ? [] : ['--exclude', capabilities.join(',')];
}

function capabilityFlags(values: unknown): string[] {
	return capabilityList(
		values,
		SUPABASE_PREPARABLE_CAPABILITIES,
		'capabilities'
	).flatMap((capability) => ['--capability', capability]);
}

function destroyTargets(values: unknown): string[] {
	if (
		!Array.isArray(values) ||
		values.length === 0 ||
		values.length > MAX_DESTROY_STACKS
	) {
		throw new SupabaseArgvError(
			'invalid-input',
			`Destroy between 1 and ${MAX_DESTROY_STACKS} stacks at once.`
		);
	}
	const ids = values.map((value) => stackIdOf(value));
	if (new Set(ids).size !== ids.length) {
		throw new SupabaseArgvError(
			'invalid-input',
			'A stack may be named only once per destroy.'
		);
	}
	return ids.flatMap((id) => ['--stack-id', id]);
}

function isLogService(value: string): boolean {
	return LOG_SERVICE_NAMES.has(value) || INSTANCE_ID_PATTERN.test(value);
}

function logServiceFlags(values: unknown): string[] {
	if (values === undefined) return [];
	if (
		!Array.isArray(values) ||
		values.length > MAX_LOG_SERVICES ||
		values.some((value) => typeof value !== 'string' || !isLogService(value))
	) {
		throw new SupabaseArgvError(
			'invalid-input',
			'Log services must be service kinds, instance ids, or gateway.'
		);
	}
	return [...new Set(values as string[])].flatMap((service) => [
		'--service',
		service,
	]);
}

function isLogTail(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0 && value <= MAX_LOG_TAIL;
}

function logTailOf(value: unknown): number {
	if (typeof value !== 'number' || !isLogTail(value)) {
		throw new SupabaseArgvError(
			'invalid-input',
			`The log tail must be an integer from 0 to ${MAX_LOG_TAIL}.`
		);
	}
	return value;
}

function isLogSince(value: string): boolean {
	return (
		value.length <= 64 &&
		(value === 'start' ||
			SINCE_DURATION_PATTERN.test(value) ||
			(SINCE_TIMESTAMP_PATTERN.test(value) && !Number.isNaN(Date.parse(value))))
	);
}

function logSinceOf(value: unknown): string {
	if (typeof value !== 'string' || !isLogSince(value)) {
		throw new SupabaseArgvError(
			'invalid-input',
			'The log window must be start, a duration such as 10m, or an ISO-8601 time.'
		);
	}
	return value;
}

function inspectReportOf(value: unknown): SupabaseInspectReport {
	const report = INSPECT_REPORTS.find((candidate) => candidate === value);
	if (report === undefined) {
		throw new SupabaseArgvError(
			'invalid-input',
			'Only the db-stats and table-stats reports are supported.'
		);
	}
	return report;
}

/**
 * A postgres URL on 127.0.0.1 or [::1] with no fragment, whitespace or
 * control characters; with `requireTlsDisabled`, one sslmode=disable too.
 */
export function isLoopbackDatabaseUrl(
	value: string,
	requireTlsDisabled: boolean
): boolean {
	if (
		value.length > MAX_DATABASE_URL_LENGTH ||
		hasSupabaseControlCharacters(value) ||
		/\s/.test(value)
	) {
		return false;
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	const port = Number(url.port);
	return (
		(url.protocol === 'postgresql:' || url.protocol === 'postgres:') &&
		(url.hostname === '127.0.0.1' || url.hostname === '[::1]') &&
		Number.isInteger(port) &&
		port >= 1 &&
		port <= 65_535 &&
		url.hash === '' &&
		(!requireTlsDisabled ||
			(url.searchParams.getAll('sslmode').length === 1 &&
				url.searchParams.get('sslmode') === 'disable'))
	);
}

function readTarget(target: unknown): string[] {
	if (target === 'local') return ['--local'];
	const dbUrl =
		typeof target === 'object' && target !== null
			? (target as { dbUrl?: unknown }).dbUrl
			: undefined;
	if (typeof dbUrl !== 'string' || !isLoopbackDatabaseUrl(dbUrl, false)) {
		throw new SupabaseArgvError(
			'invalid-input',
			'A database read targets local or a loopback postgres URL.'
		);
	}
	// Edit only the query so the encoded userinfo keeps its exact bytes.
	const queryAt = dbUrl.indexOf('?');
	const base = queryAt < 0 ? dbUrl : dbUrl.slice(0, queryAt);
	const parameters = new URLSearchParams(
		queryAt < 0 ? '' : dbUrl.slice(queryAt + 1)
	);
	parameters.set('sslmode', 'disable');
	return ['--db-url', `${base}?${parameters.toString()}`];
}

// ---------------------------------------------------------------------------
// Argv allowlist

type FlagRule = Readonly<{
	value?: (value: string) => boolean;
	repeatable?: boolean;
}>;
type ParsedFlags = ReadonlyMap<string, readonly string[]>;
type CommandSpec = Readonly<{
	kind: SupabaseCliOperationKind;
	words: readonly string[];
	flags: Readonly<Record<string, FlagRule>>;
	check?: (flags: ParsedFlags) => string | undefined;
}>;

const BOOLEAN: FlagRule = {};
const STACK_ID: FlagRule = { value: isStackId };
const PATH: FlagRule = { value: isAbsolutePath };
const NATIVE_RUNTIME: FlagRule = { value: (value) => value === 'native' };
const DATABASE_URL: FlagRule = {
	value: (value) => isLoopbackDatabaseUrl(value, true),
};
const OUTPUT_FORMAT: FlagRule = { value: (value) => value === 'json' };

function isCapabilityList(value: string, allowed: readonly string[]): boolean {
	const values = value.split(',');
	return (
		values.length > 0 &&
		values.every((entry) => allowed.includes(entry)) &&
		new Set(values).size === values.length
	);
}

function count(flags: ParsedFlags, name: string): number {
	return flags.get(name)?.length ?? 0;
}

function exactlyOne(
	flags: ParsedFlags,
	first: string,
	second: string
): boolean {
	return (
		(count(flags, first) > 0 ? 1 : 0) + (count(flags, second) > 0 ? 1 : 0) === 1
	);
}

function requireFlags(...names: string[]) {
	return (flags: ParsedFlags): string | undefined => {
		const missing = names.find((name) => count(flags, name) === 0);
		return missing === undefined ? undefined : `${missing} is required`;
	};
}

function allOf(
	...checks: ((flags: ParsedFlags) => string | undefined)[]
): (flags: ParsedFlags) => string | undefined {
	return (flags) => {
		for (const check of checks) {
			const problem = check(flags);
			if (problem !== undefined) return problem;
		}
		return undefined;
	};
}

function oneOf(first: string, second: string) {
	return (flags: ParsedFlags): string | undefined =>
		exactlyOne(flags, first, second)
			? undefined
			: `exactly one of ${first} or ${second} is required`;
}

function distinct(name: string, max: number) {
	return (flags: ParsedFlags): string | undefined => {
		const values = flags.get(name) ?? [];
		return values.length <= max && new Set(values).size === values.length
			? undefined
			: `${name} values must be distinct and at most ${max}`;
	};
}

const STACK_COMMANDS: readonly CommandSpec[] = [
	{ kind: 'stack.list', words: ['stack', 'list'], flags: {} },
	{
		kind: 'stack.status',
		words: ['stack', 'status'],
		flags: { '--stack-id': STACK_ID },
		check: requireFlags('--stack-id'),
	},
	{
		kind: 'stack.start',
		words: ['stack', 'start'],
		flags: {
			'--workdir': PATH,
			'--stack-id': STACK_ID,
			'--runtime': NATIVE_RUNTIME,
			'--exclude': {
				value: (value) =>
					isCapabilityList(value, SUPABASE_EXCLUDABLE_CAPABILITIES),
			},
			'--eager': BOOLEAN,
		},
		check: allOf(
			oneOf('--workdir', '--stack-id'),
			requireFlags('--runtime'),
			(flags) =>
				count(flags, '--eager') > 0 && count(flags, '--workdir') === 0
					? '--eager applies only when creating from a workdir'
					: undefined
		),
	},
	{
		kind: 'stack.stop',
		words: ['stack', 'stop'],
		flags: { '--stack-id': STACK_ID },
		check: requireFlags('--stack-id'),
	},
	{
		kind: 'stack.restart',
		words: ['stack', 'restart'],
		flags: { '--stack-id': STACK_ID },
		check: requireFlags('--stack-id'),
	},
	{
		kind: 'stack.destroy',
		words: ['stack', 'destroy'],
		flags: {
			'--stack-id': { ...STACK_ID, repeatable: true },
			'--yes': BOOLEAN,
		},
		check: allOf(
			requireFlags('--stack-id'),
			distinct('--stack-id', MAX_DESTROY_STACKS)
		),
	},
	{
		kind: 'stack.logs',
		words: ['stack', 'logs'],
		flags: {
			'--stack-id': STACK_ID,
			'--service': { value: isLogService, repeatable: true },
			'--tail': {
				value: (value) => /^\d{1,4}$/.test(value) && isLogTail(Number(value)),
			},
			'--since': { value: isLogSince },
		},
		check: allOf(
			requireFlags('--stack-id', '--tail'),
			distinct('--service', MAX_LOG_SERVICES)
		),
	},
	{
		kind: 'stack.prepare',
		words: ['stack', 'prepare'],
		flags: {
			'--workdir': PATH,
			'--stack-id': STACK_ID,
			'--runtime': NATIVE_RUNTIME,
			'--capability': {
				value: (value) =>
					(SUPABASE_PREPARABLE_CAPABILITIES as readonly string[]).includes(
						value
					),
				repeatable: true,
			},
		},
		check: allOf(
			oneOf('--workdir', '--stack-id'),
			requireFlags('--runtime'),
			distinct('--capability', SUPABASE_PREPARABLE_CAPABILITIES.length)
		),
	},
];

const DATABASE_COMMANDS: readonly CommandSpec[] = [
	{
		kind: 'migration.list',
		words: ['migration', 'list'],
		flags: { '--local': BOOLEAN, '--db-url': DATABASE_URL, '--workdir': PATH },
		check: allOf(requireFlags('--workdir'), oneOf('--local', '--db-url')),
	},
	{
		kind: 'migration.up',
		words: ['migration', 'up'],
		flags: { '--local': BOOLEAN, '--workdir': PATH },
		check: requireFlags('--local', '--workdir'),
	},
	{
		kind: 'db.reset',
		words: ['db', 'reset'],
		flags: { '--local': BOOLEAN, '--no-seed': BOOLEAN, '--workdir': PATH },
		check: requireFlags('--local', '--workdir'),
	},
	...INSPECT_REPORTS.map(
		(report): CommandSpec => ({
			kind: 'inspect',
			words: ['inspect', 'db', report],
			flags: {
				'--local': BOOLEAN,
				'--db-url': DATABASE_URL,
				'--workdir': PATH,
			},
			check: allOf(requireFlags('--workdir'), oneOf('--local', '--db-url')),
		})
	),
	{
		kind: 'db.dump',
		words: ['db', 'dump'],
		flags: {
			'--local': BOOLEAN,
			'--db-url': DATABASE_URL,
			'--workdir': PATH,
			'--file': PATH,
			'--data-only': BOOLEAN,
		},
		check: allOf(
			requireFlags('--workdir', '--file'),
			oneOf('--local', '--db-url')
		),
	},
	{
		kind: 'seed.buckets',
		words: ['seed', 'buckets'],
		flags: { '--local': BOOLEAN, '--workdir': PATH },
		check: requireFlags('--local', '--workdir'),
	},
];

const COMMAND_SPECS: readonly CommandSpec[] = [
	...STACK_COMMANDS,
	...DATABASE_COMMANDS,
];

function describeToken(token: string): string {
	return /^--?[a-z][a-z-]{0,40}$/.test(token) ? token : 'an argument';
}

function argvViolation(message: string): SupabaseArgvError {
	return new SupabaseArgvError(
		'not-allowed',
		`Supabase argv rejected: ${message}.`
	);
}

/**
 * Identifies which operation an argv performs and proves it uses only allowed
 * flags with valid values. Anything unknown is rejected, which is what keeps
 * `--all`, `--stack`, `--env`, `--debug`, `--dry-run`, `--linked`, `--follow`,
 * non-native runtimes and `--yes` outside destroy out of every argv.
 */
function identifySupabaseArgv(
	argv: readonly string[]
): SupabaseCliOperationKind {
	if (
		!Array.isArray(argv) ||
		argv.length === 0 ||
		argv.length > MAX_ARGV_LENGTH ||
		argv.some(
			(token) =>
				typeof token !== 'string' ||
				token.length === 0 ||
				token.length > MAX_ARGUMENT_LENGTH ||
				hasSupabaseControlCharacters(token)
		)
	) {
		throw argvViolation('argv must be a short list of plain strings');
	}
	if (argv.length === 1 && argv[0] === '--version') return 'version';
	const spec = COMMAND_SPECS.find((candidate) =>
		candidate.words.every((word, index) => argv[index] === word)
	);
	if (!spec) throw argvViolation('unknown command');
	const flags = new Map<string, string[]>();
	for (let index = spec.words.length; index < argv.length; index += 1) {
		const token = argv[index] ?? '';
		const rule =
			token === '--output-format'
				? OUTPUT_FORMAT
				: Object.hasOwn(spec.flags, token)
					? spec.flags[token]
					: undefined;
		if (rule === undefined) {
			throw argvViolation(
				`${describeToken(token)} is not allowed for ${spec.kind}`
			);
		}
		let value = '';
		if (rule.value !== undefined) {
			const next = argv[index + 1];
			if (next === undefined || !rule.value(next)) {
				throw argvViolation(`${token} has an invalid value`);
			}
			value = next;
			index += 1;
		}
		const values = flags.get(token) ?? [];
		if (values.length > 0 && rule.repeatable !== true) {
			throw argvViolation(`${token} may appear only once`);
		}
		values.push(value);
		flags.set(token, values);
	}
	if (count(flags, '--output-format') !== 1) {
		throw argvViolation('--output-format json is required');
	}
	const problem = spec.check?.(flags);
	if (problem !== undefined) throw argvViolation(problem);
	return spec.kind;
}

/** The commands a read-only run, such as a binary's version probe, may run. */
const READ_ONLY_KINDS: ReadonlySet<SupabaseCliOperationKind> = new Set([
	'version',
	'stack.list',
	'stack.status',
	'stack.logs',
	'migration.list',
	'inspect',
]);

/**
 * Throws unless `argv` is a well-formed command, and with `readOnly` one
 * that changes nothing. Run it on every argv right before spawning. Returns
 * the operation kind the argv performs.
 */
export function assertSupabaseArgvAllowed(
	argv: readonly string[],
	readOnly = false
): SupabaseCliOperationKind {
	const kind = identifySupabaseArgv(argv);
	if (readOnly && !READ_ONLY_KINDS.has(kind)) {
		throw new SupabaseArgvError(
			'read-only',
			`${kind} is not allowed in a read-only run.`
		);
	}
	return kind;
}

/** The longest budget the runner accepts for one call. */
export const SUPABASE_MAX_CLI_TIMEOUT_MS = 60 * 60_000;

export type SupabaseOperationBudget = Readonly<{
	timeoutMs: number;
	/** How long to wait after SIGINT before sending SIGTERM. */
	interruptGraceMs: number;
	/** How long to wait after SIGTERM before SIGKILL; undefined means never. */
	forceKillAfterMs: number | undefined;
	/** Lifecycle children run detached so they survive the request and the app. */
	detached: boolean;
}>;

const READ_BUDGET: SupabaseOperationBudget = Object.freeze({
	timeoutMs: 20_000,
	interruptGraceMs: 5_000,
	forceKillAfterMs: 5_000,
	detached: false,
});

function lifecycleBudget(timeoutMs: number): SupabaseOperationBudget {
	// Never SIGKILL a mutation: a killed first start has no recovery journal.
	return {
		timeoutMs,
		interruptGraceMs: 45_000,
		forceKillAfterMs: undefined,
		detached: true,
	};
}

/**
 * The time budget and kill rule for each operation, from the measured
 * timings at 2.121.0 (4.5 s warm create, 42.6 s first-ever create, 1.0 s
 * resume, 3.2 s idle stop, 4.6 s reset) with headroom for cold caches.
 */
export function supabaseOperationBudget(
	operation: SupabaseCliOperation
): SupabaseOperationBudget {
	switch (operation.kind) {
		case 'version':
			return {
				timeoutMs: 10_000,
				interruptGraceMs: 2_000,
				forceKillAfterMs: 2_000,
				detached: false,
			};
		case 'stack.logs':
			return { ...READ_BUDGET, timeoutMs: 15_000 };
		case 'stack.list':
		case 'stack.status':
		case 'migration.list':
		case 'inspect':
			return READ_BUDGET;
		case 'db.dump':
			return {
				timeoutMs: 300_000,
				interruptGraceMs: 10_000,
				forceKillAfterMs: 10_000,
				detached: false,
			};
		case 'stack.start':
			return lifecycleBudget(
				typeof operation.workdir === 'string' ? 300_000 : 120_000
			);
		case 'stack.stop':
			return lifecycleBudget(90_000);
		case 'stack.restart':
			return lifecycleBudget(120_000);
		case 'stack.destroy':
			// Two minutes per stack, within what the runner accepts for one call.
			return lifecycleBudget(
				Math.min(
					SUPABASE_MAX_CLI_TIMEOUT_MS,
					120_000 *
						Math.max(
							1,
							Array.isArray(operation.stackIds) ? operation.stackIds.length : 1
						)
				)
			);
		case 'stack.prepare':
			return lifecycleBudget(600_000);
		case 'db.reset':
			return lifecycleBudget(180_000);
		case 'migration.up':
		case 'seed.buckets':
			return lifecycleBudget(120_000);
		default:
			return unknownOperation(operation);
	}
}

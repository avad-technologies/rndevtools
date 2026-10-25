import path from 'node:path';
import { inspect } from 'node:util';
import { z } from 'zod';
import { isLoopbackHttpUrl } from '../../shared/supabase-protocol';
import { sanitizeSupabaseText } from './cli-redact';
import { isLoopbackDatabaseUrl } from './dialect';

/**
 * Projections of the Supabase CLI's `--output-format json` surfaces at the
 * verified dialect. Every schema is a strip-mode `z.object`, so fields the
 * desktop does not declare (SECRET_KEY, SERVICE_ROLE_KEY, the S3 keys,
 * MCP_URL, whatever a later release adds) never survive parsing. The env map
 * is split in two:
 * - SupabasePublicEndpoints: loopback http URLs, safe for the renderer;
 * - MainOnlyCredentials: the publishable key, anon key and DB_URL, which stay
 *   in main and refuse to serialize.
 * Projections are camelCase, frozen where cheap, and carry no raw output.
 * Parse failures report field paths and issue codes, never values.
 */

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const port = z.number().int().min(1).max(65_535);
const text = (max: number) => z.string().max(max);
const instanceId = z.string().regex(/^[0-9A-Za-z-]{1,64}$/);
const slug = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const statValue = z.union([text(256), z.number()]).nullish();

const runtimeSchema = z.enum(['native', 'docker', 'podman']);
const ownerSchema = z.enum(['reachable', 'unavailable']);
const lifecycleSchema = z.enum(['starting', 'stopping', 'running', 'stopped']);
const readinessSchema = z.enum([
	'unavailable',
	'starting',
	'sleeping',
	'stopped',
	'ready',
	'unhealthy',
]);
const serviceStateSchema = z.enum([
	'unavailable',
	'unhealthy',
	'exited',
	'sleeping',
	'stopped',
	'starting',
	'running',
	'stopping',
]);
const healthSchema = z.enum(['starting', 'healthy', 'unhealthy']);
const activationSchema = z.enum(['eager', 'lazy']);
const configDriftSchema = z.enum(['unchanged', 'changed', 'unavailable']);
const serviceKindSchema = z.enum([
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
	'unknown',
]);

type SupabaseRuntime = z.infer<typeof runtimeSchema>;
type SupabaseOwner = z.infer<typeof ownerSchema>;
type SupabaseLifecycle = z.infer<typeof lifecycleSchema>;
type SupabaseReadiness = z.infer<typeof readinessSchema>;
type SupabaseServiceState = z.infer<typeof serviceStateSchema>;
type SupabaseServiceHealth = z.infer<typeof healthSchema>;
type SupabaseServiceKind = z.infer<typeof serviceKindSchema>;
type SupabaseConfigDrift = z.infer<typeof configDriftSchema>;

/**
 * A surface name for errors: an operation kind or `error-envelope`.
 */
export type SupabaseContractSurface = string;

/** The CLI printed JSON the verified contract does not describe. */
export class SupabaseContractError extends Error {
	readonly surface: SupabaseContractSurface;
	/** `path: code` pairs; never values. */
	readonly issues: readonly string[];

	constructor(surface: SupabaseContractSurface, issues: readonly string[]) {
		super(`Unexpected Supabase CLI output for ${surface}.`);
		this.name = 'SupabaseContractError';
		this.surface = surface;
		this.issues = Object.freeze([...issues]);
	}
}

function safePathSegment(segment: PropertyKey): string {
	if (typeof segment === 'number') return String(segment);
	return typeof segment === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(segment)
		? segment
		: '?';
}

function projectWith<Schema extends z.ZodType>(
	schema: Schema,
	value: unknown,
	surface: SupabaseContractSurface
): z.infer<Schema> {
	const parsed = schema.safeParse(value);
	if (parsed.success) return parsed.data;
	// Zod messages can quote patterns and keys; build the description from
	// paths and codes only.
	const issues = parsed.error.issues
		.slice(0, 8)
		.map(
			(issue) =>
				`${issue.path.map(safePathSegment).join('.') || '(root)'}: ${issue.code}`
		);
	throw new SupabaseContractError(surface, issues);
}

/**
 * Key material and the database URL from a start or status env map. Values
 * live in private fields: JSON gives `[redacted]`, structured clones (Electron
 * IPC) give an empty object, `util.inspect` shows nothing. Keep instances in
 * main; hand values to Metro's spawn env or the agent socket only by name.
 */
export class MainOnlyCredentials {
	readonly #publishableKey: string | undefined;
	readonly #anonKey: string | undefined;
	readonly #dbUrl: string | undefined;

	constructor(
		values: Readonly<{
			publishableKey?: string | undefined;
			anonKey?: string | undefined;
			dbUrl?: string | undefined;
		}> = {}
	) {
		this.#publishableKey = values.publishableKey;
		this.#anonKey = values.anonKey;
		this.#dbUrl = values.dbUrl;
	}

	get publishableKey(): string | undefined {
		return this.#publishableKey;
	}

	get anonKey(): string | undefined {
		return this.#anonKey;
	}

	/** `postgresql://postgres:<password>@127.0.0.1:<port>/postgres`. */
	get dbUrl(): string | undefined {
		return this.#dbUrl;
	}

	toJSON(): string {
		return '[redacted]';
	}

	[inspect.custom](): string {
		return 'MainOnlyCredentials [redacted]';
	}
}

/**
 * Renderer-safe loopback URLs from the env map.
 */
export type SupabasePublicEndpoints = Readonly<{
	apiUrl: string;
	/** Absent when rest is excluded. */
	restUrl?: string;
	/** Absent when functions is excluded. */
	functionsUrl?: string;
	/** Absent when mail is excluded. */
	mailpitUrl?: string;
	/** Present only while Studio is a composition member. */
	studioUrl?: string;
}>;

const PUBLISHABLE_KEY = /^sb_publishable_[A-Za-z0-9_-]{8,256}$/;
const ANON_KEY = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/;

const environmentSchema = z.object({
	API_URL: text(256).optional(),
	REST_URL: text(256).optional(),
	FUNCTIONS_URL: text(256).optional(),
	MAILPIT_URL: text(256).optional(),
	STUDIO_URL: text(256).optional(),
	PUBLISHABLE_KEY: text(1024).optional(),
	ANON_KEY: text(8192).optional(),
	DB_URL: text(2048).optional(),
});
type ProjectedEnvironment = z.infer<typeof environmentSchema>;

function projectEnvironment(
	environment: ProjectedEnvironment | undefined,
	surface: SupabaseContractSurface
): Readonly<{
	publicEndpoints: SupabasePublicEndpoints | undefined;
	credentials: MainOnlyCredentials;
}> {
	const env: ProjectedEnvironment = environment ?? {};
	const url = (name: string, value: string | undefined) => {
		if (value === undefined) return undefined;
		// A URL that is not loopback http is never handed on, so fail closed.
		if (!isLoopbackHttpUrl(value)) {
			throw new SupabaseContractError(surface, [
				`env.${name}: not_loopback_http`,
			]);
		}
		return value;
	};
	const apiUrl = url('API_URL', env.API_URL);
	const restUrl = url('REST_URL', env.REST_URL);
	const functionsUrl = url('FUNCTIONS_URL', env.FUNCTIONS_URL);
	const mailpitUrl = url('MAILPIT_URL', env.MAILPIT_URL);
	const studioUrl = url('STUDIO_URL', env.STUDIO_URL);
	let publicEndpoints: SupabasePublicEndpoints | undefined;
	if (apiUrl !== undefined) {
		const endpoints: {
			apiUrl: string;
			restUrl?: string;
			functionsUrl?: string;
			mailpitUrl?: string;
			studioUrl?: string;
		} = { apiUrl };
		if (restUrl !== undefined) endpoints.restUrl = restUrl;
		if (functionsUrl !== undefined) endpoints.functionsUrl = functionsUrl;
		if (mailpitUrl !== undefined) endpoints.mailpitUrl = mailpitUrl;
		if (studioUrl !== undefined) endpoints.studioUrl = studioUrl;
		publicEndpoints = Object.freeze(endpoints);
	}
	// A malformed credential is dropped rather than failing the whole parse.
	const publishableKey =
		env.PUBLISHABLE_KEY !== undefined &&
		PUBLISHABLE_KEY.test(env.PUBLISHABLE_KEY)
			? env.PUBLISHABLE_KEY
			: undefined;
	const anonKey =
		env.ANON_KEY !== undefined && ANON_KEY.test(env.ANON_KEY)
			? env.ANON_KEY
			: undefined;
	const dbUrl =
		env.DB_URL !== undefined && isLoopbackDatabaseUrl(env.DB_URL, false)
			? env.DB_URL
			: undefined;
	return {
		publicEndpoints,
		credentials: new MainOnlyCredentials({ publishableKey, anonKey, dbUrl }),
	};
}

const endpointSchema = z.object({
	protocol: z.enum(['tcp', 'http']),
	address: text(64),
	port,
});
const MAX_ENDPOINTS = 64;
const stackEndpointMap = z
	.record(
		z.string().regex(/^[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9_-]{0,31}$/),
		endpointSchema
	)
	.refine((record) => Object.keys(record).length <= MAX_ENDPOINTS);
const serviceEndpointMap = z
	.record(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/), endpointSchema)
	.refine((record) => Object.keys(record).length <= MAX_ENDPOINTS);

/**
 * A listener as the CLI reports it. The address is display only: it reads
 * 127.0.0.1 even for container stacks that bind every interface, so exposure
 * must be verified with lsof, never from here.
 */
type SupabaseEndpoint = Readonly<{
	protocol: 'tcp' | 'http';
	address: string;
	port: number;
}>;

function projectEndpoints(
	record: Readonly<Record<string, z.infer<typeof endpointSchema>>> | undefined
): Readonly<Record<string, SupabaseEndpoint>> {
	return Object.freeze(
		Object.fromEntries(
			Object.entries(record ?? {}).map(([name, endpoint]) => [
				name,
				Object.freeze({
					protocol: endpoint.protocol,
					address: endpoint.address,
					port: endpoint.port,
				}),
			])
		)
	);
}

// ---------------------------------------------------------------------------
// version

const VERSION_OUTPUT =
	/^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,64})?(?:\+[0-9A-Za-z.-]{1,64})?$/;

/** `--version` prints a bare semver line, not JSON. */
export function parseSupabaseVersion(stdout: string): string {
	const version = stdout.trim();
	if (!VERSION_OUTPUT.test(version)) {
		throw new SupabaseContractError('version', ['(root): invalid_format']);
	}
	return version;
}

// ---------------------------------------------------------------------------
// stack list

const listSchema = z.object({
	stacks: z
		.array(
			z.object({
				id: hex64,
				project_root: text(4096),
				name: text(128),
				branch_context: text(1024),
				runtime: runtimeSchema,
				owner: ownerSchema,
			})
		)
		.max(512),
});

export type SupabaseStackListEntry = Readonly<{
	id: string;
	/** Realpath of the project root when the stack was created; it may be gone. */
	projectRoot: string;
	name: string;
	/** `refs/heads/<branch>`, another ref, `detached`, or `ordinary-workspace`. */
	branchContext: string;
	runtime: SupabaseRuntime;
	/** `reachable` only means an owner answered; it does not check the release. */
	owner: SupabaseOwner;
}>;

export type SupabaseStackList = Readonly<{
	stacks: readonly SupabaseStackListEntry[];
	/** Stacks the CLI skipped because their state could not be decoded. */
	unreadable: readonly Readonly<{ id: string; message: string }>[];
}>;

const UNREADABLE_STACK_WARNING =
	/^Warning: skipping invalid stack ([0-9a-f]{64}): (.*)$/;

export function parseSupabaseStackList(
	json: unknown,
	stderrLines: readonly string[] = []
): SupabaseStackList {
	const parsed = projectWith(listSchema, json, 'stack.list');
	const unreadable = stderrLines.flatMap((line) => {
		const match = UNREADABLE_STACK_WARNING.exec(line.trim());
		const id = match?.[1];
		if (id === undefined) return [];
		return [
			Object.freeze({
				id,
				message: sanitizeSupabaseText(match?.[2] ?? '', { maxChars: 512 }),
			}),
		];
	});
	return Object.freeze({
		stacks: Object.freeze(
			parsed.stacks.map((stack) =>
				Object.freeze({
					id: stack.id,
					projectRoot: stack.project_root,
					name: stack.name,
					branchContext: stack.branch_context,
					runtime: stack.runtime,
					owner: stack.owner,
				})
			)
		),
		unreadable: Object.freeze(unreadable.slice(0, 512)),
	});
}

// ---------------------------------------------------------------------------
// stack status

const memberSchema = z.object({
	id: instanceId,
	service: serviceKindSchema,
	activation: activationSchema,
	state: serviceStateSchema,
	lifecycle: lifecycleSchema.nullish(),
	health: healthSchema.nullish(),
});

const statusServiceSchema = z.object({
	id: instanceId,
	service: serviceKindSchema,
	state: serviceStateSchema,
	lifecycle: lifecycleSchema.nullish(),
	health: healthSchema.nullish(),
	endpoints: serviceEndpointMap.optional(),
	error: z.string().optional(),
});

const identitySchema = z.object({
	id: hex64,
	name: text(128),
	project_root: text(4096),
	branch_context: text(1024),
});

const statusSchema = z.object({
	identity: identitySchema,
	runtime: runtimeSchema,
	owner: ownerSchema,
	lifecycle: lifecycleSchema.nullish(),
	readiness: readinessSchema,
	composition: z.object({ members: z.array(memberSchema).max(64) }).optional(),
	services: z.array(statusServiceSchema).max(64).optional(),
	endpoints: stackEndpointMap.optional(),
	config_drift: z
		.object({
			status: configDriftSchema,
			message: z.string().optional(),
			paths: z.array(text(512)).max(64).optional(),
		})
		.optional(),
	env: environmentSchema.optional(),
});

type SupabaseStackIdentity = Readonly<{
	id: string;
	name: string;
	projectRoot: string;
	branchContext: string;
}>;

type SupabaseCompositionMember = Readonly<{
	id: string;
	service: SupabaseServiceKind;
	activation: 'eager' | 'lazy';
	state: SupabaseServiceState;
	lifecycle: SupabaseLifecycle | null;
	health: SupabaseServiceHealth | null;
}>;

type SupabaseServiceStatus = Readonly<{
	id: string;
	service: SupabaseServiceKind;
	state: SupabaseServiceState;
	lifecycle: SupabaseLifecycle | null;
	health: SupabaseServiceHealth | null;
	endpoints: Readonly<Record<string, SupabaseEndpoint>>;
	/** Sanitized per-service failure, such as a CLI release mismatch. */
	error: string | undefined;
}>;

export type SupabaseReleaseMismatch = Readonly<{
	stackId: string | undefined;
	ownerRelease: string;
	clientRelease: string;
}>;

export type SupabaseStackStatus = Readonly<{
	identity: SupabaseStackIdentity;
	runtime: SupabaseRuntime;
	owner: SupabaseOwner;
	/** JSON null when nothing was observed: stopped, unreachable, or mismatched. */
	lifecycle: SupabaseLifecycle | null;
	/**
	 * Aggregated over every saved instance, excluded ones included; derive
	 * badges from `members` instead. `sleeping` is the normal idle state.
	 */
	readiness: SupabaseReadiness;
	members: readonly SupabaseCompositionMember[];
	services: readonly SupabaseServiceStatus[];
	endpoints: Readonly<Record<string, SupabaseEndpoint>>;
	configDrift:
		| Readonly<{
				status: SupabaseConfigDrift;
				message: string | undefined;
				paths: readonly string[];
		  }>
		| undefined;
	/** Set when an owner of another CLI release serves this stack. */
	releaseMismatch: SupabaseReleaseMismatch | undefined;
	/** Absent while stopped: a stopped stack reports no URLs. */
	publicEndpoints: SupabasePublicEndpoints | undefined;
	credentials: MainOnlyCredentials;
}>;

const RELEASE_MISMATCH =
	/(?:Stack ([0-9a-f]{4,64}) )?is served by release ([0-9A-Za-z.+-]{1,64}), but this client is release ([0-9A-Za-z.+-]{1,64})/;

/**
 * Reads the owner/client release pair from the CLI's mismatch text, which an
 * owner reports when a different CLI release talks to it.
 */
export function parseSupabaseReleaseMismatch(
	value: string
): SupabaseReleaseMismatch | undefined {
	const match = RELEASE_MISMATCH.exec(value);
	const ownerRelease = match?.[2];
	const clientRelease = match?.[3];
	if (ownerRelease === undefined || clientRelease === undefined)
		return undefined;
	return Object.freeze({ stackId: match?.[1], ownerRelease, clientRelease });
}

export function parseSupabaseStackStatus(json: unknown): SupabaseStackStatus {
	const parsed = projectWith(statusSchema, json, 'stack.status');
	const { publicEndpoints, credentials } = projectEnvironment(
		parsed.env,
		'stack.status'
	);
	const services = (parsed.services ?? []).map((service) =>
		Object.freeze({
			id: service.id,
			service: service.service,
			state: service.state,
			lifecycle: service.lifecycle ?? null,
			health: service.health ?? null,
			endpoints: projectEndpoints(service.endpoints),
			error:
				service.error === undefined
					? undefined
					: sanitizeSupabaseText(service.error, { maxChars: 1024 }),
		})
	);
	let releaseMismatch: SupabaseReleaseMismatch | undefined;
	for (const service of services) {
		releaseMismatch = parseSupabaseReleaseMismatch(service.error ?? '');
		if (releaseMismatch !== undefined) break;
	}
	const drift = parsed.config_drift;
	return Object.freeze({
		identity: Object.freeze({
			id: parsed.identity.id,
			name: parsed.identity.name,
			projectRoot: parsed.identity.project_root,
			branchContext: parsed.identity.branch_context,
		}),
		runtime: parsed.runtime,
		owner: parsed.owner,
		lifecycle: parsed.lifecycle ?? null,
		readiness: parsed.readiness,
		members: Object.freeze(
			(parsed.composition?.members ?? []).map((member) =>
				Object.freeze({
					id: member.id,
					service: member.service,
					activation: member.activation,
					state: member.state,
					lifecycle: member.lifecycle ?? null,
					health: member.health ?? null,
				})
			)
		),
		services: Object.freeze(services),
		endpoints: projectEndpoints(parsed.endpoints),
		configDrift:
			drift === undefined
				? undefined
				: Object.freeze({
						status: drift.status,
						message:
							drift.message === undefined
								? undefined
								: sanitizeSupabaseText(drift.message, { maxChars: 512 }),
						paths: Object.freeze(
							(drift.paths ?? []).map((entry) =>
								sanitizeSupabaseText(entry, { maxChars: 256 })
							)
						),
					}),
		releaseMismatch,
		publicEndpoints,
		credentials,
	});
}

// ---------------------------------------------------------------------------
// stack start

const startSchema = z.object({
	id: hex64,
	runtime: runtimeSchema,
	endpoints: stackEndpointMap,
	lazy_services: z.array(slug).max(32).optional(),
	env: environmentSchema,
	endpoint_changes: z
		.array(
			z.object({
				endpoint: text(128),
				keys: z.array(text(128)).max(32).optional(),
				from: port,
				to: port,
			})
		)
		.max(64)
		.optional(),
	message: z.string().optional(),
});

/**
 * A public port that moved since the stack last ran.
 */
type SupabaseEndpointChange = Readonly<{
	/** `api` or `<service>.<endpoint>`. */
	endpoint: string;
	/** Endpoint keys that share the moved listener, such as `rest.http`. */
	keys: readonly string[];
	from: number;
	to: number;
}>;

export type SupabaseStackStart = Readonly<{
	id: string;
	runtime: SupabaseRuntime;
	endpoints: Readonly<Record<string, SupabaseEndpoint>>;
	lazyServices: readonly string[];
	/** Empty when no port moved; restart Metro when not. */
	endpointChanges: readonly SupabaseEndpointChange[];
	/** The stack was already running, so no configuration was read. */
	alreadyRunning: boolean;
	publicEndpoints: SupabasePublicEndpoints | undefined;
	credentials: MainOnlyCredentials;
}>;

export function parseSupabaseStackStart(json: unknown): SupabaseStackStart {
	const parsed = projectWith(startSchema, json, 'stack.start');
	const { publicEndpoints, credentials } = projectEnvironment(
		parsed.env,
		'stack.start'
	);
	return Object.freeze({
		id: parsed.id,
		runtime: parsed.runtime,
		endpoints: projectEndpoints(parsed.endpoints),
		lazyServices: Object.freeze([...(parsed.lazy_services ?? [])]),
		endpointChanges: Object.freeze(
			(parsed.endpoint_changes ?? []).map((change) =>
				Object.freeze({
					endpoint: change.endpoint,
					keys: Object.freeze([...(change.keys ?? [])]),
					from: change.from,
					to: change.to,
				})
			)
		),
		alreadyRunning: /\balready running\b/i.test(parsed.message ?? ''),
		publicEndpoints,
		credentials,
	});
}

// ---------------------------------------------------------------------------
// stack stop, restart, destroy

const stopSchema = z.object({
	stopped: z.array(hex64).max(64),
	not_running: z.array(hex64).max(64),
});

export type SupabaseStackStop = Readonly<{
	stopped: readonly string[];
	/** Already stopped; leftovers were reclaimed. */
	notRunning: readonly string[];
}>;

export function parseSupabaseStackStop(json: unknown): SupabaseStackStop {
	const parsed = projectWith(stopSchema, json, 'stack.stop');
	return Object.freeze({
		stopped: Object.freeze([...parsed.stopped]),
		notRunning: Object.freeze([...parsed.not_running]),
	});
}

const restartSchema = z.object({
	id: hex64,
	services: z
		.array(
			z.object({
				id: instanceId,
				service: serviceKindSchema,
				lifecycle: lifecycleSchema.nullish(),
				health: healthSchema.nullish(),
				wake_enabled: z.boolean(),
			})
		)
		.max(64),
});

/**
 * Restart reports no endpoints or env; follow it with a status.
 */
export type SupabaseStackRestart = Readonly<{
	id: string;
	services: readonly Readonly<{
		id: string;
		service: SupabaseServiceKind;
		lifecycle: SupabaseLifecycle | null;
		health: SupabaseServiceHealth | null;
		wakeEnabled: boolean;
	}>[];
}>;

export function parseSupabaseStackRestart(json: unknown): SupabaseStackRestart {
	const parsed = projectWith(restartSchema, json, 'stack.restart');
	return Object.freeze({
		id: parsed.id,
		services: Object.freeze(
			parsed.services.map((service) =>
				Object.freeze({
					id: service.id,
					service: service.service,
					lifecycle: service.lifecycle ?? null,
					health: service.health ?? null,
					wakeEnabled: service.wake_enabled,
				})
			)
		),
	});
}

const destroySchema = z.union([
	z.object({ destroyed: z.literal(true), id: hex64 }),
	z.object({
		destroyed: z.literal(true),
		stacks: z
			.array(z.object({ id: hex64 }))
			.min(1)
			.max(64),
	}),
]);

export type SupabaseStackDestroy = Readonly<{
	destroyedIds: readonly string[];
}>;

export function parseSupabaseStackDestroy(json: unknown): SupabaseStackDestroy {
	const parsed = projectWith(destroySchema, json, 'stack.destroy');
	const ids =
		'id' in parsed ? [parsed.id] : parsed.stacks.map((stack) => stack.id);
	return Object.freeze({ destroyedIds: Object.freeze(ids) });
}

// ---------------------------------------------------------------------------
// stack logs

const logSource = z.enum(['history', 'live']);
const logStream = z.enum(['stdout', 'stderr']);
const logService = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const logRecordSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('log-entry'),
		timestamp: text(64),
		source: logSource,
		service: logService,
		instance_id: instanceId,
		stream: logStream,
		line: z.string(),
	}),
	z.object({
		type: z.literal('log-marker'),
		timestamp: text(64),
		source: logSource,
		service: logService,
		instance_id: instanceId,
		kind: z.enum(['launch', 'lost']),
		stream: logStream.optional(),
		count: z.number().int().nonnegative().optional(),
	}),
]);
const logsSchema = z.array(logRecordSchema).max(5_000);
const LOG_LINE_MAX_CHARS = 2_000;
const DEFAULT_LOG_CHARACTERS = 64 * 1024;

type SupabaseLogRecord =
	| Readonly<{
			type: 'entry';
			timestamp: string;
			source: 'history' | 'live';
			service: string;
			instanceId: string;
			stream: 'stdout' | 'stderr';
			/** Control-stripped, redacted, bounded. */
			line: string;
	  }>
	| Readonly<{
			type: 'marker';
			timestamp: string;
			source: 'history' | 'live';
			service: string;
			instanceId: string;
			/** `launch` starts an instance's output; `lost` marks dropped chunks. */
			kind: 'launch' | 'lost';
			stream: 'stdout' | 'stderr' | undefined;
			count: number | undefined;
	  }>;

export type SupabaseStackLogs = Readonly<{
	records: readonly SupabaseLogRecord[];
	/** Older records were dropped to fit the character budget. */
	truncated: boolean;
}>;

/**
 * Projects `stack logs` history. Service output is not redacted upstream
 * (PostgREST logs query strings, the database echoes statements), so every
 * line is sanitized here, and the newest records are kept within the budget.
 */
export function parseSupabaseStackLogs(
	json: unknown,
	options: Readonly<{ maxCharacters?: number }> = {}
): SupabaseStackLogs {
	const parsed = projectWith(logsSchema, json, 'stack.logs');
	const budget = Math.max(256, options.maxCharacters ?? DEFAULT_LOG_CHARACTERS);
	const records: SupabaseLogRecord[] = [];
	let used = 0;
	let truncated = false;
	for (let index = parsed.length - 1; index >= 0; index -= 1) {
		const record = parsed[index];
		if (record === undefined) continue;
		if (record.type === 'log-marker') {
			records.push(
				Object.freeze({
					type: 'marker',
					timestamp: record.timestamp,
					source: record.source,
					service: record.service,
					instanceId: record.instance_id,
					kind: record.kind,
					stream: record.stream,
					count: record.count,
				})
			);
			continue;
		}
		const line = sanitizeSupabaseText(record.line, {
			maxChars: LOG_LINE_MAX_CHARS,
		});
		if (used + line.length > budget) {
			truncated = true;
			break;
		}
		used += line.length;
		records.push(
			Object.freeze({
				type: 'entry',
				timestamp: record.timestamp,
				source: record.source,
				service: record.service,
				instanceId: record.instance_id,
				stream: record.stream,
				line,
			})
		);
	}
	return Object.freeze({
		records: Object.freeze(records.reverse()),
		truncated,
	});
}

// ---------------------------------------------------------------------------
// stack prepare

const prepareSchema = z.object({
	id: hex64,
	capabilities: z
		.array(
			z.object({
				capability: serviceKindSchema,
				version: text(128).optional(),
				outcome: z.literal('prepared'),
			})
		)
		.max(32),
});

export type SupabaseStackPrepare = Readonly<{
	/** The stack the preparation registered or reused; stop it afterwards. */
	id: string;
	capabilities: readonly Readonly<{
		capability: SupabaseServiceKind;
		version: string | undefined;
	}>[];
}>;

export function parseSupabaseStackPrepare(json: unknown): SupabaseStackPrepare {
	const parsed = projectWith(prepareSchema, json, 'stack.prepare');
	return Object.freeze({
		id: parsed.id,
		capabilities: Object.freeze(
			parsed.capabilities.map((entry) =>
				Object.freeze({ capability: entry.capability, version: entry.version })
			)
		),
	});
}

// ---------------------------------------------------------------------------
// migrations

const migrationVersion = z.string().regex(/^[+-]?\d{0,32}$/);
const migrationListSchema = z.object({
	migrations: z
		.array(
			z.object({
				local: migrationVersion,
				remote: migrationVersion,
				time: text(64),
			})
		)
		.max(10_000),
});

type SupabaseMigrationRowStatus =
	| 'applied'
	| 'pending'
	| 'out-of-order'
	| 'missing-local';

export type SupabaseMigrationStatus = Readonly<{
	/**
	 * `missing-local`: the database has versions this checkout lacks (often a
	 * branch switch). `out-of-order`: local files older than the last applied
	 * version. Either one makes `migration up` refuse, as it does upstream.
	 */
	state: 'up-to-date' | 'pending' | 'out-of-order' | 'missing-local';
	rows: readonly Readonly<{
		version: string;
		time: string;
		status: SupabaseMigrationRowStatus;
	}>[];
	applied: number;
	pending: readonly string[];
	outOfOrder: readonly string[];
	missingLocal: readonly string[];
	/** Whether applying pending migrations would succeed without flags. */
	canApply: boolean;
}>;

function compareVersions(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Classifies `migration list` rows with the same two-pointer walk `migration
 * up` uses (findPendingMigrations in the CLI): lexical version order, remote
 * versions missing locally first, then local versions older than an applied
 * one, then pending versions after the last applied one.
 */
export function deriveSupabaseMigrationStatus(
	rows: readonly Readonly<{ local: string; remote: string; time: string }>[]
): SupabaseMigrationStatus {
	const remote = [
		...new Set(rows.map((row) => row.remote).filter(Boolean)),
	].sort(compareVersions);
	const local = [...new Set(rows.map((row) => row.local).filter(Boolean))].sort(
		compareVersions
	);
	const applied = new Set<string>();
	const missingLocal: string[] = [];
	const outOfOrder: string[] = [];
	let remoteIndex = 0;
	let localIndex = 0;
	while (remoteIndex < remote.length && localIndex < local.length) {
		const remoteVersion = remote[remoteIndex] ?? '';
		const localVersion = local[localIndex] ?? '';
		if (remoteVersion === localVersion) {
			applied.add(localVersion);
			remoteIndex += 1;
			localIndex += 1;
		} else if (remoteVersion < localVersion) {
			missingLocal.push(remoteVersion);
			remoteIndex += 1;
		} else {
			outOfOrder.push(localVersion);
			localIndex += 1;
		}
	}
	missingLocal.push(...remote.slice(remoteIndex));
	const pending = local.slice(localIndex);
	const outOfOrderSet = new Set(outOfOrder);
	const missingSet = new Set(missingLocal);
	const times = new Map<string, string>();
	for (const row of rows) {
		const version = row.local || row.remote;
		if (version && !times.has(version)) times.set(version, row.time);
	}
	const statusOf = (version: string): SupabaseMigrationRowStatus =>
		applied.has(version)
			? 'applied'
			: missingSet.has(version)
				? 'missing-local'
				: outOfOrderSet.has(version)
					? 'out-of-order'
					: 'pending';
	const versions = [...new Set([...remote, ...local])].sort(compareVersions);
	const state =
		missingLocal.length > 0
			? 'missing-local'
			: outOfOrder.length > 0
				? 'out-of-order'
				: pending.length > 0
					? 'pending'
					: 'up-to-date';
	return Object.freeze({
		state,
		rows: Object.freeze(
			versions.map((version) =>
				Object.freeze({
					version,
					time: times.get(version) ?? '',
					status: statusOf(version),
				})
			)
		),
		applied: applied.size,
		pending: Object.freeze(pending),
		outOfOrder: Object.freeze(outOfOrder),
		missingLocal: Object.freeze(missingLocal),
		canApply: state === 'pending',
	});
}

export type SupabaseMigrationList = Readonly<{
	rows: readonly Readonly<{ local: string; remote: string; time: string }>[];
	status: SupabaseMigrationStatus;
}>;

export function parseSupabaseMigrationList(
	json: unknown
): SupabaseMigrationList {
	const parsed = projectWith(migrationListSchema, json, 'migration.list');
	const rows = Object.freeze(
		parsed.migrations.map((row) =>
			Object.freeze({ local: row.local, remote: row.remote, time: row.time })
		)
	);
	return Object.freeze({ rows, status: deriveSupabaseMigrationStatus(rows) });
}

const migrationUpSchema = z.object({
	applied: z.array(text(4096)).max(10_000),
});

export type SupabaseMigrationUp = Readonly<{
	/** File names only; the absolute paths are not needed for display. */
	applied: readonly string[];
}>;

export function parseSupabaseMigrationUp(json: unknown): SupabaseMigrationUp {
	const parsed = projectWith(migrationUpSchema, json, 'migration.up');
	return Object.freeze({
		applied: Object.freeze(
			parsed.applied.map((file) =>
				sanitizeSupabaseText(path.basename(file), { maxChars: 256 })
			)
		),
	});
}

const dbResetSchema = z.object({
	target: z.enum(['local', 'remote']),
	version: text(64),
});

export type SupabaseDbReset = Readonly<{
	/** Always `local` for desktop calls; `remote` would mean a hosted reset ran. */
	target: 'local' | 'remote';
	/** The version reset to; empty for all migrations. */
	version: string;
}>;

export function parseSupabaseDbReset(json: unknown): SupabaseDbReset {
	const parsed = projectWith(dbResetSchema, json, 'db.reset');
	return Object.freeze({ target: parsed.target, version: parsed.version });
}

// ---------------------------------------------------------------------------
// inspect db

function statText(
	value: string | number | null | undefined
): string | undefined {
	if (value === null || value === undefined) return undefined;
	return sanitizeSupabaseText(String(value), { maxChars: 128 });
}

const dbStatsSchema = z.object({
	rows: z
		.array(
			z.object({
				database_size: statValue,
				total_index_size: statValue,
				total_table_size: statValue,
				total_toast_size: statValue,
				time_since_stats_reset: statValue,
				index_hit_rate: statValue,
				table_hit_rate: statValue,
				wal_size: statValue,
			})
		)
		.max(8),
});

/**
 * Sizes are pg_size_pretty text; hit rates are numeric text or N/A.
 */
export type SupabaseDbStats = Readonly<{
	databaseSize: string | undefined;
	totalIndexSize: string | undefined;
	totalTableSize: string | undefined;
	totalToastSize: string | undefined;
	timeSinceStatsReset: string | undefined;
	indexHitRate: string | undefined;
	tableHitRate: string | undefined;
	walSize: string | undefined;
}>;

/** Returns undefined when the report has no row. */
export function parseSupabaseInspectDbStats(
	json: unknown
): SupabaseDbStats | undefined {
	const row = projectWith(dbStatsSchema, json, 'inspect').rows[0];
	if (row === undefined) return undefined;
	return Object.freeze({
		databaseSize: statText(row.database_size),
		totalIndexSize: statText(row.total_index_size),
		totalTableSize: statText(row.total_table_size),
		totalToastSize: statText(row.total_toast_size),
		timeSinceStatsReset: statText(row.time_since_stats_reset),
		indexHitRate: statText(row.index_hit_rate),
		tableHitRate: statText(row.table_hit_rate),
		walSize: statText(row.wal_size),
	});
}

const tableStatsSchema = z.object({
	rows: z
		.array(
			z.object({
				name: text(1024),
				table_size: statValue,
				index_size: statValue,
				total_size: statValue,
				estimated_row_count: statValue,
				seq_scans: statValue,
			})
		)
		.max(5_000),
});

/**
 * One table, largest first; counts arrive as int8 text.
 */
export type SupabaseTableStats = Readonly<{
	name: string;
	tableSize: string | undefined;
	indexSize: string | undefined;
	totalSize: string | undefined;
	estimatedRowCount: string | undefined;
	seqScans: string | undefined;
}>;

export function parseSupabaseInspectTableStats(
	json: unknown
): readonly SupabaseTableStats[] {
	const parsed = projectWith(tableStatsSchema, json, 'inspect');
	return Object.freeze(
		parsed.rows.map((row) =>
			Object.freeze({
				name: sanitizeSupabaseText(row.name, { maxChars: 256 }),
				tableSize: statText(row.table_size),
				indexSize: statText(row.index_size),
				totalSize: statText(row.total_size),
				estimatedRowCount: statText(row.estimated_row_count),
				seqScans: statText(row.seq_scans),
			})
		)
	);
}

// ---------------------------------------------------------------------------
// seed buckets

const bucketNames = z.array(text(256)).max(1_000);
const seedBucketsSchema = z.object({
	buckets_created: bucketNames,
	buckets_updated: bucketNames,
	buckets_skipped: bucketNames,
	objects_uploaded: z.array(z.string()).max(100_000),
});

export type SupabaseSeedBuckets = Readonly<{
	bucketsCreated: readonly string[];
	bucketsUpdated: readonly string[];
	bucketsSkipped: readonly string[];
	objectsUploaded: number;
}>;

export function parseSupabaseSeedBuckets(json: unknown): SupabaseSeedBuckets {
	const parsed = projectWith(seedBucketsSchema, json, 'seed.buckets');
	const names = (values: readonly string[]) =>
		Object.freeze(
			values.map((value) => sanitizeSupabaseText(value, { maxChars: 128 }))
		);
	return Object.freeze({
		bucketsCreated: names(parsed.buckets_created),
		bucketsUpdated: names(parsed.buckets_updated),
		bucketsSkipped: names(parsed.buckets_skipped),
		objectsUploaded: parsed.objects_uploaded.length,
	});
}

// ---------------------------------------------------------------------------
// error envelope

const stackChangeSchema = z.object({
	service: text(64).optional(),
	path: text(256).optional(),
	key: text(256).optional(),
	saved: z.string().optional(),
	requested: z.string().optional(),
	editable: z.boolean().optional(),
});

const errorEnvelopeSchema = z.object({
	_tag: z.literal('Error'),
	error: z.object({
		code: z.string(),
		message: z.string(),
		detail: z.string().optional(),
		suggestion: z.string().optional(),
	}),
	// Machine context merges into the envelope root, never inside `error`.
	recreate_command: z.string().optional(),
	stack_changes: z.array(stackChangeSchema).max(64).optional(),
	destroyed_stacks: z
		.array(z.object({ id: hex64 }))
		.max(64)
		.optional(),
});

/**
 * One saved setting a start could not adopt.
 */
export type SupabaseStackChange = Readonly<{
	service: string | undefined;
	path: string | undefined;
	/** A config.toml key or env var, or wording such as `Postgres build`. */
	key: string | undefined;
	saved: string | undefined;
	requested: string | undefined;
	/** Whether reverting `key` keeps the stack; otherwise only recreate helps. */
	editable: boolean;
}>;

export type SupabaseErrorEnvelope = Readonly<{
	/** The thrown error's tag, such as ExperimentalStackStartError. */
	code: string;
	/** Sanitized and bounded; may span lines. */
	message: string;
	detail: string | undefined;
	suggestion: string | undefined;
	stackChanges: readonly SupabaseStackChange[];
	/** Whether the CLI suggested recreating; the command itself is dropped. */
	recreateSuggested: boolean;
	/** The stack id named by that suggestion. */
	recreateStackId: string | undefined;
	/** Stacks a partly failed batch destroy did remove. */
	destroyedStackIds: readonly string[];
}>;

const ERROR_TEXT_MAX_CHARS = 4096;

function errorText(value: string | undefined, maxChars = ERROR_TEXT_MAX_CHARS) {
	return value === undefined
		? undefined
		: sanitizeSupabaseText(value, { maxChars, keepNewlines: true });
}

/**
 * Projects a `{_tag: "Error"}` envelope, or returns undefined when the value
 * is not one. Never throws: failure output is classified, not trusted.
 */
export function parseSupabaseErrorEnvelope(
	json: unknown
): SupabaseErrorEnvelope | undefined {
	const parsed = errorEnvelopeSchema.safeParse(json);
	if (!parsed.success) return undefined;
	const { error } = parsed.data;
	const code = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.code)
		? error.code
		: 'UnknownError';
	const recreateStackId = /--stack-id ([0-9a-f]{64})\b/.exec(
		parsed.data.recreate_command ?? ''
	)?.[1];
	return Object.freeze({
		code,
		message: errorText(error.message) ?? '',
		detail: errorText(error.detail),
		suggestion: errorText(error.suggestion, 1024),
		stackChanges: Object.freeze(
			(parsed.data.stack_changes ?? []).map((change) =>
				Object.freeze({
					service: errorText(change.service, 64),
					path: errorText(change.path, 256),
					key: errorText(change.key, 256),
					saved: errorText(change.saved, 256),
					requested: errorText(change.requested, 256),
					editable: change.editable === true,
				})
			)
		),
		recreateSuggested: parsed.data.recreate_command !== undefined,
		recreateStackId,
		destroyedStackIds: Object.freeze(
			(parsed.data.destroyed_stacks ?? []).map((stack) => stack.id)
		),
	});
}

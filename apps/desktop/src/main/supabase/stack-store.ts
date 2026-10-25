import path from 'node:path';
import { z } from 'zod';
import {
	type DeviceHolder,
	isPathInside,
	isSyntheticHolder,
} from '../../shared/device-hold';
import {
	SUPABASE_EXCLUDABLE_CAPABILITIES,
	type SupabaseActivityEntry,
	sanitizeSupabaseDisplayText,
	supabaseErrorSchema,
	supabaseRepositoryIdSchema,
	supabaseRequestIdSchema,
	supabaseStackIdSchema,
	supabaseStateSchema,
} from '../../shared/supabase-protocol';
import { sanitizeSupabaseText } from './cli-redact';
import { hasSupabaseControlCharacters } from './engine-support';
import {
	ensureSupabaseStoreDirectory,
	loadSupabaseStoreFile,
	SupabaseStoreQueue,
	writeSupabaseStoreFile,
} from './policy-store';

/**
 * `<root>/stacks.json`: what the desktop knows about each stack beyond what
 * `stack list` reports. Who created it and how, the session and worktree
 * holds agents took, the operator pin, the release time the auto-stop linger
 * counts from, abandonment clocks that must survive a desktop restart, the
 * exclusions it was last started with, flags such as an interrupted first
 * start, agent requests waiting for the user, and a ring of recent outcomes
 * for local stats. Strict v1, at most 128 records, no secrets and no keys
 * (older files may still hold sha256 fingerprints of the public ones). Lane
 * holds are not stored; they are derived from the lanes themselves.
 */

const STACKS_FILE = 'stacks.json';
const MAX_STACKS_BYTES = 2 * 1024 * 1024;
/** At most this many stacks are remembered; the state lists as many. */
export const SUPABASE_MAX_STACK_RECORDS = 128;
const MAX_REQUESTS = 32;
/** The activity ring kept for local stats and doctor. */
export const SUPABASE_MAX_ACTIVITY = 200;
const MAX_HOLDS = 16;
const MAX_CLOCKS = 32;
const MAX_APP_PATHS = 16;
/** Simulators remembered per stack, for the carried-over session warning. */
export const SUPABASE_MAX_SERVED_SIMULATORS = 8;
const MAX_PATH_LENGTH = 1_024;
const MAX_NOTE_LENGTH = 240;
/** Raw agent notes are cut before redaction, so the scan stays bounded. */
const MAX_RAW_NOTE_LENGTH = 960;
/** Settled requests stay visible this long, then drop out. */
const SETTLED_REQUEST_RETENTION_MS = 24 * 60 * 60 * 1_000;

const timestampSchema = z.number().int().nonnegative();
const identifierSchema = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const agentKindSchema = z.enum(['claude', 'codex', 'other']);
const laneIdSchema = z
	.string()
	.regex(/^lane-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);

const plainText = (max: number, min = 0) =>
	z
		.string()
		.min(min)
		.max(max)
		.refine((value) => !hasSupabaseControlCharacters(value), {
			message: 'Text must not contain control characters.',
		});

/** A normalized absolute path; binaries and roots are realpaths. */
const absolutePathSchema = z
	.string()
	.min(2)
	.max(MAX_PATH_LENGTH)
	.refine(
		(value) =>
			path.isAbsolute(value) &&
			path.normalize(value) === value &&
			!hasSupabaseControlCharacters(value),
		{ message: 'Paths must be normalized absolute paths.' }
	);
/** `refs/heads/<branch>`, another full ref, `detached`, or `ordinary-workspace`. */
const branchContextSchema = plainText(1_024, 1).refine(
	(value) =>
		value.startsWith('refs/') ||
		value === 'detached' ||
		value === 'ordinary-workspace',
	{ message: 'Branch contexts are full refs, detached, or ordinary-workspace.' }
);
const versionSchema = z
	.string()
	.regex(
		/^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,64})?(?:\+[0-9A-Za-z.-]{1,64})?$/
	);
const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);
const simulatorUdidSchema = z
	.string()
	.regex(/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/);
const capabilityListSchema = z
	.array(z.enum(SUPABASE_EXCLUDABLE_CAPABILITIES))
	.max(SUPABASE_EXCLUDABLE_CAPABILITIES.length)
	.refine((values) => new Set(values).size === values.length, {
		message: 'Capabilities must be distinct.',
	});
const agentSchema = z.strictObject({
	kind: agentKindSchema,
	sessionId: identifierSchema,
});

/**
 * An agent's hold: `session` from an attributed `supabase up`, `worktree`
 * for a synthetic `mcp-*` caller that is live while a session of its kind
 * works inside the worktree.
 */
const storedHoldSchema = z.strictObject({
	holder: z.enum(['session', 'worktree']),
	agent: agentSchema.extend({ synthetic: z.boolean() }),
	since: timestampSchema,
});
export type SupabaseStoredHold = z.infer<typeof storedHoldSchema>;

/**
 * An abandonment clock: running since `missingSince`, or paused (its agent
 * kind can't be seen) after running `pausedElapsedMs`.
 */
const clockSchema = z.union([
	z.strictObject({ missingSince: timestampSchema }),
	z.strictObject({ pausedElapsedMs: z.number().int().nonnegative() }),
]);
export type SupabaseHolderClock = z.infer<typeof clockSchema>;

/** `holderClockKey` output: `kind:session`, plus `@<dir>` for synthetic ones. */
const clockKeySchema = z
	.string()
	.max(1_200)
	.regex(/^(?:claude|codex|other):[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?:@\/.*)?$/)
	.refine((value) => !hasSupabaseControlCharacters(value));

const createdBySchema = z.strictObject({
	via: z.enum(['desktop', 'agent', 'external']),
	agent: agentSchema.optional(),
	/** The lane whose `lane up` created it. */
	laneId: laneIdSchema.optional(),
	/** Created by Pre-download services (prepare, then stop). */
	prepare: z.literal(true).optional(),
});

const recordFlagsSchema = z.strictObject({
	/** A first start stopped midway; it can't be resumed. */
	interrupted: z.literal(true).optional(),
	/** The first start failed and left an empty, registered stack. */
	failedStart: z.literal(true).optional(),
	/** The saved stack cannot adopt the current configuration. */
	needsRecreate: z.literal(true).optional(),
	/** Registered by prepare and never started since. */
	prepared: z.literal(true).optional(),
	/** A Docker or Podman stack on a managed identity was stopped once at this time. */
	containerStoppedAt: timestampSchema.optional(),
	/** Was: the stack a branch follow moved the holds to. No longer written. */
	supersededBy: supabaseStackIdSchema.optional(),
	/** When a branch follow moved this stack's holds to another stack. */
	supersededAt: timestampSchema.optional(),
});

const recordSchema = z.strictObject({
	id: supabaseStackIdSchema,
	origin: z.enum(['managed', 'adopted', 'external']),
	/** The CLI's stack name; the desktop only ever uses `default`. */
	name: plainText(128, 1),
	/** Realpath of the directory holding supabase/config.toml. */
	projectRoot: absolutePathSchema,
	/** The git checkout root, once known. */
	worktreePath: absolutePathSchema.optional(),
	/** App directories whose lanes use this stack (monorepos have several). */
	appPaths: z.array(absolutePathSchema).max(MAX_APP_PATHS),
	repositoryId: supabaseRepositoryIdSchema.optional(),
	branchContext: branchContextSchema,
	createdBy: createdBySchema,
	createdAt: timestampSchema,
	lastStartedAt: timestampSchema.optional(),
	lastStoppedAt: timestampSchema.optional(),
	lastUsedAt: timestampSchema.optional(),
	/** The CLI release that last started it. */
	cliVersion: versionSchema.optional(),
	/** Realpath of the validated binary that last started it. */
	binaryPath: absolutePathSchema.optional(),
	runtime: z.enum(['native', 'docker', 'podman', 'unknown']),
	/** The operator's hold: Keep running, or a start from the Supabase tab. */
	pinned: z.boolean(),
	pinnedAt: timestampSchema.optional(),
	holds: z.array(storedHoldSchema).max(MAX_HOLDS),
	/** When the last hold went away; the unheld stop linger counts from here. */
	releasedAt: timestampSchema.optional(),
	/**
	 * The session whose own release started that period: its cwd keeps
	 * nothing running until something holds the stack again.
	 */
	releasedBy: z
		.strictObject({
			holder: agentSchema,
			sessionCwd: absolutePathSchema.optional(),
		})
		.optional(),
	/** Abandonment clocks by holderClockKey, kept across desktop restarts. */
	clocks: z
		.record(clockKeySchema, clockSchema)
		.refine((clocks) => Object.keys(clocks).length <= MAX_CLOCKS, {
			message: `At most ${MAX_CLOCKS} clocks per stack.`,
		}),
	/** The exclusions it was last started with (a resume drops them otherwise). */
	exclusions: capabilityListSchema,
	/** The operator enabled Studio for this stack; the choice persists. */
	studioEnabled: z.boolean(),
	lastError: supabaseErrorSchema.optional(),
	/**
	 * The needs_recreate failure that set flags.needsRecreate: what the saved
	 * stack can't adopt. It goes when the flag does, so a later failure for
	 * another reason replaces lastError but not this.
	 */
	recreateError: supabaseErrorSchema.optional(),
	flags: recordFlagsSchema,
	/**
	 * Simulators a lane ran this stack's app on, newest first. An app keeps
	 * its signed-in session per host, so a Simulator that moves to another
	 * stack carries the session over.
	 */
	servedSimulators: z
		.array(z.strictObject({ udid: simulatorUdidSchema, at: timestampSchema }))
		.max(SUPABASE_MAX_SERVED_SIMULATORS)
		.optional(),
	/** Was: sha256 of the public keys. No longer written; older files parse. */
	keyFingerprints: z
		.strictObject({
			publishableKey: fingerprintSchema.optional(),
			anonKey: fingerprintSchema.optional(),
		})
		.optional(),
});
export type SupabaseStackRecord = z.infer<typeof recordSchema>;

const requestSchema = z.strictObject({
	id: supabaseRequestIdSchema,
	kind: z.enum(['destroy', 'reset', 'start-capacity']),
	status: z.enum([
		'pending',
		'settling',
		'approved',
		'denied',
		'expired',
		'failed',
	]),
	requester: agentSchema.extend({ synthetic: z.boolean() }),
	/** Destroy and reset name a stack; a parked start may not have one yet. */
	stackId: supabaseStackIdSchema.optional(),
	/** Where a parked start runs (main only). */
	worktreePath: absolutePathSchema.optional(),
	/** The branch label shown on the card. */
	branch: plainText(256, 1),
	sizeBytes: z.number().int().nonnegative().optional(),
	seed: z.boolean().optional(),
	/** The agent's note, redacted and sanitized; shown on the card only. */
	note: plainText(MAX_NOTE_LENGTH).optional(),
	createdAt: timestampSchema,
	expiresAt: timestampSchema,
	settledAt: timestampSchema.optional(),
	error: supabaseErrorSchema.optional(),
});
export type SupabaseRequestRecord = z.infer<typeof requestSchema>;

const activityEntrySchema = supabaseStateSchema.shape.activity.element;

const storedStacksSchema = z
	.strictObject({
		version: z.literal(1),
		records: z.array(recordSchema).max(SUPABASE_MAX_STACK_RECORDS),
		requests: z.array(requestSchema).max(MAX_REQUESTS),
		activity: z.array(activityEntrySchema).max(SUPABASE_MAX_ACTIVITY),
	})
	.superRefine((data, context) => {
		const ids = data.records.map((record) => record.id);
		if (new Set(ids).size !== ids.length) {
			context.addIssue({
				code: 'custom',
				path: ['records'],
				message: 'Every stack id must be unique.',
			});
		}
		const requestIds = data.requests.map((request) => request.id);
		if (new Set(requestIds).size !== requestIds.length) {
			context.addIssue({
				code: 'custom',
				path: ['requests'],
				message: 'Every request id must be unique.',
			});
		}
	});
type StoredStacks = z.infer<typeof storedStacksSchema>;

function emptyStacks(): StoredStacks {
	return { version: 1, records: [], requests: [], activity: [] };
}

function parseStoredStacks(value: unknown): StoredStacks | undefined {
	const parsed = storedStacksSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

/**
 * An agent's free-text note, made safe to store and show: credentials
 * redacted, controls and bidirectional overrides removed, at most 240
 * characters. Empty notes become undefined.
 */
export function sanitizeSupabaseRequestNote(
	note: string | undefined
): string | undefined {
	if (note === undefined) return undefined;
	const redacted = redactSupabaseStoredText(
		note.slice(0, MAX_RAW_NOTE_LENGTH),
		MAX_RAW_NOTE_LENGTH
	);
	const safe = sanitizeSupabaseDisplayText(redacted, MAX_NOTE_LENGTH);
	return safe.length > 0 ? safe : undefined;
}

// `scheme://user:password@` or `scheme://user@`: the whole userinfo goes.
const URL_USERINFO = /([a-z][a-z\d+.-]*:\/\/)[^\s/?#@'"`<>]*@/gi;

/**
 * Text bound for a store, the state or a job line: the CLI redactor, then
 * any URL userinfo dropped entirely (the redactor keeps the user name),
 * then bounded.
 */
export function redactSupabaseStoredText(
	value: string,
	maxChars: number,
	options: Readonly<{ keepNewlines?: boolean }> = {}
): string {
	const redacted = sanitizeSupabaseText(value, {
		maxChars: maxChars * 2,
		keepNewlines: options.keepNewlines === true,
	}).replace(URL_USERINFO, '$1…@');
	return sanitizeSupabaseText(redacted, {
		maxChars,
		keepNewlines: options.keepNewlines === true,
	});
}

type StoredErrorView = NonNullable<SupabaseStackRecord['lastError']>;

/** An error view with its free text redacted again, bounds kept. */
export function redactSupabaseErrorView(
	error: StoredErrorView
): StoredErrorView {
	const redact = (value: string, maxChars: number) =>
		redactSupabaseStoredText(value, maxChars, { keepNewlines: true });
	const suggestion = error.details.upstreamSuggestion;
	return {
		...error,
		title: redactSupabaseStoredText(error.title, 256),
		message: redact(error.message, 4_096),
		recovery: redact(error.recovery, 2_048),
		details: {
			...error.details,
			...(suggestion === undefined
				? {}
				: { upstreamSuggestion: redact(suggestion, 1_024) }),
		},
	};
}

/**
 * What a needs-recreate stack can't adopt: the failure behind its flag.
 * Records saved before `recreateError` existed have it only as lastError.
 */
export function supabaseRecreateError(
	record: SupabaseStackRecord
): StoredErrorView | undefined {
	if (!record.flags.needsRecreate) return undefined;
	return (
		record.recreateError ??
		(record.lastError?.code === 'needs_recreate' ? record.lastError : undefined)
	);
}

/** Whether a stored hold belongs to `holder` (and, for a synthetic one, that cwd). */
function holdBelongsTo(
	hold: SupabaseStoredHold,
	record: Pick<SupabaseStackRecord, 'worktreePath' | 'projectRoot'>,
	holder: DeviceHolder,
	sessionCwd: string | undefined
): boolean {
	if (
		hold.agent.kind !== holder.kind ||
		hold.agent.sessionId !== holder.sessionId
	) {
		return false;
	}
	// One synthetic id stands for every MCP session of its kind: release only
	// the worktree holds where the ending session worked.
	if (!isSyntheticHolder(holder) || sessionCwd === undefined) return true;
	const directory = record.worktreePath ?? record.projectRoot;
	return (
		isPathInside(sessionCwd, directory) || isPathInside(directory, sessionCwd)
	);
}

/** The record without its release period: something holds it again. */
function withoutRelease(record: SupabaseStackRecord): SupabaseStackRecord {
	const { releasedAt: _releasedAt, releasedBy: _releasedBy, ...rest } = record;
	return rest;
}

/** How readily a record is evicted, lowest first; pinned or held ones never are. */
function evictionRank(record: SupabaseStackRecord): number | undefined {
	if (record.pinned || record.holds.length > 0) return undefined;
	return record.origin === 'external' ? 0 : record.origin === 'adopted' ? 1 : 2;
}

function lastActivity(record: SupabaseStackRecord): number {
	return Math.max(
		record.createdAt,
		record.lastUsedAt ?? 0,
		record.lastStoppedAt ?? 0,
		record.lastStartedAt ?? 0
	);
}

/**
 * Adds or replaces a record in a draft. Past the bound the least recently
 * active unpinned, unheld record goes, external ones first.
 */
function upsertInto(draft: StoredStacks, record: SupabaseStackRecord): void {
	const index = draft.records.findIndex(
		(candidate) => candidate.id === record.id
	);
	if (index !== -1) {
		draft.records[index] = record;
		return;
	}
	if (draft.records.length >= SUPABASE_MAX_STACK_RECORDS) {
		const evictable = draft.records
			.map((candidate) => ({ candidate, rank: evictionRank(candidate) }))
			.filter(
				(entry): entry is { candidate: SupabaseStackRecord; rank: number } =>
					entry.rank !== undefined
			)
			.sort(
				(left, right) =>
					left.rank - right.rank ||
					lastActivity(left.candidate) - lastActivity(right.candidate)
			)[0];
		if (!evictable) {
			throw new RangeError(
				`At most ${SUPABASE_MAX_STACK_RECORDS} stacks can be tracked, and every one is pinned or held.`
			);
		}
		draft.records = draft.records.filter(
			(candidate) => candidate.id !== evictable.candidate.id
		);
	}
	draft.records.push(record);
}

export type SupabaseStackStoreHealth = 'ok' | 'quarantined';

/**
 * The stack records, agent requests and activity ring, persisted together.
 * Every change runs through one queue: the draft is validated, written
 * atomically, and only then becomes the store's memory.
 */
export class SupabaseStackStore {
	readonly #directory: string;
	readonly #file: string;
	readonly #now: () => number;
	readonly #log: (line: string) => void;
	readonly #queue = new SupabaseStoreQueue();
	readonly #listeners = new Set<() => void>();
	#data: StoredStacks = emptyStacks();
	#health: SupabaseStackStoreHealth = 'ok';

	constructor(
		options: Readonly<{
			/** The service root, `<userData>/supabase`. */
			directory: string;
			now?: () => number;
			log?: (line: string) => void;
		}>
	) {
		this.#directory = path.resolve(options.directory);
		this.#file = path.join(this.#directory, STACKS_FILE);
		this.#now = options.now ?? Date.now;
		this.#log = options.log ?? (() => undefined);
	}

	get file(): string {
		return this.#file;
	}

	get health(): SupabaseStackStoreHealth {
		return this.#health;
	}

	/** Reads stacks.json; a bad file is quarantined and the store starts empty. */
	async load(): Promise<SupabaseStackStoreHealth> {
		return this.#queue.run(async () => {
			await ensureSupabaseStoreDirectory(this.#directory);
			const loaded = await loadSupabaseStoreFile(this.#file, {
				maxBytes: MAX_STACKS_BYTES,
				parse: parseStoredStacks,
				now: this.#now(),
			});
			if (loaded.status === 'ok') {
				this.#data = loaded.data;
				this.#health = 'ok';
			} else {
				this.#data = emptyStacks();
				this.#health = loaded.status === 'missing' ? 'ok' : 'quarantined';
				if (loaded.status === 'quarantined') {
					this.#log(
						`Supabase stack records were unreadable (${loaded.reason}) and were set aside.`
					);
				}
			}
			this.#notify();
			return this.#health;
		});
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	records(): readonly SupabaseStackRecord[] {
		return structuredClone(this.#data.records);
	}

	record(stackId: string): SupabaseStackRecord | undefined {
		const record = this.#data.records.find(
			(candidate) => candidate.id === stackId
		);
		return record ? structuredClone(record) : undefined;
	}

	requests(): readonly SupabaseRequestRecord[] {
		return structuredClone(this.#data.requests);
	}

	request(requestId: string): SupabaseRequestRecord | undefined {
		const request = this.#data.requests.find(
			(candidate) => candidate.id === requestId
		);
		return request ? structuredClone(request) : undefined;
	}

	/** Newest first. */
	activity(): readonly SupabaseActivityEntry[] {
		return structuredClone(this.#data.activity);
	}

	/**
	 * Adds or replaces a record. Past the 128-record bound the least recently
	 * active unpinned, unheld record goes, external ones first; when every
	 * record is pinned or held, the add is refused.
	 */
	async upsertRecord(record: SupabaseStackRecord): Promise<void> {
		await this.upsertRecords([record]);
	}

	/** Adds or replaces several records in one write, in order. */
	async upsertRecords(records: readonly SupabaseStackRecord[]): Promise<void> {
		const validated = records.map((record) => recordSchema.parse(record));
		await this.#update((draft) => {
			for (const record of validated) upsertInto(draft, record);
		});
	}

	/**
	 * Changes one record: `mutate` edits the draft in place or returns its
	 * replacement. Returns the saved record, or undefined when no record has
	 * that id (nothing is written then).
	 */
	async updateRecord(
		stackId: string,
		mutate: (draft: SupabaseStackRecord) => SupabaseStackRecord | undefined
	): Promise<SupabaseStackRecord | undefined> {
		let saved: SupabaseStackRecord | undefined;
		await this.#update((draft) => {
			const index = draft.records.findIndex(
				(candidate) => candidate.id === stackId
			);
			const record = draft.records[index];
			if (!record) return false;
			const next = mutate(record) ?? record;
			if (next.id !== stackId) {
				throw new TypeError('A record update cannot change the stack id.');
			}
			draft.records[index] = next;
			saved = next;
			return true;
		});
		return saved ? structuredClone(saved) : undefined;
	}

	/**
	 * Forgets destroyed stacks. Requests that named them stay until settled,
	 * so the agent can still read how its request ended.
	 */
	async removeRecords(stackIds: readonly string[]): Promise<number> {
		const ids = new Set(stackIds);
		let removed = 0;
		await this.#update((draft) => {
			const before = draft.records.length;
			draft.records = draft.records.filter((record) => !ids.has(record.id));
			removed = before - draft.records.length;
			return removed > 0;
		});
		return removed;
	}

	/**
	 * Adds a session or worktree hold, replacing the same holder's earlier
	 * one. The release linger is cleared because the stack is held again.
	 */
	async addHold(
		stackId: string,
		hold: SupabaseStoredHold
	): Promise<SupabaseStackRecord | undefined> {
		const validated = storedHoldSchema.parse(hold);
		return this.updateRecord(stackId, (record) => {
			const others = record.holds.filter(
				(candidate) =>
					!(
						candidate.holder === validated.holder &&
						candidate.agent.kind === validated.agent.kind &&
						candidate.agent.sessionId === validated.agent.sessionId
					)
			);
			if (others.length >= MAX_HOLDS) others.shift();
			return { ...withoutRelease(record), holds: [...others, validated] };
		});
	}

	/**
	 * Drops every hold `holder` has (only the ones where `sessionCwd` works,
	 * for a synthetic holder) and returns the stacks it released. Stacks left
	 * with no stored hold get `releasedAt` and `releasedBy`: the linger starts
	 * (holds.ts clears it again while a lane still holds the stack) and the
	 * releasing session's own cwd no longer keeps the stack running.
	 */
	async releaseHolder(
		holder: DeviceHolder,
		options: Readonly<{
			sessionCwd?: string;
			stackIds?: readonly string[];
		}> = {}
	): Promise<readonly string[]> {
		const now = this.#now();
		const released: string[] = [];
		const only = options.stackIds ? new Set(options.stackIds) : undefined;
		await this.#update((draft) => {
			for (const record of draft.records) {
				if (only && !only.has(record.id)) continue;
				const kept = record.holds.filter(
					(hold) => !holdBelongsTo(hold, record, holder, options.sessionCwd)
				);
				if (kept.length === record.holds.length) continue;
				record.holds = kept;
				if (kept.length === 0) {
					record.releasedAt = now;
					record.releasedBy = {
						holder: { kind: holder.kind, sessionId: holder.sessionId },
						...(options.sessionCwd === undefined
							? {}
							: { sessionCwd: options.sessionCwd }),
					};
				}
				released.push(record.id);
			}
			return released.length > 0;
		});
		return released;
	}

	/** Pins (an operator hold) or unpins a stack. */
	async setPinned(
		stackId: string,
		pinned: boolean
	): Promise<SupabaseStackRecord | undefined> {
		const now = this.#now();
		return this.updateRecord(stackId, (record) => {
			if (pinned) {
				return { ...withoutRelease(record), pinned: true, pinnedAt: now };
			}
			const { pinnedAt: _pinnedAt, ...rest } = record;
			return {
				...rest,
				pinned: false,
				...(record.holds.length === 0 ? { releasedAt: now } : {}),
			};
		});
	}

	/**
	 * Applies the release change holds.ts decided: `clear` ends the unheld
	 * period, `{at}` records when it began. Nothing is written for no change.
	 */
	async applyRelease(
		stackId: string,
		release: 'clear' | Readonly<{ at: number }> | undefined
	): Promise<SupabaseStackRecord | undefined> {
		if (release === undefined) return this.record(stackId);
		return this.updateRecord(stackId, (record) =>
			release === 'clear'
				? withoutRelease(record)
				: { ...record, releasedAt: release.at }
		);
	}

	/** Replaces a record's abandonment clocks (holds.ts computes them). */
	async setClocks(
		stackId: string,
		clocks: Readonly<Record<string, SupabaseHolderClock>>
	): Promise<SupabaseStackRecord | undefined> {
		return this.updateRecord(stackId, (record) => {
			record.clocks = { ...clocks };
		});
	}

	/** Stores a new agent request; the note is redacted and bounded first. */
	async putRequest(request: SupabaseRequestRecord): Promise<void> {
		const { note, ...rest } = request;
		const safeNote = sanitizeSupabaseRequestNote(note);
		const validated = requestSchema.parse({
			...rest,
			...(safeNote === undefined ? {} : { note: safeNote }),
		});
		await this.#update((draft) => {
			const others = draft.requests.filter(
				(candidate) => candidate.id !== validated.id
			);
			draft.requests = [...others, validated];
			this.#boundRequests(draft);
		});
	}

	async updateRequest(
		requestId: string,
		mutate: (draft: SupabaseRequestRecord) => void
	): Promise<SupabaseRequestRecord | undefined> {
		let saved: SupabaseRequestRecord | undefined;
		await this.#update((draft) => {
			const request = draft.requests.find(
				(candidate) => candidate.id === requestId
			);
			if (!request) return false;
			mutate(request);
			saved = request;
			return true;
		});
		return saved ? structuredClone(saved) : undefined;
	}

	/**
	 * Marks pending requests past their expiry as expired and drops settled
	 * ones older than a day. Returns how many changed.
	 */
	async expireRequests(): Promise<number> {
		const now = this.#now();
		let changed = 0;
		await this.#update((draft) => {
			for (const request of draft.requests) {
				if (
					(request.status === 'pending' || request.status === 'settling') &&
					request.expiresAt <= now
				) {
					request.status = 'expired';
					request.settledAt = now;
					changed += 1;
				}
			}
			const before = draft.requests.length;
			draft.requests = draft.requests.filter(
				(request) =>
					request.settledAt === undefined ||
					now - request.settledAt < SETTLED_REQUEST_RETENTION_MS
			);
			changed += before - draft.requests.length;
			return changed > 0;
		});
		return changed;
	}

	/** Prepends an outcome to the activity ring (newest first, at most 200). */
	async recordActivity(entry: SupabaseActivityEntry): Promise<void> {
		const validated = activityEntrySchema.parse(entry);
		await this.#update((draft) => {
			draft.activity = [
				validated,
				...draft.activity.filter((candidate) => candidate.id !== validated.id),
			].slice(0, SUPABASE_MAX_ACTIVITY);
		});
	}

	/** Keeps at most 32 requests, dropping the oldest settled ones first. */
	#boundRequests(draft: StoredStacks): void {
		while (draft.requests.length > MAX_REQUESTS) {
			const settled = draft.requests
				.filter((request) => request.settledAt !== undefined)
				.sort((left, right) => left.createdAt - right.createdAt)[0];
			const oldest =
				settled ??
				[...draft.requests].sort(
					(left, right) => left.createdAt - right.createdAt
				)[0];
			if (!oldest) break;
			draft.requests = draft.requests.filter(
				(request) => request.id !== oldest.id
			);
		}
	}

	async #update(
		mutate: (draft: StoredStacks) => boolean | undefined
	): Promise<void> {
		await this.#queue.run(async () => {
			const draft = structuredClone(this.#data);
			if (mutate(draft) === false) return;
			// Error views arrive redacted; redact again so nothing a caller
			// forgot can reach the file.
			for (const record of draft.records) {
				if (record.lastError)
					record.lastError = redactSupabaseErrorView(record.lastError);
				if (record.recreateError)
					record.recreateError = redactSupabaseErrorView(record.recreateError);
			}
			for (const request of draft.requests) {
				if (request.error)
					request.error = redactSupabaseErrorView(request.error);
			}
			const validated = storedStacksSchema.parse(draft);
			await writeSupabaseStoreFile(
				this.#file,
				`${JSON.stringify(validated)}\n`,
				MAX_STACKS_BYTES
			);
			this.#data = validated;
			this.#health = 'ok';
			this.#notify();
		});
	}

	#notify(): void {
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch {
				// A listener's failure never undoes a saved record.
			}
		}
	}
}

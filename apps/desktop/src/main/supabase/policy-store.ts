import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
	chmod,
	lstat,
	mkdir,
	open,
	realpath,
	rename,
	unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
	applySupabasePolicyPatch,
	SUPABASE_POLICY_DEFAULTS,
	type SupabasePolicy,
	sanitizeSupabaseDisplayText,
	supabasePolicyPatchErrors,
	supabasePolicyPatchSchema,
	supabasePolicySchema,
	supabaseRepositoryIdSchema,
} from '../../shared/supabase-protocol';
import { readBoundedText } from './bounded-read';
import { hasSupabaseControlCharacters } from './engine-support';

/**
 * The Supabase policy (`<root>/policy-v1.json`), plus the durable-file
 * primitives the stack and job stores share: a private 0700 directory,
 * bounded reads that never follow a symlink, atomic 0600 writes (temp file in
 * the same directory, fsync, rename, directory fsync) and quarantine. Any
 * JSON or schema failure sets the file aside as `<name>.corrupt-<ts>` instead
 * of overwriting it, and a store's memory changes only after its write lands.
 */

// ---------------------------------------------------------------------------
// Durable files

/**
 * What one bounded read of a store file found.
 */
export type SupabaseStoreRead =
	| Readonly<{ status: 'missing' }>
	| Readonly<{ status: 'ok'; text: string }>
	| Readonly<{
			status: 'invalid';
			reason: 'not-a-file' | 'too-large' | 'unreadable';
	  }>;

function isMissing(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Creates the directory 0700 if needed and returns its realpath. */
export async function ensureSupabaseStoreDirectory(
	directory: string
): Promise<string> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const info = await lstat(directory);
	if (!info.isDirectory() || info.isSymbolicLink()) {
		throw new Error('Supabase state must live in a private local directory.');
	}
	await chmod(directory, 0o700);
	return realpath(directory);
}

/**
 * Reads a regular file of at most `maxBytes`. A symlink, a FIFO or an
 * oversized file is `invalid`, so the caller quarantines it instead of
 * trusting it.
 */
export async function readSupabaseStoreFile(
	file: string,
	maxBytes: number
): Promise<SupabaseStoreRead> {
	try {
		const info = await lstat(file);
		if (!info.isFile() || info.isSymbolicLink()) {
			return { status: 'invalid', reason: 'not-a-file' };
		}
		if (info.size > maxBytes) return { status: 'invalid', reason: 'too-large' };
	} catch (error) {
		return isMissing(error)
			? { status: 'missing' }
			: { status: 'invalid', reason: 'unreadable' };
	}
	const read = await readBoundedText(file, maxBytes, { noFollow: true });
	switch (read.status) {
		case 'ok':
		case 'missing':
			return read;
		case 'error':
			return { status: 'invalid', reason: 'unreadable' };
		default:
			return { status: 'invalid', reason: read.status };
	}
}

async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, constants.O_RDONLY);
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/**
 * Replaces `file` atomically: a 0600 temp file in the same directory, fsync,
 * rename over the target, then a directory fsync. A failure leaves the old
 * file in place. With `privateDirectory: false` (a folder main does not own,
 * such as a worktree's `supabase/`) the directory is used as it is: not
 * created, chmodded or fsynced.
 */
export async function writeSupabaseStoreFile(
	file: string,
	contents: string,
	maxBytes: number,
	options: Readonly<{ privateDirectory?: boolean }> = {}
): Promise<void> {
	if (Buffer.byteLength(contents, 'utf8') > maxBytes) {
		throw new RangeError(
			`${path.basename(file)} would exceed its ${maxBytes}-byte limit.`
		);
	}
	const privateDirectory = options.privateDirectory !== false;
	const directory = privateDirectory
		? await ensureSupabaseStoreDirectory(path.dirname(file))
		: path.dirname(file);
	const name = path.basename(file);
	const destination = path.join(directory, name);
	const temporary = path.join(
		directory,
		`.${name}.${process.pid}.${randomUUID()}.tmp`
	);
	const handle = await open(
		temporary,
		constants.O_CREAT |
			constants.O_EXCL |
			constants.O_WRONLY |
			(constants.O_NOFOLLOW ?? 0),
		0o600
	);
	try {
		await handle.writeFile(contents, 'utf8');
		await handle.sync();
	} catch (error) {
		await handle.close().catch(() => undefined);
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
	await handle.close();
	try {
		await rename(temporary, destination);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
	await chmod(destination, 0o600);
	if (privateDirectory) await syncDirectory(directory);
}

/**
 * Sets an unreadable file aside as `<file>.corrupt-<ts>` (never deleted, so
 * it can be inspected) and returns the new name, or undefined when the
 * rename failed.
 */
export async function quarantineSupabaseStoreFile(
	file: string,
	now: number
): Promise<string | undefined> {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const target = `${file}.corrupt-${now}${attempt === 0 ? '' : `-${attempt}`}`;
		try {
			await lstat(target);
			continue;
		} catch (error) {
			if (!isMissing(error)) return undefined;
		}
		try {
			await rename(file, target);
			return target;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/**
 * What loading one store file produced.
 */
export type SupabaseStoreLoad<T> =
	| Readonly<{ status: 'missing' }>
	| Readonly<{ status: 'ok'; data: T }>
	| Readonly<{
			status: 'quarantined';
			/** Where the bad file went; undefined when it could not be moved. */
			movedTo: string | undefined;
			reason: 'not-a-file' | 'too-large' | 'unreadable' | 'json' | 'schema';
	  }>;

/** Reads, JSON-parses and schema-checks a store file, quarantining failures. */
export async function loadSupabaseStoreFile<T>(
	file: string,
	options: Readonly<{
		maxBytes: number;
		parse: (value: unknown) => T | undefined;
		now: number;
	}>
): Promise<SupabaseStoreLoad<T>> {
	const read = await readSupabaseStoreFile(file, options.maxBytes);
	if (read.status === 'missing') return { status: 'missing' };
	let reason: 'not-a-file' | 'too-large' | 'unreadable' | 'json' | 'schema';
	if (read.status === 'invalid') {
		reason = read.reason;
	} else {
		let value: unknown;
		try {
			value = JSON.parse(read.text);
		} catch {
			value = undefined;
		}
		if (value === undefined) {
			reason = 'json';
		} else {
			const data = options.parse(value);
			if (data !== undefined) return { status: 'ok', data };
			reason = 'schema';
		}
	}
	const movedTo = await quarantineSupabaseStoreFile(file, options.now);
	return { status: 'quarantined', movedTo, reason };
}

/** Runs async tasks one at a time; a failed task never blocks the next. */
export class SupabaseStoreQueue {
	#tail: Promise<unknown> = Promise.resolve();

	run<T>(task: () => Promise<T>): Promise<T> {
		const next = this.#tail.catch(() => undefined).then(task);
		this.#tail = next.catch(() => undefined);
		return next;
	}
}

// ---------------------------------------------------------------------------
// Policy

const POLICY_FILE = 'policy-v1.json';
const MAX_POLICY_BYTES = 64 * 1024;
const MAX_PATH_LENGTH = 1_024;

const timestampSchema = z.number().int().nonnegative();

/** A normalized absolute path main chose through its own file dialog. */
const chosenPathSchema = z
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

/**
 * The stored policy: everything the renderer may change, minus what main
 * fixes (the abandonment grace, the app variable preset) and the path labels,
 * which are derived from the real paths kept beside it.
 */
const storedPolicySchema = supabasePolicySchema.omit({
	paths: true,
	abandonedGraceMs: true,
	appEnvPreset: true,
});
type StoredPolicy = z.infer<typeof storedPolicySchema>;

const policyFileSchema = z
	.strictObject({
		version: z.literal(1),
		enabled: z.boolean(),
		acknowledgedAt: timestampSchema.optional(),
		updatedAt: timestampSchema.optional(),
		policy: storedPolicySchema,
		paths: z.strictObject({
			supabaseHome: chosenPathSchema.optional(),
			sslCertFile: chosenPathSchema.optional(),
		}),
	})
	.superRefine((file, context) => {
		// The editable fields must pass the same rules a patch does (reserved
		// and secret-like app variable names, distinct entries), so a hand
		// edit cannot smuggle in what Settings would refuse.
		const { repositories, ...editable } = file.policy;
		const errors = supabasePolicyPatchErrors(editable);
		if (Object.keys(errors).length > 0) {
			context.addIssue({
				code: 'custom',
				path: ['policy'],
				message: 'The stored policy breaks a Settings rule.',
			});
		}
		const ids = repositories.map((entry) => entry.id);
		if (new Set(ids).size !== ids.length) {
			context.addIssue({
				code: 'custom',
				path: ['policy', 'repositories'],
				message: 'Each repository may have one mode.',
			});
		}
	});
type PolicyFile = z.infer<typeof policyFileSchema>;

/**
 * Main-only absolute paths; the renderer sees labels.
 */
type SupabasePolicyPaths = Readonly<{
	supabaseHome?: string;
	sslCertFile?: string;
}>;

export type SupabasePolicySnapshot = Readonly<{
	enabled: boolean;
	acknowledgedAt?: number;
	/** `quarantined` until the next successful save after a bad file. */
	health: 'ok' | 'quarantined';
	/** Where a quarantined file went (main only). */
	quarantinedTo?: string;
	/** The renderer projection, labels included. */
	policy: SupabasePolicy;
	paths: SupabasePolicyPaths;
}>;

export type SupabasePolicyUpdate =
	| Readonly<{ ok: true; snapshot: SupabasePolicySnapshot }>
	| Readonly<{ ok: false; errors: Readonly<Record<string, string>> }>;

function defaultStoredPolicy(): StoredPolicy {
	const {
		paths: _paths,
		abandonedGraceMs: _grace,
		appEnvPreset: _preset,
		...stored
	} = SUPABASE_POLICY_DEFAULTS;
	return structuredClone(stored);
}

function defaultFile(): PolicyFile {
	return {
		version: 1,
		enabled: false,
		policy: defaultStoredPolicy(),
		paths: {},
	};
}

function parsePolicyFile(value: unknown): PolicyFile | undefined {
	const parsed = policyFileSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

/**
 * `policy-v1.json`: whether local Supabase is on, the acknowledgement time,
 * the Settings policy and the chosen paths. A file that fails to read, parse
 * or validate is quarantined, the defaults are restored with the feature
 * off, and the snapshot reports `quarantined` until the next save.
 */
export class SupabasePolicyStore {
	readonly #directory: string;
	readonly #file: string;
	readonly #now: () => number;
	readonly #pathLabel: (absolutePath: string) => string;
	readonly #log: (line: string) => void;
	readonly #queue = new SupabaseStoreQueue();
	readonly #listeners = new Set<(snapshot: SupabasePolicySnapshot) => void>();
	#data: PolicyFile = defaultFile();
	#health: 'ok' | 'quarantined' = 'ok';
	#quarantinedTo: string | undefined;
	#snapshot: SupabasePolicySnapshot;

	constructor(
		options: Readonly<{
			/** The service root, `<userData>/supabase`. */
			directory: string;
			now?: () => number;
			/** Display label for a path, such as `~/.supabase`. */
			pathLabel?: (absolutePath: string) => string;
			log?: (line: string) => void;
		}>
	) {
		this.#directory = path.resolve(options.directory);
		this.#file = path.join(this.#directory, POLICY_FILE);
		this.#now = options.now ?? Date.now;
		this.#pathLabel = options.pathLabel ?? ((value) => value);
		this.#log = options.log ?? (() => undefined);
		this.#snapshot = this.#project();
	}

	get file(): string {
		return this.#file;
	}

	async load(): Promise<SupabasePolicySnapshot> {
		return this.#queue.run(async () => {
			await ensureSupabaseStoreDirectory(this.#directory);
			const loaded = await loadSupabaseStoreFile(this.#file, {
				maxBytes: MAX_POLICY_BYTES,
				parse: parsePolicyFile,
				now: this.#now(),
			});
			if (loaded.status === 'ok') {
				this.#data = loaded.data;
				this.#health = 'ok';
				this.#quarantinedTo = undefined;
			} else if (loaded.status === 'missing') {
				this.#data = defaultFile();
				this.#health = 'ok';
				this.#quarantinedTo = undefined;
			} else {
				// Defaults with the feature off; nothing is written until the next
				// save, so the set-aside file stays the only copy of the bad one.
				this.#data = defaultFile();
				this.#health = 'quarantined';
				this.#quarantinedTo = loaded.movedTo;
				this.#log(
					`Supabase policy was unreadable (${loaded.reason}); defaults restored and local Supabase turned off.`
				);
			}
			return this.#publish();
		});
	}

	/** A copy, so callers can never change the store's memory. */
	snapshot(): SupabasePolicySnapshot {
		return structuredClone(this.#snapshot);
	}

	subscribe(listener: (snapshot: SupabasePolicySnapshot) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/**
	 * Applies a renderer patch after the shared schema validates it. Field
	 * errors come back in the Settings copy and nothing is written.
	 */
	async updatePolicy(patch: unknown): Promise<SupabasePolicyUpdate> {
		const parsed = supabasePolicyPatchSchema.safeParse(patch);
		if (!parsed.success) {
			return { ok: false, errors: supabasePolicyPatchErrors(patch) };
		}
		const snapshot = await this.#update((draft) => {
			const next = applySupabasePolicyPatch(this.#project(draft).policy, {
				...parsed.data,
			});
			const {
				paths: _paths,
				abandonedGraceMs: _grace,
				appEnvPreset: _preset,
				...stored
			} = next;
			draft.policy = stored;
		});
		return { ok: true, snapshot };
	}

	/**
	 * Turns local Supabase on or off. Turning it on records when the operator
	 * acknowledged the trust model; turning it off keeps that time.
	 */
	async setEnabled(
		enabled: boolean,
		acknowledgedAt?: number
	): Promise<SupabasePolicySnapshot> {
		if (enabled && acknowledgedAt === undefined) {
			throw new TypeError(
				'Turning local Supabase on needs the acknowledgement time.'
			);
		}
		return this.#update((draft) => {
			draft.enabled = enabled;
			if (enabled && acknowledgedAt !== undefined) {
				draft.acknowledgedAt = timestampSchema.parse(acknowledgedAt);
			}
		});
	}

	/** Use local Supabase here: `off` is stored, `auto` is the default. */
	async setRepositoryMode(
		repositoryId: string,
		mode: 'auto' | 'off'
	): Promise<SupabasePolicySnapshot> {
		const id = supabaseRepositoryIdSchema.parse(repositoryId);
		return this.#update((draft) => {
			const others = draft.policy.repositories.filter(
				(entry) => entry.id !== id
			);
			draft.policy.repositories =
				mode === 'auto' ? others : [...others, { id, mode }];
		});
	}

	/**
	 * Records a path main chose through its own dialog, or restores the
	 * default with `undefined`. The caller resolves the realpath first.
	 */
	async setPath(
		field: 'supabase-home' | 'ssl-cert',
		absolutePath: string | undefined
	): Promise<SupabasePolicySnapshot> {
		const value =
			absolutePath === undefined
				? undefined
				: chosenPathSchema.parse(absolutePath);
		return this.#update((draft) => {
			const home = field === 'supabase-home' ? value : draft.paths.supabaseHome;
			const certificate =
				field === 'ssl-cert' ? value : draft.paths.sslCertFile;
			draft.paths = {
				...(home === undefined ? {} : { supabaseHome: home }),
				...(certificate === undefined ? {} : { sslCertFile: certificate }),
			};
		});
	}

	#update(
		mutate: (draft: PolicyFile) => void
	): Promise<SupabasePolicySnapshot> {
		return this.#queue.run(async () => {
			const draft = structuredClone(this.#data);
			mutate(draft);
			draft.updatedAt = this.#now();
			const validated = policyFileSchema.parse(draft);
			await writeSupabaseStoreFile(
				this.#file,
				`${JSON.stringify(validated, null, '\t')}\n`,
				MAX_POLICY_BYTES
			);
			this.#data = validated;
			this.#health = 'ok';
			this.#quarantinedTo = undefined;
			return this.#publish();
		});
	}

	#publish(): SupabasePolicySnapshot {
		this.#snapshot = this.#project();
		for (const listener of this.#listeners) {
			try {
				listener(structuredClone(this.#snapshot));
			} catch {
				// A listener's failure never undoes a saved policy.
			}
		}
		return structuredClone(this.#snapshot);
	}

	#label(value: string): string {
		const label = sanitizeSupabaseDisplayText(this.#pathLabel(value), 1_024);
		return label.length > 0 ? label : 'a chosen folder';
	}

	#project(data: PolicyFile = this.#data): SupabasePolicySnapshot {
		const home = data.paths.supabaseHome;
		const certificate = data.paths.sslCertFile;
		const policy = supabasePolicySchema.parse({
			...structuredClone(data.policy),
			abandonedGraceMs: SUPABASE_POLICY_DEFAULTS.abandonedGraceMs,
			appEnvPreset: SUPABASE_POLICY_DEFAULTS.appEnvPreset.map((entry) => ({
				...entry,
			})),
			paths: {
				supabaseHomeLabel:
					home === undefined
						? SUPABASE_POLICY_DEFAULTS.paths.supabaseHomeLabel
						: this.#label(home),
				customHome: home !== undefined,
				...(certificate === undefined
					? {}
					: { sslCertLabel: this.#label(certificate) }),
			},
		});
		return {
			enabled: data.enabled && this.#health === 'ok',
			...(data.acknowledgedAt === undefined
				? {}
				: { acknowledgedAt: data.acknowledgedAt }),
			health: this.#health,
			...(this.#quarantinedTo === undefined
				? {}
				: { quarantinedTo: this.#quarantinedTo }),
			policy,
			paths: {
				...(home === undefined ? {} : { supabaseHome: home }),
				...(certificate === undefined ? {} : { sslCertFile: certificate }),
			},
		};
	}
}

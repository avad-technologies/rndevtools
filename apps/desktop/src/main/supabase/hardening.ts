import { execFile } from 'node:child_process';
import {
	generateKeyPairSync,
	randomBytes as nodeRandomBytes,
	randomUUID,
} from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { SUPABASE_PORT_OVERRIDE_NAMES } from './cli-runner';
import { sha256Hex } from './engine-support';
import {
	ensureSupabaseStoreDirectory,
	loadSupabaseStoreFile,
	readSupabaseStoreFile,
	SupabaseStoreQueue,
	writeSupabaseStoreFile,
} from './policy-store';
import type { PinnedListener } from './project';

/**
 * Optional per-stack keys, pinned-port leases and eager service startup.
 *
 * Per-stack keys: the CLI's default keys are public constants every local
 * stack accepts, so a token minted for one stack works on all of them. With
 * per-stack keys on, each worktree gets its own JWT secret, ES256 signing
 * key, publishable key and secret key. The signing keys separate user
 * sessions; native anonymous endpoints remain accessible on loopback. The
 * set lives under `<root>/keys` (0600) and is written into the worktree's
 * `supabase/.env.local`, which every CLI command reads, so an agent's bare
 * restart keeps the keys. That file is written only after `git check-ignore`
 * confirms git ignores it, and re-read on each apply, which notices when
 * someone reverts it.
 *
 * Pinned-port leases: a repository that pins listener ports in its config
 * lets only one stack run at a time. With leases on, each worktree gets a
 * block of ports from 33000-39999 (outside the CLI's 10000-32767 automatic
 * and native ranges) passed as SUPABASE_*_PORT on the starts the desktop
 * runs. An agent's own start does not carry them and re-plans from the
 * pinned config, which is why this stays a compatibility mode.
 */

// ---------------------------------------------------------------------------
// Per-stack keys

const KEY_NAMES = [
	'SUPABASE_AUTH_JWT_SECRET',
	'SUPABASE_AUTH_PUBLISHABLE_KEY',
	'SUPABASE_AUTH_SECRET_KEY',
	'SUPABASE_AUTH_SIGNING_KEYS_PATH',
] as const;
type KeyName = (typeof KEY_NAMES)[number];

const BLOCK_START = '# RN Devtools per-stack keys: managed by RN Devtools.';
const BLOCK_END = '# End of RN Devtools per-stack keys.';
const MAX_ENV_FILE_BYTES = 256 * 1024;
const MAX_KEY_FILE_BYTES = 16 * 1024;
const GIT = '/usr/bin/git';
const GIT_TIMEOUT_MS = 5_000;

const signingKeySchema = z.strictObject({
	kty: z.literal('EC'),
	kid: z.string().min(1).max(64),
	use: z.literal('sig'),
	key_ops: z.tuple([z.literal('sign'), z.literal('verify')]),
	alg: z.literal('ES256'),
	ext: z.literal(true),
	d: z.string().min(16).max(128),
	crv: z.literal('P-256'),
	x: z.string().min(16).max(128),
	y: z.string().min(16).max(128),
});

const keyFileSchema = z.strictObject({
	version: z.literal(1),
	projectRoot: z.string().min(2).max(1_024),
	createdAt: z.number().int().nonnegative(),
	jwtSecret: z.string().min(32).max(256),
	publishableKey: z.string().regex(/^sb_publishable_[A-Za-z0-9_-]{24,128}$/),
	secretKey: z.string().regex(/^sb_secret_[A-Za-z0-9_-]{24,128}$/),
	signingKey: signingKeySchema,
});
type KeyFile = z.infer<typeof keyFileSchema>;

export type SupabaseStackKeys = Readonly<
	Pick<KeyFile, 'jwtSecret' | 'publishableKey' | 'secretKey' | 'signingKey'>
>;

function base64Url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64url');
}

/**
 * A fresh key set: a 43-character JWT secret, opaque publishable and secret
 * keys in the CLI's own shapes, and an ES256 signing key as the JWK the CLI's
 * `gen signing-key` writes.
 */
export function generateSupabaseStackKeys(
	random: (size: number) => Uint8Array = nodeRandomBytes
): SupabaseStackKeys {
	const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
	const jwk = privateKey.export({ format: 'jwk' });
	return {
		jwtSecret: base64Url(random(32)),
		publishableKey: `sb_publishable_${base64Url(random(24))}`,
		secretKey: `sb_secret_${base64Url(random(24))}`,
		signingKey: signingKeySchema.parse({
			kty: 'EC',
			kid: randomUUID(),
			use: 'sig',
			key_ops: ['sign', 'verify'],
			alg: 'ES256',
			ext: true,
			d: jwk.d,
			crv: 'P-256',
			x: jwk.x,
			y: jwk.y,
		}),
	};
}

/** Asks git whether a path in a worktree is ignored (and not tracked). */
export type SupabaseGitCheckIgnore = (
	worktreeRoot: string,
	relativeFile: string
) => Promise<boolean>;

/**
 * `git -C <worktree> check-ignore -q -- <file>` with a fixed binary and a
 * pinned PATH. Exit 0 means ignored; anything else (not ignored, tracked,
 * not a repository, git missing) counts as not ignored, which keeps the
 * file unwritten.
 */
export const nodeGitCheckIgnore: SupabaseGitCheckIgnore = (
	worktreeRoot,
	relativeFile
) =>
	new Promise((resolve) => {
		if (
			!path.isAbsolute(worktreeRoot) ||
			path.isAbsolute(relativeFile) ||
			relativeFile.startsWith('..')
		) {
			resolve(false);
			return;
		}
		execFile(
			GIT,
			['-C', worktreeRoot, 'check-ignore', '-q', '--', relativeFile],
			{
				timeout: GIT_TIMEOUT_MS,
				env: {
					PATH: '/usr/bin:/bin',
					...(process.env.HOME ? { HOME: process.env.HOME } : {}),
					GIT_OPTIONAL_LOCKS: '0',
					GIT_TERMINAL_PROMPT: '0',
				},
				windowsHide: true,
			},
			(error) => resolve(error === null)
		);
	});

export type SupabaseKeysApplied =
	| 'written'
	| 'unchanged'
	| 'not-ignored'
	| 'failed';

function envLine(name: KeyName, value: string): string {
	// Values are base64url text or an absolute path; quote the path.
	return name === 'SUPABASE_AUTH_SIGNING_KEYS_PATH'
		? `${name}="${value.replaceAll('"', '\\"')}"`
		: `${name}=${value}`;
}

/** Strips our block and any other assignment of the managed names. */
function withoutManagedLines(text: string): string[] {
	const lines = text.split('\n');
	const kept: string[] = [];
	let inBlock = false;
	for (const line of lines) {
		if (line.trim() === BLOCK_START) {
			inBlock = true;
			continue;
		}
		if (inBlock) {
			if (line.trim() === BLOCK_END) inBlock = false;
			continue;
		}
		const assigned = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/.exec(line)?.[1];
		if (assigned && (KEY_NAMES as readonly string[]).includes(assigned)) {
			continue;
		}
		kept.push(line);
	}
	while (kept.length > 0 && kept.at(-1)?.trim() === '') kept.pop();
	return kept;
}

/** The managed names' values in a dotenv text (last one wins). */
function managedValues(text: string): Partial<Record<KeyName, string>> {
	const values: Partial<Record<KeyName, string>> = {};
	for (const line of text.split('\n')) {
		const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
		const name = match?.[1];
		if (!name || !(KEY_NAMES as readonly string[]).includes(name)) continue;
		let value = (match?.[2] ?? '').trim();
		if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
			value = value.slice(1, -1).replaceAll('\\"', '"');
		}
		values[name as KeyName] = value;
	}
	return values;
}

/**
 * Writes the worktree's dotenv file atomically (0600, never through a
 * symlink). The folder is the worktree's, and no cap refuses what the read
 * let through.
 */
function writeWorktreeFile(file: string, contents: string): Promise<void> {
	return writeSupabaseStoreFile(file, contents, Number.POSITIVE_INFINITY, {
		privateDirectory: false,
	});
}

/**
 * The per-worktree key sets under `<root>/keys` and their copies in each
 * worktree's `supabase/.env.local`. Key material never leaves main: it is
 * read from the 0600 files here and written only into the ignored dotenv
 * file the CLI reads.
 */
export class SupabaseKeyStore {
	readonly #directory: string;
	readonly #now: () => number;
	readonly #random: (size: number) => Uint8Array;
	readonly #checkIgnore: SupabaseGitCheckIgnore;
	readonly #queue = new SupabaseStoreQueue();

	constructor(
		options: Readonly<{
			/** `<root>/keys`, created 0700. */
			directory: string;
			now?: () => number;
			random?: (size: number) => Uint8Array;
			checkIgnore?: SupabaseGitCheckIgnore;
		}>
	) {
		this.#directory = path.resolve(options.directory);
		this.#now = options.now ?? Date.now;
		this.#random = options.random ?? nodeRandomBytes;
		this.#checkIgnore = options.checkIgnore ?? nodeGitCheckIgnore;
	}

	#files(projectRoot: string): { keys: string; signing: string } {
		const name = sha256Hex(projectRoot).slice(0, 24);
		return {
			keys: path.join(this.#directory, `${name}.json`),
			signing: path.join(this.#directory, `${name}.signing.json`),
		};
	}

	/** The worktree's key set, created on first use. */
	keysFor(projectRoot: string): Promise<
		Readonly<{
			keys: SupabaseStackKeys;
			signingKeysPath: string;
		}>
	> {
		return this.#queue.run(async () => {
			await ensureSupabaseStoreDirectory(this.#directory);
			const files = this.#files(projectRoot);
			const loaded = await loadSupabaseStoreFile(files.keys, {
				maxBytes: MAX_KEY_FILE_BYTES,
				parse: (value) => {
					const parsed = keyFileSchema.safeParse(value);
					return parsed.success && parsed.data.projectRoot === projectRoot
						? parsed.data
						: undefined;
				},
				now: this.#now(),
			});
			let file: KeyFile;
			if (loaded.status === 'ok') {
				file = loaded.data;
			} else {
				file = {
					version: 1,
					projectRoot,
					createdAt: this.#now(),
					...generateSupabaseStackKeys(this.#random),
				};
				await writeSupabaseStoreFile(
					files.keys,
					`${JSON.stringify(file)}\n`,
					MAX_KEY_FILE_BYTES
				);
			}
			// The CLI reads the signing keys as a JSON array of JWKs.
			await writeSupabaseStoreFile(
				files.signing,
				`${JSON.stringify([file.signingKey])}\n`,
				MAX_KEY_FILE_BYTES
			);
			return {
				keys: {
					jwtSecret: file.jwtSecret,
					publishableKey: file.publishableKey,
					secretKey: file.secretKey,
					signingKey: file.signingKey,
				},
				signingKeysPath: files.signing,
			};
		});
	}

	#values(
		keys: SupabaseStackKeys,
		signingKeysPath: string
	): Record<KeyName, string> {
		return {
			SUPABASE_AUTH_JWT_SECRET: keys.jwtSecret,
			SUPABASE_AUTH_PUBLISHABLE_KEY: keys.publishableKey,
			SUPABASE_AUTH_SECRET_KEY: keys.secretKey,
			SUPABASE_AUTH_SIGNING_KEYS_PATH: signingKeysPath,
		};
	}

	/**
	 * Writes the key set into `<projectRoot>/supabase/.env.local` once git
	 * confirms that file is ignored. Other lines in the file are kept; the
	 * managed names live in one marked block.
	 */
	async applyToWorktree(
		input: Readonly<{ projectRoot: string; worktreeRoot: string }>
	): Promise<SupabaseKeysApplied> {
		const envFile = path.join(input.projectRoot, 'supabase', '.env.local');
		const relative = path.relative(input.worktreeRoot, envFile);
		if (relative.startsWith('..') || path.isAbsolute(relative)) {
			return 'failed';
		}
		if (!(await this.#checkIgnore(input.worktreeRoot, relative))) {
			return 'not-ignored';
		}
		try {
			const { keys, signingKeysPath } = await this.keysFor(input.projectRoot);
			const wanted = this.#values(keys, signingKeysPath);
			const current = await this.#readEnv(envFile);
			if (current === 'unsafe') return 'failed';
			const present = managedValues(current);
			if (KEY_NAMES.every((name) => present[name] === wanted[name])) {
				return 'unchanged';
			}
			const kept = withoutManagedLines(current);
			const block = [
				BLOCK_START,
				...KEY_NAMES.map((name) => envLine(name, wanted[name])),
				BLOCK_END,
			];
			await writeWorktreeFile(
				envFile,
				`${[...kept, ...(kept.length > 0 ? [''] : []), ...block].join('\n')}\n`
			);
			return 'written';
		} catch {
			return 'failed';
		}
	}

	/** Removes the managed block (and only it) from the worktree's file. */
	async removeFromWorktree(projectRoot: string): Promise<boolean> {
		const envFile = path.join(projectRoot, 'supabase', '.env.local');
		try {
			const current = await this.#readEnv(envFile);
			if (current === 'unsafe' || current === '') return false;
			if (!current.includes(BLOCK_START)) return false;
			const kept = withoutManagedLines(current);
			await writeWorktreeFile(
				envFile,
				kept.length > 0 ? `${kept.join('\n')}\n` : ''
			);
			return true;
		} catch {
			return false;
		}
	}

	/** The file's text, empty when missing, `unsafe` for a symlink or oversize file. */
	async #readEnv(file: string): Promise<string | 'unsafe'> {
		try {
			const info = await lstat(file);
			if (info.isSymbolicLink() || !info.isFile()) return 'unsafe';
		} catch {
			return '';
		}
		const read = await readSupabaseStoreFile(file, MAX_ENV_FILE_BYTES);
		if (read.status === 'missing') return '';
		return read.status === 'ok' ? read.text : 'unsafe';
	}
}

// ---------------------------------------------------------------------------
// Pinned-port leases

/** RN Devtools' own port range, clear of the CLI's 10000-32767. */
export const SUPABASE_PORT_LEASE_RANGE = Object.freeze([33_000, 39_999]);
const LEASE_BLOCK = 16;
const MAX_LEASES = 64;
const MAX_LEASE_FILE_BYTES = 64 * 1024;

/** The SUPABASE_*_PORT variable that overrides a pinned listener. */
export function supabasePortOverrideName(
	listener: Pick<PinnedListener, 'source' | 'key'>
): string | undefined {
	if (listener.source === 'dotenv') {
		// Only names the runner passes through; anything else stays pinned.
		return (SUPABASE_PORT_OVERRIDE_NAMES as readonly string[]).includes(
			listener.key
		)
			? listener.key
			: undefined;
	}
	const byKey: Readonly<Record<string, string>> = {
		'api.port': 'SUPABASE_API_PORT',
		'db.port': 'SUPABASE_DB_PORT',
		'db.shadow_port': 'SUPABASE_DB_SHADOW_PORT',
		'db.pooler.port': 'SUPABASE_DB_POOLER_PORT',
		'studio.port': 'SUPABASE_STUDIO_PORT',
		'inbucket.port': 'SUPABASE_LOCAL_SMTP_PORT',
		'local_smtp.port': 'SUPABASE_LOCAL_SMTP_PORT',
		'inbucket.smtp_port': 'SUPABASE_LOCAL_SMTP_SMTP_PORT',
		'local_smtp.smtp_port': 'SUPABASE_LOCAL_SMTP_SMTP_PORT',
		'inbucket.pop3_port': 'SUPABASE_LOCAL_SMTP_POP3_PORT',
		'local_smtp.pop3_port': 'SUPABASE_LOCAL_SMTP_POP3_PORT',
		'analytics.port': 'SUPABASE_ANALYTICS_PORT',
		'edge_runtime.inspector_port': 'SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT',
	};
	return byKey[listener.key];
}

const leaseFileSchema = z.strictObject({
	version: z.literal(1),
	leases: z
		.array(
			z.strictObject({
				key: z.string().min(2).max(1_024),
				base: z.number().int(),
				leasedAt: z.number().int().nonnegative(),
			})
		)
		.max(MAX_LEASES),
});
type LeaseFile = z.infer<typeof leaseFileSchema>;

/**
 * Port blocks leased per worktree (`<root>/port-leases-v1.json`, 0600). A
 * worktree keeps its block across starts so a resume finds the same ports.
 */
export class SupabasePortLeases {
	readonly #file: string;
	readonly #now: () => number;
	readonly #queue = new SupabaseStoreQueue();
	#data: LeaseFile | undefined;

	constructor(options: Readonly<{ file: string; now?: () => number }>) {
		this.#file = options.file;
		this.#now = options.now ?? Date.now;
	}

	/** SUPABASE_*_PORT values for the names, from the worktree's block. */
	overridesFor(
		key: string,
		names: readonly string[]
	): Promise<Readonly<Record<string, string>>> {
		return this.#queue.run(async () => {
			const unique = [...new Set(names)].sort().slice(0, LEASE_BLOCK);
			if (unique.length === 0) return {};
			const data = await this.#load();
			let lease = data.leases.find((entry) => entry.key === key);
			if (!lease) {
				const taken = new Set(data.leases.map((entry) => entry.base));
				const [low, high] = SUPABASE_PORT_LEASE_RANGE as [number, number];
				let base: number | undefined;
				for (let next = low; next + LEASE_BLOCK - 1 <= high; ) {
					if (!taken.has(next)) {
						base = next;
						break;
					}
					next += LEASE_BLOCK;
				}
				if (base === undefined) return {};
				lease = { key, base, leasedAt: this.#now() };
				const leases = [...data.leases, lease]
					.sort((left, right) => right.leasedAt - left.leasedAt)
					.slice(0, MAX_LEASES);
				const next: LeaseFile = { version: 1, leases };
				await writeSupabaseStoreFile(
					this.#file,
					`${JSON.stringify(next)}\n`,
					MAX_LEASE_FILE_BYTES
				);
				this.#data = next;
			}
			const base = lease.base;
			return Object.fromEntries(
				unique.map((name, index) => [name, String(base + index)])
			);
		});
	}

	async #load(): Promise<LeaseFile> {
		if (this.#data) return this.#data;
		const loaded = await loadSupabaseStoreFile(this.#file, {
			maxBytes: MAX_LEASE_FILE_BYTES,
			parse: (value) => {
				const parsed = leaseFileSchema.safeParse(value);
				return parsed.success ? parsed.data : undefined;
			},
			now: this.#now(),
		});
		this.#data =
			loaded.status === 'ok' ? loaded.data : { version: 1, leases: [] };
		return this.#data;
	}
}

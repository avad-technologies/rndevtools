import { lstat, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
	isSupabaseStackRunning,
	type SupabaseStackSummary,
} from '../../shared/supabase-protocol';
import { hasSupabaseControlCharacters } from './engine-support';
import { SupabaseStoreQueue, writeSupabaseStoreFile } from './policy-store';
import type { SupabaseWorktreeFacts } from './repositories';
import {
	type SteeringRoot,
	type SteeringSnapshot,
	supabaseSteeringFile,
} from './service-ports';

/**
 * steering.json v1 for the Go PreToolUse hook, in the agent socket's 0700
 * directory: whether local Supabase is on, and the managed worktree roots
 * with the branch each one's stack belongs to, whether that stack runs, and
 * the worktree's runner. The hook ignores the whole file on any deviation
 * (and trusts it for 3 minutes), so every root is validated here, the file
 * stays under 64 KiB, and it is rewritten on every change and at least
 * every 60 s. It is removed when the feature is turned off and kept across
 * quit, so agents keep their rules while the desktop restarts.
 */

const STEERING_FILE = 'steering.json';
const MAX_STEERING_BYTES = 64 * 1024;
const MAX_ROOTS = 256;
const MAX_PATH_BYTES = 1_024;
/** Rewrites an unchanged file this often, inside the hook's 60 s promise. */
const HEARTBEAT_MS = 45_000;
const PRINTABLE = /^[\x20-\x7e]{1,256}$/;

function validPath(value: string): boolean {
	return (
		path.isAbsolute(value) &&
		path.normalize(value) === value &&
		Buffer.byteLength(value, 'utf8') <= MAX_PATH_BYTES &&
		!hasSupabaseControlCharacters(value)
	);
}

function validRoot(root: SteeringRoot): boolean {
	return (
		validPath(root.root) &&
		validPath(root.projectRoot) &&
		root.branchContext.length >= 1 &&
		root.branchContext.length <= 1_024 &&
		!hasSupabaseControlCharacters(root.branchContext) &&
		PRINTABLE.test(root.runner)
	);
}

/**
 * The managed roots the hook steers: one per managed worktree with a
 * readable HEAD, keyed by the worktree's realpath. `stackReady` says the
 * stack for the worktree's current branch exists and runs.
 */
export function supabaseSteeringRoots(
	input: Readonly<{
		facts: readonly SupabaseWorktreeFacts[];
		stacks: readonly Pick<SupabaseStackSummary, 'id' | 'state'>[];
	}>
): SteeringRoot[] {
	const running = new Set(
		input.stacks.filter(isSupabaseStackRunning).map((stack) => stack.id)
	);
	const roots = new Map<string, SteeringRoot>();
	for (const facts of input.facts) {
		const detection = facts.detection;
		const head = facts.head;
		if (
			facts.mode.value !== 'managed' ||
			detection?.status !== 'found' ||
			head?.status !== 'ok' ||
			roots.has(facts.realWorktreePath)
		) {
			continue;
		}
		const root: SteeringRoot = {
			root: facts.realWorktreePath,
			projectRoot: detection.projectRoot,
			branchContext: head.branchContext,
			stackReady:
				facts.expectedStackId !== undefined &&
				running.has(facts.expectedStackId),
			runner: detection.runner
				? `${detection.runner.command} supabase`
				: 'supabase',
		};
		if (validRoot(root)) roots.set(root.root, root);
		if (roots.size >= MAX_ROOTS) break;
	}
	return [...roots.values()];
}

/** Writes and removes `<agent directory>/steering.json`. */
export class SupabaseSteeringWriter {
	readonly #file: string;
	readonly #now: () => number;
	readonly #log: (line: string) => void;
	readonly #queue = new SupabaseStoreQueue();
	#lastContent: string | undefined;
	#lastWrittenAt = 0;

	constructor(
		options: Readonly<{
			/** The agent socket's 0700 directory. */
			directory: string;
			now?: () => number;
			log?: (line: string) => void;
		}>
	) {
		this.#file = path.join(path.resolve(options.directory), STEERING_FILE);
		this.#now = options.now ?? Date.now;
		this.#log = options.log ?? (() => undefined);
	}

	get file(): string {
		return this.#file;
	}

	/**
	 * Writes the snapshot when it differs from the last one written, or when
	 * the last write is old enough that the hook's freshness check needs a
	 * new heartbeat. A disabled snapshot lists no roots.
	 */
	write(snapshot: SteeringSnapshot): Promise<boolean> {
		return this.#queue.run(async () => {
			let roots = [...snapshot.managedRoots]
				.filter(validRoot)
				.slice(0, MAX_ROOTS);
			let text = '';
			for (;;) {
				const file = supabaseSteeringFile({ ...snapshot, managedRoots: roots });
				const content = JSON.stringify({ ...file, writtenAt: 0 });
				text = `${JSON.stringify(file)}\n`;
				if (Buffer.byteLength(text, 'utf8') <= MAX_STEERING_BYTES) {
					if (
						content === this.#lastContent &&
						this.#now() - this.#lastWrittenAt < HEARTBEAT_MS
					) {
						return false;
					}
					this.#lastContent = content;
					break;
				}
				// Too many roots to fit: keep the first half and try again.
				roots = roots.slice(0, Math.floor(roots.length / 2));
			}
			try {
				await writeSupabaseStoreFile(this.#file, text, MAX_STEERING_BYTES);
				this.#lastWrittenAt = this.#now();
				return true;
			} catch (error) {
				this.#lastContent = undefined;
				this.#log(
					`Supabase steering could not be written: ${error instanceof Error ? error.name : 'error'}`
				);
				return false;
			}
		});
	}

	/** Removes the file (never following a symlink); missing is fine. */
	remove(): Promise<void> {
		return this.#queue.run(async () => {
			this.#lastContent = undefined;
			this.#lastWrittenAt = 0;
			try {
				await lstat(this.#file);
			} catch {
				return;
			}
			try {
				await unlink(this.#file);
			} catch (error) {
				this.#log(
					`Supabase steering could not be removed: ${error instanceof Error ? error.name : 'error'}`
				);
			}
		});
	}
}

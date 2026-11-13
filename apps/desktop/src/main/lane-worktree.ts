import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { laneSchemeSchema } from '../shared/lane-protocol';
import {
	runSimulatorCommand,
	SimulatorCommandError,
} from './simulator-command-runner';

const GIT_PATH = '/usr/bin/git';
const GIT_TIMEOUT_MS = 10_000;
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const MAX_CONFIG_BYTES = 512 * 1024;
/** `git status` runs one listing has going at once; each uses several threads. */
const MAX_PARALLEL_STATUS = 4;

export type DiscoveredWorktree = {
	path: string;
	branch: string;
	repositoryRoot: string;
};

export type WorktreeExpoIdentity = {
	scheme?: string;
	bundleIdentifier?: string;
};

export type WorktreeInspectorPort = {
	repositoryRoot: (
		worktreePath: string,
		signal?: AbortSignal
	) => Promise<string>;
	/**
	 * Checkout topology only, without running status in each worktree. A
	 * repository that is gone, deleted since it was recorded, lists none.
	 */
	listWorktrees: (
		repositoryRoot: string,
		signal?: AbortSignal
	) => Promise<DiscoveredWorktree[]>;
	readDirty: (
		worktreePaths: readonly string[],
		signal?: AbortSignal
	) => Promise<ReadonlyMap<string, boolean>>;
	readExpoIdentity: (worktreePath: string) => Promise<WorktreeExpoIdentity>;
};

type CommandRunner = typeof runSimulatorCommand;
type Git = (
	args: readonly string[],
	cwd: string,
	signal?: AbortSignal
) => Promise<string>;

/** Parses `git worktree list --porcelain` into one entry per checkout. */
export function parseWorktreeList(
	output: string,
	repositoryRoot: string
): DiscoveredWorktree[] {
	const entries: DiscoveredWorktree[] = [];
	let current: { path?: string; branch?: string; detached?: boolean } = {};
	const flush = () => {
		if (current.path) {
			entries.push({
				path: current.path,
				branch: current.detached
					? 'detached'
					: (current.branch ?? 'unknown').replace(/^refs\/heads\//, ''),
				repositoryRoot,
			});
		}
		current = {};
	};
	for (const line of output.split('\n')) {
		if (line === '') {
			flush();
			continue;
		}
		if (line.startsWith('worktree ')) current.path = line.slice(9).trim();
		else if (line.startsWith('branch ')) current.branch = line.slice(7).trim();
		else if (line === 'detached') current.detached = true;
	}
	flush();
	return entries;
}

/**
 * Whether a worktree has tracked changes. `--no-optional-locks` keeps the
 * status from taking the worktree's index.lock, which would make an agent's
 * commit there fail. A status too long to read is dirty; one that cannot run
 * reads as clean, since the flag is only shown.
 */
async function isWorktreeDirty(
	git: Git,
	worktreePath: string,
	signal?: AbortSignal
): Promise<boolean> {
	try {
		const output = await git(
			['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no'],
			worktreePath,
			signal
		);
		return output.trim().length > 0;
	} catch (error) {
		if (signal?.aborted) throw error;
		return (
			error instanceof SimulatorCommandError && error.kind === 'output-limit'
		);
	}
}

/**
 * Whether `directory` is gone, as a checkout deleted since it was recorded
 * is. A directory that is there but cannot be read is not.
 */
async function isGone(directory: string): Promise<boolean> {
	try {
		await stat(directory);
		return false;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === 'ENOENT' || code === 'ENOTDIR';
	}
}

/** `run` over `items`, at most `limit` at a time, results in order. */
async function mapLimited<T, R>(
	items: readonly T[],
	limit: number,
	run: (item: T) => Promise<R>
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			while (next < items.length) {
				const index = next;
				next += 1;
				const item = items[index] as T;
				results[index] = await run(item);
			}
		}
	);
	await Promise.all(workers);
	return results;
}

function stringAt(value: unknown, keys: readonly string[]): string | undefined {
	let cursor: unknown = value;
	for (const key of keys) {
		if (!cursor || typeof cursor !== 'object') return undefined;
		cursor = (cursor as Record<string, unknown>)[key];
	}
	return typeof cursor === 'string' && cursor.length <= 256
		? cursor
		: undefined;
}

/**
 * The scheme expo-dev-client registers for a slug (its `getDefaultScheme`):
 * every character a URI scheme cannot hold dropped, lowercased, `exp+` in
 * front. `my_app` becomes `exp+myapp`. A slug with nothing left gets none.
 */
function devClientDefaultScheme(slug: string): string | undefined {
	const scheme = slug.replace(/[^A-Za-z0-9+\-.]/g, '').toLowerCase();
	return scheme.length > 0 ? `exp+${scheme}` : undefined;
}

/**
 * Reads the URL scheme and iOS bundle identifier from the worktree's static
 * Expo config. Dynamic `app.config.js` files are not evaluated: running
 * arbitrary project code inside the desktop app is not worth a launch URL.
 * Callers fall back to a user-supplied scheme when the static file is absent.
 * The scheme is the first declared one a lane can hold, else the dev
 * client's default; one a lane record would refuse is never returned.
 */
export async function readExpoIdentity(
	worktreePath: string
): Promise<WorktreeExpoIdentity> {
	for (const file of ['app.json', 'app.config.json']) {
		try {
			const raw = await readFile(path.join(worktreePath, file), {
				encoding: 'utf8',
			});
			if (raw.length > MAX_CONFIG_BYTES) continue;
			const parsed: unknown = JSON.parse(raw);
			const expo =
				stringAt(parsed, ['expo', 'slug']) !== undefined
					? (parsed as { expo: unknown }).expo
					: parsed;
			const declared = (expo as { scheme?: unknown } | undefined)?.scheme;
			const slug = stringAt(expo, ['slug']);
			const resolvedScheme = [
				...(Array.isArray(declared) ? declared : [declared]),
				slug === undefined ? undefined : devClientDefaultScheme(slug),
			].find(
				(candidate): candidate is string =>
					laneSchemeSchema.safeParse(candidate).success
			);
			const bundleIdentifier = stringAt(expo, ['ios', 'bundleIdentifier']);
			return {
				...(resolvedScheme ? { scheme: resolvedScheme } : {}),
				...(bundleIdentifier ? { bundleIdentifier } : {}),
			};
		} catch {
			// Try the next file name.
		}
	}
	return {};
}

/** Reads checkout topology and display-only dirty flags separately. */
export function createWorktreeInspector({
	runCommand = runSimulatorCommand,
}: {
	runCommand?: CommandRunner;
} = {}): WorktreeInspectorPort {
	const git: Git = async (args, cwd, signal) =>
		(
			await runCommand(GIT_PATH, ['-C', cwd, ...args], {
				timeoutMs: GIT_TIMEOUT_MS,
				maxOutputBytes: MAX_GIT_OUTPUT_BYTES,
				...(signal ? { signal } : {}),
			})
		).stdout;

	return {
		/**
		 * The main checkout that owns a worktree. `git worktree list` run from
		 * any linked worktree reports the whole set with the main checkout
		 * first.
		 */
		repositoryRoot: async (worktreePath, signal) => {
			const output = await git(
				['worktree', 'list', '--porcelain'],
				worktreePath,
				signal
			);
			const first = output
				.split('\n')
				.find((line) => line.startsWith('worktree '));
			if (!first) {
				throw new Error(`${worktreePath} is not inside a git repository.`);
			}
			return first.slice('worktree '.length).trim();
		},
		listWorktrees: async (repositoryRoot, signal) => {
			let output: string;
			try {
				output = await git(
					['worktree', 'list', '--porcelain'],
					repositoryRoot,
					signal
				);
			} catch (error) {
				// git fails on a directory that is gone as it does on one that is
				// no repository. A repository deleted since it was recorded has no
				// worktrees left, which is no failure to report on every listing.
				if (!signal?.aborted && (await isGone(repositoryRoot))) return [];
				throw error;
			}
			return parseWorktreeList(output, repositoryRoot);
		},
		readDirty: async (worktreePaths, signal) =>
			new Map(
				await mapLimited(
					worktreePaths,
					MAX_PARALLEL_STATUS,
					async (worktreePath) => {
						signal?.throwIfAborted();
						return [
							worktreePath,
							await isWorktreeDirty(git, worktreePath, signal),
						] as const;
					}
				)
			),
		readExpoIdentity,
	};
}

export const worktreeInspector: WorktreeInspectorPort =
	createWorktreeInspector();

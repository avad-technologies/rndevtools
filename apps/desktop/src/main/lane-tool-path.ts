import {
	type ChildProcess,
	type SpawnOptions,
	spawn,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { inheritedChildEnvironment } from './agent-harness-env';

// Version-manager initialization can take several seconds on a busy Mac.
const LOGIN_SHELL_TIMEOUT_MS = 15_000;
const LOGIN_SHELL_RETRY_TIMEOUT_MS = 3_000;
const MAX_LOGIN_SHELL_OUTPUT_BYTES = 64 * 1024;
const MAX_TOOL_PATH_LENGTH = 16 * 1024;
/** Shells that take `-ilc` and print "$PATH" as one colon-separated value. */
const LOGIN_SHELLS = new Set(['bash', 'dash', 'fish', 'ksh', 'sh', 'zsh']);
const DEFAULT_LOGIN_SHELL = '/bin/zsh';

/**
 * The PATH a worktree's own tooling runs with, given the one the desktop
 * inherited. Metro's `node_modules/.bin/expo` starts with
 * `#!/usr/bin/env node`, and the native plan runs the project's Node, so both
 * need a PATH that finds Node.
 */
export type ToolPathResolver = (
	inheritedPath: string | undefined
) => Promise<string | undefined>;

type ShellSpawn = (
	command: string,
	args: readonly string[],
	options: SpawnOptions
) => ChildProcess;

/** The absolute entries of a PATH, each kept once, in order. */
function pathEntries(value: string | undefined): string[] {
	return [
		...new Set(
			(value ?? '')
				.split(path.delimiter)
				.filter((entry) => path.isAbsolute(entry) && !/[\0\r\n]/.test(entry))
		),
	];
}

function isExecutableFile(candidate: string): boolean {
	try {
		accessSync(candidate, constants.X_OK);
		return statSync(candidate).isFile();
	} catch {
		return false;
	}
}

/** A directory on PATH with an executable Node. Ignore relative entries. */
export function findNodeDirectory(
	searchPath: string | undefined
): string | undefined {
	return pathEntries(searchPath).find((directory) =>
		isExecutableFile(path.join(directory, 'node'))
	);
}

/** Find an executable Node pinned by the app or a parent workspace. */
export function projectNodeDirectory(projectRoot: string): string | undefined {
	let current = path.resolve(projectRoot);
	for (let depth = 0; depth < 6; depth += 1) {
		const directory = path.join(current, 'node_modules', '.bin');
		if (isExecutableFile(path.join(directory, 'node'))) return directory;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

export const NODE_LOOKUP_MESSAGE =
	'RN Devtools could not find Node.js. Confirm that node --version works in a new Terminal, then retry. If it works there, launch RN Devtools from that terminal.';

/** The user's shell when it is one that takes `-ilc`, else the macOS default. */
function loginShell(env: NodeJS.ProcessEnv): string | undefined {
	const shell = env.SHELL;
	if (
		shell &&
		path.isAbsolute(shell) &&
		LOGIN_SHELLS.has(path.basename(shell)) &&
		existsSync(shell)
	) {
		return shell;
	}
	return existsSync(DEFAULT_LOGIN_SHELL) ? DEFAULT_LOGIN_SHELL : undefined;
}

/** What `output` holds between the first two `marker`s, if both arrived. */
function betweenMarkers(output: string, marker: string): string | undefined {
	const start = output.indexOf(marker);
	if (start === -1) return undefined;
	const end = output.indexOf(marker, start + marker.length);
	return end === -1 ? undefined : output.slice(start + marker.length, end);
}

/**
 * Asks the user's login shell for its PATH, the way a terminal would set it
 * up: `$SHELL -ilc`, printing the value between two random markers so that
 * whatever the rc files print is ignored. Only PATH is taken from the shell.
 * The shell runs in its own process group with no stdin, and is killed with
 * that group once it runs past `timeoutMs` or prints too much. Its rc files
 * run whatever they run, so it gets `env` without the variables of the agent
 * session the desktop may have been started from (agent-harness-env.ts),
 * and while RNDEVTOOLS_CHILD_ENV_STRIP cannot be read no shell is asked.
 * Anything that goes wrong reads as undefined.
 */
export function readLoginShellPath({
	env = process.env,
	spawnProcess = spawn,
	timeoutMs = LOGIN_SHELL_TIMEOUT_MS,
}: {
	env?: NodeJS.ProcessEnv;
	spawnProcess?: ShellSpawn;
	timeoutMs?: number;
} = {}): Promise<string | undefined> {
	const shell = loginShell(env);
	if (!shell) return Promise.resolve(undefined);
	let shellEnvironment: NodeJS.ProcessEnv;
	try {
		shellEnvironment = inheritedChildEnvironment(env);
	} catch {
		return Promise.resolve(undefined);
	}
	const marker = `__rndevtools_path_${randomUUID().replaceAll('-', '')}__`;
	return new Promise((resolve) => {
		let output = '';
		let settled = false;
		let child: ChildProcess | undefined;
		const finish = (value: string | undefined, kill = false) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (kill && child?.pid) {
				try {
					process.kill(-child.pid, 'SIGKILL');
				} catch {
					// The shell and everything it started are already gone.
				}
			}
			resolve(value);
		};
		const timer = setTimeout(() => finish(undefined, true), timeoutMs);
		try {
			child = spawnProcess(
				shell,
				['-ilc', `printf '%s%s%s' '${marker}' "$PATH" '${marker}'`],
				{
					detached: true,
					stdio: ['ignore', 'pipe', 'ignore'],
					env: shellEnvironment,
				}
			);
		} catch {
			finish(undefined);
			return;
		}
		child.on('error', () => finish(undefined));
		child.stdout?.on('data', (chunk: Buffer) => {
			output += chunk.toString('utf8');
			const value = betweenMarkers(output, marker);
			if (value !== undefined) finish(value);
			else if (output.length > MAX_LOGIN_SHELL_OUTPUT_BYTES) {
				finish(undefined, true);
			}
		});
		child.on('close', () => finish(betweenMarkers(output, marker)));
	});
}

/**
 * A macOS app opened from Finder or the Dock inherits launchd's PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), which holds no Node that Homebrew, a
 * version manager, or the Node installer put anywhere. When the inherited
 * PATH finds no `node`, the login shell's PATH goes ahead of it; one that
 * already does (a desktop started from a terminal) is used as it is. Cache a
 * shell PATH only while it finds Node, so installing Node during setup or
 * replacing a version-manager runtime takes effect without an app restart.
 */
export function createToolPathResolver({
	readShellPath = (timeoutMs) => readLoginShellPath({ timeoutMs }),
}: {
	readShellPath?: (timeoutMs: number) => Promise<string | undefined>;
} = {}): ToolPathResolver {
	const readNodePath = async (timeoutMs: number) => {
		try {
			const entries = pathEntries(await readShellPath(timeoutMs));
			const candidate = entries.join(path.delimiter);
			if (
				candidate.length <= MAX_TOOL_PATH_LENGTH &&
				findNodeDirectory(candidate)
			) {
				return entries;
			}
		} catch {
			// A later request can try again once the shell is ready.
		}
		return undefined;
	};
	let shellPath: string[] | undefined;
	let reading: Promise<void> | undefined;
	return async (inheritedPath) => {
		if (findNodeDirectory(inheritedPath)) return inheritedPath;
		if (shellPath && !findNodeDirectory(shellPath.join(path.delimiter))) {
			shellPath = undefined;
		}
		if (shellPath === undefined) {
			reading ??= readNodePath(LOGIN_SHELL_TIMEOUT_MS)
				.then(async (entries) => {
					// Give a transient failure one short retry. Both concurrent
					// starts and later starts reuse a successful lookup.
					shellPath =
						entries ?? (await readNodePath(LOGIN_SHELL_RETRY_TIMEOUT_MS));
				})
				.finally(() => {
					reading = undefined;
				});
			await reading;
		}
		if (shellPath === undefined) return inheritedPath;
		return [...new Set([...shellPath, ...pathEntries(inheritedPath)])].join(
			path.delimiter
		);
	};
}

/** Share successful discovery and in-flight reads across Metro and native plans. */
export const resolveToolPath: ToolPathResolver = createToolPathResolver();

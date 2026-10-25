import {
	type ChildProcess,
	type SpawnOptions,
	spawn,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const LOGIN_SHELL_TIMEOUT_MS = 5_000;
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

/** Whether `/usr/bin/env node` would find a Node on `searchPath`. */
function findsNode(searchPath: string | undefined): boolean {
	return pathEntries(searchPath).some((directory) =>
		isExecutableFile(path.join(directory, 'node'))
	);
}

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
 * that group once it runs past `timeoutMs` or prints too much. Anything that
 * goes wrong reads as undefined.
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
				{ detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...env } }
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
 * already does (a desktop started from a terminal) is used as it is. Once the
 * shell has given a PATH it is not asked again; after an answer without one,
 * the next call asks again.
 */
export function createToolPathResolver({
	readShellPath = readLoginShellPath,
}: {
	readShellPath?: () => Promise<string | undefined>;
} = {}): ToolPathResolver {
	let shellPath: string[] | undefined;
	let reading: Promise<string[] | undefined> | undefined;
	return async (inheritedPath) => {
		if (findsNode(inheritedPath)) return inheritedPath;
		if (shellPath === undefined) {
			reading ??= readShellPath()
				.then((value) => {
					const entries = pathEntries(value);
					return entries.length > 0 &&
						entries.join(path.delimiter).length <= MAX_TOOL_PATH_LENGTH
						? entries
						: undefined;
				})
				.catch(() => undefined)
				.finally(() => {
					reading = undefined;
				});
			shellPath = await reading;
		}
		if (shellPath === undefined) return inheritedPath;
		return [...new Set([...shellPath, ...pathEntries(inheritedPath)])].join(
			path.delimiter
		);
	};
}

/** The one resolver Metro and the native plan share, so the shell is asked once. */
export const resolveToolPath: ToolPathResolver = createToolPathResolver();

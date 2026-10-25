import { type SpawnOptions, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import {
	MAX_METRO_ENV_VALUE_LENGTH,
	METRO_ENV_NAME,
} from '../shared/lane-protocol';
import { resolveToolPath, type ToolPathResolver } from './lane-tool-path';
import { runSimulatorCommand } from './simulator-command-runner';

const METRO_PROBE_TIMEOUT_MS = 750;
const METRO_LOG_TAIL_BYTES = 256 * 1024;
const LSOF_PATH = '/usr/sbin/lsof';
const OWNER_PROBE_TIMEOUT_MS = 3_000;
const OWNER_PROBE_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_LANE_ENV_ENTRIES = 32;

/**
 * What a lane's Metro must not inherit from the desktop. Metro inlines
 * EXPO_PUBLIC_* into every lane's dev bundle, and SUPABASE_*, PG* and
 * RNDEVTOOLS_* would point a worktree's tooling at whatever backend or agent
 * session the desktop happened to be launched from. A lane gets such values
 * only from its environment's metroEnv or its own laneEnv.
 */
const STRIPPED_INHERITED_ENV = /^(?:EXPO_PUBLIC_|SUPABASE_|PG|RNDEVTOOLS_)/;

/**
 * A laneEnv entry named like a credential is refused whatever its value, as
 * is a value that is a Supabase secret key or a URL with a password in it:
 * Metro inlines EXPO_PUBLIC_* values into the app bundle and hands the rest
 * to app.config.js, and neither is a place for a secret.
 */
const SECRET_ENV_NAME =
	/(?:SECRET|SERVICE_ROLE|PASSWORD|PASSWD|PRIVATE_KEY|ROOT_KEY|DB_URL|DATABASE_URL)/;
const SECRET_ENV_VALUE = /sb_secret_|:\/\/[^/\s:@]+:[^/\s@]+@/;

export type MetroLaunchInput = {
	worktreePath: string;
	port: number;
	logPath: string;
	/** Environment selected in JavaScript; never changes the native build. */
	metroEnv?: Readonly<Record<string, string>>;
	/**
	 * This lane's own variables, such as its local backend's URL and
	 * publishable key, applied over metroEnv. A launch input only: lanes.json
	 * and LaneState never carry it, because a value may be a key.
	 */
	laneEnv?: Readonly<Record<string, string>>;
	maxWorkers?: number;
};

export type MetroSupervisorPort = {
	isPortFree: (port: number) => Promise<boolean>;
	start: (input: MetroLaunchInput) => Promise<number>;
	/**
	 * Whether the Metro at `pid` is serving `port`: a packager answers there
	 * and that very process holds the listening socket.
	 */
	isHealthy: (port: number, pid: number) => Promise<boolean>;
	isProcessRunning: (pid: number) => boolean;
	/**
	 * Stops the Metro at `pid` only if it is the one serving `port` from
	 * `appDirectory`. Throws NotLaneMetroError, signalling nothing, once `pid`
	 * is proven to be some other process, and a plain error, signalling
	 * nothing either, when it cannot tell whether `pid` is the lane's Metro.
	 */
	stop: (pid: number, port: number, appDirectory: string) => Promise<void>;
	readLogTail: (logPath: string, maxCharacters: number) => Promise<string>;
};

/**
 * The PID a lane recorded now names some other process: its command line is
 * no Expo or Metro on the lane's port. PIDs get reused, so the lane's own
 * Metro is gone. Nothing was signalled.
 */
export class NotLaneMetroError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'NotLaneMetroError';
	}
}

type CommandRunner = typeof runSimulatorCommand;

/** What a Metro start needs from the child it spawned. */
type MetroChild = {
	readonly pid?: number | undefined;
	unref: () => void;
	once: (event: 'spawn', listener: () => void) => unknown;
	on: (event: 'error', listener: (error: Error) => void) => unknown;
};

type MetroSpawn = (
	command: string,
	args: readonly string[],
	options: SpawnOptions
) => MetroChild;

type PackagerProbe = (
	url: string,
	init: { signal: AbortSignal }
) => Promise<{ ok: boolean; text: () => Promise<string> }>;

/**
 * The command-line half of proving a PID is still the Metro this lane
 * started before signalling it: Expo or Metro, with the `--port <n>` the lane
 * itself passed at launch. The app directory is not on the command line (a
 * pnpm workspace hoists `.bin/expo` far from the app), so stopping also
 * checks the process's working directory. PIDs get reused; without this a
 * stale lease could kill an unrelated process.
 */
export function isLaneMetroCommand(commandLine: string, port: number): boolean {
	if (!/\b(expo|metro)\b/i.test(commandLine)) return false;
	const match = /(?:^|\s)--port(?:=|\s+)(\d+)(?:\s|$)/.exec(commandLine);
	return match !== null && Number(match[1]) === port;
}

/**
 * Finds the Expo CLI the worktree itself depends on. A pnpm workspace member
 * hoists `.bin/expo` to the workspace root, so walk upward until one appears;
 * never fall back to a global install, which would bundle against the wrong
 * React Native.
 */
function resolveExpoBinary(worktreePath: string): string | undefined {
	let current = path.resolve(worktreePath);
	for (let depth = 0; depth < 6; depth += 1) {
		const candidate = path.join(current, 'node_modules', '.bin', 'expo');
		if (existsSync(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return undefined;
}

function isPortFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = createServer();
		server.unref();
		server.once('error', () => resolve(false));
		server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
			server.close(() => resolve(true));
		});
	});
}

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/**
 * Why a lane's own variables may not reach Metro, or undefined when they
 * may. The reason names a variable only once its name is known to be well
 * formed, and never echoes a value. The lane service asks before a spawn so a
 * backend's variables it would refuse never fail the spawn itself.
 */
export function laneEnvProblem(
	laneEnv: Readonly<Record<string, string>> | undefined
): string | undefined {
	const entries = Object.entries(laneEnv ?? {});
	if (entries.length > MAX_LANE_ENV_ENTRIES) {
		return `At most ${MAX_LANE_ENV_ENTRIES} lane variables can reach Metro.`;
	}
	for (const [name, value] of entries) {
		if (!METRO_ENV_NAME.test(name)) {
			return 'A lane variable name must be uppercase letters, digits, and underscores, at most 64 characters.';
		}
		if (SECRET_ENV_NAME.test(name)) {
			return `Lane variable ${name} names a credential, and credentials never reach Metro.`;
		}
		if (
			typeof value !== 'string' ||
			value.length > MAX_METRO_ENV_VALUE_LENGTH
		) {
			return `Lane variable ${name} must be a string of at most ${MAX_METRO_ENV_VALUE_LENGTH} characters.`;
		}
		if (SECRET_ENV_VALUE.test(value)) {
			return `Lane variable ${name} holds a secret key or a URL with a password, and those never reach Metro.`;
		}
	}
	return undefined;
}

/** A lane's own variables, checked before they reach Metro. */
function checkedLaneEnv(
	laneEnv: Readonly<Record<string, string>> | undefined
): Record<string, string> {
	const problem = laneEnvProblem(laneEnv);
	if (problem) throw new Error(problem);
	return Object.fromEntries(Object.entries(laneEnv ?? {}));
}

/**
 * Metro's environment, in this order: the desktop's own environment without
 * the variables a lane must not inherit, its PATH replaced by `toolPath` when
 * there is one, then the environment's metroEnv, then the lane's checked
 * laneEnv, then the fixed keys every lane needs, which nothing overrides.
 * CI is omitted from all layers so development watchers stay enabled.
 */
function metroEnvironment(
	inherited: NodeJS.ProcessEnv,
	input: MetroLaunchInput,
	laneEnv: Record<string, string>,
	toolPath: string | undefined
): NodeJS.ProcessEnv {
	const base: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(inherited)) {
		if (value !== undefined && !STRIPPED_INHERITED_ENV.test(name)) {
			base[name] = value;
		}
	}
	if (toolPath !== undefined) base.PATH = toolPath;
	const environment: NodeJS.ProcessEnv = {
		...base,
		...input.metroEnv,
		...laneEnv,
		NODE_ENV: 'development',
		RCT_METRO_PORT: String(input.port),
		EXPO_NO_DOTENV: '1',
		EXPO_NO_INTERACTIVE: '1',
		// Every launch URL and QR code the CLI emits gets the automation
		// parameters, so agents see the app rather than the launcher sheet.
		EXPO_NO_DEV_MENU: '1',
		// `--localhost` binds whatever "localhost" resolves to; Node's verbatim
		// DNS order picks [::1] on macOS while the dev client rewrites its
		// packager host to 127.0.0.1. Force IPv4 so the app can actually reach
		// its own Metro.
		NODE_OPTIONS: [inherited.NODE_OPTIONS, '--dns-result-order=ipv4first']
			.filter(Boolean)
			.join(' '),
	};
	// Expo's CI mode disables Metro watchers and Fast Refresh. Detached stdio
	// and the noninteractive flags keep this a background development server.
	delete environment.CI;
	return environment;
}

/**
 * Resolves once the child runs. A spawn that fails (an Expo CLI without its
 * execute bit, an app directory that is gone) is reported on the child's
 * 'error' event after spawn() returned; listening turns it into this start's
 * error instead of an uncaught exception in main. The listener stays: no one
 * else holds a detached Metro's child object.
 */
function spawned(child: MetroChild): Promise<void> {
	return new Promise((resolve, reject) => {
		child.once('spawn', () => resolve());
		child.on('error', reject);
	});
}

/**
 * Metro is detached so it survives the desktop app and so one lane's crash
 * cannot take down the main process. Its output goes to a per-lane log file
 * that the renderer and the agent CLI can tail.
 */
async function startMetro(
	input: MetroLaunchInput,
	spawnProcess: MetroSpawn,
	inherited: NodeJS.ProcessEnv,
	toolPath: ToolPathResolver
): Promise<number> {
	const expoBinary = resolveExpoBinary(input.worktreePath);
	if (!expoBinary) {
		throw new Error(
			`Expo CLI was not found under ${input.worktreePath}/node_modules. Install dependencies in the worktree first.`
		);
	}
	// Refuse a bad laneEnv before the log is created or anything spawns.
	const laneEnv = checkedLaneEnv(input.laneEnv);
	const env = metroEnvironment(
		inherited,
		input,
		laneEnv,
		await toolPath(inherited.PATH)
	);
	const log = openSync(input.logPath, 'a', 0o600);
	try {
		const child = spawnProcess(
			expoBinary,
			[
				'start',
				'--dev-client',
				'--localhost',
				'--port',
				String(input.port),
				'--max-workers',
				String(input.maxWorkers ?? 2),
			],
			{
				cwd: input.worktreePath,
				detached: true,
				stdio: ['ignore', log, log],
				env,
			}
		);
		child.unref();
		try {
			await spawned(child);
		} catch (error) {
			throw new Error(`Metro could not start: ${(error as Error).message}`, {
				cause: error,
			});
		}
		if (!child.pid) throw new Error('Metro did not return a process id.');
		return child.pid;
	} finally {
		closeSync(log);
	}
}

/**
 * `expo start --localhost` may bind either loopback family, so a probe that
 * only tried 127.0.0.1 would report a healthy Metro as dead forever.
 */
async function packagerAnswers(
	port: number,
	probe: PackagerProbe
): Promise<boolean> {
	for (const host of ['127.0.0.1', 'localhost'] as const) {
		try {
			const response = await probe(`http://${host}:${port}/status`, {
				signal: AbortSignal.timeout(METRO_PROBE_TIMEOUT_MS),
			});
			if (
				response.ok &&
				(await response.text()).includes('packager-status:running')
			) {
				return true;
			}
		} catch {
			// Try the other loopback family.
		}
	}
	return false;
}

/**
 * Whether `pid` itself holds a listening TCP socket on `port`. Expo serves
 * Metro from the CLI process the lane spawned, so the lane's PID is the
 * listener. lsof exits 1 when the process has no such socket; that, and any
 * failure to run it, reads as "not this lane's Metro".
 */
async function listensOn(
	pid: number,
	port: number,
	runCommand: CommandRunner
): Promise<boolean> {
	try {
		const result = await runCommand(
			LSOF_PATH,
			[
				'-a',
				'-p',
				String(pid),
				`-iTCP:${port}`,
				'-sTCP:LISTEN',
				'-n',
				'-P',
				'-Fp',
			],
			{
				timeoutMs: OWNER_PROBE_TIMEOUT_MS,
				maxOutputBytes: OWNER_PROBE_MAX_OUTPUT_BYTES,
			}
		);
		return result.stdout.split('\n').includes(`p${pid}`);
	} catch {
		return false;
	}
}

/**
 * A packager answering on a lane's port is not enough to call the lane
 * ready. After a port race, or with a Metro started by hand, another
 * worktree's packager can answer there, and a dev client sent to it would
 * load the wrong branch. The answer counts only when the lane's own Metro
 * owns the socket; ownership that cannot be proven fails closed.
 */
async function isMetroHealthy(
	port: number,
	pid: number,
	probe: PackagerProbe,
	runCommand: CommandRunner
): Promise<boolean> {
	if (!(await packagerAnswers(port, probe))) return false;
	return listensOn(pid, port, runCommand);
}

/** A directory's device and inode, both unsigned, as lsof prints them. */
type DirectoryIdentity = { device: bigint; inode: bigint };

/** What lsof reports about a process's working directory. */
type ProcessCwd = {
	/** Its path as lsof printed it, in lsof's escapes (see printsPath). */
	printed: string;
	/** Its device and inode; undefined unless lsof printed both. */
	identity: DirectoryIdentity | undefined;
};

/**
 * lsof's -F report on a process's working directory. lsof 4.91 prints the
 * process, the descriptor, then the device in hexadecimal, the inode in
 * decimal and the name, in that order whatever order -F names them in.
 */
const LSOF_CWD_REPORT =
	/^p(\d+)\nfcwd\n(?:D0x([0-9a-f]{1,8})\n)?(?:i(\d{1,20})\n)?n([^\n]+)\n$/;

/**
 * The working directory lsof reports for `pid`: its device and inode, and
 * its path as lsof prints it, which the kernel resolved, free of symlinks and
 * spelling each name as the disk stores it. Any other report fails. lsof
 * runs in the C locale whatever the desktop's, so it escapes every non-ASCII
 * byte. A legacy locale prints some bytes raw: in ja_JP.SJIS the backslash
 * of `Á\t` is the second byte of a character, so the path reads as `Á` and
 * a tab, and in fr_FR.ISO8859-1 `Á` and `ā` both read as U+FFFD and `\x81`.
 */
async function processCwd(
	pid: number,
	runCommand: CommandRunner
): Promise<ProcessCwd> {
	const result = await runCommand(
		LSOF_PATH,
		['-a', '-p', String(pid), '-d', 'cwd', '-FDin'],
		{
			timeoutMs: OWNER_PROBE_TIMEOUT_MS,
			maxOutputBytes: OWNER_PROBE_MAX_OUTPUT_BYTES,
			environment: { LC_ALL: 'C' },
		}
	);
	const [, reported, device, inode, printed] =
		LSOF_CWD_REPORT.exec(result.stdout) ?? [];
	if (reported !== String(pid) || printed === undefined) {
		throw new Error(`lsof reported no working directory for process ${pid}.`);
	}
	return {
		printed,
		identity:
			device === undefined || inode === undefined
				? undefined
				: { device: BigInt(`0x${device}`), inode: BigInt(inode) },
	};
}

const LSOF_CONTROL_ESCAPES: ReadonlyMap<number, string> = new Map([
	[0x08, '\\b'],
	[0x09, '\\t'],
	[0x0a, '\\n'],
	[0x0c, '\\f'],
	[0x0d, '\\r'],
]);

/**
 * How lsof prints a byte of a name: printable ASCII as itself, except the
 * backslash, which it doubles; a control byte as \b \t \n \f \r, or ^@ to ^_
 * for the others; and every other byte, DEL included, as \xNN. (It prints
 * 0xff as ^?, but no UTF-8 path holds that byte.) A non-ASCII character its
 * locale can print comes out whole instead (see printsPath).
 */
function lsofPrintedByte(byte: number): string {
	if (byte === 0x5c) return '\\\\';
	if (byte >= 0x20 && byte < 0x7f) return String.fromCharCode(byte);
	const control = LSOF_CONTROL_ESCAPES.get(byte);
	if (control !== undefined) return control;
	if (byte < 0x20) return `^${String.fromCharCode(byte | 0x40)}`;
	return `\\x${byte.toString(16).padStart(2, '0')}`;
}

/**
 * Whether `printed`, a path as lsof printed it, is `candidate`. lsof prints a
 * character as it is only when its locale can print it, and otherwise
 * escapes each of its bytes. processCwd runs it in the C locale, which
 * escapes every non-ASCII byte: `À faire` is `\xc3\x80 faire`. A UTF-8 locale
 * prints most characters as they are, but still escapes the ones it cannot
 * print, such as a soft hyphen or a zero-width joiner. The text is read
 * against a candidate rather than decoded on its own because lsof prints a
 * caret as it is: its `^A` is a caret and an A, or the control byte 0x01.
 */
function printsPath(printed: string, candidate: string): boolean {
	let at = 0;
	for (const character of candidate) {
		// Every escape is ASCII, so a non-ASCII character printed as it is
		// cannot be part of one.
		if (
			(character.codePointAt(0) ?? 0) > 0x7f &&
			printed.startsWith(character, at)
		) {
			at += character.length;
			continue;
		}
		for (const byte of Buffer.from(character, 'utf8')) {
			const expected = lsofPrintedByte(byte);
			if (!printed.startsWith(expected, at)) return false;
			at += expected.length;
		}
	}
	return at === printed.length;
}

/**
 * Decodes a run of escaped bytes. It fails on bytes that are no whole
 * character (fatal), which then stay escaped: a single-byte locale can print
 * some bytes of a character raw, which the runner reads back as U+FFFD, and
 * escape the rest. It keeps a leading U+FEFF (ignoreBOM): by default the
 * decoder drops it unseen, and `a\xef\xbb\xbfpp` would read as `app`.
 */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * What a message may not show as it is: controls, format characters such as
 * the bidi overrides and isolates, line and paragraph separators, and the
 * other default-ignorable code points, which render as nothing, such as the
 * combining grapheme joiner, variation selectors and Hangul fillers. Any of
 * them can make a path read as another one.
 */
const UNSAFE_IN_MESSAGE =
	/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

/**
 * A path lsof printed, for a message: each run of non-ASCII bytes it escaped
 * read back as UTF-8, and the rest as lsof printed it, a doubled backslash
 * included. Every backslash then starts an escape or ends lsof's `^\` for
 * U+001C, and paths lsof prints apart never read alike. That holds because
 * processCwd runs lsof in the C locale (a UTF-8 one would do too), never in
 * a legacy locale, which can print a backslash or a lone byte raw. `^\` is
 * read as one escape wherever that lets the next `\x`, after any doubled
 * backslashes, start a run: `\xd0\xa0^\\xd0\xb0` is Р, U+001C and а, and
 * `^\\\\xd0\xb0` is U+001C, a backslash and а. Control bytes stay escaped,
 * a run holding a character UNSAFE_IN_MESSAGE names stays escaped whole, and
 * such a character lsof printed raw is escaped as lsof escapes it in the C
 * locale. A UTF-8 locale prints the separators, the combining grapheme
 * joiner, variation selectors and Hangul fillers raw, and a single-byte
 * locale can print each byte of a character as a letter of its own, which
 * the runner reads back as UTF-8: ru_RU.CP866 does so for a bidi override,
 * kk_KZ.PT154 for C1 controls.
 */
function readableLsofPath(printed: string): string {
	return printed.replace(
		/\\\\|\^\\(?=(?:\\\\)*\\x[89a-f][0-9a-f])|(?:\\x[89a-f][0-9a-f])+|[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu,
		(match) => {
			if (match === '\\\\' || match === '^\\') return match;
			if (!match.startsWith('\\x')) {
				return Array.from(Buffer.from(match, 'utf8'), lsofPrintedByte).join('');
			}
			try {
				const decoded = UTF8.decode(
					Buffer.from(match.replaceAll('\\x', ''), 'hex')
				);
				return UNSAFE_IN_MESSAGE.test(decoded) ? match : decoded;
			} catch {
				return match;
			}
		}
	);
}

/**
 * A path for a message, shown as readableLsofPath shows what lsof prints for
 * it in the C locale, so that the lane's own path reads in the same escapes
 * as the one lsof printed beside it: a lane named `a\xef\xbb\xbfpp` shows as
 * `a\\xef\\xbb\\xbfpp`, apart from a directory named a, U+FEFF and pp.
 */
function readablePath(directory: string): string {
	return readableLsofPath(
		Array.from(Buffer.from(directory, 'utf8'), lsofPrintedByte).join('')
	);
}

/**
 * The device and inode of `directory`, as lsof prints a working directory's,
 * or undefined when it is gone (ENOENT). stat(2) resolves the path as the
 * kernel resolved Metro's working directory, through symlinks, letter case
 * and Unicode normalization alike, so its realpath has the same two numbers.
 * A dev_t is 32 bits and lsof prints it unsigned, while Node reads both
 * numbers as signed 64-bit ones: devfs's device, whose high bit is set, reads
 * as negative.
 */
async function directoryIdentity(
	directory: string
): Promise<DirectoryIdentity | undefined> {
	try {
		const { dev, ino } = await stat(directory, { bigint: true });
		return { device: BigInt.asUintN(32, dev), inode: BigInt.asUintN(64, ino) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw error;
	}
}

/**
 * A caret escape lsof prints for a control byte from 0x01 to 0x1f other than
 * \b \t \n \f and \r. Each but one is also how it prints a caret followed by
 * that letter or sign: `^A` is 0x01, or a caret and an A. lsof doubles a
 * backslash, so `^\` for 0x1c only begins how it prints a caret and a
 * backslash, `^\\`: `^\\t` is 0x1c and a tab, or a caret, a backslash and a t.
 */
const LSOF_CARET_ESCAPE = /\^[A-GKN-Z[\\\]^_]/;

/**
 * Whether the working directory lsof reported is `appDirectory`: the same
 * device and inode, which no spelling can stand in for, since lsof prints
 * some paths alike (see LSOF_CARET_ESCAPE). Only an app directory that is
 * gone leaves nothing to compare. lsof keeps printing a working directory
 * deleted under its process, so then the path lsof printed must be the app
 * directory as given, with no caret escape that another path prints alike.
 * Throws when it cannot tell.
 */
async function isAppDirectory(
	cwd: ProcessCwd,
	appDirectory: string
): Promise<boolean> {
	const resolved = path.resolve(appDirectory);
	const identity = await directoryIdentity(resolved);
	if (identity === undefined) {
		if (!printsPath(cwd.printed, resolved)) return false;
		if (LSOF_CARET_ESCAPE.test(cwd.printed)) {
			throw new Error(
				"the app directory is gone, and the path lsof printed could be another directory's: lsof prints a control byte as a caret and a letter or sign."
			);
		}
		return true;
	}
	if (cwd.identity === undefined) {
		throw new Error(
			'lsof printed no device and inode for its working directory.'
		);
	}
	return (
		cwd.identity.device === identity.device &&
		cwd.identity.inode === identity.inode
	);
}

/**
 * Whether `printed`, a path lsof printed, reads as `appDirectory`, as given
 * or as its realpath: the kernel spells each name in the path lsof reports as
 * the disk stores it, and so does realpath(3).
 */
async function readsAsAppDirectory(
	printed: string,
	appDirectory: string
): Promise<boolean> {
	const resolved = path.resolve(appDirectory);
	if (printsPath(printed, resolved)) return true;
	try {
		return printsPath(printed, await realpath(resolved));
	} catch {
		return false;
	}
}

/**
 * Stops only a Metro this lane owns. PIDs are recycled, so before signalling
 * the process group the PID must still be an Expo or Metro serving the lane's
 * port (its command line carries the `--port` the lane passed) from the
 * lane's app directory (its working directory, by device and inode: Expo and
 * Metro never change it). A PID whose command line is anything else is left
 * alone and throws NotLaneMetroError. One that cannot be inspected fails
 * closed, and so does an Expo or Metro on the port serving from elsewhere:
 * that may be another worktree's, but also the lane's own after its worktree
 * was moved or renamed, which lsof then reports under the new path, or after
 * its app directory was recreated.
 */
async function stopMetro(
	pid: number,
	port: number,
	appDirectory: string,
	runCommand: CommandRunner
): Promise<void> {
	if (!isProcessRunning(pid)) return;
	let cwd: ProcessCwd | undefined;
	let servesHere = false;
	try {
		const result = await runCommand(
			'/bin/ps',
			['-p', String(pid), '-o', 'command='],
			{ timeoutMs: 5_000, maxOutputBytes: 64 * 1024 }
		);
		if (isLaneMetroCommand(result.stdout, port)) {
			cwd = await processCwd(pid, runCommand);
			servesHere = await isAppDirectory(cwd, appDirectory);
		}
	} catch (error) {
		// A process that exited while it was inspected has nothing to stop.
		if (!isProcessRunning(pid)) return;
		// Otherwise the PID cannot be proven to be ours. Fail closed and say
		// so: the lane keeps its lease and the operator can stop Metro by hand.
		throw new Error(
			`Could not inspect process ${pid} to confirm it is this lane's Metro (${(error as Error).message}); refusing to stop it. Stop the Metro on port ${port} manually, then stop the lane again.`
		);
	}
	if (cwd === undefined) {
		throw new NotLaneMetroError(
			`Process ${pid} is no longer the Metro serving port ${port}; refusing to stop it.`
		);
	}
	if (!servesHere) {
		// Not proof the lane's Metro is gone, so the lane keeps its lease.
		const lanePath = readablePath(appDirectory);
		throw new Error(
			(await readsAsAppDirectory(cwd.printed, appDirectory))
				? `Process ${pid} is an Expo or Metro on port ${port} serving from another directory than this lane's ${lanePath}, though lsof prints its path the same; refusing to stop it. If the app directory was recreated, it is likely this lane's Metro: stop it manually, then stop the lane again.`
				: `Process ${pid} is an Expo or Metro on port ${port} serving from ${readableLsofPath(cwd.printed)}, not from this lane's ${lanePath}; refusing to stop it. If the worktree was moved or renamed, it is likely this lane's Metro: stop it manually, then stop the lane again.`
		);
	}
	try {
		process.kill(-pid, 'SIGTERM');
	} catch {
		process.kill(pid, 'SIGTERM');
	}
}

/**
 * The end of a lane's Metro log. A tail that starts mid-file starts at the
 * next whole line when one follows: a line cut at its head can begin inside
 * a secret whose name was cut off, which no redactor can recognise
 * afterwards. A tail that is all one line is returned as it is.
 */
async function readLogTail(
	logPath: string,
	maxCharacters: number
): Promise<string> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const info = await stat(logPath);
		const bytes = Math.min(info.size, METRO_LOG_TAIL_BYTES);
		handle = await open(logPath, 'r');
		const buffer = Buffer.alloc(bytes);
		await handle.read(buffer, 0, bytes, info.size - bytes);
		let text = buffer.toString('utf8');
		let cut = bytes < info.size;
		if (text.length > maxCharacters) {
			text = text.slice(-maxCharacters);
			cut = true;
		}
		const newline = cut ? text.indexOf('\n') : -1;
		return newline === -1 || newline === text.length - 1
			? text
			: text.slice(newline + 1);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
		throw error;
	} finally {
		await handle?.close();
	}
}

export function createMetroSupervisor({
	runCommand = runSimulatorCommand,
	spawnProcess = spawn,
	probe = fetch,
	environment = process.env,
	toolPath = resolveToolPath,
}: {
	/** The bounded runner `ps` and `lsof` go through. */
	runCommand?: CommandRunner;
	spawnProcess?: MetroSpawn;
	probe?: PackagerProbe;
	/** What a lane's Metro inherits before stripping: the desktop's own env. */
	environment?: NodeJS.ProcessEnv;
	/** The PATH Metro gets in place of the inherited one, so it finds Node. */
	toolPath?: ToolPathResolver;
} = {}): MetroSupervisorPort {
	return {
		isPortFree,
		start: (input) => startMetro(input, spawnProcess, environment, toolPath),
		isHealthy: (port, pid) => isMetroHealthy(port, pid, probe, runCommand),
		isProcessRunning,
		stop: (pid, port, appDirectory) =>
			stopMetro(pid, port, appDirectory, runCommand),
		readLogTail,
	};
}

export const metroSupervisor: MetroSupervisorPort = createMetroSupervisor();

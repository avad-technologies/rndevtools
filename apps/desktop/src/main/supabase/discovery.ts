import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { redactDiagnosticText } from '@rndevtools/core/redact';
import {
	runSimulatorCommand,
	SimulatorCommandError,
} from '../simulator-command-runner';
import {
	isPathWithin,
	nodeStaticFileSystem,
	type StaticFileSystem,
} from './bounded-read';

/**
 * Cheap, read-only discovery of local Supabase stacks (DESIGN: discovery
 * cadence, exposure verification, capacity). No Supabase CLI process is
 * involved: owner argv from pgrep, the per-user port registry through one
 * read-only SELECT, lsof over a stack's process tree, SysV shared-memory
 * capacity, du/ps footprints, and the ps command line of a CLI child a
 * previous desktop left running. Every probe runs a fixed absolute
 * executable with a timeout and an output cap, and every function resolves to
 * a typed result with an `unavailable` reason instead of throwing.
 */

const PGREP = '/usr/bin/pgrep';
const PS = '/bin/ps';
const LSOF = '/usr/sbin/lsof';
const SYSCTL = '/usr/sbin/sysctl';
const IPCS = '/usr/bin/ipcs';
const DU = '/usr/bin/du';

/** The only executables discovery ever runs. */
export type ProbeExecutable =
	| typeof PGREP
	| typeof PS
	| typeof LSOF
	| typeof SYSCTL
	| typeof IPCS
	| typeof DU;

export type ProbeRunResult =
	| { kind: 'exit'; exitCode: number; stdout: string; stderr: string }
	| {
			kind: 'error';
			reason: 'spawn' | 'timeout' | 'output-limit' | 'aborted' | 'signal';
	  };

/** Runs one probe; resolves with its exit status instead of throwing. */
export type ProbeRunner = (request: {
	executable: ProbeExecutable;
	args: readonly string[];
	timeoutMs: number;
	maxOutputBytes: number;
}) => Promise<ProbeRunResult>;

export type ProbeUnavailableReason =
	| 'unsupported-platform'
	| 'invalid-input'
	| 'too-many'
	| 'spawn-failed'
	| 'timeout'
	| 'output-limit'
	| 'aborted'
	| 'killed'
	| 'command-failed'
	| 'unparseable'
	| 'missing'
	| 'not-a-file'
	| 'sqlite-unavailable'
	| 'busy'
	| 'needs-recovery'
	| 'corrupt'
	| 'unexpected-schema'
	| 'sqlite-error';

export type ProbeUnavailable = {
	status: 'unavailable';
	reason: ProbeUnavailableReason;
	/** Short, redacted, single-line context; never raw output. */
	detail?: string;
};

/**
 * A process running `<bin> __supabase_stack_host__ <state> <cache> <id>`.
 * argv is self-reported: any same-user process can claim this shape.
 */
export type SupabaseOwnerProcess = {
	pid: number;
	/** argv[0]: the CLI binary that launched the owner (unvalidated). */
	executable: string;
	stackId: string;
	/** `<SUPABASE_HOME>/stacks`; omitted when spaces make argv ambiguous. */
	stateRoot?: string;
	/** `<SUPABASE_HOME>/cache/stack`; omitted with `stateRoot`. */
	cacheRoot?: string;
};

export type OwnerDiscoveryResult =
	| { status: 'ok'; owners: SupabaseOwnerProcess[] }
	| ProbeUnavailable;

export type ProcessTreeResult =
	| {
			status: 'ok';
			rootPid: number;
			/** Root first, then launchers and descendants, without duplicates. */
			pids: number[];
			/** Launchers matched by `supabase-stack-id=<id>` in their argv. */
			launcherPids: number[];
	  }
	| ProbeUnavailable;

export type PortReservation = {
	stateRoot: string;
	stackId: string;
	endpoint: string;
	port: number;
};

export type PortReservationsResult =
	| {
			status: 'ok';
			file: string;
			reservations: PortReservation[];
			/** Rows that failed validation and were left out. */
			skippedRows: number;
			truncated: boolean;
	  }
	| ProbeUnavailable;

/**
 * A TCP LISTEN or bound, unconnected UDP socket.
 */
export type ExposureListener = {
	pid: number;
	command?: string;
	protocol: 'tcp' | 'udp';
	family?: 'ipv4' | 'ipv6';
	/** Local address as lsof prints it: `127.0.0.1`, `::1`, `*`, a LAN IP. */
	address: string;
	port: number;
	/** Only 127.0.0.1 and ::1 count as loopback. */
	loopback: boolean;
};

export type ExposureResult =
	| {
			status: 'ok';
			pids: number[];
			listeners: ExposureListener[];
			nonLoopback: ExposureListener[];
	  }
	| ProbeUnavailable;

export type SysvCapacityResult =
	| {
			status: 'ok';
			/** `kern.sysv.shmmni`: the machine-wide segment limit. */
			shmmni: number;
			/** Segments in use per `ipcs -m`; unavailable without ipcs. */
			segments: { status: 'ok'; used: number; free: number } | ProbeUnavailable;
	  }
	| ProbeUnavailable;

export type DiskUsageEntry =
	| { path: string; status: 'ok'; bytes: number }
	| {
			path: string;
			status: 'unavailable';
			reason:
				| 'invalid-path'
				| 'missing'
				| 'outside-supabase-home'
				| 'not-reported';
	  };

export type DiskUsageResult =
	| { status: 'ok'; entries: DiskUsageEntry[] }
	| ProbeUnavailable;

export type MemoryResult =
	| {
			status: 'ok';
			/** Resident set size; it overcounts pages shared between processes. */
			metric: 'rss';
			bytes: number;
			processCount: number;
	  }
	| ProbeUnavailable;

/** A process's command line as `ps` prints it; none once it is gone. */
export type ProcessCommandResult =
	| { status: 'ok'; command: string | undefined }
	| ProbeUnavailable;

/** The read-only `ports.sqlite` connection discovery needs. */
export type PortsDatabase = {
	selectReservations: () => unknown[];
	close: () => void;
};

export type SupabaseDiscovery = {
	discoverOwners: () => Promise<OwnerDiscoveryResult>;
	processTree: (
		rootPid: number,
		options?: { stackId?: string }
	) => Promise<ProcessTreeResult>;
	readPortReservations: () => Promise<PortReservationsResult>;
	checkExposure: (pids: readonly number[]) => Promise<ExposureResult>;
	readSysvCapacity: () => Promise<SysvCapacityResult>;
	measureDisk: (paths: readonly string[]) => Promise<DiskUsageResult>;
	measureMemory: (pids: readonly number[]) => Promise<MemoryResult>;
	processCommand: (pid: number) => Promise<ProcessCommandResult>;
};

export type SupabaseDiscoveryOptions = {
	run?: ProbeRunner;
	/** Real user id for `pgrep -U`; defaults to process.getuid(). */
	uid?: number;
	/** Defaults to os.userInfo().homedir; the port registry ignores HOME. */
	homeDirectory?: string;
	/** The SUPABASE_HOME the desktop uses; defaults to `<home>/.supabase`. */
	supabaseHome?: string;
	/** Defaults to node:sqlite read-only; undefined means no node:sqlite. */
	openPortsDatabase?: (file: string) => PortsDatabase | undefined;
	fs?: Pick<StaticFileSystem, 'kind' | 'realpath'>;
	/** Probes other than the port registry run only on darwin. */
	platform?: NodeJS.Platform;
};

const OWNER_MARKER = '__supabase_stack_host__';
const LAUNCHER_MARKER = '__supabase_stack_native__';
const STACK_ID = /^[0-9a-f]{64}$/;
const ENDPOINT_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
const RESERVATION_QUERY =
	'SELECT state_root, stack_id, endpoint, port FROM reservation LIMIT 4097';

const MAX_OWNERS = 256;
const MAX_TREE_PIDS = 512;
const MAX_TREE_DEPTH = 16;
const MAX_QUERY_PIDS = 512;
const MAX_LISTENERS = 2_048;
const MAX_RESERVATIONS = 4_096;
const MAX_DISK_PATHS = 64;
const MAX_LINE_LENGTH = 16 * 1024;
const MAX_PATH_LENGTH = 4_096;
const MAX_DETAIL_LENGTH = 200;
const PORTS_BUSY_TIMEOUT_MS = 50;

const BUDGETS = {
	pgrep: { timeoutMs: 5_000, maxOutputBytes: 256 * 1024 },
	ps: { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 },
	lsof: { timeoutMs: 10_000, maxOutputBytes: 512 * 1024 },
	sysctl: { timeoutMs: 2_000, maxOutputBytes: 4 * 1024 },
	ipcs: { timeoutMs: 2_000, maxOutputBytes: 128 * 1024 },
	du: { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 },
} as const;

const runProbe: ProbeRunner = async ({
	executable,
	args,
	timeoutMs,
	maxOutputBytes,
}) => {
	try {
		const result = await runSimulatorCommand(executable, args, {
			timeoutMs,
			maxOutputBytes,
			forceKillDelayMs: 1_000,
		});
		return {
			kind: 'exit',
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
		};
	} catch (error) {
		if (!(error instanceof SimulatorCommandError)) {
			return { kind: 'error', reason: 'spawn' };
		}
		const reason = error.kind;
		if (reason !== 'failed') return { kind: 'error', reason };
		const exitCode = error.exitCode;
		return exitCode === null
			? { kind: 'error', reason: 'signal' }
			: {
					kind: 'exit',
					exitCode,
					stdout: error.stdout,
					stderr: error.stderr,
				};
	}
};

function openPortsDatabaseReadOnly(file: string): PortsDatabase | undefined {
	let sqlite: typeof import('node:sqlite');
	try {
		// Not every Node has node:sqlite; resolve at call time and degrade, the
		// same way agent-sessions.ts opens the Codex database.
		sqlite = createRequire(process.execPath)('node:sqlite');
	} catch {
		return undefined;
	}
	const database = new sqlite.DatabaseSync(file, {
		readOnly: true,
		timeout: PORTS_BUSY_TIMEOUT_MS,
	});
	return {
		// One autocommit SELECT: its read lock ends with the statement, so CLI
		// writers (busy_timeout 2 s) never wait on the desktop.
		selectReservations: () => database.prepare(RESERVATION_QUERY).all(),
		close: () => database.close(),
	};
}

function unavailable(
	reason: ProbeUnavailableReason,
	detail?: string
): ProbeUnavailable {
	return detail === undefined
		? { status: 'unavailable', reason }
		: { status: 'unavailable', reason, detail: boundedDetail(detail) };
}

function boundedDetail(text: string): string {
	const firstLine = text.replace(/\p{Cc}+/gu, ' ').trim();
	return redactDiagnosticText(firstLine).slice(0, MAX_DETAIL_LENGTH);
}

function runFailure(
	result: Extract<ProbeRunResult, { kind: 'error' }>
): ProbeUnavailable {
	const reason = result.reason;
	switch (reason) {
		case 'spawn':
			return unavailable('spawn-failed');
		case 'signal':
			return unavailable('killed');
		default:
			return unavailable(reason);
	}
}

function commandFailed(
	executable: ProbeExecutable,
	result: Extract<ProbeRunResult, { kind: 'exit' }>
): ProbeUnavailable {
	const stderr = result.stderr.split('\n').find((line) => line.trim()) ?? '';
	return unavailable(
		'command-failed',
		`${path.basename(executable)} exited ${result.exitCode}${stderr ? `: ${stderr}` : ''}`
	);
}

function isPid(value: unknown): value is number {
	return (
		typeof value === 'number' &&
		Number.isSafeInteger(value) &&
		value > 0 &&
		value <= 99_999_999
	);
}

function isAbsolutePathText(value: string): boolean {
	return (
		value.startsWith('/') &&
		value.length <= MAX_PATH_LENGTH &&
		!value.includes('\0') &&
		!/[\r\n]/.test(value)
	);
}

function uniquePids(
	pids: readonly number[]
): number[] | 'invalid' | 'too-many' {
	if (!pids.every(isPid)) return 'invalid';
	const unique = [...new Set(pids)];
	if (unique.length === 0) return 'invalid';
	return unique.length > MAX_QUERY_PIDS ? 'too-many' : unique;
}

/** Index of `token` as a whole space-separated word in `command`, or -1. */
function tokenIndex(command: string, token: string): number {
	for (
		let index = command.indexOf(token);
		index !== -1;
		index = command.indexOf(token, index + 1)
	) {
		const before = index === 0 ? ' ' : command.charAt(index - 1);
		const after = command.charAt(index + token.length);
		if (before === ' ' && (after === ' ' || after === '')) return index;
	}
	return -1;
}

/** `pgrep -l` prints `<pid> <space-joined argv>`. */
function parseProcessLine(
	line: string
): { pid: number; command: string } | undefined {
	if (line.length > MAX_LINE_LENGTH) return undefined;
	const match = /^\s*(\d{1,10}) (.+)$/.exec(line);
	const pid = Number(match?.[1]);
	const command = match?.[2];
	return command && isPid(pid) ? { pid, command } : undefined;
}

/**
 * pgrep joins argv with spaces, so the state and cache roots are ambiguous
 * when SUPABASE_HOME contains spaces. A single split point is unambiguous;
 * otherwise prefer the CLI's own layout, `<home>/stacks` + `<home>/cache/stack`.
 */
function splitRoots(
	text: string
): { stateRoot: string; cacheRoot: string } | undefined {
	const candidates: { stateRoot: string; cacheRoot: string }[] = [];
	for (
		let index = text.indexOf(' /');
		index !== -1;
		index = text.indexOf(' /', index + 1)
	) {
		candidates.push({
			stateRoot: text.slice(0, index),
			cacheRoot: text.slice(index + 1),
		});
	}
	if (candidates.length === 1) return candidates[0];
	const conventional = candidates.filter(
		({ stateRoot, cacheRoot }) =>
			stateRoot.endsWith('/stacks') &&
			cacheRoot.endsWith('/cache/stack') &&
			stateRoot.slice(0, -'/stacks'.length) ===
				cacheRoot.slice(0, -'/cache/stack'.length)
	);
	return conventional.length === 1 ? conventional[0] : undefined;
}

function parseOwner(line: string): SupabaseOwnerProcess | undefined {
	const parsed = parseProcessLine(line);
	if (!parsed) return undefined;
	const marker = tokenIndex(parsed.command, OWNER_MARKER);
	if (marker <= 0) return undefined;
	const executable = parsed.command.slice(0, marker - 1);
	if (!isAbsolutePathText(executable)) return undefined;
	const rest = parsed.command.slice(marker + OWNER_MARKER.length + 1);
	const match = /^(\/.*?) ([0-9a-f]{64})(?: |$)/.exec(rest);
	const rootsText = match?.[1];
	const stackId = match?.[2];
	if (!rootsText || !stackId) return undefined;
	const roots = splitRoots(rootsText);
	return {
		pid: parsed.pid,
		executable,
		stackId,
		...(roots &&
		isAbsolutePathText(roots.stateRoot) &&
		isAbsolutePathText(roots.cacheRoot)
			? roots
			: {}),
	};
}

function parseLauncherPid(line: string, stackId: string): number | undefined {
	const parsed = parseProcessLine(line);
	if (!parsed) return undefined;
	if (tokenIndex(parsed.command, LAUNCHER_MARKER) <= 0) return undefined;
	return tokenIndex(parsed.command, `supabase-stack-id=${stackId}`) === -1
		? undefined
		: parsed.pid;
}

function parsePidLines(stdout: string): number[] | undefined {
	const pids: number[] = [];
	for (const line of stdout.split('\n')) {
		const text = line.trim();
		if (!text) continue;
		if (!/^\d{1,10}$/.test(text)) return undefined;
		const pid = Number(text);
		if (isPid(pid)) pids.push(pid);
	}
	return pids;
}

/** `HOST:PORT[->REMOTE]` with `[v6]` hosts, as lsof prints socket names. */
function parseSocketName(
	name: string
): { address: string; port?: number; connected: boolean } | undefined {
	const arrow = name.indexOf('->');
	const local = arrow === -1 ? name : name.slice(0, arrow);
	let address: string;
	let portText: string;
	if (local.startsWith('[')) {
		const close = local.indexOf(']');
		if (close === -1 || local.charAt(close + 1) !== ':') return undefined;
		address = local.slice(1, close);
		portText = local.slice(close + 2);
	} else {
		const colon = local.lastIndexOf(':');
		if (colon <= 0) return undefined;
		address = local.slice(0, colon);
		portText = local.slice(colon + 1);
	}
	if (!address || address.length > 128) return undefined;
	const port = /^\d{1,5}$/.test(portText) ? Number(portText) : undefined;
	return {
		address,
		...(port !== undefined && port <= 65_535 ? { port } : {}),
		connected: arrow !== -1,
	};
}

/** Parses `lsof -F pcnPt` output into listening sockets. */
function parseLsofListeners(
	stdout: string,
	protocol: 'tcp' | 'udp'
): ExposureListener[] | 'too-many' | undefined {
	const listeners: ExposureListener[] = [];
	let pid: number | undefined;
	let command: string | undefined;
	let family: 'ipv4' | 'ipv6' | undefined;
	for (const line of stdout.split('\n')) {
		if (!line) continue;
		const field = line.charAt(0);
		const value = line.slice(1);
		if (field === 'p') {
			const parsed = Number(value);
			if (!/^\d+$/.test(value) || !isPid(parsed)) return undefined;
			pid = parsed;
			command = undefined;
			family = undefined;
		} else if (field === 'c') {
			command = value.slice(0, 64);
		} else if (field === 'f') {
			family = undefined;
		} else if (field === 't') {
			family =
				value === 'IPv4' ? 'ipv4' : value === 'IPv6' ? 'ipv6' : undefined;
		} else if (field === 'n') {
			if (pid === undefined) return undefined;
			const socket = parseSocketName(value);
			if (!socket) return undefined;
			// A connected UDP socket only hears its peer, and `*:*` is unbound:
			// neither accepts traffic from the network.
			if (socket.connected || socket.port === undefined) continue;
			listeners.push({
				pid,
				...(command ? { command } : {}),
				protocol,
				...(family ? { family } : {}),
				address: socket.address,
				port: socket.port,
				loopback: socket.address === '127.0.0.1' || socket.address === '::1',
			});
			if (listeners.length > MAX_LISTENERS) return 'too-many';
		}
	}
	return listeners;
}

function primarySqliteCode(error: unknown): number | undefined {
	const code = (error as { errcode?: unknown } | undefined)?.errcode;
	return typeof code === 'number' && Number.isInteger(code)
		? code % 256
		: undefined;
}

function sqliteFailure(error: unknown): ProbeUnavailable {
	const code = (error as { errcode?: unknown } | undefined)?.errcode;
	const detail =
		typeof code === 'number' ? `sqlite errcode ${code}` : undefined;
	switch (primarySqliteCode(error)) {
		case 5:
		case 6:
			return unavailable('busy', detail);
		case 8:
			// SQLITE_READONLY_*: a hot journal or WAL needs a writer to recover.
			return unavailable('needs-recovery', detail);
		case 11:
		case 26:
			return unavailable('corrupt', detail);
		case 14:
			return unavailable('missing', detail);
		case 1:
			return unavailable('unexpected-schema', detail);
		default:
			return unavailable('sqlite-error', detail);
	}
}

function reservationFrom(row: unknown): PortReservation | undefined {
	if (!row || typeof row !== 'object') return undefined;
	const record = row as Record<string, unknown>;
	const stateRoot = record.state_root;
	const stackId = record.stack_id;
	const endpoint = record.endpoint;
	const port = record.port;
	if (typeof stateRoot !== 'string' || !isAbsolutePathText(stateRoot)) {
		return undefined;
	}
	if (typeof stackId !== 'string' || !STACK_ID.test(stackId)) return undefined;
	if (typeof endpoint !== 'string' || !ENDPOINT_NAME.test(endpoint)) {
		return undefined;
	}
	if (
		typeof port !== 'number' ||
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65_535
	) {
		return undefined;
	}
	return { stateRoot, stackId, endpoint, port };
}

/**
 * Builds the discovery probes. Pass `run` to substitute the command runner;
 * the default runs the fixed executables through runSimulatorCommand with
 * its curated environment.
 */
export function createSupabaseDiscovery(
	options: SupabaseDiscoveryOptions = {}
): SupabaseDiscovery {
	const runner = options.run ?? runProbe;
	// A runner that throws instead of resolving still yields a typed result.
	const run: ProbeRunner = async (request) => {
		try {
			return await runner(request);
		} catch {
			return { kind: 'error', reason: 'spawn' };
		}
	};
	const fs = options.fs ?? nodeStaticFileSystem;
	const openDatabase = options.openPortsDatabase ?? openPortsDatabaseReadOnly;
	const platform = options.platform ?? process.platform;
	const uid = options.uid ?? process.getuid?.();

	const homeDirectory = (): string | undefined => {
		if (options.homeDirectory !== undefined) return options.homeDirectory;
		try {
			return os.userInfo().homedir || undefined;
		} catch {
			return undefined;
		}
	};

	const platformGuard = (): ProbeUnavailable | undefined =>
		platform === 'darwin'
			? undefined
			: unavailable('unsupported-platform', platform);

	const ownerGuard = (): ProbeUnavailable | undefined =>
		platformGuard() ??
		(uid === undefined || !Number.isSafeInteger(uid) || uid < 0
			? unavailable('unsupported-platform', 'no uid')
			: undefined);

	/** Runs pgrep; exit 1 means nothing matched. */
	const pgrep = async (
		args: readonly string[]
	): Promise<string | ProbeUnavailable> => {
		const result = await run({ executable: PGREP, args, ...BUDGETS.pgrep });
		if (result.kind === 'error') return runFailure(result);
		if (result.exitCode === 1) return '';
		return result.exitCode === 0 ? result.stdout : commandFailed(PGREP, result);
	};

	const discoverOwners = async (): Promise<OwnerDiscoveryResult> => {
		const guard = ownerGuard();
		if (guard) return guard;
		const stdout = await pgrep(['-U', String(uid), '-lf', OWNER_MARKER]);
		if (typeof stdout !== 'string') return stdout;
		const owners: SupabaseOwnerProcess[] = [];
		const seen = new Set<number>();
		for (const line of stdout.split('\n')) {
			const owner = parseOwner(line);
			if (!owner || seen.has(owner.pid)) continue;
			seen.add(owner.pid);
			owners.push(owner);
			if (owners.length > MAX_OWNERS) return unavailable('too-many');
		}
		return { status: 'ok', owners };
	};

	const processTree = async (
		rootPid: number,
		treeOptions: { stackId?: string } = {}
	): Promise<ProcessTreeResult> => {
		const guard = ownerGuard();
		if (guard) return guard;
		const { stackId } = treeOptions;
		if (!isPid(rootPid) || (stackId !== undefined && !STACK_ID.test(stackId))) {
			return unavailable('invalid-input');
		}
		const pids = [rootPid];
		const seen = new Set(pids);
		const launcherPids: number[] = [];
		if (stackId !== undefined) {
			const stdout = await pgrep([
				'-U',
				String(uid),
				'-lf',
				`supabase-stack-id=${stackId}`,
			]);
			if (typeof stdout !== 'string') return stdout;
			for (const line of stdout.split('\n')) {
				const pid = parseLauncherPid(line, stackId);
				if (pid === undefined || seen.has(pid)) continue;
				seen.add(pid);
				pids.push(pid);
				launcherPids.push(pid);
			}
		}
		let frontier = [...pids];
		for (let depth = 0; frontier.length > 0; depth += 1) {
			if (depth >= MAX_TREE_DEPTH) return unavailable('too-many', 'depth');
			const stdout = await pgrep(['-P', frontier.join(',')]);
			if (typeof stdout !== 'string') return stdout;
			const children = parsePidLines(stdout);
			if (!children) return unavailable('unparseable', 'pgrep -P');
			frontier = children.filter((pid) => !seen.has(pid));
			for (const pid of frontier) {
				seen.add(pid);
				pids.push(pid);
			}
			if (pids.length > MAX_TREE_PIDS) return unavailable('too-many');
		}
		return { status: 'ok', rootPid, pids, launcherPids };
	};

	const readPortReservations = async (): Promise<PortReservationsResult> => {
		const home = homeDirectory();
		if (!home || !path.isAbsolute(home)) {
			return unavailable('missing', 'no passwd home');
		}
		const file = path.join(home, '.supabase', 'ports.sqlite');
		const kind = await fs.kind(file);
		if (kind === 'missing') return unavailable('missing');
		if (kind !== 'file') return unavailable('not-a-file');
		let database: PortsDatabase | undefined;
		try {
			database = openDatabase(file);
			if (!database) return unavailable('sqlite-unavailable');
			const rows = database.selectReservations();
			const reservations: PortReservation[] = [];
			let skippedRows = 0;
			for (const row of rows.slice(0, MAX_RESERVATIONS)) {
				const reservation = reservationFrom(row);
				if (reservation) reservations.push(reservation);
				else skippedRows += 1;
			}
			reservations.sort((left, right) => left.port - right.port);
			return {
				status: 'ok',
				file,
				reservations,
				skippedRows,
				truncated: rows.length > MAX_RESERVATIONS,
			};
		} catch (error) {
			return sqliteFailure(error);
		} finally {
			try {
				database?.close();
			} catch {
				// A failed close leaves nothing to release on a read-only handle.
			}
		}
	};

	const lsofListeners = async (
		list: string,
		protocol: 'tcp' | 'udp'
	): Promise<ExposureListener[] | ProbeUnavailable> => {
		const selection =
			protocol === 'tcp' ? ['-iTCP', '-sTCP:LISTEN'] : ['-iUDP'];
		const result = await run({
			executable: LSOF,
			args: ['-nP', '-w', '-a', '-p', list, ...selection, '-F', 'pcnPt'],
			...BUDGETS.lsof,
		});
		if (result.kind === 'error') return runFailure(result);
		// lsof exits 1 when nothing matched (or a pid is gone); with -w any
		// stderr then means a real error, which fails the check closed.
		if (
			result.exitCode !== 0 &&
			(result.exitCode !== 1 || result.stderr.trim() !== '')
		) {
			return commandFailed(LSOF, result);
		}
		const listeners = parseLsofListeners(result.stdout, protocol);
		if (listeners === 'too-many') return unavailable('too-many');
		return listeners ?? unavailable('unparseable', 'lsof');
	};

	const checkExposure = async (
		pids: readonly number[]
	): Promise<ExposureResult> => {
		const guard = platformGuard();
		if (guard) return guard;
		const unique = uniquePids(pids);
		if (unique === 'invalid') return unavailable('invalid-input');
		if (unique === 'too-many') return unavailable('too-many');
		const list = unique.join(',');
		const [tcp, udp] = await Promise.all([
			lsofListeners(list, 'tcp'),
			lsofListeners(list, 'udp'),
		]);
		if (!Array.isArray(tcp)) return tcp;
		if (!Array.isArray(udp)) return udp;
		const listeners = [...tcp, ...udp];
		return {
			status: 'ok',
			pids: unique,
			listeners,
			nonLoopback: listeners.filter((listener) => !listener.loopback),
		};
	};

	const readSysvCapacity = async (): Promise<SysvCapacityResult> => {
		const guard = platformGuard();
		if (guard) return guard;
		const limit = await run({
			executable: SYSCTL,
			args: ['-n', 'kern.sysv.shmmni'],
			...BUDGETS.sysctl,
		});
		if (limit.kind === 'error') return runFailure(limit);
		if (limit.exitCode !== 0) return commandFailed(SYSCTL, limit);
		const match = /^\s*(\d{1,9})\s*$/.exec(limit.stdout);
		if (!match) return unavailable('unparseable', 'sysctl');
		const shmmni = Number(match[1]);
		const listing = await run({
			executable: IPCS,
			args: ['-m'],
			...BUDGETS.ipcs,
		});
		let segments: Extract<SysvCapacityResult, { status: 'ok' }>['segments'];
		if (listing.kind === 'error') {
			segments = runFailure(listing);
		} else if (listing.exitCode !== 0) {
			segments = commandFailed(IPCS, listing);
		} else {
			const used = listing.stdout
				.split('\n')
				.filter((line) => /^m\s+\d+\s/.test(line)).length;
			segments = { status: 'ok', used, free: Math.max(0, shmmni - used) };
		}
		return { status: 'ok', shmmni, segments };
	};

	const measureDisk = async (
		paths: readonly string[]
	): Promise<DiskUsageResult> => {
		const guard = platformGuard();
		if (guard) return guard;
		if (paths.length > MAX_DISK_PATHS) return unavailable('too-many');
		const home = homeDirectory();
		const supabaseHome =
			options.supabaseHome ?? (home ? path.join(home, '.supabase') : undefined);
		if (!supabaseHome || !path.isAbsolute(supabaseHome)) {
			return unavailable('missing', 'no SUPABASE_HOME');
		}
		const roots = await Promise.all(
			['stacks', 'cache'].map(async (name) => {
				const root = path.join(supabaseHome, name);
				return (await fs.realpath(root)) ?? root;
			})
		);
		const entries: DiskUsageEntry[] = [];
		const measured = new Map<string, number[]>();
		for (const [index, input] of paths.entries()) {
			if (!isAbsolutePathText(input)) {
				entries.push({
					path: input,
					status: 'unavailable',
					reason: 'invalid-path',
				});
				continue;
			}
			const real = await fs.realpath(input);
			if (!real) {
				entries.push({ path: input, status: 'unavailable', reason: 'missing' });
				continue;
			}
			if (
				!isAbsolutePathText(real) ||
				!roots.some((root) => isPathWithin(root, real))
			) {
				entries.push({
					path: input,
					status: 'unavailable',
					reason: 'outside-supabase-home',
				});
				continue;
			}
			entries.push({
				path: input,
				status: 'unavailable',
				reason: 'not-reported',
			});
			measured.set(real, [...(measured.get(real) ?? []), index]);
		}
		if (measured.size === 0) return { status: 'ok', entries };
		const result = await run({
			executable: DU,
			args: ['-sk', ...measured.keys()],
			...BUDGETS.du,
		});
		if (result.kind === 'error') return runFailure(result);
		// du exits non-zero when one path fails but still reports the others.
		for (const line of result.stdout.split('\n')) {
			const match = /^(\d{1,15})\t(.+)$/.exec(line);
			const kilobytes = Number(match?.[1]);
			const reported = match?.[2];
			const indexes = reported ? measured.get(reported) : undefined;
			if (!indexes || !Number.isSafeInteger(kilobytes)) continue;
			for (const index of indexes) {
				const input = paths[index];
				if (input === undefined) continue;
				entries[index] = { path: input, status: 'ok', bytes: kilobytes * 1024 };
			}
		}
		return { status: 'ok', entries };
	};

	const measureMemory = async (
		pids: readonly number[]
	): Promise<MemoryResult> => {
		const guard = platformGuard();
		if (guard) return guard;
		const unique = uniquePids(pids);
		if (unique === 'invalid') return unavailable('invalid-input');
		if (unique === 'too-many') return unavailable('too-many');
		const result = await run({
			executable: PS,
			args: ['-o', 'pid=,rss=', '-p', unique.join(',')],
			...BUDGETS.ps,
		});
		if (result.kind === 'error') return runFailure(result);
		// ps exits 1 when some of the pids are gone; the rest still print.
		if (result.exitCode !== 0 && result.exitCode !== 1) {
			return commandFailed(PS, result);
		}
		const requested = new Set(unique);
		const counted = new Set<number>();
		let kilobytes = 0;
		for (const line of result.stdout.split('\n')) {
			if (!line.trim()) continue;
			const match = /^\s*(\d{1,10})\s+(\d{1,12})\s*$/.exec(line);
			if (!match) return unavailable('unparseable', 'ps');
			const pid = Number(match[1]);
			if (!requested.has(pid) || counted.has(pid)) continue;
			counted.add(pid);
			kilobytes += Number(match[2]);
		}
		return {
			status: 'ok',
			metric: 'rss',
			bytes: kilobytes * 1024,
			processCount: counted.size,
		};
	};

	/**
	 * `ps -ww -o args=`: the binary and its arguments, space-joined, with the
	 * escapes ps's locale calls for (in the C locale, every non-ASCII byte).
	 * Compare it through supabaseArgvDigest, never as text.
	 */
	const processCommand = async (pid: number): Promise<ProcessCommandResult> => {
		const guard = platformGuard();
		if (guard) return guard;
		if (!Number.isSafeInteger(pid) || pid <= 1) {
			return unavailable('invalid-input');
		}
		const result = await run({
			executable: PS,
			args: ['-ww', '-o', 'args=', '-p', String(pid)],
			...BUDGETS.ps,
		});
		if (result.kind === 'error') return runFailure(result);
		// ps exits 1 when the pid is gone.
		if (result.exitCode === 1) return { status: 'ok', command: undefined };
		if (result.exitCode !== 0) return commandFailed(PS, result);
		const command = result.stdout.replace(/\n+$/, '');
		return { status: 'ok', command: command === '' ? undefined : command };
	};

	return {
		discoverOwners,
		processTree,
		readPortReservations,
		checkExposure,
		readSysvCapacity,
		measureDisk,
		measureMemory,
		processCommand,
	};
}

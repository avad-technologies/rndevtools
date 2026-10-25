import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentSession } from '../../shared/agent-protocol';
import type { Lane, LaneWorktree } from '../../shared/lane-protocol';
import {
	loadSupabaseCliFixture,
	realisticSecrets,
	type SupabaseCliFixtureName,
	withRealisticSecrets,
} from './cli-fixtures.test-support';
import type {
	ResolvedSupabaseCli,
	SupabaseCliResolution,
} from './cli-resolver';
import {
	type SupabaseCliDetachedHandle,
	type SupabaseCliDetachedRequest,
	type SupabaseCliRunRequest,
	SupabaseCliRunResult,
} from './cli-runner';
import { resolveSupabaseDialect, type SupabaseDialect } from './dialect';
import type { SupabaseDiscovery } from './discovery';
import type { SupabaseEngineTimers } from './engine-support';
import { readGitHead } from './git-head';
import { expectedStackId } from './identity';
import { SupabaseEngine } from './service-engine';
import type {
	SupabaseAgentPort,
	SupabaseClipboardPort,
	SupabaseDialogPort,
	SupabaseLanePort,
	SupabaseMetroRestartReason,
	SupabaseServiceDeps,
	SupabaseShellPort,
} from './service-ports';
import { supabasePlatformAvailability } from './supabase-service';

/**
 * Test support for the Supabase orchestrator: a fake CLI that keeps a stack
 * registry and answers from the recorded 2.121.0 fixtures, fake discovery
 * and resolver over the same registry, a manual clock, and fake lane, agent,
 * dialog, shell and clipboard ports. Worktrees are real temporary
 * directories (a `.git/HEAD` and `supabase/config.toml`), so detection,
 * HEAD reads and identities run the real code. Every fake counts the calls
 * that would have been a process, so a test can assert that none ran.
 */

const FAKE_CLI_BINARY =
	'/opt/example/node_modules/@supabase/cli-darwin-arm64/bin/supabase';
const FIXTURE_ID =
	'b2e7a5393a8054d7b4658b68c7c7bb12092465347f6e3fbb7afb6864534dd9e8';
const FIXTURE_ROOT = '/private/tmp/supa-spike/work/repo';
const FIXTURE_API_PORT = '26211';
const FAKE_START = Date.UTC(2026, 9, 17, 9, 0, 0);

// ---------------------------------------------------------------------------
// Clock

/** A clock tests move by hand; timers fire only inside advance(). */
export class ManualClock {
	now: number;
	#sequence = 0;
	readonly #pending = new Map<number, { at: number; callback: () => void }>();
	readonly timers: SupabaseEngineTimers;

	constructor(start = FAKE_START) {
		this.now = start;
		this.timers = {
			setTimeout: (callback, ms) => {
				this.#sequence += 1;
				this.#pending.set(this.#sequence, {
					at: this.now + Math.max(0, ms),
					callback,
				});
				return this.#sequence;
			},
			clearTimeout: (handle) => {
				if (typeof handle === 'number') this.#pending.delete(handle);
			},
		};
	}

	get pendingTimers(): number {
		return this.#pending.size;
	}

	/** Fires the next due timer at or before `until`, moving the clock to it. */
	fireNext(until: number): boolean {
		const next = [...this.#pending.entries()]
			.filter(([, timer]) => timer.at <= until)
			.sort(
				([leftId, left], [rightId, right]) =>
					left.at - right.at || leftId - rightId
			)[0];
		if (!next) return false;
		this.#pending.delete(next[0]);
		this.now = Math.max(this.now, next[1].at);
		next[1].callback();
		return true;
	}
}

/** Real time, for the few waits the job store keeps on real timers. */
function realDelay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// The fake CLI

type FakeStack = {
	id: string;
	projectRoot: string;
	branchContext: string;
	runtime: 'native' | 'docker' | 'podman';
	running: boolean;
	/** Composition members; 0 for a stack whose first start failed. */
	members: number;
	apiPort: number;
	pid: number;
	/** argv[0] of its owner. */
	executable: string;
	/** lsof sees a listener on every interface. */
	lanExposed: boolean;
	/** The next start reports the API on this port instead. */
	moveApiTo?: number;
	/** `stack status` reports config.toml no longer matching the saved stack. */
	configChanged?: boolean;
	lastExclude: readonly string[];
	lastEager: boolean;
};

type FakeCliCall = Readonly<{
	argv: readonly string[];
	binaryPath: string;
	detached: boolean;
	leasedPorts?: Readonly<Record<string, string>> | undefined;
}>;

type FakeReply = Readonly<{
	exitCode: number;
	stdout: string;
	stderr: readonly string[];
	/** The CLI printed more than the runner reads. */
	stdoutTruncated?: boolean;
}>;

type Hold = { promise: Promise<void>; release: () => void };

function hold(): Hold {
	let release: () => void = () => undefined;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

function flag(argv: readonly string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
}

function flags(argv: readonly string[], name: string): string[] {
	const values: string[] = [];
	argv.forEach((value, index) => {
		const next = argv[index + 1];
		if (value === name && next !== undefined) values.push(next);
	});
	return values;
}

/** The command words: `stack start`, `db reset`, `inspect db`. */
function commandOf(argv: readonly string[]): string {
	return argv.slice(0, 2).join(' ');
}

/** The checkout HEAD for a project that may live inside a monorepo. */
async function fakeProjectHead(projectRoot: string) {
	let current = projectRoot;
	for (let depth = 0; depth < 32; depth += 1) {
		const head = await readGitHead(current);
		if (head.status === 'ok') {
			return head;
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	throw new Error(`No git HEAD above ${projectRoot}.`);
}

/** The id the CLI gives a project root: its worktree's HEAD and the default name. */
async function fakeIdentity(projectRoot: string): Promise<string> {
	const head = await fakeProjectHead(projectRoot);
	return expectedStackId({ projectRoot, branchContext: head.branchContext });
}

/** Fixture stdout as one JSON line for a stack, with runtime-built secrets. */
function renderFixture(
	name: SupabaseCliFixtureName,
	stack: FakeStack | undefined
): string {
	const fixture = loadSupabaseCliFixture(name);
	let text = JSON.stringify(withRealisticSecrets(fixture.stdout).value);
	if (stack) {
		text = text
			.replaceAll(FIXTURE_ID, stack.id)
			.replaceAll(FIXTURE_ROOT, stack.projectRoot)
			.replaceAll('refs/heads/main', stack.branchContext)
			.replaceAll(FIXTURE_API_PORT, String(stack.apiPort));
	}
	return `${text}\n`;
}

/** A status line whose config drift says what the stack's config.toml does. */
function withConfigDrift(line: string, stack: FakeStack): string {
	if (stack.configChanged !== true) return line;
	const value = JSON.parse(line) as Record<string, unknown>;
	value.config_drift = {
		status: 'changed',
		message:
			'Project configuration differs from the saved composition members.',
		paths: ['database.config.version'],
	};
	return `${JSON.stringify(value)}\n`;
}

function fixtureReply(
	name: SupabaseCliFixtureName,
	stack?: FakeStack
): FakeReply {
	const fixture = loadSupabaseCliFixture(name);
	return {
		exitCode: fixture.exitCode,
		stdout:
			fixture.stdoutText !== undefined
				? fixture.stdoutText
				: renderFixture(name, stack),
		stderr: fixture.stderr,
	};
}

function errorReply(code: string, message: string): FakeReply {
	return {
		exitCode: 1,
		stdout: `${JSON.stringify({ _tag: 'Error', error: { code, message } })}\n`,
		stderr: [],
	};
}

/**
 * Answers every argv the service builds from a registry of stacks. Replies
 * can be queued per command (`replyNext`), and calls can be held open
 * (`hold`) to test queueing, cancellation and concurrency.
 */
class FakeSupabaseCli {
	readonly calls: FakeCliCall[] = [];
	readonly stacks = new Map<string, FakeStack>();
	readonly secrets = realisticSecrets();
	readonly #replies: { command: string; reply: FakeReply }[] = [];
	readonly #holds = new Map<string, Hold>();
	readonly #waiters: { command: string; resolve: () => void }[] = [];
	#nextPid = 41_000;
	#nextPort = 26_300;
	/** Detached calls the service interrupted. */
	readonly interrupts: string[] = [];

	/** Adds a stack as another tool would have left it. */
	addStack(
		fields: Partial<FakeStack> & Pick<FakeStack, 'id' | 'projectRoot'>
	): FakeStack {
		this.#nextPid += 1;
		this.#nextPort += 1;
		const stack: FakeStack = {
			branchContext: 'refs/heads/main',
			runtime: 'native',
			running: false,
			members: 7,
			apiPort: this.#nextPort,
			pid: this.#nextPid,
			executable: FAKE_CLI_BINARY,
			lanExposed: false,
			lastExclude: [],
			lastEager: false,
			...fields,
		};
		this.stacks.set(stack.id, stack);
		return stack;
	}

	/** Queues one reply for the next call of `command` (`stack start`). */
	replyNext(command: string, reply: FakeReply | SupabaseCliFixtureName): void {
		this.#replies.push({
			command,
			reply: typeof reply === 'string' ? fixtureReply(reply) : reply,
		});
	}

	/** A fixture's reply as the CLI would print it for one of the stacks. */
	fixtureFor(name: SupabaseCliFixtureName, stackId: string): FakeReply {
		return fixtureReply(name, this.stacks.get(stackId));
	}

	/** Holds calls of `command` open until the returned function runs. */
	hold(command: string): () => void {
		const held = hold();
		this.#holds.set(command, held);
		return () => {
			this.#holds.delete(command);
			held.release();
		};
	}

	/** Resolves once a call of `command` has been made. */
	waitForCall(command: string): Promise<void> {
		if (this.calls.some((call) => commandOf(call.argv) === command)) {
			return Promise.resolve();
		}
		return new Promise((resolve) => this.#waiters.push({ command, resolve }));
	}

	count(command?: string): number {
		return command === undefined
			? this.calls.length
			: this.calls.filter((call) => commandOf(call.argv) === command).length;
	}

	callsOf(command: string): FakeCliCall[] {
		return this.calls.filter((call) => commandOf(call.argv) === command);
	}

	running(): FakeStack[] {
		return [...this.stacks.values()].filter((stack) => stack.running);
	}

	async run(request: SupabaseCliRunRequest): Promise<SupabaseCliRunResult> {
		const reply = await this.#answer(request, false, () => false);
		return this.#result(reply, request.onStderrLine, false);
	}

	async spawnDetached(
		request: SupabaseCliDetachedRequest
	): Promise<SupabaseCliDetachedHandle> {
		this.#nextPid += 1;
		const pid = this.#nextPid;
		let interrupted = false;
		let wake: (() => void) | undefined;
		const result = (async () => {
			const reply = await this.#answer(request, true, () => interrupted, {
				onWait: (resolve) => {
					wake = resolve;
				},
			});
			return this.#result(
				interrupted
					? {
							exitCode: 130,
							stdout: '',
							stderr: ['[task] failed: Interrupted.'],
						}
					: reply,
				request.onStderrLine,
				interrupted
			);
		})();
		return {
			pid,
			progressFile: path.join(request.progressDirectory, `${pid}.log`),
			result,
			interrupt: () => {
				if (interrupted) return;
				interrupted = true;
				this.interrupts.push(commandOf(request.argv));
				wake?.();
			},
		};
	}

	#result(
		reply: FakeReply,
		onStderrLine: ((line: string) => void) | undefined,
		cancelled: boolean
	): SupabaseCliRunResult {
		for (const line of reply.stderr) onStderrLine?.(line);
		return new SupabaseCliRunResult(
			{
				exitCode: reply.exitCode,
				signal: null,
				timedOut: false,
				cancelled,
				signalsSent: cancelled ? ['SIGINT'] : [],
				stdoutBytes: Buffer.byteLength(reply.stdout, 'utf8'),
				stdoutTruncated: reply.stdoutTruncated === true,
				stderrLines: reply.stderr,
				stderrTruncated: false,
				durationMs: 1,
			},
			reply.stdout
		);
	}

	async #answer(
		request: SupabaseCliRunRequest,
		detached: boolean,
		interrupted: () => boolean,
		options: Readonly<{ onWait?: (resolve: () => void) => void }> = {}
	): Promise<FakeReply> {
		const command = commandOf(request.argv);
		this.calls.push({
			argv: request.argv,
			binaryPath: request.binaryPath,
			detached,
			...(request.environment?.leasedPorts
				? { leasedPorts: request.environment.leasedPorts }
				: {}),
		});
		for (const waiter of [...this.#waiters]) {
			if (waiter.command !== command) continue;
			this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
			waiter.resolve();
		}
		const held = this.#holds.get(command);
		if (held) {
			await new Promise<void>((resolve) => {
				options.onWait?.(resolve);
				void held.promise.then(resolve);
			});
		}
		if (interrupted()) return { exitCode: 130, stdout: '', stderr: [] };
		const queued = this.#replies.findIndex(
			(entry) => entry.command === command
		);
		if (queued >= 0) {
			const [entry] = this.#replies.splice(queued, 1);
			if (entry) return entry.reply;
		}
		return this.#default(request.argv, request.binaryPath);
	}

	async #default(
		argv: readonly string[],
		binaryPath: string
	): Promise<FakeReply> {
		const command = commandOf(argv);
		const stackId = flag(argv, '--stack-id');
		const stack = stackId === undefined ? undefined : this.stacks.get(stackId);
		switch (command) {
			case 'stack list':
				return {
					exitCode: 0,
					stdout: `${JSON.stringify({
						stacks: [...this.stacks.values()].map((entry) => ({
							id: entry.id,
							project_root: entry.projectRoot,
							name: 'default',
							branch_context: entry.branchContext,
							runtime: entry.runtime,
							owner: entry.running ? 'reachable' : 'unavailable',
						})),
						message: '',
					})}\n`,
					stderr: [],
				};
			case 'stack status':
				if (!stack) {
					return errorReply(
						'ExperimentalStackStatusError',
						`Stack ${stackId ?? ''} was not found`
					);
				}
				return {
					exitCode: 0,
					stdout: withConfigDrift(
						renderFixture(
							stack.running
								? 'status-awake'
								: stack.members === 0
									? 'status-never-started'
									: 'status-stopped',
							stack
						),
						stack
					),
					stderr: [],
				};
			case 'stack start': {
				const workdir = flag(argv, '--workdir');
				let target = stack;
				if (workdir !== undefined) {
					const id = await fakeIdentity(workdir);
					const head = await fakeProjectHead(workdir);
					target =
						this.stacks.get(id) ??
						this.addStack({
							id,
							projectRoot: workdir,
							branchContext:
								head.status === 'ok' ? head.branchContext : 'refs/heads/main',
						});
				}
				if (!target) {
					return errorReply(
						'ExperimentalStackStartError',
						`Stack ${stackId ?? ''} was not found`
					);
				}
				target.running = true;
				target.members = Math.max(target.members, 7);
				target.executable = binaryPath;
				target.lastExclude = flags(argv, '--exclude');
				target.lastEager = argv.includes('--eager');
				if (target.moveApiTo !== undefined) {
					const from = target.apiPort;
					target.apiPort = target.moveApiTo;
					delete target.moveApiTo;
					const moved = target;
					// The fixture moved the API from 26211 to 26999.
					return {
						exitCode: 0,
						stdout: renderFixture('start-endpoint-changes', undefined)
							.replaceAll(FIXTURE_ID, moved.id)
							.replaceAll('26999', String(moved.apiPort))
							.replaceAll(FIXTURE_API_PORT, String(from)),
						stderr: loadSupabaseCliFixture('start-fresh').stderr,
					};
				}
				return fixtureReply('start-fresh', target);
			}
			case 'stack stop':
				if (stack) stack.running = false;
				return fixtureReply('stop', stack);
			case 'stack restart':
				if (stack) stack.running = true;
				return fixtureReply('restart', stack);
			case 'stack destroy': {
				const ids = flags(argv, '--stack-id');
				for (const id of ids) this.stacks.delete(id);
				if (ids.length === 1) {
					return {
						exitCode: 0,
						stdout: `${JSON.stringify({ destroyed: true, id: ids[0], message: '' })}\n`,
						stderr: [],
					};
				}
				return {
					exitCode: 0,
					stdout: `${JSON.stringify({
						destroyed: true,
						stacks: ids.map((id) => ({ id })),
						message: '',
					})}\n`,
					stderr: [],
				};
			}
			case 'stack logs':
				return fixtureReply('logs', stack);
			case 'stack prepare': {
				const workdir = flag(argv, '--workdir') ?? '/';
				const id = await fakeIdentity(workdir);
				const prepared =
					this.stacks.get(id) ?? this.addStack({ id, projectRoot: workdir });
				prepared.running = true;
				prepared.executable = binaryPath;
				return fixtureReply('prepare', prepared);
			}
			case 'migration list':
				return fixtureReply('migration-list');
			case 'migration up':
				return fixtureReply('migration-up');
			case 'db reset':
				return fixtureReply('db-reset');
			case 'seed buckets':
				return fixtureReply('seed-buckets');
			case 'inspect db':
				return fixtureReply(
					argv[2] === 'table-stats' ? 'inspect-table-stats' : 'inspect-db-stats'
				);
			case 'db dump': {
				const file = flag(argv, '--file');
				if (file !== undefined) await writeFile(file, '-- schema\n');
				return fixtureReply('db-dump');
			}
			default:
				return errorReply('UnknownCommand', `Unknown command ${command}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Discovery and the resolver

/** pgrep, ps, lsof, sysctl, ipcs, du and the port registry, over the fake registry. */
class FakeDiscovery implements SupabaseDiscovery {
	readonly probes: string[] = [];
	ownersUnavailable = false;
	exposureUnavailable = false;
	/** `<SUPABASE_HOME>/stacks` as the port registry records it. */
	stateRoot = '/Users/example/.supabase/stacks';
	/** What `ps -o args=` prints per pid. */
	readonly commands = new Map<number, string>();
	readonly #cli: FakeSupabaseCli;

	constructor(cli: FakeSupabaseCli) {
		this.#cli = cli;
	}

	discoverOwners: SupabaseDiscovery['discoverOwners'] = async () => {
		this.probes.push('owners');
		if (this.ownersUnavailable) {
			return { status: 'unavailable', reason: 'command-failed' };
		}
		return {
			status: 'ok',
			owners: this.#cli.running().map((stack) => ({
				pid: stack.pid,
				executable: stack.executable,
				stackId: stack.id,
			})),
		};
	};

	processTree: SupabaseDiscovery['processTree'] = async (rootPid) => {
		this.probes.push('tree');
		return { status: 'ok', rootPid, pids: [rootPid], launcherPids: [] };
	};

	readPortReservations: SupabaseDiscovery['readPortReservations'] =
		async () => {
			this.probes.push('ports');
			return {
				status: 'ok',
				file: '/Users/example/.supabase/ports.sqlite',
				reservations: [...this.#cli.stacks.values()].map((stack) => ({
					stateRoot: this.stateRoot,
					stackId: stack.id,
					endpoint: 'api',
					port: stack.apiPort,
				})),
				skippedRows: 0,
				truncated: false,
			};
		};

	checkExposure: SupabaseDiscovery['checkExposure'] = async (pids) => {
		this.probes.push('lsof');
		if (this.exposureUnavailable) {
			return { status: 'unavailable', reason: 'command-failed' };
		}
		const listeners = pids.flatMap((pid) => {
			const stack = this.#cli.running().find((entry) => entry.pid === pid);
			if (!stack) return [];
			const address = stack.lanExposed ? '*' : '127.0.0.1';
			return [
				{
					pid,
					protocol: 'tcp' as const,
					family: 'ipv4' as const,
					address,
					port: stack.apiPort,
					loopback: !stack.lanExposed,
				},
			];
		});
		return {
			status: 'ok',
			pids: [...pids],
			listeners,
			nonLoopback: listeners.filter((listener) => !listener.loopback),
		};
	};

	readSysvCapacity: SupabaseDiscovery['readSysvCapacity'] = async () => {
		this.probes.push('sysv');
		const used = this.#cli.running().length;
		return {
			status: 'ok',
			shmmni: 32,
			segments: { status: 'ok', used, free: 32 - used },
		};
	};

	measureDisk: SupabaseDiscovery['measureDisk'] = async (paths) => {
		this.probes.push('du');
		return {
			status: 'ok',
			entries: paths.map((entry) => ({
				path: entry,
				status: 'ok' as const,
				bytes: 71 * 1024 * 1024,
			})),
		};
	};

	measureMemory: SupabaseDiscovery['measureMemory'] = async (pids) => {
		this.probes.push('rss');
		return {
			status: 'ok',
			metric: 'rss',
			bytes: 160 * 1024 * 1024 * pids.length,
			processCount: pids.length,
		};
	};

	processCommand: SupabaseDiscovery['processCommand'] = async (pid) => {
		this.probes.push('command');
		return { status: 'ok', command: this.commands.get(pid) };
	};
}

function fakeDialect(
	version: string,
	allowUnverifiedPatch: boolean
): SupabaseDialect {
	return resolveSupabaseDialect(version, { allowUnverifiedPatch });
}

export function fakeResolvedCli(
	binaryPath = FAKE_CLI_BINARY,
	version = '2.121.0',
	allowUnverifiedPatch = false
): ResolvedSupabaseCli {
	return {
		binaryPath,
		binaryDirectory: path.dirname(binaryPath),
		packageRoot: undefined,
		platformPackageRoot: path.dirname(path.dirname(binaryPath)),
		version,
		dialect: fakeDialect(version, allowUnverifiedPatch),
		fingerprint: { dev: 1, ino: 1, size: 1, mtimeMs: 1 },
	};
}

/** Resolves every worktree to one verified binary unless told otherwise. */
class FakeResolver {
	resolveCalls = 0;
	validateCalls = 0;
	/** Binaries that validate, with the version they report. */
	readonly binaries = new Map<string, string>([[FAKE_CLI_BINARY, '2.121.0']]);
	/** A worktree root's own binary, when it is not the default. */
	readonly worktreeBinaries = new Map<string, string>();
	/** Worktree roots with no CLI installed. */
	readonly missing = new Set<string>();

	async resolve(
		input: Readonly<{
			worktreeRoot: string;
			allowUnverifiedPatch?: boolean;
		}>
	): Promise<SupabaseCliResolution> {
		this.resolveCalls += 1;
		const root = path.resolve(input.worktreeRoot);
		if (this.missing.has(root)) {
			return {
				ok: false,
				reason: 'not-installed',
				message: 'the Supabase CLI is not installed',
				recovery: 'Install dependencies, then re-check.',
				path: undefined,
			};
		}
		const binary = this.worktreeBinaries.get(root) ?? FAKE_CLI_BINARY;
		const version = this.binaries.get(binary) ?? '2.121.0';
		return {
			ok: true,
			cli: fakeResolvedCli(
				binary,
				version,
				input.allowUnverifiedPatch === true
			),
		};
	}

	async validateBinary(
		input: Readonly<{ binaryPath: string; allowUnverifiedPatch?: boolean }>
	): Promise<SupabaseCliResolution> {
		this.validateCalls += 1;
		const version = this.binaries.get(input.binaryPath);
		if (version === undefined) {
			return {
				ok: false,
				reason: 'not-installed',
				message: 'the binary is gone',
				recovery: 'Install dependencies, then re-check.',
				path: input.binaryPath,
			};
		}
		return {
			ok: true,
			cli: fakeResolvedCli(
				input.binaryPath,
				version,
				input.allowUnverifiedPatch === true
			),
		};
	}
}

// ---------------------------------------------------------------------------
// Ports

class FakeLanes {
	lanes: Lane[] = [];
	worktrees: LaneWorktree[] = [];
	repositories: string[] = [];
	readonly metroRestarts: {
		laneId: string;
		reason: SupabaseMetroRestartReason;
	}[] = [];
	restartMetroImpl: (
		laneId: string,
		reason: SupabaseMetroRestartReason
	) => Promise<void> = async () => undefined;
	readonly #listeners = new Set<() => void>();

	port(): SupabaseLanePort {
		return {
			lanes: () => this.lanes,
			laneById: (laneId) => this.lanes.find((lane) => lane.id === laneId),
			worktrees: () => this.worktrees,
			repositories: () => this.repositories,
			restartMetro: (laneId, reason) => {
				this.metroRestarts.push({ laneId, reason });
				return this.restartMetroImpl(laneId, reason);
			},
			launchDeferred: async () => {},
			subscribe: (listener) => {
				this.#listeners.add(listener);
				return () => {
					this.#listeners.delete(listener);
				};
			},
		};
	}

	emit(): void {
		for (const listener of [...this.#listeners]) listener();
	}
}

class FakeAgents {
	sessions: AgentSession[] = [];
	discovery: { claude: 'ok' | 'unavailable'; codex: 'ok' | 'unavailable' } = {
		claude: 'ok',
		codex: 'ok',
	};

	port(): SupabaseAgentPort {
		return {
			sessions: () => this.sessions,
			holderLiveness: () => ({ live: true }),
			discovery: () => this.discovery,
			subscribe: () => () => undefined,
		};
	}
}

class FakeDialog {
	saveFile: string | undefined;
	openPaths: string[] = [];

	port(): SupabaseDialogPort {
		return {
			showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
			showSaveDialog: async () =>
				this.saveFile === undefined
					? { canceled: true }
					: { canceled: false, filePath: this.saveFile },
			showOpenDialog: async () =>
				this.openPaths.length === 0
					? { canceled: true, filePaths: [] }
					: { canceled: false, filePaths: this.openPaths },
		};
	}
}

class FakeShell {
	readonly opened: string[] = [];
	readonly revealed: string[] = [];

	port(): SupabaseShellPort {
		return {
			openExternal: async (url) => {
				this.opened.push(url);
			},
			showItemInFolder: (target) => {
				this.revealed.push(target);
			},
		};
	}
}

class FakeClipboard {
	text = '';

	port(): SupabaseClipboardPort {
		return {
			writeText: async (text) => {
				this.text = text;
			},
			readText: async () => this.text,
		};
	}
}

// ---------------------------------------------------------------------------
// Worktrees

type FakeWorktreeOptions = Readonly<{
	branch?: string;
	/** config.toml's text; opted in with no pinned ports by default. */
	config?: string;
	migrations?: number;
	/** A pnpm lockfile, so the runner is `pnpm exec supabase`. */
	lockfile?: boolean;
	/** An app `.env` file's text. */
	appDotenv?: string;
}>;

const OPTED_IN = '[experimental]\nstack = true\n';

async function writeWorktree(
	directory: string,
	options: FakeWorktreeOptions
): Promise<string> {
	await mkdir(path.join(directory, '.git'), { recursive: true });
	await writeFile(
		path.join(directory, '.git', 'HEAD'),
		`ref: refs/heads/${options.branch ?? 'main'}\n`
	);
	await mkdir(path.join(directory, 'supabase', 'migrations'), {
		recursive: true,
	});
	await writeFile(
		path.join(directory, 'supabase', 'config.toml'),
		options.config ?? OPTED_IN
	);
	for (let index = 0; index < (options.migrations ?? 0); index += 1) {
		await writeFile(
			path.join(
				directory,
				'supabase',
				'migrations',
				`2026101${index}000000_step.sql`
			),
			'select 1;\n'
		);
	}
	if (options.lockfile) {
		await writeFile(
			path.join(directory, 'pnpm-lock.yaml'),
			"lockfileVersion: '9.0'\n"
		);
	}
	if (options.appDotenv !== undefined) {
		await writeFile(path.join(directory, '.env'), options.appDotenv);
	}
	return realpath(directory);
}

// ---------------------------------------------------------------------------
// The harness

export type EngineHarness = Readonly<{
	engine: SupabaseEngine;
	cli: FakeSupabaseCli;
	discovery: FakeDiscovery;
	resolver: FakeResolver;
	clock: ManualClock;
	lanes: FakeLanes;
	agents: FakeAgents;
	dialog: FakeDialog;
	shell: FakeShell;
	clipboard: FakeClipboard;
	base: string;
	userData: string;
	agentDirectory: string;
	home: string;
	logs: string[];
	signals: { pid: number; signal: NodeJS.Signals }[];
	checkIgnores: string[];
	/** Pids `process.kill(pid, 0)` finds alive; none by default. */
	alivePids: Set<number>;
	/** Every call that would have been a process. */
	processCalls: () => number;
	/** A main checkout tracked by Lanes, on `main` unless told otherwise. */
	repository: (name: string, options?: FakeWorktreeOptions) => Promise<string>;
	/** A second worktree of a tracked repository. */
	worktree: (
		repositoryRoot: string,
		name: string,
		options?: FakeWorktreeOptions
	) => Promise<string>;
	checkout: (worktree: string, branch: string) => Promise<void>;
	/** The id the CLI would give this worktree's current branch. */
	identity: (worktree: string) => Promise<string>;
	enable: () => Promise<void>;
	settle: () => Promise<void>;
	/** Moves the manual clock, firing due timers and settling after each. */
	advance: (ms: number) => Promise<void>;
	/** Polls in real time until `check` holds (for work a held call blocks). */
	until: (check: () => boolean, timeoutMs?: number) => Promise<void>;
	dispose: () => Promise<void>;
}>;

type EngineHarnessOptions = Readonly<{
	enabled?: boolean;
	supported?: boolean;
	start?: boolean;
	gitIgnored?: boolean;
	memoryPressure?: 'normal' | 'warning' | 'critical' | 'unknown';
}>;

const harnesses = new Set<EngineHarness>();

/** Disposes every harness a test file created (call from afterEach). */
export async function disposeEngineHarnesses(): Promise<void> {
	const all = [...harnesses];
	harnesses.clear();
	await Promise.all(all.map((harness) => harness.dispose()));
}

export async function createEngineHarness(
	options: EngineHarnessOptions = {}
): Promise<EngineHarness> {
	const base = await realpath(
		await mkdtemp(path.join(tmpdir(), 'rndevtools-supabase-engine-'))
	);
	const userData = path.join(base, 'userData');
	const agentDirectory = path.join(userData, 'agent');
	const home = path.join(base, 'home');
	await mkdir(agentDirectory, { recursive: true, mode: 0o700 });
	await mkdir(home, { recursive: true });
	const clock = new ManualClock();
	const cli = new FakeSupabaseCli();
	const discovery = new FakeDiscovery(cli);
	discovery.stateRoot = path.join(home, '.supabase', 'stacks');
	const resolver = new FakeResolver();
	const lanes = new FakeLanes();
	const agents = new FakeAgents();
	const dialog = new FakeDialog();
	const shell = new FakeShell();
	const clipboard = new FakeClipboard();
	const logs: string[] = [];
	const signals: { pid: number; signal: NodeJS.Signals }[] = [];
	const checkIgnores: string[] = [];
	const alivePids = new Set<number>();
	let memoryProbes = 0;
	const platform = {
		platform: 'darwin',
		arch: 'arm64',
		macosVersion: options.supported === false ? '13.6.1' : '15.1.0',
	} as const;
	const deps: SupabaseServiceDeps = {
		userDataDirectory: userData,
		agentSocketDirectory: agentDirectory,
		lanes: lanes.port(),
		agents: agents.port(),
		dialog: dialog.port(),
		shell: shell.port(),
		clipboard: clipboard.port(),
		demo: false,
		platform,
		now: () => clock.now,
		log: (line) => {
			logs.push(line);
		},
	};
	const engine = new SupabaseEngine(deps, {
		platform: supabasePlatformAvailability(platform),
		runner: cli,
		resolver,
		discovery: () => discovery,
		memoryPressure: async () => {
			memoryProbes += 1;
			return options.memoryPressure ?? 'normal';
		},
		timers: clock.timers,
		signalProcess: (pid, signal) => {
			signals.push({ pid, signal });
			for (const stack of cli.stacks.values()) {
				if (stack.pid === pid) stack.running = false;
			}
		},
		processAlive: (pid) => alivePids.has(pid),
		gitCheckIgnore: async (_root, relative) => {
			checkIgnores.push(relative);
			return options.gitIgnored ?? true;
		},
		homeDirectory: home,
		pathExists: async (target) => {
			try {
				await realpath(target);
				return !target.endsWith('.sock');
			} catch {
				return false;
			}
		},
	});
	// Work waiting on the manual clock (a busy retry, an owner poll) or on a
	// held CLI call never settles on its own: settling then ends once
	// nothing has changed for `quietMs` of real time with no file request in
	// flight (Node 26 doesn't list a small write). The fakes answer at once,
	// so work that still runs waits on a file. Time this process didn't get
	// to run (a loaded machine) doesn't count: a poll that comes late counts
	// no more than one on time.
	const progress = () =>
		[
			cli.calls.length,
			discovery.probes.length,
			engine.jobStore
				.activeJobs()
				.map((job) => job.status)
				.join(','),
		].join('|');
	const filesInFlight = () =>
		process
			.getActiveResourcesInfo()
			.some((resource) =>
				/^(?:FSReq|CloseReq|FileHandleCloseReq)/.test(resource)
			);
	const settleQuietly = async (quietMs: number) => {
		let last = '';
		let quiet = 0;
		let polledAt = Date.now();
		for (;;) {
			const idle = await Promise.race([
				engine.settle().then(() => true),
				realDelay(10).then(() => false),
			]);
			if (idle) {
				await realDelay(1);
				const again = await Promise.race([
					engine.settle().then(() => true),
					realDelay(10).then(() => false),
				]);
				if (again && !filesInFlight()) return;
			}
			const now = progress();
			const elapsed = Math.min(Date.now() - polledAt, 25);
			polledAt = Date.now();
			if (now !== last || filesInFlight()) {
				last = now;
				quiet = 0;
				continue;
			}
			quiet += elapsed;
			if (quiet >= quietMs) return;
		}
	};
	const settle = () => settleQuietly(300);
	const harness: EngineHarness = {
		engine,
		cli,
		discovery,
		resolver,
		clock,
		lanes,
		agents,
		dialog,
		shell,
		clipboard,
		base,
		userData,
		agentDirectory,
		home,
		logs,
		signals,
		checkIgnores,
		alivePids,
		processCalls: () =>
			cli.calls.length +
			discovery.probes.length +
			resolver.resolveCalls +
			resolver.validateCalls +
			memoryProbes +
			checkIgnores.length,
		repository: async (name, worktreeOptions = {}) => {
			const root = await writeWorktree(path.join(base, name), worktreeOptions);
			lanes.repositories.push(root);
			lanes.worktrees.push({
				path: root,
				branch: worktreeOptions.branch ?? 'main',
				repositoryRoot: root,
				dirty: false,
			});
			return root;
		},
		worktree: async (repositoryRoot, name, worktreeOptions = {}) => {
			const root = await writeWorktree(path.join(base, name), worktreeOptions);
			lanes.worktrees.push({
				path: root,
				branch: worktreeOptions.branch ?? 'main',
				repositoryRoot,
				dirty: false,
			});
			return root;
		},
		checkout: async (worktree, branch) => {
			await writeFile(
				path.join(worktree, '.git', 'HEAD'),
				`ref: refs/heads/${branch}\n`
			);
		},
		identity: (worktree) => fakeIdentity(worktree),
		enable: async () => {
			await engine.policyStore.setEnabled(true, clock.now);
			engine.syncActivation();
			await settle();
		},
		settle,
		advance: async (ms) => {
			const until = clock.now + ms;
			while (clock.fireNext(until)) await settleQuietly(150);
			clock.now = until;
			await settle();
		},
		until: async (check, timeoutMs = 2_000) => {
			const deadline = Date.now() + timeoutMs;
			while (!check()) {
				if (Date.now() > deadline) throw new Error('Timed out waiting.');
				await realDelay(5);
			}
		},
		dispose: async () => {
			harnesses.delete(harness);
			// stop() waits for held lifecycle children on the manual clock.
			await Promise.race([engine.stop(), realDelay(2_000)]);
			await Promise.race([settle(), realDelay(2_000)]);
			await rm(base, { recursive: true, force: true, maxRetries: 5 });
		},
	};
	harnesses.add(harness);
	if (options.enabled) {
		await engine.policyStore.load();
		await engine.policyStore.setEnabled(true, clock.now);
	}
	if (options.start !== false) {
		await engine.start();
		await settle();
	}
	return harness;
}

/** A lane as Lanes stores it. */
export function fakeLane(
	fields: Partial<Lane> & Pick<Lane, 'worktreePath'>
): Lane {
	return {
		id: 'lane-11111111-2222-4333-8444-555555555555',
		branch: 'main',
		simulatorUdid: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
		environment: 'development',
		port: 8081,
		metro: 'ready',
		logPath: '/Users/example/Library/Logs/ExampleApp/metro.log',
		startedAt: FAKE_START,
		...fields,
	};
}

/** A live agent session as AgentService reports it. */
export function fakeSession(
	sessionId: string,
	cwd: string,
	kind: AgentSession['kind'] = 'claude'
): AgentSession {
	return { kind, sessionId, title: 'example', cwd };
}

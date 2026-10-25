import {
	type ChildProcess,
	type SpawnOptions,
	spawn,
} from 'node:child_process';
import { once } from 'node:events';
import { existsSync, realpathSync, statSync } from 'node:fs';
import {
	chmod,
	mkdir,
	mkdtemp,
	rename,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createMetroSupervisor,
	isLaneMetroCommand,
	laneEnvProblem,
	NotLaneMetroError,
} from './lane-metro';
import type { ToolPathResolver } from './lane-tool-path';
import {
	runSimulatorCommand,
	SimulatorCommandError,
	type SimulatorCommandOptions,
	type SimulatorCommandResult,
} from './simulator-command-runner';

/** A child that spawned: it reports 'spawn' on a later tick, as Node does. */
function runningChild(pid: number) {
	return {
		pid,
		unref: () => undefined,
		once: (_event: 'spawn', listener: () => void) => {
			queueMicrotask(listener);
		},
		on: () => undefined,
	};
}

/** Leaves PATH as the desktop inherited it, as a terminal-started desktop would. */
const inheritedToolPath: ToolPathResolver = async (inherited) => inherited;

describe('isLaneMetroCommand', () => {
	it('recognises the Metro a lane started by its --port argument, wherever the binary lives', () => {
		expect(
			isLaneMetroCommand(
				'node /Users/dev/app/node_modules/.bin/expo start --dev-client --localhost --port 8100 --max-workers 2',
				8_100
			)
		).toBe(true);
		// pnpm hoists the binary to the workspace root; the cwd is not on the command line.
		expect(
			isLaneMetroCommand(
				'node /Users/dev/monorepo/node_modules/.bin/expo start --dev-client --localhost --port 8100 --max-workers 2',
				8_100
			)
		).toBe(true);
		expect(isLaneMetroCommand('node expo start --port=8100', 8_100)).toBe(true);
	});

	it("refuses a reused PID that is not this lane's Metro", () => {
		expect(isLaneMetroCommand('node expo start --port 8101', 8_100)).toBe(
			false
		);
		expect(isLaneMetroCommand('node expo start --port 81000', 8_100)).toBe(
			false
		);
		expect(isLaneMetroCommand('/usr/bin/ssh -p 8100 host', 8_100)).toBe(false);
		expect(isLaneMetroCommand('postgres --port 8100', 8_100)).toBe(false);
		expect(isLaneMetroCommand('', 8_100)).toBe(false);
	});
});

describe('Metro launch', () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), 'rndevtools-metro-'));
		await mkdir(path.join(root, 'node_modules', '.bin'), { recursive: true });
		await writeFile(path.join(root, 'node_modules', '.bin', 'expo'), '');
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	function supervisor(
		environment: NodeJS.ProcessEnv,
		toolPath: ToolPathResolver = inheritedToolPath
	) {
		const spawned: Array<{
			command: string;
			args: readonly string[];
			options: SpawnOptions;
		}> = [];
		const metro = createMetroSupervisor({
			environment,
			toolPath,
			spawnProcess: (command, args, options) => {
				spawned.push({ command, args, options });
				return runningChild(4_242);
			},
		});
		return { metro, spawned };
	}

	function launch(
		metro: ReturnType<typeof supervisor>['metro'],
		extra: {
			metroEnv?: Record<string, string>;
			laneEnv?: Record<string, string>;
		} = {}
	) {
		return metro.start({
			worktreePath: root,
			port: 8_100,
			logPath: path.join(root, 'lane.log'),
			maxWorkers: 2,
			...extra,
		});
	}

	it('gives Metro the stripped inherited env, then metroEnv, then laneEnv, then the fixed keys', async () => {
		const { metro, spawned } = supervisor({
			PATH: '/usr/bin:/bin',
			HOME: '/Users/dev',
			NODE_OPTIONS: '--max-old-space-size=4096',
			SHARED: 'inherited',
			NODE_ENV: 'production',
			CI: '0',
			// Nothing the desktop was launched with may reach a lane's bundle
			// or point its tooling at another backend or session.
			EXPO_PUBLIC_SUPABASE_URL: 'https://example.com',
			EXPO_PUBLIC_FLAVOR: 'inherited',
			SUPABASE_ACCESS_TOKEN: 'sbp_inherited',
			SUPABASE_DB_PASSWORD: 'inherited',
			PGPASSWORD: 'inherited',
			PGHOST: 'db.example.com',
			RNDEVTOOLS_AGENT_SESSION_ID: 'session-1',
		});
		const pid = await launch(metro, {
			metroEnv: {
				SHARED: 'metro-env',
				FROM_ENVIRONMENT: '1',
				EXPO_PUBLIC_FLAVOR: 'staging',
			},
			laneEnv: {
				SHARED: 'lane-env',
				EXPO_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
				EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
				// The fixed keys win over anything a lane passes.
				CI: '0',
			},
		});
		expect(pid).toBe(4_242);
		expect(spawned).toHaveLength(1);
		expect(spawned[0]?.command).toBe(
			path.join(root, 'node_modules', '.bin', 'expo')
		);
		expect(spawned[0]?.args).toEqual([
			'start',
			'--dev-client',
			'--localhost',
			'--port',
			'8100',
			'--max-workers',
			'2',
		]);
		expect(spawned[0]?.options).toMatchObject({ cwd: root, detached: true });
		expect(spawned[0]?.options.env).toEqual({
			PATH: '/usr/bin:/bin',
			HOME: '/Users/dev',
			SHARED: 'lane-env',
			FROM_ENVIRONMENT: '1',
			EXPO_PUBLIC_FLAVOR: 'staging',
			EXPO_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
			EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
			NODE_ENV: 'development',
			RCT_METRO_PORT: '8100',
			EXPO_NO_DOTENV: '1',
			EXPO_NO_INTERACTIVE: '1',
			EXPO_NO_DEV_MENU: '1',
			NODE_OPTIONS: '--max-old-space-size=4096 --dns-result-order=ipv4first',
		});
	});

	it('strips the inherited variables even when no environment or lane adds any', async () => {
		const { metro, spawned } = supervisor({
			PATH: '/usr/bin:/bin',
			EXPO_PUBLIC_API_URL: 'https://api.example.com',
			PGUSER: 'postgres',
		});
		await launch(metro);
		expect(spawned[0]?.options.env).toEqual({
			PATH: '/usr/bin:/bin',
			NODE_ENV: 'development',
			RCT_METRO_PORT: '8100',
			EXPO_NO_DOTENV: '1',
			EXPO_NO_INTERACTIVE: '1',
			EXPO_NO_DEV_MENU: '1',
			NODE_OPTIONS: '--dns-result-order=ipv4first',
		});
	});

	it.each(['inherited', 'metroEnv', 'laneEnv', 'all'] as const)(
		'omits CI from %s so managed development lanes keep Metro watch mode',
		async (source) => {
			const { metro, spawned } = supervisor({
				PATH: '/usr/bin:/bin',
				...(source === 'inherited' || source === 'all' ? { CI: '1' } : {}),
			});
			await launch(metro, {
				...(source === 'metroEnv' || source === 'all'
					? { metroEnv: { CI: '1', EXPO_NO_INTERACTIVE: '0' } }
					: {}),
				...(source === 'laneEnv' || source === 'all'
					? { laneEnv: { CI: '1', EXPO_NO_DEV_MENU: '0', EXPO_NO_DOTENV: '0' } }
					: {}),
			});
			expect(spawned[0]?.options.env).not.toHaveProperty('CI');
			expect(spawned[0]?.options.env).toMatchObject({
				NODE_ENV: 'development',
				EXPO_NO_INTERACTIVE: '1',
				EXPO_NO_DEV_MENU: '1',
				EXPO_NO_DOTENV: '1',
			});
			expect(spawned[0]?.options).toMatchObject({
				detached: true,
				stdio: ['ignore', expect.any(Number), expect.any(Number)],
			});
		}
	);

	it.each([
		[
			'a secret-named variable',
			{
				EXPO_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiJ9.e30.c2ln',
			},
		],
		['a secret key under a neutral name', { EXPO_PUBLIC_KEY: 'sb_secret_x1' }],
		[
			'a URL that carries a password',
			{ EXPO_PUBLIC_DB: 'postgresql://postgres:hunter2@127.0.0.1:54322/db' },
		],
		[
			'a name outside the metroEnv rule',
			{ 'expo-public-url': 'http://127.0.0.1:54321' },
		],
		['an oversized value', { EXPO_PUBLIC_BLOB: 'x'.repeat(1_025) }],
	])(
		'refuses a laneEnv with %s and spawns nothing',
		async (_label, laneEnv) => {
			let toolPathAsked = false;
			const { metro, spawned } = supervisor(
				{ PATH: '/usr/bin:/bin' },
				async (inherited) => {
					toolPathAsked = true;
					return inherited;
				}
			);
			const error = await launch(metro, { laneEnv }).then(
				() => undefined,
				(caught: unknown) => caught as Error
			);
			expect(error?.message).toMatch(/lane variable/i);
			for (const value of Object.values(laneEnv)) {
				expect(error?.message).not.toContain(value);
			}
			expect(spawned).toEqual([]);
			// Not even the login shell is asked for a start that cannot happen.
			expect(toolPathAsked).toBe(false);
		}
	);

	it('gives Metro the tool PATH in place of the inherited one', async () => {
		const asked: Array<string | undefined> = [];
		const { metro, spawned } = supervisor(
			{ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/Users/dev' },
			async (inherited) => {
				asked.push(inherited);
				return `/opt/example/bin:${inherited}`;
			}
		);
		await launch(metro);
		expect(asked).toEqual(['/usr/bin:/bin:/usr/sbin:/sbin']);
		expect(spawned[0]?.options.env).toMatchObject({
			PATH: '/opt/example/bin:/usr/bin:/bin:/usr/sbin:/sbin',
			HOME: '/Users/dev',
		});
	});

	it('fails a start whose Expo CLI cannot run with the cause, leaving nothing uncaught', async () => {
		// The fixture's .bin/expo has no execute bit, so the real spawn reports
		// EACCES on the child's 'error' event after spawn() returned.
		const metro = createMetroSupervisor({
			environment: { PATH: '/usr/bin:/bin' },
			toolPath: inheritedToolPath,
		});
		await expect(launch(metro)).rejects.toThrow(
			/^Metro could not start: .*EACCES/
		);
	});
});

describe('Metro stop', () => {
	const METRO_COMMAND =
		'node /Users/dev/monorepo/node_modules/.bin/expo start --dev-client --localhost --port 8100 --max-workers 2';
	/** No lane here serves from it: another worktree's Metro works there. */
	const ELSEWHERE = os.tmpdir();
	/**
	 * The device and inode lsof prints for a directory deleted under its
	 * process, which no directory on disk has any more: a made-up pair.
	 */
	const DELETED_IDENTITY = 'D0x0\ni0\n';
	/** What a refusal may not show as it is, as UNSAFE_IN_MESSAGE names it. */
	const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;
	let root: string;
	/** A live process of the test's own, standing in for whoever has the PID. */
	let holder: ChildProcess;

	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), 'rndevtools-metro-stop-'));
		holder = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
		await once(holder, 'spawn');
	});

	afterEach(async () => {
		if (holder.exitCode === null && holder.signalCode === null) {
			holder.kill('SIGKILL');
		}
		await rm(root, { recursive: true, force: true });
	});

	/** The device and inode lines lsof prints for a cwd in `directory`. */
	function lsofIdentity(directory: string): string {
		const { dev, ino } = statSync(directory, { bigint: true });
		return `D0x${BigInt.asUintN(32, dev).toString(16)}\ni${BigInt.asUintN(64, ino)}\n`;
	}

	/**
	 * `ps` answers `command`; lsof prints `cwd`, written as lsof spells it, as
	 * the working directory, after `identity`, the device and inode lines it
	 * prints for it (see lsofIdentity), or fails when there is no `cwd`.
	 */
	function supervisor(command: string, cwd?: string, identity = '') {
		const asked: string[] = [];
		const metro = createMetroSupervisor({
			runCommand: async (executable) => {
				asked.push(executable);
				if (executable === '/bin/ps') {
					return { stdout: `${command}\n`, stderr: '', exitCode: 0 };
				}
				if (cwd !== undefined) {
					return {
						stdout: `p${holder.pid}\nfcwd\n${identity}n${cwd}\n`,
						stderr: '',
						exitCode: 0,
					};
				}
				throw new SimulatorCommandError('lsof failed with exit code 1.', {
					kind: 'failed',
					exitCode: 1,
				});
			},
		});
		return { metro, asked, pid: holder.pid as number };
	}

	/**
	 * The refusal to stop a Metro serving from another directory, whose cwd
	 * lsof prints as `printed` under the real root, for a lane whose app
	 * directory <root>/app exists: a plain error, with nothing signalled.
	 */
	async function refusalFor(printed: string): Promise<string> {
		const appDirectory = path.join(root, 'app');
		await mkdir(appDirectory);
		const { metro, pid } = supervisor(
			METRO_COMMAND,
			`${realpathSync(root)}/${printed}`,
			lsofIdentity(ELSEWHERE)
		);
		const error = await metro.stop(pid, 8_100, appDirectory).then(
			() => undefined,
			(caught: unknown) => caught
		);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(NotLaneMetroError);
		expect(metro.isProcessRunning(pid)).toBe(true);
		return (error as Error).message;
	}

	it("signals the lane's own Metro: its port on the command line, its app directory as its cwd", async () => {
		// lsof reports the directory with symlinks resolved (/var is /private/var).
		const { metro, pid } = supervisor(
			METRO_COMMAND,
			realpathSync(root),
			lsofIdentity(root)
		);
		const exited = once(holder, 'exit');
		await metro.stop(pid, 8_100, root);
		expect((await exited)[1]).toBe('SIGTERM');
	});

	it("signals the lane's own Metro through an app directory that is a symlink", async () => {
		// stat(2) follows the symlink, as the kernel did to give Metro its
		// working directory, which lsof reports as the symlink's target.
		const target = path.join(root, 'checkout');
		const appDirectory = path.join(root, 'app');
		await mkdir(target);
		await symlink(target, appDirectory);
		const { metro, pid } = supervisor(
			METRO_COMMAND,
			realpathSync(target),
			lsofIdentity(target)
		);
		const exited = once(holder, 'exit');
		await metro.stop(pid, 8_100, appDirectory);
		expect((await exited)[1]).toBe('SIGTERM');
	});

	// Of what lsof prints here, only the working directory's name depends on
	// its locale (see processCwd). ps and the listening-socket lsof run as
	// they always did.
	it('runs the working-directory lsof in the C locale, and no other command', async () => {
		const pid = holder.pid as number;
		const calls: Array<[string, SimulatorCommandOptions | undefined]> = [];
		const metro = createMetroSupervisor({
			probe: async () => ({
				ok: true,
				text: async () => 'packager-status:running',
			}),
			runCommand: async (executable, args, options) => {
				calls.push([[executable, ...args].join(' '), options]);
				let stdout = `p${pid}\nf23\n`;
				if (executable === '/bin/ps') stdout = `${METRO_COMMAND}\n`;
				else if (args.includes('cwd')) {
					stdout = `p${pid}\nfcwd\n${lsofIdentity(root)}n${realpathSync(root)}\n`;
				}
				return { stdout, stderr: '', exitCode: 0 };
			},
		});
		expect(await metro.isHealthy(8_100, pid)).toBe(true);
		const exited = once(holder, 'exit');
		await metro.stop(pid, 8_100, root);
		expect((await exited)[1]).toBe('SIGTERM');
		const bounds = { timeoutMs: 3_000, maxOutputBytes: 64 * 1024 };
		expect(calls).toEqual([
			[`/usr/sbin/lsof -a -p ${pid} -iTCP:8100 -sTCP:LISTEN -n -P -Fp`, bounds],
			[
				`/bin/ps -p ${pid} -o command=`,
				{ timeoutMs: 5_000, maxOutputBytes: 64 * 1024 },
			],
			[
				`/usr/sbin/lsof -a -p ${pid} -d cwd -FDin`,
				{ ...bounds, environment: { LC_ALL: 'C' } },
			],
		]);
	});

	it("refuses an Expo on the lane's port serving from elsewhere, failing closed and signalling nothing", async () => {
		const { metro, pid } = supervisor(
			METRO_COMMAND,
			'/Users/dev/app-feature-b',
			lsofIdentity(ELSEWHERE)
		);
		const error = await metro.stop(pid, 8_100, root).then(
			() => undefined,
			(caught: unknown) => caught
		);
		// Another worktree's Metro, or this lane's own: no proof the lane's is gone.
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(NotLaneMetroError);
		expect((error as Error).message).toContain(
			'serving from /Users/dev/app-feature-b'
		);
		expect(metro.isProcessRunning(pid)).toBe(true);
	});

	it("refuses a directory on another device that has the app directory's inode", async () => {
		// Each volume numbers its own inodes: every APFS volume's root is inode 2.
		const { dev, ino } = statSync(root, { bigint: true });
		const { metro, pid } = supervisor(
			METRO_COMMAND,
			'/Volumes/Other/app',
			`D0x${(BigInt.asUintN(32, dev) ^ 1n).toString(16)}\ni${ino}\n`
		);
		const error = await metro.stop(pid, 8_100, root).then(
			() => undefined,
			(caught: unknown) => caught
		);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(NotLaneMetroError);
		expect((error as Error).message).toContain(
			'serving from /Volumes/Other/app, not'
		);
		expect(metro.isProcessRunning(pid)).toBe(true);
	});

	// Another worktree's directory beside the lane's, or one inside it: lsof's
	// path begins with the lane's, but is not it.
	it.each(['app-feature', 'app/ios'])(
		"refuses an Expo serving from %s, whose path merely starts with the lane's",
		async (other) => {
			expect(await refusalFor(other)).toContain(
				`serving from ${realpathSync(root)}/${other}, not`
			);
		}
	);

	it('keeps refusing once the worktree moved under the running Metro, never reading it as gone', async () => {
		const appDirectory = path.join(root, 'app');
		const moved = path.join(root, 'app-renamed');
		await mkdir(appDirectory);
		await rename(appDirectory, moved);
		// lsof reports a moved working directory under its new path.
		const { metro, pid } = supervisor(
			METRO_COMMAND,
			realpathSync(moved),
			lsofIdentity(moved)
		);
		const error = await metro.stop(pid, 8_100, appDirectory).then(
			() => undefined,
			(caught: unknown) => caught
		);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(NotLaneMetroError);
		expect((error as Error).message).toContain(realpathSync(moved));
		expect((error as Error).message).toMatch(/moved or renamed/);
		expect(metro.isProcessRunning(pid)).toBe(true);
	});

	it.each([
		['the device and inode it had', DELETED_IDENTITY],
		['no device or inode', ''],
	])(
		"signals the lane's own Metro after its app directory was deleted under it, lsof printing %s",
		async (_identity, identity) => {
			// lsof keeps printing a working directory deleted under the process,
			// and stat(2) then fails with ENOENT, leaving no device and inode to
			// compare: only the app directory as given can match. It is given
			// resolved, as lsof prints it, and does not exist.
			const appDirectory = path.join(realpathSync(root), 'gone');
			const { metro, pid } = supervisor(METRO_COMMAND, appDirectory, identity);
			const exited = once(holder, 'exit');
			await metro.stop(pid, 8_100, appDirectory);
			expect((await exited)[1]).toBe('SIGTERM');
		}
	);

	it('refuses a reused PID that is no Metro at all without asking lsof', async () => {
		const { metro, asked, pid } = supervisor('/bin/sleep 30');
		await expect(metro.stop(pid, 8_100, root)).rejects.toBeInstanceOf(
			NotLaneMetroError
		);
		expect(asked).toEqual(['/bin/ps']);
		expect(metro.isProcessRunning(pid)).toBe(true);
	});

	it('fails closed when the process cannot be inspected', async () => {
		const { metro, pid } = supervisor(METRO_COMMAND);
		const error = await metro.stop(pid, 8_100, root).then(
			() => undefined,
			(caught: unknown) => caught
		);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(NotLaneMetroError);
		expect((error as Error).message).toMatch(/^Could not inspect process/);
		expect(metro.isProcessRunning(pid)).toBe(true);
	});

	it('has nothing to stop once the process exited while it was inspected', async () => {
		const pid = holder.pid as number;
		const metro = createMetroSupervisor({
			runCommand: async () => {
				holder.kill('SIGKILL');
				await once(holder, 'exit');
				throw new SimulatorCommandError('ps failed with exit code 1.', {
					kind: 'failed',
					exitCode: 1,
				});
			},
		});
		await expect(metro.stop(pid, 8_100, root)).resolves.toBeUndefined();
	});

	// Reports lsof 4.91 does not print. Each names the lane's own app
	// directory, so reading one loosely would signal its Metro.
	it.each([
		[
			'no device or inode',
			(report: string) => report.replace(/^[Di].*\n/gm, ''),
		],
		['no inode', (report: string) => report.replace(/^i.*\n/m, '')],
		['no device', (report: string) => report.replace(/^D.*\n/m, '')],
		[
			'its device in decimal',
			(report: string) =>
				report.replace(
					/^D0x([0-9a-f]+)$/m,
					(_line, hex: string) => `D${BigInt(`0x${hex}`)}`
				),
		],
		[
			"another process's number",
			(report: string) => report.replace(/^p\d+/, 'p1'),
		],
		['a second working directory', (report: string) => `${report}fcwd\nn/\n`],
	])(
		'fails closed on a working directory lsof reports with %s',
		async (_label, mangle) => {
			const pid = holder.pid as number;
			const report = mangle(
				`p${pid}\nfcwd\n${lsofIdentity(root)}n${realpathSync(root)}\n`
			);
			const metro = createMetroSupervisor({
				runCommand: async (executable) => ({
					stdout: executable === '/bin/ps' ? `${METRO_COMMAND}\n` : report,
					stderr: '',
					exitCode: 0,
				}),
			});
			const error = await metro.stop(pid, 8_100, root).then(
				() => undefined,
				(caught: unknown) => caught
			);
			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(NotLaneMetroError);
			expect((error as Error).message).toMatch(/^Could not inspect process/);
			expect(metro.isProcessRunning(pid)).toBe(true);
		}
	);

	it.skipIf(process.getuid?.() === 0)(
		'fails closed when the app directory cannot be checked, never reading it as gone',
		async () => {
			const locked = path.join(realpathSync(root), 'locked');
			const appDirectory = path.join(locked, 'app');
			await mkdir(appDirectory, { recursive: true });
			const { metro, pid } = supervisor(
				METRO_COMMAND,
				appDirectory,
				lsofIdentity(appDirectory)
			);
			// stat(2) of the app directory now fails with EACCES, not ENOENT.
			await chmod(locked, 0o000);
			try {
				const error = await metro.stop(pid, 8_100, appDirectory).then(
					() => undefined,
					(caught: unknown) => caught
				);
				expect(error).toBeInstanceOf(Error);
				expect(error).not.toBeInstanceOf(NotLaneMetroError);
				expect((error as Error).message).toMatch(
					/^Could not inspect process \d+ to confirm it is this lane's Metro \(EACCES/
				);
				expect(metro.isProcessRunning(pid)).toBe(true);
			} finally {
				await chmod(locked, 0o755);
			}
		}
	);

	// lsof prints the byte 0x01 as ^A, as it prints a caret and an A, and
	// U+001C and a tab as ^\\t, as it prints a caret, a backslash and a t. An
	// app directory deleted and made again under its running Metro leaves that
	// Metro in the old directory, which lsof prints under the same path.
	it.each([
		['a control byte where the lane has a caret', 'a^Ab', 'a\u0001b', 'a^Ab'],
		[
			'U+001C and a tab where the lane has a caret, a backslash and a t',
			'a^\\t',
			'a\u001c\t',
			String.raw`a^\\t`,
		],
		['the app directory made again', 'app', undefined, 'app'],
	])(
		"refuses a Metro in another directory that lsof prints like the lane's: %s",
		async (_label, lane, other, printed) => {
			await mkdir(path.join(root, lane));
			let identity = DELETED_IDENTITY;
			if (other !== undefined) {
				await mkdir(path.join(root, other));
				identity = lsofIdentity(path.join(root, other));
			}
			const { metro, pid } = supervisor(
				METRO_COMMAND,
				`${realpathSync(root)}/${printed}`,
				identity
			);
			// The app directory given as lsof prints it, and through /var's symlink.
			for (const parent of [realpathSync(root), root]) {
				const appDirectory = path.join(parent, lane);
				const error = await metro.stop(pid, 8_100, appDirectory).then(
					() => undefined,
					(caught: unknown) => caught
				);
				expect(error).toBeInstanceOf(Error);
				expect(error).not.toBeInstanceOf(NotLaneMetroError);
				// Its backslash shows doubled, as lsof prints it.
				expect((error as Error).message).toContain(
					`serving from another directory than this lane's ${appDirectory.replaceAll('\\', '\\\\')}, though lsof prints its path the same; refusing to stop it. If the app directory was recreated`
				);
				expect(metro.isProcessRunning(pid)).toBe(true);
			}
		}
	);

	// Once the app directory is gone, only lsof's path is left to go by, and
	// lsof prints each of these as it prints another path (see above).
	it.each([
		['a caret and an A', 'a^Ab', 'a^Ab'],
		['an escape character', 'a\u001bb', 'a^[b'],
		['U+001C before a tab', 'a\u001c\t', String.raw`a^\\t`],
	])(
		'fails closed on a deleted app directory whose path holds %s',
		async (_label, name, printed) => {
			const { metro, pid } = supervisor(
				METRO_COMMAND,
				`${realpathSync(root)}/${printed}`,
				DELETED_IDENTITY
			);
			const error = await metro
				.stop(pid, 8_100, path.join(realpathSync(root), name))
				.then(
					() => undefined,
					(caught: unknown) => caught
				);
			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(NotLaneMetroError);
			expect((error as Error).message).toMatch(
				/^Could not inspect process \d+ to confirm it is this lane's Metro \(the app directory is gone/
			);
			expect(metro.isProcessRunning(pid)).toBe(true);
		}
	);

	// What lsof 4.91 printed for these directories, in the C locale processCwd
	// runs it in, and with LANG=en_US.UTF-8, which still escapes a character
	// it cannot print, such as a soft hyphen.
	// An app directory that exists matches by device and inode whatever lsof
	// prints, so these are deleted: only the path lsof printed can match them.
	it.each([
		['À faire', 'the C locale', String.raw`\xc3\x80 faire`],
		['À faire', 'a UTF-8 locale', 'À faire'],
		[
			'Разработка',
			'the C locale',
			String.raw`\xd0\xa0\xd0\xb0\xd0\xb7\xd1\x80\xd0\xb0\xd0\xb1\xd0\xbe\xd1\x82\xd0\xba\xd0\xb0`,
		],
		['Разработка', 'a UTF-8 locale', 'Разработка'],
		[
			'Раз\u00adработка',
			'the C locale',
			String.raw`\xd0\xa0\xd0\xb0\xd0\xb7\xc2\xad\xd1\x80\xd0\xb0\xd0\xb1\xd0\xbe\xd1\x82\xd0\xba\xd0\xb0`,
		],
		['Раз\u00adработка', 'a UTF-8 locale', String.raw`Раз\xc2\xadработка`],
	])(
		"signals the lane's own Metro after %s was deleted, its cwd as lsof prints it in %s",
		async (name, _locale, printed) => {
			const { metro, pid } = supervisor(
				METRO_COMMAND,
				`${realpathSync(root)}/${printed}`,
				DELETED_IDENTITY
			);
			const exited = once(holder, 'exit');
			await metro.stop(pid, 8_100, path.join(realpathSync(root), name));
			expect((await exited)[1]).toBe('SIGTERM');
		}
	);

	it("reads a backslash and control bytes in a deleted app directory's path as lsof prints them", async () => {
		// A backslash, the five control bytes lsof names (\b \t \n \f \r) and
		// DEL. lsof doubles the backslash.
		const appDirectory = path.join(
			realpathSync(root),
			'back\\slash \b\t\n\f\r\x7f'
		);
		const { metro, pid } = supervisor(
			METRO_COMMAND,
			`${realpathSync(root)}/${String.raw`back\\slash \b\t\n\f\r\x7f`}`,
			DELETED_IDENTITY
		);
		const exited = once(holder, 'exit');
		await metro.stop(pid, 8_100, appDirectory);
		expect((await exited)[1]).toBe('SIGTERM');
	});

	it('matches an app directory given in another Unicode normalization than the disk holds', async () => {
		const onDisk = path.join(root, 'À faire'.normalize('NFC'));
		await mkdir(onDisk);
		// lsof spells the name as the disk stores it, and stat(2) finds the
		// directory in either normalization.
		const { metro, pid } = supervisor(
			METRO_COMMAND,
			`${realpathSync(root)}/${String.raw`\xc3\x80 faire`}`,
			lsofIdentity(onDisk)
		);
		const exited = once(holder, 'exit');
		await metro.stop(pid, 8_100, path.join(root, 'À faire'.normalize('NFD')));
		expect((await exited)[1]).toBe('SIGTERM');
	});

	it("refuses a directory whose name only spells out the escapes of the lane's", async () => {
		// The lane's app directory is gone, so only lsof's path is compared.
		const appDirectory = path.join(realpathSync(root), 'À faire');
		// lsof doubles a backslash: this directory is named `\xc3\x80 faire`.
		const other = path.join(root, String.raw`\xc3\x80 faire`);
		await mkdir(other);
		const { metro, pid } = supervisor(
			METRO_COMMAND,
			`${realpathSync(root)}/${String.raw`\\xc3\\x80 faire`}`,
			lsofIdentity(other)
		);
		const error = await metro.stop(pid, 8_100, appDirectory).then(
			() => undefined,
			(caught: unknown) => caught
		);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(NotLaneMetroError);
		// Shown doubled, as lsof prints it, every backslash starts an escape.
		expect((error as Error).message).toContain(
			String.raw`serving from ${realpathSync(root)}/\\xc3\\x80 faire, not`
		);
		expect(metro.isProcessRunning(pid)).toBe(true);
	});

	// The lane's own path shows in the same escapes as the one lsof printed,
	// so a lane named with the escapes lsof prints for another directory's
	// name reads apart from it, and an invisible character in it shows too.
	it.each([
		[
			'a lane named with the escapes of a zero-width no-break space',
			String.raw`a\xef\xbb\xbfpp`,
			'a\ufeffpp',
			String.raw`a\xef\xbb\xbfpp`,
			String.raw`a\\xef\\xbb\\xbfpp`,
		],
		[
			'a lane named with a zero-width no-break space',
			'a\ufeffpp',
			String.raw`a\xef\xbb\xbfpp`,
			String.raw`a\\xef\\xbb\\xbfpp`,
			String.raw`a\xef\xbb\xbfpp`,
		],
		[
			'a lane named with the escape of a tab',
			String.raw`a\tb`,
			'a\tb',
			String.raw`a\tb`,
			String.raw`a\\tb`,
		],
	])(
		'shows the two paths of a refusal apart for %s',
		async (_label, lane, other, printed, shownLane) => {
			const appDirectory = path.join(realpathSync(root), lane);
			await mkdir(appDirectory);
			await mkdir(path.join(root, other));
			const { metro, pid } = supervisor(
				METRO_COMMAND,
				`${realpathSync(root)}/${printed}`,
				lsofIdentity(path.join(root, other))
			);
			const error = await metro.stop(pid, 8_100, appDirectory).then(
				() => undefined,
				(caught: unknown) => caught
			);
			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(NotLaneMetroError);
			expect((error as Error).message).toContain(
				`serving from ${realpathSync(root)}/${printed}, not from this lane's ${realpathSync(root)}/${shownLane};`
			);
			expect((error as Error).message).not.toMatch(UNSAFE);
			expect(metro.isProcessRunning(pid)).toBe(true);
		}
	);

	it('names the directory a refused Metro serves from as it is, not in escapes', async () => {
		const appDirectory = path.join(root, 'Разработка');
		const moved = path.join(root, 'Разработка-old');
		await mkdir(appDirectory);
		await rename(appDirectory, moved);
		const { metro, pid } = supervisor(
			METRO_COMMAND,
			`${realpathSync(root)}/${String.raw`\xd0\xa0\xd0\xb0\xd0\xb7\xd1\x80\xd0\xb0\xd0\xb1\xd0\xbe\xd1\x82\xd0\xba\xd0\xb0-old`}`,
			lsofIdentity(moved)
		);
		const error = await metro.stop(pid, 8_100, appDirectory).then(
			() => undefined,
			(caught: unknown) => caught
		);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(NotLaneMetroError);
		expect((error as Error).message).toContain(
			`serving from ${realpathSync(moved)}, not from this lane's ${appDirectory};`
		);
		expect(metro.isProcessRunning(pid)).toBe(true);
	});

	// What lsof 4.91 printed for these names in the C locale and in the UTF-8
	// locales measured (en_US, ru_RU, ja_JP and C.UTF-8). Both escape these
	// controls and format characters. Of the two, only the C locale escapes
	// the separators and the other default-ignorables (see the next test), and
	// every other non-ASCII byte too, so the letters and the override form one
	// run of escapes.
	it.each([
		[
			'a right-to-left override',
			'the C and UTF-8 locales',
			String.raw`evil\xe2\x80\xaetxt.app`,
		],
		[
			'a right-to-left override among letters',
			'a UTF-8 locale',
			String.raw`Раз\xe2\x80\xaeработка`,
		],
		[
			'a right-to-left override among letters',
			'the C locale',
			String.raw`\xd0\xa0\xd0\xb0\xd0\xb7\xe2\x80\xae\xd1\x80\xd0\xb0\xd0\xb1\xd0\xbe\xd1\x82\xd0\xba\xd0\xb0`,
		],
		[
			'bidi isolates',
			'the C and UTF-8 locales',
			String.raw`a\xe2\x81\xa6b\xe2\x81\xa9c`,
		],
		[
			'a zero-width space',
			'the C and UTF-8 locales',
			String.raw`zw\xe2\x80\x8bsp`,
		],
		[
			'C1 controls',
			'the C and UTF-8 locales',
			String.raw`ne\xc2\x85l c1\xc2\x9b31m`,
		],
		// A format character that is not also a default-ignorable.
		[
			'an interlinear annotation anchor',
			'the C and UTF-8 locales',
			String.raw`app\xef\xbf\xb9`,
		],
		// Read back with its leading U+FEFF dropped, a run shows app or Раз.
		[
			'a zero-width no-break space',
			'the C and UTF-8 locales',
			String.raw`a\xef\xbb\xbfpp`,
		],
		[
			'a zero-width no-break space before letters',
			'a UTF-8 locale',
			String.raw`\xef\xbb\xbfРаз`,
		],
		[
			'a zero-width no-break space before letters',
			'the C locale',
			String.raw`\xef\xbb\xbf\xd0\xa0\xd0\xb0\xd0\xb7`,
		],
		[
			'line and paragraph separators',
			'the C locale',
			String.raw`ls\xe2\x80\xa8x ps\xe2\x80\xa9x`,
		],
		// Read back, each of these siblings of the lane's app shows as app.
		['a combining grapheme joiner', 'the C locale', String.raw`app\xcd\x8f`],
		['a Hangul filler', 'the C locale', String.raw`app\xe3\x85\xa4`],
		['a variation selector', 'the C locale', String.raw`app\xf3\xa0\x84\x80`],
		// With lsof's doubled backslash shown single, both read a^\t.
		['U+001C and a tab', 'the C and UTF-8 locales', String.raw`a^\\t`],
		['a caret and a tab', 'the C and UTF-8 locales', String.raw`a^\t`],
		// lsof printed the byte before this one raw, which the runner read
		// back as U+FFFD. Decoded on its own, the \x80 would read as U+FFFD too,
		// as a sibling app<U+0081> does.
		[
			'a byte that is no character of its own',
			'fr_FR.ISO8859-1',
			`app\ufffd${String.raw`\x80`}`,
		],
	])(
		"keeps %s escaped in a refused Metro's path as lsof prints it in %s",
		async (_label, _locale, printed) => {
			const message = await refusalFor(printed);
			expect(message).toContain(
				`serving from ${realpathSync(root)}/${printed}, not`
			);
			expect(message).not.toMatch(UNSAFE);
		}
	);

	// What lsof 4.91 printed raw. A UTF-8 locale prints the separators and the
	// other default-ignorables as they are. A single-byte locale prints each
	// byte of some characters as a letter of its own, which the runner's UTF-8
	// decoding turns back into the character: ru_RU.CP866 does so for a
	// right-to-left override, ru_RU.ISO8859-5 for an interlinear annotation
	// anchor, and kk_KZ.PT154 for C1 controls. The message escapes them as the
	// C locale does.
	it.each([
		[
			'the line and paragraph separators',
			'a UTF-8 locale',
			'ls\u2028x ps\u2029x',
			String.raw`ls\xe2\x80\xa8x ps\xe2\x80\xa9x`,
		],
		[
			'C1 controls',
			'kk_KZ.PT154',
			'ne\u0085l c1\u009b31m',
			String.raw`ne\xc2\x85l c1\xc2\x9b31m`,
		],
		[
			'a right-to-left override',
			'ru_RU.CP866',
			'app\u202etxt.exe',
			String.raw`app\xe2\x80\xaetxt.exe`,
		],
		[
			'an interlinear annotation anchor',
			'ru_RU.ISO8859-5',
			'app\ufff9',
			String.raw`app\xef\xbf\xb9`,
		],
		[
			'a combining grapheme joiner',
			'a UTF-8 locale',
			'app\u034f',
			String.raw`app\xcd\x8f`,
		],
		[
			'a Hangul filler',
			'a UTF-8 locale',
			'app\u3164',
			String.raw`app\xe3\x85\xa4`,
		],
		[
			'a variation selector',
			'a UTF-8 locale',
			'app\u{e0100}',
			String.raw`app\xf3\xa0\x84\x80`,
		],
	])(
		'escapes %s, which lsof prints raw in %s',
		async (_label, _locale, printed, shown) => {
			const message = await refusalFor(printed);
			expect(message).toContain(
				`serving from ${realpathSync(root)}/${shown}, not`
			);
			expect(message).not.toMatch(UNSAFE);
		}
	);

	// lsof's ^\ for U+001C ends in a backslash. Read as one escape, it leaves
	// the next \x, after any doubled backslashes, to start a run of bytes,
	// while a caret before a doubled backslash is a caret of its own. Each
	// reads the same in both locales.
	it.each([
		[
			'U+001C between letters',
			'the C locale',
			String.raw`\xd0\xa0^\\xd0\xb0`,
			String.raw`Р^\а`,
		],
		[
			'U+001C between letters',
			'a UTF-8 locale',
			String.raw`Р^\а`,
			String.raw`Р^\а`,
		],
		[
			'a caret and a backslash before a letter',
			'the C locale',
			String.raw`^\\\xd0\xb0`,
			String.raw`^\\а`,
		],
		[
			'a caret and a backslash before a letter',
			'a UTF-8 locale',
			String.raw`^\\а`,
			String.raw`^\\а`,
		],
		[
			'U+001C and two backslashes before a letter',
			'the C locale',
			String.raw`^\\\\\\xd0\xb0`,
			String.raw`^\\\\\а`,
		],
		[
			'U+001C and two backslashes before a letter',
			'a UTF-8 locale',
			String.raw`^\\\\\а`,
			String.raw`^\\\\\а`,
		],
	])(
		"reads %s back from lsof's escapes in a refused Metro's path in %s",
		async (_label, _locale, printed, shown) => {
			const message = await refusalFor(printed);
			expect(message).toContain(
				`serving from ${realpathSync(root)}/${shown}, not`
			);
			expect(message).not.toMatch(UNSAFE);
		}
	);

	describe.runIf(process.platform === 'darwin')('with the real lsof', () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		// Only ps is answered: lsof runs for real, through the runner.
		const metro = createMetroSupervisor({
			runCommand: (executable, args, options) =>
				executable === '/bin/ps'
					? Promise.resolve({
							stdout: `${METRO_COMMAND}\n`,
							stderr: '',
							exitCode: 0,
						})
					: runSimulatorCommand(executable, args, options),
		});

		/**
		 * Runs `check` on a stand-in Metro working in `directory`, then kills
		 * whatever is left of it.
		 */
		async function withMetroIn(
			directory: string,
			check: (standIn: ChildProcess, pid: number) => Promise<void>
		): Promise<void> {
			const standIn = spawn('/bin/sleep', ['30'], {
				cwd: directory,
				detached: true,
				stdio: 'ignore',
			});
			await once(standIn, 'spawn');
			try {
				await check(standIn, standIn.pid as number);
			} finally {
				if (standIn.exitCode === null && standIn.signalCode === null) {
					standIn.kill('SIGKILL');
				}
			}
		}

		/** Stopping `pid` for `appDirectory` refuses with a plain error. */
		async function expectRefusal(
			pid: number,
			appDirectory: string,
			message: string
		): Promise<void> {
			const error = await metro.stop(pid, 8_100, appDirectory).then(
				() => undefined,
				(caught: unknown) => caught
			);
			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(NotLaneMetroError);
			expect((error as Error).message).toContain(message);
			expect(metro.isProcessRunning(pid)).toBe(true);
		}

		// lsof runs in the C locale whatever the desktop's own: none when it
		// was launched from the Dock or Finder, or its terminal's.
		it.each([
			['the C locale', undefined],
			['a UTF-8 locale', 'en_US.UTF-8'],
		])(
			"signals the lane's own Metro in non-ASCII worktrees with the desktop in %s",
			async (_locale, lang) => {
				vi.stubEnv('LANG', lang);
				vi.stubEnv('LC_ALL', undefined);
				for (const name of ['À faire', 'Разработка']) {
					const appDirectory = path.join(root, name);
					await mkdir(appDirectory);
					await withMetroIn(appDirectory, async (lanesMetro, pid) => {
						const exited = once(lanesMetro, 'exit');
						await metro.stop(pid, 8_100, appDirectory);
						expect((await exited)[1]).toBe('SIGTERM');
					});
				}
			}
		);

		// lsof prints both directories as a^Ab: a caret and an A, or the byte
		// 0x01. Their inodes tell them apart.
		it.each([
			['the C locale', undefined],
			['a UTF-8 locale', 'en_US.UTF-8'],
		])(
			"tells the lane's own Metro from one in a directory lsof prints alike, with the desktop in %s",
			async (_locale, lang) => {
				vi.stubEnv('LANG', lang);
				vi.stubEnv('LC_ALL', undefined);
				const appDirectory = path.join(root, 'a^Ab');
				const other = path.join(root, 'a\u0001b');
				await mkdir(appDirectory);
				await mkdir(other);
				await withMetroIn(other, async (_othersMetro, pid) => {
					// Given as lsof prints it, and through /var's symlink.
					for (const given of [
						path.join(realpathSync(root), 'a^Ab'),
						appDirectory,
					]) {
						await expectRefusal(
							pid,
							given,
							`serving from another directory than this lane's ${given}, though lsof prints its path the same;`
						);
					}
				});
				await withMetroIn(appDirectory, async (lanesMetro, pid) => {
					const exited = once(lanesMetro, 'exit');
					await metro.stop(pid, 8_100, appDirectory);
					expect((await exited)[1]).toBe('SIGTERM');
				});
			}
		);

		// In the desktop's legacy locale, lsof printed some bytes of a name raw
		// (see processCwd): in ja_JP.SJIS another worktree's `Á\t` read as a
		// gone lane's `Á` and tab, and in fr_FR.ISO8859-1 `Á` showed as U+FFFD
		// and \x81.
		it.each([
			['ja_JP.SJIS', 'Á\\t', 'Á\t', String.raw`Á\\t`, String.raw`Á\t`],
			['fr_FR.ISO8859-1', 'Á', 'ā', 'Á', 'ā'],
		])(
			"refuses another worktree's Metro for a gone app directory, naming both directories, with the desktop in %s",
			async (lang, other, lane, shownOther, shownLane) => {
				vi.stubEnv('LANG', lang);
				vi.stubEnv('LC_ALL', undefined);
				await mkdir(path.join(root, other));
				await withMetroIn(path.join(root, other), async (_othersMetro, pid) => {
					await expectRefusal(
						pid,
						path.join(realpathSync(root), lane),
						`serving from ${realpathSync(root)}/${shownOther}, not from this lane's ${realpathSync(root)}/${shownLane};`
					);
				});
			}
		);

		it("keeps refusing a moved worktree's Metro, also once a directory is made at its old path", async () => {
			const appDirectory = path.join(root, 'app');
			const moved = path.join(root, 'app-moved');
			await mkdir(appDirectory);
			await withMetroIn(appDirectory, async (_lanesMetro, pid) => {
				await rename(appDirectory, moved);
				// lsof reports the working directory under its new path.
				const refusal = `serving from ${realpathSync(moved)}, not from this lane's ${appDirectory}; refusing to stop it. If the worktree was moved or renamed`;
				await expectRefusal(pid, appDirectory, refusal);
				await mkdir(appDirectory);
				await expectRefusal(pid, appDirectory, refusal);
			});
		});

		// Through the data volume's firmlink, which lsof prints as /private/var
		// and realpath(3) keeps. A TMPDIR on another volume has no such path.
		it.runIf(existsSync(`/System/Volumes/Data${realpathSync(os.tmpdir())}`))(
			"signals the lane's own Metro whose app directory is spelled unlike anything lsof prints",
			async () => {
				const appDirectory = `/System/Volumes/Data${realpathSync(root)}`;
				await withMetroIn(root, async (lanesMetro, pid) => {
					const exited = once(lanesMetro, 'exit');
					await metro.stop(pid, 8_100, appDirectory);
					expect((await exited)[1]).toBe('SIGTERM');
				});
			}
		);

		// lsof prints both numbers unsigned, while Node's stat reads them as
		// signed 64-bit integers, which a JavaScript number cannot hold exactly.
		it.each([
			['/dev', 'a device number with its high bit set, as devfs has'],
			['/System/Volumes/Data', 'an inode above 2^53, as the data volume has'],
		])('matches a working directory in %s, which has %s', async (directory) => {
			await withMetroIn(directory, async (standIn, pid) => {
				const exited = once(standIn, 'exit');
				await metro.stop(pid, 8_100, directory);
				expect((await exited)[1]).toBe('SIGTERM');
			});
		});
	});
});

describe('laneEnvProblem', () => {
	it('passes public values, and names a refused variable without echoing its value', () => {
		expect(laneEnvProblem(undefined)).toBeUndefined();
		expect(
			laneEnvProblem({
				EXPO_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:21734',
				EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example',
			})
		).toBeUndefined();
		const secret = laneEnvProblem({ EXPO_PUBLIC_KEY: 'sb_secret_x1' });
		expect(secret).toMatch(/EXPO_PUBLIC_KEY holds a secret key/);
		expect(secret).not.toContain('sb_secret_x1');
		expect(laneEnvProblem({ SUPABASE_SERVICE_ROLE_KEY: 'x' })).toMatch(
			/names a credential/
		);
	});
});

describe('Metro health', () => {
	const ANSWERS = async () => ({
		ok: true,
		text: async () => 'packager-status:running',
	});

	function probe(
		lsof: (args: readonly string[]) => Promise<SimulatorCommandResult>,
		answers: typeof ANSWERS = ANSWERS
	) {
		const commands: Array<{ executable: string; args: readonly string[] }> = [];
		const metro = createMetroSupervisor({
			probe: answers,
			runCommand: async (executable, args) => {
				commands.push({ executable, args });
				return lsof(args);
			},
		});
		return { metro, commands };
	}

	it("counts only when the lane's own Metro process listens on the port", async () => {
		const { metro, commands } = probe(async () => ({
			stdout: 'p4242\nf23\n',
			stderr: '',
			exitCode: 0,
		}));
		expect(await metro.isHealthy(8_100, 4_242)).toBe(true);
		expect(commands).toEqual([
			{
				executable: '/usr/sbin/lsof',
				args: [
					'-a',
					'-p',
					'4242',
					'-iTCP:8100',
					'-sTCP:LISTEN',
					'-n',
					'-P',
					'-Fp',
				],
			},
		]);
	});

	it("does not count another worktree's packager answering on the lane's port", async () => {
		// lsof exits 1 when the process has no listener there.
		const { metro } = probe(async () => {
			throw new SimulatorCommandError('lsof failed with exit code 1.', {
				kind: 'failed',
				exitCode: 1,
			});
		});
		expect(await metro.isHealthy(8_100, 4_242)).toBe(false);
		const { metro: other } = probe(async () => ({
			stdout: 'p31337\nf9\n',
			stderr: '',
			exitCode: 0,
		}));
		expect(await other.isHealthy(8_100, 4_242)).toBe(false);
	});

	it('fails closed when lsof cannot run', async () => {
		const { metro } = probe(async () => {
			throw new SimulatorCommandError('lsof timed out.', { kind: 'timeout' });
		});
		expect(await metro.isHealthy(8_100, 4_242)).toBe(false);
	});

	it('asks lsof nothing while no packager answers', async () => {
		const { metro, commands } = probe(
			async () => ({ stdout: 'p4242\n', stderr: '', exitCode: 0 }),
			async () => {
				throw new Error('connect ECONNREFUSED 127.0.0.1:8100');
			}
		);
		expect(await metro.isHealthy(8_100, 4_242)).toBe(false);
		expect(commands).toEqual([]);
	});
});

describe('Metro log tail', () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), 'rndevtools-metro-log-'));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it('starts a cut tail at a whole line, so no half-secret leads it', async () => {
		const file = path.join(root, 'lane.log');
		await writeFile(
			file,
			'SECRET_KEY=sb_secret_abcdefghijklmnop\nline two\nline three\n'
		);
		const { readLogTail } = createMetroSupervisor();
		// The last 30 characters begin inside the secret's value, past its name.
		expect(await readLogTail(file, 30)).toBe('line two\nline three\n');
		expect(await readLogTail(file, 4_096)).toBe(
			'SECRET_KEY=sb_secret_abcdefghijklmnop\nline two\nline three\n'
		);
	});

	it('keeps a tail that is all one line', async () => {
		const file = path.join(root, 'lane.log');
		await writeFile(file, `${'a'.repeat(40)}\n`);
		const { readLogTail } = createMetroSupervisor();
		expect(await readLogTail(file, 11)).toBe('aaaaaaaaaa\n');
	});

	it('drops the partial first line of a log longer than the read window', async () => {
		const file = path.join(root, 'lane.log');
		await writeFile(file, `password=${'x'.repeat(256 * 1024)}\nlast line\n`);
		const { readLogTail } = createMetroSupervisor();
		expect(await readLogTail(file, 512 * 1024)).toBe('last line\n');
	});

	it('reads a missing log as empty', async () => {
		const { readLogTail } = createMetroSupervisor();
		expect(await readLogTail(path.join(root, 'absent.log'), 1_024)).toBe('');
	});
});

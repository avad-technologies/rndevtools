import { EventEmitter } from 'node:events';
import { writeSync } from 'node:fs';
import {
	appendFile,
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { realisticSecrets } from './cli-fixtures.test-support';
import {
	buildSupabaseCliEnvironment,
	parseSupabaseJsonLine,
	pruneSupabaseProgressFiles,
	readSupabaseProgressLines,
	removeSupabaseProgressFile,
	type SupabaseCliEnvironmentOptions,
	SupabaseCliOutputError,
	SupabaseCliRunner,
	SupabaseCliRunnerError,
	type SupabaseCliRunnerOptions,
	type SupabaseCliRunRequest,
	SupabaseCliRunResult,
	type SupabaseClockPort,
	type SupabaseSpawnOptions,
	type SupabaseSpawnPort,
} from './cli-runner';
import {
	buildSupabaseArgv,
	resolveSupabaseDialect,
	SUPABASE_MAX_CLI_TIMEOUT_MS,
	SupabaseArgvError,
} from './dialect';

const BINARY =
	'/Users/example/ExampleApp/node_modules/@supabase/cli-darwin-arm64/bin/supabase';
const dialect = resolveSupabaseDialect('2.121.0');
const listArgv = buildSupabaseArgv(dialect, { kind: 'stack.list' });
const startArgv = buildSupabaseArgv(dialect, {
	kind: 'stack.start',
	workdir: '/Users/example/ExampleApp',
	exclude: ['studio', 'analytics'],
});
const uid = process.getuid?.() ?? 0;

const PARENT_ENVIRONMENT: Readonly<Record<string, string>> = {
	PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
	HOME: '/Users/example',
	USER: 'example',
	LOGNAME: 'example',
	TMPDIR: '/var/folders/xy/example/T/',
	LANG: 'en_US.UTF-8',
	LC_ALL: 'en_US.UTF-8',
	LC_CTYPE: 'UTF-8',
	SSL_CERT_FILE: '/etc/ssl/cert.pem',
	SUPABASE_ACCESS_TOKEN: 'access-token-example',
	SUPABASE_DB_PORT: '54322',
	SUPABASE_HOME: '/Users/example/.supabase-other',
	SUPABASE_EXPERIMENTAL: '1',
	SUPABASE_WORKDIR: '/tmp',
	SUPABASE_STUDIO_ENABLED: '',
	SUPABASE_AUTH_JWT_SECRET: 'inherited-jwt-secret-example',
	CLAUDE_CODE_SESSION_ID: 'session-example',
	CODEX_THREAD_ID: 'thread-example',
	RNDEVTOOLS_TOKEN: 'token-example',
	AWS_SECRET_ACCESS_KEY: 'aws-example',
	EXPO_PUBLIC_SUPABASE_URL: 'https://example.com',
	NODE_OPTIONS: '--inspect',
	ELECTRON_RUN_AS_NODE: '1',
	PGPASSWORD: 'pg-example',
	DOCKER_HOST: 'unix:///var/run/docker.sock',
};

const EXPECTED_ENVIRONMENT: Readonly<Record<string, string>> = {
	PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${path.dirname(BINARY)}`,
	HOME: '/Users/example',
	USER: 'example',
	LOGNAME: 'example',
	TMPDIR: '/var/folders/xy/example/T/',
	LANG: 'en_US.UTF-8',
	LC_ALL: 'en_US.UTF-8',
	LC_CTYPE: 'UTF-8',
	SSL_CERT_FILE: '/etc/ssl/cert.pem',
	SUPABASE_EXPERIMENTAL_STACK: '1',
	SUPABASE_TELEMETRY_DISABLED: '1',
	DO_NOT_TRACK: '1',
	SUPABASE_NO_UPDATE_NOTIFIER: '1',
};

class ManualClock implements SupabaseClockPort {
	#now = 1_000;
	#nextId = 1;
	readonly #timers = new Map<number, { at: number; callback: () => void }>();

	now = () => this.#now;

	setTimeout = (callback: () => void, ms: number) => {
		const id = this.#nextId;
		this.#nextId += 1;
		this.#timers.set(id, { at: this.#now + ms, callback });
		return id;
	};

	clearTimeout = (handle: unknown) => {
		this.#timers.delete(handle as number);
	};

	advance(ms: number): void {
		const target = this.#now + ms;
		for (;;) {
			const due = [...this.#timers.entries()]
				.filter(([, timer]) => timer.at <= target)
				.sort((left, right) => left[1].at - right[1].at)[0];
			if (due === undefined) break;
			this.#timers.delete(due[0]);
			this.#now = due[1].at;
			due[1].callback();
		}
		this.#now = target;
	}
}

class FakeChild extends EventEmitter {
	readonly pid: number | undefined;
	readonly stdout = new PassThrough();
	readonly stderr: PassThrough | null;
	readonly signals: NodeJS.Signals[] = [];
	unrefCalled = false;
	#finished = false;

	constructor(withStderrPipe: boolean, pid: number | undefined) {
		super();
		this.stderr = withStderrPipe ? new PassThrough() : null;
		this.pid = pid;
	}

	kill(signal: NodeJS.Signals): boolean {
		this.signals.push(signal);
		this.emit('signal', signal);
		return true;
	}

	unref(): void {
		this.unrefCalled = true;
	}

	async finish(
		code: number | null,
		signal: NodeJS.Signals | null = null
	): Promise<void> {
		if (this.#finished) return;
		this.#finished = true;
		const streams = [
			this.stdout,
			...(this.stderr === null ? [] : [this.stderr]),
		];
		const ended = Promise.all(
			streams.map(
				(stream) =>
					new Promise<void>((resolve) => stream.once('end', () => resolve()))
			)
		);
		for (const stream of streams) stream.end();
		this.emit('exit', code, signal);
		await ended;
		this.emit('close', code, signal);
	}
}

type SpawnCall = {
	command: string;
	args: string[];
	options: SupabaseSpawnOptions;
	child: FakeChild;
};

function fakeSpawn(
	options: Readonly<{
		onSpawn?: (child: FakeChild, spawnOptions: SupabaseSpawnOptions) => void;
		fail?: boolean;
		pid?: number | undefined;
	}> = {}
) {
	const calls: SpawnCall[] = [];
	const spawn: SupabaseSpawnPort = (command, args, spawnOptions) => {
		const child = new FakeChild(
			spawnOptions.stdio[2] === 'pipe',
			'pid' in options ? options.pid : 4242
		);
		calls.push({ command, args: [...args], options: spawnOptions, child });
		// Node reports the spawn (or its failure) on the next tick, before any
		// output; anything the script schedules runs after that.
		process.nextTick(() => {
			if (options.fail === true) {
				child.emit('error', new Error('spawn ENOENT'));
				child.emit('close', -2, null);
			} else {
				child.emit('spawn');
			}
		});
		options.onSpawn?.(child, spawnOptions);
		return child;
	};
	return { spawn, calls };
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`timed out waiting for ${label}`);
}

const directories: string[] = [];

async function tempDirectory(): Promise<string> {
	const directory = await realpath(
		await mkdtemp(path.join(tmpdir(), 'rndevtools-supabase-runner-'))
	);
	directories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

function runnerWith(
	spawn: SupabaseSpawnPort,
	extra: SupabaseCliRunnerOptions = {}
) {
	return new SupabaseCliRunner({
		spawn,
		clock: new ManualClock(),
		parentEnvironment: PARENT_ENVIRONMENT,
		uid,
		...extra,
	});
}

describe('buildSupabaseCliEnvironment', () => {
	it('passes exactly the allowlist: no tokens, agent ids, ports, or empty SUPABASE_*', () => {
		expect(
			buildSupabaseCliEnvironment({
				binaryPath: BINARY,
				parentEnvironment: PARENT_ENVIRONMENT,
			})
		).toEqual(EXPECTED_ENVIRONMENT);
	});

	it('adds SUPABASE_HOME, certificates and allowlisted overrides only when configured', () => {
		const environment = buildSupabaseCliEnvironment({
			binaryPath: BINARY,
			parentEnvironment: {},
			options: {
				supabaseHome:
					'/Users/example/Library/Application Support/RN Devtools/supabase',
				sslCertFile: '/Users/example/certs/bundle.pem',
				sslCertDir: '/Users/example/certs',
				overrides: {
					SUPABASE_STUDIO_ENABLED: 'false',
					SUPABASE_ANALYTICS_ENABLED: 'false',
					SUPABASE_AUTH_JWT_SECRET: 'a-per-stack-secret-of-32-chars!!',
					SUPABASE_AUTH_SIGNING_KEYS_PATH: '/Users/example/keys/signing.json',
				},
			},
		});
		expect(environment).toEqual({
			PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${path.dirname(BINARY)}`,
			SSL_CERT_FILE: '/Users/example/certs/bundle.pem',
			SSL_CERT_DIR: '/Users/example/certs',
			SUPABASE_HOME:
				'/Users/example/Library/Application Support/RN Devtools/supabase',
			SUPABASE_STUDIO_ENABLED: 'false',
			SUPABASE_ANALYTICS_ENABLED: 'false',
			SUPABASE_AUTH_JWT_SECRET: 'a-per-stack-secret-of-32-chars!!',
			SUPABASE_AUTH_SIGNING_KEYS_PATH: '/Users/example/keys/signing.json',
			SUPABASE_EXPERIMENTAL_STACK: '1',
			SUPABASE_TELEMETRY_DISABLED: '1',
			DO_NOT_TRACK: '1',
			SUPABASE_NO_UPDATE_NOTIFIER: '1',
		});
	});

	it('rejects overrides outside the allowlist and malformed values', () => {
		const rejected: SupabaseCliEnvironmentOptions[] = [
			{ overrides: { SUPABASE_ACCESS_TOKEN: 'x' } },
			{ overrides: { SUPABASE_DB_PORT: '54322' } },
			{ overrides: { SUPABASE_EXPERIMENTAL_STACK: '0' } },
			{ overrides: { SUPABASE_STUDIO_ENABLED: '' } },
			{ overrides: { SUPABASE_STUDIO_ENABLED: 'yes' } },
			{ overrides: { SUPABASE_AUTH_JWT_SECRET: 'short' } },
			{ overrides: { SUPABASE_AUTH_SECRET_KEY: 'line\nbreak' } },
			{ overrides: { SUPABASE_AUTH_SIGNING_KEYS_PATH: 'keys/signing.json' } },
			{ supabaseHome: '.supabase' },
			{ sslCertFile: 'cert.pem' },
		];
		for (const options of rejected) {
			expect(() =>
				buildSupabaseCliEnvironment({
					binaryPath: BINARY,
					parentEnvironment: {},
					options,
				})
			).toThrow(SupabaseCliRunnerError);
		}
		expect(() =>
			buildSupabaseCliEnvironment({
				binaryPath: '/Users/example/odd:dir/supabase',
				parentEnvironment: {},
			})
		).toThrow(SupabaseCliRunnerError);
	});

	it('ignores inherited values it cannot pass safely', () => {
		expect(
			buildSupabaseCliEnvironment({
				binaryPath: BINARY,
				parentEnvironment: {
					HOME: '/Users/example\nINJECTED=1',
					LANG: '',
					SSL_CERT_FILE: 'relative.pem',
					LC_lowercase: 'x',
				},
			})
		).toEqual({
			PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${path.dirname(BINARY)}`,
			SUPABASE_EXPERIMENTAL_STACK: '1',
			SUPABASE_TELEMETRY_DISABLED: '1',
			DO_NOT_TRACK: '1',
			SUPABASE_NO_UPDATE_NOTIFIER: '1',
		});
	});
});

describe('SupabaseCliRunner.run', () => {
	it('spawns an argv array, without a shell, from a private neutral directory', async () => {
		const cwd = path.join(await tempDirectory(), 'neutral', 'cwd');
		const { spawn, calls } = fakeSpawn({
			onSpawn: (child) => {
				process.nextTick(() => {
					child.stdout.write('{"stacks":[],"message":""}\n');
					void child.finish(0);
				});
			},
		});
		const result = await runnerWith(spawn).run({
			binaryPath: BINARY,
			argv: listArgv,
			readOnly: true,
			cwd,
			timeoutMs: 20_000,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.command).toBe(BINARY);
		expect(calls[0]?.args).toEqual([...listArgv]);
		expect(calls[0]?.options).toEqual({
			cwd,
			env: EXPECTED_ENVIRONMENT,
			detached: false,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		expect((await stat(cwd)).mode & 0o777).toBe(0o700);
		expect(result.succeeded).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(parseSupabaseJsonLine(result.takeStdout())).toEqual({
			stacks: [],
			message: '',
		});
	});

	it('checks argv against the allowlist before spawning anything', async () => {
		const cwd = await tempDirectory();
		const { spawn, calls } = fakeSpawn();
		const runner = runnerWith(spawn);
		await expect(
			runner.run({
				binaryPath: BINARY,
				argv: startArgv,
				readOnly: true,
				cwd,
				timeoutMs: 1_000,
			})
		).rejects.toMatchObject({ reason: 'read-only' });
		await expect(
			runner.run({
				binaryPath: BINARY,
				argv: ['stack', 'stop', '--all', '--output-format', 'json'],
				cwd,
				timeoutMs: 1_000,
			})
		).rejects.toBeInstanceOf(SupabaseArgvError);
		await expect(
			runner.run({
				binaryPath: 'supabase',
				argv: listArgv,
				readOnly: true,
				cwd,
				timeoutMs: 1_000,
			})
		).rejects.toMatchObject({ kind: 'invalid-request' });
		expect(calls).toHaveLength(0);
	});

	it('refuses working directories that are relative, symlinked or owned by someone else', async () => {
		const base = await tempDirectory();
		const real = path.join(base, 'real');
		await mkdir(real, { mode: 0o755 });
		const link = path.join(base, 'link');
		await symlink(real, link);
		const { spawn, calls } = fakeSpawn();
		await expect(
			runnerWith(spawn).run({
				binaryPath: BINARY,
				argv: listArgv,
				readOnly: true,
				cwd: 'relative/cwd',
				timeoutMs: 1_000,
			})
		).rejects.toMatchObject({ kind: 'invalid-request' });
		await expect(
			runnerWith(spawn).run({
				binaryPath: BINARY,
				argv: listArgv,
				readOnly: true,
				cwd: link,
				timeoutMs: 1_000,
			})
		).rejects.toMatchObject({ kind: 'unsafe-directory' });
		await expect(
			runnerWith(spawn, { uid: uid + 1 }).run({
				binaryPath: BINARY,
				argv: listArgv,
				readOnly: true,
				cwd: real,
				timeoutMs: 1_000,
			})
		).rejects.toMatchObject({ kind: 'unsafe-directory' });
		expect(calls).toHaveLength(0);
		// An existing directory of ours is tightened to 0700.
		const { spawn: finishing } = fakeSpawn({
			onSpawn: (child) => process.nextTick(() => void child.finish(0)),
		});
		await runnerWith(finishing).run({
			binaryPath: BINARY,
			argv: listArgv,
			readOnly: true,
			cwd: real,
			timeoutMs: 1_000,
		});
		expect((await stat(real)).mode & 0o777).toBe(0o700);
	});

	it('keeps draining stdout past its cap without killing the child', async () => {
		const cwd = await tempDirectory();
		const chunk = 'x'.repeat(64 * 1024);
		const { spawn, calls } = fakeSpawn({
			onSpawn: (child) => {
				process.nextTick(() => {
					for (let index = 0; index < 10; index += 1) child.stdout.write(chunk);
					void child.finish(0);
				});
			},
		});
		const result = await runnerWith(spawn).run({
			binaryPath: BINARY,
			argv: listArgv,
			readOnly: true,
			cwd,
			timeoutMs: 1_000,
		});
		expect(result.stdoutTruncated).toBe(true);
		expect(result.stdoutBytes).toBe(10 * 64 * 1024);
		expect(result.succeeded).toBe(false);
		expect(result.takeStdout()).toHaveLength(512 * 1024);
		expect(calls[0]?.child.signals).toEqual([]);
	});

	it('streams sanitized stderr lines and bounds what it keeps', async () => {
		const cwd = await tempDirectory();
		const secret = realisticSecrets().secretKey;
		const streamed: string[] = [];
		const { spawn } = fakeSpawn({
			onSpawn: (child) => {
				process.nextTick(() => {
					child.stderr?.write(
						'[task] start: Starting local Supabase stack...\n'
					);
					child.stderr?.write(
						'\u001b[32mApplying migration 20261016000000_notes.sql...\u001b[0m\n'
					);
					child.stderr?.write(`SECRET_KEY=${secret}\r\nhalf a li`);
					const accented = Buffer.from('ne in café\n', 'utf8');
					child.stderr?.write(accented.subarray(0, accented.length - 3));
					child.stderr?.write(accented.subarray(accented.length - 3));
					child.stderr?.write(`${'y'.repeat(99)}\n`.repeat(1_100));
					void child.finish(0);
				});
			},
		});
		const result = await runnerWith(spawn).run({
			binaryPath: BINARY,
			argv: listArgv,
			readOnly: true,
			cwd,
			timeoutMs: 1_000,
			onStderrLine: (line) => {
				streamed.push(line);
				if (streamed.length === 2)
					throw new Error('listeners cannot break the run');
			},
		});
		expect(streamed.slice(0, 2)).toEqual([
			'[task] start: Starting local Supabase stack...',
			'Applying migration 20261016000000_notes.sql...',
		]);
		expect(streamed[2]).toContain('SECRET_KEY=');
		expect(streamed[2]).not.toContain(secret);
		expect(streamed[3]).toBe('half a line in café');
		expect(result.stderrLines).toEqual(streamed);
		expect(result.stderrTruncated).toBe(true);
		expect(
			result.stderrLines.reduce((total, line) => total + line.length + 1, 0)
		).toBeLessThanOrEqual(64 * 1024);
		expect(JSON.stringify(result)).not.toContain(secret);
	});

	it('interrupts on timeout, terminates after the grace period, and never SIGKILLs without a budget', async () => {
		const cwd = await tempDirectory();
		const clock = new ManualClock();
		const { spawn, calls } = fakeSpawn();
		const pending = runnerWith(spawn, { clock }).run({
			binaryPath: BINARY,
			argv: listArgv,
			readOnly: true,
			cwd,
			timeoutMs: 1_000,
			interruptGraceMs: 45_000,
		});
		await waitFor(() => calls.length === 1, 'spawn');
		const child = calls[0]?.child;
		if (child === undefined) throw new Error('no child');
		await new Promise((resolve) => setImmediate(resolve));
		clock.advance(999);
		expect(child.signals).toEqual([]);
		clock.advance(1);
		expect(child.signals).toEqual(['SIGINT']);
		clock.advance(44_999);
		expect(child.signals).toEqual(['SIGINT']);
		clock.advance(1);
		expect(child.signals).toEqual(['SIGINT', 'SIGTERM']);
		clock.advance(60 * 60 * 1000);
		expect(child.signals).toEqual(['SIGINT', 'SIGTERM']);
		await child.finish(null, 'SIGTERM');
		const result = await pending;
		expect(result).toMatchObject({
			timedOut: true,
			cancelled: false,
			exitCode: null,
			signal: 'SIGTERM',
			signalsSent: ['SIGINT', 'SIGTERM'],
		});
		expect(result.succeeded).toBe(false);
	});

	it('SIGKILLs a read only after SIGTERM, when its budget allows it', async () => {
		const cwd = await tempDirectory();
		const clock = new ManualClock();
		const { spawn, calls } = fakeSpawn();
		const pending = runnerWith(spawn, { clock }).run({
			binaryPath: BINARY,
			argv: listArgv,
			readOnly: true,
			cwd,
			timeoutMs: 100,
			interruptGraceMs: 5_000,
			forceKillAfterMs: 5_000,
		});
		await waitFor(() => calls.length === 1, 'spawn');
		await new Promise((resolve) => setImmediate(resolve));
		const child = calls[0]?.child;
		clock.advance(100 + 5_000 + 4_999);
		expect(child?.signals).toEqual(['SIGINT', 'SIGTERM']);
		clock.advance(1);
		expect(child?.signals).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
		await child?.finish(null, 'SIGKILL');
		expect((await pending).signalsSent).toEqual([
			'SIGINT',
			'SIGTERM',
			'SIGKILL',
		]);
	});

	it('counts a call that still exited 0 after its interrupt as completed', async () => {
		const cwd = await tempDirectory();
		const clock = new ManualClock();
		const { spawn, calls } = fakeSpawn({
			onSpawn: (child) => {
				child.on('signal', (signal) => {
					if (signal !== 'SIGINT') return;
					child.stdout.write('{"stacks":[],"message":""}\n');
					void child.finish(0);
				});
			},
		});
		const pending = runnerWith(spawn, { clock }).run({
			binaryPath: BINARY,
			argv: listArgv,
			readOnly: true,
			cwd,
			timeoutMs: 1_000,
		});
		await waitFor(() => calls.length === 1, 'spawn');
		await new Promise((resolve) => setImmediate(resolve));
		clock.advance(1_000);
		const result = await pending;
		expect(result).toMatchObject({
			timedOut: true,
			exitCode: 0,
			signal: null,
			signalsSent: ['SIGINT'],
		});
		expect(result.succeeded).toBe(true);
	});

	it('interrupts with SIGINT when the caller aborts', async () => {
		const cwd = await tempDirectory();
		const controller = new AbortController();
		const { spawn, calls } = fakeSpawn({
			onSpawn: (child) => {
				child.on('signal', (signal) => {
					if (signal === 'SIGINT') void child.finish(130);
				});
			},
		});
		const pending = runnerWith(spawn).run({
			binaryPath: BINARY,
			argv: listArgv,
			readOnly: true,
			cwd,
			timeoutMs: 20_000,
			signal: controller.signal,
		});
		await waitFor(() => calls.length === 1, 'spawn');
		await new Promise((resolve) => setImmediate(resolve));
		controller.abort();
		const result = await pending;
		expect(result).toMatchObject({
			cancelled: true,
			timedOut: false,
			exitCode: 130,
			signalsSent: ['SIGINT'],
		});
		expect(result.succeeded).toBe(false);
		const aborted = new AbortController();
		aborted.abort();
		await expect(
			runnerWith(spawn).run({
				binaryPath: BINARY,
				argv: listArgv,
				readOnly: true,
				cwd,
				timeoutMs: 20_000,
				signal: aborted.signal,
			})
		).rejects.toMatchObject({ kind: 'aborted' });
		expect(calls).toHaveLength(1);
	});

	it('reports a failed spawn without echoing argv', async () => {
		const cwd = await tempDirectory();
		const { spawn } = fakeSpawn({ fail: true });
		const failure = await runnerWith(spawn)
			.run({
				binaryPath: BINARY,
				argv: listArgv,
				readOnly: true,
				cwd,
				timeoutMs: 1_000,
			})
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(SupabaseCliRunnerError);
		expect(failure).toMatchObject({ kind: 'spawn' });
		expect((failure as Error).message).not.toContain('stack');
		const throwing: SupabaseSpawnPort = () => {
			throw new Error('EINVAL');
		};
		await expect(
			runnerWith(throwing).run({
				binaryPath: BINARY,
				argv: listArgv,
				readOnly: true,
				cwd,
				timeoutMs: 1_000,
			})
		).rejects.toMatchObject({ kind: 'spawn' });
	});

	it('validates budgets', async () => {
		const cwd = await tempDirectory();
		const { spawn } = fakeSpawn();
		const budgets: Pick<
			SupabaseCliRunRequest,
			'timeoutMs' | 'interruptGraceMs' | 'forceKillAfterMs'
		>[] = [
			{ timeoutMs: 0 },
			{ timeoutMs: 1.5 },
			{ timeoutMs: 1_000, interruptGraceMs: -1 },
			{ timeoutMs: 1_000, forceKillAfterMs: Number.NaN },
			// Past the largest budget any operation is given.
			{ timeoutMs: SUPABASE_MAX_CLI_TIMEOUT_MS + 1 },
		];
		for (const budget of budgets) {
			await expect(
				runnerWith(spawn).run({
					binaryPath: BINARY,
					argv: listArgv,
					readOnly: true,
					cwd,
					...budget,
				})
			).rejects.toMatchObject({ kind: 'invalid-request' });
		}
	});
});

describe('SupabaseCliRunResult', () => {
	it('keeps stdout out of JSON, structured clones and inspection, and hands it out once', () => {
		const { dbUrl, secretKey } = realisticSecrets();
		const stdout = `${JSON.stringify({ env: { DB_URL: dbUrl, SECRET_KEY: secretKey } })}\n`;
		const result = new SupabaseCliRunResult(
			{
				exitCode: 0,
				signal: null,
				timedOut: false,
				cancelled: false,
				signalsSent: [],
				stdoutBytes: stdout.length,
				stdoutTruncated: false,
				stderrLines: ['[task] done: Stack is ready.'],
				stderrTruncated: false,
				durationMs: 12,
			},
			stdout
		);
		for (const rendered of [
			JSON.stringify(result),
			JSON.stringify(structuredClone(result)),
			inspect(result, { showHidden: true, depth: 8 }),
			String(result),
		]) {
			expect(rendered).not.toContain(secretKey);
			expect(rendered).not.toContain(dbUrl);
		}
		expect(JSON.parse(JSON.stringify(result))).toMatchObject({
			exitCode: 0,
			stderrLines: ['[task] done: Stack is ready.'],
		});
		expect(result.takeStdout()).toBe(stdout);
		expect(result.takeStdout()).toBe('');
	});
});

describe('parseSupabaseJsonLine', () => {
	it('parses the last non-empty line', () => {
		expect(parseSupabaseJsonLine('noise\n{"a":1}\n\n')).toEqual({ a: 1 });
		expect(parseSupabaseJsonLine('[1,2]')).toEqual([1, 2]);
	});

	it('fails without echoing the output', () => {
		const secret = realisticSecrets().secretKey;
		for (const [stdout, kind] of [
			['', 'empty'],
			['\n \n', 'empty'],
			[`{"SECRET_KEY":"${secret}"`, 'invalid-json'],
		] as const) {
			let failure: unknown;
			try {
				parseSupabaseJsonLine(stdout);
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(SupabaseCliOutputError);
			expect(failure).toMatchObject({ kind });
			expect((failure as Error).message).not.toContain(secret);
		}
	});
});

describe('SupabaseCliRunner.spawnDetached', () => {
	async function detachedSetup(extra: SupabaseCliRunnerOptions = {}) {
		const base = await tempDirectory();
		const clock = new ManualClock();
		const kills: [number, NodeJS.Signals][] = [];
		const { spawn, calls } = fakeSpawn({
			onSpawn: (_child, spawnOptions) => {
				const descriptor = spawnOptions.stdio[2];
				if (typeof descriptor === 'number') {
					writeSync(
						descriptor,
						'[task] start: Starting local Supabase stack...\n'
					);
				}
			},
		});
		const runner = runnerWith(spawn, {
			clock,
			killProcess: (pid, signal) => {
				kills.push([pid, signal]);
			},
			...extra,
		});
		return {
			base,
			clock,
			kills,
			calls,
			runner,
			cwd: path.join(base, 'cwd'),
			progressDirectory: path.join(base, 'progress'),
		};
	}

	it('runs in its own process group with stderr in a private progress file', async () => {
		const setup = await detachedSetup();
		const streamed: string[] = [];
		const handle = await setup.runner.spawnDetached({
			binaryPath: BINARY,
			argv: startArgv,
			cwd: setup.cwd,
			timeoutMs: 300_000,
			progressDirectory: setup.progressDirectory,
			progressLabel: 'start',
			onStderrLine: (line) => streamed.push(line),
		});
		const call = setup.calls[0];
		if (call === undefined) throw new Error('no spawn');
		expect(call.options).toMatchObject({
			cwd: setup.cwd,
			env: EXPECTED_ENVIRONMENT,
			detached: true,
		});
		expect(call.options.stdio.slice(0, 2)).toEqual(['ignore', 'pipe']);
		expect(typeof call.options.stdio[2]).toBe('number');
		expect(call.child.unrefCalled).toBe(true);
		expect(handle.pid).toBe(4242);
		expect(
			handle.progressFile.startsWith(
				`${setup.progressDirectory}${path.sep}start-`
			)
		).toBe(true);
		expect((await stat(handle.progressFile)).mode & 0o777).toBe(0o600);
		expect((await stat(setup.progressDirectory)).mode & 0o777).toBe(0o700);
		expect((await stat(setup.cwd)).mode & 0o777).toBe(0o700);
		await appendFile(
			handle.progressFile,
			'Applying migration 20261016000000_notes.sql...\n\u001b[1m[task] done: Stack is ready.\u001b[0m\n'
		);
		call.child.stdout.write('{"id":"x"}\n');
		await call.child.finish(0);
		const result = await handle.result;
		expect(result.stderrLines).toEqual([
			'[task] start: Starting local Supabase stack...',
			'Applying migration 20261016000000_notes.sql...',
			'[task] done: Stack is ready.',
		]);
		expect(streamed).toEqual(result.stderrLines);
		expect(result.takeStdout()).toBe('{"id":"x"}\n');
		expect(setup.kills).toEqual([]);
		expect(call.child.signals).toEqual([]);
		// Its lines are in the result, so the file is gone.
		expect(await readdir(setup.progressDirectory)).toEqual([]);
	});

	it('interrupts the whole group, waits, then terminates, and never SIGKILLs a lifecycle child', async () => {
		const setup = await detachedSetup();
		const handle = await setup.runner.spawnDetached({
			binaryPath: BINARY,
			argv: startArgv,
			cwd: setup.cwd,
			timeoutMs: 300_000,
			progressDirectory: setup.progressDirectory,
			progressLabel: 'start',
		});
		handle.interrupt();
		handle.interrupt();
		expect(setup.kills).toEqual([[-4242, 'SIGINT']]);
		setup.clock.advance(44_999);
		expect(setup.kills).toEqual([[-4242, 'SIGINT']]);
		setup.clock.advance(1);
		expect(setup.kills).toEqual([
			[-4242, 'SIGINT'],
			[-4242, 'SIGTERM'],
		]);
		setup.clock.advance(60 * 60 * 1000);
		expect(setup.kills).toHaveLength(2);
		await setup.calls[0]?.child.finish(130);
		const result = await handle.result;
		expect(result).toMatchObject({
			exitCode: 130,
			signalsSent: ['SIGINT', 'SIGTERM'],
		});
	});

	it('applies its budget on its own and falls back to the leader when the group is gone', async () => {
		const setup = await detachedSetup({
			killProcess: () => {
				throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
			},
		});
		const handle = await setup.runner.spawnDetached({
			binaryPath: BINARY,
			argv: startArgv,
			cwd: setup.cwd,
			timeoutMs: 1_000,
			interruptGraceMs: 2_000,
			progressDirectory: setup.progressDirectory,
			progressLabel: 'start',
		});
		const child = setup.calls[0]?.child;
		setup.clock.advance(1_000);
		expect(child?.signals).toEqual(['SIGINT']);
		setup.clock.advance(2_000);
		expect(child?.signals).toEqual(['SIGINT', 'SIGTERM']);
		await child?.finish(null, 'SIGTERM');
		expect(await handle.result).toMatchObject({ timedOut: true });
	});

	it('never signals pid 0 or 1, which would reach the desktop itself', async () => {
		const setup = await detachedSetup();
		const zero = fakeSpawn({ pid: 0 });
		const runner = runnerWith(zero.spawn, {
			clock: setup.clock,
			killProcess: (pid, signal) => {
				setup.kills.push([pid, signal]);
			},
		});
		await expect(
			runner.spawnDetached({
				binaryPath: BINARY,
				argv: startArgv,
				cwd: setup.cwd,
				timeoutMs: 1_000,
				progressDirectory: setup.progressDirectory,
				progressLabel: 'start',
			})
		).rejects.toMatchObject({ kind: 'spawn' });
		expect(setup.kills).toEqual([]);
		expect(zero.calls[0]?.child.signals).toEqual(['SIGINT']);
		expect(await readdir(setup.progressDirectory)).toEqual([]);
	});

	it('validates the progress label and reports spawn failures', async () => {
		const setup = await detachedSetup();
		await expect(
			setup.runner.spawnDetached({
				binaryPath: BINARY,
				argv: startArgv,
				cwd: setup.cwd,
				timeoutMs: 1_000,
				progressDirectory: setup.progressDirectory,
				progressLabel: '../escape',
			})
		).rejects.toMatchObject({ kind: 'invalid-request' });
		const failing = fakeSpawn({ fail: true });
		await expect(
			runnerWith(failing.spawn, { clock: setup.clock }).spawnDetached({
				binaryPath: BINARY,
				argv: startArgv,
				cwd: setup.cwd,
				timeoutMs: 1_000,
				progressDirectory: setup.progressDirectory,
				progressLabel: 'start',
			})
		).rejects.toMatchObject({ kind: 'spawn' });
		expect(await readdir(setup.progressDirectory)).toEqual([]);
		await expect(
			setup.runner.spawnDetached({
				binaryPath: BINARY,
				argv: startArgv,
				readOnly: true,
				cwd: setup.cwd,
				timeoutMs: 1_000,
				progressDirectory: setup.progressDirectory,
				progressLabel: 'start',
			})
		).rejects.toMatchObject({ reason: 'read-only' });
	});
});

describe('progress file clean up', () => {
	const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';

	it('removes only progress files earlier runs left', async () => {
		const directory = await tempDirectory();
		const old = path.join(directory, `create-1000-${UUID}.log`);
		const kept = path.join(directory, `start-1500-${UUID}.log`);
		const current = path.join(directory, `stop-3000-${UUID}.log`);
		const other = path.join(directory, 'notes.txt');
		const linked = path.join(directory, `reset-1200-${UUID}.log`);
		for (const file of [old, kept, current, other]) {
			await writeFile(file, '[task] done: Stack is ready.\n');
		}
		await symlink(other, linked);
		await expect(
			pruneSupabaseProgressFiles(directory, {
				before: 2_000,
				keep: new Set([kept]),
			})
		).resolves.toBe(1);
		expect((await readdir(directory)).sort()).toEqual(
			[kept, current, other, linked].map((file) => path.basename(file)).sort()
		);
		// Nothing outside the directory, or not named like a progress file.
		await expect(removeSupabaseProgressFile(directory, other)).resolves.toBe(
			false
		);
		await expect(
			removeSupabaseProgressFile(path.dirname(directory), kept)
		).resolves.toBe(false);
		await expect(
			pruneSupabaseProgressFiles(path.join(directory, 'missing'), {
				before: 2_000,
				keep: new Set(),
			})
		).resolves.toBe(0);
	});
});

describe('readSupabaseProgressLines', () => {
	it('reads a bounded, sanitized tail without a leading fragment', async () => {
		const base = await tempDirectory();
		const file = path.join(base, 'start.log');
		const secret = realisticSecrets().secretKey;
		await writeFile(
			file,
			`${'old line that will be cut\n'.repeat(200)}\u001b[31mApplying migration 1_a.sql...\u001b[0m\nSECRET_KEY=${secret}\n[task] done: Stack is ready.\n`,
			{ mode: 0o600 }
		);
		await chmod(file, 0o600);
		const lines = await readSupabaseProgressLines(file, 256);
		expect(lines.at(-1)).toBe('[task] done: Stack is ready.');
		expect(lines).toContain('Applying migration 1_a.sql...');
		expect(lines.join('\n')).not.toContain(secret);
		expect(
			lines
				.filter((line) => line.includes('cut'))
				.every((line) => line === 'old line that will be cut')
		).toBe(true);
		expect(await readSupabaseProgressLines(file)).toHaveLength(203);
	});
});

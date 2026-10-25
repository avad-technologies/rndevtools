import { describe, expect, it, vi } from 'vitest';
import {
	runSimulatorCommand,
	SimulatorCommandError,
	type SimulatorCommandOptions,
} from './simulator-command-runner';

describe('simulator command runner', () => {
	it('requires an absolute executable and preserves literal arguments', async () => {
		await expect(runSimulatorCommand('node', [])).rejects.toMatchObject({
			kind: 'spawn',
		});
		const payload = '; rm -rf / $(not-a-command)';
		const result = await runSimulatorCommand(process.execPath, [
			'-e',
			'process.stdout.write(process.argv[1])',
			payload,
		]);
		expect(result.stdout).toBe(payload);
	});

	it('bounds combined output', async () => {
		await expect(
			runSimulatorCommand(
				process.execPath,
				['-e', "process.stdout.write('x'.repeat(4096))"],
				{ maxOutputBytes: 128 }
			)
		).rejects.toMatchObject({ kind: 'output-limit' });
	});

	it('times out and cancels commands', async () => {
		await expect(
			runSimulatorCommand(
				process.execPath,
				['-e', 'setInterval(() => {}, 1000)'],
				{
					timeoutMs: 25,
				}
			)
		).rejects.toMatchObject({ kind: 'timeout' });

		const controller = new AbortController();
		const command = runSimulatorCommand(
			process.execPath,
			['-e', 'setInterval(() => {}, 1000)'],
			{ signal: controller.signal }
		);
		controller.abort();
		await expect(command).rejects.toMatchObject({ kind: 'aborted' });
	});

	it('requests helper cleanup through the private control pipe before force kill', async () => {
		let failure: unknown;
		try {
			await runSimulatorCommand(
				process.execPath,
				[
					'-e',
					"const fs=require('node:fs'); const b=Buffer.alloc(1); fs.read(4,b,0,1,null,()=>{process.stdout.write('control-closed');process.exit(0)}); setInterval(()=>{},1000)",
				],
				{
					timeoutMs: 25,
					forceKillDelayMs: 1_000,
					gracefulCancellationPipe: true,
				}
			);
		} catch (error) {
			failure = error;
		}
		expect(failure).toMatchObject({
			kind: 'timeout',
			stdout: 'control-closed',
		});
	});

	it('reserves descriptor 3 as an unpollable character device', async () => {
		// 'ignore' above descriptor 2 yields a pollable FIFO. The helper's Go runtime
		// registers that with its netpoll kqueue, and the helper's exactly-once close
		// of the spent authorization descriptor then kills the process mid-run. Only a
		// character device (S_IFCHR) is safe here; descriptor 4 stays the control pipe.
		const S_IFCHR = 0o20000;
		const S_IFIFO = 0o10000;
		const S_IFSOCK = 0o140000;
		const result = await runSimulatorCommand(
			process.execPath,
			[
				'-e',
				"const fs=require('node:fs'); const kind=(fd)=>{try{return (fs.fstatSync(fd).mode & 0o170000).toString(8)}catch(error){return String(error.code)}}; process.stdout.write('3:'+kind(3)+' 4:'+kind(4))",
			],
			{ gracefulCancellationPipe: true }
		);
		const [authorization, control] = result.stdout.split(' ');
		expect(authorization).toBe(`3:${S_IFCHR.toString(8)}`);
		// The control pipe must stay a socket (libuv backs 'pipe' with a
		// socketpair) or a FIFO, the only types the helper accepts there, so
		// closing it still cancels the helper.
		expect([`4:${S_IFSOCK.toString(8)}`, `4:${S_IFIFO.toString(8)}`]).toContain(
			control
		);
	});

	it('reports the helper exit code and stderr when a command dies without output', async () => {
		let failure: unknown;
		try {
			await runSimulatorCommand(process.execPath, [
				'-e',
				"process.stderr.write('fatal error: runtime: netpoll failed'); process.exit(2)",
			]);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(SimulatorCommandError);
		expect(failure).toMatchObject({
			exitCode: 2,
			stderr: 'fatal error: runtime: netpoll failed',
		});
	});

	it('returns bounded failure details without including arguments in its message', async () => {
		const secretArgument = 'private-token-value';
		let failure: unknown;
		try {
			await runSimulatorCommand(process.execPath, [
				'-e',
				'process.stderr.write(process.argv[1]); process.exit(7)',
				secretArgument,
			]);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(SimulatorCommandError);
		expect(failure).toMatchObject({ exitCode: 7, kind: 'failed' });
		expect((failure as Error).message).not.toContain(secretArgument);
	});

	it('normalizes synchronous spawn validation failures without echoing arguments', async () => {
		const secretArgument = 'private\0token';
		let failure: unknown;
		try {
			await runSimulatorCommand(process.execPath, [secretArgument]);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(SimulatorCommandError);
		expect(failure).toMatchObject({ kind: 'spawn' });
		expect((failure as Error).message).not.toContain('private');
	});

	it('uses a minimal environment and strips secrets and SIMCTL_CHILD overrides', async () => {
		const previousSecret = process.env.EXAMPLE_TEST_SECRET;
		const previousChildOverride =
			process.env.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES;
		process.env.EXAMPLE_TEST_SECRET = 'must-not-be-inherited';
		process.env.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES = '/tmp/untrusted.dylib';
		try {
			const result = await runSimulatorCommand(process.execPath, [
				'-e',
				'process.stdout.write(JSON.stringify(process.env))',
			]);
			const environment = JSON.parse(result.stdout) as Record<string, string>;
			expect(environment.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
			expect(environment.EXAMPLE_TEST_SECRET).toBeUndefined();
			expect(environment.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES).toBeUndefined();
		} finally {
			if (previousSecret === undefined) delete process.env.EXAMPLE_TEST_SECRET;
			else process.env.EXAMPLE_TEST_SECRET = previousSecret;
			if (previousChildOverride === undefined) {
				delete process.env.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES;
			} else {
				process.env.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES = previousChildOverride;
			}
		}
	});

	it('sets only typed allowlisted app environment controls', async () => {
		const result = await runSimulatorCommand(
			process.execPath,
			['-e', 'process.stdout.write(JSON.stringify(process.env))'],
			{
				simulatorAppEnvironment: {
					timeZone: 'America/Los_Angeles',
					slowAnimations: true,
				},
			}
		);
		const environment = JSON.parse(result.stdout) as Record<string, string>;
		expect(environment.SIMCTL_CHILD_TZ).toBe('America/Los_Angeles');
		expect(environment.SIMCTL_CHILD_RNDEVTOOLS_SLOW_ANIMATIONS).toBe('1');
		expect(
			Object.keys(environment)
				.filter((key) => key.startsWith('SIMCTL_CHILD_'))
				.sort()
		).toEqual(['SIMCTL_CHILD_RNDEVTOOLS_SLOW_ANIMATIONS', 'SIMCTL_CHILD_TZ']);
		await expect(
			runSimulatorCommand(process.execPath, ['-e', 'process.exit(0)'], {
				simulatorAppEnvironment: { timeZone: '../../private/etc' },
			})
		).rejects.toMatchObject({ kind: 'spawn' });
	});

	it('pins the locale to C for a call that asks, and for no other', async () => {
		vi.stubEnv('LANG', 'ja_JP.SJIS');
		vi.stubEnv('LC_ALL', 'fr_FR.ISO8859-1');
		try {
			const environmentOf = async (options?: SimulatorCommandOptions) =>
				JSON.parse(
					(
						await runSimulatorCommand(
							process.execPath,
							['-e', 'process.stdout.write(JSON.stringify(process.env))'],
							options
						)
					).stdout
				) as Record<string, string>;
			const desktop = await environmentOf();
			expect(desktop).toMatchObject({
				LANG: 'ja_JP.SJIS',
				LC_ALL: 'fr_FR.ISO8859-1',
			});
			expect(await environmentOf({ environment: { LC_ALL: 'C' } })).toEqual({
				...desktop,
				LC_ALL: 'C',
			});
			// Nothing else gets through, whatever a caller passes.
			expect(
				await environmentOf({
					environment: { LC_ALL: 'en_US.UTF-8', PATH: '/tmp' },
				} as unknown as SimulatorCommandOptions)
			).toEqual(desktop);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

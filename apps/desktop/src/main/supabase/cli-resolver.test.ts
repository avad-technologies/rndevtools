import { execFile } from 'node:child_process';
import {
	appendFile,
	chmod,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	utimes,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
	type SupabaseCliResolution,
	SupabaseCliResolver,
} from './cli-resolver';
import { type SupabaseCliRunRequest, SupabaseCliRunResult } from './cli-runner';

const uid = process.getuid?.() ?? 0;
const directories: string[] = [];

async function tempDirectory(): Promise<string> {
	const directory = await realpath(
		await mkdtemp(path.join(tmpdir(), 'rndevtools-supabase-resolver-'))
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

async function writePackage(directory: string, name: string, version: string) {
	await mkdir(directory, { recursive: true });
	await writeFile(
		path.join(directory, 'package.json'),
		JSON.stringify({ name, version, bin: { supabase: 'dist/supabase.js' } })
	);
}

/** A stand-in for the platform binary. The tests never execute it. */
async function writeBinary(
	platformRoot: string,
	mode = 0o755
): Promise<string> {
	await mkdir(path.join(platformRoot, 'bin'), { recursive: true });
	const binary = path.join(platformRoot, 'bin', 'supabase');
	await writeFile(binary, '#!/bin/sh\necho 2.121.0\n');
	await chmod(binary, mode);
	return binary;
}

/** npm or pnpm with a hoisted linker: both packages side by side. */
async function installHoisted(
	directory: string,
	version = '2.121.0',
	platformVersion = version
): Promise<string> {
	await writePackage(
		path.join(directory, 'node_modules', 'supabase'),
		'supabase',
		version
	);
	const platformRoot = path.join(
		directory,
		'node_modules',
		'@supabase',
		'cli-darwin-arm64'
	);
	await writePackage(
		platformRoot,
		'@supabase/cli-darwin-arm64',
		platformVersion
	);
	return writeBinary(platformRoot);
}

/** pnpm's isolated linker: the shim is a symlink into the store, with its platform package beside it. */
async function installIsolated(
	directory: string,
	version = '2.121.0'
): Promise<string> {
	const store = path.join(
		directory,
		'node_modules',
		'.pnpm',
		`supabase@${version}`,
		'node_modules'
	);
	await writePackage(path.join(store, 'supabase'), 'supabase', version);
	const platformRoot = path.join(store, '@supabase', 'cli-darwin-arm64');
	await writePackage(platformRoot, '@supabase/cli-darwin-arm64', version);
	const binary = await writeBinary(platformRoot);
	await symlink(
		path.join(store, 'supabase'),
		path.join(directory, 'node_modules', 'supabase')
	);
	return binary;
}

function versionResult(stdout: string, exitCode = 0): SupabaseCliRunResult {
	return new SupabaseCliRunResult(
		{
			exitCode,
			signal: null,
			timedOut: false,
			cancelled: false,
			signalsSent: [],
			stdoutBytes: stdout.length,
			stdoutTruncated: false,
			stderrLines: [],
			stderrTruncated: false,
			durationMs: 3,
		},
		stdout
	);
}

function fakeRunner(
	respond: (
		request: SupabaseCliRunRequest
	) => Promise<SupabaseCliRunResult> = async () => versionResult('2.121.0\n')
) {
	const requests: SupabaseCliRunRequest[] = [];
	return {
		requests,
		run: async (request: SupabaseCliRunRequest) => {
			requests.push(request);
			return respond(request);
		},
	};
}

async function setup(
	options: Readonly<{
		runner?: ReturnType<typeof fakeRunner>;
		uid?: number;
		platform?: NodeJS.Platform;
		arch?: string;
	}> = {}
) {
	const base = await tempDirectory();
	const worktree = path.join(base, 'worktree');
	await mkdir(worktree, { recursive: true });
	const runner = options.runner ?? fakeRunner();
	const probeCwd = path.join(base, 'cwd');
	const resolver = new SupabaseCliResolver({
		runner,
		probeCwd,
		uid: options.uid ?? uid,
		platform: options.platform ?? 'darwin',
		arch: options.arch ?? 'arm64',
	});
	return { base, worktree, runner, probeCwd, resolver };
}

function expectUnavailable(
	resolution: SupabaseCliResolution,
	reason: string,
	message?: string
) {
	expect(resolution).toMatchObject({ ok: false, reason });
	if (message !== undefined) expect(resolution).toMatchObject({ message });
	if (!resolution.ok) expect(resolution.recovery.length).toBeGreaterThan(0);
}

describe('SupabaseCliResolver.resolve', () => {
	it('resolves a hoisted install and probes its version from the neutral directory', async () => {
		const { worktree, runner, probeCwd, resolver } = await setup();
		const binary = await installHoisted(worktree);
		const resolution = await resolver.resolve({
			appPath: worktree,
			worktreeRoot: worktree,
		});
		expect(resolution).toMatchObject({
			ok: true,
			cli: {
				binaryPath: binary,
				binaryDirectory: path.dirname(binary),
				packageRoot: path.join(worktree, 'node_modules', 'supabase'),
				platformPackageRoot: path.join(
					worktree,
					'node_modules',
					'@supabase',
					'cli-darwin-arm64'
				),
				version: '2.121.0',
				dialect: { gate: 'verified', manageable: true },
			},
		});
		expect(runner.requests).toHaveLength(1);
		expect(runner.requests[0]).toMatchObject({
			binaryPath: binary,
			argv: ['--version'],
			readOnly: true,
			cwd: probeCwd,
		});
	});

	it('mirrors Node resolution through pnpm’s isolated store', async () => {
		const { worktree, resolver } = await setup();
		const binary = await installIsolated(worktree);
		const resolution = await resolver.resolve({
			appPath: worktree,
			worktreeRoot: worktree,
		});
		expect(resolution).toMatchObject({ ok: true, cli: { binaryPath: binary } });
		if (resolution.ok) {
			expect(resolution.cli.packageRoot).toBe(
				path.join(
					worktree,
					'node_modules',
					'.pnpm',
					'supabase@2.121.0',
					'node_modules',
					'supabase'
				)
			);
		}
	});

	it('prefers the app’s own install in a nested workspace, and finds the project root’s', async () => {
		const { worktree, resolver, runner } = await setup({
			runner: fakeRunner(async (request) =>
				versionResult(
					request.binaryPath.includes(`${path.sep}apps${path.sep}`)
						? '2.121.0\n'
						: '2.121.3\n'
				)
			),
		});
		const app = path.join(worktree, 'apps', 'mobile');
		await mkdir(app, { recursive: true });
		const appBinary = await installHoisted(app, '2.121.0');
		await installHoisted(worktree, '2.121.3');
		const fromApp = await resolver.resolve({
			appPath: app,
			worktreeRoot: worktree,
		});
		expect(fromApp).toMatchObject({
			ok: true,
			cli: { binaryPath: appBinary, version: '2.121.0' },
		});

		const other = await setup();
		const otherApp = path.join(other.worktree, 'apps', 'mobile');
		const backend = path.join(other.worktree, 'backend');
		await mkdir(otherApp, { recursive: true });
		const backendBinary = await installHoisted(backend);
		expect(
			await other.resolver.resolve({
				appPath: otherApp,
				projectRoot: backend,
				worktreeRoot: other.worktree,
			})
		).toMatchObject({ ok: true, cli: { binaryPath: backendBinary } });
		expect(runner.requests).toHaveLength(1);
	});

	it('never climbs above the worktree root or falls back to anything else', async () => {
		const { base, worktree, resolver, runner } = await setup();
		await installHoisted(base);
		expectUnavailable(
			await resolver.resolve({ appPath: worktree, worktreeRoot: worktree }),
			'not-installed',
			'CLI not installed in this worktree'
		);
		expect(runner.requests).toHaveLength(0);
	});

	it('requires the platform package and matching versions', async () => {
		const missing = await setup();
		await writePackage(
			path.join(missing.worktree, 'node_modules', 'supabase'),
			'supabase',
			'2.121.0'
		);
		expectUnavailable(
			await missing.resolver.resolve({
				appPath: missing.worktree,
				worktreeRoot: missing.worktree,
			}),
			'platform-package-missing'
		);
		const mismatched = await setup();
		await installHoisted(mismatched.worktree, '2.121.0', '2.121.1');
		expectUnavailable(
			await mismatched.resolver.resolve({
				appPath: mismatched.worktree,
				worktreeRoot: mismatched.worktree,
			}),
			'version-mismatch',
			'version mismatch between supabase and its platform package'
		);
		const invalid = await setup();
		await installHoisted(invalid.worktree);
		await writeFile(
			path.join(invalid.worktree, 'node_modules', 'supabase', 'package.json'),
			'{"name":"not-supabase","version":"2.121.0"}'
		);
		expectUnavailable(
			await invalid.resolver.resolve({
				appPath: invalid.worktree,
				worktreeRoot: invalid.worktree,
			}),
			'invalid-package'
		);
		expect(
			[missing, mismatched, invalid].every(
				(entry) => entry.runner.requests.length === 0
			)
		).toBe(true);
	});

	it('rejects binaries that are symlinks, writable by others, foreign or not executable', async () => {
		const cases: [
			string,
			(binary: string) => Promise<void>,
			string,
			number?,
		][] = [
			[
				'binary-symlink',
				async (binary) => {
					const real = `${binary}-real`;
					await writeFile(real, '#!/bin/sh\n');
					await chmod(real, 0o755);
					await rm(binary);
					await symlink(real, binary);
				},
				'binary is a symbolic link',
			],
			[
				'group-writable',
				(binary) => chmod(binary, 0o775),
				'binary is group-writable',
			],
			[
				'world-writable',
				(binary) => chmod(binary, 0o757),
				'binary is world-writable',
			],
			[
				'not-executable',
				(binary) => chmod(binary, 0o644),
				'binary is not executable',
			],
			[
				'foreign-owner',
				async () => undefined,
				'binary is owned by another user',
				uid + 1,
			],
		];
		for (const [reason, mutate, message, ownerUid] of cases) {
			const context = await setup({
				...(ownerUid === undefined ? {} : { uid: ownerUid }),
			});
			const binary = await installHoisted(context.worktree);
			await mutate(binary);
			expectUnavailable(
				await context.resolver.resolve({
					appPath: context.worktree,
					worktreeRoot: context.worktree,
				}),
				reason,
				message
			);
			expect(context.runner.requests).toHaveLength(0);
		}
	});

	it('accepts node_modules symlinked to the main checkout, and nothing further away', async () => {
		const { base, worktree, resolver } = await setup();
		const main = path.join(base, 'main');
		await mkdir(main, { recursive: true });
		const binary = await installHoisted(main);
		await symlink(
			path.join(main, 'node_modules'),
			path.join(worktree, 'node_modules')
		);
		expectUnavailable(
			await resolver.resolve({ appPath: worktree, worktreeRoot: worktree }),
			'outside-worktree',
			'CLI resolves outside this worktree and its main checkout'
		);
		expect(
			await resolver.resolve({
				appPath: worktree,
				worktreeRoot: worktree,
				mainCheckoutRoot: main,
			})
		).toMatchObject({ ok: true, cli: { binaryPath: binary } });

		const elsewhere = await setup();
		const shared = path.join(elsewhere.base, 'shared');
		await mkdir(shared, { recursive: true });
		await installHoisted(shared);
		await symlink(
			path.join(shared, 'node_modules'),
			path.join(elsewhere.worktree, 'node_modules')
		);
		expectUnavailable(
			await elsewhere.resolver.resolve({
				appPath: elsewhere.worktree,
				worktreeRoot: elsewhere.worktree,
				mainCheckoutRoot: main,
			}),
			'outside-worktree'
		);
	});

	it('requires the binary to report its package version', async () => {
		const disagreeing = await setup({
			runner: fakeRunner(async () => versionResult('2.121.3\n')),
		});
		await installHoisted(disagreeing.worktree);
		expectUnavailable(
			await disagreeing.resolver.resolve({
				appPath: disagreeing.worktree,
				worktreeRoot: disagreeing.worktree,
			}),
			'binary-version-mismatch'
		);
		for (const respond of [
			async () => versionResult('', 1),
			async () => versionResult('Supabase CLI\n'),
			async () => {
				throw new Error('spawn EACCES');
			},
		]) {
			const failing = await setup({ runner: fakeRunner(respond) });
			await installHoisted(failing.worktree);
			const input = {
				appPath: failing.worktree,
				worktreeRoot: failing.worktree,
			};
			expectUnavailable(
				await failing.resolver.resolve(input),
				'version-probe-failed'
			);
			// A failed probe is not cached; the next resolve probes again.
			await failing.resolver.resolve(input);
			expect(failing.runner.requests).toHaveLength(2);
		}
	});

	it('caches probes by realpath, size, mtime and inode', async () => {
		const { worktree, resolver, runner } = await setup();
		const binary = await installHoisted(worktree);
		const input = { appPath: worktree, worktreeRoot: worktree };
		await resolver.resolve(input);
		await resolver.resolve(input);
		expect(runner.requests).toHaveLength(1);
		const later = new Date(Date.now() + 60_000);
		await utimes(binary, later, later);
		await resolver.resolve(input);
		expect(runner.requests).toHaveLength(2);
	});

	it('notices a binary replaced while it was being verified', async () => {
		let binaryPath = '';
		const context = await setup({
			runner: fakeRunner(async () => {
				await appendFile(binaryPath, '# replaced\n');
				return versionResult('2.121.0\n');
			}),
		});
		binaryPath = await installHoisted(context.worktree);
		expectUnavailable(
			await context.resolver.resolve({
				appPath: context.worktree,
				worktreeRoot: context.worktree,
			}),
			'binary-changed'
		);
	});

	it('gates newer patches as compatible, managed only when allowed', async () => {
		const { worktree, resolver } = await setup({
			runner: fakeRunner(async () => versionResult('2.121.3\n')),
		});
		await installHoisted(worktree, '2.121.3');
		const observed = await resolver.resolve({
			appPath: worktree,
			worktreeRoot: worktree,
		});
		expect(observed).toMatchObject({
			ok: true,
			cli: {
				version: '2.121.3',
				dialect: { gate: 'compatible', manageable: false },
			},
		});
		expect(
			await resolver.resolve({
				appPath: worktree,
				worktreeRoot: worktree,
				allowUnverifiedPatch: true,
			})
		).toMatchObject({
			ok: true,
			cli: { dialect: { gate: 'compatible', manageable: true } },
		});
	});

	it('is offered only on Apple-silicon Macs', async () => {
		const platforms: Readonly<{ platform?: NodeJS.Platform; arch?: string }>[] =
			[{ platform: 'linux' }, { arch: 'x64' }];
		for (const options of platforms) {
			const context = await setup(options);
			await installHoisted(context.worktree);
			expectUnavailable(
				await context.resolver.resolve({
					appPath: context.worktree,
					worktreeRoot: context.worktree,
				}),
				'unsupported-platform'
			);
		}
	});

	it('rejects search roots outside the worktree', async () => {
		const { base, worktree, resolver } = await setup();
		await expect(
			resolver.resolve({ appPath: base, worktreeRoot: worktree })
		).rejects.toThrow(TypeError);
		await expect(
			resolver.resolve({
				appPath: worktree,
				projectRoot: path.join(base, 'elsewhere'),
				worktreeRoot: worktree,
			})
		).rejects.toThrow(TypeError);
		await expect(
			resolver.resolve({ appPath: 'relative', worktreeRoot: worktree })
		).rejects.toThrow(TypeError);
	});
});

describe('SupabaseCliResolver.validateBinary', () => {
	it('accepts a running owner’s binary only when it passes every check', async () => {
		const { base, worktree, resolver } = await setup();
		const binary = await installHoisted(worktree);
		expect(
			await resolver.validateBinary({
				binaryPath: binary,
				allowedRoots: [worktree],
			})
		).toMatchObject({
			ok: true,
			cli: { binaryPath: binary, packageRoot: undefined },
		});
		expectUnavailable(
			await resolver.validateBinary({
				binaryPath: binary,
				allowedRoots: [path.join(base, 'other')],
			}),
			'outside-worktree'
		);
		expectUnavailable(
			await resolver.validateBinary({
				binaryPath: '/usr/bin/true',
				allowedRoots: [worktree],
			}),
			'invalid-package'
		);
		const impostor = path.join(worktree, 'tools', 'bin', 'supabase');
		await mkdir(path.dirname(impostor), { recursive: true });
		await writeFile(impostor, '#!/bin/sh\n');
		await chmod(impostor, 0o755);
		expectUnavailable(
			await resolver.validateBinary({
				binaryPath: impostor,
				allowedRoots: [worktree],
			}),
			'invalid-package'
		);
		const linked = path.join(
			worktree,
			'linked',
			'node_modules',
			'@supabase',
			'cli-darwin-arm64'
		);
		await writePackage(linked, '@supabase/cli-darwin-arm64', '2.121.0');
		await mkdir(path.join(linked, 'bin'), { recursive: true });
		await symlink(binary, path.join(linked, 'bin', 'supabase'));
		expectUnavailable(
			await resolver.validateBinary({
				binaryPath: path.join(linked, 'bin', 'supabase'),
				allowedRoots: [worktree],
			}),
			'binary-symlink'
		);
	});

	it('refuses a package.json that is a FIFO without waiting for a writer', async () => {
		const { worktree, resolver } = await setup();
		const platformRoot = path.join(
			worktree,
			'node_modules',
			'@supabase',
			'cli-darwin-arm64'
		);
		const binary = await writeBinary(platformRoot);
		await promisify(execFile)('/usr/bin/mkfifo', [
			path.join(platformRoot, 'package.json'),
		]);
		expectUnavailable(
			await resolver.validateBinary({
				binaryPath: binary,
				allowedRoots: [worktree],
			}),
			'invalid-package'
		);
	});
});

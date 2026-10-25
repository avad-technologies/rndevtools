import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	createSupabaseDiscovery,
	type PortsDatabase,
	type ProbeExecutable,
	type ProbeRunner,
	type ProbeRunResult,
} from './discovery';
import { supabaseArgvDigest } from './job-store';

type ProbeOutput = { exitCode: number; lines: string[] };
type StackFixture = {
	id: string;
	ownerPid: number;
	executable: string;
	stateRoot: string;
	cacheRoot: string;
	treePids?: number[];
	launcherPids?: number[];
	listenerPorts?: number[];
};
type ReservationRow = {
	state_root: string;
	stack_id: string;
	endpoint: string;
	port: number;
};
type ProbeFixture = {
	uid: number;
	stacks: { repo: StackFixture; wtC: StackFixture; exampleApp: StackFixture };
	pgrepOwners: ProbeOutput;
	pgrepLaunchersRepo: ProbeOutput;
	pgrepChildrenRepo: (ProbeOutput & { parents: string })[];
	lsofTcpRepo: ProbeOutput;
	lsofUdpNone: ProbeOutput;
	lsofTcpMixed: ProbeOutput;
	lsofUdpMixed: ProbeOutput;
	sysctlShmmni: ProbeOutput;
	ipcsTwoSegments: ProbeOutput;
	ipcsNoSegments: ProbeOutput;
	psRssRepo: ProbeOutput & { totalKilobytes: number };
	diskKilobytes: { stack: number; cache: number };
	portReservations: ReservationRow[];
	invalidPortReservations: ReservationRow[];
};

const fixture = JSON.parse(
	readFileSync(
		new URL(
			'./__fixtures__/supabase-2.121.0/discovery-probes.json',
			import.meta.url
		),
		'utf8'
	)
) as ProbeFixture;
const { repo, wtC, exampleApp } = fixture.stacks;
const ALLOWED_EXECUTABLES = new Set([
	'/usr/bin/pgrep',
	'/bin/ps',
	'/usr/sbin/lsof',
	'/usr/sbin/sysctl',
	'/usr/bin/ipcs',
	'/usr/bin/du',
]);

type ProbeCall = Parameters<ProbeRunner>[0];

function exit(output: ProbeOutput, stderr = ''): ProbeRunResult {
	return {
		kind: 'exit',
		exitCode: output.exitCode,
		stdout: output.lines.length > 0 ? `${output.lines.join('\n')}\n` : '',
		stderr,
	};
}

/** Answers probes from a table keyed by `executable args...`. */
function fakeRunner(
	answers: Record<string, ProbeRunResult | (() => ProbeRunResult)>
): { run: ProbeRunner; calls: ProbeCall[] } {
	const calls: ProbeCall[] = [];
	const run: ProbeRunner = async (request) => {
		calls.push(request);
		const answer = answers[[request.executable, ...request.args].join(' ')];
		if (typeof answer === 'function') return answer();
		return (
			answer ?? {
				kind: 'exit',
				exitCode: 99,
				stdout: '',
				stderr: 'unexpected probe',
			}
		);
	};
	return { run, calls };
}

function command(executable: ProbeExecutable, ...args: string[]): string {
	return [executable, ...args].join(' ');
}

function discovery(
	answers: Record<string, ProbeRunResult | (() => ProbeRunResult)>,
	options: Parameters<typeof createSupabaseDiscovery>[0] = {}
) {
	const runner = fakeRunner(answers);
	return {
		probes: createSupabaseDiscovery({
			platform: 'darwin',
			uid: fixture.uid,
			...options,
			run: runner.run,
		}),
		calls: runner.calls,
	};
}

const OWNERS = command(
	'/usr/bin/pgrep',
	'-U',
	'501',
	'-lf',
	'__supabase_stack_host__'
);
const LAUNCHERS = command(
	'/usr/bin/pgrep',
	'-U',
	'501',
	'-lf',
	`supabase-stack-id=${repo.id}`
);

function lsofCommand(pids: readonly number[], protocol: 'tcp' | 'udp'): string {
	return command(
		'/usr/sbin/lsof',
		'-nP',
		'-w',
		'-a',
		'-p',
		pids.join(','),
		...(protocol === 'tcp' ? ['-iTCP', '-sTCP:LISTEN'] : ['-iUDP']),
		'-F',
		'pcnPt'
	);
}

describe('discoverOwners', () => {
	it('parses owner argv recorded from the spike, spaces included', async () => {
		const { probes, calls } = discovery({
			[OWNERS]: exit(fixture.pgrepOwners),
		});
		expect(await probes.discoverOwners()).toEqual({
			status: 'ok',
			owners: [repo, wtC, exampleApp].map((stack) => ({
				pid: stack.ownerPid,
				executable: stack.executable,
				stackId: stack.id,
				stateRoot: stack.stateRoot,
				cacheRoot: stack.cacheRoot,
			})),
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			executable: '/usr/bin/pgrep',
			args: ['-U', '501', '-lf', '__supabase_stack_host__'],
		});
		expect(calls[0]?.timeoutMs).toBeLessThanOrEqual(10_000);
		expect(calls[0]?.maxOutputBytes).toBeLessThanOrEqual(1024 * 1024);
	});

	it('keeps an owner but drops its roots when spaces make them ambiguous', async () => {
		const line = `777 /opt/sb/bin/supabase __supabase_stack_host__ /x /y /z ${repo.id}`;
		const { probes } = discovery({
			[OWNERS]: exit({ exitCode: 0, lines: [line] }),
		});
		expect(await probes.discoverOwners()).toEqual({
			status: 'ok',
			owners: [
				{ pid: 777, executable: '/opt/sb/bin/supabase', stackId: repo.id },
			],
		});
	});

	it('treats pgrep exit 1 as no owners and other failures as unavailable', async () => {
		expect(
			await discovery({
				[OWNERS]: exit({ exitCode: 1, lines: [] }),
			}).probes.discoverOwners()
		).toEqual({ status: 'ok', owners: [] });
		expect(
			await discovery({
				[OWNERS]: exit(
					{ exitCode: 2, lines: [] },
					'pgrep: illegal option -- Z\nusage'
				),
			}).probes.discoverOwners()
		).toEqual({
			status: 'unavailable',
			reason: 'command-failed',
			detail: 'pgrep exited 2: pgrep: illegal option -- Z',
		});
		expect(
			await discovery({
				[OWNERS]: { kind: 'error', reason: 'timeout' },
			}).probes.discoverOwners()
		).toEqual({ status: 'unavailable', reason: 'timeout' });
	});

	it('keeps failure details single-line, redacted and bounded', async () => {
		const result = await discovery({
			[OWNERS]: exit(
				{ exitCode: 3, lines: [] },
				`\u001b[31mpgrep: token=abc123 ${'x'.repeat(400)}\nsecond line`
			),
		}).probes.discoverOwners();
		const detail = result.status === 'unavailable' ? (result.detail ?? '') : '';
		expect(detail).toContain('token=[REDACTED]');
		expect(detail).not.toContain('abc123');
		expect(detail).not.toContain('second line');
		expect(detail).not.toMatch(/\p{Cc}/u);
		expect(detail.length).toBeLessThanOrEqual(200);
	});

	it('runs nothing off macOS or without a uid', async () => {
		const linux = discovery({}, { platform: 'linux' });
		expect(await linux.probes.discoverOwners()).toMatchObject({
			status: 'unavailable',
			reason: 'unsupported-platform',
		});
		expect(await linux.probes.checkExposure([1])).toMatchObject({
			reason: 'unsupported-platform',
		});
		expect(await linux.probes.readSysvCapacity()).toMatchObject({
			reason: 'unsupported-platform',
		});
		expect(linux.calls).toEqual([]);
		const noUid = discovery({}, { uid: -1 });
		expect(await noUid.probes.processTree(repo.ownerPid)).toMatchObject({
			reason: 'unsupported-platform',
		});
		expect(noUid.calls).toEqual([]);
	});

	it('resolves a typed result when the runner itself throws', async () => {
		const probes = createSupabaseDiscovery({
			platform: 'darwin',
			uid: fixture.uid,
			run: () => {
				throw new Error('runner bug');
			},
		});
		expect(await probes.discoverOwners()).toEqual({
			status: 'unavailable',
			reason: 'spawn-failed',
		});
	});
});

describe('processTree', () => {
	function treeAnswers(): Record<string, ProbeRunResult> {
		return {
			[LAUNCHERS]: exit(fixture.pgrepLaunchersRepo),
			...Object.fromEntries(
				fixture.pgrepChildrenRepo.map((level) => [
					command('/usr/bin/pgrep', '-P', level.parents),
					exit(level),
				])
			),
		};
	}

	it('walks the owner, its launchers and their children level by level', async () => {
		const { probes, calls } = discovery(treeAnswers());
		expect(
			await probes.processTree(repo.ownerPid, { stackId: repo.id })
		).toEqual({
			status: 'ok',
			rootPid: repo.ownerPid,
			pids: repo.treePids,
			launcherPids: repo.launcherPids,
		});
		expect(
			calls.map((call) => [call.executable, ...call.args].join(' '))
		).toEqual([
			LAUNCHERS,
			...fixture.pgrepChildrenRepo.map((level) =>
				command('/usr/bin/pgrep', '-P', level.parents)
			),
		]);
	});

	it('finds launchers that were reparented away from the owner', async () => {
		const { probes } = discovery({
			[LAUNCHERS]: exit(fixture.pgrepLaunchersRepo),
			[command('/usr/bin/pgrep', '-P', `${repo.ownerPid},20085`)]: exit({
				exitCode: 1,
				lines: [],
			}),
		});
		expect(
			await probes.processTree(repo.ownerPid, { stackId: repo.id })
		).toEqual({
			status: 'ok',
			rootPid: repo.ownerPid,
			pids: [repo.ownerPid, 20085],
			launcherPids: [20085],
		});
	});

	it('skips the launcher probe without a stack id', async () => {
		const { probes, calls } = discovery({
			[command('/usr/bin/pgrep', '-P', String(repo.ownerPid))]: exit({
				exitCode: 0,
				lines: ['20085'],
			}),
			[command('/usr/bin/pgrep', '-P', '20085')]: exit({
				exitCode: 1,
				lines: [],
			}),
		});
		expect(await probes.processTree(repo.ownerPid)).toMatchObject({
			pids: [repo.ownerPid, 20085],
			launcherPids: [],
		});
		expect(calls).toHaveLength(2);
	});

	it('fails closed when a level cannot be read', async () => {
		expect(
			await discovery({
				[LAUNCHERS]: exit(fixture.pgrepLaunchersRepo),
				[command('/usr/bin/pgrep', '-P', `${repo.ownerPid},20085`)]: exit(
					{ exitCode: 3, lines: [] },
					'pgrep: cannot get process list'
				),
			}).probes.processTree(repo.ownerPid, { stackId: repo.id })
		).toMatchObject({ status: 'unavailable', reason: 'command-failed' });
		expect(
			await discovery({
				[command('/usr/bin/pgrep', '-P', String(repo.ownerPid))]: exit({
					exitCode: 0,
					lines: ['20085 supabase'],
				}),
			}).probes.processTree(repo.ownerPid)
		).toMatchObject({ status: 'unavailable', reason: 'unparseable' });
	});

	it('bounds a runaway tree', async () => {
		let next = 100_000;
		const { probes } = discovery({});
		const runaway = createSupabaseDiscovery({
			platform: 'darwin',
			uid: fixture.uid,
			run: async () => {
				next += 64;
				return {
					kind: 'exit',
					exitCode: 0,
					stdout: Array.from({ length: 64 }, (_, index) => next + index).join(
						'\n'
					),
					stderr: '',
				};
			},
		});
		expect(await runaway.processTree(1_000)).toMatchObject({
			status: 'unavailable',
			reason: 'too-many',
		});
		expect(await probes.processTree(0)).toMatchObject({
			reason: 'invalid-input',
		});
		expect(await probes.processTree(1, { stackId: 'abc' })).toMatchObject({
			reason: 'invalid-input',
		});
	});
});

describe('checkExposure', () => {
	it('confirms a native stack listens on loopback only', async () => {
		const pids = repo.treePids ?? [];
		const { probes, calls } = discovery({
			[lsofCommand(pids, 'tcp')]: exit(fixture.lsofTcpRepo),
			[lsofCommand(pids, 'udp')]: exit(fixture.lsofUdpNone),
		});
		const result = await probes.checkExposure(pids);
		if (result.status !== 'ok') throw new Error(result.reason);
		expect(result.nonLoopback).toEqual([]);
		expect(result.pids).toEqual(pids);
		expect(result.listeners.map((listener) => listener.port).sort()).toEqual(
			repo.listenerPorts
		);
		expect(result.listeners[0]).toEqual({
			pid: repo.ownerPid,
			command: 'supabase',
			protocol: 'tcp',
			family: 'ipv4',
			address: '127.0.0.1',
			port: 61_600,
			loopback: true,
		});
		expect(calls.map((call) => call.executable)).toEqual([
			'/usr/sbin/lsof',
			'/usr/sbin/lsof',
		]);
	});

	it('flags wildcard, LAN and link-local listeners, and ignores connected UDP', async () => {
		const pids = [wtC.ownerPid, 20_228];
		const { probes } = discovery({
			[lsofCommand(pids, 'tcp')]: exit(fixture.lsofTcpMixed),
			[lsofCommand(pids, 'udp')]: exit(fixture.lsofUdpMixed),
		});
		const result = await probes.checkExposure([...pids, wtC.ownerPid]);
		if (result.status !== 'ok') throw new Error(result.reason);
		expect(
			result.nonLoopback.map(
				(listener) =>
					`${listener.protocol} ${listener.address}:${listener.port} ${listener.pid}`
			)
		).toEqual([
			'tcp *:54321 20218',
			'tcp *:54321 20218',
			'tcp fe80:4::1c2a:9eff:fe31:8a10:30833 20218',
			'tcp 192.168.1.20:30834 20228',
			'udp *:5353 20218',
		]);
		expect(
			result.listeners
				.filter((listener) => listener.loopback)
				.map(
					(listener) =>
						`${listener.protocol} ${listener.address}:${listener.port}`
				)
		).toEqual(['tcp 127.0.0.1:30831', 'tcp ::1:30832', 'udp 127.0.0.1:41000']);
		expect(
			result.listeners.find((listener) => listener.pid === 20_228)
		).toMatchObject({
			command: '.postgres-wrapped',
			family: 'ipv4',
		});
	});

	it('fails closed when lsof cannot answer', async () => {
		const pids = [repo.ownerPid];
		const failing = await discovery({
			[lsofCommand(pids, 'tcp')]: exit(
				{ exitCode: 1, lines: [] },
				'lsof: status error on 20075: Operation not permitted'
			),
			[lsofCommand(pids, 'udp')]: exit(fixture.lsofUdpNone),
		}).probes.checkExposure(pids);
		expect(failing).toMatchObject({
			status: 'unavailable',
			reason: 'command-failed',
		});
		const timedOut = await discovery({
			[lsofCommand(pids, 'tcp')]: { kind: 'error', reason: 'timeout' },
			[lsofCommand(pids, 'udp')]: exit(fixture.lsofUdpNone),
		}).probes.checkExposure(pids);
		expect(timedOut).toEqual({ status: 'unavailable', reason: 'timeout' });
		const garbled = await discovery({
			[lsofCommand(pids, 'tcp')]: exit({
				exitCode: 0,
				lines: ['n127.0.0.1:1'],
			}),
			[lsofCommand(pids, 'udp')]: exit(fixture.lsofUdpNone),
		}).probes.checkExposure(pids);
		expect(garbled).toMatchObject({
			status: 'unavailable',
			reason: 'unparseable',
		});
	});

	it('validates the pid list before running anything', async () => {
		const { probes, calls } = discovery({});
		expect(await probes.checkExposure([])).toMatchObject({
			reason: 'invalid-input',
		});
		expect(await probes.checkExposure([1, -2])).toMatchObject({
			reason: 'invalid-input',
		});
		expect(await probes.checkExposure([1.5])).toMatchObject({
			reason: 'invalid-input',
		});
		expect(
			await probes.checkExposure(
				Array.from({ length: 600 }, (_, index) => index + 1)
			)
		).toMatchObject({ reason: 'too-many' });
		expect(calls).toEqual([]);
	});
});

describe('readSysvCapacity', () => {
	const SYSCTL = command('/usr/sbin/sysctl', '-n', 'kern.sysv.shmmni');
	const IPCS = command('/usr/bin/ipcs', '-m');

	it('counts segments in use against kern.sysv.shmmni', async () => {
		expect(
			await discovery({
				[SYSCTL]: exit(fixture.sysctlShmmni),
				[IPCS]: exit(fixture.ipcsTwoSegments),
			}).probes.readSysvCapacity()
		).toEqual({
			status: 'ok',
			shmmni: 32,
			segments: { status: 'ok', used: 2, free: 30 },
		});
		expect(
			await discovery({
				[SYSCTL]: exit(fixture.sysctlShmmni),
				[IPCS]: exit(fixture.ipcsNoSegments),
			}).probes.readSysvCapacity()
		).toMatchObject({ segments: { used: 0, free: 32 } });
	});

	it('keeps the limit when ipcs is unavailable, and fails without sysctl', async () => {
		expect(
			await discovery({
				[SYSCTL]: exit(fixture.sysctlShmmni),
				[IPCS]: { kind: 'error', reason: 'spawn' },
			}).probes.readSysvCapacity()
		).toEqual({
			status: 'ok',
			shmmni: 32,
			segments: { status: 'unavailable', reason: 'spawn-failed' },
		});
		expect(
			await discovery({
				[SYSCTL]: exit({ exitCode: 0, lines: ['kern.sysv.shmmni: 32'] }),
			}).probes.readSysvCapacity()
		).toMatchObject({ status: 'unavailable', reason: 'unparseable' });
		expect(
			await discovery({
				[SYSCTL]: exit({ exitCode: 1, lines: [] }, 'sysctl: unknown oid'),
			}).probes.readSysvCapacity()
		).toMatchObject({ status: 'unavailable', reason: 'command-failed' });
	});
});

describe('measureMemory', () => {
	it('sums the RSS of the requested processes and labels it RSS', async () => {
		const pids = repo.treePids ?? [];
		const { probes, calls } = discovery({
			[command('/bin/ps', '-o', 'pid=,rss=', '-p', pids.join(','))]: exit(
				fixture.psRssRepo
			),
		});
		expect(await probes.measureMemory(pids)).toEqual({
			status: 'ok',
			metric: 'rss',
			bytes: fixture.psRssRepo.totalKilobytes * 1024,
			processCount: pids.length,
		});
		expect(calls[0]?.executable).toBe('/bin/ps');
	});

	it('ignores rows it did not ask for and degrades when ps cannot run', async () => {
		const ps = command('/bin/ps', '-o', 'pid=,rss=', '-p', '1,2');
		expect(
			await discovery({
				[ps]: exit({ exitCode: 1, lines: ['    1  2048', '  999  4096'] }),
			}).probes.measureMemory([1, 2])
		).toEqual({
			status: 'ok',
			metric: 'rss',
			bytes: 2048 * 1024,
			processCount: 1,
		});
		expect(
			await discovery({
				[ps]: { kind: 'error', reason: 'spawn' },
			}).probes.measureMemory([1, 2])
		).toEqual({ status: 'unavailable', reason: 'spawn-failed' });
		expect(
			await discovery({
				[ps]: exit({ exitCode: 0, lines: ['PID RSS'] }),
			}).probes.measureMemory([1, 2])
		).toMatchObject({ status: 'unavailable', reason: 'unparseable' });
	});
});

describe('processCommand', () => {
	it('reads one command line with ps, and none once the pid is gone', async () => {
		const ps = command('/bin/ps', '-ww', '-o', 'args=', '-p', '4242');
		const line =
			'/Users/example/ExampleApp/node_modules/@supabase/cli-darwin-arm64/bin/supabase stack stop --stack-id 64616c83 --output-format json';
		expect(
			await discovery({
				[ps]: exit({ exitCode: 0, lines: [line] }),
			}).probes.processCommand(4_242)
		).toEqual({ status: 'ok', command: line });
		expect(
			await discovery({
				[ps]: exit({ exitCode: 1, lines: [] }),
			}).probes.processCommand(4_242)
		).toEqual({ status: 'ok', command: undefined });
		expect(
			await discovery({
				[ps]: { kind: 'error', reason: 'spawn' },
			}).probes.processCommand(4_242)
		).toEqual({ status: 'unavailable', reason: 'spawn-failed' });
		const none = discovery({});
		expect(await none.probes.processCommand(1)).toMatchObject({
			status: 'unavailable',
			reason: 'invalid-input',
		});
		expect(none.calls).toEqual([]);
	});

	it('reads the line ps escapes without a UTF-8 locale, which the argv digest still matches', async () => {
		const worktree = '/Users/example/D\u00e9veloppement/ExampleApp';
		const argv = [
			`${worktree}/node_modules/@supabase/cli-darwin-arm64/bin/supabase`,
			'stack',
			'stop',
			'--stack-id',
			'64616c83',
			'--output-format',
			'json',
		];
		// What /bin/ps prints for it with no LANG or LC_ALL, the C locale a
		// desktop opened from the Dock passes on.
		const line =
			'/Users/example/DM-CM-)veloppement/ExampleApp/node_modules/@supabase/cli-darwin-arm64/bin/supabase stack stop --stack-id 64616c83 --output-format json';
		const found = await discovery({
			[command('/bin/ps', '-ww', '-o', 'args=', '-p', '4242')]: exit({
				exitCode: 0,
				lines: [line],
			}),
		}).probes.processCommand(4_242);
		if (found.status !== 'ok') throw new Error(found.reason);
		expect(found.command).toBe(line);
		expect(supabaseArgvDigest([found.command ?? ''])).toBe(
			supabaseArgvDigest(argv)
		);
	});
});

describe('measureDisk', () => {
	let root: string;
	let supabaseHome: string;

	beforeEach(async () => {
		root = await realpath(
			await mkdtemp(path.join(os.tmpdir(), 'rndevtools-supabase-disk-'))
		);
		supabaseHome = path.join(root, 'home', '.supabase');
		await mkdir(path.join(supabaseHome, 'stacks', repo.id, 'data'), {
			recursive: true,
		});
		await mkdir(path.join(supabaseHome, 'cache', 'stack'), { recursive: true });
		await mkdir(path.join(root, 'elsewhere'));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it('measures only paths under the stacks directory or the cache', async () => {
		const stack = path.join(supabaseHome, 'stacks', repo.id);
		const cache = path.join(supabaseHome, 'cache', 'stack');
		const escapeLink = path.join(supabaseHome, 'stacks', 'escape');
		await symlink(path.join(root, 'elsewhere'), escapeLink);
		const du = command('/usr/bin/du', '-sk', stack, cache);
		const { probes, calls } = discovery(
			{
				[du]: exit({
					exitCode: 0,
					lines: [
						`${fixture.diskKilobytes.stack}\t${stack}`,
						`${fixture.diskKilobytes.cache}\t${cache}`,
					],
				}),
			},
			{ supabaseHome }
		);
		expect(
			await probes.measureDisk([
				stack,
				cache,
				path.join(root, 'elsewhere'),
				escapeLink,
				path.join(supabaseHome, 'stacks', 'missing'),
				'relative/stacks',
				`${stack}/../../../..`,
			])
		).toEqual({
			status: 'ok',
			entries: [
				{
					path: stack,
					status: 'ok',
					bytes: fixture.diskKilobytes.stack * 1024,
				},
				{
					path: cache,
					status: 'ok',
					bytes: fixture.diskKilobytes.cache * 1024,
				},
				{
					path: path.join(root, 'elsewhere'),
					status: 'unavailable',
					reason: 'outside-supabase-home',
				},
				{
					path: escapeLink,
					status: 'unavailable',
					reason: 'outside-supabase-home',
				},
				{
					path: path.join(supabaseHome, 'stacks', 'missing'),
					status: 'unavailable',
					reason: 'missing',
				},
				{
					path: 'relative/stacks',
					status: 'unavailable',
					reason: 'invalid-path',
				},
				{
					path: `${stack}/../../../..`,
					status: 'unavailable',
					reason: 'outside-supabase-home',
				},
			],
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.args).toEqual(['-sk', stack, cache]);
	});

	it('reports what du printed even when it exits non-zero, and bounds input', async () => {
		const stack = path.join(supabaseHome, 'stacks', repo.id);
		const du = command('/usr/bin/du', '-sk', stack);
		expect(
			await discovery(
				{
					[du]: exit({ exitCode: 1, lines: [] }, 'du: data: Permission denied'),
				},
				{ supabaseHome }
			).probes.measureDisk([stack])
		).toEqual({
			status: 'ok',
			entries: [{ path: stack, status: 'unavailable', reason: 'not-reported' }],
		});
		expect(
			await discovery(
				{ [du]: { kind: 'error', reason: 'timeout' } },
				{ supabaseHome }
			).probes.measureDisk([stack])
		).toEqual({ status: 'unavailable', reason: 'timeout' });
		const tooMany = discovery({}, { supabaseHome });
		expect(
			await tooMany.probes.measureDisk(Array.from({ length: 65 }, () => stack))
		).toMatchObject({ reason: 'too-many' });
		expect(await tooMany.probes.measureDisk([])).toEqual({
			status: 'ok',
			entries: [],
		});
		expect(tooMany.calls).toEqual([]);
	});
});

describe('readPortReservations', () => {
	let home: string;
	let file: string;

	beforeEach(async () => {
		home = await realpath(
			await mkdtemp(path.join(os.tmpdir(), 'rndevtools-supabase-ports-'))
		);
		file = path.join(home, '.supabase', 'ports.sqlite');
		await mkdir(path.dirname(file), { recursive: true });
	});

	afterEach(async () => {
		await rm(home, { recursive: true, force: true });
	});

	const SCHEMA = `CREATE TABLE IF NOT EXISTS reservation (
  port INTEGER PRIMARY KEY,
  state_root TEXT NOT NULL,
  stack_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  UNIQUE (state_root, stack_id, endpoint)
)`;

	function createRegistry(
		target: string,
		rows: readonly ReservationRow[]
	): void {
		const database = new DatabaseSync(target);
		database.exec(SCHEMA);
		const insert = database.prepare(
			'INSERT INTO reservation (port, state_root, stack_id, endpoint) VALUES (?, ?, ?, ?)'
		);
		for (const row of rows) {
			insert.run(row.port, row.state_root, row.stack_id, row.endpoint);
		}
		database.close();
	}

	it('reads the real schema read-only and validates every row', async () => {
		createRegistry(file, [
			...fixture.portReservations,
			...fixture.invalidPortReservations,
		]);
		const before = statSync(file);
		const result = await createSupabaseDiscovery({
			homeDirectory: home,
		}).readPortReservations();
		expect(result).toEqual({
			status: 'ok',
			file,
			reservations: [...fixture.portReservations]
				.sort((left, right) => left.port - right.port)
				.map((row) => ({
					stateRoot: row.state_root,
					stackId: row.stack_id,
					endpoint: row.endpoint,
					port: row.port,
				})),
			skippedRows: fixture.invalidPortReservations.length,
			truncated: false,
		});
		const after = statSync(file);
		expect(after.mtimeMs).toBe(before.mtimeMs);
		expect(after.size).toBe(before.size);
		expect(existsSync(`${file}-journal`)).toBe(false);
	});

	it('degrades instead of recovering a hot journal it may not write', async () => {
		const source = path.join(home, 'writer.sqlite');
		const writer = new DatabaseSync(source);
		writer.exec('PRAGMA journal_mode = DELETE; PRAGMA cache_size = 1');
		writer.exec(SCHEMA);
		const insert = writer.prepare(
			'INSERT INTO reservation (port, state_root, stack_id, endpoint) VALUES (?, ?, ?, ?)'
		);
		// One transaction for the seed rows: 2,000 autocommits would fsync each.
		writer.exec('BEGIN');
		for (let index = 0; index < 2_000; index += 1) {
			insert.run(
				20_000 + index,
				'/tmp/supa/stacks',
				repo.id,
				`endpoint-${index}`
			);
		}
		writer.exec('COMMIT');
		writer.exec('BEGIN');
		writer.exec(
			"UPDATE reservation SET endpoint = endpoint || '-renamed-to-dirty-many-pages'"
		);
		// Copying mid-transaction leaves a hot journal next to the copy, the
		// state a CLI writer that crashed mid-write would leave behind.
		copyFileSync(source, file);
		copyFileSync(`${source}-journal`, `${file}-journal`);
		writer.exec('ROLLBACK');
		writer.close();
		const journal = readFileSync(`${file}-journal`);
		expect(
			await createSupabaseDiscovery({
				homeDirectory: home,
			}).readPortReservations()
		).toEqual({
			status: 'unavailable',
			reason: 'needs-recovery',
			detail: 'sqlite errcode 776',
		});
		expect(readFileSync(`${file}-journal`).equals(journal)).toBe(true);
	});

	it('reports a missing, misplaced, corrupt or foreign registry', async () => {
		const probes = createSupabaseDiscovery({ homeDirectory: home });
		expect(await probes.readPortReservations()).toEqual({
			status: 'unavailable',
			reason: 'missing',
		});
		await mkdir(file);
		expect(await probes.readPortReservations()).toEqual({
			status: 'unavailable',
			reason: 'not-a-file',
		});
		await rm(file, { recursive: true });
		await writeFile(file, 'this is not sqlite '.repeat(64));
		expect(await probes.readPortReservations()).toMatchObject({
			status: 'unavailable',
			reason: 'corrupt',
		});
		await rm(file);
		const other = new DatabaseSync(file);
		other.exec('CREATE TABLE something_else (x INTEGER)');
		other.close();
		expect(await probes.readPortReservations()).toMatchObject({
			status: 'unavailable',
			reason: 'unexpected-schema',
		});
	});

	it('runs one SELECT, always closes, and maps sqlite failures', async () => {
		createRegistry(file, []);
		const opened: { selects: number; closes: number }[] = [];
		const openWith =
			(select: () => unknown[]) =>
			(_file: string): PortsDatabase => {
				const counters = { selects: 0, closes: 0 };
				opened.push(counters);
				return {
					selectReservations: () => {
						counters.selects += 1;
						return select();
					},
					close: () => {
						counters.closes += 1;
					},
				};
			};
		const busy = Object.assign(new Error('database is locked'), { errcode: 5 });
		expect(
			await createSupabaseDiscovery({
				homeDirectory: home,
				openPortsDatabase: openWith(() => {
					throw busy;
				}),
			}).readPortReservations()
		).toEqual({
			status: 'unavailable',
			reason: 'busy',
			detail: 'sqlite errcode 5',
		});
		expect(
			await createSupabaseDiscovery({
				homeDirectory: home,
				openPortsDatabase: openWith(() => [{ junk: true }, 'row', null]),
			}).readPortReservations()
		).toMatchObject({ status: 'ok', reservations: [], skippedRows: 3 });
		expect(opened).toEqual([
			{ selects: 1, closes: 1 },
			{ selects: 1, closes: 1 },
		]);
		expect(
			await createSupabaseDiscovery({
				homeDirectory: home,
				openPortsDatabase: () => undefined,
			}).readPortReservations()
		).toEqual({ status: 'unavailable', reason: 'sqlite-unavailable' });
	});
});

describe('probe executables', () => {
	it('names only the fixed absolute executables in the module source', () => {
		const source = readFileSync(
			new URL('./discovery.ts', import.meta.url),
			'utf8'
		);
		const executables = new Set(
			Array.from(
				source.matchAll(/'(\/(?:usr\/)?s?bin\/[^']+)'/g),
				(match) => match[1]
			)
		);
		expect([...executables].sort()).toEqual([...ALLOWED_EXECUTABLES].sort());
		expect(source).not.toMatch(/\bshell:\s*true\b/);
	});

	it('only ever runs those executables', async () => {
		const { probes, calls } = discovery({});
		await probes.discoverOwners();
		await probes.processTree(1, { stackId: repo.id });
		await probes.checkExposure([1]);
		await probes.readSysvCapacity();
		await probes.measureMemory([1]);
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls)
			expect(ALLOWED_EXECUTABLES.has(call.executable)).toBe(true);
	});
});

describe.runIf(
	process.platform === 'darwin' &&
		process.env.RNDEVTOOLS_SUPABASE_PROBES === '1'
)('real probes on this Mac (opt-in: RNDEVTOOLS_SUPABASE_PROBES=1)', () => {
	const probes = createSupabaseDiscovery();

	it('reads owners, capacity and the registry without throwing', async () => {
		expect((await probes.discoverOwners()).status).toBe('ok');
		const capacity = await probes.readSysvCapacity();
		if (capacity.status !== 'ok') throw new Error(capacity.reason);
		expect(capacity.shmmni).toBeGreaterThan(0);
		const registry = await probes.readPortReservations();
		expect(
			registry.status === 'ok' ||
				['missing', 'sqlite-unavailable', 'busy'].includes(registry.reason)
		).toBe(true);
	});

	it('inspects this test process', async () => {
		const tree = await probes.processTree(process.pid);
		if (tree.status !== 'ok') throw new Error(tree.reason);
		expect(tree.pids[0]).toBe(process.pid);
		const exposure = await probes.checkExposure(tree.pids);
		if (exposure.status !== 'ok') throw new Error(exposure.reason);
		const memory = await probes.measureMemory([process.pid]);
		expect(
			memory.status === 'ok'
				? memory.bytes > 0
				: memory.reason === 'spawn-failed'
		).toBe(true);
	});
});

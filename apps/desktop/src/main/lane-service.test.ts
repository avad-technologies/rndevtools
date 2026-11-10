import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	utimes,
	writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	setImmediate as nextTurn,
	setTimeout as wait,
} from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	Lane,
	LaneOperationReceipt,
	LaneState,
} from '../shared/lane-protocol';
import type {
	SimulatorAction,
	SimulatorActionReceipt,
	SimulatorJob,
	SimulatorState,
} from '../shared/simulator-protocol';
import type {
	SlimmingAction,
	SlimmingJob,
	SlimmingState,
} from '../shared/slimming-protocol';
import { createSupabaseDemoState } from '../shared/supabase-demo-data';
import type {
	LaneBackendSummary,
	LaneWorktreeSupabase,
	SupabaseState,
} from '../shared/supabase-protocol';
import { AgentService } from './agent-service';
import {
	createMetroSupervisor,
	type MetroLaunchInput,
	type MetroSupervisorPort,
	NotLaneMetroError,
} from './lane-metro';
import {
	type LaneBackendPort,
	type LaneDeviceAccessPort,
	LaneService,
	type LaneSimulatorPort,
	type LaneSlimmingPort,
} from './lane-service';
import { LaneStore } from './lane-store';
import type {
	DiscoveredWorktree,
	WorktreeInspectorPort,
} from './lane-worktree';
import { SimulatorCommandError } from './simulator-command-runner';
import type { SimulatorMutationLease } from './simulator-mutation-coordinator';
import { SimulatorMutationCoordinator } from './simulator-mutation-coordinator';
import {
	type SimulatorHostProvider,
	SimulatorService,
} from './simulator-service';
import {
	describeSupabaseLaneBackend,
	type LaneBackendEnsureInput,
	type LaneBackendEnsureResult,
	type LaneBackendLateAttach,
} from './supabase/service-ports';

const UDID = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
const OTHER_UDID = 'FFFFFFFF-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
const CLONE_UDID = 'CCCCCCCC-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
const REPO = '/Users/dev/app';
const WORKTREE = '/Users/dev/app-feature-a';
const OTHER_WORKTREE = '/Users/dev/app-feature-b';
const THIRD_WORKTREE = '/Users/dev/app-feature-c';

function simulatorState(
	devices: Array<{ udid: string; state: 'booted' | 'shutdown' }>,
	jobs: SimulatorJob[] = []
): SimulatorState {
	return {
		revision: 1,
		updatedAt: 1,
		capability: {
			status: 'available',
			platform: 'darwin',
			licenseStatus: 'accepted',
			hostArchitecture: 'arm64',
			runtimeAvailability: { total: 1, available: 1 },
			features: {
				deviceManagement: true,
				apps: true,
				deepLinks: true,
				location: true,
				push: true,
				privacy: true,
				ui: true,
				statusBar: true,
				keychain: true,
				screenshot: true,
				video: true,
			},
		},
		runtimes: [],
		deviceTypes: [],
		devices: devices.map((device) => ({
			udid: device.udid,
			name: `Sim ${device.udid.slice(0, 4)}`,
			state: device.state,
			runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
			isAvailable: true,
		})),
		appsByDevice: {},
		diskByDevice: {},
		jobs,
		captures: [],
		metrics: { status: 'available', byDevice: {} },
		native: {
			status: 'available',
			permissionInspection: false,
			permissionPrompting: false,
			permissions: [],
		},
	} as unknown as SimulatorState;
}

class FakeSimulator implements LaneSimulatorPort {
	readonly actions: SimulatorAction[] = [];
	readonly listeners = new Set<(state: SimulatorState) => void>();
	state: SimulatorState;
	failNext: string | undefined;
	/** Fails every job of these kinds with the message given. */
	failKinds: Partial<Record<SimulatorAction['kind'], string>> = {};
	/** Bundle ids `app.list` reports as installed; undefined = everything. */
	installedApps: string[] | undefined;
	/** When set, a boot's job finishes only once this settles. */
	bootGate: Promise<unknown> | undefined;
	onBootStarted: (() => void) | undefined;
	/** What every `url.open` job reports it could not do, as it completes. */
	openWarnings: string[] | undefined;

	constructor(devices: Array<{ udid: string; state: 'booted' | 'shutdown' }>) {
		this.state = simulatorState(devices);
	}

	getState = () => this.state;
	refresh = async () => this.state;
	cancelJob = (_jobId: string) => true;
	subscribe = (listener: (state: SimulatorState) => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	runAction = (action: SimulatorAction): SimulatorActionReceipt => {
		this.actions.push(action);
		const jobId = `simulator-${this.actions.length}`;
		const failure = this.failNext ?? this.failKinds[action.kind];
		this.failNext = undefined;
		const settle = () => {
			const job = {
				id: jobId,
				actionId: action.actionId,
				kind: action.kind,
				status: failure ? 'failed' : 'complete',
				progressSequence: 1,
				phase: failure ? 'failed' : 'complete',
				createdAt: 1,
				finishedAt: 2,
				message: failure ?? 'done',
				deviceUdid: 'udid' in action ? action.udid : undefined,
				...(action.kind === 'url.open' && this.openWarnings
					? { warnings: this.openWarnings }
					: {}),
			} as unknown as SimulatorJob;
			if (action.kind === 'device.boot' && !failure) {
				this.state = simulatorState(
					this.state.devices.map((device) => ({
						udid: device.udid,
						state: 'booted' as const,
					})),
					[job]
				);
			} else if (action.kind === 'device.clone' && !failure) {
				const source = this.state.devices.find(
					(device) => device.udid === action.udid
				);
				this.state = {
					...this.state,
					jobs: [...this.state.jobs, job],
					devices: [
						...this.state.devices,
						{
							udid: CLONE_UDID,
							name: action.name,
							state: 'shutdown',
							runtimeIdentifier:
								source?.runtimeIdentifier ??
								'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
							isAvailable: true,
						},
					],
				};
			} else if (action.kind === 'app.list' && !failure) {
				const installed = this.installedApps ?? ['com.example.app'];
				this.state = {
					...this.state,
					jobs: [...this.state.jobs, job],
					appsByDevice: {
						...this.state.appsByDevice,
						[action.udid]: installed.map((bundleIdentifier) => ({
							bundleIdentifier,
							displayName: bundleIdentifier,
							isSystem: false,
						})),
					},
				};
			} else {
				this.state = { ...this.state, jobs: [...this.state.jobs, job] };
			}
			for (const listener of this.listeners) listener(this.state);
		};
		if (action.kind === 'device.boot') this.onBootStarted?.();
		if (action.kind === 'device.boot' && this.bootGate) {
			void this.bootGate.then(settle);
		} else {
			queueMicrotask(settle);
		}
		return { actionId: action.actionId, accepted: true, jobId };
	};
}

/**
 * Stand-in for the SimSlim service. It records every action and the lease it
 * arrived with, and lets a test decide whether the gate rejects the action
 * (`rejectWith`) or the job fails after it was accepted (`failWith`).
 */
class FakeSlimming implements LaneSlimmingPort {
	readonly actions: Array<{
		action: SlimmingAction;
		lease: SimulatorMutationLease | undefined;
	}> = [];
	readonly listeners = new Set<(state: SlimmingState) => void>();
	rejectWith: string | undefined;
	failWith: string | undefined;
	helperStatus: SlimmingState['helper']['status'] = 'available';
	refreshes = 0;
	state: SlimmingState = {
		revision: 1,
		updatedAt: 1,
		setting: { experimentalMutationsEnabled: true },
		helper: { status: 'available', readOnlyAvailable: true },
		categories: [],
		profiles: [
			{
				id: 'rndevtools-development',
				name: 'Development',
				description: 'Trims the usual suspects.',
				categoryIds: [],
				experimental: true,
			},
		],
		simulators: [],
		statusBySimulator: {},
		previewBySimulator: {},
		doctorBySimulator: {},
		jobs: [],
		checkpointBySimulator: {},
		operationsBySimulator: {},
	};

	getState = () => ({
		...this.state,
		helper: { ...this.state.helper, status: this.helperStatus },
	});
	refresh = async () => {
		this.refreshes += 1;
		return this.getState();
	};
	cancelJob = () => true;
	subscribe = (listener: (state: SlimmingState) => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	runAction = (
		action: SlimmingAction,
		lease?: SimulatorMutationLease
	): {
		actionId: string;
		accepted: boolean;
		jobId?: string;
		error?: string;
	} => {
		this.actions.push({ action, lease });
		if (this.rejectWith) {
			return {
				actionId: action.actionId,
				accepted: false,
				error: this.rejectWith,
			};
		}
		const jobId = `slimming-${this.actions.length}`;
		const failure = this.failWith;
		queueMicrotask(() => {
			const job = {
				id: jobId,
				actionId: action.actionId,
				kind: action.kind,
				status: failure ? 'failed' : 'complete',
				progressSequence: 1,
				phase: failure ? 'failed' : 'complete',
				message: failure ?? 'Profile applied and verified.',
				createdAt: 1,
				finishedAt: 2,
				currentIndex: 1,
				total: 1,
				profileId: 'profileId' in action ? action.profileId : undefined,
				targets: action.simulatorUdids.map((simulatorUdid) => ({
					simulatorUdid,
					status: failure ? 'failed' : 'complete',
					message: failure ?? 'done',
				})),
			} as unknown as SlimmingJob;
			this.state = { ...this.state, jobs: [...this.state.jobs, job] };
			for (const listener of this.listeners) listener(this.getState());
		});
		return { actionId: action.actionId, accepted: true, jobId };
	};
}

class FakeMetro implements MetroSupervisorPort {
	readonly started: MetroLaunchInput[] = [];
	readonly stopped: Array<{ pid: number; port: number }> = [];
	readonly busyPorts = new Set<number>();
	/** Ports where a packager answers /status, whoever it belongs to. */
	readonly healthyPorts = new Set<number>();
	/**
	 * The process listening on each port. The first live Metro started on a
	 * port binds it, as a real one would; a test can put a stranger there.
	 */
	readonly listeners = new Map<number, number>();
	readonly deadPids = new Set<number>();
	nextPid = 1_000;
	logs = new Map<string, string>();
	/** Why no Metro can start, as a malformed RNDEVTOOLS_CHILD_ENV_STRIP says. */
	environmentIssue: string | undefined;

	isPortFree = async (port: number) => !this.busyPorts.has(port);
	environmentProblem = () => this.environmentIssue;
	/** Refuses as the real supervisor does when the environment has a problem. */
	start = async (input: MetroLaunchInput) => {
		if (this.environmentIssue) throw new Error(this.environmentIssue);
		return this.launch(input);
	};
	/** Records a Metro launch and binds its port unless a live process holds it. */
	launch(input: MetroLaunchInput, pid?: number): number {
		let id = pid;
		if (id === undefined) {
			this.nextPid += 1;
			id = this.nextPid;
		}
		this.started.push(input);
		const holder = this.listeners.get(input.port);
		if (holder === undefined || this.deadPids.has(holder)) {
			this.listeners.set(input.port, id);
		}
		return id;
	}
	/** Without a PID this is a port-only probe: whoever answers counts. */
	isHealthy = async (port: number, pid?: number) =>
		this.healthyPorts.has(port) &&
		(pid === undefined ||
			(this.listeners.get(port) === pid && !this.deadPids.has(pid)));
	isProcessRunning = (pid: number) => !this.deadPids.has(pid);
	verifyOwnership = async (pid: number, _port: number, _directory: string) =>
		this.isProcessRunning(pid);
	/** A stopped Metro exits and lets go of its port, as a real one does. */
	stop: MetroSupervisorPort['stop'] = async (pid, port) => {
		this.stopped.push({ pid, port });
		this.deadPids.add(pid);
		if (this.listeners.get(port) === pid) this.listeners.delete(port);
	};
	readLogTail = async (logPath: string) => this.logs.get(logPath) ?? '';
	/** Every note the desktop added to a lane log, in order. */
	readonly notes: Array<{ logPath: string; note: string }> = [];
	failNotes = false;
	appendLogNote = async (logPath: string, note: string) => {
		if (this.failNotes) throw new Error('EACCES: permission denied');
		this.notes.push({ logPath, note });
	};
}

class FakeWorktrees implements WorktreeInspectorPort {
	worktrees: Array<DiscoveredWorktree & { dirty: boolean }> = [
		{ path: REPO, branch: 'main', repositoryRoot: REPO, dirty: false },
		{ path: WORKTREE, branch: 'feature/a', repositoryRoot: REPO, dirty: true },
		{
			path: OTHER_WORKTREE,
			branch: 'feature-b',
			repositoryRoot: REPO,
			dirty: false,
		},
		{
			path: THIRD_WORKTREE,
			branch: 'feature-c',
			repositoryRoot: REPO,
			dirty: false,
		},
	];
	identity: { scheme?: string; bundleIdentifier?: string } = {
		scheme: 'exampleapp',
		bundleIdentifier: 'com.example.app',
	};
	repositoryRoot = async (worktreePath: string) => {
		if (!worktreePath.startsWith('/Users/dev/app')) {
			throw new Error(`${worktreePath} is not inside a git repository.`);
		}
		return REPO;
	};
	listWorktrees = async () => this.worktrees;
	readDirty: WorktreeInspectorPort['readDirty'] = async (paths) => {
		const dirty = new Map(
			this.worktrees.map((worktree) => [worktree.path, worktree.dirty])
		);
		return new Map(
			paths.map((checkout) => [checkout, dirty.get(checkout) ?? false])
		);
	};
	readExpoIdentity = async () => this.identity;
}

/** Why no Metro can start while RNDEVTOOLS_CHILD_ENV_STRIP is malformed. */
const MALFORMED_STRIP =
	'RNDEVTOOLS_CHILD_ENV_STRIP entry 2 is not a variable name or a NAME_PREFIX* pattern. Separate entries with commas, fix it, and restart RN Devtools.';

const STACK_ID =
	'64616c83912c48442ec266f86ee2d7f004d2be5c8b7f31a6d6b4c2634f82145f';
const JOB_ID = 'supabase-job-11111111-2222-4333-8444-555555555555';
const API_URL = 'http://127.0.0.1:21734';
const MOVED_API_URL = 'http://127.0.0.1:24410';
const PUBLISHABLE_KEY = 'sb_publishable_lane_example';
const URL_NAME = 'EXPO_PUBLIC_SUPABASE_URL';
const KEY_NAME = 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

/** What the backend port maps for a lane's Metro: public values only. */
function backendEnv(apiUrl = API_URL): Record<string, string> {
	return { [URL_NAME]: apiUrl, [KEY_NAME]: PUBLISHABLE_KEY };
}

function readySummary(apiUrl = API_URL): LaneBackendSummary {
	return {
		policy: 'auto',
		status: 'ready',
		stackId: STACK_ID,
		apiUrl,
		appEnvNames: [URL_NAME, KEY_NAME],
		warnings: ['shared-default-keys'],
	};
}

function ready(apiUrl = API_URL): LaneBackendEnsureResult {
	return { summary: readySummary(apiUrl), laneEnv: backendEnv(apiUrl) };
}

/** A cold backend: not ready within the wait, attaching late. */
function starting(
	lateAttach: Promise<LaneBackendLateAttach>
): LaneBackendEnsureResult {
	return {
		summary: {
			policy: 'auto',
			status: 'starting',
			stackId: STACK_ID,
			jobId: JOB_ID,
			appEnvNames: [],
			warnings: [],
		},
		lateAttach,
	};
}

/**
 * Stand-in for the Supabase service. Each ensure takes the next queued
 * answer (a value or a promise the test settles) and is ready once they run
 * out; every call and every detach is recorded.
 */
class FakeBackends implements LaneBackendPort {
	readonly ensured: LaneBackendEnsureInput[] = [];
	readonly detached: string[] = [];
	readonly answers: Array<
		LaneBackendEnsureResult | Promise<LaneBackendEnsureResult>
	> = [];
	policy: 'auto' | 'off' = 'auto';
	detachError: Error | undefined;
	onEnsure: ((input: LaneBackendEnsureInput) => void) | undefined;
	readonly described = new Map<string, LaneWorktreeSupabase>();
	describeError: Error | undefined;
	runtimeState: SupabaseState | undefined;
	describeSummary = (previous: LaneBackendSummary) =>
		describeSupabaseLaneBackend(previous, this.runtimeState);

	ensureForLane = async (
		input: LaneBackendEnsureInput
	): Promise<LaneBackendEnsureResult> => {
		this.ensured.push(input);
		this.onEnsure?.(input);
		return this.answers.shift() ?? ready();
	};
	detachLane = (laneId: string) => {
		this.detached.push(laneId);
		if (this.detachError) throw this.detachError;
	};
	defaultPolicy = () => this.policy;
	describeWorktree = (worktreePath: string) => {
		if (this.describeError) throw this.describeError;
		return this.described.get(worktreePath);
	};
}

describe('LaneService', () => {
	let root: string;
	let store: LaneStore;
	let simulator: FakeSimulator;
	let metro: FakeMetro;
	let worktrees: FakeWorktrees;
	let slimming: FakeSlimming;
	let now: number;
	let service: LaneService;

	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), 'rndevtools-lane-service-'));
		store = new LaneStore(root);
		simulator = new FakeSimulator([
			{ udid: UDID, state: 'shutdown' },
			{ udid: OTHER_UDID, state: 'booted' },
		]);
		metro = new FakeMetro();
		worktrees = new FakeWorktrees();
		slimming = new FakeSlimming();
		now = 1_700_000_000_000;
		service = new LaneService({
			store,
			simulator,
			slimming,
			mutationCoordinator: new SimulatorMutationCoordinator(),
			metro,
			worktrees,
			now: () => now,
		});
		await service.start();
	});

	function healthyMetro() {
		metro.start = async (input) => {
			metro.healthyPorts.add(input.port);
			return metro.launch(input, 4_242);
		};
	}

	function startWithSlim(agent?: {
		kind: 'claude' | 'codex' | 'other';
		sessionId: string;
	}) {
		return service.runOperation({
			actionId: `op-slim-${Math.random().toString(16).slice(2)}`,
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: true,
			slimProfileId: 'rndevtools-development',
			...(agent ? { agent } : {}),
		});
	}

	afterEach(async () => {
		await service.stop();
		// Atomic writes already in flight may finish while temp cleanup starts.
		await rm(root, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 50,
		});
	});

	it('boots the simulator, leases a port, starts Metro, and deep-links the dev client', async () => {
		// Metro becomes healthy as soon as it is started.
		healthyMetro();
		const receipt = await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: true,
			agent: { kind: 'claude', sessionId: 'session-1' },
		});
		expect(receipt.completed).toBe(true);
		expect(receipt.lane).toMatchObject({
			worktreePath: WORKTREE,
			branch: 'feature/a',
			simulatorUdid: UDID,
			port: 8_100,
			metroPid: 4_242,
			metro: 'ready',
			scheme: 'exampleapp',
			bundleIdentifier: 'com.example.app',
			agent: { kind: 'claude', sessionId: 'session-1', lastSeenAt: now },
		});
		// A new lane's first launch starts its app fresh: any copy already
		// running goes before the dev client opens.
		expect(simulator.actions.map((action) => action.kind)).toEqual([
			'device.boot',
			'app.list',
			'app.terminate',
			'url.open',
		]);
		expect(simulator.actions[2]).toMatchObject({
			kind: 'app.terminate',
			udid: UDID,
			bundleIdentifier: 'com.example.app',
		});
		const launch = simulator.actions[3] as Extract<
			SimulatorAction,
			{ kind: 'url.open' }
		>;
		expect(launch.url).toBe(
			'exampleapp://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8100&disableOnboarding=1&disableAutoLaunch=1'
		);
		// The lane's own scheme opens in its own app without iOS asking first.
		expect(launch.bundleIdentifier).toBe('com.example.app');
		expect(metro.started[0]).toMatchObject({
			worktreePath: WORKTREE,
			port: 8_100,
			maxWorkers: 2,
		});
		expect(
			service.getState().worktrees.find((w) => w.path === WORKTREE)
		).toMatchObject({ laneId: receipt.lane?.id });
		expect(service.getState().repositories).toEqual([REPO]);
	});

	it('does not boot an already-booted simulator', async () => {
		metro.healthyPorts.add(8_100);
		await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: REPO,
			simulatorUdid: OTHER_UDID,
			environment: 'development',
			launch: true,
		});
		expect(simulator.actions.map((action) => action.kind)).toEqual([
			'app.list',
			'app.terminate',
			'url.open',
		]);
	});

	it('treats a repeated lane up for the same app and Simulator as a resume', async () => {
		metro.healthyPorts.add(8_100);
		const first = await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: false,
		});
		expect(first.completed).toBe(true);
		const laneId = first.lane?.id;
		expect(metro.started).toHaveLength(1);

		// Metro still healthy: nothing restarts, the same lane comes back.
		const again = await service.runOperation({
			actionId: 'op-2',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID.toLowerCase(),
			environment: 'development',
			launch: false,
		});
		expect(again.completed).toBe(true);
		expect(again.lane?.id).toBe(laneId);
		expect(metro.started).toHaveLength(1);
		expect(service.getState().lanes).toHaveLength(1);

		// Metro died: resume starts a new one on the lane's own port.
		metro.healthyPorts.delete(8_100);
		metro.deadPids.add(first.lane?.metroPid ?? -1);
		const resumed = await service.runOperation({
			actionId: 'op-3',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: false,
		});
		expect(resumed.completed).toBe(true);
		expect(resumed.lane?.id).toBe(laneId);
		expect(metro.started).toHaveLength(2);
		expect(metro.started[1]).toMatchObject({
			port: 8_100,
			worktreePath: WORKTREE,
		});
		expect(resumed.lane?.metroPid).not.toBe(first.lane?.metroPid);
	});

	it('refuses to steal a worktree, a simulator, or a leased port', async () => {
		metro.healthyPorts.add(8_100);
		metro.healthyPorts.add(8_101);
		const first = await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: false,
		});
		expect(first.completed).toBe(true);

		const sameWorktree = await service.runOperation({
			actionId: 'op-2',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: OTHER_UDID,
			environment: 'development',
			launch: false,
		});
		expect(sameWorktree).toMatchObject({ completed: false });
		expect(sameWorktree.error).toMatch(/already has lane/);

		const sameDevice = await service.runOperation({
			actionId: 'op-3',
			kind: 'lane.start',
			worktreePath: REPO,
			simulatorUdid: UDID,
			environment: 'development',
			launch: false,
		});
		expect(sameDevice.error).toMatch(/already assigned/);

		const second = await service.runOperation({
			actionId: 'op-4',
			kind: 'lane.start',
			worktreePath: REPO,
			simulatorUdid: OTHER_UDID,
			environment: 'development',
			launch: false,
		});
		expect(second.lane?.port).toBe(8_101);
		expect(metro.started).toHaveLength(2);
	});

	it('runs a monorepo app from its subdirectory while keying the lane on the containing worktree', async () => {
		healthyMetro();
		const receipt = await service.runOperation({
			actionId: 'op-mono',
			kind: 'lane.start',
			worktreePath: `${WORKTREE}/examples/demo`,
			simulatorUdid: UDID,
			environment: 'development',
			launch: true,
		});
		expect(receipt.completed).toBe(true);
		expect(receipt.lane).toMatchObject({
			worktreePath: WORKTREE,
			appPath: `${WORKTREE}/examples/demo`,
			branch: 'feature/a',
		});
		// Metro and the Expo config come from the app directory, not the root.
		expect(metro.started[0]?.worktreePath).toBe(`${WORKTREE}/examples/demo`);
		// A second app in the same worktree may have its own lane…
		const sibling = await service.runOperation({
			actionId: 'op-mono-2',
			kind: 'lane.start',
			worktreePath: `${WORKTREE}/examples/other`,
			simulatorUdid: OTHER_UDID,
			environment: 'development',
			launch: false,
		});
		expect(sibling.completed).toBe(true);
		// …but the same app may not have two.
		const duplicate = await service.runOperation({
			actionId: 'op-mono-3',
			kind: 'lane.start',
			worktreePath: `${WORKTREE}/examples/demo`,
			simulatorUdid: OTHER_UDID,
			environment: 'development',
			launch: false,
		});
		expect(duplicate.completed).toBe(false);
		expect(duplicate.error).toMatch(/examples\/demo already has lane/);
		// Stopping proves ownership by the leased port, not a path.
		await service.runOperation({
			actionId: 'op-mono-stop',
			kind: 'lane.stop',
			laneId: receipt.lane?.id ?? '',
		});
		expect(metro.stopped[0]).toEqual({ pid: 4_242, port: 8_100 });
	});

	it('rejects a path outside every worktree and an unknown environment', async () => {
		worktrees.repositoryRoot = async () => REPO;
		worktrees.worktrees = [
			{ path: REPO, branch: 'main', repositoryRoot: REPO, dirty: false },
		];
		const outside = await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: '/Users/dev/app-feature-a',
			simulatorUdid: UDID,
			environment: 'development',
			launch: false,
		});
		expect(outside.error).toMatch(/not inside a worktree of/);
		const environment = await service.runOperation({
			actionId: 'op-2',
			kind: 'lane.start',
			worktreePath: REPO,
			simulatorUdid: UDID,
			environment: 'nope',
			launch: false,
		});
		expect(environment.error).toMatch(/Unknown lane environment/);
		expect(metro.started).toHaveLength(0);
	});

	it('does not start Metro when the simulator fails to boot', async () => {
		simulator.failNext = 'CoreSimulator refused to boot.';
		const receipt = await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: false,
		});
		expect(receipt.error).toBe('CoreSimulator refused to boot.');
		// No lane was stored, so the receipt names none.
		expect(receipt).not.toHaveProperty('lane');
		expect(receipt).not.toHaveProperty('cancelled');
		expect(metro.started).toHaveLength(0);
		expect(service.getState().lanes).toHaveLength(0);
	});

	it.each(['cancel', 'shutdown'] as const)(
		'cleans up a Metro whose spawn finishes after %s',
		async (operation) => {
			const spawning = deferred<void>();
			const release = deferred<void>();
			metro.start = async (input) => {
				const pid = metro.launch(input);
				spawning.resolve();
				await release.promise;
				return pid;
			};
			const controller = new AbortController();
			const starting = service.runOperation(
				{
					actionId: 'op-cancel-spawn',
					kind: 'lane.start',
					worktreePath: WORKTREE,
					simulatorUdid: OTHER_UDID,
					environment: 'development',
					launch: false,
				},
				controller.signal
			);
			await spawning.promise;
			// Stopping the lanes waits for the cleanup of a Metro still spawning.
			let stopping: Promise<void> | undefined;
			if (operation === 'cancel') controller.abort();
			else stopping = service.stop();
			release.resolve();
			await stopping;
			const result = await starting;
			expect(result.completed).toBe(false);
			expect(result.error).toMatch(/cancelled|shutting down/);
			expect(metro.stopped).toEqual([{ pid: 1_001, port: 8_100 }]);
			expect(service.getState().lanes).toEqual([]);
			const reopened = new LaneStore(root);
			await reopened.start();
			expect(reopened.lanes()).toEqual([]);
		}
	);

	it.each(['cancel', 'shutdown'] as const)(
		'retains a recoverable lease when %s cleanup cannot safely stop a spawned Metro',
		async (operation) => {
			const spawning = deferred<void>();
			const release = deferred<void>();
			metro.start = async (input) => {
				const pid = metro.launch(input);
				spawning.resolve();
				await release.promise;
				return pid;
			};
			const stop = vi
				.spyOn(metro, 'stop')
				.mockRejectedValue(new Error('Ownership probe timed out.'));
			const controller = new AbortController();
			const starting = service.runOperation(
				{
					actionId: 'op-retained-start',
					kind: 'lane.start',
					worktreePath: WORKTREE,
					simulatorUdid: OTHER_UDID,
					environment: 'development',
					launch: false,
				},
				controller.signal
			);
			await spawning.promise;
			let stopping: Promise<void> | undefined;
			if (operation === 'cancel') controller.abort();
			else stopping = service.stop();
			release.resolve();
			await stopping;
			const result = await starting;
			expect(result.completed).toBe(false);
			expect(result.error).toMatch(/cancelled|shutting down/);
			expect(result.error).toContain('lane was retained');
			expect(metro.isProcessRunning(1_001)).toBe(true);
			const retained = service.getState().lanes[0];
			expect(retained).toMatchObject({
				metroPid: 1_001,
				metro: 'starting',
				port: 8_100,
			});
			const reopened = new LaneStore(root);
			await reopened.start();
			expect(reopened.lanes()[0]?.metroPid).toBe(1_001);
			// Once identity inspection recovers the retained lane can be stopped.
			stop.mockRestore();
			await service.stopLane(retained?.id as string);
			expect(metro.isProcessRunning(1_001)).toBe(false);
			expect(service.getState().lanes).toEqual([]);
		}
	);

	describe('a Metro no lane keeps that outlives its SIGTERM', () => {
		let signals: Array<{ pid: number; force: boolean }>;
		let advance: NodeJS.Timeout | undefined;

		beforeEach(() => {
			signals = [];
			// The cleanup waits on the injected clock; move it past every deadline.
			advance = setInterval(() => {
				now += 1_000;
			}, 5);
		});

		afterEach(() => {
			clearInterval(advance);
		});

		/** A start whose Metro spawn returns only once the test releases it. */
		function startHeld(signal: AbortSignal) {
			const spawning = deferred<void>();
			const release = deferred<void>();
			metro.start = async (input) => {
				const pid = metro.launch(input);
				spawning.resolve();
				await release.promise;
				return pid;
			};
			const starting = service.runOperation(
				{
					actionId: 'op-stubborn-spawn',
					kind: 'lane.start',
					worktreePath: WORKTREE,
					simulatorUdid: OTHER_UDID,
					environment: 'development',
					launch: false,
				},
				signal
			);
			return { spawning: spawning.promise, release: release.resolve, starting };
		}

		/** A Metro that ignores SIGTERM, and SIGKILL too unless `killable`. */
		function stubbornMetro({ killable }: { killable: boolean }) {
			metro.stop = async (pid, port, _directory, options) => {
				signals.push({ pid, force: options?.force === true });
				if (!options?.force || !killable) return;
				metro.deadPids.add(pid);
				if (metro.listeners.get(port) === pid) metro.listeners.delete(port);
			};
		}

		it.each(['cancel', 'shutdown'] as const)(
			'is killed once proven again when its spawn finishes after %s',
			async (operation) => {
				stubbornMetro({ killable: true });
				const controller = new AbortController();
				const held = startHeld(controller.signal);
				await held.spawning;
				let stopping: Promise<void> | undefined;
				if (operation === 'cancel') controller.abort();
				else stopping = service.stop();
				held.release(undefined);
				// Quitting waits for the cleanup to finish the Metro off.
				await stopping;
				const result = await held.starting;
				expect(result.completed).toBe(false);
				expect(signals).toEqual([
					{ pid: 1_001, force: false },
					{ pid: 1_001, force: true },
				]);
				expect(metro.isProcessRunning(1_001)).toBe(false);
				expect(service.getState().lanes).toEqual([]);
			}
		);

		it('keeps a recovery lease for one that outlives SIGKILL too', async () => {
			stubbornMetro({ killable: false });
			const controller = new AbortController();
			const held = startHeld(controller.signal);
			await held.spawning;
			controller.abort();
			held.release(undefined);
			const result = await held.starting;
			expect(result.completed).toBe(false);
			expect(result.error).toBe(
				'Lane operation cancelled. failed for Metro 1001 on port 8100: It did not exit after SIGTERM and SIGKILL. The lane was retained so cleanup can be retried.'
			);
			expect(signals).toEqual([
				{ pid: 1_001, force: false },
				{ pid: 1_001, force: true },
			]);
			expect(service.getState().lanes).toMatchObject([
				{ metroPid: 1_001, metro: 'starting', port: 8_100 },
			]);
		});
	});

	it('keeps stopping the lanes until a Metro spawned meanwhile has been cleaned up', async () => {
		const spawning = deferred<void>();
		const release = deferred<void>();
		metro.start = async (input) => {
			const pid = metro.launch(input);
			spawning.resolve();
			await release.promise;
			return pid;
		};
		const starting = service.runOperation({
			actionId: 'op-quit-spawn',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: OTHER_UDID,
			environment: 'development',
			launch: false,
		});
		await spawning.promise;
		let stopped = false;
		const stopping = service.stop().then(() => {
			stopped = true;
		});
		await nextTurn();
		// Quit goes on once this resolves; the Metro has no lane to keep it.
		expect(stopped).toBe(false);
		release.resolve();
		await stopping;
		expect(metro.stopped).toEqual([{ pid: 1_001, port: 8_100 }]);
		expect((await starting).completed).toBe(false);
	});

	it('stops waiting for a Metro spawn that outlasts the shutdown grace', async () => {
		const spawning = deferred<void>();
		const release = deferred<void>();
		metro.start = async (input) => {
			const pid = metro.launch(input);
			spawning.resolve();
			await release.promise;
			return pid;
		};
		const starting = service.runOperation({
			actionId: 'op-quit-slow-spawn',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: OTHER_UDID,
			environment: 'development',
			launch: false,
		});
		await spawning.promise;
		const advance = setInterval(() => {
			now += 1_000;
		}, 5);
		try {
			await service.stop();
		} finally {
			clearInterval(advance);
		}
		expect(metro.stopped).toEqual([]);
		release.resolve();
		expect((await starting).completed).toBe(false);
		await vi.waitFor(() =>
			expect(metro.stopped).toEqual([{ pid: 1_001, port: 8_100 }])
		);
	});

	it('does not spawn Metro for an already cancelled lane up', async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await service.runOperation(
			{
				actionId: 'op-cancelled',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: OTHER_UDID,
				environment: 'development',
				launch: false,
			},
			controller.signal
		);
		expect(result.completed).toBe(false);
		expect(result.cancelled).toBe(true);
		expect(result).not.toHaveProperty('lane');
		expect(metro.started).toEqual([]);
	});

	it('refuses a Metro restart while a lane stop is signalling its old PID', async () => {
		const started = await service.runOperation({
			actionId: 'op-start',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: OTHER_UDID,
			environment: 'development',
			launch: false,
		});
		const laneId = started.lane?.id as string;
		const stopping = deferred<void>();
		const release = deferred<void>();
		const stop = metro.stop;
		let first = true;
		metro.stop = async (pid, port, directory) => {
			if (first) {
				first = false;
				stopping.resolve();
				await release.promise;
			}
			await stop(pid, port, directory);
		};
		const stopped = service.stopLane(laneId);
		await stopping.promise;
		try {
			await expect(service.restartMetro(laneId, 'operator')).rejects.toThrow(
				/stopping/
			);
		} finally {
			release.resolve();
			await stopped;
		}
		expect(metro.started).toHaveLength(1);
		expect(service.getState().lanes).toEqual([]);
	});

	it('reserves a stopping lane device until an uncommitted replacement is cleaned up or retained', async () => {
		const started = await service.runOperation({
			actionId: 'op-reservation-start',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: OTHER_UDID,
			environment: 'development',
			launch: false,
		});
		const spawning = deferred<void>();
		const release = deferred<void>();
		metro.start = async (input) => {
			const pid = metro.launch(input);
			spawning.resolve();
			if (pid === 1_002) await release.promise;
			return pid;
		};
		const stop = metro.stop;
		metro.stop = async (pid, port, directory) => {
			if (pid === 1_002) throw new Error('Ownership inspection unavailable.');
			await stop(pid, port, directory);
		};
		const restarting = service
			.restartMetro(started.lane?.id as string, 'operator')
			.then(
				() => 'unexpected success',
				(error: unknown) =>
					error instanceof Error ? error.message : String(error)
			);
		await spawning.promise;
		await service.stopLane(started.lane?.id as string);
		const other = await service.runOperation({
			actionId: 'op-reservation-other',
			kind: 'lane.start',
			worktreePath: OTHER_WORKTREE,
			simulatorUdid: OTHER_UDID,
			environment: 'development',
			launch: false,
		});
		expect(other.completed).toBe(false);
		expect(metro.started).toHaveLength(2);
		release.resolve();
		expect(await restarting).toContain('lane was retained');
		expect(service.getState().lanes).toMatchObject([
			{ id: started.lane?.id, metroPid: 1_002 },
		]);
		metro.stop = stop;
		await service.stopLane(started.lane?.id as string);
	});

	it('stops a replacement Metro when its PID cannot be persisted', async () => {
		const started = await service.runOperation({
			actionId: 'op-persist-start',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: OTHER_UDID,
			environment: 'development',
			launch: false,
		});
		const failedWrite = vi
			.spyOn(store, 'upsert')
			.mockRejectedValueOnce(new Error('Disk write failed.'));
		try {
			await expect(
				service.restartMetro(started.lane?.id as string, 'operator')
			).rejects.toThrow('Disk write failed.');
		} finally {
			failedWrite.mockRestore();
		}
		expect(metro.started).toHaveLength(2);
		expect(metro.stopped).toEqual([
			{ pid: 1_001, port: 8_100 },
			{ pid: 1_002, port: 8_100 },
		]);
		expect(metro.isProcessRunning(1_002)).toBe(false);
	});

	it.each(['stop', 'restart'] as const)(
		'continues a Metro %s when diagnostics throw synchronously',
		async (operation) => {
			await service.stop();
			service = new LaneService({
				store,
				simulator,
				metro,
				worktrees,
				now: () => now,
				onMetroStop: () => {
					throw new Error('Diagnostics unavailable.');
				},
			});
			await service.start();
			const started = await service.runOperation({
				actionId: 'op-diagnostic-start',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: OTHER_UDID,
				environment: 'development',
				launch: false,
			});
			if (operation === 'stop')
				await service.stopLane(started.lane?.id as string);
			else await service.restartMetro(started.lane?.id as string, 'operator');
			expect(metro.stopped).toEqual([{ pid: 1_001, port: 8_100 }]);
		}
	);

	it('does not open a dev client after its lane stops during a readiness probe', async () => {
		const started = await service.runOperation({
			actionId: 'op-readiness-start',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: OTHER_UDID,
			environment: 'development',
			launch: false,
		});
		const probing = deferred<void>();
		const release = deferred<boolean>();
		metro.isHealthy = async () => {
			probing.resolve();
			return release.promise;
		};
		const launching = service.runOperation({
			actionId: 'op-readiness-launch',
			kind: 'lane.launch',
			laneId: started.lane?.id as string,
		});
		await probing.promise;
		await service.stopLane(started.lane?.id as string);
		release.resolve(true);
		expect((await launching).completed).toBe(false);
		expect(simulator.actions).toEqual([]);
	});

	it('reports a Metro that exited before becoming ready and keeps the lease for inspection', async () => {
		metro.start = async (input) => {
			metro.deadPids.add(7);
			return metro.launch(input, 7);
		};
		const receipt = await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: true,
		});
		expect(receipt.completed).toBe(false);
		expect(receipt.error).toMatch(/exited before it became ready/);
		expect(service.getState().lanes).toHaveLength(1);
		expect(simulator.actions.map((action) => action.kind)).toEqual([
			'device.boot',
		]);
		// The lane reads as stopped at once, in the receipt that names it too:
		// only a lane up, which starts Metro again, can launch it now.
		expect(service.getState().lanes[0]?.metro).toBe('stopped');
		expect(receipt.lane).toMatchObject({
			id: service.getState().lanes[0]?.id,
			metro: 'stopped',
		});
	});

	it('times out a Metro that never answers /status', async () => {
		metro.start = async (input) => metro.launch(input, 9);
		const started = service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: true,
		});
		// Advance the injected clock past the deadline between polls.
		const advance = setInterval(() => {
			now += 5_000;
		}, 5);
		const receipt = await started;
		clearInterval(advance);
		expect(receipt.completed).toBe(false);
		expect(receipt.error).toMatch(/did not become ready/);
		expect(service.getState().lanes[0]?.metro).toBe('starting');
		// The lane exists and keeps its lease, so the receipt names it for a
		// lane up or launch to try again.
		expect(receipt.lane?.id).toBe(service.getState().lanes[0]?.id);
		expect(receipt.lane?.port).toBe(8_100);
		expect(receipt).not.toHaveProperty('cancelled');
	});

	it("launches deep links through the lane scheme and refreshes the holder's attribution", async () => {
		metro.healthyPorts.add(8_100);
		const started = await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: false,
			agent: { kind: 'codex', sessionId: 'thread-9' },
		});
		now += 1_000;
		const launched = await service.runOperation({
			actionId: 'op-2',
			kind: 'lane.launch',
			laneId: started.lane?.id as string,
			url: 'checkout/cart',
			agent: { kind: 'codex', sessionId: 'thread-9' },
		});
		expect(launched.completed).toBe(true);
		expect(launched.lane).toMatchObject({
			metro: 'ready',
			lastLaunchedAt: now,
			agent: { kind: 'codex', sessionId: 'thread-9', lastSeenAt: now },
		});
		const open = simulator.actions.at(-1) as Extract<
			SimulatorAction,
			{ kind: 'url.open' }
		>;
		expect(open.url).toBe('exampleapp://checkout/cart');
		expect(open.bundleIdentifier).toBe('com.example.app');
	});

	it("approves only the lane's own scheme for its app", async () => {
		metro.healthyPorts.add(8_100);
		const started = await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: false,
		});
		const laneId = started.lane?.id as string;
		for (const [index, url] of [
			'https://example.com/items/1',
			'otherapp://home',
		].entries()) {
			const launched = await service.runOperation({
				actionId: `op-other-${index}`,
				kind: 'lane.launch',
				laneId,
				url,
			});
			expect(launched.completed).toBe(true);
			const open = simulator.actions.at(-1) as Extract<
				SimulatorAction,
				{ kind: 'url.open' }
			>;
			expect(open.url).toBe(url);
			expect(open).not.toHaveProperty('bundleIdentifier');
		}
		const own = await service.runOperation({
			actionId: 'op-own',
			kind: 'lane.launch',
			laneId,
			url: 'ExampleApp://settings',
		});
		expect(own.completed).toBe(true);
		expect(simulator.actions.at(-1)).toMatchObject({
			kind: 'url.open',
			url: 'ExampleApp://settings',
			bundleIdentifier: 'com.example.app',
		});
	});

	it("notes in the lane log what the dev client's open could not do, and launches anyway", async () => {
		metro.healthyPorts.add(8_100);
		const started = await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: true,
		});
		expect(started.completed).toBe(true);
		// An open that warned of nothing leaves the log to Metro.
		expect(metro.notes).toEqual([]);
		const laneId = started.lane?.id as string;
		const logPath = started.lane?.logPath;
		const warning =
			'The exampleapp URL scheme could not be approved for com.example.app (xcrun failed with exit code 1.), so iOS may ask "Open in …?" before the app opens.';
		simulator.openWarnings = [warning];
		now += 1_000;
		const launched = await service.runOperation({
			actionId: 'op-2',
			kind: 'lane.launch',
			laneId,
		});
		expect(launched.completed).toBe(true);
		expect(launched.lane).toMatchObject({
			metro: 'ready',
			lastLaunchedAt: now,
		});
		expect(metro.notes).toEqual([{ logPath, note: warning }]);

		// A log that cannot take the note fails nothing either.
		metro.failNotes = true;
		now += 1_000;
		const again = await service.runOperation({
			actionId: 'op-3',
			kind: 'lane.launch',
			laneId,
		});
		expect(again.completed).toBe(true);
		expect(again.lane).toMatchObject({ lastLaunchedAt: now });
	});

	it('never hands a lane to another session that launches or resumes it', async () => {
		metro.healthyPorts.add(8_100);
		const startedAt = now;
		const started = await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: false,
			agent: { kind: 'claude', sessionId: 'session-1' },
		});
		const laneId = started.lane?.id as string;
		const holder = {
			kind: 'claude',
			sessionId: 'session-1',
			lastSeenAt: startedAt,
		};

		// The launch goes through, and the holder stays the holder.
		now += 1_000;
		const launched = await service.runOperation({
			actionId: 'op-2',
			kind: 'lane.launch',
			laneId,
			agent: { kind: 'codex', sessionId: 'thread-9' },
		});
		expect(launched.completed).toBe(true);
		expect(launched.lane).toMatchObject({ lastLaunchedAt: now });
		expect(launched.lane?.agent).toEqual(holder);

		// A lane up for the same app resumes the lane without taking it.
		now += 1_000;
		const resumed = await service.runOperation({
			actionId: 'op-3',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			environment: 'development',
			launch: true,
			agent: { kind: 'codex', sessionId: 'thread-9' },
		});
		expect(resumed.lane?.id).toBe(laneId);
		expect(resumed.lane?.agent).toEqual(holder);
		expect(service.getState().lanes[0]?.agent).toEqual(holder);

		// The holder's own launch is what refreshes when it was last seen.
		now += 1_000;
		const own = await service.runOperation({
			actionId: 'op-4',
			kind: 'lane.launch',
			laneId,
			agent: { kind: 'claude', sessionId: 'session-1' },
		});
		expect(own.lane?.agent).toEqual({ ...holder, lastSeenAt: now });
	});

	it("refuses a lane up that would resume another session's lane, and resumes it for its holder and the operator", async () => {
		metro.healthyPorts.add(8_100);
		// The agent service's rule in brief: a lane's holder, or the operator,
		// may drive its device.
		const deviceAccess: LaneDeviceAccessPort = (udid, requester) => {
			const lane = guarded
				.getState()
				.lanes.find((candidate) => candidate.simulatorUdid === udid);
			const holder = lane?.agent;
			if (
				!lane ||
				!holder ||
				!requester ||
				(holder.kind === requester.kind &&
					holder.sessionId === requester.sessionId)
			) {
				return { allowed: true };
			}
			return {
				allowed: false,
				reason: `Simulator ${udid} is held by ${holder.kind} session ${holder.sessionId} through lane ${lane.id}.`,
				hold: {
					simulatorUdid: udid,
					via: 'lane',
					laneId: lane.id,
					holder: { kind: holder.kind, sessionId: holder.sessionId },
					holderLive: true,
				},
			};
		};
		const guarded: LaneService = new LaneService({
			store: new LaneStore(root),
			simulator,
			metro,
			worktrees,
			now: () => now,
			deviceAccess,
		});
		await guarded.start();
		const up = (agent?: { kind: 'claude' | 'codex'; sessionId: string }) =>
			guarded.runOperation({
				actionId: `op-${Math.random().toString(16).slice(2)}`,
				kind: 'lane.start',
				worktreePath: WORKTREE,
				environment: 'development',
				launch: true,
				backend: 'off',
				...(agent ? { agent } : {}),
			});
		const started = await guarded.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: false,
			agent: { kind: 'claude', sessionId: 'session-1' },
		});
		const opens = () =>
			simulator.actions.filter((action) => action.kind === 'url.open').length;

		const refused = await up({ kind: 'codex', sessionId: 'thread-9' });
		expect(refused.completed).toBe(false);
		expect(refused.error).toMatch(/held by claude session session-1/);
		expect(metro.stopped).toEqual([]);
		expect(metro.started).toHaveLength(1);
		expect(opens()).toBe(0);

		const own = await up({ kind: 'claude', sessionId: 'session-1' });
		expect(own.completed).toBe(true);
		expect(own.lane?.id).toBe(started.lane?.id);
		const operator = await up();
		expect(operator.completed).toBe(true);
		expect(operator.lane?.id).toBe(started.lane?.id);
		expect(opens()).toBe(2);
		await guarded.stop();
	});

	it("keeps an operator's lane with the operator when an agent launches it", async () => {
		metro.healthyPorts.add(8_100);
		const started = await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: false,
		});
		const launched = await service.runOperation({
			actionId: 'op-2',
			kind: 'lane.launch',
			laneId: started.lane?.id as string,
			agent: { kind: 'codex', sessionId: 'thread-9' },
		});
		expect(launched.completed).toBe(true);
		expect(launched.lane).not.toHaveProperty('agent');
	});

	it('stops only the Metro the lane owns and releases the lease', async () => {
		metro.healthyPorts.add(8_100);
		const started = await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: false,
		});
		const laneId = started.lane?.id as string;
		const stopped = await service.runOperation({
			actionId: 'op-2',
			kind: 'lane.stop',
			laneId,
		});
		expect(stopped.completed).toBe(true);
		expect(metro.stopped).toEqual([{ pid: 1_001, port: 8_100 }]);
		expect(service.getState().lanes).toHaveLength(0);
		const again = await service.runOperation({
			actionId: 'op-3',
			kind: 'lane.stop',
			laneId,
		});
		expect(again.error).toMatch(/does not exist/);
	});

	it('removes a lane whose recorded PID now names another process, signalling nothing', async () => {
		metro.healthyPorts.add(8_100);
		const started = await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: false,
		});
		const asked: string[] = [];
		metro.stop = async (pid, port, appDirectory) => {
			asked.push(appDirectory);
			throw new NotLaneMetroError(
				`Process ${pid} is no longer the Metro serving port ${port} from ${appDirectory}; refusing to stop it.`
			);
		};
		const stopped = await service.runOperation({
			actionId: 'op-2',
			kind: 'lane.stop',
			laneId: started.lane?.id as string,
		});
		expect(stopped.completed).toBe(true);
		expect(asked).toEqual([WORKTREE]);
		expect(metro.stopped).toEqual([]);
		expect(service.getState().lanes).toEqual([]);
	});

	it("keeps a lane whose Metro's owner could not be checked, and says why", async () => {
		metro.healthyPorts.add(8_100);
		const started = await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: false,
		});
		metro.stop = async (pid) => {
			throw new Error(
				`Could not inspect process ${pid} to confirm it is this lane's Metro; refusing to stop it.`
			);
		};
		const stopped = await service.runOperation({
			actionId: 'op-2',
			kind: 'lane.stop',
			laneId: started.lane?.id as string,
		});
		expect(stopped.completed).toBe(false);
		expect(stopped.error).toMatch(/Could not inspect process/);
		expect(service.getState().lanes).toHaveLength(1);
	});

	it.each([
		['success', undefined],
		['failure', 'Could not inspect process 1001; refusing to stop it.'],
	] as const)(
		"gives a second stop of a lane that is stopping the first one's %s",
		async (_outcome, failure) => {
			metro.healthyPorts.add(8_100);
			const started = await service.runOperation({
				actionId: 'op-double-start',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: UDID,
				environment: 'development',
				launch: false,
			});
			const laneId = started.lane?.id as string;
			const stopping = deferred<void>();
			const release = deferred<void>();
			const stop = metro.stop;
			metro.stop = async (pid, port, directory, options) => {
				stopping.resolve();
				await release.promise;
				if (failure) throw new Error(failure);
				await stop(pid, port, directory, options);
			};
			const first = service.runOperation({
				actionId: 'op-double-stop-1',
				kind: 'lane.stop',
				laneId,
			});
			await stopping.promise;
			const second = service.runOperation({
				actionId: 'op-double-stop-2',
				kind: 'lane.stop',
				laneId,
			});
			release.resolve();
			const receipts = await Promise.all([first, second]);
			expect(receipts.map((receipt) => receipt.completed)).toEqual(
				failure ? [false, false] : [true, true]
			);
			expect(receipts.map((receipt) => receipt.error)).toEqual(
				failure ? [failure, failure] : [undefined, undefined]
			);
			expect(metro.stopped).toEqual(
				failure ? [] : [{ pid: started.lane?.metroPid, port: 8_100 }]
			);
			expect(service.getState().lanes).toHaveLength(failure ? 1 : 0);
		}
	);

	describe('a Metro that outlives its SIGTERM', () => {
		let laneId: string;
		let pid: number;
		let signals: Array<{ pid: number; force: boolean }>;
		let advance: NodeJS.Timeout | undefined;

		beforeEach(async () => {
			metro.healthyPorts.add(8_100);
			const started = await service.runOperation({
				actionId: 'op-stubborn-start',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: UDID,
				environment: 'development',
				launch: false,
			});
			laneId = started.lane?.id as string;
			pid = started.lane?.metroPid as number;
			signals = [];
			// The stop waits on the injected clock; move it past every deadline.
			advance = setInterval(() => {
				now += 1_000;
			}, 5);
		});

		afterEach(() => {
			clearInterval(advance);
		});

		function stop() {
			return service.runOperation({
				actionId: `op-stubborn-stop-${signals.length}`,
				kind: 'lane.stop',
				laneId,
			});
		}

		it("is killed once proven to be the lane's Metro again, and the lane goes", async () => {
			metro.stop = async (target, port, _directory, options) => {
				signals.push({ pid: target, force: options?.force === true });
				if (!options?.force) return;
				metro.deadPids.add(target);
				if (metro.listeners.get(port) === target) metro.listeners.delete(port);
			};
			const stopped = await stop();
			expect(stopped.completed).toBe(true);
			expect(signals).toEqual([
				{ pid, force: false },
				{ pid, force: true },
			]);
			expect(metro.isProcessRunning(pid)).toBe(false);
			expect(service.getState().lanes).toEqual([]);
		});

		it('is left alone once its PID names another process, and the lane goes', async () => {
			metro.stop = async (target, port, _directory, options) => {
				signals.push({ pid: target, force: options?.force === true });
				if (options?.force) {
					throw new NotLaneMetroError(
						`Process ${target} is no longer the Metro serving port ${port}; refusing to stop it.`
					);
				}
			};
			const stopped = await stop();
			expect(stopped.completed).toBe(true);
			expect(signals).toEqual([
				{ pid, force: false },
				{ pid, force: true },
			]);
			expect(service.getState().lanes).toEqual([]);
		});

		it('is gone when it exits between its proof and its SIGKILL, and the lane goes', async () => {
			metro.stop = async (target, _port, _directory, options) => {
				signals.push({ pid: target, force: options?.force === true });
				if (!options?.force) return;
				// What process.kill throws for a PID that exited after the proof.
				metro.deadPids.add(target);
				throw Object.assign(new Error('kill ESRCH'), {
					code: 'ESRCH',
					syscall: 'kill',
				});
			};
			const stopped = await stop();
			expect(stopped.completed).toBe(true);
			expect(stopped.error).toBeUndefined();
			expect(signals).toEqual([
				{ pid, force: false },
				{ pid, force: true },
			]);
			expect(service.getState().lanes).toEqual([]);
		});

		it('keeps the lane when its proof fails at the SIGKILL stage, and says why', async () => {
			metro.stop = async (target, _port, _directory, options) => {
				signals.push({ pid: target, force: options?.force === true });
				if (!options?.force) return;
				throw new Error(
					`Could not inspect process ${target} to confirm it is this lane's Metro (lsof timed out); refusing to stop it.`
				);
			};
			const stopped = await stop();
			expect(stopped.completed).toBe(false);
			expect(stopped.error).toBe(
				`Could not inspect process ${pid} to confirm it is this lane's Metro (lsof timed out); refusing to stop it.`
			);
			expect(signals).toEqual([
				{ pid, force: false },
				{ pid, force: true },
			]);
			expect(metro.isProcessRunning(pid)).toBe(true);
			expect(service.getState().lanes.map((lane) => lane.id)).toEqual([laneId]);
		});

		it('keeps the lane when it outlives SIGKILL too, so a later stop can finish it', async () => {
			const original = metro.stop;
			metro.stop = async (target, _port, _directory, options) => {
				signals.push({ pid: target, force: options?.force === true });
			};
			const stopped = await stop();
			expect(stopped.completed).toBe(false);
			expect(stopped.error).toBe(
				`Metro ${pid} on port 8100 did not exit after SIGTERM and SIGKILL. The lane was kept so it can be stopped again.`
			);
			expect(signals).toEqual([
				{ pid, force: false },
				{ pid, force: true },
			]);
			expect(service.getState().lanes.map((lane) => lane.id)).toEqual([laneId]);
			metro.stop = original;
			expect((await stop()).completed).toBe(true);
			expect(service.getState().lanes).toEqual([]);
		});
	});

	it('keeps a lane whose worktree moved under its running Metro, leaving that Metro alone', async () => {
		const checkout = path.join(root, 'checkout');
		const appDirectory = path.join(checkout, 'apps', 'mobile');
		await mkdir(appDirectory, { recursive: true });
		// The lane's own Metro: a live process serving from the app directory.
		const own = spawn('/bin/sleep', ['30'], {
			cwd: appDirectory,
			detached: true,
			stdio: 'ignore',
		});
		await once(own, 'spawn');
		const laneStore = new LaneStore(path.join(root, 'state'));
		const lanes = new LaneService({
			store: laneStore,
			simulator,
			worktrees,
			now: () => now,
			metro: createMetroSupervisor({
				probe: async () => {
					throw new Error('connect ECONNREFUSED 127.0.0.1:8100');
				},
				// What ps and lsof report for that Metro once its checkout moved.
				runCommand: async (executable) => ({
					stdout:
						executable === '/bin/ps'
							? 'node /Users/dev/node_modules/.bin/expo start --dev-client --localhost --port 8100 --max-workers 2\n'
							: `p${own.pid}\nfcwd\nn${realpathSync(path.join(root, 'moved', 'apps', 'mobile'))}\n`,
					stderr: '',
					exitCode: 0,
				}),
			}),
		});
		try {
			await lanes.start();
			const laneId = laneStore.newLaneId();
			await laneStore.upsert({
				id: laneId,
				worktreePath: checkout,
				appPath: appDirectory,
				branch: 'main',
				simulatorUdid: UDID,
				environment: 'development',
				port: 8_100,
				metroPid: own.pid as number,
				metro: 'ready',
				logPath: laneStore.logPathFor(laneId),
				startedAt: now,
			});
			await rename(checkout, path.join(root, 'moved'));
			const stopped = await lanes.runOperation({
				actionId: 'op-stop',
				kind: 'lane.stop',
				laneId,
			});
			expect(stopped.completed).toBe(false);
			expect(stopped.error).toMatch(/moved or renamed/);
			expect(lanes.getState().lanes.map((lane) => lane.id)).toEqual([laneId]);
			expect(own.exitCode).toBeNull();
			expect(own.signalCode).toBeNull();
		} finally {
			own.kill('SIGKILL');
			await lanes.stop();
		}
	});

	describe('launch races', () => {
		/** Takes url.open from the fake Simulator and finishes it on `release`. */
		function holdUrlOpen() {
			let release: () => void = () => undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let markOpening: () => void = () => undefined;
			const opening = new Promise<void>((resolve) => {
				markOpening = resolve;
			});
			const run = simulator.runAction;
			simulator.runAction = (action) => {
				if (action.kind !== 'url.open') return run(action);
				simulator.actions.push(action);
				const jobId = `simulator-held-${simulator.actions.length}`;
				markOpening();
				void gate.then(() => {
					const job = {
						id: jobId,
						actionId: action.actionId,
						kind: action.kind,
						status: 'complete',
						progressSequence: 1,
						phase: 'complete',
						createdAt: 1,
						finishedAt: 2,
						message: 'done',
						deviceUdid: action.udid,
					} as unknown as SimulatorJob;
					simulator.state = {
						...simulator.state,
						jobs: [...simulator.state.jobs, job],
					};
					for (const listener of simulator.listeners) listener(simulator.state);
				});
				return { actionId: action.actionId, accepted: true, jobId };
			};
			return { release, opening };
		}

		async function startLane(): Promise<LaneOperationReceipt> {
			metro.healthyPorts.add(8_100);
			return service.runOperation({
				actionId: 'op-1',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: UDID,
				environment: 'development',
				launch: false,
				agent: { kind: 'claude', sessionId: 'session-1' },
			});
		}

		it.each([
			{ failures: 1, code: 60, url: undefined, attempts: 2, completed: true },
			{ failures: 2, code: 60, url: undefined, attempts: 2, completed: false },
			{ failures: 1, code: 61, url: undefined, attempts: 1, completed: false },
			{
				failures: 1,
				code: 60,
				url: 'checkout/cart',
				attempts: 1,
				completed: false,
			},
		])(
			'bounds default dev-client launch recovery: $code / $failures / $url',
			async ({ failures, code, url, attempts, completed }) => {
				const started = await startLane();
				const run = simulator.runAction;
				let opens = 0;
				simulator.runAction = (action) => {
					if (action.kind === 'url.open' && opens++ < failures) {
						simulator.failNext = `xcrun failed with exit code ${code}.`;
					}
					return run(action);
				};
				const result = await service.runOperation({
					actionId: 'recover-launch',
					kind: 'lane.launch',
					laneId: started.lane?.id as string,
					...(url ? { url } : {}),
				});
				expect(result.completed).toBe(completed);
				expect(opens).toBe(attempts);
				expect(metro.started).toHaveLength(1);
				expect(service.getState().lanes[0]?.metroPid).toBe(
					started.lane?.metroPid
				);
				if (!completed)
					expect(result.error).toBe(`xcrun failed with exit code ${code}.`);
				const actions = simulator.actions.filter(
					(action) => action.kind === 'url.open'
				);
				expect(new Set(actions.map((action) => action.actionId)).size).toBe(
					attempts
				);
				expect(new Set(actions.map((action) => action.url)).size).toBe(1);
				// Each attempt opens the lane's own scheme, approved for its app.
				expect(actions.map((action) => action.bundleIdentifier)).toEqual(
					Array.from({ length: attempts }, () => 'com.example.app')
				);
			}
		);

		it.each(['stop', 'cancel'] as const)(
			'does not retry a timed-out launch after %s',
			async (operation) => {
				const started = await startLane();
				const laneId = started.lane?.id as string;
				const controller = new AbortController();
				const run = simulator.runAction;
				simulator.runAction = (action) => {
					if (action.kind === 'url.open')
						simulator.failNext = 'xcrun failed with exit code 60.';
					return run(action);
				};
				const result = service
					.launchLane(laneId, undefined, undefined, controller.signal)
					.then(
						() => 'unexpected success',
						(error: unknown) =>
							error instanceof Error ? error.message : String(error)
					);
				await vi.waitFor(() =>
					expect(
						simulator.actions.some((action) => action.kind === 'url.open')
					).toBe(true)
				);
				if (operation === 'stop') await service.stopLane(laneId);
				else controller.abort();
				expect(await result).toMatch(
					operation === 'stop' ? /changed before.*retry/ : /cancelled/
				);
				expect(
					simulator.actions.filter((action) => action.kind === 'url.open')
				).toHaveLength(1);
			}
		);

		it('does not bring back a lane stopped while its dev client opened', async () => {
			const started = await startLane();
			const laneId = started.lane?.id as string;
			const held = holdUrlOpen();
			const launching = service.runOperation({
				actionId: 'op-launch',
				kind: 'lane.launch',
				laneId,
			});
			await held.opening;
			const stopped = await service.runOperation({
				actionId: 'op-stop',
				kind: 'lane.stop',
				laneId,
			});
			expect(stopped.completed).toBe(true);
			held.release();
			const launched = await launching;
			expect(launched.completed).toBe(false);
			expect(launched.error).toMatch(/was stopped while its dev client opened/);
			expect(service.getState().lanes).toEqual([]);
			const reopened = new LaneStore(root);
			await reopened.start();
			expect(reopened.lanes()).toEqual([]);
		});

		it('names the lane it stored when a lane up is cancelled during its launch, and says it was cancelled', async () => {
			metro.healthyPorts.add(8_100);
			const held = holdUrlOpen();
			const controller = new AbortController();
			const starting = service.runOperation(
				{
					actionId: 'op-cancel-up',
					kind: 'lane.start',
					worktreePath: WORKTREE,
					simulatorUdid: UDID,
					environment: 'development',
					launch: true,
				},
				controller.signal
			);
			await held.opening;
			controller.abort();
			const receipt = await starting;
			expect(receipt).toMatchObject({
				completed: false,
				cancelled: true,
				error: 'Lane operation cancelled.',
			});
			// The lane outlives the cancelled launch, so a lane up or launch can
			// open it again.
			expect(receipt.lane?.id).toBe(service.getState().lanes[0]?.id);
			held.release();
		});

		it('keeps the Metro that replaced the checked one while the dev client opened', async () => {
			const started = await startLane();
			const laneId = started.lane?.id as string;
			const held = holdUrlOpen();
			const launching = service.runOperation({
				actionId: 'op-launch',
				kind: 'lane.launch',
				laneId,
			});
			await held.opening;
			// An explicit operator restart replaces even a Metro with no backend.
			await service.restartMetro(laneId, 'operator');
			const respawned = service.getState().lanes[0];
			expect(respawned?.metroPid).not.toBe(started.lane?.metroPid);
			now += 1_000;
			held.release();
			const launched = await launching;
			expect(launched.completed).toBe(true);
			expect(service.getState().lanes[0]).toMatchObject({
				metroPid: respawned?.metroPid,
				metro: respawned?.metro,
				lastLaunchedAt: now,
			});
		});
	});

	it('returns the Metro log tail for a lane, redacted', async () => {
		metro.healthyPorts.add(8_100);
		const started = await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: false,
		});
		const lane = started.lane as Lane;
		// App console output lands in the Metro log verbatim.
		metro.logs.set(
			lane.logPath,
			[
				'Starting Metro Bundler',
				'Waiting on http://localhost:8100',
				' LOG  login {"password":"hunter2-example"}',
				' LOG  Authorization: Bearer abcdefghijklmnop0123',
				' LOG  session eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
			].join('\n')
		);
		const log = await service.runOperation({
			actionId: 'op-2',
			kind: 'lane.log',
			laneId: lane.id,
			maxCharacters: 1_024,
		});
		expect(log.completed).toBe(true);
		expect(log.log).toContain('Waiting on http://localhost:8100');
		expect(log.log).toContain('[REDACTED');
		for (const secret of [
			'hunter2-example',
			'abcdefghijklmnop0123',
			'eyJzdWIiOiIxIn0',
		]) {
			expect(log.log).not.toContain(secret);
		}
	});

	it('returns a log tail with no Supabase secret key or database password in it', async () => {
		metro.healthyPorts.add(8_100);
		const started = await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: false,
		});
		const lane = started.lane as Lane;
		metro.logs.set(
			lane.logPath,
			[
				'SECRET_KEY=sb_secret_example0000',
				' LOG  env {"SECRET_KEY":"sb_secret_example0000"}',
				' LOG  key sb_secret_example1111',
				'DB_URL=postgresql://postgres:db-example-pw@127.0.0.1:54322/postgres',
				' LOG  connecting to postgresql://postgres:hunter2-example@127.0.0.1:54322/postgres',
			].join('\n')
		);
		const log = await service.runOperation({
			actionId: 'op-2',
			kind: 'lane.log',
			laneId: lane.id,
			maxCharacters: 1_024,
		});
		expect(log.completed).toBe(true);
		for (const secret of ['sb_secret_', 'db-example-pw', 'hunter2-example']) {
			expect(log.log).not.toContain(secret);
		}
		expect(log.log).toContain('127.0.0.1:54322/postgres');
	});

	it('keeps a redacted log tail within the requested size', async () => {
		metro.healthyPorts.add(8_100);
		const started = await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: false,
		});
		const lane = started.lane as Lane;
		// Each 'token=x' grows to 'token=[REDACTED]' when it is redacted.
		metro.logs.set(lane.logPath, 'token=x\n'.repeat(32));
		const log = await service.runOperation({
			actionId: 'op-2',
			kind: 'lane.log',
			laneId: lane.id,
			maxCharacters: 256,
		});
		expect(log.completed).toBe(true);
		expect(log.log?.length).toBeLessThanOrEqual(256);
		expect(log.log).not.toMatch(/token=x/);
	});

	it('reconciles leases on restart: dead Metros become stopped, the owner stays recorded', async () => {
		metro.healthyPorts.add(8_100);
		const started = await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: true,
			agent: { kind: 'claude', sessionId: 'session-1' },
		});
		const lane = started.lane as Lane;
		await service.stop();

		metro.deadPids.add(lane.metroPid as number);
		now += 31 * 60 * 1_000;
		const reopened = new LaneService({
			store: new LaneStore(root),
			simulator,
			metro,
			worktrees,
			now: () => now,
		});
		await reopened.start();
		const state = reopened.getState();
		expect(state.lanes[0]).toMatchObject({ id: lane.id, metro: 'stopped' });
		// The agent is the hold's owner; it is not forgotten just because it has
		// been quiet. Whether it is still alive is the agent service's call.
		expect(state.lanes[0]?.agent).toMatchObject({ sessionId: 'session-1' });
		// A stopped lane frees its port for the next lease.
		const next = await reopened.runOperation({
			actionId: 'op-2',
			kind: 'lane.start',
			worktreePath: REPO,
			simulatorUdid: OTHER_UDID,
			environment: 'development',
			launch: false,
		});
		expect(next.lane?.port).toBe(8_100);
		await reopened.stop();
	});

	it('releases a lane whose owner has been gone past the grace period, and only then', async () => {
		metro.healthyPorts.add(8_100);
		let holderLive = true;
		let releaseAt: number | undefined;
		const withHolds = new LaneService({
			store: new LaneStore(root),
			simulator,
			metro,
			worktrees,
			now: () => now,
			holds: () =>
				new Map(
					withHolds.getState().lanes.map((lane) => [
						lane.simulatorUdid.toUpperCase(),
						{
							simulatorUdid: lane.simulatorUdid.toUpperCase(),
							via: 'lane' as const,
							laneId: lane.id,
							holder: { kind: 'claude' as const, sessionId: 'session-1' },
							holderLive,
							...(holderLive ? {} : { abandonedSince: now - 1, releaseAt }),
						},
					])
				),
		});
		await withHolds.start();
		const started = await withHolds.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: false,
			agent: { kind: 'claude', sessionId: 'session-1' },
		});
		const lane = started.lane as Lane;

		// Owner alive: nothing happens on reconcile.
		await withHolds.runOperation({ actionId: 'op-r1', kind: 'lane.refresh' });
		expect(withHolds.getState().lanes).toHaveLength(1);

		// Owner gone but inside the grace period: still nothing.
		holderLive = false;
		releaseAt = now + 5 * 60_000;
		await withHolds.runOperation({ actionId: 'op-r2', kind: 'lane.refresh' });
		expect(withHolds.getState().lanes).toHaveLength(1);
		expect(metro.stopped).toEqual([]);

		// Grace elapsed: the lane is torn down and its Metro stopped. The
		// refresh starts that stop and does not wait for the Metro to exit.
		now = releaseAt;
		await withHolds.runOperation({ actionId: 'op-r3', kind: 'lane.refresh' });
		await vi.waitFor(() => expect(withHolds.getState().lanes).toEqual([]));
		expect(metro.stopped).toEqual([{ pid: lane.metroPid, port: lane.port }]);
		await withHolds.stop();
	});

	it('keeps reconciling other lanes while an abandoned lane waits for its Metro to exit', async () => {
		await service.stop();
		const abandoned = new Set<string>();
		service = new LaneService({
			store,
			simulator,
			metro,
			worktrees,
			now: () => now,
			holds: () =>
				new Map(
					service
						.getState()
						.lanes.filter((lane) => abandoned.has(lane.id))
						.map((lane) => [
							lane.simulatorUdid.toUpperCase(),
							{
								simulatorUdid: lane.simulatorUdid.toUpperCase(),
								via: 'lane' as const,
								laneId: lane.id,
								holder: { kind: 'claude' as const, sessionId: 'session-a' },
								holderLive: false,
								abandonedSince: now - 1,
								releaseAt: now,
							},
						])
				),
		});
		await service.start();
		const start = (worktreePath: string, simulatorUdid: string) =>
			service.runOperation({
				actionId: `op-two-${simulatorUdid}`,
				kind: 'lane.start',
				worktreePath,
				simulatorUdid,
				environment: 'development',
				launch: false,
			});
		const first = (await start(WORKTREE, UDID)).lane as Lane;
		const second = (await start(OTHER_WORKTREE, OTHER_UDID)).lane as Lane;
		expect(second).toMatchObject({ port: 8_101, metro: 'starting' });
		// The first lane's Metro ignores SIGTERM; only a SIGKILL ends it.
		const signals: Array<{ pid: number; force: boolean }> = [];
		const stop = metro.stop;
		metro.stop = async (pid, port, directory, options) => {
			if (pid !== first.metroPid) return stop(pid, port, directory, options);
			signals.push({ pid, force: options?.force === true });
			if (options?.force) await stop(pid, port, directory, options);
		};
		abandoned.add(first.id);
		metro.healthyPorts.add(8_101);
		const refreshed = service.runOperation({
			actionId: 'op-two-refresh',
			kind: 'lane.refresh',
		});
		await expect(
			Promise.race([refreshed, wait(2_000, 'still waiting')])
		).resolves.toMatchObject({ completed: true });
		// The second lane got its health while the first lane's stop waits.
		expect(service.getState().lanes).toMatchObject([
			{ id: first.id },
			{ id: second.id, metro: 'ready' },
		]);
		expect(signals).toEqual([{ pid: first.metroPid, force: false }]);
		// Past its grace the first lane's Metro is killed and the lane goes.
		now += 5_001;
		await vi.waitFor(() =>
			expect(service.getState().lanes.map((lane) => lane.id)).toEqual([
				second.id,
			])
		);
		expect(signals).toEqual([
			{ pid: first.metroPid, force: false },
			{ pid: first.metroPid, force: true },
		]);
	});

	it('reports a timed reconcile that could not save lane health instead of leaving it unhandled', async () => {
		await service.stop();
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on('unhandledRejection', onUnhandled);
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		try {
			store = new LaneStore(root);
			service = new LaneService({
				store,
				simulator,
				metro,
				worktrees,
				now: () => now,
			});
			await service.start();
			metro.healthyPorts.add(8_100);
			const started = await service.runOperation({
				actionId: 'op-timed-start',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: UDID,
				environment: 'development',
				launch: false,
			});
			expect(started.lane?.metro).toBe('starting');
			// The next timed pass finds Metro ready and cannot write that down.
			const failed = vi
				.spyOn(store, 'upsert')
				.mockRejectedValue(new Error('Disk full.'));
			vi.advanceTimersByTime(5_000);
			await vi.waitFor(() =>
				expect(service.getState().error).toBe(
					'Lane status could not be refreshed: Disk full.'
				)
			);
			failed.mockRestore();
			vi.advanceTimersByTime(5_000);
			await vi.waitFor(() =>
				expect(service.getState()).toMatchObject({
					lanes: [{ id: started.lane?.id, metro: 'ready' }],
				})
			);
			expect(service.getState().error).toBeUndefined();
			await nextTurn();
			expect(unhandled).toEqual([]);
		} finally {
			vi.useRealTimers();
			process.off('unhandledRejection', onUnhandled);
		}
	});

	it('notifies subscribers with a validated state on every change', async () => {
		const listener = vi.fn();
		service.subscribe(listener);
		metro.healthyPorts.add(8_100);
		await service.runOperation({
			actionId: 'op-1',
			kind: 'lane.start',
			worktreePath: WORKTREE,
			simulatorUdid: UDID,
			environment: 'development',
			launch: false,
		});
		expect(listener).toHaveBeenCalled();
		const last = listener.mock.lastCall?.[0];
		expect(last.lanes).toHaveLength(1);
		expect(last.environments.map((env: { id: string }) => env.id)).toContain(
			'development'
		);
	});

	it('keeps polling and same-app lane starts responsive while dirty checks wait', async () => {
		const start = (actionId: string) =>
			service.runOperation({
				actionId,
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: OTHER_UDID,
				environment: 'development',
				launch: false,
			});
		const entered = deferred<void>();
		const blocked = deferred<ReadonlyMap<string, boolean>>();
		const dirty = vi.spyOn(worktrees, 'readDirty').mockImplementation(() => {
			entered.resolve();
			return blocked.promise;
		});
		try {
			const first = await start('first-while-dirty');
			await entered.promise;
			expect(first.completed).toBe(true);
			expect((await service.refresh()).lanes[0]?.id).toBe(first.lane?.id);
			const resumed = await start('resume-while-dirty');
			expect(resumed.completed).toBe(true);
			expect(resumed.lane?.id).toBe(first.lane?.id);
			expect(metro.started).toHaveLength(1);
			expect(dirty).toHaveBeenCalledOnce();
		} finally {
			blocked.resolve(new Map());
		}
	});

	it('ignores dirty results from an old branch or a removed checkout and refreshes the new topology', async () => {
		const entered = deferred<void>();
		const blocked = deferred<ReadonlyMap<string, boolean>>();
		const current = deferred<ReadonlyMap<string, boolean>>();
		const replaced = deferred<void>();
		const dirty = vi
			.spyOn(worktrees, 'readDirty')
			.mockImplementationOnce(() => {
				entered.resolve();
				return blocked.promise;
			})
			.mockImplementationOnce(() => {
				replaced.resolve();
				return current.promise;
			});
		try {
			await service.addRepository(REPO);
			await entered.promise;
			worktrees.worktrees = worktrees.worktrees
				.filter((worktree) => worktree.path !== OTHER_WORKTREE)
				.map((worktree) =>
					worktree.path === WORKTREE
						? { ...worktree, branch: 'new-branch' }
						: worktree
				);
			await service.refresh();
			blocked.resolve(
				new Map([
					[WORKTREE, true],
					[OTHER_WORKTREE, true],
				])
			);
			await replaced.promise;
			const topology = service.getState().worktrees;
			expect(topology.find((row) => row.path === WORKTREE)).toMatchObject({
				branch: 'new-branch',
				dirty: false,
			});
			expect(
				topology.find((row) => row.path === OTHER_WORKTREE)
			).toBeUndefined();
			expect(dirty.mock.calls[1]?.[0]).toEqual([WORKTREE]);
			current.resolve(new Map([[WORKTREE, true]]));
			await vi.waitFor(() =>
				expect(
					service.getState().worktrees.find((row) => row.path === WORKTREE)
				).toMatchObject({ branch: 'new-branch', dirty: true })
			);
		} finally {
			blocked.resolve(new Map());
			current.resolve(new Map());
		}
	});

	it('waits for a new explicit dirty check behind an older background check and reuses recent results', async () => {
		const initial = deferred<ReadonlyMap<string, boolean>>();
		const blocked = deferred<ReadonlyMap<string, boolean>>();
		const entered = deferred<void>();
		const read = vi
			.spyOn(worktrees, 'readDirty')
			.mockImplementationOnce(() => initial.promise)
			.mockImplementationOnce(() => {
				entered.resolve();
				return blocked.promise;
			});
		await service.addRepository(REPO);
		expect(read).toHaveBeenCalledOnce();
		const refreshing = service.runOperation({
			actionId: 'op-r',
			kind: 'lane.refresh',
		});
		try {
			await expect(
				Promise.race([refreshing, nextTurn('pending')])
			).resolves.toBe('pending');
			expect(read).toHaveBeenCalledOnce();
			initial.resolve(new Map([[WORKTREE, true]]));
			await entered.promise;
			await expect(
				Promise.race([refreshing, nextTurn('pending')])
			).resolves.toBe('pending');
			await service.refresh();
			expect(read).toHaveBeenCalledTimes(2);
		} finally {
			initial.resolve(new Map());
			blocked.resolve(new Map());
		}
		const receipt = await refreshing;
		expect(
			receipt.state?.worktrees.find((row) => row.path === WORKTREE)?.dirty
		).toBe(false);
		await service.refresh();
		expect(read).toHaveBeenCalledTimes(2);
		now += 30_001;
		await service.refresh();
		await vi.waitFor(() =>
			expect(
				service.getState().worktrees.find((row) => row.path === WORKTREE)?.dirty
			).toBe(true)
		);
		expect(read).toHaveBeenCalledTimes(3);
	});

	it('aborts dirty checks on stop and discards late results', async () => {
		const entered = deferred<AbortSignal | undefined>();
		const blocked = deferred<ReadonlyMap<string, boolean>>();
		const read = vi
			.spyOn(worktrees, 'readDirty')
			.mockImplementation((_paths, signal) => {
				entered.resolve(signal);
				return blocked.promise;
			});
		await service.addRepository(REPO);
		const signal = await entered.promise;
		const revision = service.getState().revision;
		const stopping = service.stop();
		try {
			await expect(
				Promise.race([stopping, nextTurn('pending')])
			).resolves.toBeUndefined();
			expect(signal?.aborted).toBe(true);
		} finally {
			blocked.resolve(new Map([[WORKTREE, true]]));
			await stopping;
		}
		await nextTurn();
		expect(read).toHaveBeenCalledOnce();
		expect(service.getState().revision).toBe(revision);
	});

	it('discards an in-flight topology listing after its repository is removed', async () => {
		await service.addRepository(REPO);
		await vi.waitFor(() =>
			expect(
				service.getState().worktrees.find((row) => row.path === WORKTREE)?.dirty
			).toBe(true)
		);
		const entered = deferred<void>();
		const blocked = deferred<typeof worktrees.worktrees>();
		vi.spyOn(worktrees, 'listWorktrees').mockImplementationOnce(() => {
			entered.resolve();
			return blocked.promise;
		});
		const older = service.refresh();
		await entered.promise;
		const listener = vi.fn();
		service.subscribe(listener);
		const removing = service.runOperation({
			actionId: 'remove-while-listing',
			kind: 'lane.remove-repository',
			repositoryRoot: REPO,
		});
		try {
			await vi.waitFor(() => expect(store.repositories()).toEqual([]));
		} finally {
			blocked.resolve(worktrees.worktrees);
			await older;
		}
		const removed = await removing;
		expect(removed.state?.worktrees).toEqual([]);
		expect(
			listener.mock.calls.every(([state]) => state.worktrees.length === 0)
		).toBe(true);
	});

	it('retains both active lanes and registered roots when discovery exceeds its bound', async () => {
		for (const [worktreePath, simulatorUdid] of [
			[WORKTREE, UDID],
			[OTHER_WORKTREE, OTHER_UDID],
		] as const) {
			const receipt = await service.runOperation({
				actionId: `op-bounded-${simulatorUdid}`,
				kind: 'lane.start',
				worktreePath,
				simulatorUdid,
				environment: 'development',
				launch: false,
			});
			expect(receipt.completed).toBe(true);
		}
		const active = [...worktrees.worktrees];
		worktrees.worktrees = [
			...Array.from({ length: 140 }, (_, index) => ({
				path: `/Users/dev/app/archive/${index}`,
				branch: `archive-${index}`,
				repositoryRoot: REPO,
				dirty: false,
			})),
			...active,
			...active,
		];
		now += 30_001;
		const dirty = vi.spyOn(worktrees, 'readDirty');
		const state = await service.refresh();
		await vi.waitFor(() => expect(dirty).toHaveBeenCalledOnce());
		expect(dirty.mock.calls[0]?.[0]).toEqual(
			state.worktrees.map((row) => row.path)
		);
		expect(state.worktrees).toHaveLength(128);
		expect(new Set(state.worktrees.map((w) => w.path)).size).toBe(128);
		for (const target of [REPO, WORKTREE, OTHER_WORKTREE]) {
			expect(state.worktrees.some((w) => w.path === target)).toBe(true);
		}
		expect(metro.stopped).toEqual([]);
	});

	it('surfaces repository discovery errors without hiding the rest of the state', async () => {
		worktrees.listWorktrees = async () => {
			throw new Error('fatal: not a git repository');
		};
		await service.addRepository(REPO).catch(() => undefined);
		const state = await service.refresh();
		expect(state.error).toMatch(/not a git repository/);
		expect(state.repositories).toEqual([REPO]);
	});

	describe('concurrent lane ups', () => {
		beforeEach(async () => {
			// A first-time repository costs one start a real file write, which
			// would let the other start finish first; registered up front, both
			// starts interleave await for await.
			await store.addRepository(REPO);
		});

		function up(worktreePath: string, extra: Record<string, unknown> = {}) {
			return service.runOperation({
				actionId: `op-race-${Math.random().toString(16).slice(2)}`,
				kind: 'lane.start',
				worktreePath,
				environment: 'development',
				launch: false,
				...extra,
			});
		}

		function lanesOf(receipts: LaneOperationReceipt[]): Lane[] {
			return receipts.flatMap((receipt) =>
				receipt.lane ? [receipt.lane] : []
			);
		}

		it('never share a Simulator or a port', async () => {
			const receipts = await Promise.all([up(WORKTREE), up(OTHER_WORKTREE)]);
			expect(receipts.map((receipt) => receipt.completed)).toEqual([
				true,
				true,
			]);
			const lanes = lanesOf(receipts);
			expect(lanes).toHaveLength(2);
			expect(new Set(lanes.map((lane) => lane.simulatorUdid)).size).toBe(2);
			expect(new Set(lanes.map((lane) => lane.port)).size).toBe(2);
			expect(service.getState().lanes).toHaveLength(2);
		});

		it('give the one free booted Simulator to one lane and park the other start', async () => {
			simulator.state = simulatorState([{ udid: OTHER_UDID, state: 'booted' }]);
			const receipts = await Promise.all([up(WORKTREE), up(OTHER_WORKTREE)]);
			const lanes = lanesOf(receipts);
			expect(lanes).toHaveLength(1);
			expect(lanes[0]?.simulatorUdid).toBe(OTHER_UDID);
			const requests = receipts.flatMap((receipt) =>
				receipt.deviceRequest ? [receipt.deviceRequest] : []
			);
			expect(requests).toHaveLength(1);
			expect(requests[0]?.message).toMatch(/1 by lanes/);
			expect(metro.started).toHaveLength(1);
		});

		it('refuse a named Simulator another start is already taking', async () => {
			const receipts = await Promise.all([
				up(WORKTREE, { simulatorUdid: UDID }),
				up(OTHER_WORKTREE, { simulatorUdid: UDID }),
			]);
			expect(lanesOf(receipts)).toHaveLength(1);
			const refused = receipts.find((receipt) => !receipt.completed);
			expect(refused?.error).toMatch(/already assigned to a lane starting/);
			expect(metro.started).toHaveLength(1);
		});

		it('run one at a time for the same app, so the second resumes the first', async () => {
			const [first, second] = await Promise.all([up(WORKTREE), up(WORKTREE)]);
			expect(first?.lane?.id).toBeDefined();
			expect(second?.lane?.id).toBe(first?.lane?.id);
			expect(metro.started).toHaveLength(1);
			expect(service.getState().lanes).toHaveLength(1);
		});

		it("keep a resuming lane's port from a fresh start", async () => {
			const first = await up(WORKTREE, { simulatorUdid: UDID });
			const stale = first.lane as Lane;
			metro.deadPids.add(stale.metroPid as number);
			await service.runOperation({ actionId: 'op-r', kind: 'lane.refresh' });
			expect(service.getState().lanes[0]?.metro).toBe('stopped');

			// The stopped lane's port looks free. Hold the resume while it
			// respawns Metro there, and run a fresh start to completion meanwhile.
			let release: () => void = () => undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const launch = metro.start;
			metro.start = async (input) => {
				if (input.worktreePath === WORKTREE) await gate;
				return launch(input);
			};
			const resume = up(WORKTREE, { simulatorUdid: UDID });
			const fresh = await up(OTHER_WORKTREE, { simulatorUdid: OTHER_UDID });
			release();
			const receipts = [await resume, fresh];
			expect(receipts.map((receipt) => receipt.completed)).toEqual([
				true,
				true,
			]);
			expect(receipts[0]?.lane).toMatchObject({ id: stale.id, port: 8_100 });
			const ports = service
				.getState()
				.lanes.filter((lane) => lane.metro !== 'stopped')
				.map((lane) => lane.port);
			expect(ports).toHaveLength(2);
			expect(new Set(ports).size).toBe(2);
		});

		it('refuse to resume a lane on a port that went to another lane', async () => {
			const first = await up(WORKTREE, { simulatorUdid: UDID });
			const stale = first.lane as Lane;
			metro.deadPids.add(stale.metroPid as number);
			await service.runOperation({ actionId: 'op-r', kind: 'lane.refresh' });
			const second = await up(OTHER_WORKTREE, { simulatorUdid: OTHER_UDID });
			expect(second.lane?.port).toBe(stale.port);

			const resumed = await up(WORKTREE, { simulatorUdid: UDID });
			expect(resumed.completed).toBe(false);
			expect(resumed.error).toMatch(
				new RegExp(`Port ${stale.port} now belongs to lane ${second.lane?.id}`)
			);
			expect(metro.started).toHaveLength(2);
		});

		it('keep a Simulator the user chose for a parked start from an agent picking it', async () => {
			// Park a start for the third worktree, then free one device.
			await up(WORKTREE, { simulatorUdid: UDID });
			const other = await up(OTHER_WORKTREE, { simulatorUdid: OTHER_UDID });
			const parked = await up(THIRD_WORKTREE);
			await service.runOperation({
				actionId: 'op-stop',
				kind: 'lane.stop',
				laneId: other.lane?.id as string,
			});

			const [provided, agentUp] = await Promise.all([
				service.runOperation({
					actionId: 'op-use',
					kind: 'lane.provide-device',
					requestId: parked.deviceRequest?.id as string,
					decision: 'use',
					simulatorUdid: OTHER_UDID,
				}),
				up(REPO),
			]);
			expect(provided.lane).toMatchObject({
				simulatorUdid: OTHER_UDID,
				worktreePath: THIRD_WORKTREE,
			});
			expect(agentUp.lane).toBeUndefined();
			expect(agentUp.deviceRequest?.status).toBe('pending');
		});
	});

	describe('Metro health', () => {
		it('rechecks identity before a direct launch, and a cached PID that now belongs to another app reads as a stopped Metro', async () => {
			const started = await service.runOperation({
				actionId: 'op-recycled-start',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: OTHER_UDID,
				environment: 'development',
				launch: false,
			});
			metro.healthyPorts.add(8_100);
			const verify = vi
				.spyOn(metro, 'verifyOwnership')
				.mockRejectedValue(
					new NotLaneMetroError('Another app now owns this PID.')
				);
			const result = await service.runOperation({
				actionId: 'op-recycled-launch',
				kind: 'lane.launch',
				laneId: started.lane?.id as string,
			});
			expect(result.completed).toBe(false);
			expect(result.error).toBe(
				`Metro isn't running for lane ${started.lane?.id}. Run lane up to start it again.`
			);
			expect(verify).toHaveBeenCalledWith(
				started.lane?.metroPid,
				8_100,
				WORKTREE
			);
			expect(simulator.actions).toEqual([]);
			expect(metro.stopped).toEqual([]);
			// The PID is some other process's now: the lane forgets it, so nothing
			// ever signals it, and its port is free for its next Metro.
			const lane = service.getState().lanes[0];
			expect(lane).toMatchObject({ id: started.lane?.id, metro: 'stopped' });
			expect(lane).not.toHaveProperty('metroPid');
			expect(service.getState().error).toBeUndefined();
			verify.mockRestore();
		});

		it('starts a new Metro on lane up when the recorded PID now names another process', async () => {
			metro.healthyPorts.add(8_100);
			const first = await service.runOperation({
				actionId: 'op-recycled-first',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: OTHER_UDID,
				environment: 'development',
				launch: false,
			});
			// The lane's Metro is gone and an unrelated process has its PID.
			metro.listeners.delete(8_100);
			const verify = vi
				.spyOn(metro, 'verifyOwnership')
				.mockRejectedValueOnce(
					new NotLaneMetroError(
						`Process ${first.lane?.metroPid} is no longer the Metro serving port 8100; refusing to stop it.`
					)
				);
			try {
				const resumed = await service.runOperation({
					actionId: 'op-recycled-up',
					kind: 'lane.start',
					worktreePath: WORKTREE,
					simulatorUdid: OTHER_UDID,
					environment: 'development',
					launch: true,
				});
				expect(resumed.completed).toBe(true);
				expect(resumed.lane).toMatchObject({
					id: first.lane?.id,
					port: 8_100,
					metro: 'ready',
				});
				expect(resumed.lane?.metroPid).not.toBe(first.lane?.metroPid);
				expect(metro.started).toHaveLength(2);
				expect(metro.stopped).toEqual([]);
				expect(service.getState().error).toBeUndefined();
			} finally {
				verify.mockRestore();
			}
		});

		it('adopts a surviving lease whose PID now names another process as stopped, and lane up restarts it', async () => {
			metro.healthyPorts.add(8_100);
			const started = await service.runOperation({
				actionId: 'op-recycled-adopt-start',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: OTHER_UDID,
				environment: 'development',
				launch: false,
			});
			await service.stop();
			metro.listeners.delete(8_100);
			const verify = vi
				.spyOn(metro, 'verifyOwnership')
				.mockRejectedValue(
					new NotLaneMetroError(
						`Process ${started.lane?.metroPid} is no longer the Metro serving port 8100; refusing to stop it.`
					)
				);
			store = new LaneStore(root);
			service = new LaneService({
				store,
				simulator,
				metro,
				worktrees,
				now: () => now,
			});
			await service.start();
			await vi.waitFor(() =>
				expect(service.getState().lanes[0]).toMatchObject({
					id: started.lane?.id,
					metro: 'stopped',
				})
			);
			expect(service.getState().lanes[0]).not.toHaveProperty('metroPid');
			expect(service.getState().error).toBeUndefined();
			await vi.waitFor(async () => {
				const reopened = new LaneStore(root);
				await reopened.start();
				expect(reopened.lanes()[0]).toMatchObject({ metro: 'stopped' });
				expect(reopened.lanes()[0]?.metroPid).toBeUndefined();
			});
			verify.mockRestore();
			const resumed = await service.runOperation({
				actionId: 'op-recycled-adopt-up',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: OTHER_UDID,
				environment: 'development',
				launch: false,
			});
			expect(resumed.completed).toBe(true);
			expect(resumed.lane).toMatchObject({ id: started.lane?.id, port: 8_100 });
			expect(resumed.lane?.metroPid).not.toBe(started.lane?.metroPid);
			expect(metro.stopped).toEqual([]);
		});

		it('starts the desktop service without waiting for surviving Metro ownership probes', async () => {
			const started = await service.runOperation({
				actionId: 'op-background-start',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: OTHER_UDID,
				environment: 'development',
				launch: false,
			});
			await service.stop();
			const ownership = deferred<boolean>();
			const verify = vi
				.spyOn(metro, 'verifyOwnership')
				.mockReturnValue(ownership.promise);
			metro.healthyPorts.add(started.lane?.port as number);
			service = new LaneService({
				store: new LaneStore(root),
				simulator,
				metro,
				worktrees,
				now: () => now,
			});
			await service.start();
			expect(verify).toHaveBeenCalledOnce();
			expect(service.getState().lanes[0]?.metro).toBe('starting');
			ownership.resolve(true);
			await vi.waitFor(() =>
				expect(service.getState().lanes[0]?.metro).toBe('ready')
			);
			verify.mockRestore();
		});

		describe('shutdown during startup reconciliation', () => {
			let health: ReturnType<typeof deferred<boolean>>;

			beforeEach(async () => {
				await service.runOperation({
					actionId: 'op-before-shutdown',
					kind: 'lane.start',
					worktreePath: WORKTREE,
					simulatorUdid: OTHER_UDID,
					environment: 'development',
					launch: false,
				});
				await service.stop();
				health = deferred<boolean>();
				const probing = deferred<void>();
				metro.isHealthy = () => {
					probing.resolve();
					return health.promise;
				};
				store = new LaneStore(root);
				service = new LaneService({
					store,
					simulator,
					metro,
					worktrees,
					now: () => now,
				});
				await service.start();
				await probing.promise;
			});

			it('discards a health result received after stop without waiting for the probe', async () => {
				const write = vi.spyOn(store, 'upsert');
				const stopping = service.stop();
				try {
					await expect(
						Promise.race([stopping, nextTurn('pending')])
					).resolves.toBeUndefined();
				} finally {
					health.resolve(true);
					await stopping;
				}
				await nextTurn();
				expect(write).not.toHaveBeenCalled();
				expect(metro.stopped).toEqual([]);
			});

			it('drains the durable write already started by reconciliation', async () => {
				const writing = deferred<void>();
				const writeAllowed = deferred<void>();
				const upsert = store.upsert.bind(store);
				vi.spyOn(store, 'upsert').mockImplementation(async (lane) => {
					writing.resolve();
					await writeAllowed.promise;
					await upsert(lane);
				});
				health.resolve(true);
				await writing.promise;
				const stopping = service.stop();
				try {
					await expect(
						Promise.race([stopping, nextTurn('pending')])
					).resolves.toBe('pending');
				} finally {
					writeAllowed.resolve();
					await stopping;
				}
				const reopened = new LaneStore(root);
				await reopened.start();
				expect(reopened.lanes()[0]?.metro).toBe('ready');
				expect(metro.stopped).toEqual([]);
			});
		});

		it.each(['another app directory', 'ownership probe timeout'] as const)(
			'refuses a surviving PID with %s even when that PID serves /status on its port',
			async (failure) => {
				metro.healthyPorts.add(8_100);
				const started = await service.runOperation({
					actionId: 'op-adoption-start',
					kind: 'lane.start',
					worktreePath: WORKTREE,
					simulatorUdid: OTHER_UDID,
					environment: 'development',
					launch: false,
				});
				await service.stop();
				const verify = vi
					.spyOn(metro, 'verifyOwnership')
					.mockRejectedValue(new Error(failure));
				const backends = new FakeBackends();
				service = new LaneService({
					store: new LaneStore(root),
					simulator,
					metro,
					worktrees,
					backends,
					now: () => now,
				});
				await service.start();
				await vi.waitFor(() =>
					expect(service.getState().error).toContain('Cannot adopt Metro')
				);
				expect(await metro.isHealthy(8_100, started.lane?.metroPid)).toBe(true);
				expect(service.getState()).toMatchObject({
					error: expect.stringContaining('Cannot adopt Metro'),
					lanes: [{ id: started.lane?.id, metro: 'starting' }],
				});
				const launch = await service.runOperation({
					actionId: 'op-adoption-launch',
					kind: 'lane.launch',
					laneId: started.lane?.id as string,
				});
				expect(launch.completed).toBe(false);
				expect(launch.error).toContain(failure);
				const resumed = await service.runOperation({
					actionId: 'op-adoption-resume',
					kind: 'lane.start',
					worktreePath: WORKTREE,
					simulatorUdid: OTHER_UDID,
					environment: 'development',
					launch: false,
				});
				expect(resumed.completed).toBe(false);
				expect(resumed.error).toContain(failure);
				expect(backends.ensured).toEqual([]);
				expect(simulator.actions).toEqual([]);
				expect(metro.started).toHaveLength(1);
				expect(metro.stopped).toEqual([]);
				// A transient probe failure can recover on explicit retry.
				verify.mockRestore();
				expect(
					(
						await service.runOperation({
							actionId: 'op-adoption-retry',
							kind: 'lane.start',
							worktreePath: WORKTREE,
							simulatorUdid: OTHER_UDID,
							environment: 'development',
							backend: 'off',
							launch: false,
						})
					).completed
				).toBe(true);
				expect(service.getState().error).toBeUndefined();
			}
		);

		it("does not launch against another packager answering on the lane's port", async () => {
			// Something grabbed 8100 after the bind probe passed and answers /status.
			metro.healthyPorts.add(8_100);
			metro.listeners.set(8_100, 31_337);
			const started = service.runOperation({
				actionId: 'op-1',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: UDID,
				environment: 'development',
				launch: true,
			});
			const advance = setInterval(() => {
				now += 5_000;
			}, 5);
			const receipt = await started;
			clearInterval(advance);
			expect(receipt.completed).toBe(false);
			expect(receipt.error).toMatch(/did not become ready/);
			expect(simulator.actions.map((action) => action.kind)).not.toContain(
				'url.open'
			);
			expect(service.getState().lanes[0]?.metro).toBe('starting');
		});

		it("restarts a dead lane's Metro instead of trusting another packager on its port", async () => {
			metro.healthyPorts.add(8_100);
			const first = await service.runOperation({
				actionId: 'op-1',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: UDID,
				environment: 'development',
				launch: false,
			});
			metro.deadPids.add(first.lane?.metroPid as number);
			metro.listeners.set(8_100, 31_337);
			const again = await service.runOperation({
				actionId: 'op-2',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: UDID,
				environment: 'development',
				launch: false,
			});
			expect(again.lane?.id).toBe(first.lane?.id);
			expect(metro.started).toHaveLength(2);
			expect(again.lane?.metroPid).not.toBe(first.lane?.metroPid);
		});

		it("reports ready on reconcile only for the lane's own Metro", async () => {
			metro.healthyPorts.add(8_100);
			metro.listeners.set(8_100, 31_337);
			await service.runOperation({
				actionId: 'op-1',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: UDID,
				environment: 'development',
				launch: false,
			});
			await service.runOperation({ actionId: 'op-r', kind: 'lane.refresh' });
			expect(service.getState().lanes[0]?.metro).toBe('starting');
			metro.listeners.delete(8_100);
			metro.listeners.set(8_100, service.getState().lanes[0]?.metroPid ?? 0);
			await service.runOperation({ actionId: 'op-r2', kind: 'lane.refresh' });
			expect(service.getState().lanes[0]?.metro).toBe('ready');
		});

		it('does not bring back a lane stopped while reconcile was probing it', async () => {
			metro.healthyPorts.add(8_100);
			const started = await service.runOperation({
				actionId: 'op-1',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: UDID,
				environment: 'development',
				launch: false,
			});
			let release: () => void = () => undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const probe = metro.isHealthy;
			metro.isHealthy = async (port, pid) => {
				await gate;
				return probe(port, pid);
			};
			const refreshed = service.runOperation({
				actionId: 'op-r',
				kind: 'lane.refresh',
			});
			const stopped = await service.runOperation({
				actionId: 'op-stop',
				kind: 'lane.stop',
				laneId: started.lane?.id as string,
			});
			expect(stopped.completed).toBe(true);
			release();
			await refreshed;
			expect(service.getState().lanes).toEqual([]);
		});

		it("keeps a restarted lane's Metro verified when a reconcile that began before the restart reaches it", async () => {
			metro.healthyPorts.add(8_100);
			metro.healthyPorts.add(8_101);
			const first = await service.runOperation({
				actionId: 'op-race-a',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: UDID,
				environment: 'development',
				launch: false,
			});
			const second = await service.runOperation({
				actionId: 'op-race-b',
				kind: 'lane.start',
				worktreePath: OTHER_WORKTREE,
				simulatorUdid: OTHER_UDID,
				environment: 'development',
				launch: false,
			});
			const laneId = second.lane?.id as string;
			expect(first.lane?.port).toBe(8_100);
			expect(second.lane?.port).toBe(8_101);
			// The reconcile holds on the first lane's probe, with its snapshot of
			// the second lane taken before that lane's Metro is replaced.
			const probing = deferred<void>();
			const released = deferred<void>();
			const probe = metro.isHealthy;
			metro.isHealthy = async (port, pid) => {
				if (port === 8_100) {
					probing.resolve();
					await released.promise;
				}
				return probe(port, pid);
			};
			const refreshed = service.runOperation({
				actionId: 'op-race-refresh',
				kind: 'lane.refresh',
			});
			await probing.promise;
			await service.restartMetro(laneId, 'operator');
			const restarted = service
				.getState()
				.lanes.find((lane) => lane.id === laneId);
			expect(restarted?.metroPid).not.toBe(second.lane?.metroPid);
			released.resolve();
			expect((await refreshed).completed).toBe(true);
			await service.runOperation({
				actionId: 'op-race-refresh-2',
				kind: 'lane.refresh',
			});
			expect(
				service.getState().lanes.find((lane) => lane.id === laneId)
			).toMatchObject({ metroPid: restarted?.metroPid, metro: 'ready' });
			await expect(
				service.restartMetro(laneId, 'operator')
			).resolves.toBeUndefined();
		});

		it("keeps a lane's Metro verified while a launch re-checks its identity", async () => {
			healthyMetro();
			const started = await service.runOperation({
				actionId: 'op-reprobe-start',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: UDID,
				environment: 'development',
				launch: true,
			});
			expect(started.lane?.metro).toBe('ready');
			const verifying = deferred<void>();
			const verified = deferred<boolean>();
			const verify = vi
				.spyOn(metro, 'verifyOwnership')
				.mockImplementation(async () => {
					verifying.resolve();
					return verified.promise;
				});
			try {
				const launching = service.runOperation({
					actionId: 'op-reprobe-launch',
					kind: 'lane.launch',
					laneId: started.lane?.id as string,
				});
				await verifying.promise;
				// Whatever reads the lane while the probe runs still sees the Metro
				// it saw before the probe began.
				await service.runOperation({
					actionId: 'op-reprobe-refresh',
					kind: 'lane.refresh',
				});
				expect(service.getState().lanes[0]?.metro).toBe('ready');
				verified.resolve(true);
				expect((await launching).completed).toBe(true);
			} finally {
				verify.mockRestore();
			}
		});
	});

	describe('lane environment for Metro', () => {
		it('passes no lane env when no port supplies one', async () => {
			metro.healthyPorts.add(8_100);
			await service.runOperation({
				actionId: 'op-1',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: UDID,
				environment: 'development',
				launch: false,
			});
			expect(metro.started[0]).not.toHaveProperty('laneEnv');
		});

		it('refuses a new lane before its Simulator boots when no Metro could start with the desktop environment', async () => {
			metro.environmentIssue = MALFORMED_STRIP;
			const receipt = await service.runOperation({
				actionId: 'op-malformed-strip',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: UDID,
				environment: 'development',
				launch: false,
			});
			expect(receipt).toMatchObject({
				completed: false,
				error: MALFORMED_STRIP,
			});
			expect(simulator.actions).toEqual([]);
			expect(metro.started).toEqual([]);
			expect(service.getState().lanes).toEqual([]);
		});

		it('keeps the running Metro when the desktop environment would refuse its replacement', async () => {
			const started = await service.runOperation({
				actionId: 'op-respawn-strip',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: OTHER_UDID,
				environment: 'development',
				launch: false,
			});
			const laneId = started.lane?.id as string;
			// A desktop started with a malformed list adopts the Metros that
			// survived it; a restart must not stop one it cannot replace.
			metro.environmentIssue = MALFORMED_STRIP;
			await expect(service.restartMetro(laneId, 'operator')).rejects.toThrow(
				MALFORMED_STRIP
			);
			expect(metro.stopped).toEqual([]);
			expect(metro.started).toHaveLength(1);
			expect(metro.isProcessRunning(1_001)).toBe(true);
			expect(service.getState().lanes).toMatchObject([
				{ id: laneId, metroPid: 1_001 },
			]);
		});
	});

	describe('local backends', () => {
		let backends: FakeBackends;
		let lanes: LaneService;

		beforeEach(async () => {
			backends = new FakeBackends();
			// Every spawn gets its own PID and answers at once, so a restart
			// is visible as a new Metro on the same port. Under a malformed
			// strip list it refuses, as the real supervisor's start does.
			metro.start = async (input) => {
				if (metro.environmentIssue) throw new Error(metro.environmentIssue);
				metro.healthyPorts.add(input.port);
				return metro.launch(input);
			};
			lanes = new LaneService({
				store: new LaneStore(root),
				simulator,
				metro,
				worktrees,
				now: () => now,
				backends,
			});
			await lanes.start();
		});

		afterEach(async () => {
			await lanes.stop();
		});

		function up(extra: Record<string, unknown> = {}) {
			return lanes.runOperation({
				actionId: `op-backend-${Math.random().toString(16).slice(2)}`,
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: UDID,
				environment: 'development',
				launch: true,
				agent: { kind: 'claude', sessionId: 'session-1' },
				...extra,
			});
		}

		function kinds(): string[] {
			return simulator.actions.map((action) => action.kind);
		}

		async function restart() {
			await lanes.stop();
			lanes = new LaneService({
				store: new LaneStore(root),
				simulator,
				metro,
				worktrees,
				now: () => now,
				backends,
			});
			await lanes.start();
		}

		it('restores a backend hold after restart without replacing Metro or reopening the app', async () => {
			const started = await up();
			const actions = [...simulator.actions];
			await restart();
			await eventually(() =>
				expect(lanes.getState().lanes[0]?.backend).toMatchObject({
					status: 'ready',
					metro: 'unchanged',
				})
			);
			expect(backends.ensured).toHaveLength(2);
			expect(backends.ensured[1]).toMatchObject({
				laneId: started.lane?.id,
				policy: 'auto',
				waitMs: 0,
			});
			expect(lanes.getState().lanes[0]?.metroPid).toBe(started.lane?.metroPid);
			expect(metro.started).toHaveLength(1);
			expect(metro.stopped).toEqual([]);
			expect(simulator.actions).toEqual(actions);
			expect((await up({ launch: false })).backend?.metro).toBe('unchanged');
			expect(metro.started).toHaveLength(1);
		});

		it('keeps an explicit backend off across restart and a repeated lane up', async () => {
			await up({ backend: 'off', launch: false });
			await restart();
			await up({ launch: false });
			expect(backends.ensured).toEqual([]);
			expect(lanes.getState().lanes[0]?.backendPolicy).toBe('off');
			expect(lanes.getState().lanes[0]).not.toHaveProperty('backend');
			expect(metro.started).toHaveLength(1);
		});

		it('keeps an explicit backend off when the operator restarts Metro', async () => {
			const started = await up({ backend: 'off', launch: false });
			await restart();
			await lanes.restartMetro(started.lane?.id as string, 'operator');
			expect(backends.ensured).toEqual([]);
			expect(lanes.getState().lanes[0]?.backendPolicy).toBe('off');
			expect(lanes.getState().lanes[0]).not.toHaveProperty('backend');
			expect(metro.started).toHaveLength(2);
			expect(metro.started[1]).not.toHaveProperty('laneEnv');
		});

		it('restores a late backend without restarting the surviving Metro or launching', async () => {
			await up({ launch: false });
			const late = deferred<LaneBackendLateAttach>();
			backends.answers.push(starting(late.promise));
			const actions = [...simulator.actions];
			await restart();
			await eventually(() =>
				expect(lanes.getState().lanes[0]?.backend?.status).toBe('starting')
			);
			late.resolve(ready());
			await eventually(() =>
				expect(lanes.getState().lanes[0]?.backend?.metro).toBe('unchanged')
			);
			expect(metro.started).toHaveLength(1);
			expect(metro.stopped).toEqual([]);
			expect(simulator.actions).toEqual(actions);
		});

		it('reports changed backend values after restart and waits for an explicit lane up to replace Metro', async () => {
			const started = await up({ launch: false });
			backends.answers.push(ready(MOVED_API_URL));
			await restart();
			await eventually(() =>
				expect(lanes.getState().lanes[0]?.backend).toMatchObject({
					apiUrl: MOVED_API_URL,
					metro: 'needs-restart',
				})
			);
			expect(lanes.getState().lanes[0]?.metroPid).toBe(started.lane?.metroPid);
			expect(metro.stopped).toEqual([]);
			backends.answers.push(ready(MOVED_API_URL));
			expect((await up({ launch: false })).backend?.metro).toBe('restarted');
			expect(metro.started[1]?.laneEnv).toEqual(backendEnv(MOVED_API_URL));
		});

		it('does not stop a surviving required lane when backend restoration fails', async () => {
			const started = await up({ backend: 'required', launch: false });
			backends.answers.push({
				summary: {
					policy: 'required',
					status: 'failed',
					reason: 'failed',
					appEnvNames: [],
					warnings: [],
				},
			});
			await restart();
			await eventually(() =>
				expect(lanes.getState().lanes[0]?.backend).toMatchObject({
					policy: 'required',
					status: 'failed',
				})
			);
			expect(lanes.getState().lanes[0]?.metroPid).toBe(started.lane?.metroPid);
			expect(metro.stopped).toEqual([]);
		});

		it('does not guess a legacy lane policy or start a backend for a dead Metro', async () => {
			const started = await up({ launch: false });
			await lanes.stop();
			const file = path.join(root, 'lanes.json');
			const stored = JSON.parse(await readFile(file, 'utf8'));
			delete stored.lanes[0].backendPolicy;
			delete stored.lanes[0].backendEnvHash;
			await writeFile(file, JSON.stringify(stored));
			await restart();
			expect(backends.ensured).toHaveLength(1);
			await up({ launch: false });
			const current = lanes.getState().lanes[0];
			expect(current?.backendPolicy).toBe('auto');
			metro.deadPids.add(current?.metroPid as number);
			const ensures = backends.ensured.length;
			await restart();
			expect(backends.ensured).toHaveLength(ensures);
			expect(lanes.getState().lanes[0]?.id).toBe(started.lane?.id);
		});

		it('releases a restored backend that finishes after the lane was stopped', async () => {
			const started = await up({ launch: false });
			const answer = deferred<LaneBackendEnsureResult>();
			backends.answers.push(answer.promise);
			await restart();
			await eventually(() => expect(backends.ensured).toHaveLength(2));
			await lanes.stopLane(started.lane?.id as string);
			answer.resolve(ready());
			await eventually(() => expect(backends.detached).toHaveLength(2));
			expect(lanes.getState().lanes).toEqual([]);
			expect(metro.started).toHaveLength(1);
		});

		it('does not recreate a lane stopped while a repeated lane up waits for its backend', async () => {
			const started = await up({ launch: false });
			const answer = deferred<LaneBackendEnsureResult>();
			backends.answers.push(answer.promise);
			const resuming = up({ launch: false });
			await eventually(() => expect(backends.ensured).toHaveLength(2));
			await lanes.stopLane(started.lane?.id as string);
			answer.resolve(ready());
			expect((await resuming).completed).toBe(false);
			expect(lanes.getState().lanes).toEqual([]);
			expect(metro.started).toHaveLength(1);
		});

		it("puts each worktree's Supabase project on the lane wire", async () => {
			metro.healthyPorts.add(8_100);
			expect((await up()).completed).toBe(true);
			const worktreeOf = (state: LaneState) =>
				state.worktrees.find((worktree) => worktree.path === WORKTREE);
			expect(worktreeOf(lanes.getState())?.supabase).toBeUndefined();
			const published: LaneState[] = [];
			lanes.subscribe((state) => published.push(state));
			backends.described.set(WORKTREE, {
				project: 'managed',
				portsPinned: true,
			});
			lanes.backendsChanged();
			expect(published).toHaveLength(1);
			expect(worktreeOf(published[0] as LaneState)?.supabase).toEqual({
				project: 'managed',
				portsPinned: true,
			});
			// Nothing the start form shows moved: nothing is published.
			lanes.backendsChanged();
			expect(published).toHaveLength(1);
			// A malformed or failing answer reads as unknown.
			backends.described.set(WORKTREE, {
				project: 'elsewhere',
			} as unknown as LaneWorktreeSupabase);
			lanes.backendsChanged();
			expect(published).toHaveLength(2);
			expect(worktreeOf(published[1] as LaneState)?.supabase).toBeUndefined();
			backends.describeError = new Error('the backend went away');
			expect(worktreeOf(lanes.getState())?.supabase).toBeUndefined();
		});

		/** Waits for work a lane does on its own, such as a late attach. */
		function eventually(assertion: () => void) {
			return vi.waitFor(assertion, { timeout: 3_000 });
		}

		/** Runs the injected clock fast until `done` holds. */
		async function advanceClockUntil(done: () => boolean) {
			const advance = setInterval(() => {
				now += 5_000;
			}, 5);
			try {
				await vi.waitFor(() => expect(done()).toBe(true), { timeout: 4_000 });
			} finally {
				clearInterval(advance);
			}
		}

		it.each(['stopped', 'failed', 'disabled'] as const)(
			'publishes %s backend health and requires explicit lane up to recover',
			async (status) => {
				const started = await up({ backend: 'required', launch: false });
				const initial = createSupabaseDemoState();
				const template = initial.stacks[0];
				if (!template) throw new Error('Demo stack fixture missing.');
				const healthy: SupabaseState = {
					...initial,
					stacks: [
						{
							...template,
							id: STACK_ID,
							state: 'running',
							lifecycle: 'running',
							ownerLiveness: 'reachable',
							readiness: 'ready',
							exposure: { verdict: 'loopback' },
							mode: { value: 'managed' },
							flags: [],
							apiUrl: API_URL,
						},
					],
				};
				const published: LaneState[] = [];
				lanes.subscribe((state) => published.push(state));
				const ensures = backends.ensured.length;
				const actions = simulator.actions.length;
				backends.runtimeState =
					status === 'disabled'
						? { ...healthy, feature: { ...healthy.feature, enabled: false } }
						: {
								...healthy,
								stacks: healthy.stacks.map((stack) => ({
									...stack,
									state: status,
								})),
							};
				lanes.backendsChanged();
				expect(published).toHaveLength(1);
				expect(published[0]?.lanes[0]?.backend?.status).toBe(
					status === 'disabled' ? 'skipped' : status
				);
				lanes.backendsChanged();
				expect(published).toHaveLength(1);
				expect(backends.ensured).toHaveLength(ensures);
				const launch = await lanes.runOperation({
					actionId: 'backend-stopped-launch',
					kind: 'lane.launch',
					laneId: started.lane?.id as string,
				});
				expect(launch.completed).toBe(false);
				expect(launch.error).toContain('requires its local backend');
				// The receipt says where the backend stands and names the lane.
				expect(launch.backend).toMatchObject({ policy: 'required' });
				expect(launch.lane?.id).toBe(started.lane?.id);
				expect(simulator.actions).toHaveLength(actions);
				backends.runtimeState = healthy;
				lanes.backendsChanged();
				expect(lanes.getState().lanes[0]?.backend?.status).not.toBe('ready');
				expect(
					(await up({ backend: 'required', launch: false })).completed
				).toBe(true);
				expect(lanes.getState().lanes[0]?.backend?.status).toBe('ready');
			}
		);

		it.each(['throws', 'oversized'] as const)(
			'retains recovery identity when the cached health projector %s',
			async (failure) => {
				await up({ backend: 'required', launch: false });
				const describe = vi
					.spyOn(backends, 'describeSummary')
					.mockImplementation((previous) => {
						if (failure === 'throws') throw new Error('Projection failed.');
						return { ...previous, reasonText: 'x'.repeat(5_000) };
					});
				try {
					lanes.backendsChanged();
					const backend = lanes.getState().lanes[0]?.backend;
					expect(backend).toMatchObject({
						status: 'failed',
						stackId: STACK_ID,
					});
					expect(backend?.reasonText?.length).toBeLessThanOrEqual(1_024);
				} finally {
					describe.mockRestore();
				}
			}
		);

		it('keeps required launches blocked when Metro could not apply changed backend values', async () => {
			const started = await up({ backend: 'required', launch: false });
			backends.answers.push(ready(MOVED_API_URL));
			const stop = vi
				.spyOn(metro, 'stop')
				.mockRejectedValueOnce(new Error('Ownership probe unavailable.'));
			try {
				const resumed = await up({ backend: 'required', launch: false });
				expect(resumed.backend?.metro).toBe('needs-restart');
				const actions = simulator.actions.length;
				const launched = await lanes.runOperation({
					actionId: 'backend-unapplied-launch',
					kind: 'lane.launch',
					laneId: started.lane?.id as string,
				});
				expect(launched.completed).toBe(false);
				expect(launched.error).toContain('Ownership probe unavailable');
				expect(simulator.actions).toHaveLength(actions);
			} finally {
				stop.mockRestore();
			}
		});

		it('ensures the backend while the Simulator boots, then hands Metro exactly the mapped public names', async () => {
			const answer = deferred<LaneBackendEnsureResult>();
			backends.answers.push(answer.promise);
			const bootRequestedAtEnsure: boolean[] = [];
			backends.onEnsure = () => {
				bootRequestedAtEnsure.push(kinds().includes('device.boot'));
			};
			const started = up();
			// The boot goes ahead while the backend is still coming up, and
			// Metro waits for it.
			await vi.waitFor(() => expect(kinds()).toContain('device.boot'));
			expect(bootRequestedAtEnsure).toEqual([false]);
			expect(metro.started).toEqual([]);

			answer.resolve(ready());
			const receipt = await started;
			expect(receipt.completed).toBe(true);
			expect(backends.ensured).toEqual([
				{
					laneId: receipt.lane?.id,
					worktreePath: WORKTREE,
					branch: 'feature/a',
					environmentId: 'development',
					policy: 'auto',
					agent: { kind: 'claude', sessionId: 'session-1' },
					waitMs: 15_000,
				},
			]);
			expect(metro.started).toHaveLength(1);
			expect(metro.started[0]?.laneEnv).toEqual({
				EXPO_PUBLIC_SUPABASE_URL: API_URL,
				EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
			});
			expect(receipt.backend).toEqual(readySummary());
			expect(receipt.lane?.backend).toEqual(readySummary());
			expect(lanes.getState().lanes[0]?.backend).toEqual(readySummary());
			expect(kinds()).toEqual([
				'device.boot',
				'app.list',
				'app.terminate',
				'url.open',
			]);
		});

		it('waits at most 15 s past the Metro spawn point, then defers the launch until a late attach restarts Metro with the backend', async () => {
			const answer = deferred<LaneBackendEnsureResult>();
			backends.answers.push(answer.promise);
			const started = up();
			await advanceClockUntil(() => metro.started.length === 1);
			const receipt = await started;
			expect(receipt.completed).toBe(true);
			const first = receipt.lane as Lane;
			expect(metro.started[0]).not.toHaveProperty('laneEnv');
			expect(receipt.backend).toEqual({
				policy: 'auto',
				status: 'starting',
				appEnvNames: [],
				warnings: [],
				launch: 'deferred',
			});
			expect(kinds()).toEqual(['device.boot']);

			answer.resolve(ready());
			await eventually(() =>
				expect(lanes.getState().lanes[0]?.lastLaunchedAt).toBeDefined()
			);
			expect(metro.stopped).toEqual([
				{ pid: first.metroPid, port: first.port },
			]);
			expect(metro.started).toHaveLength(2);
			expect(metro.started[1]).toMatchObject({
				port: first.port,
				laneEnv: backendEnv(),
			});
			const lane = lanes.getState().lanes[0];
			expect(lane).toMatchObject({ id: first.id, port: first.port });
			expect(lane?.metroPid).not.toBe(first.metroPid);
			expect(lane?.backend).toEqual({ ...readySummary(), metro: 'restarted' });
			// The held-back launch is still the lane's first, so its app starts
			// fresh too.
			expect(kinds()).toEqual([
				'device.boot',
				'app.list',
				'app.terminate',
				'url.open',
			]);
		});

		it('launches an auto lane without its backend when the late attach fails, and says why', async () => {
			const late = deferred<LaneBackendLateAttach>();
			backends.answers.push(starting(late.promise));
			const receipt = await up();
			expect(receipt.completed).toBe(true);
			expect(receipt.backend).toMatchObject({
				status: 'starting',
				jobId: JOB_ID,
				launch: 'deferred',
			});
			expect(metro.started[0]).not.toHaveProperty('laneEnv');
			expect(kinds()).not.toContain('url.open');

			late.resolve({
				summary: {
					policy: 'auto',
					status: 'skipped',
					reason: 'capacity',
					reasonText: 'Twelve stacks already run on this Mac.',
					appEnvNames: [],
					warnings: [],
				},
			});
			await eventually(() =>
				expect(lanes.getState().lanes[0]?.lastLaunchedAt).toBeDefined()
			);
			expect(metro.started).toHaveLength(1);
			expect(metro.stopped).toEqual([]);
			expect(lanes.getState().lanes[0]?.backend).toEqual({
				policy: 'auto',
				status: 'skipped',
				reason: 'capacity',
				reasonText: 'Twelve stacks already run on this Mac.',
				appEnvNames: [],
				warnings: [],
			});
		});

		it('fails a required lane before Metro spawns when its backend cannot serve it, and lets the backend go', async () => {
			backends.answers.push({
				summary: {
					policy: 'required',
					status: 'blocked',
					reason: 'ports-pinned',
					reasonText: 'Port keys are pinned in supabase/config.toml.',
					appEnvNames: [],
					warnings: [],
				},
			});
			const receipt = await up({ backend: 'required' });
			expect(receipt.completed).toBe(false);
			expect(receipt.error).toBe(
				'This lane requires its local backend, which is blocked (ports-pinned). Port keys are pinned in supabase/config.toml.'
			);
			expect(receipt.backend).toMatchObject({
				policy: 'required',
				status: 'blocked',
				reason: 'ports-pinned',
			});
			expect(backends.ensured[0]?.policy).toBe('required');
			expect(metro.started).toEqual([]);
			expect(lanes.getState().lanes).toEqual([]);
			expect(backends.detached).toContain(backends.ensured[0]?.laneId);
		});

		it("stops a required lane's Metro when its late attach fails", async () => {
			const late = deferred<LaneBackendLateAttach>();
			backends.answers.push(starting(late.promise));
			const receipt = await up({ backend: 'required' });
			expect(receipt.completed).toBe(true);
			expect(receipt.backend).toMatchObject({
				policy: 'required',
				status: 'starting',
				launch: 'deferred',
			});

			late.resolve({
				summary: {
					policy: 'required',
					status: 'failed',
					reason: 'failed',
					reasonText: 'The database did not become healthy.',
					appEnvNames: [],
					warnings: [],
				},
			});
			await eventually(() =>
				expect(lanes.getState().lanes[0]?.metro).toBe('stopped')
			);
			expect(metro.stopped).toEqual([
				{ pid: receipt.lane?.metroPid, port: receipt.lane?.port },
			]);
			expect(kinds()).not.toContain('url.open');
			expect(lanes.getState().lanes[0]?.backend).toEqual({
				policy: 'required',
				status: 'failed',
				reason: 'failed',
				reasonText:
					'The lane requires its local backend, so its Metro was stopped. The database did not become healthy.',
				appEnvNames: [],
				warnings: [],
			});
		});

		it('makes no backend call when the policy is off, by default or by choice', async () => {
			backends.policy = 'off';
			const byDefault = await up();
			expect(byDefault.completed).toBe(true);
			expect(byDefault).not.toHaveProperty('backend');
			expect(byDefault.lane).not.toHaveProperty('backend');

			backends.policy = 'auto';
			const byChoice = await up({
				worktreePath: OTHER_WORKTREE,
				simulatorUdid: OTHER_UDID,
				backend: 'off',
			});
			expect(byChoice.completed).toBe(true);
			expect(backends.ensured).toEqual([]);
			expect(metro.started.map((input) => input.laneEnv)).toEqual([
				undefined,
				undefined,
			]);
			for (const lane of lanes.getState().lanes) {
				expect(lane).not.toHaveProperty('backend');
			}
		});

		it('re-ensures on every lane up and restarts a running Metro only when the backend URL changed', async () => {
			const first = await up();
			const same = await up();
			expect(same.lane?.id).toBe(first.lane?.id);
			expect(backends.ensured).toHaveLength(2);
			expect(metro.started).toHaveLength(1);
			expect(metro.stopped).toEqual([]);
			expect(same.backend).toEqual({ ...readySummary(), metro: 'unchanged' });

			// The stack's ports moved: Metro restarts on its own port with them.
			backends.answers.push(ready(MOVED_API_URL));
			const moved = await up();
			expect(moved.lane?.id).toBe(first.lane?.id);
			expect(metro.stopped).toEqual([
				{ pid: first.lane?.metroPid, port: first.lane?.port },
			]);
			expect(metro.started).toHaveLength(2);
			expect(metro.started[1]).toMatchObject({
				port: first.lane?.port,
				laneEnv: backendEnv(MOVED_API_URL),
			});
			expect(moved.lane?.metroPid).not.toBe(first.lane?.metroPid);
			expect(moved.backend).toEqual({
				...readySummary(MOVED_API_URL),
				metro: 'restarted',
			});
		});

		it('asks for the backend of the branch the worktree is on now', async () => {
			const first = await up();
			worktrees.worktrees = worktrees.worktrees.map((worktree) =>
				worktree.path === WORKTREE
					? { ...worktree, branch: 'feature/a-next' }
					: worktree
			);
			const again = await up();
			expect(again.lane?.id).toBe(first.lane?.id);
			expect(backends.ensured.map((input) => input.branch)).toEqual([
				'feature/a',
				'feature/a-next',
			]);
		});

		it('respawns a dead Metro with whatever the backend serves now', async () => {
			const first = await up();
			metro.deadPids.add(first.lane?.metroPid as number);
			backends.answers.push(ready(MOVED_API_URL));
			const resumed = await up();
			expect(resumed.lane?.id).toBe(first.lane?.id);
			expect(metro.stopped).toEqual([]);
			expect(metro.started).toHaveLength(2);
			expect(metro.started[1]?.laneEnv).toEqual(backendEnv(MOVED_API_URL));
			expect(resumed.backend).toMatchObject({ apiUrl: MOVED_API_URL });
		});

		it('refuses to respawn a dead Metro before booting its Simulator or ensuring its backend when no Metro could start', async () => {
			const first = await up({ launch: false });
			metro.deadPids.add(first.lane?.metroPid as number);
			// The Simulator went down with it, so a respawn would boot it first.
			simulator.state = simulatorState([
				{ udid: UDID, state: 'shutdown' },
				{ udid: OTHER_UDID, state: 'booted' },
			]);
			metro.environmentIssue = MALFORMED_STRIP;
			const actions = simulator.actions.length;
			const ensures = backends.ensured.length;
			const resumed = await up({ launch: false });
			expect(resumed).toMatchObject({
				completed: false,
				error: MALFORMED_STRIP,
			});
			expect(kinds().slice(actions)).toEqual([]);
			expect(backends.ensured).toHaveLength(ensures);
			expect(metro.started).toHaveLength(1);
			expect(lanes.getState().lanes).toMatchObject([{ id: first.lane?.id }]);
		});

		it('lets the backend go on lane stop without waiting, and a failing port never keeps the lane', async () => {
			const started = await up();
			backends.detachError = new Error('The backend service is gone.');
			const stopped = await lanes.runOperation({
				actionId: 'op-stop',
				kind: 'lane.stop',
				laneId: started.lane?.id as string,
			});
			expect(stopped.completed).toBe(true);
			expect(backends.detached).toEqual([started.lane?.id]);
			expect(lanes.getState().lanes).toEqual([]);
		});

		it('drops a late attach for a lane that stopped meanwhile', async () => {
			const late = deferred<LaneBackendLateAttach>();
			backends.answers.push(starting(late.promise));
			const started = await up();
			await lanes.runOperation({
				actionId: 'op-stop',
				kind: 'lane.stop',
				laneId: started.lane?.id as string,
			});
			late.resolve(ready());
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(metro.started).toHaveLength(1);
			expect(kinds()).not.toContain('url.open');
		});

		it('stores only backend policy and an environment hash, and never puts a key in state or receipts', async () => {
			const late = deferred<LaneBackendLateAttach>();
			backends.answers.push(starting(late.promise));
			const started = await up();
			late.resolve(ready());
			await eventually(() =>
				expect(lanes.getState().lanes[0]?.lastLaunchedAt).toBeDefined()
			);
			const resumed = await up();
			const stored = await readFile(path.join(root, 'lanes.json'), 'utf8');
			for (const text of [
				STACK_ID,
				JOB_ID,
				'21734',
				URL_NAME,
				PUBLISHABLE_KEY,
			]) {
				expect(stored).not.toContain(text);
			}
			const savedLane = JSON.parse(stored).lanes[0];
			expect(savedLane.backendPolicy).toBe('auto');
			expect(savedLane.backendEnvHash).toMatch(/^[a-f0-9]{64}$/);
			expect(savedLane).not.toHaveProperty('backend');
			for (const text of [
				JSON.stringify(lanes.getState()),
				JSON.stringify(started),
				JSON.stringify(resumed),
			]) {
				expect(text).not.toContain(PUBLISHABLE_KEY);
			}
			// The public API URL is what the wire reports.
			expect(JSON.stringify(lanes.getState())).toContain(API_URL);
		});

		it("keeps a parked start's backend policy and starts with it once the user provides a Simulator", async () => {
			await up({ backend: 'off' });
			const other = await up({
				worktreePath: OTHER_WORKTREE,
				simulatorUdid: OTHER_UDID,
				backend: 'off',
			});
			const parked = await lanes.runOperation({
				actionId: 'op-park',
				kind: 'lane.start',
				worktreePath: THIRD_WORKTREE,
				environment: 'development',
				launch: false,
				backend: 'required',
			});
			expect(parked.deviceRequest).toMatchObject({
				status: 'pending',
				backend: 'required',
			});
			expect(lanes.getState().deviceRequests[0]?.backend).toBe('required');
			await lanes.runOperation({
				actionId: 'op-stop',
				kind: 'lane.stop',
				laneId: other.lane?.id as string,
			});

			const provided = await lanes.runOperation({
				actionId: 'op-use',
				kind: 'lane.provide-device',
				requestId: parked.deviceRequest?.id as string,
				decision: 'use',
				simulatorUdid: OTHER_UDID,
			});
			expect(provided.completed).toBe(true);
			expect(backends.ensured).toHaveLength(1);
			expect(backends.ensured[0]).toMatchObject({
				worktreePath: THIRD_WORKTREE,
				policy: 'required',
			});
			expect(provided.backend).toMatchObject({
				policy: 'required',
				status: 'ready',
			});
		});

		it("restarts a lane's own Metro on its port with the backend's current values, and reopens the app", async () => {
			const started = await up();
			const opens = () => kinds().filter((kind) => kind === 'url.open').length;
			expect(opens()).toBe(1);
			backends.answers.push(ready(MOVED_API_URL));
			await lanes.restartMetro(started.lane?.id as string, 'ports-moved');
			expect(backends.ensured.at(-1)).toEqual({
				laneId: started.lane?.id,
				worktreePath: WORKTREE,
				branch: 'feature/a',
				environmentId: 'development',
				policy: 'auto',
				agent: { kind: 'claude', sessionId: 'session-1' },
				waitMs: 0,
			});
			expect(metro.stopped).toEqual([
				{ pid: started.lane?.metroPid, port: started.lane?.port },
			]);
			expect(metro.started[1]).toMatchObject({
				port: started.lane?.port,
				laneEnv: backendEnv(MOVED_API_URL),
			});
			expect(opens()).toBe(2);
			expect(lanes.getState().lanes[0]?.backend).toEqual({
				...readySummary(MOVED_API_URL),
				metro: 'restarted',
			});
		});

		it('restarts Metro without the backend once the backend detaches, asking it nothing', async () => {
			const started = await up();
			await lanes.restartMetro(started.lane?.id as string, 'detach');
			expect(backends.ensured).toHaveLength(1);
			expect(metro.stopped).toEqual([
				{ pid: started.lane?.metroPid, port: started.lane?.port },
			]);
			expect(metro.started).toHaveLength(2);
			expect(metro.started[1]).not.toHaveProperty('laneEnv');
			expect(kinds().filter((kind) => kind === 'url.open')).toHaveLength(1);
			expect(lanes.getState().lanes[0]?.backend).toEqual({
				policy: 'auto',
				status: 'stopped',
				stackId: STACK_ID,
				appEnvNames: [],
				warnings: [],
				metro: 'restarted',
			});
		});

		it.each(['changed', 'unknown'] as const)(
			'clears a restored Metro backend on detach when its values are %s',
			async (state) => {
				const started = await up({ launch: false });
				if (state === 'unknown') {
					await lanes.stop();
					const file = path.join(root, 'lanes.json');
					const saved = JSON.parse(await readFile(file, 'utf8'));
					delete saved.lanes[0].backendEnvHash;
					await writeFile(file, JSON.stringify(saved));
				}
				backends.answers.push(ready(MOVED_API_URL));
				await restart();
				await eventually(() =>
					expect(lanes.getState().lanes[0]?.backend?.metro).toBe(
						'needs-restart'
					)
				);
				await lanes.restartMetro(started.lane?.id as string, 'detach');
				expect(metro.started).toHaveLength(2);
				expect(metro.started[1]).not.toHaveProperty('laneEnv');
				expect(backends.ensured).toHaveLength(2);
				expect(lanes.getState().lanes[0]?.backend?.metro).toBe('restarted');
				await lanes.restartMetro(started.lane?.id as string, 'detach');
				expect(metro.started).toHaveLength(2);
			}
		);

		it('does not restart a restored backend-off Metro when a backend detaches', async () => {
			const started = await up({ backend: 'off', launch: false });
			await restart();
			await lanes.restartMetro(started.lane?.id as string, 'detach');
			expect(metro.started).toHaveLength(1);
			expect(backends.ensured).toEqual([]);
		});

		it('does not restart a Metro known to have no backend values on detach or backend off', async () => {
			const late = deferred<LaneBackendLateAttach>();
			backends.answers.push(starting(late.promise));
			const started = await up({ launch: false });
			expect(metro.started[0]).not.toHaveProperty('laneEnv');
			await lanes.restartMetro(started.lane?.id as string, 'detach');
			await up({ backend: 'off', launch: false });
			expect(metro.started).toHaveLength(1);
			expect(lanes.getState().lanes[0]?.backendPolicy).toBe('off');
			late.resolve(ready());
		});

		it('refuses to restart a Metro whose PID cannot be proven, or one that is not running', async () => {
			const started = await up();
			const laneId = started.lane?.id as string;
			const stop = metro.stop;
			metro.stop = async (pid, port) => {
				throw new Error(
					`Process ${pid} is no longer the Metro serving port ${port}; refusing to stop it.`
				);
			};
			await expect(lanes.restartMetro(laneId, 'operator')).rejects.toThrow(
				/refusing to stop it/
			);
			expect(metro.started).toHaveLength(1);
			expect(lanes.getState().lanes[0]?.metroPid).toBe(started.lane?.metroPid);
			expect(lanes.getState().lanes[0]?.backend).toMatchObject({
				metro: 'needs-restart',
				reasonText: expect.stringMatching(/could not be restarted/),
			});

			metro.stop = stop;
			metro.deadPids.add(started.lane?.metroPid as number);
			await expect(lanes.restartMetro(laneId, 'operator')).rejects.toThrow(
				/isn't running/
			);
			expect(metro.started).toHaveLength(1);
		});

		it('opens a held-back dev client once through launchDeferred', async () => {
			backends.answers.push(
				starting(new Promise<LaneBackendLateAttach>(() => undefined))
			);
			const started = await up();
			expect(started.backend).toMatchObject({ launch: 'deferred' });
			const laneId = started.lane?.id as string;
			await lanes.launchDeferred(laneId);
			await lanes.launchDeferred(laneId);
			expect(kinds().filter((kind) => kind === 'url.open')).toHaveLength(1);
			expect(lanes.getState().lanes[0]?.backend).not.toHaveProperty('launch');
		});

		it.each([true, false])(
			'restarts the app on the launch a resumed lane up held back for its backend only when asked (restart %s)',
			async (restart) => {
				const started = await up({ backend: 'off' });
				expect(started.completed).toBe(true);
				expect(kinds()).toEqual([
					'device.boot',
					'app.list',
					'app.terminate',
					'url.open',
				]);
				const late = deferred<LaneBackendLateAttach>();
				backends.answers.push(starting(late.promise));
				const resumed = await up({ backend: 'auto', restart });
				expect(resumed.completed).toBe(true);
				expect(resumed.backend).toMatchObject({
					status: 'starting',
					launch: 'deferred',
				});
				// Nothing is terminated while the launch waits for the backend.
				expect(kinds()).toHaveLength(4);

				late.resolve({ summary: readySummary(), laneEnv: backendEnv() });
				await eventually(() =>
					expect(kinds().filter((kind) => kind === 'url.open')).toHaveLength(2)
				);
				expect(kinds().slice(4)).toEqual(
					restart
						? ['app.list', 'app.terminate', 'url.open']
						: ['app.list', 'url.open']
				);
			}
		);

		it('restarts the app for a held-back restart once a later lane up turns the backend off', async () => {
			expect((await up({ backend: 'off' })).completed).toBe(true);
			const late = deferred<LaneBackendLateAttach>();
			backends.answers.push(starting(late.promise));
			const resumed = await up({ backend: 'auto', restart: true });
			expect(resumed.backend).toMatchObject({ launch: 'deferred' });
			expect(kinds()).toHaveLength(4);

			// Turning the backend off lets go of the record that held the launch
			// back; the launch goes ahead now, and its restart with it.
			const off = await up({ backend: 'off' });
			expect(off.completed).toBe(true);
			expect(off.lane).not.toHaveProperty('backend');
			expect(kinds().slice(4)).toEqual([
				'app.list',
				'app.terminate',
				'url.open',
			]);
		});

		it('drops a restart once a lane up hands it to a launch, even one that fails, so a later relaunch keeps the app', async () => {
			const started = await up({ backend: 'off' });
			const laneId = started.lane?.id as string;
			const late = deferred<LaneBackendLateAttach>();
			backends.answers.push(starting(late.promise));
			await up({ backend: 'auto', restart: true });
			expect(kinds()).toHaveLength(4);

			// The backend is ready for the next lane up, which launches at once
			// with the held-back restart; with no dev client installed it fails.
			simulator.installedApps = [];
			const failed = await up();
			expect(failed.completed).toBe(false);
			expect(failed.error).toMatch(/is not installed on this Simulator/);
			expect(failed.lane?.id).toBe(laneId);
			expect(failed.lane?.backend).not.toHaveProperty('launch');
			expect(kinds().slice(4)).toEqual(['app.list']);

			// A Metro restart for the backend relaunches the dev client in the
			// background, and the restart that launch was handed is not its.
			simulator.installedApps = undefined;
			backends.answers.push(ready(MOVED_API_URL));
			await lanes.restartMetro(laneId, 'ports-moved');
			await eventually(() =>
				expect(kinds().filter((kind) => kind === 'url.open')).toHaveLength(2)
			);
			expect(kinds().slice(5)).toEqual(['app.list', 'url.open']);
		});

		it.each([true, false])(
			"holds a new lane's asked-for restart back with its launch, so a terminate that fails then fails that launch (restart %s)",
			async (restart) => {
				const late = deferred<LaneBackendLateAttach>();
				backends.answers.push(starting(late.promise));
				const started = await up({ restart });
				expect(started.backend).toMatchObject({ launch: 'deferred' });
				simulator.failKinds['app.terminate'] = 'xcrun failed with exit code 1.';

				late.resolve({ summary: readySummary(), laneEnv: backendEnv() });
				if (restart) {
					await eventually(() =>
						expect(lanes.getState().lanes[0]?.backend?.reasonText).toMatch(
							/The dev client did not open: com\.example\.app could not be terminated before its dev client opened/
						)
					);
					expect(kinds()).toEqual(['device.boot', 'app.list', 'app.terminate']);
					expect(metro.notes).toEqual([]);
				} else {
					// The first launch's own terminate is best effort, and says so.
					await eventually(() => expect(kinds()).toContain('url.open'));
					expect(kinds()).toEqual([
						'device.boot',
						'app.list',
						'app.terminate',
						'url.open',
					]);
					expect(metro.notes.map(({ note }) => note)).toEqual([
						expect.stringMatching(
							/^com\.example\.app could not be terminated before the lane's first launch/
						),
					]);
				}
				expect(lanes.getState().lanes[0]?.backend).not.toHaveProperty('launch');
			}
		);

		it("leaves a name the lane's environment pins to the environment", async () => {
			const pinned = new LaneService({
				store: new LaneStore(root),
				simulator,
				metro,
				worktrees,
				now: () => now,
				backends,
				environments: [
					{
						id: 'development',
						portRange: [8_100, 8_199],
						metroEnv: { EXPO_PUBLIC_SUPABASE_URL: 'https://example.com' },
					},
				],
			});
			await pinned.start();
			const receipt = await pinned.runOperation({
				actionId: 'op-pinned',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: UDID,
				environment: 'development',
				launch: false,
			});
			expect(metro.started[0]?.metroEnv).toEqual({
				EXPO_PUBLIC_SUPABASE_URL: 'https://example.com',
			});
			expect(metro.started[0]?.laneEnv).toEqual({
				EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
			});
			expect(receipt.backend).toEqual({
				...readySummary(),
				appEnvNames: [KEY_NAME],
				warnings: ['shared-default-keys', 'pinned-by-environment'],
			});
			await pinned.stop();
		});

		it('never fails an auto lane over its backend: a throwing port, or variables Metro would refuse', async () => {
			backends.ensureForLane = async () => {
				throw new Error('The backend service crashed.');
			};
			const crashed = await up();
			expect(crashed.completed).toBe(true);
			expect(crashed.backend).toMatchObject({
				status: 'failed',
				reason: 'failed',
				reasonText:
					'The local backend could not be ensured: The backend service crashed.',
			});
			expect(metro.started[0]).not.toHaveProperty('laneEnv');
			expect(kinds()).toContain('url.open');

			backends.ensureForLane = async () => ({
				summary: readySummary(),
				laneEnv: { [URL_NAME]: API_URL, EXPO_PUBLIC_KEY: 'sb_secret_example' },
			});
			const refused = await up({
				worktreePath: OTHER_WORKTREE,
				simulatorUdid: OTHER_UDID,
			});
			expect(refused.completed).toBe(true);
			expect(refused.backend).toMatchObject({
				status: 'failed',
				stackId: STACK_ID,
				reasonText: expect.stringMatching(/^Metro would refuse/),
			});
			expect(metro.started[1]).not.toHaveProperty('laneEnv');
			expect(JSON.stringify(refused)).not.toContain('sb_secret_example');
		});

		it('without a backend port, records auto as skipped and refuses required before anything boots', async () => {
			const start = {
				kind: 'lane.start' as const,
				worktreePath: WORKTREE,
				simulatorUdid: UDID,
				environment: 'development',
				launch: false,
			};
			const required = await service.runOperation({
				...start,
				actionId: 'op-required',
				backend: 'required',
			});
			expect(required.completed).toBe(false);
			expect(required.error).toMatch(/cannot require one/);
			expect(simulator.actions).toEqual([]);

			const auto = await service.runOperation({
				...start,
				actionId: 'op-auto',
				backend: 'auto',
			});
			expect(auto.completed).toBe(true);
			expect(auto.backend).toMatchObject({
				policy: 'auto',
				status: 'skipped',
				reason: 'disabled',
			});
			expect(metro.started[0]).not.toHaveProperty('laneEnv');
		});
	});

	describe('lane log retention', () => {
		const DAY_MS = 24 * 60 * 60 * 1_000;

		async function agedLog(ageMs: number): Promise<string> {
			const file = store.logPathFor(store.newLaneId());
			await writeFile(file, 'Starting Metro Bundler\n');
			const seconds = (now - ageMs) / 1_000;
			await utimes(file, seconds, seconds);
			return file;
		}

		async function logs(): Promise<string[]> {
			return readdir(path.join(root, 'logs'));
		}

		it('deletes the logs of lanes gone past a week when it starts, then hourly', async () => {
			const gone = await agedLog(8 * DAY_MS);
			const recent = await agedLog(DAY_MS);
			const restarted = new LaneService({
				store: new LaneStore(root),
				simulator,
				metro,
				worktrees,
				now: () => now,
			});
			await restarted.start();
			expect(await logs()).not.toContain(path.basename(gone));
			expect(await logs()).toContain(path.basename(recent));

			// Reconcile runs every few seconds; pruning does not.
			const later = await agedLog(8 * DAY_MS);
			await restarted.runOperation({ actionId: 'op-r1', kind: 'lane.refresh' });
			expect(await logs()).toContain(path.basename(later));
			now += 60 * 60_000;
			await restarted.runOperation({ actionId: 'op-r2', kind: 'lane.refresh' });
			expect(await logs()).not.toContain(path.basename(later));
			await restarted.stop();
		});
	});

	describe('picking a Simulator', () => {
		function up(extra: Record<string, unknown> = {}) {
			return service.runOperation({
				actionId: `op-pick-${Math.random().toString(16).slice(2)}`,
				kind: 'lane.start',
				worktreePath: WORKTREE,
				environment: 'development',
				launch: false,
				...extra,
			});
		}

		it('prefers a free booted device when no Simulator is named', async () => {
			const receipt = await up();
			expect(receipt.completed).toBe(true);
			// OTHER_UDID is booted in the fixture, UDID is shut down.
			expect(receipt.lane?.simulatorUdid).toBe(OTHER_UDID);
			expect(receipt.deviceRequest).toBeUndefined();
		});

		it('skips devices other sessions hold and devices with lanes', async () => {
			const held = new LaneService({
				store: new LaneStore(root),
				simulator,
				metro,
				worktrees,
				now: () => now,
				holds: () =>
					new Map([
						[
							OTHER_UDID,
							{
								simulatorUdid: OTHER_UDID,
								via: 'claim' as const,
								holder: { kind: 'codex' as const, sessionId: 'elsewhere' },
								holderLive: true,
							},
						],
					]),
			});
			await held.start();
			const receipt = await held.runOperation({
				actionId: 'op-held',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				environment: 'development',
				launch: false,
			});
			expect(receipt.lane?.simulatorUdid).toBe(UDID);
			await held.stop();
		});

		it('returns to the existing lane for the app when no Simulator is named', async () => {
			const first = await up();
			const again = await up();
			expect(again.lane?.id).toBe(first.lane?.id);
			expect(service.getState().lanes).toHaveLength(1);
		});

		it('parks a device request when nothing is free, and the user settles it', async () => {
			// Take both devices with lanes for other apps.
			await up({ simulatorUdid: UDID });
			await service.runOperation({
				actionId: 'op-other-app',
				kind: 'lane.start',
				worktreePath: OTHER_WORKTREE,
				simulatorUdid: OTHER_UDID,
				environment: 'development',
				launch: false,
			});
			const receipt = await service.runOperation({
				actionId: 'op-third',
				kind: 'lane.start',
				worktreePath: THIRD_WORKTREE,
				environment: 'development',
				launch: false,
				slimProfileId: 'rndevtools-development',
				agent: { kind: 'claude', sessionId: 'session-9' },
			});
			expect(receipt.completed).toBe(true);
			expect(receipt.lane).toBeUndefined();
			const request = receipt.deviceRequest;
			expect(request).toMatchObject({
				status: 'pending',
				worktreePath: THIRD_WORKTREE,
				branch: 'feature-c',
				slimProfileId: 'rndevtools-development',
				agent: { kind: 'claude', sessionId: 'session-9' },
				launch: false,
			});
			expect(request?.message).toMatch(/2 by lanes, 0 claimed/);
			expect(service.getState().deviceRequests).toHaveLength(1);
			expect(metro.started).toHaveLength(2);

			// A retry for the same app replaces the request rather than stacking.
			const retry = await service.runOperation({
				actionId: 'op-third-again',
				kind: 'lane.start',
				worktreePath: THIRD_WORKTREE,
				environment: 'development',
				launch: false,
				slimProfileId: 'rndevtools-development',
				agent: { kind: 'claude', sessionId: 'session-9' },
			});
			expect(service.getState().deviceRequests).toHaveLength(1);
			expect(service.getState().deviceRequests[0]?.id).toBe(
				retry.deviceRequest?.id
			);
			const requestId = retry.deviceRequest?.id ?? '';

			// Cloning the chosen device starts the lane on the copy and keeps the
			// original request's slim profile and agent.
			const cloned = await service.runOperation({
				actionId: 'op-clone',
				kind: 'lane.provide-device',
				requestId,
				decision: 'clone',
				simulatorUdid: OTHER_UDID,
			});
			expect(cloned.completed).toBe(true);
			expect(simulator.actions.map((action) => action.kind)).toContain(
				'device.clone'
			);
			const cloneAction = simulator.actions.find(
				(action) => action.kind === 'device.clone'
			);
			expect(cloneAction).toMatchObject({
				udid: OTHER_UDID,
				name: 'Sim FFFF · feature-c',
			});
			expect(cloned.lane).toMatchObject({
				simulatorUdid: CLONE_UDID,
				worktreePath: THIRD_WORKTREE,
			});
			expect(service.getState().deviceRequests[0]).toMatchObject({
				id: requestId,
				status: 'fulfilled',
				laneId: cloned.lane?.id,
			});
			// The parked slim request rode along: the clone was slimmed on start.
			expect(slimming.actions).toHaveLength(1);
			expect(slimming.actions[0]?.action).toMatchObject({
				kind: 'profile.apply',
				simulatorUdids: [CLONE_UDID],
				requester: { kind: 'claude', sessionId: 'session-9' },
			});
		});

		it('dismisses a request and refuses to settle it twice', async () => {
			await up({ simulatorUdid: UDID });
			await service.runOperation({
				actionId: 'op-other-app',
				kind: 'lane.start',
				worktreePath: OTHER_WORKTREE,
				simulatorUdid: OTHER_UDID,
				environment: 'development',
				launch: false,
			});
			const parked = await service.runOperation({
				actionId: 'op-third',
				kind: 'lane.start',
				worktreePath: THIRD_WORKTREE,
				environment: 'development',
				launch: false,
			});
			const requestId = parked.deviceRequest?.id ?? '';
			const dismissed = await service.runOperation({
				actionId: 'op-dismiss',
				kind: 'lane.provide-device',
				requestId,
				decision: 'dismiss',
			});
			expect(dismissed.deviceRequest).toMatchObject({
				status: 'dismissed',
				message: 'Dismissed by the operator.',
			});
			const again = await service.runOperation({
				actionId: 'op-dismiss-again',
				kind: 'lane.provide-device',
				requestId,
				decision: 'use',
				simulatorUdid: UDID,
			});
			expect(again.completed).toBe(false);
			expect(again.error).toMatch(/is dismissed/);

			// Settled requests are pruned after their TTL so the agent has time
			// to read the outcome.
			await service.runOperation({ actionId: 'op-r1', kind: 'lane.refresh' });
			expect(service.getState().deviceRequests).toHaveLength(1);
			now += 31 * 60_000;
			await service.runOperation({ actionId: 'op-r2', kind: 'lane.refresh' });
			expect(service.getState().deviceRequests).toEqual([]);
		});

		it('lists at most 16 device requests: a new one takes the oldest settled place, and with none settled the start is refused', async () => {
			await up({ simulatorUdid: UDID });
			await service.runOperation({
				actionId: 'op-other-app',
				kind: 'lane.start',
				worktreePath: OTHER_WORKTREE,
				simulatorUdid: OTHER_UDID,
				environment: 'development',
				launch: false,
			});
			// Every app directory inside a worktree parks a request of its own.
			const park = (n: number) =>
				service.runOperation({
					actionId: `op-park-${n}`,
					kind: 'lane.start',
					worktreePath: `${THIRD_WORKTREE}/apps/app-${n}`,
					environment: 'development',
					launch: false,
				});
			const parked: LaneOperationReceipt[] = [];
			for (let n = 1; n <= 16; n += 1) parked.push(await park(n));
			expect(parked.map((receipt) => receipt.deviceRequest?.status)).toEqual(
				Array.from({ length: 16 }, () => 'pending')
			);

			const refused = await park(17);
			expect(refused.completed).toBe(false);
			expect(refused.error).toMatch(
				/16 lane starts are already waiting on the user for a Simulator/
			);
			// Lane state still reads, and so does everything built on it.
			expect(service.getState().deviceRequests).toHaveLength(16);
			const refreshed = await service.runOperation({
				actionId: 'op-r',
				kind: 'lane.refresh',
			});
			expect(refreshed.completed).toBe(true);

			const first = parked[0]?.deviceRequest?.id as string;
			const dismissed = await service.runOperation({
				actionId: 'op-dismiss',
				kind: 'lane.provide-device',
				requestId: first,
				decision: 'dismiss',
			});
			expect(dismissed.completed).toBe(true);
			const replaced = await park(17);
			expect(replaced.deviceRequest?.status).toBe('pending');
			const ids = service
				.getState()
				.deviceRequests.map((request) => request.id);
			expect(ids).toHaveLength(16);
			expect(ids).not.toContain(first);
			expect(ids).toContain(replaced.deviceRequest?.id);
		});

		it('keeps a request pending with the reason when the chosen start fails', async () => {
			await up({ simulatorUdid: UDID });
			await service.runOperation({
				actionId: 'op-other-app',
				kind: 'lane.start',
				worktreePath: OTHER_WORKTREE,
				simulatorUdid: OTHER_UDID,
				environment: 'development',
				launch: false,
			});
			const parked = await service.runOperation({
				actionId: 'op-third',
				kind: 'lane.start',
				worktreePath: THIRD_WORKTREE,
				environment: 'development',
				launch: false,
			});
			const requestId = parked.deviceRequest?.id ?? '';
			// Using a device that already has a lane is the conflict the panel
			// labels; the service refuses it and the card stays up.
			const failed = await service.runOperation({
				actionId: 'op-use-taken',
				kind: 'lane.provide-device',
				requestId,
				decision: 'use',
				simulatorUdid: UDID,
			});
			expect(failed.completed).toBe(false);
			expect(failed.error).toMatch(/already assigned to lane/);
			expect(service.getState().deviceRequests[0]).toMatchObject({
				id: requestId,
				status: 'pending',
			});
			expect(service.getState().deviceRequests[0]?.message).toMatch(
				/already assigned to lane/
			);
		});
	});

	describe('slimming on lane start', () => {
		it('honors --slim on an existing lane and rejects an unknown profile before actions', async () => {
			healthyMetro();
			const first = await startWithSlim();
			const second = await startWithSlim();
			expect(second.completed).toBe(true);
			expect(second.lane?.id).toBe(first.lane?.id);
			expect(second.lane?.slim).toMatchObject({
				status: 'applied',
				jobId: 'slimming-2',
			});
			expect(slimming.actions).toHaveLength(2);
			expect(metro.started).toHaveLength(1);
			const previousActions = simulator.actions.length;
			const bad = await service.runOperation({
				actionId: 'retry-bad-profile',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: UDID,
				environment: 'development',
				launch: true,
				slimProfileId: 'nope',
			});
			expect(bad.completed).toBe(false);
			expect(bad.error).toMatch(/Unknown SimSlim profile/);
			expect(simulator.actions).toHaveLength(previousActions);
			expect(slimming.actions).toHaveLength(2);
		});
		it('applies the profile during start, boot then slim then Metro, with the lane agent as requester', async () => {
			healthyMetro();
			const receipt = await startWithSlim({
				kind: 'codex',
				sessionId: 'thread-9',
			});
			expect(receipt.completed).toBe(true);
			expect(receipt.lane?.slim).toMatchObject({
				profileId: 'rndevtools-development',
				status: 'applied',
				jobId: 'slimming-1',
			});
			expect(receipt.lane?.metro).toBe('ready');
			expect(slimming.actions).toHaveLength(1);
			expect(slimming.actions[0]?.action).toMatchObject({
				kind: 'profile.apply',
				requester: { kind: 'codex', sessionId: 'thread-9' },
			});
			expect(simulator.actions.map((action) => action.kind)).toEqual([
				'device.boot',
				'app.list',
				'app.terminate',
				'url.open',
			]);
		});

		it('applies the profile under a per-device mutation lease; an operator start carries no requester', async () => {
			healthyMetro();
			const receipt = await startWithSlim();
			expect(receipt.completed).toBe(true);
			expect(receipt.lane?.slim).toMatchObject({
				profileId: 'rndevtools-development',
				status: 'applied',
				jobId: 'slimming-1',
			});
			expect(slimming.refreshes).toBe(1);
			expect(slimming.actions).toHaveLength(1);
			const first = slimming.actions[0];
			expect(first?.action).toMatchObject({
				kind: 'profile.apply',
				profileId: 'rndevtools-development',
				simulatorUdids: [UDID],
				confirmation: 'APPLY_EXPERIMENTAL_PROFILE',
			});
			expect(first?.action).not.toHaveProperty('requester');
			expect(first?.lease?.simulatorUdid).toBe(UDID);
			// Order: boot, slim, then Metro + launch.
			expect(simulator.actions.map((action) => action.kind)).toEqual([
				'device.boot',
				'app.list',
				'app.terminate',
				'url.open',
			]);
			expect(metro.started).toHaveLength(1);
		});

		it('records a rejection from the SimSlim gate as skipped and keeps the lane usable', async () => {
			healthyMetro();
			slimming.rejectWith = 'Experimental Simulator mutations are disabled.';
			const receipt = await startWithSlim();
			expect(receipt.completed).toBe(true);
			expect(receipt.lane?.slim).toMatchObject({
				status: 'skipped',
				message: 'Experimental Simulator mutations are disabled.',
			});
			expect(receipt.lane?.metro).toBe('ready');
		});

		it('records a failed SimSlim job as failed without aborting the lane', async () => {
			healthyMetro();
			slimming.failWith = 'native host mutation_authorization_required';
			const receipt = await startWithSlim();
			expect(receipt.completed).toBe(true);
			expect(receipt.lane?.slim).toMatchObject({
				status: 'failed',
				message: 'native host mutation_authorization_required',
				jobId: 'slimming-1',
			});
			expect(receipt.lane?.metro).toBe('ready');
		});

		it('fails fast on an unknown profile before booting or starting Metro', async () => {
			const receipt = await service.runOperation({
				actionId: 'op-bad-profile',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: UDID,
				environment: 'development',
				launch: true,
				slimProfileId: 'nope',
			});
			expect(receipt.completed).toBe(false);
			expect(receipt.error).toMatch(/Unknown SimSlim profile "nope"/);
			expect(receipt.error).toMatch(/rndevtools-development/);
			expect(simulator.actions).toHaveLength(0);
			expect(metro.started).toHaveLength(0);
		});

		it('refuses --slim when the helper is unavailable', async () => {
			slimming.helperStatus = 'unavailable';
			const receipt = await startWithSlim();
			expect(receipt.completed).toBe(false);
			expect(receipt.error).toMatch(/helper is unavailable/i);
		});

		it('reports plainly when the build has no slimming at all', async () => {
			const bare = new LaneService({
				store: new LaneStore(
					await mkdtemp(path.join(os.tmpdir(), 'lane-bare-'))
				),
				simulator,
				metro,
				worktrees,
				now: () => now,
			});
			const receipt = await bare.runOperation({
				actionId: 'op-bare',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: UDID,
				environment: 'development',
				launch: false,
				slimProfileId: 'rndevtools-development',
			});
			expect(receipt.completed).toBe(false);
			expect(receipt.error).toMatch(/not available in this build/);
			await bare.stop();
		});
	});

	describe('dev client presence', () => {
		it('refuses to launch when the worktree bundle is not installed and says what to build', async () => {
			healthyMetro();
			simulator.installedApps = ['com.apple.mobilesafari'];
			const receipt = await service.runOperation({
				actionId: 'op-no-client',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: UDID,
				environment: 'development',
				launch: true,
			});
			expect(receipt.completed).toBe(false);
			expect(receipt.error).toMatch(/com\.example\.app is not installed/);
			expect(receipt.error).toMatch(
				new RegExp(`expo run:ios --device ${UDID} --port 8100 --no-bundler`)
			);
			expect(receipt.error).toMatch(/Metro on port 8100 is still running/);
			expect(simulator.actions.map((action) => action.kind)).toEqual([
				'device.boot',
				'app.list',
			]);
			// The lease survives so the operator can build and relaunch, and the
			// receipt names the lane to relaunch.
			expect(service.getState().lanes).toHaveLength(1);
			expect(receipt.lane?.id).toBe(service.getState().lanes[0]?.id);
		});

		it('skips the check when the worktree declares no bundle identifier', async () => {
			healthyMetro();
			worktrees.identity = { scheme: 'exampleapp' };
			simulator.installedApps = [];
			const receipt = await service.runOperation({
				actionId: 'op-no-bundle-id',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: UDID,
				environment: 'development',
				launch: true,
			});
			expect(receipt.completed).toBe(true);
			expect(simulator.actions.map((action) => action.kind)).toEqual([
				'device.boot',
				'url.open',
			]);
		});
	});

	describe('fresh app starts', () => {
		const kinds = () => simulator.actions.map((action) => action.kind);
		/**
		 * What the Simulator was asked to do since `mark` actions. The log is
		 * never cleared: the fake numbers its jobs by its length.
		 */
		const kindsSince = (mark: number) => kinds().slice(mark);

		function start(extra: Record<string, unknown> = {}) {
			metro.healthyPorts.add(8_100);
			return service.runOperation({
				actionId: `op-start-${Math.random().toString(16).slice(2)}`,
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: UDID,
				environment: 'development',
				launch: true,
				...extra,
			});
		}

		function launch(laneId: string, extra: Record<string, unknown> = {}) {
			return service.runOperation({
				actionId: `op-launch-${Math.random().toString(16).slice(2)}`,
				kind: 'lane.launch',
				laneId,
				...extra,
			});
		}

		/** A lane that has launched its dev client once, and what that took. */
		async function launchedLane(): Promise<string> {
			const started = await start();
			expect(started.completed).toBe(true);
			expect(kinds()).toEqual([
				'device.boot',
				'app.list',
				'app.terminate',
				'url.open',
			]);
			return started.lane?.id as string;
		}

		it("terminates the lane's app before its first dev-client launch, as the Lanes panel starts one too", async () => {
			// No agent: the operator's start from the Lanes panel takes this path.
			const receipt = await start();
			expect(receipt.completed).toBe(true);
			const terminate = kinds().indexOf('app.terminate');
			expect(terminate).toBeGreaterThan(kinds().indexOf('app.list'));
			expect(terminate).toBeLessThan(kinds().indexOf('url.open'));
			expect(simulator.actions[terminate]).toMatchObject({
				kind: 'app.terminate',
				udid: UDID,
				bundleIdentifier: 'com.example.app',
			});
			expect(receipt.lane?.lastLaunchedAt).toBe(now);
			// A terminate that worked leaves the log to Metro.
			expect(metro.notes).toEqual([]);
		});

		it('keeps the app of a resumed lane unless the lane up asks to restart it', async () => {
			const laneId = await launchedLane();
			let mark = kinds().length;
			const resumed = await start();
			expect(resumed.lane?.id).toBe(laneId);
			expect(kindsSince(mark)).toEqual(['app.list', 'url.open']);

			mark = kinds().length;
			const restarted = await start({ restart: true });
			expect(restarted.completed).toBe(true);
			expect(restarted.lane?.id).toBe(laneId);
			expect(kindsSince(mark)).toEqual([
				'app.list',
				'app.terminate',
				'url.open',
			]);
		});

		it('restarts the app for a lane launch only when asked once the lane has launched', async () => {
			const laneId = await launchedLane();
			let mark = kinds().length;
			expect((await launch(laneId)).completed).toBe(true);
			expect(kindsSince(mark)).toEqual(['app.list', 'url.open']);

			mark = kinds().length;
			expect((await launch(laneId, { restart: true })).completed).toBe(true);
			expect(kindsSince(mark)).toEqual([
				'app.list',
				'app.terminate',
				'url.open',
			]);
		});

		it('gives a lane started without launching its fresh start on its first launch, whichever command opens it', async () => {
			const started = await start({ launch: false });
			expect(kinds()).toEqual(['device.boot']);
			const laneId = started.lane?.id as string;
			expect((await launch(laneId)).completed).toBe(true);
			expect(kinds()).toEqual([
				'device.boot',
				'app.list',
				'app.terminate',
				'url.open',
			]);
			const mark = kinds().length;
			expect((await launch(laneId)).completed).toBe(true);
			expect(kindsSince(mark)).toEqual(['app.list', 'url.open']);
		});

		it('never terminates for a deep link without restart, even as the first launch', async () => {
			const started = await start({ launch: false });
			const laneId = started.lane?.id as string;
			const linked = await launch(laneId, { url: 'checkout' });
			expect(linked.completed).toBe(true);
			expect(kinds()).toEqual(['device.boot', 'app.list', 'url.open']);

			// A deep link asked to restart terminates first.
			const mark = kinds().length;
			const restarted = await launch(laneId, {
				url: 'checkout',
				restart: true,
			});
			expect(restarted.completed).toBe(true);
			expect(kindsSince(mark)).toEqual([
				'app.list',
				'app.terminate',
				'url.open',
			]);
			expect(simulator.actions.at(-1)).toMatchObject({
				kind: 'url.open',
				url: 'exampleapp://checkout',
			});
		});

		it('launches when the app it terminates was not running, through the Simulator service', async () => {
			const commands: string[][] = [];
			const provider: SimulatorHostProvider = {
				discover: async () => simulatorState([]).capability,
				inventory: async () => ({
					runtimes: [
						{
							identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
							name: 'iOS 26.5',
							version: '26.5',
							isAvailable: true,
						},
					],
					deviceTypes: [],
					devices: [
						{
							udid: UDID,
							name: 'Example Phone',
							state: 'booted',
							runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
							isAvailable: true,
						},
					],
				}),
				listApps: async () => [
					{
						bundleIdentifier: 'com.example.app',
						displayName: 'ExampleApp',
						isSystem: false,
					},
				],
				runSimctl: async (args) => {
					commands.push([...args]);
					if (args[0] === 'terminate') {
						throw new SimulatorCommandError('xcrun failed with exit code 3.', {
							kind: 'failed',
							exitCode: 3,
							stderr:
								'The request to terminate "com.example.app" failed. found nothing to terminate\n',
						});
					}
					return { stdout: '', stderr: '', exitCode: 0 };
				},
				openSimulator: async () => undefined,
			};
			const simulators = new SimulatorService({
				captureDirectory: path.join(root, 'captures'),
				provider,
				metricsProvider: {
					sample: async () => ({ status: 'available', byDevice: {} }),
				},
				pollIntervalMs: 60_000,
			});
			await simulators.start();
			const lanes = new LaneService({
				store: new LaneStore(path.join(root, 'service-lanes')),
				simulator: simulators,
				metro,
				worktrees,
				now: () => now,
			});
			await lanes.start();
			try {
				metro.healthyPorts.add(8_100);
				const receipt = await lanes.runOperation({
					actionId: 'op-not-running',
					kind: 'lane.start',
					worktreePath: WORKTREE,
					simulatorUdid: UDID,
					environment: 'development',
					launch: true,
				});
				expect(receipt.completed).toBe(true);
				expect(commands.map((args) => args.slice(0, 3))).toEqual([
					['terminate', UDID, 'com.example.app'],
					['spawn', UDID, 'defaults'],
					['openurl', UDID, expect.stringMatching(/^exampleapp:\/\//)],
				]);
				expect(
					simulators.getState().jobs.find((job) => job.kind === 'app.terminate')
						?.status
				).toBe('complete');
				expect(metro.notes).toEqual([]);
			} finally {
				await lanes.stop();
				await simulators.stop();
			}
		});

		it.each(['failed', 'rejected'] as const)(
			'goes ahead with a first launch whose app it could not terminate unasked, and says so in the lane log (%s)',
			async (how) => {
				const started = await start({ launch: false });
				const laneId = started.lane?.id as string;
				if (how === 'failed') {
					simulator.failKinds['app.terminate'] =
						'xcrun failed with exit code 1.';
				} else {
					// As on an Xcode without app support, which refuses app.list too.
					const run = simulator.runAction;
					simulator.runAction = (action) => {
						if (action.kind !== 'app.terminate' && action.kind !== 'app.list') {
							return run(action);
						}
						simulator.actions.push(action);
						return {
							actionId: action.actionId,
							accepted: false,
							error: 'This Xcode installation does not support apps.',
						};
					};
				}
				const receipt = await launch(laneId);
				expect(receipt.completed).toBe(true);
				expect(kinds()).toEqual([
					'device.boot',
					'app.list',
					'app.terminate',
					'url.open',
				]);
				expect(receipt.lane?.lastLaunchedAt).toBe(now);
				expect(metro.notes).toEqual([
					{
						logPath: started.lane?.logPath,
						note: `com.example.app could not be terminated before the lane's first launch (${how === 'failed' ? 'xcrun failed with exit code 1.' : 'This Xcode installation does not support apps.'}). If a copy was already running, it stays registered as a debug target on the Metro it came from; run lane launch with restart to start it fresh.`,
					},
				]);
			}
		);

		it.each(['launch', 'deep link', 'up'] as const)(
			'fails a %s asked to restart whose app could not be terminated, and opens nothing',
			async (how) => {
				const laneId = await launchedLane();
				const mark = kinds().length;
				simulator.failKinds['app.terminate'] = 'xcrun failed with exit code 1.';
				const receipt =
					how === 'up'
						? await start({ restart: true })
						: await launch(laneId, {
								restart: true,
								...(how === 'deep link' ? { url: 'checkout' } : {}),
							});
				expect(receipt.completed).toBe(false);
				expect(receipt.error).toBe(
					`com.example.app could not be terminated before ${how === 'deep link' ? 'the URL' : 'its dev client'} opened, so the launch stopped there: xcrun failed with exit code 1. Metro on port 8100 is still running.`
				);
				expect(receipt.lane?.id).toBe(laneId);
				expect(kindsSince(mark)).toEqual(['app.list', 'app.terminate']);
				expect(service.getState().lanes[0]?.lastLaunchedAt).toBe(now);
			}
		);

		it('stops waiting for the terminate when the launch is cancelled, and cancels its job', async () => {
			const started = await start({ launch: false });
			const laneId = started.lane?.id as string;
			const run = simulator.runAction;
			let terminating: () => void = () => undefined;
			const held = new Promise<void>((resolve) => {
				terminating = resolve;
			});
			// The terminate job never ends on its own.
			simulator.runAction = (action) => {
				if (action.kind !== 'app.terminate') return run(action);
				simulator.actions.push(action);
				terminating();
				return {
					actionId: action.actionId,
					accepted: true,
					jobId: 'simulator-held-terminate',
				};
			};
			const cancelled: string[] = [];
			simulator.cancelJob = (jobId: string) => {
				cancelled.push(jobId);
				return true;
			};
			const controller = new AbortController();
			const launched = service.runOperation(
				{ actionId: 'op-cancel', kind: 'lane.launch', laneId },
				controller.signal
			);
			await held;
			controller.abort();
			const receipt = await launched;
			expect(receipt.completed).toBe(false);
			expect(receipt.error).toBe('Lane operation cancelled.');
			expect(receipt.cancelled).toBe(true);
			expect(receipt.lane?.id).toBe(laneId);
			expect(cancelled).toEqual(['simulator-held-terminate']);
			expect(kinds()).not.toContain('url.open');
			expect(metro.notes).toEqual([]);
		});

		it('terminates and opens nothing on the Simulator of a lane stopped while its dev client was checked', async () => {
			const started = await start({ launch: false });
			const laneId = started.lane?.id as string;
			const run = simulator.runAction;
			let release: () => void = () => undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let listing: () => void = () => undefined;
			const listed = new Promise<void>((resolve) => {
				listing = resolve;
			});
			// The app list waits for the test to let it finish.
			simulator.runAction = (action) => {
				if (action.kind !== 'app.list') return run(action);
				listing();
				void gate.then(() => run(action));
				return {
					actionId: action.actionId,
					accepted: true,
					jobId: `simulator-${simulator.actions.length + 1}`,
				};
			};
			const launching = launch(laneId, { restart: true });
			await listed;
			const stopped = await service.runOperation({
				actionId: 'op-stop',
				kind: 'lane.stop',
				laneId,
			});
			expect(stopped.completed).toBe(true);
			release();
			const launched = await launching;
			expect(launched.completed).toBe(false);
			expect(launched.error).toBe(`Lane ${laneId} does not exist.`);
			expect(launched).not.toHaveProperty('lane');
			// The device is free now: this launch no longer touches it.
			expect(kinds()).toEqual(['device.boot', 'app.list']);
		});

		it('refuses a restart it cannot name the app for, before booting a new lane or launching an old one', async () => {
			worktrees.identity = { scheme: 'exampleapp' };
			const refused = await start({ restart: true });
			expect(refused.completed).toBe(false);
			expect(refused.error).toBe(
				"A restart terminates the app by its bundle identifier, and the worktree's app.json declares no ios.bundleIdentifier. Declare it there, or run this without restart."
			);
			expect(simulator.actions).toEqual([]);
			expect(metro.started).toEqual([]);
			expect(service.getState().lanes).toEqual([]);

			// Without restart the lane starts, and its first launch has no app
			// to name, so nothing is terminated.
			const started = await start();
			expect(started.completed).toBe(true);
			expect(kinds()).toEqual(['device.boot', 'url.open']);
			const laneId = started.lane?.id as string;
			const mark = kinds().length;
			// The lane read its identity when it started, so declaring the bundle
			// identifier now does not give this lane one: the refusal says so.
			worktrees.identity = {
				scheme: 'exampleapp',
				bundleIdentifier: 'com.example.app',
			};
			for (const refusedAgain of [
				await launch(laneId, { restart: true }),
				await start({ restart: true }),
			]) {
				expect(refusedAgain.completed).toBe(false);
				expect(refusedAgain.error).toBe(
					`A restart terminates the app by its bundle identifier, and lane ${laneId} has none: the worktree's app.json declared no ios.bundleIdentifier when the lane started. Declare it, then run lane down and lane up for a new lane, whose first launch restarts the app; or run this without restart.`
				);
				// Not a failed launch: retrying it as one would fail again.
				expect(refusedAgain.lane).toBeUndefined();
			}
			expect(kindsSince(mark)).toEqual([]);
		});

		it("keeps a parked start's restart for the start the user settles", async () => {
			for (const port of [8_100, 8_101, 8_102]) metro.healthyPorts.add(port);
			// Both Simulators run other apps' lanes, so the third start parks.
			for (const [worktreePath, simulatorUdid] of [
				[WORKTREE, UDID],
				[OTHER_WORKTREE, OTHER_UDID],
			] as const) {
				const taken = await service.runOperation({
					actionId: `op-take-${simulatorUdid}`,
					kind: 'lane.start',
					worktreePath,
					simulatorUdid,
					environment: 'development',
					launch: false,
				});
				expect(taken.completed).toBe(true);
			}
			const parked = await service.runOperation({
				actionId: 'op-parked',
				kind: 'lane.start',
				worktreePath: THIRD_WORKTREE,
				environment: 'development',
				launch: true,
				restart: true,
			});
			expect(parked.deviceRequest).toMatchObject({
				status: 'pending',
				launch: true,
				restart: true,
			});
			// The restart was asked for, so a terminate that fails fails the
			// launch, where the first launch's own would have let it go ahead.
			simulator.failKinds['app.terminate'] = 'xcrun failed with exit code 1.';
			const settled = await service.runOperation({
				actionId: 'op-settle',
				kind: 'lane.provide-device',
				requestId: parked.deviceRequest?.id ?? '',
				decision: 'clone',
				simulatorUdid: OTHER_UDID,
			});
			expect(settled.completed).toBe(false);
			expect(settled.error).toMatch(
				/^com\.example\.app could not be terminated before its dev client opened/
			);
			// The settled start stored its lane before the launch failed, and its
			// receipt names it.
			expect(settled.lane).toMatchObject({
				worktreePath: THIRD_WORKTREE,
				simulatorUdid: CLONE_UDID,
			});
			expect(kinds().slice(-2)).toEqual(['app.list', 'app.terminate']);
		});
	});

	describe('holds while a lane starts', () => {
		const LANE_AGENT = { kind: 'claude' as const, sessionId: 'session-a' };
		const OTHER_AGENT = { kind: 'codex' as const, sessionId: 'thread-b' };
		let agents: AgentService | undefined;
		let guarded: LaneService | undefined;

		/** The desktop's wiring: the lane and agent services ask each other. */
		async function wire(): Promise<{
			agents: AgentService;
			lanes: LaneService;
		}> {
			const lanes = new LaneService({
				store: new LaneStore(path.join(root, 'held-lanes')),
				simulator,
				metro,
				worktrees,
				holds: () => holder.holds(),
				deviceAccess: (udid, requester) => holder.access(udid, requester),
				now: () => now,
			});
			const holder = new AgentService({
				directory: path.join(root, 'agents'),
				lanes: () => lanes.holdingLanes(),
				discover: async () => ({
					sessions: [
						{ ...LANE_AGENT, title: 'lane agent', cwd: WORKTREE },
						{ ...OTHER_AGENT, title: 'other agent', cwd: OTHER_WORKTREE },
					],
					claude: 'ok',
					codex: 'ok',
				}),
				pollIntervalMs: 60_000,
				now: () => now,
			});
			await lanes.start();
			await holder.start();
			agents = holder;
			guarded = lanes;
			return { agents: holder, lanes };
		}

		afterEach(async () => {
			await agents?.stop();
			await guarded?.stop();
			agents = undefined;
			guarded = undefined;
		});

		/** Starts a lane for LANE_AGENT on UDID and holds it inside the boot. */
		async function startHeldInBoot(lanes: LaneService) {
			const bootStarted = deferred<void>();
			const releaseBoot = deferred<void>();
			simulator.bootGate = releaseBoot.promise;
			simulator.onBootStarted = () => bootStarted.resolve(undefined);
			const starting = lanes.runOperation({
				actionId: 'op-held-start',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: UDID,
				environment: 'development',
				launch: false,
				agent: LANE_AGENT,
			});
			await bootStarted.promise;
			return { starting, releaseBoot: () => releaseBoot.resolve(undefined) };
		}

		it('refuses a claim on the Simulator a start is booting, and the lane keeps it', async () => {
			const wired = await wire();
			const { starting, releaseBoot } = await startHeldInBoot(wired.lanes);
			// What the router asks before it stores a claim.
			expect(wired.agents.access(UDID, OTHER_AGENT)).toMatchObject({
				allowed: false,
				reason: expect.stringContaining('held by claude session session-a'),
			});
			releaseBoot();
			const receipt = await starting;
			expect(receipt.completed).toBe(true);
			expect(wired.agents.holds().get(UDID)).toMatchObject({
				via: 'lane',
				laneId: receipt.lane?.id,
				holder: LANE_AGENT,
			});
		});

		it('fails a start, stopping its Metro, rather than override a claim that reached the device first', async () => {
			const wired = await wire();
			const { starting, releaseBoot } = await startHeldInBoot(wired.lanes);
			// However a claim gets in (here straight into the agent service, as
			// one can once an abandoned start's grace period runs out), it wins
			// over a start that has not stored its lane yet.
			await wired.agents.runOperation({
				kind: 'agent.claim',
				simulatorUdid: UDID,
				agent: OTHER_AGENT,
			});
			releaseBoot();
			const receipt = await starting;
			expect(receipt.completed).toBe(false);
			expect(receipt.error).toMatch(/held by codex session thread-b/);
			expect(wired.lanes.getState().lanes).toEqual([]);
			expect(metro.started).toHaveLength(1);
			expect(metro.stopped).toEqual([{ pid: 1_001, port: 8_100 }]);
			expect(wired.agents.holds().get(UDID)).toMatchObject({
				via: 'claim',
				holder: OTHER_AGENT,
			});
		});

		it('refuses a named Simulator that another session claimed after the router checked it', async () => {
			const wired = await wire();
			// The claim lands while the start lists worktrees, before it reserves.
			const list = worktrees.listWorktrees;
			worktrees.listWorktrees = async () => {
				await wired.agents.runOperation({
					kind: 'agent.claim',
					simulatorUdid: UDID,
					agent: OTHER_AGENT,
				});
				return list();
			};
			const receipt = await wired.lanes.runOperation({
				actionId: 'op-claimed-meanwhile',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: UDID,
				environment: 'development',
				launch: false,
				agent: LANE_AGENT,
			});
			expect(receipt.completed).toBe(false);
			expect(receipt.error).toMatch(/held by codex session thread-b/);
			expect(simulator.actions).toEqual([]);
			expect(metro.started).toEqual([]);
		});
	});

	describe('a start that fails after Metro spawned', () => {
		it('stops that Metro, so a retry does not leak another one', async () => {
			// Not a scheme app.json yields any more, but the lane record refuses it.
			worktrees.identity = {
				scheme: 'my_app',
				bundleIdentifier: 'com.example.app',
			};
			for (const attempt of [1, 2]) {
				const receipt = await service.runOperation({
					actionId: `op-refused-record-${attempt}`,
					kind: 'lane.start',
					worktreePath: WORKTREE,
					simulatorUdid: UDID,
					environment: 'development',
					launch: false,
				});
				expect(receipt.completed).toBe(false);
			}
			expect(service.getState().lanes).toEqual([]);
			expect(metro.started).toHaveLength(2);
			expect(metro.stopped).toEqual(
				metro.started.map((input, index) => ({
					pid: 1_001 + index,
					port: input.port,
				}))
			);
		});

		it('stops the Metro a resume spawned for a lane stopped meanwhile, and keeps the lane stopped', async () => {
			const first = await service.runOperation({
				actionId: 'op-first',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: UDID,
				environment: 'development',
				launch: false,
			});
			const lane = first.lane as Lane;
			metro.deadPids.add(lane.metroPid as number);
			await service.runOperation({ actionId: 'op-r', kind: 'lane.refresh' });

			const spawnEntered = deferred<void>();
			const releaseSpawn = deferred<void>();
			const launch = metro.start;
			metro.start = async (input) => {
				spawnEntered.resolve(undefined);
				await releaseSpawn.promise;
				return launch(input);
			};
			const resume = service.runOperation({
				actionId: 'op-resume',
				kind: 'lane.start',
				worktreePath: WORKTREE,
				simulatorUdid: UDID,
				environment: 'development',
				launch: false,
			});
			await spawnEntered.promise;
			await service.runOperation({
				actionId: 'op-stop',
				kind: 'lane.stop',
				laneId: lane.id,
			});
			releaseSpawn.resolve(undefined);
			const receipt = await resume;
			expect(receipt.completed).toBe(false);
			expect(service.getState().lanes).toEqual([]);
			expect(metro.started).toHaveLength(2);
			expect(metro.stopped).toContainEqual({ pid: 1_002, port: lane.port });
		});
	});
});

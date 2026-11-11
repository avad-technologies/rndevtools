import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCliCommand } from '../shared/agent-cli-protocol';
import type { AgentOperation, AgentState } from '../shared/agent-protocol';
import { createDemoDevice } from '../shared/demo-data';
import {
	type DeviceHold,
	decideDeviceAccess,
	resolveDeviceHolds,
} from '../shared/device-hold';
import {
	DEFAULT_LANE_ENVIRONMENTS,
	type Lane,
	type LaneOperation,
	type LaneOperationReceipt,
	type LaneState,
} from '../shared/lane-protocol';
import type {
	DesktopAction,
	DesktopState,
	DeviceSession,
} from '../shared/protocol';
import type {
	SimulatorAction,
	SimulatorState,
} from '../shared/simulator-protocol';
import { simulatorStateSchema } from '../shared/simulator-protocol';
import {
	SLIMMING_CONFIRMATIONS,
	type SlimmingAction,
	type SlimmingState,
	slimmingStateSchema,
} from '../shared/slimming-protocol';
import {
	createSupabaseDemoState,
	SUPABASE_DEMO_IDS,
} from '../shared/supabase-demo-data';
import {
	type SupabaseAgentOperation,
	type SupabaseAgentResult,
	type SupabaseAgentStack,
	type SupabaseDoctorInfo,
	type SupabaseState,
	supabaseAgentRecovery,
} from '../shared/supabase-protocol';
import { AgentCliError } from './agent-cli-service';
import {
	type AgentSupabasePort,
	createAgentCommandRouter,
} from './agent-command-router';
import { AgentService } from './agent-service';
import { NativeHostResponseError } from './native-host-client';
import type { SimulatorActionContext } from './simulator-service';
import type {
	SupabaseAgentContext,
	SupabaseReleaseResult,
} from './supabase/service-ports';

const UDID = '11111111-2222-3333-4444-555555555555';
const OTHER_UDID = 'BBBBBBBB-0000-4000-8000-000000000002';
const now = 1_800_000_000_000;

function desktopState(): DesktopState {
	const demo = createDemoDevice(now);
	return {
		protocolVersion: 2,
		broker: {
			status: 'listening',
			host: '127.0.0.1',
			port: 47_931,
			access: 'loopback',
			urls: ['ws://127.0.0.1:47931/device'],
		},
		devices: [
			{
				...demo,
				info: { ...demo.info, simulatorUdid: UDID },
			},
		],
		diagnostics: [],
	};
}

function simulatorState(): SimulatorState {
	return simulatorStateSchema.parse({
		revision: 1,
		updatedAt: now,
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
		devices: [
			{
				udid: UDID,
				name: 'Agent Lane',
				state: 'booted',
				runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
				isAvailable: true,
			},
		],
		appsByDevice: { [UDID]: [] },
		diskByDevice: {},
		jobs: [],
		captures: [],
		metrics: { status: 'available', byDevice: {} },
		native: {
			status: 'available',
			permissionInspection: true,
			permissionPrompting: false,
			permissions: [],
		},
	});
}

function slimmingState(): SlimmingState {
	return slimmingStateSchema.parse({
		revision: 1,
		updatedAt: now,
		setting: { experimentalMutationsEnabled: false },
		helper: { status: 'available', readOnlyAvailable: true },
		categories: [],
		profiles: [],
		simulators: [],
		statusBySimulator: {},
		previewBySimulator: {},
		doctorBySimulator: {},
		jobs: [],
		checkpointBySimulator: {},
		operationsBySimulator: {},
	});
}

function fixture() {
	let desktop = desktopState();
	let simulator = simulatorState();
	let slimming = slimmingState();
	const dispatched: DesktopAction[] = [];
	const simulatorActions: SimulatorAction[] = [];
	const cancelledSimulatorJobs: string[] = [];
	const slimmingActions: SlimmingAction[] = [];
	const dependencies = {
		broker: {
			getState: () => desktop,
			dispatchAction: async (action: DesktopAction) => {
				dispatched.push(action);
				return { actionId: action.actionId, ok: true };
			},
		},
		simulator: {
			getState: () => simulator,
			refresh: async () => simulator,
			runAction: (action: SimulatorAction) => {
				simulatorActions.push(action);
				return {
					actionId: action.actionId,
					accepted: false,
					error: 'not exercised',
				};
			},
			cancelJob: (jobId: string) => {
				cancelledSimulatorJobs.push(jobId);
				return false;
			},
			subscribe: () => () => undefined,
		},
		slimming: {
			getState: () => slimming,
			refresh: async () => slimming,
			runAction: (action: SlimmingAction) => {
				slimmingActions.push(action);
				return {
					actionId: action.actionId,
					accepted: false,
					error: 'not exercised',
				};
			},
			cancelJob: () => false,
			subscribe: () => () => undefined,
		},
	};
	const handler = createAgentCommandRouter(dependencies);
	return {
		dependencies,
		handler,
		cancelledSimulatorJobs,
		dispatched,
		simulatorActions,
		slimmingActions,
		setDesktop: (value: DesktopState) => {
			desktop = value;
		},
		setSimulator: (value: SimulatorState) => {
			simulator = value;
		},
		setSlimming: (value: SlimmingState) => {
			slimming = value;
		},
	};
}

const context = {
	requestId: 'cli-0123456789abcdef0123456789abcdef',
	signal: new AbortController().signal,
};

/** The demo session, advertising the connected-app waits or not. */
function desktopStateWithWaits(advertised = true): DesktopState {
	const state = desktopState();
	return {
		...state,
		devices: state.devices.map((device): DeviceSession => {
			const others = device.info.capabilities.filter(
				(capability) => !capability.startsWith('components.wait')
			);
			return {
				...device,
				info: {
					...device.info,
					capabilities: advertised
						? [
								...others,
								'components.waitForElement',
								'components.waitForScreenChange',
							]
						: others,
				},
			};
		}),
	};
}

type Holder = { kind: 'claude' | 'codex' | 'other'; sessionId: string };

/** Whom `owner`'s lane lets onto every device: itself and the operator. */
function heldBy(owner: Holder) {
	return (udid: string, requester?: { kind: string; sessionId: string }) =>
		!requester ||
		(requester.kind === owner.kind && requester.sessionId === owner.sessionId)
			? ({ allowed: true } as const)
			: ({
					allowed: false,
					reason: `Simulator ${udid} is held by ${owner.kind} session ${owner.sessionId} through lane lane-1.`,
					hold: {
						simulatorUdid: udid,
						via: 'lane' as const,
						laneId: 'lane-1',
						holder: owner,
						holderLive: true,
					},
				} as const);
}

/** An agents port that only answers who may touch a device. */
function holdsOnlyAgents(owner: Holder) {
	return {
		getState: (): AgentState => {
			throw new Error('unused');
		},
		refresh: async (): Promise<AgentState> => {
			throw new Error('unused');
		},
		runOperation: async (): Promise<AgentState> => {
			throw new Error('unused');
		},
		touch: () => undefined,
		access: heldBy(owner),
	};
}

/** A simulator port whose recordings run until they are cancelled. */
function recordingSimulator() {
	let state = simulatorState();
	const listeners = new Set<(value: SimulatorState) => void>();
	const cancelled: string[] = [];
	const publish = (jobs: SimulatorState['jobs']) => {
		state = simulatorStateSchema.parse({ ...state, jobs });
		for (const listener of listeners) listener(state);
	};
	const port = {
		getState: () => state,
		refresh: async () => state,
		runAction: (action: SimulatorAction) => {
			const jobId = `simulator-recording-${state.jobs.length + 1}`;
			publish([
				...state.jobs,
				{
					id: jobId,
					actionId: action.actionId,
					kind: action.kind,
					...(action.kind === 'capture.video'
						? { deviceUdid: action.udid }
						: {}),
					status: 'running',
					progressSequence: 1,
					phase: 'executing',
					createdAt: now,
					startedAt: now,
					message: 'Recording.',
				},
			]);
			return { actionId: action.actionId, accepted: true, jobId };
		},
		cancelJob: (jobId: string) => {
			if (
				!state.jobs.some((job) => job.id === jobId && job.status === 'running')
			) {
				return false;
			}
			cancelled.push(jobId);
			queueMicrotask(() =>
				publish(
					state.jobs.map((job) =>
						job.id === jobId
							? {
									...job,
									status: 'cancelled',
									progressSequence: 2,
									phase: 'cancelled',
									finishedAt: now + 1,
									message: 'Recording stopped.',
								}
							: job
					)
				)
			);
			return true;
		},
		subscribe: (listener: (value: SimulatorState) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return { port, cancelled };
}

describe('agent command router', () => {
	it('includes the shared agent check in doctor without failing device diagnostics on scan errors', async () => {
		const { dependencies } = fixture();
		const agentSetup = vi.fn(async () => ({
			version: 1 as const,
			rulesVersion: 'test',
			checkedAt: 1,
			fingerprint: 'c'.repeat(64),
			project: '',
			clients: [],
			findings: [],
			repairs: [],
			coverage: [],
			limitations: [],
		}));
		const handler = createAgentCommandRouter({ ...dependencies, agentSetup });
		await expect(handler({ kind: 'doctor' }, context)).resolves.toMatchObject({
			agentSetup: { version: 1 },
		});
		agentSetup.mockRejectedValueOnce(new Error('private failure detail'));
		const result = await handler({ kind: 'doctor' }, context);
		expect(result).toMatchObject({
			agentSetup: {
				status: 'not-checked',
				// The path the desktop shows: Lanes, then Agents.
				message: expect.stringContaining('Lanes → Agents → Agent setup checks'),
			},
			broker: { status: 'listening' },
		});
		expect(JSON.stringify(result)).not.toContain('private failure detail');
	});
	it('projects local doctor and simulator state without host paths', async () => {
		const { handler } = fixture();
		const doctor = await handler({ kind: 'doctor' }, context);
		expect(doctor).toMatchObject({
			connectedDevices: 1,
			connectedSessions: [
				{
					deviceId: 'rndevtools-demo-ios',
					status: 'simulated',
					simulatorUdid: UDID,
				},
			],
			simulator: { status: 'available', platform: 'darwin' },
			slimming: { status: 'available', readOnlyAvailable: true },
		});
		expect(JSON.stringify(doctor)).not.toContain('/Users/');

		const fleet = await handler(
			{ kind: 'simulators', includeUnavailable: false },
			context
		);
		expect(fleet).toMatchObject({
			devices: [{ udid: UDID, name: 'Agent Lane' }],
		});
	});

	describe('owned Simulator lifecycle', () => {
		const owner: Holder = { kind: 'codex', sessionId: 'simulator-owner' };
		const asOwner = { ...context, agent: owner };
		const boot = { kind: 'simulator', operation: 'boot', udid: UDID } as const;
		const jobId = 'simulator-recovery-job';

		function ownedHold(via: DeviceHold['via'] = 'claim'): DeviceHold {
			return {
				simulatorUdid: UDID,
				via,
				holder: owner,
				holderLive: true,
				...(via === 'lane' ? { laneId: 'lane-1' } : {}),
			};
		}

		function lifecycle(
			hold?: DeviceHold,
			status: 'running' | 'complete' | 'failed' = 'complete'
		) {
			const { dependencies, setSimulator } = fixture();
			const state: AgentState = {
				revision: 1,
				updatedAt: now,
				sessions: [],
				byDevice: {},
				claims: [],
				holds: hold ? { [UDID]: hold } : {},
				discovery: { claude: 'ok', codex: 'ok' },
			};
			const runAction = vi.fn(
				(action: SimulatorAction, _actionContext?: SimulatorActionContext) => {
					setSimulator(
						simulatorStateSchema.parse({
							...simulatorState(),
							jobs: [
								{
									id: jobId,
									actionId: action.actionId,
									kind: action.kind,
									deviceUdid: UDID,
									status,
									progressSequence: 1,
									phase: status === 'running' ? 'executing' : status,
									createdAt: now,
									startedAt: now,
									...(status !== 'running' ? { finishedAt: now + 1 } : {}),
									message:
										status === 'failed' ? 'xcrun timed out.' : 'Simulator job.',
								},
							],
						})
					);
					return { actionId: action.actionId, accepted: true, jobId };
				}
			);
			const cancelJob = vi.fn(() => true);
			const touch = vi.fn();
			const handler = createAgentCommandRouter({
				...dependencies,
				simulator: { ...dependencies.simulator, runAction, cancelJob },
				agents: {
					getState: () => state,
					refresh: async () => state,
					runOperation: async () => state,
					touch,
				},
			});
			return { handler, runAction, cancelJob, touch, state };
		}

		it('lists with the legacy no-operation command without identity or a mutation', async () => {
			const { handler, runAction, touch } = lifecycle();
			await expect(
				handler({ kind: 'simulators', includeUnavailable: false }, context)
			).resolves.toMatchObject({ devices: [{ udid: UDID }] });
			expect(runAction).not.toHaveBeenCalled();
			expect(touch).not.toHaveBeenCalled();
		});

		it.each([
			['boot', 'claim'],
			['shutdown', 'lane'],
		] as const)(
			'uses the typed %s action on the device held by this session’s %s',
			async (operation, via) => {
				const { handler, runAction, touch, state } = lifecycle(ownedHold(via));
				await expect(
					handler({ ...boot, operation }, asOwner)
				).resolves.toMatchObject({
					operation,
					udid: UDID,
					completed: true,
					jobId,
				});
				expect(runAction).toHaveBeenCalledOnce();
				expect(runAction).toHaveBeenCalledWith(
					expect.objectContaining({ kind: `device.${operation}`, udid: UDID }),
					expect.objectContaining({
						assertLifecycleOwnership: expect.any(Function),
					})
				);
				expect(touch).toHaveBeenCalledWith(owner, UDID);
				const guard = runAction.mock.calls[0]?.[1]?.assertLifecycleOwnership;
				expect(guard).toBeDefined();
				expect(guard).not.toThrow();
				state.holds = {};
				expect(guard).toThrow(/Claim this Simulator/);
			}
		);

		it('denies a free device, a foreign or operator hold, and shared or missing identities', async () => {
			const free = lifecycle();
			await expect(free.handler(boot, asOwner)).rejects.toMatchObject({
				code: 'device_claim_required',
				recovery: expect.stringContaining('claim --udid'),
			});
			expect(free.runAction).not.toHaveBeenCalled();

			for (const hold of [
				{
					...ownedHold(),
					holder: { kind: 'codex' as const, sessionId: 'other-session' },
					holderLive: false,
					releaseAt: 1,
				},
				{ ...ownedHold('lane'), holder: undefined },
			]) {
				const denied = lifecycle(hold);
				await expect(denied.handler(boot, asOwner)).rejects.toMatchObject({
					code: 'device_held',
					recovery: expect.stringContaining('agents'),
				});
				expect(denied.runAction).not.toHaveBeenCalled();
			}

			const shared = {
				kind: 'codex' as const,
				sessionId: 'mcp-codex-mcp-client',
			};
			const denied = lifecycle({ ...ownedHold('lane'), holder: shared });
			for (const requester of [context, { ...context, agent: shared }]) {
				await expect(denied.handler(boot, requester)).rejects.toMatchObject({
					code: 'agent_required',
					recovery: expect.stringContaining('native agent session'),
				});
			}
			expect(denied.runAction).not.toHaveBeenCalled();
		});

		it('returns a pending job after the observation window and leaves it running', async () => {
			vi.useFakeTimers();
			try {
				const { handler, cancelJob } = lifecycle(ownedHold(), 'running');
				const pending = handler(boot, asOwner);
				await vi.advanceTimersByTimeAsync(20_000);
				await expect(pending).resolves.toMatchObject({
					completed: false,
					jobId,
					next: expect.stringContaining(jobId),
				});
				expect(cancelJob).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});

		it('cancels a submitted lifecycle job when the caller aborts', async () => {
			const { handler, runAction, cancelJob } = lifecycle(
				ownedHold(),
				'running'
			);
			const controller = new AbortController();
			const pending = handler(boot, { ...asOwner, signal: controller.signal });
			await vi.waitFor(() => expect(runAction).toHaveBeenCalledOnce());
			controller.abort();
			await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
			expect(cancelJob).toHaveBeenCalledExactlyOnceWith(jobId);
		});

		it('reports the job and recovery when the native action times out', async () => {
			const { handler } = lifecycle(ownedHold(), 'failed');
			await expect(handler(boot, asOwner)).rejects.toMatchObject({
				code: 'action_failed',
				message: 'xcrun timed out.',
				retryable: true,
				recovery: expect.stringContaining(jobId),
			});
		});
	});

	it('makes protocol-v1-style sessions discoverable by exact deviceId', async () => {
		const { handler, setDesktop } = fixture();
		const state = desktopState();
		const session = state.devices[0] as NonNullable<
			(typeof state.devices)[number]
		>;
		setDesktop({
			...state,
			devices: [
				{
					...session,
					info: { ...session.info, simulatorUdid: undefined },
				},
			],
		});

		const doctor = await handler({ kind: 'doctor' }, context);
		expect(doctor).toMatchObject({
			connectedSessions: [
				{
					deviceId: 'rndevtools-demo-ios',
					status: 'simulated',
				},
			],
		});
		expect(JSON.stringify(doctor)).not.toContain('simulatorUdid');

		await expect(
			handler(
				{ kind: 'screen', target: { deviceId: 'rndevtools-demo-ios' } },
				context
			)
		).resolves.toMatchObject({ device: { id: 'rndevtools-demo-ios' } });
	});

	it('resolves the exact Simulator session for semantic inspection', async () => {
		const { handler } = fixture();
		const screen = await handler(
			{ kind: 'screen', target: { udid: UDID } },
			context
		);
		expect(screen).toMatchObject({
			device: { simulatorUdid: UDID },
			status: 'simulated',
		});
		const elements = await handler(
			{ kind: 'elements', target: { udid: UDID }, query: 'button', limit: 10 },
			context
		);
		expect(elements).toHaveProperty('screenHash');
	});

	it('dispatches only already-validated semantic actions to the matching device', async () => {
		const { handler, dispatched } = fixture();
		await handler(
			{
				kind: 'act',
				target: { udid: UDID },
				action: {
					tool: 'components',
					command: 'waitForElement',
					payload: { id: 'sign-in', timeoutMs: 1_000 },
				},
			},
			context
		);
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]).toMatchObject({
			deviceId: 'rndevtools-demo-ios',
			tool: 'components',
			command: 'waitForElement',
		});
	});

	it('honors long CLI waits through bounded connected-app slices', async () => {
		const { dependencies, setDesktop } = fixture();
		setDesktop(desktopStateWithWaits());
		const timeouts: number[] = [];
		let failures = 2;
		dependencies.broker.dispatchAction = async (action: DesktopAction) => {
			if (action.tool === 'components' && 'timeoutMs' in action.payload) {
				timeouts.push(Number(action.payload.timeoutMs));
			}
			if (failures > 0) {
				failures -= 1;
				return {
					actionId: action.actionId,
					ok: false,
					error: 'Wait slice elapsed.',
				};
			}
			return { actionId: action.actionId, ok: true };
		};
		const handler = createAgentCommandRouter(dependencies);
		await expect(
			handler(
				{
					kind: 'wait',
					target: { udid: UDID },
					condition: { kind: 'element', elementId: 'button' },
					timeoutMs: 60_000,
				},
				context
			)
		).resolves.toMatchObject({ ok: true });
		expect(timeouts).toEqual([5_000, 5_000, 5_000]);
	});

	it('spaces connected wait attempts with a timer, so failures answered at once never starve the event loop', async () => {
		const { dependencies, setDesktop } = fixture();
		setDesktop(desktopStateWithWaits());
		let attempts = 0;
		// The broker answers this without I/O, as it does while the app reloads.
		dependencies.broker.dispatchAction = async (action: DesktopAction) => {
			attempts += 1;
			return {
				actionId: action.actionId,
				ok: false,
				error: 'Device is offline.',
			};
		};
		const handler = createAgentCommandRouter(dependencies);
		const request = new AbortController();
		let timerFired = false;
		setTimeout(() => {
			timerFired = true;
		}, 50);
		setTimeout(() => request.abort(), 120);
		await expect(
			handler(
				{
					kind: 'wait',
					target: { udid: UDID },
					condition: { kind: 'element', elementId: 'button' },
					timeoutMs: 1_000,
				},
				{ ...context, signal: request.signal }
			)
		).rejects.toMatchObject({ code: 'cancelled' });
		expect(timerFired).toBe(true);
		expect(attempts).toBe(1);
	});

	it('ends a connected wait at once when the app does not advertise it or its session is gone', async () => {
		const { dependencies, dispatched, setDesktop } = fixture();
		const wait = {
			kind: 'wait' as const,
			target: { udid: UDID },
			condition: { kind: 'screen-change' as const, screenHash: 'screen-1' },
			timeoutMs: 30_000,
		};
		setDesktop(desktopStateWithWaits(false));
		await expect(
			createAgentCommandRouter(dependencies)(wait, context)
		).rejects.toMatchObject({
			code: 'capability_missing',
			retryable: false,
			message: expect.stringContaining('components.waitForScreenChange'),
		});
		expect(dispatched).toEqual([]);

		const state = desktopStateWithWaits();
		setDesktop(state);
		let attempts = 0;
		dependencies.broker.dispatchAction = async (action: DesktopAction) => {
			attempts += 1;
			setDesktop({ ...state, devices: [] });
			return { actionId: action.actionId, ok: false, error: 'Wait elapsed.' };
		};
		await expect(
			createAgentCommandRouter(dependencies)(wait, context)
		).rejects.toMatchObject({ code: 'target_not_found' });
		expect(attempts).toBe(1);
	});

	it('ends a wait with too little time left for a slice on its last failure, not a contract error', async () => {
		const { dependencies, setDesktop } = fixture();
		setDesktop(desktopStateWithWaits());
		const timeouts: number[] = [];
		dependencies.broker.dispatchAction = async (action: DesktopAction) => {
			timeouts.push(Number(action.payload.timeoutMs));
			return {
				actionId: action.actionId,
				ok: false,
				error: 'Another action is already pending for this device.',
			};
		};
		await expect(
			createAgentCommandRouter(dependencies)(
				{
					kind: 'wait',
					target: { udid: UDID },
					condition: { kind: 'element', elementId: 'button' },
					timeoutMs: 100,
				},
				context
			)
		).rejects.toMatchObject({
			code: 'action_failed',
			message: 'Another action is already pending for this device.',
		});
		expect(timeouts.length).toBeGreaterThan(0);
		expect(timeouts.every((timeoutMs) => timeoutMs >= 50)).toBe(true);
	});

	it('sets and clears only the app-scoped network profile through safe actions', async () => {
		const { handler, dispatched } = fixture();
		await handler(
			{
				kind: 'network',
				target: { udid: UDID },
				operation: 'set',
				profileId: 'lte',
			},
			context
		);
		await handler(
			{ kind: 'network', target: { udid: UDID }, operation: 'clear' },
			context
		);
		expect(dispatched).toHaveLength(2);
		expect(dispatched[0]).toMatchObject({
			tool: 'network',
			command: 'setProfile',
			payload: { profileId: 'lte' },
		});
		expect(dispatched[1]).toMatchObject({
			tool: 'network',
			command: 'clearProfile',
			payload: {},
		});
	});

	it('returns the verified file path with a completed capture when the port can resolve it', async () => {
		const job = {
			id: 'simulator-shot',
			actionId: 'agent-cli-0123456789abcdef0123456789abcdef-1',
			kind: 'capture.screenshot',
			deviceUdid: UDID,
			status: 'complete',
			progressSequence: 2,
			phase: 'complete',
			createdAt: now,
			startedAt: now,
			finishedAt: now + 1,
			message: 'Complete.',
			captureId: 'capture-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
		};
		const capture = {
			id: 'capture-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
			deviceUdid: UDID,
			kind: 'screenshot',
			status: 'complete',
			createdAt: now,
			name: 'shot',
			mimeType: 'image/png',
			bytes: 7,
		};
		const state = simulatorStateSchema.parse({
			...simulatorState(),
			jobs: [job],
			captures: [capture],
		});
		const resolved: string[] = [];
		const port = (withPath: boolean) => ({
			getState: () => state,
			refresh: async () => state,
			runAction: (action: SimulatorAction) => ({
				actionId: action.actionId,
				accepted: true,
				jobId: 'simulator-shot',
			}),
			cancelJob: () => false,
			subscribe: () => () => undefined,
			...(withPath
				? {
						verifiedCapturePath: async (captureId: string) => {
							resolved.push(captureId);
							return '/captures/capture-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.png';
						},
					}
				: {}),
		});
		const { dependencies } = fixture();
		const withPath = createAgentCommandRouter({
			...dependencies,
			simulator: port(true),
		});
		await expect(
			withPath({ kind: 'capture', udid: UDID, format: 'png' }, context)
		).resolves.toMatchObject({
			capture: { id: 'capture-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' },
			path: '/captures/capture-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d.png',
		});
		expect(resolved).toEqual(['capture-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d']);

		const withoutPath = createAgentCommandRouter({
			...dependencies,
			simulator: port(false),
		});
		const result = (await withoutPath(
			{ kind: 'capture', udid: UDID, format: 'png' },
			context
		)) as Record<string, unknown>;
		expect(result).toMatchObject({
			capture: { id: 'capture-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' },
		});
		expect(result).not.toHaveProperty('path');
	});

	it('refuses to stop cross-target, non-video, or terminal jobs', async () => {
		const { cancelledSimulatorJobs, handler, setSimulator } = fixture();
		const state = simulatorState();
		setSimulator(
			simulatorStateSchema.parse({
				...state,
				jobs: [
					{
						id: 'simulator-non-video',
						actionId: 'capture-image',
						kind: 'capture.screenshot',
						deviceUdid: UDID,
						status: 'running',
						progressSequence: 1,
						phase: 'executing',
						createdAt: now,
						startedAt: now,
						message: 'Capturing.',
					},
					{
						id: 'simulator-cross-target',
						actionId: 'capture-video-other',
						kind: 'capture.video',
						deviceUdid: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
						status: 'running',
						progressSequence: 1,
						phase: 'executing',
						createdAt: now,
						startedAt: now,
						message: 'Recording.',
					},
					{
						id: 'simulator-terminal-video',
						actionId: 'capture-video-complete',
						kind: 'capture.video',
						deviceUdid: UDID,
						status: 'complete',
						progressSequence: 2,
						phase: 'complete',
						createdAt: now,
						startedAt: now,
						finishedAt: now + 1,
						message: 'Complete.',
					},
				],
			})
		);

		for (const jobId of [
			'simulator-non-video',
			'simulator-cross-target',
			'simulator-terminal-video',
		]) {
			await expect(
				handler(
					{
						kind: 'record',
						operation: 'stop',
						udid: UDID,
						codec: 'h264',
						jobId,
					},
					context
				)
			).rejects.toMatchObject({ code: 'invalid_command' });
		}
		expect(cancelledSimulatorJobs).toEqual([]);
	});

	it('lets only the holder cancel jobs or stop a recording on a held device', async () => {
		const { cancelledSimulatorJobs, dependencies, setSimulator, setSlimming } =
			fixture();
		const owner = { kind: 'claude' as const, sessionId: 'owner' };
		const running = {
			progressSequence: 1,
			createdAt: now,
			startedAt: now,
			status: 'running' as const,
		};
		setSimulator(
			simulatorStateSchema.parse({
				...simulatorState(),
				jobs: [
					{
						...running,
						id: 'simulator-lane-boot',
						actionId: 'lane-boot',
						kind: 'device.boot',
						deviceUdid: UDID,
						phase: 'executing',
						message: 'Booting.',
					},
					{
						...running,
						id: 'simulator-recording',
						actionId: 'lane-recording',
						kind: 'capture.video',
						deviceUdid: UDID,
						phase: 'executing',
						message: 'Recording.',
					},
				],
			})
		);
		setSlimming(
			slimmingStateSchema.parse({
				...slimmingState(),
				jobs: [
					{
						...running,
						id: 'slimming-lane-apply',
						actionId: 'lane-apply',
						kind: 'profile.apply',
						phase: 'running',
						message: 'Applying.',
						currentIndex: 0,
						total: 1,
						targets: [
							{ simulatorUdid: UDID, status: 'running', message: 'Applying.' },
						],
					},
				],
			})
		);
		const handler = createAgentCommandRouter({
			...dependencies,
			agents: holdsOnlyAgents(owner),
		});
		const asStranger = {
			...context,
			agent: { kind: 'codex' as const, sessionId: 'stranger' },
		};
		for (const jobId of ['simulator-lane-boot', 'slimming-lane-apply']) {
			await expect(
				handler({ kind: 'jobs', operation: 'cancel', jobId }, asStranger)
			).rejects.toMatchObject({ code: 'device_held' });
		}
		const stopRecording = {
			kind: 'record' as const,
			operation: 'stop' as const,
			udid: UDID,
			codec: 'h264' as const,
		};
		await expect(handler(stopRecording, asStranger)).rejects.toMatchObject({
			code: 'device_held',
		});
		expect(cancelledSimulatorJobs).toEqual([]);
		// Listing and reading jobs stay open to everyone.
		await expect(
			handler(
				{ kind: 'jobs', operation: 'get', jobId: 'simulator-lane-boot' },
				asStranger
			)
		).resolves.toMatchObject({ id: 'simulator-lane-boot' });

		await expect(
			handler(
				{ kind: 'jobs', operation: 'cancel', jobId: 'simulator-lane-boot' },
				{ ...context, agent: owner }
			)
		).resolves.toEqual({ cancelled: false });
		// The fixture's cancel reports the recording already gone.
		await expect(
			handler(stopRecording, { ...context, agent: owner })
		).rejects.toMatchObject({ code: 'invalid_command' });
		expect(cancelledSimulatorJobs).toEqual([
			'simulator-lane-boot',
			'simulator-recording',
		]);
	});

	it('lets a session stop or cancel a recording it started after another session took the device, and no one else', async () => {
		const root = await mkdtemp(
			path.join(os.tmpdir(), 'rndevtools-router-recordings-')
		);
		const recorder = { kind: 'codex' as const, sessionId: 'recorder' };
		const owner = { kind: 'claude' as const, sessionId: 'owner' };
		const stranger = { kind: 'claude' as const, sessionId: 'stranger' };
		const agents = new AgentService({
			directory: root,
			lanes: () => [],
			discover: async () => ({
				sessions: [recorder, owner, stranger].map((session) => ({
					...session,
					title: session.sessionId,
					cwd: '/Users/dev/app',
				})),
				claude: 'ok',
				codex: 'ok',
			}),
			pollIntervalMs: 60_000,
			now: () => now,
		});
		try {
			await agents.start();
			const { port: simulator, cancelled } = recordingSimulator();
			const { dependencies } = fixture();
			const handler = createAgentCommandRouter({
				...dependencies,
				simulator,
				agents,
			});
			const by = (agent: Holder) => ({ ...context, agent });
			const start = {
				kind: 'record' as const,
				operation: 'start' as const,
				udid: UDID,
				codec: 'h264' as const,
			};

			// Recording needs no hold, so it starts on the free device; then the
			// owner claims the device while it runs.
			const first = (await handler(start, by(recorder))) as { jobId: string };
			await handler({ kind: 'claim', udid: UDID }, by(owner));
			const stopFirst = {
				...start,
				operation: 'stop' as const,
				jobId: first.jobId,
			};
			// The hold still keeps every other session off the owner's device.
			await expect(handler(stopFirst, by(stranger))).rejects.toMatchObject({
				code: 'device_held',
			});
			await expect(
				handler(
					{ kind: 'jobs', operation: 'cancel', jobId: first.jobId },
					by(stranger)
				)
			).rejects.toMatchObject({ code: 'device_held' });
			expect(cancelled).toEqual([]);

			await expect(handler(stopFirst, by(recorder))).resolves.toMatchObject({
				job: { id: first.jobId, status: 'cancelled' },
			});
			// A recording only watches, so one on the held device is fine too,
			// and its starter can cancel it.
			const second = (await handler(start, by(recorder))) as {
				jobId: string;
			};
			await expect(
				handler(
					{ kind: 'jobs', operation: 'cancel', jobId: second.jobId },
					by(recorder)
				)
			).resolves.toEqual({ cancelled: true });
			expect(cancelled).toEqual([first.jobId, second.jobId]);
		} finally {
			await agents.stop();
			await rm(root, { recursive: true, force: true });
		}
	});

	it('stops the caller’s own recording first when record stop names no job', async () => {
		const { port: simulator, cancelled } = recordingSimulator();
		const { dependencies } = fixture();
		const owner = { kind: 'claude' as const, sessionId: 'owner' };
		const recorder = { kind: 'codex' as const, sessionId: 'recorder' };
		const handler = createAgentCommandRouter({
			...dependencies,
			simulator,
			agents: holdsOnlyAgents(owner),
		});
		const by = (agent: Holder) => ({ ...context, agent });
		const record = {
			kind: 'record' as const,
			udid: UDID,
			codec: 'h264' as const,
		};
		await handler({ ...record, operation: 'start' }, by(owner));
		const mine = (await handler(
			{ ...record, operation: 'start' },
			by(recorder)
		)) as { jobId: string };
		await expect(
			handler({ ...record, operation: 'stop' }, by(recorder))
		).resolves.toMatchObject({ job: { id: mine.jobId } });
		// With none of its own left, the one still going is the holder's.
		await expect(
			handler({ ...record, operation: 'stop' }, by(recorder))
		).rejects.toMatchObject({ code: 'device_held' });
		expect(cancelled).toEqual([mine.jobId]);
	});

	it('canonicalizes lowercase Simulator targets before local and recipe dispatch', async () => {
		const { dependencies, simulatorActions, slimmingActions } = fixture();
		const recipeTargets: string[][] = [];
		const handler = createAgentCommandRouter({
			...dependencies,
			recipes: {
				list: () => [],
				get: () => undefined,
				run: async (_recipeId, udids) => {
					recipeTargets.push([...udids]);
					return { accepted: false, needsApproval: true };
				},
				cancel: () => false,
				status: () => undefined,
			},
		});

		await expect(
			handler(
				{ kind: 'capture', udid: UDID.toLowerCase(), format: 'png' },
				context
			)
		).rejects.toMatchObject({ code: 'action_rejected' });
		await expect(
			handler(
				{
					kind: 'slimming',
					operation: 'preview',
					udids: [UDID.toLowerCase()],
					profileId: 'rndevtools-development',
				},
				context
			)
		).rejects.toMatchObject({ code: 'action_rejected' });
		await handler(
			{
				kind: 'recipe',
				operation: 'run',
				recipeId: 'recipe-smoke',
				udids: [UDID.toLowerCase()],
			},
			context
		);

		expect(simulatorActions[0]).toMatchObject({ udid: UDID });
		expect(slimmingActions[0]).toMatchObject({ simulatorUdids: [UDID] });
		expect(recipeTargets).toEqual([[UDID]]);
	});

	it('fails an unknown job wait immediately', async () => {
		const { handler } = fixture();
		await expect(
			handler(
				{
					kind: 'wait',
					condition: { kind: 'job', jobId: 'missing-job' },
					timeoutMs: 60_000,
				},
				context
			)
		).rejects.toMatchObject({ code: 'target_not_found' });
	});

	it('fails closed when a UDID ambiguously maps to two live sessions', async () => {
		const { handler, setDesktop } = fixture();
		const state = desktopState();
		setDesktop({
			...state,
			devices: [
				state.devices[0] as NonNullable<(typeof state.devices)[number]>,
				{
					...(state.devices[0] as NonNullable<(typeof state.devices)[number]>),
					info: {
						...(state.devices[0] as NonNullable<(typeof state.devices)[number]>)
							.info,
						id: 'second-session',
					},
				},
			],
		});
		await expect(
			handler({ kind: 'screen', target: { udid: UDID } }, context)
		).rejects.toMatchObject({ code: 'ambiguous_target' });
	});

	it('does not expose mutating Slimming operations through the router', async () => {
		const { handler, slimmingActions } = fixture();
		const status = await handler(
			{ kind: 'slimming', operation: 'status' },
			context
		);
		expect(status).toMatchObject({
			setting: { experimentalMutationsEnabled: false },
		});
		expect(slimmingActions).toHaveLength(0);
	});

	it('keeps class-backed simulator service subscriptions bound while awaiting jobs', async () => {
		class BoundSlimmingPort {
			readonly listeners = new Set<(state: SlimmingState) => void>();
			state = slimmingState();

			getState(): SlimmingState {
				return this.state;
			}

			async refresh(): Promise<SlimmingState> {
				return this.state;
			}

			runAction(action: SlimmingAction) {
				const jobId = 'slimming-bound-job';
				this.state = slimmingStateSchema.parse({
					...this.state,
					jobs: [
						{
							id: jobId,
							actionId: action.actionId,
							kind: action.kind,
							status: 'running',
							progressSequence: 1,
							phase: 'running',
							message: 'Running doctor.',
							createdAt: now,
							startedAt: now,
							currentIndex: 0,
							total: 1,
							targets: [
								{
									simulatorUdid: UDID,
									status: 'running',
									message: 'Running doctor.',
								},
							],
						},
					],
				});
				queueMicrotask(() => {
					const running = this.state.jobs[0];
					this.state = slimmingStateSchema.parse({
						...this.state,
						jobs: [
							{
								...running,
								status: 'complete',
								progressSequence: 2,
								phase: 'complete',
								message: 'Doctor completed.',
								finishedAt: now + 1,
								currentIndex: 1,
								targets: [
									{
										simulatorUdid: UDID,
										status: 'complete',
										message: 'Doctor completed.',
									},
								],
							},
						],
					});
					for (const listener of this.listeners) listener(this.state);
				});
				return { actionId: action.actionId, accepted: true, jobId };
			}

			cancelJob(): boolean {
				return false;
			}

			subscribe(listener: (state: SlimmingState) => void): () => void {
				this.listeners.add(listener);
				return () => this.listeners.delete(listener);
			}
		}

		const boundSlimming = new BoundSlimmingPort();
		const handler = createAgentCommandRouter({
			broker: {
				getState: desktopState,
				dispatchAction: async (action) => ({
					actionId: action.actionId,
					ok: true,
				}),
			},
			simulator: {
				getState: simulatorState,
				refresh: async () => simulatorState(),
				runAction: (action) => ({
					actionId: action.actionId,
					accepted: false,
					error: 'not used',
				}),
				cancelJob: () => false,
				subscribe: () => () => undefined,
			},
			slimming: boundSlimming,
		});
		const result = await handler(
			{ kind: 'slimming', operation: 'doctor', udids: [UDID] },
			context
		);
		expect(result).toMatchObject({ job: { status: 'complete' } });
		expect(boundSlimming.listeners.size).toBe(0);
	});

	it('routes slimming apply, undo, and restore with the confirmation literal and the requesting session', async () => {
		const { dependencies, slimmingActions } = fixture();
		const me = { kind: 'codex' as const, sessionId: 'thread-7' };
		const handler = createAgentCommandRouter({
			...dependencies,
			slimming: {
				...dependencies.slimming,
				runAction: (action: SlimmingAction) => {
					slimmingActions.push(action);
					return {
						actionId: action.actionId,
						accepted: false,
						error: 'helper unavailable in this test',
					};
				},
			},
		});
		for (const [operation, kind, confirmation] of [
			['apply', 'profile.apply', SLIMMING_CONFIRMATIONS.apply],
			['undo', 'profile.undo', SLIMMING_CONFIRMATIONS.undo],
			['restore', 'profile.restore', SLIMMING_CONFIRMATIONS.restore],
		] as const) {
			await expect(
				handler(
					{
						kind: 'slimming',
						operation,
						udids: [UDID.toLowerCase()],
						...(operation === 'apply'
							? { profileId: 'rndevtools-development' }
							: {}),
					},
					{ ...context, agent: me }
				)
			).rejects.toMatchObject({ code: 'action_rejected' });
			expect(slimmingActions.at(-1)).toMatchObject({
				kind,
				confirmation,
				simulatorUdids: [UDID],
				requester: me,
				...(operation === 'apply'
					? { profileId: 'rndevtools-development' }
					: {}),
			});
		}
		// Without a session, no requester rides along: the service treats the
		// request as the operator's.
		await expect(
			handler({ kind: 'slimming', operation: 'undo', udids: [UDID] }, context)
		).rejects.toMatchObject({ code: 'action_rejected' });
		expect(slimmingActions.at(-1)).not.toHaveProperty('requester');
	});

	it('returns a durable handle for a slow SimSlim job without cancelling it or leaking its observer', async () => {
		vi.useFakeTimers();
		try {
			const { dependencies, setSlimming } = fixture();
			const unsubscribe = vi.fn();
			const cancelJob = vi.fn(() => true);
			const handler = createAgentCommandRouter({
				...dependencies,
				slimming: {
					...dependencies.slimming,
					cancelJob,
					subscribe: () => unsubscribe,
					runAction: (action: SlimmingAction) => {
						setSlimming(
							slimmingStateSchema.parse({
								...slimmingState(),
								jobs: [
									{
										id: 'slow-slim',
										actionId: action.actionId,
										kind: action.kind,
										status: 'running',
										progressSequence: 1,
										phase: 'running',
										message: 'Rebooting the Simulator.',
										createdAt: now,
										currentIndex: 0,
										total: 1,
										targets: [
											{
												simulatorUdid: UDID,
												status: 'running',
												message: 'Rebooting.',
											},
										],
									},
								],
							})
						);
						return {
							actionId: action.actionId,
							accepted: true,
							jobId: 'slow-slim',
						};
					},
				},
			});
			const pending = handler(
				{
					kind: 'slimming',
					operation: 'apply',
					udids: [UDID],
					profileId: 'rndevtools-development',
				},
				context
			);
			await vi.advanceTimersByTimeAsync(20_000);
			expect(await pending).toMatchObject({
				completed: false,
				jobId: 'slow-slim',
				job: { status: 'running' },
				next: expect.stringContaining('wait --condition job'),
			});
			expect(cancelJob).not.toHaveBeenCalled();
			expect(unsubscribe).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		['simulator', 'timeout'],
		['simulator', 'complete'],
		['simulator', 'cancelled'],
		['slimming', 'timeout'],
		['slimming', 'complete'],
		['slimming', 'cancelled'],
	] as const)(
		'bounds %s job observation on %s without cancelling the job',
		async (source, outcome) => {
			vi.useFakeTimers();
			try {
				const { dependencies, setSimulator, setSlimming } = fixture();
				const jobId = `${source}-bounded-wait`;
				const update = (status: 'running' | 'complete') => {
					const common = {
						id: jobId,
						actionId: 'bounded-wait',
						status,
						progressSequence: status === 'running' ? 1 : 2,
						phase: status,
						message: status,
						createdAt: now,
					};
					if (source === 'simulator') {
						setSimulator(
							simulatorStateSchema.parse({
								...simulatorState(),
								jobs: [{ ...common, kind: 'device.boot', deviceUdid: UDID }],
							})
						);
					} else {
						setSlimming(
							slimmingStateSchema.parse({
								...slimmingState(),
								jobs: [
									{
										...common,
										kind: 'profile.apply',
										currentIndex: 0,
										total: 1,
										targets: [{ simulatorUdid: UDID, status, message: status }],
									},
								],
							})
						);
					}
				};
				update('running');
				const unsubscribe = vi.fn();
				const cancelJob = vi.fn(() => true);
				let publish: () => void = () => undefined;
				const handler = createAgentCommandRouter({
					...dependencies,
					simulator: {
						...dependencies.simulator,
						cancelJob,
						subscribe: (listener) => {
							publish = () => listener(dependencies.simulator.getState());
							return unsubscribe;
						},
					},
					slimming: {
						...dependencies.slimming,
						cancelJob,
						subscribe: (listener) => {
							publish = () => listener(dependencies.slimming.getState());
							return unsubscribe;
						},
					},
				});
				const controller = new AbortController();
				const pending = handler(
					{ kind: 'wait', condition: { kind: 'job', jobId }, timeoutMs: 1_000 },
					{ ...context, signal: controller.signal }
				);
				if (outcome === 'cancelled') {
					controller.abort();
					await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
				} else {
					if (outcome === 'complete') {
						update('complete');
						publish();
					} else {
						await vi.advanceTimersByTimeAsync(1_000);
					}
					expect(await pending).toMatchObject({
						id: jobId,
						status: outcome === 'complete' ? 'complete' : 'running',
					});
				}
				expect(cancelJob).not.toHaveBeenCalled();
				expect(unsubscribe).toHaveBeenCalledTimes(1);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				vi.useRealTimers();
			}
		}
	);

	it('refuses slimming mutations on a device another session holds before reaching the service', async () => {
		const { dependencies, slimmingActions } = fixture();
		const handler = createAgentCommandRouter({
			...dependencies,
			agents: {
				getState: () => {
					throw new Error('unused');
				},
				refresh: async () => {
					throw new Error('unused');
				},
				runOperation: async () => {
					throw new Error('unused');
				},
				touch: () => undefined,
				access: (udid, requester) =>
					requester
						? {
								allowed: false,
								reason: `Simulator ${udid} is held by claude session owner through lane lane-1.`,
								hold: {
									simulatorUdid: udid,
									via: 'lane',
									laneId: 'lane-1',
									holder: { kind: 'claude', sessionId: 'owner' },
									holderLive: true,
								},
							}
						: { allowed: true },
			},
		});
		await expect(
			handler(
				{
					kind: 'slimming',
					operation: 'apply',
					udids: [UDID],
					profileId: 'rndevtools-development',
				},
				{ ...context, agent: { kind: 'codex', sessionId: 'stranger' } }
			)
		).rejects.toMatchObject({ code: 'device_held' });
		expect(slimmingActions).toEqual([]);
		// Read-only operations are never gated on ownership.
		await expect(
			handler(
				{
					kind: 'slimming',
					operation: 'preview',
					udids: [UDID],
					profileId: 'rndevtools-development',
				},
				{ ...context, agent: { kind: 'codex', sessionId: 'stranger' } }
			)
		).rejects.toMatchObject({ code: 'action_rejected' });
		expect(slimmingActions).toHaveLength(1);
	});

	it('reports the absent recipe provider with a typed recovery path', async () => {
		const { handler } = fixture();
		await expect(
			handler({ kind: 'recipe', operation: 'list' }, context)
		).rejects.toEqual(
			expect.objectContaining<Partial<AgentCliError>>({
				code: 'unavailable',
				recovery: expect.stringContaining('Automation'),
			})
		);
	});

	it('routes recipe commands through the approval-aware local provider', async () => {
		const { dependencies } = fixture();
		const recipes = {
			list: async () => [{ id: 'recipe-smoke', revision: 2 }],
			get: async (recipeId: string) => ({ id: recipeId, revision: 2 }),
			run: async (recipeId: string, udids: readonly string[]) => ({
				recipeId,
				targetUdids: udids,
				accepted: false,
				needsApproval: true,
			}),
			cancel: async (runId: string) => ({ runId, cancelled: true }),
			status: async (runId?: string) => ({
				runId: runId ?? null,
				status: 'complete',
			}),
		};
		const handler = createAgentCommandRouter({ ...dependencies, recipes });

		await expect(
			handler({ kind: 'recipe', operation: 'list' }, context)
		).resolves.toEqual([{ id: 'recipe-smoke', revision: 2 }]);
		await expect(
			handler(
				{
					kind: 'recipe',
					operation: 'run',
					recipeId: 'recipe-smoke',
					udids: [UDID],
				},
				context
			)
		).resolves.toMatchObject({ accepted: false, needsApproval: true });
		await expect(
			handler(
				{ kind: 'recipe', operation: 'status', runId: 'recipe-run-smoke' },
				context
			)
		).resolves.toEqual({ runId: 'recipe-run-smoke', status: 'complete' });
	});

	it('refuses a recipe run on a device another session holds before the recipe starts', async () => {
		const { dependencies } = fixture();
		const owner = { kind: 'claude' as const, sessionId: 'owner' };
		const runs: string[][] = [];
		const handler = createAgentCommandRouter({
			...dependencies,
			agents: holdsOnlyAgents(owner),
			recipes: {
				list: () => [],
				get: () => undefined,
				run: async (_recipeId, udids) => {
					runs.push([...udids]);
					return { accepted: true };
				},
				cancel: () => false,
				status: () => undefined,
			},
		});
		const run = {
			kind: 'recipe' as const,
			operation: 'run' as const,
			recipeId: 'recipe-smoke',
			udids: [UDID.toLowerCase()],
		};
		await expect(
			handler(run, {
				...context,
				agent: { kind: 'codex', sessionId: 'stranger' },
			})
		).rejects.toMatchObject({
			code: 'device_held',
			message: expect.stringContaining('owner'),
		});
		expect(runs).toEqual([]);
		await handler(run, { ...context, agent: owner });
		await handler(run, context);
		expect(runs).toEqual([[UDID], [UDID]]);
	});

	describe('native plan and install', () => {
		/**
		 * Simulator port that remembers `initial` as the apps it last listed.
		 * Its app.list/app.install jobs complete and update appsByDevice. On a
		 * device that is not booted they fail as the service's do, and so does
		 * every listing given `listFailure`, leaving the remembered apps.
		 */
		function simulatorWithApps(
			initial: string[],
			{
				deviceState = 'booted',
				listFailure,
			}: {
				deviceState?: SimulatorState['devices'][number]['state'];
				listFailure?: string;
			} = {}
		) {
			let apps = [...initial];
			const listeners = new Set<(state: SimulatorState) => void>();
			const listed = () => ({
				[UDID]: apps.map((bundleIdentifier) => ({
					bundleIdentifier,
					displayName: bundleIdentifier,
					isSystem: false,
				})),
			});
			let state = simulatorStateSchema.parse({
				...simulatorState(),
				devices: simulatorState().devices.map((device) => ({
					...device,
					state: deviceState,
				})),
				appsByDevice: listed(),
			});
			const actions: Array<{
				action: SimulatorAction;
				context: { selectedPath?: string } | undefined;
			}> = [];
			const port = {
				getState: () => state,
				refresh: async () => state,
				runAction: (
					action: SimulatorAction,
					actionContext?: { selectedPath?: string }
				) => {
					actions.push({ action, context: actionContext });
					const jobId = `job-${actions.length}`;
					queueMicrotask(() => {
						const failure =
							deviceState !== 'booted'
								? 'Simulator must be booted for this action.'
								: action.kind === 'app.list'
									? listFailure
									: undefined;
						if (!failure && action.kind === 'app.install')
							apps = [...apps, 'com.example.app'];
						state = simulatorStateSchema.parse({
							...state,
							...(failure ? {} : { appsByDevice: listed() }),
							jobs: [
								{
									id: jobId,
									actionId: action.actionId,
									kind: action.kind,
									status: failure ? 'failed' : 'complete',
									progressSequence: 1,
									phase: failure ? 'failed' : 'complete',
									message: failure ?? 'done',
									createdAt: now,
									finishedAt: now + 1,
									deviceUdid: UDID,
								},
							],
						});
						for (const listener of listeners) listener(state);
					});
					return { actionId: action.actionId, accepted: true, jobId };
				},
				cancelJob: () => false,
				subscribe: (listener: (state: SimulatorState) => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			};
			return { port, actions };
		}
		const BUILD_LANE_ID = 'lane-11111111-2222-4333-8444-555555555555';
		/**
		 * The worktree's lane, with the identity its app.json gave it when it
		 * started: by default a bundle identifier and a scheme.
		 */
		function buildLanes(
			appPath?: string,
			metro: LaneState['lanes'][number]['metro'] = 'ready',
			identity: { bundleIdentifier?: string; scheme?: string } = {
				bundleIdentifier: 'com.example.app',
				scheme: 'exampleapp',
			}
		) {
			let state: LaneState = {
				revision: 1,
				updatedAt: now,
				environments: [...DEFAULT_LANE_ENVIRONMENTS],
				lanes: [
					{
						id: BUILD_LANE_ID,
						worktreePath: '/Users/dev/app',
						...(appPath ? { appPath } : {}),
						branch: 'main',
						simulatorUdid: UDID,
						environment: 'development',
						port: 8107,
						metro,
						logPath: '/Users/dev/lane.log',
						startedAt: now,
						...identity,
					},
				],
				worktrees: [],
				repositories: [],
				deviceRequests: [],
			};
			return {
				getState: () => state,
				refresh: async () => state,
				runOperation: async (): Promise<LaneOperationReceipt> => {
					throw new Error('unused');
				},
				/** Moves the lane's Metro on, as the lane service's reconcile does. */
				setMetro: (next: LaneState['lanes'][number]['metro']) => {
					state = {
						...state,
						lanes: state.lanes.map((lane) => ({ ...lane, metro: next })),
					};
				},
			};
		}

		const plan = (cache: 'hit' | 'miss' | 'no-provider') => async () => ({
			projectRoot: '/Users/dev/app',
			platform: 'ios' as const,
			configuration: 'Debug',
			fingerprintHash: 'f'.repeat(40),
			sourceCount: 12,
			...(cache === 'no-provider'
				? {}
				: {
						provider: {
							plugin: '@rndevtools/react-native/build-cache',
							cacheEntry: '/Users/dev/Library/Caches/rndevtools/native/x',
						},
					}),
			cache,
			...(cache === 'hit'
				? {
						artifactPath:
							'/Users/dev/Library/Caches/rndevtools/native/x/ExampleApp.app',
					}
				: {}),
			bundleIdentifier: 'com.example.app',
			scheme: 'exampleapp',
		});

		it('reports the absent planner with a typed recovery path', async () => {
			const { dependencies } = fixture();
			await expect(
				createAgentCommandRouter(dependencies)(
					{
						kind: 'native',
						operation: 'plan',
						configuration: 'Debug',
						worktreePath: '/Users/dev/app',
					},
					context
				)
			).rejects.toEqual(
				expect.objectContaining<Partial<AgentCliError>>({ code: 'unavailable' })
			);
		});

		it('plans without a device: fingerprint, cache state, and a build recommendation', async () => {
			const { dependencies } = fixture();
			const { port, actions } = simulatorWithApps([]);
			const handler = createAgentCommandRouter({
				...dependencies,
				simulator: port,
				nativePlan: plan('miss'),
			});
			const result = (await handler(
				{
					kind: 'native',
					operation: 'plan',
					configuration: 'Debug',
					worktreePath: '/Users/dev/app',
				},
				context
			)) as Record<string, unknown>;
			expect(result).toMatchObject({
				fingerprintHash: 'f'.repeat(40),
				cache: 'miss',
				bundleIdentifier: 'com.example.app',
			});
			expect(result).not.toHaveProperty('installed');
			expect(String(result.recommendation)).toMatch(/^build: /);
			expect(String(result.recommendation)).toMatch(/lane with operation up/);
			// Expo CLI starts its own Metro for an explicit Debug configuration,
			// even with --no-bundler, so the Debug advice leaves the flag out.
			expect(String(result.recommendation)).not.toMatch(/--configuration/);
			expect(actions).toHaveLength(0);
		});

		it('names a configuration other than Debug in the build advice', async () => {
			const { dependencies } = fixture();
			const { port } = simulatorWithApps([]);
			const handler = createAgentCommandRouter({
				...dependencies,
				simulator: port,
				lanes: buildLanes(),
				nativePlan: async () => ({
					...(await plan('miss')()),
					configuration: 'Release',
				}),
			});
			const result = (await handler(
				{
					kind: 'native',
					operation: 'plan',
					configuration: 'Release',
					worktreePath: '/Users/dev/app',
				},
				context
			)) as Record<string, unknown>;
			expect(String(result.recommendation)).toMatch(
				/expo run:ios --configuration Release --device \S+ --no-bundler`/
			);
		});

		it.each([undefined, '/Users/dev/app/apps/mobile'])(
			'uses only the target app lane Metro port (%s)',
			async (appPath) => {
				const { dependencies } = fixture();
				const { port } = simulatorWithApps([]);
				const handler = createAgentCommandRouter({
					...dependencies,
					simulator: port,
					lanes: buildLanes(appPath),
					nativePlan: async () => ({
						...(await plan('miss')()),
						projectRoot: appPath ?? '/Users/dev/app',
					}),
				});
				const result = (await handler(
					{
						kind: 'native',
						operation: 'plan',
						configuration: 'Debug',
						worktreePath: appPath ?? '/Users/dev/app',
						udid: UDID,
					},
					context
				)) as Record<string, unknown>;
				expect(result.recommendation).toContain(
					`\`npx expo run:ios --device ${UDID} --no-bundler\``
				);
				expect(result.recommendation).toContain(
					`lane ${BUILD_LANE_ID}'s Metro on port 8107`
				);
				expect(result.recommendation).not.toContain('--configuration Debug');
			}
		);

		it('gives a build command Expo CLI accepts, then the restart that points the app at the lane', async () => {
			// @expo/cli 57 refuses --port with --no-bundler (BAD_ARGS from
			// build/src/run/resolveBundlerProps.js) before it builds anything, and
			// with --no-bundler it opens the app it installed against port 8081.
			// So the build names no port, and a lane launch with restart reopens
			// the app with the lane's own Metro.
			const restart = `then \`rndevtools lane --operation launch --lane-id ${BUILD_LANE_ID} --restart\`: the build opens the app against port 8081, since Expo refuses --port with --no-bundler, and the restart reopens it with lane ${BUILD_LANE_ID}'s Metro on port 8107`;
			const build = `npx expo run:ios --device ${UDID} --no-bundler`;
			const { dependencies } = fixture();
			const { port } = simulatorWithApps([]);
			const route = (cache: 'miss' | 'no-provider') =>
				createAgentCommandRouter({
					...dependencies,
					simulator: port,
					lanes: buildLanes(),
					nativePlan: plan(cache),
				});
			const native = {
				kind: 'native',
				configuration: 'Debug',
				worktreePath: '/Users/dev/app',
				udid: UDID,
			} as const;
			const miss = (await route('miss')(
				{ ...native, operation: 'plan' },
				context
			)) as Record<string, unknown>;
			expect(miss.recommendation).toBe(
				`build: no cached binary for this fingerprint; run \`${build}\` once (the build cache will store it for every other worktree), ${restart}.`
			);
			const uncached = (await route('no-provider')(
				{ ...native, operation: 'plan' },
				context
			)) as Record<string, unknown>;
			expect(uncached.recommendation).toBe(
				`build: this project declares no buildCacheProvider, so every worktree builds; run \`${build}\`, ${restart}.`
			);
			await expect(
				route('miss')({ ...native, operation: 'install' }, context)
			).rejects.toMatchObject({
				code: 'cache_miss',
				recovery: `Run \`${build}\`, ${restart}.`,
			});
			// The command itself never names a port.
			for (const text of [miss.recommendation, uncached.recommendation]) {
				expect(text).not.toMatch(/`npx expo run:ios[^`]*--port/);
			}
		});

		it('gives a lane with no bundle identifier the launch without restart, and says to restart the app by hand', async () => {
			// The lane service refuses a restart for a lane whose app.json named
			// no ios.bundleIdentifier when it started: it has nothing to
			// terminate the app by.
			const afterward = `then \`rndevtools lane --operation launch --lane-id ${BUILD_LANE_ID}\`: the build opens the app against port 8081, since Expo refuses --port with --no-bundler. Lane ${BUILD_LANE_ID} cannot restart the app, as the worktree's app.json declared no ios.bundleIdentifier when the lane started, so restart it by hand: quit it on the Simulator before that launch, which then opens it with lane ${BUILD_LANE_ID}'s Metro on port 8107`;
			const build = `npx expo run:ios --device ${UDID} --no-bundler`;
			const { dependencies } = fixture();
			const { port } = simulatorWithApps([]);
			const route = (cache: 'miss' | 'no-provider') =>
				createAgentCommandRouter({
					...dependencies,
					simulator: port,
					lanes: buildLanes(undefined, 'ready', { scheme: 'exampleapp' }),
					nativePlan: plan(cache),
				});
			const native = {
				kind: 'native',
				configuration: 'Debug',
				worktreePath: '/Users/dev/app',
				udid: UDID,
			} as const;
			const miss = (await route('miss')(
				{ ...native, operation: 'plan' },
				context
			)) as Record<string, unknown>;
			expect(miss.recommendation).toBe(
				`build: no cached binary for this fingerprint; run \`${build}\` once (the build cache will store it for every other worktree), ${afterward}.`
			);
			const uncached = (await route('no-provider')(
				{ ...native, operation: 'plan' },
				context
			)) as Record<string, unknown>;
			expect(uncached.recommendation).toBe(
				`build: this project declares no buildCacheProvider, so every worktree builds; run \`${build}\`, ${afterward}.`
			);
			await expect(
				route('miss')({ ...native, operation: 'install' }, context)
			).rejects.toMatchObject({
				code: 'cache_miss',
				recovery: `Run \`${build}\`, ${afterward}.`,
			});
			for (const text of [miss.recommendation, uncached.recommendation]) {
				expect(text).not.toContain('--restart');
			}
		});

		it.each([
			['exampleapp', 'exampleapp', ''],
			[
				undefined,
				'<scheme>',
				', with <scheme> the URL scheme the app registers',
			],
		] as const)(
			"gives a lane with no URL scheme the dev client's full URL after a build (plan scheme %s)",
			async (planScheme, scheme, placeholder) => {
				// A lane reads its scheme from app.json only when it starts, and
				// one with none opens its dev client only through a full URL.
				const url = `'${scheme}://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8107&disableOnboarding=1&disableAutoLaunch=1'`;
				const afterward = `then \`rndevtools lane --operation launch --lane-id ${BUILD_LANE_ID} --url ${url} --restart\`: the build opens the app against port 8081, since Expo refuses --port with --no-bundler, and the restart reopens it with lane ${BUILD_LANE_ID}'s Metro on port 8107. Lane ${BUILD_LANE_ID} has no URL scheme, as the worktree's app.json gave none when the lane started, so that launch names its dev client's full URL${placeholder}`;
				const build = `npx expo run:ios --device ${UDID} --no-bundler`;
				const { dependencies } = fixture();
				const { port } = simulatorWithApps([]);
				const route = createAgentCommandRouter({
					...dependencies,
					simulator: port,
					lanes: buildLanes(undefined, 'ready', {
						bundleIdentifier: 'com.example.app',
					}),
					nativePlan: async () => {
						const { scheme: _scheme, ...planned } = await plan('miss')();
						return planScheme ? { ...planned, scheme: planScheme } : planned;
					},
				});
				const native = {
					kind: 'native',
					configuration: 'Debug',
					worktreePath: '/Users/dev/app',
					udid: UDID,
				} as const;
				const planned = (await route(
					{ ...native, operation: 'plan' },
					context
				)) as Record<string, unknown>;
				expect(planned.recommendation).toBe(
					`build: no cached binary for this fingerprint; run \`${build}\` once (the build cache will store it for every other worktree), ${afterward}.`
				);
				await expect(
					route({ ...native, operation: 'install' }, context)
				).rejects.toMatchObject({
					code: 'cache_miss',
					recovery: `Run \`${build}\`, ${afterward}.`,
				});
			}
		);

		it('does not borrow a sibling app lane port in a monorepo', async () => {
			const { dependencies } = fixture();
			const { port } = simulatorWithApps([]);
			const handler = createAgentCommandRouter({
				...dependencies,
				simulator: port,
				lanes: buildLanes('/Users/dev/app/other'),
				nativePlan: plan('miss'),
			});
			const result = (await handler(
				{
					kind: 'native',
					operation: 'plan',
					configuration: 'Debug',
					worktreePath: '/Users/dev/app',
					udid: UDID,
				},
				context
			)) as Record<string, unknown>;
			expect(result.recommendation).toContain('launch=false');
			expect(result.recommendation).not.toContain('expo run:ios');
		});

		it.each([
			['ready', `expo run:ios --device ${UDID} --no-bundler`],
			// A stopped lane has given its port up; lane up claims it again.
			['stopped', 'Call lane with operation up'],
		] as const)(
			'advises at once for a lane whose Metro is %s',
			async (metro, advice) => {
				const { dependencies } = fixture();
				const { port } = simulatorWithApps([]);
				const handler = createAgentCommandRouter({
					...dependencies,
					simulator: port,
					lanes: buildLanes(undefined, metro),
					nativePlan: plan('miss'),
				});
				const result = (await handler(
					{
						kind: 'native',
						operation: 'plan',
						configuration: 'Debug',
						worktreePath: '/Users/dev/app',
						udid: UDID,
					},
					context
				)) as Record<string, unknown>;
				expect(String(result.recommendation)).toMatch(/^build: /);
				expect(result.recommendation).toContain(advice);
				if (metro === 'stopped')
					expect(result.recommendation).not.toContain('expo run:ios');
			}
		);

		describe('with a lane whose Metro is still starting', () => {
			// `lane up --launch=false` returns while a new lane is starting; the
			// lane service marks it ready only once the Metro answering on its
			// port is proven to be the lane's own.
			beforeEach(() => {
				vi.useFakeTimers();
			});
			afterEach(() => {
				vi.useRealTimers();
			});

			function planFor(
				lanes: ReturnType<typeof buildLanes>,
				{
					cache = 'miss',
					operation = 'plan',
					signal = context.signal,
				}: {
					cache?: 'hit' | 'miss';
					operation?: 'plan' | 'install';
					signal?: AbortSignal;
				} = {}
			) {
				const { dependencies } = fixture();
				const { port } = simulatorWithApps([]);
				const handler = createAgentCommandRouter({
					...dependencies,
					simulator: port,
					lanes,
					nativePlan: plan(cache),
				});
				const settled: { value?: unknown; error?: unknown; done: boolean } = {
					done: false,
				};
				const pending = handler(
					{
						kind: 'native',
						operation,
						configuration: 'Debug',
						worktreePath: '/Users/dev/app',
						udid: UDID,
					},
					{ ...context, signal }
				).then(
					(value) => {
						Object.assign(settled, { value, done: true });
					},
					(error: unknown) => {
						Object.assign(settled, { error, done: true });
					}
				);
				return { settled, pending };
			}

			it('waits for it to turn ready, then gives its build command', async () => {
				const lanes = buildLanes(undefined, 'starting');
				const { settled, pending } = planFor(lanes);
				await vi.advanceTimersByTimeAsync(4_000);
				expect(settled.done).toBe(false);
				lanes.setMetro('ready');
				// The next read of the lane state, one poll later, sees it.
				await vi.advanceTimersByTimeAsync(500);
				expect(settled.done).toBe(true);
				await pending;
				const recommendation = String(
					(settled.value as Record<string, unknown>).recommendation
				);
				expect(recommendation).toMatch(/^build: /);
				expect(recommendation).toContain(
					`expo run:ios --device ${UDID} --no-bundler`
				);
			});

			it('still gives the build command to one that turns ready after 12 s', async () => {
				// The lane service marks a lane ready on a reconcile, every 5 s,
				// and one that finds its Metro still loading leaves the lane
				// starting until the next.
				const lanes = buildLanes(undefined, 'starting');
				const { settled, pending } = planFor(lanes);
				await vi.advanceTimersByTimeAsync(12_000);
				expect(settled.done).toBe(false);
				lanes.setMetro('ready');
				await vi.advanceTimersByTimeAsync(500);
				expect(settled.done).toBe(true);
				await pending;
				expect(
					String((settled.value as Record<string, unknown>).recommendation)
				).toContain(`expo run:ios --device ${UDID} --no-bundler`);
			});

			it('holds the build command back from one that never turns ready', async () => {
				// A Metro the lane service could not prove is the lane's own (an
				// adoption that failed, a stop to retry) stays starting while
				// another packager may answer on the port. A lane whose PID is
				// some other process's now reads stopped instead.
				const { settled, pending } = planFor(buildLanes(undefined, 'starting'));
				// Nothing answers before the full 15 s, and the answer comes then.
				await vi.advanceTimersByTimeAsync(14_999);
				expect(settled.done).toBe(false);
				await vi.advanceTimersByTimeAsync(1);
				expect(settled.done).toBe(true);
				await pending;
				const recommendation = String(
					(settled.value as Record<string, unknown>).recommendation
				);
				expect(recommendation).toBe(
					`build: Metro for lane ${BUILD_LANE_ID} on port 8107 is not ready: it is still starting, or RN Devtools could not prove it is the lane's own, so the launch that follows a build would have no Metro of the lane's to open the app with. Call lane with operation ls for its error and operation log for its output, then call native with operation plan again.`
				);
				expect(vi.getTimerCount()).toBe(0);
			});

			it('gives the lane up advice once it stops while waited for', async () => {
				const lanes = buildLanes(undefined, 'starting');
				const { settled, pending } = planFor(lanes);
				await vi.advanceTimersByTimeAsync(2_000);
				lanes.setMetro('stopped');
				await vi.advanceTimersByTimeAsync(500);
				expect(settled.done).toBe(true);
				await pending;
				const recommendation = String(
					(settled.value as Record<string, unknown>).recommendation
				);
				expect(recommendation).toMatch(/^build: Call lane with operation up/);
				expect(recommendation).not.toContain('expo run:ios');
			});

			it('recovers an install on a cache miss with what the lane needs first', async () => {
				const { settled, pending } = planFor(
					buildLanes(undefined, 'starting'),
					{
						operation: 'install',
					}
				);
				await vi.advanceTimersByTimeAsync(14_999);
				expect(settled.done).toBe(false);
				await vi.advanceTimersByTimeAsync(1);
				expect(settled.done).toBe(true);
				await pending;
				expect(settled.error).toMatchObject({
					code: 'cache_miss',
					recovery: expect.stringMatching(
						new RegExp(
							`^Metro for lane ${BUILD_LANE_ID} on port 8107 is not ready`
						)
					),
				});
				expect((settled.error as AgentCliError).recovery).not.toContain(
					'expo run:ios'
				);
			});

			it('stops waiting when the request is cancelled', async () => {
				const request = new AbortController();
				const { settled, pending } = planFor(
					buildLanes(undefined, 'starting'),
					{
						signal: request.signal,
					}
				);
				await vi.advanceTimersByTimeAsync(1_000);
				request.abort();
				await vi.advanceTimersByTimeAsync(0);
				await pending;
				expect(settled.error).toMatchObject({ code: 'cancelled' });
				expect(vi.getTimerCount()).toBe(0);
			});

			it('does not wait for it on a cache hit', async () => {
				const { settled, pending } = planFor(
					buildLanes(undefined, 'starting'),
					{
						cache: 'hit',
					}
				);
				await vi.advanceTimersByTimeAsync(0);
				await pending;
				expect(settled.done).toBe(true);
				expect(
					String((settled.value as Record<string, unknown>).recommendation)
				).toMatch(/^install: /);
			});
		});

		it('plans with a device and reports installed state from the Simulator app list', async () => {
			const { dependencies } = fixture();
			const { port } = simulatorWithApps(['com.example.app']);
			const handler = createAgentCommandRouter({
				...dependencies,
				simulator: port,
				nativePlan: plan('hit'),
			});
			const result = (await handler(
				{
					kind: 'native',
					operation: 'plan',
					configuration: 'Debug',
					worktreePath: '/Users/dev/app',
					udid: UDID,
				},
				context
			)) as Record<string, unknown>;
			expect(result).toMatchObject({
				cache: 'hit',
				installed: true,
				simulatorUdid: UDID,
			});
			expect(String(result.recommendation)).toMatch(/^install: /);
		});

		it('recommends install on a cache hit that is not yet on the device', async () => {
			const { dependencies } = fixture();
			const { port } = simulatorWithApps([]);
			const handler = createAgentCommandRouter({
				...dependencies,
				simulator: port,
				nativePlan: plan('hit'),
			});
			const result = (await handler(
				{
					kind: 'native',
					operation: 'plan',
					configuration: 'Debug',
					worktreePath: '/Users/dev/app',
					udid: UDID,
				},
				context
			)) as Record<string, unknown>;
			expect(result).toMatchObject({ cache: 'hit', installed: false });
			expect(String(result.recommendation)).toMatch(/^install: /);
		});

		it.each([
			['hit', /^install: /],
			['miss', /^build: /],
		] as const)(
			'leaves installed out on a Simulator that is not booted, whatever it last listed (cache %s)',
			async (cache, verb) => {
				const { dependencies } = fixture();
				const { port, actions } = simulatorWithApps(['com.example.app'], {
					deviceState: 'shutdown',
				});
				const handler = createAgentCommandRouter({
					...dependencies,
					simulator: port,
					nativePlan: plan(cache),
				});
				const result = (await handler(
					{
						kind: 'native',
						operation: 'plan',
						configuration: 'Debug',
						worktreePath: '/Users/dev/app',
						udid: UDID,
					},
					context
				)) as Record<string, unknown>;
				expect(result).toMatchObject({ cache, simulatorUdid: UDID });
				expect(result).not.toHaveProperty('installed');
				const recommendation = String(result.recommendation);
				expect(recommendation).toMatch(verb);
				// The lane up that boots it names the app directory and the
				// Simulator, as the CLI requires, and reserves the lane without
				// launching an app that may not be installed.
				const unknown = ` installed is left out: this Simulator is shut down, and its apps can be listed only while it is booted (\`rndevtools lane --operation up --worktree /Users/dev/app --udid ${UDID} --launch=false\` boots it).`;
				expect(recommendation.slice(-unknown.length)).toBe(unknown);
				// A Simulator that is not booted has nothing to list.
				expect(actions).toHaveLength(0);
			}
		);

		it.each([
			['booting', 'still booting'],
			['shuttingDown', 'shutting down'],
			['creating', 'still being created'],
			['unknown', 'in an unknown state'],
		] as const)(
			'says in words why installed is left out on a Simulator that is %s',
			async (deviceState, words) => {
				const { dependencies } = fixture();
				const { port, actions } = simulatorWithApps(['com.example.app'], {
					deviceState,
				});
				const handler = createAgentCommandRouter({
					...dependencies,
					simulator: port,
					nativePlan: plan('hit'),
				});
				const result = (await handler(
					{
						kind: 'native',
						operation: 'plan',
						configuration: 'Debug',
						worktreePath: '/Users/dev/app',
						udid: UDID,
					},
					context
				)) as Record<string, unknown>;
				expect(result).not.toHaveProperty('installed');
				expect(String(result.recommendation)).toContain(
					` installed is left out: this Simulator is ${words}, and its apps can be listed only while it is booted`
				);
				expect(actions).toHaveLength(0);
			}
		);

		it("leaves installed out when listing a booted Simulator's apps fails", async () => {
			const { dependencies } = fixture();
			const { port, actions } = simulatorWithApps(['com.example.app'], {
				listFailure: 'simctl listapps timed out.\nRetry later.',
			});
			const handler = createAgentCommandRouter({
				...dependencies,
				simulator: port,
				nativePlan: plan('hit'),
			});
			const result = (await handler(
				{
					kind: 'native',
					operation: 'plan',
					configuration: 'Debug',
					worktreePath: '/Users/dev/app',
					udid: UDID,
				},
				context
			)) as Record<string, unknown>;
			expect(result).not.toHaveProperty('installed');
			const recommendation = String(result.recommendation);
			expect(recommendation).toMatch(/^install: /);
			expect(recommendation).toMatch(
				/ installed is left out: listing this Simulator's apps failed \(simctl listapps timed out\. Retry later\.\)\.$/
			);
			expect(actions.map(({ action }) => action.kind)).toEqual(['app.list']);
		});

		it('installs without listing the apps first, and fails as app.install does on a Simulator that is not booted', async () => {
			const { dependencies } = fixture();
			const { port, actions } = simulatorWithApps(['com.example.app'], {
				deviceState: 'shutdown',
			});
			const handler = createAgentCommandRouter({
				...dependencies,
				simulator: port,
				nativePlan: plan('hit'),
			});
			await expect(
				handler(
					{
						kind: 'native',
						operation: 'install',
						configuration: 'Debug',
						worktreePath: '/Users/dev/app',
						udid: UDID,
					},
					context
				)
			).rejects.toMatchObject({
				code: 'action_failed',
				message: 'Simulator must be booted for this action.',
			});
			expect(actions.map(({ action }) => action.kind)).toEqual(['app.install']);
		});

		it('installs the cached artifact through app.install with the artifact as the selected path', async () => {
			const { dependencies } = fixture();
			const { port, actions } = simulatorWithApps([]);
			const handler = createAgentCommandRouter({
				...dependencies,
				simulator: port,
				nativePlan: plan('hit'),
			});
			const result = (await handler(
				{
					kind: 'native',
					operation: 'install',
					configuration: 'Debug',
					worktreePath: '/Users/dev/app',
					udid: UDID,
				},
				context
			)) as Record<string, unknown>;
			expect(result).toMatchObject({
				action: 'installed-from-cache',
				installed: true,
			});
			const install = actions.find(
				({ action }) => action.kind === 'app.install'
			);
			expect(install?.context).toEqual({
				selectedPath:
					'/Users/dev/Library/Caches/rndevtools/native/x/ExampleApp.app',
			});
		});

		it('refuses to install on a miss and names the build command', async () => {
			const { dependencies } = fixture();
			const { port, actions } = simulatorWithApps([]);
			const handler = createAgentCommandRouter({
				...dependencies,
				simulator: port,
				nativePlan: plan('miss'),
			});
			await expect(
				handler(
					{
						kind: 'native',
						operation: 'install',
						configuration: 'Debug',
						worktreePath: '/Users/dev/app',
						udid: UDID,
					},
					context
				)
			).rejects.toEqual(
				expect.objectContaining<Partial<AgentCliError>>({
					code: 'cache_miss',
					recovery: expect.stringContaining('launch=false'),
				})
			);
			expect(actions.some(({ action }) => action.kind === 'app.install')).toBe(
				false
			);
		});

		it('refreshes the cached native build even when its bundle is already installed', async () => {
			const { dependencies } = fixture();
			const { port, actions } = simulatorWithApps(['com.example.app']);
			const handler = createAgentCommandRouter({
				...dependencies,
				simulator: port,
				nativePlan: plan('hit'),
			});
			const result = await handler(
				{
					kind: 'native',
					operation: 'install',
					configuration: 'Debug',
					worktreePath: '/Users/dev/app',
					udid: UDID,
				},
				context
			);
			expect(result).toMatchObject({ action: 'installed-from-cache' });
			expect(actions.some(({ action }) => action.kind === 'app.install')).toBe(
				true
			);
		});

		it('refuses to install on a device another session holds', async () => {
			const { dependencies } = fixture();
			const owner = { kind: 'claude' as const, sessionId: 'owner' };
			const { port, actions } = simulatorWithApps([]);
			const handler = createAgentCommandRouter({
				...dependencies,
				simulator: port,
				nativePlan: plan('hit'),
				agents: holdsOnlyAgents(owner),
			});
			const install = {
				kind: 'native' as const,
				operation: 'install' as const,
				configuration: 'Debug' as const,
				worktreePath: '/Users/dev/app',
				udid: UDID,
			};
			await expect(
				handler(install, {
					...context,
					agent: { kind: 'codex', sessionId: 'stranger' },
				})
			).rejects.toMatchObject({ code: 'device_held' });
			expect(actions.some(({ action }) => action.kind === 'app.install')).toBe(
				false
			);
			await expect(
				handler(install, { ...context, agent: owner })
			).resolves.toMatchObject({ action: 'installed-from-cache' });
		});
	});

	describe('agents, claims, and touches', () => {
		function agentsPort() {
			const touches: Array<{
				agent: { kind: string; sessionId: string };
				udid: string;
			}> = [];
			const operations: AgentOperation[] = [];
			const state: AgentState = {
				revision: 1,
				updatedAt: now,
				sessions: [
					{
						kind: 'claude',
						sessionId: 'claude-1',
						title: 'checkout',
						cwd: '/Users/dev/app',
						pid: 7,
					},
				],
				byDevice: {},
				claims: [],
				holds: {},
				discovery: { claude: 'ok', codex: 'unavailable' },
			};
			const port = {
				getState: () => state,
				refresh: async () => state,
				runOperation: async (operation: AgentOperation) => {
					operations.push(operation);
					if (operation.kind === 'agent.claim') {
						state.claims = [
							{
								simulatorUdid: operation.simulatorUdid,
								kind: operation.agent.kind,
								sessionId: operation.agent.sessionId,
								...(operation.note ? { note: operation.note } : {}),
								claimedAt: now,
							},
						];
						state.byDevice = {
							[operation.simulatorUdid]: [
								{
									kind: operation.agent.kind,
									sessionId: operation.agent.sessionId,
									title: 'checkout',
									via: 'claim',
									lastSeenAt: now,
									live: true,
								},
							],
						};
					}
					if (operation.kind === 'agent.release') {
						const { agent } = operation;
						state.claims = state.claims.filter(
							(claim) =>
								claim.simulatorUdid !== operation.simulatorUdid ||
								(agent !== undefined &&
									`${claim.kind}:${claim.sessionId}` !==
										`${agent.kind}:${agent.sessionId}`)
						);
						state.byDevice = {};
					}
					return state;
				},
				touch: (agent: { kind: string; sessionId: string }, udid: string) => {
					touches.push({ agent, udid });
				},
			};
			return { port, touches, operations };
		}
		const session = { kind: 'claude' as const, sessionId: 'claude-1' };

		it('lists sessions and per-device attachments', async () => {
			const { dependencies } = fixture();
			const { port } = agentsPort();
			const result = (await createAgentCommandRouter({
				...dependencies,
				agents: port,
			})({ kind: 'agents' }, { ...context, agent: session })) as Record<
				string,
				unknown
			>;
			expect(result).toMatchObject({
				sessions: [expect.objectContaining({ sessionId: 'claude-1' })],
				devices: [],
				you: session,
				discovery: { claude: 'ok', codex: 'unavailable' },
			});
		});

		it('claims and releases only as the session the CLI is running inside', async () => {
			const { dependencies } = fixture();
			const { port, operations } = agentsPort();
			const handler = createAgentCommandRouter({
				...dependencies,
				agents: port,
			});
			await expect(
				handler({ kind: 'claim', udid: UDID }, context)
			).rejects.toEqual(
				expect.objectContaining<Partial<AgentCliError>>({
					code: 'no_agent_session',
				})
			);
			const claimed = (await handler(
				{ kind: 'claim', udid: UDID.toLowerCase(), note: 'checkout flow' },
				{ ...context, agent: session }
			)) as Record<string, unknown>;
			expect(operations[0]).toEqual({
				kind: 'agent.claim',
				simulatorUdid: UDID,
				agent: session,
				note: 'checkout flow',
			});
			expect(claimed).toMatchObject({ udid: UDID, you: session });
			expect((claimed.agents as unknown[]).length).toBe(1);
			await handler(
				{ kind: 'release', udid: UDID },
				{ ...context, agent: session }
			);
			expect(operations[1]).toEqual({
				kind: 'agent.release',
				simulatorUdid: UDID,
				agent: session,
			});
		});

		it('refuses a claim on a device another session holds', async () => {
			const { dependencies } = fixture();
			const { port, operations } = agentsPort();
			const owner = { kind: 'codex' as const, sessionId: 'owner' };
			const handler = createAgentCommandRouter({
				...dependencies,
				agents: { ...port, access: heldBy(owner) },
			});
			await expect(
				handler({ kind: 'claim', udid: UDID }, { ...context, agent: session })
			).rejects.toMatchObject({
				code: 'device_held',
				message: expect.stringContaining('owner'),
			});
			expect(operations).toEqual([]);
			await handler(
				{ kind: 'claim', udid: UDID },
				{ ...context, agent: owner }
			);
			expect(operations).toEqual([
				{ kind: 'agent.claim', simulatorUdid: UDID, agent: owner },
			]);
		});

		it('gives a free device to only one of two sessions claiming it at once', async () => {
			const root = await mkdtemp(
				path.join(os.tmpdir(), 'rndevtools-router-claims-')
			);
			const agents = new AgentService({
				directory: root,
				lanes: () => [],
				discover: async () => ({ sessions: [], claude: 'ok', codex: 'ok' }),
				pollIntervalMs: 60_000,
				now: () => now,
			});
			try {
				await agents.start();
				const { dependencies } = fixture();
				const handler = createAgentCommandRouter({ ...dependencies, agents });
				const results = await Promise.allSettled([
					handler(
						{ kind: 'claim', udid: UDID },
						{ ...context, agent: session }
					),
					handler(
						{ kind: 'claim', udid: UDID },
						{ ...context, agent: { kind: 'codex', sessionId: 'codex-2' } }
					),
				]);
				expect(results.map((result) => result.status)).toEqual([
					'fulfilled',
					'rejected',
				]);
				expect(results[1]).toMatchObject({
					reason: { code: 'device_held' },
				});
				expect(
					agents.getState().claims.map((claim) => claim.sessionId)
				).toEqual(['claude-1']);
			} finally {
				await agents.stop();
				await rm(root, { recursive: true, force: true });
			}
		});

		it('release --all stops the lanes and drops the claims of the calling session only', async () => {
			const { dependencies } = fixture();
			const { port, operations } = agentsPort();
			const me = { kind: 'claude' as const, sessionId: 'claude-1' };
			const other = { kind: 'codex' as const, sessionId: 'codex-2' };
			port
				.getState()
				.claims.push(
					{ simulatorUdid: UDID, ...me, claimedAt: now },
					{ simulatorUdid: OTHER_UDID, ...other, claimedAt: now }
				);
			const laneOperations: LaneOperation[] = [];
			const lanes = {
				getState: () => ({
					revision: 1,
					updatedAt: now,
					environments: [...DEFAULT_LANE_ENVIRONMENTS],
					lanes: [
						{
							id: 'lane-11111111-2222-4333-8444-555555555555',
							worktreePath: '/Users/dev/mine',
							branch: 'mine',
							simulatorUdid: UDID,
							environment: 'development' as const,
							port: 8_100,
							metro: 'ready' as const,
							logPath: '/Users/dev/mine.log',
							startedAt: now,
							agent: { ...me, lastSeenAt: now },
						},
						{
							id: 'lane-22222222-2222-4333-8444-555555555555',
							worktreePath: '/Users/dev/theirs',
							branch: 'theirs',
							simulatorUdid: OTHER_UDID,
							environment: 'development' as const,
							port: 8_101,
							metro: 'ready' as const,
							logPath: '/Users/dev/theirs.log',
							startedAt: now,
							agent: { ...other, lastSeenAt: now },
						},
					],
					worktrees: [],
					repositories: [],
					deviceRequests: [],
				}),
				refresh: async () => lanes.getState(),
				runOperation: async (operation: LaneOperation) => {
					laneOperations.push(operation);
					return {
						actionId: operation.actionId,
						kind: operation.kind,
						completed: true,
						state: lanes.getState(),
					};
				},
			};
			const handler = createAgentCommandRouter({
				...dependencies,
				agents: port,
				lanes,
			});
			const result = (await handler(
				{ kind: 'release', all: true },
				{ ...context, agent: me }
			)) as {
				stoppedLanes: string[];
				releasedClaims: string[];
				errors: string[];
			};
			expect(result).toEqual({
				you: me,
				stoppedLanes: ['lane-11111111-2222-4333-8444-555555555555'],
				pendingLanes: [],
				releasedClaims: [UDID],
				errors: [],
			});
			expect(laneOperations).toEqual([
				expect.objectContaining({
					kind: 'lane.stop',
					laneId: 'lane-11111111-2222-4333-8444-555555555555',
				}),
			]);
			expect(operations).toEqual([
				{ kind: 'agent.release', simulatorUdid: UDID, agent: me },
			]);
			await expect(
				handler({ kind: 'release', all: true }, context)
			).rejects.toMatchObject({ code: 'no_agent_session' });
		});

		function releaseLane(
			n: number,
			worktreePath: string,
			agent: { kind: 'claude' | 'codex' | 'other'; sessionId: string }
		): Lane {
			return {
				id: `lane-${String(n).repeat(8)}-2222-4333-8444-555555555555`,
				worktreePath,
				branch: `feature-${n}`,
				simulatorUdid: `AAAAAAAA-0000-4000-8000-00000000000${n}`,
				environment: 'development',
				port: 8_100 + n,
				metro: 'ready',
				logPath: `${worktreePath}/lane.log`,
				startedAt: now,
				agent: { ...agent, lastSeenAt: now },
			};
		}

		/** A lane port whose stops remove the lane once `stop` settles. */
		function releaseLanes(
			initial: Lane[],
			stop: (
				laneId: string
			) => Promise<Partial<LaneOperationReceipt>> = async () => ({})
		) {
			let current = initial;
			const stops: Array<{ laneId: string; signal: AbortSignal }> = [];
			const state = (): LaneState => ({
				revision: 1,
				updatedAt: now,
				environments: [...DEFAULT_LANE_ENVIRONMENTS],
				lanes: current,
				worktrees: [],
				repositories: [],
				deviceRequests: [],
			});
			const port = {
				getState: state,
				refresh: async () => state(),
				runOperation: async (
					operation: LaneOperation,
					signal: AbortSignal
				): Promise<LaneOperationReceipt> => {
					if (operation.kind !== 'lane.stop') {
						throw new Error(`Unexpected ${operation.kind}.`);
					}
					stops.push({ laneId: operation.laneId, signal });
					const outcome = await stop(operation.laneId);
					if (outcome.completed !== false) {
						current = current.filter((lane) => lane.id !== operation.laneId);
					}
					return {
						actionId: operation.actionId,
						kind: operation.kind,
						completed: true,
						...outcome,
					};
				},
			};
			return { port, stops };
		}

		it('release --all reports failed stops as errors and slow ones as pending, within 2 s and detached from the request', async () => {
			const { dependencies } = fixture();
			const { port, operations } = agentsPort();
			const me = { kind: 'claude' as const, sessionId: 'claude-1' };
			port
				.getState()
				.claims.push({ simulatorUdid: UDID, ...me, claimedAt: now });
			const failed = releaseLane(1, '/Users/dev/app-a', me);
			const slow = releaseLane(2, '/Users/dev/app-b', me);
			const quick = releaseLane(3, '/Users/dev/app-c', me);
			let slowFinished = false;
			const { port: lanes, stops } = releaseLanes(
				[failed, slow, quick],
				async (laneId) => {
					if (laneId === failed.id) {
						return {
							completed: false,
							error: 'Metro on port 8101 did not stop.',
						};
					}
					if (laneId === slow.id) {
						await new Promise((resolve) => setTimeout(resolve, 5_000));
						slowFinished = true;
					}
					return {};
				}
			);
			const handler = createAgentCommandRouter({
				...dependencies,
				agents: port,
				lanes,
			});
			const request = new AbortController();
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			try {
				let result: unknown;
				const released = handler(
					{ kind: 'release', all: true },
					{ ...context, signal: request.signal, agent: me }
				).then((value) => {
					result = value;
				});
				// The session-end client hangs up; the stops carry on regardless.
				request.abort();
				await vi.advanceTimersByTimeAsync(1_999);
				expect(result).toEqual({
					you: me,
					stoppedLanes: [quick.id],
					pendingLanes: [slow.id],
					releasedClaims: [UDID],
					errors: [`lane ${failed.id}: Metro on port 8101 did not stop.`],
				});
				expect(stops.map((stop) => [stop.laneId, stop.signal.aborted])).toEqual(
					[
						[failed.id, false],
						[slow.id, false],
						[quick.id, false],
					]
				);
				expect(slowFinished).toBe(false);
				await vi.advanceTimersByTimeAsync(5_000);
				expect(slowFinished).toBe(true);
				expect(lanes.getState().lanes.map((lane) => lane.id)).toEqual([
					failed.id,
				]);
				await released;
			} finally {
				vi.useRealTimers();
			}
			expect(operations).toEqual([
				{ kind: 'agent.release', simulatorUdid: UDID, agent: me },
			]);
		});

		it('release --all matches a shared MCP identity’s lanes and claims only by sessionCwd', async () => {
			const { dependencies } = fixture();
			const { port, operations } = agentsPort();
			const thread = { kind: 'codex' as const, sessionId: 'thread-1' };
			const shared = {
				kind: 'codex' as const,
				sessionId: 'mcp-codex-mcp-client',
			};
			const inside = releaseLane(1, '/Users/dev/app-a', shared);
			const elsewhere = releaseLane(2, '/Users/dev/app-b', shared);
			const otherKind = releaseLane(3, '/Users/dev/app-a', {
				kind: 'claude',
				sessionId: 'mcp-claude-code',
			});
			const own = releaseLane(4, '/Users/dev/app-c', thread);
			const otherThread = releaseLane(5, '/Users/dev/app-a', {
				kind: 'codex',
				sessionId: 'thread-2',
			});
			const bareUdid = 'AAAAAAAA-0000-4000-8000-000000000006';
			const ownUdid = 'AAAAAAAA-0000-4000-8000-000000000007';
			port.getState().claims.push(
				// On the device of the shared lane the session works in.
				{ simulatorUdid: inside.simulatorUdid, ...shared, claimedAt: now },
				// No lane, so no directory to match: left to the hold clock.
				{ simulatorUdid: bareUdid, ...shared, claimedAt: now },
				{ simulatorUdid: ownUdid, ...thread, claimedAt: now }
			);
			const { port: lanes } = releaseLanes([
				inside,
				elsewhere,
				otherKind,
				own,
				otherThread,
			]);
			const handler = createAgentCommandRouter({
				...dependencies,
				agents: port,
				lanes,
			});

			// The session-end hook reports the thread's own id and where it worked.
			await expect(
				handler(
					{
						kind: 'release',
						all: true,
						sessionCwd: '/Users/dev/app-a/src/../src/',
					},
					{ ...context, agent: thread }
				)
			).resolves.toEqual({
				you: thread,
				stoppedLanes: [inside.id, own.id],
				pendingLanes: [],
				releasedClaims: [inside.simulatorUdid, ownUdid],
				errors: [],
			});
			expect(operations).toEqual([
				{
					kind: 'agent.release',
					simulatorUdid: inside.simulatorUdid,
					agent: shared,
				},
				{ kind: 'agent.release', simulatorUdid: ownUdid, agent: thread },
			]);

			// Over MCP the id itself says nothing about which session is asking.
			const unscoped = (await handler(
				{ kind: 'release', all: true },
				{ ...context, agent: shared }
			)) as Record<string, unknown>;
			expect(unscoped).toMatchObject({
				stoppedLanes: [],
				pendingLanes: [],
				releasedClaims: [],
				errors: [],
			});
			expect(unscoped.next).toMatch(/sessionCwd/);
			expect(unscoped.next).toMatch(/lane --operation down/);

			await expect(
				handler(
					{ kind: 'release', all: true, sessionCwd: '/Users/dev/app-b' },
					{ ...context, agent: shared }
				)
			).resolves.toMatchObject({ stoppedLanes: [elsewhere.id] });
			expect(lanes.getState().lanes.map((lane) => lane.id)).toEqual([
				otherKind.id,
				otherThread.id,
			]);
			expect(
				port.getState().claims.map((claim) => claim.simulatorUdid)
			).toEqual([bareUdid]);
		});

		it('release --all from a monorepo checkout root releases the shared identity’s app lanes in it', async () => {
			const { dependencies } = fixture();
			const { port } = agentsPort();
			const shared = {
				kind: 'codex' as const,
				sessionId: 'mcp-codex-mcp-client',
			};
			const app: Lane = {
				...releaseLane(1, '/Users/dev/repo', shared),
				appPath: '/Users/dev/repo/examples/expo-demo',
			};
			port.getState().claims.push({
				simulatorUdid: app.simulatorUdid,
				...shared,
				claimedAt: now,
			});
			const { port: lanes } = releaseLanes([app]);
			const handler = createAgentCommandRouter({
				...dependencies,
				agents: port,
				lanes,
			});
			await expect(
				handler(
					{ kind: 'release', all: true, sessionCwd: '/Users/dev/repo' },
					{ ...context, agent: shared }
				)
			).resolves.toMatchObject({
				stoppedLanes: [app.id],
				releasedClaims: [app.simulatorUdid],
				errors: [],
			});
		});

		it('release --all from inside one app of a checkout leaves the shared identity’s other app lanes running', async () => {
			const { dependencies } = fixture();
			const { port, operations } = agentsPort();
			const thread = { kind: 'codex' as const, sessionId: 'thread-mobile' };
			const shared = {
				kind: 'codex' as const,
				sessionId: 'mcp-codex-mcp-client',
			};
			const mobile: Lane = {
				...releaseLane(1, '/Users/dev/mono', shared),
				appPath: '/Users/dev/mono/apps/mobile',
			};
			const admin: Lane = {
				...releaseLane(2, '/Users/dev/mono', shared),
				appPath: '/Users/dev/mono/apps/admin',
			};
			port
				.getState()
				.claims.push(
					{ simulatorUdid: mobile.simulatorUdid, ...shared, claimedAt: now },
					{ simulatorUdid: admin.simulatorUdid, ...shared, claimedAt: now }
				);
			const { port: lanes } = releaseLanes([mobile, admin]);
			const handler = createAgentCommandRouter({
				...dependencies,
				agents: port,
				lanes,
			});
			const endIn = (sessionCwd: string) =>
				handler(
					{ kind: 'release', all: true, sessionCwd },
					{ ...context, agent: thread }
				);

			// The mobile session's end leaves the admin session's lane alone.
			await expect(endIn('/Users/dev/mono/apps/mobile/src')).resolves.toEqual({
				you: thread,
				stoppedLanes: [mobile.id],
				pendingLanes: [],
				releasedClaims: [mobile.simulatorUdid],
				errors: [],
			});
			// A session above the checkout worked in none of its lanes.
			await expect(endIn('/Users/dev')).resolves.toMatchObject({
				stoppedLanes: [],
				releasedClaims: [],
			});
			expect(lanes.getState().lanes.map((lane) => lane.id)).toEqual([admin.id]);
			// One at the checkout's root worked above every app lane in it.
			await expect(endIn('/Users/dev/mono')).resolves.toMatchObject({
				stoppedLanes: [admin.id],
				releasedClaims: [admin.simulatorUdid],
			});
			expect(operations).toEqual([
				{
					kind: 'agent.release',
					simulatorUdid: mobile.simulatorUdid,
					agent: shared,
				},
				{
					kind: 'agent.release',
					simulatorUdid: admin.simulatorUdid,
					agent: shared,
				},
			]);
		});

		it('records a touch for every device-targeted command that carried a session, after it succeeds', async () => {
			const { dependencies } = fixture();
			const { port, touches } = agentsPort();
			const handler = createAgentCommandRouter({
				...dependencies,
				agents: port,
			});
			// Simulator-targeted by UDID.
			await handler(
				{ kind: 'screen', target: { udid: UDID } },
				{ ...context, agent: session }
			);
			// Connected-app target resolves to the Simulator the session reported.
			await handler(
				{ kind: 'screen', target: { deviceId: 'rndevtools-demo-ios' } },
				{ ...context, agent: session }
			);
			// Fleet-wide commands and failed commands do not touch.
			await handler(
				{ kind: 'simulators', includeUnavailable: false },
				{ ...context, agent: session }
			);
			await expect(
				handler(
					{
						kind: 'screen',
						target: { udid: '00000000-0000-4000-8000-000000000000' },
					},
					{ ...context, agent: session }
				)
			).rejects.toBeTruthy();
			// No session, no touch.
			await handler({ kind: 'screen', target: { udid: UDID } }, context);
			expect(touches).toEqual([
				{ agent: session, udid: UDID },
				{ agent: session, udid: UDID },
			]);
		});
	});

	describe('native input', () => {
		it('delivers input to a booted Simulator through the port and records a touch', async () => {
			const { dependencies } = fixture();
			const sent: unknown[] = [];
			const touches: string[] = [];
			const handler = createAgentCommandRouter({
				...dependencies,
				simulatorInput: async (input) => {
					sent.push(input);
					return {
						udid: input.udid,
						kind: input.kind,
						messages: 2,
						elapsedMilliseconds: 150,
					};
				},
				agents: {
					getState: () => ({
						revision: 0,
						updatedAt: 0,
						sessions: [],
						byDevice: {},
						claims: [],
						holds: {},
						discovery: { claude: 'ok', codex: 'ok' },
					}),
					refresh: async () => ({
						revision: 0,
						updatedAt: 0,
						sessions: [],
						byDevice: {},
						claims: [],
						holds: {},
						discovery: { claude: 'ok', codex: 'ok' },
					}),
					runOperation: async () => {
						throw new Error('unused');
					},
					touch: (_agent, udid) => {
						touches.push(udid);
					},
				},
			});
			const result = await handler(
				{
					kind: 'input',
					input: {
						kind: 'tap',
						udid: UDID.toLowerCase(),
						x: 0.5,
						y: 0.5,
						holdMilliseconds: 40,
					},
				},
				{ ...context, agent: { kind: 'claude', sessionId: 'claude-1' } }
			);
			expect(result).toMatchObject({ kind: 'tap', messages: 2 });
			// The UDID is canonicalised from the inventory before it reaches the host.
			expect(sent).toEqual([
				{ kind: 'tap', udid: UDID, x: 0.5, y: 0.5, holdMilliseconds: 40 },
			]);
			expect(touches).toEqual([UDID]);
		});

		it('refuses input to an unknown or shut-down Simulator with typed errors', async () => {
			const { dependencies } = fixture();
			const handler = createAgentCommandRouter({
				...dependencies,
				simulatorInput: async () => {
					throw new Error('must not be called');
				},
			});
			await expect(
				handler(
					{
						kind: 'input',
						input: {
							kind: 'button',
							udid: '00000000-0000-4000-8000-000000000000',
							button: 'home',
						},
					},
					context
				)
			).rejects.toEqual(
				expect.objectContaining<Partial<AgentCliError>>({
					code: 'target_not_found',
				})
			);
			const shutdown = {
				...dependencies,
				simulator: {
					...dependencies.simulator,
					refresh: async () =>
						simulatorStateSchema.parse({
							...simulatorState(),
							devices: simulatorState().devices.map((d) => ({
								...d,
								state: 'shutdown',
							})),
						}),
				},
			};
			await expect(
				createAgentCommandRouter({
					...shutdown,
					simulatorInput: async () => {
						throw new Error('no');
					},
				})(
					{
						kind: 'input',
						input: { kind: 'button', udid: UDID, button: 'home' },
					},
					context
				)
			).rejects.toEqual(
				expect.objectContaining<Partial<AgentCliError>>({
					code: 'simulator_not_booted',
					// The CLI takes lane operations as flags, never positionally.
					recovery: `Boot it with \`rndevtools simulator --operation boot --udid ${UDID}\` when this session holds it (its lane's or its claim's), or start a lane on it with \`rndevtools lane --operation up --worktree <app directory> --udid ${UDID}\`, then retry.`,
				})
			);
		});

		it('maps a host failure to a typed, retryable error and reports a missing port', async () => {
			const { dependencies } = fixture();
			await expect(
				createAgentCommandRouter(dependencies)(
					{
						kind: 'input',
						input: { kind: 'button', udid: UDID, button: 'home' },
					},
					context
				)
			).rejects.toEqual(
				expect.objectContaining<Partial<AgentCliError>>({ code: 'unavailable' })
			);
			const failing = createAgentCommandRouter({
				...dependencies,
				simulatorInput: async () => {
					throw new NativeHostResponseError(
						'simulator_input_unavailable',
						'SimulatorKit missing',
						false
					);
				},
			});
			await expect(
				failing(
					{
						kind: 'input',
						input: { kind: 'button', udid: UDID, button: 'home' },
					},
					context
				)
			).rejects.toEqual(
				expect.objectContaining<Partial<AgentCliError>>({
					code: 'simulator_input_unavailable',
					retryable: true,
					recovery: expect.stringContaining('Xcode'),
				})
			);
		});
	});

	it('reports absent lane support with a typed recovery path', async () => {
		const { handler } = fixture();
		await expect(
			handler({ kind: 'lane', operation: 'ls' }, context)
		).rejects.toEqual(
			expect.objectContaining<Partial<AgentCliError>>({
				code: 'unavailable',
				recovery: expect.stringContaining('Update RN Devtools'),
			})
		);
	});

	it('refuses lane up, lane down, and input on a device another agent holds', async () => {
		const { dependencies } = fixture();
		const owner = { kind: 'claude' as const, sessionId: 'owner-session' };
		const stranger = { kind: 'codex' as const, sessionId: 'stranger-thread' };
		const lane: Lane = {
			id: 'lane-11111111-2222-4333-8444-555555555555',
			worktreePath: '/Users/dev/app-feature',
			branch: 'feature',
			simulatorUdid: UDID,
			environment: 'development',
			port: 8_100,
			metro: 'ready',
			logPath: '/Users/dev/lane.log',
			startedAt: now,
			agent: { ...owner, lastSeenAt: now },
		};
		const state: LaneState = {
			revision: 1,
			updatedAt: now,
			environments: [...DEFAULT_LANE_ENVIRONMENTS],
			lanes: [lane],
			worktrees: [],
			repositories: [],
			deviceRequests: [],
		};
		const operations: LaneOperation[] = [];
		const inputs: unknown[] = [];
		const access = (
			udid: string,
			requester?: { kind: string; sessionId: string }
		) =>
			!requester || requester.sessionId === owner.sessionId
				? ({ allowed: true } as const)
				: ({
						allowed: false,
						reason: `Simulator ${udid} is held by claude session owner-session through lane ${lane.id}.`,
						hold: {
							simulatorUdid: udid,
							via: 'lane' as const,
							laneId: lane.id,
							holder: owner,
							holderLive: true,
						},
					} as const);
		const handler = createAgentCommandRouter({
			...dependencies,
			lanes: {
				getState: () => state,
				refresh: async () => state,
				runOperation: async (operation: LaneOperation) => {
					operations.push(operation);
					return {
						actionId: operation.actionId,
						kind: operation.kind,
						completed: true,
						lane,
						state,
					};
				},
			},
			simulatorInput: async (input) => {
				inputs.push(input);
				return {
					udid: input.udid,
					kind: input.kind,
					messages: 2,
					elapsedMilliseconds: 10,
				};
			},
			agents: {
				getState: () => {
					throw new Error('unused');
				},
				refresh: async () => {
					throw new Error('unused');
				},
				runOperation: async () => {
					throw new Error('unused');
				},
				touch: () => undefined,
				access,
			},
		});
		const asStranger = { ...context, agent: stranger };
		const asOwner = { ...context, agent: owner };

		await expect(
			handler(
				{
					kind: 'lane',
					operation: 'up',
					worktreePath: '/Users/dev/app-other',
					udid: UDID.toLowerCase(),
				},
				asStranger
			)
		).rejects.toMatchObject({
			code: 'device_held',
			retryable: true,
			message: expect.stringContaining('owner-session'),
		});
		await expect(
			handler({ kind: 'lane', operation: 'down', laneId: lane.id }, asStranger)
		).rejects.toMatchObject({ code: 'device_held' });
		// A launch would make the stranger the lane's agent, so it is refused too.
		await expect(
			handler(
				{ kind: 'lane', operation: 'launch', laneId: lane.id, url: 'checkout' },
				asStranger
			)
		).rejects.toMatchObject({ code: 'device_held' });
		await expect(
			handler(
				{
					kind: 'input',
					input: { kind: 'button', udid: UDID, button: 'home' },
				},
				asStranger
			)
		).rejects.toMatchObject({ code: 'device_held' });
		expect(operations).toEqual([]);
		expect(inputs).toEqual([]);

		// The holder, and the operator (no agent on the request), get through.
		await handler(
			{ kind: 'lane', operation: 'launch', laneId: lane.id },
			asOwner
		);
		await handler(
			{ kind: 'lane', operation: 'down', laneId: lane.id },
			asOwner
		);
		await handler(
			{ kind: 'lane', operation: 'down', laneId: lane.id },
			context
		);
		await handler(
			{ kind: 'input', input: { kind: 'button', udid: UDID, button: 'home' } },
			asOwner
		);
		expect(operations.map((operation) => operation.kind)).toEqual([
			'lane.launch',
			'lane.stop',
			'lane.stop',
		]);
		expect(operations[0]).toMatchObject({ agent: owner });
		expect(inputs).toHaveLength(1);
	});

	it('records the envelope agent on lane up and launch, so a Codex MCP caller holds its own lane', async () => {
		const { dependencies } = fixture();
		const shared = {
			kind: 'codex' as const,
			sessionId: 'mcp-codex-mcp-client',
		};
		const laneId = 'lane-11111111-2222-4333-8444-555555555555';
		let current: Lane[] = [];
		const operations: LaneOperation[] = [];
		const state = (): LaneState => ({
			revision: 1,
			updatedAt: now,
			environments: [...DEFAULT_LANE_ENVIRONMENTS],
			lanes: current,
			worktrees: [],
			repositories: [],
			deviceRequests: [],
		});
		const unused = () => {
			throw new Error('unused');
		};
		const handler = createAgentCommandRouter({
			...dependencies,
			lanes: {
				getState: state,
				refresh: async () => state(),
				runOperation: async (operation: LaneOperation) => {
					operations.push(operation);
					if (operation.kind === 'lane.start') {
						current = [
							{
								id: laneId,
								worktreePath: operation.worktreePath,
								branch: 'feature',
								simulatorUdid: UDID,
								environment: 'development',
								port: 8_100,
								metro: 'ready',
								logPath: '/Users/dev/lane.log',
								startedAt: now,
								...(operation.agent
									? { agent: { ...operation.agent, lastSeenAt: now } }
									: {}),
							},
						];
					}
					if (operation.kind === 'lane.stop') current = [];
					return {
						actionId: operation.actionId,
						kind: operation.kind,
						completed: true,
						...(current[0] ? { lane: current[0] } : {}),
					};
				},
			},
			agents: {
				getState: unused,
				refresh: unused,
				runOperation: unused,
				touch: () => undefined,
				// The real hold rules over this lane state, with no live sessions.
				access: (udid, requester) =>
					decideDeviceAccess(
						resolveDeviceHolds({
							lanes: current,
							claims: [],
							liveSessionKeys: new Set(),
							missingSince: new Map(),
							now,
						}).get(udid.toUpperCase()),
						requester,
						now
					),
			},
			simulatorInput: async (input) => ({
				udid: input.udid,
				kind: input.kind,
				messages: 1,
				elapsedMilliseconds: 1,
			}),
		});
		const asCodex = { ...context, agent: shared };

		await handler(
			{ kind: 'lane', operation: 'up', worktreePath: '/Users/dev/app' },
			asCodex
		);
		expect(operations[0]).toMatchObject({ kind: 'lane.start', agent: shared });
		expect(current[0]?.agent).toMatchObject(shared);
		await handler({ kind: 'lane', operation: 'launch', laneId }, asCodex);
		expect(operations[1]).toMatchObject({ kind: 'lane.launch', agent: shared });
		await expect(
			handler(
				{
					kind: 'input',
					input: { kind: 'button', udid: UDID, button: 'home' },
				},
				asCodex
			)
		).resolves.toMatchObject({ kind: 'button' });
		await expect(
			handler(
				{ kind: 'lane', operation: 'launch', laneId },
				{ ...context, agent: { kind: 'claude', sessionId: 'claude-1' } }
			)
		).rejects.toMatchObject({ code: 'device_held' });
		await handler({ kind: 'lane', operation: 'down', laneId }, asCodex);

		// The command's own agent, filled from the session variables, still wins.
		await handler(
			{
				kind: 'lane',
				operation: 'up',
				worktreePath: '/Users/dev/app',
				agent: { kind: 'codex', sessionId: 'thread-1' },
			},
			asCodex
		);
		expect(operations.map((operation) => operation.kind)).toEqual([
			'lane.start',
			'lane.launch',
			'lane.stop',
			'lane.start',
		]);
		expect(operations[3]).toMatchObject({
			agent: { kind: 'codex', sessionId: 'thread-1' },
		});
	});

	it('lets lane up omit the udid: the lane service picks a device, and a parked request comes back with next steps', async () => {
		const { dependencies } = fixture();
		const stranger = { kind: 'codex' as const, sessionId: 'stranger-thread' };
		const deviceRequest = {
			id: 'device-request-1',
			status: 'pending' as const,
			requestedAt: now,
			updatedAt: now,
			message:
				'All 2 available Simulators are in use: 2 by lanes, 0 claimed by other sessions.',
			worktreePath: '/Users/dev/app-feature',
			branch: 'feature',
			environment: 'development',
			launch: true,
			agent: stranger,
		};
		const state: LaneState = {
			revision: 1,
			updatedAt: now,
			environments: [...DEFAULT_LANE_ENVIRONMENTS],
			lanes: [],
			worktrees: [],
			repositories: [],
			deviceRequests: [deviceRequest],
		};
		const operations: LaneOperation[] = [];
		let accessChecks = 0;
		const handler = createAgentCommandRouter({
			...dependencies,
			agents: {
				getState: () => {
					throw new Error('unused');
				},
				refresh: async () => {
					throw new Error('unused');
				},
				runOperation: async () => {
					throw new Error('unused');
				},
				touch: () => undefined,
				access: () => {
					accessChecks += 1;
					return { allowed: true };
				},
			},
			lanes: {
				getState: () => state,
				refresh: async () => state,
				runOperation: async (operation: LaneOperation) => {
					operations.push(operation);
					return {
						actionId: operation.actionId,
						kind: operation.kind,
						completed: true,
						deviceRequest,
						state,
					};
				},
			},
		});

		const result = (await handler(
			{ kind: 'lane', operation: 'up', worktreePath: '/Users/dev/app-feature' },
			{ ...context, agent: stranger }
		)) as { completed: boolean; deviceRequest?: unknown; next?: string };
		// No device named and no lane for the app yet, so nothing to check
		// ownership against.
		expect(accessChecks).toBe(0);
		expect(operations[0]).toMatchObject({
			kind: 'lane.start',
			worktreePath: '/Users/dev/app-feature',
		});
		expect(operations[0]).not.toHaveProperty('simulatorUdid');
		expect(result.completed).toBe(true);
		expect(result.deviceRequest).toMatchObject({
			id: 'device-request-1',
			status: 'pending',
		});
		expect(result.next).toMatch(/Poll lane --operation ls/);
		expect(result.next).toContain('device-request-1');

		// `ls` carries the requests so the agent can follow the outcome.
		await expect(
			handler({ kind: 'lane', operation: 'ls' }, context)
		).resolves.toMatchObject({ deviceRequests: [deviceRequest] });
	});

	it("checks the device of the app's existing lane on a lane up without a udid", async () => {
		const { dependencies } = fixture();
		const owner = { kind: 'claude' as const, sessionId: 'owner-session' };
		const stranger = { kind: 'codex' as const, sessionId: 'stranger-thread' };
		// One app of a monorepo worktree has a lane; the worktree root is another app.
		const lane: Lane = {
			id: 'lane-11111111-2222-4333-8444-555555555555',
			worktreePath: '/Users/dev/mono',
			appPath: '/Users/dev/mono/apps/mobile',
			branch: 'feature',
			simulatorUdid: UDID,
			environment: 'development',
			port: 8_100,
			metro: 'ready',
			logPath: '/Users/dev/lane.log',
			startedAt: now,
			agent: { ...owner, lastSeenAt: now },
		};
		const state: LaneState = {
			revision: 1,
			updatedAt: now,
			environments: [...DEFAULT_LANE_ENVIRONMENTS],
			lanes: [lane],
			worktrees: [],
			repositories: [],
			deviceRequests: [],
		};
		const operations: LaneOperation[] = [];
		const checked: string[] = [];
		const handler = createAgentCommandRouter({
			...dependencies,
			agents: {
				...holdsOnlyAgents(owner),
				access: (udid, requester) => {
					checked.push(udid);
					return heldBy(owner)(udid, requester);
				},
			},
			lanes: {
				getState: () => state,
				refresh: async () => state,
				runOperation: async (operation: LaneOperation) => {
					operations.push(operation);
					return {
						actionId: operation.actionId,
						kind: operation.kind,
						completed: true,
						lane,
						state,
					};
				},
			},
		});
		const up = (worktreePath: string) =>
			({ kind: 'lane', operation: 'up', worktreePath }) as const;

		// The lane service would resume the owner's lane, restarting its Metro,
		// so the stranger gets the typed refusal and its recovery rather than a
		// failed lane. The path matches however the lane service resolves it.
		await expect(
			handler(up('/Users/dev/mono/apps/mobile/'), {
				...context,
				agent: stranger,
			})
		).rejects.toMatchObject({
			code: 'device_held',
			retryable: true,
			message: expect.stringContaining('owner-session'),
			recovery: expect.stringContaining('find a free device'),
		});
		expect(checked).toEqual([UDID]);
		expect(operations).toEqual([]);

		// The holder and the operator resume it. Another app in the worktree has
		// no lane of its own, so there is no device to check: the lane service
		// picks a free one.
		await handler(up('/Users/dev/mono/apps/mobile'), {
			...context,
			agent: owner,
		});
		await handler(up('/Users/dev/mono/apps/mobile'), context);
		await handler(up('/Users/dev/mono'), { ...context, agent: stranger });
		expect(checked).toEqual([UDID, UDID]);
		expect(operations).toMatchObject([
			{ kind: 'lane.start', worktreePath: '/Users/dev/mono/apps/mobile' },
			{ kind: 'lane.start', worktreePath: '/Users/dev/mono/apps/mobile' },
			{ kind: 'lane.start', worktreePath: '/Users/dev/mono', agent: stranger },
		]);
		// The router never names the device; the lane service resumes the lane
		// wherever it runs.
		for (const operation of operations) {
			expect(operation).not.toHaveProperty('simulatorUdid');
		}
	});

	it('routes lane up/launch/down/log through the lane service and resolves worktree targets', async () => {
		const { dependencies } = fixture();
		const lane: Lane = {
			id: 'lane-11111111-2222-4333-8444-555555555555',
			worktreePath: '/Users/dev/app-feature',
			branch: 'feature',
			simulatorUdid: UDID,
			environment: 'development',
			port: 8_100,
			metroPid: 42,
			metro: 'ready',
			logPath: '/Users/dev/lane.log',
			scheme: 'exampleapp',
			startedAt: now,
		};
		let state: LaneState = {
			revision: 1,
			updatedAt: now,
			environments: [...DEFAULT_LANE_ENVIRONMENTS],
			lanes: [],
			worktrees: [],
			repositories: [],
			deviceRequests: [],
		};
		const operations: LaneOperation[] = [];
		const runOptions: unknown[] = [];
		const lanes = {
			getState: () => state,
			refresh: async () => state,
			runOperation: async (
				operation: LaneOperation,
				_signal?: AbortSignal,
				options?: unknown
			) => {
				operations.push(operation);
				runOptions.push(options);
				if (operation.kind === 'lane.start') {
					state = { ...state, lanes: [lane] };
					return {
						actionId: operation.actionId,
						kind: operation.kind,
						completed: true,
						lane,
						state,
					};
				}
				if (operation.kind === 'lane.log') {
					return {
						actionId: operation.actionId,
						kind: operation.kind,
						completed: true,
						lane,
						log: 'metro ready',
					};
				}
				if (operation.kind === 'lane.stop') {
					state = { ...state, lanes: [] };
					return {
						actionId: operation.actionId,
						kind: operation.kind,
						completed: true,
						state,
					};
				}
				return {
					actionId: operation.actionId,
					kind: operation.kind,
					completed: true,
					lane,
					state,
				};
			},
		};
		const handler = createAgentCommandRouter({ ...dependencies, lanes });

		const up = (await handler(
			{
				kind: 'lane',
				operation: 'up',
				worktreePath: '/Users/dev/app-feature',
				udid: UDID,
				slimProfileId: 'rndevtools-development',
				agent: { kind: 'claude', sessionId: 'session-1' },
			},
			context
		)) as { lane: Lane; completed: boolean };
		expect(up.completed).toBe(true);
		expect(up.lane.port).toBe(8_100);
		expect(operations[0]).toMatchObject({
			kind: 'lane.start',
			environment: 'development',
			launch: true,
			slimProfileId: 'rndevtools-development',
			agent: { kind: 'claude', sessionId: 'session-1' },
		});
		expect(operations[0]).not.toHaveProperty('state');
		// The unattended CLI may request slimming but can never approve it.
		expect(runOptions[0]).toBeUndefined();

		await expect(
			handler({ kind: 'lane', operation: 'ls' }, context)
		).resolves.toMatchObject({ lanes: [lane] });

		await handler(
			{
				kind: 'lane',
				operation: 'launch',
				worktreePath: '/Users/dev/app-feature',
				url: 'checkout',
			},
			context
		);
		expect(operations[1]).toMatchObject({
			kind: 'lane.launch',
			laneId: lane.id,
			url: 'checkout',
		});

		const log = (await handler(
			{ kind: 'lane', operation: 'log', laneId: lane.id },
			context
		)) as { log: string };
		expect(log.log).toBe('metro ready');

		await expect(
			handler({ kind: 'lane', operation: 'down', laneId: lane.id }, context)
		).resolves.toMatchObject({ completed: true, laneId: lane.id });
		await expect(
			handler({ kind: 'lane', operation: 'down', laneId: lane.id }, context)
		).rejects.toEqual(
			expect.objectContaining<Partial<AgentCliError>>({
				code: 'lane_not_found',
				recovery:
					'Run `rndevtools lane --operation ls` to see live lanes, or `rndevtools lane --operation up --worktree <app directory>` to start one.',
			})
		);
		// A lane named by its app directory gets the lane up for that directory.
		await expect(
			handler(
				{
					kind: 'lane',
					operation: 'log',
					worktreePath: '/Users/dev/app-feature',
				},
				context
			)
		).rejects.toEqual(
			expect.objectContaining<Partial<AgentCliError>>({
				code: 'lane_not_found',
				recovery:
					'Run `rndevtools lane --operation ls` to see live lanes, or `rndevtools lane --operation up --worktree /Users/dev/app-feature` to start one.',
			})
		);
	});

	it('surfaces a failed lane receipt as a retryable typed error', async () => {
		const { dependencies } = fixture();
		const lanes = {
			getState: () => ({
				revision: 1,
				updatedAt: now,
				environments: [...DEFAULT_LANE_ENVIRONMENTS],
				lanes: [],
				worktrees: [],
				repositories: [],
				deviceRequests: [],
			}),
			refresh: async () => ({
				revision: 1,
				updatedAt: now,
				environments: [...DEFAULT_LANE_ENVIRONMENTS],
				lanes: [],
				worktrees: [],
				repositories: [],
				deviceRequests: [],
			}),
			runOperation: async (operation: LaneOperation) => ({
				actionId: operation.actionId,
				kind: operation.kind,
				completed: false,
				error: 'Metro port 8100 is already in use.',
			}),
		};
		const handler = createAgentCommandRouter({ ...dependencies, lanes });
		await expect(
			handler(
				{
					kind: 'lane',
					operation: 'up',
					worktreePath: '/Users/dev/app',
					udid: UDID,
					preferredPort: 8_100,
				},
				context
			)
		).rejects.toEqual(
			expect.objectContaining<Partial<AgentCliError>>({
				code: 'lane_failed',
				message: 'Metro port 8100 is already in use.',
				retryable: true,
			})
		);
	});

	describe('lane restarts and failed launches', () => {
		const lane: Lane = {
			id: 'lane-11111111-2222-4333-8444-555555555555',
			worktreePath: '/Users/dev/app-feature',
			branch: 'feature',
			simulatorUdid: UDID,
			environment: 'development',
			port: 8_100,
			metroPid: 42,
			metro: 'starting',
			logPath: '/Users/dev/lane.log',
			scheme: 'exampleapp',
			bundleIdentifier: 'com.example.app',
			startedAt: now,
		};
		const state: LaneState = {
			revision: 1,
			updatedAt: now,
			environments: [...DEFAULT_LANE_ENVIRONMENTS],
			lanes: [lane],
			worktrees: [],
			repositories: [],
			deviceRequests: [],
		};

		/** A lane service that answers every operation with `outcome`. */
		function lanesAnswering(
			outcome: Omit<LaneOperationReceipt, 'actionId' | 'kind'>
		) {
			const operations: LaneOperation[] = [];
			return {
				operations,
				lanes: {
					getState: () => state,
					refresh: async () => state,
					runOperation: async (
						operation: LaneOperation
					): Promise<LaneOperationReceipt> => {
						operations.push(operation);
						return {
							actionId: operation.actionId,
							kind: operation.kind,
							...outcome,
						};
					},
				},
			};
		}

		it('passes restart to lane up and launch only when the caller asks', async () => {
			const { dependencies } = fixture();
			const { lanes, operations } = lanesAnswering({ completed: true, lane });
			const handler = createAgentCommandRouter({ ...dependencies, lanes });
			const up = {
				kind: 'lane',
				operation: 'up',
				worktreePath: '/Users/dev/app-feature',
			} as const;
			const launch = {
				kind: 'lane',
				operation: 'launch',
				laneId: lane.id,
			} as const;
			await handler({ ...up, restart: true }, context);
			await handler(up, context);
			await handler({ ...up, restart: false }, context);
			await handler({ ...launch, url: 'checkout', restart: true }, context);
			await handler({ ...launch, url: 'checkout' }, context);
			expect(operations[0]).toMatchObject({
				kind: 'lane.start',
				restart: true,
			});
			expect(operations[1]).not.toHaveProperty('restart');
			expect(operations[2]).not.toHaveProperty('restart');
			expect(operations[3]).toMatchObject({
				kind: 'lane.launch',
				laneId: lane.id,
				url: 'checkout',
				restart: true,
			});
			expect(operations[4]).not.toHaveProperty('restart');
		});

		it('hands lane up and launch what their launch could not do unasked', async () => {
			const { dependencies } = fixture();
			const warning =
				"com.example.app could not be terminated before the lane's first launch (xcrun failed with exit code 1.). If a copy was already running, it stays registered as a debug target on the Metro it came from; run `rndevtools lane --operation launch --lane-id lane-11111111-2222-4333-8444-555555555555 --restart` to start it fresh.";
			const { lanes } = lanesAnswering({
				completed: true,
				lane,
				warnings: [warning],
			});
			const handler = createAgentCommandRouter({ ...dependencies, lanes });
			for (const command of [
				{
					kind: 'lane',
					operation: 'up',
					worktreePath: '/Users/dev/app-feature',
				},
				{ kind: 'lane', operation: 'launch', laneId: lane.id },
			] as const) {
				expect(await handler(command, context)).toMatchObject({
					completed: true,
					warnings: [warning],
				});
			}
		});

		/** The typed error a lane command fails with when the lane service answers `outcome`. */
		function failure(
			outcome: Omit<LaneOperationReceipt, 'actionId' | 'kind'>,
			command: AgentCliCommand
		): Promise<AgentCliError> {
			const { dependencies } = fixture();
			const { lanes } = lanesAnswering(outcome);
			const handler = createAgentCommandRouter({ ...dependencies, lanes });
			return handler(command, context).then(
				() => {
					throw new Error('the lane command should have failed');
				},
				(rejected: unknown) => rejected as AgentCliError
			);
		}

		const timedOut =
			"Metro on port 8100 did not become ready within 15s. Read the lane's log for the bundler error.";
		const exited =
			"Metro for feature exited before it became ready. Read the lane's log for the bundler error.";
		const upCommand = {
			kind: 'lane',
			operation: 'up',
			worktreePath: '/Users/dev/app-feature',
			udid: UDID,
		} as const;
		const launchCommand = {
			kind: 'lane',
			operation: 'launch',
			worktreePath: '/Users/dev/app-feature',
		} as const;
		// Like a first lane up, the retry leaves the udid out: lane up for the
		// worktree resumes its lane on whichever Simulator the lane runs on.
		const upAgain =
			'rndevtools lane --operation up --worktree /Users/dev/app-feature';
		const launchAgain = `rndevtools lane --operation launch --lane-id ${lane.id}`;
		const log = `\`rndevtools lane --operation log --lane-id ${lane.id}\` shows Metro's output.`;

		it('retries a lane up that failed to launch as itself, which starts an exited Metro again', async () => {
			const up = await failure(
				{ completed: false, error: timedOut, lane },
				upCommand
			);
			expect(up).toMatchObject({
				code: 'lane_failed',
				retryable: true,
				message: `Lane ${lane.id} did not launch: ${timedOut}`,
			});
			expect(up.recovery).toBe(
				`The lane keeps its Simulator and port 8100. Once the cause is fixed, run \`${upAgain}\` to launch it again; it starts Metro again first if Metro exited. ${log}`
			);
			const restarted = await failure(
				{ completed: false, error: timedOut, lane },
				{ ...upCommand, restart: true }
			);
			expect(restarted.recovery).toContain(
				`run \`${upAgain} --restart\` to launch it again`
			);
			// The same command fits a lane whose Metro exited.
			const dead = await failure(
				{
					completed: false,
					error: exited,
					lane: { ...lane, metro: 'stopped' },
				},
				upCommand
			);
			expect(dead.message).toBe(`Lane ${lane.id} did not launch: ${exited}`);
			expect(dead.recovery).toContain(`run \`${upAgain}\` to launch it again`);
		});

		it('retries a lane launch as itself while its Metro runs, and through lane up once Metro exited', async () => {
			const linked = await failure(
				{ completed: false, error: timedOut, lane },
				{ ...launchCommand, url: 'checkout', restart: true }
			);
			expect(linked.message).toBe(
				`Lane ${lane.id} did not launch: ${timedOut}`
			);
			expect(linked.recovery).toBe(
				`The lane keeps its Simulator and its Metro on port 8100. Once the cause is fixed, run \`${launchAgain} --restart\` with the same --url to open it again. ${log}`
			);

			// lane launch never starts Metro, so retrying it would fail at once.
			const stopped = { ...lane, metro: 'stopped' as const };
			const dead = await failure(
				{ completed: false, error: exited, lane: stopped },
				launchCommand
			);
			expect(dead.message).toBe(`Lane ${lane.id} did not launch: ${exited}`);
			expect(dead.recovery).toBe(
				`Metro for lane ${lane.id} is not running, and the launch operation does not start it. Once the cause is fixed, run \`${upAgain}\` to start Metro again and open the dev client. ${log}`
			);
			// lane up opens the dev client and restarts the app, so only the
			// deep link is left for a lane launch after it.
			const deadLink = await failure(
				{ completed: false, error: exited, lane: stopped },
				{ ...launchCommand, url: 'checkout', restart: true }
			);
			expect(deadLink.recovery).toContain(
				`run \`${upAgain} --restart\` to start Metro again and open the dev client, then \`${launchAgain}\` with the same --url.`
			);
		});

		it("retries a lane outside the default environment, for an app inside a monorepo, on the lane's own terms", async () => {
			const nested = {
				...lane,
				appPath: '/Users/dev/app-feature/apps/mobile',
				environment: 'staging',
				port: 8_200,
			};
			const up = await failure(
				{ completed: false, error: timedOut, lane: nested },
				upCommand
			);
			expect(up.recovery).toContain(
				'run `rndevtools lane --operation up --worktree /Users/dev/app-feature/apps/mobile --environment staging` to launch it again'
			);
			expect(up.recovery).toContain('keeps its Simulator and port 8200');
			// A path a shell would split or expand stays one word.
			const spaced = {
				...lane,
				worktreePath: "/Users/dev/Example App's $HOME",
			};
			const quoted = await failure(
				{ completed: false, error: timedOut, lane: spaced },
				upCommand
			);
			expect(quoted.recovery).toContain(
				"run `rndevtools lane --operation up --worktree '/Users/dev/Example App'\\''s $HOME'` to launch it again"
			);
		});

		it('reports a cancelled launch as cancelled, still naming the lane', async () => {
			const cancelled = await failure(
				{
					completed: false,
					cancelled: true,
					error: 'Lane operation cancelled.',
					lane,
				},
				upCommand
			);
			expect(cancelled).toMatchObject({
				code: 'cancelled',
				retryable: true,
				message: `Lane ${lane.id} did not launch: Lane operation cancelled.`,
			});
			expect(cancelled.recovery).toBe(
				`The lane keeps its Simulator and port 8100. Run \`${upAgain}\` to launch it again; it starts Metro again first if Metro exited. ${log}`
			);
			// A cancel before any lane was stored stays a plain cancel.
			const early = await failure(
				{
					completed: false,
					cancelled: true,
					error: 'Lane operation cancelled.',
				},
				upCommand
			);
			expect(early).toMatchObject({
				code: 'cancelled',
				message: 'Lane operation cancelled.',
			});
			expect(early.recovery).toBeUndefined();
		});

		it('reports a launch the desktop stopped at its deadline as timed out, still naming the lane', async () => {
			const timed = await failure(
				{
					completed: false,
					timedOut: true,
					error: 'Lane operation timed out.',
					lane,
				},
				upCommand
			);
			expect(timed).toMatchObject({
				code: 'timed_out',
				retryable: true,
				message: `Lane ${lane.id} did not launch: Lane operation timed out.`,
			});
			expect(timed.recovery).toBe(
				`The lane keeps its Simulator and port 8100. Run \`${upAgain}\` to launch it again; it starts Metro again first if Metro exited. ${log}`
			);
			// One that timed out before any lane was stored is a plain timeout.
			const early = await failure(
				{
					completed: false,
					timedOut: true,
					error: 'Lane operation timed out.',
				},
				upCommand
			);
			expect(early).toMatchObject({
				code: 'timed_out',
				message: 'Lane operation timed out.',
			});
		});

		it('names the lane whose required backend stopped its launch, and sends lane launch to lane up', async () => {
			const backend: NonNullable<LaneOperationReceipt['backend']> = {
				policy: 'required',
				status: 'failed',
				reason: 'failed',
				appEnvNames: [],
				warnings: [],
				reasonText:
					'Run `rndevtools lane --operation up --worktree <app directory>` to recover this lane before launching.',
			};
			const error =
				'This lane requires its local backend, which is failed (failed). Run `rndevtools lane --operation up --worktree <app directory>` to recover this lane before launching.';
			const up = await failure(
				{ completed: false, error, lane, backend },
				upCommand
			);
			expect(up).toMatchObject({
				code: 'lane_failed',
				message: `Lane ${lane.id} did not launch: ${error}`,
				recovery: expect.stringContaining('backend auto'),
			});
			const launch = await failure(
				{ completed: false, error, lane, backend },
				launchCommand
			);
			expect(launch.message).toBe(`Lane ${lane.id} did not launch: ${error}`);
			expect(launch.recovery).toBe(
				`Lane ${lane.id} requires its local backend, and the launch operation does not start it. Once the cause is fixed, run \`${upAgain}\` to start the backend and open the dev client. ${log}`
			);
		});

		it('retries a lane up without launch that failed on its resumed lane as itself', async () => {
			// A lane up resuming a stored lane names it when its Simulator boot,
			// slim, backend or Metro fails, before any launch.
			const resumed = await failure(
				{ completed: false, error: 'CoreSimulator refused to boot.', lane },
				{ ...upCommand, launch: false }
			);
			expect(resumed).toMatchObject({
				code: 'lane_failed',
				retryable: true,
				message: `Lane ${lane.id} did not start: CoreSimulator refused to boot.`,
			});
			// The retry keeps launch=false: the caller did not ask for the app.
			expect(resumed.recovery).toBe(
				`The lane keeps its Simulator and port 8100. Once the cause is fixed, run \`${upAgain} --launch=false\` to start it again; it starts Metro again first if Metro exited. ${log}`
			);
		});

		it('sends a lane with no URL scheme to a launch with a full URL, which lane up cannot take', async () => {
			const { scheme: _scheme, ...bare } = lane;
			const error = `Lane ${lane.id} has no URL scheme: the worktree's app.json gave none when the lane started, so its dev client has no launch URL. Open it with \`${launchAgain} --url <full launch URL>\`; the up operation takes no URL.`;
			const url =
				"'<scheme>://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8100&disableOnboarding=1&disableAutoLaunch=1'";
			const recovery = `Lane ${lane.id} has no URL scheme for its dev client: the worktree's app.json gave none when the lane started, and a lane keeps what it started with. Only a launch with a full URL opens it: \`${launchAgain} --url ${url}\`, with <scheme> the URL scheme the app registers. Or declare a scheme in app.json and replace the lane: \`rndevtools lane --operation down --lane-id ${lane.id}\`, then \`${upAgain}\`. ${log}`;
			const up = await failure(
				{ completed: false, error, lane: bare },
				upCommand
			);
			expect(up.message).toBe(`Lane ${lane.id} did not launch: ${error}`);
			expect(up.recovery).toBe(recovery);
			const launched = await failure(
				{ completed: false, error, lane: bare },
				launchCommand
			);
			expect(launched.recovery).toBe(recovery);
			// A restart asked for goes with that launch.
			const restarted = await failure(
				{ completed: false, error, lane: bare },
				{ ...upCommand, restart: true }
			);
			expect(restarted.recovery).toContain(
				`\`${launchAgain} --url ${url} --restart\``
			);
			// A Metro that is gone comes back from a lane up that launches nothing.
			const stopped = await failure(
				{
					completed: false,
					error: exited,
					lane: { ...bare, metro: 'stopped' },
				},
				launchCommand
			);
			expect(stopped.recovery).toContain(
				`Only a launch with a full URL opens it, once \`${upAgain} --launch=false\` has started Metro again: \`${launchAgain} --url ${url}\``
			);
			// A deep link of its own needs no scheme, and is retried as before.
			const linked = await failure(
				{ completed: false, error: timedOut, lane: bare },
				{ ...launchCommand, url: 'exampleapp://checkout' }
			);
			expect(linked.recovery).toContain(
				`run \`${launchAgain}\` with the same --url to open it again`
			);
		});

		it('keeps a failure that names no lane as it was', async () => {
			const refused = await failure(
				{ completed: false, error: 'CoreSimulator refused to boot.' },
				upCommand
			);
			expect(refused).toMatchObject({
				code: 'lane_failed',
				message: 'CoreSimulator refused to boot.',
				retryable: true,
			});
			expect(refused.recovery).toBeUndefined();
		});
	});

	describe('local Supabase', () => {
		const STACK_ID = SUPABASE_DEMO_IDS.featCheckout;
		const WORKTREE = '/Users/dev/example-app-wt/feat-checkout';
		const claude = { kind: 'claude' as const, sessionId: 'claude-1' };
		const sharedCodex = {
			kind: 'codex' as const,
			sessionId: 'mcp-codex-mcp-client',
		};
		const STACK: SupabaseAgentStack = {
			id: STACK_ID,
			status: 'ready',
			origin: 'managed',
			mode: 'managed',
			runtime: 'native',
			exposure: 'loopback',
			branchContext: 'refs/heads/feat-checkout',
			worktreePath: WORKTREE,
			projectRoot: WORKTREE,
			apiPort: 21_734,
			dbPort: 21_735,
			laneIds: [],
			holders: [{ holder: 'session', agent: claude, live: true }],
			yours: true,
			cli: { version: '2.121.0', gate: 'verified', run: 'pnpm exec supabase' },
		};
		// Placeholder values in the shapes the contract allows; not real keys.
		const ENV = {
			API_URL: 'http://127.0.0.1:21734',
			REST_URL: 'http://127.0.0.1:21734/rest/v1',
			PUBLISHABLE_KEY: 'sb_publishable_EXAMPLEKEY000',
			ANON_KEY: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.ZXhhbXBsZQ',
		};
		const DOCTOR: SupabaseDoctorInfo = {
			enabled: true,
			capability: 'ready',
			platform: { supported: true, arch: 'arm64', macosVersion: '15.1' },
			repositories: [
				{
					label: '~/code/example-app',
					mode: 'managed',
					cli: { version: '2.121.0', gate: 'verified' },
				},
				{
					label: '~/code/example-admin',
					mode: 'observed',
					cli: { version: '2.122.0', gate: 'unsupported' },
				},
			],
			running: 2,
			cap: 12,
			sysv: { used: 6, limit: 32 },
			containerEngine: { docker: 'absent', podman: 'absent' },
			stats: {
				starts: 4,
				failures: 1,
				failuresByCode: { cli_mismatch: 1 },
				p50Ms: 4_500,
				p95Ms: 6_300,
			},
			warnings: [],
		};

		function resultFor(operation: SupabaseAgentOperation): SupabaseAgentResult {
			switch (operation.operation) {
				case 'up':
					return {
						operation: 'up',
						stack: STACK,
						appEnv: [
							'EXPO_PUBLIC_SUPABASE_URL',
							'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
						],
						metro: 'no-lane',
						cli: {
							run: 'pnpm exec supabase',
							workdir: WORKTREE,
							version: '2.121.0',
						},
						next: 'Run `pnpm exec supabase migration up --local` from the worktree.',
						warnings: ['shared-default-keys'],
					};
				case 'down':
					return {
						operation: 'down',
						stackId: STACK_ID,
						released: true,
						stopping: true,
						keptBy: [],
						next: 'It stops in 60 s unless someone holds it again.',
					};
				case 'ls':
					return { operation: 'ls', stacks: [STACK] };
				case 'status':
					return {
						operation: 'status',
						stack: STACK,
						services: [
							{ service: 'database', state: 'running', health: 'healthy' },
						],
						checkedAt: now,
					};
				case 'env':
					return { operation: 'env', stackId: STACK_ID, env: ENV };
				case 'reset':
					return {
						operation: 'reset',
						stackId: STACK_ID,
						status: 'complete',
						seed: operation.seed,
						next: 'The local database was reset.',
					};
				case 'log':
					return {
						operation: 'log',
						stackId: STACK_ID,
						records: [],
						truncated: false,
					};
				case 'destroy':
					return {
						operation: 'destroy',
						stackId: STACK_ID,
						requestId: SUPABASE_DEMO_IDS.requestOldUi,
						status: 'pending',
						expiresAt: now + 600_000,
						next: 'The user decides in RN Devtools.',
					};
			}
		}

		function supabaseFake(state = createSupabaseDemoState({ now })) {
			const calls: Array<{
				operation: SupabaseAgentOperation;
				context: SupabaseAgentContext;
				signal: AbortSignal;
			}> = [];
			const releases: Array<Parameters<AgentSupabasePort['releaseHolder']>[0]> =
				[];
			const waits: Array<{ jobId: string; timeoutMs: number }> = [];
			const fake = {
				state: state as SupabaseState,
				answer: async (operation: SupabaseAgentOperation): Promise<unknown> =>
					resultFor(operation),
				release: async (): Promise<SupabaseReleaseResult> => ({
					releasedStackIds: [],
					pendingStops: [],
				}),
				doctor: (): SupabaseDoctorInfo => DOCTOR,
			};
			const port: AgentSupabasePort = {
				getState: () => fake.state,
				runAgentOperation: async (operation, context, signal) => {
					calls.push({ operation, context, signal });
					return (await fake.answer(operation)) as SupabaseAgentResult;
				},
				releaseHolder: (input) => {
					releases.push(input);
					return fake.release();
				},
				job: (jobId) => fake.state.jobs.find((job) => job.id === jobId),
				waitForJob: async (jobId, timeoutMs) => {
					waits.push({ jobId, timeoutMs });
					return fake.state.jobs.find((job) => job.id === jobId);
				},
				doctor: () => fake.doctor(),
			};
			return { port, fake, calls, releases, waits };
		}

		function agentsWith(sessions: AgentState['sessions']) {
			const state: AgentState = {
				revision: 1,
				updatedAt: now,
				sessions,
				byDevice: {},
				claims: [],
				holds: {},
				discovery: { claude: 'ok', codex: 'ok' },
			};
			return {
				getState: () => state,
				refresh: async () => state,
				runOperation: async () => state,
				touch: () => undefined,
			};
		}

		it('reports absent local Supabase with a typed recovery path', async () => {
			const { handler } = fixture();
			const jobId = SUPABASE_DEMO_IDS.jobFixAuth;
			for (const command of [
				{ kind: 'supabase', operation: 'ls' },
				{ kind: 'wait', condition: { kind: 'job', jobId }, timeoutMs: 1_000 },
				{ kind: 'jobs', operation: 'get', jobId },
			] as const) {
				await expect(handler(command, context)).rejects.toMatchObject({
					code: 'unavailable',
					recovery: 'Update RN Devtools and retry.',
				});
			}
			expect(await handler({ kind: 'doctor' }, context)).not.toHaveProperty(
				'supabase'
			);
		});

		it('runs the contract operation with the envelope identity and returns the checked result', async () => {
			const { dependencies } = fixture();
			const { port, calls } = supabaseFake();
			const handler = createAgentCommandRouter({
				...dependencies,
				supabase: port,
				agents: agentsWith([
					{
						kind: 'claude',
						sessionId: 'claude-1',
						title: 'checkout',
						cwd: `${WORKTREE}/apps/mobile`,
					},
					{
						kind: 'codex',
						sessionId: 'thread-9',
						title: 'payments',
						cwd: '/Users/dev/example-app-wt/feat-payments',
					},
				]),
			});
			const signal = new AbortController().signal;
			const up = {
				operation: 'up',
				target: { worktreePath: WORKTREE },
				waitMs: 30_000,
			} as const;
			await expect(
				handler(
					{ kind: 'supabase', operation: 'up', worktreePath: WORKTREE },
					{ ...context, signal, agent: claude }
				)
			).resolves.toEqual(resultFor(up));
			expect(calls[0]).toEqual({
				operation: up,
				context: {
					requestId: context.requestId,
					synthetic: false,
					holder: claude,
					sessionCwd: `${WORKTREE}/apps/mobile`,
				},
				signal,
			});

			// The contract's defaults (seed on, 200 lines); a stack id prefix
			// passes through for the service to resolve.
			await handler(
				{
					kind: 'supabase',
					operation: 'reset',
					stackId: STACK_ID.slice(0, 8),
					note: 'Start over.',
				},
				{ ...context, agent: claude }
			);
			await handler(
				{
					kind: 'supabase',
					operation: 'log',
					worktreePath: WORKTREE,
					services: ['gateway'],
					since: '10m',
				},
				{ ...context, agent: claude }
			);
			expect(calls.slice(1).map((call) => call.operation)).toEqual([
				{
					operation: 'reset',
					target: { stackId: STACK_ID.slice(0, 8) },
					seed: true,
					// Kept for the request card when another session holds it.
					note: 'Start over.',
				},
				{
					operation: 'log',
					target: { worktreePath: WORKTREE },
					tail: 200,
					services: ['gateway'],
					since: '10m',
				},
			]);

			// A shared MCP identity is matched by worktree, so it carries no
			// session directory even while one of its sessions is discovered.
			await handler(
				{ kind: 'supabase', operation: 'down', worktreePath: WORKTREE },
				{ ...context, agent: sharedCodex }
			);
			expect(calls[3]?.context).toEqual({
				requestId: context.requestId,
				synthetic: true,
				holder: sharedCodex,
			});
			// No session on the envelope: the operator's own CLI.
			await expect(
				handler({ kind: 'supabase', operation: 'ls' }, context)
			).resolves.toEqual({ operation: 'ls', stacks: [STACK] });
			expect(calls[4]?.context).toEqual({
				requestId: context.requestId,
				synthetic: false,
			});
		});

		it('refuses while local Supabase is off, unsupported, or unreadable, and never suggests Docker', async () => {
			const { dependencies } = fixture();
			const { port, fake, calls } = supabaseFake(
				createSupabaseDemoState({ now, variant: 'off' })
			);
			const handler = createAgentCommandRouter({
				...dependencies,
				supabase: port,
			});
			const up = {
				kind: 'supabase',
				operation: 'up',
				worktreePath: WORKTREE,
			} as const;
			const off = await handler(up, { ...context, agent: claude }).catch(
				(error: unknown) => error as AgentCliError
			);
			expect(off).toMatchObject({
				code: 'supabase_disabled',
				retryable: false,
			});
			const recovery = (off as AgentCliError).recovery;
			expect(recovery).toMatch(
				/^Ask the user to turn on local Supabase in RN Devtools › Supabase/
			);
			expect(recovery).toMatch(/`supabase start --runtime native`/);
			expect(recovery).not.toMatch(/docker/i);

			fake.state = createSupabaseDemoState({ now, variant: 'unsupported' });
			await expect(handler(up, context)).rejects.toMatchObject({
				code: 'supabase_unsupported',
				message: 'Native Supabase needs Apple silicon and macOS 14 or later.',
				recovery: supabaseAgentRecovery('supabase_unsupported'),
			});

			const demo = createSupabaseDemoState({ now });
			fake.state = {
				...demo,
				feature: { ...demo.feature, policyHealth: 'quarantined' },
			};
			await expect(handler(up, context)).rejects.toMatchObject({
				code: 'supabase_disabled',
				message: expect.stringContaining('could not read'),
			});
			expect(calls).toEqual([]);
		});

		it('maps service failures to typed errors whose recovery names the next call', async () => {
			const { dependencies } = fixture();
			const { port, fake } = supabaseFake();
			const handler = createAgentCommandRouter({
				...dependencies,
				supabase: port,
			});
			const failure = async (thrown: unknown, signal = context.signal) => {
				fake.answer = async () => {
					throw thrown;
				};
				return await handler(
					{ kind: 'supabase', operation: 'up', worktreePath: WORKTREE },
					{ ...context, signal, agent: claude }
				).then(
					() => {
						throw new Error('Expected the operation to fail.');
					},
					(error: unknown) => error as AgentCliError
				);
			};

			// Typed errors keep their own recovery, or get the contract's.
			const own = new AgentCliError({
				code: 'supabase_held',
				message: 'Codex 5d1b8f40 holds this stack.',
				recovery: 'Ask the user to release it.',
			});
			expect(await failure(own)).toBe(own);
			expect(
				await failure(
					new AgentCliError({
						code: 'supabase_held',
						message: 'Codex 5d1b8f40 holds this stack.',
					})
				)
			).toMatchObject({
				code: 'supabase_held',
				recovery: supabaseAgentRecovery('supabase_held'),
			});
			// Plain errors with an agent code, and the worktree's runner.
			expect(
				await failure(
					Object.assign(new Error('12 of 12 stacks are running.'), {
						code: 'supabase_capacity',
					})
				)
			).toMatchObject({
				code: 'supabase_capacity',
				message: '12 of 12 stacks are running.',
				retryable: true,
				recovery: supabaseAgentRecovery('supabase_capacity'),
			});
			expect(
				await failure({
					code: 'cli_unverified',
					message: 'Supabase CLI 2.122.0 is not verified.',
					runner: 'pnpm exec supabase',
				})
			).toMatchObject({
				code: 'cli_unverified',
				retryable: false,
				recovery: supabaseAgentRecovery('cli_unverified', 'pnpm exec supabase'),
			});
			// Off always reads the same, naming the runner when the service does.
			expect(
				await failure(
					new AgentCliError({
						code: 'supabase_disabled',
						message: 'Local Supabase is off.',
						recovery: supabaseAgentRecovery('supabase_disabled'),
					})
				)
			).toMatchObject({
				code: 'supabase_disabled',
				recovery: expect.stringMatching(/^Ask the user to turn on/),
			});
			const runnerOff = await failure({
				code: 'supabase_disabled',
				message: 'Local Supabase is off.',
				runner: 'pnpm exec supabase',
			});
			expect(runnerOff.recovery).toContain(
				'`pnpm exec supabase start --runtime native`'
			);
			expect(
				(await failure({ code: 'cli_unverified', runner: '`rm -rf ~`' }))
					.recovery
			).toBe(supabaseAgentRecovery('cli_unverified'));
			// Renderer-shaped failures map onto agent codes without operator copy.
			expect(
				await failure({
					code: 'unknown_target',
					title: 'Unknown stack',
					message: 'No stack matches 64616c83.',
					recovery: 'Refresh the list.',
					retry: 'none',
					details: {},
				})
			).toMatchObject({
				code: 'not_found',
				retryable: false,
				recovery: supabaseAgentRecovery('not_found'),
			});
			// Anything else is redacted, bounded, and worth one retry.
			const internal = await failure(
				new TypeError('cannot parse SECRET_KEY=sb_secret_EXAMPLE000 here')
			);
			expect(internal).toMatchObject({
				code: 'supabase_failed',
				retryable: true,
				recovery: supabaseAgentRecovery('supabase_failed'),
			});
			expect(internal.message).not.toContain('sb_secret_');
			// A request the client abandoned reads as cancelled.
			const abandoned = new AbortController();
			abandoned.abort();
			expect(
				await failure(new Error('The operation was aborted.'), abandoned.signal)
			).toMatchObject({ code: 'cancelled' });
		});

		it('withholds results that break the agent contract or carry key material outside env', async () => {
			const { dependencies } = fixture();
			const { port, fake } = supabaseFake();
			const handler = createAgentCommandRouter({
				...dependencies,
				supabase: port,
			});
			const up = {
				kind: 'supabase',
				operation: 'up',
				worktreePath: WORKTREE,
			} as const;
			const upResult = resultFor({
				operation: 'up',
				target: { worktreePath: WORKTREE },
				waitMs: 30_000,
			});
			for (const answer of [
				{ ...upResult, stack: { ...STACK, apiUrl: ENV.API_URL } },
				{
					...upResult,
					next: 'Connect with postgresql://postgres:postgres@127.0.0.1:21735/postgres.',
				},
				{ ...upResult, next: `Send apikey ${ENV.ANON_KEY}.` },
				{ ...upResult, next: `Use ${ENV.PUBLISHABLE_KEY} in the app.` },
				// Another operation's result, or none at all.
				resultFor({ operation: 'env', target: { worktreePath: WORKTREE } }),
				undefined,
			]) {
				fake.answer = async () => answer;
				await expect(handler(up, context)).rejects.toMatchObject({
					code: 'supabase_failed',
					message: expect.stringContaining('withheld'),
					retryable: true,
				});
			}

			// env is the one result that carries the public URL and keys.
			fake.answer = async (operation) => resultFor(operation);
			await expect(
				handler(
					{ kind: 'supabase', operation: 'env', worktreePath: WORKTREE },
					context
				)
			).resolves.toEqual({ operation: 'env', stackId: STACK_ID, env: ENV });

			// Service log lines are redacted once more on the way out.
			const entry = {
				type: 'entry',
				timestamp: '2026-10-17T05:00:00.000Z',
				source: 'history',
				service: 'gateway',
				instanceId: 'gateway',
				stream: 'stdout',
				line: `GET /rest/v1/notes?apikey=${ENV.PUBLISHABLE_KEY}&select=id 200 ${ENV.ANON_KEY}`,
			} as const;
			const marker = {
				type: 'marker',
				timestamp: entry.timestamp,
				source: 'history',
				service: 'gateway',
				instanceId: 'gateway',
				kind: 'launch',
			} as const;
			fake.answer = async () => ({
				operation: 'log',
				stackId: STACK_ID,
				records: [entry, marker],
				truncated: false,
			});
			const log = (await handler(
				{ kind: 'supabase', operation: 'log', worktreePath: WORKTREE },
				context
			)) as Extract<SupabaseAgentResult, { operation: 'log' }>;
			expect(log.records).toEqual([
				{
					...entry,
					line: 'GET /rest/v1/notes?apikey=[REDACTED]&select=id 200 [REDACTED JWT]',
				},
				marker,
			]);
		});

		it('release --all drops the session’s stack holds and reports them', async () => {
			const { dependencies } = fixture();
			const { port, fake, releases } = supabaseFake();
			fake.release = async () => ({
				releasedStackIds: [STACK_ID],
				pendingStops: [STACK_ID],
			});
			const handler = createAgentCommandRouter({
				...dependencies,
				agents: agentsWith([]),
				supabase: port,
			});
			await expect(
				handler(
					{ kind: 'release', all: true, sessionCwd: `${WORKTREE}/src/../src/` },
					{ ...context, agent: claude }
				)
			).resolves.toEqual({
				you: claude,
				stoppedLanes: [],
				pendingLanes: [],
				releasedClaims: [],
				releasedStacks: [STACK_ID],
				pendingStops: [STACK_ID],
				errors: [],
			});
			expect(releases).toEqual([
				{ holder: claude, sessionCwd: `${WORKTREE}/src` },
			]);

			// A failed release is reported, redacted, beside the rest.
			fake.release = async () => {
				throw new Error('registry write failed near sb_secret_EXAMPLE000');
			};
			const failed = (await handler(
				{ kind: 'release', all: true },
				{ ...context, agent: claude }
			)) as { releasedStacks: string[]; errors: string[] };
			expect(failed.releasedStacks).toEqual([]);
			expect(failed.errors).toEqual([
				expect.stringMatching(/^supabase: registry write failed near /),
			]);
			expect(failed.errors.join(' ')).not.toContain('sb_secret_');
			expect(releases[1]).toEqual({ holder: claude });

			// A shared MCP identity without its directory releases nothing.
			const unscoped = (await handler(
				{ kind: 'release', all: true },
				{ ...context, agent: sharedCodex }
			)) as { releasedStacks: string[]; next?: string };
			expect(unscoped.releasedStacks).toEqual([]);
			expect(unscoped.next).toMatch(/sessionCwd/);
			expect(unscoped.next).toMatch(/supabase --operation down/);
			expect(releases).toHaveLength(2);
			await handler(
				{ kind: 'release', all: true, sessionCwd: WORKTREE },
				{ ...context, agent: sharedCodex }
			);
			expect(releases[2]).toEqual({
				holder: sharedCodex,
				sessionCwd: WORKTREE,
			});
		});

		it('release --all answers within 2 s while the stack release still runs', async () => {
			const { dependencies } = fixture();
			const { port, fake } = supabaseFake();
			let finished = false;
			fake.release = async () => {
				await new Promise((resolve) => setTimeout(resolve, 5_000));
				finished = true;
				return { releasedStackIds: [STACK_ID], pendingStops: [] };
			};
			const handler = createAgentCommandRouter({
				...dependencies,
				agents: agentsWith([]),
				supabase: port,
			});
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			try {
				let result: unknown;
				const released = handler(
					{ kind: 'release', all: true },
					{ ...context, agent: claude }
				).then((value) => {
					result = value;
				});
				await vi.advanceTimersByTimeAsync(1_999);
				expect(result).toEqual({
					you: claude,
					stoppedLanes: [],
					pendingLanes: [],
					releasedClaims: [],
					releasedStacks: [],
					pendingStops: [],
					errors: [
						'supabase: dropping the stack holds took longer than 1.5 s and continues in the background.',
					],
				});
				expect(finished).toBe(false);
				await vi.advanceTimersByTimeAsync(5_000);
				expect(finished).toBe(true);
				await released;
			} finally {
				vi.useRealTimers();
			}
		});

		it('follows Supabase jobs through wait and jobs, and reports lost ones', async () => {
			const { dependencies } = fixture();
			const { port, fake, waits } = supabaseFake();
			const handler = createAgentCommandRouter({
				...dependencies,
				supabase: port,
			});
			const jobId = SUPABASE_DEMO_IDS.jobFixAuth;
			const job = fake.state.jobs[0];
			await expect(
				handler(
					{
						kind: 'wait',
						condition: { kind: 'job', jobId },
						timeoutMs: 45_000,
					},
					context
				)
			).resolves.toEqual(job);
			expect(waits).toEqual([{ jobId, timeoutMs: 45_000 }]);
			await expect(
				handler({ kind: 'jobs', operation: 'list' }, context)
			).resolves.toEqual([{ source: 'supabase', ...job }]);
			await expect(
				handler({ kind: 'jobs', operation: 'get', jobId }, context)
			).resolves.toEqual({ source: 'supabase', ...job });
			await expect(
				handler({ kind: 'jobs', operation: 'cancel', jobId }, context)
			).resolves.toMatchObject({
				cancelled: false,
				next: expect.stringContaining('RN Devtools › Supabase'),
			});

			const lost = {
				code: 'job_lost',
				retryable: true,
				recovery: supabaseAgentRecovery('job_lost'),
			};
			const unknown = 'supabase-job-00000000-0000-4000-8000-000000000000';
			await expect(
				handler(
					{
						kind: 'wait',
						condition: { kind: 'job', jobId: unknown },
						timeoutMs: 1_000,
					},
					context
				)
			).rejects.toMatchObject(lost);
			await expect(
				handler({ kind: 'jobs', operation: 'get', jobId: unknown }, context)
			).rejects.toMatchObject(lost);
			fake.state = {
				...fake.state,
				jobs: fake.state.jobs.map((candidate) => ({
					...candidate,
					status: 'lost' as const,
				})),
			};
			await expect(
				handler(
					{ kind: 'wait', condition: { kind: 'job', jobId }, timeoutMs: 1_000 },
					context
				)
			).rejects.toMatchObject(lost);
		});

		it('lists each session’s stack holds in agents and reports Supabase in doctor', async () => {
			const { dependencies } = fixture();
			const { port, fake } = supabaseFake();
			const handler = createAgentCommandRouter({
				...dependencies,
				agents: agentsWith([]),
				supabase: port,
			});
			const ids = SUPABASE_DEMO_IDS;
			const agents = (await handler({ kind: 'agents' }, context)) as {
				supabaseHolds: unknown[];
			};
			// Lane holds without an agent and the operator's pin are nobody's session.
			expect(agents.supabaseHolds).toEqual([
				{
					stackId: ids.featCheckout,
					branch: 'feat-checkout',
					via: 'lane',
					laneId: ids.laneCheckout,
					holder: { kind: 'claude', sessionId: ids.claudeCheckout },
					holderLive: true,
				},
				{
					stackId: ids.featCheckout,
					branch: 'feat-checkout',
					via: 'session',
					holder: { kind: 'codex', sessionId: ids.codexAbandoned },
					holderLive: false,
					abandonedSince: now - 3 * 60_000,
					releaseAt: now + 7 * 60_000,
				},
				{
					stackId: ids.featPayments,
					branch: 'feat-payments',
					via: 'worktree',
					holder: { kind: 'codex', sessionId: ids.codexSynthetic },
					holderLive: true,
				},
			]);

			await expect(handler({ kind: 'doctor' }, context)).resolves.toMatchObject(
				{ supabase: DOCTOR }
			);
			// A doctor section that cannot be read, or breaks its bounds, never
			// fails doctor itself.
			fake.doctor = () => {
				throw new Error('The policy store is busy.');
			};
			await expect(handler({ kind: 'doctor' }, context)).resolves.toMatchObject(
				{ supabase: { capability: 'unavailable', error: expect.any(String) } }
			);
			fake.doctor = () => ({
				...DOCTOR,
				warnings: Array.from({ length: 17 }, () => 'Too many warnings.'),
			});
			await expect(handler({ kind: 'doctor' }, context)).resolves.toMatchObject(
				{ supabase: { capability: 'unavailable' } }
			);
		});

		it('forwards lane up’s backend policy and says what to do while the stack starts', async () => {
			const { dependencies } = fixture();
			const lane: Lane = {
				id: 'lane-11111111-2222-4333-8444-555555555555',
				worktreePath: WORKTREE,
				branch: 'feat-checkout',
				simulatorUdid: UDID,
				environment: 'development',
				port: 8_100,
				metro: 'ready',
				logPath: '/Users/dev/lane.log',
				startedAt: now,
			};
			const state: LaneState = {
				revision: 1,
				updatedAt: now,
				environments: [...DEFAULT_LANE_ENVIRONMENTS],
				lanes: [],
				worktrees: [],
				repositories: [],
				deviceRequests: [],
			};
			const operations: LaneOperation[] = [];
			let backend: LaneOperationReceipt['backend'];
			let completed = true;
			const handler = createAgentCommandRouter({
				...dependencies,
				lanes: {
					getState: () => state,
					refresh: async () => state,
					runOperation: async (operation: LaneOperation) => {
						operations.push(operation);
						return {
							actionId: operation.actionId,
							kind: operation.kind,
							completed,
							...(completed
								? { lane }
								: {
										error: "The lane requires this worktree's local Supabase.",
									}),
							...(backend ? { backend } : {}),
						};
					},
				},
			});
			const up = {
				kind: 'lane',
				operation: 'up',
				worktreePath: WORKTREE,
			} as const;

			await expect(handler(up, context)).resolves.not.toHaveProperty('next');
			expect(operations[0]).not.toHaveProperty('backend');

			const jobId = SUPABASE_DEMO_IDS.jobFixAuth;
			backend = {
				policy: 'auto',
				status: 'starting',
				appEnvNames: [],
				warnings: [],
				jobId,
				launch: 'deferred',
			};
			const starting = (await handler({ ...up, backend: 'auto' }, context)) as {
				backend?: unknown;
				next?: string;
			};
			expect(operations[1]).toMatchObject({
				kind: 'lane.start',
				backend: 'auto',
			});
			expect(starting.backend).toEqual(backend);
			expect(starting.next).toBe(
				`This worktree's local Supabase is still starting; the dev client launches once it is ready. Follow it with wait --condition job --job-id ${jobId}.`
			);

			backend = {
				policy: 'required',
				status: 'refused',
				reason: 'ports-pinned',
				appEnvNames: [],
				warnings: [],
				reasonText: 'supabase/config.toml pins api.port.',
			};
			completed = false;
			await expect(
				handler({ ...up, backend: 'required' }, context)
			).rejects.toMatchObject({
				code: 'lane_failed',
				message: "The lane requires this worktree's local Supabase.",
				retryable: true,
				recovery: expect.stringContaining('backend auto'),
			});
			expect(operations[2]).toMatchObject({ backend: 'required' });
		});
	});
});

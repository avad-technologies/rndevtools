import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	SUPABASE_DEMO_IDS,
	SUPABASE_DEMO_NOW,
} from '../../shared/supabase-demo-data';
import {
	laneBackendSummarySchema,
	type SupabaseOperation,
	supabaseDoctorInfoSchema,
	supabaseOperationReceiptSchema,
	supabaseOperationSchema,
	supabaseStateSchema,
} from '../../shared/supabase-protocol';
import { AgentCliError } from '../agent-cli-service';
import { SupabaseEngine } from './service-engine';
import type { SupabaseServiceDeps } from './service-ports';
import {
	createSupabaseService,
	supabasePlatformAvailability,
} from './supabase-service';

const ids = SUPABASE_DEMO_IDS;
const SECRET_SHAPES = [
	/sb_secret_/,
	/sb_publishable_/,
	/eyJ/,
	/postgres(?:ql)?:\/\//,
	/SERVICE_ROLE/,
];
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

function expectNoSecrets(value: unknown): void {
	const serialized = JSON.stringify(value);
	for (const shape of SECRET_SHAPES) expect(serialized).not.toMatch(shape);
}

async function fixture(overrides: Partial<SupabaseServiceDeps> = {}) {
	const userData = await mkdtemp(
		path.join(tmpdir(), 'rndevtools-supabase-service-')
	);
	directories.push(userData);
	const ports = {
		lanes: {
			lanes: vi.fn(() => []),
			laneById: vi.fn(() => undefined),
			worktrees: vi.fn(() => []),
			repositories: vi.fn(() => []),
			restartMetro: vi.fn(async () => undefined),
			launchDeferred: vi.fn(async () => undefined),
			subscribe: vi.fn(() => () => undefined),
		},
		agents: {
			sessions: vi.fn(() => []),
			holderLiveness: vi.fn(() => ({ live: true as const })),
			discovery: vi.fn(() => ({ claude: 'ok' as const, codex: 'ok' as const })),
			subscribe: vi.fn(() => () => undefined),
		},
		dialog: {
			showMessageBox: vi.fn(),
			showSaveDialog: vi.fn(),
			showOpenDialog: vi.fn(),
		},
		shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
		clipboard: { writeText: vi.fn(), readText: vi.fn() },
	};
	const service = createSupabaseService({
		userDataDirectory: userData,
		agentSocketDirectory: path.join(userData, 'agent'),
		...ports,
		demo: false,
		platform: { platform: 'darwin', arch: 'arm64', macosVersion: '15.1.0' },
		now: () => SUPABASE_DEMO_NOW,
		...overrides,
	});
	/** Nothing asked the user, opened anything, wrote the clipboard or restarted Metro. */
	const expectNothingTouched = () => {
		for (const method of [
			...Object.values(ports.dialog),
			...Object.values(ports.shell),
			...Object.values(ports.clipboard),
			ports.lanes.restartMetro,
			ports.lanes.launchDeferred,
		]) {
			expect(method).not.toHaveBeenCalled();
		}
	};
	return { service, ports, expectNothingTouched };
}

let counter = 0;
function op(fields: Record<string, unknown>): SupabaseOperation {
	counter += 1;
	return supabaseOperationSchema.parse({
		actionId: `action-${counter}`,
		...fields,
	});
}

const laneInput = {
	laneId: 'lane-11111111-2222-4333-8444-555555555555',
	worktreePath: '/Users/example/code/example-app-wt/feat-x',
	branch: 'feat-x',
	environmentId: 'development',
} as const;

describe('Supabase platform verdict', () => {
	it('needs Apple silicon and macOS 14 or later', () => {
		expect(
			supabasePlatformAvailability({
				platform: 'darwin',
				arch: 'arm64',
				macosVersion: '14.0',
			})
		).toEqual({ supported: true, arch: 'arm64', macosVersion: '14.0' });
		expect(
			supabasePlatformAvailability({
				platform: 'darwin',
				arch: 'arm64',
				macosVersion: '26.0.1',
			}).supported
		).toBe(true);
		const reasonText =
			'Native Supabase needs Apple silicon and macOS 14 or later.';
		expect(
			supabasePlatformAvailability({
				platform: 'darwin',
				arch: 'arm64',
				macosVersion: '13.6.1',
			})
		).toEqual({
			supported: false,
			arch: 'arm64',
			macosVersion: '13.6.1',
			reasonText,
		});
		expect(
			supabasePlatformAvailability({
				platform: 'darwin',
				arch: 'x64',
				macosVersion: '15.1.0',
			})
		).toEqual({
			supported: false,
			arch: 'x64',
			macosVersion: '15.1.0',
			reasonText,
		});
		expect(
			supabasePlatformAvailability({
				platform: 'linux',
				arch: 'arm64',
				macosVersion: '15.1.0',
			})
		).toEqual({
			supported: false,
			arch: 'arm64',
			macosVersion: '',
			reasonText,
		});
	});

	it('counts an unreadable report as unsupported', () => {
		for (const platform of [
			{ platform: 'darwin', arch: 'arm64' },
			{ platform: 'darwin', arch: 'arm64', macosVersion: 'fifteen' },
			{ platform: 'darwin', arch: 'arm64', macosVersion: '15.1 beta' },
			{ platform: 'darwin', arch: 'arm64; echo', macosVersion: '15.1.0' },
		]) {
			const verdict = supabasePlatformAvailability(platform);
			expect(verdict.supported).toBe(false);
			expect(verdict.arch).toMatch(/^(?:arm64)?$/);
			expect(verdict.macosVersion).toMatch(/^[\d.]*$/);
		}
	});
});

describe('Supabase service, live', () => {
	it('is the orchestrator, off until the user turns it on', async () => {
		const { service, expectNothingTouched } = await fixture();
		expect(service).toBeInstanceOf(SupabaseEngine);
		await service.start();
		const state = supabaseStateSchema.parse(service.getState());
		expect(state).toMatchObject({
			source: 'live',
			availability: {
				platform: { supported: true, arch: 'arm64', macosVersion: '15.1.0' },
			},
			feature: { enabled: false },
			discovery: { status: 'off' },
			stacks: [],
			jobs: [],
		});
		expect(service.holderKeys()).toEqual([]);
		expect(service.steering()).toMatchObject({
			enabled: false,
			managedRoots: [],
		});
		expectNoSecrets(state);
		await service.stop();
		expectNothingTouched();
	});

	it('asks for the confirmation token before turning on, and refuses while off', async () => {
		const { service, expectNothingTouched } = await fixture();
		await service.start();
		const turnOn = op({ kind: 'set-enabled', enabled: true });
		const unconfirmed = await service.runOperation(turnOn, {
			actor: { kind: 'operator', senderId: 1 },
			confirmed: false,
		});
		expect(supabaseOperationReceiptSchema.parse(unconfirmed)).toMatchObject({
			actionId: turnOn.actionId,
			completed: false,
			error: { code: 'confirmation_required' },
		});
		const facts = await service.describeConfirmation(turnOn);
		expect(facts?.title).toBe('Turn on local Supabase (alpha)?');
		const refresh = await service.runOperation(op({ kind: 'refresh' }), {
			actor: { kind: 'operator', senderId: 1 },
			confirmed: false,
		});
		expect(refresh.error?.code).toBe('feature_off');
		await expect(
			service.releaseHolder({
				holder: { kind: 'claude', sessionId: ids.claudeCheckout },
			})
		).resolves.toEqual({ releasedStackIds: [], pendingStops: [] });
		expect(service.job(ids.jobFixAuth)).toBeUndefined();
		await expect(service.waitForJob(ids.jobFixAuth, 10)).resolves.toBe(
			undefined
		);
		service.setInterest('renderer-1', { view: 'stacks', sections: [] });
		service.detachLane(laneInput.laneId);
		service.detachLane(laneInput.laneId);
		await service.stop();
		expectNothingTouched();
	});

	it('starts lanes without a backend while off, saying why', async () => {
		const { service } = await fixture();
		await service.start();
		for (const policy of ['auto', 'required'] as const) {
			const { summary, laneEnv, lateAttach } = await service.ensureForLane({
				...laneInput,
				policy,
			});
			expect(laneBackendSummarySchema.parse(summary)).toEqual({
				policy,
				status: 'skipped',
				reason: 'disabled',
				appEnvNames: [],
				warnings: [],
				reasonText: 'Local Supabase is off in RN Devtools.',
			});
			expect(laneEnv).toBeUndefined();
			expect(lateAttach).toBeUndefined();
		}
		await expect(
			service.ensureForLane({ ...laneInput, policy: 'off' })
		).resolves.toMatchObject({
			summary: { policy: 'off', status: 'skipped', reason: 'off' },
		});
		await service.stop();
	});

	it('tells agents it is off, or that this Mac is unsupported', async () => {
		const context = { requestId: 'request-1', synthetic: false };
		const operation = {
			operation: 'up',
			target: { worktreePath: laneInput.worktreePath },
			waitMs: 0,
		} as const;
		const signal = new AbortController().signal;
		const off = (await fixture()).service;
		await off.start();
		const offError = await off
			.runAgentOperation(operation, context, signal)
			.catch((error: unknown) => error);
		expect(offError).toBeInstanceOf(AgentCliError);
		expect(offError).toMatchObject({
			code: 'supabase_disabled',
			recovery: expect.stringContaining('--runtime native'),
		});
		expect(supabaseDoctorInfoSchema.parse(off.doctor())).toMatchObject({
			enabled: false,
			capability: 'off',
			running: 0,
		});
		await off.stop();

		const intel = (
			await fixture({
				platform: { platform: 'darwin', arch: 'x64', macosVersion: '15.1.0' },
			})
		).service;
		await intel.start();
		await expect(
			intel.runAgentOperation(operation, context, signal)
		).rejects.toMatchObject({ code: 'supabase_unsupported' });
		expect(intel.doctor().capability).toBe('unsupported');
		await expect(
			intel.ensureForLane({ ...laneInput, policy: 'auto' })
		).resolves.toMatchObject({
			summary: {
				reasonText:
					'Native Supabase needs Apple silicon and macOS 14 or later.',
			},
		});
		await intel.stop();
	});
});

describe('Supabase service, demo', () => {
	it('serves the demo stacks from memory and applies operations to them', async () => {
		const { service, ports, expectNothingTouched } = await fixture({
			demo: true,
		});
		expect(service).not.toBeInstanceOf(SupabaseEngine);
		const initial = supabaseStateSchema.parse(service.getState());
		expect(initial.source).toBe('demo');
		expect(initial.updatedAt).toBe(SUPABASE_DEMO_NOW);
		expect(initial.stacks).toHaveLength(10);
		const listener = vi.fn();
		service.subscribe(listener);
		const context = {
			actor: { kind: 'operator', senderId: 1 },
			confirmed: false,
		} as const;

		const stop = op({ kind: 'stop', stackIds: [ids.featPayments] });
		const stopped = await service.runOperation(stop, context);
		expect(stopped).toMatchObject({ actionId: stop.actionId, completed: true });
		const after = service.getState();
		expect(after.revision).toBe(initial.revision + 1);
		expect(
			after.stacks.find((stack) => stack.id === ids.featPayments)?.state
		).toBe('stopped');
		expect(listener).toHaveBeenCalledOnce();
		expect(listener).toHaveBeenCalledWith(after);

		const refused = await service.runOperation(
			op({
				kind: 'destroy',
				stackIds: [ids.featCheckout],
				removeUploads: false,
			}),
			context
		);
		expect(refused).toMatchObject({
			completed: false,
			error: { code: 'refused' },
		});
		expect(service.getState()).toBe(after);
		expect(listener).toHaveBeenCalledOnce();

		const copied = await service.runOperation(
			op({ kind: 'copy', stackId: ids.featCheckout, what: 'publishable-key' }),
			context
		);
		expect(copied).toMatchObject({ copy: { copied: true } });
		expectNoSecrets([initial, after, stopped, refused, copied]);
		// Demo stacks are not something agents can use.
		await expect(
			service.runAgentOperation(
				{ operation: 'ls' },
				{ requestId: 'request-2', synthetic: false },
				new AbortController().signal
			)
		).rejects.toMatchObject({ code: 'supabase_disabled' });
		await expect(
			service.ensureForLane({ ...laneInput, policy: 'auto' })
		).resolves.toMatchObject({ summary: { status: 'skipped' } });
		expect(service.doctor()).toMatchObject({
			enabled: false,
			warnings: ['RN Devtools is showing demo stacks; nothing runs.'],
		});
		await service.start();
		await service.stop();
		expectNothingTouched();
		for (const method of Object.values(ports.lanes)) {
			expect(method).not.toHaveBeenCalled();
		}
	});

	it('pushes the inspected stack services, as a status read would', async () => {
		const { service } = await fixture({ demo: true });
		const listener = vi.fn();
		service.subscribe(listener);
		expect(service.getState().inspection).toBeUndefined();
		service.setInterest('window-1', {
			view: 'stacks',
			inspectStackId: ids.featCheckout,
			sections: ['services'],
		});
		const inspected = supabaseStateSchema.parse(service.getState());
		expect(listener).toHaveBeenCalledOnce();
		expect(inspected.inspection).toMatchObject({
			stackId: ids.featCheckout,
			status: 'live',
		});
		expect(inspected.inspection?.members[0]).toMatchObject({
			service: 'database',
			state: 'running',
		});
		expect(
			inspected.inspection?.members.some(
				(member) => member.state === 'sleeping' && member.wakeHintMs
			)
		).toBe(true);
		// The same interest again pushes nothing.
		service.setInterest('window-1', {
			view: 'stacks',
			inspectStackId: ids.featCheckout,
			sections: [],
		});
		expect(listener).toHaveBeenCalledOnce();
		// After a stop the inspection follows the stack: nothing runs.
		const receipt = await service.runOperation(
			op({ kind: 'stop', stackIds: [ids.featCheckout] }),
			{ actor: { kind: 'operator', senderId: 1 }, confirmed: false }
		);
		expect(receipt.state?.inspection?.members).toEqual([]);
		expect(service.getState().inspection?.members).toEqual([]);
		service.setInterest('window-1', { view: 'repositories', sections: [] });
		expect(service.getState().inspection).toBeUndefined();
	});

	it('keeps one subscriber from failing an operation', async () => {
		const { service } = await fixture({ demo: true });
		const failing = vi.fn(() => {
			throw new Error('renderer went away');
		});
		const after = vi.fn();
		service.subscribe(failing);
		const unsubscribe = service.subscribe(after);
		await expect(
			service.runOperation(op({ kind: 'refresh' }), {
				actor: { kind: 'operator', senderId: 1 },
				confirmed: false,
			})
		).resolves.toMatchObject({ completed: true });
		expect(after).toHaveBeenCalledOnce();
		unsubscribe();
		await service.runOperation(op({ kind: 'refresh' }), {
			actor: { kind: 'operator', senderId: 1 },
			confirmed: false,
		});
		expect(after).toHaveBeenCalledOnce();
		expect(failing).toHaveBeenCalledTimes(2);
	});
});

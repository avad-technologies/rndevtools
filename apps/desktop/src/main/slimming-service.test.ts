import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SimulatorCapability } from '../shared/simulator-protocol';
import {
	SLIMMING_CONFIRMATIONS,
	type SlimmingAction,
	slimmingActionSchema,
} from '../shared/slimming-protocol';
import {
	type SimHelperCompatibility,
	SimHelperError,
	type SimHelperHandshake,
	type SimHelperMutation,
} from './sim-helper-client';
import {
	SimulatorMutationCoordinator,
	type SimulatorMutationCoordinatorPort,
} from './simulator-mutation-coordinator';
import {
	type SimulatorHostProvider,
	SimulatorService,
} from './simulator-service';
import {
	type DeviceAccessPort,
	type SlimmingHelperProvider,
	SlimmingService,
} from './slimming-service';

const UDID = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
const SECOND_UDID = '11111111-2222-3333-4444-555555555555';
const RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-26-5';
const PROFILE = 'rndevtools-development';
/** The longest reconciliation backs off between inspections. */
const MAX_BACKOFF_MS = 10 * 60_000;
const temporaryDirectories: string[] = [];

const AVAILABLE_SIMULATOR_CAPABILITY: SimulatorCapability = {
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
};

class CoordinatedSlimmingSimulatorProvider implements SimulatorHostProvider {
	readonly commands: string[][] = [];
	beforeRun: (() => Promise<void>) | undefined;

	discover = async () => AVAILABLE_SIMULATOR_CAPABILITY;
	inventory = async () => ({
		runtimes: [],
		deviceTypes: [],
		devices: [
			{
				udid: UDID,
				name: 'Slimming coordination target',
				state: 'booted' as const,
				runtimeIdentifier: RUNTIME,
				isAvailable: true,
			},
		],
	});
	listApps = async () => [];
	openSimulator = async () => undefined;
	runSimctl = async (args: readonly string[]) => {
		await this.beforeRun?.();
		this.commands.push([...args]);
		return { stdout: '', stderr: '', exitCode: 0 };
	};
}

function deferred() {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

const COMPATIBILITY: SimHelperCompatibility = {
	status: 'unknown',
	matrixVersion: '2026-09-03-v2',
	tuple: {
		macOSBuild: '25F80',
		xcodeBuild: '17F113',
		coreSimulatorBuild: '1051.55',
		runtimeIdentifier: RUNTIME,
		runtimeBuild: '23F77',
		hostArchitecture: 'arm64',
		helperVersion: '0.1.0',
		helperBuildCommit: 'a'.repeat(40),
		catalogVersion: 'simslim-v0.12.2-6518ba7e-rndevtools.1-presets.3',
	},
	verifiedOperations: [],
};

function mutation(
	operation: SimHelperMutation['operation'],
	before: string[],
	after: string[],
	compatibility = COMPATIBILITY,
	checkpointToken = `opaque-${operation}-${before.join('.') || 'clean'}`
): SimHelperMutation {
	return {
		operation,
		...(operation === 'apply_profile' ? { profileId: PROFILE } : {}),
		changed: JSON.stringify(before) !== JSON.stringify(after),
		checkpointToken,
		compatibility,
		originalBootState: 'Booted',
		finalBootState: 'Booted',
		temporarilyBooted: false,
		rebooted: true,
		before: { managedDisabledServiceIds: before, count: before.length },
		desired: { managedDisabledServiceIds: after, count: after.length },
		plan: {
			toDisableServiceIds: after.filter((value) => !before.includes(value)),
			toEnableServiceIds: before.filter((value) => !after.includes(value)),
		},
		after: { managedDisabledServiceIds: after, count: after.length },
		verification: {
			verified: true,
			currentManagedDisabledServiceIds: after,
			desiredManagedDisabledServiceIds: after,
			overridesMatch: true,
			missingDisabledServiceIds: [],
			unexpectedDisabledServiceIds: [],
			disabledLaunchdJobRegistrationsAbsent: true,
			checkedDisabledLaunchdJobRegistrationCount: after.length,
			registeredDisabledLaunchdJobIds: [],
			observedPreMutationProcessesAbsent: true,
			checkedObservedProcessNames: [],
			presentObservedProcessNames: [],
		},
		rollback: { attempted: false, succeeded: false, rebooted: false },
	};
}

class FakeHelper implements SlimmingHelperProvider {
	readonly acknowledgements: Array<string | undefined> = [];
	readonly order: string[] = [];
	readonly preparedStates = new Map<string, string[]>();
	prepareSequence = 0;
	managedByDevice = new Map<string, string[]>([
		[UDID, []],
		[SECOND_UDID, []],
	]);
	applyError: Error | undefined;
	prepareError: Error | undefined;
	undoError: Error | undefined;
	afterPrepare: (() => Promise<void>) | undefined;
	afterApply: (() => Promise<void>) | undefined;
	preflightVerificationVerified = true;
	mutationVerificationVerified = true;
	deviceState: 'Booted' | 'Shutdown' = 'Booted';
	compatibility: SimHelperCompatibility = COMPATIBILITY;

	handshake = vi.fn(
		async (): Promise<SimHelperHandshake> => ({
			helperVersion: '0.1.0',
			buildCommit: 'a'.repeat(40),
			protocolVersion: 2 as const,
			platform: 'darwin' as const,
			architecture: 'arm64' as const,
			catalogVersion: 'simslim-v0.12.2-6518ba7e-rndevtools.1-presets.3',
			catalogSource: {
				repository: 'https://github.com/MobAI-App/simslim' as const,
				commit: 'b'.repeat(40),
				profilesSha256: 'c'.repeat(64),
				patchSet: 'rndevtools.1' as const,
				upstreamSourceManifestSha256:
					'bbd7640e2738197be54564d9f9926710a0dc5e13ee674d6e00e48bd5714b6172' as const,
				patchSha256:
					'99703cfc6fa2bddf360f364b115edd0f235df82282e3e809daff543641a472f0' as const,
				vendoredSourceManifestSha256:
					'887daa4543b0aecaefbdd9c7edb6e46e00205fecaba254c09527579dc84175d2' as const,
			},
			capabilities: {
				operations: [
					'handshake',
					'list_simulators',
					'clone_simulator',
					'disk_cleanup_plan',
					'disk_cleanup',
					'list_profiles',
					'simulator_status',
					'preview_profile',
					'verify_profile',
					'doctor',
					'prepare_mutation',
					'apply_profile',
					'restore_managed',
					'undo_last',
				],
				readOnlyAvailable: true,
				mutationMode: 'signed_broker_compatibility_gated_experimental',
				mutationSafety: 'Strict compatibility and rollback.',
				compatibilityMatrixVersion: '2026-09-03-v2',
				compatibilityStates: ['verified', 'limited', 'unknown', 'blocked'],
				verifiedMutationTuples: 0,
				checkpointTokenMaxBytes: 32_768 as const,
				runtimeDownloads: false as const,
			},
		})
	);
	listSimulators = vi.fn(async () =>
		[UDID, SECOND_UDID].map((id, index) => ({
			id,
			name: `Simulator ${index + 1}`,
			state: this.deviceState,
			runtimeIdentifier: RUNTIME,
			deviceTypeIdentifier:
				'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro',
			available: true,
		}))
	);
	listProfiles = vi.fn(async () => ({
		catalogVersion: 'simslim-v0.12.2-6518ba7e-rndevtools.1-presets.3',
		categories: [
			{
				id: 'telemetry',
				name: 'Telemetry',
				description: 'Diagnostics services.',
				downside: 'Diagnostics stop.',
				approxMemoryMB: 100,
				serviceIds: ['com.apple.feedbackd'],
			},
		],
		profiles: [
			{
				id: PROFILE,
				name: 'App Development',
				description: 'Development profile.',
				categoryIds: ['telemetry'],
				experimental: true,
			},
		],
		doctorCapabilities: [{ id: 'storekit', displayName: 'StoreKit' }],
	}));
	simulatorStatus = vi.fn(async (simulatorId: string) => {
		const managed = this.managedByDevice.get(simulatorId) ?? [];
		const device = (await this.listSimulators()).find(
			(candidate) => candidate.id === simulatorId
		);
		if (!device) throw new Error('Unknown fake simulator.');
		return {
			device,
			managedDisabledServiceIds: managed,
			managedDisabledCount: managed.length,
			managedServiceCount: 1,
			matchingProfileIds: managed.length > 0 ? [PROFILE] : [],
		};
	});
	previewProfile = vi.fn(async (simulatorId: string, profileId: string) => ({
		simulatorId,
		profileId,
		currentDisabledServiceIds: this.managedByDevice.get(simulatorId) ?? [],
		desiredDisabledServiceIds: ['com.apple.feedbackd'],
		toDisableServiceIds: ['com.apple.feedbackd'],
		toEnableServiceIds: [],
		requiresCheckpoint: true,
		requiresReboot: true,
		executable: true,
		compatibility: this.compatibility,
	}));
	verifyProfile = vi.fn(async (simulatorId: string, profileId: string) => ({
		simulatorId,
		profileId,
		verified: true,
		currentManagedDisabledServiceIds:
			this.managedByDevice.get(simulatorId) ?? [],
		desiredManagedDisabledServiceIds:
			this.managedByDevice.get(simulatorId) ?? [],
		overridesMatch: true,
		missingDisabledServiceIds: [],
		unexpectedDisabledServiceIds: [],
		disabledLaunchdJobRegistrationsAbsent: true,
		checkedDisabledLaunchdJobRegistrationCount: 0,
		registeredDisabledLaunchdJobIds: [],
		observedPreMutationProcessesAbsent: true,
		checkedObservedProcessNames: [],
		presentObservedProcessNames: [],
	}));
	doctor = vi.fn(
		async (simulatorId: string, requiredCapabilities: readonly string[]) => ({
			simulatorId,
			healthy: true,
			managedDisabledServiceIds: this.managedByDevice.get(simulatorId) ?? [],
			capabilities: requiredCapabilities.map((id) => ({
				id,
				available: true,
				blockedByServiceIds: [],
			})),
		})
	);
	prepareMutation = vi.fn(
		async (
			simulatorId: string,
			operation: 'apply_profile' | 'restore_managed' | 'undo_last',
			profileId: string | undefined,
			targetCheckpointToken: string | undefined
		) => {
			if (this.prepareError) throw this.prepareError;
			const before = [...(this.managedByDevice.get(simulatorId) ?? [])];
			const desired =
				operation === 'apply_profile'
					? ['com.apple.feedbackd']
					: operation === 'undo_last'
						? [...(this.preparedStates.get(targetCheckpointToken ?? '') ?? [])]
						: [];
			const checkpointToken = `prepared-${++this.prepareSequence}-${before.join('.') || 'clean'}`;
			this.preparedStates.set(checkpointToken, before);
			await this.afterPrepare?.();
			return {
				operation,
				simulatorId,
				...(profileId ? { profileId } : {}),
				changed: JSON.stringify(before) !== JSON.stringify(desired),
				checkpointToken,
				compatibility: this.compatibility,
				originalBootState: 'Booted' as const,
				before: { managedDisabledServiceIds: before, count: before.length },
				desired: { managedDisabledServiceIds: desired, count: desired.length },
				plan: {
					toDisableServiceIds: desired.filter(
						(value) => !before.includes(value)
					),
					toEnableServiceIds: before.filter(
						(value) => !desired.includes(value)
					),
				},
				verification: {
					verified: this.preflightVerificationVerified,
					currentManagedDisabledServiceIds: before,
					desiredManagedDisabledServiceIds: before,
					overridesMatch: true,
					missingDisabledServiceIds: [],
					unexpectedDisabledServiceIds: [],
					disabledLaunchdJobRegistrationsAbsent: true,
					checkedDisabledLaunchdJobRegistrationCount: before.length,
					registeredDisabledLaunchdJobIds: [],
					observedPreMutationProcessesAbsent: true,
					checkedObservedProcessNames: [],
					presentObservedProcessNames: [],
				},
				observedRunningProcessNames: [],
			};
		}
	);
	applyProfile = vi.fn(
		async (
			simulatorId: string,
			_profileId: string,
			checkpointToken: string,
			acknowledgement: 'EXPERIMENTAL' | undefined
		) => {
			this.order.push(simulatorId);
			this.acknowledgements.push(acknowledgement);
			if (this.applyError) throw this.applyError;
			const before = this.managedByDevice.get(simulatorId) ?? [];
			const after = ['com.apple.feedbackd'];
			this.managedByDevice.set(simulatorId, after);
			await this.afterApply?.();
			return mutation(
				'apply_profile',
				before,
				after,
				this.compatibility,
				checkpointToken
			);
		}
	);
	restoreManaged = vi.fn(
		async (
			simulatorId: string,
			checkpointToken: string,
			acknowledgement: 'EXPERIMENTAL' | undefined
		) => {
			this.order.push(simulatorId);
			this.acknowledgements.push(acknowledgement);
			const before = this.managedByDevice.get(simulatorId) ?? [];
			this.managedByDevice.set(simulatorId, []);
			return mutation(
				'restore_managed',
				before,
				[],
				this.compatibility,
				checkpointToken
			);
		}
	);
	undoLast = vi.fn(
		async (
			simulatorId: string,
			preparedCheckpointToken: string,
			_checkpointToken: string,
			acknowledgement: 'EXPERIMENTAL' | undefined
		) => {
			this.acknowledgements.push(acknowledgement);
			if (this.undoError) throw this.undoError;
			const before = this.managedByDevice.get(simulatorId) ?? [];
			this.managedByDevice.set(simulatorId, []);
			const result = mutation(
				'undo_last',
				before,
				[],
				this.compatibility,
				preparedCheckpointToken
			);
			return {
				...result,
				verification: {
					...result.verification,
					verified: this.mutationVerificationVerified,
				},
			};
		}
	);
}

function action(value: unknown): SlimmingAction {
	return slimmingActionSchema.parse(value);
}

async function createService(
	helper = new FakeHelper(),
	persistenceDirectory?: string,
	mutationCoordinator?: SimulatorMutationCoordinatorPort,
	deviceAccess?: DeviceAccessPort
) {
	const directory =
		persistenceDirectory ??
		(await mkdtemp(path.join(tmpdir(), 'rndevtools-slimming-')));
	if (!persistenceDirectory) temporaryDirectories.push(directory);
	const service = new SlimmingService({
		resourceDirectory: '/unused',
		persistenceDirectory: directory,
		appVersion: '0.1.0',
		helper,
		...(mutationCoordinator ? { mutationCoordinator } : {}),
		...(deviceAccess ? { deviceAccess } : {}),
		pollIntervalMs: 60_000,
	});
	await service.start();
	return { directory, helper, service };
}

async function createFleetService(
	mutationCoordinator: SimulatorMutationCoordinatorPort,
	provider = new CoordinatedSlimmingSimulatorProvider()
) {
	const captureDirectory = await mkdtemp(
		path.join(tmpdir(), 'rndevtools-fleet-coordination-')
	);
	temporaryDirectories.push(captureDirectory);
	const service = new SimulatorService({
		captureDirectory,
		provider,
		metricsProvider: {
			sample: vi.fn(async () => ({
				status: 'available' as const,
				byDevice: {},
			})),
		},
		mutationCoordinator,
		pollIntervalMs: 60_000,
	});
	await service.start();
	return { provider, service };
}

async function waitForJob(service: SlimmingService, jobId: string) {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		const job = service
			.getState()
			.jobs.find((candidate) => candidate.id === jobId);
		if (
			job &&
			['complete', 'failed', 'needs-attention', 'cancelled'].includes(
				job.status
			)
		) {
			return job;
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Job ${jobId} did not finish.`);
}

async function waitForFleetJob(
	service: SimulatorService,
	jobId: string,
	status: 'cancelled' | 'complete' | 'failed' = 'complete'
) {
	await vi.waitFor(() => {
		expect(
			service.getState().jobs.find((job) => job.id === jobId)?.status
		).toBe(status);
	});
}

async function enableAndAcknowledge(
	service: SlimmingService,
	actionPrefix: string
) {
	await service.setEnabled({
		actionId: `${actionPrefix}-enable`,
		enabled: true,
	});
	const receipt = await service.acknowledgeCompatibility({
		actionId: `${actionPrefix}-ack`,
		simulatorUdids: [UDID],
		acknowledgement: 'EXPERIMENTAL',
	});
	expect(receipt.accepted).toBe(true);
}

async function runApply(service: SlimmingService, actionId: string) {
	const receipt = service.runAction(
		action({
			actionId,
			kind: 'profile.apply',
			simulatorUdids: [UDID],
			profileId: PROFILE,
			confirmation: SLIMMING_CONFIRMATIONS.apply,
		})
	);
	expect(receipt.accepted).toBe(true);
	return waitForJob(service, receipt.jobId ?? '');
}

async function readPersistedState(directory: string) {
	return JSON.parse(
		await readFile(path.join(directory, 'state-v1.json'), 'utf8')
	) as {
		checkpoints: Record<string, { token: string; metadata: unknown }>;
		pendingMutations: Record<
			string,
			{
				id: string;
				checkpointToken: string;
				beforeServiceIds: string[];
				desiredServiceIds: string[];
			}
		>;
	};
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true }))
	);
});

describe('slimming service', () => {
	it('exposes the desktop mutation restriction while retaining read-only discovery', async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'rndevtools-slimming-preview-')
		);
		temporaryDirectories.push(directory);
		const service = new SlimmingService({
			resourceDirectory: '/unused',
			persistenceDirectory: directory,
			appVersion: '0.1.0',
			helper: new FakeHelper(),
			mutationUnavailableReason:
				'Use a signed, packaged desktop app to apply changes.',
		});
		try {
			await service.start();
			expect(service.getState().helper).toMatchObject({
				status: 'available',
				readOnlyAvailable: true,
				mutationUnavailableReason:
					'Use a signed, packaged desktop app to apply changes.',
			});
			expect(service.getState().profiles).not.toHaveLength(0);
		} finally {
			await service.stop();
		}
	});
	it('refuses a mutation on a device another session holds, for agents and the panel alike', async () => {
		const decisions: Array<[string, string | undefined]> = [];
		const deviceAccess: DeviceAccessPort = (udid, requester) => {
			decisions.push([udid, requester?.sessionId]);
			if (requester?.sessionId === 'owner') return { allowed: true };
			return {
				allowed: false,
				reason: `Simulator ${udid} is held by claude session owner through lane lane-1.`,
				hold: {
					simulatorUdid: udid,
					via: 'lane',
					laneId: 'lane-1',
					holder: { kind: 'claude', sessionId: 'owner' },
					holderLive: true,
				},
			};
		};
		const slimming = await createService(
			new FakeHelper(),
			undefined,
			undefined,
			deviceAccess
		);
		await enableAndAcknowledge(slimming.service, 'held');

		const stranger = slimming.service.runAction(
			action({
				actionId: 'held-stranger',
				kind: 'profile.apply',
				simulatorUdids: [UDID],
				profileId: PROFILE,
				confirmation: SLIMMING_CONFIRMATIONS.apply,
				requester: { kind: 'codex', sessionId: 'stranger' },
			})
		);
		expect(stranger.accepted).toBe(false);
		expect(stranger.error).toMatch(/held by claude session owner/);

		const operator = slimming.service.runAction(
			action({
				actionId: 'held-operator',
				kind: 'profile.apply',
				simulatorUdids: [UDID],
				profileId: PROFILE,
				confirmation: SLIMMING_CONFIRMATIONS.apply,
			})
		);
		expect(operator.accepted).toBe(false);

		const owner = slimming.service.runAction(
			action({
				actionId: 'held-owner',
				kind: 'profile.apply',
				simulatorUdids: [UDID],
				profileId: PROFILE,
				confirmation: SLIMMING_CONFIRMATIONS.apply,
				requester: { kind: 'claude', sessionId: 'owner' },
			})
		);
		expect(owner.accepted).toBe(true);
		expect((await waitForJob(slimming.service, owner.jobId ?? '')).status).toBe(
			'complete'
		);
		expect(decisions.map(([, who]) => who)).toEqual([
			'stranger',
			undefined,
			'owner',
		]);

		// Read-only work never consults ownership.
		const preview = slimming.service.runAction(
			action({
				actionId: 'held-preview',
				kind: 'profile.preview',
				simulatorUdids: [UDID],
				profileId: PROFILE,
				requester: { kind: 'codex', sessionId: 'stranger' },
			})
		);
		expect(preview.accepted).toBe(true);
		expect(decisions).toHaveLength(3);
		await slimming.service.stop();
	});

	it('serializes direct Fleet actions behind a Slimming mutation on the same UDID', async () => {
		const coordinator = new SimulatorMutationCoordinator();
		const helper = new FakeHelper();
		const slimming = await createService(helper, undefined, coordinator);
		const fleet = await createFleetService(coordinator);
		await enableAndAcknowledge(slimming.service, 'cross-service');
		const mutationEntered = deferred();
		const releaseMutation = deferred();
		helper.afterPrepare = async () => {
			helper.afterPrepare = undefined;
			mutationEntered.resolve();
			await releaseMutation.promise;
		};
		const applyReceipt = slimming.service.runAction(
			action({
				actionId: 'cross-service-apply',
				kind: 'profile.apply',
				simulatorUdids: [UDID],
				profileId: PROFILE,
				confirmation: SLIMMING_CONFIRMATIONS.apply,
			})
		);
		await mutationEntered.promise;
		const fleetReceipt = fleet.service.runAction({
			actionId: 'cross-service-launch',
			kind: 'app.launch',
			udid: UDID,
			bundleIdentifier: 'com.example.app',
			terminateRunning: false,
			arguments: [],
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(fleet.provider.commands).toEqual([]);
		releaseMutation.resolve();
		expect(
			(await waitForJob(slimming.service, applyReceipt.jobId ?? '')).status
		).toBe('complete');
		await waitForFleetJob(fleet.service, fleetReceipt.jobId ?? '');
		expect(fleet.provider.commands[0]?.[0]).toBe('launch');
		await Promise.all([slimming.service.stop(), fleet.service.stop()]);
	});

	it('cancels Slimming promptly while it waits behind a direct Fleet mutation', async () => {
		const coordinator = new SimulatorMutationCoordinator();
		const helper = new FakeHelper();
		const slimming = await createService(helper, undefined, coordinator);
		const provider = new CoordinatedSlimmingSimulatorProvider();
		const fleetEntered = deferred();
		const releaseFleet = deferred();
		provider.beforeRun = async () => {
			provider.beforeRun = undefined;
			fleetEntered.resolve();
			await releaseFleet.promise;
		};
		const fleet = await createFleetService(coordinator, provider);
		await enableAndAcknowledge(slimming.service, 'cross-cancel');
		const fleetReceipt = fleet.service.runAction({
			actionId: 'cross-cancel-launch',
			kind: 'app.launch',
			udid: UDID,
			bundleIdentifier: 'com.example.app',
			terminateRunning: false,
			arguments: [],
		});
		await fleetEntered.promise;
		const applyReceipt = slimming.service.runAction(
			action({
				actionId: 'cross-cancel-apply',
				kind: 'profile.apply',
				simulatorUdids: [UDID],
				profileId: PROFILE,
				confirmation: SLIMMING_CONFIRMATIONS.apply,
			})
		);
		expect(slimming.service.cancelJob(applyReceipt.jobId ?? '')).toBe(true);
		expect(
			(await waitForJob(slimming.service, applyReceipt.jobId ?? '')).status
		).toBe('cancelled');
		expect(helper.prepareMutation).not.toHaveBeenCalled();
		releaseFleet.resolve();
		await waitForFleetJob(fleet.service, fleetReceipt.jobId ?? '');
		await Promise.all([slimming.service.stop(), fleet.service.stop()]);
	});

	it('persists a first-use acknowledgement for the exact fresh unknown tuple before recipe mutations', async () => {
		const { helper, service } = await createService();
		await service.setEnabled({ actionId: 'enable-first-use', enabled: true });

		const blocked = service.runAction(
			action({
				actionId: 'recipe-before-ack',
				kind: 'profile.apply',
				simulatorUdids: [UDID.toLowerCase()],
				profileId: PROFILE,
				confirmation: SLIMMING_CONFIRMATIONS.apply,
			})
		);
		expect(blocked).toMatchObject({ accepted: false });

		const acknowledged = await service.acknowledgeCompatibility({
			actionId: 'typed-recipe-ack',
			simulatorUdids: [UDID.toLowerCase()],
			acknowledgement: 'EXPERIMENTAL',
		});
		expect(acknowledged).toMatchObject({
			accepted: true,
			state: {
				statusBySimulator: {
					[UDID]: { compatibility: { status: 'unknown', acknowledged: true } },
				},
			},
		});

		const accepted = service.runAction(
			action({
				actionId: 'recipe-after-ack',
				kind: 'profile.apply',
				simulatorUdids: [UDID.toLowerCase()],
				profileId: PROFILE,
				confirmation: SLIMMING_CONFIRMATIONS.apply,
			})
		);
		expect(accepted.accepted).toBe(true);
		expect((await waitForJob(service, accepted.jobId ?? '')).status).toBe(
			'complete'
		);
		expect(helper.order).toEqual([UDID]);
		expect(helper.acknowledgements).toEqual(['EXPERIMENTAL']);
		await service.stop();
	});

	it('keeps inventory, profiles, and status read-only while mutations are disabled', async () => {
		const { helper, service } = await createService();
		expect(service.getState()).toMatchObject({
			setting: { experimentalMutationsEnabled: false },
			helper: { status: 'available', readOnlyAvailable: true },
			profiles: [{ id: PROFILE }],
			statusBySimulator: { [UDID]: { condition: 'managed-clean' } },
		});
		const receipt = service.runAction(
			action({
				actionId: 'blocked-apply',
				kind: 'profile.apply',
				simulatorUdids: [UDID],
				profileId: PROFILE,
				confirmation: SLIMMING_CONFIRMATIONS.apply,
			})
		);
		expect(receipt).toMatchObject({ accepted: false });
		expect(helper.applyProfile).not.toHaveBeenCalled();
		await service.stop();
	});

	it('makes room for new work by dropping the oldest finished jobs, and refuses only while 100 are active', async () => {
		const { service } = await createService();
		const preview = (actionId: string) =>
			service.runAction(
				action({
					actionId,
					kind: 'profile.preview',
					simulatorUdids: [UDID],
					profileId: PROFILE,
				})
			);
		// Read-only jobs run one at a time, so 100 accepted at once are all active.
		const active = Array.from({ length: 100 }, (_, index) =>
			preview(`preview-${index}`)
		);
		expect(active.every((receipt) => receipt.accepted)).toBe(true);
		expect(preview('preview-overflow')).toMatchObject({
			accepted: false,
			error: 'The 100-job Slimming queue is full.',
		});
		for (const receipt of active)
			await waitForJob(service, receipt.jobId ?? '');

		// A session that already ran 100 jobs keeps working.
		const next = preview('preview-after');
		expect(next.accepted).toBe(true);
		expect((await waitForJob(service, next.jobId ?? '')).status).toBe(
			'complete'
		);
		const actionIds = service.getState().jobs.map((job) => job.actionId);
		expect(actionIds).toHaveLength(100);
		expect(actionIds).not.toContain('preview-0');
		expect(actionIds.at(-1)).toBe('preview-after');
		await service.stop();
	});

	it('does not auto-boot shutdown targets during refresh but supports preview, acknowledgement, and mutation', async () => {
		const helper = new FakeHelper();
		helper.deviceState = 'Shutdown';
		const { service } = await createService(helper);
		expect(helper.simulatorStatus).not.toHaveBeenCalled();
		expect(service.getState().statusBySimulator[UDID]).toMatchObject({
			condition: 'unknown',
			message: expect.stringContaining(
				'temporary, automatically restored boot'
			),
		});

		const preview = service.runAction(
			action({
				actionId: 'shutdown-preview',
				kind: 'profile.preview',
				simulatorUdids: [UDID],
				profileId: PROFILE,
			})
		);
		expect((await waitForJob(service, preview.jobId ?? '')).status).toBe(
			'complete'
		);
		await service.setEnabled({ actionId: 'shutdown-enable', enabled: true });
		const acknowledgement = await service.acknowledgeCompatibility({
			actionId: 'shutdown-ack',
			simulatorUdids: [UDID],
			acknowledgement: 'EXPERIMENTAL',
		});
		expect(acknowledgement.accepted).toBe(true);
		expect(helper.simulatorStatus).not.toHaveBeenCalled();

		const apply = service.runAction(
			action({
				actionId: 'shutdown-apply',
				kind: 'profile.apply',
				simulatorUdids: [UDID],
				profileId: PROFILE,
				confirmation: SLIMMING_CONFIRMATIONS.apply,
			})
		);
		expect((await waitForJob(service, apply.jobId ?? '')).status).toBe(
			'complete'
		);
		await service.stop();
	});

	it('persists opaque checkpoints and exact-tuple acknowledgement across restarts', async () => {
		const first = await createService();
		await first.service.setEnabled({ actionId: 'enable', enabled: true });
		const preview = first.service.runAction(
			action({
				actionId: 'preview',
				kind: 'profile.preview',
				simulatorUdids: [UDID],
				profileId: PROFILE,
			})
		);
		await waitForJob(first.service, preview.jobId ?? '');
		expect(
			first.service.getState().previewBySimulator[UDID]?.compatibility
		).toMatchObject({
			status: 'unknown',
			acknowledged: false,
		});
		expect(
			first.service.runAction(
				action({
					actionId: 'missing-ack',
					kind: 'profile.apply',
					simulatorUdids: [UDID],
					profileId: PROFILE,
					confirmation: SLIMMING_CONFIRMATIONS.apply,
				})
			)
		).toMatchObject({ accepted: false });
		await first.service.acknowledgeCompatibility({
			actionId: 'persist-exact-ack',
			simulatorUdids: [UDID],
			acknowledgement: 'EXPERIMENTAL',
		});

		const apply = first.service.runAction(
			action({
				actionId: 'apply',
				kind: 'profile.apply',
				simulatorUdids: [UDID],
				profileId: PROFILE,
				confirmation: SLIMMING_CONFIRMATIONS.apply,
			})
		);
		expect((await waitForJob(first.service, apply.jobId ?? '')).status).toBe(
			'complete'
		);
		const serialized = JSON.stringify(first.service.getState());
		expect(serialized).not.toContain('opaque-');
		expect(first.service.getState().checkpointBySimulator[UDID]).toBeDefined();
		await first.service.stop();

		const secondHelper = new FakeHelper();
		const second = await createService(secondHelper, first.directory);
		const secondPreview = second.service.runAction(
			action({
				actionId: 'preview-after-restart',
				kind: 'profile.preview',
				simulatorUdids: [UDID],
				profileId: PROFILE,
			})
		);
		await waitForJob(second.service, secondPreview.jobId ?? '');
		expect(
			second.service.getState().previewBySimulator[UDID]?.compatibility
		).toMatchObject({
			acknowledged: true,
		});
		const secondApply = second.service.runAction(
			action({
				actionId: 'apply-after-restart',
				kind: 'profile.apply',
				simulatorUdids: [UDID],
				profileId: PROFILE,
				confirmation: SLIMMING_CONFIRMATIONS.apply,
			})
		);
		await waitForJob(second.service, secondApply.jobId ?? '');
		expect(secondHelper.acknowledgements).toContain('EXPERIMENTAL');
		await second.service.stop();
	});

	it('processes batches sequentially and disables only after restore verification', async () => {
		const helper = new FakeHelper();
		helper.managedByDevice.set(UDID, ['com.apple.feedbackd']);
		helper.managedByDevice.set(SECOND_UDID, ['com.apple.feedbackd']);
		const { service } = await createService(helper);
		await service.setEnabled({ actionId: 'enable', enabled: true });
		await service.acknowledgeCompatibility({
			actionId: 'batch-exact-ack',
			simulatorUdids: [UDID, SECOND_UDID],
			acknowledgement: 'EXPERIMENTAL',
		});
		const receipt = await service.setEnabled({
			actionId: 'disable-and-restore',
			enabled: false,
			disposition: 'restore-and-verify',
			simulatorUdids: [UDID, SECOND_UDID],
			confirmation: SLIMMING_CONFIRMATIONS.restore,
		});
		expect(receipt.accepted).toBe(true);
		expect(service.getState().setting).toMatchObject({
			experimentalMutationsEnabled: true,
			disabledDisposition: 'restore-pending',
		});
		expect((await waitForJob(service, receipt.jobId ?? '')).status).toBe(
			'complete'
		);
		expect(helper.order).toEqual([UDID, SECOND_UDID]);
		expect(service.getState().setting).toMatchObject({
			experimentalMutationsEnabled: false,
			disabledDisposition: 'restored-and-verified',
		});
		await service.stop();
	});

	it('disables cleanly without an override warning when no managed changes exist', async () => {
		const { service } = await createService(new FakeHelper());
		await service.setEnabled({ actionId: 'enable-clean', enabled: true });

		const receipt = await service.setEnabled({
			actionId: 'disable-clean',
			enabled: false,
			disposition: 'leave-overrides-in-place',
		});

		expect(receipt.accepted).toBe(true);
		expect(service.getState().setting).toEqual({
			experimentalMutationsEnabled: false,
			updatedAt: expect.any(Number),
		});
		await service.stop();
	});

	it('retains a private emergency checkpoint and marks rollback uncertainty needs-attention', async () => {
		const helper = new FakeHelper();
		const evidence = {
			...mutation('apply_profile', [], ['com.apple.feedbackd']),
			failureCode: 'rollback_verification_failed',
			finalBootState: 'Unknown' as const,
			verification: {
				...mutation('apply_profile', [], ['com.apple.feedbackd']).verification,
				verified: false,
			},
			rollback: {
				attempted: true,
				succeeded: false,
				rebooted: true,
				errorCode: 'rollback_verification_failed',
			},
		};
		helper.applyError = new SimHelperError(
			'mutation_failed_needs_attention',
			'Rollback could not be proven.',
			false,
			evidence
		);
		const { service } = await createService(helper);
		await service.setEnabled({ actionId: 'enable', enabled: true });
		await service.acknowledgeCompatibility({
			actionId: 'failure-exact-ack',
			simulatorUdids: [UDID],
			acknowledgement: 'EXPERIMENTAL',
		});
		const receipt = service.runAction(
			action({
				actionId: 'unsafe-failure',
				kind: 'profile.apply',
				simulatorUdids: [UDID],
				profileId: PROFILE,
				confirmation: SLIMMING_CONFIRMATIONS.apply,
			})
		);
		const job = await waitForJob(service, receipt.jobId ?? '');
		expect(job.status).toBe('needs-attention');
		expect(service.getState().checkpointBySimulator[UDID]).toBeUndefined();
		expect(service.getState().statusBySimulator[UDID]).toMatchObject({
			condition: 'needs-attention',
			checkpointAvailable: true,
		});
		expect(JSON.stringify(service.getState())).not.toContain('opaque-');
		await service.stop();
	});

	it('rejects a queued mutation when its compatibility tuple changes after acknowledgement', async () => {
		const helper = new FakeHelper();
		const { service } = await createService(helper);
		await service.setEnabled({ actionId: 'enable-race', enabled: true });
		await service.acknowledgeCompatibility({
			actionId: 'ack-old-tuple',
			simulatorUdids: [UDID],
			acknowledgement: 'EXPERIMENTAL',
		});
		const receipt = service.runAction(
			action({
				actionId: 'queued-old-tuple',
				kind: 'profile.apply',
				simulatorUdids: [UDID],
				profileId: PROFILE,
				confirmation: SLIMMING_CONFIRMATIONS.apply,
			})
		);
		helper.compatibility = {
			...COMPATIBILITY,
			tuple: { ...COMPATIBILITY.tuple, xcodeBuild: '18A999' },
		};
		const job = await waitForJob(service, receipt.jobId ?? '');
		expect(job).toMatchObject({
			status: 'failed',
			targets: [
				{
					status: 'failed',
					message: expect.stringContaining(
						'unacknowledged compatibility tuple'
					),
				},
			],
		});
		expect(helper.applyProfile).not.toHaveBeenCalled();
		await service.stop();
	});

	it('surfaces the helper failure code, reason, and unverified services for a rolled-back apply', async () => {
		const helper = new FakeHelper();
		const { directory, service } = await createService(helper);
		await enableAndAcknowledge(service, 'rolled-back');
		const attempted = mutation('apply_profile', [], ['com.apple.feedbackd']);
		helper.applyError = new SimHelperError(
			'mutation_failed_rolled_back',
			'The mutation failed and the helper restored the verified pre-operation state.',
			false,
			{
				...attempted,
				failureCode: 'apply_delta_failed',
				failureDetail:
					'the disable overrides did not survive the reboot (1 of 1 changes lost)',
				changed: true,
				verification: {
					...attempted.verification,
					verified: false,
					disabledLaunchdJobRegistrationsAbsent: false,
					registeredDisabledLaunchdJobIds: ['com.apple.feedbackd'],
				},
				rollback: { attempted: true, succeeded: true, rebooted: true },
			}
		);

		const job = await runApply(service, 'rolled-back-apply');
		expect(job.status).toBe('failed');
		const target = job.targets[0];
		expect(target).toMatchObject({
			status: 'failed',
			errorCode: 'mutation_failed_rolled_back',
		});
		for (const expected of [
			'restored the verified pre-operation state',
			'helper failure apply_delta_failed',
			'did not survive the reboot (1 of 1 changes lost)',
			'still registered: com.apple.feedbackd',
			'rollback succeeded',
		]) {
			expect(target?.message).toContain(expected);
		}
		expect(
			(await readPersistedState(directory)).pendingMutations[UDID]
		).toBeUndefined();
		await service.stop();
	});

	it('reports a refused helper authorization as a plain no-mutation failure with its reason', async () => {
		const helper = new FakeHelper();
		const { directory, service } = await createService(helper);
		await enableAndAcknowledge(service, 'refused');
		const reason =
			"The helper's parent is not an authenticated mutation broker: verify live broker signature failed";
		helper.applyError = new SimHelperError(
			'mutation_authorization_required',
			reason,
			false
		);

		const job = await runApply(service, 'refused-apply');
		// The helper denies before it constructs the simulator service, so nothing
		// was mutated and nothing needs restart reconciliation.
		expect(job).toMatchObject({
			status: 'failed',
			targets: [
				{
					status: 'failed',
					condition: 'unknown',
					errorCode: 'mutation_authorization_required',
					message: expect.stringContaining(
						'not an authenticated mutation broker'
					),
				},
			],
		});
		expect(
			(await readPersistedState(directory)).pendingMutations[UDID]
		).toBeUndefined();
		expect(service.getState().statusBySimulator[UDID]?.condition).not.toBe(
			'needs-attention'
		);
		await service.stop();
	});

	it('durably records the prepared checkpoint before invoking the helper mutation', async () => {
		const helper = new FakeHelper();
		const { directory, service } = await createService(helper);
		await enableAndAcknowledge(service, 'prepare-persistence');
		const savedDirectory = `${directory}.saved`;
		temporaryDirectories.push(savedDirectory);
		helper.afterPrepare = async () => {
			helper.afterPrepare = undefined;
			await rename(directory, savedDirectory);
			await writeFile(directory, 'block atomic persistence');
		};

		const job = await runApply(service, 'prepare-persistence-apply');
		expect(job.status).toBe('failed');
		expect(helper.applyProfile).not.toHaveBeenCalled();
		const persisted = await readPersistedState(savedDirectory);
		expect(persisted.pendingMutations[UDID]).toBeUndefined();

		await rm(directory, { force: true });
		await rename(savedDirectory, directory);
		await service.stop();
	});

	it.each([false, true])(
		'clears outdated inspections before and after a mutation (failure: %s)',
		async (fails) => {
			const { helper, service } = await createService();
			await enableAndAcknowledge(service, 'inspection-cache');
			const inspect = async (prefix: string) => {
				for (const kind of ['profile.preview', 'doctor.run'] as const) {
					const receipt = service.runAction(
						action({
							actionId: `${prefix}-${kind}`,
							kind,
							simulatorUdids: [UDID],
							...(kind === 'profile.preview'
								? { profileId: PROFILE }
								: { requiredCapabilities: ['storekit'] }),
						})
					);
					expect((await waitForJob(service, receipt.jobId ?? '')).status).toBe(
						'complete'
					);
				}
				expect(service.getState().previewBySimulator[UDID]).toBeDefined();
				expect(service.getState().doctorBySimulator[UDID]).toBeDefined();
			};
			await inspect('before');
			const apply = helper.applyProfile.getMockImplementation();
			if (!apply) throw new Error('Fake apply implementation is unavailable.');
			helper.applyProfile.mockImplementationOnce(async (...arguments_) => {
				expect(service.getState().previewBySimulator[UDID]).toBeUndefined();
				expect(service.getState().doctorBySimulator[UDID]).toBeUndefined();
				await inspect('during');
				return apply(...arguments_);
			});
			if (fails) {
				helper.applyError = new SimHelperError(
					'mutation_authorization_required',
					'Injected authorization refusal.',
					false
				);
			}
			try {
				expect((await runApply(service, 'inspection-cache-apply')).status).toBe(
					fails ? 'failed' : 'complete'
				);
				expect(service.getState().previewBySimulator[UDID]).toBeUndefined();
				expect(service.getState().doctorBySimulator[UDID]).toBeUndefined();
			} finally {
				await service.stop();
			}
		}
	);

	it('preserves the last real-change checkpoint across an idempotent apply before undo', async () => {
		const { directory, helper, service } = await createService();
		await enableAndAcknowledge(service, 'idempotent');
		expect((await runApply(service, 'idempotent-first')).status).toBe(
			'complete'
		);
		const firstPersisted = await readPersistedState(directory);
		const firstCheckpoint = firstPersisted.checkpoints[UDID];
		expect(firstCheckpoint).toBeDefined();

		const second = await runApply(service, 'idempotent-second');
		expect(second).toMatchObject({
			status: 'complete',
			targets: [{ changed: false }],
		});
		const secondPersisted = await readPersistedState(directory);
		expect(secondPersisted.checkpoints[UDID]).toEqual(firstCheckpoint);
		expect(secondPersisted.pendingMutations[UDID]).toBeUndefined();

		const undo = service.runAction(
			action({
				actionId: 'idempotent-undo',
				kind: 'profile.undo',
				simulatorUdids: [UDID],
				confirmation: SLIMMING_CONFIRMATIONS.undo,
			})
		);
		expect((await waitForJob(service, undo.jobId ?? '')).status).toBe(
			'complete'
		);
		expect(helper.managedByDevice.get(UDID)).toEqual([]);
		await service.stop();
	});

	it('clears a proven rolled-back pending attempt without replacing the prior checkpoint', async () => {
		const helper = new FakeHelper();
		const { directory, service } = await createService(helper);
		await enableAndAcknowledge(service, 'rollback-safe');
		expect((await runApply(service, 'rollback-safe-first')).status).toBe(
			'complete'
		);
		const firstCheckpoint = (await readPersistedState(directory)).checkpoints[
			UDID
		];
		helper.managedByDevice.set(UDID, []);
		helper.applyError = new SimHelperError(
			'mutation_failed',
			'Injected mutation failure with verified rollback.',
			false,
			{
				...mutation('apply_profile', [], []),
				changed: true,
				rollback: { attempted: true, succeeded: true, rebooted: true },
			}
		);

		const failed = await runApply(service, 'rollback-safe-second');
		expect(failed.status).toBe('failed');
		expect(failed.targets[0]?.status).toBe('failed');
		const persisted = await readPersistedState(directory);
		expect(persisted.pendingMutations[UDID]).toBeUndefined();
		expect(persisted.checkpoints[UDID]).toEqual(firstCheckpoint);
		expect(service.getState().statusBySimulator[UDID]?.condition).not.toBe(
			'needs-attention'
		);
		await service.stop();
	});

	it('reconciles an interrupted pre-mutation record without replacing the prior checkpoint', async () => {
		const helper = new FakeHelper();
		const first = await createService(helper);
		await enableAndAcknowledge(first.service, 'restart-before');
		helper.applyError = new Error(
			'Injected helper process exit before mutation.'
		);
		const interrupted = await runApply(first.service, 'restart-before-apply');
		expect(interrupted.status).toBe('needs-attention');
		const persistedBeforeRestart = await readPersistedState(first.directory);
		const pending = persistedBeforeRestart.pendingMutations[UDID];
		expect(pending).toBeDefined();
		await first.service.stop();

		const restartedHelper = new FakeHelper();
		restartedHelper.preparedStates.set(
			pending?.checkpointToken ?? '',
			pending?.beforeServiceIds ?? []
		);
		const restarted = await createService(restartedHelper, first.directory);
		const persistedAfterRestart = await readPersistedState(first.directory);
		expect(persistedAfterRestart.pendingMutations[UDID]).toBeUndefined();
		expect(restarted.service.getState().statusBySimulator[UDID]).toMatchObject({
			condition: 'managed-clean',
			checkpointAvailable: false,
		});
		await restarted.service.stop();
	});

	it('promotes a durable prepared checkpoint after restart proves the helper committed', async () => {
		const helper = new FakeHelper();
		const first = await createService(helper);
		await enableAndAcknowledge(first.service, 'restart-after');
		const savedDirectory = `${first.directory}.saved`;
		temporaryDirectories.push(savedDirectory);
		helper.afterApply = async () => {
			helper.afterApply = undefined;
			await rename(first.directory, savedDirectory);
			await writeFile(first.directory, 'block finalization persistence');
		};

		const interrupted = await runApply(first.service, 'restart-after-apply');
		expect(interrupted.status).toBe('needs-attention');
		const persistedPending = await readPersistedState(savedDirectory);
		const pending = persistedPending.pendingMutations[UDID];
		expect(pending).toBeDefined();
		await rm(first.directory, { force: true });
		await rename(savedDirectory, first.directory);
		await first.service.stop();

		const restartedHelper = new FakeHelper();
		restartedHelper.managedByDevice.set(UDID, ['com.apple.feedbackd']);
		restartedHelper.preparedStates.set(
			pending?.checkpointToken ?? '',
			pending?.beforeServiceIds ?? []
		);
		const restarted = await createService(restartedHelper, first.directory);
		const reconciled = await readPersistedState(first.directory);
		expect(reconciled.pendingMutations[UDID]).toBeUndefined();
		expect(reconciled.checkpoints[UDID]?.token).toBe(pending?.checkpointToken);
		expect(
			restarted.service.getState().checkpointBySimulator[UDID]
		).toBeDefined();
		await restarted.service.stop();
	});

	it('retains an emergency checkpoint when matching overrides fail launchd verification', async () => {
		const helper = new FakeHelper();
		const first = await createService(helper);
		await enableAndAcknowledge(first.service, 'restart-unverified');
		helper.applyError = new Error('Injected exit after prepare.');
		await runApply(first.service, 'restart-unverified-apply');
		const pending = (await readPersistedState(first.directory))
			.pendingMutations[UDID];
		await first.service.stop();

		const restartedHelper = new FakeHelper();
		restartedHelper.preflightVerificationVerified = false;
		restartedHelper.preparedStates.set(
			pending?.checkpointToken ?? '',
			pending?.beforeServiceIds ?? []
		);
		const restarted = await createService(restartedHelper, first.directory);
		expect(
			(await readPersistedState(first.directory)).pendingMutations[UDID]
		).toBeDefined();
		expect(restarted.service.getState().statusBySimulator[UDID]).toMatchObject({
			condition: 'needs-attention',
			checkpointAvailable: true,
		});
		await restarted.service.stop();
	});

	it('does not clear an emergency checkpoint when no-op Undo preflight verification is false', async () => {
		const helper = new FakeHelper();
		const first = await createService(helper);
		await enableAndAcknowledge(first.service, 'manual-unverified');
		helper.applyError = new Error('Injected exit after durable preparation.');
		await runApply(first.service, 'manual-unverified-apply');
		const pendingBefore = (await readPersistedState(first.directory))
			.pendingMutations[UDID];
		expect(pendingBefore).toBeDefined();
		await first.service.stop();

		const recoveryHelper = new FakeHelper();
		recoveryHelper.preflightVerificationVerified = false;
		recoveryHelper.preparedStates.set(
			pendingBefore?.checkpointToken ?? '',
			pendingBefore?.beforeServiceIds ?? []
		);
		const restarted = await createService(recoveryHelper, first.directory);
		recoveryHelper.prepareError = new SimHelperError(
			'preexisting_state_unverified',
			'Launchd registration verification was false.',
			false,
			{ verification: { verified: false } }
		);
		const receipt = restarted.service.runAction(
			action({
				actionId: 'manual-unverified-undo',
				kind: 'profile.undo',
				simulatorUdids: [UDID],
				confirmation: SLIMMING_CONFIRMATIONS.undo,
			})
		);
		const undo = await waitForJob(restarted.service, receipt.jobId ?? '');
		expect(undo.status).toBe('needs-attention');
		expect(
			(await readPersistedState(first.directory)).pendingMutations[UDID]
		).toEqual(pendingBefore);
		expect(restarted.service.getState().statusBySimulator[UDID]).toMatchObject({
			condition: 'needs-attention',
			checkpointAvailable: true,
		});
		await restarted.service.stop();
	});

	it('retains the original emergency checkpoint when state drifts after no-op Undo preparation', async () => {
		const helper = new FakeHelper();
		const first = await createService(helper);
		await enableAndAcknowledge(first.service, 'manual-drift');
		helper.applyError = new Error('Injected exit after durable preparation.');
		await runApply(first.service, 'manual-drift-apply');
		const pendingBefore = (await readPersistedState(first.directory))
			.pendingMutations[UDID];
		expect(pendingBefore).toBeDefined();
		await first.service.stop();

		const recoveryHelper = new FakeHelper();
		recoveryHelper.preflightVerificationVerified = false;
		recoveryHelper.preparedStates.set(
			pendingBefore?.checkpointToken ?? '',
			pendingBefore?.beforeServiceIds ?? []
		);
		const restarted = await createService(recoveryHelper, first.directory);
		recoveryHelper.preflightVerificationVerified = true;
		recoveryHelper.afterPrepare = async () => {
			recoveryHelper.afterPrepare = undefined;
			recoveryHelper.managedByDevice.set(UDID, ['com.apple.feedbackd']);
			recoveryHelper.undoError = new SimHelperError(
				'checkpoint_state_mismatch',
				'Simulator state changed after checkpoint preparation.',
				false
			);
		};

		const receipt = restarted.service.runAction(
			action({
				actionId: 'manual-drift-undo',
				kind: 'profile.undo',
				simulatorUdids: [UDID],
				confirmation: SLIMMING_CONFIRMATIONS.undo,
			})
		);
		const undo = await waitForJob(restarted.service, receipt.jobId ?? '');
		expect(undo.status).toBe('needs-attention');
		expect(
			(await readPersistedState(first.directory)).pendingMutations[UDID]
		).toEqual(pendingBefore);
		expect(restarted.service.getState().statusBySimulator[UDID]).toMatchObject({
			condition: 'needs-attention',
			checkpointAvailable: true,
		});
		await restarted.service.stop();
	});

	it('leaves the journal of an apply that starts during a refresh to that apply', async () => {
		const helper = new FakeHelper();
		const { directory, service } = await createService(
			helper,
			undefined,
			new SimulatorMutationCoordinator()
		);
		await enableAndAcknowledge(service, 'overlap');
		// A background poll is inside its status pass when the apply arrives.
		const refreshEntered = deferred();
		const releaseRefresh = deferred();
		const status = helper.simulatorStatus.getMockImplementation();
		if (!status) throw new Error('Fake status implementation is unavailable.');
		helper.simulatorStatus.mockImplementationOnce(async (...arguments_) => {
			refreshEntered.resolve();
			await releaseRefresh.promise;
			return status(...arguments_);
		});
		const refreshing = service.refresh();
		await refreshEntered.promise;

		// The apply journals its restore point, then waits inside the commit.
		const commitEntered = deferred();
		const releaseCommit = deferred();
		const apply = helper.applyProfile.getMockImplementation();
		if (!apply) throw new Error('Fake apply implementation is unavailable.');
		helper.applyProfile.mockImplementationOnce(async (...arguments_) => {
			commitEntered.resolve();
			await releaseCommit.promise;
			return apply(...arguments_);
		});
		const receipt = service.runAction(
			action({
				actionId: 'overlap-apply',
				kind: 'profile.apply',
				simulatorUdids: [UDID],
				profileId: PROFILE,
				confirmation: SLIMMING_CONFIRMATIONS.apply,
			})
		);
		expect(receipt.accepted).toBe(true);
		await commitEntered.promise;
		const journal = (await readPersistedState(directory)).pendingMutations[
			UDID
		];
		expect(journal).toBeDefined();

		// The poll reaches reconciliation while the commit is still running.
		releaseRefresh.resolve();
		await refreshing;
		expect(
			(await readPersistedState(directory)).pendingMutations[UDID]
		).toEqual(journal);

		releaseCommit.resolve();
		const job = await waitForJob(service, receipt.jobId ?? '');
		expect(job.status).toBe('complete');
		const persisted = await readPersistedState(directory);
		expect(persisted.pendingMutations[UDID]).toBeUndefined();
		expect(persisted.checkpoints[UDID]?.token).toBe(journal?.checkpointToken);
		// Reconciliation never inspected the device the job was mutating.
		expect(
			helper.prepareMutation.mock.calls.map(([, operation]) => operation)
		).toEqual(['apply_profile']);
		await service.stop();
	});

	describe('a pending record that needs attention', () => {
		/**
		 * Leaves the interrupted apply's record behind, then restarts on a
		 * helper that can prove neither its before nor its target state.
		 */
		async function stuckRecord(
			deviceState: 'Booted' | 'Shutdown',
			mutationCoordinator?: SimulatorMutationCoordinatorPort
		) {
			const helper = new FakeHelper();
			const first = await createService(helper);
			await enableAndAcknowledge(first.service, 'stuck');
			helper.applyError = new Error('Injected exit after prepare.');
			expect((await runApply(first.service, 'stuck-apply')).status).toBe(
				'needs-attention'
			);
			const pending = (await readPersistedState(first.directory))
				.pendingMutations[UDID];
			if (!pending) throw new Error('The interrupted apply left no record.');
			await first.service.stop();

			const restartedHelper = new FakeHelper();
			restartedHelper.deviceState = deviceState;
			restartedHelper.preflightVerificationVerified = false;
			restartedHelper.preparedStates.set(
				pending.checkpointToken,
				pending.beforeServiceIds
			);
			const clock = { now: 1_000_000 };
			const service = new SlimmingService({
				resourceDirectory: '/unused',
				persistenceDirectory: first.directory,
				appVersion: '0.1.0',
				helper: restartedHelper,
				...(mutationCoordinator ? { mutationCoordinator } : {}),
				pollIntervalMs: 60_000,
				now: () => clock.now,
			});
			await service.start();
			return {
				clock,
				directory: first.directory,
				helper: restartedHelper,
				pending,
				service,
				/** Every inspection of a shut-down Simulator boots it. */
				inspections: () =>
					restartedHelper.prepareMutation.mock.calls.filter(
						([udid]) => udid === UDID
					).length,
			};
		}

		it('boots a shut-down Simulator for restart reconciliation once, not on every poll', async () => {
			const stuck = await stuckRecord('Shutdown');
			expect(stuck.inspections()).toBe(1);
			for (let tick = 0; tick < 3; tick += 1) {
				stuck.clock.now += 60_000;
				await stuck.service.refresh();
			}
			expect(stuck.inspections()).toBe(1);
			expect(stuck.service.getState().statusBySimulator[UDID]).toMatchObject({
				condition: 'needs-attention',
				checkpointAvailable: true,
				message: expect.stringContaining('Boot this Simulator'),
			});
			expect(
				(await readPersistedState(stuck.directory)).pendingMutations[UDID]
			).toEqual(stuck.pending);

			// Once it is booted, reconciliation inspects again, then backs off.
			stuck.helper.deviceState = 'Booted';
			await stuck.service.refresh();
			expect(stuck.inspections()).toBe(2);
			await stuck.service.refresh();
			expect(stuck.inspections()).toBe(2);
			stuck.clock.now += 2 * 60_000;
			await stuck.service.refresh();
			expect(stuck.inspections()).toBe(3);
			stuck.clock.now += 2 * 60_000;
			await stuck.service.refresh();
			expect(stuck.inspections()).toBe(3);
			stuck.clock.now += 2 * 60_000;
			await stuck.service.refresh();
			expect(stuck.inspections()).toBe(4);
			expect(stuck.service.getState().statusBySimulator[UDID]?.condition).toBe(
				'needs-attention'
			);
			await stuck.service.stop();
		});

		it('never waits on the Simulator lease, so a lease holder can refresh', async () => {
			const coordinator = new SimulatorMutationCoordinator();
			const stuck = await stuckRecord('Booted', coordinator);
			expect(stuck.inspections()).toBe(1);
			stuck.clock.now += 2 * 60_000;
			// Lanes and recipes refresh SimSlim from inside their own lease.
			await coordinator.runExclusive(
				UDID,
				new AbortController().signal,
				async () => {
					await stuck.service.refresh();
				}
			);
			expect(stuck.inspections()).toBe(1);
			expect(stuck.service.getState().statusBySimulator[UDID]?.condition).toBe(
				'needs-attention'
			);

			// Once the lease is free, the next pass inspects the record.
			await new Promise((resolve) => setTimeout(resolve, 0));
			await stuck.service.refresh();
			expect(stuck.inspections()).toBe(2);
			await stuck.service.stop();
		});

		it('polls with every window hidden only as often as reconciliation backs off', async () => {
			vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
			try {
				const stuck = await stuckRecord('Booted');
				stuck.service.setPollingActive(false);
				const polls = () => stuck.helper.handshake.mock.calls.length;
				const before = polls();
				// Restart reconciliation left the record waiting two polls.
				vi.advanceTimersByTime(60_000);
				expect(polls()).toBe(before);
				stuck.clock.now += 2 * 60_000;
				vi.advanceTimersByTime(60_000);
				expect(polls()).toBe(before + 1);
				await stuck.service.refresh();
				expect(stuck.inspections()).toBe(2);
				// Now it waits four.
				stuck.clock.now += 2 * 60_000;
				vi.advanceTimersByTime(60_000);
				expect(polls()).toBe(before + 1);
				await stuck.service.stop();
			} finally {
				vi.useRealTimers();
			}
		});

		it('can be forgotten, which ends its reconciliation and unblocks a restore', async () => {
			const stuck = await stuckRecord('Booted');
			const forget = (actionId: string) =>
				stuck.service.runAction(
					action({
						actionId,
						kind: 'pending.forget',
						simulatorUdids: [UDID],
						confirmation: SLIMMING_CONFIRMATIONS.forget,
					})
				);
			const receipt = forget('forget-stuck');
			expect(receipt.accepted).toBe(true);
			expect(
				(await waitForJob(stuck.service, receipt.jobId ?? '')).status
			).toBe('complete');
			const persisted = await readPersistedState(stuck.directory);
			expect(persisted.pendingMutations[UDID]).toBeUndefined();
			expect(JSON.stringify(persisted)).not.toContain(
				stuck.pending.checkpointToken
			);
			expect(
				stuck.service.getState().operationsBySimulator[UDID]?.[0]
			).toMatchObject({ kind: 'pending.forget', status: 'complete' });
			expect(stuck.service.getState().statusBySimulator[UDID]).toMatchObject({
				condition: 'unknown',
				checkpointAvailable: false,
			});

			// Nothing is left to reconcile, or to forget.
			stuck.clock.now += MAX_BACKOFF_MS;
			await stuck.service.refresh();
			expect(stuck.inspections()).toBe(1);
			expect(forget('forget-again')).toMatchObject({
				accepted: false,
				error: `${UDID} has no emergency restore point to forget.`,
			});

			// A restore, refused while the record existed, now runs.
			const restore = stuck.service.runAction(
				action({
					actionId: 'restore-after-forget',
					kind: 'profile.restore',
					simulatorUdids: [UDID],
					confirmation: SLIMMING_CONFIRMATIONS.restore,
				})
			);
			expect(
				(await waitForJob(stuck.service, restore.jobId ?? '')).status
			).toBe('complete');
			await stuck.service.stop();
		});
	});
});

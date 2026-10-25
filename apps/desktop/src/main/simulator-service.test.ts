import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	type SimulatorAction,
	type SimulatorCapability,
	simulatorActionSchema,
} from '../shared/simulator-protocol';
import {
	SimulatorCommandError,
	type SimulatorCommandOptions,
} from './simulator-command-runner';
import {
	type SimulatorCloneProvider,
	type SimulatorDiskProvider,
	type SimulatorHostProvider,
	type SimulatorImageCompositor,
	SimulatorService,
} from './simulator-service';

const RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-26-0';
const DEVICE_TYPE = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro';
const UDID = '11111111-2222-3333-4444-555555555555';
const UNKNOWN_UDID = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
const temporaryDirectories: string[] = [];

const AVAILABLE: SimulatorCapability = {
	status: 'available',
	platform: 'darwin',
	xcodeVersion: 'Xcode 26.6',
	xcodeBuild: '17G100',
	selectedDeveloperDirectoryLabel: 'Xcode.app (selected)',
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

type RecordedCommand = {
	args: readonly string[];
	options: SimulatorCommandOptions;
};

class FakeProvider implements SimulatorHostProvider {
	readonly commands: RecordedCommand[] = [];
	readonly opened: string[] = [];
	deviceState: 'booted' | 'shutdown' = 'booted';
	deviceName = 'Example Test';
	blockVideo = false;
	failKeychain = false;
	containerPath = '';

	discover = vi.fn(async () => AVAILABLE);
	inventory = vi.fn(async () => ({
		runtimes: [
			{
				identifier: RUNTIME,
				name: 'iOS 26.0',
				version: '26.0',
				isAvailable: true,
			},
		],
		deviceTypes: [
			{
				identifier: DEVICE_TYPE,
				name: 'iPhone 17 Pro',
				productFamily: 'iPhone',
			},
		],
		devices: [
			{
				udid: UDID,
				name: this.deviceName,
				state: this.deviceState,
				runtimeIdentifier: RUNTIME,
				deviceTypeIdentifier: DEVICE_TYPE,
				isAvailable: true,
			},
		],
	}));
	listApps = vi.fn(async () => [
		{
			bundleIdentifier: 'com.example.app',
			displayName: 'ExampleApp',
			isSystem: false,
		},
	]);
	openSimulator = vi.fn(async (udid: string) => {
		this.opened.push(udid);
	});
	runSimctl = vi.fn(
		async (args: readonly string[], options: SimulatorCommandOptions = {}) => {
			this.commands.push({ args: [...args], options });
			if (args[0] === 'keychain' && this.failKeychain) {
				throw new SimulatorCommandError('keychain failed', { kind: 'failed' });
			}
			if (args[0] === 'shutdown') this.deviceState = 'shutdown';
			if (args[0] === 'boot') this.deviceState = 'booted';
			if (args[0] === 'get_app_container') {
				return { stdout: `${this.containerPath}\n`, stderr: '', exitCode: 0 };
			}
			const operation = args[2];
			if (operation === 'screenshot') {
				const output = args.at(-1);
				if (output) await writeFile(output, Buffer.from('png'));
			}
			if (operation === 'recordVideo') {
				const output = args.at(-1);
				if (output) await writeFile(output, Buffer.from('video'));
				if (this.blockVideo) {
					await new Promise<void>((_resolve, reject) => {
						const rejectCancelled = () =>
							reject(
								new SimulatorCommandError('recording cancelled', {
									kind: 'aborted',
								})
							);
						if (options.signal?.aborted) rejectCancelled();
						else
							options.signal?.addEventListener('abort', rejectCancelled, {
								once: true,
							});
					});
				}
			}
			return { stdout: '', stderr: '', exitCode: 0 };
		}
	);
}

function parsedAction(value: unknown): SimulatorAction {
	return simulatorActionSchema.parse(value);
}

async function createService(
	provider = new FakeProvider(),
	revealPath?: (containerPath: string, signal: AbortSignal) => Promise<void>,
	resolveDeviceDataRoot?: (udid: string) => Promise<string>,
	imageCompositor?: SimulatorImageCompositor,
	cloneProvider?: SimulatorCloneProvider,
	diskProvider?: SimulatorDiskProvider
) {
	const captureDirectory = await mkdtemp(
		path.join(tmpdir(), 'rndevtools-service-')
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
		pollIntervalMs: 60_000,
		...(revealPath ? { revealPath } : {}),
		...(resolveDeviceDataRoot ? { resolveDeviceDataRoot } : {}),
		...(imageCompositor ? { imageCompositor } : {}),
		...(cloneProvider ? { cloneProvider } : {}),
		...(diskProvider ? { diskProvider } : {}),
	});
	await service.start();
	return { captureDirectory, provider, service };
}

async function waitForJob(
	service: SimulatorService,
	jobId: string,
	status: 'cancelled' | 'complete' | 'failed' = 'complete'
) {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		const job = service
			.getState()
			.jobs.find((candidate) => candidate.id === jobId);
		if (job?.status === status) return job;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Job ${jobId} did not reach ${status}.`);
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true }))
	);
});

describe('simulator service', () => {
	it('creates, boots, and opens only the device returned by Xcode', async () => {
		const provider = new FakeProvider();
		const originalRun = provider.runSimctl.getMockImplementation();
		provider.runSimctl.mockImplementation(async (args, options = {}) => {
			if (args[0] === 'create') {
				provider.deviceState = 'shutdown';
				return { stdout: `${UDID}\n`, stderr: '', exitCode: 0 };
			}
			if (!originalRun) throw new Error('Missing fake runner');
			return originalRun(args, options);
		});
		const { service } = await createService(provider);
		try {
			const receipt = service.runAction(
				parsedAction({
					actionId: 'create-and-open',
					kind: 'device.create',
					name: 'Example Review',
					deviceTypeIdentifier: DEVICE_TYPE,
					runtimeIdentifier: RUNTIME,
					bootAfterCreate: true,
				})
			);
			const job = await waitForJob(service, receipt.jobId ?? '');
			expect(job.deviceUdid).toBe(UDID);
			expect(provider.commands.map((command) => command.args)).toEqual([
				['boot', UDID],
				['bootstatus', UDID, '-b'],
			]);
			expect(provider.opened).toEqual([UDID]);
			expect(service.getState().devices[0]?.state).toBe('booted');
		} finally {
			await service.stop();
		}
	});

	it('does not boot a guessed target when create returns an invalid identifier', async () => {
		const { service, provider } = await createService();
		try {
			const receipt = service.runAction(
				parsedAction({
					actionId: 'invalid-created-id',
					kind: 'device.create',
					name: 'Example Review',
					deviceTypeIdentifier: DEVICE_TYPE,
					bootAfterCreate: true,
				})
			);
			const job = await waitForJob(service, receipt.jobId ?? '', 'failed');
			expect(job.message).toContain('did not return a valid device ID');
			expect(
				provider.commands.some((command) => command.args[0] === 'boot')
			).toBe(false);
			expect(provider.opened).toEqual([]);
		} finally {
			await service.stop();
		}
	});

	it('pauses idle scans while hidden and refreshes when visible again', async () => {
		vi.useFakeTimers();
		const { service, provider } = await createService();
		try {
			const metrics = vi.spyOn(service, 'refreshMetrics');
			provider.inventory.mockClear();
			service.setPollingActive(false);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(provider.inventory).not.toHaveBeenCalled();
			expect(metrics).not.toHaveBeenCalled();
			// Explicit user/recipe work must still function while background polling pauses.
			await service.refresh();
			expect(provider.inventory).toHaveBeenCalledTimes(1);
			service.setPollingActive(true);
			await vi.advanceTimersByTimeAsync(0);
			expect(provider.inventory).toHaveBeenCalledTimes(2);
			expect(metrics).toHaveBeenCalledTimes(1);
		} finally {
			await service.stop();
			vi.useRealTimers();
		}
	});

	it('resolves destructive confirmation copy from a fresh exact inventory', async () => {
		const provider = new FakeProvider();
		const { service } = await createService(provider);
		provider.deviceName = 'Fresh Example Target';
		expect(await service.resolveConfirmationTarget(UDID)).toEqual({
			name: 'Fresh Example Target',
			udid: UDID,
		});
		await expect(
			service.resolveConfirmationTarget(UNKNOWN_UDID)
		).rejects.toThrow('fresh inventory');
		await service.stop();
	});

	it('materializes and cleans an approved certificate only when its queued job runs', async () => {
		const { provider, service } = await createService();
		const cleanupMaterialized = vi.fn(async () => undefined);
		const materializeCertificatePath = vi.fn(async () => ({
			cleanup: cleanupMaterialized,
			path: '/private/example/certificate.cer',
		}));
		const cleanupSelectedInput = vi.fn(async () => undefined);
		const receipt = service.runAction(
			parsedAction({
				actionId: 'staged-root',
				kind: 'keychain.addCertificate',
				udid: UDID,
				trustRoot: true,
			}),
			{ cleanupSelectedInput, materializeCertificatePath }
		);
		await waitForJob(service, receipt.jobId ?? '');
		expect(materializeCertificatePath).toHaveBeenCalledOnce();
		expect(provider.commands.at(-1)).toEqual({
			args: [
				'keychain',
				UDID,
				'add-root-cert',
				'/private/example/certificate.cer',
			],
			options: expect.any(Object),
		});
		expect(cleanupMaterialized).toHaveBeenCalledOnce();
		await vi.waitFor(() => expect(cleanupSelectedInput).toHaveBeenCalledOnce());
		await service.stop();
	});

	it('cleans both certificate layers when the keychain command fails', async () => {
		const provider = new FakeProvider();
		provider.failKeychain = true;
		const { service } = await createService(provider);
		const cleanupMaterialized = vi.fn(async () => undefined);
		const cleanupSelectedInput = vi.fn(async () => undefined);
		const receipt = service.runAction(
			parsedAction({
				actionId: 'failed-staged-root',
				kind: 'keychain.addCertificate',
				udid: UDID,
				trustRoot: true,
			}),
			{
				cleanupSelectedInput,
				materializeCertificatePath: vi.fn(async () => ({
					cleanup: cleanupMaterialized,
					path: '/private/example/certificate.cer',
				})),
			}
		);
		await waitForJob(service, receipt.jobId ?? '', 'failed');
		expect(cleanupMaterialized).toHaveBeenCalledOnce();
		await vi.waitFor(() => expect(cleanupSelectedInput).toHaveBeenCalledOnce());
		await service.stop();
	});

	it('loads app inventory when a simulator first appears booted', async () => {
		const provider = new FakeProvider();
		const { service } = await createService(provider);
		expect(provider.listApps).toHaveBeenCalledWith(UDID, undefined);
		expect(service.getState().appsByDevice[UDID]).toEqual([
			expect.objectContaining({ bundleIdentifier: 'com.example.app' }),
		]);
		await service.stop();
	});

	it('rejects actions that the installed simctl does not advertise', async () => {
		const provider = new FakeProvider();
		provider.discover.mockResolvedValue({
			...AVAILABLE,
			features: { ...AVAILABLE.features, push: false },
		});
		const { service } = await createService(provider);
		const receipt = service.runAction(
			parsedAction({
				actionId: 'unsupported-push',
				kind: 'push.send',
				udid: UDID,
				bundleIdentifier: 'com.example.app',
				payloadJson: '{"aps":{}}',
			})
		);
		expect(receipt).toMatchObject({
			accepted: false,
			actionId: 'unsupported-push',
		});
		expect(provider.commands).toEqual([]);
		await service.stop();
	});

	it('discovers capabilities and uses exact inventory UDIDs for lifecycle actions', async () => {
		const provider = new FakeProvider();
		provider.deviceState = 'shutdown';
		const { service } = await createService(provider);
		const receipt = service.runAction(
			parsedAction({ actionId: 'boot-1', kind: 'device.boot', udid: UDID })
		);
		expect(receipt.accepted).toBe(true);
		await waitForJob(service, receipt.jobId ?? '');
		expect(provider.commands[0]?.args).toEqual(['boot', UDID]);
		expect(provider.commands[1]?.args).toEqual(['bootstatus', UDID, '-b']);
		expect(provider.opened).toEqual([UDID]);

		const unknown = service.runAction(
			parsedAction({
				actionId: 'boot-2',
				kind: 'device.boot',
				udid: UNKNOWN_UDID,
			})
		);
		await waitForJob(service, unknown.jobId ?? '', 'failed');
		expect(provider.commands).toHaveLength(2);
		await service.stop();
	});

	it('rejects a target removed from the fresh execution-time inventory', async () => {
		const provider = new FakeProvider();
		const { service } = await createService(provider);
		provider.inventory.mockResolvedValue({
			runtimes: [],
			deviceTypes: [],
			devices: [],
		});
		const receipt = service.runAction(
			parsedAction({ actionId: 'stale-target', kind: 'app.list', udid: UDID })
		);
		const failed = await waitForJob(service, receipt.jobId ?? '', 'failed');
		expect(failed.message).toBe(
			'Simulator is not present in the current inventory.'
		);
		expect(provider.listApps).toHaveBeenCalledTimes(1);
		await service.stop();
	});

	it('serializes inventory mutations even when their ordinary queue keys differ', async () => {
		const provider = new FakeProvider();
		const { service } = await createService(provider);
		let active = 0;
		let maxActive = 0;
		provider.runSimctl.mockImplementation(async (args) => {
			if (args[0] === 'create' || args[0] === 'rename') {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 25));
				active -= 1;
			}
			return { stdout: '', stderr: '', exitCode: 0 };
		});
		const create = service.runAction(
			parsedAction({
				actionId: 'create-concurrent',
				kind: 'device.create',
				name: 'Created lane',
				deviceTypeIdentifier: DEVICE_TYPE,
				runtimeIdentifier: RUNTIME,
			})
		);
		const rename = service.runAction(
			parsedAction({
				actionId: 'rename-concurrent',
				kind: 'device.rename',
				udid: UDID,
				name: 'Renamed lane',
			})
		);
		await Promise.all([
			waitForJob(service, create.jobId ?? ''),
			waitForJob(service, rename.jobId ?? ''),
		]);
		expect(maxActive).toBe(1);
		await service.stop();
	});

	it('forces capability rediscovery after the selected Xcode toolchain changes', async () => {
		const provider = new FakeProvider();
		const { service } = await createService(provider);
		provider.discover.mockResolvedValue({
			...AVAILABLE,
			xcodeVersion: '99.0',
			xcodeBuild: '99A1',
		});

		const state = await service.rediscover();
		expect(provider.discover).toHaveBeenCalledTimes(2);
		expect(state.capability).toMatchObject({
			status: 'available',
			xcodeVersion: '99.0',
			xcodeBuild: '99A1',
		});
		await service.stop();
	});

	it('fails fast when a fresh inventory still shows an erase target booted', async () => {
		const provider = new FakeProvider();
		const { service } = await createService(provider);
		const rejected = service.runAction(
			parsedAction({
				actionId: 'erase-booted',
				kind: 'device.erase',
				udid: UDID,
			})
		);
		const failed = await waitForJob(service, rejected.jobId ?? '', 'failed');
		expect(failed.message).toBe(
			'Simulator must be shut down before it can be erased.'
		);
		expect(provider.commands).toEqual([]);

		provider.deviceState = 'shutdown';
		const accepted = service.runAction(
			parsedAction({
				actionId: 'erase-shutdown',
				kind: 'device.erase',
				udid: UDID,
			})
		);
		await waitForJob(service, accepted.jobId ?? '');
		expect(provider.commands.map((command) => command.args)).toEqual([
			['erase', UDID],
		]);
		await service.stop();
	});

	it('inspects and cleans only fresh helper-planned disk categories', async () => {
		const provider = new FakeProvider();
		let planCall = 0;
		const planDiskCleanup = vi.fn(async () => {
			planCall += 1;
			return {
				simulatorId: UDID,
				totalBytes: 10_000,
				cleanableBytes: planCall >= 3 ? 1_000 : 4_000,
				categories: [
					{
						id: 'caches' as const,
						name: 'System & App Caches',
						description: 'Generated caches.',
						downside: 'Next launches may be slower.',
						recovery: 'Caches are rebuilt.',
						risk: 'Lower risk',
						defaultSelected: true,
						canClean: true,
						bytes: planCall >= 3 ? 1_000 : 4_000,
						targets: 2,
					},
					{
						id: 'required-siri-assets' as const,
						name: 'Required Siri Assets',
						description: 'System-managed assets.',
						downside: 'Cannot be cleaned.',
						recovery: 'System managed.',
						risk: 'System managed',
						defaultSelected: false,
						canClean: false,
						bytes: 2_000,
						targets: 1,
					},
				],
				storage: [
					{
						id: 'documents' as const,
						name: 'Documents',
						description: 'Durable app documents.',
						bytes: 3_000,
					},
				],
			};
		});
		const cleanDisk = vi.fn(async () => ({
			simulatorId: UDID,
			categoryIds: ['caches' as const],
			beforeBytes: 4_000,
			afterBytes: 1_000,
			reclaimedBytes: 3_000,
			wasBooted: true,
			bootStateRestored: true,
		}));
		const diskProvider: SimulatorDiskProvider = { cleanDisk, planDiskCleanup };
		const { service } = await createService(
			provider,
			undefined,
			undefined,
			undefined,
			undefined,
			diskProvider
		);

		const inspect = service.runAction(
			parsedAction({
				actionId: 'disk-inspect',
				kind: 'disk.inspect',
				udid: UDID,
			})
		);
		await waitForJob(service, inspect.jobId ?? '');
		expect(service.getState().diskByDevice[UDID]).toMatchObject({
			simulatorUdid: UDID,
			cleanableBytes: 4_000,
			categories: [{ id: 'caches', canClean: true }, { canClean: false }],
			storage: [{ id: 'documents', bytes: 3_000 }],
		});

		const cleanup = service.runAction(
			parsedAction({
				actionId: 'disk-cleanup',
				kind: 'disk.cleanup',
				udid: UDID,
				categoryIds: ['caches'],
			})
		);
		await waitForJob(service, cleanup.jobId ?? '');
		expect(cleanDisk).toHaveBeenCalledWith(
			UDID,
			['caches'],
			expect.any(AbortSignal)
		);
		expect(service.getState().diskByDevice[UDID]).toMatchObject({
			categories: [
				{ id: 'caches', bytes: 1_000 },
				{ id: 'required-siri-assets' },
			],
			lastCleanup: {
				categoryIds: ['caches'],
				reclaimedBytes: 3_000,
				bootStateRestored: true,
			},
		});
		await service.stop();
	});

	it('refuses to fall back to raw simctl clone when the trusted helper is unavailable', async () => {
		const provider = new FakeProvider();
		const { service } = await createService(provider);
		const receipt = service.runAction(
			parsedAction({
				actionId: 'clone-booted',
				kind: 'device.clone',
				udid: UDID,
				name: 'Example Clone',
			})
		);
		const job = await waitForJob(service, receipt.jobId ?? '', 'failed');
		expect(job.message).toContain('trusted pinned SimSlim clone helper');
		expect(provider.commands).toEqual([]);
		expect(provider.deviceState).toBe('booted');
		await service.stop();
	});

	it('routes production clone preparation through the pinned SimSlim helper', async () => {
		const provider = new FakeProvider();
		const cloneProvider: SimulatorCloneProvider = {
			cloneSimulator: vi.fn(async (simulatorId, name) => ({
				sourceSimulatorId: simulatorId,
				simulatorId: UNKNOWN_UDID,
				name,
			})),
		};
		const { service } = await createService(
			provider,
			undefined,
			undefined,
			undefined,
			cloneProvider
		);
		const receipt = service.runAction(
			parsedAction({
				actionId: 'clone-via-helper',
				kind: 'device.clone',
				udid: UDID,
				name: 'Example Clone',
			})
		);
		await waitForJob(service, receipt.jobId ?? '');
		expect(cloneProvider.cloneSimulator).toHaveBeenCalledWith(
			UDID,
			'Example Clone',
			expect.any(AbortSignal)
		);
		expect(provider.commands).toEqual([]);
		await service.stop();
	});

	it('maps deep-link, location, push, privacy, UI, status, and keychain actions to literals', async () => {
		const { provider, service } = await createService();
		const actions = [
			parsedAction({
				actionId: 'url',
				kind: 'url.open',
				udid: UDID,
				url: 'exampleappdevelopment://home?token=secret',
			}),
			parsedAction({
				actionId: 'universal-url',
				kind: 'app.openUniversalLink',
				udid: UDID,
				url: 'https://example.com/items/1',
			}),
			parsedAction({
				actionId: 'location',
				kind: 'location.set',
				udid: UDID,
				latitude: 37.7749,
				longitude: -122.4194,
			}),
			parsedAction({
				actionId: 'push',
				kind: 'push.send',
				udid: UDID,
				bundleIdentifier: 'com.example.app',
				payloadJson: '{"aps":{"alert":"Hello"}}',
			}),
			parsedAction({
				actionId: 'privacy',
				kind: 'privacy.update',
				udid: UDID,
				operation: 'grant',
				service: 'location',
				bundleIdentifier: 'com.example.app',
			}),
			parsedAction({
				actionId: 'ui',
				kind: 'ui.update',
				udid: UDID,
				setting: 'content_size',
				value: 'accessibility-large',
			}),
			parsedAction({
				actionId: 'status',
				kind: 'statusBar.override',
				udid: UDID,
				overrides: { time: '9:41', batteryLevel: 100 },
			}),
			parsedAction({
				actionId: 'keychain',
				kind: 'keychain.reset',
				udid: UDID,
			}),
		];
		for (const action of actions) {
			const receipt = service.runAction(action);
			await waitForJob(service, receipt.jobId ?? '');
		}

		expect(provider.commands.map((command) => command.args)).toEqual([
			['openurl', UDID, 'exampleappdevelopment://home?token=secret'],
			['openurl', UDID, 'https://example.com/items/1'],
			['location', UDID, 'set', '37.7749000,-122.4194000'],
			['push', UDID, 'com.example.app', '-'],
			['privacy', UDID, 'grant', 'location', 'com.example.app'],
			['ui', UDID, 'content_size', 'accessibility-large'],
			[
				'status_bar',
				UDID,
				'override',
				'--time',
				'9:41',
				'--batteryLevel',
				'100',
			],
			['keychain', UDID, 'reset'],
		]);
		expect(provider.commands[3]?.options.stdin).toBe(
			'{"aps":{"alert":"Hello"}}'
		);
		await service.stop();
	});

	it('rejects app-unscoped privacy reset at the backend boundary', async () => {
		const { provider, service } = await createService();
		expect(() =>
			service.runAction({
				actionId: 'privacy-global-reset',
				kind: 'privacy.update',
				udid: UDID,
				operation: 'reset',
				service: 'location',
			} as SimulatorAction)
		).toThrow();
		expect(provider.commands).toEqual([]);
		await service.stop();
	});

	it('launches apps with bounded locale and app environment overrides', async () => {
		const { provider, service } = await createService();
		const receipt = service.runAction(
			parsedAction({
				actionId: 'localized-launch',
				kind: 'app.launch',
				udid: UDID,
				bundleIdentifier: 'com.example.app',
				terminateRunning: true,
				arguments: ['--fixture', 'onboarding'],
				locale: 'fr_CA',
				languages: ['fr-CA', 'en'],
				timeZone: 'America/Vancouver',
				slowAnimations: true,
			})
		);
		await waitForJob(service, receipt.jobId ?? '');
		expect(provider.commands[0]).toEqual({
			args: [
				'launch',
				'--terminate-running-process',
				UDID,
				'com.example.app',
				'--fixture',
				'onboarding',
				'-AppleLanguages',
				'(fr-CA,en)',
				'-AppleLocale',
				'fr_CA',
			],
			options: expect.objectContaining({
				simulatorAppEnvironment: {
					timeZone: 'America/Vancouver',
					slowAnimations: true,
				},
			}),
		});
		await service.stop();
	});

	it('syncs pasteboards in either direction using exact simulator targets', async () => {
		const { provider, service } = await createService();
		for (const direction of [
			'host-to-simulator',
			'simulator-to-host',
		] as const) {
			const receipt = service.runAction(
				parsedAction({
					actionId: `pasteboard-${direction}`,
					kind: 'pasteboard.sync',
					udid: UDID,
					direction,
				})
			);
			await waitForJob(service, receipt.jobId ?? '');
		}
		expect(provider.commands.map((command) => command.args)).toEqual([
			['pbsync', 'host', UDID],
			['pbsync', UDID, 'host'],
		]);
		await service.stop();
	});

	it('reveals only a resolved container inside the exact simulator data root', async () => {
		const provider = new FakeProvider();
		const root = await mkdtemp(path.join(tmpdir(), 'rndevtools-container-'));
		temporaryDirectories.push(root);
		provider.containerPath = path.join(
			root,
			'CoreSimulator',
			'Devices',
			UDID,
			'data',
			'Containers',
			'Data',
			'Application',
			'container'
		);
		await mkdir(provider.containerPath, { recursive: true });
		const revealPath = vi.fn(async () => undefined);
		const dataRoot = await realpath(
			path.join(root, 'CoreSimulator', 'Devices', UDID, 'data')
		);
		const { service } = await createService(
			provider,
			revealPath,
			vi.fn(async () => dataRoot)
		);
		const receipt = service.runAction(
			parsedAction({
				actionId: 'reveal-data',
				kind: 'app.revealContainer',
				udid: UDID,
				bundleIdentifier: 'com.example.app',
				container: 'data',
			})
		);
		await waitForJob(service, receipt.jobId ?? '');
		expect(provider.commands[0]?.args).toEqual([
			'get_app_container',
			UDID,
			'com.example.app',
			'data',
		]);
		expect(revealPath).toHaveBeenCalledWith(
			await realpath(provider.containerPath),
			expect.any(AbortSignal)
		);

		provider.containerPath = path.join(root, 'outside-device-root');
		await mkdir(provider.containerPath);
		const escaped = service.runAction(
			parsedAction({
				actionId: 'reveal-escaped-data',
				kind: 'app.revealContainer',
				udid: UDID,
				bundleIdentifier: 'com.example.app',
				container: 'data',
			})
		);
		const escapedJob = await waitForJob(service, escaped.jobId ?? '', 'failed');
		expect(escapedJob.message).toContain(
			'escaped the selected device data root'
		);
		expect(revealPath).toHaveBeenCalledTimes(1);
		await service.stop();
	});

	it('parses and reveals every bounded App Group container entry', async () => {
		const provider = new FakeProvider();
		const root = await mkdtemp(path.join(tmpdir(), 'rndevtools-groups-'));
		temporaryDirectories.push(root);
		const dataRoot = path.join(root, 'CoreSimulator', 'Devices', UDID, 'data');
		const firstGroup = path.join(
			dataRoot,
			'Containers',
			'Shared',
			'AppGroup',
			'first'
		);
		const secondGroup = path.join(
			dataRoot,
			'Containers',
			'Shared',
			'AppGroup',
			'second'
		);
		await Promise.all([
			mkdir(firstGroup, { recursive: true }),
			mkdir(secondGroup, { recursive: true }),
		]);
		provider.containerPath = [
			`group.com.example.first\t${firstGroup}`,
			`group.com.example.second\t${secondGroup}`,
		].join('\n');
		const revealPath = vi.fn(async () => undefined);
		const { service } = await createService(
			provider,
			revealPath,
			vi.fn(async () => realpath(dataRoot))
		);
		const receipt = service.runAction(
			parsedAction({
				actionId: 'reveal-groups',
				kind: 'app.revealContainer',
				udid: UDID,
				bundleIdentifier: 'com.example.app',
				container: 'groups',
			})
		);
		await waitForJob(service, receipt.jobId ?? '');
		expect(revealPath).toHaveBeenNthCalledWith(
			1,
			await realpath(firstGroup),
			expect.any(AbortSignal)
		);
		expect(revealPath).toHaveBeenNthCalledWith(
			2,
			await realpath(secondGroup),
			expect.any(AbortSignal)
		);
		await service.stop();
	});

	it('imports bounded GPX coordinates through stdin and rejects XML entities', async () => {
		const { captureDirectory, provider, service } = await createService();
		const gpxPath = path.join(captureDirectory, 'route.gpx');
		await writeFile(
			gpxPath,
			'<gpx><trk><trkseg><trkpt lat="37.3317" lon="-122.0301"/><trkpt lat="37.3349" lon="-122.0090"/></trkseg></trk></gpx>'
		);
		const receipt = service.runAction(
			parsedAction({
				actionId: 'gpx-route',
				kind: 'location.importGpx',
				udid: UDID,
				speedMetersPerSecond: 4.5,
			}),
			{ selectedPath: gpxPath }
		);
		await waitForJob(service, receipt.jobId ?? '');
		expect(provider.commands[0]).toMatchObject({
			args: ['location', UDID, 'start', '--speed=4.5', '-'],
			options: {
				stdin: '37.3317000,-122.0301000\n37.3349000,-122.0090000\n',
				timeoutMs: 43_200_000,
				cancelSignal: 'SIGINT',
				signal: expect.any(AbortSignal),
			},
		});
		expect(JSON.stringify(provider.commands[0])).not.toContain(gpxPath);

		const unsafePath = path.join(captureDirectory, 'unsafe.gpx');
		await writeFile(
			unsafePath,
			'<!DOCTYPE gpx [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><gpx><wpt lat="0" lon="0"/><wpt lat="1" lon="1"/></gpx>'
		);
		const unsafe = service.runAction(
			parsedAction({
				actionId: 'unsafe-gpx',
				kind: 'location.importGpx',
				udid: UDID,
			}),
			{ selectedPath: unsafePath }
		);
		const failed = await waitForJob(service, unsafe.jobId ?? '', 'failed');
		expect(failed.message).toContain('entity declarations are not supported');
		expect(provider.commands).toHaveLength(1);

		const oversizedPath = path.join(captureDirectory, 'oversized.gpx');
		await writeFile(
			oversizedPath,
			`<gpx>${Array.from(
				{ length: 501 },
				(_, index) => `<wpt lat="0" lon="${index / 10_000}"/>`
			).join('')}</gpx>`
		);
		const oversized = service.runAction(
			parsedAction({
				actionId: 'oversized-gpx',
				kind: 'location.importGpx',
				udid: UDID,
			}),
			{ selectedPath: oversizedPath }
		);
		const oversizedFailure = await waitForJob(
			service,
			oversized.jobId ?? '',
			'failed'
		);
		expect(oversizedFailure.message).toContain('cannot exceed 500 waypoints');
		expect(provider.commands).toHaveLength(1);
		await service.stop();
	});

	it('validates push envelopes before they can enter the simulator queue', () => {
		expect(() =>
			parsedAction({
				actionId: 'bad-push',
				kind: 'push.send',
				udid: UDID,
				bundleIdentifier: 'com.example.app',
				payloadJson: '{"message":"missing aps"}',
			})
		).toThrow('aps object');
	});

	it('stores screenshot metadata without exposing capture paths', async () => {
		const { captureDirectory, service } = await createService();
		const receipt = service.runAction(
			parsedAction({
				actionId: 'screenshot',
				kind: 'capture.screenshot',
				udid: UDID,
				name: '../../Account',
			})
		);
		const job = await waitForJob(service, receipt.jobId ?? '');
		expect(job.captureId).toBeTruthy();
		expect(service.getState().captures).toEqual([
			expect.objectContaining({ kind: 'screenshot', bytes: 3 }),
		]);
		expect(JSON.stringify(service.getState())).not.toContain(captureDirectory);
		await service.stop();
	});

	it('composes a screenshot into a new opaque capture without exposing paths', async () => {
		const compose = vi.fn<SimulatorImageCompositor['compose']>(
			async ({ primaryPath, outputPath }, signal) => {
				expect(signal.aborted).toBe(false);
				expect(primaryPath).not.toBe(outputPath);
				await writeFile(outputPath, Buffer.from('composed-image'));
			}
		);
		const { captureDirectory, service } = await createService(
			new FakeProvider(),
			undefined,
			undefined,
			{ compose }
		);
		const screenshotReceipt = service.runAction(
			parsedAction({
				actionId: 'composition-source',
				kind: 'capture.screenshot',
				udid: UDID,
			})
		);
		const screenshotJob = await waitForJob(
			service,
			screenshotReceipt.jobId ?? ''
		);
		const sourceCaptureId = screenshotJob.captureId;
		expect(sourceCaptureId).toBeTruthy();

		const receipt = service.runAction(
			parsedAction({
				actionId: 'composition-output',
				kind: 'capture.compose',
				udid: UDID,
				primaryCaptureId: sourceCaptureId,
				name: 'App-Store-Preview',
				recipe: {
					outputFormat: 'png',
					canvas: {
						size: { mode: 'pixels', width: 1_290, height: 2_796 },
						background: { kind: 'solid', color: '#000000' },
					},
					layout: {
						padding: { top: 80, right: 80, bottom: 80, left: 80 },
						contentMode: 'fit',
						rotation: 0,
						cornerRadius: 48,
						bezel: 'rndevtools-generic-v1',
					},
				},
			})
		);
		const job = await waitForJob(service, receipt.jobId ?? '');
		expect(job.captureId).toBeTruthy();
		expect(job.captureId).not.toBe(sourceCaptureId);
		expect(compose).toHaveBeenCalledOnce();
		expect(service.getCapture(job.captureId ?? '')).toMatchObject({
			kind: 'screenshot',
			mimeType: 'image/png',
			bytes: 14,
		});
		expect(JSON.stringify(service.getState())).not.toContain(captureDirectory);
		await service.stop();
	});

	it('cancels recording jobs with a finalized capture', async () => {
		const provider = new FakeProvider();
		provider.blockVideo = true;
		const { service } = await createService(provider);
		const receipt = service.runAction(
			parsedAction({ actionId: 'video', kind: 'capture.video', udid: UDID })
		);
		const jobId = receipt.jobId ?? '';
		const deadline = Date.now() + 2_000;
		while (
			Date.now() < deadline &&
			service.getState().jobs.find((job) => job.id === jobId)?.status !==
				'running'
		) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(service.cancelJob(jobId)).toBe(true);
		const job = await waitForJob(service, jobId, 'cancelled');
		expect(job.captureId).toBeTruthy();
		expect(service.getState().captures[0]).toMatchObject({
			kind: 'video',
			bytes: 5,
		});
		await service.stop();
	});

	it('takes screenshots and lists apps while a recording runs, and queues a second recording behind it', async () => {
		const provider = new FakeProvider();
		provider.blockVideo = true;
		const { service } = await createService(provider);
		const status = (jobId: string | undefined) =>
			service.getState().jobs.find((job) => job.id === jobId)?.status;
		const recording = service.runAction(
			parsedAction({ actionId: 'video', kind: 'capture.video', udid: UDID })
		);
		await vi.waitFor(() => expect(status(recording.jobId)).toBe('running'));

		const screenshot = service.runAction(
			parsedAction({
				actionId: 'screenshot',
				kind: 'capture.screenshot',
				udid: UDID,
			})
		);
		const apps = service.runAction(
			parsedAction({ actionId: 'apps', kind: 'app.list', udid: UDID })
		);
		await waitForJob(service, screenshot.jobId ?? '');
		await waitForJob(service, apps.jobId ?? '');
		expect(status(recording.jobId)).toBe('running');

		const second = service.runAction(
			parsedAction({ actionId: 'video-2', kind: 'capture.video', udid: UDID })
		);
		expect(status(second.jobId)).toBe('queued');
		expect(service.cancelJob(recording.jobId ?? '')).toBe(true);
		await vi.waitFor(() => expect(status(second.jobId)).toBe('running'));
		await service.stop();
	});

	it('bounds the active job queue and finalizes queued work during shutdown', async () => {
		const provider = new FakeProvider();
		provider.blockVideo = true;
		const { service } = await createService(provider);
		for (let index = 0; index < 200; index += 1) {
			const receipt = service.runAction(
				parsedAction({
					actionId: `queued-video-${index}`,
					kind: 'capture.video',
					udid: UDID,
				})
			);
			expect(receipt.accepted).toBe(true);
		}
		const overflow = service.runAction(
			parsedAction({
				actionId: 'queue-overflow',
				kind: 'capture.video',
				udid: UDID,
			})
		);
		expect(overflow).toMatchObject({
			accepted: false,
			actionId: 'queue-overflow',
		});
		expect(service.getState().jobs).toHaveLength(200);
		await service.stop();
		expect(
			service.getState().jobs.every((job) => job.status === 'cancelled')
		).toBe(true);
	});
});

import { describe, expect, it, vi } from 'vitest';
import {
	developerDirectoryLabel,
	parseSimctlApps,
	parseSimctlFeatures,
	parseSimctlInventory,
	parseXcodeVersion,
	SimctlProvider,
} from './simctl-provider';
import { SimulatorCommandError } from './simulator-command-runner';

const RUNTIME = 'com.apple.CoreSimulator.SimRuntime.iOS-26-0';
const DEVICE_TYPE = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro';
const UDID = '11111111-2222-3333-4444-555555555555';

describe('simctl provider', () => {
	it('opens the legacy Simulator without trying DeviceHub when it succeeds', async () => {
		const run = vi
			.fn()
			.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
		const provider = new SimctlProvider({ run });
		await provider.openSimulator(UDID);
		expect(run).toHaveBeenCalledExactlyOnceWith(
			'/usr/bin/open',
			['-a', 'Simulator', '--args', '-CurrentDeviceUDID', UDID],
			{ timeoutMs: 15_000, maxOutputBytes: 64 * 1024 }
		);
	});

	it('falls back to the exact device URL in DeviceHub on Xcode 27', async () => {
		const signal = new AbortController().signal;
		const run = vi
			.fn()
			.mockRejectedValueOnce(
				new SimulatorCommandError(
					'Unable to find application named Simulator',
					{
						kind: 'failed',
						exitCode: 1,
					}
				)
			)
			.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });
		const provider = new SimctlProvider({ run });
		await provider.openSimulator(UDID, signal);
		expect(run).toHaveBeenCalledTimes(2);
		expect(run).toHaveBeenNthCalledWith(
			2,
			'/usr/bin/open',
			['-b', 'com.apple.dt.Devices', `devices://device/open?id=${UDID}`],
			{ signal, timeoutMs: 15_000, maxOutputBytes: 64 * 1024 }
		);
	});

	it.each(['aborted', 'output-limit', 'spawn', 'timeout'] as const)(
		'does not open DeviceHub after a %s failure',
		async (kind) => {
			const error = new SimulatorCommandError('Open failed', { kind });
			const run = vi.fn().mockRejectedValue(error);
			const provider = new SimctlProvider({ run });
			await expect(provider.openSimulator(UDID)).rejects.toBe(error);
			expect(run).toHaveBeenCalledTimes(1);
		}
	);

	it('does not start the DeviceHub fallback after cancellation', async () => {
		const controller = new AbortController();
		const error = new SimulatorCommandError('Simulator unavailable', {
			kind: 'failed',
		});
		const run = vi.fn().mockImplementation(async () => {
			controller.abort();
			throw error;
		});
		const provider = new SimctlProvider({ run });
		await expect(provider.openSimulator(UDID, controller.signal)).rejects.toBe(
			error
		);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it('reports a DeviceHub launch failure instead of claiming success', async () => {
		const error = new SimulatorCommandError('DeviceHub unavailable', {
			kind: 'failed',
			exitCode: 1,
		});
		const run = vi.fn().mockRejectedValue(error);
		const provider = new SimctlProvider({ run });
		await expect(provider.openSimulator(UDID)).rejects.toBe(error);
		expect(run).toHaveBeenCalledTimes(2);
	});

	it('rejects device URL parameters that are not an exact UDID', async () => {
		const run = vi.fn();
		const provider = new SimctlProvider({ run });
		await expect(provider.openSimulator(`${UDID}&other=value`)).rejects.toThrow(
			'Invalid simulator UDID.'
		);
		expect(run).not.toHaveBeenCalled();
	});

	it('parses bounded inventory without exposing simulator paths', () => {
		const inventory = parseSimctlInventory({
			runtimes: [
				{
					identifier: RUNTIME,
					name: 'iOS 26.0',
					version: '26.0',
					buildversion: '23A1',
					isAvailable: true,
					bundlePath: '/private/runtime',
				},
			],
			devicetypes: [
				{
					identifier: DEVICE_TYPE,
					name: 'iPhone 17 Pro',
					productFamily: 'iPhone',
					modelIdentifier: 'iPhone18,1',
					bundlePath: '/private/device-type',
				},
			],
			devices: {
				[RUNTIME]: [
					{
						udid: UDID,
						name: 'Example Test',
						state: 'Booted',
						isAvailable: true,
						deviceTypeIdentifier: DEVICE_TYPE,
						dataPath: '/private/device-data',
					},
				],
			},
		});

		expect(inventory.devices).toEqual([
			expect.objectContaining({ udid: UDID, state: 'booted' }),
		]);
		expect(JSON.stringify(inventory)).not.toContain('/private/');
	});

	it('drops invalid identifiers instead of forwarding them to actions', () => {
		const inventory = parseSimctlInventory({
			runtimes: [{ identifier: ';rm -rf /', name: 'Bad' }],
			devicetypes: [{ identifier: '../bad', name: 'Bad' }],
			devices: { [RUNTIME]: [{ udid: 'booted;whoami', name: 'Bad' }] },
		});
		expect(inventory).toEqual({ runtimes: [], deviceTypes: [], devices: [] });
	});

	it('excludes watchOS runtimes, devices, and device types from the iOS fleet', () => {
		const watchRuntime = 'com.apple.CoreSimulator.SimRuntime.watchOS-26-0';
		const watchType =
			'com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Series-11-46mm';
		const inventory = parseSimctlInventory({
			runtimes: [
				{ identifier: RUNTIME, name: 'iOS 26.0', isAvailable: true },
				{ identifier: watchRuntime, name: 'watchOS 26.0', isAvailable: true },
			],
			devicetypes: [
				{
					identifier: DEVICE_TYPE,
					name: 'iPhone 17 Pro',
					productFamily: 'iPhone',
				},
				{
					identifier: watchType,
					name: 'Apple Watch Series 11',
					productFamily: 'Apple Watch',
				},
			],
			devices: {
				[RUNTIME]: [
					{
						udid: UDID,
						name: 'iPhone',
						state: 'Shutdown',
						isAvailable: true,
						deviceTypeIdentifier: DEVICE_TYPE,
					},
				],
				[watchRuntime]: [
					{
						udid: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
						name: 'Watch',
						state: 'Shutdown',
						isAvailable: true,
						deviceTypeIdentifier: watchType,
					},
				],
			},
		});
		expect(inventory.runtimes.map((runtime) => runtime.identifier)).toEqual([
			RUNTIME,
		]);
		expect(inventory.devices.map((device) => device.udid)).toEqual([UDID]);
		expect(
			inventory.deviceTypes.map((deviceType) => deviceType.identifier)
		).toEqual([DEVICE_TYPE]);
	});

	it('projects app metadata while omitting container and bundle paths', () => {
		const apps = parseSimctlApps({
			'com.example.app': {
				CFBundleIdentifier: 'com.example.app',
				CFBundleDisplayName: 'ExampleApp',
				CFBundleShortVersionString: '1.2.3',
				CFBundleVersion: '42',
				ApplicationType: 'User',
				Bundle: '/private/ExampleApp.app',
				DataContainer: '/private/data',
			},
		});
		expect(apps).toEqual([
			{
				bundleIdentifier: 'com.example.app',
				displayName: 'ExampleApp',
				version: '1.2.3',
				buildVersion: '42',
				applicationType: 'User',
				isSystem: false,
			},
		]);
		expect(JSON.stringify(apps)).not.toContain('/private/');
	});

	it('reports an explicit unsupported-platform capability without spawning', async () => {
		const run = vi.fn();
		const provider = new SimctlProvider({
			platform: 'linux',
			architecture: 'x64',
			run,
		});
		await expect(provider.discover()).resolves.toMatchObject({
			status: 'unavailable',
			platform: 'linux',
			licenseStatus: 'unknown',
			hostArchitecture: 'x64',
			runtimeAvailability: { total: 0, available: 0 },
			features: { deviceManagement: false, screenshot: false },
		});
		expect(run).not.toHaveBeenCalled();
	});

	it('projects Xcode build and selected developer directory without exposing a path', () => {
		expect(parseXcodeVersion('Xcode 26.5\nBuild version 17F113\n')).toEqual({
			xcodeVersion: '26.5',
			xcodeBuild: '17F113',
		});
		expect(
			developerDirectoryLabel(
				'/Applications/Xcode-beta.app/Contents/Developer\n'
			)
		).toBe('Xcode-beta.app (selected)');
		expect(
			developerDirectoryLabel('/Library/Developer/CommandLineTools\n')
		).toBe('Command Line Tools (selected)');
	});

	it('derives feature support from the installed simctl command list', () => {
		const capability = parseSimctlFeatures(`
Subcommands:
    boot                Boot a device.
    clone               Clone a device.
    create              Create a device.
    delete              Delete a device.
    erase               Erase a device.
    list                List devices.
    rename              Rename a device.
    shutdown            Shut down a device.
    install             Install an app.
    launch              Launch an app.
    listapps            List apps.
    terminate           Terminate an app.
    uninstall           Uninstall an app.
    openurl             Open a URL.
    location            Control location.
    push                Send a push.
    privacy             Change privacy.
    ui                  Change UI.
    status_bar          Change status bar.
    io                  Capture media.
`);
		expect(capability).toMatchObject({
			deviceManagement: true,
			apps: true,
			deepLinks: true,
			location: true,
			push: true,
			privacy: true,
			ui: true,
			statusBar: true,
			keychain: false,
			screenshot: true,
			video: true,
		});
	});
});

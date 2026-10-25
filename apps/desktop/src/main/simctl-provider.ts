import { diagnosticErrorText } from '@rndevtools/core/redact';
import type {
	SimulatorApp,
	SimulatorCapability,
	SimulatorDevice,
	SimulatorDeviceType,
	SimulatorRuntime,
} from '../shared/simulator-protocol';
import { UDID_PATTERN } from '../shared/simulator-protocol';
import {
	runSimulatorCommand,
	SimulatorCommandError,
	type SimulatorCommandOptions,
	type SimulatorCommandResult,
} from './simulator-command-runner';

const XCRUN_PATH = '/usr/bin/xcrun';
const XCODE_SELECT_PATH = '/usr/bin/xcode-select';
const XCODEBUILD_PATH = '/usr/bin/xcodebuild';
const PLUTIL_PATH = '/usr/bin/plutil';
const OPEN_PATH = '/usr/bin/open';
const MAX_INVENTORY_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_LENGTH = 4 * 1024;
const MAX_RUNTIME_ITEMS = 500;
const MAX_DEVICE_TYPE_ITEMS = 500;
const MAX_DEVICE_ITEMS = 2_000;
const IOS_RUNTIME_PATTERN =
	/^com\.apple\.CoreSimulator\.SimRuntime\.iOS-[A-Za-z0-9.-]+$/;
const DEVICE_TYPE_PATTERN =
	/^com\.apple\.CoreSimulator\.SimDeviceType\.[A-Za-z0-9.-]+$/;
const BUNDLE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;

type CommandRunner = typeof runSimulatorCommand;

export type SimctlInventory = {
	runtimes: SimulatorRuntime[];
	deviceTypes: SimulatorDeviceType[];
	devices: SimulatorDevice[];
};

function dataRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function boundedString(
	value: unknown,
	maxLength = MAX_TEXT_LENGTH
): string | undefined {
	return typeof value === 'string' && value.length <= maxLength
		? value
		: undefined;
}

function validString(value: unknown, pattern: RegExp): string | undefined {
	const text = boundedString(value, 512);
	return text && pattern.test(text) ? text : undefined;
}

function availability(record: Record<string, unknown>): {
	isAvailable: boolean;
	availabilityError?: string;
} {
	const availabilityError = boundedString(record.availabilityError);
	return {
		isAvailable: record.isAvailable !== false && !availabilityError,
		...(availabilityError ? { availabilityError } : {}),
	};
}

function normalizeDeviceState(value: unknown): SimulatorDevice['state'] {
	if (typeof value !== 'string') return 'unknown';
	switch (value.toLowerCase().replaceAll(/[^a-z]/g, '')) {
		case 'booted':
			return 'booted';
		case 'shutdown':
			return 'shutdown';
		case 'booting':
			return 'booting';
		case 'shuttingdown':
			return 'shuttingDown';
		case 'creating':
			return 'creating';
		default:
			return 'unknown';
	}
}

export function parseSimctlInventory(value: unknown): SimctlInventory {
	const root = dataRecord(value);
	if (!root) throw new Error('simctl inventory was not an object.');
	const runtimes: SimulatorRuntime[] = [];
	for (const value of Array.isArray(root.runtimes)
		? root.runtimes.slice(0, MAX_RUNTIME_ITEMS)
		: []) {
		const record = dataRecord(value);
		if (!record) continue;
		const identifier = validString(record.identifier, IOS_RUNTIME_PATTERN);
		const name = boundedString(record.name);
		if (!identifier || !name) continue;
		runtimes.push({
			identifier,
			name,
			...availability(record),
			...(boundedString(record.version)
				? { version: boundedString(record.version) }
				: {}),
			...(boundedString(record.buildversion)
				? { buildVersion: boundedString(record.buildversion) }
				: {}),
		});
	}

	const deviceTypeCandidates: SimulatorDeviceType[] = [];
	for (const value of Array.isArray(root.devicetypes)
		? root.devicetypes.slice(0, MAX_DEVICE_TYPE_ITEMS)
		: []) {
		const record = dataRecord(value);
		if (!record) continue;
		const identifier = validString(record.identifier, DEVICE_TYPE_PATTERN);
		const name = boundedString(record.name);
		if (!identifier || !name) continue;
		const productFamily = boundedString(record.productFamily);
		const modelIdentifier = boundedString(record.modelIdentifier);
		deviceTypeCandidates.push({
			identifier,
			name,
			...(productFamily ? { productFamily } : {}),
			...(modelIdentifier ? { modelIdentifier } : {}),
		});
	}

	const devices: SimulatorDevice[] = [];
	const retainedRuntimeIdentifiers = new Set(
		runtimes.map((runtime) => runtime.identifier)
	);
	const devicesByRuntime = dataRecord(root.devices);
	for (const [runtimeIdentifier, rawDevices] of Object.entries(
		devicesByRuntime ?? {}
	)) {
		if (
			!retainedRuntimeIdentifiers.has(runtimeIdentifier) ||
			!Array.isArray(rawDevices)
		)
			continue;
		for (const value of rawDevices.slice(
			0,
			MAX_DEVICE_ITEMS - devices.length
		)) {
			const record = dataRecord(value);
			if (!record) continue;
			const udid = validString(record.udid, UDID_PATTERN);
			const name = boundedString(record.name);
			if (!udid || !name) continue;
			const deviceTypeIdentifier = validString(
				record.deviceTypeIdentifier,
				DEVICE_TYPE_PATTERN
			);
			devices.push({
				udid,
				name,
				state: normalizeDeviceState(record.state),
				runtimeIdentifier,
				...availability(record),
				...(deviceTypeIdentifier ? { deviceTypeIdentifier } : {}),
			});
		}
		if (devices.length >= MAX_DEVICE_ITEMS) break;
	}
	const referencedDeviceTypes = new Set(
		devices.flatMap((device) =>
			device.deviceTypeIdentifier ? [device.deviceTypeIdentifier] : []
		)
	);
	const deviceTypes = deviceTypeCandidates.filter((deviceType) => {
		const family = deviceType.productFamily?.toLowerCase();
		return (
			family === 'iphone' ||
			family === 'ipad' ||
			referencedDeviceTypes.has(deviceType.identifier)
		);
	});

	return {
		runtimes: runtimes.sort((left, right) =>
			left.name.localeCompare(right.name)
		),
		deviceTypes: deviceTypes.sort((left, right) =>
			left.name.localeCompare(right.name)
		),
		devices: devices.sort(
			(left, right) =>
				Number(right.state === 'booted') - Number(left.state === 'booted') ||
				left.name.localeCompare(right.name)
		),
	};
}

export function parseSimctlApps(value: unknown): SimulatorApp[] {
	const root = dataRecord(value);
	if (!root) throw new Error('simctl app inventory was not an object.');
	const apps: SimulatorApp[] = [];
	for (const [key, value] of Object.entries(root).slice(0, 5_000)) {
		const record = dataRecord(value);
		if (!record) continue;
		const bundleIdentifier =
			boundedString(record.CFBundleIdentifier, 255) ?? boundedString(key, 255);
		if (!bundleIdentifier || !BUNDLE_IDENTIFIER_PATTERN.test(bundleIdentifier))
			continue;
		const displayName =
			boundedString(record.CFBundleDisplayName) ??
			boundedString(record.CFBundleName) ??
			bundleIdentifier;
		const version = boundedString(record.CFBundleShortVersionString);
		const buildVersion = boundedString(record.CFBundleVersion);
		const applicationType = boundedString(record.ApplicationType);
		apps.push({
			bundleIdentifier,
			displayName,
			...(version ? { version } : {}),
			...(buildVersion ? { buildVersion } : {}),
			...(applicationType ? { applicationType } : {}),
			isSystem: applicationType?.toLowerCase() === 'system',
		});
	}
	return apps.sort(
		(left, right) =>
			Number(left.isSystem) - Number(right.isSystem) ||
			left.displayName.localeCompare(right.displayName)
	);
}

function platformName(
	platform: NodeJS.Platform
): SimulatorCapability['platform'] {
	if (platform === 'darwin' || platform === 'win32' || platform === 'linux') {
		return platform;
	}
	return 'other';
}

function hostArchitecture(
	architecture: NodeJS.Architecture
): SimulatorCapability['hostArchitecture'] {
	if (architecture === 'arm64' || architecture === 'x64') return architecture;
	return 'other';
}

export function developerDirectoryLabel(output: string): string | undefined {
	const selected = output.trim();
	if (!selected.startsWith('/') || selected.length > MAX_TEXT_LENGTH)
		return undefined;
	const application = selected
		.split('/')
		.find((component) => component.toLowerCase().endsWith('.app'));
	return application
		? `${application} (selected)`
		: 'Command Line Tools (selected)';
}

export function parseXcodeVersion(output: string): {
	xcodeVersion?: string;
	xcodeBuild?: string;
} {
	const version = output.match(/^Xcode\s+([^\r\n]+)$/m)?.[1]?.trim();
	const build = output.match(/^Build version\s+([^\r\n]+)$/m)?.[1]?.trim();
	return {
		...(version ? { xcodeVersion: version.slice(0, MAX_TEXT_LENGTH) } : {}),
		...(build ? { xcodeBuild: build.slice(0, MAX_TEXT_LENGTH) } : {}),
	};
}

function features(enabled: boolean): SimulatorCapability['features'] {
	return {
		deviceManagement: enabled,
		apps: enabled,
		deepLinks: enabled,
		location: enabled,
		push: enabled,
		privacy: enabled,
		ui: enabled,
		statusBar: enabled,
		keychain: enabled,
		screenshot: enabled,
		video: enabled,
	};
}

export function parseSimctlFeatures(
	helpText: string
): SimulatorCapability['features'] {
	const commands = new Set(
		[...helpText.matchAll(/^\s+([a-z_]+)\s+/gm)]
			.map((match) => match[1])
			.filter((command): command is string => command !== undefined)
	);
	const has = (...required: string[]) =>
		required.every((command) => commands.has(command));
	return {
		deviceManagement: has(
			'boot',
			'clone',
			'create',
			'delete',
			'erase',
			'list',
			'rename',
			'shutdown'
		),
		apps: has('install', 'launch', 'listapps', 'terminate', 'uninstall'),
		deepLinks: has('openurl'),
		location: has('location'),
		push: has('push'),
		privacy: has('privacy'),
		ui: has('ui'),
		statusBar: has('status_bar'),
		keychain: has('keychain'),
		screenshot: has('io'),
		video: has('io'),
	};
}

function discoveryError(error: unknown): string {
	return diagnosticErrorText(error).slice(0, MAX_TEXT_LENGTH);
}

export class SimctlProvider {
	readonly #platform: NodeJS.Platform;
	readonly #architecture: NodeJS.Architecture;
	readonly #run: CommandRunner;

	constructor({
		platform = process.platform,
		architecture = process.arch,
		run = runSimulatorCommand,
	}: {
		platform?: NodeJS.Platform;
		architecture?: NodeJS.Architecture;
		run?: CommandRunner;
	} = {}) {
		this.#platform = platform;
		this.#architecture = architecture;
		this.#run = run;
	}

	async discover(): Promise<SimulatorCapability> {
		const platform = platformName(this.#platform);
		let discoveredLicenseStatus: SimulatorCapability['licenseStatus'] =
			'unknown';
		if (this.#platform !== 'darwin') {
			return {
				status: 'unavailable',
				platform,
				licenseStatus: 'unknown',
				hostArchitecture: hostArchitecture(this.#architecture),
				runtimeAvailability: { total: 0, available: 0 },
				features: features(false),
				error: 'Apple Simulator controls require macOS and Xcode.',
			};
		}
		try {
			const located = await this.#run(XCRUN_PATH, ['--find', 'simctl'], {
				timeoutMs: 10_000,
				maxOutputBytes: 64 * 1024,
			});
			if (!located.stdout.trim().startsWith('/')) {
				throw new Error('xcrun returned an invalid simctl location.');
			}
			const [version, help, selectedDirectory, license] =
				await Promise.allSettled([
					this.#run(XCODEBUILD_PATH, ['-version'], {
						timeoutMs: 10_000,
						maxOutputBytes: 64 * 1024,
					}),
					this.#run(XCRUN_PATH, ['simctl', 'help'], {
						timeoutMs: 10_000,
						maxOutputBytes: 256 * 1024,
					}),
					this.#run(XCODE_SELECT_PATH, ['-p'], {
						timeoutMs: 10_000,
						maxOutputBytes: 64 * 1024,
					}),
					this.#run(XCODEBUILD_PATH, ['-checkFirstLaunchStatus'], {
						timeoutMs: 30_000,
						maxOutputBytes: 64 * 1024,
					}),
				]);
			discoveredLicenseStatus =
				license.status === 'fulfilled'
					? 'accepted'
					: license.reason instanceof SimulatorCommandError &&
							license.reason.kind === 'failed'
						? 'required'
						: 'unknown';
			if (version.status !== 'fulfilled' || help.status !== 'fulfilled') {
				throw new Error('Xcode version or simctl help discovery failed.');
			}
			const discoveredFeatures = parseSimctlFeatures(help.value.stdout);
			if (!discoveredFeatures.deviceManagement) {
				throw new Error(
					'The installed simctl does not expose required device commands.'
				);
			}
			const parsedVersion = parseXcodeVersion(version.value.stdout);
			return {
				status: 'available',
				platform,
				...parsedVersion,
				...(selectedDirectory.status === 'fulfilled' &&
				developerDirectoryLabel(selectedDirectory.value.stdout)
					? {
							selectedDeveloperDirectoryLabel: developerDirectoryLabel(
								selectedDirectory.value.stdout
							),
						}
					: {}),
				licenseStatus: discoveredLicenseStatus,
				hostArchitecture: hostArchitecture(this.#architecture),
				runtimeAvailability: { total: 0, available: 0 },
				features: discoveredFeatures,
			};
		} catch (error) {
			return {
				status: 'unavailable',
				platform,
				licenseStatus: discoveredLicenseStatus,
				hostArchitecture: hostArchitecture(this.#architecture),
				runtimeAvailability: { total: 0, available: 0 },
				features: features(false),
				error: discoveryError(error),
			};
		}
	}

	async inventory(signal?: AbortSignal): Promise<SimctlInventory> {
		const result = await this.runSimctl(['list', '--json'], {
			...(signal ? { signal } : {}),
			timeoutMs: 30_000,
			maxOutputBytes: MAX_INVENTORY_BYTES,
		});
		return parseSimctlInventory(JSON.parse(result.stdout));
	}

	async listApps(udid: string, signal?: AbortSignal): Promise<SimulatorApp[]> {
		const result = await this.runSimctl(['listapps', udid], {
			...(signal ? { signal } : {}),
			timeoutMs: 30_000,
			maxOutputBytes: MAX_INVENTORY_BYTES,
		});
		const json = await this.#run(
			PLUTIL_PATH,
			['-convert', 'json', '-o', '-', '--', '-'],
			{
				stdin: result.stdout,
				...(signal ? { signal } : {}),
				timeoutMs: 10_000,
				maxOutputBytes: MAX_INVENTORY_BYTES,
			}
		);
		return parseSimctlApps(JSON.parse(json.stdout));
	}

	runSimctl(
		args: readonly string[],
		options: SimulatorCommandOptions = {}
	): Promise<SimulatorCommandResult> {
		return this.#run(XCRUN_PATH, ['simctl', ...args], options);
	}

	async openSimulator(udid: string, signal?: AbortSignal): Promise<void> {
		if (!UDID_PATTERN.test(udid)) {
			throw new Error('Invalid simulator UDID.');
		}
		const options: SimulatorCommandOptions = {
			...(signal ? { signal } : {}),
			timeoutMs: 15_000,
			maxOutputBytes: 64 * 1024,
		};
		try {
			await this.#run(
				OPEN_PATH,
				['-a', 'Simulator', '--args', '-CurrentDeviceUDID', udid],
				options
			);
		} catch (error) {
			if (
				signal?.aborted ||
				!(error instanceof SimulatorCommandError) ||
				error.kind !== 'failed'
			) {
				throw error;
			}
			// Xcode 27 replaces Simulator.app with DeviceHub. Its URL selects
			// the exact device even when the application is already running.
			await this.#run(
				OPEN_PATH,
				['-b', 'com.apple.dt.Devices', `devices://device/open?id=${udid}`],
				options
			);
		}
	}
}

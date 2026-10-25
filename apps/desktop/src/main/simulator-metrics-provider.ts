import { diagnosticErrorText } from '@rndevtools/core/redact';
import type {
	SimulatorDevice,
	SimulatorDeviceMetrics,
	SimulatorMetrics,
	SimulatorProcessMetric,
} from '../shared/simulator-protocol';
import { UDID_PATTERN } from '../shared/simulator-protocol';
import { runSimulatorCommand } from './simulator-command-runner';

const XCRUN_PATH = '/usr/bin/xcrun';
const MEMORY_PRESSURE_PATH = '/usr/bin/memory_pressure';
const PS_PATH = '/bin/ps';
const TOP_PATH = '/usr/bin/top';
const MAX_BOOTED_DEVICES = 20;
const MAX_PROCESSES_PER_DEVICE = 100;
const MAX_LAUNCHCTL_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_PS_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_TOP_OUTPUT_BYTES = 4 * 1024 * 1024;
const FOOTPRINT_UNIT_BYTES: Readonly<Record<string, number>> = {
	'': 1,
	B: 1,
	K: 1024,
	M: 1024 ** 2,
	G: 1024 ** 3,
};
const MAX_DISK_OUTPUT_BYTES = 16 * 1024 * 1024;
const DISK_REFRESH_INTERVAL_MS = 30_000;
const SERVICE_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._\-[\]]{1,255}$/;
const BUNDLE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;

type ServiceProcess = {
	processId: number;
	label: string;
	bundleIdentifier?: string;
};

type ProcessSample = {
	processId: number;
	cpuPercent: number;
};

export function parseHostMemoryPressure(
	output: string
): NonNullable<SimulatorMetrics['host']> {
	const totalMatch = output.match(/system has (\d+)\s/i);
	const freeMatch = output.match(/memory free percentage:\s*(\d+(?:\.\d+)?)%/i);
	const totalMemoryBytes = Number(totalMatch?.[1]);
	const freePercent = Number(freeMatch?.[1]);
	if (
		!Number.isSafeInteger(totalMemoryBytes) ||
		totalMemoryBytes <= 0 ||
		!Number.isFinite(freePercent) ||
		freePercent < 0 ||
		freePercent > 100
	) {
		throw new Error('memory_pressure returned an unsupported response.');
	}
	const freeMemoryBytes = Math.round(totalMemoryBytes * (freePercent / 100));
	return {
		memoryPressure:
			freePercent <= 5 ? 'critical' : freePercent <= 15 ? 'warning' : 'normal',
		totalMemoryBytes,
		freeMemoryBytes,
		usedMemoryBytes: Math.max(0, totalMemoryBytes - freeMemoryBytes),
		freePercent,
	};
}

export function parseSimulatorServiceProcesses(
	output: string
): ServiceProcess[] {
	const lines = output.split(/\r?\n/);
	const servicesStart = lines.findIndex((line) =>
		/^\s*services\s*=\s*\{\s*$/.test(line)
	);
	if (servicesStart < 0)
		throw new Error('launchctl did not return a services projection.');
	const processes: ServiceProcess[] = [];
	const seen = new Set<number>();
	for (const line of lines.slice(servicesStart + 1)) {
		if (/^\s*}\s*$/.test(line)) break;
		const match = line.match(
			/^\s*(\d+)\s+(?:\([a-z]+\)|-|\d+)\s+([^\s]+)\s*$/i
		);
		if (!match) continue;
		const processId = Number(match[1]);
		const label = match[2];
		if (
			!Number.isSafeInteger(processId) ||
			processId <= 0 ||
			processId > 2_147_483_647 ||
			!label ||
			!SERVICE_LABEL_PATTERN.test(label) ||
			seen.has(processId)
		) {
			continue;
		}
		seen.add(processId);
		const bundleMatch = label.match(
			/^UIKitApplication:([A-Za-z0-9][A-Za-z0-9.-]*)\[/
		);
		const bundleIdentifier = bundleMatch?.[1];
		processes.push({
			processId,
			label,
			...(bundleIdentifier && BUNDLE_IDENTIFIER_PATTERN.test(bundleIdentifier)
				? { bundleIdentifier }
				: {}),
		});
		if (processes.length >= MAX_PROCESSES_PER_DEVICE * 100) break;
	}
	return processes;
}

export function parseProcessSamples(
	output: string
): Map<number, ProcessSample> {
	const samples = new Map<number, ProcessSample>();
	for (const line of output.split(/\r?\n/)) {
		const match = line.match(/^\s*(\d+)\s+([0-9.]+)(?:\s|$)/);
		if (!match) continue;
		const processId = Number(match[1]);
		const cpuPercent = Number(match[2]);
		if (
			!Number.isSafeInteger(processId) ||
			processId <= 0 ||
			!Number.isFinite(cpuPercent) ||
			cpuPercent < 0
		) {
			continue;
		}
		samples.set(processId, {
			processId,
			cpuPercent: Math.min(cpuPercent, 10_000),
		});
	}
	return samples;
}

/**
 * Memory comes from `top`'s MEM column, the kernel's physical footprint of each
 * process, not from `ps` RSS. RSS counts every resident page including the
 * dyld shared cache and system frameworks that all ~200 Simulator processes
 * map, so summing it across a device tree overstated memory three- to
 * four-fold (19.5 GB for a Simulator whose footprint was 5.3 GB). Footprint is
 * also what the embedded SimSlim core measures, so Fleet and Slimming agree.
 */
export function parseProcessFootprints(output: string): Map<number, number> {
	const footprints = new Map<number, number>();
	for (const line of output.split(/\r?\n/)) {
		const match = line.match(/^\s*(\d+)\s+(\d+(?:\.\d+)?)([KMGB]?)\+?\s*$/);
		if (!match) continue;
		const processId = Number(match[1]);
		const value = Number(match[2]);
		const unit = FOOTPRINT_UNIT_BYTES[match[3] ?? ''];
		if (
			!Number.isSafeInteger(processId) ||
			processId <= 0 ||
			!Number.isFinite(value) ||
			value < 0 ||
			unit === undefined
		) {
			continue;
		}
		const bytes = Math.round(value * unit);
		if (!Number.isSafeInteger(bytes)) continue;
		footprints.set(processId, bytes);
	}
	return footprints;
}

export function parseSimulatorDiskAllocations(
	output: string
): Map<string, number> {
	const root = JSON.parse(output) as unknown;
	if (!root || typeof root !== 'object' || Array.isArray(root)) {
		throw new Error('simctl disk inventory was not an object.');
	}
	const devices = (root as Record<string, unknown>).devices;
	if (!devices || typeof devices !== 'object' || Array.isArray(devices)) {
		throw new Error('simctl disk inventory omitted devices.');
	}
	const allocations = new Map<string, number>();
	for (const rawDevices of Object.values(devices as Record<string, unknown>)) {
		if (!Array.isArray(rawDevices)) continue;
		for (const value of rawDevices.slice(0, 2_000)) {
			if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
			const record = value as Record<string, unknown>;
			const udid = record.udid;
			const dataBytes = record.dataPathSize;
			const logBytes = record.logPathSize;
			if (
				typeof udid !== 'string' ||
				!UDID_PATTERN.test(udid) ||
				!Number.isSafeInteger(dataBytes) ||
				(dataBytes as number) < 0 ||
				(logBytes !== undefined &&
					(!Number.isSafeInteger(logBytes) || (logBytes as number) < 0))
			) {
				continue;
			}
			allocations.set(
				udid,
				(dataBytes as number) + ((logBytes as number | undefined) ?? 0)
			);
		}
	}
	return allocations;
}

function safeError(error: unknown): string {
	return diagnosticErrorText(error).slice(0, 4 * 1024);
}

export class SimulatorMetricsProvider {
	readonly #platform: NodeJS.Platform;
	readonly #now: () => number;
	#diskAllocations = new Map<string, number>();
	#diskSampledAt = 0;

	constructor({
		platform = process.platform,
		now = Date.now,
	}: { platform?: NodeJS.Platform; now?: () => number } = {}) {
		this.#platform = platform;
		this.#now = now;
	}

	async sample(
		devices: readonly SimulatorDevice[],
		signal?: AbortSignal
	): Promise<SimulatorMetrics> {
		if (this.#platform !== 'darwin') {
			return {
				status: 'unavailable',
				byDevice: {},
				error: 'Simulator process metrics require macOS and Xcode.',
			};
		}
		const sampledAt = this.#now();
		const commandOptions = signal ? { signal } : {};
		try {
			const diskPromise = this.#refreshDiskAllocations(sampledAt, signal).catch(
				() => undefined
			);
			const memoryPromise = runSimulatorCommand(MEMORY_PRESSURE_PATH, ['-Q'], {
				...commandOptions,
				timeoutMs: 5_000,
				maxOutputBytes: 64 * 1024,
			});
			const psPromise = runSimulatorCommand(PS_PATH, ['-axo', 'pid=,pcpu='], {
				...commandOptions,
				timeoutMs: 5_000,
				maxOutputBytes: MAX_PS_OUTPUT_BYTES,
			});
			const topPromise = runSimulatorCommand(
				TOP_PATH,
				['-l', '1', '-stats', 'pid,mem'],
				{
					...commandOptions,
					timeoutMs: 10_000,
					maxOutputBytes: MAX_TOP_OUTPUT_BYTES,
				}
			);
			// Attach rejection handlers before awaiting slower per-device probes. A
			// cancelled host command must not become an unhandled rejection in main.
			const hostSamples = Promise.allSettled([
				memoryPromise,
				psPromise,
				topPromise,
			]);
			const booted = devices
				.filter((device) => device.state === 'booted' && device.isAvailable)
				.slice(0, MAX_BOOTED_DEVICES);
			const serviceResults = new Map<string, ServiceProcess[] | Error>();
			for (let index = 0; index < booted.length; index += 4) {
				const group = booted.slice(index, index + 4);
				const results = await Promise.allSettled(
					group.map((device) =>
						runSimulatorCommand(
							XCRUN_PATH,
							[
								'simctl',
								'spawn',
								device.udid,
								'launchctl',
								'print',
								`user/${typeof process.getuid === 'function' ? process.getuid() : 501}`,
							],
							{
								...commandOptions,
								timeoutMs: 8_000,
								maxOutputBytes: MAX_LAUNCHCTL_OUTPUT_BYTES,
							}
						)
					)
				);
				for (let offset = 0; offset < group.length; offset += 1) {
					const device = group[offset];
					const result = results[offset];
					if (!device || !result) continue;
					try {
						serviceResults.set(
							device.udid,
							result.status === 'fulfilled'
								? parseSimulatorServiceProcesses(result.value.stdout)
								: new Error(safeError(result.reason))
						);
					} catch (error) {
						serviceResults.set(device.udid, new Error(safeError(error)));
					}
				}
			}

			await diskPromise;
			const [memorySample, psSample, topSample] = await hostSamples;
			if (memorySample.status === 'rejected') throw memorySample.reason;
			if (psSample.status === 'rejected') throw psSample.reason;
			if (topSample.status === 'rejected') throw topSample.reason;
			const memoryResult = memorySample.value;
			const psResult = psSample.value;
			const topResult = topSample.value;
			const host = parseHostMemoryPressure(memoryResult.stdout);
			const processSamples = parseProcessSamples(psResult.stdout);
			const processFootprints = parseProcessFootprints(topResult.stdout);
			const byDevice: Record<string, SimulatorDeviceMetrics> =
				Object.create(null);
			for (const device of devices.slice(0, 200)) {
				const services = serviceResults.get(device.udid);
				const processMetrics: SimulatorProcessMetric[] = [];
				if (Array.isArray(services)) {
					for (const service of services) {
						const sample = processSamples.get(service.processId);
						if (!sample) continue;
						processMetrics.push({
							processId: service.processId,
							name: service.label,
							cpuPercent: sample.cpuPercent,
							// A process that exited between the two samples contributes
							// nothing rather than a stale or inflated figure.
							memoryBytes: processFootprints.get(service.processId) ?? 0,
							...(service.bundleIdentifier
								? { bundleIdentifier: service.bundleIdentifier }
								: {}),
						});
					}
				}
				processMetrics.sort(
					(left, right) =>
						right.memoryBytes - left.memoryBytes ||
						right.cpuPercent - left.cpuPercent ||
						left.processId - right.processId
				);
				const activeApp = processMetrics.find(
					(process) => process.bundleIdentifier
				);
				byDevice[device.udid] = {
					deviceUdid: device.udid,
					sampledAt,
					cpuPercent: Math.min(
						100_000,
						processMetrics.reduce(
							(total, process) => total + process.cpuPercent,
							0
						)
					),
					memoryBytes: processMetrics.reduce(
						(total, process) => total + process.memoryBytes,
						0
					),
					processCount: Array.isArray(services)
						? Math.min(10_000, services.length)
						: 0,
					...(this.#diskAllocations.has(device.udid)
						? {
								diskAllocatedBytes: this.#diskAllocations.get(device.udid),
								diskSampledAt: this.#diskSampledAt,
							}
						: {}),
					...(activeApp?.bundleIdentifier
						? {
								activeApp: {
									bundleIdentifier: activeApp.bundleIdentifier,
									processId: activeApp.processId,
								},
							}
						: {}),
					processes: processMetrics.slice(0, MAX_PROCESSES_PER_DEVICE),
					...(services instanceof Error ? { error: safeError(services) } : {}),
				};
			}
			return { status: 'available', sampledAt, host, byDevice };
		} catch (error) {
			return {
				status: 'unavailable',
				sampledAt,
				byDevice: {},
				error: safeError(error),
			};
		}
	}

	async #refreshDiskAllocations(
		now: number,
		signal?: AbortSignal
	): Promise<void> {
		if (now - this.#diskSampledAt < DISK_REFRESH_INTERVAL_MS) return;
		const result = await runSimulatorCommand(
			XCRUN_PATH,
			['simctl', 'list', 'devices', '--json'],
			{
				...(signal ? { signal } : {}),
				timeoutMs: 15_000,
				maxOutputBytes: MAX_DISK_OUTPUT_BYTES,
			}
		);
		this.#diskAllocations = parseSimulatorDiskAllocations(result.stdout);
		this.#diskSampledAt = now;
	}
}

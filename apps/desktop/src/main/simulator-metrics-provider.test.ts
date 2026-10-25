import { describe, expect, it, vi } from 'vitest';
import * as commandRunner from './simulator-command-runner';
import {
	parseHostMemoryPressure,
	parseProcessFootprints,
	parseProcessSamples,
	parseSimulatorDiskAllocations,
	parseSimulatorServiceProcesses,
	SimulatorMetricsProvider,
} from './simulator-metrics-provider';

const UDID = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';

describe('simulator metrics parsing', () => {
	it('handles an early host sampling failure while a simulator probe is still pending', async () => {
		const runner = vi
			.spyOn(commandRunner, 'runSimulatorCommand')
			.mockImplementation(async (executable, args) => {
				if (executable === '/usr/bin/top')
					throw new Error('Resource sample cancelled.');
				if (args.includes('spawn'))
					await new Promise((resolve) => setTimeout(resolve, 25));
				return { stdout: '{}', stderr: '', durationMs: 1, exitCode: 0 };
			});
		try {
			const result = await new SimulatorMetricsProvider({
				platform: 'darwin',
			}).sample([
				{
					udid: UDID,
					name: 'Example Test',
					state: 'booted',
					isAvailable: true,
					runtimeIdentifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
				},
			]);
			expect(result).toMatchObject({
				status: 'unavailable',
				error: 'Resource sample cancelled.',
			});
		} finally {
			runner.mockRestore();
		}
	});
	it('projects bounded host pressure without exposing unrelated output', () => {
		expect(
			parseHostMemoryPressure(`
The system has 16000000000 (100 pages with a page size of 16384).
System-wide memory free percentage: 12%
`)
		).toEqual({
			memoryPressure: 'warning',
			totalMemoryBytes: 16_000_000_000,
			freeMemoryBytes: 1_920_000_000,
			usedMemoryBytes: 14_080_000_000,
			freePercent: 12,
		});
	});

	it('reads only active launchctl service PIDs and semantic app identifiers', () => {
		const processes = parseSimulatorServiceProcesses(`
user/501 = {
  environment = {
    API_TOKEN => must-not-project
  }
  services = {
    123 - com.apple.runningboardd
    456 (pe) UIKitApplication:com.example.app[abcd][rb-legacy]
    0 - com.apple.not-running
    789 - bad label with spaces
  }
}
`);
		expect(processes).toEqual([
			{ processId: 123, label: 'com.apple.runningboardd' },
			{
				processId: 456,
				label: 'UIKitApplication:com.example.app[abcd][rb-legacy]',
				bundleIdentifier: 'com.example.app',
			},
		]);
		expect(JSON.stringify(processes)).not.toContain('API_TOKEN');
	});

	it('reads physical footprint from top instead of resident size', () => {
		const footprints =
			parseProcessFootprints(`Processes: 4 total, 1 running, 3 sleeping, 12 threads
Load Avg: 1.00, 1.00, 1.00  CPU usage: 1.0% user, 1.0% sys, 98.0% idle
PID    MEM
123    1664M+
456    512K
789    1.5G
42     0B
`);
		expect(footprints).toEqual(
			new Map([
				[123, 1664 * 1024 ** 2],
				[456, 512 * 1024],
				[789, Math.round(1.5 * 1024 ** 3)],
				[42, 0],
			])
		);
		// The summary block and column header must never be mistaken for processes.
		expect(footprints.size).toBe(4);
	});

	it('parses process resource samples and simulator allocation sizes', () => {
		expect(parseProcessSamples(' 123 12.5\n').get(123)).toEqual({
			processId: 123,
			cpuPercent: 12.5,
		});
		// Resident size is no longer read at all; a trailing RSS column is ignored.
		expect(
			parseProcessSamples(' 123 12.5 2048 /private/process\n').get(123)
		).toEqual({
			processId: 123,
			cpuPercent: 12.5,
		});
		expect(
			parseSimulatorDiskAllocations(
				JSON.stringify({
					devices: {
						runtime: [
							{
								udid: UDID,
								dataPath: '/private/device',
								dataPathSize: 100,
								logPathSize: 20,
							},
						],
					},
				})
			)
		).toEqual(new Map([[UDID, 120]]));
	});
});

import {
	mkdir,
	mkdtemp,
	rm,
	symlink,
	truncate,
	utimes,
	writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	parseDiagnosticReport,
	readDiagnosticReports,
} from './failure-diagnostics';

const udid = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
const now = Date.now();
function report(overrides = {}) {
	return JSON.stringify({
		procName: 'ExampleApp',
		parentProc: 'launchd_sim',
		coalitionName: `com.apple.CoreSimulator.SimDevice.${udid}`,
		exception: { type: 'EXC_CRASH', signal: 'SIGABRT' },
		captureTime: new Date(now).toISOString(),
		threads: [{ frames: [{ symbol: 'exampleFrame' }] }],
		...overrides,
	});
}

describe('bounded simulator diagnostics', () => {
	let root: string;
	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), 'rndt-failure-report-'));
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});
	it('reads both IPS formats and projects symbols without memory or credentials', () => {
		const raw = report({
			memory: 'DO_NOT_EXPOSE',
			threads: [
				{
					frames: [
						{ symbol: 'Authorization: Bearer secret-value' },
						...Array.from({ length: 40 }, (_, i) => ({ symbol: `frame${i}` })),
					],
				},
			],
		});
		for (const content of [raw, `{"bug_type":"309"}\n${raw}`]) {
			const parsed = parseDiagnosticReport(content, 'ExampleApp.ips', now);
			expect(parsed).toMatchObject({
				kind: 'app-crash',
				severity: 'error',
				simulatorUdid: udid,
				at: now,
			});
			expect(parsed?.detail).toContain('frame14');
			expect(parsed?.detail).not.toContain('frame15');
			expect(parsed?.detail).not.toContain('DO_NOT_EXPOSE');
			expect(parsed?.detail).not.toContain('secret-value');
		}
	});
	it('distinguishes SpringBoard crashes from CoreSimulator resource diagnostics', () => {
		expect(
			parseDiagnosticReport(
				report({ procName: 'SpringBoard' }),
				'SpringBoard.ips',
				now
			)?.kind
		).toBe('simulator-crash');
		const diagnostic = parseDiagnosticReport(
			'Command: com.apple.CoreSimulator.CoreSimulatorService\nEvent: disk writes\nAction taken: none\nWrites: 34 GB\nsecret: DO_NOT_EXPOSE',
			'service.diag',
			now
		);
		expect(diagnostic).toMatchObject({
			kind: 'simulator-diagnostic',
			severity: 'warning',
		});
		expect(diagnostic?.detail).toContain('Action taken: none');
		expect(diagnostic?.detail).not.toContain('DO_NOT_EXPOSE');
		expect(
			parseDiagnosticReport(
				report({ exception: {}, procName: 'Simulator' }),
				'Simulator.ips',
				now
			)?.kind
		).toBe('simulator-diagnostic');
	});
	it('keeps nonfatal resource reports as warnings even when an exception type is present', () => {
		for (const overrides of [
			{ exception: { type: 'EXC_RESOURCE' } },
			{
				exception: { type: 'EXC_RESOURCE', signal: 'SIGKILL' },
				isNonFatalCorpse: 1,
			},
		]) {
			expect(
				parseDiagnosticReport(report(overrides), 'ExampleApp.ips', now)
			).toMatchObject({
				kind: 'simulator-diagnostic',
				severity: 'warning',
			});
		}
		expect(
			parseDiagnosticReport(
				report({ exception: { type: 'EXC_RESOURCE', signal: 'SIGKILL' } }),
				'ExampleApp.ips',
				now
			)?.kind
		).toBe('app-crash');
		expect(
			parseDiagnosticReport(
				'Process: Simulator [123]\nEvent: disk writes\nAction taken: none',
				'Simulator.crash',
				now
			)?.kind
		).toBe('simulator-diagnostic');
		expect(
			parseDiagnosticReport(
				report({ captureTime: '1960-01-01' }),
				'ExampleApp.ips',
				now
			)?.at
		).toBe(now);
	});
	it('ignores unrelated host crashes and malformed reports', () => {
		expect(
			parseDiagnosticReport(
				report({
					parentProc: 'launchd',
					coalitionName: '',
					procName: 'ExampleApp',
				}),
				'ExampleApp.ips',
				now
			)
		).toBeUndefined();
		expect(
			parseDiagnosticReport('bad json', 'ExampleApp.ips', now)
		).toBeUndefined();
	});
	it('identifies Apple simulator daemons without blaming the development app', () => {
		const record = parseDiagnosticReport(
			report({
				procName: 'searchd',
				codeSigningID: 'com.apple.searchd',
			}),
			'searchd.ips',
			now
		);
		expect(record?.kind).toBe('simulator-crash');
		expect(record?.detail).toContain(
			'does not establish that the development app'
		);
		expect(
			parseDiagnosticReport(
				report({ codeSigningID: 'com.example.app' }),
				'ExampleApp.ips',
				now
			)?.kind
		).toBe('app-crash');
	});
	it('never follows report symlinks and skips stale or oversized files with bounded feedback', async () => {
		await mkdir(path.join(root, 'reports'));
		await writeFile(path.join(root, 'external.ips'), report());
		await symlink(
			path.join(root, 'external.ips'),
			path.join(root, 'reports/link.ips')
		);
		await writeFile(path.join(root, 'reports/old.ips'), report());
		await utimes(path.join(root, 'reports/old.ips'), new Date(0), new Date(0));
		await writeFile(path.join(root, 'reports/large.ips'), '');
		await truncate(path.join(root, 'reports/large.ips'), 5 * 1024 * 1024);
		const result = await readDiagnosticReports(
			[path.join(root, 'reports'), path.join(root, 'missing')],
			now
		);
		expect(result.records).toEqual([]);
		expect(result.issues).toEqual([expect.stringContaining('oversized')]);
	});
	it('prioritizes newest reports by time rather than process name', async () => {
		await Promise.all(
			Array.from({ length: 300 }, async (_, i) => {
				const file = path.join(root, `Z${i}.ips`);
				await writeFile(file, '{}');
				await utimes(file, new Date(now - 10_000), new Date(now - 10_000));
			})
		);
		await writeFile(path.join(root, 'A-newest.ips'), report());
		const result = await readDiagnosticReports([root], now);
		expect(result.records).toHaveLength(1);
		expect(result.records[0]?.source).toBe('A-newest.ips');
		expect(result.issues).toEqual([expect.stringContaining('newest 300')]);
	}, 15_000);
});

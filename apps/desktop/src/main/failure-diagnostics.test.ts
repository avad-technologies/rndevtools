import {
	chmod,
	mkdir,
	mkdtemp,
	rm,
	symlink,
	truncate,
	unlink,
	utimes,
	writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	type DiagnosticReportCache,
	failureText,
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
	it('removes terminal escape sequences before redacting, so colored output cannot shield a credential', () => {
		const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJleGFtcGxlIn0.c2lnbmF0dXJl';
		for (const raw of [
			`\u001b[32m${jwt}\u001b[0m`,
			'Bearer \u001b[1msecret-value\u001b[0m',
			// The 8-bit CSI, and an OSC 8 hyperlink terminated by BEL.
			`\u009b31m${jwt}`,
			`token \u001b]8;;https://example.com\u0007${jwt}\u001b]8;;\u0007`,
		]) {
			const text = failureText(raw);
			expect(text).not.toMatch(/eyJ|secret-value/);
			// No escape parameters are left behind as visible text either.
			expect(text).not.toMatch(/\[\d+m|\]8;;/);
		}
		expect(failureText('Error: example failure\n  at exampleFrame')).toBe(
			'Error: example failure\n  at exampleFrame'
		);
	});
	it('redacts a token that an escape sequence glues to the word before it', () => {
		// The JWT and Bearer rules start at a word boundary, which neither the
		// letter that ends a sequence nor the word left once it is removed has
		// before the token.
		const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJleGFtcGxlIn0.c2lnbmF0dXJl';
		for (const [raw, redacted] of [
			[
				`Error: fetching\u001b[32m${jwt}\u001b[0m done`,
				'Error: fetching[REDACTED JWT] done',
			],
			['Error: Bearer\u001b[1msecret-value', 'Error: Bearer [REDACTED]'],
			// A two-byte escape, the 8-bit CSI, and a lone ESC.
			[`Error: fetching\u001b7${jwt}`, 'Error: fetching[REDACTED JWT]'],
			[`Error: fetching\u009b32m${jwt}`, 'Error: fetching[REDACTED JWT]'],
			[`Error: fetching\u001b${jwt}`, 'Error: fetching[REDACTED JWT]'],
			// A secret's value and a token a sequence glues to it are one secret.
			[`password=example\u001b[0m${jwt}`, 'password=[REDACTED]'],
		] as const) {
			expect(failureText(raw)).toBe(redacted);
		}
		// Redacting the raw text first cut this sequence at the `;` between its
		// parameters, and left the rest of it, `32m`, on the token.
		const text = failureText(`GET /callback?code=\u001b[1;32m${jwt}\u001b[0m`);
		expect(text).toContain('GET /callback?code=[REDACTED');
		expect(text).not.toMatch(/eyJ|32m/);
	});
	it('redacts a token that a removed control character would join to the word before it', () => {
		// The JWT and Bearer rules start at a word boundary, and a removed
		// control leaves none between the word and the token it parted.
		const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJleGFtcGxlIn0.c2lnbmF0dXJl';
		for (const [raw, redacted] of [
			[`Error: fetching\r${jwt}`, 'Error: fetching[REDACTED JWT]'],
			[`Error: fetching\u000b${jwt}`, 'Error: fetching[REDACTED JWT]'],
			[`Error: fetching\u200b${jwt}`, 'Error: fetching[REDACTED JWT]'],
			['Error: Bearer\rsecret-value', 'Error: Bearer [REDACTED]'],
			['Error: Bearer\u000bsecret-value', 'Error: Bearer [REDACTED]'],
		] as const) {
			expect(failureText(raw)).toBe(redacted);
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

	describe('across scans', () => {
		// Whole seconds, so setting the time again reproduces it exactly.
		const listedAt = new Date(Math.floor(now / 1_000) * 1_000 - 60_000);
		const changedAt = new Date(listedAt.getTime() + 1_000);
		async function place(name: string, content: string, at = listedAt) {
			const file = path.join(root, name);
			await writeFile(file, content);
			await utimes(file, at, at);
			return file;
		}
		const processes = (
			result: Awaited<ReturnType<typeof readDiagnosticReports>>
		) => result.records.map((record) => record.process);

		it('reuses what it parsed while a report keeps its size and modification time, and reads it again once either changes', async () => {
			const cache: DiagnosticReportCache = new Map();
			const file = await place('ExampleApp.ips', report());
			const first = await readDiagnosticReports([root], now, cache);
			expect(processes(first)).toEqual(['ExampleApp']);

			// New bytes of the same length under the same time are not read.
			await place('ExampleApp.ips', report({ procName: 'ExampleApq' }));
			expect(await readDiagnosticReports([root], now, cache)).toEqual(first);
			expect(processes(await readDiagnosticReports([root], now))).toEqual([
				'ExampleApq',
			]);

			await utimes(file, changedAt, changedAt);
			expect(
				processes(await readDiagnosticReports([root], now, cache))
			).toEqual(['ExampleApq']);
			await place(
				'ExampleApp.ips',
				report({ procName: 'SpringBoard' }),
				changedAt
			);
			expect(
				processes(await readDiagnosticReports([root], now, cache))
			).toEqual(['SpringBoard']);

			// A report that vanished leaves nothing behind.
			await unlink(file);
			expect(await readDiagnosticReports([root], now, cache)).toEqual({
				records: [],
				issues: [],
			});
			expect(cache.size).toBe(0);
		});

		it.skipIf(process.getuid?.() === 0)(
			'never opens an unchanged report again',
			async () => {
				const cache: DiagnosticReportCache = new Map();
				const file = await place('ExampleApp.ips', report());
				const first = await readDiagnosticReports([root], now, cache);
				expect(first.records).toHaveLength(1);
				// chmod moves only the change time, so the report is unchanged,
				// and any open(2) of it now fails.
				await chmod(file, 0o000);
				try {
					expect(await readDiagnosticReports([root], now, cache)).toEqual(
						first
					);
					expect((await readDiagnosticReports([root], now)).records).toEqual(
						[]
					);
				} finally {
					await chmod(file, 0o600);
				}
			}
		);

		it('charges reports it already knows to the folder limits, as if it read them again', async () => {
			const cache: DiagnosticReportCache = new Map();
			// Four 4 MB reports fill the 16 MB folder budget, so the older,
			// smaller report behind them is never inspected.
			for (let index = 0; index < 4; index += 1) {
				const file = await place(`Large-${index}.ips`, '');
				await truncate(file, 4 * 1024 * 1024);
				await utimes(file, listedAt, listedAt);
			}
			const oversized = await place('Oversized.ips', '');
			await truncate(oversized, 5 * 1024 * 1024);
			await utimes(oversized, listedAt, listedAt);
			await place(
				'ExampleApp.ips',
				report(),
				new Date(listedAt.getTime() - 60_000)
			);
			const first = await readDiagnosticReports([root], now, cache);
			expect(first).toEqual({
				records: [],
				issues: [
					expect.stringContaining('oversized'),
					expect.stringContaining('16 MB folder limit'),
				],
			});
			expect(await readDiagnosticReports([root], now, cache)).toEqual(first);
		});
	});
});

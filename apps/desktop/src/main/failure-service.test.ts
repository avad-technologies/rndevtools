import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	utimes,
	writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lane } from '../shared/lane-protocol';
import type { SimulatorState } from '../shared/simulator-protocol';
import { failureId } from './failure-diagnostics';
import { FailureService } from './failure-service';

const udid = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
const lane = {
	id: 'lane-test',
	simulatorUdid: udid,
	worktreePath: '/Users/dev/ExampleApp',
	port: 8100,
	metroPid: 1234,
	metro: 'ready',
	startedAt: 0,
} as Lane;

describe('persistent failure monitoring', () => {
	let root: string;
	let services: FailureService[];
	let now: number;
	const handoff = vi.fn(async () => ({ cancelled: true }));
	function make() {
		const service = new FailureService({
			directory: path.join(root, 'history'),
			directories: [path.join(root, 'reports')],
			handoff,
			now: () => now,
		});
		services.push(service);
		return service;
	}
	beforeEach(async () => {
		root = await mkdtemp(path.join(os.tmpdir(), 'rndt-failures-'));
		await mkdir(path.join(root, 'reports'));
		services = [];
		now = Date.now();
		handoff.mockClear();
	});
	afterEach(async () => {
		await Promise.all(services.map((service) => service.stop()));
		await rm(root, { recursive: true, force: true });
	});
	it('persists crashes, resolution and lane association through desktop restarts without duplicate retired reports', async () => {
		let service = make();
		await service.start();
		service.observeLanes([lane]);
		await service.stop();
		await writeFile(
			path.join(root, 'reports/SpringBoard.ips'),
			JSON.stringify({
				procName: 'SpringBoard',
				parentProc: 'launchd_sim',
				coalitionName: `com.apple.CoreSimulator.SimDevice.${udid}`,
				exception: { type: 'EXC_CRASH', signal: 'SIGABRT' },
			})
		);
		service = make();
		await service.start();
		await service.scan();
		expect(service.getState().records).toHaveLength(1);
		const record = service.getState().records[0];
		if (!record) throw new Error('Expected a crash record');
		expect(record).toMatchObject({
			laneId: lane.id,
			project: lane.worktreePath,
		});
		await service.runOperation({
			operation: 'resolve',
			id: record.id,
			resolved: true,
		});
		await service.scan();
		await service.stop();
		// An upgraded parser refreshes old report classifications without losing resolution.
		const historyFile = path.join(root, 'history/history.json');
		const stored = JSON.parse(await readFile(historyFile, 'utf8'));
		stored.records[0].kind = 'app-crash';
		await writeFile(historyFile, JSON.stringify(stored));
		service = make();
		await service.start();
		await service.scan();
		expect(service.getState().records).toEqual([
			expect.objectContaining({ resolvedAt: now, kind: 'simulator-crash' }),
		]);
		await service.runOperation({
			operation: 'resolve',
			id: record.id,
			resolved: false,
		});
		expect(service.getState().records[0]?.resolvedAt).toBeUndefined();
		expect(
			(await stat(path.join(root, 'history/history.json'))).mode & 0o777
		).toBe(0o600);
		expect((await stat(path.join(root, 'history'))).mode & 0o777).toBe(0o700);
	});
	it('reads only its own history at start, and scans for reports in the background once scanning starts', async () => {
		await writeFile(
			path.join(root, 'reports/SpringBoard.ips'),
			JSON.stringify({
				procName: 'SpringBoard',
				parentProc: 'launchd_sim',
				coalitionName: `com.apple.CoreSimulator.SimDevice.${udid}`,
				exception: { type: 'EXC_CRASH', signal: 'SIGABRT' },
			})
		);
		const service = make();
		await service.start();
		expect(service.getState()).toMatchObject({ records: [], checkedAt: 0 });
		service.startScanning();
		// Joins the scan that startScanning began.
		await service.scan();
		expect(service.getState()).toMatchObject({
			records: [expect.objectContaining({ kind: 'simulator-crash' })],
			checkedAt: now,
		});
	});
	it('does not read an unchanged report again on later scans', async () => {
		const file = path.join(root, 'reports/ExampleApp.ips');
		// Whole seconds, so setting the time again reproduces it exactly.
		const at = new Date(Math.floor(now / 1_000) * 1_000 - 60_000);
		const crash = (procName: string) =>
			JSON.stringify({
				procName,
				parentProc: 'launchd_sim',
				coalitionName: `com.apple.CoreSimulator.SimDevice.${udid}`,
				exception: { type: 'EXC_CRASH', signal: 'SIGABRT' },
			});
		const service = make();
		const titles = () =>
			service.getState().records.map((record) => record.title);
		await writeFile(file, crash('ExampleApp'));
		await utimes(file, at, at);
		await service.start();
		await service.scan();
		expect(titles()).toEqual(['ExampleApp crashed']);
		// The same size and modification time: the earlier parse stands.
		await writeFile(file, crash('ExampleApq'));
		await utimes(file, at, at);
		await service.scan();
		expect(titles()).toEqual(['ExampleApp crashed']);
		const changedAt = new Date(at.getTime() + 1_000);
		await utimes(file, changedAt, changedAt);
		await service.scan();
		expect(titles()).toEqual(['ExampleApq crashed', 'ExampleApp crashed']);
	});
	it('records intentional restarts separately from unexpected exits with code and signal', async () => {
		const service = make();
		await service.start();
		service.observeLanes([lane]);
		await service.laneIntent(lane, 'Operator restart');
		await service.metroExited({
			pid: 1234,
			port: 8100,
			startedAt: now,
			code: null,
			signal: 'SIGTERM',
		});
		service.observeLanes([{ ...lane, metro: 'stopped' }]);
		expect(
			service
				.getState()
				.records.every((record) => record.kind === 'lane-lifecycle')
		).toBe(true);
		service.observeLanes([{ ...lane, metroPid: 1235 }]);
		await service.metroExited({
			pid: 1235,
			port: 8100,
			startedAt: now,
			code: 1,
			signal: null,
		});
		expect(
			service.getState().records.find((record) => record.kind === 'metro-exit')
		).toMatchObject({
			laneId: lane.id,
			detail: expect.stringContaining('Exit code: 1'),
		});
	});
	it('keeps a bounded redacted Metro log with an unexpected exit', async () => {
		const service = make();
		await service.start();
		const logPath = path.join(root, 'metro.log');
		await writeFile(
			logPath,
			`${'old line\n'.repeat(2_000)}Authorization: Bearer secret-value\nError: example failure\n`
		);
		await service.metroExited({
			pid: 1,
			port: 8_100,
			startedAt: now,
			code: 1,
			signal: null,
			logPath,
		});
		const detail = service.getState().records[0]?.detail ?? '';
		expect(detail).toContain('Error: example failure');
		expect(detail).not.toContain('secret-value');
		expect(detail.length).toBeLessThan(9_000);
	});

	it('reports an adopted dead process with unknown cause and upgrades it when an exact exit arrives', async () => {
		const service = make();
		await service.start();
		service.observeLanes([{ ...lane, metro: 'stopped' }]);
		expect(service.getState().records[0]?.detail).toContain('not observed');
		await service.metroExited({
			pid: 1234,
			port: 8100,
			startedAt: now,
			code: null,
			signal: 'SIGKILL',
		});
		expect(service.getState().records).toHaveLength(1);
		expect(service.getState().records[0]?.detail).toContain('SIGKILL');
	});
	it('associates simulator jobs with the lane at operation start rather than latest device use', async () => {
		const service = make();
		await service.start();
		service.observeLanes([{ ...lane, startedAt: now }]);
		const startedAt = now + 1;
		now += 10;
		service.observeLanes([]);
		now += 10;
		service.observeLanes([
			{
				...lane,
				id: 'lane-other',
				startedAt: now,
				worktreePath: '/Users/dev/OtherApp',
			},
		]);
		service.observeSimulator({
			jobs: [
				{
					id: 'historical',
					kind: 'launch',
					status: 'failed',
					deviceUdid: udid,
					createdAt: startedAt,
					startedAt,
					finishedAt: now + 1,
					message: 'failed',
				},
			],
		} as SimulatorState);
		expect(service.getState().records[0]).toMatchObject({
			laneId: lane.id,
			project: lane.worktreePath,
		});
		service.observeSimulator({
			jobs: [
				{
					id: 'before-lane',
					kind: 'launch',
					status: 'failed',
					deviceUdid: udid,
					createdAt: startedAt - 100,
					finishedAt: now + 2,
				},
			],
		} as SimulatorState);
		expect(service.getState().records[0]?.project).toBeUndefined();
		service.observeLanes([
			{
				...lane,
				id: 'lane-other',
				startedAt: now,
				worktreePath: '/Users/dev/OtherApp',
			},
		]);
		expect(service.getState().records[0]?.project).toBeUndefined();
	});
	it('does not choose a project when historical lane lifetimes overlap', async () => {
		const service = make();
		await service.start();
		service.observeLanes([
			{ ...lane, startedAt: now },
			{
				...lane,
				id: 'lane-other',
				startedAt: now,
				worktreePath: '/Users/dev/OtherApp',
			},
		]);
		service.observeSimulator({
			jobs: [
				{
					id: 'ambiguous',
					kind: 'launch',
					status: 'failed',
					deviceUdid: udid,
					createdAt: now + 1,
					finishedAt: now + 2,
				},
			],
		} as SimulatorState);
		expect(service.getState().records[0]?.project).toBeUndefined();
	});
	it('bounds retained history, redacts diagnostics and never resolves on handoff', async () => {
		await mkdir(path.join(root, 'history'));
		await writeFile(
			path.join(root, 'history/history.json'),
			JSON.stringify({
				version: 1,
				contexts: [],
				records: Array.from({ length: 197 }, (_, i) => ({
					id: failureId(`seed-${i}`),
					at: now - i,
					kind: 'metro-exit',
					severity: 'error',
					title: 'Metro exited',
					detail: 'Exit code: 1',
					source: 'Metro child process',
					process: 'Authorization: Bearer secret-value',
				})),
			})
		);
		const service = make();
		await service.start();
		for (let i = 1; i <= 10; i++) {
			now++;
			await service.metroExited({
				pid: i,
				port: 8100,
				startedAt: now,
				code: 1,
				signal: null,
			});
		}
		expect(service.getState().records).toHaveLength(200);
		await service.laneIntent(lane, 'Authorization: Bearer secret-value');
		expect(JSON.stringify(service.getState())).not.toContain('secret-value');
		const id = service.getState().records[0]?.id;
		if (!id) throw new Error('Expected retained history');
		await service.runOperation({
			operation: 'handoff',
			id,
			client: 'codex',
			mode: 'investigate',
			project: lane.worktreePath,
		});
		expect(handoff).toHaveBeenCalledOnce();
		expect(service.getState().records[0]?.resolvedAt).toBeUndefined();
	});
	it('preserves corrupt history and keeps monitoring in memory without crashing startup', async () => {
		await mkdir(path.join(root, 'history'));
		await writeFile(path.join(root, 'history/history.json'), 'BROKEN');
		const service = make();
		await service.start();
		await service.metroExited({
			pid: 1,
			port: 8100,
			startedAt: now,
			code: 1,
			signal: null,
		});
		await service.scan();
		expect(service.getState().records).toHaveLength(1);
		expect(service.getState().issues[0]).toContain('in memory only');
		expect(
			await readFile(path.join(root, 'history/history.json'), 'utf8')
		).toBe('BROKEN');
	});
	it('does not follow a symlink in the storage path', async () => {
		await mkdir(path.join(root, 'outside'));
		await symlink(path.join(root, 'outside'), path.join(root, 'history'));
		const service = make();
		await service.start();
		await service.laneIntent(lane, 'restart');
		expect(service.getState().issues[0]).toContain('in memory only');
		await expect(
			stat(path.join(root, 'outside/history.json'))
		).rejects.toMatchObject({ code: 'ENOENT' });
	});
});

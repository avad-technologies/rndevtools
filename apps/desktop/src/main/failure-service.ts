import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
	type FailureRecord,
	type FailureRequest,
	type FailureResult,
	type FailureState,
	failureRecordSchema,
	failureRequestSchema,
	failureStateSchema,
} from '../shared/failure-protocol';
import type { Lane } from '../shared/lane-protocol';
import type { SimulatorState } from '../shared/simulator-protocol';
import {
	failureId,
	failureText,
	readDiagnosticReports,
} from './failure-diagnostics';
import { type MetroExit, readLogTail } from './lane-metro';
import { ensurePrivateDirectory, writeFileAtomic } from './private-files';

const contextSchema = z.strictObject({
	id: z.string().max(128),
	simulatorUdid: z.string().max(64),
	worktreePath: z.string().max(1_024),
	startedAt: z.number().finite().nonnegative().optional(),
	endedAt: z.number().finite().nonnegative().optional(),
	metroPid: z.number().int().positive().optional(),
	port: z.number().int().positive(),
});
type LaneContext = z.infer<typeof contextSchema>;
const storedSchema = z.strictObject({
	version: z.literal(1),
	records: z.array(failureRecordSchema).max(200),
	contexts: z.array(contextSchema).max(64),
});
type Handoff = (
	record: FailureRecord,
	request: Extract<FailureRequest, { operation: 'handoff' }>
) => Promise<{ message?: string; cancelled?: boolean }>;

/** Local, bounded history. A diagnostic is evidence, never an automatic repair command. */
export class FailureService {
	readonly #directory: string;
	readonly #directories: readonly string[];
	readonly #handoff: Handoff;
	readonly #now: () => number;
	#records: FailureRecord[] = [];
	#contexts: LaneContext[] = [];
	#expected = new Map<number, { reason: string; at: number }>();
	#checkedAt = 0;
	#issues: string[] = [];
	#storageIssue: string | undefined;
	#canSave = true;
	#queue: Promise<void> = Promise.resolve();
	#scan: Promise<FailureState> | undefined;
	#timer: NodeJS.Timeout | undefined;
	#stopped = false;

	constructor({
		directory,
		directories,
		handoff,
		now = Date.now,
	}: {
		directory: string;
		directories?: readonly string[];
		handoff: Handoff;
		now?: () => number;
	}) {
		this.#directory = directory;
		this.#directories = directories ?? [
			path.join(os.homedir(), 'Library/Logs/DiagnosticReports'),
			path.join(os.homedir(), 'Library/Logs/DiagnosticReports/Retired'),
			'/Library/Logs/DiagnosticReports',
			'/Library/Logs/DiagnosticReports/Retired',
		];
		this.#handoff = handoff;
		this.#now = now;
	}

	async start(): Promise<void> {
		try {
			await ensurePrivateDirectory(this.#directory, 'Failure history', {
				ownedByUser: true,
			});
			const handle = await open(
				path.join(this.#directory, 'history.json'),
				constants.O_RDONLY | constants.O_NOFOLLOW
			);
			try {
				const metadata = await handle.stat();
				if (!metadata.isFile() || metadata.size > 16 * 1024 * 1024)
					throw new Error('History exceeds its limit.');
				const bytes = Buffer.alloc(metadata.size);
				const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
				const state = storedSchema.parse(
					JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'))
				);
				for (const record of state.records) this.#add(record);
				this.#contexts = state.contexts;
			} finally {
				await handle.close();
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				this.#canSave = false;
				this.#storageIssue =
					'Previous failure history could not be read. It has been preserved; new events are in memory only. Check the failures folder in app data.';
			}
		}
		await this.scan();
		this.#timer = setInterval(() => {
			void this.scan();
		}, 30_000);
		this.#timer.unref();
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		if (this.#timer) clearInterval(this.#timer);
		await this.#scan;
		await this.#queue;
	}

	getState(): FailureState {
		return failureStateSchema.parse({
			records: this.#records,
			checkedAt: this.#checkedAt,
			monitoring: !this.#stopped,
			issues: [
				...(this.#storageIssue ? [this.#storageIssue] : []),
				...this.#issues,
			].slice(0, 12),
		});
	}

	#remember(lane: LaneContext): void {
		const context = contextSchema.parse({
			id: lane.id,
			simulatorUdid: lane.simulatorUdid,
			worktreePath: lane.worktreePath,
			startedAt: lane.startedAt,
			metroPid: lane.metroPid,
			port: lane.port,
		});
		this.#contexts = [
			context,
			...this.#contexts.filter(
				(value) => value.id !== lane.id || value.metroPid !== lane.metroPid
			),
		].slice(0, 64);
	}

	#context(lane: LaneContext | undefined): Partial<FailureRecord> {
		return lane
			? {
					laneId: lane.id,
					simulatorUdid: lane.simulatorUdid,
					project: lane.worktreePath,
					metroPid: lane.metroPid,
					port: lane.port,
				}
			: {};
	}

	#reportContext(record: FailureRecord): Partial<FailureRecord> {
		return this.#context(
			this.#contexts.find(
				(value) =>
					value.simulatorUdid === record.simulatorUdid &&
					(value.startedAt === undefined || record.at >= value.startedAt) &&
					(value.endedAt === undefined || record.at <= value.endedAt)
			)
		);
	}

	#add(record: FailureRecord): boolean {
		const previous = this.#records.find((value) => value.id === record.id);
		if (
			!previous &&
			this.#records.length >= 200 &&
			record.at < (this.#records.at(-1)?.at ?? 0)
		)
			return false;
		const clean = failureRecordSchema.parse({
			...previous,
			...record,
			title: failureText(record.title, 240),
			detail: failureText(record.detail),
			source: failureText(record.source, 256),
		});
		if (previous && JSON.stringify(previous) === JSON.stringify(clean))
			return false;
		this.#records = [
			clean,
			...this.#records.filter((value) => value.id !== record.id),
		]
			.sort((a, b) => b.at - a.at)
			.slice(0, 200);
		return true;
	}

	#save(): Promise<void> {
		if (!this.#canSave) return Promise.resolve();
		const snapshot = JSON.stringify({
			version: 1,
			records: this.#records,
			contexts: this.#contexts,
		});
		const write = this.#queue.then(() =>
			writeFileAtomic(
				path.join(this.#directory, 'history.json'),
				snapshot,
				'failures'
			)
		);
		this.#queue = write.then(
			() => {
				this.#storageIssue = undefined;
			},
			() => {
				this.#storageIssue =
					'Failure history could not be saved. Check available disk space and file access.';
			}
		);
		return this.#queue;
	}

	async laneIntent(lane: Lane, reason: string): Promise<void> {
		this.#remember(lane);
		if (lane.metroPid)
			this.#expected.set(lane.metroPid, { reason, at: this.#now() });
		this.#add({
			...this.#context(lane),
			id: failureId(`intent:${lane.id}:${lane.metroPid}:${this.#now()}`),
			at: this.#now(),
			kind: 'lane-lifecycle',
			severity: 'info',
			title: 'Managed Metro stop requested',
			detail: reason,
			source: 'RN Devtools lane lifecycle',
		});
		await this.#save();
	}

	async metroExited(exit: MetroExit): Promise<void> {
		const lane = this.#contexts.find((value) => value.metroPid === exit.pid);
		const expected = this.#expected.get(exit.pid);
		const intentional =
			expected !== undefined && this.#now() - expected.at < 60_000;
		const log =
			!intentional && exit.logPath
				? await readLogTail(exit.logPath, 8_192).catch(
						() => 'Metro log could not be read.'
					)
				: '';
		const record: FailureRecord = {
			...this.#context(lane),
			id: failureId(`metro:${exit.pid}:${exit.startedAt}`),
			at: this.#now(),
			kind: intentional ? 'lane-lifecycle' : 'metro-exit',
			severity: intentional ? 'info' : 'error',
			title: intentional
				? 'Managed Metro stopped'
				: 'Metro exited unexpectedly',
			detail: `${intentional ? expected.reason : 'No RN Devtools stop request was recorded.'}\nPID: ${exit.pid}\nPort: ${exit.port}\nExit code: ${exit.code ?? 'none'}\nSignal: ${exit.signal ?? 'none'}${log ? `\n\nMetro log tail (redacted):\n${failureText(log, 8_192)}` : ''}`,
			source: 'Metro child process',
			metroPid: exit.pid,
			port: exit.port,
		};
		// Replace a polling observation of this same death with the precise exit.
		this.#records = this.#records.filter(
			(value) =>
				value.id !== failureId(`metro-missing:${exit.pid}:${lane?.id ?? ''}`)
		);
		if (this.#add(record)) await this.#save();
	}

	observeLanes(lanes: readonly Lane[]): void {
		for (const [pid, intent] of this.#expected)
			if (this.#now() - intent.at > 60_000) this.#expected.delete(pid);
		let changed = false;
		for (const lane of lanes) {
			const previous = this.#contexts.find((value) => value.id === lane.id);
			if (
				!previous ||
				previous.metroPid !== lane.metroPid ||
				previous.endedAt !== undefined
			) {
				this.#remember(lane);
				changed = true;
			}
			if (
				lane.metro === 'stopped' &&
				lane.metroPid &&
				!this.#expected.has(lane.metroPid) &&
				!this.#records.some(
					(record) =>
						record.metroPid === lane.metroPid && record.kind === 'metro-exit'
				)
			) {
				changed =
					this.#add({
						...this.#context(lane),
						id: failureId(`metro-missing:${lane.metroPid}:${lane.id}`),
						at: this.#now(),
						kind: 'metro-exit',
						severity: 'error',
						title: 'Metro is no longer running',
						detail:
							'The stored Metro PID is gone. Its exit code and signal were not observed by this desktop process; no crash cause is inferred. Check the lane log and nearby diagnostic reports.',
						source: 'Lane health check',
					}) || changed;
			}
		}
		this.#contexts = this.#contexts.map((context) => {
			if (
				context.endedAt !== undefined ||
				lanes.some((lane) => lane.id === context.id)
			)
				return context;
			changed = true;
			return { ...context, endedAt: this.#now() };
		});
		this.#records = this.#records.map((record) => {
			if (record.project || !record.simulatorUdid) return record;
			const context = this.#reportContext(record);
			if (!context.project) return record;
			changed = true;
			return { ...context, ...record };
		});
		if (changed) void this.#save();
	}

	observeSimulator(state: SimulatorState): void {
		let changed = false;
		for (const job of state.jobs) {
			if (job.status !== 'failed') continue;
			const lane = this.#contexts.find(
				(value) => value.simulatorUdid === job.deviceUdid
			);
			changed =
				this.#add({
					...this.#context(lane),
					id: failureId(`simulator-job:${job.id}`),
					at: job.finishedAt ?? this.#now(),
					kind: 'operation-failed',
					severity: 'error',
					title: 'Simulator operation failed',
					detail: failureText(
						JSON.stringify({ kind: job.kind, message: job.message })
					),
					source: 'RN Devtools simulator job',
					...(job.deviceUdid ? { simulatorUdid: job.deviceUdid } : {}),
				}) || changed;
		}
		if (changed) void this.#save();
	}

	scan(): Promise<FailureState> {
		if (!this.#scan)
			this.#scan = this.#scanReports().finally(() => {
				this.#scan = undefined;
			});
		return this.#scan;
	}
	async #scanReports(): Promise<FailureState> {
		try {
			const result = await readDiagnosticReports(
				this.#directories,
				this.#now()
			);
			let changed = false;
			for (const record of result.records) {
				changed =
					this.#add({ ...this.#reportContext(record), ...record }) || changed;
			}
			this.#issues = result.issues;
			this.#checkedAt = this.#now();
			if (changed) await this.#save();
		} catch {
			this.#issues = ['Diagnostic scan failed; earlier records are retained.'];
		}
		return this.getState();
	}

	async runOperation(value: FailureRequest): Promise<FailureResult> {
		const request = failureRequestSchema.parse(value);
		if (request.operation === 'scan') return { state: await this.scan() };
		const record = this.#records.find((value) => value.id === request.id);
		if (!record)
			throw new Error(
				'This failure is no longer retained. Refresh the history.'
			);
		if (request.operation === 'resolve') {
			const { resolvedAt: _previous, ...base } = record;
			this.#records = this.#records.map((value) =>
				value.id === record.id
					? {
							...base,
							...(request.resolved ? { resolvedAt: this.#now() } : {}),
						}
					: value
			);
			await this.#save();
			return { state: this.getState() };
		}
		const result = await this.#handoff(record, request);
		return { state: this.getState(), ...result };
	}
}

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
	type DiagnosticReportCache,
	failureId,
	failureText,
	METRO_LOG_TAIL_HEADING,
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
	/**
	 * When RN Devtools asked this context's Metro to stop. It is kept with
	 * the lane rather than in the capped history, so a lane listed as stopped
	 * for days still has its stop on record, and it ends with the context:
	 * once the lane is gone or runs another Metro.
	 */
	stopRequestedAt: z.number().finite().nonnegative().optional(),
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

/** A context once its lane is gone or runs another Metro; no stop is pending. */
function ended(context: LaneContext, at: number): LaneContext {
	const { stopRequestedAt: _stopRequestedAt, ...rest } = context;
	return { ...rest, endedAt: at };
}

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
	/** What earlier scans parsed, so a scan opens only new or changed reports. */
	readonly #reports: DiagnosticReportCache = new Map();
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

	/**
	 * Loads the stored history. Diagnostic reports are not read until
	 * `startScanning`, so a slow report folder never holds up startup.
	 */
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
	}

	/**
	 * Scans the diagnostic report folders in the background, now and every
	 * 30 s. The first scan parses every recent report, so the desktop calls
	 * this once its window is open; later scans open only new or changed ones.
	 */
	startScanning(): void {
		if (this.#stopped || this.#timer) return;
		void this.scan();
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

	/**
	 * Records the lane as it runs now, ending the context of the Metro it ran
	 * before. A stop request already on record for this very Metro stays;
	 * `stopRequestedAt` records a new one.
	 */
	#remember(lane: LaneContext, stopRequestedAt?: number): void {
		const same = (value: LaneContext) =>
			value.id === lane.id &&
			value.metroPid === lane.metroPid &&
			value.startedAt === lane.startedAt;
		const requestedAt =
			lane.metroPid === undefined
				? undefined
				: (stopRequestedAt ?? this.#contexts.find(same)?.stopRequestedAt);
		const context = contextSchema.parse({
			id: lane.id,
			simulatorUdid: lane.simulatorUdid,
			worktreePath: lane.worktreePath,
			startedAt: lane.startedAt,
			metroPid: lane.metroPid,
			port: lane.port,
			...(requestedAt !== undefined ? { stopRequestedAt: requestedAt } : {}),
		});
		this.#contexts = [
			context,
			...this.#contexts
				.filter((value) => !same(value))
				.map((value) =>
					value.id === lane.id && value.endedAt === undefined
						? ended(value, context.startedAt ?? this.#now())
						: value
				),
		].slice(0, 64);
	}

	/** Whether RN Devtools asked the Metro the lane lists to stop. */
	#stopRequested(lane: Pick<Lane, 'id' | 'metroPid'>): boolean {
		return this.#contexts.some(
			(value) =>
				value.id === lane.id &&
				value.metroPid === lane.metroPid &&
				value.endedAt === undefined &&
				value.stopRequestedAt !== undefined
		);
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

	#reportContext(
		record: Pick<FailureRecord, 'at' | 'simulatorUdid'>
	): Partial<FailureRecord> {
		// Context order is not evidence: a device can be reused by another project.
		const matches = this.#contexts.filter(
			(value) =>
				value.simulatorUdid === record.simulatorUdid &&
				value.startedAt !== undefined &&
				record.at >= value.startedAt &&
				(value.endedAt === undefined || record.at < value.endedAt)
		);
		if (new Set(matches.map((value) => value.id)).size !== 1) return {};
		return this.#context(matches[0]);
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
			...(record.process ? { process: failureText(record.process, 256) } : {}),
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
		this.#remember(lane, this.#now());
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
			detail: `${intentional ? expected.reason : 'No RN Devtools stop request was recorded.'}\nPID: ${exit.pid}\nPort: ${exit.port}\nExit code: ${exit.code ?? 'none'}\nSignal: ${exit.signal ?? 'none'}${log ? `\n\n${METRO_LOG_TAIL_HEADING}\n${failureText(log, 8_192)}` : ''}`,
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
				previous.startedAt !== lane.startedAt ||
				previous.endedAt !== undefined
			) {
				if (previous) changed = this.#forgotMetro(lane, previous) || changed;
				this.#remember(lane);
				changed = true;
			}
			if (
				lane.metro === 'stopped' &&
				lane.metroPid &&
				!this.#expected.has(lane.metroPid) &&
				// RN Devtools asked this Metro to stop. The lane can keep it listed
				// as stopped long after the intent window, as a required lane whose
				// backend failed to attach does, and across desktop restarts. The
				// request is kept with the lane's context, which newer events
				// cannot push out of the capped history.
				!this.#stopRequested(lane) &&
				!this.#records.some(
					(record) =>
						record.metroPid === lane.metroPid &&
						(record.kind === 'metro-exit' ||
							// A history saved before stops were kept with the context.
							(record.kind === 'lane-lifecycle' && record.laneId === lane.id))
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
							"The stored Metro PID is gone. Its exit code and signal were not observed by this desktop process; no crash cause is inferred. Check the lane's log and nearby diagnostic reports.",
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
			return ended(context, this.#now());
		});
		this.#records = this.#records.map((record) => {
			if (
				record.project ||
				!record.simulatorUdid ||
				record.kind === 'operation-failed'
			)
				return record;
			const context = this.#reportContext(record);
			if (!context.project) return record;
			changed = true;
			return { ...context, ...record };
		});
		if (changed) void this.#save();
	}

	/**
	 * Records a Metro the lane forgot. The lane service drops a recorded PID
	 * only once it names some other process, and marks the lane stopped in
	 * the same write, so the stopped lane never lists the PID that went: the
	 * context it ran under still does. Whether that Metro crashed is not
	 * known, and the record says so. A Metro RN Devtools asked to stop, or
	 * whose exit is on record, is not reported.
	 */
	#forgotMetro(lane: Lane, previous: LaneContext): boolean {
		const pid = previous.metroPid;
		if (
			lane.metro !== 'stopped' ||
			lane.metroPid !== undefined ||
			pid === undefined ||
			previous.endedAt !== undefined ||
			previous.stopRequestedAt !== undefined ||
			this.#expected.has(pid) ||
			this.#records.some(
				(record) =>
					record.metroPid === pid &&
					(record.kind === 'metro-exit' ||
						(record.kind === 'lane-lifecycle' && record.laneId === lane.id))
			)
		)
			return false;
		return this.#add({
			...this.#context(previous),
			id: failureId(`metro-missing:${pid}:${lane.id}`),
			at: this.#now(),
			kind: 'metro-exit',
			severity: 'error',
			title: 'Metro is no longer running',
			detail:
				"The stored Metro PID now names another process, so the lane forgot it: its own Metro is gone. Its exit code and signal were not observed by this desktop process; no crash cause is inferred. Check the lane's log and nearby diagnostic reports.",
			source: 'Lane health check',
		});
	}

	observeSimulator(state: SimulatorState): void {
		let changed = false;
		for (const job of state.jobs) {
			if (job.status !== 'failed') continue;
			const at = job.finishedAt ?? this.#now();
			const context = job.deviceUdid
				? this.#reportContext({
						simulatorUdid: job.deviceUdid,
						at: job.startedAt ?? job.createdAt,
					})
				: {};
			changed =
				this.#add({
					...context,
					id: failureId(`simulator-job:${job.id}`),
					at,
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
				this.#now(),
				this.#reports
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

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
	SIMULATOR_CAPTURE_PROTOCOL_SCHEME,
	type SimulatorCapture,
	type SimulatorCaptureRetentionPolicy,
	type SimulatorCaptureRetentionState,
	simulatorCaptureIdSchema,
	simulatorCaptureRetentionPolicySchema,
	UDID_PATTERN,
} from '../shared/simulator-protocol';
import {
	ensurePrivateDirectory,
	isMissing,
	syncDirectory,
	writeFileAtomic,
} from './private-files';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_CAPTURE_RECORDS = 5_000;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_POLICY_BYTES = 16 * 1024;
const COPY_BUFFER_BYTES = 1024 * 1024;
const CAPTURE_FILE_PATTERN =
	/^(capture-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(jpeg|mp4|png)$/i;
const CAPTURE_RECORD_PATTERN =
	/^(capture-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/i;
const udidSchema = z.string().regex(UDID_PATTERN);

export const DEFAULT_SIMULATOR_CAPTURE_RETENTION_POLICY = {
	maxAgeDays: 30,
	maxTotalBytes: 10 * 1024 * 1024 * 1024,
} as const satisfies SimulatorCaptureRetentionPolicy;

const captureRecordSchema = z.strictObject({
	version: z.literal(1),
	id: simulatorCaptureIdSchema,
	deviceUdid: udidSchema,
	kind: z.enum(['screenshot', 'video']),
	status: z.enum(['pending', 'complete', 'partial']),
	createdAt: z.number().finite().nonnegative(),
	name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
	mimeType: z.enum(['image/png', 'image/jpeg', 'video/mp4']),
	bytes: z.number().int().nonnegative().max(MAX_CAPTURE_BYTES),
});
type CaptureRecord = z.infer<typeof captureRecordSchema>;

const policyFileSchema = z.strictObject({
	version: z.literal(1),
	policy: simulatorCaptureRetentionPolicySchema,
});

export type PendingSimulatorCapture = {
	id: string;
	path: string;
	name: string;
	deviceUdid: string;
	kind: SimulatorCapture['kind'];
	mimeType: SimulatorCapture['mimeType'];
};

export type OpenSimulatorCapture = {
	capture: SimulatorCapture;
	handle: Awaited<ReturnType<typeof open>>;
	size: number;
};

function safeCaptureStem(value: string | undefined, fallback: string): string {
	const normalized = (value ?? fallback)
		.normalize('NFKC')
		.replaceAll(/[^A-Za-z0-9._-]+/g, '-')
		.replaceAll(/\.{2,}/g, '-')
		.replaceAll(/^[._-]+|[._-]+$/g, '')
		.slice(0, 80);
	return normalized && normalized !== '.' && normalized !== '..'
		? normalized
		: fallback;
}

function extensionForMimeType(mimeType: SimulatorCapture['mimeType']): string {
	if (mimeType === 'image/png') return 'png';
	if (mimeType === 'image/jpeg') return 'jpeg';
	return 'mp4';
}

function publicCapture(record: CaptureRecord): SimulatorCapture {
	if (record.status === 'pending') {
		throw new Error('Pending captures are not public artifacts.');
	}
	return {
		id: record.id,
		deviceUdid: record.deviceUdid,
		kind: record.kind,
		status: record.status,
		createdAt: record.createdAt,
		name: record.name,
		mimeType: record.mimeType,
		bytes: record.bytes,
	};
}

export function simulatorCaptureUrl(captureId: string): string {
	const id = simulatorCaptureIdSchema.parse(captureId);
	return `${SIMULATOR_CAPTURE_PROTOCOL_SCHEME}://capture/${id}`;
}

export class SimulatorCaptureStore {
	readonly #root: string;
	readonly #now: () => number;
	readonly #defaultPolicy: SimulatorCaptureRetentionPolicy;
	readonly #records = new Map<string, CaptureRecord>();
	#policy: SimulatorCaptureRetentionPolicy;
	#filesDirectory: string | undefined;
	#recordsDirectory: string | undefined;
	#policyPath: string | undefined;
	#lastPrunedAt: number | undefined;
	#initializePromise: Promise<void> | undefined;
	#mutationQueue: Promise<void> = Promise.resolve();

	constructor(
		root: string,
		{
			now = Date.now,
			defaultPolicy = DEFAULT_SIMULATOR_CAPTURE_RETENTION_POLICY,
		}: {
			now?: () => number;
			defaultPolicy?: SimulatorCaptureRetentionPolicy;
		} = {}
	) {
		this.#root = path.resolve(root);
		this.#now = now;
		this.#defaultPolicy =
			simulatorCaptureRetentionPolicySchema.parse(defaultPolicy);
		this.#policy = this.#defaultPolicy;
	}

	initialize(): Promise<void> {
		if (this.#initializePromise) return this.#initializePromise;
		const initialize = this.#initializeInternal().catch((error: unknown) => {
			if (this.#initializePromise === initialize)
				this.#initializePromise = undefined;
			throw error;
		});
		this.#initializePromise = initialize;
		return initialize;
	}

	list(): SimulatorCapture[] {
		return [...this.#records.values()]
			.filter((record) => record.status !== 'pending')
			.sort(
				(left, right) =>
					right.createdAt - left.createdAt || right.id.localeCompare(left.id)
			)
			.map(publicCapture);
	}

	get(captureId: string): SimulatorCapture | undefined {
		const id = simulatorCaptureIdSchema.parse(captureId);
		const record = this.#records.get(id);
		return record?.status === 'pending'
			? undefined
			: record && publicCapture(record);
	}

	retentionState(): SimulatorCaptureRetentionState {
		const captures = [...this.#records.values()].filter(
			(record) => record.status !== 'pending'
		);
		return {
			policy: { ...this.#policy },
			captureCount: captures.length,
			totalBytes: captures.reduce((total, record) => total + record.bytes, 0),
			...(this.#lastPrunedAt === undefined
				? {}
				: { lastPrunedAt: this.#lastPrunedAt }),
		};
	}

	async reserve({
		deviceUdid,
		kind,
		format,
		name,
	}: {
		deviceUdid: string;
		kind: SimulatorCapture['kind'];
		format: 'jpeg' | 'mp4' | 'png';
		name?: string;
	}): Promise<PendingSimulatorCapture> {
		await this.initialize();
		return this.#mutate(async () => {
			const id = `capture-${randomUUID()}`;
			const mimeType =
				format === 'png'
					? 'image/png'
					: format === 'jpeg'
						? 'image/jpeg'
						: 'video/mp4';
			const capturedAt = this.#now();
			const stem = safeCaptureStem(name, kind);
			const captureName = `${stem}-${capturedAt}-${id.slice(-8)}.${format}`;
			const record = captureRecordSchema.parse({
				version: 1,
				id,
				deviceUdid,
				kind,
				status: 'pending',
				createdAt: capturedAt,
				name: captureName,
				mimeType,
				bytes: 0,
			});
			const capturePath = this.#capturePath(record);
			try {
				await lstat(capturePath);
				throw new Error('Capture identifier collision.');
			} catch (error) {
				if (!isMissing(error)) throw error;
			}
			await this.#persistRecord(record);
			this.#records.set(record.id, record);
			return {
				id: record.id,
				path: capturePath,
				name: record.name,
				deviceUdid: record.deviceUdid,
				kind: record.kind,
				mimeType: record.mimeType,
			};
		});
	}

	async commit(
		pending: PendingSimulatorCapture,
		{ partial = false }: { partial?: boolean } = {}
	): Promise<SimulatorCapture> {
		await this.initialize();
		return this.#mutate(async () => {
			const record = this.#pendingRecord(pending);
			const metadata = await this.#syncCaptureFile(record);
			if (metadata.size === 0) throw new Error('Simulator capture was empty.');
			const committed = captureRecordSchema.parse({
				...record,
				status: partial ? 'partial' : 'complete',
				bytes: metadata.size,
			});
			await this.#persistRecord(committed);
			this.#records.set(committed.id, committed);
			await this.#pruneInternal();
			return publicCapture(committed);
		});
	}

	async discard(pending: PendingSimulatorCapture): Promise<void> {
		await this.initialize();
		await this.#mutate(async () => {
			const id = simulatorCaptureIdSchema.parse(pending.id);
			const record = this.#records.get(id);
			if (record?.status === 'pending') await this.#removeRecord(record);
		});
	}

	async delete(captureId: string): Promise<boolean> {
		await this.initialize();
		return this.#mutate(async () => {
			const id = simulatorCaptureIdSchema.parse(captureId);
			const record = this.#records.get(id);
			if (!record || record.status === 'pending') return false;
			await this.#removeRecord(record);
			this.#lastPrunedAt = this.#now();
			return true;
		});
	}

	async configureRetention(
		policy: SimulatorCaptureRetentionPolicy
	): Promise<SimulatorCaptureRetentionState> {
		await this.initialize();
		return this.#mutate(async () => {
			const validated = simulatorCaptureRetentionPolicySchema.parse(policy);
			await this.#persistPolicy(validated);
			this.#policy = validated;
			await this.#pruneInternal();
			return this.retentionState();
		});
	}

	async openForRead(captureId: string): Promise<OpenSimulatorCapture> {
		await this.initialize();
		return this.#mutate(async () => {
			const id = simulatorCaptureIdSchema.parse(captureId);
			const record = this.#records.get(id);
			if (!record || record.status === 'pending') {
				throw Object.assign(new Error('Capture is not available.'), {
					code: 'ENOENT',
				});
			}
			await this.#safeFileMetadata(record);
			const capturePath = this.#capturePath(record);
			const handle = await open(
				capturePath,
				constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
			);
			try {
				const metadata = await handle.stat();
				if (
					!metadata.isFile() ||
					metadata.size === 0 ||
					metadata.size > MAX_CAPTURE_BYTES ||
					metadata.size !== record.bytes
				) {
					throw new Error(
						'Capture file no longer matches its trusted metadata.'
					);
				}
				return { capture: publicCapture(record), handle, size: metadata.size };
			} catch (error) {
				await handle.close();
				throw error;
			}
		});
	}

	async verifiedPath(captureId: string): Promise<string> {
		const opened = await this.openForRead(captureId);
		try {
			const record = this.#records.get(opened.capture.id);
			if (!record || record.status === 'pending') {
				throw new Error('Capture is no longer available.');
			}
			return this.#capturePath(record);
		} finally {
			await opened.handle.close();
		}
	}

	async export(captureId: string, destinationPath: string): Promise<void> {
		const opened = await this.openForRead(captureId);
		let destinationHandle: Awaited<ReturnType<typeof open>> | undefined;
		let temporaryPath: string | undefined;
		try {
			const requestedDestination = path.resolve(destinationPath);
			const destinationDirectory = await realpath(
				path.dirname(requestedDestination)
			);
			const destinationName = path.basename(requestedDestination);
			if (
				!destinationName ||
				destinationName === '.' ||
				destinationName === '..'
			) {
				throw new Error('Export destination is invalid.');
			}
			const canonicalRoot = await realpath(this.#root);
			if (
				destinationDirectory === canonicalRoot ||
				destinationDirectory.startsWith(`${canonicalRoot}${path.sep}`)
			) {
				throw new Error('Captures cannot be exported into managed storage.');
			}
			temporaryPath = path.join(
				destinationDirectory,
				`.${destinationName}.rndevtools-${randomUUID()}.tmp`
			);
			destinationHandle = await open(
				temporaryPath,
				constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
				0o600
			);
			const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
			let position = 0;
			while (position < opened.size) {
				const length = Math.min(buffer.length, opened.size - position);
				const { bytesRead } = await opened.handle.read(
					buffer,
					0,
					length,
					position
				);
				if (bytesRead === 0) throw new Error('Capture changed during export.');
				let written = 0;
				while (written < bytesRead) {
					const result = await destinationHandle.write(
						buffer,
						written,
						bytesRead - written,
						position + written
					);
					written += result.bytesWritten;
				}
				position += bytesRead;
			}
			await destinationHandle.sync();
			await destinationHandle.close();
			destinationHandle = undefined;
			await rename(
				temporaryPath,
				path.join(destinationDirectory, destinationName)
			);
			temporaryPath = undefined;
			await syncDirectory(destinationDirectory);
		} finally {
			await destinationHandle?.close().catch(() => undefined);
			await opened.handle.close().catch(() => undefined);
			if (temporaryPath)
				await rm(temporaryPath, { force: true }).catch(() => undefined);
		}
	}

	async #initializeInternal(): Promise<void> {
		const canonicalRoot = await ensurePrivateDirectory(
			this.#root,
			'Capture storage'
		);
		this.#filesDirectory = await ensurePrivateDirectory(
			path.join(canonicalRoot, 'files'),
			'Capture storage'
		);
		this.#recordsDirectory = await ensurePrivateDirectory(
			path.join(canonicalRoot, 'records'),
			'Capture storage'
		);
		this.#policyPath = path.join(canonicalRoot, 'retention-v1.json');
		this.#policy = await this.#loadPolicy();
		await this.#loadRecords();
		await this.#pruneInternal();
	}

	async #loadPolicy(): Promise<SimulatorCaptureRetentionPolicy> {
		const policyPath = this.#requiredPolicyPath();
		try {
			const value = await this.#readBoundedJson(policyPath, MAX_POLICY_BYTES);
			return policyFileSchema.parse(value).policy;
		} catch (error) {
			if (isMissing(error)) return this.#defaultPolicy;
			await this.#quarantine(policyPath, 'retention');
			return this.#defaultPolicy;
		}
	}

	async #loadRecords(): Promise<void> {
		const recordsDirectory = this.#requiredRecordsDirectory();
		const filesDirectory = this.#requiredFilesDirectory();
		const quarantinedIds = new Set<string>();
		for (const entry of await readdir(recordsDirectory, {
			withFileTypes: true,
		})) {
			const match = CAPTURE_RECORD_PATTERN.exec(entry.name);
			if (!match) {
				if (entry.name.includes('.tmp')) {
					await rm(path.join(recordsDirectory, entry.name), {
						force: true,
					}).catch(() => undefined);
				}
				continue;
			}
			const id = match[1];
			if (!id) continue;
			const recordPath = path.join(recordsDirectory, entry.name);
			try {
				if (!entry.isFile() || entry.isSymbolicLink()) {
					throw new Error('Capture metadata was not a regular file.');
				}
				const value = await this.#readBoundedJson(recordPath, MAX_RECORD_BYTES);
				let record = captureRecordSchema.parse(value);
				if (record.id.toLowerCase() !== id.toLowerCase()) {
					throw new Error(
						'Capture metadata identifier did not match its filename.'
					);
				}
				const metadata = await this.#safeFileMetadata(record);
				if (metadata.size === 0) {
					await this.#removeRecordFiles(record);
					continue;
				}
				if (record.status === 'pending' || record.bytes !== metadata.size) {
					record = captureRecordSchema.parse({
						...record,
						status: 'partial',
						bytes: metadata.size,
					});
					await this.#persistRecord(record);
				}
				this.#records.set(record.id, record);
			} catch (error) {
				if (isMissing(error)) {
					await rm(recordPath, { force: true }).catch(() => undefined);
				} else {
					quarantinedIds.add(id.toLowerCase());
					await this.#quarantine(recordPath, `capture-${id}`);
				}
			}
		}

		for (const entry of await readdir(filesDirectory, {
			withFileTypes: true,
		})) {
			const match = CAPTURE_FILE_PATTERN.exec(entry.name);
			if (!match) continue;
			const id = match[1];
			if (!id) continue;
			if (!this.#records.has(id) && !quarantinedIds.has(id.toLowerCase())) {
				await rm(path.join(filesDirectory, entry.name), { force: true }).catch(
					() => undefined
				);
			}
		}
	}

	async #readBoundedJson(
		filePath: string,
		maximumBytes: number
	): Promise<unknown> {
		const metadata = await lstat(filePath);
		if (
			!metadata.isFile() ||
			metadata.isSymbolicLink() ||
			metadata.size > maximumBytes
		) {
			throw new Error('Capture metadata was not a bounded regular file.');
		}
		const handle = await open(
			filePath,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
		);
		try {
			return JSON.parse(await handle.readFile({ encoding: 'utf8' })) as unknown;
		} finally {
			await handle.close();
		}
	}

	async #persistRecord(record: CaptureRecord): Promise<void> {
		await this.#writeAtomicJson(
			this.#recordPath(record.id),
			record,
			MAX_RECORD_BYTES
		);
	}

	async #persistPolicy(policy: SimulatorCaptureRetentionPolicy): Promise<void> {
		await this.#writeAtomicJson(
			this.#requiredPolicyPath(),
			{ version: 1, policy },
			MAX_POLICY_BYTES
		);
	}

	async #writeAtomicJson(
		destinationPath: string,
		value: unknown,
		maximumBytes: number
	): Promise<void> {
		const serialized = `${JSON.stringify(value)}\n`;
		if (Buffer.byteLength(serialized, 'utf8') > maximumBytes) {
			throw new Error('Capture metadata exceeded its safe size limit.');
		}
		await writeFileAtomic(destinationPath, serialized, 'capture');
	}

	async #pruneInternal(): Promise<number> {
		const now = this.#now();
		const cutoff = now - this.#policy.maxAgeDays * MILLISECONDS_PER_DAY;
		const publicRecords = [...this.#records.values()]
			.filter((record) => record.status !== 'pending')
			.sort(
				(left, right) =>
					left.createdAt - right.createdAt || left.id.localeCompare(right.id)
			);
		const removeIds = new Set(
			publicRecords
				.filter((record) => record.createdAt < cutoff)
				.map((record) => record.id)
		);
		let retainedBytes = publicRecords.reduce(
			(total, record) => total + (removeIds.has(record.id) ? 0 : record.bytes),
			0
		);
		let retainedCount = publicRecords.length - removeIds.size;
		for (const record of publicRecords) {
			if (removeIds.has(record.id)) continue;
			if (
				retainedBytes <= this.#policy.maxTotalBytes &&
				retainedCount <= MAX_CAPTURE_RECORDS
			) {
				break;
			}
			removeIds.add(record.id);
			retainedBytes -= record.bytes;
			retainedCount -= 1;
		}
		for (const id of removeIds) {
			const record = this.#records.get(id);
			if (record) await this.#removeRecord(record);
		}
		this.#lastPrunedAt = now;
		return removeIds.size;
	}

	async #removeRecord(record: CaptureRecord): Promise<void> {
		await rm(this.#recordPath(record.id), { force: true });
		await syncDirectory(this.#requiredRecordsDirectory());
		this.#records.delete(record.id);
		await rm(this.#capturePath(record), { force: true });
		await syncDirectory(this.#requiredFilesDirectory());
	}

	async #removeRecordFiles(record: CaptureRecord): Promise<void> {
		const recordPath = this.#recordPath(record.id);
		const capturePath = this.#capturePath(record);
		await rm(recordPath, { force: true });
		await syncDirectory(this.#requiredRecordsDirectory());
		await rm(capturePath, { force: true });
		await syncDirectory(this.#requiredFilesDirectory());
	}

	async #quarantine(filePath: string, label: string): Promise<void> {
		try {
			const directory = path.dirname(filePath);
			const destination = path.join(
				directory,
				`.${safeCaptureStem(label, 'metadata')}.corrupt-${randomUUID()}`
			);
			await rename(filePath, destination);
			await syncDirectory(directory);
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
	}

	async #safeFileMetadata(record: CaptureRecord) {
		const capturePath = this.#capturePath(record);
		const metadata = await lstat(capturePath);
		if (
			!metadata.isFile() ||
			metadata.isSymbolicLink() ||
			metadata.size > MAX_CAPTURE_BYTES
		) {
			throw new Error('Simulator capture was not a bounded regular file.');
		}
		const canonicalPath = await realpath(capturePath);
		const filesDirectory = this.#requiredFilesDirectory();
		if (!canonicalPath.startsWith(`${filesDirectory}${path.sep}`)) {
			throw new Error('Simulator capture escaped managed storage.');
		}
		return metadata;
	}

	async #syncCaptureFile(record: CaptureRecord) {
		const expected = await this.#safeFileMetadata(record);
		const handle = await open(
			this.#capturePath(record),
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
		);
		try {
			const opened = await handle.stat();
			if (!opened.isFile() || opened.size !== expected.size) {
				throw new Error(
					'Simulator capture changed while it was being committed.'
				);
			}
			await handle.chmod(0o600);
			await handle.sync();
			await syncDirectory(this.#requiredFilesDirectory());
			return opened;
		} finally {
			await handle.close();
		}
	}

	#pendingRecord(pending: PendingSimulatorCapture): CaptureRecord {
		const id = simulatorCaptureIdSchema.parse(pending.id);
		const record = this.#records.get(id);
		if (
			record?.status !== 'pending' ||
			pending.path !== this.#capturePath(record) ||
			pending.name !== record.name ||
			pending.deviceUdid !== record.deviceUdid ||
			pending.kind !== record.kind ||
			pending.mimeType !== record.mimeType
		) {
			throw new Error(
				'Capture reservation no longer matches managed metadata.'
			);
		}
		return record;
	}

	#capturePath(record: Pick<CaptureRecord, 'id' | 'mimeType'>): string {
		const filesDirectory = this.#requiredFilesDirectory();
		const candidate = path.resolve(
			filesDirectory,
			`${record.id}.${extensionForMimeType(record.mimeType)}`
		);
		if (!candidate.startsWith(`${filesDirectory}${path.sep}`)) {
			throw new Error('Capture path escaped managed storage.');
		}
		return candidate;
	}

	#recordPath(captureId: string): string {
		const id = simulatorCaptureIdSchema.parse(captureId);
		const recordsDirectory = this.#requiredRecordsDirectory();
		const candidate = path.resolve(recordsDirectory, `${id}.json`);
		if (!candidate.startsWith(`${recordsDirectory}${path.sep}`)) {
			throw new Error('Capture metadata path escaped managed storage.');
		}
		return candidate;
	}

	#requiredFilesDirectory(): string {
		if (!this.#filesDirectory)
			throw new Error('Capture storage is not initialized.');
		return this.#filesDirectory;
	}

	#requiredRecordsDirectory(): string {
		if (!this.#recordsDirectory)
			throw new Error('Capture storage is not initialized.');
		return this.#recordsDirectory;
	}

	#requiredPolicyPath(): string {
		if (!this.#policyPath)
			throw new Error('Capture storage is not initialized.');
		return this.#policyPath;
	}

	async #mutate<T>(operation: () => Promise<T>): Promise<T> {
		const task = this.#mutationQueue.then(operation);
		this.#mutationQueue = task.then(
			() => undefined,
			() => undefined
		);
		return task;
	}
}

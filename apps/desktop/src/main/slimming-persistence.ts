import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { UDID_PATTERN } from '../shared/simulator-protocol';
import type {
	SlimmingCheckpointMetadata,
	SlimmingOperationMetadata,
} from '../shared/slimming-protocol';
import { writeFileAtomic } from './private-files';

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 32 * 1024;
const MAX_SIMULATORS = 200;
const MAX_OPERATIONS = 20;
const identifierSchema = z.string().trim().min(1).max(256);
const shortTextSchema = z.string().max(4 * 1024);
const timestampSchema = z.number().finite().nonnegative();
const udidSchema = z.string().regex(UDID_PATTERN);

const checkpointMetadataSchema = z.strictObject({
	id: identifierSchema,
	createdAt: timestampSchema,
	sourceOperationId: identifierSchema,
	profileId: identifierSchema.optional(),
	helperVersion: shortTextSchema,
	catalogVersion: shortTextSchema,
	compatibilityMatrixVersion: shortTextSchema,
});

const operationMetadataSchema = z.strictObject({
	id: identifierSchema,
	actionId: identifierSchema,
	kind: shortTextSchema,
	status: z.enum(['complete', 'failed', 'needs-attention', 'cancelled']),
	startedAt: timestampSchema,
	finishedAt: timestampSchema,
	profileId: identifierSchema.optional(),
	changed: z.boolean().optional(),
	condition: z
		.enum([
			'managed-clean',
			'profile-match',
			'drifted',
			'partial',
			'unknown',
			'needs-attention',
		])
		.optional(),
	errorCode: identifierSchema.optional(),
	message: shortTextSchema,
});

const settingSchema = z.strictObject({
	experimentalMutationsEnabled: z.boolean(),
	updatedAt: timestampSchema.optional(),
	disabledDisposition: z
		.enum([
			'restored-and-verified',
			'left-overrides-in-place',
			'restore-pending',
			'restore-failed',
		])
		.optional(),
	warning: shortTextSchema.optional(),
});
export type PersistedSlimmingSetting = z.infer<typeof settingSchema>;

const checkpointSchema = z.strictObject({
	metadata: checkpointMetadataSchema,
	token: z
		.string()
		.refine(
			(value) => Buffer.byteLength(value, 'utf8') <= MAX_CHECKPOINT_BYTES,
			'checkpoint token exceeds 32 KiB'
		),
});

const managedServiceIdsSchema = z
	.array(
		z
			.string()
			.trim()
			.min(3)
			.max(128)
			.regex(/^[A-Za-z0-9][A-Za-z0-9._-]+$/)
	)
	.max(1_000)
	.refine((values) => new Set(values).size === values.length);

const pendingMutationSchema = z.strictObject({
	id: identifierSchema,
	actionId: identifierSchema,
	operation: z.enum(['apply_profile', 'restore_managed', 'undo_last']),
	profileId: identifierSchema.optional(),
	startedAt: timestampSchema,
	checkpointToken: checkpointSchema.shape.token,
	originalBootState: z.enum(['Booted', 'Shutdown']),
	beforeServiceIds: managedServiceIdsSchema,
	desiredServiceIds: managedServiceIdsSchema,
	compatibilityKey: z.string().regex(/^compatibility-[a-f0-9]{64}$/),
	compatibilityStatus: z.enum(['verified', 'limited', 'unknown']),
	matrixVersion: shortTextSchema,
	tuple: z.strictObject({
		macOSBuild: shortTextSchema,
		xcodeBuild: shortTextSchema,
		coreSimulatorBuild: shortTextSchema,
		runtimeIdentifier: shortTextSchema,
		runtimeBuild: shortTextSchema,
		hostArchitecture: z.enum(['arm64', 'x64']),
		helperVersion: shortTextSchema,
		helperBuildCommit: z
			.string()
			.regex(/^[a-f0-9]{40}(?:-dirty:[a-f0-9]{64})?$/),
		catalogVersion: shortTextSchema,
	}),
	recovery: z
		.strictObject({
			id: identifierSchema,
			startedAt: timestampSchema,
			checkpointToken: checkpointSchema.shape.token,
			beforeServiceIds: managedServiceIdsSchema,
		})
		.optional(),
});
export type PendingSlimmingMutation = z.infer<typeof pendingMutationSchema>;

function boundedRecord<T extends z.ZodType>(value: T) {
	return z
		.record(udidSchema, value)
		.refine(
			(record) => Object.keys(record).length <= MAX_SIMULATORS,
			`record exceeds ${MAX_SIMULATORS} simulators`
		);
}

const persistenceSchema = z.strictObject({
	version: z.literal(1),
	setting: settingSchema,
	checkpoints: boundedRecord(checkpointSchema),
	operations: boundedRecord(
		z.array(operationMetadataSchema).max(MAX_OPERATIONS)
	),
	pendingMutations: boundedRecord(pendingMutationSchema).default({}),
	acknowledgements: z
		.record(
			z.string().regex(/^compatibility-[a-f0-9]{64}$/),
			z.strictObject({ acknowledgedAt: timestampSchema })
		)
		.refine((record) => Object.keys(record).length <= MAX_SIMULATORS),
});
type PersistenceData = z.infer<typeof persistenceSchema>;

function emptyData(): PersistenceData {
	return {
		version: 1,
		setting: { experimentalMutationsEnabled: false },
		checkpoints: {},
		operations: {},
		pendingMutations: {},
		acknowledgements: {},
	};
}

export type SlimmingPersistenceSnapshot = {
	setting: PersistedSlimmingSetting;
	checkpointBySimulator: Record<string, SlimmingCheckpointMetadata>;
	operationsBySimulator: Record<string, SlimmingOperationMetadata[]>;
};

export class SlimmingPersistence {
	readonly #directory: string;
	readonly #filePath: string;
	#data: PersistenceData = emptyData();
	#writeQueue: Promise<void> = Promise.resolve();

	constructor(directory: string) {
		this.#directory = path.resolve(directory);
		this.#filePath = path.join(this.#directory, 'state-v1.json');
	}

	async load(): Promise<SlimmingPersistenceSnapshot> {
		await mkdir(this.#directory, { recursive: true, mode: 0o700 });
		await chmod(this.#directory, 0o700);
		try {
			const metadata = await lstat(this.#filePath);
			if (
				!metadata.isFile() ||
				metadata.isSymbolicLink() ||
				metadata.size > MAX_FILE_BYTES
			) {
				throw new Error('Slimming persistence is not a bounded regular file.');
			}
			const handle = await open(
				this.#filePath,
				constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
			);
			try {
				const contents = await handle.readFile({ encoding: 'utf8' });
				this.#data = persistenceSchema.parse(JSON.parse(contents));
			} finally {
				await handle.close();
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			this.#data = emptyData();
		}
		return this.snapshot();
	}

	snapshot(): SlimmingPersistenceSnapshot {
		const checkpointBySimulator: Record<string, SlimmingCheckpointMetadata> =
			{};
		for (const [udid, checkpoint] of Object.entries(this.#data.checkpoints)) {
			checkpointBySimulator[udid] = { ...checkpoint.metadata };
		}
		const operationsBySimulator: Record<string, SlimmingOperationMetadata[]> =
			{};
		for (const [udid, operations] of Object.entries(this.#data.operations)) {
			operationsBySimulator[udid] = operations.map((operation) => ({
				...operation,
			}));
		}
		return {
			setting: { ...this.#data.setting },
			checkpointBySimulator,
			operationsBySimulator,
		};
	}

	pendingMutations(): Record<string, PendingSlimmingMutation> {
		return Object.fromEntries(
			Object.entries(this.#data.pendingMutations).map(([udid, pending]) => [
				udid,
				pendingMutationSchema.parse(pending),
			])
		);
	}

	checkpointToken(simulatorUdid: string): string | undefined {
		return this.#data.checkpoints[udidSchema.parse(simulatorUdid).toUpperCase()]
			?.token;
	}

	pendingMutation(simulatorUdid: string): PendingSlimmingMutation | undefined {
		const pending =
			this.#data.pendingMutations[
				udidSchema.parse(simulatorUdid).toUpperCase()
			];
		return pending ? pendingMutationSchema.parse(pending) : undefined;
	}

	isAcknowledged(key: string): boolean {
		return this.#data.acknowledgements[key] !== undefined;
	}

	async setSetting(setting: PersistedSlimmingSetting): Promise<void> {
		const validated = settingSchema.parse(setting);
		await this.#update((draft) => {
			draft.setting = validated;
		});
	}

	async acknowledgeAll(
		keys: readonly string[],
		acknowledgedAt: number
	): Promise<void> {
		const validatedKeys = z
			.array(z.string().regex(/^compatibility-[a-f0-9]{64}$/))
			.min(1)
			.max(20)
			.refine((values) => new Set(values).size === values.length)
			.parse(keys);
		await this.#update((draft) => {
			let changed = false;
			for (const validatedKey of validatedKeys) {
				if (draft.acknowledgements[validatedKey]) continue;
				if (Object.keys(draft.acknowledgements).length >= MAX_SIMULATORS) {
					const oldest = Object.entries(draft.acknowledgements).sort(
						(left, right) => left[1].acknowledgedAt - right[1].acknowledgedAt
					)[0]?.[0];
					if (oldest) delete draft.acknowledgements[oldest];
				}
				draft.acknowledgements[validatedKey] = { acknowledgedAt };
				changed = true;
			}
			return changed;
		});
	}

	async beginPendingMutation(
		simulatorUdid: string,
		pendingMutation: PendingSlimmingMutation
	): Promise<void> {
		const udid = udidSchema.parse(simulatorUdid).toUpperCase();
		const validated = pendingMutationSchema.parse(pendingMutation);
		await this.#update((draft) => {
			if (draft.pendingMutations[udid]) {
				throw new Error(
					'A durable Simulator mutation is already pending reconciliation.'
				);
			}
			draft.pendingMutations[udid] = validated;
		});
	}

	async beginPendingRecovery(
		simulatorUdid: string,
		pendingMutationId: string,
		recovery: NonNullable<PendingSlimmingMutation['recovery']>
	): Promise<void> {
		const udid = udidSchema.parse(simulatorUdid).toUpperCase();
		const exactPendingId = identifierSchema.parse(pendingMutationId);
		const validatedRecovery = pendingMutationSchema.shape.recovery
			.unwrap()
			.parse(recovery);
		await this.#update((draft) => {
			const pending = draft.pendingMutations[udid];
			if (!pending || pending.id !== exactPendingId) {
				throw new Error(
					'Pending mutation no longer matches the recovery attempt.'
				);
			}
			// Atomically replace only the superseded intermediate-state checkpoint.
			// The original pre-mutation emergency checkpoint remains unchanged, and
			// the replacement captures the exact current state before the retry.
			pending.recovery = validatedRecovery;
		});
	}

	async recordPendingRecoveryFailure(
		simulatorUdid: string,
		pendingMutationId: string,
		operation: SlimmingOperationMetadata
	): Promise<void> {
		const udid = udidSchema.parse(simulatorUdid).toUpperCase();
		const exactPendingId = identifierSchema.parse(pendingMutationId);
		const validatedOperation = operationMetadataSchema.parse(operation);
		await this.#update((draft) => {
			const pending = draft.pendingMutations[udid];
			if (!pending || pending.id !== exactPendingId) {
				throw new Error(
					'Pending recovery no longer matches the durable record.'
				);
			}
			delete pending.recovery;
			const existing = draft.operations[udid] ?? [];
			draft.operations[udid] = [
				validatedOperation,
				...existing.filter(
					(candidate) => candidate.id !== validatedOperation.id
				),
			].slice(0, MAX_OPERATIONS);
		});
	}

	/**
	 * Settles the exact pending record. `clear` drops it, its emergency
	 * checkpoint token included, without promoting anything; its optional
	 * operation records why, in the same write.
	 */
	async resolvePendingMutation(
		simulatorUdid: string,
		pendingMutationId: string,
		resolution:
			| { kind: 'clear'; operation?: SlimmingOperationMetadata }
			| {
					kind: 'complete';
					checkpointMetadata?: SlimmingCheckpointMetadata;
					operation: SlimmingOperationMetadata;
			  }
			| { kind: 'needs-attention'; operation: SlimmingOperationMetadata }
	): Promise<void> {
		const udid = udidSchema.parse(simulatorUdid).toUpperCase();
		const exactPendingId = identifierSchema.parse(pendingMutationId);
		const validatedCheckpointMetadata =
			resolution.kind === 'complete' && resolution.checkpointMetadata
				? checkpointMetadataSchema.parse(resolution.checkpointMetadata)
				: undefined;
		const validatedOperation = resolution.operation
			? operationMetadataSchema.parse(resolution.operation)
			: undefined;
		await this.#update((draft) => {
			const pending = draft.pendingMutations[udid];
			if (!pending || pending.id !== exactPendingId) {
				throw new Error(
					'Pending mutation no longer matches the durable record.'
				);
			}
			if (resolution.kind === 'complete' && validatedCheckpointMetadata) {
				if (
					!draft.checkpoints[udid] &&
					Object.keys(draft.checkpoints).length >= MAX_SIMULATORS
				) {
					throw new Error(
						`Checkpoint store cannot exceed ${MAX_SIMULATORS} simulators.`
					);
				}
				draft.checkpoints[udid] = checkpointSchema.parse({
					metadata: validatedCheckpointMetadata,
					token: pending.checkpointToken,
				});
			}
			if (validatedOperation) {
				const existing = draft.operations[udid] ?? [];
				draft.operations[udid] = [
					validatedOperation,
					...existing.filter(
						(candidate) => candidate.id !== validatedOperation.id
					),
				].slice(0, MAX_OPERATIONS);
			}
			if (resolution.kind !== 'needs-attention') {
				delete draft.pendingMutations[udid];
			}
		});
	}

	async recordOperation(
		simulatorUdid: string,
		operation: SlimmingOperationMetadata
	): Promise<void> {
		const udid = udidSchema.parse(simulatorUdid).toUpperCase();
		const validatedOperation = operationMetadataSchema.parse(operation);
		await this.#update((draft) => {
			const existing = draft.operations[udid] ?? [];
			draft.operations[udid] = [
				validatedOperation,
				...existing.filter((candidate) => candidate.id !== operation.id),
			].slice(0, MAX_OPERATIONS);
		});
	}

	async #update(mutate: (draft: PersistenceData) => unknown): Promise<void> {
		const write = this.#writeQueue.then(async () => {
			const draft = persistenceSchema.parse(this.#data);
			if (mutate(draft) === false) return;
			await this.#persist(draft);
			this.#data = draft;
		});
		this.#writeQueue = write.catch(() => undefined);
		await write;
	}

	async #persist(snapshot: PersistenceData): Promise<void> {
		persistenceSchema.parse(snapshot);
		const serialized = `${JSON.stringify(snapshot)}\n`;
		if (Buffer.byteLength(serialized, 'utf8') > MAX_FILE_BYTES) {
			throw new Error('Slimming persistence exceeds its 16 MiB safety limit.');
		}
		await mkdir(this.#directory, { recursive: true, mode: 0o700 });
		const canonicalDirectory = await realpath(this.#directory);
		await writeFileAtomic(
			path.join(canonicalDirectory, path.basename(this.#filePath)),
			serialized,
			'state-v1'
		);
	}
}

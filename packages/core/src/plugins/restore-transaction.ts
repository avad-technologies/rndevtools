import { diagnosticErrorText } from '../core/redact';
import type {
	RestorePoint,
	RestorePointSource,
	RestorePointSourceSnapshot,
} from './restore-points';

export type RestoreTransactionStatus =
	| 'complete'
	| 'preflight-failed'
	| 'rolled-back'
	| 'needs-attention';

export type RestoreTransactionSourceResult = Readonly<{
	sourceId: string;
	sourceTitle: string;
	preflight: 'pending' | 'passed' | 'failed';
	apply: 'not-run' | 'succeeded' | 'failed';
	rollback: 'not-needed' | 'succeeded' | 'failed';
	error?: string;
	rollbackError?: string;
}>;

export type RestoreTransactionReceipt = Readonly<{
	id: string;
	pointId: string;
	pointLabel: string;
	startedAt: number;
	completedAt: number;
	status: RestoreTransactionStatus;
	sourceResults: readonly RestoreTransactionSourceResult[];
	error?: string;
}>;

export type RestoreTransactionOptions = Readonly<{
	sourceIds?: readonly string[];
}>;

type MutableSourceResult = {
	sourceId: string;
	sourceTitle: string;
	preflight: RestoreTransactionSourceResult['preflight'];
	apply: RestoreTransactionSourceResult['apply'];
	rollback: RestoreTransactionSourceResult['rollback'];
	error?: string;
	rollbackError?: string;
};

type OrderedSource = Readonly<{
	source: RestorePointSource;
	snapshot: RestorePointSourceSnapshot;
}>;

type CaptureSource = (
	source: RestorePointSource,
) => Promise<RestorePointSourceSnapshot>;

type ReceiptBase = Pick<
	RestoreTransactionReceipt,
	'id' | 'pointId' | 'pointLabel' | 'startedAt'
>;

const MAX_SELECTED_SOURCE_COUNT = 50;
const MAX_SOURCE_ID_LENGTH = 256;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

function normalizeRequestedSourceIds(
	requestedSourceIds?: readonly string[],
): readonly string[] | undefined {
	if (requestedSourceIds === undefined) return undefined;
	if (!Array.isArray(requestedSourceIds)) {
		throw new Error('Restore source selection must be an array.');
	}
	const lengthDescriptor = Object.getOwnPropertyDescriptor(
		requestedSourceIds,
		'length',
	);
	const length =
		lengthDescriptor &&
		'value' in lengthDescriptor &&
		Number.isSafeInteger(lengthDescriptor.value)
			? lengthDescriptor.value
			: -1;
	if (length < 1 || length > MAX_SELECTED_SOURCE_COUNT) {
		throw new Error(
			`Restore source selection must contain between 1 and ${MAX_SELECTED_SOURCE_COUNT} ids.`,
		);
	}
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < length; index += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(
			requestedSourceIds,
			String(index),
		);
		const sourceId =
			descriptor && 'value' in descriptor ? descriptor.value : undefined;
		if (
			typeof sourceId !== 'string' ||
			!sourceId ||
			sourceId.length > MAX_SOURCE_ID_LENGTH ||
			!SOURCE_ID_PATTERN.test(sourceId)
		) {
			throw new Error('Restore source selection contains an invalid id.');
		}
		if (seen.has(sourceId)) {
			throw new Error(`Duplicate restore source selection: ${sourceId}`);
		}
		seen.add(sourceId);
		normalized.push(sourceId);
	}
	return normalized;
}

function cloneSnapshot(snapshot: RestorePointSourceSnapshot): unknown {
	return JSON.parse(snapshot.json);
}

function resolveOrder(
	point: RestorePoint,
	sources: readonly RestorePointSource[],
	requestedSourceIds?: readonly string[],
): readonly OrderedSource[] {
	const normalizedRequestedSourceIds =
		normalizeRequestedSourceIds(requestedSourceIds);
	const sourceById = new Map(sources.map((source) => [source.id, source]));
	const snapshotById = new Map(
		point.sources.map((snapshot) => [snapshot.sourceId, snapshot]),
	);
	const selected = new Set(
		normalizedRequestedSourceIds === undefined
			? point.sources.map((snapshot) => snapshot.sourceId)
			: normalizedRequestedSourceIds,
	);
	if (selected.size === 0) {
		throw new Error('At least one restore source must be selected.');
	}
	for (const sourceId of selected) {
		if (!snapshotById.has(sourceId)) {
			throw new Error(`Restore point does not contain source: ${sourceId}`);
		}
	}

	const includeDependencies = (
		sourceId: string,
		chain: readonly string[],
	): void => {
		if (chain.includes(sourceId)) {
			throw new Error(
				`Restore source dependency cycle: ${[...chain, sourceId].join(' -> ')}`,
			);
		}
		const source = sourceById.get(sourceId);
		if (!source)
			throw new Error(`Restore source is no longer registered: ${sourceId}`);
		for (const dependencyId of source.dependencies ?? []) {
			if (!snapshotById.has(dependencyId)) {
				throw new Error(
					`Restore source ${sourceId} requires missing snapshot ${dependencyId}.`,
				);
			}
			selected.add(dependencyId);
			includeDependencies(dependencyId, [...chain, sourceId]);
		}
	};
	for (const sourceId of [...selected]) includeDependencies(sourceId, []);

	const visiting = new Set<string>();
	const visited = new Set<string>();
	const ordered: OrderedSource[] = [];
	const visit = (sourceId: string): void => {
		if (visited.has(sourceId)) return;
		if (visiting.has(sourceId)) {
			throw new Error(`Restore source dependency cycle includes ${sourceId}.`);
		}
		visiting.add(sourceId);
		const source = sourceById.get(sourceId);
		const snapshot = snapshotById.get(sourceId);
		if (!source || !snapshot) {
			throw new Error(`Restore source is unavailable: ${sourceId}`);
		}
		for (const dependencyId of source.dependencies ?? []) {
			if (selected.has(dependencyId)) visit(dependencyId);
		}
		visiting.delete(sourceId);
		visited.add(sourceId);
		ordered.push({ source, snapshot });
	};
	for (const snapshot of point.sources) {
		if (selected.has(snapshot.sourceId)) visit(snapshot.sourceId);
	}
	return ordered;
}

function finalizeResults(
	results: readonly MutableSourceResult[],
): readonly RestoreTransactionSourceResult[] {
	return results.map((result) => ({ ...result }));
}

/**
 * Captures a rollback snapshot of every source, then applies them in order.
 * Once one fails, the sources attempted so far are restored from their
 * rollback snapshots in reverse.
 */
async function applyWithRollback<
	Entry extends Readonly<{ source: RestorePointSource }>,
>(
	ordered: readonly Entry[],
	apply: (entry: Entry) => void | Promise<void>,
	captureSource: CaptureSource,
	results: readonly MutableSourceResult[],
	receiptBase: ReceiptBase,
): Promise<RestoreTransactionReceipt> {
	const resultById = new Map(
		results.map((result) => [result.sourceId, result]),
	);
	const rollback = new Map<string, RestorePointSourceSnapshot>();
	for (const { source } of ordered) {
		try {
			rollback.set(source.id, await captureSource(source));
		} catch (error) {
			const result = resultById.get(source.id);
			if (result) {
				result.preflight = 'failed';
				result.error = diagnosticErrorText(error);
			}
			return {
				...receiptBase,
				completedAt: Date.now(),
				status: 'preflight-failed',
				sourceResults: finalizeResults(results),
				error: `Rollback capture failed for ${source.title}: ${diagnosticErrorText(error)}`,
			};
		}
	}

	const attempted: RestorePointSource[] = [];
	let applyError: string | undefined;
	for (const entry of ordered) {
		const { source } = entry;
		const result = resultById.get(source.id);
		attempted.push(source);
		try {
			await apply(entry);
			if (result) result.apply = 'succeeded';
		} catch (error) {
			applyError = diagnosticErrorText(error);
			if (result) {
				result.apply = 'failed';
				result.error = applyError;
			}
			break;
		}
	}
	if (!applyError) {
		return {
			...receiptBase,
			completedAt: Date.now(),
			status: 'complete',
			sourceResults: finalizeResults(results),
		};
	}

	let rollbackFailed = false;
	for (const source of attempted.reverse()) {
		const result = resultById.get(source.id);
		const snapshot = rollback.get(source.id);
		if (!snapshot) continue;
		try {
			await source.restore(cloneSnapshot(snapshot));
			if (result) result.rollback = 'succeeded';
		} catch (error) {
			rollbackFailed = true;
			if (result) {
				result.rollback = 'failed';
				result.rollbackError = diagnosticErrorText(error);
			}
		}
	}
	return {
		...receiptBase,
		completedAt: Date.now(),
		status: rollbackFailed ? 'needs-attention' : 'rolled-back',
		sourceResults: finalizeResults(results),
		error: applyError,
	};
}

export async function runRestoreTransaction(
	point: RestorePoint,
	sources: readonly RestorePointSource[],
	captureSource: CaptureSource,
	options: RestoreTransactionOptions = {},
): Promise<RestoreTransactionReceipt> {
	const startedAt = Date.now();
	const receiptBase: ReceiptBase = {
		id: `${startedAt.toString(36)}-${point.id}`,
		pointId: point.id,
		pointLabel: point.label,
		startedAt,
	};
	let ordered: readonly OrderedSource[];
	try {
		ordered = resolveOrder(point, sources, options.sourceIds);
	} catch (error) {
		return {
			...receiptBase,
			completedAt: Date.now(),
			status: 'preflight-failed',
			sourceResults: [],
			error: diagnosticErrorText(error),
		};
	}
	const results: MutableSourceResult[] = ordered.map(({ source }) => ({
		sourceId: source.id,
		sourceTitle: source.title,
		preflight: 'pending',
		apply: 'not-run',
		rollback: 'not-needed',
	}));
	const resultById = new Map(
		results.map((result) => [result.sourceId, result]),
	);

	for (const { source, snapshot } of ordered) {
		const result = resultById.get(source.id);
		try {
			await source.validate?.(cloneSnapshot(snapshot));
			if (result) result.preflight = 'passed';
		} catch (error) {
			if (result) {
				result.preflight = 'failed';
				result.error = diagnosticErrorText(error);
			}
			return {
				...receiptBase,
				completedAt: Date.now(),
				status: 'preflight-failed',
				sourceResults: finalizeResults(results),
				error: `Preflight failed for ${source.title}: ${diagnosticErrorText(error)}`,
			};
		}
	}

	return applyWithRollback(
		ordered,
		({ source, snapshot }) => source.restore(cloneSnapshot(snapshot)),
		captureSource,
		results,
		receiptBase,
	);
}

export async function runResetToBaselineTransaction(
	sources: readonly RestorePointSource[],
	captureSource: CaptureSource,
	options: RestoreTransactionOptions = {},
): Promise<RestoreTransactionReceipt> {
	const startedAt = Date.now();
	const receiptBase: ReceiptBase = {
		id: `${startedAt.toString(36)}-baseline`,
		pointId: 'baseline',
		pointLabel: 'Reset to baseline',
		startedAt,
	};
	let requested: Set<string> | undefined;
	try {
		const requestedIds = normalizeRequestedSourceIds(options.sourceIds);
		requested = requestedIds ? new Set(requestedIds) : undefined;
	} catch (error) {
		return {
			...receiptBase,
			completedAt: Date.now(),
			status: 'preflight-failed',
			sourceResults: [],
			error: diagnosticErrorText(error),
		};
	}
	const selected = sources.filter(
		(source) =>
			typeof source.resetToBaseline === 'function' &&
			(!requested || requested.has(source.id)),
	);
	if (requested) {
		for (const sourceId of requested) {
			if (!selected.some((source) => source.id === sourceId)) {
				return {
					...receiptBase,
					completedAt: Date.now(),
					status: 'preflight-failed',
					sourceResults: [],
					error: `Restore source cannot reset to baseline: ${sourceId}`,
				};
			}
		}
	}
	if (selected.length === 0) {
		return {
			...receiptBase,
			completedAt: Date.now(),
			status: 'preflight-failed',
			sourceResults: [],
			error: 'No selected restore sources implement resetToBaseline.',
		};
	}
	const results: MutableSourceResult[] = selected.map((source) => ({
		sourceId: source.id,
		sourceTitle: source.title,
		preflight: 'passed',
		apply: 'not-run',
		rollback: 'not-needed',
	}));
	return applyWithRollback(
		selected.map((source) => ({ source })),
		({ source }) => source.resetToBaseline?.(),
		captureSource,
		results,
		receiptBase,
	);
}

import type { Mutation, Query } from '@tanstack/react-query';
import { sanitizeDiagnosticValueWithMetadata } from '../core/redact';
import { serializeValue, truncateText } from '../core/serialize';
import type { QuerySimulationSnapshot } from './query-simulation';

const queryDiagnosticIds = new WeakMap<object, string>();
let nextQueryDiagnosticId = 1;

/**
 * Returns a session-local identifier without retaining TanStack Query's hash.
 * Query hashes can contain raw query-key credentials, so they must never be
 * copied into a diagnostic snapshot.
 */
export function queryDiagnosticId(query: Query): string {
	const existing = queryDiagnosticIds.get(query);
	if (existing) return existing;
	const id = `query-${nextQueryDiagnosticId}`;
	nextQueryDiagnosticId += 1;
	queryDiagnosticIds.set(query, id);
	return id;
}

export type QuerySnapshot = {
	hash: string;
	keySegments: readonly string[];
	key: string;
	status: string;
	fetchStatus: string;
	observerCount: number;
	isStale: boolean;
	dataUpdatedAt: number;
	errorUpdatedAt: number;
	dataUpdateCount: number;
	fetchFailureCount: number;
	data?: string;
	error?: string;
	truncated: boolean;
};

export type MutationSnapshot = {
	id: number;
	keySegments: readonly string[];
	key: string;
	status: string;
	submittedAt: number;
	failureCount: number;
	isPaused: boolean;
	variables?: string;
	data?: string;
	error?: string;
	truncated: boolean;
};

export type QueryPluginSnapshot = {
	queries: readonly QuerySnapshot[];
	mutations: readonly MutationSnapshot[];
	sourceQueryCount: number;
	omittedQueryCount: number;
	sourceMutationCount: number;
	omittedMutationCount: number;
	simulation?: QuerySimulationSnapshot;
	error?: string;
};

function serializedKey(value: unknown): {
	text: string;
	segments: readonly string[];
	truncated: boolean;
} {
	const sanitizedResult = sanitizeDiagnosticValueWithMetadata(value);
	const sanitized = sanitizedResult.value;
	const key = serializeValue(sanitized, 16 * 1024);
	const rawSegments = Array.isArray(sanitized) ? sanitized : [sanitized];
	const segments = rawSegments
		.slice(0, 32)
		.map((segment) =>
			typeof segment === 'string'
				? truncateText(segment, 512)
				: serializeValue(segment, 512),
		);
	return {
		text: key.text,
		segments: segments.map((segment) => segment.text.replace(/\s+/g, ' ')),
		truncated:
			sanitizedResult.truncated ||
			key.truncated ||
			rawSegments.length > 32 ||
			segments.some((segment) => segment.truncated),
	};
}

export function createQuerySnapshot(
	query: Query,
	captureData: boolean,
	maxSnapshotBytes: number,
): QuerySnapshot {
	const key = serializedKey(query.queryKey);
	const sanitizedData = captureData
		? sanitizeDiagnosticValueWithMetadata(query.state.data)
		: undefined;
	const data = sanitizedData
		? serializeValue(sanitizedData.value, maxSnapshotBytes)
		: undefined;
	const sanitizedError = query.state.error
		? sanitizeDiagnosticValueWithMetadata(query.state.error)
		: undefined;
	const error = sanitizedError
		? serializeValue(sanitizedError.value, maxSnapshotBytes)
		: undefined;
	return {
		hash: queryDiagnosticId(query),
		keySegments: key.segments,
		key: key.text,
		status: query.state.status,
		fetchStatus: query.state.fetchStatus,
		observerCount: query.getObserversCount(),
		isStale: query.isStale(),
		dataUpdatedAt: query.state.dataUpdatedAt,
		errorUpdatedAt: query.state.errorUpdatedAt,
		dataUpdateCount: query.state.dataUpdateCount,
		fetchFailureCount: query.state.fetchFailureCount,
		data: data?.text,
		error: error?.text,
		truncated:
			key.truncated ||
			!!sanitizedData?.truncated ||
			!!data?.truncated ||
			!!sanitizedError?.truncated ||
			!!error?.truncated,
	};
}

export function createMutationSnapshot<TData, TError, TVariables, TContext>(
	mutation: Mutation<TData, TError, TVariables, TContext>,
	captureData: boolean,
	maxSnapshotBytes: number,
): MutationSnapshot {
	const key = serializedKey(
		mutation.options.mutationKey ?? ['anonymous mutation'],
	);
	const sanitizedVariables = captureData
		? sanitizeDiagnosticValueWithMetadata(mutation.state.variables)
		: undefined;
	const variables = sanitizedVariables
		? serializeValue(sanitizedVariables.value, maxSnapshotBytes)
		: undefined;
	const sanitizedData = captureData
		? sanitizeDiagnosticValueWithMetadata(mutation.state.data)
		: undefined;
	const data = sanitizedData
		? serializeValue(sanitizedData.value, maxSnapshotBytes)
		: undefined;
	const sanitizedError = mutation.state.error
		? sanitizeDiagnosticValueWithMetadata(mutation.state.error)
		: undefined;
	const error = sanitizedError
		? serializeValue(sanitizedError.value, maxSnapshotBytes)
		: undefined;
	return {
		id: mutation.mutationId,
		keySegments: key.segments,
		key: key.text,
		status: mutation.state.status,
		submittedAt: mutation.state.submittedAt,
		failureCount: mutation.state.failureCount,
		isPaused: mutation.state.isPaused,
		variables: variables?.text,
		data: data?.text,
		error: error?.text,
		truncated:
			key.truncated ||
			!!sanitizedVariables?.truncated ||
			!!variables?.truncated ||
			!!sanitizedData?.truncated ||
			!!data?.truncated ||
			!!sanitizedError?.truncated ||
			!!error?.truncated,
	};
}

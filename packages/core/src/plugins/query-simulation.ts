import type { DevtoolsEventStore } from '../core/event-store';
import { ExternalStore } from '../core/external-store';
import { redactDiagnosticText } from '../core/redact';
import { truncateText, utf8ByteLength } from '../core/serialize';

export const QUERY_SIMULATION_MODES = [
	'loading',
	'error',
	'paused',
	'offline',
] as const;

export type QuerySimulationMode = (typeof QUERY_SIMULATION_MODES)[number];

export type QuerySimulationLease = Readonly<{
	release: () => void | Promise<void>;
}>;

export type QuerySimulationFamilyAdapter = Readonly<{
	id: string;
	label: string;
	description?: string;
	operations?: Partial<
		Readonly<
			Record<
				QuerySimulationMode,
				() => QuerySimulationLease | Promise<QuerySimulationLease>
			>
		>
	>;
	unsupportedReasons?: Partial<Readonly<Record<QuerySimulationMode, string>>>;
}>;

export type QuerySimulationFamilySnapshot = Readonly<{
	id: string;
	label: string;
	description?: string;
	modes: readonly Readonly<{
		mode: QuerySimulationMode;
		supported: boolean;
		reason?: string;
	}>[];
}>;

export type ActiveQuerySimulation = Readonly<{
	familyId: string;
	familyLabel: string;
	mode: QuerySimulationMode;
	receiptId: string;
	startedAt: number;
}>;

export type QuerySimulationSnapshot = Readonly<{
	families: readonly QuerySimulationFamilySnapshot[];
	active?: ActiveQuerySimulation;
}>;

export type QuerySimulationController = Readonly<{
	getSnapshot: () => QuerySimulationSnapshot;
	getServerSnapshot: () => QuerySimulationSnapshot;
	subscribe: (listener: () => void) => () => void;
	apply: (
		familyId: string,
		mode: QuerySimulationMode,
	) => Promise<ActiveQuerySimulation>;
	clear: (receiptId?: string) => Promise<void>;
}>;

type ActiveLease = ActiveQuerySimulation & {
	release: QuerySimulationLease['release'];
};

const ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const MAX_QUERY_SIMULATION_FAMILIES = 50;

function dataField(record: object, key: string, label: string): unknown {
	let descriptor: PropertyDescriptor | undefined;
	try {
		descriptor = Object.getOwnPropertyDescriptor(record, key);
	} catch {
		throw new Error(`${label} field ${key} is unreadable.`);
	}
	if (!descriptor) return undefined;
	if (!descriptor.enumerable || !('value' in descriptor)) {
		throw new Error(`${label} field ${key} must be an enumerable data field.`);
	}
	return descriptor.value;
}

function denseArrayValues(value: unknown, label: string): readonly unknown[] {
	if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
	let length: unknown;
	try {
		const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
		length =
			lengthDescriptor && 'value' in lengthDescriptor
				? lengthDescriptor.value
				: undefined;
	} catch {
		throw new Error(`${label} has an unreadable length.`);
	}
	if (
		!Number.isSafeInteger(length) ||
		(length as number) < 1 ||
		(length as number) > MAX_QUERY_SIMULATION_FAMILIES
	) {
		throw new Error(
			`${label} requires between 1 and ${MAX_QUERY_SIMULATION_FAMILIES} items.`,
		);
	}
	const entries: unknown[] = [];
	for (let index = 0; index < (length as number); index += 1) {
		const item = dataField(value, String(index), label);
		if (item === undefined) {
			throw new Error(`${label} cannot contain holes or undefined items.`);
		}
		entries.push(item);
	}
	return entries;
}

function plainDataRecord(value: unknown, label: string): object | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	try {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new Error(`${label} must be a plain object.`);
		}
		if (Object.getOwnPropertySymbols(value).length > 0) {
			throw new Error(`${label} cannot contain symbol fields.`);
		}
	} catch (error) {
		if (error instanceof Error && error.message.startsWith(label)) throw error;
		throw new Error(`${label} is unreadable.`);
	}
	return value;
}

function boundedText(value: unknown, name: string, maxBytes: number): string {
	if (
		typeof value !== 'string' ||
		!value.trim() ||
		utf8ByteLength(value) > maxBytes
	) {
		throw new Error(`${name} must be non-empty and at most ${maxBytes} bytes.`);
	}
	return truncateText(redactDiagnosticText(value.trim()), maxBytes).text;
}

function normalizeFamilies(
	families: readonly QuerySimulationFamilyAdapter[],
): readonly Readonly<{
	id: string;
	label: string;
	description?: string;
	operations: Readonly<
		Partial<
			Record<
				QuerySimulationMode,
				() => QuerySimulationLease | Promise<QuerySimulationLease>
			>
		>
	>;
	modes: QuerySimulationFamilySnapshot['modes'];
}>[] {
	const familyEntries = denseArrayValues(families, 'Query simulation families');
	const ids = new Set<string>();
	return familyEntries.map((familyValue) => {
		const family = plainDataRecord(familyValue, 'Query simulation family');
		if (!family) {
			throw new Error('Query simulation families must be objects.');
		}
		const id = boundedText(
			dataField(family, 'id', 'Query simulation family'),
			'Query simulation family id',
			256,
		);
		if (!ID_PATTERN.test(id) || ids.has(id)) {
			throw new Error(`Invalid or duplicate query simulation family id: ${id}`);
		}
		ids.add(id);
		const label = boundedText(
			dataField(family, 'label', 'Query simulation family'),
			'Query simulation family label',
			4_096,
		);
		const rawDescription = dataField(
			family,
			'description',
			'Query simulation family',
		);
		const description = rawDescription
			? boundedText(
					rawDescription,
					'Query simulation family description',
					4_096,
				)
			: undefined;
		const operationsRecord = plainDataRecord(
			dataField(family, 'operations', 'Query simulation family'),
			`Query simulation operations for ${id}`,
		);
		const unsupportedReasonsRecord = plainDataRecord(
			dataField(family, 'unsupportedReasons', 'Query simulation family'),
			`Query simulation unsupported reasons for ${id}`,
		);
		const operations: Partial<
			Record<
				QuerySimulationMode,
				() => QuerySimulationLease | Promise<QuerySimulationLease>
			>
		> = {};
		const modes = QUERY_SIMULATION_MODES.map((mode) => {
			const operation = operationsRecord
				? dataField(
						operationsRecord,
						mode,
						`Query simulation operations for ${id}`,
					)
				: undefined;
			if (operation !== undefined && typeof operation !== 'function') {
				throw new Error(
					`Query simulation operation ${id}.${mode} must be a function.`,
				);
			}
			if (typeof operation === 'function') {
				operations[mode] = operation as () =>
					| QuerySimulationLease
					| Promise<QuerySimulationLease>;
			}
			const rawReason = unsupportedReasonsRecord
				? dataField(
						unsupportedReasonsRecord,
						mode,
						`Query simulation unsupported reasons for ${id}`,
					)
				: undefined;
			if (rawReason !== undefined && typeof rawReason !== 'string') {
				throw new Error(
					`Query simulation unsupported reason ${id}.${mode} must be text.`,
				);
			}
			const reason = rawReason
				? boundedText(rawReason, 'Query simulation unsupported reason', 4_096)
				: undefined;
			return operation
				? { mode, supported: true }
				: {
						mode,
						supported: false,
						reason:
							reason ??
							'This query family has no safe host adapter for this state.',
					};
		});
		return Object.freeze({
			id,
			label,
			...(description ? { description } : {}),
			operations: Object.freeze(operations),
			modes: Object.freeze(modes),
		});
	});
}

function publicActive(item: ActiveLease): ActiveQuerySimulation {
	return Object.freeze({
		familyId: item.familyId,
		familyLabel: item.familyLabel,
		mode: item.mode,
		receiptId: item.receiptId,
		startedAt: item.startedAt,
	});
}

export function createQuerySimulationController(
	familiesValue: readonly QuerySimulationFamilyAdapter[],
	options: Readonly<{
		eventStore?: DevtoolsEventStore;
		now?: () => number;
	}> = {},
): QuerySimulationController {
	const families = normalizeFamilies(familiesValue);
	const publicFamilies = Object.freeze(
		families.map(({ id, label, description, modes }) =>
			Object.freeze({
				id,
				label,
				...(description ? { description } : {}),
				modes,
			}),
		),
	);
	const store = new ExternalStore<QuerySimulationSnapshot>({
		families: publicFamilies,
	});
	const now = options.now ?? Date.now;
	let active: ActiveLease | undefined;
	let nextReceipt = 1;
	let mutationQueue = Promise.resolve();

	const publish = (): void => {
		store.set({
			families: publicFamilies,
			...(active
				? {
						active: publicActive(active),
					}
				: {}),
		});
	};
	const appendEvent = (
		kind: 'applied' | 'cleared',
		item: ActiveLease,
	): void => {
		try {
			options.eventStore?.append({
				source: 'query',
				kind: `simulation-${kind}`,
				level: kind === 'applied' ? 'warn' : 'info',
				title: `Query simulation ${kind}`,
				summary: `${item.familyLabel} · ${item.mode}`,
				resourceRef: { toolId: 'query', resourceId: item.receiptId },
				attributes: { family: item.familyId, mode: item.mode },
			});
		} catch {
			// Diagnostics must never make a successfully reversible host operation fail.
		}
	};
	const enqueue = <Result>(
		operation: () => Promise<Result>,
	): Promise<Result> => {
		const result = mutationQueue.then(operation, operation);
		mutationQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};
	const releaseActive = async (expectedReceiptId?: string): Promise<void> => {
		const current = active;
		if (!current) return;
		if (expectedReceiptId && current.receiptId !== expectedReceiptId) {
			throw new Error(
				'The active query simulation changed; refresh and try again.',
			);
		}
		await current.release();
		if (active?.receiptId !== current.receiptId) {
			throw new Error('The active query simulation changed during cleanup.');
		}
		active = undefined;
		publish();
		appendEvent('cleared', current);
	};

	return Object.freeze({
		getSnapshot: store.getSnapshot,
		getServerSnapshot: store.getServerSnapshot,
		subscribe: store.subscribe,
		apply: (familyId, mode) =>
			enqueue(async () => {
				if (!QUERY_SIMULATION_MODES.includes(mode)) {
					throw new Error('Unsupported query simulation mode.');
				}
				const family = families.find((candidate) => candidate.id === familyId);
				if (!family) throw new Error('Query simulation family is unavailable.');
				const operation = family.operations?.[mode];
				if (!operation) {
					const reason = family.modes.find(
						(candidate) => candidate.mode === mode,
					)?.reason;
					throw new Error(reason ?? 'Query simulation mode is unavailable.');
				}
				if (active?.familyId === family.id && active.mode === mode) {
					return publicActive(active);
				}
				await releaseActive();
				const startedAt = now();
				if (!Number.isSafeInteger(startedAt) || startedAt < 0) {
					throw new Error(
						'Query simulation clock returned an invalid timestamp.',
					);
				}
				const lease = await operation();
				const leaseRecord = plainDataRecord(lease, 'Query simulation lease');
				const release = leaseRecord
					? dataField(leaseRecord, 'release', 'Query simulation lease')
					: undefined;
				if (typeof release !== 'function') {
					throw new Error(
						'Query simulation host did not provide reversible cleanup.',
					);
				}
				const nextActive: ActiveLease = {
					familyId: family.id,
					familyLabel: family.label,
					mode,
					receiptId: `query-simulation-${nextReceipt++}`,
					startedAt,
					release: release as QuerySimulationLease['release'],
				};
				active = nextActive;
				publish();
				appendEvent('applied', nextActive);
				return publicActive(nextActive);
			}),
		clear: (receiptId) => enqueue(() => releaseActive(receiptId)),
	});
}

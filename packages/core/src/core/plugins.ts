import type {
	DevToolsPanelPlugin,
	DevToolsPillQuickActionOption,
	DevToolsPlugin,
	DevToolsPluginWithPillQuickAction,
} from '../types';
import { normalizeActionConfirmation } from './action-validation';
import { redactDiagnosticText } from './redact';
import { truncateText } from './serialize';

const RESERVED_PILL_OPTION_IDS = new Set(['__open-panel', '__unpin']);
const MAX_PILL_OPTIONS = 32;
const MAX_PILL_OPTION_TEXT_LENGTH = 256;
const MAX_RAW_PILL_OPTION_LABEL_LENGTH = 64 * 1024;

type PillOptionArrayEntry = { valid: true; value: unknown } | { valid: false };

function readPillOptionArray(value: unknown): {
	entries: readonly PillOptionArrayEntry[];
	length: number;
} | null {
	let lengthDescriptor: PropertyDescriptor | undefined;
	try {
		if (!Array.isArray(value)) return null;
		lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
	} catch {
		return null;
	}
	const length =
		lengthDescriptor && 'value' in lengthDescriptor
			? lengthDescriptor.value
			: undefined;
	if (!Number.isSafeInteger(length) || length < 0) return null;

	const entries: PillOptionArrayEntry[] = [];
	for (let index = 0; index < Math.min(length, MAX_PILL_OPTIONS); index += 1) {
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		} catch {
			return null;
		}
		entries.push(
			descriptor && 'value' in descriptor
				? { valid: true, value: descriptor.value }
				: { valid: false },
		);
	}
	return { entries, length };
}

export type DevToolsPluginSection = {
	title: string;
	plugins: readonly DevToolsPlugin[];
};

export function isPanelPlugin(
	plugin: DevToolsPlugin,
): plugin is DevToolsPanelPlugin {
	return plugin.kind !== 'action';
}

export function hasPillQuickAction(
	plugin: DevToolsPlugin,
): plugin is DevToolsPluginWithPillQuickAction {
	return plugin.pillQuickAction !== undefined;
}

export function groupPlugins(
	plugins: readonly DevToolsPlugin[],
): readonly DevToolsPluginSection[] {
	const sections = new Map<string, DevToolsPlugin[]>();

	for (const plugin of plugins) {
		const section = plugin.section ?? 'Diagnostics';
		const entries = sections.get(section) ?? [];
		entries.push(plugin);
		sections.set(section, entries);
	}

	return [...sections].map(([title, entries]) => ({
		title,
		plugins: entries,
	}));
}

function normalizePillOption(
	value: unknown,
): DevToolsPillQuickActionOption | null {
	if (!value || typeof value !== 'object') return null;
	let descriptors: Record<string, PropertyDescriptor>;
	try {
		descriptors = Object.getOwnPropertyDescriptors(value);
	} catch {
		return null;
	}
	const descriptorValue = (key: string): unknown => {
		const descriptor = descriptors[key];
		return descriptor && 'value' in descriptor ? descriptor.value : undefined;
	};
	const rawId = descriptorValue('id');
	const rawLabel = descriptorValue('label');
	const action = descriptorValue('action');
	if (
		typeof rawId !== 'string' ||
		rawId.trim() !== rawId ||
		rawId.length === 0 ||
		rawId.length > MAX_PILL_OPTION_TEXT_LENGTH ||
		RESERVED_PILL_OPTION_IDS.has(rawId) ||
		typeof rawLabel !== 'string' ||
		rawLabel.trim().length === 0 ||
		rawLabel.length > MAX_RAW_PILL_OPTION_LABEL_LENGTH ||
		typeof action !== 'function'
	) {
		return null;
	}
	const label = truncateText(
		redactDiagnosticText(rawLabel.trim()),
		MAX_PILL_OPTION_TEXT_LENGTH,
	).text;
	const systemImageDescriptor = descriptors.systemImage;
	if (systemImageDescriptor && !('value' in systemImageDescriptor)) return null;
	const systemImage = descriptorValue('systemImage');
	if (
		systemImage !== undefined &&
		(typeof systemImage !== 'string' ||
			!systemImage.trim() ||
			systemImage !== systemImage.trim() ||
			systemImage.length > MAX_PILL_OPTION_TEXT_LENGTH)
	) {
		return null;
	}
	const confirmationDescriptor = descriptors.confirmation;
	if (confirmationDescriptor && !('value' in confirmationDescriptor))
		return null;
	const confirmation = descriptorValue('confirmation');
	let normalizedConfirmation:
		| DevToolsPillQuickActionOption['confirmation']
		| undefined;
	if (confirmation !== undefined) {
		const normalized = normalizeActionConfirmation(confirmation);
		if (!normalized) return null;
		normalizedConfirmation = normalized;
	}
	return {
		id: rawId,
		label,
		action: action as DevToolsPillQuickActionOption['action'],
		...(typeof systemImage === 'string'
			? {
					systemImage:
						systemImage as DevToolsPillQuickActionOption['systemImage'],
				}
			: {}),
		...(normalizedConfirmation ? { confirmation: normalizedConfirmation } : {}),
	};
}

/** Safely resolves and validates a static or dynamic pill-option snapshot. */
export function resolvePillQuickActionOptions(
	declared:
		| readonly DevToolsPillQuickActionOption[]
		| (() => readonly DevToolsPillQuickActionOption[]),
): readonly DevToolsPillQuickActionOption[] {
	let values: unknown;
	try {
		values = typeof declared === 'function' ? declared() : declared;
	} catch {
		return [];
	}
	const snapshot = readPillOptionArray(values);
	if (!snapshot) return [];
	const options: DevToolsPillQuickActionOption[] = [];
	const ids = new Set<string>();
	for (const entry of snapshot.entries) {
		if (!entry.valid) continue;
		const option = normalizePillOption(entry.value);
		if (!option || ids.has(option.id)) continue;
		ids.add(option.id);
		options.push(option);
	}
	return options;
}

export function assertUniquePluginIds(
	plugins: readonly DevToolsPlugin[],
): void {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const plugin of plugins) {
		if (
			typeof plugin.id !== 'string' ||
			!plugin.id ||
			plugin.id !== plugin.id.trim() ||
			plugin.id.length > MAX_PILL_OPTION_TEXT_LENGTH
		) {
			throw new Error(
				'Developer-tools plugin ids must be 1–256 trimmed characters.',
			);
		}
		if (seen.has(plugin.id)) duplicates.add(plugin.id);
		seen.add(plugin.id);

		if (plugin.pillQuickAction) {
			const declaredOptions = plugin.pillQuickAction.options;
			// Dynamic getters are extension code and are validated each time the
			// menu reads them. Do not execute them during host initialization.
			if (typeof declaredOptions === 'function') continue;
			const snapshot = readPillOptionArray(declaredOptions);
			if (!snapshot || snapshot.length === 0) {
				throw new Error(
					`Pill quick actions require at least one option for plugin: ${plugin.id}`,
				);
			}
			if (snapshot.length > MAX_PILL_OPTIONS) {
				throw new Error(
					`Pill quick actions support at most ${MAX_PILL_OPTIONS} options for plugin: ${plugin.id}`,
				);
			}
			const optionIds = new Set<string>();
			for (const entry of snapshot.entries) {
				if (!entry.valid) {
					throw new Error(
						`Invalid pill quick-action option for plugin: ${plugin.id}`,
					);
				}
				const option = entry.value;
				let rawId: unknown;
				try {
					const descriptor = Object.getOwnPropertyDescriptor(option, 'id');
					rawId =
						descriptor && 'value' in descriptor ? descriptor.value : undefined;
				} catch {
					rawId = undefined;
				}
				if (typeof rawId === 'string' && RESERVED_PILL_OPTION_IDS.has(rawId)) {
					throw new Error(
						`Reserved pill quick-action option id for plugin ${plugin.id}: ${rawId}`,
					);
				}
				const normalized = normalizePillOption(option);
				if (!normalized) {
					throw new Error(
						`Invalid pill quick-action option for plugin: ${plugin.id}`,
					);
				}
				if (optionIds.has(normalized.id)) {
					throw new Error(
						`Duplicate pill quick-action option id for plugin ${plugin.id}: ${normalized.id}`,
					);
				}
				optionIds.add(normalized.id);
			}
		}
	}
	if (duplicates.size > 0) {
		throw new Error(
			`Duplicate developer-tools plugin id${duplicates.size === 1 ? '' : 's'}: ${[
				...duplicates,
			].join(', ')}`,
		);
	}
}

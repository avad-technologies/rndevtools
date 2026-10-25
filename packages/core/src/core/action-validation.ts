import type {
	DevToolsActionConfirmation,
	DevToolsActionRequest,
} from '../types';
import { redactDiagnosticText } from './redact';
import { truncateText } from './serialize';

const MAX_ACTION_TEXT_LENGTH = 256;
const MAX_CONFIRMATION_MESSAGE_LENGTH = MAX_ACTION_TEXT_LENGTH * 4;
const MAX_RAW_ACTION_TEXT_LENGTH = 64 * 1024;

function dataProperty(
	descriptors: Record<string, PropertyDescriptor>,
	key: string,
): unknown {
	const descriptor = descriptors[key];
	return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function descriptorsFor(
	value: object,
): Record<string, PropertyDescriptor> | null {
	try {
		return Object.getOwnPropertyDescriptors(value);
	} catch {
		return null;
	}
}

function hasAccessor(
	descriptors: Record<string, PropertyDescriptor>,
	key: string,
): boolean {
	const descriptor = descriptors[key];
	return descriptor !== undefined && !('value' in descriptor);
}

/** Validates and detaches confirmation data without invoking accessors. */
export function normalizeActionConfirmation(
	value: unknown,
): DevToolsActionConfirmation | null {
	if (!value || typeof value !== 'object') return null;
	const descriptors = descriptorsFor(value);
	if (!descriptors) return null;
	for (const key of ['title', 'message', 'confirmLabel', 'destructive']) {
		if (hasAccessor(descriptors, key)) return null;
	}

	const title = dataProperty(descriptors, 'title');
	const message = dataProperty(descriptors, 'message');
	const confirmLabel = dataProperty(descriptors, 'confirmLabel');
	const destructive = dataProperty(descriptors, 'destructive');
	if (
		typeof title !== 'string' ||
		!title.trim() ||
		title.length > MAX_RAW_ACTION_TEXT_LENGTH ||
		(message !== undefined &&
			(typeof message !== 'string' ||
				message.length > MAX_RAW_ACTION_TEXT_LENGTH)) ||
		(confirmLabel !== undefined &&
			(typeof confirmLabel !== 'string' ||
				!confirmLabel.trim() ||
				confirmLabel.length > MAX_RAW_ACTION_TEXT_LENGTH)) ||
		(destructive !== undefined && typeof destructive !== 'boolean')
	) {
		return null;
	}

	return {
		title: truncateText(
			redactDiagnosticText(title.trim()),
			MAX_ACTION_TEXT_LENGTH,
		).text,
		...(typeof message === 'string'
			? {
					message: truncateText(
						redactDiagnosticText(message),
						MAX_CONFIRMATION_MESSAGE_LENGTH,
					).text,
				}
			: {}),
		...(typeof confirmLabel === 'string'
			? {
					confirmLabel: truncateText(
						redactDiagnosticText(confirmLabel.trim()),
						MAX_ACTION_TEXT_LENGTH,
					).text,
				}
			: {}),
		...(typeof destructive === 'boolean' ? { destructive } : {}),
	};
}

/** Validates and detaches an extension-owned action request. */
export function normalizeActionRequest(
	value: unknown,
): DevToolsActionRequest | null {
	if (!value || typeof value !== 'object') return null;
	const descriptors = descriptorsFor(value);
	if (!descriptors) return null;
	for (const key of ['pluginId', 'label', 'confirmation', 'action']) {
		if (hasAccessor(descriptors, key)) return null;
	}

	const pluginId = dataProperty(descriptors, 'pluginId');
	const label = dataProperty(descriptors, 'label');
	const action = dataProperty(descriptors, 'action');
	const rawConfirmation = dataProperty(descriptors, 'confirmation');
	if (
		typeof pluginId !== 'string' ||
		!pluginId ||
		pluginId !== pluginId.trim() ||
		pluginId.length > MAX_ACTION_TEXT_LENGTH ||
		typeof label !== 'string' ||
		!label.trim() ||
		label.length > MAX_RAW_ACTION_TEXT_LENGTH ||
		typeof action !== 'function'
	) {
		return null;
	}

	let confirmation: DevToolsActionConfirmation | undefined;
	if (rawConfirmation !== undefined) {
		const normalized = normalizeActionConfirmation(rawConfirmation);
		if (!normalized) return null;
		confirmation = normalized;
	}

	return {
		pluginId,
		label: truncateText(
			redactDiagnosticText(label.trim()),
			MAX_ACTION_TEXT_LENGTH,
		).text,
		action: action as DevToolsActionRequest['action'],
		...(confirmation ? { confirmation } : {}),
	};
}

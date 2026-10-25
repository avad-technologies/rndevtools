import {
	type SerializedValue,
	truncateUtf8,
	utf8ByteLength,
} from './bounded-redaction';
import { diagnosticErrorText, sanitizeDiagnosticValue } from './redact';

export type { SerializedValue };
export { utf8ByteLength };

export function serializeValue(
	value: unknown,
	maxBytes = 64 * 1024,
): SerializedValue {
	let text: string;
	try {
		text = JSON.stringify(sanitizeDiagnosticValue(value), null, 2);
	} catch (error) {
		text = diagnosticErrorText(error);
	}

	return truncateUtf8(text, maxBytes);
}

export function truncateText(
	text: string,
	maxBytes = 64 * 1024,
): SerializedValue {
	return truncateUtf8(text, maxBytes);
}

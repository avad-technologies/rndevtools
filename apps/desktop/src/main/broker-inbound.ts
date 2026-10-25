import { diagnosticErrorText } from '@rndevtools/core/redact';
import { truncateText } from '@rndevtools/core/serialize';
import type { RawData } from 'ws';
import { ZodError } from 'zod';
import { type DeviceMessage, deviceMessageSchema } from '../shared/protocol';

const MAX_BOUNDARY_ERROR_BYTES = 8 * 1024;
const MAX_ISSUE_PATH_SEGMENTS = 8;
const MAX_ISSUE_PATH_SEGMENT_LENGTH = 64;

/** Convert every ws raw-frame representation into the same validated message. */
export function parseBrokerDeviceMessage(raw: RawData): DeviceMessage {
	const text = Array.isArray(raw)
		? Buffer.concat(raw).toString('utf8')
		: raw instanceof ArrayBuffer
			? Buffer.from(raw).toString('utf8')
			: raw.toString('utf8');
	return deviceMessageSchema.parse(JSON.parse(text));
}

/** Charge fragmented frames by their complete wire size before parsing. */
export function brokerRawDataByteLength(raw: RawData): number {
	return Array.isArray(raw)
		? raw.reduce((total, chunk) => total + chunk.byteLength, 0)
		: raw.byteLength;
}

/**
 * Where a rejected device message failed, from its first schema issue. A
 * ZodError keeps its message behind a getter, which diagnosticErrorText
 * reads as just 'ZodError'.
 */
function schemaIssueText(error: ZodError): string {
	const [first] = error.issues;
	if (!first) return 'The device message does not match the protocol.';
	const path = first.path
		.slice(0, MAX_ISSUE_PATH_SEGMENTS)
		.map((segment) => String(segment).slice(0, MAX_ISSUE_PATH_SEGMENT_LENGTH))
		.join('.');
	const more =
		error.issues.length > 1 ? ` (and ${error.issues.length - 1} more)` : '';
	return `The device message does not match the protocol at ${path || 'its root'}: ${first.message}${more}`;
}

/** Bound and redact errors before they cross the broker observability boundary. */
export function safeBrokerErrorText(error: unknown): string {
	const text =
		error instanceof ZodError
			? diagnosticErrorText(schemaIssueText(error))
			: diagnosticErrorText(error);
	return truncateText(text, MAX_BOUNDARY_ERROR_BYTES).text;
}

import { diagnosticErrorText } from '@rndevtools/core/redact';

/** An operation as a panel builds it; the runtime adds the actionId and token. */
export type WithoutActionId<T> = T extends { actionId: string }
	? Omit<T, 'actionId' | 'confirmationToken'>
	: never;

/** A fresh action id under a runtime's prefix, such as `simulator-…`. */
export function nextActionId(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

/** A thrown value as text a runtime may show: redacted, at most 8 KiB. */
export function errorText(error: unknown): string {
	return diagnosticErrorText(error).slice(0, 8 * 1024);
}

/** The notice a submitted job's status shows: ended jobs succeed or fail. */
export function jobNoticeKind(status: string): 'pending' | 'success' | 'error' {
	if (status === 'complete' || status === 'cancelled') return 'success';
	return status === 'failed' || status === 'needs-attention'
		? 'error'
		: 'pending';
}

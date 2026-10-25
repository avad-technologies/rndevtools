import { Share } from 'react-native';

/** Invokes the native share sheet without letting bridge failures crash a panel. */
export function shareDiagnosticContent(
	content: Parameters<typeof Share.share>[0],
): void {
	try {
		void Promise.resolve(Share.share(content)).catch(() => undefined);
	} catch {
		// Sharing is best-effort on unsupported or partially torn-down runtimes.
	}
}

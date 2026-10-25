import type { QueryClient } from '@tanstack/react-query';

/**
 * Production stub for `@/devtools/host`.
 *
 * Metro resolves the real host to this file in release builds. It imports
 * nothing from `@rndevtools/*`, so none of it can enter the bundle. The
 * exported shape must stay identical to the real module: a mismatch breaks at
 * runtime in production, which is the worst place to find it.
 */
export function DevtoolsHost(_props: { queryClient: QueryClient }) {
	return null;
}

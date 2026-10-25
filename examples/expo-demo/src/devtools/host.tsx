import { InternalTools } from '@rndevtools/core';
import { setDevtoolsAuthorization } from '@rndevtools/react-native';
import type { QueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { connectToDesktop } from './desktop';
import { createDemoDevtools } from './plugins';

/**
 * The app's single devtools import.
 *
 * Everything diagnostic is reachable only through this module, which is what
 * makes production pruning work: Metro swaps this one file for
 * `src/lib/devtools-host-disabled.tsx`, and the panel runtime, plugins, and
 * desktop client all fall out of the bundle with it. An app that imports
 * `@rndevtools/*` from anywhere else reconnects the graph and defeats that.
 */
export function DevtoolsHost({ queryClient }: { queryClient: QueryClient }) {
	const { plugins, instrumentedFetch } = useMemo(
		() => createDemoDevtools(queryClient),
		[queryClient],
	);

	useEffect(() => {
		// Privileged actions stay refused until the host grants authorization.
		// A real app gates this on staff status and binds it to its auth source.
		setDevtoolsAuthorization({ enabled: __DEV__, ownerId: 'demo-user' });

		// One instrumented request so the network panel has something to show.
		void instrumentedFetch('https://api.example.com/health').catch(() => {
			// A failed demo request is still a captured request.
		});

		const desktop = connectToDesktop();
		return () => desktop?.stop();
	}, [instrumentedFetch]);

	// `enabled` is the single switch. Collectors follow it, not panel
	// visibility, so traffic is captured before the panel is opened.
	return <InternalTools enabled={__DEV__} plugins={plugins} />;
}

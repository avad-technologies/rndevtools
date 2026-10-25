import type { DevToolsPanelPlugin } from '@rndevtools/core';
import {
	createEnvironmentPlugin,
	createNavigationPlugin,
	createNetworkPlugin,
	createQueryPlugin,
} from '@rndevtools/core/plugins';
import type { QueryClient } from '@tanstack/react-query';
import { Linking } from 'react-native';

/**
 * Everything host-specific about this app's diagnostics lives here: which
 * plugins are on, what the app's URL scheme is, and which environment values
 * are safe to show. The packages themselves know none of it.
 *
 * Factories are not uniform: some return the panel plugin directly, others
 * return a controller with the plugin plus an imperative API.
 */
export function createDemoDevtools(queryClient: QueryClient): {
	plugins: readonly DevToolsPanelPlugin[];
	instrumentedFetch: typeof fetch;
} {
	const network = createNetworkPlugin({
		captureBody: true,
		// This app emits its own request id header, so it is listed ahead of the
		// standard ones. Omitting this option falls back to x-request-id and
		// traceparent, which is the right default for most apps.
		correlationIdHeaders: ['x-demo-request-id', 'x-request-id', 'traceparent'],
	});

	const navigation = createNavigationPlugin({
		// Makes the deep link field read `rndevtoolsdemo://…` rather than a
		// generic placeholder.
		deepLinkScheme: 'rndevtoolsdemo',
		onOpenDeepLink: (url) => Linking.openURL(url),
	});

	const plugins: DevToolsPanelPlugin[] = [
		network.plugin,
		navigation.plugin,
		createQueryPlugin({ queryClient, captureData: true }),
		createEnvironmentPlugin({
			values: {
				API_URL: process.env.EXPO_PUBLIC_API_URL ?? 'https://api.example.com',
				RELEASE_CHANNEL: process.env.EXPO_PUBLIC_RELEASE_CHANNEL ?? 'local',
			},
		}),
	];

	// Only requests made through this wrapper are captured. Global fetch is left
	// alone unless a host explicitly opts in with `patchGlobalFetch`.
	const instrumentedFetch = network.instrumentFetch(fetch);

	return { plugins, instrumentedFetch };
}

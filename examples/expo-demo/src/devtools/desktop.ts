import {
	createEmptyDesktopToolsSnapshot,
	type DesktopDeviceInfoSnapshot,
	type DesktopDeviceToolsSnapshot,
} from '@rndevtools/core/desktop-protocol';
// The narrow entry points keep this headless module off the root barrel, which
// also loads the camera provider and the image overlay.
import { getDevtoolsAuthorization } from '@rndevtools/react-native/authorization';
import {
	type DesktopClientHandle,
	shouldStartDesktopClient,
	simulatorUdidFromPath,
	startDesktopClient,
} from '@rndevtools/react-native/desktop';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { Paths } from 'expo-file-system';
import { Platform } from 'react-native';

/**
 * The desktop client is deliberately ignorant of this app. It handles
 * discovery, framing, replay protection, and admission control; the host
 * adapter below decides what a snapshot contains and what an action may do.
 */
function createDeviceInfo(): DesktopDeviceInfoSnapshot {
	return {
		id: `demo-${Constants.sessionId}`,
		name: Device.deviceName ?? 'Simulator',
		platform:
			Platform.OS === 'ios' || Platform.OS === 'android'
				? Platform.OS
				: 'unknown',
		model: Device.modelName ?? undefined,
		osVersion: Device.osVersion ?? undefined,
		appVersion: Constants.expoConfig?.version ?? '0.0.0',
		bundleIdentifier: Constants.expoConfig?.ios?.bundleIdentifier ?? undefined,
		// Reporting the Simulator UDID lets the desktop link this session to the
		// Simulator row and the lane that launched it, and lets an agent address
		// both with one `--udid`. It is derived from the app's own container
		// path, so it is undefined on a physical device.
		simulatorUdid: simulatorUdidFromPath(Paths.document.uri),
		// Declaring no capabilities is what makes every privileged desktop
		// control inert for this demo. A host opts in one capability at a time.
		capabilities: [],
	};
}

function captureTools(): DesktopDeviceToolsSnapshot {
	// A real host spreads this and overrides the tools it actually collects:
	// { ...createEmptyDesktopToolsSnapshot(), network: myNetworkProjection }.
	// The desktop validates the whole shape, so every collection must be present.
	return createEmptyDesktopToolsSnapshot();
}

export function connectToDesktop(): DesktopClientHandle | undefined {
	// Never true for a build that reaches a tester: the broker socket is
	// unauthenticated loopback and belongs only on a developer's own machine.
	if (!shouldStartDesktopClient({ isDevelopmentBuild: __DEV__ }))
		return undefined;

	return startDesktopClient({
		host: {
			captureTools,
			createDeviceInfo,
			runAction: async (action) => {
				// Reject anything this app has not explicitly implemented. Throwing
				// is how a host refuses a desktop-issued action.
				throw new Error(`Unsupported action: ${action.tool}.${action.command}`);
			},
			getAuthorization: getDevtoolsAuthorization,
		},
	});
}

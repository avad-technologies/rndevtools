/**
 * React Native host runtime for RN Devtools.
 *
 * `@rndevtools/core` owns the on-device panels and diagnostic plugins. This
 * package owns the glue an app needs to drive them: the desktop broker client,
 * the authorization mirror that gates privileged actions, and adapters for
 * storage, camera fixtures, and image overlays.
 */

export {
	type AsyncStorageLike,
	createAsyncStorageDevtoolsAdapter,
	createSecureStoreDevtoolsAdapter,
	type DevtoolsStorageAdapterOptions,
	type SecureStoreLike,
	type SecureStoreManifestEntry,
} from './adapters/storage';
export {
	bindDevtoolsAuthorizationOwnerSource,
	type DevtoolsAuthorization,
	disableDevtoolsAuthorization,
	getDevtoolsAuthorization,
	setDevtoolsAuthorization,
	subscribeToDevtoolsAuthorization,
} from './authorization';

export type {
	DebugCameraFixture,
	DevtoolsCameraPicker,
	DevtoolsCameraProvider,
} from './camera/contract';
export { devtoolsCameraProvider } from './camera/provider';

export {
	DesktopActionAdmissionController,
	DesktopActionReplayCache,
	type DesktopClientHandle,
	type DesktopClientHost,
	type DesktopClientOptions,
	type DesktopDiagnostic,
	desktopBrokerCandidates,
	shouldStartDesktopClient,
	startDesktopClient,
} from './desktop/client';

export {
	desktopProjectionId,
	limitDesktopProjection,
	projectDesktopHeaders,
	projectDesktopQueryKey,
} from './desktop/projection';
export { simulatorUdidFromPath } from './desktop/simulator-identity';

export {
	type ComponentVisualState,
	componentVisuals,
} from './diagnostics/component-visuals';

export {
	clearImageOverlay,
	configureImageOverlay,
	type ImageOverlayOptions,
	imageOverlay,
	RNDEVTOOLS_IMAGE_OVERLAY_LIMITS,
	setLocalImageOverlaySource,
	setRemoteImageOverlaySource,
} from './diagnostics/image-overlay';

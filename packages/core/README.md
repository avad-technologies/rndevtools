# @rndevtools/core

Extensible on-device diagnostics for Expo and React Native. The UI is
iOS-first, with native SwiftUI chrome on iOS and matching React Native panels
on Android.

The package is a greenfield implementation. It does not contain code or visual
assets from React Buoy or the current `@buoy-gg/*` packages.

## Usage

```tsx
import { InternalTools } from '@rndevtools/core';
import {
	createEnvironmentPlugin,
	createNetworkPlugin,
	createQueryPlugin,
} from '@rndevtools/core/plugins';

const network = createNetworkPlugin({
	captureBody: true,
	// Use only in trusted internal builds; unknown-size bodies must be read
	// before their size can be known.
	captureUnknownLengthBodies: true,
});

const plugins = [
	network.plugin,
	createQueryPlugin({ queryClient, captureData: true }),
	createEnvironmentPlugin({
		values: {
			API_URL: process.env.EXPO_PUBLIC_API_URL,
			RELEASE_CHANNEL: process.env.EXPO_PUBLIC_RELEASE_CHANNEL,
		},
	}),
];

// This opt-in is appropriate only because the host owns and has vetted this
// exact fetch implementation and its Request/Response objects.
export const instrumentedFetch = network.instrumentFetch(fetch, {
	trustedRequest: true,
	trustedResponse: true,
});

<InternalTools enabled={isInternalBuild} plugins={plugins} />;
```

The root entry point exposes the runtime, shared panel UI, event stores, and
public types. Reusable built-in diagnostics and plugin factories are also
available from the dedicated `@rndevtools/core/plugins` entry point. Keeping the
entry points separate prevents hosts that only need the shell from traversing
optional diagnostic dependencies.

Image diagnostics and the storage editor use the separate
`@rndevtools/core/plugins/images` and `@rndevtools/core/plugins/storage` entry points.
They are excluded from the shared plugins barrel so a host that does not use them
never loads them, even without tree shaking. Like every entry point in this
package, none of them may reach a release bundle; see
[Keeping devtools out of production builds](#keeping-devtools-out-of-production-builds).

The reference-image overlay controller and its source validators are also
published alone at `@rndevtools/core/plugins/image-overlay`. The shared plugins
barrel still exports them; the subpath lets a module that only drives the
overlay load it without the barrel's panels and the dependencies they reach.
Like the other entry points, it must never reach a release bundle.

Collectors install when `InternalTools` is enabled and remain active while its
panel is closed. The runtime reconciles collectors by plugin ID and installer,
so adding an application action does not restart unrelated collectors. Network
collection wraps explicit fetch implementations by default. Broad global fetch
capture is opt-in with `patchGlobalFetch: true`. Multiple collectors compose as
layers, and disposal safely rebuilds or restores the global wrapper in either
order.

Captured events are bounded by count and estimated UTF-8 byte size. Known-large
and binary response bodies are omitted, and unknown-length bodies are omitted
unless `captureUnknownLengthBodies` is explicitly enabled and a bounded stream
reader is available. Header, URL, and body redaction runs before an event enters
the store. Caller-supplied or custom fetch implementations remain untrusted and
body-uninspectable unless the host explicitly vets that exact boundary; retained
bodies are capped at 64 KB so admission matches the built-in redaction bound.

Network condition profiles are an explicit, capability-gated opt-in. Offline,
Edge, 3G, LTE, Wi-Fi, DSL, and Very Bad Network apply deterministic latency,
jitter, timeout/failure, request-loss, and known-size transfer delays only to
fetch implementations returned by `instrumentFetch` (or the separately opted-in
global fetch layer). They do not intercept native SDK sockets, WebSockets, or
traffic from other applications. Upload shaping is available only when the
request body size is synchronously knowable; download shaping requires a valid
`Content-Length`. Disabling the collector always resets the active profile.

Profile mutations return versioned action-policy receipts, and hosts can supply
a dynamic capability from the runtime registry. Active conditions bind to the
exact capability identity and are cleared when revocation or replacement is
observed (hosts should subscribe for immediate lifecycle observation), or on
tools disposal. Request replay is disabled by default and is available only
through the collector-owned global fetch layer; when a trusted host opts in,
requests with omitted or redacted inputs stay blocked and every replay still
runs through the confirmed action path. Completed request summaries can also
be published to a shared `DevtoolsEventStore`; the envelope carries bounded
correlation fields and a resource reference while headers and bodies remain in
the network collector. Timing reports only phases visible at the fetch boundary,
and cURL export applies built-in redaction and a 64 KB output limit again even
when a host constructs an event directly.

The root entry point also exposes `DevtoolsEventStore` for a shared,
host-agnostic timeline. Its versioned envelopes contain bounded summaries,
scalar attributes, correlation IDs, and optional collector-owned resource
references; detail payloads remain in their owning collectors. The store
redacts and detaches every event before insertion, evicts oldest entries by
count and estimated bytes, reports drop/truncation counters, supports external
store subscriptions, and produces bounded complete-row JSON, NDJSON, Markdown,
bug-report, errors-only, or Mermaid sequence exports. Explicit correlation
scopes retain causal IDs; time-window correlation is permanently labelled as
inferred with its evidence event.
Existing plugin-specific `BoundedEventStore` instances remain supported while
collectors migrate independently.

Runtime tools can publish versioned read and mutation capabilities through the
bounded `createDevToolsCapabilityRegistry` contract. Panels and remote hosts
can render disabled, degraded, and unsupported states explicitly instead of
inferring support from missing snapshot fields. Mutation decisions adapt to
the shared action policy before host code runs.

The reusable diagnostics include Network, TanStack Query, registered storage
adapters, a deliberate environment manifest, public navigation adapters, a
logger-backed Console, explicit Zustand projections, bounded restore points,
JavaScript responsiveness reviews, and explicit component targets. None of
them imports application code.

## Advanced diagnostics safety model

The advanced plugins use host-owned adapters instead of global interception:

- Zustand requires `getInspectableState`; there is no automatic store
  discovery and the built-in panel is read-only.
- Storage never reads a sensitive adapter's values, and redacts a value stored
  under a key whose name marks it sensitive, such as `refreshToken` or
  `session`. An adapter opts out of both with `revealValues: true`.
- Restore points accept only declared sources. Snapshots must be JSON, are
  bounded by source and session size, remain in memory, and capture rollback
  state before applying a restore.
- Console subscribes to an application's structured logger, groups repeated
  entries, and preserves supplied scope, correlation, bounded stack, source,
  and bookmark metadata after redaction. It redacts a bounded window of each
  text, at most 1.9 Mi code units for a message or stack however long it is,
  and redacts attribute keys as it redacts values. The attributes of one
  event share a work budget of 2 Mi code units, which every value read, key
  listed or copied, and code unit tested or redacted counts against, so
  attributes that share one object widely stop at the budget; listing the
  keys of one huge object still costs time in proportion to its size. A
  secret of up to 64 Ki code units that a window edge cuts is never stored
  unredacted; part of a longer one can be. An optional development-only
  `createConsoleMethodSource` exists for third-party output; it requires two
  explicit opt-ins and restores only wrappers it still owns. It is never used
  by default.
- Performance Review samples React Native runtime / JavaScript responsiveness
  only. It does not claim native UI-thread FPS, CPU, memory, or profiler data.
- Component Inspector lists only deliberate target metadata supplied by the
  host; it does not traverse React fibers or native view hierarchies.

Collectors still follow the runtime `enabled` lifecycle. Console and Zustand
subscriptions detach when internal tools are disabled, performance sampling
stops, and component sources unsubscribe.

## Custom tools

Applications can contribute full React Native panels without changing this
package:

```tsx
import { createCustomPlugin } from '@rndevtools/core/plugins';

const fixturesPlugin = createCustomPlugin({
	id: 'fixtures',
	title: 'Fixtures',
	description: 'Load deterministic application states',
	systemImage: 'shippingbox.fill',
	section: 'My App',
	render: (controls) => (
		<FixturesPanel
			onBack={controls.onBack}
			onClose={controls.onClose}
		/>
	),
});
```

One-tap application actions use the same registry:

```tsx
import { createActionPlugin } from '@rndevtools/core/plugins';

const clearOnboardingPlugin = createActionPlugin({
	id: 'clear-onboarding',
	title: 'Clear Onboarding',
	description: 'Return this account to the first-run state',
	systemImage: 'arrow.counterclockwise',
	section: 'My App',
	confirmation: {
		title: 'Clear onboarding?',
		confirmLabel: 'Clear',
		destructive: true,
	},
	action: ({ close }) => {
		close();
		clearOnboarding();
	},
});
```

Large application panels can stay out of the initial module graph:

```tsx
const livePreviewPlugin = createLazyCustomPlugin({
	id: 'live-preview',
	title: 'Live Preview',
	description: 'Preview application-specific native states',
	systemImage: 'timer',
	section: 'My App',
	load: () => import('./live-preview-panel').then((module) => module.Panel),
});
```

`PanelShell`, navigation controls, Android panel primitives, icons, and shared
colors are exported for custom tools that should visually match built-in
diagnostics. Custom panels also receive the current presentation mode, can
switch modes themselves, and receive `actions.run(...)` for consistent
confirmation, error routing, and audit events.

Hosts that expose actions outside the on-device plugin UI can use the versioned
`createDevToolsActionCoordinator` contract. The host supplies each canonical
plan's capability availability and risk classification; the coordinator rejects
unsupported actions before invocation, enforces confirmation, deduplicates
request IDs against an opaque host-generated action fingerprint, attempts
declared rollback, and emits redacted value-free receipts. The existing
`actions.run(...)` API is a compatibility facade over the same coordinator.

Plugins with a small set of immediate choices can also opt into the minimized
Pill. The runtime exposes pin controls from the tool browser, persists the
selection, and owns the native quick-action menu:

```tsx
const fixturesPlugin = createCustomPlugin({
	id: 'fixtures',
	title: 'Fixtures',
	description: 'Switch application fixture data',
	systemImage: 'shippingbox.fill',
	section: 'My App',
	pillQuickAction: {
		getSelectedOptionId: () => fixtureStore.getState().mode,
		subscribe: fixtureStore.subscribe,
		options: [
			{
				id: 'live',
				label: 'Live data',
				action: () => fixtureStore.getState().setMode('live'),
			},
			{
				id: 'mock',
				label: 'Mock data',
				action: () => fixtureStore.getState().setMode('mock'),
			},
		],
	},
	render: (controls) => <FixturesPanel onBack={controls.onBack} />,
});
```

Pill choices run through the same action service as full panels, including
confirmation, audit events, and centralized errors. `subscribe` and
`getSelectedOptionId` are optional for stateless menus; provide both when the
native menu should mark the current choice.

## Presentation modes

The runtime supports three interchangeable presentations:

- `sheet`: native Expo UI / SwiftUI bottom sheet and tool browser.
- `window`: draggable floating window that leaves the application interactive.
- `pill`: draggable minimized status pill that restores the previous expanded
  presentation and hosts pinned plugin quick-action menus.

```tsx
<InternalTools
	enabled={isInternalBuild}
	visible={showLauncherAndPanels}
	plugins={plugins}
	defaultPresentationMode="sheet"
	pillLabel="My App Tools"
	bottomObstructionInset={tabBarHeight}
	onAuditEvent={(event) => audit(event)}
/>
```

`enabled` owns collector lifecycle; `visible` only hides or shows the interface.
This allows collectors to remain active while a feedback flow, screenshot, or
other temporary overlay suppresses the launcher.

Use the optional controlled `presentationMode` and
`onPresentationModeChange` props when the host application should own this
state. Switching presentation never reinstalls collectors or clears the active
plugin.

Launcher, window, pill position, pinned quick actions, and presentation state
can be persisted through any small key/value storage implementation:

```tsx
<InternalTools
	enabled={isInternalBuild}
	plugins={plugins}
	persistence={{ storage: myStringStorage }}
/>
```

The host can also keep a ref and call `open()`, `close()`,
`openPlugin(pluginId)`, or `setPresentationMode(mode)`. This lets application
screens expose contextual shortcuts without coupling those screens to panel
implementations.

Host applications must provide `GestureHandlerRootView` and
`SafeAreaProvider` above `InternalTools`.

## Compatibility

| Host | Supported |
| --- | --- |
| Expo SDK | 56 and 57 |
| React Native | 0.85 and 0.86 |
| `react-native-worklets` | 0.8 through 0.x |
| `@expo/ui` | 56 and 57 |

The lower bounds were verified against an Expo 56.0.19 / React Native
0.85.3 host: every named import this package takes from `@expo/ui`,
`@expo/ui/swift-ui`, `@expo/ui/swift-ui/modifiers`, `@expo/ui/community/menu`,
`react-native-worklets`, `expo-device`, `expo-file-system`, `expo-constants`,
and `expo-image-picker` exists in the SDK 56 releases of those packages, and
the full diagnostic suite runs on-device against that host.

## Package boundary

Keep generic runtime and diagnostic behavior in `@rndevtools/core`. Host-app
adapters, feature flags, account actions, fixture scenarios, and product-specific
panels belong in the consuming application. This keeps the package reusable
without introducing application dependencies into its graph.

The API is still settling, so treat minor versions as potentially breaking
until 1.0. Individual diagnostics stay in this package until a tool needs
native code, materially changes bundle size, or requires independent
release/versioning.

## Keeping devtools out of production builds

This package is only safe to depend on because it never reaches a release
bundle. Tree shaking is not a strong enough guarantee: one retained import
pulls in the panels and every adapter they reach.

`@rndevtools/react-native` ships the mechanism for this. Its
`withDevtoolsPruning` Metro resolver swaps the devtools modules for typed
no-op shims at resolution time, so the module graph is cut rather than
trimmed. It does so for every release bundle by default, and fails the build
when an import would still reach this package. `rndevtools-verify-bundle`
asserts over an exported bundle that no devtools markers survived. Wire both
up before shipping, and keep the shim list current when you add a plugin.

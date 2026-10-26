# @rndevtools/react-native

The React Native host runtime for [RN Devtools](https://github.com/avad-technologies/rndevtools).

`@rndevtools/core` owns the on-device panels and diagnostic plugins. This
package owns the glue an app needs to drive them: the desktop broker client,
the authorization mirror that gates privileged actions, adapters for storage
and camera fixtures, and the Metro mechanism that keeps all of it out of
release builds.

## Install

```sh
pnpm add -D @rndevtools/core @rndevtools/react-native
```

Both packages ship TypeScript source so your Babel pipeline compiles them —
Reanimated worklets in the panel UI have to be workletized by your app, not by
a prebuilt bundle. Metro handles this with no configuration. For Jest, add them
to `transformIgnorePatterns`:

```js
transformIgnorePatterns: [
  'node_modules/(?!((jest-)?react-native|@rndevtools/.*|expo(nent)?|@expo(nent)?/.*)/)',
],
```

## Connecting to the desktop app

The client discovers a loopback broker, publishes bounded snapshots, and
applies actions the desktop sends back. It knows nothing about your app: you
supply a host adapter, which is what makes it reusable.

```ts
import {
  getDevtoolsAuthorization,
  shouldStartDesktopClient,
  startDesktopClient,
} from '@rndevtools/react-native';

if (shouldStartDesktopClient({ isDevelopmentBuild: __DEV__ })) {
  startDesktopClient({
    host: {
      // Project your registered diagnostics into a snapshot payload.
      captureTools: (diagnostics) => buildToolsSnapshot(diagnostics),
      // Identify this device and build, and list the actions it accepts.
      createDeviceInfo: () => buildDeviceInfo(),
      // Apply one desktop-issued action. Throw to reject it. `signal` aborts
      // when the client stops waiting for the action.
      runAction: async (action, { signal }) => applyAction(action, signal),
      // The client refuses actions while this reports disabled.
      getAuthorization: getDevtoolsAuthorization,
    },
  });
}
```

`shouldStartDesktopClient` stays false under Jest and honours the
`EXPO_PUBLIC_DESKTOP_DEVTOOLS_DISABLED` kill switch. Pass
`isDevelopmentBuild: false` for anything that reaches a tester's device:
the broker socket is unauthenticated and belongs only on a machine the
developer controls.

Any local process can answer on the broker's port, so the client enforces
the broker's contract itself:

- It runs an action only when the action's `deviceId` is the `id` that
  `createDeviceInfo()` returned and its capability is in that info's
  `capabilities`. Any other action is refused and the connection is closed.
- Each action has `actionTimeoutMs` to settle, 45 seconds unless you pass
  `startDesktopClient` another positive number of milliseconds that a timer
  can hold; any other value throws. When an action runs out of time, the
  desktop is told it timed out and that its outcome is unknown, the action's
  `signal` aborts, and the next queued action runs. A host that holds an
  on-device prompt for an action, such as a confirmation sheet, should
  dismiss it and reject when the signal aborts.
- Outgoing frames are paced under the broker's per-connection rate limit.
  Action results go first, and snapshots coalesce, so the next one sent
  carries the latest state.
- A snapshot collection with more rows than its limit in
  `RNDEVTOOLS_SNAPSHOT_LIMITS` (from `@rndevtools/core/desktop-protocol`) is
  trimmed to its newest rows, and the client records a warning in its
  diagnostics. The broker rejects a whole snapshot that is over any limit.

The root barrel imported above also loads the camera provider and the image
overlay, and with them the optional `expo-file-system` peer. A headless host
module, such as the one that starts this client, can import from
`@rndevtools/react-native/desktop`, `/authorization` and `/adapters/storage`
instead, which load neither the optional peers nor core's plugins barrel.
`/desktop` also exports `simulatorUdidFromPath`, which reads a Simulator's
UDID from a container path for `createDeviceInfo().simulatorUdid`, and the
projection helpers for building snapshots: `desktopProjectionId`,
`projectDesktopHeaders`, `projectDesktopQueryKey` and
`limitDesktopProjection`.

## Authorization

Privileged actions are gated by a single mirror the app owns. Bind it to your
auth source so a user change revokes synchronously:

```ts
import {
  bindDevtoolsAuthorizationOwnerSource,
  setDevtoolsAuthorization,
} from '@rndevtools/react-native';

bindDevtoolsAuthorizationOwnerSource({
  getOwnerId: () => session.userId,
  subscribe: (listener) => session.subscribe(listener),
});

setDevtoolsAuthorization({ enabled: isStaff, ownerId: session.userId });
```

While a source is bound, a grant applies only when its `ownerId` is the
source's live owner. A grant your app computed for a user who has since
signed out is ignored, rather than enabling tools for whoever signed in next.
A failed owner read revokes. So does a source whose `subscribe` throws, and
grants are then refused until a working source is bound, because nothing
could revoke them when its owner changed. Granting again after any
revocation is your app's explicit call. `setDevtoolsAuthorization` called
without an authorization object revokes, then throws.

## Keeping devtools out of production

Two pieces, both required. `withDevtoolsPruning` cuts the module graph at
resolution time so devtools code is never reachable:

```js
// metro.config.js
const { withDevtoolsPruning } = require('@rndevtools/react-native/metro');

module.exports = withDevtoolsPruning(config, {
  projectRoot: __dirname,
  replace: [
    {
      module: '@/features/dev-menu/dev-menu-host',
      path: 'src/features/dev-menu/dev-menu-host',
      stub: 'src/lib/dev-menu-host-disabled.tsx',
    },
  ],
});
```

Each stub must export the same shape as the real module with no-op bodies.
`path` is the file `module` resolves to, with or without its extension.
Imports are matched by the file they resolve to, so the alias, the relative
path `babel-plugin-module-resolver` rewrites it to, an explicit extension and
an `/index` import all get the stub. Leave `path` out only when `module` is
itself a project-relative path or an installed package. A `path` or stub that
names no file fails the config load, so a moved module cannot silently stay in
the bundle.

Pruning fails closed. It applies to every release bundle, meaning every
bundle Metro builds with `dev: false`. Metro hands the resolver that flag for
each bundle, the same flag that sets `__DEV__`, so there is no environment
variable to set and none to forget. That covers `expo export` (and so EAS
Update), Xcode and Gradle release builds, which bundle with `--dev false`
(`expo run:ios --configuration Release`, `expo run:android --variant release`,
EAS Build), and `expo start --no-dev`. A resolver context without the flag is
treated as a release. Development bundles are left alone.

While a bundle is pruned, an import that resolves into any `@rndevtools/*`
package without going through a `replace` entry fails the build, naming the
import and the module that made it, instead of quietly adding the package to
the bundle. A package is recognised by the `name` in its `package.json`, so a
workspace or `link:` install counts too.

Two options change the default. Both must be real booleans; an environment
variable passed straight through is a string, and is refused.

- `enabled: true` prunes development bundles too, to try the release graph in
  development. `enabled: false` is the same as leaving it out: it never turns
  pruning off.
- `keepInReleaseBundles: true` turns pruning off, so release bundles keep their
  devtools. It exists for an internal build that deliberately ships the tools,
  such as a preview for testers. Derive it from an exact match, for example
  `keepInReleaseBundles: process.env.APP_VARIANT === 'preview'`, so that a
  build which forgets the variable is still pruned.

`projectRoot` and `replace` are checked on every config load, development
included, unless `keepInReleaseBundles` is `true`.

The guarantee does not cover:

- A build with `keepInReleaseBundles: true`, such as that preview. It ships
  devtools by design and `rndevtools-verify-bundle` fails on it, so never let a
  store build inherit the setting.
- A bundle built with `dev: true`, wherever it ends up. `expo export:embed` and
  `react-native bundle` build one unless they are given `--dev false`.
- Your own diagnostics that import nothing from `@rndevtools/*`. Only a
  `replace` entry cuts them out, and only a `--marker` finds them.

Then prove it over a real export, in CI:

```sh
npx expo export --platform ios --platform android --output-dir ./build
npx rndevtools-verify-bundle ./build --marker "My Debug Panel"
```

The verifier reads every `.js`, `.mjs`, `.cjs`, Hermes `.hbc`, `.bundle` and
`.jsbundle` file in the directory, or the single bundle file you name (such as
an embedded `main.jsbundle`), and fails the build if a devtools marker
survives. It prints how many files it checked and fails when it finds none, so
a mistyped or empty output directory cannot pass. The built-in markers are
strings that minified production code keeps: panel copy and identifiers, plus
one on the runtime path of each entry point those cannot see, so that
importing it alone still fails the check. Those entry points are this
package's `/desktop`, `/authorization` and `/adapters/storage`, and core's
`/desktop-protocol`, `/plugins/images`, `/plugins/image-overlay` (which this
package's image overlay builds on), `/plugins/network-presentation`, `/redact`
and `/serialize` (which loads `/redact`). The one exception is core's
`/format`: its three formatters hold no string specific enough to look for,
so the verifier misses it when it is imported alone. Expo's experimental tree
shaking (`EXPO_UNSTABLE_TREE_SHAKING`) removes a marker together with the code
that holds it, so there the verifier misses an import when the code it keeps
holds none, as `getDevtoolsAuthorization` on its own does. A pruned build
refuses both imports anyway, because resolution runs before tree shaking; the
verifier is what still catches a config that stopped pruning. The `--marker`
flag adds strings specific to your own panels;
`verifyPrunedBundle(root, markers)` from
`@rndevtools/react-native/verify-bundle` checks the built-in markers as well
as the ones you pass.

Two opt-in checks catch a release bundle that was built against a developer's
machine, for example after a local backend's URL and keys were copied into a
`.env` file that the export also reads:

```sh
npx rndevtools-verify-bundle ./build --forbid-loopback-urls --preset supabase-local
```

- `--forbid-loopback-urls` fails on literal `http(s)://` and `ws(s)://` URLs
  whose host is `localhost`, `*.localhost`, `127.x.x.x` or `[::1]`.
- `--preset supabase-local` fails on Supabase secret keys (`sb_secret_…`), on
  JWTs whose payload carries `role: service_role`, and on JWTs issued by a
  local Supabase stack (`iss: supabase-demo`), whose default keys every local
  stack shares. A hosted project's URL and publishable or anon key pass.

A failure names each file and what was found, never the key itself. An
unknown flag or preset fails the run instead of skipping its check.

## Sharing native builds across worktrees

Running several git worktrees of one app side by side (the desktop app's
*lanes*) means several `expo run:ios` builds of the same native shell. The
build cache provider stores a finished Simulator or emulator binary once,
keyed by Expo's native fingerprint, and hands it to any worktree whose
fingerprint matches. A JavaScript-only branch installs in seconds instead of
rebuilding for twenty minutes, and two worktrees that miss at the same time
produce one build: the second waits for the first.

Expo loads providers from a dynamic config, so add an `app.config.js` next to
your `app.json`:

```js
// app.config.js
module.exports = ({ config }) => ({
  ...config,
  experiments: {
    ...config.experiments,
    buildCacheProvider: {
      plugin: '@rndevtools/react-native/build-cache',
      // options: { cacheDirectory: '~/Library/Caches/my-app/native' },
    },
  },
});
```

Then build as usual: `npx expo run:ios --device <udid> --no-bundler`. The
first worktree builds and uploads; later ones with the same fingerprint are
installed from
`~/Library/Caches/rndevtools/native/v2/<platform>/<configuration>/<toolchain>/<hash>/`
(`RNDEVTOOLS_BUILD_CACHE_DIR` or the `cacheDirectory` option relocates the root).
The `v2` namespace keeps the immutable lock protocol separate from older
worktrees. Legacy entries remain untouched; the first build with this provider
populates the new namespace.
Entries are split by platform, build configuration, and toolchain (CPU
architecture plus, for iOS, the `xcodebuild -version` output), so a Release
binary is never installed for a Debug run and an Xcode upgrade never serves a
build from the old SDK. Claims are immutable; when a builder dies or releases
its claim, waiters compete for one shared successor. An entry's binary is never
replaced once stored, so a second upload of the same fingerprint cannot
remove an app that another worktree is installing. Delete the directory to
start clean; there is no eviction.

`@expo/fingerprint` decides what counts as a native change. If your project
has native inputs outside the usual places, configure them in
[`.fingerprintignore` / `fingerprint.config.js`](https://docs.expo.dev/versions/latest/sdk/fingerprint/)
rather than here; this provider only stores what Expo hands it.

## Adapters

`createAsyncStorageDevtoolsAdapter` and `createSecureStoreDevtoolsAdapter`
wire your storage into the storage panel:

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { createStoragePlugin } from '@rndevtools/core/plugins/storage';
import {
  createAsyncStorageDevtoolsAdapter,
  createSecureStoreDevtoolsAdapter,
} from '@rndevtools/react-native/adapters/storage';

const storage = createStoragePlugin({
  adapters: [
    createAsyncStorageDevtoolsAdapter(AsyncStorage),
    createSecureStoreDevtoolsAdapter(SecureStore, [
      { key: 'session-token', description: 'Signed-in session' },
      { key: 'region-override', description: 'Region override', revealable: true },
    ]),
  ],
  rules: [{ adapterId: 'async-storage', key: 'onboarding-complete', required: true }],
});
```

Each factory takes an optional `{ id, title, description }` as its last
argument. The ids default to `async-storage` and `secure-store`. Earlier
versions used `example-async-storage` and `example-secure-store`, so update
any storage rule whose `adapterId` names one of those. The storage plugin
rejects two adapters with one id, so a second store of the same kind needs an
id of its own:

```ts
createAsyncStorageDevtoolsAdapter(offlineCache, {
  id: 'offline-cache',
  title: 'Offline cache',
});
```

The secure-store adapter takes an explicit key manifest: it never enumerates
the keychain, so only keys you list are ever readable, and it reads a value
only when its key is marked `revealable` and someone reveals it. Either
factory throws when it is given no store, instead of returning an adapter
whose every read fails. `devtoolsCameraProvider` serves desktop-pushed image
fixtures to an instrumented development camera.

## Image overlays

`imageOverlay` holds a reference image, such as a design export, for your app
to draw over its own screens. Local files and clipboard images need no setup.
Remote images are downloaded only from hosts you allow, and none are allowed
by default:

```ts
import { configureImageOverlay } from '@rndevtools/react-native';

configureImageOverlay({
  // Hostnames or HTTPS URLs; unset, blank and non-HTTPS entries are ignored.
  allowedRemoteHosts: ['designs.example.com', process.env.EXPO_PUBLIC_ASSET_URL],
});
```

Each call replaces the previous list. Earlier versions also trusted the hosts
in `EXPO_PUBLIC_IMAGE_OVERLAY_ORIGIN` and `EXPO_PUBLIC_SUPABASE_URL` without
being asked; pass those variables here to keep that behaviour.

## License

MIT

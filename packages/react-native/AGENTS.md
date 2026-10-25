# @rndevtools/react-native

React Native host runtime: desktop broker client, authorization mirror, storage and camera adapters, and the Metro production-pruning helper.

## Commands

```bash
pnpm --dir packages/react-native lint
pnpm --dir packages/react-native typecheck
pnpm --dir packages/react-native test:run
pnpm --dir packages/react-native quality
```

## Package Rules

- Keep this package host-agnostic. The desktop client takes a `DesktopClientHost` adapter; add a callback to that interface rather than importing app state or reaching for a global.
- Import from `@rndevtools/core`'s narrow subpaths (`/redact`, `/serialize`, `/desktop-protocol`), never the root barrel. The barrel pulls in the panel UI and Reanimated, which headless host modules must not depend on.
- Ships TypeScript source for the same reason as `@rndevtools/core`. Do not add a bundler.
- The broker socket is unauthenticated loopback. Keep `shouldStartDesktopClient` conservative: development builds only, inert under test, and honouring the kill switch.
- Any local process can answer on the broker's port, so the client keeps the broker's contract itself: it runs only actions for its own device and advertised capabilities, paces outgoing frames under the broker's per-connection rate limit, and bounds each host action with `actionTimeoutMs`.
- Authorization is a revocation boundary. A failed or changed owner read must revoke synchronously; re-granting is the host's explicit decision. While a source is bound, a grant applies only to its live owner, and a source whose `subscribe` throws revokes and refuses grants until a working one is bound.
- The secure-store adapter reads only keys in its caller-supplied manifest. Never enumerate a keychain.
- `withDevtoolsPruning` and `rndevtools-verify-bundle` are a pair. Changing either without the other silently weakens the production guarantee.
- Each entry point a host module can import alone (`./desktop`, `./authorization`, `./adapters/storage`, and core's `/desktop-protocol`, `/plugins/images`, `/plugins/image-overlay` under `./diagnostics/image-overlay`, `/plugins/network-presentation` and `/redact`, which `/serialize` loads too) keeps a marker string literal where a minifier must keep it: in code that runs, such as an error message, not in a comment, an unused constant or a `__DEV__` branch. Core's `/format` has none: its formatters hold no string specific enough to look for, so importing it alone goes unnoticed. `src/verify-bundle.test.ts` pins each marker to its source and runs that source through Expo's production transform, so renaming a marker means changing `DEFAULT_MARKERS` and `PINNED_MARKERS` in the same commit.
- `expo-file-system` and `expo-image-picker` are optional peers, listed in the root `knip.json` `ignoreDependencies` for that reason. The camera provider and the image overlay import them (`expo-image-picker` only for types), so the root barrel, `./camera` and `./diagnostics/image-overlay` reach them. Keep `./desktop`, `./authorization` and `./adapters/storage`, the entry points a headless host module imports, free of them and of the core plugins barrel; `client.test.ts` fails if `./desktop` loads either.
- `build-cache.js` is a Node-only Expo build cache provider (`./build-cache`), the same shape as `metro.js`: plain CommonJS at the package root, typed by a hand-written `.d.ts`, tested from `src/` through a typed `require` because this package deliberately has no `@types/node`. It must stay free of product paths; cache roots come from the OS cache directory, an env var, or an option.

# RN Devtools — Expo demo

A minimal Expo app wired to `@rndevtools/core` and
`@rndevtools/react-native`. It exists to prove the public contract: if this
app typechecks and exports cleanly, a consumer outside this repo can do the
same.

## What it shows

| File | Demonstrates |
| --- | --- |
| [`src/app.tsx`](src/app.tsx) | An app whose **only** devtools import is the host module |
| [`src/devtools/host.tsx`](src/devtools/host.tsx) | The single seam: mounts `InternalTools`, grants authorization, connects the desktop |
| [`src/devtools/plugins.ts`](src/devtools/plugins.ts) | Host-specific configuration: URL scheme, vendor correlation headers, environment values |
| [`src/devtools/desktop.ts`](src/devtools/desktop.ts) | Implementing `DesktopClientHost` to connect to the desktop app |
| [`src/lib/devtools-host-disabled.tsx`](src/lib/devtools-host-disabled.tsx) | The no-op stub a release build resolves to instead |
| [`metro.config.js`](metro.config.js) | `withDevtoolsPruning` cutting devtools out of every release bundle's module graph |
| [`app.config.js`](app.config.js) | The build cache provider that shares native builds between git worktrees (lanes) |

## Run it

```sh
pnpm install
pnpm --dir examples/expo-demo exec expo run:ios
```

Open the desktop app alongside it and the device appears automatically — the
client discovers a loopback broker on its own.

## Run several branches at once

Lanes in the desktop app (or `rndevtools lane --operation up`) run one worktree
per Simulator with its own Metro port. The included dev client has to exist on that
Simulator first; build it once and the cache provider in `app.config.js`
shares the binary with every other worktree whose native fingerprint matches:

```sh
npx expo run:ios --device <udid> --no-bundler    # first worktree builds and caches
git worktree add ../demo-feature feature/x        # same native shell, new JS
cd ../demo-feature && npx expo run:ios --device <other-udid> --no-bundler   # installs from cache
```

## A local Supabase per worktree

[`supabase/`](supabase/config.toml) is the repository setup RN Devtools
recommends for per-worktree local Supabase. It does three things:

- It opts into the Supabase CLI's managed stack backend (`[experimental] stack = true`).
- It pins no ports, so every worktree gets its own automatic ones.
- It turns Studio and analytics off in config, so even a start an agent runs by hand stays lean and has no unauthenticated SQL endpoint.

With local Supabase turned on in the desktop app's Supabase tab, a lane started on this app gets its own native stack. Its Metro receives only the stack's public URL and publishable key, under the variable names configured in that tab.

RN Devtools runs the worktree's own CLI and never a global one. This example includes `supabase` as a devDependency, pinned to the verified 2.121.0 release through the workspace catalog. The package age exceptions cover only that exact release and its platform binaries.

With RN Devtools running and local Supabase enabled, start the lane and its backend together:

```sh
rndevtools lane --operation up --worktree "$PWD/examples/expo-demo" --backend required
```

Never use `--runtime auto`: it prefers Docker, whose stacks listen on every interface.

When RN Devtools is not managing this worktree, a standalone start uses `pnpm --dir examples/expo-demo exec supabase start --runtime native`.

## Prove the pruning works

Two checks, at two speeds. The fast one walks the import graph with the same
replacement table Metro is given, and fails if anything from `@rndevtools/*`
is still reachable. It runs in the `quality` gate and names the offending
import:

```sh
pnpm --dir examples/expo-demo verify:seam
```

The rule it enforces is the whole trick: the app imports devtools from exactly
one module, and Metro replaces that module. A second import anywhere else
would reconnect the graph; in a release build Metro refuses it instead and the
build fails, naming the import. Release builds are pruned by default, so
nothing has to be set for this to hold. The slow check confirms it against a
real export:

```sh
pnpm --dir examples/expo-demo verify:bundle
```

The command exports the iOS and Android release bundles the way a store build
does (production, minified, Hermes bytecode) with no app variable set, and
asserts no devtools markers survived. CI runs it on every change. It is the
check worth copying into your own CI: it reads the bundle itself, so it still
fails if the Metro config stops pruning, for example after
`keepInReleaseBundles: true` is set or `withDevtoolsPruning` is removed.

## Notes

The app declares no action capabilities in `createDeviceInfo`, so every
privileged desktop control stays inert. A real host opts in one capability at a
time, and `runAction` here rejects everything by design — rejecting is how a
host refuses a desktop-issued action.

# RN Devtools — Expo demo

A minimal Expo app wired to `@rndevtools/core` and
`@rndevtools/react-native`. It exists to prove the public contract: if this
app typechecks and exports cleanly, a consumer outside this repo can do the
same.

## What it shows

| File | Demonstrates |
| --- | --- |
| [`src/app.tsx`](src/app.tsx) | An app whose **only** devtools import is the host module, with a local database probe |
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
per Simulator with its own Metro port. The cache provider in `app.config.js`
shares native builds between worktrees whose fingerprints match. Use the
[two-worktree procedure](#verify-two-isolated-databases) to reserve the ports
and install the dev clients through their native plans.

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

## Verify two isolated databases

Use the source snapshot paired with the installed QA desktop. Complete the Mac
and CLI setup in RN Devtools, enable Local Supabase, and select two available
iOS simulators. The app expects the policy's default Metro variables
`EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.

From a fresh clone's root, create a second worktree and give each app a unique
probe label. Run these commands in one shell so the paths and labels remain
available for the remaining steps.

```sh
qa_a="$(pwd -P)"
qa_b="$(dirname "$qa_a")/rndevtools-qa-b"
git worktree add -b qa/lane-b "$qa_b" HEAD
pnpm --filter @rndevtools/example-expo-demo... install --frozen-lockfile
pnpm --dir "$qa_b" --filter @rndevtools/example-expo-demo... install --frozen-lockfile

app_a="$qa_a/examples/expo-demo"
app_b="$qa_b/examples/expo-demo"
qa_run="qa-$(date -u +%Y%m%d-%H%M%S)-$$"
label_a="${qa_run}-a"
label_b="${qa_run}-b"
printf '{"label":"%s"}\n' "$label_a" > "$app_a/src/database-probe-config.json"
printf '{"label":"%s"}\n' "$label_b" > "$app_b/src/database-probe-config.json"
```

The label is a worktree-local JavaScript bundle input. Configure it before
starting Metro, which sets `EXPO_NO_DOTENV=1` for lanes. A clean clone has an
empty label and neutral seed notes. It can display a connection and notes
before the isolation check is configured.

Set `udid_a` and `udid_b` to the two distinct simulator identifiers shown by
RN Devtools. Start each lane with its backend and defer app launch.

```sh
rndevtools lane --operation up --worktree "$app_a" --udid "$udid_a" --backend required --launch=false
rndevtools lane --operation up --worktree "$app_b" --udid "$udid_b" --backend required --launch=false
rndevtools lane --operation ls
rndevtools supabase --operation ls
```

Wait for both backends to report ready. If a result includes a job ID, use
`rndevtools wait --condition job --job-id` with that ID. Record the distinct
simulator UDIDs, Metro ports and PIDs, stack IDs, API ports and database ports.

Write one marker to each running database using its worktree's pinned CLI.
The generated labels contain only letters, digits and hyphens. Use the same
labels for the relaunch and restart checks.

```sh
pnpm --dir "$app_a" exec supabase db query --local "insert into public.notes (body)
  select 'RN Devtools QA: ${label_a}' where not exists
  (select 1 from public.notes where body = 'RN Devtools QA: ${label_a}')"
pnpm --dir "$app_b" exec supabase db query --local "insert into public.notes (body)
  select 'RN Devtools QA: ${label_b}' where not exists
  (select 1 from public.notes where body = 'RN Devtools QA: ${label_b}')"

qa_query="select body from public.notes where body like 'RN Devtools QA: %' order by body"
pnpm --dir "$app_a" exec supabase db query --local "$qa_query"
pnpm --dir "$app_b" exec supabase db query --local "$qa_query"
```

Each query should return exactly its own marker. Inspect each assigned
simulator's native build plan.

```sh
rndevtools native --operation plan --worktree "$app_a" --udid "$udid_a"
rndevtools native --operation plan --worktree "$app_b" --udid "$udid_b"
```

Follow each recommendation. Install a cache hit with
`native --operation install`. For a cache miss, run the build each plan gives
once its lane's Metro is ready, `npx expo run:ios --device <udid> --no-bundler`,
as given: it names no port, because Expo CLI refuses `--port` with
`--no-bundler`, and it opens the app against port 8081. Then restart each app
through its lane, so it runs with that lane's Metro.

```sh
rndevtools lane --operation launch --worktree "$app_a" --restart
rndevtools lane --operation launch --worktree "$app_b" --restart
```

Tap **Refresh database** in each app and verify the label, local API URL and
marker against its lane. The app reports **PASS: expected QA marker only**
when the returned rows include its exact marker and contain no other QA marker.
A missing marker or a foreign marker fails the check. Repeat the two SQL
queries and both app checks after relaunching and restarting the desktop.

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

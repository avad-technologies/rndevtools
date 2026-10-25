# RN Devtools Desktop

An isolated Electron app for inspecting a running React Native development build. The renderer uses React, HeroUI, HeroUI Pro, Tailwind CSS, and a restrained Vercel-inspired visual system. Electron owns the local device broker and exposes only a narrow, typed preload API to the renderer.

## Tools

Connected app diagnostics:

- Network request history and request/response details
- Logger-backed, redacted console events
- Explicit storage adapters with protected values hidden
- TanStack Query queries, bounded sanitized payload previews, mutations, invalidate, and refetch actions
- Expo Router map, history, and allowlisted navigation
- Environment validation and health scoring
- Explicit Zustand store projections and change history, with confirmed Apply patch and Restore for stores declared restorable
- Guarded restore points for declared safe state sources, with rollback attempts
- JS responsiveness reviews with optional native UI/CPU/memory channels
- Targeted component registry with source, test ID, safe instance projection, measured bounds, and on-device highlight
- Broker, transport, runtime, privacy, and internal diagnostics

Local iOS Simulator tooling on macOS:

- Multi-Simulator fleet discovery, creation, cloning, boot/shutdown, erase/delete,
  installed-app inventory, process drill-down, disk inventory, and host/device metrics
- Experimental SimSlim profiles with compatibility gating, exact previews, checkpoints,
  verification, rollback, drift repair, capability doctor, and sequential batches
- Bundle-aware app install/launch/terminate, deep links, APNs payloads, permissions,
  location/routes, locale/time zone, appearance, Dynamic Type, status bar, keychain,
  pasteboard, and main-owned directory reveal actions
- Screenshots and H.264 recordings with crash recovery, private media URLs, retention,
  export/reveal/delete, and concurrent exact-UDID capture jobs
- Capture Design Studio with native PNG/JPEG composition, device treatment, canvas and
  background presets, metadata, rotation, fit/fill, shadows, and screenshot comparisons
- Versioned Automation recipes with exact targets, bounded concurrency, teardown,
  privileged-step approval, correlated local evidence, import/export, and cancellation
- Local Build Insights from user-selected `.xcresult` and DerivedData sources with
  12-month SQLite retention, full-history p50/p75/p95, seven-day averages, activity,
  and local JSON/CSV export. This initial foundation uses a local Node filesystem
  watcher and the supported public `xcresulttool build-results` view. That view
  does not report scheme, configuration, Xcode version, or reliable clean/incremental
  evidence, so those values remain explicitly unreported instead of being inferred.
  The Swift FSEvents adapter and versioned richer-metadata adapters remain deferred.
- Lanes: one git worktree on one Simulator with its own leased Metro port, so
  several branches and coding agents run side by side. Lanes refuse to steal a
  worktree, Simulator, or port; Metro health, agent attribution, and the Metro
  log are visible on the fleet wall and in the Lanes panel
- A signed `rndevtools` local-agent CLI over a current-user `0600` Unix socket,
  including `lane up|down|ls|launch|log` and an agent skill
- Local Supabase per worktree (alpha): the Supabase tab (⌘8) tracks every native
  local Supabase stack on this Mac. For each one it shows the agent session, lane,
  Simulator and worktree/branch it belongs to. It starts, stops, resets, migrates,
  inspects, reads logs for and cleans up stacks, and lets lanes start the
  worktree's stack automatically. See [Local Supabase per worktree](#local-supabase-per-worktree-alpha).

Protocol v2 adds Simulator identity, explicit semantic elements and safe actions,
app-scoped network conditions, request/recipe correlation, and development camera
fixtures. Protocol v1 diagnostics remain accepted.

The app starts in a connection-ready state and shows real development devices as they connect. Set `RNDEVTOOLS_DEMO=true` when you deliberately want a simulated device for UI exploration. Multiple connected and recently disconnected devices are retained in the device picker.

## Run locally

From the monorepo root:

```bash
pnpm --filter @rndevtools/desktop dev
```

`dev` keeps the cross-platform connected-app diagnostics loop fast and does not
generate ignored native binaries. On macOS, a clean checkout should use the
Simulator-capable command at least once (and again after native changes):

```bash
pnpm --filter @rndevtools/desktop dev:simulator
```

That command verifies the pinned vendored SimSlim source, builds the Go and
Swift helpers for the current architecture, then starts Electron.

The pinned Electron release has no install hook, so `pnpm install` deliberately
does not fetch the runtime. The first `dev` or `start` prints
`Downloading Electron binary...` and pulls roughly 110 MB from GitHub releases
into `node_modules/electron/dist`; every later run reuses it. `package` and
`make` never use that copy: electron-builder downloads the same zip through its
own `@electron/get`, reuses one already in Electron's cache
(`~/Library/Caches/electron` on macOS), and still fetches `SHASUMS256.txt` on
every run. Packaging offline therefore needs a seeded `SHASUMS256.txt-44.7.0`
(named for the pinned version) in that cache root, or electron-builder's
`electronDist` option. On an offline machine or behind a proxy, set
`ELECTRON_MIRROR` before the first run; it applies to both downloads.

The mobile diagnostics client starts only when the host's
`shouldStartDesktopClient({ isDevelopmentBuild })` check passes: in a
development build, outside tests, and unless
`EXPO_PUBLIC_DESKTOP_DEVTOOLS_DISABLED=true`. Hosts pass their own
development-build flag (the Expo demo passes `__DEV__`), so preview and
production builds never dial the broker.

The broker listens on `ws://127.0.0.1:47931/device` by default. Expo simulators discover loopback and the Expo development host automatically. If that port is occupied, both sides try the next nine ports.

Useful commands:

```bash
pnpm --filter @rndevtools/desktop quality
pnpm --filter @rndevtools/desktop check:dead-code
pnpm --filter @rndevtools/desktop build
pnpm --filter @rndevtools/desktop package
pnpm --filter @rndevtools/desktop make
```

`package` creates an unpacked, locally runnable app in `apps/desktop/release`. `make` creates the configured platform artifacts: DMG and ZIP on macOS, NSIS on Windows, or AppImage and DEB on Linux. Distribution releases still require the normal platform signing and notarization credentials.

The app icon source is [`build/icon-source.png`](build/icon-source.png): the approved
phone-and-inspection-target artwork, with transparent margins. After replacing it,
regenerate the committed 1024px PNG and macOS ICNS assets on a Mac:

```bash
pnpm --filter @rndevtools/desktop icons:generate
```

Simulator mutations and native helpers are macOS-only. On Windows and Linux, the
connected-app diagnostics continue to work and Simulator workspaces present a bounded
unsupported state rather than attempting to execute bundled macOS tools.
The main process validates and atomically persists an explicitly selected Xcode
developer directory, restores it before helper discovery on restart, clears stale
selections safely, and forces capability rediscovery after a selection changes.

Native source gates and both-architecture builds:

```bash
pnpm --filter @rndevtools/desktop native:check
pnpm --filter @rndevtools/desktop native:build:all
pnpm --filter @rndevtools/desktop native:verify
pnpm --filter @rndevtools/desktop native:verify:capabilities
```

`native:check` requires Go 1.27, `govulncheck`, and the Xcode Swift toolchain. Generated
native binaries are ignored by Git and are rebuilt, hashed, signed, and verified by the
macOS package job.

## Connect a physical device

Loopback is the safe default. The broker itself speaks plaintext WebSocket, while the mobile client requires TLS for every non-loopback address. To connect a physical device, bind the broker to the computer's specific development-network address, put an authenticated TLS terminator or secure tunnel in front of it, and give the mobile development build the resulting `wss://` URL with a token of at least 16 characters:

```bash
RNDEVTOOLS_BIND_ADDRESS=<computer-lan-ip> RNDEVTOOLS_TOKEN=<long-random-token> pnpm --filter @rndevtools/desktop dev
# From your app's directory:
EXPO_PUBLIC_DESKTOP_DEVTOOLS_URL='wss://<tls-endpoint>/device?token=<long-random-token>' npx expo start
```

The desktop Diagnostics panel lists the broker endpoints. Treat a tokenized URL as a development credential and do not paste it into tickets or logs. `RNDEVTOOLS_PORT` changes the initial port; if it is occupied, the broker tries the next nine ports. An explicit mobile URL should include the selected port when the TLS endpoint does not use its protocol default. Set `EXPO_PUBLIC_DESKTOP_DEVTOOLS_DISABLED=true` to disable the development client.

Wildcard binding is intentionally a second opt-in. If a local setup truly requires `0.0.0.0` or `::`, also set `RNDEVTOOLS_ALLOW_WILDCARD=true`; prefer an exact interface address because wildcard binding can include VPN and other unintended adapters. Never expose the plaintext broker directly to an untrusted network.

Diagnostic payloads are metadata-only by default. A host that deliberately needs sanitized query values or HTTP bodies opts in per plugin, with `createQueryPlugin({ captureData: true })` and `createNetworkPlugin({ captureBody: true })`; both default to `false`. Assume any opted-in payload can contain application data, and keep the connection local and temporary.

## Local Supabase per worktree (alpha)

The Supabase tab (Simulator workspace, Backend group, ⌘8) runs one native local
Supabase stack per git worktree and branch. It uses the Supabase CLI's
experimental stack backend: no Docker, automatic loopback ports, and about
160 MiB per idle stack. Design, measurements, the full UI specification and the
as-built notes are in [`experiments/supabase-backends/`](experiments/supabase-backends/).

### Requirements

- **This Mac:** Apple silicon with macOS 14 or later.
- **Turn it on:** Supabase › Turn on local Supabase. It is off by default, and
  nothing is probed or spawned while it is off.
- **The repository:**
  - commits `[experimental] stack = true` in `supabase/config.toml`, pins no ports,
    and preferably disables Studio and analytics in config
    (see [`examples/expo-demo/supabase`](../../examples/expo-demo/supabase/config.toml));
  - pins `supabase` exactly as a devDependency. RN Devtools runs the worktree's own
    CLI and never a global one, and it verifies CLI 2.121.0.

### What it does

- **Native only.** It creates every stack with `--runtime native` and never uses
  `auto` or Docker. After every start it runs `lsof` over the stack's process
  tree and stops the stack if anything listens beyond loopback. A Docker or
  Podman stack it finds is flagged as LAN-exposed; one on a worktree RN Devtools
  manages is stopped once and never attached.
- **Lanes.** A lane on a development worktree starts or resumes that worktree's
  stack while the Simulator boots. Its Metro gets only the stack's API URL and
  publishable key, under variable names you configure in the tab's settings.
- **Agents.** Agents use `rndevtools supabase --operation up|down|ls|status|env|reset|log|destroy`,
  or the `supabase` MCP tool, plus the worktree's own `supabase … --local` data
  commands. `rndevtools setup` installs the `rndevtools-supabase` skill and a
  hook that steers agents away from hand-run lifecycle commands while RN Devtools
  manages the worktree. Destroying, or resetting a stack another session holds,
  becomes a request you approve.
- **Holds and cleanup.** Stacks are held by lanes, agent sessions and your pins,
  like Simulators. One stops 60 s after its last holder releases it, 10 min after
  that holder's session is gone, or at once when its worktree is deleted. Data is
  kept. Destroying is never automatic: Clean up suggests orphaned, stale-branch and
  long-stopped stacks with their sizes.
- **Branch switches.** Stack identity includes the git branch. RN Devtools follows
  a held stack to the new branch after HEAD has been stable for 30 s and no rebase
  or merge is running, and switching back reattaches the old one. Following from
  the stack's notice, or an agent's `up`, skips the 30 s wait.
- **Confirmations.** Destroy, reset, recreate, enabling Studio, stopping a stack
  RN Devtools didn't start, turning the feature on or turning it off while
  managed stacks run, settings that weaken a safeguard, and approving an agent's
  destroy or reset go through a native dialog with Cancel as the default and a
  one-time token. Database changes run only from the stack's own worktree, and
  only while that worktree is on the stack's branch.

### Trade-off

Supabase recommends Docker for several local projects on one machine. Native
stacks share this Mac's process table, the default local keys are public
constants shared by every stack, and `supabase_admin` is trusted on loopback.
Treat local Supabase as single-user-Mac tooling: stacks are separate databases,
not isolated tenants.

## Security and privacy boundaries

- The Electron renderer runs sandboxed with context isolation, no Node integration, a Content Security Policy, denied popups/navigation, and a frozen preload bridge.
- Packaged binaries disable Electron's Node and inspect escape hatches, require ASAR loading, and enable embedded ASAR integrity validation.
- The broker binds only to loopback unless LAN access is explicitly enabled with a sufficiently long token.
- Connection count, pre-parse message rate, 16 MiB mobile snapshot envelopes at the broker (the mobile client additionally caps its own outgoing snapshot at 8 MiB), aggregate retained snapshot bytes, diagnostic history, and renderer state broadcasts are bounded.
- Incoming messages and renderer actions are schema-validated. Mobile actions are additionally constrained to per-tool command allowlists.
- Console and network payloads use bounded, redacted collectors; query data and HTTP bodies are opt-in even in development. Secure storage values never cross the bridge.
- Zustand and component inspection use explicit registries; there is no global store or React-tree crawl.
- Restore points contain only sources declared safe to restore. A restore attempts rollback from a safety copy if a source fails, but independent state adapters cannot provide true atomic transactions.
- Recently disconnected sessions are retained for 24 hours for comparison, in memory only.
- Simulator commands always resolve a fresh canonical UDID and use fixed executables,
  argument arrays, minimal child environments, bounded output/timeouts, and per-target
  mutation serialization. They never traverse the mobile WebSocket.
- Simulator media is stored under the app data directory and served only through opaque
  `rndevtools-capture://` IDs. Renderer APIs never accept or return filesystem paths.
- SimSlim mutations are off by default. Destructive actions and experimental mutations
  use short-lived confirmations bound to the exact sender, target, and normalized payload.
  The signed Swift host additionally authenticates the packaged Electron parent and gives
  the signed Go helper a one-shot operation/UDID/exact-request authorization on inherited
  FD 3. A private marked FD 4 control pipe handles graceful cleanup and rollback without
  relying on process-signal delivery. Direct, unsigned-development, and ad-hoc helper mutation attempts fail closed;
  read-only inspection remains available.
- Build artifacts, captures, process data, recipes, and evidence remain local. Build source
  paths stay in Electron main and never cross the preload boundary.
- Local Supabase keys, the database URL and CLI output stay in Electron main. The
  renderer receives loopback URLs, ports, ids and redacted, bounded text. Copying a
  key or psql command happens in main, and main clears the clipboard 60 s later if
  it still holds that text. The Supabase CLI runs with an allowlisted environment
  from a neutral working directory, with telemetry and update checks off. Nothing
  Supabase-related crosses the unauthenticated broker.

This remains an internal development tool. Do not enable its mobile client in release builds or expose the LAN broker on an untrusted network.

## HeroUI Pro installation

HeroUI core and HeroUI Pro are intentionally used together. Pro supplies the dense data-grid, native select, and empty-state primitives; core supplies the remaining controls. A clean install must be authenticated for the licensed Pro package. Developer machines can use the HeroUI CLI login, while CI should provide its HeroUI auth token through the secret environment rather than committing credentials.

## Architecture

```text
App dev build         ── WebSocket protocol v1/v2 ── DesktopBroker
                                                        │
HeroUI renderer ── frozen, typed preload bridges ── Electron main
                                                        ├── fixed xcrun simctl adapter
                                                        ├── signed Go SimSlim helper
                                                        ├── signed Swift native host
                                                        ├── capture / recipe / build stores
                                                        └── private local-agent socket
```

The wire contract is versioned and its device/snapshot DTO is shared by the mobile
projector and desktop Zod boundary. Protocol v2 features are capability-gated; v1 remains
available for the original diagnostics. Tool snapshots are complete, atomic replacements;
a client that omits a projection is rejected so stale and fresh state cannot be mixed.

ScreenCaptureKit live mirroring/audio, the whole-Simulator Network Extension, and
arbitrary-app XCTest accessibility are shown as capability-gated advanced providers. They
are not silently approximated: raw `simctl io` capture, app-scoped network profiles,
and semantic actions remain the supported fallbacks until those separately signed,
permissioned providers are available.

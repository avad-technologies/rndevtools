# Desktop native helpers

The desktop app packages three small, first-party macOS executables. None
downloads code, opens a network listener, or exposes a shell. Every protocol
operation and CLI flag is explicitly allowlisted and bounded.

- `rndevtools-sim-helper` is a first-party Go protocol adapter linked to an exact,
  checked-in snapshot of SimSlim v0.12.2. It discovers the default iOS Simulator
  device set, reads managed launchd overrides, projects the pinned service
  catalog, previews and verifies profiles, runs capability diagnostics, and
  performs compatibility-gated experimental apply, restore, and undo
  transactions through SimSlim's public library API. This repo owns the bounded
  request boundary, confirmations, two-phase restart-safe checkpoints,
  independent launchd-registration verification, commit-time exact-UDID
  process-root absence evidence, exact rollback orchestration, and job
  serialization. The helper never invokes the upstream CLI or downloads code.
- `rndevtools-native-host` is a Swift executable that reports its protocol version,
  non-prompting macOS permission status, and a bounded native-capability
  projection. Protocol v2 inspects ScreenCaptureKit, AVFoundation,
  VideoToolbox, Accessibility, FSEvents, and Network Extension prerequisites
  without enumerating content, reading network preferences, requesting
  permissions, or mutating external state.
  Protocol v3 also performs bounded, nondestructive PNG/JPEG Capture Design Studio
  compositions inside a helper-owned private workspace. Inputs and outputs are staged by
  Electron main; the renderer and helper protocol never exchange application paths.
  Protocol v4 is the sole mutation broker for the Go simulator helper. It requires the
  live production-signed Electron parent to carry the native host's own Apple Team ID
  (the Go helper pins that team at build time from `APPLE_TEAM_ID`), validates the
  exact manifest bytes against the parent app's resource seal, binds both native
  executables to the same build, and verifies the suspended helper's exact live
  CodeDirectory identity before delivering an operation/UDID/exact-request-bound one-shot
  authorization on inherited FD 3. A separately marked private control pipe on FD 4
  requests graceful cancellation and gives helper rollback its full bounded grace period.
- `rndevtools` is a standard-library-only Go command-line client for local
  agents and scripts. It connects only to the current user's private RN Devtools
  Devtools Unix socket, sends one bounded `rndevtools/1` command, receives
  one bounded response, and exits. It has no shell or network-discovery path.

The simulator helper consumes protocol v2. The native host keeps its exact
protocol-v1 surface for the existing Electron client, adds the protocol-v2
`capability_status` operation, protocol-v3 `compose_image`, protocol-v4's
signed-parent `run_simulator_mutation` broker, and protocol-v5's
`send_simulator_input` (taps, swipes, typed text, keys, and hardware buttons
over SimulatorKit's HID transport; see PROTOCOL.md). Both consume one bounded JSON object from
standard input, emit one bounded JSON object to standard output, and exit. The
CLI uses its separately versioned local-socket contract. The build emits a
SHA-256 manifest beside all three binaries. On macOS, the packaging hook first
verifies the source manifest, signs the nested binaries with the app's resolved
identity, atomically refreshes their sizes and hashes, and verifies them again.
The outer app is signed last while excluding those already-signed binaries, so
its resource seal covers the final bytes and manifest without invalidating
either.

Live-capture sessions are intentionally not exposed by this helper. A start/stop
session cannot be made crash-safe in a one-request executable: it needs a
supervised long-lived process, explicit window selection, bounded frame
transport, cancellation, and guaranteed stream cleanup. Protocol v2 reports
whether the underlying capture path is usable so that session ownership can be
added without guessing about permissions or hardware support.

Simulator mutation remains explicitly experimental. Known tuples are
classified as `verified`, `limited`, `unknown`, or `blocked`; an unknown tuple
requires the exact `EXPERIMENTAL` acknowledgement on every request, while a
blocked tuple cannot be overridden. The helper has no verified tuples at the
time of this catalog revision. See `PROTOCOL.md` for confirmations, checkpoint
ownership, rollback evidence, and graceful cancellation behavior.
Confirmation literals and `EXPERIMENTAL` are not authorization: direct Go-helper
mutation is denied without the signed Swift parent and its one-shot inherited-FD grant.
Unsigned development and ad-hoc packages intentionally retain read-only inspection but
cannot perform real mutations.

Build the current architecture:

```bash
pnpm --filter @rndevtools/desktop native:build
pnpm --filter @rndevtools/desktop native:verify
pnpm --filter @rndevtools/desktop native:verify:capabilities
```

Build both supported macOS architectures:

```bash
pnpm --filter @rndevtools/desktop native:build:all
```

The simulator helper and the native host report the desktop version from
`package.json` in their handshakes, and Electron treats a helper whose handshake
disagrees with the manifest as untrusted. The Go binaries receive that version
through `-ldflags`. Swift has no equivalent, so the native host compiles it from
the generated, committed
`rndevtools-native-host/Sources/RNDevtoolsNativeHost/HelperVersion.swift`, and a
plain `swift build` still works. The native build regenerates that file (a
public release refuses a stale one instead), and `native:verify:capabilities`
requires the built host's handshakes to report the `package.json` version. After
changing the desktop version, run:

```bash
pnpm --filter @rndevtools/desktop native:sync-version
```

and commit the regenerated file.

Run source checks:

```bash
pnpm --filter @rndevtools/desktop native:check
```

Every check selection first fails when `HelperVersion.swift` does not declare
the `package.json` version. The Go gate runs formatting, vet, race tests, a
hermetic two-module dependency check for the Simulator helper,
standard-library-only enforcement for the agent CLI, exact vendored-file
SHA-256 verification, and `govulncheck` with module downloads disabled. The
Swift gate runs strict formatting and package tests.

Generated binaries live under `build/native/mac-{arm64,x64}` and are ignored by
Git. `electron-builder` copies only the package target's architecture into
`Contents/Resources/native`; it never downloads a helper at runtime.

The macOS CI package gate refuses to run while any existing RN Devtools app
instance could absorb the launch. It starts the packaged Mach-O directly, waits
for a live renderer process, holds a stability window, rejects new macOS crash
reports, and then terminates only the process it launched.

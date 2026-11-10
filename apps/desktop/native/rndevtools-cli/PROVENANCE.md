# `rndevtools` provenance

`rndevtools` is first-party code written for the
RN Devtools desktop app. Apart from the vendored go-toml module described
below, no source, generated code, protocol definitions, or catalog data was
copied from SimSlim, Buoy, RocketSim, or another third-party project.

The wire contract was developed alongside this repo's TypeScript desktop service
and is intentionally fixed to `rndevtools/1`. The Go module depends on one
external module, go-toml v2.4.3, which is vendored and pinned as described
below. Its other incorporated third-party material is the Go runtime and
standard library. Go's BSD notice and go-toml's MIT notice are reproduced in
`apps/desktop/THIRD_PARTY_NOTICES.md` and are packaged with the application.

Release binaries are built from this directory with `CGO_ENABLED=0`,
`GOOS=darwin`, and an explicit `GOARCH` of `arm64` or `amd64`. The build script
embeds the desktop app version and a clean or dirty-aware source identity, then
records the unsigned development binary's SHA-256 digest and byte size in the
native-resource manifest. During packaging, the after-pack hook first verifies
that manifest, signs each packaged copy with the app's resolved identity,
atomically refreshes only the packaged manifest's sizes and hashes, and verifies
the signed bytes again before the outer app is sealed. Runtime downloads and
binary replacement are not supported.

When the contract changes, update the Go protocol, its tests, the matching
TypeScript service/schema tests, and this record in the same change. A breaking
wire change requires a new protocol string rather than silently widening
`rndevtools/1`.

## Vendored go-toml

- Module: `github.com/pelletier/go-toml/v2`
- Release: `v2.4.3` (<https://github.com/pelletier/go-toml/tree/v2.4.3>)
- `go.sum`: `h1:GTRvJQutkOSftxIFD5xw9aepkYNuPWmVJpffdDPYVpY=` for the module
  and `h1:2gIqNv+qfxSVS7cM2xJQKtLSTLUE9V8t9Stt+h56mCY=` for its `go.mod`
- License: MIT, reproduced in `apps/desktop/THIRD_PARTY_NOTICES.md`
- Compiled packages: the root package, `unstable`, `internal/parserbridge`, and
  `internal/tracker`
- Vendored-tree manifest: `VENDORED_SOURCE_SHA256SUMS`

`setup` registers the MCP server in Codex's `config.toml`, and `agent-check`
reads and repairs settings in Codex's TOML files. go-toml's decoder
rejects invalid TOML, and the byte offsets from its `unstable` parser let an
edit replace one value while the user's comments, layout, other settings, and
table-like text inside strings stay as they were. Every edited file is decoded
again, and the edit is refused when it no longer parses. The `unstable` API
carries no upstream compatibility promise, which is one more reason the module
is pinned and vendored rather than resolved at build time.

`vendor/` holds exactly what `go mod vendor` selects for that release: the
non-test files of the four compiled packages, `LICENSE`, and upstream's other
root files (contributor guide, CI scripts, Dockerfile, release configuration).
Go never builds or runs those extra files, and the vendored `AGENTS.md` is
upstream's contributor guide, not an instruction for this repository. The
compiled packages import only the standard library and each other, with no
cgo, `unsafe`, `os`, `os/exec`, `net`, or `syscall`; their one `init` wires the
parser bridge.

The CLI is built and checked with `-mod=vendor`, `GOPROXY=off`, `GOWORK=off`,
and `GOTOOLCHAIN=local`, and in vendor mode Go never compares vendored bytes
with `go.sum`. `apps/desktop/scripts/verify-vendored-go-toml.mjs` therefore
hard-codes the SHA-256 of `VENDORED_SOURCE_SHA256SUMS`, requires that manifest
to list exactly the regular files under `vendor/` (`modules.txt` included) with
matching digests, and requires `go.mod`, `go.sum`, and `vendor/modules.txt` to
be the pinned text. An edited, added, or symbolically linked file fails (Go
would compile an added file into the package), and so does an edit whose
editable manifest was regenerated to match. The Go check
(`check-native-helpers.mjs --go`) and the native build run this verifier beside
the SimSlim one, before they start a toolchain.

These anchors bind the build to the reviewed snapshot, but they run offline and
cannot show that the snapshot is the published release. On a machine with
module downloads enabled, `go mod download`, `go mod verify`, and
`go mod vendor` must leave `git diff --exit-code vendor/` clean; that ties the
vendored bytes to `go.sum` and the Go checksum database. No such run is
recorded for the current snapshot.

### Updating go-toml

1. From this directory, with module downloads enabled, run
   `go get github.com/pelletier/go-toml/v2@<release>`, `go mod verify`, and
   `go mod vendor`.
2. Review the upstream changes and license, and confirm that the compiled
   packages still import only the standard library.
3. Regenerate the manifest:
   `find vendor -type f | LC_ALL=C sort | xargs shasum -a 256 > VENDORED_SOURCE_SHA256SUMS`
4. In `apps/desktop/scripts/verify-vendored-go-toml.mjs`, update the manifest
   SHA-256 (`shasum -a 256 VENDORED_SOURCE_SHA256SUMS`) and the exact `go.mod`,
   `go.sum`, and `vendor/modules.txt` text, then the expected values in its
   node test.
5. Update the module pin in `apps/desktop/scripts/check-native-helpers.mjs`,
   the notice in `apps/desktop/THIRD_PARTY_NOTICES.md`, and this record.
6. Run `pnpm --filter @rndevtools/desktop native:check:go` and
   `pnpm --filter @rndevtools/desktop native:check:packaging`.

## Additive changes within `rndevtools/1`

Each entry is optional on the wire, so an older desktop rejects it with a
recovery message instead of misreading it, and an older CLI never sends it.

- `release.sessionCwd`: an absolute path (at most 1024 characters), accepted
  only with `all: true`. The session-end hook sends the ending session's
  working directory so the desktop can release lanes and claims held under a
  shared MCP identity (Codex over MCP) by directory.
- The `supabase` command kind: `{"kind":"supabase","operation":"up"|"down"|
  "ls"|"status"|"env"|"reset"|"log"|"destroy"}` with the optional fields
  `worktreePath` (absolute, 2..1024 bytes, no control characters), `stackId`
  (8..64 lowercase hex), `waitMs` (`up` only, integer 0..45000), `seed`
  (`reset` only, boolean), `services` (`log` only, 1..16 distinct service
  kinds, `gateway`, or instance UUIDs), `tail` (`log` only, integer 1..1000),
  `since` (`log` only, `start`, a duration, or an ISO-8601 time, at most 64
  characters), and `note` (`destroy` and `reset`, at most 240 UTF-16 units).
  `ls` takes no target; every other operation takes exactly one of
  `worktreePath` or `stackId`. The agent's identity stays on the envelope.
  The Go schema and the desktop's agent CLI schema accept and reject the same
  matrix (`command_test.go`).
- `lane.backend`: `"auto"`, `"off"`, or `"required"`, accepted only with
  `operation: "up"`; it selects the worktree's local Supabase for the lane.
  The receipt's `lane.backend` summary is wire-only on the desktop side.
- The `simulator` command kind:
  `{"kind":"simulator","operation":"boot"|"shutdown","udid":…}`, with all
  three fields required and no others; `udid` is an exact Simulator UDID,
  never `booted`. It boots or shuts down one Simulator that the calling
  session already holds through a claim or its lane. The desktop refuses a
  shared synthetic identity (`agent_required`), a device nobody holds
  (`device_claim_required`), and a device that another session or the desktop
  operator holds (`device_held`), and it checks ownership again when the
  queued job starts. The receipt carries `operation`, `udid`, `completed`,
  `jobId`, and `job`, plus `next` while the job is still running; cancelling
  the call requests cancellation of the job. The read-only `simulators` list
  is unchanged. The Go schema and the desktop's agent CLI schema accept and
  reject the same requests (`command_test.go`, `agent-cli-protocol.test.ts`).
- `lane.restart`: a boolean, accepted only with `operation: "up"` or
  `"launch"`; `true` is refused on an `up` with `launch: false`. It asks the
  desktop to terminate the lane's app on the lane's Simulator before the dev
  client or the `url` opens, by the bundle identifier the worktree's app.json
  declared when the lane started (a lane without one refuses it), and a
  terminate that fails fails the launch. Without it only a lane's first
  dev-client launch terminates the app, best effort. The Go schema and the
  desktop's agent CLI schema accept and reject the same requests
  (`command_test.go`, `agent-cli-protocol.test.ts`).

The PreToolUse hook also reads `steering.json` v1, which the desktop writes
into the agent socket directory; it is a local file contract between the
desktop and this CLI, not part of `rndevtools/1`, and the hook ignores any
file that is not exactly that shape.

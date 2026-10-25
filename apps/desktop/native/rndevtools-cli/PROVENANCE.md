# `rndevtools` provenance

`rndevtools` is first-party code written for the
RN Devtools desktop app. No source, generated code, protocol definitions, or
catalog data was copied from SimSlim, Buoy, RocketSim, or another third-party
project.

The wire contract was developed alongside this repo's TypeScript desktop service
and is intentionally fixed to `rndevtools/1`. The Go module has no external
module dependency: `go list -m all` must return only
`github.com/adalloul0928/rndevtools-cli`. Its only incorporated
third-party material is the Go runtime and standard library; the applicable BSD
notice is reproduced in `apps/desktop/THIRD_PARTY_NOTICES.md` and is packaged
with the application.

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

The PreToolUse hook also reads `steering.json` v1, which the desktop writes
into the agent socket directory; it is a local file contract between the
desktop and this CLI, not part of `rndevtools/1`, and the hook ignores any
file that is not exactly that shape.

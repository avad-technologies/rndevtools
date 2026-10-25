# SimSlim library provenance

`rndevtools-sim-helper` links a pinned, reviewed fork of SimSlim's public Go
package. It does not execute the SimSlim CLI, download code at runtime, or
accept arbitrary launchd labels from Electron or the renderer.

Base source:

- Repository: <https://github.com/MobAI-App/simslim>
- Release: `v0.12.2`
- Commit: `6518ba7eab1123d7e1d7797b0e05f51043b42a5b`
- License: MIT, reproduced in `apps/desktop/THIRD_PARTY_NOTICES.md`
- Clean-base manifest: `UPSTREAM_SOURCE_SHA256SUMS`
- Reviewed patch: `RNDEVTOOLS_PATCHSET_rndevtools.1.patch`
- Final vendored-tree manifest: `VENDORED_SOURCE_SHA256SUMS`

The vendored package contains all 17 non-test root Go files and `LICENSE` from
that commit. Fourteen Go files and the license remain byte-identical to
upstream. Patch set `rndevtools.1` changes exactly three files:

- `clone.go` replaces upstream's same-user `ps eww` environment scan with an
  exact CoreSimulator launchd-root lookup, a PID/PPID/CPU/comm-only process-tree
  projection, and `lsof` limited to that tree.
- `disk_cleanup.go` restores a previously booted Simulator with an independent,
  bounded context even when the cleanup request is cancelled.
- `simctl.go` exports the upstream package's canonical disabled-override parser
  so the adapter does not maintain a second launchctl grammar.

The build-time verifier hard-codes and checks the SHA-256 of the clean-base
manifest, the deterministic patch artifact, and the final vendored manifest.
It proves unchanged files still match the pinned base, only the three disclosed
files differ, every final vendored byte matches the reviewed snapshot, and the
module graph contains only this helper plus `github.com/mobai-app/simslim v0.12.2`.
Changing source and merely regenerating an editable checksum file therefore
does not pass the build.

## Adapter ownership

SimSlim remains the source of service labels, category overlap, profile
resolution, simulator lookup, boot/shutdown, service transitions, disk
inventory/cleanup, and clone repair. This helper adds a bounded one-request JSON
boundary, exact-UDID validation, compatibility and confirmation policy,
two-phase durable restore-point persistence, helper-supervision time budgets,
and sequential per-Simulator jobs.

Preset revision `presets.3` uses upstream `Profile.Keep` to preserve
`com.apple.MapKit.SnapshotService`, `com.apple.siri.acousticsignature`, and
`com.apple.siri.context.service` in the two bundled presets. These jobs remained
registered after reboot in real iOS 26.5 apply attempts, which correctly failed
verification and rolled back. They remain in the managed universe for legacy
override repair. The upstream source and patch set remain unchanged; Maximum
Density still projects the complete upstream desired set. Profile responses
disclose these exceptions through optional `preservedServiceIds`.

`presets.3` differs from `presets.2` only because the upstream v0.12.2 catalog
moved `com.apple.assistantd` (dictation host; Spotlight leaks memory without it)
and `com.apple.gamed` (XCUITest launch latency) from slimmable labels to
restore-only `AlwaysEnabled` services, next to `com.apple.sharingd`, and listed
`com.apple.navd` under widgets as well as connectivity. The slimmable universe is
168 labels and the managed universe 171. Upstream also added
`EnableSlimNoReboot`, an offline override store that applies profiles to a shut
down Simulator in seconds, and `Watch`; this helper does not call them yet, and
the compatibility matrix remains empty until the disposable-Simulator suite is
rerun against this base.

Verification proves exact managed override equality and the absence of
disabled launchd job registrations through `launchctl print`. Immediately
before a transition, the helper also binds each running to-disable label's single
launchd PID/program to a unique executable basename in SimSlim's exact-UDID
process tree, then requires those observed roots to be absent after reboot.
Missing or ambiguous mappings fail before mutation. This conservative process
proof covers managed jobs observed running at commit; a job that was already
not running is covered by launchd-registration absence rather than a historical
process claim. The compatibility matrix remains empty until a disposable
real-Simulator suite proves efficacy for an exact
macOS/Xcode/CoreSimulator/runtime/helper/catalog tuple.

## Hermetic module pin

`go.mod` names `github.com/mobai-app/simslim v0.12.2`; `vendor/modules.txt`
binds the checked-in package to that identity. Checks force vendor mode with
network and workspace resolution disabled. Builds use a minimal allowlisted
environment, `GOTOOLCHAIN=local`, `GOPROXY=off`, `GOWORK=off`, and explicit
architecture defaults. There is intentionally no `go.sum`: module-archive
checksums do not validate patched vendored bytes, while the three anchored
manifests validate the exact source compiled into the helper.

## Update procedure

1. Resolve a named upstream release to a full verified commit and review its
   license.
2. From a clean checkout at that commit, regenerate
   `UPSTREAM_SOURCE_SHA256SUMS` for the root package and license.
3. Copy the complete non-test root package and license, then rebase and review
   the narrow `rndevtools.1` patch set. Regenerate the deterministic patch artifact.
4. Regenerate `VENDORED_SOURCE_SHA256SUMS`; update the hard-coded clean-base,
   patch, and final-manifest digests together in the build/trust contracts.
5. Update `go.mod`, `vendor/modules.txt`, catalog/checkpoint provenance,
   package manifests, notices, and protocol fixtures to the same identities.
6. Audit labels, restore-only services, shared categories, targeting,
   boot-state restoration, cleanup confinement, clone sanitation, and launchd
   verification.
7. Run formatting, unit/race tests, vet, vendored `govulncheck`, TypeScript
   contract tests, both-architecture builds, signature/hash checks, and
   packaged cold start.
8. Run preview/apply/verify/failure/rollback/undo/restore/clone/cleanup against
   disposable Simulators. Only that evidence may add an exact verified or
   limited tuple. iOS below 18.5 remains hard-blocked.

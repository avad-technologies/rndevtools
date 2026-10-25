# Per-worktree local Supabase: as built

> **Status:** implemented on 2026-10-17 against Supabase CLI 2.121.0, uncommitted. It ships every phase of [UI.md](UI.md) (P0 to P5, so no control, operation or CLI command is gated by phase) and the opt-in Phase 6 hardening toggles.
> **Read with:** [DESIGN.md](DESIGN.md) (the backend design), [UI.md](UI.md) (the tab specification) and [FINDINGS.md](FINDINGS.md) (measurements). This file records what shipped, where it lives, how it was verified and where it departs from those two documents.

## What it does

- **The Supabase tab** (Simulator workspace, Backend group, ⌘8; Settings moved to ⌘9):
  - lists every native local stack on the Mac, with the agent session, lane, Simulator and worktree/branch it belongs to;
  - starts, stops, restarts, resets, migrates, inspects (services, database, redacted logs), copies values and exports;
  - cleans up stacks;
  - views: Stacks, Repositories and Requests, plus Settings behind the gear.
- **Lanes** start or resume their worktree's stack while the Simulator boots, and give Metro only the API URL and publishable key, under the policy's variable names.
- **Agents** use `rndevtools supabase --operation up|down|ls|status|env|reset|log|destroy` or the `supabase` MCP tool:
  - `rndevtools setup` installs the `rndevtools-supabase` skill and a hook that steers hand-run lifecycle commands to it;
  - destroying, or resetting a stack another session holds, becomes a request the user approves.
- **Other panels** show a lane's stack:
  - Lanes: a backend chip, a Backend start field and a Backend section;
  - Fleet: a With backend filter;
  - Agents view: the backends each session holds;
  - Network, Diagnostics and Environment: the app's actual backend, compared with its lane's stack (P5).

## Where it lives

| Area | Files |
|---|---|
| Contract | `src/shared/supabase-protocol.ts` (state, operations, availability rules, copy), `supabase-traffic.ts` (P5 classifier), `supabase-demo-data.ts` (demo set A and reducer); lane and agent wire additions in `lane-protocol.ts` and `agent-cli-protocol.ts` |
| CLI adapter | `src/main/supabase/` `dialect.ts`, `cli-resolver.ts`, `cli-runner.ts`, `cli-contract.ts`, `cli-errors.ts`, `cli-redact.ts`, plus 40 captured 2.121.0 fixtures in `__fixtures__/supabase-2.121.0/` |
| Discovery | `discovery.ts` (owners, port registry, SysV, disk), `project.ts`, `static-config.ts`, `git-head.ts`, `identity.ts`, `bounded-read.ts` |
| Stores and rules | `policy-store.ts`, `stack-store.ts`, `job-store.ts`, `holds.ts`, `admission.ts`, `gc.ts`, `repositories.ts`, `state-assembly.ts` |
| Orchestrator | `supabase-service.ts` (live engine or demo), `service-engine.ts`, `service-operations.ts`, `service-confirmation.ts`, `lane-backend.ts`, `agent-operations.ts`, `branch-follow.ts`, `cli-drift.ts`, `hardening.ts`, `steering-writer.ts`, `demo-service.ts`, `engine-support.ts` |
| Main wiring | `src/main/supabase-ipc.ts` (IPC, interest, confirmation tokens), `security.ts` (dialog text, loopback URLs), `index.ts` |
| Renderer | `state/supabase-runtime.tsx`, `simulator/supabase-model.ts`, `components/supabase-ui.tsx`, `panels/simulator/supabase-*.tsx`; cross-panel in `simulator/supabase-cross-panel.ts`, `simulator/app-traffic-model.ts`, `lib/app-traffic.ts` |
| Agent CLI (Go) | `native/rndevtools-cli`: the `supabase` command and MCP tool, `rndevtools://supabase`, `setup/steering.go`, `setup/hook_supabase.go`, the `rndevtools-supabase` skill |
| Packages | `@rndevtools/core` redaction (`sb_secret_`, URL passwords); `@rndevtools/react-native` `rndevtools-verify-bundle --forbid-loopback-urls` and `--preset supabase-local` |
| Example | `examples/expo-demo/supabase/` (config, a migration and a seed) |

## Try it

1. Build with the Simulator helpers: `pnpm --filter @rndevtools/desktop dev:simulator`.
2. In a repository you track in Lanes, commit a `supabase/config.toml` like the Expo example's. It sets `[experimental] stack = true`, pins no ports, and turns Studio and analytics off.
3. Pin `supabase` as an exact devDependency (`2.121.0`).
4. Open the Supabase tab and choose Turn on local Supabase. That runs the confirmation once; nothing is probed or spawned before it.
5. Start a lane on a development worktree. Its stack starts alongside the Simulator, and the tab shows the lane, Simulator and branch on the stack's row.
6. Agents: rebuild the CLI and run `rndevtools setup` again so the new skill and hook are installed.

Demo mode (`RNDEVTOOLS_DEMO=true`, unpackaged) serves demo set A from memory, including Services for the inspected stack.

## Verification

All checks below ran on 2026-10-17.

**Unit tests and quality gates:**
- `pnpm --filter @rndevtools/desktop quality`: lint, typecheck, knip (unused exports and cycles), 1,827 unit tests and the build all pass. The 144 Biome warnings are the existing `noDescendingSpecificity` baseline in `styles.css`.
- `@rndevtools/core` and `@rndevtools/react-native` quality pass (687 and 60 tests), and so does the Expo example's.

**Real CLI** (2.121.0 binary, scratch `SUPABASE_HOME`, run outside the sandbox):
- The adapter suite passes 8/8 and the service suite 8/8.
- Each run left 0 owner processes and 0 port reservations. The service suite now fails if a stack it created is left behind.

**Go agent CLI:**
- `gofmt`, `go vet` and `go test -race ./...` pass, with the agent environment set and cleared.
- `go list -m all` is still the module alone.
- govulncheck is not installed here, so it did not run.

**Electron e2e:**
- 78 tests pass, among them `simulator-supabase.e2e.ts`. It walks the tab in demo mode, checks Services for the inspected stack and checks for horizontal overflow at 1040×700, including inside the virtual list. It also turns the feature off and on again.
- `device-verify.e2e.ts` (17 tests) failed at its first test and the rest didn't run. It targeted one specific consuming app on a Simulator connected to the default broker port, so it has since been removed.
- A screenshot pass at 1040×700, 1220×800 and 1440×900 found two problems, both now fixed:
  - an 8 px horizontal scrollbar in every virtualized dense list;
  - metric cards that wrapped at 1040.

## Changes from DESIGN.md and UI.md

**Naming.** Everything says Supabase, not backend. That covers:
- the tool id `supabase`;
- the agent CLI kind and MCP tool `supabase`;
- the resource `rndevtools://supabase`;
- the skill `rndevtools-supabase`;
- `--stack-id` instead of `--backend-id`;
- job ids `supabase-job-<uuid>`;
- modules under `src/main/supabase/`.

The consuming app's variable names stay options (default `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`). The root AGENTS.md rule now says that integrated third-party tools may be named in source and the app's own conventions may not.

**Lifecycle:**
- A start or resume job completes only after `stack list` shows the stack and its status has been read again. Until then a new stack still read as "not created" just after it started.
- `stack list` refreshes are single-flight but never stale: a caller that arrives during a list shares one list queued behind it (`SupabaseSingleFlight.runFresh`). A stop followed at once by a destroy therefore sees the stop.
- An owner on another CLI release is stopped and restarted with the worktree's CLI when something ensures it, instead of being refused.
- A drift restart is gated on HEAD and tried once per drift signature.
- Cancelling a running create marks the stack interrupted (destroy and start again). A queued create is cancelled without running the CLI.
- Follows run as the new branch's create or resume job; there is no separate `follow` job yet.
- Exposure fails closed: if the owner can't be found after a start, the stack is stopped and the start fails.

**Branch follow:**
- Automatic follow keeps the 30 s stable-HEAD debounce and the git-operation markers.
- The explicit Follow branch action (UI.md P5) and an agent's `up` follow at once. A rebase, merge, cherry-pick, revert or bisect in progress still blocks them.

**Lanes:**
- Pinned-port leases reach the CLI through a runner option, `leasedPorts`; the runner still refuses port names in `overrides`.
- A lane's Simulator now warns `previous-session-on-simulator` when it last ran against another stack. Each stack record lists the Simulators it last served (`servedSimulators`), and each Simulator appears on one record only. The renderer shows the carried-over sign-in banner on that warning.
- Lane worktrees carry their Supabase project (`LaneWorktree.supabase`: managed, observed with main's reason, or none, and pinned ports). The start form prefers that over matching main's home-relative path labels, and keeps the label match as a fallback.

**Agents:**
- The Codex MCP block sets `tool_timeout_sec = 240`.
- CLI deadlines: `up` waits wait-ms + 15 s, `reset` 75 s, everything else 45 s.
- The desktop budgets stay under those: destroy and down 40 s, reset 60 s.
- Session-end hooks forward the session's cwd, so a session's own release doesn't leave its cwd keeping the stack running.

**Tab UI:**
- Supabase-specific `SupabaseNotice` and `SupabaseControlButton` primitives. `PanelNotice` can't hold inline recovery buttons or the "+N more" toggle.
- Database and Logs reads run only when their section opens, on Refresh or from a deep link, and are cached per stack in the Stacks view.
- Reset lives in the Danger zone, and Studio controls appear in both Services and Connect.
- Trust-changing switches act at once through main's dialog; other policy fields use Apply, with field errors.
- At 1080 px and below, the metric details stay on one line and are cut with an ellipsis; the full text is the tooltip. That keeps five 64 px rows visible at 1040×700 outside demo mode. Between 1081 and 1220 px the toolbar's "N matching · M selected" wraps to its own line.
- Open lane and Open in Agents use the Lanes focus intent, `focusLane(laneId | {view: 'agents', sessionKey})`. Fleet's Open in Lanes now lands on its own lane too.
- The Overview's App traffic row (P5) shows the verdict, the request count and when the last request was seen, from the connected app on one of the stack's lanes' Simulators. Show traffic selects that app, sets a one-shot Network filter and opens Network.
- Track repository… failures show as the lane runtime's notice, which the Supabase tab now displays.
- The Network filter intent lives in `lib/app-traffic.ts`, not in the desktop runtime.

**Inspection:**
- Sleeping services carry measured wake hints: REST 0.4 s, Auth 0.8 s, Storage 1.4 s, Realtime 2.6 s, Functions 0.6 s, Studio 18 s.
- Endpoints are keyed `service.endpoint`, as the CLI reports them.

**Example:** the Expo example doesn't add the `supabase` devDependency, because `minimumReleaseAge` would block 2.121.0 for now. Its README says how to add it.

**Post-review fixes (2026-10-17).** After the build, the fixes from a repo-wide review changed seven Supabase engine behaviours: when a needs-recreate stack is tried again and how long it keeps what it can't adopt, which ensures share a flight, what a turn-off calls off, stops and forgets and when Turn on works again, retries of a failed branch follow, the destroy budget, progress-file cleanup and the adoption of surviving CLI children. DESIGN.md's [as-built notes](DESIGN.md#as-built-notes) list what each one now does.

## CLI behaviour found while building

These are in addition to FINDINGS.md:
- `stack destroy` leaves an empty `$SUPABASE_HOME/stacks/<id>/data/` directory. Discovery lists stacks through the CLI and measures disk only for listed ids, so these never show up as stacks.
- `stack list --output-format json` reports `owner: "unavailable"` for stopped stacks. Their port reservations persist until destroy.

## Known gaps and follow-ups

**Coverage and checks:**
- The cross-panel UI has no e2e yet: the Lanes Backend field, Fleet's With backend filter, Agents backends and the traffic banner. It needs demo lanes that carry backend summaries.
- govulncheck has not run on the Go CLI here (it is standard library only).

**Lifecycle:**
- An outer `follow` job, so a follow shows as one job.
- Batched job-store writes for detached lifecycle calls.
- Pinned-port leases for starts agents run themselves (doctor warns for now).

**Calibration and UI:**
- Calibrate the memory estimate, and the wake hints for other Macs.
- Consider moving the per-stack read cache into `SupabaseRuntimeProvider`, so it survives view switches.

**Existing, not introduced here:**
- The shared `SearchControl` draws a second focus rectangle inside the field.
- `.sim-detail-heading > div > span` styles state pills in other panels' headings as subtitle lines.
- A quoted `simctl boot` outside a heredoc still trips the hook's text match.

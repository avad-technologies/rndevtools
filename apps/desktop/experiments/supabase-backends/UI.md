# Supabase tab: UI specification

> **Status:** implemented on 2026-10-17 (P0 to P5, plus the Phase 6 toggles). [IMPLEMENTATION.md](IMPLEMENTATION.md) lists the deviations from this spec.
> **Inputs:** three competing designs, two judges, and a completeness critic, checked against the working tree on 2026-10-17. See [DESIGN.md](DESIGN.md) (backend) and [FINDINGS.md](FINDINGS.md) (measurements).
> **Mockup:** [mockup/supabase-tab.html](mockup/supabase-tab.html), with 31 frames at 1040×700 and wide sizes.

## Supabase tab: final UI specification (native list/detail, attribution chain, phased P1 to P5)

The base is native list/detail on the Lanes and Fleet console contract, which both judges ranked first (82.0 and 83.75). It has been corrected against code already in the working tree: the Supabase dialect, the error classifier and the shell plumbing. Two ideas are grafted in. From the topology design: the holder chain and the "what happens next" timeline. From the inbox design: one attention ranker, and native dialogs for trust changes. It adds no HeroUI CSS imports, no table mode and no tabs. The first shippable slice is a read-only observer.

**Placement.** A Simulator-workspace tool, **Supabase**:
- id `supabase`, icon lucide `DatabaseZap`, shortcut ⌘8;
- Settings moves to ⌘9 (precedent: commit 138d3a7);
- it sits in a new config-driven **Backend** sidebar group.

It tracks every local stack and shows, for each one, the agent session, lane, Simulator and worktree/branch it is attached to.

**Layout (the existing contract):**
1. Header: Refresh, Clean up N (P4), a settings gear.
2. At most 2 ranked notices, with an inline "+N more" toggle.
3. Four metrics: Running, Postgres slots, Memory, Disk.
4. Toolbar: a Stacks | Repositories | Requests N toggle, search, a filter with counts, Select multiple.
5. The unchanged `.sim-fleet-layout`: 64 px two-line rows on the left, the detail on the right.
6. An activity Disclosure.

Five rows stay visible at 1040x700.

**Detail pane:**
- A heading, then a state-dependent action row of at most 4 buttons.
- Typed notices with one recovery each. Their title and recovery text come from main's ClassifiedSupabaseError.
- Disclosures:
  - Overview: a "Who holds this" chain (Agent › Lane › Simulator › Worktree › Stack) on HeroUI Pro Timeline, "What happens next" from a pure nextEvents(), and the stack's facts.
  - Services, in the CLI's own words.
  - Database, read when opened.
  - Logs, history only.
  - Connect.
  - Danger zone.

**Safety rules:**
- Main-owned native dialogs guard destroy, clean up, reset, recreate, Studio, stopping an external stack, turning the feature on, turning it off while stacks run, and two trust policies. Cancel is the default; tokens are single-use and last 60 s; the uploads checkbox comes back in the confirmation result.
- ConfirmAction is used only to interrupt a live agent, and never in front of a native dialog.
- Every start of a stopped stack, and every database mutation, needs the worktree on the stack's branch.
- Destroy runs only on stopped stacks with no running lane.
- Unreadable stacks are never destroyable.
- Agent free text never appears in a dialog, and secrets never reach the renderer.

**Phases** follow the CLI rollout order (every phase has shipped, so none gates anything now):
- P1: read-only (list, status, log history, database reads).
- P3: lifecycle, policy, and the Lanes, Fleet and Agents chips.
- P4: destroy, clean up, agent requests, release.
- P5: database mutations, Studio, branch follow, recreate, logs auto-refresh, app traffic, capacity-parked starts, paths.

Controls from a later phase are absent in earlier ones, not disabled.

## Decisions

### Base design

**Choice.** native-list-detail, with corrections and grafts

**Why.** Both judges ranked it first. It fits the renderer best, has the strictest destroy friction, needs no CSS import and fits 1040x700.

### Tool identity

**Choice.** id supabase, label Supabase, DatabaseZap icon, Simulator workspace, Backend group, ⌘8; Settings moves to ⌘9

**Why.** The brief already decided this. DatabaseZap avoids clashing with connected Storage's Database icon, commit 138d3a7 set the precedent for moving Settings, and ⌘0 belongs to Electron.

### Layout

**Choice.** Keep .sim-fleet-layout unchanged with 64 px DenseVirtualList rows; no table mode, no tabs, no inbox region

**Why.** 64 px matches Fleet. A table mode or tabs would add a second rendering surface and a CSS import. An inbox region would cost about 145 px at 700 px.

### Detail structure

**Choice.** Disclosures, with Database and Logs read only when opened

**Why.** Native details/summary keyboard behaviour, no tabs.css, and reads are tied to what is on screen.

### Attribution

**Choice.** A Who holds this chain on Timeline plus What happens next from nextEvents(); row line 2 carries labelled ports; no buttons inside rows

**Why.** Operator-ux graft. Nested interactive rows have no precedent here and risk GridList focus bugs.

### Requests surfacing

**Choice.** A ranked tab notice and a Requests view, with no strip inside the list

**Why.** Keeps five rows visible at 700 px.

### Notices

**Choice.** attentionItems() ranking, at most 2 notices, an inline +N toggle; never tone=info for must-read text

**Why.** Vertical budget (R8); tone=info collapses its body into a popover (ui.tsx:110-117).

### Settings location

**Choice.** An in-tab Settings view behind the gear, plus one link row in global Settings

**Why.** The hash router can't deep-link to a section of global Settings.

### Confirmation tiers

**Choice.** Native dialog plus token for destroy, clean up, reset, recreate, turn on, turn off with running stacks, Studio, external stop and the trust policies. ConfirmAction for every interruption of a live agent, never stacked in front of a native dialog.

**Why.** Applies DESIGN's rule. Using ConfirmAction for every live-agent interruption gives the same friction for the same consequence; the maintainer may narrow it to Stop only.

### Dialog defaults

**Choice.** Cancel is button 0 and the default in every dialog, including Turn off

**Why.** Return and Esc always cancel (index.ts:356-357). This overrides DESIGN's Leave running default.

### Destroying a stack a live agent holds

**Choice.** One dialog with a graduated title and the verb Destroy anyway

**Why.** A second identical dialog adds habituation, not information.

### Reset UI

**Choice.** Two buttons: Reset to migrations + seed… and Reset without seed…

**Why.** Each binds one exact op; only destroy needs checkboxLabel.

### HEAD gate

**Choice.** Every start of a stopped stack by --stack-id, and every database mutation, needs HEAD == branch_context; Restart services stays allowed

**Why.** start/SIDE_EFFECTS.md: start reloads the checkout's config. restart uses saved configuration.

### Destroy preconditions

**Choice.** Stopped, no running lane, not in flight, not unreadable, present in a fresh list; an approved agent request stops then destroys

**Why.** Refuse to delete what is in use (prior art); dialect limit of 32 ids per call.

### Unreadable stacks

**Choice.** Never selectable; Reveal in Finder only; correct main's recovery copy

**Why.** destroy/SIDE_EFFECTS.md:97-104: the CLI fails on undecodable state, and the desktop never deletes stack folders.

### Logs

**Choice.** History in P1; no live follow; P5 auto-refresh through --since

**Why.** The dialect never builds --follow and requires --output-format json exactly once (dialect.ts:15-19, 1150).

### Database tools

**Choice.** Reads in P1 (the read-only kinds); moved-branch stats through the DB_URL main holds; mutations --local only in P5; no Copy TypeScript types

**Why.** dialect.ts readTarget and READ_ONLY_KINDS; gen types has no dialect operation (dialect.ts:256-326).

### Phases

**Choice.** Aligned with the CLI rollout order; controls from later phases were absent, not disabled. Every phase has shipped, so nothing is gated by phase now

**Why.** Engineering judge; avoids dead controls.

### Error copy

**Choice.** Render main's ClassifiedSupabaseError and map each of its 17 codes to one action

**Why.** Avoids a parallel copy table (cli-errors.ts:20-38, 365-462).

### Availability order

**Choice.** bridge, off, platform, in flight, mode or CLI gate, release mismatch, HEAD, exposure, holder, capacity, state

**Why.** One pure function with a fixed order. In-flight comes early because it is the most actionable temporary reason.

### Tone scales

**Choice.** Absolute stackStatus() in the tab and a lane-relative chip elsewhere; blue only for in-flight

**Why.** Critic C4; also fixes .sim-state-pill.is-info.

### Lane defaults

**Choice.** A policy field laneDefaults per environment (Auto | Off); Required stays a per-lane-start choice

**Why.** Lane environments are fixed at construction with no edit op (lane-store.ts:230).

### Capacity-parked starts

**Choice.** P5, as a new request kind; until then the start is refused with recovery text and the chip db skipped · capacity

**Why.** DESIGN.md:1590 refuses today.

### Off state

**Choice.** No Check repositories while off; show only the platform verdict

**Why.** Keeps off meaning off and the zero-calls test simple.

### Shell plumbing and HeroUI

**Choice.** Reuse the working tree's PanelErrorBoundary, action-notice and shortcut-range code; Timeline for StepList and the chain; NativeSelect wrapped so one new module imports @heroui-pro

**Why.** Avoids re-planning existing code. Stepper has no failed status (stepper.d.ts:3).

### Command words

**Choice.** The renderer never hard-codes Supabase CLI words; command text, runner and snippets come from main

**Why.** Keeps the alpha contained in one module.

## Information architecture

### Placement
- **Tool entry** (simulator-config.ts:13-96):
  - `{id:'supabase', label:'Supabase', icon:DatabaseZap, shortcut:8, group:'backend'}`.
  - Settings becomes shortcut 9 with group 'system'; every other tool gets group 'simulator'.
- **Panel registration:** a lazy SupabasePanel plus an entry in SIMULATOR_PANELS (app.tsx:177-218).
- **Route:** `#simulator/supabase` only, because routeFromHash reads two segments (app.tsx:231-252).
- **Error boundary:** reuse the existing PanelErrorBoundary inside SimulatorToolPanel (app.tsx:1130-1143; error-boundary.tsx:56-106). It shows "Supabase could not render" with [Open Simulators].

### Sidebar and shell
- **Groups:** render SIMULATOR (⌘1-7), BACKEND (Supabase ⌘8) and SYSTEM (Settings ⌘9) from `group`.
  - This replaces the coreTools split and the hard-coded Settings item (app.tsx:812-891).
  - Keep exactly one .tool-nav-item per tool, and keep Settings' amber capability count (app.tsx:888-891).
- **Badge:** simulatorCount (app.tsx:936-947) becomes `simulatorBadge(tool, ctx) → {value, tone, label} | undefined`.
  - Red (a new `.tool-count.is-danger`) for any danger item.
  - Amber for request or warning items.
  - Otherwise a grey count of running stacks.
  - No badge while off, unsupported, not live, or anywhere in P1.
- **Footer hint:** already derived (app.tsx:227, lib/shell-navigation.ts:23-36); it reads 1–9.
- **Xcode onboarding banner:** skip it for this tool (app.tsx:1061).
- **ActionNotice routing:**
  - Add 'supabase' to ActionNoticeRuntime (lib/action-notice.ts:22-27) and a noticeSources entry (app.tsx:282-293).
  - SIMULATOR_TOOL_NOTICES becomes: supabase ['supabase'], lanes ['lanes','supabase'], fleet ['simulator','lanes','supabase'] (lib/action-notice.ts:41-49).
- **Titlebar:** the Jobs metric adds Supabase jobs from P3.

### Panel skeleton (top to bottom)
1. `section.panel-root`.
2. **PanelHeader:**
   - h1 Supabase;
   - an About popover;
   - meta: [Alpha] plus counts, or "Off", "Not available on this Mac", "Settings";
   - actions: [Refresh] (P1), [Clean up N] (P4), [Gear] (aria-pressed, P1).
3. **Notices:** at most 2 PanelNotices from supabaseNotices(), the tab-level slice of attentionItems().
   - Ranking: danger, then requests, then warnings.
   - Extra notices sit behind a "+N more notice(s)" toggle at the end of the last notice (aria-expanded, expands inline).
   - Never use tone=info for must-read text.
4. **.sim-metric-grid:** Running n/cap · Postgres slots used/limit · Memory (RSS measured, or an estimate) · Disk (stacks plus cache).
5. **Toolbar:**
   - fieldset.sim-layout-toggle: [Stacks|Repositories], plus [Requests N] from P4;
   - search;
   - filter NativeSelect with counts;
   - [Select multiple] (P3, Stacks view only);
   - the meta "N matching · M selected", hidden at 1080 px and below.
6. **Body.**
7. **"Supabase activity · N running" Disclosure:** only while jobs exist (fleet-panel.tsx:675-721).

### Views
- **Stacks:** the unchanged .sim-fleet-layout.
  - List: DenseVirtualList with rowHeight 64. Rows only select.
  - **Rank:** needs attention, then in flight, then running with a lane, running and held, running unheld (soonest auto-stop first), stopped (most recent first), prune-suggested, and finally not created.
  - **Selection:** when the selection disappears, the first row is auto-selected (lanes-panel.tsx:125-129).
  - **Transient stacks:** supabase-shadow-* stacks are shown only under the Transient filter.
  - **No rows:** the detail shows Getting started, a readiness summary per repository.
- **Repositories (P1):** the same grid.
  - Rows: tracked repositories from Lanes, each with a readiness word.
  - Detail: ReadinessRow checks with copy-only fixes, worktrees with links to their stacks, and [Re-check].
  - P3 adds Use local Supabase here (Auto|Off) and Pre-download services.
  - Toolbar: [Track repository…], which reuses lane.add-repository.
- **Requests (P4):** a full-width column (max 820 px) with Agent requests (RequestCards), then Clean up (PruneSection). The header's Clean up button opens this view and focuses the Clean up heading.
- **Settings (gear):** .sim-settings-scroll > .sim-settings-layout replaces the metrics, toolbar and body. Pressing the gear again returns to the previous view. Global Settings gets one link row.

### Stack detail (.sim-target-detail, max 820 px)
- **Heading:**
  - eyebrow "Supabase stack";
  - h2 with the branch (refs/heads/ stripped; "detached HEAD" when detached);
  - shortPath(worktree) · truncateMiddle(id);
  - StackStatePill plus an origin Badge: Managed, Adopted, External, Observed or Not created.
- **Action row (P3+, at most 4 buttons):**
  - running managed: Stop, Restart services, Keep running/Unpin, Open lane;
  - stopped: Resume, Open lane;
  - not created or never started: Start;
  - failed: Try again, Open logs;
  - external native: Adopt, Stop…;
  - external Docker: Stop…;
  - creating or starting: Cancel start….
  - Each disabled control gets a visible DisabledReason line under the row.
- **Notices:** typed attention notices under the heading.
- **Disclosures:** open state is kept in the provider per stack.
  - Overview: open.
  - Services: open while running.
  - Database: closed; reads when opened.
  - Logs: closed; reads when opened.
  - Connect: open while running.
  - Danger zone: closed (P4/P5).
- **Batch mode:** a SelectionSummary replaces the detail.

### Navigation
- **Provider state:** view, filter, query, selected stack, selected repository, batch ids (at most 20), open sections, notices expanded, and the view to return to from Settings. The view and filter persist to localStorage (rndevtools.desktop.supabase.*).
- **Into the tab:** openInSupabase({stackId?, repositoryId?, view?, section?}) sets that state, then sets window.location.hash = 'simulator/supabase' (lanes-panel.tsx:442 pattern). Unknown ids fall back to the first ranked row.
- **Out of the tab:**
  - Open lane: lanes.focusLane(laneId), then simulator/lanes. This new intent also fixes Fleet's Open in Lanes (fleet-panel.tsx:648-650).
  - Open in Agents: lanes.focusLane({view:'agents', sessionKey}).
  - Open in Simulators: setSelectedDeviceUdid, then simulator/fleet.
  - Show traffic (P5): desktop.setSelectedDeviceId plus a Network filter intent, then connected/network.

### Availability
One pure function, supabaseActionAvailability(row, op, ctx) → {allowed, reason}, decides every control. It checks in a fixed order and returns the first failing check:
1. bridge;
2. feature off;
3. platform;
4. in flight;
5. mode / CLI gate;
6. release mismatch;
7. HEAD gate;
8. exposure;
9. holder (pinned, running lane attached);
10. capacity;
11. state.

Common reason strings:
- Supabase controls need the secure desktop bridge. Open the packaged RN Devtools app.
- Turn on local Supabase first.
- Needs Apple silicon and macOS 14 or later.
- Another operation is running on this stack.
- Observed only: <reason from main>.

### CLI conventions (used in every cli field)
- **Binary (`<bin>`):** the stack worktree's validated binary, resolved by cli-resolver.
  - "any validated `<bin>`" means stop and destroy work across releases.
  - "owner `<bin>`" means the owner's own release.
- **Placeholders:**
  - `<root>`: the realpath of the Supabase project root.
  - `<id>`: the full 64-hex id from a fresh stack list.
  - `<excl>`: the policy exclusions, default studio,analytics; passed on every start and resume, and omitted when empty.
- **Process rules:**
  - Every argv ends with `--output-format json` and runs with shell:false.
  - Curated env: PATH, HOME, USER, LOGNAME, TMPDIR, LANG, LC_ALL, SUPABASE_EXPERIMENTAL_STACK=1, SUPABASE_TELEMETRY_DISABLED=1, DO_NOT_TRACK=1, SUPABASE_NO_UPDATE_NOTIFIER=1.
  - The cwd is a neutral 0700 directory.
  - Every argv passes assertSupabaseArgvAllowed (dialect.ts); the resolver's version probe runs read-only.
- **Never emitted:** --runtime auto|docker|podman, stop --all, --stack <name>, id prefixes, status --env, --eager, --dry-run, --debug, --follow, --db-url on any mutation, and --yes outside a token-consuming destroy.
- **CLI command words** (status and inspect command text, the runner, config snippets) come from main state. They are never renderer literals.

## Status model

**A. Absolute stack status** (`stackStatus()` in shared/supabase-protocol.ts; used by tab rows, the pill and metrics)

Label precedence, highest first:
1. in-flight job
2. LAN-exposed or exposure unknown
3. failed, interrupted or needs recreate
4. unhealthy
5. unreadable
6. CLI mismatch
7. not responding
8. partly stopped
9. running or running · idle
10. stopped outside
11. stopped
12. never started
13. not created
14. checking

| Signal(s) | Label | Tone | Icon | Explanation |
|---|---|---|---|---|
| desktop job | Creating… / Starting… / Stopping… / Restarting… / Destroying… / Resetting… / Migrating… / Downloading… | info | LoaderCircle (static when reduced motion) | The operation in flight; health keeps its last value |
| owner reachable; DB running and healthy; all members running | Running | success | StatusDot | All services awake |
| as above, with ≥1 lazy member sleeping | Running · idle | success | StatusDot + Moon | Other services start on first request |
| member unhealthy or exited | Unhealthy | danger | CircleX | Names the service; Restart services |
| a member stopped while the DB runs | Partly stopped | warning | CircleAlert | Stop and start; data kept |
| owner unavailable, no owner argv | Stopped | default | Square | Data and ports kept; resumes in about 1 s |
| stopped outside RN Devtools while held | Stopped outside | warning | Square | A holder still needs it |
| owner argv alive for less than 30 s, no desktop job | Starting (outside) | info | LoaderCircle | Someone else is starting it |
| owner argv alive for 30 s or more, identity checks time out | Not responding | warning | ServerOff | Stop asks it to shut down |
| owner reachable; every service reports the release error | CLI mismatch | warning | GitCompareArrows | Stop, destroy and logs work; DB tools don't |
| registered with an empty composition | Never started / Failed to start | default / danger | CircleDashed / CircleX | Prepared, or the first start failed |
| interrupted or needs recreate | Interrupted / Needs recreate | danger | CircleX | Destroy and start again / recreate |
| runtime docker or podman; lsof failed | LAN-exposed / Exposure unknown | danger | ShieldAlert | Stopped once; never attached |
| unreadable | Unreadable | warning | CircleAlert | Never destroyed here |
| origin expected | Not created | default | hollow dot | Start creates it (about 5 s) |
| unknown | Checking… | default | RefreshCw (static) | Re-reading |

Never show Running from `stack list` owner=reachable alone.

**B. Flags** (line 2 shows at most 2, then "+N"; Worktree deleted, Stale branch and LAN-exposed always show)
- Worktree deleted: FolderX, warning.
- Stale branch: GitBranch, warning.
- Studio back on: Layers, warning, ranked first among warnings.
- Config changed: FileDiff, warning.
- All warning: Ports pinned, config.json conflict, CLI unverified / changed / missing, Env shadowed, Other Supabase home, Id mismatch.
- Not opted in: Eye, default.
- Transient: hidden behind its filter.

**C. Holders and timers**
- Badges, all in the default tone: Managed, Adopted, External, Observed.
- Agent holders: the AgentGlyph carries the only agent hue, e.g. "Claude 9b1e2c00 · live" or "Codex · by worktree". A desktop-started lane reads "You · lane :8102".
- Pinned: Pin icon, default, "You · pinned · never stopped automatically".
- Auto-stop countdown: amber Timer, e.g. "Stops in 45 s · data kept" or "gone · stops in 7 min".
- Cwd keeper: default.
- Clocks paused: info, CirclePause.
- Prune suggestion: muted CalendarClock, "Prune suggested Oct 31 · never automatic". It never ticks.

**D. Service rows** use CLI words and CLI tone buckets:
| CLI state | Tone | Icon |
|---|---|---|
| running · healthy | success | — |
| starting, stopping, running without health | info | — |
| sleeping · starts on first request | default | static Moon |
| stopped, unavailable, excluded | default | — |
| unhealthy, exited | danger | — |

**E. Lane-relative chip** (`laneBackendChip()`, used in Lanes, Fleet and Agents)
| Chip | Tone |
|---|---|
| db :21734 | success |
| db starting, db stopped, db stale, db shadowed, db blocked · ports pinned, db skipped · capacity | warning (the app has no database) |
| db refused · LAN | danger |

The chip is hidden when the feature is off.

**F. App traffic (P5)**
| Verdict | Tone |
|---|---|
| uses this stack | success |
| other stack, hosted, remote, unknown local, mixed | warning |
| legacy :54321 | danger |
| no app traffic seen, app not linked | default; never shown as OK |

**G. Readiness, metrics and badge**
- Check pills: READY success; NEEDS FIX and CHECK warning; OPTIONAL and CHECKING default.
- CLI gate: verified success; compatible, unsupported and missing warning.
- Metric warnings: Running at the cap; Postgres slots below 4 free; Memory when pressure is critical. No info or danger metric tones.
- Sidebar badge: red for danger, amber for requests or warnings, otherwise a grey running count, and nothing while off.

## States

Loading
- Metrics show "—" over Skeletons.
- The list shows 3 Skeleton rows with aria-busy.
- The detail shows "Select a stack to inspect".

Empty
- "No stacks yet. Start a lane on a worktree whose repository opts in, or let an agent run rndevtools backend --operation up. Stacks started outside RN Devtools show up here too."
- The detail shows Getting started: readiness per repository.

Filter empty
- "No stacks match these filters. Try another branch, port or agent." [Clear filters]

Off
- Meta: Off. Metrics show "—" with "off" or "checked when on". The toggle offers Stacks|Repositories.
- Stacks shows the EmptyPanel "Local Supabase is off" with the purpose paragraph. P1 variant: "RN Devtools lists the local Supabase stacks on this Mac and the lane, Simulator and agent each belongs to."
- It also shows the platform verdict and [Turn on local Supabase…].
- Repositories: "Turn on local Supabase to check repositories. Nothing is read while it is off."

Unsupported
- Meta: Not available on this Mac.
- Warning: "Native Supabase needs Apple silicon and macOS 14 or later. This Mac: <arch>, macOS <version>."
- Metrics show "—". No toolbar or gear; nothing is probed.

Bridge missing
- Warning: "Supabase controls need the secure desktop bridge. Open the packaged RN Devtools app."

Policy quarantined
- Danger: "Supabase settings couldn't be read, so local Supabase was turned off. The file was set aside and defaults restored. Running stacks were left as they are." [Open settings]

State unreadable
- Danger: "Supabase state could not be read." [Retry]
- The last state is kept with its checked time.

Panel crash
- The existing PanelErrorBoundary: "Supabase could not render" [Open Simulators]

Observed-only
- "Observed only: <reason>. RN Devtools lists this stack and can stop or destroy it, but won't start it or change its database." [Review repository]

Partial
- "Some services stopped outside the normal idle cycle. Stop and start brings them back; data is kept."

CLI mismatch
- Main's title, plus both releases.
- "Stop, Destroy and log history still work; database tools and status don't. Data is kept." [Stop] [Restart with this CLI]

Owner not responding
- "Its owner runs but didn't answer in 2 s; agents' local commands fail. Stop asks it to shut down." [Stop]

Never started / failed first start / interrupted
- "Prepared, but never started." [Start]
- "The first start failed and left an empty stack." [Try again] [Destroy…]
- "A first start stopped midway can't be resumed." [Destroy and start again…]

LAN-exposed
- Tab danger: "N stacks listen on your network. They run on Docker; RN Devtools stopped them once." [Show them]
- Detail: [Stop…] [Destroy…]. Nothing is deleted if Docker doesn't answer.

Exposure unknown
- "Couldn't verify it listens only on this Mac, so it was stopped." [Resume] checks again.

Orphaned
- "Its worktree was deleted. RN Devtools stopped it at once. Destroy it to free 64 MB and 10 ports; its uploads went with the worktree."
- Preselected in Clean up.

Stale branch
- "The worktree moved to <new>. Agents' local commands now reach that branch's stack. This one keeps its data; switching back reattaches it."
- Resume and database changes stay off until then.
- P5 adds Follow, or "Following <new> in 22 s".

Drift
- "Studio is back on. A start without exclusions re-enabled it; its SQL endpoint has no authentication while it runs." [Re-apply exclusions]
- "Config changed since this stack started: <paths>." [Stop and start to apply]

Capacity full
- Running "12 / 12" in warning, with "next to stop: <branch>" or "all held".
- Notice: "12 of 12 stacks are running and all are in use." [Show running stacks]
- Start is disabled with the capacity reason.
- P5 adds parked requests.

Needs recreate (P5)
- A stack_changes table: key · saved → requested · editable. [Destroy and recreate…]

Unreadable
- "Stack state cannot be read. This CLI can't decode it (another CLI release may have saved it). RN Devtools never deletes stack folders." [Reveal in Finder]

Discovery unavailable
- "Auto-stop paused: agent sessions can't be read right now."

Disabling
- "Turning off… stopping 3 managed stacks (1 of 3)."

Demo
- Info: "Demo stacks. Nothing runs and nothing is saved."

P1 detail
- Inline note: "Read-only. This release lists and inspects stacks; agents and lanes still start and stop them."

## Data needs (renderer state, no secrets)

**SupabaseState** (pushed; strictObject; accepted only when revision ≥ current; re-parsed in main and safeParsed in preload)
- Envelope: revision, updatedAt, source (live | demo).
- availability.platform: {supported, arch, macosVersion, reasonText?}
- feature: {enabled, acknowledgedAt?, policyHealth: ok | quarantined, disabling?: {remaining, total}}
- discovery: {status: live | paused | off, lastListAt?, sessions: ok | unavailable}
- capacity: {running, starting, queued, cap, derivedCap, sysv: {used, limit} | null, memoryPressure, nextToStopId?}
- footprint: {mode: measured | estimate, bytes, measuredAt?, awake, idle}
- disk: {stacksBytes?, uploadsBytes?, cacheBytes?, cacheState, measuredAt?}
- home: {label, foreign?}; engines: {docker, podman}, as found | absent
- policy projection:
  - maxRunning, exclude[], unheldStopDelayMs, abandonedGraceMs, retentionDays, branchSwitch, allowUnverifiedPatch, stopContainerStacksOnce;
  - appEnv[{name, source}] (at most 8), appEnvPreset[];
  - laneDefaults[{environmentId, backend: auto | off}];
  - repositories[{id, mode}];
  - paths labels.
- Collections: stacks[] (at most 128), repositories[] (at most 32), requests[] (at most 32), jobs[] (at most 64), prune, transientCount.
- notices: {containerStacks[], registryError?}
- P5 only: trafficSignature, apiPortIndex[{port, stackId}].

**StackSummary**
- Identity and status:
  - id, name, origin (managed | adopted | external | expected);
  - state (9 values), ownerLiveness (reachable | absent | starting | sweeping | not-responding | unknown);
  - lifecycle | null, readiness | null;
  - health {members, awake, sleeping, unhealthy, excluded[]}.
- Runtime and mode: runtime; exposure {verdict, checkedAt?}; mode {value: managed | observed | off, reasonText?}.
- Location (display only): repositoryId?, worktreeLabel, projectRootLabel, branchContext, currentHead {branch | detached, stableSince?, gitOperation?}, worktreeExists.
- Endpoints (loopback-validated): apiUrl?, restUrl?, functionsUrl?, ports {api, db, mail, studio}, excluded[], studio.
- Attachments and holds:
  - lanes[{laneId, simulatorUdid, port, env}];
  - holds[{holder: lane | session | worktree | operator, since, live, abandonedSince?, releaseAt?}];
  - cwdKeepers[], createdBy {via, agent?, at?}, pinned.
- Timers: autoStopAt?, autoStopReason?, pruneGroup?, pruneSuggestedAt?.
- cli: {version, gate, runnerLabel, inspectCommand, statusCommand, mismatch?: {ownerRelease, clientRelease}}.
- flags[], diskBytes?, uploadsBytes?, uploadsInDeletedWorktree, memoryBytes?, measuredAt?, lastUsedAt?.
- Drift: configDrift {status, paths?}, compositionDrift?.
- lastError?: ClassifiedSupabaseError {code (17), title, message ≤ 4096, recovery, retry, display-safe details}.
- recreateChanges?[{service?, path?, key?, saved?, requested?, editable}] ≤ 64: what a needs-recreate stack can't adopt, as the start that set the state listed it. It stays until the state clears, so a later failure for another reason replaces lastError but not this.
- appEnvNames[], envShadow?[{file, line, name}], bucketsConfigured, migrationCount, requestIds[], activeJobId?.

**Inspection** (pushed only while a stack is inspected)
- members[{service, capability, activation, state (8 CLI values), lifecycle | null, health | null, wakeHintMs?, error? ≤ 512}], endpoints[{key, port}], checkedAt.

**Repository**
- id (repo-<12hex>), label, appPathLabel?, mode, counts, checkedAt.
- cli {version?, gate?, runnerLabel?}.
- checks[{id, status, summary, lines?[{file, line, text}], fix?}].
- worktrees[{pathLabel, branch, mode, reasonText?, stackId?}].

**Request**
- id, kind (destroy | reset | start-capacity in P5), status, requester {kind, sessionId, live}, stackId?, branch, sizeBytes?, createdAt, expiresAt.
- note? (sanitized, ≤ 240 characters; shown in the card only).
- otherHolders[], laneAttached?, capacity candidates.

**Job**
- id, kind, stackIds[], status (queued | running | complete | failed | cancelled | lost).
- steps?[{id, label, state}], migration?{done, total}, coldCache?, latestLine?, startedAt, expectedMs?, error?, cancellable.

**Prune**
- revision, computedAt, groups[{id, stackIds[], bytes?, selectable}], notSuggested counts, lastResult?.

**Receipts**
- Every receipt: {actionId, kind, completed, cancelled?, error?, jobId?, state?}.
- Logs: {records[entry | marker], truncated, bytes, readAt}.
- Database: {target, stats?, topTables ≤ 10, migrations?{comparable, state, rows ≤ 500}, readAt}.
- copy {copied, what}; open {opened}; reveal {revealed}.
- Confirmation: {actionId, required, confirmed, token?, expiresAt?, options?{removeUploads?, disposition?}, error?}.

**Interest**
- setSupabaseInterest({view, inspectStackId?, sections[]}) → disposer. Debounced 60 ms; the disposer sends none.

**Lane delta**
- lane.backend {policy, status, stackId?, apiUrl?, appEnvNames[], reasonText?, warnings[]}.

**Never in the renderer**
- Keys, the publishable key value, passwords, DB_URL, MCP URL, S3 values, raw stdout.
- Tests assert that sb_secret_, sb_publishable_, eyJ, postgresql:// and SERVICE_ROLE never appear in serialized state, receipts or demo data.

## Polling and performance

**Main** (follows DESIGN.md:1626-1634; gated by window visibility, index.ts:1267-1281, and by the interest signal):
1. **Off:** nothing runs. A FakeCli test asserts zero calls.
2. **Cheap tier** (pgrep/ps argv, one read-only ports.sqlite SELECT, stat of roots and gitdir HEAD and its markers):
   - P1: only while interest exists;
   - from P3: every 15 s while the feature is enabled.

   It feeds the badge, chips and countdowns.
3. **`stack list`:** when the set of ids changes, after lifecycle events, on Refresh, and every 5 min. Single-flight.
4. **`stack status`:** every 10 s for the inspected stack, only while it is visible.
5. **lsof:** after every lifecycle operation, and every 5 min for running managed stacks.
6. **Footprint and disk:**
   - RSS every 30 s;
   - disk walk (at most 50,000 entries, 2 s) every 10 min;
   - both only while interest exists, shown with an as-of time, or "—" when stale.
7. **Database and log reads:** only on open, on Refresh, or after migrate or reset. The P5 log auto-refresh polls every 5 s with --since and stops after 10 min.
8. **Concurrency:**
   - creations one at a time;
   - resumes and stops two at a time;
   - at most 4 CLI children;
   - reads time out at 20 s;
   - budgets come from supabaseOperationBudget (dialect.ts:1237-1318).
9. **Broadcasts:** only on change, coalesced to 100 ms. Interest never extends an auto-stop timer.

**Renderer:**
- **Subscriptions and contexts:**
  - one subscription;
  - separate contexts for state, actions/status and selection, so a push doesn't re-render App, Titlebar or the sidebar;
  - the sidebar uses a memoised badge selector.
- **Rows:** memoised by revision; the list is virtualized.
- **Pending and guards:**
  - pending tracked per stack plus one bulk key;
  - actionId guards;
  - a ≥ revision guard on broadcasts and receipts.
- **Clocks:**
  - one panel-level useNow(): 1 s while a visible countdown is under 2 min, otherwise 15 s, stopped on unmount;
  - the StepList clock runs only while its detail is visible.
- **Interest:** debounced 60 ms with a disposer (simulator-stream-runtime.tsx:85-117).
- **Logs:** at most 64 KiB in one pre; the filter is debounced 100 ms.
- **No direct network access:** the renderer never fetches a stack port (the packaged CSP sets connect-src 'self').

## Cross-panel integration

**Shell (P1)**
- The Backend sidebar group.
- ⌘8 opens Supabase; Settings moves to ⌘9.
- The Xcode setup banner is skipped on this tab.
- ActionNotice routing gains a 'supabase' runtime: lanes → [lanes, supabase] and fleet → [simulator, lanes, supabase].
- The sidebar badge arrives in P3; the titlebar Jobs count includes Supabase jobs from P3 (app.tsx:468-488).

**Lanes (P3)**
- Lane rows: a SupabaseChip after LaneSlimBadge (lanes-panel.tsx:401-418).
- Start form (469-688):
  - a Backend select after Slim, whose disabled reason is visible text;
  - worktree suffixes in the picker;
  - the pending message "Starting the backend, booting the Simulator, and starting Metro…";
  - `backend` is spread into the start request only when set.
- Lane detail (858-1060): a Backend Disclosure with the chip, the API URL to copy, the injected variable names, and [Open in Supabase] [Restart Metro to attach] [Stop backend].
- P5: a warning when a signed-in session carried over.
- A new `lanes.focusLane` intent lets Supabase open a specific lane or Agents card, and fixes Fleet's Open in Lanes.

**Fleet (P3)**
- The chip on tiles and rows (fleet-panel.tsx:801-880).
- A 'with-backend' filter (fleet-model.ts:40-45); search also matches :port and the stack id prefix.
- The Lane section (1215-1289) gains a Backend line with [Open in Supabase].
- connectedSessionsForSimulator moves into fleet-model.ts first.

**Agents view (P3; P4 adds Release)**
- Per-session backends from backendsForSession(): chip, how the session holds it, liveness, [Open in Supabase].
- Release appears on session holds only; lane holds end when the lane stops.
- A count badge like "1 device · 1 backend".
- A pending-request line with [Review in Supabase].

**Global Settings (P1)**
- One optional "Local Supabase (alpha)" row with its status and [Open Supabase settings].
- It is never required and never adds to the warning count.

**Connected workspace (P5)**
- A mismatch banner in the offline-banner slot (app.tsx:1099). It shows only for a real mismatch, never when there is no evidence.
- Network: target badges in the host cell, and a filter intent (Backend segment plus an origin chip; network-panel.tsx:138, 200-215).
- Diagnostics: export HealthCard with a default tone and add a Backend card (diagnostics-panel.tsx:297-338).
- Environment: a notice when the app's declared URL points at a different stack.

**e2e**
- harness: insert 'supabase' before 'settings' in simulatorToolIds and add panelHeadings['simulator/supabase'] = 'Supabase'.
- shell: Mod+8 opens supabase, Mod+9 opens settings, and the footer reads 1–9.
- smoke: the nav count becomes 9.
- A new simulator-supabase.e2e.ts asserts the h1, the metric grid, the off state, the demo rows, and no horizontal overflow at 1040x700.

## Keyboard and accessibility

Shortcuts and structure
- ⌘8 / Ctrl+8 opens Supabase through the existing digit handler (app.tsx:309-358), which ignores editable targets. Settings moves to ⌘9. Nothing binds 0.
- There is one h1, "Supabase". e2e asserts it, because unknown hashes fall back to Fleet.
- The nav item keeps aria-current, and the badge's meaning is part of its accessible name.

Toggles
- The view toggle and Follow|Warn are a fieldset with an sr-only legend and aria-pressed buttons (lanes-panel.tsx:189-208).
- The gear uses aria-pressed.

List
- The list is a ListView (GridList): arrow keys move, Enter or Space selects.
- Typeahead uses textValue: branch, state, ports and holder.
- In batch mode, Space toggles the row's checkbox.
- No buttons sit inside rows.

Detail links
- The holder chain and StepList are Timeline ol/li. The current step gets aria-current.
- Each link button names its target, e.g. "Open lane feat/login-flow :8102 in Lanes".
- Icon-only buttons name their stack, e.g. "Stop feat/login-flow".

Disabled controls
- Each disabled control has a visible DisabledReason span with an id, linked by a conditional aria-describedby (the network-panel.tsx:369-421 pattern).
- ConfirmAction gains a describedBy prop, because its disabled branch drops aria props (ui.tsx:316-322).
- The reason is never only in a title tooltip.

Status
- Status is never colour or motion alone: every dot sits beside a word, and spinners sit beside a verb.
- The global reduced-motion rule (styles.css:4867-4880) freezes animation.
- Sleeping uses a static Moon.

Live regions
- ActionNotice uses aria-live.
- Danger notices use role=alert, warnings role=status.
- The Clean up result and the log match count use role=status.
- Countdowns sit in output elements with aria-live off.
- StepList announces only step changes, politely.

Logs
- Logs render in a focusable pre (tabIndex 0) labelled "Redacted logs for <branch>".
- Filter matches use mark.

Disclosures and dialogs
- Disclosures stay native details/summary.
- Native dialogs cancel on both Return and Esc (defaultId and cancelId 0). Tab reaches the checkbox, and focus returns to the trigger.

Focus
- After Destroy or Clean up, selection and focus move to the next row (lanes-panel.tsx:125-129).
- Deep links focus the target's heading.
- The focus ring is the global 2 px brand ring.

## Responsive behaviour

At 1040x700 (content area 815x652; the sidebar is 225 px at 1220 px and below, styles.css:4768-4771):
- **Header:** about 600 of 771 px.
- **Notices:** at most 2, with the +N toggle inline.
- **Toolbar:** about 650 of 791 px:
  - view toggle text-only (about 260 px);
  - search 180 px, via `SearchControl widthClassName="w-[260px] max-[1080px]:w-[180px]"`;
  - filter about 150 px;
  - Select multiple icon-only (ListChecks, with an aria-label);
  - meta hidden (styles.css:4862).
- **Batch mode:** the bulk group wraps to a second line as one unit.
- **Layout:** the existing `.sim-fleet-layout` at 1080 px and below, minmax(245px,34%) | 1fr: list about 277 px, detail about 538 px.
- **Vertical budget:** 652 − 72 − 76 − 82 − 45 − 45 = 332 px, which is five 64 px rows.
- **Row line 2:** state, then at most 2 flags, then lane :port, API :port and size, cut off with an ellipsis.
- **Truncation:** paths use shortPath and ids use truncateMiddle.

From 1081 to 1220 px:
- The meta and the Select multiple label return.
- The layout is minmax(310px,37%).

At 1220 px and wider (1440x900, content 1212 px):
- The list is about 448 px; rows show the Simulator name and size.
- The detail is capped at 820 px and centred.
- Titlebar metrics return.

With the sidebar hidden (Mod+B):
- The content is 1040 px, but the 1080 px rules still apply (they key on window width), so the list is about 354 px.

Other views and panels:
- Settings and Requests are scrolling columns, max 960 and 820 px.
- The Lanes Backend field wraps with `.lane-start-fields`.
- The connected banner wraps to two lines.

No horizontal overflow anywhere: final-visual.e2e.ts and shell.e2e.ts cover the tab once the harness lists it.

## Copy deck

Conventions
- No renderer string contains "process." or "Buffer" (boundaries.test.ts:62-71). Say "owner" or "service" instead.
- Service states use the CLI's own words.
- Command text, runner, config snippets and observed-mode reasons come from main state.
- An ellipsis marks any control that opens a dialog.
- Verb ladder:
  - Stop (keeps data)
  - Reset database (drops data, keeps the stack)
  - Destroy (deletes the database and logs, frees ports, can't be undone)
- Automatic actions only ever say "stopped automatically · data kept".
- Sizes use the app formatter (KB, MB, GB; "—" when unknown).
- Future times read "in 45 s", "in 7 min", "in 3 days".

Shell and header
- Group: Backend. Tool: Supabase.
- Sidebar accessible names: "Supabase, 3 need attention" / "Supabase, 3 running".
- Footer: "⌘ 1–9 Navigate Simulator".
- h1: Supabase, with an Alpha badge.
- Meta: "3 running · 4 stopped · 1 starting".
- aria-labels: "Refresh Supabase stacks", "Supabase settings".
- About popover: "One local Supabase stack per worktree and branch, on 127.0.0.1, using Supabase's native runtime. RN Devtools starts, stops and cleans them up for lanes and agents; agents keep running their own local database commands. Supabase marks these stack commands experimental. Viewing this tab never keeps a stack running."

Metrics
- RUNNING: "3 / 12", with "1 starting" / "all held" / "next to stop: main".
- POSTGRES SLOTS: "6 / 32", with "26 free".
- MEMORY: "1.2 GB", with "RSS · measured 5 s ago" or "≈ 1.4 GB · estimate".
- DISK: "2.1 GB", with "1.7 GB is shared cache".

Toolbar
- View toggle: Stacks | Repositories | Requests 2.
- Search placeholder: "Branch, :port, agent".
- Filters, with counts: All stacks, Running, Stopped, Not created, Held by agents, Unused, Needs attention, External, Transient.
- "Select multiple" / "Done selecting".
- Meta: "10 matching · 0 selected".
- Bulk: "Stop 3", "Destroy 1…".

Rows
- "Running · lane :8102 · API :21734"
- "Running · idle · API :24410"
- "Starting… 2 s · lane :8106"
- "Stopped · Stale branch · 71 MB"
- "Stopped 16 d · prune suggested"
- "Not created · managed worktree"
- "LAN-exposed · Docker · stopped"

Detail
- Eyebrow: "Supabase stack".
- Section headings: "Who holds this", "Also held by", "Created by", "What happens next".
- Created by: "lane up · Claude 9b1e2c00 · today 12:02", "You (Supabase tab)", "Outside RN Devtools".
- Footnote: "Viewing this tab never keeps a stack running."

Services
- "Services · 1 of 7 awake · 5 asleep".
- "sleeping · starts on first request (~0.4 s)".
- "Excluded by Settings: studio, analytics."

Database
- "Migrations · 12 applied · 2 pending".
- Row statuses: applied, pending, out of order, missing locally.
- "Storage files aren't in exports; there is no restore."

Logs
- "Redacted · 214 lines · 48 KB of 64 KB · read 14:03:05".
- Markers: "--- launch 2 ---", "--- 3 stdout lines lost ---".
- "History stays readable while the stack is stopped."

Connect
- "Publishable: the local default key, the same on every local stack."
- "Secret: Not shown by RN Devtools. Run <statusCommand> in the worktree."
- "Values stay in RN Devtools."
- "Keys and the database password never reach this window; RN Devtools writes them to the clipboard itself."

Danger zone
- "Drops all data and auth users, then re-runs N migrations and the seed (about 5 s). Keeps the stack id, URL, ports and keys. No backup is kept."
- "Deletes its database and logs and frees 10 ports. Storage uploads stay unless you tick the box in the next dialog. This can't be undone."

Requests and Clean up
- Request lines:
  - "<Agent> session <id> (live) asks to destroy <branch> (71 MB)"
  - "…asks to reset <branch>'s database"
  - "…needs a database for <branch>; 12 of 12 run, all in use"
- Agent's note: "Agent's note: …".
- Clean up groups: Worktree deleted · Stale branch · Stopped longer than 14 days · Failed to start · Unreadable.
- "No downside: the worktree is gone, and its uploads with it."
- "Recovery: lane up recreates a fresh, migrated, seeded database in about 5 s."
- "1 stack selected · a system dialog confirms".
- "Not suggested: …".
- "RN Devtools never deletes a database on its own."

Repositories
- Pills: READY / NEEDS FIX / CHECK / OPTIONAL.
- "Delete these lines. Only one stack at a time can use a pinned port; the others fail to start."
- "RN Devtools never edits repository files; copy a fix and commit it yourself."

Settings
- "Max running · 1–24 · this Mac's safe ceiling is 12 (32 slots, 8 kept free)"
- "Stop after release · s · when nothing holds a stack; data is kept"
- "Abandoned grace · 10 min, the same as Simulator holds"
- "Suggest cleanup · days · RN Devtools never deletes on its own"
- "Exclude by default · Studio · Analytics · Pooler"
- "Stop Docker or Podman stacks on managed worktrees, once per session"
- "Allow unverified patch releases"
- "App variables · names Metro gets for each lane; values stay in RN Devtools"
- "Use Supabase + Expo preset"
- "Lane defaults · Auto · Off · Required is a per-lane choice."
- Global Settings row: "Local Supabase (alpha) · Off | On · 3 running | Needs setup | Not available · Open Supabase settings"

Dialog titles and verb buttons
- "Destroy the local Supabase stack for <branch>?" → "Destroy <branch> (71 MB)", or "Destroy anyway (71 MB)" when a live agent holds it.
- "Destroy 3 local Supabase stacks (179 MB)?"
- "Reset the database for <branch>?" → "Reset <branch>", or "Reset without seed".
- "Turn on local Supabase (alpha)?" → "Turn on".
- "Turn off local Supabase?" → "Leave them running" / "Stop managed stacks".
- "Enable Studio for <branch>?" → "Enable Studio".
- "Stop the stack for <name>? RN Devtools didn't start it." → "Stop <name>".
- "Allow unverified Supabase CLI patch releases?"
- "Stop excluding Studio by default?"
- "Recreate the stack for <branch>?"
- Checkbox: "Also delete Storage uploads (<size> in …/stack-uploads/<id>)". For a deleted worktree: "Uploads lived in the deleted worktree and are already gone."

Error titles and recovery
- Rendered from main's classifier (cli-errors.ts:365-462), with the unreadable recovery corrected.
- Every code maps to exactly one button.

Cross-panel
- Lanes Backend select: "Auto (development) / Off / Required".
- Worktree suffixes: "· Supabase", "· Supabase (needs opt-in)", "· Supabase (ports pinned)".
- Lanes pending message: "Starting the backend, booting the Simulator, and starting Metro…".
- Fleet: "With backend (2)".
- Agents: "1 device · 1 backend".
- Connected banner: "<App> talks to the stack for <branch> (:24410), not its lane's stack (:21734): 12 of 14 requests."

## Implementation cost

**Prerequisites**
- `.gitignore` gets the negation `!apps/desktop/src/renderer/lib/`. Today action-notice.ts, shell-navigation.ts and their tests are ignored (.gitignore:6), even though app.tsx imports them.
- Fix main's unreadable recovery copy (cli-errors.ts:428-431).
- Land the P0 redactor.

**HeroUI**
- No CSS import changes (styles.css:5-28 is unchanged).
- One new @heroui-pro importer, supabase-ui.tsx (Timeline plus a NativeSelect wrapper). AGENTS.md's importer count goes from 16 to 17.

**New primitives**
- components/ui.tsx: StatusDot, DisabledReason, RequestCard, ReadinessRow.
- components/supabase-ui.tsx: HolderBadge, HolderChain, StackStatePill, SupabaseChip, ServiceRow, StepList, LogView, MainCopyButton, SupabaseSelect.
- shared/device-hold.ts: holdCountdownLabel.
- lib/format.ts: formatSize.

**Extensions**
- Disclosure: controlled open state.
- ConfirmAction: describedBy.
- SearchControl: a width class.
- AgentBadge: accepts a Pick of the agent.
- SimulatorToolDefinition: a group field; simulatorBadge.
- ActionNoticeRuntime: the supabase runtime.
- CSS: the info pill fix and `.tool-count.is-danger`.
- LaneRuntime: a focus intent.
- P5: a DesktopRuntime network intent and an exported HealthCard.

**New files (lines, with tests)**

| File | Lines | Test lines |
|---|---|---|
| supabase-panel.tsx | 420 | — |
| supabase-stack-detail.tsx | 620 | — |
| supabase-repositories-view.tsx | 240 | — |
| supabase-requests-view.tsx | 330 | — |
| supabase-settings-view.tsx | 380 | — |
| supabase-ui.tsx | 380 | — |
| supabase-runtime.tsx | 400 | 220 |
| supabase-model.ts | 560 | 700 |
| supabase-protocol.ts | 620 | 420 |
| supabase-demo-data.ts | 280 | 80 |
| supabase-traffic.ts (P5) | 170 | 160 |
| simulator-supabase.e2e.ts | 120 | — |

**Edits (about 450 lines)**
- Shell and runtime: simulator-config, app, main.tsx, desktop-api.d.ts, action-notice, ui, lane-ui, format, device-hold, lane-runtime, desktop-runtime.
- Panels: lanes-panel, fleet-panel, fleet-model, agents-view, settings-panel, network-panel, diagnostics-panel, environment-panel.
- styles.css (a Supabase section of about 200 lines).
- e2e: harness and shell.
- Docs: README, AGENTS.md (naming line, importer count), DESIGN.md (id, shortcut, phases, DB_URL in memory, unreadable rule, lane defaults).

**Total:** about 4,500 product lines and 1,600 test lines.

**Main-side dependencies (sized in DESIGN)**
- 5 bridge methods and the supabase.* ops.
- A confirmation helper with checkboxLabel, whose result returns the chosen options.
- An exported sanitizer and loopback URL validator.
- Clipboard writes from main.
- The interest gate.
- Demo ports, behind RNDEVTOOLS_DEMO && !app.isPackaged.

**PR slices**

| PR | Contents |
|---|---|
| P1a | Registration, Stacks list and detail without actions, Repositories, Settings block, on/off, states, demo, e2e |
| P1b | Database reads and Logs history |
| P3a | Lifecycle, holds, Adopt, Mailpit, main-side copies, bulk Stop, policy |
| P3b | Lanes, Fleet, Agents and titlebar |
| P4 | Destroy, Clean up, Requests, Release, Reveal |
| P5 | Extras |

## Components

| Component | Kind | Source | Purpose | API sketch |
|---|---|---|---|---|
| `PanelHeader` | reuse | components/ui.tsx:103-126 | h1 Supabase, About popover, meta with Alpha Badge, actions Refresh, Clean up N, Gear. |  |
| `PanelNotice` | reuse | components/ui.tsx:101-131 | Ranked tab notices (cap 2) and detail notices; warning/danger only for must-read text (info collapses, ui.tsx:110-117). |  |
| `SimulatorMetric + .sim-metric-grid` | reuse | components/simulator-ui.tsx:109-134; styles.css:1082-1143 | Running, Postgres slots, Memory, Disk; tones default/success/warning only. |  |
| `Toolbar, SearchControl, NativeSelect filter, .sim-layout-toggle` | reuse | ui.tsx:97-168; fleet-panel.tsx:428-462; lanes-panel.tsx:189-208 | View toggle, search, filter with counts, Follow\|Warn. |  |
| `DenseVirtualList` | reuse | components/simulator-ui.tsx:136-218 | Stack and repository rows (rowHeight 64); batch mode multiple with ListView selection checkboxes, cap 20 (fleet-panel.tsx:586-596). |  |
| `Layout and detail scaffold CSS` | reuse | styles.css:1171-1186, 2272-2300, 2422-2440, 4833-4835 | .sim-fleet-layout unchanged, .sim-target-detail, .sim-action-row, .sim-detail-section, .sim-danger-zone. |  |
| `KeyValue, InfoPopover, InlineCode, CodePreview, CopyButton, Badge, EmptyPanel, Skeleton, DetailPlaceholder, StatusPill, ActionNotice` | reuse | ui.tsx:23-494; status-ui.tsx:15-88 | Facts, snippets, non-secret copies, empty/loading states, toasts. |  |
| `AgentGlyph, LaneChip, WorktreeLabel` | reuse | components/lane-ui.tsx:17-114 | Holder glyphs, lane links, worktree labels. |  |
| `PanelErrorBoundary, action-notice routing, formatShortcutRange` | reuse | components/error-boundary.tsx:56-106; lib/action-notice.ts:22-142; lib/shell-navigation.ts:16-36 | Already in the working tree; Supabase only adds a runtime id and tool lists. |  |
| `DiskInventorySection, Fleet activity Disclosure, CaptureRetentionControls patterns` | reuse | fleet-panel.tsx:1567-1745, 675-721; captures-panel.tsx:837-975; capture-model.ts:14-37 | Clean up layout and revision-keyed selection; Supabase activity; policy form parser and dirty check. |  |
| `Interest, confirm and revision patterns; holder resolver` | reuse | simulator-stream-runtime.tsx:85-117; slimming-runtime.tsx:129-171; simulator-runtime.tsx:230-234; shared/device-hold.ts:60-145 | Debounced interest with disposer; actionId-guarded confirm then run; >= revision guard; resolveHolderLiveness and holderClockKey. |  |
| `HeroUI Pro Timeline` | heroui-import | @heroui-pro/react/timeline (CSS already imported, styles.css:28; zero consumers) | StepList and the Who holds this chain; statuses success, current, muted, danger, warning; ol/li with aria-current. No new CSS import. | wrapped only inside components/supabase-ui.tsx |
| `SimulatorToolDefinition.group + simulatorBadge` | extend | simulator/simulator-config.ts:23-96; app.tsx:801-947 | Backend group, generic sidebar sections, badge tone. | group: 'simulator' \| 'backend' \| 'system'; simulatorBadge(tool, ctx): {value, tone: 'default' \| 'warning' \| 'danger', label} \| undefined |
| `Disclosure, ConfirmAction, SearchControl, AgentBadge` | extend | ui.tsx:50-68, 294-363, 133-168; lane-ui.tsx:66-85 | Controlled open/onToggle (keeps defaultOpen callers); describedBy on both branches of ConfirmAction; widthClassName; agent prop as Pick<LaneAgent, 'kind' \| 'sessionId'>. | Disclosure({title, open?, onToggle?, defaultOpen?}); ConfirmAction({..., describedBy?}); SearchControl({..., widthClassName = 'w-[260px]'}) |
| `ReadinessRow` | extend | settings-panel.tsx:391-471 (CapabilityRow) moved to components/ui.tsx | Repository checks, Settings capability rows, global Local Supabase row. | ReadinessRow({icon, label, status: 'ready' \| 'needs-fix' \| 'check' \| 'optional' \| 'checking', detail, lines?, fix?, actions?}) |
| `holdCountdownLabel, formatSize` | extend | shared/device-hold.ts; lanes-panel.tsx:825-856 (LaneHoldNote adopts it); lib/format.ts:30-47 | One tested countdown label; GB-capable size formatting with — for unknown. | holdCountdownLabel({live, releaseAt?}, now, verb): {text, tone}; formatSize(bytes?) |
| `CSS fixes` | extend | styles.css:2211-2215, 928, 5499 | Blue tokens for .sim-state-pill.is-info; new .tool-count.is-danger; Supabase section (about 200 lines, tokens only). |  |
| `Cross-panel extensions` | extend | lanes-panel.tsx:401-418, 469-688, 858-1060; fleet-model.ts:40-45; fleet-panel.tsx:137-155, 801-880, 1215-1289; agents-view.tsx:21-268; settings-panel.tsx:283-330; lane-runtime.tsx; network-panel.tsx:138, 200-215; diagnostics-panel.tsx:297-338 | Chips, Backend select and section, with-backend filter, backend lines, global row, focusLane intent; P5 network intent, target badges, exported HealthCard with default tone; connectedSessionsForSimulator moves to fleet-model.ts. |  |
| `SupabasePanel and views` | new | panels/simulator/supabase-panel.tsx, supabase-stack-detail.tsx, supabase-repositories-view.tsx, supabase-requests-view.tsx, supabase-settings-view.tsx | Lazy prop-less panel, view routing and the skeleton. | export function SupabasePanel() |
| `supabase-ui.tsx` | new | components/supabase-ui.tsx (the only new @heroui-pro importer) | StackStatePill, SupabaseChip, HolderBadge, HolderChain, ServiceRow, StepList, LogView, MainCopyButton, SupabaseSelect (NativeSelect wrapper). | MainCopyButton({label, onCopy: () => Promise<{copied}>}); StepList({steps, elapsedMs, expected}) |
| `StatusDot, DisabledReason, RequestCard` | new | components/ui.tsx | One dot primitive; visible reason with id for aria-describedby; block-layout request card (DeviceRequestCard can adopt it). | DisabledReason({id, children}); RequestCard({tone, title, children, actions}) |
| `SupabaseRuntimeProvider` | new | state/supabase-runtime.tsx (+test), mounted inside AgentRuntimeProvider around SimulatorStreamProvider (main.tsx:27-31) | Bridge detection, revision guard, per-stack pending map plus bulk key, separate status and selection contexts, interest, intents, selectors. | {state, isBridgeAvailable, pendingFor(id), actionStatus, clearActionStatus, run(op, msgs), confirmAndRun(op, msgs), useInterest(spec), openInSupabase(intent), stackForLane(laneId), backendsForSession(key)} |
| `supabase-model.ts` | new | simulator/supabase-model.ts (+test) | Pure joins and rules, all node-tested. | buildSupabaseRows, supabaseRank, supabaseFilterCounts, supabaseTabState, supabaseActionAvailability, attentionItems, supabaseNotices, nextEvents, bulkEligibility, pruneSelection, sidebarBadge, startSteps |
| `Shared protocol, demo and traffic modules` | new | shared/supabase-protocol.ts, shared/supabase-demo-data.ts, shared/supabase-traffic.ts (P5), each with tests | Strict schemas and bridge type, stackStatus and laneBackendChip tone scales, deterministic demo state, classifyAppTraffic with a main-supplied signature. |  |

## Controls

### P1 · Turn on local Supabase…

- **Location:** Off-state EmptyPanel; Settings view switch
- **Preconditions:** Bridge; platform supported (verdict from main without spawning); feature off, with no Stop managed stacks turn-off still running. A quarantined policy restarts from defaults.
- **Disabled reasons (visible copy):**
  - Supabase controls need the secure desktop bridge. Open the packaged RN Devtools app.
  - Needs Apple silicon and macOS 14 or later.
  - Turning on…
  - Local Supabase is still turning off.
- **Confirmation:** main-dialog-token
- **CLI:** `main-only: supabase.set-enabled {enabled: true, confirmationToken}; then the first reconcile runs `<bin> --version` per candidate (cached) and `<newest verified bin> stack list --output-format json`; nothing starts`
- **Progress:** Switch reads Turning on…; three Skeleton rows until the first list.
- **Success copy:** P1: Local Supabase is on. RN Devtools now lists the stacks on this Mac. From P3: Local Supabase is on. Development lanes on opted-in worktrees now get their own database.
- **Failure:** Could not turn on local Supabase: <message>. The switch returns to off.
- **Holder rules:** Running stacks are listed as External, or Managed when backends.json knows them; nothing is stopped or started.

### P1 · Turn off local Supabase…

- **Location:** Settings view switch
- **Preconditions:** Feature on. With no managed stack running (always in P1) it applies at once; from P3, a three-button dialog when managed stacks run.
- **Disabled reasons (visible copy):**
  - Turning off… waiting for running starts to finish.
- **Confirmation:** main-dialog-token
- **CLI:** `main-only: supabase.set-enabled {enabled: false, disposition?, confirmationToken?}; Stop managed stacks runs `any validated <bin> stack stop --stack-id <id> --output-format json` per running managed or adopted stack and per stack a running start, restart, stop-and-start, Studio switch or recreate brings up, one at a time once none of those is queued or running; any job still waiting its turn is called off when it comes`
- **Progress:** Turning off… · Stopping 3 managed stacks (1 of 3); running starts finish first.
- **Success copy:** Local Supabase is off. · Local Supabase is off. 3 stacks keep running. · Local Supabase is off. Stopped 3 managed stacks; data kept.
- **Failure:** Local Supabase is off, but feat/x did not stop: <title>.
- **Holder rules:** Dialog buttons Cancel (default), Leave them running, Stop managed stacks. Holds stay recorded; lanes get no database; agents get backends_disabled with self-start guidance.

### P1 · Refresh

- **Location:** Header [Refresh] (aria-label Refresh Supabase stacks)
- **Preconditions:** Feature on and supported (absent otherwise); presses coalesce into one refresh.
- **Confirmation:** none
- **CLI:** `Cheap tier (pgrep -U <uid> -f __supabase_stack_, ps argv, one read-only SELECT on ports.sqlite, stat of roots and gitdir HEAD), then `<newest verified bin> stack list --output-format json` (single-flight), then `owner <bin> stack status --stack-id <inspected id> --output-format json``
- **Progress:** Icon spins (static under reduced motion); sr-only role=status Refreshing Supabase stacks.
- **Success copy:** Silent; checked times update.
- **Failure:** Danger notice: Supabase state could not be read. <redacted> [Retry]; last state kept with its time.
- **Holder rules:** Never extends or resets an auto-stop clock.

### P1 · Inspect a stack (Overview, Services)

- **Location:** Row selection; Overview and Services Disclosures
- **Preconditions:** A stack selected, tab mounted, window visible (interest); live member state needs the owner on the same release.
- **Disabled reasons (visible copy):**
  - Status needs this stack's own Supabase CLI release; showing the state from <time>.
- **Confirmation:** none
- **CLI:** ``owner <bin> stack status --stack-id <id> --output-format json` every 10 s while inspected; lsof after lifecycle operations and every 5 min for running managed stacks`
- **Progress:** Skeleton on first read, then checked 14:02:31.
- **Success copy:** None.
- **Failure:** Status unavailable: <message>. Last rows kept.
- **Holder rules:** Viewing is not activity.

### P1 · Database reads

- **Location:** Detail › Database (on open) [Refresh]
- **Preconditions:** Database running. --local when HEAD == branch_context and the owner runs the worktree's release; otherwise stats read through the DB_URL main holds in memory. Migration status only when HEAD matches.
- **Disabled reasons (visible copy):**
  - Start the stack first. Database reads need it running.
  - Migration status can't be worked out while the worktree is on <current>; its migration files belong to that branch.
- **Confirmation:** none
- **CLI:** ``<bin> inspect db db-stats --local --workdir <root> --output-format json`; `<bin> inspect db table-stats --local --workdir <root> --output-format json`; `<bin> migration list --local --workdir <root> --output-format json`; moved branch or mismatch: the inspect reads use `--db-url <main-held DB_URL>?sslmode=disable` instead of --local`
- **Progress:** Skeleton rows; checked 14:02:31.
- **Success copy:** None.
- **Failure:** Inline main classifier title and recovery; unreadable stats show dashes.
- **Holder rules:** Read-only.

### P1 · Logs history

- **Location:** Detail › Logs: service select, window select, filter, Refresh, Copy shown
- **Preconditions:** The stack has started once; readable while stopped and across releases.
- **Disabled reasons (visible copy):**
  - No logs yet: this stack never started.
- **Confirmation:** none
- **CLI:** ``<bin> stack logs --stack-id <id> [--service <kind>|gateway] --tail 200 --output-format json`; windows use `--tail 1000 --since 10m|1h|start`; main strips control characters, redacts, caps lines at 2,000 characters and keeps the newest 64 KiB`
- **Progress:** Skeleton, then read 14:03:05; match count role=status.
- **Success copy:** Copied (CopyButton).
- **Failure:** Could not read logs: <message>.
- **Holder rules:** Reading never keeps a stack running.

### P1 · Copy non-secret values and repository fixes

- **Location:** Connect URLs, Stack id, Inspect command, Repositories snippets
- **Preconditions:** Value known (URLs after the first start, kept while stopped).
- **Disabled reasons (visible copy):**
  - The API URL is known after the stack's first start.
- **Confirmation:** none
- **CLI:** `none: renderer CopyButton on loopback URLs, ids, main-built command text and main-supplied config snippets (never dotenv values)`
- **Progress:** Tooltip 1.8 s.
- **Success copy:** Copied
- **Failure:** Copy failed
- **Holder rules:** RN Devtools never edits repository files.

### P1 · Repositories: Re-check

- **Location:** Repositories detail [Re-check]
- **Preconditions:** Feature on; repository tracked in Lanes.
- **Disabled reasons (visible copy):**
  - Turn on local Supabase first.
  - Checking…
- **Confirmation:** none
- **CLI:** `main-only bounded static reads (supabase/config.toml, config.json, supabase/.env*, app dotenv files, lockfile) plus `<bin> --version` per candidate (cached)`
- **Progress:** Rows read Checking.
- **Success copy:** ~/src/app checked · 2 fixes needed.
- **Failure:** Could not read supabase/config.toml (too large or not a file).
- **Holder rules:** n/a

### P1 · Navigation and global Settings link

- **Location:** Chain links, notice actions, Repositories links, global Settings row [Open Supabase settings]
- **Preconditions:** Target exists.
- **Disabled reasons (visible copy):**
  - This session has ended; it is no longer listed in Agents.
  - The lane has stopped.
- **Confirmation:** none
- **CLI:** `none: provider intents (openInSupabase, lanes.focusLane, setSelectedDeviceUdid) then window.location.hash`
- **Progress:** Instant; target selected and its heading focused.
- **Success copy:** None.
- **Failure:** A vanished target falls back to the first item.
- **Holder rules:** The global row is never required and never adds to the Settings badge.

### P3 · Start (create)

- **Location:** Action row on Not created and Never started rows; Getting started
- **Preconditions:** Common reasons first. Managed worktree (stack flag set, no config.json conflict, verified CLI, no pinned port held by another stack); worktree present; main re-derives the expected id from HEAD; admission: below the cap or an unheld managed stack can be stopped, at least 2 free Postgres slots, memory not critical. Creations queue one at a time.
- **Disabled reasons (visible copy):**
  - Observed only: <reason from main>.
  - Port 54321 for api is pinned in supabase/config.toml and held by the stack for ~/src/app-wt/spike.
  - A Docker stack already uses this worktree's identity. Destroy it first; RN Devtools never attaches container stacks.
  - 12 of 12 stacks are running and all are in use. Stop one, or raise the limit in Settings.
  - Only 1 Postgres slot is free; a start needs 2. Stop an idle stack first.
  - Memory pressure is critical. Stop stacks or Simulators first.
- **Confirmation:** none
- **CLI:** `Optional admission stop `any validated <bin> stack stop --stack-id <LRU unheld id> --output-format json`; then `<bin> stack start --workdir <root> --runtime native --exclude <excl> --output-format json`; lsof over the owner tree (non-loopback or lsof failure stops it and fails); `owner <bin> stack status --stack-id <id> --output-format json``
- **Progress:** Creating… 18 s (info) in row and pill; StepList; pending toast Starting Supabase for feat/onboarding… about 5 s (first start on this Mac about 45 s); label Start (stops spike-db, idle 2 h) when admission stops a stack; Queued · new stacks start one at a time.
- **Success copy:** feat/onboarding is running on :25118.
- **Failure:** Failed or Failed to start (danger) with main's title and recovery plus one action per code (ports_pinned: Open that stack, Review repository; capacity: Show running stacks; container_runtime: Destroy… (P4)); one automatic retry when retry is once.
- **Holder rules:** Adds an operator hold (You · pinned); Created by: You (Supabase tab).

### P3 · Resume

- **Location:** Action row on Stopped and Stopped outside rows; Try again on failed registered stacks
- **Preconditions:** As Start, plus registered and stopped; managed or adopted; native; worktree present; HEAD == branch_context; not needs-recreate.
- **Disabled reasons (visible copy):**
  - The worktree is on <current>. Starting this stack would load <current>'s settings. Switch back to <branch> first.
  - Its worktree was deleted. Destroy this stack to free its ports and data.
  - This stack runs on Docker and listens on your network. Destroy it; lane up then creates a native one.
  - This stack must be recreated: <key> changed from <saved> to <requested>. When every listed change is editable, instead: <key> changed from <saved> to <requested>. Revert it to keep this stack, or recreate it.
  - RN Devtools didn't start this stack. Adopt it first.
  - 12 of 12 stacks are running and all are in use. Stop one, or raise the limit in Settings.
- **Confirmation:** none
- **CLI:** ``<bin> stack start --stack-id <id> --runtime native --exclude <excl> --output-format json` (exclusions passed again because a resume drops them), lsof, status`
- **Progress:** Starting… about 1-2 s.
- **Success copy:** feat/payments resumed on :24410. Data was kept. (+ Ports moved, so lane :8104's Metro restarted.)
- **Failure:** As Start; partial gets one automatic stop and start first.
- **Holder rules:** Adds an operator hold only when nothing else holds it.

### P3 · Cancel start…

- **Location:** Action row while Creating, Starting or Downloading; activity row
- **Preconditions:** A desktop-owned start or prepare job before [task] done.
- **Disabled reasons (visible copy):**
  - Cancelling… the CLI is cleaning up (up to 45 s).
- **Confirmation:** inline
- **CLI:** `main-only: SIGINT to the CLI child, SIGTERM after 45 s, never SIGKILL (dialect.ts:1263-1271)`
- **Progress:** Cancelling… (info).
- **Success copy:** Start of feat/onboarding cancelled. · Start cancelled. It left an empty stack; destroy it before starting again.
- **Failure:** The start did not stop cleanly; feat/onboarding is marked Interrupted.
- **Holder rules:** Confirm copy: Cancel the start of feat/onboarding? The CLI cleans up first (up to 45 s). Removes the start's operator hold.

### P3 · Stop (keeps data)

- **Location:** Action row; Lanes detail [Stop backend]; not-responding and mismatch notices
- **Preconditions:** Running, starting outside, partial, unhealthy, not responding or CLI mismatch; managed, adopted or observed-mode; not already stopping.
- **Disabled reasons (visible copy):**
  - Another operation is running on this stack.
  - Stopping…
- **Confirmation:** inline
- **CLI:** ``any validated <bin> stack stop --stack-id <id> --output-format json` (90 s); then SIGTERM to the owner only after ps shows __supabase_stack_host__, the full id and the same uid, re-checked before signalling`
- **Progress:** Stopping…; after 5 s: Services stop one at a time; a fully awake stack can take 20 s or more.
- **Success copy:** feat/login-flow stopped. Data and ports are kept; Resume brings it back in about a second.
- **Failure:** Busy retries at 0.5, 1, 2 s; else Could not stop feat/login-flow: <title>. [Try again]
- **Holder rules:** ConfirmAction only with a live agent holder: Stop feat/login-flow's stack? Claude 9b1e2c00 is using it; its app loses the database until something starts it again. Data and ports are kept. Clears your pin; lane and agent holds stay; lane chip becomes db stopped.

### P3 · Stop… (external stack)

- **Location:** Action row on External running stacks; LAN-exposed notice
- **Preconditions:** Origin external; running or starting.
- **Disabled reasons (visible copy):**
  - Another operation is running on this stack.
- **Confirmation:** main-dialog-token
- **CLI:** ``any validated <bin> stack stop --stack-id <id> --output-format json``
- **Progress:** Stopping…; Docker: Waiting for Docker to answer…
- **Success copy:** legacy-main stopped. RN Devtools still doesn't manage it; data and ports are kept.
- **Failure:** Docker didn't answer within 90 s. Nothing was changed. [Copy stop command]
- **Holder rules:** Dialog names live sessions in the worktree. External stacks are never stopped automatically, except a Docker stack on a managed identity once per session.

### P3 · Restart services

- **Location:** Action row; Services; unhealthy and partial notices
- **Preconditions:** Owner reachable on the worktree's release; running, partial or unhealthy; managed or adopted. Uses saved settings, so allowed on stale-branch stacks.
- **Disabled reasons (visible copy):**
  - This stack runs on another Supabase CLI release. Stop it, then start it with this worktree's CLI.
  - RN Devtools didn't start this stack. Adopt it first.
  - Another operation is running on this stack.
- **Confirmation:** inline
- **CLI:** ``owner <bin> stack restart --stack-id <id> --output-format json`, then `owner <bin> stack status --stack-id <id> --output-format json``
- **Progress:** Restarting… about 1 s.
- **Success copy:** feat/login-flow's services restarted. Saved settings, exclusions, data and keys were kept.
- **Failure:** Main classifier copy; never-configured maps to Never started with [Start].
- **Holder rules:** ConfirmAction only with a live agent holder (open connections drop for about a second).

### P3 · Stop and start (Stop and start to apply · Re-apply exclusions · Restart with this CLI)

- **Location:** Config-drift and partial notices; Studio-back-on notice; CLI-mismatch notice
- **Preconditions:** Managed or adopted; HEAD == branch_context; worktree CLI verified or allowed patch; no job.
- **Disabled reasons (visible copy):**
  - The worktree is on <current>. Starting this stack would load <current>'s settings. Switch back to <branch> first.
  - This worktree's Supabase CLI isn't verified for RN Devtools. Stop the stack, then start it from a terminal.
  - Another operation is running on this stack.
- **Confirmation:** inline
- **CLI:** ``any validated <bin> stack stop --stack-id <id> --output-format json`, then `<bin> stack start --stack-id <id> --runtime native --exclude <excl> --output-format json`, lsof, status`
- **Progress:** StepList Stop, Start, Verify loopback; about 2-5 s.
- **Success copy:** feat/x restarted with its current settings. · Studio and analytics are excluded again on feat/x. · feat/x restarted with Supabase CLI 2.121.0. Database tools are back.
- **Failure:** Classifier copy; a failed start leaves it stopped with data and offers [Resume].
- **Holder rules:** ConfirmAction only with a live agent holder: its app loses the database for about 4 s. Data is kept.

### P3 · Keep running / Unpin

- **Location:** Action row toggle; What happens next
- **Preconditions:** Managed or adopted; running or starting.
- **Confirmation:** none
- **CLI:** `main-only: supabase.pin {stackId, pinned} (operator hold in backends.json)`
- **Progress:** Instant.
- **Success copy:** feat/login-flow keeps running until you unpin or stop it. · Unpinned. feat/login-flow stops 60 s after nothing holds it.
- **Failure:** Could not save the pin: <message>.
- **Holder rules:** Pinned: never auto-stopped, never stopped to make room, never suggested for cleanup; Reset asks to unpin; Stop clears the pin.

### P3 · Adopt

- **Location:** Action row on External native stacks in a managed worktree
- **Preconditions:** External; native; id equals the expected id for (worktree, branch_context); managed worktree; owner on the worktree's release, or stopped.
- **Disabled reasons (visible copy):**
  - Only native stacks can be adopted. This one runs on Docker.
  - Track this repository first (Repositories › Track repository…).
  - Its branch (old-ui) isn't checked out in that worktree anymore.
  - This stack runs on another Supabase CLI release. Stop it first.
- **Confirmation:** none
- **CLI:** ``owner <bin> stack status --stack-id <id> --output-format json` (when running), then lsof; no lifecycle command`
- **Progress:** Consequence line before the click: After adopting, RN Devtools stops it 60 s after nothing holds it; data is kept.
- **Success copy:** feat/spike is now managed by RN Devtools.
- **Failure:** Could not adopt feat/spike: <message>.
- **Holder rules:** Origin Adopted; Created by stays Outside RN Devtools; no hold added.

### P3 · Pre-download services

- **Location:** Repositories detail; Getting started
- **Preconditions:** A managed worktree; cache cold for this CLI release; no creation or download running.
- **Disabled reasons (visible copy):**
  - Services are already downloaded for Supabase CLI 2.121.0 (1.7 GB cache).
  - No managed worktree in this repository yet.
  - A stack is being created; the download waits for it.
- **Confirmation:** none
- **CLI:** ``<bin> stack prepare --workdir <root> --runtime native --capability database --capability rest --capability auth --capability realtime --capability storage --capability functions --capability mail --output-format json`, then `any validated <bin> stack stop --stack-id <returned id> --output-format json``
- **Progress:** Downloading services… 1:12 · one time, up to about 360 MB; activity row with Cancel.
- **Success copy:** Services downloaded. New stacks now start in about 5 s.
- **Failure:** Download failed: <message>. Nothing else changed.
- **Holder rules:** Registers the worktree's stack as Never started; no hold.

### P3 · Open Mailpit

- **Location:** Connect › Development tools
- **Preconditions:** Running; mail included; mail port known.
- **Disabled reasons (visible copy):**
  - Mail is excluded from this stack.
  - Start the stack first.
- **Confirmation:** none
- **CLI:** `main-only: supabase.open {stackId, surface: 'mailpit'}; main validates its own http://127.0.0.1:<port> record, then shell.openExternal`
- **Progress:** Opening Mailpit…
- **Success copy:** Silent (the browser opens).
- **Failure:** Could not open Mailpit: <reason>.
- **Holder rules:** Opening is not a hold.

### P3 · Copy key / Copy psql command / Copy app variables

- **Location:** Connect (MainCopyButton)
- **Preconditions:** Key known from the last start or status; psql needs a running stack; app variables need a mapping and a key.
- **Disabled reasons (visible copy):**
  - The key is read when the stack starts. Start it once.
  - Start the stack first. The database address is only known while it runs.
  - No app variables are mapped. Add one in Settings.
- **Confirmation:** none
- **CLI:** `main-only: supabase.copy {stackId, what: 'publishable-key' | 'psql' | 'app-env'}; main writes the clipboard (psql refreshes status if DB_URL is stale); receipt {copied, what} has no value`
- **Progress:** Copied or Copy failed for 1.8 s.
- **Success copy:** Copied the publishable key. It's the local default every local stack shares; don't commit it. · Copied a psql command for feat/login-flow. It contains the local database password; paste it only into a terminal on this Mac. · Copied 2 app variables · local only, do not commit.
- **Failure:** Copy failed
- **Holder rules:** n/a

### P3 · Select multiple and Stop N

- **Location:** Stacks toolbar
- **Preconditions:** Batch mode; at least 1 selected running, non-external stack; selection at most 20.
- **Disabled reasons (visible copy):**
  - None of the selected stacks is running.
  - External stacks are stopped one at a time from their detail.
- **Confirmation:** inline
- **CLI:** `One `any validated <bin> stack stop --stack-id <id> --output-format json` per eligible id, two at a time`
- **Progress:** Rows Stopping…; toast Stopping 3 stacks… 1 of 3 done.
- **Success copy:** Stopped 3 stacks. Data and ports are kept.
- **Failure:** Stopped 2 of 3. feat/y: <title>. [Try again] on that row.
- **Holder rules:** ConfirmAction when any has a live agent holder (names up to 3); pins clear; other holds stay.

### P3 · Settings policy form (Apply / Reset)

- **Location:** Settings view: Capacity and idle, Services (Analytics, Pooler), Safety (Docker stop once), App variables, Lane defaults; Repositories Auto|Off
- **Preconditions:** Feature on; Max running whole 1-24 (default min(12, (shmmni - 8) / 2)); stop after release 0-3600 s; suggest cleanup 1-90 days; app variable names match ^[A-Z][A-Z0-9_]{0,63}$, unique, not Metro-reserved, at most 8; lane defaults Auto | Off per environment.
- **Disabled reasons (visible copy):**
  - Max running must be a whole number from 1 to 24.
  - Stop after release must be 0 to 3600 seconds.
  - Suggest cleanup must be 1 to 90 days.
  - That name is already mapped.
  - That name is reserved for Metro.
  - Change a value to apply.
- **Confirmation:** none
- **CLI:** `main-only: supabase.set-policy {patch}; a pure renderer parser over the shared schema runs first; main re-parses and persists atomically`
- **Progress:** Applying…; 2 unsaved changes beside the buttons.
- **Success copy:** Supabase settings saved. They apply to the next start; running stacks keep theirs.
- **Failure:** Field errors under each field.
- **Holder rules:** Lowering Max running never stops a held stack; repository Off never stops running stacks.

### P3 · Settings trust changes (stop excluding Studio by default; allow unverified patch releases)

- **Location:** Settings view › Services › Studio; Safety › CLI versions
- **Preconditions:** Feature on. The safer direction applies at once with no dialog.
- **Confirmation:** main-dialog-token
- **CLI:** `main-only: supabase.set-policy {patch: {exclude} | {allowUnverifiedPatch: true}, confirmationToken}; unverified versions must pass a live contract probe`
- **Progress:** Instant after the dialog.
- **Success copy:** New stacks start with Studio. Its SQL endpoint has no authentication while it runs. · Unverified 2.121 patch releases can be managed after a live check.
- **Failure:** Could not save: <message>. The switch reverts.
- **Holder rules:** Running stacks keep their services until their next start.

### P3 · Lanes Backend select and lane detail Backend section

- **Location:** Lanes start form after Slim; lane detail Backend (Open in Supabase, Restart Metro to attach, Stop backend)
- **Preconditions:** Feature on; Auto or Required need a managed worktree; Restart Metro only when the stack attached after Metro started or ports moved.
- **Disabled reasons (visible copy):**
  - Turn on local Supabase in the Supabase tab first.
  - This worktree has no Supabase project.
  - Observed only: <reason from main>.
  - Metro isn't running for this lane.
- **Confirmation:** none
- **CLI:** `main-only: lane.start {..., backend: 'auto' | 'off' | 'required'} (spread only when set) runs Start or Resume during boot; Restart Metro is a main-only verified Metro restart; Stop backend is Stop`
- **Progress:** pendingMessage Starting the backend, booting the Simulator, and starting Metro…
- **Success copy:** Lane started. · Metro for lane :8102 restarted with feat/login-flow's database.
- **Failure:** Auto never fails the lane (chip shows db skipped · capacity); Required fails early with main's title.
- **Holder rules:** The lane hold attaches to the stack; Stop backend is a ConfirmAction when an agent drives the lane.

### P4 · Destroy… (single, bulk, Destroy and start again)

- **Location:** Danger zone; Select multiple [Destroy N…]; Failed, Never started, Worktree deleted, LAN-exposed and Interrupted notices
- **Preconditions:** Stopped (or failed, never started, interrupted, no owner); no running lane attached; not in flight; not unreadable; ids in a fresh stack list; at most 20 selected (32 per call). Destroy and start again also needs HEAD == branch_context.
- **Disabled reasons (visible copy):**
  - Stop it first. Destroy runs only on a stopped stack.
  - Lane :<port> is attached and running. Stop the lane in Lanes first.
  - This CLI can't read the stack, so it can't destroy it. See Clean up › Unreadable.
  - Destroy runs only on stopped stacks; 3 selected are running.
  - Another operation is running on this stack.
- **Confirmation:** main-dialog-token
- **CLI:** ``any validated <bin> stack destroy --stack-id <a> [--stack-id <b> ...] --yes --output-format json` (neutral cwd, ids re-checked); if ticked, main deletes <root>/supabase/.temp/stack-uploads/<id> after realpath, lstat and name checks; Destroy and start again then runs `<bin> stack start --workdir <root> --runtime native --exclude <excl> --output-format json``
- **Progress:** Destroying… (info); Docker: nothing is deleted if Docker doesn't answer.
- **Success copy:** Destroyed feat/old-ui. Freed 71 MB and 10 ports. · Destroyed 2 stacks. Freed 142 MB and 20 ports.
- **Failure:** Could not destroy feat/old-ui: <title>. Partial: Destroyed 1 of 2. feat/y: <title>. (root destroyed_stacks)
- **Holder rules:** Never automatic; one dialog names holders and switches to Destroy anyway when a live agent holds it; holds removed; focus moves to the next row.

### P4 · Clean up: Destroy N stacks (X MB)…

- **Location:** Requests › Clean up action bar
- **Preconditions:** At least one candidate selected; selection revision equals the latest prune revision.
- **Disabled reasons (visible copy):**
  - Select at least one stack.
  - The list changed. Review the selection again.
- **Confirmation:** main-dialog-token
- **CLI:** `As bulk destroy; the token binds {operation, sorted ids, removeUploads}`
- **Progress:** Group rows Destroying…; role=status result line.
- **Success copy:** Last clean up destroyed 1 stack and freed 64 MB · Oct 17, 14:02
- **Failure:** Partial result; failed rows stay selected; candidates refresh.
- **Holder rules:** Candidates never include held, pinned, external, running or unreadable stacks.

### P4 · Review and destroy… / Deny (agent request)

- **Location:** Request card; request notice [Review]; Agents card [Review in Supabase]
- **Preconditions:** Request pending; stack in a fresh list; not unreadable; any running lane attached belongs to the requester.
- **Disabled reasons (visible copy):**
  - This request is already being settled.
  - Lane :<port> belongs to another session. Stop that lane first, or deny the request.
  - This CLI can't read the stack, so it can't destroy it. Deny the request.
- **Confirmation:** main-dialog-token
- **CLI:** `If running `any validated <bin> stack stop --stack-id <id> --output-format json`; then `any validated <bin> stack destroy --stack-id <id> --yes --output-format json`; settle via supabase.settle-request {requestId, decision, removeUploads?, confirmationToken?}; Deny settles with no dialog`
- **Progress:** Card reads Destroying feat/old-ui…; Deny removes the card.
- **Success copy:** Destroyed feat/old-ui as Codex session 3f2a91c0 asked. Freed 71 MB. · Request denied. Codex session 3f2a91c0 is told on its next call.
- **Failure:** The card stays with the reason.
- **Holder rules:** Dialog shows only main-derived facts, never the agent's note; requests expire after 30 min.

### P4 · Release hold

- **Location:** Overview › Who holds this [Release…]; Agents card backend line
- **Preconditions:** A session or worktree hold (lane holds end with the lane; your pin uses Unpin).
- **Confirmation:** inline
- **CLI:** `main-only: supabase.release-hold {stackId, holder}`
- **Progress:** Instant; a countdown appears if nothing else holds it.
- **Success copy:** Released Codex 3f2a91c0's hold. feat/payments stops in 60 s unless something else holds it.
- **Failure:** Could not release the hold: <message>.
- **Holder rules:** ConfirmAction only while the holder is live; abandoned holders release with no prompt; a live session in the worktree still keeps it running.

### P4 · Reveal in Finder (unreadable stack)

- **Location:** Clean up › Unreadable; Unreadable notice
- **Preconditions:** The folder exists under SUPABASE_HOME/stacks.
- **Disabled reasons (visible copy):**
  - The folder is gone.
- **Confirmation:** none
- **CLI:** `main-only: supabase.reveal {stackId}; main resolves <SUPABASE_HOME>/stacks/<id> (realpath inside SUPABASE_HOME, no symlinks) and calls shell.showItemInFolder; nothing is deleted`
- **Progress:** Instant.
- **Success copy:** Silent (Finder opens).
- **Failure:** Could not reveal the folder: <reason>.
- **Holder rules:** Copy: RN Devtools never deletes stack folders. If no worktree uses another Supabase CLI release, removing the folder discards the stack.

### P5 · Apply pending migrations

- **Location:** Database › Migrations
- **Preconditions:** Running healthy database; same release; HEAD == branch_context; managed or adopted; state pending (not out-of-order or missing-local).
- **Disabled reasons (visible copy):**
  - Start the stack first. Migrations need a running database.
  - The worktree is on <current>. Switch back to <branch> to change this database.
  - No pending migrations.
  - <version> sorts before the last applied migration. Reset the database to apply it in order.
  - <n> applied migrations are missing from this branch. Switch to the branch that has them, or reset the database.
- **Confirmation:** inline
- **CLI:** ``<bin> migration up --local --workdir <root> --output-format json`, then `<bin> migration list --local --workdir <root> --output-format json`; never --db-url`
- **Progress:** Applying 20261016090000… (1 of 2).
- **Success copy:** Applied 2 migrations to feat/login-flow.
- **Failure:** Main's migration_failed title and recovery + [Open logs].
- **Holder rules:** ConfirmAction with a live agent holder: schema changes can block its queries.

### P5 · Reset to migrations + seed… / Reset without seed… (and Review and reset…)

- **Location:** Danger zone; request card
- **Preconditions:** Running healthy database; same release; HEAD == branch_context; managed or adopted; not pinned. A request card exists only when someone besides the requester holds the stack.
- **Disabled reasons (visible copy):**
  - Start the stack first. A reset needs its database running.
  - The worktree is on <current>. Switch back to <branch> to change this database.
  - Pinned stacks are protected. Unpin it first.
  - This stack runs on another Supabase CLI release. Stop it, then start it with this worktree's CLI.
- **Confirmation:** main-dialog-token
- **CLI:** ``<bin> db reset --local --workdir <root> --output-format json` or with `--no-seed`; never --db-url or --yes`
- **Progress:** StepList Stop services, Reset, Migrations n of N, Seed, Restart, Buckets; about 5 s.
- **Success copy:** feat/login-flow reset to migrations and seed. · feat/login-flow reset to migrations; seed skipped.
- **Failure:** Database reset did not finish (main recovery) + [Stop and start]; old data is gone.
- **Holder rules:** Dialog names live holders: its app sees an empty database and signed-out users.

### P5 · Re-seed buckets / Export schema… / Export data…

- **Location:** Database › Storage and Export
- **Preconditions:** Running; seed: storage included, buckets configured, HEAD match; export: --local when HEAD matches and same release, else main-held DB_URL.
- **Disabled reasons (visible copy):**
  - No buckets are configured for this project.
  - Storage is excluded from this stack.
  - Start the stack first. An export reads the running database.
  - Another export is running.
- **Confirmation:** inline
- **CLI:** ``<bin> seed buckets --local --workdir <root> --output-format json`; main save dialog then `<bin> db dump --local --workdir <root> --file <main path> [--data-only] --output-format json` (moved branch: `--db-url <DB_URL>?sslmode=disable`)`
- **Progress:** Seeding buckets… · Exporting…
- **Success copy:** Buckets seeded: 1 created, 1 updated, 14 files uploaded. · Exported feat/login-flow's data (63 KB). Storage files aren't included. [Show in Finder]
- **Failure:** Storage didn't answer; it may be waking. Try again in a few seconds. · Export failed: <message>.
- **Holder rules:** Re-seed always confirms inline (same-name files are overwritten); export has no confirm and no restore exists.

### P5 · Enable Studio… / Disable Studio / Open Studio

- **Location:** Connect; Services studio row
- **Preconditions:** Managed or adopted; same release; HEAD == branch_context; memory not critical (enable); Open needs Studio running.
- **Disabled reasons (visible copy):**
  - The worktree is on <current>. Starting this stack would load <current>'s settings. Switch back to <branch> first.
  - RN Devtools didn't start this stack. Adopt it first.
  - Memory pressure is critical; Studio needs about 1-2 GB.
- **Confirmation:** main-dialog-token
- **CLI:** `Stop then `<bin> stack start --stack-id <id> --runtime native --exclude analytics --output-format json` (disable: --exclude <excl>), lsof, status; Open: main-only supabase.open {surface: 'studio'}`
- **Progress:** StepList Stop, Start, Verify; Opening Studio… it can take about 18 s to wake.
- **Success copy:** Studio is on for feat/login-flow. It sleeps after 5 min idle. · Studio is off again for feat/login-flow.
- **Failure:** Classifier copy; Studio stays as it was.
- **Holder rules:** Disable is an inline ConfirmAction with a live agent; the choice persists per stack.

### P5 · Follow branch, Destroy and recreate…, Logs auto-refresh

- **Location:** Stale-branch notice; needs-recreate notice; Logs toggle
- **Preconditions:** Follow: held, HEAD stable 30 s, no rebase/merge/cherry-pick/revert/bisect marker, new branch opted in. Recreate: stack_changes failure, stopped, HEAD == branch_context. Auto-refresh: Logs open, window visible, running.
- **Disabled reasons (visible copy):**
  - A rebase is in progress in this worktree; following waits until it finishes.
  - The worktree is on <current>, so a new stack would belong to <current>. Switch back to <branch> first.
  - Auto-refresh needs a running stack; history stays readable.
- **Confirmation:** main-dialog-token
- **CLI:** `Follow: `<bin> stack start --workdir <root> --runtime native --exclude <excl> --output-format json`, Metro restart, then stop the old id. Recreate: destroy with --yes, then start --workdir (recreate_command never run). Auto-refresh: `<bin> stack logs --stack-id <id> --tail 1000 --since <last ISO> --output-format json` every 5 s`
- **Progress:** StepLists; auto-refresh pauses after 10 min with [Resume].
- **Success copy:** Now following feat/nav-v2 on :26211. feat/old-ui's stack stopped; its data comes back when you switch back. · feat/auth recreated with a fresh, migrated, seeded database.
- **Failure:** Holds stay on the old stack; a failed recreate start leaves Not created with [Start].
- **Holder rules:** Only Recreate uses the dialog; Follow and auto-refresh need none. Follow moves holds to the new stack.

### P5 · Capacity-parked start, app traffic links, paths

- **Location:** Request card; Overview App traffic and connected banner; Settings › Paths
- **Preconditions:** Parked request (new protocol) with requester HEAD still on its branch; app traffic needs a linked session with captured requests; Supabase home change needs no managed stack running.
- **Disabled reasons (visible copy):**
  - Choose a stack to stop.
  - The worktree moved to <current> since the request. Dismiss it.
  - App not linked: it doesn't report its Simulator.
  - Stop every managed stack before changing the Supabase home.
- **Confirmation:** inline
- **CLI:** `Stop chosen id, then `<bin> stack start --workdir <requester root> --runtime native --exclude <excl> --output-format json`; Show traffic: none (classifier + Network intent); Paths: main-only supabase.choose-path {field} with a main file dialog`
- **Progress:** Card Starting feat/tags…; system file dialog for paths.
- **Success copy:** feat/search stopped and feat/tags started for Claude session 9b1e2c00. · Supabase home set to ~/alt/.supabase.
- **Failure:** The card stays with the reason. · That folder can't be used: <reason>.
- **Holder rules:** ConfirmAction when the chosen stack has a live holder; the new stack gets the requester's hold; requests expire after 30 min.

## Wireframes

### Stacks view (P4 complete) (1040x700, content 815x652 (sidebar drawn separately), Demo set A: 10 stacks; LAN-exposed external, 1 agent destroy request, 1 unreadable; feat/login-flow selected)

```text
+------------------------------------------------------------------------------------------------+
| Supabase (i) [Alpha] 3 running · 4 stopped · 1 starting             [Refresh] [Clean up 3] [Gear]|
| x 1 stack listens on your network. It runs on Docker; RN Devtools stopped it once.  [Show it]    |
| ! Codex session 3f2a91c0 asks to destroy feat/old-ui (71 MB).  [Review]     + 1 more notice v    |
| RUNNING 3 / 12      | POSTGRES SLOTS 6 / 32 | MEMORY 1.2 GB          | DISK 2.1 GB             |
| 1 starting          | 26 free               | RSS · measured 5 s ago | 1.7 GB is shared cache  |
| [Stacks|Repositories|Requests 1] [Search: Branch, :port, agent] [All stacks (10) v] [Select]    |
+-----------------------------------+------------------------------------------------------------+
| x legacy-main          [External] | SUPABASE STACK                       [RUNNING] [Managed]   |
|   LAN-exposed · Docker · stopped  | feat/login-flow                                            |
| o feat/checkout                   | ~/src/app-wt/login-flow · 64616c83…145f                    |
|   Starting… 2 s · lane :8106      | [Stop] [Restart services] [Keep running] [Open lane]       |
|>* feat/login-flow       [*Claude] | v Overview                                                 |
|>  Running · lane :8102 · API :21734   Running · database healthy · 5 services asleep           |
| * feat/payments          [>Codex] |   WHO HOLDS THIS                                           |
|   Running · idle · API :24410     |   * Claude 9b1e2c00 · live · via lane :8102 [Open in Agents]|
| * main                   [Pinned] |   * Lane :8102 · Metro ready                   [Open lane] |
|   Running · idle · API :22990     |   * iPhone 16 Pro · booted            [Open in Simulators] |
| . feat/old-ui  (5 more below)     |   @ feat/login-flow · HEAD matches · API :21734            |
+-----------------------------------+------------------------------------------------------------+
| > Supabase activity · 1 running (feat/checkout · Starting · 2 s)                                |
+------------------------------------------------------------------------------------------------+
```

Glyphs: * running (green dot), o in flight (blue), . stopped (grey), x danger (red), > selected row; always with a word. Budget at 700 px: header 72, 2 notices about 38 each (the +N toggle sits at the end of the last notice), metrics 82, toolbar 45, activity 45, leaving 332 px = five 64 px rows. Unchanged .sim-fleet-layout: list about 277 px, detail about 538 px at 1080 px and below. Line 2 labels every port. [Select] is icon-only at 1080 px and below. P1: header shows only Refresh and Gear, the toggle only Stacks|Repositories, no Select, no action row, no activity row.

### Stacks view, wide (1440x900, content 1212 px (reduced scale), Same data)

```text
| [Stacks|Repositories|Requests 1] [Search] [All stacks (10) v] [Select multiple]   10 matching  |
+-------------------------------------------------+----------------------------------------------+
|>* feat/login-flow                     [*Claude] | detail capped at 820 px, centred             |
|>  Running · API :21734 · lane :8102 · iPhone 16 Pro                                            |
| * feat/payments                        [>Codex] | RUNNING 3 / 12 · all held (or next to stop:   |
|   Running · idle · API :24410 · no lane · 52 MB |   <branch>)                                   |
| . feat/search                                   |                                              |
|   Stopped 16 d · prune suggested · 44 MB        |                                              |
```

From 1220 px the list is minmax(310px,37%), about 448 px; rows add the Simulator name and size; Select multiple keeps its label; the toolbar meta and titlebar metrics return.

### Sidebar: Backend group and badge (1040x700 sidebar (225 px), Supabase active; red badge (a stack is LAN-exposed))

```text
| SIMULATOR                    |  Badge (simulatorBadge):
|  Simulators          12  ⌘1  |  [3] red    any danger item (LAN-exposed, exposure
|  ...                         |             unknown, failed, needs recreate)
|  Lanes                   ⌘7  |  [2] amber  requests and warnings only
| BACKEND                      |  3   grey   nothing needs you: running count
|> Supabase            [3]  ⌘8 |  none       off, unsupported, not live, and all of P1
| SYSTEM                       |
|  Settings            [1]  ⌘9 |  Settings keeps its amber capability count.
| ⌘ 1–9  Navigate Simulator    |  Accessible name: Supabase, 3 need attention
```

Groups come from SimulatorToolDefinition.group (simulator, backend, system); one .tool-nav-item per tool (smoke.e2e.ts:48-59). The footer hint is already derived by formatShortcutRange (app.tsx:227).

### Detail: Overview and what happens next (detail pane at 1040 (about 494 px inside padding), Running; held by a live Claude lane; an abandoned Codex hold also recorded)

```text
| v Overview
|   Running · database healthy · 5 services asleep (start on first request)
|   WHO HOLDS THIS                                                 (i)
|   * Claude 9b1e2c00 · live · via lane :8102        [Open in Agents]
|   * Lane :8102 · Metro ready                            [Open lane]
|   * iPhone 16 Pro · booted                     [Open in Simulators]
|   * feat/login-flow · ~/src/app-wt/login-flow · HEAD matches
|   @ This stack · API :21734
|   Also held by  Codex 3f2a91c0 · gone 3 min · hold ends 14:20 [Release…]
|   Created by    lane up · Claude 9b1e2c00 · today 12:02
|   WHAT HAPPENS NEXT
|   Keeps running while Claude 9b1e2c00 is live. 60 s after the last release
|   it stops; data is kept. Never deleted on its own.
|   Runtime native · loopback only (lsof, 2 min ago) | CLI 2.121.0 · verified
|   Disk 64 MB + 2 MB uploads · as of 14:02 | Stack id 64616c83…145f [Copy]
|   Inspect  pnpm exec supabase stack status --stack-i… [Copy]
|   App traffic (P5)  uses this stack · 48 requests · 5 s ago  [Show traffic]
| Other next-event lines: Stops in 45 s · data kept [Keep running] | Claude
| 9b1e2c00 is gone; stops at 14:20 (in 7 min) [Keep running] [Stop] | Kept
| running: Codex 3f2a91c0 works in this worktree | Pinned by you · never stopped
| automatically [Unpin] | Prune suggested Oct 31 if still stopped (muted, never
| automatic) | Auto-stop paused: agent sessions can't be read now.
```

WHO HOLDS THIS is a HeroUI Pro Timeline (CSS already imported, styles.css:28; renders ol/li): success live, warning gone, muted absent; one navigation button per link. Created by stays separate from holders. WHAT HAPPENS NEXT comes from pure nextEvents(row, policy, now): amber Timer for auto-stop, muted CalendarClock for the never-automatic prune suggestion, countdowns in output with aria-live off. The Inspect text is built by main. P1 variant: origin External, holders are observed relationships (lane on the same worktree and branch, live session cwd), no action row or Danger zone.

### Detail: Services and Database (detail pane at 1040, Running; 1 of 7 awake; 2 pending migrations; moved-branch variant)

```text
| v Services · 1 of 7 awake · 5 asleep                    checked 14:02:31
|   database  * running · healthy · eager                     db :21736
|   rest      (moon) sleeping · starts on first request (~0.4 s)
|   auth      (moon) sleeping · starts on first request (~0.8 s)
|   ...realtime ~2.6 s, storage ~1.1 s, functions ~0.6 s, mail :21739
|   Excluded by Settings: studio, analytics. Waking auth also wakes mail.
|   ! Studio is back on; its SQL endpoint has no authentication while it
|     runs.                                   [Re-apply exclusions] (P3)
|   ! Config changed since start: services.auth.site_url
|                                        [Stop and start to apply] (P3)
| v Database                                        checked 14:02:31 [Refresh]
|   Size 11 MB · index hit 99.8% · table hit 99.1% · WAL 16 MB
|   public.notes ~1,000 rows 2.1 MB · public.profiles ~42 rows 48 kB
|   MIGRATIONS · 12 applied · 2 pending
|   20261016090000  Oct 16, 09:00  pending · 20261017080000  pending
|   [Apply 2 pending] (P5)  [Export schema…] [Export data…] (P5)
|   [Re-seed buckets] (P5)  Storage files aren't in exports; no restore.
|   Moved branch: stats still read through main's in-memory DB address;
|   migration status isn't computed; {Apply pending} The worktree is on
|   feat/other. Switch back to feat/login-flow to change this database.
```

Services rows come from composition.members[] in CLI words and tone buckets, never from top-level readiness; status refreshes every 10 s only while inspected and visible. Database reads run on open and Refresh only (inspect db-stats, table-stats, migration list); rows are versions plus times. Mutations are --local only and need HEAD == branch_context.

### Detail: Logs and Connect (detail pane at 1040, History of all services; Connect while running)

```text
| v Logs  [All services v] [Last 200 lines v] [Filter lines] [Refresh]
|   | --- launch 2 · rest ---
|   | 14:02:11 gateway GET /rest/v1/notes?select=id&limit=1 200 3ms
|   | 14:02:40 auth    POST /token grant_type=[REDACTED] 200
|   | --- 3 stdout lines lost · rest ---
|   Redacted · 214 lines · 48 KB of 64 KB · read 14:03:05  [Copy shown]
|   12 lines match notes. History stays readable while stopped.
|   P5: [ ] Auto-refresh while open. Never in v1: live follow.
| v Connect
|   API URL http://127.0.0.1:21734 [Copy] · REST …/rest/v1 [Copy]
|   Functions …/functions/v1 [Copy] · Database port :21736 [Copy psql command] (P3)
|   Publishable  the local default key, same on every stack  [Copy key] (P3)
|   Secret       Not shown by RN Devtools. Run pnpm exec supabase status
|                in the worktree.
|   Mailpit :21739 · asleep [Open Mailpit] (P3) · Studio excluded [Enable Studio…] (P5)
|   EXPO_PUBLIC_SUPABASE_URL <- API_URL · ..._PUBLISHABLE_KEY <- PUBLISHABLE_KEY
|   Values stay in RN Devtools.                [Copy app variables] (P3)
|   ! .env.local:3 sets EXPO_PUBLIC_SUPABASE_URL; Expo reads it instead.
|   Keys and the database password never reach this window.
```

Logs: one focusable pre over main-redacted records (lines at most 2,000 characters, 64 KiB total). Windows map to --tail 200 or --tail 1000 --since 10m|1h|start; filtering is client-side with a role=status count. Connect: loopback URLs use CopyButton; key, psql and app variables use MainCopyButton (main writes the clipboard; receipt has no value). Command text and runner come from main.

### Detail: Danger zone and first-start progress (detail pane at 1040, Running (Destroy disabled); a cold-cache create with failure variants)

```text
| v Danger zone (closed by default)
|   Reset database (P5)   [Reset to migrations + seed…] [Reset without seed…]
|   Drops all data and auth users, then re-runs 12 migrations and the seed
|   (about 5 s). Keeps the stack id, URL, ports and keys. No backup is kept.
|   Destroy stack (P4)                                        {Destroy…}
|   Stop it first. Destroy runs only on a stopped stack.          [Stop]
|   Other reasons: Lane :8102 is attached and running. Stop the lane in
|   Lanes first. | Pinned stacks are protected. Unpin it first. (Reset)
+--
| SUPABASE STACK  feat/onboarding                [CREATING…] [Managed]
| [Cancel start…]  Cancelling lets the CLI clean up (up to 45 s).
| Starting feat/onboarding · 18 s. First start on this Mac downloads
| services once (usually about 45 s); later stacks take about 5 s.
|   ok  Check room · 3 of 12 running · 26 Postgres slots free
|   >>  Download services · one time, up to about 360 MB
|   ..  Start the database | Apply migrations 0 of 3 | Seed data
|   ..  Verify it listens only on 127.0.0.1 | Attach to lane :8110
|   x   Failure: Migration failed. Fix the failing migration, then apply
|       again. The failed migration was rolled back.  [Open logs] [Try again]
|   x   Port pinned by another stack: 54321 for api, held by the stack of
|       ~/src/app-wt/spike.  [Open that stack] [Review repository]
```

Danger zone rows are .sim-danger-zone; the span is the consequence or the visible disabled reason. Two reset buttons, so each native dialog binds one exact op. StepList is a HeroUI Pro Timeline (success, current with aria-current, muted, danger); steps come from main-parsed redacted stderr plus lsof and lane attach; no percentages. Failure title and recovery come from main's ClassifiedSupabaseError.

### Attention notices (1040x700 content width, Tab-level (ranked, cap 2) and detail-level, one recovery each)

```text
| TAB: x 2 stacks listen on your network. They run on Docker; RN Devtools
|        stopped them once.                                   [Show them]
|      ! 3 stacks need attention: 1 failed to start, 1 runs another CLI
|        release, 1 isn't responding.          [Show them]  + 2 more v
| DETAIL:
| ! CLI mismatch. Stop, Destroy and log history work; database tools and
|   status don't. Data is kept.        [Stop] [Restart with this CLI] (P3)
| ! Owner not responding. Stop asks it to shut down; after 90 s RN Devtools
|   ends the owner once it is sure it belongs to this stack.      [Stop]
| ! Stale branch. The worktree moved to feat/nav-v2; agents' local commands
|   reach that branch's stack. This one keeps its data; switching back
|   reattaches it. Resume and database changes stay off. P5: [Follow]
| . Never started. Start creates its database, migrations and seed.
| x Failed to start: the first start left an empty stack. [Try again] [Destroy…]
| x Interrupted: can't be resumed.          [Destroy and start again…] (P4)
| ! Observed only: Supabase CLI 2.122.0 isn't verified.  [Review repository]
| x LAN-exposed: Docker listens on every interface with public default keys.
|   Stopped once, never attached.          [Stop…] [Destroy…] (P4)
| ! Worktree deleted: stopped at once. Destroy to free 64 MB and 10 ports.
| ! Unreadable: this CLI can't decode its state. RN Devtools never deletes
|   stack folders.                                [Reveal in Finder] (P4)
| x Needs recreate (P5): [db] major_version saved 15 -> requested 17.
|                                              [Destroy and recreate…]
| ! 12 of 12 stacks are running and all are in use.  [Show running stacks]
```

attentionItems() ranks danger, then requests, then warnings; suggestions (stale branch, prune) never become notices or badge counts. Danger notices use role=alert, warnings role=status. Unreadable never offers Destroy: the CLI fails on undecodable state (destroy/SIDE_EFFECTS.md) and the desktop never deletes stack folders.

### Off, unsupported, loading, empty and errors (1040x700 content (small multiples), Feature off; Intel Mac; first load; no stacks; failures)

```text
| OFF: Supabase (i) [Alpha] Off                                       [Gear]
|   metrics show dashes (off | checked when on); toolbar [Stacks|Repositories]
|   Local Supabase is off. Give each worktree and branch its own local
|   Supabase on 127.0.0.1 ... native runtime, never Docker. Alpha.
|   ok This Mac can run it: Apple silicon, macOS 15.1
|   [Turn on local Supabase…]   Off means off: nothing runs or polls.
| UNSUPPORTED: meta Not available on this Mac; ! Native Supabase needs
|   Apple silicon and macOS 14 or later. This Mac: Intel, macOS 13.6.
|   metrics dashes; no toolbar, no gear; nothing is probed.
| LOADING: dashes with Skeleton; 3 skeleton rows; Select a stack to inspect
| EMPTY: No stacks yet. Start a lane on a worktree whose repository opts in,
|   or let an agent run rndevtools backend --operation up. Detail: Getting
|   started (repository readiness). FILTER: No stacks match these filters.
| BRIDGE: ! Supabase controls need the secure desktop bridge. Open the
|   packaged RN Devtools app.
| CRASH (existing PanelErrorBoundary): Supabase could not render [Open Simulators]
| QUARANTINED: x Supabase settings couldn't be read, so local Supabase was
|   turned off. Running stacks were left as they are.   [Open settings]
| DEMO: (i) Demo stacks. Nothing runs and nothing is saved.
```

The metric grid stays in the off state so e2e can assert .sim-metric-grid. The platform verdict comes from main without spawning anything. Panel failure uses error-boundary.tsx:56-106 with panelRecovery.

### Repositories view (1040x700 content, Three tracked repositories; ~/src/app selected)

```text
| [Stacks|Repositories|Requests 1] [Search] [All repositories (3) v] [Track repository…]
+-----------------------------------+------------------------------------------------------------+
|>~/src/app               2 fixes   | REPOSITORY  ~/src/app · app apps/mobile        [Re-check]   |
|   4 worktrees · 2 managed         | Use local Supabase here [Auto v] (P3) [Pre-download services]|
| ~/src/admin            Observed   | ok Platform      Apple silicon · macOS 15.1        READY    |
|   CLI 2.122.0 not verified        | x  Stack flag    missing in feat/a, feat/b      NEEDS FIX   |
| ~/src/site          No Supabase   |    [experimental] stack = true            [Copy snippet]   |
|                                   | ok config.json   none                              READY    |
|                                   | x  Pinned ports  config.toml:12 api.port = 54321 NEEDS FIX  |
|                                   |    Delete these lines; only one stack can use a pinned port |
|                                   | ok Supabase CLI  2.121.0 · verified · pnpm exec    READY    |
|                                   | !  App env files .env.local:3 shadows a mapped name CHECK   |
|                                   | .  Recommended   disable Studio and analytics   OPTIONAL    |
|                                   | Worktrees: main managed (running :22990) [Show stack] ...   |
|                                   | RN Devtools never edits repository files.  [Open in Lanes]  |
```

Checks use an exported ReadinessRow (from CapabilityRow, settings-panel.tsx:391-471). File and line facts come from main's static scan (project.ts). Fixes are copy-only. Track repository reuses lane.add-repository.

### Requests and Clean up (P4; capacity card P5) (1040x700, full-width column (max 820 px), 1 destroy request, 1 parked start, clean-up groups, 1 unreadable)

```text
| [Stacks|Repositories|Requests 2]                       2 to decide · 3 suggested
| AGENT REQUESTS
| ! Codex session 3f2a91c0 (live) asks to destroy feat/old-ui (71 MB) · 4 min ago
|   Stopped · no lane attached · nothing else holds it.
|   Agent's note: Fresh database for the migration test. (sanitized, 240 chars)
|   [Review and destroy…] [Deny] [Open stack]
| ! (P5) Claude session 9b1e2c00 needs a database for feat/tags; 12 of 12 run,
|   all in use. Make room: [feat/search · Codex 77c0d2aa · idle 2 h v]
|   [Stop it and start feat/tags] [Raise the limit] [Dismiss]
| CLEAN UP        ON DISK 412 MB | SUGGESTED 179 MB | SELECTED 64 MB  [Refresh]
| [x] Worktree deleted · feat/gone · 64 MB      No downside; uploads went too.
| [ ] Stale branch · feat/old-ui · 71 MB        Lane up recreates one in ~5 s.
| [ ] Stopped longer than 14 days · feat/search · 44 MB
| [ ] Failed to start · 0
|  -  Unreadable · 7f3c2a10… · 12 MB  never selectable   [Reveal in Finder]
| 1 stack selected · a system dialog confirms     [Destroy 1 stack (64 MB)…]
| Last clean up destroyed 2 stacks and freed 120 MB · Oct 15, 14:02 (status)
| Not suggested: 2 held, 1 pinned, 1 starting, 1 external. Never automatic.
```

RequestCard (block layout, never controls inside PanelNotice's inline span). The agent's note appears only here, never in a dialog. PruneSection copies DiskInventorySection (fleet-panel.tsx:1567-1745): revision-keyed selection, risk and recovery copy, one trigger with the size, role=status result. Worktree deleted and Failed to start are preselected.

### Bulk selection (P3 Stop, P4 Destroy) (1040x700 content, Select multiple on; 4 selected)

```text
| [Stacks|Repositories|Requests 1] [Search] [All stacks v] [Stop 3] [Destroy 1…]
|   [Done selecting]  4 selected · Stop skips 1 stopped · Destroy skips 3 running
+-----------------------------------+------------------------------------------------------------+
| [x] * feat/login-flow  [*Claude]  | SELECTION                                       4 of 10     |
| [x] * feat/payments    [>Codex]   |   feat/login-flow running · Claude 9b1e2c00 (live) via lane |
| [x] * main             [Pinned]   |   feat/old-ui stopped · 71 MB · requested for destroy       |
| [x] . feat/old-ui                 | Stop 3: two live agents lose their database. Data is kept.  |
| [ ] . feat/search                 | Destroy 1…: stopped stacks without a running lane only.     |
```

ListView multiple mode renders selection checkboxes; cap 20 (fleet-panel.tsx:589-594); counts are eligible-only; the bulk group wraps as one unit at 1080 px and below.

### Settings view and global Settings row (1040x700 content, Feature on; P3/P5 sections; 2 unsaved changes)

```text
| Supabase (i) [Alpha] Settings                       [Refresh] [Clean up 3] [Gear pressed]
| LOCAL SUPABASE (ALPHA)                                      [On]  Turn off…
|   Platform Apple silicon · macOS 15.1 READY | Supabase CLI 2 verified, 1 not
|   NEEDS SETUP [Open Repositories] | Docker found · never used | Supabase home
|   ~/.supabase | Postgres slots 6 of 32 | Trust model accepted Oct 16
| Capacity and idle (P3): Max running [12] 1–24 · safe ceiling 12 | Stop after
|   release [60] s | Abandoned grace 10 min (fixed) | Suggest cleanup [14] days
| Services (P3): Exclude by default [on] Studio [on] Analytics [off] Pooler
| Safety (P3): [on] Stop Docker or Podman stacks once | [off] Allow unverified
|   patch releases of 2.121 (system dialog)
| App variables (P3): EXPO_PUBLIC_SUPABASE_URL <- API_URL [x] | [+ Add variable]
|   [Use Supabase + Expo preset]
| Lane defaults (P3): development [Auto] staging [Off] production [Off]
| Branch switch (P5) [Follow|Warn] | Paths (P5) Supabase home [Choose…]
|                                     2 unsaved changes [Reset] [Apply 2 changes]
| GLOBAL SETTINGS > Optional features: Local Supabase (alpha) [On · 3 running]
|                                                      [Open Supabase settings]
```

Replaces metrics, toolbar and body with .sim-settings-scroll > .sim-settings-layout. Policy form follows CaptureRetentionControls (captures-panel.tsx:837-975). Trust changes act at once through main dialogs: feature on/off, including Studio by default, allowing unverified patches. The global row calls openInSupabase({view:'settings'}).

### Native confirmations (main-owned) (macOS message boxes, Destroy (single, live holder, bulk), reset, turn on/off, Studio, external stop, policy trust changes, recreate)

```text
| ! Destroy the local Supabase stack for feat/old-ui?
|   Deletes its database and logs. This can't be undone. Worktree ~/src/app-wt/old-ui
|   Stack 64616c83… · native · 71 MB · frees 10 ports · keeps the 1.7 GB cache
|   Codex session 3f2a91c0 (live) asked for this 4 min ago.
|   [ ] Also delete Storage uploads (12 MB in …/stack-uploads/64616c83…)
|                              [Destroy feat/old-ui (71 MB)]  [<< Cancel >>]
| Live holder: Codex session 3f2a91c0 (live) holds feat/payments' stopped stack.
|   Destroy it anyway?                    [Destroy anyway (52 MB)] [<< Cancel >>]
| Bulk: Destroy 3 local Supabase stacks (179 MB)? (10 named, then and N more)
| Reset: Reset the database for feat/login-flow? Drops all data and auth users,
|   re-runs 12 migrations and the seed. No backup.  [Reset feat/login-flow]
| Turn on: native not Docker; single-user Mac; stacks run outside agent
|   sandboxes; Codex over MCP is attributed by worktree; experimental.  [Turn on]
| Turn off (managed stacks running): [Stop managed stacks] [Leave them running]
|   [<< Cancel >>]
| Studio: Studio and its SQL endpoint .../mcp have no authentication and answer
|   any origin; about 1-2 GB awake, about 18 s to wake.        [Enable Studio]
| External: RN Devtools didn't start this stack; an agent or you may be using it.
| Policy: Allow unverified Supabase CLI patch releases? | Stop excluding Studio
|   by default? | Recreate: [db] major_version saved 15, requested 17.
```

buttons ['Cancel', verb] (Turn off: ['Cancel', 'Leave them running', 'Stop managed stacks']), defaultId 0, cancelId 0, noLink, type warning; macOS draws button 0 rightmost, so Return and Esc cancel. checkboxChecked returns as removeUploads in the confirmation result and is bound into the 60 s single-use 'supabase' token. Text is built by main from a fresh stack list and sanitized; agent free text never appears.

### Cross-panel: Lanes, Fleet, Agents, connected app (1040x700 Lanes, Fleet, Agents view, Network, P3 lane and fleet integration; P5 traffic mismatch)

```text
| LANES start form: WORKTREE [feat/tags · Supabase v] SLIM [none v]
|   BACKEND [Auto (development) v]  [Start Metro]
|   Backend: starts or resumes this worktree's database (about 5 s; first
|   start about 45 s); the app opens when it is ready.
|   Other worktree: BACKEND {Off}  Observed only: the stack flag is missing.
| LANE ROW: feat/login-flow :8102 ready · iPhone 16 Pro · [*Claude] [db :21734]
| LANE DETAIL: v Backend [db :21734] Running · stack 64616c83… · API [Copy]
|   Injected names only · Held by this lane · Claude 9b1e2c00 (live)
|   [Open in Supabase] [Restart Metro to attach] [Stop backend]
| FLEET: filter With backend (2) · row chip [db :21734] · Lane section line
|   Backend [db :21734] running · stack 64616c83… [Open in Supabase]
| AGENTS card: [1 device · 1 backend] · BACKENDS [db :24410] feat/payments ·
|   backend up · live [Open in Supabase] [Release…] (P4) · ! Asked to destroy
|   feat/old-ui [Review in Supabase] (P4)
| CONNECTED (P5): ! ExampleApp talks to the stack for feat/payments (:24410),
|   not its lane's stack (:21734): 12 of 14 requests. [Open in Supabase]
|   [Show this traffic] · Network rows get [lane stack] [feat/payments stack]
|   [hosted abcd1234] badges · Diagnostics BACKEND card: Other stack
```

Lane chip tones are lane-relative: db :port success; db starting, stopped, stale, shadowed, blocked, skipped amber; db refused · LAN red. The Backend select's reason is visible text with aria-describedby (unlike Slim's title, lanes-panel.tsx:631-634). Banner slot is the offline banner (app.tsx:1099); verdicts come from shared classifyAppTraffic over redacted entries with main's signature.

## Corrections applied from the judges

- Every start of a stopped stack (by --stack-id) is HEAD-gated: Resume, every Stop and start variant, Studio, Destroy and start again, and recreate. Capacity starts check the request's branch. Restart services stays allowed. Recreate keeps the same id only while HEAD matches.
- Logs follow is removed. History ships in P1; auto-refresh through --since comes in P5.
- Copy TypeScript types is removed, because the dialect has no operation for it.
- The working tree's PanelErrorBoundary, action-notice.ts and formatShortcutRange are reused instead of re-planned. The .gitignore lib/ rule must be fixed first.
- e2e: insert supabase before settings, add the panel heading, Mod+8 opens supabase, Mod+9 opens settings, footer 1–9, smoke nav count 9.
- Unreadable stacks are never selectable for destroy and offer only Reveal in Finder. Main's recovery copy is corrected to match.
- Cancel is the default in every native dialog, including Turn off. The trust policy toggles go through dialogs.
- Agent free text never appears in native dialogs. Nothing derived from a key (no fingerprint) reaches the renderer. Key, psql and app-variable copies go through MainCopyButton.
- Adopt runs status and lsof only. Releasing a live holder uses ConfirmAction; an abandoned holder releases with no prompt.
- Holder liveness and countdowns come from resolveHolderLiveness/holderClockKey; holdCountdownLabel lives in device-hold.ts. Prune copy always says suggested.
- The UI handles all 17 classifier codes (including container_runtime, ports_conflict, confirm_required and flag_misuse). There is no transient code; a single retry happens when retry is once.
- On a moved branch, reads go through main's DB_URL with sslmode=disable; mutations are --local only; migration status is shown only when HEAD matches.
- Phases follow the CLI rollout order; db dump is P5. Every phase has shipped.
- Layout: the unchanged .sim-fleet-layout, 64 px rows, at most 3 header controls, no 44% grid, no table mode, no inbox region.
- ConfirmAction gains describedBy. StepList is built on Timeline, not Stepper. .sim-state-pill.is-info is fixed. Metrics use only default, success and warning tones. SearchControl gets a width hook.
- Destroy requires a stopped stack. Batch selection is capped at 20; at most 32 ids per call.
- Off means off, but the metric grid stays visible. The controlled Disclosure keeps existing defaultOpen callers working. connectedSessionsForSimulator moves to fleet-model.ts before it is reused.

## Ideas grafted from the other designs

- From attribution-topology: the Who holds this chain on Timeline in Overview, with liveness and Open-in buttons and Created by kept separate.
- From attribution-topology: a pure nextEvents() that shows an amber auto-stop countdown, kept visually distinct from the muted, never-automatic prune suggestion.
- From attribution-topology: labelled ports and a compact chain on row line 2.
- From attribution-topology: native dialogs for the two trust changes (Studio included by default, unverified patch releases); Release confirms only while the holder is live; Adopt only reads status; Destroy anyway as graduated wording in a single dialog.
- From attribution-topology: the Start (stops <branch>, idle 2 h) label, one panel-level useNow(), ConfirmAction describedBy, ReadinessRow exported, and the lanes.focusLane intent.
- From attention-inbox: one attentionItems() ranker that drives notices, the Needs attention filter and the red/amber badge.
- From attention-inbox: supabaseTabState() and a fixed availability order, both covered by it.each tests.
- From attention-inbox: Studio-drift copy that names the exposure, cwd keepers shown in Overview, and Destroy refused while a running lane is attached.
- From attention-inbox: two reset buttons, a per-repository Auto/Off override, reads only on open or Refresh, and no P1 badge.

## Risks and open questions

- Stale-branch stacks can't be resumed in v1 because of the HEAD gate. If a recorded fixture shows that stack restart --stack-id on a stopped stack resumes from saved settings (restart/SIDE_EFFECTS.md says restart may launch an owner), add Resume with saved settings.
- Studio with --exclude analytics is unverified: FINDINGS says waking Studio also wakes analytics. Test it before shipping Enable Studio.
- Keeping DB_URL in main memory (MainOnlyCredentials, cli-contract.ts:126-170) contradicts DESIGN.md:976-980, which strips it at parse time. That needs a DESIGN amendment and a sslmode=disable fixture against native Postgres.
- The publishable key, the psql command (which contains the local password) and the app variables land on the system clipboard, where clipboard managers may keep them.
- ActionNotice has a single slot, so concurrent operations overwrite each other. Per-stack progress therefore lives in the rows, the detail and the activity Disclosure.
- App-traffic evidence needs host wiring: the app must report its Simulator UDID (simulatorUdidFromPath) and route supabase-js through instrumented fetch. No evidence will be the common case, and Realtime WebSockets are never captured.
- Error classification matches message text recorded against 2.121.0. Recheck it on every CLI bump and on the planned stack→local rename.
- Making Disclosure controlled must not change its uncontrolled callers or the native keyboard behaviour of details/summary.
- The .sim-state-pill.is-info fix also recolours the Simulator booting, creating and shutting-down pills. That is intended.
- Capacity-parked starts and lane defaults stored in the policy are new protocol and need DESIGN amendments.
- An unreadable stack may still be in use by another CLI release. The Reveal in Finder copy warns about this but can't verify it.
- Stopping or destroying an external Docker stack depends on Docker answering. Only the time budgets and a copyable command recover from a hang.
- Badges and chips stay absent through P1, until the P3 cheap tier runs.
- Timings and memory figures come from one Mac on 2.121.0. Copy says about, and the values live in one constants table.
- The demo seam must never reach packaged builds. Test the RNDEVTOOLS_DEMO && !app.isPackaged helper.
- Using Timeline for a chain that isn't a sequence in time needs a screen-reader check. The fallback is a plain ol with dot markers.
- LanesPanel keeps its view and selection in local state, so seeding them from the new focus intent requires a small Lanes change.

## Decisions for the maintainer

- Keep tool id supabase as the brief decided, or use the critic's neutral backends id with the Supabase label? The UI is the same either way.
- Use ConfirmAction for every interruption of a live agent's database, or only for Stop (critic R24)?
- Store lane defaults in the Supabase policy, or make lane environments editable as DESIGN §5 implies?
- Build capacity-parked starts in P5, or keep refusing the start permanently?
- After a fixture confirms it, offer Resume with saved settings (stack restart) on stale-branch stacks?
- Should main clear the clipboard 60 s after it copies the key, the psql command or the app variables?
- Ship the disk walker, log history and database reads in P1 (the dialect allows them), or keep DESIGN's later phases?
- Approve the DESIGN amendments: DB_URL kept in main memory, unreadable stacks never destroyed, the HEAD gate on resume, the phase list aligned with the dialect, Cancel as the default for Turn off.
- Approve running the CLI to record fixtures: restart from stopped, Studio with analytics excluded, logs with --since, sslmode=disable reads.

## Mockup brief

**Visual rules for every frame**
- Dark only: black surfaces, Geist and Geist Mono.
- Brand green only for success, active and focus states.
- Amber for warnings, red for danger, blue only for in-flight states.
- Agent hues (Claude #d97757, Codex #8b9dff) appear only on agent glyphs.
- Every dot carries a word.
- Frames at 1040x700 show no horizontal overflow.

**Data: demo set A**

Repositories:
- ~/src/app: managed in 2 of 4 worktrees; app directory apps/mobile.
- ~/src/admin: observed (CLI 2.122.0 is not verified).
- ~/src/site: no Supabase project.

Stacks (10):

| Stack | State | Details |
|---|---|---|
| legacy-main | external, Docker, LAN-exposed, stopped | 88 MB |
| feat/checkout | Starting… | lane :8106, iPhone 15 |
| feat/login-flow | running, 1 of 7 awake | held by lane :8102, Claude 9b1e2c00 (live), iPhone 16 Pro, API :21734, db :21736, mail :21739, 64 MB, id 64616c83…145f, CLI 2.121.0, pnpm exec supabase |
| feat/payments | running, idle | held by Codex 3f2a91c0 via backend up, API :24410 |
| main | running, idle | pinned, API :22990 |
| feat/old-ui | stopped, stale branch | worktree now on feat/nav-v2, 71 MB, destroy requested 4 min ago |
| feat/search | stopped 16 days, prune suggested | 44 MB |
| feat/gone | worktree deleted | 64 MB |
| 7f3c2a10… | unreadable | 12 MB |
| feat/onboarding | not created | — |

Summary values:
- Metrics: 3/12 running, 6/32 slots, 1.2 GB memory, 2.1 GB disk.
- Header: Clean up 3. Toolbar: Requests 1 (2 with the P5 card).
- Sidebar badge: red, 3.

**Frames**

| # | Frame | Viewport | State |
|---|---|---|---|
| 1 | Stacks view (P4) | 1040x700 | feat/login-flow selected |
| 2 | The same view | 1440x900 | — |
| 3 | P1 variant of frame 1 | 1040x700 | External badges, no action row, no Requests, no Clean up |
| 4 | Sidebar | — | Badge variants |
| 5 | Detail: Overview | — | Plus the abandoned, unheld, pinned and stopped next-event lines |
| 6 | Detail: Services and Database | — | — |
| 7 | Detail: Logs and Connect | — | — |
| 8 | Detail: Danger zone | — | Destroy disabled |
| 9 | First-start StepList | — | Cold cache, with the failure step |
| 10 | Attention notices | — | Tab level and detail level |
| 11 | Off | 1040x700 | — |
| 12 | Unsupported | 1040x700 | — |
| 13 | Loading and empty | — | Small multiples |
| 14 | Repositories | — | ~/src/app selected |
| 15 | Requests and Clean up | — | — |
| 16 | Bulk selection | — | 4 selected |
| 17 | Settings view and global Settings row | — | — |
| 18 | Destroy dialog | macOS | Uploads checkbox, Cancel rightmost and default |
| 19 | Other dialogs | — | Reset, Turn on, Turn off, Studio |
| 20 | Lanes | — | Start form with Backend, chip rows, Backend section |
| 21 | Fleet and Agents | — | Chips and held backends |
| 22 | Connected Network | — | Mismatch banner and badges (P5) |
| 23 | Reduced-motion variant of frame 9 | — | Static icons |


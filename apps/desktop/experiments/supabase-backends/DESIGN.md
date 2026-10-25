# Per-worktree local Supabase for lanes: design

> **Status:** implemented on 2026-10-17; [IMPLEMENTATION.md](IMPLEMENTATION.md) records what shipped, how it was verified and where it departs from this design (names say `supabase`, not `backend`). The [as-built notes](#as-built-notes) at the end list engine behaviours that a later repo-wide review changed. Produced on 2026-10-16 from research, a hands-on spike, and tag-level verification; see [FINDINGS.md](FINDINGS.md).
> **Pinned upstream:** Supabase CLI 2.121.0. Supabase source references are relative to `supabase/cli@v2.121.0` unless they say `@develop`. rndevtools references are relative to the repository root, at commit a415937.
> **Origin:** three competing designs (managed, adopt, risk-first MVP) were scored by two judges. MVP ranked first and managed second, within about one point of each other, so this design is a synthesis of the two.

## Verdict

**Yes, with conditions.** Native (no-Docker) Supabase is the right runtime for per-worktree backends in rndevtools on Apple-silicon Macs with macOS 14+. It is also the only Supabase runtime compatible with the repo's loopback rule and your builder-security policy.

**The conditions:**
1. **The machine and the trade-off.** It runs on a single-user Mac, and you accept that stacks are separate databases rather than isolated tenants:
   - shared public default keys;
   - `supabase_admin` trusted on loopback;
   - CORS `*`;
   - a process table shared by every agent.

   That isolation gap is why Supabase recommends Docker for several projects.
2. **The repos.** Every target repo commits `[experimental] stack = true`, removes Docker-era pinned ports, and pins one exact `supabase` version that both the desktop and the agents run.
3. **The runtime.** The desktop creates every stack with `--runtime native` and verifies loopback-only listeners. It never uses auto or Docker.
4. **The alpha guardrails.** The integration stays an opt-in alpha behind a version-gated, fail-closed adapter with kill criteria, because the `stack` commands are outside Supabase's compatibility promise and are slated to become `local`.
5. **The prerequisites.** The rndevtools defects in Phase 0 are fixed first.

**What the measurements say.** On those terms the numbers fit a fleet of agents comfortably:
- 4.5 s for a new worktree's stack, migrations and seed included;
- 1.0 s to resume;
- about 160 MiB per idle stack;
- automatic, collision-free ports;
- at most about 32 Postgres servers per Mac, shared with shadow databases.

**Where it does not fit:**
- physical-device testing (loopback only);
- Intel Macs and shared multi-user Macs;
- setups that rely on agent OS sandboxes for containment;
- repos that cannot drop pinned ports.

There is also no supported pre-migrated database clone today, so every new worktree or branch pays its migrations and seed.

## Summary

**Short answer: yes.** Native (no-Docker) Supabase fits per-agent backends for rndevtools. It fits as an opt-in alpha, on Apple-silicon macOS 14+, on a single-user Mac.

**What the spike settled** (this Mac, CLI 2.121.0, macOS 26 arm64; the spike (FINDINGS.md)):
- **Isolation per worktree.** Each git worktree gets its own stack automatically. The stack id is sha256 of the realpath, the HEAD ref and `default`. Each stack gets its own ports from 20000-32767, and they stay the same across stop and start.
- **Loopback only.** Every listener binds 127.0.0.1.
- **Timings:**

  | Operation | Time |
  |---|---|
  | New worktree's stack, migrations and seed included | 4.5 s |
  | Restart | 1.0 s |
  | Stop | 3.2 s |
  | `db reset` | 4.6 s |
  | First start on the machine (one-time 1.7 GiB artifact cache) | 42.6 s |

- **Memory:**

  | State | Footprint |
  |---|---|
  | Idle (only Postgres awake) | about 150-171 MiB |
  | App services awake | about 885 MiB |
  | Studio awake | about 1.9 GiB |

**The trade-off you would be accepting.** Supabase's own docs recommend Docker for several local projects on one machine, because native stacks share the host's process table and file locks. This design deviates from that on purpose. Docker/Podman proxies bind 0.0.0.0 with well-known credentials (v2.121.0 packages/stack/src/Network.ts:111), and the repo's loopback rule and your builder-security policy forbid that as a default.

So the stacks are **separate databases, not isolated tenants**:
- Default keys are public constants shared by every stack.
- `supabase_admin` is trusted without a password through each stack's loopback port.
- The gateway answers CORS `*`.
- Any agent running as you can stop or read any other agent's stack.

The enable dialog states this plainly.

**What gets built**
1. **Three worktree modes:**
   - `off`.
   - `observed`: a project is found but can't be managed (flag missing, config conflict, CLI missing or unverified, unsupported platform).
   - `managed`: the desktop owns create, resume, stop and destroy.

   Agents are steered to RN Devtools only in managed worktrees, and only while the desktop is actually running. Everywhere else they start their own stack with `supabase start --runtime native`, under a corrective hook.
2. **Managed lanes.**
   - `lane up` (development environment) ensures the worktree's native stack while the Simulator boots.
   - That lane's Metro gets only the API URL and the publishable key, under configurable names.
   - A `backend up|down|ls|status|env` tool serves database-only tasks.
   - Agents keep `supabase … --local` with the worktree's own CLI.
3. **A fail-closed adapter:**
   - CLI `--output-format json` only;
   - a dialect table of verified versions (2.121.0 today);
   - recorded fixtures and a per-phase argv allowlist;
   - parsing that drops every secret field;
   - kill criteria.
4. **Cheap read-only discovery:**
   - every 15 s: `pgrep`/`ps` for owner processes and one read-only SELECT on `ports.sqlite`;
   - `stack list` only when the set of stacks changes;
   - `status` only on demand.
5. **Safety rails:**
   - `--runtime native` on every create and resume;
   - an `lsof` check over each stack's process tree after every start, failing closed;
   - Studio and analytics excluded;
   - Docker/Podman stacks never attached to a lane and stopped once;
   - destroy never automatic, and always behind a main-owned dialog plus a one-time token.
6. **UI.**
   - A Backends view: a Lanes-panel toggle in Phase 1, its own tool on shortcut 9 from Phase 3.
   - It shows every stack with its worktree, branch, lane, Simulator, holder, runtime and exposure, ports, disk and flags.
   - Chips in Lanes, Fleet and Agents, plus a Settings section.

**Main choices**
- **Keys.** v1 uses the CLI's shared default keys.
- **Waiting.**
  - `backend up` waits at most 30-45 s, then returns a job for `wait --condition job`.
  - `lane up` waits at most about 15 s for a cold backend. After that it attaches the backend late and defers the dev-client launch until then.
  - `release --all` releases holds in memory and stops stacks in the background.
- **Cleanup.** Stops are automatic:
  - 60 s after release;
  - 10 min after abandonment;
  - at once for deleted worktrees.

  Destroys are never automatic.
- **Branch switches.** Followed after HEAD has been stable for 30 s with no rebase or merge in progress.
- **Capacity.**
  - At most 12 stacks run at once on this Mac. The cap comes from `kern.sysv.shmmni=32`, a limit shared with shadow databases.
  - New stacks are created one at a time, because 2.121.0 does not reserve native backend ports in its registry.

**Phases**
- Phase 0 fixes the rndevtools defects a backend would inherit:
  - the holder clock;
  - Codex-over-MCP attribution;
  - the desktop's 60 s handler cap versus 240 s in the CLI and Codex's tool timeout;
  - `release --all` reporting;
  - the lane reservation race and port-only Metro health;
  - redactor gaps and the unredacted `lane.log`;
  - inherited `EXPO_PUBLIC_*`;
  - LaneStore quarantine.
- Phase 1 is a single read-only PR behind a Settings flag.
- Phase 2 adds corrective agent steering.
- Phase 3 adds managed lanes.
- Phase 4 adds the agent tool and managed steering.
- Phase 5 covers hygiene and Phase 6 optional hardening.
- Phase 7 is a review: graduate the feature or kill it.

**Other recommendations**
- **In each target repo:**
  - commit `[experimental] stack = true`;
  - delete the pinned ports;
  - pin `supabase` exactly as a devDependency;
  - consider `[studio] enabled = false` and `[analytics] enabled = false`;
  - keep `EXPO_PUBLIC_SUPABASE_*` out of the app's `.env`, `.env.local` and `.env.development*`. Expo 57 dev bundles let those files override the lane's Metro env, even with `EXPO_NO_DOTENV=1`.
- **Habits and scope:**
  - Create the branch before `lane up`.
  - Use Supabase Branching only for PR previews.
  - File the upstream asks.

## Key decisions

### Which design is the base, and how the judges' disagreements are settled

**Choice.** **Backbone: the MVP design.** It contributes:
- Phase 0 prerequisite PRs;
- a single read-only Phase 1 PR behind a Settings flag;
- a dialect table with recorded fixtures;
- a per-phase argv allowlist;
- kill criteria K1-K6.

**Grafts.**
- From the managed design: lifecycle, protocol, holder model, admission control, debounced branch follow and UI.
- From the adopt design: cheap discovery tier, status through the owner's binary, projections that drop secret fields, the rule that a lane never fails because of its backend, corrective fallback hook, and onboarding cards.

**Disagreements settled.**
- In-lane wait (engineering said about 15 s, experience said up to 45 s): 15 s inside `lane up`, and 30 s default / 45 s maximum for `backend up`.
- Running cap (8 vs 12): derived from `kern.sysv.shmmni`, which gives 12 on this Mac.
- UI placement: the view starts as a Lanes-panel toggle and becomes its own tool in Phase 3.

**Why.** Both judges ranked MVP first (69.4 and 78.4) for alpha containment and incremental cost. Managed scored highest on agent UX, operator UX and LAN containment. Adopt is the only design whose steering keeps working when the desktop is closed.

The in-lane wait has to stay well under Codex's per-call MCP timeout. The installed Codex 0.162.1 has a `tool_timeout_sec` key, and setup.go:309 writes none. A closed socket aborts the handler (agent-cli-service.ts:402-409).

**Rejected.** - **Managed as-is:** the largest build, and its hook locks agents out when the feature is off or the desktop is down.
- **Adopt as-is:** no automatic provisioning, Studio /mcp on by default, and it attaches a stack even when lsof fails.
- **MVP as-is:** synchronous 300 s calls, raw 5 s branch follow, `db start` left unblocked, and a session-wide disable on an id mismatch.

### Who owns the stack lifecycle

**Choice.** Three worktree modes, recomputed on every reconcile:
- **off:** the feature is off, there is no `supabase/config.toml` between the app and the worktree root, or the environment sets `backend: off`.
- **observed:** a project exists, but the flag is missing or false, `config.json` conflicts, the CLI is missing or unverified, or the platform is unsupported. The desktop lists and flags stacks; the operator can stop or destroy; nothing is created.
- **managed:** the desktop owns create, resume, stop and destroy. Agents keep the `--local` data-plane commands.

While the desktop is running, managed worktrees steer agents to `backend` and `lane`. Everywhere else agents run `supabase start --runtime native` themselves.

**Why.** Settings the desktop applies through flags or env do not survive an agent's own lifecycle command:
- a start after a stop re-reads config and reverts keys (Credentials.ts:135-142);
- `--exclude` persists only for `stack restart`;
- `supabase start`, `db start` and `db schema declarative generate|sync --local` all create stacks with runtime auto (stack-local-database.ts:220-246; generate.handler.ts:180-185; sync.handler.ts:282).

A managed-only model, however, dead-ends agents whenever the desktop is closed, the feature is off, or the CLI is unverified. Both judges flagged this as a fatal flaw.

**Rejected.** - **Always desktop-owned (managed, MVP):** dead ends.
- **Never desktop-owned (adopt):** no automatic per-agent stack, and sandboxed agents cannot start one.
- **Session-wide SUPABASE_EXPERIMENTAL_STACK injection by setup:** flips repos that never opted in.

### Runtime

**Choice.** - **Native only.** Every desktop create and resume passes `--runtime native`. The feature is offered only on darwin-arm64 with macOS 14 or later.
- **Never probe engines.** The desktop never uses `auto` and never probes Docker.
- **Docker/Podman stack on a managed worktree's identity:**
  - never attached to a lane;
  - stopped once per detection and flagged `lan-exposed`, with the user notified;
  - destroy-and-recreate natively offered behind the destroy dialog.

**Why.** Auto probes Docker, then Podman, then native. Each probe has a 10 s timeout, and Docker hangs on this Mac. The choice is saved with the stack (stack-runtime.ts:72-100). Container proxies bind 0.0.0.0 (Network.ts:111).

Stopping in a loop would fight an agent whose bare start reuses the saved Docker runtime.

**Rejected.** - Docker as the default or as a fallback (Supabase's recommendation).
- Repeatedly auto-stopping container stacks.
- Docker as an opt-in in this design. It would need its own LAN-exposure design.

### Integration surface and alpha containment

**Choice.** **The CLI's `--output-format json` is the only control surface.** The dialect table works like this:
- **2.121.0:** verified, command group `stack`.
- **Newer patch of the same minor:** compatible. The worktree is observed, and stop and destroy are allowed. It is managed only with `allowUnverifiedPatch` plus a live contract probe.
- **Anything else:** unsupported.

**Guards around it:**
- a per-phase argv allowlist;
- a static test that the adapter never emits `--runtime auto|docker|podman`, `stop --all`, `--stack <name>`, `status --env`, `--eager`, or `--yes` outside the token path;
- kill criteria K1-K6.

**Read-only side channels:**
- owner argv;
- one SELECT on `ports.sqlite`;
- gitdir HEAD.

The desktop never reads `state.json` or `owner.json`, and never calls the owner's HTTP API.

**Why.** - `@supabase/stack` is private.
- `state.json` holds credentials in plaintext; `owner.json` holds a bearer secret.
- The `stack` group is outside Supabase's compatibility promise, and a planned `local` rename lists only start/stop/status/logs (docs/cli/dev-alpha-command-structure.md:86-90, 163-167).

**Rejected.** - Embedding `@supabase/stack`.
- Parsing private files or calling POST /shutdown.
- Best-effort parsing of any version.
- Hard-blocking every non-exact version, which would also block stop and cleanup.

### Which supabase binary the desktop runs

**Choice.** | Purpose | Binary |
|---|---|
| Create or resume | the worktree's own platform binary |
| Status of a live owner | the owner's argv[0], only if it passes the same validation; otherwise the recorded binary, then the worktree binary |
| Stop and destroy | any validated binary (these work across releases) |

**Resolving the worktree binary.** Mirror the npm shim: find `node_modules/supabase/package.json` from appPath and then from the project root, which handles nested pnpm workspaces.

**Validation.**
- The realpath must be inside the worktree, or inside the repository's main checkout (for worktrees that symlink node_modules).
- The file must be owned by the user and not group- or world-writable.
- The versions of `supabase` and `@supabase/cli-darwin-arm64` must be equal.

No PATH, Homebrew, npx or bundled binary is used.

**Why.** An owner serves only clients of its own release (HostProcess.ts:323-329). The release id is a digest of the stack sources, not the semver: npm and Homebrew 2.121.0 both carry 0.1.0+a559977f2134f3a5, and develop differs.

Owner argv can be set by any same-user process. Executing an unvalidated argv[0] from the desktop would run it with the desktop app's macOS privacy (TCC) permissions.

**Rejected.** - A CLI bundled with or downloaded by the desktop: release mismatch with the agents.
- A global lookup.
- Running owner argv[0] unvalidated.
- `SUPABASE_CLI_BINARY_OVERRIDE`.

### Addressing and identity

**Choice.** - **Create:** `stack start --workdir <realpath project root>`, run from an empty 0700 `userData/backends/cwd`.
- **Everything after:** the full 64-hex `--stack-id`. Config loads from the saved projectRoot (stack.shared.ts:203-212; start.handler.ts:564).
- **Identity check.** The expected id is computed with native realpath and gitdir HEAD, as a canary only. On a mismatch, trust the CLI's id and flag `identity-canary` on that worktree.

**Why.** - `--local` commands see only the default-named stack of the current branch (stack-local-database.ts:55-61).
- The owner inherits the client's cwd (HostProcess.ts:495-516). A neutral cwd keeps it out of deletable worktrees and stops the CLI's unbounded upward search for config.toml.

**Rejected.** - Named stacks per lane.
- Id prefixes.
- Trusting a predicted id.
- Disabling managed starts for the whole session on a mismatch (MVP).

### Call timing and jobs

**Choice.** - **`backend up`:**
  - Waits up to `waitMs` (default 30 s, maximum 45 s), then returns `{status: starting, jobId}`.
  - The handler budget is `waitMs` + 10 s.
- **`lane up`:**
  - Runs ensure in parallel with boot and slim.
  - Waits at most 15 s past the point where Metro would spawn.
  - If the backend is still not ready, Metro starts without the mapped names and the dev-client launch is deferred. A late attach then restarts Metro with laneEnv and launches.
- **`down` and `release --all`:** never wait for stops.
- **Job ids:** kept in a persisted ring, so `wait` after a desktop restart answers `job_lost` with the recovery `backend up again`.

**Why.** - **Warm operations fit in one call:** 4.5 s, 1.0 s, 3.2 s, 4.6 s.
- **Cold paths do not.**
  - A first-ever start takes 42.6 s.
  - Databases get up to `db.health_timeout` (2 min).
  - Each service startup command gets 60 s, then 60 s for readiness (ProcessRecipe.ts:217-218, 584).
- **Client budgets are short.**
  - Codex's per-server tool timeout has an upstream default of 60 s.
  - Claude Code's Bash timeout defaults to 120 s.
  - The SessionEnd client has 2 s (app/setup.go:235-236).
- **Deferring the launch** keeps the app from booting against a missing or hosted URL.

**Rejected.** - Synchronous 300 s calls (MVP).
- Always asynchronous calls.
- A 45 s wait inside `lane up` (managed).
- 610 s handler timeouts.

### Holds and attribution

**Choice.** **`BackendHold` kinds:**
- **lane:** derived from lanes.json.
- **session:** an attributed `backend up`.
- **worktree:** for synthetic `mcp-*` callers; live while a discovered session of that kind has its cwd inside the worktree.
- **operator:** Pin.

In addition, any live session whose cwd is inside the worktree keeps the stack from being stopped, except the requesting session for its own down or release.

**Mechanics.**
- One resource-agnostic liveness helper is exported from device-hold.ts, and `deviceHoldSchema` is unchanged.
- Synthetic is detected by the prefix, so nothing new is persisted.
- When discovery reports `unavailable`, abandonment clocks freeze instead of starting.

**Why.** - Every Codex MCP call shares `codex:mcp-codex-mcp-client` (server.go:340-356; FINDINGS.md:159-162).
- Claude Code does pass CLAUDE_CODE_SESSION_ID to MCP servers (verified live).
- A Codex discovery failure returns an empty list (agent-sessions.ts:160-200), which today would start everyone's clock.

**Rejected.** - Widening `deviceHoldSchema`.
- Keying holds on synthetic ids.
- Refusing a second app lane in one monorepo worktree.
- Adding a `synthetic` field to laneSchema, which is a downgrade hazard.

### Persistence

**Choice.** - **`userData/backends/backends.json`:**
  - strict v1, at most 128 records;
  - 0700 directory, 0600 file, atomic rename;
  - quarantined on any JSON or schema failure;
  - no secrets: only fingerprints of the public keys.
- **`policy-v1.json`.**
- **`steering.json`** in the agent socket directory.

lanes.json and `laneSchema` are untouched; lane backend summaries travel on the wire only.

**Why.** - lane-store.ts:47-58 silently ignores a lanes.json that fails the schema, then overwrites it.
- desktop-settings-store.ts:36 throws on unknown fields.

Separate files are invisible to older builds and survive worktree deletion.

**Rejected.** - `laneSchema.backend`.
- lanes.json v2.
- Links kept in memory only.

### How backend values reach the app

**Choice.** - **Where the values go:** only the dev Metro's spawn env, as `laneEnv`.
- **Merge order:** stripped process.env, then metroEnv, then laneEnv, then the fixed keys.
- **Mapping policy:** `{name, source}`, where the source is one of API_URL, REST_URL, FUNCTIONS_URL, PUBLISHABLE_KEY or ANON_KEY.
- **Preset:** the provider module ships EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY.
- **Stripped from the desktop's inherited env:** EXPO_PUBLIC_*, SUPABASE_*, PG* and RNDEVTOOLS_*.
- **Conflicts:**
  - A mapped name already set by `environment.metroEnv` means `pinned-by-environment`: that name is skipped.
  - A mapped name defined in the app root's `.env`, `.env.development`, `.env.local` or `.env.development.local` means `shadowed`: auto warns, required fails.

**Why.** - **Metro's env is the only channel.** Lanes force EXPO_NO_DOTENV=1, and the dev serializer reads EXPO_PUBLIC_* from Metro's env at serve time, so a restart picks up new values.
- **But dotenv files win.** Expo 57's dev env module merges those four files over process.env (node_modules/@expo/metro-config 57.0.12 build/transform-worker/transform-worker.js:160-163). EXPO_NO_DOTENV is checked only by @expo/env.

**Rejected.** - Writing .env files: they get bundled, and `status --env` leaks secrets.
- A static metroEnv per environment.
- Mapping secret sources.
- Trusting EXPO_NO_DOTENV as a guard.

### When a worktree 'actually uses Supabase'

**Choice.** A static, bounded read (256 KiB per file) between appPath and the worktree root, never above. It checks:
- `supabase/config.toml` exists (required);
- `[experimental] stack = true` as a TOML boolean, in table or dotted form;
- whether `supabase/config.json` exists, which gives `config-conflict`;
- pinned listener keys in config.toml, and `SUPABASE_*_PORT` in `supabase/.env*` and the project root's `.env*`;
- the lockfile, which gives the runner hint (`pnpm exec`, `npx`, `yarn`, `bunx`).

By default only the development environment is auto.

**Why.** - Routing reads config.json for the flag, while stack start loads only config.toml (paths.ts:27-37; local-project-context.ts:81-91).
- An `env()` value fails decoding and routes to the legacy backend.
- The project root's dotenv files also feed SUPABASE_* overrides (project-environment.ts:95-139).

**Rejected.** - Detecting a supabase-js dependency.
- Evaluating app.config.js.
- Climbing above the worktree root, the way the CLI does.

### Pinned ports

**Choice.** - No port leasing.
- The first stack runs normally.
- Later starts fail fast with `ports_pinned`, naming the stack that holds the ports and the exact lines to delete.
- A compatibility mode exists only in Phase 6.
- The desktop reads ports from every start JSON, and restarts Metro whenever `endpoint_changes` or the ports differ.

**Why.** - Configured ports are exact requests.
- Env-pinned ports are re-planned by agents' own starts.
- A configured port can take over a stopped stack's automatic reservation, so 'sticky' is not guaranteed (Ports.ts:330-352).

**Rejected.** - Editing config.toml.
- `SUPABASE_*_PORT` leasing by default.

### Default services

**Choice.** - **Every desktop create and resume** passes `--exclude studio,analytics`.
- **Recommended repo config:** commit `[studio] enabled = false` and `[analytics] enabled = false`, so agents' bare starts keep the exclusion.
- **Drift:** a `composition-drift` flag, plus a Re-apply exclusions action.
- **Studio** is a per-backend opt-in behind a dialog (Phase 5).
- **Everything else** stays lazy. `--eager` is never used.

**Why.** - **Cost:** Studio awake costs about 1.9 GiB and an 18 s wake.
- **Exposure:** `/mcp` exists only when Studio is a member (host/Endpoints.ts:99-103) and has no auth. The ports dedicated to Studio, pg-meta, Mailpit and analytics share the same proxy, with its CORS `*`.
- **Worktree hygiene:** Studio snippets block a non-force `git worktree remove`.

**Rejected.** - The full default composition.
- Excluding functions by default, which would break `functions serve --local`.
- Writing SUPABASE_STUDIO_ENABLED into worktrees.

### Agent steering

**Choice.** - **No Supabase rules at all** unless the user has enabled local backends (steering.json says so).
- **Managed mode**, active only when the steering file is at most 3 min old, a connect to the desktop socket succeeds, and the effective directory is inside a managed root:
  - lifecycle verbs, `db start`, `--runtime` and versioned runners are redirected to `backend`;
  - commands that create stacks or shadow databases are blocked while the branch's stack is not ready.
- **Fallback mode**, in opted-in projects otherwise:
  - `supabase start --runtime native` is allowed;
  - bare `start` and auto/docker/podman runtimes are blocked, with the exact corrected command;
  - `db start` is blocked;
  - declarative generate/sync against local is allowed only when chained after a native start.
- **Always on** while the feature is enabled:
  - `stop --all`;
  - stopping another worktree's stack;
  - `stack destroy`;
  - pkill/killall of stack processes;
  - `status --env > .env*`.
- **Mechanics:** a per-segment tokenizer that fails open. MCP text depends on the outcome, so it never dead-ends.

**Why.** - **Judges' fatal flaws:** the managed and MVP designs dead-end agents, and MVP missed `db start` and the declarative commands.
- **Why the socket connect check:** the socket is removed on a clean quit (agent-cli-service.ts:259-268), but a crash leaves a stale file.
- **Why MCP text comes first:** Codex hooks need manual trust and Cursor has no hooks. MCP alone reached 12/12 adoption (FINDINGS.md:20-27).
- **Why feature-gated:** teams that never enable the feature, or chose Docker on purpose, are untouched.

**Rejected.** - Unconditional blocks.
- Relying on the hook alone.
- A regex over the whole command line.
- A hook check that computes the stack id and stats the stack directory: a mismatch would lock agents out.

### Exposure verification

**Choice.** - **Exposure = runtime + lsof.** A container runtime means LAN-exposed.
- **The lsof check** covers the stack's process tree: the owner, the launchers matched by `supabase-stack-id=<id>`, and their children. It checks TCP LISTEN and bound UDP.
- **Any address other than 127.0.0.1 or [::1]:** stop the stack, flag `lan-exposed`, and fail the operation.
- **If lsof fails** after a desktop start: stop and report.
- **No 'loopback' mark from JSON.** The UI never shows a loopback check mark based on JSON addresses.

**Why.** - JSON endpoint addresses are always 127.0.0.1, even when container listeners bind 0.0.0.0 (Network.ts:111-113).
- The builder-security policy says 'verify, do not detect'.

**Rejected.** - Adopt's attach-as-`listeners-unverified`.
- Checking only the JSON `address`.

### Per-stack secrets

**Choice.** - **v1 keeps the CLI default keys,** labeled 'port-isolated, not credential-isolated'.
- **Phase 6 opt-in: a full per-stack key set.**
  - Contents: JWT secret, publishable key, secret key, and an ES256 signing-key file.
  - Written once per worktree into a gitignored `supabase/.env.local`, checked with `git check-ignore`.
  - The key file lives outside the repo with mode 0600.
  - Drift fingerprints catch reverts.

**Why.** - **The JWT secret alone is not enough.** The default ES256 private key and the `sb_secret_` constant still grant service_role (ServiceConfig.ts:29-64; HttpProxy.ts:122-130).
- **A worktree file survives agents' starts.** supabase/.env.local is read by every CLI command (project-environment.ts:95-139), so keys written there survive agents' bare starts; desktop-only env does not.

**Rejected.** - Per-stack keys by default.
- Desktop-only `SUPABASE_AUTH_*` env, which a bare restart reverts silently.
- Keys in the app's .env files.

### Branch switches

**Choice.** `follow` is the default and `warn` is optional. The desktop follows only when all of these hold:
- HEAD has been stable for 30 s;
- the worktree gitdir has none of these markers: rebase-merge, rebase-apply, MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD, BISECT_LOG;
- the stack is held.

Then it:
1. ensures the new identity natively;
2. moves the holds;
3. restarts the attached Metro;
4. stops the old stack, keeping its data and flagging it `stale-branch`.

Switching back reattaches the old stack. An explicit `backend up` follows immediately, with no debounce. The hook treats HEAD ≠ the recorded branchContext as 'not ready'.

**Why.** - HEAD is detached for the whole of a rebase (GitBranchContext.ts:107-120). Raw following would create 'detached' stacks and restart Metro twice.
- Shadows inherit the saved runtime of the current branch's default stack only if that stack exists (stack-shadow.ts:51-62).

**Rejected.** - Raw 5 s polling with no debounce (MVP).
- Pinning the old stack (blocked by #7162).
- Blocking `git switch`.

### Capacity and concurrency

**Choice.** - **Cap:** `maxRunning` = min(12, floor((shmmni − 8) / 2)), which is 12 here; settable from 1 to 24.
- **Admission, checked before every start:**
  - running stacks below the cap;
  - at least 2 free SysV segments (sysctl minus `ipcs -m`);
  - host memory pressure not critical (simulator-metrics-provider.ts:43-66).
- **Concurrency:** creations run one at a time; resumes and stops two at a time.
- **Over the cap:** stop the least recently used unheld managed stack, or else refuse with `backend_capacity`.

**Why.** - One SysV segment per postmaster, with shadow databases included: shmmni=32 is a hard ceiling for the machine.
- 2.121.0 does not register native backend ports. That code is only on develop, and the race can recur at lazy wakes.

**Rejected.** - No cap.
- A memory-only cap.
- Unlimited parallel creation.

### Garbage collection and retention

**Choice.** **Stops (data kept):**

| Condition | Stop after |
|---|---|
| Explicit release | a 60 s linger |
| Abandoned holder | 10 min after missingSince; Codex only after its 30-minute activity window |
| Orphan (project root missing on two consecutive checks) | at once |
| Superseded branch | the 60 s unheld linger |

**Destroy is never automatic.**
- It needs a dialog plus a token, and applies only to ids present in a fresh list.
- Prune candidates: orphaned; stale or stopped-and-unattached for more than 14 days; unreadable.
- Uploads are removed only through a checkbox with path checks.
- The desktop never deletes files under ~/.supabase.

**Why.** - **Stop is cheap and reversible:** 3.2 s to stop, 1.0 s to resume.
- **An unregistered full id is dangerous to destroy:** it makes destroy list Docker and Podman containers (destroy/SIDE_EFFECTS.md), and Docker hangs here.
- **Deleting state files is worse than useless:** it stops owners without cleanup and leaks PGDATA.

**Rejected.** - Auto-destroy.
- Never stopping.
- Deleting stack directories.

### Handling CLI processes

**Choice.** **Lifecycle children:**
- spawned detached (own process group);
- not tied to the request signal or to Electron's lifetime;
- stdout piped (a single JSON line);
- stderr to a 0600 progress file that is read through the redactor.

**Reads** use separate, fully drained pipes.

**On a start timeout:**
1. send SIGINT;
2. wait 45 s;
3. send SIGTERM.

Never SIGKILL. The stack is then flagged `interrupted`.

**Quitting and restarting the desktop.** Before quitting, the desktop waits at most 15 s, then leaves children running. On boot, it adopts surviving children by pid and argv.

**Why.** - There is no recovery journal, and abrupt termination of a first bootstrap requires a destroy (start/SIDE_EFFECTS.md, 'First startup and retries').
- An interrupt makes the CLI stop the owner it launched.
- CLI issue #6846 spins when a shared pipe closes.

**Rejected.** - SIGKILL after 5 s (MVP).
- Children on the request signal.
- Writing stdout JSON (which contains secrets) to disk.

### Discovery cadence

**Choice.** **Every 15 s while enabled.** One pass runs:
- `pgrep -U <uid> -f __supabase_stack_` and `ps` for argv;
- one read-only `SELECT state_root, stack_id, endpoint, port FROM reservation` with no transaction held;
- a stat of project roots and gitdir HEAD files.

No Supabase CLI process is involved.

**`stack list`** runs only when the set of ids changes, after lifecycle events, or every 5 min. It is single-flight and waits for in-flight creations.

**`status`** runs only on attach, on inspect, or while the detail drawer is open.

**Why.** - `stack list` probes every owner and briefly takes each idle owner's lock (Lease.ts:241-255).
- Writers on ports.sqlite wait at most 2 s (PortReservations.ts:96).

**Rejected.** - Polling `stack list` or per-stack status in a loop.
- Reading state.json.

### Naming and the agent surface

**Choice.** **Names.**
- The command kind is `backend`.
- Supabase strings live only in `main/backend/providers/supabase.ts` and one Go file, `setup/hook_supabase.go`.
- Env-name defaults are options.

**Operations.**
- Phase 4: `up`, `down`, `ls`, `status`, `env`.
- Phase 5: `reset`, `log`, and `destroy`, which parks a user request.

**MCP annotation:** readOnly false, destructive false.

**Why.** - **Naming rule:** root AGENTS.md says nothing product-specific goes in source.
- **Annotations:** catalog.go marks no tool destructive (meta struct at 59-64; only readOnly flags are set). `down` keeps data, and `destroy` is never executed by an agent.

**Rejected.** - A `supabase` command kind.
- Supabase strings spread across modules.
- `destructive: true` (managed).
- reset, snapshot or restore in v1.

## Architecture

## Shape

```text
agent shell / MCP (Claude Code, Codex)
  ├─ <runner> supabase … --local ──────────────── owner RPC ──▶ native stack owner (detached, 127.0.0.1 only)
  └─ rndevtools lane up · backend … · release ── 0600 unix socket, rndevtools/1 ──▶ AgentCliService ─▶ AgentCommandRouter
                                                                                                         │
renderer: Backends view/tool, chips ◀── IPC get/subscribe/run/confirm ── main/backend-ipc.ts ────────────┤
                                                                                                         ▼
           LaneService ◀── LaneBackendPort ──▶ BackendService (main; single owner of backend state)
                                                 ├─ backend/providers/supabase.ts   every Supabase string: package names, argv markers, argv builders,
                                                 │                                  error classifiers, env-name preset, default exclusions
                                                 ├─ backend/supabase-dialects.ts    verified versions → command group, allowed ops, fixture set
                                                 ├─ backend/supabase-cli.ts         resolve + validate binary, version gate, runner (curated env, neutral cwd)
                                                 ├─ backend/supabase-contract.ts    strip projections (no secret fields), envelope classifier, id canary
                                                 ├─ backend/backend-project.ts      static detection: flag, conflict, pinned ports, dotenv shadowing, runner
                                                 ├─ backend/backend-discovery.ts    pgrep/ps owner argv · ports.sqlite SELECT · gitdir HEAD + markers ·
                                                 │                                  lsof over process tree · sysctl/ipcs · du
                                                 ├─ backend/backend-jobs.ts         jobs, persisted job ring, adoption of detached CLI children
                                                 ├─ backend/backend-store.ts        userData/backends/backends.json   (P3)
                                                 ├─ backend/backend-policy-store.ts userData/backends/policy-v1.json  (P1)
                                                 └─ backend/steering-writer.ts      ~/Library/Application Support/RN Devtools/agent/steering.json (P2)
```

**Backend data crosses exactly four boundaries:**
- **IPC to the trusted renderer:** strict projections with no key material.
- **The 0600 agent socket:** public URL and publishable/anon keys, and only on `backend env`.
- **steering.json:** roots, modes and readiness; no secrets.
- **The dev Metro spawn env:** mapped public names only.

Nothing goes over the unauthenticated WebSocket broker.

## New modules
| File | Phase | Responsibility |
|---|---|---|
| `apps/desktop/src/main/backend/providers/supabase.ts` | 1 | **The only TS file that spells Supabase command words.** It holds:<br>- package names (`supabase`, `@supabase/cli-darwin-arm64`) and argv markers (`__supabase_stack_host__`, `__supabase_stack_native__`);<br>- argv builders per dialect, and the error classifier patterns tested against fixtures;<br>- the list-stderr warning pattern;<br>- the env-name preset and the default exclusions. |
| `…/backend/supabase-dialects.ts` | 1 | **Version table**, for example `2.121.0 → {group:'stack', gate:'verified', fixtures:'supabase-2.121.0', features:{multiDestroy, endpointChanges, nativeBackendPortClaims:false, inventory:true, destroy:true}}`.<br>- Newer patches of the same minor are `compatible`; everything else is `unsupported`.<br>- Each phase has an argv allowlist; Phase 1 allows only `--version`, `stack list` and `stack status --stack-id`.<br>- This is the only file a CLI bump should touch. |
| `…/backend/supabase-cli.ts` | 1 (reads), 3 (lifecycle) | **Resolver**, mirroring the shim (bin.ts:24-40): appPath first, then the project root; the realpath must be inside the worktree or the repository's main checkout; owner checks and no group/world write; package versions must be equal.<br>**Version gate:** `--version` (bare semver), cached by realpath, size, mtime and ino.<br>**Runner:**<br>- argv array, `shell:false`, curated env, empty 0700 cwd at `userData/backends/cwd`;<br>- reads use separate, fully drained pipes, with stdout capped at 512 KiB and stderr at 64 KiB;<br>- lifecycle children are detached, with stderr going to a 0600 progress file;<br>- every operation has its own budget and kill rule. |
| `…/backend/supabase-contract.ts` | 1 | - `z.object` (strip mode) projections for version, list, status, start, stop, destroy and the error envelope.<br>- Root-level `recreate_command`, `stack_changes` and `destroyed_stacks` are read too.<br>- A classifier maps errors to typed codes.<br>- `expectedStackId()` is a canary only.<br>- Raw buffers are dropped after projection, never logged, and never echoed in zod errors. |
| `…/backend/backend-project.ts` | 1 | **Static, bounded detection**; no project code is evaluated. It reads:<br>- `supabase/config.toml`, and flags `config.json` as a conflict;<br>- the `[experimental] stack` boolean;<br>- pinned listener keys with line numbers;<br>- `SUPABASE_*_PORT` in supabase/ and project-root dotenv files;<br>- app-root Expo dotenv files that define the mapped names;<br>- the lockfile, for the runner hint;<br>- gitdir HEAD and git-operation markers. |
| `…/backend/backend-discovery.ts` | 1 | **Read-only probes** through runSimulatorCommand (pinned PATH, timeouts):<br>- `/usr/bin/pgrep` and `/bin/ps -o pid=,ppid=,command=` for owner and launcher argv;<br>- node:sqlite readOnly on `<os.userInfo().homedir>/.supabase/ports.sqlite`, degrading the way agent-sessions.ts:121-153 does;<br>- `/usr/sbin/lsof -nP -a -p <tree pids> -iTCP -sTCP:LISTEN -iUDP -Fpn`;<br>- `/usr/sbin/sysctl -n kern.sysv.shmmni` and `/usr/bin/ipcs -m`;<br>- `du -sk`, only while the view is visible. |
| `…/backend/backend-policy-store.ts` | 1 | `policy-v1.json`: strict, atomic, 0600; a schema failure is quarantined and the feature is treated as off. |
| `…/backend/backend-service.ts` | 1 → 5 | - **P1, observer:** refresh, join and flags.<br>- **P3, manager:** ensure, attach and detach, holds, admission, GC, reconcile.<br>- **P4:** agent operations and requests.<br>- **P5:** follow, drift and prune. |
| `…/backend/steering-writer.ts` | 2 | Writes steering.json atomically (0600) in the socket's 0700 directory, on every change and every 60 s. It is kept across quit and removed on disable. |
| `…/backend/backend-store.ts` | 3 | backends.json: strict v1, at most 128 records, quarantined on any failure, no secrets. |
| `…/backend/backend-jobs.ts` | 3 | - The jobs map, plus a persisted ring of the last 64 job ids and their terminal states.<br>- Detached child bookkeeping (pid, start time, argv digest).<br>- On boot, adopts surviving children. |
| `apps/desktop/src/main/backend-ipc.ts`, `backend-confirmation.ts` | 1, 4 | - Every handler runs `assertTrustedRenderer` and a schema parse; operations take ids only.<br>- `confirmBackendOperation` shows a main-owned dialog built from a fresh list and issues an ActionConfirmationStore token, bound to sender and fingerprint (action-confirmation-store.ts:44-89).<br>- `runBackendOperation` consumes the token after re-resolving the targets, as the simulator flow does at index.ts:947-1030. |
| `apps/desktop/src/shared/backend-protocol.ts` | 1 | Renderer-facing strict schemas, plus pure helpers `backendSummary()`, `decideBackendAccess()` and `backendPruneCandidates()`. |
| `apps/desktop/src/renderer/state/backend-runtime.tsx` | 1 | Provider mounted inside AgentRuntimeProvider (main.tsx:19-37), with `backendForLane()` and `backendsForSession()`. |
| `…/panels/simulator/backends-view.tsx` + `backends-model.ts` | 1 | The view behind the Lanes panel's third toggle. In P3 it becomes the lazy tool `backends-panel.tsx`. |
| `…/components/backend-ui.tsx` | 3 | `BackendChip`, whose tone comes from `backendSummary()`. |
| `apps/desktop/src/main/backend/__fixtures__/supabase-2.121.0/*`, `apps/desktop/scripts/record-supabase-fixtures.mjs` | 1, 3 | - **P1:** hand-written fixtures in the spike's shapes (the spike (FINDINGS.md)), with placeholder secrets.<br>- **P3:** re-recorded from the real binary by a dev-only recorder that uses a scratch `SUPABASE_HOME` and replaces secrets. Needs your approval to run. |
| Go `internal/setup/hook_supabase.go`, `internal/setup/steering.go` | 2 | - A shell-segment tokenizer and the Supabase rules.<br>- A steering reader validated like the socket: regular file, not a symlink, owned by euid, no group/other write (client.go:150-195), 64 KiB or less, strict v1. |
| Go `internal/setup/skills/rndevtools-backend/SKILL.md` | 4 | The backend skill. |

## Changed files (anchors at HEAD a415937)
- `packages/core/src/core/redact.ts:1-39` (P0): `sb_secret_` values, URL userinfo passwords, compound secret names; no 64-hex rule.
- `apps/desktop/src/main/lane-service.ts`:
  - **P0:** redact at 317-329; reservations at 428-531; identity-aware Metro health at 961-976; refuse lane launch by a non-holder at 849-855.
  - **P3:** start the ensure after the port lease (458-468), await it before `metro.start` (505-511) with laneEnv, and defer the launch on late attach (533-535). Thread the backend policy through device requests (599-638, 695-711). `#resumeLane` re-ensures and restarts Metro when the env hash changes (775-807). `stopLane` detaches without awaiting (861-868). Add `restartMetro(laneId, {relaunch})`.
- `apps/desktop/src/main/lane-metro.ts:11-18,110-133` (P0): strip the inherited env, add the `laneEnv` slot.
- `apps/desktop/src/main/agent-service.ts:111,307-352` (P0): holder clock for every referenced key; synthetic cwd liveness; freeze on unavailable. P3 adds the backend holder source and `liveness(key)`.
- `apps/desktop/src/shared/device-hold.ts:109-179` (P0): export `resolveHolderLiveness()`; synthetic-aware access.
- `apps/desktop/src/main/agent-cli-service.ts:23-24,93-101,384-399` (P0, P4): per-command budgets; `invalid_request` recovery text.
- `apps/desktop/src/main/agent-command-router.ts`:
  - **P0:** `release --all` honesty and the 2 s budget (422-481); envelope agent for lane up/launch (1384-1432).
  - **P3:** wait and jobs see backend jobs (1094-1114, 1262-1281); lane up summary (1379-1418); doctor (1002-1020).
  - **P4:** `case 'backend'`; agents (838-859).
- `apps/desktop/src/main/lane-store.ts:47-58` (P0): quarantine schema failures.
- `apps/desktop/src/main/lane-ipc.ts:57-62` (P0): validate `worktreePath` against discovered worktrees.
- `apps/desktop/src/shared/lane-protocol.ts` (P3, all wire-only; lanes.json persists only lanes and repositories, lane-store.ts:7-11):
  - environment `backend` (58-82);
  - device request `backend` (169-195);
  - lane.start `backend` (217-242);
  - worktree `backendProject` (153-159);
  - receipt `backend` (296-320).
- `apps/desktop/src/shared/agent-cli-protocol.ts`: P0 adds `release.sessionCwd` and fixes the stale message at 354; P4 adds the `backend` kind and lane `backend`.
- `apps/desktop/src/main/index.ts` (P1+):
  - construct after lanes and agents with late-bound closures (1482-1502);
  - router dependency (1516-1548);
  - broadcast, start and IPC (1569-1587);
  - quit clears timers and waits at most 15 s for lifecycle children, but never stops stacks (1610-1634).
- `apps/desktop/src/preload/index.ts:417-443`, `src/shared/ipc.ts`, `src/renderer/desktop-api.d.ts` (P1): four frozen bridge methods.
- Renderer:
  - `lanes-panel.tsx:118,190-215`: third toggle (P1); chip, form select and detail section (P3);
  - `settings-panel.tsx`: capability row and toggle (P1), policy (P3);
  - `simulator-config.ts`: tool `backends`, shortcut 9 (P3; shortcuts 1-8 are taken);
  - `app.tsx`: lazy route;
  - `fleet-panel.tsx` and `fleet-model.ts`, `agents-view.tsx:136-262` (P3, P4).
- `packages/react-native/src/diagnostics/image-overlay.ts:21-24` (P0 cleanup): the `EXPO_PUBLIC_SUPABASE_URL` host becomes an option.
- Go (`native/rndevtools-cli/internal/`):
  - **P0:** `setup/setup.go:309` (Codex `tool_timeout_sec`); `setup/hook.go:52-66,81,90-94` (payload cwd, per-segment exemption); `app/setup.go:204-259` (forward cwd); `command/schema.go:305-344` (release `sessionCwd`).
  - **P2:** `hook_supabase.go`, `steering.go`, the `hookUsage` text (app/setup.go:191-202), the installHooks detail (setup.go:427).
  - **P4:** `protocol/protocol.go:20-62,88-110`; `command/parse.go:45-145`; `command/schema.go:280-299,414-496`; `command/describe.go:194-220`; `mcp/catalog.go:18-57,193-214`; `mcp/server.go:225-237`; `setup/setup.go:26-30,456-545`; skills; `README.md:80-82,119`; `PROVENANCE.md`.
- `apps/desktop/experiments/agent-discovery/{prompts.json,leak-rule.mjs,desktop-fixture.mjs,experiment-entry.ts}` (P4).

## Data flows
### Lane up, managed worktree, backend auto (P3)
1. Resolve the worktree and app, and take the reservation (P0-5) on app dir, UDID and port. Pick a device or park a request, check conflicts, lease the port, read app.json.
2. Run the cheap static backend check (no CLI). In `required` mode, failures stop the lane here, before boot.
3. Start `ensureForLane` as a job. The job is detached from the request signal, and its rejection is caught at once.
4. Boot and slim in parallel with it.
5. Await the backend for at most 15 s more.
6. **Ready:** `metro.start` with laneEnv; upsert the lane; record the attachment (env hash); launch.
7. **Not ready:**
   - start Metro without the mapped names and upsert the lane;
   - the receipt says `backend {status:'starting', jobId}` and `launch:'deferred'`;
   - when the job completes: `restartMetro` (PID-verified stop, same port, identity-aware health), then launch.
   - If the job fails: `auto` launches without the backend and reports the reason; `required` stops the lane's Metro and reports `backend_failed`.

### Ensure (shared by lane up, backend up and UI Start)
1. Detection and mode, binary, and gate.
2. HEAD and markers. If a git operation is in progress: `skipped: git-busy`.
3. Expected id, then inventory (a list cached for 5 s or less).
4. Then, depending on what exists:
   - **Same native id, running:** `stack start --stack-id` reports the current endpoints without reading config (start/SIDE_EFFECTS.md).
   - **Stopped:** resume.
   - **Container:** the container path.
   - **None:** admission, then the creation queue, then create.
5. Project the JSON. Verify listeners over the tree; fail closed.
6. Persist, then add the hold.

### Agent backend up (P4)
1. CLI or MCP sends the request over the socket to the router.
2. `BackendService.ensure(worktree, requester)` adds a session hold, or a worktree hold for synthetic callers.
3. Attached lanes restart Metro if the env hash changed.
4. The result returns within waitMs, or as a job.

### Release (P0 + P3/P4)
1. Release the session's holds in memory and persist.
2. Stop lanes concurrently within 1.5 s; the rest continue detached.
3. Drop claims.
4. Queue stops for stacks that are now unheld, ignoring the ending session's own cwd.
5. Return within 2 s.

### Reconcile cadence
| When | What |
|---|---|
| Every 15 s while enabled | Cheap tier: pgrep/ps, ports.sqlite, stat, HEAD |
| On id-set change, after lifecycle events, or every 5 min | `stack list`, single-flight, waiting for in-flight creations |
| On demand | `status` |
| After lifecycle operations, and every 5 min for running managed stacks | lsof |
| Every 10 min while visible | disk |

### Steering file
The desktop rewrites steering.json when policy, roots or HEAD readiness change, and every 60 s. The Go hook reads it only for segments that invoke supabase or kill tools.

## Deviations from the research notes
1. No `laneSchema.backend` (lane-store.ts:47-58 downgrade hazard).
2. No reads of state.json or owner.json, and no POST /shutdown. A SIGTERM fallback is used only after argv proves the stack id and no validated binary exists.
3. No snapshots: the CLI has none.
4. Automatic ports, no `SUPABASE_*_PORT` leasing.
5. An agent's destroy parks a user request.
6. A separate policy file.
7. The hook is gated by steering.json plus liveness, with managed and fallback modes.
8. A bounded wait plus jobs instead of 610 s timeouts.
9. A neutral cwd, and `--stack-id` after creation instead of `--workdir` everywhere.
10. `stack prepare` is used only with `--runtime native` against a real worktree, followed by `stack stop`.
11. Dotenv shadowing detection, because Expo 57 ignores EXPO_NO_DOTENV for these files.

## Lifecycle

## Worktree modes
Modes are recomputed on every reconcile and on demand.

| Mode | When | Desktop | Agents (hook) |
|---|---|---|---|
| off | feature disabled, no `supabase/config.toml` between the app and the worktree root, or environment `backend: off` | nothing | no Supabase rules |
| observed | project found, plus any of: flag missing or false, `config.json` conflict, CLI missing or unverified, unsupported platform | lists, flags, operator stop/destroy; never creates | fallback corrective rules |
| managed | feature on, darwin-arm64 with macOS 14+, flag true, no conflict, verified CLI | owns create, resume, stop, destroy; holds; GC | managed rules while the steering file is fresh and the socket answers; otherwise fallback |

## Stack record states
`expected` (an absent row keyed by the predicted id) → `creating` → `running` ⇄ `stopping` → `stopped` → `destroying` → gone.

Other states:
- `starting`: a resume is in progress.
- `failed`: the last CLI operation failed; it can be retried.
- `unknown`: at boot, or when an in-flight job was lost.

**Overlay flags:** orphaned, stale-branch, lan-exposed, exposure-unknown, ports-pinned, stack-flag-missing, config-conflict, cli-unverified, cli-drift, binary-missing, release-mismatch, unreadable, composition-drift, stopped-outside, identity-canary, env-shadowed, home-mismatch, needs-recreate, interrupted, transient (shadow roots named `supabase-shadow-*`).

**Holds per stack:**
- **held:** at least one live lane, session, worktree or operator hold.
- **abandoned:** every holder is gone; `releaseAt = missingSince + 10 min`.
- **free.**

Separately, a live session whose cwd is inside the worktree keeps a free stack from being stopped. The requesting session is ignored for its own down or release.

**Origins:**
- **managed:** the desktop created it.
- **adopted:** the same identity, created by someone else and then ensured by the desktop.
- **external:** not tied to a managed worktree. Never auto-stopped, except by the container rule.

## Transitions
| From | Trigger | To | CLI / action (measured time) |
|---|---|---|---|
| expected | lane up (auto or required), backend up, UI Start | creating | admission, then a single-slot queue, then `stack start --workdir <root> --runtime native --exclude studio,analytics --output-format json` (4.5 s warm, 42.6 s first ever) |
| stopped | ensure | starting | `stack start --stack-id <id> --runtime native --exclude …` (1.0 s) |
| creating / starting | projected JSON + lsof shows only loopback | running | record, hold, laneEnv |
| creating / starting | lsof shows a non-loopback listener, or lsof fails | stopping, then failed + lan-exposed or exposure-unknown | stop, fail closed |
| running | last hold released explicitly | stopping after a 60 s linger | `stack stop --stack-id <id>` (3.2 s idle; budget 90 s) |
| running | every holder abandoned past grace | stopping | same |
| running | project root missing on two checks 15 s apart | stopping, plus orphaned | stop through any validated binary; argv-verified SIGTERM fallback |
| running | owner died, reboot, or an agent's stop | stopped (+ stopped-outside if held) | nothing until the next ensure |
| any | start fails with root `recreate_command` or `stack_changes` | failed + needs-recreate | user dialog: destroy and recreate (data loss) |
| stopped | prune, destroy, or an approved agent request | destroying, then gone | `stack destroy --stack-id <a> [--stack-id <b>] --yes` after a consumed token, for ids in a fresh list |

## Flows
1. **Create, attach, adopt.**
   - Ensure works as described in the architecture section.
   - The id the CLI returns must equal the predicted one. Otherwise flag `identity-canary` on that worktree only and trust the CLI.
   - A native stack with the same identity that an agent started itself (in fallback mode) is adopted with its data.
   - A start that fails with 'partial lifecycle state' gets one automatic stop and start.
   - Two app lanes in one monorepo worktree resolve to the same project root: one stack, two lane holds.
   - UI Start on an expected row adds an operator hold (Pin), so GC does not stop it 60 s later.
2. **Lane up.** Ensure runs in parallel with boot and slim. Metro waits at most 15 s for the backend. When the backend is late:
   - the dev-client launch is deferred;
   - the late attach restarts Metro with laneEnv and launches;
   - `auto` never fails the lane;
   - `required` fails early on static or admission problems, and stops the lane if its job fails.

   Statuses: ready, starting, skipped (with a reason), failed, stale, shadowed, pinned-by-environment, off.
3. **Lane down.**
   - Stop Metro after verifying its PID, then remove the lease.
   - Detach without awaiting.
   - If no holds remain and no live session has its cwd in the worktree, stop after 60 s.
   - An agent that ran `lane down` but is still working in the worktree keeps the database.
4. **backend up / down (P4).**
   - **up:** ensure, plus a session hold (a worktree hold for synthetic `mcp-*` callers). Attached Metro restarts on an env-hash change. Returns ready within `waitMs`, or `{starting, jobId}`.
   - **down:** releases only the caller's holds. If nothing else holds the stack (the caller's own cwd is ignored), it stops asynchronously. Returns at once.
5. **Release** (`release --all` or SessionEnd).
   - **In memory, first:** remove the session's holds. Synthetic callers match worktree holds by `sessionCwd`.
   - **Lanes:** stop concurrently within 1.5 s. Leftovers continue detached and are reported as `pending`.
   - **Claims:** drop them.
   - **Backends:** queue a stop for every stack left unheld, after the 60 s linger.
   - **Budget:** the reply is `{you, stoppedLanes, pendingLanes, releasedClaims, releasedBackends, stoppingBackends, errors}`, within the 2 s client budget.
6. **Abandon and grace.**
   - Every holder key gets a missingSince clock (P0-1).
   - **Claude** is live while its PID is alive.
   - **Codex** is live for 30 minutes after a thread update, so its abandonment takes at least 40 minutes.
   - **Synthetic callers** are live while a session of that kind has its cwd inside the worktree.
   - **Discovery unavailable** freezes the clocks.
   - At `releaseAt`, re-check the holders and any `supabase` CLI process whose cwd is inside the worktree (via `lsof -a -p <pid> -d cwd`), then stop.
   - A returning agent's `--local` command says 'The local stack is not running.' The skill and `next` hints say: call backend up (1.0 s).
7. **Branch switch.**
   - **Detection:** the gitdir HEAD differs from `branch_context`.
   - **The hook's view:** steering.json still names the old `branchContext` and the hook reads the live HEAD, so it treats the root as not ready at once.
   - **follow mode:** after 30 s stable with no markers, and only for a held stack:
     1. ensure the new identity natively (a fresh migrated and seeded database, about 4.5 s);
     2. move the holds;
     3. restart attached Metro and relaunch;
     4. stop the old stack (data kept, `stale-branch`).
   - **Switching back** reattaches the old stack with its data.
   - **Unflagged branch:** if the new branch's config lacks the flag, Metro restarts without backend vars and the record shows the reason.
   - **warn mode:** nothing moves. Agent results carry `branch_moved` plus a hint, and the UI offers Follow branch.
   - **Explicit `backend up`** always follows immediately.
   - **Detached-HEAD worktrees** (common for Codex) get a fresh database on their first `git switch -c`; the skill says to create the branch first.
8. **Worktree deletion.**
   - `git worktree remove` leaves the owner running; `stack list` still says reachable (the spike (FINDINGS.md)).
   - Two failed root checks mark the stack orphaned, and it is stopped at once.
   - Stop works across releases. When no validated binary remains anywhere, the fallback is SIGTERM to the owner after `ps` argv proves `__supabase_stack_host__` plus the full id. That is a graceful stop (StackHost.ts:649-653).
   - Prune offers destroy, run from the neutral cwd with SUPABASE_EXPERIMENTAL_STACK=1 (needed because the deleted config.toml can no longer enable the command group).
   - Uploads lived in the worktree and are already gone; the dialog says so.
   - The UI and skill recommend destroying before `git worktree remove`. Studio snippets would block a non-force remove anyway.
9. **Desktop restart.**
   - Owners, Metros and detached CLI children keep running.
   - On boot:
     1. load the policy and store;
     2. adopt surviving lifecycle children by pid and argv, and wait for them;
     3. mark records `unknown`;
     4. run the cheap tier plus one `stack list`;
     5. re-derive lane holds from lanes.json and restore session, worktree and operator holds; abandonment clocks restart (conservative);
     6. jobs from the ring become `job_lost`.
   - Stacks are never started at boot.
   - Before quitting, the desktop waits at most 15 s for lifecycle children, then leaves them running.
10. **Reboot.**
    - No owners exist, so records become `stopped` with data and reservations kept, and Metros are reconciled dead.
    - The next lane up resumes in 1.0 s. Ports come from the start JSON.
    - If `endpoint_changes` reports a moved port (a configured port took over the reservation), Metro restarts with the new URL.
11. **CLI upgrade and owner binary drift.**
    - Each reconcile stats the owner's argv[0] (path, size, mtime) and the worktree's package versions.
    - **Binary changed or missing:** lazy wakes would spawn launchers from a missing or replaced binary (NativeProcess.ts:74-77).
    - **New version verified:** stop (works across releases), then start with the new binary after a 30 s debounce, while no CLI operation is in flight. Data is kept. Metro restarts if the ports changed.
    - **New version unverified:** the worktree drops to `observed`, the stack is flagged, and agents' fallback rules allow their own native start.
    - **Postgres major change:** `needs-recreate`, behind a dialog.
    - **A release-mismatch error** from any call leads to the same handling.
12. **Container stack on a managed identity.**
    - Explicit `--runtime native` fails with 'Requested runtime native does not match existing stack runtime docker' (stack.shared.ts:195-202).
    - The stack is classified `container_runtime`: never attached, stopped once per desktop session, flagged `lan-exposed`, and you are notified. The lane is told `refused`.
    - Destroy-and-recreate natively is offered behind the destroy dialog.
    - If it reappears, the desktop notifies only and does not stop it again.
13. **Feature disable and re-enable.**
    - A dialog offers 'Leave managed backends running' (default) or 'Stop them now'.
    - steering.json switches to `enabled:false`, so no hook rules apply. Lane auto becomes off.
    - Backend operations return `backends_disabled`, with self-start recovery text.
    - Re-enabling adopts by identity.
14. **Concurrency and partial failures.**
    - **Serialization:**
      - single-flight per identity;
      - a per-stack mutex across start, stop, reset and destroy;
      - creations one at a time (2.121.0 does not register native backend ports, Ports.ts:192-198), resumes and stops two at a time;
      - `stack list` waits for in-flight creations;
      - the P0-5 reservation keeps concurrent lane ups apart.
    - **Retries:** registry lock, lease or sweeping errors are retried 0.5, 1 and 2 s apart. A 'native port collision' or port-allocation failure is retried once and reported as `transient`.
    - **Failures:**
      - **Metro fails after the backend is ready:** the lane throws, the attachment is removed, and GC stops the stack after the linger.
      - **An agent stops a held stack:** `stopped-outside`, with no auto-restart; the next ensure resumes it.
      - **A stop fails:** retry with backoff 3 times, then argv-verified SIGTERM, then `stop-failed`.
      - **A partial multi-destroy:** use the root `destroyed_stacks` from the envelope (destroy.handler.ts:189-191), then re-list.
      - **A start timeout:** SIGINT, a 45 s wait, SIGTERM, never SIGKILL. The stack is flagged `interrupted`, and a failed first bootstrap gets an offer to destroy and retry.
      - **The client disconnects mid-up:** the CLI child finishes, and the next `up` attaches.

## Protocol and agent surfaces

## 1. Supabase CLI invocations (`providers/supabase.ts`, dialect `stack`)
| Op | argv (always `--output-format json`) | Binary | cwd | Budget | Phase |
|---|---|---|---|---|---|
| version | `--version` (bare semver, no json) | each candidate, cached | neutral | 10 s | 1 |
| inventory | `stack list` | newest verified binary among registered worktrees; P5 adds one run per foreign `state_root` with `SUPABASE_HOME=dirname(state_root)` | neutral | 20 s | 1 |
| inspect | `stack status --stack-id <64hex>` | validated owner argv[0], then recorded, then worktree | neutral | 20 s | 1 |
| create | `stack start --workdir <realpath root> --runtime native --exclude <policy>` | worktree | neutral | 300 s | 3 |
| resume / ensure | `stack start --stack-id <id> --runtime native --exclude <policy>` | worktree | neutral | 120 s | 3 |
| stop | `stack stop --stack-id <id>` (one process per id, never `--all`) | any validated | neutral | 90 s, then argv-verified SIGTERM | 3 |
| destroy | `stack destroy --stack-id <a> [--stack-id <b>…] --yes` (ids from a fresh list, token consumed) | any validated | neutral | 120 s per stack | 4 |
| logs | `stack logs --stack-id <id> --tail 200 [--service s]` (JSON array), then redacted, 64 KiB or less | owner/recorded/worktree | neutral | 15 s | 5 |
| reset | `db reset --local --workdir <root> [--no-seed]`, only if HEAD equals `branch_context` and the caller is the sole holder, or the operator has a token | worktree | neutral | 180 s | 5 |
| warm cache | `stack prepare --workdir <root> --runtime native`, then `stack stop --stack-id <id>` | worktree | neutral | 600 s | 5 |

**Never emitted.** A static test greps the adapter for:
- `--runtime auto|docker|podman`, `stop --all`, `--stack <name>`, id prefixes;
- `status --env`, `--override-name`, `--eager`;
- top-level `start|stop|status`;
- `--yes` outside the destroy path that consumes a token.

**The `stack`→`local` rename.** It is a new dialect row. If `local` lacks `list` or `destroy`, that dialect sets `inventory:false`/`destroy:false`. Managed creation is then disabled, stop by id and argv-verified SIGTERM keep working, and inventory comes from ports.sqlite plus owner argv (kill criterion K2).

## 2. Curated environment
The owner keeps this environment for life:
```
PATH=/usr/bin:/bin:/usr/sbin:/sbin   HOME USER LOGNAME TMPDIR LANG LC_ALL (copied from process.env)
SUPABASE_EXPERIMENTAL_STACK=1  SUPABASE_TELEMETRY_DISABLED=1  DO_NOT_TRACK=1  SUPABASE_NO_UPDATE_NOTIFIER=1
SSL_CERT_FILE / SSL_CERT_DIR   only when chosen in Settings (main-owned dialog)
SUPABASE_HOME                  only when chosen in Settings; never implicitly
```
**Never passed:**
- SUPABASE_ACCESS_TOKEN, SUPABASE_*_PORT, SUPABASE_AUTH_*, SUPABASE_WORKDIR;
- SUPABASE_EXPERIMENTAL (it changes migrations);
- RNDEVTOOLS_*, CLAUDE*, CODEX*, AWS_*, EXPO_*, NODE_OPTIONS, ELECTRON_*;
- any empty SUPABASE_* (an exported empty value masks dotenv).

## 3. Parsing (`supabase-contract.ts`, main only)
**Exit codes.**
- **0:** `JSON.parse` the last non-empty stdout line (single-line JSON, output.layer.ts:497), then project it at once.
- **1:** the stdout error envelope.
- **130:** interrupted.

stderr carries `[task] …` progress. The raw stdout buffer is dropped right after projection: never logged, never stored, never echoed in errors.
```ts
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const port = z.number().int().min(1).max(65_535);
const t = (max: number) => z.string().max(max);
const loopbackUrl = z.string().max(256).regex(/^http:\/\/127\.0\.0\.1:\d{4,5}(?:\/[\w./-]*)?$/);
// z.object = strip mode: undeclared keys (SECRET_KEY, SERVICE_ROLE_KEY, DB_URL, MCP_URL, S3_*) never survive parsing.
const publicEnv = z.object({
  API_URL: loopbackUrl.optional(), REST_URL: loopbackUrl.optional(), FUNCTIONS_URL: loopbackUrl.optional(),
  MAILPIT_URL: loopbackUrl.optional(), STUDIO_URL: loopbackUrl.optional(),
  PUBLISHABLE_KEY: z.string().regex(/^sb_publishable_[A-Za-z0-9_-]{8,256}$/).optional(),
  ANON_KEY: z.string().max(4096).regex(/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/).optional(),
});
const endpoint = z.object({ address: t(64), port });            // url dropped; address is NOT an exposure signal
export const versionOut = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,64})?$/);
export const listOut = z.object({ stacks: z.array(z.object({ id: hex64, project_root: t(4096), name: t(128),
  branch_context: t(1024), runtime: t(16), owner: t(32) })).max(512) });
export const statusOut = z.object({
  identity: z.object({ id: hex64, name: t(128), project_root: t(4096), branch_context: t(1024) }),
  runtime: t(16), owner: t(32).optional(), lifecycle: t(32).optional(), readiness: t(32).optional(),
  composition: z.object({ members: z.array(z.object({ service: t(32), activation: t(16).optional() })).max(32) }).optional(),
  services: z.array(z.object({ service: t(32), state: t(32).optional(), lifecycle: t(32).optional(),
    health: t(32).optional() })).max(64).optional(),            // per-service error text dropped
  endpoints: z.record(t(128), endpoint).optional(),
  config_drift: z.object({ status: t(16) }).optional(),
  env: publicEnv.optional(),                                   // plain status env comes from saved bindings
});
export const startOut = z.object({ id: hex64, runtime: t(16), endpoints: z.record(t(128), endpoint),
  lazy_services: z.array(t(64)).max(32).optional(), env: publicEnv,
  endpoint_changes: z.array(z.object({ endpoint: t(128), from: port, to: port })).max(64).optional() });
export const stopOut = z.object({ stopped: z.array(hex64).max(64), not_running: z.array(hex64).max(64) });
export const destroyOut = z.union([z.object({ destroyed: z.literal(true), id: hex64 }),
  z.object({ destroyed: z.literal(true), stacks: z.array(z.object({ id: hex64 })).max(64) })]);
export const errorEnvelope = z.object({
  _tag: z.literal('Error'),
  error: z.object({ code: t(128), message: t(8192), detail: t(8192).optional(), suggestion: t(4096).optional() }),
  // Additions merge into the envelope ROOT, never inside `error` (output.layer.ts:542-547; machine-error-context.service.ts:4-12):
  recreate_command: t(1024).optional(),                                          // start.handler.ts:888-895
  stack_changes: z.array(z.object({ key: t(256).optional(), editable: z.boolean().optional() })).max(64).optional(),
  destroyed_stacks: z.array(z.object({ id: hex64 })).max(64).optional(),         // destroy.handler.ts:189-191
});
// list stderr: /^Warning: skipping invalid stack ([0-9a-f]{64}): / -> 'unreadable' rows (list.handler.ts:30-33)
```

**Error classification.** Matches use `error.code` plus message text, because the internal reason is not serialized. Messages are redacted and capped at 4 KiB. Patterns live in the provider module and are tested against recorded fixtures.

| Signal | Code | Handling |
|---|---|---|
| `is served by release (\S+), but this client is release (\S+)` (HostProcess.ts:323-329) | `supabase_cli_mismatch` | stop (cross-release), then start with the worktree binary |
| `No managed stack exists` | `backend_not_found` | create |
| `The local stack is not running.` | `backend_not_running` | resume |
| root `recreate_command` or `stack_changes` | `needs_recreate` | dialog; never retried automatically: a lane up, an agent up or an operator Follow tries again (the operator's Start is refused with the recreate reason), and a stack status whose `config_drift` is unchanged clears the flag |
| `Requested runtime (\w+) does not match existing stack runtime (docker\|podman)` | `container_runtime` | stop once, flag, notify |
| `Public port (\d+) for (\S+) is in use by …` / `Port … is in use by another process` (Ports.ts:134, 369) | `ports_pinned` | name the holder and the config lines |
| native port collision / port-allocation | `backend_transient` | one automatic retry |
| partial lifecycle state | `backend_partial` | one automatic stop, then start |
| registry locked / lease held / sweeping | `backend_busy` | retries at 0.5, 1 and 2 s |
| shared memory or `No space left on device` from Postgres | `backend_capacity` | stop idle stacks |
| state that cannot be decoded | `backend_unreadable` | show the CLI's guidance; never delete files |
| anything else | `backend_failed` | redacted message |

## 4. Shared schemas (`apps/desktop/src/shared/backend-protocol.ts`)
```ts
export const backendIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const repositoryIdSchema = z.string().regex(/^repo-[0-9a-f]{12}$/);   // issued by main (sha256 of realpath)
const loopbackUrl = z.string().max(64).regex(/^http:\/\/127\.0\.0\.1:[1-9]\d{3,4}$/);
const agentKind = z.enum(['claude', 'codex', 'other']);
export const capabilitySchema = z.enum(['rest','auth','realtime','storage','functions','studio','mail','analytics','pooler']);
export const backendFlagSchema = z.enum(['orphaned','stale-branch','lan-exposed','exposure-unknown','ports-pinned',
  'stack-flag-missing','config-conflict','cli-unverified','cli-drift','binary-missing','release-mismatch','unreadable',
  'composition-drift','stopped-outside','identity-canary','env-shadowed','home-mismatch','needs-recreate','interrupted','transient']);
const holderSchema = z.discriminatedUnion('via', [
  z.strictObject({ via: z.literal('lane'), laneId: laneIdSchema }),
  z.strictObject({ via: z.literal('session'), kind: agentKind, sessionId: identifierSchema }),
  z.strictObject({ via: z.literal('worktree'), kind: agentKind }),      // synthetic MCP caller
  z.strictObject({ via: z.literal('operator') }),                       // Pin / UI Start
]);
export const backendHoldSchema = z.strictObject({ holder: holderSchema, since: timestampSchema, live: z.boolean(),
  abandonedSince: timestampSchema.optional(), releaseAt: timestampSchema.optional() });
export const backendInstanceSchema = z.strictObject({
  id: backendIdSchema, provider: z.literal('supabase'),
  origin: z.enum(['managed','adopted','external','expected']),
  state: z.enum(['expected','creating','starting','running','stopping','stopped','destroying','failed','unknown']),
  runtime: z.enum(['native','docker','podman','unknown']), exposure: z.enum(['loopback','lan','unknown']),
  repositoryId: repositoryIdSchema.optional(), projectRoot: absolutePathSchema.optional(),   // display only
  worktreePath: absolutePathSchema.optional(), branchContext: z.string().max(300).optional(),
  currentBranch: z.string().max(300).optional(), apiUrl: loopbackUrl.optional(),
  ports: z.strictObject({ api: portSchema.optional(), db: portSchema.optional(), mail: portSchema.optional(), studio: portSchema.optional() }),
  services: z.array(z.strictObject({ service: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    state: z.enum(['awake','sleeping','starting','stopped','failed','unknown']) })).max(24).default([]),
  excluded: z.array(capabilitySchema).max(9).default([]),
  lanes: z.array(z.strictObject({ laneId: laneIdSchema, simulatorUdid: laneUdidSchema, port: portSchema })).max(16).default([]),
  holds: z.array(backendHoldSchema).max(16).default([]),
  cli: z.strictObject({ version: z.string().max(64), gate: z.enum(['verified','compatible','unsupported']) }).optional(),
  flags: z.array(backendFlagSchema).max(24).default([]),
  diskBytes: z.number().int().nonnegative().optional(), memoryBytes: z.number().int().nonnegative().optional(),
  lastUsedAt: timestampSchema.optional(), autoStopAt: timestampSchema.optional(), message: shortTextSchema.optional(),
});   // deliberately no key, password, DB URL or MCP URL field anywhere in this file
const appEnvSource = z.enum(['API_URL','REST_URL','FUNCTIONS_URL','PUBLISHABLE_KEY','ANON_KEY']);
const appEnvEntry = z.strictObject({ name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), source: appEnvSource });
export const backendPolicySchema = z.strictObject({ version: z.literal(1), enabled: z.boolean(),
  acknowledgedAt: timestampSchema.optional(), maxRunning: z.number().int().min(1).max(24),
  exclude: z.array(capabilitySchema).max(9), unheldStopDelayMs: z.number().int().min(0).max(3_600_000),
  retentionDays: z.number().int().min(1).max(90), branchSwitch: z.enum(['follow','warn']),
  allowUnverifiedPatch: z.boolean(), stopContainerStacksOnce: z.boolean(),
  appEnv: z.array(appEnvEntry).max(8),
  repositories: z.array(z.strictObject({ id: repositoryIdSchema, mode: z.enum(['auto','off']).optional(),
    appEnv: z.array(appEnvEntry).max(8).optional() })).max(32),
});   // SUPABASE_HOME and the SSL bundle are set only by main-owned file dialogs, never by set-policy
const op = <K extends string, F extends z.ZodRawShape>(kind: K, fields: F) =>
  z.strictObject({ actionId: identifierSchema, kind: z.literal(kind), ...fields });
const token = z.string().regex(/^confirmation-[0-9a-f]{64}$/);
export const backendOperationSchema = z.discriminatedUnion('kind', [
  op('backend.refresh', {}), op('backend.inspect', { backendId: backendIdSchema }),                       // P1
  op('backend.set-enabled', { enabled: z.boolean(), confirmationToken: token.optional(),
    disposition: z.enum(['leave-running','stop-managed']).optional() }),                                  // P1
  op('backend.set-policy', { patch: backendPolicySchema.omit({ version: true, enabled: true, acknowledgedAt: true }).partial() }), // P3
  op('backend.start', { backendId: backendIdSchema }),                  // P3; an 'expected' id creates natively
  op('backend.stop', { backendId: backendIdSchema, confirmationToken: token.optional() }),                // P3; token for external stacks
  op('backend.restart-metro', { laneId: laneIdSchema }), op('backend.pin', { backendId: backendIdSchema, pinned: z.boolean() }),
  op('backend.adopt', { backendId: backendIdSchema }), op('backend.copy-env', { backendId: backendIdSchema }),
  op('backend.open', { backendId: backendIdSchema, surface: z.enum(['mailpit','studio']) }),              // P3 / P5
  op('backend.destroy', { backendIds: z.array(backendIdSchema).min(1).max(32), removeUploads: z.boolean(), confirmationToken: token }), // P4
  op('backend.prune', { selection: z.enum(['orphaned','stale','retention','unreadable']), confirmationToken: token }),            // P4
  op('backend.settle-request', { requestId: identifierSchema, decision: z.enum(['approve','deny']), confirmationToken: token.optional() }),
  op('backend.release-hold', { backendId: backendIdSchema, holder: holderSchema }),                       // P4
  op('backend.reapply-exclusions', { backendId: backendIdSchema }),
  op('backend.set-studio', { backendId: backendIdSchema, enabled: z.boolean(), confirmationToken: token.optional() }),
  op('backend.read-log', { backendId: backendIdSchema, service: z.enum(['database','rest','auth','realtime','storage','functions','mail','gateway']).optional(),
    maxCharacters: z.number().int().min(256).max(64_000).default(16_384) }),
  op('backend.reset', { backendId: backendIdSchema, confirmationToken: token }),
  op('backend.choose-path', { field: z.enum(['supabaseHome','sslCertFile']) }), op('backend.prepare-cache', { repositoryId: repositoryIdSchema }), // P5
]);
```

**Bridge.** Four frozen methods: `getBackendState`, `subscribeBackendState` (safeParse), `runBackendOperation`, and `confirmBackendOperation`. The last one returns a token after a main dialog that is built from a fresh list.

**Agent-side job.** `backendJobSchema` = `{id: 'backend-job-<uuid>', kind: up|resume|down|reset|destroy|follow|prepare, backendId?, status: queued|running|complete|failed|cancelled|lost, phase?: resolving|waiting-slot|downloading|starting|migrating|verifying|connecting-metro|stopping|destroying, message, startedAt, updatedAt}`.

## 5. Lane protocol deltas (`lane-protocol.ts`, wire-only)
- **Environment:** `laneEnvironmentSchema` gains `backend: z.enum(['auto','off']).optional()`. `DEFAULT_LANE_ENVIRONMENTS` sets development to auto and staging and production to off.
- **lane.start** gains `backend: z.enum(['auto','off','required']).optional()`, defaulting to `environment.backend ?? 'off'`. The same field goes on `laneDeviceRequestSchema`, which is kept in memory.
- **Worktree:** `laneWorktreeSchema` gains `backendProject: z.enum(['managed','observed','none']).optional()`.
- **New `laneBackendSummarySchema`**, also added as an optional `backend` on `laneOperationReceiptSchema` and on `lane ls` results:
  - `policy`;
  - `status`: `off|ready|starting|skipped|failed|stale|shadowed|pinned-by-environment`;
  - `backendId?`, `apiUrl?` (loopback);
  - `appEnvNames[]`: names only, never values;
  - `reason?`, `message?`, `jobId?`;
  - `launch?: 'deferred'`;
  - `warnings[]`: `previous-session-on-simulator`, `shared-default-keys`, `cli-untested`, `composition-drift`.

## 6. Agent CLI protocol and Go CLI
**TypeScript schema.**
```ts
z.strictObject({ kind: z.literal('backend'),
  operation: z.enum(['up','down','ls','status','env']),            // P4; 'reset','destroy','log' added additively in P5
  worktreePath: absolutePathSchema.optional(), backendId: z.string().regex(/^[0-9a-f]{8,64}$/).optional(),
  waitMs: z.number().int().min(0).max(45_000).optional() })
 .superRefine(/* up: worktreePath only (+waitMs); ls: optional worktreePath; down|status|env: exactly one of worktreePath|backendId */)
```
- Lane gains `backend: z.enum(['auto','off','required']).optional()`, for `up` only.
- Release gains `sessionCwd` (absolute, only with `all: true`), sent by the SessionEnd hook.
- Identity stays envelope-only.
- A `backendId` prefix must be unique among known records, otherwise `invalid_request`.

**Commands.**
```
rndevtools backend --operation up     --worktree <abs> [--wait-ms 30000]
rndevtools backend --operation down   (--worktree <abs> | --backend-id <8-64 hex>)
rndevtools backend --operation ls     [--worktree <abs>]
rndevtools backend --operation status (--worktree | --backend-id)
rndevtools backend --operation env    (--worktree | --backend-id)
rndevtools lane --operation up --worktree <abs> [--backend auto|off|required]
```

**Go side.**
- `protocol.go`: `CommandBackend` after `CommandLane`.
- `parse.go`: flags `operation`, `worktree`→`worktreePath`, `backend-id`, `wait-ms`, plus lane `backend`. Usage strings are written as agent guidance.
- `schema.go`: `validateBackend` mirrors the TS rules.
- `describe.go`: `deriveTimeout(backend) = max(75 s, waitMs + 20 s)`. `attachAgent` stays lane-only.

**`up` result.**
```json
{"backend":{"id":"<64hex>","status":"ready","runtime":"native","apiUrl":"http://127.0.0.1:2xxxx","dbPort":2xxxx,
 "branchContext":"refs/heads/feat-x","worktreePath":"/abs/wt","laneIds":["lane-…"]},
 "appEnv":["EXPO_PUBLIC_SUPABASE_URL","EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY"],"metro":"restarted|unchanged|no-lane",
 "cli":{"run":"pnpm exec supabase","workdir":"/abs/wt","version":"2.121.0"},
 "next":"Run `pnpm exec supabase migration up --local`, `db reset --local`, `gen types typescript --local` from /abs/wt.","warnings":["shared-default-keys"]}
```
**Other results.**
- A slow `up` returns `{"backend":{"status":"starting"},"jobId":"backend-job-…","next":"wait --condition job --job-id backend-job-…"}`.
- `env` returns `{API_URL, REST_URL, FUNCTIONS_URL, MAILPIT_URL, PUBLISHABLE_KEY, ANON_KEY}`. It never returns SECRET_KEY, SERVICE_ROLE_KEY or DB_URL.
- `ls` returns summaries with a `yours` flag.
- `release --all` returns `{you, stoppedLanes, pendingLanes, releasedClaims, releasedBackends, stoppingBackends, errors}`.
- `doctor` gains `backends: {enabled, platform, repositories[{mode, cli:{version, gate}}], running, cap, sysv:{used, limit}, containerEngine, stats:{starts, failuresByCode, p50Ms, p95Ms}, warnings[]}`.

**Errors for agents** (typed AgentCliError; the recovery text names the next call):
| Code | Recovery |
|---|---|
| `backends_disabled` / `backend_unsupported` / `cli_unverified` | RN Devtools is not managing this worktree; run `<runner> supabase start --runtime native` yourself (never without it) |
| `backend_cli_missing` | install dependencies in this worktree; the repo should pin `supabase` as a devDependency; do not use npx/dlx versions |
| `stack_flag_missing` / `config_conflict` | ask the user to commit `[experimental] stack = true` (and remove `supabase/config.json`); do not edit it yourself |
| `ports_pinned` | ask the user to delete the listed port keys; never stop the other stack |
| `container_runtime` | ask the user to destroy it in RN Devtools › Backends; then `backend up` |
| `backend_capacity` | release backends you no longer need, or ask the user to raise the cap |
| `backend_held` | only for mutations by a non-holder |
| `supabase_cli_mismatch` | `backend up` (RN Devtools restarts the stack with the worktree CLI; data kept); never destroy to fix it |
| `job_lost` | call `backend up` again (idempotent) |
| `branch_moved` | warn mode only; call `backend up` to follow |
| `backend_failed` | redacted CLI message, 4 KiB or less |

## 7. MCP
- **`catalog.go`.**
  - `CommandBackend` goes right after `CommandLane`, with requiredFields `{operation}` and annotations readOnly:false, destructive:false (no tool in catalog.go is marked destructive).
  - Resource `rndevtools://backends` maps to `backend ls`; server_test then expects 4 resources.
- **Tool title:** "Run this worktree's local Supabase".
- **Tool description:** "Give this git worktree its own local Supabase (Postgres, REST, Auth, Storage, Realtime, Functions) on 127.0.0.1, managed by RN Devtools so parallel agents never share a database or collide on ports. operation up (absolute worktree path) creates or resumes the stack natively and returns status, apiUrl and the db port; if a lane runs this worktree its Metro is restarted with that URL. A first start on this Mac downloads services once: if status is starting with a jobId, call wait (condition job). lane up already does this when supabase/config.toml sets [experimental] stack = true. down stops it when nobody else uses it (data kept); env returns the public URL and publishable/anon keys (service-role and secret keys are never returned); ls lists every stack with its lane, Simulator and holder. Do database work with the worktree's own CLI: `pnpm exec supabase migration up --local`, `db reset --local`, `gen types typescript --local`. If this tool answers backends_disabled, backend_unsupported or cli_unverified, RN Devtools is not managing this worktree: start the stack yourself with `supabase start --runtime native` (never without --runtime native). Never run supabase stop --all, stack destroy, or pkill postgres, and never write keys into .env files."
- **Lane tool description delta:** "Optional backend (auto, off, required): with auto, lane up also starts this worktree's local Supabase and passes its URL and publishable key to Metro; lane.backend reports ready, starting (jobId; the app launches when it is ready), skipped, shadowed (the app's own .env files override the injected URL) or refused, with next."
- **Server instructions (`server.go:225-237`).**
  - The scope becomes "the iOS Simulators and, when enabled, each worktree's local backend (Supabase) on this Mac".
  - Add: "For a worktree with supabase/config.toml, get its database with backend (operation up) or lane up; if RN Devtools says it is not managing that worktree, run `supabase start --runtime native` yourself. Use the worktree's own supabase CLI with --local for migrations, reset and types; never stop --all, destroy, or kill other agents' stacks, and call release with all=true when done."

## 8. Desktop handler budgets (`agent-cli-service.ts:93-101`)
| Command | Budget |
|---|---|
| lane up/launch, native | 230 s (Go 240 s; setup writes Codex `tool_timeout_sec = 240`) |
| backend up/down | `waitMs` + 10 s (55 s or less) |
| wait | unchanged |
| everything else | 60 s |

## 9. Steering file and PreToolUse rules
**steering.json** lives at `~/Library/Application Support/RN Devtools/agent/steering.json`. It is 0600 in the 0700 socket directory and written atomically.
```json
{"version":1,"writtenAt":1760000000000,"desktopPid":12345,
 "backends":{"enabled":true,"roots":[{"worktreeRoot":"/abs/wt","projectRoot":"/abs/wt","mode":"managed",
   "branchContext":"refs/heads/feat-a","stackReady":true,"runner":"pnpm exec supabase"}]}}
```

**Mode resolution, per command:**
- **No Supabase rules** when the file is missing, invalid (symlink, wrong owner, group/other-writable, over 64 KiB, bad schema) or `enabled:false`.
- **Managed mode** requires all of:
  - `writtenAt` is 3 minutes old or less;
  - `net.Dial("unix", socket)` succeeds within 200 ms;
  - the effective directory is inside a root with mode `managed`, and the project root found matches.
- **Otherwise, fallback mode**, applied only in opted-in projects. A project is opted in when the nearest ancestor `supabase/config.json` sets experimental.stack true; or, with no config.json, `supabase/config.toml` sets `[experimental] stack = true`; or the segment assigns SUPABASE_EXPERIMENTAL_STACK=1. A segment that assigns `=0` opts out.

**Tokenizer** (`hook_supabase.go`, stdlib only):
1. **Split** on unquoted `;`, `&&`, `||`, `|`, `&` and newlines. `$(…)` and backticks are separate segments. A `cd <dir>` segment updates the effective directory for later `&&`/`;` segments.
2. **Strip** `VAR=value` prefixes, the wrappers `sudo`, `env`, `command`, `exec`, `time`, `nohup`, and the runners `npx [-y|--yes|-p X]`, `bunx`, `bun x`, `pnpm [exec|dlx]`, `yarn [dlx]`, `npm exec [--]`.
3. **Match the program** against `(?:^|/)supabase(?:@[\w.^~-]+)?$`.
4. **Skip global flags.** These take a value: `--workdir`, `--output-format`, `-o`, `--profile`, `--agent`, `--network-id`, `--dns-resolver`. These do not: `--debug`, `--experimental`, `--yes`, `--create-ticket`.
5. **`--help`/`-h`** always passes.
6. **Exemption:** a segment whose program is `rndevtools` is exempt. This is per segment, replacing the whole-command check at hook.go:81.
7. **Any parse failure** allows the command.

| Rule | Mode | Matches | Reason (abridged) |
|---|---|---|---|
| X1 | any (feature on) | stop / stack stop / local stop with `--all` | "stops every agent's local Supabase on this Mac; stop only yours (backend down, or `supabase stop` when RN Devtools is not managing it)" |
| X2 | any | stop / stack stop with `--stack-id` / `--project-id`, or `--workdir` outside the current worktree | "may stop another agent's stack" |
| X3 | any | stack destroy / local destroy | "deletes a database; ask the user (RN Devtools › Backends, or backend destroy); to start fresh use `db reset --local`" |
| X4 | any | `pkill`/`killall` naming postgres, postmaster, postgrest, gotrue, realtime, edge-runtime, supabase, supavisor, mailpit, imgproxy, storage-api, beam.smp; `kill $(pgrep … postgres\|supabase)`; `pg_ctl … stop` | "native stacks share this Mac's process table; this kills every agent's database" |
| X5 | any | `status` with `--env` or `-o env`, redirected `>`/`>>`/`&>` into `.env*` or piped to `tee [-a] .env*` | "writes SECRET_KEY, SERVICE_ROLE_KEY and DB_URL into a file Expo bundles; lanes already pass the URL and publishable key to Metro" |
| F1 | fallback, opted in | start / stack start / stack prepare without `--runtime native` / `--runtime=native`, or with auto/docker/podman | "a new stack would pick Docker when it runs, and Docker stacks listen on every interface with public default credentials. Run `<same command> --runtime native` (the runtime is saved, later starts stay native). If it reports the existing stack is docker, ask the user before replacing it" |
| F2 | fallback, opted in | `db start` | "it cannot choose a runtime and creates a Docker stack when Docker answers; run `supabase start --runtime native`" |
| F3 | fallback, opted in | `db schema declarative generate\|sync` targeting local (`--local`, `--local=true`, or no explicit target) | allowed when an earlier `&&` segment in the same command is an F1-compliant native start; otherwise "run `supabase start --runtime native && <your command>` (start returns at once when the stack is running)" |
| M1 | managed | start, stop, dev, stack start\|stop\|restart\|prepare, local start\|stop\|restart | "RN Devtools runs this worktree's local Supabase: use the backend tool (operation up/down, worktree <abs>) or lane up; your `supabase … --local` commands keep working" |
| M2 | managed | `db start`; any `--runtime` | "use backend (operation up)" |
| M3 | managed and not ready (live HEAD ≠ root.branchContext, or stackReady false) | declarative generate\|sync (local), `db diff`, `db pull`, `migration squash` | "this branch has no local stack yet, and these commands would create one with automatic runtime selection; call backend (operation up) first" |
| M4 | managed | `npx\|pnpm dlx\|bunx\|yarn dlx supabase@…`, `npx -p supabase@…`, or an absolute supabase binary outside the worktree or repository | "a stack only answers the CLI build that started it; use `<root.runner>` from this worktree" |

**Always allowed:**
- `db reset --local`, `migration *`, `gen *`, `test db`, `seed`, `inspect`, `functions serve`;
- `status` without a redirect; `stack status|list|logs`;
- `stack restart` (fallback mode);
- `init`, `link`, `login`.

**SessionEnd.** The payload's `cwd` is decoded, and the hook sends `{"kind":"release","all":true,"sessionCwd":"<abs>"}` inside the existing 2 s.

## 10. Skill, AGENTS block and setup
**Phase 2: `AgentsBlock` paragraph.** Written only when `<project>/supabase/config.toml` exists (setup.go:533-545):
```
## Local Supabase
Each worktree gets its own local Supabase stack (native runtime, loopback only). Use the rndevtools `backend` tool
(operation up) or `lane up` when RN Devtools manages this worktree; otherwise start it yourself from the worktree with
`pnpm exec supabase start --runtime native` (never without --runtime native). Use `supabase … --local` for migrations,
`db reset` and `gen types`, against your local stack rather than a hosted project unless the user asks. Never run
`supabase stop --all`, `supabase stack destroy` or `pkill postgres`, and never write `supabase status --env` into a .env file.
```

**Phase 4: new `skills/rndevtools-backend/SKILL.md`.** setup.go:26-30 changes to `//go:embed skills/*/SKILL.md`, and installSkill loops over each skill. Not added to Kiro `readOnlyTools`.

Description: "Use RN Devtools for this worktree's local Supabase: starting or checking the local database for a git worktree, connecting the app in a lane to it, applying or testing migrations, resetting and reseeding, reading backend logs, or finding the local API URL and publishable key. Trigger on start the local database, supabase start, reset the db, seed, apply this migration locally, run two worktrees with their own database, the app cannot reach Supabase. Never run supabase start without --runtime native, stop --all, stack destroy, or pkill postgres."

Body rules:
- `lane up` starts the stack automatically; `backend up` is for database-only work.
- Use the worktree's own CLI (the `cli.run` hint), never `dlx`, `@latest` or a global install.
- Create your branch before `lane up`. A branch switch gives a fresh database, RN Devtools follows it, and switching back restores the old one.
- After switching, call `backend up` before `db diff`, `db pull` or declarative commands.
- The first request after a minute idle wakes that service: Realtime takes up to about 3 s, and the first-ever Functions call about 22 s.
- Do not open Studio or `/mcp` unless asked.
- Keys are local defaults shared by every stack. After a backend change, sign out and in again in the app.
- `release --all` stops your stack in the background, with data kept.
- An "If backend reports…" table maps each error code to its recovery.

**Lanes skill delta.** One rule, plus a `release --all` line in the Stop section.

**`hookUsage`** (app/setup.go:191-202) and **the installHooks detail** (setup.go:427) describe the Supabase rules and the feature gate.

**README and PROVENANCE.** Record the additive rndevtools/1 change (the `backend` kind, lane `backend`, `release.sessionCwd`) in the same commit as the Go and TS schemas. README:80-82 (attribution) and :119 (udid) are fixed in P0.

## 11. Version upgrades
**Repos.** Pin `"supabase": "2.121.0"` exactly. Settings shows each repository's resolved version and gate.

**Adding a version:**
1. Run `node apps/desktop/scripts/record-supabase-fixtures.mjs --cli <path>`. It uses a scratch `SUPABASE_HOME` and records init → start → status → list → stop → restart → branch-switch error → destroy, with secrets replaced.
2. Diff the new fixtures against the current set.
3. If the projections and classifier still pass, append the version as `verified`. Otherwise add dialect code; that change counts toward K1.

**3.0.0-next** stays unsupported until fixtures are recorded.

## UI

## Phase 1: Backends view (Lanes panel, third toggle "Backends · alpha")
The toggle sits in the existing Lanes/Agents fieldset (lanes-panel.tsx:118, 190-215).

**When disabled.** One paragraph explains the feature and the native-versus-Docker trade-off, with an "Open Settings" link. No process runs.

**Notices** (PanelNotice, ui.tsx:101), in this order:
1. Unsupported platform ("Native Supabase needs Apple silicon and macOS 14+").
2. Danger: "N Docker/Podman stacks listen on your network". Listed per stack, each with a copyable stop command.
3. Another `SUPABASE_HOME` is in use, taken from ports.sqlite `state_root`.
4. CLI missing or unverified in some repositories.
5. Alpha: "Supabase's stack commands are outside its compatibility promise".

**Onboarding cards, one per registered repository:**
- **Mode badge:** managed, observed or off, with the reason.
- **`[experimental] stack = true`:** a check mark or a cross, with a copyable snippet.
- **`config.json` conflict.**
- **Pinned listener ports** with file:line, and "delete these lines".
- **CLI version and gate**, plus the runner taken from the lockfile.
- **App dotenv files** that define mapped names (available from P3), listed with file:line.

**Toolbar.**
- Filters: All · Managed · External · Needs attention.
- Refresh.
- Readout: "3 running of 12 · Postgres slots 6/32".
- A "2 transient" counter for shadow roots named `supabase-shadow-*`, which are hidden by default.

**Table** (pure helpers in backends-model.ts):
| Column | Content |
|---|---|
| Status | dot plus state; `managed` / `adopted` / `external` tag |
| Worktree · branch | WorktreeLabel; **Stale branch** badge when HEAD moved; **Worktree deleted** when orphaned |
| Lane · Simulator | LaneChip(s) and device name; monorepo lanes sharing one stack all show |
| Holder | AgentBadge with liveness: "live", "gone · stops in 7 min", "operator", "worktree (codex)" |
| Runtime · exposure | `native · loopback` (from lsof), `docker · LAN-exposed` in danger tone, or `exposure unknown` |
| API | `:21734`; clicking copies the loopback URL |
| CLI | version and gate badge; **CLI drift** / **binary missing** |
| Disk | PGDATA in MB (P5; "—" before then) |
| Last used | relative time |
| Flags | badges for the remaining flags |

**Detail drawer** (read-only in P1; `backend.inspect`):
- identity (full id, name, project root, branch_context against the current HEAD);
- readiness;
- the services table (service, state, health, activation; a sleeping service reads "wakes on first request");
- endpoints by name and port. There is no loopback check mark taken from JSON; exposure comes from lsof;
- config drift, holders, and the CLI binary (path, version);
- the uploads path;
- the last redacted error;
- copyable non-secret commands, for example `pnpm exec supabase stack status --stack-id <id>`.

**Phase 1 actions:** Refresh, Copy stack id, Copy CLI command.

## Phase 3: Backends tool
- **Registration.** Shortcut 9, lucide Database icon, registered in simulator-config.ts (shortcuts 1-8 are taken) and lazy-loaded from `panels/simulator/backends-panel.tsx`.
- **The toggle** in the Lanes panel becomes a link to the tool.
- **Header.** "Local backends · N running · M stopped"; Refresh; "Clean up ▾" (P4); a gear that opens Settings › Local backends.
- **Metric grid** (SimulatorMetric, simulator-ui.tsx:109):
  - Running `n / cap`.
  - Postgres slots `used / shmmni`.
  - Memory: the measured footprint while the tool is visible. Otherwise an estimate, labelled as one: idle stacks × 0.17 GiB plus awake stacks × 0.9 GiB.
  - Disk: PGDATA plus the shared 1.7 GiB cache.

**Row actions:**
| Action | Notes |
|---|---|
| Start / Resume | expected rows create natively by the predicted id and add an operator hold |
| Stop (keeps data) | ConfirmAction when a live agent holds it; main dialog plus token for external stacks |
| Restart Metro to attach | shown when an attached lane is stale |
| Keep running | Pin: an operator hold |
| Adopt | external native stacks |
| Open Mailpit | main validates the loopback URL and calls `shell.openExternal` |
| Copy public env | main writes the mapped names with the URL and publishable key to the clipboard, under "# local only, do not commit" |
| Re-apply exclusions | P5 |
| Open Studio / Enable Studio… | P5 |
| View logs | P5; per service, redacted, 64 KiB or less |
| Reset database… | P5 |
| Destroy… | P4 |

**Bulk.** Checkbox selection, then Stop selected or Destroy selected… (one dialog for all).

**Agent requests (P4).** Cards at the top, in the deviceRequest pattern: "codex session 3f2a… asks to destroy the backend for feat-x (64 MB)" with [Review & destroy…] [Deny].

**Prune section (P4,** in the DiskInventorySection style of fleet-panel.tsx:1567**).**
- Groups: Orphaned (worktree deleted), Stale branch, Stopped longer than N days, Unreadable. Each shows its size.
- One button: "Destroy N stacks (X MB)…".

## Changes to existing views (P3)
- **`BackendChip`** (`components/backend-ui.tsx`). Its tone comes from `backendSummary()`:
  - `db :21734` (success);
  - `db starting`, `db stopped`, `db stale`, `db shadowed` (warning);
  - `db refused · LAN` (danger);
  - `db blocked · ports pinned`;
  - hidden when off.
- **Lanes panel:**
  - the chip next to LaneSlimBadge (rows at 409-418);
  - in the start form, a Backend select (Auto / Off / Required) next to the slim select, plus worktree options marked "· Supabase", "· Supabase (needs opt-in)" or "· Supabase (ports pinned)";
  - in the lane detail, a Disclosure "Backend": API URL, status, reason, injected variable **names**, the stack id prefix, branch, `next`, and the actions Restart Metro to attach, Stop backend (ConfirmAction) and Open in Backends;
  - a banner when the lane's Simulator last ran against a different stack: "Signed-in sessions may carry over (sb-127-auth-token); sign out in the app";
  - the memory card adds the backend footprint.
- **Fleet** (`fleet-panel.tsx`, `fleet-model.ts`): the chip on tiles and rows, a backend line in the Lane section, and a `with-backend` filter.
- **Agents view** (`agents-view.tsx:136-262`): each session card lists the backends it holds (via lane, session, worktree or cwd) with Release (P4), plus a count badge.

## Settings › Local backends (alpha)
**Capability row** (CapabilityRow, settings-panel.tsx:391):
- platform: arm64 and the macOS version;
- the CLI per repository, with its gate;
- "Docker detected: never used by RN Devtools";
- the SUPABASE_HOME in use;
- shared memory used/limit.

**Controls:**
| Setting | Default |
|---|---|
| Enable | off; opens the acknowledgement dialog |
| Max running backends | 12, derived (range 1-24) |
| Exclude by default | Studio ✓, Analytics ✓, Pooler ☐ |
| Stop released backends after | 60 s |
| Abandoned grace | 10 min; shown, equal to the hold grace |
| Prune suggestions after | 14 days |
| Branch switch | Follow or Warn |
| Stop Docker/Podman stacks found on managed worktrees, once | on |
| Allow unverified patch releases | off |

- **App variables.** An editable NAME ← SOURCE list. The source offers only API_URL, REST_URL, FUNCTIONS_URL, PUBLISHABLE_KEY and ANON_KEY. A "Supabase + Expo preset" button fills it in. Names are validated with the metroEnv regex and must not collide with fixed Metro keys.
- **Per-repository overrides** are keyed by main-issued repository ids.
- **Paths (P5).** SUPABASE_HOME and the SSL bundle are chosen through main-owned file dialogs; the renderer never sends a path.
- **Prepare local backends (P5)** warms the artifact cache as a job.

## Confirmations
All are main-owned `dialog.showMessageBox` dialogs, built from a fresh `stack list` and record lookup, with text sanitized as in desktop-action-confirmation.ts. Destructive ones issue ActionConfirmationStore tokens (60 s, bound to the sender and a fingerprint of `{operation, sorted ids, removeUploads}`). Cancel is the default.

- **Enable.** States four things:
  1. native was chosen over Supabase's Docker recommendation, for loopback-only exposure, at the cost of weaker isolation;
  2. it assumes a single-user Mac (supabase_admin is trusted on loopback; default keys are shared);
  3. stacks started by RN Devtools run outside any agent sandbox;
  4. Codex-over-MCP calls are attributed by worktree.

  It also says the stack commands are experimental.
- **Destroy.**
  - Title: "Destroy the local Supabase stack for <branch>?"
  - Detail: worktree, id prefix, runtime, size, the ports to be released, and "deletes its database and logs".
  - Holder line: "<codex session …> is using it; its app will lose its database."
  - Checkbox: "Also delete Storage uploads (12 MB in …/supabase/.temp/stack-uploads/<id>)". For deleted worktrees: "Uploads lived in the deleted worktree and are already gone."
- **Prune.** Lists up to 10 stacks, "and N more", and the total MB.
- **Reset.** "Drop all data in <branch> and re-run migrations and seed (about 5 s)?", with the holder line.
- **Enable Studio.** "Studio and its SQL endpoint <API_URL>/mcp have no authentication and answer any origin; any program on this Mac, and web pages your browser lets reach 127.0.0.1, can run SQL while it is on. Studio uses about 1-2 GiB awake and takes about 18 s to wake."
- **Stop external stack.** "RN Devtools did not start this stack; an agent or you may be using it. Data and ports are kept; it restarts in about a second."
- **Disable feature.** "Leave backends running" (default) or "Stop managed backends".

## Security and repository rules

## Exposure (builder-security policy, applied as policy)
- **Private by default.**
  - Every desktop create and resume passes `--runtime native`. Native public listeners bind 127.0.0.1 in code (v2.121.0 Network.ts:111), and the spike confirmed it with lsof (the spike (FINDINGS.md)).
  - Docker and Podman proxies bind 0.0.0.0 (Network.ts:111). They are never selected, never attached, and stopped once when found on a managed identity.
  - Physical-device or LAN access is out of scope; it would need its own exposure design and your explicit go-ahead.
- **Verify, don't just detect.**
  - After every desktop start or resume, and every 5 min for running managed stacks, run `lsof` over the stack's process tree: owner, launchers and their children.
  - Everything must be 127.0.0.1 or [::1]. Otherwise, stop the stack, flag `lan-exposed`, and fail the operation.
  - An lsof failure counts as a failed verification.
  - JSON `address` fields are never used as evidence; they are always 127.0.0.1 (Network.ts:112).
- **No new listeners.** RN Devtools adds none, nothing goes over the loopback broker, and the agent socket stays 0600 in a 0700 directory.
- **Never weaken or invent auth.**
  - The desktop writes no pg_hba, no proxy and no config.
  - Native Postgres's `local all supabase_admin trust` behind the loopback TCP proxy (Database.ts:119-120) is Supabase's own local-dev setup. It is disclosed as a residual risk.
  - Datastores are never exposed beyond loopback.

## The trust model you are accepting (shown in the enable dialog)
- **Separate databases, not tenants.**
  - Any local process or account can become database superuser on any stack through the trusted `supabase_admin` path.
  - Default keys (JWT secret, ES256 signing key including its private part, `sb_secret_`, S3 keys, analytics token `api-key`) are public constants accepted by every stack (Defaults.ts:2-41; stack-config.ts:1240,1319-1321).
  - The gateway and the dedicated Studio, pg-meta, Mailpit and analytics ports answer CORS `*` (HttpProxy.ts:259-266, 635-641).
  - Assume a single-user Mac with Remote Login and Screen Sharing off.
- **Stacks are not sandboxes.**
  - A stack the desktop starts runs outside every agent sandbox: migrations, seeds, Functions preparation (which may build project source) and pg_net outbound calls.
  - An agent-started owner inherits the agent's environment and sandbox for life (HostProcess.ts:495-516).
- **Opt-in twice.** The feature needs both the desktop setting and the repo's committed `[experimental] stack = true`.
- **Never root.** The desktop never runs the CLI as root.

## Where secret values may go
| Value | Main memory | backends.json | Renderer IPC | Agent socket | steering.json | Metro env / bundle |
|---|---|---|---|---|---|---|
| API/REST/Functions/Mailpit URLs | yes | ports only | yes (loopback-validated) | yes | no | mapped names only |
| PUBLISHABLE_KEY, ANON_KEY | yes | sha256 fingerprint only | no (clipboard written by main) | only on `backend env` | no | mapped names only |
| SECRET_KEY, SERVICE_ROLE_KEY, DB_URL, MCP_URL, S3 secret | dropped at parse time (undeclared in strip projections) | never | never | never | never | impossible: the source enum cannot name them |
| owner.json secret, state.json credentials | never read | never | never | never | never | never |
| Phase 6 per-stack keys | yes | never (gitignored supabase/.env.local + 0600 key file outside the repo) | never | publishable/anon only | no | publishable/anon only |

**Other rules for sensitive data.**
- CLI stderr, error messages and log tails go through the extended redactor and are bounded: 4 KiB for messages, 64 KiB for logs.
- Logs are read only on request and never stored. PostgREST and gateway logs carry query strings (start/SIDE_EFFECTS.md).
- Tests serialize state, receipts, IPC payloads and backends.json, and assert that `sb_secret_`, `eyJ`, `postgresql://`, `SERVICE_ROLE` and `SECRET_KEY=` values are absent.

## Binary and process hygiene
- **Which binaries run.**
  - Only validated binaries, resolved inside a registered worktree or its repository's main checkout. They must be regular files owned by the user, with no group or world write.
  - Owner argv[0] is executed only when it passes the same validation. Argv can be set by any same-user process, and executing it from the desktop would run it with the desktop's macOS privacy (TCC) permissions.
  - No PATH lookup, no npx/dlx, no bundled CLI.
- **How they run.**
  - argv array, `shell:false`, curated env, an empty 0700 cwd.
  - Separate drained pipes (CLI issue #6846).
  - `--yes` only on the token-consuming destroy path.
  - Never SIGKILL a start.
- **What the desktop never touches.**
  - It never writes under ~/.supabase.
  - It never holds a transaction on ports.sqlite: one read-only SELECT; writers wait at most 2 s (PortReservations.ts:96).
  - It never touches `.registry-lock.sqlite`.
  - It never deletes stack directories.
- **Signals to owners.** SIGTERM goes to an owner only after `ps` argv shows `__supabase_stack_host__`, the full 64-hex id and the same uid, re-checked right before signalling (the lane-metro.ts:171-198 rule). Launchers and services are never signalled.
- **Uploads removal** happens only through the destroy checkbox, after realpath shows `<projectRoot>/supabase/.temp/stack-uploads/<id>` is inside the project, contains no symlinks (lstat), and its name equals the full id.

## How each repo rule is met
| Rule | How |
|---|---|
| Nothing product-specific | Neutral `backend` kind and BackendService. Supabase strings live in `providers/supabase.ts` and one Go hook file. Env names are options with a preset. No schemes, bundle ids or redirect URLs are set (`site_url` stays in the project). The hard-coded `EXPO_PUBLIC_SUPABASE_URL` in image-overlay.ts:21-24 moves to an option. Fixtures use example.com and ExampleApp. Hook rules apply only after you enable the feature. |
| Redact and bound before a store or the socket | Strip projections, the extended redactor, bounded arrays (instances ≤128, records ≤128, jobs ≤64), and nothing on the broker. |
| Devtools never in release bundles | Values only in the dev Metro spawn env (NODE_ENV=development, no builds). Nothing written to `.env*`, app.json, eas.json or config.toml. Hook X5 blocks `status --env > .env*`. Dotenv shadowing is detected. An opt-in `rndevtools-verify-bundle --forbid-loopback-urls` comes in Phase 6. `withDevtoolsPruning` is unchanged. |
| Typed protocol, narrowest preload | Strict zod both ways; four frozen bridge methods; `assertTrustedRenderer` on every handler; the router re-validates after the Go CLI. |
| Renderer never sends paths | Operations take stack ids, lane ids or main-issued repository ids. Expected rows are created by predicted id. Paths come only from main dialogs. P0 also closes lane-ipc.ts:57-62. |
| Destructive actions confirmed | Destroy, prune, reset, uploads removal and enabling Studio need a main dialog plus a one-time token. Stopping an external stack needs a dialog. An agent's destroy becomes a user request card. GC never destroys. |
| Lane creation fails instead of stealing | A stack belongs to its worktree identity, and no lane attaches to another worktree's stack. Ports pinned elsewhere produce a fast, named error. The P0 reservation closes the race. Metro restarts keep PID verification, and health becomes identity-aware. |
| Static reads only | Bounded line scans of config.toml, config.json and dotenv files. Project code is never evaluated. Starting a stack (project-influenced tooling) happens only when the feature is on and the repo has opted in. |

## Telemetry
- Every desktop spawn sets `SUPABASE_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1` and `SUPABASE_NO_UPDATE_NOTIFIER=1`.
- Agents' own CLI calls default to consent granted (consent.ts:155-170). Exporting the opt-outs in agent shells is your decision.
- RN Devtools itself sends nothing.

## Hooks are advisory
The hook fails open, needs `/hooks` trust in Codex, and does not exist in Cursor. The real controls are:
- the desktop pre-creating native stacks;
- the runtime and lsof checks;
- the container stop-once rule;
- the MCP tool text.

## Resource policy

## Measured basis
From the spike (FINDINGS.md), CLI 2.121.0, this 48 GiB, 14-core Mac.

| State | Physical footprint | Processes |
|---|---|---|
| Idle: DB only (owner Bun 67-88 MiB + about 22 MiB launcher + Postgres) | about 150-171 MiB | 10 |
| Three idle stacks | about 464 MiB | 30 |
| App services awake: REST, Auth, Storage, Realtime, Functions | about 885 MiB | 33 |
| Studio awake, which wakes analytics (BEAM about 492 MiB) and Next.js (about 232 MiB) | about 1.9 GiB | 52 |
| Stopped | 0 RAM; PGDATA 52-79 MB | 0 |

**Timings.**

| Operation | Time |
|---|---|
| First-ever start | 42.6 s (one-time download of about 363 MiB, extracting to a 1.7 GiB cache) |
| New worktree, with migrations and seed | 4.5 s |
| Resume | 1.0 s |
| Stop (idle) | 3.2 s; a fully awake stack stops one service at a time and can take well over 20 s |
| `db reset` | 4.6 s |
| Two concurrent new starts | 6.4 s |

**Wake after idle.**

| Service | Wake time |
|---|---|
| REST | 0.36 s |
| Auth | 0.75 s |
| Storage | 1.1 s |
| Realtime | 2.6 s |
| Functions | 0.57 s (22 s for the one-time first bootstrap) |
| Studio | 18 s |

Lazy services sleep after about 60 s; Studio after 300 s. An open WebSocket or TCP connection keeps a service awake.

**Ports.** About 10 public ports per stack from 20000-32767, plus an OS-assigned owner RPC port. There is no overlap with Metro (8100-8399) or the broker (47931).

**SysV.** One segment per running postmaster, shadow databases included, with `kern.sysv.shmmni=32`.

## Caps and admission
Checked before every create or resume.
1. **Running managed and adopted stacks below `maxRunning`.** The default is min(12, floor((shmmni − 8) / 2)), which is 12 here; settable from 1 to 24.
   - 12 running stacks leave 20 segments for shadow databases (`db diff`, declarative commands) and any other local Postgres.
   - Worst case, with every app awake: 12 × 0.885 ≈ 10.6 GiB. All idle: 12 × 0.17 ≈ 2 GiB.
   - Simulators and Metros come on top and were not measured.
2. **At least 2 free SysV segments** (`sysctl -n kern.sysv.shmmni` minus the `ipcs -m` count). If ipcs is unavailable, skip this check and warn. A Postgres shared-memory or 'No space left on device' failure maps to `backend_capacity`.
3. **Host memory pressure not `critical`** (simulator-metrics-provider.ts:43-66). At `warning`, proceed and add a warning to the receipt.
4. **Concurrency.**
   - New stacks are created one at a time. 2.121.0 probes native backend ports 10000-19999 without registry claims (Ports.ts:192-198), and the race can recur at lazy wakes.
   - Resumes and stops run two at a time.
   - At most 4 CLI children run at once, including reads.
   - Raise this once a stable release ships develop's claims.
5. **Over the cap.**
   - First, stop the least recently used unheld managed stack (non-destructive; it comes back in 1.0 s).
   - Otherwise refuse: `lane up` with auto continues with `skipped: capacity`; `backend up` returns `backend_capacity`.
   - Held and external stacks are never stopped to make room.

## Services
- Every desktop create and resume passes **`--exclude studio,analytics`**. This avoids the 1.9 GiB / 18 s path, the unauthenticated `/mcp`, and pg-meta (Studio includes pg-meta).
- **Recommended in repos:** commit `[studio] enabled = false` and `[analytics] enabled = false`, so agents' bare starts keep the exclusion. Committing `[storage.s3_protocol] enabled = false` is also worth it when the app does not use S3, since the S3 keys are fixed public constants.
- **Kept, but lazy:** rest, auth (keeps mail awake), realtime, storage with imgproxy, functions, mail. Pooler is optional to exclude; it is lazy and unused by typical apps.
- **Never `--eager`.** Optional per-lane eager mode comes only in Phase 6, for UI automation that cannot tolerate the 2.6 s Realtime wake.
- **Smoke test** Functions under the curated PATH in Phase 3 before keeping them included by default.

## Idle and stop policy
Applies to managed and adopted stacks; pinned (operator) and external stacks are never auto-stopped.

| Condition | Action | Default |
|---|---|---|
| Held, or a live session has its cwd in the worktree | keep running (idle costs about 171 MiB) | — |
| Last hold released explicitly (lane down with no session left, `backend down`, `release --all`) | stop after a linger | 60 s |
| Every holder abandoned (Claude PID dead; Codex inactive 30 min) | stop at missingSince + grace, after re-checking holders and supabase CLI processes in the worktree | 10 min |
| Discovery `unavailable` | freeze the clocks | — |
| Orphan (project root missing on two checks 15 s apart) | stop now | on |
| Superseded by a branch follow | stop after the linger, data kept | on |
| Container runtime on a managed identity | stop once per desktop session, flag, notify | on |
| Desktop quit | do nothing; stacks outlive it, like Metro | — |

## Disk, GC and retention
- **Stop never deletes data. Destroy is never automatic.**
- **Prune candidates**, shown with sizes:
  - orphaned and unreadable stacks, right away;
  - stale-branch, and stopped-and-unattached for more than 14 days (`retentionDays`).

  Everything goes through one main dialog plus a token, and only for ids present in a fresh list. A full id that is not registered makes destroy enumerate Docker and Podman containers, and Docker hangs on this Mac.
- **Disk per stack.** A bounded walk (at most 50,000 entries, 2 s) of `~/.supabase/stacks/<id>` and of `stack-uploads/<id>`, every 10 minutes while the tool is visible. Logs are capped upstream at about 10 MiB per service instance.
- **The 1.7 GiB artifact cache** is shown but never touched. The CLI retires unused generations after 30 days. CLI upgrades download hundreds of MiB, so they run as jobs.
- **Leftovers after destroy.** Destroy leaves an empty `stacks/<id>/data` shell that later owners prune. Uploads survive destroy unless the checkbox is ticked.
- **backends.json** history of destroyed stacks is pruned after 30 days. Lane logs of removed lanes are deleted after 7 days (P0-7).

## Polling budget
| Tier | What | When |
|---|---|---|
| Cheap (no Supabase CLI) | pgrep + ps argv; one read-only ports.sqlite SELECT; stat of roots and gitdir HEAD + markers | every 15 s while enabled. In P1, only while the view is visible |
| Inventory | `stack list` (probes each owner, briefly takes idle owners' lock) | when the id set changes, after lifecycle events, or every 5 min; single-flight; waits for in-flight creations |
| Detail | `stack status --stack-id` | on attach, inspect, or while the drawer is open (every 10 s) |
| Exposure | lsof over the tree | after every lifecycle operation, and every 5 min for running managed stacks |
| Footprint and disk | top-style footprint per tree; du | 30 s and 10 min, only while visible |

**Local-only metrics.** `doctor.backends.stats` (starts, failures by code, p50/p95 start ms) is held in memory, never sent anywhere, and feeds the kill criteria.

## Prerequisite fixes (Phase 0)

- **P0-1: Holder liveness clock** (agent-service.ts:111, 307-352; device-hold.ts:122-128).
- **Problem:** `#missingSince` is written only for claims, so a lane-only holder's `releaseAt` slides forever, and lane-service.ts:879-902 never stops abandoned lanes.
- **Fix:**
  - On every refresh, track missingSince for every holder key that lanes, claims and (later) backends reference. Set it when the key goes missing, delete it when the key is live, and prune unreferenced keys.
  - Treat discovery `unavailable` (agent-sessions.ts:160-200) as unknown and freeze the clocks.
  - Export a resource-agnostic `resolveHolderLiveness()`, and leave `deviceHoldSchema` unchanged.
- **Failing test first:** the real AgentService plus LaneService reconcile releases a lane-only holder after DEVICE_HOLD_GRACE_MS.
- **P0-2: Synthetic MCP attribution** (server.go:340-356; agent-command-router.ts:1384-1432; device-hold.ts:113-117, 146-178).
- **Problem:** Codex MCP calls share `codex:mcp-codex-mcp-client`. Lanes are recorded with no agent, so they are operator-owned, never abandoned, and the same Codex session is even refused `device_held` on its own lane.
- **Fix:**
  - Treat envelope ids starting with `mcp-` as synthetic. Detect this by prefix only, so nothing new is persisted.
  - The router passes the envelope agent into lane.start and launch when `command.agent` is absent.
  - A synthetic holder is live while a discovered session of the same kind has its cwd inside the lane's app dir (agent-protocol.ts:197-208).
  - Decode `cwd` in SessionEndPayload (hook.go:90-94) and send it as `release.sessionCwd` (app/setup.go:245-250; schema.go:305-344; agent-cli-protocol.ts:271-284). Synthetic releases match only by sessionCwd.
  - Test that the session-end kind inference (app/setup.go:210-221) does not fall back to `other` under Codex.
  - Fix README.md:80-82 and :119, and the stale message at agent-cli-protocol.ts:354.
- **P0-3: Timeout alignment.**
- **Problem:** agent-cli-service.ts:93-101 caps every handler except wait and recipe run at 60 s, while describe.go:199-204 gives lane and native 240 s. Codex's per-server MCP timeout also applies: the `tool_timeout_sec` key is present in the installed 0.162.1 binary, but setup.go:309 writes only command and args.
- **Fix:**
  - Give lane up/launch and native 230 s on the desktop.
  - Have setup write `tool_timeout_sec = 240` into the owned `[mcp_servers.rndevtools]` table. Verify the semantics against Codex's docs first.
  - Add recovery text to the generic `invalid_request` (agent-cli-service.ts:388-398): 'Update RN Devtools, or restart the agent session to reload the rndevtools tools'.
- **Tests:** a 90 s fake lane handler completes, and the setup_test Codex block includes the key.
- **P0-4: `release --all` honesty and budget** (agent-command-router.ts:422-481).
- **Problem:** line 453 pushes a stopped lane even when the receipt says `completed:false`, and lane stops run one after another on the request signal. The SessionEnd client gives up after 2 s (app/setup.go:235-236), and a closed socket aborts the handler (agent-cli-service.ts:402-409).
- **Fix:**
  - Honour `receipt.completed`.
  - Release holds in memory first.
  - Stop lanes concurrently within a 1.5 s budget. The rest continue detached from `context.signal` and are reported as `pending`.
  - Backend stops (later) are always asynchronous.
- **Test:** a slow fake stop still returns within 2 s, and a failed stop appears in `errors`.
- **P0-5: Lane reservation race and port-only Metro health** (lane-service.ts:428-531, 961-976; lane-metro.ts:145-165).
- **Reservation:** keep an in-memory reservation of (app directory, UDID, port), taken before the first await and released on upsert or failure. `#pickFreeDevice`, `findLaneConflict` and `allocateLanePort` all consult it. Lane up is single-flight per app directory.
- **Health:** a health probe counts only when `lsof -a -p <metroPid> -iTCP:<port> -sTCP:LISTEN` shows the lane's own PID owns the port. Without this, the second lane of a race can be reported ready against another worktree's Metro.
- **Test:** two concurrent lane ups against one free booted device produce distinct devices and ports, or one lane plus one device request.
- **P0-6: Redactor gaps** (packages/core/src/core/redact.ts:1-39).
- **Problem:** `SENSITIVE_NAME` must sit directly before `=` or `:`, so these pass through unredacted:
  - `SECRET_KEY=sb_secret_…`;
  - JSON `\"SECRET_KEY\":\"sb_secret_…\"`;
  - bare `sb_secret_` tokens;
  - `DB_URL=postgresql://postgres:pw@…`.
- **Fix:**
  - Add value rules for `sb_secret_[A-Za-z0-9_-]+` and for URL userinfo passwords (keep the user, drop the password).
  - Add the names SECRET_KEY, SERVICE_ROLE_KEY, ROOT_KEY and DB_URL.
  - Mirror upstream's list (packages/stack/src/internal/redact-credentials.ts:32-60).
  - Add no blanket 64-hex rule, because stack ids are 64-hex.
- **Gates:** run the core, react-native and desktop quality gates.
- **P0-7: Redact `lane.log` and bound lane logs.**
- lane-service.ts:317-329 returns the raw Metro tail (up to 64 KiB) to agents and the renderer. Pass it through `redactDiagnosticText` with the P0-6 rules.
- Delete the logs of removed lanes after 7 days. Today they are never deleted (lane-service.ts:861-868).
- **P0-8: Metro environment hygiene** (lane-metro.ts:11-18, 110-133).
- **Problem:** `...process.env` passes the desktop's inherited EXPO_PUBLIC_* into every lane's dev bundle.
- **Fix:**
  - Strip inherited EXPO_PUBLIC_*, SUPABASE_*, PG* and RNDEVTOOLS_* from Metro's env. This is a behaviour change; mention it in release notes.
  - Add a validated `laneEnv` slot, merged after metroEnv and before the fixed keys, at both spawn sites (lane-service.ts:505-511, 787-793).
- **Test:** the exact child env.
- **P0-9: LaneStore quarantine** (lane-store.ts:47-58).
- **Problem:** a lanes.json that is valid JSON but fails the strict schema is silently ignored and later overwritten, which orphans detached Metros.
- **Fix:** rename it to `.corrupt-<ts>`, as AgentClaimStore does (agent-service.ts:54-63).
- **Test:** a schema-invalid lanes.json is renamed and not overwritten.
- **P1-10: Hook exemption per segment, and payload cwd** (hook.go:52-66, 81).
- **Problem:** any command containing `rndevtools` skips the Metro rule, so `rndevtools doctor; expo start` passes.
- **Fix:** evaluate shell segments independently, and decode the PreToolUse payload `cwd`, which the Phase 2 rules need.
- **Tests:** hook_test cases.
- **P1-11: Hard-coded vendor variable** (packages/react-native/src/diagnostics/image-overlay.ts:21-24). The `EXPO_PUBLIC_SUPABASE_URL` host allowlist becomes an option with a neutral default. Verify both packages.
- **P1-12: Renderer path intake** (lane-ipc.ts:57-62).
- **Problem:** lane.start forwards a worktreePath supplied by the renderer. apps/desktop/AGENTS.md says lanes never take a path from the renderer except through the repository dialog.
- **Fix:** accept only paths in main's discovered worktree cache. Backend IPC is id-only from day one.
- **P1-13: Lane launch by a non-holder transfers ownership** (lane-service.ts:849-855; the router's launch case has no access check).
- With backends attached, this would also move the backend's holder and auto-stop clock.
- **Fix:** refuse with `device_held`, or attribute without transferring. This is your decision; the recommendation is to refuse.

## Phases

### Phase 0: Prerequisite fixes (separate small PRs, no Supabase code) (size M)

**Scope.** **Fixes:** P0-1 to P0-9 and P1-10 to P1-13 from prerequisite_fixes. Each is a small PR that starts with a failing test.

**Gates:**
- the workspace's `quality` command;
- core changes also run the react-native and desktop gates;
- Go changes run `go test ./...` and the stdlib-only check.

**Records:** PROVENANCE.md records `release.sessionCwd`, and the Codex `tool_timeout_sec` line is added to setup.

**Exit criteria.** Every new test fails before its fix and passes after it.

The following hold:
- a lane-only holder past 10 minutes is released by the real AgentService plus LaneService;
- two concurrent lane ups never share a Simulator or port;
- a lane can no longer be reported ready against another lane's Metro;
- a 90 s lane handler is not aborted;
- `release --all` returns within 2 s and lists failed stops in `errors`;
- `lane.log` and CLI error text contain no `sb_secret_` values or URL passwords;
- a schema-invalid lanes.json is quarantined;
- `pnpm quality` is green.

Behaviour is unchanged for users without Supabase, apart from stricter redaction and the stripped inherited env.

### Phase 1: Read-only observer and Backends view (one PR, desktop only, flag off by default) (size M)

**Scope.** **New files:**
- `shared/backend-protocol.ts`;
- `main/backend/{providers/supabase,supabase-dialects,supabase-cli,supabase-contract,backend-project,backend-discovery,backend-policy-store,backend-service}.ts`, with the service as an observer only;
- `main/backend-ipc.ts`;
- `renderer/state/backend-runtime.tsx`;
- `renderer/panels/simulator/{backends-view.tsx,backends-model.ts}`;
- fixtures under `__fixtures__/supabase-2.121.0`, hand-written in the spike's shapes with placeholder secrets.

**Edits:**
- index.ts wiring;
- preload, ipc.ts and desktop-api.d.ts: get, subscribe, run;
- main.tsx provider;
- the third toggle in lanes-panel.tsx;
- in settings-panel.tsx, a capability row and an Enable toggle with the main-owned acknowledgement dialog.

**Argv allowlist:** `--version`, `stack list` and `stack status --stack-id`.

**Discovery:** pgrep/ps argv, ports.sqlite read-only, gitdir HEAD, and lsof over owner trees.

**Polling** happens only while the view is visible.

**Not included:** lifecycle operations, backends.json, steering, lane changes, Go changes. Roughly 2,000 lines plus tests.

**Exit criteria.** - **Off means off.** While the flag is off, no process is spawned; a FakeCli asserts zero calls.
- **Inventory.** With 2.121.0 present, the view lists every stack from list, pgrep and ports.sqlite.
  - Each row is joined to worktree, lane and session.
  - Flags: orphan, stale-branch, LAN-exposed (from runtime), exposure from lsof, unreadable, transient.
  - Expected rows appear for opted-in worktrees.
  - Onboarding cards show the flag, the config conflict, pinned ports with line numbers, and the CLI gate.
- **Safety and contracts.**
  - No JSON-address check marks appear.
  - Serialized state and IPC payloads contain no secret-shaped strings.
  - The identity vector 64616c83…145f passes, as do all fixture contract tests.
- **Manual check** (needs approval to run the CLI): the view matches `pnpm exec supabase stack list` on this Mac.

### Phase 2: Corrective agent steering (desktop steering writer plus Go hook) (size S)

**Scope.** **Desktop:** `steering-writer.ts` writes steering.json:
- the enabled flag, desktop pid, writtenAt;
- a heartbeat every 60 s;
- no managed roots yet;
- kept across quit, removed on disable.

**Go:**
- `internal/setup/steering.go` reads the file, validated like the socket.
- `hook_supabase.go` has a per-segment tokenizer, the fallback rules F1-F3 and the always-on rules X1-X5. Every rule applies only when the feature is enabled.
- `hookUsage` and the installHooks detail text are updated.
- The `AgentsBlock` Local Supabase paragraph is added, in its fallback wording, only when `<project>/supabase/config.toml` exists.

**Exit criteria.** - **hook_test matrix passes.** It covers:
  - runners (npx, pnpm exec/dlx, yarn, bunx, bun x, npm exec, a path binary, a `supabase@` version);
  - `--runtime=native` forms and `--help`;
  - `cd` prefixes, and `--workdir` inside and outside the worktree;
  - the declarative chain rule;
  - `.env` redirects and tee;
  - pkill variants;
  - the per-segment rndevtools exemption;
  - legacy projects that have not opted in;
  - `SUPABASE_EXPERIMENTAL_STACK=0/1` prefixes.
- **Steering file:** with the feature off nothing changes; a stale, symlinked or group-writable file is ignored; parse errors fail open.
- **Fallback works:** with the desktop quit, agents in opted-in projects can still run `supabase start --runtime native` and plain `supabase stop`.

### Phase 3: Managed backends for lanes (3a main, 3b renderer) (size L)

**Scope.** **3a, main process:**
- New modules: backend-store, and backend-jobs (persisted ring, detached children, orphan adoption on boot).
- CLI runner and admission:
  - lifecycle start and stop added to the runner's allowlist;
  - admission (cap, SysV, memory pressure), one-at-a-time creation, two-at-a-time resume and stop;
  - lsof verification that fails closed.
- Lane integration:
  - `ensureForLane` with the 15 s window, late attach and deferred launch;
  - `restartMetro`; the env hash on resume; detach on stop;
  - laneEnv mapping with `pinned-by-environment` and `shadowed`.
- Holds and GC:
  - lane holds plus implicit cwd liveness;
  - GC stops: linger, abandoned, orphan, least-recently-used over the cap;
  - container stop-once.
- Router and protocol:
  - the lane up `backend` summary;
  - wait and jobs seeing backend jobs;
  - `release --all` backend release;
  - doctor `backends`;
  - the wire-only lane-protocol deltas;
  - the environment default `backend: auto` for development.
- Fixtures re-recorded from the real binary (needs approval).

**3b, renderer:**
- The Backends tool on shortcut 9, with the metric grid.
- Actions: Start, Stop, Restart Metro to attach, Pin, Adopt, Open Mailpit, Copy public env.
- BackendChip in Lanes, Fleet and Agents.
- The lane start-form Backend select and the lane detail section.
- Settings policy controls and the app variables mapping.

No Go changes: agents get backends through `lane up`'s environment default.

**Exit criteria.** **Manual smoke** (needs approval):
- two worktrees start lanes concurrently and get distinct stacks;
- lsof shows only loopback;
- each Simulator app reaches its own stack's REST, Auth (sign-in via a Mailpit magic link), a Storage upload and a Realtime subscription;
- Functions work under the curated PATH.

**Automated:**
- Metro's child env holds exactly the mapped names.
- A cold first start returns `starting` and launches after the late attach.
- `lane down` stops the backend 60 s later, but only when no session is in the worktree; a killed session stops it after the grace period.
- `release --all` returns in under 2 s and the stops complete in the background.
- A desktop restart in the middle of a job ends consistent.
- After a reboot, `lane up` restarts the stack with the same URL.
- A Docker stack on the identity is refused and stopped once.
- Two weeks of local stats are captured for the kill criteria.

### Phase 4: Agent surface, managed steering and destroy (size L)

**Scope.** **Agent command:**
- The TS and Go `backend` kind: up, down, ls, status, env.
- Lane `--backend`.
- Session and worktree holds, using sessionCwd for synthetic callers.
- Typed errors with recovery text that names the self-start fallback.

**MCP and setup:**
- MCP tool, `rndevtools://backends` resource, server instructions.
- The `rndevtools-backend` skill and the lanes-skill delta.
- The managed AGENTS wording.
- Setup embeds `skills/*/SKILL.md`.

**Managed steering:**
- steering.json gains managed roots with `branchContext`, `stackReady` and `runner`.
- Hook managed rules M1-M4.

**Destroy:**
- `confirmBackendOperation`, then a token, then a fresh list, then destroy, with the uploads checkbox and path checks.
- Prune and Clean up.
- Agent destroy request cards.

**Docs and experiment:**
- README and PROVENANCE in the same commit as the schemas.
- The discovery experiment gains database prompts, Supabase leak patterns, and a condition with Supabase's Claude plugin installed.

**Exit criteria.** - The Go and TS schemas accept and reject the same matrix.
- The hook matrix covers managed and fallback, including a dead socket or a stale file falling back to fallback mode.
- Destroy is impossible without a consumed token.
- Ids missing from a fresh list are never destroyed.
- `backend up` over MCP and over the CLI works for Claude Code and Codex.
- The discovery experiment reaches at least 11/12 adoption with 0 leaks on database prompts, including the plugin condition.
- An old desktop answers a new CLI with recovery text.

### Phase 5: Hygiene and edge cases (size M)

**Scope.** **Branch follow:**
- a 30 s debounce and git-operation markers;
- held stacks only; stop the old stack and reattach on switch-back;
- warn mode;
- an explicit `backend up` bypasses the debounce.

**CLI upgrades and drift:**
- owner binary stat; a verified-version bump restarts the stack automatically;
- an unverified bump drops the worktree to observed;
- the needs-recreate dialog, driven by the envelope's root `recreate_command`.

**Cleanup:** retention, prune suggestions with sizes, and the disk walker.

**Agent and operator extras:**
- the logs viewer and `backend log`;
- `backend reset`, for the sole holder or with an operator token;
- the agent destroy-request operation;
- the Studio toggle dialog;
- warm cache with `stack prepare --runtime native` followed by a stop.

**Detection and warnings:**
- a per-state-root list for a foreign SUPABASE_HOME;
- `home-mismatch`;
- the previous-session-on-Simulator warning;
- a composition-drift re-apply action.

**Exit criteria.** Scripted scenarios pass against the real CLI (needs approval):
- a branch switch and switch back keep data intact;
- an interactive rebase creates no stack;
- worktree deletion leads to an orphan stop, then prune or destroy;
- bumping `supabase` in one worktree restarts only that stack;
- an unverified bump falls back to fallback steering;
- a forced Postgres-major change produces needs-recreate;
- logs are redacted;
- Studio enable and disable round-trips.

### Phase 6 (optional): Hardening (size M)

**Scope.** **Per-stack keys (full set):**
- JWT secret, publishable key, secret key, and an ES256 signing-key file;
- written once per worktree into a gitignored `supabase/.env.local`, checked with `git check-ignore`;
- the key file is 0600 and lives outside the repo;
- drift fingerprints catch reverts.

**Other options:**
- a pinned-ports compatibility mode, with leased `SUPABASE_*_PORT` blocks in a range RN Devtools owns;
- a `rndevtools-verify-bundle --forbid-loopback-urls` preset plus a Supabase local-default-keys preset;
- a per-repo static app-variable mapping read from package.json;
- per-lane eager mode;
- a Docker opt-in only as a separate design with LAN acknowledgement, or never.

**Exit criteria.** - Each item ships behind its own setting and defaults to off.
- Phases 1-5 are unchanged when an item is disabled.
- An agent's bare restart keeps the per-stack keys, and a forged token signed with the default ES256 key gets 401.
- verify-bundle flags a seeded loopback URL in a fixture release bundle.

### Phase 7: Graduation or kill review (size S)

**Scope.** Review the local stats and the state of upstream against the kill criteria:
- **K1:** two consecutive verified CLI bumps each need adapter code beyond fixtures.
- **K2:** the `local` rename, or any release, drops a list or destroy equivalent.
- **K3:** any non-loopback listener appears on a native stack of a verified version.
- **K4:** backend-caused lane-up failures exceed 5% (opt-in and pinned-port refusals excluded), or any data loss happens without a confirmed destroy or reset.
- **K5:** warm start p50 exceeds 15 s, or lazy-wake automation failures appear.
- **K6:** the fleet routinely hits the SysV or memory ceilings.

**Upgrade triggers:**
- a stable release with native backend-port claims, which lets creation concurrency rise;
- a snapshot CLI, which enables a baseline cache;
- a compatibility promise for `local`, which lets the gating relax.

**Exit criteria.** A written decision: stay alpha, enable by default for opted-in repos, freeze the pinned version, or retire. It records:
- the measured stats (start p50/p95, failure codes, memory);
- the upstream status of #7162, snapshots, the rename and port claims.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Alpha CLI churn: the `stack` flags, JSON or behaviour change in a weekly release. | high | high | - A dialect table with a verified gate. - Strip projections that fail closed: no env is injected when parsing fails. - Fixtures recorded per version, and a recorder script. - Unverified versions drop the worktree to `observed`, with stop and destroy still working. - Kill criterion K1. |
| The `stack`→`local` rename keeps only start/stop/status/logs (dev-alpha-command-structure.md:163-167), so inventory and destroy through the CLI disappear. | medium | high | - The dialect sets `inventory:false` and `destroy:false`, which disables managed creation. - Stop by id and argv-verified SIGTERM keep working; inventory comes from ports.sqlite and owner argv. - File the upstream ask. - Kill criterion K2. |
| Release mismatch: an agent uses `dlx`, `@latest`, a global CLI, or a bumped devDependency, so its own `--local` commands fail and the CLI suggests stop or destroy. | medium | high | - Only worktree binaries are run. - Pin the exact version per repo; npm and Homebrew builds of one version share the release id. - Hook M4 and the skill's runner hint. - The classifier answers with 'backend up (data kept), never destroy'. - Owner binary drift detection, and CLI upgrades treated as fleet events. |
| LAN exposure through a Docker/Podman stack created by an agent: bare start, `db start`, declarative `--local`, or a shadow database while no project stack exists. | medium | high | - The desktop pre-creates the native stack on lane up and backend up, which also makes shadow databases native (stack-shadow.ts:51-62). - Hook F1-F3 and M1-M3. - Container stacks are stopped once, flagged and announced. - lsof verification after desktop starts. - A doctor warning when a Docker socket exists. - File an upstream ask for a runtime pin in config. |
| Steering misfires or dead-ends: a stale steering file after a crash, PID reuse, or blocks when the desktop cannot answer. | medium | medium | - Managed mode needs a steering file at most 3 minutes old and a live socket connect. - Otherwise the corrective fallback applies, which always allows `supabase start --runtime native`. - Every Supabase rule is gated on the feature. - Fail open. - A full hook test matrix. - MCP text that names the self-start fallback. |
| The local trust weakness is exploited: same-user processes, other accounts, or web pages reach superuser through the trusted `supabase_admin` path, public default keys, the `sb_secret_` constant and CORS `*`. | low | high | - State the single-user-Mac assumption in the enable dialog. - Exclude Studio and analytics, which removes `/mcp` and pg-meta. - Recommend disabling the S3 protocol when it is unused. - Per-stack keys in Phase 6. - Upstream asks: a password-checked `supabase_admin`, and a narrower CORS default. |
| Secrets leak into transcripts, renderer state, backends.json, logs or the bundle. | low | high | - Strip projections declare only public keys, and raw buffers are dropped. - The source enum cannot name a secret. - The extended redactor, and `lane.log` redaction. - Hook X5, and no `.env` writes. - Tests grep every serialized boundary for secret patterns. |
| The app's own dotenv files silently override the injected URL: Expo 57 merges `.env`, `.env.development`, `.env.local` and `.env.development.local` over Metro's env, even with EXPO_NO_DOTENV=1. The app might then talk to a hosted project. | medium | high | - A static scan for the mapped names, giving `shadowed` (auto warns loudly, required fails). - Onboarding-card lines with file:line. - A repo recommendation to keep EXPO_PUBLIC_SUPABASE_* out of committed dotenv files. - Skill text about hosted projects. |
| Resource exhaustion: the 32 SysV segments, shadow databases included, or memory alongside many Simulators and Metros. | medium | high | - A derived cap (12), a check for at least 2 free segments, and a memory-pressure gate. - Exclusions and no `--eager`. - GC stops, and least-recently-used stops over the cap. - The shared-memory failure maps to `backend_capacity`. - Metrics in the tool. |
| The native backend-port race at v2.121.0 recurs on lazy wakes; creation serialization cannot cover wakes (inferred). | low | medium | - One-at-a-time creation. - One automatic retry, and a `transient` classification. - The CLI's own three launch attempts. - Pin a release with backend-port claims when one ships, then re-verify. |
| Branch-switch churn or data surprise: each new branch is a fresh database; a detached-to-branch switch loses the detached stack's data from view. | high | medium | - A 30 s debounce, git-operation markers, held stacks only. - Stop, never destroy; switching back reattaches. - Explicit backend up. - The hook blocks shadow creators while the stack is not ready. - The skill says to create the branch first. - Prune old stacks only through the user. |
| Codex attribution stays coarse: all Codex MCP calls share one identity, and liveness relies on a 30-minute activity window and cwd matching. | high | medium | - Worktree-scoped holds for synthetic ids, released by sessionCwd. - Implicit cwd liveness. - Holds are never keyed on synthetic ids. - Re-test whether the Go MCP server process's cwd identifies the Codex thread, and whether Codex can pass per-thread metadata. |
| An interrupted first bootstrap (desktop quit, timeout, crash) leaves an incomplete stack, because there is no recovery journal. | medium | medium | - Detached lifecycle children, not tied to the request or Electron. - SIGINT then SIGTERM, never SIGKILL. - Before quitting, wait up to 15 s. - Adopt surviving children on boot. - Flag `interrupted` and offer destroy-and-retry. |
| Owner binary drift: pnpm install prunes or replaces the binary under a running owner, so lazy wakes fail. | medium | medium | - stat the owner's argv[0] on reconcile, and flag `binary-missing`. - Automatic stop then start with the verified worktree binary after a debounce. - An unverified bump becomes `observed`, and agents' fallback allows self-heal. |
| Orphans and disk growth from deleted worktrees, renames, moves, and stale branches. | high | low | - Orphans are stopped at once. - Prune suggestions with sizes. - Destroy works across releases from a neutral cwd. - An argv-verified SIGTERM fallback. - Guidance to destroy before `git worktree remove`. |
| Diverging HOME or SUPABASE_HOME between the desktop and agents creates duplicate stacks for one worktree; ports.sqlite ignores SUPABASE_HOME. | low | high | - The ports.sqlite `state_root` scan raises `home-mismatch`. - SUPABASE_HOME is never set implicitly. - Phase 5 adds per-root listing. - A doctor check. |
| Session carry-over on a reused Simulator: supabase-js keys sessions as sb-127-auth-token regardless of port, and the default signing key validates tokens on every stack. | medium | low | - A `previous-session-on-simulator` warning. - The skill says to sign out and back in. - Recommend deriving `auth.storageKey` from the URL including the port. - Per-stack keys in Phase 6 turn it into a clean 401. |
| Agents in OS sandboxes cannot run the CLI or reach 127.0.0.1, and stacks the desktop starts run outside the sandbox. | medium | medium | - Managed mode needs no agent-side start. - Doctor and skill guidance on sandbox allowances. - The enable dialog discloses the sandbox point. - Test the agents' `--local` commands inside Codex and Claude sandboxes in Phase 3. |
| Supabase's own agent integrations (Claude plugin, hosted MCP, hosted .mcp.json) pull agents to a shared hosted project. | medium | high | - Skill and AGENTS text: use the local stack unless the user asks. - An experiment condition with the plugin installed. - A user decision about installing hosted MCP in agent sessions (read_only plus project_ref if used). |
| Lazy-wake latency makes UI automation flaky after 60 s idle. | medium | low | - Document the wake times in the skill. - An open Realtime socket keeps the service awake. - Optional per-lane eager mode in Phase 6. |
| Downgrading RN Devtools, or version skew between the CLI and the desktop, breaks state or tools. | low | medium | - Separate versioned files with quarantine; lanes.json is unchanged. - `invalid_request` recovery text. - Additive rndevtools/1 changes recorded in PROVENANCE. |

## Tests

- packages/core redact.test.ts:
- **Redacted:** `SECRET_KEY=sb_secret_x`; JSON `SECRET_KEY: sb_secret_x`; a bare `sb_secret_x`; `SERVICE_ROLE_KEY=eyJ…`; `postgresql://postgres:pw@127.0.0.1:1/postgres` (keeps `postgres@`).
- **Kept:** 64-hex stack ids and `sb_publishable_` values stay intact, and existing cases are unchanged.
- The core, react-native and desktop gates all pass.
- agent-service.test.ts with lane-service.test.ts:
- a lane-only holder is released after DEVICE_HOLD_GRACE_MS through the real AgentService and LaneService;
- a synthetic `mcp-codex-*` holder is live while a Codex session has its cwd inside the app dir;
- discovery `unavailable` freezes the clocks;
- unreferenced keys are pruned.
- agent-cli-service.test.ts:
- a 90 s lane-up handler completes;
- backend up gets a budget of waitMs + 10 s;
- other commands keep 60 s;
- an unknown kind returns `invalid_request` with recovery text.
- agent-command-router.test.ts (P0 and P3):
- `release --all` returns within 2 s with a slow fake stop;
- `completed:false` lanes appear in `errors`, and the rest are `pending`;
- `releasedBackends` is reported without awaiting stops;
- `sessionCwd` releases only the matching synthetic worktree holds;
- lane up for a Codex synthetic caller records the envelope agent and is not refused on its own lane.
- lane-service.test.ts (P0):
- two concurrent lane ups never share a device or port;
- health counts only when the lane's own Metro PID owns the port;
- `lane.log` is redacted;
- a launch by a non-holder is refused (P1-13).
- lane-store.test.ts: a schema-invalid lanes.json is renamed to .corrupt-<ts> and not overwritten. lane-metro.test.ts: the merge order is stripped env, then metroEnv, then laneEnv, then the fixed keys, and inherited EXPO_PUBLIC_*, SUPABASE_*, PG* and RNDEVTOOLS_* are absent.
- supabase-contract.test.ts:
- every 2.121.0 fixture parses: list, list stderr, status running/stopped, status-no-stack error, start new/running/endpoint-changes, stop, destroy one/many, and the error envelopes for release mismatch, port conflict, runtime mismatch and not running;
- the start error envelope with a root `recreate_command` and `stack_changes` classifies as `needs_recreate`;
- the destroy partial envelope reads the root `destroyed_stacks`;
- projections never contain `sb_secret_`, `eyJ` (except ANON_KEY), `postgresql://` or SERVICE_ROLE;
- unknown fields are tolerated and stripped;
- zod errors never echo raw stdout.
- supabase-contract.test.ts:
- `expectedStackId('/tmp/project','refs/heads/main','default')` equals 64616c83912c48442ec266f86ee2d7f004d2be5c8b7f31a6d6b4c2634f82145f (identity.integration.test.ts:76);
- the `detached` and `ordinary-workspace` contexts work;
- a mismatch flags only that worktree.
- supabase-cli.test.ts:
- the spawn env equals the allowlist exactly (no SUPABASE_HOME unless set, no tokens, no CLAUDE*/CODEX*, no NODE_OPTIONS, no empty SUPABASE_*);
- cwd is the neutral directory;
- each phase's argv allowlist is enforced;
- a static source scan finds no forbidden flags;
- `--yes` appears only on the token path;
- both pipes are drained past their caps;
- lifecycle children survive request abort;
- a start timeout sends SIGINT, then SIGTERM after 45 s, and never SIGKILL.
- supabase-cli.test.ts (resolver):
- a nested pnpm workspace resolves from appPath before the project root;
- node_modules symlinked to the main checkout is accepted;
- a path outside the worktree or repo is rejected;
- group-writable files, symlinked binaries and other owners are rejected;
- mismatched supabase and cli-darwin-arm64 versions are rejected;
- owner argv[0] is used only when it validates;
- the gate maps 2.121.0 to verified, 2.121.3 to compatible, and 2.122.0, 3.0.0-next.15 and 0.0.0-dev to unsupported.
- backend-project.test.ts:
- detection climbs to the worktree root and never above it;
- `[experimental] stack = true` is recognized in table and dotted forms, and `false`, absent and `env()` values are handled;
- a config.json conflict is flagged;
- every legacy pinned port key is found with its line, including dotenv SUPABASE_*_PORT in supabase/ and the project root, while `[auth.email.smtp] port` is ignored;
- Expo dotenv shadowing is found in all four files;
- size caps hold;
- linked-worktree gitdir HEAD reads work, and the rebase-merge, MERGE_HEAD, CHERRY_PICK_HEAD and BISECT_LOG markers are detected.
- backend-discovery.test.ts:
- owner and launcher argv parse, including paths with spaces, and other uids are ignored;
- a fixture ports.sqlite is read read-only, including degrading on a hot journal;
- lsof parsing treats 127.0.0.1 and [::1] as loopback and `*:` and 0.0.0.0 as LAN, and a failure means unknown;
- ipcs and sysctl output parse.
- backend-service.test.ts (P1, observer): zero spawns while off; joins by realpath, laneAppDirectory and session cwd; orphan, stale-branch, LAN-exposed, unreadable, transient and expected rows; no polling while hidden; JSON.stringify(state) has no secret patterns.
- backend-service.test.ts (P3, manager):
- **Ensure and concurrency:** ensure is single-flight per identity; creations run one at a time and resumes two; admission covers cap, SysV and memory.
- **Container path:** stop once, flag, refuse; no loop.
- **Exposure:** an lsof failure or a non-loopback listener stops the stack and fails the operation.
- **Late attach:** deferred launch, then a Metro restart, then launch; in required mode a job failure stops the lane.
- **Restarts and jobs:** a restart reconcile starts nothing; the job ring gives `job_lost`; detached children are adopted.
- **GC:** linger, abandoned, orphan and least-recently-used timings; holders and supabase CLI processes are re-checked before each stop; external and pinned stacks are never auto-stopped.
- backend-service.test.ts (P5):
- branch follow respects the debounce and markers and follows held stacks only; switch-back reattaches; an explicit up bypasses the debounce;
- a missing owner binary leads to a restart with a verified version, and to observed with an unverified one;
- `needs_recreate` is never retried automatically: a lane up, an agent up or an operator Follow tries again (the operator's Start is refused with the recreate reason), and a stack status whose `config_drift` is unchanged clears the flag.
- lane-service.test.ts (P3):
- `metro.started[i].env` contains exactly the mapped names and values;
- `pinned-by-environment` and `shadowed` work;
- resume restarts Metro only when the env hash changes;
- device requests carry the backend policy through provideDevice;
- stopLane detaches without awaiting;
- a backend failure never fails an auto lane.
- backend-protocol.test.ts:
- the schemas are strict and bounded, and none has a key, password or DB URL field;
- the loopback URL check rejects 0.0.0.0, localhost, LAN addresses and https;
- operations accept only ids and reject smuggled paths;
- set-policy rejects paths;
- repository ids are validated;
- `decideBackendAccess` mirrors the device-hold reason text and grace behaviour.
- backend-ipc.test.ts:
- `assertTrustedRenderer` runs on every handler;
- a token from confirmBackendOperation is bound to the fingerprint of the operation, sorted ids and removeUploads;
- targets are re-resolved from a fresh list, and ids not in it are refused;
- copy-env and open run in main and return no key;
- uploads removal refuses symlinks, wrong names and paths outside the project.
- backend-store.test.ts and steering-writer.test.ts:
- atomic writes with 0600 files and 0700 directories;
- quarantine on invalid JSON and on schema failure;
- bounds hold;
- a property test confirms no secret-shaped strings;
- the steering heartbeat is written, removed on disable, and kept on quit.
- Go internal/setup/hook_supabase_test.go:
- **Modes:** the full block/allow matrix for managed, fallback and off.
- **Command shapes:** runners and versioned runners, `--runtime=native`, `--help`, `cd` prefixes, `--workdir` inside and outside the worktree, the declarative chain rule, and the shadow creators while not ready.
- **Cross-agent rules:** `.env` redirects and tee, and pkill/killall/pgrep variants.
- **Exemption:** per segment; `rndevtools doctor; supabase start` is still evaluated.
- **Steering file:** a dead socket or a stale file means fallback; a symlinked or group-writable file is ignored.
- **Robustness:** bad JSON fails open.
- Go command, describe and mcp tests:
- the validateBackend matrix;
- lane `backend` only with up;
- release `sessionCwd` only with all;
- deriveTimeout for backend;
- the tool list order, with backend after lane and the readOnly-false/destructive-false annotations;
- 4 resources;
- the instructions mention backend and the native self-start fallback.
- Go app/run_test.go and setup_test.go:
- session-end forwards the payload cwd as sessionCwd within 2 s and exits 0;
- the Codex block includes `tool_timeout_sec`;
- all embedded skills are installed;
- the AGENTS Local Supabase paragraph appears only when supabase/config.toml exists;
- the hook detail text is updated.
- renderer backends-model.test.ts and lanes-panel tests:
- rows, filters and badges;
- onboarding cards;
- BackendChip tones for every status;
- prune grouping and sizes;
- dialog copy names the branch, worktree, size, holders and uploads path;
- key values are never rendered;
- app-variable name validation (regex, collisions with metroEnv and fixed keys).
- Manual smoke on this Mac (needs your approval to run the CLI and services):
- **Fixtures and exposure:** record the fixtures; run lsof on the owner tree.
- **App behaviour:** supabase-js from a lane's Simulator does REST, Auth via Mailpit, a Storage upload and a Realtime subscription; Functions work under the curated PATH.
- **Lifecycle:** two worktrees run concurrently; branch switch and back; worktree deletion then orphan stop then destroy; reboot then resume with the same ports; a CLI bump in one worktree.
- **Agents:** Codex and Claude Code reach the backend over the CLI and MCP; their `--local` commands run inside their sandboxes.
- experiments/agent-discovery: database prompts (start the local DB, reset and seed, apply a migration, two worktrees at once); Supabase leak patterns for X1-X5, F1-F3 and M1-M4; BackendService wired into the fixture; conditions none, MCP, skill, both, and MCP plus Supabase's plugin; target at least 11/12 adoption with 0 leaks.

## Decisions for the maintainer

- **Native only.** Accept native-only as the runtime, knowing it gives weaker isolation than the Docker setup Supabase recommends for several projects, because Docker/Podman bind 0.0.0.0. Should Docker ever be offered later as a separate opt-in with explicit LAN acknowledgement, or never?
- **Single-user Mac and sandboxes.**
- Confirm the single-user-Mac assumption: supabase_admin is trusted on loopback, the default keys are shared, and Remote Login and Screen Sharing are off.
- Do any of your agents rely on OS sandboxes for containment? Stacks started by RN Devtools run outside them.
- **Repo opt-in.** Commit `[experimental] stack = true`, delete the Docker-era pinned port keys, and pin `supabase` exactly (2.121.0) as a devDependency in each target repo. This also moves teammates and CI to the stack backend. Also commit `[studio] enabled = false` and `[analytics] enabled = false`?
- **App variables.**
- Ship the Supabase + Expo preset (EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY) as the default mapping, or start empty and require explicit configuration?
- Does your app read the publishable key or the legacy anon key?
- **Default lane policy.** When the feature is on, should the development environment default to `backend: auto`, with staging and production off? Or should `required` or `off` be the default?
- **Capacity.** The default cap is 12 running backends, derived from kern.sysv.shmmni=32 with headroom for shadow databases (range 1-24). New stacks are created one at a time. Adjust for your typical fleet size?
- **Branch switches.** Follow by default (30 s debounce, held backends only, old stack kept) or warn only?
- **Cleanup timings.**
- Stop 60 s after release, 10 min after abandonment (at least 40 min for Codex), at once for deleted worktrees.
- Prune suggestions after 14 days.
- Never auto-destroy.

Keep these defaults?
- **Agent destroy and reset.** Should an agent's destroy always become a request card for you? Should an agent's reset be allowed without a dialog when it is the only live holder?
- **Hook scope.** Supabase hook rules would apply only after you enable local backends. In fallback mode they block a bare `supabase start` and require `--runtime native`; they also block `stop --all`, `stack destroy`, `pkill postgres` and `status --env > .env`. Is that the right strictness?
- **Codex timeout.** May `rndevtools setup` write `tool_timeout_sec = 240` into the Codex rndevtools MCP table, so lane up isn't cut off at Codex's default per-call timeout?
- **Telemetry.** Should `rndevtools setup` also export SUPABASE_TELEMETRY_DISABLED=1, DO_NOT_TRACK=1 and SUPABASE_NO_UPDATE_NOTIFIER=1 into agent sessions? Agents' own CLI calls default to telemetry granted.
- **Untested CLI versions.** Treat them strictly as observed-only, or allow newer patch releases of a verified minor with a warning (`allowUnverifiedPatch`)?
- **Per-stack keys (Phase 6).** Is it acceptable for RN Devtools to write a gitignored `supabase/.env.local` into each worktree? That is what makes keys survive agents' own restarts. Or stay with shared default keys and port isolation?
- **Inherited Expo variables.** Strip inherited EXPO_PUBLIC_* from the desktop's environment for every lane (recommended, a behaviour change), or keep a setting to inherit them?
- **Lane launch by a non-holder.** Refuse it with device_held (recommended), or attribute the launch without transferring ownership? This decides who holds an attached backend.
- **Approval to run the CLI.** May the supabase CLI and services run on this Mac for fixture recording (Phase 1 to 3) and the manual smoke tests? Running them was out of scope for this research session.
- **Out of scope.** Confirm that physical devices and LAN access stay out of scope. They would need a separate exposure design.

## Other recommendations

- **Target repos.**
- Commit `[experimental] stack = true`; for new projects, run `SUPABASE_EXPERIMENTAL_STACK=1 supabase init`, which pins no ports.
- Delete the legacy port keys: 54321-54329, 54320 and 8083.
- Remove `supabase/config.json` if both formats exist.
- Keep supabase/.gitignore from init.
- Pin `supabase` exactly as a devDependency.
- **Keep EXPO_PUBLIC_SUPABASE_* out of the app's `.env`, `.env.local`, `.env.development` and `.env.development.local`.**
- Expo 57 dev bundles merge those files over Metro's env even with EXPO_NO_DOTENV=1 (transform-worker.js:160-163).
- Supabase's documented `status --env > .env.local` pattern also writes SECRET_KEY into a file Expo bundles.
- **Agent-heavy repos:**
- commit `[studio] enabled = false` and `[analytics] enabled = false`, so even an agent's bare start stays lean and has no `/mcp`;
- commit `[storage.s3_protocol] enabled = false` when the app does not use S3;
- keep seed data small, since there is no clone primitive.
- **Agent habits:**
- Create the branch before `lane up` or `backend up`. A detached-HEAD worktree's first `git switch -c` gets a fresh database.
- Destroy a worktree's stack before `git worktree remove`; Studio snippets block a non-force remove.
- Use the worktree's own CLI (`pnpm exec supabase`) everywhere.
- **CLI upgrades are fleet events:**
1. stop the stacks;
2. bump `supabase` in every worktree together;
3. let RN Devtools restart them.

Any official build of one version shares the release id. The next release will almost certainly change it, since develop already computes a different digest.
- **Lane Metro watching.** Reconsider `CI=1` for lanes' Metro (lane-metro.ts:122). Expo then disables file watching (instantiateMetro.js:400, 570-575), so code and dotenv edits reach a lane only after a Metro restart. That is a separate decision from this feature.
- **App code.** Derive supabase-js `auth.storageKey` from the URL including the port, so a Simulator reused across lanes does not carry a session into another stack (the default key is sb-127-auth-token for every local stack).
- **Hosted Supabase.** Don't install Supabase's hosted MCP or plugin in agent sessions by default. If you do, use read_only with a project_ref, and keep the AGENTS text that says to use the local stack unless asked.
- **Cloud branching.** Use Supabase Branching only for PR previews, production parity, or physical-device testing. It costs per branch-hour outside the Spend Cap and needs the network.
- **Mac security posture.** Remote Login and Screen Sharing off, no other macOS accounts. Chromium's local-network-access prompt is the only browser-side barrier against pages reaching 127.0.0.1 ports that answer CORS `*`.
- **Codex attribution.** Track whether Codex can pass per-thread identity to MCP servers: the `x-codex-turn-metadata` threadId is in the binary, and server.go:291-294 ignores `_meta` today. Also test whether the MCP server process's own cwd identifies the thread; that would let the Go MCP server attach a cwd to synthetic envelopes.
- **Optional demo.** Add a small supabase/ fixture (one migration and seed) to examples/expo-demo, so CI can exercise detection and the parsing contract without running services.

## Upstream asks

- Let `--local` database and migration commands target a stack by `--stack-id` or `--stack` (supabase/cli#7162), so a lane can keep its stack across a branch switch.
- Keep `list` and `destroy` (and JSON output) in the planned `stack`→`local` rename, and give `local list|status|start|stop|destroy --output-format json` a stability promise.
- Add a committed runtime pin, for example `[experimental] runtime = "native"` or SUPABASE_STACK_RUNTIME, and a `--runtime` flag for `db start` and the declarative commands, so no command can silently pick Docker.
- Offer loopback-only publishing for Docker/Podman stack proxies, preferably as the default, instead of the hard-coded 0.0.0.0 in Network.ts:111.
- Replace `local all supabase_admin trust` behind the TCP proxy with a password-checked path, or per-stack random credentials for supabase_admin.
- Make the gateway's CORS configurable (allowed origins) and add a Host-header check on the dedicated Studio, pg-meta, Mailpit and analytics ports.
- Add an option to generate per-stack keys (JWT secret, signing key, publishable/secret keys) persisted with the stack, so a bare restart never reverts to the public defaults.
- Persist exclusions and activation with the stack, so a bare `start` after `stop` keeps them, or add a resume that applies config but keeps saved exclusions.
- Add snapshot save/restore, or create-from-baseline, for project stacks in the CLI. This enables cheap pre-migrated clones per worktree.
- Ship the native backend-port registry claims (develop Ports.ts) in a stable release, and extend them to lazy wakes.
- Expose the owner release id, owner pid and executable in `stack list --output-format json`, and add `--version --output-format json`, so tools can detect release mismatch without reading owner.json.
- Document whether Studio's `/mcp` endpoint authenticates anything, and allow disabling `/mcp` separately from Studio.
- Fix the stale docs: apps/cli/docs/stack-commands.md says Functions never idles, but the composition makes it lazy at 60 s. Also document that the update notifier writes `cli-latest` into supabase/.temp.
- Document whether the Codex (or MCP-spec) tool-call metadata can carry a per-session id to stdio MCP servers; this goes to the Codex team rather than Supabase.

## What verification changed

- **Shadow runtime (partial).** Shadow databases from `db diff`, `db pull`, `migration squash` and declarative commands inherit the saved runtime of the current branch's default project stack. Auto selection, and so possibly Docker, applies only when no such stack exists (stack-shadow.ts:51-62).
- **Change:** pre-creating the native project stack is enough to keep shadows native.
- **Managed mode:** the hook blocks shadow creators only while the branch's stack is not ready.
- **Fallback mode:** they are allowed, because any exposure is transient, and this is documented.
- **Two more creation paths (new).** `db start` (no `--runtime` flag; db/start/start.command.ts:10-15) and `db schema declarative generate|sync --local` both create a postgres-only project stack with `selectStackRuntime(undefined)`, i.e. runtime auto (stack-local-database.ts:220-246 with :235; generate.handler.ts:180-185; sync.handler.ts:282).
- **Change:** these are not plain data-plane commands. Rules F2, F3, M2 and M3 cover them.
- **Error envelope.** `recreate_command`, `stack_changes` and `destroyed_stacks` sit at the envelope root, next to `_tag` and `error` (output.layer.ts:542-547; machine-error-context.service.ts:4-12; start.handler.ts:888-895; destroy.handler.ts:189-191).
- **Change:** the classifier reads the root, `needs_recreate` is never retried automatically, and partial destroys use the root list.
- **JSON endpoint addresses.** They are always 127.0.0.1, even for container runtimes whose listeners bind 0.0.0.0 (Network.ts:111-113).
- **Change:** exposure is derived only from runtime plus lsof over the process tree, and an lsof failure fails closed. Adopt's 'listeners-unverified' attach is rejected.
- **Loose parsing.** `z.looseObject` passes undeclared keys through, so plain `status` env would keep SECRET_KEY, SERVICE_ROLE_KEY and DB_URL (status/SIDE_EFFECTS.md).
- **Change:** strip-mode `z.object` projections declare only the public keys.
- **Startup and stop budgets (partial).** Each service startup command gets 60 s, then readiness gets 60 s. The database waits up to `db.health_timeout` (2 min). Stops run one service at a time, POST /shutdown has no client timeout, and stopping a fully awake stack can take well over 20 s (ProcessRecipe.ts:217-218, 584; Orchestrator.ts:980-994).
- **Change:** create budget 300 s, stop budget 90 s with one process per id, an argv-verified SIGTERM fallback, and never SIGKILL a start.
- **Release identity.** It is `0.1.0+<digest of packages/stack sources and effect>`, not the CLI semver. npm and Homebrew 2.121.0 share 0.1.0+a559977f2134f3a5, and develop computes 8b6cc1ef8a8469e7.
- **Change:** pin an exact version (any official channel interoperates) and treat upgrades as fleet events.
- **Kept:** the desktop still runs only validated worktree binaries, plus owner argv[0] only when it validates. Executing unvalidated argv would hand the desktop's macOS privacy permissions to whoever wrote that argv.
- **Per-stack secrets.** Overriding only the JWT secret does not stop forged tokens: the default ES256 private key is public, and the `sb_secret_` constant still maps to service_role (ServiceConfig.ts:29-64; Defaults.ts:5-16; HttpProxy.ts:122-130). But `supabase/.env.local` is read by every CLI command (project-environment.ts:95-139).
- **Change:** Phase 6 keys must be the full set including a signing-key file. They can survive agents' bare starts through a gitignored per-worktree file, which the managed design wrongly called impossible.
- **Durable exclusions.** `--exclude` persists only for `stack restart`. A start after a stop re-reads config.toml and the current flags, and a start against a running stack reads no config at all (start/SIDE_EFFECTS.md; restart/SIDE_EFFECTS.md).
- **Change:** desktop resumes re-pass the exclusions, repos are told to commit `enabled = false`, and drift is flagged.
- **Expo dotenv precedence (partial).** Expo 57 dev bundles merge the app root's `.env`, `.env.development`, `.env.local` and `.env.development.local` over Metro's process env. EXPO_NO_DOTENV is checked only by @expo/env (node_modules/@expo/metro-config 57.0.12 transform-worker.js:134, 160-163).
- **Change:** static shadowing detection; `auto` warns and `required` fails.
- **CORS reach (partial).** The ports dedicated to Studio, pg-meta, Mailpit and analytics share the gateway proxy, with its CORS `*` and no Host check (Network.ts:200-206; HttpProxy.ts:251-266). Excluding Studio also drops pg-meta (stack.shared.ts:228-237).
- **Change:** the exclusions weigh more, and Studio enablement gets its own dialog.
- **Native port race at lazy wakes (inferred).** In v2.121.0 the native backend-port race can recur at every lazy wake, not only at start, because ports are reserved per launch (ProcessRecipe.ts:491-520, 597).
- **Change:** serialized creation reduces the race but cannot remove it. Collisions are classified transient and retried once, and a release with registry claims is the upgrade trigger.
- **`stack list` cost.** It briefly takes each idle owner's lock (Lease.ts:241-255), chmods the state root, and probes 8 owners at a time with 2 s timeouts.
- **Change:** adopt's cheap tier (pgrep plus one ports.sqlite SELECT) drives change detection, and list runs only when the set of ids changes or every 5 minutes.
- **Offline destroy.** It works after the worktree is deleted, but needs SUPABASE_EXPERIMENTAL_STACK=1 and an existing cwd. A full id that is not registered makes destroy enumerate Docker and Podman containers.
- **Change:** destroys run from the neutral cwd with the flag set, and only for ids present in a fresh list. Undecodable stacks show the CLI's guidance instead of the desktop deleting files.
- **Codex and Claude attribution.** All Codex MCP sessions share `codex:mcp-codex-mcp-client`, and forwarding CODEX_THREAD_ID through `env_vars` is unproven. Claude Code does pass CLAUDE_CODE_SESSION_ID to MCP servers (verified live).
- **Change:** worktree-scoped holds are needed only for Codex. Codex's own lane refusal (operator-held) is fixed in P0-2.
- **Discovery failure.** Codex discovery failure returns an empty session list (agent-sessions.ts:160-200), which would start every holder's clock.
- **Change:** an `unavailable` result freezes the clocks.
- **Metro health is port-only** (lane-service.ts:961-976; lane-metro.ts:145-165).
- **Change:** P0-5 makes health identity-aware, because late attach, branch follow and resume all restart Metro on a known port.
- **Sticky ports are not guaranteed.** A configured port can take over a stopped stack's automatic reservation, and that stack then gets a new port (Ports.ts:330-352).
- **Change:** ports are read from every start JSON, and Metro restarts on `endpoint_changes`.
- **Worktree writes.** Studio snippets in supabase/snippets block a non-force `git worktree remove`. The update notifier writes `cli-latest` into supabase/.temp.
- **Change:** another reason to exclude Studio; SUPABASE_NO_UPDATE_NOTIFIER=1 on every spawn; destroy before remove.
- **Routing versus start config.** Routing prefers supabase/config.json for the experimental flag, while stack start loads only config.toml (paths.ts:27-37; local-project-context.ts:81-91). An `env()` value for the flag fails decoding and routes to legacy.
- **Change:** detection flags a config.json conflict and requires a TOML boolean.
- **Socket and steering liveness.** The agent socket is removed on a clean quit (agent-cli-service.ts:259-268), but a crash leaves a stale file. Codex's per-server `tool_timeout_sec` exists in 0.162.1, and setup.go:309 does not write it.
- **Change:** the hook needs a fresh steering file plus a successful socket connect for managed mode. P0-3 writes the Codex timeout.
- **MCP annotations.** catalog.go marks no tool destructive (the meta struct at 59-64; only readOnly flags are set).
- **Change:** the backend tool ships readOnly:false and destructive:false, instead of managed's destructive:true.

## Ideas grafted from the other designs

- **From managed:** a bounded wait (30 s default, 45 s maximum) with a job fallback that reuses `wait --condition job`, and `release` that is always asynchronous. The in-lane wait was tightened to 15 s, with a deferred launch.
- **From managed:** the BackendHold model (lane, session, worktree, operator) with one resource-agnostic liveness helper, `deviceHoldSchema` unchanged, and synthetic `mcp-*` worktree holds released by `sessionCwd`.
- **From managed:** admission control (a running cap, SysV headroom from sysctl minus `ipcs -m`, and a memory-pressure gate). The cap is derived from shmmni rather than fixed.
- **From managed:** branch follow with a 30 s debounce, git-operation markers, held stacks only, stop-not-destroy, and reattach on switch-back. An explicit `backend up` and hook readiness were added.
- **From managed:** the agent protocol (`backend up|down|ls|status|env`, later reset/log/destroy-request), typed errors with recovery text, the lockfile-derived `cli.run` runner hint, agent destroy as a parked user request card, and reset only for the sole holder.
- **From managed:** the UI metric grid, prune grouping, request cards, the lane detail Backend section, Settings controls, and the enable-Studio dialog that explains `/mcp`.
- **From managed:** Studio and analytics excluded by default; separate backends.json and policy files; never stopping stacks on quit; SIGINT-first handling of starts; a wait before quitting; one automatic stop and start for a partial lifecycle.
- **From adopt:** the cheap discovery tier (pgrep/ps owner argv, one read-only ports.sqlite SELECT, HEAD stat), with `stack list` only when the set of ids changes or on a slow interval, and a per-state-root list for foreign homes.
- **From adopt:** status for live owners through the owner's argv[0] binary, with path, ownership and mode validation added against TCC privilege borrowing.
- **From adopt:** strip-mode `z.object` projections that declare only the public keys, combined with managed's source enum for the Metro mapping.
- **From adopt:** a lane never fails because of its backend (the outcome goes into `lane.backend` with `next`), and `pinned-by-environment` when metroEnv already sets a mapped name.
- **From adopt:** the corrective hook rule as the fallback mode (allow `--runtime native`, block bare starts with the corrected command), and the cross-agent stop rule covering `--stack-id`, `--project-id` and an outside `--workdir`.
- **From adopt:** per-repository onboarding cards (opt-in snippet, pinned listener ports with line numbers, CLI version); Pin and Adopt actions; external stacks never auto-stopped; the AGENTS paragraph only when supabase/config.toml exists.
- **From adopt:** re-checking holders and running supabase CLI processes in the worktree right before any auto-stop; implicit liveness for any live session whose cwd is inside the worktree.
- **From adopt:** `release --all` stops lanes concurrently within 1.5 s, reports the rest as pending, and honours `receipt.completed`.
- **From MVP:** the dialect table, fixture recorder, per-phase argv allowlist, and static scan for forbidden flags; kill criteria K1-K6 and the graduation review.
- **From MVP:** the neutral 0700 cwd and `--stack-id`-only addressing after creation; creation serialized while 2.121.0 lacks backend-port claims; `stack list` waiting for in-flight creations.
- **From MVP:** ActionConfirmationStore one-time tokens bound to {operation, ids, removeUploads}; steering.json validated like the socket (with liveness and modes added); the enable acknowledgement dialog; rule R7, now M4, against non-pinned CLIs.
- **From MVP:** the expected-stack-id canary on the upstream test vector, demoted to a per-worktree flag computed with native realpath; expected rows keyed by predicted id, so even creation is path-free from the renderer.

## As-built notes

The fixes from a repo-wide review on 2026-10-17 changed these engine behaviours after the build. Where the sections above say otherwise, these notes describe what ships.

- **Needs recreate** (Error classification). `needs_recreate` is never retried automatically. A lane up, an agent up or an operator Follow (through `followBranch`) tries again. The operator's Start does not: `checkSupabaseOperation` refuses it with the recreate reason, such as "[db] major_version changed from 15 to 17. Revert it to keep this stack, or recreate it." A stack status whose `config_drift` is unchanged clears the flag, as does a start that succeeds. The failure that set the flag stays with it until it clears (`recreateError` in stacks.json, `recreateChanges` in the state). A retry that fails for another reason, such as a taken port, replaces only `lastError`. So the automatic refusal, its recovery and the tab's pill, Resume reason and notice still say whether reverting keeps the stack.
- **Ensure flights** (Flows: Concurrency and partial failures). Ensures stay single-flight per identity, but an explicit one (the operator's, a lane's or an agent's) never joins a flight an automatic follow began, whose answer can be the refusal above. It waits for the automatic one to end and then runs its own flight. If the stack runs by then, as when the automatic flight started it, the explicit flight just attaches; otherwise it starts the stack as its own job. An automatic ensure joins whichever flight runs, including an explicit one that still waits. An agent's up that answers while its flight waits like this gives no job id: it says the up is queued and to call up again, because the automatic flight's job can fail while the up then succeeds.
- **Turning off** (Flows: Feature disable and re-enable). Once the switch reads off, nothing new begins. An ensure (lane up, agent up, Start or a follow) asks preflight again after it waits and after its reads, and an attach, like an Adopt, checks again inside the stack's lock before it probes; one in flight answers "Local Supabase is off in RN Devtools." instead of attaching or starting. Every lifecycle job, whoever asked for it, checks the switch when its turn comes: after the creation gate, the lifecycle gate and the stack's lock, right before it begins or makes its first CLI call. Off by then, it is cancelled with that message (`feature_off`). That covers starts, restarts, stop-and-starts, Studio switches, recreates, stops, destroys, migrations, resets, bucket seeds and pre-downloads, and an export once its save dialog closes. Only the turn-off's own stops skip the check. An ensure whose restart is cancelled answers the same refusal, not a CLI mismatch, and a cancelled drift restart or container stop runs once the feature is on again. A cheap tick, a Refresh, the start-up after a turn-on or a memory measurement in flight ends at its next step, and a tick's capacity read before its memory-pressure probe; a tick in flight when the desktop quits ends the same way. A wait on another tool's start stops reading, and a CLI read (a list, a status, logs, a database read or a dump) whose turn comes once off spawns and records nothing; an agent's log read answers `supabase_disabled` then, as its reset does. Jobs already running finish first, but without those reads, so a destroy that hasn't read its fresh list yet destroys nothing. Admission never judges room from the off state, which lists no stacks: a start still in admission, or whose room-making stop the turn-off calls off, is called off too. The status read a stop or start ends with spawns nothing if the feature is off by then, and keeps nothing if it ends while off, even one that began before the turn-off; either way the stack's last status is dropped instead, so on again the stack doesn't show as it was before while its first list is read. Only those two drop it: a read that a turn-off and a turn-on both land during ends while on, so it keeps what it read, and until it ends the stack shows as it was before. A list confirms an unchanged stack's status only if that status was read or confirmed since the list before; one that list left unread (a list reads 16) is read again. With Stop managed stacks, the stacks to stop are the managed stacks the state showed running or starting, and those of the starts, restarts, stop-and-starts, Studio switches and recreates running at the switch; the state shows a stack starting only once its CLI says so. The turn-off waits until none of those jobs is queued or running, then stops the stacks one at a time. Until its last stop, Turn on is unavailable ("Local Supabase is still turning off."), so those stops never run with the feature on again.
- **Branch follow** (Branch switches). A failed automatic follow is retried after 1 min, doubling up to 30 min, per worktree and target. A move to another branch starts over.
- **Destroy budget** (Supabase CLI invocations). 2 min per stack, capped at the runner's 60-minute limit for one call.
- **Progress files** (Handling CLI processes). A lifecycle child's progress file is removed once its result has been read, and `start()` prunes files that earlier runs left behind.
- **Child adoption** (Handling CLI processes, Desktop restart). A surviving child is adopted only when its pid is alive and `ps -ww -o args=` matches the recorded command-line digest. The digest is checked only while the feature is on: while it is off nothing is spawned, so the pid check alone decides. A pid the liveness check answers with EPERM (another user's process) counts as not ours.

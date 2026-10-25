# Per-worktree local Supabase: findings

> **Date:** 2026-10-16.
> **Sources:** research from source code and docs, a hands-on spike on this Mac, and adversarial verification at `supabase/cli@v2.121.0` and in this repository.
> **Companion doc:** [DESIGN.md](DESIGN.md).

## Hands-on spike: native Supabase stacks on this Mac (2026-10-16)

The environment:
- **Machine:** macOS 26.7.1 arm64, 48 GiB RAM, 14 cores.
- **CLI:** Supabase CLI 2.121.0 from the npm tarball `@supabase/cli-darwin-arm64`. Its sha512 matched npm's integrity value, and the binary is ad-hoc signed.
- **How every call was made:** through a wrapper with an allowlisted env (`env -i`). The wrapper set `SUPABASE_EXPERIMENTAL_STACK=1`, `SUPABASE_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, `SUPABASE_NO_UPDATE_NOTIFIER=1`, and a scratch `SUPABASE_HOME`. Calls passed `--runtime native`, `--workdir`, and `--output-format json` explicitly.
- **Test repo:** one migration (a table with RLS and a select policy) and a 1000-row seed.
- **Worktrees:** created with `git worktree add -b`, plus the main checkout.

All stacks were destroyed afterwards, and no owners, listeners, port reservations, or SysV segments remained.

## Facts observed (ground truth for this CLI version)
- **Init:**
  - `SUPABASE_EXPERIMENTAL_STACK=1 supabase init` writes `[experimental] stack = true` into `supabase/config.toml`.
  - It pins no service ports. Only the smtp/pop3 port lines appear, commented out.
  - So a committed config routes every CLI call to the stack backend without any env var.
  - The generated `supabase/.gitignore` ignores `.branches`, `.temp`, `.env.keys`, `.env.local` and `.env.*.local`.
- **Timings:**
  | Operation | Wall time |
  |---|---|
  | First start ever: downloads artifacts (1.7 GiB extracted cache), initdb, migration, seed | 42.6 s on this network |
  | Warm start of a second worktree, migration and seed included | 4.5 s |
  | Restart of a stopped stack (migrations are not re-run) | 1.0 s |
  | Stop | 3.2 s |
  | `db reset --local` | 4.6 s |
  | Two new stacks started concurrently (one trial, no port collision) | 6.4 s |
- **Binding:** every listener of every stack's process tree was on 127.0.0.1, checked with lsof on TCP and UDP.
  - The owner process holds all public listeners.
  - Each stack exposes one API gateway port, shared by rest, auth, realtime, storage and functions. That port is API_URL.
  - It also exposes the database sql, studio, pgmeta, analytics, realtime.rpc and functions.inspector endpoints, plus mail http/smtp/pop3.
  - That is about 10 public ports per stack from 20000-32767, plus the owner's RPC port, which the OS assigns.
- **Ports and registry:**
  - Each worktree got a distinct stack ID and disjoint ports.
  - Ports were identical across stop and start.
  - Reservations are kept on stop and released on destroy.
  - Schema of `<passwd home>/.supabase/ports.sqlite`: `reservation(port INTEGER PRIMARY KEY, state_root TEXT NOT NULL, stack_id TEXT NOT NULL, endpoint TEXT NOT NULL, UNIQUE(state_root, stack_id, endpoint))`.
- **Memory**, as physical footprint from `proc_pid_rusage` (RSS overcounts shared pages):
  | State | Footprint | Processes |
  |---|---|---|
  | Idle stack: only the DB awake (owner + 1 launcher + postgres) | about 150-171 MiB | 10 |
  | App services awake: REST, Auth, Storage, Realtime, Functions | about 885 MiB | 33 |
  | Studio awake too, which wakes analytics/Logflare (BEAM about 492 MiB) and Next.js (about 232 MiB) | about 1.9 GiB | 52 |
  | Three idle stacks together | about 464 MiB | 30 |
  - The owner, a Bun process, accounts for about 67-88 MiB.
  - Each running service has its own Bun launcher of about 22 MiB.
  - Lazy services slept after about 60 s idle, bringing the stack back to about 171 MiB.
- **Wake latency:**
  - First hit after the first-ever start: REST 4.1 s, Auth 1.5 s, Storage 1.7 s, Realtime 2.9 s, Functions 22.2 s (a one-time edge-runtime bootstrap).
  - After an idle sleep: REST 0.36 s, Auth 0.75 s, Storage 1.1 s, Realtime 2.6 s, Functions 0.57 s, Studio 18 s.
  - Warm requests take 2-5 ms.
- **Disk:**
  - PGDATA is 52-79 MB per stack under `SUPABASE_HOME/stacks/<id>/data`.
  - The shared artifact cache is 1.7 GiB under `SUPABASE_HOME/cache/stack`.
  - Destroy leaves an empty `stacks/<id>/data` directory.
- **SysV shared memory:**
  - Each running postmaster holds one segment; the count dropped to zero when the stacks stopped.
  - This Mac has `kern.sysv.shmmni=32` and `shmseg=8`.
  - That makes a hard ceiling of about 32 concurrent Postgres servers on the machine, shadow databases included.
- **Secrets:**
  - Stack A was started with `SUPABASE_AUTH_JWT_SECRET=<random>`. That changed ANON_KEY and SERVICE_ROLE_KEY, but not PUBLISHABLE_KEY or SECRET_KEY, which were identical default constants on every stack.
  - A bare restart without that env, which is what an agent's own `supabase start` does, silently reverted A's ANON and SERVICE_ROLE keys to the defaults (equal to stack B's).
  - A restart without `--runtime` kept the saved native runtime.
- **Branch switch:**
  - After `git switch -c feature-b2` in worktree B, `supabase status --workdir B` failed with `ExperimentalStackStatusError` "No managed stack exists for the selected project.".
  - The agent's `supabase migration list --local` failed with `LocalDbRunningError` "The local stack is not running.".
  - The old stack's owner kept running.
  - Switching back restored access.
  - `supabase stack status --stack-id <id>` worked from any branch and reported `config_drift.status = unchanged`.
- **Orphans:**
  - Deleting a worktree (`git worktree remove --force`) while its stack runs leaves the owner running; it was still alive 35 s later.
  - `stack list` still reports that stack as `reachable`, with the now-missing `project_root`.
  - `supabase stack destroy --stack-id <id> --yes` succeeded afterwards: ports released, owner gone.
  - The destroy prompt says "Storage upload files will be preserved"; they live in `supabase/.temp/stack-uploads` in the worktree.
  - Destroying three stacks with one command (repeated `--stack-id`) worked.
- **Worktree writes:** `start` writes `supabase/snippets`, `supabase/functions` and `supabase/.temp` into the worktree. They are empty or gitignored, so `git status` stayed clean.
- **JSON shapes** (the stable fields observed):
  - `start`: `{id, runtime, endpoints{<service.endpoint>:{protocol,address,port,url}}, lazy_services[], env{...}, message}`. The `env` keys are API_URL, REST_URL, FUNCTIONS_URL, DB_URL, STUDIO_URL, MCP_URL, MAILPIT_URL, INBUCKET_URL, PUBLISHABLE_KEY, SECRET_KEY, ANON_KEY, SERVICE_ROLE_KEY, STORAGE_S3_URL, S3_PROTOCOL_ACCESS_KEY_ID, S3_PROTOCOL_ACCESS_KEY_SECRET and S3_PROTOCOL_REGION.
  - `status`: `{identity{id,name,project_root,branch_context}, runtime, owner, lifecycle, readiness, composition{members[{id,service,activation,state,lifecycle,health}]}, services[{id,service,state,lifecycle,health,endpoints}], endpoints{...}, config_drift{status,message}, env{...}, message}`.
  - `status --env`: a flat map with the same keys as `env`.
  - `stack list`: `{stacks[{id, project_root, name, branch_context, runtime, owner}], message}`. It has no ports; `owner` is for example `reachable`.
  - `stop`: `{stopped[ids], not_running[ids], message}`.
  - `destroy`: `{destroyed, id, message}`, or `{destroyed, stacks[{id}], message}` for several stacks.
  - Errors: `{"_tag":"Error","error":{code,message,suggestion?}}` with exit 1.
- **Quirks of this Mac and session:**
  - `/bin/ps` and `top` fail with EPERM; `pgrep`, `lsof` and libproc work.
  - Docker Desktop processes run, but `docker info` hangs because the daemon is unresponsive. That is another reason never to rely on `--runtime auto`.
  - `rm -rf` is denied by the permission layer.


## Spike 2 (2026-10-17): the CLI surfaces behind management controls

Setup:
- **Environment:** the same sandbox as spike 1. Supabase CLI 2.121.0, native runtime, an allowlisted env, a scratch `SUPABASE_HOME`, and telemetry off.
- **Calls:** every call passed `--output-format json` (or `stream-json`) plus `--workdir`/`--stack-id`.
- **Teardown:** all stacks were destroyed afterwards, leaving no owners, port reservations, SysV segments or listeners.
- **Loopback:** confirmed with lsof on every start, including after Studio came back on resume.

### Start and progress
- **Command:** `stack start --runtime native --exclude studio,analytics --workdir <root>` took 6.3 s on a destroyed-then-recreated identity (warm cache, fresh initdb, migrations, seed).
- **Composition:** database, rest, auth, realtime, storage, functions and mail. There is no studio, pgmeta, analytics or `/mcp`, `env` has no STUDIO_URL or MCP_URL, and the stack has 8 listeners, all on 127.0.0.1.
- **Deterministic identity:** re-creating a destroyed identity gave the same stack id. It also got the same API port (26211) this time, but the DB port changed, so ports must never be assumed stable.
- **Progress in stream-json:**
  - It emits only `{type:"log", level:"info"|"success", message, timestamp}` and a final `{type:"result", data:<start JSON>, timestamp}`.
  - Detailed steps arrive on stderr:
    - `[task] start: Starting local Supabase stack...`
    - `Seeding globals from roles.sql...`
    - `Applying migration <file>...`, one line per migration
    - `Seeding data from supabase/seed.sql...`
    - `[task] done: Stack is ready.` or `[task] failed: <message>`
  - A progress stepper can be built from redacted stderr lines, with N = the number of migration files counted statically.

### Status semantics (`stack status --stack-id <id> --output-format json`)

**Running stack:**
- `owner`=`reachable`, `lifecycle`=`running`.
- `readiness`=`sleeping` while any lazy member sleeps. It stayed `sleeping` even with rest, auth and storage awake, so stack-level readiness is coarse; the UI must derive per-service state from `services[]`.
- Members (`composition.members[]`) carry `activation` (`eager`|`lazy`), `state` (`running`|`sleeping`), `lifecycle` (`running`|`stopped`) and `health` (`healthy` or absent).
- Per-service rows: the database is `state=running lifecycle=running health=healthy`; a sleeping service is `state=sleeping lifecycle=stopped` with no health.

**Wake behaviour:**
- Waking auth also woke mail, a dependency wake.
- Wake latencies: REST 347 ms, Auth 793 ms, Storage 1.4 s.

**Stopped stack:**
- `owner`=`unavailable`, no `lifecycle`, `readiness`=`unavailable`.
- Every member and service has `state`=`unavailable` with no lifecycle or health.
- `endpoints` is `{}`, and `env` keeps only ANON_KEY, PUBLISHABLE_KEY, SECRET_KEY and SERVICE_ROLE_KEY.
- `config_drift.status` is still reported (`unchanged`).

**Listing** (`stack list`): a stopped stack shows `owner`=`unavailable`; a running one `reachable`.

**Unknown id:** exit 1, `{"_tag":"Error","error":{"code":"ExperimentalStackStatusError","message":"Stack <id> was not found","suggestion":"Run `supabase stack list` to see managed stacks and their IDs."}}`.

### Lifecycle verbs
| Verb | Command | Wall time | Notes |
|---|---|---|---|
| Restart | `stack restart --stack-id <id> --output-format json` | 0.8 s | Returns `{id, services:[{id, service, lifecycle, health, wake_enabled}], message}`. Exclusions persisted (still no studio or analytics). |
| Stop | `stack stop --stack-id <id>` | 0.3 s (mostly asleep) | Returns `{stopped:[ids], not_running:[ids], message}`. |
| Resume | `stack start --stack-id <id>` on a stopped stack | 1.6 s | **Exclusions did not persist.** Without `--exclude` the resumed composition put analytics, pgmeta and studio back (lazy) and `studio.http` reappeared. The desktop must pass `--exclude` on every resume, and an agent's bare resume re-enables Studio, which the UI must detect as composition drift. Returns the start JSON without `endpoint_changes` when ports did not move. |
| Failed first start | `start` that fails | | Still registers the stack (`stack list` shows it, owner unavailable). A pinned-port conflict left a registered stack that had to be destroyed. The UI needs a "failed to start" row with Destroy. |

### Logs (`stack logs --stack-id <id> [--service <kind>|gateway] [--tail N] [--since 10m|ISO|start] [--follow] --output-format json|stream-json`)
- **json:** an array of records:
  - `{type:"log-entry", timestamp, source:"history", service, instance_id, stream:"stdout"|"stderr", line}`
  - `{type:"log-marker", timestamp, source:"history", service, instance_id, kind:"launch"}`
- **stream-json:** the same records as NDJSON.
- **While stopped:** history is readable; `--follow` needs a running stack.
- **The `gateway` service** writes Apache-style access lines with full paths and query strings (e.g. `GET /rest/v1/notes?select=id&limit=1`).
- **Database logs** include SQL statement text (`LOG: statement: CREATE T...`).
- **Redaction:** no keys appeared in the sample, but query strings and SQL can carry PII or tokens. The viewer must redact (sb_secret_, JWTs, URL userinfo, token-like query params) and bound output.

### Migrations
- **Listing:** `migration list --local --workdir <root> --output-format json` returns `{migrations:[{local, remote, time}], message:"Migrations listed"}`.
  - A pending migration has `remote:""`; an applied one has `remote` equal to `local`.
- **Applying:** `migration up --local --workdir <root> --output-format json` returns `{applied:[<absolute file paths>], message:"Migrations applied"}` in 0.3 s. Stderr shows `Applying migration <file>...`.
- **`--db-url` targeting** (`migration list|up --db-url <DB_URL> --workdir <root>`):
  - It works **only** when DB_URL belongs to the stack of that workdir's current branch identity; the CLI then treats it as local.
  - From any other workdir the same loopback URL counts as a **remote** database: it prompts "reset the remote database?", which `--yes` auto-confirms, and it tries TLS (it failed with `DbConnectError` plus the suggestion `sslmode=disable`).
  - With `sslmode=disable` it would apply or reset the stack using the **other worktree's** migrations.
  - **Rule:** the desktop must run database-mutating commands (`migration up`, `db reset`) only with `--workdir` equal to the stack's own project root, and only while that worktree's HEAD matches the stack's `branch_context`. Never mutate across worktrees via `--db-url`.
  - Read-only inspection via `--db-url` is safe.

### Reset
- **Command:** `db reset --local --workdir <root> --output-format json` returns `{target:"local", version:"", message:"Reset local database."}` in about 4.3-4.9 s.
- **What happens:** it re-applies every migration and the seed (stderr shows each step).
- **What is kept:** the owner PID and the composition.
- **Flags:** `--no-seed`, `--version <v>`, `--last <n>`, `--sql-paths <p>`.
- **`--db-url`** with the matching stack's own URL from its own workdir behaves the same as `--local`. From another workdir it is the remote path described above, so **never use it**.

### Database inspection (read-only; `--local` or `--db-url`)
- **`inspect db db-stats`** (0.2 s) returns `{rows:[{database_size:"11 MB", total_index_size, total_table_size, total_toast_size, time_since_stats_reset, index_hit_rate, table_hit_rate, wal_size}], message}`.
- **`inspect db table-stats`** (0.2 s) returns `{rows:[{name:"public.notes", table_size, index_size, total_size, estimated_row_count, seq_scans}], message}`.
- **Other subcommands:** `locks`, `blocking`, `long-running-queries`, `outliers`, `calls`, `index-stats`, `role-stats`, `vacuum-stats`, `bloat`, `replication-slots`, `traffic-profile` (plus deprecated ones).

### Export
- **Command:** `db dump --local --data-only --workdir <root> -f <file>` worked natively in 1.4 s, producing a 63 KB file for 1000 rows.
- **Output:** stdout JSON is `null` when `-f` is used; stderr reads "Dumping data from local database... Dumped schema to <file>".
- **Restore:** there is no CLI restore. An "Export data" control is viable; "Import" or "Snapshot restore" is not, today.

### Errors observed
| Code | When |
|---|---|
| `ExperimentalStackStatusError` | "No managed stack exists for the selected project." (branch switched) or "Stack <id> was not found" |
| `ExperimentalStackStartError` | A pinned-port conflict, e.g. "rest <instance>: Public port 54321 for api is in use by the stack of project <path> (stack <id>); run `supabase stack stop` in that project, or configure a different port for api", with the suggestion "Set `api.port` in supabase/config.toml (or SUPABASE_API_PORT) to a free port." |
| `LocalDbRunningError` | "The local stack is not running." |
| `DbConnectError` | A TLS or connection failure, with an `sslmode` suggestion |

Codes are coarse; the message text names the specific cause, the conflicting project and the stack. The UI classifier needs message patterns, tested against recorded fixtures.

## Verification at v2.121.0 and in rndevtools

### identity-runtime-ports

- **confirmed**: Stack ID = sha256 over length-prefixed UTF-8 fields: realpath(projectRoot), the full HEAD ref (or detached / ordinary-workspace), and the stack name (default "default"); for a linked worktree the HEAD comes from the worktree gitdir; --workdir is used exactly; without it the CLI searches upward for supabase/config.toml with no stop at the worktree root.
- **partial**: --runtime auto probes Docker (about 10 s), then Podman, then native; the chosen runtime is saved and reused; an explicit conflicting --runtime on an existing stack errors; shadow/ephemeral databases (db diff etc.) also pick a runtime by auto selection, possibly Docker, even when the project stack is native.
  - These hold: the probe order, the 10 s bound per engine (up to about 20 s if Docker and Podman both hang), the saved and reused runtime, and the mismatch error. The shadow part is wrong as stated. When the project's default stack for the current workdir and branch exists, shadows (db diff, db pull, migration squash, declarative) inherit its saved runtime, so a native project stack gives native shadows. Auto selection, Docker first, happens only when no such stack is found: before the first start, after a branch switch, for --stack-named stacks, or when the state is unreadable. In that case this Mac's hung Docker daemon costs about 10 s per plan, and a healthy Docker would give a 0.0.0.0-bound shadow.
- **confirmed**: At v2.121.0 automatic public ports come from 20000-32767 and are reserved in <passwd home>/.supabase/ports.sqlite ignoring HOME and SUPABASE_HOME; fixed config or SUPABASE_*_PORT ports are exact; native backend ports 10000-19999 are NOT registry-claimed at v2.121.0 (develop only), so concurrent native starts can race: find exactly what happens on such a collision at the tag (retry? failure message?).
- **confirmed**: supabase stack list reads only <SUPABASE_HOME>/stacks, probes live owners (lease + GET /identity, 2 s), skips undecodable entries with a stderr warning, and creates the registry directory if missing.
- **confirmed**: Every "--local" database command family (db reset, db diff, migration up/list, gen types, test db, inspect, pull, storage, functions serve) targets only the default-named stack of the current (projectRoot, branch) and talks to it through owner RPC tied to the owner release.
- **confirmed**: SUPABASE_EXPERIMENTAL_STACK must be exactly 0 or 1 and overrides [experimental] stack; with neither, start/status/stop and the --local commands use the legacy Docker backend.
- **confirmed**: For SUPABASE_* overrides, process env beats supabase/.env.local which beats supabase/.env, but only inside the process that carries the env.

New findings:

- `supabase db start`, and `db schema declarative` through ensureLocalDatabaseStarted, create a postgres-only PROJECT stack with auto runtime when the worktree has no default stack. `db start` has no --runtime flag (tag apps/cli/src/command-internal/stack-local-database.ts:220-256; commands/db/start/start.command.ts:10-15; commands/db/start/start.handler.ts:32-40; commands/db/shared/pgdelta.seam.layer.ts:86-105). This is a second agent-side creation path that picks Docker (0.0.0.0) whenever Docker answers, so steering and the 'desktop pre-creates native' rule must cover it.
- Native backend ports (10000-19999) are reserved again on every native launch, and the placeholder is closed before the spawn (tag Service.ts:298-302 -> services/ProcessRecipe.ts:461-520, 597; Ports.ts:198 'not stable across restarts'). At v2.121.0 the cross-stack race can therefore recur at every lazy wake (about every 60 s idle cycle), not only at start. Only the Pooler confirms its own bind (services/Pooler.ts:84); the others trust HTTP readiness racing the exit (ProcessRecipe.ts:675-706). The race on wake is inferred, not tested.
- The owner 'release' is '0.1.0+<16-hex digest>' of the packages/stack sources plus the Effect version, embedded at build time (tag packages/stack/src/HostProcess.ts:29, 43-66; internal/release.ts:9-50; apps/cli/scripts/compile-options.ts:19-27). It is not the CLI semver, so CLI versions with identical stack sources interoperate. owner.json stores `release` next to the bearer secret (namespace/Lease.ts:11-20), and `stack list`'s 'reachable' never checks it (HostProcess.ts:254-265 vs 323-329).
- When the stack backend is routed, `supabase stop --all` stops every readable stack in the state root (tag commands/experimental/stack/stop/stop.command.ts:7-11; stop.handler.ts:61-96). Any agent can stop every lane's stack, so the steering hook must catch it along with `stack destroy`.
- Fixed public ports from config or env are registry-reserved only while their listener is open, so a stopped stack does not hold them. A fixed port inside 10000-19999 is rejected outright (tag packages/stack/src/Ports.ts:261-268, 276-280, 438-445).
- The port registry has two preconditions. <passwd home>/.supabase must be a real directory owned by the uid, so a symlinked ~/.supabase is refused (tag namespace/PortReservations.ts:106-127). The home is resolved by spawning `dscacheutil` with a 5 s timeout (PortReservations.ts:161-186), so a sandbox that blocks it would break every stack start (untested). The state root, by contrast, follows $HOME/SUPABASE_HOME (shared/config/supabase-home.ts:11-20): a sandbox with another HOME sees a different `stack list` but shares the port registry.
- Config-file mismatch: routing prefers supabase/config.json for the `[experimental] stack` read (tag packages/config/src/paths.ts:27-37). Stack start loads only config.toml (command-internal/local-project-context.ts:81-91), and the CLI's workdir search looks only for config.toml (config/command-settings.layer.ts:89). A config.json-only project is effectively unsupported on the stack path.
- SUPABASE_WORKDIR is honoured verbatim like --workdir by both config loading and routing (tag config/command-settings.layer.ts:84-86; command-internal/experimental-feature.ts:49-56). Without it, and with no supabase/config.toml up the tree, the CLI uses cwd, and `start` creates a default-settings stack keyed to that directory (commands/experimental/stack/start/start.command.ts:47-48). A per-session SUPABASE_WORKDIR is therefore a supported way to pin agents to the lane root; the mechanism for injecting it is unverified.
- Identity edge cases (tag packages/stack/src/identity/GitBranchContext.ts:30-44, 61-86): a dangling worktree gitdir file, after the main repo moves or its admin dir is pruned, makes identity resolution fail outright. A project root outside its own repo inherits the nearest ancestor repo's HEAD. A detached HEAD maps all commits to one 'detached' identity. rndevtools stores branches without refs/heads/ (apps/desktop/src/main/lane-worktree.ts:58-62), so correlating with branch_context must add the prefix back.
- With this Mac's unresponsive Docker, auto selection waits the full 10 s Docker probe before trying Podman and then native (tag command-internal/stack-runtime.ts:35, 89-94). That wait applies to every new stack an agent creates without --runtime, and to every shadow plan when no project stack exists for the current branch (commands/db/shared/pgdelta-next-shadow.layer.ts:301-302). It shows up as a slow command, not an error.
- `stack list` probing briefly takes each idle stack's owner.lock with BEGIN IMMEDIATE (tag namespace/Lease.ts:241-255; namespace/drivers/Sqlite.ts:89-96). It probes 8 stacks at a time with a 2 s identity timeout (packages/stack/src/effect.ts:986-991; HostProcess.ts:214-224) and chmods the state root to 0700 (StackNamespace.ts:41-46). Polling it frequently can interfere with owner startup and is slow when owners hang.

### lifecycle-release

- **confirmed**: Detached owners outlive the CLI, the agent session and the desktop and never exit on their own; native workloads die with their owner (pipe watch); after a reboot nothing restarts but registrations and automatic port reservations remain; an owner exits within about 30 s if its state.json disappears.
- **confirmed**: An owner serves only clients of the same stack release (package version plus SUPABASE_STACK_BUILD_ID digest); stop and destroy work across releases. Determine whether the Homebrew formula build and the npm @supabase/cli-darwin-arm64 build of the same version produce the same release id.
- **confirmed**: Destroying an OFFLINE stack (no owner running) spawns an owner of the caller release; determine whether anything on that path needs the project root to still exist.
- **confirmed**: stack prepare launches an owner that stays running; it defaults to runtime auto.
- **confirmed**: Only the database is eager; every other service with an endpoint, Functions included, is lazy with a 60 s idle timeout (Studio 300 s); --eager disables idling; --exclude accepts rest, auth, realtime, storage, functions, studio, mail, analytics, pooler; excluding studio also removes the /mcp endpoint?
- **partial**: Native startup budget: ProcessRecipe startupTimeoutSeconds 60 with 3 native launch attempts; stop waits up to about 15 s for Postgres SIGINT plus a 5 s owner-exit poll.
  - The constants are right but the claim's framing is too narrow. Startup is 60 s per startup command plus 60 s for readiness, so one launch or wake can exceed 60 s. The 3 attempts are port-collision retries inside a single 60 s window. Postgres uses db.health_timeout, 2 min by default. Stop: the 15 s SIGINT and the 5 s exit poll are correct. But every running service is stopped one at a time first, each with up to 5 s of SIGTERM plus forced-kill guards, and the client puts no timeout on /shutdown. An idle stack stops in about 3 s (spike). A fully awake stack can take well over 20 s. The 5 s poll is usually not additive, because the owner exits as soon as it has delivered the response.
- **confirmed**: What exactly the CLI writes into the worktree on start (supabase/snippets, supabase/functions, supabase/.temp/*, cli-latest) and whether any of it would block "git worktree remove" without --force.

New findings:

- Release ID = '@supabase/stack' package version (a constant 0.1.0) + 16 hex of SHA-256 over packages/stack/src non-test .ts files and the effect version. The CLI version is not part of it (HostProcess.ts:29,43-66; internal/release.ts:9-50). 2.121.0 is 0.1.0+a559977f2134f3a5 in the npm binary, the homebrew-core bottle and the tap tarball. The tag commit is also v2.121.0-beta.27, so that beta shares the release. Develop computes 8b6cc1ef8a8469e7, so expect the next CLI release to break status and --local db commands against running stacks.
- `stack list` shows owner 'reachable' without comparing releases (HostProcess.ts:254-265; list.handler.ts:53). A mismatch only appears when status or owner-RPC commands fail with 'Stack <id> is served by release X, but this client is release Y' (HostProcess.ts:323-329). owner.json publishes `release` next to the bearer secret (StackHost.ts:591-599).
- Sticky automatic ports are not guaranteed. A pinned port request (config.toml or SUPABASE_*_PORT) reclaims the automatic reservation of any stack with no live owner, for example after a stop, crash or reboot. That stack then gets a new port on its next start (Ports.ts:330-352; start/SIDE_EFFECTS.md:68-70). Read ports from every start's JSON, use endpoint_changes, and restart Metro on change.
- Stops are sequential: per service within a stack (Orchestrator.ts:980-994,1069-1086) and per stack for `stop --all` (stop.handler.ts:115-130). POST /shutdown has no client-side timeout (HostProcess.ts:333-353).
- Timing budgets from source: owner readiness 30 s (HostProcess.ts:541-545). Connect waits up to 30 s for a starting owner (HostProcess.ts:301-310). Launch waits up to 70 s while a sweeper holds the lease (HostProcess.ts:684-697; sweepTimeout 1 min at HostProcess.ts:85). DB readiness is db.health_timeout, default 2m (packages/config/src/db.ts:20; stack-config.ts:1133-1136,1229). A wake waiter gets 120 s (Orchestrator.ts:138). The breaker opens for 30 s after 3 failures within 300 s (Lifecycle.ts:4-7). Each startup command gets 60 s, then readiness gets 60 s (ProcessRecipe.ts:217-218,244-275,584).
- Every owner start sweeps all other free-lease stacks in its state root, holding each one's lease as 'sweeper' for up to 1 min (StackHost.ts:606-614; Sweep.ts:55-86,128-166). Concurrent lane starts can briefly hit 'sweeping' and wait. Docker/Podman stacks in the same state root make native owners probe those engines during the sweep.
- A lost registration leaks data. Deleting state.json or owner.lock makes the owner stop its workloads and exit, but PGDATA, logs and port rows stay (the rows are only reclaimed lazily), and the stack vanishes from `stack list` (StackHost.ts:398-415,645-648; Owner.ts:929-932; Ports.ts:286-305). Never GC by deleting files; always destroy.
- Command-line --exclude/--eager persist only for `stack restart`. A normal `start` after a stop reloads config.toml and the current flags. A `start` against a running stack doesn't read config at all (apps/cli/docs/stack-commands.md:307-315; start/SIDE_EFFECTS.md:11-15; restart/SIDE_EFFECTS.md:15-16). Stack mode honours config.toml `enabled` flags (stack-config.ts:1234-1388), so desktop exclusions survive an agent's stop+start only if they are in config.toml.
- Open WebSocket or TCP connections keep a lazy service awake indefinitely; idle HTTP keep-alive does not (stack-commands.md:298-300; Lifecycle.ts:347-360). A lane app holding a Realtime subscription keeps Realtime resident.
- A first `supabase start` killed with SIGKILL, bypassing finalizers, can leave an incomplete bootstrap that needs a destroy; there is no recovery journal (start/SIDE_EFFECTS.md:213-225). On a graceful failure or interrupt, the CLI stops the owner it launched (start.handler.ts:636-649). So the desktop must not hard-kill start after 60 s; interrupt it with SIGINT and wait.
- The owner inherits the full env and the cwd of whatever process ran start: HostProcess.ts:495-516 passes no env option and uses cwd: process.cwd(). By macOS behaviour (inferred, not tested) it also inherits that process's sandbox for its whole life. Desktop-started owners therefore run outside agent sandboxes, and agent-started ones stay confined.
- Offline destroy prerequisites: SUPABASE_EXPERIMENTAL_STACK=1 in the env, because the deleted worktree's config.toml can no longer enable the command group (experimental-feature.ts:89-108), and an existing cwd. A full id that is not registered makes destroy probe both Docker and Podman before confirming (effect.ts:1039-1061; destroy.handler.ts:58-63). Docker's daemon hangs on this Mac, so expect slow failures for stale or unregistered ids; the probe bound was not verified.
- After an owner crash, its Postgres can keep running for up to about 15 s, holding its SysV segment and PGDATA, because the launcher sends SIGINT first and waits the 15 s budget before SIGKILL (native-launcher.ts:182-211; Database.ts:518-519). Native socket directories live at /tmp/supabase-<uid>/pg-<digest> (runtime/postgres-user.ts:15-22,240-249).

### credentials-security

- **confirmed**: Default credentials are shared public constants. Per-stack overrides exist for the JWT secret, the publishable key, the secret key and the signing keys, and the database password cannot be configured. The spike showed SUPABASE_AUTH_JWT_SECRET changes ANON/SERVICE_ROLE but not PUBLISHABLE/SECRET.
- **confirmed**: A start without the overrides re-keys a stopped stack back to the defaults: Credentials.ts falls back to DEFAULT whenever keys are supplied, and the CLI always supplies keys. Does the same hold for publishable/secret keys and signing keys, and can keys be persisted in config.toml or supabase/.env.local instead of env?
- **confirmed**: Native Postgres HBA trusts supabase_admin for local connections, including through the owner's loopback TCP proxy, so any local process can become superuser without a password; other roles need scram.
- **partial**: The gateway sends access-control-allow-origin * on every route including /mcp, and /mcp has no authentication.
  - **Confirmed:** everything the gateway controls. ACAO * goes on every response it originates, including all preflights and 404s, so cross-origin preflights to /mcp always succeed. The gateway adds no auth to /mcp. The CORS behaviour is also broader than claimed: Studio, pg-meta, Mailpit and analytics ports are served by the same proxy.

**Not verifiable from source:** whether Studio's prebuilt /api/mcp handler checks anything itself. It is given no MCP token, and upstream docs say CLI-local MCP has no OAuth.

The ACAO on proxied responses can be replaced by an upstream's own header.
- **confirmed**: state.json holds the full credential record in plaintext (mode 0600) and owner.json holds a bearer secret (0600); the start/status JSON env map contains SECRET_KEY, SERVICE_ROLE_KEY, DB_URL with password, and S3 secrets.
- **confirmed**: Native workloads receive only an env allowlist (PATH, HOME, TMPDIR/TMP/TEMP, LANG, LC_*; plus SSL_CERT_FILE/DIR for Postgres) while the owner keeps the full env of the client that started it.
- **confirmed**: Docker/Podman public proxies bind 0.0.0.0 at v2.121.0 (packages/stack/src/Network.ts).
- **confirmed**: The supabase-js default auth storage key is sb-<first hostname label>-auth-token, i.e. sb-127-auth-token for every local stack, so a Simulator reused across lanes keeps the previous lane's session.

New findings:

- **Setting only the JWT secret does not stop forged tokens.**
- REST's PGRST_JWT_SECRET is the JWKS document (Rest.ts:34,48).
- That document keeps the default ES256 public key unless SUPABASE_AUTH_SIGNING_KEYS_PATH is set (ServiceConfig.ts:29-39,54-55,77-78,100-106).
- The matching private key 'd' is a public constant (Defaults.ts:5-16).
- GoTrue signs with that key and accepts HS256/RS256/ES256 (Auth.ts:97-100).

So anyone can mint a service_role JWT accepted by any stack without a per-stack signing key. All paths are under supabase/cli@v2.121.0/packages/stack/src.
- **The public sb_secret_ constant still grants service_role.** The gateway rewrites it to the stack's service_role JWT unless SUPABASE_AUTH_SECRET_KEY is overridden (HttpProxy.ts:122-130,206-211; Owner.ts:292-297,433).
- **S3 and analytics run on fixed public credentials.**
- Storage S3 protocol keys are hard-coded in stack mode (apps/cli/src/command-internal/stack-config.ts:1319-1321 -> Storage.ts:89-91).
- The protocol is on by default (packages/config/src/storage.ts:19).
- /storage/v1/s3 is routed without key rewriting (Endpoints.ts:86).
- The only mitigation is SUPABASE_STORAGE_S3_PROTOCOL_ENABLED=false (stack-config.ts:519-527).
- The analytics private access token is the literal 'api-key' (stack-config.ts:1240; Analytics.ts:89-91).
- **Every dedicated public HTTP port uses the same proxy, so CORS * and no Host-header check apply there too.** This covers Studio, pg-meta, Mailpit and analytics (Network.ts:200-206; HttpProxy.ts:251-266,616-641).
- pg-meta connects as supabase_admin (composition/Supabase.ts:59-65; Endpoints.ts:164-170; Pgmeta.ts:29-40).
- Studio holds the secret key, service key and DB password (Studio.ts:57-83).
- So a browser page or local process that finds these ports can run SQL as superuser or read captured auth mail.
- `--exclude studio` also drops pg-meta (apps/cli/src/commands/experimental/stack/stack.shared.ts:228-237).
- WebSocket upgrades have no Origin check (HttpProxy.ts:682-729).
- **Desktop-only --exclude flags do not persist.** A bare agent `supabase start` from stopped re-requests every service enabled in config (start.handler.ts:79-101,527,807). Persistent toggles exist as SUPABASE_* overrides that every CLI call reads, for example from supabase/.env.local:
- SUPABASE_STUDIO_ENABLED (stack-config.ts:770)
- SUPABASE_ANALYTICS_ENABLED (:597)
- SUPABASE_STORAGE_S3_PROTOCOL_ENABLED (:522)
- SUPABASE_LOCAL_SMTP_ENABLED (:781)
- SUPABASE_REALTIME_ENABLED (:758)
- SUPABASE_EDGE_RUNTIME_ENABLED (:580)
- **Exactly when credentials change:**
- Only a start from a fully stopped stack re-keys; the running and resume paths keep credentials (start.handler.ts:718-789).
- `stack restart` passes no keys (restart.handler.ts:76-84).
- Credentials cannot change while services run (Owner.ts:400-409).
- `db start` never re-keys but fails on a differing configured JWT secret or root key (stack-local-database.ts:290-300).
- The root key and DB password stick after creation (Credentials.ts:120-134).
- **Process env beats the worktree files.**
- Ambient env overrides dotenv files for SUPABASE_* (project-environment.ts:116-131; local-config-values.ts:229).
- SUPABASE_ENV=test skips .env.local (project-environment.ts:21-23).
- Publishable/secret env overrides apply only while auth is enabled (stack-config.ts:710-711,420-421).
- The JWT secret must be at least 16 characters (local-config-values.ts:165,608-614).
- The stack registry is SUPABASE_HOME/stacks (stack-local-database.ts:34-37), so the desktop and agents must share HOME and SUPABASE_HOME.
- **A signing-key file fails closed, unlike an env var.**
- SUPABASE_AUTH_SIGNING_KEYS_PATH is read when config loads, relative to <workdir>/supabase or absolute (config-validate.ts:584-586; local-config-values.ts:659-686). A missing file aborts start instead of silently reverting.
- `supabase gen signing-key --algorithm ES256|RS256` generates a key (commands/gen/signing-key/signing-key.command.ts:13-24,40-62).
- With a configured key the HS256 entry is dropped from the JWKS (ServiceConfig.ts:84,104).
- anon/service_role become ES256 JWTs with exp=now+10y (go-jwt.ts:253-256) that stay stable across restarts (ServiceConfig.ts:93-123).
- **Any agent can read every stack's secrets and stop or destroy any stack.**
- state.json also stores every saved creation, including Functions/edge_runtime env secrets and auth provider, SMTP and hook secrets as plain strings (Registry.ts:16-19,56-74; Functions.ts:29,38; AuthSettings.ts:6,17,47,112).
- The owner.json bearer unlocks /rpc, including runCommand, and /shutdown with destroy (StackHost.ts:334-381).
- Any same-uid process can therefore stop or destroy any stack; ownership can only be steered, not enforced.
- **Upstream already has a redaction pattern list rndevtools can reuse.** The gateway redactor (internal/redact-credentials.ts:32-60) covers apikey/jwt/access_token/token/token_hash/code/refresh_token/id_token parameters, sb_secret_ values, eyJ… JWTs and URL userinfo. That fits the fix needed for rndevtools' shared redactor.
- **Reported addresses cannot reveal LAN exposure.** Endpoint addresses in JSON are always 127.0.0.1 (Owner.ts:736-739 -> Network.ts:253-260), even when the docker/podman runtime binds 0.0.0.0. Nothing in config or env forces the native runtime for stacks an agent creates (apps/cli/src/command-internal/stack-runtime.ts:72-91).
- **Sessions survive lane changes.** Lanes never reset app data (rndevtools lane-service.ts:1026-1055; uninstall exists only as the explicit simulator-service.ts:1422-1424 action), so persisted supabase-js sessions carry over. auth-js also keys its JWKS cache by storageKey (GoTrueClient.ts:236-291).
- **Unverified:** Realtime exposes a public loopback `rpc` (gen_rpc) TCP endpoint per stack (stack-config.ts:1303-1306; Realtime.ts:78-84). Its authentication was not inspectable because it is a prebuilt artifact. Treat it as an unreviewed local surface and exclude realtime when unused.

### rndevtools-defects-metro

- **confirmed**: Lane-only holds never auto-release: AgentService records missingSince only for claim holders and resolveDeviceHolds falls back to now, so releaseAt stays now + 10 min for lane-only holders and the lane-service reconcile check never fires.
- **confirmed**: Codex-over-MCP calls carry no CODEX_THREAD_ID and fall back to an mcp-<client> identity; command.agent is set only from env; the router records lane.agent only from command.agent, so such lanes are stored without an agent: operator-owned, never abandoned, never matched by release --all. Also: can Codex MCP config pass env, and what does setup write.
- **confirmed**: The desktop aborts every CLI handler after 60 s except wait and recipe run, while the Go CLI waits 240 s for lane/native; the SessionEnd hook client allows 2 s inside a 3 s hook cap.
- **confirmed**: lane.log returns the raw Metro tail unredacted, and packages/core/src/core/redact.ts misses SECRET_KEY=sb_secret_..., JSON "SECRET_KEY":"sb_secret_..." and URL userinfo passwords.
- **confirmed**: startLane has no reservation between device/port selection and store.upsert, so two concurrent lane up calls can pick the same Simulator and port; release --all counts failed lane stops as stopped.
- **partial**: lane-metro.ts spawns Metro with {...process.env, ...environment.metroEnv, NODE_ENV: development, EXPO_NO_DOTENV: 1, ...}; nothing configures metroEnv; LaneState echoes metroEnv to the renderer and CLI; in development EXPO_PUBLIC_* values are read from Metro's process env when the bundle is served, so a Metro restart picks up new values without --clear.
  - Every literal sub-claim holds. Values from the Metro process env are re-read at serve time, and dev transform output holds references, not values, so a restart picks up new process-env values without --clear. But that is not the effective value the app sees. In Expo 57 dev bundles, EXPO_PUBLIC_* keys defined in the app root's .env.local, .env.development or .env.development.local override the Metro env, and EXPO_NO_DOTENV=1 does not prevent it. So 'EXPO_NO_DOTENV means the app's .env Supabase URL is ignored' is false for those three files (a bare .env is skipped only because of the node crawler's extname handling). Fresh `git worktree add` checkouts usually lack the gitignored .env.local, but a committed .env.development, or tooling that copies .env files into worktrees, will silently win over injection. Separately, CI=1 means code and .env edits after start are never seen until Metro restarts. The desktop's inherited EXPO_PUBLIC_* also reach every lane through ...process.env (spread at lane-metro.ts:112); how much depends on how the desktop was launched.
- **confirmed**: packages/react-native/src/diagnostics/image-overlay.ts hard-codes EXPO_PUBLIC_SUPABASE_URL (a product-specific name in source); lane-ipc.ts passes a renderer-supplied worktreePath to lane.start.

New findings:

- Codex over MCP is refused on its own lane. Its lane is stored without an agent and so is held by the operator (device-hold.ts:113-117), yet its envelope still carries codex:mcp-codex-mcp-client (server.go:344-354). decideDeviceAccess (device-hold.ts:146-178) therefore refuses that same session with device_held 'held by the operator' on input (agent-command-router.ts:813), lane down (1435), slimming mutations (1304) and lane up naming that udid (1385). Traced from code, not run.
- All Codex MCP sessions share one identity, codex:mcp-codex-mcp-client. Codex discovery keys sessions by thread row.id (agent-sessions.ts:179-196), so that key is never live. As a result, Codex MCP claims start their abandonment clock on the first refresh and are dropped after 10 min even while the session is working (agent-service.ts:329-352, consistent with the codex-9 case in agent-service.test.ts:318-324). Also, one Codex session's release --all drops every Codex MCP session's claims (agent-command-router.ts:460-473).
- Claude Code does pass CLAUDE_CODE_SESSION_ID to the stdio MCP servers it spawns. Checked live with the read-only rndevtools `agents` tool: `you` came back as this session's own UUID, matching a discovered live Claude session, not an mcp-* fallback. The open question in the research notes is answered for Claude; subagent calls are attributed to the parent session.
- Codex liveness is a heuristic: a thread counts as live only if updated within 30 min (agent-sessions.ts:18-22 and 179; CODEX_ACTIVE_WINDOW_MS at agent-protocol.ts:26). A discovery failure returns an empty session list (agent-sessions.ts:169-177, 199-200; agent-service.ts:307-317), which starts the abandonment clock for every claim of that agent kind. A stack GC built on these holds must treat 'unavailable' as unknown, not dead, and should not stop an idle Codex user's stack 40 min after their last turn.
- Expo 57 dev bundles let app-root .env.local, .env.development and .env.development.local override Metro's process env for EXPO_PUBLIC_* even with EXPO_NO_DOTENV=1 (transform-worker.js:133-165; only @expo/env checks EXPO_NO_DOTENV). A bare .env is skipped only because the node crawler uses path.extname (crawlers/node/index.js:99-101; useWatchman forced null at ExpoMetroConfig.js:358-362). Injecting the stack URL through Metro env can therefore be silently overridden by a hosted Supabase URL in those files, so the desktop should detect them.
- Lanes run Metro with file watching off. lane-metro.ts:122 sets CI=1, and Expo CLI 57 then sets watch=false (instantiateMetro.js:400 and 570-575). Both lane logs on this Mac show 'Metro is running in CI mode, reloads are disabled.' Code edits, .env edits and env changes reach a lane only after a Metro restart. CI=1 dates to the first lanes commit fded199 and is not documented as a trade-off.
- Metro health is checked by port only: #waitForMetro returns ready if any packager answers on the lane's port (lane-service.ts:965; lane-metro.ts:148-165), and resume does the same (782-786). After a port race, a lane can be wired to another worktree's Metro. Stack health checks must verify the stack id, not just a port answering.
- The session-end hook can send a key that matches nothing. It derives kind from env: if CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID, RNDEVTOOLS_AGENT_SESSION_ID, CLAUDE_CODE_ENTRYPOINT, CLAUDE_PROJECT_DIR, CODEX_HOME and CODEX_SANDBOX are all unset in the hook's env, kind becomes 'other' and the key other:<session_id> matches no lanes or claims (internal/app/setup.go:210-221). Whether Codex's hook env sets any of these is unverified; it is worth a test before relying on the hook to release stacks.
- Codex 0.162.1 has a lead and a dead end for MCP identity. Its strings contain an x-codex-turn-metadata structure with threadId, turnId and callId, but whether it reaches third-party stdio tools/call _meta is unverified, and rndevtools' server.go:291-294 ignores _meta anyway. Its MCP config supports env and env_vars (source local or remote), but there is no evidence a per-thread id is available to forward.
- Lane logs are never deleted. stopLane removes the lease but not logs/<laneId>.log (lane-service.ts:861-868; lane-store.ts:36-38), so unredacted Metro output, including app console logs, piles up under userData/lanes/logs.
- #missingSince is in memory only (agent-service.ts:111), so every desktop restart resets the abandonment clock for all holds. Stack GC needs its own persisted or reconstructed abandoned-since timestamps.

## Research summaries

### stack-core

I checked the code at the research notes @ 8c91ac5 (2026-10-16), plus the CLI under apps/cli and npm. Evidence paths below are relative to that clone unless prefixed with rndevtools:.

How a stack runs: each stack has one detached owner process (StackHost). The client starts it by re-running its own executable (process.execPath). In the shipped CLI that is the Bun-compiled `supabase` binary, launched as `supabase __supabase_stack_host__ <stateRoot> <cacheRoot> <stackId>` in its own session. The owner holds a SQLite write lock on <stateRoot>/<id>/owner.lock for its whole life. It serves Effect RPC (NDJSON over HTTP) on an OS-assigned 127.0.0.1 port. The port and a random bearer secret are published in a 0600 owner.json. There is no Unix socket.

Lifetimes: the CLI's `stack start` (and `supabase start` when the experimental flag is on) creates detached stacks with startOwner:true. Those owners outlive the agent's CLI, the agent session and any rndevtools restart, and they never exit on their own. Only the CLI's throwaway shadow databases use the 'session' lifetime.

Owner death and reboot: if the owner dies, its native services die with it, because each service's launcher watches a pipe from the owner. Containers stay until some owner starts again in the same state root. After a reboot nothing restarts. Detached stacks stay registered with their data and their sticky automatic ports.

Identity: the stack ID is the SHA-256 of three fields: the canonical project root, the full git ref (or 'detached' / 'ordinary-workspace'), and the stack name. So sibling worktrees always get different stacks, even on the same branch. But switching or renaming a branch, or moving the directory, quietly creates a new stack while the old owner keeps running. Deleting a worktree neither stops nor destroys its stack.

Embedding @supabase/stack in Electron is not viable:
- The package is private and not published (npm 404).
- It ships raw TypeScript.
- It only drives owners of its own release, and the release string is a digest of its own source files.
- Anything it spawned would run Electron's own binary with a .ts entrypoint, and would then fight the agent's CLI with release-mismatch errors.

What does work across releases: the lease, the owner.json record, GET /identity, POST /shutdown {destroy}, and SIGTERM to the owner. Also readable are state.json (no version field, contains plaintext secrets), the log segment files, and the per-user ~/.supabase/ports.sqlite (a simple 4-column reservation table).

Recommended model for rndevtools:
- Observe read-only from disk, `ps` and ports.sqlite.
- Stop or destroy live stacks through /shutdown, and only for released or abandoned lanes.
- Hand offline destroys and rich status to the `supabase` CLI. Ideally use the owner's own executable path, so the release matches.
- Keep its own lane-to-stack-ID mapping.
- Never spawn owners.

Have agents use `--runtime native`. Auto-selection prefers Docker or Podman, whose proxies bind 0.0.0.0 with well-known credentials. Also keep ports out of config.toml, because fixed ports collide across worktrees.

### stack-services

Native mode fits per-agent Supabase on Apple Silicon. The storage, port and resource mechanics are designed for many parallel stacks. The blocker is the integration surface: the clone-a-seeded-database feature exists but the CLI doesn't expose it for project stacks. (Paths below are relative to the research notes at 8c91ac5.)

Coverage and pins: every one of the 12 stack service kinds has a pinned darwin-arm64 artifact. The kinds are database, rest, auth, realtime, storage, imgproxy, functions, studio, pgmeta, mail, analytics and pooler. Vector is pinned but only the legacy `supabase start` runs it. There is no Kong: each stack's detached owner process is the gateway. Intel Macs have no native artifacts, and postgres, postgrest and edge-runtime need macOS 14 or later.

Integration surface: the feature is gated behind SUPABASE_EXPERIMENTAL_STACK=1 and its CLI interface is excluded from the compatibility promise. `@supabase/stack` is private and not on npm, so rndevtools can only drive `supabase stack ... --output-format json`. Pass `--runtime native` explicitly: `auto` picks a reachable Docker or Podman first, and the choice sticks to the stack.

Downloads: the first native start fetches pinned .tar.zst archives into ~/.supabase/cache/stack, from GitHub Releases with a public S3 fallback, verified against SHA-256 pins compiled into the CLI. For the 10 services the CLI enables by default that is 363 MiB to download and 1.73 GiB extracted. The cache is shared by every stack, works offline after the first fetch, and only retires a version once it is unused and untouched for 30 days.

Networking: each stack has one shared API port (/rest/v1, /auth/v1, /storage/v1, /functions/v1, /realtime/v1, plus /mcp for Studio), and that is SUPABASE_URL. The DB, Studio, mail, analytics, pg-meta and realtime-rpc get their own ports. All ports are assigned automatically from 20000-32767 through a per-user registry at ~/.supabase/ports.sqlite; process-internal ports use 10000-19999. None of this overlaps rndevtools' 8100-8399 Metro ranges. Native listeners bind 127.0.0.1 only, so the iOS Simulator can reach them; Docker and Podman bind every interface.

Memory: the pinned artifact manifests carry publisher-measured idle memory per service, for example Postgres 96 MiB, Realtime 213, Storage 266, Studio 324 and analytics 508. That is 1.73 GiB if all 10 default services are awake, or 0.74 GiB for just the services an app calls. Only the database stays up; everything else sleeps after 60 s (Studio after 5 min) and wakes on the next request within a 120 s budget. A stopped stack costs zero processes.

My estimate (not measured anywhere, since the per-stack owner and per-service launcher overhead are unmeasured): about 0.2-0.3 GiB per idle stack, 1.0-1.35 GiB per stack the app is actively using, and 2.0-2.5 GiB with Studio or its MCP awake. A likely hard ceiling is macOS's limit of 32 System V shared-memory segments; Postgres probably needs one per server (inferred), and the slim profile itself targets 25 parallel stacks.

Snapshots: these are physical copies of the database directory using `cp -cRp`, which is an APFS copy-on-write clone because data and cache share the ~/.supabase volume. So "migrate and seed once, clone per agent" would be cheap. But the shared snapshot cache keeps only 3 entries, a CLI upgrade that changes the Postgres version makes old entries miss, and the CLI only uses snapshots internally for its throwaway shadow databases.

Credentials and security: by default every stack shares the same public dev secrets (JWT secret, anon and service_role tokens, sb_publishable_/sb_secret_ keys, signing key, root key, password `postgres`). Per-stack secrets are supported through SUPABASE_AUTH_* environment variables, and upstream's own e2e test uses them. Native Postgres listens only on a 0700 socket directory, but the owner's loopback TCP proxy feeds into it and the access rules trust supabase_admin on local connections. Any local process that finds the port gets superuser without a password, and the gateway sends CORS `*`. Agents are isolated by port, not by authentication.

Worktrees: a stack's identity is a hash of the worktree's real path, its git branch and the stack name. Each worktree gets its own stack automatically, but switching branches inside a worktree creates a new stack and leaves the old one running.

### cli-surface

Today's Supabase CLI can drive per-directory local stacks through the experimental `supabase stack` backend. The current stable is npm `latest` 2.121.0 (2026-10-14): a Bun-compiled TypeScript binary that ships with a small Go sidecar, and the stack commands never call the sidecar. You turn the backend on with `SUPABASE_EXPERIMENTAL_STACK=1` (it must be literally 0 or 1) or with `[experimental] stack = true` in `supabase/config.toml`. Once it is on, `supabase start|status|stop` become the same handlers as `supabase stack start|status|stop`, and `stack list|destroy|logs|prepare|restart` appear. Native mode ("no Docker") means passing `--runtime native`. The `auto` default prefers Docker, then Podman, then native on Apple-silicon macOS or Linux. The runtime is saved per stack, native listeners bind 127.0.0.1 only, and a detached owner process keeps running after the CLI exits. The stack ID is SHA-256 of (the realpath of the project root, the worktree's own Git ref, and the name "default"). So each git worktree gets its own stack with no flags. Two catches: a branch switch or directory move silently creates a new stack, and the `db`, `migration`, `gen types`, `storage` and `functions serve` commands with `--local` only find the default-named stack. So rndevtools should never use `--stack` names and should key each lane on the 64-hex `id` that `start` returns. State lives in `$SUPABASE_HOME/stacks/<id>` and `$SUPABASE_HOME/cache/stack` (default `~/.supabase`). `SUPABASE_HOME` is the only way to move them, and the port registry (`<passwd home>/.supabase/ports.sqlite`) ignores it. So the desktop and the agents must share the same `SUPABASE_HOME`. Ports are picked automatically from 20000–32767 and stay the same across restarts. A key in `config.toml` or a `SUPABASE_*_PORT` env var pins a port instead, and there is no 'auto' value. The legacy `supabase init` template pins 54321–54329, 54320 and 8083, so the second worktree fails with a port conflict until those keys are removed. The first start applies the catalog, migrations, seeds and storage buckets once; later starts do not re-run migrations. For machine-readable output use `--output-format json` or `stream-json`. `start` returns {id, runtime, endpoints, lazy_services, env}. `supabase status --env --output-format json` returns a flat map (API_URL, DB_URL, PUBLISHABLE_KEY, ANON_KEY, SECRET_KEY, SERVICE_ROLE_KEY, STUDIO_URL, MCP_URL, MAILPIT_URL…) that the desktop can rename to EXPO_PUBLIC_* names for Metro; JWT_SECRET is no longer exported. Errors are `{"_tag":"Error","error":{code,message,detail?,suggestion?}}` with exit code 1 (130 on interrupt). `stack list --output-format json` gives a machine-wide inventory with no ports; together with `stack status/stop/destroy --stack-id` that is enough for a tracking and cleanup UI. Status and env export only work when the CLI's stack release matches the one that started the owner, so pin one CLI binary for both the desktop and the agents. The CLI sends telemetry by default (PostHog, opt-out) plus a GitHub release check. For automated runs set SUPABASE_TELEMETRY_DISABLED=1 (or DO_NOT_TRACK=1) and SUPABASE_NO_UPDATE_NOTIFIER=1. Each stack also serves Studio's MCP at `<API_URL>/mcp`. Verdict: native mode fits the one-stack-per-worktree goal (it was built for 'several checkouts of the same repo'), but it is alpha and outside the compatibility promise. Supabase's docs require CLI ≥2.119.0 (≥2.121.0 for port re-planning, destroying several stacks at once, and native pg_cron on macOS). A design doc already plans to rename `stack` to `local`.

### docs-web

Supabase's Docker-free "native" local runtime exists, but it is alpha and off by default. It only works behind the experimental stack backend, which you turn on with `[experimental] stack = true` or `SUPABASE_EXPERIMENTAL_STACK=1` (only 0 or 1 are accepted). The stack commands are excluded from the CLI compatibility promise. They first appear in the release notes of stable v2.118.0 (2026-09-25); the current latest release is 2.121.0 (2026-10-14). Native mode runs only on macOS 14+ on Apple silicon and on Linux amd64/arm64 (no Intel Macs, no Windows). What simfleet needs most is one isolated stack per directory or worktree, with automatic collision-free ports (20000-32767, tracked in a per-user `~/.supabase/ports.sqlite`). That comes from the stack backend and works with Docker and native alike, not only native. Supabase's own docs say "For several local projects on one machine, use Docker", because native stacks share the host's process table and file locks. They pitch native for agent sandboxes and CI. On the other hand, native binds public listeners to 127.0.0.1, while Docker/Podman proxies bind 0.0.0.0, exposing unauthenticated Studio, pgMeta and the local MCP endpoint to the LAN. So native fits rndevtools' loopback model better, at the cost of weaker isolation and alpha bugs. A stack's identity is the canonical project root plus the current git branch (or "detached") plus an optional `--stack` name. Each worktree gets its own stack automatically, but an agent that switches branches silently gets a new stack, and migration commands cannot target a named stack or stack ID yet (open issue #7162). Fixed ports in an existing `config.toml` (the old `supabase init` template) defeat multi-instance and must be removed. The CLI has enough machine-readable output for an rndevtools "Supabase instances" panel: `stack list`, `status` and `start` JSON, `status --env`, `logs`, `prepare`, `stop --all`, and `destroy` with repeated `--stack-id` and `--yes`. These outputs are unstable and contain secrets. Each stack serves Studio's MCP at `<API_URL>/mcp`, with a limited tool subset, no OAuth and no auth at all. The official Supabase Claude plugin instead wires agents to the hosted MCP with full account scope. Its skill never tells agents to run `supabase start`; if `.mcp.json` is missing it says to create one pointing at the hosted server. Cloud branching (Pro plan and up, $0.01344 per branch-hour, starts with no data, preview branches auto-pause, spin-up time undocumented) is workable as an optional cloud lane but not as the inner-loop replacement. Snapshot APIs exist only in the private, unpublished `@supabase/stack` package, so the CLI offers no supported way to cache a pre-migrated database like native plan. Recommendation: let the desktop own the stack lifecycle through the CLI with an explicit `--output-format json`, pin CLI ≥ 2.121.0, record each lane's stack ID and address it with `--stack-id`, default to native on Apple silicon and offer Docker as an opt-in, and strip secrets before anything crosses the socket.

### alternatives

Yes, the new native runtime fits rndevtools on Apple-silicon Macs, and it should be the default for agents that need their own backend. It runs as `supabase stack ... --runtime native`. It is alpha, gated by `[experimental] stack = true` or `SUPABASE_EXPERIMENTAL_STACK=1`, needs CLI 2.119.0 or later, and 2.121.0 or later is recommended. Three properties make it fit. First, each stack is identified by SHA-256(project root, git branch ref, stack name), so every worktree gets its own stack without editing any config. Second, automatic ports in 20000-32767 are coordinated through a per-user registry and stay the same across restarts. Third, native listeners bind 127.0.0.1 only, and only Postgres runs all the time: other services start on their first request and stop after 60 s idle. That keeps N stacks affordable next to N Simulators. Measured idle memory on darwin-arm64 is about 98 MiB for Postgres, about 0.74 GiB when DB, REST, Auth, Realtime, Storage and Functions are all awake, and about 1.9 GiB with every service awake. Several caveats change the design. The `stack` commands are experimental and outside Supabase's compatibility promise. Native needs macOS 14+ on Apple silicon. Supabase's own docs say several native projects work but are less isolated, because they share the host's process table and file locks, and they recommend Docker or Podman for that case. Because the git branch is part of the identity, switching branches in a worktree silently moves to a different stack. Fixed ports in a Docker-era config.toml make the second stack fail. `--runtime auto` picks Docker whenever it is running, and that choice sticks. The fast snapshot/restore primitive (APFS clone) exists only in the private, unpublished @supabase/stack package, not in the CLI. Ranked recommendation: (1) a native stack per worktree for lanes whose changes touch `supabase/` or that change data or auth state; (2) the same new stack with `--runtime docker|podman` when container isolation matters more than RAM and LAN exposure, or on Intel Macs; (3) one shared stack for UI-only or JS-only lanes; (4) Supabase cloud Branching for PR previews, production parity or physical devices (it costs $0.01344/h per Micro branch, is not covered by the Spend Cap, and needs the network); (5) the classic Docker `supabase start` per worktree, with `SUPABASE_PROJECT_ID` and `SUPABASE_*_PORT` set, only as a fallback: about 13-14 containers all running, ports on 0.0.0.0, and every agent command must carry the same env; (6) Neon branches only when Supabase is used purely as Postgres; (7) PGlite only for SQL or migration unit tests. On hybrids: a baseline snapshot keyed by a hash of migrations and seed is the right idea but cannot be built safely without upstream CLI support. rndevtools can compute that fingerprint now, following the native-plan pattern, to decide between shared and isolated, and use `supabase db reset --local` for resets. Lanes start Metro with EXPO_NO_DOTENV=1, so each lane's Supabase URL and publishable key must be passed through metroEnv. The tracking UI can be built entirely from `supabase stack list/status --output-format json`, joined to lanes by project_root and branch_context. Stop should be the default action, and destroy should require confirmation.

### rndev-desktop

rndevtools already has the seams a per-worktree Supabase 'backend' needs, but four existing defects should be fixed first, because a backend would inherit or amplify them. Lane start (lane-service.ts:366-541) runs in a fixed order: resolve the worktree, resume an existing lane, pick a free Simulator or park a device request, refuse conflicts, lease a port, read static app.json, boot, slim, spawn a detached Metro, record the lease, launch. The backend 'ensure' step belongs between the port lease (458-465) and the Metro spawn (505-511). Start it alongside boot/slim and await it before the spawn: Metro's env is fixed at spawn, and lane-metro.ts sets EXPO_NO_DOTENV=1, so a worktree's .env never reaches the bundle. Per-lane env injection does not exist today. Metro gets the full process.env plus a per-environment metroEnv (lane-metro.ts:110-133) that nothing configures and that is echoed to the renderer and the CLI in LaneState. A new per-lane field is needed at both spawn sites (505-511 and resume 787-793), and it should carry only public values (API URL, publishable/anon key). 'Stop' belongs in stopLane (861-868) as a non-blocking stop that keeps data; 'destroy' should be an operator action behind a main-owned dialog. release --all must not wait for teardown: the SessionEnd hook allows 2 s, and a closed socket aborts the handler. The four defects: (1) holds that exist only through a lane never auto-release, because AgentService records missingSince only for claims (agent-service.ts:328-352 vs device-hold.ts:122); (2) startLane reserves nothing between choosing a device and port (428-465) and recording the lease (531), so two concurrent `lane up` calls can get the same Simulator and the same port; (3) the desktop aborts CLI handlers after 60 s (agent-cli-service.ts:93-101) while the Go CLI waits 240 s; (4) release --all reports failed lane stops as stopped. On the Supabase side, @supabase/stack is private and not on npm (404). So the desktop must drive the supabase CLI's JSON outputs (stack list, stack status --env) rather than embed the runtime or parse ~/.supabase/stacks/<id>/state.json, whose schema Supabase calls unpublished. Stack identity is sha256(realpath of the project root, git HEAD ref or 'detached', name). Every worktree therefore gets its own stack automatically, but switching branches creates a new stack and orphans the old one with its data and reserved ports. Existing projects whose config.toml pins the Docker-era ports (54321 etc.) will collide across worktrees, because explicit config ports are honored exactly; only projects created for the experimental stack leave them out. Native listeners bind loopback, while Docker/Podman listeners bind all interfaces and `--runtime auto` prefers Docker, so the desktop should always pass `--runtime native`. Model backends as a separate BackendHold keyed by project root and branch (one backend can serve several lanes, since two apps in one monorepo worktree share one stack) that reuses an extracted liveness helper; do not widen deviceHoldSchema, which the renderer and CLI parse keyed by UDID. The native-plan/build-cache pair is a good template for a migrations-fingerprint baseline cache, but the CLI has no snapshot command today. Core redaction misses `sb_secret_` keys and passwords inside connection URLs, so Supabase-specific redaction is needed before CLI output enters a store or crosses the socket.

### rndev-cli-mcp

Adding agent-facing Supabase commands fits rndevtools cleanly because the CLI is table-driven. A new `backend` kind needs entries in protocol.go (the kind registry), parse.go (the flag-to-JSON table), schema.go (strict per-operation validation), describe.go (timeout) and the MCP catalog. Dispatch in run.go, the MCP tool schemas and envelope attribution are all generic. On the desktop side it needs a member in the zod union, a router case backed by a new BackendService port, and wiring in index.ts. Build a standalone `backend` family plus an optional `lane up --backend auto` that calls it: Supabase stacks are per worktree, and agents need a database (reset, snapshot, migrations) even when no Simulator is involved.

Two existing behaviors would break the feature unless fixed first:
- **60 s handler cap.** The desktop aborts every handler except wait and recipe-run after 60 s, while the CLI waits 240 s for lanes. A cold `backend up` would be cancelled.
- **Codex attribution over MCP.** Codex calls reach the MCP server without CODEX_THREAD_ID, so they carry a shared client-name identity, and lanes started that way record no owner. Per-session cleanup would be unreliable, so key backend ownership by worktree and use each session's cwd for attribution.

The installed SessionEnd hook already sends `release --all`, so extending the desktop's releaseEverything covers Supabase with no CLI change. Stacks must be stopped asynchronously, though: the hook's client gives up after 2 s and the desktop aborts the handler when the socket closes. Decoding the hook payload's `cwd` would also let it release worktree-keyed stacks for MCP-attributed sessions.

Steering should copy the Metro playbook in four places (MCP instructions, tool description, skill, AGENTS.md block), backed by a PreToolUse pattern for `supabase start/stop`, `stack ...` and `local ...`. The discovery experiment found MCP alone reached 12/12 adoption with zero leaks, while the skill missed once on description matching. It never tested competition with Supabase's own Claude plugin, which the Supabase CLI actively suggests.

The rndevtools/1 contract is documented in the CLI README and PROVENANCE.md, not in native/PROTOCOL.md. A new kind is additive under rndevtools/1, but the Go and TS schemas, their tests and the PROVENANCE record must change together. Because the CLI is standard-library-only, CGO-free and signed with the app, all Supabase discovery and process control must live in the desktop, which already reads SQLite read-only via node:sqlite.

Hand-started stacks can be found without running any CLI. ~/.supabase/ports.sqlite lists (state_root, stack_id) for every stack, each state.json names its realpath projectRoot and git HEAD ref, and owner.json names the owner pid. That is enough to map a stack to a lane, and via session cwd to an agent, but those files also hold credentials and an owner secret that must never be copied. Stack identity hashes projectRoot plus HEAD ref, so worktrees isolate automatically but a branch switch orphans the old stack. And because `supabase init` pins ports 54321/54322 as fixed, parallel hand-started stacks collide unless rndevtools leases ports and injects SUPABASE_*_PORT overrides. Both points argue for adopting stray stacks and making `backend up` the managed path.

Supabase's experimental `stack` command group is explicitly outside its compatibility promise and is slated to be renamed `local`, so the desktop adapter must be version-gated and fail closed. It should also force `--runtime native` (loopback-only), because Docker/Podman proxies bind all interfaces and the CLI picks Docker first when it is available.

### security-ops

Supabase's native ('no Docker') mode is the only Supabase runtime that fits simfleet's exposure rules. Native public listeners bind 127.0.0.1 (Network.ts:119). For Docker/Podman, the stack's own public proxies bind 0.0.0.0, which puts each agent's database (supabase_admin password 'postgres'), the unauthenticated Studio/MCP and Mailpit on the LAN. So rndevtools must always pass `--runtime native`, refuse or loudly flag container stacks (including ones agents create through auto selection), offer the feature only on Apple Silicon, and check the real listeners with lsof after every start (the builder-security policy's own check). By default, agents are kept apart only by port numbers. Every stack shares the same JWT secret, ES256 signing key, sb_publishable/sb_secret keys, root key and DB password. As a result, anon, service-role, secret-key and user-session tokens minted for one stack are accepted by all the others. On top of that, supabase-js's default storage key ignores the port (`sb-127-auth-token`), so a logged-in session carries over to the next lane that reuses a Simulator. Per-stack secrets are possible through the SUPABASE_AUTH_SIGNING_KEYS_PATH, JWT_SECRET, PUBLISHABLE_KEY and SECRET_KEY overrides (not the DB password). They stop drive-by browser access (the gateway sends `access-control-allow-origin: *` on every route) and connections to the wrong stack. They do not protect one same-user agent from another, because the CLI stores every credential in plaintext 0600 state.json. The bigger local-trust problem is the native rule `local all supabase_admin trust`, reachable through an unauthenticated loopback TCP proxy: any process of any macOS account, or any sandboxed agent that can reach loopback, can become SUPERUSER and run programs as the developer. Supabase lanes must therefore be documented as single-user-Mac only and as running outside any agent sandbox. Secrets must stay in Electron main. Concretely: parse `--output-format json` through a strict projection that drops the `env` map (it carries SECRET_KEY, SERVICE_ROLE_KEY and DB_URL), return only public values over the CLI/MCP socket and IPC, spawn the CLI with an allowlisted environment (the detached owner keeps whatever environment it started with), and extend the shared redactor, which demonstrably misses `sb_secret_…` and URL passwords, then apply it to the currently unredacted `lane.log`. Release bundles stay clean as long as the values only go into the dev-Metro spawn environment (lanes force NODE_ENV=development and EXPO_NO_DOTENV=1 and never build). rndevtools must never write .env* or config files, agents must be steered away from Supabase's documented `status --env > .env.local` pattern (Expo loads .env.local for production exports), and an opt-in verify-bundle check for loopback URLs and Supabase's public local default keys is cheap insurance. The variable names must be a configurable mapping that defaults to the Expo quickstart names, and the existing hard-coded EXPO_PUBLIC_SUPABASE_URL in image-overlay.ts should move into it. Destroy, `db reset` and bucket seeding are destructive. They should follow the device-hold model: only the holding session, or the operator through a dialog owned by the main process plus a one-time token. An abandoned hold past DEVICE_HOLD_GRACE_MS should only stop the stack; deletion should wait for a longer retention period or for the worktree to disappear, and uploads under supabase/.temp/stack-uploads/<id> survive destroy, so they must be cleaned up explicitly. Operationally: pin stacks by their full `--stack-id` (the stack identity includes the git branch), pass `--workdir` (otherwise the CLI climbs up to a parent checkout), set SUPABASE_TELEMETRY_DISABLED=1 and DO_NOT_TRACK=1 (consent defaults to granted), stop stacks asynchronously because the SessionEnd hook gets 3 s, cap how many stacks run at once, and exclude Studio and analytics. Repos with an older config.toml that pins 54321/54322 will collide across worktrees. The only way to integrate is the alpha CLI: @supabase/stack is not published and there is no snapshot command, so a native-plan-style cache of pre-migrated databases is not possible today.

## Critic: contradictions resolved

- **cli-surface + docs-web vs stack-services (stack-core flagged the conflict).** Whether Functions idles. cli-surface says Functions never idles; docs-web says 'the docs say Functions doesn't stop on its own'. stack-services says Functions idles at 60 s and the CLI doc is stale. This sets RAM per idle lane and edge-function wake latency.
  - **Resolution.** Spot-check settles it for stack-services. The CLI builds its composition with stack.composition.supabase(requested, { keys, eager: flags.eager }) at apps/cli/src/commands/experimental/stack/start/start.handler.ts:936-941. packages/stack/src/composition/Supabase.ts:10-14 and 784-790 make every non-database member that has an endpoint lazy with a 60 s idle (Studio 300 s); the file is byte-identical at the v2.121.0 tag. packages/stack/tests/whole-stack/idle.ts:255-268 asserts Functions is lazy with idleMillis 60000, and start/SIDE_EFFECTS.md:111-114 lists no exemption. apps/cli/docs/stack-commands.md:296-297 and the docs page (re-fetched 2026-10-16: 'Functions doesn't stop on its own') are stale. Design for Functions sleeping after 60 s and measure its cold-wake time.
- **alternatives vs cli-surface + security-ops.** Telemetry opt-out. The runner env proposed by alternatives sets SUPA_TELEMETRY=off; the other two use SUPABASE_TELEMETRY_DISABLED=1 / DO_NOT_TRACK=1.
  - **Resolution.** Settled. apps/cli/src/shared/telemetry/consent.ts:154-170 (identical at v2.121.0) denies telemetry only when SUPABASE_TELEMETRY_DISABLED or DO_NOT_TRACK is exactly '1', and otherwise defaults to 'granted'. grep finds no SUPA_TELEMETRY in apps/cli/src; it appears only in the design doc docs/telemetry.md. Use SUPABASE_TELEMETRY_DISABLED=1, DO_NOT_TRACK=1 and SUPABASE_NO_UPDATE_NOTIFIER=1.
- **docs-web vs cli-surface + stack-core.** docs-web says `stack list` reads the global registry 'without contacting live owners'. cli-surface and stack-core say it probes every owner (a lease probe plus a 2 s GET /identity).
  - **Resolution.** Settled for cli-surface and stack-core. list/SIDE_EFFECTS.md:3-9 says 'Discovery probes existing owners but never launches an owner', and list.handler.ts:28-55 (identical at v2.121.0) maps api.discover to owner reachable/unavailable. The command also mkdirs and chmods the registry (SIDE_EFFECTS.md:10-12), and it skips undecodable state with only a stderr warning (:28-30). Poll it rarely, never in a tight loop, and read those stderr warnings as 'unreadable stack' signals.
- **alternatives vs cli-surface (cli-surface is also internally ambiguous).** alternatives says project dotenv files (supabase/.env, .env.local) take precedence over process.env for SUPABASE_* overrides (local-config-values.ts:229). cli-surface says process env wins, but also says override lookup 'checks the project dotenv map and then process.env'. This decides whether SUPABASE_*_PORT and SUPABASE_AUTH_* values injected by the desktop are honored.
  - **Resolution.** Settled. envOverride does read projectEnvValues before process.env (apps/cli/src/command-internal/local-config-values.ts:206-235). But that map is built with ambient values layered last: resolveProjectEnvironmentValues returns { ...merged, ...ambientOverrides } (project-environment.ts:75-139), and packages/config/docs/cli-config-loading.md:160-175 says 'process.env wins over .env.local'. So the desktop's spawn env beats worktree dotenv files, but only in processes the desktop spawns. For commands an agent runs, the agent's shell env wins. Drop alternatives' risk item.
- **security-ops vs stack-services.** security-ops says the detached owner passes its environment to service processes and could leak hosted-project credentials into local services. stack-services says native workloads inherit only PATH, HOME, TMPDIR/TMP/TEMP, LANG and LC_*.
  - **Resolution.** Mostly settled for stack-services. packages/stack/src/runtime/native-launcher.ts:99-124 builds the workload env from exactly that allowlist; the only difference at v2.121.0 is an unrelated line. SSL_CERT_FILE and SSL_CERT_DIR are additionally forwarded to Postgres (packages/stack/README.md:132; start/SIDE_EFFECTS.md:99-110). The owner process itself keeps its full env for life (README.md:132), and same-user processes can read it. A curated spawn env is still right, but the 'secrets reach services' rationale is overstated for native. Container runtimes were not re-checked.
- **docs-web vs cli-surface.** docs-web says `stack prepare` 'pre-downloads without starting anything, but it registers a stack'. cli-surface says prepare registers the stack and leaves an owner running. This matters for the proposed cache-warming step.
  - **Resolution.** Settled for cli-surface. prepare/SIDE_EFFECTS.md:29-31 says 'The resident owner process may be launched and remains available after preparation; stack stop shuts it down', and prepare also defaults to --runtime auto. A cache-warming step must pass --runtime native, then stop or destroy the descriptor it created. Run it against the lane's real project root so the descriptor becomes the lane's own stack rather than a stray one.
- **stack-core vs docs-web, alternatives, security-ops, rndev-desktop, rndev-cli-mcp.** stack-core says rndevtools must 'never spawn owners', should only observe, and should hand rich operations to the CLI. The others want the desktop to run `supabase start --runtime native` at lane up, so a native stack exists before the agent needs one.
  - **Resolution.** They are compatible once scoped. stack-core's prohibition targets embedding @supabase/stack, or any build whose release digest differs from the agent's (HostProcess.ts:43-66 and 276-331; the release-mismatch message is at 323-329). Spawning through the same supabase build the agent uses produces an owner of the same release. The design should state the rule explicitly: the desktop only runs the worktree's own CLI build, never a bundled or embedded build of another release (see the binary-parity blocker).
- **stack-core + rndev-cli-mcp vs security-ops, cli-surface, stack-services, rndev-desktop.** How to observe and control stacks. stack-core: parse state.json tolerantly, read owner.json, and POST /shutdown with its bearer secret or send SIGTERM. rndev-cli-mcp: read ports.sqlite, state.json and owner.json directly. The other four: use only the CLI's JSON output, and never read state.json (plaintext credentials, no version field) or the owner's control secret.
  - **Resolution.** Choose one layering and write it down:
- CLI first: `stack list`, `stack status --stack-id`, `stack stop/destroy --stack-id`. Stop and destroy work across releases (packages/stack/README.md:74; HostProcess.ts:129-146).
- `ps` argv (`__supabase_stack_host__ <stateRoot> <cacheRoot> <id>`, HostProcess.ts:495-503) for liveness, and as the check before any SIGTERM fallback.
- Optionally one read-only SELECT on ports.sqlite (PortReservations.ts:67-74) for ports and other state roots.
Never read the owner.json secret or the credentials in state.json.
- **rndev-cli-mcp (security-ops lists it as an option) vs cli-surface, docs-web, alternatives, rndev-desktop.** Port strategy. rndev-cli-mcp wants to lease a per-worktree port block and inject SUPABASE_*_PORT, calling it 'the strongest argument for the managed path'. The others want the registry to auto-allocate 20000-32767 and rndevtools to read the ports back.
  - **Resolution.** Default to automatic ports. The ranges cannot overlap 8100-8399 or 47931 (Ports.ts:23-27, identical in the tag's Ports.ts header). Ports pinned by env are exact intents and get re-planned whenever a start runs without the same env (stack-config.ts:179-196; endpoint_changes in start.handler.ts). Use SUPABASE_*_PORT overrides only as a compatibility mode for repos whose committed config.toml pins ports, and only if rndevtools owns every start. Dev bundles read EXPO_PUBLIC_* from Metro's env when the bundle is served, so a moved port only needs a Metro restart.
- **docs-web vs cli-surface, alternatives, security-ops.** docs-web says rndevtools can set SUPABASE_EXPERIMENTAL_STACK=1 itself instead of requiring a committed flag. The others say that without `[experimental] stack = true` (or the env in the agent's shell), the agent's own `supabase db/migration/gen --local` commands go to the legacy Docker backend and miss the stack.
  - **Resolution.** Settled against docs-web. apps/cli/src/command-internal/experimental-feature.ts:89-108 (identical at v2.121.0) uses the env when it is set, otherwise the config value; with neither, the legacy backend runs. An env set only by the desktop therefore covers only commands the desktop spawns. Choose one: a committed config flag (the user's repo), SUPABASE_EXPERIMENTAL_STACK=1 injected into agent sessions by `rndevtools setup`, or routing every Supabase command through rndevtools via the hook.
- **alternatives vs the user goal and the other seven reports.** alternatives makes 'one shared stack for UI-only/JS-only lanes' the cheap default for lanes whose supabase/ has not diverged. The user asked for each agent to get its own isolated instance whenever its worktree uses Supabase.
  - **Resolution.** Keep isolated-per-worktree as the default. A shared stack belongs to one worktree's identity. An agent in another worktree that runs `db reset --local` or `gen types --local` resolves to its own stack, which does not exist (stack-local-database.ts:55-61), and gets 'The local stack is not running.' Offer 'shared' only as an explicit opt-in that connects Metro and nothing else, with that caveat documented, and 'none' when the worktree has no supabase/config.toml.
- **stack-core + stack-services (develop clone) vs the v2.121.0 release all reports recommend pinning.** The reports say native backend ports 10000-19999 are claimed in ports.sqlite as 'native:<key>@<port>', so two stacks of the same user never collide on them.
  - **Resolution.** Settled by diffing raw.githubusercontent.com/supabase/cli/v2.121.0 against the clone. The claim code in packages/stack/src/Ports.ts (develop 151-156, 199-262, 593-648) and the claimNativePort hook in Network.ts (develop 65-72, 375) exist only on develop. In v2.121.0, backend ports are probed and bound with no registry row ('Never saved: backend ports are private'), so concurrent native starts can race and fall back to an exclusion retry. Either pin a release that includes the claims or test the race. Re-verify every claim taken from develop against the pinned tag.
- **alternatives + cli-surface vs stack-services.** Native readiness budget. alternatives and cli-surface give 2 minutes, citing ADR-0017 ('a cold process can spend more than 30 s loading shared libraries'). stack-services gives a 60 s deadline with up to 3 launch attempts.
  - **Resolution.** Settled for stack-services. packages/stack/src/services/ProcessRecipe.ts:217-218 sets startupTimeoutSeconds = 60 and nativeLaunchAttempts = 3, and docs/adr/0017-...md:3 is marked superseded. Size client timeouts from the code values plus measured cold starts.
- **rndev-cli-mcp vs rndevtools' own README (and the brief's attribution model).** native/rndevtools-cli/README.md:80-82 says both agents pass their session variables to the MCP servers they spawn. experiments/agent-discovery/FINDINGS.md:159-162 says Codex does not, so Codex-over-MCP calls are attributed to 'mcp-codex-mcp-client'.
  - **Resolution.** The code path confirms the gap. internal/mcp/server.go:337-356 falls back to 'mcp-' plus the client name, and internal/command/describe.go:177-190 sets command.agent only from the env. agent-command-router.ts:1384-1410 records lane.agent only from command.agent, so a Codex-over-MCP lane is stored without an agent and treated as operator-owned (device-hold.ts:113-117). It is never abandoned and never matched by release --all. Treat FINDINGS as authoritative until current Codex is re-tested; key backend ownership by worktree plus session cwd; fix the README.
- **task brief, security-ops, rndev-cli-mcp vs rndev-desktop.** The brief, security-ops and rndev-cli-mcp assume abandoned holds auto-release after DEVICE_HOLD_GRACE_MS, and hang stack stop on that clock. rndev-desktop says holds that exist only through a lane never auto-release.
  - **Resolution.** Confirmed for rndev-desktop. The only writer of #missingSince is #expireAbandonedClaims, which loops over claims only (apps/desktop/src/main/agent-service.ts:111, 328-352). resolveDeviceHolds falls back to `now` (src/shared/device-hold.ts:122), so a lane-only holder's releaseAt is always now + 10 min and the check at lane-service.ts:891-899 never fires. Before reusing the clock for stacks, track missingSince for every holder key referenced by lanes, claims or backends, and add an agent-service test.
- **task brief vs apps/desktop/AGENTS.md and code (noted by rndev-desktop and security-ops).** The brief says the renderer never receives filesystem paths except through dialogs owned by main. In fact LaneState already sends worktreePath and logPath to the renderer, and lane.start accepts a worktreePath from it.
  - **Resolution.** The real rule (apps/desktop/AGENTS.md:30) is that lanes never TAKE a path from the renderer except through the repository dialog. lane-ipc.ts:57-62 nevertheless passes lane.start, worktreePath included, straight to the service, which is an existing deviation. Backend IPC should address stacks by stack ID or lane ID only; showing paths is fine. Put the lane.start path intake on the fix list, or confirm it is intentional.
- **rndev-desktop + alternatives vs stack-core + cli-surface.** Project-root discovery. rndev-desktop and alternatives say Supabase prefers supabase/config.json over config.toml. stack-core and cli-surface say the root is the nearest ancestor containing supabase/config.toml.
  - **Resolution.** Both are correct, at different layers. The CLI's upward search (apps/cli/src/config/command-settings.layer.ts:74-99) looks only for supabase/config.toml and falls back to cwd; it does not stop at the worktree root. Config loading prefers config.json once the workdir is known. rndevtools should look for either file statically, only between appPath and the worktree root, and always pass an explicit --workdir.
- **docs-web vs security-ops, alternatives, cli-surface.** Supabase's official guidance (reported by docs-web) is 'For several local projects on one machine, use Docker', because native stacks share the process table and file locks. The other reports make native the default or the only runtime.
  - **Resolution.** I re-fetched https://supabase.com/docs/guides/local-development/running-multiple-local-projects on 2026-10-16 and the quote stands. Record native as a deliberate, documented deviation: the repo's loopback rule and the builder-security policy rule out Docker/Podman's 0.0.0.0 proxies (Network.ts:119) as a default. Tell the user plainly that native gives weaker isolation between agents, and keep Docker as an explicit opt-in that warns about LAN exposure.
- **security-ops vs rndev-desktop, alternatives, rndev-cli-mcp.** Naming. security-ops proposes supabase-cli.ts, supabase-protocol.ts and a `supabase` command kind; the others propose a provider-neutral `backend` kind and BackendService.
  - **Resolution.** This is a product decision against the 'nothing product-specific' rule (AGENTS.md:32; packages/core/AGENTS.md: never hardcode a vendor header). A neutral `backend` kind with Supabase as its first provider fits the rule, with vendor-specific defaults such as env names kept in options. There is already a precedent to clean up: packages/react-native/src/diagnostics/image-overlay.ts:21-24 hard-codes EXPO_PUBLIC_SUPABASE_URL.
- **rndev-cli-mcp vs docs-web.** rndev-cli-mcp says the Supabase CLI suggests installing 'supabase@claude-plugins-official' and that the plugin's contents were not inspected. docs-web inspected supabase-community/supabase-plugin v0.1.16 (hosted MCP; its skill never says `supabase start`).
  - **Resolution.** Partly reconciled. The hint is printed only on login paths: login-claude-hint.ts:5 is used only by command-internal/ensure-login.ts:15 and login/login.handler.ts:18, not by stack commands. Confirm that the marketplace entry resolves to supabase-community/supabase-plugin. The competing pull is agents using the hosted MCP or writing a hosted .mcp.json into the worktree, not starting local stacks by hand.
- **stack-services vs alternatives.** Idle memory per service differs slightly. Manifest figures: Postgres 96.2, Storage 265.5, Analytics 507.6, Pooler 216.8 MiB. slim-services README: 97.6, 284.6, 503.2, 203.7 MiB.
  - **Resolution.** Minor: these are different publisher runs of standalone idle services, and both leave out the owner and launcher processes. Neither should set a cap; measure N stacks under rndevtools on the target Mac.

## Web sources consulted

- http://127.0.0.1:${port}/rpc
- http://localhost:54321/mcp
- https://api.github.com/repos/supabase/slim-services/releases
- https://docs.expo.dev/guides/environment-variables/
- https://formulae.brew.sh/api/formula/supabase.json
- https://github.com/supabase/cli/issues/5787
- https://github.com/supabase/cli/issues/6302
- https://github.com/supabase/cli/issues/6445
- https://github.com/supabase/cli/issues/6771
- https://github.com/supabase/cli/issues/6832
- https://github.com/supabase/cli/issues/6845
- https://github.com/supabase/cli/issues/6846
- https://github.com/supabase/cli/issues/6858
- https://github.com/supabase/cli/issues/6915
- https://github.com/supabase/cli/issues/6922
- https://github.com/supabase/cli/issues/6975
- https://github.com/supabase/cli/issues/6977
- https://github.com/supabase/cli/issues/6987
- https://github.com/supabase/cli/issues/7007
- https://github.com/supabase/cli/issues/7008
- https://github.com/supabase/cli/issues/7162
- https://github.com/supabase/cli/pull/7027
- https://github.com/supabase/cli/pull/7061
- https://github.com/supabase/cli/pull/7175
- https://github.com/supabase/cli/pull/7186
- https://github.com/supabase/cli/pull/7188
- https://github.com/supabase/cli/pull/7193
- https://github.com/supabase/cli/releases/tag/v2.118.0
- https://github.com/supabase/cli/releases/tag/v2.119.0
- https://github.com/supabase/cli/releases/tag/v2.120.0
- https://github.com/supabase/cli/releases/tag/v2.121.0
- https://github.com/supabase/cli/releases?q=stack&expanded=true&page=2
- https://github.com/supabase/mcp/blob/HEAD/README.md:41
- https://github.com/supabase/mcp/issues/257
- https://mcp.supabase.com/mcp
- https://mcp.supabase.com/mcp?features=docs
- https://neon.com/pricing
- https://pglite.dev/docs/pglite-socket
- https://pglite.dev/extensions/
- https://raw.githubusercontent.com/supabase-community/supabase-plugin/HEAD/.claude-plugin/plugin.json
- https://raw.githubusercontent.com/supabase-community/supabase-plugin/HEAD/SUPABASE.md
- https://raw.githubusercontent.com/supabase-community/supabase-plugin/HEAD/agents/claude/.mcp.json
- https://raw.githubusercontent.com/supabase/agent-skills/HEAD/.mcp.json
- https://raw.githubusercontent.com/supabase/agent-skills/HEAD/skills/supabase/SKILL.md
- https://raw.githubusercontent.com/supabase/slim-services/main/README.md:122-133
- https://raw.githubusercontent.com/supabase/slim-services/main/README.md:13
- https://raw.githubusercontent.com/supabase/slim-services/main/README.md:171-174
- https://registry.npmjs.org/-/package/supabase/dist-tags
- https://registry.npmjs.org/@supabase%2fstack
- https://registry.npmjs.org/supabase
- https://supabase-cli-artifacts.s3.us-east-1.amazonaws.com/<svc>/<release>/<svc>-<release>-darwin-arm64.manifest.json
- https://supabase-cli-artifacts.s3.us-east-1.amazonaws.com/postgres/17.11.0.004-r1/postgres-17.11.0.004-r1-darwin-arm64.tar.zst:
- https://supabase.com/blog/select-2026-build-anything:
- https://supabase.com/blog/select-2026-operate-with-confidence:
- https://supabase.com/blog/supabase-select-2026-recap
- https://supabase.com/docs/guides/ai-tools/mcp
- https://supabase.com/docs/guides/ai-tools/plugins
- https://supabase.com/docs/guides/deployment/branching
- https://supabase.com/docs/guides/deployment/branching/troubleshooting
- https://supabase.com/docs/guides/getting-started/quickstarts/expo-react-native
- https://supabase.com/docs/guides/local-development/cli/getting-started
- https://supabase.com/docs/guides/local-development/docker-and-native-runtimes
- https://supabase.com/docs/guides/local-development/docker-and-native-runtimes:
- https://supabase.com/docs/guides/local-development/running-multiple-local-projects
- https://supabase.com/docs/guides/local-development/running-multiple-local-projects:
- https://supabase.com/docs/guides/platform/manage-your-usage/branching
- https://supabase.com/docs/guides/self-hosting/enable-mcp:
- https://supabase.com/pricing
- https://www.postgresql.org/docs/17/sql-createdatabase.html

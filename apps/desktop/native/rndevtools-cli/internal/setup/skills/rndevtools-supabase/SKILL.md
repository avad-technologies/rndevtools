---
name: rndevtools-supabase
description: >
  Use RN Devtools for a git worktree's local Supabase: starting or checking
  the worktree's own local database (Postgres, with REST, Auth, Storage,
  Realtime and Functions on 127.0.0.1), connecting the app in a lane to it,
  creating, applying or testing migrations, resetting and reseeding, reading
  Supabase service logs, Studio, or finding the local API URL and publishable
  key. Trigger on requests like "start the local database", "supabase start",
  "reset the db", "reseed", "apply this migration locally", "run two
  worktrees with their own database", "show the Supabase logs", "open
  Studio", or "the app cannot reach Supabase". Never run supabase start
  without --runtime native, supabase stop --all, supabase stack destroy, or
  pkill postgres.
---

# RN Devtools local Supabase

> If an `rndevtools` MCP server is connected, its `supabase` tool takes the
> same arguments as the CLI below (`operation`, `worktree`, `stack-id`, …);
> prefer it, and read this skill for the workflow. The CLI remains the
> fallback when no MCP server is registered.

Each git worktree, on each branch, gets its own local Supabase stack: its own
Postgres database, API port, and Mailpit, on 127.0.0.1, using Supabase's
native runtime. RN Devtools starts, stops, and cleans up these stacks for
lanes and agents, so parallel worktrees never share a database or fight over
ports. You keep running your own database commands (migrations, resets, type
generation) with the worktree's own CLI.

## When RN Devtools manages a worktree

RN Devtools runs a worktree's stack when:

- the user turned on local Supabase in RN Devtools › Supabase;
- the repository commits `[experimental] stack = true` in
  `supabase/config.toml`;
- the worktree's dependencies are installed, with `supabase` pinned as a
  devDependency.

When a `supabase` call answers `supabase_disabled`, `supabase_unsupported`,
or `cli_unverified`, RN Devtools is not managing that worktree. Start the
stack yourself from the worktree with the project's own runner and the native
runtime, for example `pnpm exec supabase start --runtime native`. Never start
one without `--runtime native`: a new stack would pick Docker when Docker
answers, and Docker stacks listen on every network interface.

## Start

1. **Create or switch to your git branch first.** A stack belongs to a
   worktree and a branch. Switching branches later gives you a fresh database
   that RN Devtools follows; switching back restores the old one.
2. **For a lane, run `lane up` and stop there.** With `--backend auto`, the
   development default, `rndevtools lane --operation up --worktree "$PWD"`
   starts this worktree's stack and hands Metro its URL and publishable key.
3. **For database work without a lane:**

```bash
rndevtools supabase --operation up --worktree "$PWD"
```

The result carries `stack` (`id`, `status`, `apiPort`, `dbPort`,
`branchContext`, `holders`), `cli.run` (the runner to use, for example
`pnpm exec supabase`) and `cli.workdir`, `appEnv` (the variable names Metro
gets), `metro`, `next`, and `warnings`. The first start on this Mac downloads
services once, which takes about a minute: when the result carries a `jobId`,
wait for it.

```bash
rndevtools wait --condition job --job-id <jobId>
```

A start queued behind RN Devtools' own automatic start has no `jobId`: wait a
few seconds, then call `up` again, as for `lane up`.

`up` is idempotent. Call it again after a branch switch, or whenever unsure.

## Work with the database

Run the worktree's own CLI from `cli.run`, from `cli.workdir`, always with
`--local`:

```bash
pnpm exec supabase migration new add_profiles
pnpm exec supabase migration up --local
pnpm exec supabase db reset --local      # drops the data, re-runs migrations and seed
pnpm exec supabase gen types typescript --local > src/types/database.ts
pnpm exec supabase test db
```

- **Use only the worktree's CLI.** Never `npx supabase@latest`, `pnpm dlx`,
  `bunx supabase@…`, or a global install: a stack only answers the CLI build
  that started it.
- **Never start or stop Supabase by hand while RN Devtools manages the
  worktree.** `supabase start`, `stop`, `stack …`, and `db start` are
  redirected to `rndevtools supabase` by the hook; call it directly instead.
- **After a branch switch, call `up` before `db diff`, `db pull`,
  `migration squash`, or `db schema declarative …`.** Without a running stack
  for the branch they would create one with automatic runtime selection.
- **Target your local stack, not a hosted project,** unless the user asks.

## Look

```bash
rndevtools supabase --operation ls                         # every stack, with lanes and holders
rndevtools supabase --operation status --worktree "$PWD"   # services and health
rndevtools supabase --operation env --worktree "$PWD"      # URLs, publishable and anon keys
rndevtools supabase --operation log --worktree "$PWD" --service auth --tail 100 --since 10m
```

- **`env` returns public values only.** The secret and service-role keys and
  the database URL never leave RN Devtools. Never write keys, or the output
  of `supabase status --env`, into a `.env` file: Expo bundles those files
  into the app, and lanes already pass the public values to Metro.
- **Idle services sleep.** After a minute without requests a service stops;
  the next request wakes it (Realtime takes up to about 3 s, the very first
  Functions call about 22 s).
- **The keys are local defaults every stack shares.** After the app moves to
  another stack, sign out and in again.
- **Studio is off by default.** If the user wants it, they enable it in
  RN Devtools › Supabase. Do not open Studio or `/mcp` yourself unless asked.

## Reset, destroy, stop

```bash
rndevtools supabase --operation reset --worktree "$PWD"            # migrations and seed; --seed=false skips the seed
rndevtools supabase --operation destroy --worktree "$PWD" --note "why it should go"
rndevtools supabase --operation down --worktree "$PWD"
rndevtools release --all                                           # when the whole task is done
```

- **`reset` runs at once only when you are the stack's only holder.** When
  another session holds it, the reset becomes a request the user approves,
  and the result says `requested`.
- **`destroy` never deletes anything by itself.** It files a request that the
  user settles in RN Devtools. To start fresh yourself, use `reset`.
- **`down` releases your hold.** The stack stops once nobody else uses it, and
  its data is kept. `release --all` does that for everything you hold, along
  with your lanes and claims.
- **Never run `supabase stop --all`, `supabase stack destroy`, or
  `pkill postgres`.** Native stacks share this Mac, so those hit every
  agent's databases.

## If supabase reports…

| Code | Do |
| --- | --- |
| `supabase_disabled`, `supabase_unsupported`, `cli_unverified` | Start the stack yourself from the worktree: `<runner> start --runtime native`. |
| `cli_missing` | Install the worktree's dependencies. Do not use npx or dlx versions. |
| `stack_flag_missing`, `config_conflict` | Ask the user to commit `[experimental] stack = true` (and to remove `supabase/config.json`). Do not edit it yourself. |
| `ports_pinned` | Ask the user to delete the listed port settings. Never stop the other stack. |
| `container_runtime` | Ask the user to destroy that stack in RN Devtools › Supabase, then call `up`. |
| `supabase_capacity` | Call `down` for stacks you no longer need, or ask the user to raise the limit. |
| `supabase_held` | Another session holds the stack. Ask the user. |
| `cli_mismatch` | Call `up`: RN Devtools restarts the stack with this worktree's CLI and keeps its data. Never destroy it to fix this. |
| `job_lost` | Call `up` again; it is idempotent. |
| `branch_moved` | Call `up` to get the current branch's stack. |
| `git_busy` | Finish the rebase or merge, then call `up`. |
| `not_found` | Call `ls`, then retry with a worktree path. |
| `needs_recreate` | If your change caused it, revert that setting and call `up` again; the stack keeps its data. Otherwise ask the user to recreate the stack in RN Devtools › Supabase; that deletes its local database. |
| `supabase_failed` | Retry once, then read `log`. |

Every error also carries `recovery` text. Follow it before improvising.

## Report

State the worktree and branch, the stack id prefix, its status and API port,
the CLI you ran (`cli.run`), and the migrations you applied. Database
commands succeeding is not proof the app works; check the app in its lane.

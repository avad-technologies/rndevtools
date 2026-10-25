# Agent discovery experiment: skill vs MCP

Which integration makes a coding agent *actually use* RN Devtools for
Simulator work instead of reaching for `xcrun simctl`? This harness runs
Claude Code and Codex headlessly against the real desktop socket and a real
booted Simulator, under four conditions, and scores adoption where it can be
measured honestly: at the socket.

## Conditions

| Condition | What the agent is given |
| --- | --- |
| `none` | Nothing. Control. |
| `skill` | The `rndevtools-lanes` SKILL.md in the agent's user skills directory (`~/.claude/skills`, `~/.agents/skills`). The `rndevtools` CLI is on PATH. |
| `mcp` | The `rndevtools` MCP server registered (Claude `--mcp-config`, Codex `[mcp_servers.rndevtools]`). No skill. |
| `both` | Skill and MCP. |

The blocking `simctl` hook is deliberately absent in every condition: the
experiment measures discovery, not enforcement.

## Isolation

Each run gets a fresh fake `HOME` (and `CODEX_HOME`) holding exactly the
condition's files, so the operator's real configuration, skills, plugins, and
MCP servers never leak in. Claude additionally runs with `--strict-mcp-config`
and `--setting-sources user`. Only authentication crosses the boundary: a
credential-export helper needs the real HOME, so the harness resolves AWS
credentials once and hands the agent plain `AWS_*` variables.

Runs are randomised across conditions within each prompt so drift in the
Simulator's state or the model's day cannot favour one condition.

## Measurement

- **Adopted**: at least one request reached the RN Devtools socket during the
  run. `desktop-fixture.mjs` runs the desktop's router under Electron and logs
  every request with its attribution and whether it came via the MCP server
  (`mcp-…` request ids) or the CLI (`cli-…`).
- **Leaked**: at least one mutating `simctl` verb (`boot`, `shutdown`,
  `openurl`, `install`, `launch`, `io`, …) or a hand-started Metro (`expo
  start`, `react-native start`) ran in Bash. Claude's Bash calls are recorded
  by a PreToolUse hook that allows everything; Codex's come from its `--json`
  event stream.
- **rndevtools calls**: every socket request, as `kind:operation`, with `!code`
  appended on failure, so recovery behaviour is visible per run.

The database prompts (`start-local-db`, `reset-seed`, `apply-migration`,
`two-worktrees`) measure local Supabase steering the same way.

- **Adopted:** an agent sends `supabase:up` to the socket.
- **Leaked:** it starts, stops or destroys a stack by hand, picks a non-native
  runtime, runs `stop --all`, or kills a stack's processes.

The worktree's own `--local` data commands (`migration up`, `db reset`,
`gen types`) are expected, and `leak-rule.mjs` does not count them. Both
skills are installed in the skill conditions. Run these prompts against a
fixture repository that has `supabase/config.toml` (the Expo example's is
one), with local Supabase turned on in the fixture desktop.

Transcripts are kept per run for reading what the agent actually did.

## Running

```sh
cd apps/desktop
npx esbuild experiments/agent-discovery/experiment-entry.ts --bundle --platform=node --format=esm \
  --outfile=dist/main/experiment-entry.js --external:electron
cp experiments/agent-discovery/desktop-fixture.mjs /tmp/exp-fixture.mjs
npx electron --in-process-gpu --disable-gpu --disable-gpu-compositing \
  /tmp/exp-fixture.mjs /tmp/exp-requests.jsonl /tmp/exp.ready /tmp/exp.stop &
# wait for /tmp/exp.ready, then:
node experiments/agent-discovery/run.mjs --out experiments/agent-discovery/results/<name> \
  [--agents claude,codex] [--conditions none,skill,mcp,both] [--prompts id,id] [--repeat N]
touch /tmp/exp.stop   # when done
```

The RN Devtools desktop app must *not* be running (the fixture owns the
socket). A Simulator must be booted; set `RNDEVTOOLS_EXPERIMENT_UDID` to
choose one. The fixture is copied to `/tmp` because Electron treats a script
inside the package as the app to launch.

## Prompts

See `prompts.json`. Each has an `intent` explaining what it probes: the
canonical "run this branch" case, pure observation, device-level input, the
Metro-collision scenario lanes exist for, the missing-dev-client recovery
path, and a prompt with no UDID where the agent has to discover and pick a
free device.

## Results

Each results directory holds `results.json` (per run), `summary.md` (tables),
and `<run>.transcript.txt` / `<run>.bash.jsonl`; `rescore.mjs` merges several
directories and re-applies the current leak rule. `results/` is gitignored:
transcripts record whatever the agents saw on the operator's machine (other
sessions, installed apps, paths) and must not be published. The findings and
the summary tables live in `FINDINGS.md`.

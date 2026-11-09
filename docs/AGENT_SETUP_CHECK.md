# Agent setup check

Open **Setup → Choose extras**, or **Lanes → Agents → Agent setup checks**.
The same read-only check appears in `rndevtools doctor` and runs before and
after `rndevtools setup`. The view rechecks on focus and once a minute while
visible. **Recheck** always reads fresh configuration.

## Checks and repairs

The check covers Claude Code and Codex default user configuration, the selected
registered project, RN Devtools MCP registration, routing instructions, its two
skills, and installed steering hooks. It flags known simulator controllers such
as XcodeBuildMCP, iOS Simulator MCP, SimView, Maestro, Argent, Radon,
agent-device and Appium. A registered controller is a potential overlap; the
check does not start it or claim it has interfered with a lane. Hosted Supabase
and Expo cloud tools are not disabled. With a project selected, the skills and
the routing block that `rndevtools setup --project` installs in that project
count in place of missing user-level copies: Codex reads the project's
`AGENTS.md`, and Claude Code reads its `CLAUDE.md`, which may import that file
with an `@AGENTS.md` line. An outdated user-level copy is still reported,
because every project loads it.

Select a repository/worktree to include its overrides. Each finding shows its
client, source, scope, and available action. Clicking a repair opens a native
confirmation describing the exact file and effect; when that file is a link,
it also names the file the link points to, which is the one written. A
selected-project repair is not offered when the project's file resolves
outside the project (for example a committed link to your user settings),
because it would change every project; change that setting where the file
lives. The repair revalidates the preview against current files, changes one
file atomically, and rechecks.

| Fix | Scope |
| --- | --- |
| Disable a Codex MCP or plugin | Effective user or selected trusted project configuration |
| Disable a Claude plugin | All projects, or a local override for the selected project |
| Disable a Claude MCP | Selected project only; its registration is retained |
| Repair RN Devtools registration | Existing effective registration, preserving environment and approval policy; a Codex tool timeout under 240 s is raised to 240, as setup does |
| Install hooks, routing or RN Devtools skills | The displayed client file; other hooks/instructions remain |

**Undo** restores the touched setting while retaining unrelated later edits.
If a newer edit changed that same setting, undo refuses to overwrite it. Text
files are restored only while their content still matches the repaired version.
Undo removes empty MCP entries created by a repair; if new settings were added
inside that connection, it stops and preserves the current configuration.
Previews bind to resolved file and directory symlink targets, so switching a
dotfiles directory requires a new preview. JSON numbers retain their precision,
and selective TOML undo recovers value types from the original source snapshot.
Private previews and original bytes are stored under
`~/Library/Application Support/RN Devtools/agent-check`, with directory mode
0700 and file mode 0600. Reports never include environment values or credentials.
They are kept only while undo can use them. A preview that is not applied
within its five minutes, because it was cancelled or never confirmed, is
deleted with its copy of the file at the next check. Undoing a repair deletes
its record. Each scope keeps its 32 most recent repairs for undo, listed newest
first, and applying another repair deletes the records past that.

Reload the affected client after a change. In Codex, review new hooks with
`/hooks`. **Test RN Devtools connection** performs MCP initialize, tools/list,
and doctor against the bundled CLI. It does not change simulator/database state
or establish which tools an already-running Claude/Codex chat has loaded.

## Local CLI

```sh
rndevtools agent-check
rndevtools agent-check --project /absolute/project
rndevtools agent-check --operation plan --finding-id finding-ID
rndevtools agent-check --operation apply --plan-id check-ID
rndevtools agent-check --operation undo --plan-id check-ID
rndevtools agent-check --operation probe
```

Use the same project scope for plan/apply/undo. Previews expire after five
minutes. An unknown operation, a plan without `--finding-id`, an apply or undo
without `--plan-id`, or a relative path is a usage error (`invalid_arguments`,
exit 2); a check or repair that cannot run is `agent_check_failed` (exit 7). Repairs are local CLI/UI actions, not an MCP capability that changes
another agent's configuration without a user review. `--config-home` supports
isolated setup tests without changing the process's home directory; pass
`--no-doctor` to `rndevtools setup` in such a test, because its closing doctor
dials the socket under the real home.

## Coverage limits

Malformed or unreadable client files and uncertain Codex project trust disable
automatic fixes for that client. Vendor skills containing lifecycle commands
receive review findings; their files are never rewritten automatically. Tool
filters and disabled-hook policy receive review findings and are preserved.
First-run setup also skips unsupported hook sections or event shapes instead of
overwriting them. Routing checks distinguish quoted marker examples from the
managed instruction block and offer updates when that block is stale.

Custom configuration homes, Codex profiles, ancestor project overrides, managed
organization policy, unknown wrappers, detailed plugin tool filters, remote
clients, and currently loaded tool lists are not certified. Kiro and Cursor
configuration is not scanned: setup registers RN Devtools there, but a
simulator controller registered in them needs review in that client. Hook files being
installed does not prove approval or execution. Shell hooks steer supported
shell payloads; they are not an MCP firewall.

Use the [fresh Mac checks](FRESH_MAC_SETUP.md) to separately prove native helper
trust, simulator input, two Metros, and two independent databases. Optional
Maestro/Argent adapters remain future work in the
[automation investigation](AGENT_HEALTH_AND_AUTOMATION_PLAN.md).

# Agent setup check

Open **Setup → Choose extras**, or **Lanes → Agents → Agent setup checks**.
The same read-only check appears in `rndevtools doctor` and runs before and
after `rndevtools setup`. The view rechecks on focus and once a minute while
visible. **Recheck** always reads fresh configuration.

## Checks and repairs

The check covers Claude Code and Codex default user configuration, the selected
registered project, RN Devtools MCP registration, routing instructions, its two
skills, and installed steering hooks. It flags known simulator controllers such
as SimView, Maestro, Argent, Radon, agent-device and Appium. A registered
controller is a potential overlap; the check does not start it or claim it has
interfered with a lane. Hosted Supabase and Expo cloud tools are not disabled.

Select a repository/worktree to include its overrides. Each finding shows its
client, source, scope, and available action. Clicking a repair opens a native
confirmation describing the exact file and effect. The repair revalidates the
preview against current files, changes one file atomically, and rechecks.

| Fix | Scope |
| --- | --- |
| Disable a Codex MCP or plugin | Effective user or selected trusted project configuration |
| Disable a Claude plugin | All projects, or a local override for the selected project |
| Disable a Claude MCP | Selected project only; its registration is retained |
| Repair RN Devtools registration | Existing effective registration, preserving environment and approval policy |
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
minutes. Repairs are local CLI/UI actions, not an MCP capability that changes
another agent's configuration without a user review. `--config-home` supports
isolated setup tests without changing the process's home directory.

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
clients, and currently loaded tool lists are not certified. Hook files being
installed does not prove approval or execution. Shell hooks steer supported
shell payloads; they are not an MCP firewall.

Use the [fresh Mac checks](FRESH_MAC_SETUP.md) to separately prove native helper
trust, simulator input, two Metros, and two independent databases. Optional
Maestro/Argent adapters remain future work in the
[automation investigation](AGENT_HEALTH_AND_AUTOMATION_PLAN.md).

# Failure history and agent investigations

Open **Lanes → Failures**. The desktop monitors simulator-related macOS crash
reports every 30 seconds and records managed Metro exits and failed simulator
operations. Use **Scan now** to refresh. **All events** also shows intentional
Metro stops/restarts, with their reason. Each failure can be copied, resolved,
or reopened. Opening an investigation does not resolve it.

History survives desktop restarts in the app data `failures/history.json`, in a
private directory with private files. It retains the latest 200 events and up to
64 lane contexts. Diagnostic scanning covers the last 30 days, reads only known
report formats in standard macOS DiagnosticReports folders (including Retired),
and projects bounded, redacted metadata and stack symbol names. It never stores
raw memory sections. Oversized files, scan limits, and file-access/storage errors
are shown in the UI. Unreadable history is preserved instead of overwritten.

A resource diagnostic (for example, CoreSimulator disk writes with “Action taken:
none”) is shown as a warning, not proof of a crash. A disappeared Metro adopted
from an earlier desktop session has an unknown exit code/signal; the UI says so.
So does one whose recorded PID now names another process, as after a reboot:
the lane forgets that PID, and the history still records its Metro as gone.
A Metro that RN Devtools asked to stop is not reported as missing: the request
is kept with its lane's context, not among the latest 200 events.
An OS crash is evidence to investigate, not proof that application code is wrong.
Reports are associated with a known lane only within its observed lifetime.
Failed simulator operations use the operation's start time for association, even
when they finish after the device has moved to another lane. Overlapping or
unknown lane lifetimes remain unassigned; choose the project explicitly.

## Investigate or fix through a subscription

Install Codex CLI or Claude Code, then sign in with **ChatGPT** or **Claude.ai**.
Track the relevant repository in Lanes. Select the failure, registered project,
and client. **Investigate** opens Codex in a read-only sandbox, or Claude Code in
plan mode, which edits no file. **Fix with Codex/Claude** lets the client edit
the project, but it asks before each edit and each command not already allowed:
Codex runs with `--sandbox workspace-write --ask-for-approval untrusted`, so
only its read-only commands and those your Codex rules allow run unasked, and
Claude Code runs in its default (manual) permission mode, so only what your
Claude Code permission rules allow runs unasked.

A native confirmation comes first, with **Cancel** as the default button, so
Return never opens a session. It shows the failure, the project and the action,
and lists what the prompt sends, as untrusted evidence, and to whom (OpenAI for
Codex, Anthropic for Claude Code):

- the failure's title, kind, time, source and detail, with its lane, port and
  Simulator when known;
- the Metro log tail, when the failure carries one: up to 8 KB of the lane's
  Metro output, redacted, including the app's own console logs;
- for a crash report, its fields and stack symbol names, which the crashing app
  can influence;
- the project path.

RN Devtools verifies the client's subscription login, clears inherited API-key,
provider, and stale session overrides, and passes the diagnostic as quoted data
to the installed CLI. It does not call a model API or manage API credentials.
Codex is constrained to ChatGPT login and the OpenAI provider; Claude Code uses
Claude.ai login settings. Existing managed client policies remain authoritative.
If subscription login cannot be verified, the action stops with instructions.
Subscription usage limits still apply. If the app's inherited PATH has Node but
not the selected agent CLI, discovery also checks the login-shell PATH. Terminal
uses the same home and client configuration directories verified by the login
check, rather than inheriting different credential locations from its session.

Review findings, changes, and test results in the terminal. Mark the failure
resolved only after verification. Up to 50 recent task/script pairs are kept in
`failures/tasks`; no background autonomous repair or broad permission bypass is
started. The normal CLI session discovers the project's instructions and RN
Devtools MCP registration installed by **Coding agents → Set up**.

## Lane lifetime

Codex's SQLite recent-thread view is a display/discovery aid, not an exit signal.
An idle chat, long tool call, or thread outside that view retains its simulator,
Metro, and Supabase hold across desktop restarts. Release explicitly when done;
supported client session-end hooks also release. Claude sessions with confirmed
process exit retain the existing ten-minute grace period. Data is not destroyed
by release.

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
An OS crash is evidence to investigate, not proof that application code is wrong.
Reports are associated with a known lane only within its observed lifetime.

## Investigate or fix through a subscription

Install Codex CLI or Claude Code, then sign in with **ChatGPT** or **Claude.ai**.
Track the relevant repository in Lanes. Select the failure, registered project,
and client. **Investigate** opens read-only/plan mode; **Fix with Codex/Claude**
opens the normal interactive coding mode with the client's approval prompts.
A native confirmation shows the project and action before Terminal opens.

RN Devtools verifies the client's subscription login, clears inherited API-key,
provider, and stale session overrides, and passes the diagnostic as quoted data
to the installed CLI. It does not call a model API or manage API credentials.
Codex is constrained to ChatGPT login and the OpenAI provider; Claude Code uses
Claude.ai login settings. Existing managed client policies remain authoritative.
If subscription login cannot be verified, the action stops with instructions.
Subscription usage limits still apply.

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

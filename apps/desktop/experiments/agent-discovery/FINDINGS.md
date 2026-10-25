# Findings: how coding agents discover RN Devtools

Date: 2026-10-15. Machine: macOS 26.7.1, Xcode 26.6, one booted iPhone 17 Pro.
Agents: Claude Code 2.1.300 (ASBX build, Bedrock), Codex CLI 0.162.1 (Bedrock,
`openai.gpt-5.6-sol`). Harness: `run.mjs` against a live desktop socket
(`desktop-fixture.mjs`). 48 valid runs: 6 prompts × 4 conditions × 2 agents,
one iteration each. Per-run cap 6 minutes.

The raw runs (transcripts, shell logs, `results.json`) are not kept in the
repository: they record the operator's machine (other live agent sessions,
installed apps, home-directory paths), which has no place in a published tree,
and everything they supported is extracted below. `results/` is ignored; rerun
`run.mjs` to regenerate them locally.

An earlier 48-run attempt was discarded after its 8th run: the harness's port
cleanup killed the desktop fixture (a bare `lsof -ti tcp:PORT` also returns
the fixture's own client connection to Metro), so the remaining 40 runs
measured a dead socket and are excluded here.

## Headline

| condition | adopted RN Devtools | drove the Simulator behind its back |
| --- | --- | --- |
| none (control) | 0 / 12 | 10 / 12 |
| skill only | 11 / 12 | 1 / 12 |
| MCP only | 12 / 12 | 0 / 12 |
| both | 12 / 12 | 0 / 12 |

"Adopted" means at least one request reached the RN Devtools socket during the
run (measured at the socket, not inferred from the transcript). "Drove behind
its back" means a mutating `simctl` verb, a hand-started Metro, or a
third-party driver (idb, axe) ran in the shell.

Per prompt, adopted / runs (⚠ leaked, ⏱ hit the 6-minute cap):

| prompt | claude/none | codex/none | claude/skill | codex/skill | claude/mcp | codex/mcp | claude/both | codex/both |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| run-branch | 0/1 ⚠ ⏱ | 0/1 ⚠ | 1/1 | 1/1 ⏱ | 1/1 | 1/1 ⏱ | 1/1 | 1/1 |
| screenshot | 0/1 ⚠ | 0/1 ⚠ | 0/1 ⚠ | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 |
| tap-home | 0/1 ⚠ | 0/1 ⚠ | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 |
| metro-collision | 0/1 ⚠ | 0/1 ⚠ ⏱ | 1/1 | 1/1 ⏱ | 1/1 | 1/1 ⏱ | 1/1 ⏱ | 1/1 ⏱ |
| missing-dev-client | 0/1 | 0/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 |
| ambiguous-device | 0/1 ⚠ ⏱ | 0/1 ⚠ | 1/1 | 1/1 ⏱ | 1/1 ⏱ | 1/1 ⏱ | 1/1 | 1/1 ⏱ |

**MCP alone gets both agents to 100 % adoption with zero leakage on every
prompt**, including the three that the control condition handles by driving
the Simulator directly (screenshot, tap, run). Adding the skill on top of MCP
changed nothing measurable in adoption or leakage.

**The skill alone is nearly as good, with one instructive miss.** On the bare
prompt "take a screenshot of the iOS Simulator … and tell me what is on
screen", Claude with the skill installed went straight to `xcrun simctl io …
screenshot`. The skill's description is about lanes and worktrees; the model
did not judge it relevant to a screenshot, so the body was never loaded. That
is the description-matching failure mode of skills, observed once in twelve
runs. MCP has no such step: `capture` is simply in the tool list.

Both agents, with no integration, did what you would expect and what lanes
exist to prevent: Codex ran `npx expo start --ios` on port 8081 and
`simctl openurl`; Claude searched the machine for drivers, found `idb` and
`axe`, and tapped with them. In the "pick a free device" prompt the control
runs booted two further Simulators to find an empty one.

## What the integrated agents did well

- **They check before they take.** Every integrated run on the ambiguous-device
  prompt called `agents` and `simulators` first, saw the shared iPhone 17 Pro's
  recent sessions, and chose (and `claim`ed) a different device. Control runs
  booted whatever `simctl list` showed.
- **They obey "do not build".** All eight integrated missing-dev-client runs
  called `native plan`, reported the single `npx expo run:ios … --no-bundler`
  command verbatim, and did not run it. Codex without integration recommended a
  different, incorrect command (`npx expo install expo-dev-client && npx expo
  run:ios …`).
- **They stop at other agents' lanes.** Claude with MCP, finding the device
  assigned to another worktree's lane, declined to tear it down and asked the
  user: "getting it onto that simulator would mean removing another agent's
  lane, and I want your OK first." That is the behaviour the claims system
  exists to produce.
- **They read `recovery` text.** When `lane up` failed, the next call was
  almost always the one the error named (`lane ls`, `native plan`, `lane log`).

## Where they struggled, and what we changed

**1. A repeated `lane up` failed as a conflict.** In the very first runs an
agent whose first `lane up` was interrupted retried it and got "already has
lane", with no path forward. Fixed in `c1ebd38`: `lane up` for the same app
and Simulator now returns the existing lane, restarts Metro if it died, and
relaunches. Codex's own transcript shows why it matters: it called `lane up`
three times in one run.

**2. The 6-minute cap is mostly the native build.** 13 of the 48 runs timed
out. In 11 of them the agent was waiting on `npx expo run:ios` (CocoaPods plus
a React Native compile from a cold cache); the other two were the control
condition polling a Metro it had started by hand. This is the fixture's cost,
not the agents' fault: the fixture app has no cached dev client, so every
"run" prompt bottoms out in a first native build. Two things follow for the
product: `native plan`'s `build:` recommendation now says a first build takes
5–15 minutes and to tell the user rather than wait silently (skill and MCP
description updated), and the build cache (`@rndevtools/react-native/build-cache`)
is what turns this from minutes into seconds on every worktree after the
first.

**3. Agents reached for `simctl spawn … launchctl` to verify.** Several
integrated runs, after tapping through `input`, confirmed the foreground app
with `xcrun simctl spawn <udid> launchctl print system`. That is read-only and
we score it as such, but it signals a missing tool: there is no `rndevtools`
way to ask "what app is in the foreground" for an app that has not connected
to RN Devtools. Candidate follow-up: a `foreground` operation on `apps`, or an
accessibility snapshot (`idb ui describe-all` equivalent) as the general
answer.

**4. `lane down` failed in this sandbox.** Eleven of twenty-two `lane down`
calls failed with "Could not inspect process … to confirm it is this lane's"
because the agent sandbox blocks `/bin/ps`. The desktop fails closed by
design; outside the sandbox `ps` works and this does not occur. It did mean
agents sometimes saw stale lanes from earlier runs, which is also why the
harness now gives each run its own fixture directory.

## Cost

Mean wall time per run, excluding timeouts: Claude 20–50 s for observation
prompts in every integrated condition versus 11–14 s for the control's single
`simctl` call; the extra time is the orientation calls (`agents`,
`simulators`, `lane ls`) the agent makes before acting. Codex made more calls
per run than Claude in every condition (49 vs 43 with the skill, 28 vs 25 with
MCP). The skill condition issued roughly 1.7× as many rndevtools calls as MCP
for the same prompts (the skill's checklist says to run `doctor`, `simulators`,
`lane ls`, and `agents` before `lane up`; the MCP tool descriptions do not
prescribe an order), so MCP is also the cheaper path.

## Recommendation

1. **Ship MCP as the primary integration** and register it by default in
   `rndevtools setup`. It gave 100 % adoption and 0 % leakage on both agents
   with no prompt engineering, and it is the only mechanism all four agents
   (Claude Code, Codex, Cursor, Kiro) discover without the model first deciding
   a skill applies.
2. **Keep the skill, but reposition it.** It carries procedure the tool
   descriptions cannot (the build-cache workflow, the claim etiquette, the
   recovery sequences), and its one miss was a description problem: widen the
   `description` to name screenshots, taps, and device state, not only lanes.
   Done in this change.
3. **Keep the PreToolUse hook as a backstop for Claude Code**, not as the
   mechanism. With MCP registered it never had to fire in this experiment
   (0 leaks), but the control condition shows what it prevents when
   registration is missing or a project has `--strict-mcp-config`.
4. **Add a foreground-app / accessibility read** so verification stops needing
   `simctl spawn launchctl`.
5. **Pre-build the dev client in the fixture** before the next iteration of
   this experiment, so the timeout column measures agent behaviour rather than
   Xcode.

## Limits of this experiment

One iteration per cell, so a single run decides each cell; the per-condition
totals (n = 12) are the numbers to read, not the per-prompt cells. One model
per agent, one day. The fixture app cannot actually be run (no dev client, no
cache), so "task completed" was not scored; adoption and leakage were. The
Codex MCP attribution shows `mcp-codex-mcp-client` because Codex does not pass
`CODEX_THREAD_ID` to the MCP servers it spawns; claims and touches from Codex
over MCP therefore attribute to the client, not the thread.

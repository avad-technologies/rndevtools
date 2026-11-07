# Set up RN Devtools on another Mac

Install the signed release app in `/Applications` and launch it before connecting
an agent. Installing the packaged app does not require Go, Swift build tools, or
a HeroUI Pro token. Building RN Devtools itself from source does; see the desktop
README. A locally signed development build is not a substitute for testing the
downloaded, notarized release through Gatekeeper on another Mac.

## Prerequisites

- Full Xcode, an accepted Xcode license, and an available iOS Simulator runtime.
  Use **Get started → Check your Mac** to select Xcode and check its runtime.
- The consuming project's Node version, package manager, and installed
  dependencies. Confirm `node --version` in a new Terminal. RN Devtools launched
  from Finder reads the login shell PATH and retries discovery after Node is
  installed or a version manager replaces it.
- For managed local Supabase: Apple silicon, macOS 14 or newer, and the project's
  own supported Supabase CLI. The bundled Expo demo pins a verified CLI. Run
  `rndevtools doctor` to see the exact CLI gate for another project; do not
  assume a globally installed CLI or a different major version is supported.

## Connect the agent

Use **Get started → Choose extras → Coding agents → Set up**, or run:

```sh
"/Applications/RN Devtools.app/Contents/Resources/native/rndevtools" setup
```

Restart the coding agent or reload its MCP servers after registration. If using
the short command in Terminal, put `~/.local/bin` on the shell PATH. Review and
trust newly installed Codex hooks with `/hooks` when setup requests it. Run
`rndevtools doctor` and inspect any `skip` in the setup report.

Open **Setup → Choose extras → Agent setup check** before and after registration.
After setup it remains under **Lanes → Agents**. Review overlapping simulator
controllers, choose the relevant project, and use the scoped repair/Undo
buttons. Reload the affected client, then run the connection test. Installed
hooks still need client trust; the check does not grant it automatically.
See [agent setup checks](AGENT_SETUP_CHECK.md) for repair scope and coverage.

Setup preserves existing MCP approval settings, environment, disabled state,
and longer timeouts. Agent tool approval is separate from RN Devtools' resource
ownership checks and macOS permissions. See the
[agent permission reference](../apps/desktop/native/rndevtools-cli/README.md#agent-permissions).

Enable **Local Supabase** and **SimSlim** in their desktop tabs when needed.
SimSlim is experimental: an unverified runtime/profile/build combination needs
its explicit acknowledgement. Ordinary simulator input and captures do not
need host Accessibility, camera, microphone, or Screen Recording grants.

## Failures and investigations

Open **Lanes → Failures** for persistent Metro and simulator diagnostics. Install
and sign in to Codex CLI with ChatGPT or Claude Code with Claude.ai to use the
**Investigate** and **Fix** buttons with your subscription. See
[failure history](FAILURE_HISTORY.md) for retention and handoff behavior.

## Prove two independent lanes

Create two git worktrees on different branches before starting either backend.
Install dependencies in each. Pass each app directory (the directory containing
`app.json`), including its workspace subdirectory in a monorepo.

```sh
rndevtools lane --operation up --worktree /absolute/lane-a/app --backend required --slim rndevtools-development
rndevtools lane --operation up --worktree /absolute/lane-b/app --backend required --slim rndevtools-development
rndevtools lane --operation ls
rndevtools supabase --operation ls
```

Without `--udid`, RN Devtools chooses a free device. If none is available, settle
the returned device request in the desktop and poll `lane ls`. If a result
contains a `jobId`, wait for that job; a timeout is an observation deadline, not
proof that the background work stopped. A first Supabase start downloads and
initializes services and can take several minutes.

When no matching dev client is installed, keep the lane and inspect the native
plan for its assigned device:

```sh
rndevtools native --operation plan --worktree /absolute/lane-a/app --udid DEVICE_UDID
```

Follow `recommendation`: install a cache hit with `native --operation install`,
or start the requested lane with `launch=false` and run the supplied
`expo run:ios … --port LANE_PORT --no-bundler` command once for a cache miss.
The port matters: Expo still opens the app with `--no-bundler`. A matching
bundle ID only proves that an app is installed, not that its native fingerprint
is current. An explicit cached install refreshes that binary.
RN Devtools owns Metro. Then run `lane --operation launch` for the lane.

Check all of the following before calling the Mac qualified:

- Different simulator UDIDs and Metro ports/PIDs, with both apps connected.
- Different Supabase stack IDs and API/database ports.
- A record written through app A appears in A and is absent from B, and vice
  versa. Separate local stacks use shared default signing keys unless per-stack
  keys are enabled; data isolation alone does not prove JWT signing isolation.
- Relaunch each app, repeat `lane up`, and restart the desktop. The same lanes
  should recover with their own Metro and backend. Observe jobs until terminal.
- Restore and reapply SimSlim on a test device, then check app input, captures,
  and database access again. Retain the restore checkpoint.
- An unrelated agent is refused access to a device held by another session.

For a simulator that stops responding, recover only the device your session
already holds with `rndevtools simulator --operation shutdown --udid DEVICE_UDID`,
then `--operation boot` for the same UDID. Follow each returned pending job with
`rndevtools wait --condition job --job-id JOB_ID` before proceeding. Relaunch
its lane and repeat input, capture, and database checks. The existing plural
`simulators` command remains read-only; reload the agent client to discover the
separate lifecycle tool and check its permission policy.

For Codex clients that omit their thread identity over MCP, use the CLI from
the chat's shell for explicit `CODEX_THREAD_ID` attribution. Never put one chat's
thread ID into the global MCP registration.

At the end of a disposable test, stop only its lanes and release their holds.
Do not stop other agents' Metros or databases, delete simulator data, or erase
Supabase stacks to clear a setup error. The error's `recovery` field identifies
the next supported action.

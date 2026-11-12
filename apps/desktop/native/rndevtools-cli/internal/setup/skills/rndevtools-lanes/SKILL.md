---
name: rndevtools-lanes
description: >
  Use RN Devtools for anything involving an iOS Simulator on this Mac: running
  a React Native worktree or branch on its own Simulator (lanes with a leased
  Metro port, so agents never collide on 8081 or a shared device), taking a
  screenshot of a Simulator, tapping, swiping, or typing on it, pressing its
  home or lock button, checking which Simulators exist and which other agents
  hold them, launching or deep-linking the dev client, finding out whether the
  native build is installed or cached, and cleaning up. Trigger on requests
  like "run this branch", "open the simulator", "screenshot the simulator",
  "tap X on the device", "start the app for my worktree", "restart the app",
  "pick a free simulator", or "fix a Metro port collision". Never drive a
  Simulator with xcrun simctl boot/shutdown/openurl/install/launch/terminate/io,
  idb, axe, or another Simulator MCP server (XcodeBuildMCP, ios-simulator).
---

# RN Devtools lanes

> If an `rndevtools` MCP server is connected, its tools (`lane`, `simulators`,
> `capture`, `input`, …) are the same commands as the CLI below with the same
> arguments; prefer them, and read this skill for the workflow. The CLI remains
> the fallback when no MCP server is registered. On the command line an
> operation is always the `--operation` flag
> (`rndevtools lane --operation up --worktree "$PWD"`); the CLI rejects an
> operation written as a positional word. A command given
> any field flag never reads stdin, and neither does one complete without any,
> such as a bare `rndevtools simulators`, so an input that stays open cannot
> hang them. One that needs fields and is given none, such as a bare
> `rndevtools lane`, reads a JSON command from stdin unless that is a
> terminal: pass its flags instead.

A **lane** is one git worktree running on one Simulator, served by one Metro on
a port the desktop leased for it. Lanes are how several branches, and the agents
working on them, run side by side without fighting over port 8081 or a shared
Simulator. The RN Devtools desktop app owns every lane; this CLI talks to it over
a private local socket.

## Prerequisites

- RN Devtools is running on this Mac (`rndevtools doctor` succeeds).
- Pass the absolute **app directory** containing `app.json`, inside a git
  checkout (the checkout root for a single-app repository). Install its
  dependencies and declare `expo.scheme` in `app.json`. Lanes read
  the scheme to deep-link the dev client; they never evaluate `app.config.js`.
  A lane reads it when it starts and keeps what it read: one started without
  a scheme opens its dev client only through
  `rndevtools lane --operation launch --lane-id <laneId> --url <full launch URL>`
  (`lane --operation up` takes no URL), and a scheme declared later counts
  only for a new lane. The error's `recovery` gives both commands.
- The Expo development client is **already installed** on the Simulator. Lanes
  never trigger a native build. If `rndevtools apps --udid <UDID>` does not list
  the app, follow
  `rndevtools native --operation plan --worktree "$PWD" --udid <UDID>` (below):
  reserve a lane first, then use its cached install or its build command, and
  restart the app on the lane after a build.

## Rules

- **One lane per worktree, one Simulator per lane.** Lane creation fails rather
  than stealing a worktree, a Simulator, or a port another lane holds. If
  `lane --operation up` is refused, read the error: it names the owning lane.
  Do not work around it by killing processes.
- **Never pick ports by hand, and never start Metro yourself.** The desktop
  leases ports from the environment's range (`development` 8100–8199 by
  default). Do not run `expo start`, a bare `npx expo` (Expo CLI's default
  command is start, so `npx expo --port 8082` starts Metro too),
  `react-native start`, `expo run:ios` without `--no-bundler`, or a package
  script that runs one of those (`npm start`, `yarn ios`): each starts its
  own Metro, and the hook blocks them.
- **Never start Supabase by hand for a lane.** When the user has turned on
  local Supabase in RN Devtools and the worktree's `supabase/config.toml`
  sets `[experimental] stack = true`, `lane --operation up` starts the
  worktree's own stack and hands Metro its URL and publishable key. Do not run
  `supabase start` or `stop` yourself, and never write keys into `.env`
  files. The `rndevtools-supabase` skill covers database work.
- **Always address Simulators by exact UDID.** Never use `booted`; with several
  Simulators running, `simctl` picks one at random. The UDID you get back from
  `lane --operation up` is the one to pass to every later `rndevtools` call.
- **Stop only the lanes you started.** `lane --operation down` stops the lane's
  Metro and frees the Simulator. It does not shut the Simulator down.
- **Attribution is automatic.** The CLI forwards `CLAUDE_CODE_SESSION_ID` or
  `CODEX_THREAD_ID` on every request, so each Simulator you touch is shown with
  your session in the desktop's Agents view for 30 minutes. Other agents can
  export `RNDEVTOOLS_AGENT_SESSION_ID`.
- **A Simulator is free or held.** It is held while a lane runs on it or a
  session has claimed it, and only the holder may boot it, send it input,
  install on it, slim it, or stop it. The desktop enforces this:
  `lane --operation up`, `launch`, and `down`, `input`,
  `native --operation install`, slimming,
  `recipe --operation run`, and cancelling its jobs or recordings on a device
  another session holds fail with `device_held`, naming the holder, except
  for a recording you started yourself: starting one needs no hold, and
  `record --operation stop` or `jobs --operation cancel` always works on it,
  whoever holds the device by then. `act` and `network` are not gated, so a
  hold does not keep another session out of the app itself.
  `rndevtools agents` lists every hold (`holds`: device, holder, via
  `lane` or `claim`, whether the holder is still alive) and the live sessions,
  so pick a device with no hold. Make your own hold explicit for work that is
  not a lane:

  ```bash
  rndevtools claim --udid <UDID> --note "reviewing the checkout flow"
  rndevtools release --udid <UDID>      # that one device
  rndevtools release --all              # everything this session holds: lanes stopped, claims dropped
  ```

  A Claude hold with a confirmed dead session is released after 10 minutes.
  Codex’s recent-thread list is not a process-liveness signal: an idle or
  unlisted Codex chat keeps its lanes and databases until explicit release.
  So does a session known only by `RNDEVTOOLS_AGENT_SESSION_ID`, whose end
  RN Devtools cannot see.
  Supported session-end hooks release at once. Run `release --all` when the
  task is finished unless the user wants the lanes left running.
- **Only RN Devtools respects holds.** Other Simulator MCP servers
  (XcodeBuildMCP's `boot_sim`, `build_run_sim`, or `launch_app_sim`;
  ios-simulator's `launch_app` or `ui_tap`) drive a device directly: a hold
  does not stop them, and the hook, which reads only shell commands, never
  sees their calls. Do not use them on Simulators RN Devtools manages.
- **You may slim the devices you hold.** `rndevtools slimming --operation
  apply|undo|restore --udids <UDID>[,...] [--profile-id <id>]` applies a SimSlim
  profile, reverts the last managed change, or restores every managed service.
  It works only while the user has enabled SimSlim in RN Devtools, only on
  devices that are free or yours (`device_held` otherwise), and only on
  runtime/profile combinations SimSlim has verified or the user approved once;
  the error names which gate refused. Applying reboots the device, so prefer
  `rndevtools lane --operation up --worktree "$PWD" --slim <profileId>` for
  the device a lane is about to use.

## Recover a Simulator you already hold

If a launch is blocked by a Simulator that stopped responding, use its exact
UDID from your existing claim or lane. Shutdown preserves the lane, Metro,
local backend, and Simulator data. Follow each pending job before moving on.

```bash
rndevtools simulator --operation shutdown --udid <UDID>
rndevtools wait --condition job --job-id <jobId>  # if shutdown is pending
rndevtools simulator --operation boot --udid <UDID>
rndevtools wait --condition job --job-id <jobId>  # if boot is pending
rndevtools lane --operation launch --lane-id <laneId>
```

`simulators` lists devices; `simulator` takes both flags. Both lifecycle
operations require an exact owning session identity. If MCP reports a shared
identity, run the CLI from the native agent session that owns the lane or
claim.

## Start a worktree on a Simulator

```bash
rndevtools doctor                                     # 1. desktop reachable?
rndevtools lane --operation ls                        # 2. see existing lanes and worktrees
rndevtools lane --operation up --worktree "$PWD"      # 3. RN Devtools picks a free Simulator
```

Leave `--udid` out unless the user named a device: the desktop picks a free
iPhone (nobody's lane, nobody's claim), booted ones first, so you never race
another session for it. One caveat: a booted Simulator nobody holds can still
be one a person is using, so pass `--udid` when the user named a device or is
using one. To choose yourself, run `rndevtools simulators`, pick a device with
no hold, and pass `--udid <UDID>`.

When nothing is free the result has `completed: true`, no `lane`, a
`deviceRequest` with its `id`, its `status` and the reason (`message`), and
a `next` that names the poll; RN Devtools asks the user to start your lane
on an existing Simulator or a new clone (you cannot create Simulators).
Tell the user, then poll `rndevtools lane --operation ls` every ~10 s: the
entry in `deviceRequests` with your `id` ends `fulfilled` with a `laneId`,
or `dismissed`. A `fulfilled` request whose lane did not launch says so in
its `message` (`Started lane <laneId> on <UDID>, but its launch failed: …`),
which ends with the command that launches it again once the cause is fixed,
usually `rndevtools lane --operation up --worktree "$PWD"`; read it before
driving the app. Do not retry `lane --operation up` in a loop while the
request is pending; a retry replaces the request and resets the user's
card.

`--worktree` is wherever you are working: a checkout root, or the app's
directory inside a monorepo checkout. The lane is keyed on the containing git
worktree and runs Metro from the directory you gave (`lane.appPath` when it
differs from `lane.worktreePath`). Two apps in one checkout can each have a
lane; one app cannot have two.

`lane --operation up` boots the Simulator if needed, starts Metro on the
leased port, waits up to 15 s for `/status`, and deep-links the dev client
with the SDK 57 launch form
(`<scheme>://expo-development-client/?url=http://127.0.0.1:<port>`). Before
the lane's first dev-client launch it terminates any running copy of the app
on that Simulator, so the app starts fresh with only this lane's Metro. It
names the app by the `ios.bundleIdentifier` that `app.json` declared when the
lane started; without one, or when the Simulator cannot terminate the app, the
launch goes ahead, and the result's `warnings` and the lane's log say so. A
launch held back until the lane's local backend is ready (`lane.backend`
`starting`) opens after `lane --operation up` has returned, so then only the
lane's log says so (`rndevtools lane --operation log --lane-id <laneId>`). The
result includes `lane.id`, `lane.port`, `lane.simulatorUdid`, and `lane.metro`
(`starting` | `ready` | `stopped`). Pass `--launch=false` to lease and start
Metro without opening the app.

Running `lane --operation up` again for the same worktree is safe: it returns
the app's existing lane (on whatever Simulator it has, when you omit
`--udid`), restarts Metro on the lane's port if it died, and relaunches. Once
the lane's dev client has opened, a relaunch leaves the running app as it is;
add `--restart` to start it fresh (see [Restart the app](#restart-the-app)). A
lane whose dev client has not opened yet (one started with `--launch=false`,
or whose launches failed or only opened a deep link) still terminates the app
at its first dev-client launch, from whichever of `up` or `launch` opens it.
Naming a *different* Simulator for an app that already has a lane, or a
Simulator that carries another app's lane, is a conflict; use
`lane --operation ls` to see which.

Add `--slim <profileId>` (ids come from `rndevtools slimming --operation
status`, e.g. `rndevtools-development`) to trim the Simulator's background
services before Metro starts. The desktop applies it in the lane's own
sequence (boot, slim, Metro, launch) when SimSlim is enabled in RN Devtools,
the device's runtime/profile combination is verified or approved, and the
device is free or yours. `lane.slim` in the result says `applied` (with the
SimSlim `jobId`), `skipped` with the reason (SimSlim is off, the build is
unsigned, the device is held by another session, the combination needs the
user's one-time approval), or `failed`. An unknown profile id fails the whole
`lane --operation up` before anything boots. Slimming persists across reboots
on iOS 26, so a device slimmed once stays slim for every later lane.

`--backend auto|off|required` decides this worktree's local Supabase.
`auto`, the default for the `development` environment, starts the worktree's
own stack when RN Devtools manages its Supabase project, and never fails the
lane; `required` fails the lane when the stack cannot start; `off` skips it.
`lane.backend` in the result says `ready`, `starting` (the app launches once
the stack is ready), `skipped`, `shadowed` (the app's own `.env` files
override the injected URL), `refused`, or `failed`, with the reason. A
`starting` backend usually carries a `jobId`: wait for it with
`rndevtools wait --condition job --job-id <jobId>`. A start queued behind RN
Devtools' own automatic start has none: wait a few seconds, then call
`lane --operation up` again, which is idempotent, as for
`supabase --operation up`. Create your git branch before
`lane --operation up`: each branch gets its own database.

If the dev client is not installed on that Simulator, `lane --operation up`
fails with `<bundle id> is not installed on this Simulator` and leaves Metro
running. **Do not reach for `expo run:ios` first**: without `--no-bundler` it
starts its own Metro, and the hook blocks it. Ask the desktop what the
worktree needs; it fingerprints the native inputs with the project's own Expo
tooling and checks the shared build cache, so ten worktrees of one native
shell build once:

```bash
rndevtools native --operation plan --worktree "$PWD" --udid <UDID>
```

The result carries `fingerprintHash`, `cache` (`hit` | `miss` | `no-provider`),
`installed`, and a one-line `recommendation` that starts with the verb to act
on. `installed` only means the bundle exists, not that its native fingerprint
matches, and it is left out when the Simulator is not booted or listing its apps
fails; the recommendation then ends by saying why. An explicit cached install
refreshes that binary. A build opens the app as soon as it installs it, even
with `--no-bundler`, against port 8081, so restart the app on the lane
afterward:

| `recommendation` starts with | Do |
| --- | --- |
| `install:` | `rndevtools native --operation install --worktree "$PWD" --udid <UDID>` puts the cached binary on the Simulator in seconds. |
| `build:` | The plan quotes the build only once the lane's Metro is ready. If it asks for a lane, start one with `rndevtools lane --operation up --worktree "$PWD" --launch=false`; if it says the lane's Metro is not ready, read `rndevtools lane --operation ls` and `rndevtools lane --operation log --worktree "$PWD"`; then call `rndevtools native --operation plan --worktree "$PWD" --udid <UDID>` again. Run the quoted build once, exactly as quoted: `npx expo run:ios --device <UDID> --no-bundler`, with `--configuration Release` only when that was asked for. Add no `--port`: Expo CLI refuses `--port` with `--no-bundler`. Never add `--configuration Debug` (Debug is already the default, and naming it starts Metro even with `--no-bundler`). Finish with the launch the plan quotes after the build, exactly as quoted: `rndevtools lane --operation launch --lane-id <laneId> --restart`, which reopens the app with the lane's Metro. A lane started without an `ios.bundleIdentifier` in `app.json` cannot restart the app, so for it the plan quotes the launch without `--restart` and says how to quit the app before it: `rndevtools simulator --operation shutdown --udid <UDID>`, then `rndevtools simulator --operation boot --udid <UDID>`, which keep the lane, its Metro and the Simulator's data; or declare `ios.bundleIdentifier` in `app.json` and replace the lane with `rndevtools lane --operation down --lane-id <laneId>` and `rndevtools lane --operation up --worktree "$PWD"`, whose first dev-client launch restarts the app; or ask the user to quit the app. For a lane started without a scheme, the launch carries `--url` with the dev client's full launch URL. The build cache stores the result for every other worktree with the same fingerprint. A first native build compiles CocoaPods and React Native and commonly takes 5–15 minutes; tell the user it is running rather than waiting silently, and do not restart it. If the user asked you not to build, report the exact command instead. |

A JavaScript-only branch reports the same `fingerprintHash` as the branch it
came from, so it is a cache hit, never a build. Then:

```bash
rndevtools lane --operation launch --worktree "$PWD"
```

If Metro does not become ready, the lease is kept so you can read the bundler
error:

```bash
rndevtools lane --operation log --worktree "$PWD"
```

Fix the actual Metro error, then relaunch:

```bash
rndevtools lane --operation launch --worktree "$PWD"
rndevtools lane --operation launch --worktree "$PWD" --restart             # start the app fresh
rndevtools lane --operation launch --worktree "$PWD" --url checkout/cart   # deep link via the lane scheme; app state kept
```

## Restart the app

`--restart` on `lane --operation up` (resuming an existing lane) or on
`lane --operation launch` terminates any running copy of the
lane's app (its bundle identifier) on the lane's Simulator before the dev
client opens, so the app starts fresh with only this lane's Metro. A lane does
this on its first dev-client launch without the flag, as far as it can (see
[Start a worktree on a Simulator](#start-a-worktree-on-a-simulator));
`--restart` asks for it, so a terminate that fails fails the launch, and it
needs the `ios.bundleIdentifier` the lane started with.

```bash
rndevtools lane --operation up --worktree "$PWD" --restart
rndevtools lane --operation launch --worktree "$PWD" --restart
```

Use it when the app last ran against another Metro (another lane, a build, or
one started by hand), when the JavaScript debugger opens the wrong app, or
whenever the app needs a clean start; never `xcrun simctl terminate` it. A
React Native dev client keeps an inspector connection to every Metro it was
pointed at for as long as it runs, so an app re-pointed to a new port stays
listed as a debug target on whatever Metro later takes the old port.
Terminating an app that is not running counts as success, and device holds
apply as they do to any `up` or `launch`.
`rndevtools lane --operation launch --worktree "$PWD" --url <path>` without
`--restart` never terminates the app: a deep link keeps its state, and it
leaves that first restart to the dev-client launch after it.

## Drive the app that is running in the lane

Use the UDID from the lane for every call so your actions stay on your
Simulator:

```bash
rndevtools screen   --udid <UDID>
rndevtools elements --udid <UDID> --query "button"
rndevtools act      --udid <UDID> --tool routes --action-command navigate --action-payload '{"path":"/settings"}'
rndevtools wait     --udid <UDID> --condition network-idle
rndevtools capture  --udid <UDID> --name "after-checkout"
```

The connected app reports its own Simulator UDID, so `--udid` reaches both the
Simulator and the app session running inside it.

## Drive the Simulator itself

`rndevtools input` sends real touches and keys through the native host, the
same path Simulator.app uses, so it works on Springboard, system alerts, the
login screen, and the dev client before it has connected. Coordinates are
ratios of the screen (`0..1` from the top-left); divide a pixel position by the
screenshot's width and height to get them.

```bash
rndevtools input --udid <UDID> --kind tap --x 0.39 --y 0.92              # tap
rndevtools input --udid <UDID> --kind tap --x 0.5 --y 0.5 --hold-ms 700  # long press
rndevtools input --udid <UDID> --kind swipe --from-x 0.5 --from-y 0.85 --to-x 0.5 --to-y 0.3
rndevtools input --udid <UDID> --kind text --text "user@example.com"      # typed, never pasted
rndevtools input --udid <UDID> --kind key --usage 40                      # Return (HID usages: 40 Return, 42 Delete, 41 Escape, 43 Tab)
rndevtools input --udid <UDID> --kind button --button home                # home, lock, siri, volume-up, volume-down, apple-pay
```

Prefer `rndevtools act` for the app's own screens: it drives the connected
app's semantic actions and reports structured results. Use `input` when there
is no connected app to talk to, or for anything outside the app. After an
input, take a screenshot (`rndevtools capture`) or re-read `elements` to see
what changed; the result only says the Simulator acknowledged the gesture.

## Stop

```bash
rndevtools lane --operation down --worktree "$PWD"     # or --lane-id <lane.id>
rndevtools release --all                               # when the whole task is done
```

`lane --operation down` ends one lane and frees its Simulator and port.
`release --all` ends every lane this session owns, drops its claims, and
releases its local Supabase stacks (they stop in the background, data kept);
it is what the session-end hook runs when that client emits it. An idle Codex
chat is never proof of exit; explicitly release when finished unless the user
requests that the lanes remain running.

## Report

State the lane id, worktree and branch, Simulator name and UDID, environment,
Metro port and health, whether the Simulator was slim, and `lane.backend`'s
status when the worktree uses local Supabase. A healthy Metro or a
successful launch is not proof a feature works; include UI evidence from
`screen`, `elements`, or `capture`.

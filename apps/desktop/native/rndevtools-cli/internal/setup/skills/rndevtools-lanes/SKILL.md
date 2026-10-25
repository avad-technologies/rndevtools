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
  "tap X on the device", "start the app for my worktree", "pick a free
  simulator", or "fix a Metro port collision". Never drive a Simulator with
  xcrun simctl boot/shutdown/openurl/install/launch/io, idb, or axe directly.
---

# RN Devtools lanes

> If an `rndevtools` MCP server is connected, its tools (`lane`, `simulators`,
> `capture`, `input`, …) are the same commands as the CLI below with the same
> arguments; prefer them, and read this skill for the workflow. The CLI remains
> the fallback when no MCP server is registered.

A **lane** is one git worktree running on one Simulator, served by one Metro on
a port the desktop leased for it. Lanes are how several branches, and the agents
working on them, run side by side without fighting over port 8081 or a shared
Simulator. The RN Devtools desktop app owns every lane; this CLI talks to it over
a private local socket.

## Prerequisites

- RN Devtools is running on this Mac (`rndevtools doctor` succeeds).
- The worktree is a **checkout root** (output of `git worktree list`), has its
  dependencies installed, and declares `expo.scheme` in `app.json`. Lanes read
  the scheme to deep-link the dev client; they never evaluate `app.config.js`.
- The Expo development client is **already installed** on the Simulator. Lanes
  never trigger a native build. If `rndevtools apps --udid <UDID>` does not list
  the app, build and install it once (`npx expo run:ios -d <UDID>`) and reuse it.

## Rules

- **One lane per worktree, one Simulator per lane.** Lane creation fails rather
  than stealing a worktree, a Simulator, or a port another lane holds. If
  `lane up` is refused, read the error: it names the owning lane. Do not work
  around it by killing processes.
- **Never pick ports by hand.** The desktop leases ports from the environment's
  range (`development` 8100–8199 by default). Do not start `expo start` or
  `react-native start` yourself inside a worktree that has a lane.
- **Never start Supabase by hand for a lane.** When the user has turned on
  local Supabase in RN Devtools and the worktree's `supabase/config.toml`
  sets `[experimental] stack = true`, `lane up` starts the worktree's own
  stack and hands Metro its URL and publishable key. Do not run
  `supabase start` or `stop` yourself, and never write keys into `.env`
  files. The `rndevtools-supabase` skill covers database work.
- **Always address Simulators by exact UDID.** Never use `booted`; with several
  Simulators running, `simctl` picks one at random. The UDID you get back from
  `lane up` is the one to pass to every later `rndevtools` call.
- **Stop only the lanes you started.** `lane down` stops the lane's Metro and
  frees the Simulator. It does not shut the Simulator down.
- **Attribution is automatic.** The CLI forwards `CLAUDE_CODE_SESSION_ID` or
  `CODEX_THREAD_ID` on every request, so each Simulator you touch is shown with
  your session in the desktop's Agents view for 30 minutes. Other agents can
  export `RNDEVTOOLS_AGENT_SESSION_ID`.
- **A Simulator is free or held.** It is held while a lane runs on it or a
  session has claimed it, and only the holder may boot it, send it input,
  install on it, slim it, or stop it. The desktop enforces this: `lane up`,
  `launch`, and `down`, `input`, `native --operation install`, slimming,
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

  A hold whose session has exited is released by the desktop after 10 minutes;
  the session-end hook that `rndevtools setup` installs releases it at once.
  Run `release --all` yourself when you finish, so nobody waits those minutes.
- **You may slim the devices you hold.** `rndevtools slimming --operation
  apply|undo|restore --udids <UDID>[,...] [--profile-id <id>]` applies a SimSlim
  profile, reverts the last managed change, or restores every managed service.
  It works only while the user has enabled SimSlim in RN Devtools, only on
  devices that are free or yours (`device_held` otherwise), and only on
  runtime/profile combinations SimSlim has verified or the user approved once;
  the error names which gate refused. Applying reboots the device, so prefer
  `lane up --slim` for the device a lane is about to use.

## Start a worktree on a Simulator

```bash
rndevtools doctor                                     # 1. desktop reachable?
rndevtools lane --operation ls                        # 2. see existing lanes and worktrees
rndevtools lane --operation up --worktree "$PWD"      # 3. RN Devtools picks a free Simulator
```

Leave `--udid` out unless the user named a device: the desktop picks a free
iPhone (nobody's lane, nobody's claim), booted ones first, so you never race
another session for it. To choose yourself, run `rndevtools simulators`, pick
a device with no hold, and pass `--udid <UDID>`.

When nothing is free the result has `completed: false`, no `lane`, and a
`deviceRequest` with its `id` and the reason; RN Devtools asks the user to
start your lane on an existing Simulator or a new clone (you cannot create
Simulators). Tell the user, then poll `rndevtools lane --operation ls` every
~10 s: the entry in `deviceRequests` with your `id` ends `fulfilled` with a
`laneId`, or `dismissed`. Do not retry `lane up` in a loop; a retry replaces
the request and resets the user's card.

`--worktree` is wherever you are working: a checkout root, or the app's
directory inside a monorepo checkout. The lane is keyed on the containing git
worktree and runs Metro from the directory you gave (`lane.appPath` when it
differs from `lane.worktreePath`). Two apps in one checkout can each have a
lane; one app cannot have two.

`lane up` boots the Simulator if needed, starts Metro on the leased port, waits
up to 15 s for `/status`, and deep-links the dev client with the SDK 57 launch
form (`<scheme>://expo-development-client/?url=http://127.0.0.1:<port>`). The
result includes `lane.id`, `lane.port`, `lane.simulatorUdid`, and `lane.metro`
(`starting` | `ready` | `stopped`). Pass `--launch=false` to lease and start
Metro without opening the app.

Running `lane up` again for the same worktree is safe: it returns the app's
existing lane (on whatever Simulator it has, when you omit `--udid`), restarts
Metro on the lane's port if it died, and relaunches. Naming a *different*
Simulator for an app that already has a lane, or a Simulator that carries
another app's lane, is a conflict; use `lane ls` to see which.

Add `--slim <profileId>` (ids come from `rndevtools slimming --operation
status`, e.g. `rndevtools-development`) to trim the Simulator's background
services before Metro starts. The desktop applies it in the lane's own
sequence (boot, slim, Metro, launch) when SimSlim is enabled in RN Devtools,
the device's runtime/profile combination is verified or approved, and the
device is free or yours. `lane.slim` in the result says `applied` (with the
SimSlim `jobId`), `skipped` with the reason (SimSlim is off, the build is
unsigned, the device is held by another session, the combination needs the
user's one-time approval), or `failed`. An unknown profile id fails the whole
`lane up` before anything boots. Slimming persists across reboots on iOS 26,
so a device slimmed once stays slim for every later lane.

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
`lane up` again, which is idempotent, as for `supabase up`.
Create your git branch before `lane up`: each branch gets its own database.

If the dev client is not installed on that Simulator, `lane up` fails with
`<bundle id> is not installed on this Simulator` and leaves Metro running.
**Do not reach for `expo run:ios` first.** Ask the desktop what the worktree
needs; it fingerprints the native inputs with the project's own Expo tooling
and checks the shared build cache, so ten worktrees of one native shell build
once:

```bash
rndevtools native --operation plan --worktree "$PWD" --udid <UDID>
```

The result carries `fingerprintHash`, `cache` (`hit` | `miss` | `no-provider`),
`installed`, and a one-line `recommendation` that starts with the verb to act
on:

| `recommendation` starts with | Do |
| --- | --- |
| `installed:` | Nothing; launch the lane. |
| `install:` | `rndevtools native --operation install --worktree "$PWD" --udid <UDID>` puts the cached binary on the Simulator in seconds. |
| `build:` | Run the quoted `npx expo run:ios … --no-bundler` once. The build cache stores the result for every other worktree with the same fingerprint. A first native build compiles CocoaPods and React Native and commonly takes 5–15 minutes; tell the user it is running rather than waiting silently, and do not restart it. If the user asked you not to build, report the exact command instead. |

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
rndevtools lane --operation launch --worktree "$PWD" --url checkout/cart   # deep link via the lane scheme
```

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

`lane down` ends one lane and frees its Simulator and port. `release --all`
ends every lane this session owns, drops its claims, and releases its local
Supabase stacks (they stop in the background, data kept); it is what the
session-end hook runs, so a clean exit releases everything even if you forget.

## Report

State the lane id, worktree and branch, Simulator name and UDID, environment,
Metro port and health, whether the Simulator was slim, and `lane.backend`'s
status when the worktree uses local Supabase. A healthy Metro or a
successful launch is not proof a feature works; include UI evidence from
`screen`, `elements`, or `capture`.

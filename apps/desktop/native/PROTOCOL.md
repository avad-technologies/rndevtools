# Native helper protocols

The simulator helper and native host are bounded one-request processes. Each
accepts no command-line arguments. The simulator helper reads at most 64 KiB
from standard input; the native host reads at most 96 KiB so its protocol-v4
broker envelope can contain one exact 64 KiB helper request. Each
emits exactly one newline-terminated JSON response to standard output, and
exits. Electron main closes stdin after writing. Unknown envelope and payload
fields are rejected.

```json
{
  "protocolVersion": 2,
  "requestId": "renderer-independent-operation-id",
  "operation": "handshake",
  "payload": {}
}
```

Success and failure use the same protocol version and request ID:

```json
{"protocolVersion":2,"requestId":"id","ok":true,"result":{}}
```

```json
{
  "protocolVersion": 2,
  "requestId": "id",
  "ok": false,
  "error": {
    "code": "stable_machine_code",
    "message": "Bounded user-facing summary.",
    "retryable": false,
    "details": {}
  }
}
```

`requestId` is restricted to 64 ASCII identifier characters. Exit status is
`0` for success, `1` for a recognized operation failure, and `2` for malformed
protocol input or unexpected arguments. Standard error is not protocol data.

## `rndevtools-sim-helper`

The helper resolves canonical simulator UDIDs from a fresh projection of the
default device set. It accepts no device-set path, launchd label, executable,
path, or command argument from the caller. Profile and doctor service IDs are
always resolved from the helper's pinned catalog.

Supported read-only operations:

- `handshake {}`
- `list_simulators {}`
- `disk_cleanup_plan { "simulatorId": "<canonical-UDID>" }`
- `list_profiles {}`
- `simulator_status { "simulatorId": "<canonical-UDID>" }`
- `preview_profile { "simulatorId": "<canonical-UDID>", "profileId": "<built-in-id>" }`
- `verify_profile { "simulatorId": "<canonical-UDID>", "profileId": "<built-in-id>" }`
- `doctor { "simulatorId": "<canonical-UDID>", "requiredCapabilities": ["storekit"] }`

The handshake result also reports `signingTeamIdentifier`, the actual team
pin linked into the helper's parent attestor. It is a ten-character Apple team
ID, or an empty string when no pin was compiled. This read-only operation
probes no Simulators and grants no mutation authorization. The desktop accepts
the field as optional for older helper responses; public release verification
requires it to match the app and helper signatures. Ship the rebuilt desktop
and helpers together, because older strict desktop decoders reject new fields.

Simulator clone preparation is a separate bounded operation:

- `clone_simulator { "simulatorId": "<canonical-UDID>", "name": "Test Clone" }`

The helper delegates this operation to the pinned SimSlim library. It preserves
the source's original boot state, captures only SimSlim-managed overrides,
repairs CoreSimulator's source-bound paths and registrations, audits the clone
for open source paths, and deletes a clone that cannot be proven independent.
Neither a device-set path nor raw `simctl` arguments cross the protocol. Clone
names are trimmed, limited to 128 Unicode scalar values, and reject control
characters. The result contains only the exact source UDID, new clone UDID, and
normalized name.

Disk cleanup is a separately confirmed, bounded mutation:

```json
{
  "simulatorId": "<canonical-UDID>",
  "categoryIds": ["caches", "logs"],
  "confirmation": "CLEAN_SIMULATOR_DISK"
}
```

- `disk_cleanup_plan` delegates read-only category and durable-storage
  measurement to the pinned SimSlim library. It returns the five fixed
  categories `caches`, `logs`, `temporary`, `linguistic-data`, and the
  measurement-only `required-siri-assets`, plus read-only `installed-apps`,
  `documents`, `app-data`, and `user-media` storage rows.
- `disk_cleanup` accepts one to four unique IDs from only the first four
  cleanable categories. It never accepts paths or arbitrary category names.
  Documents, app data, app bundles, user media, shared runtimes, and host
  directories cannot become deletion targets through the protocol.
- The pinned library resolves the canonical UDID through `simctl`, confines
  each allowlisted deletion to that device's real data directory, and restores
  the original booted state. A boot-state restoration failure is an operation
  failure, never success.
- Electron performs a fresh plan immediately before cleanup, binds its own
  short-lived confirmation token to the exact UDID/category action, and then
  supplies the helper's fixed `CLEAN_SIMULATOR_DISK` confirmation literal.

Canonical built-in profile IDs are `rndevtools-development`,
`rndevtools-ui-automation`, and `maximum-density`. The legacy IDs `ui-automation`
and `maximum-slimming` are accepted as input aliases but results use canonical
IDs. Custom and duplicated profiles remain Electron-owned data and never
cross the native boundary as arbitrary service lists.

`preview_profile.result.compatibility` has this exact shape:

```json
{
  "status": "verified | limited | unknown | blocked",
  "matrixVersion": "2026-09-03-v2",
  "tuple": {
    "macOSBuild": "25F80",
    "xcodeBuild": "17F113",
    "coreSimulatorBuild": "1051.55",
    "runtimeIdentifier": "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
    "runtimeBuild": "23F77",
    "hostArchitecture": "arm64 | x64",
    "helperVersion": "0.1.0",
    "helperBuildCommit": "40-hex-commit-or-dirty-aware-source-identity",
    "catalogVersion": "simslim-v0.12.2-6518ba7e-rndevtools.1-presets.3"
  },
  "verifiedOperations": []
}
```

`blocked` cannot be overridden. `limited` permits only operations named in
`verifiedOperations`. `unknown` requires `acknowledgement` to equal
`EXPERIMENTAL` on each mutation request. The acknowledgement is not a
compatibility claim; it records explicit use of an unverified tuple.

Doctor capability IDs are a closed enum:

- `push-notifications`
- `storekit`
- `universal-links`
- `icloud-sync`
- `healthkit`
- `homekit`
- `photo-library`
- `contacts`
- `calendar`
- `siri`
- `spotlight`
- `app-store`

`requiredCapabilities` contains 1–20 unique enum values. Doctor intentionally
has no `profileId`: it reports whether the requested capabilities are
available in the simulator's actual current managed state. Every array-valued
doctor result field is always a JSON array; an empty `blockedByServiceIds` is
encoded as `[]`, never omitted or encoded as `null`.

`verify_profile` accepts a booted or shutdown simulator. A shutdown target is
booted only for the bounded probe and is restored to shutdown with an
independent cleanup context before the helper responds. It succeeds with
`result.verified: false` for a conclusive mismatch. An ambiguous launchctl
probe is `verification_inconclusive`; it is never reported as verified.
Registration evidence comes from one bounded `user/501` snapshot and one
bounded `system` snapshot, with exact label parsing. The helper never launches
one subprocess per service or assumes user agents live in the system domain.

## Mutation operations

Mutation JSON is deliberately not authorization. The fixed confirmation
strings, `EXPERIMENTAL` acknowledgement, and checkpoint integrity binding are
additional safety layers, but a caller that invokes `rndevtools-sim-helper`
directly cannot use them to mutate a simulator.

Electron sends the exact helper request to the signed Swift native host over
protocol v4. The native host authenticates its live parent as the
production-signed desktop application signed by the native host's own Apple
Team ID, validates the exact helper-manifest bytes against that application's
resource seal, reads the helper SHA-256 and build commit from the validated
manifest, verifies the packaged sibling Go helper against the pinned designated
requirement, starts it suspended, binds the live process to the exact verified
CodeDirectory hash, and only then resumes it and sends input. The native host
pins no team of its own: the Go helper's build-time `APPLE_TEAM_ID` pin, which
it checks against the native host as described below, anchors the chain. A
15-second, random, one-shot authorization travels only on inherited file
descriptor 3. It binds the request ID, operation, canonical Simulator UDID,
SHA-256 of every exact helper-request byte (therefore the complete profile,
service delta/prepared checkpoint, tuple, target checkpoint, and cleanup or
clone payload), expiry, nonce, and broker PID.

The Go helper independently proves that its live parent PID and its own live
process satisfy pinned designated requirements. It reads each process's
kernel-attached CodeDirectory hash through `csops(2)` and binds that hash into a
static `codesign` requirement on the executable, because `codesign`'s `+pid`
form cannot evaluate an explicit requirement against a process on current
macOS. It compares the authorized UDID with the one the operation itself
decodes from the payload, where JSON field names match case-insensitively, so
keys that differ only by case cannot authorize one Simulator and act on
another. It also requires the authorization
to name its exact build commit, consumes the descriptor exactly once, watches
the broker parent for the operation lifetime, and rejects replay, mismatch,
expiry, downgrade, missing FD, parent death, or untrusted-parent cases before
constructing the simulator service. The native host likewise watches its live
Electron parent and uses cancellation-aware nonblocking writes. Unsigned
development execution and ad-hoc packages fail closed for real mutations;
direct read-only inspection remains available. Electron's sender-bound UI
confirmation and the compatibility/checkpoint checks described below remain
mandatory on top of this process boundary.

Both direct read-only execution and Swift-brokered mutation execution also
provide a private inherited control channel on FD 4, explicitly marked by
`RNDEVTOOLS_HELPER_CONTROL_FD=4`. Electron's direct runs pass a Unix socketpair
(Node's `'pipe'` stdio) and the broker passes a pipe. Closing or half-closing the
parent's end cancels the Go context and allows
independently bounded boot-state restoration or mutation rollback to finish;
the parent escalates only to SIGKILL after the operation-specific grace period.
Unmarked descriptors are never opened, and a marked descriptor that is neither a
pipe nor a socket is ignored. The helper intentionally does not use
`os/signal` while supervising Simulator child processes.

Every mutation uses a two-phase prepare/persist/commit contract. Preparation is
read-only and accepts one of these exact payloads:

```json
{
  "simulatorId": "<canonical-UDID>",
  "operation": "apply_profile",
  "profileId": "rndevtools-development",
  "checkpointToken": ""
}
```

- `prepare_mutation` for `restore_managed` requires empty `profileId` and
  `checkpointToken`.
- `prepare_mutation` for `undo_last` requires empty `profileId` and the prior
  durable restore-point `checkpointToken` that defines the desired state.
- Preparation returns the fresh exact tuple, original boot state, current and
  desired managed sets, delta, verification evidence, and a new
  `checkpointToken` bound to the operation, canonical profile/desired set,
  Simulator, tuple, current state, random preparation ID, and the unique
  executable basenames of to-disable launchd jobs observed running in the
  exact Simulator process tree during preparation. A shutdown target is
  temporarily booted for this inspection and independently restored before
  preparation responds.

Electron atomically persists that prepared token and the exact pending intent
under app data before sending any commit. A persistence failure stops before a
launchd transition. The matching commit payloads are:

- `apply_profile { "simulatorId", "profileId", "checkpointToken":
  "<prepared-token>", "confirmation": "APPLY_EXPERIMENTAL_PROFILE",
  "acknowledgement": "EXPERIMENTAL-or-empty" }`
- `restore_managed { "simulatorId", "checkpointToken":
  "<prepared-token>", "confirmation": "RESTORE_ALL_MANAGED_SERVICES",
  "acknowledgement": "EXPERIMENTAL-or-empty" }`
- `undo_last { "simulatorId", "preparedCheckpointToken":
  "<new-prepared-token>", "checkpointToken": "<durable-target-token>",
  "confirmation": "UNDO_EXPERIMENTAL_MUTATION", "acknowledgement":
  "EXPERIMENTAL-or-empty" }`

Acknowledgement is required only for `unknown` tuples, but confirmation is
required on every commit regardless of tuple status. Preparation does not
accept or create acknowledgement authority. Electron persists a typed
acknowledgement against the exact tuple key separately, rechecks the tuple from
preparation, and sends the commit acknowledgement only when that exact key is
still valid. Batch orchestration is Electron-owned, sequential, and capped
there; the helper processes exactly one simulator and operation.

At commit, the helper freshly resolves the target again and rejects a token if
the tuple, current state, original boot state, operation, profile, or desired
set differs. It proves the pre-existing override/launchd-registration state so
apply has a verified rollback baseline. Restore and checkpoint-bound undo are
the deliberate repair paths: a conclusive finding that an overridden job is
still registered may proceed toward the restore target, while an ambiguous
probe still fails closed. It applies only the computed delta, reboots only when
needed, verifies the exact managed override set, and requires every
desired-disabled launchd job registration to be absent. Immediately before the
transition it rebinds every currently running to-disable label's single PID and
program to a unique basename in the exact-UDID process tree. Those fresh
commit-time roots, rather than the earlier preparation snapshot, must all be
absent after the reboot. Missing, duplicated, or ambiguous PID/program/tree
mappings fail before mutation. This proof is deliberately scoped to managed
jobs observed running at commit; jobs already not running are covered by the
independent launchd-registration absence proof. Every successful commit,
undo included, ends in the boot state the Simulator had when that commit
started: undo returns the managed services to the target checkpoint, not to the
boot state recorded with it.

The helper also proves that both the checkpoint and requested target can be
represented by SimSlim's public profile API before mutation. A pre-existing
upstream restore-only label is visible in read-only status, but blocks mutation
with `checkpoint_not_representable`; this avoids starting work that could not
reproduce the exact checkpoint after a partial failure.

On failure after mutation begins, the helper independently boots if necessary,
reads the observed partial state, restores only its delta back to the prepared
state, reboots if needed, verifies the prior overrides and launchd-registration
absence, and
restores the pre-operation boot state. `mutation_failed_rolled_back` means that
rollback was proven. `mutation_failed_needs_attention` means it was not; the
helper never reports mutation success in that case.

Mutation success and both mutation failure codes expose the same evidence
shape (`error.details` on failure):

```json
{
  "operation": "apply_profile | restore_managed | undo_last",
  "profileId": "rndevtools-development",
  "failureCode": "verification_failed",
  "changed": true,
  "checkpointToken": "opaque-token",
  "compatibility": {},
  "originalBootState": "Booted | Shutdown",
  "finalBootState": "Booted | Shutdown | Unknown",
  "temporarilyBooted": false,
  "rebooted": true,
  "before": {"managedDisabledServiceIds": [], "count": 0},
  "desired": {"managedDisabledServiceIds": [], "count": 0},
  "plan": {"toDisableServiceIds": [], "toEnableServiceIds": []},
  "after": {"managedDisabledServiceIds": [], "count": 0},
  "verification": {
    "verified": true,
    "currentManagedDisabledServiceIds": [],
    "desiredManagedDisabledServiceIds": [],
    "overridesMatch": true,
    "missingDisabledServiceIds": [],
    "unexpectedDisabledServiceIds": [],
    "disabledLaunchdJobRegistrationsAbsent": true,
    "checkedDisabledLaunchdJobRegistrationCount": 0,
    "registeredDisabledLaunchdJobIds": [],
    "observedPreMutationProcessesAbsent": true,
    "checkedObservedProcessNames": [],
    "presentObservedProcessNames": []
  },
  "rollback": {
    "attempted": false,
    "succeeded": false,
    "rebooted": false,
    "before": {},
    "after": {},
    "verification": {},
    "errorCode": ""
  }
}
```

`profileId` is present only for apply. `failureCode` is present only on a
failed mutation. Optional rollback evidence objects and `errorCode` are present
only when applicable; the three rollback booleans are always present.

`checkpointToken` is at most 32,768 UTF-8 bytes. It is a canonical,
integrity-checked opaque encoding of the exact prior allowlisted set, original
boot state, Simulator ID, tuple, catalog/fork identities, matrix version, the
exact intended operation/profile/desired set, a random preparation ID, and
bounded preparation-time executable basenames. It
contains no filesystem path, raw command line, or process environment and is
an integrity binding, not an authorization credential. Commit-time process
evidence is freshly captured and may differ after an intentional shutdown/boot
boundary. Electron main stores
it atomically with mode `0600`, never parses, logs, or exposes it to the
renderer. Main owns the single pending-token lifecycle and does not replay a
completed token.

If Electron or the helper exits after pending intent is persisted, startup
reconciliation temporarily boots a shutdown target if required, inspects the
fresh managed and launchd-registration state, and restores the original boot
state. Exact verified pre-state clears the pending record without replacing an
older undo point. Exact verified intended state promotes the prepared pre-state
token to the last-successful-change restore point. Any partial, ambiguous, or
unverified state retains a private emergency token, blocks other mutations,
and exposes checkpoint-bound Undo recovery. No-op and proven-rolled-back
attempts never replace the prior successful restore point. After startup,
reconciliation inspects a retained record only while its target is booted and
no other mutation holds the target, less often each time the state stays
ambiguous. When Undo can no longer use the emergency token, for example after
the tuple changed, the operator may forget it after a main-owned confirmation,
which clears that pending record and nothing else.

Closing the FD 4 control channel requests graceful cancellation; the helper
installs no signal handler, so a signal ends it without cleanup. A mutation failure
then enters an independent bounded rollback/boot-restoration context before
responding. Electron's operation-specific timeout and forced-kill grace always
reserve that cleanup budget; ungraceful termination is not routine
cancellation.

## `rndevtools-native-host`

Protocol v1 remains byte-shape compatible with the initial Electron client and
supports:

- `handshake {}`
- `permission_status {}`

Permission status is read-only and never causes a system prompt. The initial
projection covers accessibility, screen recording, camera, and microphone.

Protocol v2 supports those operations plus `capability_status {}`. Every
payload must be exactly an empty object. A v1 request for `capability_status`
fails with `unsupported_operation`. Successful v2 responses are limited to
256 KiB and use the request's protocol version and request ID.

The v2 handshake advertises `capabilityInspection: true` and
`liveCaptureSessions: false`. `capability_status` returns:

- the check timestamp, compiled architecture, and macOS version;
- ScreenCaptureKit framework and screen-recording status, live-window,
  system-audio, and microphone gates, and requestable 30/60/120 FPS values;
- AVFoundation camera/microphone authorization, device presence, and gates;
- VideoToolbox H.264/HEVC hardware encode/decode probes at 1920x1080 and the
  realtime expected-frame-rate values accepted by each compression session;
- Accessibility trust and the resulting element-inspection gate;
- the current FSEvents event ID plus path-scoping and protected-path gates for
  future Build Insights;
- Network Extension API and entitlement presence, while configuration and
  interception remain policy-gated; and
- explicit safety evidence that no permission prompt, content enumeration,
  persistent session, network preference read, or external mutation occurred.

Availability values are the closed enum `available | gated | unavailable`.
`gated` means that the compiled API exists but a permission, entitlement, or
product policy prevents use. `unavailable` means that the required framework or
device is absent. Authorization uses the closed values `granted`, `denied`,
`restricted`, `not_determined`, `not_granted`, and `unknown`.

The VideoToolbox probe creates and immediately invalidates hardware-required
compression sessions and encodes zero frames. Accepted FPS values prove only
that VideoToolbox accepted a realtime configuration; they are not a throughput
benchmark or a sustained-FPS claim.

`capability_status` never calls ScreenCaptureKit content enumeration or a
content picker, never requests camera/microphone/screen/Accessibility access,
never reads Network Extension preferences, never scans source roots, and never
launches Xcode processes. Live capture is not exposed because a bounded
one-request helper cannot safely own a start/stop session or guarantee cleanup
after its process exits. A future capture implementation requires a supervised
long-lived process, explicit simulator-window selection, bounded frame
transport, cancellation, and crash cleanup.

### Protocol v3 image composition

Protocol v3 preserves every v1/v2 operation and adds `compose_image`. Electron main creates
a random 32-lowercase-hex workspace token under the fixed app-data Capture Design Studio
root, stages one or two current-user-owned regular image files into its private `inputs`
directory, and reserves a non-existing leaf in `outputs`. The request contains only that
token, ASCII leaf names, the output format, and a strictly decoded composition recipe.

Recipes support a bounded pixel canvas or aspect canvas, transparent/solid/linear-gradient
backgrounds, explicit padding, fit/fill, 0/90/180/270-degree rotation, corner radius,
The generic bezel, bounded shadow, optional bounded ASCII metadata, and side-by-side,
opacity, or deterministic absolute-RGB difference comparisons. A secondary image is
required only for comparison modes. Transparent JPEG is rejected.

Each input is capped at 32 MiB, dimensions at 8192 per side, each decoded input at 40
megapixels, aggregate decoded pixels at 64 megapixels, and output at 64 MiB. Every
workspace component and file must be non-symlink, current-user-owned, and contained under
the helper-owned root. Encoding commits through a private sibling temporary file and a
no-overwrite hard link. Cancellation and every failure remove the temporary output. The
response reports only dimensions, byte count, format, composition mode, and treatment
flags—never paths or the workspace token.

### Protocol v4 simulator mutation broker

Protocol v4 preserves the earlier native-host operations and adds only
`run_simulator_mutation { "helperRequest": "<exact protocol-v2 JSON>" }`.
The nested request must be one of `clone_simulator`, `disk_cleanup`,
`apply_profile`, `restore_managed`, or `undo_last`; all read-only simulator
operations continue to invoke the Go helper directly. The response contains
the bounded exact Go-helper response string. The native host never accepts a
helper path, authorization token, signing identity, executable, argument
vector, expiry, or nonce from Electron. Cancellation terminates the isolated
helper process group and reserves the existing operation-specific rollback
grace before Electron's outer forced-kill deadline.

### Protocol v5 simulator input

Protocol v5 preserves every earlier native-host operation and adds
`send_simulator_input`, which drives a booted Simulator over the same HID path
Simulator.app uses for the mouse and keyboard. The guest cannot tell these
events from a user's, so they work on Springboard, system alerts, and the
login screen, not only inside a connected development app. Nothing on disk is
mutated, so the operation is available in unsigned builds.

The payload is one gesture, addressed by exact UDID. Coordinates are ratios of
the device screen (`0…1` from the top-left) so any screenshot size converts
without knowing the device geometry:

| `kind` | Fields | Delivered as |
| --- | --- | --- |
| `tap` | `x`, `y`, `holdMilliseconds` (default 40; 500+ is a long press) | digitizer down, hold, up |
| `swipe` | `fromX`, `fromY`, `toX`, `toY`, `durationMilliseconds` (default 250), `steps` (default 16, max 120) | down, interpolated moves, up |
| `text` | `text` (printable ASCII plus `\n` and `\t`, max 2048) | one key down/up per character, shift held for upper case and symbols |
| `key` | `usage` (USB HID keyboard usage 0x04…0xE7, e.g. 0x28 Return, 0x2A Delete, 0x29 Escape), `modifiers` (`shift`, `control`, `option`, `command`) | modifiers down, key down/up, modifiers up |
| `button` | `button`: `home`, `lock`, `siri`, `volume-up`, `volume-down`, `apple-pay` | hardware button down/up |

Text is typed, never pasted: iOS 16+ gates the pasteboard behind an
"Allow Paste" prompt that blocks unattended use.

The result reports `messages` (HID messages the Simulator acknowledged) and
`elapsedMilliseconds`. Errors: `invalid_payload` for anything outside the
table; `simulator_not_found` and `simulator_not_booted` from the live
CoreSimulator inventory; `simulator_input_unavailable` when this Xcode does
not expose the SimulatorKit symbols the host resolves at run time (the host
links no private framework, it `dlopen`s CoreSimulator and SimulatorKit from
the active developer directory and resolves `SimServiceContext`,
`SimDeviceLegacyHIDClient`, and the `IndigoHIDMessageFor*` builders by name);
`simulator_input_failed` when a message is refused or unacknowledged within 5 s.
A gesture that is cancelled or fails part-way first lifts whatever it still
holds (the finger, keys and modifiers, or a button) before the host reports the
error, so a shared Simulator is not left with input held down. Holds wake on
cancellation, so the lifts go out before Electron's forced kill.

The result also names the `transport` that carried the events. Two exist, and
the host picks one from the CoreSimulator version actually loaded in process
(the system framework's `CFBundleVersion`, not the Xcode the request named,
because that framework is what talks to the guest):

| CoreSimulator | Transport | Path |
| --- | --- | --- |
| < 1155.4 (Xcode 26 and earlier) | `indigo` | SimulatorKit's `SimDeviceLegacyHIDClient`. Buttons and keys come from the framework's `IndigoHIDMessageFor*` builders; a single touch is the documented 320-byte Indigo envelope (`eventType` 2) around the multi-touch builder's digitizer contact, repeated once as the second payload. Every message is acknowledged individually. |
| ≥ 1155.4 (Xcode 27) | `dtuhid` | Apple injects `dtuhidd` into the guest and the legacy client stops delivering touches. The host looks the device's `com.apple.coredevice.feature.remote.hid.digitizer` service up in the Simulator's bootstrap namespace (`-[SimDevice lookup:error:]`), wraps the port with libxpc's `xpc_endpoint_create_mach_port_4sim`, marks the connection simulator-to-host with `xpc_connection_enable_sim2host_4sim` (without it the daemon sees the peer but no payload), and sends plain-XPC dictionaries: `{messageType, isBarrier, featureIdentifier, payload}` with `IndigoDigitizerEvent {pointOne{x,y}, eventType 0 start/1 position/2 end, edge, target}`, `IndigoKeyboardButtonEvent {usageCode, state 1 down/2 up}`, and `IndigoButtonEvent {usagePage 0x0C, usageCode, state}` (home 0x40, lock 0x30, Siri 0xCF, volume 0xE9/0xEA; Apple Pay is a double side press and has no usage). `dtuhidd` is demand-launched, so the host first sends a barrier-flagged no-op key-up, which the daemon answers, and retries up to five times four seconds apart before reporting `simulator_input_failed`. |

Both transports deliver the same gesture sequence (`SimulatorInputSequencer`),
so a tap, swipe, or typed string behaves identically on either Xcode. The
environment variable `RNDEVTOOLS_SIMULATOR_INPUT_TRANSPORT=indigo|dtuhid`
overrides the selection for diagnosis.

Verification status: `indigo` is verified live on Xcode 26.6 (CoreSimulator
1051.55). `dtuhid` is built from idb's published transport and verified as far
as this toolchain allows: the service lookup reaches the guest, which reports
that it does not vend the digitizer service on CoreSimulator 1051. To verify on
Xcode 27, boot a device and run `rndevtools input --udid <UDID> --kind tap
--x 0.39 --y 0.92` (Safari's icon on a default home screen); the result must
say `"transport": "dtuhid"` and Safari must open. If `dtuhidd` answers the
probe but nothing lands, the payload shape is the suspect, not the connection.

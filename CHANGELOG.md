# Changelog

## 0.2.0 (unreleased)

### `@rndevtools/core`, `@rndevtools/react-native`

- **Breaking:** the image overlay no longer reads
  `EXPO_PUBLIC_IMAGE_OVERLAY_ORIGIN` or `EXPO_PUBLIC_SUPABASE_URL`. Pass the
  hosts it may download from to `configureImageOverlay({ allowedRemoteHosts })`
  instead; with none, remote images are refused.
- **Breaking:** the storage adapters' default ids are now `async-storage` and
  `secure-store`, not `example-async-storage` and `example-secure-store`.
  `createAsyncStorageDevtoolsAdapter` and `createSecureStoreDevtoolsAdapter`
  take `{ id, title, description }` options; pass `id` to keep an old one.
- **Breaking:** `withDevtoolsPruning` matches imports by the file they resolve
  to, so the alias, the relative path `babel-plugin-module-resolver` rewrites
  it to, an explicit extension and an `/index` import all get the stub.
  Previously an app using that plugin kept devtools reachable in release
  bundles. A `path` or stub that names no file, or an alias entry without
  `path`, now fails the config load, so configs that relied on alias-only
  matching must add `path`.
- **Breaking:** `withDevtoolsPruning` prunes every release bundle, meaning
  every bundle Metro builds with `dev: false`, by default. It reads Metro's own
  `dev` flag rather than an app variable, so a release build that never sets
  one, such as `expo run:ios --configuration Release` or an EAS profile
  without it, no longer ships devtools. `enabled: false` no longer turns
  pruning off, `enabled: true` still prunes development bundles too, and
  `keepInReleaseBundles: true` is the only way to keep devtools in a release
  bundle. Both options must be booleans, and `projectRoot` and `replace` are
  validated on every config load, development included.
- While pruning, an import that resolves into an `@rndevtools/*` package
  without going through a `replace` entry fails the build, naming the import
  and the module that made it, instead of adding the package to the bundle.
- **Breaking:** `verifyPrunedBundle(root, markers)` checks `markers` in
  addition to the default markers instead of replacing them, so a caller that
  passed its own shorter list now also fails on any default marker.
- Support Expo SDK 56 / React Native 0.85 hosts alongside SDK 57 / 0.86.
  Peer ranges are now `expo >=56 <58`, `react-native >=0.85 <0.87`,
  `react-native-worklets >=0.8 <1`, and `@expo/ui >=56 <58`.
- `@rndevtools/react-native/build-cache` is an Expo build cache provider that
  shares native builds between git worktrees, keyed by Expo's native
  fingerprint and the host toolchain (CPU architecture and, for iOS, the Xcode
  version). It claims its lock atomically, lets only one waiter take over an
  abandoned lock, and never replaces a stored binary with a later upload.
- `simulatorUdidFromPath` reads the Simulator's UDID from a path inside the
  app's container, so a host can report `simulatorUdid` and the desktop can
  link the session to its Simulator and lane. It returns `undefined` outside
  an iOS Simulator.
- The desktop client runs only the actions the device advertises, addressed to
  its own `deviceId`. It paces its frames under the broker's limit, trims a
  collection over the desktop's row limit to its newest rows, and backs off
  after repeated broker policy closes. A new `actionTimeoutMs` option bounds
  each host action, and `runAction` receives an `AbortSignal` that aborts when
  the client stops waiting.
- While an owner source is bound, an authorization grant applies only when it
  names that source's live owner. A source that cannot be subscribed to
  revokes authorization and refuses grants until a working one is bound.
- `rndevtools-verify-bundle` fails when it finds no bundle file, instead of
  passing an empty or mistyped directory. It also scans `.bundle`,
  `.jsbundle`, `.mjs` and `.cjs` files, accepts a single bundle file, and
  prints how many files it checked.
- The verifier's default markers now detect the desktop client
  (`@rndevtools/react-native/desktop`), `@rndevtools/react-native/authorization`,
  `@rndevtools/react-native/adapters/storage`, the desktop protocol, the images
  panel, the image overlay, and `@rndevtools/core/redact`, `/serialize` and
  `/plugins/network-presentation` in production bundles.
  `@rndevtools/core/format` is not detected when imported alone: its formatters
  hold no string specific enough to look for.
- New `@rndevtools/core/plugins/image-overlay` entry point (the plugins barrel
  still re-exports it). `@rndevtools/react-native`'s image overlay, and so its
  package root, no longer loads the core plugins barrel.
- `setDevtoolsAuthorization` called with `undefined` or `null` now revokes
  before it throws a `TypeError`; it used to throw and leave the previous grant
  in force.
- `createAsyncStorageDevtoolsAdapter` and `createSecureStoreDevtoolsAdapter`
  throw a `TypeError` when given no store, instead of returning an adapter
  whose every read fails.
- `rndevtools-verify-bundle --forbid-loopback-urls` and
  `--preset supabase-local` fail a release bundle that still carries a
  loopback URL or a local Supabase key.
- `rndevtools-verify-bundle` runs when invoked through a package manager's
  `node_modules/.bin` symlink, including under `--preserve-symlinks-main`.
  Previously the main-module guard never matched and the command exited 0
  without scanning.
- The storage plugin redacts a value stored under a key whose name marks it
  sensitive (`refreshToken`, `session`, `email`…) as `[REDACTED]`; set
  `revealValues: true` on the adapter to show such values.
- Diagnostic redaction masks Supabase `sb_secret_` keys, passwords in
  connection URLs and compound secret names such as `SERVICE_ROLE_KEY`.
- Diagnostic sanitization summarizes typed arrays and DataViews as
  `{ type, byteLength }` instead of index-keyed objects, and reads only the
  entries it keeps, of a Map or a Set too. Of an error it reads only `name`,
  `message` and `stack`, and a String object counts as its text, where it
  listed a key per index. A symbol's description is redacted.
- Diagnostic sanitization hides the value of a Map entry whose key is a
  credential name, as it hides the value of such an object field; 0.1.x kept
  `new Map([['password', 'hunter2']])` in clear.
- Diagnostic sanitization bounds its work. It charges one projection for
  every value it visits, holes, accessors and values without text such as
  `undefined` included, for every key it lists, for every code unit it tests
  or redacts, and for every code unit of a key it copies again. Once 4 Mi code
  units are charged, each later string, object, symbol or bigint is stored as
  `[Value omitted: input limit]`, and each later key longer than 1 Ki code
  units as `[Key omitted: input limit]`. A string longer than 1 MiB and
  64 KiB is redacted through a bounded window, at most 2.32 Mi code units,
  and cut to that size, and a bigint of more than 1,024 digits is omitted
  instead of converted. 0.1.x visited an object that many paths share once
  per path, and redacted every string and converted every bigint whole, so
  its work grew with the value without limit. Listing the keys of one object
  still costs time in proportion to its size.
- `diagnosticErrorText` redacts the text of a thrown value through the same
  bounded window and keeps up to 1 MiB and 64 KiB of it, and gives
  `[Value omitted: input limit]` for a bigint of more than 1,024 digits.
  0.1.x redacted the whole text and converted every bigint, so its work grew
  with the value without limit.
- Diagnostic sanitization and the Console plugin redact the keys of a logged
  object with the rules they apply to its values, through the same bounded
  window, and cut them to 1 KiB. 0.1.x stored keys verbatim, so a map keyed by
  email addresses or connection URLs kept them in clear. Keys that redaction
  or the cut makes equal are numbered, as `[REDACTED EMAIL]` and
  `(2) [REDACTED EMAIL]`; the number leads, so that a second redaction does
  not read it as the value of a key that ends in `token:`. Whether a value is
  hidden still depends on its key as logged, so such a map keeps its values;
  a key longer than 64 Ki code units hides its value.
- `DevtoolsEventStore` normalizes the attributes of an event the same way. It
  keeps the first 64 attributes in the order it lists them, stores them in key
  order, and reads only their descriptors, where 0.1.x read every descriptor
  and sorted every key to keep the 64 that sorted first. It redacts each key
  through the bounded window and cuts it to 512 bytes, numbers keys that
  trimming, redaction or the cut makes equal, which 0.1.x dropped, and tests
  whether a value is hidden on its key as logged, where 0.1.x tested the
  redacted key and so hid the value of an attribute keyed by an email
  address. A key numbered without being redacted, as when trimming makes two
  keys equal, marks the event truncated, as dropping it did. Every text of an
  event is redacted through a bounded window, and the attributes of one event
  share a work budget of 2 Mi code units, after which strings are stored as
  `[Value omitted: input limit]` and keys longer than 512 code units as
  `[Key omitted: input limit]`.
- Email and JWT redaction run in linear time; on a long base64url or dotted
  run they took time quadratic in its length.
- Diagnostic redaction masks a quoted credential that ends right after a
  backslash or holds a backslash before a line break; both used to stay in
  clear.
- Diagnostic redaction matches a quoted value in steps of at most 1,024
  escapes, so its regexp stack stays bounded however long the value is;
  0.1.x threw a `RangeError` on a quoted value of 8 Mi code units.
- Redacting redacted text changes nothing: a value that is only a marker, an
  ellipsis that a cut appended, or both, is left as it is. So the `…` with
  which the Console plugin's windows end an attribute survives the
  serializer's second redaction, where `token=[REDACTED]…` became
  `token=[REDACTED]`. A `Bearer` value in an assignment is redacted as far as
  any other value; its tail after the token's characters used to be kept.
- Diagnostic redaction masks the password of a URL whose user is an email
  address, and a URL password that only starts like a marker, such as
  `[REDACTEDhunter2` or `[REDACTED]@hunter2` before the address; only a
  password that is exactly a marker is left as it is.
- Diagnostic redaction masks the credentials after any scheme word of an
  `Authorization` value in free text. They are one token with its `=`
  padding, as in `authorization: Basic …` or `Authorization: Token …`, or a
  list of parameters that runs to the end of the line, as Digest's and
  AWS4-HMAC-SHA256's do, when a comma, an `&` or the end of the line follows
  the value of a first `name=value`, after any spaces or tabs. That value is
  a token that starts with an ASCII letter, a digit or one of `_+/%.~-` and
  holds no white space, comma, `&`, `"` or `'`, a quoted string, raw or
  JSON-escaped, that holds at most 1,024 escapes, or a raw one that ends at
  its first quote, whatever backslashes it holds; after a JSON-escaped one,
  the quote that closes the JSON string ends the line too. 0.1.x masked only
  the scheme word of any scheme but `Bearer`, so the base64 of
  `user:password` stayed in clear.
- The Console plugin redacts a bounded window of each message, stack and
  attribute string instead of the whole value, so a multi-megabyte log no
  longer drops its event, and each text of an event outside its attributes
  costs at most 1.9 Mi code units of redaction however long it is, where
  0.1.x redacted every text whole. A secret of up to 64 Ki code units that a
  window edge cuts is never stored unredacted. A longer secret that both
  edges of a window pair cut can be stored in part, where 0.1.x redacted it.
  When redaction shortens the text so much that the largest window cannot
  fill the field's byte limit, the stored text stops early and is marked
  truncated.
- The attributes of one console event share a work budget of 2 Mi code
  units, charged for every value, hole and accessor read, values without text
  such as `undefined` included, for every key listed, for every code unit of
  a string or key tested or redacted, and for every code unit of a key copied
  again. Strings and objects past it are stored as
  `[Value omitted: input limit]`, and keys longer than 1 Ki code units past
  it as `[Key omitted: input limit]`. An object of more than 100 keys or an
  array of more than 50 entries now marks the attributes truncated; 0.1.x
  left the entries past those caps out silently. A long quoted attribute,
  nested or passed as the attributes, no longer drops the event. The plugin
  reads a String object as its text, and only the fields of an event, error
  and source location that it uses, where it read every descriptor.
- `createConsoleMethodSource` prints, but does not capture, a log made while
  one of its listeners is handling a log, instead of recursing until the
  stack overflows.

### Desktop app

- Restyled every panel and the shell to a Vercel/Supabase-inspired system:
  one brand accent for active/positive states, blue reserved for information,
  hairline borders, dense typography.
- Disabled actions now explain why (missing device capability, invalid input).
- Playwright end-to-end harness and per-panel specs against the demo device.

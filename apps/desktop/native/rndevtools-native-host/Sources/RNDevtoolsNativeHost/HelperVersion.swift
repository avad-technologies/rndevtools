// Generated from apps/desktop/package.json by scripts/native-host-version.mjs. Do not edit.
// To update it after changing the desktop version, run:
//   pnpm --filter @rndevtools/desktop native:sync-version
extension NativeHost {
  /// The desktop version this host is built for. Electron trusts the host only when its
  /// handshake reports the version recorded in the verified native manifest.
  static let helperVersion = "0.2.0"
}

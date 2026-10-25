import CryptoKit
import Darwin
import Foundation
import Security

private let simulatorHelperProtocolVersion = 2
private let maximumHelperRequestBytes = 64 * 1024
private let maximumAuthorizationBytes = 4 * 1024
private let maximumHelperResponseBytes = 4 * 1024 * 1024
private let authorizationLifetimeMilliseconds: Int64 = 15_000
private let authorizationFD: Int32 = 3
private let controlFD: Int32 = 4
private let controlFDEnvironment = "RNDEVTOOLS_HELPER_CONTROL_FD"
private let expectedApplicationIdentifier = "io.github.adalloul0928.rndevtools"
private let expectedNativeHostIdentifier = "rndevtools-native-host"
private let expectedSimulatorHelperIdentifier = "rndevtools-sim-helper"
private let teamIdentifierPattern = "^[A-Z0-9]{10}$"
private let maximumNativeManifestBytes = 64 * 1024
private let maximumSimulatorHelperBytes = 64 * 1024 * 1024

struct MutationBrokerResult: Encodable {
  let helperResponse: String
}

struct BrokerParentIdentity: Equatable {
  let processID: pid_t
  let nativeResourceDirectory: URL
  let simulatorHelperSHA256: String
  let buildCommit: String
}

struct VerifiedSimulatorHelperIdentity: Equatable {
  let codeDirectoryHash: Data
}

protocol BrokerParentAttesting {
  func attest() throws -> BrokerParentIdentity
}

protocol SimulatorHelperVerifying {
  func verify(_ executableURL: URL, expectedSHA256: String) throws
    -> VerifiedSimulatorHelperIdentity
}

protocol SpawnedSimulatorHelperVerifying {
  func verify(
    processID: pid_t,
    identity: VerifiedSimulatorHelperIdentity
  ) throws
}

protocol SimulatorMutationProcessRunning {
  func run(
    executableURL: URL,
    identity: VerifiedSimulatorHelperIdentity,
    brokerParentPID: pid_t,
    request: Data,
    authorization: Data,
    terminationGraceSeconds: TimeInterval,
    cancellation: any CancellationChecking
  ) throws -> Data
}

protocol SimulatorMutationBrokering {
  func isAvailable() -> Bool
  func run(
    helperRequest: String,
    cancellation: any CancellationChecking
  ) throws -> MutationBrokerResult
}

private struct TrustedNativeResources {
  let directory: URL
  let simulatorHelperSHA256: String
  let nativeHostSHA256: String
  let buildCommit: String
}

private struct NativeResourceManifest: Decodable {
  struct Helpers: Decodable {
    struct Entry: Decodable {
      let name: String
      let file: String
      let sha256: String
    }

    let simulator: Entry
    let nativeHost: Entry
  }

  let schemaVersion: Int
  let platform: String
  let buildCommit: String
  let helpers: Helpers
}

private struct RegularFileIdentity: Equatable {
  let device: UInt64
  let inode: UInt64
  let size: Int
  let modifiedSeconds: Int
  let modifiedNanoseconds: Int
}

private func regularFileIdentity(
  _ url: URL,
  maximumBytes: Int,
  failure: String
) throws -> RegularFileIdentity {
  var metadata = stat()
  let status = url.path.withCString { Darwin.lstat($0, &metadata) }
  guard status == 0, (metadata.st_mode & S_IFMT) == S_IFREG,
    metadata.st_size > 0, metadata.st_size <= maximumBytes
  else {
    throw brokerError(failure)
  }
  return RegularFileIdentity(
    device: UInt64(metadata.st_dev),
    inode: UInt64(metadata.st_ino),
    size: Int(metadata.st_size),
    modifiedSeconds: Int(metadata.st_mtimespec.tv_sec),
    modifiedNanoseconds: Int(metadata.st_mtimespec.tv_nsec)
  )
}

private func signingInformation(for staticCode: SecStaticCode) throws -> [String: Any] {
  var signingInformation: CFDictionary?
  guard
    SecCodeCopySigningInformation(
      staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &signingInformation)
      == errSecSuccess,
    let information = signingInformation as? [String: Any]
  else {
    throw brokerError("A required code-signing identity could not be read.")
  }
  return information
}

private func signingInformation(for liveCode: SecCode) throws -> [String: Any] {
  // Apple's C API explicitly accepts either SecCodeRef or SecStaticCodeRef here,
  // although Swift imports the common parameter as SecStaticCode. Preserve the
  // dynamic guest object so its kernel-attached identity is not re-resolved via
  // a mutable filesystem path.
  let polymorphicCode = unsafeBitCast(liveCode, to: SecStaticCode.self)
  return try signingInformation(for: polymorphicCode)
}

private func codeDirectoryHash(from information: [String: Any]) throws -> Data {
  guard let value = information[kSecCodeInfoUnique as String] as? Data, !value.isEmpty else {
    throw brokerError("A required live CodeDirectory identity is unavailable.")
  }
  return value
}

/// The broker requires the Electron parent and the Go helper to carry the team that signed
/// this native host, so it pins no team of its own and cannot drift from the build: the Go
/// helper's `APPLE_TEAM_ID` pin, checked against this host's live signature, stays the single
/// source of truth. An unsigned or ad-hoc host has no team and brokers no mutation.
func signingTeamIdentifier(from information: [String: Any]) throws -> String {
  guard let teamIdentifier = information[kSecCodeInfoTeamIdentifier as String] as? String,
    teamIdentifier.range(of: teamIdentifierPattern, options: .regularExpression) != nil
  else {
    throw brokerError("The native host is not signed by an Apple Developer team.")
  }
  return teamIdentifier
}

private func nativeHostSigningTeamIdentifier() throws -> String {
  var liveCode: SecCode?
  guard SecCodeCopySelf([], &liveCode) == errSecSuccess, let liveCode else {
    throw brokerError("The running native host code identity could not be inspected.")
  }
  return try signingTeamIdentifier(from: signingInformation(for: liveCode))
}

func designatedRequirement(
  identifier: String,
  teamIdentifier: String,
  codeDirectoryHash: Data? = nil
) throws -> SecRequirement {
  guard
    identifier == expectedApplicationIdentifier || identifier == expectedNativeHostIdentifier
      || identifier == expectedSimulatorHelperIdentifier
  else {
    throw brokerError("An unexpected code identifier cannot become a trust requirement.")
  }
  guard teamIdentifier.range(of: teamIdentifierPattern, options: .regularExpression) != nil else {
    throw brokerError("An invalid signing team cannot become a trust requirement.")
  }
  var text =
    "anchor apple generic and identifier \"\(identifier)\" and certificate leaf[subject.OU] = \"\(teamIdentifier)\""
  if let codeDirectoryHash {
    guard codeDirectoryHash.count == 20 else {
      throw brokerError("A CodeDirectory trust requirement must use the canonical 20-byte hash.")
    }
    let hash = codeDirectoryHash.map { String(format: "%02x", $0) }.joined()
    text += " and cdhash H\"\(hash)\""
  }
  var requirement: SecRequirement?
  guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess,
    let requirement
  else {
    throw brokerError("A pinned code-signing requirement could not be created.")
  }
  return requirement
}

private func trustedNativeResources(
  mainExecutableURL: URL,
  parentStaticCode: SecStaticCode
) throws -> TrustedNativeResources {
  let executableURL = mainExecutableURL.resolvingSymlinksInPath()
  let macOSDirectory = executableURL.deletingLastPathComponent()
  let contentsDirectory = macOSDirectory.deletingLastPathComponent()
  let applicationDirectory = contentsDirectory.deletingLastPathComponent()
  guard macOSDirectory.lastPathComponent == "MacOS",
    contentsDirectory.lastPathComponent == "Contents",
    applicationDirectory.pathExtension == "app"
  else {
    throw brokerError("The authenticated desktop parent is not inside an application bundle.")
  }
  let nativeDirectory = contentsDirectory.appendingPathComponent(
    "Resources/native", isDirectory: true)
  let manifestURL = nativeDirectory.appendingPathComponent("manifest.json", isDirectory: false)
  let identity = try regularFileIdentity(
    manifestURL,
    maximumBytes: maximumNativeManifestBytes,
    failure: "The sealed native-helper manifest is missing or invalid."
  )
  let data = try Data(contentsOf: manifestURL, options: .mappedIfSafe)
  guard data.count == identity.size else {
    throw brokerError("The sealed native-helper manifest changed while it was read.")
  }
  guard
    SecCodeValidateFileResource(
      parentStaticCode,
      "Resources/native/manifest.json" as CFString,
      data as CFData,
      []
    ) == errSecSuccess
  else {
    throw brokerError("The native-helper manifest bytes do not match the parent app resource seal.")
  }
  let manifest: NativeResourceManifest
  do {
    manifest = try JSONDecoder().decode(NativeResourceManifest.self, from: data)
  } catch {
    throw brokerError("The sealed native-helper manifest could not be decoded.")
  }
  let simulator = manifest.helpers.simulator
  let nativeHost = manifest.helpers.nativeHost
  guard manifest.schemaVersion == 1, manifest.platform == "darwin",
    manifest.buildCommit.range(
      of: "^[a-f0-9]{40}(?:-dirty:[a-f0-9]{64})?$",
      options: .regularExpression
    ) != nil,
    simulator.name == expectedSimulatorHelperIdentifier,
    simulator.file == expectedSimulatorHelperIdentifier,
    simulator.sha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
    nativeHost.name == expectedNativeHostIdentifier,
    nativeHost.file == expectedNativeHostIdentifier,
    nativeHost.sha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
  else {
    throw brokerError("The sealed native-helper manifest does not describe this helper contract.")
  }
  return TrustedNativeResources(
    directory: nativeDirectory,
    simulatorHelperSHA256: simulator.sha256,
    nativeHostSHA256: nativeHost.sha256,
    buildCommit: manifest.buildCommit
  )
}

private func verifyRunningNativeHost(
  _ resources: TrustedNativeResources,
  teamIdentifier: String
) throws {
  let hostURL = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
  guard hostURL.lastPathComponent == expectedNativeHostIdentifier,
    hostURL.deletingLastPathComponent() == resources.directory.resolvingSymlinksInPath()
  else {
    throw brokerError("The running native host is not the sealed helper in this application.")
  }
  var liveCode: SecCode?
  guard SecCodeCopySelf([], &liveCode) == errSecSuccess, let liveCode else {
    throw brokerError("The running native host code identity could not be inspected.")
  }
  let requirement = try designatedRequirement(
    identifier: expectedNativeHostIdentifier, teamIdentifier: teamIdentifier)
  guard SecCodeCheckValidity(liveCode, [], requirement) == errSecSuccess else {
    throw brokerError("The running native host failed its live designated requirement.")
  }
  let liveHash = try codeDirectoryHash(from: signingInformation(for: liveCode))
  var staticCode: SecStaticCode?
  guard SecStaticCodeCreateWithPath(hostURL as CFURL, [], &staticCode) == errSecSuccess,
    let staticCode,
    SecStaticCodeCheckValidity(
      staticCode,
      SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures),
      requirement
    ) == errSecSuccess,
    try codeDirectoryHash(from: signingInformation(for: staticCode)) == liveHash
  else {
    throw brokerError("The native host path does not match its running code identity.")
  }
  let before = try regularFileIdentity(
    hostURL,
    maximumBytes: maximumSimulatorHelperBytes,
    failure: "The native host is not a bounded regular file."
  )
  let data = try Data(contentsOf: hostURL, options: .mappedIfSafe)
  let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  let after = try regularFileIdentity(
    hostURL,
    maximumBytes: maximumSimulatorHelperBytes,
    failure: "The native host changed during sealed-manifest verification."
  )
  guard before == after, data.count == before.size, digest == resources.nativeHostSHA256 else {
    throw brokerError("The running native host does not match the sealed app manifest.")
  }
}

struct SystemBrokerParentAttestor: BrokerParentAttesting {
  func attest() throws -> BrokerParentIdentity {
    let parentPID = getppid()
    guard parentPID > 1 else {
      throw brokerError("The native host has no trusted desktop parent.")
    }
    let expectedTeamIdentifier = try nativeHostSigningTeamIdentifier()
    var guestCode: SecCode?
    let attributes = [kSecGuestAttributePid as String: NSNumber(value: parentPID)] as CFDictionary
    guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &guestCode) == errSecSuccess,
      let guestCode
    else {
      throw brokerError("The desktop parent signature could not be inspected.")
    }
    let information = try signingInformation(for: guestCode)
    guard
      let identifier = information[kSecCodeInfoIdentifier as String] as? String,
      identifier == expectedApplicationIdentifier,
      let teamIdentifier = information[kSecCodeInfoTeamIdentifier as String] as? String,
      teamIdentifier == expectedTeamIdentifier,
      let mainExecutableURL = information[kSecCodeInfoMainExecutable as String] as? URL
    else {
      throw brokerError("The desktop parent is not a production-signed desktop application.")
    }
    let requirement = try designatedRequirement(
      identifier: expectedApplicationIdentifier, teamIdentifier: expectedTeamIdentifier)
    guard SecCodeCheckValidity(guestCode, [], requirement) == errSecSuccess else {
      throw brokerError("The desktop parent failed its live designated requirement.")
    }
    let liveCodeDirectoryHash = try codeDirectoryHash(from: information)
    var parentStaticCode: SecStaticCode?
    guard
      SecStaticCodeCreateWithPath(mainExecutableURL as CFURL, [], &parentStaticCode)
        == errSecSuccess,
      let parentStaticCode,
      SecStaticCodeCheckValidity(
        parentStaticCode,
        SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures),
        requirement
      ) == errSecSuccess,
      try codeDirectoryHash(from: signingInformation(for: parentStaticCode))
        == liveCodeDirectoryHash
    else {
      throw brokerError("The desktop parent path does not match its running code identity.")
    }
    let trustedResources = try trustedNativeResources(
      mainExecutableURL: mainExecutableURL,
      parentStaticCode: parentStaticCode
    )
    try verifyRunningNativeHost(trustedResources, teamIdentifier: expectedTeamIdentifier)
    guard
      SecCodeCheckValidity(guestCode, [], requirement) == errSecSuccess,
      try codeDirectoryHash(from: signingInformation(for: guestCode)) == liveCodeDirectoryHash,
      getppid() == parentPID
    else {
      throw brokerError("The desktop parent changed while its sealed helper manifest was read.")
    }
    return BrokerParentIdentity(
      processID: parentPID,
      nativeResourceDirectory: trustedResources.directory,
      simulatorHelperSHA256: trustedResources.simulatorHelperSHA256,
      buildCommit: trustedResources.buildCommit
    )
  }
}

struct SystemSimulatorHelperVerifier: SimulatorHelperVerifying {
  func verify(_ executableURL: URL, expectedSHA256: String) throws
    -> VerifiedSimulatorHelperIdentity
  {
    let before = try regularFileIdentity(
      executableURL,
      maximumBytes: maximumSimulatorHelperBytes,
      failure: "The packaged simulator helper is not a bounded regular file."
    )
    let helperData = try Data(contentsOf: executableURL, options: .mappedIfSafe)
    guard helperData.count == before.size else {
      throw brokerError("The packaged simulator helper changed while it was hashed.")
    }
    let actualSHA256 = SHA256.hash(data: helperData).map { String(format: "%02x", $0) }.joined()
    guard
      expectedSHA256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
      actualSHA256 == expectedSHA256
    else {
      throw brokerError("The packaged simulator helper does not match the sealed app manifest.")
    }
    var staticCode: SecStaticCode?
    guard
      SecStaticCodeCreateWithPath(executableURL as CFURL, [], &staticCode) == errSecSuccess,
      let staticCode
    else {
      throw brokerError("The packaged simulator helper signature could not be inspected.")
    }
    let requirement = try designatedRequirement(
      identifier: expectedSimulatorHelperIdentifier,
      teamIdentifier: nativeHostSigningTeamIdentifier()
    )
    guard
      SecStaticCodeCheckValidity(
        staticCode,
        SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures),
        requirement
      ) == errSecSuccess
    else {
      throw brokerError("The packaged simulator helper failed its designated requirement.")
    }
    let after = try regularFileIdentity(
      executableURL,
      maximumBytes: maximumSimulatorHelperBytes,
      failure: "The packaged simulator helper changed after signature verification."
    )
    guard before == after else {
      throw brokerError("The packaged simulator helper changed during verification.")
    }
    let codeDirectoryHash = try codeDirectoryHash(from: signingInformation(for: staticCode))
    return VerifiedSimulatorHelperIdentity(codeDirectoryHash: codeDirectoryHash)
  }
}

struct SystemSpawnedSimulatorHelperVerifier: SpawnedSimulatorHelperVerifying {
  func verify(
    processID: pid_t,
    identity: VerifiedSimulatorHelperIdentity
  ) throws {
    guard processID > 1 else {
      throw brokerError("The spawned simulator helper has an invalid process identity.")
    }
    var guestCode: SecCode?
    let attributes = [kSecGuestAttributePid as String: NSNumber(value: processID)] as CFDictionary
    guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &guestCode) == errSecSuccess,
      let guestCode
    else {
      throw brokerError("The spawned simulator helper signature could not be inspected.")
    }
    let requirement = try designatedRequirement(
      identifier: expectedSimulatorHelperIdentifier,
      teamIdentifier: nativeHostSigningTeamIdentifier(),
      codeDirectoryHash: identity.codeDirectoryHash
    )
    guard
      SecCodeCheckValidity(guestCode, [], requirement) == errSecSuccess
    else {
      throw brokerError("The spawned simulator helper failed its live designated requirement.")
    }
  }
}

struct SystemSimulatorMutationBroker: SimulatorMutationBrokering {
  private let parentAttestor: any BrokerParentAttesting
  private let helperVerifier: any SimulatorHelperVerifying
  private let processRunner: any SimulatorMutationProcessRunning
  private let currentDate: () -> Date
  private let randomBytes: (Int) throws -> [UInt8]
  private let executableURL: URL

  init(
    parentAttestor: any BrokerParentAttesting = SystemBrokerParentAttestor(),
    helperVerifier: any SimulatorHelperVerifying = SystemSimulatorHelperVerifier(),
    processRunner: any SimulatorMutationProcessRunning = SystemSimulatorMutationProcessRunner(),
    currentDate: @escaping () -> Date = Date.init,
    randomBytes: @escaping (Int) throws -> [UInt8] = secureRandomBytes,
    executableURL: URL = URL(fileURLWithPath: CommandLine.arguments[0])
  ) {
    self.parentAttestor = parentAttestor
    self.helperVerifier = helperVerifier
    self.processRunner = processRunner
    self.currentDate = currentDate
    self.randomBytes = randomBytes
    self.executableURL = executableURL
  }

  func isAvailable() -> Bool {
    (try? parentAttestor.attest()) != nil
  }

  func run(
    helperRequest: String,
    cancellation: any CancellationChecking
  ) throws -> MutationBrokerResult {
    try cancellation.check()
    let parent = try parentAttestor.attest()
    let requestData = Data(helperRequest.utf8)
    let request = try BrokeredHelperRequest.decode(requestData)
    let helperURL = try siblingHelperURL()
    guard
      helperURL.deletingLastPathComponent().resolvingSymlinksInPath()
        == parent.nativeResourceDirectory.resolvingSymlinksInPath()
    else {
      throw brokerError("The simulator helper is not inside the authenticated app resources.")
    }
    let helperIdentity = try helperVerifier.verify(
      helperURL,
      expectedSHA256: parent.simulatorHelperSHA256
    )
    let issuedAt = currentDate()
    let authorization = BrokeredAuthorization(
      version: 1,
      requestID: request.requestID,
      operation: request.operation,
      simulatorID: request.simulatorID,
      requestSHA256: SHA256.hash(data: requestData).map { String(format: "%02x", $0) }.joined(),
      expiresAtUnixMilliseconds: Int64(issuedAt.timeIntervalSince1970 * 1_000)
        + authorizationLifetimeMilliseconds,
      nonce: try randomBytes(32).map { String(format: "%02x", $0) }.joined(),
      brokerPID: getpid(),
      brokerBuildCommit: parent.buildCommit
    )
    let authorizationData = try JSONEncoder.brokerEncoder.encode(authorization)
    guard authorizationData.count <= maximumAuthorizationBytes else {
      throw brokerError("The one-shot mutation authorization exceeds its bound.")
    }
    let output = try processRunner.run(
      executableURL: helperURL,
      identity: helperIdentity,
      brokerParentPID: parent.processID,
      request: requestData,
      authorization: authorizationData,
      terminationGraceSeconds: request.terminationGraceSeconds,
      cancellation: cancellation
    )
    guard output.count <= maximumHelperResponseBytes,
      let response = String(data: output, encoding: .utf8)
    else {
      throw brokerError("The simulator helper returned an invalid or oversized response.")
    }
    return MutationBrokerResult(helperResponse: response)
  }

  private func siblingHelperURL() throws -> URL {
    let hostURL = executableURL.resolvingSymlinksInPath().standardizedFileURL
    guard hostURL.lastPathComponent == expectedNativeHostIdentifier else {
      throw brokerError("The mutation broker executable identity is invalid.")
    }
    let helperURL = hostURL.deletingLastPathComponent().appendingPathComponent(
      expectedSimulatorHelperIdentifier, isDirectory: false)
    let values = try helperURL.resourceValues(forKeys: [
      .isRegularFileKey, .isSymbolicLinkKey, .isExecutableKey,
    ])
    guard values.isRegularFile == true, values.isSymbolicLink != true, values.isExecutable == true
    else {
      throw brokerError("The packaged simulator helper is not a regular executable sibling.")
    }
    return helperURL
  }
}

private struct BrokeredHelperRequest {
  let requestID: String
  let operation: String
  let simulatorID: String
  let terminationGraceSeconds: TimeInterval

  static func decode(_ data: Data) throws -> BrokeredHelperRequest {
    guard !data.isEmpty, data.count <= maximumHelperRequestBytes,
      let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(object.keys) == Set(["protocolVersion", "requestId", "operation", "payload"]),
      object["protocolVersion"] as? Int == simulatorHelperProtocolVersion,
      let requestID = object["requestId"] as? String,
      requestID.range(of: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$", options: .regularExpression)
        != nil,
      let operation = object["operation"] as? String,
      ["clone_simulator", "disk_cleanup", "apply_profile", "restore_managed", "undo_last"]
        .contains(operation),
      let payload = object["payload"] as? [String: Any],
      let simulatorID = payload["simulatorId"] as? String,
      simulatorID.range(of: "^[A-Fa-f0-9-]{8,64}$", options: .regularExpression) != nil
    else {
      throw brokerError("The broker accepts only a bounded versioned simulator mutation request.")
    }
    return BrokeredHelperRequest(
      requestID: requestID,
      operation: operation,
      simulatorID: simulatorID,
      terminationGraceSeconds: operation == "clone_simulator"
        ? 20 * 60
        : operation == "disk_cleanup" ? 10 * 60 : 30 * 60
    )
  }
}

private struct BrokeredAuthorization: Encodable {
  let version: Int
  let requestID: String
  let operation: String
  let simulatorID: String
  let requestSHA256: String
  let expiresAtUnixMilliseconds: Int64
  let nonce: String
  let brokerPID: pid_t
  let brokerBuildCommit: String

  enum CodingKeys: String, CodingKey {
    case version
    case requestID = "requestId"
    case operation
    case simulatorID = "simulatorId"
    case requestSHA256 = "requestSha256"
    case expiresAtUnixMilliseconds = "expiresAtUnixMs"
    case nonce
    case brokerPID = "brokerPid"
    case brokerBuildCommit
  }
}

extension JSONEncoder {
  fileprivate static var brokerEncoder: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return encoder
  }
}

private func secureRandomBytes(count: Int) throws -> [UInt8] {
  var bytes = [UInt8](repeating: 0, count: count)
  guard SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess else {
    throw brokerError("A secure one-shot mutation nonce could not be generated.")
  }
  return bytes
}

private func brokerError(_ message: String) -> NativeHostError {
  NativeHostError(code: "mutation_authorization_required", message: message)
}

/// A helper that dies without a protocol response explains itself only on
/// stderr. Keep a bounded, single-line copy so the failure is diagnosable from
/// Electron instead of collapsing into one fixed sentence.
private func helperFailureMessage(status: Int32, standardError: Data) -> String {
  let base = "The authenticated simulator helper process failed with status \(status)."
  let space: Unicode.Scalar = " "
  let scalars = String(decoding: standardError.prefix(8 * 1024), as: UTF8.self)
    .unicodeScalars
    .map { CharacterSet.newlines.contains($0) ? space : $0 }
    .filter { !CharacterSet.controlCharacters.contains($0) }
  let detail = String(String.UnicodeScalarView(scalars))
    .split(separator: " ", omittingEmptySubsequences: true)
    .joined(separator: " ")
    .prefix(1_024)
  return detail.isEmpty ? base : "\(base) \(detail)"
}

final class SystemSimulatorMutationProcessRunner: SimulatorMutationProcessRunning {
  private static let timeout: TimeInterval = 32 * 60
  private let spawnedHelperVerifier: any SpawnedSimulatorHelperVerifying
  private let currentParentPID: () -> pid_t

  init(
    spawnedHelperVerifier: any SpawnedSimulatorHelperVerifying =
      SystemSpawnedSimulatorHelperVerifier(),
    currentParentPID: @escaping () -> pid_t = getppid
  ) {
    self.spawnedHelperVerifier = spawnedHelperVerifier
    self.currentParentPID = currentParentPID
  }

  func run(
    executableURL: URL,
    identity: VerifiedSimulatorHelperIdentity,
    brokerParentPID: pid_t,
    request: Data,
    authorization: Data,
    terminationGraceSeconds: TimeInterval,
    cancellation: any CancellationChecking
  ) throws -> Data {
    let inputPipe = try SpawnPipe()
    let authorizationPipe = try SpawnPipe()
    try authorizationPipe.makeReadNonBlocking()
    let controlPipe = try SpawnPipe()
    let outputPipe = try SpawnPipe()
    let errorPipe = try SpawnPipe()
    var actions: posix_spawn_file_actions_t?
    guard posix_spawn_file_actions_init(&actions) == 0 else {
      throw brokerError("The simulator helper process could not be prepared.")
    }
    defer { posix_spawn_file_actions_destroy(&actions) }
    var attributes: posix_spawnattr_t?
    guard posix_spawnattr_init(&attributes) == 0 else {
      throw brokerError("The simulator helper process group could not be prepared.")
    }
    defer { posix_spawnattr_destroy(&attributes) }
    guard posix_spawnattr_setpgroup(&attributes, 0) == 0,
      posix_spawnattr_setflags(
        &attributes,
        Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_START_SUSPENDED)
      ) == 0
    else {
      throw brokerError("The simulator helper process group could not be isolated.")
    }
    try addDup(inputPipe.readFD, STDIN_FILENO, &actions)
    try addDup(outputPipe.writeFD, STDOUT_FILENO, &actions)
    try addDup(errorPipe.writeFD, STDERR_FILENO, &actions)
    try addDup(authorizationPipe.readFD, authorizationFD, &actions)
    try addDup(controlPipe.readFD, controlFD, &actions)
    for descriptor in [
      inputPipe.readFD, inputPipe.writeFD, authorizationPipe.readFD, authorizationPipe.writeFD,
      controlPipe.readFD, controlPipe.writeFD,
      outputPipe.readFD, outputPipe.writeFD, errorPipe.readFD, errorPipe.writeFD,
    ] {
      guard posix_spawn_file_actions_addclose(&actions, descriptor) == 0 else {
        throw brokerError("The simulator helper process descriptors could not be bounded.")
      }
    }

    var processID: pid_t = 0
    var arguments: [UnsafeMutablePointer<CChar>?] = [strdup(executableURL.path), nil]
    defer { free(arguments[0]) }
    var environment = simulatorHelperEnvironment().map {
      strdup($0) as UnsafeMutablePointer<CChar>?
    }
    environment.append(nil)
    defer {
      for value in environment.dropLast() { free(value) }
    }
    let spawnStatus = executableURL.path.withCString { executablePath in
      arguments.withUnsafeMutableBufferPointer { argumentBuffer in
        environment.withUnsafeMutableBufferPointer { environmentBuffer in
          posix_spawn(
            &processID,
            executablePath,
            &actions,
            &attributes,
            argumentBuffer.baseAddress,
            environmentBuffer.baseAddress
          )
        }
      }
    }
    guard spawnStatus == 0 else {
      throw brokerError("The simulator helper process could not be launched.")
    }
    do {
      try verifyBrokerParent(brokerParentPID, cancellation: cancellation)
      try spawnedHelperVerifier.verify(processID: processID, identity: identity)
      try verifyBrokerParent(brokerParentPID, cancellation: cancellation)
      guard kill(processID, SIGCONT) == 0 else {
        throw brokerError("The authenticated simulator helper could not be resumed.")
      }
    } catch {
      terminateAndReap(processID, graceSeconds: 0)
      throw error
    }
    inputPipe.closeRead()
    authorizationPipe.closeRead()
    controlPipe.closeRead()
    outputPipe.closeWrite()
    errorPipe.closeWrite()

    let output = BoundedPipeReader(
      fd: outputPipe.takeRead(), limit: maximumHelperResponseBytes)
    let standardError = BoundedPipeReader(
      fd: errorPipe.takeRead(), limit: NativeProtocol.maximumResponseBytes)
    output.start()
    standardError.start()
    var leaderReaped = false
    do {
      try inputPipe.writeAndClose(
        request,
        brokerParentPID: brokerParentPID,
        currentParentPID: currentParentPID,
        cancellation: cancellation
      )
      try authorizationPipe.writeAndClose(
        authorization,
        brokerParentPID: brokerParentPID,
        currentParentPID: currentParentPID,
        cancellation: cancellation
      )
      let status = try waitForProcess(
        processID,
        brokerParentPID: brokerParentPID,
        cancellation: cancellation
      )
      leaderReaped = true
      controlPipe.closeWrite()
      terminateSurvivingGroup(processID)
      let outputData = output.finish()
      let standardErrorData = standardError.finish()
      guard status == 0 || status == 1, !outputData.isEmpty else {
        throw NativeHostError(
          code: "simulator_helper_failed",
          message: helperFailureMessage(status: status, standardError: standardErrorData)
        )
      }
      guard !output.isOversized else {
        throw brokerError("The simulator helper response exceeds 4 MiB.")
      }
      return outputData
    } catch {
      // FD 4 is the helper's private cancellation channel. Closing it lets the
      // Go helper complete independently bounded rollback without depending on
      // Darwin's process-signal delivery runtime.
      controlPipe.closeWrite()
      if !leaderReaped {
        waitForGracefulExitThenKill(processID, graceSeconds: terminationGraceSeconds)
      }
      inputPipe.closeWrite()
      authorizationPipe.closeWrite()
      _ = output.finish()
      _ = standardError.finish()
      throw error
    }
  }

  private func waitForProcess(
    _ processID: pid_t,
    brokerParentPID: pid_t,
    cancellation: any CancellationChecking
  ) throws -> Int32 {
    let deadline = Date().addingTimeInterval(Self.timeout)
    while true {
      try verifyBrokerParent(brokerParentPID, cancellation: cancellation)
      var status: Int32 = 0
      let result = waitpid(processID, &status, WNOHANG)
      if result == processID {
        if status & 0x7F == 0 { return (status >> 8) & 0xFF }
        return 128 + (status & 0x7F)
      }
      if result == -1 { throw brokerError("The simulator helper process could not be reaped.") }
      if Date() >= deadline { throw brokerError("The simulator helper process timed out.") }
      usleep(20_000)
    }
  }

  private func verifyBrokerParent(
    _ brokerParentPID: pid_t,
    cancellation: any CancellationChecking
  ) throws {
    try cancellation.check()
    guard brokerParentPID > 1, currentParentPID() == brokerParentPID else {
      throw brokerError("The authenticated desktop parent exited during the simulator mutation.")
    }
  }

  private func terminateAndReap(_ processID: pid_t, graceSeconds: TimeInterval) {
    guard processID > 1 else { return }
    _ = kill(-processID, SIGTERM)
    waitForGracefulExitThenKill(processID, graceSeconds: graceSeconds)
  }

  private func waitForGracefulExitThenKill(_ processID: pid_t, graceSeconds: TimeInterval) {
    guard processID > 1 else { return }
    let deadline = Date().addingTimeInterval(graceSeconds)
    var leaderReaped = false
    while Date() < deadline {
      if !leaderReaped {
        var status: Int32 = 0
        let result = waitpid(processID, &status, WNOHANG)
        if result == processID || (result == -1 && errno == ECHILD) {
          leaderReaped = true
        } else if result == -1, errno != EINTR {
          break
        }
      }
      if !processGroupExists(processID) { return }
      usleep(20_000)
    }
    _ = kill(-processID, SIGKILL)
    if !leaderReaped {
      var status: Int32 = 0
      while waitpid(processID, &status, 0) == -1, errno == EINTR {}
    }
  }

  private func processGroupExists(_ processID: pid_t) -> Bool {
    if kill(-processID, 0) == 0 { return true }
    return errno != ESRCH
  }

  private func terminateSurvivingGroup(_ processID: pid_t) {
    guard processID > 1 else { return }
    _ = kill(-processID, SIGTERM)
    usleep(20_000)
    _ = kill(-processID, SIGKILL)
  }

  private func addDup(
    _ source: Int32,
    _ destination: Int32,
    _ actions: inout posix_spawn_file_actions_t?
  ) throws {
    guard posix_spawn_file_actions_adddup2(&actions, source, destination) == 0 else {
      throw brokerError("The simulator helper process descriptors could not be assigned.")
    }
  }

  private func simulatorHelperEnvironment() -> [String] {
    var result = ["PATH=/usr/bin:/bin:/usr/sbin:/sbin", "\(controlFDEnvironment)=\(controlFD)"]
    for name in ["DEVELOPER_DIR", "HOME", "LANG", "LC_ALL", "LOGNAME", "TMPDIR", "USER"] {
      guard let value = getenv(name), !String(cString: value).contains("\n") else { continue }
      result.append("\(name)=\(String(cString: value))")
    }
    return result
  }
}

final class SpawnPipe {
  private var readDescriptor: Int32
  private var writeDescriptor: Int32

  var readFD: Int32 { readDescriptor }
  var writeFD: Int32 { writeDescriptor }

  init() throws {
    var descriptors: [Int32] = [0, 0]
    let result = descriptors.withUnsafeMutableBufferPointer { Darwin.pipe($0.baseAddress!) }
    guard result == 0 else {
      throw brokerError("A bounded simulator-helper pipe could not be created.")
    }
    readDescriptor = try Self.moveAboveReservedRange(descriptors[0])
    writeDescriptor = try Self.moveAboveReservedRange(descriptors[1])
    guard fcntl(writeDescriptor, F_SETNOSIGPIPE, 1) == 0 else {
      throw brokerError("A simulator-helper pipe could not be made crash-safe.")
    }
  }

  deinit {
    closeRead()
    closeWrite()
  }

  func closeRead() {
    if readDescriptor >= 0 {
      Darwin.close(readDescriptor)
      readDescriptor = -1
    }
  }

  func closeWrite() {
    if writeDescriptor >= 0 {
      Darwin.close(writeDescriptor)
      writeDescriptor = -1
    }
  }

  func takeRead() -> Int32 {
    let descriptor = readDescriptor
    readDescriptor = -1
    return descriptor
  }

  func makeReadNonBlocking() throws {
    let flags = fcntl(readDescriptor, F_GETFL)
    guard flags >= 0, fcntl(readDescriptor, F_SETFL, flags | O_NONBLOCK) == 0 else {
      throw brokerError("The simulator-helper authorization pipe could not be made pollable.")
    }
  }

  func writeAndClose(
    _ data: Data,
    brokerParentPID: pid_t,
    currentParentPID: () -> pid_t,
    cancellation: any CancellationChecking
  ) throws {
    defer { closeWrite() }
    let flags = fcntl(writeDescriptor, F_GETFL)
    guard flags >= 0, fcntl(writeDescriptor, F_SETFL, flags | O_NONBLOCK) == 0 else {
      throw brokerError("The simulator-helper input pipe could not be made cancellation-safe.")
    }
    let deadline = Date().addingTimeInterval(5)
    try data.withUnsafeBytes { buffer in
      guard var pointer = buffer.baseAddress else { return }
      var remaining = buffer.count
      while remaining > 0 {
        try cancellation.check()
        guard brokerParentPID > 1, currentParentPID() == brokerParentPID else {
          throw brokerError("The authenticated desktop parent exited while helper input was sent.")
        }
        let written = Darwin.write(writeDescriptor, pointer, remaining)
        if written < 0 {
          if errno == EINTR { continue }
          if errno == EAGAIN || errno == EWOULDBLOCK {
            guard Date() < deadline else {
              throw brokerError("The simulator helper did not consume its bounded input in time.")
            }
            usleep(10_000)
            continue
          }
          throw brokerError("The simulator helper input pipe closed unexpectedly.")
        }
        remaining -= written
        pointer = pointer.advanced(by: written)
      }
    }
  }

  private static func moveAboveReservedRange(_ descriptor: Int32) throws -> Int32 {
    let moved = fcntl(descriptor, F_DUPFD_CLOEXEC, 10)
    Darwin.close(descriptor)
    guard moved >= 10 else {
      throw brokerError("A simulator-helper pipe descriptor could not be isolated.")
    }
    return moved
  }
}

private final class BoundedPipeReader: @unchecked Sendable {
  private let descriptor: Int32
  private let limit: Int
  private let group = DispatchGroup()
  private let lock = NSLock()
  private var data = Data()
  private(set) var isOversized = false

  init(fd: Int32, limit: Int) {
    descriptor = fd
    self.limit = limit
  }

  func start() {
    group.enter()
    DispatchQueue.global(qos: .utility).async { [self] in
      defer {
        Darwin.close(descriptor)
        group.leave()
      }
      var buffer = [UInt8](repeating: 0, count: 8 * 1024)
      while true {
        let count = Darwin.read(descriptor, &buffer, buffer.count)
        if count == 0 { return }
        if count < 0 {
          if errno == EINTR { continue }
          return
        }
        lock.lock()
        if data.count + count <= limit {
          data.append(buffer, count: count)
        } else {
          isOversized = true
        }
        lock.unlock()
      }
    }
  }

  func finish() -> Data {
    group.wait()
    lock.lock()
    defer { lock.unlock() }
    return data
  }
}

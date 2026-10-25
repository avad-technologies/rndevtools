import Foundation
import Security
import Testing

@testable import RNDevtoolsNativeHost

private struct StubPermissionReader: PermissionReading {
  let values: [PermissionStatus]

  func statuses() -> [PermissionStatus] {
    values
  }
}

private struct StubCapabilityReader: CapabilityReading {
  let value: NativeCapabilityStatusResult

  func status() -> NativeCapabilityStatusResult {
    value
  }
}

private struct StubImageComposer: ImageComposing {
  func compose(
    _ request: ImageCompositionRequest,
    cancellation: any CancellationChecking
  ) throws -> ImageCompositionResult {
    try cancellation.check()
    return ImageCompositionResult(
      outputName: request.output,
      outputFormat: request.outputFormat.rawValue,
      width: request.canvasSize.width,
      height: request.canvasSize.height,
      byteCount: 128,
      inputCount: request.secondaryInput == nil ? 1 : 2,
      composition: request.comparison?.resultName ?? "single",
      metadataRendered: request.metadata != nil,
      bezelStyle: request.layout.bezel.rawValue
    )
  }
}

private struct StubParentAttestor: BrokerParentAttesting {
  let identity: BrokerParentIdentity?

  func attest() throws -> BrokerParentIdentity {
    guard let identity else {
      throw NativeHostError(
        code: "mutation_authorization_required", message: "untrusted test parent")
    }
    return identity
  }
}

private final class StubHelperVerifier: SimulatorHelperVerifying {
  private(set) var expectedSHA256Values: [String] = []

  func verify(_ executableURL: URL, expectedSHA256: String) throws
    -> VerifiedSimulatorHelperIdentity
  {
    #expect(executableURL.lastPathComponent == "rndevtools-sim-helper")
    expectedSHA256Values.append(expectedSHA256)
    return VerifiedSimulatorHelperIdentity(codeDirectoryHash: Data("verified".utf8))
  }
}

private struct StubSpawnedHelperVerifier: SpawnedSimulatorHelperVerifying {
  let error: NativeHostError?
  let inspection: ((pid_t) -> Void)?

  init(error: NativeHostError? = nil, inspection: ((pid_t) -> Void)? = nil) {
    self.error = error
    self.inspection = inspection
  }

  func verify(processID: pid_t, identity: VerifiedSimulatorHelperIdentity) throws {
    #expect(processID > 1)
    #expect(identity.codeDirectoryHash == Data("verified".utf8))
    inspection?(processID)
    if let error { throw error }
  }
}

private final class LockedParentPID: @unchecked Sendable {
  private let lock = NSLock()
  private var value: pid_t

  init(_ value: pid_t) {
    self.value = value
  }

  func get() -> pid_t {
    lock.lock()
    defer { lock.unlock() }
    return value
  }

  func set(_ value: pid_t) {
    lock.lock()
    self.value = value
    lock.unlock()
  }
}

private final class StubMutationProcessRunner: SimulatorMutationProcessRunning {
  var response = Data(
    #"{"protocolVersion":2,"requestId":"mutation-1","ok":true,"result":{}}"#.utf8)
  private(set) var requests: [Data] = []
  private(set) var authorizations: [Data] = []

  func run(
    executableURL: URL,
    identity: VerifiedSimulatorHelperIdentity,
    brokerParentPID: pid_t,
    request: Data,
    authorization: Data,
    terminationGraceSeconds: TimeInterval,
    cancellation: any CancellationChecking
  ) throws -> Data {
    try cancellation.check()
    #expect(identity.codeDirectoryHash == Data("verified".utf8))
    #expect(brokerParentPID == 123)
    requests.append(request)
    authorizations.append(authorization)
    #expect(terminationGraceSeconds == 10 * 60)
    return response
  }
}

private struct StubMutationBroker: SimulatorMutationBrokering {
  let available: Bool
  let response: MutationBrokerResult?

  func isAvailable() -> Bool { available }

  func run(
    helperRequest: String,
    cancellation: any CancellationChecking
  ) throws -> MutationBrokerResult {
    try cancellation.check()
    guard let response else {
      throw NativeHostError(
        code: "mutation_authorization_required", message: "signed broker required")
    }
    #expect(helperRequest.contains("disk_cleanup"))
    return response
  }
}

@Test func directMutationIsDeniedButAuthenticatedBrokerFlowIsReturned() throws {
  let helperRequest = simulatorMutationRequest()
  let direct = NativeHost(
    mutationBroker: StubMutationBroker(available: false, response: nil)
  ).process(
    arguments: ["rndevtools-native-host"],
    input: request(
      protocolVersion: 4,
      operation: "run_simulator_mutation",
      payload: ["helperRequest": helperRequest]
    )
  )
  #expect(direct.exitCode == 1)
  let directObject = try #require(
    JSONSerialization.jsonObject(with: direct.data) as? [String: Any])
  let directError = try #require(directObject["error"] as? [String: Any])
  #expect(directError["code"] as? String == "mutation_authorization_required")

  let authorized = NativeHost(
    mutationBroker: StubMutationBroker(
      available: true,
      response: MutationBrokerResult(
        helperResponse:
          #"{"protocolVersion":2,"requestId":"mutation-1","ok":true,"result":{}}"#
      )
    )
  ).process(
    arguments: ["rndevtools-native-host"],
    input: request(
      protocolVersion: 4,
      operation: "run_simulator_mutation",
      payload: ["helperRequest": helperRequest]
    )
  )
  #expect(authorized.exitCode == 0)
  let object = try #require(
    JSONSerialization.jsonObject(with: authorized.data) as? [String: Any])
  let result = try #require(object["result"] as? [String: Any])
  #expect((result["helperResponse"] as? String)?.contains("mutation-1") == true)
}

@Test func systemBrokerBindsOneShotAuthorizationToExactRequestAndParent() throws {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let hostURL = root.appendingPathComponent("rndevtools-native-host")
  let helperURL = root.appendingPathComponent("rndevtools-sim-helper")
  for url in [hostURL, helperURL] {
    try Data("fixture".utf8).write(to: url)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
  }
  let verifier = StubHelperVerifier()
  let runner = StubMutationProcessRunner()
  let requestValue = simulatorMutationRequest()
  let now = Date(timeIntervalSince1970: 1_900_000_000)
  let broker = SystemSimulatorMutationBroker(
    parentAttestor: StubParentAttestor(
      identity: BrokerParentIdentity(
        processID: 123,
        nativeResourceDirectory: root,
        simulatorHelperSHA256: String(repeating: "a", count: 64),
        buildCommit: String(repeating: "b", count: 40)
      )),
    helperVerifier: verifier,
    processRunner: runner,
    currentDate: { now },
    randomBytes: { count in [UInt8](repeating: 0xAB, count: count) },
    executableURL: hostURL
  )
  let result = try broker.run(helperRequest: requestValue, cancellation: NeverCancelled())
  #expect(result.helperResponse.contains("mutation-1"))
  #expect(verifier.expectedSHA256Values == [String(repeating: "a", count: 64)])
  #expect(runner.requests == [Data(requestValue.utf8)])
  let authorizationData = try #require(runner.authorizations.first)
  let authorization = try #require(
    JSONSerialization.jsonObject(with: authorizationData) as? [String: Any])
  #expect(authorization["requestId"] as? String == "mutation-1")
  #expect(authorization["operation"] as? String == "disk_cleanup")
  #expect(
    authorization["simulatorId"] as? String
      == "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")
  #expect(authorization["brokerPid"] as? Int == Int(getpid()))
  #expect(authorization["brokerBuildCommit"] as? String == String(repeating: "b", count: 40))
  #expect(authorization["nonce"] as? String == String(repeating: "ab", count: 32))
  #expect(authorization["expiresAtUnixMs"] as? Int64 == 1_900_000_015_000)
  #expect((authorization["requestSha256"] as? String)?.count == 64)
}

@Test func brokerRejectsUntrustedParentAndNonMutationBeforeSpawning() throws {
  let runner = StubMutationProcessRunner()
  let broker = SystemSimulatorMutationBroker(
    parentAttestor: StubParentAttestor(identity: nil),
    helperVerifier: StubHelperVerifier(),
    processRunner: runner,
    executableURL: URL(fileURLWithPath: "/tmp/rndevtools-native-host")
  )
  #expect(throws: NativeHostError.self) {
    try broker.run(helperRequest: simulatorMutationRequest(), cancellation: NeverCancelled())
  }
  #expect(runner.requests.isEmpty)
}

@Test func processRunnerReapsAHelperThatCrashesBeforeReadingAuthorization() throws {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let processIDFile = root.appendingPathComponent("pid")
  let executable = root.appendingPathComponent("crashing-helper")
  try Data("#!/bin/sh\necho $$ > '\(processIDFile.path)'\nexit 9\n".utf8).write(to: executable)
  try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
  #expect(throws: NativeHostError.self) {
    try SystemSimulatorMutationProcessRunner(
      spawnedHelperVerifier: StubSpawnedHelperVerifier()
    ).run(
      executableURL: executable,
      identity: VerifiedSimulatorHelperIdentity(codeDirectoryHash: Data("verified".utf8)),
      brokerParentPID: getppid(),
      request: Data("request".utf8),
      authorization: Data("authorization".utf8),
      terminationGraceSeconds: 0.1,
      cancellation: NeverCancelled()
    )
  }
  let processID = try #require(
    Int32(String(contentsOf: processIDFile).trimmingCharacters(in: .whitespacesAndNewlines)))
  #expect(kill(processID, 0) == -1)
  #expect(errno == ESRCH)
}

@Test func authorizationPipeReadEndIsPollableWithoutChangingItsWriter() throws {
  let pipe = try SpawnPipe()
  let originalWriteFlags = fcntl(pipe.writeFD, F_GETFL)
  #expect(originalWriteFlags >= 0)

  try pipe.makeReadNonBlocking()

  let readFlags = fcntl(pipe.readFD, F_GETFL)
  let writeFlags = fcntl(pipe.writeFD, F_GETFL)
  #expect(readFlags >= 0)
  #expect(readFlags & O_NONBLOCK == O_NONBLOCK)
  #expect(writeFlags == originalWriteFlags)
}

@Test func liveHelperRequirementIncludesTheExactVerifiedCodeDirectoryHash() throws {
  let hash = Data((0..<20).map(UInt8.init))
  let requirement = try designatedRequirement(
    identifier: "rndevtools-sim-helper",
    teamIdentifier: "ABCDE12345",
    codeDirectoryHash: hash
  )
  var text: CFString?
  #expect(SecRequirementCopyString(requirement, [], &text) == errSecSuccess)
  let value = try #require(text as String?)
  #expect(value.contains(#"identifier "rndevtools-sim-helper""#))
  #expect(value.contains("certificate leaf[subject.OU] = ABCDE12345"))
  #expect(value.contains(#"cdhash H"000102030405060708090a0b0c0d0e0f10111213""#))
}

@Test func brokerTrustsOnlyTheTeamThatSignedTheNativeHost() throws {
  let team = kSecCodeInfoTeamIdentifier as String
  #expect(try signingTeamIdentifier(from: [team: "ABCDE12345"]) == "ABCDE12345")
  let untrusted: [[String: Any]] = [
    [:],
    [team: "abcde12345"],
    [team: "ABCDE1234"],
    [team: #"ABCDE12345" or anchor apple"#],
  ]
  for information in untrusted {
    #expect(throws: NativeHostError.self) { try signingTeamIdentifier(from: information) }
  }
  #expect(throws: NativeHostError.self) {
    try designatedRequirement(identifier: "rndevtools-native-host", teamIdentifier: "")
  }
}

@Test func processRunnerVerifiesSuspendedHelperBeforeAnyUserCodeRuns() throws {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let marker = root.appendingPathComponent("executed")
  let executable = root.appendingPathComponent("suspended-helper")
  let response =
    #"{"protocolVersion":2,"requestId":"mutation-1","ok":true,"result":{}}"#
  try Data(
    "#!/bin/sh\necho executed > '\(marker.path)'\ncat >/dev/null\ncat <&3 >/dev/null\nprintf '%s' '\(response)'\n"
      .utf8
  ).write(to: executable)
  try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
  let output = try SystemSimulatorMutationProcessRunner(
    spawnedHelperVerifier: StubSpawnedHelperVerifier(inspection: { _ in
      #expect(!FileManager.default.fileExists(atPath: marker.path))
    })
  ).run(
    executableURL: executable,
    identity: VerifiedSimulatorHelperIdentity(codeDirectoryHash: Data("verified".utf8)),
    brokerParentPID: getppid(),
    request: Data("request".utf8),
    authorization: Data("authorization".utf8),
    terminationGraceSeconds: 0.1,
    cancellation: NeverCancelled()
  )
  #expect(FileManager.default.fileExists(atPath: marker.path))
  #expect(String(data: output, encoding: .utf8) == response)
}

@Test func processRunnerCancelsAndReapsWhenElectronParentDisappears() throws {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let processIDFile = root.appendingPathComponent("pid")
  let executable = root.appendingPathComponent("long-running-helper")
  try Data(
    "#!/bin/sh\necho $$ > '\(processIDFile.path)'\ncat >/dev/null\ncat <&3 >/dev/null\nsleep 5\n"
      .utf8
  ).write(to: executable)
  try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
  let parent = LockedParentPID(42)
  let helperProcess = LockedParentPID(-1)
  let startedAt = Date()
  #expect(throws: NativeHostError.self) {
    try SystemSimulatorMutationProcessRunner(
      spawnedHelperVerifier: StubSpawnedHelperVerifier(inspection: { processID in
        helperProcess.set(processID)
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { parent.set(1) }
      }),
      currentParentPID: parent.get
    ).run(
      executableURL: executable,
      identity: VerifiedSimulatorHelperIdentity(codeDirectoryHash: Data("verified".utf8)),
      brokerParentPID: 42,
      request: Data("request".utf8),
      authorization: Data("authorization".utf8),
      terminationGraceSeconds: 0.05,
      cancellation: NeverCancelled()
    )
  }
  #expect(Date().timeIntervalSince(startedAt) < 1)
  let processID = helperProcess.get()
  #expect(processID > 1)
  #expect(kill(processID, 0) == -1)
  #expect(errno == ESRCH)
}

@Test func processRunnerClosesPrivateControlPipeBeforeForceKillingHelper() throws {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let cleanupFile = root.appendingPathComponent("cleanup-complete")
  let readyFile = root.appendingPathComponent("control-ready")
  let executable = root.appendingPathComponent("control-aware-helper")
  try Data(
    "#!/bin/sh\ncat >/dev/null\ncat <&3 >/dev/null\necho ready > '\(readyFile.path)'\ncat <&4 >/dev/null\necho cleaned > '\(cleanupFile.path)'\n"
      .utf8
  ).write(to: executable)
  try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
  let parent = LockedParentPID(42)
  #expect(throws: NativeHostError.self) {
    try SystemSimulatorMutationProcessRunner(
      spawnedHelperVerifier: StubSpawnedHelperVerifier(inspection: { _ in
        let readyPath = readyFile.path
        DispatchQueue.global().async {
          let deadline = Date().addingTimeInterval(2)
          while !FileManager.default.fileExists(atPath: readyPath), Date() < deadline {
            usleep(10_000)
          }
          parent.set(1)
        }
      }),
      currentParentPID: parent.get
    ).run(
      executableURL: executable,
      identity: VerifiedSimulatorHelperIdentity(codeDirectoryHash: Data("verified".utf8)),
      brokerParentPID: 42,
      request: Data("request".utf8),
      authorization: Data("authorization".utf8),
      terminationGraceSeconds: 1,
      cancellation: NeverCancelled()
    )
  }
  #expect(FileManager.default.fileExists(atPath: cleanupFile.path))
}

@Test func processRunnerSendsNoAuthorizationWhenLiveHelperIdentityFails() throws {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let authorizationFile = root.appendingPathComponent("authorization")
  let executable = root.appendingPathComponent("substituted-helper")
  try Data("#!/bin/sh\ncat <&3 > '\(authorizationFile.path)'\n".utf8).write(to: executable)
  try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
  #expect(throws: NativeHostError.self) {
    try SystemSimulatorMutationProcessRunner(
      spawnedHelperVerifier: StubSpawnedHelperVerifier(
        error: NativeHostError(code: "mutation_authorization_required", message: "substituted")
      )
    ).run(
      executableURL: executable,
      identity: VerifiedSimulatorHelperIdentity(codeDirectoryHash: Data("verified".utf8)),
      brokerParentPID: getppid(),
      request: Data("request".utf8),
      authorization: Data("secret-authorization".utf8),
      terminationGraceSeconds: 0.1,
      cancellation: NeverCancelled()
    )
  }
  let captured = (try? Data(contentsOf: authorizationFile)) ?? Data()
  #expect(captured.isEmpty)
}

@Test func processRunnerKillsTermResistantDescendantsAfterLeaderFailure() throws {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let descendantFile = root.appendingPathComponent("descendant")
  let executable = root.appendingPathComponent("descendant-helper")
  try Data(
    "#!/bin/sh\n( trap '' TERM; while :; do sleep 5; done ) &\necho $! > '\(descendantFile.path)'\nexit 9\n"
      .utf8
  ).write(to: executable)
  try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
  #expect(throws: NativeHostError.self) {
    try SystemSimulatorMutationProcessRunner(
      spawnedHelperVerifier: StubSpawnedHelperVerifier()
    ).run(
      executableURL: executable,
      identity: VerifiedSimulatorHelperIdentity(codeDirectoryHash: Data("verified".utf8)),
      brokerParentPID: getppid(),
      request: Data("request".utf8),
      authorization: Data("authorization".utf8),
      terminationGraceSeconds: 0.05,
      cancellation: NeverCancelled()
    )
  }
  let descendantPID = try #require(
    Int32(String(contentsOf: descendantFile).trimmingCharacters(in: .whitespacesAndNewlines)))
  let deadline = Date().addingTimeInterval(1)
  while kill(descendantPID, 0) == 0, Date() < deadline { usleep(10_000) }
  #expect(kill(descendantPID, 0) == -1)
  #expect(errno == ESRCH)
}

@Test func processRunnerPreservesARecognizedHelperFailureResponse() throws {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: root) }
  let executable = root.appendingPathComponent("failing-helper")
  let response =
    #"{"protocolVersion":2,"requestId":"mutation-1","ok":false,"error":{"code":"compatibility_blocked","message":"blocked","retryable":false}}"#
  try Data(
    "#!/bin/sh\ncat >/dev/null\ncat <&3 >/dev/null\nprintf '%s' '\(response)'\nexit 1\n".utf8
  )
  .write(to: executable)
  try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
  let output = try SystemSimulatorMutationProcessRunner(
    spawnedHelperVerifier: StubSpawnedHelperVerifier()
  ).run(
    executableURL: executable,
    identity: VerifiedSimulatorHelperIdentity(codeDirectoryHash: Data("verified".utf8)),
    brokerParentPID: getppid(),
    request: Data("request".utf8),
    authorization: Data("authorization".utf8),
    terminationGraceSeconds: 0.1,
    cancellation: NeverCancelled()
  )
  #expect(String(data: output, encoding: .utf8) == response)
}

@Test func handshakeIsVersionedAndCannotMutate() throws {
  let response = NativeHost().process(
    arguments: ["rndevtools-native-host"],
    input: request(operation: "handshake")
  )
  #expect(response.exitCode == 0)
  let object = try #require(JSONSerialization.jsonObject(with: response.data) as? [String: Any])
  #expect(object["protocolVersion"] as? Int == 1)
  #expect(object["ok"] as? Bool == true)
  let result = try #require(object["result"] as? [String: Any])
  let capabilities = try #require(result["capabilities"] as? [String: Any])
  #expect(capabilities["simulatorMutation"] as? Bool == false)
  #expect(capabilities["runtimeDownloads"] as? Bool == false)
  #expect(capabilities["operations"] as? [String] == ["handshake", "permission_status"])
  #expect(capabilities["capabilityInspection"] == nil)
  #expect(capabilities["liveCaptureSessions"] == nil)
}

@Test func versionTwoHandshakeAdvertisesInspectionWithoutCaptureMutation() throws {
  let response = NativeHost().process(
    arguments: ["rndevtools-native-host"],
    input: request(protocolVersion: 2, operation: "handshake")
  )
  #expect(response.exitCode == 0)
  let object = try #require(JSONSerialization.jsonObject(with: response.data) as? [String: Any])
  #expect(object["protocolVersion"] as? Int == 2)
  let result = try #require(object["result"] as? [String: Any])
  // Electron requires this to equal the manifest's appVersion; it is generated from package.json.
  #expect(result["helperVersion"] as? String == NativeHost.helperVersion)
  let capabilities = try #require(result["capabilities"] as? [String: Any])
  #expect(
    capabilities["operations"] as? [String]
      == ["handshake", "permission_status", "capability_status"]
  )
  #expect(capabilities["capabilityInspection"] as? Bool == true)
  #expect(capabilities["liveCaptureSessions"] as? Bool == false)
  #expect(capabilities["permissionPrompting"] as? Bool == false)
}

@Test func versionThreeAdvertisesAndValidatesBoundedImageComposition() throws {
  let handshake = NativeHost().process(
    arguments: ["rndevtools-native-host"],
    input: request(protocolVersion: 3, operation: "handshake")
  )
  #expect(handshake.exitCode == 0)
  let handshakeObject = try #require(
    JSONSerialization.jsonObject(with: handshake.data) as? [String: Any])
  let handshakeResult = try #require(handshakeObject["result"] as? [String: Any])
  let capabilities = try #require(handshakeResult["capabilities"] as? [String: Any])
  #expect(
    capabilities["operations"] as? [String]
      == ["handshake", "permission_status", "capability_status", "compose_image"]
  )
  #expect(capabilities["imageComposition"] as? Bool == true)
  #expect(capabilities["simulatorMutation"] as? Bool == false)

  let requestObject: [String: Any] = [
    "protocolVersion": 3,
    "requestId": "compose-test",
    "operation": "compose_image",
    "payload": [
      "workspaceToken": String(repeating: "a", count: 32),
      "primaryInput": "primary.png",
      "output": "output.png",
      "outputFormat": "png",
      "canvas": [
        "size": ["mode": "pixels", "width": 1290, "height": 2796],
        "background": ["kind": "solid", "color": "#000000"],
      ],
      "layout": [
        "padding": ["top": 80, "right": 80, "bottom": 80, "left": 80],
        "contentMode": "fit",
        "rotation": 0,
        "cornerRadius": 48,
        "bezel": "rndevtools-generic-v1",
      ],
    ],
  ]
  let response = NativeHost(imageComposer: StubImageComposer()).process(
    arguments: ["rndevtools-native-host"],
    input: try JSONSerialization.data(withJSONObject: requestObject)
  )
  #expect(response.exitCode == 0)
  let object = try #require(JSONSerialization.jsonObject(with: response.data) as? [String: Any])
  let result = try #require(object["result"] as? [String: Any])
  #expect(result["operation"] as? String == "compose_image")
  #expect(result["width"] as? Int == 1290)
  #expect(result["atomicCommit"] as? Bool == true)

  let versionTwo = NativeHost(imageComposer: StubImageComposer()).process(
    arguments: ["rndevtools-native-host"],
    input: try JSONSerialization.data(
      withJSONObject: requestObject.merging(["protocolVersion": 2]) { _, new in new })
  )
  #expect(versionTwo.exitCode == 2)
}

@Test(arguments: ["9223372036854775808", "-9223372036854775809", "1e300", "1.5", "true"])
func imageCompositionRejectsUnrepresentableIntegerFields(width: String) throws {
  let input = Data(
    """
    {"protocolVersion":3,"requestId":"integer-boundary","operation":"compose_image","payload":{
      "workspaceToken":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","primaryInput":"primary.png",
      "output":"output.png","outputFormat":"png",
      "canvas":{"size":{"mode":"pixels","width":\(width),"height":64},
        "background":{"kind":"transparent"}},
      "layout":{"padding":{"top":0,"right":0,"bottom":0,"left":0},
        "contentMode":"fit","rotation":0,"cornerRadius":0,"bezel":"none"}
    }}
    """.utf8)
  let response = NativeHost(imageComposer: StubImageComposer()).process(
    arguments: ["rndevtools-native-host"], input: input)
  #expect(response.exitCode == 1)
  let object = try #require(JSONSerialization.jsonObject(with: response.data) as? [String: Any])
  #expect(object["requestId"] as? String == "integer-boundary")
  let error = try #require(object["error"] as? [String: Any])
  #expect(error["code"] as? String == "invalid_payload")
}

@Test func permissionStatusUsesReadOnlyProvider() throws {
  let reader = StubPermissionReader(values: [
    PermissionStatus(id: "screen_recording", value: .granted, canPrompt: false)
  ])
  let response = NativeHost(permissionReader: reader).process(
    arguments: ["rndevtools-native-host"],
    input: request(operation: "permission_status")
  )
  #expect(response.exitCode == 0)
  let object = try #require(JSONSerialization.jsonObject(with: response.data) as? [String: Any])
  let result = try #require(object["result"] as? [String: Any])
  let statuses = try #require(result["statuses"] as? [[String: Any]])
  #expect(statuses.count == 1)
  #expect(statuses[0]["value"] as? String == "granted")
}

@Test func decoderRejectsUnknownFieldsAndArguments() throws {
  let unsafeInput = Data(
    #"{"protocolVersion":1,"requestId":"test","operation":"handshake","payload":{},"args":["delete"]}"#
      .utf8)
  let unknownField = NativeHost().process(arguments: ["rndevtools-native-host"], input: unsafeInput)
  #expect(unknownField.exitCode == 2)

  let arguments = NativeHost().process(
    arguments: ["rndevtools-native-host", "--command"], input: request(operation: "handshake"))
  #expect(arguments.exitCode == 2)
}

@Test func decoderBoundsInput() {
  let oversized = Data(repeating: 0x41, count: NativeProtocol.maximumRequestBytes + 1)
  let response = NativeHost().process(arguments: ["rndevtools-native-host"], input: oversized)
  #expect(response.exitCode == 2)
}

@Test func capabilityStatusIsVersionGatedBoundedAndReadOnly() throws {
  let fixture = capabilityFixture()
  let host = NativeHost(
    permissionReader: StubPermissionReader(values: []),
    capabilityReader: StubCapabilityReader(value: fixture)
  )
  let legacy = host.process(
    arguments: ["rndevtools-native-host"],
    input: request(operation: "capability_status")
  )
  #expect(legacy.exitCode == 2)

  let response = host.process(
    arguments: ["rndevtools-native-host"],
    input: request(protocolVersion: 2, operation: "capability_status")
  )
  #expect(response.exitCode == 0)
  #expect(response.data.count + 1 <= NativeProtocol.maximumResponseBytes)
  let object = try #require(JSONSerialization.jsonObject(with: response.data) as? [String: Any])
  let result = try #require(object["result"] as? [String: Any])
  let safety = try #require(result["safety"] as? [String: Any])
  #expect(safety["permissionPrompts"] as? Bool == false)
  #expect(safety["externalStateMutations"] as? Bool == false)
  #expect(safety["contentEnumerated"] as? Bool == false)
  #expect(safety["persistentSessions"] as? Bool == false)
  #expect(safety["networkPreferencesRead"] as? Bool == false)
}

@Test func capabilityStatusRejectsSelectorsAndFailsClosedOnOversizedOutput() throws {
  let selectedWindow = NativeHost().process(
    arguments: ["rndevtools-native-host"],
    input: Data(
      #"{"protocolVersion":2,"requestId":"selected-window","operation":"capability_status","payload":{"windowId":42}}"#
        .utf8)
  )
  #expect(selectedWindow.exitCode == 2)

  let oversizedFixture = capabilityFixture(
    operatingSystemVersion: String(repeating: "x", count: NativeProtocol.maximumResponseBytes)
  )
  let oversized = NativeHost(
    permissionReader: StubPermissionReader(values: []),
    capabilityReader: StubCapabilityReader(value: oversizedFixture)
  ).process(
    arguments: ["rndevtools-native-host"],
    input: request(protocolVersion: 2, operation: "capability_status")
  )
  #expect(oversized.exitCode == 1)
  #expect(oversized.data.count + 1 <= NativeProtocol.maximumResponseBytes)
  let object = try #require(JSONSerialization.jsonObject(with: oversized.data) as? [String: Any])
  let error = try #require(object["error"] as? [String: Any])
  #expect(error["code"] as? String == "response_too_large")
}

@Test func systemCapabilityReaderNeverClaimsUnperformedSensitiveWork() {
  let permissions = StubPermissionReader(values: [
    PermissionStatus(id: "accessibility", value: .notGranted, canPrompt: false),
    PermissionStatus(id: "screen_recording", value: .notGranted, canPrompt: false),
    PermissionStatus(id: "camera", value: .notDetermined, canPrompt: false),
    PermissionStatus(id: "microphone", value: .denied, canPrompt: false),
  ])
  let status = SystemCapabilityReader(permissionReader: permissions).status()
  #expect(status.screenCaptureKit.liveWindowCapture == .gated)
  #expect(status.screenCaptureKit.windowEnumerationPerformed == false)
  #expect(status.screenCaptureKit.contentPickerPresented == false)
  #expect(status.screenCaptureKit.persistentSessionOperationsExposed == false)
  #expect(status.avFoundation.permissionRequestsPerformed == false)
  #expect(status.accessibility.permissionPromptPerformed == false)
  #expect(status.buildInsights.sourceRootsInspected == false)
  #expect(status.buildInsights.xcodeProcessesLaunched == false)
  #expect(status.networkExtension.configurationInspection == .gated)
  #expect(status.networkExtension.trafficInterception == .gated)
  #expect(status.networkExtension.preferenceReadsPerformed == false)
  #expect(status.videoToolbox.codecs.map(\.id) == ["h264", "hevc"])
  #expect(status.videoToolbox.framesEncoded == 0)
}

private func request(
  protocolVersion: Int = 1,
  operation: String,
  payload: [String: Any] = [:]
) -> Data {
  try! JSONSerialization.data(withJSONObject: [
    "protocolVersion": protocolVersion,
    "requestId": "test-request",
    "operation": operation,
    "payload": payload,
  ])
}

private func simulatorMutationRequest() -> String {
  #"{"protocolVersion":2,"requestId":"mutation-1","operation":"disk_cleanup","payload":{"simulatorId":"AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE","categoryIds":["caches"],"confirmation":"CLEAN_SIMULATOR_DISK"}}"#
}

private func capabilityFixture(
  operatingSystemVersion: String = "15.0.0"
) -> NativeCapabilityStatusResult {
  NativeCapabilityStatusResult(
    checkedAtMilliseconds: 1,
    architecture: "arm64",
    operatingSystemVersion: operatingSystemVersion,
    screenCaptureKit: ScreenCaptureKitCapabilityStatus(
      frameworkAvailable: true,
      screenRecordingPermission: .granted,
      liveWindowCapture: .available,
      systemAudioCapture: .available,
      microphoneCapture: .available,
      requestableFrameRates: [30, 60],
      windowEnumerationPerformed: false,
      contentPickerPresented: false,
      persistentSessionOperationsExposed: false
    ),
    avFoundation: AVFoundationCapabilityStatus(
      frameworkAvailable: true,
      cameraPermission: .granted,
      microphonePermission: .granted,
      cameraDeviceAvailable: true,
      microphoneDeviceAvailable: true,
      cameraCapture: .available,
      microphoneCapture: .available,
      permissionRequestsPerformed: false
    ),
    videoToolbox: VideoToolboxCapabilityStatus(
      frameworkAvailable: true,
      referenceWidth: 1920,
      referenceHeight: 1080,
      probeKind: "hardware_realtime_configuration_acceptance",
      codecs: [
        VideoCodecCapabilityStatus(
          id: "h264",
          hardwareEncodeSupported: true,
          hardwareDecodeSupported: true,
          sessionCreationStatus: 0,
          acceptedRealtimeConfigurationFrameRates: [30, 60]
        )
      ],
      framesEncoded: 0
    ),
    accessibility: AccessibilityCapabilityStatus(
      frameworkAvailable: true,
      permission: .granted,
      elementInspection: .available,
      permissionPromptPerformed: false
    ),
    buildInsights: BuildInsightsCapabilityStatus(
      fseventsFrameworkAvailable: true,
      currentEventID: "1",
      pathScopedObservation: .available,
      protectedPathObservation: .gated,
      requiresExplicitSourceRoots: true,
      fullDiskAccessPreflightAvailable: false,
      sourceRootsInspected: false,
      xcodeProcessesLaunched: false
    ),
    networkExtension: NetworkExtensionCapabilityStatus(
      frameworkAvailable: true,
      vpnManagerAPIAvailable: true,
      packetTunnelProviderAPIAvailable: true,
      appProxyProviderAPIAvailable: true,
      contentFilterAPIAvailable: true,
      entitlementPresent: false,
      configurationInspection: .gated,
      trafficInterception: .gated,
      preferenceReadsPerformed: false
    ),
    safety: CapabilitySafetyStatus(
      permissionPrompts: false,
      externalStateMutations: false,
      contentEnumerated: false,
      persistentSessions: false,
      networkPreferencesRead: false
    )
  )
}

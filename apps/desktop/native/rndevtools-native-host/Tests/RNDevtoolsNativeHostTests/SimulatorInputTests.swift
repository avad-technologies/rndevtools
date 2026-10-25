import Foundation
import Testing

@testable import RNDevtoolsNativeHost

private let udid = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE"

private final class RecordingInputDriver: SimulatorInputDriving, @unchecked Sendable {
  private(set) var requests: [SimulatorInputRequest] = []
  var failure: NativeHostError?

  func send(_ request: SimulatorInputRequest, cancellation: any CancellationChecking) throws
    -> SimulatorInputResult
  {
    try cancellation.check()
    requests.append(request)
    if let failure { throw failure }
    return SimulatorInputResult(
      udid: request.udid, kind: "recorded", messages: 2, elapsedMilliseconds: 7, transport: .indigo)
  }
}

private func inputRequest(protocolVersion: Int = 5, payload: [String: Any]) -> Data {
  try! JSONSerialization.data(withJSONObject: [
    "protocolVersion": protocolVersion,
    "requestId": "input-test",
    "operation": "send_simulator_input",
    "payload": payload,
  ])
}

private func decoded(_ data: Data) throws -> [String: Any] {
  try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
}

@Test func decodesEveryInputKindAndNormalizesTheUDID() throws {
  let tap = try SimulatorInputRequest.decode([
    "kind": "tap", "udid": udid.lowercased(), "x": 0.25, "y": 1,
  ])
  #expect(tap == .tap(udid: udid, point: .init(x: 0.25, y: 1), holdMilliseconds: 40))

  let swipe = try SimulatorInputRequest.decode([
    "kind": "swipe", "udid": udid, "fromX": 0.5, "fromY": 0.9, "toX": 0.5, "toY": 0.2,
    "durationMilliseconds": 400, "steps": 20,
  ])
  #expect(
    swipe
      == .swipe(
        udid: udid, from: .init(x: 0.5, y: 0.9), to: .init(x: 0.5, y: 0.2),
        durationMilliseconds: 400,
        steps: 20))

  #expect(
    try SimulatorInputRequest.decode(["kind": "text", "udid": udid, "text": "Hi\n"])
      == .text(udid: udid, text: "Hi\n"))
  #expect(
    try SimulatorInputRequest.decode([
      "kind": "key", "udid": udid, "usage": 0x28, "modifiers": ["shift", "command"],
    ]) == .key(udid: udid, usage: 0x28, modifiers: [.shift, .command]))
  #expect(
    try SimulatorInputRequest.decode(["kind": "button", "udid": udid, "button": "volume-up"])
      == .button(udid: udid, button: .volumeUp))
}

@Test func rejectsMalformedInputPayloads() {
  let bad: [[String: Any]] = [
    ["kind": "tap", "udid": "booted", "x": 0.5, "y": 0.5],
    ["kind": "tap", "udid": udid, "x": 1.5, "y": 0.5],
    ["kind": "tap", "udid": udid, "x": 0.5, "y": -0.1],
    ["kind": "tap", "udid": udid, "x": 0.5, "y": 0.5, "button": "home"],
    [
      "kind": "swipe", "udid": udid, "fromX": 0.5, "fromY": 0.5, "toX": 0.5, "toY": 0.5, "steps": 1,
    ],
    ["kind": "text", "udid": udid, "text": ""],
    ["kind": "text", "udid": udid, "text": "héllo"],
    ["kind": "text", "udid": udid, "text": String(repeating: "a", count: 2_049)],
    ["kind": "key", "udid": udid, "usage": 0x03],
    ["kind": "key", "udid": udid, "usage": 0x04, "modifiers": ["shift", "shift"]],
    ["kind": "key", "udid": udid, "usage": 0x04, "modifiers": ["hyper"]],
    ["kind": "button", "udid": udid, "button": "power"],
    ["kind": "shake", "udid": udid],
  ]
  for payload in bad {
    #expect(throws: NativeHostError.self) { try SimulatorInputRequest.decode(payload) }
  }
}

@Test func keyboardLayoutMapsAsciiToHidUsagesWithShift() {
  #expect(KeyboardLayout.stroke(for: "a") == .init(usage: 0x04, modifiers: []))
  #expect(KeyboardLayout.stroke(for: "z") == .init(usage: 0x1D, modifiers: []))
  #expect(KeyboardLayout.stroke(for: "A") == .init(usage: 0x04, modifiers: [.shift]))
  #expect(KeyboardLayout.stroke(for: "1") == .init(usage: 0x1E, modifiers: []))
  #expect(KeyboardLayout.stroke(for: "0") == .init(usage: 0x27, modifiers: []))
  #expect(KeyboardLayout.stroke(for: "!") == .init(usage: 0x1E, modifiers: [.shift]))
  #expect(KeyboardLayout.stroke(for: " ") == .init(usage: 0x2C, modifiers: []))
  #expect(
    KeyboardLayout.stroke(for: "\n") == .init(usage: KeyboardLayout.returnUsage, modifiers: []))
  #expect(KeyboardLayout.stroke(for: "{") == .init(usage: 0x2F, modifiers: [.shift]))
  #expect(KeyboardLayout.stroke(for: "?") == .init(usage: 0x38, modifiers: [.shift]))
  #expect(KeyboardLayout.stroke(for: "é") == nil)
  #expect(SimulatorInputRequest.KeyModifier.shift.usage == 0xE1)
  #expect(SimulatorInputRequest.HardwareButton.home.indigoSource == 0x0)
  #expect(SimulatorInputRequest.HardwareButton.siri.indigoSource == 0x40_0002)
}

@Test func versionFiveRoutesInputToTheDriverAndOlderVersionsRefuseIt() throws {
  let driver = RecordingInputDriver()
  let host = NativeHost(inputDriver: driver)

  let handshake = host.process(
    arguments: ["rndevtools-native-host"],
    input: try! JSONSerialization.data(withJSONObject: [
      "protocolVersion": 5, "requestId": "h", "operation": "handshake", "payload": [:],
    ]))
  let handshakeResult = try #require(try decoded(handshake.data)["result"] as? [String: Any])
  let capabilities = try #require(handshakeResult["capabilities"] as? [String: Any])
  #expect((capabilities["operations"] as? [String])?.last == "send_simulator_input")
  #expect(capabilities["simulatorInput"] as? Bool == true)

  let ok = host.process(
    arguments: ["rndevtools-native-host"],
    input: inputRequest(payload: ["kind": "tap", "udid": udid, "x": 0.5, "y": 0.5]))
  #expect(ok.exitCode == 0)
  let result = try #require(try decoded(ok.data)["result"] as? [String: Any])
  #expect(result["messages"] as? Int == 2)
  #expect(driver.requests == [.tap(udid: udid, point: .init(x: 0.5, y: 0.5), holdMilliseconds: 40)])

  let old = host.process(
    arguments: ["rndevtools-native-host"],
    input: inputRequest(
      protocolVersion: 4, payload: ["kind": "tap", "udid": udid, "x": 0.5, "y": 0.5]))
  #expect(old.exitCode == 2)
  #expect(
    (try decoded(old.data)["error"] as? [String: Any])?["code"] as? String
      == "unsupported_operation")
  #expect(driver.requests.count == 1)

  let invalid = host.process(
    arguments: ["rndevtools-native-host"],
    input: inputRequest(payload: ["kind": "tap", "udid": udid, "x": 2, "y": 0.5]))
  #expect(invalid.exitCode == 1)
  #expect(
    (try decoded(invalid.data)["error"] as? [String: Any])?["code"] as? String == "invalid_payload")

  driver.failure = NativeHostError(code: "simulator_not_booted", message: "off", retryable: true)
  let failed = host.process(
    arguments: ["rndevtools-native-host"],
    input: inputRequest(payload: ["kind": "button", "udid": udid, "button": "home"]))
  #expect(failed.exitCode == 1)
  let error = try #require(try decoded(failed.data)["error"] as? [String: Any])
  #expect(error["code"] as? String == "simulator_not_booted")
  #expect(error["retryable"] as? Bool == true)
}

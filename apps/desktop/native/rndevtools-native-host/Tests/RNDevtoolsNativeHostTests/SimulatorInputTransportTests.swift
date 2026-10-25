import Foundation
import Testing

@testable import RNDevtoolsNativeHost

// MARK: - Transport selection

@Test("CoreSimulator before 1155.4 keeps the legacy Indigo transport")
func selectsIndigoBeforeDTUHID() {
  #expect(SimulatorInputTransportKind.select(coreSimulatorVersion: "1051.55") == .indigo)
  #expect(SimulatorInputTransportKind.select(coreSimulatorVersion: "1155.3") == .indigo)
  #expect(SimulatorInputTransportKind.select(coreSimulatorVersion: nil) == .indigo)
  #expect(SimulatorInputTransportKind.select(coreSimulatorVersion: "garbage") == .indigo)
}

@Test("CoreSimulator 1155.4 and later select dtuhidd, comparing components numerically")
func selectsDTUHIDFromXcode27() {
  #expect(SimulatorInputTransportKind.select(coreSimulatorVersion: "1155.4") == .dtuhid)
  #expect(SimulatorInputTransportKind.select(coreSimulatorVersion: "1155.10") == .dtuhid)
  #expect(SimulatorInputTransportKind.select(coreSimulatorVersion: "1200.1") == .dtuhid)
  #expect(SimulatorInputTransportKind.compareVersions("1155.10", "1155.4") > 0)
  #expect(SimulatorInputTransportKind.compareVersions("1155", "1155.0") == 0)
}

// MARK: - DTUHID payloads (the shape dtuhidd's Codable decode expects)

@Test("A digitizer event carries one contact as ratios with its phase, edge, and target")
func digitizerEnvelope() {
  let envelope = DTUHIDMessages.digitizer(x: 0.25, y: 0.75, phase: .start)
  #expect(envelope.messageType == "IndigoDigitizerEvent")
  #expect(envelope.isBarrier == false)
  #expect(envelope.featureIdentifier == "com.apple.coredevice.feature.remote.hid.digitizer")
  #expect(
    envelope.payload == [
      "pointOne": .dictionary(["x": .double(0.25), "y": .double(0.75)]),
      "eventType": .uint64(0),
      "edge": .uint64(0),
      "target": .uint64(0),
    ])
  #expect(envelope.payload["pointTwo"] == nil, "single-finger touches omit the second contact")
  #expect(DTUHIDMessages.digitizer(x: 0, y: 0, phase: .position).payload["eventType"] == .uint64(1))
  #expect(DTUHIDMessages.digitizer(x: 0, y: 0, phase: .end).payload["eventType"] == .uint64(2))
}

@Test("Keyboard events carry the USB HID usage and a 1=down / 2=up state")
func keyboardEnvelope() {
  let down = DTUHIDMessages.keyboard(usage: 0x28, down: true)
  #expect(down.messageType == "IndigoKeyboardButtonEvent")
  #expect(down.payload == ["usageCode": .uint64(0x28), "state": .uint64(1)])
  #expect(DTUHIDMessages.keyboard(usage: 0x28, down: false).payload["state"] == .uint64(2))
}

@Test("Hardware buttons map to consumer-page usages; Apple Pay has none on dtuhidd")
func buttonEnvelope() {
  let home = DTUHIDMessages.button(usagePage: 0x0C, usageCode: 0x40, down: true)
  #expect(home.messageType == "IndigoButtonEvent")
  #expect(
    home.payload == ["usagePage": .uint64(0x0C), "usageCode": .uint64(0x40), "state": .uint64(1)])
  #expect(
    SimulatorInputRequest.HardwareButton.home.consumerUsage.map { [$0.page, $0.code] } == [
      0x0C, 0x40,
    ])
  #expect(
    SimulatorInputRequest.HardwareButton.lock.consumerUsage.map { [$0.page, $0.code] } == [
      0x0C, 0x30,
    ])
  #expect(
    SimulatorInputRequest.HardwareButton.siri.consumerUsage.map { [$0.page, $0.code] } == [
      0x0C, 0xCF,
    ])
  #expect(
    SimulatorInputRequest.HardwareButton.volumeUp.consumerUsage.map { [$0.page, $0.code] } == [
      0x0C, 0xE9,
    ])
  #expect(
    SimulatorInputRequest.HardwareButton.volumeDown.consumerUsage.map { [$0.page, $0.code] } == [
      0x0C, 0xEA,
    ])
  #expect(SimulatorInputRequest.HardwareButton.applePay.consumerUsage == nil)
}

@Test("The liveness probe is a no-op key-up flagged as a barrier")
func barrierEnvelope() {
  let barrier = DTUHIDMessages.barrier()
  #expect(barrier.isBarrier)
  #expect(barrier.messageType == "IndigoKeyboardButtonEvent")
  #expect(barrier.payload == ["usageCode": .uint64(0), "state": .uint64(2)])
  let top = barrier.dictionary
  #expect(top["isBarrier"] == .bool(true))
  #expect(top["featureIdentifier"] == .string(DTUHIDMessages.digitizerService))
}

@Test("The envelope dictionary has exactly dtuhidd's four keys")
func envelopeKeys() {
  #expect(
    Set(DTUHIDMessages.digitizer(x: 0, y: 0, phase: .start).dictionary.keys)
      == ["messageType", "isBarrier", "featureIdentifier", "payload"])
}

@Test("The envelope round-trips into an xpc dictionary with matching value types")
func envelopeEncodesToXPC() {
  let object = DTUHIDTransport.xpcObject(
    from: DTUHIDMessages.digitizer(x: 0.5, y: 0.125, phase: .end))
  #expect(xpc_get_type(object) == XPC_TYPE_DICTIONARY)
  #expect(xpc_dictionary_get_bool(object, "isBarrier") == false)
  #expect(
    String(cString: xpc_dictionary_get_string(object, "messageType")!) == "IndigoDigitizerEvent")
  let payload = xpc_dictionary_get_value(object, "payload")!
  #expect(xpc_dictionary_get_uint64(payload, "eventType") == 2)
  let point = xpc_dictionary_get_value(payload, "pointOne")!
  #expect(xpc_dictionary_get_double(point, "x") == 0.5)
  #expect(xpc_dictionary_get_double(point, "y") == 0.125)
}

// MARK: - Contact tracking

@Test("A held finger reports start, then position moves, then end")
func contactTrackerPhases() {
  var tracker = DigitizerContactTracker()
  #expect(tracker.phase(forDown: true) == .start)
  #expect(tracker.phase(forDown: true) == .position)
  #expect(tracker.phase(forDown: true) == .position)
  #expect(tracker.phase(forDown: false) == .end)
  #expect(tracker.phase(forDown: true) == .start, "a new contact after lift is a fresh start")
}

// MARK: - Sequencing shared by both transports

private func events(for request: SimulatorInputRequest) throws -> (
  events: [SimulatorInputEvent], pauses: [Int]
) {
  var events: [SimulatorInputEvent] = []
  var pauses: [Int] = []
  try SimulatorInputSequencer.run(
    request, cancellation: NeverCancelled(), pause: { pauses.append($0) },
    deliver: { events.append($0) })
  return (events, pauses)
}

@Test("A tap is one contact down, the hold, and a lift at the same point")
func tapSequence() throws {
  let (events, pauses) = try events(
    for: .tap(udid: "U", point: .init(x: 0.3, y: 0.9), holdMilliseconds: 500))
  #expect(events == [.touch(x: 0.3, y: 0.9, down: true), .touch(x: 0.3, y: 0.9, down: false)])
  #expect(pauses == [500])
}

@Test("A swipe interpolates `steps` moves between the endpoints and lifts at the destination")
func swipeSequence() throws {
  let (events, _) = try events(
    for: .swipe(
      udid: "U", from: .init(x: 0, y: 0), to: .init(x: 1, y: 0.5), durationMilliseconds: 100,
      steps: 4))
  #expect(events.count == 6)
  #expect(events.first == .touch(x: 0, y: 0, down: true))
  #expect(events[2] == .touch(x: 0.5, y: 0.25, down: true))
  #expect(events.last == .touch(x: 1, y: 0.5, down: false))
}

@Test("Text becomes key down/up pairs with shift held around upper-case letters")
func textSequence() throws {
  let (events, _) = try events(for: .text(udid: "U", text: "aA"))
  #expect(
    events == [
      .key(usage: 0x04, down: true), .key(usage: 0x04, down: false),
      .key(usage: 0xE1, down: true), .key(usage: 0x04, down: true), .key(usage: 0x04, down: false),
      .key(usage: 0xE1, down: false),
    ])
}

@Test("A hardware button is a down, a hold, and an up")
func buttonSequence() throws {
  let (events, pauses) = try events(for: .button(udid: "U", button: .lock))
  #expect(events == [.button(.lock, down: true), .button(.lock, down: false)])
  #expect(pauses == [SimulatorInputSequencer.buttonHoldMilliseconds])
}

// MARK: - Lifting a gesture that stops part-way

/// Runs `request` and records every event offered to the transport. `onDeliver` sees each
/// attempt with its index and may throw to fail that delivery.
private func interruptedRun(
  _ request: SimulatorInputRequest,
  cancellation: CancellationToken = CancellationToken(),
  pause: (Int) -> Void = { _ in },
  onDeliver: (Int, SimulatorInputEvent) throws -> Void = { _, _ in }
) -> (attempts: [SimulatorInputEvent], error: NativeHostError?) {
  var attempts: [SimulatorInputEvent] = []
  do {
    try SimulatorInputSequencer.run(
      request, cancellation: cancellation, pause: pause,
      deliver: { event in
        attempts.append(event)
        try onDeliver(attempts.count - 1, event)
      })
  } catch {
    return (attempts, error as? NativeHostError)
  }
  return (attempts, nil)
}

private let wedged = NativeHostError(code: "simulator_input_failed", message: "no acknowledgement")

@Test("Cancelling during a long press still lifts the finger")
func cancelledTapLiftsTheFinger() {
  let cancellation = CancellationToken()
  let run = interruptedRun(
    .tap(udid: "U", point: .init(x: 0.3, y: 0.9), holdMilliseconds: 8_000),
    cancellation: cancellation, pause: { _ in cancellation.cancel() })
  #expect(run.error?.code == "cancelled")
  #expect(
    run.attempts == [.touch(x: 0.3, y: 0.9, down: true), .touch(x: 0.3, y: 0.9, down: false)])
}

@Test("Cancelling mid-swipe lifts the finger where it last was")
func cancelledSwipeLiftsAtTheLastPoint() {
  let cancellation = CancellationToken()
  let run = interruptedRun(
    .swipe(
      udid: "U", from: .init(x: 0, y: 0), to: .init(x: 1, y: 0.5), durationMilliseconds: 100,
      steps: 4),
    cancellation: cancellation,
    onDeliver: { index, _ in
      if index == 2 { cancellation.cancel() }
    })
  #expect(run.error?.code == "cancelled")
  #expect(run.attempts.count == 4)
  #expect(run.attempts.last == .touch(x: 0.5, y: 0.25, down: false))
}

@Test("Cancelled typing lifts the held key before the shift that modifies it")
func cancelledTextLiftsKeyThenModifier() {
  let cancellation = CancellationToken()
  let run = interruptedRun(
    .text(udid: "U", text: "AB"), cancellation: cancellation, pause: { _ in cancellation.cancel() })
  #expect(run.error?.code == "cancelled")
  #expect(
    run.attempts == [
      .key(usage: 0xE1, down: true), .key(usage: 0x04, down: true),
      .key(usage: 0x04, down: false), .key(usage: 0xE1, down: false),
    ])
}

@Test("A press the transport fails to acknowledge is still lifted, since it may have landed")
func failedPressIsStillLifted() {
  let run = interruptedRun(
    .button(udid: "U", button: .lock),
    onDeliver: { index, _ in
      if index == 0 { throw wedged }
    })
  #expect(run.error?.code == "simulator_input_failed")
  #expect(run.attempts == [.button(.lock, down: true), .button(.lock, down: false)])
}

@Test("The first refused lift ends the cleanup and the original error is reported")
func refusedLiftEndsTheCleanup() {
  let cancellation = CancellationToken()
  let run = interruptedRun(
    .key(udid: "U", usage: 0x28, modifiers: [.shift, .command]), cancellation: cancellation,
    pause: { _ in cancellation.cancel() },
    onDeliver: { index, _ in
      if index >= 3 { throw wedged }
    })
  #expect(run.error?.code == "cancelled")
  #expect(
    run.attempts == [
      .key(usage: 0xE1, down: true), .key(usage: 0xE3, down: true), .key(usage: 0x28, down: true),
      .key(usage: 0x28, down: false),
    ])
}

@Test("A gesture's pause wakes promptly once the request is cancelled")
func pauseWakesOnCancellation() {
  let driver = SimulatorKitInputDriver(developerDirectory: "/nonexistent")
  let held = DispatchTime.now()
  driver.pause(milliseconds: 30, cancellation: NeverCancelled())
  #expect(DispatchTime.now().uptimeNanoseconds - held.uptimeNanoseconds >= 30_000_000)

  let cancellation = CancellationToken()
  DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { cancellation.cancel() }
  let started = DispatchTime.now()
  driver.pause(milliseconds: 5_000, cancellation: cancellation)
  #expect(DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds < 1_000_000_000)
}

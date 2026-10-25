import Foundation

/// Input over SimulatorKit's `SimDeviceLegacyHIDClient`: Indigo HID messages built by the
/// framework's own `IndigoHIDMessageFor*` functions (buttons, keys) or hand-enveloped from
/// them (single touches). This is the path the guest accepts through CoreSimulator 1051
/// (Xcode 26); from 1155.4 Apple routes input through `dtuhidd` and the legacy client stops
/// delivering touches, so `DTUHIDTransport` takes over there.
final class IndigoTransport: SimulatorInputTransport {
  let kind: SimulatorInputTransportKind = .indigo

  private let client: AnyObject
  private let toolkit: SimulatorKitInputDriver.Toolkit
  private let queue: DispatchQueue

  init(device: AnyObject, toolkit: SimulatorKitInputDriver.Toolkit, queue: DispatchQueue) throws {
    self.client = try IndigoTransport.hidClient(for: device)
    self.toolkit = toolkit
    self.queue = queue
  }

  func deliver(_ event: SimulatorInputEvent) throws {
    switch event {
    case .touch(let x, let y, let down):
      try deliverMessage(touchMessage(SimulatorInputRequest.Point(x: x, y: y), down: down))
    case .key(let usage, let down):
      try deliverMessage(
        toolkit.messageForKeyboard(
          Int32(usage), down ? SimulatorKitInputDriver.eventDown : SimulatorKitInputDriver.eventUp))
    case .button(let button, let down):
      try deliverMessage(
        toolkit.messageForButton(
          button.indigoSource,
          down ? SimulatorKitInputDriver.eventDown : SimulatorKitInputDriver.eventUp,
          SimulatorKitInputDriver.hardwareTarget))
    }
  }

  /// Every Indigo message is acknowledged individually, so there is nothing left to drain.
  func finish() throws {}

  // MARK: - Session

  private static func hidClient(for device: AnyObject) throws -> AnyObject {
    guard let clientClass = NSClassFromString("SimulatorKit.SimDeviceLegacyHIDClient") else {
      throw unavailable("SimulatorKit has no SimDeviceLegacyHIDClient on this Xcode.")
    }
    guard
      let allocated = (clientClass as AnyObject).perform(NSSelectorFromString("alloc"))?
        .takeUnretainedValue()
    else {
      throw unavailable("SimDeviceLegacyHIDClient could not be allocated.")
    }
    var error: AnyObject?
    guard
      let client = unsafeBitCast(allocated, to: SimulatorKitInputDriver.HIDClientMessaging.self)
        .initWithDevice(device, error: &error)
    else {
      throw NativeHostError(
        code: "simulator_input_failed",
        message: "The Simulator refused a HID session: \(SimulatorKitInputDriver.describe(error)).",
        retryable: true)
    }
    return client
  }

  // MARK: - Delivery

  private func deliverMessage(_ message: UnsafeMutableRawPointer) throws {
    let semaphore = DispatchSemaphore(value: 0)
    var failure: Error?
    unsafeBitCast(client, to: SimulatorKitInputDriver.HIDClientMessaging.self).send(
      withMessage: message, freeWhenDone: true, completionQueue: queue
    ) { error in
      failure = error
      semaphore.signal()
    }
    guard
      semaphore.wait(timeout: .now() + SimulatorKitInputDriver.acknowledgementTimeout) == .success
    else {
      throw NativeHostError(
        code: "simulator_input_failed",
        message: "The Simulator did not acknowledge a HID message within 5s.",
        retryable: true)
    }
    if let failure {
      throw NativeHostError(
        code: "simulator_input_failed",
        message: "The Simulator rejected a HID message: \(failure).",
        retryable: true)
    }
  }

  /// A hand-enveloped single-touch Indigo message (eventType 2, 320 bytes). SimulatorKit only
  /// ships a multi-touch builder, so its digitizer contact is copied into a single-touch
  /// envelope and repeated once, marked as the second slot (field1=1, field2=2).
  private func touchMessage(_ point: SimulatorInputRequest.Point, down: Bool)
    -> UnsafeMutableRawPointer
  {
    var cgPoint = CGPoint(x: point.x, y: point.y)
    let source = toolkit.messageForMouse(
      &cgPoint, nil, SimulatorKitInputDriver.touchTarget,
      UInt(down ? SimulatorKitInputDriver.eventDown : SimulatorKitInputDriver.eventUp),
      CGSize(width: 1, height: 1), 0)
    source.storeBytes(of: point.x, toByteOffset: 0x3C, as: Double.self)
    source.storeBytes(of: point.y, toByteOffset: 0x44, as: Double.self)
    let stride = SimulatorKitInputDriver.payloadStride
    guard let message = calloc(1, SimulatorKitInputDriver.touchMessageSize) else {
      fatalError("calloc failed for a 320-byte Indigo message")
    }
    message.storeBytes(of: UInt32(stride), toByteOffset: 0x18, as: UInt32.self)
    message.storeBytes(of: UInt8(2), toByteOffset: 0x1C, as: UInt8.self)
    message.storeBytes(of: UInt32(0x0B), toByteOffset: 0x20, as: UInt32.self)
    message.storeBytes(of: mach_absolute_time(), toByteOffset: 0x24, as: UInt64.self)
    memcpy(message.advanced(by: 0x30), source.advanced(by: 0x30), stride - 0x10)
    free(source)
    memcpy(message.advanced(by: 0x20 + stride), message.advanced(by: 0x20), stride)
    message.storeBytes(of: UInt32(1), toByteOffset: 0x20 + stride + 0x10, as: UInt32.self)
    message.storeBytes(of: UInt32(2), toByteOffset: 0x20 + stride + 0x14, as: UInt32.self)
    return message
  }

  private static func unavailable(_ reason: String) -> NativeHostError {
    NativeHostError(code: "simulator_input_unavailable", message: reason)
  }
}

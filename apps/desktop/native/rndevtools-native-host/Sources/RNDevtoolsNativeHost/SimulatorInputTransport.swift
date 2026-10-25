import Foundation

/// How a Simulator input message reaches the guest.
///
/// Through CoreSimulator 1051 (Xcode 26) the guest accepts Indigo messages on
/// SimulatorKit's `SimDeviceLegacyHIDClient`. From CoreSimulator 1155.4 (Xcode 27) Apple
/// injects `dtuhidd` into the guest and the legacy client no longer delivers touches, so
/// input crosses as plain-XPC dictionaries on the device's digitizer service instead.
/// The selection is a property of the CoreSimulator version actually loaded in process,
/// not of the Xcode the request named, because the system framework is what talks to the
/// guest.
enum SimulatorInputTransportKind: String, Encodable {
  case indigo
  case dtuhid

  /// The first CoreSimulator that ships `dtuhidd` and drops legacy Indigo input.
  static let firstDTUHIDCoreSimulatorVersion = "1155.4"

  /// Picks the transport for a CoreSimulator `CFBundleVersion`. Versions compare
  /// numerically per dotted component so `1155.10` sorts above `1155.4`. An unreadable
  /// version keeps the legacy transport, which is also the one that fails loudly when it
  /// is wrong.
  static func select(coreSimulatorVersion: String?) -> SimulatorInputTransportKind {
    guard let coreSimulatorVersion,
      compareVersions(coreSimulatorVersion, firstDTUHIDCoreSimulatorVersion) >= 0
    else {
      return .indigo
    }
    return .dtuhid
  }

  static func compareVersions(_ lhs: String, _ rhs: String) -> Int {
    let left = lhs.split(separator: ".").map { Int($0) ?? 0 }
    let right = rhs.split(separator: ".").map { Int($0) ?? 0 }
    for index in 0..<max(left.count, right.count) {
      let l = index < left.count ? left[index] : 0
      let r = index < right.count ? right[index] : 0
      if l != r { return l < r ? -1 : 1 }
    }
    return 0
  }
}

/// A primitive HID event, independent of how it is encoded on the wire. The driver turns a
/// request (tap, swipe, text, key, button) into a sequence of these; each transport encodes
/// and delivers them.
enum SimulatorInputEvent: Equatable {
  /// Finger contact at a screen ratio. `down` is contact-or-move; `up` lifts.
  case touch(x: Double, y: Double, down: Bool)
  /// USB HID keyboard usage (page 0x07).
  case key(usage: UInt16, down: Bool)
  case button(SimulatorInputRequest.HardwareButton, down: Bool)
}

/// One delivery path for `SimulatorInputEvent`s to one booted device.
protocol SimulatorInputTransport {
  var kind: SimulatorInputTransportKind { get }
  /// Delivers one event and waits until the guest has it (or refuses it).
  func deliver(_ event: SimulatorInputEvent) throws
  /// Called once after the last event so queued messages reach the guest before the
  /// process exits.
  func finish() throws
}

// MARK: - DTUHID payloads

/// The plain-XPC envelope every `dtuhidd` message shares. Keys match `dtuhidd`'s `Codable`
/// decode: `messageType`, `isBarrier`, `featureIdentifier`, `payload`.
struct DTUHIDEnvelope: Equatable {
  let messageType: String
  let isBarrier: Bool
  let featureIdentifier: String
  let payload: [String: DTUHIDValue]

  var dictionary: [String: DTUHIDValue] {
    [
      "messageType": .string(messageType),
      "isBarrier": .bool(isBarrier),
      "featureIdentifier": .string(featureIdentifier),
      "payload": .dictionary(payload),
    ]
  }
}

/// The XPC value types `dtuhidd` payloads use. Kept as an enum so the encoding is testable
/// without libxpc: tests inspect the tree, the live transport walks it into `xpc_object_t`.
indirect enum DTUHIDValue: Equatable {
  case string(String)
  case bool(Bool)
  case uint64(UInt64)
  case double(Double)
  case dictionary([String: DTUHIDValue])
}

enum DTUHIDMessages {
  static let digitizerService = "com.apple.coredevice.feature.remote.hid.digitizer"

  /// `IndigoDigitizerEvent`: one contact as screen ratios plus its phase.
  /// `eventType`: 0 start, 1 position, 2 end. `edge`/`target` are 0 for the main screen.
  static func digitizer(x: Double, y: Double, phase: DigitizerPhase) -> DTUHIDEnvelope {
    DTUHIDEnvelope(
      messageType: "IndigoDigitizerEvent", isBarrier: false, featureIdentifier: digitizerService,
      payload: [
        "pointOne": .dictionary(["x": .double(x), "y": .double(y)]),
        "eventType": .uint64(phase.rawValue),
        "edge": .uint64(0),
        "target": .uint64(0),
      ])
  }

  /// `IndigoKeyboardButtonEvent`: a USB HID keyboard usage. `state`: 1 down, 2 up.
  static func keyboard(usage: UInt16, down: Bool) -> DTUHIDEnvelope {
    DTUHIDEnvelope(
      messageType: "IndigoKeyboardButtonEvent", isBarrier: false,
      featureIdentifier: digitizerService,
      payload: ["usageCode": .uint64(UInt64(usage)), "state": .uint64(down ? 1 : 2)])
  }

  /// `IndigoButtonEvent`: a hardware button as a consumer-page (0x0C) usage.
  static func button(usagePage: UInt16, usageCode: UInt16, down: Bool) -> DTUHIDEnvelope {
    DTUHIDEnvelope(
      messageType: "IndigoButtonEvent", isBarrier: false, featureIdentifier: digitizerService,
      payload: [
        "usagePage": .uint64(UInt64(usagePage)),
        "usageCode": .uint64(UInt64(usageCode)),
        "state": .uint64(down ? 1 : 2),
      ])
  }

  /// The liveness probe: a no-op key-up flagged as a barrier. `dtuhidd` replies to barriers,
  /// so an answered probe proves the demand-launched daemon is up and this connection reaches
  /// it; plain events get no reply.
  static func barrier() -> DTUHIDEnvelope {
    DTUHIDEnvelope(
      messageType: "IndigoKeyboardButtonEvent", isBarrier: true,
      featureIdentifier: digitizerService,
      payload: ["usageCode": .uint64(0), "state": .uint64(2)])
  }

  enum DigitizerPhase: UInt64 {
    case start = 0
    case position = 1
    case end = 2
  }
}

/// Tracks whether a finger is already on the glass so successive `down`s become
/// `position` moves rather than new `start`s, which `dtuhidd` would treat as a second contact.
struct DigitizerContactTracker: Equatable {
  private var active = false

  mutating func phase(forDown down: Bool) -> DTUHIDMessages.DigitizerPhase {
    guard down else {
      active = false
      return .end
    }
    if active { return .position }
    active = true
    return .start
  }
}

extension SimulatorInputRequest.HardwareButton {
  /// Consumer-page HID usage `dtuhidd` accepts for the button. Apple Pay is a double
  /// side-button press, not a usage, so it has none on this transport.
  var consumerUsage: (page: UInt16, code: UInt16)? {
    switch self {
    case .home: return (0x0C, 0x40)  // Menu
    case .lock: return (0x0C, 0x30)  // Power
    case .siri: return (0x0C, 0xCF)  // Voice Command
    case .volumeUp: return (0x0C, 0xE9)  // Volume Increment
    case .volumeDown: return (0x0C, 0xEA)  // Volume Decrement
    case .applePay: return nil
    }
  }
}

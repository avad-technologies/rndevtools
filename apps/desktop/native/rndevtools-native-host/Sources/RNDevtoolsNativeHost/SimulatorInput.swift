import Foundation

/// One Simulator input request from the desktop: a touch, a hardware button, or a
/// keyboard key, addressed to a Simulator by exact UDID.
///
/// Coordinates are normalized ratios of the device screen (0…1 from the top-left),
/// so the renderer and the CLI can compute them from any screenshot size without
/// knowing the device's point or pixel geometry. The host does no scaling.
///
/// Every input is a down/up pair the guest sees as a gesture: a tap is down+up at
/// one point, a swipe is down, a bounded series of moves, up. Text is a sequence of
/// keyboard events, so each character is an independent down/up the guest cannot
/// confuse with paste (which iOS 16+ gates behind an "Allow Paste" prompt).
enum SimulatorInputRequest: Equatable {
  struct Point: Equatable {
    let x: Double
    let y: Double
  }

  case tap(udid: String, point: Point, holdMilliseconds: Int)
  case swipe(udid: String, from: Point, to: Point, durationMilliseconds: Int, steps: Int)
  case text(udid: String, text: String)
  /// `usage` is a USB HID keyboard usage (page 0x07): 0x04 is `a`, 0x28 Return, 0x2A Delete.
  case key(udid: String, usage: UInt16, modifiers: [KeyModifier])
  case button(udid: String, button: HardwareButton)

  static let maximumTextCharacters = 2_048
  static let maximumSwipeSteps = 120
  static let maximumDurationMilliseconds = 10_000

  /// USB HID keyboard usages (page 0x07) for the modifiers the guest understands.
  /// SimulatorKit's keyboard builder takes HID usages, not HIToolbox virtual keycodes.
  enum KeyModifier: String, CaseIterable {
    case shift
    case control
    case option
    case command

    var usage: UInt16 {
      switch self {
      case .shift: return 0xE1
      case .control: return 0xE0
      case .option: return 0xE2
      case .command: return 0xE3
      }
    }
  }

  /// Indigo `ButtonEventSource` values for the hardware buttons a phone or tablet has.
  enum HardwareButton: String, CaseIterable {
    case home
    case lock
    case siri
    case volumeUp = "volume-up"
    case volumeDown = "volume-down"
    case applePay = "apple-pay"

    var indigoSource: Int32 {
      switch self {
      case .home: return 0x0
      case .lock: return 0x1
      case .siri: return 0x40_0002
      case .volumeUp: return 0x2
      case .volumeDown: return 0x3
      case .applePay: return 0x1F4
      }
    }
  }

  var udid: String {
    switch self {
    case .tap(let udid, _, _), .swipe(let udid, _, _, _, _), .text(let udid, _),
      .key(let udid, _, _), .button(let udid, _):
      return udid
    }
  }

  static func decode(_ payload: [String: Any]) throws -> SimulatorInputRequest {
    guard let udid = payload["udid"] as? String,
      udid.range(
        of: #"^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$"#,
        options: .regularExpression) != nil
    else {
      throw NativeHostError(
        code: "invalid_payload", message: "udid must be an exact Simulator UDID.")
    }
    guard let kind = payload["kind"] as? String else {
      throw NativeHostError(code: "invalid_payload", message: "kind is required.")
    }
    let allowed: Set<String>
    let request: SimulatorInputRequest
    switch kind {
    case "tap":
      allowed = ["kind", "udid", "x", "y", "holdMilliseconds"]
      let hold =
        try optionalInt(payload, "holdMilliseconds", range: 0...maximumDurationMilliseconds) ?? 40
      request = .tap(
        udid: udid.uppercased(), point: try point(payload, "x", "y"), holdMilliseconds: hold)
    case "swipe":
      allowed = ["kind", "udid", "fromX", "fromY", "toX", "toY", "durationMilliseconds", "steps"]
      let duration =
        try optionalInt(payload, "durationMilliseconds", range: 1...maximumDurationMilliseconds)
        ?? 250
      let steps = try optionalInt(payload, "steps", range: 2...maximumSwipeSteps) ?? 16
      request = .swipe(
        udid: udid.uppercased(),
        from: try point(payload, "fromX", "fromY"),
        to: try point(payload, "toX", "toY"),
        durationMilliseconds: duration,
        steps: steps)
    case "text":
      allowed = ["kind", "udid", "text"]
      guard let text = payload["text"] as? String, !text.isEmpty else {
        throw NativeHostError(code: "invalid_payload", message: "text must be a non-empty string.")
      }
      guard text.count <= maximumTextCharacters else {
        throw NativeHostError(
          code: "invalid_payload",
          message: "text must be at most \(maximumTextCharacters) characters.")
      }
      guard
        text.unicodeScalars.allSatisfy({
          $0.isASCII && ($0.value >= 0x20 || $0 == "\n" || $0 == "\t")
        })
      else {
        throw NativeHostError(
          code: "invalid_payload",
          message:
            "text must be printable ASCII (plus newline and tab); the Simulator keyboard has no key for other characters."
        )
      }
      request = .text(udid: udid.uppercased(), text: text)
    case "key":
      allowed = ["kind", "udid", "usage", "modifiers"]
      guard let code = payload["usage"] as? Int, (0x04...0xE7).contains(code) else {
        throw NativeHostError(
          code: "invalid_payload",
          message: "usage must be a USB HID keyboard usage (0x04…0xE7), e.g. 0x28 for Return.")
      }
      var modifiers: [KeyModifier] = []
      if let raw = payload["modifiers"] {
        guard let names = raw as? [String], names.count <= KeyModifier.allCases.count else {
          throw NativeHostError(
            code: "invalid_payload", message: "modifiers must be a short list of names.")
        }
        for name in names {
          guard let modifier = KeyModifier(rawValue: name), !modifiers.contains(modifier) else {
            throw NativeHostError(
              code: "invalid_payload",
              message: "modifiers may only contain shift, control, option, and command, each once.")
          }
          modifiers.append(modifier)
        }
      }
      request = .key(udid: udid.uppercased(), usage: UInt16(code), modifiers: modifiers)
    case "button":
      allowed = ["kind", "udid", "button"]
      guard let name = payload["button"] as? String, let button = HardwareButton(rawValue: name)
      else {
        throw NativeHostError(
          code: "invalid_payload",
          message:
            "button must be one of \(HardwareButton.allCases.map(\.rawValue).joined(separator: ", "))."
        )
      }
      request = .button(udid: udid.uppercased(), button: button)
    default:
      throw NativeHostError(
        code: "invalid_payload", message: "kind must be tap, swipe, text, key, or button.")
    }
    guard Set(payload.keys).isSubset(of: allowed) else {
      throw NativeHostError(
        code: "invalid_payload",
        message: "The input payload has fields that \(kind) does not accept.")
    }
    return request
  }

  private static func point(_ payload: [String: Any], _ xKey: String, _ yKey: String) throws
    -> Point
  {
    guard let x = ratio(payload[xKey]), let y = ratio(payload[yKey]) else {
      throw NativeHostError(
        code: "invalid_payload",
        message: "\(xKey) and \(yKey) must be screen ratios between 0 and 1.")
    }
    return Point(x: x, y: y)
  }

  private static func ratio(_ value: Any?) -> Double? {
    let number: Double
    if let double = value as? Double {
      number = double
    } else if let integer = value as? Int {
      number = Double(integer)
    } else {
      return nil
    }
    guard number.isFinite, (0...1).contains(number) else { return nil }
    return number
  }

  private static func optionalInt(
    _ payload: [String: Any], _ key: String, range: ClosedRange<Int>
  ) throws -> Int? {
    guard let raw = payload[key] else { return nil }
    guard let value = raw as? Int, range.contains(value) else {
      throw NativeHostError(
        code: "invalid_payload",
        message: "\(key) must be an integer between \(range.lowerBound) and \(range.upperBound).")
    }
    return value
  }
}

/// What the host reports back: how many HID messages were delivered and acknowledged.
struct SimulatorInputResult: Encodable {
  let udid: String
  let kind: String
  let messages: Int
  let elapsedMilliseconds: Int
  /// Which HID path carried the events; lets a caller tell an Xcode 26 host from an Xcode 27 one.
  let transport: SimulatorInputTransportKind
}

/// The HID delivery surface, so the host logic is testable without SimulatorKit.
protocol SimulatorInputDriving {
  func send(_ request: SimulatorInputRequest, cancellation: any CancellationChecking) throws
    -> SimulatorInputResult
}

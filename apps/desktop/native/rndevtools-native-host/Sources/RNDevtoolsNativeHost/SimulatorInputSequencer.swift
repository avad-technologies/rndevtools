import Foundation

/// Turns one input request into the ordered HID events every transport delivers, with the
/// pauses that make the guest read them as a human gesture (a tap holds, a swipe moves in
/// steps, a key stays down long enough to register). Transport-agnostic so the Indigo and
/// DTUHID paths produce identical gestures and the sequencing is testable without a device.
enum SimulatorInputSequencer {
  static let keyDownMilliseconds = 12
  static let keyGapMilliseconds = 8
  static let buttonHoldMilliseconds = 60
  static let swipeLiftMilliseconds = 30

  /// Checks cancellation before each event. When cancellation or a failed delivery stops the
  /// gesture part-way, whatever it still holds (the finger, keys, or a button) is lifted
  /// without that check, so a shared Simulator is never left with input stuck down. The
  /// first failed lift ends the cleanup: a transport that refused one would only spend its
  /// timeout on the next.
  static func run(
    _ request: SimulatorInputRequest,
    cancellation: any CancellationChecking,
    pause: (Int) -> Void,
    deliver: (SimulatorInputEvent) throws -> Void
  ) throws {
    var held = HeldInput()
    do {
      try sequence(request, pause: pause) { event in
        try cancellation.check()
        held.willDeliver(event)
        try deliver(event)
        held.didDeliver(event)
      }
    } catch {
      for release in held.releases {
        do {
          try deliver(release)
        } catch {
          break
        }
      }
      throw error
    }
  }

  private static func sequence(
    _ request: SimulatorInputRequest,
    pause: (Int) -> Void,
    deliver: (SimulatorInputEvent) throws -> Void
  ) throws {
    switch request {
    case .tap(_, let point, let hold):
      try deliver(.touch(x: point.x, y: point.y, down: true))
      pause(hold)
      try deliver(.touch(x: point.x, y: point.y, down: false))
    case .swipe(_, let from, let to, let duration, let steps):
      try deliver(.touch(x: from.x, y: from.y, down: true))
      let interval = max(1, duration / steps)
      for step in 1...steps {
        let fraction = Double(step) / Double(steps)
        pause(interval)
        try deliver(
          .touch(
            x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction,
            down: true))
      }
      pause(swipeLiftMilliseconds)
      try deliver(.touch(x: to.x, y: to.y, down: false))
    case .text(_, let text):
      for scalar in text.unicodeScalars {
        guard let stroke = KeyboardLayout.stroke(for: scalar) else { continue }
        try type(stroke, pause: pause, deliver: deliver)
      }
    case .key(_, let usage, let modifiers):
      try type(
        KeyboardLayout.Stroke(usage: usage, modifiers: modifiers), pause: pause, deliver: deliver)
    case .button(_, let button):
      try deliver(.button(button, down: true))
      pause(buttonHoldMilliseconds)
      try deliver(.button(button, down: false))
    }
  }

  private static func type(
    _ stroke: KeyboardLayout.Stroke, pause: (Int) -> Void,
    deliver: (SimulatorInputEvent) throws -> Void
  ) throws {
    for modifier in stroke.modifiers {
      try deliver(.key(usage: modifier.usage, down: true))
    }
    try deliver(.key(usage: stroke.usage, down: true))
    pause(keyDownMilliseconds)
    try deliver(.key(usage: stroke.usage, down: false))
    for modifier in stroke.modifiers.reversed() {
      try deliver(.key(usage: modifier.usage, down: false))
    }
    pause(keyGapMilliseconds)
  }
}

/// What a gesture stopped part-way still holds down. A press counts from the moment it is
/// attempted, since a down whose acknowledgement timed out may still have landed; a lift
/// counts only once it is delivered.
struct HeldInput {
  private var touch: SimulatorInputRequest.Point?
  private var keys: [UInt16] = []
  private var buttons: [SimulatorInputRequest.HardwareButton] = []

  mutating func willDeliver(_ event: SimulatorInputEvent) {
    switch event {
    case .touch(let x, let y, true):
      touch = SimulatorInputRequest.Point(x: x, y: y)
    case .key(let usage, true) where !keys.contains(usage):
      keys.append(usage)
    case .button(let button, true) where !buttons.contains(button):
      buttons.append(button)
    default:
      break
    }
  }

  mutating func didDeliver(_ event: SimulatorInputEvent) {
    switch event {
    case .touch(_, _, false):
      touch = nil
    case .key(let usage, false):
      keys.removeAll { $0 == usage }
    case .button(let button, false):
      buttons.removeAll { $0 == button }
    default:
      break
    }
  }

  /// The lifts that release everything still held: the finger where it last was, then keys
  /// and buttons in reverse press order, so the main key goes up before its modifiers.
  var releases: [SimulatorInputEvent] {
    var events: [SimulatorInputEvent] = []
    if let touch {
      events.append(.touch(x: touch.x, y: touch.y, down: false))
    }
    events += keys.reversed().map { .key(usage: $0, down: false) }
    events += buttons.reversed().map { .button($0, down: false) }
    return events
  }
}

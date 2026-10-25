import Darwin
import Foundation

/// Drives a Simulator over Indigo HID through SimulatorKit's runtime-only
/// `SimDeviceLegacyHIDClient`, the same transport Simulator.app uses for mouse
/// and keyboard, so the guest cannot tell these touches from a user's.
///
/// Nothing here links against Apple's private frameworks: CoreSimulator and
/// SimulatorKit are `dlopen`ed from the active developer directory and the
/// classes and C builders are resolved by name. If any of that is missing the
/// driver reports `simulator_input_unavailable` with the reason, and the
/// desktop falls back to telling the user what the toolchain lacks.
///
/// Message layouts follow the publicly reverse-engineered Indigo wire format
/// (idb's `Indigo.h`): a single-touch message is 320 bytes with the digitizer
/// contact at 0x30, repeated once at 0xB0; buttons and keys come straight from
/// SimulatorKit's own `IndigoHIDMessageFor*` builders.
final class SimulatorKitInputDriver: SimulatorInputDriving {
  @objc private protocol ServiceContextMessaging {
    @objc(sharedServiceContextForDeveloperDir:error:)
    static func shared(
      forDeveloperDir dir: String, error: AutoreleasingUnsafeMutablePointer<AnyObject?>?
    )
      -> AnyObject?
    @objc(defaultDeviceSetWithError:)
    func defaultDeviceSet(error: AutoreleasingUnsafeMutablePointer<AnyObject?>?) -> AnyObject?
  }
  @objc private protocol DeviceSetMessaging {
    @objc var devices: [AnyObject] { get }
  }
  @objc private protocol DeviceMessaging {
    @objc(UDID) var udid: UUID { get }
    @objc var state: UInt64 { get }
  }
  @objc protocol HIDClientMessaging {
    @objc(initWithDevice:error:)
    func initWithDevice(_ device: Any, error: AutoreleasingUnsafeMutablePointer<AnyObject?>?)
      -> AnyObject?
    @objc(sendWithMessage:freeWhenDone:completionQueue:completion:)
    func send(
      withMessage message: UnsafeMutableRawPointer, freeWhenDone: Bool,
      completionQueue: DispatchQueue,
      completion: @escaping (Error?) -> Void)
  }

  typealias ButtonBuilder = @convention(c) (Int32, Int32, Int32) -> UnsafeMutableRawPointer
  typealias KeyboardBuilder = @convention(c) (Int32, Int32) -> UnsafeMutableRawPointer
  typealias MouseBuilder =
    @convention(c) (
      UnsafeMutablePointer<CGPoint>?, UnsafeMutablePointer<CGPoint>?, UInt32, UInt, CGSize, UInt32
    ) -> UnsafeMutableRawPointer

  /// SimDevice.state for a booted device (SimDeviceState enum: 3 = Booted).
  private static let bootedState: UInt64 = 3
  /// The digitizer HID service target the mouse/touch builder addresses.
  static let touchTarget: UInt32 = 0x32
  /// `ButtonEventTargetHardware`: where home, lock, and volume go.
  static let hardwareTarget: Int32 = 0x33
  static let eventDown: Int32 = 1
  static let eventUp: Int32 = 2
  static let payloadStride = 0x90
  static let touchMessageSize = 0x20 + 0x90 + 0x90
  static let acknowledgementTimeout: DispatchTimeInterval = .seconds(5)

  private let developerDirectory: String
  private let queue = DispatchQueue(label: "dev.rndevtools.native-host.simulator-input")

  init(developerDirectory: String? = nil) {
    self.developerDirectory =
      developerDirectory
      ?? ProcessInfo.processInfo.environment["DEVELOPER_DIR"]
      ?? SimulatorKitInputDriver.activeDeveloperDirectory()
      ?? "/Applications/Xcode.app/Contents/Developer"
  }

  func send(_ request: SimulatorInputRequest, cancellation: any CancellationChecking) throws
    -> SimulatorInputResult
  {
    let started = DispatchTime.now()
    try loadCoreSimulator()
    let device = try bootedDevice(udid: request.udid)
    let transport = try openTransport(for: device)
    var delivered = 0
    do {
      try SimulatorInputSequencer.run(
        request,
        cancellation: cancellation,
        pause: { self.pause(milliseconds: $0, cancellation: cancellation) },
        deliver: { event in
          try transport.deliver(event)
          delivered += 1
        })
    } catch {
      // Lets the lifts the sequencer sent on the way out reach the guest before exit.
      try? transport.finish()
      throw error
    }
    try transport.finish()
    let elapsed = Int(
      (DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000)
    return SimulatorInputResult(
      udid: request.udid, kind: SimulatorKitInputDriver.kindName(request), messages: delivered,
      elapsedMilliseconds: elapsed, transport: transport.kind)
  }

  /// Picks the transport the loaded CoreSimulator supports. The decision is made on the
  /// framework version actually in process (`SimDevice`'s bundle), because that is what talks
  /// to the guest; a `DEVELOPER_DIR` pointing at another Xcode does not change it. An explicit
  /// `RNDEVTOOLS_SIMULATOR_INPUT_TRANSPORT=indigo|dtuhid` overrides the choice for diagnosis.
  private func openTransport(for device: AnyObject) throws -> any SimulatorInputTransport {
    let override = ProcessInfo.processInfo.environment["RNDEVTOOLS_SIMULATOR_INPUT_TRANSPORT"]
      .flatMap(SimulatorInputTransportKind.init(rawValue:))
    let selected =
      override
      ?? SimulatorInputTransportKind.select(
        coreSimulatorVersion: SimulatorKitInputDriver.loadedCoreSimulatorVersion())
    switch selected {
    case .dtuhid:
      return try DTUHIDTransport(device: device)
    case .indigo:
      return try IndigoTransport(device: device, toolkit: loadToolkit(), queue: queue)
    }
  }

  /// `CFBundleVersion` of the CoreSimulator framework that vends `SimDevice`, e.g. `"1051.55"`.
  static func loadedCoreSimulatorVersion() -> String? {
    guard let deviceClass = NSClassFromString("SimDevice") else { return nil }
    return Bundle(for: deviceClass).infoDictionary?["CFBundleVersion"] as? String
  }

  // MARK: - Toolkit loading

  struct Toolkit {
    let messageForButton: ButtonBuilder
    let messageForKeyboard: KeyboardBuilder
    let messageForMouse: MouseBuilder
  }

  private func loadCoreSimulator() throws {
    guard
      dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW)
        != nil
    else {
      throw unavailable("CoreSimulator.framework could not be loaded (\(dlErrorText())).")
    }
  }

  private func loadToolkit() throws -> Toolkit {
    let simulatorKitPath =
      "\(developerDirectory)/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"
    guard let handle = dlopen(simulatorKitPath, RTLD_NOW) else {
      throw unavailable(
        "SimulatorKit.framework could not be loaded from \(developerDirectory) (\(dlErrorText())).")
    }
    func symbol<T>(_ name: String, as type: T.Type) throws -> T {
      guard let pointer = dlsym(handle, name) else {
        throw unavailable("SimulatorKit does not export \(name) on this Xcode.")
      }
      return unsafeBitCast(pointer, to: type)
    }
    return Toolkit(
      messageForButton: try symbol("IndigoHIDMessageForButton", as: ButtonBuilder.self),
      messageForKeyboard: try symbol(
        "IndigoHIDMessageForKeyboardArbitrary", as: KeyboardBuilder.self),
      messageForMouse: try symbol("IndigoHIDMessageForMouseNSEvent", as: MouseBuilder.self))
  }

  private func bootedDevice(udid: String) throws -> AnyObject {
    guard let contextClass = NSClassFromString("SimServiceContext") else {
      throw unavailable("CoreSimulator has no SimServiceContext class.")
    }
    var error: AnyObject?
    guard
      let context = unsafeBitCast(contextClass, to: ServiceContextMessaging.Type.self)
        .shared(forDeveloperDir: developerDirectory, error: &error)
    else {
      throw unavailable(
        "CoreSimulator refused a service context: \(SimulatorKitInputDriver.describe(error)).")
    }
    guard
      let set = unsafeBitCast(context, to: ServiceContextMessaging.self).defaultDeviceSet(
        error: &error)
    else {
      throw unavailable(
        "CoreSimulator refused the default device set: \(SimulatorKitInputDriver.describe(error)).")
    }
    let devices = unsafeBitCast(set, to: DeviceSetMessaging.self).devices
    guard
      let device = devices.first(where: {
        unsafeBitCast($0, to: DeviceMessaging.self).udid.uuidString.uppercased()
          == udid.uppercased()
      })
    else {
      throw NativeHostError(
        code: "simulator_not_found", message: "No Simulator with UDID \(udid) exists.")
    }
    guard
      unsafeBitCast(device, to: DeviceMessaging.self).state == SimulatorKitInputDriver.bootedState
    else {
      throw NativeHostError(
        code: "simulator_not_booted",
        message: "Simulator \(udid) is not booted; input needs a running device.",
        retryable: true)
    }
    return device
  }

  // MARK: - Helpers

  /// Holds a gesture for up to 10 s, waking within 10 ms of cancellation so the sequencer can
  /// lift what is held before Electron follows SIGTERM with SIGKILL.
  func pause(milliseconds: Int, cancellation: any CancellationChecking) {
    guard milliseconds > 0 else { return }
    let deadline =
      DispatchTime.now().uptimeNanoseconds + UInt64(min(milliseconds, 10_000)) * 1_000_000
    while (try? cancellation.check()) != nil {
      let now = DispatchTime.now().uptimeNanoseconds
      guard now < deadline else { return }
      usleep(useconds_t(min(deadline - now, 10_000_000) / 1_000))
    }
  }

  private func unavailable(_ reason: String) -> NativeHostError {
    NativeHostError(code: "simulator_input_unavailable", message: reason)
  }

  static func describe(_ error: AnyObject?) -> String {
    guard let error else { return "no error details" }
    return (error as? NSError)?.localizedDescription ?? String(describing: error)
  }

  private func dlErrorText() -> String {
    guard let text = dlerror() else { return "unknown dlopen error" }
    return String(cString: text)
  }

  private static func kindName(_ request: SimulatorInputRequest) -> String {
    switch request {
    case .tap: return "tap"
    case .swipe: return "swipe"
    case .text: return "text"
    case .key: return "key"
    case .button: return "button"
    }
  }

  private static func activeDeveloperDirectory() -> String? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
    process.arguments = ["-p"]
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    do {
      try process.run()
    } catch {
      return nil
    }
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { return nil }
    let output = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
}

/// US ANSI layout: printable ASCII to USB HID keyboard usages (page 0x07), with shift where
/// the character needs it. Verified on the Simulator: SimulatorKit's keyboard builder takes
/// HID usages (0x04 = a, 0x1E = 1, 0x2C = space, 0x28 = Return, 0x2A = Delete), not HIToolbox
/// virtual keycodes. Text is typed as discrete key events so the guest treats it as typing
/// rather than a paste.
enum KeyboardLayout {
  struct Stroke: Equatable {
    let usage: UInt16
    let modifiers: [SimulatorInputRequest.KeyModifier]
  }

  static let returnUsage: UInt16 = 0x28

  private static let plain: [Character: UInt16] = {
    var table: [Character: UInt16] = [:]
    for (offset, letter) in "abcdefghijklmnopqrstuvwxyz".enumerated() {
      table[letter] = UInt16(0x04 + offset)
    }
    for (offset, digit) in "1234567890".enumerated() {
      table[digit] = UInt16(0x1E + offset)
    }
    table["\n"] = returnUsage
    table["\t"] = 0x2B
    table[" "] = 0x2C
    table["-"] = 0x2D
    table["="] = 0x2E
    table["["] = 0x2F
    table["]"] = 0x30
    table["\\"] = 0x31
    table[";"] = 0x33
    table["'"] = 0x34
    table["`"] = 0x35
    table[","] = 0x36
    table["."] = 0x37
    table["/"] = 0x38
    return table
  }()

  private static let shifted: [Character: Character] = {
    var table: [Character: Character] = [:]
    for (upper, lower) in zip("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz") {
      table[upper] = lower
    }
    for (symbol, base) in zip("!@#$%^&*()", "1234567890") {
      table[symbol] = base
    }
    table["_"] = "-"
    table["+"] = "="
    table["{"] = "["
    table["}"] = "]"
    table["|"] = "\\"
    table[":"] = ";"
    table["\""] = "'"
    table["~"] = "`"
    table["<"] = ","
    table[">"] = "."
    table["?"] = "/"
    return table
  }()

  static func stroke(for scalar: Unicode.Scalar) -> Stroke? {
    let character = Character(scalar)
    if let usage = plain[character] {
      return Stroke(usage: usage, modifiers: [])
    }
    if let base = shifted[character], let usage = plain[base] {
      return Stroke(usage: usage, modifiers: [.shift])
    }
    return nil
  }
}

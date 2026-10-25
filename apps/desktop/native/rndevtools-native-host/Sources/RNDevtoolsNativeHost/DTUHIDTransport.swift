import Foundation
import XPC

/// Input over `dtuhidd`, the HID daemon CoreSimulator 1155.4+ (Xcode 27) injects into the
/// guest. Messages are plain-XPC dictionaries sent on the device's digitizer service.
///
/// Reaching the service: its Mach port is looked up in the Simulator's bootstrap namespace
/// (`-[SimDevice lookup:error:]`), wrapped by libxpc's private
/// `xpc_endpoint_create_mach_port_4sim`, and the connection marked simulator-to-host with
/// `xpc_connection_enable_sim2host_4sim`. Without that flag the daemon sees the peer but
/// never a payload. Both functions are resolved by name from the running process, so a macOS
/// without them reports `simulator_input_unavailable` instead of failing to load.
///
/// `dtuhidd` is demand-launched, so the first connection after boot can race it: the
/// transport proves liveness with a barrier message the daemon replies to, retrying with a
/// backoff that respects the daemon's 10 s minimum runtime before launchd will relaunch it.
final class DTUHIDTransport: SimulatorInputTransport {
  @objc private protocol DeviceLookupMessaging {
    @objc(lookup:error:)
    func lookup(_ service: String, error: AutoreleasingUnsafeMutablePointer<AnyObject?>?) -> UInt32
  }

  private typealias EndpointFromPort =
    @convention(c) (mach_port_t, UInt64, UInt64) -> Unmanaged<AnyObject>?
  private typealias ConnectionFromEndpoint = @convention(c) (xpc_object_t) -> Unmanaged<AnyObject>?
  private typealias EnableSim2Host = @convention(c) (xpc_connection_t) -> Void

  enum Timing {
    static let livenessTimeout: DispatchTimeInterval = .seconds(4)
    static let livenessAttempts = 5
    static let livenessRetryBackoff: UInt32 = 4  // seconds
    /// After an answered probe, the time the guest needs before the first real event lands.
    static let replyTailMilliseconds: UInt32 = 200
    /// Queued events need this long to cross into the guest before the process exits.
    static let drainMilliseconds: UInt32 = 80
  }

  let kind: SimulatorInputTransportKind = .dtuhid

  private let connection: xpc_connection_t
  private let queue = DispatchQueue(label: "dev.rndevtools.native-host.dtuhid")
  private var contact = DigitizerContactTracker()
  private var sentSinceDrain = 0

  /// Connects to `device`'s digitizer service and confirms `dtuhidd` answers.
  init(device: AnyObject, sleep: (UInt32) -> Void = { Foundation.sleep($0) }) throws {
    var lastFailure: NativeHostError?
    var connected: xpc_connection_t?
    for attempt in 1...Timing.livenessAttempts {
      let candidate = try DTUHIDTransport.connect(device: device)
      do {
        try DTUHIDTransport.confirmLiveness(candidate, queue: queue)
        connected = candidate
        break
      } catch let error as NativeHostError {
        xpc_connection_cancel(candidate)
        lastFailure = error
        if attempt < Timing.livenessAttempts { sleep(Timing.livenessRetryBackoff) }
      }
    }
    guard let connected else {
      throw NativeHostError(
        code: "simulator_input_failed",
        message:
          "dtuhidd did not answer a liveness probe after \(Timing.livenessAttempts) attempts: \(lastFailure?.message ?? "no reply").",
        retryable: true)
    }
    connection = connected
    usleep(Timing.replyTailMilliseconds * 1_000)
  }

  func deliver(_ event: SimulatorInputEvent) throws {
    let envelope: DTUHIDEnvelope
    switch event {
    case .touch(let x, let y, let down):
      envelope = DTUHIDMessages.digitizer(x: x, y: y, phase: contact.phase(forDown: down))
    case .key(let usage, let down):
      envelope = DTUHIDMessages.keyboard(usage: usage, down: down)
    case .button(let button, let down):
      guard let usage = button.consumerUsage else {
        throw NativeHostError(
          code: "invalid_payload",
          message:
            "apple-pay is a double side-button press on this Simulator; send button lock twice instead."
        )
      }
      envelope = DTUHIDMessages.button(usagePage: usage.page, usageCode: usage.code, down: down)
    }
    xpc_connection_send_message(connection, DTUHIDTransport.xpcObject(from: envelope))
    sentSinceDrain += 1
    // A send barrier resolves once libxpc has handed the message to the kernel, which keeps
    // a swipe's moves ordered against its own pauses.
    let barrier = DispatchSemaphore(value: 0)
    xpc_connection_send_barrier(connection) { barrier.signal() }
    guard barrier.wait(timeout: .now() + Timing.livenessTimeout) == .success else {
      throw NativeHostError(
        code: "simulator_input_failed", message: "dtuhidd stopped accepting messages.",
        retryable: true)
    }
  }

  func finish() throws {
    if sentSinceDrain > 0 {
      usleep(Timing.drainMilliseconds * 1_000)
      sentSinceDrain = 0
    }
    xpc_connection_cancel(connection)
  }

  // MARK: - Connection

  private static func connect(device: AnyObject) throws -> xpc_connection_t {
    guard let handle = dlopen(nil, RTLD_NOW) else {
      throw NativeHostError(
        code: "simulator_input_unavailable", message: "libxpc could not be opened.")
    }
    defer { dlclose(handle) }
    func symbol<T>(_ name: String, as type: T.Type) throws -> T {
      guard let pointer = dlsym(handle, name) else {
        throw NativeHostError(
          code: "simulator_input_unavailable",
          message: "This macOS does not export \(name); Simulator XPC input needs it.")
      }
      return unsafeBitCast(pointer, to: type)
    }
    let endpointFromPort = try symbol(
      "xpc_endpoint_create_mach_port_4sim", as: EndpointFromPort.self)
    let connectionFromEndpoint = try symbol(
      "xpc_connection_create_from_endpoint", as: ConnectionFromEndpoint.self)
    let enableSim2Host = try symbol("xpc_connection_enable_sim2host_4sim", as: EnableSim2Host.self)

    var error: AnyObject?
    let port = unsafeBitCast(device, to: DeviceLookupMessaging.self)
      .lookup(DTUHIDMessages.digitizerService, error: &error)
    guard port != MACH_PORT_NULL else {
      let detail =
        (error as? NSError)?.localizedDescription ?? "the service is not registered in the guest"
      throw NativeHostError(
        code: "simulator_input_unavailable",
        message: "The Simulator does not vend \(DTUHIDMessages.digitizerService) (\(detail)).")
    }
    guard let endpoint = endpointFromPort(port, 0, 0)?.takeRetainedValue() as? xpc_object_t,
      let connection = connectionFromEndpoint(endpoint)?.takeRetainedValue() as? xpc_connection_t
    else {
      throw NativeHostError(
        code: "simulator_input_failed",
        message: "libxpc refused a connection to the digitizer service.",
        retryable: true)
    }
    enableSim2Host(connection)
    return connection
  }

  private static func confirmLiveness(_ connection: xpc_connection_t, queue: DispatchQueue) throws {
    xpc_connection_set_event_handler(connection) { _ in }
    xpc_connection_set_target_queue(connection, queue)
    xpc_connection_resume(connection)
    let answered = DispatchSemaphore(value: 0)
    let outcome = ReplyBox()
    xpc_connection_send_message_with_reply(
      connection, xpcObject(from: DTUHIDMessages.barrier()), queue
    ) { reply in
      if xpc_get_type(reply) == XPC_TYPE_ERROR {
        outcome.failure =
          xpc_dictionary_get_string(reply, XPC_ERROR_KEY_DESCRIPTION).map { String(cString: $0) }
          ?? "XPC error"
      }
      answered.signal()
    }
    guard answered.wait(timeout: .now() + Timing.livenessTimeout) == .success else {
      throw NativeHostError(
        code: "simulator_input_failed", message: "no reply within 4s", retryable: true)
    }
    if let failure = outcome.failure {
      throw NativeHostError(code: "simulator_input_failed", message: failure, retryable: true)
    }
  }

  /// Carries the reply handler's verdict back across the semaphore. The handler runs on
  /// `queue` and the reader waits on the semaphore, so the write is complete before the read.
  private final class ReplyBox: @unchecked Sendable {
    var failure: String?
  }

  // MARK: - Encoding

  static func xpcObject(from envelope: DTUHIDEnvelope) -> xpc_object_t {
    xpcObject(from: .dictionary(envelope.dictionary))
  }

  private static func xpcObject(from value: DTUHIDValue) -> xpc_object_t {
    switch value {
    case .string(let string): return string.withCString { xpc_string_create($0) }
    case .bool(let bool): return xpc_bool_create(bool)
    case .uint64(let number): return xpc_uint64_create(number)
    case .double(let number): return xpc_double_create(number)
    case .dictionary(let entries):
      let dictionary = xpc_dictionary_create(nil, nil, 0)
      for (key, entry) in entries {
        key.withCString { xpc_dictionary_set_value(dictionary, $0, xpcObject(from: entry)) }
      }
      return dictionary
    }
  }
}

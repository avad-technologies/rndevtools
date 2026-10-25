import Foundation

enum NativeProtocol {
  static let legacyVersion = 1
  static let inspectionVersion = 2
  static let compositionVersion = 3
  static let mutationBrokerVersion = 4
  static let simulatorInputVersion = 5
  static let supportedVersions: Set<Int> = [
    legacyVersion, inspectionVersion, compositionVersion, mutationBrokerVersion,
    simulatorInputVersion,
  ]
  static let maximumRequestBytes = 96 * 1024
  static let maximumResponseBytes = 256 * 1024
  static let maximumMutationResponseBytes = 8 * 1024 * 1024
}

enum NativeOperation: String, Encodable {
  case handshake
  case permissionStatus = "permission_status"
  case capabilityStatus = "capability_status"
  case composeImage = "compose_image"
  case runSimulatorMutation = "run_simulator_mutation"
  case sendSimulatorInput = "send_simulator_input"
}

struct NativeRequest {
  let protocolVersion: Int
  let requestID: String
  let operation: NativeOperation
  let payload: [String: Any]

  static func decode(_ data: Data) throws -> NativeRequest {
    guard !data.isEmpty else {
      throw NativeHostError(code: "empty_request", message: "The native-host request is empty.")
    }
    guard data.count <= NativeProtocol.maximumRequestBytes else {
      throw NativeHostError(
        code: "request_too_large", message: "The native-host request exceeds 96 KiB.")
    }

    let json: Any
    do {
      json = try JSONSerialization.jsonObject(with: data, options: [])
    } catch {
      throw NativeHostError(
        code: "invalid_request", message: "The native-host request is not valid protocol JSON.")
    }
    guard let object = json as? [String: Any] else {
      throw NativeHostError(
        code: "invalid_request", message: "The native-host request must be a JSON object.")
    }
    let expectedKeys: Set<String> = ["protocolVersion", "requestId", "operation", "payload"]
    guard Set(object.keys) == expectedKeys else {
      throw NativeHostError(
        code: "invalid_request", message: "The native-host request has missing or unknown fields.")
    }
    guard let protocolVersion = object["protocolVersion"] as? Int,
      NativeProtocol.supportedVersions.contains(protocolVersion)
    else {
      throw NativeHostError(
        code: "unsupported_protocol_version", message: "The protocol version is not supported.")
    }
    guard let requestID = object["requestId"] as? String,
      requestID.range(of: #"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$"#, options: .regularExpression)
        != nil
    else {
      throw NativeHostError(code: "invalid_request_id", message: "requestId has an invalid format.")
    }
    guard let operationValue = object["operation"] as? String,
      let operation = NativeOperation(rawValue: operationValue)
    else {
      throw NativeHostError(
        code: "unsupported_operation",
        message: "The requested native-host operation is not supported.")
    }
    if protocolVersion == NativeProtocol.legacyVersion, operation == .capabilityStatus {
      throw NativeHostError(
        code: "unsupported_operation",
        message: "capability_status requires native-host protocol version 2."
      )
    }
    if protocolVersion < NativeProtocol.compositionVersion, operation == .composeImage {
      throw NativeHostError(
        code: "unsupported_operation",
        message: "compose_image requires native-host protocol version 3."
      )
    }
    if protocolVersion < NativeProtocol.mutationBrokerVersion,
      operation == .runSimulatorMutation
    {
      throw NativeHostError(
        code: "unsupported_operation",
        message: "run_simulator_mutation requires native-host protocol version 4."
      )
    }
    if protocolVersion < NativeProtocol.simulatorInputVersion, operation == .sendSimulatorInput {
      throw NativeHostError(
        code: "unsupported_operation",
        message: "send_simulator_input requires native-host protocol version 5."
      )
    }
    guard let payload = object["payload"] as? [String: Any] else {
      throw NativeHostError(
        code: "invalid_payload", message: "payload must be a JSON object."
      )
    }
    if operation != .composeImage, operation != .runSimulatorMutation,
      operation != .sendSimulatorInput, !payload.isEmpty
    {
      throw NativeHostError(
        code: "invalid_payload", message: "payload must be an empty JSON object for this operation."
      )
    }
    return NativeRequest(
      protocolVersion: protocolVersion,
      requestID: requestID,
      operation: operation,
      payload: payload
    )
  }
}

struct NativeHostError: Error, Encodable {
  let code: String
  let message: String
  let retryable: Bool

  init(code: String, message: String, retryable: Bool = false) {
    self.code = code
    self.message = message
    self.retryable = retryable
  }
}

struct SuccessEnvelope<Result: Encodable>: Encodable {
  let protocolVersion: Int
  let requestID: String
  let ok = true
  let result: Result

  enum CodingKeys: String, CodingKey {
    case protocolVersion
    case requestID = "requestId"
    case ok
    case result
  }
}

struct FailureEnvelope: Encodable {
  let protocolVersion: Int
  let requestID: String
  let ok = false
  let error: NativeHostError

  enum CodingKeys: String, CodingKey {
    case protocolVersion
    case requestID = "requestId"
    case ok
    case error
  }
}

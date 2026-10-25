import Foundation

struct NativeHost {
  private let permissionReader: any PermissionReading
  private let capabilityReader: any CapabilityReading
  private let imageComposer: any ImageComposing
  private let mutationBroker: any SimulatorMutationBrokering
  private let inputDriver: any SimulatorInputDriving

  init(
    permissionReader: any PermissionReading = SystemPermissionReader(),
    capabilityReader: (any CapabilityReading)? = nil,
    imageComposer: any ImageComposing = SystemImageComposer(),
    mutationBroker: any SimulatorMutationBrokering = SystemSimulatorMutationBroker(),
    inputDriver: any SimulatorInputDriving = SimulatorKitInputDriver()
  ) {
    self.permissionReader = permissionReader
    self.capabilityReader =
      capabilityReader ?? SystemCapabilityReader(permissionReader: permissionReader)
    self.imageComposer = imageComposer
    self.mutationBroker = mutationBroker
    self.inputDriver = inputDriver
  }

  func process(
    arguments: [String],
    input: Data,
    cancellation: any CancellationChecking = NeverCancelled()
  ) -> (data: Data, exitCode: Int32) {
    guard arguments.count == 1 else {
      return failure(
        protocolVersion: NativeProtocol.legacyVersion,
        requestID: "",
        error: NativeHostError(
          code: "unexpected_arguments",
          message:
            "rndevtools-native-host accepts one versioned JSON request on stdin and no command-line arguments."
        ),
        exitCode: 2
      )
    }

    let request: NativeRequest
    do {
      request = try NativeRequest.decode(input)
    } catch let error as NativeHostError {
      return failure(
        protocolVersion: NativeProtocol.legacyVersion,
        requestID: "",
        error: error,
        exitCode: 2
      )
    } catch {
      return failure(
        protocolVersion: NativeProtocol.legacyVersion,
        requestID: "",
        error: NativeHostError(
          code: "invalid_request", message: "The native-host request could not be decoded."),
        exitCode: 2
      )
    }

    switch request.operation {
    case .handshake:
      return success(
        protocolVersion: request.protocolVersion,
        requestID: request.requestID,
        result: HandshakeResult(
          helperVersion: Self.helperVersion,
          protocolVersion: request.protocolVersion,
          capabilities: NativeCapabilities(
            operations: request.protocolVersion == NativeProtocol.legacyVersion
              ? [.handshake, .permissionStatus]
              : request.protocolVersion == NativeProtocol.inspectionVersion
                ? [.handshake, .permissionStatus, .capabilityStatus]
                : request.protocolVersion == NativeProtocol.compositionVersion
                  ? [.handshake, .permissionStatus, .capabilityStatus, .composeImage]
                  : request.protocolVersion == NativeProtocol.mutationBrokerVersion
                    ? [
                      .handshake, .permissionStatus, .capabilityStatus, .composeImage,
                      .runSimulatorMutation,
                    ]
                    : [
                      .handshake, .permissionStatus, .capabilityStatus, .composeImage,
                      .runSimulatorMutation, .sendSimulatorInput,
                    ],
            permissionInspection: true,
            permissionPrompting: false,
            simulatorMutation: request.protocolVersion >= NativeProtocol.mutationBrokerVersion
              ? mutationBroker.isAvailable() : false,
            runtimeDownloads: false,
            capabilityInspection: request.protocolVersion >= NativeProtocol.inspectionVersion
              ? true : nil,
            liveCaptureSessions: request.protocolVersion >= NativeProtocol.inspectionVersion
              ? false : nil,
            imageComposition: request.protocolVersion >= NativeProtocol.compositionVersion
              ? true : nil,
            simulatorInput: request.protocolVersion >= NativeProtocol.simulatorInputVersion
              ? true : nil
          )
        )
      )
    case .permissionStatus:
      return success(
        protocolVersion: request.protocolVersion,
        requestID: request.requestID,
        result: PermissionStatusResult(statuses: permissionReader.statuses())
      )
    case .capabilityStatus:
      return success(
        protocolVersion: request.protocolVersion,
        requestID: request.requestID,
        result: capabilityReader.status()
      )
    case .composeImage:
      do {
        return success(
          protocolVersion: request.protocolVersion,
          requestID: request.requestID,
          result: try imageComposer.compose(
            ImageCompositionRequest.decode(request.payload),
            cancellation: cancellation
          )
        )
      } catch let error as NativeHostError {
        return failure(
          protocolVersion: request.protocolVersion,
          requestID: request.requestID,
          error: error,
          exitCode: error.code == "cancelled" ? 130 : 1
        )
      } catch {
        return failure(
          protocolVersion: request.protocolVersion,
          requestID: request.requestID,
          error: NativeHostError(
            code: "image_composition_failed",
            message: "The native image composition could not be completed."
          ),
          exitCode: 1
        )
      }
    case .runSimulatorMutation:
      do {
        return success(
          protocolVersion: request.protocolVersion,
          requestID: request.requestID,
          result: try mutationBroker.run(
            helperRequest: try mutationHelperRequest(request.payload),
            cancellation: cancellation
          ),
          maximumBytes: NativeProtocol.maximumMutationResponseBytes
        )
      } catch let error as NativeHostError {
        return failure(
          protocolVersion: request.protocolVersion,
          requestID: request.requestID,
          error: error,
          exitCode: error.code == "cancelled" ? 130 : 1
        )
      } catch {
        return failure(
          protocolVersion: request.protocolVersion,
          requestID: request.requestID,
          error: NativeHostError(
            code: "mutation_authorization_required",
            message: "The authenticated simulator mutation could not be brokered."
          ),
          exitCode: 1
        )
      }
    case .sendSimulatorInput:
      do {
        return success(
          protocolVersion: request.protocolVersion,
          requestID: request.requestID,
          result: try inputDriver.send(
            SimulatorInputRequest.decode(request.payload),
            cancellation: cancellation
          )
        )
      } catch let error as NativeHostError {
        return failure(
          protocolVersion: request.protocolVersion,
          requestID: request.requestID,
          error: error,
          exitCode: error.code == "cancelled" ? 130 : 1
        )
      } catch {
        return failure(
          protocolVersion: request.protocolVersion,
          requestID: request.requestID,
          error: NativeHostError(
            code: "simulator_input_failed",
            message: "The Simulator input could not be delivered.",
            retryable: true
          ),
          exitCode: 1
        )
      }
    }
  }

  private func success<Result: Encodable>(
    protocolVersion: Int,
    requestID: String,
    result: Result,
    maximumBytes: Int = NativeProtocol.maximumResponseBytes
  ) -> (Data, Int32) {
    do {
      let data = try encoder().encode(
        SuccessEnvelope(
          protocolVersion: protocolVersion,
          requestID: requestID,
          result: result
        )
      )
      guard data.count + 1 <= maximumBytes else {
        return failure(
          protocolVersion: protocolVersion,
          requestID: requestID,
          error: NativeHostError(
            code: "response_too_large",
            message: "The native-host response exceeds the operation-specific bound."
          ),
          exitCode: 1
        )
      }
      return (data, 0)
    } catch {
      return failure(
        protocolVersion: protocolVersion,
        requestID: requestID,
        error: NativeHostError(
          code: "encoding_failed", message: "The native-host response could not be encoded."),
        exitCode: 1
      )
    }
  }

  private func mutationHelperRequest(_ payload: [String: Any]) throws -> String {
    guard Set(payload.keys) == Set(["helperRequest"]),
      let helperRequest = payload["helperRequest"] as? String
    else {
      throw NativeHostError(
        code: "invalid_payload",
        message: "run_simulator_mutation requires exactly one bounded helperRequest string."
      )
    }
    return helperRequest
  }

  private func failure(
    protocolVersion: Int,
    requestID: String,
    error: NativeHostError,
    exitCode: Int32
  ) -> (Data, Int32) {
    let data =
      (try? encoder().encode(
        FailureEnvelope(
          protocolVersion: protocolVersion,
          requestID: requestID,
          error: error
        )
      )) ?? Data()
    return (data, exitCode)
  }

  private func encoder() -> JSONEncoder {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return encoder
  }
}

struct NativeCapabilities: Encodable {
  let operations: [NativeOperation]
  let permissionInspection: Bool
  let permissionPrompting: Bool
  let simulatorMutation: Bool
  let runtimeDownloads: Bool
  let capabilityInspection: Bool?
  let liveCaptureSessions: Bool?
  let imageComposition: Bool?
  /// Native Simulator input (tap/swipe/text/key/button) over SimulatorKit HID. Reported as
  /// supported by the host; whether the toolchain actually provides it is learned on first use.
  let simulatorInput: Bool?
}

struct HandshakeResult: Encodable {
  let helperVersion: String
  let protocolVersion: Int
  let capabilities: NativeCapabilities
}

struct PermissionStatusResult: Encodable {
  let statuses: [PermissionStatus]
}

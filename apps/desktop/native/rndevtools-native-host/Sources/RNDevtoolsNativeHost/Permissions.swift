import AVFoundation
import ApplicationServices
import CoreGraphics
import Foundation

enum PermissionValue: String, Encodable {
  case granted
  case denied
  case restricted
  case notDetermined = "not_determined"
  case notGranted = "not_granted"
  case unknown
}

struct PermissionStatus: Encodable, Equatable {
  let id: String
  let value: PermissionValue
  let canPrompt: Bool
}

protocol PermissionReading {
  func statuses() -> [PermissionStatus]
}

struct SystemPermissionReader: PermissionReading {
  func statuses() -> [PermissionStatus] {
    [
      PermissionStatus(
        id: "accessibility",
        value: AXIsProcessTrusted() ? .granted : .notGranted,
        canPrompt: false
      ),
      PermissionStatus(
        id: "screen_recording",
        value: CGPreflightScreenCaptureAccess() ? .granted : .notGranted,
        canPrompt: false
      ),
      PermissionStatus(
        id: "camera",
        value: value(for: AVCaptureDevice.authorizationStatus(for: .video)),
        canPrompt: false
      ),
      PermissionStatus(
        id: "microphone",
        value: value(for: AVCaptureDevice.authorizationStatus(for: .audio)),
        canPrompt: false
      ),
    ]
  }

  private func value(for status: AVAuthorizationStatus) -> PermissionValue {
    switch status {
    case .authorized:
      .granted
    case .denied:
      .denied
    case .restricted:
      .restricted
    case .notDetermined:
      .notDetermined
    @unknown default:
      .unknown
    }
  }
}

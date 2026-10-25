import AVFoundation
import CoreMedia
import CoreServices
import Foundation
import Security
import VideoToolbox

enum CapabilityAvailability: String, Encodable, Equatable {
  case available
  case gated
  case unavailable
}

struct NativeCapabilityStatusResult: Encodable, Equatable {
  let checkedAtMilliseconds: Int64
  let architecture: String
  let operatingSystemVersion: String
  let screenCaptureKit: ScreenCaptureKitCapabilityStatus
  let avFoundation: AVFoundationCapabilityStatus
  let videoToolbox: VideoToolboxCapabilityStatus
  let accessibility: AccessibilityCapabilityStatus
  let buildInsights: BuildInsightsCapabilityStatus
  let networkExtension: NetworkExtensionCapabilityStatus
  let safety: CapabilitySafetyStatus
}

struct ScreenCaptureKitCapabilityStatus: Encodable, Equatable {
  let frameworkAvailable: Bool
  let screenRecordingPermission: PermissionValue
  let liveWindowCapture: CapabilityAvailability
  let systemAudioCapture: CapabilityAvailability
  let microphoneCapture: CapabilityAvailability
  let requestableFrameRates: [Int]
  let windowEnumerationPerformed: Bool
  let contentPickerPresented: Bool
  let persistentSessionOperationsExposed: Bool
}

struct AVFoundationCapabilityStatus: Encodable, Equatable {
  let frameworkAvailable: Bool
  let cameraPermission: PermissionValue
  let microphonePermission: PermissionValue
  let cameraDeviceAvailable: Bool
  let microphoneDeviceAvailable: Bool
  let cameraCapture: CapabilityAvailability
  let microphoneCapture: CapabilityAvailability
  let permissionRequestsPerformed: Bool
}

struct VideoToolboxCapabilityStatus: Encodable, Equatable {
  let frameworkAvailable: Bool
  let referenceWidth: Int
  let referenceHeight: Int
  let probeKind: String
  let codecs: [VideoCodecCapabilityStatus]
  let framesEncoded: Int
}

struct VideoCodecCapabilityStatus: Encodable, Equatable {
  let id: String
  let hardwareEncodeSupported: Bool
  let hardwareDecodeSupported: Bool
  let sessionCreationStatus: Int32
  let acceptedRealtimeConfigurationFrameRates: [Int]
}

struct AccessibilityCapabilityStatus: Encodable, Equatable {
  let frameworkAvailable: Bool
  let permission: PermissionValue
  let elementInspection: CapabilityAvailability
  let permissionPromptPerformed: Bool
}

struct BuildInsightsCapabilityStatus: Encodable, Equatable {
  let fseventsFrameworkAvailable: Bool
  let currentEventID: String
  let pathScopedObservation: CapabilityAvailability
  let protectedPathObservation: CapabilityAvailability
  let requiresExplicitSourceRoots: Bool
  let fullDiskAccessPreflightAvailable: Bool
  let sourceRootsInspected: Bool
  let xcodeProcessesLaunched: Bool
}

struct NetworkExtensionCapabilityStatus: Encodable, Equatable {
  let frameworkAvailable: Bool
  let vpnManagerAPIAvailable: Bool
  let packetTunnelProviderAPIAvailable: Bool
  let appProxyProviderAPIAvailable: Bool
  let contentFilterAPIAvailable: Bool
  let entitlementPresent: Bool
  let configurationInspection: CapabilityAvailability
  let trafficInterception: CapabilityAvailability
  let preferenceReadsPerformed: Bool
}

struct CapabilitySafetyStatus: Encodable, Equatable {
  let permissionPrompts: Bool
  let externalStateMutations: Bool
  let contentEnumerated: Bool
  let persistentSessions: Bool
  let networkPreferencesRead: Bool
}

protocol CapabilityReading {
  func status() -> NativeCapabilityStatusResult
}

struct SystemCapabilityReader: CapabilityReading {
  private static let referenceWidth = 1920
  private static let referenceHeight = 1080
  private static let frameRates = [30, 60, 120]

  private let permissionReader: any PermissionReading

  init(permissionReader: any PermissionReading = SystemPermissionReader()) {
    self.permissionReader = permissionReader
  }

  func status() -> NativeCapabilityStatusResult {
    let permissions = Dictionary(
      uniqueKeysWithValues: permissionReader.statuses().map { ($0.id, $0.value) }
    )
    let screenPermission = permissions["screen_recording"] ?? .unknown
    let cameraPermission = permissions["camera"] ?? .unknown
    let microphonePermission = permissions["microphone"] ?? .unknown
    let accessibilityPermission = permissions["accessibility"] ?? .unknown
    let cameraDeviceAvailable = AVCaptureDevice.default(for: .video) != nil
    let microphoneDeviceAvailable = AVCaptureDevice.default(for: .audio) != nil

    return NativeCapabilityStatusResult(
      checkedAtMilliseconds: Int64(Date().timeIntervalSince1970 * 1_000),
      architecture: Self.architecture,
      operatingSystemVersion: Self.operatingSystemVersion,
      screenCaptureKit: ScreenCaptureKitCapabilityStatus(
        frameworkAvailable: true,
        screenRecordingPermission: screenPermission,
        liveWindowCapture: Self.availability(
          frameworkAvailable: true,
          deviceAvailable: true,
          permission: screenPermission
        ),
        systemAudioCapture: Self.availability(
          frameworkAvailable: true,
          deviceAvailable: true,
          permission: screenPermission
        ),
        microphoneCapture: Self.availability(
          frameworkAvailable: Self.screenCaptureMicrophoneAvailable,
          deviceAvailable: microphoneDeviceAvailable,
          permission: microphonePermission
        ),
        requestableFrameRates: Self.frameRates,
        windowEnumerationPerformed: false,
        contentPickerPresented: false,
        persistentSessionOperationsExposed: false
      ),
      avFoundation: AVFoundationCapabilityStatus(
        frameworkAvailable: true,
        cameraPermission: cameraPermission,
        microphonePermission: microphonePermission,
        cameraDeviceAvailable: cameraDeviceAvailable,
        microphoneDeviceAvailable: microphoneDeviceAvailable,
        cameraCapture: Self.availability(
          frameworkAvailable: true,
          deviceAvailable: cameraDeviceAvailable,
          permission: cameraPermission
        ),
        microphoneCapture: Self.availability(
          frameworkAvailable: true,
          deviceAvailable: microphoneDeviceAvailable,
          permission: microphonePermission
        ),
        permissionRequestsPerformed: false
      ),
      videoToolbox: Self.videoToolboxStatus(),
      accessibility: AccessibilityCapabilityStatus(
        frameworkAvailable: true,
        permission: accessibilityPermission,
        elementInspection: Self.availability(
          frameworkAvailable: true,
          deviceAvailable: true,
          permission: accessibilityPermission
        ),
        permissionPromptPerformed: false
      ),
      buildInsights: BuildInsightsCapabilityStatus(
        fseventsFrameworkAvailable: true,
        currentEventID: String(FSEventsGetCurrentEventId()),
        pathScopedObservation: .available,
        protectedPathObservation: .gated,
        requiresExplicitSourceRoots: true,
        fullDiskAccessPreflightAvailable: false,
        sourceRootsInspected: false,
        xcodeProcessesLaunched: false
      ),
      networkExtension: Self.networkExtensionStatus(),
      safety: CapabilitySafetyStatus(
        permissionPrompts: false,
        externalStateMutations: false,
        contentEnumerated: false,
        persistentSessions: false,
        networkPreferencesRead: false
      )
    )
  }

  private static func availability(
    frameworkAvailable: Bool,
    deviceAvailable: Bool,
    permission: PermissionValue
  ) -> CapabilityAvailability {
    guard frameworkAvailable, deviceAvailable else {
      return .unavailable
    }
    return permission == .granted ? .available : .gated
  }

  private static var architecture: String {
    #if arch(arm64)
      "arm64"
    #elseif arch(x86_64)
      "x86_64"
    #else
      "unknown"
    #endif
  }

  private static var operatingSystemVersion: String {
    let version = ProcessInfo.processInfo.operatingSystemVersion
    return "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"
  }

  private static var screenCaptureMicrophoneAvailable: Bool {
    if #available(macOS 15.0, *) {
      true
    } else {
      false
    }
  }

  private static func videoToolboxStatus() -> VideoToolboxCapabilityStatus {
    VideoToolboxCapabilityStatus(
      frameworkAvailable: true,
      referenceWidth: referenceWidth,
      referenceHeight: referenceHeight,
      probeKind: "hardware_realtime_configuration_acceptance",
      codecs: [
        codecStatus(id: "h264", codecType: kCMVideoCodecType_H264),
        codecStatus(id: "hevc", codecType: kCMVideoCodecType_HEVC),
      ],
      framesEncoded: 0
    )
  }

  private static func codecStatus(
    id: String,
    codecType: CMVideoCodecType
  ) -> VideoCodecCapabilityStatus {
    var session: VTCompressionSession?
    let encoderSpecification =
      [
        kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: kCFBooleanTrue!
      ] as CFDictionary
    let creationStatus = VTCompressionSessionCreate(
      allocator: nil,
      width: Int32(referenceWidth),
      height: Int32(referenceHeight),
      codecType: codecType,
      encoderSpecification: encoderSpecification,
      imageBufferAttributes: nil,
      compressedDataAllocator: nil,
      outputCallback: nil,
      refcon: nil,
      compressionSessionOut: &session
    )
    let hardwareDecodeSupported = VTIsHardwareDecodeSupported(codecType)
    guard creationStatus == noErr, let session else {
      return VideoCodecCapabilityStatus(
        id: id,
        hardwareEncodeSupported: false,
        hardwareDecodeSupported: hardwareDecodeSupported,
        sessionCreationStatus: creationStatus,
        acceptedRealtimeConfigurationFrameRates: []
      )
    }
    defer { VTCompressionSessionInvalidate(session) }

    let realTimeStatus = VTSessionSetProperty(
      session,
      key: kVTCompressionPropertyKey_RealTime,
      value: kCFBooleanTrue
    )
    let acceptedFrameRates =
      realTimeStatus == noErr
      ? frameRates.filter { frameRate in
        VTSessionSetProperty(
          session,
          key: kVTCompressionPropertyKey_ExpectedFrameRate,
          value: NSNumber(value: frameRate)
        ) == noErr
      }
      : []
    return VideoCodecCapabilityStatus(
      id: id,
      hardwareEncodeSupported: true,
      hardwareDecodeSupported: hardwareDecodeSupported,
      sessionCreationStatus: creationStatus,
      acceptedRealtimeConfigurationFrameRates: acceptedFrameRates
    )
  }

  private static func networkExtensionStatus() -> NetworkExtensionCapabilityStatus {
    NetworkExtensionCapabilityStatus(
      frameworkAvailable: true,
      vpnManagerAPIAvailable: true,
      packetTunnelProviderAPIAvailable: true,
      appProxyProviderAPIAvailable: true,
      contentFilterAPIAvailable: true,
      entitlementPresent: networkExtensionEntitlementPresent(),
      configurationInspection: .gated,
      trafficInterception: .gated,
      preferenceReadsPerformed: false
    )
  }

  private static func networkExtensionEntitlementPresent() -> Bool {
    guard let task = SecTaskCreateFromSelf(nil),
      let value = SecTaskCopyValueForEntitlement(
        task,
        "com.apple.developer.networking.networkextension" as CFString,
        nil
      )
    else {
      return false
    }
    if let entries = value as? [String] {
      return !entries.isEmpty
    }
    return (value as? Bool) == true
  }
}

import CoreGraphics
import Foundation

enum ImageCompositionLimits {
  static let maximumInputFileBytes = 32 * 1024 * 1024
  static let maximumEncodedOutputBytes = 64 * 1024 * 1024
  static let maximumDimension = 8_192
  static let maximumPixels = 40_000_000
  static let maximumAggregateInputPixels = 64_000_000
  static let maximumMetadataBytes = 512
  static let maximumMetadataLines = 8
  static let maximumMetadataLineBytes = 96
}

enum ComposedImageFormat: String {
  case png
  case jpeg
}

struct RGBAColor: Equatable {
  let red: UInt8
  let green: UInt8
  let blue: UInt8
  let alpha: UInt8

  var cgColor: CGColor {
    CGColor(
      srgbRed: CGFloat(red) / 255,
      green: CGFloat(green) / 255,
      blue: CGFloat(blue) / 255,
      alpha: CGFloat(alpha) / 255
    )
  }

  var isOpaque: Bool { alpha == 255 }
}

enum CanvasBackground: Equatable {
  case transparent
  case solid(RGBAColor)
  case linearGradient(
    start: RGBAColor,
    end: RGBAColor,
    direction: GradientDirection
  )

  var isOpaque: Bool {
    switch self {
    case .transparent:
      false
    case .solid(let color):
      color.isOpaque
    case .linearGradient(let start, let end, _):
      start.isOpaque && end.isOpaque
    }
  }
}

enum GradientDirection: String, Equatable {
  case topToBottom = "top_to_bottom"
  case leftToRight = "left_to_right"
  case topLeftToBottomRight = "top_left_to_bottom_right"
}

struct PixelSize: Equatable {
  let width: Int
  let height: Int
}

struct EdgePadding: Equatable {
  let top: Int
  let right: Int
  let bottom: Int
  let left: Int
}

enum ImageContentMode: String, Equatable {
  case fit
  case fill
}

enum DeviceBezelStyle: String, Equatable {
  case none
  case genericV1 = "rndevtools-generic-v1"
}

struct ImageShadow: Equatable {
  let color: RGBAColor
  let blurRadius: Int
  let offsetX: Int
  let offsetY: Int
}

struct ImageLayout: Equatable {
  let padding: EdgePadding
  let contentMode: ImageContentMode
  let rotation: Int
  let cornerRadius: Int
  let bezel: DeviceBezelStyle
  let shadow: ImageShadow?
}

struct MetadataOverlay: Equatable {
  let text: String
  let lines: [String]
  let placement: MetadataPlacement
  let textColor: RGBAColor
  let backgroundColor: RGBAColor
  let fontSize: Int
  let padding: Int
}

enum MetadataPlacement: String, Equatable {
  case top
  case bottom
}

enum ImageComparison: Equatable {
  case sideBySide(gap: Int)
  case opacity(secondaryOpacityBasisPoints: Int)
  case difference

  var resultName: String {
    switch self {
    case .sideBySide:
      "side_by_side"
    case .opacity:
      "opacity"
    case .difference:
      "difference"
    }
  }
}

struct ImageCompositionRequest: Equatable {
  let workspaceToken: String
  let primaryInput: String
  let secondaryInput: String?
  let output: String
  let outputFormat: ComposedImageFormat
  let jpegQuality: Int
  let canvasSize: PixelSize
  let background: CanvasBackground
  let layout: ImageLayout
  let metadata: MetadataOverlay?
  let comparison: ImageComparison?

  static func decode(_ payload: [String: Any]) throws -> ImageCompositionRequest {
    try requireKeys(
      payload,
      required: [
        "workspaceToken", "primaryInput", "output", "outputFormat", "canvas", "layout",
      ],
      optional: ["secondaryInput", "jpegQuality", "metadata", "comparison"],
      at: "payload"
    )
    let workspaceToken = try string(payload, "workspaceToken", at: "payload")
    guard workspaceToken.range(of: #"^[a-f0-9]{32}$"#, options: .regularExpression) != nil else {
      throw invalidPayload(
        "workspaceToken must contain exactly 32 lowercase hexadecimal characters.")
    }
    let primaryInput = try imageLeaf(payload, "primaryInput", at: "payload")
    let secondaryInput = try optionalImageLeaf(payload, "secondaryInput", at: "payload")
    if primaryInput == secondaryInput {
      throw invalidPayload("primaryInput and secondaryInput must be different staged files.")
    }
    let output = try outputLeaf(payload, "output", at: "payload")
    let outputFormat = try enumValue(
      payload,
      "outputFormat",
      at: "payload",
      as: ComposedImageFormat.self
    )
    try requireOutputExtension(output, format: outputFormat)

    let jpegQuality: Int
    if outputFormat == .jpeg {
      jpegQuality = try optionalInteger(payload, "jpegQuality", at: "payload") ?? 90
      try requireRange(jpegQuality, 1...100, field: "payload.jpegQuality")
    } else {
      guard payload["jpegQuality"] == nil else {
        throw invalidPayload("jpegQuality is valid only when outputFormat is jpeg.")
      }
      jpegQuality = 100
    }

    let canvas = try requiredObject(payload, "canvas", at: "payload")
    try requireKeys(canvas, required: ["size", "background"], optional: [], at: "payload.canvas")
    let canvasSize = try decodeCanvasSize(try requiredObject(canvas, "size", at: "payload.canvas"))
    let background = try decodeBackground(
      try requiredObject(canvas, "background", at: "payload.canvas")
    )
    if outputFormat == .jpeg, !background.isOpaque {
      throw invalidPayload("JPEG output requires an opaque solid or gradient canvas.")
    }

    let layout = try decodeLayout(try requiredObject(payload, "layout", at: "payload"))
    let metadata = try optionalObject(payload, "metadata", at: "payload").map(decodeMetadata)
    let comparison = try optionalObject(payload, "comparison", at: "payload").map(
      decodeComparison)

    guard (secondaryInput != nil) == (comparison != nil) else {
      throw invalidPayload(
        "secondaryInput and comparison must either both be present or both be absent.")
    }
    try validateGeometry(
      canvasSize: canvasSize,
      layout: layout,
      metadata: metadata,
      comparison: comparison
    )

    return ImageCompositionRequest(
      workspaceToken: workspaceToken,
      primaryInput: primaryInput,
      secondaryInput: secondaryInput,
      output: output,
      outputFormat: outputFormat,
      jpegQuality: jpegQuality,
      canvasSize: canvasSize,
      background: background,
      layout: layout,
      metadata: metadata,
      comparison: comparison
    )
  }
}

struct ImageCompositionResult: Encodable, Equatable {
  let operation = "compose_image"
  let outputName: String
  let outputFormat: String
  let width: Int
  let height: Int
  let byteCount: Int
  let inputCount: Int
  let composition: String
  let metadataRendered: Bool
  let bezelStyle: String
  let atomicCommit = true
}

private func decodeCanvasSize(_ object: [String: Any]) throws -> PixelSize {
  let mode = try string(object, "mode", at: "payload.canvas.size")
  switch mode {
  case "pixels":
    try requireKeys(
      object,
      required: ["mode", "width", "height"],
      optional: [],
      at: "payload.canvas.size"
    )
    let width = try integer(object, "width", at: "payload.canvas.size")
    let height = try integer(object, "height", at: "payload.canvas.size")
    return try validatedPixelSize(width: width, height: height)
  case "aspect":
    try requireKeys(
      object,
      required: ["mode", "ratioWidth", "ratioHeight", "longEdge"],
      optional: [],
      at: "payload.canvas.size"
    )
    let ratioWidth = try integer(object, "ratioWidth", at: "payload.canvas.size")
    let ratioHeight = try integer(object, "ratioHeight", at: "payload.canvas.size")
    let longEdge = try integer(object, "longEdge", at: "payload.canvas.size")
    try requireRange(ratioWidth, 1...1_000, field: "payload.canvas.size.ratioWidth")
    try requireRange(ratioHeight, 1...1_000, field: "payload.canvas.size.ratioHeight")
    try requireRange(
      longEdge,
      64...ImageCompositionLimits.maximumDimension,
      field: "payload.canvas.size.longEdge"
    )
    let width: Int
    let height: Int
    if ratioWidth >= ratioHeight {
      width = longEdge
      height = max(1, (longEdge * ratioHeight + ratioWidth / 2) / ratioWidth)
    } else {
      width = max(1, (longEdge * ratioWidth + ratioHeight / 2) / ratioHeight)
      height = longEdge
    }
    return try validatedPixelSize(width: width, height: height)
  default:
    throw invalidPayload("payload.canvas.size.mode must be pixels or aspect.")
  }
}

private func validatedPixelSize(width: Int, height: Int) throws -> PixelSize {
  try requireRange(
    width,
    1...ImageCompositionLimits.maximumDimension,
    field: "payload.canvas.size.width"
  )
  try requireRange(
    height,
    1...ImageCompositionLimits.maximumDimension,
    field: "payload.canvas.size.height"
  )
  guard width * height <= ImageCompositionLimits.maximumPixels else {
    throw invalidPayload("The output canvas exceeds the 40 megapixel limit.")
  }
  return PixelSize(width: width, height: height)
}

private func decodeBackground(_ object: [String: Any]) throws -> CanvasBackground {
  let kind = try string(object, "kind", at: "payload.canvas.background")
  switch kind {
  case "transparent":
    try requireKeys(
      object,
      required: ["kind"],
      optional: [],
      at: "payload.canvas.background"
    )
    return .transparent
  case "solid":
    try requireKeys(
      object,
      required: ["kind", "color"],
      optional: [],
      at: "payload.canvas.background"
    )
    return .solid(try color(object, "color", at: "payload.canvas.background"))
  case "linear_gradient":
    try requireKeys(
      object,
      required: ["kind", "startColor", "endColor", "direction"],
      optional: [],
      at: "payload.canvas.background"
    )
    return .linearGradient(
      start: try color(object, "startColor", at: "payload.canvas.background"),
      end: try color(object, "endColor", at: "payload.canvas.background"),
      direction: try enumValue(
        object,
        "direction",
        at: "payload.canvas.background",
        as: GradientDirection.self
      )
    )
  default:
    throw invalidPayload(
      "payload.canvas.background.kind must be transparent, solid, or linear_gradient."
    )
  }
}

private func decodeLayout(_ object: [String: Any]) throws -> ImageLayout {
  try requireKeys(
    object,
    required: ["padding", "contentMode", "rotation", "cornerRadius", "bezel"],
    optional: ["shadow"],
    at: "payload.layout"
  )
  let paddingObject = try requiredObject(object, "padding", at: "payload.layout")
  try requireKeys(
    paddingObject,
    required: ["top", "right", "bottom", "left"],
    optional: [],
    at: "payload.layout.padding"
  )
  let padding = EdgePadding(
    top: try boundedInteger(paddingObject, "top", at: "payload.layout.padding", range: 0...2_048),
    right: try boundedInteger(
      paddingObject,
      "right",
      at: "payload.layout.padding",
      range: 0...2_048
    ),
    bottom: try boundedInteger(
      paddingObject,
      "bottom",
      at: "payload.layout.padding",
      range: 0...2_048
    ),
    left: try boundedInteger(
      paddingObject,
      "left",
      at: "payload.layout.padding",
      range: 0...2_048
    )
  )
  let shadow = try optionalObject(object, "shadow", at: "payload.layout").map(decodeShadow)
  let rotation = try integer(object, "rotation", at: "payload.layout")
  guard [0, 90, 180, 270].contains(rotation) else {
    throw invalidPayload("payload.layout.rotation must be 0, 90, 180, or 270.")
  }
  return ImageLayout(
    padding: padding,
    contentMode: try enumValue(
      object,
      "contentMode",
      at: "payload.layout",
      as: ImageContentMode.self
    ),
    rotation: rotation,
    cornerRadius: try boundedInteger(
      object,
      "cornerRadius",
      at: "payload.layout",
      range: 0...1_024
    ),
    bezel: try enumValue(object, "bezel", at: "payload.layout", as: DeviceBezelStyle.self),
    shadow: shadow
  )
}

private func decodeShadow(_ object: [String: Any]) throws -> ImageShadow {
  try requireKeys(
    object,
    required: ["color", "blurRadius", "offsetX", "offsetY"],
    optional: [],
    at: "payload.layout.shadow"
  )
  return ImageShadow(
    color: try color(object, "color", at: "payload.layout.shadow"),
    blurRadius: try boundedInteger(
      object,
      "blurRadius",
      at: "payload.layout.shadow",
      range: 0...256
    ),
    offsetX: try boundedInteger(
      object,
      "offsetX",
      at: "payload.layout.shadow",
      range: -512...512
    ),
    offsetY: try boundedInteger(
      object,
      "offsetY",
      at: "payload.layout.shadow",
      range: -512...512
    )
  )
}

private func decodeMetadata(_ object: [String: Any]) throws -> MetadataOverlay {
  try requireKeys(
    object,
    required: [
      "text", "placement", "textColor", "backgroundColor", "fontSize", "padding",
    ],
    optional: [],
    at: "payload.metadata"
  )
  let text = try string(object, "text", at: "payload.metadata")
  let bytes = text.utf8.count
  guard bytes > 0, bytes <= ImageCompositionLimits.maximumMetadataBytes else {
    throw invalidPayload("payload.metadata.text must contain 1 to 512 UTF-8 bytes.")
  }
  guard text.unicodeScalars.allSatisfy({ $0.value == 10 || (32...126).contains($0.value) }) else {
    throw invalidPayload("payload.metadata.text supports printable ASCII and newline only.")
  }
  let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
  guard lines.count <= ImageCompositionLimits.maximumMetadataLines,
    lines.allSatisfy({ $0.utf8.count <= ImageCompositionLimits.maximumMetadataLineBytes })
  else {
    throw invalidPayload("Metadata is limited to 8 lines and 96 UTF-8 bytes per line.")
  }
  return MetadataOverlay(
    text: text,
    lines: lines,
    placement: try enumValue(
      object,
      "placement",
      at: "payload.metadata",
      as: MetadataPlacement.self
    ),
    textColor: try color(object, "textColor", at: "payload.metadata"),
    backgroundColor: try color(object, "backgroundColor", at: "payload.metadata"),
    fontSize: try boundedInteger(
      object,
      "fontSize",
      at: "payload.metadata",
      range: 8...96
    ),
    padding: try boundedInteger(
      object,
      "padding",
      at: "payload.metadata",
      range: 0...64
    )
  )
}

private func decodeComparison(_ object: [String: Any]) throws -> ImageComparison {
  let mode = try string(object, "mode", at: "payload.comparison")
  switch mode {
  case "side_by_side":
    try requireKeys(
      object,
      required: ["mode", "gap"],
      optional: [],
      at: "payload.comparison"
    )
    return .sideBySide(
      gap: try boundedInteger(
        object,
        "gap",
        at: "payload.comparison",
        range: 0...512
      )
    )
  case "opacity":
    try requireKeys(
      object,
      required: ["mode", "secondaryOpacityBasisPoints"],
      optional: [],
      at: "payload.comparison"
    )
    return .opacity(
      secondaryOpacityBasisPoints: try boundedInteger(
        object,
        "secondaryOpacityBasisPoints",
        at: "payload.comparison",
        range: 0...10_000
      )
    )
  case "difference":
    try requireKeys(
      object,
      required: ["mode"],
      optional: [],
      at: "payload.comparison"
    )
    return .difference
  default:
    throw invalidPayload("payload.comparison.mode must be side_by_side, opacity, or difference.")
  }
}

private func validateGeometry(
  canvasSize: PixelSize,
  layout: ImageLayout,
  metadata: MetadataOverlay?,
  comparison: ImageComparison?
) throws {
  let contentWidth = canvasSize.width - layout.padding.left - layout.padding.right
  let contentHeight = canvasSize.height - layout.padding.top - layout.padding.bottom
  guard contentWidth > 0, contentHeight > 0 else {
    throw invalidPayload("Canvas padding leaves no drawable content area.")
  }

  var frameWidth = contentWidth
  if case .sideBySide(let gap) = comparison {
    guard gap < contentWidth else {
      throw invalidPayload("The side-by-side gap must be smaller than the drawable content width.")
    }
    frameWidth = (contentWidth - gap) / 2
    guard frameWidth > 0 else {
      throw invalidPayload("Side-by-side frames must each be at least one pixel wide.")
    }
  }
  guard layout.cornerRadius <= min(frameWidth, contentHeight) / 2 else {
    throw invalidPayload("cornerRadius exceeds half of the smallest image-frame dimension.")
  }
  if layout.bezel == .genericV1, min(frameWidth, contentHeight) < 64 {
    throw invalidPayload(
      "rndevtools-generic-v1 requires each image frame to be at least 64 pixels.")
  }
  if let metadata {
    let lineHeight = Int(ceil(Double(metadata.fontSize) * 1.25))
    let overlayHeight = metadata.padding * 2 + lineHeight * metadata.lines.count
    guard overlayHeight <= canvasSize.height else {
      throw invalidPayload("The metadata overlay is taller than the output canvas.")
    }
  }
}

private func imageLeaf(_ object: [String: Any], _ key: String, at path: String) throws -> String {
  let value = try string(object, key, at: path)
  try requireLeaf(value, field: "\(path).\(key)")
  guard ["png", "jpg", "jpeg"].contains((value as NSString).pathExtension.lowercased()) else {
    throw invalidPayload("\(path).\(key) must use a .png, .jpg, or .jpeg extension.")
  }
  return value
}

private func optionalImageLeaf(
  _ object: [String: Any],
  _ key: String,
  at path: String
) throws -> String? {
  guard object[key] != nil else { return nil }
  return try imageLeaf(object, key, at: path)
}

private func outputLeaf(_ object: [String: Any], _ key: String, at path: String) throws -> String {
  let value = try string(object, key, at: path)
  try requireLeaf(value, field: "\(path).\(key)")
  return value
}

private func requireLeaf(_ value: String, field: String) throws {
  guard value.utf8.count <= 128,
    value.range(of: #"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"#, options: .regularExpression) != nil,
    value != ".",
    value != ".."
  else {
    throw invalidPayload("\(field) must be a bounded ASCII filename without path separators.")
  }
}

private func requireOutputExtension(_ output: String, format: ComposedImageFormat) throws {
  let ext = (output as NSString).pathExtension.lowercased()
  let matches = format == .png ? ext == "png" : ["jpg", "jpeg"].contains(ext)
  guard matches else {
    throw invalidPayload("output filename extension does not match outputFormat.")
  }
}

private func requireKeys(
  _ object: [String: Any],
  required: Set<String>,
  optional: Set<String>,
  at path: String
) throws {
  let keys = Set(object.keys)
  guard required.isSubset(of: keys), keys.isSubset(of: required.union(optional)) else {
    throw invalidPayload("\(path) has missing or unknown fields.")
  }
}

private func requiredObject(
  _ object: [String: Any], _ key: String, at path: String
) throws -> [String: Any] {
  guard let value = object[key] as? [String: Any] else {
    throw invalidPayload("\(path).\(key) must be an object.")
  }
  return value
}

private func optionalObject(
  _ object: [String: Any],
  _ key: String,
  at path: String
) throws -> [String: Any]? {
  guard object[key] != nil else { return nil }
  return try requiredObject(object, key, at: path)
}

private func string(_ object: [String: Any], _ key: String, at path: String) throws -> String {
  guard let value = object[key] as? String else {
    throw invalidPayload("\(path).\(key) must be a string.")
  }
  return value
}

private func integer(_ object: [String: Any], _ key: String, at path: String) throws -> Int {
  guard let value = strictInteger(object[key]) else {
    throw invalidPayload("\(path).\(key) must be an integer.")
  }
  return value
}

private func optionalInteger(
  _ object: [String: Any],
  _ key: String,
  at path: String
) throws -> Int? {
  guard object[key] != nil else { return nil }
  return try integer(object, key, at: path)
}

private func boundedInteger(
  _ object: [String: Any],
  _ key: String,
  at path: String,
  range: ClosedRange<Int>
) throws -> Int {
  let value = try integer(object, key, at: path)
  try requireRange(value, range, field: "\(path).\(key)")
  return value
}

private func strictInteger(_ value: Any?) -> Int? {
  guard let number = value as? NSNumber,
    CFGetTypeID(number) != CFBooleanGetTypeID()
  else {
    return nil
  }
  // Double(Int.max) rounds up to 2^63 on 64-bit hosts, so comparing against
  // that bound before Int(double) still allows a trapping conversion.
  return Int(exactly: number.doubleValue)
}

private func requireRange(_ value: Int, _ range: ClosedRange<Int>, field: String) throws {
  guard range.contains(value) else {
    throw invalidPayload("\(field) is outside its allowed range.")
  }
}

private func enumValue<Value: RawRepresentable>(
  _ object: [String: Any],
  _ key: String,
  at path: String,
  as type: Value.Type
) throws -> Value where Value.RawValue == String {
  let rawValue = try string(object, key, at: path)
  guard let value = Value(rawValue: rawValue) else {
    throw invalidPayload("\(path).\(key) has an unsupported value.")
  }
  return value
}

private func color(_ object: [String: Any], _ key: String, at path: String) throws -> RGBAColor {
  let rawValue = try string(object, key, at: path)
  guard
    rawValue.range(of: #"^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$"#, options: .regularExpression)
      != nil
  else {
    throw invalidPayload("\(path).\(key) must be #RRGGBB or #RRGGBBAA.")
  }
  let hex = String(rawValue.dropFirst())
  func component(_ offset: Int) -> UInt8 {
    let start = hex.index(hex.startIndex, offsetBy: offset)
    let end = hex.index(start, offsetBy: 2)
    return UInt8(hex[start..<end], radix: 16)!
  }
  return RGBAColor(
    red: component(0),
    green: component(2),
    blue: component(4),
    alpha: hex.count == 8 ? component(6) : 255
  )
}

private func invalidPayload(_ message: String) -> NativeHostError {
  NativeHostError(code: "invalid_payload", message: message)
}

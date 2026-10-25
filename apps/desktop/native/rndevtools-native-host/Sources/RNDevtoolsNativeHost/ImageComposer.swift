import AppKit
import CoreGraphics
import Darwin
import Foundation
import ImageIO
import UniformTypeIdentifiers

protocol ImageComposing: Sendable {
  func compose(
    _ request: ImageCompositionRequest,
    cancellation: any CancellationChecking
  ) throws -> ImageCompositionResult
}

struct SystemImageComposer: ImageComposing {
  func compose(
    _ request: ImageCompositionRequest,
    cancellation: any CancellationChecking
  ) throws -> ImageCompositionResult {
    try cancellation.check()
    let workspace = try secureWorkspace(request.workspaceToken)
    let primaryURL = workspace.inputs.appendingPathComponent(request.primaryInput)
    let secondaryURL = request.secondaryInput.map(workspace.inputs.appendingPathComponent)
    let outputURL = workspace.outputs.appendingPathComponent(request.output)
    let temporaryURL = workspace.outputs.appendingPathComponent(
      ".composition-\(UUID().uuidString.lowercased()).tmp"
    )
    defer {
      try? FileManager.default.removeItem(at: primaryURL)
      if let secondaryURL { try? FileManager.default.removeItem(at: secondaryURL) }
      try? FileManager.default.removeItem(at: temporaryURL)
    }

    try requireMissingFile(outputURL)
    let primary = try loadImage(primaryURL)
    let secondary = try secondaryURL.map(loadImage)
    let aggregatePixels =
      primary.width * primary.height + (secondary.map { $0.width * $0.height } ?? 0)
    guard aggregatePixels <= ImageCompositionLimits.maximumAggregateInputPixels else {
      throw imageCompositionError("The staged images exceed the 64 megapixel aggregate limit.")
    }
    try cancellation.check()
    let rendered = try render(request: request, primary: primary, secondary: secondary)
    try cancellation.check()
    let byteCount = try encode(
      rendered,
      format: request.outputFormat,
      jpegQuality: request.jpegQuality,
      temporaryURL: temporaryURL
    )
    try cancellation.check()
    guard link(temporaryURL.path, outputURL.path) == 0 else {
      throw imageCompositionError("The composed image could not be committed atomically.")
    }
    guard unlink(temporaryURL.path) == 0 else {
      try? FileManager.default.removeItem(at: outputURL)
      throw imageCompositionError("The composition temporary file could not be finalized.")
    }
    return ImageCompositionResult(
      outputName: request.output,
      outputFormat: request.outputFormat.rawValue,
      width: rendered.width,
      height: rendered.height,
      byteCount: byteCount,
      inputCount: secondary == nil ? 1 : 2,
      composition: request.comparison?.resultName ?? "single",
      metadataRendered: request.metadata != nil,
      bezelStyle: request.layout.bezel.rawValue
    )
  }

  private func secureWorkspace(_ token: String) throws -> (inputs: URL, outputs: URL) {
    let base = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library", isDirectory: true)
      .appendingPathComponent("Application Support", isDirectory: true)
      .appendingPathComponent("RN Devtools", isDirectory: true)
      .appendingPathComponent("Capture Design Studio", isDirectory: true)
      .appendingPathComponent("workspaces", isDirectory: true)
    let workspace = base.appendingPathComponent(token, isDirectory: true)
    let inputs = workspace.appendingPathComponent("inputs", isDirectory: true)
    let outputs = workspace.appendingPathComponent("outputs", isDirectory: true)
    for directory in [base, workspace, inputs, outputs] {
      try requirePrivateDirectory(directory)
    }
    return (inputs, outputs)
  }

  private func requirePrivateDirectory(_ url: URL) throws {
    var value = stat()
    guard lstat(url.path, &value) == 0,
      value.st_uid == getuid(),
      value.st_mode & S_IFMT == S_IFDIR,
      value.st_mode & 0o077 == 0
    else {
      throw imageCompositionError("The composition workspace is not a private owned directory.")
    }
  }

  private func requireMissingFile(_ url: URL) throws {
    var value = stat()
    if lstat(url.path, &value) == 0 || errno != ENOENT {
      throw imageCompositionError("The composition output already exists or cannot be inspected.")
    }
  }

  private func loadImage(_ url: URL) throws -> CGImage {
    var value = stat()
    guard lstat(url.path, &value) == 0,
      value.st_uid == getuid(),
      value.st_mode & S_IFMT == S_IFREG,
      value.st_size > 0,
      value.st_size <= ImageCompositionLimits.maximumInputFileBytes
    else {
      throw imageCompositionError("A staged image is not a bounded owned regular file.")
    }
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      CGImageSourceGetCount(source) == 1,
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
      image.width > 0,
      image.height > 0,
      image.width <= ImageCompositionLimits.maximumDimension,
      image.height <= ImageCompositionLimits.maximumDimension,
      image.width * image.height <= ImageCompositionLimits.maximumPixels
    else {
      throw imageCompositionError("A staged image is invalid or exceeds its geometry limit.")
    }
    return image
  }

  private func render(
    request: ImageCompositionRequest,
    primary: CGImage,
    secondary: CGImage?
  ) throws -> CGImage {
    let width = request.canvasSize.width
    let height = request.canvasSize.height
    guard let context = makeContext(width: width, height: height) else {
      throw imageCompositionError("The output canvas could not be allocated.")
    }
    context.translateBy(x: 0, y: CGFloat(height))
    context.scaleBy(x: 1, y: -1)
    drawBackground(request.background, in: context, width: width, height: height)

    let padding = request.layout.padding
    let content = CGRect(
      x: padding.left,
      y: padding.top,
      width: width - padding.left - padding.right,
      height: height - padding.top - padding.bottom
    )
    switch request.comparison {
    case .sideBySide(let gap):
      guard let secondary else { throw imageCompositionError("The comparison image is missing.") }
      let frameWidth = CGFloat((Int(content.width) - gap) / 2)
      let left = CGRect(x: content.minX, y: content.minY, width: frameWidth, height: content.height)
      let right = CGRect(
        x: left.maxX + CGFloat(gap), y: content.minY, width: frameWidth, height: content.height)
      drawFramed(primary, in: left, layout: request.layout, context: context, alpha: 1)
      drawFramed(secondary, in: right, layout: request.layout, context: context, alpha: 1)
    case .opacity(let basisPoints):
      guard let secondary else { throw imageCompositionError("The comparison image is missing.") }
      drawFramed(primary, in: content, layout: request.layout, context: context, alpha: 1)
      drawFramed(
        secondary,
        in: content,
        layout: request.layout,
        context: context,
        alpha: CGFloat(basisPoints) / 10_000
      )
    case .difference:
      guard let secondary else { throw imageCompositionError("The comparison image is missing.") }
      let frameWidth = max(1, Int(content.width.rounded(.down)))
      let frameHeight = max(1, Int(content.height.rounded(.down)))
      let primaryFrame = try renderFrame(
        primary, width: frameWidth, height: frameHeight, layout: request.layout)
      let secondaryFrame = try renderFrame(
        secondary, width: frameWidth, height: frameHeight, layout: request.layout)
      let difference = try absoluteDifference(primaryFrame, secondaryFrame)
      drawFramed(difference, in: content, layout: request.layout, context: context, alpha: 1)
    case nil:
      drawFramed(primary, in: content, layout: request.layout, context: context, alpha: 1)
    }
    if let metadata = request.metadata {
      drawMetadata(metadata, context: context, canvasWidth: width, canvasHeight: height)
    }
    guard let image = context.makeImage() else {
      throw imageCompositionError("The output canvas could not be finalized.")
    }
    return image
  }

  private func makeContext(width: Int, height: Int) -> CGContext? {
    CGContext(
      data: nil,
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: width * 4,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    )
  }

  private func drawBackground(
    _ background: CanvasBackground,
    in context: CGContext,
    width: Int,
    height: Int
  ) {
    let bounds = CGRect(x: 0, y: 0, width: width, height: height)
    switch background {
    case .transparent:
      context.clear(bounds)
    case .solid(let color):
      context.setFillColor(color.cgColor)
      context.fill(bounds)
    case .linearGradient(let start, let end, let direction):
      guard
        let gradient = CGGradient(
          colorsSpace: CGColorSpaceCreateDeviceRGB(),
          colors: [start.cgColor, end.cgColor] as CFArray,
          locations: [0, 1]
        )
      else { return }
      let points: (CGPoint, CGPoint) =
        switch direction {
        case .topToBottom:
          (CGPoint(x: width / 2, y: 0), CGPoint(x: width / 2, y: height))
        case .leftToRight:
          (CGPoint(x: 0, y: height / 2), CGPoint(x: width, y: height / 2))
        case .topLeftToBottomRight:
          (CGPoint(x: 0, y: 0), CGPoint(x: width, y: height))
        }
      context.drawLinearGradient(gradient, start: points.0, end: points.1, options: [])
    }
  }

  private func drawFramed(
    _ image: CGImage,
    in frame: CGRect,
    layout: ImageLayout,
    context: CGContext,
    alpha: CGFloat
  ) {
    context.saveGState()
    defer { context.restoreGState() }
    let radius = CGFloat(layout.cornerRadius)
    let outerPath = CGPath(
      roundedRect: frame, cornerWidth: radius, cornerHeight: radius, transform: nil)
    if let shadow = layout.shadow {
      context.setShadow(
        offset: CGSize(width: shadow.offsetX, height: shadow.offsetY),
        blur: CGFloat(shadow.blurRadius),
        color: shadow.color.cgColor
      )
    }
    if layout.bezel == .genericV1 {
      context.setFillColor(CGColor(gray: 0.04, alpha: alpha))
      context.addPath(outerPath)
      context.fillPath()
    }
    context.setShadow(offset: .zero, blur: 0, color: nil)
    let inset: CGFloat =
      layout.bezel == .genericV1 ? max(8, min(frame.width, frame.height) * 0.012) : 0
    let imageFrame = frame.insetBy(dx: inset, dy: inset)
    let imageRadius = max(0, radius - inset)
    context.addPath(
      CGPath(
        roundedRect: imageFrame,
        cornerWidth: imageRadius,
        cornerHeight: imageRadius,
        transform: nil
      )
    )
    context.clip()
    context.setAlpha(alpha)
    drawImage(image, in: imageFrame, layout: layout, context: context)
  }

  private func drawImage(
    _ image: CGImage,
    in frame: CGRect,
    layout: ImageLayout,
    context: CGContext
  ) {
    let rotated = layout.rotation == 90 || layout.rotation == 270
    let sourceWidth = CGFloat(rotated ? image.height : image.width)
    let sourceHeight = CGFloat(rotated ? image.width : image.height)
    let scaleX = frame.width / sourceWidth
    let scaleY = frame.height / sourceHeight
    let scale = layout.contentMode == .fit ? min(scaleX, scaleY) : max(scaleX, scaleY)
    let targetWidth = sourceWidth * scale
    let targetHeight = sourceHeight * scale
    context.saveGState()
    defer { context.restoreGState() }
    context.translateBy(x: frame.midX, y: frame.midY)
    context.rotate(by: -CGFloat(layout.rotation) * .pi / 180)
    context.scaleBy(x: 1, y: -1)
    let drawWidth = rotated ? targetHeight : targetWidth
    let drawHeight = rotated ? targetWidth : targetHeight
    context.draw(
      image,
      in: CGRect(x: -drawWidth / 2, y: -drawHeight / 2, width: drawWidth, height: drawHeight)
    )
  }

  private func renderFrame(
    _ image: CGImage,
    width: Int,
    height: Int,
    layout: ImageLayout
  ) throws -> CGImage {
    guard let context = makeContext(width: width, height: height) else {
      throw imageCompositionError("A comparison frame could not be allocated.")
    }
    context.translateBy(x: 0, y: CGFloat(height))
    context.scaleBy(x: 1, y: -1)
    drawFramed(
      image,
      in: CGRect(x: 0, y: 0, width: width, height: height),
      layout: layout,
      context: context,
      alpha: 1
    )
    guard let result = context.makeImage() else {
      throw imageCompositionError("A comparison frame could not be finalized.")
    }
    return result
  }

  private func absoluteDifference(_ left: CGImage, _ right: CGImage) throws -> CGImage {
    let width = left.width
    let height = left.height
    guard right.width == width, right.height == height else {
      throw imageCompositionError("Difference inputs must have identical geometry.")
    }
    let leftBytes = try rgbaBytes(left)
    let rightBytes = try rgbaBytes(right)
    var output = [UInt8](repeating: 0, count: leftBytes.count)
    for index in stride(from: 0, to: output.count, by: 4) {
      let leftAlpha = Int(leftBytes[index + 3])
      let rightAlpha = Int(rightBytes[index + 3])
      for component in 0..<3 {
        let leftValue =
          leftAlpha == 0 ? 0 : min(255, Int(leftBytes[index + component]) * 255 / leftAlpha)
        let rightValue =
          rightAlpha == 0 ? 0 : min(255, Int(rightBytes[index + component]) * 255 / rightAlpha)
        output[index + component] = UInt8(abs(leftValue - rightValue))
      }
      output[index + 3] = 255
    }
    let data = Data(output)
    guard let provider = CGDataProvider(data: data as CFData),
      let image = CGImage(
        width: width,
        height: height,
        bitsPerComponent: 8,
        bitsPerPixel: 32,
        bytesPerRow: width * 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
        provider: provider,
        decode: nil,
        shouldInterpolate: false,
        intent: .defaultIntent
      )
    else {
      throw imageCompositionError("The difference image could not be created.")
    }
    return image
  }

  private func rgbaBytes(_ image: CGImage) throws -> [UInt8] {
    var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
    let rendered = bytes.withUnsafeMutableBytes { buffer -> Bool in
      guard
        let context = CGContext(
          data: buffer.baseAddress,
          width: image.width,
          height: image.height,
          bitsPerComponent: 8,
          bytesPerRow: image.width * 4,
          space: CGColorSpaceCreateDeviceRGB(),
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )
      else { return false }
      context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
      return true
    }
    guard rendered else {
      throw imageCompositionError("A comparison image could not be decoded to pixels.")
    }
    return bytes
  }

  private func drawMetadata(
    _ metadata: MetadataOverlay,
    context: CGContext,
    canvasWidth: Int,
    canvasHeight: Int
  ) {
    let lineHeight = CGFloat(metadata.fontSize) * 1.25
    let overlayHeight = CGFloat(metadata.padding * 2) + lineHeight * CGFloat(metadata.lines.count)
    let overlay = CGRect(
      x: 0,
      y: metadata.placement == .top ? 0 : CGFloat(canvasHeight) - overlayHeight,
      width: CGFloat(canvasWidth),
      height: overlayHeight
    )
    context.setFillColor(metadata.backgroundColor.cgColor)
    context.fill(overlay)
    let attributes: [NSAttributedString.Key: Any] = [
      .font: NSFont.systemFont(ofSize: CGFloat(metadata.fontSize), weight: .medium),
      .foregroundColor: metadata.textColor.nsColor,
    ]
    let text = NSAttributedString(string: metadata.text, attributes: attributes)
    let graphicsContext = NSGraphicsContext(cgContext: context, flipped: true)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = graphicsContext
    text.draw(
      in: overlay.insetBy(dx: CGFloat(metadata.padding), dy: CGFloat(metadata.padding))
    )
    NSGraphicsContext.restoreGraphicsState()
  }

  private func encode(
    _ image: CGImage,
    format: ComposedImageFormat,
    jpegQuality: Int,
    temporaryURL: URL
  ) throws -> Int {
    let descriptor = open(
      temporaryURL.path,
      O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW,
      S_IRUSR | S_IWUSR
    )
    guard descriptor >= 0 else {
      throw imageCompositionError("The private composition output could not be reserved.")
    }
    close(descriptor)
    let type = format == .png ? UTType.png.identifier : UTType.jpeg.identifier
    guard
      let destination = CGImageDestinationCreateWithURL(
        temporaryURL as CFURL, type as CFString, 1, nil)
    else {
      throw imageCompositionError("The image encoder could not be initialized.")
    }
    let properties: CFDictionary? =
      format == .jpeg
      ? [kCGImageDestinationLossyCompressionQuality: Double(jpegQuality) / 100] as CFDictionary
      : nil
    CGImageDestinationAddImage(destination, image, properties)
    guard CGImageDestinationFinalize(destination) else {
      throw imageCompositionError("The composed image could not be encoded.")
    }
    var value = stat()
    guard lstat(temporaryURL.path, &value) == 0,
      value.st_uid == getuid(),
      value.st_mode & S_IFMT == S_IFREG,
      value.st_size > 0,
      value.st_size <= ImageCompositionLimits.maximumEncodedOutputBytes
    else {
      throw imageCompositionError("The encoded composition exceeded its output limit.")
    }
    return Int(value.st_size)
  }
}

extension RGBAColor {
  fileprivate var nsColor: NSColor {
    NSColor(
      srgbRed: CGFloat(red) / 255,
      green: CGFloat(green) / 255,
      blue: CGFloat(blue) / 255,
      alpha: CGFloat(alpha) / 255
    )
  }
}

private func imageCompositionError(_ message: String) -> NativeHostError {
  NativeHostError(code: "image_composition_failed", message: message)
}

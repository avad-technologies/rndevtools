// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "rndevtools-native-host",
  platforms: [.macOS(.v13)],
  products: [
    .executable(name: "rndevtools-native-host", targets: ["RNDevtoolsNativeHost"])
  ],
  targets: [
    .executableTarget(name: "RNDevtoolsNativeHost"),
    .testTarget(name: "RNDevtoolsNativeHostTests", dependencies: ["RNDevtoolsNativeHost"]),
  ]
)

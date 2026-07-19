// swift-tools-version: 6.2

import PackageDescription

let package = Package(
  name: "PicoMacOSControl",
  platforms: [.macOS(.v26)],
  products: [
    .library(name: "PicoMacOSControlCore", targets: ["PicoMacOSControlCore"]),
    .executable(name: "pico-macos-control", targets: ["PicoMacOSControl"]),
  ],
  targets: [
    .target(name: "PicoMacOSControlCore"),
    .executableTarget(
      name: "PicoMacOSControl",
      dependencies: ["PicoMacOSControlCore"]
    ),
    .testTarget(
      name: "PicoMacOSControlCoreTests",
      dependencies: ["PicoMacOSControlCore"]
    ),
  ],
  swiftLanguageModes: [.v6]
)

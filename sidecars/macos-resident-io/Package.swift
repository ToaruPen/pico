// swift-tools-version: 6.2

import PackageDescription

let package = Package(
  name: "PicoMacOSResidentIO",
  platforms: [.macOS(.v26)],
  products: [
    .library(name: "PicoMacOSResidentIOCore", targets: ["PicoMacOSResidentIOCore"]),
    .executable(name: "pico-macos-resident-io", targets: ["PicoMacOSResidentIO"]),
  ],
  targets: [
    .target(name: "PicoMacOSResidentIOCore"),
    .executableTarget(
      name: "PicoMacOSResidentIO",
      dependencies: ["PicoMacOSResidentIOCore"]
    ),
    .testTarget(
      name: "PicoMacOSResidentIOCoreTests",
      dependencies: ["PicoMacOSResidentIOCore"]
    ),
  ],
  swiftLanguageModes: [.v6]
)

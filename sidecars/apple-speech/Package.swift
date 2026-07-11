// swift-tools-version: 6.2

import PackageDescription

let package = Package(
  name: "pico-apple-speech-sidecar",
  platforms: [
    .macOS(.v26)
  ],
  products: [
    .library(name: "AppleSpeechCore", targets: ["AppleSpeechCore"]),
    .executable(name: "pico-apple-speech-sidecar", targets: ["AppleSpeechSidecar"])
  ],
  dependencies: [
    .package(url: "https://github.com/swhitty/FlyingFox.git", exact: "0.27.0")
  ],
  targets: [
    .target(
      name: "AppleSpeechCore",
      dependencies: [
        .product(name: "FlyingFox", package: "FlyingFox")
      ]
    ),
    .executableTarget(
      name: "AppleSpeechSidecar",
      dependencies: [
        "AppleSpeechCore",
        .product(name: "FlyingFox", package: "FlyingFox")
      ]
    ),
    .testTarget(
      name: "AppleSpeechCoreTests",
      dependencies: [
        "AppleSpeechCore",
        .product(name: "FlyingFox", package: "FlyingFox")
      ]
    )
  ],
  swiftLanguageModes: [.v6]
)

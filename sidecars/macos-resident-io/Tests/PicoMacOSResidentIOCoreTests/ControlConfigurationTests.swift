import Testing

@testable import PicoMacOSResidentIOCore

@Suite("macOS resident I/O configuration")
struct ControlConfigurationTests {
  @Test("parses stable input UID, resident PCM format, tail, and controls")
  func parsesConfiguration() throws {
    let configuration = try ResidentIoConfiguration.parse(arguments: arguments())

    #expect(configuration.deviceUID == "BuiltInMicrophoneDevice")
    #expect(configuration.sampleRateHz == 16_000)
    #expect(configuration.channels == 1)
    #expect(configuration.frameMilliseconds == 10)
    #expect(configuration.releaseTailMilliseconds == 250)
    #expect(configuration.talkKeyCode == 105)
    #expect(configuration.cancelKeyCode == 107)
  }

  @Test("rejects positional devices, unsupported formats, and unsafe controls")
  func rejectsInvalidConfiguration() {
    #expect(throws: ResidentIoConfigurationError.self) {
      try ResidentIoConfiguration.parse(arguments: ["--device", ":1"] + arguments())
    }
    #expect(throws: ResidentIoConfigurationError.self) {
      try ResidentIoConfiguration.parse(arguments: arguments(sampleRate: "48000"))
    }
    #expect(throws: ResidentIoConfigurationError.self) {
      try ResidentIoConfiguration.parse(arguments: arguments(channels: "2"))
    }
    #expect(throws: ResidentIoConfigurationError.self) {
      try ResidentIoConfiguration.parse(arguments: arguments(releaseTail: "249"))
    }
    #expect(throws: ResidentIoConfigurationError.self) {
      try ResidentIoConfiguration.parse(arguments: arguments(talkKey: "Shift"))
    }
    #expect(throws: ResidentIoConfigurationError.self) {
      try ResidentIoConfiguration.parse(arguments: arguments(cancelKey: "F13"))
    }
  }

  private func arguments(
    sampleRate: String = "16000",
    channels: String = "1",
    releaseTail: String = "250",
    talkKey: String = "F13",
    cancelKey: String = "F14"
  ) -> [String] {
    [
      "--device-uid", "BuiltInMicrophoneDevice",
      "--sample-rate-hz", sampleRate,
      "--channels", channels,
      "--frame-ms", "10",
      "--release-tail-ms", releaseTail,
      "--talk-key", talkKey,
      "--cancel-key", cancelKey,
    ]
  }
}

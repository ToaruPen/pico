import Testing

@testable import PicoMacOSControlCore

@Suite("macOS control configuration")
struct ControlConfigurationTests {
  @Test("parses loopback controls and key names")
  func parsesConfiguration() throws {
    let configuration = try ControlConfiguration.parse(arguments: [
      "--host", "127.0.0.1", "--port", "8781",
      "--token-path", "/tmp/control-token",
      "--talk-key", "F13", "--cancel-key", "F14",
    ])

    #expect(configuration.host == "127.0.0.1")
    #expect(configuration.port == 8_781)
    #expect(configuration.talkKeyCode == 105)
    #expect(configuration.cancelKeyCode == 107)
  }

  @Test("rejects unsafe configuration")
  func rejectsInvalidConfiguration() {
    #expect(throws: ControlConfigurationError.self) {
      try ControlConfiguration.parse(arguments: arguments(host: "0.0.0.0"))
    }
    #expect(throws: ControlConfigurationError.self) {
      try ControlConfiguration.parse(arguments: arguments(talkKey: "Shift"))
    }
    #expect(throws: ControlConfigurationError.self) {
      try ControlConfiguration.parse(arguments: arguments(cancelKey: "F13"))
    }
  }

  private func arguments(
    host: String = "127.0.0.1",
    talkKey: String = "F13",
    cancelKey: String = "F14"
  ) -> [String] {
    [
      "--host", host, "--port", "8781", "--token-path", "/tmp/control-token",
      "--talk-key", talkKey, "--cancel-key", cancelKey,
    ]
  }
}

import Testing

@testable import AppleSpeechCore

@Suite("Sidecar command line")
struct CommandLineTests {
  @Test("parses the supported commands")
  func parsesSupportedCommands() throws {
    #expect(try CommandLineParser.parse(["--version"]) == .version)
    #expect(
      try CommandLineParser.parse(["install-assets", "--locale", "ja-JP"])
        == .installAssets(locale: "ja-JP")
    )
    #expect(
      try CommandLineParser.parse(["preflight", "--locale", "ja-JP"])
        == .preflight(locale: "ja-JP")
    )
    #expect(
      try CommandLineParser.parse([
        "serve", "--host", "127.0.0.1", "--port", "8766", "--locale", "ja-JP",
        "--analysis-timeout-ms", "25000"
      ])
        == .serve(
          ServeOptions(
            host: "127.0.0.1",
            port: 8_766,
            locale: "ja-JP",
            analysisTimeoutMilliseconds: 25_000
          )
        )
    )
  }

  @Test(
    "rejects missing, unknown, duplicate, and unsafe options",
    arguments: [
      [String](),
      ["unknown"],
      ["install-assets"],
      ["preflight", "--locale", "en-US"],
      ["serve", "--host", "0.0.0.0", "--port", "8766", "--locale", "ja-JP", "--analysis-timeout-ms", "25000"],
      ["serve", "--host", "127.0.0.1", "--port", "0", "--locale", "ja-JP", "--analysis-timeout-ms", "25000"],
      ["serve", "--host", "127.0.0.1", "--host", "127.0.0.1", "--port", "8766", "--locale", "ja-JP", "--analysis-timeout-ms", "25000"],
      ["serve", "--host", "127.0.0.1", "--port", "8766", "--locale", "ja-JP", "--analysis-timeout-ms", "0"]
    ]
  )
  func rejectsInvalidArguments(arguments: [String]) {
    #expect(throws: CommandLineError.invalidArguments) {
      try CommandLineParser.parse(arguments)
    }
  }
}

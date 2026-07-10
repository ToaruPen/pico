import AppleSpeechCore
import Darwin
import FlyingFox
import Foundation

@main
struct AppleSpeechSidecarEntryPoint {
  static func main() async {
    do {
      let command = try CommandLineParser.parse(Array(CommandLine.arguments.dropFirst()))
      try await run(command)
    } catch is CommandLineError {
      fail("invalid command line")
    } catch {
      fail("command failed")
    }
  }

  private static func run(_ command: SidecarCommand) async throws {
    switch command {
    case .version:
      print("\(AppleSpeechConstants.executableName) \(AppleSpeechConstants.version)")
    case .preflight(let locale):
      guard await AppleSpeechAssets.isReady(localeIdentifier: locale) else {
        throw SidecarServiceError.modelLoad
      }
      print("Apple Speech assets are ready")
    case .installAssets(let locale):
      try await AppleSpeechAssets.install(localeIdentifier: locale)
      print("Apple Speech assets are installed")
    case .serve(let options):
      let engine = AppleSpeechEngine(
        localeIdentifier: options.locale,
        analysisTimeoutMilliseconds: options.analysisTimeoutMilliseconds
      )
      let handler = SidecarHTTPHandler(service: engine)
      let address = try sockaddr_in.inet(ip4: options.host, port: options.port)
      let server = HTTPServer(
        config: makeAppleSpeechHTTPServerConfiguration(
          address: address,
          analysisTimeoutMilliseconds: options.analysisTimeoutMilliseconds
        ),
        handler: handler
      )
      try await server.run()
    }
  }

  private static func fail(_ reason: String) -> Never {
    let line = "\(AppleSpeechConstants.executableName): \(reason)\n"
    FileHandle.standardError.write(Data(line.utf8))
    exit(EXIT_FAILURE)
  }
}

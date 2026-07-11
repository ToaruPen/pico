import Foundation

public struct ServeOptions: Equatable, Sendable {
  public let host: String
  public let port: UInt16
  public let locale: String
  public let analysisTimeoutMilliseconds: Int

  public init(host: String, port: UInt16, locale: String, analysisTimeoutMilliseconds: Int) {
    self.host = host
    self.port = port
    self.locale = locale
    self.analysisTimeoutMilliseconds = analysisTimeoutMilliseconds
  }
}

public enum SidecarCommand: Equatable, Sendable {
  case version
  case installAssets(locale: String)
  case preflight(locale: String)
  case serve(ServeOptions)
}

public enum CommandLineError: Error, Equatable, Sendable {
  case invalidArguments
}

public func commandFailureReason(_ error: any Error) -> String {
  if error is CommandLineError {
    return "invalid command line"
  }
  if let serviceError = error as? SidecarServiceError {
    return serviceError.payload.message
  }
  return "command failed"
}

public enum CommandLineParser {
  public static func parse(_ arguments: [String]) throws -> SidecarCommand {
    guard let command = arguments.first else {
      throw CommandLineError.invalidArguments
    }

    switch command {
    case "--version":
      guard arguments.count == 1 else { throw CommandLineError.invalidArguments }
      return .version
    case "install-assets", "preflight":
      let options = try parseOptions(Array(arguments.dropFirst()))
      guard
        options.count == 1,
        options["--locale"] == AppleSpeechConstants.locale
      else {
        throw CommandLineError.invalidArguments
      }
      if command == "install-assets" {
        return .installAssets(locale: AppleSpeechConstants.locale)
      }
      return .preflight(locale: AppleSpeechConstants.locale)
    case "serve":
      let options = try parseOptions(Array(arguments.dropFirst()))
      guard
        options.count == 4,
        let host = options["--host"],
        host == "127.0.0.1",
        let portText = options["--port"],
        let port = UInt16(portText),
        port > 0,
        options["--locale"] == AppleSpeechConstants.locale,
        let timeoutText = options["--analysis-timeout-ms"],
        let timeout = Int(timeoutText),
        timeout > 0
      else {
        throw CommandLineError.invalidArguments
      }
      return .serve(
        ServeOptions(
          host: host,
          port: port,
          locale: AppleSpeechConstants.locale,
          analysisTimeoutMilliseconds: timeout
        )
      )
    default:
      throw CommandLineError.invalidArguments
    }
  }

  private static func parseOptions(_ arguments: [String]) throws -> [String: String] {
    guard !arguments.isEmpty, arguments.count.isMultiple(of: 2) else {
      throw CommandLineError.invalidArguments
    }

    var options: [String: String] = [:]
    var index = 0
    while index < arguments.count {
      let name = arguments[index]
      let value = arguments[index + 1]
      guard name.hasPrefix("--"), !value.hasPrefix("--"), options[name] == nil else {
        throw CommandLineError.invalidArguments
      }
      options[name] = value
      index += 2
    }
    return options
  }
}

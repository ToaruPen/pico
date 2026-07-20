import Foundation

public enum ResidentIoConfigurationError: Error, Equatable, LocalizedError {
  case missingArgument(String)
  case unknownArgument(String)
  case invalidSampleRate
  case invalidChannels
  case invalidFrameMilliseconds
  case invalidReleaseTail
  case invalidKey(String)
  case identicalKeys

  public var errorDescription: String? {
    switch self {
    case .missingArgument(let name):
      "missing required argument \(name)"
    case .unknownArgument(let name):
      "unknown argument \(name)"
    case .invalidSampleRate:
      "resident I/O sample rate must be 16000 Hz"
    case .invalidChannels:
      "resident I/O channel count must be 1"
    case .invalidFrameMilliseconds:
      "resident I/O frame duration must be a positive integer"
    case .invalidReleaseTail:
      "resident I/O release tail must be 250 ms"
    case .invalidKey(let name):
      "unknown keyboard control \(name)"
    case .identicalKeys:
      "talk and cancel controls must be different"
    }
  }
}

public struct ResidentIoConfiguration: Equatable, Sendable {
  public let deviceUID: String
  public let sampleRateHz: UInt32
  public let channels: UInt32
  public let frameMilliseconds: UInt32
  public let releaseTailMilliseconds: UInt32
  public let talkKey: String
  public let cancelKey: String
  public let talkKeyCode: UInt16
  public let cancelKeyCode: UInt16

  public static func parse(arguments: [String]) throws -> ResidentIoConfiguration {
    let values = try parseNamedArguments(arguments)
    let deviceUID = try require(values, "--device-uid")
    let sampleRateText = try require(values, "--sample-rate-hz")
    let channelsText = try require(values, "--channels")
    let frameMillisecondsText = try require(values, "--frame-ms")
    let releaseTailText = try require(values, "--release-tail-ms")
    let talkKey = try require(values, "--talk-key")
    let cancelKey = try require(values, "--cancel-key")

    guard UInt32(sampleRateText) == 16_000 else {
      throw ResidentIoConfigurationError.invalidSampleRate
    }
    guard UInt32(channelsText) == 1 else {
      throw ResidentIoConfigurationError.invalidChannels
    }
    guard let frameMilliseconds = UInt32(frameMillisecondsText), frameMilliseconds > 0 else {
      throw ResidentIoConfigurationError.invalidFrameMilliseconds
    }
    guard UInt32(releaseTailText) == 250 else {
      throw ResidentIoConfigurationError.invalidReleaseTail
    }

    guard let talkKeyCode = MacKeyCodes.value(for: talkKey) else {
      throw ResidentIoConfigurationError.invalidKey(talkKey)
    }

    guard let cancelKeyCode = MacKeyCodes.value(for: cancelKey) else {
      throw ResidentIoConfigurationError.invalidKey(cancelKey)
    }

    guard talkKeyCode != cancelKeyCode else {
      throw ResidentIoConfigurationError.identicalKeys
    }

    return ResidentIoConfiguration(
      deviceUID: deviceUID,
      sampleRateHz: 16_000,
      channels: 1,
      frameMilliseconds: frameMilliseconds,
      releaseTailMilliseconds: 250,
      talkKey: talkKey,
      cancelKey: cancelKey,
      talkKeyCode: talkKeyCode,
      cancelKeyCode: cancelKeyCode
    )
  }
}

private func parseNamedArguments(_ arguments: [String]) throws -> [String: String] {
  var values: [String: String] = [:]
  var index = 0
  let known = Set([
    "--device-uid", "--sample-rate-hz", "--channels", "--frame-ms", "--release-tail-ms",
    "--talk-key", "--cancel-key",
  ])

  while index < arguments.count {
    let name = arguments[index]
    guard known.contains(name) else {
      throw ResidentIoConfigurationError.unknownArgument(name)
    }

    let valueIndex = index + 1
    guard valueIndex < arguments.count else {
      throw ResidentIoConfigurationError.missingArgument(name)
    }

    values[name] = arguments[valueIndex]
    index += 2
  }

  return values
}

private func require(_ values: [String: String], _ name: String) throws -> String {
  guard let value = values[name], !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  else {
    throw ResidentIoConfigurationError.missingArgument(name)
  }

  return value
}

public enum MacKeyCodes {
  private static let codes: [String: UInt16] = [
    "A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5, "Z": 6, "X": 7,
    "C": 8, "V": 9, "B": 11, "Q": 12, "W": 13, "E": 14, "R": 15,
    "Y": 16, "T": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22,
    "5": 23, "Equal": 24, "9": 25, "7": 26, "Minus": 27, "8": 28,
    "0": 29, "RightBracket": 30, "O": 31, "U": 32, "LeftBracket": 33,
    "I": 34, "P": 35, "Return": 36, "L": 37, "J": 38, "Quote": 39,
    "K": 40, "Semicolon": 41, "Backslash": 42, "Comma": 43, "Slash": 44,
    "N": 45, "M": 46, "Period": 47, "Tab": 48, "Space": 49, "Grave": 50,
    "Backspace": 51, "Escape": 53, "F17": 64, "F18": 79, "F19": 80,
    "F20": 90, "F5": 96, "F6": 97, "F7": 98, "F3": 99, "F8": 100,
    "F9": 101, "F11": 103, "F13": 105, "F16": 106, "F14": 107,
    "F10": 109, "F12": 111, "F15": 113, "Home": 115, "PageUp": 116,
    "Delete": 117, "F4": 118, "End": 119, "F2": 120, "PageDown": 121,
    "F1": 122, "LeftArrow": 123, "RightArrow": 124, "DownArrow": 125,
    "UpArrow": 126,
  ]

  public static func value(for name: String) -> UInt16? {
    codes[name]
  }
}

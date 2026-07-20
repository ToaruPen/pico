import Foundation

public struct StreamingStartMessage: Equatable, Sendable {
  public let timeoutMilliseconds: Int

  public init(timeoutMilliseconds: Int) {
    self.timeoutMilliseconds = timeoutMilliseconds
  }
}

public enum StreamingClientMessage: Equatable, Sendable {
  case start(StreamingStartMessage)
  case finish
}

public enum StreamingWireContract {
  public static let maximumBinaryMessageBytes = 64 * 1_024

  private static let startKeys = Set([
    "type", "version", "provider", "language", "timeoutMs", "encoding", "sampleRateHz",
    "channels",
  ])
  private static let finishKeys = Set(["type"])

  public static func decodeClientText(_ data: Data) throws -> StreamingClientMessage {
    guard !data.isEmpty else { throw SidecarServiceError.invalidRequest }

    let object: Any
    do {
      object = try JSONSerialization.jsonObject(with: data)
    } catch {
      throw SidecarServiceError.invalidRequest
    }
    guard
      let root = object as? [String: Any],
      let type = root["type"] as? String
    else {
      throw SidecarServiceError.invalidRequest
    }

    switch type {
    case "start":
      guard Set(root.keys) == startKeys else {
        throw SidecarServiceError.invalidRequest
      }
      let message: StartWireMessage
      do {
        message = try JSONDecoder().decode(StartWireMessage.self, from: data)
      } catch {
        throw SidecarServiceError.invalidRequest
      }
      guard
        message.type == "start",
        message.version == 1,
        message.provider == AppleSpeechConstants.provider,
        message.language == AppleSpeechConstants.locale,
        message.timeoutMs > 0,
        message.encoding == AppleSpeechConstants.encoding,
        message.sampleRateHz == AppleSpeechConstants.sampleRateHz,
        message.channels == AppleSpeechConstants.channels
      else {
        throw SidecarServiceError.invalidRequest
      }
      return .start(StreamingStartMessage(timeoutMilliseconds: message.timeoutMs))
    case "finish":
      guard Set(root.keys) == finishKeys else {
        throw SidecarServiceError.invalidRequest
      }
      return .finish
    default:
      throw SidecarServiceError.invalidRequest
    }
  }

  public static func validateBinary(_ data: Data) throws {
    guard
      !data.isEmpty,
      data.count.isMultiple(of: 2),
      data.count <= maximumBinaryMessageBytes
    else {
      throw SidecarServiceError.invalidRequest
    }
  }

  public static func encodeReady() throws -> Data {
    try encoder().encode(
      ReadyWireMessage(
        type: "ready",
        version: 1,
        provider: AppleSpeechConstants.provider
      )
    )
  }

  public static func encodeCompleted(_ result: TranscriptionResult) throws -> Data {
    try encoder().encode(
      CompletedWireMessage(
        type: "completed",
        provider: AppleSpeechConstants.provider,
        result: result
      )
    )
  }

  public static func encodeFailed(_ error: SidecarServiceError) throws -> Data {
    try encoder().encode(
      FailedWireMessage(
        type: "failed",
        provider: AppleSpeechConstants.provider,
        error: error.payload
      )
    )
  }

  private static func encoder() -> JSONEncoder {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return encoder
  }
}

private struct StartWireMessage: Decodable {
  let type: String
  let version: Int
  let provider: String
  let language: String
  let timeoutMs: Int
  let encoding: String
  let sampleRateHz: Int
  let channels: Int
}

private struct ReadyWireMessage: Encodable {
  let type: String
  let version: Int
  let provider: String
}

private struct CompletedWireMessage: Encodable {
  let type: String
  let provider: String
  let result: TranscriptionResult
}

private struct FailedWireMessage: Encodable {
  let type: String
  let provider: String
  let error: SidecarErrorPayload
}

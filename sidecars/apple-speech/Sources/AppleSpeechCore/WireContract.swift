import Foundation

public enum AppleSpeechConstants {
  public static let executableName = "pico-apple-speech-sidecar"
  public static let version = "0.1.0"
  public static let provider = "apple-speech"
  public static let locale = "ja-JP"
  public static let encoding = "pcm16le"
  public static let sampleRateHz = 16_000
  public static let channels = 1
}

public struct AudioRequest: Codable, Equatable, Sendable {
  public let encoding: String
  public let sampleRateHz: Int
  public let channels: Int
  public let dataBase64: String

  public init(encoding: String, sampleRateHz: Int, channels: Int, dataBase64: String) {
    self.encoding = encoding
    self.sampleRateHz = sampleRateHz
    self.channels = channels
    self.dataBase64 = dataBase64
  }
}

public struct AudioNormalization: Codable, Equatable, Sendable {
  public let targetEncoding: String
  public let targetSampleRateHz: Int
  public let targetChannels: Int

  public init(targetEncoding: String, targetSampleRateHz: Int, targetChannels: Int) {
    self.targetEncoding = targetEncoding
    self.targetSampleRateHz = targetSampleRateHz
    self.targetChannels = targetChannels
  }
}

public struct TranscriptionRequest: Codable, Equatable, Sendable {
  public let provider: String
  public let language: String
  public let timeoutMs: Int
  public let audio: AudioRequest
  public let normalization: AudioNormalization

  public init(
    provider: String,
    language: String,
    timeoutMs: Int,
    audio: AudioRequest,
    normalization: AudioNormalization
  ) {
    self.provider = provider
    self.language = language
    self.timeoutMs = timeoutMs
    self.audio = audio
    self.normalization = normalization
  }
}

public struct ValidatedTranscriptionRequest: Equatable, Sendable {
  public let timeoutMilliseconds: Int
  public let audio: Data
  public let durationMilliseconds: Double

  public init(timeoutMilliseconds: Int, audio: Data, durationMilliseconds: Double) {
    self.timeoutMilliseconds = timeoutMilliseconds
    self.audio = audio
    self.durationMilliseconds = durationMilliseconds
  }
}

public struct TranscriptSegment: Codable, Equatable, Sendable {
  public let text: String
  public let startMs: Double
  public let endMs: Double
  public let confidence: Double

  public init(text: String, startMs: Double, endMs: Double, confidence: Double) {
    self.text = text
    self.startMs = startMs
    self.endMs = endMs
    self.confidence = confidence
  }
}

public struct TranscriptionResult: Codable, Equatable, Sendable {
  public let text: String
  public let language: String
  public let confidence: Double
  public let durationMs: Double
  public let segments: [TranscriptSegment]

  public init(
    text: String,
    language: String,
    confidence: Double,
    durationMs: Double,
    segments: [TranscriptSegment]
  ) {
    self.text = text
    self.language = language
    self.confidence = confidence
    self.durationMs = durationMs
    self.segments = segments
  }
}

public enum SidecarErrorCode: String, Codable, Equatable, Sendable {
  case invalidRequest = "invalid_request"
  case timeout
  case modelLoad = "model_load"
  case backendError = "backend_error"
}

public struct SidecarErrorPayload: Codable, Equatable, Sendable {
  public let code: SidecarErrorCode
  public let message: String

  public init(code: SidecarErrorCode, message: String) {
    self.code = code
    self.message = message
  }
}

public struct TranscriptionSuccessResponse: Codable, Equatable, Sendable {
  public let provider: String
  public let ok: Bool
  public let result: TranscriptionResult

  public init(provider: String, ok: Bool, result: TranscriptionResult) {
    self.provider = provider
    self.ok = ok
    self.result = result
  }
}

public struct TranscriptionFailureResponse: Codable, Equatable, Sendable {
  public let provider: String
  public let ok: Bool
  public let error: SidecarErrorPayload

  public init(provider: String, ok: Bool, error: SidecarErrorPayload) {
    self.provider = provider
    self.ok = ok
    self.error = error
  }
}

public enum SidecarServiceError: Error, Equatable, Sendable {
  case invalidRequest
  case timeout
  case modelLoad
  case backendError
  case busy

  public var payload: SidecarErrorPayload {
    switch self {
    case .invalidRequest:
      SidecarErrorPayload(code: .invalidRequest, message: "request is invalid")
    case .timeout:
      SidecarErrorPayload(code: .timeout, message: "transcription timed out")
    case .modelLoad:
      SidecarErrorPayload(code: .modelLoad, message: "speech assets are unavailable")
    case .backendError:
      SidecarErrorPayload(code: .backendError, message: "speech backend failed")
    case .busy:
      SidecarErrorPayload(code: .backendError, message: "speech backend is busy")
    }
  }
}

public enum WireContract {
  public static let maximumDecodedAudioBytes = 4 * 1_024 * 1_024
  public static let maximumRequestBodyBytes =
    ((maximumDecodedAudioBytes + 2) / 3) * 4 + 1_024

  private static let rootKeys = Set(["provider", "language", "timeoutMs", "audio", "normalization"])
  private static let audioKeys = Set(["encoding", "sampleRateHz", "channels", "dataBase64"])
  private static let normalizationKeys = Set([
    "targetEncoding", "targetSampleRateHz", "targetChannels"
  ])

  public static func decodeAndValidate(_ data: Data) throws -> ValidatedTranscriptionRequest {
    guard !data.isEmpty, data.count <= maximumRequestBodyBytes else {
      throw SidecarServiceError.invalidRequest
    }

    let object: Any
    do {
      object = try JSONSerialization.jsonObject(with: data)
    } catch {
      throw SidecarServiceError.invalidRequest
    }

    guard
      let root = object as? [String: Any],
      Set(root.keys) == rootKeys,
      let audioObject = root["audio"] as? [String: Any],
      Set(audioObject.keys) == audioKeys,
      let normalizationObject = root["normalization"] as? [String: Any],
      Set(normalizationObject.keys) == normalizationKeys
    else {
      throw SidecarServiceError.invalidRequest
    }

    let request: TranscriptionRequest
    do {
      request = try JSONDecoder().decode(TranscriptionRequest.self, from: data)
    } catch {
      throw SidecarServiceError.invalidRequest
    }

    guard
      request.provider == AppleSpeechConstants.provider,
      request.language == AppleSpeechConstants.locale,
      request.timeoutMs > 0,
      request.audio.encoding == AppleSpeechConstants.encoding,
      request.audio.sampleRateHz == AppleSpeechConstants.sampleRateHz,
      request.audio.channels == AppleSpeechConstants.channels,
      request.normalization.targetEncoding == AppleSpeechConstants.encoding,
      request.normalization.targetSampleRateHz == AppleSpeechConstants.sampleRateHz,
      request.normalization.targetChannels == AppleSpeechConstants.channels,
      let decodedAudio = Data(base64Encoded: request.audio.dataBase64),
      decodedAudio.base64EncodedString() == request.audio.dataBase64,
      !decodedAudio.isEmpty,
      decodedAudio.count.isMultiple(of: 2),
      decodedAudio.count <= maximumDecodedAudioBytes
    else {
      throw SidecarServiceError.invalidRequest
    }

    return ValidatedTranscriptionRequest(
      timeoutMilliseconds: request.timeoutMs,
      audio: decodedAudio,
      durationMilliseconds: try PCM16LE.durationMilliseconds(forByteCount: decodedAudio.count)
    )
  }

  public static func encodeSuccess(_ result: TranscriptionResult) throws -> Data {
    try makeEncoder().encode(
      TranscriptionSuccessResponse(
        provider: AppleSpeechConstants.provider,
        ok: true,
        result: result
      )
    )
  }

  public static func encodeFailure(_ error: SidecarServiceError) throws -> Data {
    try makeEncoder().encode(
      TranscriptionFailureResponse(
        provider: AppleSpeechConstants.provider,
        ok: false,
        error: error.payload
      )
    )
  }

  private static func makeEncoder() -> JSONEncoder {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return encoder
  }
}

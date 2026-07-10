import Foundation

public struct TranscriptRun: Equatable, Sendable {
  public let text: String
  public let startMs: Double?
  public let endMs: Double?
  public let confidence: Double?

  public init(text: String, startMs: Double?, endMs: Double?, confidence: Double?) {
    self.text = text
    self.startMs = startMs
    self.endMs = endMs
    self.confidence = confidence
  }
}

public enum TranscriptMapper {
  public static func map(
    runs: [TranscriptRun],
    audioDurationMilliseconds: Double
  ) throws -> TranscriptionResult {
    guard audioDurationMilliseconds.isFinite, audioDurationMilliseconds >= 0 else {
      throw SidecarServiceError.backendError
    }

    let text = runs.map(\.text).joined()
    guard !text.isEmpty else {
      return TranscriptionResult(
        text: "",
        language: AppleSpeechConstants.locale,
        confidence: 0,
        durationMs: audioDurationMilliseconds,
        segments: []
      )
    }

    let segments = runs.compactMap(makeSegment)
    let totalDuration = segments.reduce(0) { partial, segment in
      partial + (segment.endMs - segment.startMs)
    }
    guard totalDuration.isFinite, totalDuration > 0 else {
      throw SidecarServiceError.backendError
    }

    let weightedConfidence = segments.reduce(0) { partial, segment in
      partial + segment.confidence * (segment.endMs - segment.startMs)
    } / totalDuration
    guard weightedConfidence.isFinite else {
      throw SidecarServiceError.backendError
    }

    return TranscriptionResult(
      text: text,
      language: AppleSpeechConstants.locale,
      confidence: weightedConfidence,
      durationMs: audioDurationMilliseconds,
      segments: segments
    )
  }

  private static func makeSegment(from run: TranscriptRun) -> TranscriptSegment? {
    guard
      !run.text.isEmpty,
      let startMs = run.startMs,
      let endMs = run.endMs,
      let confidence = run.confidence,
      startMs.isFinite,
      endMs.isFinite,
      confidence.isFinite,
      startMs >= 0,
      endMs > startMs,
      (0...1).contains(confidence)
    else {
      return nil
    }

    return TranscriptSegment(
      text: run.text,
      startMs: startMs,
      endMs: endMs,
      confidence: confidence
    )
  }
}

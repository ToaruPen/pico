import Testing

@testable import AppleSpeechCore

@Suite("Final transcript mapping")
struct TranscriptMappingTests {
  @Test("preserves arrival order and duration-weights confidence")
  func mapsFinalRuns() throws {
    let mapped = try TranscriptMapper.map(
      runs: [
        TranscriptRun(text: "こん", startMs: 0, endMs: 100, confidence: 0.5),
        TranscriptRun(text: "にちは", startMs: 100, endMs: 400, confidence: 1)
      ],
      audioDurationMilliseconds: 500
    )

    #expect(mapped.text == "こんにちは")
    #expect(mapped.language == "ja-JP")
    #expect(mapped.durationMs == 500)
    #expect(mapped.confidence == 0.875)
    #expect(
      mapped.segments == [
        TranscriptSegment(text: "こん", startMs: 0, endMs: 100, confidence: 0.5),
        TranscriptSegment(text: "にちは", startMs: 100, endMs: 400, confidence: 1)
      ]
    )
  }

  @Test("maps silence to an empty zero-confidence result")
  func mapsSilence() throws {
    let mapped = try TranscriptMapper.map(runs: [], audioDurationMilliseconds: 320)

    #expect(mapped.text == "")
    #expect(mapped.confidence == 0)
    #expect(mapped.durationMs == 320)
    #expect(mapped.segments.isEmpty)
  }

  @Test("fails nonempty output with no valid duration weight")
  func rejectsUnweightedText() {
    #expect(throws: SidecarServiceError.backendError) {
      try TranscriptMapper.map(
        runs: [TranscriptRun(text: "こんにちは", startMs: nil, endMs: nil, confidence: nil)],
        audioDurationMilliseconds: 500
      )
    }
  }

  @Test("ignores invalid attributed ranges when other runs are valid")
  func ignoresInvalidRanges() throws {
    let mapped = try TranscriptMapper.map(
      runs: [
        TranscriptRun(text: "A", startMs: .nan, endMs: 10, confidence: 0.2),
        TranscriptRun(text: "B", startMs: 10, endMs: 20, confidence: 0.8),
        TranscriptRun(text: "C", startMs: 20, endMs: 20, confidence: 0.4),
        TranscriptRun(text: "D", startMs: 20, endMs: 30, confidence: 2)
      ],
      audioDurationMilliseconds: 40
    )

    #expect(mapped.text == "ABCD")
    #expect(mapped.confidence == 0.8)
    #expect(mapped.segments.map(\.text) == ["B"])
  }
}

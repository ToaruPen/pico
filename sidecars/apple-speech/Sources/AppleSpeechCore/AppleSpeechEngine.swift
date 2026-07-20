import AVFoundation
import CoreMedia
import Foundation
import Speech

public actor AppleSpeechEngine: AppleSpeechServing, AppleSpeechStreamingServing {
  private let localeIdentifier: String
  private let analysisTimeoutMilliseconds: Int

  public init(localeIdentifier: String, analysisTimeoutMilliseconds: Int) {
    self.localeIdentifier = localeIdentifier
    self.analysisTimeoutMilliseconds = analysisTimeoutMilliseconds
  }

  public func isReady() async -> Bool {
    await AppleSpeechAssets.isReady(localeIdentifier: localeIdentifier)
  }

  public func transcribe(
    _ request: ValidatedTranscriptionRequest
  ) async throws -> TranscriptionResult {
    do {
      let transcriber = try await AppleSpeechAssets.makeReadyTranscriber(
        localeIdentifier: localeIdentifier
      )
      return try await performTranscription(request, transcriber: transcriber)
    } catch is CancellationError {
      throw CancellationError()
    } catch let error as SidecarServiceError {
      throw error
    } catch {
      throw SidecarServiceError.backendError
    }
  }

  public func makeStreamingSession(
    timeoutMilliseconds: Int
  ) async throws -> any AppleSpeechStreamingSession {
    try await AppleSpeechStreamingAnalysisSession.make(
      localeIdentifier: localeIdentifier,
      clientTimeoutMilliseconds: timeoutMilliseconds,
      analysisTimeoutMilliseconds: analysisTimeoutMilliseconds
    )
  }

  private func performTranscription(
    _ request: ValidatedTranscriptionRequest,
    transcriber: SpeechTranscriber
  ) async throws -> TranscriptionResult {
    let audio = AnalysisAudio(buffer: try PCM16LE.makeBuffer(from: request.audio))
    let analyzer = SpeechAnalyzer(
      modules: [transcriber],
      options: SpeechAnalyzer.Options(
        priority: .userInitiated,
        modelRetention: .processLifetime
      )
    )

    let consumer = Task<[TranscriptRun], any Error> {
      var runs: [TranscriptRun] = []
      for try await result in transcriber.results {
        guard result.isFinal else { continue }
        runs.append(contentsOf: Self.makeRuns(from: result.text))
      }
      return runs
    }

    let input = AsyncStream<AnalyzerInput> { continuation in
      continuation.yield(AnalyzerInput(buffer: audio.buffer))
      continuation.finish()
    }
    let timeout = min(request.timeoutMilliseconds, analysisTimeoutMilliseconds)

    return try await withThrowingTaskGroup(of: TranscriptionResult.self) { group in
      group.addTask {
        try await analyzer.prepareToAnalyze(in: audio.format)
        let runs = try await Self.runAnalysis(
          analyze: { try await analyzer.analyzeSequence(input) },
          finalize: { try await analyzer.finalizeAndFinish(through: $0) },
          cancelWhenEmpty: { await analyzer.cancelAndFinishNow() },
          consume: { try await consumer.value }
        )
        return try TranscriptMapper.map(
          runs: runs,
          audioDurationMilliseconds: request.durationMilliseconds
        )
      }
      group.addTask {
        try await Task.sleep(for: .milliseconds(timeout))
        throw SidecarServiceError.timeout
      }

      do {
        guard let result = try await group.next() else {
          throw SidecarServiceError.backendError
        }
        group.cancelAll()
        return result
      } catch {
        group.cancelAll()
        await analyzer.cancelAndFinishNow()
        consumer.cancel()
        _ = await consumer.result
        throw error
      }
    }
  }

  static func runAnalysis<Result: Sendable>(
    analyze: @Sendable () async throws -> CMTime?,
    finalize: @Sendable (CMTime) async throws -> Void,
    cancelWhenEmpty: @Sendable () async -> Void,
    consume: @Sendable () async throws -> Result
  ) async throws -> Result {
    let lastTime = try await analyze()
    try Task.checkCancellation()

    if let lastTime {
      try await finalize(lastTime)
    } else {
      await cancelWhenEmpty()
    }

    try Task.checkCancellation()
    return try await consume()
  }

  nonisolated static func makeRuns(
    from transcription: AttributedString
  ) -> [TranscriptRun] {
    transcription.runs.map { run in
      let text = String(transcription[run.range].characters)
      let timeRange = run.audioTimeRange
      return TranscriptRun(
        text: text,
        startMs: timeRange.map { CMTimeGetSeconds($0.start) * 1_000 },
        endMs: timeRange.map { CMTimeGetSeconds(CMTimeRangeGetEnd($0)) * 1_000 },
        confidence: run.transcriptionConfidence
      )
    }
  }
}

private struct AnalysisAudio: @unchecked Sendable {
  let buffer: AVAudioPCMBuffer

  var format: AVAudioFormat {
    buffer.format
  }
}

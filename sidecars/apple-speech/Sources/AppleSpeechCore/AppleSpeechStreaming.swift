import AVFoundation
import CoreMedia
import Foundation
import Speech

public protocol AppleSpeechStreamingSession: Sendable {
  func send(_ audio: Data) async throws
  func finish() async throws -> TranscriptionResult
  func cancel() async
}

public protocol AppleSpeechStreamingServing: Sendable {
  func makeStreamingSession(timeoutMilliseconds: Int) async throws
    -> any AppleSpeechStreamingSession
}

actor StreamingAudioInput {
  static let defaultMaximumBufferedBytes = 8 * 1_024 * 1_024

  let maximumBufferedBytes: Int
  private(set) var totalAcceptedBytes: Int64 = 0
  private(set) var maximumObservedBufferedBytes = 0

  private var bufferedBytes = 0
  private var queue: [Data] = []
  private var waiter: CheckedContinuation<Data?, any Error>?
  private var termination: Termination?

  init(maximumBufferedBytes: Int = defaultMaximumBufferedBytes) {
    precondition(maximumBufferedBytes > 0)
    self.maximumBufferedBytes = maximumBufferedBytes
  }

  func send(_ data: Data) throws {
    try throwIfTerminated()

    let (newTotal, totalOverflow) = totalAcceptedBytes.addingReportingOverflow(Int64(data.count))
    guard !totalOverflow else {
      fail(with: .inputOverflow)
      throw SidecarServiceError.inputOverflow
    }

    if let waiter {
      self.waiter = nil
      totalAcceptedBytes = newTotal
      waiter.resume(returning: data)
      return
    }

    guard data.count <= maximumBufferedBytes - bufferedBytes else {
      fail(with: .inputOverflow)
      throw SidecarServiceError.inputOverflow
    }

    queue.append(data)
    bufferedBytes += data.count
    totalAcceptedBytes = newTotal
    maximumObservedBufferedBytes = max(maximumObservedBufferedBytes, bufferedBytes)
  }

  func next() async throws -> Data? {
    if !queue.isEmpty {
      let data = queue.removeFirst()
      bufferedBytes -= data.count
      return data
    }

    if let termination {
      return try termination.result.get()
    }

    guard waiter == nil else {
      throw SidecarServiceError.backendError
    }
    return try await withCheckedThrowingContinuation { continuation in
      waiter = continuation
    }
  }

  func finish() {
    guard termination == nil else { return }
    termination = .finished
    if queue.isEmpty {
      waiter?.resume(returning: nil)
      waiter = nil
    }
  }

  func cancel() {
    guard termination == nil else { return }
    termination = .cancelled
    queue.removeAll(keepingCapacity: false)
    bufferedBytes = 0
    waiter?.resume(throwing: CancellationError())
    waiter = nil
  }

  private func fail(with error: SidecarServiceError) {
    guard termination == nil else { return }
    termination = .failed(error)
    queue.removeAll(keepingCapacity: false)
    bufferedBytes = 0
    waiter?.resume(throwing: error)
    waiter = nil
  }

  private func throwIfTerminated() throws {
    guard let termination else { return }
    switch termination {
    case .finished:
      throw SidecarServiceError.invalidRequest
    case .cancelled:
      throw CancellationError()
    case .failed(let error):
      throw error
    }
  }

  private enum Termination {
    case finished
    case cancelled
    case failed(SidecarServiceError)

    var result: Result<Data?, any Error> {
      switch self {
      case .finished:
        .success(nil)
      case .cancelled:
        .failure(CancellationError())
      case .failed(let error):
        .failure(error)
      }
    }
  }
}

actor AppleSpeechStreamingAnalysisSession: AppleSpeechStreamingSession {
  private let input: StreamingAudioInput
  private let analysisTask: Task<TranscriptionResult, any Error>
  private let finalizationTimeoutMilliseconds: Int
  private var state = State.active

  private init(
    input: StreamingAudioInput,
    analysisTask: Task<TranscriptionResult, any Error>,
    finalizationTimeoutMilliseconds: Int
  ) {
    self.input = input
    self.analysisTask = analysisTask
    self.finalizationTimeoutMilliseconds = finalizationTimeoutMilliseconds
  }

  static func make(
    localeIdentifier: String,
    clientTimeoutMilliseconds: Int,
    analysisTimeoutMilliseconds: Int
  ) async throws -> AppleSpeechStreamingAnalysisSession {
    let transcriber = try await AppleSpeechAssets.makeReadyTranscriber(
      localeIdentifier: localeIdentifier
    )
    let analyzer = SpeechAnalyzer(
      modules: [transcriber],
      options: SpeechAnalyzer.Options(
        priority: .userInitiated,
        modelRetention: .processLifetime
      )
    )
    try await analyzer.prepareToAnalyze(in: PCM16LE.makeFormat())

    let input = StreamingAudioInput()
    let analysisTask = Task<TranscriptionResult, any Error> {
      let consumer = Task<[TranscriptRun], any Error> {
        var runs: [TranscriptRun] = []
        for try await result in transcriber.results {
          guard result.isFinal else { continue }
          runs.append(contentsOf: AppleSpeechEngine.makeRuns(from: result.text))
        }
        return runs
      }

      do {
        let lastTime = try await analyzer.analyzeSequence(
          StreamingAnalyzerInputSequence(input: input)
        )
        try Task.checkCancellation()
        guard let lastTime else {
          await analyzer.cancelAndFinishNow()
          consumer.cancel()
          _ = await consumer.result
          throw SidecarServiceError.invalidRequest
        }
        try await analyzer.finalizeAndFinish(through: lastTime)
        try Task.checkCancellation()
        let runs = try await consumer.value
        let duration = try await PCM16LE.streamingDurationMilliseconds(
          forByteCount: input.totalAcceptedBytes
        )
        return try TranscriptMapper.map(
          runs: runs,
          audioDurationMilliseconds: duration
        )
      } catch {
        await analyzer.cancelAndFinishNow()
        consumer.cancel()
        _ = await consumer.result
        if error is CancellationError {
          throw CancellationError()
        }
        if let serviceError = error as? SidecarServiceError {
          throw serviceError
        }
        throw SidecarServiceError.backendError
      }
    }

    return AppleSpeechStreamingAnalysisSession(
      input: input,
      analysisTask: analysisTask,
      finalizationTimeoutMilliseconds: min(
        clientTimeoutMilliseconds,
        analysisTimeoutMilliseconds
      )
    )
  }

  func send(_ audio: Data) async throws {
    guard state == .active else { throw SidecarServiceError.invalidRequest }
    try await input.send(audio)
  }

  func finish() async throws -> TranscriptionResult {
    guard state == .active else { throw SidecarServiceError.invalidRequest }
    state = .finishing
    await input.finish()

    let task = analysisTask
    let input = input
    let timeout = finalizationTimeoutMilliseconds
    do {
      let result = try await withThrowingTaskGroup(of: TranscriptionResult.self) { group in
        group.addTask { try await task.value }
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
          await input.cancel()
          task.cancel()
          _ = await task.result
          group.cancelAll()
          throw error
        }
      }
      state = .completed
      return result
    } catch {
      state = .cancelled
      throw error
    }
  }

  func cancel() async {
    guard state != .completed, state != .cancelled else { return }
    state = .cancelled
    await input.cancel()
    analysisTask.cancel()
    _ = await analysisTask.result
  }

  private enum State {
    case active
    case finishing
    case completed
    case cancelled
  }
}

private struct StreamingAnalyzerInputSequence: AsyncSequence, Sendable {
  typealias Element = AnalyzerInput

  let input: StreamingAudioInput

  func makeAsyncIterator() -> Iterator {
    Iterator(input: input)
  }

  struct Iterator: AsyncIteratorProtocol {
    let input: StreamingAudioInput

    mutating func next() async throws -> AnalyzerInput? {
      guard let data = try await input.next() else { return nil }
      return AnalyzerInput(buffer: try PCM16LE.makeBuffer(from: data))
    }
  }
}

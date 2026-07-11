import CoreMedia
import Testing

@testable import AppleSpeechCore

@Suite("Apple Speech analysis cancellation")
struct AppleSpeechEngineCancellationTests {
  @Test("stops after analyze returns normally for a cancelled task")
  func stopsAfterCancelledAnalyze() async {
    let analyzeGate = SuspensionGate()
    let events = EventLog()
    let task = Task {
      try await AppleSpeechEngine.runAnalysis(
        analyze: {
          await analyzeGate.suspendUntilReleased()
          await events.append("analyze")
          return .zero
        },
        finalize: { _ in await events.append("finalize") },
        cancelWhenEmpty: { await events.append("cancel-empty") },
        consume: {
          await events.append("consume")
          return 1
        }
      )
    }

    await analyzeGate.waitUntilSuspended()
    task.cancel()
    await analyzeGate.release()

    await expectCancellation(from: task)
    #expect(await events.values == ["analyze"])
  }

  @Test("stops after finalize returns normally for a cancelled task")
  func stopsAfterCancelledFinalize() async {
    let finalizeGate = SuspensionGate()
    let events = EventLog()
    let task = Task {
      try await AppleSpeechEngine.runAnalysis(
        analyze: {
          await events.append("analyze")
          return .zero
        },
        finalize: { _ in
          await events.append("finalize")
          await finalizeGate.suspendUntilReleased()
        },
        cancelWhenEmpty: { await events.append("cancel-empty") },
        consume: {
          await events.append("consume")
          return 1
        }
      )
    }

    await finalizeGate.waitUntilSuspended()
    task.cancel()
    await finalizeGate.release()

    await expectCancellation(from: task)
    #expect(await events.values == ["analyze", "finalize"])
  }

  private func expectCancellation(from task: Task<Int, any Error>) async {
    do {
      _ = try await task.value
      Issue.record("cancelled analysis must not complete successfully")
    } catch is CancellationError {
      return
    } catch {
      Issue.record("unexpected error: \(error)")
    }
  }
}

private actor SuspensionGate {
  private var suspended = false
  private var suspensionWaiters: [CheckedContinuation<Void, Never>] = []
  private var releaseContinuation: CheckedContinuation<Void, Never>?

  func suspendUntilReleased() async {
    suspended = true
    suspensionWaiters.forEach { $0.resume() }
    suspensionWaiters.removeAll()
    await withCheckedContinuation { continuation in
      releaseContinuation = continuation
    }
  }

  func waitUntilSuspended() async {
    guard !suspended else { return }
    await withCheckedContinuation { continuation in
      suspensionWaiters.append(continuation)
    }
  }

  func release() {
    releaseContinuation?.resume()
    releaseContinuation = nil
  }
}

private actor EventLog {
  private(set) var values: [String] = []

  func append(_ value: String) {
    values.append(value)
  }
}

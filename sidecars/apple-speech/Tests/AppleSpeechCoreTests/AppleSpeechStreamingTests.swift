import Foundation
import Testing

@testable import AppleSpeechCore

@Suite("Apple Speech streaming input")
struct AppleSpeechStreamingTests {
  @Test("delivers multiple chunks in order and then finishes")
  func deliversChunksInOrder() async throws {
    let input = StreamingAudioInput(maximumBufferedBytes: 8)

    try await input.send(Data([0, 1]))
    try await input.send(Data([2, 3, 4, 5]))
    await input.finish()

    #expect(try await input.next() == Data([0, 1]))
    #expect(try await input.next() == Data([2, 3, 4, 5]))
    #expect(try await input.next() == nil)
    #expect(await input.totalAcceptedBytes == 6)
  }

  @Test("fails before accepting a chunk that exceeds the byte bound")
  func failsBeforeOverflowing() async throws {
    let input = StreamingAudioInput(maximumBufferedBytes: 4)
    try await input.send(Data([0, 1, 2, 3]))

    await #expect(throws: SidecarServiceError.inputOverflow) {
      try await input.send(Data([4, 5]))
    }
    await #expect(throws: SidecarServiceError.inputOverflow) {
      try await input.next()
    }
    #expect(await input.totalAcceptedBytes == 4)
  }

  @Test("accepts more than four MiB over time without retaining the full turn")
  func acceptsLongTurnIncrementally() async throws {
    let input = StreamingAudioInput(maximumBufferedBytes: 64 * 1_024)
    let chunk = Data(repeating: 0, count: 32 * 1_024)
    let repetitions = 129

    for _ in 0..<repetitions {
      try await input.send(chunk)
      #expect(try await input.next()?.count == chunk.count)
    }
    await input.finish()

    #expect(try await input.next() == nil)
    #expect(await input.totalAcceptedBytes == Int64(chunk.count * repetitions))
    #expect(await input.maximumObservedBufferedBytes == chunk.count)
  }

  @Test("cancellation wakes a waiting consumer and rejects later sends")
  func cancellationConverges() async throws {
    let input = StreamingAudioInput(maximumBufferedBytes: 8)
    let consumer = Task { try await input.next() }

    await input.cancel()

    await #expect(throws: CancellationError.self) {
      try await consumer.value
    }
    await #expect(throws: CancellationError.self) {
      try await input.send(Data([0, 0]))
    }
  }

  @Test("streaming duration uses an Int64 total without the batch four MiB cap")
  func computesLongDuration() throws {
    let byteCount = Int64(WireContract.maximumDecodedAudioBytes + 32_000)
    #expect(try PCM16LE.streamingDurationMilliseconds(forByteCount: byteCount) == 132_072)
  }
}

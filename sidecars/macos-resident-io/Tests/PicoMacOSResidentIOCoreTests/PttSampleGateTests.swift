import Testing

@testable import PicoMacOSResidentIOCore

@Suite("resident PTT sample gate")
struct PttSampleGateTests {
  @Test("fails closed on a forward audio timeline gap")
  func rejectsForwardTimelineGap() throws {
    var gate = PttSampleGate(capacityFrames: 48_000, releaseTailSeconds: 0.25)

    let buffer = [Int16](repeating: 0, count: 480)
    _ = try gate.consume(bufferStartingAt: 10, sampleRate: 48_000, samples: buffer)

    #expect(throws: PttSampleGateError.timestampDiscontinuity) {
      try gate.consume(bufferStartingAt: 10.02, sampleRate: 48_000, samples: buffer)
    }
    #expect(gate.state == .unavailable)

    var rateChange = PttSampleGate(capacityFrames: 48_000, releaseTailSeconds: 0.25)
    _ = try rateChange.consume(bufferStartingAt: 20, sampleRate: 48_000, samples: buffer)
    #expect(throws: PttSampleGateError.timestampDiscontinuity) {
      try rateChange.consume(bufferStartingAt: 20.01, sampleRate: 44_100, samples: buffer)
    }
    #expect(rateChange.state == .unavailable)
  }

  @Test("accepts only samples at or after a press inside a buffer")
  func slicesAtPhysicalPress() throws {
    var gate = PttSampleGate(capacityFrames: 48_000, releaseTailSeconds: 0.250)
    try gate.observePress(sequence: 7, hostSeconds: 10.0025)
    let pending = try gate.consume(
      bufferStartingAt: 10.0,
      sampleRate: 48_000,
      samples: Array(0..<480).map(Int16.init)
    )
    #expect(pending.segments.isEmpty)
    #expect(pending.droppedFrameCount == 120)
    #expect(pending.outsidePttDroppedFrameCount == 120)
    #expect(pending.suppressedDroppedFrameCount == 0)
    let admitted = try gate.resolveAdmission(sequence: 7, result: .accepted, generation: 11)

    #expect(admitted.segments.first?.sourceSampleIndex == 120)
    #expect(admitted.segments.first?.samples.first == 120)
    #expect(admitted.segments.first?.generation == 11)
  }

  @Test("recovers post-press samples when the audio callback is processed before the key event")
  func reordersCallbackBeforePressByHostTime() throws {
    var gate = PttSampleGate(
      capacityFrames: 100,
      reorderingCapacityFrames: 16,
      releaseTailSeconds: 0.250)

    _ = try gate.consume(
      bufferStartingAt: 1.0,
      sampleRate: 10,
      samples: Array(0..<10).map(Int16.init))
    try gate.observePress(sequence: 8, hostSeconds: 1.55)
    let admitted = try gate.resolveAdmission(sequence: 8, result: .accepted, generation: 12)

    #expect(admitted.segments.first?.sourceSampleIndex == 6)
    #expect(admitted.segments.first?.samples == [6, 7, 8, 9])
  }

  @Test("retains post-press samples until admission and clears them on busy")
  func retainsOnlyUntilAdmission() throws {
    var gate = PttSampleGate(capacityFrames: 100, releaseTailSeconds: 0.250)
    try gate.observePress(sequence: 1, hostSeconds: 1.0)
    _ = try gate.consume(bufferStartingAt: 1.0, sampleRate: 100, samples: [1, 2, 3])
    let rejected = try gate.resolveAdmission(sequence: 1, result: .ignoredBusy, generation: nil)

    #expect(rejected.segments.isEmpty)
    #expect(rejected.outsidePttDroppedFrameCount == 3)
    #expect(gate.state == .discarding)
    try gate.observePress(sequence: 2, hostSeconds: 2.0)
    #expect(
      try gate.resolveAdmission(sequence: 2, result: .accepted, generation: 12).segments.isEmpty)
  }

  @Test("discards every candidate sample when admission times out")
  func discardsTimedOutAdmission() throws {
    var gate = PttSampleGate(capacityFrames: 100, releaseTailSeconds: 0.25)
    try gate.observePress(sequence: 1, hostSeconds: 1)
    _ = try gate.consume(bufferStartingAt: 1, sampleRate: 100, samples: [1, 2, 3])

    let timeout = try gate.resolveAdmission(
      sequence: 1, result: .ignoredStale, generation: nil)
    let afterTimeout = try gate.consume(
      bufferStartingAt: 1.03, sampleRate: 100, samples: [4, 5])

    #expect(timeout.segments.isEmpty)
    #expect(timeout.outsidePttDroppedFrameCount == 3)
    #expect(gate.state == .discarding)
    #expect(afterTimeout.segments.isEmpty)
    #expect(afterTimeout.droppedFrameCount == 2)
  }

  @Test("includes the 250 millisecond release tail and excludes its cutoff")
  func appliesReleaseTail() throws {
    var gate = PttSampleGate(capacityFrames: 100, releaseTailSeconds: 0.250)
    try gate.observePress(sequence: 1, hostSeconds: 1.0)
    _ = try gate.resolveAdmission(sequence: 1, result: .accepted, generation: 3)
    try gate.observeRelease(hostSeconds: 1.1)
    let output = try gate.consume(
      bufferStartingAt: 1.34,
      sampleRate: 100,
      samples: [0, 1, 2]
    )

    #expect(output.segments.first?.samples == [0])
    #expect(output.tailCompletedGeneration == 3)
    #expect(output.droppedFrameCount == 2)
    #expect(output.outsidePttDroppedFrameCount == 2)
    #expect(output.suppressedDroppedFrameCount == 0)
    #expect(gate.state == .discarding)
  }

  @Test("cancel and TTS suppression clear all pending content")
  func clearsAtPrivacyBoundaries() throws {
    var gate = PttSampleGate(capacityFrames: 100, releaseTailSeconds: 0.250)
    try gate.observePress(sequence: 1, hostSeconds: 1.0)
    _ = try gate.consume(bufferStartingAt: 1.0, sampleRate: 100, samples: [1, 2, 3])
    let cancelled = gate.cancel()
    #expect(cancelled.outsidePttDroppedFrameCount == 3)
    try gate.observePress(sequence: 2, hostSeconds: 1.03)
    #expect(
      try gate.resolveAdmission(sequence: 2, result: .accepted, generation: 2).segments.isEmpty)

    _ = gate.cancel()
    try gate.observePress(sequence: 3, hostSeconds: 1.03)
    _ = try gate.consume(bufferStartingAt: 1.03, sampleRate: 100, samples: [4, 5])
    let suppressionBoundary = gate.suppress()
    #expect(suppressionBoundary.outsidePttDroppedFrameCount == 2)
    #expect(gate.state == .suppressed)
    let suppressed = try gate.consume(
      bufferStartingAt: 1.05, sampleRate: 100, samples: [9, 9])
    #expect(suppressed.droppedFrameCount == 2)
    #expect(suppressed.outsidePttDroppedFrameCount == 0)
    #expect(suppressed.suppressedDroppedFrameCount == 2)
    gate.resume()
    #expect(gate.state == .discarding)
  }

  @Test("cancel and recovery preserve TTS suppression until explicit resume")
  func preservesSuppressionAcrossCancelAndRecovery() throws {
    var gate = PttSampleGate(capacityFrames: 100, releaseTailSeconds: 0.250)

    gate.suppress()
    gate.cancel()
    #expect(gate.state == .suppressed)
    #expect(throws: PttSampleGateError.invalidTransition) {
      try gate.observePress(sequence: 1, hostSeconds: 1)
    }

    _ = gate.markUnavailable()
    gate.restoreAvailability()
    #expect(gate.state == .suppressed)

    gate.resume()
    #expect(gate.state == .discarding)
    try gate.observePress(sequence: 2, hostSeconds: 2)
  }

  @Test("recovery reports pending admission and active generation invalidations")
  func reportsRecoveryInvalidations() throws {
    var pending = PttSampleGate(capacityFrames: 100, releaseTailSeconds: 0.250)
    try pending.observePress(sequence: 4, hostSeconds: 1)
    _ = try pending.consume(bufferStartingAt: 1, sampleRate: 100, samples: [1, 2, 3])

    let pendingUnavailable = pending.markUnavailable()
    #expect(pendingUnavailable.invalidation == .pendingAdmission(sequence: 4))
    #expect(pendingUnavailable.output.outsidePttDroppedFrameCount == 3)
    #expect(pending.state == .unavailable)

    var active = PttSampleGate(capacityFrames: 100, releaseTailSeconds: 0.250)
    try active.observePress(sequence: 5, hostSeconds: 2)
    _ = try active.resolveAdmission(sequence: 5, result: .accepted, generation: 12)

    #expect(active.markUnavailable().invalidation == .activeGeneration(12))
    #expect(active.state == .unavailable)

    var failed = PttSampleGate(capacityFrames: 100, releaseTailSeconds: 0.250)
    try failed.observePress(sequence: 6, hostSeconds: 3)
    #expect(throws: PttSampleGateError.invalidTimestamp) {
      try failed.consume(bufferStartingAt: -1, sampleRate: 100, samples: [1])
    }

    #expect(failed.markUnavailable().invalidation == .pendingAdmission(sequence: 6))
  }

  @Test("recovery reports buffered discard after a fail-closed transition")
  func reportsFailClosedBufferedDiscard() throws {
    var gate = PttSampleGate(
      capacityFrames: 100,
      reorderingCapacityFrames: 4,
      releaseTailSeconds: 0.250)
    _ = try gate.consume(bufferStartingAt: 1, sampleRate: 100, samples: [1, 2, 3, 4])
    try gate.observePress(sequence: 7, hostSeconds: 1.02)

    #expect(throws: PttSampleGateError.timestampDiscontinuity) {
      try gate.consume(bufferStartingAt: 1.10, sampleRate: 100, samples: [5, 6])
    }
    let unavailable = gate.markUnavailable()

    #expect(unavailable.invalidation == .pendingAdmission(sequence: 7))
    #expect(unavailable.output.outsidePttDroppedFrameCount == 2)
    #expect(gate.markUnavailable().output.droppedFrameCount == 0)
  }

  @Test("fails closed on overflow, timestamp regression, and mismatched admission")
  func failsClosed() throws {
    var overflow = PttSampleGate(capacityFrames: 2, releaseTailSeconds: 0.250)
    try overflow.observePress(sequence: 1, hostSeconds: 1.0)
    #expect(throws: PttSampleGateError.ringOverflow) {
      try overflow.consume(bufferStartingAt: 1.0, sampleRate: 100, samples: [1, 2, 3])
    }
    #expect(overflow.state == .unavailable)

    var mismatch = PttSampleGate(capacityFrames: 10, releaseTailSeconds: 0.250)
    try mismatch.observePress(sequence: 4, hostSeconds: 4.0)
    #expect(throws: PttSampleGateError.sequenceMismatch) {
      try mismatch.resolveAdmission(sequence: 5, result: .accepted, generation: 1)
    }

    var regression = PttSampleGate(capacityFrames: 10, releaseTailSeconds: 0.250)
    _ = try regression.consume(bufferStartingAt: 2.0, sampleRate: 100, samples: [1])
    #expect(throws: PttSampleGateError.timestampRegression) {
      try regression.consume(bufferStartingAt: 1.0, sampleRate: 100, samples: [1])
    }
    #expect(regression.state == .unavailable)
  }
}

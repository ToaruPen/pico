import Foundation

public enum PttGateState: Equatable, Sendable {
  case discarding
  case pendingAdmission(sequence: UInt64, pressedAt: Double, releaseCutoff: Double?)
  case accepting(generation: UInt64, pressedAt: Double)
  case tailing(generation: UInt64, cutoff: Double)
  case suppressed
  case unavailable
}

public enum PttSampleGateError: Error, Equatable, Sendable {
  case invalidConfiguration
  case invalidTimestamp
  case timestampRegression
  case timestampDiscontinuity
  case invalidTransition
  case sequenceMismatch
  case generationRequired
  case ringOverflow
}

public enum PttGateInvalidation: Equatable, Sendable {
  case pendingAdmission(sequence: UInt64)
  case activeGeneration(UInt64)
}

public struct AcceptedPcmSegment: Equatable, Sendable {
  public let generation: UInt64
  public let bufferStartHostSeconds: Double
  public let sampleRate: Double
  public let sourceSampleIndex: Int
  public let samples: [Int16]
}

public struct PttGateOutput: Equatable, Sendable {
  public let segments: [AcceptedPcmSegment]
  public let tailCompletedGeneration: UInt64?
  public let outsidePttDroppedFrameCount: Int
  public let suppressedDroppedFrameCount: Int
  public var droppedFrameCount: Int {
    outsidePttDroppedFrameCount + suppressedDroppedFrameCount
  }

  public init(
    segments: [AcceptedPcmSegment] = [],
    tailCompletedGeneration: UInt64? = nil,
    outsidePttDroppedFrameCount: Int = 0,
    suppressedDroppedFrameCount: Int = 0
  ) {
    self.segments = segments
    self.tailCompletedGeneration = tailCompletedGeneration
    self.outsidePttDroppedFrameCount = outsidePttDroppedFrameCount
    self.suppressedDroppedFrameCount = suppressedDroppedFrameCount
  }
}

public struct PttGateUnavailableTransition: Equatable, Sendable {
  public let invalidation: PttGateInvalidation?
  public let output: PttGateOutput
}

private struct PendingPcmSegment: Sendable {
  let bufferStartHostSeconds: Double
  let sampleRate: Double
  let sourceSampleIndex: Int
  let samples: [Int16]
}

public struct PttSampleGate: Sendable {
  public private(set) var state: PttGateState = .discarding
  private let capacityFrames: Int
  private let reorderingCapacityFrames: Int
  private let releaseTailSeconds: Double
  private var pending: [PendingPcmSegment] = []
  private var pendingFrameCount = 0
  private var pendingTailReached = false
  private var recent: [PendingPcmSegment] = []
  private var recentFrameCount = 0
  private var lastBufferStart: Double?
  private var lastBufferEnd: Double?
  private var lastSampleRate: Double?
  private var suppressionRequested = false
  private var pendingInvalidation: PttGateInvalidation?
  private var unreportedOutsidePttDroppedFrameCount = 0

  public init(
    capacityFrames: Int,
    reorderingCapacityFrames: Int = 0,
    releaseTailSeconds: Double
  ) {
    self.capacityFrames = capacityFrames
    self.reorderingCapacityFrames = reorderingCapacityFrames
    self.releaseTailSeconds = releaseTailSeconds
  }

  @discardableResult
  public mutating func observePress(sequence: UInt64, hostSeconds: Double) throws -> PttGateOutput {
    guard capacityFrames > 0, reorderingCapacityFrames >= 0,
      releaseTailSeconds.isFinite, releaseTailSeconds >= 0
    else {
      failClosed()
      throw PttSampleGateError.invalidConfiguration
    }
    guard hostSeconds.isFinite, hostSeconds >= 0 else {
      failClosed()
      throw PttSampleGateError.invalidTimestamp
    }
    guard state == .discarding else { throw PttSampleGateError.invalidTransition }
    clearPending()
    let retainedFrameCount = recentFrameCount
    pending = recent.compactMap {
      slice(segment: $0, lowerBound: hostSeconds, upperBound: nil)
    }
    pendingFrameCount = pending.reduce(0) { $0 + $1.samples.count }
    clearRecent()
    state = .pendingAdmission(sequence: sequence, pressedAt: hostSeconds, releaseCutoff: nil)
    let droppedFrameCount = retainedFrameCount - pendingFrameCount
    return PttGateOutput(
      outsidePttDroppedFrameCount: droppedFrameCount)
  }

  public mutating func observeRelease(hostSeconds: Double) throws {
    guard hostSeconds.isFinite, hostSeconds >= 0 else {
      failClosed()
      throw PttSampleGateError.invalidTimestamp
    }
    switch state {
    case .pendingAdmission(let sequence, let pressedAt, _):
      guard hostSeconds >= pressedAt else {
        failClosed()
        throw PttSampleGateError.timestampRegression
      }
      state = .pendingAdmission(
        sequence: sequence,
        pressedAt: pressedAt,
        releaseCutoff: hostSeconds + releaseTailSeconds
      )
    case .accepting(let generation, let pressedAt):
      guard hostSeconds >= pressedAt else {
        failClosed()
        throw PttSampleGateError.timestampRegression
      }
      state = .tailing(generation: generation, cutoff: hostSeconds + releaseTailSeconds)
    case .tailing:
      break
    default:
      throw PttSampleGateError.invalidTransition
    }
  }

  public mutating func resolveAdmission(
    sequence: UInt64,
    result: ResidentIoControlResult,
    generation: UInt64?
  ) throws -> PttGateOutput {
    guard case .pendingAdmission(let expected, let pressedAt, let releaseCutoff) = state,
      expected == sequence
    else {
      throw PttSampleGateError.sequenceMismatch
    }
    guard result == .accepted else {
      let output = discardBufferedPcm()
      state = .discarding
      return output
    }
    guard let generation else { throw PttSampleGateError.generationRequired }
    let tailReached = pendingTailReached
    let segments = pending.map {
      AcceptedPcmSegment(
        generation: generation,
        bufferStartHostSeconds: $0.bufferStartHostSeconds,
        sampleRate: $0.sampleRate,
        sourceSampleIndex: $0.sourceSampleIndex,
        samples: $0.samples
      )
    }
    clearPending()
    if let releaseCutoff {
      if tailReached {
        state = .discarding
        pendingTailReached = false
        return PttGateOutput(segments: segments, tailCompletedGeneration: generation)
      }
      state = .tailing(generation: generation, cutoff: releaseCutoff)
    } else {
      state = .accepting(generation: generation, pressedAt: pressedAt)
    }
    return PttGateOutput(segments: segments)
  }

  public mutating func consume(
    bufferStartingAt start: Double,
    sampleRate: Double,
    samples: [Int16]
  ) throws -> PttGateOutput {
    do {
      try validateBuffer(start: start, sampleRate: sampleRate)
      defer {
        lastBufferStart = start
        lastBufferEnd = bufferEnd(start: start, sampleRate: sampleRate, count: samples.count)
        lastSampleRate = sampleRate
      }
      switch state {
      case .discarding:
        let droppedFrameCount = retainRecent(
          bufferStartingAt: start,
          sampleRate: sampleRate,
          samples: samples)
        return PttGateOutput(
          outsidePttDroppedFrameCount: droppedFrameCount)
      case .suppressed:
        return PttGateOutput(
          suppressedDroppedFrameCount: samples.count)
      case .unavailable:
        return PttGateOutput(
          outsidePttDroppedFrameCount: samples.count)
      case .pendingAdmission(_, let pressedAt, let releaseCutoff):
        let slice = slice(
          start: start,
          sampleRate: sampleRate,
          samples: samples,
          lowerBound: pressedAt,
          upperBound: releaseCutoff
        )
        if let slice {
          guard pendingFrameCount + slice.samples.count <= capacityFrames else {
            failClosed()
            throw PttSampleGateError.ringOverflow
          }
          pending.append(slice)
          pendingFrameCount += slice.samples.count
        }
        if let releaseCutoff,
          bufferEnd(start: start, sampleRate: sampleRate, count: samples.count) >= releaseCutoff
        {
          pendingTailReached = true
        }
        let droppedFrameCount = samples.count - (slice?.samples.count ?? 0)
        return PttGateOutput(
          outsidePttDroppedFrameCount: droppedFrameCount)
      case .accepting(let generation, let pressedAt):
        let accepted = slice(
          start: start,
          sampleRate: sampleRate,
          samples: samples,
          lowerBound: pressedAt,
          upperBound: nil
        ).map { acceptedSegment($0, generation: generation) }
        return PttGateOutput(
          segments: accepted.map { [$0] } ?? [],
          outsidePttDroppedFrameCount: samples.count - (accepted?.samples.count ?? 0)
        )
      case .tailing(let generation, let cutoff):
        let accepted = slice(
          start: start,
          sampleRate: sampleRate,
          samples: samples,
          lowerBound: nil,
          upperBound: cutoff
        ).map { acceptedSegment($0, generation: generation) }
        let complete =
          bufferEnd(start: start, sampleRate: sampleRate, count: samples.count) >= cutoff
        if complete { state = .discarding }
        return PttGateOutput(
          segments: accepted.map { [$0] } ?? [],
          tailCompletedGeneration: complete ? generation : nil,
          outsidePttDroppedFrameCount: samples.count - (accepted?.samples.count ?? 0)
        )
      }
    } catch let error as PttSampleGateError {
      if error == .timestampRegression || error == .timestampDiscontinuity
        || error == .invalidTimestamp
      {
        failClosed()
      }
      throw error
    }
  }

  @discardableResult
  public mutating func cancel() -> PttGateOutput {
    let output = discardBufferedPcm()
    state = suppressionRequested ? .suppressed : .discarding
    return output
  }

  @discardableResult
  public mutating func suppress() -> PttGateOutput {
    suppressionRequested = true
    let output = discardBufferedPcm()
    state = .suppressed
    return output
  }

  public mutating func resume() {
    suppressionRequested = false
    clearPending()
    clearRecent()
    state = .discarding
  }

  public mutating func markUnavailable() -> PttGateUnavailableTransition {
    let invalidation = pendingInvalidation ?? invalidation(for: state)
    pendingInvalidation = nil
    let bufferedDiscard = discardBufferedPcm()
    let output = PttGateOutput(
      outsidePttDroppedFrameCount: unreportedOutsidePttDroppedFrameCount
        + bufferedDiscard.outsidePttDroppedFrameCount)
    unreportedOutsidePttDroppedFrameCount = 0
    clearTimeline()
    state = .unavailable
    return PttGateUnavailableTransition(invalidation: invalidation, output: output)
  }

  public mutating func restoreAvailability() {
    pendingInvalidation = nil
    clearPending()
    clearRecent()
    clearTimeline()
    state = suppressionRequested ? .suppressed : .discarding
  }

  private mutating func failClosed() {
    pendingInvalidation = pendingInvalidation ?? invalidation(for: state)
    unreportedOutsidePttDroppedFrameCount +=
      discardBufferedPcm().outsidePttDroppedFrameCount
    clearTimeline()
    state = .unavailable
  }

  private mutating func discardBufferedPcm() -> PttGateOutput {
    let outsidePttDroppedFrameCount = pendingFrameCount + recentFrameCount
    clearPending()
    clearRecent()
    return PttGateOutput(outsidePttDroppedFrameCount: outsidePttDroppedFrameCount)
  }

  private func invalidation(for state: PttGateState) -> PttGateInvalidation? {
    switch state {
    case .pendingAdmission(let sequence, _, _):
      .pendingAdmission(sequence: sequence)
    case .accepting(let generation, _), .tailing(let generation, _):
      .activeGeneration(generation)
    case .discarding, .suppressed, .unavailable:
      nil
    }
  }

  private mutating func validateBuffer(start: Double, sampleRate: Double) throws {
    guard start.isFinite, start >= 0, sampleRate.isFinite, sampleRate > 0 else {
      throw PttSampleGateError.invalidTimestamp
    }
    if let lastBufferStart, start < lastBufferStart {
      throw PttSampleGateError.timestampRegression
    }
    if let lastBufferEnd, let lastSampleRate {
      let tolerance = max(1e-9, 0.5 / max(sampleRate, lastSampleRate))
      guard abs(start - lastBufferEnd) <= tolerance,
        abs(sampleRate - lastSampleRate) <= Double.ulpOfOne * max(sampleRate, lastSampleRate)
      else {
        throw PttSampleGateError.timestampDiscontinuity
      }
    }
  }

  private func slice(
    start: Double,
    sampleRate: Double,
    samples: [Int16],
    lowerBound: Double?,
    upperBound: Double?
  ) -> PendingPcmSegment? {
    let first = lowerBound.map { Int(ceil((($0 - start) * sampleRate) - 1e-9)) } ?? 0
    let end = upperBound.map { Int(ceil((($0 - start) * sampleRate) - 1e-9)) } ?? samples.count
    let clampedFirst = min(samples.count, max(0, first))
    let clampedEnd = min(samples.count, max(0, end))
    guard clampedEnd > clampedFirst else { return nil }
    return PendingPcmSegment(
      bufferStartHostSeconds: start,
      sampleRate: sampleRate,
      sourceSampleIndex: clampedFirst,
      samples: Array(samples[clampedFirst..<clampedEnd])
    )
  }

  private func slice(
    segment: PendingPcmSegment,
    lowerBound: Double?,
    upperBound: Double?
  ) -> PendingPcmSegment? {
    let first =
      lowerBound.map {
        Int(ceil((($0 - segment.bufferStartHostSeconds) * segment.sampleRate) - 1e-9))
      } ?? segment.sourceSampleIndex
    let end =
      upperBound.map {
        Int(ceil((($0 - segment.bufferStartHostSeconds) * segment.sampleRate) - 1e-9))
      } ?? (segment.sourceSampleIndex + segment.samples.count)
    let segmentEnd = segment.sourceSampleIndex + segment.samples.count
    let clampedFirst = min(segmentEnd, max(segment.sourceSampleIndex, first))
    let clampedEnd = min(segmentEnd, max(segment.sourceSampleIndex, end))
    guard clampedEnd > clampedFirst else { return nil }
    let relativeFirst = clampedFirst - segment.sourceSampleIndex
    let relativeEnd = clampedEnd - segment.sourceSampleIndex
    return PendingPcmSegment(
      bufferStartHostSeconds: segment.bufferStartHostSeconds,
      sampleRate: segment.sampleRate,
      sourceSampleIndex: clampedFirst,
      samples: Array(segment.samples[relativeFirst..<relativeEnd]))
  }

  private mutating func retainRecent(
    bufferStartingAt start: Double,
    sampleRate: Double,
    samples: [Int16]
  ) -> Int {
    guard reorderingCapacityFrames > 0 else { return samples.count }
    recent.append(
      PendingPcmSegment(
        bufferStartHostSeconds: start,
        sampleRate: sampleRate,
        sourceSampleIndex: 0,
        samples: samples))
    recentFrameCount += samples.count
    var droppedFrameCount = 0
    while recentFrameCount > reorderingCapacityFrames, let first = recent.first {
      let excess = recentFrameCount - reorderingCapacityFrames
      if first.samples.count <= excess {
        recent.removeFirst()
        recentFrameCount -= first.samples.count
        droppedFrameCount += first.samples.count
        continue
      }
      recent[0] = PendingPcmSegment(
        bufferStartHostSeconds: first.bufferStartHostSeconds,
        sampleRate: first.sampleRate,
        sourceSampleIndex: first.sourceSampleIndex + excess,
        samples: Array(first.samples.dropFirst(excess)))
      recentFrameCount -= excess
      droppedFrameCount += excess
    }
    return droppedFrameCount
  }

  private func acceptedSegment(_ value: PendingPcmSegment, generation: UInt64)
    -> AcceptedPcmSegment
  {
    AcceptedPcmSegment(
      generation: generation,
      bufferStartHostSeconds: value.bufferStartHostSeconds,
      sampleRate: value.sampleRate,
      sourceSampleIndex: value.sourceSampleIndex,
      samples: value.samples
    )
  }

  private func bufferEnd(start: Double, sampleRate: Double, count: Int) -> Double {
    start + (Double(count) / sampleRate)
  }

  private mutating func clearPending() {
    pending.removeAll(keepingCapacity: true)
    pendingFrameCount = 0
    pendingTailReached = false
  }

  private mutating func clearRecent() {
    recent.removeAll(keepingCapacity: true)
    recentFrameCount = 0
  }

  private mutating func clearTimeline() {
    lastBufferStart = nil
    lastBufferEnd = nil
    lastSampleRate = nil
  }
}

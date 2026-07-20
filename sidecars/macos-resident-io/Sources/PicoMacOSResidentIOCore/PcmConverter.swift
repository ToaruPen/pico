import Foundation

public enum PcmConversionError: Error, Equatable, Sendable {
  case invalidFormat
  case invalidTimestamp
  case timestampDiscontinuity
}

public struct ConvertedPcmBuffer: Equatable, Sendable {
  public let bufferStartHostSeconds: Double
  public let sampleRate: Double
  public let samples: [Int16]
}

public struct LinearPcm16MonoResampler: Sendable {
  private let outputSampleRate: Double
  private var nextOutputHostSeconds: Double?
  private var expectedInputStartHostSeconds: Double?

  public init(outputSampleRate: Double) {
    self.outputSampleRate = outputSampleRate
  }

  public mutating func convert(
    samples: [Float],
    sampleRate: Double,
    bufferStartingAt start: Double
  ) throws -> ConvertedPcmBuffer {
    guard outputSampleRate.isFinite, outputSampleRate > 0, sampleRate.isFinite, sampleRate > 0
    else {
      throw PcmConversionError.invalidFormat
    }
    guard start.isFinite, start >= 0 else { throw PcmConversionError.invalidTimestamp }
    if let expectedInputStartHostSeconds {
      let tolerance = max(0.002, 2 / sampleRate)
      guard abs(start - expectedInputStartHostSeconds) <= tolerance else {
        throw PcmConversionError.timestampDiscontinuity
      }
    }

    let end = start + (Double(samples.count) / sampleRate)
    expectedInputStartHostSeconds = end
    let firstOutputTime = max(nextOutputHostSeconds ?? start, start)
    var outputTime = firstOutputTime
    var converted: [Int16] = []
    converted.reserveCapacity(Int(ceil(Double(samples.count) * outputSampleRate / sampleRate)))

    while outputTime < end - 1e-12, !samples.isEmpty {
      let sourcePosition = max(0, (outputTime - start) * sampleRate)
      let lowerIndex = min(samples.count - 1, Int(floor(sourcePosition)))
      let upperIndex = min(samples.count - 1, lowerIndex + 1)
      let fraction = Float(sourcePosition - Double(lowerIndex))
      let sample = samples[lowerIndex] + ((samples[upperIndex] - samples[lowerIndex]) * fraction)
      converted.append(pcm16(sample))
      outputTime += 1 / outputSampleRate
    }

    nextOutputHostSeconds = outputTime
    return ConvertedPcmBuffer(
      bufferStartHostSeconds: firstOutputTime,
      sampleRate: outputSampleRate,
      samples: converted
    )
  }

  public mutating func reset() {
    nextOutputHostSeconds = nil
    expectedInputStartHostSeconds = nil
  }
}

private func pcm16(_ value: Float) -> Int16 {
  let clamped = min(Float(32_767) / 32_768, max(-1, value))
  return Int16((clamped * 32_768).rounded())
}

public enum PcmFrameAssemblerError: Error, Equatable, Sendable {
  case invalidConfiguration
  case invalidTimestamp
  case timestampDiscontinuity
  case generationMismatch
  case sampleRateMismatch
}

public struct AssembledPcmFrame: Equatable, Sendable {
  public let generation: UInt64
  public let startHostSeconds: Double
  public let sampleRate: Double
  public let samples: [Int16]
}

public struct Pcm16FrameAssembler: Sendable {
  private let frameCount: Int
  private var generation: UInt64?
  private var pendingStartHostSeconds: Double?
  private var sampleRate: Double?
  private var pending: [Int16] = []

  public init(frameCount: Int) {
    self.frameCount = frameCount
  }

  public mutating func append(
    generation: UInt64,
    samples: [Int16],
    startingAtHostSeconds start: Double,
    sampleRate: Double
  ) throws -> [AssembledPcmFrame] {
    guard frameCount > 0, sampleRate.isFinite, sampleRate > 0 else {
      throw PcmFrameAssemblerError.invalidConfiguration
    }
    guard start.isFinite, start >= 0 else { throw PcmFrameAssemblerError.invalidTimestamp }
    if let ownedGeneration = self.generation, ownedGeneration != generation {
      throw PcmFrameAssemblerError.generationMismatch
    }
    if let ownedSampleRate = self.sampleRate, ownedSampleRate != sampleRate {
      throw PcmFrameAssemblerError.sampleRateMismatch
    }
    if let pendingStartHostSeconds {
      let expected = pendingStartHostSeconds + (Double(pending.count) / sampleRate)
      guard abs(start - expected) <= max(1e-9, 0.5 / sampleRate) else {
        throw PcmFrameAssemblerError.timestampDiscontinuity
      }
    } else {
      pendingStartHostSeconds = start
    }
    self.generation = generation
    self.sampleRate = sampleRate
    pending.append(contentsOf: samples)
    return takeFullFrames()
  }

  public mutating func flush(generation: UInt64) -> [AssembledPcmFrame] {
    guard self.generation == generation, let start = pendingStartHostSeconds,
      let sampleRate, !pending.isEmpty
    else {
      clear()
      return []
    }
    let frame = AssembledPcmFrame(
      generation: generation,
      startHostSeconds: start,
      sampleRate: sampleRate,
      samples: pending
    )
    clear()
    return [frame]
  }

  public mutating func clear() {
    generation = nil
    pendingStartHostSeconds = nil
    sampleRate = nil
    pending.removeAll(keepingCapacity: true)
  }

  private mutating func takeFullFrames() -> [AssembledPcmFrame] {
    guard let generation, var start = pendingStartHostSeconds, let sampleRate else { return [] }
    var frames: [AssembledPcmFrame] = []
    while pending.count >= frameCount {
      let samples = Array(pending.prefix(frameCount))
      pending.removeFirst(frameCount)
      frames.append(
        AssembledPcmFrame(
          generation: generation,
          startHostSeconds: start,
          sampleRate: sampleRate,
          samples: samples
        ))
      start += Double(frameCount) / sampleRate
    }
    pendingStartHostSeconds = pending.isEmpty ? nil : start
    return frames
  }
}

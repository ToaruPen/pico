import Foundation

public struct HostClockCalibrationSample: Equatable, Sendable {
  public let eventTimestampNanoseconds: UInt64
  public let machHostSecondsBefore: Double
  public let machHostSecondsAfter: Double

  public init(
    eventTimestampNanoseconds: UInt64,
    machHostSecondsBefore: Double,
    machHostSecondsAfter: Double
  ) {
    self.eventTimestampNanoseconds = eventTimestampNanoseconds
    self.machHostSecondsBefore = machHostSecondsBefore
    self.machHostSecondsAfter = machHostSecondsAfter
  }
}

public enum HostClockMapperError: Error, Equatable, Sendable {
  case insufficientSamples
  case invalidSample
  case residualExceeded
}

public struct HostClockMapper: Equatable, Sendable {
  public let eventToAudioOffsetSeconds: Double
  public let maximumResidualSeconds: Double

  public static func calibrate(
    samples: [HostClockCalibrationSample],
    maximumResidualSeconds: Double
  ) throws -> HostClockMapper {
    guard samples.count >= 2 else { throw HostClockMapperError.insufficientSamples }
    guard maximumResidualSeconds.isFinite, maximumResidualSeconds >= 0 else {
      throw HostClockMapperError.invalidSample
    }
    let offsets = try samples.map { sample -> Double in
      guard sample.machHostSecondsBefore.isFinite,
        sample.machHostSecondsAfter.isFinite,
        sample.machHostSecondsBefore <= sample.machHostSecondsAfter
      else {
        throw HostClockMapperError.invalidSample
      }
      let eventSeconds = Double(sample.eventTimestampNanoseconds) / 1_000_000_000
      return ((sample.machHostSecondsBefore + sample.machHostSecondsAfter) / 2) - eventSeconds
    }
    let mean = offsets.reduce(0, +) / Double(offsets.count)
    guard offsets.allSatisfy({ abs($0 - mean) <= maximumResidualSeconds }) else {
      throw HostClockMapperError.residualExceeded
    }
    return HostClockMapper(
      eventToAudioOffsetSeconds: mean,
      maximumResidualSeconds: maximumResidualSeconds
    )
  }

  public func audioHostSeconds(eventTimestampNanoseconds: UInt64) -> Double {
    (Double(eventTimestampNanoseconds) / 1_000_000_000) + eventToAudioOffsetSeconds
  }
}

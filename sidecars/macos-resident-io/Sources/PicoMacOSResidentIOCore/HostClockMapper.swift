public enum HostClockMapperError: Error, Equatable, Sendable {
  case invalidEventTimestamp
  case clockDomainMismatch
}

public struct HostClockMapper: Equatable, Sendable {
  public init() {}

  public func audioHostSeconds(eventTimestampNanoseconds: UInt64) -> Double {
    Double(eventTimestampNanoseconds) / 1_000_000_000
  }

  public func audioHostSeconds(
    eventTimestampNanoseconds: UInt64,
    currentHostSeconds: Double,
    maximumSkewSeconds: Double
  ) throws -> Double {
    guard eventTimestampNanoseconds > 0, currentHostSeconds.isFinite,
      maximumSkewSeconds.isFinite, currentHostSeconds >= 0, maximumSkewSeconds >= 0
    else {
      throw HostClockMapperError.invalidEventTimestamp
    }
    let eventHostSeconds = audioHostSeconds(
      eventTimestampNanoseconds: eventTimestampNanoseconds)
    guard abs(currentHostSeconds - eventHostSeconds) <= maximumSkewSeconds else {
      throw HostClockMapperError.clockDomainMismatch
    }
    return eventHostSeconds
  }
}

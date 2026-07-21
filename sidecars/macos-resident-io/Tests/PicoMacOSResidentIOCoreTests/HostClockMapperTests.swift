import Testing

@testable import PicoMacOSResidentIOCore

@Suite("resident host clock mapping")
struct HostClockMapperTests {
  @Test("maps Quartz elapsed nanoseconds directly into audio host seconds")
  func mapsSharedHostClock() throws {
    let mapper = HostClockMapper()

    #expect(
      abs(
        try mapper.audioHostSeconds(
          eventTimestampNanoseconds: 12_345_678_901,
          currentHostSeconds: 12.346,
          maximumSkewSeconds: 1
        ) - 12.345_678_901)
        < 0.000_000_001)
  }

  @Test("rejects zero timestamps and a divergent event clock")
  func rejectsInvalidEventClock() {
    let mapper = HostClockMapper()

    #expect(throws: HostClockMapperError.invalidEventTimestamp) {
      try mapper.audioHostSeconds(
        eventTimestampNanoseconds: 0,
        currentHostSeconds: 12,
        maximumSkewSeconds: 1)
    }
    #expect(throws: HostClockMapperError.clockDomainMismatch) {
      try mapper.audioHostSeconds(
        eventTimestampNanoseconds: 10_000_000_000,
        currentHostSeconds: 12,
        maximumSkewSeconds: 1)
    }
  }
}

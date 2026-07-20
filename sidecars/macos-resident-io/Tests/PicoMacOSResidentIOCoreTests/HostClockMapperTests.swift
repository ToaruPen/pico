import Testing

@testable import PicoMacOSResidentIOCore

@Suite("resident host clock mapping")
struct HostClockMapperTests {
  @Test("maps CGEvent nanoseconds into audio host seconds")
  func mapsEventClock() throws {
    let mapper = try HostClockMapper.calibrate(
      samples: [
        HostClockCalibrationSample(
          eventTimestampNanoseconds: 10_000_000_000,
          machHostSecondsBefore: 10.003,
          machHostSecondsAfter: 10.005
        ),
        HostClockCalibrationSample(
          eventTimestampNanoseconds: 11_000_000_000,
          machHostSecondsBefore: 11.003,
          machHostSecondsAfter: 11.005
        ),
      ],
      maximumResidualSeconds: 0.002
    )

    #expect(
      abs(mapper.audioHostSeconds(eventTimestampNanoseconds: 12_000_000_000) - 12.004) < 0.000_001)
  }

  @Test("rejects inconsistent clock samples")
  func rejectsInconsistentSamples() {
    #expect(throws: HostClockMapperError.residualExceeded) {
      try HostClockMapper.calibrate(
        samples: [
          HostClockCalibrationSample(
            eventTimestampNanoseconds: 10_000_000_000,
            machHostSecondsBefore: 10.000,
            machHostSecondsAfter: 10.002
          ),
          HostClockCalibrationSample(
            eventTimestampNanoseconds: 11_000_000_000,
            machHostSecondsBefore: 11.020,
            machHostSecondsAfter: 11.022
          ),
        ],
        maximumResidualSeconds: 0.002
      )
    }
  }
}

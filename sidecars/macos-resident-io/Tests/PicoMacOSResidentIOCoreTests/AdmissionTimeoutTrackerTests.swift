import Testing

@testable import PicoMacOSResidentIOCore

@Suite("resident admission timeout tracking")
struct AdmissionTimeoutTrackerTests {
  @Test("uses the fixed 500 millisecond timeout contract")
  func exposesFixedTimeout() {
    #expect(AdmissionTimeoutTracker.timeoutMilliseconds == 500)
  }

  @Test("invalidates one late accepted generation and then forgets the sequence")
  func invalidatesLateAcceptanceOnce() throws {
    var tracker = AdmissionTimeoutTracker()
    try tracker.expire(sequence: 7)

    #expect(
      tracker.invalidatedGeneration(sequence: 7, result: .accepted, generation: 11) == 11)
    #expect(tracker.invalidatedGeneration(sequence: 7, result: .accepted, generation: 11) == nil)
    #expect(tracker.expiredCount == 0)
  }

  @Test("bounds unresolved timeout state at 64 sequences")
  func boundsExpiredSequenceBacklog() throws {
    var tracker = AdmissionTimeoutTracker()
    for sequence in 1...64 {
      try tracker.expire(sequence: UInt64(sequence))
    }

    #expect(tracker.expiredCount == 64)
    #expect(throws: AdmissionTimeoutTrackerError.backlogExceeded) {
      try tracker.expire(sequence: 65)
    }
    #expect(tracker.expiredCount == 64)
  }
}

import Testing

@testable import PicoMacOSResidentIOCore

@Suite("resident pending control tracking")
struct PendingControlTrackerTests {
  @Test("bounds every unresolved control sequence at 64 entries")
  func boundsAllControlKinds() throws {
    var tracker = PendingControlTracker(maximumCount: 64)

    for sequence in UInt64(1)...64 {
      let kind: ResidentIoControlKind = sequence.isMultiple(of: 2) ? .talkReleased : .cancelPressed
      try tracker.insert(sequence: sequence, kind: kind, hostSeconds: Double(sequence))
    }

    #expect(throws: PendingControlTrackerError.backlogExceeded) {
      try tracker.insert(sequence: 65, kind: .talkReleased, hostSeconds: 65)
    }
    #expect(
      tracker.remove(sequence: 1)
        == PendingControl(kind: .cancelPressed, hostSeconds: 1))
    try tracker.insert(sequence: 65, kind: .talkPressed, hostSeconds: 65)
  }
}

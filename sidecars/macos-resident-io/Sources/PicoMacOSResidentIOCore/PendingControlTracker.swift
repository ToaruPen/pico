import Foundation

public struct PendingControl: Equatable, Sendable {
  public let kind: ResidentIoControlKind
  public let hostSeconds: Double

  public init(kind: ResidentIoControlKind, hostSeconds: Double) {
    self.kind = kind
    self.hostSeconds = hostSeconds
  }
}

public enum PendingControlTrackerError: Error, Equatable, Sendable {
  case backlogExceeded
  case duplicateSequence
}

public struct PendingControlTracker: Sendable {
  private let maximumCount: Int
  private var controls: [UInt64: PendingControl] = [:]

  public init(maximumCount: Int) {
    self.maximumCount = maximumCount
  }

  public mutating func insert(
    sequence: UInt64,
    kind: ResidentIoControlKind,
    hostSeconds: Double
  ) throws {
    guard controls[sequence] == nil else {
      throw PendingControlTrackerError.duplicateSequence
    }
    guard maximumCount > 0, controls.count < maximumCount else {
      throw PendingControlTrackerError.backlogExceeded
    }
    controls[sequence] = PendingControl(kind: kind, hostSeconds: hostSeconds)
  }

  public mutating func remove(sequence: UInt64) -> PendingControl? {
    controls.removeValue(forKey: sequence)
  }
}

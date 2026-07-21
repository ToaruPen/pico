import Foundation

public enum AdmissionTimeoutTrackerError: Error, Equatable, Sendable {
  case backlogExceeded
}

public struct AdmissionTimeoutTracker: Sendable {
  public static let timeoutMilliseconds = 500
  public static let maximumExpiredSequences = 64

  private var expiredSequences: Set<UInt64> = []

  public init() {}

  public var expiredCount: Int { expiredSequences.count }

  public mutating func expire(sequence: UInt64) throws {
    guard
      expiredSequences.contains(sequence) || expiredSequences.count < Self.maximumExpiredSequences
    else {
      throw AdmissionTimeoutTrackerError.backlogExceeded
    }
    expiredSequences.insert(sequence)
  }

  public mutating func invalidatedGeneration(
    sequence: UInt64,
    result: ResidentIoControlResult,
    generation: UInt64?
  ) -> UInt64? {
    guard expiredSequences.remove(sequence) != nil, result == .accepted else { return nil }
    return generation
  }
}

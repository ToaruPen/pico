public struct TranscriptionLease: Equatable, Sendable {
  fileprivate let identifier: UInt64
}

public actor TranscriptionAdmission {
  private var activeLease: TranscriptionLease?
  private var nextIdentifier: UInt64 = 1

  public init() {}

  public func acquire() -> TranscriptionLease? {
    guard activeLease == nil else { return nil }
    let lease = TranscriptionLease(identifier: nextIdentifier)
    nextIdentifier &+= 1
    if nextIdentifier == 0 {
      nextIdentifier = 1
    }
    activeLease = lease
    return lease
  }

  public func release(_ lease: TranscriptionLease) {
    guard activeLease == lease else { return }
    activeLease = nil
  }

  public func perform<Result: Sendable>(
    _ operation: @Sendable () async throws -> Result
  ) async rethrows -> Result? {
    guard let lease = acquire() else { return nil }
    defer { release(lease) }
    return try await operation()
  }
}

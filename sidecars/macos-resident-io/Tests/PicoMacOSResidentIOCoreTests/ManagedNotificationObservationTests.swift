import Foundation
import Testing

@testable import PicoMacOSResidentIOCore

@Suite("managed notification observation")
struct ManagedNotificationObservationTests {
  @Test("deallocation removes the registered observer")
  func removesObserverOnDeallocation() {
    let center = NotificationCenter()
    let name = Notification.Name("managed-observation-test")
    let count = NotificationCount()
    var observation: ManagedNotificationObservation? = ManagedNotificationObservation(
      center: center,
      name: name
    ) { _ in
      count.increment()
    }

    center.post(name: name, object: nil)
    #expect(count.value == 1)

    observation = nil
    center.post(name: name, object: nil)

    #expect(observation == nil)
    #expect(count.value == 1)
  }
}

private final class NotificationCount: @unchecked Sendable {
  private let lock = NSLock()
  private var count = 0

  var value: Int {
    lock.lock()
    defer { lock.unlock() }
    return count
  }

  func increment() {
    lock.lock()
    count += 1
    lock.unlock()
  }
}

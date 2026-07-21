import Foundation

public final class ManagedNotificationObservation: @unchecked Sendable {
  private let center: NotificationCenter
  private let lock = NSLock()
  private var token: NSObjectProtocol?

  public init(
    center: NotificationCenter = .default,
    name: Notification.Name,
    object: Any? = nil,
    queue: OperationQueue? = nil,
    using handler: @escaping @Sendable (Notification) -> Void
  ) {
    self.center = center
    token = center.addObserver(forName: name, object: object, queue: queue, using: handler)
  }

  deinit {
    cancel()
  }

  public func cancel() {
    lock.lock()
    let token = token
    self.token = nil
    lock.unlock()
    if let token {
      center.removeObserver(token)
    }
  }
}

import CoreGraphics
import Foundation
import PicoMacOSControlCore

@main
enum PicoMacOSControlMain {
  static func main() {
    do {
      try run()
    } catch {
      FileHandle.standardError.write(
        Data("pico macOS control failed: \(error.localizedDescription)\n".utf8))
      Darwin.exit(1)
    }
  }

  private static func run() throws {
    let configuration = try ControlConfiguration.parse(
      arguments: Array(CommandLine.arguments.dropFirst()))
    let token = try readControlToken(path: configuration.tokenPath)
    let requests = ControlRequestBuilder(baseURL: configuration.baseURL, token: token)
    let transport = ControlTransport(requests: requests)
    try awaitHealth(transport)
    try requireInputMonitoringAccess()

    guard let runLoop = CFRunLoopGetCurrent() else {
      throw BridgeError.runLoopUnavailable
    }
    let reporter = FailureReporter(runLoop: runLoop)
    let eventChannel = ControlEventChannel()
    let sender = Task {
      for await event in eventChannel.events {
        do {
          try await transport.send(event)
        } catch {
          reporter.fail("semantic control delivery failed: \(error.localizedDescription)")
          return
        }
      }
    }
    let context = BridgeContext(
      mapper: ControlEventMapper(
        talkKeyCode: configuration.talkKeyCode,
        cancelKeyCode: configuration.cancelKeyCode
      ),
      eventChannel: eventChannel,
      reporter: reporter
    )
    let contextPointer = Unmanaged.passUnretained(context).toOpaque()
    let eventMask =
      (CGEventMask(1) << CGEventType.keyDown.rawValue)
      | (CGEventMask(1) << CGEventType.keyUp.rawValue)
    guard
      let tap = CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        place: .headInsertEventTap,
        options: .defaultTap,
        eventsOfInterest: eventMask,
        callback: eventTapCallback,
        userInfo: contextPointer
      )
    else {
      _ = finishAndDrainControlEvents(channel: eventChannel, sender: sender)
      throw BridgeError.eventTapUnavailable
    }
    guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
      CFMachPortInvalidate(tap)
      _ = finishAndDrainControlEvents(channel: eventChannel, sender: sender)
      throw BridgeError.runLoopSourceUnavailable
    }

    let signalSource = installTerminationSignal(runLoop: runLoop)
    CFRunLoopAddSource(runLoop, source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
    FileHandle.standardOutput.write(Data("{\"event\":\"ready\"}\n".utf8))
    CFRunLoopRun()

    CFRunLoopRemoveSource(runLoop, source, .commonModes)
    CFMachPortInvalidate(tap)
    signalSource.cancel()
    _ = finishAndDrainControlEvents(channel: eventChannel, sender: sender)

    if let failure = reporter.failureReason() {
      throw BridgeError.runtimeFailure(failure)
    }
  }
}

private let eventTapCallback: CGEventTapCallBack = { _, type, event, userInfo in
  guard let userInfo else {
    return Unmanaged.passUnretained(event)
  }

  let context = Unmanaged<BridgeContext>.fromOpaque(userInfo).takeUnretainedValue()

  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    context.reportTapDisabled()
    return nil
  }

  guard type == .keyDown || type == .keyUp else {
    return Unmanaged.passUnretained(event)
  }

  let keyCode = UInt16(event.getIntegerValueField(.keyboardEventKeycode))
  let isRepeat = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
  let decision = context.handle(keyCode: keyCode, isKeyDown: type == .keyDown, isRepeat: isRepeat)

  return decision.consume ? nil : Unmanaged.passUnretained(event)
}

private final class BridgeContext {
  private var mapper: ControlEventMapper
  private let eventChannel: ControlEventChannel
  private let reporter: FailureReporter

  init(
    mapper: ControlEventMapper,
    eventChannel: ControlEventChannel,
    reporter: FailureReporter
  ) {
    self.mapper = mapper
    self.eventChannel = eventChannel
    self.reporter = reporter
  }

  func handle(keyCode: UInt16, isKeyDown: Bool, isRepeat: Bool) -> KeyboardEventDecision {
    let decision = mapper.handle(keyCode: keyCode, isKeyDown: isKeyDown, isRepeat: isRepeat)

    if let event = decision.event {
      if !eventChannel.send(event) {
        reporter.fail("semantic control buffer rejected an event")
      }
    }

    return decision
  }

  func reportTapDisabled() {
    reporter.fail("Core Graphics disabled the event tap")
  }
}

private final class FailureReporter: @unchecked Sendable {
  private let lock = NSLock()
  private let runLoop: CFRunLoop
  private var reason: String?

  init(runLoop: CFRunLoop) {
    self.runLoop = runLoop
  }

  func fail(_ message: String) {
    lock.lock()
    let firstFailure = reason == nil

    if firstFailure {
      reason = message
    }

    lock.unlock()

    if firstFailure {
      CFRunLoopStop(runLoop)
      CFRunLoopWakeUp(runLoop)
    }
  }

  func failureReason() -> String? {
    lock.lock()
    defer { lock.unlock() }
    return reason
  }
}

private enum BridgeError: Error, LocalizedError {
  case inputMonitoringDenied
  case eventTapUnavailable
  case runLoopUnavailable
  case runLoopSourceUnavailable
  case runtimeFailure(String)

  var errorDescription: String? {
    switch self {
    case .inputMonitoringDenied:
      "Input Monitoring permission is required for the managed pico-macos-control executable"
    case .eventTapUnavailable:
      "Core Graphics could not create the active session event tap"
    case .runLoopUnavailable:
      "Core Foundation did not provide a current run loop"
    case .runLoopSourceUnavailable:
      "Core Graphics event tap could not create a run-loop source"
    case .runtimeFailure(let reason):
      reason
    }
  }
}

private func requireInputMonitoringAccess() throws {
  guard CGPreflightListenEventAccess() || CGRequestListenEventAccess() else {
    throw BridgeError.inputMonitoringDenied
  }
}

private func awaitHealth(_ transport: ControlTransport) throws {
  let result = AsyncResultBox()
  let semaphore = DispatchSemaphore(value: 0)

  Task {
    do {
      try await transport.checkHealth()
      result.store(.success(()))
    } catch {
      result.store(.failure(error))
    }

    semaphore.signal()
  }

  semaphore.wait()
  try result.load().get()
}

private final class AsyncResultBox: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Result<Void, Error>?

  func store(_ result: Result<Void, Error>) {
    lock.lock()
    value = result
    lock.unlock()
  }

  func load() -> Result<Void, Error> {
    lock.lock()
    defer { lock.unlock() }
    return value ?? .failure(BridgeError.runtimeFailure("health preflight did not complete"))
  }
}

private func installTerminationSignal(runLoop: CFRunLoop) -> DispatchSourceSignal {
  signal(SIGTERM, SIG_IGN)
  let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
  source.setEventHandler {
    CFRunLoopStop(runLoop)
    CFRunLoopWakeUp(runLoop)
  }
  source.resume()
  return source
}

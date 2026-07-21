import AppKit
import CoreGraphics
import Foundation
import PicoMacOSResidentIOCore

@main
enum PicoMacOSResidentIOMain {
  static func main() {
    do {
      try run()
    } catch {
      FileHandle.standardError.write(
        Data("pico macOS resident I/O failed: \(error.localizedDescription)\n".utf8))
      Darwin.exit(1)
    }
  }

  private static func run() throws {
    let configuration = try ResidentIoConfiguration.parse(
      arguments: Array(CommandLine.arguments.dropFirst()))
    try requireInputMonitoringAccess()
    guard let runLoop = CFRunLoopGetCurrent() else {
      throw ResidentIoMainError.runLoopUnavailable
    }
    let runLoopBox = RunLoopBox(runLoop)
    let owner = try ResidentIoOwner(configuration: configuration) {
      runLoopBox.stop()
    }
    try owner.start()
    startCommandReader(owner: owner)
    let context = KeyboardContext(
      mapper: ControlEventMapper(
        talkKeyCode: configuration.talkKeyCode,
        cancelKeyCode: configuration.cancelKeyCode
      ),
      owner: owner
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
      owner.stop()
      throw ResidentIoMainError.eventTapUnavailable
    }
    guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
      CFMachPortInvalidate(tap)
      owner.stop()
      throw ResidentIoMainError.runLoopSourceUnavailable
    }
    let signalSource = installTerminationSignal(runLoop: runLoop)
    let workspaceCenter = NSWorkspace.shared.notificationCenter
    let sleepObserver = workspaceCenter.addObserver(
      forName: NSWorkspace.willSleepNotification, object: nil, queue: nil
    ) { _ in owner.sleep() }
    let wakeObserver = workspaceCenter.addObserver(
      forName: NSWorkspace.didWakeNotification, object: nil, queue: nil
    ) { _ in owner.wake() }

    withExtendedLifetime(context) {
      CFRunLoopAddSource(runLoop, source, .commonModes)
      CGEvent.tapEnable(tap: tap, enable: true)
      CFRunLoopRun()
      CGEvent.tapEnable(tap: tap, enable: false)
      CFRunLoopRemoveSource(runLoop, source, .commonModes)
      CFMachPortInvalidate(tap)
    }

    workspaceCenter.removeObserver(sleepObserver)
    workspaceCenter.removeObserver(wakeObserver)
    signalSource.cancel()
    owner.stop()
  }
}

private final class RunLoopBox: @unchecked Sendable {
  private let runLoop: CFRunLoop

  init(_ runLoop: CFRunLoop) {
    self.runLoop = runLoop
  }

  func stop() {
    CFRunLoopStop(runLoop)
    CFRunLoopWakeUp(runLoop)
  }
}

private let eventTapCallback: CGEventTapCallBack = { _, type, event, userInfo in
  guard let userInfo else { return Unmanaged.passUnretained(event) }
  let context = Unmanaged<KeyboardContext>.fromOpaque(userInfo).takeUnretainedValue()
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    context.owner.reportEventTapFailure()
    return nil
  }
  guard type == .keyDown || type == .keyUp else { return Unmanaged.passUnretained(event) }
  let keyCode = UInt16(event.getIntegerValueField(.keyboardEventKeycode))
  let isRepeat = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
  let decision = context.handle(
    keyCode: keyCode,
    isKeyDown: type == .keyDown,
    isRepeat: isRepeat,
    timestampNanoseconds: event.timestamp
  )
  return decision.consume ? nil : Unmanaged.passUnretained(event)
}

private final class KeyboardContext {
  var mapper: ControlEventMapper
  let owner: ResidentIoOwner

  init(mapper: ControlEventMapper, owner: ResidentIoOwner) {
    self.mapper = mapper
    self.owner = owner
  }

  func handle(
    keyCode: UInt16,
    isKeyDown: Bool,
    isRepeat: Bool,
    timestampNanoseconds: UInt64
  ) -> KeyboardEventDecision {
    let decision = mapper.handle(keyCode: keyCode, isKeyDown: isKeyDown, isRepeat: isRepeat)
    if let event = decision.event {
      owner.handleControlEvent(event, eventTimestampNanoseconds: timestampNanoseconds)
    }
    return decision
  }
}

private func startCommandReader(owner: ResidentIoOwner) {
  DispatchQueue.global(qos: .userInitiated).async {
    var decoder = ResidentIoDecoder()
    do {
      while let data = try FileHandle.standardInput.read(upToCount: 65_536), !data.isEmpty {
        try decoder.append(data)
        while let message = try decoder.next() {
          owner.receive(message)
        }
      }
      owner.reportProtocolEof()
    } catch {
      owner.reportProtocolFailure(error)
    }
  }
}

private enum ResidentIoMainError: Error, LocalizedError {
  case inputMonitoringDenied
  case eventTapUnavailable
  case runLoopUnavailable
  case runLoopSourceUnavailable

  var errorDescription: String? {
    switch self {
    case .inputMonitoringDenied:
      "Input Monitoring permission is required for pico-macos-resident-io"
    case .eventTapUnavailable:
      "Core Graphics could not create the resident I/O event tap"
    case .runLoopUnavailable:
      "Core Foundation did not provide a current run loop"
    case .runLoopSourceUnavailable:
      "Core Graphics event tap could not create a run-loop source"
    }
  }
}

private func requireInputMonitoringAccess() throws {
  guard CGPreflightListenEventAccess() || CGRequestListenEventAccess() else {
    throw ResidentIoMainError.inputMonitoringDenied
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

import AppKit
import AudioToolbox
import AVFAudio
import CoreAudio
import CoreGraphics
import Foundation
import Darwin

private struct Options {
    let durationSeconds: TimeInterval
    let deviceUID: String?
    let talkKeyCode: Int64
    let releaseTailMilliseconds: UInt64

    static func parse(_ arguments: [String]) throws -> Options {
        var durationSeconds: TimeInterval = 20
        var deviceUID: String?
        var talkKeyCode: Int64 = 122
        var releaseTailMilliseconds: UInt64 = 250
        var index = 1

        while index < arguments.count {
            let argument = arguments[index]
            guard index + 1 < arguments.count else {
                throw ProbeError.invalidArgument("missing value for \(argument)")
            }
            let value = arguments[index + 1]
            switch argument {
            case "--duration-seconds":
                guard let parsed = TimeInterval(value), parsed > 0, parsed <= 300 else {
                    throw ProbeError.invalidArgument("duration must be between 0 and 300 seconds")
                }
                durationSeconds = parsed
            case "--device-uid":
                guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    throw ProbeError.invalidArgument("device UID must not be empty")
                }
                deviceUID = value
            case "--talk-key-code":
                guard let parsed = Int64(value), parsed >= 0 else {
                    throw ProbeError.invalidArgument("talk key code must be non-negative")
                }
                talkKeyCode = parsed
            case "--release-tail-ms":
                guard let parsed = UInt64(value), parsed <= 5_000 else {
                    throw ProbeError.invalidArgument("release tail must be at most 5000 ms")
                }
                releaseTailMilliseconds = parsed
            default:
                throw ProbeError.invalidArgument("unknown argument \(argument)")
            }
            index += 2
        }

        return Options(
            durationSeconds: durationSeconds,
            deviceUID: deviceUID,
            talkKeyCode: talkKeyCode,
            releaseTailMilliseconds: releaseTailMilliseconds
        )
    }
}

private enum ProbeError: Error, CustomStringConvertible {
    case audio(OSStatus, String)
    case deviceNotFound(String)
    case invalidArgument(String)
    case missingInputFormat
    case eventTapUnavailable

    var description: String {
        switch self {
        case let .audio(status, operation):
            return "\(operation) failed with CoreAudio status \(status)"
        case let .deviceNotFound(uid):
            return "no CoreAudio device has UID \(uid)"
        case let .invalidArgument(message):
            return message
        case .missingInputFormat:
            return "selected input device has no usable input format"
        case .eventTapUnavailable:
            return "global keyboard event tap is unavailable; grant Accessibility permission"
        }
    }
}

private struct DeviceReport: Codable {
    let id: UInt32
    let name: String
    let uid: String
    let isDefaultInput: Bool
    let isSelectedInput: Bool
}

private struct ProbeReport: Codable {
    let durationSeconds: Double
    let device: DeviceReport
    let sampleRate: Double
    let channelCount: UInt32
    let callbackCount: UInt64
    let frameCount: UInt64
    let frameLengthMinimum: UInt32?
    let frameLengthMaximum: UInt32?
    let bufferDurationMillisecondsMean: Double?
    let callbackCadenceMillisecondsMinimum: Double?
    let callbackCadenceMillisecondsMean: Double?
    let callbackCadenceMillisecondsMaximum: Double?
    let engineStartToFirstCallbackMilliseconds: Double?
    let acceptedFrameCount: UInt64
    let droppedOutsidePttFrameCount: UInt64
    let firstAcceptedSampleAfterKeyDownMilliseconds: [Double]
    let keyEventHostClockDeltaMilliseconds: [Double]
    let configurationChangeCount: UInt64
    let engineUnexpectedStopCount: UInt64
    let sleepCount: UInt64
    let wakeCount: UInt64
    let processUserCpuSeconds: Double
    let processSystemCpuSeconds: Double
    let maximumResidentSetKilobytes: Int64
    let thermalState: String
}

private struct RunningAverage {
    private(set) var count: UInt64 = 0
    private(set) var total = 0.0
    private(set) var minimum: Double?
    private(set) var maximum: Double?

    mutating func add(_ value: Double) {
        count += 1
        total += value
        minimum = minimum.map { Swift.min($0, value) } ?? value
        maximum = maximum.map { Swift.max($0, value) } ?? value
    }

    var mean: Double? { count == 0 ? nil : total / Double(count) }
}

private final class ProbeState: @unchecked Sendable {
    private let lock = NSLock()
    private let releaseTailNanoseconds: UInt64
    private(set) var talkKeyCode: Int64

    private var engineStartHostNanoseconds: UInt64 = 0
    private var firstCallbackHostNanoseconds: UInt64?
    private var previousCallbackHostNanoseconds: UInt64?
    private var callbackCount: UInt64 = 0
    private var frameCount: UInt64 = 0
    private var acceptedFrameCount: UInt64 = 0
    private var droppedFrameCount: UInt64 = 0
    private var frameLengths = RunningAverage()
    private var bufferDurations = RunningAverage()
    private var callbackCadences = RunningAverage()
    private var gateStartNanoseconds: UInt64?
    private var gateEndNanoseconds: UInt64?
    private var awaitingFirstAcceptedSample = false
    private var acceptedSampleDeltas: [Double] = []
    private var keyClockDeltas: [Double] = []
    private var configurationChangeCount: UInt64 = 0
    private var engineUnexpectedStopCount: UInt64 = 0
    private var sleepCount: UInt64 = 0
    private var wakeCount: UInt64 = 0

    init(talkKeyCode: Int64, releaseTailMilliseconds: UInt64) {
        self.talkKeyCode = talkKeyCode
        releaseTailNanoseconds = releaseTailMilliseconds * 1_000_000
    }

    func engineStarted(at hostNanoseconds: UInt64) {
        lock.withLock { engineStartHostNanoseconds = hostNanoseconds }
    }

    func recordKey(type: CGEventType, eventNanoseconds: UInt64, callbackNanoseconds: UInt64) {
        lock.withLock {
            if keyClockDeltas.count < 512 {
                let delta = signedDifference(callbackNanoseconds, eventNanoseconds)
                keyClockDeltas.append(Double(delta) / 1_000_000)
            }
            if type == .keyDown {
                gateStartNanoseconds = eventNanoseconds
                gateEndNanoseconds = nil
                awaitingFirstAcceptedSample = true
            } else if type == .keyUp, gateStartNanoseconds != nil {
                gateEndNanoseconds = eventNanoseconds &+ releaseTailNanoseconds
            }
        }
    }

    func recordAudioBuffer(
        startNanoseconds: UInt64,
        callbackNanoseconds: UInt64,
        frameLength: UInt32,
        sampleRate: Double
    ) {
        lock.withLock {
            callbackCount += 1
            frameCount += UInt64(frameLength)
            frameLengths.add(Double(frameLength))
            let durationNanoseconds = UInt64((Double(frameLength) / sampleRate) * 1_000_000_000)
            bufferDurations.add(Double(durationNanoseconds) / 1_000_000)
            if firstCallbackHostNanoseconds == nil {
                firstCallbackHostNanoseconds = callbackNanoseconds
            }
            if let previous = previousCallbackHostNanoseconds {
                callbackCadences.add(Double(callbackNanoseconds - previous) / 1_000_000)
            }
            previousCallbackHostNanoseconds = callbackNanoseconds

            let endNanoseconds = startNanoseconds &+ durationNanoseconds
            guard let gateStart = gateStartNanoseconds else {
                droppedFrameCount += UInt64(frameLength)
                return
            }
            let gateEnd = gateEndNanoseconds ?? UInt64.max
            let acceptedStart = max(startNanoseconds, gateStart)
            let acceptedEnd = min(endNanoseconds, gateEnd)
            guard acceptedEnd > acceptedStart else {
                droppedFrameCount += UInt64(frameLength)
                if endNanoseconds >= gateEnd {
                    gateStartNanoseconds = nil
                    gateEndNanoseconds = nil
                }
                return
            }

            let accepted = min(
                UInt64(frameLength),
                UInt64((Double(acceptedEnd - acceptedStart) / 1_000_000_000) * sampleRate)
            )
            acceptedFrameCount += accepted
            droppedFrameCount += UInt64(frameLength) - accepted
            if awaitingFirstAcceptedSample {
                acceptedSampleDeltas.append(Double(acceptedStart - gateStart) / 1_000_000)
                awaitingFirstAcceptedSample = false
            }
            if endNanoseconds >= gateEnd {
                gateStartNanoseconds = nil
                gateEndNanoseconds = nil
            }
        }
    }

    func recordConfigurationChange() {
        lock.withLock { configurationChangeCount += 1 }
    }

    func recordUnexpectedStop() {
        lock.withLock { engineUnexpectedStopCount += 1 }
    }

    func recordSleep() {
        lock.withLock { sleepCount += 1 }
    }

    func recordWake() {
        lock.withLock { wakeCount += 1 }
    }

    func makeReport(
        durationSeconds: Double,
        device: DeviceReport,
        sampleRate: Double,
        channelCount: UInt32,
        usage: rusage
    ) -> ProbeReport {
        lock.withLock {
            let firstCallbackLatency = firstCallbackHostNanoseconds.map {
                Double($0 - engineStartHostNanoseconds) / 1_000_000
            }
            return ProbeReport(
                durationSeconds: durationSeconds,
                device: device,
                sampleRate: sampleRate,
                channelCount: channelCount,
                callbackCount: callbackCount,
                frameCount: frameCount,
                frameLengthMinimum: frameLengths.minimum.map(UInt32.init),
                frameLengthMaximum: frameLengths.maximum.map(UInt32.init),
                bufferDurationMillisecondsMean: bufferDurations.mean,
                callbackCadenceMillisecondsMinimum: callbackCadences.minimum,
                callbackCadenceMillisecondsMean: callbackCadences.mean,
                callbackCadenceMillisecondsMaximum: callbackCadences.maximum,
                engineStartToFirstCallbackMilliseconds: firstCallbackLatency,
                acceptedFrameCount: acceptedFrameCount,
                droppedOutsidePttFrameCount: droppedFrameCount,
                firstAcceptedSampleAfterKeyDownMilliseconds: acceptedSampleDeltas,
                keyEventHostClockDeltaMilliseconds: keyClockDeltas,
                configurationChangeCount: configurationChangeCount,
                engineUnexpectedStopCount: engineUnexpectedStopCount,
                sleepCount: sleepCount,
                wakeCount: wakeCount,
                processUserCpuSeconds: timevalSeconds(usage.ru_utime),
                processSystemCpuSeconds: timevalSeconds(usage.ru_stime),
                maximumResidentSetKilobytes: Int64(usage.ru_maxrss),
                thermalState: thermalStateName(ProcessInfo.processInfo.thermalState)
            )
        }
    }
}

private extension NSLock {
    func withLock<T>(_ operation: () -> T) -> T {
        lock()
        defer { unlock() }
        return operation()
    }
}

private func signedDifference(_ lhs: UInt64, _ rhs: UInt64) -> Int64 {
    lhs >= rhs ? Int64(lhs - rhs) : -Int64(rhs - lhs)
}

private func hostNanoseconds(_ hostTime: UInt64 = mach_absolute_time()) -> UInt64 {
    var information = mach_timebase_info_data_t()
    mach_timebase_info(&information)
    return UInt64(
        (Double(hostTime) * Double(information.numer)) / Double(information.denom)
    )
}

private func timevalSeconds(_ value: timeval) -> Double {
    Double(value.tv_sec) + (Double(value.tv_usec) / 1_000_000)
}

private func thermalStateName(_ state: ProcessInfo.ThermalState) -> String {
    switch state {
    case .nominal: "nominal"
    case .fair: "fair"
    case .serious: "serious"
    case .critical: "critical"
    @unknown default: "unknown"
    }
}

private func audioProperty<T>(
    objectID: AudioObjectID,
    selector: AudioObjectPropertySelector,
    initialValue: T
) throws -> T {
    var address = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var value = initialValue
    var size = UInt32(MemoryLayout<T>.size)
    let status = AudioObjectGetPropertyData(objectID, &address, 0, nil, &size, &value)
    guard status == noErr else { throw ProbeError.audio(status, "read audio property") }
    return value
}

private func stringProperty(
    objectID: AudioObjectID,
    selector: AudioObjectPropertySelector
) throws -> String {
    let value: CFString = try audioProperty(
        objectID: objectID,
        selector: selector,
        initialValue: "" as CFString
    )
    return value as String
}

private func deviceIDs() throws -> [AudioDeviceID] {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    var status = AudioObjectGetPropertyDataSize(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size
    )
    guard status == noErr else { throw ProbeError.audio(status, "list audio devices") }
    var devices = [AudioDeviceID](
        repeating: kAudioObjectUnknown,
        count: Int(size) / MemoryLayout<AudioDeviceID>.size
    )
    status = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &devices
    )
    guard status == noErr else { throw ProbeError.audio(status, "read audio devices") }
    return devices
}

private func selectDevice(requestedUID: String?) throws -> (AudioDeviceID, DeviceReport) {
    let defaultDevice: AudioDeviceID = try audioProperty(
        objectID: AudioObjectID(kAudioObjectSystemObject),
        selector: kAudioHardwarePropertyDefaultInputDevice,
        initialValue: kAudioObjectUnknown
    )
    let selectedID: AudioDeviceID
    if let requestedUID {
        guard let match = try deviceIDs().first(where: {
            try stringProperty(objectID: $0, selector: kAudioDevicePropertyDeviceUID) == requestedUID
        }) else {
            throw ProbeError.deviceNotFound(requestedUID)
        }
        selectedID = match
    } else {
        selectedID = defaultDevice
    }
    let report = DeviceReport(
        id: selectedID,
        name: try stringProperty(objectID: selectedID, selector: kAudioObjectPropertyName),
        uid: try stringProperty(objectID: selectedID, selector: kAudioDevicePropertyDeviceUID),
        isDefaultInput: selectedID == defaultDevice,
        isSelectedInput: true
    )
    return (selectedID, report)
}

private func eventTapCallback(
    proxy _: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let userInfo else { return Unmanaged.passUnretained(event) }
    let state = Unmanaged<ProbeState>.fromOpaque(userInfo).takeUnretainedValue()
    guard type == .keyDown || type == .keyUp,
          event.getIntegerValueField(.keyboardEventKeycode) == state.talkKeyCode else {
        return Unmanaged.passUnretained(event)
    }
    state.recordKey(
        type: type,
        eventNanoseconds: event.timestamp,
        callbackNanoseconds: hostNanoseconds()
    )
    return Unmanaged.passUnretained(event)
}

private func run() throws {
    let options = try Options.parse(CommandLine.arguments)
    let (deviceID, deviceReport) = try selectDevice(requestedUID: options.deviceUID)
    let state = ProbeState(
        talkKeyCode: options.talkKeyCode,
        releaseTailMilliseconds: options.releaseTailMilliseconds
    )
    let engine = AVAudioEngine()
    try engine.inputNode.auAudioUnit.setDeviceID(deviceID)
    let format = engine.inputNode.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else { throw ProbeError.missingInputFormat }

    engine.inputNode.installTap(onBus: 0, bufferSize: 4_096, format: format) { buffer, when in
        state.recordAudioBuffer(
            startNanoseconds: hostNanoseconds(when.hostTime),
            callbackNanoseconds: hostNanoseconds(),
            frameLength: buffer.frameLength,
            sampleRate: format.sampleRate
        )
    }

    let notificationCenter = NotificationCenter.default
    let configurationObserver = notificationCenter.addObserver(
        forName: .AVAudioEngineConfigurationChange,
        object: engine,
        queue: nil
    ) { _ in
        state.recordConfigurationChange()
    }
    let workspaceCenter = NSWorkspace.shared.notificationCenter
    let sleepObserver = workspaceCenter.addObserver(
        forName: NSWorkspace.willSleepNotification,
        object: nil,
        queue: nil
    ) { _ in state.recordSleep() }
    let wakeObserver = workspaceCenter.addObserver(
        forName: NSWorkspace.didWakeNotification,
        object: nil,
        queue: nil
    ) { _ in state.recordWake() }
    defer {
        notificationCenter.removeObserver(configurationObserver)
        workspaceCenter.removeObserver(sleepObserver)
        workspaceCenter.removeObserver(wakeObserver)
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }

    let eventMask = CGEventMask(1 << CGEventType.keyDown.rawValue)
        | CGEventMask(1 << CGEventType.keyUp.rawValue)
    guard let eventTap = CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        place: .headInsertEventTap,
        options: .listenOnly,
        eventsOfInterest: eventMask,
        callback: eventTapCallback,
        userInfo: Unmanaged.passUnretained(state).toOpaque()
    ) else {
        throw ProbeError.eventTapUnavailable
    }
    let eventSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0)
    CFRunLoopAddSource(CFRunLoopGetCurrent(), eventSource, .commonModes)
    CGEvent.tapEnable(tap: eventTap, enable: true)
    defer {
        CGEvent.tapEnable(tap: eventTap, enable: false)
        CFRunLoopRemoveSource(CFRunLoopGetCurrent(), eventSource, .commonModes)
    }

    engine.prepare()
    let startedAt = hostNanoseconds()
    try engine.start()
    state.engineStarted(at: startedAt)

    let deadline = Date(timeIntervalSinceNow: options.durationSeconds)
    while Date() < deadline {
        RunLoop.current.run(until: min(deadline, Date(timeIntervalSinceNow: 0.1)))
        if !engine.isRunning {
            state.recordUnexpectedStop()
            break
        }
    }

    var usage = rusage()
    getrusage(RUSAGE_SELF, &usage)
    let report = state.makeReport(
        durationSeconds: options.durationSeconds,
        device: deviceReport,
        sampleRate: format.sampleRate,
        channelCount: format.channelCount,
        usage: usage
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    FileHandle.standardOutput.write(try encoder.encode(report))
    FileHandle.standardOutput.write(Data([0x0A]))
}

do {
    try run()
} catch {
    FileHandle.standardError.write(Data("macOS resident audio probe: \(error)\n".utf8))
    exit(1)
}

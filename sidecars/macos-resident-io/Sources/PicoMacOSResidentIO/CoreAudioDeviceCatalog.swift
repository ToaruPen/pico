import CoreAudio
import Foundation
import PicoMacOSResidentIOCore

enum CoreAudioDeviceCatalog {
  static func resolveInputDevice(uid: String) throws -> AudioDeviceID {
    let devices = try enumerateInputDevices()
    return try PicoMacOSResidentIOCore.resolveInputDevice(uid: uid, from: devices).id
  }

  private static func enumerateInputDevices() throws -> [CoreAudioInputDevice] {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyDevices,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    try requireNoErr(
      AudioObjectGetPropertyDataSize(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size),
      operation: "list Core Audio devices"
    )
    var deviceIDs = [AudioDeviceID](
      repeating: kAudioObjectUnknown,
      count: Int(size) / MemoryLayout<AudioDeviceID>.size
    )
    try requireNoErr(
      AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceIDs),
      operation: "read Core Audio devices"
    )
    return try deviceIDs.map { deviceID in
      CoreAudioInputDevice(
        id: deviceID,
        uid: try stringProperty(deviceID, kAudioDevicePropertyDeviceUID),
        name: try stringProperty(deviceID, kAudioObjectPropertyName),
        inputChannels: try inputChannelCount(deviceID)
      )
    }
  }

  private static func stringProperty(
    _ objectID: AudioObjectID,
    _ selector: AudioObjectPropertySelector
  ) throws -> String {
    var address = AudioObjectPropertyAddress(
      mSelector: selector,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain
    )
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    try requireNoErr(
      AudioObjectGetPropertyData(objectID, &address, 0, nil, &size, &value),
      operation: "read Core Audio string property"
    )
    guard let value else {
      throw ResidentAudioEngineError.coreAudio(
        operation: "read Core Audio string property", status: kAudio_ParamError)
    }
    return value.takeUnretainedValue() as String
  }

  private static func inputChannelCount(_ deviceID: AudioDeviceID) throws -> UInt32 {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioDevicePropertyStreamConfiguration,
      mScope: kAudioDevicePropertyScopeInput,
      mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    try requireNoErr(
      AudioObjectGetPropertyDataSize(deviceID, &address, 0, nil, &size),
      operation: "read Core Audio input stream size"
    )
    let rawList = UnsafeMutableRawPointer.allocate(
      byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { rawList.deallocate() }
    let listPointer = rawList.assumingMemoryBound(to: AudioBufferList.self)
    var mutableSize = size
    try requireNoErr(
      AudioObjectGetPropertyData(
        deviceID, &address, 0, nil, &mutableSize, listPointer),
      operation: "read Core Audio input streams"
    )
    let list = UnsafeMutableAudioBufferListPointer(listPointer)
    return list.reduce(0) { $0 + $1.mNumberChannels }
  }

  private static func requireNoErr(_ status: OSStatus, operation: String) throws {
    guard status == noErr else {
      throw ResidentAudioEngineError.coreAudio(operation: operation, status: status)
    }
  }
}

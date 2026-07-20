import Foundation

public struct CoreAudioInputDevice: Equatable, Sendable {
  public let id: UInt32
  public let uid: String
  public let name: String
  public let inputChannels: UInt32

  public init(id: UInt32, uid: String, name: String, inputChannels: UInt32) {
    self.id = id
    self.uid = uid
    self.name = name
    self.inputChannels = inputChannels
  }
}

public enum CoreAudioInputDeviceError: Error, Equatable, Sendable {
  case notFound(String)
  case duplicateUID(String)
  case inputUnavailable(String)
}

public func resolveInputDevice(uid: String, from devices: [CoreAudioInputDevice]) throws
  -> CoreAudioInputDevice
{
  let matching = devices.filter { $0.uid == uid }
  guard !matching.isEmpty else { throw CoreAudioInputDeviceError.notFound(uid) }
  guard matching.count == 1 else { throw CoreAudioInputDeviceError.duplicateUID(uid) }
  let device = matching[0]
  guard device.inputChannels > 0 else {
    throw CoreAudioInputDeviceError.inputUnavailable(uid)
  }
  return device
}

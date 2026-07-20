import Testing

@testable import PicoMacOSResidentIOCore

@Suite("Core Audio input device selection")
struct CoreAudioInputDeviceTests {
  @Test("selects exactly one input-capable device by stable UID")
  func resolvesStableUID() throws {
    let devices = [
      CoreAudioInputDevice(id: 2, uid: "speaker", name: "Output", inputChannels: 0),
      CoreAudioInputDevice(id: 7, uid: "usb-mic", name: "Mic", inputChannels: 2),
    ]

    #expect(try resolveInputDevice(uid: "usb-mic", from: devices).id == 7)
  }

  @Test("rejects missing, duplicate, and output-only UID matches")
  func rejectsAmbiguousOrIncapableDevices() {
    #expect(throws: CoreAudioInputDeviceError.notFound("missing")) {
      try resolveInputDevice(uid: "missing", from: [])
    }
    #expect(throws: CoreAudioInputDeviceError.duplicateUID("duplicate")) {
      try resolveInputDevice(
        uid: "duplicate",
        from: [
          CoreAudioInputDevice(id: 1, uid: "duplicate", name: "One", inputChannels: 1),
          CoreAudioInputDevice(id: 2, uid: "duplicate", name: "Two", inputChannels: 1),
        ]
      )
    }
    #expect(throws: CoreAudioInputDeviceError.inputUnavailable("speaker")) {
      try resolveInputDevice(
        uid: "speaker",
        from: [CoreAudioInputDevice(id: 2, uid: "speaker", name: "Output", inputChannels: 0)]
      )
    }
  }
}

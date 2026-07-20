import Foundation
import Testing

@testable import PicoMacOSResidentIOCore

@Suite("resident I/O framed protocol")
struct ResidentIoCodecTests {
  @Test("decodes a frame only after fragmented input is complete")
  func decodesFragmentedFrame() throws {
    let message = ResidentIoMessage.ready(
      ReadyMetadata(engineGeneration: 4, sampleRateHz: 16_000, channels: 1))
    let encoded = try ResidentIoCodec.encode(message)
    var decoder = ResidentIoDecoder()

    try decoder.append(encoded.prefix(7))
    #expect(try decoder.next() == nil)
    try decoder.append(encoded.dropFirst(7))
    #expect(try decoder.next() == message)
  }

  @Test("preserves consecutive frame ordering and PCM bytes")
  func preservesConsecutiveFrames() throws {
    let control = ResidentIoMessage.controlEvent(
      ControlEventMetadata(sequence: 9, kind: .talkPressed, eventTimestampNanoseconds: "12345"))
    let pcm = ResidentIoMessage.pcmFrame(
      PcmFrameMetadata(
        generation: 11,
        sampleHostTimeNanoseconds: "20000",
        sampleRateHz: 16_000,
        channels: 1,
        frameCount: 2
      ),
      Data([1, 2, 3, 4])
    )
    var bytes = try ResidentIoCodec.encode(control)
    bytes.append(try ResidentIoCodec.encode(pcm))
    var decoder = ResidentIoDecoder()

    try decoder.append(bytes)

    #expect(try decoder.next() == control)
    #expect(try decoder.next() == pcm)
    #expect(try decoder.next() == nil)
  }

  @Test("preserves UInt64 host timestamps as decimal strings")
  func preservesUInt64HostTimestamp() throws {
    let message = ResidentIoMessage.controlEvent(
      ControlEventMetadata(
        sequence: 1,
        kind: .talkPressed,
        eventTimestampNanoseconds: "18446744073709551615"))
    var decoder = ResidentIoDecoder()

    try decoder.append(ResidentIoCodec.encode(message))

    #expect(try decoder.next() == message)
  }

  @Test("round-trips fixed privacy-safe timing stages")
  func preservesTimingEvent() throws {
    let message = ResidentIoMessage.timingEvent(
      TimingEventMetadata(stage: .keyToAdmission, durationMs: 1.25))
    var decoder = ResidentIoDecoder()

    try decoder.append(ResidentIoCodec.encode(message))

    #expect(try decoder.next() == message)
  }

  @Test("rejects unknown versions and kinds")
  func rejectsUnknownHeaderFields() throws {
    var version = try ResidentIoCodec.encode(.shutdown)
    version[4] = 2
    var versionDecoder = ResidentIoDecoder()
    #expect(throws: ResidentIoCodecError.unsupportedVersion(2)) {
      try versionDecoder.append(version)
    }

    var kind = try ResidentIoCodec.encode(.shutdown)
    kind[5] = 255
    var kindDecoder = ResidentIoDecoder()
    #expect(throws: ResidentIoCodecError.unknownKind(255)) {
      try kindDecoder.append(kind)
    }
  }

  @Test("rejects oversized lengths before buffering their bodies")
  func rejectsOversizedLengths() throws {
    var metadata = try ResidentIoCodec.encode(.shutdown)
    metadata.replaceSubrange(8..<12, with: [0, 0, 64, 1])
    var metadataDecoder = ResidentIoDecoder()
    #expect(throws: ResidentIoCodecError.metadataTooLarge(16_385)) {
      try metadataDecoder.append(metadata)
    }

    var payload = try ResidentIoCodec.encode(.shutdown)
    payload.replaceSubrange(12..<16, with: [0, 16, 0, 1])
    var payloadDecoder = ResidentIoDecoder()
    #expect(throws: ResidentIoCodecError.payloadTooLarge(1_048_577)) {
      try payloadDecoder.append(payload)
    }
  }

  @Test("permits payload bytes only on PCM messages")
  func rejectsPayloadOnMetadataOnlyMessage() throws {
    var encoded = try ResidentIoCodec.encode(.shutdown)
    encoded.replaceSubrange(12..<16, with: [0, 0, 0, 1])
    encoded.append(0)
    var decoder = ResidentIoDecoder()
    try decoder.append(encoded)

    #expect(throws: ResidentIoCodecError.unexpectedPayload(.shutdown)) {
      try decoder.next()
    }
  }

  @Test("requires PCM payload length to match frame and channel metadata")
  func rejectsMismatchedPcmPayloadLength() throws {
    let message = ResidentIoMessage.pcmFrame(
      PcmFrameMetadata(
        generation: 1,
        sampleHostTimeNanoseconds: "2",
        sampleRateHz: 16_000,
        channels: 1,
        frameCount: 2
      ),
      Data([1, 2])
    )

    #expect(throws: ResidentIoCodecError.invalidPcmPayloadLength(expected: 4, actual: 2)) {
      try ResidentIoCodec.encode(message)
    }
  }
}

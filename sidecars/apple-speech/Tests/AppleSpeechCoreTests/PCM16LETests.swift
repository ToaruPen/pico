import Foundation
import Testing

@testable import AppleSpeechCore

@Suite("PCM16LE conversion")
struct PCM16LETests {
  @Test("converts little-endian signed samples without normalization")
  func convertsSamples() throws {
    let buffer = try PCM16LE.makeBuffer(
      from: Data([0x00, 0x80, 0xff, 0xff, 0x00, 0x00, 0xff, 0x7f])
    )

    #expect(buffer.format.sampleRate == 16_000)
    #expect(buffer.format.channelCount == 1)
    #expect(buffer.frameLength == 4)
    let channel = try #require(buffer.int16ChannelData?[0])
    #expect(Array(UnsafeBufferPointer(start: channel, count: 4)) == [-32_768, -1, 0, 32_767])
  }

  @Test("computes duration from the real audio byte count")
  func computesDuration() throws {
    #expect(try PCM16LE.durationMilliseconds(forByteCount: 32_000) == 1_000)
  }

  @Test("rejects empty and misaligned audio", arguments: [0, 1, 3])
  func rejectsInvalidByteCounts(byteCount: Int) {
    #expect(throws: SidecarServiceError.invalidRequest) {
      try PCM16LE.makeBuffer(from: Data(repeating: 0, count: byteCount))
    }
  }
}

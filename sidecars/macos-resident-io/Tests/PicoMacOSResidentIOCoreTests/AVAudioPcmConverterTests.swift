import Testing

@testable import PicoMacOSResidentIOCore

@Suite("AVAudioConverter PCM conversion")
struct AVAudioPcmConverterTests {
  @Test("converts 44.1 kHz mono PCM to the configured 16 kHz format")
  func converts44100HzTo16000Hz() throws {
    let converter = try AVAudioPcm16MonoConverter(outputSampleRate: 16_000)
    let input = (0..<441).map { index in
      Int16(clamping: index * 32)
    }

    let output = try converter.convert(samples: input, sampleRate: 44_100)

    #expect(output.count >= 150)
    #expect(output.count <= 170)
  }

  @Test("drains converter latency at the accepted tail boundary")
  func drainsTailLatency() throws {
    let converter = try AVAudioPcm16MonoConverter(outputSampleRate: 16_000)
    let input = [Int16](repeating: 1_000, count: 441)
    var output: [Int16] = []

    for _ in 0..<5 {
      output.append(contentsOf: try converter.convert(samples: input, sampleRate: 44_100))
    }
    let tail = try converter.finish()
    output.append(contentsOf: tail)

    #expect(tail.count > 0)
    #expect(output.count == 800)
  }
}

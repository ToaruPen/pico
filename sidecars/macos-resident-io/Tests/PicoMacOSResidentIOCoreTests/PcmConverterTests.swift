import Testing

@testable import PicoMacOSResidentIOCore

@Suite("resident PCM conversion")
struct PcmConverterTests {
  @Test("resamples a continuous 48 kHz mono buffer to 16 kHz")
  func resamplesToResidentFormat() throws {
    var converter = LinearPcm16MonoResampler(outputSampleRate: 16_000)
    let source = (0..<480).map { Float($0) / 480 }

    let converted = try converter.convert(
      samples: source,
      sampleRate: 48_000,
      bufferStartingAt: 10.0
    )

    #expect(converted.sampleRate == 16_000)
    #expect(converted.bufferStartHostSeconds == 10.0)
    #expect(converted.samples.count == 160)
    #expect(converted.samples[1] > converted.samples[0])
  }

  @Test("rejects timestamp discontinuity instead of estimating through it")
  func rejectsDiscontinuity() throws {
    var converter = LinearPcm16MonoResampler(outputSampleRate: 16_000)
    _ = try converter.convert(samples: [0, 0], sampleRate: 100, bufferStartingAt: 1.0)

    #expect(throws: PcmConversionError.timestampDiscontinuity) {
      try converter.convert(samples: [0], sampleRate: 100, bufferStartingAt: 2.0)
    }
  }

  @Test("assembles fixed frames and never mixes generations")
  func assemblesGenerationOwnedFrames() throws {
    var assembler = Pcm16FrameAssembler(frameCount: 4)

    #expect(
      try assembler.append(
        generation: 1,
        samples: [1, 2],
        startingAtHostSeconds: 1.0,
        sampleRate: 16_000
      ).isEmpty)
    let frames = try assembler.append(
      generation: 1,
      samples: [3, 4, 5, 6],
      startingAtHostSeconds: 1.000125,
      sampleRate: 16_000
    )
    #expect(frames.map(\.samples) == [[1, 2, 3, 4]])
    #expect(assembler.flush(generation: 1).map(\.samples) == [[5, 6]])

    _ = try assembler.append(
      generation: 2,
      samples: [7],
      startingAtHostSeconds: 2.0,
      sampleRate: 16_000
    )
    #expect(throws: PcmFrameAssemblerError.generationMismatch) {
      try assembler.append(
        generation: 3,
        samples: [8],
        startingAtHostSeconds: 2.1,
        sampleRate: 16_000
      )
    }
  }
}

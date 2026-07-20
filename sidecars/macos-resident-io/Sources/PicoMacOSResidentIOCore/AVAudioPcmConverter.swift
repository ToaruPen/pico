@preconcurrency import AVFAudio
import Foundation

public enum AVAudioPcmConverterError: Error, Equatable, Sendable {
  case invalidSampleRate
  case formatUnavailable
  case converterUnavailable
  case bufferUnavailable
  case conversionFailed
}

public final class AVAudioPcm16MonoConverter: @unchecked Sendable {
  private let outputSampleRate: Double
  private var sourceSampleRate: Double?
  private var converter: AVAudioConverter?

  public init(outputSampleRate: Double) throws {
    guard outputSampleRate.isFinite, outputSampleRate > 0 else {
      throw AVAudioPcmConverterError.invalidSampleRate
    }
    self.outputSampleRate = outputSampleRate
  }

  public func reset() {
    converter?.reset()
    converter = nil
    sourceSampleRate = nil
  }

  public func convert(samples: [Int16], sampleRate: Double) throws -> [Int16] {
    guard sampleRate.isFinite, sampleRate > 0 else {
      throw AVAudioPcmConverterError.invalidSampleRate
    }
    guard !samples.isEmpty else { return [] }

    let inputFormat = try requireFormat(sampleRate: sampleRate)
    let outputFormat = try requireFormat(sampleRate: outputSampleRate)
    let converter = try requireConverter(inputFormat: inputFormat, outputFormat: outputFormat)
    guard
      let input = AVAudioPCMBuffer(
        pcmFormat: inputFormat, frameCapacity: AVAudioFrameCount(samples.count)),
      let inputData = input.int16ChannelData?.pointee
    else {
      throw AVAudioPcmConverterError.bufferUnavailable
    }
    input.frameLength = AVAudioFrameCount(samples.count)
    inputData.update(from: samples, count: samples.count)

    let capacity = AVAudioFrameCount(
      ceil((Double(samples.count) * outputSampleRate) / sampleRate) + 64)
    guard
      let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity),
      let outputData = output.int16ChannelData?.pointee
    else {
      throw AVAudioPcmConverterError.bufferUnavailable
    }
    let inputSupply = InputSupply()
    var conversionError: NSError?
    let status = converter.convert(to: output, error: &conversionError) { _, status in
      guard inputSupply.take() else {
        status.pointee = .noDataNow
        return nil
      }
      status.pointee = .haveData
      return input
    }
    guard status != .error, conversionError == nil else {
      throw AVAudioPcmConverterError.conversionFailed
    }
    return Array(UnsafeBufferPointer(start: outputData, count: Int(output.frameLength)))
  }

  public func finish() throws -> [Int16] {
    guard let converter else { return [] }
    let outputFormat = try requireFormat(sampleRate: outputSampleRate)
    guard
      let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: 4_096),
      let outputData = output.int16ChannelData?.pointee
    else {
      throw AVAudioPcmConverterError.bufferUnavailable
    }
    var conversionError: NSError?
    let status = converter.convert(to: output, error: &conversionError) { _, status in
      status.pointee = .endOfStream
      return nil
    }
    guard status != .error, conversionError == nil else {
      throw AVAudioPcmConverterError.conversionFailed
    }
    return Array(UnsafeBufferPointer(start: outputData, count: Int(output.frameLength)))
  }

  private func requireConverter(
    inputFormat: AVAudioFormat,
    outputFormat: AVAudioFormat
  ) throws -> AVAudioConverter {
    if sourceSampleRate != inputFormat.sampleRate {
      converter = AVAudioConverter(from: inputFormat, to: outputFormat)
      sourceSampleRate = inputFormat.sampleRate
    }
    guard let converter else { throw AVAudioPcmConverterError.converterUnavailable }
    return converter
  }

  private func requireFormat(sampleRate: Double) throws -> AVAudioFormat {
    guard
      let format = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: sampleRate,
        channels: 1,
        interleaved: false)
    else {
      throw AVAudioPcmConverterError.formatUnavailable
    }
    return format
  }
}

private final class InputSupply: @unchecked Sendable {
  private let lock = NSLock()
  private var available = true

  func take() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard available else { return false }
    available = false
    return true
  }
}

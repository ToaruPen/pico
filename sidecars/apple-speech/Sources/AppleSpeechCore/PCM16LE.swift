import AVFoundation
import Foundation

public enum PCM16LE {
  public static func durationMilliseconds(forByteCount byteCount: Int) throws -> Double {
    guard
      byteCount > 0,
      byteCount.isMultiple(of: MemoryLayout<Int16>.size),
      byteCount <= WireContract.maximumDecodedAudioBytes
    else {
      throw SidecarServiceError.invalidRequest
    }

    return try streamingDurationMilliseconds(forByteCount: Int64(byteCount))
  }

  public static func streamingDurationMilliseconds(forByteCount byteCount: Int64) throws -> Double {
    guard
      byteCount > 0,
      byteCount.isMultiple(of: Int64(MemoryLayout<Int16>.size))
    else {
      throw SidecarServiceError.invalidRequest
    }

    let sampleCount = byteCount / Int64(MemoryLayout<Int16>.size)
    let duration = Double(sampleCount) * 1_000 / Double(AppleSpeechConstants.sampleRateHz)
    guard duration.isFinite else {
      throw SidecarServiceError.backendError
    }
    return duration
  }

  public static func makeBuffer(from data: Data) throws -> AVAudioPCMBuffer {
    let sampleCount = data.count / MemoryLayout<Int16>.size
    _ = try durationMilliseconds(forByteCount: data.count)

    guard
      let buffer = AVAudioPCMBuffer(
        pcmFormat: try makeFormat(),
        frameCapacity: AVAudioFrameCount(sampleCount)
      ),
      let samples = buffer.int16ChannelData?[0]
    else {
      throw SidecarServiceError.backendError
    }

    for sampleIndex in 0..<sampleCount {
      let byteIndex = data.startIndex + sampleIndex * MemoryLayout<Int16>.size
      let low = UInt16(data[byteIndex])
      let high = UInt16(data[byteIndex + 1]) << 8
      samples[sampleIndex] = Int16(bitPattern: low | high)
    }
    buffer.frameLength = AVAudioFrameCount(sampleCount)
    return buffer
  }

  static func makeFormat() throws -> AVAudioFormat {
    guard
      let format = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: Double(AppleSpeechConstants.sampleRateHz),
        channels: AVAudioChannelCount(AppleSpeechConstants.channels),
        interleaved: false
      )
    else {
      throw SidecarServiceError.backendError
    }
    return format
  }
}

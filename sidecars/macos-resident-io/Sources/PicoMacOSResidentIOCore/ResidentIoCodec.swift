import Foundation

public enum ResidentIoCodecError: Error, Equatable, Sendable {
  case invalidMagic
  case unsupportedVersion(UInt8)
  case unknownKind(UInt8)
  case metadataTooLarge(UInt32)
  case payloadTooLarge(UInt32)
  case unexpectedPayload(ResidentIoMessageKind)
  case missingPayload(ResidentIoMessageKind)
  case invalidPcmPayloadLength(expected: Int, actual: Int)
  case invalidMetadata(ResidentIoMessageKind)
}

public enum ResidentIoCodec {
  public static let headerByteCount = 16
  public static let maximumMetadataBytes: UInt32 = 16_384
  public static let maximumPayloadBytes: UInt32 = 1_048_576
  static let magic = Data([0x50, 0x49, 0x43, 0x4F])
  static let version: UInt8 = 1

  public static func encode(_ message: ResidentIoMessage) throws -> Data {
    let metadata = try encodeMetadata(message)
    let payload: Data
    if case .pcmFrame(_, let bytes) = message {
      payload = bytes
    } else {
      payload = Data()
    }
    if case .pcmFrame(let metadata, _) = message {
      try validatePcmPayload(metadata: metadata, payload: payload)
    }
    guard metadata.count <= Int(maximumMetadataBytes) else {
      throw ResidentIoCodecError.metadataTooLarge(UInt32(metadata.count))
    }
    guard payload.count <= Int(maximumPayloadBytes) else {
      throw ResidentIoCodecError.payloadTooLarge(UInt32(payload.count))
    }

    var frame = Data()
    frame.reserveCapacity(headerByteCount + metadata.count + payload.count)
    frame.append(magic)
    frame.append(version)
    frame.append(message.kind.rawValue)
    frame.append(contentsOf: [0, 0])
    frame.appendUInt32(UInt32(metadata.count))
    frame.appendUInt32(UInt32(payload.count))
    frame.append(metadata)
    frame.append(payload)
    return frame
  }

  fileprivate static func decode(
    kind: ResidentIoMessageKind,
    metadata: Data,
    payload: Data
  ) throws -> ResidentIoMessage {
    if kind != .pcmFrame, !payload.isEmpty {
      throw ResidentIoCodecError.unexpectedPayload(kind)
    }
    if kind == .pcmFrame, payload.isEmpty {
      throw ResidentIoCodecError.missingPayload(kind)
    }

    do {
      switch kind {
      case .ready:
        return .ready(try decodeMetadata(ReadyMetadata.self, from: metadata))
      case .controlEvent:
        return .controlEvent(try decodeMetadata(ControlEventMetadata.self, from: metadata))
      case .controlResult:
        return .controlResult(try decodeMetadata(ControlResultMetadata.self, from: metadata))
      case .pcmFrame:
        let value = try decodeMetadata(PcmFrameMetadata.self, from: metadata)
        try validatePcmPayload(metadata: value, payload: payload)
        return .pcmFrame(value, payload)
      case .tailComplete:
        return .tailComplete(try decodeMetadata(TailCompleteMetadata.self, from: metadata))
      case .suppressCapture:
        return .suppressCapture(try decodeMetadata(CaptureBoundaryMetadata.self, from: metadata))
      case .resumeCapture:
        return .resumeCapture(try decodeMetadata(CaptureBoundaryMetadata.self, from: metadata))
      case .cancelGeneration:
        return .cancelGeneration(
          try decodeMetadata(CancelGenerationMetadata.self, from: metadata))
      case .healthEvent:
        return .healthEvent(try decodeMetadata(HealthEventMetadata.self, from: metadata))
      case .fatal:
        return .fatal(try decodeMetadata(FatalMetadata.self, from: metadata))
      case .shutdown:
        guard metadata.isEmpty else { throw ResidentIoCodecError.invalidMetadata(kind) }
        return .shutdown
      case .timingEvent:
        return .timingEvent(try decodeMetadata(TimingEventMetadata.self, from: metadata))
      }
    } catch let error as ResidentIoCodecError {
      throw error
    } catch {
      throw ResidentIoCodecError.invalidMetadata(kind)
    }
  }

  private static func encodeMetadata(_ message: ResidentIoMessage) throws -> Data {
    switch message {
    case .ready(let value): try encoder.encode(value)
    case .controlEvent(let value): try encoder.encode(value)
    case .controlResult(let value): try encoder.encode(value)
    case .pcmFrame(let value, _): try encoder.encode(value)
    case .tailComplete(let value): try encoder.encode(value)
    case .suppressCapture(let value): try encoder.encode(value)
    case .resumeCapture(let value): try encoder.encode(value)
    case .cancelGeneration(let value): try encoder.encode(value)
    case .healthEvent(let value): try encoder.encode(value)
    case .fatal(let value): try encoder.encode(value)
    case .shutdown: Data()
    case .timingEvent(let value): try encoder.encode(value)
    }
  }

  private static func decodeMetadata<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
    try decoder.decode(type, from: data)
  }

  private static func validatePcmPayload(metadata: PcmFrameMetadata, payload: Data) throws {
    let expected = Int(metadata.frameCount) * Int(metadata.channels) * 2
    guard payload.count == expected else {
      throw ResidentIoCodecError.invalidPcmPayloadLength(expected: expected, actual: payload.count)
    }
  }

  private static var encoder: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.keyEncodingStrategy = .convertToSnakeCase
    encoder.outputFormatting = [.sortedKeys]
    return encoder
  }

  private static var decoder: JSONDecoder {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    return decoder
  }
}

public struct ResidentIoDecoder: Sendable {
  private var buffer = Data()

  public init() {}

  public mutating func append<Bytes: DataProtocol>(_ bytes: Bytes) throws {
    buffer.append(contentsOf: bytes)
    try validateBufferedHeader()
  }

  public mutating func next() throws -> ResidentIoMessage? {
    guard buffer.count >= ResidentIoCodec.headerByteCount else { return nil }
    let header = try decodeHeader(buffer.prefix(ResidentIoCodec.headerByteCount))
    let total =
      ResidentIoCodec.headerByteCount + Int(header.metadataLength) + Int(header.payloadLength)
    guard buffer.count >= total else { return nil }
    let metadataStart = ResidentIoCodec.headerByteCount
    let payloadStart = metadataStart + Int(header.metadataLength)
    let metadata = Data(buffer[metadataStart..<payloadStart])
    let payload = Data(buffer[payloadStart..<total])
    buffer = Data(buffer.dropFirst(total))
    return try ResidentIoCodec.decode(kind: header.kind, metadata: metadata, payload: payload)
  }

  private func validateBufferedHeader() throws {
    guard buffer.count >= ResidentIoCodec.headerByteCount else { return }
    _ = try decodeHeader(buffer.prefix(ResidentIoCodec.headerByteCount))
  }
}

private struct DecodedHeader {
  let kind: ResidentIoMessageKind
  let metadataLength: UInt32
  let payloadLength: UInt32
}

private func decodeHeader(_ bytes: Data.SubSequence) throws -> DecodedHeader {
  guard Data(bytes.prefix(4)) == ResidentIoCodec.magic else {
    throw ResidentIoCodecError.invalidMagic
  }
  let version = bytes[bytes.startIndex + 4]
  guard version == ResidentIoCodec.version else {
    throw ResidentIoCodecError.unsupportedVersion(version)
  }
  let rawKind = bytes[bytes.startIndex + 5]
  guard let kind = ResidentIoMessageKind(rawValue: rawKind) else {
    throw ResidentIoCodecError.unknownKind(rawKind)
  }
  let metadataLength = bytes.readUInt32(at: bytes.startIndex + 8)
  let payloadLength = bytes.readUInt32(at: bytes.startIndex + 12)
  guard metadataLength <= ResidentIoCodec.maximumMetadataBytes else {
    throw ResidentIoCodecError.metadataTooLarge(metadataLength)
  }
  guard payloadLength <= ResidentIoCodec.maximumPayloadBytes else {
    throw ResidentIoCodecError.payloadTooLarge(payloadLength)
  }
  return DecodedHeader(kind: kind, metadataLength: metadataLength, payloadLength: payloadLength)
}

extension Data {
  fileprivate mutating func appendUInt32(_ value: UInt32) {
    append(UInt8((value >> 24) & 0xFF))
    append(UInt8((value >> 16) & 0xFF))
    append(UInt8((value >> 8) & 0xFF))
    append(UInt8(value & 0xFF))
  }
}

extension Data.SubSequence {
  fileprivate func readUInt32(at index: Index) -> UInt32 {
    (UInt32(self[index]) << 24)
      | (UInt32(self[index + 1]) << 16)
      | (UInt32(self[index + 2]) << 8)
      | UInt32(self[index + 3])
  }
}

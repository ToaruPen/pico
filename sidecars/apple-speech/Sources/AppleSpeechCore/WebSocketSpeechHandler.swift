import FlyingFox
import Foundation

public actor StreamingSessionRegistry {
  private var nextIdentifier: UInt64 = 1
  private var sessions: [UInt64: any StreamingSessionCancelling] = [:]

  public init() {}

  fileprivate func register(_ session: any StreamingSessionCancelling) -> UInt64 {
    let identifier = nextIdentifier
    nextIdentifier &+= 1
    if nextIdentifier == 0 {
      nextIdentifier = 1
    }
    sessions[identifier] = session
    return identifier
  }

  func unregister(_ identifier: UInt64) {
    sessions.removeValue(forKey: identifier)
  }

  public func cancelAll() async {
    let active = sessions.values
    sessions.removeAll()
    for session in active {
      await session.cancelForShutdown()
    }
  }
}

public struct WebSocketSpeechHandler: WSHandler {
  private let service: any AppleSpeechStreamingServing
  private let admission: TranscriptionAdmission
  private let registry: StreamingSessionRegistry
  private let inactivityTimeout: Duration

  public init(
    service: any AppleSpeechStreamingServing,
    admission: TranscriptionAdmission,
    registry: StreamingSessionRegistry,
    inactivityTimeout: Duration = .seconds(10)
  ) {
    self.service = service
    self.admission = admission
    self.registry = registry
    self.inactivityTimeout = inactivityTimeout
  }

  public func makeFrames(
    for client: AsyncThrowingStream<WSFrame, any Error>
  ) async throws -> AsyncStream<WSFrame> {
    let coordinator = StreamingSessionCoordinator(
      service: service,
      admission: admission,
      registry: registry,
      inactivityTimeout: inactivityTimeout
    )

    return AsyncStream { continuation in
      let reader = Task {
        let identifier = await registry.register(coordinator)
        await coordinator.attach(output: continuation, registryIdentifier: identifier)
        var assembler = WebSocketFrameAssembler()
        do {
          for try await frame in client {
            guard let message = try assembler.accept(frame) else { continue }
            await coordinator.receive(message)
          }
          await coordinator.disconnect()
        } catch is CancellationError {
          await coordinator.disconnect()
        } catch {
          await coordinator.fail(.invalidRequest)
        }
      }
      continuation.onTermination = { @Sendable _ in
        reader.cancel()
        Task { await coordinator.disconnect() }
      }
    }
  }
}

private protocol StreamingSessionCancelling: Sendable {
  func cancelForShutdown() async
}

private actor StreamingSessionCoordinator: StreamingSessionCancelling {
  private let service: any AppleSpeechStreamingServing
  private let admission: TranscriptionAdmission
  private let registry: StreamingSessionRegistry
  private let inactivityTimeout: Duration

  private var output: AsyncStream<WSFrame>.Continuation?
  private var registryIdentifier: UInt64?
  private var lease: TranscriptionLease?
  private var session: (any AppleSpeechStreamingSession)?
  private var acceptedBinaryMessages = 0
  private var phase = Phase.awaitingStart
  private var inactivityTask: Task<Void, Never>?
  private var preparationTask: Task<Void, Never>?

  init(
    service: any AppleSpeechStreamingServing,
    admission: TranscriptionAdmission,
    registry: StreamingSessionRegistry,
    inactivityTimeout: Duration
  ) {
    self.service = service
    self.admission = admission
    self.registry = registry
    self.inactivityTimeout = inactivityTimeout
  }

  func attach(
    output: AsyncStream<WSFrame>.Continuation,
    registryIdentifier: UInt64
  ) {
    self.output = output
    self.registryIdentifier = registryIdentifier
    resetInactivityTimer()
  }

  func receive(_ message: WebSocketClientMessage) async {
    guard phase != .terminal else { return }

    switch message {
    case .text(let data):
      await receiveText(data)
    case .binary(let data):
      await receiveBinary(data)
    case .ping(let data):
      output?.yield(WSFrame(fin: true, opcode: .pong, mask: nil, payload: data))
    case .pong:
      break
    case .close:
      await disconnect()
    }
  }

  func fail(_ error: SidecarServiceError) async {
    await terminate(error: error, emitFailure: true)
  }

  func disconnect() async {
    await terminate(error: nil, emitFailure: false)
  }

  func cancelForShutdown() async {
    await disconnect()
  }

  private func receiveText(_ data: Data) async {
    let message: StreamingClientMessage
    do {
      message = try StreamingWireContract.decodeClientText(data)
    } catch {
      await fail(.invalidRequest)
      return
    }

    switch (phase, message) {
    case (.awaitingStart, .start(let start)):
      await startSession(start)
    case (.streaming, .finish):
      guard acceptedBinaryMessages > 0, let session else {
        await fail(.invalidRequest)
        return
      }
      phase = .finalizing
      inactivityTask?.cancel()
      inactivityTask = nil
      Task {
        do {
          let result = try await session.finish()
          await self.complete(result)
        } catch is CancellationError {
          await self.disconnect()
        } catch let error as SidecarServiceError {
          await self.fail(error)
        } catch {
          await self.fail(.backendError)
        }
      }
    default:
      await fail(.invalidRequest)
    }
  }

  private func startSession(_ start: StreamingStartMessage) async {
    guard let acquiredLease = await admission.acquire() else {
      await fail(.busy)
      return
    }
    guard phase == .awaitingStart else {
      await admission.release(acquiredLease)
      return
    }
    lease = acquiredLease
    phase = .preparing
    resetInactivityTimer()
    let service = service
    preparationTask = Task {
      do {
        let prepared = try await service.makeStreamingSession(
          timeoutMilliseconds: start.timeoutMilliseconds
        )
        await self.completePreparation(prepared, lease: acquiredLease)
      } catch is CancellationError {
        await self.disconnect()
      } catch let error as SidecarServiceError {
        await self.fail(error)
      } catch {
        await self.fail(.backendError)
      }
    }
  }

  private func completePreparation(
    _ prepared: any AppleSpeechStreamingSession,
    lease preparedLease: TranscriptionLease
  ) async {
    guard phase == .preparing, lease == preparedLease else {
      await prepared.cancel()
      return
    }
    preparationTask = nil
    session = prepared
    phase = .streaming
    resetInactivityTimer()
    do {
      let result = output?.yield(textFrame(try StreamingWireContract.encodeReady()))
      if case .terminated? = result {
        await disconnect()
      }
    } catch {
      await fail(.backendError)
    }
  }

  private func receiveBinary(_ data: Data) async {
    guard phase == .streaming, let session else {
      await fail(.invalidRequest)
      return
    }
    do {
      try StreamingWireContract.validateBinary(data)
      try await session.send(data)
      guard phase == .streaming else { return }
      acceptedBinaryMessages += 1
      resetInactivityTimer()
    } catch let error as SidecarServiceError {
      await fail(error)
    } catch {
      await fail(.backendError)
    }
  }

  private func resetInactivityTimer() {
    inactivityTask?.cancel()
    let timeout = inactivityTimeout
    inactivityTask = Task {
      do {
        try await Task.sleep(for: timeout)
        await self.fail(.timeout)
      } catch is CancellationError {
      } catch {
        await self.fail(.backendError)
      }
    }
  }

  private func complete(_ result: TranscriptionResult) async {
    guard phase == .finalizing else { return }
    phase = .terminal
    inactivityTask?.cancel()
    inactivityTask = nil
    await releaseOwnership(cancelSession: false)
    do {
      output?.yield(textFrame(try StreamingWireContract.encodeCompleted(result)))
      output?.yield(.close(code: .normalClosure))
    } catch {
      output?.yield(.close(code: .internalServerError))
    }
    output?.finish()
    output = nil
  }

  private func terminate(
    error: SidecarServiceError?,
    emitFailure: Bool
  ) async {
    guard phase != .terminal else { return }
    phase = .terminal
    inactivityTask?.cancel()
    inactivityTask = nil
    await releaseOwnership(cancelSession: true)

    if emitFailure, let error, let payload = try? StreamingWireContract.encodeFailed(error) {
      output?.yield(textFrame(payload))
      output?.yield(.close(code: closeCode(for: error)))
    }
    output?.finish()
    output = nil
  }

  private func releaseOwnership(cancelSession: Bool) async {
    preparationTask?.cancel()
    preparationTask = nil
    if cancelSession, let session {
      await session.cancel()
    }
    session = nil
    if let lease {
      await admission.release(lease)
      self.lease = nil
    }
    if let registryIdentifier {
      await registry.unregister(registryIdentifier)
      self.registryIdentifier = nil
    }
  }

  private func textFrame(_ data: Data) -> WSFrame {
    WSFrame(fin: true, opcode: .text, mask: nil, payload: data)
  }

  private func closeCode(for error: SidecarServiceError) -> WSCloseCode {
    switch error {
    case .invalidRequest:
      .protocolError
    case .busy:
      .tryAgainLater
    case .inputOverflow:
      .messageTooBig
    case .timeout, .modelLoad, .backendError:
      .internalServerError
    }
  }

  private enum Phase {
    case awaitingStart
    case preparing
    case streaming
    case finalizing
    case terminal
  }
}

private enum WebSocketClientMessage {
  case text(Data)
  case binary(Data)
  case ping(Data)
  case pong
  case close
}

private struct WebSocketFrameAssembler {
  private static let maximumTextBytes = 4 * 1_024

  private var fragmentedOpcode: WSFrame.Opcode?
  private var fragmentedPayload = Data()

  mutating func accept(_ frame: WSFrame) throws -> WebSocketClientMessage? {
    guard !frame.rsv1, !frame.rsv2, !frame.rsv3 else {
      throw SidecarServiceError.invalidRequest
    }

    switch frame.opcode {
    case .ping:
      guard frame.fin, frame.payload.count <= 125 else {
        throw SidecarServiceError.invalidRequest
      }
      return .ping(frame.payload)
    case .pong:
      guard frame.fin, frame.payload.count <= 125 else {
        throw SidecarServiceError.invalidRequest
      }
      return .pong
    case .close:
      guard frame.fin, frame.payload.count <= 125 else {
        throw SidecarServiceError.invalidRequest
      }
      return .close
    case .text, .binary:
      guard fragmentedOpcode == nil else {
        throw SidecarServiceError.invalidRequest
      }
      if frame.fin {
        return try makeMessage(opcode: frame.opcode, payload: frame.payload)
      }
      fragmentedOpcode = frame.opcode
      fragmentedPayload = frame.payload
      try validateAccumulatedSize()
      return nil
    case .continuation:
      guard let fragmentedOpcode else {
        throw SidecarServiceError.invalidRequest
      }
      self.fragmentedPayload.append(frame.payload)
      try validateAccumulatedSize()
      guard frame.fin else { return nil }
      let payload = fragmentedPayload
      self.fragmentedOpcode = nil
      fragmentedPayload.removeAll(keepingCapacity: false)
      return try makeMessage(opcode: fragmentedOpcode, payload: payload)
    default:
      throw SidecarServiceError.invalidRequest
    }
  }

  private func validateAccumulatedSize() throws {
    let maximum =
      fragmentedOpcode == .binary
      ? StreamingWireContract.maximumBinaryMessageBytes : Self.maximumTextBytes
    guard fragmentedPayload.count <= maximum else {
      throw SidecarServiceError.invalidRequest
    }
  }

  private func makeMessage(
    opcode: WSFrame.Opcode,
    payload: Data
  ) throws -> WebSocketClientMessage {
    switch opcode {
    case .text:
      guard
        payload.count <= Self.maximumTextBytes,
        String(data: payload, encoding: .utf8) != nil
      else {
        throw SidecarServiceError.invalidRequest
      }
      return .text(payload)
    case .binary:
      guard payload.count <= StreamingWireContract.maximumBinaryMessageBytes else {
        throw SidecarServiceError.invalidRequest
      }
      return .binary(payload)
    default:
      throw SidecarServiceError.invalidRequest
    }
  }
}

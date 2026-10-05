import Darwin
import Foundation

@MainActor public protocol BridgeTransport: AnyObject {
  var onData: ((Data) -> Void)? { get set }
  var onEnd: (() -> Void)? { get set }
  func write(_ data: Data) throws
  func close()
}

@MainActor public protocol BridgeScheduling {
  func after(_ seconds: TimeInterval, _ action: @escaping @MainActor () -> Void) -> () -> Void
}

@MainActor public protocol ControllerConnection: AnyObject {
  var onEvent: ((JSONValue) -> Void)? { get set }
  var onClosed: (() -> Void)? { get set }
  var isReady: Bool { get }
  func connect(_ completion: @escaping (Result<JSONValue, BridgeFailure>) -> Void)
  func request(
    _ command: String, args: JSONValue?,
    completion: @escaping (Result<JSONValue, BridgeFailure>) -> Void)
  func close()
}

@MainActor public final class BridgeClient: ControllerConnection {
  public var onEvent: ((JSONValue) -> Void)?
  public var onClosed: (() -> Void)?
  public private(set) var isReady = false
  private let transport: any BridgeTransport
  private let clock: any BridgeScheduling
  private var framer = LineFramer()
  private var nextID: UInt64 = 1
  private var ended = false
  private var flowID: String?
  private var challenge: String?
  private struct Pending {
    let id: UInt64
    let command: String
    let mutation: Bool
    let completion: (Result<JSONValue, BridgeFailure>) -> Void
  }
  private var pending: Pending?
  private var cancelDeadline: (() -> Void)?
  public init(transport: any BridgeTransport, clock: any BridgeScheduling) {
    self.transport = transport
    self.clock = clock
    transport.onData = { [weak self] in self?.receive($0) }
    transport.onEnd = { [weak self] in self?.terminate(.unavailable) }
  }
  public func connect(_ completion: @escaping (Result<JSONValue, BridgeFailure>) -> Void) {
    guard !ended, nextID == 1 else {
      completion(.failure(.unavailable))
      return
    }
    request("hello", completion: completion)
  }
  public func request(
    _ command: String, args: JSONValue? = nil,
    completion: @escaping (Result<JSONValue, BridgeFailure>) -> Void
  ) {
    guard !ended else {
      completion(.failure(.unavailable))
      return
    }
    guard pending == nil else {
      completion(.failure(.busy))
      return
    }
    guard isReady || (command == "hello" && nextID == 1) else {
      completion(.failure(.handshakeRequired))
      return
    }
    guard nextID <= Wire.maxID, !(isReady && command == "hello") else {
      terminate(.badRequest)
      completion(.failure(.badRequest))
      return
    }
    var fields: [String: JSONValue] = [
      "v": .number(1), "id": .number(Double(nextID)), "cmd": .string(command),
    ]
    if let args { fields["args"] = args }
    let value = JSONValue.object(fields)
    guard Wire.valid(value, kind: "request"), let encoded = try? JSONEncoder().encode(value),
      encoded.count <= LineFramer.lineLimit
    else {
      completion(.failure(.badRequest))
      return
    }
    pending = Pending(id: nextID, command: command, mutation: args != nil, completion: completion)
    nextID += 1
    let lifecycle =
      command.hasPrefix("service.") || command.hasPrefix("desktop.")
      || command.hasPrefix("ownership.")
    cancelDeadline = clock.after(lifecycle ? 60 : 5) { [weak self] in
      self?.terminate(.timeout)
    }
    do { try transport.write(encoded + Data([10])) } catch { terminate(.unavailable) }
  }
  public func close() { terminate(.unavailable) }
  private func terminate(_ reason: BridgeFailure) {
    guard !ended else { return }
    ended = true
    isReady = false
    flowID = nil
    challenge = nil
    cancelDeadline?()
    cancelDeadline = nil
    let request = pending
    pending = nil
    transport.onData = nil
    transport.onEnd = nil
    transport.close()
    request?.completion(.failure(request?.mutation == true ? .deliveryUnknown : reason))
    onClosed?()
  }
  private func receive(_ bytes: Data) {
    guard !ended else { return }
    do {
      for line in try framer.append(bytes) {
        guard !ended else { return }
        let value = try Wire.parse(line)
        if value.object?["event"] != nil {
          guard isReady, Wire.valid(value, kind: "event"), let flowID,
            value["flowId"].string == flowID
          else { throw BridgeFailure.badRequest }
          if value["event"] == .string("pairing.request") {
            guard challenge == nil else { throw BridgeFailure.badRequest }
            challenge = value["challengeId"].string
          } else {
            self.flowID = nil
            challenge = nil
          }
          onEvent?(value)
          continue
        }
        guard let request = pending, value["id"] == .number(Double(request.id)),
          Wire.valid(value, kind: "response", command: request.command)
        else { throw BridgeFailure.badRequest }
        cancelDeadline?()
        cancelDeadline = nil
        pending = nil
        if value["ok"] == .bool(true) {
          if request.command == "hello" { isReady = true }
          if request.command == "pairing.open" {
            flowID = value["data"]["flowId"].string
            challenge = nil
          }
          if request.command == "pairing.confirm" { challenge = nil }
          if request.command == "pairing.close" {
            flowID = nil
            challenge = nil
          }
          request.completion(.success(value["data"]))
        } else {
          let error = BridgeFailure(rawValue: value["error"]["code"].string!)!
          request.completion(.failure(error))
          if [.deliveryUnknown, .timeout, .handshakeRequired, .unsupportedVersion].contains(error) {
            terminate(error)
          }
        }
      }
    } catch { terminate(.badRequest) }
  }
}

@MainActor public final class DispatchBridgeClock: BridgeScheduling {
  public init() {}
  public func after(_ seconds: TimeInterval, _ action: @escaping @MainActor () -> Void) -> () ->
    Void
  {
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now() + seconds)
    timer.setEventHandler { MainActor.assumeIsolated { action() } }
    timer.resume()
    return { timer.cancel() }
  }
}

/// Main-queue nonblocking descriptors preserve callback order without spawning a task per byte/event.
/// The OS pipe and one bounded write buffer provide backpressure; stderr is deliberately discarded.
@MainActor public final class ProcessBridgeTransport: BridgeTransport {
  public var onData: ((Data) -> Void)?
  public var onEnd: (() -> Void)?
  private let process: Process
  private let input: Pipe
  private let output: Pipe
  private var reader: (any DispatchSourceRead)?
  private var writer: (any DispatchSourceWrite)?
  private var queued = Data()
  private var closed = false

  public init(plan: LaunchPlan) throws {
    process = Process()
    input = Pipe()
    output = Pipe()
    process.executableURL = URL(fileURLWithPath: plan.executable)
    process.arguments = plan.arguments
    process.environment = plan.environment
    process.currentDirectoryURL = URL(fileURLWithPath: plan.home)
    process.standardInput = input
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    try process.run()
    input.fileHandleForReading.closeFile()
    output.fileHandleForWriting.closeFile()
    let readFD = output.fileHandleForReading.fileDescriptor
    let writeFD = input.fileHandleForWriting.fileDescriptor
    _ = fcntl(readFD, F_SETFL, O_NONBLOCK)
    _ = fcntl(writeFD, F_SETFL, O_NONBLOCK)
    _ = fcntl(writeFD, F_SETNOSIGPIPE, 1)
    let source = DispatchSource.makeReadSource(fileDescriptor: readFD, queue: .main)
    source.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.readAvailable() } }
    source.setCancelHandler { [handle = output.fileHandleForReading] in try? handle.close() }
    reader = source
    source.resume()
  }
  public func write(_ data: Data) throws {
    guard !closed, queued.isEmpty, data.count <= LineFramer.queueLimit else {
      throw BridgeFailure.busy
    }
    queued = data
    flush()
    if closed { throw BridgeFailure.unavailable }
  }
  private func flush() {
    guard !closed else { return }
    while !queued.isEmpty {
      let n = queued.withUnsafeBytes {
        Darwin.write(input.fileHandleForWriting.fileDescriptor, $0.baseAddress, $0.count)
      }
      if n > 0 {
        queued.removeFirst(n)
      } else if n < 0 && errno == EINTR {
        continue
      } else if n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) {
        break
      } else {
        end()
        return
      }
    }
    if queued.isEmpty {
      writer?.cancel()
      writer = nil
    } else if writer == nil {
      let source = DispatchSource.makeWriteSource(
        fileDescriptor: input.fileHandleForWriting.fileDescriptor, queue: .main)
      source.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.flush() } }
      writer = source
      source.resume()
    }
  }
  private func readAvailable() {
    guard !closed else { return }
    var bytes = [UInt8](repeating: 0, count: 16_384)
    for _ in 0..<16 {
      let count = Darwin.read(output.fileHandleForReading.fileDescriptor, &bytes, bytes.count)
      if count > 0 {
        onData?(Data(bytes.prefix(count)))
        if closed { return }
      } else if count < 0 && errno == EINTR {
        continue
      } else if count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) {
        return
      } else {
        end()
        return
      }
    }
  }
  private func end() {
    let callback = onEnd
    close()
    callback?()
  }
  public func close() {
    guard !closed else { return }
    closed = true
    reader?.cancel()
    reader = nil
    writer?.cancel()
    writer = nil
    queued.removeAll()
    try? input.fileHandleForWriting.close()
    // EOF releases this coordinator's control client. It never owns the background service PID.
    if process.isRunning { process.terminate() }
  }
}

import Foundation

@MainActor public protocol PowerClientTransport: AnyObject {
  var onReply: ((Data) -> Void)? { get set }
  var onEnd: (() -> Void)? { get set }
  func write(_ data: Data) throws
  func close()
}

public enum PowerClientFailure: Error, Equatable {
  case unavailable, busy, invalidRequest, invalidReply, timeout, deliveryUnknown
}

@MainActor public protocol PowerHelperConnection: AnyObject {
  func request(
    _ verb: PowerVerb, leaseID: UUID?,
    completion: @escaping (Result<PowerReply, PowerClientFailure>) -> Void)
  func close()
}

/// One bounded request at a time. Losing a mutation reply is ambiguous: close
/// the connection (releasing its lease) and never replay the mutation.
@MainActor public final class PowerClient: PowerHelperConnection {
  private let transport: any PowerClientTransport
  private let clock: any BridgeScheduling
  private var nextID: UInt64 = 1
  private var ended = false
  private var cancelDeadline: (() -> Void)?
  private var pending: (PowerRequest, (Result<PowerReply, PowerClientFailure>) -> Void)?

  public init(transport: any PowerClientTransport, clock: any BridgeScheduling) {
    self.transport = transport
    self.clock = clock
    transport.onReply = { [weak self] in self?.receive($0) }
    transport.onEnd = { [weak self] in self?.terminate(.unavailable) }
  }

  public func request(
    _ verb: PowerVerb, leaseID: UUID? = nil,
    completion: @escaping (Result<PowerReply, PowerClientFailure>) -> Void
  ) {
    send(verb, leaseID: leaseID, holdForRemoval: nil, completion: completion)
  }

  public func prepareRemoval(
    completion: @escaping (Result<PowerReply, PowerClientFailure>) -> Void
  ) {
    send(.recover, leaseID: nil, holdForRemoval: true, completion: completion)
  }

  private func send(
    _ verb: PowerVerb, leaseID: UUID?, holdForRemoval: Bool?,
    completion: @escaping (Result<PowerReply, PowerClientFailure>) -> Void
  ) {
    guard !ended else {
      completion(.failure(.unavailable))
      return
    }
    guard pending == nil else {
      completion(.failure(.busy))
      return
    }
    let request = PowerRequest(
      requestID: nextID, verb: verb, leaseID: leaseID, holdForRemoval: holdForRemoval)
    guard let data = try? JSONEncoder().encode(request),
      (try? PowerRequest.decode(data, after: nextID - 1)) != nil
    else {
      completion(.failure(.invalidRequest))
      return
    }
    nextID += 1
    pending = (request, completion)
    cancelDeadline = clock.after(10) { [weak self] in self?.terminate(.timeout) }
    do { try transport.write(data) } catch { terminate(.unavailable) }
  }

  public func close() { terminate(.unavailable) }

  private func terminate(_ failure: PowerClientFailure) {
    guard !ended else { return }
    ended = true
    cancelDeadline?()
    cancelDeadline = nil
    let outstanding = pending
    pending = nil
    transport.onReply = nil
    transport.onEnd = nil
    transport.close()
    if let (request, completion) = outstanding {
      completion(.failure(request.verb == .status ? failure : .deliveryUnknown))
    }
  }

  private func receive(_ data: Data) {
    guard !ended else { return }
    guard let (request, completion) = pending, data.count <= 8192,
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(object.keys).isSubset(of: ["v", "requestID", "ok", "state", "leaseID", "error"]),
      let reply = try? JSONDecoder().decode(PowerReply.self, from: data),
      reply.v == 1, reply.requestID == request.requestID,
      reply.ok == (reply.error == nil),
      reply.leaseID == nil || reply.state == .active || reply.state == .maintenance,
      !reply.ok || (reply.state != .unavailable && reply.state != .recoveryRequired)
    else {
      terminate(.invalidReply)
      return
    }
    if reply.ok && request.holdForRemoval == true {
      guard reply.state == .maintenance, reply.leaseID != nil else {
        terminate(.invalidReply)
        return
      }
    }
    if reply.ok && (request.verb == .acquire || request.verb == .renew) {
      guard reply.state == .active, reply.leaseID != nil,
        request.verb != .renew || reply.leaseID == request.leaseID
      else {
        terminate(.invalidReply)
        return
      }
    }
    cancelDeadline?()
    cancelDeadline = nil
    pending = nil
    completion(.success(reply))
  }
}

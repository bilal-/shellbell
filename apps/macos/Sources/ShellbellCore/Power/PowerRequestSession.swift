import Foundation

public enum PowerRemoteState: String, Codable, Sendable {
  case idle, active, conflict, recoveryRequired, unavailable, maintenance
}

public struct PowerReply: Codable, Sendable {
  public let v: Int
  public let requestID: UInt64
  public let ok: Bool
  public let state: PowerRemoteState
  public let leaseID: UUID?
  public let error: String?
}

/// One instance per authenticated XPC connection; identity is never decoded from a request.
@MainActor public final class PowerRequestSession {
  private let peer: PowerPeer
  private let engine: PowerLeaseEngine
  private var lastID: UInt64 = 0
  private var closed = false
  public nonisolated init(peer: PowerPeer, engine: PowerLeaseEngine) {
    self.peer = peer
    self.engine = engine
  }

  public func handle(_ bytes: Data) throws -> PowerReply {
    guard !closed else { throw PowerLeaseFailure.unauthorized }
    let request: PowerRequest
    do { request = try PowerRequest.decode(bytes, after: lastID) } catch {
      try? close()
      throw error
    }
    lastID = request.requestID
    var failure: String?
    do {
      switch request.verb {
      case .status: break
      case .acquire: _ = try engine.acquire(peer)
      case .renew: try engine.renew(request.leaseID!, peer: peer)
      case .release: try engine.release(request.leaseID!, peer: peer)
      case .recover:
        if request.holdForRemoval == true {
          _ = try engine.prepareRemoval(peer)
        } else {
          try engine.recover()
        }
      }
    } catch {
      failure = (error as? PowerLeaseFailure)?.rawValue ?? "operationFailed"
    }
    let observed = engine.observation(for: peer)
    // Readback failure cannot turn a successfully delivered operation into a success claim.
    let unhealthy = observed.0 == .unavailable || observed.0 == .recoveryRequired
    return PowerReply(
      v: 1, requestID: request.requestID,
      ok: failure == nil && !unhealthy, state: observed.0, leaseID: observed.1,
      error: failure ?? (unhealthy ? "verificationFailed" : nil))
  }

  public func close() throws {
    closed = true
    // Retry remains possible after failed restoration; no further commands are accepted.
    try engine.disconnected(peer)
  }
}

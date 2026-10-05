import Foundation
import ShellbellCore

/// Production-only identity checks run before connecting. Development builds
/// retain normal idle assertions but cannot talk to the privileged helper.
@MainActor public final class NativePowerClientTransport: PowerClientTransport {
  public var onReply: ((Data) -> Void)?
  public var onEnd: (() -> Void)?
  private let connection: NSXPCConnection
  private let invalidator: PowerConnectionInvalidator
  private var closed = false

  public init() throws {
    let team = try PowerPeerVerifier.currentPublisher(role: .desktop)
    let requirement = try PowerPeerVerifier.requirement(teamID: team, peer: .helper)
    let connection = NSXPCConnection(
      machServiceName: PowerHelperListener.serviceName, options: .privileged)
    self.connection = connection
    invalidator = PowerConnectionInvalidator(connection)
    connection.setCodeSigningRequirement(requirement)
    connection.remoteObjectInterface = NSXPCInterface(with: PowerHelperXPC.self)
    connection.interruptionHandler = { [weak self] in
      Task { @MainActor in self?.end() }
    }
    connection.invalidationHandler = { [weak self] in
      Task { @MainActor in self?.end() }
    }
    connection.resume()
  }

  deinit { invalidator.invalidate() }

  public func write(_ data: Data) throws {
    guard !closed, data.count <= 8192 else { throw PowerClientFailure.unavailable }
    guard
      let proxy = connection.remoteObjectProxyWithErrorHandler({ [weak self] _ in
        Task { @MainActor in self?.end() }
      }) as? PowerHelperXPC
    else { throw PowerClientFailure.unavailable }
    proxy.request(data) { [weak self] response in
      Task { @MainActor in
        guard let self, !self.closed else { return }
        self.onReply?(response)
      }
    }
  }

  public func close() { end() }

  private func end() {
    guard !closed else { return }
    closed = true
    invalidator.invalidate()
    onEnd?()
  }
}

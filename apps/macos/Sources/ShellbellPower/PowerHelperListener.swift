import Foundation
import ShellbellCore

/// Narrow cross-queue operation: XPC invalidation is safe from callback queues.
/// No mutable connection configuration escapes the listener's admission method.
final class PowerConnectionInvalidator: @unchecked Sendable {
  private weak var connection: NSXPCConnection?
  init(_ connection: NSXPCConnection) { self.connection = connection }
  func invalidate() { connection?.invalidate() }
}

/// No development authentication bypass: an unsigned/ad-hoc helper cannot even
/// construct its listener. launchd owns the named Mach service.
public final class PowerHelperListener: NSObject, NSXPCListenerDelegate {
  public static let serviceName = "sh.bilal.shellbell.power"
  private let listener: NSXPCListener
  private let teamID: String
  private let engine: PowerLeaseEngine

  public init(engine: PowerLeaseEngine) throws {
    teamID = try PowerPeerVerifier.currentPublisher(role: .helper)
    self.engine = engine
    listener = NSXPCListener(machServiceName: Self.serviceName)
    super.init()
    listener.delegate = self
  }

  public func resume() { listener.resume() }

  public func listener(
    _ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection
  ) -> Bool {
    guard
      let policy = try? PowerConnectionPolicy(
        teamID: teamID, uid: connection.effectiveUserIdentifier)
    else { return false }
    // Evaluate the actual peer before dispatch; no caller-supplied PID or path.
    connection.setCodeSigningRequirement(policy.requirement)
    let session = PowerRequestSession(peer: policy.peer, engine: engine)
    let invalidator = PowerConnectionInvalidator(connection)
    let exported = PowerXPCExport(session: session) { invalidator.invalidate() }
    connection.exportedInterface = NSXPCInterface(with: PowerHelperXPC.self)
    connection.exportedObject = exported
    connection.interruptionHandler = { [weak exported] in exported?.close() }
    // Retain until invalidation so cleanup survives exportedObject teardown.
    connection.invalidationHandler = { exported.close() }
    connection.resume()
    return true
  }
}

import Foundation
import ShellbellCore

/// Construct using the NSXPCConnection's effective UID, never request data.
public struct PowerConnectionPolicy: Sendable {
  public let requirement: String
  public let peer: PowerPeer
  public init(teamID: String, uid: UInt32) throws {
    guard uid > 0 else { throw PowerLeaseFailure.unauthorized }
    requirement = try PowerPeerVerifier.requirement(teamID: teamID, peer: .desktop)
    peer = PowerPeer(uid: uid, connectionID: UUID())
  }
}

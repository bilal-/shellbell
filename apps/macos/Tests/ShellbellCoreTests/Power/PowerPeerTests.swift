import Foundation
import Security
import XCTest

@testable import ShellbellPower

final class PowerPeerTests: XCTestCase {
  @MainActor func testUnsignedDesktopCannotCreatePrivilegedTransport() {
    XCTAssertThrowsError(try NativePowerClientTransport())
  }

  func testTransportRejectsRootBeforeAuthorizingAnyMessages() throws {
    XCTAssertThrowsError(try PowerConnectionPolicy(teamID: "ABCDE12345", uid: 0))
    let accepted = try PowerConnectionPolicy(teamID: "ABCDE12345", uid: 501)
    XCTAssertEqual(accepted.peer.uid, 501)
    let second = try PowerConnectionPolicy(teamID: "ABCDE12345", uid: 501)
    XCTAssertNotEqual(accepted.peer.connectionID, second.peer.connectionID)
  }
  func testRequirementOnlyAcceptsValidatedPublisherAndFixedPeerRoles() throws {
    for team in ["", "short", "ABCDEFGHIJ\" or true", "abcdefghij", "ABCDEFGHIJK"] {
      XCTAssertThrowsError(try PowerPeerVerifier.requirement(teamID: team, peer: .desktop))
    }
    for role in [PowerPeerVerifier.Role.desktop, .helper] {
      let text = try PowerPeerVerifier.requirement(teamID: "ABCDE12345", peer: role)
      var compiled: SecRequirement?
      XCTAssertEqual(SecRequirementCreateWithString(text as CFString, [], &compiled), errSecSuccess)
      XCTAssertNotNil(compiled)
    }
  }
  func testMissingOrAdHocSigningEvidenceCannotSupplyHelperAuthority() {
    for info: [String: Any] in [
      [:],
      [kSecCodeInfoTeamIdentifier as String: "ABCDE12345", kSecCodeInfoFlags as String: 2],
      [kSecCodeInfoTeamIdentifier as String: "ABCDE12345"],
      [kSecCodeInfoTeamIdentifier as String: "bad", kSecCodeInfoFlags as String: 0],
    ] {
      XCTAssertThrowsError(try PowerPeerVerifier.publisher(from: info))
    }
  }
}

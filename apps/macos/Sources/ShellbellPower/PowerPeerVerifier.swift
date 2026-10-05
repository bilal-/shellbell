import Foundation
import Security

public enum PowerPeerVerifier {
  public enum Role: Sendable { case desktop, helper }
  public enum Failure: Error { case invalidPublisher, invalidSignature }

  public static func requirement(teamID: String, peer: Role) throws -> String {
    guard teamID.utf8.count == 10,
      teamID.utf8.allSatisfy({ (65...90).contains($0) || (48...57).contains($0) })
    else { throw Failure.invalidPublisher }
    let identifier =
      peer == .desktop ? "sh.bilal.shellbell.host" : "sh.bilal.shellbell.power"
    // Runtime enforcement binds this requirement to each actual XPC peer.
    return
      "anchor apple generic and identifier \"\(identifier)\" and certificate leaf[subject.OU] = \"\(teamID)\""
  }

  static func publisher(from information: [String: Any]) throws -> String {
    guard let flags = information[kSecCodeInfoFlags as String] as? NSNumber,
      flags.uint32Value & 2 == 0,  // CS_ADHOC: ad-hoc signing conveys no publisher identity.
      let team = information[kSecCodeInfoTeamIdentifier as String] as? String
    else { throw Failure.invalidPublisher }
    _ = try requirement(teamID: team, peer: .desktop)
    return team
  }

  /// Extract only our own validated signature. No peer-supplied team or PID enters here.
  public static func currentPublisher(role: Role) throws -> String {
    var code: SecCode?
    guard SecCodeCopySelf([], &code) == errSecSuccess, let code else {
      throw Failure.invalidSignature
    }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else {
      throw Failure.invalidSignature
    }
    var information: CFDictionary?
    guard
      SecCodeCopySigningInformation(
        staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
      let dictionary = information as? [String: Any]
    else { throw Failure.invalidSignature }
    let team = try publisher(from: dictionary)
    let text = try requirement(teamID: team, peer: role)
    var requirement: SecRequirement?
    guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess,
      let requirement, SecCodeCheckValidity(code, [], requirement) == errSecSuccess
    else { throw Failure.invalidSignature }
    return team
  }
}

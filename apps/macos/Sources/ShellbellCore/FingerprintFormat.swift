import Foundation

/// Groups of four, matching `formatFingerprint` in the protocol package and the phone's waiting
/// screen, so the owner compares the same text on both devices.
public func formatFingerprint(_ fingerprint: String) -> String {
  var groups: [Substring] = []
  var rest = Substring(fingerprint)
  while !rest.isEmpty {
    groups.append(rest.prefix(4))
    rest = rest.dropFirst(4)
  }
  return groups.joined(separator: " ")
}

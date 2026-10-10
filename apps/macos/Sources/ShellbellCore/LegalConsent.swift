import Foundation

public struct LegalConsent {
  public static let termsVersion = "2026-10-09"
  public static let termsURL = URL(
    string: "https://github.com/bilal-/shellbell/blob/main/legal/terms/\(termsVersion).md")!
  public static let privacyURL = URL(
    string: "https://github.com/bilal-/shellbell/blob/main/PRIVACY.md")!
  private let defaults: UserDefaults
  private let termsKey = "shellbell.terms.v1"
  private let relaysKey = "shellbell.relay-consent.v1"
  private let relayNoticeVersion = 1

  public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

  public var hasAcceptedTerms: Bool {
    let saved = defaults.dictionary(forKey: termsKey)
    return saved?["version"] as? String == Self.termsVersion
      && saved?["acceptedAt"] is Date
  }

  public func acceptTerms() {
    defaults.set(["version": Self.termsVersion, "acceptedAt": Date()], forKey: termsKey)
  }

  public static func relayOrigin(_ value: String) -> String? {
    guard var url = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)),
      let scheme = url.scheme?.lowercased(), ["ws", "wss"].contains(scheme),
      let host = url.host?.lowercased(), !host.isEmpty,
      url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
      url.path.isEmpty || url.path == "/"
    else { return nil }
    url.scheme = scheme
    url.host = host
    url.path = ""
    if url.port == (scheme == "wss" ? 443 : 80) { url.port = nil }
    return url.string
  }

  private var acceptedRelays: [String] {
    let saved = defaults.dictionary(forKey: relaysKey)
    guard saved?["version"] as? Int == relayNoticeVersion else { return [] }
    return saved?["origins"] as? [String] ?? []
  }

  public func hasAcceptedRelay(_ value: String) -> Bool {
    guard let origin = Self.relayOrigin(value) else { return false }
    return acceptedRelays.contains(origin)
  }

  public func acceptRelay(_ value: String) {
    guard let origin = Self.relayOrigin(value) else { return }
    let origins = Array((acceptedRelays.filter { $0 != origin } + [origin]).suffix(64))
    defaults.set(["version": relayNoticeVersion, "origins": origins], forKey: relaysKey)
  }
}

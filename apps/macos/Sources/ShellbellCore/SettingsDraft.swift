import Foundation

/// Values and the revision they were loaded from always travel together.
public struct SettingsDraft: Equatable, Sendable {
  public private(set) var revision: JSONValue = .null
  public var values: [String: String] = [:]
  private var savedRelay = ""

  /// Prompt only for a changed relay outside the project's hosted service.
  public var customRelayToConfirm: String? {
    let proposed = (values["relay"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard proposed != savedRelay, !proposed.isEmpty else { return nil }
    if LegalConsent.relayOrigin(proposed) == "wss://relay.shellbell.dev" { return nil }
    return proposed
  }

  public static let customRelayNotice =
    "Only use this relay if you know who operates it and understand its setup and privacy practices. "
    + "Its operator receives connection and routing metadata and may log or retain it. "
    + "Terminal content stays end-to-end encrypted, but the operator can delay or block connections. "
    + "Shellbell cannot verify another operator’s practices."

  public init() {}
  public mutating func receive(_ settings: JSONValue, refreshing: Bool = false) {
    guard !refreshing, revision == .null else { return }
    replace(with: settings)
  }
  public mutating func replace(with settings: JSONValue) {
    guard settings["savedRevision"].string != nil else { return }
    let fields = [
      ("relay", "relayUrl"), ("name", "computerName"), ("accent", "accent"),
      ("notifyMinCommandMs", "notifyMinCommandMs"), ("idleQuietMs", "idleQuietMs"),
      ("idleMinActiveMs", "idleMinActiveMs"),
    ]
    var next: [String: String] = [:]
    for (key, field) in fields {
      let value = settings["saved"][field]
      next[key] = value.string ?? value.number.map { String(format: "%.0f", $0) } ?? ""
    }
    values = next
    savedRelay = next["relay"] ?? ""
    revision = settings["savedRevision"]
  }
}

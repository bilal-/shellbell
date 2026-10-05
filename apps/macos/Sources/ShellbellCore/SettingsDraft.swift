import Foundation

/// Values and the revision they were loaded from always travel together.
public struct SettingsDraft: Equatable, Sendable {
  public private(set) var revision: JSONValue = .null
  public var values: [String: String] = [:]
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
    revision = settings["savedRevision"]
  }
}

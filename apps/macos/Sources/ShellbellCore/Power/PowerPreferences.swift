import Foundation

public struct PowerPreferences: Codable, Equatable, Sendable {
  public var keepAwake: Bool
  public var allowDisplaySleep: Bool
  public var allowLidSleep: Bool

  public init(keepAwake: Bool = false, allowDisplaySleep: Bool = true, allowLidSleep: Bool = true) {
    self.keepAwake = keepAwake
    self.allowDisplaySleep = allowDisplaySleep
    self.allowLidSleep = allowLidSleep
  }

  private enum CodingKeys: String, CodingKey { case keepAwake, allowDisplaySleep, allowLidSleep }
  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    // Absent keys migrate safely; explicitly invalid/null values reject the record.
    keepAwake = c.contains(.keepAwake) ? try c.decode(Bool.self, forKey: .keepAwake) : false
    allowDisplaySleep =
      c.contains(.allowDisplaySleep) ? try c.decode(Bool.self, forKey: .allowDisplaySleep) : true
    allowLidSleep =
      c.contains(.allowLidSleep) ? try c.decode(Bool.self, forKey: .allowLidSleep) : true
  }
}

public final class PowerPreferencesStore {
  private struct Record: Codable {
    let v: Int
    let preferences: PowerPreferences
  }
  private let defaults: UserDefaults
  private let key = "shellbell.power.preferences"

  public init(defaults: UserDefaults) { self.defaults = defaults }
  public func load() -> PowerPreferences {
    guard let bytes = defaults.data(forKey: key), bytes.count <= 4096,
      let record = try? JSONDecoder().decode(Record.self, from: bytes), record.v == 1
    else { return PowerPreferences() }
    return record.preferences
  }
  public func save(_ preferences: PowerPreferences) throws {
    defaults.set(try JSONEncoder().encode(Record(v: 1, preferences: preferences)), forKey: key)
  }
}

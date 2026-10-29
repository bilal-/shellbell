import Foundation

public struct PowerPreferences: Codable, Equatable, Sendable {
  public var keepAwake: Bool
  public var keepAwakeOnBattery: Bool
  public var allowDisplaySleep: Bool
  public var allowLidSleep: Bool

  public init(
    keepAwake: Bool = false, keepAwakeOnBattery: Bool = false,
    allowDisplaySleep: Bool = true, allowLidSleep: Bool = true
  ) {
    self.keepAwake = keepAwake
    self.keepAwakeOnBattery = keepAwakeOnBattery
    self.allowDisplaySleep = allowDisplaySleep
    self.allowLidSleep = allowLidSleep
  }

  /// What one app process left on when it quit, for the build that replaces it.
  private struct Handoff: Codable {
    let v: Int
    let build: String
    let quitAt: TimeInterval
    let preferences: PowerPreferences
  }
  private static let key = "shellbell.power.preferences"
  /// Long enough to install an update, short enough that a later launch starts off.
  private static let updateWindow: TimeInterval = 15 * 60

  /// Power intent belongs to one app process, not the next launch. The one exception is an
  /// update: a different build opened within minutes of a quit keeps that quit's choices, so
  /// updating Shellbell doesn't quietly let the Mac sleep. Reopening the same build starts off.
  public static func startSession(defaults: UserDefaults, build: String, now: Date)
    -> PowerPreferences
  {
    let bytes = defaults.data(forKey: key)
    defaults.removeObject(forKey: key)
    guard let bytes, bytes.count <= 4096,
      let handoff = try? JSONDecoder().decode(Handoff.self, from: bytes),
      handoff.v == 2, handoff.build != build
    else { return PowerPreferences() }
    let elapsed = now.timeIntervalSince1970 - handoff.quitAt
    guard elapsed >= 0, elapsed <= updateWindow else { return PowerPreferences() }
    return handoff.preferences
  }

  /// Called once Quit has finished; offered only to the first launch of a different build.
  public static func endSession(
    _ preferences: PowerPreferences, defaults: UserDefaults, build: String, now: Date
  ) {
    guard preferences != PowerPreferences(),
      let bytes = try? JSONEncoder().encode(
        Handoff(v: 2, build: build, quitAt: now.timeIntervalSince1970, preferences: preferences))
    else {
      defaults.removeObject(forKey: key)
      return
    }
    defaults.set(bytes, forKey: key)
  }
}

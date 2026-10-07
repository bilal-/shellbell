import Foundation

public struct PowerPreferences: Equatable, Sendable {
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

  /// Power intent belongs to one app process, not the next launch.
  public static func startSession(defaults: UserDefaults) -> PowerPreferences {
    defaults.removeObject(forKey: "shellbell.power.preferences")
    return PowerPreferences()
  }
}

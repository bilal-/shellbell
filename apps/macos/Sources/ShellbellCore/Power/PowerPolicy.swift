public enum ExternalPower: Equatable, Sendable { case ac, battery, unknown }

public struct PowerEligibility: Sendable {
  public let power: ExternalPower
  public let desktopServiceVerified: Bool
  public let statusFresh: Bool
  public let isLaptop: Bool
  public init(power: ExternalPower, desktopServiceVerified: Bool, statusFresh: Bool, isLaptop: Bool)
  {
    self.power = power
    self.desktopServiceVerified = desktopServiceVerified
    self.statusFresh = statusFresh
    self.isLaptop = isLaptop
  }
}

public struct PowerDemand: Equatable, Sendable {
  public let preventIdleSystem: Bool
  public let preventIdleDisplay: Bool
  public let requestClosedLid: Bool
  public init(preventIdleSystem: Bool, preventIdleDisplay: Bool, requestClosedLid: Bool) {
    self.preventIdleSystem = preventIdleSystem
    self.preventIdleDisplay = preventIdleDisplay
    self.requestClosedLid = requestClosedLid
  }
}

public func powerDemand(_ preferences: PowerPreferences, _ eligibility: PowerEligibility)
  -> PowerDemand
{
  let active =
    preferences.keepAwake && eligibility.power == .ac
    && eligibility.desktopServiceVerified && eligibility.statusFresh
  return PowerDemand(
    preventIdleSystem: active,
    preventIdleDisplay: active && !preferences.allowDisplaySleep,
    requestClosedLid: active && eligibility.isLaptop && !preferences.allowLidSleep)
}

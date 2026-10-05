public struct PowerSourceSnapshot: Sendable {
  public enum Source: Sendable { case ac, battery, ups, unknown }
  public let source: Source
  public let internalBatteryPresent: Bool?
  public init(source: Source, internalBatteryPresent: Bool?) {
    self.source = source
    self.internalBatteryPresent = internalBatteryPresent
  }
}

public struct PowerSourceState: Equatable, Sendable {
  public let power: ExternalPower
  public let isLaptop: Bool
  public init(power: ExternalPower, isLaptop: Bool) {
    self.power = power
    self.isLaptop = isLaptop
  }
}

public func classifyPowerSource(_ snapshot: PowerSourceSnapshot) -> PowerSourceState {
  guard let laptop = snapshot.internalBatteryPresent else {
    return .init(power: .unknown, isLaptop: false)
  }
  let power: ExternalPower
  switch snapshot.source {
  case .ac: power = .ac
  case .battery: power = .battery
  case .ups, .unknown: power = .unknown
  }
  return .init(power: power, isLaptop: laptop)
}

/// Unknown console/process evidence must never grant a global sleep override.
/// Detection is conservative: running Amphetamine blocks even if its session is
/// inactive. Unknown or renamed controllers cannot be reliably discovered.
public func powerHelperHost(
  power: ExternalPower, consoleName: String?, consoleUID: UInt32,
  processNames: [String]?
) -> PowerLeaseHost {
  guard let names = processNames else {
    return .init(power: power, consoleUID: nil, competingController: true)
  }
  let validConsole =
    consoleUID > 0 && consoleName != nil
    && consoleName != "" && consoleName != "loginwindow" && consoleName != "_mbsetupuser"
  return .init(
    power: power, consoleUID: validConsole ? consoleUID : nil,
    competingController: names.contains { $0.hasPrefix("Amphetamine") })
}

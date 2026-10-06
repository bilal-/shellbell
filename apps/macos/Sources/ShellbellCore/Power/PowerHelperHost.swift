import Darwin

/// Unknown console/process evidence must never grant a global sleep override.
/// Recognized sleep managers conservatively block closed-lid access even when
/// their session is inactive. Ordinary idle assertions can still coexist.
/// Process names are hints, not an exhaustive inventory of other controllers;
/// the lease engine also checks the existing global override before mutation.
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
    competingController: names.contains { name in
      let normalized = name.lowercased()
      return sleepManagerNames.contains { normalized == $0 || normalized == String($0.prefix(Int(MAXCOMLEN))) }
    })
}

// Darwin p_comm retains MAXCOMLEN bytes. Known manager names are ASCII. Include known helper names
// without matching arbitrary processes that merely contain an app's name.
private let sleepManagerNames = [
  "amphetamine", "amphetamine enhancer", "amphetamine-enhancer", "amphetamineenhancer",
  "caffeine", "keepingyouawake", "nosleep", "insomniax", "lungo", "owly",
]

import Foundation
import ShellbellCore

@MainActor public final class SystemSleepOverride: SleepOverrideAdapter {
  public enum Failure: Error { case invalidReadback }
  private let execute: ([String]) throws -> Data
  public init() {
    execute = { try BoundedPowerCommand.run(executable: "/usr/bin/pmset", arguments: $0) }
  }
  init(execute: @escaping ([String]) throws -> Data) { self.execute = execute }
  public func readEnabled() throws -> Bool {
    try Self.decode(try execute(["-g"]))
  }
  // Shared by the root command adapter and the desktop's read-only background probe.
  nonisolated static func decode(_ output: Data) throws -> Bool {
    guard let text = String(data: output, encoding: .utf8) else { throw Failure.invalidReadback }
    let rows = text.split(whereSeparator: \.isNewline).map {
      $0.split(whereSeparator: \.isWhitespace)
    }
    let lines = rows.filter { $0.first?.hasPrefix("SleepDisabled") == true }
    if lines.isEmpty {
      // pmset prints only explicitly stored system settings. A fresh Mac has
      // no SleepDisabled key. Require both successful sections and a valid
      // live sleep setting before interpreting an omitted key as off.
      guard rows.first == ["System-wide", "power", "settings:"],
        rows.filter({ $0 == ["System-wide", "power", "settings:"] }).count == 1,
        rows.filter({ $0 == ["Currently", "in", "use:"] }).count == 1,
        let live = rows.firstIndex(of: ["Currently", "in", "use:"])
      else { throw Failure.invalidReadback }
      let sleep = rows.dropFirst(live + 1).filter { $0.first == "sleep" }
      guard sleep.count == 1, sleep[0].count >= 2,
        let minutes = UInt(sleep[0][1]), minutes <= Int32.max
      else { throw Failure.invalidReadback }
      return false
    }
    guard lines.count == 1, lines[0].first == "SleepDisabled", lines[0].count == 2,
      ["0", "1"].contains(lines[0][1])
    else { throw Failure.invalidReadback }
    return lines[0][1] == "1"
  }
  public func setEnabled(_ enabled: Bool) throws {
    _ = try execute(["-a", "disablesleep", enabled ? "1" : "0"])
  }
}

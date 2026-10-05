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
    let output = try execute(["-g"])
    guard let text = String(data: output, encoding: .utf8) else { throw Failure.invalidReadback }
    let lines = text.split(whereSeparator: \.isNewline).map {
      $0.split(whereSeparator: \.isWhitespace)
    }
    .filter { $0.first == "SleepDisabled" }
    guard lines.count == 1, lines[0].count == 2, ["0", "1"].contains(lines[0][1])
    else { throw Failure.invalidReadback }
    return lines[0][1] == "1"
  }
  public func setEnabled(_ enabled: Bool) throws {
    _ = try execute(["-a", "disablesleep", enabled ? "1" : "0"])
  }
}

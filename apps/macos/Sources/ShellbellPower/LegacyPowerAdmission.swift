import Darwin
import Foundation

/// Read-only admission check: old and new helpers must never share the power lease.
enum LegacyPowerAdmission {
  static let label = "dev.bilalahmad.shellbell.power"
  enum Failure: Error { case inspectionUnavailable }

  static func isPresent(
    installed: () throws -> Bool = installedPlist,
    inspect: ([String]) throws -> Data = inspectLaunchd
  ) throws -> Bool {
    if try installed() { return true }
    do {
      _ = try inspect(["print", "system/\(label)"])
      return true
    } catch BoundedPowerCommand.Failure.exit(let status) where status == (113 << 8) {
      // Only launchctl's explicit service-not-found response proves absence.
    }
    let data = try inspect(["print-disabled", "system"])
    guard let text = String(data: data, encoding: .utf8) else {
      throw Failure.inspectionUnavailable
    }
    let lines = text.split(separator: "\n").map {
      $0.trimmingCharacters(in: .whitespacesAndNewlines)
    }.filter { !$0.isEmpty }
    guard lines.first == "disabled services = {", lines.last == "}" else {
      throw Failure.inspectionUnavailable
    }
    return lines.contains { $0.contains("\"\(label)\"") }
  }

  static func installedPlist() throws -> Bool {
    var info = stat()
    if lstat("/Library/LaunchDaemons/\(label).plist", &info) == 0 { return true }
    guard errno == ENOENT else { throw Failure.inspectionUnavailable }
    return false
  }

  static func inspectLaunchd(_ arguments: [String]) throws -> Data {
    try BoundedPowerCommand.run(
      executable: "/bin/launchctl", arguments: arguments, timeout: 1, limit: 65536)
  }
}

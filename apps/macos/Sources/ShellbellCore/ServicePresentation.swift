import Foundation

public struct ServicePresentation: Equatable, Sendable {
  public enum ProcessState: Equatable, Sendable {
    case unknown, noObservedProcess, runningUnverified, runningVerified
  }
  public let managerRows: [String]
  public let processState: ProcessState
  public let process: String
  public let ownership: String

  public init(status: JSONValue) {
    guard status != .null else {
      managerRows = ["Service manager: Unknown"]
      processState = .unknown
      process = "Service process: Unknown"
      ownership = "Local ownership: Unknown"
      return
    }
    let modes =
      [("manual", "This login"), ("persistent", "At login")]
      + (status["desktop"] == .null ? [] : [("desktop", "Desktop")])
    managerRows = modes.map { mode, title in
      let job = status[mode]
      let registration: String
      switch job["registration"].string {
      case "not-registered": registration = "Not registered"
      case "enabled": registration = "Registered"
      case "requires-approval": registration = "Approval required"
      case "not-found": registration = "Not found"
      default: registration = "Unknown registration"
      }
      let loaded = job["loaded"].bool.map { $0 ? "loaded" : "not loaded" } ?? "load state unknown"
      return "\(title) manager: \(registration), \(loaded)"
    }
    let observed = modes.compactMap { mode, title -> (Double, String)? in
      guard status[mode]["loaded"].bool == true, let pid = status[mode]["pid"].number else {
        return nil
      }
      return (pid, "PID \(String(format: "%.0f", pid)) (\(title.lowercased()))")
    }
    let local = status["local"]
    let localPID = local["status"]["process"]["pid"].number
    let verified = local["kind"] == .string("verified") && localPID != nil
    if observed.isEmpty {
      processState = .noObservedProcess
      process =
        modes.contains { status[$0.0]["loaded"].bool == true }
        ? "Service process: Loaded job; no PID reported" : "Service process: No PID observed"
    } else if observed.count == 1, verified, observed[0].0 == localPID {
      processState = .runningVerified
      process = "Service process: Running, \(observed[0].1)"
    } else {
      processState = .runningUnverified
      process =
        "Service process: Observed \(observed.map(\.1).joined(separator: "; ")); ownership unverified"
    }
    switch local["kind"].string {
    case "verified":
      ownership =
        localPID.map { "Local ownership: Verified owner, PID \(String(format: "%.0f", $0))" }
        ?? "Local ownership: Reported verified; no local PID"
    case "foreign": ownership = "Local ownership: Foreign process"
    case "absent": ownership = "Local ownership: No local connection"
    case "unverified": ownership = "Local ownership: Unverified"
    default: ownership = "Local ownership: Unknown"
    }
  }
}

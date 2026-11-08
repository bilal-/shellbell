import Foundation
import os

/// Local, metadata-only power evidence. Repeated states are bounded; changes log immediately.
@MainActor public final class PowerDiagnosticLog {
  public enum Event: String, Sendable {
    case startup, source, sourceSubscription, host, controller, request, reply, powerService
    case eligibility, lease, restoration, restorationResult, overrideRead, overrideWrite
    case runtime, system, sleepWake
  }

  private struct Record {
    let details: String
    let time: TimeInterval
  }
  private var records: [Event: Record] = [:]
  private let now: () -> TimeInterval
  private let write: (String) -> Void

  public init(
    category: String,
    now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
    write: ((String) -> Void)? = nil
  ) {
    self.now = now
    let logger = Logger(subsystem: "sh.bilal.shellbell.host", category: category)
    self.write = write ?? { logger.notice("\($0, privacy: .public)") }
  }

  public func record(_ event: Event, _ details: String) {
    let time = now()
    if let previous = records[event], previous.details == details,
      time.isFinite, time >= previous.time, time - previous.time < 60
    {
      return
    }
    records[event] = Record(details: details, time: time)
    write("event=\(event.rawValue) \(details)")
  }

  public nonisolated static func value(_ value: Bool?) -> String {
    value.map { $0 ? "true" : "false" } ?? "unknown"
  }

  /// Never include an error's description, command output, paths or associated payload.
  public nonisolated static func failure(_ error: Error) -> String {
    if let failure = error as? PowerLeaseFailure { return failure.rawValue }
    return "\(String(reflecting: type(of: error))):\((error as NSError).code)"
  }
}

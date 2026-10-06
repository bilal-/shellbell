import Foundation

/// Read-only macOS evidence, separate from preferences and Shellbell's owned controls.
/// Nil fields mean unavailable, never "off". Assertion requests are not sleep guarantees.
public struct PowerSystemSnapshot: Equatable, Sendable {
  public let sleepDisabled: Bool?
  public let otherIdleSleepRequests: Bool?
  public let otherDisplaySleepRequests: Bool?

  public init(
    sleepDisabled: Bool?, otherIdleSleepRequests: Bool?, otherDisplaySleepRequests: Bool?
  ) {
    self.sleepDisabled = sleepDisabled
    self.otherIdleSleepRequests = otherIdleSleepRequests
    self.otherDisplaySleepRequests = otherDisplaySleepRequests
  }
}

public struct PowerSystemObservation: Equatable, Sendable {
  public static let maximumAge: TimeInterval = 5
  public let snapshot: PowerSystemSnapshot
  public let capturedAt: TimeInterval

  public init(snapshot: PowerSystemSnapshot, capturedAt: TimeInterval) {
    self.snapshot = snapshot
    self.capturedAt = capturedAt
  }

  public func fresh(at now: TimeInterval) -> Self? {
    guard now.isFinite, capturedAt.isFinite, capturedAt >= 0,
      now >= capturedAt, now - capturedAt <= Self.maximumAge
    else { return nil }
    return self
  }
}

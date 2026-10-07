/// Settings copy derives from observed controls, never checkbox intent.
public struct PowerPresentation: Equatable, Sendable {
  public let title: String
  public let detail: String
  public let idle: String
  public let display: String
  public let lid: String
  public let systemSleep: String
  public let otherIdle: String
  public let otherDisplay: String
  public let systemWarning: String?

  public init(
    status: PowerStatus, closedLidStatus: PowerStatus,
    idleSystemHealth: PowerAssertionHealth, idleDisplayHealth: PowerAssertionHealth,
    powerSource: ExternalPower, approvalPending: Bool = false,
    systemObservation: PowerSystemObservation? = nil
  ) {
    idle = Self.assertionValue(idleSystemHealth, active: "Active", off: "Off")
    display = Self.assertionValue(idleDisplayHealth, active: "Kept on", off: "May sleep")
    lid = Self.lidValue(closedLidStatus, power: powerSource, approvalPending: approvalPending)
    let snapshot = systemObservation?.snapshot
    systemSleep = Self.observedValue(snapshot?.sleepDisabled, on: "On", off: "Off")
    otherIdle = Self.observedValue(snapshot?.otherIdleSleepRequests, on: "Present", off: "None observed")
    otherDisplay = Self.observedValue(snapshot?.otherDisplaySleepRequests, on: "Present", off: "None observed")
    systemWarning = snapshot?.sleepDisabled == true && closedLidStatus != .active && closedLidStatus != .restoring
      ? "System sleep is disabled, but Shellbell’s closed-lid protection isn’t verified. Check manual power changes or other sleep apps."
      : nil
    switch status {
    case .off:
      title = "Keep-awake is off"
      detail = "Shellbell is not requesting keep-awake protection."
    case .waitingForPower:
      title = powerSource == .battery ? "Paused on battery" : "Power source unavailable"
      detail = powerSource == .battery
        ? "Plug in this Mac or turn on Include battery power."
        : "Keep-awake is paused until the power source can be verified."
    case .waitingForService:
      title = "Waiting for remote access"
      detail = "Start Shellbell’s desktop service to enable keep-awake."
    case .checking:
      title = "Checking closed-lid access…"
      detail = "Waiting for macOS and the administrator helper to confirm protection."
    case .restoring:
      title = "Turning off closed-lid access…"
      detail = "Waiting for macOS to confirm system sleep is restored."
    case .active:
      title = powerSource == .battery ? "Keeping awake on battery" : "Keep-awake is active"
      detail = closedLidStatus == .active
        ? "Closed-lid access is verified. Keep this Mac ventilated."
        : closedLidStatus == .waitingForPower
          ? "Idle protection is active. Plug in to use closed-lid access."
          : "Idle protection is active while desktop remote access runs."
    case .setupRequired:
      title = approvalPending ? "Approve closed-lid access in macOS" : "Set up closed-lid access"
      detail = approvalPending
        ? "Allow Shellbell in System Settings → General → Login Items & Extensions."
        : "Administrator approval is required for this optional feature."
    case .helperUnavailable:
      title = "Closed-lid helper unavailable"
      detail = "Shellbell retries automatically. Closed-lid protection is not verified."
    case .conflict:
      title = "Closed-lid access is blocked"
      detail = "Review manual power changes or quit other sleep-management apps. Shellbell retries automatically."
    case .recoveryRequired:
      title = "Power change not verified"
      detail = "One of the requested changes could not be confirmed. Retry recovery and check the status below."
    case .maintenance:
      title = "Finish closed-lid setup"
      detail = "After any update or removal finishes, use Enable closed-lid access to restore protection."
    case .interrupted:
      title = "Closed-lid access was interrupted"
      detail = "macOS reported that the sleep override was turned off. Review manual power changes or other sleep apps, then retry."
    }
  }

  private static func assertionValue(_ health: PowerAssertionHealth, active: String, off: String) -> String {
    switch health {
    case .active: return active
    case .activeWithFailure: return "Still active; change failed"
    case .off: return off
    case .unverified: return "Not verified"
    }
  }

  private static func observedValue(_ value: Bool?, on: String, off: String) -> String {
    guard let value else { return "Not verified" }
    return value ? on : off
  }

  private static func lidValue(_ status: PowerStatus, power: ExternalPower, approvalPending: Bool) -> String {
    switch status {
    case .off: return "Off"
    case .active: return "Active"
    case .waitingForPower: return power == .battery ? "Plug in to enable" : "Power source unknown"
    case .waitingForService: return "Waiting for remote access"
    case .checking: return "Checking…"
    case .restoring: return "Turning off…"
    case .setupRequired: return approvalPending ? "Approval needed" : "Setup needed"
    case .helperUnavailable: return "Helper unavailable"
    case .conflict: return "Blocked"
    case .recoveryRequired: return "Not verified"
    case .maintenance: return "Setup needed"
    case .interrupted: return "Paused after a power change"
    }
  }
}

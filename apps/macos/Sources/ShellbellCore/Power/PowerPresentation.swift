/// Describes verified Shellbell controls, independently of saved user intent.
/// Other applications and macOS can still prevent sleep after our controls stop.
public struct PowerPresentation: Equatable, Sendable {
  public let title: String
  public let detail: String

  public init(
    status: PowerStatus, lidActive: Bool, idleSystemActive: Bool, idleDisplayActive: Bool,
    approvalPending: Bool = false
  ) {
    let idle =
      idleSystemActive ? "Idle sleep is prevented." : "Shellbell is not preventing idle sleep."
    let display =
      idleDisplayActive ? "Display sleep is prevented." : "Shellbell allows display sleep."
    switch status {
    case .off:
      title = "Shellbell keep-awake is off"
      detail =
        "Shellbell’s power controls are off. macOS and other apps can still keep this Mac awake."
    case .waitingForPower:
      title = "Waiting for external power"
      detail = "Shellbell’s keep-awake controls are paused until this Mac is plugged in."
    case .waitingForService:
      title = "Waiting for remote access"
      detail =
        "Start desktop remote access to keep this Mac awake. Headless services do not use these settings."
    case .checking:
      title = "Checking closed-lid access…"
      detail = "Closed-lid access is requested but not yet verified. \(idle) \(display)"
    case .restoring:
      title = "Turning off closed-lid access…"
      detail = "Waiting for the helper to verify that Shellbell’s sleep override is off. \(idle)"
    case .active:
      title = lidActive ? "Closed-lid access is active" : "Idle sleep is prevented"
      detail =
        lidActive
        ? "Shellbell’s sleep override is verified. Keep this Mac ventilated. \(display)"
        : "Shellbell’s closed-lid protection is off. macOS and other apps control lid-close behavior. \(display)"
    case .setupRequired:
      title = approvalPending ? "Waiting for macOS approval" : "Closed-lid access needs setup"
      detail =
        approvalPending
        ? "Allow Shellbell in System Settings → General → Login Items & Extensions. Closed-lid access is not active. \(idle)"
        : "Administrator setup is required for closed-lid access. \(idle)"
    case .helperUnavailable:
      title = "The power helper could not be reached"
      detail = "Closed-lid access is not verified. Shellbell will retry automatically. \(idle)"
    case .conflict:
      title = "Closed-lid access is blocked"
      detail =
        "Shellbell cannot safely take control of sleep. Pause other sleep-management apps before retrying. \(idle)"
    case .recoveryRequired:
      title = "Power state could not be verified"
      detail =
        "A power change failed or could not be confirmed. Retry power recovery before quitting or removing Shellbell. \(idle)"
    case .maintenance:
      title = "Closed-lid access is paused for maintenance"
      detail =
        "The helper’s sleep override is off. Open Advanced to recover interrupted setup after the update or removal has finished. \(idle)"
    }
  }
}

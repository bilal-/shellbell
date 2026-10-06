/// Describes verified Shellbell controls, independently of saved user intent.
/// Other applications and macOS can still prevent sleep after our controls stop.
public struct PowerPresentation: Equatable, Sendable {
  public let title: String
  public let detail: String

  public init(
    status: PowerStatus, lidActive: Bool, idleSystemActive: Bool, idleDisplayActive: Bool,
    approvalPending: Bool = false,
    powerSource: ExternalPower = .unknown, closedLidRequested: Bool = false
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
      title = powerSource == .battery ? "Keep-awake is paused on battery" : "Power source unavailable"
      detail = powerSource == .battery
        ? "Plug in this Mac or enable Keep awake on battery. Shellbell is not preventing idle sleep."
        : "Shellbell’s power controls are paused until the power source can be verified."
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
      if lidActive {
        title = "Closed-lid access is active"
        detail = "Shellbell’s sleep override is verified. Keep this Mac ventilated. \(display)"
      } else if powerSource == .battery {
        title = "Idle sleep prevented on battery"
        let lid = closedLidRequested
          ? "Closed-lid access is paused on battery; plug in this Mac to resume it."
          : "Closing the lid can still put this Mac to sleep."
        detail = "Keep-awake uses battery power. \(lid) \(display)"
      } else {
        title = "Idle sleep is prevented"
        detail = "Shellbell’s closed-lid protection is off. macOS and other apps control lid-close behavior. \(display)"
      }
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
        "Shellbell cannot safely take control of sleep. Review manual power changes or quit other sleep-management apps before retrying. \(idle)"
    case .interrupted:
      title = "Closed-lid access was interrupted"
      detail = "macOS’s system sleep override was turned off. Review manual power changes or other sleep apps, then retry closed-lid access. \(idle)"
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

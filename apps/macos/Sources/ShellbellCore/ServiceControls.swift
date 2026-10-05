import Foundation

/// Actions follow installation ownership, never merely a registered job.
public struct ServiceControls {
  public enum Action { case start, stop }
  public let action: Action?
  public let title: String
  public let startMode = "desktop"
  public let canRecoverManually: Bool
  public let automaticStartupUnavailable: Bool
  public let isDesktop: Bool
  public let needsSetup: Bool
  public let canConvertToDesktop: Bool
  public let canConvertToHeadless: Bool
  public let canRecoverOwnership: Bool

  public init(status: JSONValue) {
    let mode = status["ownership"]["mode"].string
    isDesktop = mode == "desktop"
    canRecoverOwnership = status["ownership"]["transition"] != .null
    canConvertToHeadless = isDesktop && !canRecoverOwnership && status["transition"] == .null
    canConvertToDesktop = !canRecoverOwnership && (mode == "headless" || mode == "legacy-native")
    needsSetup =
      status != .null && status["ownership"] != .null && mode == nil && status["selection"] == .null
      && status["legacy"]["installed"] == .bool(false)
      && status["local"]["kind"] == .string("absent")
    automaticStartupUnavailable =
      isDesktop
      ? (status["desktopLogin"].string ?? "unknown") == "unknown"
      : status["persistent"]["registration"] == .string("not-found")
    canRecoverManually =
      status["manualRecoveryAvailable"] == .bool(true)
      && status["selection"]["mode"] == .string("persistent")
      && ["start", "restart", "recover"].contains(status["transition"]["action"].string ?? "")
      && status["manual"]["loaded"] == .bool(false)
      && status["persistent"]["loaded"] == .bool(false)
      && status["legacy"]["installed"] == .bool(false) && status["legacy"]["loaded"] == .bool(false)
      && status["local"]["kind"] == .string("absent")
    if status == .null {
      action = nil
      title = "Checking service…"
      return
    }
    if canRecoverOwnership || status["transition"] != .null {
      action = nil
      title = "Setup needs attention"
      return
    }
    if mode == "headless" {
      action = nil
      title = "Headless service"
      return
    }
    if !isDesktop {
      action = nil
      title = needsSetup ? "Enable Shellbell" : "Existing service setup"
      return
    }
    let presentation = ServicePresentation(status: status)
    if presentation.processState == .runningVerified {
      action = .stop
      title =
        status["local"]["status"]["relayOnline"] == .bool(true)
        ? "Connected" : "Service running · relay offline"
    } else if status["local"]["kind"] == .string("absent")
      && status["desktop"]["loaded"] == .bool(false)
    {
      action = .start
      title = "Service stopped"
    } else {
      action = nil
      title = "Service needs attention"
    }
  }
}

extension ControllerPhase {
  public var notice: String? {
    switch self {
    case .idle: nil
    case .busy(let command):
      ["status", "settings.get", "devices", "diagnostics"].contains(command)
        ? nil : "Updating Shellbell…"
    case .approval: "Allow Shellbell in Login Items, then continue setup in Advanced."
    case .conflict: "Settings changed elsewhere. Reload before trying again."
    case .unknownDelivery: "The result is unknown. Check Advanced before trying again."
    case .recovery: "Service setup is incomplete. Use the recovery controls in General or Advanced."
    case .unavailable: "Shellbell couldn’t connect to its controller. Open Advanced to reconnect."
    }
  }
}

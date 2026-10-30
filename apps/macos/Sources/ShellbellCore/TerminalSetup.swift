import Foundation

/// One supported terminal as the running service reports it, in the Mac app's words. The wording
/// matches `terminalSetupText(..., "mac-app")` in `@shellbell/protocol`.
public struct TerminalSetup: Equatable, Sendable, Identifiable {
  public enum Action: Equatable, Sendable {
    /// Lets macOS and iTerm2 ask; only a click starts it.
    case connectITerm
    case openITerm
    case openAutomationSettings
  }

  public let name: String
  public let connected: Bool
  public let issue: String?
  public let detail: String?
  public var id: String { name }

  public init(name: String, connected: Bool, issue: String? = nil, detail: String? = nil) {
    self.name = name
    self.connected = connected
    self.issue = issue
    self.detail = detail
  }

  public init?(_ value: JSONValue) {
    guard let name = value["name"].string, let connected = value["connected"].bool else {
      return nil
    }
    self.init(
      name: name, connected: connected, issue: value["issue"].string,
      detail: value["detail"].string)
  }

  public var label: String {
    ["iterm2": "iTerm2", "tmux": "tmux", "herdr": "Herdr"][name] ?? name
  }

  public var ready: Bool { connected && issue == nil }

  /// Something the person has to do. A terminal that is absent or closed is not a problem.
  public var needsAttention: Bool {
    guard let issue else { return false }
    return [
      "needs-consent", "automation-denied", "iterm2-denied", "timed-out", "too-old", "failed",
      "limited",
    ].contains(issue)
  }

  /// Not installed, so it is listed under "Other supported terminals".
  public var absent: Bool { issue == "not-installed" }

  public var waiting: Bool { issue == "connecting" }

  public var status: String {
    if ready { return "Connected. Ready for your paired phone." }
    switch issue {
    case "not-installed": return "Shellbell couldn't find \(label). Optional."
    case "not-running":
      return name == "iterm2"
        ? "iTerm2 isn't open. Open it to see its tabs on your phone." : "\(label) isn't running."
    case "no-session": return "No tmux session is running."
    case "api-off": return "Turn on iTerm2's Python API to connect."
    case "needs-consent": return "Ready to connect."
    case "connecting": return "Finish connecting in the macOS or iTerm2 dialog."
    case "automation-denied": return "macOS is blocking Shellbell from iTerm2."
    case "iterm2-denied": return "iTerm2 is blocking Shellbell."
    case "timed-out": return "Connecting wasn't finished."
    case "too-old":
      return name == "tmux" ? "Shellbell needs tmux 3.2 or newer." : "Update \(label) to connect."
    case "limited": return "Viewing and typing work. Opening new sessions from your phone doesn't."
    default: return "Shellbell couldn't connect to \(label)."
    }
  }

  /// The steps under the status line; nil when there is nothing to do.
  public var steps: String? {
    switch issue {
    case "not-installed":
      return name == "tmux" ? "Install tmux 3.2 or newer, for example: brew install tmux" : nil
    case "not-running": return name == "iterm2" ? nil : "In any terminal, run: \(name)"
    case "no-session": return "In any terminal, run: tmux"
    case "api-off":
      return "In iTerm2, open Settings → General → Magic and turn on Enable Python API."
    case "needs-consent":
      return
        "Your paired phone will be able to read and type in your iTerm2 tabs. When you click Connect iTerm2, macOS asks to let Shellbell control iTerm2, and iTerm2 may ask to allow Shellbell. Allow both. You can connect later."
    case "automation-denied":
      return
        "Open System Settings → Privacy & Security → Automation, find Shellbell (or node, for the background service) and turn on iTerm2."
    case "iterm2-denied":
      return
        "In iTerm2, open Settings → General → Magic and check who may use the Python API. Then click Connect iTerm2."
    case "timed-out": return "Check for an open macOS or iTerm2 dialog, then try again."
    case "too-old":
      return name == "iterm2"
        ? "Shellbell needs iTerm2 3.3 or newer."
        : name == "tmux" ? "Update tmux, for example: brew upgrade tmux" : nil
    case "limited": return detail
    case "failed": return name == "iterm2" ? "Try again." : "Shellbell keeps trying."
    default: return nil
    }
  }

  /// The one button the card offers, if any.
  public var action: Action? {
    guard name == "iterm2" else { return nil }
    switch issue {
    case "not-running": return .openITerm
    case "needs-consent", "iterm2-denied", "timed-out", "failed": return .connectITerm
    case "automation-denied": return .openAutomationSettings
    default: return nil
    }
  }

  public static func list(_ value: JSONValue) -> [TerminalSetup] {
    (value["terminals"].array ?? []).compactMap(TerminalSetup.init)
  }

  /// True when Shellbell found none of iTerm2, tmux or Herdr and no other terminal is connected;
  /// Apple's Terminal alone is not enough. A list missing any of them, as from an older service,
  /// is never judged. Matches `noUsableMacTerminal` in `@shellbell/protocol`.
  public static func noUsableTerminal(_ terminals: [TerminalSetup]) -> Bool {
    if terminals.contains(where: \.connected) { return false }
    return ["iterm2", "tmux", "herdr"].allSatisfy { name in
      terminals.contains { $0.name == name && !$0.connected && $0.issue == "not-installed" }
    }
  }

  /// Matches `noUsableMacTerminalText(..., "mac-app")` in `@shellbell/protocol`.
  public static let noUsableTerminalStatus = "Shellbell needs iTerm2, tmux or Herdr on this Mac."
  public static let noUsableTerminalSteps =
    "Apple's Terminal only lets other apps see plain text and type whole lines, which isn't enough to use a terminal from your phone, so Shellbell can't use it by itself. iTerm2 is the easiest: your phone sees every tab and can open new ones. With tmux or Herdr, sessions you run inside them show on your phone, in Terminal too."
}

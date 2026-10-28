import Foundation

/// One coding agent found on this computer, as the controller reports it. The wording matches
/// `agentSetupLine` in the service's `agent-setup.ts`, so the app and the command line agree.
public struct AgentSetup: Equatable, Sendable, Identifiable {
  public enum State: String, Sendable {
    case ready, needsSetup = "needs-setup", hooksOff = "hooks-off", blocked
    case comingSoon = "coming-soon"
  }

  public let kind: String
  public let name: String
  public let state: State
  /// Shellbell added a helper to this agent, so it can be removed.
  public let helper: Bool
  /// Set up was offered and skipped; the app doesn't offer it again.
  public let skipped: Bool
  public let detail: String?
  public var id: String { kind }

  public init(
    kind: String, name: String, state: State, helper: Bool = false, skipped: Bool = false,
    detail: String? = nil
  ) {
    self.kind = kind
    self.name = name
    self.state = state
    self.helper = helper
    self.skipped = skipped
    self.detail = detail
  }

  public init?(_ value: JSONValue) {
    guard let kind = value["kind"].string, let name = value["name"].string,
      let state = value["state"].string.flatMap(State.init(rawValue:)),
      let helper = value["helper"].bool, let skipped = value["skipped"].bool
    else { return nil }
    self.init(
      kind: kind, name: name, state: state, helper: helper, skipped: skipped,
      detail: value["detail"].string)
  }

  public static func list(_ value: JSONValue) -> [AgentSetup]? {
    value["agents"].array.map { $0.compactMap(AgentSetup.init) }
  }

  /// Agents to offer set up for: they need a helper and the owner hasn't skipped them.
  public static func offer(_ agents: [AgentSetup]) -> [AgentSetup] {
    agents.filter { $0.state == .needsSetup && !$0.skipped }
  }

  public var ready: Bool { state == .ready }

  public var status: String {
    switch state {
    case .ready:
      return kind == "codex"
        ? "Ready. Codex sessions started from now on show their full history. If Codex asks, trust Shellbell's helper."
        : "Ready."
    case .needsSetup: return "Needs a small helper for full history on your phone."
    case .hooksOff:
      return
        "Codex hooks are turned off (hooks = false in Codex's config.toml), so its sessions open as a terminal."
    case .blocked: return detail ?? "Shellbell couldn't change this agent's settings."
    case .comingSoon: return "Full history coming soon. Opens as a terminal for now."
    }
  }

  /// The setup screen's text for these agents, in the words the command line uses too.
  public static func pitch(_ offer: [AgentSetup]) -> (title: String, body: String, note: String?) {
    let names = ListFormatter.localizedString(byJoining: offer.map(\.name))
    return (
      "Get the most out of \(names) on your phone",
      "Scroll back through a whole session, not just what's on screen, in text sized for your phone. Shellbell adds a small helper to each agent. It only notes which window each session runs in, and doesn't change how the agent works. You can remove it at any time in Settings.",
      offer.contains { $0.kind == "codex" }
        ? "Codex asks you to trust the helper the next time it starts. Choose Trust." : nil
    )
  }
}

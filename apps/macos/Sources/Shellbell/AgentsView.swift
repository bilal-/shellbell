import Combine
import ShellbellCore
import SwiftUI

/// Offers the helpers that give the phone each agent's full history. Highly recommended, never
/// required: skipping leaves those sessions as terminals and the app doesn't ask again.
struct AgentSetupPrompt: View {
  @ObservedObject var model: ControllerModel
  let offer: [AgentSetup]
  /// Runs after either choice has been saved, such as continuing to start the service.
  var then: (() -> Void)?

  var body: some View {
    let pitch = AgentSetup.pitch(offer)
    VStack(alignment: .leading, spacing: 8) {
      Text(pitch.title).font(.headline)
      Text(pitch.body).font(.callout).fixedSize(horizontal: false, vertical: true)
      if let note = pitch.note {
        Text(note).font(.callout).foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      HStack {
        Button("Set Up (Recommended)") { model.setupAgents(offer.map(\.kind), then: then) }
          .keyboardShortcut(.defaultAction)
        Button("Skip for Now") { model.skipAgents(offer.map(\.kind), then: then) }
      }
      .disabled(!model.canMutate)
    }
    .padding(14).frame(maxWidth: .infinity, alignment: .leading)
    .background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
  }
}

/// Settings → General: each coding agent found on this Mac and whether it shows full history.
struct AgentsSettings: View {
  @ObservedObject var model: ControllerModel
  /// Rereads like Terminals, so a newly installed agent or a change from the command line shows.
  private let poll = Timer.publish(every: 2, on: .main, in: .common).autoconnect()

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Coding agents").font(.headline)
      if let failure = model.agentsChangeFailure {
        Text(failure).font(.callout).foregroundStyle(.orange)
          .fixedSize(horizontal: false, vertical: true)
      }
      if let agents = model.agents {
        let offer = AgentSetup.offer(agents)
        if !offer.isEmpty { AgentSetupPrompt(model: model, offer: offer) }
        if agents.isEmpty {
          Text("No coding agents found on this Mac yet. Claude Code, Codex and others appear here once installed.")
            .font(.callout).foregroundStyle(.secondary)
        }
        ForEach(agents) { agent in
          HStack(alignment: .firstTextBaseline) {
            Image(systemName: agent.ready ? "checkmark.circle.fill" : "circle")
              .foregroundStyle(agent.ready ? Color.green : Color.secondary)
              .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
              Text(agent.name).font(.callout.weight(.medium))
              Text(agent.status).font(.callout).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            if agent.helper {
              Button("Remove Helper") { model.removeAgent(agent.kind) }.disabled(!model.canMutate)
            } else if agent.state == .needsSetup && agent.skipped {
              Button("Set Up") { model.setupAgents([agent.kind]) }.disabled(!model.canMutate)
            }
          }
          .accessibilityElement(children: .combine)
        }
      } else if let failure = model.agentsFailure {
        Text(failure).font(.callout).foregroundStyle(.orange)
          .fixedSize(horizontal: false, vertical: true)
      } else {
        Text("Checking…").font(.callout).foregroundStyle(.secondary)
      }
    }
    .onAppear { model.loadAgents() }
    .onReceive(poll) { _ in model.loadAgents() }
  }
}

/// Settings → Advanced: the owner's off switch for full history. On unless turned off.
struct FullHistorySetting: View {
  @Binding var draft: SettingsDraft

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Toggle(
        "Full agent history on your phone",
        isOn: Binding(
          get: { draft.values["conversations"] != "off" },
          set: { draft.values["conversations"] = $0 ? "on" : "off" })
      )
      .font(.callout.weight(.medium))
      Text(
        draft.values["conversations"] == "off"
          ? "Your phone shows only what's on your Mac's screen. Save to apply."
          : "Your phone can scroll back through a whole Claude Code or Codex session, in text sized for it. It travels encrypted, straight to your phone, and is never stored."
      )
      .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }
  }
}

import Combine
import ShellbellCore
import SwiftUI

struct OwnershipSetupView: View {
  @ObservedObject var model: ControllerModel
  @State private var confirming = false
  @State private var askingAgents = false
  /// Retries the agent check while it hasn't answered: a check asked for while another request
  /// was out is dropped, and Enable Remote Access waits for one.
  private let retry = Timer.publish(every: 2, on: .main, in: .common).autoconnect()
  private var controls: ServiceControls { ServiceControls(status: model.status) }
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      if controls.needsSetup {
        Text("Set up Shellbell").font(.headline)
        Text(
          "Allow Shellbell to read terminal sessions and send input from devices you pair. Closing Settings keeps access available; quitting Shellbell stops it."
        )
        .foregroundStyle(.secondary)
        VStack(alignment: .leading, spacing: 4) {
          Text(PermissionGuide.heading).font(.subheadline.weight(.semibold))
          ForEach(PermissionGuide.items, id: \.question) { item in
            Text("**\(item.question)**: \(item.reason)").fixedSize(horizontal: false, vertical: true)
          }
          Text(PermissionGuide.footer).foregroundStyle(.secondary)
          Text(PermissionGuide.next).foregroundStyle(.secondary)
        }
        .font(.callout)
        // Before the service starts, offer the helpers once; either answer continues the setup.
        if askingAgents, let failure = model.agentsChangeFailure {
          Text(failure).font(.callout).foregroundStyle(.orange)
            .fixedSize(horizontal: false, vertical: true)
        }
        if askingAgents, let agents = model.agents, !AgentSetup.offer(agents).isEmpty {
          AgentSetupPrompt(model: model, offer: AgentSetup.offer(agents)) {
            askingAgents = false
            model.setupDesktop()
          }
        } else {
          Button("Enable Remote Access") {
            if let agents = model.agents, !AgentSetup.offer(agents).isEmpty {
              askingAgents = true
            } else {
              model.setupDesktop()
            }
          }
          // Wait for the check of this Mac's agents, or its failure, so the offer isn't skipped.
          .disabled(!model.canMutate || (model.agents == nil && model.agentsFailure == nil))
          .onAppear { model.loadAgents() }
          .onReceive(retry) { _ in
            if model.agents == nil && model.agentsFailure == nil { model.loadAgents() }
          }
        }
      } else if controls.canRecoverOwnership {
        Text("Finish service setup").font(.headline)
        Text(
          "Setup was interrupted. Continue the recorded change without replacing your identity, paired devices, or settings."
        )
        .foregroundStyle(.secondary)
        Button("Continue Setup") { model.recoverOwnership() }.disabled(model.busy)
      } else if controls.canConvertToDesktop {
        Text(
          model.status["ownership"]["mode"] == .string("headless")
            ? "This headless service runs independently. Quitting this app leaves it running."
            : "This installation uses the older background service. Switch to desktop mode so Quit also stops remote access."
        )
        .foregroundStyle(.secondary)
        if confirming {
          Text(
            "Switching stops the existing service, keeps your paired devices and settings, and starts a desktop-owned service."
          )
          .font(.callout)
          HStack {
            Button("Cancel") { confirming = false }
            Button("Switch to Desktop Mode") {
              model.convertOwnership()
              confirming = false
            }
            .disabled(model.busy)
          }
        } else {
          Button("Switch to Desktop Mode…") { confirming = true }.disabled(model.busy)
        }
      }
    }
  }
}

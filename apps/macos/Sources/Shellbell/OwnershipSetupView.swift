import ShellbellCore
import SwiftUI

struct OwnershipSetupView: View {
  @ObservedObject var model: ControllerModel
  @State private var confirming = false
  private var controls: ServiceControls { ServiceControls(status: model.status) }
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      if controls.needsSetup {
        Text("Connect your terminals").font(.headline)
        Text(
          "Allow Shellbell to read terminal sessions and send input from devices you pair. Closing Settings keeps access available; quitting Shellbell stops it."
        )
        .foregroundStyle(.secondary)
        Button("Enable Remote Access") { model.setupDesktop() }.disabled(!model.canMutate)
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

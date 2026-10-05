import ShellbellCore
import ShellbellPower
import SwiftUI

/// Helper lifecycle controls belong in Advanced, not the everyday sleep controls.
struct PowerMaintenanceView: View {
  @ObservedObject var power: PowerController
  @ObservedObject var maintenance: PowerMaintenanceActions
  @State private var showRemoval = false
  @State private var showRecovery = false

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if maintenance.canRemoveHelper || maintenance.offersRecovery(powerStatus: power.status) {
        Text("Closed-lid access").font(.headline)
        Text(
          "Helper removal and maintenance recovery require the Mac’s system sleep override to be off. Other apps can block this check. The inactive helper can stay installed."
        )
        .font(.callout).foregroundStyle(.secondary)
        if maintenance.canRemoveHelper {
          Button("Remove Helper…") { showRemoval = true }
        }
        if maintenance.offersRecovery(powerStatus: power.status) {
          Text(
            "If an update or removal was interrupted, recover setup after that operation has finished."
          )
          .font(.callout).foregroundStyle(.secondary)
          Button("Recover Interrupted Setup…") { showRecovery = true }
        }
      }
      if maintenance.busy {
        Text("Verifying power settings…").font(.callout).foregroundStyle(.secondary)
      }
      if let error = maintenance.error {
        Text(error).font(.callout).foregroundStyle(.secondary)
      }
    }
    .disabled(maintenance.busy)
    .alert("Remove closed-lid helper?", isPresented: $showRemoval) {
      Button("Cancel", role: .cancel) {}
      Button("Remove Helper", role: .destructive) { Task { await maintenance.remove() } }
    } message: {
      Text(
        "Shellbell will release its own sleep controls and check that the Mac’s system sleep override is off before removing its administrator helper. Other apps can block this check. Remote access and ordinary keep-awake are kept. To use closed-lid access again, set up the helper and recover the maintenance hold."
      )
    }
    .alert("Recover interrupted setup?", isPresented: $showRecovery) {
      Button("Cancel", role: .cancel) {}
      Button("Recover") { Task { await maintenance.cancelRemoval() } }
    } message: {
      Text(
        "Only continue after any Shellbell update or helper removal has finished. This explicitly clears the maintenance hold after checking that the Mac’s system sleep override is off. Other apps can block this check. Closed-lid access stays off until you enable it again."
      )
    }
  }
}

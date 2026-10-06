import ShellbellCore
import ShellbellPower
import SwiftUI

/// Administrator lifecycle controls stay separate from everyday keep-awake settings.
struct PowerMaintenanceView: View {
  @ObservedObject var power: PowerController
  @ObservedObject var maintenance: PowerMaintenanceActions
  @State private var showRemoval = false
  @State private var showRecovery = false

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if maintenance.canRemoveHelper
        || maintenance.offersRecovery(powerStatus: power.status, lidActive: power.lidActive)
      {
        Text("Closed-lid setup").font(.headline)
        Text("An inactive administrator helper can stay installed. Remove it here when you no longer want closed-lid access.")
          .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        if maintenance.canRemoveHelper {
          Button("Remove closed-lid setup…") { showRemoval = true }
        }
        if maintenance.offersRecovery(powerStatus: power.status, lidActive: power.lidActive) {
          Text("If an update or removal was interrupted, finish setup after that operation has completed.")
            .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
          Button("Finish interrupted setup…") { showRecovery = true }
        }
      }
      if maintenance.busy {
        Text("Verifying power settings…").font(.callout).foregroundStyle(.secondary)
      }
      if let error = maintenance.error {
        Text("Last maintenance attempt: \(error)").font(.caption).foregroundStyle(.red)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .disabled(maintenance.busy)
    .alert("Remove closed-lid setup?", isPresented: $showRemoval) {
      Button("Cancel", role: .cancel) {}
      Button("Remove setup", role: .destructive) { Task { await maintenance.remove() } }
    } message: {
      Text("Shellbell turns off its closed-lid setting, verifies the system sleep override is off, and removes the administrator helper. Remote access stays enabled; idle protection resumes afterward. Other sleep controls can block this check.")
    }
    .alert("Finish interrupted setup?", isPresented: $showRecovery) {
      Button("Cancel", role: .cancel) {}
      Button("Finish setup") { Task { await maintenance.cancelRemoval() } }
    } message: {
      Text("Continue only after any Shellbell update or helper removal has finished. Shellbell checks that the system sleep override is off before allowing setup to continue. Closed-lid access stays off until you enable it again.")
    }
  }
}

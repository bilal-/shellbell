import ShellbellCore
import ShellbellPower
import SwiftUI

/// Native controls and a stable inline status fit the existing General page.
/// Only explicit closed-lid setup presents consent; polling never opens a panel.
struct PowerSettingsView: View {
  @ObservedObject var power: PowerController
  let setup: () -> String?
  @ObservedObject var maintenance: PowerMaintenanceActions
  @State private var showConsent = false
  @State private var setupError: String?

  private func update(_ edit: (inout PowerPreferences) -> Void) {
    var value = power.preferences
    edit(&value)
    if power.setPreferences(value) {
      setupError = nil
      power.resume()
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Toggle(
        "Keep this Mac awake",
        isOn: Binding(
          get: { power.preferences.keepAwake }, set: { value in update { $0.keepAwake = value } }))
      Text("Prevent sleep when this Mac is plugged in and remote access is enabled.")
        .font(.callout).foregroundStyle(.secondary)
      VStack(alignment: .leading, spacing: 8) {
        Toggle(
          "Allow display sleep",
          isOn: Binding(
            get: { power.preferences.allowDisplaySleep },
            set: { value in update { $0.allowDisplaySleep = value } }))
        if power.isLaptop {
          Toggle(
            "Allow system sleep when lid is closed",
            isOn: Binding(
              get: { power.preferences.allowLidSleep },
              set: { value in
                if value { update { $0.allowLidSleep = true } } else { showConsent = true }
              }))
        }
      }.padding(.leading, 20).disabled(!power.preferences.keepAwake)
      VStack(alignment: .leading, spacing: 4) {
        Text(presentation.title).font(.callout.weight(.medium))
        Text(presentation.detail).font(.caption).foregroundStyle(.secondary)
      }.frame(maxWidth: .infinity, minHeight: 42, alignment: .leading)

      if power.status == .recoveryRequired {
        Button("Retry Power Recovery") {
          power.prepareToQuit { restored in if restored { power.resume() } }
        }
      }
      if maintenance.busy {
        Text("Verifying power settings…").font(.callout).foregroundStyle(.secondary)
      }
      if let error = maintenance.error { Text(error).font(.callout).foregroundStyle(.secondary) }
      if let error = power.preferenceError {
        Text(error).font(.callout).foregroundStyle(.secondary)
      }
      if power.preferences.keepAwake && !power.preferences.allowLidSleep
        && power.status == .setupRequired
      {
        if let setupError { Text(setupError).font(.callout).foregroundStyle(.secondary) }
        Button(
          maintenance.registrationStatus == .requiresApproval
            ? "Open macOS Approval…" : "Set Up Closed-Lid Access…"
        ) {
          if maintenance.registrationStatus == .requiresApproval {
            setupError = setup()
          } else {
            showConsent = true
          }
        }
      }
    }
    .disabled(maintenance.busy)
    .alert("Enable closed-lid access?", isPresented: $showConsent) {
      Button("Cancel", role: .cancel) {}
      Button("Enable") {
        setupError = nil
        var value = power.preferences
        value.allowLidSleep = false
        guard power.setPreferences(value) else { return }
        setupError = setup()
      }
    } message: {
      Text(
        "This requires administrator approval and affects the whole Mac. It may also prevent manually selected Sleep. Do not leave an awake Mac in a bag or enclosed space. Pause other sleep-management apps before enabling closed-lid access."
      )
    }
  }
  private var presentation: PowerPresentation {
    PowerPresentation(
      status: power.status, lidActive: power.lidActive,
      idleSystemActive: power.idleSystemActive, idleDisplayActive: power.idleDisplayActive,
      approvalPending: maintenance.registrationStatus == .requiresApproval)
  }
}

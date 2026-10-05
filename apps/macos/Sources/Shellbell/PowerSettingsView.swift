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
    if power.setPreferences(value) { power.resume() }
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
        Text(title).font(.callout.weight(.medium))
        Text(detail).font(.caption).foregroundStyle(.secondary)
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
      if let setupError {
        Text(setupError).font(.callout).foregroundStyle(.secondary)
        Button("Retry Setup…") { showConsent = true }
      }
    }
    .disabled(maintenance.busy)
    .alert("Enable closed-lid access?", isPresented: $showConsent) {
      Button("Cancel", role: .cancel) {}
      Button("Enable") {
        setupError = nil
        update { $0.allowLidSleep = false }
        setupError = setup()
      }
    } message: {
      Text(
        "This requires administrator approval and affects the whole Mac. It may also prevent manually selected Sleep. Do not leave an awake Mac in a bag or enclosed space. Do not use it together with Amphetamine or another closed-lid manager."
      )
    }
      }
  private var title: String {
    switch power.status {
    case .off: "Off"
    case .waitingForPower: "Waiting for external power"
    case .waitingForService: "Waiting for remote access"
    case .checking: "Checking closed-lid protection…"
    case .active: "Active"
    case .setupRequired: "Administrator setup required"
    case .conflict: "Another sleep controller is active"
    case .recoveryRequired: "Power recovery required"
    case .maintenance: "Closed-lid access paused for maintenance"
    }
  }

  private var detail: String {
    switch power.status {
    case .off: "Normal macOS sleep settings apply."
    case .waitingForPower: "Keep-awake only operates on external power."
    case .waitingForService:
      "Start desktop remote access to keep this Mac awake. Headless services do not use these settings."
    case .checking: "Closed-lid protection is not yet verified."
    case .active:
      power.lidActive
        ? "Closed-lid protection is verified. Keep this Mac ventilated."
        : "Idle system sleep is prevented. Normal lid-close behavior is unchanged."
    case .setupRequired: "Ordinary keep-awake can continue; closed-lid protection is not active."
    case .conflict: "Close Amphetamine or the other closed-lid manager before trying again."
    case .maintenance:
      "A helper removal or update was started. Open Advanced to recover interrupted setup after that operation has finished."
    case .recoveryRequired:
      "Normal sleep behavior could not be verified. Retry recovery before quitting or removing Shellbell."
    }
  }
}

import ServiceManagement
import ShellbellCore
import ShellbellPower
import SwiftUI

struct DiagnosticsView: View {
  @ObservedObject var power: PowerController
  @ObservedObject var powerMaintenance: PowerMaintenanceActions
  @ObservedObject var model: ControllerModel
  @Binding var draft: SettingsDraft
  let reload: () -> Void
  let reconnect: () -> Void
  @State private var restartPrevious = false
  @State private var action: String?
  @State private var confirmingHeadless = false
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        HStack {
          Text("Advanced").font(.system(size: 24, weight: .semibold))
          Spacer()
          Button("Refresh") { model.loadDiagnostics() }.disabled(model.busy)
        }
        OwnershipSetupView(model: model)
        PowerMaintenanceView(power: power, maintenance: powerMaintenance)
        if ServiceControls(status: model.status).canConvertToHeadless {
          Text("Headless service").font(.headline)
          Text(
            "Run Shellbell independently of this app. Quitting the app will leave remote access available. Your paired devices and settings are kept."
          )
          .font(.callout).foregroundStyle(.secondary)
          if confirmingHeadless {
            Text(
              "This stops the desktop-owned service and starts a per-user background service. Your startup preference is kept; the app’s login item is removed."
            )
            .font(.callout).foregroundStyle(.secondary)
            HStack {
              Button("Cancel") { confirmingHeadless = false }
              Button("Switch to Headless Mode") {
                model.convertOwnership(to: "headless")
                confirmingHeadless = false
              }.disabled(!model.canMutate)
            }
          } else {
            Button("Switch to Headless Mode…") { confirmingHeadless = true }.disabled(
              !model.canMutate)
          }
        }
        Text("Relay address").font(.headline)
        TextField(
          "wss://relay.shellbell.dev",
          text: Binding(
            get: { draft.values["relay"] ?? "" }, set: { draft.values["relay"] = $0 })
        )
        .textFieldStyle(.roundedBorder)
        .accessibilityLabel("Relay address")
        .disabled(draft.revision == .null || model.phase == .busy("settings.set"))
        Text(
          "Only choose a custom relay if you trust its operator and understand its privacy practices. Use the same relay on your phone. Changing relay does not delete records from the old relay."
        )
        .font(.callout).foregroundStyle(.secondary)
        SettingsActions(model: model, draft: $draft, reload: reload)
        Divider()
        let service = ServicePresentation(status: model.status)
        ForEach(service.managerRows, id: \.self) { Text($0).font(.caption) }
        Text(service.process).font(.caption)
        Text(service.ownership).font(.caption)
        HStack {
          Button("Reconnect") { reconnect() }.disabled(model.busy)
          Button("Refresh Status") { model.refresh() }.disabled(model.busy)
          Button("Open Login Items") { SMAppService.openSystemSettingsLoginItems() }
        }
        Text(
          "Approving Shellbell does not finish a paused handoff. Refresh status, then choose Continue Setup."
        )
        .font(.caption).foregroundStyle(.secondary)
        ForEach(Array(model.diagnostics.enumerated()), id: \.offset) { _, check in
          VStack(alignment: .leading, spacing: 4) {
            Label(
              check["name"].string ?? "Check",
              systemImage: check["ok"].bool == true
                ? "checkmark.circle" : "exclamationmark.triangle")
            Text(check["detail"].string ?? "").textSelection(.enabled)
            if let fix = check["fix"].string {
              Text(fix).foregroundStyle(.secondary).textSelection(.enabled)
            }
          }
        }
        Divider()
        Text("Configured app").font(.headline)
        Text(model.status["selection"]["bundlePath"].string ?? "No native setup selected")
          .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
        Text(
          "Before moving or replacing a persistent installation, stop and disable startup. If its old app is missing, restore it to the configured path before recovery."
        )
        .font(.caption).foregroundStyle(.secondary)
        if model.status["ownership"]["mode"] == .string("legacy-native")
          && model.status["ownership"]["transition"] == .null
        {
          Text("Legacy recovery").font(.headline)
          Button("Continue Setup…") { action = "continue" }.disabled(
            model.busy || model.status["transition"] == .null)
          if model.status["recoveryAvailable"].bool == true {
            Toggle("Also restart the previous CLI service", isOn: $restartPrevious)
            Text("Restoring its definition and restarting it are separate choices.").font(.caption)
              .foregroundStyle(.secondary)
            Button("Restore Previous CLI Setup…") { action = "restore-legacy" }.disabled(model.busy)
            Button("Discard Recovery Copy…") { action = "discard-backup" }.disabled(model.busy)
          }
          Button("Remove Stopped Native Setup…") { action = "remove" }.disabled(
            model.busy || model.status == .null)
          Text(
            "Removing setup retains identity, paired devices, and any recovery copy. It requires the native service to be stopped."
          )
          .font(.caption).foregroundStyle(.secondary)
        }
      }.padding(24)
    }
    .alert(
      "Confirm setup change",
      isPresented: Binding(get: { action != nil }, set: { if !$0 { action = nil } })
    ) {
      Button("Cancel", role: .cancel) { action = nil }
      Button("Continue") {
        if action == "remove" {
          model.remove()
        } else if let action {
          model.recover(
            action: action, restartPrevious: action == "restore-legacy" && restartPrevious)
        }
        action = nil
      }
    } message: {
      Text(
        action == "restore-legacy"
          ? (restartPrevious
            ? "Restore the previous CLI definition and explicitly restart its service."
            : "Restore the previous CLI definition without restarting its service.")
          : action == "discard-backup"
            ? "Discard the retained recovery copy. This cannot be undone."
            : action == "remove"
              ? "Remove the stopped native setup while retaining identity and devices."
              : "Continue the recorded setup operation after checking its current state.")
    }
  }
}

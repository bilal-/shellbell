import ShellbellCore
import ShellbellPower
import SwiftUI

struct SettingsView: View {
  @ObservedObject var model: ControllerModel
  @ObservedObject var power: PowerController
  let section: SettingsSection
  @Binding var draft: SettingsDraft
  let reload: () -> Void
  let setupPower: () -> String?
  @ObservedObject var powerMaintenance: PowerMaintenanceActions
  @State private var stopConfirmation = false

  private var controls: ServiceControls { ServiceControls(status: model.status) }
  private var startupEnabled: Bool { model.status["ownership"]["startupEnabled"] == .bool(true) }
  private var fields: [(String, String)] {
    section == .general
      ? [("name", "Computer name"), ("accent", "Computer color")]
      : [
        ("notifyMinCommandMs", "Minimum command duration"),
        ("idleQuietMs", "Quiet time before a ring"),
        ("idleMinActiveMs", "Minimum activity before quiet"),
      ]
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        Text(section.rawValue).font(.system(size: 24, weight: .semibold))
        if section == .general {
          HStack {
            VStack(alignment: .leading, spacing: 5) {
              Label(
                controls.title,
                systemImage: controls.action == .stop ? "checkmark.circle.fill" : "circle"
              )
              .font(.headline)
              Text("Check your terminals from your phone.").foregroundStyle(.secondary)
            }
            Spacer()
            if let action = controls.action {
              Button(action == .start ? "Start Service" : "Stop Service") {
                if action == .start {
                  power.resume()
                  model.startDesktop()
                } else {
                  stopConfirmation = true
                }
              }.disabled(!model.canMutate)
            }
          }
          OwnershipSetupView(model: model)
          Divider()
          PowerSettingsView(power: power, setup: setupPower, maintenance: powerMaintenance)
          Divider()
          if controls.isDesktop {
            Toggle(
              "Start at Login",
              isOn: Binding(
                get: { startupEnabled }, set: { model.setLoginStartup($0) })
            )
            .disabled(!model.canMutate || controls.automaticStartupUnavailable)
            if controls.automaticStartupUnavailable {
              Text(
                "Start at Login is unavailable in this app build. You can still open Shellbell manually."
              )
              .font(.callout).foregroundStyle(.secondary)
            } else if model.status["desktopLogin"] == .string("requires-approval") {
              Text("Allow Shellbell in macOS Login Items to finish enabling startup.")
                .font(.callout).foregroundStyle(.secondary)
            }
            Text("Close Settings to keep Shellbell running. Quit Shellbell to stop remote access.")
              .font(.callout).foregroundStyle(.secondary)
          }
        } else {
          Text(
            "Choose when your terminal should ring. Timing values are in milliseconds (1,000 = 1 second)."
          )
          .foregroundStyle(.secondary)
        }
        VStack(alignment: .leading, spacing: 16) {
          ForEach(fields, id: \.0) { field in
            VStack(alignment: .leading, spacing: 6) {
              Text(field.1).font(.callout.weight(.medium))
              if field.0 == "accent" {
                Picker(
                  field.1,
                  selection: Binding(
                    get: { draft.values["accent"] ?? "" }, set: { draft.values["accent"] = $0 })
                ) {
                  ForEach(
                    ["emerald", "blue", "amber", "violet", "rose", "cyan", "lime", "orange"],
                    id: \.self
                  ) {
                    Text($0.capitalized).tag($0)
                  }
                  if !["emerald", "blue", "amber", "violet", "rose", "cyan", "lime", "orange"]
                    .contains(draft.values["accent"] ?? "")
                  {
                    Text("Custom").tag(draft.values["accent"] ?? "")
                  }
                }.labelsHidden().accessibilityLabel(field.1)
              } else {
                TextField(
                  field.1,
                  text: Binding(
                    get: { draft.values[field.0] ?? "" }, set: { draft.values[field.0] = $0 })
                )
                .textFieldStyle(.roundedBorder).labelsHidden().accessibilityLabel(field.1)
              }
            }
          }
        }.disabled(draft.revision == .null || model.phase == .busy("settings.set"))
        SettingsActions(model: model, draft: $draft, reload: reload)
      }.padding(28).frame(maxWidth: .infinity, alignment: .leading)
    }
    .alert("Stop Shellbell service?", isPresented: $stopConfirmation) {
      Button("Cancel", role: .cancel) {}
      Button("Stop Service") { model.stopDesktop() }
    } message: {
      Text(
        "Your phone will disconnect. Paired devices, settings, and Start at Login are kept."
      )
    }
  }
}

struct SettingsActions: View {
  @ObservedObject var model: ControllerModel
  @Binding var draft: SettingsDraft
  let reload: () -> Void
  @State private var restart = false
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Button("Reload Saved", action: reload).disabled(model.busy)
        Spacer()
        Button("Save Changes") {
          model.saveSettings(changes: draft.values, revision: draft.revision) {
            draft.replace(with: $0)
          }
        }.disabled(!model.canMutate || draft.revision == .null || draft.values.count != 6)
      }
      // Reserve space so save/apply state never moves surrounding fields.
      HStack {
        Text(
          model.status["ownership"]["mode"] == .string("headless")
            && model.settingsApplied == "restart-required"
            ? "Saved. Run shellbell service restart in Terminal to apply your changes."
            : model.settingsApplied == "restart-required"
              ? "Saved. Restart to apply your changes."
              : model.settingsApplied == "matches"
                ? "Your saved settings are in use."
                : "Saved settings apply when the service starts."
        )
        .font(.caption).foregroundStyle(.secondary)
        Spacer()
        if model.status["ownership"]["mode"] != .string("headless") {
          Button("Restart…") { restart = true }.disabled(!model.canRestartService)
        }
      }.frame(minHeight: 32)
    }.alert("Restart service?", isPresented: $restart) {
      Button("Cancel", role: .cancel) {}
      Button("Restart") { model.restart() }
    } message: {
      Text("Connected devices will briefly disconnect. Your saved settings will be applied.")
    }
  }
}

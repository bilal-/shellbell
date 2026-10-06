import ShellbellCore
import ShellbellPower
import SwiftUI

struct PowerSettingsView: View {
  @ObservedObject var power: PowerController
  let setup: () -> String?
  @ObservedObject var maintenance: PowerMaintenanceActions
  @State private var showConsent = false
  @State private var setupError: String?

  @discardableResult private func update(_ edit: (inout PowerPreferences) -> Void) -> Bool {
    var value = power.preferences
    edit(&value)
    guard power.setPreferences(value) else { return false }
    setupError = nil
    power.resume()
    return true
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Label("Keep awake", systemImage: "bolt.circle").font(.headline)
      VStack(alignment: .leading, spacing: 5) {
        Toggle("Keep this Mac awake", isOn: Binding(
          get: { power.preferences.keepAwake }, set: { newValue in update { $0.keepAwake = newValue } }))
        Text("Prevent idle sleep while Shellbell’s desktop remote access is running.")
          .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      }.disabled(maintenance.busy)

      VStack(alignment: .leading, spacing: 10) {
        if power.isLaptop {
          VStack(alignment: .leading, spacing: 4) {
            Toggle("Include battery power", isOn: Binding(
              get: { power.preferences.keepAwakeOnBattery },
              set: { newValue in update { $0.keepAwakeOnBattery = newValue } }))
            Text("Uses more battery. When off, keep-awake pauses when unplugged.")
              .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
          }
        }
        Toggle("Keep display on", isOn: Binding(
          get: { !power.preferences.allowDisplaySleep },
          set: { newValue in update { $0.allowDisplaySleep = !newValue } }))
        if power.isLaptop {
          VStack(alignment: .leading, spacing: 4) {
            Toggle("Keep awake with lid closed", isOn: Binding(
              get: { !power.preferences.allowLidSleep },
              set: { enabled in
                if enabled { showConsent = true }
                else { update { $0.allowLidSleep = true } }
              }))
            Text("Requires a power adapter and administrator approval. Keep the Mac ventilated.")
              .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
          }
        }
      }.padding(.leading, 20).disabled(!power.preferences.keepAwake || maintenance.busy)

      VStack(alignment: .leading, spacing: 8) {
        Text(presentation.title).font(.callout.weight(.semibold))
        Text(presentation.detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        Divider()
        statusRow("Idle protection", presentation.idle, active: power.idleSystemHealth == .active)
        statusRow("Display", presentation.display, active: power.idleDisplayHealth == .active)
        if power.isLaptop {
          statusRow("Lid closed", presentation.lid, active: power.lidActive)
        }
      }.padding(12).background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 8))

      if let warning = presentation.systemWarning {
        Label(warning, systemImage: "exclamationmark.triangle")
          .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      }
      if power.isLaptop && power.preferences.keepAwake && !power.preferences.allowLidSleep
        && maintenance.registrationStatus != .enabled
      {
        Button(maintenance.registrationStatus == .requiresApproval
          ? "Open macOS approval…" : "Set up closed-lid access…") {
          if maintenance.registrationStatus == .requiresApproval { setupError = setup() }
          else { showConsent = true }
        }.disabled(maintenance.busy)
      }
      if power.closedLidInterrupted {
        Button("Retry closed-lid access") { power.retryClosedLid() }.disabled(maintenance.busy)
      }
      if power.status == .recoveryRequired {
        Button("Retry power recovery") {
          power.prepareToQuit { restored in if restored { power.resume() } }
        }.disabled(maintenance.busy)
      }
      if maintenance.busy {
        HStack(spacing: 8) {
          ProgressView().controlSize(.small)
          Text("Verifying power settings…").font(.callout)
        }
      }
      if let error = setupError { Text("Last setup attempt: \(error)").font(.caption).foregroundStyle(.red) }
      if let error = maintenance.error { Text("Last maintenance attempt: \(error)").font(.caption).foregroundStyle(.red) }
      if let error = power.preferenceError { Text(error).font(.caption).foregroundStyle(.red) }

      DisclosureGroup("macOS power details") {
        VStack(alignment: .leading, spacing: 8) {
          statusRow("System sleep override", presentation.systemSleep)
          statusRow("Other idle requests", presentation.otherIdle)
          statusRow("Other display requests", presentation.otherDisplay)
          Text("Shows changes from Terminal and other apps. macOS can’t always identify who changed a setting.")
            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }.padding(.top, 8)
      }.font(.callout)
    }
    .onChange(of: power.closedLidStatus) { value in if value == .active { setupError = nil } }
    .alert("Keep this Mac awake with lid closed?", isPresented: $showConsent) {
      Button("Cancel", role: .cancel) {}
      Button("Enable closed-lid access") {
        guard update({ $0.allowLidSleep = false }) else { return }
        setupError = setup()
      }
    } message: {
      Text("Requires a power adapter and administrator approval. While active, this changes a system-wide setting and can prevent manual Sleep. Keep the Mac ventilated and out of bags. Stop other closed-lid sleep controls first.")
    }
  }

  private func statusRow(_ label: String, _ value: String, active: Bool = false) -> some View {
    HStack(alignment: .firstTextBaseline) {
      Text(label).foregroundStyle(.secondary)
      Spacer(minLength: 12)
      Text(value).fontWeight(active ? .semibold : .medium).foregroundStyle(.primary)
        .multilineTextAlignment(.trailing)
    }.font(.callout).accessibilityElement(children: .combine)
  }

  private var presentation: PowerPresentation {
    PowerPresentation(
      status: power.status, closedLidStatus: power.closedLidStatus,
      idleSystemHealth: power.idleSystemHealth, idleDisplayHealth: power.idleDisplayHealth,
      powerSource: power.powerSource,
      approvalPending: maintenance.registrationStatus == .requiresApproval,
      systemObservation: power.systemObservation)
  }
}

import AppKit
import ShellbellCore
import ShellbellPower
import SwiftUI

struct ShellbellMark: View {
  var size: CGFloat = 36
  var body: some View {
    Group {
      if let url = Bundle.main.url(forResource: "ShellbellService", withExtension: "icns"),
        let image = NSImage(contentsOf: url)
      {
        Image(nsImage: image).resizable().aspectRatio(contentMode: .fit)
      } else {
        Image(systemName: "terminal").resizable().aspectRatio(contentMode: .fit)
      }
    }.frame(width: size, height: size).accessibilityHidden(true)
  }
}

struct WorkspaceView: View {
  @ObservedObject var model: ControllerModel
  @ObservedObject var power: PowerController
  @ObservedObject var navigation: WorkspaceNavigation
  let select: (SettingsSection) -> Void
  let pair: () -> Void
  let reconnect: () -> Void
  let setupPower: () -> String?
  @ObservedObject var powerMaintenance: PowerMaintenanceActions
  @State private var draft = SettingsDraft()
  @State private var reloadRequested = false

  var body: some View {
    HStack(spacing: 0) {
      VStack(alignment: .leading, spacing: 24) {
        HStack(spacing: 10) {
          ShellbellMark()
          Text("Shellbell").font(.system(size: 18, weight: .semibold))
        }.padding(.top, 8)
        VStack(spacing: 5) {
          ForEach(SettingsSection.allCases) { section in
            Button {
              select(section)
            } label: {
              Label(section.rawValue, systemImage: section.symbol)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(
                  navigation.section == section ? Color.accentColor.opacity(0.14) : .clear,
                  in: RoundedRectangle(cornerRadius: 7))
            }.buttonStyle(.plain)
              .accessibilityLabel(section.rawValue)
              .accessibilityAddTraits(navigation.section == section ? .isSelected : [])
          }
        }
        Spacer()
        Text(
          "Shellbell \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.1")"
        )
        .font(.caption).foregroundStyle(.secondary)
      }.padding(20).frame(width: 200)
        .background(Color(nsColor: .windowBackgroundColor))
      Divider()
      VStack(spacing: 0) {
        switch navigation.section {
        case .general, .notifications:
          SettingsView(
            model: model, power: power, section: navigation.section, draft: $draft,
            reload: reload, setupPower: setupPower, powerMaintenance: powerMaintenance)
        case .devices:
          if navigation.pairingVisible {
            PairingView(
              model: model,
              done: {
                model.closePairing()
                navigation.pairingVisible = false
                model.loadDevices()
              })
          } else {
            DevicesView(model: model, pair: pair)
          }
        case .advanced:
          DiagnosticsView(
            power: power, powerMaintenance: powerMaintenance,
            model: model, draft: $draft, reload: reload, reconnect: reconnect)
        }
        Divider()
        StatusNotice(model: model)
          .padding(.horizontal, 24).padding(.vertical, 8)
      }.frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .controlBackgroundColor))
    }.frame(maxWidth: .infinity, maxHeight: .infinity)
      .onReceive(model.$settings) { settings in
        guard !model.busy else { return }
        if reloadRequested {
          draft.replace(with: settings)
          reloadRequested = false
        } else {
          draft.receive(settings)
        }
      }
  }
  private func reload() {
    reloadRequested = true
    model.refreshSettings()
  }
}

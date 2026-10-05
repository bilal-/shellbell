import ShellbellCore
import SwiftUI

struct DevicesView: View {
  @ObservedObject var model: ControllerModel
  let pair: () -> Void
  @State private var selected: JSONValue?
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack {
        Text("Devices").font(.title2)
        Spacer()
        Button("Pair Device…", action: pair).disabled(!model.serviceAvailable)
        Button("Refresh") { model.loadDevices() }.disabled(model.busy)
      }
      if model.devices.isEmpty {
        Text("No paired devices yet. Connect your phone to check your terminals from anywhere.")
          .foregroundStyle(.secondary)
        Spacer()
      } else {
        List(Array(model.devices.enumerated()), id: \.offset) { _, phone in
          VStack(alignment: .leading, spacing: 8) {
            HStack {
              Text(phone["name"].string ?? "Device").font(.headline)
              Spacer()
              Button("Revoke…") { selected = phone }.disabled(!model.serviceAvailable)
            }
            Text(phone["phoneFp"].string ?? "").font(.system(.caption, design: .monospaced))
              .textSelection(.enabled)
            Text(phone["lastSeenAt"].string.map { "Last seen \($0)" } ?? "Not seen yet").font(
              .caption
            ).foregroundStyle(.secondary)
          }.padding(.vertical, 8)
        }
      }
    }.padding(24)
      .alert(
        "Revoke device?",
        isPresented: Binding(get: { selected != nil }, set: { if !$0 { selected = nil } })
      ) {
        Button("Cancel", role: .cancel) { selected = nil }
        Button("Revoke", role: .destructive) {
          if let fingerprint = selected?["phoneFp"].string { model.revoke(fingerprint) }
          selected = nil
        }
      } message: {
        Text(
          "\(selected?["name"].string ?? "Device")\n\(selected?["phoneFp"].string ?? "")\nThis exact device will lose access. It can be paired again later."
        )
      }
  }
}

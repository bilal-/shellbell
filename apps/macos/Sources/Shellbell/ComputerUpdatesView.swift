import ShellbellCore
import SwiftUI

struct ComputerUpdatesView: View {
  @StateObject private var updates: ComputerUpdates

  init() {
    let system = ProcessInfo.processInfo.operatingSystemVersion
    #if arch(arm64)
      let arm64 = true
    #else
      let arm64 = false
    #endif
    _updates = StateObject(wrappedValue: ComputerUpdates(
      version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0",
      build: Int(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0") ?? 0,
      arm64: arm64, osVersion: "\(system.majorVersion).\(system.minorVersion).\(system.patchVersion)",
      clock: DispatchBridgeClock(), makeTransport: {
        let account = try LaunchPlan.account()
        let plan = try LaunchPlan(bundle: Bundle.main.bundlePath, home: account.home,
          user: account.user, updateCheck: true)
        try plan.validateFiles()
        return try ProcessBridgeTransport(plan: plan)
      }))
  }

  var body: some View {
    GroupBox {
      VStack(alignment: .leading, spacing: 10) {
        Text("Updates").font(.headline)
        Text("Installed: \(updates.version) (build \(updates.build))").font(.callout)
        Text(updates.message).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        HStack {
          Button(updates.checking ? "Checking…" : "Check for Updates") { updates.check() }
            .disabled(updates.checking)
          if updates.checking { ProgressView().controlSize(.small) }
          if let offer = updates.offer {
            Link("Release Notes", destination: offer.notes)
            if let download = offer.download { Link("Download Mac App", destination: download) }
          }
        }
        Text("Checking contacts GitHub. No automatic checks or app downloads.")
          .font(.caption).foregroundStyle(.secondary)
        Link("Installation Guide", destination: URL(string: "https://github.com/bilal-/shellbell/blob/main/apps/macos/README.md#install-the-published-mac-app")!)
          .font(.callout)
      }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
    }.onDisappear { updates.cancel() }
  }
}

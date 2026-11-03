import ShellbellCore
import SwiftUI

struct ComputerUpdatesView: View {
  @StateObject private var updates: ComputerUpdates
  @StateObject private var installer: MacAppInstaller

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
    let bundle = Bundle.main.bundleURL
    let account = try? LaunchPlan.account()
    let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    let workRoot = caches.appendingPathComponent("sh.bilal.shellbell.host/Updates")
    // A window opened mid-install, or after one failed, shows that install rather than a new one.
    _installer = StateObject(wrappedValue: MacAppInstaller.current ?? MacAppInstaller(
      target: bundle,
      workRoot: workRoot,
      steps: SystemMacAppInstallSteps(
        bundle: bundle.path, home: account?.home ?? NSHomeDirectory(),
        user: account?.user ?? NSUserName(),
        bundleID: Bundle.main.bundleIdentifier ?? "sh.bilal.shellbell.host"),
      startSwap: { staged, target, lock in
        let info = Bundle.main.infoDictionary
        return try MacAppSwap.start(
          pid: ProcessInfo.processInfo.processIdentifier, staged: staged, target: target,
          trash: MacAppSwap.trashDestination(
            home: account?.home ?? NSHomeDirectory(),
            version: info?["CFBundleShortVersionString"] as? String ?? "old",
            build: info?["CFBundleVersion"] as? String ?? "0"),
          workRoot: workRoot, lock: lock)
      },
      quit: { NSApp.terminate(nil) }))
  }

  private var installText: String? {
    switch installer.state {
    case .idle: nil
    case .downloading: "Downloading the update…"
    case .checking: "Checking the update…"
    case .restarting: "Restarting Shellbell…"
    case .failed(let failure) where failure.downloadHelps:
      "Couldn’t install the update: \(failure.reason). You can download it and install it yourself instead."
    case .failed(.busy):
      "Couldn’t install the update: another copy of Shellbell is installing one. Try again in a minute."
    case .failed(let failure):
      "Nothing to install: \(failure.reason)."
    }
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
            if offer.download != nil {
              Button("Install and Restart") { installer.install(version: offer.version, build: offer.build) }
                .disabled(installer.busy)
            }
            Link("Release Notes", destination: offer.notes)
            if let download = offer.download, case .failed(let failure) = installer.state,
              failure.downloadHelps
            {
              Link("Download Mac App", destination: download)
            }
          }
          if installer.busy { ProgressView().controlSize(.small) }
        }
        if let installText {
          Text(installText).font(.callout).foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        Text(
          "Checking contacts GitHub; Shellbell never checks on its own. Install and Restart downloads the update, checks it’s signed by Shellbell’s developer, then quits, updates and opens Shellbell again. Your phone reconnects by itself."
        )
          .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        Link("Installation Guide", destination: URL(string: "https://github.com/bilal-/shellbell/blob/main/apps/macos/README.md#install-the-published-mac-app")!)
          .font(.callout)
      }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
    }.onDisappear { if !installer.busy { updates.cancel() } }
  }
}

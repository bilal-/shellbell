import AppKit
import ServiceManagement
import ShellbellCore
import ShellbellPower
import SwiftUI

@MainActor final class UnavailableConnection: ControllerConnection {
  var onEvent: ((JSONValue) -> Void)?
  var onClosed: (() -> Void)?
  var isReady = false
  func connect(_ completion: @escaping (Result<JSONValue, BridgeFailure>) -> Void) {
    // The controller couldn't start; report it like a lost connection so recovery retries.
    onClosed?()
    completion(.failure(.unavailable))
  }
  func request(
    _ command: String, args: JSONValue?,
    completion: @escaping (Result<JSONValue, BridgeFailure>) -> Void
  ) { completion(.failure(.unavailable)) }
  func close() {}
}

enum SettingsSection: String, CaseIterable, Identifiable {
  case general = "General"
  case terminals = "Terminals"
  case devices = "Devices"
  case notifications = "Notifications"
  case advanced = "Advanced"
  var id: String { rawValue }
  var symbol: String {
    switch self {
    case .general: "slider.horizontal.3"
    case .terminals: "terminal"
    case .devices: "iphone"
    case .notifications: "bell"
    case .advanced: "gearshape.2"
    }
  }
  var readName: String {
    switch self {
    case .general, .notifications: "Settings"
    case .devices: "Devices"
    case .terminals: "Terminals"
    case .advanced: "Advanced"
    }
  }
}

@MainActor final class WorkspaceNavigation: ObservableObject {
  @Published var section: SettingsSection = .general
  @Published var pairingVisible = false
}

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
  private(set) var model = ControllerModel(connection: UnavailableConnection())
  private var menu: MenuController?
  private var window: NSWindow?
  private var navigation = WorkspaceNavigation()
  private var timer: Timer?
  private var powerTimer: Timer?
  private var terminalsTimer: Timer?
  private let powerSource = PowerSourceObserver()
  private let powerSystem = PowerSystemObserver()
  private var powerState = PowerSourceState(power: .unknown, isLaptop: false)
  private let powerRegistration = PowerHelperRegistration()
  private lazy var powerMaintenance = PowerMaintenanceActions(
    registration: powerRegistration,
    setClosedLidEnabled: { [weak self] enabled in
      guard let self else { return }
      var preferences = self.power.preferences
      preferences.allowLidSleep = !enabled
      self.power.setPreferences(preferences)
    },
    preparePower: { [weak self] completion in
      guard let self else {
        completion(false)
        return
      }
      self.power.prepareToQuit { restored in
        if restored { self.power.closeConnection() }
        completion(restored)
      }
    },
    finishPower: { [weak self] in self?.power.resume() },
    makeClient: {
      PowerClient(transport: try NativePowerClientTransport(), clock: DispatchBridgeClock())
    })
  private let quitCoordinator = PowerQuitCoordinator()
  private lazy var power: PowerController = {
    return PowerController(
      preferences: PowerPreferences.startSession(defaults: .standard),
      assertions: PowerAssertionController(adapter: IdleAssertionAdapter()),
      helperAvailable: { [weak self] in self?.powerRegistration.status == .enabled },
      helperFactory: {
        PowerClient(transport: try NativePowerClientTransport(), clock: DispatchBridgeClock())
      },
      eligibility: { [weak self] in
        guard let self else {
          return .init(
            power: .unknown, desktopServiceVerified: false, statusFresh: false, isLaptop: false)
        }
        return self.model.powerEligibility(
          power: self.powerState.power, isLaptop: self.powerState.isLaptop)
      },
      observation: { [weak self] in self?.powerSystem.observation },
      refreshService: { [weak self] in self?.model.refreshInBackground() },
      now: { ProcessInfo.processInfo.systemUptime })
  }()
  private var terminating = false
  private var started = false
  /// Brings remote access back after the controller connection is lost, waiting a little longer
  /// after each failed try. Remote access restarts only if it was running when it was lost.
  private var recoveryTimer: Timer?
  private var recoveryDelay: TimeInterval = 1
  private var recoveryRestartsRemoteAccess = false
  private var lastRecovery: Date?
  private let consent = LegalConsent()

  func applicationDidFinishLaunching(_ notification: Notification) {
    guard consent.hasAcceptedTerms || requestTermsConsent() else {
      NSApp.terminate(nil)
      return
    }
    started = true
    replaceConnection(launchDesktop: true)
    powerSystem.start { [weak self] in self?.power.tick() }
    powerSource.start { [weak self] state in
      guard let self else { return }
      self.powerState = state
      self.powerSystem.refresh(force: true)
      self.power.tick()
    }
    // Power freshness/renewal must continue with both menu and Settings closed. With keep-awake
    // off and nothing left to restore, only an open Settings window reads system power state.
    let powerTimer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        let showing = self.window?.isVisible == true
        if showing || self.power.needsSystemObservation {
          self.powerSystem.refresh()
        }
        self.power.tick()
        if showing { self.powerMaintenance.refresh() }
      }
    }
    self.powerTimer = powerTimer
    RunLoop.main.add(powerTimer, forMode: .common)
    let timer = Timer(timeInterval: 5, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        if self.menu?.visible == true || self.window?.isVisible == true { self.model.tick() }
        // Read status even with nothing open, so a service that stopped by itself is noticed
        // and started again. Do not update a menu while it is being tracked.
        if self.menu?.visible != true && self.model.phase == .idle {
          self.model.refreshInBackground(ifOlderThan: 4.5)
        }
      }
    }
    self.timer = timer
    RunLoop.main.add(timer, forMode: .common)
    // Keeps "iTerm2 needs attention…" in the menu current while no window is open.
    let terminalsTimer = Timer(timeInterval: 30, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self, self.menu?.visible != true, self.model.phase == .idle else { return }
        self.model.loadTerminals()
      }
    }
    self.terminalsTimer = terminalsTimer
    RunLoop.main.add(terminalsTimer, forMode: .common)
  }

  private func requestTermsConsent() -> Bool {
    let alert = NSAlert()
    alert.messageText = "Before you connect"
    alert.informativeText =
      "Shellbell gives paired devices access to your computer’s terminals. Commands can read, change or delete data. Only pair devices you trust.\n\n"
      + "This is a free, open source project with voluntary hosting and support. Security, availability and notification delivery are not guaranteed.\n\n"
      + "By selecting Agree, you accept the Terms of Use. The Privacy notice explains data handling. Your MIT License rights remain unchanged."
    alert.addButton(withTitle: "Agree")
    alert.addButton(withTitle: "Decline")
    alert.accessoryView = NSHostingView(
      rootView:
        HStack(spacing: 20) {
          Link("Terms of Use", destination: LegalConsent.termsURL)
          Link("Privacy", destination: LegalConsent.privacyURL)
        }.frame(width: 300, height: 36, alignment: .leading))
    NSApp.activate(ignoringOtherApps: true)
    guard alert.runModal() == .alertFirstButtonReturn else { return false }
    consent.acceptTerms()
    return true
  }

  func reconnect() {
    guard !model.busy, !terminating else { return }
    // Replacing the connection stops its service, so bring back remote access that was running,
    // or that was lost with an earlier connection.
    let launch =
      (model.connectionLost && recoveryRestartsRemoteAccess)
      || (!model.connectionLost && model.remoteAccessRunning)
    power.prepareToQuit { [weak self] restored in
      guard let self else { return }
      guard restored else {
        self.show("Settings")
        return
      }
      self.power.closeConnection()
      self.replaceConnection(launchDesktop: launch, afterLoss: true)
      self.power.resume()
    }
  }

  private func connectionLost(remoteAccessWasRunning: Bool) {
    guard !terminating else { return }
    recoveryRestartsRemoteAccess = recoveryRestartsRemoteAccess || remoteAccessWasRunning
    // A connection that held for a while starts the backoff afresh.
    if let lastRecovery, Date().timeIntervalSince(lastRecovery) > 120 { recoveryDelay = 1 }
    recoveryTimer?.invalidate()
    let timer = Timer(timeInterval: recoveryDelay, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.recover() }
    }
    recoveryTimer = timer
    RunLoop.main.add(timer, forMode: .common)
    recoveryDelay = min(recoveryDelay * 2, 30)
  }

  private func recover() {
    recoveryTimer = nil
    guard !terminating, model.connectionLost else { return }
    guard !model.busy, !powerMaintenance.busy else {
      connectionLost(remoteAccessWasRunning: false)
      return
    }
    let launch = recoveryRestartsRemoteAccess
    power.prepareToQuit { [weak self] restored in
      guard let self, !self.terminating else { return }
      guard restored else {
        // Closed-lid cleanup isn't verified yet; Settings shows its recovery. Try again later.
        self.power.resume()
        self.connectionLost(remoteAccessWasRunning: false)
        return
      }
      self.lastRecovery = Date()
      self.recoveryRestartsRemoteAccess = false
      self.power.closeConnection()
      self.replaceConnection(launchDesktop: launch, afterLoss: true)
      self.power.resume()
    }
  }

  func startDesktop() {
    power.resume()
    model.startDesktop()
  }

  private func replaceConnection(launchDesktop: Bool, afterLoss: Bool = false) {
    guard !model.busy else { return }
    let reopen = window?.isVisible == true
    let selected = navigation.section
    window?.close()
    window = nil
    model.disconnectForReconnect()
    do {
      let transport = try ProcessBridgeTransport(plan: ServiceLauncher.plan())
      model = ControllerModel(
        connection: BridgeClient(transport: transport, clock: DispatchBridgeClock()))
    } catch { model = ControllerModel(connection: UnavailableConnection()) }
    model.onConnectionLost = { [weak self] running in
      self?.connectionLost(remoteAccessWasRunning: running)
    }
    navigation = WorkspaceNavigation()
    navigation.section = selected
    menu = MenuController(app: self, model: model)
    // Ask first: a controller that fails to start must still leave this intent for recovery.
    if launchDesktop { model.launchDesktopIfConsented(afterLoss: afterLoss) }
    model.connect()
    if reopen { show(selected == .advanced ? "Diagnostics" : "Settings") }
  }

  func select(_ section: SettingsSection) {
    if section != .devices && navigation.pairingVisible {
      navigation.pairingVisible = false
      model.closePairing()
    }
    navigation.section = section
    model.activateWindow(section.readName)
  }

  func pairDevice() {
    navigation.section = .devices
    navigation.pairingVisible = true
    model.openPairing()
  }

  func show(_ name: String) {
    if name == "Pair Device" {
      pairDevice()
      model.activateWindow("Devices")
    } else {
      select(
        name == "Devices"
          ? .devices
          : name == "Diagnostics" ? .advanced : name == "Terminals" ? .terminals : .general)
    }
    if window == nil {
      let content = WorkspaceView(
        model: model, power: power, navigation: navigation, select: select, pair: pairDevice,
        reconnect: reconnect, powerMaintenance: powerMaintenance
      )
      let hosting = NSHostingController(rootView: content)
      // SwiftUI's intrinsic size must not resize the window during status/QR updates.
      hosting.sizingOptions = []
      let created = NSWindow(contentViewController: hosting)
      created.title = "Shellbell"
      created.identifier = NSUserInterfaceItemIdentifier("Shellbell Settings")
      created.styleMask = [.titled, .closable, .miniaturizable, .resizable]
      created.setContentSize(NSSize(width: 820, height: 700))
      created.minSize = NSSize(width: 740, height: 580)
      created.isReleasedWhenClosed = false
      created.delegate = self
      created.setFrameAutosaveName("ShellbellSettings")
      created.center()
      window = created
    }
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool
  {
    guard started else { return true }
    show("Settings")
    return true
  }
  func windowDidBecomeKey(_ notification: Notification) {
    model.activateWindow(navigation.section.readName)
  }
  func windowWillClose(_ notification: Notification) {
    model.closePairing()
    navigation.pairingVisible = false
    window = nil
  }
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard started else { return .terminateNow }
    if powerMaintenance.busy {
      show("Settings")
      return .terminateCancel
    }
    if terminating { return .terminateLater }
    terminating = true
    recoveryTimer?.invalidate()
    recoveryTimer = nil
    // A lost connection can't confirm anything. A fresh controller can confirm remote access
    // ended with the old one, so Quit doesn't get stuck behind "could not be verified".
    if model.connectionLost {
      power.closeConnection()
      replaceConnection(launchDesktop: false)
      model.requireQuitCheck()
    }
    quitCoordinator.quit(
      releasePower: { self.power.prepareToQuit($0) }, stopService: { self.model.quit($0) }
    ) { [weak self] outcome in
      DispatchQueue.main.async {
        guard let self else {
          sender.reply(toApplicationShouldTerminate: false)
          return
        }
        self.terminating = false
        sender.reply(toApplicationShouldTerminate: outcome.complete)
        if !outcome.complete {
          // A successful service quit closes its bridge. Reopen only the control
          // bridge, never remote access, so a power-recovery retry can still quit.
          if outcome.serviceStopped {
            self.replaceConnection(launchDesktop: false)
          } else if outcome.powerRestored {
            self.power.resume()
          }
          self.show("Settings")
          self.model.refresh()
        }
      }
    }
    return .terminateLater
  }
  static func confirm(_ title: String, detail: String, action: String) -> Bool {
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = detail
    alert.addButton(withTitle: action)
    alert.addButton(withTitle: "Cancel")
    return alert.runModal() == .alertFirstButtonReturn
  }
}

struct StatusNotice: View {
  @ObservedObject var model: ControllerModel
  var body: some View {
    // A shared footer keeps status changes from moving the settings content.
    Text(model.notice ?? "")
      .font(.callout).foregroundStyle(.secondary)
      .frame(maxWidth: .infinity, minHeight: 42, maxHeight: 42, alignment: .topLeading)
      .accessibilityHidden(model.notice == nil)
  }
}

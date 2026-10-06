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
  case devices = "Devices"
  case notifications = "Notifications"
  case advanced = "Advanced"
  var id: String { rawValue }
  var symbol: String {
    switch self {
    case .general: "slider.horizontal.3"
    case .devices: "iphone"
    case .notifications: "bell"
    case .advanced: "gearshape.2"
    }
  }
  var readName: String {
    switch self {
    case .general, .notifications: "Settings"
    case .devices: "Devices"
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
  private let powerSource = PowerSourceObserver()
  private let powerSystem = PowerSystemObserver()
  private var powerState = PowerSourceState(power: .unknown, isLaptop: false)
  private let powerRegistration = PowerHelperRegistration()
  private lazy var powerMaintenance = PowerMaintenanceActions(
    registration: powerRegistration,
    disableClosedLid: { [weak self] in
      guard let self else { return false }
      var preferences = self.power.preferences
      preferences.allowLidSleep = true
      return self.power.setPreferences(preferences)
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
    let store = PowerPreferencesStore(defaults: .standard)
    return PowerController(
      preferences: store.load(),
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
      now: { ProcessInfo.processInfo.systemUptime }, save: { try store.save($0) })
  }()
  private var terminating = false

  func applicationDidFinishLaunching(_ notification: Notification) {
    replaceConnection(launchDesktop: true)
    powerSystem.start { [weak self] in self?.power.tick() }
    powerSource.start { [weak self] state in
      guard let self else { return }
      self.powerState = state
      self.powerSystem.refresh(force: true)
      self.power.tick()
    }
    // Power freshness/renewal must continue with both menu and Settings closed.
    let powerTimer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated {
        self?.powerSystem.refresh()
        self?.power.tick()
        self?.powerMaintenance.refresh()
      }
    }
    self.powerTimer = powerTimer
    RunLoop.main.add(powerTimer, forMode: .common)
    let timer = Timer(timeInterval: 5, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self, self.menu?.visible == true || self.window?.isVisible == true else { return }
        self.model.tick()
        // Do not update a menu while it is being tracked, or move an editor's content.
        if self.menu?.visible != true && self.model.phase == .idle {
          self.model.refreshInBackground()
        }
      }
    }
    self.timer = timer
    RunLoop.main.add(timer, forMode: .common)
  }

  func reconnect() {
    guard !model.busy, !terminating else { return }
    power.prepareToQuit { [weak self] restored in
      guard let self else { return }
      guard restored else {
        self.show("Settings")
        return
      }
      self.power.closeConnection()
      self.replaceConnection(launchDesktop: false)
      self.power.resume()
    }
  }

  func startDesktop() {
    power.resume()
    model.startDesktop()
  }

  private func setupPower() -> String? {
    guard !powerMaintenance.busy else { return "Wait for power maintenance to finish." }
    do {
      let status = try powerRegistration.requestSetup(consented: true)
      if status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
      power.resume()
      return nil
    } catch PowerHelperRegistration.Failure.legacyInstallation {
      return
        "An older Shellbell power helper is installed. Remove it using the older app before setting up this version."
    } catch is PowerPeerVerifier.Failure {
      return
        "Shellbell's publisher could not be verified. Install a signed Shellbell build and try again."
    } catch PowerHelperRegistration.Failure.unavailable {
      return "The power helper is unavailable. Reinstall Shellbell and try setup again."
    } catch {
      let failure = error as NSError
      NSLog("Shellbell power helper setup failed (%@:%ld)", failure.domain, failure.code)
      return
        "macOS could not complete power helper setup. Check Shellbell in System Settings → General → Login Items & Extensions, then retry."
    }
  }
  private func replaceConnection(launchDesktop: Bool) {
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
    navigation = WorkspaceNavigation()
    navigation.section = selected
    menu = MenuController(app: self, model: model)
    model.connect()
    if launchDesktop { model.launchDesktopIfConsented() }
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
      select(name == "Devices" ? .devices : name == "Diagnostics" ? .advanced : .general)
    }
    if window == nil {
      let content = WorkspaceView(
        model: model, power: power, navigation: navigation, select: select, pair: pairDevice,
        reconnect: reconnect, setupPower: setupPower, powerMaintenance: powerMaintenance
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
    if powerMaintenance.busy {
      show("Settings")
      return .terminateCancel
    }
    if terminating { return .terminateLater }
    terminating = true
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

import AppKit
import Combine
import ShellbellCore

@MainActor final class MenuController: NSObject, NSMenuDelegate {
  private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
  private unowned let app: AppDelegate
  private let model: ControllerModel
  private var observation: AnyCancellable?
  private var scheduled = false
  private(set) var visible = false

  init(app: AppDelegate, model: ControllerModel) {
    self.app = app
    self.model = model
    super.init()
    if let url = Bundle.main.url(forResource: "ShellbellTemplate", withExtension: "png"),
      let image = NSImage(contentsOf: url)
    {
      if let retina = Bundle.main.url(forResource: "ShellbellTemplate@2x", withExtension: "png"),
        let bytes = try? Data(contentsOf: retina), let rep = NSBitmapImageRep(data: bytes)
      {
        rep.size = NSSize(width: 18, height: 18)
        image.addRepresentation(rep)
      }
      image.isTemplate = true
      image.size = NSSize(width: 18, height: 18)
      item.button?.image = image
    } else {
      item.button?.title = "Shellbell"
    }
    item.button?.setAccessibilityLabel("Shellbell")
    rebuild()
    observation = model.objectWillChange.sink { [weak self] in
      guard let self, !self.scheduled else { return }
      self.scheduled = true
      DispatchQueue.main.async { [weak self] in
        self?.scheduled = false
        if self?.visible == false { self?.rebuild() }
      }
    }
  }
  deinit { MainActor.assumeIsolated { NSStatusBar.system.removeStatusItem(item) } }
  func menuWillOpen(_ menu: NSMenu) {
    visible = true
    if model.phase == .idle { model.refresh() }
  }
  func menuDidClose(_ menu: NSMenu) {
    visible = false
    rebuild()
  }

  private func rebuild() {
    let menu = NSMenu()
    menu.delegate = self
    menu.autoenablesItems = false
    let controls = ServiceControls(status: model.status)
    let status = NSMenuItem(title: controls.title, action: nil, keyEquivalent: "")
    status.isEnabled = false
    menu.addItem(status)
    menu.addItem(.separator())
    if let primary = controls.action {
      action(
        primary == .start ? "Start Service" : "Stop Service…",
        primary == .start ? "start" : "stop", enabled: model.canMutate, in: menu)
    } else {
      action("Review Service…", "Diagnostics", in: menu)
    }
    action("Pair Device…", "Pair Device", key: "p", enabled: model.serviceAvailable, in: menu)
    action("Settings…", "Settings", key: ",", in: menu)
    menu.addItem(.separator())
    action("Quit Shellbell", "quit", key: "q", in: menu)
    item.menu = menu
  }

  private func action(
    _ title: String, _ command: String, key: String = "", enabled: Bool = true, in menu: NSMenu
  ) {
    let entry = NSMenuItem(title: title, action: #selector(invoke(_:)), keyEquivalent: key)
    entry.target = self
    entry.representedObject = command
    entry.isEnabled = enabled
    menu.addItem(entry)
  }
  @objc private func invoke(_ sender: NSMenuItem) {
    guard let command = sender.representedObject as? String else { return }
    switch command {
    case "start":
      guard ServiceControls(status: model.status).action == .start else { return }
      app.startDesktop()
    case "stop":
      guard ServiceControls(status: model.status).action == .stop else { return }
      if AppDelegate.confirm(
        "Stop Shellbell service?",
        detail:
          "Your phone will disconnect. Paired devices, settings, and Start at Login are kept.",
        action: "Stop Service")
      {
        model.stopDesktop()
      }
    case "quit": NSApp.terminate(nil)
    default: app.show(command)
    }
  }
}

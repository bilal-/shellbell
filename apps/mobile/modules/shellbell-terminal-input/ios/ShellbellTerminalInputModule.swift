import Foundation
import ExpoModulesCore
import GameController

public class ShellbellTerminalInputModule: Module {
    private var observers: [NSObjectProtocol] = []

    private func stop() {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers.removeAll()
    }

    public func definition() -> ModuleDefinition {
        Name("ShellbellTerminalInput")
        Events("keyboardChanged")
        AsyncFunction("isKeyboardAttached") { GCKeyboard.coalesced != nil }.runOnQueue(.main)
        // The terminal page's font, read from the copy the app already ships for its own text, so
        // the page needn't embed a second one.
        AsyncFunction("terminalFont") { () -> String? in
            guard let url = Bundle.main.url(forResource: "JetBrainsMonoNerdFont-Regular", withExtension: "ttf"),
                  let data = try? Data(contentsOf: url) else { return nil }
            return data.base64EncodedString()
        }
        OnStartObserving {
            self.stop()
            for name in [Notification.Name.GCKeyboardDidConnect, Notification.Name.GCKeyboardDidDisconnect] {
                self.observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                    self?.sendEvent("keyboardChanged", ["attached": GCKeyboard.coalesced != nil])
                })
            }
            self.sendEvent("keyboardChanged", ["attached": GCKeyboard.coalesced != nil])
        }
        OnStopObserving { self.stop() }
        OnDestroy { self.stop() }
    }
}

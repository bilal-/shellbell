import ShellbellPower

@MainActor final class ManualPowerEvents: PowerHelperEvents {
  private var callback: (@MainActor () -> Void)?
  var running: Bool { callback != nil }
  func start(_ callback: @escaping @MainActor () -> Void) { self.callback = callback }
  func stop() { callback = nil }
  func fire() { callback?() }
}

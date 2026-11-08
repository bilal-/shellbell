import Foundation
import IOKit.ps
import ShellbellCore

// The CF source is immutable after construction; invalidation is thread-safe.
// Owning it here also permits cleanup from Swift's nonisolated deinitialization.
private final class PowerSourceSubscription: @unchecked Sendable {
  let source: CFRunLoopSource
  init(_ source: CFRunLoopSource) { self.source = source }
  deinit { CFRunLoopSourceInvalidate(source) }
}

@MainActor public final class PowerSourceObserver {
  private var subscription: PowerSourceSubscription?
  private var onChange: ((PowerSourceState) -> Void)?
  private var lastState: PowerSourceState?
  private let readState: () -> PowerSourceState
  private let makeSource: (UnsafeMutableRawPointer) -> CFRunLoopSource?
  private let diagnostics: PowerDiagnosticLog?

  public convenience init(diagnostics: PowerDiagnosticLog? = nil) {
    self.init(read: Self.read, makeSource: Self.notificationSource, diagnostics: diagnostics)
  }

  init(
    read: @escaping () -> PowerSourceState,
    makeSource: @escaping (UnsafeMutableRawPointer) -> CFRunLoopSource?,
    diagnostics: PowerDiagnosticLog? = nil
  ) {
    self.readState = read
    self.makeSource = makeSource
    self.diagnostics = diagnostics
  }

  public func start(_ onChange: @escaping (PowerSourceState) -> Void) {
    stop()
    self.onChange = onChange
    refresh(origin: "start")
    let source = makeSource(Unmanaged.passUnretained(self).toOpaque())
    diagnostics?.record(.sourceSubscription, "available=\(source != nil) pollingFallback=true")
    if let source {
      subscription = PowerSourceSubscription(source)
      CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    }
    // Close the setup race even when notifications are unavailable; watchdogs still poll.
    refresh(origin: "subscribed")
  }

  private static func notificationSource(_ context: UnsafeMutableRawPointer) -> CFRunLoopSource? {
    IOPSNotificationCreateRunLoopSource(
      { context in
        guard let context else { return }
        MainActor.assumeIsolated {
          let observer = Unmanaged<PowerSourceObserver>.fromOpaque(context).takeUnretainedValue()
          observer.refresh(origin: "notification")
        }
      }, context)?.takeRetainedValue()
  }

  /// Desktop and helper watchdogs call this even if a power notification was missed.
  public func refresh() { refresh(origin: "poll") }

  private func refresh(origin: String) {
    guard let onChange else { return }
    let state = readState()
    guard state != lastState else { return }
    lastState = state
    diagnostics?.record(
      .source,
      "origin=\(origin) power=\(state.power) laptop=\(state.isLaptop)")
    onChange(state)
  }

  public func stop() {
    if let subscription { CFRunLoopSourceInvalidate(subscription.source) }
    subscription = nil
    onChange = nil
    lastState = nil
  }

  public static func read() -> PowerSourceState {
    guard let blob = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
      let list = IOPSCopyPowerSourcesList(blob)?.takeRetainedValue() as? [CFTypeRef]
    else { return .init(power: .unknown, isLaptop: false) }
    let provider = IOPSGetProvidingPowerSourceType(blob)?.takeUnretainedValue() as String?
    let kind: PowerSourceSnapshot.Source
    switch provider {
    case kIOPMACPowerKey: kind = .ac
    case kIOPMBatteryPowerKey: kind = .battery
    case kIOPMUPSPowerKey: kind = .ups
    default: kind = .unknown
    }
    var internalBattery = false
    for item in list {
      guard
        let info = IOPSGetPowerSourceDescription(blob, item)?.takeUnretainedValue()
          as? [String: Any],
        let type = info[kIOPSTypeKey] as? String
      else { return .init(power: .unknown, isLaptop: false) }
      if type == kIOPSInternalBatteryType { internalBattery = true }
    }
    return classifyPowerSource(.init(source: kind, internalBatteryPresent: internalBattery))
  }
}

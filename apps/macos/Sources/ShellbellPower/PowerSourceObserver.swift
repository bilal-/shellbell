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
  public init() {}

  public func start(_ onChange: @escaping (PowerSourceState) -> Void) {
    stop()
    self.onChange = onChange
    // Read once before subscription, then again after it to close the setup race.
    onChange(Self.read())
    let source = IOPSNotificationCreateRunLoopSource(
      { context in
        guard let context else { return }
        MainActor.assumeIsolated {
          let observer = Unmanaged<PowerSourceObserver>.fromOpaque(context).takeUnretainedValue()
          observer.onChange?(PowerSourceObserver.read())
        }
      }, Unmanaged.passUnretained(self).toOpaque())?.takeRetainedValue()
    guard let source else {
      onChange(.init(power: .unknown, isLaptop: false))
      return
    }
    subscription = PowerSourceSubscription(source)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    onChange(Self.read())
  }
  public func stop() {
    if let subscription { CFRunLoopSourceInvalidate(subscription.source) }
    subscription = nil
    onChange = nil
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

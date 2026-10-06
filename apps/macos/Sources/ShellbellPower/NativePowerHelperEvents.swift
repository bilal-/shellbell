import Darwin
import Foundation
import ShellbellCore
import SystemConfiguration

private final class ConsoleSubscription: @unchecked Sendable {
  let store: SCDynamicStore
  let source: CFRunLoopSource
  init(store: SCDynamicStore, source: CFRunLoopSource) {
    self.store = store
    self.source = source
  }
  deinit { CFRunLoopSourceInvalidate(source) }
}

/// All observations and the watchdog live in the helper's main run loop, never
/// in the UI or its visibility timer. Fresh reads also run before each mutation.
@MainActor public final class NativePowerHelperEvents: PowerHelperEvents {
  private let power = PowerSourceObserver()
  private var console: ConsoleSubscription?
  private var timer: DispatchSourceTimer?
  private var callback: (@MainActor () -> Void)?
  private var powerKnown = false

  public init() {}

  public func start(_ callback: @escaping @MainActor () -> Void) {
    stop()
    self.callback = callback
    var context = SCDynamicStoreContext(
      version: 0, info: Unmanaged.passUnretained(self).toOpaque(),
      retain: nil, release: nil, copyDescription: nil)
    if let store = SCDynamicStoreCreate(
      nil, "Shellbell power" as CFString,
      { _, _, context in
        guard let context else { return }
        MainActor.assumeIsolated {
          let observer = Unmanaged<NativePowerHelperEvents>.fromOpaque(context)
            .takeUnretainedValue()
          observer.callback?()
        }
      }, &context),
      SCDynamicStoreSetNotificationKeys(
        store, [SCDynamicStoreKeyCreateConsoleUser(nil)] as CFArray, nil),
      let source = SCDynamicStoreCreateRunLoopSource(nil, store, 0)
    {
      console = ConsoleSubscription(store: store, source: source)
      CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    }
    power.start { [weak self] state in
      guard let self else { return }
      self.powerKnown = state.power != .unknown
      self.callback?()
    }
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(deadline: .now() + 1, repeating: 1, leeway: .milliseconds(100))
    timer.setEventHandler { [weak self] in
      MainActor.assumeIsolated { self?.callback?() }
    }
    self.timer = timer
    timer.resume()
    callback()
  }

  public func stop() {
    timer?.cancel()
    timer = nil
    if let console { CFRunLoopSourceInvalidate(console.source) }
    console = nil
    power.stop()
    powerKnown = false
    callback = nil
  }

  public func readHost() -> PowerLeaseHost {
    guard let console, powerKnown else {
      return .init(power: .unknown, consoleUID: nil, competingController: true)
    }
    var uid: uid_t = 0
    let name = SCDynamicStoreCopyConsoleUser(console.store, &uid, nil) as String?
    return powerHelperHost(
      power: PowerSourceObserver.read().power, consoleName: name, consoleUID: uid,
      processNames: Self.processNames())
  }

  /// BSD process snapshot only; no subprocess, shell, PID-based authentication,
  /// or dependence on a GUI session. Fail closed on errors or truncation.
  nonisolated static func decodeProcessName(_ bytes: UnsafeRawBufferPointer) -> String? {
    String(bytes: bytes.prefix { $0 != 0 }, encoding: .utf8)
  }

  private static func processNames() -> [String]? {
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0]
    let stride = MemoryLayout<kinfo_proc>.stride
    for _ in 0..<3 {
      var bytes = 0
      guard sysctl(&mib, 4, nil, &bytes, nil, 0) == 0,
        bytes > 0, bytes < 8 * 1024 * 1024
      else { return nil }
      // Leave room for processes that appeared after the size query.
      let capacity = bytes / stride + 128
      var records = [kinfo_proc](repeating: kinfo_proc(), count: capacity)
      bytes = capacity * stride
      let result = records.withUnsafeMutableBytes { buffer in
        sysctl(&mib, 4, buffer.baseAddress, &bytes, nil, 0)
      }
      if result != 0 {
        if errno == ENOMEM { continue }
        return nil
      }
      guard bytes % stride == 0, bytes / stride <= capacity else { return nil }
      var names: [String] = []
      for var record in records.prefix(bytes / stride) {
        let name = withUnsafeBytes(of: &record.kp_proc.p_comm) { raw -> String? in
          Self.decodeProcessName(raw)
        }
        guard let name else { return nil }
        names.append(name)
      }
      return names
    }
    return nil
  }
}

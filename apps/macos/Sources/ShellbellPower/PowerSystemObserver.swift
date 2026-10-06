import AppKit
import Foundation
import IOKit.pwr_mgt
import ShellbellCore

private final class PowerWakeSubscriptions: @unchecked Sendable {
  let center: NotificationCenter
  let tokens: [NSObjectProtocol]
  init(center: NotificationCenter, tokens: [NSObjectProtocol]) {
    self.center = center
    self.tokens = tokens
  }
  deinit { for token in tokens { center.removeObserver(token) } }
}

/// One read-only probe at a time, off the UI actor. No command history or terminal input.
@MainActor public final class PowerSystemObserver {
  public private(set) var observation: PowerSystemObservation?
  private(set) var reading = false
  private let now: () -> TimeInterval
  private let read: @Sendable () async -> PowerSystemSnapshot
  private var nextPoll: TimeInterval = 0
  private var generation: UInt64 = 0
  private var onChange: (() -> Void)?
  private var subscriptions: PowerWakeSubscriptions?

  public convenience init() {
    self.init(now: { ProcessInfo.processInfo.systemUptime }, read: {
      await Task.detached(priority: .utility) { Self.readSnapshot() }.value
    })
  }

  init(now: @escaping () -> TimeInterval, read: @escaping @Sendable () async -> PowerSystemSnapshot) {
    self.now = now
    self.read = read
  }

  public func start(onChange: @escaping () -> Void) {
    self.onChange = onChange
    if subscriptions == nil {
      let center = NSWorkspace.shared.notificationCenter
      let tokens = [NSWorkspace.willSleepNotification, NSWorkspace.didWakeNotification].map { name in
        center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
          MainActor.assumeIsolated {
            self?.invalidate()
            self?.refresh(force: true)
          }
        }
      }
      subscriptions = PowerWakeSubscriptions(center: center, tokens: tokens)
    }
    refresh(force: true)
  }

  public func invalidate() {
    generation &+= 1
    observation = nil
    nextPoll = 0
    onChange?()
  }

  public func refresh(force: Bool = false) {
    guard !reading, force || now() >= nextPoll else { return }
    let capturedAt = now()
    let token = generation
    reading = true
    nextPoll = capturedAt + 2
    let read = read
    Task { [weak self] in
      let snapshot = await read()
      guard let self else { return }
      self.reading = false
      guard token == self.generation else {
        self.refresh(force: true)
        return
      }
      self.observation = .init(snapshot: snapshot, capturedAt: capturedAt)
      self.onChange?()
    }
  }

  nonisolated private static func readSnapshot() -> PowerSystemSnapshot {
    let override = try? SystemSleepOverride.decode(BoundedPowerCommand.run(
      executable: "/usr/bin/pmset", arguments: ["-g"], timeout: 2))
    var raw: Unmanaged<CFDictionary>?
    let requests: (idle: Bool, display: Bool)?
    if IOPMCopyAssertionsByProcess(&raw) == kIOReturnSuccess,
      let value = raw?.takeRetainedValue()
    {
      requests = otherRequests(value, ownPID: getpid())
    } else {
      // The out parameter is not an owned result on failure.
      requests = nil
    }
    return .init(
      sleepDisabled: override, otherIdleSleepRequests: requests?.idle,
      otherDisplaySleepRequests: requests?.display)
  }

  nonisolated static func otherRequests(_ raw: CFDictionary, ownPID: Int32) -> (idle: Bool, display: Bool)? {
    guard let entries = raw as? [NSNumber: [[String: Any]]], entries.count <= 16_384 else { return nil }
    var idle = false
    var display = false
    var count = 0
    for (pid, assertions) in entries where pid.int32Value != ownPID {
      count += assertions.count
      guard count <= 16_384 else { return nil }
      for assertion in assertions {
        guard let type = assertion[kIOPMAssertionTypeKey] as? String,
          let level = assertion[kIOPMAssertionLevelKey] as? NSNumber,
          CFGetTypeID(level) != CFBooleanGetTypeID(),
          [kIOPMAssertionLevelOff, kIOPMAssertionLevelOn].contains(level.intValue)
        else { return nil }
        guard level.intValue == kIOPMAssertionLevelOn else { continue }
        if type == kIOPMAssertionTypePreventUserIdleSystemSleep || type == kIOPMAssertionTypePreventSystemSleep {
          idle = true
        }
        if type == kIOPMAssertionTypePreventUserIdleDisplaySleep { display = true }
      }
    }
    return (idle, display)
  }
}

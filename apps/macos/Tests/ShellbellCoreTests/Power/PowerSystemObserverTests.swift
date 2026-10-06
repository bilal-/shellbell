import Foundation
import IOKit.pwr_mgt
import XCTest
@testable import ShellbellCore
@testable import ShellbellPower

private actor SnapshotReader {
  private var pending: [CheckedContinuation<PowerSystemSnapshot, Never>] = []
  var count: Int { pending.count }
  func read() async -> PowerSystemSnapshot {
    await withCheckedContinuation { pending.append($0) }
  }
  func finish(_ value: PowerSystemSnapshot) { pending.removeFirst().resume(returning: value) }
}

final class PowerSystemObserverTests: XCTestCase {
  private let normal = PowerSystemSnapshot(
    sleepDisabled: false, otherIdleSleepRequests: false, otherDisplaySleepRequests: false)

  @MainActor private func until(_ condition: () async -> Bool) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(2))
    while !(await condition()) {
      if ContinuousClock.now >= deadline { throw PowerClientFailure.timeout }
      await Task.yield()
    }
  }

  func testObservationRejectsExpiredFutureAndInvalidTimestamps() {
    let observation = PowerSystemObservation(snapshot: normal, capturedAt: 10)
    XCTAssertNotNil(observation.fresh(at: 15))
    XCTAssertNil(observation.fresh(at: 15.001))
    XCTAssertNil(observation.fresh(at: 9))
    XCTAssertNil(observation.fresh(at: .nan))
    for value in [-1, Double.nan, Double.infinity] {
      XCTAssertNil(PowerSystemObservation(snapshot: normal, capturedAt: value).fresh(at: 10))
    }
  }

  @MainActor func testProbeDoesNotOverlapAndUsesStartTimeForFreshness() async throws {
    let reader = SnapshotReader()
    var now = 10.0
    let observer = PowerSystemObserver(now: { now }, read: { await reader.read() })
    observer.refresh()
    try await until { await reader.count == 1 }
    observer.refresh(force: true)
    XCTAssertTrue(observer.reading)
    let pending = await reader.count
    XCTAssertEqual(pending, 1)
    now = 20
    await reader.finish(normal)
    try await until { !observer.reading }
    XCTAssertEqual(observer.observation?.capturedAt, 10)
    XCTAssertNil(observer.observation?.fresh(at: now))
    observer.refresh()
    try await until { await reader.count == 1 }
    await reader.finish(normal)
    try await until { !observer.reading }
    XCTAssertNotNil(observer.observation?.fresh(at: now))
    observer.refresh()
    XCTAssertFalse(observer.reading)
  }

  @MainActor func testWakeInvalidationDiscardsInFlightResultBeforeStartingAnother() async throws {
    let reader = SnapshotReader()
    var now = 10.0
    let observer = PowerSystemObserver(now: { now }, read: { await reader.read() })
    observer.refresh()
    try await until { await reader.count == 1 }
    observer.invalidate()
    observer.refresh(force: true)
    now = 11
    await reader.finish(normal)
    try await until { await reader.count == 1 }
    XCTAssertNil(observer.observation)
    await reader.finish(.init(
      sleepDisabled: true, otherIdleSleepRequests: true, otherDisplaySleepRequests: nil))
    try await until { !observer.reading }
    XCTAssertEqual(observer.observation?.capturedAt, 11)
    XCTAssertEqual(observer.observation?.snapshot.sleepDisabled, true)
    XCTAssertNil(observer.observation?.snapshot.otherDisplaySleepRequests)
  }

  func testOtherRequestsExcludeOurProcessAndIgnoreInactiveOrUnrelatedAssertions() {
    let entries: [NSNumber: [[String: Any]]] = [
      1: [[kIOPMAssertionTypeKey: kIOPMAssertionTypePreventUserIdleSystemSleep,
        kIOPMAssertionLevelKey: kIOPMAssertionLevelOn]],
      2: [[kIOPMAssertionTypeKey: kIOPMAssertionTypePreventUserIdleDisplaySleep,
        kIOPMAssertionLevelKey: kIOPMAssertionLevelOff]],
      3: [[kIOPMAssertionTypeKey: "BackgroundTask", kIOPMAssertionLevelKey: kIOPMAssertionLevelOn]],
    ]
    let requests = PowerSystemObserver.otherRequests(entries as CFDictionary, ownPID: 1)
    XCTAssertEqual(requests?.idle, false)
    XCTAssertEqual(requests?.display, false)
    var updated = entries
    updated[2] = [
      [kIOPMAssertionTypeKey: kIOPMAssertionTypePreventSystemSleep, kIOPMAssertionLevelKey: kIOPMAssertionLevelOn],
      [kIOPMAssertionTypeKey: kIOPMAssertionTypePreventUserIdleDisplaySleep, kIOPMAssertionLevelKey: kIOPMAssertionLevelOn],
    ]
    let active = PowerSystemObserver.otherRequests(updated as CFDictionary, ownPID: 1)
    XCTAssertEqual(active?.idle, true)
    XCTAssertEqual(active?.display, true)
    XCTAssertNil(PowerSystemObserver.otherRequests(
      [2: [[kIOPMAssertionTypeKey: "Unknown"]]] as CFDictionary, ownPID: 1))
    XCTAssertNil(PowerSystemObserver.otherRequests(
      [2: [[kIOPMAssertionTypeKey: "Unknown", kIOPMAssertionLevelKey: true]]] as CFDictionary, ownPID: 1))
  }
}

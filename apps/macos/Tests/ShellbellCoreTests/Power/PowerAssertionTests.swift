import XCTest

@testable import ShellbellCore

@MainActor private final class AssertionProbe: IdleAssertionAdapterProtocol {
  var acquired: [IdleAssertionKind] = []
  var released: [UInt32] = []
  var failAcquire: IdleAssertionKind?
  var failRelease = false
  enum Failure: Error { case rejected }
  func acquire(_ kind: IdleAssertionKind) throws -> UInt32 {
    if kind == failAcquire { throw Failure.rejected }
    acquired.append(kind)
    return UInt32(acquired.count)
  }
  func release(_ id: UInt32) throws {
    released.append(id)
    if failRelease { throw Failure.rejected }
  }
}

final class PowerAssertionTests: XCTestCase {
  @MainActor func testRepeatedDemandDoesNotLeakAndDisplayCanReleaseIndependently() {
    let probe = AssertionProbe()
    let controller = PowerAssertionController(adapter: probe)
    let both = PowerDemand(
      preventIdleSystem: true, preventIdleDisplay: true, requestClosedLid: true)
    controller.reconcile(both)
    controller.reconcile(both)
    XCTAssertEqual(probe.acquired, [.system, .display])
    XCTAssertTrue(controller.systemActive)
    XCTAssertTrue(controller.displayActive)
    controller.reconcile(
      .init(preventIdleSystem: true, preventIdleDisplay: false, requestClosedLid: false))
    XCTAssertEqual(probe.released, [2])
    XCTAssertTrue(controller.systemActive)
    XCTAssertFalse(controller.displayActive)
    XCTAssertTrue(controller.releaseAll())
    XCTAssertEqual(probe.released, [2, 1])
    XCTAssertTrue(controller.releaseAll())
    XCTAssertEqual(probe.released, [2, 1])
  }

  @MainActor func testFailedReleaseRetainsExactHandleAndRetriesWithoutReacquiring() {
    let probe = AssertionProbe()
    let controller = PowerAssertionController(adapter: probe)
    controller.reconcile(
      .init(preventIdleSystem: true, preventIdleDisplay: false, requestClosedLid: false))
    probe.failRelease = true
    XCTAssertFalse(controller.releaseAll())
    XCTAssertTrue(controller.systemActive)
    XCTAssertTrue(controller.hasFailure)
    probe.failRelease = false
    XCTAssertTrue(controller.releaseAll())
    XCTAssertEqual(probe.released, [1, 1])
    XCTAssertEqual(probe.acquired, [.system])
    XCTAssertFalse(controller.systemActive)
    XCTAssertFalse(controller.hasFailure)
  }

  @MainActor func testPartialAcquisitionIsReportedAndRetried() {
    let probe = AssertionProbe()
    probe.failAcquire = .display
    let controller = PowerAssertionController(adapter: probe)
    let both = PowerDemand(
      preventIdleSystem: true, preventIdleDisplay: true, requestClosedLid: false)
    controller.reconcile(both)
    XCTAssertTrue(controller.systemActive)
    XCTAssertFalse(controller.displayActive)
    XCTAssertTrue(controller.hasFailure)
    probe.failAcquire = nil
    controller.reconcile(both)
    XCTAssertEqual(probe.acquired, [.system, .display])
    XCTAssertFalse(controller.hasFailure)
    XCTAssertTrue(controller.releaseAll())
  }

  @MainActor func testEveryIneligibleTransitionReleasesOwnedAssertions() {
    for eligibility in [
      PowerEligibility(
        power: .battery, desktopServiceVerified: true, statusFresh: true, isLaptop: true),
      PowerEligibility(
        power: .unknown, desktopServiceVerified: true, statusFresh: true, isLaptop: true),
      PowerEligibility(
        power: .ac, desktopServiceVerified: true, statusFresh: false, isLaptop: true),
      PowerEligibility(
        power: .ac, desktopServiceVerified: false, statusFresh: true, isLaptop: true),
    ] {
      let probe = AssertionProbe()
      let controller = PowerAssertionController(adapter: probe)
      controller.reconcile(
        .init(preventIdleSystem: true, preventIdleDisplay: true, requestClosedLid: false))
      controller.reconcile(powerDemand(.init(keepAwake: true), eligibility))
      XCTAssertFalse(controller.systemActive)
      XCTAssertFalse(controller.displayActive)
      XCTAssertEqual(Set(probe.released), Set([1, 2]))
    }
  }
}

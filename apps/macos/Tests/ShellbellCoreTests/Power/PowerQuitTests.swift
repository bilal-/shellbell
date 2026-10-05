import XCTest

@testable import ShellbellCore

final class PowerQuitTests: XCTestCase {
  @MainActor func testPowerFailureStillStopsServiceAndBothResultsAreRequired() {
    let coordinator = PowerQuitCoordinator()
    var serviceCompletion: ((Bool) -> Void)?
    var outcome: PowerQuitOutcome?
    coordinator.quit(releasePower: { $0(false) }, stopService: { serviceCompletion = $0 }) {
      outcome = $0
    }
    XCTAssertNotNil(serviceCompletion)
    XCTAssertNil(outcome)
    serviceCompletion?(true)
    XCTAssertEqual(outcome?.powerRestored, false)
    XCTAssertEqual(outcome?.serviceStopped, true)
    XCTAssertEqual(outcome?.complete, false)
  }

  @MainActor func testServiceFailureStillWaitsForPowerAndRepeatedQuitDoesNotOverlap() {
    let coordinator = PowerQuitCoordinator()
    var powerCompletion: ((Bool) -> Void)?
    var outcomes: [PowerQuitOutcome] = []
    coordinator.quit(releasePower: { powerCompletion = $0 }, stopService: { $0(false) }) {
      outcomes.append($0)
    }
    coordinator.quit(
      releasePower: { _ in XCTFail("duplicate release") },
      stopService: { _ in XCTFail("duplicate stop") }
    ) { outcomes.append($0) }
    XCTAssertTrue(outcomes.isEmpty)
    powerCompletion?(true)
    powerCompletion?(false)
    XCTAssertEqual(outcomes.count, 2)
    XCTAssertTrue(outcomes.allSatisfy { $0.powerRestored && !$0.serviceStopped && !$0.complete })
    coordinator.quit(releasePower: { $0(true) }, stopService: { $0(true) }) { outcomes.append($0) }
    XCTAssertEqual(outcomes.last?.complete, true)
  }
}

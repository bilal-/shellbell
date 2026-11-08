import Foundation
import XCTest

@testable import ShellbellCore

final class PowerDiagnosticLogTests: XCTestCase {
  @MainActor func testRepeatedStatesAreBoundedButTransitionsAndRecoveryLogImmediately() {
    var now = 0.0
    var records: [String] = []
    let log = PowerDiagnosticLog(category: "test", now: { now }, write: { records.append($0) })
    for tick in 0...120 {
      now = Double(tick)
      log.record(.controller, "power=ac")
    }
    XCTAssertEqual(records.count, 3)
    log.record(.controller, "power=battery")
    log.record(.restorationResult, "restored=false")
    log.record(.restorationResult, "restored=false")
    log.record(.restorationResult, "restored=true")
    XCTAssertEqual(records.count, 6)
    now = 1
    log.record(.controller, "power=battery")
    XCTAssertEqual(records.count, 7, "A clock discontinuity must not suppress diagnostics.")
  }

  func testFailureEvidenceExcludesDescriptionsDomainsAndAssociatedPayloads() {
    enum Failure: Error { case injected(String) }
    let payload = "private-test-payload"
    XCTAssertFalse(PowerDiagnosticLog.failure(Failure.injected(payload)).contains(payload))
    XCTAssertFalse(PowerDiagnosticLog.failure(NSError(domain: payload, code: 7)).contains(payload))
    XCTAssertEqual(PowerDiagnosticLog.failure(PowerLeaseFailure.readback), "readback")
    XCTAssertEqual(PowerDiagnosticLog.value(nil), "unknown")
  }
}

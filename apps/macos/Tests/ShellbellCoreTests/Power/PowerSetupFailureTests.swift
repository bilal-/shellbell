import Foundation
import XCTest

@testable import ShellbellCore
@testable import ShellbellPower

@MainActor final class PowerSetupFailureTests: XCTestCase {
  func testEachSetupFailureSaysWhatHappened() {
    let errors: [Error] = [
      PowerHelperRegistration.Failure.restorationRequired, PowerHelperRegistration.Failure.unavailable,
      PowerClientFailure.timeout, PowerClientFailure.unavailable, PowerClientFailure.invalidReply,
      NSError(domain: "SMAppServiceErrorDomain", code: 22),
    ]
    let messages = errors.map(PowerMaintenanceActions.enableFailure)
    XCTAssertEqual(Set(messages).count, messages.count)
    XCTAssertTrue(messages[0].contains("restoring normal sleep"))
    XCTAssertTrue(messages[2].contains("didn’t answer"))
    XCTAssertTrue(messages[3].contains("couldn’t reach"))
    XCTAssertTrue(messages[5].contains("error 22"))
    for message in messages { XCTAssertFalse(message.contains("could not be verified")) }
  }
}

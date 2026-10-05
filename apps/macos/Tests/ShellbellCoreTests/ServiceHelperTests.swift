import XCTest

@testable import ShellbellCore

final class ServiceHelperTests: XCTestCase {
  func testFixedOperationsAndBoundedErrorsWithoutServiceManagement() {
    var calls: [String] = []
    let result = ServiceHelper.perform(
      "register", admit: {}, status: { "enabled" },
      register: { calls.append("register") }, unregister: { calls.append("unregister") })
    XCTAssertEqual(calls, ["register"])
    XCTAssertTrue(Wire.valid(result, kind: "helper"))
    XCTAssertEqual(result["status"], .string("enabled"))
    let denied = ServiceHelper.perform(
      "register", admit: {}, status: { "requires-approval" },
      register: { throw BridgeFailure.operationFailed }, unregister: {})
    XCTAssertEqual(
      denied,
      .object(["v": .number(1), "ok": .bool(false), "error": .object(["code": .string("denied")])]))
    let unsafe = ServiceHelper.perform(
      "status", admit: { throw BridgeFailure.unsafeState },
      status: {
        calls.append("status")
        return "enabled"
      }, register: {}, unregister: {})
    XCTAssertEqual(unsafe["error"]["code"], .string("invalid-bundle"))
    XCTAssertEqual(calls, ["register"])
  }
  func testUnknownVerbCannotReachPlatformAndStatusNeverMutates() {
    var mutations = 0
    let status = ServiceHelper.perform(
      "status", admit: {}, status: { "not-registered" }, register: { mutations += 1 },
      unregister: { mutations += 1 })
    XCTAssertEqual(status["status"], .string("not-registered"))
    let invalid = ServiceHelper.perform(
      "open-settings", admit: {}, status: { "enabled" }, register: { mutations += 1 },
      unregister: { mutations += 1 })
    XCTAssertEqual(invalid["ok"], .bool(false))
    XCTAssertEqual(mutations, 0)
  }
}

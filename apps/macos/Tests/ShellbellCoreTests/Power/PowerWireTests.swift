import Foundation
import XCTest

@testable import ShellbellCore

final class PowerWireTests: XCTestCase {
  func testRemovalHoldIsAnExplicitRecoverOnlyRequest() throws {
    let valid = Data(#"{"v":1,"requestID":1,"verb":"recover","holdForRemoval":true}"#.utf8)
    XCTAssertNoThrow(try PowerRequest.decode(valid, after: 0))
    for raw in [
      #"{"v":1,"requestID":1,"verb":"status","holdForRemoval":true}"#,
      #"{"v":1,"requestID":1,"verb":"acquire","holdForRemoval":true}"#,
      #"{"v":1,"requestID":1,"verb":"recover","holdForRemoval":false}"#,
      #"{"v":1,"requestID":1,"verb":"recover","holdForRemoval":null}"#,
      #"{"v":1,"requestID":1,"verb":"recover","holdForRemoval":1}"#,
    ] {
      XCTAssertThrowsError(try PowerRequest.decode(Data(raw.utf8), after: 0))
    }
  }

  func testStrictCommandsLeaseShapeSizeAndReplay() throws {
    let id = UUID()
    let request = PowerRequest(requestID: 2, verb: .renew, leaseID: id)
    XCTAssertEqual(try PowerRequest.decode(JSONEncoder().encode(request), after: 1), request)
    XCTAssertThrowsError(try PowerRequest.decode(JSONEncoder().encode(request), after: 2))
    for raw in [
      #"{"v":1,"requestID":1,"verb":"status","executable":"/bin/sh"}"#,
      #"{"v":2,"requestID":1,"verb":"status"}"#,
      #"{"v":1,"requestID":0,"verb":"status"}"#,
      #"{"v":1,"requestID":1,"verb":"renew"}"#,
      #"{"v":1,"requestID":1,"verb":"acquire","leaseID":"00000000-0000-0000-0000-000000000000"}"#,
      #"{"v":1,"requestID":1,"verb":"shell"}"#,
      #"{"v":1,"requestID":9007199254740992,"verb":"status"}"#,
    ] { XCTAssertThrowsError(try PowerRequest.decode(Data(raw.utf8), after: 0)) }
    XCTAssertThrowsError(try PowerRequest.decode(Data(repeating: 32, count: 8193), after: 0))
  }
}

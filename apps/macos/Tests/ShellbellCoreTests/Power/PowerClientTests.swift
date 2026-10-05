import Foundation
import XCTest

@testable import ShellbellCore

@MainActor private final class PowerTransportFixture: PowerClientTransport {
  var onReply: ((Data) -> Void)?
  var onEnd: (() -> Void)?
  var requests: [Data] = []
  var closed = false
  func write(_ data: Data) throws { requests.append(data) }
  func close() { closed = true }
}

final class PowerClientTests: XCTestCase {
  @MainActor func testRemovalPreparationRequiresMaintenanceTokenProof() throws {
    for validProof in [false, true] {
      let transport = PowerTransportFixture()
      let client = PowerClient(transport: transport, clock: FixtureClock())
      var reply: PowerReply?
      var failure: PowerClientFailure?
      client.prepareRemoval {
        switch $0 {
        case .success(let value): reply = value
        case .failure(let value): failure = value
        }
      }
      let sent = try XCTUnwrap(transport.requests.first)
      let object = try XCTUnwrap(JSONSerialization.jsonObject(with: sent) as? [String: Any])
      XCTAssertEqual(object["verb"] as? String, "recover")
      XCTAssertEqual(object["holdForRemoval"] as? Bool, true)
      let response =
        validProof
        ? #"{"v":1,"requestID":1,"ok":true,"state":"maintenance","leaseID":"00000000-0000-0000-0000-000000000001"}"#
        : #"{"v":1,"requestID":1,"ok":true,"state":"maintenance"}"#
      transport.onReply?(Data(response.utf8))
      if validProof {
        XCTAssertEqual(reply?.state, .maintenance)
        XCTAssertNotNil(reply?.leaseID)
        XCTAssertFalse(transport.closed)
      } else {
        XCTAssertEqual(failure, .deliveryUnknown)
        XCTAssertTrue(transport.closed)
      }
    }
  }

  @MainActor func testCorrelatedReplyAndSingleOutstandingRequest() throws {
    let transport = PowerTransportFixture()
    let client = PowerClient(transport: transport, clock: FixtureClock())
    var reply: PowerReply?
    var failure: PowerClientFailure?
    client.request(.status) { reply = try? $0.get() }
    client.request(.status) { if case .failure(let value) = $0 { failure = value } }
    XCTAssertEqual(failure, .busy)
    XCTAssertEqual(transport.requests.count, 1)
    transport.onReply?(Data(#"{"v":1,"requestID":1,"ok":true,"state":"idle"}"#.utf8))
    XCTAssertEqual(reply?.state, .idle)
    XCTAssertFalse(transport.closed)
  }

  @MainActor func testUnverifiedOrUncorrelatedAcquireReplyClosesConnection() {
    for response in [
      #"{"v":1,"requestID":2,"ok":true,"state":"idle"}"#,
      #"{"v":1,"requestID":1,"ok":true,"state":"active"}"#,
      #"{"v":2,"requestID":1,"ok":true,"state":"idle"}"#,
      String(repeating: "x", count: 8193),
    ] {
      let transport = PowerTransportFixture()
      let client = PowerClient(transport: transport, clock: FixtureClock())
      var failure: PowerClientFailure?
      client.request(.acquire) { if case .failure(let value) = $0 { failure = value } }
      transport.onReply?(Data(response.utf8))
      XCTAssertEqual(failure, .deliveryUnknown)
      XCTAssertTrue(transport.closed)
    }
  }

  @MainActor func testTimeoutDoesNotReplayMutationOrCompleteTwice() {
    let transport = PowerTransportFixture()
    let clock = FixtureClock()
    let client = PowerClient(transport: transport, clock: clock)
    var failures: [PowerClientFailure] = []
    client.request(.acquire) { if case .failure(let value) = $0 { failures.append(value) } }
    let lateReply = transport.onReply
    clock.fire()
    lateReply?(Data(#"{"v":1,"requestID":1,"ok":true,"state":"idle"}"#.utf8))
    XCTAssertEqual(failures, [.deliveryUnknown])
    XCTAssertTrue(transport.closed)
    XCTAssertEqual(transport.requests.count, 1)
  }
}

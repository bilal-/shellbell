import Foundation
import XCTest

@testable import ShellbellCore

@MainActor final class FixtureTransport: BridgeTransport {
  var onData: ((Data) -> Void)?
  var onEnd: (() -> Void)?
  var writes: [JSONValue] = []
  var closed = false
  func write(_ data: Data) throws {
    writes.append(try JSONDecoder().decode(JSONValue.self, from: data))
  }
  func close() { closed = true }
  func emit(_ value: JSONValue) { onData?(try! JSONEncoder().encode(value) + Data([10])) }
  func success(_ id: Int, _ data: JSONValue) {
    emit(.object(["v": .number(1), "id": .number(Double(id)), "ok": .bool(true), "data": data]))
  }
  func hello(_ capabilities: [String] = Wire.capabilities) {
    success(
      1,
      .object([
        "version": .number(1), "agentVersion": .string("0.0.0"),
        "capabilities": .array(capabilities.map(JSONValue.string)),
      ]))
  }
}
@MainActor final class FixtureClock: BridgeScheduling {
  var seconds: [TimeInterval] = []
  var active: [Int: @MainActor () -> Void] = [:]
  func after(_ seconds: TimeInterval, _ action: @escaping @MainActor () -> Void) -> () -> Void {
    self.seconds.append(seconds)
    let id = self.seconds.count
    active[id] = action
    return { self.active[id] = nil }
  }
  func fire() {
    let callbacks = active.values
    active.removeAll()
    for callback in callbacks { callback() }
  }
}

@MainActor final class BridgeClientTests: XCTestCase {
  func testModelDisconnectsRealBridgeAfterFailedOwnedCloseWithoutReplay() throws {
    let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("Fixtures/native-protocol.json")
    let vectors = try JSONDecoder().decode([JSONValue].self, from: Data(contentsOf: file))
    let status = try XCTUnwrap(vectors.first { $0["name"] == .string("status public status") })[
      "value"]["data"]
    let transport = FixtureTransport()
    let clock = FixtureClock()
    let client = BridgeClient(transport: transport, clock: clock)
    let model = ControllerModel(connection: client)
    model.connect()
    transport.hello()
    transport.success(2, status)
    model.openPairing()
    transport.success(
      3,
      .object([
        "flowId": .string("aaaaaaaaaaaaaaaaaaaaaa"), "qrText": .string("fixture"),
        "expiresAt": .number(9_000_000_000_000),
      ]))
    model.closePairing()
    transport.emit(
      .object([
        "v": .number(1), "id": .number(4), "ok": .bool(false),
        "error": .object(["code": .string("conflict")]),
      ]))
    XCTAssertTrue(transport.closed)
    XCTAssertFalse(client.isReady)
    XCTAssertFalse(model.pairingOwned)
    clock.fire()
    XCTAssertEqual(
      transport.writes.map { $0["cmd"].string! },
      ["hello", "status", "pairing.open", "pairing.close"])
  }
  func testHelloFirstAndBusyWithoutQueue() {
    let transport = FixtureTransport()
    let clock = FixtureClock()
    let client = BridgeClient(transport: transport, clock: clock)
    var before: BridgeFailure?
    var busy: BridgeFailure?
    client.request("status") { if case .failure(let e) = $0 { before = e } }
    XCTAssertEqual(before, .handshakeRequired)
    client.connect { _ in }
    client.request("status") { if case .failure(let e) = $0 { busy = e } }
    XCTAssertEqual(busy, .busy)
    XCTAssertEqual(transport.writes.map { $0["cmd"].string! }, ["hello"])
    transport.hello()
    XCTAssertTrue(client.isReady)
    client.request("devices") { _ in }
    XCTAssertEqual(transport.writes.last?["id"], .number(2))
  }
  func testMalformedCapabilitiesAndFutureResponsesCloseOnce() {
    let transport = FixtureTransport()
    let clock = FixtureClock()
    let client = BridgeClient(transport: transport, clock: clock)
    var completions = 0
    client.connect { _ in completions += 1 }
    transport.hello(["status"])
    transport.onEnd?()
    clock.fire()
    XCTAssertFalse(client.isReady)
    XCTAssertTrue(transport.closed)
    XCTAssertEqual(completions, 1)
    let t = FixtureTransport()
    let c = BridgeClient(transport: t, clock: FixtureClock())
    c.connect { _ in }
    t.hello()
    c.request("devices") { _ in }
    t.success(3, .array([]))
    XCTAssertTrue(t.closed)
  }
  func testDeadlinesAndLostMutationNeverReplay() {
    let transport = FixtureTransport()
    let clock = FixtureClock()
    let client = BridgeClient(transport: transport, clock: clock)
    client.connect { _ in }
    transport.hello()
    var error: BridgeFailure?
    client.request(
      "service.stop", args: .object(["expect": .object(["revision": .null, "runtime": .null])])
    ) {
      if case .failure(let e) = $0 { error = e }
    }
    XCTAssertEqual(clock.seconds, [5, 60])
    clock.fire()
    XCTAssertEqual(error, .deliveryUnknown)
    XCTAssertTrue(transport.closed)
    client.connect { _ in }
    XCTAssertEqual(transport.writes.count, 2)
  }
  func testDesktopMutationsUseTheLifecycleDeadline() {
    for command in ["desktop.start", "desktop.stop", "desktop.login.set", "ownership.convert"] {
      let transport = FixtureTransport()
      let clock = FixtureClock()
      let client = BridgeClient(transport: transport, clock: clock)
      client.connect { _ in }
      transport.hello()
      var args: [String: JSONValue] = [
        "expect": .object(["revision": .null, "runtime": .null]), "ownerRevision": .null,
      ]
      if command == "desktop.login.set" { args["enabled"] = .bool(true) }
      if command == "ownership.convert" {
        args["target"] = .string("desktop")
        args["consent"] = .bool(true)
      }
      client.request(command, args: .object(args)) { _ in }
      XCTAssertEqual(clock.seconds, [5, 60])
      client.close()
    }
  }
  func testReadTimeoutAndWrongPayloadFailClosed() {
    let transport = FixtureTransport()
    let clock = FixtureClock()
    let client = BridgeClient(transport: transport, clock: clock)
    client.connect { _ in }
    transport.hello()
    var result: BridgeFailure?
    client.request("devices") { if case .failure(let e) = $0 { result = e } }
    clock.fire()
    XCTAssertEqual(result, .timeout)
    XCTAssertTrue(transport.closed)
    let t = FixtureTransport()
    let c = BridgeClient(transport: t, clock: FixtureClock())
    c.connect { _ in }
    t.hello()
    c.request("devices") { _ in }
    t.success(2, .object([:]))
    XCTAssertTrue(t.closed)
  }
  func testPairingResultBeforeOwnedChallengeAndForeignFlowRefused() {
    let transport = FixtureTransport()
    let c = BridgeClient(transport: transport, clock: FixtureClock())
    var order: [String] = []
    c.connect { _ in }
    transport.hello()
    c.onEvent = { _ in order.append("event") }
    c.request(
      "pairing.open", args: .object(["expect": .object(["revision": .null, "runtime": .null])])
    ) { _ in order.append("open") }
    transport.success(
      2,
      .object([
        "flowId": .string("aaaaaaaaaaaaaaaaaaaaaa"), "qrText": .string("fixture"),
        "expiresAt": .number(1),
      ]))
    transport.emit(
      .object([
        "v": .number(1), "event": .string("pairing.request"),
        "flowId": .string("aaaaaaaaaaaaaaaaaaaaaa"),
        "challengeId": .string("bbbbbbbbbbbbbbbbbbbbbb"),
        "phoneFp": .string("aaaaaaaaaaaaaaaaaaaaaaaaaa"), "name": .string("Fixture"),
      ]))
    XCTAssertEqual(order, ["open", "event"])
    transport.emit(
      .object([
        "v": .number(1), "event": .string("pairing.closed"),
        "flowId": .string("cccccccccccccccccccccc"),
      ]))
    XCTAssertTrue(transport.closed)
  }
}

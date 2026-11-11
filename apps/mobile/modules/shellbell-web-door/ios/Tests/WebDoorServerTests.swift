import Darwin
import Foundation
import XCTest

@testable import ShellbellWebDoorCore

private enum SocketTestError: Error {
    case failed(String, Int32)
    case timeout
}

private final class Peer {
    let fd: Int32

    init(port: Int) throws {
        fd = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw SocketTestError.failed("socket", errno) }
        var timeout = timeval(tv_sec: 3, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout<Int32>.size))
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = UInt16(port).bigEndian
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard connected == 0 else {
            Darwin.close(fd)
            throw SocketTestError.failed("connect", errno)
        }
    }

    deinit { Darwin.close(fd) }

    func send(_ data: Data) throws {
        var offset = 0
        while offset < data.count {
            let count = data.withUnsafeBytes {
                Darwin.send(fd, $0.baseAddress!.advanced(by: offset), data.count - offset, 0)
            }
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { throw SocketTestError.failed("send", errno) }
            offset += count
        }
    }

    func receive(count: Int) throws -> Data {
        var output = Data()
        var buffer = [UInt8](repeating: 0, count: max(1, count))
        while output.count < count {
            let received = buffer.withUnsafeMutableBytes {
                Darwin.recv(fd, $0.baseAddress, count - output.count, 0)
            }
            if received < 0 && errno == EINTR { continue }
            guard received > 0 else { throw SocketTestError.failed("receive", errno) }
            output.append(contentsOf: buffer.prefix(received))
        }
        return output
    }

    func eof() throws -> Bool {
        var byte: UInt8 = 0
        let received = Darwin.recv(fd, &byte, 1, 0)
        guard received >= 0 else { throw SocketTestError.failed("EOF", errno) }
        return received == 0
    }

    func shutdownOutput() { Darwin.shutdown(fd, SHUT_WR) }
}

private final class Events {
    private let condition = NSCondition()
    private var values: [WebDoorServer.Event] = []

    func receive(_ event: WebDoorServer.Event) {
        condition.lock()
        values.append(event)
        condition.broadcast()
        condition.unlock()
    }

    func count(_ name: String, id: Int? = nil) -> Int {
        condition.lock()
        defer { condition.unlock() }
        return values.filter { $0.name == name && (id == nil || $0.id == id) }.count
    }

    func wait(_ name: String, id: Int? = nil, count: Int = 1) throws -> [WebDoorServer.Event] {
        condition.lock()
        defer { condition.unlock() }
        let deadline = Date().addingTimeInterval(3)
        while true {
            let found = values.filter { $0.name == name && (id == nil || $0.id == id) }
            if found.count >= count { return found }
            guard condition.wait(until: deadline) else { throw SocketTestError.timeout }
        }
    }
}

final class WebDoorServerTests: XCTestCase {
    private func read(_ server: WebDoorServer, id: Int, events: Events, count: Int) throws -> Data {
        var output = Data()
        var buffer = [UInt8](repeating: 0, count: 128 * 1024)
        while output.count < count {
            let observed = events.count("readable", id: id)
            let received = buffer.withUnsafeMutableBytes { server.read(id, into: $0) }
            if received > 0 {
                output.append(contentsOf: buffer.prefix(received))
            } else if received == 0 {
                _ = try events.wait("readable", id: id, count: observed + 1)
            } else {
                throw SocketTestError.failed("native read ended", 0)
            }
        }
        return output
    }

    func testLoopbackBytesAndOrderedWriteAcknowledgements() throws {
        let events = Events()
        let server = WebDoorServer(onEvent: events.receive)
        defer { server.stop() }
        let door = try server.listen()
        let peer = try Peer(port: door.port)
        let accepted = try XCTUnwrap(events.wait("accepted").first)
        XCTAssertEqual(accepted.generation, door.generation)
        let request = Data("GET /example HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".utf8)
        try peer.send(request)
        XCTAssertEqual(
            try read(server, id: accepted.id, events: events, count: request.count), request)
        XCTAssertTrue(server.write(accepted.id, data: Data("one".utf8)))
        XCTAssertTrue(server.write(accepted.id, data: Data()))
        XCTAssertTrue(server.write(accepted.id, data: Data("two".utf8)))
        server.close(accepted.id)
        XCTAssertEqual(try peer.receive(count: 6), Data("onetwo".utf8))
        XCTAssertTrue(try peer.eof())
        let written = try events.wait("written", id: accepted.id, count: 3)
        XCTAssertEqual(written.map(\.bytes), [3, 0, 3])
    }

    func testReadBackpressureResumesWithoutLosingBytes() throws {
        let events = Events()
        let server = WebDoorServer(onEvent: events.receive)
        defer { server.stop() }
        let peer = try Peer(port: server.listen().port)
        let id = try XCTUnwrap(events.wait("accepted").first?.id)
        let payload = Data((0..<(4 * WebDoorServer.readLimit)).map { UInt8($0 & 255) })
        let sent = expectation(description: "peer sent all bytes")
        DispatchQueue.global().async {
            do { try peer.send(payload) } catch { XCTFail("Peer send failed: \(error)") }
            sent.fulfill()
        }
        _ = try events.wait("readable", id: id)
        var first = [UInt8](repeating: 0, count: 128 * 1024)
        let count = first.withUnsafeMutableBytes { server.read(id, into: $0) }
        XCTAssertGreaterThan(count, 0)
        XCTAssertLessThanOrEqual(count, WebDoorServer.readLimit)
        let remaining = try read(server, id: id, events: events, count: payload.count - count)
        XCTAssertEqual(Data(first.prefix(count)) + remaining, payload)
        wait(for: [sent], timeout: 3)
    }

    func testLargeResponseDrainsBeforeClose() throws {
        let events = Events()
        let server = WebDoorServer(onEvent: events.receive)
        defer { server.stop() }
        let peer = try Peer(port: server.listen().port)
        let id = try XCTUnwrap(events.wait("accepted").first?.id)
        let payload = Data((0..<WebDoorServer.writeLimit).map { UInt8($0 & 255) })
        XCTAssertTrue(server.write(id, data: payload))
        server.close(id)
        XCTAssertEqual(try peer.receive(count: payload.count), payload)
        XCTAssertTrue(try peer.eof())
        let written = try events.wait("written", id: id)
        XCTAssertEqual(written.map(\.bytes), [payload.count])
    }

    func testPeerEOFDrainsInputAndStillAllowsAResponse() throws {
        let events = Events()
        let server = WebDoorServer(onEvent: events.receive)
        defer { server.stop() }
        let peer = try Peer(port: server.listen().port)
        let id = try XCTUnwrap(events.wait("accepted").first?.id)
        try peer.send(Data("request".utf8))
        peer.shutdownOutput()
        XCTAssertEqual(try read(server, id: id, events: events, count: 7), Data("request".utf8))
        var scratch = [UInt8](repeating: 0, count: 16)
        var received = 0
        while received == 0 {
            let observed = events.count("readable", id: id)
            received = scratch.withUnsafeMutableBytes { server.read(id, into: $0) }
            if received == 0 { _ = try events.wait("readable", id: id, count: observed + 1) }
        }
        XCTAssertEqual(received, -1)
        XCTAssertTrue(server.write(id, data: Data("response".utf8)))
        server.shutdownOutput(id)
        XCTAssertEqual(try peer.receive(count: 8), Data("response".utf8))
        XCTAssertTrue(try peer.eof())
        XCTAssertFalse(server.write(id, data: Data("late".utf8)))
    }

    func testStopRetiresSocketsAndGenerations() throws {
        let events = Events()
        let server = WebDoorServer(onEvent: events.receive)
        defer { server.stop() }
        let first = try server.listen()
        let oldPeer = try Peer(port: first.port)
        let old = try XCTUnwrap(events.wait("accepted").first)
        server.stop()
        XCTAssertTrue(try oldPeer.eof())
        let next = try server.listen()
        XCTAssertGreaterThan(next.generation, first.generation)
        let peer = try Peer(port: next.port)
        let current = try XCTUnwrap(events.wait("accepted", count: 2).last)
        XCTAssertGreaterThan(current.id, old.id)
        XCTAssertEqual(current.generation, next.generation)
        XCTAssertFalse(server.write(old.id, data: Data("stale".utf8)))
        try peer.send(Data("current".utf8))
        XCTAssertEqual(
            try read(server, id: current.id, events: events, count: 7), Data("current".utf8))
    }

    func testSocketAndWriteLimitsCloseExcessWork() throws {
        let events = Events()
        let server = WebDoorServer(onEvent: events.receive)
        defer { server.stop() }
        let door = try server.listen()
        var peers: [Peer] = []
        for _ in 0..<32 { peers.append(try Peer(port: door.port)) }
        let accepted = try events.wait("accepted", count: 32)
        let excess = try Peer(port: door.port)
        XCTAssertTrue(try excess.eof())
        XCTAssertEqual(events.count("accepted"), 32)
        let id = try XCTUnwrap(accepted.first?.id)
        XCTAssertFalse(server.write(id, data: Data(count: WebDoorServer.writeLimit + 1)))
        _ = try events.wait("closed", id: id)
        XCTAssertTrue(try peers[0].eof())
        withExtendedLifetime(peers) {}
    }
}

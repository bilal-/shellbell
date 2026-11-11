import Darwin
import Foundation

struct WebDoorSocketError: Error {
    let operation: String
    let code: Int32
}

/// A bounded loopback byte transport. The shared TypeScript door owns HTTP and authentication.
final class WebDoorServer {
    static let readLimit = 64 * 1024
    static let writeLimit = 256 * 1024
    private static let readChunk = 16 * 1024
    private static let socketLimit = 32
    private static let writeItems = 512

    struct Event {
        let name: String
        let id: Int
        let generation: Int
        var bytes: Int? = nil
    }

    private enum Output {
        case bytes(Data, offset: Int)
        case shutdown
        case close
    }

    private final class Connection {
        let fd: Int32
        let generation: Int
        let reader: DispatchSourceRead
        let writer: DispatchSourceWrite
        var input: [Data] = []
        var inputOffset = 0
        var inputBytes = 0
        var readEnded = false
        var readPaused = false
        var output: [Output] = []
        var outputBytes = 0
        var writePaused = true
        var shutdownQueued = false
        var closeQueued = false

        init(fd: Int32, generation: Int, queue: DispatchQueue) {
            self.fd = fd
            self.generation = generation
            reader = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
            writer = DispatchSource.makeWriteSource(fileDescriptor: fd, queue: queue)
        }
    }

    private let queue = DispatchQueue(label: "sh.bilal.shellbell.web-door")
    private let queueKey = DispatchSpecificKey<Bool>()
    private let onEvent: (Event) -> Void
    private var listener: DispatchSourceRead?
    private var listenerFD: Int32 = -1
    private var generation = 0
    private var nextID = 1
    private var connections: [Int: Connection] = [:]

    init(onEvent: @escaping (Event) -> Void) {
        self.onEvent = onEvent
        queue.setSpecific(key: queueKey, value: true)
    }

    deinit { stop() }

    private func synchronized<T>(_ operation: () throws -> T) rethrows -> T {
        if DispatchQueue.getSpecific(key: queueKey) == true { return try operation() }
        return try queue.sync(execute: operation)
    }

    func listen() throws -> (port: Int, generation: Int) {
        try synchronized {
            stopListening()
            let fd = Darwin.socket(AF_INET, SOCK_STREAM, 0)
            guard fd >= 0 else { throw WebDoorSocketError(operation: "socket", code: errno) }
            var retained = false
            defer { if !retained { Darwin.close(fd) } }
            try configure(fd)
            var address = sockaddr_in()
            address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            address.sin_family = sa_family_t(AF_INET)
            address.sin_addr.s_addr = inet_addr("127.0.0.1")
            let bound = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
            guard bound == 0 else { throw WebDoorSocketError(operation: "bind", code: errno) }
            guard Darwin.listen(fd, 16) == 0 else {
                throw WebDoorSocketError(operation: "listen", code: errno)
            }
            var size = socklen_t(MemoryLayout<sockaddr_in>.size)
            let named = withUnsafeMutablePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &size) }
            }
            guard named == 0 else {
                throw WebDoorSocketError(operation: "getsockname", code: errno)
            }
            let current = generation
            let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
            source.setEventHandler { [weak self] in self?.accept(fd: fd, generation: current) }
            source.setCancelHandler { Darwin.close(fd) }
            listenerFD = fd
            listener = source
            retained = true
            source.resume()
            return (Int(UInt16(bigEndian: address.sin_port)), current)
        }
    }

    func stop() { synchronized { stopListening() } }

    private func stopListening() {
        generation += 1
        listenerFD = -1
        listener?.cancel()
        listener = nil
        for id in Array(connections.keys) { terminate(id) }
    }

    private func configure(_ fd: Int32) throws {
        let flags = fcntl(fd, F_GETFL)
        guard flags >= 0, fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0 else {
            throw WebDoorSocketError(operation: "nonblocking", code: errno)
        }
        var yes: Int32 = 1
        guard
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout<Int32>.size)) == 0
        else {
            throw WebDoorSocketError(operation: "nosigpipe", code: errno)
        }
    }

    private func accept(fd: Int32, generation current: Int) {
        guard listenerFD == fd, generation == current else { return }
        while listenerFD == fd, generation == current {
            let socket = Darwin.accept(fd, nil, nil)
            if socket < 0 {
                if errno == EINTR { continue }
                return
            }
            guard connections.count < Self.socketLimit else {
                Darwin.close(socket)
                continue
            }
            do { try configure(socket) } catch {
                Darwin.close(socket)
                continue
            }
            var yes: Int32 = 1
            setsockopt(socket, IPPROTO_TCP, TCP_NODELAY, &yes, socklen_t(MemoryLayout<Int32>.size))
            let id = nextID
            nextID += 1
            let connection = Connection(fd: socket, generation: current, queue: queue)
            connections[id] = connection
            connection.reader.setEventHandler { [weak self, weak connection] in
                guard let self, let connection, self.connections[id] === connection else { return }
                self.receive(id, connection)
            }
            connection.writer.setEventHandler { [weak self, weak connection] in
                guard let self, let connection, self.connections[id] === connection else { return }
                self.flush(id, connection)
            }
            connection.reader.resume()
            onEvent(Event(name: "accepted", id: id, generation: current))
        }
    }

    private func receive(_ id: Int, _ connection: Connection) {
        var buffer = [UInt8](repeating: 0, count: Self.readChunk)
        var changed = false
        while connection.inputBytes < Self.readLimit {
            let count = min(Self.readChunk, Self.readLimit - connection.inputBytes)
            let received = buffer.withUnsafeMutableBytes {
                Darwin.recv(connection.fd, $0.baseAddress, count, 0)
            }
            if received > 0 {
                connection.input.append(Data(buffer.prefix(received)))
                connection.inputBytes += received
                changed = true
            } else if received == 0 {
                connection.readEnded = true
                pauseRead(connection)
                changed = true
                break
            } else {
                if errno == EINTR { continue }
                if errno == EAGAIN || errno == EWOULDBLOCK { break }
                terminate(id)
                return
            }
        }
        if connection.inputBytes == Self.readLimit { pauseRead(connection) }
        if changed { onEvent(Event(name: "readable", id: id, generation: connection.generation)) }
    }

    private func pauseRead(_ connection: Connection) {
        if !connection.readPaused {
            connection.readPaused = true
            connection.reader.suspend()
        }
    }

    /// Typed-array memory is used only while the JavaScript caller waits for this synchronous operation.
    func read(_ id: Int, into destination: UnsafeMutableRawBufferPointer) -> Int {
        synchronized {
            guard let connection = connections[id] else { return -1 }
            var copied = 0
            while copied < destination.count, let head = connection.input.first {
                let count = min(destination.count - copied, head.count - connection.inputOffset)
                head.withUnsafeBytes {
                    destination.baseAddress!.advanced(by: copied).copyMemory(
                        from: $0.baseAddress!.advanced(by: connection.inputOffset), byteCount: count
                    )
                }
                copied += count
                connection.inputBytes -= count
                connection.inputOffset += count
                if connection.inputOffset == head.count {
                    connection.input.removeFirst()
                    connection.inputOffset = 0
                }
            }
            if connection.readPaused && !connection.readEnded
                && connection.inputBytes < Self.readLimit
            {
                connection.readPaused = false
                connection.reader.resume()
            }
            return copied == 0 && connection.readEnded ? -1 : copied
        }
    }

    func write(_ id: Int, data: Data) -> Bool {
        synchronized {
            guard let connection = connections[id], !connection.closeQueued,
                !connection.shutdownQueued
            else { return false }
            guard connection.outputBytes + data.count <= Self.writeLimit,
                connection.output.count < Self.writeItems
            else {
                terminate(id)
                return false
            }
            connection.output.append(.bytes(data, offset: 0))
            connection.outputBytes += data.count
            flush(id, connection)
            return true
        }
    }

    func shutdownOutput(_ id: Int) {
        synchronized {
            guard let connection = connections[id], !connection.shutdownQueued,
                !connection.closeQueued
            else { return }
            connection.shutdownQueued = true
            connection.output.append(.shutdown)
            flush(id, connection)
        }
    }

    /// Ordinary close drains earlier writes. stop() cancels them when a visit is retired.
    func close(_ id: Int) {
        synchronized {
            guard let connection = connections[id], !connection.closeQueued else { return }
            connection.closeQueued = true
            connection.output.append(.close)
            flush(id, connection)
        }
    }

    private func flush(_ id: Int, _ connection: Connection) {
        while let output = connection.output.first {
            switch output {
            case .bytes(let data, let offset):
                if offset == data.count {
                    connection.output.removeFirst()
                    connection.outputBytes -= data.count
                    onEvent(
                        Event(
                            name: "written", id: id, generation: connection.generation,
                            bytes: data.count))
                    guard connections[id] === connection else { return }
                    continue
                }
                let sent = data.withUnsafeBytes {
                    Darwin.send(
                        connection.fd, $0.baseAddress!.advanced(by: offset), data.count - offset, 0)
                }
                if sent > 0 {
                    connection.output[0] = .bytes(data, offset: offset + sent)
                    continue
                }
                if sent < 0 && errno == EINTR { continue }
                if sent < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) {
                    if connection.writePaused {
                        connection.writePaused = false
                        connection.writer.resume()
                    }
                    return
                }
                terminate(id)
                return
            case .shutdown:
                Darwin.shutdown(connection.fd, SHUT_WR)
                connection.output.removeFirst()
            case .close:
                terminate(id)
                return
            }
        }
        if !connection.writePaused {
            connection.writePaused = true
            connection.writer.suspend()
        }
    }

    private func terminate(_ id: Int) {
        guard let connection = connections.removeValue(forKey: id) else { return }
        Darwin.shutdown(connection.fd, SHUT_RDWR)
        // A descriptor stays owned until both dispatch sources have completed cancellation.
        let cancelled = DispatchGroup()
        cancelled.enter()
        cancelled.enter()
        connection.reader.setCancelHandler { cancelled.leave() }
        connection.writer.setCancelHandler { cancelled.leave() }
        let fd = connection.fd
        cancelled.notify(queue: queue) { Darwin.close(fd) }
        connection.reader.cancel()
        connection.writer.cancel()
        if connection.readPaused { connection.reader.resume() }
        if connection.writePaused { connection.writer.resume() }
        onEvent(Event(name: "closed", id: id, generation: connection.generation))
    }
}

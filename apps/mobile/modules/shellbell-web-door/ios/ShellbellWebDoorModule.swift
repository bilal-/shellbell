import ExpoModulesCore
import Foundation
import WebKit

public final class ShellbellWebDoorModule: Module {
    private lazy var server = WebDoorServer { [weak self] event in
        DispatchQueue.main.async { [weak self] in
            var body: [String: Any] = ["id": event.id, "generation": event.generation]
            if let bytes = event.bytes { body["bytes"] = bytes }
            self?.sendEvent(event.name, body)
        }
    }

    private func bytes(_ array: Uint8Array) -> Data {
        Data(bytes: array.rawPointer, count: array.byteLength)
    }

    public func definition() -> ModuleDefinition {
        Name("ShellbellWebDoor")
        Events("accepted", "readable", "written", "closed")
        Function("listen") { () throws -> [Int] in
            let door = try self.server.listen()
            return [door.port, door.generation]
        }
        Function("stop") { self.server.stop() }
        Function("read") { (id: Int, out: Uint8Array) -> Int in
            self.server.read(
                id,
                into: UnsafeMutableRawBufferPointer(start: out.rawPointer, count: out.byteLength))
        }
        Function("write") { (id: Int, data: Uint8Array) -> Bool in
            self.server.write(id, data: self.bytes(data))
        }
        Function("shutdownOutput") { (id: Int) in self.server.shutdownOutput(id) }
        Function("close") { (id: Int) in self.server.close(id) }
        AsyncFunction("clearWebData") { (promise: Promise) in
            // Apps use a separate nonpersistent WKWebsiteDataStore for every WebView visit.
            WKWebsiteDataStore.default().removeData(
                ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast
            ) { promise.resolve(true) }
        }.runOnQueue(.main)
        Function("aeadSeal") {
            (key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, input: Uint8Array, out: Uint8Array)
                throws in
            guard out.byteLength == input.byteLength + 16 else {
                throw TransportAeadError.invalidInput
            }
            let sealed = try TransportAead.seal(
                key: self.bytes(key), nonce: self.bytes(nonce), ad: self.bytes(ad),
                plaintext: self.bytes(input))
            sealed.copyBytes(
                to: out.rawPointer.assumingMemoryBound(to: UInt8.self), count: sealed.count)
        }
        Function("aeadOpen") {
            (key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, input: Uint8Array, out: Uint8Array)
                throws -> Int in
            guard input.byteLength >= 16, out.byteLength == input.byteLength - 16 else {
                throw TransportAeadError.invalidInput
            }
            guard
                let opened = try TransportAead.open(
                    key: self.bytes(key), nonce: self.bytes(nonce), ad: self.bytes(ad),
                    ciphertext: self.bytes(input))
            else { return -1 }
            if !opened.isEmpty {
                opened.copyBytes(
                    to: out.rawPointer.assumingMemoryBound(to: UInt8.self), count: opened.count)
            }
            return opened.count
        }
        OnDestroy { self.server.stop() }
    }
}

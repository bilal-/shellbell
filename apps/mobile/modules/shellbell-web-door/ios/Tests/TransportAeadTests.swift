import Foundation
import XCTest

@testable import ShellbellWebDoorCore

final class TransportAeadTests: XCTestCase {
    private func hex(_ text: String) -> Data {
        let bytes = Array(text.utf8)
        return Data(
            stride(from: 0, to: bytes.count, by: 2).map {
                UInt8(String(bytes: bytes[$0..<$0 + 2], encoding: .utf8)!, radix: 16)!
            })
    }

    func testRFC8439TransportFrame() throws {
        let key = hex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f")
        let nonce = hex("070000004041424344454647")
        let ad = hex("50515253c0c1c2c3c4c5c6c7")
        let plaintext = Data(
            "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it."
                .utf8)
        let expected = hex(
            "d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d6"
                + "3dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b36"
                + "92ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc3"
                + "ff4def08e4b7a9de576d26586cec64b61161ae10b594f09e26a7e902ecbd0600691")
        XCTAssertEqual(
            try TransportAead.seal(key: key, nonce: nonce, ad: ad, plaintext: plaintext), expected)
        XCTAssertEqual(
            try TransportAead.open(key: key, nonce: nonce, ad: ad, ciphertext: expected), plaintext)
    }

    func testEmptyAndMaximumNoisePayloads() throws {
        let key = Data(repeating: 0x42, count: 32)
        let nonce = Data(repeating: 0xff, count: 12)
        let ad = Data(repeating: 0xa5, count: 13)
        for count in [0, 31, 16_384, 65_519] {
            let plaintext = Data((0..<count).map { UInt8($0 & 255) })
            let sealed = try TransportAead.seal(
                key: key, nonce: nonce, ad: ad, plaintext: plaintext)
            XCTAssertEqual(sealed.count, count + 16)
            XCTAssertEqual(
                try TransportAead.open(key: key, nonce: nonce, ad: ad, ciphertext: sealed),
                plaintext)
            var forged = sealed
            forged[forged.count - 1] ^= 1
            XCTAssertNil(try TransportAead.open(key: key, nonce: nonce, ad: ad, ciphertext: forged))
        }
    }

    func testInvalidSizesAreRejected() throws {
        let key = Data(repeating: 0, count: 32)
        let nonce = Data(repeating: 0, count: 12)
        XCTAssertThrowsError(
            try TransportAead.seal(key: Data(), nonce: nonce, ad: Data(), plaintext: Data()))
        XCTAssertThrowsError(
            try TransportAead.seal(key: key, nonce: Data(), ad: Data(), plaintext: Data()))
        XCTAssertThrowsError(
            try TransportAead.seal(
                key: key, nonce: nonce, ad: Data(), plaintext: Data(count: 65_520)))
        XCTAssertThrowsError(
            try TransportAead.open(key: key, nonce: nonce, ad: Data(), ciphertext: Data(count: 15)))
    }
}

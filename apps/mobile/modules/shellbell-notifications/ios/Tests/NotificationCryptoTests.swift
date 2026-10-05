import Foundation
import XCTest
@testable import ShellbellNotificationCore

final class NotificationCryptoTests: XCTestCase {
    func testRelayTransportFixturesDecryptAndPresentTwoSessionsWithoutTitleCache() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../../../packages/protocol/test/notification-transport-vectors.json")
        let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        var groups = Set<String>()
        var subtitles = Set<String>()
        for item in fixture["cases"] as! [[String: Any]] {
            let box = item["box"] as! [String: Any]
            let opened = try NotificationCrypto.open(key: bytes(fixture["key"] as! String), box: box)
            let payload = try JSONSerialization.jsonObject(with: opened) as! [String: Any]
            let presentation = NotificationPresentation.authenticated(payload)
            XCTAssertEqual(presentation.title, "private-repository-qa · private-branch-qa")
            subtitles.insert(presentation.subtitle)
            groups.insert(NotificationPresentation.sessionGroup(computer: box["computerFp"] as! String, session: box["sessionId"] as! String))
        }
        XCTAssertEqual(groups.count, 2)
        XCTAssertEqual(subtitles.count, 2)
    }
    func fixture() throws -> [String: Any] {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../../../packages/protocol/test/notification-vectors.json")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    func bytes(_ hex: String) -> Data {
        var data = Data()
        var index = hex.startIndex
        while index < hex.endIndex {
            let end = hex.index(index, offsetBy: 2)
            data.append(UInt8(hex[index..<end], radix: 16)!)
            index = end
        }
        return data
    }

    func testOpensIndependentOpenSSLFixtureWithoutJavaScript() throws {
        let f = try fixture()
        let result = try NotificationCrypto.open(key: bytes(f["key"] as! String), box: f["box"] as! [String: Any])
        XCTAssertEqual(String(data: result, encoding: .utf8), f["plaintext"] as? String)
    }

    func testRejectsAllSharedInvalidVectors() throws {
        let f = try fixture()
        for bad in f["invalid"] as! [[String: Any]] {
            XCTAssertThrowsError(try NotificationCrypto.open(key: bytes(bad["key"] as! String), box: bad["box"] as! [String: Any]), bad["name"] as! String)
        }
    }

    func testRejectsUnknownOuterFieldsAndOversizedEncodedInput() throws {
        let f = try fixture()
        let key = bytes(f["key"] as! String)
        var box = f["box"] as! [String: Any]
        box["output"] = "must not enter notification"
        XCTAssertThrowsError(try NotificationCrypto.open(key: key, box: box))
        box.removeValue(forKey: "output")
        box["ciphertext"] = String(repeating: "A", count: 2071)
        XCTAssertThrowsError(try NotificationCrypto.open(key: key, box: box))
    }
}

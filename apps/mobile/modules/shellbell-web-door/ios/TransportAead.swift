import CryptoKit
import Foundation

enum TransportAeadError: Error {
    case invalidInput
}

enum TransportAead {
    static func seal(key: Data, nonce: Data, ad: Data, plaintext: Data) throws -> Data {
        guard key.count == 32, nonce.count == 12, plaintext.count <= 65_519 else {
            throw TransportAeadError.invalidInput
        }
        let box = try ChaChaPoly.seal(
            plaintext, using: SymmetricKey(data: key), nonce: ChaChaPoly.Nonce(data: nonce),
            authenticating: ad)
        return box.ciphertext + box.tag
    }

    static func open(key: Data, nonce: Data, ad: Data, ciphertext: Data) throws -> Data? {
        guard key.count == 32, nonce.count == 12, (16...65_535).contains(ciphertext.count) else {
            throw TransportAeadError.invalidInput
        }
        let box = try ChaChaPoly.SealedBox(
            nonce: ChaChaPoly.Nonce(data: nonce), ciphertext: ciphertext.dropLast(16),
            tag: ciphertext.suffix(16))
        return try? ChaChaPoly.open(box, using: SymmetricKey(data: key), authenticating: ad)
    }
}

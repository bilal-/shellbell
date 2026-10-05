/**
 * Experimental Noise_KKpsk2_25519_ChaChaPoly_SHA256 primitive.
 *
 * This follows the Noise specification and is checked against the independent
 * Sendspin KKpsk2 vector. It is deliberately NOT exported from the protocol
 * package root or used by live connections until wire binding, key confirmation,
 * cross-runtime tests, and independent cryptographic review are complete.
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concat, utf8 } from "./bytes.js";

const EMPTY = new Uint8Array(0);
const PROTOCOL = utf8("Noise_KKpsk2_25519_ChaChaPoly_SHA256");
const MAX_SEQUENCE = (1n << 64n) - 2n; // 2^64 - 1 is reserved by Noise.
const MAX_MESSAGE_BYTES = 65_535;
const TRANSPORT_FACTORY = Symbol("Noise transport factory");

function isTestRuntime(): boolean {
  return (
    (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV === "test"
  );
}

function requireSequence(sequence: bigint): void {
  if (sequence < 0n || sequence > MAX_SEQUENCE) {
    throw new Error("invalid Noise sequence or reserved nonce");
  }
}

export function encodeNoiseSequence(sequence: bigint): Uint8Array {
  requireSequence(sequence);
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, sequence, true);
  return bytes;
}

export function decodeNoiseSequence(bytes: Uint8Array): bigint {
  if (bytes.length !== 8) throw new Error("invalid Noise sequence length");
  const sequence = new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true);
  requireSequence(sequence);
  return sequence;
}

function aeadNonce(sequence: bigint): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce.set(encodeNoiseSequence(sequence), 4);
  return nonce;
}

function noiseHkdf(chainingKey: Uint8Array, input: Uint8Array, count: 2): [Uint8Array, Uint8Array];
function noiseHkdf(
  chainingKey: Uint8Array,
  input: Uint8Array,
  count: 3,
): [Uint8Array, Uint8Array, Uint8Array];
function noiseHkdf(chainingKey: Uint8Array, input: Uint8Array, count: 2 | 3): Uint8Array[] {
  const tempKey = hmac(sha256, chainingKey, input);
  const one = hmac(sha256, tempKey, Uint8Array.of(1));
  const two = hmac(sha256, tempKey, concat(one, Uint8Array.of(2)));
  const result =
    count === 2 ? [one, two] : [one, two, hmac(sha256, tempKey, concat(two, Uint8Array.of(3)))];
  tempKey.fill(0);
  return result;
}

function checkedDh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(privateKey, publicKey);
  if (shared.every((byte) => byte === 0)) throw new Error("invalid Noise public key");
  return shared;
}

class SymmetricState {
  private chainingKey: Uint8Array = sha256(PROTOCOL);
  private hash: Uint8Array = this.chainingKey.slice();
  private key: Uint8Array | null = null;
  private nonce = 0n;

  get handshakeHash(): Uint8Array {
    return this.hash.slice();
  }

  mixHash(data: Uint8Array): void {
    this.hash = sha256(concat(this.hash, data));
  }

  private setKey(key: Uint8Array): void {
    this.key?.fill(0);
    this.key = key;
    this.nonce = 0n;
  }

  mixKey(data: Uint8Array): void {
    const [chainingKey, key] = noiseHkdf(this.chainingKey, data, 2);
    this.chainingKey.fill(0);
    this.chainingKey = chainingKey;
    this.setKey(key);
  }

  mixKeyAndHash(data: Uint8Array): void {
    const [chainingKey, hashPart, key] = noiseHkdf(this.chainingKey, data, 3);
    this.chainingKey.fill(0);
    this.chainingKey = chainingKey;
    this.mixHash(hashPart);
    hashPart.fill(0);
    this.setKey(key);
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    if (!this.key) throw new Error("Noise handshake key missing");
    const ciphertext = chacha20poly1305(this.key, aeadNonce(this.nonce), this.hash).encrypt(
      plaintext,
    );
    this.nonce += 1n;
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    if (!this.key) throw new Error("Noise handshake key missing");
    const plaintext = chacha20poly1305(this.key, aeadNonce(this.nonce), this.hash).decrypt(
      ciphertext,
    );
    this.nonce += 1n;
    this.mixHash(ciphertext);
    return plaintext;
  }

  split(): [Uint8Array, Uint8Array] {
    const [first, second] = noiseHkdf(this.chainingKey, EMPTY, 2);
    this.close();
    return [first, second];
  }

  close(): void {
    this.chainingKey.fill(0);
    this.hash.fill(0);
    this.key?.fill(0);
    this.key = null;
  }
}

export class NoiseTransport {
  private readonly sendKey: Uint8Array;
  private readonly receiveKey: Uint8Array;
  private lastSent = -1n;
  private lastReceived = -1n;
  private closed = false;

  constructor(
    role: "initiator" | "responder",
    first: Uint8Array,
    second: Uint8Array,
    factory: typeof TRANSPORT_FACTORY,
  ) {
    if (factory !== TRANSPORT_FACTORY) throw new Error("Noise transport factory required");
    this.sendKey = new Uint8Array(role === "initiator" ? first : second);
    this.receiveKey = new Uint8Array(role === "initiator" ? second : first);
    first.fill(0);
    second.fill(0);
  }

  seal(sequence: bigint, plaintext: Uint8Array, ad: Uint8Array = EMPTY): Uint8Array {
    if (this.closed) throw new Error("Noise transport closed");
    if (plaintext.length > MAX_MESSAGE_BYTES - 16) throw new Error("Noise message too large");
    requireSequence(sequence);
    if (sequence <= this.lastSent) throw new Error("Noise send sequence reuse");
    const ciphertext = chacha20poly1305(this.sendKey, aeadNonce(sequence), ad).encrypt(plaintext);
    // Consume the nonce even if the caller later fails local queue admission.
    this.lastSent = sequence;
    return ciphertext;
  }

  open(sequence: bigint, ciphertext: Uint8Array, ad: Uint8Array = EMPTY): Uint8Array {
    if (this.closed) throw new Error("Noise transport closed");
    if (ciphertext.length < 16 || ciphertext.length > MAX_MESSAGE_BYTES) {
      throw new Error("Noise message length invalid");
    }
    requireSequence(sequence);
    if (sequence <= this.lastReceived) throw new Error("Noise receive sequence replay");
    const plaintext = chacha20poly1305(this.receiveKey, aeadNonce(sequence), ad).decrypt(
      ciphertext,
    );
    // A forged high sequence may not block a later authentic frame.
    this.lastReceived = sequence;
    return plaintext;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sendKey.fill(0);
    this.receiveKey.fill(0);
  }
}

export interface NoiseKKpsk2Options {
  role: "initiator" | "responder";
  staticPrivate: Uint8Array;
  remoteStatic: Uint8Array;
  psk: Uint8Array;
  prologue: Uint8Array;
  /** Deterministic fixture injection only. Production callers must omit. */
  ephemeralPrivate?: Uint8Array;
}

/** Two-message KKpsk2 handshake. Application data is forbidden until a separate key-confirmation exchange. */
export class NoiseKKpsk2Handshake {
  private readonly role: NoiseKKpsk2Options["role"];
  private readonly staticPrivate: Uint8Array;
  private readonly remoteStatic: Uint8Array;
  private readonly psk: Uint8Array;
  private readonly ephemeralPrivate: Uint8Array;
  private remoteEphemeral: Uint8Array | null = null;
  private readonly symmetric = new SymmetricState();
  private finalHash: Uint8Array | null = null;
  private phase: "first" | "second" | "complete" | "failed" = "first";

  constructor(options: NoiseKKpsk2Options) {
    if (options.role !== "initiator" && options.role !== "responder") {
      throw new Error("invalid Noise role");
    }
    if (options.ephemeralPrivate && !isTestRuntime()) {
      throw new Error("fixed Noise ephemeral key is test-only");
    }
    for (const value of [options.staticPrivate, options.remoteStatic, options.psk]) {
      if (value.length !== 32) throw new Error("Noise key must be 32 bytes");
    }
    if (options.prologue.length > 1024) throw new Error("Noise prologue too large");
    if (options.ephemeralPrivate && options.ephemeralPrivate.length !== 32) {
      throw new Error("Noise ephemeral key must be 32 bytes");
    }
    this.role = options.role;
    // Buffer.prototype.slice aliases memory; key erasure must never wipe caller-owned pair keys.
    this.staticPrivate = new Uint8Array(options.staticPrivate);
    this.remoteStatic = new Uint8Array(options.remoteStatic);
    this.psk = new Uint8Array(options.psk);
    this.ephemeralPrivate = options.ephemeralPrivate
      ? new Uint8Array(options.ephemeralPrivate)
      : x25519.utils.randomSecretKey();
    this.symmetric.mixHash(options.prologue);
    const localStatic = x25519.getPublicKey(this.staticPrivate);
    // Noise KK pre-messages are always initiator static, then responder static.
    this.symmetric.mixHash(this.role === "initiator" ? localStatic : this.remoteStatic);
    this.symmetric.mixHash(this.role === "responder" ? localStatic : this.remoteStatic);
  }

  get handshakeHash(): Uint8Array {
    if (this.finalHash) return this.finalHash.slice();
    if (this.phase !== "complete") throw new Error("Noise handshake not complete");
    return this.symmetric.handshakeHash;
  }

  write(payload: Uint8Array = EMPTY): Uint8Array {
    if (payload.length > 0 && !isTestRuntime()) {
      throw new Error("Noise handshake payloads are test-only");
    }
    if (
      (this.role === "initiator" && this.phase !== "first") ||
      (this.role === "responder" && this.phase !== "second")
    )
      throw new Error("Noise handshake message order");
    if (payload.length > MAX_MESSAGE_BYTES - 48)
      throw new Error("Noise handshake payload too large");
    try {
      const ephemeral = x25519.getPublicKey(this.ephemeralPrivate);
      this.symmetric.mixHash(ephemeral);
      this.symmetric.mixKey(ephemeral); // Required for PSK-modified Noise patterns.
      if (this.role === "initiator") {
        this.symmetric.mixKey(checkedDh(this.ephemeralPrivate, this.remoteStatic)); // es
        this.symmetric.mixKey(checkedDh(this.staticPrivate, this.remoteStatic)); // ss
      } else {
        if (!this.remoteEphemeral) throw new Error("Noise peer ephemeral key missing");
        this.symmetric.mixKey(checkedDh(this.ephemeralPrivate, this.remoteEphemeral)); // ee
        this.symmetric.mixKey(checkedDh(this.ephemeralPrivate, this.remoteStatic)); // se
        this.symmetric.mixKeyAndHash(this.psk);
      }
      const message = concat(ephemeral, this.symmetric.encryptAndHash(payload));
      this.phase = this.role === "initiator" ? "second" : "complete";
      return message;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  read(message: Uint8Array): Uint8Array {
    if (
      (this.role === "responder" && this.phase !== "first") ||
      (this.role === "initiator" && this.phase !== "second")
    )
      throw new Error("Noise handshake message order");
    if (message.length < 48 || message.length > MAX_MESSAGE_BYTES) {
      this.close();
      throw new Error("Noise handshake message length");
    }
    if (message.length !== 48 && !isTestRuntime()) {
      this.close();
      throw new Error("Noise handshake payloads are test-only");
    }
    try {
      const remoteEphemeral = new Uint8Array(message.subarray(0, 32));
      this.remoteEphemeral = remoteEphemeral;
      this.symmetric.mixHash(remoteEphemeral);
      this.symmetric.mixKey(remoteEphemeral);
      if (this.role === "responder") {
        this.symmetric.mixKey(checkedDh(this.staticPrivate, remoteEphemeral)); // es
        this.symmetric.mixKey(checkedDh(this.staticPrivate, this.remoteStatic)); // ss
      } else {
        this.symmetric.mixKey(checkedDh(this.ephemeralPrivate, remoteEphemeral)); // ee
        this.symmetric.mixKey(checkedDh(this.staticPrivate, remoteEphemeral)); // se
        this.symmetric.mixKeyAndHash(this.psk);
      }
      const payload = this.symmetric.decryptAndHash(message.subarray(32));
      this.phase = this.role === "responder" ? "second" : "complete";
      return payload;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  split(): NoiseTransport {
    if (this.phase !== "complete") throw new Error("Noise handshake not complete");
    this.finalHash = this.symmetric.handshakeHash;
    const [first, second] = this.symmetric.split();
    this.close();
    return new NoiseTransport(this.role, first, second, TRANSPORT_FACTORY);
  }

  close(): void {
    if (this.phase === "failed") return;
    this.phase = "failed";
    this.staticPrivate.fill(0);
    this.remoteStatic.fill(0);
    this.psk.fill(0);
    this.ephemeralPrivate.fill(0);
    this.remoteEphemeral?.fill(0);
    this.symmetric.close();
  }
}

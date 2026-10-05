import { x25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes, utf8 } from "../src/bytes.js";
import { deriveNoisePsk } from "../src/crypto.js";
import {
  decodeNoiseSequence,
  encodeNoiseSequence,
  NoiseKKpsk2Handshake,
  NoiseTransport,
} from "../src/noise-kkpsk2.js";

// ChaChaPoly/SHA256 known-answer data from Sendspin's Apache-2.0 KKpsk2
// vector fixture (https://github.com/Sendspin/sendspin-js). The fixture is
// based on Noise protocol test vectors; no Sendspin implementation is copied.
const vector = {
  prologue: "4a6f686e2047616c74",
  psk: "54686973206973206d7920417573747269616e20706572737065637469766521",
  initStatic: "e61ef9919cde45dd5f82166404bd08e38bceb5dfdfded0a34c8df7ed542214d1",
  initEphemeral: "893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a",
  initRemoteStatic: "31e0303fd6418d2f8c0e78b91f22e8caed0fbe48656dcf4767e4834f701b8f62",
  respStatic: "4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893",
  respEphemeral: "bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b",
  respRemoteStatic: "6bc3822a2aa7f4e6981d6538692b3cdf3e6df9eea6ed269eb41d93c22757b75a",
  handshakeHash: "7f3c5fdcdd3767e2835473a2683971490339f5bbeee82c3690bc606e14db70ed",
  firstPayload: "4c756477696720766f6e204d69736573",
  firstMessage:
    "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c7944babf6443250c604872e33233c3b9a29df5c6d334ae2d53f1bd7f0b265a716b37",
  secondPayload: "4d757272617920526f746862617264",
  secondMessage:
    "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f14480884366a1f5f0d79fe93ae476bd1897a7a8ae92764898aa5d49e07b5849f35865ba",
  transportPayload: "462e20412e20486179656b",
  transportCiphertext: "2eb2686b8814a7c0178fe18bfeeafe3e07312d69486d45e6572546",
  reversePayload: "4361726c204d656e676572",
  reverseCiphertext: "eea5791a890cd573a5c2e2345a8f98b0d1f0727acd24584fcddde5",
};

function peers(psk = hexToBytes(vector.psk), prologue = hexToBytes(vector.prologue)) {
  const initiator = new NoiseKKpsk2Handshake({
    role: "initiator",
    staticPrivate: hexToBytes(vector.initStatic),
    remoteStatic: hexToBytes(vector.initRemoteStatic),
    ephemeralPrivate: hexToBytes(vector.initEphemeral),
    psk,
    prologue,
  });
  const responder = new NoiseKKpsk2Handshake({
    role: "responder",
    staticPrivate: hexToBytes(vector.respStatic),
    remoteStatic: hexToBytes(vector.respRemoteStatic),
    ephemeralPrivate: hexToBytes(vector.respEphemeral),
    psk: hexToBytes(vector.psk),
    prologue: hexToBytes(vector.prologue),
  });
  return { initiator, responder };
}

describe("Noise_KKpsk2_25519_ChaChaPoly_SHA256", () => {
  it("never wipes caller-owned Node Buffers when a handshake closes", () => {
    const staticPrivate = Buffer.alloc(32, 3);
    const remoteStatic = Buffer.from(x25519.getPublicKey(new Uint8Array(32).fill(7)));
    const psk = Buffer.alloc(32, 11);
    const ephemeralPrivate = Buffer.alloc(32, 13);
    const originals = [staticPrivate, remoteStatic, psk, ephemeralPrivate].map((value) =>
      Buffer.from(value),
    );
    const handshake = new NoiseKKpsk2Handshake({
      role: "initiator",
      staticPrivate,
      remoteStatic,
      psk,
      prologue: utf8("buffer-copy-test"),
      ephemeralPrivate,
    });
    handshake.close();
    expect([staticPrivate, remoteStatic, psk, ephemeralPrivate]).toEqual(originals);
  });

  it("derives a dedicated PSK from the v1 pair key with an independent HKDF vector", () => {
    const pairKey = new Uint8Array(32).fill(7);
    const computerFp = "a".repeat(26);
    const phoneFp = "b".repeat(26);
    expect(bytesToHex(deriveNoisePsk(pairKey, computerFp, phoneFp))).toBe(
      "9559ba2cfefbda7311d777d26333626b800845b9400e214b9798cbf515e9b78b",
    );
    expect(deriveNoisePsk(pairKey, computerFp, phoneFp)).not.toEqual(pairKey);
    expect(deriveNoisePsk(pairKey, computerFp, phoneFp)).not.toEqual(
      deriveNoisePsk(pairKey, phoneFp, computerFp),
    );
    expect(() => deriveNoisePsk(new Uint8Array(31), computerFp, phoneFp)).toThrow();
    expect(() => deriveNoisePsk(pairKey, "bad|fp", phoneFp)).toThrow();
  });

  it("matches an independent byte-exact handshake and transport vector", () => {
    const { initiator, responder } = peers();
    const m1 = initiator.write(hexToBytes(vector.firstPayload));
    expect(bytesToHex(m1)).toBe(vector.firstMessage);
    expect(bytesToHex(responder.read(m1))).toBe(vector.firstPayload);
    const m2 = responder.write(hexToBytes(vector.secondPayload));
    expect(bytesToHex(m2)).toBe(vector.secondMessage);
    expect(bytesToHex(initiator.read(m2))).toBe(vector.secondPayload);
    expect(bytesToHex(initiator.handshakeHash)).toBe(vector.handshakeHash);
    expect(responder.handshakeHash).toEqual(initiator.handshakeHash);
    const sender = initiator.split();
    const receiver = responder.split();
    expect(bytesToHex(initiator.handshakeHash)).toBe(vector.handshakeHash);
    const frame = sender.seal(0n, hexToBytes(vector.transportPayload));
    expect(bytesToHex(frame)).toBe(vector.transportCiphertext);
    expect(bytesToHex(receiver.open(0n, frame))).toBe(vector.transportPayload);
    const reverse = receiver.seal(0n, hexToBytes(vector.reversePayload));
    expect(bytesToHex(reverse)).toBe(vector.reverseCiphertext);
    expect(bytesToHex(sender.open(0n, reverse))).toBe(vector.reversePayload);
  });

  it("rejects the wrong pair key or prologue before a session can be used", () => {
    for (const { psk, prologue } of [
      { psk: new Uint8Array(32).fill(1), prologue: hexToBytes(vector.prologue) },
      { psk: hexToBytes(vector.psk), prologue: utf8("wrong route") },
    ]) {
      const { initiator } = peers(psk, prologue);
      const { responder } = peers();
      const m1 = initiator.write();
      if (prologue.length !== hexToBytes(vector.prologue).length) {
        expect(() => responder.read(m1)).toThrow();
      } else {
        responder.read(m1);
        expect(() => initiator.read(responder.write())).toThrow();
      }
      expect(() => initiator.split()).toThrow();
    }
  });

  it("supports explicit 64-bit nonce gaps but rejects replay and tampering", () => {
    const { initiator, responder } = peers();
    responder.read(initiator.write());
    initiator.read(responder.write());
    const sender = initiator.split();
    const receiver = responder.split();
    const first = sender.seal(0n, utf8("first"));
    expect(receiver.open(0n, first)).toEqual(utf8("first"));
    const later = sender.seal(2n, utf8("later"));
    const tampered = later.slice();
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1;
    expect(() => receiver.open(2n, tampered)).toThrow();
    expect(receiver.open(2n, later)).toEqual(utf8("later"));
    expect(() => receiver.open(2n, later)).toThrow(/replay|sequence/i);
    expect(() => sender.seal(2n, utf8("again"))).toThrow(/reuse|sequence/i);
    sender.close();
    receiver.close();
    expect(() => sender.seal(3n, utf8("closed"))).toThrow(/closed/i);
  });

  it("binds frame associated data and never advances replay state for a failed tag", () => {
    const { initiator, responder } = peers();
    responder.read(initiator.write());
    initiator.read(responder.write());
    const sender = initiator.split();
    const receiver = responder.split();
    const frame = sender.seal(3n, utf8("payload"), utf8("pair A / route 4"));
    expect(() => receiver.open(3n, frame, utf8("pair B / route 4"))).toThrow();
    expect(receiver.open(3n, frame, utf8("pair A / route 4"))).toEqual(utf8("payload"));
    expect(() => receiver.open(2n, frame, utf8("pair A / route 4"))).toThrow(/replay/i);
  });

  it("uses exactly two 48-byte handshake messages when payloads are empty", () => {
    const { initiator, responder } = peers();
    const first = initiator.write();
    expect(first).toHaveLength(48);
    expect(responder.read(first)).toHaveLength(0);
    const second = responder.write();
    expect(second).toHaveLength(48);
    expect(initiator.read(second)).toHaveLength(0);
    expect(initiator.handshakeHash).toEqual(responder.handshakeHash);
  });

  it("forbids non-empty handshake payloads outside known-answer tests", () => {
    const { initiator, responder } = peers();
    const nonEmptyFirst = initiator.write(utf8("not terminal data"));
    const previous = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      expect(() => responder.read(nonEmptyFirst)).toThrow(/payload/i);
      const live = new NoiseKKpsk2Handshake({
        role: "initiator",
        staticPrivate: hexToBytes(vector.initStatic),
        remoteStatic: hexToBytes(vector.initRemoteStatic),
        psk: hexToBytes(vector.psk),
        prologue: hexToBytes(vector.prologue),
      });
      expect(() => live.write(utf8("not terminal data"))).toThrow(/payload/i);
      expect(live.write()).toHaveLength(48);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it("losslessly encodes sequence numbers and rejects Noise's reserved max nonce", () => {
    for (const value of [0n, 1n, 2n ** 53n + 17n, 2n ** 64n - 2n]) {
      expect(decodeNoiseSequence(encodeNoiseSequence(value))).toBe(value);
    }
    expect(() => encodeNoiseSequence(2n ** 64n - 1n)).toThrow(/sequence|nonce/i);
    expect(() => decodeNoiseSequence(new Uint8Array(7))).toThrow(/sequence|nonce/i);
    expect(bytesToHex(encodeNoiseSequence(2n ** 32n + 1n))).toBe("0100000001000000");
  });

  it("enforces Noise's 65535-byte handshake and transport message ceiling", () => {
    const { initiator, responder } = peers();
    const largestHandshake = initiator.write(new Uint8Array(65_535 - 48));
    expect(largestHandshake).toHaveLength(65_535);
    expect(responder.read(largestHandshake)).toHaveLength(65_535 - 48);
    const second = responder.write();
    initiator.read(second);
    const sender = initiator.split();
    const receiver = responder.split();
    const largestFrame = sender.seal(0n, new Uint8Array(65_535 - 16));
    expect(largestFrame).toHaveLength(65_535);
    expect(receiver.open(0n, largestFrame)).toHaveLength(65_535 - 16);
    expect(() => sender.seal(1n, new Uint8Array(65_536 - 16))).toThrow(/length|large/i);
    expect(() => receiver.open(1n, new Uint8Array(65_536))).toThrow(/length|large/i);
    const another = peers();
    expect(() => another.initiator.write(new Uint8Array(65_536 - 48))).toThrow(/length|large/i);
  });

  it("requires matching static X25519 keys and correct message order", () => {
    const { initiator, responder } = peers();
    expect(() => initiator.split()).toThrow();
    expect(() => responder.write()).toThrow();
    const m1 = initiator.write();
    expect(() => initiator.write()).toThrow();
    expect(() => responder.read(m1.slice(0, 10))).toThrow();
    const wrong = new NoiseKKpsk2Handshake({
      role: "responder",
      staticPrivate: new Uint8Array(32).fill(2),
      remoteStatic: x25519.getPublicKey(hexToBytes(vector.initStatic)),
      psk: hexToBytes(vector.psk),
      prologue: hexToBytes(vector.prologue),
    });
    expect(() => wrong.read(m1)).toThrow();
  });

  it("poisons a handshake after either message is tampered with", () => {
    const first = peers();
    const originalFirst = first.initiator.write();
    const alteredFirst = originalFirst.slice();
    alteredFirst[alteredFirst.length - 1] = (alteredFirst.at(-1) ?? 0) ^ 1;
    expect(() => first.responder.read(alteredFirst)).toThrow();
    expect(() => first.responder.read(originalFirst)).toThrow(/order/i);
    expect(() => first.responder.split()).toThrow(/complete/i);

    const second = peers();
    second.responder.read(second.initiator.write());
    const alteredSecond = second.responder.write().slice();
    alteredSecond[alteredSecond.length - 1] = (alteredSecond.at(-1) ?? 0) ^ 1;
    expect(() => second.initiator.read(alteredSecond)).toThrow();
    expect(() => second.initiator.split()).toThrow(/complete/i);
  });

  it("rejects a low-order remote static public key", () => {
    const handshake = new NoiseKKpsk2Handshake({
      role: "initiator",
      staticPrivate: hexToBytes(vector.initStatic),
      remoteStatic: new Uint8Array(32),
      psk: hexToBytes(vector.psk),
      prologue: hexToBytes(vector.prologue),
    });
    expect(() => handshake.write()).toThrow();
    expect(() => handshake.split()).toThrow(/complete/i);
  });

  it("rejects deterministic ephemeral injection outside tests and raw transport construction", () => {
    const previous = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      expect(() => peers()).toThrow(/test-only/i);
    } finally {
      process.env.NODE_ENV = previous;
    }
    const RawTransport = NoiseTransport as unknown as new (
      role: "initiator",
      first: Uint8Array,
      second: Uint8Array,
    ) => NoiseTransport;
    expect(() => new RawTransport("initiator", new Uint8Array(32), new Uint8Array(32))).toThrow(
      /factory/i,
    );
  });
});

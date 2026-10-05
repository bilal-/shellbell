import { Buffer } from "node:buffer";
import { fingerprint } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { decodeComputerRecord, decodePairingRecord, decodePairingWindow } from "../src/index.js";

const inputs: readonly [string, () => Uint8Array][] = [
  ["Node Buffer", () => Buffer.alloc(32, 2)],
  ["offset Node Buffer", () => Buffer.alloc(96, 8).subarray(16, 48).fill(2)],
  ["offset Uint8Array", () => new Uint8Array(96).fill(8).subarray(16, 48).fill(2)],
];

function ownsBytes(input: Uint8Array, decoded: Uint8Array) {
  input.fill(9);
  expect(decoded).toEqual(new Uint8Array(32).fill(2));
  expect(decoded.buffer.byteLength).toBe(32);
  expect(decoded.byteOffset).toBe(0);
  decoded.fill(3);
  expect(Array.from(input)).toEqual(Array(32).fill(9));
}

describe("identity record byte ownership", () => {
  it.each(inputs)("copies computer keys from %s", (_name, create) => {
    const input = create();
    const decoded = decodeComputerRecord({
      fingerprint: fingerprint(input),
      publicKey: input,
      name: "Mac",
      firstSeen: 100,
      lastSeen: 100,
    });
    ownsBytes(input, decoded.publicKey);
  });

  it.each(inputs)("copies pairing keys from %s", (_name, create) => {
    const input = create();
    const decoded = decodePairingRecord({
      phoneFp: fingerprint(input),
      publicKey: input,
      name: "Phone",
      pushToken: null,
      pushPlatform: null,
      pushEnabled: true,
      pairedAt: 100,
      lastSeenAt: null,
    });
    ownsBytes(input, decoded.publicKey);
  });

  it("retains and owns optional pair IDs while rejecting malformed IDs", () => {
    const publicKey = new Uint8Array(32).fill(2);
    const pairId = new Uint8Array(32).fill(7);
    const row = {
      phoneFp: fingerprint(publicKey),
      publicKey,
      name: "Phone",
      pushToken: null,
      pushPlatform: null,
      pushEnabled: true,
      pairedAt: 100,
      lastSeenAt: null,
      pairId,
    };
    const decoded = decodePairingRecord(row);
    pairId.fill(8);
    expect(decoded.pairId).toEqual(new Uint8Array(32).fill(7));
    expect(() => decodePairingRecord({ ...row, pairId: new Uint8Array(31) })).toThrow();
  });

  it.each(inputs)("copies pairing gates from %s", (_name, create) => {
    const input = create();
    const decoded = decodePairingWindow({ gateHash: input, expiresAt: 100, admitted: 0 });
    ownsBytes(input, decoded.gateHash);
  });
});

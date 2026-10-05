import { createCipheriv, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as protocol from "../src/index.js";
import {
  notificationHeader as header,
  notificationPayload as payload,
} from "./notification-fixture.js";

const pairKey = new Uint8Array(32).fill(3);
function independentlySeal(value: unknown) {
  const key = new Uint8Array(
    hkdfSync(
      "sha256",
      pairKey,
      "shellbell-notification-v1",
      JSON.stringify([header.computerFp, header.phoneFp, header.generation]),
      32,
    ),
  );
  const nonce = new Uint8Array(12).fill(7);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(
    Buffer.from(
      JSON.stringify([
        "shellbell-notification-v1",
        header.computerFp,
        header.phoneFp,
        header.generation,
        header.sessionId,
        header.eventId,
      ]),
    ),
  );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    key,
    box: {
      ...header,
      nonce: protocol.toBase64Url(nonce),
      ciphertext: protocol.toBase64Url(ciphertext),
    },
  };
}

describe("notification-only encryption", () => {
  it("agrees with the independent OpenSSL KDF and GCM implementation", () => {
    expect(protocol.deriveNotificationKey).toBeTypeOf("function");
    const { key, box } = independentlySeal(payload);
    expect(protocol.deriveNotificationKey(pairKey, header)).toEqual(key);
    expect(protocol.openNotification(key, box)).toEqual(payload);
  });

  it("encrypts current labels without exposing them and uses fresh nonces", () => {
    const key = protocol.deriveNotificationKey(pairKey, header);
    const first = protocol.sealNotification(key, payload);
    const second = protocol.sealNotification(key, payload);
    expect(first.nonce).not.toBe(second.nonce);
    expect(JSON.stringify(first)).not.toContain("shellbell");
    expect(protocol.openNotification(key, first)).toEqual(payload);
    expect(protocol.openNotification(key, second)).toEqual(payload);
  });

  it("rejects modifications to every authenticated routing field", () => {
    const { key, box } = independentlySeal(payload);
    for (const [field, value] of Object.entries({
      computerFp: "c".repeat(26),
      phoneFp: "c".repeat(26),
      sessionId: "tmux:other",
      eventId: protocol.toBase64Url(new Uint8Array(16).fill(9)),
      generation: protocol.toBase64Url(new Uint8Array(16).fill(9)),
    })) {
      expect(() => protocol.openNotification(key, { ...box, [field]: value })).toThrow();
    }
  });

  it("rejects validly encrypted mismatched inner routing and unknown fields", () => {
    for (const value of [
      { ...payload, sessionId: "another" },
      { ...payload, output: "secret" },
    ]) {
      const { key, box } = independentlySeal(value);
      expect(() => protocol.openNotification(key, box)).toThrow();
    }
  });

  it("rejects wrong keys, corrupted tags, nonce lengths and oversized ciphertext", () => {
    const { key, box } = independentlySeal(payload);
    expect(() => protocol.openNotification(new Uint8Array(32), box)).toThrow();
    const bytes = protocol.fromBase64Url(box.ciphertext);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    for (const change of [
      { ciphertext: protocol.toBase64Url(bytes) },
      { nonce: "AA" },
      { ciphertext: protocol.toBase64Url(new Uint8Array(1553)) },
      { ciphertext: `${box.ciphertext}=` },
    ])
      expect(() => protocol.openNotification(key, { ...box, ...change })).toThrow();
  });

  it("does not use the pair key or another enrollment's derived key", () => {
    const key = protocol.deriveNotificationKey(pairKey, header);
    expect(key).not.toEqual(pairKey);
    expect(key).not.toEqual(
      protocol.deriveNotificationKey(pairKey, {
        ...header,
        generation: protocol.toBase64Url(new Uint8Array(16).fill(8)),
      }),
    );
    expect(() => protocol.deriveNotificationKey(new Uint8Array(31), header)).toThrow();
  });
});

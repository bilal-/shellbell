// Independent OpenSSL fixtures: never expose a deterministic nonce runtime API.
import { createCipheriv, hkdfSync } from "node:crypto";
import { bytesToHex, toBase64Url } from "../src/bytes.js";
import type { NotificationBox, NotificationPayload } from "../src/notification.js";

export function generateNotificationVectors() {
  const pairKey = new Uint8Array(32).fill(3);
  const header = {
    computerFp: "a".repeat(26),
    phoneFp: "b".repeat(26),
    generation: toBase64Url(new Uint8Array(16).fill(1)),
    sessionId: "tmux:1",
    eventId: toBase64Url(new Uint8Array(16).fill(2)),
  };
  const payload: NotificationPayload = {
    ...header,
    context: {
      computerName: "MacBook",
      sessionLabel: "Terminal 2",
      observedAt: 1000,
      repository: "shellbell",
      branch: "fix/通知",
    },
    reason: "agent-blocked",
    issuedAt: 1000,
    expiresAt: 121000,
    sequence: "1",
  };
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      pairKey,
      "shellbell-notification-v1",
      JSON.stringify([header.computerFp, header.phoneFp, header.generation]),
      32,
    ),
  );
  const nonce = new Uint8Array(12).fill(7);
  const ad = JSON.stringify([
    "shellbell-notification-v1",
    header.computerFp,
    header.phoneFp,
    header.generation,
    header.sessionId,
    header.eventId,
  ]);
  function seal(value: unknown): NotificationBox {
    // Different plaintext with this nonce is permitted ONLY for isolated public test vectors.
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(ad));
    return {
      ...header,
      nonce: toBase64Url(nonce),
      ciphertext: toBase64Url(
        Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]),
      ),
    };
  }
  const box = seal(payload);
  const invalid = [
    { name: "wrong key", key: "00".repeat(32), box },
    { name: "wrong recipient", key: bytesToHex(key), box: { ...box, phoneFp: "c".repeat(26) } },
    {
      name: "inner routing mismatch",
      key: bytesToHex(key),
      box: seal({ ...payload, sessionId: "other" }),
    },
    {
      name: "unknown plaintext field",
      key: bytesToHex(key),
      box: seal({ ...payload, output: "must reject" }),
    },
    { name: "padded encoding", key: bytesToHex(key), box: { ...box, nonce: `${box.nonce}=` } },
    {
      name: "unsafe label",
      key: bytesToHex(key),
      box: seal({ ...payload, context: { ...payload.context, title: "spoof\u202e" } }),
    },
  ];
  return {
    pairKey: bytesToHex(pairKey),
    key: bytesToHex(key),
    ad,
    plaintext: JSON.stringify(payload),
    payload,
    box,
    invalid,
  };
}

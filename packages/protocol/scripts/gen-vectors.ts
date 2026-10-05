import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bytesToHex, hexToBytes, toBase64Url, utf8 } from "../src/bytes.js";
import {
  authMessage,
  deriveConnKey,
  derivePairKey,
  derivePskKey,
  fingerprint,
  frameAd,
  identityFromSeeds,
  sealWithNonce,
  sign,
} from "../src/crypto.js";
import type { Vectors } from "../src/vectors.js";
import { generateNotificationVectors } from "./notification-vectors.js";

const fixed = (fill: number) => bytesToHex(new Uint8Array(32).fill(fill));
const c = identityFromSeeds(
  hexToBytes(fixed(0x11)),
  hexToBytes(fixed(0x22)),
  "2026-01-01T00:00:00Z",
);
const p = identityFromSeeds(
  hexToBytes(fixed(0x33)),
  hexToBytes(fixed(0x44)),
  "2026-01-01T00:00:00Z",
);
const fpC = fingerprint(c.ed25519.pub);
const fpP = fingerprint(p.ed25519.pub);
const code = new Uint8Array(16).fill(0x55);
const nPhone = new Uint8Array(16).fill(0x66);
const nAgent = new Uint8Array(16).fill(0x77);
const kPair = derivePairKey(c.x25519.priv, p.x25519.pub, code, fpC, fpP);
const conn = deriveConnKey(kPair, nPhone, nAgent, fpC, fpP);
const frameNonce = new Uint8Array(24).fill(0x88);
const plaintext = '{"type":"input.line","reqId":"r1","sessionId":"iterm2:x","text":"y"}';
const frame = sealWithNonce(
  conn.kConn,
  frameNonce,
  utf8(plaintext),
  frameAd(fpP, fpC, conn.connTag, 1),
);
const nonceBytes = new Uint8Array(32).fill(0x99);
const authNonce = toBase64Url(nonceBytes);
const authMsg = authMessage("conn-abc", "phone", fpP, nonceBytes);

const vectors: Vectors = {
  v: 1,
  computer: { edSeed: fixed(0x11), xSeed: fixed(0x22), fp: fpC },
  phone: { edSeed: fixed(0x33), xSeed: fixed(0x44), fp: fpP },
  code: bytesToHex(code),
  kPsk: bytesToHex(derivePskKey(code, fpC)),
  kPair: bytesToHex(kPair),
  nPhone: bytesToHex(nPhone),
  nAgent: bytesToHex(nAgent),
  connTag: conn.connTag,
  kConn: bytesToHex(conn.kConn),
  frame: { nonce: bytesToHex(frameNonce), plaintext, seq: 1, ciphertext: bytesToHex(frame.c) },
  auth: {
    connId: "conn-abc",
    nonce: authNonce,
    role: "phone",
    sig: bytesToHex(sign(p.ed25519.priv, authMsg)),
  },
};
writeFileSync(
  join(import.meta.dirname, "..", "test", "vectors.json"),
  `${JSON.stringify(vectors, null, 2)}\n`,
);
console.log("wrote test/vectors.json", fpC, fpP);
writeFileSync(
  join(import.meta.dirname, "..", "test", "notification-vectors.json"),
  `${JSON.stringify(generateNotificationVectors(), null, 2)}\n`,
);

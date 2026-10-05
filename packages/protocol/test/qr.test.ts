import { describe, expect, it } from "vitest";
import { toBase64Url } from "../src/bytes.js";
import { fingerprint, generateIdentity } from "../src/crypto.js";
import { encodeQr, parseQr, relayWsUrl } from "../src/qr.js";

describe("qr payload", () => {
  const id = generateIdentity();
  const good = {
    v: 1 as const,
    r: "wss://relay.shellbell.dev",
    c: fingerprint(id.ed25519.pub),
    e: toBase64Url(id.ed25519.pub),
    n: "MBP",
    p: toBase64Url(new Uint8Array(16)),
    g: toBase64Url(new Uint8Array(16).fill(1)),
  };

  it("round-trips", () => {
    expect(parseQr(encodeQr(good))).toEqual(good);
  });
  it("rejects fp/e mismatch, non-wss, bad version, trailing slash, credentials", () => {
    expect(() => parseQr(encodeQr({ ...good, c: "a".repeat(26) }))).toThrow(/malformed/);
    expect(() => parseQr(encodeQr({ ...good, r: "ws://relay" }))).toThrow(/malformed/);
    expect(
      parseQr(encodeQr({ ...good, r: "ws://localhost:8787" }), { allowInsecure: true }).r,
    ).toBe("ws://localhost:8787");
    expect(() => parseQr(encodeQr({ ...good, r: "wss://relay.shellbell.dev/" }))).toThrow(
      /malformed/,
    );
    expect(() => parseQr(JSON.stringify({ ...good, v: 2 }))).toThrow(/malformed/);
    expect(() => parseQr("not json")).toThrow(/malformed/);
    expect(() => parseQr(encodeQr({ ...good, r: "wss://user:pass@relay.shellbell.dev" }))).toThrow(
      /malformed/,
    );
  });
  it("builds the socket url", () => {
    expect(relayWsUrl("wss://relay.shellbell.dev", good.c)).toBe(
      `wss://relay.shellbell.dev/ws/${good.c}`,
    );
  });
});

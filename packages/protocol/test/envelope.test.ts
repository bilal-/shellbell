import { describe, expect, it } from "vitest";
import { decodeCbor, encodeCbor } from "../src/codec.js";
import {
  decodeEnvelope,
  decodeRoutableEnvelope,
  E2EBodySchema,
  type Envelope,
  encodeEnvelope,
  encodeV2RelayEnvelope,
  FRAME_LIMITS,
} from "../src/envelope.js";

const FP_A = "a".repeat(26);
const FP_B = "b".repeat(26);

describe("cbor codec", () => {
  it("omits undefined properties and round-trips bytes", () => {
    const enc = encodeCbor({ a: 1, b: undefined, c: new Uint8Array([1, 2]) });
    const dec = decodeCbor(enc) as Record<string, unknown>;
    expect(Object.keys(dec)).toEqual(["a", "c"]);
    expect(dec.c).toBeInstanceOf(Uint8Array);
  });
});

describe("envelope", () => {
  it("round-trips an e2e envelope", () => {
    const e: Envelope = {
      v: 1,
      t: "e2e",
      from: FP_A,
      to: FP_B,
      seq: 7,
      body: { n: new Uint8Array(24), c: new Uint8Array([9]) },
    };
    const out = decodeEnvelope(encodeEnvelope(e));
    expect(out.from).toBe(FP_A);
    expect(out.seq).toBe(7);
    expect((out.body as { c: Uint8Array }).c).toEqual(new Uint8Array([9]));
  });
  it("accepts 'relay' as from for ctrl", () => {
    const e: Envelope = {
      v: 1,
      t: "ctrl",
      from: "relay",
      seq: 0,
      body: { type: "presence", agentOnline: true, computerName: null },
    };
    expect(decodeEnvelope(encodeEnvelope(e)).from).toBe("relay");
  });
  it("rejects malformed input", () => {
    expect(() => decodeEnvelope(new Uint8Array([0xff, 0x00]))).toThrow(/malformed/);
    expect(() => decodeEnvelope(encodeCbor({ v: 2 }))).toThrow(/malformed/);
    expect(() =>
      decodeEnvelope(encodeCbor({ v: 1, t: "e2e", from: "short", seq: 0, body: {} })),
    ).toThrow(/malformed/);
  });
  it("exposes the documented frame limits", () => {
    expect(FRAME_LIMITS).toEqual({
      unauth: 4096,
      ctrl: 16384,
      e2eFromPhone: 65536,
      e2eFromAgent: 1048576,
    });
  });
  it("rejects an e2e envelope without to", () => {
    expect(() =>
      decodeEnvelope(
        encodeCbor({
          v: 1,
          t: "e2e",
          from: FP_A,
          seq: 0,
          body: { n: new Uint8Array(24), c: new Uint8Array([9]) },
        }),
      ),
    ).toThrow(/malformed/);
  });
});

describe("E2EBodySchema", () => {
  it("requires a 24-byte nonce", () => {
    expect(E2EBodySchema.safeParse({ n: new Uint8Array(23), c: new Uint8Array(1) }).success).toBe(
      false,
    );
    expect(E2EBodySchema.safeParse({ n: new Uint8Array(24), c: new Uint8Array(1) }).success).toBe(
      true,
    );
  });
});

describe("opaque v2 relay carrier", () => {
  it("routes bounded opaque bytes without a lossy outer sequence number", () => {
    const frame = new Uint8Array(61_000).fill(7);
    const raw = encodeV2RelayEnvelope({ v: 2, t: "e2e", from: FP_A, to: FP_B, body: frame });
    expect(raw.length).toBeLessThan(FRAME_LIMITS.e2eFromPhone);
    const decoded = decodeRoutableEnvelope(raw);
    expect(decoded).toEqual({ v: 2, t: "e2e", from: FP_A, to: FP_B, body: frame });
    expect("seq" in decoded).toBe(false);
    expect(() => decodeEnvelope(raw)).toThrow(); // v1 endpoint parser must not misread v2.
  });

  it("rejects control impersonation, extra fields, invalid bodies, and oversized frames", () => {
    const base = { v: 2, t: "e2e", from: FP_A, to: FP_B, body: new Uint8Array([1]) };
    for (const invalid of [
      { ...base, t: "ctrl" },
      { ...base, from: "relay" },
      { ...base, seq: 0 },
      { ...base, body: [1] },
      { ...base, body: new Uint8Array(61_001) },
    ]) {
      expect(() => decodeRoutableEnvelope(encodeCbor(invalid))).toThrow(/malformed/);
    }
  });
});

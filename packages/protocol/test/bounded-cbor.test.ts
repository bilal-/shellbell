import { describe, expect, it } from "vitest";
import {
  decodeBoundedRecord,
  decodeCbor,
  encodeCbor,
  ProtocolError,
  STREAM_LIMITS,
} from "../src/index.js";

function malformed(bytes: number[] | Uint8Array, maxBytes = 64) {
  expect(() => decodeBoundedRecord(new Uint8Array(bytes), maxBytes)).toThrow(ProtocolError);
}

describe("bounded CBOR logical records", () => {
  it("round-trips an allowed record through the package export", () => {
    expect(decodeBoundedRecord(encodeCbor({ a: [1, true, "界"] }), 64)).toEqual({
      a: [1, true, "界"],
    });
  });

  it("rejects a thirteenth open container", () => {
    const deeplyNested = new Uint8Array(14);
    deeplyNested.fill(0x81, 0, 13);
    deeplyNested[13] = 0;
    expect(() => decodeBoundedRecord(deeplyNested, 64)).toThrow(ProtocolError);
  });

  it("accepts twelve open containers", () => {
    const nested = new Uint8Array(13);
    nested.fill(0x81, 0, 12);
    nested[12] = 0;
    let expected: unknown = 0;
    for (let i = 0; i < 12; i++) expected = [expected];
    expect(decodeBoundedRecord(nested, 64)).toEqual(expected);
  });

  it("enforces nonempty buffers and a positive bounded byte limit", () => {
    malformed([]);
    malformed([0xf4, 0xf5], 1);
    expect(decodeBoundedRecord(new Uint8Array([0xf4]), 1)).toBe(false);
    for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      malformed([0xf4], limit);
    }
    malformed([0xf4], STREAM_LIMITS.screenBytes + 1);
  });

  it("rejects truncated heads, text and collections", () => {
    for (const bytes of [[0x18], [0x19, 0x01], [0x7a, 0, 0], [0x63, 0x61], [0x81], [0xa1, 0x60]])
      malformed(bytes);
  });

  it("rejects advertised array, map and text lengths that cannot fit", () => {
    for (const bytes of [
      [0x9a, 0, 1, 0, 0],
      [0xba, 0, 1, 0, 0],
      [0x7a, 0, 1, 0, 0],
      [0x9b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    ])
      malformed(bytes);
  });

  it("rejects integers outside JavaScript's safe range in both signs", () => {
    malformed([0x1b, 0, 0x20, 0, 0, 0, 0, 0, 0]);
    malformed([0x3b, 0, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect(decodeBoundedRecord(new Uint8Array([0x19, 0xff, 0xff]), 64)).toBe(65535);
  });

  it("rejects non-text and duplicate map keys without exposing their values", () => {
    malformed([0xa1, 0, 1]);
    const duplicate = new Uint8Array([0xa2, 0x61, 0x78, 0, 0x61, 0x78, 1]);
    try {
      decodeBoundedRecord(duplicate, 64);
      throw new Error("expected duplicate rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as Error).message).toBe("malformed");
    }
  });

  it("rejects invalid UTF-8 scalar encodings", () => {
    for (const bytes of [
      [0x61, 0x80],
      [0x62, 0xc0, 0x80],
      [0x63, 0xed, 0xa0, 0x80],
      [0x64, 0xf4, 0x90, 0x80, 0x80],
      [0x62, 0xe2, 0x82],
      [0x61, 0xc2],
    ])
      malformed(bytes);
  });

  it("rejects bytes, tags, floats, null, undefined, indefinite and reserved forms", () => {
    for (const bytes of [
      [0x40],
      [0xc0, 0],
      [0xf9, 0, 0],
      [0xf6],
      [0xf7],
      [0x9f, 0xff],
      [0x1c],
      [0xff],
      [0xf0],
      [0x5f, 0xff],
    ])
      malformed(bytes);
  });

  it("rejects two trailing root items", () => {
    malformed([0xf4, 0xf5]);
  });

  it("preserves empty strings, supplementary scalars and combining marks", () => {
    expect(decodeBoundedRecord(new Uint8Array([0xa1, 0x60, 0x60]), 64)).toEqual({ "": "" });
    const value = { "": "🛎e\u0301" };
    expect(decodeBoundedRecord(encodeCbor(value), 64)).toEqual(value);
  });

  it("preserves leading, repeated and interior U+FEFF in keys and values", () => {
    const value = { "\ufeff": "\ufeff\ufeffA\ufeffB", "A\ufeffB": "\ufeff" };
    expect(decodeBoundedRecord(encodeCbor(value), 128)).toEqual(value);
  });

  it("treats BOM-prefixed and plain keys as distinct while leaving legacy decode intact", () => {
    const bytes = encodeCbor({ "\ufeffx": 1, x: 2 });
    expect(decodeBoundedRecord(bytes, 64)).toEqual({ "\ufeffx": 1, x: 2 });
    expect(decodeCbor(encodeCbor({ x: 2 }))).toEqual({ x: 2 });
  });

  it("decodes a valid maximum-size text record without spreading the whole string", () => {
    const textBytes = STREAM_LIMITS.screenBytes - 5;
    const bytes = new Uint8Array(STREAM_LIMITS.screenBytes);
    bytes.set([
      0x7a,
      (textBytes >>> 24) & 0xff,
      (textBytes >>> 16) & 0xff,
      (textBytes >>> 8) & 0xff,
      textBytes & 0xff,
    ]);
    bytes.fill(0x61, 5);
    expect(decodeBoundedRecord(bytes, STREAM_LIMITS.screenBytes)).toBe("a".repeat(textBytes));
  });
});

import { describe, expect, it } from "vitest";
import {
  bytesEqual,
  bytesToHex,
  concat,
  fromBase64Url,
  fromUtf8,
  hexToBytes,
  toBase32Lower,
  toBase64Url,
  utf8,
} from "../src/bytes.js";

describe("base64url", () => {
  it("round-trips and uses no padding", () => {
    const b = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const s = toBase64Url(b);
    expect(s).not.toMatch(/[=+/]/);
    expect(fromBase64Url(s)).toEqual(b);
  });
  it("encodes known vector", () => {
    expect(toBase64Url(utf8("hello"))).toBe("aGVsbG8");
    expect(fromUtf8(fromBase64Url("aGVsbG8"))).toBe("hello");
  });
  it("rejects invalid characters", () => {
    expect(() => fromBase64Url("ab$c")).toThrow();
  });
});

describe("base32", () => {
  it("encodes RFC 4648 vectors in lowercase without padding", () => {
    expect(toBase32Lower(utf8(""))).toBe("");
    expect(toBase32Lower(utf8("f"))).toBe("my");
    expect(toBase32Lower(utf8("fo"))).toBe("mzxq");
    expect(toBase32Lower(utf8("foo"))).toBe("mzxw6");
    expect(toBase32Lower(utf8("foobar"))).toBe("mzxw6ytboi");
  });
});

describe("hex and misc", () => {
  it("hex round-trips", () => {
    expect(bytesToHex(new Uint8Array([0, 15, 255]))).toBe("000fff");
    expect(hexToBytes("000fff")).toEqual(new Uint8Array([0, 15, 255]));
  });
  it("concat and equal", () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([3]);
    expect(concat(a, b)).toEqual(new Uint8Array([1, 2, 3]));
    expect(bytesEqual(concat(a, b), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(bytesEqual(a, b)).toBe(false);
  });
});

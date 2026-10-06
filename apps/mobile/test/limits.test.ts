import {
  encodeCbor,
  encodeEnvelope,
  FRAME_LIMITS,
  type InnerMessageOf,
  MAX_TERMINAL_MESSAGE_BYTES,
  seal,
} from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { inputTextExceedsLimit, lineExceedsLimit, MAX_LINE_LENGTH } from "../src/input/limits";

describe("lineExceedsLimit (review M15)", () => {
  it("allows exactly the protocol's max length", () => {
    expect(lineExceedsLimit("x".repeat(MAX_LINE_LENGTH))).toBe(false);
  });

  it("rejects one character past the max length", () => {
    expect(lineExceedsLimit("x".repeat(MAX_LINE_LENGTH + 1))).toBe(true);
  });

  it("allows an ordinary short line", () => {
    expect(lineExceedsLimit("ls -la")).toBe(false);
  });
});

describe("encoded terminal input size", () => {
  const message = (text: string): InnerMessageOf<"input.text"> => ({
    type: "input.text",
    reqId: "r".repeat(64),
    sessionId: "s".repeat(128),
    text,
  });
  const atLimit = () => {
    // CBOR's text length header grows from one to three bytes at this boundary.
    const overhead = encodeCbor(message("")).length + 2;
    return message("x".repeat(MAX_TERMINAL_MESSAGE_BYTES - overhead));
  };
  it("admits the exact complete-message limit and rejects the next byte", () => {
    const request = atLimit();
    expect(encodeCbor(request).length).toBe(MAX_TERMINAL_MESSAGE_BYTES);
    expect(inputTextExceedsLimit(request)).toBe(false);
    expect(inputTextExceedsLimit({ ...request, text: `${request.text}x` })).toBe(true);
  });
  it("counts multibyte text rather than only its character count", () => {
    expect(inputTextExceedsLimit(message("界".repeat(18_000)))).toBe(false);
    expect(inputTextExceedsLimit(message("界".repeat(20_000)))).toBe(true);
  });
  it("leaves enough room for the encrypted legacy envelope", () => {
    const body = seal(new Uint8Array(32), encodeCbor(atLimit()), "fixture");
    const envelope = encodeEnvelope({
      v: 1,
      t: "e2e",
      from: "a".repeat(26),
      to: "b".repeat(26),
      seq: Number.MAX_SAFE_INTEGER,
      body,
    });
    expect(envelope.length).toBeLessThanOrEqual(FRAME_LIMITS.e2eFromPhone);
  });
});

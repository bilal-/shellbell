import { describe, expect, it } from "vitest";
import { lineExceedsLimit, MAX_LINE_LENGTH } from "../src/input/limits";

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

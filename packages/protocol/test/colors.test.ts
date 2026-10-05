import { describe, expect, it } from "vitest";
import { colorToHex, TERMINAL16, xterm256Hex } from "../src/colors.js";

describe("colors", () => {
  it("has 16 theme colors and maps indices", () => {
    expect(TERMINAL16).toHaveLength(16);
    expect(xterm256Hex(1)).toBe(TERMINAL16[1]);
    expect(xterm256Hex(16)).toBe("#000000");
    expect(xterm256Hex(21)).toBe("#0000ff");
    expect(xterm256Hex(196)).toBe("#ff0000");
    expect(xterm256Hex(231)).toBe("#ffffff");
    expect(xterm256Hex(232)).toBe("#080808");
    expect(xterm256Hex(255)).toBe("#eeeeee");
  });
  it("colorToHex handles rgb, index and undefined", () => {
    expect(colorToHex([255, 0, 128], "#abcdef")).toBe("#ff0080");
    expect(colorToHex(2, "#abcdef")).toBe(TERMINAL16[2]);
    expect(colorToHex(undefined, "#abcdef")).toBe("#abcdef");
  });
  it("clamps xterm256Hex out-of-range indices", () => {
    expect(xterm256Hex(300)).toBe(xterm256Hex(255));
    expect(xterm256Hex(-4)).toBe(xterm256Hex(0));
  });
  it("clamps colorToHex RGB components", () => {
    expect(colorToHex([300, -5, 1.6], "#000000")).toBe("#ff0002");
  });
});
